// src/entities/bosses/guardian-boss-agent.js — 末影守卫 Boss 智能体：地面三态机
//
// 本文件属 Worker 同构层（红线 8）：不碰 DOM、不 import three、不自建 Worker。
//
// `BossAgent` 的守卫子类（每个 Boss 一个智能体类）。以 `ignis-boss-agent.js` 为骨架，
// **四处结构性差异**（别照抄焰魔）：
//
// 1. **四档抽签**（`GUARDIAN_ATTACK_IDS`），每档独立冷却 `state.attackCooldowns[kind]`。
//    冷却未好时**把它从候选集里去掉**再按权重归一化抽 —— 不是「抽中了再改判」
//    （后者会让剩余概率全堆到第一档，权重语义变味）。
// 2. **命中帧 / 时长 / 射程 / 锥角逐招取**（`GUARDIAN_ATTACKS[state.attackKind]`）。
//    ⚠️ 读 `GUARDIAN_AI.hitRange/hitConeDeg`（派生最大值 6.25 / 180°）会把重击的锥
//    从 35° 扩到 180°（玩家绕到背后也被打中），而数据层完全正常。
// 3. **不做跳跃劈砍**：`leap` 态只服务脱困，`leapKind` 恒 `'escape'`。
//    原版守卫没有这一招（spec §12）⇒ 不引入 `leapAttack*` / `leapTargetY` 等死字段。
// 4. **体形**：站定环 3.5（焰魔 5.0）、重叠阈 1.95（焰魔 1.15）。
//    环半径按**最短的一招**（踩踏 4.5）定，照抄 5.0 会让踩踏永远打不中。
//
// ## 三条载荷性约定（与焰魔/飞龙同）
//
// 1. **只读 state 与 ctx，返回全新 state 各字段**（plain 对象）。不得原地改写 ——
//    `EntityManager.update` 的跨 column 索引迁移判据是「赋值前 position vs 赋值后 position」，
//    原地改写会让 before/after 从同一份算出 → 恒相等 → 索引永不迁移。
// 2. **不生成实体、不改世界、不改玩家血量**。只写 `attackRequest` 意图，由 `game.js` 结算。
// 3. **命中只在一帧触发**：`attackAnimT` 越过 `hitFrameSeconds` 的那一帧。

import { BossAgent } from './boss-agent.js';
import {
  GUARDIAN, GUARDIAN_AI, GUARDIAN_ATTACKS, GUARDIAN_ATTACK_IDS, GUARDIAN_STEERING,
} from '../guardian/guardian-config.js';
import { aabbCollidesAt, steerIntentAabb } from '../zombies/zombie-navigation.js';

/** 物理固定步长（与丧尸/焰魔的 60Hz 同口径，保证与帧率无关） */
const FIXED_STEP = 1 / 60;
/** 单个 update 最多跑几个固定步（防后台切回时补跑上百步） */
const MAX_PHYS_STEPS = 5;
/** 「脚下支撑」探测距离（格）：静立每帧下沉 ≈ 24/3600 ≈ 0.0067，取 0.01 足够区分 */
const SUPPORT_EPSILON = 0.01;
/**
 * `needsPath` 的偏角阈值（弧度）。
 *
 * ⚠️ 取 ~5° 而不是 0：`steerIntentAabb` 在 0° 通行时逐位原样返回，但 `atan2` 与归一化的
 * 浮点往返会差出 1e-16 量级 ⇒ 写 0 会让开阔地也恒真（每拍跑 A*）。
 */
const PATH_DEVIATION_EPS = 5 * Math.PI / 180;

export class GuardianBossAgent extends BossAgent {
  /**
   * @param {{rng?: () => number}} deps `rng` 可注入（默认 `Math.random`）——
   *        抽签、攻击冷却、感知间隔、脱困方向都用它，测试据此钉两端。
   */
  constructor({ rng = Math.random } = {}) {
    super();
    this.rng = rng;
  }

