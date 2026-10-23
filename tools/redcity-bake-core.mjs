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
 * @returns {Object} 见 return 语句
 */
export function bakeRedCityCore(schematic, cfg) {
  const { grid, W, H, L } = schematic;
  const { isEmpty, isSkin, isBuilding, nameOf, params } = cfg;
  const { relief, K, groundFloor: FLOOR, decay, pad, minComp, borderKeep } = params;
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

  // ---- 3. 目标平移 S0 / 下限 Slow；最近地形列（4 邻接 BFS）----
  const relTarget = (g) => Math.max(Math.round((g - sMed) * relief), FLOOR);
  const S0 = new Int16Array(NC);
  const Slow = new Int16Array(NC).fill(-32000);
  const nearest = new Int32Array(NC).fill(-1);
  const dist = new Int16Array(NC).fill(-1);
  const bq = [];
  for (let c = 0; c < NC; c++) {
    if (!isTerrain(c)) continue;
    S0[c] = relTarget(gY[c]) - (gY[c] - sMed);
    Slow[c] = FLOOR - (gY[c] - sMed);
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

  // ---- 6. 平移场 S：初值 → 按体量降序给每个刚性分量涂色 ----
  const med = (a) => { const s = [...a].sort((p, q) => p - q); return s[s.length >> 1]; };
  const S = new Int16Array(NC);
  const painted = new Uint8Array(NC);
  for (let c = 0; c < NC; c++) S[c] = isTerrain(c) ? S0[c] : S0[nearest[c]];
  const nearBorder = (c) => {
    const x = c % RW, z = (c / RW) | 0;
    return x < borderKeep || z < borderKeep || x >= RW - borderKeep || z >= RZ - borderKeep;
  };
  let rigidN = 0, borderSkipped = 0;
  for (const C of comps) {
    const base = new Map(); const foot = new Set();
    for (const i of C.members) {
      const x = i % W, z = ((i / W) | 0) % L, y = (i / WL) | 0;
      const c = cidx(x, z);
      foot.add(c);
      if (!base.has(c) || base.get(c) > y) base.set(c, y);   // 每列最低接地点
    }
    let near = false;
    for (const c of foot) if (nearBorder(c)) { near = true; break; }
    C.rigid = !near;
    if (near) { borderSkipped++; continue; }
    rigidN++;
    C.S = med([...base.keys()].map((c) => S[c]));            // 参考地面高度 = 接地点 S 的中位
    let low = -32000; const cells = new Set();
    for (const c of foot) {
      const x0 = c % RW, z0 = (c / RW) | 0;
      for (let dz = -pad; dz <= pad; dz++) {
        for (let dx = -pad; dx <= pad; dx++) {
          const nx = x0 + dx, nz = z0 + dz;
          if (nx < 0 || nz < 0 || nx >= RW || nz >= RZ) continue;
          const n = nz * RW + nx;
          cells.add(n);
          if (isTerrain(n)) low = Math.max(low, Slow[n]);
        }
      }
    }
    if (C.S < low) C.S = low;                                // 平移量不得使任一涂色岛列的 ground′ 低于地面下限（保 I3）
    for (const n of cells) if (!painted[n]) { painted[n] = 1; S[n] = C.S; }
  }

  // ---- 7. 地面高度场 ground'：地形列 = g - sMed + S；其余列外推 + Lipschitz 收敛 ----
  const ground = new Int16Array(NC);
  const island = new Uint8Array(NC);
  for (let c = 0; c < NC; c++) {
    if (!isTerrain(c)) continue;
    ground[c] = gY[c] - sMed + S[c];
    island[c] = 1;
  }
  for (let c = 0; c < NC; c++) {
    if (island[c]) continue;
    const r = ground[nearest[c]], d = dist[c];
    const mag = Math.max(0, Math.abs(r) - Math.floor(d / decay));
    ground[c] = r < 0 ? -mag : mag;
  }
  {
    let ch = true, it = 0;
    while (ch && it++ < 300) {
      ch = false;
      for (let z = 0; z < RZ; z++) {
        for (let x = 0; x < RW; x++) {
          const c = z * RW + x;
          if (island[c]) continue;
          for (const [dx, dz] of [[1, 0], [0, 1]]) {
            const nx = x + dx, nz = z + dz;
            if (nx >= RW || nz >= RZ) continue;
            const n = nz * RW + nx;
            if (island[n]) continue;
            const d = ground[c] - ground[n];
            if (d > 1 || d < -1) {
              const hi = Math.abs(ground[c]) > Math.abs(ground[n]) ? c : n;
              ground[hi] += ground[hi] > 0 ? -1 : 1;
              ch = true;
            }
          }
        }
      }
    }
    if (ch) throw new Error('redcity: 岛外地面外推未在 300 轮内收敛');
  }

  // ---- 8. 条目：yRel = y - sMed + S_block；无地面列丢弃 yRel < ground'；同格去重 ----
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
    const sb = cc ? cc.S : S[c];
    const yRel = y - sMed + sb;
    if (gY[c] < 0 && yRel < ground[c]) { droppedUnder++; continue; }
    const key = c * 4096 + (yRel + 2048);
    const rank = cc ? 1e6 - compRank.get(i) : 0;              // 刚性块 rank 越大越优先
    const prev = cellOwner.get(key);
    if (prev) { conflicts++; if (rank < prev.rank) continue; } // 同 rank（非刚性）后到者（y 更高）覆盖
    cellOwner.set(key, { c, y: yRel, name: nameOf(v), rank, i, sb });
  }
  const ents = [];
  for (const o of cellOwner.values()) {
    ents.push({ c: o.c, y: o.y, name: o.name });
    sOfBlock.set(o.i, o.sb);
    if (o.y > dyMax) dyMax = o.y;
    if (o.y < dyMin) dyMin = o.y;
  }
  ents.sort((a, b) => a.c - b.c || a.y - b.y);

  // ---- 9. 统计与不变量 ----
  let vc = 0, vcBad = 0;
  for (const [i, sb] of sOfBlock) {
    if (i < WL) continue;
    const below = sOfBlock.get(i - WL);
    if (below === undefined) continue;
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
    checks: { intraCompBreaks: intraBreaks },                    // 不进 stats / 不落盘（产物 JSON 的 stats 形状不变）
    stats: {
      terrainColumns: gs.length, comps: comps.length, rigid: rigidN, nearBorder: borderSkipped,
      smallComps: smallN, retained: ents.length, droppedUnder, conflicts,
      groundMin: minG, groundMax: maxG, verticalContacts: vc, contactBreaks: vcBad,
      borderNonZero: borderNZ, outsideAdjMax: outAdj,
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
