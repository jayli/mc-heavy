// src/render/ambient-fx-config.js — 森林落叶 / 草地萤火虫的观感常量与纯函数（**three-free**）
//
// 设计：docs/superpowers/specs/2026-11-20-forest-leaves-and-fireflies-design.md
//
// 用户 2026-11-20 需求：森林 biome 里有「秋风萧瑟」的落叶（单色、无贴图、落地即消失、
// **不得高于树冠**），草地 biome 里有「稀稀落落」的萤火虫（夜里更亮更密）。
// 三项选型裁定：① 落叶配色 = **秋色加权**（不是真实叶种比例）；② 萤火虫**全天都有、夜里更亮**；
// ③ 默认开启 + 性能档自动减量，面板把「雾色」那一组换成本开关（雾色恒开）。
//
// ## 为什么两张表合一个文件，而 material / renderer 分开
//
// 两张表都是「环境特效观感量」，共享 `renderOrder` 与「跟随语义」常量（半径 / 节流 / 批大小）
// ⇒ 合一份避免漂移。而两个 pass 的 TSL 结构完全不同（正常混合的翻转薄片 vs additive 的呼吸
// 光点），合一个文件会变成 `if (kind)` 巨型分支 —— 与 `spike-fx-material` 的双 pass 不同，
// 那两个共用同一套粒子结构，本轮不共用。
//
// ⚠️ **本文件不 import three**，也不 import `leaf-fx.js` / `firefly-fx.js`
// （后者 import 本文件 ⇒ 循环）。依赖方向单向：
// `ambient-fx-config` ← `leaf-fx-material` ← `leaf-fx`（萤火虫同形）。
//
// ⚠️⚠️ **秋色权重表不是 `vegetation.js:pickLeaf` 的副本**：后者是**世界树叶**的权威
// （绿 60% / 黄 25% / 四种巨树各 3.75%），一个字节不动。本表是**落叶自己的观感表**，
// 用户明确裁定要偏黄（真实比例的期望色 sRGB 71,119,44 偏绿，秋意弱）。
// 两者刻意不同 ⇒ 各自成表、各有单测。**不是同一事实，不得「统一成一份」。**
import { CINDER_FX } from './cinder-fall-config.js';
import { normPixelRatioMode } from './pixel-ratio.js';

/**
 * 落叶（FOREST）的容量、出生带、运动与观感量（冻结，渲染层不得改写）。
 */
