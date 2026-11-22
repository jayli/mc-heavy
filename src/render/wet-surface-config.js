// src/render/wet-surface-config.js — 湿表面的类参数与标定常量（v3.31，**three-free**）
//
// 设计稿：docs/superpowers/specs/2026-11-22-wet-surface-rebuild-design.md §6
//
// ## 与上游的关系：**零关系**
//
// 用户 2026-11-22 裁定「不要参考 bj-shooting-game 的实现，从零实现」。
// 本表的数值按**表面物理**（致密度 / 吸水性 / 折射率）与本仓光照口径定，
// 不是上游 GROUND_FRAG 的 puddle/film 参数。上游那套的前提（独立地面 mesh、
// 地面就在镜面高度）在本仓不成立 —— 详见 spec §2 的三条错配取证。
//
// ## CPU 同构参考实现
//
// TSL 侧在 `wet-surface.js`，两者公式**必须逐项一致**（红线 1：同一事实只有一份权威）。
// 本文件的纯函数是「可在 Node 单测里求值」的那一份 —— TSL 节点只有 GPU 能求值，
// 所以关系式判据（单调性、边界、归零门）全部落在这里，像素判据落在 Tier 4。
//
// ⚠️ 本文件不 import three / three/tsl（Node 单测直接读）。
// ⚠️ 数值是**初值**：反光量级由 Tier 4 的 Δluma 目标带扇描重标（spec §6.1b），
//    关系式（序、单调、归零）是判据，绝对值可调。

import { WET_CLASS, WET_CLASS_COUNT } from '../voxel/wet-material-data.js';

/**
 * 湿度总强度上限（装配层写 `uWet` 时用；0 = 完全干，逐位回到未开启的体素材质）。
 * ⚠️ 名字与值沿用 v3.30 的 `WET_STRENGTH_MAX` —— 装配层与既有 spec 读同一个句柄语义。
 */
export const WET_STRENGTH_MAX = 1.0;

/**
 * 每类一组 `(wetGain, darken, rough, specGain)`，下标 = `WET_CLASS` 的值。
 *
 * - `wetGain`  该类能被淋湿的程度（0 = 永不湿）
 * - `darken`   湿透时的 albedo 乘数（越小越暗 ⇒ 吸水越强）
 * - `rough`    湿表面粗糙度：驱动 F0 / 高光锐度 / 天空渐变带宽 / 积水门
 * - `specGain` 反光强度上限系数（与 rough 反相关，金属/宝石额外抬）
 *
 * ⚠️ **长度必须等于 `WET_CLASS_COUNT`**：GPU 侧是 `uniformArray(...).element(cls)`，
 * 数组短一项就会越界读到 0（整片材质静默退化）或触发 WGSL 验证错误。
 * 由 `test-wet-surface.js` 的长度断言钉住。
 *
 * 标定依据（不是上游数值）：
 *   · 吸水性与 darken 反相关：羊毛/布最吸水（0.55）、金属最不吸水（0.88）；
 *   · rough 按表面致密度：抛光石 0.06 ↔ 羊毛 0.90；
 *   · 冰本来就滑 ⇒ wetGain 只 0.60（湿增益小），但 rough 0.04 / specGain 1.0（镜面最强）；
 *   · 植被 wetGain 0.35 + specGain 0.05 ⇒ 雨里几乎不变（保持哑光）。
 */
export const WET_CLASS_PARAMS = Object.freeze([
  /* NONE     */ Object.freeze([0.00, 1.00, 1.00, 0.00]),
  /* POLISHED */ Object.freeze([1.00, 0.82, 0.06, 1.00]),
  /* STONE    */ Object.freeze([0.85, 0.72, 0.35, 0.45]),
  /* SOIL     */ Object.freeze([1.00, 0.62, 0.62, 0.18]),
  /* WOOD     */ Object.freeze([0.80, 0.74, 0.45, 0.35]),
  /* METAL    */ Object.freeze([0.90, 0.88, 0.12, 0.90]),
  /* ICE      */ Object.freeze([0.60, 0.92, 0.04, 1.00]),
  /* FABRIC   */ Object.freeze([1.00, 0.55, 0.90, 0.04]),
  /* PLANT    */ Object.freeze([0.35, 0.88, 0.85, 0.05]),
]);

/**
 * 侧面（竖直墙面）的湿强度系数；底面恒 0。
 *
 * ⚠️ **这条是用户报告的岩壁亮带的直接防线**：上游 `wet = uWet*(0.3+0.7*up+0.55*streak)`
 * 在 up=0 时仍给到 0.85（实测），于是墙面吃到近乎满强度的镜面反射。
 * 本仓改成「顶面 1 / 侧面 0.22 / 底面 0」的**离散朝向权重** ——
 * 墙面只有极弱压暗与极弱广角反光，没有竖直长条纹理。
 */
