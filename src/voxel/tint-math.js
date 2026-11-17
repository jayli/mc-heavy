// src/voxel/tint-math.js — 贴图着色的纯数学（v3.12，草方块配色对齐 vanilla）
//
// 属 Worker 同构层（红线 8）：无 DOM、无 fs、不 import three。
// **两个消费方共用这一份**（红线 1）：
//   ① `tools/bake-grass-textures.mjs`（node 侧离线烘焙）
//   ② `src/tests/test-grass-tint.js`（浏览器内单测）
// 各写一份公式会漂移出「单测说该这个色、烘出来是另一个色」的静默撕裂。
//
// ## 为什么着色必须预乘进贴图，而不是运行时乘
// vanilla 的草方块是「灰度贴图 + 运行时 biome tint」（`grass_block_top` 是纯灰度，
// `grass_block_side` 的草沿由 `grass_block_side_overlay` 灰度 × biome 色合成）。
// 本仓体素材质是 **unlit**、无 biome tint uniform，也没有第二层 overlay 几何 ——
// 所以只能把着色**烘进像素**。这不是偏离，是同一视觉结果的不同实现位置。
//
// ## GRASS_TINT 的来源（实测反解，不是挑一个好看的绿）
// 用户 2026-11-17 给的参考图 `Grass_Block_JE7_BE6.png` 与 wiki 官方渲染图逐字节相同。
// 按等轴测三面逐 texel 反解：
//   · 顶面 = vanilla 灰度 × T，corr **0.9997**、最小二乘 T=(119.21,186.57,101.54)、RMSE **0.83**
//   · 侧面 = [side×(1−a) + ovGray×T×a] × 面光照，RMSE **0.86/1.15**
//     （对照：直接用 side 成品是 RMSE 12.67 ⇒ wiki 渲染**不用** side 自带的草沿像素）
// 取整到 0.1 → 下面这三个值，RMSE 不变。
// ⚠️ 它**不是** plains 官方 tint `#91BD59`=(145,189,89)：blockrender 的官方渲染反解出的
// 才是那个值。参考图用的是更暗、更偏青的一档 —— 用户要的是参考图那个色调。

/** 草色着色系数（唯一权威，禁止在第二处写字面量） */
export const GRASS_TINT = Object.freeze([119.2, 186.6, 101.5]);

/**
 * 把一张（灰度）贴图按 tint 着色：逐通道 `round(c × T[c]/255)`，**alpha 原样保留**。
 *
 * 用于 `grass_block_top` / `tall_grass_top` / `short_grass` 这类「灰度承载明暗、
 * 色相由 biome 决定」的 vanilla 源图。
 *
 * @param {{data: ArrayLike<number>, width: number, height: number}} src
 * @param {readonly number[]} tint 三通道系数（0~255 口径）
 * @returns {{data: Uint8ClampedArray, width: number, height: number}} 新缓冲，不改入参
 */
export function applyTint(src, tint) {
  const out = new Uint8ClampedArray(src.data.length);
  for (let i = 0; i < src.data.length; i += 4) {
    for (let c = 0; c < 3; c++) out[i + c] = Math.round(src.data[i + c] * tint[c] / 255);
    out[i + 3] = src.data[i + 3];
  }
  return { data: out, width: src.width, height: src.height };
}

/**
 * 重算「草沿」：`round(base×(1−a) + ovGray×T/255×a)`，`a = overlayAlpha/255`。
 * 输出 alpha 恒 255（草方块侧面不透明）。
 *
 * ⚠️ **base 必须是 `grass_side_carried` 自己，不能用 `dirt.png`**：
 * vanilla `grass_block_side` 的泥土区与 `dirt.png` **有 48 个字节差**（side 自带一套
 * dirt 变体）。用 dirt 当 base 会把非草沿区一起改掉 —— 那不是本需求要的改动，
 * 且会让「侧面 dirt 区逐字节不变」这条内容级判据失效（指纹拓不到它）。
 *
 * @param {{data: ArrayLike<number>, width: number, height: number}} base 原 side 贴图
 * @param {{data: ArrayLike<number>, width: number, height: number}} overlay 灰度草沿遮罩（alpha 承载形状）
 * @param {readonly number[]} tint
 * @returns {{data: Uint8ClampedArray, width: number, height: number}} 新缓冲，不改入参
 */
export function retintFringe(base, overlay, tint) {
  const out = new Uint8ClampedArray(base.data.length);
  for (let i = 0; i < base.data.length; i += 4) {
    const a = overlay.data[i + 3] / 255;
    for (let c = 0; c < 3; c++) {
      out[i + c] = Math.round(base.data[i + c] * (1 - a) + overlay.data[i + c] * tint[c] / 255 * a);
    }
    out[i + 3] = 255;
  }
  return { data: out, width: base.width, height: base.height };
}

