// src/entities/zombies/zombie-system.js — M6：丧尸玩法入口（M6 规格 §2）
//
// 同构层：**无 DOM、无 three、不新增 Worker**（`npm run check:arch` 静态门守）。
// `ZombieService` 是 M6 唯一的玩法入口；state 权威在 M5 的 `EntityManager`，本类不持有
// 第二份实体集合（红线 1）—— 它只负责「玩法校验 + 生命 + slot 分配 + AI 编排」。
//
// 两处与 M6 规格措辞的有意取舍（均在验收报告记录）：
// ① **generation 不入 state**：规格 §2 写「ZombieState 至少包含 {…, generation, …}」，但
//    generation 的唯一权威是 M5 Entity wrapper（`EntityManager` 不变式 ②：单调递增、despawn
//    后不重置）。复制进 state 会开第二份版本协议真相 → 两者漂移时无法判断哪份对，且 AI 回包
//    校验会读到过期代数。故 state 不含 generation，AI 回包一律经 manager 校验。
// ② **AI 意图写进 state.velocity，不另设 intent 容器**：mc-lite 也用同一个 velocity 字段
//    驱动步态与移动。另设 intent 会让「渲染看到的移动」与「物理实际的移动」分家。
import {
  ZOMBIE, ZOMBIE_FLASH_MS, ZOMBIE_MAX_STEP, ZOMBIE_MOVING_EPSILON, ZOMBIE_SEPARATION,
} from './zombie-config.js';
import { zombieCollidesAt, zombieStepUpY, steerIntent, displaceGroundEntity } from './zombie-navigation.js';
import { PathCache } from './zombie-pathfinder.js';
import { decideStep, memoryFor } from './zombie-navigator.js';
import { normalizePosition, raycastAabbSlab } from '../entity-types.js';

/** 丧尸 AABB（相对 state.position 的局部偏移；position 为脚底 → min.y = 0） */
export const ZOMBIE_AABB = Object.freeze({
  min: Object.freeze([-ZOMBIE.width / 2, 0, -ZOMBIE.width / 2]),
  max: Object.freeze([ZOMBIE.width / 2, ZOMBIE.height, ZOMBIE.width / 2]),
});

/**
 * 单只丧尸的实体间排斥力（mc-lite `EnemyWorker.js:131-155` `calculateSeparationForce` 逐行复刻）。
 *
 * **为什么需要**：所有丧尸朝同一玩家追逐会收敛到同一点，没有排斥就叠成一坨（用户实玩报告）。
 *
 * **为什么在 AI 层算、叠加进 velocity，而不是在 manager 层推挤位置**：mc-lite 就是这么做的
 * （`:218-220` `velocity = aiVelocity + separationForce`）。推挤位置会新增一条**绕过物理层**
 * 的位置改写路径（须额外 collides 兜底防推进方块，且要在 ZombieService 重建 state 守「新对象+
 * 新数组」约束）。走 velocity 则方块碰撞与 step-up 天然生效，不新增权威。
 *
 * **静止丧尸也会被推开**：排斥力无条件叠加（不在「感知范围内」分支里），故 AI 速度为 0 时
 * velocity 仍非零 —— 这正是「已经挤在一起的静止丧尸会散开」的来源。
 *
 * @param {{id: string, position: number[]}} self 当前丧尸
 * @param {Array<{id: string, position: number[]}>} others **含 self** 的全部丧尸
 *   （mc-lite 的 `allEnemies` 含自己，靠 `other.id === enemy.id` 跳过）
 * @returns {{x: number, z: number}} 排斥力向量
 */
export function separationForce(self, others) {
  let forceX = 0;
  let forceZ = 0;
  const { minDistance, repulsionStrength } = ZOMBIE_SEPARATION;
  for (const other of others ?? []) {
    if (other.id === self.id) continue; // 跳过自己
    const dx = self.position[0] - other.position[0];
    const dz = self.position[2] - other.position[2];
    const distance = Math.sqrt(dx * dx + dz * dz);
    if (distance < minDistance && distance > 0.001) {
      // 距离越近排斥力越大（线性衰减）
      const force = (minDistance - distance) / minDistance * repulsionStrength;
      // 归一化方向 × force
      forceX += (dx / distance) * force;
      forceZ += (dz / distance) * force;
    } else if (distance <= 0.001) {
      // **tie-break（有意偏离 mc-lite，实测必需）**：mc-lite 判定 `distance > 0.001` →
      // 完全重叠时跳过不推开。这在 mc-lite 里无害（它有 S 路线随机偏移角让丧尸不会精确同点），
      // 但在 mc-heavy 里会**永久死锁**：两只同位置丧尸的追逐速度完全相同 → 永远同步移动、
      // 永不分开（实测 20 只强制同点生成后 3 秒仍 min=0、190 对全重叠）。mc-heavy 的 AI 是
      // 纯直线追逐，没移植 S 路线偏移角，故必须自己补 tie-break。
      //
      // 用 **id 派生的确定性方向**而非 `Math.random()`：① 可测（断言能钉住具体方向）；
      // ② 无帧间抖动（random 会让丧尸每帧换方向抖个不停）。
      // 方向由「排序后的 id 对」派生 + 符号由 id 序决定 → **同位置的两只必然朝相反方向**
      // （若两只派生出同一角度，它们仍会同步移动 → 死锁没解开）。
      const selfFirst = self.id < other.id;
      const pairKey = selfFirst ? self.id + other.id : other.id + self.id;
      let codeSum = 0;
      for (let i = 0; i < pairKey.length; i++) codeSum += pairKey.charCodeAt(i);
      // 黄金角散列：让不同 id 对的方向尽量分散（避免多只重叠时全朝同一方向）
      const ang = codeSum * 0.6180339887498949;
      const sign = selfFirst ? 1 : -1;
      forceX += Math.cos(ang) * repulsionStrength * sign;
      forceZ += Math.sin(ang) * repulsionStrength * sign;
    }
  }
  return { x: forceX, z: forceZ };
}

