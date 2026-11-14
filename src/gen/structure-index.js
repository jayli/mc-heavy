// src/gen/structure-index.js — StructureIndex：主线程布局缓存 + GEN 门控（设计文档 §4.2/DR-13）
// 布局由 Worker 'layout' RPC 计算（候选扫描较重，不放主线程防卡帧），
// 主线程缓存后随 GEN 任务参数下发；各 GEN Worker 只做 rasterize，不重复跑候选发现。

import { neighborRegionKeys } from './structures/structure-layout.js';

/** 每帧布局任务下发预算（region(0,0) 含城市布局 ~12ms，限制在途避免阻塞 GEN/MESH 队列） */
const LAYOUT_DISPATCH_PER_FRAME = 4;

export class StructureIndex {
  /**
   * @param {Object} opts
   * @param {import('../core/worker-pool.js').WorkerPool} opts.pool
   * @param {number} opts.seed
   * @param {import('../core/load-watchdog.js').LoadWatchdog} [opts.watchdog]
   *        启动进展计时器（v2.99，**全仓唯一实例**，由 Game 经 Scheduler 传入）。
   *        缺省 null → 退化为旧行为（只等，不报 stall）。
   */
  constructor({ pool, seed, watchdog = null }) {
    this.pool = pool;
    this.seed = seed;
    /** 启动进展计时器（单一权威，见 `core/load-watchdog.js` 的注释） */
    this._watchdog = watchdog;
    /**
     * 零进展时的通知回调（单槽，由 `main.js` 赋值）。
     * ⚠️ **只通知，不中断等待** —— `waitForRegion` 永不因 stall 落定（见它的注释）。
     * @type {((verdict: 'stall'|'hard-cap') => void) | null}
     */
    this.onStalled = null;
    /** @type {Map<string, Object>} regionKey → 布局 */
    this._layouts = new Map();
    /** @type {Map<string, number>} regionKey → 在途 layout 任务 callId */
    this._inflight = new Map();
    /** 待请求布局队列：[{key, regionX, regionZ, prio}]，prio 小（近玩家）优先 */
    this._pending = [];
    this._pendingKeys = new Set();
  }

  /** column 的 GEN 门控：查询域内全部 region 布局就绪才放行（§4.2 依赖规则） */
  readyForColumn(cx, cz) {
    for (const key of neighborRegionKeys(cx, cz)) {
      if (!this._layouts.has(key)) return false;
    }
    return true;
  }

  /** 把 column 查询域内缺失的 region 布局加入请求队列（去重；调度器每帧 drain） */
  ensureForColumn(cx, cz, prio = 0) {
    for (const key of neighborRegionKeys(cx, cz)) {
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
        // 进展信号：**布局真的到了**才算（不是「有在途任务」）。
        // ⚠️ 把 `_inflight.size > 0` 当进展会让挂死的请求永远喂饱 watchdog，
        // stall 永不触发、诊断面板永不出现（实施计划 Review Focus 第 6 条）。
        if (this._watchdog) this._watchdog.notifyProgress();
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

  /**
   * 等待单个 region 布局就绪（出生点选择等启动关键路径用）。
   *
   * ## 为什么不再用绝对超时，而且 stall 时也不 reject（v2.99）
   *
   * 旧实现 5 秒后抛 `layout timeout: 0,0`。实测（真实部署 trace + 本机 250KB/s 限速）：
   * 慢网络下 worker 模块图 52 个模块要 **90.9 秒**才回第一个包 —— 布局任务根本还没被执行，
   * 5 秒预算差了两个数量级。它把「网络慢」误报成「世界生成失败」。
   *
   * 现在只看「有没有进展」：零进展 60 秒 / 总时长 10 分钟 → 经 `onStalled` 通知 UI 弹
   * 诊断面板，**但 Promise 继续挂着**。用户要求「只要网络不断就一个个加载完」——
   * reject 会让游戏彻底起不来（`boot()` 落到 `showError`），正是要消灭的形态。
   * 等布局真到了就照常 resolve。
   *
   * ⚠️ **进展信号只能是「结果到了」，不能是「有在途任务」**：见 `dispatch()` 里的注释。
   *
   * @param {number} regionX @param {number} regionZ
   * @param {import('../core/load-watchdog.js').LoadWatchdog} [watchdog] 缺省用构造时注入的那个
   * @returns {Promise<Object>} 该 region 的布局
   */
  waitForRegion(regionX, regionZ, watchdog = null) {
    const wd = watchdog || this._watchdog;
    const key = `${regionX},${regionZ}`;
    this.ensureForColumn(regionX * 25, regionZ * 25); // 复用队列入口（该 column 查询域含目标 region）
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        if (this._layouts.has(key)) { clearInterval(timer); resolve(this._layouts.get(key)); return; }
        if (wd) {
          const verdict = wd.poll();
          // 只通知 UI，**不** clearInterval、**不** reject
          if ((verdict === 'stall' || verdict === 'hard-cap') && this.onStalled) this.onStalled(verdict);
        }
        this.dispatch(); // 启动关键路径：驱动下发（主循环尚未开始）
      }, 20);
    });
  }
}
