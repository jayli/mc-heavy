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
import { IGNIS_TYPE, IGNIS, IGNIS_CORE_OBB, ignisEntityIdFor } from './ignis-config.js';
import { IgnisBossAgent } from '../bosses/ignis-boss-agent.js';

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
  attackAnimT, attackCooldown, losTimer, losVisible, onGround, attackRequest,
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
    /** 攻击冷却剩余秒数 */
    attackCooldown: Number.isFinite(attackCooldown) ? attackCooldown : 0,
    /** 视线缓存倒计时（秒） */
    losTimer: Number.isFinite(losTimer) ? losTimer : 0,
    losVisible: losVisible === true,
    /** 本帧是否站在地面上（物理用，决定能否 step-up） */
    onGround: onGround === true,
    /**
     * ⚠️ **瞬态**：本帧要结算一次挥砍命中。由 game.js 在 `entities.update` 之后消费
     * （生成伤害），Agent 下一帧自动清成 null。
     *
     * 形状 `{at: [x,y,z], yaw: number}` —— `at` 是**焰魔身体位置**（不是玩家位置），
     * 因为命中判据是「玩家的水平距 + 相对角」由结算方算。
     */
    attackRequest: attackRequest || null,
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
  }

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
   * @returns {{ok: true, id: string} | {ok: false, reason: 'limit'|'exists'}}
   */
  summon(mapKey, cx, cz, slot) {
    if (this.entities.count(IGNIS_TYPE) >= IGNIS.maxAlive) {
      return { ok: false, reason: 'limit' };
    }
    const id = ignisEntityIdFor(mapKey, slot);
    if (this.entities.get(id)) return { ok: false, reason: 'exists' };

    const y = this._findGroundY(cx, cz);
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
   * 从世界顶向下扫，返回第一个「本格空气 + 下方实心 + 头顶 3 格也空气」的 y。
   * 找不到（空世界/全是方块）时返回 `WORLD_MAX_Y` 的下方兜底高度，**保证 y 是有限数**
   * （返回 NaN 会让实体出生在 NaN 位置 → 物理与索引全崩，且是静默的）。
   *
   * @param {number} cx @param {number} cz 整数列坐标
   * @returns {number}
   */
  _findGroundY(cx, cz) {
    const w = this.world;
    if (!w || typeof w.isSolid !== 'function') return 0;
    const top = 96;        // 与 WORLD_MAX_Y 同量级；多扫几格无害
    const bottom = -32;
    for (let y = top; y > bottom; y--) {
      if (w.isSolid(cx, y, cz)) continue;          // 本格被占，继续往下
      if (!w.isSolid(cx, y - 1, cz)) continue;     // 下方不实心（悬空），继续往下
      // 头顶需要有 4 格净空（焰魔 3.25 高）
      let clear = true;
      for (let dy = 1; dy <= 4; dy++) {
        if (w.isSolid(cx, y + dy, cz)) { clear = false; break; }
      }
      if (clear) return y;
    }
    // 兜底：站在世界底附近（空世界时走到这里）
    return 0;
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
      return { dead: true, health };
    }
    return { dead: false, health };
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
    }
  }
}
