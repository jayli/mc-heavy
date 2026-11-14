# 启动加载进度与「无进展才失败」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给启动过程一条三阶段的可信进度条，并把「绝对超时」改成「零进展才判卡住」，使慢网络下只要还在下载就永不失败。

**Architecture:** `index.html` 里的内联脚本在模块图开始解析前就挂上 `PerformanceObserver`，成为 P1（脚本与资源下载）的唯一采集权威；`src/core/load-watchdog.js` 提供唯一的进展计时器，`StructureIndex.waitForRegion` 与 `Game._waitForColumn` 从「绝对超时」改为消费它的 stall 信号；`src/main.js` 汇总三阶段为一个总进度并驱动 DOM。

**Tech Stack:** 原生 ES modules（无构建）、`PerformanceObserver`、Web Worker 池、Playwright（`channel: 'chromium'`，WebGPU 必需）、`node:http` + `node:zlib`。

**Spec:** `docs/superpowers/specs/2026-11-13-boot-loading-progress-design.md`

## Global Constraints

- 解释、注释、对话一律中文；代码注释尽量中文（`AGENTS.md`）。
- **资源 URL 只能走 `core/resource-url.js` 的 `resourceUrl()`**，禁止 `'/assets/`、`'/src/`、`'/vendor/` 根绝对路径字面量（`check:arch` 静态拦）。
- `src/voxel|gen|mesh|workers|entities` 是 Worker 同构层：不得 import three、不得自建 Worker（唯一入口 `core/worker-pool.js`）。`core/load-watchdog.js` 落在 `core/`，可以无这两条限制，但**仍不得 import three**（它只做计时）。
- 时间基准统一 `performance.now()`，**禁止 `Date.now()`**（本仓踩过：相差约 17 亿毫秒）。
- UI 层级不等式：`toast 90 < loading 95 < 启动错误遮罩 100`，**不得取 100+**。进度条挂在既有 `#loading-overlay`（95）内部，不新增层。
- 新增 `src/tests/test-*.js` **必须**同时登记到 `src/tests/index.html` 的 import，否则 `check:data` 报「静默不跑」。
- 冻结常量、阈值不改（本计划不含任何冻结断言变更）。
- `tests/tmp-*` 已 gitignore，**不得提交**；临时探针用完即删。
- 本改动**不碰热路径**（mesher / materials / render-world / scheduler 主循环 / physics）⇒ 门禁为 `npm run check` + `npm test`，**不跑 bench**。
- 浏览器内单测结果读 `window.__MC_TEST_RESULTS__`，用例要 `suites.flatMap(s => s.tests)`。

## Review Focus

按「最可能咬到真实用户」排序，每条都必须在指定任务的测试里被钉住：

1. **后台标签页（`requestAnimationFrame` 停摆）** —— 玩家切到别的标签页再切回来，进度条若靠 rAF 驱动会冻在旧值，看起来像卡死。判据：进度刷新走 `setInterval`，不依赖 rAF。
2. **`window.__MC_LOADING__` 从未被创建（内联脚本被 CSP/扩展拦掉或写错）** —— 后续所有阶段上报必须静默降级，而不是抛异常把启动打断。判据：`main.js` 的每个上报调用都在 `?.` 下，且缺采集器时 `boot()` 仍能走到 `rendererReady`。
3. **零进展判定在「有进展但极慢」时误报** —— 每 59 秒前进一个脚本的假死网络。判据：progress 间隔 < 60s 时永不 stall，即使总时长超过 10 分钟由 hardCap 单独兜。
4. **进度倒退** —— 阶段切换时总进度回落（P1 渐近值 0.45 → P2 从 0 起算）会让玩家以为重新开始。判据：`report()` 内部对总百分比取 `max(上一次, 本次)`。
5. **恢复位置那条路径的超时回落被改坏** —— 恢复点不可达时本应静默回落 City 出生点（`game.js:944` 注释），若改成「等 watchdog」就变成永远卡在 loading。判据：这一处**必须保留**绝对超时（10s）并走回落，且有断言；它与出生点主路径是两种语义，不得统一。
6. **stall 判据误判为「还在进展」** —— 等待循环若拿「在途任务数 > 0」当进展信号，任务永久在途（Worker 死了、请求挂死）时 `notifyProgress()` 会被每 50ms 喂一次，stall 永不触发，面板永不出现。判据：**只有「结果真的到达」才算进展**（布局数 / 已成列数增加），在途数不是进展。

---

## 文件结构

| 文件 | 职责 | 状态 |
|---|---|---|
| `index.html` | 内联进度采集器 + 进度条 DOM/CSS | 修改 |
| `src/core/load-watchdog.js` | 唯一的进展计时器：`notifyProgress()` / `poll()` / `reset()`，纯逻辑无 DOM。**所有 verdict 只驱动 UI，从不驱动 reject** | **新建** |
| `src/core/load-progress.js` | 三阶段权重合成 + 百分比单调化 + 文案 | **新建** |
| `src/core/game.js` | `_waitForColumn` 接 watchdog；`start()` 上报阶段 | 修改 |
| `src/gen/structure-index.js` | `waitForRegion` 去绝对超时，改由 watchdog 驱动 UI 信号（不 reject） | 修改 |
| `src/core/scheduler.js` | 构造选项增加 `watchdog`，透传给 `StructureIndex`（单一权威，不得在 Scheduler 另建一个） | 修改 |
| `src/main.js` | 建 watchdog、驱动三阶段、stall UI、按钮接线 | 修改 |
| `server-script/start-server.js` | 静态文本资源 gzip | 修改 |
| `src/tests/test-load-watchdog.js` | watchdog 单测 | **新建** |
| `src/tests/test-load-progress.js` | 进度合成单测 | **新建** |
| `src/tests/index.html` | 登记上面两个测试文件 | 修改 |
| `tests/loading-overlay.spec.mjs` | 扩三条 E2E（慢网络不失败 / 进度单调 / 真卡住能诊断） | 修改 |
| `docs/roadmap.md` | 登记本改动 | 修改 |

拆分理由：`load-watchdog`（何时算卡住）与 `load-progress`（进度怎么算/怎么显示）是两个独立失效面 —— 前者错了会误杀正常启动，后者错了只是数字难看。分别单测才能在红的时候立刻知道是哪一类。

---

### Task 1: LoadWatchdog —— 零进展与总时长双判据

**Files:**
- Create: `src/core/load-watchdog.js`
- Create: `src/tests/test-load-watchdog.js`
- Modify: `src/tests/index.html`（登记）

**Interfaces:**
- Produces:
  - `new LoadWatchdog({ stallMs = 60_000, hardCapMs = 600_000, now = () => performance.now() })`
  - `notifyProgress(): void` —— 重置零进展计时
  - `poll(): 'ok' | 'stall' | 'hard-cap'` —— 幂等可反复调；返回 `'stall'` 在同一次 stall 期间只返回一次（之后返回 `'ok'` 直到 `reset()`）
  - `reset(): void` —— 玩家点「继续等待」时调用，两个计时器都重置
  - `state(): { stalled: boolean, elapsedMs: number, sinceProgressMs: number }`
- Consumes: 无

- [ ] **Step 1: 写失败测试**

