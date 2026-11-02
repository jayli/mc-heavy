// tools/zombie-skin-fingerprint.mjs — 丧尸皮肤版式参数与输入指纹
//
// **两个消费者共用同一份逻辑**（红线 1：同一事实只有一份权威）：
//   - `tools/bake-zombie-skin.mjs` 烘焙时按本参数绘制，并把指纹写进 `assets/zombie/skin.json`
//   - `tools/check-data.mjs` 用当前参数重算并比对 → 不匹配即报「跑 npm run zombieskin」
//
// ⚠️ **UV 矩形不在这里再写一份** —— 从 `src/render/zombie-model.js` re-export（渲染器运行时
// 读的就是那份，两处必须字面同一）。手法同 `tools/cloudland-kit-fingerprint.mjs` re-export
// `src/gen/structures/cloudland-kit-data.js`。
//
// 皮肤是**派生产物**，权威输入是本文件的参数 + `zombie-model.js` 的 UV 表。改了却忘跑
// `npm run zombieskin`，皮肤会**静默过期**（渲染旧图案/旧配色，肉眼看不出）—— 与图标过期
// 同一条失效路径。
//
// node 侧模块（门禁与烘焙脚本都要读 PNG / 路径），不进 src/，浏览器不消费。

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { ZOMBIE_SKIN_UV, SKIN_SIZE, ZOMBIE_MODEL_PARTS, SKIN_EYES } from '../src/render/zombie-model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 产物路径（烘焙脚本与门禁共用，避免两处各写一份） */
export const SKIN_PNG = path.join(__dirname, '..', 'assets', 'zombie', 'skin.png');
export const SKIN_JSON = path.join(__dirname, '..', 'assets', 'zombie', 'skin.json');

/**
 * 版式版本：皮肤图的布局口径。
 * 改 UV 表或区域划分时**必须同步改它** —— 门禁据此抓「UV 表已换新布局、皮肤还是旧布局」
 * （那会让所有面的采样整体错位，观感是「纹理全乱」，但不报错）。
 */
export const SKIN_LAYOUT_VERSION = 'mc-standard-64';

/**
 * re-export（权威在 src/render/zombie-model.js，供烘焙脚本、门禁与 Tier 4 fixture 共同 import）
 * ⚠️ `SKIN_EYES` 也必须住 `src/` —— Tier 4 fixture 在浏览器里要 import 它，而 `tools/*.mjs`
 * 被静态服务器以 `application/octet-stream` 提供（浏览器拒绝加载为模块，实测踩到）。
 */
export { ZOMBIE_SKIN_UV, SKIN_SIZE, ZOMBIE_MODEL_PARTS, SKIN_EYES };

/**
 * 皮肤的四个语义区，每个区 = **该部件六个面的 UV 矩形的并集**（源像素，左闭右开）。
 *
 * ⚠️ **不能用包围盒**：标准皮肤版式里每个部件的 UV 岛并不填满它的 bbox
 * （例：body 的 bbox 是 16..40 × 16..32，而 x16..20 / y16..20 那块是别的部件的地盘）
 * —— 拿 bbox 取均值会把邻区颜色混进来，实测三区色距从 87/51/66 跌到 43/57/75。
 *
 * 从 `ZOMBIE_SKIN_UV` 派生（红线 1：不另写一份矩形）—— 区就是「玩家实际看到的那几块像素」。
 */
function rectsOf(parts) {
  const out = [];
  for (const part of parts) {
    for (const face of ['px', 'nx', 'py', 'ny', 'pz', 'nz']) {
      const [u1, v1, u2, v2] = ZOMBIE_SKIN_UV[part][face];
      out.push(Object.freeze({
        x0: Math.min(u1, u2), y0: Math.min(v1, v2),
        x1: Math.max(u1, u2), y1: Math.max(v1, v2),
      }));
    }
  }
  return Object.freeze(out);
}

export const SKIN_REGIONS = Object.freeze({
  /** 头（颈以上） */
  head: rectsOf(['head']),
  /** 躯干（上衣） */
  torso: rectsOf(['body']),
  /** 两臂（袖子 + 露出的前臂） */
  arm: rectsOf(['rightArm', 'leftArm']),
  /** 两腿（裤腿 + 鞋） */
  leg: rectsOf(['rightLeg', 'leftLeg']),
});

