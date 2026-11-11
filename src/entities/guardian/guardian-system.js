// src/entities/guardian/guardian-system.js — 末影守卫：definition + service
//
// 本文件属 Worker 同构层（红线 8）：不碰 DOM、不 import three、不自建 Worker。
// 渲染层只读本文件产出的 pose，不回写 state、不参与命中
// （命中唯一真相 = `guardianDefinition.raycastAabb`，红线 6）。
//
// ⚠️ **守卫是「临时实体」**（`persistent: false`，与焰魔/飞龙同口径）：位置不是纯函数，
// 但它是 Boss、随 column 卸载回收可接受，且「进存档 = 第二份权威」（红线 2）。
//
// ## 与焰魔 system 的四处差异
//
// 1. `attackKind` 取值域是**四档**；新增 `attackCooldowns`（逐招冷却映射，跨帧保留）。
//    不引入 `spinCooldown` / `leapAttackCooldown` / `leapTargetY`（守卫无跳劈）。
// 2. `_findGroundY` 的 **`HEADROOM = Math.ceil(height) = 4`（不 +1）** ——
//    上层房间净空只有 5 格，取 5 会把落点判死而静默召到中层（差 8 格）。
// 3. `overlapsAabb` 的 id Set 短路（玩家物理每帧调几十次）。
// 4. `guardianAabbFor` 用 `GUARDIAN_CORE_OBB`，center 与半长**一起**绕 yaw 旋转。
import { raycastAabbSlab, normalizePosition } from '../entity-types.js';
import {
  GUARDIAN_TYPE, GUARDIAN, GUARDIAN_AI, GUARDIAN_ATTACK_IDS, GUARDIAN_CORE_OBB,
  GUARDIAN_STEERING, guardianEntityIdFor,
} from './guardian-config.js';
import { GuardianBossAgent } from '../bosses/guardian-boss-agent.js';
// 寻路第①②层 —— **与丧尸/焰魔同一份实现**（红线 1）。第③层在 Agent 里，不重复引用。
import { PathCache } from '../zombies/zombie-pathfinder.js';
import { decideStep, memoryFor } from '../zombies/zombie-navigator.js';
import { aabbCollidesAt, zombieStepUpY, displaceGroundEntity } from '../zombies/zombie-navigation.js';

// ==================== 纯函数 ====================

/**
 * 核心 OBB 绕 `state.yaw` 旋转后的**轴对齐**包围盒。
 *
 * ⚠️ **返回「相对 `state.position` 的局部盒」**，不是世界盒 —— `raycastAabbSlab` 内部会做
 * `lo = aabb.min[axis] + position[axis]`。返回世界盒会让 position 被**加两次**
 * （形态：水平射线永远打不中，而「盒尺寸」类断言全绿）。
 *
 * ⚠️ **盒是相对脚底的**：`center[1] = 2.7181`、`halfExtents[1] = 1.2188`
 * ⇒ `min[1] ≈ 1.4993`（**不是 0**）—— 守卫的躯干含头盔，从脚底往上 1.5 格才开始。
 * 照抄焰魔的「min[1] ≈ 0」会写错断言。
 *
 * ⚠️ **center 与半长一起转**：`center[2] = −0.4062` 非零 ⇒ 盒前后不对称，
 * 只转半长会让斜角命中判定偏移。
 *
 * @param {{position: [number,number,number], yaw: number}} state
 * @returns {{min: number[], max: number[]}} 局部盒
 */
export function guardianAabbFor(state) {
  const h = GUARDIAN_CORE_OBB.halfExtents;
  const c = GUARDIAN_CORE_OBB.center;
  const cos = Math.cos(state.yaw), sin = Math.sin(state.yaw);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let sx = -1; sx <= 1; sx += 2) {
    for (let sy = -1; sy <= 1; sy += 2) {
      for (let sz = -1; sz <= 1; sz += 2) {
        const lx = c[0] + sx * h[0];
        const ly = c[1] + sy * h[1];
        const lz = c[2] + sz * h[2];
        const rx = lx * cos + lz * sin;
        const rz = -lx * sin + lz * cos;
        if (rx < min[0]) min[0] = rx;
        if (ly < min[1]) min[1] = ly;
        if (rz < min[2]) min[2] = rz;
        if (rx > max[0]) max[0] = rx;
        if (ly > max[1]) max[1] = ly;
        if (rz > max[2]) max[2] = rz;
      }
    }
  }
  return { min, max };
}

