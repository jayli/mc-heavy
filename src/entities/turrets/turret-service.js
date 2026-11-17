// src/entities/turrets/turret-service.js — M8 炮塔服务：全局索引 + 预检 + 原子放置
// 同构层：不得 import three（`tools/check-architecture.mjs` 静态门守）。
// **复用 M7 的方块锚定装置模式**（roadmap「M7 交付的可复用模式」）—— 与
// `zombie-nest-service.js` 逐方法同构，只改 kind / 上限来源 / 锚点形状。
//
// 职责边界（规格 §3）：
// - **全局索引**是派生对象，不是第二份权威（红线 1）—— 持久真相只有锚点 blockEntity；
//   索引只是「id → anchor/rotation」的查表，用于上限判定与 controller 归属。
// - 放置的全部写入经**一次** `WorldEditor.setBlocks()` 事务（11 格 + 锚点富状态同批），
//   失败时没有部分方块、没有 anchor、没有索引条目。
// - 不轮询 mesh、不维护影子方块表、不另开破坏路径。
import { TURRET } from './turret-config.js';
import { columnKeyAt } from '../../voxel/constants.js';

export class TurretService {
  /**
   * @param {{world: import('../../voxel/world-data.js').WorldData,
   *          editor: import('../../core/world-editor.js').WorldEditor,
   *          registry: ReturnType<import('../../voxel/block-registry.js').createRegistry>,
   *          blueprint: ReturnType<import('./turret-blueprint.js').createTurretBlueprint>,
   *          onPlaced?: (id: string, anchor: [number,number,number]) => void}} deps
   *        ⚠️ 与巢穴不同：**没有 `invalid-blueprint` 退化路径** —— 炮塔蓝图是代码生成
   *        （不 fetch JSON），不存在加载失败。
   *
   *        `onPlaced`（M7 同手法）：放置成功后回调，由 Game 注入「创建 controller」。
   *        **必须有这条路径** —— anchor column 此刻已加载，`onColumnReady` 早在放置前
   *        触发过了，不会再为新锚点触发一次 → 没有它则新炮塔永不工作。
   */
  constructor({ world, editor, registry, blueprint, onPlaced = null }) {
    this.world = world;
    this.editor = editor;
    this.registry = registry;
    this.blueprint = blueprint;
    this._onPlaced = onPlaced;
    /**
     * 派生全局索引：`Map<id, {anchor:[x,y,z], rotation:number}>`。
     * **只含 id/anchor/rotation** —— 不含 controller 引用、不含方块副本。
     * 上限判定用它的 size，**不能用已加载 controller 数量**：远处炮塔的 column 可能未加载
     * （无 controller），用 controller 数判上限会让玩家走远再回来就能无限放置。
     */
    this._index = new Map();
    /** 派生 controller 表：`Map<id, TurretController>` */
    this._controllers = new Map();
  }

  /** 全局索引条目数（上限判定的单一来源）。@returns {number} */
  count() { return this._index.size; }

  /** 只读 controller 表（测试/诊断接口）。@returns {ReadonlyMap<string, Object>} */
  controllers() { return this._controllers; }