export const LEAF_FX = Object.freeze({
  /**
   * 容量 = 稳态并发。落叶**不设固定寿命**：出生带 3~13 格 ÷ 下落 0.55~0.9 格/秒
   * ⇒ 落地时刻 3.3~23.6 秒，寿命由「落地 + 淡出」派生 ⇒ 稳态就是「容量片都在飘」，
   * 回收即在玩家周围重新出生。220 片 / 半径 18 格的圆盘 ⇒ 约 0.22 片/格²。
   */
  capacity: 220,
  /** 性能档减半（分辨率档 → 粒子数，同 rain 的 `rainParticleCount` 手法） */
  capacityPerformance: 110,
  /** 跟随玩家的圆盘半径（格）。比雨的 24 小 —— 落叶是近景氛围，远处看不见也无所谓 */
  radius: 18,

  // ---- 出生带（用户点名的硬约束：「高于树的地方是不应该有树叶飘落的」）----
  /**
   * 出生高度下界（相对该列地面顶面，格）。矮树叶层实测 +2..+4 ⇒ 取 3 落在树冠带内。
   */
  birthMin: 3,
  /**
   * 出生高度上界（相对该列地面顶面，格）。
   *
   * 依据：33×33 森林范围内**代码生成树**的叶层聚合上界实测 **+14**（spec §3.3），
   * 取 13 留 1 格余量 ⇒ 出生点恒在树冠高度带内或以下，不会在树顶之上凭空生叶。
   *
   * ⚠️ **巨树（最高 41 格叶层）刻意不覆盖**：它们是稀疏景观（spacing 32），
   * 为它们把出生带抬到 40 会让绝大多数普通树上方全是凭空落叶 —— 那正是用户否掉的形态。
   * 巨树脚下的落叶来自同一带的普通树，观感上仍是「树在落叶」。
   *
   * ⚠️⚠️ **抬高这个值前必须重核云**：`cloud` 的 `solid` 是 **true**（`cullMode:'opaque'`），
   * 向下扫描会停在云顶（雨滴已记过「雨会停在云顶」）。云簇在 Y=35/55，而当前出生带
   * 上限「地面 +13」的扫描窗口根本到不了云 ⇒ 本轮不受影响；抬高后就会。
   */
  birthMax: 13,

  // ---- 运动（三项叠加，全在顶点着色器）----
  /**
   * 匀速下落速度区间（格/秒）。
   *
   * ⚠️ **用户 2026-11-20 裁定「落叶飘速度快一倍」** ⇒ 从首版 [0.55, 0.90] 翻倍到 [1.10, 1.80]。
   * 仍比雨滴（24）慢约 **13~22 倍** ⇒ 读作「飘」不是「掉」。
   * ⚠️ 是**匀速**不是抛物线：落叶早已达到终端速度，加速段在树冠里就完成了。
   * ⚠️ 提速后落地时刻从 3.3~23.6s 变为 **1.7~11.8s** ⇒ 回收更快，而稳态密度不变
   *（容量固定，回收即在玩家周围重新出生）。
   */
  fallSpeed: Object.freeze([1.10, 1.80]),
  /** 水平摆荡幅度区间（格）—— 「随风」的那一项 */
  swayAmp: Object.freeze([0.5, 1.1]),
  /** 摆荡角频率区间（rad/s）。z 轴用 ×0.83 的异频 ⇒ 不是直线来回而是李萨如式飘 */
  swayFreq: Object.freeze([0.6, 1.3]),
  /** 三轴自转角速度区间（rad/s）—— 「翻飞」。不转就读作纸片平移 */
  spin: Object.freeze([0.8, 2.4]),
  /**
   * 叶片边长区间（格，逐实例随机）。
   *
   * ⚠️ **下限 0.10 的依据是 v3.23 实测**：0.055 在 4~8 格距离只投影 **2.3px**
   * ⇒ 画面上等于没有。本轮距离更远（半径 18）故取 0.10~0.18，并由 Tier 4 像素复核。
   */
  size: Object.freeze([0.10, 0.18]),
  /** 屏幕尺寸硬钳（占屏高比例）—— 玩家可能正贴着叶子，不钳会糊成大色块 */
  maxScreen: 0.03,
  /** 落地时相对地面顶面的抬升（格）—— 防 z-fighting，同 rain 的 floorOffset */
  floorOffset: 0.02,
  /** 落地后淡出时长（秒）—— 「落到地上就消失掉」（用户原话），淡出而不是硬切 */
  landFadeSeconds: 0.6,
  /**
   * 薄片翻到侧面时的亮度。
   *
   * **= `sun-shade.js` 标定的正午 +Z 侧面亮度 0.845**（同一语义，不另拍一个数）：
   * `SUN_AMBIENT + SUN_INTENSITY × dot(+Z, noonSunDir)`。
   * ⚠️ 刻意**不接体素的太阳方向 uniform**：落叶是自由翻转的薄片，接方向光会让它
   * 一半时间全黑。这里只用 `abs(cos(rotX))` 做朝向近似（读作「有厚度」）。
   */
  sideShade: 0.845,

  // ---- 跟随语义（与萤火虫共用口径）----
  /** 玩家水平移动超过它就启动分批迁移（格） */
  refreshDistance: 8,
  /** 玩家竖直移动超过它就启动迁移（格）—— 上树 / 跳崖 */
  refreshVertical: 6,
  /** 距离检查节流（秒）= 30Hz，同 rain */
  refreshInterval: 1 / 30,
  /** biome 门控节流（秒）= 5Hz。`getBiome` 实测 0.028 µs/次 ⇒ 成本可忽略 */
  biomeInterval: 1 / 5,
  /** 每帧最多迁移几片（削峰，同 rain 的 64 手法）。必须 >0 且 < 容量 */
  refreshBatchSize: 32,
  /**
   * 播种失败后的重试间隔（秒）。
   *
   * ⚠️⚠️ **不得每帧重试**（自审实测的热路径缺陷）：玩家站在世界边缘 / 流式加载没跟上时，
   * 「地面扫不到」会**永久持续** ⇒ 每帧全池重扫实测 **3135 次 isSolid / 0.359ms 每帧**
   * （真实 WorldData 空世界）。取 0.25s ⇒ 摊薄到 1/15，而 column 加载完成到叶子出现
   * 最多迟 250ms（观感上不可辨，且此时玩家还在等地图长出来）。
   */
  seedRetryInterval: 0.25,
  /**
   * 向下找地面的扫描深度（格）。
   *
   * ⚠️⚠️ **不得按「出生带最高 13」来定**（本轮浏览器实测踩到）：扫描起点是**玩家高度**，
   * 而既有 spec 的标准落点是 `_teleportTo(x, 45, z)`，森林真地面在 y≈8 ⇒ 相距 **37 格**。
   * 首版取 24 ⇒ 窗口 [45,21] 够不到地面 ⇒ **220 片全部跳过**（零报错，visible/count 全对）。
   * 取 **56**（与 `rain.js` 的 `searchDepth` 同值，同一语义：从玩家高度往下找可站地面）。
   */
  searchDepth: 56,

  /**
   * transparent 队列绘制序号 —— **与 Cinder / 闪电 / 火圈同档**
   * （体素水 0 < 海面 1 < 曳光 2 < 特效 3）。空闲 `visible=false` ⇒ 队列回到基线，
   * 水面顺序不变式（`water-order.spec.mjs`）不受影响。
   */
  renderOrder: CINDER_FX.renderOrder,
});