// ==================== state 构造 ====================

/** 合法 mode（其余回落 idle）。`leap` 只服务脱困 */
const MODES = Object.freeze(['idle', 'chase', 'attack', 'leap']);

/**
 * 构造全新 state（**不原地改写** —— M5 不变式：`EntityManager.update` 的跨 column 索引
 * 迁移判据是「赋值前 position vs 赋值后 position」，原地改写会让索引永不迁移
 * → column 卸载漏回收实体）。
 *
 * @returns {object|null} position 非法时返回 null
 */
function createState({
  position, velocity, yaw, health, flashedUntil, mode,
  attackAnimT, attackKind, attackCooldowns,
  idleTime, attackCooldown, losTimer, losVisible, onGround, attackRequest,
  navDir, navMode, needsPath,
  acquireT, stuckT, stuckAnchor, sensedPlayer, senseTimer, escapeFailCount,
  leapKind, leapDir, leapT,
  _physAccum,
}) {
  const p = normalizePosition(position);
  if (!p) return null;
  const v = Array.isArray(velocity) && velocity.length === 3
    && velocity.every((n) => Number.isFinite(n))
    ? [velocity[0], velocity[1], velocity[2]]
    : [0, 0, 0];
  // ⚠️⚠️ **逐招冷却映射必须跨帧保留**（同 `_physAccum` / `senseTimer` 的教训）：
  // 丢掉它 ⇒ 每帧重置为 0 ⇒ 每招独立冷却永不生效，而权重与常量看上去都对。
  const cds = {};
  for (const id of GUARDIAN_ATTACK_IDS) {
    const raw = attackCooldowns && Number.isFinite(attackCooldowns[id]) ? attackCooldowns[id] : 0;
    cds[id] = Math.max(0, raw);
  }
  return {
    position: p,
    velocity: v,
    yaw: Number.isFinite(yaw) ? yaw : 0,
    health: Number.isFinite(health) ? health : GUARDIAN.health,
    flashedUntil: Number.isFinite(flashedUntil) ? flashedUntil : 0,
    mode: MODES.includes(mode) ? mode : 'idle',
    /** 攻击动画已播放秒数。0 = 不在攻击中 */
    attackAnimT: Number.isFinite(attackAnimT) ? attackAnimT : 0,
    /**
     * 本刀是哪一招（四档之一），非攻击态为 null。
     * 三个消费者：渲染器选动画 / 命中推进取档案 / `attackRequest.kind`。
     * ⚠️ **缺省必须是显式 `null`而不是 `undefined`**：消费方判 `!== null`，
     * `undefined` 会溜过那道守卫（实测：字段缺失时三元运算直接透传 undefined）。
     * ⚠️ 有值但非法则回落第一档。
     */
    attackKind: attackKind == null
      ? null
      : (GUARDIAN_ATTACK_IDS.includes(attackKind) ? attackKind : GUARDIAN_ATTACK_IDS[0]),
    /** 逐招独立冷却剩余秒数（见上方 ⚠️） */
    attackCooldowns: cds,
    /** 待机动画相位（秒）—— 跨帧累积，否则待机永远停在第 0 帧 */
    idleTime: Number.isFinite(idleTime) ? idleTime : 0,
    /** 全局攻击冷却剩余秒数 */
    attackCooldown: Number.isFinite(attackCooldown) ? attackCooldown : 0,
    losTimer: Number.isFinite(losTimer) ? losTimer : 0,
    losVisible: losVisible === true,
    onGround: onGround === true,
    /**
     * 物理固定步长累积器（瞬态，不入 snapshot 但**必须留在 state 里跨帧传递**）。
     * ⚠️ 丢掉它 ⇒ 每帧重置 ⇒ 多数帧不跑物理步 ⇒ `onGround` 恒 false（焰魔实测踩过）。
     */
    _physAccum: Number.isFinite(_physAccum) ? _physAccum : 0,
    /**
     * ⚠️ **瞬态**：本帧要结算一次命中，由 game.js 在 `entities.update` 之后消费。
     * 形状 `{at:[x,y,z], yaw, kind}` —— `at` 是**守卫脚底**，`kind` 让结算方按招取射程/锥角。
     */
    attackRequest: attackRequest || null,
    /** 寻路给出的单位方向 `[vx,vz]` 或 null（由 Service 写，Agent 消费） */
    navDir: Array.isArray(navDir) && navDir.length === 2 && navDir.every((n) => Number.isFinite(n))
      ? [navDir[0], navDir[1]]
      : null,
    navMode: navMode === 'chasing' || navMode === 'blocked' ? navMode : null,
    needsPath: needsPath === true,
    /** idle→chase 的重新锁定累计秒数（跨帧累积） */
    acquireT: Number.isFinite(acquireT) ? acquireT : 0,
    /** 卡住累计秒数（棘轮式锚点判据，跨帧累积） */
    stuckT: Number.isFinite(stuckT) ? stuckT : 0,
    /** 「上次确认有进展」的位置锚点（跨帧累积；丢掉它 ⇒ stuckT 永不累计 ⇒ 脱困永不触发） */
    stuckAnchor: Array.isArray(stuckAnchor) && stuckAnchor.length === 2
      && stuckAnchor.every((n) => Number.isFinite(n))
      ? [stuckAnchor[0], stuckAnchor[1]]
      : null,
    /** 玩家位置感知快照（chase 的移动与转向读它） */
    sensedPlayer: Array.isArray(sensedPlayer) && sensedPlayer.length === 3
      && sensedPlayer.every((n) => Number.isFinite(n))
      ? [sensedPlayer[0], sensedPlayer[1], sensedPlayer[2]]
      : null,
    senseTimer: Number.isFinite(senseTimer) ? senseTimer : 0,
    /** 连续失败的普通脱困跳次数（跨帧累积；满 escalateAfter 后升级强化跳） */
    escapeFailCount: Number.isFinite(escapeFailCount) ? escapeFailCount : 0,
    /** 飞跃类别：守卫恒 `'escape'`（不做跳劈），非法值回落 null */
    leapKind: leapKind === 'escape' ? 'escape' : null,
    /** 飞跃期水平速度（含长度，起跳时算定） */
    leapDir: Array.isArray(leapDir) && leapDir.length === 2 && leapDir.every((n) => Number.isFinite(n))
      ? [leapDir[0], leapDir[1]]
      : null,
    leapT: Number.isFinite(leapT) ? leapT : 0,
  };
}

