// src/main.js — 启动入口：WebGPU gate → Game
import { Game } from './core/game.js';
import { buildDefaultRegistry } from './voxel/block-registry.js';
import { setDebugFlags } from './core/debug-config.js';
import { loadStoredSettings, resolveSettings } from './ui/settings.js';
import { LoadWatchdog } from './core/load-watchdog.js';
import { createProgressReporter, p1Fraction, p2DisplayFraction, formatPercent, shouldShowStallPanel } from './core/load-progress.js';

window.__MC_BOOT__ = { webgpu: false, rendererReady: false, error: null, loading: { percent: 0, phase: 'p1', stalled: false } };

// ---- 启动 loading 占位（v2.51）----
// DOM 是 `index.html` 里的静态节点（**不在 JS 里创建**）：它要在模块还没解析完时就可见。
// 这里只做两件事：更新阶段副文案、在就绪后淡出。
const LOADING_FADE_MS = 300;   // 略大于 CSS 的 opacity 0.25s 过渡

/**
 * 更新 loading 副文案（不传则保持原样）。
 * 阶段文案的意义：从打开页面到首帧渲染之间可能十几秒（世界生成），只转圈的 spinner
 * 会让玩家分不清「在加载」与「卡死」。
 * @param {string} text
 */
function setLoadingStage(text) {
  const el = document.getElementById('loading-sub');
  if (el) el.textContent = text;
}

// ---- 启动进度（v2.99）----
//
// 三阶段（设计文档 DR-2）：P1 脚本与资源下载 45% / P2 世界生成 45% / P3 首帧渲染 10%。
//
// ⚠️ **采集器在 `index.html` 的内联脚本里**（`window.__MC_LOADING__`），不在本文件：
// 本文件是模块图的根，它执行时 874 个模块请求已经挂出去了。见 index.html 的注释。
//
// ⚠️ **唯一的 `LoadWatchdog` 实例在这里创建**，然后经 `new Game({ watchdog })` 传给
// Scheduler → StructureIndex。全仓不得有第二处 `new LoadWatchdog`（fixture 页的兜底除外），
// 否则 `main.js` 看到的 stalled 与等待循环用的那份脱钩，诊断面板永不出现。
const reporter = createProgressReporter();
const watchdog = new LoadWatchdog();

/** 当前阶段：'p1' 脚本下载 / 'p2' 世界生成 / 'p3' 首帧渲染 */
let loadingPhase = 'p1';
/** 100ms 刷新计时器（`hideLoading` 里清） */
let loadingTimer = 0;
/**
 * 判 stall 那一刻的已下载脚本数（`null` = 从未判过 stall）。
 * ⚠️ 用它而不是布尔标志：网络恢复后 js 会继续增长，面板必须**自动**收起 ——
 * 只在玩家点按钮时才复位的布尔标志会留下一句过时的「网络似乎已断开」（见
 * `load-progress.js` 的 `shouldShowStallPanel` 注释）。
 */
let stallAtJsCount = null;

/** 把当前进度写进 DOM（幂等，可高频调用）。末尾同步 `__MC_BOOT__.loading` 供测试读取。 */
function paintLoading() {
  const fill = document.getElementById('loading-bar-fill');
  const bar = document.getElementById('loading-bar');
  const stat = document.getElementById('loading-stat');
  const text = document.getElementById('loading-text');
  const pct = reporter.percent();
  const label = formatPercent(pct);
  if (fill) fill.style.width = label;
  if (bar) bar.setAttribute('aria-valuenow', String(Math.round(Math.max(0, Math.min(100, pct)))));
  if (stat) stat.textContent = reporter.detail();
  if (text) {
    text.textContent = loadingPhase === 'p1' ? 'Loading'
      : loadingPhase === 'p2' ? 'Generating world' : 'Finishing';
  }
  window.__MC_BOOT__.loading = {
    percent: pct, phase: loadingPhase, stalled: watchdog.state().stalled,
  };
}

/**
 * 读内联采集器并上报 P1。
 * ⚠️ **采集器缺失必须静默降级**（CSP / 扩展 / 老浏览器）：不得抛、不得中断启动。
 * @returns {{js: number, total: number}|null}
 */
function reportP1() {
  const st = window.__MC_LOADING__;
  if (!st) { reporter.report('p1', 0, '正在加载…'); return null; }
  reporter.report('p1', p1Fraction(st.js), '已加载 ' + st.js + ' 个脚本');
  return { js: st.js, total: st.total };
}

