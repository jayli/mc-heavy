// src/entities/bosses/dragon-boss-agent.js — 飞龙 Boss 智能体：四态机 AI（v2.44）
//
// 同构层：**无 DOM、无 three、不新增 Worker**（`check:arch` 的 `ISOMORPHIC_DIRS` 静态门守）。
//
// `BossAgent` 的飞龙子类（用户的解耦指令：每个 Boss 都有自己的智能体类）。
// 设计文档 `docs/superpowers/specs/2026-11-03-dragon-boss-ai-design.md` §3。
//
// ## 四态机
//
//   orbit ──(视线通 + 水平距 ≤ sightRange)──▶ chase
//   chase ──(距 ≤ attackRange)──▶ attack ──(距 > disengageDistance 或视线断)──▶ return
//   chase ──(视线断)──▶ return ──(追及轨道点)──▶ orbit
//
// - **orbit**：位置/yaw 逐位来自注入的 `poseAt`（= `dragonPoseAt`，轨道的唯一权威）。
// - **chase**：yaw 平滑转向玩家（`turnRate` 限速），沿机头前向飞 `chaseSpeed`。
// - **attack**：子态 `approach`（冲向玩家）↔ `turn`（递近到 `flyoverDistance` 就飞过玩家
//   头顶，外飞 `turnAroundDistance` 后掉头）—— 玩家静止时的「飞跃 → 拉远 → 回头」循环。
// - **return**：飞向**当前 `orbitT` 的轨道点**（不是圆心）—— 轨道点也在动（6 格/秒）而龙
//   飞 9 格/秒 ⇒ 追及必收敛，且到达时位置已≈轨道点 ⇒ 切回 orbit **无跳变**。
//
// ## 三条载荷性约定
//
// 1. **`orbitT` 在所有模式都推进**，y 恒取 `poseAt(orbit, orbitT).position[1]`（bob 带）——
//    若 chase 把 y 钉死在 `orbit.y`，orbit→chase 瞬间会跳最多 `bobAmplitude`(1.5) 格。
// 2. **移动沿 yaw 的前向向量**（不是直指玩家）：龙是飞行器，yaw 平滑转向 + 沿机头飞才自然
//    产生「飞跃 → 拉远 → 掉头」；直指玩家会让 turn 子态的外飞失去意义（瞬时反向）。
// 3. **只读 state 与 ctx，返回全新 plain 对象**（M5 不变式）；不生成实体、不改世界 ——
//    开火意图写进 `fireRequest`，由 `game.js` 消费（Task 3 接入，本文件 Task 2 恒 null）。
//
// ⚠️ **本文件不 import `dragon-system.js`**（避免环）：轨道 pose 由构造注入（`poseAt`）。
// 生产装配传 `dragonPoseAt`，单测传确定性 fake —— Agent 因此独立可测。

import { BossAgent } from './boss-agent.js';
import { DRAGON_AI, DRAGON } from '../dragons/dragon-config.js';

export class DragonBossAgent extends BossAgent {
  /**
   * @param {{poseAt: (orbit: object, t: number) => {position: [number,number,number], yaw: number},
   *          rng?: () => number}} deps
   *        `poseAt` = 轨道 pose 唯一权威（生产 = `dragonPoseAt`）。
   *        `rng` 可注入（默认 `Math.random`）—— Task 3 的开火冷却用它，测试钉区间。
   */
  constructor({ poseAt, rng = Math.random } = {}) {
    super();
    if (typeof poseAt !== 'function') {
      throw new Error('DragonBossAgent 需要注入 poseAt（轨道 pose 唯一权威）');
    }
    this.poseAt = poseAt;
    this.rng = rng;
  }

