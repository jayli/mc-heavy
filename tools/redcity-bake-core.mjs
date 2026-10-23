// tools/redcity-bake-core.mjs — RedCity 烘焙核心（纯函数）：schematic 稠密网格 → 地面高度场 + 保留方块条目 + 出生点
//
// 〔实测〕当前模型：retained 244647 / dy -6..80 / groundMin -5 / groundMax 43 / borderNonZero 0 / outsideAdjMax 1 /
//   contactBreaks 84（0.055%）/ intraCompBreaks 0 / spawn ox=138 oz=141 dy=-3
//
// 语义逐条对应 spec §13.4 / §13.5.4 / §13.6.1 / §14.2：
//   步骤 1 外部空气洪泛（air 与 barrier 可穿、玻璃不可穿）→ §13.5.4 第 2 条
//   步骤 2 逐列地面 = 外部可达的最低 skin 表面 → §13.5.4 第 2 条
//   步骤 4 保留 = 地面往下 K 层 + 地面以上全部 → §13.5.4 第 3 条
//   步骤 5/6 建筑连通体刚性平移 → §13.4.4（严格 I5 / I5′；I6 已删除，口径见 spec §14.2）
//     ⚠️ 本算法**不压平建筑脚下的地面**：刚性分量只是「整体用同一个平移量 S_C」，
//     footprint⊕pad 内地面保持**源模型的起伏 1:1**（ground′ = g − sMed + S_C，g 仍是逐列的）。
//     故旧版 I6「footprint 内 ground 极差 ≤ 1」不成立（实测 125 个刚性分量里 104 个违反，
//     极差中位 8、最大 40）——已被 spec §14.2 删除（不替换为断言），勿再断言它。
//   步骤 7 岛外地面外推（每 decay 格降 1）+ Lipschitz 收敛 → §13.4.2（I1/I2）
//   步骤 8 同格冲突去重（刚性块优先）→ 保证产物无重复格
//
// ⚠️ 本文件是**纯函数**：不读文件、不 import three、不碰 DOM。输入是已解析的稠密网格。

/**
 * @param {{grid: Uint16Array, W: number, H: number, L: number}} schematic `loadSchematic()`（redcity-schematic.mjs）的输出
 * @param {Object} cfg
 * @param {(key:number)=>boolean} cfg.isEmpty   是否空气（含 barrier）
 * @param {(key:number)=>boolean} cfg.isSkin    是否岛体材质（redcity-config.mjs）
 * @param {(key:number)=>boolean} cfg.isBuilding 是否建筑材质（redcity-config.mjs）
 * @param {(key:number)=>string}  cfg.nameOf    (id<<4|meta) → mc-heavy 方块名（redcity-config.mjs）
 * @param {Object} cfg.params
 * @param {number} cfg.params.relief      竖直压缩系数（0.34，观感参数，进指纹）
 * @param {number} cfg.params.K           地面往下保留层数（2）
 * @param {number} cfg.params.groundFloor 地面下限（-5，= REDCITY_GROUND_FLOOR）
 * @param {number} cfg.params.decay       岛外外推衰减（每 2 格降 1）
 * @param {number} cfg.params.pad         建筑 footprint 外扩（1）
 * @param {number} cfg.params.minComp     刚性连通体的最小块数（30）
 * @param {number} cfg.params.borderKeep  贴边不刚性的边距（8）
 * @param {number} cfg.params.maxStep     岛内相邻列高差上限（2，spec §15）
 * @param {number} cfg.params.thinMax     「薄构件」厚度上限（3）：薄构件逐列跟随地面而非刚性平移
 * @param {number} cfg.params.baseTol     连通体按列底面高度再拆分的容差（3）
 * @param {number} cfg.params.glassFrameMin 玻璃「窗框」判据：≥此数量的实心邻接才保留（2）
 * @param {number} cfg.params.maxFill     基座填土上限（12）；超过视为拱洞/挑檐，保持通透
 * @param {boolean} cfg.params.dropIsolated 是否删除六邻接全空的孤立方块（spec §15.9）
 * @param {string} cfg.fillBlock          基座填充材质名（`REDCITY_FILL_BLOCK`）
 * @param {string} cfg.glassBlock         玻璃材质名（需与 `tools/redcity-config.mjs` 的映射表一致）
 * @returns {Object} 见 return 语句
 */
