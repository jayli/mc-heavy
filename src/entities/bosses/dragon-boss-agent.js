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
// 1. **`orbitT` 在所有模式都推进**，y = `poseAt(orbit, orbitT).position[1]`（bob 带）
//    **+ `diveOffset`**（v2.48 俯冲）。
//    ⚠️ v2.44~v2.46 的旧约定是「y 恒取 poseAt 的 y」（完全不俯冲）—— 它已被 v2.48 取代，
//    但**零回归的那一半必须保留**：`diveOffset === 0` 时 y 与旧实现**逐位相同**（单测钉死）。
//    若 chase 把 y 钉死在 `orbit.y`，orbit→chase 瞬间会跳最多 `bobAmplitude`(1.5) 格；
//    而俯冲结束后 `diveOffset` 缓归 0 ⇒ 切回 orbit 时也无跳变。
// 2. **水平移动沿 yaw 的前向向量**（不是直指玩家）：龙是飞行器，yaw 平滑转向 + 沿机头飞才
//    自然产生「飞跃 → 拉远 → 掉头」；直指玩家会让 turn 子态的外飞失去意义（瞬时反向）。
//    ⚠️ v2.48 起**水平位移仍按 yaw 算、不按 pitch 缩短**：俯冲是姿态，不是「把 9 格/秒
//    分解成水平与竖直」的向量飞行（后者会让水平追及变慢、手感变钝，且 attack 的
//    `flyoverDistance` / `turnAroundDistance` 阈值全是**水平**口径）。竖直分量由 `diveOffset`
//    单独积分。
// 3. **只读 state 与 ctx，返回全新 plain 对象**（M5 不变式）；不生成实体、不改世界 ——
//    开火意图写进 `fireRequest`，由 `game.js` 消费。
//
// ⚠️ **本文件不 import `dragon-system.js`**（避免环）：轨道 pose 由构造注入（`poseAt`）。
// 生产装配传 `dragonPoseAt`，单测传确定性 fake —— Agent 因此独立可测。

