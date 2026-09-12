// tools/icon-fingerprint.mjs — 背包图标的输入指纹（§4.5.4 v1.26）
//
// **两个消费者共用同一份逻辑**（红线 1：指纹算法只有一份权威）：
//   - `tools/bake-icon-atlas.mjs` 烘焙时计算并写进 `assets/icons.json`
//   - `tools/check-data.mjs` 用当前源码重算并比对 → 不匹配即报「跑 npm run icons」
//
// 图标是**派生产物**，权威输入是 mesher 的几何 + faces-data 的贴图。改了其中一处却忘跑
// `npm run icons`，图标会**静默过期**（渲染旧形状/旧配色，肉眼看不出）—— 这正是
// v1.24 记录过的失效路径（改了 mesher 几何忘跑 atlas）。范围从 9 项扩到物品集合全量后更容易踩。
//
// node 侧模块（要读 PNG 文件），不进 src/，浏览器不消费。

import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMPLATES } from '../src/mesh/mesher.js';
import { cubeQuads } from '../src/mesh/iso-icon.js';
import { getFaceTile } from '../src/voxel/faces-data.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEX_DIR = path.join(__dirname, '..', 'assets', 'textures');

/** 贴图缓存（一张贴图被多个方块/多个面共用） */
const cache = new Map();

export function loadTex(tileName) {
  if (cache.has(tileName)) return cache.get(tileName);
  const file = path.join(TEX_DIR, `${tileName}.png`);
  if (!fs.existsSync(file)) throw new Error(`贴图文件不存在：${file}（tile ${tileName}）`);
  const png = PNG.sync.read(fs.readFileSync(file));
  cache.set(tileName, png);
  return png;
}

/**
 * 贴图内容哈希（FNV-1a 32bit，纯整数无依赖）。
 *
 * **必须进指纹**：只钉贴图名的话，「改了 PNG 内容但没动 faces-data 的映射」会漏掉 ——
 * 而这正是最常见的过期路径（换一张同名贴图）。实测确认过这个盲区。
 */
export function texHash(tileName) {
  const png = loadTex(tileName);
  let h = 0x811c9dc5;
  for (let i = 0; i < png.data.length; i++) {
    h ^= png.data[i];
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return (h >>> 0).toString(36);
}

/** 等轴测图标的三个可见面（与 iso-icon.js 的 VISIBLE_FACES 同口径） */
const VISIBLE_FACES = [0, 2, 4];

/**
 * **非实心方块保持平面贴图**（§4.5.4 v1.26，用户指定口径）：等轴测立方体对植被/水/云
 * 不合适 —— 植被贴图有透明像素（实测 `flower` 86% / `vine` 76%）、水/云无几何语义。
 *
 * 放在共享模块而非烘焙脚本内：`check-data.mjs` 重算指纹时必须用**同一份**清单
 * （红线 1），否则「改了一处忘了另一处」会让指纹比对得出错误结论。
 *
 * `mine_cart` 走平面路径采 mc-lite 手工图标 `Invicon_Minecart`（是**实体**不是方块，
 * mesher 无其几何模板 → 等轴测不适用）。
 *
 * **清单里有一项 `solid: true` 的例外**（`zombie_nest_alias_block`），别按「非实心」口径
 * 「修正」它 —— 它走平面的理由是另一类：**多方块结构的占位物品**。该物品在背包里代表
 * 一整个 38 方块的巢穴结构（放置走 `player.js` 的物品名路由，不会真的放进世界一格），
 * 立方体是错的表达。mc-lite 同口径：`ItemIconUtils.getCustomIconPath()` 把
 * `zombie_nest_alias_block` / `turret_alias_block` / `bed_alias_block` / `mine_cart`
 * 一起映射到手工图，**绕过** `HUD.generateIcon()` 的立方体生成。
 */
export const FLAT_BLOCKS = [
  'water', 'swamp_water', 'cloud', 'flower', 'short_grass', 'allium', 'azure_bluet',
  'dead_bush', 'oxeye_daisy', 'red_mushroom', 'vine', 'lilypad', 'mine_cart', 'hanging_lamp',
  'zombie_nest_alias_block', 'turret_alias_block',
];

/** 平面路径方块名 → 手工图标 tile（其余走 faces-data 的 face 0） */
export const FLAT_ICON_TILE = { mine_cart: 'Invicon_Minecart' };

/**
 * 算某方块的指纹（自动判定平面/等轴测路径）。两个消费者共用的入口。
 * @param {string} name 方块名
 * @param {{geometry?: string}} def BLOCKS 条目
 * @returns {string} 指纹串
 */
export function iconFingerprintFor(name, def) {
  return fingerprint(name, def, FLAT_BLOCKS.includes(name));
}

/**
 * 平面路径实际采样哪张贴图。**必须与烘焙脚本 `bakeFlatIcon()` 的取图口径完全一致** ——
 * 否则指纹会算错输入：
 *   - 假阳：改一张指纹算了、但烘焙没用的贴图（实测踩过：改 `stone.png` 误报 mine_cart 过期，
 *     因为 faces-data 里 `mine_cart` 的 face0 是 `stone`）
 *   - 假阴：改一张烘焙实际用了、但指纹没算的贴图（更危险 —— `Invicon_Minecart.png`
 *     变了图标会静默过期而门禁放行）
 */
function flatTile(name) {
  return FLAT_ICON_TILE[name] ?? getFaceTile(name, 0);
}

/**
 * 计算某方块的输入指纹。
 *
 * 指纹 = 该方块的**全部实际输入**（与烘焙脚本读的东西一一对应）：
 *   - 等轴测路径：几何模板（名称 + quad 数 + **顶点序列**）+ 三个可见面的贴图名与**内容哈希**
 *   - 平面路径：`flatTile(name)` 的贴图名与**内容哈希**（平面只采一张，无逐面语义）
 *
 * 为什么用指纹而非颜色比对：指纹是**精确**判定（任一输入变了必不匹配），不依赖阈值调参；
 * 颜色启发式会有假阴（改了一张贴图但主色恰好相近）与假阳（同贴图不同采样点）。
 *
 * @param {string} name 方块名
 * @param {{geometry?: string}} def BLOCKS 条目（取 geometry 字段）
 * @param {boolean} flat 是否走平面路径（非实心方块保持平面贴图）
 * @returns {string} 指纹串
 */
export function fingerprint(name, def, flat) {
  const parts = [];
  if (flat) {
    // 平面路径：只采 flatTile(name) 这一张（与 bakeFlatIcon 同口径）
    const tile = flatTile(name) ?? '';
    parts.push(`flat;t:${tile}${tile ? `#${texHash(tile)}` : ''}`);
    return parts.join(';');
  }
  const quads = (def?.geometry && TEMPLATES[def.geometry]) || cubeQuads();
  parts.push(`geom:${def?.geometry ?? 'cube'}`);
  parts.push(`quads:${quads.length}`);
  // 顶点序列进指纹：几何改了（哪怕 quad 数不变）也能抓到
  for (const q of quads) parts.push(`f${q.face}:` + q.v.map((p) => p.join(',')).join('|'));
  // 三个可见面的贴图名 + 内容哈希（逐面采样 → 任一面改贴图都会让图标过期）
  for (const face of VISIBLE_FACES) {
    const tile = getFaceTile(name, face) ?? '';
    parts.push(`t${face}:${tile}${tile ? `#${texHash(tile)}` : ''}`);
  }
  return parts.join(';');
}
