// src/core/load-watchdog.js — 启动进展计时器（v2.99）
//
// ## 为什么需要这一层
//
// 旧实现的启动失败判据是两处**绝对超时**：`StructureIndex.waitForRegion` 5 秒、
// `Game._waitForColumn` 10 秒。实测（真实部署 trace + 本机 250KB/s + 300ms 限速）：
// 慢网络下 worker 模块图（每个 worker 52 个模块 / 905 KiB，池大小 14）要 **90.9 秒**
// 才回第一个包 —— 布局任务根本还没被执行，5 秒预算差了两个数量级。
//
// 结果是「网络慢」被误报成「**无法启动渲染** / column 加载超时」，玩家照提示换浏览器无效。
// 用户的要求是：**只要网络不断，就一个个把脚本加载完成**。
//
// ## 双判据（缺一不可）
//
//   ① **零进展**（`stallMs`，默认 60s）：识别「真断了 / 挂死」。有进展就永不触发 ——
//      这是「慢但不断线不得误杀」的全部实现。
//   ② **总时长**（`hardCapMs`，默认 10 分钟）：识别「极慢假死网络」（每 59s 挪一格可以
//      永远骗过 ①）。它**不是**自动失败 —— 只让 UI 把诊断与自救入口亮出来。
//
// ⚠️ **两个判据都只驱动 UI，从不驱动 reject**（见 `progress.md` 的用户裁定与实施计划
// Task 5）：一旦这里能让等待循环 reject，`boot()` 就会落到 `showError`，玩家看到
// 「无法启动渲染」错误遮罩 —— 那正是本 Epic 要消灭的形态。等待循环只在**资源真到了**
// 之后结束。
//
// ## 时间基准
//
// 统一 `performance.now()`（毫秒、单调、不受系统时钟调整影响）。**不得用 `Date.now()`** ——
// 本仓踩过：两者相差约 17 亿毫秒，任何「距上次进展多久」的判定会恒真或恒假。
// `now` 可注入，单测用假时钟把边界钉到毫秒（真等待会让 harness 整页耗时不可控）。
//
// ## 单一权威
//
// 全仓**只允许存在一个实例**：`main.js` 建 → `new Game({ watchdog })` → `Scheduler` →
// `StructureIndex`。两个实例会让 `main.js` 看到的 stalled 与等待循环用的那份脱钩
// （症状：面板永不出现，或等待循环放弃而 UI 还在转）。

/** 零进展阈值（毫秒）。60s 取自实测：慢网络下模块仍在逐个到达，间隔远小于此。 */
const DEFAULT_STALL_MS = 60_000;

/** 总时长上限（毫秒）。10 分钟 = 实测 158s 那一档的 ~4 倍余量。 */
const DEFAULT_HARD_CAP_MS = 600_000;

export class LoadWatchdog {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.stallMs] 零进展多少毫秒判 stall
   * @param {number} [opts.hardCapMs] 总时长多少毫秒判 hard-cap
   * @param {() => number} [opts.now] 时间源（注入假时钟用；缺省 performance.now）
   */
  constructor({ stallMs = DEFAULT_STALL_MS, hardCapMs = DEFAULT_HARD_CAP_MS, now } = {}) {
    this.stallMs = stallMs;
    this.hardCapMs = hardCapMs;
    this._now = now || (() => performance.now());
    this._t0 = this._now();
    this._lastProgressAt = this._t0;
    /** 本次 stall 是否已上报过（保证一次卡顿只弹一次面板） */
    this._stallReported = false;
  }

  /**
   * 上报一次「有进展」。
   *
   * ⚠️ **调用方必须真的拿到了东西**（新 column 就绪 / 布局到了 / 资源条目增加），
   * **不能**用「有在途任务」代替 —— 挂死的请求会让这里每 50ms 被喂一次，stall 永不触发，
   * 玩家对着一根冻住的进度条无限等（实施计划 Review Focus 第 6 条）。
   *
   * 不清 `_stallReported`：卡了一下又动一格不该再弹一次面板（那正是「网络抖动」的常态）。
   */
  notifyProgress() {
    this._lastProgressAt = this._now();
  }

  /**
   * 查询当前判据状态。**幂等、可高频调用**（UI 每 100ms 一次）。
   *
   * @returns {'ok'|'stall'|'hard-cap'}
   *   - `'stall'`：零进展已达 `stallMs`，且**本次卡顿尚未上报过**（下一次调用回 `'ok'`）
   *   - `'hard-cap'`：总时长已达 `hardCapMs`（每次调用都返回，直到 `reset()`）
   */
  poll() {
    const now = this._now();
    if (now - this._t0 >= this.hardCapMs) return 'hard-cap';
    if (!this._stallReported && now - this._lastProgressAt >= this.stallMs) {
      this._stallReported = true;
      return 'stall';
    }
    return 'ok';
  }

  /**
   * 重置两个计时器（玩家点「继续等待」）。可反复调用。
   *
   * 重置 `_t0` 是刻意的：hard-cap 的语义是「这一轮等待的总时长」，玩家主动续期就是新的一轮。
   * 否则到达 10 分钟后面板会一直亮着，点「继续等待」毫无效果。
   */
  reset() {
    this._t0 = this._now();
    this._lastProgressAt = this._t0;
    this._stallReported = false;
  }

  /** @returns {{stalled: boolean, elapsedMs: number, sinceProgressMs: number}} */
  state() {
    const now = this._now();
    return {
      stalled: this._stallReported,
      elapsedMs: now - this._t0,
      sinceProgressMs: now - this._lastProgressAt,
    };
  }
}
