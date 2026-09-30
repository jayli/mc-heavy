// src/entities/entity-manager.js — M5：动态实体 state 的唯一权威（M5 规格 §2）
//
// 同构层：**无 DOM、无 three、不新增 Worker**（`npm run check:arch` 静态门守）。
// 三份派生缓存全部可从 `_entities` 重建，**不是第二份逻辑真相**（红线 1）：
//   `_byColumn`（position 派生的 column 索引）/ `_generations`（同 id 的代数计数）/ 渲染 slot（在 render 层）。
//
// 关键不变式：
// ① 同 id 不得重复 spawn —— id 是唯一键，重复返回 null（不是覆盖，覆盖会让迟到回包命中错实例）；
// ② generation 随同一 id 的每次成功 spawn **单调递增且 despawn 后不重置** —— 任何异步消费者
//    （M6 的 WorkerPool AI 回包）必须回传 {id,generation}，代数不符即丢弃。这是红线 7 的
//    版本协议在实体侧的对应物：不打 epoch/防抖补丁，用代数直接判定过期。
// ③ 临时实体只在 Scheduler 最终卸载其所在 column 前回收（`despawnColumn`）；
//    **不另设「距离玩家 N 格销毁」的第二套生命周期真相**（相对 mc-lite 的有意架构调整）。
import { columnKeyOfPosition } from './entity-types.js';

/**
 * @typedef {{id: string, type: string, generation: number, persistent: boolean,
 *            state: object, frozen: boolean}} Entity
 */

export class EntityManager {
  constructor() {
    /** @type {Map<string, Entity>} 动态实体 state 的唯一权威 */
    this._entities = new Map();
    /** @type {Map<string, Set<string>>} columnKey → id 集合（由 position 派生） */
    this._byColumn = new Map();
    /** @type {Map<string, number>} id → 最后一次成功 spawn 的 generation（despawn 后保留） */
    this._generations = new Map();
    /** @type {Map<string, object>} type → definition */
    this._types = new Map();
  }

  /**
   * 注册实体类型。重复 type 抛错 —— 静默覆盖会让两个消费者拿到不同 definition
   * （M5 规格 §2「重复 type 抛错」）。
   * @param {string} type
   * @param {{create: Function, update: Function, raycastAabb: Function,
   *          serialize: Function, deserialize: Function}} definition
   */
  registerType(type, definition) {
    if (!type || typeof type !== 'string') throw new Error('EntityManager: type 必须是非空字符串');
    if (this._types.has(type)) throw new Error(`EntityManager: 类型 "${type}" 已注册`);
    for (const fn of ['create', 'update', 'raycastAabb', 'serialize', 'deserialize']) {
      if (typeof definition?.[fn] !== 'function') {
        throw new Error(`EntityManager: 类型 "${type}" 的 definition 缺少纯函数 ${fn}`);
      }
    }
    this._types.set(type, definition);
  }

  /**
   * 创建一个实体。仅在 type 已注册、id 未占用、`definition.create(state)` 返回合法 state 时成功。
   * 任何失败路径都**不产生部分副作用**（不写 Map、不写索引、不递增 generation）。
   * @param {{id: string, type: string, state: object, persistent?: boolean}} request
   * @returns {Entity|null}
   */
  spawn({ id, type, state, persistent = false }) {
    if (typeof id !== 'string' || id === '') return null;
    if (this._entities.has(id)) return null; // ①：id 是唯一键
    const definition = this._types.get(type);
    if (!definition) return null;
    const created = definition.create(state);
    if (!created) return null;
    const generation = (this._generations.get(id) || 0) + 1;
    this._generations.set(id, generation);
    const entity = { id, type, generation, persistent: !!persistent, state: created, frozen: false };
    this._entities.set(id, entity);
    this._indexColumn(entity);
    return entity;
  }

  /**
   * 销毁实体。**先失效 generation 再移除**（M5 规格 §3：临时实体卸载/死亡/dispose 必须先取消
   * 或失效其 generation）—— 反序会让在途异步回包在移除后的窗口里命中残留索引。
   *
   * 「失效」的实现 = 从 `_entities` 与派生索引中移除（任何 `{id,generation}` 回包都查不到实体），
   * 而 `_generations` 的**计数保留、绝不置负或重置** —— 它必须是单调递增的：同 id 重新 spawn 时
   * 继续 +1，于是旧代数的回包即使 id 又存在也匹配不上。把计数置 -1 之类的「失效标记」会破坏
   * 这条不变式（`(-1||0)+1 = 0` 反而小于上一代 → 旧回包被判为有效）。这是实测踩坑，勿照直觉改。
   * @param {string} id @param {string} reason @returns {boolean}
   */
  despawn(id, reason) {
    const entity = this._entities.get(id);
    if (!entity) return false;
    this._unindexColumn(entity);
    this._entities.delete(id); // 失效：任何 {id, generation} 回包都不再匹配
    this._onDespawned?.(entity, reason); // 渲染层/玩法侧的对称回收钩子（Game 装配时注入）
    return true;
  }