/**
 * 计算一批丧尸的 AI 期望速度（追逐 + 排斥力）。
 *
 * **同构纯函数**：worker（`world-worker.js` 的 `ai` 分支）与浏览器内单测共用同一份 ——
 * 红线 8「主线程/Worker 同构纯函数」，也避免「测试与真实接线口径不一致」的盲区
 * （CLAUDE.md 活跃约束：fake pool 曾让纯逻辑测试全绿而真实接线丢回包）。
 *
 * 追逐语义 = M6 规格 §2（感知门 `perceptionRange` 内归一化方向 × `speed`，门外 idle + 零速度）。
 * 排斥力按 mc-lite `:218-220` 无条件叠加（门外也叠加 → 静止丧尸会散开）。
 *
 * @param {{playerPosition: number[], dt: number,
 *          zombies: Array<{id: string, generation: number, position: number[], yaw: number, mode: string}>}} p
 * @returns {{updates: Array<{id: string, generation: number, vx: number, vz: number, mode: string}>}}
 */
export function computeAiUpdates(p) {
  const [px, , pz] = p.playerPosition;
  const zombies = p.zombies ?? [];
  const updates = [];
  for (const z of zombies) {
    const [x, , z0] = z.position;
    const dx = px - x, dz = pz - z0;
    const dist = Math.hypot(dx, dz);
    // 基础 AI 速度：感知门外 idle + 零速度（不追）。感知门内：归一化方向 × 速度上限
    let aiVx = 0, aiVz = 0;
    let mode = 'idle';
    if (dist <= ZOMBIE.perceptionRange && dist > 1e-6) {
      aiVx = dx / dist * ZOMBIE.speed;
      aiVz = dz / dist * ZOMBIE.speed;
      mode = 'chasing';
    }
    // **最终期望速度 = AI 速度 + 排斥力**（mc-lite `:218-220` 同口径）
    const sep = separationForce(z, zombies);
    updates.push({
      id: z.id,
      generation: z.generation,
      vx: aiVx + sep.x,
      vz: aiVz + sep.z,
      mode,
    });
  }
  return { updates };
}

/**
 * state.mode 的白名单（v2.40 加入 `'blocked'`）。
 *
 * ⚠️ **必须是单一实现**：`createState()` 与 `setIntent()` 都消费它。写两份三元表达式会让其中一处
 * 漏掉 `'blocked'`，形态是「速度与位置都对（都是零）、只有 mode 错」—— 任何只看「它没动」的
 * 断言都抓不到（实测：注入旧式三元后 k 用例真红）。
 */
function normalizeMode(mode) {
  return mode === 'chasing' || mode === 'blocked' ? mode : 'idle';
}

/** 新建一份合法 state（形状即 M6 规格 §2 口径，少 generation） */
function createState({ position, velocity, yaw, health, mode, source, flashedUntil, onGround, _physAccum }) {
  const pos = normalizePosition(position);
  if (!pos) return null;
  const vel = Array.isArray(velocity) && velocity.length === 3 && velocity.every(Number.isFinite)
    ? [velocity[0], velocity[1], velocity[2]]
    : [0, 0, 0];
  return {
    position: pos,
    velocity: vel,
    yaw: Number.isFinite(yaw) ? yaw : 0,
    health: Number.isFinite(health) ? health : ZOMBIE.health,
    mode: normalizeMode(mode),
    source: typeof source === 'string' ? source : null,
    flashedUntil: Number.isFinite(flashedUntil) ? flashedUntil : 0,
    /** 物理派生量（step-up 判定依据）。不入 snapshot（丧尸是临时实体），故不算第二份权威 */
    onGround: onGround === true,
    /**
     * 60Hz 固定步 accumulator（瞬态物理量，不入 snapshot）。**必须在 createState 里保留** ——
     * `damage`/`setIntent` 都经 createState 重建 state，不保留会让每次受伤/收到 AI 回包都把
     * 累积器清零 → 物理时序漂移（同一段 dt 跑出不同步数）。
     */
    _physAccum: Number.isFinite(_physAccum) ? _physAccum : 0,
  };
}

/**
 * 丧尸 60Hz 物理（M6 规格 §2：主线程按既有 60Hz 固定步长以 `world.isSolid()` 应用重力、
 * AABB 碰撞和一格 step-up）。
 *
 * **为什么物理在 definition.update 而不是 ZombieService.update**：`EntityManager.update()`
 * 负责跨 column 的派生索引迁移（M5 规格 §2「每次 update() 后重新定位发生跨 column 的实体」），
 * 而 Game 帧循环已经调它。若 ZombieService.update 也跑物理，丧尸会**推进两遍**（速度翻倍）——
 * 两处物理是同一事实的两个副本（红线 1）。故：definition.update 跑物理，
 * ZombieService.update 只管 AI 编排（RPC accumulator）。
 *
 * 常数移植 mc-lite `PHYSICS_CONFIG`（gravity 0.08 格/帧² ≈ -24 格/秒²、MAX_STEP 1.0），
 * 与 `player/physics.js` 同口径 —— 手感一致，丧尸不会飘。
 */
