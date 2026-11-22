// src/render/wet-ground-config.js — 雨天「地面湿滑与反光」的标定常数（**three-free**）
//
// 上游：`bj-shooting-game/night-heron-src/src/gfx/shaders.js` 的 `GROUND_FRAG`
// （puddle / film / rippleLayer / fresnel / planar reflection）与 `LIT_FRAG` 的
// rain wetness 段（albedo 压暗 + roughness 降低 + 竖直流水纹）。
//
// ## 本仓的落地方式与上游的差别（**这是必要的架构适配，不是观感改动**）
//
// 上游有一张**独立的地面 mesh**（`makeGround`），湿地面效果全写在它的片元里。
// 本仓的地面就是**体素本身**（BatchedMesh 三通道，红线 4/5：禁止第二份地形几何）
// ⇒ 不能新建地面 mesh。故把同一套效果做成**体素 opaque/cutout 材质的一个可开关分支**：
//   · 压暗 + 降粗糙度（上游 albedo × mix(1, 0.6, wet) 与 roughness 降低）；
//   · 朝上面更强（上游 `up = max(N.y, 0)`）；
//   · 竖直流水纹（上游 flowN 噪声）；
//   · 水膜涟漪扰动法线（上游 rippleLayer 两层）；
//   · **平面反射**（复用既有 `reflector` 管线，见下）。
//
// ## 反射为什么复用既有 reflector 而不是新建一个
//
// 本仓已有一条水面反射管线（`ocean.js` 的 `reflector()` + `Game._renderWaterReflection`），
// 它已解决三个硬问题：
//   ① **必须在主 render 之前手动跑**（否则 BatchedMesh 的 indirect 索引表被反射相机覆写
//      ⇒ 天空整片撕成黑多边形，v3.17 实测）；
//   ② 反射期间要临时藏掉第一人称物件与各特效池（成本主杠杆是 draw call 数）；
//   ③ 节流 + 可见性门 + 高度衰减（成本从每帧 +0.93ms 降到每 2 帧 +0.36ms）。
// 新建第二个 reflector 会把这三个问题**再踩一遍**，且两条反射 pass 会互相覆写索引表。
// ⇒ **共用同一条 pass**：湿地面与水面读同一个 RT，只是采样坐标与强度不同。
//
// ⚠️ **代价与取舍**：既有 reflector 的镜面高度是 `WATER_LEVEL_OFFSET`（−1.5），
// 而地面高度随地形起伏。故湿地面的反射是**近似**（以海平面为镜面的投影），
// 在高处地面上会有偏移。这是「复用一条 pass」的必然代价，用户口径是
// 「重点是地面上湿滑和反光的效果」——观感上要的是「地面映出周围景物」，
// 而不是逐格精确的镜面。偏移由 `WET_REFLECT_DISTORT` 的扰动进一步柔化。
//
// ⚠️ 本文件不 import three（Node 单测直接读）。

/**
 * 湿度总开关强度（0 = 完全干，逐位回到未开启时的体素材质；1 = 全湿）。
 * 由装配层按「雨天光影档开启 ∧ 当前在下雨」写入。
 */
export const WET_STRENGTH_MAX = 1.0;

/**
 * 朝上面的湿度权重（上游 `wet = uWet * (0.3 + 0.7*up + 0.55*streak)`）。
 * ⚠️ 三项相加可 > 1，上游用 clamp(0,1) —— 本仓同口径。
 */
export const WET_UP_BASE = 0.3;
export const WET_UP_GAIN = 0.7;
export const WET_STREAK_GAIN = 0.55;

/**
 * 竖直流水纹（上游 `flowN = noise(vec2(dot(xz,(0.83,0.71))*0.55, y*0.045 − t*0.03)).g`，
 * `streak = smoothstep(0.42, 0.72, flowN)`）。
 */
export const WET_FLOW_DIR = Object.freeze([0.83, 0.71]);
export const WET_FLOW_SCALE = 0.55;
export const WET_FLOW_Y_SCALE = 0.045;
export const WET_FLOW_SPEED = 0.03;
export const WET_FLOW_FROM = 0.42;
export const WET_FLOW_TO = 0.72;

/**
 * 多孔材质的压暗（上游 `albedo *= mix(1.0, 0.6, wet*porous)`）。
 * ⚠️ 本仓体素没有 roughness/metalness 维数据 ⇒ 「porous」用**朝上面 + 非玻璃**近似：
 * 体素世界里绝大多数方块都是多孔的（石/土/木/砖），只有玻璃/水不是。
 * 而玻璃与水走 transparent 通道，本分支只挂 opaque/cutout ⇒ 天然全是多孔材质。
 */
export const WET_ALBEDO_DARKEN = 0.6;

/**
 * 水膜涟漪（上游 `rippleLayer`：格子内随机相位的扩张圆环，两层叠加）。
 *
 * 上游参数逐字：
 *   layer1: wuv*2.3, t,       seedOffset 0
 *   layer2: wuv*3.7 + 11.3, t*1.13, seedOffset 5
 *   ph = fract(t*(0.75+0.6*h.z) + h.x*9)
 *   d  = f − (h.xy−0.5)*0.44
 *   R  = ph*0.27
 *   w  = sin((r−R)*70) * smoothstep(0.05,0,|r−R|) * (1−ph)²
 *   nxy += rip * (0.05 + 0.3*puddle) * rfade
 *   rfade = smoothstep(26, 8, camDist)
 */