  /**
   * column 卸载前回收其中的**临时**实体（M5 规格 §2：Scheduler 最终卸载前调用）。
   * 持久实体不在这里回收 —— 它们走 `beginColumnUnload` 的两阶段冻结/保存/commit 流程，
   * 否则 snapshot 写盘失败就静默丢失（M5 规格 §3）。
   * @param {string} key @param {string} reason @returns {number} 回收数
   */
  despawnColumn(key, reason) {
    let n = 0;
    // entitiesInColumn 返回数组快照：despawn 会改动 _byColumn 集合，边遍历边删是安全的
    for (const entity of this.entitiesInColumn(key)) {
      if (entity.persistent) continue;
      if (this.despawn(entity.id, reason)) n++;
    }
    return n;
  }

  // ---------- M5：持久 snapshot 与两阶段卸载 ----------

  /**
   * 全部持久实体的最小 snapshot（M5 规格 §3：形状严格为 `{id,type,state}`）。
   * state 经 `definition.serialize` 归一化 —— 落库的是最小形状，不是运行时 state 的引用
   * （否则 IndexedDB 结构化克隆会带上运行时派生字段，且改 state 会污染已存 snapshot）。
   * @returns {Array<{id: string, type: string, state: object}>}
   */
  serializePersistent() {
    const out = [];
    for (const entity of this._entities.values()) {
      if (!entity.persistent) continue;
      const definition = this._types.get(entity.type);
      const state = definition.serialize(entity.state);
      if (!state) continue; // 不可序列化：跳过而不是存半个 snapshot
      out.push({ id: entity.id, type: entity.type, state });
    }
    return out;
  }

