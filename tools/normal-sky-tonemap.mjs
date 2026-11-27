// tools/normal-sky-tonemap.mjs — 烘焙期把 HDR 天空压进 8bit 用的色调映射（three-free）
//
// ## 为什么烘焙期需要色调映射
//
// v3.47 的烘焙用**线性曝光** `×bakeExposure(0.55)` 后直接 `srgbEncode`。那个曝光是按
// **纯渐变天空**标的（上半球辐射 max 1.689，实测削顶 0%）。
//
// v3.48 加了体积云之后，云的线性亮度是天空的 **21~50 倍**（实测 25° 仰角处
// 云 14.8 vs 天空 0.69）——「顶亮底灰 + 亮边」这个观感正是靠这段高动态范围。
// 线性曝光只有一个后果：**全部削顶成 255 死白**，云内部的层次被彻底压平
// （实测抽检：云像素 lum 251.1、整片纯白）。
//
// ⇒ 需要一条**压高光、保中间调**的曲线。直接用上游 ASHLAR 的 AgX+punch
// （常量取自 `src/render/ashlar-tonemap-config.mjs`，**不另立第二份权威**）——
// 它本来就是上游用来同时容纳太阳亮面与云层高光的曲线。
//
// ## 与运行时曲线的串联（必须知道）
//
// 「普通」档运行时会把 `renderer.toneMapping` 切成 `ASHLAR_TONE_MAPPING`（同一条 AgX+punch）。
// 所以烘焙期的输出会被运行时的曲线**再压一次**。这不可避免（贴图已经是 LDR），
// 但决定了烘焙期的曝光要取在「云刚好处在可分辨区间」而不是「显得刚好」
// ⇒ 见 fingerprint 的 `bakeTonemapExposure` 注释。
//
// 上游源码：`source/src/main/25_post.js` 的 `agx()` / `agxContrast()`，逐字移植。

import {
  ASHLAR_AGX_INSET, ASHLAR_AGX_OUTSET,
  ASHLAR_AGX_MIN_EV, ASHLAR_AGX_MAX_EV,
  ASHLAR_PUNCH_GAMMA, ASHLAR_PUNCH_SAT, ASHLAR_LUMA_WEIGHTS,
} from '../src/render/ashlar-tonemap-config.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * 3×3 矩阵乘向量。
 * ⚠️ 矩阵按**列主序**存（每个子数组是一列，与 GLSL `mat3(c0,c1,c2)` 同序）
 * ⇒ `out[i] = Σ_j m[j][i] * v[j]`。按行主序乘会得出偏色结果
 * （该结论已记在 `ashlar-tonemap-config.js` 的注释里）。
 */
function mulMat3(m, v) {
  return [
    m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2],
    m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2],
    m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2],
  ];
}

/** 上游 `agxContrast()` 逐字（6 次多项式）。 */
function agxContrast(x) {
  const f = (v) => {
    const x2 = v * v, x4 = x2 * x2;
    return 15.5 * x4 * x2 - 40.14 * x4 * v + 31.96 * x4
         - 6.868 * x2 * v + 0.4298 * x2 + 0.1191 * v - 0.00232;
  };
  return [f(x[0]), f(x[1]), f(x[2])];
}

/**
 * 上游 `agx()` 逐字，输入线性 HDR，输出 **sRGB 0..1**。
 *
 * ⚠️ 上游最后是 `pow(v, 2.2)`（不是标准 sRGB 传输函数），随后由渲染管线再 `toSrgb()`。
 * 本函数保留那个 2.2 —— 与上游 `agx() → toSrgb()` 的串联顺序一致。
 */
export function agxToneMap(rgb) {
  let v = mulMat3(ASHLAR_AGX_INSET, rgb.map((c) => Math.max(c, 1e-10)));
  v = v.map((c) => clamp(Math.log2(c), ASHLAR_AGX_MIN_EV, ASHLAR_AGX_MAX_EV));
  v = v.map((c) => (c - ASHLAR_AGX_MIN_EV) / (ASHLAR_AGX_MAX_EV - ASHLAR_AGX_MIN_EV));
  v = agxContrast(v);
  // display-space punch（顺序载荷性：先 gamma 提对比，再按亮度轴放大饱和）
  v = v.map((c) => Math.pow(Math.max(c, 0), ASHLAR_PUNCH_GAMMA));
  const l2 = dot3(v, ASHLAR_LUMA_WEIGHTS);
  v = v.map((c) => l2 + ASHLAR_PUNCH_SAT * (c - l2));
  v = mulMat3(ASHLAR_AGX_OUTSET, v);
  return v.map((c) => Math.pow(Math.max(c, 0), 2.2));
}