export const WET_WALL_FACTOR = 0.22;

/** 竖面水膜更薄更散 ⇒ 粗糙度加成（顶面不加）。 */
export const WET_WALL_ROUGH_ADD = 0.25;

/**
 * 天空环境混合的**上限**。
 * ⚠️ 反光走 `mix(albedo, skyEnv, reflK)` 而不是 `add` ⇒ reflK ≤ 1 时天然有界，
 * 不会像上游的加项那样在亮端钳白（本仓 ocean 已实测过加法钳白）。
 */
export const WET_REFL_MAX = 0.55;

/** 太阳高光总增益。雨天云遮日 ⇒ 取得很弱（不是晴天的镜面太阳斑）。 */
export const WET_SUN_SPEC = 0.22;

/** 积水斑的世界 xz 噪声尺度（0.32 ⇒ 斑块直径 ≈3 格）。 */
export const WET_PUDDLE_SCALE = 0.32;
/** 积水斑的噪声阈值带（smoothstep 的两端）。 */
export const WET_PUDDLE_FROM = 0.52;
export const WET_PUDDLE_TO = 0.76;
/** 积水处粗糙度乘数（更小 ⇒ 更镜面）。 */
export const WET_PUDDLE_ROUGH_K = 0.25;
/** 积水处 albedo 再压暗的乘数。 */
export const WET_PUDDLE_DARK_K = 0.88;
/** 积水处 specGain 乘数（结果钳 ≤1）。 */
export const WET_PUDDLE_SPEC_K = 1.60;

/**
 * 积水门的粗糙度带：rough 越大越不积水（水会被粗糙面吸走 / 散开）。
 * FABRIC 0.90 与 PLANT 0.85 都 ≥ to ⇒ 门恒 0；STONE 0.35 与 POLISHED 0.06 ⇒ 门恒 1。
 */
export const WET_PUDDLE_ROUGH_GATE = Object.freeze({ from: 0.55, to: 0.80 });

/**
 * 天空渐变的反射方向 y 带宽：`smoothstep(mix(loNear,loFar,rough), mix(hiNear,hiFar,rough), R.y)`。
 * 光滑面（rough→0）带宽窄 ⇒ 反光有清晰的天顶/地平线分界；
 * 粗糙面（rough→1）带宽宽 ⇒ 反光糊成一团环境色。
 */
export const WET_SKY_BAND = Object.freeze({
  loNear: -0.15, loFar: -0.50, hiNear: 0.55, hiFar: 1.00,
});

/** 菲涅尔 F0：`BASE + RANGE×(1−rough)`（光滑面 F0 更高 ⇒ 更正视也反光）。 */
export const WET_FRESNEL_F0_BASE = 0.02;
export const WET_FRESNEL_F0_RANGE = 0.04;

/** Blinn-Phong 高光锐度：`min + (max−min)×(1−rough)^3`。 */
export const WET_SHININESS = Object.freeze({ min: 6, max: 420 });