  /**
   * 恢复持久实体。**只恢复已注册、可反序列化且尚未存在的 snapshot**（M5 规格 §3）。
   * 任何非法条目忽略且不产生部分副作用 —— 半恢复会让 column ready 时的实体集合不确定。
   * @param {Array<{id: string, type: string, state: object}>} snapshots
   * @returns {{restored: number, skipped: number}}
   */
  restorePersistent(snapshots) {
    let restored = 0, skipped = 0;
    if (!Array.isArray(snapshots)) return { restored, skipped };
    for (const snapshot of snapshots) {
      if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.id !== 'string') { skipped++; continue; }
      if (this._entities.has(snapshot.id)) { skipped++; continue; } // 已存在 → 恰好恢复一次
      const definition = this._types.get(snapshot.type);
      if (!definition) { skipped++; continue; } // 未注册类型
      const state = definition.deserialize(snapshot.state);
      if (!state) { skipped++; continue; } // 非法 state
      // 恢复的一律是持久实体：临时实体不写盘，恢复成临时的会在下次卸载时永久丢失
      if (this.spawn({ id: snapshot.id, type: snapshot.type, state, persistent: true })) restored++;
      else skipped++;
    }
    return { restored, skipped };
  }

  /**
   * 两阶段卸载的**准备阶段**（M5 规格 §2/§3）。
   *
   * 语义：持久实体立即冻结（`update` 期间不再推进 state），从冻结 state 取 snapshot；
   * 临时实体在准备期间**仍保留**。调用方（Game 的 requested listener）把
   * `Persistence.saveEntities(snapshots)` 作为 `ready`，只有它成功后才允许下一帧的
   * 同步最终回收。
   *
   * 为什么必须冻结：snapshot 是写盘真相。若准备期间实体继续移动，写盘的 position 与
   * commit 时回收的 state 就不是同一份 —— 重入恢复出来的实体位置漂移，且无法判断哪份是对的。
   *
   * @param {string} key
   * @returns {{snapshots: Array<{id: string, type: string, state: object}>,
   *            commit: () => number, cancel: () => void}}
   */
  beginColumnUnload(key) {
    const frozen = [];
    const snapshots = [];
    for (const entity of this.entitiesInColumn(key)) {
      if (!entity.persistent) continue; // 临时实体不在准备阶段回收
      entity.frozen = true;
      frozen.push(entity);
      const definition = this._types.get(entity.type);
      const state = definition.serialize(entity.state);
      if (state) snapshots.push({ id: entity.id, type: entity.type, state });
    }

    let settled = false; // commit/cancel 只允许生效一次（两阶段协议的幂等保证）

    /**
     * 最终回收：**先失效 generation 再回收**（M5 规格 §2/§3）。
     * 顺序不可反 —— 反序会让在途异步回包在回收后的窗口里命中残留的派生索引。
     */
    const commit = () => {
      if (settled) return 0;
      settled = true;
      let n = 0;
      for (const entity of frozen) if (this.despawn(entity.id, 'column-unloaded')) n++;
      // 准备期间新进入该 column 的临时实体也要回收（它们在准备阶段被刻意保留）
      n += this.despawnColumn(key, 'column-unloaded');
      return n;
    };

    /** 解冻而不复制 state（M5 规格 §2：cancel 解冻，不复制 state） */
    const cancel = () => {
      if (settled) return;
      settled = true;
      for (const entity of frozen) {
        if (this._entities.get(entity.id) === entity) entity.frozen = false;
      }
    };

    return { snapshots, commit, cancel };
  }

  /** @param {string} id @returns {Entity|null} 只读查询；调用方不得写回 */
  get(id) { return this._entities.get(id) || null; }

  /** @param {string} type @returns {number} */
  count(type) {
    let n = 0;
    for (const entity of this._entities.values()) if (entity.type === type) n++;
    return n;
  }

  /** @returns {Iterable<Entity>} 仅供渲染层枚举 */
  entities() { return this._entities.values(); }

  /** @param {string} key @returns {Iterable<Entity>} 卸载协调的只读查询 */
  entitiesInColumn(key) {
    const ids = this._byColumn.get(key);
    if (!ids) return [];
    const out = [];
    for (const id of ids) {
      const entity = this._entities.get(id);
      if (entity) out.push(entity);
    }
    return out;
  }

  /**
   * 每帧推进：调 definition.update，并在 position 变化时迁移派生 column 索引。
   * 索引是**派生**数据 —— 这里重算而不是让调用方手动维护，否则跨 column 的实体会留在旧索引里，
   * 卸载时漏回收（M5 规格 §2「每次 update() 后重新定位发生跨 column 的实体」）。
   * @param {number} dt @param {object} [context]
   */
  update(dt, context) {
    for (const entity of [...this._entities.values()]) {
      if (entity.frozen) continue; // 卸载准备中的持久实体：state 冻结（M5 规格 §2）
      const definition = this._types.get(entity.type);
      const next = definition.update(entity, dt, context);
      if (!next) continue;
      const before = columnKeyOfPosition(entity.state.position);
      entity.state = next;
      this._migrateColumn(entity, before);
    }
  }

  /**
   * 派生 column 索引迁移（`update` / `applyAsyncPose` 两处共用）。
   * ⚠️ `reindexColumn` **不用本方法** —— 它的 beforeKey 来自 `_byColumn` 反查（索引里当前记的 key），
   * 而本方法的 beforeKey 来自「赋值前的 position」，两者语义不同。
   * @param {Entity} entity @param {string} beforeKey 赋值前的 column key
   */
  _migrateColumn(entity, beforeKey) {
    const after = columnKeyOfPosition(entity.state.position);
    if (beforeKey !== after) { this._unindexColumn(entity, beforeKey); this._indexColumn(entity, after); }
  }

  /**
   * 按实体**当前** state.position 重算派生 column 索引（跨 column 时迁移）。
   *
   * **为什么需要公开**：`EntityManager.update()` 只在 `definition.update` 返回新 state 时迁移索引。
   * 但玩法服务有时会在 update 循环**之外**改 state.position —— 矿车的 `applyDeferred()`
   * 把相向碰撞的车回弹到 `lastTrack`（可跨 column 边界），那条路径绕过 update →
   * 索引永久停在旧 column（且**不自愈**：车已 idle 不再动，下一帧 before===after 不触发迁移）。
   * 后果：旧 column 卸载时 `beginColumnUnload` 会命中这辆实际已离开的车 → 冻结 + snapshot +
   * despawn 它，而它真正所在的 column 可能仍加载 → **车在玩家眼前消失**。
   *
   * ⚠️ 与 `applyAsyncPose` 的区别：那个是「消费异步 worker 回包」（有 generation 门控、只写
   * position）；本方法是**同步、无 generation 校验**的索引校准 —— 调用方（玩法服务）在同一帧内
   * 持有实体并刚写完 state，不存在迟到回包问题。
   *
   * ⚠️ beforeKey 必须是**索引里当前记的 key**（从 `_byColumn` 反查），不是从 position 重算的
   * key —— 后者会让 before===after 恒成立、永不迁移。
   * @param {string} id @returns {boolean} false = 未知 id
   */
  reindexColumn(id) {
    const entity = this._entities.get(id);
    if (!entity) return false;
    const after = columnKeyOfPosition(entity.state.position);
    // 反查 id 当前挂在哪个 key 下（_byColumn 是 key → Set<id>）
    for (const [key, set] of this._byColumn) {
      if (set.has(id)) {
        if (key !== after) { this._unindexColumn(entity, key); this._indexColumn(entity, after); }
        return true;
      }
    }
    // 不在索引里（理论不可达，spawn 时必建索引）→ 直接建
    this._indexColumn(entity, after);
    return true;
  }

  /**
   * 消费异步回包（M6 WorkerPool AI 的接入点）。**代数不符即丢弃**（红线 7 版本协议）：
   * 迟到的 pose 不得改变已 despawn 的实例或同 id 的后续实例。
   * @param {{id: string, generation: number, position: number[]}} result
   * @returns {boolean} false = 过期/未知，调用方应丢弃
   */
  applyAsyncPose({ id, generation, position }) {
    const entity = this._entities.get(id);
    if (!entity) return false;
    if (entity.generation !== generation) return false;
    const definition = this._types.get(entity.type);
    const next = definition.create({ ...entity.state, position });
    if (!next) return false; // 非法 position 的回包同样丢弃，不污染 state
    const before = columnKeyOfPosition(entity.state.position);
    entity.state = next;
    this._migrateColumn(entity, before);
    return true;
  }

  /**
   * 实体 AABB 射线（**实体命中的唯一入口**，M5 规格 §2）。
   * 地形命中仍由 `raycastVoxel()` 决定 —— 本方法不读 world、不读 three mesh。
   * dir 在此归一化（slab 法的 t 才等于世界距离）。
   * @param {number[]} origin @param {number[]} dir @param {number} maxDist
   * @param {(entity: Entity) => boolean} [predicate]
   * @returns {null|{id: string, type: string, dist: number, point: number[]}}
   */
  raycast(origin, dir, maxDist, predicate) {
    const len = Math.hypot(dir[0], dir[1], dir[2]);
    if (!(len > 0) || !Number.isFinite(maxDist) || maxDist < 0) return null;
    const unit = [dir[0] / len, dir[1] / len, dir[2] / len];
    let best = null;
    for (const entity of this._entities.values()) {
      if (predicate && !predicate(entity)) continue;
      const definition = this._types.get(entity.type);
      const dist = definition.raycastAabb(entity.state, origin, unit, maxDist);
      if (dist === null || dist < 0 || dist > maxDist) continue;
      if (!best || dist < best.dist) best = { entity, dist };
    }
    if (!best) return null;
    const { entity, dist } = best;
    return {
      id: entity.id,
      type: entity.type,
      dist,
      point: [origin[0] + unit[0] * dist, origin[1] + unit[1] * dist, origin[2] + unit[2] * dist],
    };
  }

  // ---------- 派生 column 索引 ----------

  /** @param {Entity} entity @param {string} [key] */
  _indexColumn(entity, key = columnKeyOfPosition(entity.state.position)) {
    let set = this._byColumn.get(key);
    if (!set) { set = new Set(); this._byColumn.set(key, set); }
    set.add(entity.id);
  }

  /** @param {Entity} entity @param {string} [key] */
  _unindexColumn(entity, key = columnKeyOfPosition(entity.state.position)) {
    const set = this._byColumn.get(key);
    if (!set) return;
    set.delete(entity.id);
    if (set.size === 0) this._byColumn.delete(key); // 空集合不留：索引 size 即诊断口径
  }

  /**
   * 注入 despawn 钩子（Game 装配时接渲染层对称回收）。
   * 用注入而非 import render —— 本层是 Worker 同构层，不得依赖 render/three（依赖方向 §3）。
   * @param {(entity: Entity, reason: string) => void} fn
   */
  onDespawn(fn) { this._onDespawned = fn; }

  /** 只读诊断：派生索引里仍有实体的 column 数 */
  stats() {
    return {
      entities: this._entities.size,
      columns: this._byColumn.size,
      types: this._types.size,
    };
  }

  /**
   * 回收全部持久实体（`Game._discardEdits()` 调用）。
   *
   * 为什么与 edits 清理同属一个入口：持久实体是玩家放置的装置（未来炮塔/矿车），属「玩家改动」。
   * 换 seed / 删除缓存若不清它们 —— ① 旧世界的装置泄漏进新 seed（违反红线 2 确定性）；
   * ② `beforeunload → flushEntities()` 会把仍活着的持久实体序列化写回刚清空的 store，
   *    与 edits 的「只清库不清内存 → 写回」竞态同构（CLAUDE.md 活跃约束）。
   * 故必须先回收内存里的持久实体，再清库。临时实体不动（它们本就不写盘）。
   * @param {string} reason @returns {number} 回收数
   */
  despawnPersistent(reason) {
    let n = 0;
    for (const entity of [...this._entities.values()]) {
      if (!entity.persistent) continue;
      if (this.despawn(entity.id, reason)) n++;
    }
    return n;
  }

  /** 反向释放（Game.dispose 调用）：清全部 state 与派生缓存 */
  dispose() {
    for (const id of [...this._entities.keys()]) this.despawn(id, 'dispose');
    this._entities.clear();
    this._byColumn.clear();
    this._generations.clear();
    this._types.clear();
  }
}
