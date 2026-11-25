// src/entities/soldiers/soldier-system.js — 士兵 definition + Service
//
// 同构层：**无 DOM、无 three、不新增 Worker**（`check:arch` 静态门守）。
// state 权威在 M5 `EntityManager`，本类不持有第二份实体集合（红线 1）——
// 它只管「玩法校验 + 生命 + slot 分配 + 班组情报 + 寻路编排」。
//
// ## 与丧尸 Service 的两处刻意差异
//
// 1. **死后留尸 1.2s**（上游倒地动画）⇒ `count()` **只数活着的**，
//    ⚠️ **不得用 `entities.count(SOLDIER_TYPE)`** —— 那含尸体，形态是
//    「打死一只后 1.2s 内按 C 没反应」而所有数值看着全对。
// 2. **班组共享情报**（`lastKnown` / `lastSeenAny` / `advancerId` / `bursting`）
//    存在 Service 上，不是每只士兵一份 —— 上游 `mgr.lastKnown` 同口径。
//    这不是第二份权威：它是「班组情报」这一件事实的唯一存放处，
//    个体 state 只存自己的 `lastSeen`。
import {
  SOLDIER, SOLDIER_TYPE, SOLDIER_AI, SOLDIER_STEERING, soldierEntityIdFor,
} from './soldier-config.js';
import { SoldierAgent, createSoldierState } from './soldier-agent.js';
import { normalizePosition, raycastAabbSlab } from '../entity-types.js';
import {
  aabbCollidesAt, resolveStepUpY, displaceGroundEntity, physicsStepAabb,
} from '../zombies/zombie-navigation.js';
import { PathCache } from '../zombies/zombie-pathfinder.js';
import { decideStep, memoryFor } from '../zombies/zombie-navigator.js';

/** 士兵 AABB（相对脚底；与丧尸同尺寸） */
export const SOLDIER_AABB = Object.freeze({
  min: Object.freeze([-SOLDIER.width / 2, 0, -SOLDIER.width / 2]),
  max: Object.freeze([SOLDIER.width / 2, SOLDIER.height, SOLDIER.width / 2]),
});

/** 传给共用物理的体型（宽/高与丧尸逐位相同；maxStep 有意取 2，见 soldier-config） */
const PHYS_BOX = Object.freeze({
  halfWidth: SOLDIER.width / 2,
  height: SOLDIER.height,
  maxStep: SOLDIER.maxStep,
  gravity: SOLDIER.gravity,
});

/** 模块级单例 Agent（无跨帧成员，多只士兵共用安全） */
const soldierAgent = new SoldierAgent();

/**
 * 士兵的 M5 definition。
 * `update` = Agent 决策 + 60Hz 物理（与丧尸同分层：物理在 definition 里，
 * 由 `EntityManager.update` 驱动；Service 只做编排，两处物理会让速度翻倍）。
 */
export const soldierDefinition = Object.freeze({
  create: createSoldierState,

  update(entity, dt, context) {
    const world = context?.world;
    if (!world) return entity.state;   // 无世界上下文（纯 fixture）：不推进
    const next = soldierAgent.update(entity.state, dt, { ...context, selfId: entity.id });
    if (!next) return entity.state;
    const state = createSoldierState(next);
    // 60Hz 固定步 accumulator（与丧尸同口径，n<5 防后台切回补跑上百步）
    state._physAccum = (entity.state._physAccum ?? 0) + (Number.isFinite(dt) ? dt : 0);
    const step = 1 / 60;
    let n = 0;
    while (state._physAccum >= step && n < 5) {
      // ⚠️ 留尸期间也跑物理（尸体要落地），但 Agent 已把水平速度清零
      physicsStepAabb(state, world, step, PHYS_BOX);
      state._physAccum -= step;
      n++;
    }
    return state;
  },

  /** ⚠️ 留尸期间返回 null —— 不可鞭尸（否则死后还扣血、还弹伤害数字） */
  raycastAabb: (state, origin, dir, maxDist) => (
    state?.dead ? null : raycastAabbSlab(state, origin, dir, maxDist, SOLDIER_AABB)
  ),

  /** 临时实体，不写 snapshot（红线 2） */
  serialize() { return null; },
  deserialize() { return null; },
});

