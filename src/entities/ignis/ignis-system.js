// src/entities/ignis/ignis-system.js — 焰魔（Ignis, v2.55）：definition + service
//
// 同构层：**无 DOM、无 three、不新增 Worker**（`check:arch` 的 `ISOMORPHIC_DIRS` 静态门守）。
// 渲染层（`src/render/ignis-renderer.js`）只读本文件产出的 pose，不回写 state、不参与命中
// （命中唯一真相 = `ignisDefinition.raycastAabb`，红线 6）。
//
// ⚠️ **焰魔是「临时实体」**（`persistent: false`，与飞龙同口径）：位置不是纯函数（会走动），
// 但它是 Boss、随 column 卸载回收可接受，且「进存档 = 第二份权威」（红线 2）。
//
// ## 与飞龙（dragon-system）的四处结构性差异
//
// | 项 | 飞龙 | 焰魔 |
// |---|---|---|
// | position 语义 | 身体中心（空中） | **脚底中心**（地面，靠重力） |
// | 物理 | 无（轨道纯函数） | **有**（重力 + 分轴碰撞 + step-up，复用丧尸那套） |
// | AI | 四态机（orbit/chase/attack/return） | 三态机（idle/chase/attack） |
// | 攻击 | 喷火球（生成实体） | 挥剑（扣玩家血，由 game.js 结算） |
import { raycastAabbSlab, normalizePosition } from '../entity-types.js';
import { IGNIS_TYPE, IGNIS, IGNIS_AI, IGNIS_CORE_OBB, IGNIS_STEERING, ignisEntityIdFor }
  from './ignis-config.js';
import { IgnisBossAgent } from '../bosses/ignis-boss-agent.js';
// 寻路三层中的第①②层 —— **与丧尸同一份实现**（v2.61 参数化，红线 1）。
// 第③层（`steerIntentAabb` 的 1.2 格精细避让）已经在 Agent 里，不重复引用。
import { PathCache } from '../zombies/zombie-pathfinder.js';
import { decideStep, memoryFor } from '../zombies/zombie-navigator.js';
import { aabbCollidesAt, zombieStepUpY } from '../zombies/zombie-navigation.js';

// ==================== 纯函数 ====================

/**
 * 身体核心 OBB 绕 `state.yaw` 旋转后的**轴对齐**包围盒。
 *
 * ⚠️ **返回的是「相对 `state.position` 的局部盒」**，不是世界盒 —— `raycastAabbSlab`
 * （`entity-types.js`）内部会做 `lo = aabb.min[axis] + position[axis]`。返回世界盒会让
 * position 被**加两次**（实测形态：水平射线永远打不中，而「盒尺寸」类断言全绿）。
 *
 * ⚠️ **必须现算**：核心盒长宽比不大（0.83 vs 0.78），但 depth 0.777 与 width 0.8264
 * 在 45° 时差异累积可见；且焰魔无俯仰（地面实体），故只绕 Y 旋转。
 *
 * @param {{position: [number,number,number], yaw: number}} state
 * @returns {{min: number[], max: number[]}} 局部盒（调用方加 position 得世界盒）
 */
