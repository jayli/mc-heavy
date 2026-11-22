// src/render/storm-grade-config.js — 雨天光影档的后处理标定常数（**three-free**）
//
// 上游：`bj-shooting-game/night-heron-src/src/gfx/renderer.js`
// （COMPOSITE_FRAG 体积雾 + 远景雨幕 / BLOOM_DOWN·UP / GRADE_FRAG 色差·ACES·暗角）。
//
// ## 移植范围（用户 2026-11-22 第二轮裁定）
//
// 用户原话：「单孔可以不要，CA 和暗角你看下如果跟现在我实现的类似的话，也可以不移植。」
//   · **弹孔（单孔）不做** ⇒ `carbine-fx` 的弹孔池虽已实现，装配层**不启用**它
//     （`holes` 恒 0；池代码保留但不 spawn，见 `carbine-fx.js` 的 `enableHoles` 开关）。
//   · **CA（色差）与暗角**：本仓此前**零实现**（程序化扫描 `vignette|色差|chromatic`
//     在 src/ 与 index.html 全无命中）⇒ 不存在「跟现在实现的类似」的情形，
//     故**照移植**（它们是上游雨夜氛围的一部分，且成本极低：两次纹理采样 + 一次乘法）。
//   · **ACES 色调映射**：本仓**已有**（`renderer.toneMapping = ACESFilmicToneMapping`，
//     v1.70 用户拍板）⇒ **不重复移植**，后处理链沿用 renderer 的那一份
//     （`RenderPipeline` 的 `outputColorTransform` 自动接上）。
//
// ## 与上游的三处必要改写
//   ① **体积雾的散射源**：上游对 32 个霓虹灯做闭式积分（`uVolPos/uVolCol`）。
//      本仓没有霓虹灯，改用**太阳 + 天空环境色**两项（同公式，光源数 2）。
//   ② **远景雨幕**：上游用一张程序化雨纹贴图做三层柱面投影。本仓改用
//      **TSL 噪声**（零贴图、零烘焙产物），三层尺度/速度/门控逐字保留。
//   ③ **bloom 用 mip 链**：上游手写 6 级 down/up（13 抽头 +  tent 上采样）。
//      本仓用 `pass(...).getTextureNode()` + 逐级 `rtt` 降采样（同结构，
//      但复用 three 的 RT 管理，少一套手写 RT 生命周期）。
//
// ⚠️ 本文件不 import three（Node 单测直接读）。

/**
 * 体积雾（上游 COMPOSITE_FRAG 的 inscattering）。
 *
 * 上游对每个光源做「1/d² 沿视线的闭式积分」：
 *   b = dot(q, rd); h2 = dot(q,q) − b² + 0.05; h = sqrt(h2)
 *   I = min((atan((T−b)/h) + atan(b/h)) / h, 2.6)
 *   ins += col * I * smoothstep(0.09, 7, |q|²) / (1 + h2*0.11)
 * 本仓光源 = 太阳方向（无穷远 ⇒ 用方向项近似）+ 天空环境色（各向同性）。
 */
export const STORM_FOG = Object.freeze({
  /** 散射总增益（上游 `uVolK = 0.0055`；本仓无霓虹 ⇒ 抬到 0.02 才有可见雾感） */
  gain: 0.02,
  /** 噪声调制（上游 `ins *= uVolK*(0.62 + 0.76*n)`） */
  noiseBase: 0.62,
  noiseRange: 0.76,
  /** 噪声空间尺度（上游 `rd.xz*0.9 + vec2(rd.y*0.5, t*0.013)`） */
  noiseScale: 0.9,
  noiseYScale: 0.5,
  noiseSpeed: 0.013,
  /** 积分上限（上游 `T = min(lin*length(rayV), 120)`） */
  maxDistance: 120,
  /** 太阳散射色（暖白；上游是霓虹色，本仓取日光） */
  sunColor: Object.freeze([1.0, 0.92, 0.78]),
  /** 天空散射色（冷蓝，与雨丝同色系） */
  skyColor: Object.freeze([0.42, 0.55, 0.78]),
  /** 太阳项权重（方向性散射，朝太阳看更亮） */
  sunWeight: 0.6,
  /** 太阳项的方向锐度（pow(dot(rd,sunDir), k)） */
  sunSharpness: 8.0,
});