const GRAVITY = -24.0;
// 一格台阶上限的唯一权威已上移到 `zombie-config.js` 的 `ZOMBIE_MAX_STEP`（v2.40）——
// 避障探针要读同一份（红线 1）。`PHYS_EPSILON` 也随 `collides()` 一并搬到 `zombie-navigation.js`。

/**
 * 分轴移动 + 碰撞 + 自动上台阶（与 player/physics.js `_moveAxis`/`_tryStepUp` 同构）。
 *
 * @param {boolean} zeroVelocityOnHit 撞墙后是否清零该轴速度。
 *   **竖直轴必须清零**（否则重力逐帧累积 → 落地瞬间巨大负速度、穿地抖动）；
 *   **水平轴不得清零** —— 水平速度是 AI 意图（RPC 每 0.05 秒才刷新一次，物理跑 60Hz），
 *   撞墙清零会让丧尸在两次 RPC 之间彻底卡住（实测：清零后丧尸贴墙不动直到下个周期）。
 */
function moveAxis(state, world, delta, axis, keys, zeroVelocityOnHit) {
  if (delta === 0) return;
  const old = state.position[axis];
  state.position[axis] = old + delta;
  if (collides(state, world)) {
    // 水平轴：尝试自动上台阶（mc-lite tryStepUp 手感，MAX_STEP=1.0）
    if (axis !== 1 && tryStepUp(state, world)) return;
    // 二分回退到不碰撞位置
    let lo = 0, hi = 1;
    for (let i = 0; i < 8; i++) {
      const mid = (lo + hi) / 2;
      state.position[axis] = old + delta * mid;
      if (collides(state, world)) hi = mid; else lo = mid;
    }
    state.position[axis] = old + delta * lo;
    if (axis === 1 && delta < 0) state.onGround = true;
    if (zeroVelocityOnHit) state.velocity[axis] = 0;
  }
}

/**
 * 自动上台阶：水平碰撞时，把脚底抬到上一格整数面。
 * 用完整 AABB 检测保证 2 格高墙抬不上去（目标位仍碰撞）、头顶净空不足抬不上去
 * （1.8 高需 2 格净空）—— 与 player/physics.js `_tryStepUp` 同一判据。
 *
 * **门控不是 `onGround`（v1.72，与 player/physics.js 同步改）**：只在「跳跃上升段」拒绝，
 * 下落中允许 —— 否则丧尸斜蹭台阶边沿时会先失去支撑（`onGround=false`）再被前方台壁挡死，
 * 表现为彻底卡住。根因与实测数据见 `player/physics.js` 的 `_tryStepUp` 注释。
 */
function tryStepUp(state, world) {
  if (!state.onGround && state.velocity[1] > 0) return false;
  const oldY = state.position[1];
  const lifted = zombieStepUpY(oldY); // 唯一实现在 zombie-navigation.js（探针读同一份）
  if (lifted - oldY > ZOMBIE_MAX_STEP) return false; // 超过一格台阶不登（mc-lite MAX_STEP 语义）
  state.position[1] = lifted;
  if (!collides(state, world)) { state.velocity[1] = 0; return true; }
  state.position[1] = oldY;
  return false;
}

/**
 * 单个 60Hz 固定步的积分（重力 + 分轴碰撞 + step-up）。**原地改写传入 state**。
 * @param {object} state @param {import('../../voxel/world-data.js').WorldData} world
 * @param {number} dt 固定步长（1/60）
 */
function physicsStep(state, world, dt) {
  const keys = ['x', 'y', 'z'];
  state.velocity[1] += GRAVITY * dt;
  // **竖直先走**（顺序与 player/physics.js 一致，step-up 依赖它）：先落地算出本步的
  // `onGround`，水平轴才能据此判定能否上台阶。把 `onGround = false` 放在水平移动之前
  // 会让 `tryStepUp` 永远拿不到 onGround → step-up 完全失效（实测踩坑）。
  state.onGround = false;
  moveAxis(state, world, state.velocity[1] * dt, 1, keys, true);
  // AI 意图驱动的水平移动（velocity[0]/[2] 由 RPC 回包写入）
  moveAxis(state, world, state.velocity[0] * dt, 0, keys, false);
  moveAxis(state, world, state.velocity[2] * dt, 2, keys, false);
}

/**
 * 丧尸 AABB 0.6×1.8×0.6 与实心方块采样检测（脚底为 position）。
 *
 * **唯一实现在 `zombie-navigation.js` 的 `zombieCollidesAt`**（v2.40）—— 避障探针要读同一份判据，
 * 两份会漂移成「探针以为能过、物理撞墙」，而那种漂移是静默的（只表现为丧尸莫名卡顿）。
 */
function collides(state, world) {
  return zombieCollidesAt(world, state.position[0], state.position[1], state.position[2]);
}

