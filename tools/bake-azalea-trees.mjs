// tools/bake-azalea-trees.mjs — 把 asset_oak.schem 的杜鹃主题行烘焙成 10 档杜鹃树变体 JSON
// 用法：npm run azaleatrees → assets/azalea-trees/trees.json + trees.meta.json
//
// 流程：gunzip → 最小 NBT 读取（Sponge Schematic v3，共享 tools/nbt-reader.mjs）→ 按灰线网格切 50 个地台
//   → 取杜鹃主题行（SOURCE_ROW）的 10 个地台 → 按 SOURCE_MAP 映射（树干 azalea_log / 三种叶并成一槽）
//   → 剥掉 y=0 地板 → 锚点 → 写 JSON。
//
// **1:1 原生尺度**（用户 2026-10-28 裁定）：不做降采样。巨树用 1/2 降采样是因为素材高 40+ 格；
// 杜鹃树原生高 12~29 格，是「华丽杜鹃树」的预期体量，降采样会砍掉全部枝叶细节。
//
// 索引序：(y*Length + z)*Width + x（与巨树烘焙同一实测口径）。
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import {
  SCHEM_PATH, TREES_JSON, TREES_META, PAD_COUNT, PAD_SIZE, PAD_COLS, PAD_ROWS, SOURCE_ROW,
  VARIANT_COUNT, PALETTE, LEAF_SLOT, SOURCE_MAP, SIZE_EXPECTATIONS, TOTAL_BLOCKS_RANGE,
  azaleaTreesInputFingerprint,
} from './azalea-trees-fingerprint.mjs';

import { NbtReader } from './nbt-reader.mjs';

function loadSchematic() {
  const root = (() => { const r = new NbtReader(zlib.gunzipSync(fs.readFileSync(SCHEM_PATH))); const t = r.u1(); r.str(); return r.payload(t); })();
  const S = root.Schematic || root;
  const { Width: W, Height: H, Length: L } = S;
  const pal = []; for (const [name, id] of Object.entries(S.Blocks.Palette)) pal[id] = name.replace('minecraft:', '').split('[')[0];
  const data = S.Blocks.Data; const blocks = new Uint16Array(W * H * L); let p = 0, n = 0;
  while (p < data.length) { let v = 0, sh = 0, b; do { b = data[p++]; v |= (b & 0x7f) << sh; sh += 7; } while (b & 0x80); blocks[n++] = v; }
  if (n !== W * H * L) throw new Error(`Data 长度 ${n} ≠ ${W}×${H}×${L}`);
  return { W, H, L, pal, blocks, at: (x, y, z) => pal[blocks[(y * L + z) * W + x]] };
}

// ---------------------------------------------------------------- 地台切分

/**
 * 灰线网格切分：y=0 层里「整列/整行都是 gray_concrete」的位置即分隔线，其余连续区间就是地台。
 * 与巨树的 netherite 连通分量同精神（都是读素材自带的展示台布局），但这里的分隔线是**直线**，
 * 所以一维分段就够（实测 x 10 段、z 5 段、每段恒 13 格）。
 */
function slicePads(s) {
  const { W, L } = s;
  const sepX = [], sepZ = [];
  for (let x = 0; x < W; x++) {
    let all = true;
    for (let z = 0; z < L; z++) if (s.at(x, 0, z) !== 'gray_concrete') { all = false; break; }
    sepX[x] = all;
  }
  for (let z = 0; z < L; z++) {
    let all = true;
    for (let x = 0; x < W; x++) if (s.at(x, 0, z) !== 'gray_concrete') { all = false; break; }
    sepZ[z] = all;
  }
  const segments = (flags) => {
    const segs = []; let start = -1;
    for (let i = 0; i < flags.length; i++) {
      if (!flags[i]) { if (start < 0) start = i; }
      else if (start >= 0) { segs.push([start, i - 1]); start = -1; }
    }
    if (start >= 0) segs.push([start, flags.length - 1]);
    return segs;
  };
  const xs = segments(sepX), zs = segments(sepZ);
  const pads = [];
  for (const [minZ, maxZ] of zs) for (const [minX, maxX] of xs) pads.push({ minX, maxX, minZ, maxZ });
  // 规范顺序：先 z 后 x（行优先）→ 行下标 = floor(padIndex / PAD_COLS)
  pads.sort((a, b) => a.minZ - b.minZ || a.minX - b.minX);
  return { pads, cols: xs.length, rows: zs.length };
}

// ---------------------------------------------------------------- 单个变体