export function ignisAabbFor(state) {
  const h = IGNIS_CORE_OBB.halfExtents;
  const c = IGNIS_CORE_OBB.center;
  const cos = Math.cos(state.yaw), sin = Math.sin(state.yaw);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let sx = -1; sx <= 1; sx += 2) {
    for (let sy = -1; sy <= 1; sy += 2) {
      for (let sz = -1; sz <= 1; sz += 2) {
        const lx = c[0] + sx * h[0];
        const ly = c[1] + sy * h[1];
        const lz = c[2] + sz * h[2];
        // 绕 Y（偏航），three 约定
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

/** 合法的 mode 取值（其余一律回落 `idle`）。`leap` 是 v2.62 新增的飞跃态（脱困/跳劈共用） */
const MODES = Object.freeze(['idle', 'chase', 'attack', 'leap']);

/** 合法的 leapKind 取值（其余一律回落 `null`）：`escape` 脱困飞跃 / `attack` 跳跃劈砍 */
const LEAP_KINDS = Object.freeze(['escape', 'attack']);

/**
 * 构造全新 state（**不原地改写** —— M5 不变式：`EntityManager.update` 的跨 column 索引
 * 迁移判据是「赋值前 position vs 赋值后 position」，原地改写会让 before/after 从同一份
 * 算出 → 恒相等 → 索引永不迁移 → column 卸载漏回收实体）。
 *
 * 全部字段都有缺省，旧调用不破。
 *
 * @returns {object|null} position 非法时返回 null
 */
function createState({
  position, velocity, yaw, health, flashedUntil, mode,
  attackAnimT, idleTime, attackCooldown, losTimer, losVisible, onGround, attackRequest,
  navDir, navMode, needsPath,
  acquireT, stuckT, stuckAnchor, sensedPlayer, senseTimer,
  leapKind, leapDir, leapT, leapTargetY, leapAttackCooldown,
  _physAccum,
}) {
  const p = normalizePosition(position);
  if (!p) return null;
  const v = Array.isArray(velocity) && velocity.length === 3
    && velocity.every((n) => Number.isFinite(n))
    ? [velocity[0], velocity[1], velocity[2]]
    : [0, 0, 0];
  return {
    position: p,
    velocity: v,
    yaw: Number.isFinite(yaw) ? yaw : 0,
    health: Number.isFinite(health) ? health : IGNIS.health,
    flashedUntil: Number.isFinite(flashedUntil) ? flashedUntil : 0,
    /** 三态机状态：idle（待机）/ chase（追击）/ attack（挥砍中） */
    mode: MODES.includes(mode) ? mode : 'idle',
    /**
     * 攻击动画已播放的秒数。0 = 不在攻击中。
     * 命中判定用它越过 `IGNIS_AI.hitFrameSeconds` 的那一帧触发（**只触发一次**）。
     */
    attackAnimT: Number.isFinite(attackAnimT) ? attackAnimT : 0,
    /**
     * 待机动画的相位（秒，渲染层消费）。
     * ⚠️ **不属于 `position` 派生的量**：它要跨帧累积，否则待机动画永远停在第 0 帧。
     */
    idleTime: Number.isFinite(idleTime) ? idleTime : 0,
    /** 攻击冷却剩余秒数 */
    attackCooldown: Number.isFinite(attackCooldown) ? attackCooldown : 0,
    /** 视线缓存倒计时（秒） */
    losTimer: Number.isFinite(losTimer) ? losTimer : 0,
    losVisible: losVisible === true,
    /** 本帧是否站在地面上（物理用，决定能否 step-up） */
    onGround: onGround === true,
    /**
     * 物理固定步长累积器（瞬态物理量，不入 snapshot）。
     *
     * ⚠️⚠️ **必须保留本字段**，否则 `ignis-boss-agent` 的 accumulator 每帧被重置为 0 ⇒
     * 固定步长最多跑 0~1 步、且余量被丢掉。缺陷形态极其隐蔽（实测踩到）：
     * 焰魔**站得住、位置也对**（因为重力推不动它 —— 下沉量被碰撞卡住），
     * 但 `onGround` 恒为 `false`（"脚底贴地支撑"的判定需要累积出一次完整的
     * `_physicsStep`，而累积器被清零后多数帧根本不跑）。
     * 同类缺陷在丧尸侧被当作「瞬态不入 snapshot」处理，但**必须留在 state 里跨帧传递**——
     * 「不入存档」与「不入 state」是两件事。
     */
    _physAccum: Number.isFinite(_physAccum) ? _physAccum : 0,
    /**
     * ⚠️ **瞬态**：本帧要结算一次挥砍命中。由 game.js 在 `entities.update` 之后消费
     * （生成伤害），Agent 下一帧自动清成 null。
     *
     * 形状 `{at: [x,y,z], yaw: number}` —— `at` 是**焰魔身体位置**（不是玩家位置），
     * 因为命中判据是「玩家的水平距 + 相对角」由结算方算。
     */
    attackRequest: attackRequest || null,
    /**
     * 寻路给出的**单位方向**（`[vx, vz]`），或 `null` = 当前不需要绕行（v2.61）。
     *
     * 由 `IgnisService._stepNavigator` 写入（第①层 A\* + 第②层 `decideStep`），
     * 由 `IgnisBossAgent` 在「直线走不通」时消费。
     *
     * ⚠️ **方向不是位置**：写位置就是第二条位置权威（红线 1）—— 移动仍必须走
     * Agent 的物理（重力/碰撞/step-up），那才是唯一的位置更新路径。
     */
    navDir: Array.isArray(navDir) && navDir.length === 2 && navDir.every((n) => Number.isFinite(n))
      ? [navDir[0], navDir[1]]
      : null,
    /** 寻路给出的模式：`chasing`（有方向）/ `blocked`（四面围死）/ `null`（未规划） */
    navMode: navMode === 'chasing' || navMode === 'blocked' ? navMode : null,
    /**
     * 「下一拍需要重新寻路」标志（v2.61）。
     *
     * ⚠️ **由 Agent 写、由 Service 消费后清**：两者分离的原因与丧尸同 ——
     * Agent 只看得到「这一帧走不通」（1.2 格探针），所以由它判定需求；
     * A\* 是主线程服务层的事（要 `PathCache` 与 20Hz 节流）。
     * 判据必须用「相对意图的偏差」而不是最终向量，否则会自激（见 Agent 注释）。
     */
    needsPath: needsPath === true,
    /**
     * 待机重新锁定的累计秒数（v2.62 用户缺陷①）。
     *
     * `idle` 中玩家在 `sightRange` 内时累加，离开立即清零；满 `IGNIS_AI.turnDelay` 才转
     * `chase`。⚠️ **跨帧累积量，必须在 createState 里保留**（同 `_physAccum` 的教训：
     * 丢掉它 ⇒ 延迟永远累不满 ⇒ 行为静默退化成「立即追击」）。
     */
    acquireT: Number.isFinite(acquireT) ? acquireT : 0,
    /**
     * 「卡住」的累计秒数（v2.62 用户缺陷⑤）。
     *
     * 满 `IGNIS_AI.stuckLeapSeconds` 且在地面 ⇒ 起跳脱困（`leap`/`escape`）。
     * ⚠️ v2.63 起计量口径改为**棘轮式锚点**（不看意图，见 `stuckNetDist` 与 `stuckAnchor`）。
     */
    stuckT: Number.isFinite(stuckT) ? stuckT : 0,
    /**
     * 「上次确认有进展」的位置锚点（v2.63 棘轮式卡住判据），`[x, z]` 或 `null`。
     *
     * ⚠️ **跨帧累积量，必须在 createState 里保留** —— 丢掉它 ⇒ 每帧重新初始化锚点 ⇒
     * `stuckT` 永不累计 ⇒ 脱困飞跃永不触发（同 `_physAccum` 的教训）。
     */
    stuckAnchor: Array.isArray(stuckAnchor) && stuckAnchor.length === 2
      && stuckAnchor.every((n) => Number.isFinite(n))
      ? [stuckAnchor[0], stuckAnchor[1]]
      : null,
    /**
     * 玩家位置的**感知快照**（v2.63：1~2 秒间隔采样），`[x, y, z]` 或 `null`。
     *
     * chase 的移动与转向一律读它，不读真实位置（用户：「不是每时每刻都检测玩家位置，
     * 而是间隔最快 1 秒检测玩家位置，根据这个检测到的玩家位置进行位置移动和转向」）。
     * ⚠️ **跨帧累积量，必须在 createState 里保留** —— 丢掉它 ⇒ 每帧重采 ⇒ 感知间隔失效
     * ⇒ 退化成 v2.62 的每帧跟随（用户报告的问题原样复活）。
     */
    sensedPlayer: Array.isArray(sensedPlayer) && sensedPlayer.length === 3
      && sensedPlayer.every((n) => Number.isFinite(n))
      ? [sensedPlayer[0], sensedPlayer[1], sensedPlayer[2]]
      : null,
    /** 下次感知玩家的倒计时（秒），与 `sensedPlayer` 配套 */
    senseTimer: Number.isFinite(senseTimer) ? senseTimer : 0,
    /** 飞跃类别（仅 `mode === 'leap'` 时有意义）：`escape` 脱困 / `attack` 跳跃劈砍 */
    leapKind: LEAP_KINDS.includes(leapKind) ? leapKind : null,
    /**
     * 飞跃期的水平速度（`[vx, vz]`，**含长度**，不是单位方向）或 `null`。
     *
     * 起跳时算定、空中不再改（常量向量）—— 碰撞/step-up 照常生效，撞墙就滑停。
     * 校验手法同 `navDir`（长度 2 且全部有限）。
     */
    leapDir: Array.isArray(leapDir) && leapDir.length === 2 && leapDir.every((n) => Number.isFinite(n))
      ? [leapDir[0], leapDir[1]]
      : null,
    /** 飞跃已持续秒数（安全阀 `IGNIS_AI.leapMaxSeconds` 用） */
    leapT: Number.isFinite(leapT) ? leapT : 0,
    /**
     * 跳跃劈砍的预判落点 y（仅 `leapKind === 'attack'`），或 `null`。
     *
     * 「快触地时起劈」的判据：下落中且 `py ≤ leapTargetY + IGNIS_AI.leapSlashLead`。
     */
    leapTargetY: Number.isFinite(leapTargetY) ? leapTargetY : null,
    /** 跳跃劈砍的冷却剩余秒数（**独立于** `attackCooldown`） */
    leapAttackCooldown: Number.isFinite(leapAttackCooldown) ? leapAttackCooldown : 0,
  };
}

// ==================== definition ====================

/**
 * 模块级单例 Agent（无跨帧成员，多条焰魔共用安全；与飞龙的 `dragonAgent` 同一手法）。
 *
 * ⚠️ **本文件不写 AI**（用户的解耦指令：每个 Boss 有自己的智能体类）。
 * `ignis-boss-agent.js` 也不 import 本文件 —— 它只依赖 config 与 navigation，避免循环依赖。
 */
const ignisAgent = new IgnisBossAgent();

/**
 * 焰魔的 M5 definition。
 *
 * ⚠️ **`update` 委托给 Agent**（用户的解耦指令：每个 Boss 都有自己的智能体类）。
 * 无玩家上下文（ctx 缺 world/player）时 Agent 只做重力 —— 与「未召唤时不存在」等价。
 */
export const ignisDefinition = Object.freeze({
  create(state) {
    if (!state) return null;
    return createState(state);
  },

  /**
   * 委托 AI 推进一帧，返回值经 `createState` 包裹（校验 + 全新数组）。
   * @returns {object|null} 全新 state
   */
  update(entity, dt, context) {
    const next = ignisAgent.update(entity.state, dt, context || {});
    if (!next) return null;
    return createState(next);
  },

  raycastAabb: (state, origin, dir, maxDist) =>
    raycastAabbSlab(state, origin, dir, maxDist, ignisAabbFor(state)),

  /**
   * 临时实体不走存档，最小 snapshot（保留 health 便于调试；位置不进存档）。
   *
   * ⚠️ **`attackRequest` 刻意不进 snapshot**（瞬态）：它是「本帧要结算命中」的意图，
   * 由 game.js 立即消费。写进快照的形态是「陈旧请求复活」。
   */
  serialize(state) {
    if (!state) return null;
    const p = normalizePosition(state.position);
    if (!p) return null;
    return { position: p, yaw: state.yaw, health: state.health };
  },

  /**
   * 反序列化。AI 字段一律回缺省（idle 态）—— 临时实体本就不走存档。
   * ⚠️ **`attackRequest` 必须显式为 `null`**（不是 undefined）：消费方判 `!== null`。
   */
  deserialize(raw) {
    if (!raw) return null;
    const p = normalizePosition(raw.position);
    if (!p) return null;
    return createState({
      position: p,
      yaw: Number.isFinite(raw.yaw) ? raw.yaw : 0,
      health: Number.isFinite(raw.health) ? raw.health : IGNIS.health,
    });
  },
});

// ==================== service ====================

/**
 * 焰魔的玩法入口（形状对齐 `DragonService`：spawn 编排 / damage / 只读查询）。
 *
 * ⚠️ **不 import three、不 import DOM**（同构层）。
 */
export class IgnisService {
  /**
   * @param {{entities: import('../entity-manager.js').EntityManager,
   *          world: object|null, seed: number}} deps
   *        `world` 用于召唤时扫描地表落点（可为 null —— 那样用兜底高度）
   */
  constructor({ entities, world, seed }) {
    this.entities = entities;
    this.world = world;
    this.seed = seed;
    /**
     * 寻路状态（v2.61）：缓存 + 每只焰魔的旅行记忆 + 决策周期累积器。
     * 与 `ZombieService._stepNavigator` 同一套构件，只是体型参数不同。
     */
    this._pathCache = new PathCache();
    /** @type {Map<string, object>} id → 导航记忆（`plan` 防等长路线横跳） */
    this._navMemory = new Map();
    /**
     * 曾经召唤过的焰魔 id 集合（v2.62）—— 只为 `overlapsAabb` 的**热路径短路**。
     *
     * ⚠️ **为什么不能直接遍历 `entities.entities()`**：`overlapsAabb` 被玩家物理的
     * `_collides()` 每帧调几十次（含二分回退），若每次都遍历全部实体（常态 20+ 丧尸）
     * + 分配一个数组，就是热路径上的无谓开销 —— 而场上最多只有 2 只焰魔。
     *
     * ⚠️ **不需要在 column 卸载时清理**：id 由 `ignisEntityIdFor(mapKey, slot)` 确定性派生，
     * 「走远 column 卸载 → 回来重召」复用同一个 id ⇒ Set 不累积；已 despawn 的 id
     * 留在 Set 里也无害（`entities.get(id)` 返回 null ⇒ 跳过）。尺寸上界 = 玩家去过的
     * 高台地带数 × slot 数（实际个位数）。
     * @type {Set<string>}
     */
    this._ignisIds = new Set();
    /** 决策周期累积器（秒） */
    this._navAccum = 0;
    /** @type {{decisions: number, blocked: number}} 只读诊断钩子 */
    this._navDebug = { decisions: 0, blocked: 0 };
  }

  /**
   * 寻路一拍：给所有「Agent 报告需要绕行」的焰魔跑 A\* + `decideStep`，把方向写进 state。
   *
   * ## 为什么要走服务层而不是 Agent 里算
   *
   * A\* 需要 `PathCache`（带去抖时效与路径前缀匹配）与 20Hz 节流 —— 两者都是**跨帧状态**，
   * 而 `BossAgent.update` 的契约是「只读 state + ctx，返回全新 state」，不得持有跨帧成员
   * （基类注释：Agent 实例无状态，同一个 Agent 服务多条龙是安全的）。
   * 服务层本就按实体隔离（`_pathCache` 按 agentId 分槽），职责也对：
   * 丧尸的 `_stepNavigator` 就在这里，两条寻路路径因此长得一样。
   *
   * ## `needsPath` 的消费语义
   *
   * 只给 `state.needsPath === true` 的焰魔算 —— 开阔地形上这个标志恒假 ⇒ 零 A\* 开销。
   * 规划完**不清标志**：标志由 Agent 下一帧根据「实际走开来没有」重算（它才是唯一有权
   * 判"走不通"的一方）。服务只负责「既然你说走不通，就把新方向写这里」。
   *
   * @param {number[]} playerPosition 玩家脚底 [x, y, z]
   * @param {number} [nowMs] 时间基准（`performance.now()` 口径）；缺省取全局。
   *        仅供 `PathCache` 的时效判定用 —— 传 `Date.now()` 会让缓存永不命中（差 17 亿毫秒）。
   */
  _stepNavigator(playerPosition, nowMs) {
    const world = this.world;
    if (!world || typeof world.isSolid !== 'function') return;
    // 格坐标可走性判据：**复用 `aabbCollidesAt`**（唯一权威，与物理同源）。
    // 一层台阶算可走：抬一格后也不碰撞即可（与物理 `_tryStepUp` 同口径）。
    // ⚠️ **不要自己用 `isSolid` 拼判据**：那会把「脚下是地面」误判成不可走，丧尸侧实测踩过。
    const isWalkable = (w, bx, y, bz) => {
      if (!aabbCollidesAt(w, bx + 0.5, y, bz + 0.5, IGNIS.halfWidth, IGNIS.height)) return true;
      const lifted = zombieStepUpY(y);
      return lifted - y <= IGNIS_AI.maxStep
        && !aabbCollidesAt(w, bx + 0.5, lifted, bz + 0.5, IGNIS.halfWidth, IGNIS.height);
    };
    /** 焰魔的可走性体型（高 3.25 ⇒ 占 4 层，与丧尸的 2 层不同） */
    const box = {
      halfWidth: IGNIS.halfWidth,
      height: IGNIS.height,
      maxStep: IGNIS_AI.maxStep,
    };
    const now = Number.isFinite(nowMs)
      ? nowMs
      : (typeof performance !== 'undefined' ? performance.now() : 0);

    const active = this.activeEntities();
    // 清理已消失焰魔的寻路残留（column 卸载走 `EntityManager.despawnColumn`，绕过本服务）
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
        // 偏角档位与局部避让共用 `IGNIS_STEERING`（角度与体型无关，与丧尸同值）
        steering: IGNIS_STEERING,
      });
      this._navDebug.decisions++;
      if (step.blocked) this._navDebug.blocked++;
      // 用 `createState` 重建（不原地改）：与 Agent 同一契约
      entity.state = createState({
        ...entity.state,
        navDir: step.blocked ? null : [step.vx, step.vz],
        navMode: step.mode,
      });
    }
  }

  /**
   * 每帧推进寻路（**必须在 `entities.update` 之前调**，与 `ZombieService.update` 同一帧序）。
   *
   * ⚠️ **必须早于物理**：Agent 本帧的移动意图要读 `state.navDir`。反序会让焰魔
   * 用上帧的寻路方向走一步 —— 形态是「绕行晚一拍」，在长墙拐角会明显抖动。
   *
   * @param {number} dt 秒
   * @param {{playerPosition?: number[], nowMs?: number}} [ctx]
   */
  update(dt, { playerPosition, nowMs } = {}) {
    if (!Array.isArray(playerPosition) || playerPosition.length < 3) return;
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    this._navAccum += step;
    if (this._navAccum < IGNIS_AI.navPeriod) return;
    this._navAccum = 0;
    this._stepNavigator(playerPosition, nowMs);
  }

  /** @returns {{decisions: number, blocked: number, cache: object}} 只读诊断（测试/调试用） */
  navDebugState() {
    return { ...this._navDebug, cache: this._pathCache.debugState() };
  }

  /**
   * @param {string} id
   * @returns {ReadonlyArray<{x: number, z: number}>|null} 只读测试钩子：该焰魔的缓存路径
   */
  cachedPathOf(id) { return this._pathCache.cachedPathOf(id); }

  /**
   * 在指定地图中心召唤一只焰魔（按 C 的 Boss2 入口）。
   *
   * ## 落点：从地图中心向下扫第一个能站立的 y
   *
   * ⚠️ **不能用 `findSpawnY`**：它从世界顶向下扫第一个非空方块，会把高台地带的
   * **巨型云**（y ∈ [54, 95]）当地面 —— CLAUDE.md 已记这个坑（`teleportToTarnZone`
   * 也为此改成了从 `plateauY` 向上扫描）。
   *
   * 这里的做法：从世界高处向下找「本格是空气 且 下方一格实心」的 y，且要求
   * 「本格与上一格（头顶）都是空气」（焰魔 3.25 格高，需要 4 格净空）。
   *
   * @param {string} mapKey 地图实例标识（`bossMapAt().key`）
   * @param {number} cx @param {number} cz 地图中心
   * @param {number} slot 名册槽位（焰魔 = 1）
   * @param {number} [refY] 参考高度（装配层传玩家 y）。给了就取**靠近它**的地面，
   *        避开空中结构；不给则取该列最低的可站位置。
   * @returns {{ok: true, id: string} | {ok: false, reason: 'limit'|'exists'}}
   */
  summon(mapKey, cx, cz, slot, refY) {
    if (this.entities.count(IGNIS_TYPE) >= IGNIS.maxAlive) {
      return { ok: false, reason: 'limit' };
    }
    const id = ignisEntityIdFor(mapKey, slot);
    if (this.entities.get(id)) return { ok: false, reason: 'exists' };

    // ⚠️ **参考高度必须传**：不传会让 `_findGroundY` 取「最低可站位置」，
    // 而高台地带的空中结构（巨云 / 拱洞 / 高台顶）与地面都可以站 —— 取最低通常对，
    // 但玩家若正在高台上，就会召到脚下的广场地面（相距 40 格）。
    // `refY` 由装配层（game.js）传入玩家 y —— entities/ 同构层**不得 import player/**。
    const y = this._findGroundY(cx, cz, refY);
    const entity = this.entities.spawn({
      id,
      type: IGNIS_TYPE,
      state: createState({
        position: [cx + 0.5, y, cz + 0.5],
        yaw: 0,
        health: IGNIS.health,
      }),
      // ⚠️ 临时实体（与飞龙同口径）：位置会变但仍是 Boss，进存档 = 第二份权威（红线 2）
      persistent: false,
    });
    if (!entity) return { ok: false, reason: 'exists' };
    this._ignisIds.add(id);   // 热路径短路用（见字段注释）
    return { ok: true, id };
  }

  /**
   * 找 `(cx, cz)` 列上可以站立的脚底 y。
   *
   * ## 从哪开始扫（这是踩过的真坑）
   *
   * ⚠️ **不能从世界顶部（y=96）往下扫**：高台地带里有**空中结构**（巨型云 y∈[54,95]、
   * 拱洞、高台顶）—— 从顶部扫到的第一个「有支撑 + 头顶净空」的位置往往在**半空平台**上。
   * 实测形态：玩家站在广场地面 y=5，焰魔被召到 y=36（拱洞顶），两者相距 31 格，
   * 画面里根本看不到它，而「召唤成功 / 实体存在 / 渲染器可见」全部为真。
   *
   * ## 做法：以**地图中心的地表**为基准，向上找最近的空位
   *
   * 先用 `findSpawnY` 拿到该列的地表（它会停在**地表**而不只是「第一个非空」——
   * 因为下面还要验证「头顶有 4 格净空」，悬空的云层/拱洞会被这一步排除）：
   * 1. 从 `WORLD_MAX−1` 往下找第一个**连续 4 格空气且其下为实心**的位置；
   * 2. 如果找到的位置高于「玩家所在高度 + maxSpawnRiseY」，就**继续往下找**；
   * 3. 都找不到时退回最下面那个可站位置。
   *
   * @param {number} cx @param {number} cz 整数列坐标
   * @param {number} [nearY] 参考高度（玩家所在 y / 地图中心地表）。给了就优先取**靠近它**的地面，
   *        避免落到空中结构上。
   * @returns {number} 保证有限的 y（找不到时返回 0）
   */
  _findGroundY(cx, cz, nearY) {
    const w = this.world;
    if (!w || typeof w.isSolid !== 'function') return 0;
    // 焰魔 3.25 高 ⇒ 需要 4 格净空（含脚底那一格之上的 3 格）
    const HEADROOM = 4;
    const TOP = 96;
    const BOTTOM = -32;
    /** 收集该列全部可站立位置（从高到低） */
    const candidates = [];
    for (let y = TOP; y > BOTTOM; y--) {
      if (w.isSolid(cx, y, cz)) continue;          // 本格被占
      if (!w.isSolid(cx, y - 1, cz)) continue;     // 下方不实心（悬空）
      let clear = true;
      for (let dy = 1; dy <= HEADROOM; dy++) {
        if (w.isSolid(cx, y + dy, cz)) { clear = false; break; }
      }
      if (clear) candidates.push(y);
    }
    if (candidates.length === 0) return 0;
    // 有参考高度 ⇒ 取离它最近的那个（同时避免空中结构）
    if (Number.isFinite(nearY)) {
      let best = candidates[0];
      let bestD = Math.abs(best - nearY);
      for (const y of candidates) {
        const d = Math.abs(y - nearY);
        if (d < bestD) { best = y; bestD = d; }
      }
      return best;
    }
    // 无参考高度 ⇒ 取**最低**的那个（最接近自然地表的那个，刻意避开空中结构）
    return candidates[candidates.length - 1];
  }

  /**
   * 给定一个**世界 AABB**，是否与任一存活焰魔的身体盒相交（v2.62 用户缺陷⑦）。
   *
   * ## 为什么在 service 而不是 player 侧算
   *
   * 玩家物理要「撞到焰魔就像撞到实心方块」（用户原文），但 `player/` **不得 import
   * `entities/`**（依赖方向）—— 故由装配层（game.js）把本 service 注入 `PlayerPhysics.ignises`，
   * 与 `minecarts` 完全同一手法。
   *
   * ## 两侧各自持有自己的尺寸权威（红线 1）
   *
   * 调用方（`physics.js`）传**自己的** `aabb()`（玩家尺寸权威在那边）；本方法只用
   * `ignisAabbFor(state)`（焰魔身体盒的唯一权威，含 yaw 旋转）。两边都不复制对方的量。
   *
   * ⚠️ **严格不等式**（贴面不算重叠，同 `PlayerPhysics.overlapsBlock` 口径）：用 `>=`
   * 会让「恰好贴着焰魔站」被当成重叠 ⇒ 玩家被二分回退推离，观感是「碰不到它」。
   *
   * ⚠️ **用身体盒（`IGNIS_CORE_OBB`）而不是碰撞盒（`IGNIS.halfWidth/height`）**：
   * 身体盒是「看得见的躯干」（半宽 0.83），碰撞盒是 1.0×3.25 的粗盒 —— 用后者会让
   * 玩家停在「离模型还有一截」的地方，看着像隔空被挡。
   *
   * @param {{minX:number,maxX:number,minY:number,maxY:number,minZ:number,maxZ:number}} box
   *        调用方给的世界 AABB（形状 = `PlayerPhysics.aabb()` 的返回值）
   * @returns {boolean}
   */
  overlapsAabb(box) {
    if (!box || this._ignisIds.size === 0) return false;
    // ⚠️ **热路径短路**（玩家物理 `_collides()` 每帧调几十次）：只遍历 `_ignisIds`
    //（尺寸 ≤ 玩家去过的高台地带数 × slot 数，实际个位数）+ O(1) 的 `entities.get`，
    // **不**遍历全部实体、**不**分配数组（`activeEntities()` 两者都做，那是给低频
    // 调用方用的）。已 despawn 的 id 留在 Set 里无害：`get` 返回 null ⇒ 跳过。
    for (const id of this._ignisIds) {
      const entity = this.entities.get(id);
      if (!entity) continue;
      const local = ignisAabbFor(entity.state);
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
   * 造成伤害。与 `ZombieService.damage` / `DragonService.damage` 同形状
   * （红闪 + health ≤ 0 即 despawn）。
   *
   * ⚠️ **时间基准必须是 `performance.now()`**（调用方负责）：`Date.now()` 与它相差约
   * 17 亿毫秒，会让 `nowMs < flashedUntil` 恒真 → **焰魔永久红闪、永不消退**。
   *
   * @param {string} id @param {number} amount @param {number} nowMs
   * @returns {{dead: boolean, health: number}|null} 未知 id / 非焰魔实体返回 null
   */
  damage(id, amount, nowMs) {
    const entity = this.entities.get(id);
    if (!entity || entity.type !== IGNIS_TYPE) return null;
    const state = entity.state;
    const health = state.health - (Number.isFinite(amount) ? amount : 0);
    const flashedUntil = (Number.isFinite(nowMs) ? nowMs : 0) + IGNIS.flashMs;
    // 经 createState 重建（不原地改）：原地改会让 state 与任何持有它的引用悄悄同步
    entity.state = createState({ ...state, health, flashedUntil });
    if (health <= 0) {
      this.entities.despawn(id, 'killed');
      this._forgetNavigation(id);
      return { dead: true, health };
    }
    return { dead: false, health };
  }

  /**
   * 回收某只焰魔的寻路残留（缓存条目 + 导航记忆）。
   *
   * ⚠️ **两条回收路径都必须调**（`damage` 的死亡分支与 `dispose`）：漏一条的形态是
   * `PathCache` 与 `_navMemory` 随「死了又召」单调增长，且旧条目会以同一个 id
   * （`ignisEntityIdFor` 是确定性的）继续命中 —— 去抖与记忆都带着上一条命的状态。
   *
   * @param {string} id
   */
  _forgetNavigation(id) {
    this._pathCache.forget(id);
    this._navMemory.delete(id);
  }

  /**
   * 全部存活的焰魔（数组快照，与 `DragonService.activeEntities` 同手法：
   * 调用方可能在遍历中调 `damage()` → despawn 改变底层集合，故返回快照而非迭代器）。
   * @returns {Array<import('../entity-manager.js').Entity>}
   */
  activeEntities() {
    const out = [];
    for (const entity of this.entities.entities()) {
      if (entity.type === IGNIS_TYPE) out.push(entity);
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
    this._ignisIds.clear();
  }
}
