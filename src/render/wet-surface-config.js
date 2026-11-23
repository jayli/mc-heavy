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
import { SHELTER_Y_BASE, SHELTER_EPS } from '../voxel/rain-occlusion-data.js';

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

/**
 * 反光的**非物理地板**（v3.31，用户 2026-11-22 裁定「加非物理地板，反光明显」）。
 *
 * ## 为什么需要它（扇描实测，不是口味）
 *
 * Schlick 菲涅尔在半俯视（noV≈0.53）时 F≈**0.068** —— 物理上湿石头在该角度
 * 只反射约 7% 的光。用真实 atlas 基色（Smooth_Stone 线性 luma 0.3816）
 * 与正午天空色（0x87ceeb 线性 luma 0.5529）算，抛光石的 Δluma 只有 **1.46**
 * （sRGB 0~255）—— 8bit 量化 + ACES 后屏幕上分不开。
 * 设计稿 §6.1b 的三个旋钮全扇描完（MAX 0.55→1.0 / 菲涅尔幂 5→3 /
 * F0 基数 0.02+0.04→0.04+0.16）最强也只 **3.81**，低于目标带下界 **6**。
 * ⇒ 用户裁定加地板（偏离物理，换「看得见的地面湿滑反光」）。
 *
 * ## 为什么地板必须随粗糙度衰减
 *
 * `floor = WET_REFL_FLOOR × (1 − rough)` —— 否则布/植被也会反光，
 * 材质分层就没了（用户明确否决「只有一种反光材质」）。
 * 实测（noV 0.53）：抛光 Δluma **6.19** vs 布 **0.06** ⇒ 差 100 倍。
 *
 * ⚠️ 取值 0.28 是**扇描选定的最小入带档**（0.06/0.10/0.14/0.20/0.28 中
 * 第一个让抛光 ≥6 的），不动既有 `WET_REFL_MAX`。
 * ⚠️ 地板只加在 **F** 上，不突破 `WET_REFL_MAX` 的总上限
 * ⇒ reflK 恒 ≤ 0.55 < 1 ⇒ `mix` 仍天然有界，不会钳白（由单测的全组合扫描钉住）。
 */
export const WET_REFL_FLOOR = 0.28;

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
 * 积水的**镜面反光目标**（v3.32，用户 2026-11-23「水汪没有反光，适当加一些反光」）。
 *
 * ## 为什么必须是「绝对目标」而不是又一个乘数（本轮根因，实测取证）
 *
 * v3.31 的积水修正只有 `rough×0.25` / `specGain×1.60` / `albedo×0.88` 三项，
 * 反光强度仍走同一条 `reflK = (F+floor)×specGain×WET_REFL_MAX×wet`。
 * 而 **`wetSpecGainAt` 被 `min(…,1)` 钳死**，抛光/冰类的 specGain 本来就是 **1.0**
 * ⇒ `×1.60` 后仍是 1.0，**一点没涨**；只有 rough 变小带来的 F0/floor 微增。
 * 实测（noV 0.53、真实 atlas 基色）：抛光 reflK **0.1883 → 0.1962（+4%）**，
 * 却额外压暗 12% ⇒ 屏幕上水汪比周边水膜**暗 5.9 luma**（石材暗 3.0）。
 * GPU 侧交叉验证：开档后地面区 mean luma 181.58 → 178.32（净变暗），方向一致。
 * ⇒ 积水必须有一条**独立于菲涅尔的绝对镜面目标**。
 *
 * ## 为什么不能改 WET_REFL_MAX / FLOOR / SUN_SPEC
 *
 * · 抬 MAX/FLOOR 会让**整片湿墙**一起变亮 ⇒ 用户 2026-11-22 报的岩壁光晕缺陷复活；
 * · 抬 `WET_SUN_SPEC` 对水汪**零作用**：积水处 rough 0.0875 ⇒ shininess **320.6**，
 *   该机位 N·H 0.677 ⇒ `pow(0.677, 320.6)` = **4.94e-55**（它是掠射角才可见的项）。
 *
 * ## 取值 0.70 的扇描依据（代入**真实掩码峰值 0.7682**，不是 1.0）
 *
 * Δ = 积水 − 水膜的屏幕 luma（noV 0.53、BASE 0.3816、SKY 0.5529）：
 *   MIRROR 0.65 → 抛光 +14.0 / 石 +11.3 / 木 +6.7 / 土 +5.2 / 布 −2.4
 *   MIRROR 0.70 → 抛光 **+15.8** / 石 +12.7 / 木 +7.7 / 土 +6.0 / 布 **−2.2**
 *   MIRROR 0.80 → 抛光 +19.5 / 石 +15.4 / 木 +9.7 / 土 +7.6 / 布 −1.8
 *   MIRROR 1.00 → 抛光 +26.6 / 石 +20.6 / 木 +13.6 / 土 +10.9 / 布 −0.8
 * 取 0.70：抛光落在目标带 [12,28] 中段、布仍几乎不变（材质分层保住），
 * 且 reflK 全组合上界 **0.70 < 1** ⇒ `mix` 天然有界，不会钳白。
 *
 * ⚠️ 掩码峰值 0.7682 是 GPU 实测（绕开 ACES 直接量 puddle）：
 * `smoothstep(0.52,0.76,n)` 而噪声 n 的 p95 才 0.753 ⇒ **按 p=1 标定会高估 26%**。
 *
 * ## v3.32b：幅度减半（用户 2026-11-23「上一版本的积水增量的幅度减半」）
 *
 * **0.70 → 0.44**。⚠️ 基准是 **v3.31（`uWetPuddleRefl = 0`）的水汪亮度**，
 * 不是「水汪相对周边水膜的总差」—— 用户说的是本轮引入的**增量**。
 * 两者相差很大（v3.31 的水汪比水膜还暗）：抛光总差 15.85 而本轮增量 **20.37**。
 * 取错基准会调成 0.50（总差减半）而不是 0.44。
 *
 * 实测（noV 0.53、p=0.7682）与扇描：
 *   类        v3.31    M=0.70   增量    目标(半)   M=0.44 实得
 *   POLISHED  156.82   177.20   20.37   10.19      10.30
 *   STONE     143.96   159.15   15.19    7.59       7.94
 *   WOOD      143.41   154.67   11.26    5.63       5.92
 *   SOIL      131.37   140.85    9.48    4.74       5.08
 *   FABRIC    121.62   124.29    2.67    1.33       1.45
 * MIRROR 扇描 0.40 / 0.42 / 0.44 / 0.46 / 0.48 对「目标增量」的 RMS 误差
 *   = 0.821 / 0.334 / 0.263 / 0.735 / 1.231 ⇒ 0.44 最优。
 */
