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
// ⚠️⚠️ **暖色不能照搬冷色的 additive 增益**：冷蓝白叠 3.6 倍仍读得出蓝，
// 而暖橙的 r 已≈1.0，再叠必然**钳到白**（实测 warmPct 2.7% = 几乎无色）。
//
// **② 体积火焰 raymarch 不移植，但火焰尾巴本身要移植**（用户 2026-11-19：
// 「有拖拽的一个火焰尾巴」）。上游 `VolumetricFireMaterial` 是 35 步/像素的黑体
// 积分（833 行）—— 本仓换成**相机朝向 ribbon + 四层 TSL 噪声**（轮廓 / 流场 /
// 湍流与域扭曲 / 量化闪烁），保留观感身份而不付 raymarch 的代价。
// 光晕仍照火球手法（canvas 径向渐变 billboard，零 shader）。
//
// **③ 熔岩裂缝贴花 / 焦痕 / 动态光 / 震屏闪白不移植**（用户既有裁定）。
// 但**火星 / 余烬 / 烟 三套 GPU 粒子要移植**（用户：「爆炸的时候蹦出的火星
// 粒子很多，是爆炸的样子，而不是现在一样像烟花」）。
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
  /** icosphere 细分。上游 facets 3（1280 三角）；本仓取 3 与上游一致（轮廓要看得出碎石） */
  rockDetail: 3,
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
  /** 轮廓的热鞘 —— 上游 rimHeat 0.7；本仓压到 0.45（unlit 下它会把黑岩石洗成橙球） */
  rimHeat: 0.45,
  /** 前缘压缩热 —— 上游 leadGlow 0.9 / leadSharp 2.6（同上，压到 0.5） */
  leadGlow: 0.5,
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

  // ---- 火焰尾巴（上游 RibbonGeometry + VolumetricFireMaterial 的**简化移植**）----
  /**
   * ⚠️⚠️ **用户 2026-11-19：「有拖拽的一个火焰尾巴」** —— 旧实现只有岩石 +
   * 一圈光晕，没有任何尾巴，读作「飘着的火球」而不是「抡过来的陨石」。
   *
   * 上游用 35 步/像素的**体积黑体 raymarch**（833 行）—— 本仓**不移植那套**
   * （用户既有裁定「从最简单的开始」），而是用**相机朝向的 ribbon 条带 +
   * TSL 噪声火焰**：几何沿用 Storm Lance 已验证的「顶点里没有任何米数」手法
   * （`createBoltRibbonGeometry` 同形），每个顶点只是 `(t, side)`，世界坐标由
   * shader 每帧从 `uTail → uHead` 重建 ⇒ 改弧高/长度不需要重建几何。
   *
   * 下面逐项取自上游 `settings.meteor.trail*`（单位是米，本仓 1 格 = 1 米）。
   */
  /** 尾巴覆盖的弧长（格）—— 上游 trailSpan 7.0 */
  trailSpan: 7.0,
  /** 管半径（格）—— 上游 trailWidth 0.66 */
  trailWidth: 0.66,
  /** 头部（贴着岩石那端）半径倍率 —— 上游 trailHeadSize 1.8 */
  trailHeadSize: 1.8,
  /**
   * ⚠️⚠️ **鼻锥长度（格）** —— 用户 2026-11-19：「火焰球的前进方向侧，前面是平的，
   * 而不是尖的，平的不好看，希望从平头改成椭圆头或者尖头」。
   *
   * 成因：ribbon 只铺到**岩石中心**（`uHead` = 岩石位置），于是条带在球心处
   * 被一条垂直于运动方向的**直边**截断 —— 岩石与光晕盖不住那半圈超出球半径的宽度，
   * 读作「平头铲子」。上游那套是体积积分，密度场天然在头部收拢，没有这个问题。
   *
   * 正解：把中心线**沿运动方向前伸**一段，并在这一段用**椭圆剖面**
   * `sqrt(1−s²)` 收拢到 0 ⇒ 前端是光滑的卵形尖头（s=0 处切线竖直 ⇒ 圆润，
   * s→1 处收到一点 ⇒ 尖）。取 1.15 格 ≈ 2.3×岩石半径，够包住球体又不显突兀。
   */
  trailNoseLength: 1.15,
  /**
   * 鼻锥起始处的宽度衔接（占头部半径的比例）。
   * 取 1.0 = 与头部同宽开始收拢（无缝）；<1 会在接缝处出现台阶。
   */
  trailNoseJoin: 1.0,
  /** 尾端已燃气体的膨大 —— 上游 trailWakeSpread 0.22 */
  trailWakeSpread: 0.22,
  /** 远端上浮（格）—— 上游 trailRise 0.35（热气往上爬） */
  trailRise: 0.35,
  /** 向上拉伸（浮力伸长）—— 上游 trailPlume 1.1 */
  trailPlume: 1.1,
  /** 噪声吞吃轮廓的幅度 —— 上游 trailTurbulence 2.94（按本仓 ribbon 口径折算） */
  trailTurbulence: 0.62,
  /** 域扭曲（把噪声折成卷曲的火舌）—— 上游 trailWarp 0.45 */
  trailWarp: 0.45,
  /** 火舌向上拉长指数（<1 拉长）—— 上游 trailTongue 0.94 */
  trailTongue: 0.94,
  /** 场沿路径向后流动的速率 —— 上游 trailSpeed 4.62 */
  trailSpeed: 4.62,
  /** 场内上升速率 —— 上游 trailBuoyancy 3.5 */
  trailBuoyancy: 3.5,
  /** 尾部撕成独立烟团的强度 —— 上游 trailDetachment 0.9 */
  trailDetachment: 0.9,
  /** 噪声频率 —— 上游 trailNoiseFrequency 3.23 */
  trailNoiseFrequency: 3.23,
  /** 密度 —— 上游 trailDensity 2.09 */
  trailDensity: 2.09,
  /** 烟灰吸收（让冷气体遮挡，出层次）—— 上游 trailSoot 1.42 */
  trailSoot: 1.42,
  /** 整体不透明度 —— 上游 trailOpacity 0.96 */
  trailOpacity: 0.96,
  /** 已烧尽的尾段比例 —— 上游 trailTailFade 0.71；
   * ⚠️ **本仓压到 0.42**：上游那个值是配合体积积分的，ribbon 上直接用它会把
   * 整条尾巴吃掉 ⇒ 只剩烟灰，实测截图里是一根**灰柱子**而不是火。 */
  trailTailFade: 0.42,
  /** 火焰亮度增益 —— 上游 trailGlow 3.06（本仓无 toneMapped，按像素重标） */
  trailGlow: 2.2,
  /** 闪烁 —— 上游 trailFlicker 0.74 */
  trailFlicker: 0.34,
  /** 岩石消失后尾巴烧回头的时长（秒）—— 上游 trailBurnout 1.2 */
  trailBurnout: 1.2,
  /** 沿尾巴的采样节点数（上游 TRAIL_NODES 48；本仓 ribbon 参数化取 40 足够） */
  trailNodes: 40,

  // ---- 火星 / 余烬 / 烟（上游 ParticleSystem 的四套，本仓合并成两套 GPU 池）----
  /**
   * ⚠️⚠️ **用户 2026-11-19：「爆炸的时候蹦出的火星粒子很多，是爆炸的样子，
   * 而不是现在一样像烟花」** —— 旧实现落点只有爆壳 + 冲击环 + 18 块碎块，
   * 零火星 ⇒ 读作「一圈光环扩开」= 烟花。
   *
   * 上游落点一次喷：`burstEmbers 260` + `burstSparks 180` + `burstDebris 90`
   * + `burstSmoke 70`。本仓移植前三类的**观感身份**（火星条状拉伸 + 余烬圆点
   * 上浮 + 烟团遮挡），数量按同一比例。
   *
   * ⚠️ **火星必须是 STREAK（沿速度拉伸的细条）**，不是圆形羽化 quad ——
   * 后者用户已明确读作「冒爆米花」（Storm Lance v3.20 实测）。手法直接复用
   * `storm-lance-material.js` 的 spark pass 结构（同一份已验证的 TSL）。
   */
  sparkCapacity: 1024,
  /** 落点火星数 —— 上游 burstSparks 180 */
  burstSparks: 180,
  /** 落点余烬数 —— 上游 burstEmbers 260 */
  burstEmbers: 260,
  /** 飞行中每秒火星数 —— 上游 sparkRate 110 */
  sparkRate: 110,
  /** 飞行中每秒余烬数 —— 上游 emberRate 180 */
  emberRate: 180,
  /** 沿弧分批撒（上游 TRAIL_BATCHES 3）—— 单点发射会读作「定点星爆」 */
  trailBatches: 3,
  /** 火星初速 —— 上游 sparkSpeed 6.5（落点 ×2.4） */
  sparkSpeed: 6.5,
  sparkBurstSpeedMul: 2.4,
  sparkLifetime: 0.8,
  sparkGravity: -11.0,
  sparkSize: 0.055,
  /**
   * ⚠️⚠️ **屏幕空间尺寸上限（占屏高比例）** —— 粒子在**手点附近出生**，
   * 那里离相机只有 0.5 格 ⇒ 0.1 格的余烬会投影成 **140px 的大光斑**
   * （实测截图：满屏淡橙 bokeh 圆斑 = 用户报的「爆米花 / 烟花」）。
   * 上游靠 softFade 与更远的相机缓解，本仓第一人称必须**硬钳屏幕尺寸**。
   */
  sparkMaxScreen: 0.022,
  emberMaxScreen: 0.014,
  smokeMaxScreen: 0.10,
  /** 速度拉伸系数 —— 上游 sparkStretch 0.16 */
  sparkStretch: 0.16,
  sparkDrag: 0.7,
  /** 余烬初速 —— 上游 emberSpeed 2.4（落点 ×2.6） */
  emberSpeed: 2.4,
  emberBurstSpeedMul: 2.6,
  emberLifetime: 1.5,
  /** 余烬浮力（正 = 往上飘）—— 上游 emberRise 1.5 */
  emberRise: 1.5,
  emberSize: 0.035,
  emberDrag: 1.2,
  /** 烟雾容量与寿命（非加法混合 ⇒ 它要**遮挡**，这是层次的来源） */
  smokeCapacity: 192,
  burstSmoke: 70,
  smokeRate: 70,
  smokeSpeed: 1.2,
  smokeLifetime: 3.0,
  smokeSize: 0.55,
  smokeOpacity: 0.16,
  smokeRise: 0.9,
  smokeDrag: 1.7,
  /** 粒子空闲多久后隐藏 mesh（两个最长寿命，让在飞的自然衰亡而不是硬切） */
  particleIdleSeconds: 3.2,

  // ---- 落点爆壳（复用 Storm Lance 的 STORM 结构，换暖色）----
  /** 终值半径（格）—— 上游 burstSize 3.6 */
  burstSize: 3.6,
  burstLifeSeconds: 0.9,
  burstIntensity: 0.85,
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
  /**
   * 环沿命中面法线的抬升（格）。
   * ⚠️⚠️ **不得为 0**：落点是真实表面接触点，环与地面共面 ⇒ depthTest 下
   * 被地面完全遮住（实测渲染 **0 像素**，而 visible/age/fade 全对）。
   */
  shockLift: 0.03,

  // ---- 总增益 ----
  /** ⚠️ 由 Tier 4 像素实测标定（见文件头 ①）。初值 1.0 = 上游原比例 */
  gain: 1.0,

  /**
   * 配色（逐项取自上游 `settings.meteor.color*`）。
   * **暖橙 + 焦黑**是 Cinder Fall 的身份（Storm Lance 是冷蓝白）。
   */
  /**
   * 石头基色。**用户 2026-11-19：「他的实现是一个**黑色的燃烧的火球**」**。
   * 上游 `colorRock #6e675f` 是中灰（它靠 HDR 环境光提亮）；本仓体素世界是 unlit，
   * 中灰在亮天空下读作「灰石头」而不是「燃烧的黑色陨石」⇒ 压到接近炭黑，
   * 让**熔岩缝与火焰尾巴成为唯一亮源**（对比更强 = 更「燃烧」）。
   */
  colorRock: '#2a2420',  colorChar: '#0b0908',
  colorCrack: '#ff6a12',
  colorHot: '#fff3d0',
  colorFlameMid: '#ffb02e',
  colorFlameEdge: '#ff3d10',
  colorBurstA: '#ff6a12',
  colorBurstB: '#ffb02e',
  colorBurstC: '#fff3d0',
  colorShockA: '#ff9a2e',
  colorShockB: '#fff3d0',
  /** 火焰尾巴的三段色（上游 colorHot / colorFlameMid / colorFlameEdge / colorFlameSmoke） */
  colorFlameSmoke: '#181616',
  /** 火星四停靠渐变（上游 colorSparkA..D：白热 → 淡金 → 炽橙 → 焦褐） */
  colorSparkA: '#fffdf2',
  colorSparkB: '#ffd27a',
  colorSparkC: '#ff6a12',
  colorSparkD: '#3d1103',
  /** 余烬四停靠渐变（上游 colorEmberA..D） */
  colorEmberA: '#fff3d0',
  colorEmberB: '#ff9a2e',
  colorEmberC: '#ff3b0d',
  colorEmberD: '#2b0d05',
  /** 烟四停靠渐变（上游 colorSmoke*：热灰 → 冷灰 → 近黑） */
  colorSmokeA: '#6b5a4e',
  colorSmokeB: '#3a3230',
  colorSmokeC: '#221d1c',
  colorSmokeD: '#12100f',
});

/**
 * 落点碎块的基色（0..1 三分量，喂给 `blockHitFx.spawnDeathBurst`）。
 *
 * ⚠️ **与 `IGNIS_DEATH_COLOR` 同位点**：碎块颜色由调用方给，池与曲线复用。
 * 取炽橙（上游 colorFlameMid `#ffb02e`）—— 读作「烧红的岩石碎块」而不是普通石屑。
 * 放在 config 而不是装配层：观感量的单一权威在这里（红线 1）。
 */
export const CINDER_DEBRIS_COLOR = Object.freeze([1.0, 0.69, 0.18]);