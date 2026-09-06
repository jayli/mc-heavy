// src/core/game.js — 主循环编排（§4.9）：input→physics→schedule→budget→render
// M1 范围：世界流式加载 + 地形渲染；玩家移动/交互 Task 9 接入。
import * as THREE from 'three';
import { WorldData } from '../voxel/world-data.js';
import { Scheduler } from './scheduler.js';
import { WorkerPool } from './worker-pool.js';
import { PerfMonitor } from './perf.js';
import { PerfHUD } from './perf-hud.js';
import { BudgetConfig } from './budget.js';
import { DEBUG_FLAGS } from './debug-config.js';
import { RenderWorld } from '../render/render-world.js';
import { setupFog } from '../render/materials.js';
import { setupOcean } from '../render/ocean.js';
import { DayNight } from '../render/daynight.js';
import { RainEffect } from '../render/rain.js';
import { WeatherState } from '../render/weather.js';
import { WeaponModelLoader } from '../render/weapon-model-loader.js';
import { AudioManager } from '../render/audio-manager.js';
import { ViewWeapon } from '../render/view-weapon.js';
import { TracerRenderer } from '../render/tracer-renderer.js';
import { WorldEditor } from './world-editor.js';
import { loadAtlas } from '../mesh/atlas-loader.js';
import { findSpawnY } from '../gen/terrain.js';
import { getCitySpawnPoint, getCityInfo } from '../gen/structures/city-layout.js';
import { Player } from '../player/player.js';
import { Persistence } from '../save/persistence.js';
import { CoordsHUD } from '../ui/coords-hud.js';
import { SettingsPanel } from '../ui/settings-panel.js';
import { createHotbar } from '../ui/hotbar.js';
import { InventoryPanel } from '../ui/inventory.js';
import { loadIconManifest } from '../ui/icons.js';
import { getBiome } from '../gen/noise.js';
import { loadStoredSettings, resolveSettings } from '../ui/settings.js';

/** 随机世界 seed（M3-4 新世界）：24bit 正整数，避开 0（noise 退化）与负值 */
export function randomSeed() {
  return 1 + Math.floor(Math.random() * 0xFFFFFF);
}

