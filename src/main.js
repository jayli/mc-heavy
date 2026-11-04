// src/main.js — 启动入口：WebGPU gate → Game
import { Game } from './core/game.js';
import { buildDefaultRegistry } from './voxel/block-registry.js';
import { setDebugFlags } from './core/debug-config.js';
import { loadStoredSettings, resolveSettings } from './ui/settings.js';

window.__MC_BOOT__ = { webgpu: false, rendererReady: false, error: null };

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
  setLoadingStage('正在生成世界…');
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
    settings,
  });
  await game.start();
  window.__MC_BOOT__.rendererReady = true;
  window.__MC_GAME__ = game; // 测试钩子
  hideLoading();
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