import { BossAgent } from './boss-agent.js';
import { DRAGON_AI, DRAGON } from '../dragons/dragon-config.js';
import { dragonForward, dragonMuzzleOffsetWorld } from '../dragons/dragon-facing.js';

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

    // ① 轨道时钟在所有模式都推进（bob 带 + return 的追及目标 + 俯冲基准高度都从它派生）
    const orbitT = state.orbitT + step;
    const orbitPose = this.poseAt(state.orbit, orbitT);
    const orbitY = orbitPose.position[1];

    // ② 本帧起点：orbit 模式用轨道点，其余用上一帧位置（位置连续，不跳帧）
    let px = state.mode === 'orbit' ? orbitPose.position[0] : state.position[0];
    let pz = state.mode === 'orbit' ? orbitPose.position[2] : state.position[2];
    let yaw = state.mode === 'orbit' ? orbitPose.yaw : state.yaw;
    // v2.48：俯仰与俯冲位移。**orbit 模式一律归零**（盘旋必须是平飞）——
    // 从 chase/attack 切回 orbit 的那一帧若还带着 pitch，龙会以低头姿态继续盘旋整圈
    // （`orbit` 分支不再推进姿态）；深度靠 `climbRate` 在 return 阶段爬回，
    // 切 orbit 时可能残留一点（≤ climbRate × return 时长），不再额外跳变。
    let pitch = state.mode === 'orbit' ? 0 : (Number.isFinite(state.pitch) ? state.pitch : 0);
    let diveOffset = Number.isFinite(state.diveOffset) ? state.diveOffset : 0;
    let y = orbitY + diveOffset;

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

    // ⑥b 俯仰姿态与俯冲（v2.48）—— 用户：「可以让火龙在大致朝向玩家的时候让身体俯冲一下
    // 朝向玩家转向后喷火球，喷完火球后又返回到原来的飞行轨迹上」。
    //
    // ⚠️ **这是 v2.48 的根因修复**：之前龙的身体俯仰恒 0（纯 2D AI），飞到玩家头顶时 yaw 的
    // 水平角恰好完美 ⇒ 旧的「只看水平角」喷火锥无条件通过 ⇒ 从水平飞行的身体上下蛋。
    //
    // 三段：① 算「应向玩家低头多少」（clamp 在 `maxDivePitch`/`maxClimbPitch`）；
    // ② pitch 按 `pitchRate` 限速追踪它（不在可瞄准帧里就缓归 0 = 拉平）；
    // ③ 竖直位移按 `sin(pitch)` 积分（低头 → 往下走），双闸门限制深度与世界高度底线。
    //
    // ⚠️ **`aimPitch` 不依赖水平相对角**（用户要的「先大致朝向、再俯冲」，不是「先精确对准、再低头」）：
    // 若 pitch 也要求水平已对准，则横向掠袭时龙抬不起头，永远进不了锥 —— 开火频率会崩。
    //
    // ⚠️ **但必须门控在「射程窗口」内**（`fireRange` ≥ hDist ≥ `minFireDistance`）：
    // 否则远在 5000 格外的追击也会把鼻尖压低 0.3°，而竖直积分会把它慢推到 `maxDiveDepth` 底部
    // （实测：−0.052 格/秒 × 30 秒 = −1.57 格，而 `pitch` 一直 < 0 ⇒ 爬升分支永不触发）。
    // 门控后语义也更合用户意图：「先飞近，进射程后再低头俯冲喷火；喷完（尤其是飞过头、
    // 水平距 < minFireDistance）就把鼻子抬回平飞，回到原来的飞行轨迹」。
    const canAimMode = (mode === 'chase' || mode === 'attack') && player !== null;
    const dyAim = player ? (player[1] + DRAGON_AI.playerAimOffsetY) - y : 0;
    const hDistNow = player ? this._hDist([px, y, pz], player) : Infinity;
    const inFireWindow = canAimMode
      && hDistNow <= DRAGON_AI.fireRange && hDistNow >= DRAGON_AI.minFireDistance;
    const aimPitch = inFireWindow
      ? clamp(
        Math.atan2(dyAim, Math.max(hDistNow, 1e-6)),
        -DRAGON_AI.maxDivePitch, DRAGON_AI.maxClimbPitch,
      )
      : 0;
    const maxPitchStep = DRAGON_AI.pitchRate * step;
    pitch += clamp(aimPitch - pitch, -maxPitchStep, maxPitchStep);
    // ① 竖直积分：低头下潜、抬头爬升；每帧都向「盘旋高度」收紧，`mode==='orbit'` 归零后自然停止
    if (pitch < 0) {
      diveOffset += DRAGON_AI.chaseSpeed * Math.sin(pitch) * step;
    }
    // ② 双闸门：限深（相对出发高度）+ 限底（绝对世界高度）
    const deepest = Math.max(-DRAGON_AI.maxDiveDepth, DRAGON_AI.minDiveY - orbitY);
    diveOffset = Math.max(diveOffset, deepest);
    // ③ 拉平 / 盘旋时爬回：爬升速率低于下潜速率是刻意的（压下去、喷一口、慢慢爬回来）
    if (pitch >= 0 && diveOffset < 0) {
      diveOffset = Math.min(0, diveOffset + DRAGON_AI.climbRate * step);
    }
    y = orbitY + diveOffset;

    // ⑦ 开火判定（只在 chase / attack 两个模式；orbit 自由盘旋与 return 回家途中不喷火）
    //
    // ⚠️ **v2.45 瞄准保持**（用户：「转身后龙头大致方向对准玩家的方向再发射火球」）：
    // `aimTime` 在「双轴锥内」时累积，**出锥即清零**。
    //
    // ⚠️ **v2.48 双轴锥**（用户：「不能像下蛋一样」）：水平角与竖直角必须**同时**满足。
    // 头顶自然被排除：正上方需要低头 87°，被 `maxDivePitch`(55°) clamp ⇒ 竖直角差 32° >
    // `fireElevationConeDeg`(12°) ⇒ 永不满足，龙继续盘旋等角度 —— **不需任何「头顶特判」**
    // （写特判的形态是判定散落在两处、改一处漂移）。
    let fireRequest = null;
    let fireCooldown = Math.max(0, (Number.isFinite(state.fireCooldown) ? state.fireCooldown : 0) - step);
    let aimTime = Number.isFinite(state.aimTime) ? state.aimTime : 0;
    if (canAimMode && this._inFireCone([px, y, pz], yaw, pitch, player)) {
      aimTime += step;
    } else {
      aimTime = 0;   // 出锥 / 不可喷火模式 / 无玩家 → 重新对准
    }
    if (canAimMode && fireCooldown <= 0 && aimTime >= DRAGON_AI.aimHoldSeconds) {
      fireRequest = this._tryFire([px, y, pz], yaw, pitch, player, ctx);
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
      pitch,
      diveOffset,
      fireRequest,
    };
  }

  /**
   * 机头是否已对准玩家 —— **双轴锥**（v2.48）。
   *
   * ① 水平：`|Δyaw| ≤ fireConeDeg`（v2.45 的 10°）；
   * ② 竖直：`|pitch − aimPitch| ≤ fireElevationConeDeg`（v2.48 新增的 12°）。
   *
   * ⚠️ **两轴必须同时满足**，任一条单看都会放过「头顶下蛋」：头顶时水平角完美（Δyaw≈0），
   * 但需要低头 87° 而 `pitch` 被 `maxDivePitch` clamp 到 −55°。
   *
   * ⚠️ **判据用身体中心→玩家**（不是嘴部）：yaw/pitch 是身体的姿态，而嘴部偏移是由它们
   * 派生的 —— 用嘴部算夹角会把「已经对准」误判成「偏了 3 格」。
   *
   * ⚠️ 竖直那一项的参照是 **`_aimPitch()`（clamp 后的值）**，不是原始的 `atan2`：
   * 拿未 clamp 的值比会让「本来就到不了的俯仰」永远差一大截，永远喷不出火。
   *
   * @param {[number,number,number]} pos 身体中心 @param {number} yaw @param {number} pitch
   * @param {[number,number,number]} player 玩家脚底
   * @returns {boolean}
   */
  _inFireCone(pos, yaw, pitch, player) {
    const cone = DRAGON_AI.fireConeDeg * Math.PI / 180;
    if (Math.abs(this._angleDiff(yaw, this._angleTo(pos, player))) > cone) return false;
    const elevationCone = DRAGON_AI.fireElevationConeDeg * Math.PI / 180;
    const want = this._aimPitch(pos, player);
    return Math.abs(pitch - want) <= elevationCone;
  }

  /**
   * 「应向玩家低头多少」（弧度，负 = 低头），已 clamp 到 `[-maxDivePitch, +maxClimbPitch]`。
   *
   * ⚠️ **不受水平相对角影响**：pitch 只追俯仰角本身。若这里也要求「水平已对准」，
   * 横向掠袭时龙抬不起头，就永远进不了双轴锥（形态：龙只在极少数「恰好从正前方来」的
   * 机会喷火，整体开火频率崩掉）。
   *
   * @param {[number,number,number]} pos 龙身体中心
   * @param {[number,number,number]} player 玩家脚底
   * @returns {number}
   */
  _aimPitch(pos, player) {
    const dy = (player[1] + DRAGON_AI.playerAimOffsetY) - pos[1];
    const h = this._hDist(pos, player);
    return clamp(
      Math.atan2(dy, Math.max(h, 1e-6)),
      -DRAGON_AI.maxDivePitch, DRAGON_AI.maxClimbPitch,
    );
  }

  /**
   * 嘴部世界坐标（v2.45 立 / v2.48 加俯仰）。
   *
   * = 身体中心 + `R(yaw)·R(pitch)` 旋转过的 `DRAGON.muzzleOffset`。
   * ⚠️ **旋转公式不在这里写**：它住在 `dragons/dragon-facing.js`（唯一权威）——
   * 渲染层、命中盒、本文件、测试夹具四处共用同一份。各自写一份会漂移出「看到的龙低头 40°，
   * 火球却按低头 20° 飞」而格数/指纹/单测全绿（M8 炮塔「弹丸往天上飞」同类）。
   *
   * @param {[number,number,number]} pos 身体中心 @param {number} yaw @param {number} pitch
   * @returns {[number,number,number]} 新数组
   */
  _muzzlePosition(pos, yaw, pitch) {
    const off = dragonMuzzleOffsetWorld(yaw, pitch, DRAGON.muzzleOffset);
    return [pos[0] + off[0], pos[1] + off[1], pos[2] + off[2]];
  }

  /**
   * 开火判据（用户：「脑袋冲着玩家发射火球」+「至少间隔五到十秒」）。
   *
   * ① 脑袋朝向玩家（双轴）+ **瞄准保持**（调用方已判：`aimTime` ≥ `aimHoldSeconds`）；
   * ② 冷却到点（调用方已判）；
   * ③ **新鲜视线复查** —— ⚠️ 不得用 `losVisible` 缓存：缓存 10Hz，而玩家可能在这 0.1 秒
   *    里走进墙后（形态是「隔着墙喷火」）；
   * ④ 水平距 ≤ `fireRange` 且 ≥ `minFireDistance`（太远不浪费、太近姿态追不上 —— 后者同时是
   *    「头顶不下蛋」的显式闸门，双轴锥已在数学上排除它，这里只是防御性的第二道门）。
   *
   * ## v2.48 的两项语义变更
   *
   * - **出生点 = 嘴部并随俯仰旋转**（`_muzzlePosition(pos, yaw, pitch)`）：低头俯冲时嘴在龙头下方，
   *   不按 pitch 旋转会让火球从「抬头时嘴后上方」冒出来。
   * - **方向 = 机头前向**（`dragonForward(yaw, pitch)`），不再从嘴部朝玩家胸部做点对点瞄准。
   *   用户 2026-11-04 裁定「火球方向要严格等于机头方向」—— 否则即使锥内对准，仍会出现
   *   「飞龙身体朝东、火球往东南飞」的观感偏差（“下蛋”的本质）。
   *   代价：落点偏差可达 `tan(fireConeDeg)×距离`（10° × 20 格 ≈ 3.5 格）。火球本就不掉血，可接受。
   *
   * @param {[number,number,number]} pos 龙身体中心 @param {number} yaw @param {number} pitch
   * @param {[number,number,number]} player 玩家脚底位置 @param {object} ctx
   * @returns {{position: [number,number,number], direction: [number,number,number]}|null}
   */
  _tryFire(pos, yaw, pitch, player, ctx) {
    // ④ 距离（用身体中心：fireRange 是「龙与玩家多远」的口径）
    const hDist = this._hDist(pos, player);
    if (hDist > DRAGON_AI.fireRange) return null;
    if (hDist < DRAGON_AI.minFireDistance) return null;
    const muzzle = this._muzzlePosition(pos, yaw, pitch);
    const aim = [player[0], player[1] + DRAGON_AI.playerAimOffsetY, player[2]];
    // ③ 新鲜视线复查（从嘴部起算 —— 火球真的要从那里飞出去）
    // ⚠️ 用「目标点」而非机头方向做 LOS：判据是「我看得见你吗」，不是「我的枪口指向哪里」。
    // 两者在双轴锥内相近，但用目标点能在「低头角被 clamp 差一点点」时不误杀。
    if (!this._hasLos(ctx, muzzle, aim)) return null;
    // 方向 = 机头前向（v2.48）—— 与渲染层 / 命中盒共用 `dragon-facing.js` 的唯一实现
    const forward = dragonForward(yaw, pitch);
    const len = Math.hypot(forward[0], forward[1], forward[2]);
    if (!(len > 1e-9)) return null;   // 退化：方向无法归一化（理论不会发生，前向恒为单位）
    return { position: muzzle, direction: [forward[0] / len, forward[1] / len, forward[2] / len] };
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

/**
 * 把 v 夹到 [lo, hi]。本文件唯一的小工具 —— 不用 `Math.min/max` 嵌套是为了让
 * 「已 clamp」的语义在 `_aimPitch` / 竖直积分两处读起来一致（两处必须用同一口径）。
 * @param {number} v @param {number} lo @param {number} hi
 * @returns {number}
 */
function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}
