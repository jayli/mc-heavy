// src/core/scheduler.js — 世界流式调度（§4.9）
// GEN 段（Task 4）+ MESH 段（Task 6：脏 section → Worker 网格化 → 上传预算）。
import { ChunkColumn } from '../voxel/chunk-column.js';
import { columnKey, SECTIONS_PER_COLUMN } from '../voxel/constants.js';
import { buildSectionMesh } from '../mesh/mesher.js';

const CHANNELS = ['opaque', 'cutout', 'transparent'];
const MESH_UPLOAD_BUDGET_MS = 3;   // 每帧 GPU 上传预算（§4.9）
const MESH_DISPATCH_PER_FRAME = 64; // 每帧下发 mesh 任务上限（worker 侧计算，主线程仅 postMessage）
const LIGHT_DISPATCH_PER_FRAME = 1; // 每帧下发 light 任务上限（区域重算 ~4ms/column，Worker 侧执行）

function sectionKey(cx, sy, cz) { return `${cx},${sy},${cz}`; }

/** Worker 回传的 buffer 形式 → typed array（上传前解包） */
function unpackGeom(g) {
  return {
    positions: new Float32Array(g.positions),
    uvs: new Float32Array(g.uvs),
    packed: new Uint32Array(g.packed),
    indices: new Uint32Array(g.indices),
    vertexCount: g.vertexCount,
    indexCount: g.indexCount,
  };
}

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
   * @param {import('../render/render-world.js').RenderWorld} [opts.renderWorld]
   *        发布层；缺省（GEN-only 模式，Task 4 测试）则跳过 MESH 段
   */
  constructor({ world, pool, registry, seed, viewDistance = 8, perf, getEdits, renderWorld }) {
    this.world = world;
    this.pool = pool;
    this.registry = registry;
    this.seed = seed;
    this.viewDistance = viewDistance;
    this.perf = perf;
    this.getEdits = getEdits || (() => []);
    this.renderWorld = renderWorld || null;
    /** @type {Map<string, {callId: number}>} 在途 GEN 任务 */
    this._inflightGen = new Map();
    this._columnReadyCallbacks = [];
    // ---- MESH 段状态（renderWorld 存在时启用）----
    /** @type {Map<string, {callId: number}>} 在途 MESH 任务 */
    this._inflightMesh = new Map();
    /** 邻居未就绪而挂起的 section（sectionKey 集合） */
    this._pendingMesh = new Set();
    /** 邻居已就绪、待下发 Worker 的 section 队列 */
    this._meshQueue = [];
    this._meshQueuedSet = new Set();
    /** Worker 回传、待上传 GPU 的网格结果 */
    this._uploadQueue = [];
    /** 至少上传过一次的 section（邻居到达重 mesh 判定用） */
    this._meshedSections = new Set();
    // ---- LIGHT 段状态（skylight 水平扩散异步收敛，§4.6）----
    /** 待下发光照重算的 columnKey 集合（去重） */
    this._lightQueue = new Set();
    /** @type {Map<string, {callId: number}>} 在途 LIGHT 任务 */
    this._inflightLight = new Map();
    this._playerCx = 0;
    this._playerCz = 0;
    /** atlas tile 元数据（Game 启动时赋值，与 broadcast 给 Worker 的同一份）——快速路径主线程 mesh 用 */
    this._atlasMeta = null;
  }

  onColumnReady(cb) { this._columnReadyCallbacks.push(cb); }

  /** 每帧调用：目标集合 → GEN 下发 → 滞回卸载 → MESH 下发 → 上传预算 */
  update(playerX, playerZ) {
    const pcx = Math.floor(playerX / 16), pcz = Math.floor(playerZ / 16);
    this._playerCx = pcx; this._playerCz = pcz;
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
        if (this.renderWorld) this.renderWorld.removeColumn(col.cx, col.cz);
        this._cleanupColumn(col.cx, col.cz, key);
      }
    }

    // 3. MESH 段（renderWorld 存在时）
    if (this.renderWorld) {
      // 3a. 收集 ready column 的脏 section（玩家编辑 / 邻居到达置脏）
      for (const [, col] of this.world.columns) {
        if (col.state !== 'ready') continue;
        const dirty = col.takeDirty();
        for (const sy of dirty) this._enqueueMesh(col.cx, sy, col.cz);
      }
      // 3b. 重查挂起 section（等待的邻居可能已就绪）
      for (const skey of [...this._pendingMesh]) {
        const [cx, sy, cz] = skey.split(',').map(Number);
        this._enqueueMesh(cx, sy, cz);
      }
      // 3c. 下发 mesh 任务（每帧上限）
      let dispatched = 0;
      while (this._meshQueue.length && dispatched < MESH_DISPATCH_PER_FRAME) {
        const { cx, sy, cz } = this._meshQueue.shift();
        const skey = sectionKey(cx, sy, cz);
        this._meshQueuedSet.delete(skey);
        this._sendMeshTask(cx, sy, cz);
        dispatched++;
      }
      // 3d. 上传预算（≤3ms/帧）
      this._processUploadQueue();
    }

    // 4. LIGHT 段：skylight 水平扩散异步收敛（编辑/邻居到达触发，Worker 执行）
    this._processLightQueue();

    if (this.perf) {
      this.perf.mark('gen-inflight', this._inflightGen.size);
      if (this.renderWorld) {
        this.perf.mark('mesh-inflight', this._inflightMesh.size);
        this.perf.mark('upload-queue', this._uploadQueue.length);
        this.perf.mark('light-inflight', this._inflightLight.size);
      }
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
    if (this.renderWorld) this._handleColumnReady(column);
    this._enqueueLightIfOverhang(column);
    for (const cb of this._columnReadyCallbacks) cb(key, column);
  }

  // ==================== LIGHT 段 ====================

  /**
   * 悬挑检测：column 内存在"表面之上的 opaque 方块"才需要水平扩散重算
   * （GEN 的垂直 skylight 对开阔地形已正确；悬挑/结构/玩家搭建才产生侧向阴影）。
   * 地表高度 = 最高非 air 格的 y。O(32768) 扫描，GEN 就绪时一次。
   */
  _enqueueLightIfOverhang(column) {
    const blocks = column.blocks;
    let surfaceYi = -1; // yi = y - WORLD_MIN_Y 的 blockIndex 层索引
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i] !== 0) { surfaceYi = i >> 8; break; }
    }
    if (surfaceYi < 0) return;
    const opaque = this.registry.opaqueTable;
    for (let i = blocks.length - 1; i >= 0; i--) {
      if ((i >> 8) <= surfaceYi) break; // 表面及以下无需检查
      if (opaque[blocks[i]] === 1) { this.enqueueLight(column.cx, column.cz); return; }
    }
  }

  /** 请求异步重算 (cx,cz) 的区域光照（去重；column 未就绪忽略） */
  enqueueLight(cx, cz) {
    const key = columnKey(cx, cz);
    const col = this.world.getColumn(cx, cz);
    if (!col || col.state !== 'ready') return;
    if (this._inflightLight.has(key)) return; // 在途：结果回来后由脏标记再触发
    this._lightQueue.add(key);
  }

  /** 每帧下发 ≤N 个 light 任务：中心 column + 4 正交邻居的 blocks 副本送 Worker */
  _processLightQueue() {
    let dispatched = 0;
    for (const key of [...this._lightQueue]) {
      if (dispatched >= LIGHT_DISPATCH_PER_FRAME) break;
      this._lightQueue.delete(key);
      const [cx, cz] = key.split(',').map(Number);
      const col = this.world.getColumn(cx, cz);
      if (!col || col.state !== 'ready' || this._inflightLight.has(key)) continue;
      const columns = [];
      for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ncol = this.world.getColumn(cx + dx, cz + dz);
        if (!ncol || ncol.state !== 'ready') continue;
        // 拷贝 blocks（不能 transfer 主线程活跃数据）
        columns.push({ cx: ncol.cx, cz: ncol.cz, version: ncol.version, blocks: ncol.blocks.slice().buffer });
      }
      const { id: callId, promise } = this.pool.call('light', { cx, cz, columns }, {
        transfer: columns.map((c) => c.blocks),
      });
      this._inflightLight.set(key, { callId });
      promise.then((r) => this._onLightResult(key, r)).catch(() => {
        this._inflightLight.delete(key); // 失败：下帧由脏标记/邻居到达重试
      });
      dispatched++;
    }
  }

  /** LIGHT 结果：版本校验 → 写回 light 数组 + 全 section 置脏重 mesh。
   *  版本不匹配（在途期间玩家编辑过）：丢弃并重新入队收敛，
   *  否则旧 light 会覆盖 setBlock 快路径已重算的垂直单列新值。 */
  _onLightResult(key, r) {
    this._inflightLight.delete(key);
    for (const res of r.results) {
      const col = this.world.getColumn(res.cx, res.cz);
      if (!col || col.state !== 'ready') continue; // 已卸载：丢弃
      if (col.version !== res.version) { this.enqueueLight(res.cx, res.cz); continue; }
      col.light.set(new Uint8Array(res.light));
      for (let sy = 0; sy < SECTIONS_PER_COLUMN; sy++) col.markDirty(sy);
    }
  }

  // ==================== MESH 段 ====================

  /** column 就绪：8 section 入 MESH 队列 + 触发相邻已 mesh column 边界重 mesh（§4.3 第 3 条） */
  _handleColumnReady(column) {
    const { cx, cz } = column;
    for (let sy = 0; sy < SECTIONS_PER_COLUMN; sy++) this._enqueueMesh(cx, sy, cz);
    // 邻居到达：把相邻已 mesh column 的 section 重入队（玩家移动时，先前保守出块的边界面需精修）
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ncol = this.world.getColumn(cx + dx, cz + dz);
      if (!ncol || ncol.state !== 'ready') continue;
      for (let sy = 0; sy < SECTIONS_PER_COLUMN; sy++) {
        if (this._meshedSections.has(sectionKey(cx + dx, sy, cz + dz))) {
          this._enqueueMesh(cx + dx, sy, cz + dz);
        }
      }
    }
  }

  /** halo 前置（§4.3 第 2 条）：半径内 4 水平邻居须 ready；半径外缺失 → 直接 mesh（保守出块） */
  _neighborsReadyForMesh(cx, cz) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ncx = cx + dx, ncz = cz + dz;
      const dist = Math.max(Math.abs(ncx - this._playerCx), Math.abs(ncz - this._playerCz));
      if (dist <= this.viewDistance) {
        const ncol = this.world.getColumn(ncx, ncz);
        if (!ncol || ncol.state !== 'ready') return false; // 半径内未就绪 → 等待
      }
    }
    return true;
  }

  /** section 入 MESH 管线：在途跳过；邻居未就绪挂起；否则进下发队列 */
  _enqueueMesh(cx, sy, cz) {
    const skey = sectionKey(cx, sy, cz);
    if (this._inflightMesh.has(skey) || this._meshQueuedSet.has(skey)) return;
    if (!this._neighborsReadyForMesh(cx, cz)) { this._pendingMesh.add(skey); return; }
    this._pendingMesh.delete(skey);
    this._meshQueue.push({ cx, sy, cz });
    this._meshQueuedSet.add(skey);
  }

  /** 下发单 section mesh 任务（view buffer transfer 给 Worker） */
  _sendMeshTask(cx, sy, cz) {
    const skey = sectionKey(cx, sy, cz);
    const col = this.world.getColumn(cx, cz);
    if (!col || col.state !== 'ready') return;
    const version = col.version;
    const view = this.world.getSectionView(cx, sy, cz);
    const { id: callId, promise } = this.pool.call('mesh', {
      cx, sy, cz,
      data: view.data.buffer,
      light: view.light.buffer,
      version,
    }, { transfer: [view.data.buffer, view.light.buffer] });
    this._inflightMesh.set(skey, { callId });
    promise.then((r) => this._onMeshResult(skey, r)).catch(() => {
      this._inflightMesh.delete(skey); // 失败/取消：下帧由脏标记或邻居重查重试
    });
  }

  /** MESH 结果：版本校验 → 进上传队列 */
  _onMeshResult(skey, r) {
    this._inflightMesh.delete(skey);
    const col = this.world.getColumn(r.cx, r.cz);
    if (!col || col.version !== r.version) return; // 过期结果丢弃（§4.9）
    this._uploadQueue.push({ cx: r.cx, sy: r.sy, cz: r.cz, channels: r.channels, version: r.version });
  }

  /** 上传预算：每帧 ≤3ms，从队列取 section 调 renderWorld.uploadSection */
  _processUploadQueue() {
    const t0 = performance.now();
    while (this._uploadQueue.length && performance.now() - t0 < MESH_UPLOAD_BUDGET_MS) {
      const item = this._uploadQueue.shift();
      const col = this.world.getColumn(item.cx, item.cz);
      if (!col || col.version !== item.version) continue; // 卸载/已变更：丢弃
      for (const channel of CHANNELS) {
        this.renderWorld.uploadSection(item.cx, item.sy, item.cz, channel, unpackGeom(item.channels[channel]), item.version);
      }
      this._meshedSections.add(sectionKey(item.cx, item.sy, item.cz));
    }
  }

  /** column 卸载：清理 GEN/MESH 在途、挂起、已 mesh 状态 */
  _cleanupColumn(cx, cz, key) {
    const genInflight = this._inflightGen.get(key);
    if (genInflight) { this.pool.cancel(genInflight.callId); this._inflightGen.delete(key); }
    this._lightQueue.delete(key);
    const lightInflight = this._inflightLight.get(key);
    if (lightInflight) { this.pool.cancel(lightInflight.callId); this._inflightLight.delete(key); }
    for (let sy = 0; sy < SECTIONS_PER_COLUMN; sy++) {
      const skey = sectionKey(cx, sy, cz);
      this._meshedSections.delete(skey);
      this._pendingMesh.delete(skey);
      if (this._meshQueuedSet.has(skey)) { this._meshQueuedSet.delete(skey); }
      const meshInflight = this._inflightMesh.get(skey);
      if (meshInflight) { this.pool.cancel(meshInflight.callId); this._inflightMesh.delete(skey); }
    }
  }

  /**
   * 方块编辑后重建受影响 section（§4.5.3 快速路径）。
   * fastPath：主线程同步 buildSectionMesh + 立即上传（<2ms 当帧生效）；
   * affected 已含编辑所在 section + 正交相邻 section，全部同步重建（M1 口径），
   * 对角 AO 差异由后续常规 MESH 收敛。
   * @param {Array<{cx:number, cz:number, sy:number}>} affected
   * @param {{fastPath?: boolean}} [opts]
   */
  remeshSections(affected, { fastPath = true } = {}) {
    if (!this.renderWorld) return;
    for (const { cx, cz, sy } of affected) {
      const col = this.world.getColumn(cx, cz);
      if (!col || col.state !== 'ready') continue;
      // 编辑改变光照：请求异步区域重算收敛水平扩散（setBlock 已同步重算垂直单列做即时反馈）。
      // enqueueLight 是 O(1) Set.add，不影响编辑帧预算。
      this.enqueueLight(cx, cz);
      if (!fastPath) { col.markDirty(sy); this._enqueueMesh(cx, sy, cz); continue; }
      const t0 = performance.now();
      const view = this.world.getSectionView(cx, sy, cz);
      const data = buildSectionMesh(view, this.registry, this._atlasMeta || {}, cx, sy, cz);
      for (const channel of CHANNELS) {
        this.renderWorld.uploadSection(cx, sy, cz, channel, data[channel], col.version);
      }
      if (this.perf) this.perf.mark('fast-remesh', performance.now() - t0);
    }
  }

  stats() {
    return {
      inflight: this._inflightGen.size,
      ready: this.world.columns.size,
      meshInflight: this._inflightMesh.size,
      uploadQueue: this._uploadQueue.length,
      sections: this._meshedSections.size,
      lightInflight: this._inflightLight.size,
    };
  }
}
