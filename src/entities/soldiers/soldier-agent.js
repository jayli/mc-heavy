// src/entities/soldiers/soldier-agent.js — 士兵状态机（方案 B）
//
// 同构层：**无 DOM、无 three、不新增 Worker**（`check:arch` 静态门守）。
//
// 上游 `enemies.js` 的 `Soldier.thinkStep()` / `update()`，**掩体三件换成距离环**
// （用户 2026-11-24 裁定「B，先简单实现」）：上游 `pickCover / coverBad / 探头` 依赖
// `level.cover`（那张固定城市地图手写的掩体点），本仓是无限程序化世界，无此数据。
//
// ## 三条载荷性契约（与焰魔/守卫 Agent 同）
//
// 1. **只读 state 与 ctx，返回全新 state 各字段 + 全新数组**。原地改写会让
//    `EntityManager.update` 的跨 column 索引迁移判据 before/after 同源 ⇒ 索引永不迁移
//    ⇒ column 卸载漏回收（M5 不变式）。
// 2. **不生成实体、不改世界、不写玩家血量**：开火只写 `shotRequest` 意图，
//    由 `game.js` 在 `entities.update` 之后结算。
// 3. **每个跨帧量都必须在 `createSoldierState` 的白名单里**：漏一个 ⇒ 每帧重置
//    ⇒ 该机制永不生效，而所有数值判据看着全对（焰魔/守卫各踩过一次）。
//
// ## ⚠️ yaw 口径与 Boss 相反
//
// 士兵前向 = `(sin yaw, cos yaw)`（与丧尸 `yaw = atan2(vx,vz)` 同源），
// **不是** Boss 那套 `(-sin,-cos)`。用错一侧的形态是「士兵背对玩家开枪」。
import {
  SOLDIER, SOLDIER_AI, SOLDIER_SHOT, SOLDIER_GAIT, SOLDIER_STEERING,
  soldierAwarenessRate, soldierEyeY, soldierMuzzleWorld,
} from './soldier-config.js';
import { normalizePosition } from '../entity-types.js';
import { steerIntentAabb } from '../zombies/zombie-navigation.js';
import { hasLineOfSight } from '../turrets/turret-system.js';

/** 合法 mode（其余回落 patrol） */
const MODES = Object.freeze(['patrol', 'combat', 'search']);

/** 视线缓存周期（秒）= 10Hz，不每帧重查（照守卫 losInterval 口径） */
const LOS_INTERVAL = 0.1;
/** 「路径偏差多大才值得跑 A*」阈值（弧度，≈5°）—— 同守卫的 PATH_DEVIATION_EPS */
const PATH_DEVIATION_EPS = 5 * Math.PI / 180;
/** 玩家疾跑判定阈值（格/秒）：本仓无疾跑档，用速度近似（玩家 SPEED=8） */
const SPRINT_SPEED = 6;
/** 玩家胸部高度（视线终点，与炮塔 enemyBodyOffsetY 同值语义） */
const PLAYER_CHEST_Y = 1.2;