  /**
   * 推进一帧。
   *
   * @param {object} state 守卫 state
   * @param {number} dt 秒
   * @param {{world: object|null, registry?: object,
   *          player: {position: [number,number,number]} | null}} ctx
   * @returns {object} 全新 state 各字段
   */
  update(state, dt, ctx) {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const world = ctx && ctx.world ? ctx.world : null;
    // ⚠️ `ctx.player` 是**对象**（`{position, velocity}`），不是裸数组 —— 装配层就是这么传的
    const player = ctx && ctx.player && Array.isArray(ctx.player.position)
      ? ctx.player.position
      : null;

    let px = state.position[0];
    let py = state.position[1];
    let pz = state.position[2];
    let vy = Number.isFinite(state.velocity[1]) ? state.velocity[1] : 0;

    // ---- 穿模自解卡（被埋时向上扫到首个可站 y）----
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
    /** 本刀是哪一招；非 attack 态为 null；有值但非法 → 回落第一档 */
    let attackKind = state.attackKind == null
      ? null
      : (GUARDIAN_ATTACK_IDS.includes(state.attackKind) ? state.attackKind : GUARDIAN_ATTACK_IDS[0]);
    /**
     * 逐招独立冷却的剩余秒数映射。
     *
     * ⚠️⚠️ **跨帧累积量，必须在 state 里传递并逐帧递减**（同 `_physAccum` / `senseTimer`）：
     * 丢掉它 ⇒ 每帧重置 ⇒ 独立冷却永不生效，而权重与常量看上去都对。
     */
    const attackCooldowns = {};
    for (const id of GUARDIAN_ATTACK_IDS) {
      const prev = state.attackCooldowns && Number.isFinite(state.attackCooldowns[id])
        ? state.attackCooldowns[id] : 0;
      attackCooldowns[id] = Math.max(0, prev - step);
    }
    let acquireT = Number.isFinite(state.acquireT) ? state.acquireT : 0;
    let stuckT = Number.isFinite(state.stuckT) ? state.stuckT : 0;
    /** 飞跃类别：守卫恒 `'escape'`（不做跳劈）；非飞跃态为 null */
    let leapKind = state.leapKind === 'escape' ? 'escape' : null;
    let leapDir = Array.isArray(state.leapDir) && state.leapDir.length === 2
      && state.leapDir.every((n) => Number.isFinite(n))
      ? [state.leapDir[0], state.leapDir[1]]
      : null;
    let leapT = Number.isFinite(state.leapT) ? state.leapT : 0;
    let escapeFailCount = Math.max(0,
      Number.isFinite(state.escapeFailCount) ? state.escapeFailCount : 0);
    let sensedPlayer = Array.isArray(state.sensedPlayer) && state.sensedPlayer.length === 3
      && state.sensedPlayer.every((n) => Number.isFinite(n))
      ? [state.sensedPlayer[0], state.sensedPlayer[1], state.sensedPlayer[2]]
      : null;
    let senseTimer = Number.isFinite(state.senseTimer) ? state.senseTimer : 0;
    let stuckAnchor = Array.isArray(state.stuckAnchor) && state.stuckAnchor.length === 2
      && state.stuckAnchor.every((n) => Number.isFinite(n))
      ? [state.stuckAnchor[0], state.stuckAnchor[1]]
      : null;
    const idleTime = (Number.isFinite(state.idleTime) ? state.idleTime : 0) + step;
    let attackCooldown = Math.max(0,
      (Number.isFinite(state.attackCooldown) ? state.attackCooldown : 0) - step);
    let attackRequest = null;

    // ---- 视线缓存（10Hz，不每帧重查）----
    let losTimer = (Number.isFinite(state.losTimer) ? state.losTimer : 0) - step;
    let losVisible = state.losVisible === true;
    if (losTimer <= 0) {
      losVisible = player !== null && this._queryLos([px, py, pz], ctx);
      losTimer = GUARDIAN_AI.losInterval;
    }

    const hDist = player ? this._hDist([px, py, pz], player) : Infinity;

    // ---- 玩家位置感知（1~2 秒采样，chase 的移动与转向读快照）----
    // ⚠️ 首次感知立即执行（否则召唤后头 1~2 秒完全不动）
    // ⚠️ 清空阈值用 disengageRange 而不是 sightRange：两者之间是滞回带，仍在 chase
    if (!player || hDist > GUARDIAN_AI.disengageRange) {
      sensedPlayer = null;
      senseTimer = 0;
    } else {
      senseTimer -= step;
      if (sensedPlayer === null || senseTimer <= 0) {
        sensedPlayer = [player[0], player[1], player[2]];
        const { senseIntervalMin: lo, senseIntervalMax: hi } = GUARDIAN_AI;
        senseTimer = lo + this.rng() * (hi - lo);
      }
    }

    // ---- 状态转移 ----
    if (mode === 'idle') {
      // 不要求视线通（「看不见」是可解状态，不是停止条件）；重新锁定需累计满 turnDelay
      if (player && hDist <= GUARDIAN_AI.sightRange) {
        acquireT += step;
        if (acquireT >= GUARDIAN_AI.turnDelay) {
          mode = 'chase';
          acquireT = 0;
        }
      } else {
        acquireT = 0;
      }
    } else if (mode === 'chase') {
      if (!player || hDist > GUARDIAN_AI.disengageRange) mode = 'idle';
      // ⚠️ `attackCooldown <= 0` 是必需条件（缺了它会无间隔连招）
      // ⚠️ 起手仍要求视线通（隔墙起手就是空砍，还白耗冷却）
      else if (player && hDist <= GUARDIAN_AI.attackRange && attackCooldown <= 0 && losVisible) {
        mode = 'attack';
        attackAnimT = 0;
        attackKind = this._rollAttackKind(attackCooldowns);
        // ⚠️ 起手当帧就置本招冷却（不是命中帧）：玩家跑掉不命中时按命中帧计会反复抽中
        const cd = GUARDIAN_ATTACKS[attackKind].cooldownSeconds;
        if (cd > 0) attackCooldowns[attackKind] = cd;
        // ⚠️ 起手当帧把 yaw 立即对准**真实**玩家（不走缓动、不用快照）：
        // 快照最多陈旧 2 秒，玩家 8 格/秒能跑 16 格 ⇒ 用陈旧朝向起手会永远砍不中
        yaw = this._angleTo([px, py, pz], player);
      }
    } else if (mode === 'attack') {
      if (!losVisible || hDist > GUARDIAN_AI.disengageRange) {
        mode = 'chase';
        attackAnimT = 0;
        attackKind = null;
      }
    }

    // ---- 按模式决定水平移动意图 ----
    let wantVx = 0;
    let wantVz = 0;
    let directVx = 0;
    let directVz = 0;
    let needsPath = false;
    let tooClose = false;
    if (mode === 'chase' && player) {
      // 站定环读感知快照；**真重叠时用真实位置**（安全问题等不起 1~2 秒采样间隔）
      const realDist = this._hDist([px, py, pz], player);
      const ringTarget = realDist < GUARDIAN_AI.overlapEscapeDist ? player : (sensedPlayer || player);
      const intent = this._ringIntent(px, pz, ringTarget);
      wantVx = intent.vx;
      wantVz = intent.vz;
      directVx = intent.vx;
      directVz = intent.vz;
      tooClose = intent.tooClose === true;
      // 看不见玩家时强制走寻路（否则永远隔墙站着）
      if (!losVisible) needsPath = true;
    } else if (mode === 'leap' && Array.isArray(leapDir)) {
      wantVx = leapDir[0];
      wantVz = leapDir[1];
      leapT += step;
    }
    // idle 不转向、attack 站定（want 保持 0）

    // ---- 局部绕行（只换方向、不改长度；与丧尸同一份实现）----
    if (world && (wantVx !== 0 || wantVz !== 0)) {
      directVx = wantVx;
      directVz = wantVz;
      const steering = steerIntentAabb({
        world,
        position: [px, py, pz],
        vx: wantVx,
        vz: wantVz,
        halfWidth: GUARDIAN.halfWidth,
        height: GUARDIAN.height,
        maxStep: GUARDIAN_AI.maxStep,
        steering: GUARDIAN_STEERING,
      });
      wantVx = steering.vx;
      wantVz = steering.vz;
      // ⚠️ 判据用「相对原始意图的偏差」而不是最终向量（否则采纳 navDir 后会自激）
      const directLen = Math.hypot(directVx, directVz);
      const steeredLen = Math.hypot(steering.vx, steering.vz);
      if (steering.blocked) {
        needsPath = true;
      } else if (directLen > 1e-9 && steeredLen > 1e-9) {
        const cos = (directVx * steering.vx + directVz * steering.vz) / (directLen * steeredLen);
        if (Math.acos(Math.max(-1, Math.min(1, cos))) > PATH_DEVIATION_EPS) needsPath = true;
      }
    }

    // ---- 寻路方向优先（服务层上一拍写好的 navDir）----
    // ⚠️ 看不见玩家时寻路说了算（**包括死区**）；但玩家已贴近时不吃 navDir
    //（玩家本人在寻路里不是障碍物，采纳会让守卫朝玩家撞过去）
    const navDir = Array.isArray(state.navDir) && state.navDir.length === 2
      && state.navDir.every((n) => Number.isFinite(n))
      ? state.navDir : null;
    if (needsPath && navDir && !tooClose && (wantVx !== 0 || wantVz !== 0 || mode === 'chase')) {
      const len = Math.hypot(navDir[0], navDir[1]);
      if (len > 1e-9) {
        wantVx = navDir[0] / len * GUARDIAN_AI.chaseSpeed;
        wantVz = navDir[1] / len * GUARDIAN_AI.chaseSpeed;
        directVx = wantVx;
        directVz = wantVz;
        if (world) {
          const re = steerIntentAabb({
            world,
            position: [px, py, pz],
            vx: wantVx,
            vz: wantVz,
            halfWidth: GUARDIAN.halfWidth,
            height: GUARDIAN.height,
            maxStep: GUARDIAN_AI.maxStep,
            steering: GUARDIAN_STEERING,
          });
          wantVx = re.vx;
          wantVz = re.vz;
        }
      }
    }

    // ---- 脱困跳的触发（意图确定后、物理之前）----
    // ⚠️ 方向随机：朝「卡住瞬间的原始意图」跳正是被挡住的方向（朝墙跳），跳完仍在原地
    if (mode === 'chase' && !buriedUnresolvable
      && stuckT >= GUARDIAN_AI.stuckLeapSeconds && onGround) {
      mode = 'leap';
      leapKind = 'escape';
      leapT = 0;
      escapeFailCount += 1;
      const dyPlayer = player ? Math.max(0, player[1] - py) : 0;
      if (escapeFailCount > GUARDIAN_AI.escapeLeapEscalateAfter) {
        const apex = Math.min(GUARDIAN_AI.escapeLeapApexMax, Math.max(
          GUARDIAN_AI.escapeLeapApexMin, dyPlayer + GUARDIAN_AI.escapeLeapApexMargin));
        vy = Math.sqrt(2 * Math.abs(GUARDIAN_AI.gravity) * apex);
      } else {
        vy = GUARDIAN_AI.leapJumpForce;
      }
      const theta = this.rng() * Math.PI * 2;
      leapDir = [Math.sin(theta) * GUARDIAN_AI.leapSpeed, Math.cos(theta) * GUARDIAN_AI.leapSpeed];
      wantVx = leapDir[0];
      wantVz = leapDir[1];
      stuckT = 0;
      stuckAnchor = [px, pz];
    }

    // ---- yaw 转向（统一在**最终意图**确定之后）----
    // 绕行时面向前进方向（不是面向玩家贴墙侧滑）；死区站定时面向玩家
    if (mode === 'chase') {
      if (wantVx !== 0 || wantVz !== 0) {
        yaw = this._steerYaw(yaw, Math.atan2(-wantVx, -wantVz), step);
      } else if (player && losVisible) {
        yaw = this._steerYaw(yaw, this._angleTo([px, py, pz], sensedPlayer || player), step);
      }
    } else if (mode === 'leap' && (wantVx !== 0 || wantVz !== 0)) {
      yaw = this._steerYaw(yaw, Math.atan2(-wantVx, -wantVz), step);
    }

    // ---- 物理：60Hz 固定步长 ----
    const prevAccum = Number.isFinite(state._physAccum) ? state._physAccum : 0;
    const wasOnGround = onGround;
    let accum = prevAccum + step;
    let n = 0;
    while (accum >= FIXED_STEP && n < MAX_PHYS_STEPS) {
      // 飞跃期防穿玩家：与玩家过近时本步水平意图清零（只保留下落）
      let stepVx = wantVx, stepVz = wantVz;
      if (mode === 'leap' && player) {
        const inner = GUARDIAN_AI.standoffRange - GUARDIAN_AI.standoffDeadband;
        if (this._hDist([px, py, pz], player) < inner) { stepVx = 0; stepVz = 0; }
      }
      const r = this._physicsStep({ px, py, pz, vy, onGround, wantVx: stepVx, wantVz: stepVz }, world);
      px = r.px; py = r.py; pz = r.pz; vy = r.vy; onGround = r.onGround;
      accum -= FIXED_STEP;
      n++;
    }
    if (n >= MAX_PHYS_STEPS) accum = Math.min(accum, FIXED_STEP);

    // ---- 飞跃落地 / 安全阀 ----
    if (mode === 'leap') {
      const landed = onGround && !wasOnGround;
      // ⚠️ 安全阀在低净空房间是**唯一**出路：上层房间净空 5 格、守卫高 3.8
      // ⇒ 脚底只能升 1.2 格，撞顶后既上不去也落不下来（spec §2.3.3）
      if (landed || leapT > GUARDIAN_AI.leapMaxSeconds) {
        mode = 'chase';
        leapKind = null;
        leapDir = null;
        leapT = 0;
        stuckT = 0;
      }
    }

    // ---- 卡住计时（棘轮式锚点 + 「应该动却不动」门控）----
    // ⚠️ 判据不看意图（意图恒零的卡死态也要累计），但必须有门控：
    // 死区站定连砍 / idle / attack 都是**正确行为**，光看净位移会把它们误判成卡住
    const shouldTrackStuck = mode === 'chase'
      && (Math.hypot(directVx, directVz) > 1e-6 || !losVisible);
    if (mode !== 'leap') {
      if (buriedUnresolvable || !shouldTrackStuck) {
        stuckT = 0;
        stuckAnchor = [px, pz];
        escapeFailCount = 0;
      } else if (stuckAnchor === null) {
        stuckAnchor = [px, pz];
        stuckT = 0;
      } else {
        const net = Math.hypot(px - stuckAnchor[0], pz - stuckAnchor[1]);
        if (net >= GUARDIAN_AI.stuckNetDist) {
          stuckAnchor = [px, pz];
          stuckT = 0;
          // 真的走开了才算脱困成功 —— 但玩家还在上方时不算（深坑底部够宽，坑里乱走也能刷满棘轮）
          if (!player || player[1] - py <= GUARDIAN_AI.escapeLevelTolerance) escapeFailCount = 0;
        } else {
          stuckT += step;
        }
      }
    }

    // ---- 攻击推进与命中帧（逐招取档案）----
    if (mode === 'attack') {
      const prevAnimT = attackAnimT;
      attackAnimT += step;
      const profile = GUARDIAN_ATTACKS[attackKind] || GUARDIAN_ATTACKS[GUARDIAN_ATTACK_IDS[0]];
      // ⚠️ 只在「越过」的那一帧触发一次：`prev < hit <= now`
      if (prevAnimT < profile.hitFrameSeconds && attackAnimT >= profile.hitFrameSeconds) {
        // 新鲜视线复查（不用 10Hz 缓存）—— 否则会隔着墙打人
        const freshLos = player !== null && this._queryLos([px, py, pz], ctx);
        if (freshLos) {
          // ⚠️ kind 必须装进 request：结算方按招取射程/半角，回读 state 会在切回 chase 后读到错值
          attackRequest = { at: [px, py, pz], yaw, kind: attackKind };
          const { attackCooldownMin: lo, attackCooldownMax: hi } = GUARDIAN_AI;
          // 减去本帧 step：顶部已统一扣过一次 dt，不补扣会让实际间隔多出一帧
          attackCooldown = lo + this.rng() * (hi - lo) - step;
        }
      }
      if (attackAnimT >= profile.animSeconds) {
        mode = 'chase';
        attackAnimT = 0;
        attackKind = null;
      }
    }

    return {
      position: [px, py, pz],
      velocity: [0, vy, 0],
      yaw,
      health: state.health,
      flashedUntil: state.flashedUntil,
      mode,
      attackAnimT,
      attackKind,
      attackCooldowns,
      acquireT,
      stuckT,
      stuckAnchor,
      escapeFailCount,
      sensedPlayer,
      senseTimer,
      leapKind,
      leapDir,
      leapT,
      idleTime,
      attackCooldown,
      losTimer,
      losVisible,
      onGround,
      attackRequest,
      // navDir/navMode 原样透传（属寻路层，由 GuardianService 写）
      navDir: state.navDir ?? null,
      navMode: state.navMode ?? null,
      needsPath,
      _physAccum: accum,
    };
  }

