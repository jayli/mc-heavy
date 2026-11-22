// src/render/wet-surface.js — 雨天「按材质分类的湿表面」TSL 分支（v3.31）
//
// 设计稿：docs/superpowers/specs/2026-11-22-wet-surface-rebuild-design.md §6
// 常量与 CPU 同构纯函数：`wet-surface-config.js`（three-free，可 Node 单测）
// 材质分类：`voxel/wet-material-data.js` → `registry.wetClassTable` → mesher 写 packed bit15–18
//
// ## 与上游 bj-shooting-game 的关系：**零关系**（用户 2026-11-22 裁定从零实现）
//
// 上游那套 GROUND_FRAG 服务的是一张**独立地面 mesh**，地面就在镜面高度 y=0，
// 所以它的「把世界点压平到镜面再投影」是 no-op。挂到本仓体素通道后三处同时错
// （实测取证见 spec §2）：
//   ① 墙侧面 wet 实测 0.85（不是注释说的「完全不湿」）；
//   ② 流水纹沿 y 的空间频率只有 xz 的 1/12.2 ⇒ 竖直长条亮带；
//   ③ 反射投影只对镜面那一层成立 ⇒ 墙面/云层采到别处内容（天空暖白）。
// 加上云走 opaque 通道吃满强度湿分支 + 屏幕空间体积雾 + bloom 放大
// ⇒ 用户截图里的岩壁亮带与高空云层光晕。
//
// ## 本实现的三条核心决定
//
// ① **不采样任何反射 RT**：反光反的是「按反射方向在既有雾色↔天顶色之间插值」的
//    程序化天空 + 弱 Blinn-Phong 太阳高光。对**任何朝向任何高度**的面都几何正确，
//    `?skybox=0` 也成立（那是全部既有 Tier 4 spec 的口径），零额外 render pass。
// ② **按材质分类**：九类各一组 (wetGain, darken, rough, specGain)，
//    顶点阶段查 uniform 数组得逐 quad 常量 vec4，经一个 varying 传片元。
// ③ **反光用 `mix` 不用 `add`**：`mix(albedo, skyEnv, reflK)` 在 reflK ≤ 1 时天然有界，
//    不会像上游的加项那样在亮端钳白（本仓 ocean 已实测过加法钳白）。
//
// ## 七条 TSL 口径（本仓已实测的教训，逐条遵守）
//   ① 节点不与裸 JS 数字算术，一律 `.mul()/.add()/.sub()/.div()`；
//   ② 常量色**显式拆分量**（`vec3(Color)` 在 WebGPU 静默输出纯黑）；
//   ③ 多层 mix **嵌套**，不链式 `.mix()`（链式会毁颜色）；
//   ④ 径向量（V/R/H/NoV）全在**片元**算 —— 体素 quad 只有 4 顶点，
//      顶点算 length/dot 插值后恒为常数（整片 quad 一起亮再一起消失）；
//   ⑤ 不用 `.toVar()/.assign()` —— 本函数在 `makeMaterial` 里**直接调**（不在 `Fn()` 体内），
//      TSL 的 assign 要求当前有 stack ⇒ 报 `No stack defined`，而画面照常渲染（静默）；
//   ⑥ 反向 smoothstep 写 `oneMinus(smoothstep(lo,hi,x))`；
//   ⑦ 噪声用 `mx_noise_float`（连续），**不用 `hash(floor(...))`**（会出轴对齐矩形斑）。
import * as THREE from 'three';
import {
  float, vec2, vec3, uniform, uniformArray, attribute, varying, vertexStage,
  mix, max, min, mul, add, sub, dot, pow, clamp, normalize, smoothstep, oneMinus,
  step, select, reflect, mx_noise_float as perlin,
  positionWorld, cameraPosition,
} from 'three/tsl';
import {
  WET_CLASS_PARAMS, WET_CLASS_COUNT,
  WET_WALL_FACTOR, WET_WALL_ROUGH_ADD, WET_REFL_MAX, WET_SUN_SPEC,
  WET_PUDDLE_SCALE, WET_PUDDLE_FROM, WET_PUDDLE_TO,
  WET_PUDDLE_ROUGH_K, WET_PUDDLE_DARK_K, WET_PUDDLE_SPEC_K, WET_PUDDLE_ROUGH_GATE,
  WET_SKY_BAND, WET_FRESNEL_F0_BASE, WET_FRESNEL_F0_RANGE, WET_SHININESS,
} from './wet-surface-config.js';
import { WATER_SURFACE_Y } from './water-surface.js';

