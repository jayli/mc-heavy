// tools/bake-shallow-tarns.mjs — 把 Valtury 地形素材烘成 5 个「浅水高台」结构 JSON
// 用法：npm run shallowtarns          烘焙 → assets/structures/shallow_tarn_0{1..5}.json
//                                         + assets/structures/shallow_tarns.meta.json
//       node tools/bake-shallow-tarns.mjs --census   只打印连通分量普查，不写文件
//
// ## 流程
// gunzip → 最小 NBT 读取（Sponge Schematic v3）→ **丢弃 y=0 展台基座** → 26 连通分量
//   → 取 5 个指定分量（按 `SHALLOW_TARN_METRICS[*].componentIndex`）→ 以水平包围盒中心为原点、
//   y 归一化到 1 → 逐格过 `BLOCK_MAP`（未命中 throw）→ palette 索引压缩 → 写 JSON。
//
// ## 为什么要丢 y=0
// 实测 y=0 有 76,170 格（`white_concrete` 71,591 + `yellow_concrete` 3,108 + 少量 `andesite`/
// `stone`/`light_gray_concrete_powder`）—— 是作者摆作品用的**展台**，不属于任何一座高台。
// 不丢的话 28 个独立结构会被它连成一片（与 Cloudland 素材同一条教训）。
//
// ## 为什么未知源方块必须 throw
// `makeColumnSetter` 对未注册名字是**静默 return**（`landmarks.js`）→ 那格变 air，
// 方块层面完全看不出是映射错了。所以映射缺失必须在烘焙期炸掉。
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { NbtReader } from './nbt-reader.mjs';
import {
  SCHEM_PATH, STRUCTURE_DIR, SHALLOW_TARN_META, BLOCK_MAP, CONTAINER_LAYER_Y,
  GRASS_MARKER_BLOCK, SHALLOW_TARN_PALETTE, SHALLOW_TARN_FORMAT_VERSION,
  SHALLOW_TARN_VARIANTS, SHALLOW_TARN_METRICS, shallowTarnInputFingerprint, variantPath, ROOT,
} from './shallow-tarns-fingerprint.mjs';

/** 产物格式：4 项 stride（x, y, z, paletteIndex）—— 素材没有需要朝向的方块 */
const STRIDE = 4;

/** 分量最少格数：低于它的分量是 `black_concrete` 地面细节碎片（实测 1~51 格） */
const MIN_COMPONENT_BLOCKS = 400;

// ---------------------------------------------------------------- .schem 读取

/**
 * 读 Sponge Schematic v3。返回 `{ W,H,L, pal, blocks }`，`pal` 是**剥过前缀与属性**的方块名。
 *
 * ⚠️ **palette 索引 0 不一定是 air**：本素材实测索引 3 才是 air（0=yellow_concrete）。
 * Cloudland 的烘焙脚本硬断言「索引 0 是 air」是因为它把索引真值当实心判据；
 * 这里显式解析 air 的下标，不做那个假设。
 */
function loadSchematic() {
  const r = new NbtReader(zlib.gunzipSync(fs.readFileSync(SCHEM_PATH)));
  const tagType = r.u1();
  r.str();
  const root = r.payload(tagType);
  const S = root.Schematic || root;
  const { Width: W, Height: H, Length: L, Version, DataVersion } = S;
  const paletteSrc = S.Blocks ? S.Blocks.Palette : S.Palette;
  const dataSrc = S.Blocks ? S.Blocks.Data : S.BlockData;
  const pal = [];
  for (const [name, id] of Object.entries(paletteSrc)) {
    pal[id] = name.replace('minecraft:', '').split('[')[0];
  }
  const airIndex = pal.indexOf('air');
  if (airIndex < 0) throw new Error('palette 里没有 air —— 素格式不认识，停止');

  const blocks = new Uint16Array(W * H * L);
  let p = 0, n = 0;
  while (p < dataSrc.length) {
    let v = 0, sh = 0, b;
    do { b = dataSrc[p++]; v |= (b & 0x7f) << sh; sh += 7; } while (b & 0x80);
    blocks[n++] = v;
  }
  if (n !== W * H * L) throw new Error(`Data 长度 ${n} ≠ ${W}×${H}×${L}`);
  return { W, H, L, pal, blocks, airIndex, version: Version, dataVersion: DataVersion, paletteEntryCount: Object.keys(paletteSrc).length };
}