// ---------------------------------------------------------------- 局部纯函数
// ⚠️ 不能 import three/tsl 的 mix/clamp/smoothstep —— 本文件要在 Node 单测里求值。
// 与 GLSL/TSL 的 smoothstep 同定义（Hermite 插值，端点外钳制）。

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function lerp(a, b, t) { return a + (b - a) * t; }
function smoothstep(edge0, edge1, x) {
  if (edge1 === edge0) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * 朝向权重：顶面 1 / 底面 0 / 侧面 `WET_WALL_FACTOR`。
 * 体素面法线是六个轴向之一 ⇒ 阈值 0.5 足以三分（不依赖连续插值）。
 * @param {number} up 面法线 y
 * @returns {number}
 */
export function wetOrientFactor(up) {
  if (!Number.isFinite(up)) return 0;
  if (up > 0.5) return 1;
  if (up < -0.5) return 0;
  return WET_WALL_FACTOR;
}

/**
 * 水下门（沿用 v3.30g 用户裁定「地面反光不要在水面以下出现」）。
 *
 * ⚠️ **必须是逐片元门**：站在岸上看湖底是「相机在水上、片元在水下」，
 * CPU 的总强度门对它零判别力。
 * ⚠️ 取**严格**小于：恰好共面算水上（防边界逐帧翻转）。
 *
 * @param {number} worldY 片元世界高度
 * @param {number} waterY 水面高度
 * @returns {number} 1 = 可湿；0 = 水下
 */
export function wetAboveWaterGate(worldY, waterY) {
  if (!Number.isFinite(worldY) || !Number.isFinite(waterY)) return 1;
  return worldY < waterY ? 0 : 1;
}

/**
 * 有效湿强度 = `clamp(总强度 × 类增益 × 朝向权重, 0, 1) × 水下门`。
 * @param {number} strength 总开关 0..1
 * @param {number} up 面法线 y
 * @param {number} cls 材质类
 * @param {number} worldY @param {number} waterY
 * @returns {number} 0..1
 */
export function wetnessAt(strength, up, cls, worldY, waterY) {
  const p = WET_CLASS_PARAMS[cls];
  if (!p) return 0;
  const w = clamp01(strength * p[0] * wetOrientFactor(up));
  return w * wetAboveWaterGate(worldY, waterY);
}

/**
 * 湿表面粗糙度：类基值 + 竖面加成（钳 ≤1），再按积水程度往镜面拉。
 * @param {number} cls @param {number} up @param {number} puddle 0..1
 * @returns {number} 0..1
 */
export function wetRoughnessAt(cls, up, puddle) {
  const p = WET_CLASS_PARAMS[cls];
  if (!p) return 1;
  const base = Math.min(p[2] + (up > 0.5 ? 0 : WET_WALL_ROUGH_ADD), 1);
  return base * lerp(1, WET_PUDDLE_ROUGH_K, clamp01(puddle));
}

/**
 * 积水门：粗糙面不积水（水被吸走 / 散开）。
 * @param {number} rough 已含竖面加成的粗糙度
 * @returns {number} 0..1
 */
export function puddleAllowed(rough) {
  return 1 - smoothstep(WET_PUDDLE_ROUGH_GATE.from, WET_PUDDLE_ROUGH_GATE.to, rough);
}

/**
 * 菲涅尔反射率（Schlick，F0 由粗糙度派生）。
 * @param {number} noV 法线·视线 @param {number} rough
 * @returns {number} F0..1
 */
export function wetFresnel(noV, rough) {
  const f0 = WET_FRESNEL_F0_BASE + WET_FRESNEL_F0_RANGE * (1 - clamp01(rough));
  return f0 + (1 - f0) * Math.pow(1 - clamp01(noV), 5);
}

/**
 * Blinn-Phong 高光锐度（粗糙 ⇒ 散）。
 * @param {number} rough @returns {number} min..max
 */
export function wetShininess(rough) {
  const k = Math.pow(1 - clamp01(rough), 3);
  return WET_SHININESS.min + (WET_SHININESS.max - WET_SHININESS.min) * k;
}

/**
 * 天空环境的混合因子：按**反射方向**的 y 在「地平线色 ↔ 天顶色」之间插值。
 *
 * ⚠️ 这是「反光照向天空」的几何正确表达 —— 与上游「把世界点压平到镜面高度再投影」
 * 完全不同：后者只对镜面那一层成立，墙面/云层必然错位（spec §2.1/§2.2）。
 * 本式对**任何朝向任何高度**的面都成立，且不采样任何 RT。
 *
 * @param {number} ry 反射方向单位向量的 y
 * @param {number} rough 粗糙度（越大带宽越宽 ⇒ 过渡越缓）
 * @returns {number} 0 = 地平线色；1 = 天顶色
 */
export function skyEnvMixAt(ry, rough) {
  const r = clamp01(rough);
  const lo = lerp(WET_SKY_BAND.loNear, WET_SKY_BAND.loFar, r);
  const hi = lerp(WET_SKY_BAND.hiNear, WET_SKY_BAND.hiFar, r);
  return smoothstep(lo, hi, ry);
}

/**
 * 反光强度系数（积水处更强，钳 ≤1）。
 * @param {number} cls @param {number} puddle @returns {number} 0..1
 */
export function wetSpecGainAt(cls, puddle) {
  const p = WET_CLASS_PARAMS[cls];
  if (!p) return 0;
  return Math.min(p[3] * lerp(1, WET_PUDDLE_SPEC_K, clamp01(puddle)), 1);
}

/**
 * 湿 albedo 乘数（积水处再压暗）。
 * @param {number} cls @param {number} puddle @returns {number} 0..1
 */
export function wetDarkenAt(cls, puddle) {
  const p = WET_CLASS_PARAMS[cls];
  if (!p) return 1;
  return p[1] * lerp(1, WET_PUDDLE_DARK_K, clamp01(puddle));
}

// 类枚举再导出一次：消费方（TSL 侧 / 单测）只 import 本文件即可拿到全套。
export { WET_CLASS, WET_CLASS_COUNT };