/** 士兵玩法入口（形状对齐 `ZombieService` / `GuardianService`） */
export class SoldierService {
  /**
   * @param {{entities:object, world:object, maxAlive?:number, rng?:()=>number,
   *          onSpawn?:(id:string,slot:number)=>void, onDespawn?:(id:string)=>void,
   *          onKnockback?:(id:string,dx:number,dz:number)=>void}} deps
   */
  constructor({
    entities, world, maxAlive = SOLDIER.maxAlive, rng = Math.random,
    onSpawn = null, onDespawn = null, onKnockback = null,
  }) {
    this.entities = entities;
    this.world = world;
    this.maxAlive = maxAlive;
    this._rng = rng;
    this._onSpawn = onSpawn;
    this._onDespawn = onDespawn;
    this._onKnockback = onKnockback;
    /** @type {Map<string,number>} id → 渲染 slot（slot 单一权威在这里） */
    this._slots = new Map();
    /**
     * 空闲 slot（低位优先，与丧尸同口径）。
     *
     * ⚠️⚠️ **容量比 maxAlive 多一倍**（实测踩到，与丧尸不同）：
     * 丧尸死后立即 despawn，故「存活上限」与「slot 池」是等价两道门；
     * 士兵**留尸 1.2s**，尸体仍占着 slot（渲染要画倒地）⇒ 存活 9 只时
     * slot 可能已占满 10 个。若池只给 maxAlive，「打死一只立即补上」会抛
     * 「slot 池与存活数不同步」（本轮实测）。
     * 取 2×maxAlive：最坏情况是「10 只全死且都在留尸期 + 又召满 10 只」。
     * id 仍由 slot 派生（s0..s19），不影响「同时存活 10」的玩法上限。
     */
    this._freeSlots = [];
    for (let i = maxAlive * 2 - 1; i >= 0; i--) this._freeSlots.push(i);
    // ---- 班组共享情报（上游 mgr.*）----
    /** @type {number[]|null} 最后已知玩家位置 */
    this.lastKnown = null;
    /** @type {number} 任一士兵最后看见玩家的时刻（ms） */
    this.lastSeenAny = -1e9;
    /** @type {string|null} 推进者 id */
    this._advancerId = null;
    this._advancerT = 0;
    /** @type {number} 当前正在点射的士兵数 */
    this._bursting = 0;
    // ---- 寻路（与丧尸/焰魔/守卫共用同一套实现）----
    this._pathCache = new PathCache();
    this._navMemory = new Map();
    this._navAccum = 0;
    this._nowMs = 0;
    this._navDebug = { decisions: 0, blocked: 0 };
  }

  /**
   * 出生。四道门全过才创建（照 `ZombieService.spawn`）：
   * 上限 → column 已加载 → 脚格 air → 头格 air → 脚下 solid。
   * @param {number[]} position 脚底 @param {{source?:string|null}} [opts]
   * @returns {string|null}
   */
  spawn(position, { source = null } = {}) {
    if (this.count() >= this.maxAlive) return null;
    const pos = normalizePosition(position);
    if (!pos) return null;
    const [x, y, z] = pos;
    const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
    if (!this.world.hasColumn(Math.floor(x / 16), Math.floor(z / 16))) return null;
    if (this.world.getBlockId(bx, by, bz) !== 0) return null;
    if (this.world.getBlockId(bx, by + 1, bz) !== 0) return null;
    if (!this.world.isSolid(bx, by - 1, bz)) return null;

    const slot = this._freeSlots.pop();
    // 池容量 = 2×maxAlive（含留尸余量，见构造器注释）。走到这里池必非空；
    // 为空说明回收路径漏了归还（真 bug）—— 抛错而非静默 null。
    if (slot === undefined) throw new Error('SoldierService: slot 池耗尽（回收路径漏归还）');
    const id = soldierEntityIdFor(slot);
    const entity = this.entities.spawn({
      id, type: SOLDIER_TYPE,
      state: createSoldierState({ position: pos, health: SOLDIER.health, source, yaw: Math.PI }),
      persistent: false,
    });
    if (!entity) { this._freeSlots.push(slot); return null; }
    this._slots.set(id, slot);
    this._onSpawn?.(id, slot);
    return id;
  }