export const WET_PUDDLE_MIRROR = 0.44;

/**
 * 水汪内天空环境的**云影调制幅度**（±12.5%，v3.32b 减半后）。
 *
 * ## 为什么需要它
 *
 * 积水处 rough → 0.015 ⇒ 天空渐变带宽极窄（lo −0.155 / hi 0.557），
 * 而正午 `sky` 与 `fogColor` **同为 0x87ceeb**（v3.31 §7.3）
 * ⇒ `skyEnv` 在整个水汪内几乎是同一个颜色。只抬 reflK 会得到一片**纯色塑料板**。
 * 真实水汪反的是阴天云层（有明暗层次）⇒ 给天空环境加一层低频噪声调制。
 *
 * 扇描（水汪内 luma 跨度，amp 已 × puddle）：
 *   0.20 → 抛光 span 17.9 / 石 11.4
 *   0.25 → 抛光 **22.4** / 石 **14.3**
 *   0.30 → 抛光 27.0 / 石 17.1
 * 取 0.25：落在 [12,36]，肉眼有层次但不花。
 *
 * ## v3.32b：**0.25 → 0.125**（用户 2026-11-23 裁定幅度减半）
 *
 * 云影也是本轮引入的增量 ⇒ 同步减半，否则「亮度降了但层次还是那么花」。
 * M=0.44 固定下扇描 CLOUD：0.25→span 15.89 / 0.16→10.16 / **0.125→7.94** / 0.10→6.35。
 * 取 0.125（常量语义上就是减半）得 span **7.94**，仍在「有层次」带 [6,18] 内。
 * ⚠️ M 与 CLOUD 同时降 ⇒ span 双重衰减，故 7.94 低于「原 22.44 的一半 11.22」；
 * 这是两个旋钮都减半的必然结果，不是标定错。
 *
 * ⚠️ 上界 1.125 ⇒ skyEnv 线性 luma 最大 0.6220，配 reflK 0.44
 * ⇒ 全组合最大线性 luma 远低于过曝线（Tier 4 用例③仍守）。
 */
export const WET_PUDDLE_CLOUD = 0.125;

/**
 * 云影噪声的世界 xz 尺度（0.09 ⇒ 斑块 ≈11 格，比积水斑大 3.5 倍）。
 * ⚠️ **必须比 `WET_PUDDLE_SCALE` 小**（= 斑块更大）：否则每摊水自带一个亮斑，
 * 看起来像「水汪在发光」而不是「水汪映着天上的云」。
 */
export const WET_PUDDLE_CLOUD_SCALE = 0.09;

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
 * 反光地板项（随粗糙度衰减）。
 * @param {number} rough @returns {number} 0..WET_REFL_FLOOR
 */
