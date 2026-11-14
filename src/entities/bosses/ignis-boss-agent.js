// src/entities/bosses/ignis-boss-agent.js — 焰魔 Boss 智能体：地面三态机（v2.55）
//
// 同构层：**无 DOM、无 three、不新增 Worker**（`check:arch` 的 `ISOMORPHIC_DIRS` 静态门守）。
//
// `BossAgent` 的焰魔子类（用户的解耦指令：每个 Boss 都有自己的智能体类）。
//
// ## 三态机
//
//   idle ──(视线通 + 水平距 ≤ sightRange)──▶ chase
//   chase ──(水平距 ≤ attackRange)──▶ attack
//   attack ──(动画播完)──▶ chase
//   attack ──(水平距 > disengageRange / 视线断)──▶ chase（中断动画）
//   chase ──(视线断)──▶ idle
//
// ## 与飞龙 Agent 的四处结构性差异（不要照抄 dragon-boss-agent）
//
// 1. **`position` 是脚底**（飞龙是身体中心）：重力、碰撞盒、命中判据全按脚底算。
// 2. **有物理**：重力 + 分轴碰撞 + step-up，**复用** `zombies/zombie-navigation.js` 的
//    `aabbCollidesAt` / `steerIntentAabb`（v2.55 参数化）—— 不写第二份碰撞判据（红线 1）。
// 3. **攻击是挥剑扣血**（不是生成实体）：意图写进 `attackRequest`（瞬态），
//    由 `game.js` 在 `entities.update` 之后结算。理由同飞龙的 `fireRequest`：
//    生成/伤害是主线程装配层职责，`entities/` 同构层不得 import `player/`。
// 4. **无俯仰/无轨道**：地面 Boss 恒竖直 0，yaw 是唯一的姿态自由度。
//
// ## 三条载荷性约定（与飞龙同）
//
// 1. **只读 state 与 ctx，返回全新 state 各字段**（plain 对象）。不得原地改写 state ——
//    M5 不变式：`EntityManager.update` 的跨 column 索引迁移判据是「赋值前 position vs
//    赋值后 position」，原地改写会让 before/after 从同一份算出 → 恒相等 → 索引永不迁移。
// 2. **不生成实体、不改世界、不改玩家血量**。只写 `attackRequest` 意图。
// 3. **命中只在一帧触发**：`attackAnimT` 越过 `hitFrameSeconds` 的那一帧（不是每帧）。

import { BossAgent } from './boss-agent.js';
import { IGNIS, IGNIS_AI, IGNIS_ATTACKS, IGNIS_ATTACK_IDS, IGNIS_STEERING }
  from '../ignis/ignis-config.js';
import { aabbCollidesAt, steerIntentAabb } from '../zombies/zombie-navigation.js';

/** 物理固定步长（与 `zombie-system.js` 的 60Hz 固定步同口径，保证与帧率无关） */
const FIXED_STEP = 1 / 60;
/** 单个 update 里最多跑几个固定步（防后台切回时一次跑上百步，卡顿尖峰） */
const MAX_PHYS_STEPS = 5;
/**
 * 「脚下支撑」探测距离（格）。
 *
 * 静立时每帧的下沉量 = `gravity × step² = 24 / 3600 ≈ 0.0067` 格，远小于这个值，
 * 故 `0.01` 足够区分「贴地悬停」与「真的悬空」。取大了会让焰魔在离地 1cm 时"站住"，
 * 取小了会被浮点误差骗。
 */
const SUPPORT_EPSILON = 0.01;

/**
 * 焰魔的绕行参数 —— **现在是 `IGNIS_STEERING` 的别名**（v2.61 上移到 config）。
 *
 * 移走的理由：寻路的第②层（`decideStep` 的 8 向地标滑行）也需同一组偏角，
 * 而它在 `IgnisService` 里跑。写在两处就是同一事实的两个副本（红线 1）。
 *
 * ⚠️ **复用丧尸的档位**（22.5°/45°/67.5°/90°）而不是另标一套：焰魔更宽
 * （halfWidth 0.5 vs 0.3），但这些档位是**角度**，与宽度无关；宽度通过
 * `aabbCollidesAt` 的 `halfWidth` 参数生效。另标一套会让「两个地面实体绕同一堵墙时
 * 走出不同路径」——那正是「探针漂移」的形态。
 */
const IGNIS_STEERING_PARAMS = IGNIS_STEERING;

/**
 * `needsPath` 判据的偏角阈值（弧度）—— `steerIntentAabb` 修过方向后与原始意图的夹角
 * 超过此值就算「被障碍逼偏了」。
 *
 * ⚠️ **取小值（~5°）而不是 0**：`steerIntentAabb` 在 0° 通行时**逐位原样返回**输入，
 * 理论差值为 0；但 `atan2` 与归一化的浮点往返会让「差不多同向」的两个向量差出 1e-16 量级。
 * 写 0 会让 `needsPath` 在开阔地也恒真（每拍都跑 A\*）。
 */
const PATH_DEVIATION_EPS = 5 * Math.PI / 180;

/**
 * 焰魔的转向目标角（from → to 的水平方向），落在本仓的 yaw 口径里。
 *
 * ⚠️ **公式 `atan2(−dx, −dz)` 由本仓 yaw→前向口径反解而来**：前向 = `(−sin yaw, −cos yaw)`
 * ⇒ `yaw = atan2(−dx, −dz)`。与 `BossAgent._angleTo` 同一个（基类已提供，这里不重复实现）。
 */

export class IgnisBossAgent extends BossAgent {
  /**
   * @param {{rng?: () => number}} deps `rng` 可注入（默认 `Math.random`）—— 攻击冷却用它，
   *        测试钉区间两端。
   */
  constructor({ rng = Math.random } = {}) {
    super();
    this.rng = rng;
  }