/**
 * 秋色权重表（用户裁定「秋色加权」，取 spec §4.1 的实测 B 档）。
 *
 * 顺序 = 分箱顺序（`pickAutumnLeaf` 按累加权重命中），**不得重排** ——
 * 单测钉住了 σ=0.64 / 0.65 的分箱边界。
 *
 * ⚠️ `giant_oak_leaves` 权重 0 且**刻意不列**：它与 `leaves` 的 atlas 均色实测几乎相同
 * （28,110,48 vs 28,109,47），列进去只是把同一个色写两遍（避免「六个叶种」的假完整性）。
 *
 * 期望色 sRGB **106,135,39**（r/g **0.785**），真实叶种比例是 71,119,44（r/g 0.597）
 * ⇒ 明显转黄。
 */
export const LEAF_AUTUMN_WEIGHTS = Object.freeze([
  Object.freeze(['yellow_leaves', 0.65]),
  Object.freeze(['giant_banyan_leaves', 0.12]),
  Object.freeze(['giant_palm_leaves', 0.08]),
  Object.freeze(['leaves', 0.10]),
  Object.freeze(['giant_spruce_leaves', 0.05]),
]);

/**
 * 萤火虫（PLAINS）的容量、分布、运动与发光量（冻结）。
 */
export const FIREFLY_FX = Object.freeze({
  /**
   * 容量 = **夜间上限**（密度差走逐实例 `aAlive`，不改 instanceCount，spec §3.5）。
   * ⚠️ 已核实 `geometry.instanceCount` 每次 draw 都读，但「已建 bindGroup 后改它是否
   * 立即生效」**没有 GPU 实测** ⇒ 设计不依赖它。容量固定 + 缩零是本仓六个粒子池的成熟手法。
   */
  capacity: 168,
  capacityPerformance: 84,
  /**
   * 白天只数（用户裁定「全天都有」⇒ 不得为 0）。
   * ⚠️ 用户 2026-11-20：「萤火虫数量多一倍」⇒ 28 → 56。
   * ⚠️ 用户 2026-11-21 复报「数量太少，再增加一倍」⇒ 56 → **112**（首版至今 ×4）。
   * 白天与夜间**同比例抬**、保持 2:3 −− 只抬夜间会让白天下地里的玩家一点变化都看不到。
   * 容量必须同比例抬（上方）：不抬的形态是「夜里只数被容量静默钳住」——
   * 计数/可见性/draw call 判据全绿而密度根本没变。
   */
  countDay: 112,
  /** 夜里只数 = 容量（×1.5 白天）。首版 42 → 84 → **168** */
  countNight: 168,
  /** 跟随玩家的圆盘半径（格）。比落叶小 —— 「身边飞舞」 */
  radius: 14,
  /** 贴地高度带（相对该列地面顶面，格）—— 萤火虫在草尖上方，不在树冠里 */
  heightMin: 0.4,
  heightMax: 2.6,

  // ---- 运动：三轴异频李萨如式游走（读作「乱飞」而不是绕圈）----
  /** 三轴正弦幅度区间（格） */
  amp: Object.freeze([0.3, 0.9]),
  /** 三轴角频率区间（rad/s）。三个分量互不相同且非整数倍 ⇒ 轨迹不闭合 */
  freq: Object.freeze([0.5, 1.6]),
  /** 水平慢漂移上限（格/秒，±）。⚠️ **y 不漂移**（只正弦）⇒ 不飘上天也不钻地 */
  drift: 0.25,
  /** 寿命区间（秒）—— 到期淡出后在玩家周围重新出生（常驻场，不是「一次 spawn」） */
  lifetime: Object.freeze([6, 12]),
  /** 光点边长区间（格）—— 核心 + 光晕两层，quad 比可见光晕大一圈 */
  size: Object.freeze([0.09, 0.16]),
  /** 呼吸角频率区间（rad/s） */
  breatheFreq: Object.freeze([0.7, 1.9]),

  // ---- 发光 ----
  /**
   * 白天增益。⚠️ **上限由 CPU 复刻 ACES 实测定**：`#c8ff50` 在正午草地背景上
   * gain 0.6 时 Δ=[127,95,41]；gain 2.4 时夜间 Δb 已到 159（开始钳白）⇒ 不取 1.6 以上。
   */
  gainDay: 0.55,
  /** 夜里增益（夜间草地背景 Δ=[182,163,72]，仍满足「b 增显著小于 r 增」） */
  gainNight: 1.15,
  /** 黄绿色相（萤火虫的身份色；additive 下叠在草地上仍读作暖黄绿） */
  colorHex: 0xc8ff50,
  /** 核心边缘（归一化半径）—— `core = 1 − smoothstep(0, coreEdge, r)` */
  coreEdge: 0.35,
  /**
   * 光晕衰减指数 —— `halo = pow(1 − r, haloFalloff)`。
   * ⚠️ 必须有幂衰减，否则是硬边圆盘（v3.20b「发光鸡蛋」的既有教训）。
   */
  haloFalloff: 2.2,
  /** 屏幕尺寸硬钳（占屏高比例）—— 比落叶更紧（光点糊成大光斑就读作 bokeh） */
  maxScreen: 0.02,
  /** y 钳制的离地净空（格）—— 正弦下摆时不钻地 */
  floorClearance: 0.25,

  /** 绘制序号，与落叶同档（见 LEAF_FX.renderOrder） */
  renderOrder: CINDER_FX.renderOrder,

  // ---- 跟随语义（与落叶同口径）----
  refreshDistance: 8,
  refreshVertical: 6,
  refreshInterval: 1 / 30,
  biomeInterval: 1 / 5,
  /**
   * 批大小比落叶小（容量是它的 168/220）。2026-11-20 翻倍时按比例抬到 32；
   * 2026-11-21 容量再翻倍时**刻意保持 32**：单帧迁移成本不随容量增长（削峰优先），
   * 代价只是整池迁移从 3 帧变 6 帧（玩家移动 8 格才触发，观感无差）。
   */
  refreshBatchSize: 32,
  /** 播种失败后的重试间隔（秒）—— 同落叶，防「地面永久扫不到 ⇒ 每帧全池重扫」 */
  seedRetryInterval: 0.25,
  /** 同落叶：从玩家高度往下扫，必须容得下传送落点（45）到真地面的践离 */
  searchDepth: 56,
});