export class Game {
  /**
   * @param {Object} opts
   * @param {HTMLCanvasElement} opts.canvas
   * @param {*} opts.registry - BlockRegistry 实例
   * @param {number|null} [opts.seed] 显式 seed（?seed= 调试入口）；缺省 null → 无存档时随机生成（M3-4）
   * @param {number} [opts.viewDistance] 默认 8（测试可传 2 加速）
   * @param {HTMLElement} opts.hudRoot
   * @param {boolean} [opts.blurMipmap] blur 档位（§4.4.1）：atlas 开 mipmap 消远处莫尔纹
   * @param {'auto'|'high'|'low'} [opts.budgetProfile] 帧预算档位覆盖（M3-2；默认 auto）
   * @param {'rain'|'clear'|null} [opts.startWeather] 启动即强制天气（M3-3 调试/测试；null 自动周期）
   * @param {Object} [opts.settings] 生效设置（main.js resolveSettings 结果；缺省 start() 内自行合并）
   */
  constructor({ canvas, registry, seed = null, viewDistance = 8, hudRoot, blurMipmap = false, budgetProfile = 'auto', startWeather = null, settings = null }) {
    this._settings = settings;
    this.registry = registry;
    this.seed = seed; // null → start() 中无存档时 randomSeed()（有存档恒读存档）
    this.viewDistance = viewDistance;
    /**
     * 模态栈（M3.1，§4.5.4）：设置面板与背包共用。原为可写布尔，单消费者时够用；
     * 两个面板后会互相踩（设置开着时开/关背包会误清门控）。
     * 栈内每项是 owner 标识（'settings' | 'inventory'）；`uiModal` getter = 栈非空。
     */
    this._modals = [];
    this.blurMipmap = blurMipmap;
    this.world = new WorldData(registry);
    this.perf = new PerfMonitor();
    /** 帧预算双档标定（M3-2）：Scheduler 上传/下发预算从这里读，主循环喂帧间隔 */
    this.budget = new BudgetConfig({ profile: budgetProfile });
    this.pool = new WorkerPool({ workerUrl: '/src/workers/world-worker.js' });
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
    this.scene = new THREE.Scene();
    // far 覆盖加载半径对角线（滞回 +2 圈 × 16 × sqrt2 余量），与 setupFog 口径一致
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, (viewDistance + 2) * 16 * 1.5);
    // M4：camera 必须加入 scene 图——three.js 中挂在 camera 下的子节点（视图武器模型）
    // 只有当 camera 本身在 scene 里才会被渲染。对齐 mc-lite Engine.js:139
    // `this.scene.add(this.camera)`；不加则 ViewWeapon 把枪挂到 camera 后永不渲染
    // （表现为「按 R 切武器没反应」）。camera 自身无几何，加入 scene 不产生 draw call。
    this.scene.add(this.camera);
    this.worldReady = false;
    this._hudRoot = hudRoot;
    this._startWeather = startWeather;
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
    // M4：武器模型灯光（设计文档 §4.2「武器模型灯光」段）—— GLTFLoader 对 GLB 生成
    // MeshPhysicalMaterial（PBR，必须吃场景灯光），而 mc-heavy 全场景是 unlit 设计（体素亮度
    // 烘焙在顶点 shade，ocean/rain/tracer/highlight 均不吃灯光），场景原本零灯光 → 枪体渲染
    // 为纯黑（建模颜色没丢在资源里，丢在渲染端没有光源）。补 mc-lite 同款双灯：
    // AmbientLight(0xddeeff, 2.3) = Engine.js:194 的 1 × _ambientBoost（TSL 管线间接漫射偏暗的
    // 经验补偿）；DirectionalLight(0xfffaf0, 3.2) 方向 [0,0.8,0.6]（Engine.js:168,161）——
    // 手枪 METAL 材质 metallicFactor=1（金属 diffuse 为 0、全靠镜面反射），只有环境光金属件
    // 仍然发黑，方向光高光不可省。灯光只影响 PBR 材质（枪），unlit 材质一律不吃灯光 →
    // 世界视觉零回归。方向恒定不跟随玩家：mc-lite 的光源跟随（Game.js:556）是为阴影投射
    // 服务，mc-heavy 不开 castShadow；月光与日夜灯光调制不移植（体素日夜走独立 uniform 体系）。
    this.scene.add(new THREE.AmbientLight(0xddeeff, 2.3));
    const weaponSun = new THREE.DirectionalLight(0xfffaf0, 3.2);
    weaponSun.position.set(0, 0.8, 0.6); // 光源在太阳方向 → 照射方向 = -[0,0.8,0.6]（mc-lite 口径）
    this.scene.add(weaponSun);
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
    // M3-4：有存档读存档；无存档时——opts.seed 显式指定（?seed= 调试入口）则用之，
    // 否则随机生成（roadmap「新世界」语义；随机 seed 保证每次新档地形不同）。
    this.persistence = new Persistence();
    await this.persistence.open();
    const meta = await this.persistence.loadMeta();
    const hadMeta = !!(meta && meta.seed !== undefined);
    if (hadMeta) this.seed = meta.seed;
    else {
      if (this.seed === null || this.seed === undefined) {
        this.seed = randomSeed();
      }
      await this.persistence.saveMeta({ seed: this.seed, spawn: [8, 8], savedAt: Date.now() });
    }
    this.ocean.setSeed(this.seed);

    this.scheduler = new Scheduler({
      world: this.world, pool: this.pool, registry: this.registry,
      seed: this.seed, viewDistance: this.viewDistance, perf: this.perf,
      renderWorld: this.renderWorld, budget: this.budget,
      getEdits: (key) => this.persistence.getEditsSync(key),
    });
    this.scheduler._atlasMeta = atlasMeta; // 快速路径主线程 mesh 用（与 broadcast 同一份）
    // M4-0：世界编辑协调器 —— 唯一世界写入入口（remesh/light/event）。
    // 玩家挖放、武器破坏、未来 TNT 全部经此，不持有第二份体素真相。
    this.editor = new WorldEditor({ world: this.world, scheduler: this.scheduler });

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
    // M4：武器渲染/音频运行时（只在主线程；不进 Worker/体素 meshing 管线）。
    // 模型加载失败只记录 console，不中止 worldReady——玩家保持徒手可玩。
    this.weaponModelLoader = new WeaponModelLoader();
    this.audioManager = new AudioManager(this.camera);
    this.audioManager.preload().catch((err) => console.warn('[audio] preload failed:', err));
    this.viewWeapon = new ViewWeapon({ camera: this.camera, modelLoader: this.weaponModelLoader });
    this.tracerRenderer = new TracerRenderer({ scene: this.scene });
    // 玩家出生（第一人称，眼高由 Player 管）
    this.player = new Player({
      world: this.world, camera: this.camera, scheduler: this.scheduler,
      registry: this.registry, canvas: this.renderer.domElement,
      editor: this.editor,
      weaponRuntime: {
        viewWeapon: this.viewWeapon,
        tracerRenderer: this.tracerRenderer,
        audioManager: this.audioManager,
      },
      // M3.1 模态守卫（§4.5.4）：面板打开时 Player 的 keydown 全部拦截。
      // 谓词注入而非传 Game 本身，保持 player/ 不反向依赖 core/（依赖方向 §3）
      isModal: () => this.uiModal,
    });
    this.player.spawn(this.spawnX, this.spawnY, this.spawnZ);
    this.scene.add(this.player.highlight);

