// src/render/pixel-ratio.js — 渲染分辨率档位（v2.27，「清晰」/「性能」两档）
//
// 为什么要单独成模块（而不是在 game.js 里写两行）：
//   ① 面板（`ui/settings-panel.js`）、设置解析（`ui/settings.js`）、渲染接线（`core/game.js`）
//      三处都要用到「档位 → 像素比」这段换算。各写一份字面量会漂移出「按钮说性能、
//      实际没降」这种**静默**缺陷（像素比是 GPU drawing buffer 的物理尺寸，画面照常出，
//      只是没变小，肉眼在 Retina 屏上很容易看不出来）。
//   ② 这段换算有对错可言（半倍率、下限钳制、非法值回落），必须能被 Tier 1 单测钉住 ——
//      而 `renderer.setPixelRatio()` 本身在无头单测里验不到（没有真 WebGPU backend）。
//   与 `render/fog-sky-direction.js`、`render/sun-shade.js` 同手法：纯函数 + three-free，
//   被渲染层 import，数值口径只有这一份（红线 1）。
//
// ## 为什么不照抄 mc-lite 的三档绝对倍率（0.4 / 0.6 / 1.0）
//
// mc-lite 的 `Engine.setResolution(scale)` 直接把 `scale` 喂给 `setPixelRatio()`，它的三档是
// **绝对**像素比。而本仓的清晰档是 `window.devicePixelRatio`（Retina 屏 = 2.0）——
// 若照搬那三档，「1.0 画质档」在本仓相当于把 Retina 屏降到一半分辨率，
// 而「0.4 性能档」会糊到比 mc-lite 更狠（mc-lite 自己的默认也只有 0.6）。
// 故本仓按**相对 dpr 的倍率**定义：清晰 = dpr 原值（= 改动前的观感，零回归），
// 性能 = dpr × 0.5（像素量降到 1/4）。普通屏（dpr=1）上性能档恰为 0.5，
// 与 mc-lite 的性能档量级一致。

/**
 * 分辨率档位集合（面板两个按钮、`?res=` URL 取值、localStorage 存储值共用这一份）。
 * 顺序 = 面板按钮的显示顺序：「清晰」在前（默认档）、「性能」在后。
 */
export const PIXEL_RATIO_MODE_OPTIONS = ['sharp', 'performance'];

/**
 * 默认档 = 清晰。**必须等于本次改动前的实际观感**（`setPixelRatio(devicePixelRatio)`），
 * 否则等于在没人要求的情况下偷偷降了全世界的画质。
 */
export const DEFAULT_PIXEL_RATIO_MODE = 'sharp';

/**
 * 性能档相对 devicePixelRatio 的倍率（用户 2026-11-03 裁定 0.5）。
 * Retina 屏（dpr=2）→ 1.0；普通屏（dpr=1）→ 0.5。像素量降到 1/4。
 */
export const PERFORMANCE_RATIO_SCALE = 0.5;

/**
 * 像素比下限。**绝不能是 0** —— `setPixelRatio(0)` 会让 `canvas.width/height` 归零，
 * 而 WebGPU 不为此抛异常：画面只是变成一片空白，是典型的静默失效。
 * 取 0.25 与 mc-lite 最激进档（0.4）同量级，仅在 dpr 异常（0 / NaN）时才生效。
 */
export const PIXEL_RATIO_MIN = 0.25;

/**
 * 归一化档位值（存储 / URL / 构造函数入参都过它）。
 * @param {*} v
 * @returns {'sharp'|'performance'} 非法值一律回落默认档（不抛异常）
 */
export function normPixelRatioMode(v) {
  return PIXEL_RATIO_MODE_OPTIONS.includes(v) ? v : DEFAULT_PIXEL_RATIO_MODE;
}

/**
 * 由档位与设备像素比算出 `renderer.setPixelRatio()` 的入参。
 *
 * ⚠️ 非有限 dpr（`NaN` / `Infinity` / `undefined`）一律当下限处理：真实浏览器里
 * `devicePixelRatio` 恒为有限正数，但这些入参在单测与 fixture 里会被显式喂进来，
 * 而乘积落到 `NaN` 会让 canvas 宽高也是 `NaN` → 同样静默空白。
 *
 * @param {'sharp'|'performance'} mode 档位（非法值按默认档处理）
 * @param {number} dpr 设备像素比（通常是 `window.devicePixelRatio`）
 * @returns {number} ≥ `PIXEL_RATIO_MIN` 的有限值
 */
export function pixelRatioFor(mode, dpr) {
  const n = Number(dpr);
  const base = Number.isFinite(n) && n > 0 ? n : PIXEL_RATIO_MIN;
  const scale = normPixelRatioMode(mode) === 'performance' ? PERFORMANCE_RATIO_SCALE : 1;
  return Math.max(PIXEL_RATIO_MIN, base * scale);
}