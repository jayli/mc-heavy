// src/main.js — 启动入口：WebGPU gate → 空白场景渲染循环
import * as THREE from 'three';
import { PerfMonitor } from './core/perf.js';
import { PerfHUD } from './core/perf-hud.js';

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

  const canvas = document.getElementById('app-canvas');
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  await renderer.init();
  window.__MC_BOOT__.rendererReady = true;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb); // 天空蓝，验收"非黑屏"用

  const camera = new THREE.PerspectiveCamera(
    70, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0, 8, 16);
  camera.lookAt(0, 0, 0);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  const perf = new PerfMonitor();
  const hud = new PerfHUD(perf, document.getElementById('hud-root'));

  renderer.setAnimationLoop((nowMs) => {
    perf.tick(nowMs);
    hud.update(nowMs);
    renderer.render(scene, camera);
  });
}

boot().catch((err) => {
  window.__MC_BOOT__.error = String(err);
  showError('启动失败：' + err);
});