/**
 * `zombie` 类型定义（注册进 EntityManager，与 `probe` 同构口径）。
 * `update` 跑 60Hz 物理 —— 由 `EntityManager.update()` 驱动（见上方注释的分层理由）。
 */
export const zombieDefinition = Object.freeze({
  create: createState,
  /**
   * 单步物理。**必须返回新对象（含新 position/velocity 数组）** —— 不可原地改写后返回同一份。
   *
   * 为什么（实测踩坑，勿照直觉改回）：`EntityManager.update()` 的跨 column 索引迁移判据是
   * ```js
   * const before = columnKeyOfPosition(entity.state.position); // 赋值前
   * entity.state = next;
   * const after  = columnKeyOfPosition(next.position);         // 赋值后
   * if (before !== after) { 迁移索引 }
   * ```
   * 若 `next === entity.state`（同一对象引用）且 position 数组已被原地改写，则 before/after
   * 都从**同一份已改写的位置**算出 → 恒相等 → **索引永不迁移** → 丧尸跨 column 后仍留在旧
   * 索引里 → column 卸载时漏回收（实体泄漏 + 渲染 slot 泄漏）。
   *
   * 浅拷贝 `{...state}` 也不够：position 数组引用相同，同样会被原地改写污染 before。
   * 故物理推进在**全新的 state + 全新数组**上做（`createState` 已保证形状与校验一致）。
   * 开销 = 20 只 × 60Hz ≈ 1200 个小对象/秒，对 GC 微不足道（实测 bench 无回退）。
   *
   * @param {import('../entity-manager.js').Entity} entity
   * @param {number} dt @param {{world: import('../../voxel/world-data.js').WorldData}} context
   */
  update(entity, dt, context) {
    const world = context?.world;
    if (!world) return entity.state; // 无世界上下文（纯 fixture 调用）：不推进，避免读空指针
    const prev = entity.state;
    // 新对象 + 新数组（见上方注释的索引迁移理由）
    const state = createState({
      position: [...prev.position],
      velocity: [...prev.velocity],
      yaw: prev.yaw, health: prev.health, mode: prev.mode,
      source: prev.source, flashedUntil: prev.flashedUntil, onGround: prev.onGround,
    });
    // **60Hz 固定步长 accumulator**（M6 规格 §2「主线程按既有 60Hz 固定步长」= player/physics.js
    // 的 accumulator 口径）。为什么不直接用帧 dt 积分：帧 dt 随显示刷新率变化（120Hz → 1/120、
    // 掉帧 → 上限 0.1s），碰撞判定粒度随之漂移 → 同一 AI 意图在不同帧率下走出不同路径。
    // 固定步长让丧尸运动与帧率无关（确定性），且 n<5 上限防后台切回时一次跑上百步（卡顿尖峰）。
    // `_physAccum` 是瞬态物理量，不入 snapshot（丧尸本就不写盘）。
    state._physAccum = (prev._physAccum ?? 0) + dt;
    const step = 1 / 60;
    let n = 0;
    while (state._physAccum >= step && n < 5) {
      physicsStep(state, world, step);
      state._physAccum -= step;
      n++;
    }
    return state;
  },
  raycastAabb: (state, origin, dir, maxDist) => raycastAabbSlab(state, origin, dir, maxDist, ZOMBIE_AABB),
  /** 丧尸是临时实体，**不写 snapshot**（M6 规格 §1）—— 序列化一律返回 null */
  serialize() { return null; },
  deserialize() { return null; },
});

export class ZombieService {
  /**
   * @param {{entities: import('../entity-manager.js').EntityManager,
   *          world: import('../../voxel/world-data.js').WorldData,
   *          maxActive?: number,
   *          pool?: import('../../core/worker-pool.js').WorkerPool,
   *          onSpawn?: (id: string, slot: number) => void,
   *          onDespawn?: (id: string) => void}} deps
   *        `onSpawn`/`onDespawn` 是渲染层的对称回收钩子（Game 装配时注入）。注入而非 import
   *        render —— 本层是 Worker 同构层，不得依赖 render/three（依赖方向 §3）。
   *        `pool` 缺省时不发 AI RPC（纯 fixture 只测 state/渲染）—— AI 是可选装配。
   */
  constructor({ entities, world, maxActive = ZOMBIE.maxActive, pool = null, onSpawn = null, onDespawn = null }) {
    this.entities = entities;
    this.world = world;
    this.maxActive = maxActive;
    this.pool = pool;
    this._onSpawn = onSpawn;
    this._onDespawn = onDespawn;
    /**
     * 本地导航（v2.47）：`PathCache` + 每只丧尸的旅行记忆。**常开、零网络**。
     * ⚠️ 历史上这里挂过「在线 AI 编排器」（Jev），已整体删除（用户 2026-11-04 裁定）。
     */
    this._pathCache = new PathCache();
    /** @type {Map<string, object>} id → 导航记忆（只剩 `plan`，v2.49 清理） */
    this._navMemory = new Map();
    /** 决策周期（秒）：复用离线 AI 周期，不新开节流 */
    this._navAccum = 0;
    /** 诊断计数 */
    this._navDecisions = 0;
    this._navBlocked = 0;
    // ---- AI 编排状态（Task 2）----
    /** accumulator：累计到 `ZOMBIE.aiPeriod` 才发一条 RPC（20Hz，M6 规格 §2） */
    this._aiAccum = 0;
    /** 在途 RPC 标记：**在途期间不重复调用**（否则一个周期内会发出多条，回包互相覆盖） */
    this._aiInFlight = false;
    /** @type {{calls: number, lastBatchSize: number, pending: number}} 只读测试钩子 */
    this._aiDebug = { calls: 0, lastBatchSize: 0, pending: 0 };
    /** @type {Map<string, number>} id → 渲染 slot（slot 单一权威在这里，renderer 只接收） */
    this._slots = new Map();
    /** @type {number[]} 空闲 slot（低位优先，与 mc-lite/tracer 池同口径） */
    this._freeSlots = [];
    for (let i = maxActive - 1; i >= 0; i--) this._freeSlots.push(i);
    /** @type {number} 已分配 slot 数（= 活动丧尸数） */
    this._active = 0;
    // **不用 `entities.onDespawn()` 钩子归还 slot**：该钩子是单槽覆盖语义
    // （`EntityManager._onDespawned = fn`），M5 已把它留给 Game 装配渲染层的对称回收；
    // ZombieService 再注册一次会覆盖掉前者（且覆盖是静默的，看不出谁生效）。
    // 故 slot 归还在本类的**三条回收路径**上显式做 —— 正是 M6 规格 §2 枚举的全部路径：
    // 死亡（`damage`）/ column 卸载（`despawnColumn`）/ `dispose`。
    // 新增第四条回收路径时须同步归还 slot，否则渲染留残影、容量被占满。
  }