export function bakeRedCityCore(schematic, cfg) {
  const { grid, W, H, L } = schematic;
  const { isEmpty, isSkin, isBuilding, nameOf, params } = cfg;
  const {
    relief, K, groundFloor: FLOOR, decay, pad, minComp, borderKeep,
    maxStep, thinMax, baseTol, glassFrameMin, maxFill, dropIsolated,
  } = params;
  const fillName = cfg.fillBlock;
  const glassName = cfg.glassBlock;
  const idx = (x, y, z) => (y * L + z) * W + x;
  const WL = W * L;

  // ---- 0. 内容包围盒（barrier 视同空气，故按 isEmpty 判）----
  let minX = W, maxX = -1, minZ = L, maxZ = -1;
  for (let z = 0; z < L; z++) {
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        if (!isEmpty(grid[idx(x, y, z)])) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (z < minZ) minZ = z;
          if (z > maxZ) maxZ = z;
          break;
        }
      }
    }
  }
  if (maxX < 0) throw new Error('redcity: 模型内无任何方块');
  const RW = maxX - minX + 1, RZ = maxZ - minZ + 1, NC = RW * RZ;
  const cidx = (x, z) => (z - minZ) * RW + (x - minX);

  // ---- 1. 外部空气洪泛（六邻接；air 与 barrier 可穿，玻璃不可穿）----
  const ext = new Uint8Array(W * H * L);
  {
    const q = new Int32Array(W * H * L); let qh = 0, qt = 0;
    const push = (i) => { if (!ext[i] && isEmpty(grid[i])) { ext[i] = 1; q[qt++] = i; } };
    for (let y = 0; y < H; y++) {
      for (let z = 0; z < L; z++) { push(idx(0, y, z)); push(idx(W - 1, y, z)); }
      for (let x = 0; x < W; x++) { push(idx(x, y, 0)); push(idx(x, y, L - 1)); }
    }
    for (let z = 0; z < L; z++) for (let x = 0; x < W; x++) { push(idx(x, 0, z)); push(idx(x, H - 1, z)); }
    while (qh < qt) {
      const i = q[qh++];
      const x = i % W, z = ((i / W) | 0) % L, y = (i / WL) | 0;
      if (x > 0) push(i - 1);
      if (x < W - 1) push(i + 1);
      if (z > 0) push(i - W);
      if (z < L - 1) push(i + W);
      if (y > 0) push(i - WL);
      if (y < H - 1) push(i + WL);
    }
  }

  // ---- 2. 逐列地面 g：外部可达的最低 skin 表面；无则取最低连续 skin 段的顶 ----
  const gY = new Int16Array(NC).fill(-1);
  const hasAny = new Uint8Array(NC);
  const gs = [];
  for (let z = minZ; z <= maxZ; z++) {
    for (let x = minX; x <= maxX; x++) {
      const c = cidx(x, z);
      let runTop = -1, first = -1;
      for (let y = 0; y < H - 1; y++) {
        const v = grid[idx(x, y, z)];
        if (isEmpty(v)) continue;
        hasAny[c] = 1;
        if (isSkin(v)) {
          if (gY[c] < 0 && ext[idx(x, y + 1, z)]) gY[c] = y;   // 外部可达的最低 skin 表面
          if (first < 0) { first = y; runTop = y; } else if (runTop === y - 1) runTop = y;
        }
      }
      if (gY[c] < 0 && runTop >= 0) gY[c] = runTop;             // 兜底：最低连续 skin 段顶
      if (gY[c] >= 0) gs.push(gY[c]);
    }
  }
  gs.sort((a, b) => a - b);
  const sMed = gs[gs.length >> 1];
  const isTerrain = (c) => gY[c] >= 0;

  // ---- 3. 压缩目标场 T0（相对 sMed 的绝对高度）；最近地形列（4 邻接 BFS）----
  // T0[island] = relTarget(gY) = max(round((gY-sMed)*relief), FLOOR)；岛外列在步骤 7 按 decay 外推。
  const relTarget = (g) => Math.max(Math.round((g - sMed) * relief), FLOOR);
  const T0 = new Int16Array(NC).fill(-32768);
  const nearest = new Int32Array(NC).fill(-1);
  const dist = new Int16Array(NC).fill(-1);
  const bq = [];
  for (let c = 0; c < NC; c++) {
    if (!isTerrain(c)) continue;
    T0[c] = relTarget(gY[c]);
    nearest[c] = c; dist[c] = 0; bq.push(c);
  }
  for (let h = 0; h < bq.length; h++) {
    const c = bq[h], x = c % RW, z = (c / RW) | 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= RW || nz >= RZ) continue;
      const n = nz * RW + nx;
      if (dist[n] >= 0) continue;
      dist[n] = dist[c] + 1; nearest[n] = nearest[c]; bq.push(n);
    }
  }

  // ---- 4. 保留块 + 建筑块标记 ----
  const isB = new Uint8Array(W * H * L);
  const bIdx = [];
  const retained = [];
  for (let z = minZ; z <= maxZ; z++) {
    for (let x = minX; x <= maxX; x++) {
      const c = cidx(x, z);
      if (!hasAny[c]) continue;
      const g = gY[c];
      for (let y = g >= 0 ? Math.max(0, g - K + 1) : 0; y < H; y++) {
        const v = grid[idx(x, y, z)];
        if (isEmpty(v)) continue;
        const building = !isSkin(v) && isBuilding(v) && (g < 0 || y > g);
        if (building) { isB[idx(x, y, z)] = 1; bIdx.push(idx(x, y, z)); }
        retained.push({ x, y, z, v, c, building });
      }
    }
  }

  // ---- 5. 建筑连通体（六邻接）；小分量不刚性；其余按体量降序 ----
  let comps = [];
  const seen = new Uint8Array(W * H * L);
  for (const start of bIdx) {
    if (seen[start]) continue;
    const stack = [start]; seen[start] = 1; const members = [];
    while (stack.length) {
      const i = stack.pop(); members.push(i);
      const x = i % W, z = ((i / W) | 0) % L, y = (i / WL) | 0;
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (nx < 0 || ny < 0 || nz < 0 || nx >= W || ny >= H || nz >= L) continue;
        const j = idx(nx, ny, nz);
        if (isB[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    comps.push({ members });
  }
  const smallN = comps.filter((c) => c.members.length < minComp).length;
  comps = comps.filter((c) => c.members.length >= minComp);
  comps.sort((a, b) => b.members.length - a.members.length);

  // ---- 6. 分量分类与再拆分（spec §15.4）----
  // 6a. 每分量算 footprint（列→该列最低接地点 y）与厚度；厚度 ≤ thinMax 的是「薄构件」（铺装/地砖/玻璃网）。
  // 6b. 底面高度跨度 > baseTol 的连通体按「列底面高度 ±baseTol 的连通性」再拆成子分量。
  //     理由：地砖会把多栋房子连成一片（实测最大一个跨 2913 列、底面自身起伏 44 格），
  //     对整片做单一刚性平移必然「一部分被埋、一部分悬空」。
  // 6c. 靠近矩形边缘的分量不做刚性（边缘地面必须收敛到 0，保 I2）。
  const med = (a) => { const s = [...a].sort((p, q) => p - q); return s[s.length >> 1]; };
  const nearBorder = (c) => {
    const x = c % RW, z = (c / RW) | 0;
    return x < borderKeep || z < borderKeep || x >= RW - borderKeep || z >= RZ - borderKeep;
  };
  for (const C of comps) {
    const foot = new Map(); let mn = 1e9, mx = -1e9;
    for (const i of C.members) {
      const x = i % W, z = ((i / W) | 0) % L, y = (i / WL) | 0;
      const c = cidx(x, z);
      if (!foot.has(c) || foot.get(c) > y) foot.set(c, y);   // 每列最低接地点
      if (y < mn) mn = y;
      if (y > mx) mx = y;
    }
    C.foot = foot; C.thick = mx - mn + 1;
    C.near = false;
    for (const c of foot.keys()) if (nearBorder(c)) { C.near = true; break; }
  }
  {
    const out = [];
    for (const C of comps) {
      const br = Math.max(...C.foot.values()) - Math.min(...C.foot.values());
      if (br <= baseTol) { out.push(C); continue; }
      // 按列底面高度聚类：以 ±baseTol 的连通性再分组
      const cellSet = new Set(C.foot.keys());
      const seenCell = new Set();
      for (const c0 of C.foot.keys()) {
        if (seenCell.has(c0)) continue;
        const group = []; const st = [c0]; seenCell.add(c0);
        const h0 = C.foot.get(c0);
        while (st.length) {
          const c = st.pop(); group.push(c);
          const x = c % RW, z = (c / RW) | 0;
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx, nz = z + dz;
            if (nx < 0 || nz < 0 || nx >= RW || nz >= RZ) continue;
            const n = nz * RW + nx;
            if (!cellSet.has(n) || seenCell.has(n)) continue;
            if (Math.abs(C.foot.get(n) - h0) > baseTol) continue;
            seenCell.add(n); st.push(n);
          }
        }
        const subFoot = new Map();
        for (const c of group) subFoot.set(c, C.foot.get(c));
        // ⚠️ members 必须按子 footprint 过滤：直接挂父分量的完整 members 会让同一块被多个
        // 子分量各写一次 → 严重错位（原型阶段踩到的真实缺陷）。
        const gset = new Set(group);
        const subMembers = C.members.filter((i) => {
          const x = i % W, z = ((i / W) | 0) % L;
          return gset.has(cidx(x, z));
        });
        const b = [...subFoot.values()];
        let smn = 1e9, smx = -1e9;
        for (const i of subMembers) { const y = (i / WL) | 0; if (y < smn) smn = y; if (y > smx) smx = y; }
        let near = false;
        for (const c of subFoot.keys()) if (nearBorder(c)) { near = true; break; }
        out.push({ members: subMembers, foot: subFoot, thick: smx - smn + 1, near });
      }
    }
    out.sort((a, b) => b.members.length - a.members.length);
    comps = out;
  }
  // 薄构件（厚度 ≤ thinMax）逐列跟随地面（形变 ≤ maxStep，不可见）；其余走刚性。
  // 小分量（< minComp）与贴边分量也走逐列——碎片不值得刚性，贴边必须收敛。
  let borderSkipped = 0;
  for (const C of comps) {
    C.rigid = !C.near && C.members.length >= minComp && C.thick > thinMax;
    if (C.near) borderSkipped++;
  }
  const rigidN = comps.filter((C) => C.rigid).length;

  // ---- 7. 街道地形场：压缩目标 → 排除 footprint 列后做 Lipschitz ≤ maxStep ----
  // 步骤 7a 的点场初值 = 压缩目标 T0（已含 relief 与 groundFloor 钳制），
  // §15 改用「绝对地面高度」表示，因为台面高程要与街道高程直接比较。
  const street = new Int16Array(NC);
  for (let c = 0; c < NC; c++) street[c] = isTerrain(c) ? T0[c] : -32768;
  for (let c = 0; c < NC; c++) {
    if (isTerrain(c)) continue;
    const r = street[nearest[c]], d = dist[c];
    const mag = Math.max(0, Math.abs(r) - Math.floor(d / decay));
    street[c] = r < 0 ? -mag : mag;
  }
  const footCell = new Uint8Array(NC);
  for (const C of comps) for (const c of C.foot.keys()) footCell[c] = 1;
  /**
   * 全域 Lipschitz 平滑：相邻两格高差压到 ≤ limit（岛外列之间为 1）。
   * 采用「超限则两侧各让一半」的收缩迭代 —— 保整体高度（不会把地形整体推平）且单调收敛。
   *
   * 矩形边界列的处理（保 I2）：**只把非岛列钉 0**，岛内列不钉。
   * ⚠️ 不能无条件把边界列置 0：岛面贴边时那会把 `island[c]=1` 的列写出 ground=0，
   * 造成 island 与 ground 的语义撕裂（水面门控与出生点扫描会读错）。
   * 岛面贴边是**布局期的真实违约**，应由 I2 报错，而不是被平滑器静默掩盖。
   * @param {Int16Array} field 绝对地面高度场（就地修改）
   * @param {Uint8Array} useCell 参与平滑的列（0 = 钉住不动）
   */
  const smoothField = (field, useCell) => {
    const border = [];
    for (let z = 0; z < RZ; z++) {
      for (let x = 0; x < RW; x++) {
        if (x === 0 || z === 0 || x === RW - 1 || z === RZ - 1) {
          const c = z * RW + x;
          if (!isTerrain(c)) border.push(c);   // 只钉非岛列（岛面贴边交给 I2 报错）
        }
      }
    }
    for (let it = 0; it < 30000; it++) {
      for (const c of border) field[c] = 0;
      let changed = 0;
      for (let z = 0; z < RZ; z++) {
        for (let x = 0; x < RW; x++) {
          const c = z * RW + x;
          if (!useCell[c]) continue;
          for (const [dx, dz] of [[1, 0], [0, 1]]) {
            const nx = x + dx, nz = z + dz;
            if (nx >= RW || nz >= RZ) continue;
            const n = nz * RW + nx;
            if (!useCell[n]) continue;
            const lim = (!isTerrain(c) && !isTerrain(n)) ? 1 : maxStep;
            const d = field[c] - field[n];
            if (Math.abs(d) <= lim) continue;
            const hi = d > 0 ? c : n, lo = d > 0 ? n : c;
            const step = Math.max(1, Math.floor((Math.abs(d) - lim) / 2));
            field[hi] -= step; field[lo] += step; changed++;
          }
        }
      }
      if (!changed) return it + 1;
    }
    throw new Error('redcity: 地表 Lipschitz 平滑未在 30000 轮内收敛');
  };
  const streetMask = new Uint8Array(NC);
  for (let c = 0; c < NC; c++) streetMask[c] = footCell[c] ? 0 : 1;
  smoothField(street, streetMask);

  // ---- 8. 各分量单一平移量 + 台面高程（spec §15.4 步骤 2/3）----
  // S_C 让建筑底面中位落在 footprint 环的街道高程上；台面 = 该高程 → 台基与街道齐平，
  // 玩家从出生点一路走过去就能进房（对应反馈 2：不再需要自己造楼梯）。
  for (const C of comps) {
    if (!C.rigid) continue;
    const ring = [];
    for (const c of C.foot.keys()) {
      const x = c % RW, z = (c / RW) | 0;
      for (let dz = -pad; dz <= pad; dz++) {
        for (let dx = -pad; dx <= pad; dx++) {
          const nx = x + dx, nz = z + dz;
          if (nx < 0 || nz < 0 || nx >= RW || nz >= RZ) continue;
          const n = nz * RW + nx;
          if (!footCell[n]) ring.push(street[n]);
        }
      }
    }
    C.ringMed = med(ring.length ? ring : [...C.foot.keys()].map((c) => street[c]));
    C.baseRel = med([...C.foot.values()].map((y) => y - sMed));
    C.S = C.ringMed - C.baseRel;
    C.terrace = C.ringMed;
  }

  // ---- 9. 最终地面场 = 街道 + footprint 台面，再做一次全域 Lipschitz ----
  // 第二次平滑把「台面 ↔ 街道」的高差也摊成缓坡（台面因此可能小幅下落，基座填充按最终地面补）。
  const ground = Int16Array.from(street);
  for (const C of comps) if (C.rigid) for (const c of C.foot.keys()) ground[c] = C.terrace;
  smoothField(ground, new Uint8Array(NC).fill(1));

  // ---- 10. 条目：yRel 与去重 ----
  const compOf = new Map();
  const compRank = new Map();
  comps.forEach((C, rank) => {
    if (!C.rigid) return;
    for (const i of C.members) { compOf.set(i, C); compRank.set(i, rank); }
  });
  const cellOwner = new Map();
  let dyMax = -1e9, dyMin = 1e9, droppedUnder = 0, conflicts = 0;
  const sOfBlock = new Map();
  for (const r of retained) {
    const { x, y, z, v, c, building } = r;
    const i = idx(x, y, z);
    const cc = building ? compOf.get(i) : null;
    // 刚性分量：全程同一个 S_C（严格 I5）；其余：逐列跟随地面。
    const yRel = cc ? y - sMed + cc.S : y - (isTerrain(c) ? gY[c] : gY[nearest[c]]) + ground[c];
    if (gY[c] < 0 && yRel < ground[c]) { droppedUnder++; continue; }
    const key = c * 4096 + (yRel + 2048);
    const rank = cc ? 1e6 - compRank.get(i) : 0;              // 刚性块 rank 越大越优先
    const prev = cellOwner.get(key);
    if (prev) { conflicts++; if (rank < prev.rank) continue; } // 同 rank（非刚性）后到者（y 更高）覆盖
    cellOwner.set(key, { c, y: yRel, name: nameOf(v), rank, i, sb: cc ? cc.S : ground[c] - (isTerrain(c) ? gY[c] : gY[nearest[c]]) });
  }

  // ---- 11. 基座填充（spec §15.4 步骤 4）：限高，拱洞/挑檐列保持通透 ----
  let fillCount = 0, archCols = 0;
  for (const C of comps) {
    if (!C.rigid) continue;
    for (const [c, minY] of C.foot) {
      const bottom = (minY - sMed) + C.S;
      const gap = bottom - 1 - ground[c];
      if (gap > maxFill) { archCols++; continue; }            // 底面远高于台面 = 拱洞/挑檐
      for (let y = ground[c] + 1; y <= bottom - 1; y++) {
        const key = c * 4096 + (y + 2048);
        if (cellOwner.has(key)) continue;
        cellOwner.set(key, { c, y, name: fillName, rank: -1, i: -1, sb: null });
        fillCount++;
      }
    }
  }

  // ---- 12. 玻璃窗框过滤（spec §15.4 步骤 6）：无框玻璃壳/网全部删除 ----
  // ⚠️ 邻接统计必须在**删除前**一次性做完（边删边统计会让邻接关系自我改变，留下数量取决于遍历顺序）。
  const atName = new Map();
  for (const o of cellOwner.values()) atName.set(o.c * 4096 + (o.y + 2048), o.name);
  let glassKept = 0, glassDropped = 0;
  {
    const doomed = [];
    for (const [key, o] of cellOwner) {
      if (o.name !== glassName) continue;
      const ox = o.c % RW, oz = (o.c / RW) | 0;
      let solid = 0;
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const nx = ox + dx, nz = oz + dz;
        if (nx < 0 || nz < 0 || nx >= RW || nz >= RZ) continue;
        const nm = atName.get((nz * RW + nx) * 4096 + (o.y + dy + 2048));
        if (nm !== undefined && nm !== glassName) solid++;
      }
      if (solid >= glassFrameMin) glassKept++;
      else { doomed.push(key); glassDropped++; }
    }
    for (const key of doomed) cellOwner.delete(key);
  }

  // ---- 11c. 孤立方块过滤（spec §15.9，v1.70）：六邻接全空的方块删除 ----
  // 用户实玩反馈「空中有大量的悬空方块」。实测当前产物 3,760 个（占 1.96%），其中 3,607 个悬空、
  // 3,154 个悬在 11 格以上。**不是删玻璃的次生后果**（玻璃全保留时仍有 3,888 个，源模型自带）。
  //
  // ⚠️ 两处口径是载荷性的：
  //   ① 必须在玻璃过滤（步骤 12）**之后**跑 —— 删玻璃会给边缘列造出新孤儿；
  //      但必须在**地面补齐（步骤 11b）之前**跑 —— 否则会把刚补的地面方块当成孤立块删掉。
  //   ② 只删一轮即到不动点（实测：第 1 轮 3,760、第 2 轮 0），无需迭代；
  //      但仍保留不动点循环，因为改后面的参数时可能出现级联 —— 迭代成本可忽略。
  //   ③ `isolatedDropped` 记的是**过滤当时删掉的个数**（实测 3,761），它比净减（3,711）多 50 ——
  //      因为后续「地面补齐」又把其中 50 个**位于 `y === ground[c]` 的列唯一块**补了回来
  //      （那是玩家脚下的锚点，不得为空）。两个数都对，别拿一个去推另一个。
  let isolatedDropped = 0;
  if (dropIsolated) {
    const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    for (let round = 0; round < 8; round++) {
      const doomed = [];
      for (const [key, o] of cellOwner) {
        const ox = o.c % RW, oz = (o.c / RW) | 0;
        let touching = 0;
        for (const [dx, dy, dz] of N6) {
          const nx = ox + dx, nz = oz + dz;
          if (nx < 0 || nz < 0 || nx >= RW || nz >= RZ) continue;
          if (cellOwner.has((nz * RW + nx) * 4096 + (o.y + dy + 2048))) { touching++; break; }
        }
        if (touching === 0) doomed.push(key);
      }
      if (!doomed.length) break;
      for (const key of doomed) cellOwner.delete(key);
      isolatedDropped += doomed.length;
    }
  }

  // ---- 12. 地面补齐（spec §15）：必须在**玻璃过滤 + 孤立块过滤之后**做 ——
  // 两者都会删掉整列都只有装饰块的列，那时它们才真正变空。放在前面会补出一批随后又被删的格子
  // （实测：补了但没生效，仍缺 236 列；再叠上孤立块过滤，不放在后面就会「补一格→被当孤立删掉→再补」循环）。
  // 目的：Lipschitz 平滑会把部分列的 ground 抬到它原本最高块之上（实测 236 列），
  // 那些列因此「在 dy===ground 处没有方块」——而 `ground[c]` 是玩家脚下的锚点（出生点扫描、
  // 水面门控、`check:data` 的 ground↔blocks 一致契约都靠它）。不补就是地表凭空虚空一格。
  {
    for (let c = 0; c < NC; c++) {
      if (!isTerrain(c)) continue;
      const g = ground[c];
      const key = c * 4096 + (g + 2048);
      if (cellOwner.has(key)) continue;
      // 该列在 ground 处已有方块则跳过；否则补一格填充（与 core 基底同材）
      cellOwner.set(key, { c, y: g, name: fillName, rank: -2, i: -1, sb: null });
      fillCount++;
      if (g > dyMax) dyMax = g;
      if (g < dyMin) dyMin = g;
    }
  }

  const ents = [];
  for (const o of cellOwner.values()) {
    ents.push({ c: o.c, y: o.y, name: o.name });
    // sOfBlock 只记**源块**（o.i >= 0）：它是 I5′「竖向接触平移量一致」的数据源。
    // 基座填充是新生成的几何（不是平移出来的），没有自己的平移量，不能混进这个度量
    // —— 混进去会让 I5′ 恒报 3.6%，而几何其实完好（同列 112,291 对源块全部仍相邻）。
    if (o.i >= 0) sOfBlock.set(o.i, o.sb);
    if (o.y > dyMax) dyMax = o.y;
    if (o.y < dyMin) dyMin = o.y;
  }
  ents.sort((a, b) => a.c - b.c || a.y - b.y);

  // ---- 13. 统计与不变量 ----
  // island[c]=1 表示该列有岛面（= 有地形），供外推收敛与水面门控旧判据使用。
  const island = new Uint8Array(NC);
  for (let c = 0; c < NC; c++) if (isTerrain(c)) island[c] = 1;
  let vc = 0, vcBad = 0;
  // I5′ 违反的分类统计（诊断用）：区分「上下两块各自是刚性还是逐列平移」
  const dbgContact = {};
  /**
   * I5′ 参不参与统计：只看「同一平移族」的竖向接触。
   *
   * 旧算法里所有块都只有两种平移源（刚性 S_C / 逐列 S[c]），且建筑块必在上面，所以直接全量比。
   * §15 的新设计**故意**让刚性建筑与逐列铺装共存（房子不形变、地砖跟地形）——两者在交界处
   * 的平移量本来就不同，把它们计入会让 I5′ 恒报 3.6% 而几何其实完好（实测：同列 112,291 对
   * 源块全部仍相邻，孤立块 25,542 反而比源模型的 29,915 少）。
   *
   * 因此口径订正为：**只有「上下两块同属刚性或同属逐列」的接触才计入分母与分子**。
   * 分类统计见 `checks.dbgContact`（rigid|col 与 col|rigid 的计数就是被排除的那部分）。
   */
  const sameFamily = (i) => compOf.has(i);
  // 岛内相邻列高差上限（spec §15.4 的核心不变式）：平滑后必须 ≤ maxStep。
  // 它的意义是「跑动不被台阶打断」——1 格由 MAX_STEP 直接走，2 格需跳，>2 则被迫绕路。
  let maxIslandStep = 0;
  for (let z = 0; z < RZ; z++) {
    for (let x = 0; x < RW; x++) {
      const c = z * RW + x;
      if (!isTerrain(c)) continue;
      if (x < RW - 1 && isTerrain(c + 1)) maxIslandStep = Math.max(maxIslandStep, Math.abs(ground[c + 1] - ground[c]));
      if (z < RZ - 1 && isTerrain(c + RW)) maxIslandStep = Math.max(maxIslandStep, Math.abs(ground[c + RW] - ground[c]));
    }
  }
  for (const [i, sb] of sOfBlock) {
    if (i < WL) continue;
    const below = sOfBlock.get(i - WL);
    if (below === undefined) continue;
    // 不同平移族的竖向接触不计入 I5′（见 sameFamily 的注释）
    if (sameFamily(i) !== sameFamily(i - WL)) {
      const k = `${sameFamily(i) ? 'rigid' : 'col'}|${sameFamily(i - WL) ? 'rigid' : 'col'}`;
      dbgContact[k] = (dbgContact[k] || 0) + 1;
      continue;
    }
    vc++;
    if (sb !== below) vcBad++;
  }
  // 严格 I5：同一刚性分量内任意相邻块（+x / +z / +y 三个方向各算一次），烘焙后 yRel 差必须等于源 y 差。
  // 按**实际落盘的条目**（cellOwner）核对，而不是按分量定义核对——否则「逐列平移」的退化实现
  // （building 块误用 S[c]）也会因为定义上同属一个分量而通过。by-construction 恒为 0，
  // 它守的是发射路径：任何让同分量块用了不同平移量的改动都会让它 > 0。
  let intraBreaks = 0;
  const yRelOf = new Map();
  for (const o of cellOwner.values()) if (compOf.has(o.i)) yRelOf.set(o.i, o.y);
  for (const [i, yr] of yRelOf) {
    const C = compOf.get(i);
    for (const d of [1, W, WL]) {                                 // +x / +z / +y（idx = (y*L+z)*W+x）
      const j = i + d;
      if (compOf.get(j) !== C) continue;                          // 非同一分量（含 j 不是建筑块）
      const yj = yRelOf.get(j);
      if (yj === undefined) continue;                             // 邻块在去重中落选
      const srcDy = d === WL ? 1 : 0;                             // 源 y 差：+y 邻居为 1，其余为 0
      if (yj - yr !== srcDy) intraBreaks++;
    }
  }
  let minG = 0, maxG = 0;
  for (let c = 0; c < NC; c++) {
    if (ground[c] < minG) minG = ground[c];
    if (ground[c] > maxG) maxG = ground[c];
  }
  let borderNZ = 0;
  for (let z = 0; z < RZ; z++) {
    for (let x = 0; x < RW; x++) {
      if ((x === 0 || z === 0 || x === RW - 1 || z === RZ - 1) && ground[z * RW + x] !== 0) borderNZ++;
    }
  }
  let outAdj = 0;
  for (let z = 0; z < RZ; z++) {
    for (let x = 0; x < RW; x++) {
      const c = z * RW + x;
      if (island[c]) continue;
      if (x < RW - 1 && !island[c + 1]) outAdj = Math.max(outAdj, Math.abs(ground[c] - ground[c + 1]));
      if (z < RZ - 1 && !island[c + RW]) outAdj = Math.max(outAdj, Math.abs(ground[c] - ground[c + RW]));
    }
  }
  return {
    width: RW, length: RZ, bounds: { minX, maxX, minZ, maxZ }, sMed,
    ground, island, ents, dyMin, dyMax,
    checks: { intraCompBreaks: intraBreaks, maxIslandStep, dbgContact },   // 不进 stats / 不落盘（产物 JSON 的 stats 形状不变）
    stats: {
      terrainColumns: gs.length, comps: comps.length, rigid: rigidN, nearBorder: borderSkipped,
      smallComps: smallN, retained: ents.length, droppedUnder, conflicts,
      groundMin: minG, groundMax: maxG, verticalContacts: vc, contactBreaks: vcBad,
      borderNonZero: borderNZ, outsideAdjMax: outAdj,
      // ---- spec §15（v1.69 / v1.70）----
      maxIslandStep, baseFill: fillCount, archCols, glassKept, glassDropped, isolatedDropped,
    },
  };
}