  /**
   * 放置炮塔。**预检顺序**（位置合法性先于全局上限，照 M7）：
   * `bounds` → `occupied` → `player-overlap` → `limit`。
   * 理由：位置非法时报告位置原因更有行动价值（「这里已被占」比「你已达上限」更能解释
   * 为什么放不下去）；且三种位置原因互不掩盖，便于逐条断言。
   * 任何失败都在调 editor **之前**返回 —— 失败路径零世界写入。
   *
   * ⚠️ **origin 先归一到地面格**（`_groundOrigin`）：命中格是草/花时下沉一格，
   * 否则底座会落在「草格 +1」而悬空（用户 2026-11-18 报告）。归一在**服务层**而不是
   * `Player.placeBlock()`：`game.placeTurret()` 与背包分流是两个入口，写在 player 里
   * 只修一条（M7「两条放置路径一测一用」的同类撕裂）。
   *
   * @param {{origin:[number,number,number],
   *          playerAabb: {minX,maxX,minY,maxY,minZ,maxZ}|null, rotation?: number}} req
   * @returns {{ok:true, id:string, anchor:[number,number,number]} |
   *           {ok:false, reason:'limit'|'bounds'|'occupied'|'player-overlap'}}
   */
  place({ origin, playerAabb, rotation = 0 }) {
    // ① 归一 origin：命中格是地表植物（草/花/藤…）时下沉一格到它脚下的地面格。
    //
    // ⚠️ **这条是用户 2026-11-18 报告的「炮塔悬空」缺陷的根因修点**：主射线的命中判据是
    // 「非空气且非水即命中」⇒ 地面上长着一株草时命中的是**草格**，`placeBlock()` 把它当
    // origin 传进来，蓝图 `BASE_DY=1` 于是把底座放到「草格 +1」= 地面 +2 → 炮塔与地面之间
    // 空一格（实测 seed 12345 地面 (287,5,104)：有草底座 y=7 / 无草 y=6）。
    //
    // **只下沉一格**，不做「一路向下找实心」：后者会把叠放的植物/装饰一次穿透好几层，
    // 且会在水面上把炮塔沉到水底（`isPlant` 刻意不含水，见 block-registry）。
    // 下沉后的地面格本身仍可能是植物（连着两株），那属于「原地放置」的既有语义，不多管。
    const base = this._groundOrigin(origin);
    // ② bounds：任一格越界或目标 column 未加载
    if (!this.blueprint.inWorldBounds(base)) return { ok: false, reason: 'bounds' };
    const changes = this.blueprint.changesAt(base);
    for (const c of changes) {
      if (!this.world.hasColumn(Math.floor(c.x / 16), Math.floor(c.z / 16))) {
        return { ok: false, reason: 'bounds' };
      }
    }
    // ③ occupied：蓝图位置必须是空气**或可被覆盖的植物**。
    // ⚠️ 旧判据是「11 格全为空气」⇒ 3×3 底座里只要有一格长草，整座炮塔就放不下去
    // （玩家看到的是「点了没反应」）。植物无碰撞、可被方块覆盖，与单格放置同口径。
    for (const c of changes) {
      const id = this.world.getBlockId(c.x, c.y, c.z);
      if (id !== 0 && !this.registry.isPlant(id)) return { ok: false, reason: 'occupied' };
    }
    // ④ player-overlap：结构 AABB 与玩家 AABB 相交（不得把玩家埋进结构里）
    if (playerAabb) {
      const b = this.blueprint.boundsAt(base);
      if (playerAabb.minX < b.maxX && playerAabb.maxX > b.minX &&
          playerAabb.minY < b.maxY && playerAabb.maxY > b.minY &&
          playerAabb.minZ < b.maxZ && playerAabb.maxZ > b.minZ) {
        return { ok: false, reason: 'player-overlap' };
      }
    }
    // ⑤ limit：全局最多 20 个（跨 column 卸载与重启仍有效 —— 索引来自 edits store）
    if (this._index.size >= TURRET.maxTurrets) return { ok: false, reason: 'limit' };

    // ---- 全部预检通过：构造一次事务 ----
    const critical = this.blueprint.criticalAt(base);
    const id = this._nextId();
    const anchorEntity = {
      kind: 'turret',
      id,
      origin: [base[0], base[1], base[2]],
      critical: { x: critical.x, y: critical.y, z: critical.z, id: critical.id },
      // 放置时的默认朝向（无目标时回归它）。⚠️ 这是装置运行态，存在 blockEntity 里 ——
      // 与「单格方块的 meta 朝向不看玩家 yaw」那条约束不是同一事实（规格 §3.1）。
      rotation,
      lastFireAt: 0,
    };
    // 只在 critical change 上附 blockEntity —— 其余 10 个结构方块不是锚点
    const rawChanges = changes.map((c) => (
      (c.x === critical.x && c.y === critical.y && c.z === critical.z)
        ? { ...c, blockEntity: anchorEntity } : c
    ));
    // 预检前的 id/meta，供事务未完整成功时回滚（M7 同手法）
    const prior = rawChanges.map((c) => ({
      x: c.x, y: c.y, z: c.z,
      id: this.world.getBlockId(c.x, c.y, c.z),
      meta: this.world.getBlockMeta(c.x, c.y, c.z),
    }));

    const report = this.editor.setBlocks(rawChanges);
    if (report.changes.length !== rawChanges.length || report.skipped.length !== 0) {
      // 实现 bug（预检已保证全空且 column 已加载，不该有 skip）：回滚到预检前状态、
      // 不建索引 —— 绝不能留下「半个炮塔」。
      this.editor.setBlocks(prior);
      return { ok: false, reason: 'bounds' };
    }

    this._index.set(id, { anchor: [critical.x, critical.y, critical.z], rotation });
    // 放置成功 → 通知装配层创建 controller（见构造函数注释：没有这条路径则新炮塔永不工作）
    if (this._onPlaced) this._onPlaced(id, [critical.x, critical.y, critical.z]);
    return { ok: true, id, anchor: [critical.x, critical.y, critical.z] };
  }

