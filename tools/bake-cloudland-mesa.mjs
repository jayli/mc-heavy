// tools/bake-cloudland-mesa.mjs — 把 CLOUDLAND 素材的 Landscape/9 高台烘焙成结构 JSON
// 用法：npm run mesa → assets/structures/cloudland_mesa_small.json + cloudland_mesa_small.meta.json
//
// 流程：gunzip → 最小 NBT 读取（Sponge Schematic v3）→ 剔除 y=0 地板层 → 26 连通分量
//   → 按 BlockCount 匹配 Landscape/9（10712）→ 平移到基座质心为原点、y 归一化到 1
//   → 逐格过 BLOCK_MAP（未命中 throw）→ palette 索引压缩 → 写 JSON + meta。
//
// ## 为什么按 BlockCount 匹配而不是按坐标
// 素材是一个 385×85×280 的合集，38 个互不相连的结构平铺在里面。`.bp` 蓝图文件只存
// `BlockCount` 元数据 + 缩略图（不含方块数据），而 26 连通分量的格数能与某个 `.bp` 的
// `BlockCount` **精确唯一对上** —— 这是「哪个蓝图对应哪块几何」唯一可靠的对应关系。
// Landscape/9 的 10712 在 38 个分量里唯一。
//
// ## 为什么剔除 y=0 层
// y=0 是素材的地板/道路层（70094 格 black_terracotta + 10833 black_concrete + 8465 white_wool），
// 不属于任何单个结构；不剔除会让全部 38 个分量连成一片。
//
// ## 为什么输出 palette 扁平数组而不是 {x,y,z,type}
// 10712 格逐字写对象约 500KB；palette 索引压缩后约 90KB。`structure-json.js` 的
// loadStructure 已支持两种形状（Task 3）。
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import {
  SCHEM_PATH, MESA_JSON, MESA_META, SOURCE_COMPONENT_BLOCKS, BLOCK_MAP, MESA_METRICS,
  MESA_ORIGIN, cloudlandMesaInputFingerprint,
} from './cloudland-mesa-fingerprint.mjs';
import { NbtReader } from './nbt-reader.mjs';

/** y=0 是素材的地板/道路层，不属于任何单个结构（见文件头） */
const GROUND_LAYER_Y = 0;

// ---------------------------------------------------------------- .schem 读取

function loadSchematic() {
  const root = (() => {
    const r = new NbtReader(zlib.gunzipSync(fs.readFileSync(SCHEM_PATH)));
    const t = r.u1();
    r.str();
    return r.payload(t);
  })();
  const S = root.Schematic || root;
  const { Width: W, Height: H, Length: L } = S;
  // Sponge v2/v3 的字段名有两种：v3 用 Blocks.Palette / Blocks.Data，v2 用 Palette / BlockData
  const paletteSrc = S.Blocks ? S.Blocks.Palette : S.Palette;
  const dataSrc = S.Blocks ? S.Blocks.Data : S.BlockData;
  const pal = [];
  for (const [name, id] of Object.entries(paletteSrc)) {
    pal[id] = name.replace('minecraft:', '').split('[')[0];
  }
  // Data = varint 数组
  const data = dataSrc;
  const blocks = new Uint16Array(W * H * L);
  let p = 0, n = 0;
  while (p < data.length) {
    let v = 0, sh = 0, b;
    do { b = data[p++]; v |= (b & 0x7f) << sh; sh += 7; } while (b & 0x80);
    blocks[n++] = v;
  }
  if (n !== W * H * L) throw new Error(`Data 长度 ${n} ≠ ${W}×${H}×${L}`);
  const airId = Object.entries(paletteSrc).find(([name]) => name === 'minecraft:air')?.[1];
  return {
    W, H, L, pal, blocks, airId,
    idx: (x, y, z) => (y * L + z) * W + x,
    at: (x, y, z) => pal[blocks[(y * L + z) * W + x]],
  };
}

// ---------------------------------------------------------------- 连通分量（26 邻接）