  /**
   * 推进一帧。
   *
   * @param {object} state 焰魔 state（含 mode / attackAnimT / attackCooldown / losTimer …）
   * @param {number} dt 秒
   * @param {{world: object|null, registry?: object,
   *          player: {position: [number,number,number]} | null}} ctx
   * @returns {object} 全新 state 各字段（plain 对象，由 `ignis-system` 的 `createState` 包裹）
   */
  update(state, dt, ctx) {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const world = ctx && ctx.world ? ctx.world : null;
    const player = ctx && ctx.player && Array.isArray(ctx.player.position)
      ? ctx.player.position
      : null;
    /**
     * 玩家速度（v2.62 跳跃劈砍的速度预判用，装配层注入）。
     *
     * ⚠️ **不能从 `player` 上读**：`player` 是 `ctx.player.position` 的裸数组，
     * 上面没有 velocity。缺省 `[0,0,0]`（静止）—— 防 ctx.player 无该字段时 NaN。
     */
    const playerVelocity = ctx && ctx.player && Array.isArray(ctx.player.velocity)
      && ctx.player.velocity.length === 3
      && ctx.player.velocity.every((n) => Number.isFinite(n))
      ? ctx.player.velocity : [0, 0, 0];

    // ---- 本帧起点（全部用新数组，不改输入）----
    let px = state.position[0];
    let py = state.position[1];
    let pz = state.position[2];
    let vx = Number.isFinite(state.velocity[0]) ? state.velocity[0] : 0;
    let vy = Number.isFinite(state.velocity[1]) ? state.velocity[1] : 0;
    let vz = Number.isFinite(state.velocity[2]) ? state.velocity[2] : 0;

    // ---- 穿模自解卡（v2.62 用户缺陷④）----
    // 被埋的现实路径：TNT/火球爆炸改地形、玩家放块、step-up 角落竞态。被埋后所有水平
    // 移动都二分回退到零位移 ⇒ 卡死。在移动意图之前先解卡，语义复刻玩家
    // `PlayerPhysics.resolveStuck`：向上扫到首个可站 y；扫不到就放弃并原地不动。
    // 常态成本 = 一次 `_collides`（未埋时位置逐位不变）。
    /**
     * 本帧是否「被埋且无解」（final review P2-1）。
     *
     * ⚠️ 这个标志是必需的：放弃解卡是对的，但若没有终态，它会以 ~7s 为周期永久抖动
     *（stuckT 累计 → 起跳但被埋 ⇒ 全被二分回退 → `leapMaxSeconds` 超时回 chase → 再累计），
     * 而渲染层会跟着播起跳姿态。不可恢复的场景应该**安静地什么都不做**。
     */
    let buriedUnresolvable = false;
    if (world) {
      const raised = this._resolveStuck(world, px, py, pz);
      if (raised !== null) {
        py = raised;
        vy = 0;   // 清零是载荷性的：被埋时重力已把 vy 压成很大的负值
      } else if (this._collides(world, px, py, pz)) {
        buriedUnresolvable = true;
      }
    }
    let yaw = Number.isFinite(state.yaw) ? state.yaw : 0;
    let onGround = state.onGround === true;

    let mode = state.mode;
    let attackAnimT = Number.isFinite(state.attackAnimT) ? state.attackAnimT : 0;
    /**
     * 本刀是哪一招（v2.75）：`'swing'`（曹力→横扫）/ `'spin'`（整圈旋斩）。
     *
     * 三个消费者：
     * ① 渲染器（按它选 `animations.attack` / `animations.spin`）；
     * ② 命中推进（本文件的命中帧 / 时长 —— 每招不同）；
     * ③ `attackRequest.kind`（给结算方，不回读 state）。
     *
     * ⚠️ **非 attack 态为 `null`**（「不在攻击中」就不该声称是哪一招）；渲染器的选择
     * 还额外由 `attackAnimT > 0` 门控，所以 null 不会导致空姿态。
     * ⚠️ **有值但非法 → 回落 `'swing'`**（旧存档/旧调用方的字段缺失意义不同于「显式 null」）。
     */
    let attackKind = state.attackKind == null
      ? null
      : (IGNIS_ATTACK_IDS.includes(state.attackKind) ? state.attackKind : 'swing');
    /** 旋斩的独立冷却剩余秒数（v2.75）。跨帧累积量 ⇒ 必须在 state 里传递。 */
    let spinCooldown = Math.max(0,
      (Number.isFinite(state.spinCooldown) ? state.spinCooldown : 0) - step);
    /**
     * 待机重新锁定的累计秒数（v2.62 用户缺陷①）。
     *
     * 跨帧累积量，必须在 state 里传递（同 `_physAccum` / `idleTime` 的口径）。
     */
    let acquireT = Number.isFinite(state.acquireT) ? state.acquireT : 0;
    /**
     * 「有意图但没走成」的累计秒数（v2.62 用户缺陷⑤）。跨帧累积量，必须在 state 里传递。
     * 计量口径见物理块后的注释（pre-steering 原始意图）。
     */
    let stuckT = Number.isFinite(state.stuckT) ? state.stuckT : 0;
    /** 飞跃类别（v2.62）：`escape` 脱困 / `attack` 跳跃劈砍；非飞跃态为 null */
    let leapKind = state.leapKind === 'escape' || state.leapKind === 'attack' ? state.leapKind : null;
    /** 飞跃期的水平速度（含长度的常量向量），非飞跃态为 null */
    let leapDir = Array.isArray(state.leapDir) && state.leapDir.length === 2
      && state.leapDir.every((n) => Number.isFinite(n))
      ? [state.leapDir[0], state.leapDir[1]]
      : null;
    /** 飞跃已持续秒数（安全阀用） */
    let leapT = Number.isFinite(state.leapT) ? state.leapT : 0;
    /** 跳跃劈砍的预判落点 y（Task 6 用），非 attack 飞跃为 null */
    let leapTargetY = Number.isFinite(state.leapTargetY) ? state.leapTargetY : null;
    /** 跳跃劈砍的冷却剩余秒数（Task 6 用），独立于 attackCooldown */
    let leapAttackCooldown = Math.max(0,
      (Number.isFinite(state.leapAttackCooldown) ? state.leapAttackCooldown : 0) - step);
    /**
     * 连续失败了几次**普通**脱困跳（v2.84）。跨帧累积量，超过
     * `IGNIS_AI.escapeLeapEscalateAfter` 后下一次起跳改用强化（更高）跳。
     *
     * 清零只看两件事（见 `escapeLevelTolerance` 注释）：
     *   ① 不再处于「卡住」态（`!shouldTrackStuck`）—— 不卡了就不需要记住过去的困境；
     *   ② 棘轮确认有进展 **且** 玩家不在上方 —— 后者是必需的：深坑底部往往很宽，
     *     在坑里水平乱走 1.5 格也能刷满棘轮，只看净位移会让计数被反复清零 ⇒ 永远等不到高跳。
     */
    let escapeFailCount = Math.max(0,
      Number.isFinite(state.escapeFailCount) ? state.escapeFailCount : 0);
    /**
     * 玩家位置的**感知快照**（v2.63）—— chase 的移动与转向一律读它，不读真实位置。
     *
     * `null` = 还没采过（首次感知立即执行，见下方感知块）。
     */
    let sensedPlayer = Array.isArray(state.sensedPlayer) && state.sensedPlayer.length === 3
      && state.sensedPlayer.every((n) => Number.isFinite(n))
      ? [state.sensedPlayer[0], state.sensedPlayer[1], state.sensedPlayer[2]]
      : null;
    /** 下次感知玩家的倒计时（秒）。<=0 时重采并重置为 [min,max] 的随机值 */
    let senseTimer = Number.isFinite(state.senseTimer) ? state.senseTimer : 0;
    /**
     * 「上次确认有进展」的位置锚点（v2.63 棘轮式卡住判据）。
     *
     * ⚠️ 取代 v2.62 的「意图 vs 位移」判据（根因见 `stuckNetDist` 注释）。
     * `null` = 未初始化（本帧用当前位置初始化）。
     */
    let stuckAnchor = Array.isArray(state.stuckAnchor) && state.stuckAnchor.length === 2
      && state.stuckAnchor.every((n) => Number.isFinite(n))
      ? [state.stuckAnchor[0], state.stuckAnchor[1]]
      : null;
    // 待机动画的相位（渲染层消费）。**属于实体状态而非渲染器**：用 performance.now() 会让
    // 「重新召唤的焰魔」继承上一只的相位，且纯函数采样在单测里不可复现。
    const idleTime = (Number.isFinite(state.idleTime) ? state.idleTime : 0) + step;
    let attackCooldown = Math.max(0,
      (Number.isFinite(state.attackCooldown) ? state.attackCooldown : 0) - step);
    let attackRequest = null;

    // ---- 视线缓存（倒计时；<=0 重查并重置）----
    let losTimer = (Number.isFinite(state.losTimer) ? state.losTimer : 0) - step;
    let losVisible = state.losVisible === true;
    if (losTimer <= 0) {
      losVisible = player !== null && this._queryLos([px, py, pz], ctx);
      losTimer = IGNIS_AI.losInterval;
    }

    const hDist = player ? this._hDist([px, py, pz], player) : Infinity;

    // ---- 玩家位置感知（v2.63：1~2 秒间隔采样，不每帧跟随）----
    //
    // 用户原文：「不是每时每刻都检测玩家位置，而是间隔最快 1 秒检测玩家位置，
    // 根据这个检测到的玩家位置进行位置移动和转向」。
    //
    // ⚠️ **v2.62 的 `turnDelay` 没解决用户的问题**：它只门控了 `idle → chase` 的重新锁定，
    // 一旦进入 chase 就每帧读真实玩家位置 ⇒ 追击途中仍然炮塔式跟着玩家转。
    //
    // ⚠️ **首次感知立即执行**（`sensedPlayer === null` 时不等间隔）：否则召唤后头 1~2 秒
    // 焰魔完全不动，且单帧驱动的既有用例会全部失效。
    // ⚠️ **清空阈值用 `disengageRange`（60）而不是 `sightRange`（50）**：两者之间是滞回带，
    // 焰魔仍在 chase —— 此时清空快照会让它在这个带上完全停止移动（无目标）。
    if (!player || hDist > IGNIS_AI.disengageRange) {
      sensedPlayer = null;
      senseTimer = 0;
    } else {
      senseTimer -= step;
      if (sensedPlayer === null || senseTimer <= 0) {
        sensedPlayer = [player[0], player[1], player[2]];
        const { senseIntervalMin: lo, senseIntervalMax: hi } = IGNIS_AI;
        senseTimer = lo + this.rng() * (hi - lo);
      }
    }

    // ---- 状态转移（用本帧起点位置，与移动同帧完成，不慢一帧）----
    if (mode === 'idle') {
      // ⚠️⚠️ **v2.61：不再要求视线通**。视线曾是一个**永久死锁**：`chase` 里
      // `if (!losVisible) mode = 'idle'`，`idle` 除了转头什么都不做，而回 `chase` 又要
      // 先视线通 ⇒ 中间一有方块就永久僵住（用户实玩：玩家站定不动，焰魔也不动了）。
      // 有了寻路（第①②层）后，「看不见」从一个**停止条件**变成一个**可解状态**；
      // `losVisible` 现在只服务「这一刀砍不砍得到」。
      //
      // ⚠️⚠️ **v2.62：重新锁定需累计满 `turnDelay`**（用户缺陷①：「玩家跑开几秒后，
      // 焰魔再转身面向玩家进行追击」）。玩家在视野内 → 累计；离开 → 清零重来。
      // 素材佐证：原版 `LookAtPlayerGoal(this, Player.class, 8.0F)` + `RandomLookAroundGoal`
      //（`Ignis_Entity.java:271-272`）—— 原版只在 8 格内转头看玩家，本来就不是炮塔式追踪。
      if (player && hDist <= IGNIS_AI.sightRange) {
        acquireT += step;
        if (acquireT >= IGNIS_AI.turnDelay) {
          mode = 'chase';
          acquireT = 0;
        }
      } else {
        acquireT = 0;
      }
    } else if (mode === 'chase') {
      // 脱离追击只看距离（与 `sightRange` 构成滞回，同飞龙的 `disengageDistance` 手法）
      if (!player || hDist > IGNIS_AI.disengageRange) mode = 'idle';
      // ⚠️ **`attackCooldown <= 0` 是必需条件**，不是可选项：
      // 缺了它，「动画播完 → 回 chase → 下一帧距离开在 attackRange 内 → 立即再起手」
      // 会让焰魔**无间隔地连续挥砍**（`attackCooldownMin/Max` 形同虚设）。
      // 实测踩到：冷却算出来了、也返回了，但从未参与判断。
      //
      // ⚠️ **起手仍要求视线通**（v2.61 保留）：隔着墙起手就是空砍，而且会白白消耗冷却。
      // 注意这一条与上面的脱离追击是两回事 —— 看不见但**距离近**时它仍在 `chase` 里，
      // 只是不起手（它会忙着绕路）。
      else if (player && hDist <= IGNIS_AI.attackRange && attackCooldown <= 0 && losVisible) {
        mode = 'attack';
        attackAnimT = 0;   // 起手：动画从头播
        // ---- 抽签选招（v2.75 用户裁定「每次起手按权重随机」）----
        // ⚠️ **旋斩冷却未好时降级**（不白放冷却）：`spinCooldown > 0` 时只从
        // 非旋斩的档案里抽 —— 否则玩家跑掉不命中的旋斩会反复浪费掉新鲜冷却。
        // ⚠️ v3.01 二次裁定（用户 2026-11-14 实玩后）：**贴身门已删** —— 持盾冲撞与另两招
        // 共用同一个起手门槛（本分支的 `hDist <= attackRange`），不再按距离排除。
        // 原裁定②的 `smashEngageRange`（3.0）已作废：用户实测认为「触发条件过于苛刻」。
        attackKind = this._rollAttackKind(spinCooldown > 0);
        // ⚠️ **起手当帧就置冷却**（不是命中帧）：否则玩家跑掉不命中时旋斩可以连抽。
        // ⚠️ 持盾冲撞**不置独立冷却**：全局 `attackCooldownMin`（4.0）已控住节奏。本行不动。
        if (attackKind === 'spin') spinCooldown = IGNIS_AI.spinCooldownSeconds;
        // ⚠️ **v2.63：起手当帧把 yaw 立即对准真实玩家**（不走 turnRate 缓动、不用快照）。
        // 快照最多陈旧 2 秒，玩家 8 格/秒能跑 16 格 —— 用陈旧朝向起手会让命中锥
        //（半角 35°）永远砍不中。「追」可以迟钝，「砍」必须准（见 `senseIntervalMin` 注释）。
        yaw = this._angleTo([px, py, pz], player);
      }
    } else if (mode === 'attack') {
      if (!losVisible || hDist > IGNIS_AI.disengageRange) {
        mode = 'chase';
        attackAnimT = 0;   // 中断：动画放弃
        attackKind = null;   // 离开 attack 一律复位（渲染器/结算都不该看到残留）
      }
    }

    // ---- 按模式决定水平移动意图 ----
    let wantVx = 0;
    let wantVz = 0;
    /**
     * **pre-steering 的原始意图**（站定环/navDir 给出、`steerIntentAabb` 之前）。
     *
     * ⚠️ 只服务于 `needsPath` 的偏差判定（「被障碍逼偏了多少」要用它和 steering 结果比）。
     * v2.62 曾用它计量 stuckT，v2.63 改为棘轮式锚点（不看意图，见 `stuckNetDist` 注释）。
     */
    let directVx = 0;
    let directVz = 0;
    /** 本帧是否需要（下一拍）重新寻路（v2.61）。先按「确实要移动」预设为 false */
    let needsPath = false;
    /**
     * 本帧意图是否为「玩家已贴近」。
     *
     * ⚠️⚠️ **退让优先级高于寻路**：看不见玩家、但玩家已经贴到 `standoff − deadband` 以内时，
     * 寻路会给出「朝玩家所在格走」的地标 —— 直接采纳会让焰魔**朝着玩家撞过去**
     * （正是 v2.60 修掉的穿模缺陷换个形式复活）。玩家本人在寻路里不是一个障碍物，
     * `standable` 只看方块。故贴近时不吃 `navDir`。
     *
     * ⚠️ **v2.62 更名**（原 `retreating`）：v2.60 的语义是「太近要退开」，v2.62 用户
     * 裁定改为「站定不动」（不动如山，见 `_ringIntent`），故更名 `tooClose` 以免误导。
     */
    let tooClose = false;
    if (mode === 'chase' && player) {
      // ⚠️ **v2.62：yaw 不在这里转**（用户缺陷⑧：绕行时「面向玩家贴着墙侧滑」）。
      // 转向目标依赖**最终**移动意图（站定环 → 局部绕行 → navDir 覆盖之后），
      // 统一在下方「yaw 转向」块处理。
      //
      // ⚠️ **v2.63：站定环读感知快照而不是真实位置**（用户：「根据这个检测到的玩家
      // 位置进行位置移动和转向」）。快照最多陈旧 2 秒 ⇒ 追的是「1~2 秒前你在哪」，
      // 转身也是一顿一顿的而不是连续跟随。
      //
      // ⚠️ **例外：真重叠时用真实位置**（final review P1-3 的安全问题等不起快照的
      // 1~2 秒采样间隔 —— 玩家被冻在身体里时每多一秒就多挨一刀）。
      const realDist = player ? this._hDist([px, py, pz], player) : Infinity;
      const ringTarget = (player && realDist < IGNIS_AI.overlapEscapeDist)
        ? player
        : (sensedPlayer || player);
      const intent = this._ringIntent(px, pz, ringTarget);
      wantVx = intent.vx;
      wantVz = intent.vz;
      // 记下 pre-steering 的原始意图（stuckT 计量口径，见上方注释）
      directVx = intent.vx;
      directVz = intent.vz;
      tooClose = intent.tooClose === true;
      // **看不见玩家时强制走寻路**：否则玩家站在墙后、焰魔停在站定环上，
      // 会永远隔着墙空砍（"起手仍要求视线通"使 attack 永不进入）—— 那就回到了
      // 用户报告的僵住形态，只是从 idle 换成 chase。
      if (!losVisible) needsPath = true;
    } else if (mode === 'attack') {
      // 挥砍时站定（作者原实现：`setDeltaMovement(0, ..., 0)`）
      wantVx = 0;
      wantVz = 0;
    } else if (mode === 'leap') {
      // 飞跃期（v2.62）：水平意图 = `leapDir`（起跳时算定的常量向量，含长度）。
      // 不转向玩家、不走站定环、不消费 navDir；碰撞/step-up 照常生效（撞墙就滑停，
      // 上升段被墙挡时竖直继续、水平在每个物理步重试 —— 高过墙顶自然飞过去）。
      if (Array.isArray(leapDir)) {
        wantVx = leapDir[0];
        wantVz = leapDir[1];
      }
      leapT += step;
    }
    // ⚠️ **v2.62：idle 不再转向玩家**（用户缺陷①：「只要没有在做动作，就会始终面向玩家，
    // 这样不太自然」）。待机时保持最后的朝向；转身发生在 `acquireT` 满、进入 chase 之后
    //（受 `turnRate` 限速，观感是「慢半拍才反应过来」）。

    // ---- 局部绕行（只换方向、不改长度；一步只探一次，与丧尸同一份实现）----
    /**
     * 「直路可通」：本帧的原始意图既没被障碍逼偏、也没被完全挡住。
     *
     * 跳跃劈砍的触发条件之一（spec §2.6）：正在绕行时起跳会撞墙。
     * ⚠️ **复用本帧已算的 steering 结果**，不得为了这个判据再调一次 `steerIntentAabb`。
     */
    let directClear = !world;   // ⚠️ 无障碍可探 ⇒ 直路可通（final review P2-2：默认假会让
                                // world 缺失的降级路径上缺陷⑥静默失效）
    if (world && (wantVx !== 0 || wantVz !== 0)) {
      directVx = wantVx;
      directVz = wantVz;
      const steering = steerIntentAabb({
        world,
        position: [px, py, pz],
        vx: wantVx,
        vz: wantVz,
        halfWidth: IGNIS.halfWidth,
        height: IGNIS.height,
        maxStep: IGNIS_AI.maxStep,
        steering: IGNIS_STEERING_PARAMS,
      });
      wantVx = steering.vx;
      wantVz = steering.vz;
      // 被障碍逼偏（或完全走不通）⇒ 下一拍值得跑一次 A\*。
      // ⚠️ **判据用「相对原始意图的偏差」而不是最终向量** —— 否则会自激：
      // 用了 navDir → 与直接方向不偏 → 清掉标志 → 下一帧又偏。
      // 无阻碍时 `steerIntentAabb` 0° 命中会**逐位原样返回**，故偏差恒 0，
      // 开阔地永远不会误触发寻路（不引入 8 向网格化走路）。
      const directLen = Math.hypot(directVx, directVz);
      const steeredLen = Math.hypot(steering.vx, steering.vz);
      let deviated = steering.blocked;
      if (steering.blocked) {
        needsPath = true;
      } else if (directLen > 1e-9 && steeredLen > 1e-9) {
        const cos = (directVx * steering.vx + directVz * steering.vz) / (directLen * steeredLen);
        deviated = Math.acos(Math.max(-1, Math.min(1, cos))) > PATH_DEVIATION_EPS;
        if (deviated) needsPath = true;
      }
      directClear = !deviated;
    }

    // ---- 寻路方向优先（v2.61：第①②层的结果，由 `IgnisService` 上一拍写好）----
    //
    // ⚠️ **站定环的语义优先级取决于"看不看得见玩家"**：
    // - **看得见** ⇒ 站定环说了算。死区里想 = 0，而 `needsPath` 此时只可能来自
    //   `deviated`（它只在 want 非零时才计算）⇒ 本块根本不会进入。
    // - **看不见** ⇒ 寻路说了算，**包括死区**。玩家站在墙后时焰魔可能已处于「与玩家的水平
    //   距离恰好落在 5 格环上」的状态，那时 `_ringIntent` 返回 0；若因此不听寻路，它会
    //   永远隔着墙站着不动（就是用户报告的形态）。故条件里保留 `mode === 'chase'`。
    const navDir = Array.isArray(state.navDir) && state.navDir.length === 2
      && state.navDir.every((n) => Number.isFinite(n))
      ? state.navDir : null;
    if (needsPath && navDir && !tooClose && (wantVx !== 0 || wantVz !== 0 || mode === 'chase')) {
      const len = Math.hypot(navDir[0], navDir[1]);
      if (len > 1e-9) {
        // 寻路给的是**单位方向**，乘上自己的追击速度（速度上限的唯一权威仍是本 Agent）
        wantVx = navDir[0] / len * IGNIS_AI.chaseSpeed;
        wantVz = navDir[1] / len * IGNIS_AI.chaseSpeed;
        // 采纳了寻路方向 ⇒ 原始意图也随之更新（stuckT 要量「AI 本帧想走哪」）
        directVx = wantVx;
        directVz = wantVz;
        // 8 向地标也要过局部避让：地标是格中心，物理推进时可能蹭到角
        if (world) {
          const re = steerIntentAabb({
            world,
            position: [px, py, pz],
            vx: wantVx,
            vz: wantVz,
            halfWidth: IGNIS.halfWidth,
            height: IGNIS.height,
            maxStep: IGNIS_AI.maxStep,
            steering: IGNIS_STEERING_PARAMS,
          });
          wantVx = re.vx;
          wantVz = re.vz;
        }
      }
    }

    // ---- 卡住飞跃的触发（v2.62 用户缺陷⑤；v2.63 改随机方向）----
    //
    // ⚠️ **必须在意图确定之后、物理之前**（起跳当帧就要把 `wantVx/wantVz` 换成飞跃向量）。
    //
    // ⚠️⚠️ **v2.63：方向改为随机**（用户原文：「就随机朝着一个方向大跳一下，大跳的目的
    // 就是试图脱困，大跳完了之后继续回归到追逐玩家的逻辑上来」）。
    // v2.62 朝「卡住瞬间的原始意图」跳 —— 而那个方向正是**被挡住的方向**（朝墙跳），
    // 跳完大概率仍在原地，这是「脱困跳了但没脱困」的根因之一。随机方向 + 落地回 chase
    //（既有行为）= 「试一个方向，不行下次再试」，多次尝试后总能出来。
    if (mode === 'chase' && !buriedUnresolvable
      && stuckT >= IGNIS_AI.stuckLeapSeconds && onGround) {
      mode = 'leap';
      leapKind = 'escape';
      leapT = 0;
      escapeFailCount += 1;
      /**
       * 本跳是否升级为**强化跳**（v2.84）：前 `escapeLeapEscalateAfter` 次仍是普通跳。
       *
       * 顶点 H = `clamp(max(Δy + margin, apexMin), apexMin, apexMax)`，Δy = 玩家脚底 − 自身脚底
       * —— 正是用户说的「焰魔所在 y 与玩家所在 y 的差」。
       *
       * ⚠️ **`max(…, apexMin)` 不是可选项**：玩家不在高处时（被 4 格高围墙困住、Δy ≈ 0）
       * 纯按高差算会得到与普通跳同高的顶点 ⇒ 强化跳白跳（`tests/ignis.spec.mjs` 的围栏 E2E）。
       * ⚠️ **不给「玩家必须贴近」这类额外门**：用户的原话是「数次普通脱困跳跃没有成功脱困
       * 才高跳」，而高跳的高度本来就由高差与保底算出 —— 再叠一个水平距离条件会在「围栏
       * 困住 + 玩家在远处」这种常见组合下让强化跳永不触发（实测过：只看到 1 次跳）。
       *
       * 无玩家时不可能有高差信息 ⇒ Δy 按 0 算（顶点 = `apexMin`），不能猜一个。
       * 这与「脱困不依赖意图」不矛盾：卡住判据仍然不看玩家，只是强化跳的**高度**需要参照量。
       */
      const dyPlayer = player ? Math.max(0, player[1] - py) : 0;
      if (escapeFailCount > IGNIS_AI.escapeLeapEscalateAfter) {
        const apex = Math.min(IGNIS_AI.escapeLeapApexMax, Math.max(
          IGNIS_AI.escapeLeapApexMin, dyPlayer + IGNIS_AI.escapeLeapApexMargin));
        // 顶点 → 竖直初速（能量守恒，与 `leapJumpForce` 同一套抛物线物理）。
        vy = Math.sqrt(2 * Math.abs(IGNIS_AI.gravity) * apex);
      } else {
        vy = IGNIS_AI.leapJumpForce;
      }
      // 随机方位角（`rng` 可注入 ⇒ 单测能钉「不同 rng 给不同方向」）
      const theta = this.rng() * Math.PI * 2;
      leapDir = [Math.sin(theta) * IGNIS_AI.leapSpeed, Math.cos(theta) * IGNIS_AI.leapSpeed];
      wantVx = leapDir[0];
      wantVz = leapDir[1];
      stuckT = 0;
      stuckAnchor = [px, pz];   // 锚点重置：飞跃本身不算「卡住」也不算「进展」
    }

    // ---- 跳跃劈砍的触发（v2.62 用户缺陷⑥）----
    //
    // 用户原文：「当焰魔靠近玩家过程中，距离玩家一定的距离，就执行一个飞跃向前的动作，
    // 落点刚好就在玩家的面前，飞跃到快触碰到地面的时候，执行当前的劈砍的动作」。
    // 素材佐证：原版 `PredictiveChargeAttackAnimationGoal`（预判玩家位置后 `setDeltaMovement`）。
    //
    // ⚠️ **与 escape 触发同位（意图确定后、物理前）**，但条件不同：跳劈是「够不着时的
    // 接近手段」，故要求 `onGround + 视线通 + 冷却好 + 距离在 [leapAttackMin, leapAttackMax]
    // + 直路可通`（正在绕行时起跳会撞墙）。
    if (mode === 'chase' && player && onGround && losVisible
      && leapAttackCooldown <= 0
      && hDist >= IGNIS_AI.leapAttackMin && hDist <= IGNIS_AI.leapAttackMax
      && directClear) {
      const T = IGNIS_AI.leapAttackAirtime;
      // 预判玩家位置 = 当前位置 + 速度 × 滞空时间（原版 `PredictiveCharge` 同口径）
      const predX = player[0] + playerVelocity[0] * T;
      const predZ = player[2] + playerVelocity[2] * T;
      // 落点 = 预判位置朝焰魔方向外推「站定环内缘」（= standoff − deadband/2）
      // ⇒ 「落在玩家面前」且落进挥砍范围（< hitRange，守卫在 test-ignis-system）。
      const offX = px - predX, offZ = pz - predZ;
      const offLen = Math.hypot(offX, offZ) || 1;
      const landDist = IGNIS_AI.standoffRange - IGNIS_AI.standoffDeadband / 2;
      const landX = predX + offX / offLen * landDist;
      const landZ = predZ + offZ / offLen * landDist;
      const landY = player[1];   // 落点高度取玩家脚底（玩家站在地面）
      // 水平速度 = (落点 − 自身)/T；竖直初速按抛物线精确解，钳 [8,14]
      let ldx = (landX - px) / T, ldz = (landZ - pz) / T;
      // ⚠️ **长度钳制是必需的**（final review P1-1）：`playerVelocity` 来自装配层的
      // 位置差分，而传送路径（`_teleportTo` → `player.spawn`）会让首帧差分出
      // **几万格/秒**的伪速度 ⇒ 预判落点偏出几万格 ⇒ 焰魔被甲出地图。
      // 装配层已修（传送重置 `_prevPlayerPos`），这里是 Agent 侧的防御：
      // 无论上游给多离谱的速度，飞跃水平速都不得超 `leapSpeed × 3`。
      const LEAP_DIR_MAX = IGNIS_AI.leapSpeed * 3;
      const lLen = Math.hypot(ldx, ldz);
      if (lLen > LEAP_DIR_MAX) { ldx = ldx / lLen * LEAP_DIR_MAX; ldz = ldz / lLen * LEAP_DIR_MAX; }
      leapDir = [ldx, ldz];
      const g = Math.abs(IGNIS_AI.gravity);
      vy = Math.max(8, Math.min(14, (landY - py + 0.5 * g * T * T) / T));
      leapTargetY = landY;
      leapKind = 'attack';
      leapT = 0;
      mode = 'leap';
      leapAttackCooldown = IGNIS_AI.leapAttackCooldown;
      wantVx = leapDir[0];
      wantVz = leapDir[1];
    }

    // ---- yaw 转向（v2.62：统一在**最终意图**确定之后算）----
    //
    // 用户缺陷⑧：「绕过障碍物追击玩家的时候，脸部方向要面向前进方向，而不是面向玩家
    // 贴着墙进行『侧滑』」。旧实现把转向写在 chase 分支**开头**（那时意图还没经绕行/
    // 寻路修正），于是绕行时脸永远对着玩家、身体横着滑。
    //
    // 三档（spec §2.8）：
    // - `attack`：**不逐帧改 yaw**（与原版挥砍期锁朝向同口径；起手前 chase 已对准）；
    // - 有水平意图：面向速度方向 `atan2(−wantVx, −wantVz)`（由本仓前向口径
    //   `(−sin yaw, −cos yaw)` 反解，与 `_angleTo` 同源）；
    // - 无意图（死区站定）：面向玩家（`losVisible` 才转 —— 看不见时转过去也只是对着墙）。
    //
    // ⚠️ **idle 不在这里转向**（Task 2 的语义：待机保持最后朝向，不炮塔式追踪）。
    if (mode === 'chase') {
      if (wantVx !== 0 || wantVz !== 0) {
        yaw = this._steerYaw(yaw, Math.atan2(-wantVx, -wantVz), step);
      } else if (player && losVisible) {
        // v2.63：死区站定面向也用快照（转向同样不实时跟随）
        yaw = this._steerYaw(yaw, this._angleTo([px, py, pz], sensedPlayer || player), step);
      }
    } else if (mode === 'leap') {
      // 飞跃期面向飞跃方向（escape 全程如此；attack kind 在转 attack 那一帧改对玩家）
      if (wantVx !== 0 || wantVz !== 0) {
        yaw = this._steerYaw(yaw, Math.atan2(-wantVx, -wantVz), step);
      }
    }

    // ---- 物理：60Hz 固定步长（与帧率无关）----
    // ⚠️ **固定步长而不是直接积帧 dt**：帧 dt 随显示刷新率变化（120Hz → 1/120、
    // 掉帧 → 上限 0.1s），碰撞判定粒度随之漂移 → 同一意图在不同帧率下走出不同路径。
    // 与 `zombie-system.js` 的 accumulator 同一口径。
    const prevAccum = Number.isFinite(state._physAccum) ? state._physAccum : 0;
    const wasOnGround = onGround;
    let accum = prevAccum + step;
    let n = 0;
    while (accum >= FIXED_STEP && n < MAX_PHYS_STEPS) {
      // 飞跃期的防穿玩家守卫（spec §2.5）：每个物理步若与玩家水平距 < 死区下界，
      // 本步水平意图清零（只保留下落）—— 焰魔物理看不见玩家（玩家阻挡是单向的，
      // §2.7），这条守卫防止飞跃落进玩家身体造成重叠。`leapDir` 本身不清（玩家走开后继续飞）。
      let stepVx = wantVx, stepVz = wantVz;
      if (mode === 'leap' && player) {
        const inner = IGNIS_AI.standoffRange - IGNIS_AI.standoffDeadband;
        if (this._hDist([px, py, pz], player) < inner) { stepVx = 0; stepVz = 0; }
      }
      const r = this._physicsStep(
        { px, py, pz, vy, onGround, wantVx: stepVx, wantVz: stepVz }, world);
      px = r.px; py = r.py; pz = r.pz; vy = r.vy; onGround = r.onGround;
      accum -= FIXED_STEP;
      n++;
    }
    // n 撞到上限时丢弃余量（与丧尸同口径：防后台切回时补跑上百步）
    if (n >= MAX_PHYS_STEPS) accum = Math.min(accum, FIXED_STEP);

    // ---- 飞跃落地 / 起劈 / 安全阀（v2.62）----
    if (mode === 'leap') {
      const landed = onGround && !wasOnGround;
      const timedOut = leapT > IGNIS_AI.leapMaxSeconds;
      if (leapKind === 'attack') {
        // 「快触地时起劈」（用户原文：「飞跃到快触碰到地面的时候，执行当前的劈砍的动作」）：
        // 下落中（vy<0）且脚底 ≤ 预判落点 + leapSlashLead ⇒ 转 attack；
        // 或已落地 / 超时（兜底：预判偏差大时落地才起劈，不能白跳一趟回 chase）。
        const nearGround = vy < 0 && leapTargetY !== null
          && py <= leapTargetY + IGNIS_AI.leapSlashLead;
        if (nearGround || landed || timedOut) {
          mode = 'attack';
          attackAnimT = 0;                       // 从头播劈砍动画
          if (player) yaw = this._angleTo([px, py, pz], player);   // 立即对准玩家（不走 turnRate 缓动）
          leapKind = null;
          leapDir = null;                        // 水平动量交回 attack（意图为 0，落地即停）
          leapT = 0;
          leapTargetY = null;
          stuckT = 0;
        }
      } else if (landed || timedOut) {
        // escape 落地 → 回 chase
        mode = 'chase';
        leapKind = null;
        leapDir = null;
        leapT = 0;
        leapTargetY = null;
        stuckT = 0;
      }
    }

    // ---- 卡住计时（v2.63：棘轮式锚点 + 「应该动却不动」门控）----
    //
    // ⚠️️ **用户要求「不管什么原因」都能脱困**，故判据不得依赖意图：
    // v2.62 的「有意图但没走成」在「意图恒为零」的卡死态下永不累计（根因见
    // `stuckNetDist` 注释）。棘轮式锚点只看「有没有真的走开」：
    //   距锚点 ≥ `stuckNetDist` ⇒ 有进展，锚点推到当前位置、`stuckT` 清零；
    //   否则 ⇒ 累计 `stuckT`。
    //
    // ⚠️️ **但必须有「应该动却不动」门控**（实测踩到，三条用例同时红）：
    // 光看净位移会把三种**正确行为**误判成卡住：
    //   ① 死区站定（v2.60 用户明确要求「玩家站住不动就停住砍第二刀」）——
    //      实测：4 秒后随机跳，跳到 4.18 格（比 inner 4.25 还近，挤进玩家身体）；
    //   ② `idle` 态（玩家已逃出 `disengageRange`）—— 站着不动是对的，不是卡住；
    //   ③ `attack` 态（作者原实现就是站定挥砍）。
    //
    // 门控：**`chase` 中，要么在走（意图非零），要么看得见玩家（随时能砍）** ——
    // 两者都不满足才是卡住。这恰好把用户报的根因（死区 + 寻路无解 + 看不见）
    // 与正常站定区分开：看不见 ⇒ 这一刀砍不到 ⇒ 又不动 ⇒ 真的无事可做。
    const shouldTrackStuck = mode === 'chase'
      && (Math.hypot(directVx, directVz) > 1e-6 || !losVisible);
    if (mode !== 'leap') {
      if (buriedUnresolvable || !shouldTrackStuck) {
        // 被埋且无解（final review P2-1）/ 或本来就该站着：钉 0，不累计
        stuckT = 0;
        stuckAnchor = [px, pz];
        // v2.84：不卡了 ⇒ 过去的失败记忆一并清掉（否则上一处困境的记忆会漏到下一次）
        escapeFailCount = 0;
      } else if (stuckAnchor === null) {
        stuckAnchor = [px, pz];
        stuckT = 0;
      } else {
        const net = Math.hypot(px - stuckAnchor[0], pz - stuckAnchor[1]);
        if (net >= IGNIS_AI.stuckNetDist) {
          stuckAnchor = [px, pz];   // 棘轮推进
          stuckT = 0;
          // v2.84：**真的走开了**才算一次脱困成功 —— 但「玩家还在上方」时不算
          //（深坑底部够宽，坑里水平乱走也能刷满 `stuckNetDist`）。
          if (!player || player[1] - py <= IGNIS_AI.escapeLevelTolerance) escapeFailCount = 0;
        } else {
          stuckT += step;
        }
      }
    }

    // ---- 攻击推进与命中帧 ----
    if (mode === 'attack') {
      const prevAnimT = attackAnimT;
      attackAnimT += step;
      // 本招的档案 —— 命中帧 / 时长都按招取（两招不同：1.20/2.75 vs 0.70/1.90）
      const profile = IGNIS_ATTACKS[attackKind] || IGNIS_ATTACKS.swing;
      // ⚠️ **只在「越过」的那一帧触发一次**：`prev < hit <= now`。
      // 写成 `current >= hit` 会每帧都触发（连续扣血）；写成 `current === hit` 在
      // dt 不是 1/fps 整数倍时永远不触发（帧率无关性丢失）。
      if (prevAnimT < profile.hitFrameSeconds && attackAnimT >= profile.hitFrameSeconds) {
        // 新鲜视线复查（不用 10Hz 缓存）—— 否则会隔着墙打人
        const freshLos = player !== null && this._queryLos([px, py, pz], ctx);
        if (freshLos) {
          // ⚠️ **`kind` 必须装进 request**（v2.75）：结算方按招取射程/半角。
          // 回读 `state.attackKind` 会在「下一帧 state 已切回 chase」时读到错值。
          attackRequest = { at: [px, py, pz], yaw, kind: attackKind };
          const { attackCooldownMin: lo, attackCooldownMax: hi } = IGNIS_AI;
          // ⚠️ 减去本帧 step：顶部已统一扣过一次 dt，不补扣会让实际间隔多出一帧
          attackCooldown = lo + this.rng() * (hi - lo) - step;
        }
      }
      // 动画播完 → 回 chase
      if (attackAnimT >= profile.animSeconds) {
        mode = 'chase';
        attackAnimT = 0;
        attackKind = null;      // 非 attack 态不得残留上一刀的档案
      }
    }

    return {
      position: [px, py, pz],
      velocity: [vx, vy, vz],
      yaw,
      health: state.health,
      flashedUntil: state.flashedUntil,
      mode,
      attackAnimT,
      attackKind,
      spinCooldown,
      acquireT,
      stuckT,
      stuckAnchor,
      escapeFailCount,
      sensedPlayer,
      senseTimer,
      leapKind,
      leapDir,
      leapT,
      leapTargetY,
      leapAttackCooldown,
      idleTime,
      attackCooldown,
      losTimer,
      losVisible,
      onGround,
      attackRequest,
      // ⚠️ **`navDir` 原样透传**（不在 Agent 里改）：它属于寻路层的结果，由
      // `IgnisService` 写入。Agent 只是消费方与 `needsPath` 的判定方。
      navDir: state.navDir ?? null,
      navMode: state.navMode ?? null,
      /** 本帧判定：下一拍需要重新寻路（服务层消费后写回 `navDir`） */
      needsPath,
      _physAccum: accum,
    };
  }