  /**
   * 抽签选招：按权重累加，**冷却未好的档先从候选集里去掉**再归一化。
   *
   * ⚠️ 两档普攻 `cooldownSeconds = 0` ⇒ 永远在候选里 ⇒ 不会出现「全档被排除而空抽」。
   * ⚠️ 用总权重归一而不是假定和为 1（调权重时不必手工配平）。
   *
   * @param {Record<string, number>} cooldowns 各招剩余冷却秒数
   * @returns {string} 选中的招式键
   */
  _rollAttackKind(cooldowns) {
    const ready = GUARDIAN_ATTACK_IDS.filter((id) => {
      const cd = GUARDIAN_ATTACKS[id].cooldownSeconds;
      return cd === 0 || !(cooldowns && cooldowns[id] > 0);
    });
    const ids = ready.length > 0 ? ready : GUARDIAN_ATTACK_IDS.filter(
      (id) => GUARDIAN_ATTACKS[id].cooldownSeconds === 0);
    const total = ids.reduce((s, id) => s + GUARDIAN_ATTACKS[id].weight, 0);
    let r = this.rng() * total;
    for (const id of ids) {
      r -= GUARDIAN_ATTACKS[id].weight;
      if (r < 0) return id;
    }
    return ids[ids.length - 1];   // 浮点边界：取最后一个而不是 undefined
  }