```js
// src/tests/test-load-watchdog.js
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse } from './assert.js';
import { LoadWatchdog } from '../core/load-watchdog.js';

/** 假时钟：手动推进，全程不用真等待 */
function fakeClock() {
  let t = 0;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('LoadWatchdog: 每 30s 有进展 → 5 分钟内永不 stall（极慢网络不误杀）', () => {
  const c = fakeClock();
  const w = new LoadWatchdog({ now: c.now });
  for (let i = 0; i < 10; i++) {
    c.advance(30_000);
    w.notifyProgress();
    assertEqual(w.poll(), 'ok', `第 ${i + 1} 次 30s 后有进展，不得 stall`);
  }
});

test('LoadWatchdog: 零进展恰好 60s 触发一次 stall，之后 poll 不再重复报', () => {
  const c = fakeClock();
  const w = new LoadWatchdog({ now: c.now });
  w.notifyProgress();
  c.advance(59_999);
  assertEqual(w.poll(), 'ok', '59.999s 未到阈值');
  c.advance(1);
  assertEqual(w.poll(), 'stall', '正好 60s 必须触发');
  assertEqual(w.poll(), 'ok', '同一次 stall 只报一次（否则 UI 会被重复弹）');
  c.advance(60_000);
  assertEqual(w.poll(), 'ok', 'stalled 状态持续期间不重复报');
});

test('LoadWatchdog: reset() 后可再次 stall（玩家点「继续等待」）', () => {
  const c = fakeClock();
  const w = new LoadWatchdog({ now: c.now });
  c.advance(60_000);
  assertEqual(w.poll(), 'stall');
  w.reset();
  c.advance(30_000);
  assertEqual(w.poll(), 'ok', 'reset 后计时归零');
  c.advance(30_000);
  assertEqual(w.poll(), 'stall', 'reset 后满 60s 应再次 stall');
});

test('LoadWatchdog: 总时长超 hardCapMs 返回 hard-cap（独立于 stall）', () => {
  const c = fakeClock();
  const w = new LoadWatchdog({ now: c.now });
  // 一直有进展，所以永不 stall —— 只能靠 hardCap 兜
  for (let i = 0; i < 19; i++) { c.advance(30_000); w.notifyProgress(); }
  assertEqual(w.poll(), 'ok', '9.5 分钟仍在正常区间');
  c.advance(30_000); w.notifyProgress(); // 10.0 分钟
  assertEqual(w.poll(), 'hard-cap', '到 10 分钟必须报 hard-cap');
});

test('LoadWatchdog: state() 暴露两个耗时（诊断文案要用）', () => {
  const c = fakeClock();
  const w = new LoadWatchdog({ now: c.now });
  c.advance(10_000); w.notifyProgress();
  c.advance(5_000);
  const s = w.state();
  assertEqual(s.elapsedMs, 15_000);
  assertEqual(s.sinceProgressMs, 5_000);
  assertFalse(s.stalled);
});
```

- [ ] **Step 2: 登记测试文件并跑 RED**

`src/tests/index.html` 的 import 区按字母序插入（与既有风格一致）：

```html
    import './test-load-progress.js';
    import './test-load-watchdog.js';
```

Run: `npx playwright test tests/harness.spec.mjs`
Expected: FAIL —— `test-load-watchdog.js` 里 `LoadWatchdog` 解析失败 / 模块不存在（同时 `test-load-progress.js` 尚不存在会 404，Task 2 才建文件，故**本步只插入 `test-load-watchdog.js` 那一行**，`test-load-progress.js` 的行留到 Task 2）。

- [ ] **Step 3: 实现 `LoadWatchdog`**

`src/core/load-watchdog.js`，导出单个类。要点：
- 构造时 `this._t0 = now()`、`this._lastProgressAt = this._t0`、`this._stallReported = false`。
- `poll()` 依次判：`hardElapsed >= hardCapMs` → `'hard-cap'`；否则 `sinceProgress >= stallMs && !_stallReported` → 置 `_stallReported = true` 并返回 `'stall'`；否则 `'ok'`。
- `notifyProgress()` 置 `_lastProgressAt = now()`。**不清 `_stallReported`**（否则「卡了一下又动一格」会反复弹窗）。
- `reset()` 同时重置 `_t0` / `_lastProgressAt` / `_stallReported`。
- `now` 可注入（测试用假时钟），默认 `() => performance.now()`。
- 头部注释写清：**不用 `Date.now()`**（本仓时间基准红线），以及「有进展 ≠ 有 stall」的推导。

- [ ] **Step 4: 跑 GREEN**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: PASS，含 5 条 `LoadWatchdog` 用例。

- [ ] **Step 5: 提交**

```bash
git add src/core/load-watchdog.js src/tests/test-load-watchdog.js src/tests/index.html
git commit -m "feat(loading): 新增 LoadWatchdog 零进展/总时长双判据"
```

---

### Task 2: LoadProgress —— 三阶段权重合成与单调化

**Files:**
- Create: `src/core/load-progress.js`
- Create: `src/tests/test-load-progress.js`
- Modify: `src/tests/index.html`（登记）

**Interfaces:**
- Consumes: 无（纯函数，不碰 DOM、不碰 watchdog）
- Produces:
  - `PHASE_WEIGHTS: { p1: 0.45, p2: 0.45, p3: 0.10 }`
  - `p1Fraction(modulesLoaded: number): number` —— `1 - 1 / (1 + n / 24)`；n ≤ 0 时返回 0
  - `p2Fraction(readyColumns: number, totalColumns: number): number` —— 夹到 [0,1]；`totalColumns <= 0` 返回 0
  - `createProgressReporter(): { report(phase, value, detail?), percent(), phase(), detail(), reset() }` —— `report()` 内部对 `percent` 取历史最大值（单调）
  - `formatPercent(p: number): string` —— 整数百分比串（`"42%"`）

- [ ] **Step 1: 写失败测试**

