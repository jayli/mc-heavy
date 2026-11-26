// tools/player-skin-fingerprint.mjs — 第一人称手臂皮肤的版式参数与输入指纹（v3.46）
//
// **两个消费者共用同一份逻辑**（红线 1）：
//   - `tools/bake-player-skin.mjs` 按本参数绘制，并把指纹写进 `assets/player/skin.json`
//   - `tools/check-data.mjs` 用当前参数重算并比对 → 不匹配即报「跑 npm run playerskin」
//
// ⚠️ **UV 矩形不在这里再写一份** —— 从 `src/render/view-arm-data.js` re-export
//（three-free 的数据层，渲染器运行时读的就是那份）。手法同
// `tools/zombie-skin-fingerprint.mjs` re-export `zombie-model.js`。
// ⚠️ **不能从 `view-arm.js` 拿**：那个文件 import three，Node 侧烘焙脚本没有
// three 解析映射（实测 `ERR_MODULE_NOT_FOUND`）。
//
// ## 上游出处与本仓裁定
//
// 配色三档取自 OpusCraft `src/textures/skin.ts` 的 `steveSkin()`：
//   skin  = [0xa87d63, 0xb68a6f, 0xc49a7e]   （暗/中/亮）
//   shirt = [0x008080, 0x00a0a0, 0x00b2b2]   （**保留作出处留档，本仓已不用**）
//   逐像素噪声：`rand<0.3 ? pal[randInt(3)] : pal[1]`；top 面 noise=0.25、bottom 面 0.3
//
// ⚠️ **v3.46b 用户裁定（2026-11-27）**：「手臂前方的蓝色部分也烘焙成跟手臂
// 一样的色调，不然看起来感觉怪怪的」⇒ **整条手臂全肤色，无袖口**。
// 上游原本是 `y < 4 ? shirt : skin`（短袖），但那 4 行落在几何 y 最大端，
// 而那一端实测 **z=−1.095（更远）/ y=−0.438（更高）** ⇒ 屏幕上就是**朝前的远端**
//（沿长轴探针：teal 12500 像素全在 bin 8~9）。这是**有意偏离上游**。
//
// ☠️☠️ **外套层（inflate 外包盒）必须整段透明**：
//   · 整段涂实 ⇒ 把下面手臂完全遮住（实测 19550 像素全 teal、肤色 0）；
//   · 只涂袖口 4 行 ⇒ 朝前远端变蓝块（用户否定）。
// ⇒ 回到上游口径：overlay 段不写。几何仍保留袖子盒（形状与上游一致），
// 但材质必须保留 `alphaTest` —— 否则透明像素被当成**黑色实心**把整条手臂盖死。
//
// ⚠️ **烘焙只是数据格式转换，不产生新美术资源**：上游是运行时逐像素绘制，
// 本仓改成离线烘焙 + 指纹门（皮肤类素材的既有口径，见 `bake-zombie-skin.mjs`）。
//
// node 侧模块（门禁与烘焙脚本都要读 PNG / 路径），不进 src/，浏览器不消费。

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { PNG } from 'pngjs';
import { PLAYER_SKIN_UV, PLAYER_SKIN_SIZE } from '../src/render/view-arm-data.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 产物路径（烘焙脚本与门禁共用） */
export const PLAYER_SKIN_PNG = path.join(__dirname, '..', 'assets', 'player', 'skin.png');
export const PLAYER_SKIN_JSON = path.join(__dirname, '..', 'assets', 'player', 'skin.json');

/**
 * 版式版本。改 UV 表或区域划分时**必须同步改它** —— 门禁据此抓
 * 「UV 表已换新布局、皮肤还是旧布局」（所有面采样整体错位，观感是纹理全乱但不报错）。
 */
export const PLAYER_SKIN_LAYOUT_VERSION = 'mc-standard-64-arm-only-allskin';

/** re-export（权威在 src/render/view-arm-data.js，供烘焙脚本、门禁与浏览器单测共同 import） */
export { PLAYER_SKIN_UV, PLAYER_SKIN_SIZE };

/** 六面键（与 mesher 的面序无关，这里是皮肤版式自己的命名） */
const FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];

/** 一组 UV 矩形 → 左闭右开整数区间（反向书写在这里才规范化） */
function rectsOf(part) {
  const out = [];
  for (const face of FACES) {
    const [u1, v1, u2, v2] = PLAYER_SKIN_UV[part][face];
    out.push(Object.freeze({
      x0: Math.min(u1, u2), y0: Math.min(v1, v2),
      x1: Math.max(u1, u2), y1: Math.max(v1, v2),
    }));
  }
  return Object.freeze(out);
}

/**
 * 四个语义区（每个 = 该部件六面 UV 矩形的并集）。
 *
 * ⚠️ **不能用包围盒**：标准皮肤版式里每个部件的 UV 岛并不填满它的 bbox
 *（手臂基础层 bbox 是 40..56 × 16..32，而 x40..44 / y16..20 是别的部件的地盘）。
 * 从 `PLAYER_SKIN_UV` 派生（红线 1：不另写一份矩形）。
 */
export const PLAYER_SKIN_REGIONS = Object.freeze({
  /** 右臂基础层（袖口 + 裸露前臂） */
  arm: rectsOf('arm'),
  /** 右臂外套层（袖子，inflate 0.25） */
  sleeve: rectsOf('sleeve'),
});