function bakeVariant(s, pad, idx) {
  // 1) 收集 pad 内的可映射格（y ≥ 1，剥掉 y=0 地台地板）。
  //
  // ⚠️ **必须按 pad 边界裁剪**：树叶会溢出 13×13 地台边缘（实测 #8/#9 不裁剪时 bbox 会量到
  // 27/41 宽 —— 那是把**相邻地台**的树叶算进来了，不是造型本身）。
  const cells = new Map(); // key `x,y,z`（pad 本地坐标）→ palette 下标
  const seenNames = new Set();
  for (let y = 1; y < s.H; y++) {
    for (let z = pad.minZ; z <= pad.maxZ; z++) {
      for (let x = pad.minX; x <= pad.maxX; x++) {
        const name = s.at(x, y, z);
        if (name === 'air') continue;
        seenNames.add(name);
        if (!(name in SOURCE_MAP)) {
          throw new Error(`[杜鹃树#${idx}] 源方块 "${name}" 不在 SOURCE_MAP 里（须显式映射或显式丢弃 -1）`);
        }
        const pi = SOURCE_MAP[name];
        if (pi < 0) continue;
        cells.set(`${x - pad.minX},${y},${z - pad.minZ}`, pi);
      }
    }
  }
  if (cells.size === 0) throw new Error(`[杜鹃树#${idx}] pad(${pad.minX},${pad.minZ}) 映射后为空`);

  // 2) 求 bbox（本地坐标）并重基准到原点
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -1, mxy = -1, mxz = -1;
  for (const key of cells.keys()) {
    const [x, y, z] = key.split(',').map(Number);
    if (x < mnx) mnx = x; if (x > mxx) mxx = x;
    if (y < mny) mny = y; if (y > mxy) mxy = y;
    if (z < mnz) mnz = z; if (z > mxz) mxz = z;
  }
  const w = mxx - mnx + 1, h = mxy - mny + 1, d = mxz - mnz + 1;

  const blocks = [];
  const baseTrunks = []; // y=0 归一化层里的树干格（锚点候选）
  for (const [key, pi] of cells) {
    const [x0, y0, z0] = key.split(',').map(Number);
    const x = x0 - mnx, y = y0 - mny, z = z0 - mnz;
    blocks.push(x, y, z, pi);
    if (y === 0 && pi === 0) baseTrunks.push([x, z]);
  }

  // 3) 锚点 = y=0 层树干格中离几何中心 (w/2, d/2) 最近者（平分取遍历序最先者）。
  // ⚠️ 不是几何中心：光栅化时锚点对齐候选点，用几何中心会让树干偏出最多 2 格（巨树实测同一结论）。
  if (baseTrunks.length === 0) throw new Error(`[杜鹃树#${idx}] y=0 层没有树干格 → 无法定锚点`);
  let anchor = null, best = Infinity;
  for (const [x, z] of baseTrunks) {
    const dd = (x - w / 2) ** 2 + (z - d / 2) ** 2;
    if (dd < best) { best = dd; anchor = [x, z]; }
  }

  // 按 (y, z, x) 排序，让产物稳定（Map 迭代序依赖插入序，跨 Node 版本不保证；也在 diff 里更可读）
  const ordered = [];
  for (let k = 0; k < blocks.length; k += 4) ordered.push([blocks[k], blocks[k + 1], blocks[k + 2], blocks[k + 3]]);
  ordered.sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[0] - b[0]);

  return { pad: idx, w, d, h, anchor, palette: [...PALETTE], blocks: ordered.flat(), seenNames: [...seenNames] };
}

// ---------------------------------------------------------------- 校验（任一不满足即 throw，不产生半成品）

