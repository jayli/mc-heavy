// tools/bake-icon-atlas.mjs — 离线烘焙全量背包图标（§4.5.4 v1.26）
//
// 产物：`assets/icons-atlas.png` + `assets/icons.json`（预生成完整 CSS background 串）。
// 用法：`npm run icons`。
//
// **为什么离线烘焙 + 预生成 CSS 串**（v1.26，取代 v1.24 的「入世界 atlas + 运行时裁剪」）：
// 运行时图标逻辑从「两级查表 + 裁剪数学 + 写 4 个样式属性」收敛为 1 行
// `icon.style.background = ICON_CSS[name]`（实测 computed style 与旧路径逐项相等）。
// 实测可消除约 91 行运行时代码 + 13 个钉 tile 名/裁剪参数的「改动放大器」用例。
//
// **独立 atlas 而非入世界 atlas**：消除 v1.24 记录的副作用（新增 textures 子目录会按字母序
// 重排已有 tile 坐标 —— `build-atlas.mjs` 的 shelf 装箱），且 UI 不必加载 2048² 世界 atlas
// 只为裁一个 40px 图标。容量实测：1024² 对 236 张（118 项 × 两套尺寸）占用 ~29%。
//
// **形状与 UV 的唯一权威 = `src/mesh/mesher.js`**（红线 1）：
//   - 异形方块 → `TEMPLATES[geometry]`
//   - 实心方块 → `cubeQuads()`（由 mesher 的 `FACE_VERTICES`/`FACE_UVS` 派生）
// 禁止手写第二份几何/UV 定义 —— 几何改了重跑本脚本即自动跟上。
//
// **逐面采样贴图**：实测背包实心 104 项里 17 项是多面不同贴图（`grass` 顶绿侧土、
// `chest`/`tnt` 顶侧不同）。旧脚本只采 `getFaceTile(name, 0)` → 三个面全采同一张，
// 顶面配色错误。本脚本按 `face` 取对应贴图。
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMPLATES } from '../src/mesh/mesher.js';
import { renderIsoIcon, cubeQuads } from '../src/mesh/iso-icon.js';
import { BLOCKS } from '../src/voxel/blocks-data.js';
import { getFaceTile } from '../src/voxel/faces-data.js';
import { buildItemNames } from '../src/player/inventory.js';
import { buildDefaultRegistry } from '../src/voxel/block-registry.js';
// 指纹与贴图加载走共享模块（红线 1：指纹算法只有一份权威，check:data 用同一份重算比对）
import { fingerprint, loadTex, FLAT_BLOCKS, FLAT_ICON_TILE } from './icon-fingerprint.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const TEX_DIR = path.join(ROOT, 'assets', 'textures');
const OUT_PNG = path.join(ROOT, 'assets', 'icons-atlas.png');
const OUT_JSON = path.join(ROOT, 'assets', 'icons.json');

/**
 * **按显示尺寸烘焙**（用户指定口径）：运行时零缩放 → 不需要 `background-size` 放大，
 * 图标就是显示尺寸，像素风锐利。两套尺寸对应两个消费方：
 *   40 = 快捷栏（`hotbar.js` 的 icon 40×40）
 *   32 = 背包面板（`inventory.js` 的 `ICON_SIZE`）
 */
const SIZES = { hotbar: 40, inventory: 32 };

/** atlas 边长与装箱间距 */
const ATLAS_SIZE = 1024;
const PAD = 1; // 图标间留 1px 防 CSS 裁剪边缘渗色

// ---------------------------------------------------------------- 贴图采样

/**
 * nearest 采样（含 alpha）。
 *
 * v 轴翻转口径：`build-atlas.mjs` 用 `v0 = 1-(shelfY+h)/SIZE`（PNG 行序 → v 翻转），
 * 故 tile 局部 v=0 对应 PNG **最后一行**、v=1 对应第一行。`FACE_UVS` 的 v=y
 * （±X/±Z 面）→ y=0 是方块底部 → 采样图片底部，贴图不上下颠倒。
 *
 * 返回 [r,g,b,a] —— 平面路径需要 alpha（植被贴图透明像素），等轴测只用 rgb。
 */