```js
// src/tests/test-load-progress.js
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import {
  PHASE_WEIGHTS, p1Fraction, p2Fraction, createProgressReporter, formatPercent,
} from '../core/load-progress.js';

test('LoadProgress: 三阶段权重之和为 1', () => {
  assertEqual(PHASE_WEIGHTS.p1 + PHASE_WEIGHTS.p2 + PHASE_WEIGHTS.p3, 1);
});

test('LoadProgress: p1Fraction 是单调渐近曲线（实测口径：24→0.5，72→0.75）', () => {
  assertEqual(p1Fraction(0), 0);
  assertEqual(p1Fraction(24), 0.5);
  assertEqual(p1Fraction(72), 0.75);
  // 单调性：严格递增，且永不达 1
  let prev = -1;
  for (const n of [1, 10, 24, 50, 100, 200, 874]) {
    const v = p1Fraction(n);
    assertTrue(v > prev, `n=${n} 必须比前一个大`);
    assertTrue(v < 1, `n=${n} 不得达到 1（还得留给 p2/p3）`);
    prev = v;
  }
});

test('LoadProgress: p2Fraction 用 (2vd+1)^2 作分母（实测 vd=2 → 25）', () => {
  assertEqual(p2Fraction(0, 25), 0);
  assertEqual(p2Fraction(23, 25), 23 / 25);
  assertEqual(p2Fraction(25, 25), 1);
  assertEqual(p2Fraction(30, 25), 1, '超出分母必须夹到 1，不得 >1');
  assertEqual(p2Fraction(5, 0), 0, '分母为 0 时返回 0（不产生 NaN）');
});

test('LoadProgress: 总百分比单调不倒退（阶段切换时取历史最大值）', () => {
  const r = createProgressReporter();
  r.report('p1', 0.9);              // 0.405
  const a = r.percent();
  assertTrue(Math.abs(a - 40.5) < 1e-9, `p1 0.9 → 40.5%，实际 ${a}`);
  r.report('p2', 0.0);              // 若直接算会回落
  assertEqual(r.percent(), a, '阶段切换不得让百分比倒退');
  r.report('p2', 0.5);              // 0.405 + 0.225 = 0.63
  assertTrue(r.percent() > a, '真进展必须前进');
  r.report('p3', 1);
  assertEqual(r.percent(), 100, '三阶段全满 → 100');
});

test('LoadProgress: report 记录当前阶段与细节文案', () => {
  const r = createProgressReporter();
  r.report('p1', 0.2, '正在加载脚本 120 个');
  assertEqual(r.phase(), 'p1');
  assertEqual(r.detail(), '正在加载脚本 120 个');
  r.report('p2', 0.1, '正在生成世界 3/25');
  assertEqual(r.detail(), '正在生成世界 3/25');
});

test('LoadProgress: reset() 清空历史最大值（换世界重建时才用）', () => {
  const r = createProgressReporter();
  r.report('p1', 0.9);
  const high = r.percent();
  r.reset();
  assertEqual(r.percent(), 0, 'reset 后归零');
  assertTrue(high > 0);
});

test('LoadProgress: formatPercent 取整且不出现 100.00000001', () => {
  assertEqual(formatPercent(0), '0%');
  assertEqual(formatPercent(42.4), '42%');
  assertEqual(formatPercent(99.6), '100%');
  assertEqual(formatPercent(100.00000001), '100%');
});
```

- [ ] **Step 2: 跑 RED**

先把 `import './test-load-progress.js';` 补进 `src/tests/index.html`（Task 1 已完成 `test-load-watchdog.js` 那行）。

Run: `npx playwright test tests/harness.spec.mjs`
Expected: FAIL —— `src/core/load-progress.js` 不存在（404 / 模块解析失败）。

- [ ] **Step 3: 实现 `load-progress.js`**

纯函数模块，无 DOM 无 timer。要点：
- `p1Fraction(n)` = `n <= 0 ? 0 : 1 - 1 / (1 + n / 24)`，其中 `24` 抽成具名常量 `P1_HALF_POINT = 24`，注释说明它来自实测（首屏 151 个模块，24 让前 10% 几秒内就发生）。
- `p2Fraction(ready, total)` 先 `Math.max(0, Math.min(1, total > 0 ? ready / total : 0))`。
- `createProgressReporter()` 内部保存 `{ phase, detail, _max }`；`report()` 算出 `raw = p1*w1 + p2*w2 + p3*w3`，`_max = Math.max(_max, raw)`，`percent()` 返回 `_max * 100`。
- 头部注释写清 spec DR-2 的推导：为什么 P1 必须渐近（总数事前不可知）而不是 `n/total`。

- [ ] **Step 4: 跑 GREEN**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: PASS（7 条 LoadProgress + 5 条 LoadWatchdog）。

- [ ] **Step 5: 提交**

```bash
git add src/core/load-progress.js src/tests/test-load-progress.js src/tests/index.html
git commit -m "feat(loading): 三阶段进度合成与单调化"
```

---

### Task 3: `index.html` 内联采集器 + 进度条 DOM

**Files:**
- Modify: `index.html`（`<head>` 的 `<style>` 与 body 的 `#loading-overlay`）

**Interfaces:**
- Produces（供 Task 4/5/6 消费）:
  - `window.__MC_LOADING__ = { js: number, other: number, total: number, sinceMs: number }` —— `js/other/total` 为已完成资源条目累计数，`sinceMs` 为自内联脚本执行起的毫秒数
  - `window.__MC_LOADING__.onChange(fn)` —— 注册回调，每次计数更新后调用（一次）
- Consumes: 无

- [ ] **Step 1: 写进度条 DOM 与 CSS**

在 `#loading-overlay` 内、`mc-loading-sub` 之后追加：

```html
    <div class="mc-loading-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" id="loading-bar">
      <div class="mc-loading-bar-fill" id="loading-bar-fill"></div>
    </div>
    <p class="mc-loading-stat" id="loading-stat"></p>
    <div class="mc-loading-actions" id="loading-actions" hidden>
      <button type="button" id="loading-continue">继续等待</button>
      <button type="button" id="loading-reload">重新加载页面</button>
    </div>
```

CSS（放在既有 `.mc-loading-sub` 规则之后）：

```css
    #loading-overlay .mc-loading-bar {
      width: min(420px, 72vw); height: 8px; border-radius: 4px;
      background: #262b36; overflow: hidden;
    }
    #loading-overlay .mc-loading-bar-fill {
      height: 100%; width: 0%; background: #7fc253; border-radius: 4px;
      transition: width 0.2s linear;
    }
    #loading-overlay .mc-loading-stat {
      margin: 0; font-size: 11px; color: #6f7887; min-height: 15px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    #loading-overlay .mc-loading-actions { display: flex; gap: 10px; }
    #loading-overlay .mc-loading-actions[hidden] { display: none; }
    #loading-overlay .mc-loading-actions button {
      padding: 6px 14px; font-size: 13px; border-radius: 4px; cursor: pointer;
      border: 1px solid #4a5160; background: #2b3140; color: #e8e8e8;
      font-family: inherit;
    }
    #loading-overlay .mc-loading-actions button:hover { background: #363d4e; }
```

- [ ] **Step 2: 写内联采集器脚本**

紧接在 `<script type="importmap">` **之前**插入（必须早于任何 module script，这样 `PerformanceObserver` 才不漏掉前几百个请求）：

```html
  <script>
    /*
     * 启动进度采集器（v2.98）。
     *
     * ⚠️ **必须在 index.html 内联，不能放 src/main.js**：main.js 自身是模块图的根，
     * 它执行时首页 151 个模块请求已经全部挂出去了，由 JS 创建的采集器会漏掉最关键的一段。
     * 与 v2.51 把 loading 占位图写成静态 HTML 是同一条理由。
     *
     * ⚠️ **用 PerformanceObserver 而不是 performance.getEntriesByType()**：后者受资源
     * 时间线缓冲区上限截断（本仓实测只返 250 条，而实际 874 个模块请求），
     * 进度条会在 30% 处永久冻住。
     *
     * ⚠️ **用 setInterval 而不是 requestAnimationFrame**：后台标签页里 rAF 会停摆，
     * 玩家切走再切回来会看到一个冻住的进度条（看起来像卡死）。
     */
    (function () {
      var state = { js: 0, other: 0, total: 0, sinceMs: 0, onChange: null };
      var t0 = performance.now();
      function count(name) {
        state.total++;
        if (/\.(js|mjs)(\?|$)/.test(name)) state.js++;
        else state.other++;
        if (state.onChange) { try { state.onChange(state); } catch (e) { /* 观测者出错不得打断启动 */ } }
      }
      try {
        new PerformanceObserver(function (list) {
          var es = list.getEntries();
          for (var i = 0; i < es.length; i++) count(es[i].name);
        }).observe({ type: 'resource' });
      } catch (e) {
        // 老浏览器没有 resource 观测：进度会停在 0，但启动不受影响
      }
      state.onChange = null;
      // sinceMs 由读取方按需算（保持 state 是纯数据，便于测试读取）
      Object.defineProperty(state, 'sinceMs', { get: function () { return performance.now() - t0; } });
      window.__MC_LOADING__ = state;
      // 兜底：即便一个资源都没被观测到，也让 UI 有东西可显示
      setInterval(function () { if (state.onChange) { try { state.onChange(state); } catch (e) {} } }, 100);
    })();
  </script>
```

