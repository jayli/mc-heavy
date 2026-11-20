// src/render/fire-ring-config.js — 焰魔扩散火圈的观感常量（**three-free**）
//
// 用户 2026-11-20：「把地上扬起的碎石块的特效改为扩散火圈……以焰魔为中心来散出一个
// 逐渐向外燃烧的火圈，不需要外加声音，只实现视觉特效」。批准范围：**持盾冲撞
// （shieldSmash，用户口语「头部撞击」）与举盾砸击（shieldBash）两招都换**。
//
// ## 与被它取代的碎石圆环的三处刻意差异
//
//   ① **圆心 = 焰魔脚底**，不是碎石那个「正前方 2.75 格」的偏心环
//      （`smashRingCenter` 已随本轮删除）。用户原话「以焰魔为中心」。
//   ② **半径随时间外扩**（碎石是固定半径的一圈静态落点 + 抛物线弹跳）。
//   ③ **纯视觉、无伤害**：与地面法阵同口径（v3.04 裁定），两招伤害仍走
//      `IGNIS.attackDamage`，本轮一行玩法代码未改。
//
// ## 观感身份：燃烧火舌环（用户在三个选项里选的那个）
//
// 复用本仓**已过像素实测**的暖色 TSL 结构，不新写一套：
//   · 环的径向亮带 → `cinder-fall-material.js:makeShockPass` 的 `front/band` 结构
//   · 火舌的噪声侵蚀 + 流场 + 量化闪烁 → 同文件 `makeFlamePass`
//   · 条状火星 → `makeParticlePass(streak=true)`（圆点会被读作「爆米花」，v3.20 实测）
// **零新增贴图、零音效、零烘焙产物。**
//
// ## 配色直接引 Cinder 的火焰色阶（红线 1：同一事实只有一份权威）
//
// 不在这里另写一套橙 —— 那会让「同样是火」的两处特效色相漂移，而所有数值判据全绿。
import { CINDER_FX as CF } from './cinder-fall-config.js';
import { IGNIS } from '../entities/ignis/ignis-config.js';

const sat = (x) => Math.max(0, Math.min(1, x));
/** outQuint —— **冲击力的来源**（前 20% 冲掉 2/3）；outCubic 读作慢胀（v3.20 实测） */
const outQuint = (t) => 1 - Math.pow(1 - sat(t), 5);

/**
 * 火圈节奏与形状（冻结，渲染层不得改写）。
 *
 * ⚠️ **寿命 1.1s 是推导出来的，不是拍的**：两招各自「命中帧 → 收势结束」的余量分别是
 * `shieldSmash` 3.50−1.70 = **1.80s**、`shieldBash` 3.89−1.89 = **2.00s**，
 * 加上招间空档下限 `IGNIS_AI.attackCooldownMin` 1.0s ⇒ 同一只焰魔两次火圈至少隔 2.80s。
 * 1.1s 远小于它 ⇒ 单只焰魔不会自己叠自己（两只并发时由池容量 2 兜住）。
 * 关系式单测钉在 `test-fire-ring.js`。
 */