  /**
   * 出生。**四道门全过才创建**，任何失败路径不产生部分副作用（M6 规格 §2）。
   *
   * 门控顺序：上限 → column 已加载 → 脚格 air → 头格 air → 脚下 solid。
   * 「脚下 solid」用 `isSolid` 而非 `supportsPlayer`：丧尸不站在云上（mc-lite 语义）。
   *
   * @param {number[]} position 脚底位置 @param {{source?: string|null}} [opts]
   * @returns {string|null} 成功返回 id；满额/非法位置返回 null
   */
  spawn(position, { source = null } = {}) {
    if (this._active >= this.maxActive) return null;
    const pos = normalizePosition(position);
    if (!pos) return null;
    const [x, y, z] = pos;
    const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
    if (!this.world.hasColumn(Math.floor(x / 16), Math.floor(z / 16))) return null;
    if (this.world.getBlockId(bx, by, bz) !== 0) return null;     // 脚格被占用
    if (this.world.getBlockId(bx, by + 1, bz) !== 0) return null; // 头格被占用
    if (!this.world.isSolid(bx, by - 1, bz)) return null;         // 脚下无支撑

    const slot = this._freeSlots.pop();
    // `_active >= maxActive`（上面第一道门）与「slot 池耗尽」是**等价的两道门** —— 容量都由
    // maxActive 决定，两者同步增减。故走到这里 slot 池必然非空；为空说明 `_active` 与
    // `_freeSlots` 不同步（真 bug）。**抛错而非静默返回 null**：静默返回会把状态不同步
    // 伪装成「满额拒绝」，让缺陷逃逸 —— 负向验证实测踩过（删掉上限门控后两道冗余门互相
    // 兜底，注入仍然全绿）。
    if (slot === undefined) throw new Error('ZombieService: slot 池与 _active 不同步（上限门控被绕过）');
    // id 与 slot 同编号：id 天然随 slot 复用（低位优先），无需第二份 id 池
    const id = `z${slot}`;
    const entity = this.entities.spawn({
      id,
      type: 'zombie',
      state: createState({ position: pos, health: ZOMBIE.health, source }),
      persistent: false, // 临时实体：不写 snapshot，随 column 卸载回收
    });
    if (!entity) { this._freeSlots.push(slot); return null; }
    this._slots.set(id, slot);
    this._active++;
    this._onSpawn?.(id, slot);
    return id;
  }

  /** @param {string} id @returns {Readonly<object>|null} 只读测试接口（调用方不得写回） */
  get(id) {
    const entity = this.entities.get(id);
    return entity ? entity.state : null;
  }

  /** @returns {number} 活动丧尸数 */
  count() { return this._active; }

  /**
   * 只读活动实体快照（M8 爆炸半径伤害用）。**不新建第二份实体集合**（红线 1）——
   * 只是从 M5 EntityManager 的迭代器过滤 type。返回数组快照而非迭代器：
   * 调用方会在遍历中调 `damage()` → 可能触发 despawn 改变底层集合（迭代器失效）。
   * @returns {Array<import('../entity-manager.js').Entity>}
   */
  activeEntities() {
    const out = [];
    for (const entity of this.entities.entities()) {
      if (entity.type === 'zombie') out.push(entity);
    }
    return out;
  }

  /**
   * 造成伤害。**立即改变权威 state** 并置 `flashedUntil = nowMs + 200`；health ≤ 0 立刻 despawn。
   * 返回值用于测试，不是效果事件的替代品（M6 规格 §2）。
   * @param {string} id @param {number} amount @param {number} nowMs
   * @returns {{dead: boolean, health: number}|null} 未知 id 返回 null
   */
  damage(id, amount, nowMs) {
    const entity = this.entities.get(id);
    if (!entity || entity.type !== 'zombie') return null;
    const state = entity.state;
    const health = state.health - (Number.isFinite(amount) ? amount : 0);
    const flashedUntil = (Number.isFinite(nowMs) ? nowMs : 0) + ZOMBIE_FLASH_MS;
    entity.state = createState({ ...state, health, flashedUntil });
    if (health <= 0) {
      this.entities.despawn(id, 'killed');
      this._releaseSlot(id); // 回收路径 ①：死亡
      return { dead: true, health };
    }
    return { dead: false, health };
  }

