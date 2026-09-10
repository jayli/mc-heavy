// src/entities/zombie-nests/zombie-nest-service.js — M7 巢穴服务：全局索引 + 预检 + 原子放置
// Worker 同构：本文件不得 import three（同构层，见 tools/check-architecture.mjs）。
//
// 职责边界（M7 规格 §1/§2）：
// - **全局索引**是派生对象，不是第二份权威（红线 1）—— 持久真相只有锚点 blockEntity；
//   索引只是「id → anchor」的查表，用于上限判定与 controller 归属。
// - 放置的全部写入经**一次** `WorldEditor.setBlocks()` 事务（结构 38 格 + 锚点富状态同批），
//   失败时没有部分方块、没有 anchor、没有索引条目（M7 规格 §2）。
// - 本服务**不轮询 mesh、不维护影子方块表、不另开破坏路径**（M7 规格 §1）。
import { NEST } from './nest-config.js';
import { columnKeyAt } from '../../voxel/constants.js';

export class ZombieNestService {
  /**
   * @param {{world: import('../../voxel/world-data.js').WorldData,
   *          editor: import('../../core/world-editor.js').WorldEditor,
   *          registry: ReturnType<import('../../voxel/block-registry.js').createRegistry>,
   *          blueprint: ReturnType<import('./nest-blueprint.js').parseNestBlueprint>|null,
   *          onPlaced?: (id: string, anchor: [number, number, number]) => void}} deps
   *        blueprint 为 null = 加载失败的退化路径 → place() 一律返回 'invalid-blueprint'。
   *
   *        `onPlaced`（M7）：放置成功后回调，由 Game 注入「创建 controller」。
   *        **必须有这条路径** —— anchor column 此刻**已经加载**，而 `onColumnReady` 在
   *        column 加载时就触发过了（那时还没有锚点）→ 没人创建 controller →
   *        巢穴方块全写对了、anchor 也在，但**永不刷怪**（实测：controllers.size 恒 0）。
   *        注入回调而非让 service 直接造 controller —— 同构层不得反向依赖渲染/装配层
   *        （依赖方向 §3，与 `onInvalidated` 同手法）。
   */
  constructor({ world, editor, registry, blueprint, onPlaced = null }) {
    this.world = world;
    this.editor = editor;
    this.registry = registry;
    this.blueprint = blueprint;
    this._onPlaced = onPlaced;
    /**
     * 派生全局索引：`Map<id, {anchor:[x,y,z]}>`。
     * **只含 id/anchor**（M7 规格 §2）—— 不含 controller 引用、不含方块副本。
     * 上限判定用它的 size，**不能用已加载 controller 数量**：远处巢穴的 column 可能未加载
     * （无 controller），用 controller 数判上限会让玩家走远再回来就能无限放巢穴。
     */
    this._index = new Map();
    /** 派生 controller 表（Task 3 接线）：`Map<id, ZombieNestController>` */
    this._controllers = new Map();
  }

  /**
   * 全局索引条目数（上限判定的单一来源）。只读测试/诊断接口 —— 与规格 §2 的四个公开方法并列。
   * @returns {number}
   */
  count() { return this._index.size; }

  /**
   * 只读 controller 表（M7 规格 §2 的测试接口）。Task 3 由 column 生命周期填充。
   * @returns {ReadonlyMap<string, Object>}
   */
  controllers() { return this._controllers; }

  /**
   * 放置巢穴：预检 → 一次事务写入 → 更新派生索引。
   *
   * **预检顺序**（位置合法性先于全局上限）：`invalid-blueprint` → `bounds` → `occupied` →
   * `player-overlap` → `limit`。理由：位置非法时报告位置原因更有行动价值（「这里已被占」
   * 比「你已达上限」更能解释为什么放不下去）；且三种位置原因互不掩盖，便于逐条断言。
   * 任何失败都在调用 editor **之前**返回固定 reason —— 失败路径零世界写入（M7 规格 §3）。
   *
   * @param {{origin: [number, number, number],
   *          playerAabb: {minX,maxX,minY,maxY,minZ,maxZ}|null}} req
   * @returns {{ok: true, id: string, anchor: [number, number, number]} |
   *           {ok: false, reason: 'limit'|'bounds'|'occupied'|'player-overlap'|'invalid-blueprint'}}
   */
  place({ origin, playerAabb }) {
    if (!this.blueprint) return { ok: false, reason: 'invalid-blueprint' };

    // ① bounds：结构任一格落在世界高度之外，或目标 column 未加载（不得写世界）
    if (!this.blueprint.inWorldBounds(origin)) return { ok: false, reason: 'bounds' };
    const changes = this.blueprint.changesAt(origin);
    for (const c of changes) {
      if (!this.world.hasColumn(Math.floor(c.x / 16), Math.floor(c.z / 16))) {
        return { ok: false, reason: 'bounds' };
      }
    }

    // ② occupied：所有蓝图位置必须为空
    for (const c of changes) {
      if (this.world.getBlockId(c.x, c.y, c.z) !== 0) return { ok: false, reason: 'occupied' };
    }

    // ③ player-overlap：结构 AABB 与玩家 AABB 相交（不得把玩家埋进结构里）
    if (playerAabb) {
      const b = this.blueprint.boundsAt(origin);
      if (playerAabb.minX < b.maxX && playerAabb.maxX > b.minX &&
          playerAabb.minY < b.maxY && playerAabb.maxY > b.minY &&
          playerAabb.minZ < b.maxZ && playerAabb.maxZ > b.minZ) {
        return { ok: false, reason: 'player-overlap' };
      }
    }

    // ④ limit：全局最多 8 个（跨 column 卸载与重启仍有效）
    if (this._index.size >= NEST.maxNests) return { ok: false, reason: 'limit' };

    // ---- 全部预检通过：构造一次事务 ----
    const critical = this.blueprint.criticalAt(origin);
    const id = this._nextId();
    const anchorEntity = {
      kind: 'zombie-nest',
      id,
      origin: [origin[0], origin[1], origin[2]],
      critical: { x: critical.x, y: critical.y, z: critical.z, id: critical.id },
      lastSpawnAt: 0,
    };
    // 只在 critical change 上附 blockEntity —— 其余 37 个结构方块不是锚点
    const rawChanges = changes.map((c) => {
      if (c.x === critical.x && c.y === critical.y && c.z === critical.z) {
        return { ...c, blockEntity: anchorEntity };
      }
      return c;
    });
    // 预检前的 id/meta，供事务未完整成功时回滚（M7 规格 §2）
    const prior = rawChanges.map((c) => ({
      x: c.x, y: c.y, z: c.z,
      id: this.world.getBlockId(c.x, c.y, c.z),
      meta: this.world.getBlockMeta(c.x, c.y, c.z),
    }));

    const report = this.editor.setBlocks(rawChanges);
    if (report.changes.length !== rawChanges.length || report.skipped.length !== 0) {
      // 实现 bug（预检已保证全空且 column 已加载，不该有 skip）：回滚到预检前状态，
      // 不建索引 —— 绝不能留下「半个巢穴」（M7 规格 §2）。
      this.editor.setBlocks(prior);
      return { ok: false, reason: 'invalid-blueprint' };
    }

    this._index.set(id, { anchor: [critical.x, critical.y, critical.z] });
    // 放置成功 → 通知装配层创建 controller（见构造函数注释：没有这条路径则新巢穴永不刷怪）
    if (this._onPlaced) this._onPlaced(id, [critical.x, critical.y, critical.z]);
    return { ok: true, id, anchor: [critical.x, critical.y, critical.z] };
  }