/**
 * 配色（sRGB 0..255，三档 = 暗/中/亮）。**逐值取自上游 `steveSkin()`**。
 *
 * ⚠️ 上游用的是 `Rand`（xoshiro128**）；本仓用 mulberry32 ⇒ **逐像素图案不与上游逐位相同**，
 * 但配色、分段位置、噪声概率三项一致 ⇒ 观感等价。这是有意的（红线 2：本仓所有烘焙
 * 共用同一个固定种子 RNG，不为一个素材引入第二套 PRNG）。
 */
export const PLAYER_SKIN_PALETTE = Object.freeze({
  skin: Object.freeze([0xa8, 0x7d, 0x63]),
  skinMid: Object.freeze([0xb6, 0x8a, 0x6f]),
  skinLight: Object.freeze([0xc4, 0x9a, 0x7e]),
  shirt: Object.freeze([0x00, 0x80, 0x80]),
  shirtMid: Object.freeze([0x00, 0xa0, 0xa0]),
  shirtLight: Object.freeze([0x00, 0xb2, 0xb2]),
});

/**
 * 远端分区行数（侧面上 4 行，侧面高 12px）。
 *
 * ⚠️ **v3.46b 起它不再是「袖口长度」而是「回归门的分区界线」**：
 * 用户 2026-11-27 裁定整条手臂都是肤色（无袖口），但门禁仍需要把侧面切成
 * 「远端 4 行 vs 近端 8 行」两段比色距 —— 若有人把袖口改回衬衫色，色距会从 ~2 跳到 ~188。
 * 取 4 是为了与旧口径逐字对齐（那 4 行就是原来的衬衫区）。
 */
export const PLAYER_SKIN_FAR_ROWS = 4;

/** 侧面逐像素取随机档的概率（上游 `r.next() < 0.3`） */
export const PLAYER_SKIN_SIDE_NOISE = 0.3;
/** top 面 fillFace 的 noise（上游 0.25） */
export const PLAYER_SKIN_TOP_NOISE = 0.25;
/** bottom 面 fillFace 的 noise（上游 0.3） */
export const PLAYER_SKIN_BOTTOM_NOISE = 0.3;

/**
 * 远端段与近端段的**最大**欧氏色距（sRGB 0..255）—— **上界门，不是下界**。
 *
 * ⚠️⚠️ **v3.46b 口径反转**（用户 2026-11-27：「手臂前方的蓝色部分也烘焙成
 * 跟手臂一样的色调，不然看起来感觉怪怪的」）：
 *   · 旧口径（v3.46）：两段色距 **≥ 60**（抓「整条手臂一个颜色」）；
 *   · 新口径：两段色距 **≤ 12**（抓「又出现异色袖口」）。
 * 两者目标相反 —— 现在「一个颜色」正是用户要的。
 *
 * 标定依据：全肤色下两段均值的实测差 ≈ **2**（只是三档噪声的采样波动）；
 * 而衬衫色 vs 肤色是 **188** ⇒ 阈 12 两侧都有巨大余量。
 * ⚠️ 不要为了让某版配色过门而放宽它。
 */
export const PLAYER_SKIN_MAX_DIST = 12;

/** 固定种子（红线 2：程序化绘制不许用 Math.random） */
export const PLAYER_SKIN_SEED = 20261127;

/** mulberry32（与 `zombie-skin-fingerprint.mjs` / `bake-procedural-textures.mjs` 同款） */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** UV 表的稳定串（进入指纹：改任一矩形即指纹变） */
function uvFingerprint() {
  return Object.keys(PLAYER_SKIN_UV)
    .map((part) => `${part}:${FACES.map((f) => PLAYER_SKIN_UV[part][f].join(',')).join('|')}`)
    .join(';');
}

/**
 * 输入指纹 = 版式版本 + 尺寸 + 区域 + 配色 + 分段/噪声参数 + 种子 + UV 表。
 *
 * 已知盲区（与 `zombie-skin-fingerprint.mjs` 同类）：改**绘制算法**而不动参数时指纹不变
 * ⇒ 那类改动靠产物契约单测 + Tier 4 像素兜住。
 * @returns {string}
 */
export function playerSkinInputFingerprint() {
  const regions = Object.entries(PLAYER_SKIN_REGIONS)
    .map(([k, rects]) => `${k}:${rects.map((r) => `${r.x0},${r.y0},${r.x1},${r.y1}`).join('.')}`).join('|');
  const palette = Object.entries(PLAYER_SKIN_PALETTE).map(([k, v]) => `${k}:${v.join(',')}`).join('|');
  return [
    `layout:${PLAYER_SKIN_LAYOUT_VERSION}`,
    `size:${PLAYER_SKIN_SIZE}`,
    `regions:${regions}`,
    `palette:${palette}`,
    `farRows:${PLAYER_SKIN_FAR_ROWS}`,
    `sideNoise:${PLAYER_SKIN_SIDE_NOISE}`,
    `topNoise:${PLAYER_SKIN_TOP_NOISE}`,
    `bottomNoise:${PLAYER_SKIN_BOTTOM_NOISE}`,
    `seed:${PLAYER_SKIN_SEED}`,
    `uv:${uvFingerprint()}`,
  ].join(';');
}

/** PNG 内容哈希（FNV-1a 32bit，同 `zombie-skin-fingerprint.mjs` 的 pngHash） */
export function playerSkinPngHash(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  let h = 0x811c9dc5;
  for (let i = 0; i < png.data.length; i++) {
    h ^= png.data[i];
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return (h >>> 0).toString(36);
}