    // 天气 + 雨效（M3-3）：状态机自动周期（晴 60~180s → 雨 30~90s，5s 过渡），
    // rain 效果移植 mc-lite RainEffect（world.isSolid 地面截停；267 滴分批迁移削峰）
    this.weather = new WeatherState();
    if (this._startWeather) this.weather.force(this._startWeather);
    this.rain = new RainEffect(this.scene, {
      world: this.world,
      playerPos: this.player.physics.pos,
    });
    this.rain.setIntensity(this.weather.intensity);

    this._hud = new PerfHUD(this.perf, this._hudRoot,
      DEBUG_FLAGS.worldStats ? () => this.worldStats() : null);
    // M3-4 HUD：坐标+biome、快捷栏（atlas tile CSS 裁剪）、设置面板
    this._coordsHud = new CoordsHUD(this._hudRoot, this);
    // v1.26：图标走预生成的 CSS 串（`npm run icons` → assets/icons.json）。
    // 两套尺寸档：hotbar=40px / inventory=32px —— 按显示尺寸烘焙，运行时零缩放。
    // 取代此前的 atlasTiles/atlasSize/tileOfName/atlasUrl 四个参数 + 运行时裁剪数学。
    const iconManifest = await loadIconManifest();
    // M3.1：快捷栏是背包前 5 格的视图（§4.5.4），内容/高亮都读 inventory，
    // 不再有第二份物品状态
    this._hotbar = createHotbar(this._hudRoot, {
      inventory: this.player.inventory,
      icons: iconManifest.hotbar,
    });
    // M3.1：背包面板（Z toggle / Escape 关闭 / 点击槽位选中；模态栈 owner 'inventory'）
    this.inventoryPanel = new InventoryPanel(this._hudRoot, this, {
      icons: iconManifest.inventory,
    });
    // 生效设置：main.js 已 resolve（存储+URL）传入；缺省自行合并（fixture 页直建 Game 时）
    this.settings = this._settings || resolveSettings(loadStoredSettings(), new URLSearchParams(location.search));
    this.settingsPanel = new SettingsPanel(this._hudRoot, this, this.settings);
    // 启动应用视觉风格（设置持久化：null=日夜循环，M2-6）
    if (this.settings.visualStyle) this.setVisualStyle(this.settings.visualStyle);
    this.worldReady = true;

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
      // M3-2：预算判档喂原始（未钳制）帧间隔——vsync 量化值正是测量对象
      if (this._lastFrameMs >= 0) this.budget.observeFrame(nowMs - this._lastFrameMs);
      this._lastFrameMs = nowMs;
      // 设置面板打开时跳过玩家输入/物理（世界调度继续：后台填充不受 UI 阻塞）
      if (!this.uiModal) this.player.update(dt);
      this.scheduler.update(this.player.physics.pos.x, this.player.physics.pos.z);
      this.persistence.scheduleFlush(this.world); // 5s 防抖写盘（有 edits 才真正写）
      this.ocean.update(this.camera, dt);
      this.dayNight.update(dt);
      // 天气状态机推进 + 雨强度接线 + 雨幕跟随玩家（30Hz 内部检查）
      this.weather.update(dt);
      this.rain.setIntensity(this.weather.intensity);
      if (this.weather.isRaining) this.rain.update(this.player.physics.pos, dt);
      this._hud.update(nowMs);
      this._coordsHud.update(nowMs);
      this._hotbar.update(this.player.hotbarIndex);
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

  /**
   * 模态标志（M3.1，§4.5.4）：栈非空即 true —— 主循环跳过 `player.update`、
   * `Player._bindInput()` 的 keydown 守卫拦截按键。**只读**，面板通过 push/popModal 改动。
   */
  get uiModal() { return this._modals.length > 0; }

