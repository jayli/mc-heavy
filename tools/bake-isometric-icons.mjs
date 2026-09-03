// tools/bake-isometric-icons.mjs — 离线烘焙异形方块的等轴测背包图标（§4.5.4 v1.24）
//
// **形状的唯一权威 = `src/mesh/mesher.js` 的 `TEMPLATES`**（红线 1：数据只有一份权威）。
// 本脚本 import 该模板做投影，**禁止手写第二份几何定义** —— 几何改了重跑本脚本即自动跟上。
//
// 产物：`assets/textures/inventory-icons/<方块名>.png`（64×64，透明背景），随后
// `npm run atlas` 入图。用法：`npm run icons`（= node tools/bake-isometric-icons.mjs）。
//
// 为什么离线烘焙而非运行时合成（§4.5.4 v1.24）：运行时零开销（复用既有 CSS background
// 裁剪路径）、与其余 109 项图标同一条渲染路径、确定性（固定算法无随机）、符合红线 3
// （重计算离开运行时）。代价：几何变更需重跑本脚本 + `npm run atlas`。
//
// **按方块名组织**（几何查 `BLOCKS[].geometry`、贴图查 `faces-data`，二者不必同名）：
// `stone_diorite_step` 的 geometry 是 `cobblestone_step`（mc-lite `BlockData.js:283`
// `geometryType: 'cobblestone_step'` 同口径）但贴图是 `stone_diorite` → 图标形状与
// `cobblestone_step` 相同、配色不同。若按 geometry 名组织会让它采到鹅卵石贴图。
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMPLATES } from '../src/mesh/mesher.js';
import { renderIsoIcon } from '../src/mesh/iso-icon.js';
import { BLOCKS } from '../src/voxel/blocks-data.js';
import { getFaceTile } from '../src/voxel/faces-data.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const TEX_DIR = path.join(ROOT, 'assets', 'textures');
const OUT_DIR = path.join(TEX_DIR, 'inventory-icons');

// 图标边长：64（与 mc-lite 程序化贴图烘焙同尺寸，nearest 放大到槽位 32/40px 后仍清晰）
const SIZE = 64;

/**
 * 覆盖范围 = 9 项异形方块（§4.5.4 v1.24）：栏杆×3 + 柱子×2 + 台阶×4。
 *
 * **不含**：
 * - `cactus`/`vine`/`lilypad`/`hanging_lamp`/`flower` 系 7 个方块 —— 保持平面贴图现状
 *   （不在本次范围，用户明确指定）；
 * - `chimney`/`bed_head`/`bed_tail`/`bed_alias_block` —— 不在背包 118 项内
 *   （`player/inventory.js` 的 `HIDDEN_FROM_INVENTORY`）；
 * - `mine_cart` —— 是**实体**不是方块，mesher 无其几何模板，等轴测方案不适用
 *   （保持 mc-lite 手工图标 `Invicon_Minecart`）。
 */
const TARGET_BLOCKS = [
  'handrail', 'handrailA', 'handrailB',
  'vertical_pillar', 'horizontal_pillar',
  'planks_step', 'cobblestone_step', 'cobblestone_step_updown', 'stone_diorite_step',
];

/** 方块名 → BLOCKS 条目（geometry 字段 = TEMPLATES 键名） */
function blockDef(name) {
  const def = BLOCKS.find((b) => b.name === name);
  if (!def) throw new Error(`方块 "${name}" 不在 BLOCKS 中`);
  return def;
}

/**
 * 读贴图 PNG 并按 tile 局部 UV nearest 采样 → [r,g,b]。
 *
 * v 轴翻转口径：`build-atlas.mjs:103` 用 `v0 = 1-(shelfY+h)/SIZE`（PNG 行序 → v 翻转），
 * 故 tile 局部 v=0 对应 PNG **最后一行**（图片底部）、v=1 对应第一行。`FACE_UVS` 的
 * v=y（±X/±Z 面）→ y=0 是方块底部 → 采样图片底部，贴图不上下颠倒。
 */
function makeSampler(png) {
  return (u, v) => {
    const x = Math.max(0, Math.min(png.width - 1, Math.floor(u * png.width)));
    const y = Math.max(0, Math.min(png.height - 1, Math.floor((1 - v) * png.height)));
    const i = (y * png.width + x) << 2;
    return [png.data[i], png.data[i + 1], png.data[i + 2]];
  };
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const results = [];
for (const name of TARGET_BLOCKS) {
  const def = blockDef(name);
  const quads = TEMPLATES[def.geometry];
  if (!quads) throw new Error(`TEMPLATES 无 "${def.geometry}"（方块 ${name}）`);
  // 贴图 = faces-data 的该方块条目（与游戏内世界渲染同源 → 配色一致，不会出现
  // mc-lite 手工图标那种「背包金黄色栏杆、游戏内木色栏杆」的割裂）
  const tileName = getFaceTile(name, 0);
  const texFile = path.join(TEX_DIR, `${tileName}.png`);
  if (!fs.existsSync(texFile)) throw new Error(`贴图文件不存在：${texFile}（方块 ${name}）`);
  const tex = PNG.sync.read(fs.readFileSync(texFile));

  const rgba = renderIsoIcon(quads, SIZE, makeSampler(tex));
  const out = new PNG({ width: SIZE, height: SIZE });
  for (let i = 0; i < rgba.length; i++) out.data[i] = rgba[i];

  const outFile = path.join(OUT_DIR, `${name}.png`);
  fs.writeFileSync(outFile, PNG.sync.write(out));

  let opaque = 0;
  const colors = new Set();
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] > 0) {
      opaque++;
      colors.add(`${rgba[i]},${rgba[i + 1]},${rgba[i + 2]}`);
    }
  }
  results.push({ name, geometry: def.geometry, tile: tileName, opaque, colors: colors.size });
}

console.log(`等轴测图标：${results.length} 个方块 → ${path.relative(ROOT, OUT_DIR)}/ (${SIZE}x${SIZE})`);
for (const r of results) {
  const pct = ((r.opaque / (SIZE * SIZE)) * 100).toFixed(1);
  console.log(`  ${r.name.padEnd(24)} geometry=${r.geometry.padEnd(24)} tile=${r.tile.padEnd(26)} 不透明=${r.opaque}px (${pct}%) 色数=${r.colors}`);
}