function num(v, fallback) { return Number.isFinite(v) ? v : fallback; }
function vec3(v) {
  return Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n))
    ? [v[0], v[1], v[2]] : null;
}
function vec2(v) {
  return Array.isArray(v) && v.length === 2 && v.every((n) => Number.isFinite(n))
    ? [v[0], v[1]] : null;
}
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
/** 最短角差（归一化到 [-π,π]），与炮塔 shortestAngleDiff 同口径 */
function angleDelta(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
/** 指数趋近（上游 `damp`） */
function damp(cur, target, rate, dt) { return cur + (target - cur) * Math.min(1, rate * dt); }

/**
 * 构造全新 state。**白名单里的每一项都是跨帧量或瞬态量，一个都不能漏**。
 *
 * @param {object} raw @returns {object|null} position 非法时 null
 */
export function createSoldierState(raw) {
  if (!raw) return null;
  const position = normalizePosition(raw.position);
  if (!position) return null;
  const v = vec3(raw.velocity) || [0, 0, 0];
  return {
    position,
    velocity: v,
    yaw: num(raw.yaw, 0),
    aimPitch: num(raw.aimPitch, 0),
    health: num(raw.health, SOLDIER.health),
    flashedUntil: num(raw.flashedUntil, 0),
    mode: MODES.includes(raw.mode) ? raw.mode : 'patrol',
    /** 发现玩家的累积量（0..1），到 1 才进 combat */
    awareness: num(raw.awareness, 0),
    /** 蹲姿插值量 0..1（渲染与命中盒都读它） */
    crouch: num(raw.crouch, 0),
    /** 意图：是否要蹲（与 crouch 分开 —— 一个是目标一个是当前） */
    crouching: raw.crouching === true,
    /** 蹲/站切换倒计时（秒） */
    peekT: num(raw.peekT, 0),
    /** 侧向游走方向 ±1 */
    strafe: raw.strafe === -1 ? -1 : 1,
    /** 侧向换向倒计时 */
    strafeT: num(raw.strafeT, 0),
    /** 步态相位（弧度） */
    walkPhase: num(raw.walkPhase, 0),
    /** 本轮剩余发数 */
    burst: Math.max(0, Math.floor(num(raw.burst, 0))),
    /** 发间隔倒计时 */
    shotT: num(raw.shotT, 0),
    /** 两轮之间的间隔倒计时 */
    nextBurst: num(raw.nextBurst, 0),
    /** 是否首轮（命中率基数不同） */
    firstBurst: raw.firstBurst !== false,
    /** 进战反应延迟 */
    reaction: num(raw.reaction, 0),
    /** 班组报警的延迟入战倒计时；<0 = 无 pending */
    alertDelay: num(raw.alertDelay, -1),
    /** 巡逻/搜索时的「看哪里」（与身体 yaw 分开，上游 lookYaw 同语义） */
    lookYaw: num(raw.lookYaw, num(raw.yaw, 0)),
    /** 自己最后一次看见玩家的时刻（ms） */
    lastSeen: num(raw.lastSeen, -1e9),
    /** search 剩余时长 */
    searchT: num(raw.searchT, 0),
    /** 巡逻等待倒计时 */
    patrolWait: num(raw.patrolWait, 0),
    /** 巡逻锚点（出生点，方案 B 替代上游 route） */
    patrolAnchor: vec3(raw.patrolAnchor) || [position[0], position[1], position[2]],
    /** 当前巡逻目标点 */
    patrolTarget: vec3(raw.patrolTarget),
    /** 视线缓存计时 */
    losTimer: num(raw.losTimer, 0),
    losVisible: raw.losVisible === true,
    /** 卡住累计 */
    stuckT: num(raw.stuckT, 0),
    stuckAnchor: vec2(raw.stuckAnchor),
    /** 死后经过秒数 */
    deadT: num(raw.deadT, 0),
    dead: raw.dead === true,
    /** 倒地方向 ±1（由击杀方向决定） */
    fallDir: raw.fallDir === -1 ? -1 : 1,
    /** 寻路结果（Service 写，Agent 读） */
    navDir: vec2(raw.navDir),
    navMode: raw.navMode === 'chasing' || raw.navMode === 'blocked' ? raw.navMode : null,
    needsPath: raw.needsPath === true,
    onGround: raw.onGround === true,
    source: typeof raw.source === 'string' ? raw.source : null,
    /** 瞬态：本帧要结算一发。由 game.js 在 entities.update 之后消费 */
    shotRequest: raw.shotRequest || null,
    /** 60Hz 物理 accumulator（瞬态但必须跨帧保留） */
    _physAccum: num(raw._physAccum, 0),
  };
}

/**
 * 士兵智能体。**无跨帧可变成员**（除注入的 rng）⇒ 一个实例服务全部士兵安全。
 */
export class SoldierAgent {
  /** @param {{rng?: () => number}} deps rng 可注入（测试据此钉住发数与间隔） */
  constructor({ rng = Math.random } = {}) {
    this.rng = rng;
  }

  /** 区间随机 */
  _rand(lo, hi) { return lo + this.rng() * (hi - lo); }

  /**
   * 推进一拍。
   * @param {object} state @param {number} dt 秒
   * @param {{world:object, registry:object,
   *          player:{position:number[], speed?:number, grounded?:boolean}|null,
   *          nowMs:number, bursting:number, lastKnown:number[]|null,
   *          lastSeenAny:number, advancerId:string|null, selfId?:string}} ctx
   * @returns {object} 全新 state 各字段
   */
  update(state, dt, ctx) {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const world = ctx?.world || null;
    const registry = ctx?.registry || null;
    const player = ctx?.player && Array.isArray(ctx.player.position) ? ctx.player : null;
    const nowMs = num(ctx?.nowMs, 0);
    const lastKnown = vec3(ctx?.lastKnown);
    const lastSeenAny = num(ctx?.lastSeenAny, -1e9);
    const since = (nowMs - lastSeenAny) / 1000;

    // 全部字段先取出来（下面逐段改写，最后一次性 createState）
    let s = { ...state };
    s.shotRequest = null;   // 瞬态：每帧重置，只有本帧真开火才写

    // ---- 死亡：只保持 deadT（由 Service.update 推进，两处都推会双倍计时），
    // 尸体水平速度清零（竖直由物理处理落地）----
    if (s.dead) {
      s.velocity = [0, s.velocity[1], 0];
      return createSoldierState(s);
    }

    const px = s.position[0], py = s.position[1], pz = s.position[2];
    const hDist = player ? Math.hypot(player.position[0] - px, player.position[2] - pz) : Infinity;

    // ---- 视线缓存（10Hz）----
    s.losTimer = num(s.losTimer, 0) - step;
    if (s.losTimer <= 0) {
      s.losTimer = LOS_INTERVAL;
      s.losVisible = !!(player && world && registry && hasLineOfSight({
        world, registry,
        from: [px, py + soldierEyeY(s.crouch), pz],
        to: [player.position[0], player.position[1] + PLAYER_CHEST_Y, player.position[2]],
      }));
    }
    const los = s.losVisible && hDist <= SOLDIER_AI.combatLosRange;

    // ---- 班组报警的延迟入战 ----
    if (s.alertDelay >= 0) {
      s.alertDelay -= step;
      if (s.alertDelay < 0) s = this._enterCombat(s);
    }

    // ---- 状态转移 ----
    if (s.mode === 'combat') {
      if (los) s.lastSeen = nowMs;
      // ⚠️ **降级判据取「班组最后看见」与「自己最后看见」的较晚者**。
      // 只看 ctx.lastSeenAny 会在它还是初值（-1e9）时把 since 算成天文数字，
      // 于是**刚进战斗、玩家就在眼前也立即掉回 search**（实测：第 0 拍 mode 已是 search，
      // 速度恒 0、永不瞄准、永不开火）。班组情报由 Service 写，但个体自己的视线同样算数。
      const seenAt = Math.max(lastSeenAny, num(s.lastSeen, -1e9));
      const sinceSeen = (nowMs - seenAt) / 1000;
      if (sinceSeen > SOLDIER_AI.loseSightToSearchSeconds) {
        s.mode = 'search';
        s.searchT = SOLDIER_AI.searchSeconds;
        s.patrolTarget = lastKnown ? [...lastKnown] : null;
      }
    } else {
      // patrol / search：awareness 累积或衰减
      const searching = s.mode === 'search';
      const range = searching ? SOLDIER_AI.sightRangeSearch : SOLDIER_AI.sightRangePatrol;
      const fovCos = searching ? SOLDIER_AI.fovCosSearch : SOLDIER_AI.fovCosPatrol;
      const seen = !!player && hDist <= range && s.losVisible
        && this._inFov(s, player.position, hDist, fovCos);
      if (seen) {
        const sprinting = num(player.speed, 0) > SPRINT_SPEED;
        s.awareness = num(s.awareness, 0)
          + soldierAwarenessRate(hDist, sprinting, searching) * step;
        // ⚠️⚠️ **载荷性：起疑就停下巡逻、转头盯玩家**
        // （上游：`if (awareness > 0.35 && state === 'patrol') { hasGoal = false; wait = 1.5; }`
        //   另在 seen 分支里 `lookYaw = atan2(…)`）。
        // 没有这一段的实测后果：士兵沿巡逻腿走时面朝**走路方向**（正确），
        // 于是视锥转离玩家 ⇒ awareness 刚累到 0.595 就开始衰减 ⇒ **永远进不了 combat**
        // （实测：第 6 拍 fovCos 跌到 0.335 < 0.42，之后单调下降）。
        if (player) s.lookYaw = Math.atan2(player.position[0] - px, player.position[2] - pz);
        if (s.awareness > 0.35 && s.mode === 'patrol') {
          s.patrolTarget = null;
          s.patrolWait = 1.5;
        }
        if (s.awareness >= 1) {
          s = this._enterCombat(s);
          s.lastSeen = nowMs;
        }
      } else {
        s.awareness = Math.max(0, num(s.awareness, 0) - SOLDIER_AI.awarenessDecayPerSecond * step);
      }
      if (s.mode === 'search') {
        s.searchT = num(s.searchT, 0) - step;
        if (s.searchT <= 0) {
          s.mode = 'patrol';
          s.patrolWait = this._rand(SOLDIER_AI.patrolWaitMin, SOLDIER_AI.patrolWaitMax);
          s.patrolTarget = null;
        }
      }
    }

    // ---- 移动意图 ----
    let wantVx = 0, wantVz = 0;
    let speed = 0;
    const combat = s.mode === 'combat';
    if (combat) {
      speed = SOLDIER_AI.combatSpeed;
      // 蹲姿站定（上游 `speed = crouching ? 0 : 4.0`）
      s.peekT = num(s.peekT, 0) - step;
      if (s.peekT <= 0) {
        s.crouching = !s.crouching;
        s.peekT = s.crouching
          ? this._rand(SOLDIER_AI.peekCrouchMin, SOLDIER_AI.peekCrouchMax)
          : this._rand(SOLDIER_AI.peekStandMin, SOLDIER_AI.peekStandMax);
      }
      const advancing = ctx?.advancerId && ctx.selfId === ctx.advancerId
        && since > SOLDIER_AI.advancerSinceSeconds;
      if (advancing && lastKnown) {
        const d = Math.hypot(lastKnown[0] - px, lastKnown[2] - pz) || 1;
        wantVx = (lastKnown[0] - px) / d;
        wantVz = (lastKnown[2] - pz) / d;
        s.crouching = false;
      } else if (!s.crouching && player) {
        // **方案 B 的距离环 + 侧向游走**（替代上游掩体）
        const d = hDist || 1;
        const ux = (player.position[0] - px) / d;
        const uz = (player.position[2] - pz) / d;
        s.strafeT = num(s.strafeT, 0) - step;
        if (s.strafeT <= 0) {
          s.strafe = -s.strafe;
          s.strafeT = this._rand(SOLDIER_AI.strafeFlipMin, SOLDIER_AI.strafeFlipMax);
        }
        const toward = d > SOLDIER_AI.standoffMax ? SOLDIER_AI.towardFar
          : d < SOLDIER_AI.standoffMin ? SOLDIER_AI.towardNear : 0;
        // 切向（绕玩家的垂直方向）× strafe + 径向 × toward
        const tx = -uz * s.strafe * SOLDIER_AI.strafeReach + ux * toward;
        const tz = ux * s.strafe * SOLDIER_AI.strafeReach + uz * toward;
        const tl = Math.hypot(tx, tz) || 1;
        wantVx = tx / tl;
        wantVz = tz / tl;
      }
    } else if (s.mode === 'search') {
      speed = SOLDIER_AI.searchSpeed;
      const goal = s.patrolTarget || lastKnown;
      if (goal) {
        const d = Math.hypot(goal[0] - px, goal[2] - pz);
        if (d > 0.5) { wantVx = (goal[0] - px) / d; wantVz = (goal[2] - pz) / d; }
        else s.patrolTarget = null;
      }
    } else {
      // patrol：出生点附近踱步（方案 B 替代上游手写 route）
      speed = SOLDIER_AI.patrolSpeed;
      if (s.patrolTarget) {
        const d = Math.hypot(s.patrolTarget[0] - px, s.patrolTarget[2] - pz);
        if (d > 0.5) { wantVx = (s.patrolTarget[0] - px) / d; wantVz = (s.patrolTarget[2] - pz) / d; }
        else { s.patrolTarget = null; s.patrolWait = this._rand(SOLDIER_AI.patrolWaitMin, SOLDIER_AI.patrolWaitMax); }
      } else {
        s.patrolWait = num(s.patrolWait, 0) - step;
        if (s.patrolWait <= 0) {
          const a = this.rng() * Math.PI * 2;
          const r = this.rng() * SOLDIER_AI.patrolRadius;
          s.patrolTarget = [
            s.patrolAnchor[0] + Math.cos(a) * r, py, s.patrolAnchor[2] + Math.sin(a) * r,
          ];
        }
      }
      // **巡逻时头部左右扫视**（上游 `lookYaw += Math.sin(t*0.7 + pos.x) * dtT * 0.8`）。
      // ⚠️ 载荷性：没有这一句时，巡逻士兵的 yaw 会被「上一个随机踱步方向」带走，
      // 于是视锥慢慢转离玩家 ⇒ awareness 刚开始累积就因「转出视锥」而衰减 ⇒ **永远发现不了玩家**
      // （实测：第 7 拍 awareness 从 0.595 掉到 0.581，yaw 已漂到 −1.3 而玩家在 0）。
      // 判据用 wantVx/wantVz 而不是下面的 moving（后者尚未声明 —— TDZ）：
      // 巡逻态 speed 恒 > 0 且不蹲，故「有意图」等价于「在移动」。
      if (wantVx === 0 && wantVz === 0) {
        s.lookYaw = num(s.lookYaw, num(s.yaw, 0)) + Math.sin(nowMs / 1000 * 0.7 + px) * step * 0.8;
      }
    }

    // 意图 → 速度（蹲下时速度为 0，但 peekT 仍在上面推进）
    const moving = (wantVx !== 0 || wantVz !== 0) && speed > 0 && !(combat && s.crouching);
    let vx = moving ? wantVx * speed : 0;
    let vz = moving ? wantVz * speed : 0;

    // ---- 局部避障 + 是否需要 A* ----
    s.needsPath = false;
    if (world && (vx !== 0 || vz !== 0)) {
      const directVx = vx, directVz = vz;
      const steered = steerIntentAabb({
        world, position: s.position, vx, vz,
        halfWidth: SOLDIER.width / 2, height: SOLDIER.height,
        maxStep: SOLDIER.maxStep, steering: SOLDIER_STEERING,
      });
      vx = steered.vx; vz = steered.vz;
      if (steered.blocked) s.needsPath = true;
      else {
        const dl = Math.hypot(directVx, directVz), sl = Math.hypot(vx, vz);
        if (dl > 1e-9 && sl > 1e-9) {
          const cos = clamp((directVx * vx + directVz * vz) / (dl * sl), -1, 1);
          if (Math.acos(cos) > PATH_DEVIATION_EPS) s.needsPath = true;
        }
      }
    }
    // 寻路方向优先（Service 上一拍写好的 navDir）
    if (s.needsPath && s.navDir && moving) {
      const nl = Math.hypot(s.navDir[0], s.navDir[1]);
      if (nl > 1e-9) { vx = s.navDir[0] / nl * speed; vz = s.navDir[1] / nl * speed; }
    }
    s.velocity = [vx, s.velocity[1], vz];

    // ---- 卡住检测（净位移判据，不用路径长）----
    if (moving) {
      s.stuckT = num(s.stuckT, 0) + step;
      if (!s.stuckAnchor) s.stuckAnchor = [px, pz];
      if (s.stuckT >= SOLDIER_AI.stuckSeconds) {
        const net = Math.hypot(px - s.stuckAnchor[0], pz - s.stuckAnchor[1]);
        if (net < SOLDIER_AI.stuckDistance) { s.strafe = -s.strafe; s.needsPath = true; }
        s.stuckT = 0;
        s.stuckAnchor = [px, pz];
      }
    } else {
      s.stuckT = 0;
      s.stuckAnchor = [px, pz];
    }

    // ---- 朝向与瞄准 ----
    // 同样取「班组或自己」的较晚者（理由见上方降级判据）
    const sinceAim = (nowMs - Math.max(lastSeenAny, num(s.lastSeen, -1e9))) / 1000;
    const aimTarget = combat && (los || sinceAim < 9);
    let wantYaw = s.yaw;
    if (aimTarget) {
      const tp = los && player ? player.position : (lastKnown || (player && player.position));
      if (tp) {
        // ⚠️ 士兵口径：前向 (sin yaw, cos yaw) ⇒ yaw = atan2(dx, dz)
        wantYaw = Math.atan2(tp[0] - px, tp[2] - pz);
        const dh = Math.hypot(tp[0] - px, tp[2] - pz);
        const pitch = Math.atan2(tp[1] + PLAYER_CHEST_Y - (py + 1.4), dh);
        s.aimPitch = damp(num(s.aimPitch, 0),
          clamp(pitch, SOLDIER_GAIT.aimPitchMin, SOLDIER_GAIT.aimPitchMax), 10, step);
      }
    } else if (moving) {
      wantYaw = Math.atan2(vx, vz);
      s.aimPitch = damp(num(s.aimPitch, 0), -0.25, 6, step);
    } else if (!combat && Number.isFinite(s.lookYaw)) {
      // 站着不动时朝「看哪里」（起疑后 = 玩家方向；否则 = 巡逻扫视）
      wantYaw = s.lookYaw;
    }
    const turnRate = combat ? SOLDIER_AI.turnRateCombat : SOLDIER_AI.turnRateIdle;
    // ⚠️ **只有「瞄准中」或「真在移动」或「有看的方向」才转身**（上游同口径）。
    // 站着巡逻且无 lookYaw 时上面已写了扫视 yaw，这里再转一次会把它盖掉。
    if (aimTarget || moving || (!combat && Number.isFinite(s.lookYaw))) {
      s.yaw = s.yaw + angleDelta(s.yaw, wantYaw) * Math.min(1, step * turnRate);
    }

    // ---- 点射 ----
    if (combat) {
      const suppress = !los && since > SOLDIER_SHOT.suppressSinceMin
        && since < SOLDIER_SHOT.suppressSinceMax
        && !(ctx?.advancerId && ctx.selfId === ctx.advancerId);
      const exposed = num(s.crouch, 0) < SOLDIER_SHOT.fireCrouchMax;
      s.nextBurst = num(s.nextBurst, 0) - step;
      s.reaction = Math.max(0, num(s.reaction, 0) - step);
      if (s.burst <= 0 && s.nextBurst <= 0 && s.reaction <= 0 && exposed
        && (los || suppress) && Math.abs(angleDelta(s.yaw, wantYaw)) < SOLDIER_SHOT.fireYawTolerance) {
        // **并发闸门**：同一时刻最多 maxConcurrentBursts 名士兵在点射
        if (num(ctx?.bursting, 0) < SOLDIER_SHOT.maxConcurrentBursts) {
          s.burst = Math.floor(this._rand(SOLDIER_SHOT.burstMin, SOLDIER_SHOT.burstMax));
          s.shotT = 0;
        } else {
          s.nextBurst = this._rand(SOLDIER_SHOT.burstBusyGapMin, SOLDIER_SHOT.burstBusyGapMax);
        }
      }
      if (s.burst > 0) {
        s.shotT = num(s.shotT, 0) - step;
        if (s.shotT <= 0) {
          s.shotT = SOLDIER_SHOT.shotInterval;
          s.burst -= 1;
          const muzzle = soldierMuzzleWorld(s.position, s.yaw, s.crouch);
          const aimPoint = los && player
            ? [player.position[0], player.position[1] + PLAYER_CHEST_Y, player.position[2]]
            : (lastKnown || muzzle);
          s.shotRequest = {
            muzzle,
            target: aimPoint,
            accuracy: s.firstBurst ? SOLDIER_SHOT.accuracyFirst : SOLDIER_SHOT.accuracyRest,
            hasLos: los,
          };
          if (s.burst === 0) {
            s.nextBurst = los
              ? this._rand(SOLDIER_SHOT.burstGapLosMin, SOLDIER_SHOT.burstGapLosMax)
              : this._rand(SOLDIER_SHOT.burstGapBlindMin, SOLDIER_SHOT.burstGapBlindMax);
            s.firstBurst = false;
          }
        }
      }
    }

    // ---- 姿态量 ----
    const speedCur = Math.hypot(vx, vz);
    s.crouch = damp(num(s.crouch, 0), (s.crouching && !moving) ? 1 : 0, 9, step);
    s.walkPhase = num(s.walkPhase, 0) + speedCur * step * SOLDIER_GAIT.phasePerBlock;

    return createSoldierState(s);
  }

  /** 进入战斗（上游 enterCombat）：置 awareness/reaction/首轮标志 */
  _enterCombat(s) {
    if (s.mode === 'combat') return s;
    return {
      ...s,
      mode: 'combat',
      awareness: 1,
      reaction: this._rand(SOLDIER_SHOT.reactionMin, SOLDIER_SHOT.reactionMax),
      firstBurst: true,
      nextBurst: 0,
      alertDelay: -1,
    };
  }

  /** 玩家是否在视锥内（上游 sees 的 fovCos 段；贴身 2.5 格内不限视锥） */
  _inFov(s, playerPos, hDist, fovCos) {
    if (fovCos <= -1 || hDist <= 2.5) return true;
    const dx = playerPos[0] - s.position[0];
    const dz = playerPos[2] - s.position[2];
    const d = Math.hypot(dx, dz) || 1;
    // 前向 (sin yaw, cos yaw) 与玩家方向的余弦
    return (dx * Math.sin(s.yaw) + dz * Math.cos(s.yaw)) / d >= fovCos;
  }
}