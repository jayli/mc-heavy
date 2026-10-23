// tools/bake-giant-trees.mjs — 把 40AssortedTreesPack.schem 烘焙成 1/2 比例的巨树变体 JSON
// 用法：npm run gianttrees → assets/giant-trees/trees.json + trees.meta.json
//
// 流程：gunzip → 最小 NBT 读取（Sponge Schematic v3）→ 剥离展示台 → 40 个地块切分（netherite 圈连通分量）
//   → 取 TREE_FAMILIES 里的 28 个变体 → 2×2×2 降采样 → 按族调色板映射 → 锚点 → 写 JSON。
//
// 降采样规则（**载荷性，勿改成「空气参与的多数投票」**）：
//   每个 2×2×2 立方块内，**空气/展示台/被丢弃的装饰件都不参与投票**；只要有 ≥1 个「可映射方块」，
//   该格就保留，取出现次数最多的调色板下标；同票时下标小者胜（palette[0] = 树干，所以树干不会在
//   降采样里消失）。这条规则对 40 棵全量的产出（~26k 格）与设计文档 §2.3 的 25,640 相符；字面
//   「多数投票」（空气算一票）只会得到 6k~10k 格，树变成稀疏空壳，且全部预算数字都不适用。
//
// 索引序：(y*Length + z)*Width + x（实测唯一能让 y=0 层是完整 400×254 平面的序）。
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import {
  SCHEM_PATH, TREES_JSON, TREES_META, SCALE, PAD_COUNT, TREE_FAMILIES, FAMILY_PALETTES, SOURCE_MAP,
  DISPLAY_BLOCKS, FAMILY_MARKERS, sortPads, giantTreesInputFingerprint,
} from './giant-trees-fingerprint.mjs';

/** 28 个变体降采样后的总格数验收区间（实测 16,954；落区间外 = 规则/映射/排序被改动，须人工复核） */
const TOTAL_BLOCKS_RANGE = [16000, 18000];

// ---------------------------------------------------------------- NBT 读取（只实现 tag 1~12）

class NbtReader {
  constructor(buf) { this.b = buf; this.o = 0; }
  u1() { return this.b[this.o++]; }
  i1() { const v = this.b.readInt8(this.o); this.o += 1; return v; }
  i2() { const v = this.b.readInt16BE(this.o); this.o += 2; return v; }
  i4() { const v = this.b.readInt32BE(this.o); this.o += 4; return v; }
  i8() { const v = this.b.readBigInt64BE(this.o); this.o += 8; return v; }
  f4() { const v = this.b.readFloatBE(this.o); this.o += 4; return v; }
  f8() { const v = this.b.readDoubleBE(this.o); this.o += 8; return v; }
  str() { const n = this.b.readUInt16BE(this.o); this.o += 2; const s = this.b.toString('utf8', this.o, this.o + n); this.o += n; return s; }
  payload(t) {
    switch (t) {
      case 1: return this.i1();
      case 2: return this.i2();
      case 3: return this.i4();
      case 4: return this.i8();
      case 5: return this.f4();
      case 6: return this.f8();
      case 7: { const n = this.i4(); const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
      case 8: return this.str();
      case 9: { const it = this.u1(); const n = this.i4(); const a = []; for (let i = 0; i < n; i++) a.push(this.payload(it)); return a; }
      case 10: { const o = {}; for (;;) { const tt = this.u1(); if (tt === 0) break; const k = this.str(); o[k] = this.payload(tt); } return o; }
      case 11: { const n = this.i4(); const a = new Int32Array(n); for (let i = 0; i < n; i++) a[i] = this.i4(); return a; }
      case 12: { const n = this.i4(); const a = []; for (let i = 0; i < n; i++) a.push(this.i8()); return a; }
      default: throw new Error(`NBT: 未知 tag ${t}`);
    }
  }
}

function loadSchematic() {
  const root = (() => { const r = new NbtReader(zlib.gunzipSync(fs.readFileSync(SCHEM_PATH))); const t = r.u1(); r.str(); return r.payload(t); })();
  const S = root.Schematic || root;
  const { Width: W, Height: H, Length: L } = S;
  const pal = []; for (const [name, id] of Object.entries(S.Blocks.Palette)) pal[id] = name.replace('minecraft:', '').split('[')[0];
  // Data = varint 数组
  const data = S.Blocks.Data; const blocks = new Uint16Array(W * H * L); let p = 0, n = 0;
  while (p < data.length) { let v = 0, sh = 0, b; do { b = data[p++]; v |= (b & 0x7f) << sh; sh += 7; } while (b & 0x80); blocks[n++] = v; }
  if (n !== W * H * L) throw new Error(`Data 长度 ${n} ≠ ${W}×${H}×${L}`);
  return { W, H, L, pal, blocks, at: (x, y, z) => pal[blocks[(y * L + z) * W + x]] };
}

// ---------------------------------------------------------------- 地块切分

/** netherite_block 在 y=1 层的 4 连通分量 → 每个分量一个地块 bbox；返回 (minZ,minX) 升序 */
function slicePads(s) {
  const { W, L } = s; const seen = new Uint8Array(W * L); const pads = [];
  for (let z = 0; z < L; z++) for (let x = 0; x < W; x++) {
    if (seen[z * W + x] || s.at(x, 1, z) !== 'netherite_block') continue;
    const st = [[x, z]]; seen[z * W + x] = 1; let minX = x, maxX = x, minZ = z, maxZ = z;
    while (st.length) {
      const [cx, cz] = st.pop(); minX = Math.min(minX, cx); maxX = Math.max(maxX, cx); minZ = Math.min(minZ, cz); maxZ = Math.max(maxZ, cz);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= W || nz >= L || seen[nz * W + nx] || s.at(nx, 1, nz) !== 'netherite_block') continue;
        seen[nz * W + nx] = 1; st.push([nx, nz]);
      }
    }
    pads.push({ minX, maxX, minZ, maxZ });
  }
  if (pads.length !== PAD_COUNT) throw new Error(`地块数 ${pads.length} ≠ ${PAD_COUNT}（展示台切分失败）`);
  return sortPads(pads);
}