  /**
   * 击退（v2.65 近战剑）：沿给定水平位移把丧尸推开一小步。
   *
   * ⚠️ **必须是位置位移，不能写 velocity**：丧尸的水平 `velocity` 是 AI 意图，
   * RPC 每 `ZOMBIE.aiPeriod`(0.05s) 覆写一次 —— 写进 velocity 的击退会在下一拍被冲掉
   * （形态：数据层看着有值，画面上丧尸纹丝不动）。理由与碰撞回退见
   * `displaceGroundEntity`（`zombie-navigation.js`，与物理共用同一份 `aabbCollidesAt`）。
   *
   * ⚠️ **必须显式 `reindexColumn`**：本方法在 `EntityManager.update` 之外改 `state.position`，
   * 不调它实体就停在旧 column 索引上不自愈（AGENTS.md 已记）。
   *
   * @param {string} id @param {number} dx @param {number} dz 水平位移（格，已含距离与方向）
   * @returns {boolean} false = 未知 id / 完全走不动（被墙卡死）
   */
  knockback(id, dx, dz) {
    const entity = this.entities.get(id);
    if (!entity || entity.type !== 'zombie') return false;
    const state = entity.state;
    const next = displaceGroundEntity(
      this.world, state.position, dx, dz, ZOMBIE.width / 2, ZOMBIE.height,
    );
    if (next[0] === state.position[0] && next[2] === state.position[2]) return false;
    // 经 createState 重建（不原地改）：原地改会让跨 column 迁移判据的 before/after 同源
    entity.state = createState({ ...state, position: next });
    this.entities.reindexColumn(id);
    return true;
  }

  /**
   * 写入 AI 意图（Task 2 的 RPC 回包消费点）。**写进 state.velocity/mode/yaw，不另设 intent 容器**
   * —— 渲染步态与物理移动读同一个字段，不会分家。过期回包由调用方先经 generation 校验。
   *
   * **朝向从速度派生**（对齐 mc-lite `Zombie.js:230-239` 的 `setDesiredVelocity`）：
   * `yaw = atan2(vx, vz)`，且**仅在移动时更新** —— 静止（`abs(vx) ≤ 0.001 && abs(vz) ≤ 0.001`）
   * 保持原朝向。阈值用 `ZOMBIE_MOVING_EPSILON`（与步态判定同一个常量，单一权威在 config）。
   *
   * 为什么必须在这里派生而不是在渲染层算：yaw 是**实体逻辑状态**（渲染层只读 pose，不得回写），
   * 且物理的水平位移也读 velocity —— 朝向与实际移动方向同源才不会「走左边却看着右边」。
   * 实测踩坑：yaw 初始化为 0 后从未更新 → 丧尸出生后永远面向同一方向（渲染层确实消费 yaw，
   * `_parent.rotation.set(0, pose.yaw, 0)`，但读到的恒是 0）。
   *
   * @param {string} id @param {{vx: number, vz: number, mode?: string}} intent
   * @returns {boolean} false = 未知 id
   */
  setIntent(id, { vx = 0, vz = 0, mode = 'idle' }) {
    const entity = this.entities.get(id);
    if (!entity || entity.type !== 'zombie') return false;
    const state = entity.state;
    const outVx = Number.isFinite(vx) ? vx : 0;
    const outVz = Number.isFinite(vz) ? vz : 0;
    // 移动中才派生朝向（mc-lite 同口径）；静止保持原朝向，避免零速度把 yaw 清零
    const moving = Math.abs(outVx) > ZOMBIE_MOVING_EPSILON || Math.abs(outVz) > ZOMBIE_MOVING_EPSILON;
    const yaw = moving ? Math.atan2(outVx, outVz) : state.yaw;
    entity.state = createState({
      ...state,
      velocity: [outVx, state.velocity[1], outVz],
      mode: normalizeMode(mode),
      yaw,
    });
    return true;
  }