  /**
   * 站定环的移动意图（三档，死区内完全不动）。
   *
   * | 当前距离 d | 意图 |
   * |---|---|
   * | `d < overlapEscapeDist` | **背离玩家退开**（真重叠的例外自愈）|
   * | `d < standoff − deadband` | **站定不动**（玩家撞身体盒被挡，不退让）|
   * | 死区（到 `standoff`）| 原地不动，只转向 |
   * | `d > standoff` | 朝玩家走全速 |
   *
   * ⚠️ 死区里不微调、不绕圈：只做「朝环上最近点走」会让环内实体侧向漂移（绕着玩家画圆）。
   * ⚠️ 重叠自愈只反转「重叠」这一个退化情形，不反转「贴近时站定」的用户裁定。
   *
   * @returns {{vx: number, vz: number, tooClose: boolean}}
   */
  _ringIntent(px, pz, player) {
    const dx = player[0] - px;
    const dz = player[2] - pz;
    const d = Math.hypot(dx, dz);
    const { standoffRange, standoffDeadband, chaseSpeed, overlapEscapeDist } = GUARDIAN_AI;
    const inner = standoffRange - standoffDeadband;
    if (!(d > 1e-6)) return { vx: 0, vz: 0, tooClose: true };   // 退化奇点：不造 NaN
    if (d < overlapEscapeDist) {
      const ux = dx / d, uz = dz / d;
      return { vx: -ux * chaseSpeed, vz: -uz * chaseSpeed, tooClose: true };
    }
    if (d < inner) return { vx: 0, vz: 0, tooClose: true };
    if (d <= standoffRange) return { vx: 0, vz: 0, tooClose: false };
    const ux = dx / d, uz = dz / d;
    return { vx: ux * chaseSpeed, vz: uz * chaseSpeed, tooClose: false };
  }

