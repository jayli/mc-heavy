// src/entities/soldiers/soldier-config.js — 士兵玩法数值的**唯一权威**
//
// 同构层：**无 DOM、无 three、不新增 Worker**（`npm run check:arch` 静态门守）。
// Agent / Service / 渲染器 / 武器接线 / 测试都从这里派生，不得各自写字面量（红线 1）。
//
// 数值出处：上游 `~/jaylli/bj-shooting-game/night-heron-src/src/game/enemies.js`
// 的 `Soldier` 类（逐项读源，非推断）。**三条用户裁定**（2026-11-24）：
//   ① 同时存活上限 **10**；② 每发子弹扣玩家 **2 血**（本仓玩家满血 40，上游是 100）；
//   ③ 掩体方案取 **B**：不扫体素找掩体，用「距离环 + 侧向游走 + 周期蹲起」代替。
//
// 设计文档 `docs/superpowers/specs/2026-11-24-soldier-enemy-port-design.md`。

/** 实体 type（`EntityManager` 的注册键，也是 id 前缀语义） */
export const SOLDIER_TYPE = 'soldier';

/**
 * 体形与生命。
 *
 * ⚠️ **width/height 与丧尸逐位相同是载荷性的**：`zombie-pathfinder.js` 的
 * `DEFAULT_BOX`、`zombieCollidesAt`、`steerIntentAabb` 的缺省参数全部按 0.6×1.8×1.0 标定。
 * 同尺寸 ⇒ 士兵可直接复用那一整套寻路/避障/物理，零新几何。改这两个值会静默让
 * 「规划得出、物理走不通」（本仓已记的漂移形态）。
 * 上游 `radius 0.32`（直径 0.64）取整到 0.6 与丧尸对齐 —— 有意偏离，理由是复用。
 *
 * ⚠️ **`maxStep` 是唯一有意与丧尸不同的几何参数**（用户 2026-11-26）：士兵 2.0 / 丧尸 1.0。
 * 它不影响 AABB，只影响「能抬多高」，且所有调用方都**显式传 box**（不用缺省值）。
 */
export const SOLDIER = Object.freeze({
  /** 同时存活上限（用户裁定 10）。⚠️ 判定只数**活着的**，留尸不占名额 */
  maxAlive: 10,
  /** 生命（上游 `this.health = 100`） */
  health: 100,
  /** AABB 宽（上游 radius 0.32 → 直径 0.64，对齐丧尸 0.6） */
  width: 0.6,
  /** AABB 高（上游 `this.height = 1.8`） */
  height: 1.8,
  /** 红闪时长（ms），与丧尸/焰魔/守卫同口径 */
  flashMs: 200,
  /**
   * 死后留尸时长（秒，上游 `if (this.deadT < 1.2)`）。
   * ⚠️ 留尸期间实体仍在 EntityManager 里 ⇒ **上限判定不能用 `entities.count()`**
   * （那会把尸体算进名额，形态是「打死后 1.2s 内按 C 没反应」而数值全对）。
   */
  deadLingerSeconds: 1.2,
  /**
   * 台阶上限（格）—— **士兵 2 格，有意强于丧尸的 1 格**（用户 2026-11-26：
   * 「现在 soldier 掉进坑里一般情况是出不来的……可以上 2 级台阶，三级台阶就上不去了」）。
   *
   * ⚠️⚠️ **光改本常量曾经无效**：旧实现的 `zombieStepUpY` 恒抬 1 格，`maxStep` 只是
   * 上限门控 ⇒ 1.0 与 2.0 逐位等价（`docs/pitfalls.md`「maxStep 是死值」）。
   * 现在共用层的 `resolveStepUpY` 按本值逐级试，它才真的生效。
   *
   * ⚠️ **渲染层的 `StepLift` 必须传同一个值**（`soldier-renderer.js`）：缺省封顶 1 格
   * 会把 2 格抬升截断成「瞬时跳 1 格 + 缓动 1 格」。
   */
  maxStep: 2.0,
  /** 重力（格/秒²，与丧尸/玩家同口径 −24） */
  gravity: -24.0,
});

/**
 * AI 参数（方案 B）。上游 `thinkStep()` / `update()` 逐值，掩体三项换成距离环。
 */
