// src/core/game.js — 主循环编排（§4.9）：input→physics→schedule→budget→render
// M1 范围：世界流式加载 + 地形渲染；玩家移动/交互 Task 9 接入。
import * as THREE from 'three';
import { WorldData } from '../voxel/world-data.js';
import { Scheduler } from './scheduler.js';
import { WorkerPool } from './worker-pool.js';
import { PerfMonitor } from './perf.js';
import { PerfHUD } from './perf-hud.js';
import { DEBUG_FLAGS } from './debug-config.js';
import { RenderWorld } from '../render/render-world.js';
import { setupFog } from '../render/materials.js';
import { setupOcean } from '../render/ocean.js';
import { DayNight } from '../render/daynight.js';
import { loadAtlas } from '../mesh/atlas-loader.js';
import { findSpawnY } from '../gen/terrain.js';
import { getCitySpawnPoint } from '../gen/structures/city-layout.js';
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
   * @param {boolean} [opts.blurMipmap] blur 档位（§4.4.1）：atlas 开 mipmap 消远处莫尔纹
   */
  constructor({ canvas, registry, seed, viewDistance = 8, hudRoot, blurMipmap = false }) {
    this.registry = registry;
    this.seed = seed;
    this.viewDistance = viewDistance;
    this.blurMipmap = blurMipmap;
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
    /** 每帧 render 后捕获的 renderer.info 快照（异步读取不撞 autoReset 重置点） */
    this._lastRenderInfo = { drawCalls: 0, triangles: 0 };
  }

  async start() {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    await this.renderer.init();

    // atlas：纹理 + tileRect 元数据（broadcast 给 Worker 供 mesher 查 UV）
    const { texture } = await loadAtlas({ mipmap: this.blurMipmap });
    this._atlasTexture = texture; // 调试/测试引用
    const atlasMeta = await (await fetch('/assets/atlas.json')).json();
    this.pool.broadcast('atlas-meta', atlasMeta);
    // 调试开关同步给 Worker（mesher 与主线程快速路径同构生效，§4.9）
    this.pool.broadcast('debug-flags', { ...DEBUG_FLAGS });

    this.scene.background = new THREE.Color(0x87ceeb);
    const fogUniforms = setupFog(this.scene, this.viewDistance);
    this.ocean = setupOcean(this.scene);
    this.renderWorld = new RenderWorld({ scene: this.scene, atlasTexture: texture, viewDistance: this.viewDistance });
    // 日夜循环（M2-6）：正午起步（与 M1 视觉口径一致），1200s 一天
    this.dayNight = new DayNight({
      scene: this.scene,
      fog: fogUniforms,
      voxelUniforms: this.renderWorld.materials.dayNight,
      baseFogNear: this.viewDistance * 16 * 0.75,
      baseFogFar: (this.viewDistance + 2) * 16 * 0.95,
    });

    // 存档：打开 IndexedDB、恢复 seed（edits 预热在出生点确定后，§4.8）
    this.persistence = new Persistence();
    await this.persistence.open();
    const meta = await this.persistence.loadMeta();
    const hadMeta = !!(meta && meta.seed !== undefined);
    if (hadMeta) this.seed = meta.seed;
    else await this.persistence.saveMeta({ seed: this.seed, spawn: [8, 8], savedAt: Date.now() });
    this.ocean.setSeed(this.seed);

    this.scheduler = new Scheduler({
      world: this.world, pool: this.pool, registry: this.registry,
      seed: this.seed, viewDistance: this.viewDistance, perf: this.perf,
      renderWorld: this.renderWorld,
      getEdits: (key) => this.persistence.getEditsSync(key),
    });
    this.scheduler._atlasMeta = atlasMeta; // 快速路径主线程 mesh 用（与 broadcast 同一份）

    // 出生点（mc-lite 语义：优先 City 中心出生，保证出生即见城市天际线，§7 M2 验收）
    const regionLayout = await this.scheduler.structureIndex.waitForRegion(0, 0);
    const citySpawn = getCitySpawnPoint(regionLayout.city);
    this.spawnX = citySpawn.x; this.spawnZ = citySpawn.z;
    if (!hadMeta) {
      await this.persistence.saveMeta({ seed: this.seed, spawn: [this.spawnX, this.spawnZ], savedAt: Date.now() });
    }
    {
      const R = this.viewDistance;
      const pcx = Math.floor(this.spawnX / 16), pcz = Math.floor(this.spawnZ / 16);
      const keys = [];
      for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) keys.push(`${pcx + dx},${pcz + dz}`);
      await this.persistence.preloadEdits(keys);
    }
    this.scheduler.update(this.spawnX, this.spawnZ);
    await this._waitForColumn(Math.floor(this.spawnX / 16), Math.floor(this.spawnZ / 16), 10000);
    this.spawnY = findSpawnY(this.world, this.spawnX, this.spawnZ);
    // 玩家出生（第一人称，眼高由 Player 管）
    this.player = new Player({
      world: this.world, camera: this.camera, scheduler: this.scheduler,
      registry: this.registry, canvas: this.renderer.domElement,
    });
    this.player.spawn(this.spawnX, this.spawnY, this.spawnZ);
    this.scene.add(this.player.highlight);
    this.worldReady = true;

    this._hud = new PerfHUD(this.perf, this._hudRoot,
      DEBUG_FLAGS.worldStats ? () => this.worldStats() : null);
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
      this.ocean.update(this.camera, dt);
      this.dayNight.update(dt);
      this._hud.update(nowMs);
      this.renderer.render(this.scene, this.camera);
      // info 在每帧 render 前被 autoReset 清零，render 后捕获才是本帧真实值
      // （HUD/测试异步读取 renderer.info 会撞上重置点，必须在此快照）
      this._lastRenderInfo = {
        drawCalls: this.renderer.info.render.drawCalls,
        triangles: this.renderer.info.render.triangles,
      };
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
  /** 切换视觉风格（'morning'/'noon'/'night'，null 恢复日夜循环；M2-6，M3 设置面板接入） */
  setVisualStyle(key) { this.dayNight.setStyle(key); }
  renderStats() {
    return { ...this.renderWorld.stats(), drawCalls: this._lastRenderInfo.drawCalls };
  }

  /**
   * 世界数据看板（HUD 2s 异步刷新）：体素/面剔除统计 + 通道级合批统计 + draw call。
   * 对应 mc-lite 面板的方块数/面数/剔除面数/合并 mesh 数/节省渲染量语义。
   * drawCalls/triangles 读 _lastRenderInfo（render 后快照），避免异步读撞上 autoReset 清零。
   */
  worldStats() {
    const voxel = this.scheduler.worldStats();
    const rw = this.renderWorld.stats();
    return {
      ...voxel,
      channels: rw.channels,
      sections: rw.sections,
      columns: this.world.columns.size,
      drawCalls: this._lastRenderInfo.drawCalls,
      triangles: this._lastRenderInfo.triangles,
    };
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    this.pool.dispose();
    this.renderer.dispose();
  }
}
