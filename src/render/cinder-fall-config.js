// src/render/cinder-fall-config.js — Cinder Fall 的观感常量（**three-free**）
//
// 与 `storm-lance-config.js` 同手法单独成模块：
//   ① Tier 1 单测能直接 import 它断言常量关系，**不必经过 three 的 GPU 初始化**；
//   ② 玩法量（半径/射程/池容量）从 `weapon-catalog.js` 派生，观感量在这里 ——
//      两边各写一份会漂移出「判定用的岩石与画出来的岩石不在同一处」（红线 1）。
//
// ## 数值来源：上游 `~/jaylli/LinearAbiltyCastingThreeJS` 的 `settings.meteor`
//
// Cinder Fall = `MeteorAbility.js` + `MeteorMaterial.js`（`ELEMENT_META.meteor.label`）。
// **零新增美术资源**：配色是常量，几何程序化，光晕是运行时 canvas 渐变。
//
// ## ⚠️ 三处按本仓口径重标（照抄会错，与 Storm Lance 同源）
//
// **① `toneMapped:false` 在 WebGPU 后端不存在** ⇒ 上游 `glow 0.75` / `crackGlow 2.2`
// 会被 ACES 削平。统一增益 `gain` 由 Tier 4 像素实测标定。
//
// **② 体积火焰 raymarch 不移植**：上游 `VolumetricFireMaterial` 是 35 步/像素的
// 黑体积分（833 行）。本仓换成**火球式径向渐变贴图 billboard**（用户 v3.20c 裁定
// 「就那样加就行，很简单，不要搞得太复杂」），零 shader。
//
// **③ 熔岩裂缝 / 焦痕 / 动态光 / 震屏闪白不移植**（用户既有裁定）。
import { WEAPONS } from '../player/weapons/weapon-catalog.js';
import { FIREBALL_HALO_SCALE } from './fireball-renderer.js';

const CF = WEAPONS.sword.cinderFall;

/**
 * 观感常量（冻结，渲染层不得改写）。
 */
