// src/gen/structure-index.js — StructureIndex：主线程布局缓存 + GEN 门控（设计文档 §4.2/DR-13）
// 布局由 Worker 'layout' RPC 计算（候选扫描较重，不放主线程防卡帧），
// 主线程缓存后随 GEN 任务参数下发；各 GEN Worker 只做 rasterize，不重复跑候选发现。

import { neighborRegionKeys } from './structures/structure-layout.js';

/** 全局布局 key：City / RedCity 的持有者 region(0,0)（CITY_REGION 语义） */
const GLOBAL_LAYOUT_KEY = '0,0';

/** 每帧布局任务下发预算（region(0,0) 含城市布局 ~12ms，限制在途避免阻塞 GEN/MESH 队列） */
const LAYOUT_DISPATCH_PER_FRAME = 4;

export class StructureIndex {
  /**
   * @param {Object} opts
   * @param {import('../core/worker-pool.js').WorkerPool} opts.pool
   * @param {number} opts.seed
   */
  constructor({ pool, seed }) {
    this.pool = pool;
    this.seed = seed;
    /** @type {Map<string, Object>} regionKey → 布局 */
    this._layouts = new Map();
    /** @type {Map<string, number>} regionKey → 在途 layout 任务 callId */
    this._inflight = new Map();
    /** 待请求布局队列：[{key, regionX, regionZ, prio}]，prio 小（近玩家）优先 */
    this._pending = [];
    this._pendingKeys = new Set();
  }

  /**
   * 一个 column 的 GEN 需要的 region 布局 key：3×3 查询域 + 全局 (0,0)。
   * (0,0) 持有全世界唯一的 City / RedCity 布局，RedCity 不走 3×3 查询域（影响域越界 60/80 个 seed）。
   */
  _requiredKeys(cx, cz) {
    const keys = neighborRegionKeys(cx, cz);
    if (!keys.includes(GLOBAL_LAYOUT_KEY)) keys.push(GLOBAL_LAYOUT_KEY);
    return keys;
  }

  /** column 的 GEN 门控：查询域 + 全局 (0,0) 布局就绪才放行（§4.2 依赖规则）。否则早到的 column 会永久缺 RedCity */
  readyForColumn(cx, cz) {
    for (const key of this._requiredKeys(cx, cz)) {
      if (!this._layouts.has(key)) return false;
    }
    return true;
  }

  /** 全世界唯一的 RedCity 布局（region(0,0) 持有；未就绪 → null）。随每个 gen 任务全局下发，见 spec §13.3.2 */
  redCity() { return this._layouts.get(GLOBAL_LAYOUT_KEY)?.redCity ?? null; }

  /** 把 column 查询域内缺失的 region 布局加入请求队列（去重；调度器每帧 drain） */
  ensureForColumn(cx, cz, prio = 0) {
    for (const key of this._requiredKeys(cx, cz)) {
      if (this._layouts.has(key) || this._inflight.has(key) || this._pendingKeys.has(key)) continue;
      const [regionX, regionZ] = key.split(',').map(Number);
      this._pending.push({ key, regionX, regionZ, prio });
      this._pendingKeys.add(key);
    }
  }

  /** 每帧调用：按预算与优先级下发布局任务（近玩家先就绪 → 出生圈 GEN 不堵） */
  dispatch() {
    if (this._pending.length === 0) return;
    this._pending.sort((a, b) => a.prio - b.prio);
    let dispatched = 0;
    while (this._pending.length && dispatched < LAYOUT_DISPATCH_PER_FRAME) {
      const { key, regionX, regionZ } = this._pending.shift();
      this._pendingKeys.delete(key);
      if (this._layouts.has(key) || this._inflight.has(key)) continue;
      const { id, promise } = this.pool.call('layout', { regionX, regionZ, seed: this.seed });
      this._inflight.set(key, id);
      promise.then((layout) => {
        this._layouts.set(key, layout);
        this._inflight.delete(key);
      }).catch(() => {
        this._inflight.delete(key); // 失败：下帧 ensure 重试
      });
      dispatched++;
    }
  }

  /** column 查询域内的全部布局（readyForColumn 为 true 时调用） */
  layoutsForColumn(cx, cz) {
    const out = [];
    for (const key of neighborRegionKeys(cx, cz)) {
      const layout = this._layouts.get(key);
      if (layout) out.push(layout);
    }
    return out;
  }

  /** 等待单个 region 布局就绪（出生点选择等启动关键路径用） */
  waitForRegion(regionX, regionZ, timeoutMs = 5000) {
    const key = `${regionX},${regionZ}`;
    this.ensureForColumn(regionX * 25, regionZ * 25); // 复用队列入口（该 column 查询域含目标 region）
    return new Promise((resolve, reject) => {
      const t0 = performance.now();
      const timer = setInterval(() => {
        if (this._layouts.has(key)) { clearInterval(timer); resolve(this._layouts.get(key)); }
        else if (performance.now() - t0 > timeoutMs) { clearInterval(timer); reject(new Error(`layout timeout: ${key}`)); }
        else this.dispatch(); // 启动关键路径：驱动下发（主循环尚未开始）
      }, 20);
    });
  }
}