  /**
   * 删除巢穴：删锚点 blockEntity + 移除派生索引 + 销毁 controller。
   * **绝不扫描未加载 column / mesh / controller 列表来判定全局数量**（M7 规格 §2）。
   * @param {string} id @returns {boolean} 不存在返回 false
   */
  destroy(id) {
    const entry = this._index.get(id);
    if (!entry) return false;
    const [x, y, z] = entry.anchor;
    this.editor.setBlockEntity({ x, y, z, value: null });
    this._index.delete(id);
    this._controllers.delete(id);
    return true;
  }

  /**
   * 从存档恢复派生全局索引（只含 id/anchor）。跨 column 卸载与重启的上限有效性靠它。
   * 锚点坐标从 blockEntity 的 `critical` 派生 —— 持久真相在 edits store，不在已加载 column。
   * @param {import('../../save/persistence.js').Persistence} persistence
   * @returns {Promise<void>}
   */
  async hydrate(persistence) {
    const anchors = await persistence.listBlockEntities('zombie-nest');
    this._index.clear();
    for (const { blockEntity } of anchors) {
      if (!blockEntity?.critical) continue;
      const { x, y, z } = blockEntity.critical;
      this._index.set(blockEntity.id, { anchor: [x, y, z] });
    }
  }

  /**
   * 生成确定性 id。**不用 `Math.random()`**（红线 2：同 seed 两次生成须一致）。
   * 从现有索引里取最大数字后缀 +1 —— hydrate 后同样口径，故重启不会产生 id 冲突。
   * @returns {string}
   */
  _nextId() {
    let max = 0;
    for (const id of this._index.keys()) {
      const n = Number.parseInt(id.replace(/^nest-/, ''), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return `nest-${max + 1}`;
  }

  /**
   * 登记/注销 controller（Task 3 由 Game 的 column 生命周期调用）。
   * controller 只在 anchor column 已加载时存在；column 卸载时注销 controller 但**保留索引**。
   * @param {string} id @param {Object|null} controller
   */
  setController(id, controller) {
    if (controller === null || controller === undefined) this._controllers.delete(id);
    else this._controllers.set(id, controller);
  }

  /**
   * 该 id 是否已在全局索引里（Game 的 column ready 路径用）。
   *
   * 为什么需要它：hydrate 在 `Game.start` 里跑，但**早于它的 column 可能已经 ready**
   * （出生点 column 在 hydrate 之前就加载了）。那条路径要判断「索引里有没有这个锚点」，
   * 不该伸手进 `_index` 私有字段 —— 越界访问会让封装失效，且改名即崩。
   * @param {string} id @returns {boolean}
   */
  hasIndex(id) { return this._index.has(id); }

  /**
   * 补登记一个锚点（hydrate 前就 ready 的 column 用）。
   * @param {string} id @param {[number, number, number]} anchor
   */
  registerAnchor(id, anchor) { this._index.set(id, { anchor }); }

  /** 锚点所在 column key（controller 归属判定用） */
  anchorColumnKey(id) {
    const entry = this._index.get(id);
    if (!entry) return null;
    return columnKeyAt(entry.anchor[0], entry.anchor[2]);
  }

  /**
   * 锚点坐标 `[x,y,z]`（装配层据此重读 blockEntity）。未登记返回 null。
   * @param {string} id @returns {[number, number, number]|null}
   */
  anchorOf(id) {
    const entry = this._index.get(id);
    return entry ? entry.anchor : null;
  }
}
