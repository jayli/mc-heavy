// src/main.js — 启动入口：WebGPU gate → Game
import { Game } from './core/game.js';
import { buildDefaultRegistry } from './voxel/block-registry.js';
import { setDebugFlags } from './core/debug-config.js';
import { loadStoredSettings, resolveSettings } from './ui/settings.js';

window.__MC_BOOT__ = { webgpu: false, rendererReady: false, error: null };

function showError(detail) {
  if (detail) document.getElementById('webgpu-error-detail').textContent = detail;
  document.getElementById('webgpu-error').style.display = 'flex';
}

async function boot() {
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
  const game = new Game({
    canvas: document.getElementById('app-canvas'),
    registry, seed,
    viewDistance: settings.viewDistance,
    hudRoot: document.getElementById('hud-root'),
    blurMipmap: settings.blur,
    budgetProfile: settings.budgetProfile,
    startWeather,
    shadows,
    skybox,
    settings,
  });
  await game.start();
  window.__MC_BOOT__.rendererReady = true;
  window.__MC_GAME__ = game; // 测试钩子
}

boot().catch((err) => {
  window.__MC_BOOT__.error = String(err);
  showError('启动失败：' + err);
});
