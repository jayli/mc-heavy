// src/render/storm-rain-config.js — 持续雨（雨天光影档）的观感常量（**three-free**）
//
// 上游：`~/jaylli/bj-shooting-game/night-heron-src/src/fx/rain.js`
// （`Rain(scene, col, count=5200)`：GPU 雨丝 + CPU 生成的水花冠）。
// **数值逐项取自上游**，用户要求「下雨的特效就完全复用 bj-shooting-game 里的」。
//
// ## 与上游的三处必要改写
//   ① **遮挡走体素而不是 shelter 贴图**：上游把「每格最低遮盖高度」烘成一张
//      `uShelter` 纹理（关卡是静态的）。本仓世界无边界、玩家可挖可放 ⇒ 静态贴图会过期。
//      改用**逐滴 CPU 解析 + 逐实例属性**（`aMinY`），与既有 `rain.js` 同手法，
//      判据走 `rain-shelter.js`（屋顶拦、树叶/云/空岛不拦、上界在云下）。
//   ② **雨幕盒心钳在云层之下**（用户裁定）：上游盒子跟着相机自由上下。
//   ③ **不接动态点光源**（上游 `particleLight`）：本仓全场景 unlit，
//      雨丝亮度改由「天空环境色 × 日夜 skyDim」给（复用体素那两个 uniform 实例）。
//
// ⚠️ 本文件不 import three（Node 单测直接读）。

/** 雨丝（上游 streaks） */
export const STORM_STREAK = Object.freeze({
  /**
   * 粒子数（上游 5200）。**性能档减半**（同既有 rain 的 `rainParticleCount` 手法）。
   * ⚠️ 容量在 `InstancedBufferGeometry` 构造期固定 ⇒ 切档必须 dispose 重建。
   */
  count: 5200,
  countPerformance: 2600,
  /**
   * 雨幕盒边长（上游 `uBox = (24, 18, 24)`，单位米）。
   * ⚠️ 本仓 1 格 = 1 米，故直接用同值（格）。
   */
  box: Object.freeze([24, 18, 24]),
  /** 下落速度（上游 `uVel = (1.6, 13.0, 0.7)`：x/z 是风，y 是下落） */
  vel: Object.freeze([1.6, 13.0, 0.7]),
  /** 逐滴速度差（上游 `sp = 0.75 + 0.5*fract(...)`） */
  speedMin: 0.75,
  speedRange: 0.5,
  /** 雨丝长度（上游 `aCorner.y * 0.34 * sp`） */
  length: 0.34,
  /** 半宽（上游 `max(0.006, dist*0.0011)`） */
  widthMin: 0.006,
  widthPerDistance: 0.0011,
  /** 近处淡入 / 远处淡出（上游 `smoothstep(1.0,3.2,dist)` 与 box.x 的 0.36→0.5） */
  nearFadeFrom: 1.0,
  nearFadeTo: 3.2,
  farFadeFromRatio: 0.36,
  farFadeToRatio: 0.5,
  /** 亮度增益（上游 `vCol = amb * fade * uGain * 0.12`） */
  gain: 0.12,
  /**
   * transparent 队列序号。**排在既有雨滴之后、特效之前**。
   * 体素水 0 < 海面 1 < 曳光 2 < 特效 3 ⇒ 雨丝取 **2**（与曳光同档，都是 additive 细线，
   * 互不遮挡；深度测试保留 ⇒ 被地形正常挡住）。
   */
  renderOrder: 2,
});

/** 水花冠（上游 splashes） */
export const STORM_SPLASH = Object.freeze({
  /** 池容量（上游 `M = 260`） */
  capacity: 260,
  /** 单朵寿命（上游 `age = (uTime - birth) / 0.26`） */
  life: 0.26,
  /** 每秒生成上限（上游 `rate = 520`，`setDensity` 时 300+320k） */
  rate: 520,
  ratePerformance: 300,
  /** 每帧最多生成几朵（上游 `min(40, floor(acc))` —— 削峰） */
  perFrameCap: 40,
  /** 生成半径（上游 `r = 1.2 + random*random*15`：平方 ⇒ 近处密） */
  radiusMin: 1.2,
  radiusRange: 15,
  /** 生成角扇（上游 `atan2(camDir.x, camDir.z) + (random-0.5)*2.6`） */
  angleSpread: 2.6,
  /** 宽度/高度曲线（上游 `(0.02+age*0.05)` / `(0.012+sin(age*π)*0.075)`） */
  widthBase: 0.02,
  widthGrow: 0.05,
  heightBase: 0.012,
  heightArc: 0.075,
  /** 亮度（上游 `* 0.14 * (1-age*0.7) * smoothstep(20,10,dist)`） */
  gain: 0.14,
  ageFade: 0.7,
  distFadeFrom: 20,
  distFadeTo: 10,
  /** 出生高度抬升（防 z-fighting；上游 `groundAt(...) + 0.01`） */
  floorOffset: 0.01,
  /** 高于玩家眼高这么多就不生成（上游 `y > camPos.y + 0.6` 跳过） */
  maxAboveEye: 0.6,
  renderOrder: 2,
});

