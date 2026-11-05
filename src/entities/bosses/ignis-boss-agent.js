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
import { IGNIS, IGNIS_AI } from '../ignis/ignis-config.js';
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
 * 焰魔的绕行参数。
 *
 * ⚠️ **复用丧尸的档位**（22.5°/45°/67.5°/90°）而不是另标一套：焰魔更宽
 * （halfWidth 0.5 vs 0.3），但这些档位是**角度**，与宽度无关；宽度通过
 * `aabbCollidesAt` 的 `halfWidth` 参数生效。另标一套会让「两个地面实体绕同一堵墙时
 * 走出不同路径」——那正是「探针漂移」的形态。
 */
const IGNIS_STEERING = Object.freeze({
  probeDistance: 1.2,
  anglesDeg: Object.freeze([22.5, 45, 67.5, 90]),
});

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

    // ---- 本帧起点（全部用新数组，不改输入）----
    let px = state.position[0];
    let py = state.position[1];
    let pz = state.position[2];
    let vx = Number.isFinite(state.velocity[0]) ? state.velocity[0] : 0;
    let vy = Number.isFinite(state.velocity[1]) ? state.velocity[1] : 0;
    let vz = Number.isFinite(state.velocity[2]) ? state.velocity[2] : 0;
    let yaw = Number.isFinite(state.yaw) ? state.yaw : 0;
    let onGround = state.onGround === true;

    let mode = state.mode;
    let attackAnimT = Number.isFinite(state.attackAnimT) ? state.attackAnimT : 0;
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

    // ---- 状态转移（用本帧起点位置，与移动同帧完成，不慢一帧）----
    if (mode === 'idle') {
      if (player && losVisible && hDist <= IGNIS_AI.sightRange) mode = 'chase';
    } else if (mode === 'chase') {
      if (!losVisible) mode = 'idle';
      // ⚠️ **`attackCooldown <= 0` 是必需条件**，不是可选项：
      // 缺了它，「动画播完 → 回 chase → 下一帧距离开在 attackRange 内 → 立即再起手」
      // 会让焰魔**无间隔地连续挥砍**（`attackCooldownMin/Max` 形同虚设）。
      // 实测踩到：冷却算出来了、也返回了，但从未参与判断。
      else if (player && hDist <= IGNIS_AI.attackRange && attackCooldown <= 0) {
        mode = 'attack';
        attackAnimT = 0;   // 起手：动画从头播
      }
    } else if (mode === 'attack') {
      if (!losVisible || hDist > IGNIS_AI.disengageRange) {
        mode = 'chase';
        attackAnimT = 0;   // 中断：动画放弃
      }
    }

    // ---- 按模式决定水平移动意图 ----
    let wantVx = 0;
    let wantVz = 0;
    if (mode === 'chase' && player) {
      yaw = this._steerYaw(yaw, this._angleTo([px, py, pz], player), step);
      // 沿机头前向飞/走（本仓 yaw 口径：前向 = (−sin yaw, −cos yaw)）
      wantVx = -Math.sin(yaw) * IGNIS_AI.chaseSpeed;
      wantVz = -Math.cos(yaw) * IGNIS_AI.chaseSpeed;
    } else if (mode === 'attack') {
      // 挥砍时站定（作者原实现：`setDeltaMovement(0, ..., 0)`）
      wantVx = 0;
      wantVz = 0;
    } else if (mode === 'idle' && player && losVisible) {
      // 待机时缓慢转向玩家（观感：它会「看」着你），但不移动
      yaw = this._steerYaw(yaw, this._angleTo([px, py, pz], player), step);
    }

    // ---- 局部绕行（只换方向、不改长度；一步只探一次，与丧尸同一份实现）----
    if (world && (wantVx !== 0 || wantVz !== 0)) {
      const steering = steerIntentAabb({
        world,
        position: [px, py, pz],
        vx: wantVx,
        vz: wantVz,
        halfWidth: IGNIS.halfWidth,
        height: IGNIS.height,
        maxStep: IGNIS_AI.maxStep,
        steering: IGNIS_STEERING,
      });
      wantVx = steering.vx;
      wantVz = steering.vz;
    }

    // ---- 物理：60Hz 固定步长（与帧率无关）----
    // ⚠️ **固定步长而不是直接积帧 dt**：帧 dt 随显示刷新率变化（120Hz → 1/120、
    // 掉帧 → 上限 0.1s），碰撞判定粒度随之漂移 → 同一意图在不同帧率下走出不同路径。
    // 与 `zombie-system.js` 的 accumulator 同一口径。
    const prevAccum = Number.isFinite(state._physAccum) ? state._physAccum : 0;
    let accum = prevAccum + step;
    let n = 0;
    while (accum >= FIXED_STEP && n < MAX_PHYS_STEPS) {
      const r = this._physicsStep(
        { px, py, pz, vy, onGround, wantVx, wantVz }, world);
      px = r.px; py = r.py; pz = r.pz; vy = r.vy; onGround = r.onGround;
      accum -= FIXED_STEP;
      n++;
    }
    // n 撞到上限时丢弃余量（与丧尸同口径：防后台切回时补跑上百步）
    if (n >= MAX_PHYS_STEPS) accum = Math.min(accum, FIXED_STEP);

    // ---- 攻击推进与命中帧 ----
    if (mode === 'attack') {
      const prevAnimT = attackAnimT;
      attackAnimT += step;
      // ⚠️ **只在「越过」的那一帧触发一次**：`prev < hit <= now`。
      // 写成 `current >= hit` 会每帧都触发（连续扣血）；写成 `current === hit` 在
      // dt 不是 1/fps 整数倍时永远不触发（帧率无关性丢失）。
      if (prevAnimT < IGNIS_AI.hitFrameSeconds && attackAnimT >= IGNIS_AI.hitFrameSeconds) {
        // 新鲜视线复查（不用 10Hz 缓存）—— 否则会隔着墙打人
        const freshLos = player !== null && this._queryLos([px, py, pz], ctx);
        if (freshLos) {
          attackRequest = { at: [px, py, pz], yaw };
          const { attackCooldownMin: lo, attackCooldownMax: hi } = IGNIS_AI;
          // ⚠️ 减去本帧 step：顶部已统一扣过一次 dt，不补扣会让实际间隔多出一帧
          attackCooldown = lo + this.rng() * (hi - lo) - step;
        }
      }
      // 动画播完 → 回 chase
      if (attackAnimT >= IGNIS_AI.attackAnimSeconds) {
        mode = 'chase';
        attackAnimT = 0;
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
      idleTime,
      attackCooldown,
      losTimer,
      losVisible,
      onGround,
      attackRequest,
      _physAccum: accum,
    };
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