⚠️ 实现时注意：上面 `Object.defineProperty` 与 `state.onChange` 的赋值顺序要整理干净（`onChange` 初始为 `null`，由 Task 4 的 `main.js` 赋值；`setInterval` 每 100ms 主动 tick 一次，保证即使没有新资源也能刷新 UI 与 `sinceMs`）。

- [ ] **Step 3: 验证静态存在性（不靠 JS）**

Run:
```bash
npx playwright test tests/loading-overlay.spec.mjs -g "占位图与 logo"
```
Expected: PASS —— 既有用例仍绿（缩略图与 LOADING 字样没被改动）。

再手工确认采集器在模块加载前就存在：
```bash
npx playwright test tests/loading-overlay.spec.mjs -g "loading：" 
```
Expected: 全部 PASS。

- [ ] **Step 4: 提交**

```bash
git add index.html
git commit -m "feat(loading): 内联资源采集器与进度条 DOM"
```

---

### Task 4: `main.js` 驱动三阶段与 stall UI

**Files:**
- Modify: `src/main.js`

**Interfaces:**
- Consumes: `LoadWatchdog`（Task 1）、`createProgressReporter` / `p1Fraction` / `p2Fraction` / `formatPercent`（Task 2）、`window.__MC_LOADING__`（Task 3）、`game.scheduler.stats().ready` 与 `game.viewDistance`（既有）
- Produces:
  - `window.__MC_BOOT__.loading = { percent: number, phase: 'p1'|'p2'|'p3', stalled: boolean }`（Playwright 断言入口）
  - `main.js` **持有唯一的 `LoadWatchdog` 实例**，经 `new Game({ watchdog })` 传入（`Game` 构造选项新增 `watchdog`，缺省自建 → fixture 页直建 Game 时不受影响）

**单一权威的传递链**：`main.js` 建 → `new Game({ watchdog })` → `Game._watchdog` → `Scheduler({ watchdog })` → `StructureIndex({ watchdog })`，并且 `main.js` 自己留一份引用。
**不得**在 `Game` 与 `main.js` 各建一个（否则 `main.js` 看到的 stalled 与 `_waitForColumn` 用的不是同一份状态，面板永远不会弹）。

- [ ] **Step 1: 进度条元素与 DOM 写入**

`index.html` 里 `.mc-loading-text` 那个 `<p>` 需要加 id 供文案切换（Task 3 若未加，本步补上）：

```html
    <p class="mc-loading-text" id="loading-text">Loading</p>
```

`src/main.js` 顶部 import 增加：

```js
import { LoadWatchdog } from './core/load-watchdog.js';
import { createProgressReporter, p1Fraction, p2Fraction, formatPercent } from './core/load-progress.js';
```

模块级状态（放在既有 `setLoadingStage` 之前）：

```js
/** 启动进度（三阶段合成）。single-flight：整个启动期只有一个实例。 */
const reporter = createProgressReporter();
/** **唯一的进展计时器**（见文件头注释：game.js / scheduler.js / structure-index.js 都只用这一个）。 */
const watchdog = new LoadWatchdog();
/** 当前阶段：'p1' 脚本下载 / 'p2' 世界生成 / 'p3' 首帧渲染 */
let loadingPhase = 'p1';
/** 100ms 刷新计时器句柄（hideLoading 里清） */
let loadingTimer = 0;
```

三个函数（实现按下面「具体要求」逐条落地）：

```js
function paintLoading() { /* 见下方要求 */ }
function reportP1() { /* 读 window.__MC_LOADING__，返回 {js,total} 或 null */ }
function reportP2(game) { /* 读 game.scheduler.stats().ready */ }
function showStall(verdict) { /* 填诊断文案 + 显示两个按钮 */ }
```

具体要求（实现者照此写，不留选择）：
- `paintLoading()`：`#loading-bar-fill` 的 `style.width = formatPercent(reporter.percent())`；`#loading-bar` 的 `aria-valuenow` 写整数百分比；`#loading-stat` 写 `reporter.detail()`；`#loading-text` 按 `loadingPhase` 显示 `Loading` / `Generating world` / `Finishing`（大写由 CSS `text-transform` 负责，DOM 里写原样词）。
- `reportP1()`：`const st = window.__MC_LOADING__; if (!st) { reporter.report('p1', 0, '正在加载…'); return null; }` 然后 `reporter.report('p1', p1Fraction(st.js), '已加载 ' + st.js + ' 个脚本')`，返回 `{ js: st.js, total: st.total }`。
  ⚠️ **采集器缺失必须静默降级**（Review Focus 第 2 条）：不得抛、不得中断启动。
- `reportP2(game)`：`const s = game.scheduler.stats(); const total = (2 * game.viewDistance + 1) ** 2;` 然后 `reporter.report('p2', p2Fraction(s.ready, total), '正在生成世界 ' + s.ready + '/' + total)`。
- `showStall(verdict)`：`const st = watchdog.state();` 然后 `#loading-stat` 写
  `` `网络似乎已断开 · 已等待 ${Math.round(st.sinceProgressMs / 1000)} 秒无进展 · 已加载 ${js} 个脚本` ``（`js` 取 `window.__MC_LOADING__?.js ?? 0`；`verdict === 'hard-cap'` 时前缀换成「加载时间较长」），并把 `#loading-actions` 的 `hidden` 去掉。
  ⚠️ **文案里不得出现「超时」「timeout」字样**（Task 6 第 1/3 条 E2E 会断言这一点）—— 那些词把「网络慢」误导成「功能坏了」。
- 按钮：`#loading-continue` → `watchdog.reset()` + 重新隐藏 actions + `paintLoading()`；`#loading-reload` → `location.reload()`。两个监听各只绑一次（模块顶层绑，不在 `boot()` 里绑）。
- 刷新循环：模块顶层起 `loadingTimer = setInterval(tickLoading, 100)`，`tickLoading()` 的逻辑是：
  ```js
  function tickLoading() {
    if (!watchdog) return;
    const verdict = watchdog.poll();          // 'ok' | 'stall' | 'hard-cap'
    if (verdict !== 'ok') showStall(verdict);
    if (loadingPhase === 'p1') reportP1();
    else if (loadingPhase === 'p2' && window.__MC_GAME__) reportP2(window.__MC_GAME__);
    paintLoading();
  }
  ```
  ⚠️ **`tickLoading` 内部不调 `watchdog.notifyProgress()`** —— 进展只能由「真的拿到了东西」喂（见 Task 5），
  否则一个挂死的请求会永远喂饱 watchdog、stall 永不触发（Review Focus 第 6 条）。