// ==================== definition ====================

/** 模块级单例 Agent（无跨帧成员，多条守卫共用安全） */
const guardianAgent = new GuardianBossAgent();

/** 守卫的 M5 definition。`update` 委托 Agent（每个 Boss 一个智能体类） */
export const guardianDefinition = Object.freeze({
  create(state) {
    if (!state) return null;
    return createState(state);
  },

  update(entity, dt, context) {
    const next = guardianAgent.update(entity.state, dt, context || {});
    if (!next) return null;
    return createState(next);
  },

  raycastAabb: (state, origin, dir, maxDist) =>
    raycastAabbSlab(state, origin, dir, maxDist, guardianAabbFor(state)),

  /**
   * 临时实体不走存档，最小 snapshot。
   * ⚠️ `attackRequest` 刻意不进 snapshot（瞬态）：写进去的形态是「陈旧请求复活」。
   */
  serialize(state) {
    if (!state) return null;
    const p = normalizePosition(state.position);
    if (!p) return null;
    return { position: p, yaw: state.yaw, health: state.health };
  },

  deserialize(raw) {
    if (!raw) return null;
    const p = normalizePosition(raw.position);
    if (!p) return null;
    return createState({
      position: p,
      yaw: Number.isFinite(raw.yaw) ? raw.yaw : 0,
      health: Number.isFinite(raw.health) ? raw.health : GUARDIAN.health,
    });
  },
});

// ==================== service ====================