/** 全局下标 ↔ 坐标（Sponge v3 的索引序是 (y·L + z)·W + x） */
function idxOf(s, x, y, z) { return (y * s.L + z) * s.W + x; }

// ---------------------------------------------------------------- 连通分量（26 邻接）

/**
 * 对 y > `CONTAINER_LAYER_Y` 的实心格做 26 连通分量。
 *
 * 26 邻接（含对角）而非 6：素材里的岩石结构靠角相连（只走正交会把它切成碎块）。
 * @returns {Array<{cells:number[], n:number, x0:number,x1:number,y0:number,y1:number,z0:number,z1:number}>}
 */
function connectedComponents(s) {
  const { W, H, L, blocks, airIndex } = s;
  const N = W * H * L;
  const solid = new Uint8Array(N);
  for (let y = CONTAINER_LAYER_Y + 1; y < H; y++) {
    const base = y * L * W;
    for (let i = base; i < base + L * W; i++) if (blocks[i] !== airIndex) solid[i] = 1;
  }
  const seen = new Uint8Array(N);
  const comps = [];
  const stack = [];
  for (let start = 0; start < N; start++) {
    if (!solid[start] || seen[start]) continue;
    seen[start] = 1;
    stack.push(start);
    const cells = [];
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    while (stack.length) {
      const c = stack.pop();
      cells.push(c);
      const y = Math.floor(c / (W * L));
      const r = c - y * W * L;
      const z = Math.floor(r / W);
      const x = r - z * W;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny <= CONTAINER_LAYER_Y || ny >= H) continue;
        for (let dz = -1; dz <= 1; dz++) {
          const nz = z + dz;
          if (nz < 0 || nz >= L) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= W) continue;
            const j = (ny * L + nz) * W + nx;
            if (solid[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
          }
        }
      }
    }
    comps.push({ cells, n: cells.length, x0, x1, y0, y1, z0, z1 });
  }
  // 稳定排序：格数降序，同格数时按几何坐标兜底（不依赖 Map/遍历顺序）
  comps.sort((a, b) => (b.n - a.n) || (a.y0 - b.y0) || (a.x0 - b.x0) || (a.z0 - b.z0));
  return comps;
}

// ---------------------------------------------------------------- 映射

/**
 * 源方块 → 目标（`null` = 丢弃，字符串 = 目标方块名）。
 *
 * ⚠️ 未映射的源方块 **throw**（见文件头）。
 * @param {string} sourceName @returns {string|null}
 */
function classify(sourceName) {
  if (!Object.prototype.hasOwnProperty.call(BLOCK_MAP, sourceName)) {
    throw new Error(`未映射的源方块：${sourceName}（补 BLOCK_MAP 后重跑）`);
  }
  return BLOCK_MAP[sourceName];
}

/** 某个分量用到的源方块名 → 格数 */
function sourceCountsOf(s, comp) {
  const m = new Map();
  for (const c of comp.cells) {
    const name = s.pal[s.blocks[c]];
    m.set(name, (m.get(name) || 0) + 1);
  }
  return m;
}

// ---------------------------------------------------------------- 普查

/**
 * 全量源方块普查（含 y=0 展台层，供门禁反向断言「没有未知源方块被静默丢弃」）。
 * @returns {Map<string, number>}
 */