  /**
   * 抽签选招（v2.75）。
   *
   * 用户裁定「每次起手按权重随机」。按 `IGNIS_ATTACK_IDS` 的声明顺序累加 `weight`，
   * 首个使 `r * 总权重 < 累计` 的档案胜出 —— 用**总权重归一**而不是假定和为 1，
   * 这样调权重时不必手工配平（虽然 `test-ignis-system.js` 钉了和 = 1，那是为了抽签语义清晰）。
   *
   * ⚠️ **`spinBlocked` 时只从非旋斩的候选里抽**：冷却未好就把旋斩从候选集里去掉，
   * 而不是「抽中了再改判」—— 后者会让剩余概率全部堆到第一个档案上，权重语义变味。
   *
   * ⚠️ **v3.01 二次裁定：本函数回到单参**。初版曾加过第二参 `smashAllowed`（贴身门），
   * 用户 2026-11-14 实玩后裁定「不要限制在严格 3 格内，改成和其他两个攻击技能一样的生效距离」
   * ⇒ 持盾冲撞**无条件参与抽签**，距离门槛完全交给调用点的 `hDist <= attackRange`（三招共用）。
   *
   * @param {boolean} spinBlocked 旋斩冷却是否未好
   * @returns {'swing'|'spin'|'shieldSmash'} 选中的档案键
   */
  _rollAttackKind(spinBlocked) {
    const ids = spinBlocked ? IGNIS_ATTACK_IDS.filter((id) => id !== 'spin') : IGNIS_ATTACK_IDS;
    const total = ids.reduce((s, id) => s + IGNIS_ATTACKS[id].weight, 0);
    let r = this.rng() * total;
    for (const id of ids) {
      r -= IGNIS_ATTACKS[id].weight;
      if (r < 0) return id;
    }
    // 浮点边界（r 恰好落在末尾）：取最后一个候选，而不是返回 undefined
    return ids[ids.length - 1];
  }