/** 守卫的玩法入口（形状对齐 `IgnisService` / `DragonService`） */
export class GuardianService {
  /**
   * @param {{entities: import('../entity-manager.js').EntityManager,
   *          world: object|null, seed: number,
   *          onKnockback?: (id: string, dx: number, dz: number) => void}} deps
   *        `onKnockback` 是渲染层缓动的钩子（装配时注入，不 import render —— 依赖方向）。
   */
  constructor({ entities, world, seed, onKnockback = null }) {
    this.entities = entities;
    this.world = world;
    this.seed = seed;
    this._onKnockback = onKnockback;
    this._pathCache = new PathCache();
    /** @type {Map<string, object>} id → 导航记忆 */
    this._navMemory = new Map();
    /**
     * 曾经召唤过的守卫 id 集合 —— 只为 `overlapsAabb` 的**热路径短路**。
     *
     * ⚠️ 不能直接遍历 `entities.entities()`：`overlapsAabb` 被玩家物理每帧调几十次
     * （含二分回退），遍历全部实体 + 分配数组是热路径上的无谓开销。
     * ⚠️ 不需要在 column 卸载时清理：id 确定性派生 ⇒ 走远回来复用同 id ⇒ Set 不累积；
     * 已 despawn 的 id 留在 Set 里无害（`get` 返回 null ⇒ 跳过）。
     * @type {Set<string>}
     */
    this._guardianIds = new Set();
    this._navAccum = 0;
    this._navDebug = { decisions: 0, blocked: 0 };
  }

  /**
   * 寻路一拍：给「Agent 报告需要绕行」的守卫跑 A* + decideStep，把方向写进 state。
   *
   * ⚠️ 走服务层而不是 Agent：A* 需要 `PathCache` 与节流（**跨帧状态**），
   * 而 Agent 的契约是「只读 state + ctx，返回全新 state」，不得持有跨帧成员。
   * ⚠️ 规划完**不清 needsPath**：标志由 Agent 下一帧重算（它才是有权判「走不通」的一方）。
   */
  _stepNavigator(playerPosition, nowMs) {
    const world = this.world;
    if (!world || typeof world.isSolid !== 'function') return;
    // 可走性判据**复用 aabbCollidesAt**（与物理同源）；一格台阶算可走
    const isWalkable = (w, bx, y, bz) => {
      if (!aabbCollidesAt(w, bx + 0.5, y, bz + 0.5, GUARDIAN.halfWidth, GUARDIAN.height)) return true;
      const lifted = zombieStepUpY(y);
      return lifted - y <= GUARDIAN_AI.maxStep
        && !aabbCollidesAt(w, bx + 0.5, lifted, bz + 0.5, GUARDIAN.halfWidth, GUARDIAN.height);
    };
    const box = {
      halfWidth: GUARDIAN.halfWidth,
      height: GUARDIAN.height,
      maxStep: GUARDIAN_AI.maxStep,
    };
    const now = Number.isFinite(nowMs)
      ? nowMs
      : (typeof performance !== 'undefined' ? performance.now() : 0);

    const active = this.activeEntities();
    if (this._navMemory.size > active.length) {
      const live = new Set(active.map((e) => e.id));
      for (const id of [...this._navMemory.keys()]) {
        if (!live.has(id)) this._forgetNavigation(id);
      }
    }

    for (const entity of active) {
      if (entity.state.needsPath !== true) continue;
      const mem = memoryFor(this._navMemory, entity.id);
      const step = decideStep({
        world,
        position: entity.state.position,
        playerPosition,
        memory: mem,
        pathCache: this._pathCache,
        nowMs: now,
        isWalkable,
        box,
        steering: GUARDIAN_STEERING,
      });
      this._navDebug.decisions++;
      if (step.blocked) this._navDebug.blocked++;
      entity.state = createState({
        ...entity.state,
        navDir: step.blocked ? null : [step.vx, step.vz],
        navMode: step.mode,
      });
    }
  }

  /**
   * 每帧推进寻路（**必须在 `entities.update` 之前调**）。
   * ⚠️ 反序会让守卫用上帧的寻路方向走一步（长墙拐角明显抖动）。
   */
  update(dt, { playerPosition, nowMs } = {}) {
    if (!Array.isArray(playerPosition) || playerPosition.length < 3) return;
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    this._navAccum += step;
    if (this._navAccum < GUARDIAN_AI.navPeriod) return;
    this._navAccum = 0;
    this._stepNavigator(playerPosition, nowMs);
  }

  navDebugState() {
    return { ...this._navDebug, cache: this._pathCache.debugState() };
  }

