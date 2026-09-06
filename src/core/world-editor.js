// src/core/world-editor.js — WorldEditor：主线程世界编辑协调器（M4-0，设计文档 §4.5.3 / M4 规格 §4.1）
// 职责仅是协调已有唯一权威数据（WorldData typed array）与派生重建（remesh / light / 事件）。
// 不保存体素副本，不持有 event log、light 值或 world snapshot —— 红线 1。
// 它是玩家挖放、MAG7 批量破坏与未来 TNT/爆炸的共享入口：世界写入没有第二条路径。
// Worker 同构无关：本模块只在主线程运行（依赖 Scheduler），不得被 Worker import。
import { WORLD_MIN_Y, WORLD_MAX_Y, columnKey } from '../voxel/constants.js';

/**
 * @typedef {{x: number, y: number, z: number, id: number, meta?: number}} BlockChangeRequest
 * @typedef {{x: number, y: number, z: number, oldId: number, oldMeta: number,
 *            newId: number, newMeta: number}} BlockChange
 * @typedef {{changes: BlockChange[], affected: Array<{cx: number, cz: number, sy: number}>,
 *            changedColumns: string[], skipped: Array<BlockChangeRequest & {reason: string}>}} EditReport
 */

export class WorldEditor {
  /**
   * @param {{world: import('../voxel/world-data.js').WorldData,
   *          scheduler: import('./scheduler.js').Scheduler}} deps
   */
  constructor({ world, scheduler }) {
    this.world = world;
    this.scheduler = scheduler;
    /** @type {Set<(event: {type: 'block-changed', changes: BlockChange[]}) => void>} */
    this._listeners = new Set();
  }

  /**
   * 单块编辑：过滤越界/缺 column/基岩目标/no-change 后写入，
   * 保留 WorldData.setBlock 的同步 skylight 单列重算（M1 挖放当帧视觉），
   * 并按调用方指定走同步快速网格（玩家挖放）或异步 REMESH。
   * @param {BlockChangeRequest} change
   * @param {{fastPath?: boolean}} [opts]
   * @returns {EditReport}
   */
  setBlock(change, { fastPath = true } = {}) {
    const { x, y, z, id } = change;
    const meta = change.meta ?? 0;
    if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) {
      return { changes: [], affected: [], changedColumns: [], skipped: [{ ...change, reason: 'out-of-bounds' }] };
    }
    const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
    if (!this.world.getColumn(cx, cz)) {
      return { changes: [], affected: [], changedColumns: [], skipped: [{ ...change, reason: 'column-missing' }] };
    }
    const oldId = this.world.getBlockId(x, y, z);
    const oldMeta = this.world.getBlockMeta(x, y, z);
    if (oldId === this.world.registry.idOf('bedrock') && id !== oldId) {
      return { changes: [], affected: [], changedColumns: [], skipped: [{ ...change, reason: 'bedrock' }] };
    }
    if (oldId === id && oldMeta === meta) {
      return { changes: [], affected: [], changedColumns: [], skipped: [{ ...change, reason: 'no-change' }] };
    }
    const write = this.world.setBlock(x, y, z, id, meta);
    const changes = [{ x, y, z, oldId, oldMeta, newId: id, newMeta: meta }];
    const report = { changes, affected: write.affected, changedColumns: [columnKey(cx, cz)], skipped: [] };
    this.scheduler.remeshSections(report.affected, { fastPath });
    this._emit(changes);
    return report;
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