function sampleTexAt(png, u, v) {
  const x = Math.max(0, Math.min(png.width - 1, Math.floor(u * png.width)));
  const y = Math.max(0, Math.min(png.height - 1, Math.floor((1 - v) * png.height)));
  const i = (y * png.width + x) << 2;
  return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
}

/**
 * 逐面采样回调（v1.26 关键修正）：按 `face` 取对应贴图。
 * `grass` 顶面采 `grass_carried`（绿）、侧面采 `grass_side_carried`（土）——
 * 只采 face 0 会让顶面渲成土色（实测配色错误）。
 * null 面（该面不渲染）回落 face 0 的贴图：等轴测图标不存在「不渲染面」语义。
 */
function makeFaceSampler(name) {
  const byFace = new Map();
  return (u, v, face) => {
    if (!byFace.has(face)) {
      const tile = getFaceTile(name, face) ?? getFaceTile(name, 0);
      byFace.set(face, tile ? loadTex(tile) : null);
    }
    const png = byFace.get(face);
    if (!png) return [0, 0, 0]; // 该方块无 faces-data 条目（正常不触发，check:data 会抓）
    return sampleTexAt(png, u, v);
  };
}

// ---------------------------------------------------------------- 渲染单个图标

/** 等轴测图标（实心方块 + 有几何模板的异形方块） */
function bakeIsoIcon(name, def, size) {
  const quads = (def.geometry && TEMPLATES[def.geometry]) || cubeQuads();
  const rgba = renderIsoIcon(quads, size, makeFaceSampler(name));
  return rgba; // alpha 已由 renderIsoIcon 处理（形状外 = 0，形状内 = 255）
}

/**
 * 平面图标（非实心 14 项）：源贴图 nearest 放大到显示尺寸，**保留 alpha**。
 * 源尺寸混杂（16/32/64），nearest 放大保像素风锐利。
 */
function bakeFlatIcon(name, size) {
  const tile = FLAT_ICON_TILE[name] ?? getFaceTile(name, 0);
  if (!tile) throw new Error(`平面图标方块 "${name}" 无 tile（faces-data 与图标表都没有）`);
  const src = loadTex(tile);
  const out = new Uint8ClampedArray(size * size * 4); // 默认全 0 = 全透明
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = sampleTexAt(src, (x + 0.5) / size, 1 - (y + 0.5) / size);
      const o = (y * size + x) << 2;
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
    }
  }
  return out;
}

// ---------------------------------------------------------------- atlas 装箱（shelf）

/** shelf 装箱：按高度分 shelf，同一 shelf 内横向排列（与 build-atlas.mjs 同思路，简化版） */
function packShelf(entries) {
  let x = 0, y = 0, shelfH = 0;
  for (const e of entries) {
    const w = e.size + PAD, h = e.size + PAD;
    if (x + w > ATLAS_SIZE) { x = 0; y += shelfH; shelfH = 0; } // 换 shelf
    if (y + h > ATLAS_SIZE) throw new Error(`atlas ${ATLAS_SIZE}² 装不下（已到 y=${y}）——需扩大或减小图标尺寸`);
    e.x = x; e.y = y;
    x += w;
    shelfH = Math.max(shelfH, h);
  }
  return entries;
}

// ---------------------------------------------------------------- 主流程

const registry = await buildDefaultRegistry();
const items = buildItemNames(registry);
const byName = new Map(BLOCKS.map((b) => [b.name, b]));

/** 背包集合的每一项都必须能生成图标（check:data 的 [4] 钉同一不变式） */
const missingDef = items.filter((n) => !byName.has(n));
if (missingDef.length) throw new Error(`背包项不在 BLOCKS 中：${missingDef.join(', ')}`);

// 收集全部待烘条目（118 项 × 两套尺寸 = 236 张）
const entries = [];
for (const sizeKey of Object.keys(SIZES)) {
  const size = SIZES[sizeKey];
  for (const name of items) {
    const def = byName.get(name);
    const flat = FLAT_BLOCKS.includes(name);
    entries.push({ name, sizeKey, size, flat, def });
  }
}
packShelf(entries);

// 渲染并写入 atlas
const atlas = new PNG({ width: ATLAS_SIZE, height: ATLAS_SIZE });
// 全透明底（alpha=0）：CSS 裁剪出的图标背景透明
for (let i = 3; i < atlas.data.length; i += 4) atlas.data[i] = 0;