export const WET_RIPPLE = Object.freeze({
  scaleA: 2.3,
  scaleB: 3.7,
  offsetB: 11.3,
  speedB: 1.13,
  seedB: 5.0,
  rateMin: 0.75,
  rateRange: 0.6,
  phaseGain: 9.0,
  centerJitter: 0.44,
  radiusGain: 0.27,
  waveFreq: 70.0,
  bandWidth: 0.05,
  /** 扰动幅度（上游 `0.05 + 0.3*puddle`；本仓 puddle 恒取 WET_PUDDLE） */
  ampBase: 0.05,
  ampPuddle: 0.3,
  /** 距离衰减（上游 smoothstep(26, 8, dist)：近处全额、26 格外归零） */
  fadeNear: 8,
  fadeFar: 26,
});

/**
 * 积水程度（上游 `uPuddle`，各地面材质不同：0.5 是通用值）。
 * 本仓体素无材质分类 ⇒ 取通用 0.5，并由噪声在空间上分出「积水/水膜」两档。
 */
export const WET_PUDDLE = 0.5;

/**
 * 反射强度（上游 `col += refl * fres * (1 − 0.45*prough)`）。
 *
 * ⚠️ **本仓取值比上游小**：上游地面是独立 mesh、反射 RT 是**专门为它渲的**
 * （藏掉全部 groundMeshes）；本仓复用水面那条 RT，里面含水面自己 ⇒ 直接全强度会
 * 出现「地面映出水面、水面又映出地面」的互反射亮斑。取 0.35 作上限（实测标定见 spec）。
 */
export const WET_REFLECT_STRENGTH = 0.35;

/**
 * 反射的菲涅尔（上游 `f0 = mix(0.05, 0.1, puddle)`，
 * `fres = f0 + (max(1−prough, f0) − f0) * pow(1−NoV, 4)`）。
 */
export const WET_FRESNEL_F0 = 0.05;
export const WET_FRESNEL_F0_PUDDLE = 0.1;
export const WET_FRESNEL_POWER = 4.0;

/**
 * 反射采样坐标的扰动（上游 `ruv += vec2(across*0.12, along*0.42)*(1−0.6*puddle)`）。
 * ⚠️ 沿视线方向的拉伸更大（0.42 vs 0.12）⇒ 读作「竖直的长条反光」而不是镜面。
 */
export const WET_REFLECT_DISTORT_ACROSS = 0.12;
export const WET_REFLECT_DISTORT_ALONG = 0.42;
export const WET_REFLECT_DISTORT_PUDDLE_K = 0.6;

/** 反射采样的 mip 级别（上游 `textureLod(uRefl, ruv, prough*7)`；本仓固定 2 = 朦胧） */
export const WET_REFLECT_MIP = 2;

/**
 * 湿地面只在**朝上的面**生效（法线 y 阈值）。
 * 上游用连续的 `up = max(N.y,0)`；本仓体素面法线是六个轴向之一 ⇒ 只有 +Y 面 up=1。
 * ⚠️ 侧面与底面**完全不湿**（up=0 ⇒ wet = uWet*0.3 仍有轻微压暗，那是上游口径）。
 */
export const WET_UP_EPS = 0.5;

/**
 * 湿度 → 有效强度的纯函数（上游 clamp 口径）。
 * @param {number} strength 0..1（总开关）
 * @param {number} up 面法线 y（0..1）
 * @param {number} streak 流水纹 0..1
 * @returns {number} 0..1
 */
export function wetnessAt(strength, up, streak) {
  const w = strength * (WET_UP_BASE + WET_UP_GAIN * Math.max(0, up) + WET_STREAK_GAIN * streak);
  return Math.max(0, Math.min(1, w));
}

/**
 * 涟漪的距离衰减（上游 `smoothstep(26, 8, dist)` 的 CPU 同构）。
 * @param {number} dist 格
 * @returns {number} 0..1（近处 1、远处 0）
 */
export function wetRippleFade(dist) {
  const { fadeNear, fadeFar } = WET_RIPPLE;
  const t = Math.max(0, Math.min(1, (dist - fadeFar) / (fadeNear - fadeFar)));
  return t * t * (3 - 2 * t);
}

/**
 * 菲涅尔反射率（上游同式）。
 * @param {number} noV 法线·视线（0..1）
 * @param {number} rough 粗糙度 0..1
 * @param {number} puddle 积水程度 0..1
 * @returns {number}
 */
export function wetFresnel(noV, rough, puddle = WET_PUDDLE) {
  const f0 = WET_FRESNEL_F0 + (WET_FRESNEL_F0_PUDDLE - WET_FRESNEL_F0) * puddle;
  const hi = Math.max(1 - rough, f0);
  return f0 + (hi - f0) * Math.pow(1 - Math.max(0, Math.min(1, noV)), WET_FRESNEL_POWER);
}