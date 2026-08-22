// src/main.js — 启动入口：WebGPU gate → Game
import { Game } from './core/game.js';
import { buildDefaultRegistry } from './voxel/block-registry.js';
import { setDebugFlags } from './core/debug-config.js';

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
  const seed = 12345; // M1 固定 seed（M2 接存档/随机）
  const params = new URLSearchParams(location.search);
  // 调试开关 URL 覆盖：?stats=0 关闭世界数据看板统计（对照基线用），?stats=1 强制开
  if (params.get('stats') === '0') setDebugFlags({ worldStats: false });
  if (params.get('stats') === '1') setDebugFlags({ worldStats: true });
  // ?log=0 关闭世界数据控制台日志（HUD 仍显示），?log=1 强制开
  if (params.get('log') === '0') setDebugFlags({ statsLog: false });
  if (params.get('log') === '1') setDebugFlags({ statsLog: true });
  const game = new Game({
    canvas: document.getElementById('app-canvas'),
    registry, seed,
    viewDistance: params.get('vd') ? Number(params.get('vd')) : 8,
    hudRoot: document.getElementById('hud-root'),
  });
  await game.start();
  window.__MC_BOOT__.rendererReady = true;
  window.__MC_GAME__ = game; // 测试钩子
}

boot().catch((err) => {
  window.__MC_BOOT__.error = String(err);
  showError('启动失败：' + err);
});