  /** @param {string} id @returns {object|null} 只读 state */
  get(id) {
    const e = this.entities.get(id);
    return e && e.type === SOLDIER_TYPE ? e.state : null;
  }

  /**
   * **存活**士兵数（上限判定的唯一口径）。
   * ⚠️⚠️ **不得改成 `entities.count(SOLDIER_TYPE)`** —— 那含留尸的尸体，
   * 形态是「打死一只后 1.2s 内按 C 没反应」而数值全对（spec Review Focus 1）。
   * @returns {number}
   */
  count() {
    let n = 0;
    for (const e of this.entities.entities()) {
      if (e.type === SOLDIER_TYPE && !e.state.dead) n++;
    }
    return n;
  }

  /**
   * 全部士兵实体（**含留尸** —— 渲染要画倒地动画）。
   * 返回数组快照：调用方可能在遍历中 damage → despawn 改变底层集合。
   * @returns {Array<object>}
   */
  activeEntities() {
    const out = [];
    for (const e of this.entities.entities()) if (e.type === SOLDIER_TYPE) out.push(e);
    return out;
  }

  /**
   * 造成伤害。致死时置 `dead` 并启动留尸计时，**不立即 despawn**（要播倒地）。
   * @returns {{dead:boolean, health:number}|null}
   */
  damage(id, amount, nowMs) {
    const e = this.entities.get(id);
    if (!e || e.type !== SOLDIER_TYPE) return null;
    if (e.state.dead) return { dead: true, health: e.state.health };   // 已死不重复扣
    const health = e.state.health - (Number.isFinite(amount) ? amount : 0);
    const flashedUntil = (Number.isFinite(nowMs) ? nowMs : 0) + SOLDIER.flashMs;
    if (health <= 0) {
      e.state = createSoldierState({ ...e.state, health, flashedUntil, dead: true, deadT: 0 });
      return { dead: true, health };
    }
    e.state = createSoldierState({ ...e.state, health, flashedUntil });
    return { dead: false, health };
  }

  /**
   * 击退：**位置位移**（不写 velocity —— 那是 AI 意图，每拍被覆写）。
   * 与丧尸/守卫同口径，共用 `displaceGroundEntity`（撞墙二分回退）。
   * @returns {boolean}
   */
  knockback(id, dx, dz) {
    const e = this.entities.get(id);
    if (!e || e.type !== SOLDIER_TYPE || e.state.dead) return false;
    const prev = e.state.position;
    const next = displaceGroundEntity(
      this.world, prev, dx, dz, SOLDIER.width / 2, SOLDIER.height,
    );
    if (next[0] === prev[0] && next[2] === prev[2]) return false;
    e.state = createSoldierState({ ...e.state, position: next });
    this.entities.reindexColumn(id);
    this._onKnockback?.(id, next[0] - prev[0], next[2] - prev[2]);
    return true;
  }

  /**
   * 班组报警（上游 `alertOthers`）：半径内非 combat 同伴按距离延迟入战。
   * @param {string} srcId @param {number} nowMs
   */
  alertNearby(srcId, nowMs) {
    const src = this.entities.get(srcId);
    if (!src) return;
    const [sx, , sz] = src.state.position;
    for (const e of this.activeEntities()) {
      if (e.id === srcId || e.state.dead || e.state.mode === 'combat') continue;
      const d = Math.hypot(e.state.position[0] - sx, e.state.position[2] - sz);
      if (d > SOLDIER_AI.alertRadius) continue;
      if (e.state.alertDelay >= 0) continue;   // 已安排过，不重复推后
      const delay = SOLDIER_AI.alertDelayMin
        + this._rng() * (SOLDIER_AI.alertDelayMax - SOLDIER_AI.alertDelayMin)
        + d * SOLDIER_AI.alertDelayPerBlock;
      e.state = createSoldierState({ ...e.state, alertDelay: delay });
    }
    void nowMs;
  }