  /**
   * 推进一帧。
   * @param {object} state 龙 state（含 mode/attackPhase/fireCooldown/losTimer/losVisible/turnDist）
   * @param {number} dt 秒
   * @param {{world: object, registry: object,
   *          player: {position: [number,number,number]} | null}} ctx
   * @returns {object} 全新 state 各字段（plain 对象，由 dragon-system 的 createState 包裹）
   */
  update(state, dt, ctx) {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    // ① 轨道时钟在所有模式都推进（y 的 bob 带 + return 的追及目标都从它派生）
    const orbitT = state.orbitT + step;
    const orbitPose = this.poseAt(state.orbit, orbitT);
    const y = orbitPose.position[1];

    // ② 本帧起点：orbit 模式用轨道点，其余用上一帧位置（位置连续，不跳帧）
    let px = state.mode === 'orbit' ? orbitPose.position[0] : state.position[0];
    let pz = state.mode === 'orbit' ? orbitPose.position[2] : state.position[2];
    let yaw = state.mode === 'orbit' ? orbitPose.yaw : state.yaw;

    // ③ 视线缓存（倒计时；<=0 重查并重置）。所有模式共用 —— chase/attack 靠它判脱离。
    let losTimer = state.losTimer - step;
    let losVisible = state.losVisible;
    if (losTimer <= 0) {
      losVisible = this._queryLos([px, y, pz], ctx);
      losTimer = DRAGON_AI.losInterval;
    }

    // ④ 玩家瞄准点（胸部）。player 可能为 null（无玩家上下文 → 只盘旋）。
    const player = ctx.player && Array.isArray(ctx.player.position) ? ctx.player.position : null;

    let mode = state.mode;
    let attackPhase = state.attackPhase;
    let turnDist = state.turnDist;

    // ⑤ 转移判定（用本帧起点位置）—— 与移动同帧完成，不慢一帧
    if (mode === 'orbit') {
      if (player && losVisible && this._hDist([px, y, pz], player) <= DRAGON_AI.sightRange) {
        mode = 'chase';
      }
    } else if (mode === 'chase') {
      if (!losVisible) mode = 'return';
      else if (player && this._hDist([px, y, pz], player) <= DRAGON_AI.attackRange) {
        mode = 'attack'; attackPhase = 'approach'; turnDist = 0;
      }
    } else if (mode === 'attack') {
      const dist = player ? this._hDist([px, y, pz], player) : Infinity;
      if (!losVisible || dist > DRAGON_AI.disengageDistance) mode = 'return';
    }

    // ⑥ 按（可能已切换的）新模式移动
    if (mode === 'orbit') {
      px = orbitPose.position[0];
      pz = orbitPose.position[2];
      yaw = orbitPose.yaw;
    } else if (mode === 'return') {
      // 追及「当前 orbitT 的轨道点」（轨道点以 orbitSpeed 移动，龙更快 ⇒ 必收敛、切回无跳变）
      yaw = this._steerYaw(yaw, this._angleTo([px, y, pz], orbitPose.position), step);
      px += -Math.sin(yaw) * DRAGON_AI.chaseSpeed * step;
      pz += -Math.cos(yaw) * DRAGON_AI.chaseSpeed * step;
      if (this._hDist([px, y, pz], orbitPose.position) <= DRAGON_AI.returnArriveDistance) mode = 'orbit';
    } else {
      // chase / attack：沿机头前向飞（前向 = (−sin yaw, −cos yaw)，本仓 yaw 口径）
      //
      // ⚠️ **`turn` 子态刻意不追踪玩家**：飞跃后必须**直飞拉远**，若 yaw 继续追踪会立刻
      // U 型转弯（形态是「龙在玩家头顶原地打转」，`turnAroundDistance` 的外飞失去意义）。
      // 掉头回 `approach` 后 yaw 才重新开始追踪 —— 那正是用户说的「盘旋回头再次递近」。
      const tracking = !(mode === 'attack' && attackPhase === 'turn');
      if (player && tracking) {
        yaw = this._steerYaw(yaw, this._angleTo([px, y, pz], player), step);
      }
      px += -Math.sin(yaw) * DRAGON_AI.chaseSpeed * step;
      pz += -Math.cos(yaw) * DRAGON_AI.chaseSpeed * step;

      if (mode === 'attack') {
        if (attackPhase === 'approach') {
          if (player && this._hDist([px, y, pz], player) <= DRAGON_AI.flyoverDistance) {
            attackPhase = 'turn'; turnDist = 0;
          }
        } else {
          turnDist += DRAGON_AI.chaseSpeed * step;
          if (turnDist >= DRAGON_AI.turnAroundDistance) { attackPhase = 'approach'; turnDist = 0; }
        }
      }
    }

    // ⑦ 开火判定（只在 chase / attack 两个模式；orbit 自由盘旋与 return 回家途中不喷火）
    //
    // ⚠️ **v2.45 瞄准保持**（用户：「转身后龙头大致方向对准玩家的方向再发射火球」）：
    // `aimTime` 在「模式可喷火 + 有玩家 + yaw 在喷火锥内」时累积，**出锥即清零**。
    // 只有累积到 `aimHoldSeconds` 才允许开火 —— 彻底消除「刚转身扫过锥内那一帧就吐」。
    // 累积**不看冷却与距离**：冷却到点时若已对准就立即喷（否则玩家会看到
    // 「龙头明明对着我却不喷」）；距离门控留在开火那一刻判。
    let fireRequest = null;
    let fireCooldown = Math.max(0, (Number.isFinite(state.fireCooldown) ? state.fireCooldown : 0) - step);
    let aimTime = Number.isFinite(state.aimTime) ? state.aimTime : 0;
    const canAim = (mode === 'chase' || mode === 'attack') && player !== null;
    if (canAim && this._inFireCone([px, y, pz], yaw, player)) {
      aimTime += step;
    } else {
      aimTime = 0;   // 出锥 / 不可喷火模式 / 无玩家 → 重新对准
    }
    if (canAim && fireCooldown <= 0 && aimTime >= DRAGON_AI.aimHoldSeconds) {
      fireRequest = this._tryFire([px, y, pz], yaw, player, ctx);
      if (fireRequest) {
        const { fireCooldownMin: lo, fireCooldownMax: hi } = DRAGON_AI;
        // ⚠️ 减去本帧的 step：顶部已统一扣过一次 dt，这里不补扣会让实际间隔多出一帧
        fireCooldown = lo + this.rng() * (hi - lo) - step;
        aimTime = 0;   // 喷过就清零：下一发须重新对准（不得攒着连喷）
      }
    }

    return {
      position: [px, y, pz],
      yaw,
      orbit: state.orbit,
      orbitT,
      health: state.health,
      flashedUntil: state.flashedUntil,
      mode,
      attackPhase,
      fireCooldown,
      losTimer,
      losVisible,
      turnDist,
      aimTime,
      fireRequest,
    };
  }

