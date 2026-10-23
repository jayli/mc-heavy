// src/save/persistence.js — IndexedDB edits 持久化（§4.8，DR-6）
// 只存玩家改过的方块（edits 稀疏层），加载 = GEN 时叠加，无"整图恢复"阶段。
// M5 起追加 `entities` store：炮塔/矿车等**持久**运行时实体的最小 snapshot
// （丧尸等临时实体不写盘，见 M5 规格 §1/§3）。
import { columnKeyAt } from '../voxel/constants.js';

const DB_NAME = 'mc_heavy_saves';
// M5：v1 → v2 新增 `entities` object store（持久实体 snapshot）。
// 升级路径只「不存在时创建」（`onupgradeneeded` 的幂等写法），旧库的 meta/edits 原样保留 ——
// 老存档不会因升级丢失（M5 规格 §3）。
const DB_VERSION = 2;

export class Persistence {
  constructor() {
    this.db = null;
    /** @type {Map<string, Array<{index:number,id:number,meta:number}>>} 内存缓存 */
    this.editsCache = new Map();
    /**
     * 持久实体 snapshot 内存缓存（M5）：`Map<id, {id,type,state}>`。
     * 与 `editsCache` 同一理由 —— column ready 回调是**同步**的（`Scheduler._onGenResult`），
     * 恢复该 column 的持久实体时不能 await IndexedDB。启动时一次性 `loadEntities()` 预热，
     * 之后按 `state.position` 所属 column 过滤即可（M5 规格 §3「不得扫描整世界」）。
     */
    this.entitiesCache = new Map();
    this._flushTimer = null;
  }

  /**
   * 打开存档库。
   *
   * **库版本高于本代码声明时自愈重建**：IndexedDB 不允许 `open` 一个低于现有版本的库
   * （抛 `VersionError`），而浏览器里的库版本是**跨分支残留的持久状态** —— git 切分支/
   * 回撤都改不到它。实测成因（2026-10）：RedCity 分支把版本提到 3 并按 D7 清库，切回
   * 未含 RedCity 的分支（声明 2）后每次启动都 VersionError；`main.js` 的 `boot().catch`
   * 把它显示成通用的「浏览器不支持 WebGPU」→ 表现为白屏 + 误导提示（`webgpu:true`）。
   *
   * 自愈语义 = 删库重建（等价于全新世界）：版本更高的库必然由**别的代码版本**写过，
   * 其 edits/meta 对当前世界生成逻辑没有意义（RedCity 那次正是「世界生成变了→旧档作废」）。
   * 这条只在前置版本真的更高时触发，正常 v2 存档库重开**不会**被清（`db-version-heal.spec`
   * 第二个用例钉住「不误伤」）。
   */
  open() {
    return this._openAtVersion(true);
  }