// ---------------------------------------------------------------- 单个变体：降采样 + 映射

function bakeVariant(s, pad, family, padIndex) {
  const map = SOURCE_MAP[family]; const palette = FAMILY_PALETTES[family]; const P = palette.length;
  const width = pad.maxX - pad.minX + 1, depth = pad.maxZ - pad.minZ + 1, height = s.H - 2; // y 从 2 起（y=0 地板、y=1 展示台圈）
  const nx = Math.ceil(width / SCALE), nz = Math.ceil(depth / SCALE), ny = Math.ceil(height / SCALE);
  const votes = new Uint16Array(nx * ny * nz * P);
  const seenNames = new Set();
  for (let y = 2; y < s.H; y++) for (let z = pad.minZ; z <= pad.maxZ; z++) for (let x = pad.minX; x <= pad.maxX; x++) {
    const name = s.at(x, y, z);
    if (DISPLAY_BLOCKS.has(name)) continue;
    seenNames.add(name);
    if (!(name in map)) throw new Error(`[${family}#${padIndex}] 源方块 "${name}" 不在 SOURCE_MAP 里（须显式映射或显式丢弃 -1）`);
    const pi = map[name]; if (pi < 0) continue;
    const gx = Math.floor((x - pad.minX) / SCALE), gy = Math.floor((y - 2) / SCALE), gz = Math.floor((z - pad.minZ) / SCALE);
    votes[((gy * nz + gz) * nx + gx) * P + pi]++;
  }
  // 逐格取最大票（空气不参与；同票下标小者胜）
  const cells = []; let mnx = 1e9, mny = 1e9, mnz = 1e9, mxx = -1, mxy = -1, mxz = -1;
  for (let gy = 0; gy < ny; gy++) for (let gz = 0; gz < nz; gz++) for (let gx = 0; gx < nx; gx++) {
    const base = ((gy * nz + gz) * nx + gx) * P; let best = -1, bestN = 0;
    for (let pi = 0; pi < P; pi++) if (votes[base + pi] > bestN) { bestN = votes[base + pi]; best = pi; }
    if (best < 0) continue;
    cells.push([gx, gy, gz, best]);
    mnx = Math.min(mnx, gx); mny = Math.min(mny, gy); mnz = Math.min(mnz, gz); mxx = Math.max(mxx, gx); mxy = Math.max(mxy, gy); mxz = Math.max(mxz, gz);
  }
  if (cells.length === 0) throw new Error(`[${family}#${padIndex}] 降采样后为空`);
  const w = mxx - mnx + 1, h = mxy - mny + 1, d = mxz - mnz + 1;
  const blocks = []; const layer0 = [];
  for (const [gx, gy, gz, pi] of cells) {
    const x = gx - mnx, y = gy - mny, z = gz - mnz; blocks.push(x, y, z, pi);
    if (y === 0 && pi === 0) layer0.push([x, z]);
  }
  // 锚点 = gy=0 层树干格中离几何中心 (w/2, d/2) 最近者（平分取遍历序最先者）。
  // ⚠️ 不是几何中心（实测最大偏移 ±2 格）：光栅化时锚点对齐候选点，用几何中心会让树干偏出最多 2 格。
  if (layer0.length === 0) throw new Error(`[${family}#${padIndex}] gy=0 层没有树干格 → 无法定锚点`);
  let anchor = null, bd = Infinity;
  for (const [x, z] of layer0) { const dd = (x - w / 2) ** 2 + (z - d / 2) ** 2; if (dd < bd) { bd = dd; anchor = [x, z]; } }
  return { pad: padIndex, w, d, h, anchor, palette: [...palette], blocks, seenNames };
}

