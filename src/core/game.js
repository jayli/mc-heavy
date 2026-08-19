// src/core/game.js — 主循环编排（§4.9）：input→physics→schedule→budget→render
// M1 范围：世界流式加载 + 地形渲染；玩家移动/交互 Task 9 接入。
import * as THREE from 'three';
import { WorldData } from '../voxel/world-data.js';
import { Scheduler } from './scheduler.js';
import { WorkerPool } from './worker-pool.js';
import { PerfMonitor } from './perf.js';
import { PerfHUD } from './perf-hud.js';
import { RenderWorld } from '../render/render-world.js';
import { setupFog } from '../render/materials.js';
import { loadAtlas } from '../mesh/atlas-loader.js';
import { findSpawnY } from '../gen/terrain.js';

export class Game {
  /**
   * @param {Object} opts
   * @param {HTMLCanvasElement} opts.canvas
   * @param {*} opts.registry - BlockRegistry 实例
   * @param {number} opts.seed
   * @param {number} [opts.viewDistance] 默认 8（测试可传 2 加速）
   * @param {HTMLElement} opts.hudRoot
   */
  constructor({ canvas, registry, seed, viewDistance = 8, hudRoot }) {
    this.registry = registry;
    this.seed = seed;
    this.viewDistance = viewDistance;
    this.world = new WorldData(registry);
    this.perf = new PerfMonitor();
    this.pool = new WorkerPool({ workerUrl: '/src/workers/world-worker.js' });
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, viewDistance * 16 * 1.2);
    this.worldReady = false;
    this._hudRoot = hudRoot;
  }

  async start() {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    await this.renderer.init();

    // atlas：纹理 + tileRect 元数据（broadcast 给 Worker 供 mesher 查 UV）
    const { texture } = await loadAtlas();
    this._atlasTexture = texture; // 调试/测试引用
    const atlasMeta = await (await fetch('/assets/atlas.json')).json();
    this.pool.broadcast('atlas-meta', atlasMeta);

    this.scene.background = new THREE.Color(0x87ceeb);
    setupFog(this.scene, this.viewDistance);
    this.renderWorld = new RenderWorld({ scene: this.scene, atlasTexture: texture, viewDistance: this.viewDistance });

    this.scheduler = new Scheduler({
      world: this.world, pool: this.pool, registry: this.registry,
      seed: this.seed, viewDistance: this.viewDistance, perf: this.perf,
      renderWorld: this.renderWorld,
    });

    // 出生点：(8, 8) 列，3×3 先就绪即可玩（§4.2 冷启动口径）
    this.spawnX = 8; this.spawnZ = 8;
    this.scheduler.update(this.spawnX, this.spawnZ);
    await this._waitForColumn(0, 0, 10000);
    this.spawnY = findSpawnY(this.world, this.spawnX, this.spawnZ);
    this.camera.position.set(this.spawnX, this.spawnY + 20, this.spawnZ + 20);
    this.camera.lookAt(this.spawnX, this.spawnY, this.spawnZ);
    this.worldReady = true;

    this._hud = new PerfHUD(this.perf, this._hudRoot);
    window.addEventListener('resize', () => this._onResize());
    this._onResize();

    this.renderer.setAnimationLoop((nowMs) => {
      this.perf.tick(nowMs);
      this.scheduler.update(this.spawnX, this.spawnZ); // Task 9 改为玩家实时位置
      this._hud.update(nowMs);
      this.renderer.render(this.scene, this.camera);
    });
  }

  _waitForColumn(cx, cz, timeoutMs) {
    return new Promise((resolve, reject) => {
      const t0 = performance.now();
      const timer = setInterval(() => {
        if (this.world.hasColumn(cx, cz)) { clearInterval(timer); resolve(); }
        else if (performance.now() - t0 > timeoutMs) { clearInterval(timer); reject(new Error('spawn column timeout')); }
      }, 50);
    });
  }

  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  perfSnapshot() { return this.perf.snapshot(); }
  renderStats() {
    return { ...this.renderWorld.stats(), drawCalls: this.renderer.info.render.drawCalls };
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    this.pool.dispose();
    this.renderer.dispose();
  }
}