/** packed 里材质类位的偏移与掩码（唯一权威在 mesher 的 WET_CLASS_SHIFT，两处必须一致）。 */
const WET_CLASS_SHIFT = 15;
const WET_CLASS_MASK = 0xF;

/**
 * 湿表面的 uniform（**模块级单例**，与 `uSkyDim` / `uSunDirection` 同手法）。
 *
 * ⚠️ 恒创建（即使雨天档未开启）：句柄存在 ⇒ 装配层无条件可写。
 * ⚠️ `uWet` 初值 **0** ⇒ 未接线时逐位等于原材质（零回归锚点，Tier 4 单变量 A/B 靠它）。
 * ⚠️ **不 freeze**：Tier 4 要能单变量替换成员（旧实现 freeze 过，导致装配层只能往
 *    `.value` 里 copy，绕了一圈；这里不需要那层限制）。
 */
export const WET_SURFACE_UNIFORMS = {
  /** 湿度总强度 0..1（装配层按「雨天档 ∧ 非室内」写） */
  uWet: uniform(0),
  /**
   * 水下门基准（世界 y）。逐片元判 `wp.y < uWetWaterY ⇒ 不湿`。
   * ⚠️ 不能只靠 CPU 的总强度：站在岸上看湖底是「相机在水上、片元在水下」。
   * ⚠️ 写成 uniform 而不是硬编码，是为了 Tier 4 能单变量把它推到极低（= 关门）做 A/B。
   */
  uWetWaterY: uniform(WATER_SURFACE_Y),
  /**
   * 地平线天空色 —— 由 `DayNight._apply` 写 `p.fogColor`（**既有风格数据**，红线 1）。
   * ⚠️ 是 Color：片元里必须显式拆 `.r/.g/.b`（口径②）。
   */
  uWetHorizon: uniform(new THREE.Color(0x87ceeb)),
  /** 天顶天空色 —— 由 `DayNight._apply` 写 `p.sky`（同上）。 */
  uWetZenith: uniform(new THREE.Color(0x87ceeb)),
  /**
   * 类参数表（每类一个 vec4 = wetGain/darken/rough/specGain）。
   *
   * ⚠️ `uniformArray` 走 uniform buffer 路径（WebGPU 的 storageBuffer 可用），
   * **不会退化成逐顶点属性** ⇒ 零顶点字节增量（那是本方案的硬约束，见 config 文件头）。
   * ⚠️ `updateType = RENDER` ⇒ 每帧自动重传，Tier 4 改 `.array[i]` 的分量后无需 needsUpdate。
   * ⚠️ 长度必须 = `WET_CLASS_COUNT`：短一项 ⇒ `.element(cls)` 越界读 0（整片材质静默退化）。
   */
  uWetParams: uniformArray(
    WET_CLASS_PARAMS.map((p) => new THREE.Vector4(p[0], p[1], p[2], p[3])), 'vec4',
  ),
};

/**
 * 造湿表面分支节点。
 *
 * @param {{baseRgb: object, faceNormal: object, skyDim: object, sunDirection: object,
 *          sunColor: object, shadowKill?: object|null}} deps
 *   `baseRgb`      原亮度项（texColor.rgb × shade，含自发光）
 *   `faceNormal`   面法线（packed bit10-12 解出的六选一，**已有节点**，不新增属性）
 *   `skyDim`       日夜天空亮度 uniform（复用 materials 的实例，不新建）
 *   `sunDirection` 太阳方向 uniform（同上）
 *   `sunColor`     直射色温 uniform（同上）
 *   `shadowKill`   太阳被阴影拿走的比例（0=影区 1=受光）；null ⇒ 恒 1（fixture 路径）
 * @returns {object} vec3 最终颜色
 */