/**
 * 配色（sRGB 0..255）。原版丧尸口径：绿皮 + 青蓝上衣 + 蓝紫裤子。
 *
 * ⚠️ **这组值要按「三区色距 ≥ `SKIN_REGION_MIN_DIST`」标定** —— 先烘一版量门禁的输出，
 * 不达标就调这里，**不要在门里放宽阈值**（阈值是判别力，配色是观感）。
 */
export const SKIN_PALETTE = Object.freeze({
  /** 皮肤基色（绿皮） */
  skin: Object.freeze([92, 140, 85]),
  /** 上衣基色（青蓝） */
  shirt: Object.freeze([70, 110, 140]),
  /** 裤子基色（蓝紫） */
  pants: Object.freeze([80, 70, 150]),
  /** 眼窝（近黑带一点绿，避免纯黑在远处糊成洞） */
  eye: Object.freeze([24, 32, 20]),
  /** 鞋（比裤子更深的冷灰） */
  shoe: Object.freeze([52, 48, 62]),
  /** 腐斑（偏黄的暗绿，叠在皮肤上做旧） */
  rot: Object.freeze([120, 120, 78]),
});

/**
 * 三区均值最小欧氏色距（sRGB 0..255 单位）。
 *
 * 标定依据与实测读数见计划 Task 4：先在达标配色下量三对距离，再定阈值使两侧都有余量。
 * ⚠️ 不要为了让某版配色过门而放宽它 —— 那会把「远看是纯色人形」这个真实缺陷放过去。
 */
export const SKIN_REGION_MIN_DIST = 40;

/** 固定种子（红线 2：程序化绘制不许用 `Math.random`，否则每次加载图案都变） */
export const SKIN_SEED = 20261104;

/** 逐像素明度抖动幅度（±v/2，sRGB 单位） */
export const SKIN_NOISE = 8;

/** 破损像素占比：躯干/臂区露皮肤 */
export const SKIN_TEAR_RATIO = 0.08;

/** 腐斑像素占比：头部区 */
export const SKIN_ROT_RATIO = 0.05;

/** mulberry32（固定种子 RNG，与 `tools/bake-procedural-textures.mjs` 同款实现） */
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
  const parts = [];
  for (const part of ZOMBIE_MODEL_PARTS) {
    const faces = ZOMBIE_SKIN_UV[part];
    parts.push(`${part}:${['px', 'nx', 'py', 'ny', 'pz', 'nz'].map((f) => faces[f].join(',')).join('|')}`);
  }
  return parts.join(';');
}

/**
 * 输入指纹 = 版式版本 + 区域 + 配色 + 噪声/破损比例 + 眼睛位置 + 种子 + UV 表。
 *
 * 为什么用参数指纹而非颜色比对：指纹是**精确**判定（任一参数变了必不匹配），不依赖阈值调参。
 * 已知盲区（与 `icon-fingerprint.mjs` 同类）：改**绘制算法**而不动参数时指纹不变 ——
 * 这类改动须靠 Tier 4 像素实测兜住。
 * @returns {string}
 */
export function skinInputFingerprint() {
  const regions = Object.entries(SKIN_REGIONS)
    .map(([k, rects]) => `${k}:${rects.map((r) => `${r.x0},${r.y0},${r.x1},${r.y1}`).join('.')}`).join('|');
  const palette = Object.entries(SKIN_PALETTE).map(([k, v]) => `${k}:${v.join(',')}`).join('|');
  const eyes = SKIN_EYES.map((e) => `${e.dx},${e.dy},${e.w},${e.h}`).join('|');
  return [
    `layout:${SKIN_LAYOUT_VERSION}`,
    `size:${SKIN_SIZE}`,
    `regions:${regions}`,
    `palette:${palette}`,
    `noise:${SKIN_NOISE}`,
    `tear:${SKIN_TEAR_RATIO}`,
    `rot:${SKIN_ROT_RATIO}`,
    `eyes:${eyes}`,
    `seed:${SKIN_SEED}`,
    `uv:${uvFingerprint()}`,
  ].join(';');
}

/** PNG 内容哈希（FNV-1a 32bit，纯整数无依赖，同 `icon-fingerprint.mjs` 的 `texHash`） */
export function pngHash(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  let h = 0x811c9dc5;
  for (let i = 0; i < png.data.length; i++) {
    h ^= png.data[i];
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return (h >>> 0).toString(36);
}