- `hideLoading()` 里补 `if (loadingTimer) { clearInterval(loadingTimer); loadingTimer = 0; }`。
- `window.__MC_BOOT__.loading` 在 `paintLoading()` 末尾同步写：`{ percent: reporter.percent(), phase: loadingPhase, stalled: watchdog.state().stalled }`。

- [ ] **Step 2: 接线三阶段到既有启动流程**

- `boot()` 最开头（第一个 `setLoadingStage` 之前）：`reporter.report('p1', 0, '正在启动…'); paintLoading();` 并**立刻 emit 一次** `window.__MC_LOADING__?.onChange?.(window.__MC_LOADING__)`（启动期资源观测由采集器自己的 100ms 循环驱动，这里只是让首个画面不是 0%）。
- 检查 WebGPU 之后、`await buildDefaultRegistry()` 之前：`reportP1();`（此刻已能读到采集器的 js 计数）。
- `new Game({ ..., watchdog })` —— **把 watchdog 传进去**（构造选项名固定为 `watchdog`）。
- `await game.start()` 之前：`loadingPhase = 'p2'; reportP2(game);`。
- `window.__MC_GAME__ = game` 之后：`loadingPhase = 'p3'; reporter.report('p3', 0, '正在绘制首帧'); paintLoading();`
- **P3 的 100% 必须在首帧之后置位**：`requestAnimationFrame(() => { reporter.report('p3', 1, '准备完成'); paintLoading(); hideLoading(); })`。
  ⚠️ 不能直接 `await game.start()` 下一行就 `report('p3',1)` 或 `hideLoading()` —— `game.start()` 只到
  `setAnimationLoop` 注册为止，那一刻还没有任何一帧被画出来；「首帧渲染」这个阶段名会名不副实，
  且慢 GPU 上会先看到黑屏一瞬间才淡出。

- [ ] **Step 3: 验证不破坏既有启动**

Run: `npx playwright test tests/loading-overlay.spec.mjs -g "占位图与 logo"`
Expected: PASS（静态 HTML 那条不受影响）。

Run: `npx playwright test tests/loading-overlay.spec.mjs -g "淡出"`
Expected: PASS（`hideLoading` 逻辑未变，只是多了 rAF 一跳）。

Run: `npx playwright test tests/render-terrain.spec.mjs`
Expected: PASS（启动路径没被改坏的代表性用例）。

- [ ] **Step 4: 提交**

```bash
git add src/main.js index.html
git commit -m "feat(loading): main.js 驱动三阶段进度与 stall 面板"
```

---

### Task 5: `waitForRegion` 与 `_waitForColumn` 改为消费 watchdog（**不 reject**）

**Files:**
- Modify: `src/gen/structure-index.js:78-89`（`waitForRegion` 重写 + `dispatch()` 成功分支喂进展）
- Modify: `src/core/scheduler.js:49,116`（构造解构 + `new StructureIndex`）
- Modify: `src/core/game.js`：
  - 构造器签名加 `watchdog`（`Game({ ..., watchdog })`，缺省 `null` → 自建）
  - `:518` Scheduler 构造传 `watchdog: this._watchdog`
  - `:890`、`:936`、`:944-954`、`:1388-1405` 等待逻辑
- Modify: `src/tests/test-structure-layout.js`（新增一条新语义用例 + 补 import）

**Interfaces:**
- Consumes: `LoadWatchdog` 实例（`main.js` 建 → `new Game({ watchdog })` → `Scheduler` → `StructureIndex`，一条链传递）
- Produces:
  - `Game({ ..., watchdog })` 新增构造选项；`this._watchdog = watchdog || new LoadWatchdog()`（fixture 页直建 Game 时自建）
  - `StructureIndex({ pool, seed, watchdog })` 新增构造选项（缺省 `null`）
  - `StructureIndex.waitForRegion(regionX, regionZ, watchdog?): Promise<Layout>` —— 无 `timeoutMs` 参数
  - `StructureIndex.onStalled: ((verdict) => void) | null` —— 单槽回调
  - `Scheduler({ ..., watchdog })` 新增构造选项
  - `Game._waitForColumn(cx, cz, driveX, driveZ): Promise<void>` —— **去掉 `timeoutMs` 参数**，改用注入的 `this._watchdog` 只做 UI 信号
  - `Game._waitForColumnOrTimeout(cx, cz, timeoutMs, driveX, driveZ): Promise<void>` —— 仅恢复位置路径用
  - `Game.onLoadStalled: ((verdict) => void) | null` —— `main.js` 赋值

**为什么两处都**不**reject（与初版计划的差异）**

用户要求「只要网络不断，就一个个把脚本加载完成」。如果把 stall 做成 reject，`boot()` 会落到
`showError`，玩家看到「无法启动渲染」错误遮罩、游戏根本没起来 —— 那正是要被消灭的形态。

- **`waitForRegion(0,0)`（出生点主路径）：永不 reject**。watchdog 报 stall/hard-cap 时只调
  `onStalled`（→ `main.js` 弹面板），循环继续等；布局真到了就照常 resolve。
- **`_waitForColumn`（出生点）：永不 reject**，同上。
- **`_waitForColumn`（恢复位置那条，`game.js:944-954`）：保留硬超时**。它已有
  `try/catch` 回落 City 出生点，语义是「那个点去不了就不去」，与主路径不同；换成无限等会让
  玩家卡在 loading 里永远进不去。

- [ ] **Step 1: 写失败测试（钉住「watchdog 报 stall 也不 reject」）**

`src/tests/test-structure-layout.js` 首行 import 改为：

```js
import { assertEqual, assertTrue, assertNotNull } from './assert.js';
```

追加用例：

```js
test('StructureIndex: watchdog 报 stall 时不得 reject（慢网络必须仍能启动）', async () => {
  const resolvers = new Map();
  const fakePool = {
    call(method, payload) {
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      resolvers.set(`${payload.regionX},${payload.regionZ}`, resolve);
      return { id: resolvers.size, promise };
    },
  };
  const index = new StructureIndex({ pool: fakePool, seed: SEED });
  const stalledWatchdog = {
    poll: () => 'stall',
    notifyProgress: () => {},
    state: () => ({ sinceProgressMs: 61_000, elapsedMs: 61_000 }),
  };
  let stalledCalls = 0;
  index.onStalled = () => { stalledCalls++; };
  let settled = null;
  const p = index.waitForRegion(0, 0, stalledWatchdog)
    .then(() => { settled = 'resolved'; }, () => { settled = 'rejected'; });
  // 等几次 20ms tick，确认它既没 reject 也没 resolve
  await new Promise((r) => setTimeout(r, 200));
  assertEqual(settled, null, 'watchdog 报 stall 不得让 waitForRegion 落定（必须继续等）');
  assertTrue(stalledCalls > 0, 'stall 必须通过回调通知 UI，否则玩家看不到诊断');
  // 资源终于到了 → 必须正常 resolve 继续启动
  for (const [k, resolve] of resolvers) {
    const [rx, rz] = k.split(',').map(Number);
    resolve(computeRegionLayout(rx, rz, SEED));
  }
  await p;
  assertEqual(settled, 'resolved', '布局到了必须继续启动');
});
```