  /**
   * 每帧推进 AI 编排（M6 规格 §2）。**不跑物理** —— 物理在 `zombieDefinition.update`，
   * 由 `EntityManager.update()` 驱动（见 zombie-system.js 的分层理由注释）。
   *
   * 编排三件事：
   * ① accumulator 累计到 `aiPeriod`（0.05 秒 = 20Hz）才发一条 RPC；
   * ② 批次只含「距玩家 ≤ `aiSleepDistance`（60 格）」的活尸 —— **只冻结意图，不销毁**；
   * ③ 回包逐个验 `{id, generation}` 后写意图，过期包丢弃（红线 7 版本协议）。
   *
   * **不传局部体素 view**：worker 只输出 `{id,generation,vx,vz,mode}`，世界读取一律由
   * 主线程物理用 `world.isSolid()` 做（M6 规格 §2 的明确口径）。
   *
   * @param {number} dt 秒
   * @param {{world?: object, playerPosition: number[], nowMs?: number}} context
   */
  /**
   * 本地导航一步：给所有活动丧尸算方向并写进 `state.velocity`（v2.47）。
   *
   * **常开**，不受任何设置开关控制 —— 它是纯本地计算（24 格 BFS + 缓存，实测 20 只
   * 的帧时零回退），没有"关掉"的理由。用户 2026-11-04 裁定删掉网络推理后，
   * 这就是丧尸「智能」的全部来源。
   *
   * @param {number[]} playerPosition 玩家脚底 [x, y, z]
   */
  _stepNavigator(playerPosition) {
    const world = this.world;
    const nowMs = this._nowMs
      ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
    // 格坐标可走性判据：**直接复用 `zombieCollidesAt`**（唯一权威，与物理同源）。
    // 丧尸脚底在 y，AABB 高 1.8 → 占 y..y+1 两层；站在该格 = AABB 不碰撞。
    // 一层台阶算可走：抬一格后也不碰撞即可（与物理 `tryStepUp` 同口径）。
    // ⚠️ **不要自己用 `isSolid` 拼判据**（初版就是这么写的，把「脚下是地面」误判成不可走，
    // 导致所有方向 blocked、丧尸站死）——`zombieCollidesAt` 才懂 AABB 与脚底语义。
    const isWalkable = (w, bx, y, bz) => {
      if (!zombieCollidesAt(w, bx + 0.5, y, bz + 0.5)) return true;
      const lifted = zombieStepUpY(y);
      return lifted - y <= ZOMBIE_MAX_STEP && !zombieCollidesAt(w, bx + 0.5, lifted, bz + 0.5);
    };
    // `separationForce` 的入参形状是 `{id, position}`（mc-lite 口径），先收集一份
    const allZombies = [];
    for (const entity of this.entities.entities()) {
      if (entity.type !== 'zombie') continue;
      allZombies.push({ id: entity.id, position: entity.state.position });
    }
    for (const entity of this.entities.entities()) {
      if (entity.type !== 'zombie') continue;
      const st = entity.state;
      const mem = memoryFor(this._navMemory, entity.id);
      const step = decideStep({
        world,
        position: st.position,
        playerPosition,
        memory: mem,
        pathCache: this._pathCache,
        nowMs,
        isWalkable,
      });
      this._navDecisions++;
      if (step.blocked) this._navBlocked++;
      // **实体排斥力**（v2.47 从已删除的离线 RPC 路径搬过来）：
      // 20 只丧尸朝同一目标走会收敛成一个点。原来由 `computeAiUpdates` 无条件叠加，
      // 该路径删掉后必须在这里补回 —— 否则「强制同点生成后必须散开」的观感直接消失
      // （实测：不补时 190 对全重叠、3 秒后仍然 190 对）。
      //
      // ⚠️⚠️ **排斥力必须绕开 `_applyIntent` 的 `steerIntent`**：后者是「把方向修成
      // 走得通的方向」，0° 一通行就**原样返回输入向量**。把「导航方向 + 排斥力」的合成
      // 向量喂进去时，只要 0° 通得过，排斥力就被整个吞掉（实测：190 对全重叠散不开）。
      // 正确做法 = 导航方向走 `_applyIntent`（含避障），排斥力**直接叠加到最终速度上**。
      // **合成 → 避障 → 钳制**（顺序与 mc-lite `:218-220` 等价，只是避障插在中间）：
      // ① 导航给出方向，排斥力把它推离同伴；② `steerIntent` 保证合成的方向真的走得通；
      // ③ 最后统一钳到 `ZOMBIE.speed`。
      //
      // ⚠️⚠️ **排斥力必须参与合成，不能事后再单独 setIntent**：
      // 事后叠加会绕过钳制 —— `separationForce` 在 19 只同点时的合力达 19 格/秒（16 倍速），
      // 直接把丧尸甩飞；而且它绕过了 `steerIntent`，可能把丧尸推进墙里。
      // ⚠️ **也不能只把「导航方向」喂给 `_applyIntent` 再叠排斥力**：`steerIntent` 在 0°
      // 通行时原样返回输入向量，排斥力会被整个吞掉（实测 190 对全重叠散不开）。
      // ⚠️ **`separationForce` 的入参是 `{id, position}`，不是 `Entity` 对象**
      // （`Entity` 的位置在 `state.position`，没有顶层 `position`）。传错会抛
      // `Cannot read properties of undefined (reading '0')` —— 而那个异常在遍历里被吞掉，
      // 表现为「只有第一只丧尸在动、其余速度恒 0」（实测踩到）。
      const sep = separationForce({ id: entity.id, position: st.position }, allZombies);
      this._applyIntent({
        id: entity.id,
        generation: entity.generation,
        vx: step.vx * ZOMBIE.speed + sep.x,
        vz: step.vz * ZOMBIE.speed + sep.z,
        mode: step.mode,
      });
    }
  }