/**
 * 出生点选择（spec §13.6.1 的严格判据）。
 *
 * ⚠️ **判据必须是「其上 headroom 格全空」，不是「上方 2 格空气」** —— v1.0 的弱判据
 * 选中过 `168:2` 屋顶块的顶面（该列自上而下第一个方块），玩家一出生就站在塔顶。
 *
 * @param {Object} model bakeRedCityCore 的返回
 * @param {Object} [opt]
 * @param {number} [opt.headroom=24]  本列头顶净空格数
 * @param {number} [opt.wallClear=3]  5×5 邻域每列的头顶净空（防贴墙/贴树冠）
 * @param {number} [opt.flatRange=1]  5×5 内 ground 极差上限
 * @param {number} [opt.halfWin=2]    5×5 窗口的半宽
 * @returns {{ox:number, oz:number, dy:number, d:number}|null}
 */
export function pickSpawn({ width: RW, length: RZ, ground, island, ents }, {
  headroom = 24, wallClear = 3, flatRange = 1, halfWin = 2,
} = {}) {
  const occ = new Map();
  for (const e of ents) {
    let s = occ.get(e.c);
    if (!s) occ.set(e.c, s = new Set());
    s.add(e.y);
  }
  const free = (c, y0, y1) => {
    const s = occ.get(c);
    if (!s) return true;
    for (let y = y0; y <= y1; y++) if (s.has(y)) return false;
    return true;
  };
  const cx0 = (RW - 1) / 2, cz0 = (RZ - 1) / 2;
  let best = null;
  for (let z = halfWin; z < RZ - halfWin; z++) {
    for (let x = halfWin; x < RW - halfWin; x++) {
      const c = z * RW + x;
      if (!island[c]) continue;
      const g = ground[c];
      const s = occ.get(c);
      if (!s || !s.has(g)) continue;                    // 脚下必须是烘焙出的岛面方块
      if (!free(c, g + 1, g + headroom)) continue;      // 本列头顶净空
      let lo = 1e9, hi = -1e9, ok = true;
      for (let dz = -halfWin; dz <= halfWin && ok; dz++) {
        for (let dx = -halfWin; dx <= halfWin; dx++) {
          const cc = (z + dz) * RW + (x + dx);
          const gg = ground[cc];
          lo = Math.min(lo, gg); hi = Math.max(hi, gg);
          if (!free(cc, gg + 1, gg + wallClear)) { ok = false; break; }   // 5×5 不贴墙/树冠
        }
      }
      if (!ok || hi - lo > flatRange) continue;
      const d = Math.hypot(x - cx0, z - cz0);
      if (!best || d < best.d - 1e-9 || (Math.abs(d - best.d) <= 1e-9 && (z < best.oz || (z === best.oz && x < best.ox)))) {
        best = { ox: x, oz: z, dy: g, d };
      }
    }
  }
  return best;
}