export const CINDER_FX = Object.freeze({
  // ---- 玩法派生（唯一权威在 weapon-catalog）----
  radius: CF.radius,
  spin: CF.spin,
  poolSize: CF.poolSize,
  debrisCount: CF.debrisCount,

  // ---- 绘制顺序与容量 ----
  /**
   * transparent 队列里的绘制序号。**与闪电同档 3**（体素水 0 < 海面 1 < 曳光 2 < 特效 3）。
   * 空闲 `visible=false` ⇒ 队列回到基线，水面顺序不变式不受影响。
   */
  renderOrder: 3,

  // ---- 岩石形状（上游 lumpiness / lumpScale / surfaceRoughness / facets）----
  /** icosphere 细分。上游 facets 3（1280 三角）；本仓 2 足够（半径仅 0.5 格） */
  rockDetail: 2,
  /** 低频起伏幅度（× 半径）—— 上游 lumpiness 0.26 */
  lumpiness: 0.26,
  /** 每单位半径的凸起数 —— 上游 lumpScale 1.5 */
  lumpScale: 1.5,
  /** 高频碎裂幅度 —— 上游 surfaceRoughness 0.16 */
  surfaceRoughness: 0.16,

  // ---- 熔岩缝（上游 crack* / rockScale / cavity / soot / rimHeat）----
  /** 每单位半径的缝数 —— 上游 crackScale 0.95 */
  crackScale: 0.95,
  /** 缝宽（飞行中随受热张开）—— 上游 crackWidth 0.045 */
  crackWidth: 0.045,
  /** 细缝分叉强度 —— 上游 crackBranches 0.5 */
  crackBranches: 0.5,
  /** 缝的发光增益 —— 上游 crackGlow 2.2 */
  crackGlow: 2.2,
  /** 岩浆亮度爬行 —— 上游 crackFlow 0.7 / crackFlowSpeed 0.9 */
  crackFlow: 0.7,
  crackFlowSpeed: 0.9,
  /** 岩石本体的斑驳 —— 上游 rockScale 3.4 */
  rockScale: 3.4,
  /** 逐面明暗打散（读作石头而不是塑料球）—— 上游 facetTint 0.5 */
  facetTint: 0.5,
  /** 凹陷压暗 —— 上游 cavity 0.25 */
  cavity: 0.25,
  /** 缝两侧的焦黑 —— 上游 soot 0.6 */
  soot: 0.6,
  /** 轮廓的热鞘 —— 上游 rimHeat 0.7 */
  rimHeat: 0.7,
  /** 前缘压缩热 —— 上游 leadGlow 0.9 / leadSharp 2.6 */
  leadGlow: 0.9,
  leadSharp: 2.6,
  /**
   * 受热曲线指数 —— 上游 chargeCurve 1.6：岩石**越接近落点越亮**
   * （「the explosion is something you watched arrive」）。
   */
  chargeCurve: 1.6,

  // ---- 火焰光晕（照火球手法，零 shader）----
  /**
   * 光晕相对岩石的直径倍率。**直接等于 `FIREBALL_HALO_SCALE`**
   * （用户 v3.20c 裁定的手法，单测钉两者相等）。
   * 实现：canvas 径向渐变（白热 → 炽橙 → 暗橙 → **边缘 alpha 0**）
   * + `MeshBasicMaterial` + additive + billboard。
   */
  haloScale: FIREBALL_HALO_SCALE,
  /** 光晕呼吸幅度与频率（照火球 ±15% / 6Hz，火焰跳动感） */
  haloPulseAmp: 0.15,
  haloPulseHz: 6,

  // ---- 落点爆壳（复用 Storm Lance 的 STORM 结构，换暖色）----
  /** 终值半径（格）—— 上游 burstSize 3.6 */
  burstSize: 3.6,
  burstLifeSeconds: 0.9,
  burstIntensity: 1.4,
  burstOpacity: 0.9,
  burstFresnel: 1.6,
  burstDisplace: 0.6,
  burstSquash: 0.8,
  /**
   * 电弧阈值。**必须硬**（与 Storm Lance 同口径 0.80~0.97）。
   * 上游注释：放宽后「fills the shell in and it immediately reads as a rock」。
   */
  burstArcLo: 0.80,
  burstArcHi: 0.97,

  // ---- 冲击环（上游 DecalType.SHOCKWAVE）----
  /** 终值半径 —— 上游 shockRadius 6.0 */
  shockRadius: 6.0,
  shockLifeSeconds: 0.65,
  shockWidth: 0.07,
  shockIntensity: 1.2,

  // ---- 总增益 ----
  /** ⚠️ 由 Tier 4 像素实测标定（见文件头 ①）。初值 1.0 = 上游原比例 */
  gain: 1.0,

  /**
   * 配色（逐项取自上游 `settings.meteor.color*`）。
   * **暖橙 + 焦黑**是 Cinder Fall 的身份（Storm Lance 是冷蓝白）。
   */
  colorRock: '#6e675f',  colorChar: '#17130f',
  colorCrack: '#ff6a12',
  colorHot: '#fff3d0',
  colorFlameMid: '#ffb02e',
  colorFlameEdge: '#ff3d10',
  colorBurstA: '#ff6a12',
  colorBurstB: '#ffb02e',
  colorBurstC: '#fff3d0',
  colorShockA: '#ff9a2e',
  colorShockB: '#fff3d0',
});

/**
 * 落点碎块的基色（0..1 三分量，喂给 `blockHitFx.spawnDeathBurst`）。
 *
 * ⚠️ **与 `IGNIS_DEATH_COLOR` 同位点**：碎块颜色由调用方给，池与曲线复用。
 * 取炽橙（上游 colorFlameMid `#ffb02e`）—— 读作「烧红的岩石碎块」而不是普通石屑。
 * 放在 config 而不是装配层：观感量的单一权威在这里（红线 1）。
 */
export const CINDER_DEBRIS_COLOR = Object.freeze([1.0, 0.69, 0.18]);