  /**
   * 龙头是否已对准玩家（水平夹角 ≤ `fireConeDeg`）。
   *
   * ⚠️ **判据用身体中心→玩家的水平角**（不是嘴部）：yaw 是身体的航向，而嘴部偏移是
   * 由 yaw 派生的 —— 用嘴部算夹角会把「已经对准」误判成「偏了 3 格」。
   * @param {[number,number,number]} pos 身体中心 @param {number} yaw
   * @param {[number,number,number]} player 玩家脚底
   * @returns {boolean}
   */
  _inFireCone(pos, yaw, player) {
    const cone = DRAGON_AI.fireConeDeg * Math.PI / 180;
    return Math.abs(this._angleDiff(yaw, this._angleTo(pos, player))) <= cone;
  }

  /**
   * 嘴部世界坐标（v2.45，用户：「火球吐出来的位置现在大致是火龙脖子的位置，要在嘴的位置」）。
   *
   * = 身体中心 + 按 yaw 旋转的 `DRAGON.muzzleOffset`。旋转公式与渲染层
   * `pivot.rotation.set(0, yaw, 0)` 同一套（three 绕 Y 轴：x' = x·cosθ + z·sinθ、
   * z' = −x·sinθ + z·cosθ）。代入 `muzzleOffset = (0, −0.47, −3.36)` 得 xz 偏移
   * = 3.36 × 本仓前向向量 (−sin yaw, −cos yaw) —— 即「沿机头前向 3.36 格、低 0.47 格」。
   *
   * @param {[number,number,number]} pos 身体中心 @param {number} yaw
   * @returns {[number,number,number]} 新数组
   */
  _muzzlePosition(pos, yaw) {
    const [ox, oy, oz] = DRAGON.muzzleOffset;
    const s = Math.sin(yaw), c = Math.cos(yaw);
    return [pos[0] + ox * c + oz * s, pos[1] + oy, pos[2] - ox * s + oz * c];
  }

