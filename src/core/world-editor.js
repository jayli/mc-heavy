// src/core/world-editor.js — WorldEditor：主线程世界编辑协调器（M4-0，设计文档 §4.5.3 / M4 规格 §4.1）
// 职责仅是协调已有唯一权威数据（WorldData typed array）与派生重建（remesh / light / 事件）。
// 不保存体素副本，不持有 event log、light 值或 world snapshot —— 红线 1。
// 它是玩家挖放、MAG7 批量破坏与未来 TNT/爆炸的共享入口：世界写入没有第二条路径。
// Worker 同构无关：本模块只在主线程运行（依赖 Scheduler），不得被 Worker import。
import { WORLD_MIN_Y, WORLD_MAX_Y, columnKey } from '../voxel/constants.js';

/**
 * @typedef {{x: number, y: number, z: number, id: number, meta?: number, blockEntity?: Object}} BlockChangeRequest
 * @typedef {{x: number, y: number, z: number, oldId: number, oldMeta: number,
 *            newId: number, newMeta: number, oldBlockEntity?: Object, newBlockEntity?: Object}} BlockChange
 * @typedef {{changes: BlockChange[], affected: Array<{cx: number, cz: number, sy: number}>,
 *            changedColumns: string[], skipped: Array<BlockChangeRequest & {reason: string}>}} EditReport
 */

export class WorldEditor {
  /**
   * @param {{world: import('../voxel/world-data.js').WorldData,
   *          scheduler: import('./scheduler.js').Scheduler,
   *          persistence?: import('../save/persistence.js').Persistence}} deps
   *        persistence 可选：`setBlockEntity`（纯 entity 写，不触发 remesh）需靠它把 anchor
   *        记入 edits 并调度落盘。缺省时 setBlockEntity 仍写内存但不调度 flush（测试 fixture）。
   */
  constructor({ world, scheduler, persistence = null }) {
    this.world = world;
    this.scheduler = scheduler;
    this.persistence = persistence;
    /** @type {Set<(event: {type: 'block-changed', changes: BlockChange[]}) => void>} */
    this._listeners = new Set();
  }