  /** @returns {ReadonlyArray<{x:number,z:number}>|null} 只读测试钩子 */
  cachedPathOf(id) { return this._pathCache.cachedPathOf(id); }

  /**
   * 在指定位置召唤守卫。
   *
   * @param {string} mapKey 地图实例标识（`bossMapAt().key`）
   * @param {number} cx @param {number} cz 落点列坐标（整数）
   * @param {number} slot 名册槽位（守卫 = 0）
   * @param {number} [refY] 参考高度 —— 装配层传 `summonY`（= `floorY − 6`，上层房间）。
   *        ⚠️ **必须传**：不传会取「最低可站位置」= 最深房间（玩家走不下去，spec §2.3.1）。
   * @returns {{ok: true, id: string} | {ok: false, reason: 'limit'|'exists'}}
   */
  summon(mapKey, cx, cz, slot, refY) {
    if (this.entities.count(GUARDIAN_TYPE) >= GUARDIAN.maxAlive) {
      return { ok: false, reason: 'limit' };
    }
    const id = guardianEntityIdFor(mapKey, slot);
    if (this.entities.get(id)) return { ok: false, reason: 'exists' };

    const y = this._findGroundY(cx, cz, refY);
    const entity = this.entities.spawn({
      id,
      type: GUARDIAN_TYPE,
      state: createState({
        position: [cx + 0.5, y, cz + 0.5],
        yaw: 0,
        health: GUARDIAN.health,
      }),
      persistent: false,
    });
    if (!entity) return { ok: false, reason: 'exists' };
    this._guardianIds.add(id);
    return { ok: true, id };
  }

  /**
   * 找 `(cx, cz)` 列上可站立的脚底 y，取离 `nearY` 最近的候选。
   *
   * ⚠️⚠️ **`HEADROOM = Math.ceil(GUARDIAN.height) = 4`，不是 `+1 = 5`**（实测标定）：
   * 废弃堡垒上层房间净空只有 **5 格**（ny39..43，天花板 ny44）。同一列的候选实测：
   *
   * | HEADROOM | 候选 ny | refY = floorY−6 选中 |
   * |---|---|---|
   * | 3 / **4** | 23 / 31 / **39** | **39 ✓** |
   * | 5 | 23 / 31（**39 被判死**）| **31 ✗ 召到中层，差 8 格** |
   *
   * 守卫高 3.8 ⇒ 占 ny39..42 四层，ny43 是余量。取 5 的形态是**静默召错层**
   *（所有计数与状态全对，只有位置错）。
   *
   * ⚠️ 不能从世界顶往下取第一个：地牢有三层可站面，必须按 `nearY` 选。
   *
   * @returns {number} 保证有限（找不到时 0）
   */
  _findGroundY(cx, cz, nearY) {
    const w = this.world;
    if (!w || typeof w.isSolid !== 'function') return 0;
    const HEADROOM = Math.ceil(GUARDIAN.height);
    const TOP = 96;
    const BOTTOM = -32;
    const candidates = [];
    for (let y = TOP; y > BOTTOM; y--) {
      if (w.isSolid(cx, y, cz)) continue;
      if (!w.isSolid(cx, y - 1, cz)) continue;
      let clear = true;
      for (let dy = 1; dy <= HEADROOM; dy++) {
        if (w.isSolid(cx, y + dy, cz)) { clear = false; break; }
      }
      if (clear) candidates.push(y);
    }
    if (candidates.length === 0) return 0;
    if (Number.isFinite(nearY)) {
      let best = candidates[0];
      let bestD = Math.abs(best - nearY);
      for (const y of candidates) {
        const d = Math.abs(y - nearY);
        if (d < bestD) { best = y; bestD = d; }
      }
      return best;
    }
    return candidates[candidates.length - 1];
  }