  /**
   * 开火判据（用户：「脑袋冲着玩家发射火球」+「至少间隔五到十秒」）。
   *
   * ① 脑袋朝向玩家 + **瞄准保持**（调用方已判：`_inFireCone` 累积 `aimTime` ≥ `aimHoldSeconds`）；
   * ② 冷却到点（调用方已判）；
   * ③ **新鲜视线复查** —— ⚠️ 不得用 `losVisible` 缓存：缓存 10Hz，而玩家可能在这 0.1 秒
   *    里走进墙后（形态是「隔着墙喷火」）；
   * ④ 水平距 ≤ `fireRange`（太远不浪费火球）。
   *
   * ⚠️ **v2.45：出生点 = 嘴部**（`_muzzlePosition`），瞄准方向 = 嘴部→玩家胸部。
   * 从身体中心出生会让火球「从脖子里冒出来」（用户报告的原话）。
   *
   * @param {[number,number,number]} pos 龙身体中心 @param {number} yaw
   * @param {[number,number,number]} player 玩家脚底位置 @param {object} ctx
   * @returns {{position: [number,number,number], direction: [number,number,number]}|null}
   */
  _tryFire(pos, yaw, player, ctx) {
    // ④ 距离（用身体中心：fireRange 是「龙与玩家多远」的口径）
    if (this._hDist(pos, player) > DRAGON_AI.fireRange) return null;
    const muzzle = this._muzzlePosition(pos, yaw);
    const aim = [player[0], player[1] + DRAGON_AI.playerAimOffsetY, player[2]];
    // ③ 新鲜视线复查（从嘴部起算 —— 火球真的要从那里飞出去）
    if (!this._hasLos(ctx, muzzle, aim)) return null;
    // 方向 = 归一化(玩家胸部 − 嘴部)：精确瞄准（脑袋已对准 ±10° 且保持了 0.2 秒）
    const dx = aim[0] - muzzle[0], dy = aim[1] - muzzle[1], dz = aim[2] - muzzle[2];
    const len = Math.hypot(dx, dy, dz);
    if (!(len > 1e-9)) return null;   // 贴身退化：方向无法归一化
    return { position: muzzle, direction: [dx / len, dy / len, dz / len] };
  }

  /**
   * yaw 平滑转向（`turnRate` 限速）。
   * @param {number} yaw 当前 @param {number} target 目标 @param {number} step dt
   * @returns {number} 新 yaw
   */
  _steerYaw(yaw, target, step) {
    const diff = this._angleDiff(yaw, target);
    const maxTurn = DRAGON_AI.turnRate * step;
    return yaw + Math.max(-maxTurn, Math.min(maxTurn, diff));
  }

  /**
   * 视线查询：龙（身体中心）→ 玩家胸部。转调炮塔 LOS 唯一权威（`_hasLos`）。
   * ⚠️ 遮挡判据 = 「实心不透明」（`isProjectileOccluding`）：能透过玻璃/水，树叶会挡。
   * @param {[number,number,number]} from @param {object} ctx
   * @returns {boolean}
   */
  _queryLos(from, ctx) {
    const player = ctx.player && Array.isArray(ctx.player.position) ? ctx.player.position : null;
    if (!player) return false;
    const to = [player[0], player[1] + DRAGON_AI.playerAimOffsetY, player[2]];
    return this._hasLos(ctx, from, to);
  }
}