  /**
   * 听到枪声（上游 `hearShot`）：半径内非 combat 士兵转 search 并走向声源。
   * @param {number[]} pos 声源（玩家开火位置）@param {number} nowMs
   */
  hearShot(pos, nowMs) {
    if (!Array.isArray(pos)) return;
    this.lastKnown = [pos[0], pos[1], pos[2]];
    for (const e of this.activeEntities()) {
      if (e.state.dead || e.state.mode === 'combat') continue;
      const d = Math.hypot(e.state.position[0] - pos[0], e.state.position[2] - pos[2]);
      if (d > SOLDIER_AI.hearRadius) continue;
      e.state = createSoldierState({
        ...e.state,
        mode: 'search',
        searchT: SOLDIER_AI.hearSearchSeconds,
        awareness: Math.max(e.state.awareness, SOLDIER_AI.hearAwarenessFloor),
        patrolTarget: [pos[0], e.state.position[1], pos[2]],
      });
    }
    void nowMs;
  }

  /**
   * 每帧编排（**必须在 `entities.update` 之前调**，与丧尸/焰魔/守卫同帧序）：
   * ① 回收留尸到期的尸体；② 20Hz 寻路拍；③ 每 2s 选 advancer；④ 统计并发点射；
   * ⑤ 刷新班组情报（任一士兵看见玩家 ⇒ lastKnown/lastSeenAny）。
   *
   * ⚠️ 本方法**不跑物理**（物理在 definition.update，两处推进会速度翻倍）。
   * @param {number} dt @param {{playerPosition:number[], nowMs:number}} ctx
   */
  update(dt, { playerPosition, nowMs } = {}) {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    this._nowMs = Number.isFinite(nowMs) ? nowMs : this._nowMs + step * 1000;
    const list = this.activeEntities();

    // ① 留尸到期回收
    // ⚠️⚠️ **deadT 在本方法里推进，不依赖 definition.update**（实测）：
    // definition.update 由 `entities.update` 驱动，而本方法由装配层先行调。
    // 只靠 definition 推 deadT 时，任何只调 Service.update 的路径（单测/未来的
    // 暂停帧）尸体永不回收 ⇒ slot 永不归还 ⇒ 容量被死尸占满（本轮实测踩到）。
    // 两处都推会双倍计时，故**只在这里推**，Agent 的 dead 分支不再累加。
    for (const e of list) {
      if (!e.state.dead) continue;
      const deadT = e.state.deadT + step;
      if (deadT >= SOLDIER.deadLingerSeconds) {
        this.entities.despawn(e.id, 'dead-linger-expired');
        this._releaseSlot(e.id);
      } else {
        e.state = createSoldierState({ ...e.state, deadT });
      }
    }

    const alive = list.filter((e) => !e.state.dead);
    // ④ 并发点射统计（Agent 的闸门读它）
    this._bursting = alive.reduce((n, e) => n + (e.state.burst > 0 ? 1 : 0), 0);

    // ⑤ 班组情报：任一士兵本帧看得见玩家 ⇒ 刷新（上游 mgr.lastKnown 同口径）
    if (Array.isArray(playerPosition)) {
      for (const e of alive) {
        if (e.state.losVisible && e.state.mode === 'combat') {
          this.lastKnown = [playerPosition[0], playerPosition[1], playerPosition[2]];
          this.lastSeenAny = this._nowMs;
          break;
        }
      }
    }

    // ③ advancer：离最后已知位置最近的 combat 士兵（上游每 2s 重选）
    this._advancerT -= step;
    if (this._advancerT <= 0) {
      this._advancerT = SOLDIER_AI.advancerPeriod;
      let best = null, bestD = Infinity;
      const goal = this.lastKnown || playerPosition;
      if (goal) {
        for (const e of alive) {
          if (e.state.mode !== 'combat') continue;
          const d = Math.hypot(e.state.position[0] - goal[0], e.state.position[2] - goal[2]);
          if (d < bestD) { bestD = d; best = e.id; }
        }
      }
      this._advancerId = best;
    }

    // ② 寻路拍（20Hz，只给 needsPath 的真跑 A*）
    this._navAccum += step;
    if (this._navAccum >= SOLDIER_AI.aiPeriod) {
      this._navAccum = 0;
      this._stepNavigator(playerPosition);
    }
  }