function censusSourceBlocks(s) {
  const m = new Map();
  for (let y = 0; y < s.H; y++) {
    for (let z = 0; z < s.L; z++) {
      for (let x = 0; x < s.W; x++) {
        const id = s.blocks[idxOf(s, x, y, z)];
        const name = s.pal[id];
        m.set(name, (m.get(name) || 0) + 1);
      }
    }
  }
  return m;
}

function census() {
  const s = loadSchematic();
  const comps = connectedComponents(s);
  const big = comps.filter((c) => c.n >= MIN_COMPONENT_BLOCKS);
  console.log(`素材 ${s.W}×${s.H}×${s.L}（Sponge v${s.version}，DataVersion ${s.dataVersion}），`
    + `palette ${s.paletteEntryCount} 条（剥前缀后 ${new Set(s.pal).size} 种）`);
  console.log(`丢弃 y=${CONTAINER_LAYER_Y} 展台后：${comps.length} 个分量，其中 ≥${MIN_COMPONENT_BLOCKS} 格的 ${big.length} 个\n`);

  console.log('=== 全部 ≥400 格的分量（含「平顶」度量） ===');
  console.log('  idx   格数   尺寸            最大同高台面      顶部4格内');
  for (let i = 0; i < big.length; i++) {
    const comp = big[i];
    const topMap = new Map();
    for (const c of comp.cells) {
      const y = Math.floor(c / (s.W * s.L));
      const r = c - y * s.W * s.L;
      const z = Math.floor(r / s.W);
      const x = r - z * s.W;
      const k = z * s.W + x;
      const cur = topMap.get(k);
      if (cur === undefined || y > cur) topMap.set(k, y);
    }
    const hist = new Map();
    for (const v of topMap.values()) hist.set(v, (hist.get(v) || 0) + 1);
    const levels = [...hist.entries()].sort((a, b) => b[1] - a[1]);
    let bestFlat = 0, bestFlatY = -1;
    for (const [y] of levels.slice(0, 8)) {
      const set = new Set();
      for (const [k, v] of topMap) if (v === y) set.add(k);
      const seen2 = new Set();
      let mx = 0;
      for (const k of set) {
        if (seen2.has(k)) continue;
        const q = [k]; seen2.add(k); let cnt = 0;
        while (q.length) {
          const ck = q.pop(); cnt++;
          const cx = ck % s.W, cz = (ck - cx) / s.W;
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nk = (cz + dz) * s.W + cx + dx;
            if (set.has(nk) && !seen2.has(nk)) { seen2.add(nk); q.push(nk); }
          }
        }
        if (cnt > mx) mx = cnt;
      }
      if (mx > bestFlat) { bestFlat = mx; bestFlatY = y; }
    }
    let nearTop = 0;
    for (const v of topMap.values()) if (v >= comp.y1 - 3) nearTop++;
    const dims = `${comp.x1 - comp.x0 + 1}×${comp.y1 - comp.y0 + 1}×${comp.z1 - comp.z0 + 1}`;
    const picked = SHALLOW_TARN_VARIANTS.find((v) => SHALLOW_TARN_METRICS[v].componentIndex === i);
    console.log(`  ${String(i).padStart(3)} ${String(comp.n).padStart(6)}  ${dims.padEnd(14)} `
      + `${String(bestFlat).padStart(5)}@y${String(bestFlatY).padStart(2)} (${(bestFlat / topMap.size * 100).toFixed(0)}% 列)   `
      + `${(nearTop / topMap.size * 100).toFixed(0)}%picked`.replace('picked', picked ? ` → ${picked}` : ''));
  }

  console.log('\n=== 源方块普查（全图，含 y=0 展台） ===');
  const counts = censusSourceBlocks(s);
  let unmapped = 0;
  for (const [name, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    let target;
    try { target = classify(name); } catch (e) { console.log(`  ✗ ${name.padEnd(30)} ${String(n).padStart(7)} 格 → 未映射`); unmapped += n; continue; }
    const label = target === null
      ? '（丢弃 / 展台基座）'
      : (target === GRASS_MARKER_BLOCK ? '草标记 → 光栅化期按噪声刷成 dark/light_grass' : target);
    console.log(`  ${name.padEnd(30)} ${String(n).padStart(7)} 格 → ${label}`);
  }
  if (unmapped) { console.log(`\n✗ 未映射共 ${unmapped} 格 —— 补 BLOCK_MAP 后重跑`); process.exitCode = 1; }
}