/**
 * ⚠️⚠️ **远景雨幕（STORM_FAR_RAIN）已整表删除**（v3.30e，用户裁定「感觉还不如去掉」）。
 *
 * 用户实玩报告「屏幕上有纹路，让屏幕看上去很粗糙」。单变量像素实测的根因：
 * 上游 `rainLayer` 把 512² 细丝纹理按柱面投影铺满屏幕，三层 tiles=12/25/50
 * ⇒ 横向密度 **1.37 / 2.85 / 5.69 texel/像素** ⇒ 严重欠采样走样，细丝混叠成满屏竖纹。
 *   · 换纹理内容：原图 **83.5** 次符号翻转/行；只留纵向渐变 **33.5**（= 无雨幕基线）；
 *     只留横向细丝 **144.9** ⇒ 竖纹 100% 来自横向高频。
 *   · 横向 box blur 半径 0→1→2→4→8：83.5 → 72.2 → 64.3 → 52.3 → **40.4**（单调）。
 *   · mip 开/关/Nearest：83.4 / 75.5 / 95.5 ⇒ mip 只帮一点忙，解决不了欠采样。
 *
 * **上游同样欠采样（4.91 texel/px），但它链尾有 FXAA**（`uFxaa=1`）把走样抹平。
 * 本仓移植时判断「已开 MSAA 就不做 FXAA」——那条判断对几何边缘成立，
 * 但 **MSAA 对 shader 内部采样出的高频纹理完全无效** ⇒ 照搬这一层必然粗糙。
 *
 * ⇒ 整层移除。雨感由**真实几何**承担：近景雨丝 5200 条 + 水花（`storm-rain-config.js`）
 * + 体积雾 + 湿地面反光。**不要凭直觉把这三层「补齐」**。
 */

/**
 * Bloom（上游 BLOOM_DOWN / BLOOM_UP）。
 *
 * ⚠️ **阈值与增益逐字取上游**：threshold 0.9、软膝 0.6×threshold、
 * 上采样 tent 权重 /16、最终 `uBloomK = 0.16`。
 */
export const STORM_BLOOM = Object.freeze({
  /** 亮部提取阈值（上游 `bloomThreshold = 0.9`） */
  threshold: 0.9,
  /** 软膝比例（上游 `knee = threshold*0.6`） */
  kneeRatio: 0.6,
  /** 输入钳制上限（上游 `c = min(c, vec3(40))` —— 防极亮像素把整条 mip 链烧白） */
  clampMax: 40,
  /** mip 级数（上游 high/medium 档 6，low 档 5）。本仓取 5（性能档 4）。 */
  levels: 5,
  levelsPerformance: 4,
  /** 上采样扩散（上游 `uSpread = 1.0`，权重 /16） */
  spread: 1.0,
  /** 最终混合增益（上游 `uBloomK = 0.16`） */
  gain: 0.16,
});

/**
 * 色彩分级（上游 GRADE_FRAG）。
 *
 * ⚠️ **ACES 不在这里**：本仓 renderer 已设 ACESFilmicToneMapping，
 * `RenderPipeline.outputColorTransform = true` 会自动在链尾接上它。
 * 本表只管 ACES **之前**的曝光/色差/暗角与**之后**的冷调分级。
 */
