// src/entities/zombie-nests/zombie-nest-controller.js — M7 巢穴控制器：增量失效 + 定时刷怪
// Worker 同构：本文件不得 import three（同构层，见 tools/check-architecture.mjs）。
//
// 职责边界（M7 规格 §1/§2）：
// - **只在 anchor column 已加载时存在** —— 它是派生对象，不是持久状态。column 卸载即销毁，
//   再次加载后从 blockEntity 恢复（`lastSpawnAt` 不重置）。
// - 失效判定订阅 M4 的 `block-changed` **增量事件**，不轮询 mesh、不维护影子方块表
//   （mc-lite 是每 30 帧轮询完整性检查，本仓库改走事件 —— 有意偏离，见下方注释）。
// - 刷怪经 M6 `ZombieService.spawn()`，不另开实体生成路径。
import { NEST } from './nest-config.js';

export class ZombieNestController {
  /**
   * @param {{world: import('../../voxel/world-data.js').WorldData,
   *          zombies: {spawn: (position: number[], opts?: {source?: string}) => string|null},
   *          editor: import('../../core/world-editor.js').WorldEditor,
   *          anchor: {kind: string, id: string, origin: number[],
   *                   critical: {x: number, y: number, z: number, id: number}, lastSpawnAt: number},
   *          onInvalidated?: (id: string) => void}} deps
   *        `onInvalidated` 由 Game 注入 `(id) => nests.destroy(id)`。注入而非直接持有 service
   *        引用 —— 与本仓库既有惯例一致（`isModal` / `onSpawnZombie` / `damage` 都是注入），
   *        且让 controller 可独立单测（不必造完整 service fixture）。缺省 null → 只上报不删锚点。
   */
  constructor({ world, zombies, editor, anchor, onInvalidated = null, soldiers = null }) {
    this.world = world;
    this.zombies = zombies;
    /**
     * 士兵服务（士兵 Epic）。**可选**：缺省 null ⇒ 退化为只产丧尸。
     * ⚠️ 既有 20 余条单测的 fake 只有 `zombies`，不传 soldiers 必须逐位回到旧行为。
     */
    this.soldiers = soldiers;
    this.editor = editor;
    this.anchor = anchor;
    this._onInvalidated = onInvalidated;
    /**
     * 交替指针（士兵 Epic）。**派生节奏，不入 blockEntity**：
     * column 卸载后从 0 重开可接受；写进存档会让 anchor 多一个字段且要迁移旧档。
     */
    this._spawnIndex = 0;
    /** 最近一次刷怪尝试时刻（ms，performance 基准）。与 anchor.lastSpawnAt 同源同步。 */
    this.lastSpawnAt = anchor?.lastSpawnAt ?? 0;
    this.id = anchor?.id ?? null;
    this._invalidated = false;
  }

  /**
   * 增量失效判定（M7 规格 §1）。
   *
   * 判据 = **坐标覆盖关键格且 `newId !== critical.id`** —— 不依赖 `oldBlockEntity` 字段：
   * 徒手挖掉、M4 武器破坏、未来 TNT 批量编辑走的是同一条 setBlock/setBlocks，三者产生的
   * change 都带同样的坐标与 newId，故必然同义（这正是规格 §1 要求的「同一失效语义」）。
   *
   * ⚠️ **同格写回同 id 不得失效**：巢穴每次刷怪都用 `editor.setBlockEntity` 写回 `lastSpawnAt`。
   * 若判定只看「坐标覆盖关键格」，自己的时钟写回就会把巢穴杀掉。故必须比 `newId`。
   *
   * mc-lite 是每 30 帧轮询 `getBlock(criticalBlock)` 做完整性检查（`ZombieNest.js:54-70`）；
   * 本仓库改走增量事件 —— **有意偏离**：轮询在主线程是常驻开销且失效有延迟（最多 30 帧），
   * 而事件路径零常驻开销、破坏当帧即失效（M7 规格 §1「禁止轮询 mesh」）。
   *
   * @param {{type: 'block-changed', changes: Array<{x: number, y: number, z: number, newId: number}>}} event
   */
  onWorldChange(event) {
    if (this._invalidated) return;
    const critical = this.anchor?.critical;
    if (!critical) return;
    for (const change of event?.changes || []) {
      if (change.x !== critical.x || change.y !== critical.y || change.z !== critical.z) continue;
      if (change.newId === critical.id) continue; // 同格同 id（纯 entity 写回）→ 不失效
      this._invalidated = true;
      if (this._onInvalidated) this._onInvalidated(this.id);
      return;
    }
  }