  /**
   * 单块编辑：过滤越界/缺 column/基岩目标/no-change 后写入，
   * 保留 WorldData.setBlock 的同步 skylight 单列重算（M1 挖放当帧视觉），
   * 并按调用方指定走同步快速网格（玩家挖放）或异步 REMESH。
   * `change.blockEntity`（M7）透传给 WorldData.setBlock：不带即清除该格旧 entity（失效语义）。
   * 事件的 change 携带 `oldBlockEntity`/`newBlockEntity` 供巢穴 controller 失效判定 ——
   * 徒手挖关键方块与批量破坏走的是同一条 setBlock/setBlocks，故同义（M7 规格 §1）。
   * @param {BlockChangeRequest} change
   * @param {{fastPath?: boolean}} [opts]
   * @returns {EditReport}
   */
  setBlock(change, { fastPath = true } = {}) {
    const { x, y, z, id } = change;
    const meta = change.meta ?? 0;
    const blockEntity = change.blockEntity ?? undefined;
    if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) {
      return { changes: [], affected: [], changedColumns: [], skipped: [{ ...change, reason: 'out-of-bounds' }] };
    }
    const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
    // 一次换算读出 id/meta/blockEntity（M7 性能修正，见 WorldData.readCell）：
    // 逐个调 getBlockId/getBlockMeta/getBlockEntity 会把同一 cx/cz/index 换算做三遍。
    const cell = this.world.readCell(x, y, z);
    if (!cell.column) {
      return { changes: [], affected: [], changedColumns: [], skipped: [{ ...change, reason: 'column-missing' }] };
    }
    const oldId = cell.id, oldMeta = cell.meta, oldBlockEntity = cell.blockEntity;
    if (oldId === this.world.registry.idOf('bedrock') && id !== oldId) {
      return { changes: [], affected: [], changedColumns: [], skipped: [{ ...change, reason: 'bedrock' }] };
    }
    // `?? null` 归一化不可省：`readCell` 的 blockEntity 缺省是 **null**，而未传 entity 的 change
    // 是 **undefined**，两者直接 `===` 恒 false → 重复放同一方块不再被判为 no-change（回归）。
    if (oldId === id && oldMeta === meta && (oldBlockEntity ?? null) === (blockEntity ?? null)) {
      return { changes: [], affected: [], changedColumns: [], skipped: [{ ...change, reason: 'no-change' }] };
    }
    const write = this.world.setBlock(x, y, z, id, meta, blockEntity);
    const record = { x, y, z, oldId, oldMeta, newId: id, newMeta: meta };
    if (oldBlockEntity !== null && oldBlockEntity !== undefined) record.oldBlockEntity = oldBlockEntity;
    if (blockEntity !== undefined) record.newBlockEntity = blockEntity;
    const changes = [record];
    const report = { changes, affected: write.affected, changedColumns: [columnKey(cx, cz)], skipped: [] };
    this.scheduler.remeshSections(report.affected, { fastPath });
    this._emit(changes);
    return report;
  }

  /**
   * 只写一格的 blockEntity（M7）：巢穴锚点的唯一持久写入路径。
   * 与 `setBlock`/`setBlocks` 的本质区别 —— **不 bump version、不 remesh/light**
   * （纯 entity 写不改变任何渲染输入），但仍记入 `column.edits` 并调度落盘（DR-6）。
   * `value=null` 删除该格 entity（巢穴失效时删锚点）。返回 EditReport（changes 恒空，
   * 因为这不是方块变更，不发 block-changed 事件 —— 失效由破坏方块的 change 触发，不在此处）。
   * @param {{x: number, y: number, z: number, value: Object|null}} req
   * @returns {EditReport}
   */
  setBlockEntity({ x, y, z, value }) {
    if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) {
      return { changes: [], affected: [], changedColumns: [], skipped: [{ x, y, z, value, reason: 'out-of-bounds' }] };
    }
    const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
    const col = this.world.getColumn(cx, cz);
    if (!col) {
      return { changes: [], affected: [], changedColumns: [], skipped: [{ x, y, z, value, reason: 'column-missing' }] };
    }
    col.setBlockEntity(x - cx * 16, y, z - cz * 16, value);
    if (this.persistence) this.persistence.scheduleFlush(this.world);
    return { changes: [], affected: [], changedColumns: [columnKey(cx, cz)], skipped: [] };
  }

  /**
   * 批量编辑（MAG7 / 未来 TNT）：一次逻辑事务提交全部变更。
   * 每个受影响 column 只递增一次版本、每格仍写 edits；
   * 跳过同步快速网格，统一转 Worker REMESH，并对受影响 column 入异步 light 队列。
   * @param {BlockChangeRequest[]} changes
   * @returns {EditReport}
   */
  setBlocks(changes) {
    const report = this.world.setBlocks(changes);
    if (report.changes.length === 0) return report;
    for (const key of new Set(report.affected.map(({ cx, cz }) => columnKey(cx, cz)))) {
      const [cx, cz] = key.split(',').map(Number);
      this.scheduler.enqueueLight(cx, cz);
    }
    this.scheduler.remeshSections(report.affected, { fastPath: false });
    this._emit(report.changes);
    return report;
  }

  /**
   * 订阅世界变更（音频/粒子/未来实体可消费）。
   * 事件只携带与返回值同一份增量，不保存第二份世界状态；事件不进 Worker、不参与版本判定。
   * @param {(event: {type: 'block-changed', changes: BlockChange[]}) => void} listener
   * @returns {() => void} unsubscribe
   */
  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _emit(changes) {
    if (changes.length === 0) return;
    const event = { type: 'block-changed', changes };
    for (const listener of this._listeners) listener(event);
  }
}