- [ ] **Step 2: 跑 RED**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: FAIL —— 当前实现没有 `onStalled` 概念，`stalledCalls` 恒 0，第二条断言红。
（若 `waitForRegion` 连 `watchdog` 形参都还没有，那它会把第三参当 `timeoutMs` 用，
`performance.now() - t0 > {object}` 恒假 ⇒ 永不落定，第一条断言同样红。两种形态都算 RED。）

- [ ] **Step 3: 重写 `StructureIndex.waitForRegion` + 在 `dispatch()` 里喂进展**

```js
/**
 * 等待单个 region 布局就绪（出生点选择等启动关键路径用）。
 *
 * ## 为什么不再用绝对超时，而且 stall 时也不 reject（v2.98）
 *
 * 旧实现 5 秒后抛 `layout timeout: 0,0`。实测（真实部署 trace + 本机 250KB/s 限速）：
 * 慢网络下 worker 模块图 52 个模块要 **90.9 秒**才回第一个包 —— 布局任务根本还没被执行，
 * 5 秒预算差了两个数量级。它把「网络慢」误报成「世界生成失败」。
 *
 * 现在只看「有没有进展」：零进展 60 秒 / 总时长 10 分钟 → 经 `onStalled` 通知 UI 弹诊断面板，
 * **但 Promise 继续挂着**。用户要求「只要网络不断就一个个加载完」—— reject 会让游戏彻底
 * 起不来，正是要消灭的形态。等布局真到了就照常 resolve。
 *
 * ⚠️ **进展信号只能是「结果到了」，不能是「有在途任务」**：拿 `_inflight.size > 0` 当进展
 * 会让挂死的请求永远喂饱 watchdog，面板永不出现（Review Focus 第 6 条）。
 */
waitForRegion(regionX, regionZ, watchdog = null) {
  const wd = watchdog || this._watchdog;
  const key = `${regionX},${regionZ}`;
  this.ensureForColumn(regionX * 25, regionZ * 25);
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (this._layouts.has(key)) { clearInterval(timer); resolve(this._layouts.get(key)); return; }
      if (wd) {
        const verdict = wd.poll();
        if ((verdict === 'stall' || verdict === 'hard-cap') && this.onStalled) this.onStalled(verdict);
      }
      this.dispatch(); // 继续驱动下发
    }, 20);
  });
}
```

在构造器里加 `this._watchdog = watchdog;` 与 `this.onStalled = null;`。
在 `dispatch()` 的成功回调 `this._layouts.set(key, layout)` 之后加一行：

```js
        if (this._watchdog) this._watchdog.notifyProgress();
```

⚠️ **只在这里喂**，不要在 `setInterval` 里无条件调 —— 那是 Review Focus 第 6 条的缺陷形态。

- [ ] **Step 4: 改 `Game._waitForColumn`（主路径不 reject）+ 新增带超时的变体**

重写为：

```js
_waitForColumn(cx, cz, driveX, driveZ) {
  const dx = driveX ?? this.spawnX, dz = driveZ ?? this.spawnZ;
  return new Promise((resolve) => {
    let lastReady = this.world.columns.size;
    const timer = setInterval(() => {
      // 进展信号 = **真有新列就绪**（不是「GEN 在途」）
      const nowReady = this.world.columns.size;
      if (nowReady > lastReady) { lastReady = nowReady; this._watchdog?.notifyProgress(); }
      if (this.world.hasColumn(cx, cz)) { clearInterval(timer); resolve(); return; }
      const verdict = this._watchdog ? this._watchdog.poll() : 'ok';
      if ((verdict === 'stall' || verdict === 'hard-cap') && this.onLoadStalled) this.onLoadStalled(verdict);
      this.scheduler.update(dx, dz);
    }, 50);
  });
}

/**
 * 带硬超时的变体：**只给「恢复位置」那条路径用**。
 *
 * 恢复位置与出生点是两种语义：出生点必须到（等多久都认），恢复位置去不了就该回落
 * City 出生点（game.js:944 既有 `try/catch`）。给主路径也加超时会把「网络慢」变成
 * 「游戏起不来」；给恢复位置不加超时会让玩家卡在 loading 里永远进不去。
 */
_waitForColumnOrTimeout(cx, cz, timeoutMs, driveX, driveZ) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`恢复位置 column (${cx},${cz}) ${timeoutMs}ms 内未就绪`)), timeoutMs);
    this._waitForColumn(cx, cz, driveX, driveZ).then(() => { clearTimeout(t); resolve(); });
  });
}
```

两处调用：
- `game.js:936`（出生点，主路径）：`await this._waitForColumn(Math.floor(this.spawnX / 16), Math.floor(this.spawnZ / 16));`
- `game.js:949`（恢复位置）：`await this._waitForColumnOrTimeout(rcx, rcz, 10000, startX, startZ);` —— **`try/catch` 回落分支原样保留**（`console.warn` + 回落 City 出生点，Review Focus 第 5 条）。

- [ ] **Step 5: 接线 `main.js` → `Game` → `Scheduler` → `StructureIndex`**

三处改动，单一权威一条链：

1. `src/core/game.js` 构造器解构加 `watchdog = null`，并在构造器体内：
   ```js
   /**
    * 启动进展计时器（v2.98）。
    * ⚠️ **全仓只允许存在一个实例**：main.js / `_waitForColumn` / StructureIndex 必须共享它，
    * 否则 `main.js` 看到 stalled=true 而等待循环看不到，`_waitForColumn` 就永远等下去；反过来
    * 等待循环报 stall 而 UI 不知道，玩家只看到一根冻住的进度条。
    * fixture 页直建 Game（不经 main.js）时自建一个 —— 那类页面不启动 loading UI，
    * 自建实例只保证内部代码不必判空。
    */
   this._watchdog = watchdog || new LoadWatchdog();
   ```
2. `src/core/scheduler.js` 构造解构加 `watchdog = null`，`new StructureIndex({ pool, seed, watchdog })`。
3. `src/core/game.js:518` 的 Scheduler 构造补 `watchdog: this._watchdog`。

`main.js` 的传法（Task 4 Step 2 已写）：`new Game({ ..., watchdog })` 里传的就是 `main.js` 顶层那个
`const watchdog = new LoadWatchdog()` —— 它是唯一的创建点，`Game` 只在缺省时兜底。

- [ ] **Step 6: 跑 GREEN + 结构布局回归**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: PASS。

Run: `npx playwright test tests/city-visual.spec.mjs`
Expected: PASS（出生点城市布局仍正常）。

Run: `npx playwright test tests/turrets.spec.mjs`
Expected: PASS（该 spec 依赖 `_waitForColumn` 的装配时序，是签名变更的回归探针）。

- [ ] **Step 7: 提交**

```bash
git add src/gen/structure-index.js src/core/scheduler.js src/core/game.js src/tests/test-structure-layout.js
git commit -m "feat(loading): 布局与出生点等待改为零进展判据（不 reject）"
```

