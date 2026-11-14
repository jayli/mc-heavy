// src/core/load-progress.js — 启动进度三阶段合成（v2.99）
//
// 纯函数 + 一个小状态对象：**无 DOM、无 timer、无 three**。UI 写入留在 `main.js`，
// 这样这里的三条不变式（单调、渐近、夹边界）可以在浏览器内单测里逐条钉住，不必起页面。
//
// ## 三阶段与权重（设计文档 DR-2）
//
//   P1 脚本与资源下载  45%  —— 分母**不可知**，用渐近曲线
//   P2 世界生成        45%  —— 分母 = (2·viewDistance+1)² 个 column
//   P3 首帧渲染        10%  —— 二值
//
// P2 用 `scheduler.stats().ready`（GEN 完成的 column 数）而不是 `sections`（网格上传数）：
// 后者在同一时刻只有个位数，进度条看着像卡住（实测 vd=2：ready 23/25 而 sections 才 8）。
//
// ## 为什么 P1 必须是渐近曲线而不是 n/total
//
// 模块图是浏览器**边解析边发现边请求**的，事前没有任何 API 能给出总数（实测首页 874 个模块
// 请求，其中 723 个来自 14 个 Worker 各自的模块图）。要「n/total」就必须猜分母，猜错的表现是
// 进度条在某个值上**永久冻住** —— 比不给百分比更糟。
//
// 渐近曲线 `1 - 1/(1 + n/24)` 给的是「一直在动、越来越慢」的正确感受，且天然单调
// （n 恒增 ⇒ p 恒增）。`P1_HALF_POINT = 24` 来自实测：本地首屏 151 个模块，24 让最初的
// 10% 在头几秒内就发生（慢网络下也是），玩家不会开局就对着 0% 怀疑坏了。
//
// ⚠️ 渐近曲线的代价是**永远到不了 1**（n 有限时 < 1）。这不是缺陷：P1 结束后由阶段切换
// 把进度交给 P2，而 `createProgressReporter` 取历史最大值保证不倒退。

/** 三阶段权重。和为 1（单测钉住）。 */
export const PHASE_WEIGHTS = Object.freeze({ p1: 0.45, p2: 0.45, p3: 0.10 });

/**
 * P1 渐近曲线的半程点：已加载这么多个模块时进度走到 0.5。
 * 取 24 的推导见文件头（实测首屏 151 个模块）。
 */
const P1_HALF_POINT = 24;

/**
 * P1 进度（渐近、单调、值域 [0,1)）。
 * @param {number} modulesLoaded 已完成加载的模块/resource 条目数
 * @returns {number}
 */
export function p1Fraction(modulesLoaded) {
  const n = Number(modulesLoaded);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return 1 - 1 / (1 + n / P1_HALF_POINT);
}

/**
 * P2 进度（线性，夹到 [0,1]）。
 * @param {number} readyColumns 已就绪的 column 数（`scheduler.stats().ready`）
 * @param {number} totalColumns 加载半径内的 column 总数 `(2·vd+1)²`
 * @returns {number}
 */
export function p2Fraction(readyColumns, totalColumns) {
  const total = Number(totalColumns);
  if (!Number.isFinite(total) || total <= 0) return 0;
  const ready = Number(readyColumns);
  if (!Number.isFinite(ready) || ready <= 0) return 0;
  return Math.min(1, ready / total);
}

/**
 * P2 阶段**显示用**的归一化值：取「已下载脚本」与「已就绪 column」两者的较大者。
 *
 * ## 为什么必须有这一层（v2.99 实测缺陷 A 的回归点）
 *
 * P2 从 `new Game()` 之后开始，但 `game.start()` 里的 GEN 要等 Worker 模块图到齐才跑得起来。
 * 慢网络下这个空窗期很长（实测 200KB/s：Worker 模块图 90 秒才回第一个包），期间
 * `scheduler.stats().ready` **恒为 0**。
 *
 * 只算 P2 的后果：进度条冻在 P1 结束时的值（实测 39.2%）一动不动，而资源从 161 个
 * 涨到 852 个 —— 玩家看到的是一个「卡死」的进度条，正是本 Epic 要消灭的形态。
 *
 * 两者都是「已经完成多少」的合法度量：
 *   · `p1Fraction(js)` —— 脚本还在陆续到达（渐近上升）
 *   · `p2Fraction(ready, total)` —— 世界列在陆续就绪（网络好时先满）
 * 取较大者既保持单调，也不撒谎（不会把「还没下载完」报成接近完成）。
 *
 * @param {{jsLoaded: number, readyColumns: number, totalColumns: number}} o
 * @returns {number} 阶段内归一值 [0,1]
 */