export const SOLDIER_AI = Object.freeze({
  /** 决策周期（秒）= 20Hz，与丧尸 `aiPeriod` 同口径 */
  aiPeriod: 0.05,
  /** 巡逻速度（上游 `speed = 1.5`） */
  patrolSpeed: 1.5,
  /** 搜索速度（上游 `state === 'search' ? 2.8`） */
  searchSpeed: 2.8,
  /** 战斗速度（上游 `combat ? 4.0`） */
  combatSpeed: 4.0,
  /** 巡逻态发现距离（上游 `sees(27, …)`） */
  sightRangePatrol: 27,
  /** 搜索态发现距离（上游 `sees(34, …)`） */
  sightRangeSearch: 34,
  /** 巡逻视锥余弦（上游 fovCos 0.42） */
  fovCosPatrol: 0.42,
  /** 搜索视锥余弦（上游 fovCos 0.1） */
  fovCosSearch: 0.1,
  /** 战斗态视线射程（上游 `sees(60, -2, …)`，-2 = 不限视锥） */
  combatLosRange: 60,
  /**
   * 站定环下界（格）—— **方案 B 的身份载体**。
   * 距玩家小于它就后退拉开；上游是「找掩体」，本仓无掩体数据故用距离环。
   * ⚠️ 改小它会让士兵直冲贴身 ⇒ 退化成「会开枪的丧尸」（spec 反目标）。
   */
  standoffMin: 8,
  /** 站定环上界（格）：大于它就推进。上游 `d > 20 ? 1.5` */
  standoffMax: 20,
  /** 远于上界时的径向推进分量（上游 `toward = 1.5`） */
  towardFar: 1.5,
  /** 近于下界时的径向后退分量（上游 `d < 8 ? -1.5`） */
  towardNear: -1.5,
  /** 侧向游走换向间隔下界（秒，上游 `strafeT = rand(0.9, 2.0)`） */
  strafeFlipMin: 0.9,
  /** 侧向游走换向间隔上界 */
  strafeFlipMax: 2.0,
  /** 侧向目标点距离（格，上游 `px * this.strafe * 2`） */
  strafeReach: 2,
  /** 站姿持续下界（秒，上游 `peekT = rand(1.6, 2.8)`） */
  peekStandMin: 1.6,
  /** 站姿持续上界 */
  peekStandMax: 2.8,
  /** 蹲姿持续下界（秒，上游 `rand(0.8, 1.9)`） */
  peekCrouchMin: 0.8,
  /** 蹲姿持续上界 */
  peekCrouchMax: 1.9,
  /** 蹲下时身体下沉量（格，上游 `body.position.y = -cr * 0.44`） */
  crouchDrop: 0.44,
  /** 站姿眼高（上游 `eyeY() = lerp(1.56, 1.0, crouch)` 的站端） */
  eyeYStand: 1.56,
  /** 蹲姿眼高（同上的蹲端） */
  eyeYCrouch: 1.0,
  /** 看不见玩家时 awareness 每秒衰减（上游 `- dtT * 0.28`） */
  awarenessDecayPerSecond: 0.28,
  /** search 态持续（秒，上游 `searchT = 7`） */
  searchSeconds: 7,
  /** 多久没看见就转 search（秒，上游 `since > 12`） */
  loseSightToSearchSeconds: 12,
  /** 巡逻等待下界（秒，上游 `wait = rand(1.5, 4)`） */
  patrolWaitMin: 1.5,
  /** 巡逻等待上界 */
  patrolWaitMax: 4,
  /** 巡逻踱步半径（格）—— 方案 B 替代上游手写 route */
  patrolRadius: 3,
  /** 卡住判定窗口（秒，上游 `stuckT > 0.7`） */
  stuckSeconds: 0.7,
  /** 卡住判定净位移阈值（格，上游 `< 0.25`） */
  stuckDistance: 0.25,
  /** 班组报警半径（格，上游 `alertOthers(this, 34)`） */
  alertRadius: 34,
  /** 报警延迟下界（秒，上游 `rand(0.5, 1.4) + d * 0.03`） */
  alertDelayMin: 0.5,
  /** 报警延迟上界 */
  alertDelayMax: 1.4,
  /** 报警延迟的距离系数（秒/格） */
  alertDelayPerBlock: 0.03,
  /** 听枪声半径（格，上游 `hearShot` 的 `d > 48` 早退） */
  hearRadius: 48,
  /** 听到枪声后的 search 时长（秒，上游 `searchT = 6`） */
  hearSearchSeconds: 6,
  /** 听到枪声后 awareness 下限（上游 `Math.max(e.awareness, 0.45)`） */
  hearAwarenessFloor: 0.45,
  /** advancer 重选周期（秒，上游 `advT = 2`） */
  advancerPeriod: 2,
  /** advancer 推进所需的「多久没看见」（秒，上游 `since > 2.5`） */
  advancerSinceSeconds: 2.5,
  /** 战斗态转身速率（上游 `dt * 9`） */
  turnRateCombat: 9,
  /** 非战斗态转身速率（上游 `dt * 4.5`） */
  turnRateIdle: 4.5,
});

