// src/save/persistence.js — IndexedDB edits 持久化（§4.8，DR-6）
// 只存玩家改过的方块（edits 稀疏层），加载 = GEN 时叠加，无"整图恢复"阶段。

const DB_NAME = 'mc_heavy_saves';
const DB_VERSION = 1;

export class Persistence {
  constructor() {
    this.db = null;
    /** @type {Map<string, Array<{index:number,id:number,meta:number}>>} 内存缓存 */
    this.editsCache = new Map();
    this._flushTimer = null;
  }

  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('edits')) db.createObjectStore('edits', { keyPath: 'columnKey' });
      };
      req.onsuccess = () => { this.db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
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

  /** 立即 flush（页面隐藏/退出/测试用） */
  async flushNow(world) {
    if (!world) return;
    const jobs = [];
    for (const [key, col] of world.columns) {
      if (col.edits.size === 0) continue;
      const arr = [...col.edits.entries()].map(([index, e]) => ({ index, id: e.id, meta: e.meta }));
      jobs.push(this.saveColumnEdits(key, arr));
    }
    await Promise.all(jobs);
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