/** 区间抽样 `lo + rand() × (hi − lo)`（所有区间量的唯一写法） */
function rangeOf([lo, hi], rand) {
  return lo + rand() * (hi - lo);
}

/**
 * 一片落叶的出生数据（**纯函数，rand 注入 ⇒ 可复现**）。
 *
 * ⚠️ **圆内面积均匀**：`r = radius × sqrt(rand())`。直接拿 `rand()` 当半径会挤在圆心
 * （内半圆占 50% 而不是 25%）⇒ 玩家脚下糊成一团而四周没有叶子。
 *
 * ⚠️ **不含世界地面查找**：`groundY` 由调用方（渲染器的 `_resolveGroundY`）给。
 *
 * @param {{x:number, y:number, z:number}} center 玩家位置（只用 x/z）
 * @param {number} groundY 该列地面顶面 y
 * @param {() => number} rand [0,1) 均匀随机
 * @param {object} [cfg]
 * @returns {{x:number,y:number,z:number,minY:number,fallSpeed:number,swayAmp:number,
 *   swayFreq:number,swayPhase:number,spinX:number,spinY:number,spinZ:number,size:number}}
 */
export function leafSeedAt(center, groundY, rand, cfg = LEAF_FX) {
  const ang = rand() * Math.PI * 2;
  const r = cfg.radius * Math.sqrt(rand());
  return {
    x: center.x + Math.cos(ang) * r,
    y: groundY + cfg.birthMin + rand() * (cfg.birthMax - cfg.birthMin),
    z: center.z + Math.sin(ang) * r,
    minY: groundY + cfg.floorOffset,
    fallSpeed: rangeOf(cfg.fallSpeed, rand),
    swayAmp: rangeOf(cfg.swayAmp, rand),
    swayFreq: rangeOf(cfg.swayFreq, rand),
    swayPhase: rand() * Math.PI * 2,
    spinX: rangeOf(cfg.spin, rand),
    spinY: rangeOf(cfg.spin, rand),
    spinZ: rangeOf(cfg.spin, rand),
    size: rangeOf(cfg.size, rand),
  };
}

