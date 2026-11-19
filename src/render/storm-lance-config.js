// src/render/storm-lance-config.js — Storm Lance 的观感常量与曲线（**three-free**）
//
// 为什么单独成模块（与 `water-reflect-config.js` / `sun-shade.js` 同手法）：
//   ① Tier 1 单测要能直接 import 它断言常量关系与曲线，**不必经过 three 的 GPU 初始化**；
//   ② 玩法量（半径/时长）从 `weapon-catalog.js` 派生，观感量在这里 —— 两边各写一份会漂移出
//      「伤害判定用的束与画出来的束不在同一处」（红线 1）。
//
// ## 数值来源：上游 `~/jaylli/LinearAbiltyCastingThreeJS` 的 `settings.thunder`
//
// Storm Lance = `ThunderAbility.js` + `LightningMaterial.js`（`ELEMENT_META.thunder.label`）。
// **零新增美术资源**：配色是常量，几何程序化。
//
// ## ⚠️ 三处必须按本仓口径重标（照抄会错）
//
// **① `toneMapped: false` 在 WebGPU 后端不存在**（实测 `three.webgpu.js` 里出现次数 = **0**）
// —— 色调映射在 `_renderOutput` 的全屏 output pass 上做，材质级开关没有。上游 `glow 2.3`
// 在本仓 ACES + exposure 下会削平成白。故给统一增益 `gain`，由 Tier 4 像素实测标定。
//
// **② 深度软相交不移植**：上游 `softFade(uSceneDepth, …)` 的 TSL 对应物
// `viewportDepthTexture()` 会 **`currentPass.end()` + 重开 render pass**
// （`three.webgpu.js:86491`）—— 那正是 v3.17 水面倒影撕天空那一类时机缺陷。
// 本仓只靠 `depthTest: true` 硬遮挡（曳光既有口径）。
//
// **③ 手点/落点不用绝对米数**：上游 `handHeight/endHeight` 是「离地板的高度」（沙盒地板恒
// y=0）。本仓地形起伏 ⇒ 走 catalog 的 `handOffset`（相对相机）与沿轴线的落点。
import { WEAPONS } from '../player/weapons/weapon-catalog.js';

const SL = WEAPONS.sword.stormLance;

/** 缓动（上游 `utils/math.js` 同名函数） */
const sat = (x) => Math.max(0, Math.min(1, x));

/**
 * 爆壳扩张曲线 —— **`outQuint`，不是 outCubic**（用户报「软绵绵」的根因之一）。
 *
 * `1−(1−t)^5`：t=0.2 时已到 **0.672**，而 outCubic 只有 0.488。
 * 前 20% 的时间冲掉三分之二 ⇒ 读作「炸开」；outCubic 读作「慢慢胀」。
 * **这条曲线是冲击力的来源，单测钉住 t=0.2 的读数。**
 *
 * @param {number} t 0..1
 * @returns {number} 0..1
 */
export function stormBurstScale(t) {
  const k = sat(Number.isFinite(t) ? t : 0);
  return 1 - Math.pow(1 - k, 5);
}

/**
 * 上游 `hash11`（`shaders/lib/noise.glsl.js`）—— 逐字重建，**不用 vendor 的 `hash`**。
 *
 * 理由：TSL 的 `hash` 与上游这个不是同一个分布，换掉会让全部 kink 形状漂移，
 * 而「闪电看起来还是闪电」⇒ 数值判据拓不到。这里保持逐字一致。
 *
 * @param {number} p @returns {number} 0..1
 */
function hash11(p) {
  let x = (p * 0.1031) % 1;
  if (x < 0) x += 1;
  x *= x + 33.33;
  x *= x + x;
  return x - Math.floor(x);
}

/**
 * **分段线性** value noise（上游 `LightningMaterial.js` 的 `vnoise`）。
 *
 * ⚠️⚠️ **不得改成 smoothstep 插值**。上游注释原文：「Linear on purpose: smoothstep
 * would round the corners off, and the corners are the entire reason it reads as
 * lightning rather than as a wobbly tube」。换成平滑噪声 ⇒ 闪电退化成扭动的管子，
 * 而顶点数/相位/draw call 判据全绿。单测用 t=0.25 处的权重分辨两者。
 *
 * @param {number} x @param {number} seed
 * @returns {number} −1..1
 */
export function stormKinkNoise(x, seed) {
  const xv = Number.isFinite(x) ? x : 0;
  const sv = Number.isFinite(seed) ? seed : 0;
  const i = Math.floor(xv);
  const f = xv - i;
  const a = hash11(i + sv);
  const b = hash11(i + 1 + sv);
  return (a + (b - a) * f) * 2 - 1;
}

/**
 * 观感常量（冻结，渲染层不得改写）。
 */