export function p2DisplayFraction({ jsLoaded, readyColumns, totalColumns }) {
  return Math.max(p1Fraction(jsLoaded), p2Fraction(readyColumns, totalColumns));
}

/**
 * stall 面板此刻是否该展示。
 *
 * ## 为什么需要这条判据（v2.99 自审发现）
 *
 * 第一版只在玩家点「继续等待」时复位 `stallShown`。但网络恢复是**自动**发生的：
 * 抖动一下停了 61 秒 → 判 stall 弹面板 → 网络回来、脚本继续到达 → 面板上还写着
 * 「网络似乎已断开 · 已等待 61 秒无进展」。那是一句**过时的谎话**，而本 Epic 的全部
 * 意义就是不给玩家误导性诊断（旧缺陷正是把「网络慢」报成「无法启动渲染」）。
 *
 * 判据：**进度真的前进了就收起**，不看玩家有没有点过按钮。
 *
 * @param {{stalled: boolean, jsGrewSinceStall: boolean}} o
 *   `jsGrewSinceStall` = 自上次判 stall 以来，已下载脚本数是否增长过
 * @returns {boolean}
 */
export function shouldShowStallPanel({ stalled, jsGrewSinceStall }) {
  return stalled === true && jsGrewSinceStall !== true;
}

/**
 * 进度报告器：把三阶段的值合成一个总百分比，并保证**单调不倒退**。
 *
 * 单调性的实现是维护历史最大值（`_max`）：阶段切换时（P1 渐近值 0.44 → P2 从 0 起算）
 * 直接相加会回落，玩家会以为「重新开始加载了」。
 *
 * @returns {{
 *   report: (phase: 'p1'|'p2'|'p3', value: number, detail?: string) => void,
 *   percent: () => number, phase: () => string, detail: () => string, reset: () => void
 * }}
 */
export function createProgressReporter() {
  let phase = 'p1';
  let detail = '';
  let max = 0;

  return {
    /**
     * @param {'p1'|'p2'|'p3'} nextPhase
     * @param {number} value 该阶段的归一化值 [0,1]
     * @param {string} [nextDetail] 副文案（`#loading-stat` 显示）
     */
    report(nextPhase, value, nextDetail) {
      phase = nextPhase;
      if (nextDetail !== undefined) detail = nextDetail;
      const v = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
      const raw = phase === 'p1'
        ? v * PHASE_WEIGHTS.p1
        : phase === 'p2'
          ? PHASE_WEIGHTS.p1 + v * PHASE_WEIGHTS.p2
          : PHASE_WEIGHTS.p1 + PHASE_WEIGHTS.p2 + v * PHASE_WEIGHTS.p3;
      if (raw > max) max = raw;
    },
    percent() { return max * 100; },
    phase() { return phase; },
    detail() { return detail; },
    /** 清空历史最大值（只有「换世界重建」这类场景才该用，否则会让进度倒退） */
    reset() { phase = 'p1'; detail = ''; max = 0; },
  };
}

/**
 * 百分比 → DOM 文案。夹到 [0,100] 且取整。
 *
 * ⚠️ **必须夹上界**：`Math.round(100.00000001)` 会得到 `100.00000001%`（浮点相加的
 * 真实值不是精确 100），写进 `style.width` 是非法值、写进 `aria-valuenow` 是脏数据。
 * @param {number} p @returns {string}
 */
export function formatPercent(p) {
  const v = Number.isFinite(p) ? Math.max(0, Math.min(100, p)) : 0;
  return `${Math.round(v)}%`;
}