/**
 * 零进展面板：展示可诊断信息 + 两个自救入口，**不自动失败**。
 *
 * ⚠️ 文案里**不得出现「超时」「timeout」**：那些词把「网络慢」误导成「功能坏了」，
 * 而本 Epic 要消灭的正是这条误导（旧文案 `column (9,8) 加载超时` 会让玩家去换浏览器）。
 * ⚠️ 也不得调用 `showError` —— 那会盖掉 loading 并让游戏彻底起不来。
 * @param {'stall'|'hard-cap'} verdict
 */
function showStall(verdict, jsNow) {
  if (stallAtJsCount !== null) return;   // 同一个 stall 事件只记一次快照
  stallAtJsCount = jsNow;
  const stat = document.getElementById('loading-stat');
  const actions = document.getElementById('loading-actions');
  const st = watchdog.state();
  const secs = Math.round(st.sinceProgressMs / 1000);
  const head = verdict === 'hard-cap' ? '加载时间较长' : '网络似乎已断开';
  if (stat) stat.textContent = head + ' · 已等待 ' + secs + ' 秒无进展 · 已加载 ' + jsNow + ' 个脚本';
  if (actions) actions.hidden = false;
}

/**
 * 按 `shouldShowStallPanel` 同步面板可见性（每次 tick 都调）。
 * 网络恢复（js 增长）⇒ 自动收起，不留过时文案。
 */
function syncStallPanel(jsNow) {
  if (stallAtJsCount === null) return;
  const show = shouldShowStallPanel({
    stalled: watchdog.state().stalled,
    jsGrewSinceStall: jsNow > stallAtJsCount,
  });
  if (!show) {
    const actions = document.getElementById('loading-actions');
    if (actions) actions.hidden = true;
    stallAtJsCount = null;
  }
}

/** 当前正在启动的 Game 实例（`new Game()` 之后立刻赋值，**不**等 `start()` 完成）。 */
let bootingGame = null;
/** 上一次 tick 的 JS 资源计数（判「资源还在下载」用，喂 watchdog 的进展信号） */
let lastJsCount = -1;

/**
 * 每 100ms 的刷新：判 stall、按阶段上报、重写 DOM。
 *
 * ⚠️ **P1 的下载进展在 P2 阶段仍然要参与计算**（v2.99 实测修正）：`new Game()` 之后
 * 到 `game.start()` 结束之间，Worker 的 874 个模块还在陆续到达 —— 若这时只算 P2
 * （`scheduler.stats().ready`，慢网络下长期为 0），进度条会**冻在 39.2%** 一动不动，
 * 而资源其实一直在下载（实测 200KB/s：js 从 161 涨到 852，进度条一个字没动）。
 * 这正是本 Epic 要消灭的「进度不可观测」。
 *
 * 规则：`reporter.report('p2', x)` 的 x **取 P1 与 P2 的较大者** —— P1 的渐近值在慢网络下
 * 会持续爬升（0.44→0.6→0.8…），P2 就绪列数在网络好的时候先满。两者都是「已经完成多少」，
 * 取大者既单调又不撒谎。
 */
function tickLoading() {
  const st = window.__MC_LOADING__;
  // 资源条目增加 = 真的有进展（唯一可信的 P1 进展信号）
  if (st && st.js > lastJsCount) {
    if (lastJsCount >= 0) watchdog.notifyProgress();
    lastJsCount = st.js;
  }
  // ⚠️ 整段用 try 包住：`tickLoading` 由 setInterval 驱动，**抛一次异常不会停掉计时器，
  // 但会跳过后面所有代码**（实测踩到：`bootingGame.scheduler` 在 `new Game()` 构造完成前
  // 是 undefined，每 100ms 抛一次 `Cannot read properties of undefined (reading 'stats')`，
  // 于是 `reportP1()` 永远跑不到、进度条冻在 39.2% 而 js 已从 161 涨到 695）。
  // 进度显示的任何内部错误都不得让启动流程或进度更新中断 —— 宁可少更新一帧。
  try {
    if (loadingPhase === 'p1') {
      reportP1();
    } else if (loadingPhase === 'p2') {
      const jsLoaded = st ? st.js : 0;
      const stats = bootingGame?.scheduler?.stats?.();
      if (stats) {
        const total = (2 * bootingGame.viewDistance + 1) ** 2;
        // 取「已下载」与「已就绪」的较大者 —— 推导与实测缺陷见 p2DisplayFraction 的注释
        const frac = p2DisplayFraction({ jsLoaded, readyColumns: stats.ready, totalColumns: total });
        reporter.report('p2', frac, '正在生成世界 ' + stats.ready + '/' + total
          + ' · 已加载 ' + jsLoaded + ' 个脚本');
      } else {
        reporter.report('p2', p2DisplayFraction({ jsLoaded, readyColumns: 0, totalColumns: 1 }),
          '正在加载 ' + jsLoaded + ' 个脚本');
      }
    }
    const jsNow = st ? st.js : 0;
    const verdict = watchdog.poll();
    if (verdict !== 'ok') showStall(verdict, jsNow);
    syncStallPanel(jsNow);
    paintLoading();
  } catch (err) {
    // 只记一次，避免每 100ms 刷屏（本仓口径：控制台噪音会掩盖真信号）
    if (!tickLoading._warned) {
      tickLoading._warned = true;
      console.warn('[loading] 进度刷新异常（已忽略，不影响启动）：', err);
    }
  }
}