export const STORM_GRADE = Object.freeze({
  /** 曝光（上游 `uExposure = 1.15`）。⚠️ 本仓 renderer 已有 toneMappingExposure，
   *  故本项是**额外**乘数，取 1.0 作中性（不双重曝光）。 */
  exposure: 1.0,
  /** 色差强度（上游 `uCA = 0.0045`；偏移 = c*(0.35 + r²*2.6)*uCA） */
  ca: 0.0045,
  caBase: 0.35,
  caRadial: 2.6,
  /**
   * 暗角强度。**有意偏离上游 0.62，取 0.34**（本轮像素实测标定）。
   *
   * 上游是**夜景**（天空 luma≈20），四角再压 62% 也看不出；本仓正午天空 luma≈190
   * ⇒ 0.62 把左右边缘压到 **luma 33、近黑占比 0.30**（实测 5×3 网格：
   * 两侧 0.301/0.295，中心 0.002/luma 178）⇒ 读作「屏幕两侧糊了黑边」而不是暗角。
   * 取 0.34 后边缘仍压暗但不到近黑（判据：中心区近黑 <1%、边缘均值 >60）。
   * ⚠️ 这不是「放宽阈值」——阈值判的是**中心区**（撕碎会污染中心），
   * 强度是按本仓亮场景重新标定的观感参数。
   */
  vignette: 0.34,
  vignetteFrom: 0.08,
  vignetteTo: 0.62,
  /** 冷调分级（上游暗部乘 (0.86, 1.0, 1.16)，权重 (1−smoothstep(0,0.5,luma))*0.55） */
  coldTint: Object.freeze([0.86, 1.0, 1.16]),
  coldFrom: 0.0,
  coldTo: 0.5,
  coldWeight: 0.55,
  /** 对比 S 曲线（上游 `col*col*(3−2col)*0.35 + col*0.65`） */
  contrastMix: 0.35,
  /** 胶片颗粒（上游 FXAA_FRAG 的 `uGrain = 0.045`，暗部更强）。
   *  ⚠️ v3.30g：颗粒已移到**显示空间**（ACES + sRGB 之后），故暗部权重读的是
   *  **显示 luma**（同上游 `m.a`）。旧实现在线性空间加 ⇒ 暗部增量被 ACES 放大。 */
  grain: 0.045,
  grainDarkBoost: 0.65,
});

/**
 * 档位 → bloom 级数。
 * @param {'sharp'|'performance'} mode
 * @returns {number}
 */
export function stormBloomLevels(mode) {
  return mode === 'performance' ? STORM_BLOOM.levelsPerformance : STORM_BLOOM.levels;
}

/**
 * 软膝亮部提取（上游 `pre()` 的 CPU 同构，供单测钉住阈值行为）。
 * @param {number} br 亮度（max(r,g,b)）
 * @param {number} threshold
 * @param {number} kneeRatio
 * @returns {number} 该像素保留的比例 0..1
 */
export function bloomSoftKnee(br, threshold = STORM_BLOOM.threshold, kneeRatio = STORM_BLOOM.kneeRatio) {
  const knee = threshold * kneeRatio;
  const soft = Math.max(0, Math.min(2 * knee, br - threshold + knee));
  const softOut = (soft * soft) / (4 * knee + 1e-4);
  return Math.max(softOut, br - threshold) / Math.max(br, 1e-4);
}

/**
 * 暗角乘数（上游 `1 − v*smoothstep(0.08, 0.62, r²)`）。
 * @param {number} r2 到屏幕中心的归一化距离平方（中心 0、角 0.5）
 * @param {number} v 强度
 * @returns {number} 0..1
 */
export function vignetteAt(r2, v = STORM_GRADE.vignette) {
  const { vignetteFrom: a, vignetteTo: b } = STORM_GRADE;
  const t = Math.max(0, Math.min(1, (r2 - a) / (b - a)));
  return 1 - v * (t * t * (3 - 2 * t));
}

/**
 * 色差的 UV 偏移量（上游 `off = c*(0.35 + r²*2.6)*uCA`）。
 * @param {number} cx 到中心的 x 偏移（−0.5..0.5）
 * @param {number} r2 距离平方
 * @param {number} ca 强度
 * @returns {number} 该方向上的偏移量
 */
export function chromaticOffset(cx, r2, ca = STORM_GRADE.ca) {
  return cx * (STORM_GRADE.caBase + r2 * STORM_GRADE.caRadial) * ca;
}