---

### Task 6: 三条 E2E 验收

**Files:**
- Modify: `tests/loading-overlay.spec.mjs`

**Interfaces:**
- Consumes: `window.__MC_LOADING__`、`window.__MC_BOOT__.loading`、`#loading-actions`、`#loading-continue`、`#loading-reload`
- Produces: 无（终端验收）

- [ ] **Step 1: 写三条失败用例**

在 `tests/loading-overlay.spec.mjs` 追加（文件头 import 保持 `{ test, expect }`）：

```js
/** 给页面套 CDP 限速（本仓实测能复现旧缺陷的那一档：250 KB/s + 300 ms）。 */
async function throttle(page, { latencyMs, bytesPerSec }) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: latencyMs,
    downloadThroughput: bytesPerSec, uploadThroughput: bytesPerSec,
  });
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
}

test('loading：慢网络（250KB/s+300ms）下必须启动成功，不得报加载超时', async ({ page }) => {
  // ⚠️ 必须自己放宽超时：全局 200s 装不下「限速下的完整启动」（改前实测 158s 且失败）。
  test.setTimeout(400_000);
  await throttle(page, { latencyMs: 300, bytesPerSec: 250_000 });
  await page.goto('/?vd=2&seed=12345', { waitUntil: 'commit' });
  await page.waitForFunction(
    () => window.__MC_BOOT__ && (window.__MC_BOOT__.rendererReady || window.__MC_BOOT__.error),
    null, { timeout: 360_000 },
  );
  const boot = await page.evaluate(() => window.__MC_BOOT__);
  expect(boot.rendererReady, `启动必须成功（实际 error=${boot.error}）`).toBe(true);
  expect(boot.error).toBeNull();
  // 诊断文案不得再出现「加载超时」
  const boxes = await page.evaluate(() => ({
    detail: document.getElementById('webgpu-error-detail')?.textContent || '',
    note: document.getElementById('webgpu-error-note')?.textContent || '',
  }));
  expect(boxes.detail).not.toMatch(/加载超时/);
  expect(boxes.note).not.toMatch(/加载超时/);
});

test('loading：进度百分比单调不倒退，末值 ≥ 99', async ({ page }) => {
  test.setTimeout(200_000);
  await page.goto('/?vd=2&seed=12345', { waitUntil: 'commit' });
  // 每 50ms 采样一次（在页面里采，避免跨进程开销掩盖抖动）
  await page.evaluate(() => {
    window.__PROGRESS_LOG__ = [];
    const t = setInterval(() => {
      const p = window.__MC_BOOT__?.loading?.percent;
      if (typeof p === 'number') window.__PROGRESS_LOG__.push(p);
    }, 50);
    window.addEventListener('load', () => setTimeout(() => clearInterval(t), 120_000));
  });
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 120_000 });
  const log = await page.evaluate(() => window.__PROGRESS_LOG__);
  expect(log.length, '至少采到若干样本').toBeGreaterThan(5);
  for (let i = 1; i < log.length; i++) {
    expect(log[i], `第 ${i} 个样本倒退：${log[i - 1]} → ${log[i]}`).toBeGreaterThanOrEqual(log[i - 1]);
  }
  expect(Math.max(...log), '末值必须 ≥ 99').toBeGreaterThanOrEqual(99);
});

test('loading：真卡住时给诊断与自救按钮，且不说「加载超时」', async ({ page }) => {
  test.setTimeout(200_000);
  // 挂死结构 JSON：让 GEN 永远拿不到布局所需资源，制造「有连接但无进展」
  await page.route('**/assets/structures/**', (route) => new Promise(() => {})); // 永不 resolve = 永不返回
  await page.goto('/?vd=2&seed=12345', { waitUntil: 'commit' });
  // 零进展阈值 60s，留余量到 100s
  await page.waitForFunction(
    () => {
      const el = document.getElementById('loading-actions');
      return el && !el.hidden;
    },
    null, { timeout: 100_000 },
  );
  const ui = await page.evaluate(() => ({
    stat: document.getElementById('loading-stat')?.textContent || '',
    continueVisible: !!document.getElementById('loading-continue'),
    reloadVisible: !!document.getElementById('loading-reload'),
    errText: (document.getElementById('webgpu-error')?.textContent || ''),
  }));
  expect(ui.stat, '必须点名「已加载 N 个脚本」这类可诊断信息').toMatch(/已加载|无进展|等待/);
  expect(ui.continueVisible, '必须有「继续等待」').toBe(true);
  expect(ui.reloadVisible, '必须有「重新加载页面」').toBe(true);
  expect(ui.errText).not.toMatch(/加载超时/);
});
```

- [ ] **Step 2: 跑 RED**

Run: `npx playwright test tests/loading-overlay.spec.mjs`
Expected: 第 1 条在旧代码下应 FAIL（那是本 Epic 的主缺陷）；第 2 条失败于 `__MC_BOOT__.loading` 不存在；第 3 条失败于 `#loading-actions` 一直 hidden。
⚠️ 若第 1 条在本机限速下意外通过（机器/网络太快），**不要改判据、不要放宽** —— 记录实测耗时并停下来报告（本仓约定：限速档位是从真实 trace 复现出来的，不是拍脑袋的）。

- [ ] **Step 3: 跑 GREEN**

Run: `npx playwright test tests/loading-overlay.spec.mjs`
Expected: PASS（7 条）。

- [ ] **Step 4: 提交**

```bash
git add tests/loading-overlay.spec.mjs
git commit -m "test(loading): 慢网络不失败 / 进度单调 / 卡住可诊断"
```

---

### Task 7: dev server gzip

**Files:**
- Modify: `server-script/start-server.js`

**Interfaces:**
- Consumes: 无
- Produces: 静态文本资源响应带 `Content-Encoding: gzip`

- [ ] **Step 1: 先量基线（改前）**

Run:
```bash
node -e '
const http=require("node:http");
const req=http.get({port:8081,path:"/src/core/game.js",headers:{"accept-encoding":"gzip"}},r=>{
  console.log("status",r.statusCode,"enc",r.headers["content-encoding"]||"(none)");
  let n=0; r.on("data",c=>n+=c.length); r.on("end",()=>console.log("bytes",n));
});'
```
Expected: `enc (none)`，`bytes` ≈ 204000。**记录这个数字**，Step 4 的断言要用实测值而非估算。

- [ ] **Step 2: 实现 gzip**

`server-script/start-server.js`：`import zlib from 'node:zlib';`，MIME 判定后加：

```js
// 文本类压缩（v2.98）：本仓无构建步骤，874 个模块源码直传 —— 实测真实部署
// （js-perf.cn）连 atlas 在内没有任何响应带 content-encoding，慢网络下模块图抢带宽
// 正是启动超时的根因。只压文本类：PNG/JPEG/WAV 已压缩，再压只烧 CPU。
const COMPRESSIBLE = new Set(['.js', '.mjs', '.json', '.html', '.css', '.svg']);
const gzipOk = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
const compress = gzipOk && COMPRESSIBLE.has(extname);
```

响应分支：