/** 绑定 stall 面板的两个按钮（只绑一次，模块顶层）。 */
function bindStallButtons() {
  document.getElementById('loading-continue')?.addEventListener('click', () => {
    watchdog.reset();
    stallAtJsCount = null;
    const actions = document.getElementById('loading-actions');
    if (actions) actions.hidden = true;
    paintLoading();
  });
  document.getElementById('loading-reload')?.addEventListener('click', () => location.reload());
}

/**
 * 移除 loading 遮罩（幂等）。
 *
 * ⚠️ **必须既加 class 又置 `display:none`**：只加 class 时它仍是 `position:fixed; inset:0`
 * 的全屏盒子 —— 虽然 `pointer-events:none` 不挡点击，但它会继续参与合成（以及日后
 * 任何按 DOM 数层级的用法都会把它算进去）。只置 display 则没有淡出，观感是硬切。
 * 回调后置 none 是 `perf-hud.js` 折叠动画的同一手法（过渡结束再收尾）。
 */
function hideLoading() {
  const el = document.getElementById('loading-overlay');
  if (!el || el.classList.contains('mc-loading-done')) return;
  // 进度刷新到此为止（世界可玩后不需要再写 DOM）
  if (loadingTimer) { clearInterval(loadingTimer); loadingTimer = 0; }
  el.classList.add('mc-loading-done');
  setTimeout(() => { el.style.display = 'none'; }, LOADING_FADE_MS);
}

function showError(detail) {
  if (detail) document.getElementById('webgpu-error-detail').textContent = detail;
  document.getElementById('webgpu-error').style.display = 'flex';
  // 错误遮罩 z-index 100 > loading 95，但它下面那层 loading 仍在淡出中会透出一瞬
  // → 直接收掉（启动失败时不应该同时看到「Loading」）
  hideLoading();
}