/**
 * 一只萤火虫的出生数据（**纯函数，rand 注入**）。
 *
 * ⚠️ **三轴频率必须互不相同且非整数倍**：同频（或整数倍）会让轨迹闭合 ⇒ 读作
 * 「绕圈的粒子」而不是「乱飞的虫」（spec §2 反目标）。做法：抽基准 f0，另两轴取
 * **无理数量级的倍率**（1.31~1.71 / 0.61~0.91）后钳进区间；钳到边界会撞相等
 * ⇒ 加一个固定微偏移错开（不用 while 重抽，避免不可预期的 rand 消耗次数）。
 *
 * ⚠️ `groundY` **存进 seed**：`fireflyMotionAt` 的 y 钳制要用它。让调用方再传一次
 * 会漂移出「两处地面不一致」（红线 1）。
 *
 * @param {{x:number,y:number,z:number}} center
 * @param {number} groundY 该列地面顶面 y
 * @param {() => number} rand
 * @param {object} [cfg]
 */
export function fireflySeedAt(center, groundY, rand, cfg = FIREFLY_FX) {
  const ang = rand() * Math.PI * 2;
  const r = cfg.radius * Math.sqrt(rand());
  const [fLo, fHi] = cfg.freq;
  const clampF = (v) => Math.min(fHi, Math.max(fLo, v));
  const f0 = rangeOf(cfg.freq, rand);
  let f1 = clampF(f0 * (1.31 + rand() * 0.4));
  let f2 = clampF(f0 * (0.61 + rand() * 0.3));
  // 钳制后可能与 f0 / 彼此相等 ⇒ 用固定微偏移错开（仍在区间内：偏移量远小于区间宽度）
  const EPS = 1e-3;
  if (Math.abs(f1 - f0) < EPS) f1 = clampF(f1 + EPS * 7);
  if (Math.abs(f2 - f0) < EPS) f2 = clampF(f2 - EPS * 7);
  if (Math.abs(f1 - f2) < EPS) f2 = clampF(f2 - EPS * 13);
  return {
    x: center.x + Math.cos(ang) * r,
    y: groundY + cfg.heightMin + rand() * (cfg.heightMax - cfg.heightMin),
    z: center.z + Math.sin(ang) * r,
    groundY,
    ampX: rangeOf(cfg.amp, rand),
    ampY: rangeOf(cfg.amp, rand),
    ampZ: rangeOf(cfg.amp, rand),
    freqX: f0,
    freqY: f1,
    freqZ: f2,
    phaseX: rand() * Math.PI * 2,
    phaseY: rand() * Math.PI * 2,
    phaseZ: rand() * Math.PI * 2,
    driftX: (rand() * 2 - 1) * cfg.drift,
    driftZ: (rand() * 2 - 1) * cfg.drift,
    size: rangeOf(cfg.size, rand),
    breatheFreq: rangeOf(cfg.breatheFreq, rand),
    breathePhase: rand() * Math.PI * 2,
    life: rangeOf(cfg.lifetime, rand),
  };
}