  /**
   * @param {boolean} allowHeal 版本高于期望时是否删库重建（内部递归时传 false，只重试一次）
   */
  _openAtVersion(allowHeal) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('edits')) db.createObjectStore('edits', { keyPath: 'columnKey' });
        // M5：只在不存在时创建（幂等 —— 旧库升级到 v2 时 meta/edits 已在，不得重建）
        if (!db.objectStoreNames.contains('entities')) db.createObjectStore('entities', { keyPath: 'id' });
      };
      req.onsuccess = () => { this.db = req.result; resolve(); };
      req.onerror = (e) => {
        const err = req.error;
        // 版本更高的残留库：删掉重建一次。`e.preventDefault()` 不必要 —— 我们主动 reject
        // 后由下一轮 open 接管，事件本身不会再冒到 window。
        if (allowHeal && err && err.name === 'VersionError') {
          this._deleteDatabase().then(
            () => this._openAtVersion(false).then(resolve, reject),
            reject,
          );
          return;
        }
        reject(err);
      };
    });
  }

  /**
   * 删除整个存档库（仅供 `_openAtVersion` 的自愈路径使用）。
   * 必须正确处理 `onblocked`：其他标签页还开着旧库时删除会被阻塞，此时不能挂起 ——
   * 直接 reject 让启动失败并给出明确错误，比静默白屏好。
   */
  _deleteDatabase() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => {
        console.warn(`[persistence] 存档库版本高于当前代码（期望 v${DB_VERSION}），已删除重建（旧存档作废）`);
        resolve();
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error(
        '存档库需要重建，但被其他 mc-heavy 标签页占用：请关闭该页面的其他标签后重新打开',
      ));
    });
  }

  saveMeta(obj) {
    return this._put('meta', { ...obj, key: 'main' });
  }

  loadMeta() {
    return this._get('meta', 'main');
  }

  /** @param {string} columnKey @param {Array<{index:number,id:number,meta:number}>} editsArray */
  saveColumnEdits(columnKey, editsArray) {
    this.editsCache.set(columnKey, editsArray);
    return this._put('edits', { columnKey, edits: editsArray });
  }

  /** @returns {Promise<Array>} 缺失返回 [] */
  async loadColumnEdits(columnKey) {
    if (this.editsCache.has(columnKey)) return this.editsCache.get(columnKey);
    const row = await this._get('edits', columnKey);
    const edits = row ? row.edits : [];
    this.editsCache.set(columnKey, edits);
    return edits;
  }

  /** 批量预热（启动时调用，GEN 前缓存必命中） */
  async preloadEdits(keys) {
    await Promise.all(keys.map((k) => this.loadColumnEdits(k)));
  }

  /** 同步查缓存（Scheduler.getEdits 用，GEN 前必须已 preload） */
  getEditsSync(columnKey) {
    return this.editsCache.get(columnKey) || [];
  }

  /** 防抖 flush：5s 后把 world 内所有有 edits 的 column 写盘（§4.8） */
  scheduleFlush(world) {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flushNow(world);
    }, 5000);
  }

  /** 取消在途防抖 flush（M3-4 新世界：clearAllEdits 后不得再写回旧 edits） */
  cancelPendingFlush() {
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
  }

  /** 立即 flush（页面隐藏/退出/测试用） */
  async flushNow(world) {
    if (!world) return;
    const jobs = [];
    for (const [key, col] of world.columns) {
      if (col.edits.size === 0) continue;
      // `blockEntity` 必须一起序列化（M7）：它是巢穴锚点的持久载体。
      // 此处曾硬编码 `{index,id,meta}` → 锚点富状态被静默丢弃（重启后巢穴失效）。
      // 无 entity 的 edit 不写该字段（保持存档紧凑，且 undefined 在 structuredClone 下会丢）。
      const arr = [...col.edits.entries()].map(([index, e]) => {
        const row = { index, id: e.id, meta: e.meta };
        if (e.blockEntity !== undefined && e.blockEntity !== null) row.blockEntity = e.blockEntity;
        return row;
      });
      jobs.push(this.saveColumnEdits(key, arr));
    }
    await Promise.all(jobs);
  }

  // ==================== 进度导入导出（设置面板） ====================

  /**
   * 枚举 edits store 中**全部** column 的改动（进度导出用）。
   *
   * 与 `listBlockEntities` 的区别：那个按 `kind` 过滤只要数个锚点，本方法要完整稀疏层 ——
   * 二者共用「cursor 扫库而非 getAll」的手法（存档可能含成百上千 column 的 edits 行，
   * 但进度导出本就要全量，故此处逐行收集而不做过滤）。
   * @returns {Promise<Array<{columnKey: string, edits: Array<Object>}>>}
   */
  listEdits() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('edits', 'readonly');
      const req = tx.objectStore('edits').openCursor();
      const out = [];
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(out); return; }
        const value = cursor.value;
        if (value?.columnKey && Array.isArray(value.edits)) {
          out.push({ columnKey: value.columnKey, edits: value.edits });
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * 枚举 edits store 中所有带指定 kind 的 blockEntity（M7）。
   *
   * 为什么必须扫**库**而不是扫已加载 column：「全局最多 8 个巢穴」要跨 column 卸载与重启
   * 仍有效。远处巢穴可能只存在于存档里（其 column 未加载、无 controller），
   * 若以当前 controller 数量判断上限，玩家走远再回来就能无限放巢穴（M7 规格 §2）。
   * 走 IndexedDB cursor 而非 `getAll()` —— 存档可能含成百上千 column 的 edits 行，
   * 只为数几个锚点把整库读进内存没必要（M5 规格 §3「不得扫描整世界」同源原则）。
   * @param {string} kind
   * @returns {Promise<Array<{columnKey: string, index: number, blockEntity: Object}>>}
   */
  listBlockEntities(kind) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('edits', 'readonly');
      const req = tx.objectStore('edits').openCursor();
      const out = [];
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(out); return; }
        const edits = cursor.value?.edits || [];
        for (const edit of edits) {
          if (edit?.blockEntity?.kind === kind) {
            out.push({ columnKey: cursor.value.columnKey, index: edit.index, blockEntity: edit.blockEntity });
          }
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  // ==================== M5：持久实体 snapshot ====================

  /**
   * 接线实体 snapshot 来源（Game.start 调用）。
   * Persistence 不 import EntityManager —— 注入一个纯函数保持 save/ 与 entities/ 解耦，
   * 也让 fixture/测试能塞替身。
   * @param {() => Array<{id: string, type: string, state: object}>} serializer
   */
  attachEntities(serializer) { this._entitiesSerializer = serializer; }

  /**
   * 写一批持久 snapshot（**upsert**，不是整库替换）。
   *
   * 为什么必须 upsert 而非 clear+write：一次 column 卸载只保存**该 column** 的持久实体
   * （M5 规格 §3「不得扫描整世界」）。若整库替换，其它 column 的持久实体会在这次写盘里
   * 被抹掉 —— 玩家走一圈回来，远处的炮塔全没了。
   * @param {Array<{id: string, type: string, state: object}>} snapshots
   * @returns {Promise<void>}
   */
  async saveEntities(snapshots) {
    if (!Array.isArray(snapshots)) return;
    if (snapshots.length === 0) return;
    await new Promise((resolve, reject) => {
      const tx = this.db.transaction('entities', 'readwrite');
      const store = tx.objectStore('entities');
      for (const snapshot of snapshots) {
        if (!snapshot || typeof snapshot.id !== 'string') continue;
        store.put({ id: snapshot.id, type: snapshot.type, state: snapshot.state });
        this.entitiesCache.set(snapshot.id, snapshot);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('entities transaction aborted'));
    });
  }

  /**
   * 读全部持久 snapshot。**缺失返回 `[]` 而不是 null**（M5 plan Task 2）。
   * 顺带预热 `entitiesCache` —— column ready 回调是同步的，恢复该 column 的持久实体时
   * 不能 await IndexedDB。
   * @returns {Promise<Array<{id: string, type: string, state: object}>>}
   */
  loadEntities() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('entities', 'readonly');
      const req = tx.objectStore('entities').getAll();
      req.onsuccess = () => {
        const rows = req.result || [];
        this.entitiesCache.clear();
        for (const row of rows) this.entitiesCache.set(row.id, row);
        resolve(rows);
      };
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * 同步查缓存里属于某个 column 的 snapshot（column ready 时恢复用）。
   * 按 `state.position` 过滤 —— 只有这个判据，不扫世界、不读盘。
   * @param {string} key @returns {Array<{id: string, type: string, state: object}>}
   */
  entitiesForColumn(key) {
    const out = [];
    for (const snapshot of this.entitiesCache.values()) {
      const position = snapshot.state?.position;
      if (!Array.isArray(position) || position.length !== 3) continue;
      // column 归属判据 = voxel/constants.js 的 columnKeyAt（与实体的派生索引同一份权威）
      if (columnKeyAt(position[0], position[2]) === key) out.push(snapshot);
    }
    return out;
  }

  /**
   * 立即 flush 当前全部活着的持久 snapshot（测试 / 页面隐藏 / 退出）。
   * 同样是 upsert：已卸载实体的 snapshot 不在 serializer 输出里，也不会被删掉。
   *
   * M5 的 flush 时机只有两处（M5 规格 §3「持久实体创建、销毁、显式状态变化或页面隐藏」）：
   * ① column 卸载时 `saveEntities(snapshots)`（只写该 column）；② 页面隐藏/退出 flushEntities
   * （写全部活着的）。M5 只有静态 probe、无持续变状态的持久实体，故不做防抖脏标记 flush
   * —— 那是给未来会移动的持久实体准备的，现在加是无调用者的死代码（计划外补丁）。
   * @returns {Promise<void>}
   */
  async flushEntities() {
    if (typeof this._entitiesSerializer !== 'function') return;
    await this.saveEntities(this._entitiesSerializer());
  }

  /**
   * 删除单个持久 snapshot（矿车拾取/销毁用）。
   * **M5 持久层首个单删 API**：矿车是第一个可被单独销毁的持久实体（炮塔/巢穴走 blockEntity
   * edits store；弹丸/丧尸是临时实体）→ M5 从未需要单删。缺它会让已销毁实体的 snapshot
   * 永久留在 store —— ① `count()` 把死车计入全局上限（50 次放/拾后永久放不出车）；
   * ② reload 时 `entitiesForColumn` 把死车恢复出来。
   * ⚠️ 与 `saveEntities` 的 upsert 语义互补：put 负责写、delete 负责删，两者共同维护
   * store 与内存的一致性。
   * @param {string} id @returns {Promise<void>}
   */
  deleteEntity(id) {
    this.entitiesCache.delete(id);
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('entities', 'readwrite');
      tx.objectStore('entities').delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /** 清空全部持久 snapshot（新世界 / 删除缓存：旧世界的装置不得带入） */
  clearAllEntities() {
    this.entitiesCache.clear();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('entities', 'readwrite');
      tx.objectStore('entities').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /** 测试钩子 */
  countSavedColumns() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('edits', 'readonly');
      const req = tx.objectStore('edits').count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /** 清空全部 edits（M3-4 新世界：旧世界的玩家修改不得带入新 seed） */
  clearAllEdits() {
    this.editsCache.clear();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('edits', 'readwrite');
      tx.objectStore('edits').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  _put(store, value) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  _get(store, key) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }
}
