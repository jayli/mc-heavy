// src/core/scheduler.js — 世界流式调度（§4.9）
// 本任务实现 GEN 段；MESH 段（Task 6）、上传预算（Task 7）后续补入。
import { ChunkColumn } from '../voxel/chunk-column.js';
import { columnKey } from '../voxel/constants.js';

export class Scheduler {
  /**
   * @param {Object} opts
   * @param {import('../voxel/world-data.js').WorldData} opts.world
   * @param {import('./worker-pool.js').WorkerPool} opts.pool
   * @param {*} opts.registry
   * @param {number} opts.seed
   * @param {number} [opts.viewDistance] 视距（column 数，切比雪夫半径），默认 8
   * @param {import('./perf.js').PerfMonitor} [opts.perf]
   * @param {(key: string) => Array<{index:number,id:number,meta:number}>} [opts.getEdits]
   *        持久化层提供的 edits 查询（Task 10 接入；缺省返回空数组）
   */
  constructor({ world, pool, registry, seed, viewDistance = 8, perf, getEdits }) {
    this.world = world;
    this.pool = pool;
    this.registry = registry;
    this.seed = seed;
    this.viewDistance = viewDistance;
    this.perf = perf;
    this.getEdits = getEdits || (() => []);
    /** @type {Map<string, {callId: number}>} 在途 GEN 任务 */
    this._inflightGen = new Map();
    this._columnReadyCallbacks = [];
  }

  onColumnReady(cb) { this._columnReadyCallbacks.push(cb); }

  /** 每帧调用：目标集合 → GEN 下发 → 滞回卸载 */
  update(playerX, playerZ) {
    const pcx = Math.floor(playerX / 16), pcz = Math.floor(playerZ / 16);
    const R = this.viewDistance;

    // 1. GEN 下发（按切比雪夫距离升序，内圈先就绪，§4.3 halo 协议第 1 条）
    const targets = [];
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        targets.push([pcx + dx, pcz + dz, Math.max(Math.abs(dx), Math.abs(dz))]);
      }
    }
    targets.sort((a, b) => a[2] - b[2]);
    for (const [cx, cz] of targets) {
      const key = columnKey(cx, cz);
      if (this.world.hasColumn(cx, cz) || this._inflightGen.has(key)) continue;
      const edits = this.getEdits(key);
      const { id: callId, promise } = this.pool.call('gen', { cx, cz, seed: this.seed, edits });
      this._inflightGen.set(key, { callId });
      promise.then((r) => this._onGenResult(key, r)).catch(() => {
        this._inflightGen.delete(key); // 失败/取消：下帧重试
      });
    }

    // 2. 滞回卸载（半径 +2，DR-16）
    for (const [key, col] of [...this.world.columns]) {
      const dist = Math.max(Math.abs(col.cx - pcx), Math.abs(col.cz - pcz));
      if (dist > R + 2) {
        this.world.remove(key);
        const inflight = this._inflightGen.get(key);
        if (inflight) { this.pool.cancel(inflight.callId); this._inflightGen.delete(key); }
      }
    }

    if (this.perf) {
      this.perf.mark('gen-inflight', this._inflightGen.size);
    }
  }

  /** GEN 结果接管：版本/存在性校验 → 零拷贝包装 → edits 已在 Worker 叠加 → ready */
  _onGenResult(key, r) {
    this._inflightGen.delete(key);
    if (this.world.columns.has(key)) return; // 已有（重入竞态）
    const [cx, cz] = key.split(',').map(Number);
    if (r.cx !== cx || r.cz !== cz) return;
    const column = new ChunkColumn(cx, cz);
    column.blocks = new Uint16Array(r.blocks);
    column.meta = new Uint8Array(r.meta);
    column.light = new Uint8Array(r.light);
    column.state = 'ready';
    this.world.add(column);
    for (const cb of this._columnReadyCallbacks) cb(key, column);
  }

  stats() {
    return { inflight: this._inflightGen.size, ready: this.world.columns.size };
  }
}