export function wetReflFloor(rough) {
  return WET_REFL_FLOOR * (1 - clamp01(rough));
}

/**
 * 天空环境的混合系数 `reflK` —— **反光的唯一强度入口**。
 *
 * `reflK = (F + floor(rough)) × specGain × WET_REFL_MAX × wet`
 *
 * ⚠️ 恒 ≤ `WET_REFL_MAX` < 1：因为 F ≤ 1、floor ≤ 0.28、specGain ≤ 1、wet ≤ 1
 * ⇒ 乘积上限 = (1+0.28)×1×0.55×1 = 0.704？**不是** —— F 与 floor 不会同时取最大：
 * F 在 rough→0 时最大（0.06）而 floor 也在 rough→0 时最大（0.28），
 * 故上限 = (0.06+0.28)×1×0.55 = 0.187（noV→0 时 F→1 ⇒ (1+0.28)×0.55 = 0.704）。
 * 两者都 < 1 ⇒ `mix(albedo, skyEnv, reflK)` 恒在两端之间，**不会钳白**。
 * 由 `test-wet-surface.js` 的全组合扫描（9 类 × 3 朝向 × 2 积水 × 5 noV）钉住。
 *
 * @param {number} noV 法线·视线
 * @param {number} rough 已含竖面加成与积水修正的粗糙度
 * @param {number} specGain 类镜面系数（已含积水修正）
 * @param {number} wet 有效湿强度
 * @returns {number} 0..WET_REFL_MAX
 */