const manifest = {}; // sizeKey → { name → CSS background 串 }
for (const sizeKey of Object.keys(SIZES)) manifest[sizeKey] = {};

const stats = [];
const fingerprints = {}; // 方块名 → 输入指纹（check:data 的图标过期检查用）
for (const e of entries) {
  const rgba = e.flat ? bakeFlatIcon(e.name, e.size) : bakeIsoIcon(e.name, e.def, e.size);
  // blit 到 atlas（保留 alpha）
  for (let y = 0; y < e.size; y++) {
    for (let x = 0; x < e.size; x++) {
      const srcO = (y * e.size + x) << 2;
      const dstO = ((e.y + y) * ATLAS_SIZE + (e.x + x)) << 2;
      atlas.data[dstO] = rgba[srcO];
      atlas.data[dstO + 1] = rgba[srcO + 1];
      atlas.data[dstO + 2] = rgba[srcO + 2];
      atlas.data[dstO + 3] = rgba[srcO + 3];
    }
  }
  // 预生成 CSS background 串：图标就是显示尺寸 → 无缩放，position 定位到 atlas 内矩形
  manifest[e.sizeKey][e.name] =
    `url('icons-atlas.png') ${-e.x}px ${-e.y}px / ${ATLAS_SIZE}px ${ATLAS_SIZE}px no-repeat`;

  // 指纹只记一次（两套尺寸的输入相同）
  if (e.sizeKey === 'hotbar') fingerprints[e.name] = fingerprint(e.name, e.def, e.flat);

  if (e.sizeKey === 'hotbar') { // 统计只记一次（两套尺寸形状相同）
    let opaque = 0; const colors = new Set();
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i + 3] > 0) { opaque++; colors.add(`${rgba[i]},${rgba[i + 1]},${rgba[i + 2]}`); }
    }
    stats.push({ name: e.name, flat: e.flat, opaque, colors: colors.size, size: e.size });
  }
}

fs.writeFileSync(OUT_PNG, PNG.sync.write(atlas));
fs.writeFileSync(OUT_JSON, JSON.stringify({
  size: ATLAS_SIZE,
  // 两套显示尺寸（40 快捷栏 / 32 背包）；运行时只需 `ICON_CSS[name]` 一行
  hotbar: manifest.hotbar,
  inventory: manifest.inventory,
  // 输入指纹（运行时不消费，仅 `npm run check:data` 的图标过期检查用）：
  // 改了几何/贴图却忘跑本脚本 → 指纹不匹配 → 当场报「跑 npm run icons」
  fingerprints,
}, null, 0));

// ---------------------------------------------------------------- 报告

const iso = stats.filter((s) => !s.flat).length;
const flat = stats.filter((s) => s.flat).length;
console.log(`背包图标烘焙：${stats.length} 项（等轴测 ${iso} + 平面 ${flat}）× 两套尺寸 ${Object.values(SIZES).join('/')}px`);
console.log(`  → ${path.relative(ROOT, OUT_PNG)} (${ATLAS_SIZE}²) + ${path.relative(ROOT, OUT_JSON)}`);
const usedPx = entries.reduce((s, e) => s + e.size * e.size, 0);
console.log(`  atlas 占用 ${(usedPx / (ATLAS_SIZE * ATLAS_SIZE) * 100).toFixed(1)}%，PNG ${(fs.statSync(OUT_PNG).size / 1024).toFixed(0)}KB`);

// 抽查多面贴图方块的配色（逐面采样生效的证据）
console.log('\n多面贴图方块抽查（逐面采样 → 色数应显著多于单面）：');
for (const n of ['grass', 'stone', 'dirt', 'chest', 'tnt']) {
  const s = stats.find((x) => x.name === n);
  if (s) console.log(`  ${n.padEnd(8)} 不透明=${String(s.opaque).padEnd(5)}px 色数=${s.colors}`);
}
console.log('\n平面贴图方块抽查（保留 alpha → 透明背景）：');
for (const n of ['flower', 'vine', 'mine_cart', 'water']) {
  const s = stats.find((x) => x.name === n);
  if (s) {
    const pct = (s.opaque / (s.size * s.size) * 100).toFixed(0);
    console.log(`  ${n.padEnd(12)} 不透明=${pct}% 色数=${s.colors}`);
  }
}