function validate(variants, leafSlotChecked) {
  if (variants.length !== VARIANT_COUNT) throw new Error(`变体数 ${variants.length} ≠ ${VARIANT_COUNT}`);
  let total = 0;
  variants.forEach((v, i) => {
    const tag = `[杜鹃树#${i}]`;
    const exp = SIZE_EXPECTATIONS[i];
    if (v.w !== exp.w || v.d !== exp.d || v.h !== exp.h) {
      throw new Error(`${tag} 尺寸 ${v.w}×${v.d}×${v.h} ≠ 期望 ${exp.w}×${exp.d}×${exp.h}（切分/映射被改动？）`);
    }
    const n = v.blocks.length / 4;
    if (n !== exp.cells) throw new Error(`${tag} 格数 ${n} ≠ 期望 ${exp.cells}`);
    if (!v.anchor || v.anchor[0] < 0 || v.anchor[0] >= v.w || v.anchor[1] < 0 || v.anchor[1] >= v.d) {
      throw new Error(`${tag} 锚点 ${JSON.stringify(v.anchor)} 越界（w=${v.w} d=${v.d}）`);
    }
    const seen = new Set();
    let mx = [-1, -1, -1];
    for (let k = 0; k < v.blocks.length; k += 4) {
      const [x, y, z, pi] = [v.blocks[k], v.blocks[k + 1], v.blocks[k + 2], v.blocks[k + 3]];
      if (pi < 0 || pi >= v.palette.length) throw new Error(`${tag} palIdx ${pi} 越界`);
      if (x < 0 || x >= v.w || y < 0 || y >= v.h || z < 0 || z >= v.d) throw new Error(`${tag} 坐标越界 ${x},${y},${z}`);
      const key = (y * v.d + z) * v.w + x;
      if (seen.has(key)) throw new Error(`${tag} 坐标重复 ${x},${y},${z}`);
      seen.add(key);
      mx = [Math.max(mx[0], x), Math.max(mx[1], y), Math.max(mx[2], z)];
    }
    if (mx[0] !== v.w - 1 || mx[1] !== v.h - 1 || mx[2] !== v.d - 1) throw new Error(`${tag} w/h/d 与 blocks 极值不一致`);
    total += n;
  });
  if (total < TOTAL_BLOCKS_RANGE[0] || total > TOTAL_BLOCKS_RANGE[1]) {
    throw new Error(`10 个变体共 ${total} 格，不在验收区间 [${TOTAL_BLOCKS_RANGE}]（映射表/切分被改动？）`);
  }
  // 叶子槽必须真的用到了 LEAF 哨兵（否则「三种叶并成一槽」的约定失效，运行时不会掷花）
  if (!leafSlotChecked) throw new Error(`palette[1] 必须是 "${LEAF_SLOT}" 哨兵（运行时按 30% 概率替换花/叶）`);
  return total;
}

function main() {
  const s = loadSchematic();
  const { pads, cols, rows } = slicePads(s);
  if (pads.length !== PAD_COUNT) throw new Error(`地台数 ${pads.length} ≠ ${PAD_COUNT}（灰线网格切分失败）`);
  if (cols !== PAD_COLS || rows !== PAD_ROWS) throw new Error(`地台网格 ${cols}×${rows} ≠ ${PAD_COLS}×${PAD_ROWS}`);
  for (const pad of pads) {
    if (pad.maxX - pad.minX + 1 !== PAD_SIZE || pad.maxZ - pad.minZ + 1 !== PAD_SIZE) {
      throw new Error(`地台尺寸 ${pad.maxX - pad.minX + 1}×${pad.maxZ - pad.minZ + 1} ≠ ${PAD_SIZE}×${PAD_SIZE}`);
    }
  }
  if (PALETTE[1] !== LEAF_SLOT) throw new Error(`palette[1] 必须是 "${LEAF_SLOT}"`);

  // 取材行的 10 个 pad（按 (minZ, minX) 序即 x 升序 = 尺寸由小到大）
  const rowPads = pads.filter((_, i) => Math.floor(i / PAD_COLS) === SOURCE_ROW);
  if (rowPads.length !== VARIANT_COUNT) throw new Error(`取材行 pad 数 ${rowPads.length} ≠ ${VARIANT_COUNT}`);

  const variants = rowPads.map((pad, idx) => bakeVariant(s, pad, idx));
  const total = validate(variants, true);

  const out = { version: 1, scale: 1, leafSlot: LEAF_SLOT, trees: variants.map(({ pad, w, d, h, anchor, palette, blocks }) => ({ pad, w, d, h, anchor, palette, blocks })) };
  const json = JSON.stringify(out);
  fs.mkdirSync(path.dirname(TREES_JSON), { recursive: true });
  fs.writeFileSync(TREES_JSON, json);

  const fp = azaleaTreesInputFingerprint();
  fs.writeFileSync(TREES_META, JSON.stringify({
    scale: 1, variantCount: variants.length, totalBlocks: total, leafSlot: LEAF_SLOT,
    sizes: variants.map((v) => `${v.w}x${v.d}x${v.h}`),
    fingerprints: { input: fp.input, schemSha256: fp.schemSha256, paramsSha256: fp.paramsSha256 },
  }, null, 2) + '\n');

  console.log(`trees.json ${(json.length / 1024).toFixed(1)} KB，${variants.length} 个变体，${total} 格`);
  variants.forEach((v, i) => {
    console.log(`  #${i}  ${String(v.w).padStart(2)}×${String(v.d).padStart(2)}×${String(v.h).padStart(2)}  ${String(v.blocks.length / 4).padStart(4)} 格  锚点 ${JSON.stringify(v.anchor)}`);
  });
}

main();