/**
 * 秋色抽签：σ ∈ [0,1) → 方块名。
 *
 * ⚠️ **σ 越界必须抛错**：静默落回第一项会把 yellow 的占比放大到「所有越界样本」
 * ⇒ 秋色权重表与实际分布不符，而分布判据可能仍在区间内（静默失效）。
 *
 * @param {number} sigma
 * @param {ReadonlyArray<readonly [string, number]>} [weights]
 * @returns {string}
 */
export function pickAutumnLeaf(sigma, weights = LEAF_AUTUMN_WEIGHTS) {
  if (!(sigma >= 0 && sigma < 1)) {
    throw new RangeError(`pickAutumnLeaf: sigma 必须在 [0,1)，实得 ${sigma}`);
  }
  let acc = 0;
  for (const [name, w] of weights) {
    acc += w;
    if (sigma < acc) return name;
  }
  // 权重和 <1 时最后一箱兜住（和 ≡1 由单测钉；这里不静默缩放）
  return weights[weights.length - 1][0];
}

/**
 * 落地时刻（秒）= (出生 y − minY) / 下落速度。
 * @param {ReturnType<typeof leafSeedAt>} seed
 */
export function leafLandSeconds(seed) {
  return (seed.y - seed.minY) / seed.fallSpeed;
}

/** 复用的输出对象（每帧零分配；传 `out` 时用传入的） */
const _leafOut = { x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0, landed: false, alpha: 1 };
const _flyOut = { x: 0, y: 0, z: 0 };

/**
 * 落叶运动的 **CPU 闭式复刻**（shader 侧必须逐字对应，见 `leaf-fx-material.js`）。
 *
 * ```
 * tLand = (y − minY) / fallSpeed
 * tEff  = min(t, tLand)                        // ⚠️ 落地后冻结摆荡与自转
 * y(t)  = max(y − fallSpeed × t, minY)
 * x(t)  = x + swayAmp × sin(swayFreq × tEff + swayPhase)
 * z(t)  = z + swayAmp × cos(swayFreq × 0.83 × tEff + swayPhase)
 * rot   = (spinX, spinY, spinZ) × tEff
 * alpha = landed ? clamp(1 − (t − tLand)/landFadeSeconds, 0, 1) : 1
 * ```
 *
 * ⚠️⚠️ **`tEff` 的 min 是载荷性的**：y 被钳在 minY 之后若继续摆荡 / 翻飞，
 * 读作「叶子在地上打转」（spec §4.1）。
 *
 * ⚠️ **y 单调不增**（匀速下落 + 钳底，无竖直摆荡）⇒ 「会不会入水」只需判
 * **落点 minY**，不需要逐帧扫全程（v3.30g 水下排除的单调性依据）。
 *
 * @param {ReturnType<typeof leafSeedAt>} seed
 * @param {number} tSec 自出生起的秒数
 * @param {object} [out] 复用对象；缺省用模块级常量（调用方若要留存须自己拷贝）
 * @param {object} [cfg]
 */
