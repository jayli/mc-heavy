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
import { resourceUrl } from './resource-url.js';
import { RenderWorld } from '../render/render-world.js';
import { setupFog } from '../render/materials.js';
import { setupOcean } from '../render/ocean.js';
import { setupSky, placeCelestial } from '../render/sky.js';
import { DayNight, SUN_LIGHT_BASE_HEX, SUN_LIGHT_BASE_RGB } from '../render/daynight.js';
import { ShadowScheduler, SUN_DIR_GATE_DEG, sunDirectionChanged, texelSnapOffset } from '../render/shadow-manager.js';
import { RainEffect } from '../render/rain.js';
import { WeatherState } from '../render/weather.js';
import { WeaponModelLoader } from '../render/weapon-model-loader.js';
import { AudioManager } from '../render/audio-manager.js';
import { ViewWeapon } from '../render/view-weapon.js';
import { ViewArm } from '../render/view-arm.js';
import { WEAPON_IDS } from '../player/weapons/weapon-catalog.js';
import { TracerRenderer } from '../render/tracer-renderer.js';
import { ExplosionRenderer } from '../render/explosion-renderer.js';
import { BlockHitFxRenderer } from '../render/block-hit-fx.js';
import { createAtlasColorResolver } from '../render/block-color.js';
import {
  ExplosionSpriteRenderer, loadExplosionSpriteTexture,
} from '../render/explosion-sprite.js';
import { computeExplosion, EXPLOSION_DAMAGE_RADIUS, EXPLOSION_DAMAGE } from '../voxel/explosion.js';
import { ZOMBIE } from '../entities/zombies/zombie-config.js';
import { WorldEditor } from './world-editor.js';
import { EntityManager } from '../entities/entity-manager.js';
import { probeDefinition } from '../entities/entity-types.js';
import { EntityRenderLayer, createProbeRenderDef } from '../render/entity-render-layer.js';
import { ZombieService, zombieDefinition } from '../entities/zombies/zombie-system.js';
import { ZombieRenderer } from '../render/zombie-renderer.js';
import { loadZombieHeadTexture } from '../render/zombie-head-texture.js';
import { TurretRenderer } from '../render/turret-renderer.js';
import { loadTurretArmorTexture } from '../render/turret-armor-texture.js';
import { loadNestBlueprint } from '../entities/zombie-nests/nest-blueprint.js';
import { ZombieNestService } from '../entities/zombie-nests/zombie-nest-service.js';
import { ZombieNestController } from '../entities/zombie-nests/zombie-nest-controller.js';
import { TurretService } from '../entities/turrets/turret-service.js';
import { TurretController } from '../entities/turrets/turret-controller.js';
import { createTurretBlueprint } from '../entities/turrets/turret-blueprint.js';
import { computeTurretUpdates } from '../entities/turrets/turret-system.js';
import { projectileDefinition, judgeProjectile } from '../entities/turrets/projectile-system.js';
import { PlaygroundService } from '../entities/playground/playground-service.js';
import { ProjectileRenderer } from '../render/projectile-renderer.js';
import { TURRET } from '../entities/turrets/turret-config.js';
import { MinecartService, minecartDefinition } from '../entities/minecarts/minecart-system.js';
import { MINECART_TYPE, MINECART } from '../entities/minecarts/minecart-config.js';
import { MinecartRenderer } from '../render/minecart-renderer.js';
import { loadAtlas } from '../mesh/atlas-loader.js';
import { findSpawnY } from '../gen/terrain.js';
import { getCitySpawnPoint, getCityInfo } from '../gen/structures/city-layout.js';
import { Player } from '../player/player.js';
import { Persistence } from '../save/persistence.js';
import { CoordsHUD } from '../ui/coords-hud.js';
import { Crosshair } from '../ui/crosshair.js';
import { SettingsPanel } from '../ui/settings-panel.js';
import { createHotbar } from '../ui/hotbar.js';
import { InventoryPanel } from '../ui/inventory.js';
import { loadIconManifest } from '../ui/icons.js';
import { getBiome } from '../gen/noise.js';
import { loadStoredSettings, resolveSettings } from '../ui/settings.js';
import { encodeProgress, decodeProgress } from '../save/progress-codec.js';

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
   * @param {boolean} [opts.shadows] 太阳阴影总开关（DR-7，默认 true）。false = 启动即关
   *   （停阴影 pass + uShadowStrength=0）—— `?shadows=0` URL 入口（main.js）与测试隔离都走这里；
   *   运行时切换用 `setShadowsEnabled()`（本选项只在 start() 消费一次）。
   * @param {Object} [opts.settings] 生效设置（main.js resolveSettings 结果；缺省 start() 内自行合并）
   * @param {boolean} [opts.skybox] 天空盒开关（v1.58，默认 true）。false = 完全不加载、退回纯色天空
   *   （`?skybox=0` URL 入口）——既有 Tier 4 spec 用「±30 内等于 0x87ceeb」判纯色天空来数地形
   *   像素，照片天空会让那个判据失去意义，故它们 pin 该开关。
   */
  constructor({ canvas, registry, seed = null, viewDistance = 8, hudRoot, blurMipmap = false, budgetProfile = 'auto', startWeather = null, shadows = true, skybox = true, settings = null }) {
    this._settings = settings;
    this._shadowsOption = shadows;
    this._skyboxOption = skybox;
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
    // Worker 入口地址是站点根绝对路径时，仓库挂子路径部署会 404 → Worker 池全部起不来
    // （v1.87 实测：`/mc-heavy/` 下 8 个 worker 全部 ERR_FAILED）。走 resourceUrl 部署无关解析。
    this.pool = new WorkerPool({ workerUrl: resourceUrl('src/workers/world-worker.js') });
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
    // ACES 色调映射（v1.70）：高光柔和滚落、不再被 sRGB 传递函数削平成白块。
    // 实测整屏高光削顶（luma>=250）**0.44% → 0%**，对比跳度 p95−p5 **163 → 183**。
    // 曝光值（每风格不同）由 DayNight._apply 按风格/日夜写入（唯一收口点）。
    // ⚠️ v1.58 的 spec §7 曾以「用户否决」为由**不移植** ACES —— v1.70 用户重新拍板，
    // 那个否决**已作废**。本仓是 unlit 管线，故不需要 mc-lite 的每风格 CSS 色彩分级。
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
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
    // 丧尸头部马赛克纹理：与 atlas 一并 await（保持 ZombieRenderer 构造器同步 → 首帧不闪纯色）。
    // 加载失败不应阻断启动 —— 头部纹理只是观感，缺了退回纯色头即可（_baseColorOf 的退回路径）。
    this._zombieHeadTexture = await loadZombieHeadTexture().catch((e) => {
      console.warn('[game] 丧尸头部纹理加载失败，退回纯色头：', e);
      return null;
    });
    // M8：炮塔装甲纹理（三区并排）。与 atlas 一并 await（保持 TurretRenderer 构造器同步 →
    // 首帧不闪纯色）。加载失败不阻断启动 —— 装甲只是观感，缺了退回纯色炮塔即可
    // （与丧尸头部、M4 武器模型同一容错口径）。
    this._turretArmorTexture = await loadTurretArmorTexture().catch((e) => {
      console.warn('[game] 炮塔装甲纹理加载失败，退回纯色炮塔：', e);
      return null;
    });
    // 爆炸序列帧图集（500×200，5×2 = 10 帧）。同上口径：加载失败不阻断启动 ——
    // 爆炸特效只是观感，缺了退回「只有球体扩张层」（`explosion-renderer.js`）即可。
    this._explosionSpriteTexture = await loadExplosionSpriteTexture().catch((e) => {
      console.warn('[game] 爆炸序列帧图集加载失败，退回只有球体扩张层：', e);
      return null;
    });
    const atlasMeta = await (await fetch(resourceUrl('assets/atlas.json'))).json();
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
    // 世界视觉零回归。月光与日夜灯光调制不移植（体素日夜走独立 uniform 体系）。
    this.scene.add(new THREE.AmbientLight(0xddeeff, 2.3));
    // 太阳灯（原 weaponSun，DR-3 复用为阴影投射灯，不新建第二盏）：方向/色/强度本就是
    // mc-lite 太阳口径（noon 值），兼作枪 PBR 高光的方向光。阴影相机参数照抄 mc-lite
    // Engine.js:30-34,168-182（DR-4）。光源跟随玩家（mc-lite Game.js:556）由
    // `_updateSunPosition()` 在帧循环驱动（Fix Round 2 提前进 Task 3：阴影相机 ±30 必须
    // 覆盖玩家所在几何，否则阴影系统对可见世界完全无效）；按需刷新（DR-5）由
    // `this.shadowScheduler` 在帧循环 tick 驱动（Fix Round 4 接线）。
    const sunLight = new THREE.DirectionalLight(SUN_LIGHT_BASE_HEX, 3.2);
    // 基准色只有一个权威（`daynight.js` 的 `SUN_LIGHT_BASE_RGB` / `_HEX`，从同一值派生）。
    // 色温由 DayNight._apply 按风格乘算回写（中性风格乘 1 → 逐位等于这个原色）。
    sunLight.color.setRGB(SUN_LIGHT_BASE_RGB[0], SUN_LIGHT_BASE_RGB[1], SUN_LIGHT_BASE_RGB[2]);
    // 初始位置 = 太阳方向（构造期玩家尚未创建；第一帧帧循环的 distSq 检查必 >25
    // → `_updateSunPosition()` 立即把光源定位到玩家处，无需在 start() 额外调一次）。
    sunLight.position.set(0, 0.8, 0.6); // 光源在太阳方向 → 照射方向 = -[0,0.8,0.6]（mc-lite 口径）
    sunLight.castShadow = true;
    // 阴影相机覆盖与贴图分辨率（v1.70）。
    //
    // **为什么扩大**：±30 只覆盖 60 格，而树影、建筑影、地形起伏大多在覆盖区外 → 实测
    // 真实场景里开/关阴影的整屏差异只有 **1.19% 像素**（最大 27/255）—— 影子几乎看不见。
    // 改 ±48（覆盖 96 格）+ 1024² 后，同样的对照升到 **3.21% 像素**（2.7×）。
    //
    // **纹素反而更清晰**：纹素 = 覆盖宽 / 贴图宽 → 60/256 = 0.234 格 → 96/1024 = **0.094 格**
    // （清晰 2.5×）。`_updateSunPosition()` 的 texel snapping 从 `(right−left)/mapSize` 读配置，
    // 故这里改完它自动跟随，**无需同步改任何字面量**（红线 1）。
    //
    // **成本**：renderer.render 提交时间实测 256² → 1024² 的刷新帧 0.2 → **1.3ms**、稳态帧
    // 0.1 → 0.2ms。刷新被 ShadowScheduler 节流到 200ms（5Hz 上限）→ 摊到每帧约 0.05ms，
    // 在 8.3ms 帧预算里可忽略。
    // far=300：光源距玩家 60 格、覆盖对角约 68 格 → 需覆盖到光源另一侧，300 留足余量
    // （阴影相机 ±48 之后 250 已偏紧）。
    sunLight.shadow.mapSize.set(1024, 1024);
    sunLight.shadow.camera.left = -48;
    sunLight.shadow.camera.right = 48;
    sunLight.shadow.camera.top = 48;
    sunLight.shadow.camera.bottom = -48;
    sunLight.shadow.camera.near = 0.1;
    sunLight.shadow.camera.far = 300;
    // 软化参数（radius 默认 1 / blurSamples 默认 8，three.core.js LightShadow）。
    // mc-lite 的 bias 0.00008 / normalBias 0.048 不移植；radius + blurSamples 是 VSM 的
    // 软化参数。
    // ⚠️ **radius 用 mc-lite 原值 2.6，不是 4**：原 4 是「阴影因子乘在最终颜色上」
    // （影区 ×0 纯黑）时代的补偿值 —— 那时需要把阴影糊开才不致于全黑。改成
    // 「只衰减 skylight 项 + 地板 SHADOW_FLOOR」后，radius=4 反而把阴影冲淡到
    // 谷底比值 0.852（地板 0.5 根本达不到）。实测扫描（同一平台/同一相机，只改 radius）：
    //   r=1 → 0.724 / r=2 → 0.724 / **r=2.6 → 0.726** / r=3 → 0.769 / r=4 → 0.852，
    //   半影宽度 r=2.6 与 r=4 同为 4/8 点（边缘不更硬）。
    // ⚠️ **v1.70 贴图 256²→1024² 后 radius 仍保持 2.6（用户拍板）**：VSM 的 radius 是
    // **纹素**单位，纹素从 0.234 变 0.094 格 → 同样的 2.6 只相当于原来的 ~1 纹素，
    // **半影宽度窄 2.5×、影子明显变硬**。这**不是回归而是有意结果**（用户要「真实感」
    // 而非「柔和」，硬一点的影子更像日光）。若将来实玩觉得生硬，处置是**按比例升到 ~6.5**
    // 的单次标定，**不得把覆盖改回去**。
    // 0.726 与 mc-lite 的理论影区亮度 0.71（ambient 2.3 / (2.3 + sun 3.2×NdotL 0.8) = 0.4733
    // 线性 → sRGB 0.71）几乎重合 → radius=2.6 既对齐上游又让地板真正生效。
    sunLight.shadow.radius = 2.6;
    sunLight.shadow.blurSamples = 8;
    // DR-5 按需刷新：autoUpdate=false 关掉每帧重渲，只在 ShadowScheduler.tick() 放行时置
    // `shadow.needsUpdate = true`。⚠️ 这不是可选优化而是硬约束：VSM 下 receiveShadow 对象
    // 也进阴影 pass，每帧重渲会把 render-terrain 的冻结断言 drawCalls<100 从 53 打到 428。
    sunLight.shadow.autoUpdate = false;
    // 刷新节流器（mc-lite `World.requestShadowMapUpdate` 的 200ms 最小间隔同构）。
    // 三个请求源：① editor 订阅（世界编辑）② 帧循环移动阈值（光源重定位）
    // ③ DayNight 的 onSunDirection（日夜方向变化）。
    this.shadowScheduler = new ShadowScheduler();
    // target 必须入场景，否则其 matrixWorld 不更新 → 阴影相机朝向错。
    this.scene.add(sunLight.target);
    this.scene.add(sunLight);
    this.sunLight = sunLight;
    // 光源跟随节流快照（玩家位置；mc-lite Game.js:537 口径：移动超 5 格才重新定位）。
    // 初始 (0,0,0)：出生点距原点必 >5 格 → 第一帧即自动定位。
    this._lastShadowPos = { x: 0, y: 0, z: 0 };
    // v1.47：太阳方向门控快照（onSunDirection 的角度阈值比较用）。初始 null → 首次恒通过
    // （启动即定位）。由 `_updateSunPosition()` 统一维护（两条重定位路径口径一致）。
    this._lastSunDir = null;
    // shadowMap.enabled 是硬门控（three.webgpu.js:43563）：不开则 castShadow 被忽略。
    // type = VSMShadowMap（DR-4b，用户拍板）：r185.1 WebGPU 后端的 depth-compare 阴影路径
    // （PCFSoft/PCF/Basic）有 GPUValidationError bug（ShadowDepthTexture 同 scope 内
    // RenderAttachment 与 TextureBinding 冲突 → CommandBuffer 失效、画面全黑），VSM 走
    // depthTexture.compareFunction = null（three.webgpu.js:45074）绕开 comparison-sampler，
    // 是唯一实测出影的档位。代价见 spec DR-4b（light-bleeding / 多 2 个模糊 pass /
    // receiveShadow 对象也进阴影 pass）。
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.VSMShadowMap;
    // 天空盒（v1.58）**必须先于 setupFog**：v1.59 的「雾色融入天空」要在雾节点里
    // 采样同一份立方图 —— 雾色与背景天空共用一个 uNightBlend，否则会漂移出
    // 「雾是白天色、天是夜幕色」的撕裂。
    // 加载失败不阻断启动（与丧尸头部/炮塔装甲纹理同一容错口径）：退回既有纯色背景。
    // ⚠️ 失败时必须把 `scene.background` 恢复成 Color：setupSky 成功路径会把它置 null
    // （让 DayNight 的纯色路径自动跳过）；半途失败不留这个 null。
    this.sky = null;
    if (this._skyboxOption) {
      try {
        this.sky = await setupSky(this.scene);
      } catch (e) {
        console.warn('[game] 天空盒加载失败，退回纯色天空：', e);
        this.scene.backgroundNode = null;
        this.scene.background = new THREE.Color(0x87ceeb);
      }
    }
    const fogUniforms = setupFog(this.scene, this.viewDistance, this.sky);
    this.fog = fogUniforms; // v1.59：雾色模式开关的 uniform 句柄（setFogColorEnabled）
    this.ocean = setupOcean(this.scene);
    // ⚠️ 灯光创建必须在 RenderWorld 之前：材质的 shadow() 节点在构建时固定 light 引用。
    this.renderWorld = new RenderWorld({ scene: this.scene, atlasTexture: texture, viewDistance: this.viewDistance, sunLight });
    // 日夜循环（M2-6）：正午起步（与 M1 视觉口径一致），1200s 一天
    this.dayNight = new DayNight({
      scene: this.scene,
      fog: fogUniforms,
      voxelUniforms: this.renderWorld.materials.dayNight,
      skyUniforms: this.sky
        ? { uNightBlend: this.sky.uNightBlend, uDuskBlend: this.sky.uDuskBlend }
        : null,
      baseFogNear: this.viewDistance * 16 * 0.75,
      baseFogFar: (this.viewDistance + 2) * 16 * 0.95,
      // ACES 曝光写入目标（v1.70）：DayNight._apply 是唯一收口点（setStyle 与日夜循环共用）。
      renderer: this.renderer,
      // 色温（v1.71）：太阳灯的颜色也由 _apply 按风格重算 —— 它是枪 PBR 高光的源，
      // 不接的话傍晚里枪身高光仍是中性白，与暖橙直射光打架。
      sunLight,
      // 太阳方向变化 → 光源重定位 + 请求阴影刷新（DR-5 第三个请求源）。**用于定位的**方向由
      // `_updateSunPosition()` 从 `dayNight.params.sunDirection` 读（唯一权威，红线 1：
      // 回调里不写字面量方向）。
      // ⚠️ **门控比较用 `dir` 入参，定位仍读 `params`** —— 两者同值（DayNight 传的就是刚 apply
      // 的 `normalizeDirection(p.sunDirection)`），但 `get params()` 会走 `paramsAtHour()` →
      // `lerpParams()` + `normalizeDirection()`，**每次调用新分配 2 个小对象**。初版门控自己读
      // `params` 做比较 → 被门控掉的帧仍每帧分配，白做了一半。入参是 DayNight 已经算好的值，
      // 零额外分配。⚠️ 本门控消除的是「重定位路径上的额外 params 读取」（门控前每帧 2 次：
      // 门控自己 1 次 + `_updateSunPosition()` 1 次 → 门控后约 0.6Hz 各 1 次）；
      // `DayNight._apply` 自身的每帧分配（`paramsAtHour` + 末尾 `normalizeDirection`）不在本门控
      // 范围内，属日夜循环固有成本，本次不动。
      // ⚠️ **必须判 `this.player`**：本构造调用会立即触发一次 `_apply` → 回调，而
      // `this.player` 在 start() 后半段才创建 → 不判空启动即抛 TypeError。
      // ⚠️ **`request()` 必须判 `castShadow`（阴影总开关）**：日夜循环模式下
      // `DayNight.update()` 每帧调 `_apply` → 本回调每帧触发。不门控则「用户已关阴影」
      // 时系统仍每 200ms 重渲一次阴影贴图（VSM 下 receiveShadow 对象也进阴影 pass
      // → drawCalls 53→273）—— 语义上就是错的：关阴影必须是零开销关闭。
      // 实测（200 次采样，口径同 render-terrain:48）：门控前 ≥100 占比 6~8%，门控后 0%。
      // ⚠️ **`_updateSunPosition()` 不门控**：DirectionalLight 对着色只生效「方向」
      // （= position − target），而本方法保持该方向恒等于当前太阳方向 → 枪的 PBR 高光
      // 需它跟随日夜（与阴影开关无关）；它只改阴影相机的居中点，不门控不会产生重渲。
      onSunDirection: (dir) => {
        if (!this.player) return;
        // v1.47 角度阈值门控：日夜循环下太阳每帧只转 0.0025°（256² 贴图上不可见），
        // 门控前每帧重定位 120 次/秒且每帧 `paramsAtHour()` 新分配 2~3 个小对象（GC 压力源）；
        // 门控后约 0.6Hz（SUN_DIR_GATE_DEG=0.5°，太阳 0.3°/秒）。noon 平台段（hour 9~17）
        // 方向恒定 → 该时段零方向驱动刷新。
        // ⚠️ 门控**只加在这条路径**，不得加到帧循环的移动阈值路径（玩家移动必须让阴影
        // 相机跟上，加了会「走 5 格后影子钉在原地」）。
        if (!sunDirectionChanged(this._lastSunDir, dir, SUN_DIR_GATE_DEG)) return;
        this._updateSunPosition();
        this._updateCelestial(); // 日轮/月轮跟看太阳方向（与光源同一节奏，不每帧）
        if (this.sunLight.castShadow) this.shadowScheduler.request();
      },
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
    // 高台地带池面：初始接一次（玩家可能直接出生在地带附近）。
    // 之后由帧循环按移动阈值刷新 —— 照 `_updateSunPosition()` 的同一手法（不每帧调）。
    this._tarnPoolAnchor = null;

    this.scheduler = new Scheduler({
      world: this.world, pool: this.pool, registry: this.registry,
      seed: this.seed, viewDistance: this.viewDistance, perf: this.perf,
      renderWorld: this.renderWorld, budget: this.budget,
      getEdits: (key) => this.persistence.getEditsSync(key),
    });
    this.scheduler._atlasMeta = atlasMeta; // 快速路径主线程 mesh 用（与 broadcast 同一份）
    // M4-0：世界编辑协调器 —— 唯一世界写入入口（remesh/light/event）。
    // 玩家挖放、武器破坏、未来 TNT 全部经此，不持有第二份体素真相。
    // M7：注入 persistence —— `setBlockEntity`（巢穴锚点纯 entity 写）靠它记入 edits 并调度落盘。
    this.editor = new WorldEditor({ world: this.world, scheduler: this.scheduler, persistence: this.persistence });
    // DR-5 按需刷新的第一个请求源：世界编辑（block-changed 唯一入口 → 放/挖/枪械破坏/
    // TNT/炮塔全覆盖）。`request()` 只置挂起标志，真正刷新由帧循环 tick 按 200ms 节流放行。
    // ⚠️ **同样判 `castShadow`**（与 onSunDirection / 移动阈值同一不变式）：本回调曾漏门控，
    // 而消费端当时也未门控 → 关阴影后每次放/挖仍刷阴影（实测 drawCalls 168→402）。
    // 消费端已补**单点权威兜底**（帧循环处），此处门控是纵深防御 + 不变式文档化。
    this.editor.subscribe(() => { if (this.sunLight.castShadow) this.shadowScheduler.request(); });

    // ---- M5：实体运行时装配 ----
    // EntityManager 是动态实体 state 的唯一权威；column 索引/generation 全是派生缓存（红线 1）。
    this.entities = new EntityManager();
    this.entities.registerType('probe', probeDefinition); // M5 fixture 类型（M6 丧尸另注册）
    // 卸载/恢复接线：
    // ① 卸载请求 —— Scheduler 发现 column 超界时调这里，冻结持久实体 + 异步保存，
    //    返回 {ready, commit, cancel} handle。只有 ready 成功后的下一帧才同步 commit。
    this.scheduler.onColumnUnloadRequested((key) => {
      const unload = this.entities.beginColumnUnload(key);
      return {
        ready: this.persistence.saveEntities(unload.snapshots),
        // **顺序：先 ZombieService 回收，再 M5 commit**。
        // `unload.commit()` 内部会调 `entities.despawnColumn(key)` 回收临时实体（含丧尸），
        // 那条路径**绕过 ZombieService** → 渲染 slot 不归还（实例矩阵残留、容量被占满）。
        // 故必须先走 `zombies.despawnColumn()`（它回收实体并归还 slot），再让 commit 收尾
        // （此时丧尸已回收，commit 内的 despawnColumn 返回 0，无害）。
        // 闭包延迟调用：注册时 this.zombies 尚未创建，卸载真正发生时已装配完成。
        // 返回值 = 丧尸回收数 + commit 回收数之和（本次卸载真实回收的实体总量）。
        // `unload.commit()` 只计持久实体 —— 单返回它会让「卸载回收了几只丧尸」不可观测
        // （Scheduler 只 try/catch 不消费该值，故改语义安全，见 scheduler.js:324）。
        commit: () => {
          const zombies = this.zombies?.despawnColumn(key) ?? 0;
          const n = zombies + unload.commit();
          // 矿车：commit 回收了该 column 的持久矿车 → 重建位置索引（清掉已回收车的条目）
          if (this.minecarts) this.minecarts.syncIndex();
          return n;
        },
        cancel: () => unload.cancel(),
      };
    });
    // ② column ready —— 恢复该 column 的持久 snapshot（按 position 过滤，只恢复缺失 id）。
    //    实体运行时不复制方块状态；方块锚定装置仍归 blockEntities。
    this.scheduler.onColumnReady((key, column) => {
      const snapshots = this.persistence.entitiesForColumn(key);
      if (snapshots.length > 0) this.entities.restorePersistent(snapshots);
      // 矿车：恢复持久实体后立即重建位置索引（否则本帧 place() 的 occupied 检查读不到
      // 刚恢复的车 → 同格双重放置；syncIndex 是 O(车数) 全量重建，50 辆规模无感）
      if (this.minecarts && snapshots.length > 0) this.minecarts.syncIndex();
      // M7：为该 column 内的巢穴锚点创建 controller（闭包延迟引用 this.nests，
      // 注册时尚未创建，column 真正 ready 时已装配完成 —— 与上方 this.zombies 同手法）。
      this._createNestControllers(key, column);
      // M8：炮塔锚点同理（同一闭包延迟引用手法 —— 注册回调时 this.turrets 尚未创建）
      this._createTurretControllers(key, column);
    });
    // M7：column 卸载 —— 销毁 controller 但**保留 anchor 与全局索引**。
    // 再次加载后从 blockEntity 恢复，`lastSpawnAt` 不重置（M7 规格 §2）。
    // 与「卸载回收临时实体」相反：巢穴是方块锚定装置，不是临时实体。
    this.scheduler.onColumnWillRemove((key) => {
      this._destroyNestControllers(key);
      // M8：炮塔 controller 同理销毁（保留 anchor 与索引，reload 后从 blockEntity 恢复）
      this._destroyTurretControllers(key);
    });
    // Persistence 的实体 snapshot 来源（save/ 不 import entities/，注入纯函数解耦）
    this.persistence.attachEntities(() => this.entities.serializePersistent());
    // 预热持久 snapshot：loadEntities() 一次读库填充 entitiesCache，供 column ready 同步恢复
    await this.persistence.loadEntities();
    // 受控渲染层：只读 pose 发布（M5 规格 §2）。probe 节点 = 受控 THREE.Group（fixture，
    // 未来丧尸改用实例渲染器）。layer 不回写 state、不调 setBlock、不作命中真相。
    this.entityLayer = new EntityRenderLayer({ scene: this.scene });
    this.entityLayer.register('probe', createProbeRenderDef());

    // ---- M6：丧尸装配 ----
    // ZombieService 是 M6 唯一玩法入口（M6 规格 §2）：state 权威仍在 EntityManager，
    // ZombieService 只管玩法校验/生命/slot 分配/AI 编排，不持有第二份实体集合（红线 1）。
    // ZombieRenderer 是六个固定容量 20 的 InstancedMesh（M6 规格 §3），**不走 EntityRenderLayer**
    // —— layer 是 per-entity Group 语义（20+ 实体时是性能反模式，M6 规格明令禁止每尸 Group）。
    // 两者经 onSpawn/onDespawn 钩子对称接线：slot 单一权威在 service，renderer 只接收。
    // 构造顺序：先 renderer 后 service —— service 的钩子闭包引用 renderer，反序会让闭包
    // 在「已创建但未赋值」的窗口里读到 undefined（运行时不炸只因闭包延迟调用，勿照直觉改回）。
    this.zombieRenderer = new ZombieRenderer({ scene: this.scene, headTexture: this._zombieHeadTexture });
    // M8：炮塔渲染层（8 部件固定容量实例池）。slot 由 renderer 内部**差集驱动**分配
    // （sync(poses) 里新 id 分配、消失 id 归还）—— 不在 TurretService 侧建 slot 池。理由：
    // 炮塔不是 EntityManager 实体（是方块锚定装置），没有 `despawnColumn` 绕过玩法服务的
    // 回收路径，差集驱动即可覆盖全部回收场景（column 卸载 / 失效 / 放置）。M6 的 service 侧
    // slot 池是为高频 spawn/despawn 的丧尸设计的，炮塔低频放置，不需要那套记账。
    this.turretRenderer = new TurretRenderer({
      scene: this.scene, armorTexture: this._turretArmorTexture,
    });
    // M8 Task 6：弹丸是 **M5 临时实体**（roadmap 指定接入点：EntityManager + 实体 raycast），
    // 不是渲染节点 —— 命中真相由实体逻辑 AABB 给出，渲染层只发布 pose。
    this.entities.registerType('projectile', projectileDefinition);
    this.projectileRenderer = new ProjectileRenderer({ scene: this.scene });
    /** 弹丸 id 序号（确定性派生 —— 红线 2：不用 Math.random） */
    this._projectileSeq = 0;
    this.zombies = new ZombieService({
      entities: this.entities, world: this.world,
      // M6 AI：经既有 WorkerPool 的统一 `ai` RPC（不新建 Worker，红线 3 / M5 规格 §3）
      pool: this.pool,
      onSpawn: (id, slot) => this.zombieRenderer.acquireSlot(id, slot),
      onDespawn: (id) => this.zombieRenderer.releaseSlot(id),
    });
    this.entities.registerType('zombie', zombieDefinition);

    // ---- 矿车装配 ----
    // 矿车是 M5 持久实体（设计文档 §2.2）：白拿 entities store 写盘 / column 两阶段卸载 /
    // `_discardEdits` 清档。service 装配位置无 `_waitForColumn` 时序约束（矿车没有
    // onColumnReady 回调依赖 —— 恢复走既有的 `restorePersistent`），但为与 M6~M8 的
    // 装配段保持一致仍放在此处。
    this.minecarts = new MinecartService({
      entities: this.entities, world: this.world, registry: this.registry,
      persistence: this.persistence,
    });
    this.entities.registerType(MINECART_TYPE, minecartDefinition);
    // 恢复已加载 column 的矿车后校准位置索引（column ready 的 restorePersistent 先于
    // service 首帧 syncIndex；此处立即建一次，避免放置预检读到空索引的窗口）
    this.minecarts.syncIndex();
    // 渲染层：2 个 InstancedMesh（车斗 + 4 轮），零实例时 visible=false
    this.minecartRenderer = new MinecartRenderer({ scene: this.scene });

    // ---- M7：丧尸巢穴装配 ----
    // **装配位置必须在 `_waitForColumn`（出生点 column 加载）之前** —— 实测踩坑：
    // 放在武器运行时装配段（晚于 `_waitForColumn`）时，出生点 column 的 `onColumnReady`
    // 回调先跑，此刻 `this.nests` 还是 null → `_createNestControllers` 第一行直接 return →
    // reload 后 anchor 与索引都恢复了（`count=1`、column.blockEntities 里有锚点），
    // 但 controller 恒为 0（巢穴不刷怪）。对比 `this.zombies`：它装配在 `_waitForColumn`
    // 之前，故同样的 column ready 路径正常工作 —— 顺序差异是唯一原因。
    //
    // 蓝图加载失败不得中止 worldReady（与 M4 武器模型同一容错口径）：退化为 blueprint=null，
    // place() 一律返回 'invalid-blueprint' —— 玩家保持可玩，只是放不了巢穴。
    let nestBlueprint = null;
    try {
      nestBlueprint = await loadNestBlueprint(this.registry);
    } catch (err) {
      console.warn('[zombie-nest] blueprint load failed:', err);
    }
    this.nests = new ZombieNestService({
      world: this.world, editor: this.editor, registry: this.registry, blueprint: nestBlueprint,
      // 放置成功 → 立刻创建 controller。**没有这条接线则新巢穴永不刷怪**：anchor column
      // 此刻已加载，`onColumnReady` 早在放置前就触发过了，不会再为这个新锚点触发一次。
      onPlaced: (id) => this._createNestController(id),
    });
    // hydrate 必须在开放放置前：建立只含 id/anchor 的派生全局索引，使「全局最多 8 个」
    // 跨 column 卸载与重启仍有效（M7 规格 §2）。索引来源是 edits store，不是已加载 column
    // （`listBlockEntities` 走 cursor 扫库，不依赖 `preloadEdits` 预热，故此处可调）。
    await this.nests.hydrate(this.persistence);

    // ---- M8：炮塔装配 ----
    // ⚠️ **装配位置必须在 `_waitForColumn` 之前**（CLAUDE.md 活跃约束）：出生点 column 在
    // `_waitForColumn` 时 ready、`onColumnReady` 随之触发。若创建在其后，回调跑时 `this.turrets`
    // 还是 null → `_createTurretControllers` 第一行直接 return → reload 后 anchor 与索引都恢复了
    // 但 controller 恒为 0（炮塔不工作）。对照 `this.zombies` / `this.nests`：都装配在之前。
    this.turrets = new TurretService({
      world: this.world, editor: this.editor, registry: this.registry,
      blueprint: createTurretBlueprint(this.registry),   // 代码生成，无 fetch → 不会失败
      // 放置成功 → 立刻创建 controller。**没有这条接线则新炮塔永不工作**（M7 同坑）
      onPlaced: (id) => this._createTurretController(id),
    });
    // hydrate 必须在开放放置前。⚠️ hydrate 是 clear()+重建 → 调用前必须先 flushNow()，
    // 否则库里没锚点 → 索引被清成 0（真实重启路径本就是 flush → reload → hydrate）。
    await this.persistence.flushNow(this.world);
    await this.turrets.hydrate(this.persistence);

    // ---- M9：创造台装配 ----
    // 复用 M7 装置模式的**持久层半边**（blockEntity 锚点 + listBlockEntities 扫库恢复），
    // 但**不复用 controller / 增量失效那半边** —— 创造台无运行时行为（不刷怪、不射击），
    // 它的锚点只是「平台在哪、多大」的持久真相，关闭时由 origin+size 确定性重算枚举（红线 1：
    // 不维护 mc-lite 的 playgroundBlocks 方块集合副本）。
    this.playground = new PlaygroundService({
      world: this.world, editor: this.editor, registry: this.registry,
    });
    // ⚠️ **启动期 hydrate 不需要 flushNow**（审查低12）—— M7 的 nests.hydrate 同口径
    // （listBlockEntities 走 cursor 扫库，不依赖预热）。flushNow 是测试侧 reload 前调用的，
    // 见 playground.spec.mjs 的 reload 用例。上面的 flushNow 是为 turrets.hydrate 而调，
    // 顺带也让 playground 的锚点落了库，故此处直接 hydrate 即可。
    await this.playground.hydrate(this.persistence);

    /** 索敌 accumulator（8Hz 节流；`_updateTurretControllers` 消费） */
    this._turretAiAccum = 0;
    /** 帧循环复用的 pose Map（避免每帧 `new Map()` —— 见帧循环注释） */
    this._turretPoses = new Map();

    // 失效事件订阅：**全局只订阅一次**，再把同一个 event 分派给全部 controller。
    // 不为每个 controller 单独 subscribe —— N 个巢穴就有 N 份监听器，且销毁 controller 时
    // 必须逐个退订，漏一个就是常驻泄漏。分派路径下 controller 增删与订阅生命周期无关。
    this.editor.subscribe((event) => {
      for (const controller of this.nests.controllers().values()) controller.onWorldChange(event);
      for (const controller of this.turrets.controllers().values()) controller.onWorldChange(event);
    });

    // ---- M8：TNT 爆炸装配 ----
    /** TNT 是否破坏地形（mc-lite `Game.js:92` 代码事实为 false：默认只伤害 + 连锁、不动地形）。
     *  ⚠️ **不宣称「实测过默认开关下的爆炸行为」** —— mc-lite 的 TNT 运行时目前是坏的
     *  （`PlayerInteraction.js:620/686` 引用未声明的 `worldAccess` → ReferenceError），
     *  故本仓库的 TNT 对齐口径是「读源码 + 推断意图」，验收报告须如实记录。 */
    this.canTntDestroyBlocks = false;
    /**
     * 引爆去重集合（**单一权威在此**，不在 player 侧）。三条引爆路径（左键 / 枪击 / 连锁到期）
     * 共用它 —— 防止连锁回环把同一格引爆两次（A↔B 相距 ≤2 的 TNT 会永久互爆）。
     * @type {Set<string>}
     */
    this._ignitingTnt = new Set();
    /** 连锁引爆队列：Array<{x,y,z,dueAt}>，dueAt 是 `performance.now()` 基准（禁止 Date.now()） */
    this._tntChain = [];
    /** 爆炸计数（只读测试钩子） */
    this._tntExploded = 0;
    /** 爆炸球体特效池（独立 InstancedMesh；无活跃实例时 visible=false） */
    this.explosionRenderer = new ExplosionRenderer({ scene: this.scene });
    /**
     * 爆炸序列帧 billboard 池（mc-lite `ParticleSystem.spawnExplosionEffect` 层）。
     * 与球体扩张层**同时触发** —— mc-lite `World.js:1296 spawnExplosionParticles` 就是
     * 两层叠加（billboard 为主、球体「作为底层增强」）。空闲 slot `visible=false`
     * → draw call 基线不变（`three.webgpu.js:62263` 首行 early return）。
     */
    this.explosionSprite = new ExplosionSpriteRenderer({
      scene: this.scene, texture: this._explosionSpriteTexture,
    });

    /**
     * v1.64：枪击方块命中的特效（白闪 / 碎块）。
     *
     * 与 mc-lite 的 `pick.png` / `block_crash.png` 通用序列帧**刻意不同**：碎块颜色取自
     * **该方块命中那一面**的真实 atlas 像素（``block-color.js``）—— 打石头出灰、
     * 打草出绿，不需要任何新美术资源，也没有离线烘焙产物要维护。
     *
     * v1.67 按实玩反馈收敛：去掉球形闪光与面闪灭（改成品白闪：命中格整格变白后消失），
     * 并去掉 MAG7 的碎块散落与冲击波环。
     *
     * 容错：`colorResolver` 构造失败（取不到 atlas 像素）时退化成中性灰，不阻断启动。
     */
    let blockColorResolver = null;
    try {
      blockColorResolver = createAtlasColorResolver({
        texture: this._atlasTexture, atlasMeta: await (await fetch(resourceUrl('assets/atlas.json'))).json(),
      });
    } catch (e) {
      console.warn('[game] 命中特效取色失败，退回中性灰：', e);
    }
    this.blockHitFx = new BlockHitFxRenderer({
      scene: this.scene,
      colorResolver: blockColorResolver,
      // 方块名来自 registry —— 「块 id → 名字」的唯一权威（红线 1）
      blockNameOf: (id) => this.registry.nameOf(id),
    });

    // 出生点（mc-lite 语义：优先 City 中心出生，保证出生即见城市天际线，§7 M2 验收）
    const regionLayout = await this.scheduler.structureIndex.waitForRegion(0, 0);
    // 水面遮罩的城市门控 bounds（城市全世界唯一，固定 region [0,0]）。
    // 城市把地面压平到接近海平面 → 若不关掉水面平面，玩家在城市里下挖 2 格就会
    // 挖出一汪假水（洞底顶面降到 -2，低于水面平面 -1.5）。判据见 render/ocean-mask.js。
    this.ocean.setCityBounds(regionLayout.city);
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
    // 首次阴影渲染：autoUpdate=false 下 map 是空的，不置 needsUpdate 则第一帧无影
    // （后续刷新由 shadowScheduler 按需放行）。
    this.sunLight.shadow.needsUpdate = true;
    this.spawnY = findSpawnY(this.world, this.spawnX, this.spawnZ);
    // M4：武器渲染/音频运行时（只在主线程；不进 Worker/体素 meshing 管线）。
    // 模型加载失败只记录 console，不中止 worldReady——玩家保持徒手可玩。
    this.weaponModelLoader = new WeaponModelLoader();
    // v1.63：背景音乐开关来自生效设置。`this.settings` 的赋值在 start() 尾部（:646），
    // 此处读不到 —— 故照既有手法直接解析一次（Game 构造参数里的 settings 优先）。
    this.audioManager = new AudioManager(this.camera, {
      bgmEnabled: (this._settings
        || resolveSettings(loadStoredSettings(), new URLSearchParams(location.search))).bgm,
    });
    this.audioManager.preload().catch((err) => console.warn('[audio] preload failed:', err));
    this.viewWeapon = new ViewWeapon({ camera: this.camera, modelLoader: this.weaponModelLoader });
    // 第一人称手臂（徒手可见 + 挖/放挥动）：与 viewWeapon 互斥，同一时刻只显其一。
    // 挂 camera 下 = 只增 1 个 draw call（一个 Mesh）。徒手是默认武器（controller 初值 arm），
    // 故这里就置为可见（对齐 mc-lite：进入游戏即能看到手臂）。
    this.viewArm = new ViewArm({ camera: this.camera });
    this.viewArm.setWeapon(WEAPON_IDS.ARM);
    this.tracerRenderer = new TracerRenderer({ scene: this.scene });
    // 玩家出生（第一人称，眼高由 Player 管）
    this.player = new Player({
      world: this.world, camera: this.camera, scheduler: this.scheduler,
      registry: this.registry, canvas: this.renderer.domElement,
      editor: this.editor,
      weaponRuntime: {
        viewWeapon: this.viewWeapon,
        viewArm: this.viewArm,
        tracerRenderer: this.tracerRenderer,
        audioManager: this.audioManager,
        blockHitFx: this.blockHitFx,
      },
      // M3.1 模态守卫（§4.5.4）：面板打开时 Player 的 keydown 全部拦截。
      // 谓词注入而非传 Game 本身，保持 player/ 不反向依赖 core/（依赖方向 §3）
      isModal: () => this.uiModal,
      // M6：X 键生成丧尸（调试键，对齐 mc-lite）。注入回调而非传 Game（依赖方向 §3，与 isModal 同手法）
      onSpawnZombie: () => this.spawnZombieNearPlayer(),
      // M7：巢穴服务注入。同样注入而非传 Game —— `src/entities/**` 是同构层，
      // Player 不得反向依赖它（依赖方向 §3，与 isModal / onSpawnZombie 同手法）
      nests: this.nests,
      // M8：炮塔服务注入（同手法）。`CREATIVE_SPECIALS` 已含 `turret_alias_block`，
      // 背包选中它右键时 `placeBlock()` 会分流到 `_placeSpecial()` 的这个分支。
      turrets: this.turrets,
      // 矿车服务注入（同手法）。`CREATIVE_SPECIALS` 已含 `mine_cart`，背包选中它右键时
      // `placeBlock()` 会分流到 `_placeSpecial()` 的矿车分支（origin = prevPos，单格实体）。
      minecarts: this.minecarts,
      // M8：TNT 引爆路由。**透传返回值** —— player 的 `igniteTnt()` 据此告诉调用方是否
      // 真的引爆了（false = 去重命中）。左键挖块与枪击命中两条路径都经此函数落到
      // `explodeTnt()`（去重集合的单一权威在本类，见其注释）。
      onIgniteTnt: (x, y, z) => this.explodeTnt(x, y, z),
    });
    this.player.spawn(this.spawnX, this.spawnY, this.spawnZ);
    this.scene.add(this.player.highlight);

    // M6：把实体查询注入**同一个** M4 controller（M6 规格 §2）。只注入两个函数 ——
    // ① `EntityManager.raycast()`：实体命中唯一入口（红线 6 禁止 Raycaster，地形仍走 DDA）；
    // ② `ZombieService.damage()`：立即改权威 state + 置 flashedUntil。
    // controller 不持有任何实体集合、不 import entities/render（依赖方向 §3）。
    // 必须在 Player 构造之后调 —— weaponController 由 Player 构造期创建。
    this.player.weaponController.setEntityQuery({
      raycast: (origin, dir, maxDist, predicate) =>
        this.entities.raycast(origin, dir, maxDist, predicate),
      damage: (id, amount, nowMs) => this.zombies.damage(id, amount, nowMs),
    });

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
    // 准心配色自适应（v1.64）：按准心背后画面亮度在白色/黑色间切 —— 固定白在雪地/白墙上消失。
    // 挂在 `_hudRoot` 下（与其他 HUD 同层），但**独立于 HUD 的显示/隐藏**：它是准心不是 HUD。
    this.crosshair = new Crosshair(document.body, this);
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
    // 启动应用枪械破坏开关（M4：默认 false 已是 weaponController 初值，仅 true 时需调）
    if (this.settings.gunBlockDamage) this.setGunBlockDamage(true);
    // 启动应用 TNT 破坏开关（M8：默认 false 已是 `canTntDestroyBlocks` 初值，仅 true 时需调）
    if (this.settings.tntDamage) this.setTntBlockDamage(true);
    // 启动应用阴影开关（DR-7；默认开，仅关时需调）。**必须在 sunLight 与 dayNight 都就绪后**
    // —— `setShadowsEnabled` 同时写三处：renderWorld 材质的 uShadowStrength、sunLight.castShadow、
    // dayNight.shadowEnabled；本行已是 start() 尾部（三者早已创建）。
    // ⚠️ 此处默认开（不无条件调用）：`setShadowsEnabled(true)` 会置 `needsUpdate = true`，
    // 而「默认开」路径的重渲早已由 start() 中段的首次 needsUpdate 覆盖。
    if (!this._shadowsOption) this.setShadowsEnabled(false);
    // 启动应用雾色模式（默认**开**，用户 2026-10-25 裁定）。
    // ⚠️ 必须在 sky 就绪之后（此处已是 start() 尾部）；`?skybox=0` 时 sky 为 null → 静默保持关。
    // 两条都要显式走：材质初值 `uFogColorMix` 恒 0（= 关闭，`materials.js` 的 mix 左端），
    // 所以「关」也不是空操作 —— 落到这里才把 uniform 写成 0，与设置面板点击同一路径。
    this.setFogColorEnabled(this.settings.fogColor);
    this.worldReady = true;

    window.addEventListener('resize', () => this._onResize());
    this._onResize();
    // 存档 flush：页面隐藏/退出立即写盘（§4.8）。M5 起实体 snapshot 同步 flush。
    window.addEventListener('visibilitychange', () => {
      if (document.hidden) { this.persistence.flushNow(this.world); this.persistence.flushEntities(); }
    });
    window.addEventListener('beforeunload', () => { this.persistence.flushNow(this.world); this.persistence.flushEntities(); });

    this.renderer.setAnimationLoop((nowMs) => {
      this.perf.tick(nowMs);
      // dt（秒）：首帧为 0，钳制上限 0.1s 防后台切回大步长
      const dt = this._lastFrameMs < 0 ? 0 : Math.min((nowMs - this._lastFrameMs) / 1000, 0.1);
      // M3-2：预算判档喂原始（未钳制）帧间隔——vsync 量化值正是测量对象
      if (this._lastFrameMs >= 0) this.budget.observeFrame(nowMs - this._lastFrameMs);
      this._lastFrameMs = nowMs;
      // 设置面板打开时跳过玩家输入/物理（世界调度继续：后台填充不受 UI 阻塞）
      if (!this.uiModal) this.player.update(dt);
      // 模态期 `player.update` 被跳过而下面 `entities.update` 照跑 → 矿车继续移动
      // （乘坐基线 `_lastRidePos` 会冻结）。每帧把乘坐基线刷成车位：解除模态那帧的跟随
      // 增量退化为**至多一帧车位移**（实测 0.0164 格 ≈ 2.0/120），而非全部累积位移
      // （实测 6.02 格）；车已走远时由 `_updateMinecartRiding` 既有的偏离检查自然下车。
      // ⚠️ **不要**改成模态期调 `_updateMinecartRiding` —— 那会让面板开着时也执行
      // 空格下车/自动重绑/相机同步，爆炸半径更大。
      else this.player.syncRideBaseline();
      // M5 帧序固定：player.update → entities.update → scheduler.update → entityLayer.sync → render
      // （M5 规格 §2）。entities.update 在 scheduler 之前：实体先推进位置，scheduler 再用最新
      // position 判定卸载/恢复，避免实体跨 column 后被旧索引漏回收。
      //
      // M6 在此帧序里插入两步（M6 规格 §2）：
      // ① `zombies.update(dt)` 在 `entities.update` **之前** —— AI 编排先把追逐意图写进
      //    state.velocity，物理才能用本帧的意图推进。反序会让丧尸用上帧（或零）意图走一步。
      // ② 丧尸物理在 `zombieDefinition.update` 里，由下面这行 `entities.update` 驱动
      //    （60Hz 固定步长 accumulator 在 definition 内），**不在 ZombieService 里跑物理** ——
      //    两处物理会让丧尸推进两遍（速度翻倍），是同一事实的两个副本（红线 1）。
      const pp = this.player.physics.pos;
      // 矿车帧序：beginFrame 清瞬态（reservations/deferred/抬玩家意图）—— 必须在
      // entities.update 之前（mc-lite 的 frameReservations 同生命周期）
      this.minecarts.beginFrame();
      this.zombies.update(dt, { playerPosition: [pp.x, pp.y, pp.z] });
      // 矿车 context：minecarts = service（跨车协调），player = 玩家位置（抬起判定）。
      // ⚠️ player 传**位置快照**而非 Player 对象 —— entities/ 是同构层，不得依赖 player/
      // ⚠️ **形状必须是 `{position:[x,y,z]}` 对象，不是裸数组** —— `resolvePlayerBlocking`
      // 读 `player.position`（mc-lite `checkPlayerCollision` 的入参形状）。传裸数组会让它
      // 解构 undefined → 每帧抛 TypeError → 帧循环中断 → **车永远停在起点**（实测：
      // idle 车在步骤①早退不读 player，故只有车真移动时才暴露；单测传对象/null 全绿）。
      // ⚠️ **复用上一行已有的 `pp`** —— 重复 `const pp` 会是 SyntaxError（同一块作用域）。
      this.entities.update(dt, {
        world: this.world, registry: this.registry,
        minecarts: this.minecarts, player: { position: [pp.x, pp.y, pp.z] },
      });
      // 跨车写入统一生效 + 位置索引同步（设计文档 §3.4：必须在 entities.update 之后）
      this.minecarts.applyDeferred();
      this.minecarts.syncIndex();
      // 抬玩家：矿车把玩家顶到车顶（mc-lite checkPlayerCollision 的落地动作）
      if (this.minecarts.pendingPlayerLift !== null) {
        this.player.physics.pos.y = this.minecarts.pendingPlayerLift;
        this.player.physics.vel.y = 0;
      }
      // M8 Task 6：弹丸判定（**只判定 + despawn，不再推进** —— 见 _updateProjectiles 的 ⚠️）
      this._updateProjectiles(nowMs, dt);
      // M7：巢穴刷怪推进。放在 entities.update **之后** —— 刷怪经 ZombieService.spawn()
      // 创建实体，须等实体运行时本帧推进完成再创建，避免新实体在创建当帧被 update 漏处理。
      // 内部 8 秒节流（controller.update 自己判 nowMs-lastSpawnAt），故每帧调用是零成本的。
      this._updateNestControllers(nowMs);
      // M8：炮塔推进（朝向插值 / 开火）。放在 entities.update **之后** —— 开火会创建弹丸
      // 实体（Task 6），须等实体运行时本帧推进完成再创建，避免新实体在创建当帧被 update
      // 漏处理（与巢穴刷怪同一理由）。内部 8Hz 节流，故每帧调用是零成本的。
      this._updateTurretControllers(nowMs, dt);
      // M8：连锁引爆推进。放在巢穴之后、scheduler 之前 —— 爆炸写世界经 editor，
      // scheduler 本帧才能把受影响 column 送进 REMESH/light 队列。
      this._updateTntChain(nowMs);
      // 光源跟随（mc-lite Game.js:537 口径）：玩家移动超 5 格（distSq > 25）才重新定位
      // 光源/target —— 阴影相机 ±30 覆盖 60 格直径，5 格滞后内几何仍全覆盖，省掉每帧
      // target.updateMatrixWorld 的开销。重定位后必须 request()：autoUpdate=false 下
      // 阴影相机换了位置但不刷新，map 里仍是旧位置的深度（影子会钉在原地）。
      // ⚠️ 本块**不是唯一的重定位路径**：`onSunDirection` 回调（日夜方向变化时，构造处
      // :238）同样调 `_updateSunPosition()`。两条路径幂等（同读 `dayNight.params.sunDirection`
      // + 当场玩家位置 → 同结果）；但回调路径不刷 `_lastShadowPos`，故方向变化帧的阈值检查
      // 会基于旧快照多触发一次重定位 —— 幂等，且 request() 被 200ms 节流吸收
      // （重复请求只置同一个 `_pending`，量的是「有没有请求」而非请求次数）。
      // ⚠️ request() 同样判 castShadow（与 onSunDirection 同一不变式：阴影关闭时
      // 不产生任何刷新请求）；`_updateSunPosition()` 不门控（理由见构造处注释）。
      {
        const dx = pp.x - this._lastShadowPos.x;
        const dy = pp.y - this._lastShadowPos.y;
        const dz = pp.z - this._lastShadowPos.z;
        if (dx * dx + dy * dy + dz * dz > 25) {
          this._updateSunPosition();
          this._updateCelestial();
          if (this.sunLight.castShadow) this.shadowScheduler.request();
          this._lastShadowPos = { x: pp.x, y: pp.y, z: pp.z };
        }
      }
      this.scheduler.update(this.player.physics.pos.x, this.player.physics.pos.z);
      // ⚠️ v1.89：高台地带的中央水池已整体删除（用户 2026-10-27 裁定），
      // 池面 uniform 刷新与 `setTarnPool` 接线一并移除 —— 地带不再向 transparent 通道
      // 贡献任何东西，也不再需要每帧/每 5 格算一次 `tarnPoolAt()`。
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
      // M5 帧序最后一步：把实体 pose 发布成 scene 节点（scheduler 可能已卸载/恢复实体，
      // 用最新集合 sync，节点数恒等于实体数 —— 生命周期对称）
      this.entityLayer.sync(this.entities.entities());
      // M8 Task 6：弹丸 pose 发布（差集驱动 slot —— 三条回收路径自动覆盖）
      this.projectileRenderer.sync(this.entities.entities());
      // M6：丧尸六部件实例发布（只读 pose → 位置/朝向 + 步态 + 200ms 红闪）。
      // 传时间戳而非 dt —— renderer 自己算 dt 累积步态相位（mc-lite `_walkTime` 口径）。
      this.zombieRenderer.sync(this.zombies, nowMs);
      // 矿车 pose 发布（差集驱动 slot；只读 state）
      this.minecartRenderer.sync(this.entities.entities());
      // M8：炮塔 pose 发布（pivot 世界坐标 + Task 4 插值出的当前 yaw/pitch）。
      // ⚠️ **复用模块级 Map**（`clear()` + 重填）而不是每帧 `new Map()` —— 每帧新建是分配
      // （20 炮塔 × 60fps = 每秒 1200 个 Map 对象 + 2400 个 pose 对象）。
      this._turretPoses.clear();
      for (const [id, controller] of this.turrets.controllers()) {
        this._turretPoses.set(id, {
          position: controller.pivot(),
          yaw: controller.currentRotation,
          pitch: controller.currentPitch,
        });
      }
      this.turretRenderer.sync(this._turretPoses);
      // M8：爆炸球体扩张推进（0.3s 寿命；全部结束后 visible=false → draw call 回基线）
      this.explosionRenderer.update(nowMs);
      // 爆炸序列帧 billboard 推进（0.5s 寿命；到期 slot visible=false → draw call 回基线）
      this.explosionSprite.update(nowMs);
      // 枪击方块命中特效推进（碎块抛物线/自旋、白闪的保持与淡出）
      this.blockHitFx.update(nowMs);
      // DR-5 按需刷新：节流放行时才置 needsUpdate（必须在 render 之前 —— ShadowNode 的
      // updateBefore 在本帧渲染前读它）。tick 内部已消费 pending 并记录时刻。
      // ⚠️ **`tick()` 必须在前、`castShadow` 在后**，两侧顺序是**载荷性的，勿交换**：
      //   · `tick()` 在前：关阴影期间 pending 仍被正常消费（不残留）—— sun-shadow.spec 用例 6 的
      //     观测口径就是「窗口内采样 `_pending` 恒 false」，残留 true 会使它确定性 FAIL（实测）。
      //   · `castShadow` 在后：关阴影时不置 needsUpdate（**零开销**）。
      // 这是「关阴影 = 零开销」的**单点权威兜底**（Ruling (i) 补全）。三个请求源
      // （editor.subscribe / 帧循环移动阈值 / onSunDirection）各自的门控是纵深防御，但漏一个就复发
      // —— 且实测确实漏过：editor.subscribe（:274）与本消费端曾**双双无门控** → 关阴影后每次
      // 放/挖仍触发阴影 pass（vd=4 实测 drawCalls 168→402，每轮 +3 render = renderShadow + 2×vsmPass）。
      // 门控放在**成本真正发生的那一点**（置 needsUpdate），对现有与未来所有请求源一次生效。
      // 交换写法的实测后果：`castShadow && tick()` → tick 被短路完全不跑 → `_pending` 永久残留 →
      // 用例 6 观测到 46/46、47/47 次 pending（5/5 FAIL）。
      if (this.shadowScheduler.tick(nowMs) && this.sunLight.castShadow) {
        this.sunLight.shadow.needsUpdate = true;
      }
      this.renderer.render(this.scene, this.camera);
      // 准心配色（v1.64）：**必须在 render 之后** —— WebGPU canvas 在 render 前不可读
      // （实测读到恒为 0，会让准心永远判为暗背景而恒白）。内部 100ms 节流 + 迟滞。
      this.crosshair.update(nowMs);
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

  /**
   * 光源跟随玩家（mc-lite Game.js:556-558 口径）：光源放在「玩家位置 + 太阳方向 × 60」，
   * target 指向玩家 → 阴影相机（±30）始终覆盖玩家周围可见几何。
   * ⚠️ 太阳方向从 `dayNight.params.sunDirection` 取（唯一权威，日夜风格/循环切换自动跟随；
   * 红线 1：不得在此写字面量方向）。偏移 60 = mc-lite Game.js:558 原值。
   *
   * v1.47 纹素对齐（texel snapping，有意偏离 mc-lite —— 它无连续日夜循环且无此机制）：
   * 阴影相机 ±30 / 贴图 256² → 每纹素 ≈ 0.234 格；相机连续跟随玩家时世界相对纹素网格
   * 错位分数纹素 → 影子边缘随移动抖动（用户实玩可察觉）。把相机中心吸附到纹素边界后
   * 网格只按整纹素步进 → 影子稳定。texelSize 从实际配置读（红线 1：不写字面量）。
   * ⚠️ **载荷性**：偏移必须**同时**加到 position 与 target —— 两者之差平行于相机 Z 轴，
   * 加同一向量方向严格不变；只加一个会改「position − target」→ 枪 PBR 高光漂移。
   * 故本方法不受 `castShadow` 门控（关阴影时枪的高光仍须跟随日夜，见构造处注释）。
   */
  _updateSunPosition() {
    if (!this.player) return; // 防御：帧循环里 player 必然已建，判空成本为零
    const p = this.player.physics.pos;
    const dir = this.dayNight.params.sunDirection; // 已归一化（DayNight.get params）
    this._lastSunDir = dir; // 两条重定位路径统一维护门控快照（口径一致）
    const cam = this.sunLight.shadow.camera;
    const texelSize = (cam.right - cam.left) / this.sunLight.shadow.mapSize.width;
    const off = texelSnapOffset([p.x, p.y, p.z], dir, texelSize);
    this.sunLight.position.set(p.x + off[0] + dir[0] * 60, p.y + off[1] + dir[1] * 60, p.z + off[2] + dir[2] * 60);
    this.sunLight.target.position.set(p.x + off[0], p.y + off[1], p.z + off[2]);
  }

  /**
   * 日轮/月轮跟随（v1.58）。位置跟随相机（而非玩家）—— sprite 在相机附近漂浮，
   * 相机因 StepLift/视角晃动产生的微小位移用玩家位置跟不上，会看到 sprite 相对视野漂移。
   *
   * ⚠️ **不得每帧调**：调用点是 `_updateSunPosition()` 的两个触发点（移动超 5 格 /
   * 太阳方向过 0.5° 门控）。每帧调等于白付两次 `dayNight.params`（它每次新分配 2 个小对象）
   * ——与 SUN_DIR_GATE_DEG 门控要消除的就是同一笔派开销。
   *
   * ⚠️ 可见性来自 `dayNight.params.moonVisible`（风格数据）：三套风格里**太阳全是 false**
   * —— `skyBox4` 贴图本身烘焙了太阳光晕，再画一个会变成两个太阳（mc-lite 同口径，
   * 它的 sunVisible 也全是 false）。改一个字段就能打开。
   */
  _updateCelestial() {
    if (!this.sky || !this.player) return; // ?skybox=0 / 加载失败 → 无 sprite 可跟
    const p = this.dayNight.params;
    placeCelestial(this.sky.sunSprite, this.camera, p.sunDirection, 28);
    placeCelestial(this.sky.moonSprite, this.camera, p.moonDirection, p.moonSize);
    this.sky.sunSprite.visible = p.sunVisible === true;
    this.sky.moonSprite.visible = p.moonVisible === true;
  }

  /**
   * 阴影总开关（代码级开关，DR-7：**不进设置面板**，默认开）。
   * 两个入口：① 构造选项 `shadows`（`?shadows=0` URL 参数，main.js 解析后传入）② 本方法。
   * 消费方是 E2E / 视觉测试的隔离（关阴影消掉 drawCalls 尖峰，量 drawCalls 的 spec 须先关）。
   * 三步缺一不可：① castShadow 门控投射；② uShadowStrength 置 0 —— 只改 castShadow 时
   * shadow() 节点仍在 node graph 里（VSM 下 receiveShadow 对象也进阴影 pass），材质侧须
   * 同步归零；③ needsUpdate 强制下一次阴影 pass 重渲（否则 map 里仍是旧影）。
   * ⚠️ 同时设 `dayNight.shadowEnabled` 标志：DayNight._apply 每次日夜推进都写
   * uShadowStrength，不遵守标志的话「关闭」会在正常日夜循环的下一帧被覆写回 skyDim
   * —— 静默失效（override 风格的测试路径 update() early-return，测不出来）。
   */
  setShadowsEnabled(enabled) {
    this.dayNight.shadowEnabled = enabled;
    this.sunLight.castShadow = enabled;
    this.renderWorld.materials.dayNight.uShadowStrength.value = enabled ? this.dayNight.params.skyDim : 0;
    if (enabled) this.sunLight.shadow.needsUpdate = true;
  }

  /** 阴影是否开启（E2E 断言用） */
  get shadowsEnabled() { return this.sunLight.castShadow; }

  /**
   * 雾色模式开关（v1.59：雾色融入天空 vs 固定 0x87ceeb）。
   *
   * 消费方 = 设置面板「雾色」行（默认**开**）与 `?fog=0|1` URL 入口。
   * 开关走材质 uniform 的 `mix()` 插值（不是代码分支）→ 关闭时 **逐位** 回到 v1.58 行为。
   *
   * ⚠️ **开启条件是 `this.sky` 存在**：`setupFog()` 只在传入 sky 时构建天空采样节点。
   * 天空盒未启用（`?skybox=0`）、加载失败、或启动时「雾色」已开但 sky 为 null —— 三者都
   * 无法采样（没有立方图），此时 `uFogColorMix` 恒为 0，不得谎报开启状态。
   * 返回实际生效值（调用方 UI 可能据此提示，与 `setTntBlockDamage` 同口径）。
   *
   * @param {boolean} enabled
   * @returns {boolean} 实际生效值
   */
  setFogColorEnabled(enabled) {
    const u = this.fog?.uFogColorMix;
    if (!u) return false;
    // 没有天空盒就没有天空色可融入 —— 静默保持关闭（不写 1，否则采样未绑定立方图 → 全黑雾）
    const effective = !!enabled && this.sky !== null;
    u.value = effective ? 1 : 0;
    return effective;
  }

  /** 雾色模式是否实际开启（E2E 断言用） */
  get fogColorEnabled() { return (this.fog?.uFogColorMix?.value ?? 0) > 0.5; }

  /**
   * v1.63：背景音乐开关（设置面板「背景音乐」行与 `?bgm=0|1` 的落点）。
   *
   * ⚠️ **开关与「真的在出声」是两件事**：开启后还需 buffer 解码完（`preload()` 异步，4MB）
   * 且 AudioContext 已被用户手势恢复（`Player` 的 canvas 点击 → `unlock()`）。两者任意一个
   * 未到，音乐只是「待播」—— 消费者不得把 `musicEnabled === true` 当成「已经响了」。
   * 无法出声时本方法**不抛错也不谎报**：返回实际播放状态（与 `setFogColorEnabled` 同口径）。
   *
   * @param {boolean} enabled @returns {boolean} 当前是否真的在播
   */
  setMusicEnabled(enabled) {
    return this.audioManager?.setMusicEnabled(enabled) ?? false;
  }

  /** 背景音乐开关意图（面板/测试读设置口径，不判断是否已出声） */
  get musicEnabled() { return this.audioManager?.musicEnabled ?? false; }

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
    // M5：持久实体同属「玩家改动」，必须一并回收 —— 否则 beforeunload → flushEntities
    // 会把仍活着的实体写回刚清空的 entities store（与 edits 的写回竞态同构），
    // 且换 seed 时旧世界的装置会泄漏进新世界（违反红线 2 确定性）。
    // 顺序：先回收内存里的持久实体，再清库（与 edits「先清内存再清库」同一口径）。
    if (this.entities) this.entities.despawnPersistent('discard');
    await this.persistence.clearAllEdits();
    await this.persistence.clearAllEntities();
  }

  /**
   * 导出进度：把当前世界的完整存档（seed + 全部玩家改动 + 持久实体）编码成 JSON 文本。
   *
   * ⚠️ **必须先 `flushNow(world)`** —— 内存 edits 才是真相（5s 防抖写盘到期前，刚放下的
   * 方块还没进 `edits` store）。不先落库就会导出一份「5 秒前的旧进度」，而导出侧看不出任何异常
   * （文件照样生成、格式照样合法），只有导入后才发现在丢方块。
   *
   * ⚠️ 导出期间**不暂停玩家编辑** —— 逐格复制而非快照：`listEdits`/`serializePersistent` 都是
   * 同步或单事务的纯读，产出的包内部自洽（实体取的是同一时刻的序列化结果）。
   *
   * 不导出逐格地形（红线 2：地形由 seed 确定性重算）、不导出玩家位置（消费它需改出生点逻辑，
   * 与 `meta.spawn` 语义冲突），详见设计文档 §4.8 的「进度包」段。
   * @returns {Promise<{ok:true, json:string, columns:number, cells:number, entities:number,
   *                     seed:number, filename:string}>}
   */
  async exportProgress() {
    await this.persistence.flushNow(this.world);   // 先落库，见上
    const columns = await this.persistence.listEdits();
    // 持久实体：以 cache（含已卸载 column 的 snapshot）为底，用**当前活着**的实体覆盖同 id
    // —— cache 里可能是该实体早先的旧状态（矿车开走前写的），活着的那份才是最新真相。
    const entitiesById = new Map();
    for (const snapshot of this.persistence.entitiesCache.values()) {
      entitiesById.set(snapshot.id, snapshot);
    }
    if (this.entities) {
      for (const snapshot of this.entities.serializePersistent()) entitiesById.set(snapshot.id, snapshot);
    }
    const entities = [...entitiesById.values()];
    const json = encodeProgress({
      seed: this.seed, spawn: [this.spawnX, this.spawnZ], columns, entities,
    }, this.registry);
    let cells = 0;
    for (const column of columns) cells += column.edits.length;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return {
      ok: true, json, columns: columns.length, cells, entities: entities.length, seed: this.seed,
      filename: `mc-heavy-progress-${this.seed}-${stamp}.json`,
    };
  }

  /**
   * 导入进度：**覆盖式**恢复一份进度包（清空当前全部改动 → 写入包里的 seed/改动 → 重载）。
   *
   * 三步顺序与 `newWorld` / `clearSave` 完全一致，中间那步复用 `_discardEdits()`（**唯一丢弃
   * 入口**：取消在途防抖 flush + 清内存 edits + 清两个 store）—— 不另写一份「清旧世界」的逻辑，
   * 否则内存 edits 的写回竞态会在两条路径里各修一次（红线 1 精神，v1.29 已记录该教训）。
   *
   * ⚠️ **解码失败时零世界写入**（`decodeProgress` 的失败分支不带 edits/entities）—— 坏文件
   * 不该把玩家现有进度清掉一半。
   *
   * ⚠️ **非原子**：IndexedDB 写失败只中止并返回 reason，世界会停在「已清空」状态；此时再导入
   * 一次即可恢复（导入是幂等的：先清后写）。不引入临时 store 交换 —— 那需要 DB 版本升级，
   * 成本远超收益（设计文档 §4.8 已登记）。
   *
   * @param {string} jsonText @returns {Promise<{ok:true, seed:number, columns:number,
   *   cells:number, entities:number, invalid:number, skipped:number} | {ok:false, reason:string}>}
   */
  async importProgress(jsonText) {
    const decoded = decodeProgress(jsonText, this.registry);
    if (!decoded.ok) return decoded;   // 零写入
    await this._discardEdits();
    // spawn 非法（null）→ 保留既有 meta.spawn：写 null 进存档会让下次启动读到非法出生点
    const spawn = decoded.spawn ?? [this.spawnX, this.spawnZ];
    await this.persistence.saveMeta({ seed: decoded.seed, spawn, savedAt: Date.now() });
    let cells = 0;
    for (const column of decoded.edits) {
      await this.persistence.saveColumnEdits(column.columnKey, column.edits);
      cells += column.edits.length;
    }
    await this.persistence.saveEntities(decoded.entities);
    location.reload();
    return {
      ok: true, seed: decoded.seed, columns: decoded.edits.length, cells,
      entities: decoded.entities.length, invalid: decoded.invalid, skipped: decoded.skipped,
    };
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

  // ---- M8 TNT 公开 API ----

  /**
   * 引爆一格 TNT（M8 唯一爆炸入口）。三条路径（左键挖块 / 枪击命中 / 连锁到期）都经此处。
   *
   * 顺序固定（规格 §2.2）：① **去重** → ② 算范围 → ③ 移除引爆格自身 → ④ 破坏事务 →
   * ⑤ 入队连锁 → ⑥ 伤害丧尸 → ⑦ 音效与特效。
   *
   * ⚠️ **去重必须在本函数内**（不能只在 `player.igniteTnt` 里）：连锁队列与枪击路径都直接
   * 调本函数，若去重只在 player 侧，A↔B 两格相距 ≤2 的 TNT 会**永久互爆**
   * （A 炸 → 入队 B → B 到期炸 → 入队 A → …），`_tntExploded` 无界增长。
   * mc-lite 同口径：四个引爆入口（`:172` ctrl+左键 / `:617` 连锁 / `:1048` / `:1083` 子弹命中）
   * 全部先 `has` 再 `add`。
   *
   * ⚠️ **移除引爆格自身独立于破坏开关**：mc-lite `explode()` 的 `removeBlock` 只以
   * 「该格是 tnt」为条件（`PlayerInteraction.js:683-688`），而 `canTntDestroyBlocks` 门控只包住
   * 周围 3×3×3 的 `removeBlocksBatch`（`:608-614`）。若把自身移除塞进破坏开关内，默认关闭时
   * 被引爆的 TNT 方块永不消失 → 连锁链永不终止（这是 mc-lite 的链能终止的原因：
   * `:620` 先 removeBlock 再 explode）。
   *
   * @param {number} x @param {number} y @param {number} z
   * @returns {boolean} false = 去重命中（已引爆过），零世界写入
   */
  explodeTnt(x, y, z) {
    // ① 去重（唯一入口 —— 三条路径共用同一集合）
    const key = `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
    if (this._ignitingTnt.has(key)) return false;
    this._ignitingTnt.add(key);

    const result = computeExplosion({ world: this.world, registry: this.registry, center: [x, y, z] });
    const tntId = this.registry.idOf('tnt');
    // ③ 移除引爆格自身（**不受破坏开关影响** —— 见上方 ⚠️）
    if (this.world.getBlockId(result.center[0], result.center[1], result.center[2]) === tntId) {
      this.editor.setBlock({ x: result.center[0], y: result.center[1], z: result.center[2], id: 0 });
      this._ignitingTnt.delete(key);   // mc-lite `:687` 同口径：移除后释放去重键（该格已非 tnt）
    }
    // ④ 破坏事务（周围 3×3×3，受开关门控）。⚠️ **过滤掉待爆 TNT** —— 否则连锁 TNT 会被
    //    自己的破坏事务删掉（连锁静默丢失：pending 队列里有它，但它已经是空气了）。
    //
    // ⚠️ **过滤集合必须包含本批连锁项，不能只查 `this._ignitingTnt`**（实测修正了计划的写法）：
    //    本函数里破坏事务（④）跑在连锁入队（⑤）**之前**，此刻本批连锁 TNT 还没进
    //    `_ignitingTnt` → 只查该集合会让过滤恒不命中。mc-lite 同口径：`:605-606` 构造
    //    `ignitingKeys = new Set(ignitingTNTs)` 后**再 add 本批 `tntToIgnite` 的全部键**，
    //    `:610` 才用它过滤 —— 即「已有去重键 ∪ 本批待爆项」。
    if (this.canTntDestroyBlocks && result.destroy.length > 0) {
      const pending = new Set(this._ignitingTnt);
      for (const t of result.chain) pending.add(`${t.x},${t.y},${t.z}`);
      this.editor.setBlocks(result.destroy
        .filter((c) => !pending.has(`${c.x},${c.y},${c.z}`))
        .map((c) => ({ x: c.x, y: c.y, z: c.z, id: 0 })));
    }
    // ⑤ 入队连锁。**performance 基准 —— 禁止 Date.now()**（Global Constraints：
    //    两者相差约 17 亿毫秒，混用会让到期判定恒真 → 连锁立即全炸）
    const now = performance.now();
    for (const t of result.chain) {
      this._tntChain.push({ x: t.x, y: t.y, z: t.z, dueAt: now + t.delayMs });
    }
    // ⑥ 半径 4 格内丧尸受 50 伤害
    this._damageEntitiesInRadius(result.center, EXPLOSION_DAMAGE_RADIUS, EXPLOSION_DAMAGE, now);
    // ⑥b 半径内矿车摧毁（mc-lite 爆炸段语义；不掉落物品）
    if (this.minecarts) this.minecarts.destroyInRadius(result.center, MINECART.explosionRadius);
    // ⑦ 音效与特效同帧。音效出处 = mc-lite `PlayerInteraction.js:673`（音量 0.4）；
    //    特效出处 = `World.js:1296 spawnExplosionParticles` —— **两层叠加**：① 序列帧
    //    billboard（`ParticleSystem.js:177`）② 球体扩张（`World.js:1301-1311`，注释原文
    //    「作为底层增强」）。mc-lite 就是这个顺序（billboard 先、球体后），此处照搬。
    this.audioManager?.play('explosion', 0.4);
    // ⚠️ **两层共用同一坐标与同一时间戳**：坐标须 +0.5 换算成块中心（mc-heavy 模板坐标以
    //    块底角为原点，mc-lite 特效位置是 `x+0.5,y+0.5,z+0.5`）；时间戳须 `performance.now()`
    //    基准（M6 活跃约束，禁止 `Date.now()` —— 两者相差约 17 亿毫秒）。
    const burstPos = [
      result.center[0] + 0.5, result.center[1] + 0.5, result.center[2] + 0.5,
    ];
    this.explosionSprite.spawn(burstPos, now);
    this.explosionRenderer.burst(burstPos, now);
    this._tntExploded++;
    return true;
  }

  /**
   * 半径内丧尸伤害。枚举 `ZombieService.activeEntities()`（slot 表是单一权威），
   * **不扫 EntityManager 全量集合** —— 那会把未来其它实体类型（弹丸/炮塔）也炸伤。
   * @param {[number,number,number]} center @param {number} radius
   * @param {number} damage @param {number} nowMs
   */
  _damageEntitiesInRadius(center, radius, damage, nowMs) {
    const cx = center[0] + 0.5, cy = center[1] + 0.5, cz = center[2] + 0.5;
    for (const entity of this.zombies.activeEntities()) {
      const [px, py, pz] = entity.state.position;
      const dy = py + ZOMBIE.height / 2;   // 度量用丧尸 AABB 中心（mc-lite 同口径）
      if (Math.hypot(px - cx, dy - cy, pz - cz) <= radius) {
        this.zombies.damage(entity.id, damage, nowMs);
      }
    }
  }

  /**
   * 帧循环内推进连锁（放在 `_updateNestControllers(nowMs)` 之后）。
   * ⚠️ **不要在到期回调里加「先验证该格仍是 TNT」的门控**（这是无谓偏离）：
   * mc-lite 的到期回调也不重新校验（`PlayerInteraction.js:619-623` 直接 removeBlock →
   * delete(key) → explode()），`explode()` 对空气坐标照样发 worker。本仓库的行为与上游同构。
   */
  _updateTntChain(nowMs) {
    if (this._tntChain.length === 0) return;
    const due = this._tntChain.filter((t) => nowMs >= t.dueAt);
    if (due.length === 0) return;
    this._tntChain = this._tntChain.filter((t) => nowMs < t.dueAt);
    for (const t of due) this.explodeTnt(t.x, t.y, t.z);
  }

  /** 设置 TNT 是否破坏地形（默认 false）。@returns {boolean} */
  setTntBlockDamage(enabled) {
    this.canTntDestroyBlocks = !!enabled;
    return this.canTntDestroyBlocks;
  }

  /** 只读连锁队列状态（测试钩子）。@returns {{pending: number, exploded: number}} */
  tntChainDebugState() { return { pending: this._tntChain.length, exploded: this._tntExploded }; }

  // ---- M6 调试键（X 键生成丧尸，对齐 mc-lite `Game.js:155-202`）----

  /**
   * 在玩家附近生成一只丧尸（X 键）。**调试入口，不是玩法** —— mc-lite 的 X 键同样是
   * `[Debug]` 用途（随机角度 + 随机距离 + console.log），M6 规格 §1 明确「无昼夜自然刷怪」，
   * 正式的生成入口是 M7 巢穴（经 `ZombieService.spawn()`）。
   *
   * **两处有意偏离 mc-lite**（都是 M6 验收时实测到的坑，详见验收报告 §4）：
   * ① 向下扫判据用 `isSolid`，不是 mc-lite 的「非空气」（`getBlock !== null && !== 'air'`）。
   *    理由：M2-7 云层 `supportsPlayer=1` 但 `solid=0`，按「非空气」会把云面当地面 →
   *    `ZombieService.spawn` 的「脚下 solid」门控拒绝 → 生成静默失败。
   * ② 扫描深度 64 格，不是 mc-lite 的 10 格。理由：`findSpawnY`（`gen/terrain.js:98`）从世界顶
   *    向下扫第一个非空气方块，会把空中结构当出生点 → 随机 seed 下玩家可能在云面上（实测
   *    y≈56），与真实地面（y≈17~26）落差约 40 格，10 格扫不到。
   *
   * 另：mc-lite 只试一次落点，失败就静默无输出。这里最多试 8 次不同随机落点，并把结果
   * 返回给调用方（便于测试断言，不靠 console.log）。
   *
   * 随机数用 `Math.random()`（不是 seededRandom）：X 键是玩家手动触发的**调试动作**，
   * 时机本身不可复现，且丧尸是临时实体不入存档 —— 不属红线 2 的「seed 确定性世界生成」范畴
   * （对比 v1.37：`generateCodeHouse` 是生成期代码，必须用 seededRandom）。
   *
   * @returns {{spawned: string|null, position: number[]|null, attempts: number, count: number}}
   */
  /**
   * 受控创造模式选择入口（M7 规格 §2）：转发给 Player，供 Playwright 编程驱动。
   * 不改 Hotbar/背包/HUD —— 只置 Player 的标志位。
   * @param {string} id @returns {boolean}
   */
  selectPlaceable(id) {
    return this.player.selectPlaceable(id);
  }

  /**
   * 只读音频诊断状态（M7 规格 §2）：暴露 AudioManager 的播放请求计数。
   * Playwright 靠它断言「成功放置后尝试播放 put」—— AudioContext 在无头环境未必可播，
   * 故断言的是**请求计数**而非真实出声（M4 同一手法：play() 先递增计数）。
   * @returns {{playRequests: Record<string, number>}}
   */
  audioDebugState() {
    const counts = this.audioManager?.playRequests ?? new Map();
    const out = {};
    for (const [id, n] of counts) out[id] = n;
    return { playRequests: out };
  }

  /**
   * 为一个锚点创建 controller（M7）。两条调用路径共用本方法：
   * ① `onColumnReady` —— column 加载时扫该 column 的 blockEntities 补建；
   * ② `onPlaced` —— 玩家放置成功后立刻建（anchor column 此刻已加载，`onColumnReady`
   *    早在放置前就触发过了 → 只有这条路径能让新巢穴开始刷怪）。
   *
   * **只读已加载 column 的 blockEntities**，不扫世界、不读盘 —— 全局索引在 `hydrate()` 时
   * 已从 edits store 建好，这里只是补上派生 controller。
   *
   * 去重判据 = 已有同 id 的 controller 则跳过：column 重复 ready（重入竞态 / reload）时
   * 不得创建第二个 controller，否则一个巢穴会刷怪两倍（M7 规格 §3「每个锚点只恢复一个」）。
   *
   * @param {string} id @param {Object|null} anchorEntity 巢穴 blockEntity；null → 从世界重读
   */
  _createNestController(id, anchorEntity = null) {
    if (!this.nests || this.nests.controllers().has(id)) return; // 已有 → 不重复创建
    let entity = anchorEntity;
    if (!entity) {
      const anchor = this.nests.anchorOf(id);
      if (!anchor) return;
      entity = this.world.getBlockEntity(anchor[0], anchor[1], anchor[2]);
    }
    if (!entity || entity.kind !== 'zombie-nest') return;
    // 索引缺失（hydrate 前就 ready 的 column）：补登记，使上限判定包含它
    if (!this.nests.hasIndex(id)) {
      const c = entity.critical;
      this.nests.registerAnchor(id, [c.x, c.y, c.z]);
    }
    const controller = new ZombieNestController({
      world: this.world, zombies: this.zombies, editor: this.editor, anchor: entity,
      onInvalidated: (nid) => this._invalidateNest(nid),
    });
    this.nests.setController(id, controller);
  }

  /**
   * 为该 column 内的巢穴锚点创建 controller（column ready 路径）。
   * @param {string} key @param {import('../voxel/chunk-column.js').ChunkColumn} column
   */
  _createNestControllers(key, column) {
    if (!this.nests || column?.blockEntities.size === 0) return;
    for (const entity of column.blockEntities.values()) {
      if (entity?.kind !== 'zombie-nest') continue;
      this._createNestController(entity.id, entity);
    }
  }

  /**
   * 销毁某 column 的全部巢穴 controller（column 卸载）。**保留 anchor 与全局索引** ——
   * 巢穴是方块锚定装置，column 卸载只丢派生对象；再次加载后从 blockEntity 恢复，
   * `lastSpawnAt` 不重置（M7 规格 §2）。
   * @param {string} key
   */
  _destroyNestControllers(key) {
    if (!this.nests) return;
    const [cx, cz] = key.split(',').map(Number);
    for (const [id, controller] of this.nests.controllers()) {
      // column 归属判据用 controller 自己持有的 anchor（它就是这个 column 的锚点）——
      // 不查 service 索引，避免伸手进私有字段（封装失效，改名即崩）。
      const critical = controller.anchor?.critical;
      if (!critical) continue;
      if (Math.floor(critical.x / 16) === cx && Math.floor(critical.z / 16) === cz) {
        controller.dispose();
        this.nests.setController(id, null);
      }
    }
  }

  /** 每帧推进全部巢穴 controller（内部 8 秒节流）。 */
  _updateNestControllers(nowMs) {
    if (!this.nests) return;
    for (const controller of this.nests.controllers().values()) controller.update(nowMs);
  }

  /**
   * 巢穴失效：关键方块被破坏（徒手 / 武器 / TNT 批量编辑同语义）。
   * 删锚点 blockEntity + 移除全局索引 + 销毁 controller —— 三者一起，不留半失效状态。
   * @param {string} id
   */
  _invalidateNest(id) {
    this.nests.destroy(id);
  }

  // ---- M8：炮塔 controller 生命周期（与上方巢穴方法逐条对称） ----

  /**
   * 为一个锚点创建炮塔 controller（**照 M7 的实际签名
   * `_createNestController(id, anchorEntity = null)`**，不是不存在的 `_readNestAnchor`）。
   * 两条调用路径共用：① `onColumnReady` 扫 blockEntities 补建；② `onPlaced` 放置成功后立刻建
   * （anchor column 此刻已加载，`onColumnReady` 早在放置前触发过了 → 只有这条路径能让新炮塔工作）。
   *
   * 去重判据 = 已有同 id 的 controller 则跳过：column 重复 ready（重入竞态 / reload）时不得
   * 创建第二个 controller。⚠️ **去重断言须比较对象引用**（`first === second`），不能用
   * `controllers().size`：按 id 为键 → 重复创建是覆盖写，size 恒为 1（M7 实测无效盲区）。
   *
   * @param {string} id @param {Object|null} [anchorEntity] 炮塔 blockEntity；null → 从世界重读
   */
  _createTurretController(id, anchorEntity = null) {
    if (!this.turrets || this.turrets.controllers().has(id)) return; // 已有 → 不重复创建
    let entity = anchorEntity;
    if (!entity) {
      const anchor = this.turrets.anchorOf(id);
      if (!anchor) return;
      entity = this.world.getBlockEntity(anchor[0], anchor[1], anchor[2]);
    }
    if (!entity || entity.kind !== 'turret') return;
    // 索引缺失（hydrate 前就 ready 的 column）：补登记，使上限判定包含它
    if (!this.turrets.hasIndex(id)) {
      const c = entity.critical;
      this.turrets.registerAnchor(id, [c.x, c.y, c.z], entity.rotation ?? 0);
    }
    const controller = new TurretController({
      world: this.world, zombies: this.zombies, editor: this.editor, anchor: entity,
      onInvalidated: (tid) => this._invalidateTurret(tid),
      // M8 Task 6：发射回调（controller 不反向依赖 entities/render —— 注入解耦）
      onFire: (position, direction, turretId) => this.fireProjectile(position, direction, turretId),
    });
    this.turrets.setController(id, controller);
  }

  /**
   * 为该 column 内的炮塔锚点创建 controller（column ready 路径）。
   * @param {string} key @param {import('../voxel/chunk-column.js').ChunkColumn} column
   */
  _createTurretControllers(key, column) {
    if (!this.turrets || column?.blockEntities.size === 0) return;
    for (const entity of column.blockEntities.values()) {
      if (entity?.kind !== 'turret') continue;
      this._createTurretController(entity.id, entity);
    }
  }

  /**
   * 销毁某 column 的全部炮塔 controller（column 卸载）。**保留 anchor 与全局索引** ——
   * 炮塔是方块锚定装置，column 卸载只丢派生对象；再次加载后从 blockEntity 恢复，
   * `lastFireAt` 不重置（规格 §3.2）。
   *
   * column 归属判据用 controller 自己持有的 anchor（它就是这个 column 的锚点）——
   * 不查 service 索引，避免伸手进私有字段（与 `_destroyNestControllers` 同手法）。
   * @param {string} key
   */
  _destroyTurretControllers(key) {
    if (!this.turrets) return;
    const [cx, cz] = key.split(',').map(Number);
    for (const [id, controller] of this.turrets.controllers()) {
      const critical = controller.anchor?.critical;
      if (!critical) continue;
      if (Math.floor(critical.x / 16) === cx && Math.floor(critical.z / 16) === cz) {
        controller.dispose();
        this.turrets.setController(id, null);
      }
    }
  }

  /**
   * 每帧推进全部炮塔 controller（Task 4 填朝向插值、Task 6 填发射）。
   * @param {number} nowMs @param {number} dt 秒
   */
  _updateTurretControllers(nowMs, dt) {
    if (!this.turrets) return;
    // 8Hz 索敌（accumulator 节流，对齐 mc-lite `TARGET_REACQUIRE_INTERVAL`）。
    // 照 `ZombieService.update` 的 `_aiAccum` 同手法 —— 索敌是重活（最坏 20 炮塔 × 20 丧尸
    // × 100 次 LOS 采样），每帧跑会浪费；朝向插值与开火节流则必须每帧（否则炮塔「一顿一顿」）。
    this._turretAiAccum += dt;
    if (this._turretAiAccum >= TURRET.aiPeriodMs / 1000) {
      this._turretAiAccum = 0;
      this._runTurretAi();
    }
    // 每帧朝向插值 + 开火节流（controller.update 自己判冷却）
    for (const controller of this.turrets.controllers().values()) controller.update(nowMs, dt);
  }

  /**
   * 索敌：**同步**调同构纯函数，把意图写进各 controller。
   *
   * ⚠️ **不走 Worker RPC**（规格 §4.1）：LOS 必须读方块，而世界数据的唯一权威在主线程
   * （红线 1）。故无 `generation` 版本门 —— 但同步执行仍有一处竞态：索敌到写回之间
   * controller 可能被销毁（column 卸载）→ **写回前须查表**（下方 `if (!c) continue`）。
   */
  _runTurretAi() {
    const controllers = this.turrets.controllers();
    if (controllers.size === 0) return;   // 无炮塔 → 空批次不浪费（M6 同口径）
    const turrets = [];
    for (const [id, controller] of controllers) {
      turrets.push({ id, pivot: controller.pivot(), rotation: controller.anchor?.rotation ?? 0 });
    }
    const zombies = this.zombies.activeEntities().map((e) => ({
      id: e.id, position: [...e.state.position],
    }));
    const { updates } = computeTurretUpdates({
      turrets, zombies, world: this.world, registry: this.registry,
    });
    for (const u of updates) {
      const c = controllers.get(u.id);
      if (!c) continue;   // 索敌到写回之间 controller 可能已被销毁（column 卸载）
      c.targetRotation = u.targetYaw;
      c.targetPitch = u.targetPitch;
      // ⚠️ **必须写回目标标识**（实玩反馈修正）：controller 的开火门控靠 `targetId` 判
      // 「有无目标」—— 不写回则它永远认为无目标（或永远认为有目标）。
      c.targetId = u.hasTarget ? u.targetId : null;
    }
  }

  /** 炮塔失效：关键 obsidian 被破坏（徒手 / 武器 / TNT 批量编辑同语义）。 */
  _invalidateTurret(id) {
    this.turrets.destroy(id);
  }

  /**
   * 创建一颗弹丸（M5 临时实体，不存档）。id 确定性派生（红线 2：不用 Math.random）。
   * @param {number[]} position @param {number[]} direction @param {string} turretId
   * @returns {boolean} false = 实体池满额
   */
  fireProjectile(position, direction, turretId) {
    this._projectileSeq += 1;
    const id = `projectile-${turretId}-${this._projectileSeq}`;
    const spawned = this.entities.spawn({
      id, type: 'projectile',
      state: { position, direction, traveled: 0, source: turretId },
      persistent: false,   // 临时实体：随 column 卸载回收，不进 entities snapshot
    });
    // mc-lite `TurretManager.js:148` 的 `playSound('turret_gun_fire', 0.25)`
    this.audioManager?.play('turret_gun_fire', 0.25);
    return spawned !== null;
  }

  /**
   * 帧循环内判定弹丸（放在 `entities.update` 之后 —— 位置已推进，本方法只判定与 despawn）。
   *
   * ⚠️ **推进不能做两遍**（红线 1：同一事实的两个副本）。位置推进已由
   * `projectileDefinition.update` 经 `entities.update(dt, {world})` 驱动；本方法**只调
   * `judgeProjectile`（纯谓词）+ despawn**，不得再写 state —— 两处推进会让弹丸速度翻倍
   * （与丧尸「两处物理会让丧尸推进两遍」同一类缺陷）。
   * `judgeProjectile` 内部用 `from = position − direction×stepLen` 还原本步穿越的线段，
   * 故即便只拿到步后位置也能判定正确区间。
   */
  _updateProjectiles(nowMs, dt) {
    for (const entity of [...this.entities.entities()]) {   // 快照：despawn 会改底层集合
      if (entity.type !== 'projectile') continue;
      const { reason } = judgeProjectile({
        next: entity.state, world: this.world, registry: this.registry,
        entities: this.entities, stepLen: TURRET.projectileSpeed * dt, nowMs,
        onDamage: (id, amount, ms) => this.zombies.damage(id, amount, ms),
      });
      if (reason) this.entities.despawn(entity.id, reason);
    }
  }

  /** 只读弹丸诊断状态。@returns {{count: number, slots: number}} */
  projectilesDebugState() {
    let count = 0;
    for (const entity of this.entities.entities()) if (entity.type === 'projectile') count++;
    return { count, slots: this.projectileRenderer.slotCount() };
  }

  /** 测试 API：放置炮塔（与背包分流同一 `place()` 入口，只是不带玩家 AABB 与朝向）。 */
  placeTurret(origin) {
    return this.turrets.place({ origin, playerAabb: null, rotation: 0 });
  }

  /** 只读炮塔诊断状态。@returns {{count: number, controllers: number}} */
  turretsDebugState() {
    return { count: this.turrets.count(), controllers: this.turrets.controllers().size };
  }

  /**
   * 测试 API（Task 3 的 UI 按钮也调这两个）：创建创造台。
   * 以玩家当前位置为选址基准（东侧优先 → 西侧 → Y−20 → Y−5）。
   * @returns {{ok:true, origin:[number,number,number]} | {ok:false, reason:string}}
   */
  createPlayground() {
    const p = this.player.physics.pos;
    return this.playground.create({ x: p.x, y: p.y, z: p.z });
  }

  /** 测试 API：关闭创造台。玩家须在平台区域外（否则拒绝，防止抽掉脚下地面）。 */
  closePlayground() {
    const p = this.player.physics.pos;
    return this.playground.close({ x: p.x, y: p.y, z: p.z });
  }

  /** 只读创造台诊断状态。@returns {{active: boolean, origin: [number,number,number]|null}} */
  playgroundDebugState() {
    return { active: this.playground.isActive(), origin: this.playground.origin() };
  }

  spawnZombieNearPlayer() {
    const p = this.player.physics.pos;
    let attempts = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      attempts++;
      // mc-lite 语义：随机角度 + 距玩家 2~10 格
      const angle = Math.random() * Math.PI * 2;
      const distance = Math.random() * 8 + 2;
      const x = Math.floor(p.x + Math.cos(angle) * distance);
      const z = Math.floor(p.z + Math.sin(angle) * distance);
      // 向下扫真实地面（solid 判据，见上方偏离 ①/②）
      for (let y = Math.floor(p.y); y >= Math.floor(p.y) - 64; y--) {
        if (this.world.getBlockId(x, y, z) === 0
          && this.world.getBlockId(x, y + 1, z) === 0
          && this.world.isSolid(x, y - 1, z)) {
          const id = this.zombies.spawn([x + 0.5, y, z + 0.5], { source: 'debug-key' });
          if (id) return { spawned: id, position: [x + 0.5, y, z + 0.5], attempts, count: this.zombies.count() };
          // 落点合法但被上限拒绝（20 只已满）→ 不再换落点重试，直接如实返回
          return { spawned: null, position: [x + 0.5, y, z + 0.5], attempts, count: this.zombies.count() };
        }
      }
    }
    return { spawned: null, position: null, attempts, count: this.zombies.count() };
  }

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
    // M5：反向释放实体运行时（layer → manager → pool → renderer）。
    // 先释放渲染层（scene 节点）再释放 manager（state 权威），与启动顺序相反。
    this.entityLayer?.dispose();
    // M6：先回收丧尸（service 归还 slot），再释放渲染器（scene 六部件），最后 manager
    // —— 与启动顺序相反。反序会让 manager.dispose 触发 despawn 时 renderer 已不存在。
    this.zombies?.dispose();
    this.zombieRenderer?.dispose();
    // 矿车：service 回收实体后释放渲染器（与启动顺序相反）
    this.minecarts?.dispose();
    this.minecartRenderer?.dispose();
    // M8：炮塔渲染层 + 爆炸特效池（Game 装配的独立 scene 节点，不经 player.dispose 释放）
    this.turretRenderer?.dispose();
    this.projectileRenderer?.dispose();
    this.explosionRenderer?.dispose();
    this.explosionSprite?.dispose();
    this.blockHitFx?.dispose();
    this.entities?.dispose();
    this.pool.dispose();
    this.renderer.dispose();
  }
}