  /**
   * 单个固定步的物理：重力 + 分轴移动 + 碰撞 + step-up。
   *
   * ⚠️ **竖直轴先走**：先落地算出本步 `onGround`，水平轴才能据此判定能否 step-up。
   */
  _physicsStep(s, world) {
    let { px, py, pz, vy, onGround, wantVx, wantVz } = s;
    vy += GUARDIAN_AI.gravity * FIXED_STEP;
    onGround = false;

    // ① 竖直轴
    if (world) {
      const dy = vy * FIXED_STEP;
      const ny = py + dy;
      if (this._collides(world, px, ny, pz)) {
        let lo = 0, hi = 1;
        for (let i = 0; i < 8; i++) {
          const mid = (lo + hi) / 2;
          if (this._collides(world, px, py + dy * mid, pz)) hi = mid; else lo = mid;
        }
        py = py + dy * lo;
        if (dy < 0) onGround = true;
        vy = 0;
      } else {
        py = ny;
        // ⚠️ 静止在支撑面上也要置 onGround：落地后 vy=0 ⇒ 每帧下沉 ≈0.0067 格不足以撞进
        // 下方实心格 ⇒ onGround 恒 false（重力永远推不动它）
        if (dy < 0 && this._collides(world, px, py - SUPPORT_EPSILON, pz)) {
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
      if (this._tryStepUp(world, tryX, py, tryZ, onGround, vy)) {
        py = Math.floor(py + 0.01) + 1;
        vy = 0;
        if (axis === 0) px = next; else pz = next;
        continue;
      }
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
   * 被埋进方块时向上解卡（判据复用 `aabbCollidesAt`，红线 1）。
   *
   * 未埋 ⇒ null（常态零副作用）；扫到 `stuckResolveMaxRaise` 仍埋 ⇒ null（放弃并原地不动，
   * 不静默抬到半路 —— 半路仍在实心里等于没解卡）。
   */
  _resolveStuck(world, x, y, z) {
    if (!this._collides(world, x, y, z)) return null;
    const base = Math.ceil(y);
    for (let dy = 0; dy <= GUARDIAN_AI.stuckResolveMaxRaise; dy++) {
      const ny = base + dy;
      if (!this._collides(world, x, ny, z)) return ny;
    }
    return null;
  }

  /** 守卫 AABB 与实心方块是否相交（转调 zombie-navigation 的通用实现） */
  _collides(world, x, y, z) {
    return aabbCollidesAt(world, x, y, z, GUARDIAN.halfWidth, GUARDIAN.height);
  }

  /**
   * 自动上台阶：抬一格后不撞就能上。
   *
   * ⚠️ 门控不是 `onGround` 本身：只在「跳跃上升段」拒绝，下落中允许
   * （否则斜蹭台阶边沿时会先失去支撑再被前方台壁挡死）。
   * ⚠️ `zombieStepUpY` 恒抬 1 格 ⇒ `maxStep` 1.75 与 1.0 等价（见 config 注释）。
   */
  _tryStepUp(world, x, y, z, onGround, vy) {
    if (!onGround && vy > 0) return false;
    const lifted = Math.floor(y + 0.01) + 1;
    if (lifted - y > GUARDIAN_AI.maxStep) return false;
    return !this._collides(world, x, lifted, z);
  }

  /** yaw 平滑转向（turnRate 限速） */
  _steerYaw(yaw, target, step) {
    const diff = this._angleDiff(yaw, target);
    const maxTurn = GUARDIAN_AI.turnRate * step;
    return yaw + Math.max(-maxTurn, Math.min(maxTurn, diff));
  }

  /**
   * 视线查询：守卫（脚底 + 半身高）→ 玩家胸部。转调炮塔 LOS 唯一权威。
   *
   * ⚠️ 起点取半身高而不是脚底（从脚底起算会被脚下的台阶挡住）。
   */
  _queryLos(from, ctx) {
    const player = ctx && ctx.player && Array.isArray(ctx.player.position)
      ? ctx.player.position
      : null;
    if (!player) return false;
    const eye = [from[0], from[1] + GUARDIAN.height * 0.5, from[2]];
    const to = [player[0], player[1] + 1.0, player[2]];
    return this._hasLos(ctx, eye, to);
  }
}