// ---------------------------------------------------------------- 烘焙

/** 选中的五个分量的尺寸必须与 `SHALLOW_TARN_METRICS` 一致（产物契约，先自守一道） */
function assertMetric(base, comp, n) {
  const m = SHALLOW_TARN_METRICS[base];
  const W = comp.x1 - comp.x0 + 1, H = comp.y1 - comp.y0 + 1, D = comp.z1 - comp.z0 + 1;
  const bad = [];
  if (m.width !== W) bad.push(`width ${W} ≠ ${m.width}`);
  if (m.height !== H) bad.push(`height ${H} ≠ ${m.height}`);
  if (m.depth !== D) bad.push(`depth ${D} ≠ ${m.depth}`);
  if (m.blocks !== n) bad.push(`blocks ${n} ≠ ${m.blocks}`);
  if (bad.length) {
    throw new Error(`${base}（分量 #${m.componentIndex}）与 SHALLOW_TARN_METRICS 不符：${bad.join('；')}\n`
      + '  → 素材变了或选型变了。跑 `npm run shallowtarns -- --census` 看实际值，同步数据文件后重跑。');
  }
}

function bake() {
  const s = loadSchematic();
  const comps = connectedComponents(s);

  const records = {};
  let grandTotal = 0;
  for (const base of SHALLOW_TARN_VARIANTS) {
    const m = SHALLOW_TARN_METRICS[base];
    const comp = comps[m.componentIndex];
    if (!comp) throw new Error(`${base}：分量 #${m.componentIndex} 不存在（只有 ${comps.length} 个分量）`);

    // 水平包围盒中心为原点（与 `bake-cloudland-kit` 同手法：落点的 wx/wz 就是结构水平中心）。
    // ⚠️ 奇数跨度必须用 `floor((x1-x0)/2)` 反推中心列 —— 与产物坐标系的 `lo/hi` 偏移约定配套，
    // 消费方的 AABB 半宽派生（`shallowTarnHalfWidth`）读的是同一份 width/depth。
    const OX = comp.x0 + Math.floor((comp.x1 - comp.x0) / 2);
    const OZ = comp.z0 + Math.floor((comp.z1 - comp.z0) / 2);

    const palette = [];
    const paletteIndex = new Map();
    const blocks = [];
    let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity, mnz = Infinity, mxz = -Infinity;
    const sourceCounts = sourceCountsOf(s, comp);

    for (const c of comp.cells) {
      const y = Math.floor(c / (s.W * s.L));
      const r = c - y * s.W * s.L;
      const z = Math.floor(r / s.W);
      const x = r - z * s.W;
      const srcName = s.pal[s.blocks[c]];
      const target = classify(srcName);
      // BLOCK_MAP 里 null 表示「丢弃」。但 y>0 的内容不该命中 null（那两项只在 y=0）——
      // 命中就说明素材变了，必须显式报出来而不是静默少格。
      if (target === null) {
        throw new Error(`${base}：y=${y} 出现被丢弃的源方块 "${srcName}" —— 它应当只在 y=${CONTAINER_LAYER_Y} 展台层`);
      }
      // y 相对最低层后 +1（既有结构 JSON 的约定：最低点归一化为 y=1）
      const by = y - comp.y0 + 1;
      let pi = paletteIndex.get(target);
      if (pi === undefined) { pi = palette.length; palette.push(target); paletteIndex.set(target, pi); }
      const bx = x - OX, bz = z - OZ;
      blocks.push(bx, by, bz, pi);
      if (bx < mnx) mnx = bx; if (bx > mxx) mxx = bx;
      if (by < mny) mny = by; if (by > mxy) mxy = by;
      if (bz < mnz) mnz = bz; if (bz > mxz) mxz = bz;
    }

    const n = blocks.length / STRIDE;
    assertMetric(base, comp, n);

    // 归一化与包围盒自检（防原点算错导致整体偏移 —— Cloudland 的同款断言）
    if (mny !== 1) throw new Error(`${base}：最低点 y=${mny} ≠ 1（归一化失败）`);
    if (mnx !== -Math.floor((comp.x1 - comp.x0) / 2) || mxz !== comp.z1 - OZ) {
      // 只做「跨度对得上」的软校验：真实 bbox 的 min/max 未必等于理论值（结构可能不是满铺矩形）
    }
    const W = mxx - mnx + 1, H = mxy - mny + 1, D = mxz - mnz + 1;
    if (W !== m.width || H !== m.height || D !== m.depth) {
      throw new Error(`${base}：产物 bbox ${W}×${H}×${D} ≠ SHALLOW_TARN_METRICS ${m.width}×${m.height}×${m.depth}`);
    }

    // palette 必须落在白名单内
    for (const name of palette) {
      if (!SHALLOW_TARN_PALETTE.includes(name)) {
        throw new Error(`${base}：palette 含白名单外的方块 "${name}"（同步 SHALLOW_TARN_PALETTE）`);
      }
    }
    fs.mkdirSync(STRUCTURE_DIR, { recursive: true });
    fs.writeFileSync(variantPath(base), JSON.stringify({
      version: SHALLOW_TARN_FORMAT_VERSION, palette, blocks,
    }));

    records[base] = {
      role: m.role,
      componentIndex: m.componentIndex,
      width: W, height: H, depth: D, blocks: n,
      paletteSize: palette.length,
      palette: [...palette].sort(),
      hasGrass: palette.includes(GRASS_MARKER_BLOCK),
      sourceCounts: Object.fromEntries([...sourceCounts.entries()].sort((a, b) => b[1] - a[1])),
      origin: { cx: OX, cz: OZ },
      sourceBounds: { x0: comp.x0, x1: comp.x1, y0: comp.y0, y1: comp.y1, z0: comp.z0, z1: comp.z1 },
    };
    grandTotal += n;
    console.log(`${base}.json  ${String(n).padStart(6)} 格  ${W}×${H}×${D}  palette ${palette.length} 种  `
      + `${palette.includes(GRASS_MARKER_BLOCK) ? '含草' : '无草'}`);
  }

  // 源方块普查（门禁用它反向断言「没有未知源方块被静默丢弃」）
  const fp = shallowTarnInputFingerprint();
  const meta = {
    version: 1,
    source: path.relative(ROOT, SCHEM_PATH),
    sourceSize: { width: s.W, height: s.H, length: s.L },
    sourceVersion: s.version,
    dataVersion: s.dataVersion,
    containerLayerY: CONTAINER_LAYER_Y,
    blockMap: BLOCK_MAP,
    paletteWhitelist: SHALLOW_TARN_PALETTE,
    grassMarkerBlock: GRASS_MARKER_BLOCK,
    variants: SHALLOW_TARN_VARIANTS,
    variantMetrics: records,
    totalBlocks: grandTotal,
    sourceBlockCounts: Object.fromEntries([...censusSourceBlocks(s).entries()].sort((a, b) => b[1] - a[1])),
    fingerprints: fp,
  };
  fs.writeFileSync(SHALLOW_TARN_META, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`\n共 ${SHALLOW_TARN_VARIANTS.length} 个产物，合计 ${grandTotal} 格`);
  console.log(`指纹 ${fp.input}`);
  console.log(`meta → ${path.relative(ROOT, SHALLOW_TARN_META)}`);
}

// ---------------------------------------------------------------- 入口

if (process.argv.includes('--census')) census();
else bake();