export function leafMotionAt(seed, tSec, out = _leafOut, cfg = LEAF_FX) {
  const tLand = leafLandSeconds(seed);
  const t = Math.max(0, tSec);
  const tEff = Math.min(t, tLand);
  out.x = seed.x + seed.swayAmp * Math.sin(seed.swayFreq * tEff + seed.swayPhase);
  out.y = Math.max(seed.y - seed.fallSpeed * t, seed.minY);
  out.z = seed.z + seed.swayAmp * Math.cos(seed.swayFreq * 0.83 * tEff + seed.swayPhase);
  out.rotX = seed.spinX * tEff;
  out.rotY = seed.spinY * tEff;
  out.rotZ = seed.spinZ * tEff;
  out.landed = t >= tLand;
  out.alpha = out.landed
    ? Math.min(1, Math.max(0, 1 - (t - tLand) / cfg.landFadeSeconds))
    : 1;
  return out;
}

/**
 * 萤火虫运动的 **CPU 闭式复刻**（shader 侧逐字对应）。
 *
 * ```
 * x(t) = x + driftX × t + ampX × sin(freqX × t + phaseX)
 * y(t) = max(y + ampY × sin(freqY × t + phaseY), groundY + floorClearance)
 * z(t) = z + driftZ × t + ampZ × sin(freqZ × t + phaseZ)
 * ```
 *
 * ⚠️ **y 没有漂移项**：加了它会飘上天或钻地（spec §4.2）。
 *
 * @param {ReturnType<typeof fireflySeedAt>} seed
 * @param {number} tSec
 * @param {object} [out]
 * @param {object} [cfg]
 */
export function fireflyMotionAt(seed, tSec, out = _flyOut, cfg = FIREFLY_FX) {
  const t = Math.max(0, tSec);
  out.x = seed.x + seed.driftX * t + seed.ampX * Math.sin(seed.freqX * t + seed.phaseX);
  out.y = Math.max(
    seed.y + seed.ampY * Math.sin(seed.freqY * t + seed.phaseY),
    seed.groundY + cfg.floorClearance,
  );
  out.z = seed.z + seed.driftZ * t + seed.ampZ * Math.sin(seed.freqZ * t + seed.phaseZ);
  return out;
}

/**
 * 夜间派生：亮度增益与只数（**唯一权威在 `daynight.js:nightBlendOf`**，
 * 本函数只做插值，不自己算夜间程度）。
 *
 * ⚠️ `count` 上限是 `capacity`：越界会让 `aAlive` 写越界（静默丢失尾部实例）。
 *
 * @param {number} nb 夜间程度 0..1（0=白昼 1=深夜）
 * @param {object} [cfg]
 * @returns {{gain:number, count:number}}
 */
export function fireflyNightAt(nb, cfg = FIREFLY_FX) {
  const k = Number.isFinite(nb) ? Math.min(1, Math.max(0, nb)) : 0;
  return {
    gain: cfg.gainDay + (cfg.gainNight - cfg.gainDay) * k,
    count: Math.min(cfg.capacity, Math.round(cfg.countDay + (cfg.countNight - cfg.countDay) * k)),
  };
}

/**
 * 分辨率档 → 粒子容量（几何容量在构造期固定 ⇒ 切档必须 dispose 重建，同 `_rebuildRain`）。
 *
 * @param {*} mode 档位（非法值经 `normPixelRatioMode` 回落清晰档）
 * @param {'leaf'|'firefly'} kind
 * @returns {number}
 */
export function ambientParticleCount(mode, kind) {
  const cfg = kind === 'firefly' ? FIREFLY_FX : LEAF_FX;
  return normPixelRatioMode(mode) === 'performance' ? cfg.capacityPerformance : cfg.capacity;
}