  /**
   * 给定一个**世界 AABB**，是否与任一存活守卫的身体盒相交。
   *
   * 由装配层注入 `PlayerPhysics`（`player/` 不得 import `entities/`）。
   * ⚠️ **严格不等式**（贴面不算重叠）：用 `>=` 会让「恰好贴着站」被推离，观感是「碰不到它」。
   * ⚠️ **用身体盒而不是碰撞盒**：后者是 2.5×3.8 的粗盒，会让玩家停在离模型还有一截的地方。
   * ⚠️ **热路径短路**：只遍历 `_guardianIds` + O(1) 的 `get`，不遍历全部实体、不分配数组。
   *
   * @param {{minX:number,maxX:number,minY:number,maxY:number,minZ:number,maxZ:number}} box
   */
  overlapsAabb(box) {
    if (!box || this._guardianIds.size === 0) return false;
    for (const id of this._guardianIds) {
      const entity = this.entities.get(id);
      if (!entity) continue;
      const local = guardianAabbFor(entity.state);
      const p = entity.state.position;
      const minX = p[0] + local.min[0], maxX = p[0] + local.max[0];
      const minY = p[1] + local.min[1], maxY = p[1] + local.max[1];
      const minZ = p[2] + local.min[2], maxZ = p[2] + local.max[2];
      if (box.minX < maxX && box.maxX > minX
        && box.minY < maxY && box.maxY > minY
        && box.minZ < maxZ && box.maxZ > minZ) return true;
    }
    return false;
  }

  /**
   * 造成伤害（红闪 + health ≤ 0 即 despawn）。
   *
   * ⚠️ **时间基准必须是 `performance.now()`**：`Date.now()` 相差约 17 亿毫秒
   * ⇒ `nowMs < flashedUntil` 恒真 ⇒ 永久红闪。
   *
   * @returns {{dead: boolean, health: number}|null} 未知 id / 非守卫返回 null
   */
  damage(id, amount, nowMs) {
    const entity = this.entities.get(id);
    if (!entity || entity.type !== GUARDIAN_TYPE) return null;
    const state = entity.state;
    const health = state.health - (Number.isFinite(amount) ? amount : 0);
    const flashedUntil = (Number.isFinite(nowMs) ? nowMs : 0) + GUARDIAN.flashMs;
    entity.state = createState({ ...state, health, flashedUntil });
    if (health <= 0) {
      this.entities.despawn(id, 'killed');
      this._forgetNavigation(id);
      return { dead: true, health };
    }
    return { dead: false, health };
  }

  /**
   * 击退：沿给定水平位移推开一小步（受击反馈，**不是**走位退让）。
   *
   * ⚠️ **权威位移瞬时**：AABB / 实体射线 / 方块碰撞 / AI 起点全读 `state.position`，
   * 一滞后就会「按旧位置判命中」。观感滞后由渲染层补间承担 ⇒ 成功时经 `onKnockback`
   * 上报**实际**位移（撞墙二分回退后可能只走了一部分）。
   * ⚠️ 位移量必须小于 `standoffDeadband`，否则「砍一刀」变成「把它打跑」。
   *
   * @returns {boolean} false = 未知 id / 完全走不动
   */
  knockback(id, dx, dz) {
    const entity = this.entities.get(id);
    if (!entity || entity.type !== GUARDIAN_TYPE) return false;
    const state = entity.state;
    const next = displaceGroundEntity(
      this.world, state.position, dx, dz, GUARDIAN.halfWidth, GUARDIAN.height,
    );
    if (next[0] === state.position[0] && next[2] === state.position[2]) return false;
    entity.state = createState({ ...state, position: next });
    this.entities.reindexColumn(id);
    if (this._onKnockback) {
      this._onKnockback(id, next[0] - state.position[0], next[2] - state.position[2]);
    }
    return true;
  }

  /**
   * 回收某只守卫的寻路残留。
   * ⚠️ **两条回收路径都要调**（damage 死亡分支与 dispose）：漏一条会让缓存与记忆
   * 随「死了又召」单调增长，且旧条目以同一 id 继续命中（带着上一条命的状态）。
   */
  _forgetNavigation(id) {
    this._pathCache.forget(id);
    this._navMemory.delete(id);
  }

  /**
   * 全部存活守卫（**数组快照**：调用方可能在遍历中 damage → despawn 改变底层集合）。
   */
  activeEntities() {
    const out = [];
    for (const entity of this.entities.entities()) {
      if (entity.type === GUARDIAN_TYPE) out.push(entity);
    }
    return out;
  }

  dispose() {
    for (const entity of this.activeEntities()) {
      this.entities.despawn(entity.id, 'dispose');
      this._forgetNavigation(entity.id);
    }
    this._pathCache.clear();
    this._navMemory.clear();
    this._guardianIds.clear();
  }
}