```js
    } else {
      const headers = { 'Content-Type': contentType };
      if (compress) {
        const zipped = zlib.gzipSync(content);
        headers['Content-Encoding'] = 'gzip';
        headers['Vary'] = 'Accept-Encoding';
        res.writeHead(200, headers);
        res.end(zipped);
        return;
      }
      res.writeHead(200, headers);
      res.end(content, 'utf-8');
    }
```

⚠️ **不要加 `Cache-Control`**：本地 dev 无缓存更能立刻看到改动（spec DR-6 已裁定）。

- [ ] **Step 3: 验证客户端仍能跑**

Run: `npx playwright test tests/loading-overlay.spec.mjs -g "占位图与 logo"`
Expected: PASS（模块能正常解析 —— 压缩头写错会在这里炸成白屏）。

- [ ] **Step 4: 断言压缩确实生效（Tier 2 门禁口径，落地为一次性实测）**

Run:
```bash
node -e '
const http=require("node:http");
const req=http.get({port:8081,path:"/src/core/game.js",headers:{"accept-encoding":"gzip"}},r=>{
  const enc=r.headers["content-encoding"];
  let n=0; r.on("data",c=>n+=c.length);
  r.on("end",()=>{
    console.log("enc",enc,"gzipBytes",n);
    if(enc!=="gzip") { console.error("FAIL: 未压缩"); process.exit(1); }
    if(n>=190000) { console.error("FAIL: 压缩后仍 >=190000 字节"); process.exit(1); }
    console.log("PASS");
  });
});'
```
Expected: `enc gzip`、`PASS`。
把实测的 gzip 字节数写进 `server-script/start-server.js` 的注释（作为后续改动的对照基线）。

- [ ] **Step 5: 提交**

```bash
git add server-script/start-server.js
git commit -m "perf(dev-server): 静态文本资源启用 gzip"
```

---

### Task 8: 全量门禁与登记

**Files:**
- Modify: `docs/roadmap.md`

**Interfaces:**
- Consumes: 前面全部任务
- Produces: 无

- [ ] **Step 1: 跑门禁**

Run: `npm run check`
Expected: 全绿（`check:arch` / `check:data` / `lint` 三段，`check:data` 应报「测试注册」通过，含两个新测试文件）。

Run: `npm test`
Expected: 全绿。**特别留意** `loading-overlay`（7 条）、`harness`（新增 12 条单测）、`city-visual`、`turrets`（依赖 `_waitForColumn` 时序的三条）。

- [ ] **Step 2: 确认唯一 watchdog 实例（Review Focus ⑥ 的接线检查）**

Run:
```bash
grep -rn "new LoadWatchdog" src/
```
Expected: 恰好 **2** 处 —— `src/main.js`（唯一创建点）与 `src/core/game.js`（fixture 兜底）。
出现第三处即为「stall 状态分裂」缺陷，必须删掉并改为传递。

- [ ] **Step 3: 本机启动不回退（交替对照，不取单次）**

Run（各 3 轮交替，记录 `__MC_BOOT__` 就绪耗时）：
```bash
npx playwright test tests/loading-overlay.spec.mjs -g "慢网络" --repeat-each=1
```
Expected: 与改动前对照不劣化。判据看交替分布而非单次（本仓 `timing-ab-alternating-not-batch` 教训）。
⚠️ 不要跑 bench：本改动不碰热路径。

- [ ] **Step 4: 登记 roadmap**

`docs/roadmap.md` 版本表追加一行（版本号 v2.98，与 spec 一致）：启动加载进度与零进展判据 —— 三阶段进度条（内联 `PerformanceObserver` 采集）、`LoadWatchdog` 双判据（60s 零进展 / 10min 硬上限）取代 layout 5s / column 10s 绝对超时、dev server gzip。附实测：改动前慢网络实测失败（`layout timeout: 0,0` + `column (9,8) 加载超时`，worker 首个回包 90.9s）。

- [ ] **Step 5: 提交**

```bash
git add docs/roadmap.md
git commit -m "docs(roadmap): 登记启动加载进度与零进展判据"
```

---

## 自审记录

**Task 顺序的依赖**：1（watchdog）→ 2（progress）互相独立，可并行；3（index.html 采集器）依赖无；
4（main.js）依赖 1/2/3 的接口；5（等待语义）依赖 1 且要改 `game.js` 的构造签名 —— **必须排在 4 之前**
（4 的 `new Game({ watchdog })` 需要 5 先加构造选项）。若执行者按 1→2→3→4→5 顺序做，第 4 步
会因 `Game` 还不接受 `watchdog` 而把参数静默丢掉（症状：`main.js` 的 watchdog 与 `Game` 内的
不是同一个，stall 面板永不出现）。**正确顺序：1 → 2 → 3 → 5 → 4**（5 与 3 无耦合，也可 3↔5 互换）。

**Spec 覆盖**：DR-1（内联采集器）→ Task 3；DR-2（三阶段口径）→ Task 2 + Task 4；DR-3（双判据）→ Task 1 + Task 5；DR-4（诊断文案）→ Task 4 + Task 6 第 3 条；DR-5（不合并两处实现）→ Task 5（`_waitForColumn` 与 `_waitForColumnOrTimeout` 两个函数，语义不同不合并）；DR-6（gzip）→ Task 7。验收 5 条 → Task 6 + Task 8。

**Review Focus 落点**：① 后台标签页 → Task 3 Step 2（`setInterval` 实现）+ 注释；② 采集器缺失 → Task 4 Step 1（`reportP1` 静默降级）；③ 极慢不误报 → Task 1 第 1 条用例；④ 进度倒退 → Task 2 第 4 条用例；⑤ 恢复位置回落 → Task 5 Step 4（`_waitForColumnOrTimeout` + 保留 catch）；⑥ 在途任务不是进展 → Task 5 Step 3/4（`dispatch()` 成功分支与 `columns.size` 增长才喂 `notifyProgress`）。

**类型一致性**：`LoadWatchdog.poll()` 返回 `'ok'|'stall'|'hard-cap'` 在四处消费（Task 1 定义、Task 4 interval、Task 5 的两处等待循环）完全一致；`createProgressReporter()` 的方法名 `report/percent/phase/detail/reset` 在 Task 2 定义与 Task 4 使用一致；`_waitForColumn` 由 `(cx, cz, timeoutMs, driveX, driveZ)` 改为 `(cx, cz, driveX, driveZ)`，超时语义移到新的 `_waitForColumnOrTimeout`，已在 Task 5 Interfaces 与 Step 4 显式点名两处调用；`StructureIndex` 新增 `watchdog` 构造选项与 `onStalled` 槽位，在 Task 5 Step 3/5 定义并被 Task 4 的 `showStall` 消费。

**已知的一处 spec 修正**：spec DR-3 原文写「stall → 提示 + 自救入口」，未明说等待 Promise 是否继续挂起；本计划明确为**不 reject**（否则会落到 `showError`，与「慢但不断线要能启动」的验收冲突）。实现 Task 5 时以本计划为准。

**比例**：计划约为 spec 的 2.4 倍，绝大多数是测试代码与不可推导的常量（60s / 10min / 24 / 权重 0.45/0.45/0.10 / 250KB/s 限速档），无整段实现体转录。