  /**
   * 站定环的移动意图：焰魔主动保持的与玩家水平距离（v2.60；v2.62 去退让）。
   *
   * ## 为什么不是「朝玩家直走」（根因）
   *
   * 旧实现把意图写成玩家位置方向上的全速，**没有任何接近距离下限** ⇒ 玩家站定时焰魔
   * 会一直走到与玩家重合（实测 0.01 格），即用户看到的「穿模到身后 → 转回来 → 再穿」。
   * 攻击段本来是站定的，但下刀那一刻玩家已在它背后（|Δyaw| ≈ 180° ≫ 半角 35°）⇒
   * 第二刀起全部落空；挥完回 chase 继续走 → 再次穿过。
   *
   * ## 三档（死区内完全不动）
   *
   * | 当前距离 d | 意图 |
   * |---|---|
   * | `d < standoff − deadband` | **站定不动**（v2.62；v2.60 是「背离退开」）|
   * | 环内死区（上面到 `standoff`） | 原地不动，只转向 |
   * | `d > standoff` | 朝玩家的**最近环上点**走全速 |
   *
   * ⚠️ **v2.62 去退让的理由**（用户第⑦项）：「玩家跑向焰魔时，焰魔就会自己远离玩家，
   * 因为目前玩家跑步速度和焰魔移动速度差不多，就显得是玩家向前跑动会推着焰魔走，
   * 这个效果不太合理。我希望焰魔作为一个巨大的存在，如果焰魔不动，焰魔是可以挡住
   * 玩家前进的」。故玩家贴近时焰魔**站定**，让玩家撞上它的身体盒（那一半在
   * `player/physics.js` + `IgnisService.overlapsAabb`）—— 原版 `KNOCKBACK_RESISTANCE = 1.0`
   *（`Ignis_Entity.java:508`）同口径。
   *
   * ⚠️ **死区里不微调、不绕圈**：只做「朝环上最近点走」会让环内的焰魔侧向漂移
   * （目标点与当前站位垂直 ⇒ 绕着玩家画圆），观感比穿模好不了多少。
   * 死区宽度取 `standoffDeadband`：追击一步位移 4.4/60 ≈ 0.073 格，远小于它，
   * 故一旦进死区就不会因为浮点误差退出。
   *
   * @param {number} px 焰魔脚底 x @param {number} pz 焰魔脚底 z
   * @param {[number,number,number]} player 玩家位置
   * @returns {{vx: number, vz: number, tooClose: boolean}} 速度意图（未绕行、未归一化到 yaw）
   *   `tooClose` = 玩家已贴近（`d < inner`）。调用方据此**禁止**寻路覆盖这个意图（见 `update`）。
   */
  _ringIntent(px, pz, player) {
    const dx = player[0] - px;
    const dz = player[2] - pz;
    const d = Math.hypot(dx, dz);
    const { standoffRange, standoffDeadband, chaseSpeed, overlapEscapeDist } = IGNIS_AI;
    const inner = standoffRange - standoffDeadband;
    // 玩家与自己重合（退化的奇点）：没有可用方向 ⇒ 站着，不要拿 0/0 造 NaN
    if (!(d > 1e-6)) return { vx: 0, vz: 0, tooClose: true };
    // ⚠️ **例外：真重叠时后退自愈**（final review P1-3）。
    //
    // 玩家可能因传送/矿车下车而落在焰魔身体盒**内部**（`d < overlapEscapeDist`）。
    // 此时玩家侧 `_collides()` 恒真 ⇒ 四轴全冻结（走不开、也落不下）；而焰魔若按
    // 「站定不动」处理，它永不主动离开、`stuckT` 也不累计（意图恒 0）⇒ 脱困飞跃不触发
    // ⇒ 玩家被冻在 Boss 身体里、Boss 处于 attack 循环持续砍人 —— 唯一出路是打死它或再传送。
    //
    // ⚠️ **这只反转「重叠」这一个退化情形，不反转用户第⑦项**：玩家被身体盒挡在
    // 外面的正常距离（E2E 实测 minDist ≈ 1.36）远大于 `overlapEscapeDist`(1.15) ⇒ 仍站定。
    // 后退方向 = 背离玩家（与 v2.60 的退让同向量，但**只在重叠时**生效）。
    if (d < overlapEscapeDist) {
      const ux = dx / d, uz = dz / d;
      return { vx: -ux * chaseSpeed, vz: -uz * chaseSpeed, tooClose: true };
    }
    // 太近（但未重叠）：**站定不动**（v2.62；玩家撞上身体盒被挡，见 physics.js）
    if (d < inner) return { vx: 0, vz: 0, tooClose: true };
    if (d <= standoffRange) return { vx: 0, vz: 0, tooClose: false };   // 死区：站住
    // 还远：朝玩家走全速（与旧行为一致，只是多了「进环就停」）
    const ux = dx / d, uz = dz / d;
    return { vx: ux * chaseSpeed, vz: uz * chaseSpeed, tooClose: false };
  }

