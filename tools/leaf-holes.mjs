// tools/leaf-holes.mjs — 树叶贴图的「孔洞压缩」共享逻辑（红线 1：两个烘焙脚本共用这一份）
//
// **消费者**：
//   - `tools/bake-giant-textures.mjs`（巨树叶，重着色 + 孔洞压缩）
//   - `tools/bake-leaf-textures.mjs`（普通树叶，只做孔洞压缩、不改颜色）
//   - `tools/check-data.mjs`（门禁按同一份逻辑复算孔洞率，防两处漂移）
//
// ## 为什么需要孔洞压缩（2026-10-23 用户需求）
//
// 树叶走 cutout 通道、`alphaTest = 0.3`（materials.js）→ `alpha < 77` 的像素被 discard。
// 源图那批「半透明」像素（alpha 1~76）会被一并剔掉，孔洞率高达 23%~78%，观感是「叶冠太稀」。
// 尤其是巨树冠巨大、普通树的 `oak_leaves_branch_medium` 甚至 77.6% 孔洞 —— 树叶几乎不成形。
//
// **做法**：从源图**已经被 alphaTest 剔除的那批像素**里按低差异序列选前 N 个作孔洞（alpha 归 0），
// 其余像素 alpha 抬到 255（完全实心）。两个设计点：
//   ① **只在源图的孔洞集合里选** —— 不是在叶面上随机挖洞，保留的孔洞位置仍符合原图的叶片脉络；
//   ② **低差异序列（R2）而非「alpha 最小优先」** —— 后者实测会把孔洞聚成一块（前 8 个全落左上角），
//      而 R2 能铺开到几乎每一行，观感才是「疏密有致」而不是「边上缺一块」。
//
// ⚠️ **几何/顶点数完全不变**（只改 alpha），所以不影响任何容量预算。

import { PNG } from 'pngjs';

/** cutout 材质的 alphaTest 阈值：alpha < 77 的像素会被 discard（materials.js 的 `alphaTest: 0.3`） */
export const HOLE_ALPHA = 77;

/**
 * 统一孔洞率（2026-10-23 用户裁定：普通树叶「跟巨树一样」）。
 * 实测：38/256 = 14.84%，叶面覆盖 85.2%。
 * 取值依据（巨树那次逐档试出来的，同一套看图比对）：
 *   · 0.03（8 个）→ 几乎无孔，像实心彩色塑料
 *   · 0.08（20 个）→ 孔洞太零散
 *   · 0.15（38 个）→ 疏密有致，铺开 14/16 行
 */
export const LEAF_HOLE_RATIO = 0.15;

/** 门禁允许的孔洞率区间（5%~25%；太小像实心色板，太接近源图就回到「叶冠太稀」） */
export const LEAF_HOLE_RATIO_MIN = 0.05;
export const LEAF_HOLE_RATIO_MAX = 0.25;

/** R2 低差异序列：给像素一个确定性的「空间铺开」优先级（不依赖随机数） */
function r2Priority(i, width) {
  const x = i % width;
  const y = Math.floor(i / width);
  const v = x * 0.7548776662466927 + y * 0.5698402909980532;
  return v - Math.floor(v);
}

/**
 * 压缩孔洞：从源图「会被 alphaTest 剔除」的像素里按 R2 顺序选前 `ratio×像素数` 个作孔洞
 * （alpha 归 0），其余全部抬到 255。返回新的 alpha 数组与孔洞数。
 *
 * 源图孔洞不够 `ratio` 所需时用全部源孔洞（**不额外挖叶面**）。
 * @param {{width:number,height:number,data:Uint8Array}} src pngjs 解码后的 PNG
 * @param {number} ratio 目标孔洞率（占全部像素）
 * @returns {{alpha: Uint8Array, holeCount: number, srcHoleCount: number}}
 */
export function compactLeafHoles(src, ratio) {
  const n = src.width * src.height;
  const srcHoles = [];
  for (let i = 0; i < n; i++) if (src.data[i * 4 + 3] < HOLE_ALPHA) srcHoles.push(i);
  const ranked = [...srcHoles].sort((a, b) => r2Priority(a, src.width) - r2Priority(b, src.width) || a - b);
  const holeCount = Math.max(0, Math.min(srcHoles.length, Math.round(n * ratio)));
  const alpha = new Uint8Array(n).fill(255);
  for (let k = 0; k < holeCount; k++) alpha[ranked[k]] = 0;
  return { alpha, holeCount, srcHoleCount: srcHoles.length };
}

/**
 * 按 pngjs 的 PNG 对象统计「会被 alphaTest 剔除」的像素比例（门禁用；与烘焙同一判据）。
 * @param {{width:number,height:number,data:Uint8Array}} png
 * @returns {{holes:number, total:number, ratio:number}}
 */
export function leafHoleStats(png) {
  const total = png.width * png.height;
  let holes = 0;
  for (let i = 0; i < total; i++) if (png.data[i * 4 + 3] < HOLE_ALPHA) holes++;
  return { holes, total, ratio: holes / total };
}

/**
 * 把一份 alpha 数组套到源图 RGB 上，生成新 PNG（RGB 逐字节保留，只改 alpha）。
 * 用于「只压孔洞、不改颜色」的普通树叶烘焙。
 */
export function applyAlpha(src, alpha) {
  const out = new PNG({ width: src.width, height: src.height });
  out.data.set(src.data);
  for (let i = 0; i < src.width * src.height; i++) out.data[i * 4 + 3] = alpha[i];
  return out;
}