/**
 * 开火参数（上游 `shootAt()` 与 `update()` 的点射段逐值）。
 */
export const SOLDIER_SHOT = Object.freeze({
  /**
   * 每发扣玩家血量 —— **用户裁定 2**（上游是 8，但那是按 100 血玩家标的；
   * 本仓玩家满血 40，照搬 8 会让一轮点射直接打空）。
   */
  playerDamage: 2,
  /** 一轮点射发数下界（上游 `Math.floor(rand(3, 6))`） */
  burstMin: 3,
  /** 一轮点射发数上界 */
  burstMax: 6,
  /** 发间隔（秒，上游 `shotT = 0.105`） */
  shotInterval: 0.105,
  /** 有视线时两轮间隔下界（秒，上游 `rand(0.8, 1.7)`） */
  burstGapLosMin: 0.8,
  /** 有视线时两轮间隔上界 */
  burstGapLosMax: 1.7,
  /** 盲射时两轮间隔下界（秒，上游 `rand(1.4, 2.6)`） */
  burstGapBlindMin: 1.4,
  /** 盲射时两轮间隔上界 */
  burstGapBlindMax: 2.6,
  /**
   * 同一时刻最多几名士兵在点射（上游 `if (this.mgr.bursting < 2)`）。
   * ⚠️ 这是「不被 10 个士兵瞬间齐射打空」的唯一闸门，删了它玩家几乎必死。
   */
  maxConcurrentBursts: 2,
  /** 名额已满时的重试间隔下界（秒，上游 `rand(0.2, 0.5)`） */
  burstBusyGapMin: 0.2,
  /** 名额已满时的重试间隔上界 */
  burstBusyGapMax: 0.5,
  /** 首轮命中率基数（上游 `this.firstBurst ? 0.4 : 0.66`） */
  accuracyFirst: 0.4,
  /** 后续轮命中率基数 */
  accuracyRest: 0.66,
  /** 命中率的距离衰减（每格，上游 `d * 0.011`） */
  accuracyPerBlock: 0.011,
  /** 命中率的玩家速度衰减（上游 `p.speed * 0.03`） */
  accuracyPerSpeed: 0.03,
  /** 玩家腾空时的命中率惩罚（上游 `p.grounded ? 0 : 0.12`） */
  accuracyAirPenalty: 0.12,
  /** 命中率下界（上游 `clamp(…, 0.06, 0.82)`） */
  accuracyMin: 0.06,
  /** 命中率上界 */
  accuracyMax: 0.82,
  /** 未命中时散布半径下界（格，上游 `0.5 + Math.random() * 1.1`） */
  missRadiusMin: 0.5,
  /** 未命中时散布半径增量 */
  missRadiusRange: 1.1,
  /** 未命中时弹着点相对玩家脚底的高度下界（上游 `p.pos.y + 0.4 + …`） */
  missYMin: 0.4,
  /** 未命中时高度增量（上游 `Math.random() * 1.6`） */
  missYRange: 1.6,
  /** 开火允许的 yaw 误差（弧度，上游 `< 0.35`） */
  fireYawTolerance: 0.35,
  /** 开火允许的蹲姿上限（上游 `exposed = this.crouch < 0.35`） */
  fireCrouchMax: 0.35,
  /** 压制射击的「多久没看见」下界（秒，上游 `> 0.6`） */
  suppressSinceMin: 0.6,
  /** 压制射击的上界（上游 `< 8`） */
  suppressSinceMax: 8,
  /** 弹道最大距离（格，上游 `col.raycast(…, 80, …)`） */
  maxDistance: 80,
  /** 进入战斗后的反应延迟下界（秒，上游 `rand(0.45, 0.85)`） */
  reactionMin: 0.45,
  /** 反应延迟上界 */
  reactionMax: 0.85,
  /**
   * 枪口相对 **torso 局部原点** 的偏移（上游 `muzzle.position.set(0.07, 0.39, 0.98)`）。
   * ⚠️ 唯一权威：渲染层的枪口锚点与 Agent 的弹道起点都读它，各写一份会漂移出
   * 「曳光从枪管旁边射出」（数值全绿，只有画面能看出）。
   */
  muzzleLocal: Object.freeze([0.07, 0.39, 0.98]),
  /** torso 相对 body 原点的高度（上游 `mk(GEO.torso, this.body, 0, 1.0, 0)`） */
  torsoPivotY: 1.0,
});