export function wetReflK(noV, rough, specGain, wet) {
  const f = wetFresnel(noV, rough) + wetReflFloor(rough);
  return Math.min(f * specGain * WET_REFL_MAX * clamp01(wet), WET_REFL_MAX);
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

// ------------------------------------------------ v3.32 积水斑的镜面反光
//
// 设计稿：docs/superpowers/specs/2026-11-23-puddle-mirror-reflection-design.md
// TSL 侧在 wet-surface.js，两侧公式**逐项同构**（红线 1）。

/**
 * 朝向门：**水汪镜面只在朝上面**（顶面 1 / 侧面与底面 0）。
 *
 * ⚠️⚠️ **这条是岩壁光晕缺陷的直接防线**：`puddleAllowed` 只看粗糙度，
 * 而竖面加成后的 rough0 对 POLISHED/STONE/METAL/ICE 分别是
 * 0.31/0.60/0.37/0.29 ⇒ 门值 **1.0/0.896/1.0/1.0**（实测）
 * ⇒ 没有这道门，水汪镜面会**爬上墙**，正是用户 2026-11-22 报的缺陷。
 * v3.31 的 `puddle` 在 TSL 里已乘 `select(isTop,1,0)`，本函数把同一口径显式化，
 * 让 CPU 侧也能单独求值与断言。
 */
function puddleTopGate(up) {
  return Number.isFinite(up) && up > 0.5 ? 1 : 0;
}

/**
 * 积水的镜面反光**目标值**（不是乘数 —— 见 `WET_PUDDLE_MIRROR` 的根因注释）。
 *
 * `mirrorK = MIRROR × specGain(含积水修正) × wet × topGate × reflStrength`
 *
 * ⚠️ `specGain` 在这里是**分层旋钮**（抛光 1.0 / 石 0.72 / 土 0.288 / 布 0.064），
 * 不是「再抬一档」的乘数 —— 它决定各类能反多少，而 MIRROR 是绝对上限。
 *
 * @param {number} cls 材质类
 * @param {number} puddle 积水程度 0..1（真实峰值 0.7682）
 * @param {number} wet 有效湿强度（`wetnessAt` 的结果）
 * @param {number} up 面法线 y
 * @param {number} reflStrength 积水反光开关强度 0..1（0 ⇒ 逐位回到 v3.31）
 * @returns {number} 0..WET_PUDDLE_MIRROR
 */
export function wetPuddleMirrorK(cls, puddle, wet, up, reflStrength) {
  const sg = wetSpecGainAt(cls, puddle);
  return WET_PUDDLE_MIRROR * sg * clamp01(wet) * puddleTopGate(up)
    * clamp01(puddle) * clamp01(reflStrength);
}

/**
 * 最终反光系数 = **水膜项与积水镜面项的 mix**。
 *
 * `reflK = min(mix(wetReflK(...), MIRROR×specGain×wet, puddle×topGate×strength), 1)`
 *
 * ⚠️⚠️ **混合权重必须也乘 topGate × strength**：只把 `mirrorK` 乘门是不够的 ——
 * `mix(filmK, 0, puddle)` 会让水汪**变暗**而不是回到水膜，
 * 于是「strength=0 ⇒ 逐位回到 v3.31」这条零回归锚点静默失效。
 *
 * ⚠️ 水膜项 `wetReflK` **逐字不动**（仍受 `WET_REFL_MAX = 0.55` 钳制）；
 * 只有积水项能超过 0.55，上界 `WET_PUDDLE_MIRROR = 0.70 < 1` ⇒ mix 有界。
 *
 * @param {number} noV 法线·视线
 * @param {number} cls @param {number} up @param {number} puddle
 * @param {number} wet @param {number} reflStrength
 * @returns {number} 0..1
 */
export function wetPuddleReflK(noV, cls, up, puddle, wet, reflStrength) {
  const p = clamp01(puddle);
  const rough = wetRoughnessAt(cls, up, p);
  const sg = wetSpecGainAt(cls, p);
  const filmK = wetReflK(noV, rough, sg, wet);
  const w = p * puddleTopGate(up) * clamp01(reflStrength);
  const mirrorK = WET_PUDDLE_MIRROR * sg * clamp01(wet);
  return Math.min(lerp(filmK, mirrorK, w), 1);
}

/**
 * 水汪内天空环境的云影乘数：`1 + cloud × CLOUD × puddle × topGate × strength`。
 *
 * ⚠️ `cloud` 是 `mx_noise_float` 的**原始值域 [−1,1]**（不是 0..1 的积水噪声）——
 * 云影要有明有暗，取 0..1 只会整体抬亮。
 * ⚠️ 只调制**水汪**（× puddle）且只在**朝上面**：墙面与云的天空环境逐位不动。
 *
 * @param {number} cloud 噪声原始值 −1..1
 * @param {number} puddle @param {number} up @param {number} reflStrength
 * @returns {number} 1−CLOUD .. 1+CLOUD
 */
export function wetPuddleSkyMul(cloud, puddle, up, reflStrength) {
  const c = Number.isFinite(cloud) ? Math.max(-1, Math.min(1, cloud)) : 0;
  const w = clamp01(puddle) * puddleTopGate(up) * clamp01(reflStrength);
  return 1 + c * WET_PUDDLE_CLOUD * w;
}

// 类枚举再导出一次：消费方（TSL 侧 / 单测）只 import 本文件即可拿到全套。
export { WET_CLASS, WET_CLASS_COUNT };

// ------------------------------------------------ v3.34 逐点遮挡门
//
// 设计稿：docs/superpowers/specs/2026-11-23-rain-per-point-shelter-design.md §4.6
// TSL 侧在 wet-surface.js，两侧公式**逐项同构**（红线 1）。

/** 解码时的 f32 量化 scratch（与 GPU 的 8bit 归一化 + f32 算术逐位同构）。 */
const _encF32 = new Float32Array(1);

/**
 * 遮挡门：该探针是否被头顶的屋顶挡住雨。
 *
 * ⚠️⚠️ **判据是「截停面严格高于探针所在格的格顶」**，不是 `probeY <= stopY`：
 * `stopY` 是**格顶**（y+1，与既有 rainShelterY 同源），而探针落在**几何顶面**外半格。
 * 对整格方块两者恰好差 0.5，但对**非整格顶面**的方块会共面：
 *   · 三款 slab / 床：几何顶面 0.5 ⇒ 探针 1.0，stop=1 ⇒ `probe<=stop` 成立
 *     ⇒ **露天半砖永远不湿**（静默缺陷）；
 *   · horizontal_pillar 0.65 同理。
 * 格顶口径把「自身格表面」从「遮挡」里结构性地排除 ⇒ 屋顶自身顶面也正确判湿。
 *
 * ⚠️ **解码必须显式走一遗 f32 量化**（`Float32Array(enc/255)` 再 `×127.5`）：
 * GPU 侧读的是 8bit 归一化后的 f32，直接用 `enc/2` 会与 GPU 差最多 3.78e-6。
 *
 * @param {number} probeY 探针世界 y（= 片元 y + 法线 y × 0.5）
 * @param {number} stopEnc R 通道编码（0 = 未知/无截停面）
 * @param {number} strength `uWetShelter` 0..1（0 ⇒ 逐位回到 v3.33，第四级零回归锚点）
 * @returns {number} 1 = 可湿；0 = 被遮挡（干）
 */
export function wetShelterGate(probeY, stopEnc, strength) {
  if (!(stopEnc > 0)) return 1;                 // 未知 ⇒ 安全失败（不遮挡）
  if (!(strength > 0)) return 1;                // 关档 ⇒ 逐位回到改动前
  _encF32[0] = stopEnc / 255;
  const stop = _encF32[0] * (255 / 2) + SHELTER_Y_BASE;
  const cellTop = Math.floor(probeY) + 1 + SHELTER_EPS;
  return stop > cellTop ? 1 - strength : 1;
}