export const FIRE_RING = Object.freeze({
  /**
   * transparent 队列里的绘制序号。**与闪电 / Cinder 同档 3**
   * （体素水 0 < 海面 1 < 曳光 2 < 特效 3）。空闲 `visible=false` ⇒ 队列回到基线，
   * 水面顺序不变式（`water-order.spec.mjs`）不受影响。
   */
  renderOrder: 3,
  /**
   * 并发环数。**从 `IGNIS.maxAlive` 派生**（同时最多两只焰魔，各出一个环）。
   * ⚠️ 不硬编码 2：那是第二份权威，改 maxAlive 时会静默不够用。
   */
  maxActive: IGNIS.maxAlive,

  /** 起始半径（格）—— 从脚下起火，不是从 0 半径的一个点 */
  startRadius: 0.5,
  /**
   * 终值半径（格）。碎石环最远点到脚底 5.35 格、两招射程 6.5 格
   * ⇒ 取 6.5 让火圈铺满整个交战圈（玩家站在 4.25~5.0 格 standoff 环上时火圈扫过脚下）。
   */
  endRadius: 6.5,
  /** 总寿命（ms，含外扩 + 淡出） */
  lifeMs: 1100,
  /** 淡出起点（寿命进度）—— 前 70% 满亮 */
  fadeFrom: 0.7,
  /**
   * 环带半宽（格）。⚠️ 它是**世界米数**不是归一化比例 ——
   * 写成归一化会让带宽随半径一起放大，末段变成一大片橙色饼而不是「一圈火」。
   */
  bandWidth: 0.55,
  /**
   * 抬离地面（格）。⚠️⚠️ **不得为 0**：环与地面共面 ⇒ `depthTest:true` 下被地面
   * 完全遮住（Cinder Fall 实测渲染 **0 像素**，而 visible/age/fade 全对）。
   */
  yLift: 0.03,
  // ---- 火舌（噪声侵蚀 + 流场 + 闪烁）----
  /** 沿圆周的噪声频率（越大 = 火舌越密） */
  tongueScale: 2.6,
  /** 噪声对环带的侵蚀强度（0 = 完美圆环，读作光环而不是火） */
  turbulence: 0.55,
  /**
   * 环带增益（侵蚀前先乘它）。
   * ⚠️ **必须 >1**：写成 `band + turb` 时噪声只能「加亮」不能「吃掉」，
   * 边缘永远是光滑丝带（实测：画面读作金色光环而不是燃烧火舌）。
   * 取 1.6：带的外半被噪声吃成锯齿，内半保留 ⇒ 火舌轮廓。
   */
  bandGain: 1.6,
  /** 噪声向上爬的速度（火舌舔舐感） */
  flowSpeed: 1.6,
  /** 量化闪烁幅度（真火在几个亮度之间跳，不是正弦呼吸） */
  flicker: 0.22,
  /** 内圈余烬暗光强度（扫过的地方留一点余光，不是干干净净只剩一条线） */
  innerGlow: 0.14,
  /**
   * 内圈余烬的**径向衰减幂**。
   *
   * ⚠️⚠️ **它必须存在**（本轮玩家视角截图实测到的真缺陷）：只写 `innerGlow`
   * 而不随半径衰减时，波前以内的**整个圆盘**都是恒亮度的橙 ⇒ 画面读作
   * 「一张实心橙饼」（用户要的是「一圈火」）。取 3.0：只有紧贴波前的内侧
   * 有余光（r/front=0.8 时 0.51、0.5 时 0.125、0.2 时 0.008）。
   */
  innerFalloff: 3.0,
  /**
   * 白热核的**锐度幂**（越大 = 白热区越窄）。
   *
   * ⚠️⚠️ **它决定「火还是白弧」**（本轮实测）：旧写法用
   * `smoothstep(0.66,1,heat)` 且 heat 在带内恒达 1.0 ⇒ **整条带全是白热色**
   * (255,243,208)，橙色只存在于 alpha≈0 处。取 4.0：band=1 时核=1（波前白热），
   * band=0.7 时 0.24、band=0.5 时 0.0625 ⇒ 带体主体是炽橙。
   */
  coreSharp: 4.0,
  /**
   * 带体基色的橙红程度（0 = 全炽橙 colorMid，1 = 全暗红 colorEdge）。
   * ⚠️ 暖色特效在亮草地上容易发白（本轮实测）—— 把带体往红端推一点
   * 能拉开与背景的色相距离。取 0.35：主体仍是炽橙，但 g 分量更低。
   */
  bodyRedBias: 0.35,
  /** 总增益。⚠️ 暖色 additive 的增益必须按像素标定，不得照抄冷色（v3.21 实测） */
  gain: 1.0,
  /** 环带不透明度上限 */
  opacity: 0.95,

  // ---- 条状火星（沿速度拉伸；圆点会被读作「爆米花」）----
  /** 一次 spawn 撒多少颗。分 6 批沿圆周撒（单点发射读作「定点星爆」） */
  sparkCount: 150,
  sparkBatches: 6,
  /** 粒子池容量（一次 150 × 两环并发，留一倍余量） */
  sparkCapacity: 512,
  /** 火星初速（格/秒），主方向 = 径向外 + 上 */
  sparkSpeed: 4.2,
  sparkLifetime: 0.55,
  sparkGravity: -9.0,
  sparkSize: 0.07,
  sparkDrag: 0.9,
  sparkStretch: 0.16,
  /**
   * 屏幕空间尺寸上限（占屏高比例）。⚠️ 玩家可能正站在火圈里 ⇒ 粒子离相机 0.3 格，
   * 不钳的话会投影成上百像素的大光斑（Cinder Fall 实测的「爆米花」成因）。
   */
  sparkMaxScreen: 0.02,

  // ---- 配色（引 Cinder 火焰色阶，不另写一套橙）----
  colorEdge: CF.colorFlameEdge,
  colorMid: CF.colorFlameMid,
  colorHot: CF.colorHot,
  colorSparkA: CF.colorSparkA,
  colorSparkB: CF.colorSparkB,
  colorSparkC: CF.colorSparkC,
  colorSparkD: CF.colorSparkD,
});

