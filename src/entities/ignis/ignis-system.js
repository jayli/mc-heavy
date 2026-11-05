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

/** 合法的 mode 取值（其余一律回落 `idle`） */
const MODES = Object.freeze(['idle', 'chase', 'attack']);

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
  }
}