  /**
   * origin 归一：命中格是地表植物时取它脚下那一格当地面。
   *
   * **只下沉一格**（不循环）：循环会穿透叠放的多层植物，把炮塔放到远低于玩家瞄准的位置。
   * 判据走 `registry.isPlant`（派生自 solid/cull 两张表）—— 不在此写植物名字白名单，
   * 否则新增植物（如 v3.12 的 `bush_grass`）会静默漏掉。
   * @param {[number,number,number]} origin @returns {[number,number,number]}
   */
  _groundOrigin(origin) {
    const [x, y, z] = origin;
    return this.registry.isPlant(this.world.getBlockId(x, y, z)) ? [x, y - 1, z] : [x, y, z];
  }

  /**
   * 删除炮塔：删锚点 blockEntity + 移除派生索引 + 注销 controller。
   * **绝不扫描未加载 column / mesh / controller 列表来判定全局数量**。
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
   * 从存档恢复派生全局索引。锚点坐标从 blockEntity 的 `critical` 派生 ——
   * 持久真相在 edits store，不在已加载 column（跨 column 卸载与重启的上限有效性靠它）。
   * ⚠️ **hydrate 是 `clear()+重建`**：调用前必须先 `flushNow()`，否则库里没锚点 →
   * 索引被清成 0（真实重启路径本就是 flush → reload → hydrate）。
   * @param {import('../../save/persistence.js').Persistence} persistence
   * @returns {Promise<void>}
   */
  async hydrate(persistence) {
    const anchors = await persistence.listBlockEntities('turret');
    this._index.clear();
    for (const { blockEntity } of anchors) {
      if (!blockEntity?.critical) continue;
      const { x, y, z } = blockEntity.critical;
      this._index.set(blockEntity.id, { anchor: [x, y, z], rotation: blockEntity.rotation ?? 0 });
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
      const n = Number.parseInt(id.replace(/^turret-/, ''), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return `turret-${max + 1}`;
  }

  /** 登记/注销派生 controller（column 生命周期由 Game 调用）。null = 注销 */
  setController(id, controller) {
    if (controller === null || controller === undefined) this._controllers.delete(id);
    else this._controllers.set(id, controller);
  }

  /** 索引是否含该 id（`onColumnReady` 补登记前判重用）。@returns {boolean} */
  hasIndex(id) { return this._index.has(id); }

  /** 补登记锚点（hydrate 前就 ready 的 column 走这条路径）。 */
  registerAnchor(id, anchor, rotation = 0) { this._index.set(id, { anchor, rotation }); }

  /** @returns {[number,number,number]|null} */
  anchorOf(id) { const e = this._index.get(id); return e ? e.anchor : null; }

  /** @returns {number} 未知 id 返回 0 */
  rotationOf(id) { const e = this._index.get(id); return e ? e.rotation : 0; }

  /** 锚点所属 column key（卸载回收时按 key 匹配 controller）。@returns {string|null} */
  anchorColumnKey(id) {
    const e = this._index.get(id);
    return e ? columnKeyAt(e.anchor[0], e.anchor[2]) : null;
  }
}