  /**
   * 定时刷怪（每帧调；内部 8 秒节流）。
   *
   * **时间基准必须是 `performance.now()`**（帧循环 `setAnimationLoop` 回调的 `nowMs`）——
   * 不得用 `Date.now()`：两者相差约 17 亿毫秒，混用会让到期判定恒真 → 每帧都刷怪
   * （CLAUDE.md 活跃约束，M6 已实测踩坑）。mc-lite 用的是 `Date.now()`（`ZombieNest.js:110`），
   * 本仓库按自身口径改为 performance 基准。
   *
   * **无论成功/失败/满额都写回 `lastSpawnAt`**（mc-lite 同口径 `:117-131`）——
   * 否则无合法位置或全局满额时会退化成每帧重试搜索（48 格 × 每帧）。
   *
   * @param {number} nowMs performance.now() 基准
   * @returns {boolean} 本次是否成功刷出一只
   */
  update(nowMs) {
    if (this._invalidated) return false;
    if (nowMs - this.lastSpawnAt < NEST.spawnIntervalMs) return false;
    const position = this._findSpawnPosition();
    let spawned = false;
    if (position) spawned = this._spawnAlternating(position);
    this._writeBackSpawnClock(nowMs);
    return spawned;
  }

  /**
   * 交替产出 + 满额回落（士兵 Epic，用户：「soldier 足够多了就只好生成丧尸」）。
   *
   * 顺序：按 `_spawnIndex` 取首选 → 试 spawn → 返回 null 则试另一种 → 都 null 则不产出。
   * ⚠️ **`_spawnIndex` 只在真的产出一只后推进**：满额那拍不推进，否则恢复后节奏错乱。
   * ⚠️ **`soldiers` 缺省时首选恒为 zombie**（既有 fixture 零回归）。
   * ⚠️ 落点扫描与 8 秒节流一行未改（冻结口径）。
   *
   * @param {number[]} position @returns {boolean}
   */
  _spawnAlternating(position) {
    const order = NEST.spawnOrder;
    const services = { soldier: this.soldiers, zombie: this.zombies };
    // 未注入 soldiers ⇒ 只留 zombie（退化为旧行为）
    const usable = order.filter((kind) => services[kind]);
    if (usable.length === 0) return false;
    const first = usable[this._spawnIndex % usable.length];
    const candidates = [first, ...usable.filter((k) => k !== first)];
    for (const kind of candidates) {
      // M6 口径：spawn 返回 `string | null`（满额/落点非法 → null），不是 false
      if (services[kind].spawn(position, { source: this.id }) !== null) {
        this._spawnIndex = (this._spawnIndex + 1) % usable.length;
        return true;
      }
    }
    return false;
  }

  /**
   * 查找首个合法刷怪位置（mc-lite `findSpawnPosition` `:144-162` 语义照搬）。
   *
   * 顺序固定：外层八个偏移（四个距离 3 的正交 → 四个距离 2√2 的对角），内层
   * `dy = 3..-2` **六层**降序。首个合法位置即返回 —— 改顺序会改变刷怪点分布。
   * 合法性三判据（`isValidSpawnPosition` `:169-184`）：脚格空 + 头格空（两格空腔）+ 脚下 solid。
   *
   * @returns {number[]|null} `[baseX + 0.5, footY, baseZ + 0.5]`
   */
  _findSpawnPosition() {
    const origin = this.anchor?.origin;
    if (!origin) return null;
    for (const offset of NEST.spawnOffsets) {
      const baseX = origin[0] + offset.x;
      const baseZ = origin[2] + offset.z;
      for (let dy = NEST.spawnDyTop; dy >= NEST.spawnDyBottom; dy--) {
        const footY = origin[1] + 1 + dy;
        if (this.world.getBlockId(baseX, footY, baseZ) !== 0) continue;        // 脚格被占
        if (this.world.getBlockId(baseX, footY + 1, baseZ) !== 0) continue;    // 头格被占
        if (!this.world.isSolid(baseX, footY - 1, baseZ)) continue;            // 脚下无支撑
        return [baseX + 0.5, footY, baseZ + 0.5];
      }
    }
    return null;
  }

  /**
   * 写回 `lastSpawnAt`（纯 entity 写：不 bump version、不 remesh/light）。
   *
   * 构造**新对象**而非原地改 `this.anchor`：原地改会让 `column.blockEntities` 与
   * `column.edits` 持有的同一引用被悄悄改写（两处状态看似独立实则共享，红线 1 精神）。
   * 新对象必须保留 kind/id/origin/critical —— 只换 lastSpawnAt，漏字段会让锚点失真。
   * @param {number} nowMs
   */
  _writeBackSpawnClock(nowMs) {
    this.lastSpawnAt = nowMs;
    const value = { ...this.anchor, lastSpawnAt: nowMs };
    this.anchor = value;
    const { x, y, z } = this.anchor.critical;
    this.editor.setBlockEntity({ x, y, z, value });
  }

  /** 销毁（column 卸载 / 巢穴失效）。controller 只释放自己的状态，不删锚点 —— 那是 service.destroy 的事。 */
  dispose() {
    this._invalidated = true;
    this.world = null;
    this.zombies = null;
    this.soldiers = null;
    this.editor = null;
  }
}