async function boot() {
  setLoadingStage('正在检查 WebGPU…');
  // 启动进度：绑按钮 + 起 100ms 刷新（采集器自己的 onChange 也会推，但 UI 需要统一出口）
  bindStallButtons();
  reporter.report('p1', 0, '正在启动…');
  paintLoading();
  loadingTimer = setInterval(tickLoading, 100);
  // WebGPU 仅在安全上下文暴露（http://localhost 与 HTTPS）；
  // http://<局域网IP> 下 navigator.gpu 为 undefined，需单独提示，避免误判为浏览器不支持
  if (!window.isSecureContext) {
    window.__MC_BOOT__.error = 'insecure context';
    showError('WebGPU 仅在安全上下文可用：当前地址是 ' + location.origin +
      '，请改用 http://localhost:8081/ 或 HTTPS 地址打开。');
    return;
  }
  if (!navigator.gpu) {
    window.__MC_BOOT__.error = 'navigator.gpu unavailable';
    showError();
    return;
  }
  window.__MC_BOOT__.webgpu = true;

  setLoadingStage('正在加载方块注册表…');
  const registry = await buildDefaultRegistry();
  reportP1();
  const params = new URLSearchParams(location.search);
  // 调试开关 URL 覆盖：?stats=0 关闭世界数据看板统计（对照基线用），?stats=1 强制开
  if (params.get('stats') === '0') setDebugFlags({ worldStats: false });
  if (params.get('stats') === '1') setDebugFlags({ worldStats: true });
  // ?log=0 关闭世界数据控制台日志（HUD 仍显示），?log=1 强制开
  if (params.get('log') === '0') setDebugFlags({ statsLog: false });
  if (params.get('log') === '1') setDebugFlags({ statsLog: true });

  // 设置统一收口（M3-4）：URL > localStorage > 默认（core/ui/settings.js resolveSettings）。
  // ?blur=1 画质档（§4.4.1）：atlas 三线性 mipmap + anisotropy 8 消远处莫尔纹；默认像素风。
  // ?budget=high|low 帧预算档位覆盖（M3-2）；缺省 auto 按刷新率自动标定。
  // ?vd 视距覆盖；?style 视觉风格覆盖（M2-6）。
  const settings = resolveSettings(loadStoredSettings(), params);
  // ?weather=rain|clear 启动即强制天气（M3-3 调试/测试入口）；缺省自动随机周期。
  const weatherParam = params.get('weather');
  const startWeather = (weatherParam === 'rain' || weatherParam === 'clear') ? weatherParam : null;
  // ?seed= 调试/复现入口（M3-4）：显式指定则无存档时用之；缺省 null → 无存档随机生成、
  // 有存档读存档（确定性红线 2：seed 落库后重启读回同一 seed，地形可复现）。
  const seedParam = params.get('seed');
  const seed = seedParam !== null && Number.isFinite(Number(seedParam)) && Number(seedParam) > 0
    ? Math.floor(Number(seedParam)) : null;
  // ?shadows=0 代码级开关的 URL 入口（DR-7：默认开。只有 '0' 关——缺省/其它值都是默认开，
  // 与 ?guns/?tntDamage 的 `=== '1'` 反向口径一致：默认开则显式值与默认值相反）。
  // 不进设置面板（DR-7），故不过 resolveSettings，直接作构造选项传入。
  // ?skybox=0 关闭天空盒（v1.58；退回纯色天空 —— 观测口径与 v1.57 逐位相同，既有 Tier 4
  // spec 的隔离入口）。与 ?shadows=0 同一反向口径：默认开则只有 '0' 关。
  // 不进设置面板，故不过 resolveSettings，直接作构造选项传入。
  const skybox = params.get('skybox') !== '0';
  const shadows = params.get('shadows') !== '0';
  // ?reflect=0 关闭水面倒影（v3.17）。与 ?shadows / ?skybox 同一反向口径：
  // 默认开，只有显式 '0' 关。不进 resolveSettings（不持久化）—— 它是 Tier 4 做
  // 单变量 A/B 的隔离入口，玩家侧的开关在右下角常驻调参坞。
  const reflect = params.get('reflect') !== '0';
  setLoadingStage('正在生成世界…');
  loadingPhase = 'p2';
  const game = new Game({
    canvas: document.getElementById('app-canvas'),
    registry, seed,
    viewDistance: settings.viewDistance,
    hudRoot: document.getElementById('hud-root'),
    blurMipmap: settings.blur,
    budgetProfile: settings.budgetProfile,
    chunkPace: settings.chunkPace,
    startWeather,
    shadows,
    skybox,
    reflect,
    settings,
    // 启动进展计时器的唯一实例（见文件头注释：全仓只允许一个）
    watchdog,
  });
  // ⚠️ **必须在这里**（不是 `await game.start()` 之后）：P2 阶段要读
  // `game.scheduler.stats()`，而 `start()` 在慢网络下要跑几分钟 —— 只认
  // `window.__MC_GAME__`（start 完才赋值）会让整个 P2 阶段的进度条冻住。
  bootingGame = game;
  await game.start();
  window.__MC_BOOT__.rendererReady = true;
  window.__MC_GAME__ = game; // 测试钩子
  // P3 首帧渲染：**必须在真的画完一帧之后**才置 100% 并淡出。
  // `game.start()` 只到 `setAnimationLoop` 注册为止，那一刻还没有任何一帧被画出来 ——
  // 在它下一行直接 hideLoading 会让慢 GPU 上先黑一瞬，也让「首帧渲染」这个阶段名不副实。
  loadingPhase = 'p3';
  reporter.report('p3', 0, '正在绘制首帧');
  paintLoading();
  requestAnimationFrame(() => {
    reporter.report('p3', 1, '准备完成');
    paintLoading();
    hideLoading();
  });
}

boot().catch((err) => {
  window.__MC_BOOT__.error = String(err);
  // 启动失败的原因不只有 WebGPU —— 存档库/网络/模型加载都可能在这里抛。静态遮罩的
  // 默认文案只适合「拿不到 adapter」那一种，直接用会把别的原因显示成「浏览器不支持
  // WebGPU」（实测：IndexedDB 的 VersionError 被误报成浏览器版本过低，玩家照提示换浏览器
  // 而完全无效）。故把已知的非 WebGPU 类失败改成准确提示。
  const name = err && err.name ? String(err.name) : '';
  const known = {
    VersionError: '存档库版本与当前代码不一致，且重建失败：请关闭其他 mc-heavy 标签页后重试。',
    QuotaExceededError: '浏览器存储空间不足，无法写入存档：请清理磁盘空间或站点数据后重试。',
  };
  const hint = known[name]
    || (window.__MC_BOOT__.webgpu ? `初始化失败：${err}` : null);
  if (hint) {
    // 已拿到 WebGPU adapter 时，渲染能力不是原因 → 换掉那条「请使用最新版 Chrome」的提示
    const note = document.getElementById('webgpu-error-note');
    if (note) note.textContent = hint;
  }
  showError('启动失败：' + err);
});