/** 士兵曳光（上游 `tracers.fire(…, [12,3.5,1.5], 170, 0.013)`，与玩家 KV-9 不同色） */
export const SOLDIER_TRACER = Object.freeze({
  /** 线性 HDR 色（不是 sRGB hex） */
  color: Object.freeze([12, 3.5, 1.5]),
  /** 曳光头推进速度（格/秒） */
  speed: 170,
  /** 半宽（格） */
  width: 0.013,
});

/** 步态与姿态（上游 `update()` 的 pose 段逐值） */
export const SOLDIER_GAIT = Object.freeze({
  /** 相位累积系数（上游 `walk += speedCur * dt * 2.6`） */
  phasePerBlock: 2.6,
  /** 大腿摆幅（弧度，上游 `sw * 0.62 * k`） */
  thighSwing: 0.62,
  /** 小腿摆幅（弧度，上游 `Math.max(0, ±cos(walk)) * 0.9 * k`） */
  shinSwing: 0.9,
  /** 蹲姿左大腿基准角（上游 `- cr * 1.25`） */
  crouchThighL: -1.25,
  /** 蹲姿右大腿基准角（上游 `- cr * 0.35`） */
  crouchThighR: -0.35,
  /** 蹲姿左小腿基准角（上游 `+ cr * 1.75`） */
  crouchShinL: 1.75,
  /** 蹲姿右小腿基准角（上游 `+ cr * 1.6`） */
  crouchShinR: 1.6,
  /** 行走上下起伏幅度（格，上游 `Math.abs(Math.cos(walk)) * 0.03 * k`） */
  bobAmplitude: 0.03,
  /** 每发开火的躯干后坐（弧度，上游 `torso.rotation.x -= 0.03`） */
  torsoRecoilPerShot: 0.03,
  /** 瞄准俯仰下限（弧度，上游 `clamp(…, -0.7, 0.9)`） */
  aimPitchMin: -0.7,
  /** 瞄准俯仰上限 */
  aimPitchMax: 0.9,
});

/**
 * 局部避障档位 —— **与丧尸 `ZOMBIE_STEERING` 同值**（同尺寸 ⇒ 同一套几何标定）。
 * ⚠️ 不 import 丧尸那份而是各自冻结：两者是不同实体的玩法数据，将来调士兵的
 * 绕行手感不应该连带改丧尸（那是既有冻结值）。同值这件事由单测钉住。
 */
export const SOLDIER_STEERING = Object.freeze({
  probeDistance: 1.2,
  anglesDeg: Object.freeze([22.5, 45, 67.5, 90]),
});

/**
 * C 键落点选取（用户 2026-11-27 实玩报告：「按 c 有时候会把 soldier 生成到地下矿洞里……
 * 尽量生成在跟玩家一个水平线上的空间内，即便有高度差，也要在一个联通的空间内」）。
 *
 * ☠️ **旧口径的病根**：随机角度 2~10 格 + **从玩家高度向下扫 64 格**，取第一个
 * 「本格 air + 上格 air + 下格 solid」。那条判据只问「这一格能不能站」，
 * 不问它与玩家是否连通、差多少高度 ⇒ 洞穴顶板天然满足它。
 * 实测（seed 12345 真实地形 8 点 × 200 次）最深 **−39 格**；浏览器真实按键 20 次里
 * 出现 −32 / −28 / −26。改成**从玩家出发的有界连通洪泛**后可达性由构造保证。
 */