export const STORM_LANCE_FX = Object.freeze({
  // ---- 玩法派生（唯一权威在 weapon-catalog）----
  radius: SL.radius,
  holdSeconds: SL.holdSeconds,
  fadeSeconds: SL.fadeSeconds,
  speed: SL.speed,

  // ---- 绘制顺序与容量 ----
  /**
   * transparent 队列里的绘制序号。**体素水 0 < 海面 1 < 曳光 2 < 闪电 3**。
   * 与曳光同理：海面 `depthWrite=true`，闪电排在它之后才能被水面正确遮挡（入水段）。
   * 空闲 `visible=false` ⇒ 队列回到基线，水面顺序不变式不受影响。
   */
  renderOrder: 3,
  /** 火花池容量。上游 4000 是沙盒连发多个技能的量；本仓单槽 ≤1.18s */
  sparkCapacity: 768,

  // ---- 几何细分（形状全在 shader 里，这些只是精度上限）----
  /** 沿束采样数。上游 NODES=72：高于「每两节点一个 kink」的频率只会走样 */
  boltNodes: 72,
  /** 丝数上限（上游 MAX_STRANDS=24，出厂 strands=9） */
  strands: 9,
  maxStrands: 24,
  /** 每帧火花分散到沿束的几个点（上游 SPARK_BATCHES=6）。少了每批读作定点星爆 */
  sparkBatches: 6,

  // ---- 束的扇形（上游 spread* / twist* / branchDim）----
  spread: SL.radius,
  spreadNear: 0.05,
  spreadCurve: 1.6,
  twist: 0.45,
  twistSpeed: 0.8,
  branchDim: 0.72,
  /** 中段拱起（格）。上游 sag 0.22 —— 让闪电不是死直的线 */
  sag: 0.22,

  // ---- 单条丝的 kink（分段线性噪声，见 stormKinkNoise）----
  jitter: 0.34,
  jitterScale: 0.85,
  octaves: 4,
  jitterFalloff: 0.55,
  crawl: 3.2,
  pinch: 0.14,
  converge: 0.8,

  // ---- ribbon 宽度与剖面 ----
  width: 0.025,
  widthTip: 0.43,
  widthCurve: 1.09,
  coreWidth: 1.31,
  coreSharp: 4.95,
  glowWidth: 5.7,
  glowFalloff: 2.4,
  glowOpacity: 0.49,

  // ---- 频闪与重击（保持期不读作静态丝带的关键）----
  restrike: 24,
  flicker: 0.3,
  flickerSpeed: 34,
  strandFlash: 0.5,
  tipGlow: 2.0,
  tipLength: 0.08,

  // ---- 总增益与不透明度 ----
  /** ⚠️ 由 Tier 4 像素实测标定（见文件头 ①）。初值 1.0 = 上游原比例 */
  gain: 1.0,
  glow: 2.3,
  opacity: 1.0,

  // ---- 蓄力光球（R5：用户「蓄力的球也有点太大，改小点」）----
  /** 旧 Nova Beam 是 0.39；这里 0.20 ≈ 一半，单测钉「< 0.39×0.7」 */
  orbSize: 0.20,
  orbThrob: 0.11,
  orbThrobSpeed: 6.9,
  orbTurbulence: 0.24,
  orbScale: 2.2,
  orbFlow: 0.9,
  orbBands: 5.0,
  orbRim: 1.8,
  orbGlow: 2.8,
  orbOpacity: 1.0,
  orbFadeSeconds: 0.15,

  // ---- 火花：**速度拉伸条状**（R3，用户「曳光效果丢了」）----
  /**
   * ⚠️⚠️ `streak` 不是装饰选项。上游 `ParticleShape.STREAK` + `stretch:true`：
   * 火花沿自己的速度方向拉成细条（`ParticleSystem.js:461-467`）。
   * 上一版用的是圆形羽化 quad（`ParticleShape.SOFT`）⇒ 用户读作「往外冒爆米花」。
   */
  sparkShape: 'streak',
  sparkStretch: 0.18,
  sparkRate: 240,
  sparkSize: 0.16,
  sparkSpeed: 9.0,
  sparkLifetime: 0.5,
  sparkGravity: -12.0,
  sparkForward: 0.45,
  /** 蓄力吸入（复用火花池，方向指向手点） */
  intakeRate: 200,
  intakeRadius: 2.0,
  intakeSpeed: 7.0,

  // ---- 落点爆壳（R4：STORM 模式，逐字照 BurstSphere.js）----
  burstSize: 3.0,
  burstLifeSeconds: 0.7,
  burstIntensity: 1.4,
  burstOpacity: 0.9,
  burstFresnel: 1.6,
  burstDisplace: 0.6,
  burstSquash: 0.8,
  /**
   * 电弧阈值。**必须硬**（上游 0.80~0.97）。上游注释原文：
   * 「Thresholded hard on purpose — a wide band here fills the shell in and it
   * immediately reads as a rock」。放宽 ⇒ 实心球 ⇒ 又变回软绵绵。
   */
  burstArcLo: 0.80,
  burstArcHi: 0.97,
  /** 枪口小爆壳（上游 muzzleSize 0.55） */
  muzzleSize: 0.55,
  muzzleIntensity: 1.9,
  muzzleLifeSeconds: 0.3,
  /** 落点额外火花数（上游 burstSparks 170） */
  burstSparks: 170,

  // ---- 冲击环（R4「要有冲击波」，上游 DecalType.SHOCKWAVE）----
  shockRadius: 6.5,
  shockLifeSeconds: 0.6,
  /** 环带厚度（上游 width 0.05，相对半径） */
  shockWidth: 0.05,
  shockIntensity: 1.0,

  /**
   * 配色（逐项取自上游 `settings.thunder.color*`）。
   * **冷蓝白**是 Storm Lance 的身份（Nova Beam 是青 + 金线圈，已废弃）。
   */
  colorCore: '#ffffff',
  colorInner: '#c9ecff',
  colorOuter: '#3aa0ff',
  colorHalo: '#0b3fc8',
  colorSparkA: '#ffffff',
  colorSparkB: '#ffffff',
  colorSparkC: '#c9ecff',
  colorSparkD: '#1e5b95',
  colorBurstA: '#3aa0ff',
  colorBurstB: '#c9ecff',
  colorBurstC: '#ffffff',
  colorMuzzleA: '#3aa0ff',
  colorMuzzleB: '#c9ecff',
  colorMuzzleC: '#ffffff',
  colorShockA: '#c9ecff',
  colorShockB: '#ffffff',
});