// ---------------------------------------------------------------- 校验（任一不满足即 throw，不产生半成品）

function validate(variants) {
  let total = 0;
  for (const [family, list] of Object.entries(variants)) {
    if (list.length !== TREE_FAMILIES[family].length) throw new Error(`${family} 变体数 ${list.length} ≠ ${TREE_FAMILIES[family].length}`);
    const mk = FAMILY_MARKERS[family];
    list.forEach((v, i) => {
      const tag = `${family}[${i}](pad ${v.pad})`;
      if (!v.anchor || v.anchor[0] < 0 || v.anchor[0] >= v.w || v.anchor[1] < 0 || v.anchor[1] >= v.d) throw new Error(`${tag} 锚点越界`);
      const seen = new Set(); let mx = [-1, -1, -1];
      for (let k = 0; k < v.blocks.length; k += 4) {
        const [x, y, z, pi] = [v.blocks[k], v.blocks[k + 1], v.blocks[k + 2], v.blocks[k + 3]];
        if (pi < 0 || pi >= v.palette.length) throw new Error(`${tag} palIdx ${pi} 越界`);
        if (x < 0 || x >= v.w || y < 0 || y >= v.h || z < 0 || z >= v.d) throw new Error(`${tag} 坐标越界 ${x},${y},${z}`);
        const key = (y * v.d + z) * v.w + x; if (seen.has(key)) throw new Error(`${tag} 坐标重复 ${x},${y},${z}`); seen.add(key);
        mx = [Math.max(mx[0], x), Math.max(mx[1], y), Math.max(mx[2], z)];
      }
      if (mx[0] !== v.w - 1 || mx[1] !== v.h - 1 || mx[2] !== v.d - 1) throw new Error(`${tag} w/h/d 与 blocks 极值不一致`);
      // 族归属反向校验：源方块名集合须符合该族的标志
      for (const n of mk.has) if (!v.seenNames.has(n)) throw new Error(`${tag} 缺少族标志源方块 "${n}"（pad 排序约定被破坏？）`);
      for (const grp of mk.hasAnyOf || []) if (!grp.some((n) => v.seenNames.has(n))) throw new Error(`${tag} 缺少族标志源方块之一 [${grp}]`);
      for (const n of mk.lacks) if (v.seenNames.has(n)) throw new Error(`${tag} 含有不属于该族的源方块 "${n}"（pad 排序约定被破坏？）`);
      total += v.blocks.length / 4;
    });
  }
  if (total < TOTAL_BLOCKS_RANGE[0] || total > TOTAL_BLOCKS_RANGE[1]) {
    throw new Error(`28 个变体共 ${total} 格，不在验收区间 [${TOTAL_BLOCKS_RANGE}]（降采样规则/映射表/排序被改动？）`);
  }
  return total;
}

function main() {
  const s = loadSchematic();
  const pads = slicePads(s);
  const variants = {};
  for (const [family, padIdxs] of Object.entries(TREE_FAMILIES)) {
    variants[family] = padIdxs.map((pi) => bakeVariant(s, pads[pi], family, pi));
  }
  const total = validate(variants);
  const out = { version: 1, scale: SCALE, trees: {} };
  for (const [family, list] of Object.entries(variants)) {
    out.trees[family] = list.map(({ pad, w, d, h, anchor, palette, blocks }) => ({ pad, w, d, h, anchor, palette, blocks }));
  }
  const json = JSON.stringify(out);
  fs.mkdirSync(path.dirname(TREES_JSON), { recursive: true });
  fs.writeFileSync(TREES_JSON, json);
  const fp = giantTreesInputFingerprint();
  const familyCounts = Object.fromEntries(Object.entries(variants).map(([f, l]) => [f, l.length]));
  fs.writeFileSync(TREES_META, JSON.stringify({
    scale: SCALE, variantCount: Object.values(familyCounts).reduce((a, b) => a + b, 0), families: familyCounts,
    totalBlocks: total, fingerprints: { input: fp.input, schemSha256: fp.schemSha256, paramsSha256: fp.paramsSha256 },
  }, null, 2) + '\n');

  console.log(`trees.json ${(json.length / 1024).toFixed(1)} KB，${Object.keys(variants).length} 族共 ${Object.values(familyCounts).reduce((a, b) => a + b, 0)} 个变体，${total} 格`);
  for (const [f, l] of Object.entries(variants)) {
    const ws = l.map((v) => `${v.w}×${v.d}×${v.h}`).join(' ');
    console.log(`  ${f.padEnd(12)} ${l.length} 个  尺寸 ${ws}  格数 ${l.map((v) => v.blocks.length / 4).join('/')}`);
  }
}

main();
