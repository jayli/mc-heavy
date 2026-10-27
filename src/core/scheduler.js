// src/core/scheduler.js — 世界流式调度（§4.9）
// GEN 段（Task 4）+ MESH 段（Task 6：脏 section → Worker 网格化 → 上传预算）。
import { ChunkColumn } from '../voxel/chunk-column.js';
import { columnKey, SECTIONS_PER_COLUMN } from '../voxel/constants.js';
import { buildSectionMesh } from '../mesh/mesher.js';
import { LIGHT_REGION_OFFSETS, lightDirtyMasks } from '../mesh/lighting.js';
import { StructureIndex } from '../gen/structure-index.js';
import { BudgetConfig } from './budget.js';

const CHANNELS = ['opaque', 'cutout', 'transparent'];
// 帧预算双档标定（M3-2）：mesh 上传预算/下发上限由 BudgetConfig 按刷新率档位提供
// （120Hz=3ms/64，60Hz=6ms/128；默认值与原 §4.9 常量一致，档位判定见 core/budget.js）。
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
   * @param {import('./budget.js').BudgetConfig} [opts.budget]
   *        帧预算双档配置（M3-2）；缺省自建一个（auto，未定档按 high 口径 3ms/64）
   */
  constructor({ world, pool, registry, seed, viewDistance = 8, perf, getEdits, renderWorld, budget }) {
    this.world = world;
    this.pool = pool;
    this.registry = registry;
    this.seed = seed;
    this.viewDistance = viewDistance;
    this.perf = perf;
    this.getEdits = getEdits || (() => []);
    this.renderWorld = renderWorld || null;
    this.budget = budget || new BudgetConfig();
    /** 结构布局缓存 + GEN 门控（§4.2 DR-13：布局 Worker 算一次，主线程转发） */
    this.structureIndex = new StructureIndex({ pool, seed });
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
    /** @type {Map<string, {blocks:number,candidateFaces:number,faces:number,culledFaces:number,vertices:number}>}
     *  已上传 section 的面剔除统计（mesher 回传，HUD 世界数据看板用） */
    this._sectionStats = new Map();
    // ---- LIGHT 段状态（skylight 水平扩散异步收敛，§4.6）----
    /** 待下发光照重算的 columnKey 集合（去重） */
    this._lightQueue = new Set();
    /** @type {Map<string, {callId: number}>} 在途 LIGHT 任务 */
    this._inflightLight = new Map();
    this._playerCx = 0;
    this._playerCz = 0;
    /** atlas tile 元数据（Game 启动时赋值，与 broadcast 给 Worker 的同一份）——快速路径主线程 mesh 用 */
    this._atlasMeta = null;
    // ---- M5：两阶段 column 卸载 ----
    /**
     * @type {Map<string, {key: string, column: import('../voxel/chunk-column.js').ChunkColumn,
     *                       handles: Array<{ready: Promise<void>, commit: Function, cancel: Function}>,
     *                       ready: Promise<void>, settled: boolean}>}
     * 卸载准备中的 column。**只登记 key / Column 引用 / handle 的生命周期状态**，
     * 不复制 blocks/meta/light、不参与游戏逻辑（M5 规格 §2 + 红线 1）——
     * 复制体素数据就是第二份世界权威，正是 mc-lite WorldChunkPayloadRegistry 的病根。
     */
    this._pendingColumnUnloads = new Map();
    /** 卸载请求监听器：返回 `{ready, commit, cancel}` handle（Game 接 EntityManager） */
    this._unloadRequestedListeners = [];
    /** 最终移除前的同步通知监听器（只释放派生对象，返回值不等待） */
    this._willRemoveListeners = [];
    /** 最近一次卸载失败的可诊断信息（`stats()` 只读暴露，不参与调度分支） */
    this._lastUnloadError = null;
  }

  onColumnReady(cb) { this._columnReadyCallbacks.push(cb); }

  /**
   * 订阅「column 请求卸载」（M5 规格 §2）。
   *
   * listener 必须返回 `{ready, commit, cancel}`：Scheduler 用 `ready` 决定本次卸载能否最终提交，
   * 只有它 resolve 后的**下一帧**、且 column 仍在卸载半径外，才同步调 `commit()`。
   * listener 抛错或返回非法 handle 视为准备失败（等同 ready reject）。
   * @param {(key: string, column: import('../voxel/chunk-column.js').ChunkColumn) =>
   *          {ready: Promise<void>, commit: Function, cancel: Function}} listener
   * @returns {() => void} unsubscribe
   */
  onColumnUnloadRequested(listener) {
    this._unloadRequestedListeners.push(listener);
    return () => {
      const i = this._unloadRequestedListeners.indexOf(listener);
      if (i >= 0) this._unloadRequestedListeners.splice(i, 1);
    };
  }

  /**
   * 订阅「column 即将最终移除」（M5 规格 §2）。
   * 只在 `ready` 成功后、同步删除之前调用；**不接受 Promise**（没有异步删除竞态），
   * listener 只负责释放 controller 等派生对象，不得保存 column 副本、不得返回异步工作。
   * @param {(key: string, column: import('../voxel/chunk-column.js').ChunkColumn) => void} listener
   * @returns {() => void} unsubscribe
   */
  onColumnWillRemove(listener) {
    this._willRemoveListeners.push(listener);
    return () => {
      const i = this._willRemoveListeners.indexOf(listener);
      if (i >= 0) this._willRemoveListeners.splice(i, 1);
    };
  }

  /** 每帧调用：目标集合 → GEN 下发 → 滞回卸载 → MESH 下发 → 上传预算 */
  update(playerX, playerZ) {
    const pcx = Math.floor(playerX / 16), pcz = Math.floor(playerZ / 16);
    this._playerCx = pcx; this._playerCz = pcz;
    const R = this.viewDistance;

    // 0. 结构布局下发（GEN 前置依赖，§4.2 DR-13：预算内按就近优先级）
    this.structureIndex.dispatch();

    // 1. GEN 下发（按切比雪夫距离升序，内圈先就绪，§4.3 halo 协议第 1 条）
    const targets = [];
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        targets.push([pcx + dx, pcz + dz, Math.max(Math.abs(dx), Math.abs(dz))]);
      }
    }
    targets.sort((a, b) => a[2] - b[2]);
    for (const [cx, cz, dist] of targets) {
      const key = columnKey(cx, cz);
      if (this.world.hasColumn(cx, cz) || this._inflightGen.has(key)) continue;
      // GEN 依赖规则（§4.2）：本 column 查询域（基 region + 相邻 8 region）布局全就绪才下发
      if (!this.structureIndex.readyForColumn(cx, cz)) {
        this.structureIndex.ensureForColumn(cx, cz, dist);
        continue;
      }
      const layouts = this.structureIndex.layoutsForColumn(cx, cz);
      const edits = this.getEdits(key);
      const { id: callId, promise } = this.pool.call('gen', { cx, cz, seed: this.seed, edits, layouts });
      this._inflightGen.set(key, { callId });
      promise.then((r) => this._onGenResult(key, r)).catch(() => {
        this._inflightGen.delete(key); // 失败/取消：下帧重试
      });
    }

    // 2. 滞回卸载（半径 +2，DR-16）—— M5 起改为两阶段（可取消异步准备 → 同步最终移除）
    this._processColumnUnloads(pcx, pcz, R);

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
      // 3c. 下发 mesh 任务（每帧上限，按刷新率档位标定）
      let dispatched = 0;
      while (this._meshQueue.length && dispatched < this.budget.meshDispatchPerFrame) {
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
    // M7：接管时重建 edits Map 与 blockEntities（不只是 typed 数组）。
    // Worker 内 `applyEdits` 已把 edits 叠进 blocks/meta（world-worker.js:76），故方块值正确；
    // 但 column.edits / blockEntities 仍是空的 —— 若留空，玩家在此 column 新放一块后
    // `Persistence.flushNow()` 会用「只含新编辑」的 Map 整行覆盖该 key 的存档 →
    // **旧 edits（含巢穴锚点）静默丢失**。restoreEdits 与 getEdits 同源，重建这两者。
    const edits = this.getEdits(key);
    if (edits && edits.length) column.restoreEdits(edits);
    column.state = 'ready';
    this.world.add(column);
    if (this.renderWorld) this._handleColumnReady(column);
    this._enqueueLightIfOverhang(column);
    for (const cb of this._columnReadyCallbacks) cb(key, column);
  }

  // ==================== M5：两阶段 column 卸载 ====================

  /**
   * 滞回卸载的两阶段实现（M5 规格 §2/§3，设计文档 §4.9「卸载与重入」）。
   *
   * 阶段划分：
   * ① **请求**：column 首次超出「加载半径 + 2」→ 调每个 requested listener 拿 handle，
   *    登记 pending，**保留** world/render column 与临时实体（这段时间只做异步保存准备）；
   * ② **提交**：所有 handle 的 `ready` 都 resolve 后的**下一帧**、且 column 仍在卸载半径外 →
   *    依次同步广播 `onColumnWillRemove` → 各 handle `commit()` → `world.remove()` →
   *    `renderWorld.removeColumn()` → `_cleanupColumn()`。
   *
   * 取消路径（两条，都必须保留一切运行时 state）：
   * - **玩家重入**（回到 R+2 内）→ 各 handle `cancel()`、删除 pending。已完成的 IndexedDB
   *   写入允许保留（后续状态保存会覆盖它）；
   * - **`ready` reject**（写盘失败）→ 各 handle `cancel()`、删除 pending、记 `lastUnloadError`，
   *   **不调 `world.remove()`**。不得静默删除 —— 静默删除会让持久实体的 snapshot 永久丢失，
   *   且玩家看不出发生了什么。后续正常卸载周期会重试。
   *
   * 没有 requested listener 时（未装配实体运行时，例如 GEN-only 的 Task 4 测试）退化为
   * 直接同步移除 —— 两阶段协议是为持久实体保存服务的，没有消费者就不该拖住卸载。
   */
  _processColumnUnloads(pcx, pcz, R) {
    const limit = R + 2;
    const distOf = (col) => Math.max(Math.abs(col.cx - pcx), Math.abs(col.cz - pcz));

    // 2a. 先取消已回到卸载半径内的 pending（玩家重入：解冻持久实体、保留 column）
    for (const [key, entry] of [...this._pendingColumnUnloads]) {
      if (distOf(entry.column) > limit) continue;
      this._cancelPendingUnload(key, entry);
    }

    // 2b. 超出半径的 column：发起请求 / 推进已就绪的提交
    for (const [key, col] of [...this.world.columns]) {
      if (distOf(col) <= limit) continue;

      const entry = this._pendingColumnUnloads.get(key);
      if (!entry) {
        // 无消费者 → 直接同步移除（两阶段只为持久实体保存服务）
        if (this._unloadRequestedListeners.length === 0) { this._removeColumnNow(key, col); continue; }
        this._requestColumnUnload(key, col);
        continue;
      }
      // ready 尚未 settle → 继续等（重入检查已在 2a 做过）
      if (!entry.readyResolved || entry.failed) continue;
      // ready 成功后的**下一帧**且仍超界 → 同步最终移除
      this._commitColumnUnload(key, entry);
    }
  }

  /** 发起卸载请求：调 listener 拿 handle，登记 pending，保留 column */
  _requestColumnUnload(key, col) {
    const handles = [];
    let readyPromises = [];
    for (const listener of this._unloadRequestedListeners) {
      try {
        const handle = listener(key, col);
        if (!handle || typeof handle.commit !== 'function' || typeof handle.cancel !== 'function') {
          throw new Error('listener 未返回 {ready, commit, cancel} handle');
        }
        handles.push(handle);
        readyPromises.push(Promise.resolve(handle.ready));
      } catch (err) {
        // listener 抛错 = 准备失败：取消已拿到的 handle，不登记 pending（下帧重试）
        for (const h of handles) this._safeCancel(h, key);
        this._lastUnloadError = `${key}: ${err?.message || String(err)}`;
        return;
      }
    }
    const entry = { key, column: col, handles, ready: Promise.all(readyPromises), readyResolved: false, failed: false };
    this._pendingColumnUnloads.set(key, entry);
    // 异步 settle 只**标记状态**，不在回调里删除 column —— 删除必须发生在下一帧的同步流程里，
    // 否则就是「把 IndexedDB Promise 塞进最终移除」（M5 规格 §3 明令禁止的异步删除竞态）。
    entry.ready.then(() => { entry.readyResolved = true; }).catch((err) => {
      entry.failed = true;
      this._lastUnloadError = `${key}: ${err?.message || String(err)}`;
      if (this._pendingColumnUnloads.get(key) === entry) this._cancelPendingUnload(key, entry);
    });
  }

  /** 取消 pending：各 handle cancel、删除登记、保留 world/render column 与实体 */
  _cancelPendingUnload(key, entry) {
    for (const handle of entry.handles) this._safeCancel(handle, key);
    this._pendingColumnUnloads.delete(key);
  }

  /** 同步最终移除：will-remove 广播 → commit → world/render/调度派生队列清理 */
  _commitColumnUnload(key, entry) {
    for (const listener of this._willRemoveListeners) {
      try { listener(key, entry.column); } catch (err) {
        // 派生对象释放失败不阻断卸载（column 数据即将消失，留着反而泄漏）
        this._lastUnloadError = `${key}: onColumnWillRemove ${err?.message || String(err)}`;
      }
    }
    for (const handle of entry.handles) {
      try { handle.commit(); } catch (err) {
        this._lastUnloadError = `${key}: commit ${err?.message || String(err)}`;
      }
    }
    this._pendingColumnUnloads.delete(key);
    this._removeColumnNow(key, entry.column);
  }

  /** 真正删除 column（world + render + 调度派生队列）。卸载与最终提交共用这一条路径 */
  _removeColumnNow(key, col) {
    this.world.remove(key);
    if (this.renderWorld) this.renderWorld.removeColumn(col.cx, col.cz);
    this._cleanupColumn(col.cx, col.cz, key);
  }

  /** cancel 失败只记诊断，不中断其余 handle（一个 listener 出错不能拖死整次卸载） */
  _safeCancel(handle, key) {
    try { handle.cancel(); } catch (err) {
      this._lastUnloadError = `${key}: cancel ${err?.message || String(err)}`;
    }
  }

  // ==================== LIGHT 段 ====================

  /**
   * 阴影检测（两件事合并在一起，都以「这一列的光照输入变了」为语义 —— 见 enqueueLight）：
   *
   * ① 悬挑扩散（第一阶段 v1.9 恒不触发）：column 内存在「空气格但垂直 skylight=0」才需要水平扩散。
   *    判据 = 存在 blocks==0 且 (light>>4)==0 的格。O(32768) 扫描，GEN 就绪时一次。
   * ② **区域内有 emissive 源**（2026-10-21 新增，修「灯光有边界」的第二半）：
   *    GEN 只对本 column 算 blocklight（截断），跨列光必须靠以各列为中心的 light 任务收敛。
   *    新列到达时若它的 3×3 区域内存在发光方块，就要把区域入队 —— 否则玩家「走远再回来」
   *    会看到一个刚生成的光源又是「光停在 column 边界上」（实测现有存档里 43 个发光方块，
   *    跨列邻居格 126/134 是 0）。
   *    成本：9 × 32768 格扫 emissiveTable，实测 **0.286ms**，首次命中即退出；无光列零成本。
   */
  _enqueueLightIfOverhang(column) {
    const blocks = column.blocks;
    const light = column.light;
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i] === 0 && (light[i] >> 4) === 0) {
        this.enqueueLight(column.cx, column.cz);
        return;
      }
    }
    if (this._regionHasEmissive(column.cx, column.cz)) this.enqueueLight(column.cx, column.cz);
  }

  /** 3×3 区域内（已就绪的列）是否存在发光方块。首次命中即退出。 */
  _regionHasEmissive(cx, cz) {
    const emissive = this.registry.emissiveTable;
    for (const [dx, dz] of LIGHT_REGION_OFFSETS) {
      const col = this.world.getColumn(cx + dx, cz + dz);
      if (!col || col.state !== 'ready') continue;
      const blocks = col.blocks;
      for (let i = 0; i < blocks.length; i++) {
        if (emissive[blocks[i]] > 0) return true;
      }
    }
    return false;
  }

  /**
   * 请求「(cx,cz) 这一列的光照输入变了」→ 入队 **3×3 区域**（区域内已就绪的列）。
   *
   * ⚠️ **入队范围 ≠ 写回范围，这是不对称且载荷性的**（2026-10-21 修「灯光有边界」的根因之一）：
   * 写回只写**中心列**（3×3 只对中心列精确，邻列拿到的是截断结果 —— 见 `_onLightResult`），
   * 但入队必须覆盖 3×3 —— 因为「光照输入变了」对区域里每一列都是真的：灯放在 A 列，
   * 它的 ✓ 形光锥会进入**每一个**邻居列的角落，而邻居列原本的 light 是 GEN 时的单列截断值。
   * 旧实现只入队编辑所在列 → 灯的邻居列永远没有自己的 task → 永远是 0。
   *
   * 只入**已就绪**的列：未加载的列入了只会堆在 `_lightQueue` 里等（或永远等不到），
   * 它们由 `_enqueueLightIfOverhang` 的 emissive 扫描在 GEN 到达时补入。
   */
  enqueueLight(cx, cz) {
    for (const [dx, dz] of LIGHT_REGION_OFFSETS) {
      const ncx = cx + dx, ncz = cz + dz;
      const key = columnKey(ncx, ncz);
      const col = this.world.getColumn(ncx, ncz);
      if (!col || col.state !== 'ready') continue;
      // 在途：不重复下发。回包时 `_onLightResult` 的输入校验（版本 + 输入集合）会发现输入已变并重新入队
      if (this._inflightLight.has(key)) continue;
      this._lightQueue.add(key);
    }
  }

  /** 每帧下发 ≤N 个 light 任务：发中心 column + 3×3 区域邻居的 blocks 副本送 Worker */
  _processLightQueue() {
    let dispatched = 0;
    for (const key of [...this._lightQueue]) {
      if (dispatched >= LIGHT_DISPATCH_PER_FRAME) break;
      const [cx, cz] = key.split(',').map(Number);
      const col = this.world.getColumn(cx, cz);
      if (!col || col.state !== 'ready' || this._inflightLight.has(key)) continue;
      // halo 前置（与 MESH 同口径，§4.3）：半径内 3×3 邻居须 ready，否则保留
      // 队列下帧重试——避免邻居未就绪时区域截断、边界光照不收敛。
      let neighborsReady = true;
      for (const [dx, dz] of LIGHT_REGION_OFFSETS) {
        const ncx = cx + dx, ncz = cz + dz;
        const dist = Math.max(Math.abs(ncx - this._playerCx), Math.abs(ncz - this._playerCz));
        if (dist <= this.viewDistance) {
          const ncol = this.world.getColumn(ncx, ncz);
          if (!ncol || ncol.state !== 'ready') { neighborsReady = false; break; }
        }
      }
      if (!neighborsReady) continue;
      this._lightQueue.delete(key);
      const columns = [];
      for (const [dx, dz] of LIGHT_REGION_OFFSETS) {
        const ncol = this.world.getColumn(cx + dx, cz + dz);
        if (!ncol || ncol.state !== 'ready') continue;
        // 拷贝 blocks（不能 transfer 主线程活跃数据）
        columns.push({ cx: ncol.cx, cz: ncol.cz, version: ncol.version, blocks: ncol.blocks.slice().buffer });
      }
      const { id: callId, promise } = this.pool.call('light', { cx, cz, columns }, {
        transfer: columns.map((c) => c.blocks),
      });
      // 记下本次输入各列的 (key → version)：回包写回前要校验「区域输入是否仍在途的是同一批」
      // （红线 7：版本协议而非 epoch/防抖）。
      const inputs = new Map();
      for (const c of columns) inputs.set(columnKey(c.cx, c.cz), c.version);
      this._inflightLight.set(key, { callId, inputs });
      promise.then((r) => this._onLightResult(key, r)).catch(() => {
        this._inflightLight.delete(key); // 失败：下帧由脏标记/邻居到达重试
      });
      dispatched++;
    }
  }

  /** LIGHT 结果：中心 column 权威写回（v1.8 修订，设计文档 §4.6/DR-14）。
   *  每列 light 只由以它为中心的 task 写回 —— 3×3 region 对中心列充分
   *  （15 的光水平最远影响 14 格 < 16，对角邻居最近格距本列边缘 2 格也在区域内），
   *  而邻列若被写回会遭 last-write-wins：后到的 task 其 region 可能不含该列的光源
   *  （房屋东窗/萤石在 region 外），先清零再用不完整光源重算 → 覆盖已收敛的好光
   *  （偶现全黑面 + 截断渐变环根因）。邻列只参与计算不写回，仅置脏重 mesh
   *  （边界脸采样中心列 light，需收敛）。
   *
   * 校验三层（缺一不可，都是「task 手里的输入已不是当前输入」→ 丢弃并重新入队）：
   *  ① **中心列**版本（旧有）：在途期间玩家编辑过 → 丢弃并重新入队，
   *     否则旧 light 会覆盖 setBlock 快路径已重算的垂直单列新值。
   *  ② **region 全部输入列**版本（2026-10-21 新增）：邻列 block 变了也要丢 —— 它们的
   *     version 不会因为「别列放了灯」而变，但它们的 blocks 已经变了（放的灯就在里面），
   *     旧 task 回包用的是旧 blocks → 写回去就是一次静默回退。
   *     实测现象面：灯光跨列时不收敛（需要再放一块才“好”）。
   *  ③ **输入集合**（2026-10-21 第二次修）：在途期间 3×3 里新到达的就绪列不在 `inputs` 里，版本比对
   *     看不见它；而它到达时的 `enqueueLight` 又因本 column「在途」被跳过 → 永远缺它的光。
   *
   * 脏标记打的是 **mesher 的 light 依赖者**，既不是「9 列 × 8 section 无条件全脏」（入队扩到 3×3
   * 后会把 mesh churn 放大 9 倍），也不是「light 字节变了的同 sy」（2026-10-21 第二次修的根因）：
   * mesher 的 faceLight 读的是面外邻格，所以格 (lx,ly,lz) 变化要通知 ① 它所在 section，
   * ② ly 在 section 最上/最下层时的上/下相邻 section，③ 边界层（lx/lz ∈ {0,15}）时的 4 个**正交**
   * 邻列同 sy。对角列不读本列 light。推导与 mesher 耦合见 `lighting.js` 的 `lightDirtyMasks`。
   * 实测症状：地表在 section 最上层（y=-1 沙滩）时，放灯后地面不亮 / 删灯后被照亮的面不变暗
   * —— **light 数据是对的，网格是旧的**。
   */
  _onLightResult(key, r) {
    const inflight = this._inflightLight.get(key);
    this._inflightLight.delete(key);
    const [ccx, ccz] = key.split(',').map(Number);

    // ② region 输入校验：回包里记录的输入版本 vs 当前实际版本（任一不符即整体丢弃）
    const inputs = inflight?.inputs;
    if (inputs) {
      for (const [nr, version] of inputs) {
        const [x, z] = nr.split(',').map(Number);
        const col = this.world.getColumn(x, z);
        if (!col || col.state !== 'ready') { this.enqueueLight(ccx, ccz); return; }
        if (col.version !== version) { this.enqueueLight(ccx, ccz); return; }
      }
      // ③ 输入**集合**也要一致：task 在途期间 3×3 里新到达了一个就绪列（可能带灯），它的 blocks 不在这次
      //    计算里，版本比对又看不见它（派发时根本没有它）。而新列到达时的 `enqueueLight` 恰好因这个 column
      //    「在途」而跳过了它 —— 不在这里补，这个 column 就永远缺一盏灯的光（column 边界处的光截断）。
      for (const [dx, dz] of LIGHT_REGION_OFFSETS) {
        if (inputs.has(columnKey(ccx + dx, ccz + dz))) continue;
        const ncol = this.world.getColumn(ccx + dx, ccz + dz);
        if (ncol && ncol.state === 'ready') { this.enqueueLight(ccx, ccz); return; }
      }
    }

    const center = this.world.getColumn(ccx, ccz);
    if (!center || center.state !== 'ready') return; // 已卸载：丢弃
    if (!r.light) { this.enqueueLight(ccx, ccz); return; } // 调用方漏送中心列：重试
    // ① 中心列版本（与 inputs 里的条目重复，但 task 可能来自不记 inputs 的旧路径/fixture）
    if (r.version !== undefined && center.version !== r.version) {
      this.enqueueLight(ccx, ccz);
      return;
    }
    const next = new Uint8Array(r.light);
    // 脏 section = **mesher 的 light 依赖者**，不是「light 字节变了的 section」（见 lightDirtyMasks 的推导）：
    // 本列含 Y 方向相邻 section（地表在 section 最上层时，地面读的是上一 section 最底层的格），
    // 邻列只含 4 个正交邻列且只在边界层变化时才置脏（对角列不读本列 light）。
    const masks = lightDirtyMasks(center.light, next);
    center.light.set(next);
    this._markDirtyByMask(center, masks.self);
    this._markDirtyByMask(this.world.getColumn(ccx - 1, ccz), masks.xm);
    this._markDirtyByMask(this.world.getColumn(ccx + 1, ccz), masks.xp);
    this._markDirtyByMask(this.world.getColumn(ccx, ccz - 1), masks.zm);
    this._markDirtyByMask(this.world.getColumn(ccx, ccz + 1), masks.zp);
  }

  /** 按掩码给（已就绪的）column 置脏 section；column 不存在/未就绪 → 忽略 */
  _markDirtyByMask(col, mask) {
    if (!col || col.state !== 'ready') return;
    for (let sy = 0; sy < SECTIONS_PER_COLUMN; sy++) if (mask[sy]) col.markDirty(sy);
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

  /** section 入 MESH 管线：在途挂起（in-flight 完成由 3b 重查补发——takeDirty 已消费
   *  脏标记，若此处直接早退会吞掉 light 写回等触发的重 mesh，陈旧几何永久残留）；
   *  已入下发队列跳过（dispatch 时读最新 view，天然含写回后的 light）；
   *  邻居未就绪挂起；否则进下发队列 */
  _enqueueMesh(cx, sy, cz) {
    const skey = sectionKey(cx, sy, cz);
    if (this._inflightMesh.has(skey)) { this._pendingMesh.add(skey); return; }
    if (this._meshQueuedSet.has(skey)) return;
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
      meta: view.meta.buffer,
      version,
    }, { transfer: [view.data.buffer, view.light.buffer, view.meta.buffer] });
    this._inflightMesh.set(skey, { callId });
    promise.then((r) => this._onMeshResult(skey, r)).catch(() => {
      this._inflightMesh.delete(skey); // 失败/取消：下帧由脏标记或邻居重查重试
    });
  }

  /** MESH 结果：版本校验 → 进上传队列 */
  _onMeshResult(skey, r) {
    this._inflightMesh.delete(skey);
    const col = this.world.getColumn(r.cx, r.cz);
    if (!col) return; // 已卸载：无处可发
    if (col.version !== r.version) {
      // 过期结果丢弃（§4.9）—— 但**丢弃的是结果，不是这份工作**：该 section 的脏标记在派发前就被
      // `takeDirty` 消费了，不重新置脏就再没有东西会要求它重 mesh，旧网格会永久残留
      // （2026-10-21 实测：light 写回把地面 section 置脏 → mesh 在途 → 同 column 任一编辑 version++
      // → 结果被丢 → 数据对、画面旧，3/3 复现）。与 `_onLightResult` 的「丢弃并重新入队」同一语义。
      this._redispatchDropped(col, r.sy);
      return;
    }
    this._uploadQueue.push({ cx: r.cx, sy: r.sy, cz: r.cz, channels: r.channels, version: r.version, stats: r.stats });
  }

  /** 被版本协议丢弃的 mesh 结果：重新置脏，下一帧 `takeDirty` 会以最新版本重新派发 */
  _redispatchDropped(col, sy) {
    col.markDirty(sy);
  }

  /** 上传预算：每帧 ≤budget.meshUploadBudgetMs（120Hz=3 / 60Hz=6），
   *  从队列取 section 调 renderWorld.uploadSection */
  _processUploadQueue() {
    const t0 = performance.now();
    // `meshUploadPerFrameLimit`（0 = 不限，只受 3ms 时间预算约束）：控制**视觉铺开节奏**。
    // 默认 0 = 一波内全部发布（帧时不受影响）；调小则地形逐格长出来，代价是加载总时长变长
    // （实测 2/帧 时飞完 600 帧仍剩 698 个 section 待发布）。见 budget.js 的 BUDGET_PROFILES 注释。
    let uploaded = 0;
    const lim = this.budget.meshUploadPerFrameLimit ?? 0;
    // ⚠️ 循环条件里**不能**只写 `uploaded < lim`：头部堆满「column 已卸载」的
    // 陈旧项时，每帧仅有的 1 个配额会被它们瞬间吃光，真正要上传的项永远轮不到
    // （实测 `?chunkpace=1` 时 slots 恒 0、队列只涨不消 4408→4380，而时间预算版
    // 不会暴露 —— 3ms 内能扫掉几千个无效项）。故无效项在下面 continue 时**退还配额**。
    while (this._uploadQueue.length && performance.now() - t0 < this.budget.meshUploadBudgetMs
           && (lim <= 0 || uploaded < lim)) {
      const item = this._uploadQueue.shift();
      const col = this.world.getColumn(item.cx, item.cz);
      if (!col) continue; // 已卸载：丢弃（不计入配额，见上）
      if (col.version !== item.version) { // 排队等预算期间已变更：丢弃并重发（理由同 `_onMeshResult`）
        this._redispatchDropped(col, item.sy);
        continue; // 同样不计入配额
      }
      uploaded++;
      for (const channel of CHANNELS) {
        this.renderWorld.uploadSection(item.cx, item.sy, item.cz, channel, unpackGeom(item.channels[channel]), item.version);
      }
      const skey = sectionKey(item.cx, item.sy, item.cz);
      this._meshedSections.add(skey);
      if (item.stats) this._sectionStats.set(skey, item.stats);
    }
    // 每帧上传实际耗时打点（M3-5 基线采集：§4.9「mesh 上传 ≤3ms/帧」的直接观测）
    if (this.perf) this.perf.mark('upload-ms', performance.now() - t0);
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
      this._sectionStats.delete(skey);
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
      if (data.stats) this._sectionStats.set(sectionKey(cx, sy, cz), data.stats);
      if (this.perf) this.perf.mark('fast-remesh', performance.now() - t0);
    }
  }

  stats() {
    // M4：保留既有字段，追加只读队列观测值（只读已有容器的 size/length，不参与调度分支）。
    // Playwright 据此对「队列已收敛、无过期 mesh 写回」作直接断言（weapons-performance/world-edit）。
    return {
      inflight: this._inflightGen.size,
      genInflight: this._inflightGen.size,
      ready: this.world.columns.size,
      meshInflight: this._inflightMesh.size,
      meshQueued: this._meshQueue.length,
      pendingMesh: this._pendingMesh.size,
      uploadQueue: this._uploadQueue.length,
      sections: this._meshedSections.size,
      lightInflight: this._inflightLight.size,
      lightQueued: this._lightQueue.size,
      // M5：两阶段卸载只读诊断（只观测 _pendingColumnUnloads / 最近错误，不驱动调度决策）
      pendingUnloads: this._pendingColumnUnloads.size,
      lastUnloadError: this._lastUnloadError,
    };
  }

  /**
   * 世界体素/面剔除统计（HUD 世界数据看板，§4.3）。
   * 汇总所有已上传 section 的 mesher 统计：方块数、候选面、出块面、剔除面、顶点数。
   * 剔除率 = culled / candidate，反映面剔除节省的渲染面数。
   */
  worldStats() {
    let blocks = 0, candidateFaces = 0, faces = 0, culledFaces = 0, vertices = 0;
    for (const s of this._sectionStats.values()) {
      blocks += s.blocks;
      candidateFaces += s.candidateFaces;
      faces += s.faces;
      culledFaces += s.culledFaces;
      vertices += s.vertices;
    }
    return {
      blocks,
      candidateFaces,
      faces,
      culledFaces,
      vertices,
      cullRatio: candidateFaces > 0 ? culledFaces / candidateFaces : 0,
      sectionCount: this._sectionStats.size,
    };
  }
}