  update(dt, { playerPosition } = {}) {
    // ---- 本地导航（v2.47）：**常开、零网络、不受任何开关控制** ----
    // ⚠️ **这是本轮最重要的不变式**：寻路一度只挂在「在线 AI 开关」下，而那个开关默认关闭
    // ⇒ 玩家实玩时寻路一行都没执行（实测 `plannerEnabled: false, decided: 0`），
    // 表现为「丧尸完全没有任何寻路逻辑」。寻路是纯本地计算（零 API 成本），必须常开。
    this._navAccum += dt;
    if (this._navAccum >= ZOMBIE.aiPeriod) {
      this._navAccum = 0;
      this._stepNavigator(playerPosition);
    }
    // ⚠️ **离线 RPC 决策分支已整体删除**（v2.47，用户 2026-11-04 裁定「只依赖本地计算」）。
    // 历史：这里曾走 `pool.call('ai', …)` 让 worker 算「直线朝玩家」的意图。它与本地导航
    // **抢写同一份 `state.velocity`** —— 实测形态是「速度在 ±1.2 之间翻转、净位移接近 0」。
    // `state.velocity` 的写者现在**只有** `_stepNavigator`（经 `_applyIntent`）。
    // `this.pool` 字段保留只为装配层兼容（Game 仍注入），本类不再消费。
  }

  /**
   * 应用一条 AI 意图。**先验代数**再写（红线 7）：迟到的意图不得改变已 despawn 的实例
   * 或同 id 的后续实例。速度长度钳到 `ZOMBIE.speed`（恶意/错误的意图不得让丧尸超速）。
   *
   * **局部避障就在这里**（v2.40）：钳速之后过一道 `steerIntent`，把「目标方向」修成
   * 「走得通的方向」。
   * ⚠️ **必须留在这里，不得搬进 `setIntent`**：后者是通用意图写入口（物理用例、调试代码
   * 直接下令），探针长在里面会让「想让它走就必须能走」的语义被偷换。
   * ⚠️ **`state.velocity` 的唯一写者链**：`_stepNavigator` → 本方法 → `setIntent`。
   * v2.47 删掉了离线 RPC 分支，它就是唯一来源。
   * @param {{id: string, generation: number, vx: number, vz: number, mode?: string}} update
   * @returns {boolean} false = 过期/未知，已丢弃
   */
  _applyIntent({ id, generation, vx, vz, mode }) {
    const entity = this.entities.get(id);
    if (!entity || entity.type !== 'zombie') return false;
    if (entity.generation !== generation) return false; // 过期意图
    const speed = Math.hypot(vx, vz);
    let outVx = vx, outVz = vz;
    if (speed > ZOMBIE.speed) { outVx = vx / speed * ZOMBIE.speed; outVz = vz / speed * ZOMBIE.speed; }
    // 局部避障：只换方向、不改长度（长度权威仍是上面那次钳制 + ZOMBIE.speed）
    const steered = steerIntent({
      world: this.world, position: entity.state.position, vx: outVx, vz: outVz,
    });
    return this.setIntent(id, {
      vx: steered.vx, vz: steered.vz,
      mode: steered.blocked ? 'blocked' : mode,
    });
  }

  /** @returns {{calls: number, lastBatchSize: number, pending: number}} 只读测试钩子（已废弃，恒 0） */
  debugAiState() {
    return { calls: this._aiDebug.calls, lastBatchSize: this._aiDebug.lastBatchSize, pending: this._aiDebug.pending };
  }

  /**
   * 本地导航的只读诊断（测试/调试用）。**没有开关** —— 寻路常开。
   * @returns {{memorySize: number, pathCache: object, navDecisions: number, navBlocked: number}}
   */
  debugNavigator() {
    return {
      memorySize: this._navMemory.size,
      pathCache: this._pathCache.debugState(),
      navDecisions: this._navDecisions,
      navBlocked: this._navBlocked,
    };
  }

  /** @param {string} id @returns {number|null} 只读测试接口：id 的渲染 slot */
  slotOf(id) {
    const slot = this._slots.get(id);
    return slot === undefined ? null : slot;
  }

  /**
   * column 卸载前的临时实体回收包装（M5 卸载链路的 M6 侧）。
   *
   * 先快照本 column 内的丧尸 id 再回收 —— `entities.despawnColumn()` 只返回计数，
   * 拿不到 id，而 slot 归还需要 id（回收路径 ②：column 卸载）。
   * @param {string} columnKey @returns {number} 回收数
   */
  despawnColumn(columnKey) {
    const ids = [];
    for (const entity of this.entities.entitiesInColumn(columnKey)) {
      if (entity.type === 'zombie') ids.push(entity.id);
    }
    const n = this.entities.despawnColumn(columnKey, 'column-unloaded');
    for (const id of ids) this._releaseSlot(id);
    return n;
  }

  /** 反向释放：回收全部丧尸（Game.dispose 调用）（回收路径 ③） */
  dispose() {
    for (const id of [...this._slots.keys()]) this.entities.despawn(id, 'dispose');
    for (const id of [...this._slots.keys()]) this._releaseSlot(id);
    this._slots.clear();
    this._active = 0;
  }

  /** 归还 slot（三条回收路径共用；漏任一条都会渲染留残影、容量被占满） */
  _releaseSlot(id) {
    const slot = this._slots.get(id);
    if (slot === undefined) return;
    this._slots.delete(id);
    this._active--;
    this._freeSlots.push(slot);
    // **同处回收导航记忆**（v2.47）：三条回收路径（死亡 / column 卸载 / dispose）
    // 都经过本函数，故只改这一处即可。漏了会带上一只的访问历史（id 随 slot 复用）。
    this._navMemory.delete(id);
    this._pathCache.forget(id);
    this._onDespawn?.(id);
  }
}