  /**
   * 单个固定步的物理：重力 + 分轴移动 + 碰撞 + step-up。
   *
   * ⚠️ **竖直轴先走**（与 `zombie-system.js` / `player/physics.js` 同序）：
   * 先落地算出本步的 `onGround`，水平轴才能据此判定能否 step-up。
   * 把 `onGround = false` 放在水平移动之前会让 `tryStepUp` 永远拿不到 onGround
   * → step-up 完全失效（丧尸那边实测踩过这个坑）。
   *
   * @param {{px:number, py:number, pz:number, vy:number, onGround:boolean,
   *          wantVx:number, wantVz:number}} s
   * @param {object|null} world
   * @returns {{px:number, py:number, pz:number, vy:number, onGround:boolean}}
   */
  _physicsStep(s, world) {
    let { px, py, pz, vy, onGround, wantVx, wantVz } = s;
    vy += IGNIS_AI.gravity * FIXED_STEP;
    onGround = false;

    // ① 竖直轴（撞地则清零速度并置 onGround）
    if (world) {
      const dy = vy * FIXED_STEP;
      const ny = py + dy;
      if (this._collides(world, px, ny, pz)) {
        // 二分回退到不碰撞的位置
        let lo = 0, hi = 1;
        for (let i = 0; i < 8; i++) {
          const mid = (lo + hi) / 2;
          if (this._collides(world, px, py + dy * mid, pz)) hi = mid; else lo = mid;
        }
        py = py + dy * lo;
        if (dy < 0) onGround = true;   // 下落中撞到 → 落地
        vy = 0;
      } else {
        py = ny;
        // ⚠️ **静止在支撑面上时必须也能置 onGround**（否则重力永远推不动它）：
        // 落地后 `vy = 0` ⇒ 下一帧 `dy = gravity·step·step` 是一个**极小**的负数
        // （−24 × (1/60)² ≈ −0.0067 格），不足以让它撞进下方的实心格 ⇒ 位置每帧
        // 微微下沉一点点、`_collides` 永远返回 false ⇒ `onGround` 恒为 false。
        // 实测形态：焰魔站在地上、y 不变、`vy = 0`，但 `onGround = false`（
        // `test-ignis-boss-agent.js` 的「落到地面后停住」用例抓不到，因为那条跑了
        // 300 帧后恰好跨过了一个沉降阈值）。
        // 修正：本帧未能下移时，主动检查「脚底下一小格内是否有支撑」。
        if (dy < 0 && !this._collides(world, px, py - SUPPORT_EPSILON, pz)) {
          // 仍有空隙 → 真的悬空，继续下坠
        } else if (dy < 0) {
          onGround = true;
          vy = 0;
        }
      }
    } else {
      py += vy * FIXED_STEP;
    }

    // ② 水平两轴（碰撞时可 step-up）
    for (const [axis, delta] of [[0, wantVx * FIXED_STEP], [2, wantVz * FIXED_STEP]]) {
      if (delta === 0) continue;
      const old = axis === 0 ? px : pz;
      const next = old + delta;
      const tryX = axis === 0 ? next : px;
      const tryZ = axis === 2 ? next : pz;
      if (!world || !this._collides(world, tryX, py, tryZ)) {
        if (axis === 0) px = next; else pz = next;
        continue;
      }
      // 尝试 step-up（抬一格）
      if (this._tryStepUp(world, tryX, py, tryZ, onGround, vy)) {
        py = Math.floor(py + 0.01) + 1;
        vy = 0;
        if (axis === 0) px = next; else pz = next;
        continue;
      }
      // 二分回退
      let lo = 0, hi = 1;
      for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) / 2;
        const mx = axis === 0 ? old + delta * mid : px;
        const mz = axis === 2 ? old + delta * mid : pz;
        if (this._collides(world, mx, py, mz)) hi = mid; else lo = mid;
      }
      if (axis === 0) px = old + delta * lo; else pz = old + delta * lo;
    }

    return { px, py, pz, vy, onGround };
  }

  /**
   * 被埋进方块时**向上解卡**（v2.62 用户缺陷④）。
   *
   * 语义复刻玩家 `PlayerPhysics.resolveStuck`（判据复用 `aabbCollidesAt`，红线 1）：
   * - 未埋 ⇒ 返回 `null`（常态零副作用，位置逐位不变）；
   * - 被埋 ⇒ 从 `Math.ceil(py)` 起向上逐格扫，第一个不碰撞的整数 y 即落点；
   * - 扫到 `IGNIS_AI.stuckResolveMaxRaise` 仍埋 ⇒ 返回 `null`（**放弃并原地不动**，
   *   不静默抬到半路 —— 半路仍在实心里等于没解卡，却让人以为解了）。
   *
   * ⚠️ **抬到整数 y**（同玩家 `resolveStuck` 的三条理由：不过冲 / 还原 intended 落点 /
   * 与物理常态静止位置同口径）。抬升后可能悬空 ⇒ 由既有重力自然落下站稳。
   *
   * @param {object} world @param {number} x @param {number} y @param {number} z
   * @returns {number|null} 解卡后的脚底 y；未埋或无解返回 null
   */
  _resolveStuck(world, x, y, z) {
    if (!this._collides(world, x, y, z)) return null;
    const base = Math.ceil(y);
    for (let dy = 0; dy <= IGNIS_AI.stuckResolveMaxRaise; dy++) {
      const ny = base + dy;
      if (!this._collides(world, x, ny, z)) return ny;
    }
    return null;
  }

  /** 焰魔 AABB 与实心方块是否相交（转调 `zombie-navigation` 的通用实现） */
  _collides(world, x, y, z) {
    return aabbCollidesAt(world, x, y, z, IGNIS.halfWidth, IGNIS.height);
  }

  /**
   * 自动上台阶：抬一格后不撞就能上。
   *
   * ⚠️ **门控不是 `onGround` 本身**（与 `zombie-system.js` 的 v1.72 同口径）：
   * 只在「跳跃上升段」拒绝，下落中允许 —— 否则实体斜蹭台阶边沿时会先失去支撑
   * （`onGround=false`）再被前方台壁挡死。
   *
   * @returns {boolean} 抬升后是否可通行（调用方负责真的抬 py）
   */
  _tryStepUp(world, x, y, z, onGround, vy) {
    if (!onGround && vy > 0) return false;
    const lifted = Math.floor(y + 0.01) + 1;
    if (lifted - y > IGNIS_AI.maxStep) return false;
    return !this._collides(world, x, lifted, z);
  }

  /**
   * yaw 平滑转向（`turnRate` 限速）。
   * @param {number} yaw 当前 @param {number} target 目标 @param {number} step dt
   * @returns {number} 新 yaw
   */
  _steerYaw(yaw, target, step) {
    const diff = this._angleDiff(yaw, target);
    const maxTurn = IGNIS_AI.turnRate * step;
    return yaw + Math.max(-maxTurn, Math.min(maxTurn, diff));
  }

  /**
   * 视线查询：焰魔（脚底 + 半身高）→ 玩家胸部。转调炮塔 LOS 唯一权威。
   *
   * ⚠️ **起点取半身高而不是脚底**：从脚底起算会被脚下的台阶/脚甲方块挡住（形态是
   * 「站在台阶边上看不见玩家」而实际上看得见）。
   * ⚠️ 遮挡判据 = 「实心不透明」（`isProjectileOccluding`）：能透过玻璃/水，树叶会挡。
   *
   * @param {[number,number,number]} from 焰魔脚底 @param {object} ctx
   * @returns {boolean}
   */
  _queryLos(from, ctx) {
    const player = ctx && ctx.player && Array.isArray(ctx.player.position)
      ? ctx.player.position
      : null;
    if (!player) return false;
    const eye = [from[0], from[1] + IGNIS.height * 0.5, from[2]];
    const to = [player[0], player[1] + 1.0, player[2]];   // 玩家胸部（与飞龙 playerAimOffsetY 同）
    return this._hasLos(ctx, eye, to);
  }
}