  /**
   * 打开一个模态面板（幂等：同一 owner 重复 push 不叠层）。
   * @param {string} owner 面板标识（'settings' | 'inventory'）
   */
  pushModal(owner) {
    if (!this._modals.includes(owner)) this._modals.push(owner);
  }

  /**
   * 关闭一个模态面板。**只移除自己的 owner**，不误清其他面板的门控
   * （原可写布尔的竞争根因：设置面板开着时关背包会把门控一起清掉）。
   * @param {string} owner 面板标识
   */
  popModal(owner) {
    const i = this._modals.indexOf(owner);
    if (i >= 0) this._modals.splice(i, 1);
  }

  perfSnapshot() { return this.perf.snapshot(); }
  /** 切换视觉风格（'morning'/'noon'/'night'，null 恢复日夜循环；M2-6，M3 设置面板接入） */
  setVisualStyle(key) { this.dayNight.setStyle(key); }

  /** 玩家位置的 biome 名（M3-4 坐标 HUD；CITY 布局边界优先，否则 getBiome 纯函数） */
  biomeAt(x, z) {
    const layout = this.scheduler?.structureIndex?._layouts?.get('0,0');
    if (layout?.city && getCityInfo(Math.floor(x), Math.floor(z), layout.city)) return 'CITY';
    return getBiome(Math.floor(x), Math.floor(z), this.seed);
  }

  /**
   * 切换视距（M3-4 设置面板）：持久化后带参重载。
   * BatchedMesh 的 maxInstances 在 RenderWorld 构造期固定，运行时无法扩容，
   * 且雾距/相机 far/加载半径全部依赖 viewDistance——重载是最简单且无副作用的路径。
   * @param {number} vd
   */
  applyViewDistance(vd) {
    const url = new URL(location.href);
    url.searchParams.set('vd', String(vd));
    location.assign(url.toString());
  }

  /**
   * 切换画质 blur 档（M3-4 设置面板，§4.4.1）：持久化后带参重载。
   * WebGPU 纹理的 mip level 数在创建期由 generateMipmaps 决定（vendor
   * three.webgpu.js needsMipmaps → options.levels），运行时翻 generateMipmaps
   * 不会重建 mip 链，故走重载（与视距同口径）。
   * @param {boolean} on
   */
  setBlurQuality(on) {
    const url = new URL(location.href);
    if (on) url.searchParams.set('blur', '1');
    else url.searchParams.delete('blur');
    location.assign(url.toString());
  }

  /**
   * 新世界（M3-4）：随机（或指定）seed 写入 meta、丢弃旧世界全部修改、带参重载。
   * 确定性红线 2 不受影响：seed 落库后重启读回同一 seed，地形完全可复现。
   * 丢弃口径：newWorld 是「离开旧世界」，旧 edits 一律不留（`_discardEdits`，含防卸载
   * 写回的竞态三步）。
   * @param {number|null} seed null = 随机
   */
  async newWorld(seed = null) {
    const newSeed = (seed === null || seed === undefined) ? randomSeed() : seed;
    await this._discardEdits();
    await this.persistence.saveMeta({ seed: newSeed, spawn: [8, 8], savedAt: Date.now() });
    const url = new URL(location.href);
    url.searchParams.set('seed', String(newSeed));
    location.assign(url.toString());
  }

  /**
   * 删除缓存（设置面板）：丢弃玩家的全部方块改动，**保留 seed 与设置**。
   * 与 newWorld 的区别：不写新 meta、不带 `?seed=` 参数 → 重载后读回同一 seed，
   * 地形回到该世界的未修改原始版本（确定性红线 2：地形只由 seed 决定，edits 是叠加层）。
   * localStorage 设置（视距/画质/音量/风格/帧预算）完全不动。
   * 与 newWorld 共用 `_discardEdits` —— 两份竞态防护逻辑会漂移（红线 1 精神）。
   */
  async clearSave() {
    await this._discardEdits();
    location.reload();
  }