/**
 * 寿命进度 → 环半径（格）。**纯函数，渲染器与单测共用这一份**（红线 1）。
 *
 * outQuint：t=0.2 时已到 0.672 ⇒ 半径 4.53 格（「轰地散开」）；
 * 换成 outCubic 只有 0.488 ⇒ 3.43 格，读作慢慢胀（v3.20 用户裁定「软绵绵」）。
 *
 * @param {number} k 寿命进度 0..1（越界会被钳）
 * @param {object} [cfg]
 * @returns {number} 半径（格）
 */
export function fireRingRadiusAt(k, cfg = FIRE_RING) {
  return cfg.startRadius + (cfg.endRadius - cfg.startRadius) * outQuint(k);
}

/**
 * 寿命进度 → 亮度系数（前 `fadeFrom` 满亮，之后线性降到 0）。
 * @param {number} k 寿命进度 0..1
 * @param {object} [cfg]
 * @returns {number} 0..1
 */
export function fireRingFadeAt(k, cfg = FIRE_RING) {
  const t = sat(k);
  if (t < cfg.fadeFrom) return 1;
  return sat((1 - t) / (1 - cfg.fadeFrom));
}

/**
 * 火星出生点与初速（**纯函数，rand 注入 ⇒ 可复现**）。
 *
 * 沿圆周分 `sparkBatches` 批撒：每批一个基准方位角 + 批内抖动
 * ⇒ 观感是「整圈都在冒火星」而不是某一处定点星爆（Storm Lance v3.20 实测教训）。
 *
 * ⚠️ **不含 y 的世界地面查找**：`y` 由调用方（装配层）给，渲染层不查体素
 * （与 `flame-sigil.js` / `spike-fx.js` 同口径）。
 *
 * @param {{x:number, y:number, z:number, radius:number}} ring 圆心与当前半径
 * @param {number} count 颗数
 * @param {() => number} rand [0,1) 均匀随机
 * @param {object} [cfg]
 * @returns {Array<{pos:number[], vel:number[], life:number, size:number}>}
 */
export function fireRingSparks(ring, count, rand, cfg = FIRE_RING) {
  const n = Math.max(0, Math.floor(count));
  const batches = Math.max(1, Math.floor(cfg.sparkBatches));
  const out = [];
  for (let i = 0; i < n; i++) {
    const b = i % batches;
    const base = (b / batches) * Math.PI * 2;
    const ang = base + (rand() - 0.5) * (Math.PI * 2 / batches);
    const dx = Math.cos(ang);
    const dz = Math.sin(ang);
    // 出生在环带上（±半宽内），不是圆心
    const r = ring.radius + (rand() - 0.5) * cfg.bandWidth;
    const speed = cfg.sparkSpeed * (0.6 + rand() * 0.8);
    out.push({
      pos: [ring.x + dx * r, ring.y, ring.z + dz * r],
      // 径向外 + 上抛：读作「火圈边缘往外窜的火星」
      vel: [dx * speed * 0.75, speed * (0.45 + rand() * 0.5), dz * speed * 0.75],
      life: cfg.sparkLifetime * (0.7 + rand() * 0.6),
      size: cfg.sparkSize * (0.6 + rand() * 0.8),
    });
  }
  return out;
}