/**
 * 雨声与雷声（烘焙产物，配方来自上游 `_startAmbience` / `thunder`）。
 * ⚠️ id 必须在 `CARBINE_AUDIO_IDS` 里（单测钉住）。
 */
export const STORM_AUDIO = Object.freeze({
  /** 雨声床（12s 立体声循环） */
  rainLoop: 'rain_storm',
  /** 雨声音量上限（实际 = 本值 × 强度，与既有 rain 的 SOUND_VOLUME 同手法） */
  rainVolume: 0.5,
  /** 远雷 */
  thunder: 'rain_thunder',
  thunderVolume: 0.35,
  /** 雷声间隔区间（秒）—— 随机而不是固定周期（固定周期听得出节拍） */
  thunderInterval: Object.freeze([25, 70]),
});

/**
 * 雨丝的下落位移（GPU 闭式，CPU 侧同构参考实现）。
 *
 * 上游顶点：`p = position*uBox + vel*uTime`，再 `mod(p - camPos + box/2, box) - box/2 + camPos`
 * ⇒ 雨幕在绕相机的盒子里循环。**盒子随相机平移，雨丝相对盒子静止循环**。
 *
 * ⚠️ 本函数只算「未 wrap 的原始位置」，供单测钉住速度/相位关系；
 * wrap 与 billboard 在 GPU 侧（TSL）做。
 *
 * @param {number[]} seed 逐滴种子 [0,1)³
 * @param {number} t 绝对秒
 * @param {object} [cfg]
 * @returns {number[]} 原始世界位置（未 wrap）
 */
export function stormStreakRawPos(seed, t, cfg = STORM_STREAK) {
  const sp = cfg.speedMin + cfg.speedRange * fract(seed[0] * 7.31 + seed[2] * 3.17);
  return [
    seed[0] * cfg.box[0] + cfg.vel[0] * t,
    seed[1] * cfg.box[1] - cfg.vel[1] * sp * t,
    seed[2] * cfg.box[2] + cfg.vel[2] * t,
  ];
}

/** GLSL fract 的 JS 同构 */
function fract(x) { return x - Math.floor(x); }

/**
 * 水花冠的尺寸包络（上游顶点逐字）。
 * @param {number} age01 归一化年龄 0..1
 * @param {object} [cfg]
 * @returns {{width:number, height:number, alive:boolean}}
 */
export function stormSplashSize(age01, cfg = STORM_SPLASH) {
  const alive = age01 >= 0 && age01 <= 1;
  if (!alive) return { width: 0, height: 0, alive: false };
  return {
    width: cfg.widthBase + age01 * cfg.widthGrow,
    height: cfg.heightBase + Math.sin(age01 * Math.PI) * cfg.heightArc,
    alive: true,
  };
}

/**
 * 水花的亮度衰减（上游 `(1-age*0.7) * smoothstep(20,10,dist)`）。
 * @param {number} age01 @param {number} dist 到相机距离（格）
 * @param {object} [cfg]
 * @returns {number} 0..1 的乘数
 */
export function stormSplashFade(age01, dist, cfg = STORM_SPLASH) {
  const ageK = Math.max(0, 1 - age01 * cfg.ageFade);
  // smoothstep(20, 10, dist)：近处 1、远处 0（反向 smoothstep）
  const t = Math.max(0, Math.min(1, (dist - cfg.distFadeFrom) / (cfg.distFadeTo - cfg.distFadeFrom)));
  const distK = t * t * (3 - 2 * t);
  return ageK * distK;
}

/**
 * 档位 → 雨丝数（唯一权威在本表，装配层不写字面量）。
 * @param {'sharp'|'performance'} mode
 * @returns {number}
 */
export function stormStreakCount(mode) {
  return mode === 'performance' ? STORM_STREAK.countPerformance : STORM_STREAK.count;
}

/**
 * 档位 → 水花生成速率。
 * @param {'sharp'|'performance'} mode
 * @returns {number}
 */
export function stormSplashRate(mode) {
  return mode === 'performance' ? STORM_SPLASH.ratePerformance : STORM_SPLASH.rate;
}

/** 雨丝池账：盒体积内的密度（滴/格³）—— 单测用它钉「性能档确实减半」 */
export function stormStreakDensity(mode) {
  const b = STORM_STREAK.box;
  return stormStreakCount(mode) / (b[0] * b[1] * b[2]);
}