  /**
   * 丢弃全部玩家改动（内存 edits + IndexedDB edits store）。
   *
   * 三步顺序不可省略：
   * ① `cancelPendingFlush()` 取消在途 5s 防抖写盘；
   * ② 清 `world.columns` 各 column 的**内存** edits；
   * ③ `clearAllEdits()` 清 IndexedDB store 与 `editsCache`（预热源不得残留）。
   *
   * ② 为什么必要（实测口径，勿照推理实现）：`beforeunload → flushNow(world)` 读的是内存
   * edits，不清即存在写回风险。但**风险窗口比直觉窄** —— 实测（对照脚本，只差「reload 前
   * 是否 await flushNow」一个变量）：给卸载事务一点时间（多一次 evaluate 往返）则确实写回
   * （savedColumns 0→1）；紧跟 `location.reload()` 立即卸载则事务来不及提交就被中止、
   * 读回 0。故「不清这步」在生产路径上**不一定**当场暴露，却会在任何来得及提交的时机
   * （标签页关闭较慢、5s 防抖 flush 未被取消、后续任何写盘机会）把旧改动写回刚清空的
   * store → 用户「点了没生效」。这类时序不定的缺陷只能靠内存侧断言钉住
   * （`tests/clear-save.spec.mjs`：E2E 断言抓不住，内存断言能抓住 —— 已做负向验证）。
   *
   * 消费者：`newWorld`（换 seed）/ `clearSave`（保留 seed）。
   */
  async _discardEdits() {
    this.persistence.cancelPendingFlush();
    for (const [, col] of this.world.columns) col.edits.clear(); // 防卸载 flush 写回
    await this.persistence.clearAllEdits();
  }

  /**
   * 内存预算快照（§4.10，M3-1 验收用）：
   * - voxelBytes：所有已加载 column 的 blocks/meta/light 字节和（289 列 ≈ 37MB 基线）；
   * - gpuVertexBytes：3 通道 BatchedMesh 已分配缓冲字节（maxVertexCount×24B 顶点
   *   + maxIndexCount×4B 索引；含扩容兜底后的实际分配，CPU 侧副本同额）；
   * - gpuActiveBytes：slot 预留（reservedV/reservedI）合计 = 实际被几何占用的部分；
   * - jsHeap*：performance.memory（仅 Chromium；其他环境为 null）。
   */
  memoryStats() {
    let voxelBytes = 0;
    for (const [, col] of this.world.columns) {
      voxelBytes += col.blocks.byteLength + col.meta.byteLength + col.light.byteLength;
    }
    let gpuVertexBytes = 0;
    for (const cap of Object.values(this.renderWorld._capacity)) {
      // flat 三属性顶点 = position(3×f32) + uv(2×f32) + packed(u32) = 24B；索引 u32 = 4B
      gpuVertexBytes += cap.maxVertexCount * 24 + cap.maxIndexCount * 4;
    }
    let gpuActiveBytes = 0;
    for (const slot of this.renderWorld.slotMap.values()) {
      gpuActiveBytes += slot.reservedV * 24 + slot.reservedI * 4;
    }
    const mem = performance.memory || null;
    return {
      columns: this.world.columns.size,
      sections: this.renderWorld.slotMap.size,
      voxelBytes,
      gpuVertexBytes,
      gpuActiveBytes,
      jsHeapUsedBytes: mem ? mem.usedJSHeapSize : null,
      jsHeapLimitBytes: mem ? mem.jsHeapSizeLimit : null,
    };
  }
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

  // ---- M4 公开 API（Playwright 与 UI 都走这些方法，委派给同一控制器，不复制玩法逻辑）----

  /** 选择武器（arm/pistol/mag7/minigun）。@returns {Promise<string>} 当前选中 id */
  selectWeapon(id) { return this.player.selectWeapon(id); }

  /** 开一枪（走与键鼠相同路径，仍遵守冷却）。@returns {object[]} 效果事件 */
  fireWeaponOnce() { return this.player.fireWeaponOnce(); }

  /** 设置普通枪是否破坏方块（默认 false；MAG7 不受限）。@returns {boolean} */
  setGunBlockDamage(enabled) { return this.player.setGunBlockDamage(enabled); }

  /** 只读武器调试状态（含曳光池/视图模型/音频请求计数）。 */
  weaponDebugState() { return this.player.weaponDebugState(); }

  dispose() {
    this.renderer.setAnimationLoop(null);
    // M3.1：背包面板在 window 上挂 keydown 监听，不清理会跨实例串扰
    // （fixture 页多次构造 Game 时旧面板仍会响应按键）。生产路径不调 dispose，
    // 此处为完整清理入口的一致性收尾。
    this.inventoryPanel?.dispose();
    // M4：反向释放武器运行时（Player → Audio → ModelLoader → WorkerPool → renderer）
    this.player?.dispose();
    this.audioManager?.dispose();
    this.weaponModelLoader?.dispose();
    this.pool.dispose();
    this.renderer.dispose();
  }
}
