// src/main.js — 启动入口：WebGPU gate → 空白场景渲染循环
import * as THREE from 'three';

window.__MC_BOOT__ = { webgpu: false, rendererReady: false, error: null };

async function boot() {
  if (!navigator.gpu) {
    window.__MC_BOOT__.error = 'navigator.gpu unavailable';
    document.getElementById('webgpu-error').style.display = 'flex';
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

  renderer.setAnimationLoop(() => {
    renderer.render(scene, camera);
  });
}

boot().catch((err) => {
  window.__MC_BOOT__.error = String(err);
  document.getElementById('webgpu-error').style.display = 'flex';
});