export function createWetSurfaceNode({
  baseRgb, faceNormal, skyDim, sunDirection, sunColor, shadowKill = null,
}) {
  const U = WET_SURFACE_UNIFORMS;

  // ---- 顶点阶段：查类参数（逐 quad 常量 ⇒ 常量 vec4 插值逐位精确，片元零查表）----
  // ⚠️ 不在片元读 packed：three 对 int 类型 varying 强制 flat（已记教训）。
  // 虽然 flat 对常量恰好无害，但顶点查表更省一次片元位运算，且绕开那条坑。
  const packed = attribute('packed', 'uint');
  const cls = packed.shiftRight(WET_CLASS_SHIFT).bitAnd(WET_CLASS_MASK);
  const P = varying(vertexStage(U.uWetParams.element(cls)), 'vWetParams');

  const wp = positionWorld;
  const up = faceNormal.y;
  const isTop = up.greaterThan(0.5);
  const isBottom = up.lessThan(-0.5);

  // ---- 朝向权重：顶面 1 / 底面 0 / 侧面 WET_WALL_FACTOR ----
  // ⚠️ 这条是用户报告的岩壁亮带的直接防线（上游侧面 wet 实测 0.85）。
  const orient = select(isTop, float(1), select(isBottom, float(0), float(WET_WALL_FACTOR)));
  // 竖面水膜更薄更散 ⇒ 粗糙度加成
  const rough0 = min(add(P.z, select(isTop, float(0), float(WET_WALL_ROUGH_ADD))), float(1));

  // ---- 积水斑：只在朝上面，且材质足够致密（连续 perlin，不用 hash(floor) —— 口径⑦）----
  const nCoord = vec3(wp.x.mul(WET_PUDDLE_SCALE), wp.z.mul(WET_PUDDLE_SCALE), float(0));
  const n = perlin(nCoord).mul(0.5).add(0.5);
  const puddleGate = oneMinus(smoothstep(
    float(WET_PUDDLE_ROUGH_GATE.from), float(WET_PUDDLE_ROUGH_GATE.to), rough0));
  const puddle = smoothstep(float(WET_PUDDLE_FROM), float(WET_PUDDLE_TO), n)
    .mul(select(isTop, float(1), float(0)))
    .mul(puddleGate);

  const rough = rough0.mul(mix(float(1), float(WET_PUDDLE_ROUGH_K), puddle));
  const specGain = min(mul(P.w, mix(float(1), float(WET_PUDDLE_SPEC_K), puddle)), float(1));
  const darken = mul(P.y, mix(float(1), float(WET_PUDDLE_DARK_K), puddle));

  // ---- 有效湿强度（水下门乘在这里 ⇒ 压暗/反光/高光四项一起归零）----
  const aboveWater = step(U.uWetWaterY, wp.y);
  const wet = clamp(mul(mul(U.uWet, P.x), orient), float(0), float(1)).mul(aboveWater);

  // ---- 反光的「天空」：按反射方向 y 在雾色↔天顶色之间插值（口径②：显式拆分量）----
  const V = normalize(sub(cameraPosition, wp));
  const R = reflect(V.negate(), faceNormal);
  const bandLo = mix(float(WET_SKY_BAND.loNear), float(WET_SKY_BAND.loFar), rough);
  const bandHi = mix(float(WET_SKY_BAND.hiNear), float(WET_SKY_BAND.hiFar), rough);
  const horizon = vec3(U.uWetHorizon.r, U.uWetHorizon.g, U.uWetHorizon.b);
  const zenith = vec3(U.uWetZenith.r, U.uWetZenith.g, U.uWetZenith.b);
  const skyEnv = mix(horizon, zenith, smoothstep(bandLo, bandHi, R.y)).mul(skyDim);

  // ---- 菲涅尔（Schlick，F0 由粗糙度派生）----
  const noV = clamp(dot(faceNormal, V), float(0), float(1));
  const f0 = add(float(WET_FRESNEL_F0_BASE),
    mul(float(WET_FRESNEL_F0_RANGE), oneMinus(rough)));
  const fres = add(f0, mul(oneMinus(f0), pow(oneMinus(noV), 5)));

  // ---- 太阳高光（Blinn-Phong；雨天云遮日 ⇒ 总增益很弱；影区复用既有 shadowKill）----
  const H = normalize(add(sunDirection, V));
  const shin = add(float(WET_SHININESS.min),
    mul(float(WET_SHININESS.max - WET_SHININESS.min), pow(oneMinus(rough), 3)));
  const kill = shadowKill || float(1);
  const spec = pow(max(dot(faceNormal, H), float(0)), shin)
    .mul(specGain).mul(WET_SUN_SPEC).mul(kill);

  // ---- 合成：压暗 → **有界**混合天空 → 加一点点高光 ----
  // ⚠️ mix 不是 add（口径见文件头③）：reflK ≤ WET_REFL_MAX < 1 ⇒ 结果恒在
  // [albedo, skyEnv] 之间，不会在亮端钳白。
  const albedo = mul(baseRgb, mix(float(1), darken, wet));
  const reflK = mul(mul(fres, specGain), float(WET_REFL_MAX)).mul(wet);
  const withSky = mix(albedo, skyEnv, reflK);
  const lit = add(withSky, mul(vec3(sunColor.x, sunColor.y, sunColor.z), spec).mul(wet));

  // ⚠️ `uWet = 0` ⇒ wet=0 ⇒ albedo=baseRgb、reflK=0、spec 项乘 0
  //    ⇒ mix 取左端 ⇒ **逐位回到原色**（零回归锚点）。
  return mix(baseRgb, lit, U.uWet);
}

void [vec2, sub];