export const SOLDIER_SPAWN = Object.freeze({
  /**
   * 常态高度差上限（格，双向）—— **用户裁定 ±3**。
   * 实测自然地形 11 点在此档仍有 185~308 个候选落点（远多于需要的 1 个）。
   */
  maxDy: 3,
  /**
   * 放宽档高度差（格）—— 用户裁定「附近确实没有合法落点时放宽高度差再试一次」。
   * ⚠️ **放宽只动高度带，空气通路判据一次都不放松** ⇒ 不会把落点放进封死的深洞
   * （实测地表玩家在 band 3/8/16 下最深恒为 −2~−4）。
   */
  relaxedDy: 8,
  /**
   * 单步允许的高度变化（格）= 士兵的台阶能力，**派生不写字面量**（红线 1）。
   * 走不通的高度差就不算「连通」—— 与物理 step-up 同源。
   */
  stepPerCell: SOLDIER.maxStep,
  /** 洪泛半径（切比雪夫格）—— 覆盖取距上界 10 + 一格余量 */
  radius: 11,
  /** 访问格上限（防病态地形把主线程拖住）。实测常态 visited≈529，耗时 0.21ms */
  maxCells: 1200,
  /** 落点水平距下界（格）—— 与旧口径逐位相同 */
  minDist: 2,
  /** 落点水平距上界（格）—— 与旧口径逐位相同 */
  maxDist: 10,
  /**
   * 兜底②：玩家自己那一列往下找支撑面的最大深度（格）。
   * 玩家悬空/飞行时它不在任何水平面上，取「脚下地面」是最忠实解释。
   * 64 与旧扫描深度同值（世界高 128，够从任何高度落到地表）。
   */
  selfSupportDrop: 64,
});

/**
 * 按 slot 派生实体 id（与丧尸 `z${slot}` 同手法）。
 * ⚠️ **不用 `Math.random()`**：id 随 slot 复用，确定性可测（红线 2 精神）。
 * @param {number} slot @returns {string}
 */
export function soldierEntityIdFor(slot) {
  return `s${slot}`;
}

/**
 * awareness 累积速率（上游 `thinkStep` 的四档距离表 × 两个倍率）。
 *
 * @param {number} dist 到玩家的距离（格）
 * @param {boolean} sprinting 玩家是否在疾跑（上游 `p.sprinting ? 1.5 : 1`）
 * @param {boolean} searching 自己是否在 search 态（上游 `? 1.8 : 1`）
 * @returns {number} 每秒累积量
 */
export function soldierAwarenessRate(dist, sprinting, searching) {
  const base = dist < 6 ? 4.2 : dist < 13 ? 1.7 : dist < 21 ? 0.9 : 0.5;
  return base * (sprinting ? 1.5 : 1) * (searching ? 1.8 : 1);
}

/**
 * 眼高（上游 `eyeY() { return lerp(1.56, 1.0, this.crouch); }`）。
 * @param {number} crouch 0=站 / 1=蹲
 * @returns {number} 相对脚底的高度
 */
export function soldierEyeY(crouch) {
  const k = Number.isFinite(crouch) ? crouch : 0;
  return SOLDIER_AI.eyeYStand + (SOLDIER_AI.eyeYCrouch - SOLDIER_AI.eyeYStand) * k;
}

/**
 * 枪口世界坐标（弹道起点与曳光起点的唯一算法）。
 *
 * ⚠️⚠️ **yaw→前向口径必须与丧尸一致**：前向 = `(sin yaw, cos yaw)`
 * （丧尸 `yaw = atan2(vx, vz)`）。**不是** Boss 那套 `(-sin yaw, -cos yaw)` ——
 * 用错一侧的形态是「士兵背对玩家开枪」，而所有数值判据全绿。
 *
 * 变换顺序：torso 局部偏移 → 加 torso 轴心高度 → 减蹲姿下沉 → 绕 Y 转 yaw → 加 position。
 * 旋转式与 `guardianAabbFor` 同式（`x' = lx·cos + lz·sin`，`z' = −lx·sin + lz·cos`）。
 *
 * @param {number[]} position 脚底 [x,y,z]
 * @param {number} yaw 弧度
 * @param {number} crouch 0..1
 * @returns {[number,number,number]}
 */
export function soldierMuzzleWorld(position, yaw, crouch) {
  const [lx, ly, lz] = SOLDIER_SHOT.muzzleLocal;
  const k = Number.isFinite(crouch) ? crouch : 0;
  const y = ly + SOLDIER_SHOT.torsoPivotY - k * SOLDIER_AI.crouchDrop;
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  return [
    position[0] + lx * cos + lz * sin,
    position[1] + y,
    position[2] - lx * sin + lz * cos,
  ];
}