/**
 * 对 y ≥ 1 的实心格做 26 连通分量。返回每个分量的 {cells, x0..z1, n}。
 * 26 邻接（含对角）而非 6：素材里的岩石结构靠角相连（只走正交会把它切成碎块）。
 */
function connectedComponents(s) {
  const { W, H, L } = s;
  const N = W * H * L;
  const solid = new Uint8Array(N);
  for (let y = GROUND_LAYER_Y + 1; y < H; y++) {
    const base = y * L * W;
    solid.set(s.blocks.subarray(base, base + L * W), base);
  }
  const seen = new Uint8Array(N);
  const comps = [];
  const stack = [];
  for (let i = 0; i < N; i++) {
    if (!solid[i] || seen[i]) continue;
    seen[i] = 1;
    stack.push(i);
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
        if (ny <= GROUND_LAYER_Y || ny >= H) continue;
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
  return comps;
}

/** 找 BlockCount 精确等于目标值的分量（唯一性由 §2.3 实测定死） */
function findComponent(comps, blockCount) {
  const hits = comps.filter((c) => c.n === blockCount);
  if (hits.length === 0) {
    const near = comps.map((c) => c.n).sort((a, b) => Math.abs(a - blockCount) - Math.abs(b - blockCount)).slice(0, 5);
    throw new Error(`没有 BlockCount=${blockCount} 的连通分量；最接近的 5 个：${near.join(', ')}`);
  }
  if (hits.length > 1) throw new Error(`BlockCount=${blockCount} 不唯一（${hits.length} 个分量）—— 匹配依据失效，须换判据`);
  return hits[0];
}

/** 分量内每个 (x,z) 列的最底层 y（用于基座判据与断言） */
function columnBottoms(s, comp) {
  const m = new Map();
  for (const c of comp.cells) {
    const y = Math.floor(c / (s.W * s.L));
    const r = c - y * s.W * s.L;
    const z = Math.floor(r / s.W);
    const x = r - z * s.W;
    const k = `${x},${z}`;
    const prev = m.get(k);
    if (prev === undefined || y < prev) m.set(k, y);
  }
  return m;
}

// ---------------------------------------------------------------- 主流程

function main() {
  const s = loadSchematic();
  const comps = connectedComponents(s);
  const comp = findComponent(comps, SOURCE_COMPONENT_BLOCKS);

  // 现场方块名普查（映射表的唯一事实来源：不凭规格表猜名字）
  const census = new Map();
  for (const c of comp.cells) {
    const name = s.pal[s.blocks[c]];
    census.set(name, (census.get(name) ?? 0) + 1);
  }

  // ---- 检查模式：只打印，不写文件 ----
  if (process.argv.includes('--census')) {
    const sorted = [...census.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`Landscape/9 分量：${comp.n} 格，bbox ${comp.x1 - comp.x0 + 1}×${comp.y1 - comp.y0 + 1}×${comp.z1 - comp.z0 + 1}，${sorted.length} 种源方块`);
    for (const [name, n] of sorted) {
      const mapped = BLOCK_MAP[name];
      console.log(`  ${String(n).padStart(5)}  ${name.padEnd(28)} → ${mapped ?? '【未映射】'}`);
    }
    const missing = sorted.filter(([name]) => !BLOCK_MAP[name]).map(([n]) => n);
    if (missing.length) {
      console.log(`\n未映射 ${missing.length} 种：${missing.join(', ')}`);
    } else {
      console.log('\n全部已映射');
    }
    return;
  }

  // ---- 烘焙 ----
  const unmapped = [];
  for (const [name, n] of census) if (!BLOCK_MAP[name]) unmapped.push(`${name}(${n})`);
  if (unmapped.length) {
    throw new Error(`有 ${unmapped.length} 种源方块不在 BLOCK_MAP 里：${unmapped.join(', ')} —— 补映射表后重跑`);
  }

  const OX = comp.x0 + MESA_ORIGIN.cx;
  const OZ = comp.z0 + MESA_ORIGIN.cz;
  const palette = [];
  const paletteIndex = new Map();
  const blocks = [];
  for (const c of comp.cells) {
    const y = Math.floor(c / (s.W * s.L));
    const r = c - y * s.W * s.L;
    const z = Math.floor(r / s.W);
    const x = r - z * s.W;
    const target = BLOCK_MAP[s.pal[s.blocks[c]]];
    let pi = paletteIndex.get(target);
    if (pi === undefined) { pi = palette.length; palette.push(target); paletteIndex.set(target, pi); }
    // y 相对最低层后 +1（既有结构 JSON 的约定：最低点归一化为 y=1）
    blocks.push(x - OX, y - comp.y0 + 1, z - OZ, pi);
  }

  // ---- 断言 ----
  const M = MESA_METRICS;
  const n = blocks.length / 4;
  if (n !== M.blocks) throw new Error(`方块数 ${n} ≠ MESA_METRICS.blocks ${M.blocks}`);
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity, mnz = Infinity, mxz = -Infinity;
  const baseCols = new Set();
  for (let i = 0; i < blocks.length; i += 4) {
    const x = blocks[i], y = blocks[i + 1], z = blocks[i + 2];
    mnx = Math.min(mnx, x); mxx = Math.max(mxx, x);
    mny = Math.min(mny, y); mxy = Math.max(mxy, y);
    mnz = Math.min(mnz, z); mxz = Math.max(mxz, z);
    if (y === 1) baseCols.add(`${x},${z}`);
  }
  const W = mxx - mnx + 1, H = mxy - mny + 1, D = mxz - mnz + 1;
  if (W !== M.width) throw new Error(`宽 ${W} ≠ ${M.width}`);
  if (H !== M.height) throw new Error(`高 ${H} ≠ ${M.height}`);
  if (D !== M.depth) throw new Error(`深 ${D} ≠ ${M.depth}`);
  if (mny !== 1) throw new Error(`最低点 y=${mny} ≠ 1（归一化失败）`);
  if (baseCols.size !== M.baseCells) throw new Error(`基座列数 ${baseCols.size} ≠ ${M.baseCells}`);
  for (const name of palette) {
    if (name.includes('minecraft:') || name.includes('[')) throw new Error(`palette 含未剥净的方块名 "${name}"`);
  }

  // 基座每列都不悬空：每列的 y=1 格必须存在（上面 baseCols 已覆盖），
  // 另外底座最小层必须覆盖 164 列里每一列 —— 由 baseCells 断言与「Landscape/9 的 y=1 层是 164 格」共同保证。

  const json = {
    version: 1,
    sourceComponentBlocks: SOURCE_COMPONENT_BLOCKS,
    palette,
    blocks,
  };
  const fp = cloudlandMesaInputFingerprint();
  const meta = {
    version: 1,
    sourceComponentBlocks: SOURCE_COMPONENT_BLOCKS,
    width: W, height: H, depth: D,
    blocks: n,
    baseCells: baseCols.size,
    paletteSize: palette.length,
    origin: { cx: MESA_ORIGIN.cx, cz: MESA_ORIGIN.cz },
    fingerprints: fp,
    sourceBounds: { x0: comp.x0, x1: comp.x1, y0: comp.y0, y1: comp.y1, z0: comp.z0, z1: comp.z1 },
  };

  fs.mkdirSync(path.dirname(MESA_JSON), { recursive: true });
  fs.writeFileSync(MESA_JSON, JSON.stringify(json));
  fs.writeFileSync(MESA_META, `${JSON.stringify(meta, null, 2)}\n`);
  const kb = (fs.statSync(MESA_JSON).size / 1024).toFixed(1);
  console.log(`高台 JSON ${kb} KB，${n} 格，${W}×${H}×${D}，palette ${palette.length} 种，基座 ${baseCols.size} 列`);
  console.log(`指纹 ${fp.input}`);
}

main();