  /** 寻路一步（与焰魔/守卫同结构，共用 PathCache + decideStep） */
  _stepNavigator(playerPosition) {
    const world = this.world;
    if (!world || typeof world.isSolid !== 'function') return;
    if (!Array.isArray(playerPosition)) return;
    const isWalkable = (w, bx, y, bz) => {
      if (!aabbCollidesAt(w, bx + 0.5, y, bz + 0.5, SOLDIER.width / 2, SOLDIER.height)) return true;
      return resolveStepUpY(
        w, bx + 0.5, y, bz + 0.5, SOLDIER.width / 2, SOLDIER.height, SOLDIER.maxStep,
      ) !== null;
    };
    const active = this.activeEntities().filter((e) => !e.state.dead);
    // 清理已消失士兵的寻路残留（column 卸载绕过本服务）
    if (this._navMemory.size > active.length) {
      const live = new Set(active.map((e) => e.id));
      for (const id of [...this._navMemory.keys()]) if (!live.has(id)) this._forgetNavigation(id);
    }
    for (const e of active) {
      if (e.state.needsPath !== true) continue;
      const mem = memoryFor(this._navMemory, e.id);
      const step = decideStep({
        world, position: e.state.position, playerPosition, memory: mem,
        pathCache: this._pathCache, nowMs: this._nowMs, isWalkable,
        box: { halfWidth: SOLDIER.width / 2, height: SOLDIER.height, maxStep: SOLDIER.maxStep },
        steering: SOLDIER_STEERING,
      });
      this._navDebug.decisions++;
      if (step.blocked) this._navDebug.blocked++;
      e.state = createSoldierState({
        ...e.state,
        navDir: step.blocked ? null : [step.vx, step.vz],
        navMode: step.mode,
      });
    }
  }

  /** 喂给 Agent 的班组上下文（装配层把它并进 entities.update 的 ctx） */
  agentContext() {
    return {
      bursting: this._bursting,
      lastKnown: this.lastKnown,
      lastSeenAny: this.lastSeenAny,
      advancerId: this._advancerId,
      nowMs: this._nowMs,
    };
  }

  /** @param {string} id @returns {number|null} 只读 slot */
  slotOf(id) {
    const s = this._slots.get(id);
    return s === undefined ? null : s;
  }

  /** 只读诊断 */
  debugState() {
    const list = this.activeEntities();
    return {
      alive: list.filter((e) => !e.state.dead).length,
      dead: list.filter((e) => e.state.dead).length,
      bursting: this._bursting,
      advancerId: this._advancerId,
      nav: { ...this._navDebug },
    };
  }

  /**
   * column 卸载前回收（先快照 id 再回收 —— despawnColumn 只返回计数，
   * 而 slot 归还需要 id）。
   * @param {string} columnKey @returns {number}
   */
  despawnColumn(columnKey) {
    const ids = [];
    for (const e of this.entities.entitiesInColumn(columnKey)) {
      if (e.type === SOLDIER_TYPE) ids.push(e.id);
    }
    const all = this.entities.despawnColumn(columnKey, 'column-unloaded');
    for (const id of ids) this._releaseSlot(id);
    void all;
    return ids.length;
  }

  /** 反向释放（Game.dispose 调） */
  dispose() {
    for (const e of this.activeEntities()) {
      this.entities.despawn(e.id, 'dispose');
      this._releaseSlot(e.id);
    }
    this._slots.clear();
    this._pathCache.clear();
    this._navMemory.clear();
  }

  _forgetNavigation(id) {
    this._pathCache.forget(id);
    this._navMemory.delete(id);
  }

  /** 归还 slot（三条回收路径共用；漏任一条都会渲染留残影、容量被占满） */
  _releaseSlot(id) {
    const slot = this._slots.get(id);
    if (slot === undefined) return;
    this._slots.delete(id);
    this._freeSlots.push(slot);
    this._forgetNavigation(id);
    this._onDespawn?.(id);
  }
}