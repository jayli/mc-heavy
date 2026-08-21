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
import { Player } from '../player/player.js';
import { Persistence } from '../save/persistence.js';

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
    // far 覆盖加载半径对角线（滞回 +2 圈 × 16 × sqrt2 余量），与 setupFog 口径一致
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, (viewDistance + 2) * 16 * 1.5);
    this.worldReady = false;
    this._hudRoot = hudRoot;
    this.player = null;
    this._lastFrameMs = -1;
    this.persistence = null;
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

    // 存档：打开 IndexedDB、恢复 seed、预热视距内 edits 缓存（GEN 前必命中，§4.8）
    this.persistence = new Persistence();
    await this.persistence.open();
    const meta = await this.persistence.loadMeta();
    if (meta && meta.seed !== undefined) this.seed = meta.seed;
    else await this.persistence.saveMeta({ seed: this.seed, spawn: [8, 8], savedAt: Date.now() });
    {
      const R = this.viewDistance;
      const keys = [];
      for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) keys.push(`${dx},${dz}`);
      await this.persistence.preloadEdits(keys);
    }

    this.scheduler = new Scheduler({
      world: this.world, pool: this.pool, registry: this.registry,
      seed: this.seed, viewDistance: this.viewDistance, perf: this.perf,
      renderWorld: this.renderWorld,
      getEdits: (key) => this.persistence.getEditsSync(key),
    });
    this.scheduler._atlasMeta = atlasMeta; // 快速路径主线程 mesh 用（与 broadcast 同一份）

    // 出生点：(8, 8) 列，3×3 先就绪即可玩（§4.2 冷启动口径）
    this.spawnX = 8; this.spawnZ = 8;
    this.scheduler.update(this.spawnX, this.spawnZ);
    await this._waitForColumn(0, 0, 10000);
    this.spawnY = findSpawnY(this.world, this.spawnX, this.spawnZ);
    // 玩家出生（第一人称，眼高由 Player 管）
    this.player = new Player({
      world: this.world, camera: this.camera, scheduler: this.scheduler,
      registry: this.registry, canvas: this.renderer.domElement,
    });
    this.player.spawn(this.spawnX, this.spawnY, this.spawnZ);
    this.scene.add(this.player.highlight);
    this.worldReady = true;

    this._hud = new PerfHUD(this.perf, this._hudRoot);
    window.addEventListener('resize', () => this._onResize());
    this._onResize();
    // 存档 flush：页面隐藏/退出立即写盘（§4.8）
    window.addEventListener('visibilitychange', () => {
      if (document.hidden) this.persistence.flushNow(this.world);
    });
    window.addEventListener('beforeunload', () => this.persistence.flushNow(this.world));

    this.renderer.setAnimationLoop((nowMs) => {
      this.perf.tick(nowMs);
      // dt（秒）：首帧为 0，钳制上限 0.1s 防后台切回大步长
      const dt = this._lastFrameMs < 0 ? 0 : Math.min((nowMs - this._lastFrameMs) / 1000, 0.1);
      this._lastFrameMs = nowMs;
      this.player.update(dt);
      this.scheduler.update(this.player.physics.pos.x, this.player.physics.pos.z);
      this.persistence.scheduleFlush(this.world); // 5s 防抖写盘（有 edits 才真正写）
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
        else this.scheduler.update(this.spawnX, this.spawnZ); // 布局门控后 GEN 需后续帧驱动（动画循环尚未启动）
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
