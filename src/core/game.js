// src/core/game.js — 主循环编排（§4.9）：input→physics→schedule→budget→render
// M1 范围：世界流式加载 + 地形渲染；玩家移动/交互 Task 9 接入。
import * as THREE from 'three';
import { WorldData } from '../voxel/world-data.js';
import { Scheduler } from './scheduler.js';
import { WorkerPool } from './worker-pool.js';
import { PerfMonitor } from './perf.js';
import { PerfHUD } from './perf-hud.js';
import { BudgetConfig } from './budget.js';
import { LoadWatchdog } from './load-watchdog.js';
import { DEBUG_FLAGS } from './debug-config.js';
import { resourceUrl } from './resource-url.js';
import { RenderWorld } from '../render/render-world.js';
import { setupFog } from '../render/materials.js';
import { setupOcean, WATER_LEVEL_OFFSET } from '../render/ocean.js';
import {
  ReflectScheduler, reflectVisible, reflectHeightFade,
  REFLECT_STRENGTH, REFLECT_DISTORT, REFLECT_MIP_LEVEL, REFLECT_REFRESH_EVERY,
  REFLECT_HEIGHT_FULL, REFLECT_HEIGHT_ZERO, REFLECT_GRAZE, REFLECT_RESOLUTION_SCALE, REFLECT_TINT,
} from '../render/water-reflect-config.js';
import { setupSky, placeCelestial } from '../render/sky.js';
import { DayNight, SUN_LIGHT_BASE_HEX, SUN_LIGHT_BASE_RGB } from '../render/daynight.js';
import { ShadowScheduler, SUN_DIR_GATE_DEG, sunDirectionChanged, texelSnapOffset } from '../render/shadow-manager.js';
import { RainEffect } from '../render/rain.js';
import { WeatherState, RAIN } from '../render/weather.js';
import { WeaponModelLoader } from '../render/weapon-model-loader.js';
import { AudioManager } from '../render/audio-manager.js';
// v2.64：音量表 / 飞龙吼叫间隔 / 死亡爆散配色的唯一权威在各自 config（红线 1：不在装配层写字面量）。
import { SOUND_VOLUMES, DRAGON_SHOUT, ignisAttackSound, BOSS_HIT_SOUND } from '../render/audio-config.js';
import { ZOMBIE_MODEL_DEFS } from '../render/zombie-model.js';
import { ViewWeapon } from '../render/view-weapon.js';
import { ViewArm } from '../render/view-arm.js';
import { WEAPON_IDS, WEAPONS } from '../player/weapons/weapon-catalog.js';
import { TracerRenderer } from '../render/tracer-renderer.js';
import { ExplosionRenderer } from '../render/explosion-renderer.js';
import { BlockHitFxRenderer, IGNIS_DEATH_BURST, smashRingCenter } from '../render/block-hit-fx.js';
import { FlameSigilRenderer, loadFlameSigilTexture, sigilSpawnPoints } from '../render/flame-sigil.js';
import { SpikeFxRenderer, spikeSpawnPoints } from '../render/spike-fx.js';
import { createAtlasColorResolver } from '../render/block-color.js';
import {
  ExplosionSpriteRenderer, loadExplosionSpriteTexture,
} from '../render/explosion-sprite.js';
import { computeExplosion, EXPLOSION_DAMAGE_RADIUS, EXPLOSION_DAMAGE } from '../voxel/explosion.js';
import { stormLanceSweep, stormLanceAxis, stormChargeProgress } from '../player/weapons/storm-lance.js';
import { StormLanceRenderer } from '../render/storm-lance-renderer.js';
import { ChargeRing } from '../ui/charge-ring.js';
import { ZOMBIE } from '../entities/zombies/zombie-config.js';
import { WorldEditor } from './world-editor.js';
import { EntityManager } from '../entities/entity-manager.js';
import { probeDefinition, WEAPON_HITTABLE_TYPES } from '../entities/entity-types.js';
import { EntityRenderLayer, createProbeRenderDef } from '../render/entity-render-layer.js';
import { ZombieService, zombieDefinition } from '../entities/zombies/zombie-system.js';
import { ZombieRenderer } from '../render/zombie-renderer.js';
import { loadZombieSkinTexture } from '../render/zombie-skin-texture.js';
import { TurretRenderer } from '../render/turret-renderer.js';
import { loadTurretTopGeometry } from '../render/turret-top-geometry.js';
import { loadNestBlueprint } from '../entities/zombie-nests/nest-blueprint.js';
import { ZombieNestService } from '../entities/zombie-nests/zombie-nest-service.js';
import { ZombieNestController } from '../entities/zombie-nests/zombie-nest-controller.js';
import { TurretService } from '../entities/turrets/turret-service.js';
import { TurretController } from '../entities/turrets/turret-controller.js';
import { createTurretBlueprint } from '../entities/turrets/turret-blueprint.js';
import { computeTurretUpdates, hasLineOfSight, shortestAngleDiff } from '../entities/turrets/turret-system.js';
import { DRAGON_TYPE, FIREBALL_TYPE, FIREBALL, DRAGON_CORE_OBB } from '../entities/dragons/dragon-config.js';
import { dragonDefinition, DragonService } from '../entities/dragons/dragon-system.js';
import { fireballDefinition, judgeFireball } from '../entities/dragons/fireball-system.js';
import { IGNIS_TYPE, IGNIS, IGNIS_ATTACKS, IGNIS_SPIKE } from '../entities/ignis/ignis-config.js';
import { ignisDefinition, IgnisService } from '../entities/ignis/ignis-system.js';
import { IgnisRenderer } from '../render/ignis-renderer.js';
import { loadIgnisAsset, IGNIS_DEATH_COLOR } from '../render/ignis-model.js';
import { GUARDIAN_TYPE, GUARDIAN, GUARDIAN_ATTACKS } from '../entities/guardian/guardian-config.js';
import { guardianDefinition, GuardianService } from '../entities/guardian/guardian-system.js';
import { GuardianRenderer } from '../render/guardian-renderer.js';
import { loadGuardianAsset, GUARDIAN_DEATH_COLOR } from '../render/guardian-model.js';
import { applyDamage } from '../player/health.js';
import { FireballRenderer } from '../render/fireball-renderer.js';
import { playerHitboxLocal } from '../player/physics.js';
import { bossMapAt, warmBossAnchors } from '../entities/bosses/boss-map.js';
import { bossSlotsFor } from '../entities/bosses/boss-registry.js';
import { DragonRenderer } from '../render/dragon-renderer.js';
import { loadDragonAsset } from '../render/dragon-model.js';
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
import { HealthHUD } from '../ui/health-hud.js';
import { DamageNumbers } from '../ui/damage-numbers.js';
import { Minimap } from '../ui/minimap.js';
import { WaterReflectDock } from '../ui/water-reflect-dock.js';
import { BossHintHUD } from '../ui/boss-hint.js';
import { Crosshair } from '../ui/crosshair.js';
import { SettingsPanel } from '../ui/settings-panel.js';
import { createHotbar } from '../ui/hotbar.js';
import { InventoryPanel } from '../ui/inventory.js';
import { loadIconManifest } from '../ui/icons.js';
import { getBiome } from '../gen/noise.js';
import { loadStoredSettings, resolveSettings } from '../ui/settings.js';
import { Toast } from '../ui/toast.js';
import { pixelRatioFor, normPixelRatioMode } from '../render/pixel-ratio.js';
import { encodeProgress, decodeProgress } from '../save/progress-codec.js';
import { computeTarnZone, findNearestTarnZone } from '../gen/structures/tarn-zone.js';
import { computeArenaAnchor } from '../gen/structures/arena.js';
import { burningArenaTeleportPoint } from '../gen/structures/burning-arena.js';
import { ruinedCitadelTeleportPoint } from '../gen/structures/ruined-citadel.js';
import { jungleFortressTeleportPoint } from '../gen/structures/jungle-fortress.js';
import {
  computeShallowTarnAnchor, SHALLOW_TARN_OUTER_RADIUS,
  BEACH_WIDTH, SLOPE_WIDTH, shallowTarnShapePhase, shallowTarnLakeRadiusAt,
} from '../gen/structures/shallow-water-tarns.js';
import { shallowTarnSurfaceYAt } from '../gen/structures/shallow-water-terrain.js';
import { tarnSurfaceYAt } from '../gen/structures/tarn-terrain.js';
import { WORLD_MAX_Y, WORLD_MIN_Y, SEA_Y } from '../voxel/constants.js';

/**
 * 「标记位置」的 localStorage key（v1.92）。
 *
 * ⚠️ **不进 `DEFAULT_SETTINGS` / `STORAGE_KEY`** —— 标记是**玩家数据**而不是配置：
 * 它不参与 URL 覆盖（`?mark=` 没有意义）、不进 `settingsVersion` 迁移、也不该被
 * 「恢复默认设置」清掉。与 `mc_heavy_settings_v1` 分开存（红线 1：两类数据各有自己的权威）。
 */
const MARK_KEY = 'mc_heavy_mark_v1';

/**
 * 玩家位置落盘的最小间隔（毫秒）。
 *
 * 用户 2026-10-31 要求「记录玩家位置的方法不要影响性能」—— 故**不每帧写**：
 * 常态每帧成本只是 `_maybeSavePlayerPos()` 里的三次减法比较，静止时零写入。
 * 5s 与 `Persistence.scheduleFlush` 的 edits 防抖同量级（两个独立的节流，不共用计时器 ——
 * edits 写的是 column 行、位置写的是 meta 行）。
 */
const PLAYER_POS_SAVE_INTERVAL_MS = 5000;
/** 位置落盘的最小位移（格）：小于它不写（站着不动时不产生任何 IndexedDB 事务）。 */
const PLAYER_POS_SAVE_MIN_MOVE = 1;

/**
 * 校验存档里的玩家位置（`meta.playerPos`）。
 *
 * 只认「三个有限数 + y 在世界高度范围内」—— 坏存档（手改 / 旧版本 / 写入时被中止的
 * 不完整行）不得把玩家放到 NaN 或世界外（与 `markedPosition()` / `teleportToSpawn()` 的
 * 同一防御口径）。非法 → 返回 null，调用方回落 City 出生点（旧存档自然兼容，
 * 无需 settingsVersion 式迁移）。
 * @param {unknown} pos
 * @returns {[number, number, number]|null}
 */
function validPlayerPos(pos) {
  if (!Array.isArray(pos) || pos.length !== 3) return null;
  if (!pos.every((v) => Number.isFinite(v))) return null;
  if (pos[1] < WORLD_MIN_Y || pos[1] > WORLD_MAX_Y) return null;
  return [pos[0], pos[1], pos[2]];
}

/**
 * 瞬移到高台地带时，落点相对**平台外缘**再往外的格数（v1.92）。
 *
 * 平台半径 114、缓坡宽 24 → 取 6 落在缓坡中部：脚下是黏土缓坡（高度已在插值下降），
 * 视野里能看见整片地带的轮廓（圆心在 120 格外），又不会站在圆外的自然地形上看不清边界。
 */
const TARN_TELEPORT_MARGIN = 6;

/**
 * 瞬移到浅水高台时，落点相对**该方位的湖岸线**再往外的格数（v2.19）。
 *
 * = 沙滩带宽 + 半个缓坡带（7 + 12 = 19）：落在缓坡中部 —— 身后是 City 那一侧的自然地形，
 * 面前是整个湖与五座台地（与「高台」按钮的 `TARN_TELEPORT_MARGIN` 同一口径）。
 * ⚠️ 两个带宽都从 `shallow-water-tarns.js` 读，不写字面量（红线 1）。
 */
const SHALLOW_TARN_TELEPORT_OFFSET = BEACH_WIDTH + Math.round(SLOPE_WIDTH / 2);

/**
 * 找「干燥岸边」时扫的方位步长（弧度，≈8.6°）与候选数（24 个 = 正西 ±103°）。
 *
 * 湖岸谐波最多 6 条、最短周期 120° ⇒ 8.6° 的步长足以采到每一个凸起/凹陷方位，
 * 又不会把候选数推多（每个候选只调一次带缓存的纯函数）。
 */
const SHALLOW_TARN_SHORE_STEP = 0.15;
const SHALLOW_TARN_SHORE_PROBES = 24;

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
   * @param {boolean} [opts.reflect] 水面倒影开关（v3.17，默认 true）。false = 不跑反射 pass
   *   且混合强度恒 0（逐位回到无倒影的原式）—— `?reflect=0` URL 入口，Tier 4 单变量 A/B 用。
   * @param {import('./load-watchdog.js').LoadWatchdog} [opts.watchdog] 启动进展计时器（v2.99）。
   *   ⚠️ **全仓唯一实例**：`main.js` 建好后传进来，本类再传给 `Scheduler` → `StructureIndex`。
   *   缺省（fixture 页直建 Game）自建一个 —— 那些页面不启动 loading UI，自建只保证内部不必判空。
   */
  constructor({ canvas, registry, seed = null, viewDistance = 8, hudRoot, blurMipmap = false, budgetProfile = 'auto', chunkPace = 8, startWeather = null, shadows = true, skybox = true, reflect = true, settings = null, watchdog = null }) {
    this._settings = settings;
    /**
     * 启动进展计时器（v2.99）。**全仓唯一实例**，见 `core/load-watchdog.js` 的「单一权威」段。
     *
     * ⚠️ 两个实例会让 `main.js` 看到的 stalled 与等待循环用的那份脱钩 ——
     * 症状是「面板永不出现」或「等待循环放弃而 UI 还在转」，两者都不由任何断言覆盖。
     */
    this._watchdog = watchdog || new LoadWatchdog();
    /**
     * 零进展时的 UI 通知回调（单槽，由 `main.js` 赋值）。
     * ⚠️ **只通知，不中断等待** —— 出生点的 column 等待永不因零进展结束（见 `_waitForColumn`）。
     * @type {((verdict: 'stall'|'hard-cap') => void) | null}
     */
    this.onLoadStalled = null;
    /**
     * 生效设置：main.js 已 resolve（存储+URL）传入；缺省自行合并（fixture 页直建 Game 时）。
     *
     * ⚠️ **必须在构造期解析，不能等到 `start()` 尾部**（用户 2026-10-31 反馈「启动即傍晚/夜晚
     * 时水面颜色不对」的根因之一）：`DayNight` 在 `start()` 中段构造，而旧实现要到尾部才赋
     * `this.settings` → 构造时读不到持久化的 `visualStyle`。同款教训已记在 `bgmEnabled` 上
     * （AudioManager 构造在 settings 赋值之前，读 `this.settings.bgm` 会抛）。
     * 此处解析是**幂等**的（resolveSettings 是纯函数），start() 里的那行赋值保留作兵二。
     */
    this.settings = settings || resolveSettings(loadStoredSettings(), new URLSearchParams(location.search));
    this._shadowsOption = shadows;
    this._skyboxOption = skybox;
    this._reflectOption = reflect;
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
    // 区块铺开节奏（观感旋钮，不是性能旋钮）：每帧最多发布 N 个 section。
    // ⚠️ 必须在这里写而不是等 `this.settings`（那是 start() 尾部才赋值的，见 bgm 的同款教训）。
    this.budget.meshUploadPerFrameLimit = chunkPace;
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
    /**
     * 上一帧的玩家位置（v2.62）—— 只为差分算出玩家速度（焰魔跳跃劈砍的落点预判用）。
     * `null` = 首帧（给 `[0,0,0]`，防 NaN）。
     */
    this._prevPlayerPos = null;
    this.persistence = null;
    /** 每帧 render 后捕获的 renderer.info 快照（异步读取不撞 autoReset 重置点） */
    this._lastRenderInfo = { drawCalls: 0, triangles: 0 };
  }

  async start() {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    // 分辨率档位（v2.27）：清晰 = devicePixelRatio（改动前观感，零回归）、性能 = dpr × 0.5。
    // ⚠️ 这里只写像素比（`_applyPixelRatio`），**不调 `setPixelRatioMode`** —— 后者还会重建雨效，
    // 而此刻 `rain` 与 `scene` 都还没创建（重建只会白做且会被后面的构造覆盖）。雨效在下方
    // 构造时直接从 `settings.pixelRatio` 取雨滴数（`rainParticleCount`），两条路径读同一个值。
    this._applyPixelRatio(this.settings.pixelRatio);
    await this.renderer.init();

    // atlas：纹理 + tileRect 元数据(broadcast 给 Worker 供 mesher 查 UV)
    const { texture } = await loadAtlas({ mipmap: this.blurMipmap });
    this._atlasTexture = texture; // 调试/测试引用
    // 丧尸全身皮肤（标准 64×64）：与 atlas 一并 await（保持 ZombieRenderer 构造器同步 →
    // 首帧不闪纯色）。加载失败不应阻断启动 —— 皮肤只是观感，缺了退回各部件纯色即可
    // （_baseColorOf 的退回路径）。
    this._zombieSkinTexture = await loadZombieSkinTexture().catch((e) => {
      console.warn('[game] 丧尸皮肤加载失败，退回纯色：', e);
      return null;
    });
    // M8：炮塔塔顶几何产物。**零贴图**（v3.14）：装甲改走三档冷灰金属颜色渲染，
    // 旧的 armor.png 加载已整套删除。几何缺了不装配外观（玩法仍正常）。
    const turretTop = await loadTurretTopGeometry().catch((e) => {
      console.warn('[game] 炮塔塔顶几何加载失败，本局不装配炮塔外观：', e);
      return null;
    });
    this._turretTopGeometry = turretTop;
    // 爆炸序列帧图集（500×200，5×2 = 10 帧）。同上口径：加载失败不阻断启动 ——
    // 爆炸特效只是观感，缺了退回「只有球体扩张层」（`explosion-renderer.js`）即可。
    this._explosionSpriteTexture = await loadExplosionSpriteTexture().catch((e) => {
      console.warn('[game] 爆炸序列帧图集加载失败，退回只有球体扩张层：', e);
      return null;
    });
    // v3.04：焰魔地面火焰法阵贴图（mod 既有素材逐字节拷入，非新画美术资源）。
    // 同上容错口径：加载失败不阻断启动 —— 法阵只是观感，缺了仍有碎石反馈。
    this._flameSigilTexture = await loadFlameSigilTexture().catch((e) => {
      console.warn('[game] 焰魔法阵贴图加载失败，本轮不装配法阵层：', e);
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
    // 水面倒影（v3.17）：刷新节流器 + 四个参数快照。
    // 默认开（用户要的就是这个效果）；`?reflect=0` 与面板可关，关掉逐位回到原式。
    this.reflectScheduler = new ReflectScheduler({ every: REFLECT_REFRESH_EVERY });
    this._reflectEnabled = true;
    this._reflectStrength = REFLECT_STRENGTH;
    // 高度衰减的两个阈值（调参坞可改）
    this._reflectHeightFull = REFLECT_HEIGHT_FULL;
    this._reflectHeightZero = REFLECT_HEIGHT_ZERO;
    // target 必须入场景，否则其 matrixWorld 不更新 → 阴影相机朝向错。
    this.scene.add(sunLight.target);
    this.scene.add(sunLight);
    this.sunLight = sunLight;
    // 光源跟随节流快照（玩家位置；mc-lite Game.js:537 口径：移动超 5 格才重新定位）。
    // 初始 (0,0,0)：出生点距原点必 >5 格 → 第一帧即自动定位。
    this._lastShadowPos = { x: 0, y: 0, z: 0 };
    /**
     * 玩家位置落盘的节流基线（`_maybeSavePlayerPos` / `_savePlayerPos` 共用）。
     * 初始 null = 「还没有基线」→ 帧循环节流直接返回，不凭空写一次。
     * `start()` 在 `player.spawn` 之后把它设成实际出生位置（**不写盘** —— 启动时读的就是
     * 存档里的值，写回去是冗余事务）。
     */
    this._lastSavedPos = null;
    this._lastSavedPosAt = 0;
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
    // ⚠️ 海面必须先于 DayNight 创建：它的 `uWaterTint`（v2.1 环境亮度乘数）由 DayNight._apply
    // 写入，而构造器末尾就会立即 apply 一次 —— 晚于构造就接不到启动那一帧。
    this.ocean = setupOcean(this.scene);
    // 反射 pass 需要 renderer 句柄（此时 `renderer.init()` 已 await 完）。
    this.ocean.setRenderer(this.renderer);
    // ⚠️ 灯光创建必须在 RenderWorld 之前：材质的 shadow() 节点在构建时固定 light 引用。
    this.renderWorld = new RenderWorld({ scene: this.scene, atlasTexture: texture, viewDistance: this.viewDistance, sunLight });
    // 日夜循环（M2-6）：正午起步（与 M1 视觉口径一致），1200s 一天
    this.dayNight = new DayNight({
      scene: this.scene,
      fog: fogUniforms,
      voxelUniforms: this.renderWorld.materials.dayNight,
      skyUniforms: this.sky
        ? { uNightBlend: this.sky.uNightBlend, uDuskBlend: this.sky.uDuskBlend, uWaterTint: this.ocean.uWaterTint }
        : { uWaterTint: this.ocean.uWaterTint },
      // 启动即目标风格（用户 2026-10-31）：持久化的「傍晚/黑夜」必须在**构造首帧**就生效，
      // 而不是等 start() 尾部的 setVisualStyle() 补 —— 否则首帧（含水面 tint）是正午值。
      visualStyle: this.settings.visualStyle || null,
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
    let meta = await this.persistence.loadMeta();

    // ---- 方块清单指纹校验（v1.29）----
    //
    // **为什么必须在 `hadMeta` 之前校验**：edits 行存的是数字方块 ID，而 ID 由注册顺序决定。
    // 从 `blocks-data.js` 删/插一行声明会让**后面所有 ID 前移**，旧存档里的玩家改动会
    // 静默错位成别的方块（不报错，只是世界内容变了）。2026-11-04 按用户裁定删
    // `realistic_oak_leaves`（当时排第 17，后面还有 122 个）就会踩到。
    //
    // 处置 = **丢弃旧世界的 edits/entities，保留 seed 与玩家位置**：地形是 seed 的确定性
    // 函数（红线 2），重新生成后世界完整；丢的只是玩家手工改动（不可恢复，故给 `console.warn`）。
    // 旧存档没有该字段 → 视为不兼容（宁可丢改动也不静默错位）。
    const blockFp = this.registry.fingerprint();
    const blockCount = this.registry.count;
    if (meta && meta.seed !== undefined && meta.blockFp !== blockFp) {
      // ---- v3.19：**末尾追加**新方块不得清档 ----
      //
      // 既有 id = BLOCKS 下标，在末尾追加时它们**逐位未变** ⇒ 旧 edits 完全可读。
      // 但全量指纹会变（实测 fc6212f5 → 16d99151）⇒ 旧判据会把玩家手工建造白白清掉。
      //
      // 判据 = 「旧清单是当前清单的**前缀**」：meta 记了当时的方块数 `blockCount`，
      // 拿它算前缀指纹，相等则前 n 个 id 语义未变。
      // ⚠️ **中间插入 / 删除 / 换序仍走下面的清档路径**（前缀指纹会变，单测逐条钉住）。
      // ⚠️ **旧存档没有 blockCount** ⇒ 回落旧口径（全等），行为不变。
      // ⚠️ 哈希只在 registry 里算（红线 1），本处不自写循环。
      const oldCount = meta.blockCount;
      const appendOnly = Number.isInteger(oldCount) && oldCount > 0 && oldCount <= blockCount
        && this.registry.fingerprintOfPrefix(oldCount) === meta.blockFp;
      if (appendOnly) {
        console.info(`[save] 方块清单末尾追加了 ${blockCount - oldCount} 项（${meta.blockFp} → ${blockFp}）：`
          + `既有 ${oldCount} 个方块 ID 逐位未变，玩家改动与实体全部保留。`);
        await this.persistence.saveMeta({ ...meta, blockFp, blockCount, savedAt: Date.now() });
        meta = { ...meta, blockFp, blockCount };
      } else {
        console.warn(`[save] 方块清单已变（存档 ${meta.blockFp ?? '(无)'} → 当前 ${blockFp}）：`
          + '方块 ID 可能已前移，旧存档的玩家改动会错位，已丢弃（seed 与位置保留）。');
        await this.persistence.clearAllEdits();
        await this.persistence.clearAllEntities();
        await this.persistence.saveMeta({ ...meta, blockFp, blockCount, savedAt: Date.now() });
        meta = { ...meta, blockFp, blockCount };
      }
    }

    const hadMeta = !!(meta && meta.seed !== undefined);
    if (hadMeta) this.seed = meta.seed;
    else {
      if (this.seed === null || this.seed === undefined) {
        this.seed = randomSeed();
      }
      await this.persistence.saveMeta({ seed: this.seed, spawn: [8, 8], blockFp, blockCount, savedAt: Date.now() });
    }
    // 上次停留的位置（用户 2026-10-31：「游戏重新进入后……玩家位置也恢复到上次停留的状态」）。
    // 非法/缺失 → null，下面回落 City 出生点。
    const resumedPos = validPlayerPos(meta && meta.playerPos);
    this.ocean.setSeed(this.seed);
    // 高台地带池面：初始接一次（玩家可能直接出生在地带附近）。
    // 之后由帧循环按移动阈值刷新 —— 照 `_updateSunPosition()` 的同一手法（不每帧调）。
    this._tarnPoolAnchor = null;

    this.scheduler = new Scheduler({
      world: this.world, pool: this.pool, registry: this.registry,
      seed: this.seed, viewDistance: this.viewDistance, perf: this.perf,
      renderWorld: this.renderWorld, budget: this.budget,
      getEdits: (key) => this.persistence.getEditsSync(key),
      watchdog: this._watchdog,
    });
    this.scheduler._atlasMeta = atlasMeta; // 快速路径主线程 mesh 用（与 broadcast 同一份）
    // 布局等待的零进展通知：与 column 等待共用同一条 UI 出口（main.js 赋值 onLoadStalled）。
    // ⚠️ 只转发，不在这里做任何计时判断（判据的唯一权威是 LoadWatchdog）。
    this.scheduler.structureIndex.onStalled = (verdict) => { this.onLoadStalled?.(verdict); };
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
      // 解卡（传送/出生被埋的主修复点，见 `_resolvePlayerStuck`）：传送不等 column，
      // 玩家可能已掉到世界底，而本 column 的「底部补实」刚把那段填成实心 → 加载完成的
      // 这一刻把玩家抬出来。内部先做「column 与玩家 AABB 相交」门控，远处 column 零成本。
      this._resolvePlayerStuck(column);
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
    this.zombieRenderer = new ZombieRenderer({ scene: this.scene, skinTexture: this._zombieSkinTexture });
    // M8：炮塔渲染层（8 部件固定容量实例池）。slot 由 renderer 内部**差集驱动**分配
    // （sync(poses) 里新 id 分配、消失 id 归还）—— 不在 TurretService 侧建 slot 池。理由：
    // 炮塔不是 EntityManager 实体（是方块锚定装置），没有 `despawnColumn` 绕过玩法服务的
    // 回收路径，差集驱动即可覆盖全部回收场景（column 卸载 / 失效 / 放置）。M6 的 service 侧
    // slot 池是为高频 spawn/despawn 的丧尸设计的，炮塔低频放置，不需要那套记账。
    this.turretRenderer = new TurretRenderer({
      scene: this.scene,
      topGeometry: this._turretTopGeometry,
      // 金属高光（装甲三档 + 炮管单色）**复用体素材质的同一个太阳 uniform**（红线 1）：
      // 自己 new 一个会让日夜变了而炮塔高光钉在正午方向。
      sunDirection: this.renderWorld.materials.dayNight.uSunDirection,
      sunStrength: this.renderWorld.materials.dayNight.uSunStrength,
      sunColor: this.renderWorld.materials.dayNight.uSunColor,
    });
    // M8 Task 6：弹丸是 **M5 临时实体**（roadmap 指定接入点：EntityManager + 实体 raycast），
    // 不是渲染节点 —— 命中真相由实体逻辑 AABB 给出，渲染层只发布 pose。
    this.entities.registerType('projectile', projectileDefinition);
    this.projectileRenderer = new ProjectileRenderer({ scene: this.scene });
    /** 弹丸 id 序号（确定性派生 —— 红线 2：不用 Math.random） */
    this._projectileSeq = 0;
    // v2.44：飞龙火球是 M5 临时实体（与弹丸同构但刻意独立：速度/遮挡/命中语义全不同）。
    // ⚠️ **不复用 'projectile' type**：两个渲染器都按 type 过滤，共用会让火球被画成曳光弹。
    this.entities.registerType(FIREBALL_TYPE, fireballDefinition);
    /** 火球 id 序号（确定性派生 —— 红线 2：不用 Math.random） */
    this._fireballSeq = 0;
    // ---- v2.64：Boss 战音效与 BGM 状态（用户 2026-11-07）----
    /**
     * 焰魔/飞龙的表现层状态快照（帧间差分用）。
     *
     * ⚠️ **为什么不写进 Agent/createState**：挥刀音/跳跃音/随机吼叫是**纯表现层**关注点，
     * 而 `ignis-boss-agent.js` / `ignis-system.js` 属于 Worker 同构层（红线 8，不得碰音频）。
     * 把音效触发写进同构层会破坏红线 8（主线程/Worker 同构纯函数）。故在装配层（Game）
     * 用「上一帧 mode/leapKind」与「本帧」做差分检测状态迁移 —— 焰魔最多 2 只、飞龙最多 4 条，
     * 每帧一次 Map 查询成本可忽略。
     *
     * 形状：`Map<entityId, {mode, leapKind, generation, nextShoutAt}>`。
     * 实体 despawn 后由 `_syncBossAudio` 清理（按 generation 判失效，与伤害数字同手法）。
     * @type {Map<string, object>}
     */
    this._bossAudioState = new Map();
    /**
     * 火球 spawn 失败计数（评审 I3 防线）。
     *
     * ⚠️ **为什么需要**：`entities.spawn` 满额返回 null 时 `fireFireball` 返回 false，
     * 而 `_consumeDragonFireRequests` 若不检查返回值，火球会凭空消失且冷却已重置
     * （龙要再等 5~10 秒）—— 形态是「龙张嘴没喷出东西，然后长时间不喷」，玩家会读作
     * AI 坏了。概率低（需 EntityManager 全量满额）但是**静默**的，与本仓的去重集合污染同类，
     * 值得一个诊断口。计数进 `fireballsDebugState()`，首次失败时 console.warn 一次。
     */
    this._fireballSpawnFailed = 0;
    /** 火球渲染池（InstancedMesh 球体；无活跃火球时 visible=false → draw call 归零） */
    this.fireballRenderer = new FireballRenderer({ scene: this.scene });
    /** 玩家命中盒（局部，相对脚底中心）—— entities/ 不 import player/，故由装配层注入 ctx */
    this._playerAabbLocal = playerHitboxLocal();
    this.zombies = new ZombieService({
      entities: this.entities, world: this.world,
      // M6 AI：经既有 WorkerPool 的统一 `ai` RPC（不新建 Worker，红线 3 / M5 规格 §3）
      pool: this.pool,
      onSpawn: (id, slot) => this.zombieRenderer.acquireSlot(id, slot),
      onDespawn: (id) => this.zombieRenderer.releaseSlot(id),
      // v2.81 击退视觉补间：服务层知道这一帧确实发生了击退（它刚算完 next − prev），
      // 渲染层据此把渲染位置滞后一小段再 ease-out 追平。用位置增量猜必然误伤
      // （丧尸 AI 每帧 0.02 格 vs 0.9 格击退）。
      onKnockback: (id, dx, dz) => this.zombieRenderer.noteKnockback(id, dx, dz),
    });
    this.entities.registerType('zombie', zombieDefinition);

    // ---- 祭坛飞龙装配（v2.41）----
    // 龙是**景观实体**：全世界恰好一条，在带祭坛的高台地带上空盘旋。
    // ⚠️ **装配位置必须在 `persistence`(:447) / `seed`(:451) 之后**（否则拿到 null persistence
    // 与未定 seed），且在 `_waitForColumn`(:769) **之前** —— 同 M7 巢穴/炮塔的装配约束。
    // ⚠️ **龙是临时实体**（`persistent: false`）：位置是 seed 的纯函数，进存档就是第二份
    // 权威（红线 2）。v2.43 起**不再有任何东西进存档** —— 永久死亡标记已随「死后可重召」移除。
    this.entities.registerType(DRAGON_TYPE, dragonDefinition);
    this.dragons = new DragonService({
      entities: this.entities, seed: this.seed,
      // v2.81 击退视觉补间（与丧尸同口径）。⚠️ 闭包延迟取值 —— 本行早于
      // `dragonRenderer` 创建，击退发生时它必已就位；加载失败为 null 则跳过。
      onKnockback: (id, dx, dz) => this.dragonRenderer?.noteKnockback(id, dx, dz),
    });
    // 渲染器：要 await 产物加载。⚠️ **加载失败不得让整个游戏起不来**（龙是景观，
    // 缺它不该白屏）—— 与 M4 武器模型 / M8 蓝图加载失败同一容错口径。失败则
    // `dragonRenderer = null`，帧循环判空。
    try {
      const dragonAsset = await loadDragonAsset();
      this.dragonRenderer = new DragonRenderer(this.scene, dragonAsset);
      await this.dragonRenderer.loadTexture();
    } catch (err) {
      console.warn('[dragon] 渲染器加载失败，龙不显示（不影响游戏）:', err);
      this.dragonRenderer = null;
    }
    // ⚠️ **v2.43 起不再预热**：龙不再绑定祭坛地带（`findAltarTarnRegion` 的 12.6ms 冷调用
    // 已不在龙的路径上），轨道中心由按 B 时的 `bossMapAt()` 给出。

    // ---- 焰魔装配（v2.55，高台地带的 Boss2）----
    // ⚠️ **装配位置与龙同段**（在 `persistence` / `seed` 之后、`_waitForColumn` 之前）。
    // 焰魔也是**临时实体**（`persistent: false`）—— 它是 Boss，但进存档就是第二份权威（红线 2）。
    this.entities.registerType(IGNIS_TYPE, ignisDefinition);
    // `world` 用于召唤时扫描地表落点（spec：不能用 `findSpawnY`，它会把高台地带的巨型云当地面）
    this.ignises = new IgnisService({
      entities: this.entities, world: this.world, seed: this.seed,
      // v2.81 击退视觉补间（与丧尸/飞龙同口径；闭包延迟取值，理由同上）
      onKnockback: (id, dx, dz) => this.ignisRenderer?.noteKnockback(id, dx, dz),
    });
    // 渲染器：加载失败不得让整个游戏起不来（与龙/武器模型/蓝图同一容错口径）
    try {
      const ignisAsset = await loadIgnisAsset();
      this.ignisRenderer = new IgnisRenderer(this.scene, ignisAsset);
      await this.ignisRenderer.loadTexture();
    } catch (err) {
      console.warn('[ignis] 渲染器加载失败，焰魔不显示（不影响游戏）:', err);
      this.ignisRenderer = null;
    }

    // ---- 末影守卫装配（废弃堡垒的 Boss1 + **围场的 Boss1**，v3.09）----
    // ⚠️ 两张图各一只 ⇒ `GUARDIAN.maxAlive = 2`（渲染池容量从它派生）。
    // ⚠️ **装配位置与龙/焰魔同段**（在 `_waitForColumn` 之前）。
    // 守卫也是**临时实体**（`persistent: false`）—— 进存档就是第二份权威（红线 2）。
    this.entities.registerType(GUARDIAN_TYPE, guardianDefinition);
    // `world` 用于召唤时扫描落点：守卫恒召到**上层房间**（summonY = floorY − 6），
    // 且 `_findGroundY` 的 HEADROOM = ceil(3.8) = 4（取 5 会静默召到中层，差 8 格）。
    this.guardians = new GuardianService({
      entities: this.entities, world: this.world, seed: this.seed,
      onKnockback: (id, dx, dz) => this.guardianRenderer?.noteKnockback(id, dx, dz),
    });
    // 渲染器：加载失败不得让整个游戏起不来（与龙/焰魔/武器模型同一容错口径）
    try {
      const guardianAsset = await loadGuardianAsset();
      this.guardianRenderer = new GuardianRenderer(this.scene, guardianAsset);
      await this.guardianRenderer.loadTexture();
    } catch (err) {
      console.warn('[guardian] 渲染器加载失败，末影守卫不显示（不影响游戏）:', err);
      this.guardianRenderer = null;
    }

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
    /**
     * 「已排期、尚未引爆」的格键集合（v2.97）。
     * ⚠️ **不能合并进 `_ignitingTnt`**：后者的语义是「引爆进行中」，在 `explodeTnt` 出口就
     * 无条件释放（否则键残留 → 该格以后永远炸不掉）。而排期项要活到 500~1100ms 后真正引爆。
     * ⚠️ **也不能用「扫 `_tntChain` 查重」代替**：`_updateTntChain` 在逐项引爆前把本帧到期的项
     * **整批**从队列里抽走 ⇒ 同批两项互相看不见，去重失效（v2.97 实测：三连仍重复入队，
     * 多出一次幽灵爆炸 —— `exploded` 计数 4 而非 3）。
     * @type {Set<string>}
     */
    this._tntScheduled = new Set();
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

    // v3.04：焰魔举盾砸击的地面火焰法阵（原版 Flame_Strike_Entity 的视觉层）。
    // ⚠️ 贴图缺失时**跳过装配**（置 null）—— 下游一律 `?.` 调用，
    // 不拿空贴图建一个永远看不见却占 draw call 的池。
    this.flameSigil = this._flameSigilTexture
      ? new FlameSigilRenderer({ scene: this.scene, texture: this._flameSigilTexture })
      : null;

    // v3.06：焰魔尖刺攻击的火焰尖锥（程序化几何，**无贴图依赖** ⇒ 恒装配）。
    // 原版无尖刺素材（它是把地面方块整块掀飞），本仓新建几何 —— 用户裁定「火焰尖锥」。
    this.spikeFx = new SpikeFxRenderer({ scene: this.scene });

    // v3.20：持剑蓄力大招 Storm Lance（程序化几何 + TSL，**零贴图依赖** ⇒ 恒装配）。
    // 单槽：总视觉时长 1.773s < 蓄力 2.0s ⇒ 两道闪电不可能重叠（推导见渲染器文件头）。
    // 空闲时七个 mesh 全部 visible=false ⇒ 0 draw call，bench 冻结基线逐位不变。
    this.stormLance = new StormLanceRenderer({ scene: this.scene });

    // 出生点（mc-lite 语义：优先 City 中心出生，保证出生即见城市天际线，§7 M2 验收）
    const regionLayout = await this.scheduler.structureIndex.waitForRegion(0, 0);
    // 水面遮罩的城市门控 bounds（城市全世界唯一，固定 region [0,0]）。
    // 城市把地面压平到接近海平面 → 若不关掉水面平面，玩家在城市里下挖 2 格就会
    // 挖出一汪假水（洞底顶面降到 -2，低于水面平面 -1.5）。判据见 render/ocean-mask.js。
    this.ocean.setCityBounds(regionLayout.city);
    // 浅水高台的湖盆（v2.14）：湖底被整形压到 `SEA_Y-1`，而水域遮罩读的是
    // `generateHeight`（自然地形，没变）→ 不接这一项的话湖面上只剩体素水的
    // **静态顶面**（无波纹），用户报告的「波纹没盖全」就是这个。
    // 锚点来自 `computeShallowTarnAnchor` 的 seed 缓存（与 layout 层同一份，红线 1），
    // 不建第二份落点副本。
    //
    // ⚠️ **v2.15：半径用 `SHALLOW_TARN_OUTER_RADIUS`（整形区最大半径），不是湖半径**。
    // 理由：① 湖岸已不是圆，在 TSL 里重算谐波必然是第二份实现（会与 JS 漂移）；
    // ② 放大到整形区是**零风险**的 —— 整形区内干燥列的地表恒 ≥ `SEA_Y`（顶面 ≥ -1 >
    // 平面 -1.5），平面被深度测试遮掉；淹水列的体素水面顶面正好也是 -1.5。
    // ③ 接壤水系的水下方坡落在湖缘外 3.5 格之外，不放大就会只剩体素水顶面。
    const shallowTarn = computeShallowTarnAnchor(this.seed);
    this.ocean.setLakeCircle(shallowTarn
      ? { cx: shallowTarn.wx, cz: shallowTarn.wz, radius: SHALLOW_TARN_OUTER_RADIUS }
      : null);
    const citySpawn = getCitySpawnPoint(regionLayout.city);
    this.spawnX = citySpawn.x; this.spawnZ = citySpawn.z;
    if (!hadMeta) {
      await this.persistence.saveMeta({ seed: this.seed, spawn: [this.spawnX, this.spawnZ], blockFp: this.registry.fingerprint(), blockCount: this.registry.count, savedAt: Date.now() });
    }
    // ---- 实际出生位置（与 `spawnX/spawnY/spawnZ` 是**两套口径**，勿混）----
    // `spawnX/spawnY/spawnZ` 永远 = City 出生点（「回家」按钮与既有 spec 的权威，语义不变）；
    // 本次真正落地的位置 = 上次停留处（合法时），否则 City 出生点。
    let startX = resumedPos ? resumedPos[0] : this.spawnX;
    let startY = resumedPos ? resumedPos[1] : 0;   // City 分支的 y 要等 findSpawnY 才算得出
    let startZ = resumedPos ? resumedPos[2] : this.spawnZ;
    {
      // edits 预热必须覆盖 **City ∪ 恢复位置** 两个区域：`getEditsSync` 是同步的，GEN 前没
      // preload 就等于「该 column 无修改」→ 玩家改动静默丢失。顺带修掉一个既有缺口
      // （在远离 City 处编辑后重启、再走回去，改动会丢）。Set 去重（两区域常重叠）。
      const R = this.viewDistance;
      const keys = new Set();
      const addArea = (wx, wz) => {
        const pcx = Math.floor(wx / 16), pcz = Math.floor(wz / 16);
        for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) keys.add(`${pcx + dx},${pcz + dz}`);
      };
      addArea(this.spawnX, this.spawnZ);
      if (resumedPos) addArea(startX, startZ);
      await this.persistence.preloadEdits([...keys]);
    }
    this.scheduler.update(this.spawnX, this.spawnZ);
    await this._waitForColumn(Math.floor(this.spawnX / 16), Math.floor(this.spawnZ / 16));
    // 首次阴影渲染：autoUpdate=false 下 map 是空的，不置 needsUpdate 则第一帧无影
    // （后续刷新由 shadowScheduler 按需放行）。
    this.sunLight.shadow.needsUpdate = true;
    this.spawnY = findSpawnY(this.world, this.spawnX, this.spawnZ);
    if (!resumedPos) startY = this.spawnY;
    // 恢复位置的 column 可能不在 City 加载半径内 → 单独等它。
    // ⚠️ `driveX/driveZ` 必须传（v1.92 已踩过的坑：不推调度中心则目标永远进不了加载半径
    // → 超时）。⚠️ 超时**不得让启动整体失败** —— 回落 City 出生点比弹错误遮罩好。
    const rcx = Math.floor(startX / 16), rcz = Math.floor(startZ / 16);
    if (!this.world.hasColumn(rcx, rcz)) {
      this.scheduler.update(startX, startZ);
      try {
        await this._waitForColumnOrTimeout(rcx, rcz, 10000, startX, startZ);
      } catch (err) {
        console.warn('[game] 恢复位置加载失败，回落 City 出生点：', err);
        startX = this.spawnX; startY = this.spawnY; startZ = this.spawnZ;
      }
    }
    // M4：武器渲染/音频运行时（只在主线程；不进 Worker/体素 meshing 管线）。
    // 模型加载失败只记录 console，不中止 worldReady——玩家保持徒手可玩。
    this.weaponModelLoader = new WeaponModelLoader();
    // v1.63：背景音乐开关来自生效设置。
    // ⚠️ 旧实现因为 `this.settings` 在 start() 尾部才赋值，这里只能再解析一次；现在已改为
    // **构造期解析**（见构造器注释，v2.1 修启动即傍晚/夜晚水面不准时一并收口）→ 直接读。
    this.audioManager = new AudioManager(this.camera, {
      bgmEnabled: this.settings.bgm,
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
        // v3.20：Storm Lance 渲染器（上面刚装配）—— 玩家松手施放时由它出视觉
        stormLanceRenderer: this.stormLance,
      },
      // M3.1 模态守卫（§4.5.4）：面板打开时 Player 的 keydown 全部拦截。
      // 谓词注入而非传 Game 本身，保持 player/ 不反向依赖 core/（依赖方向 §3）
      isModal: () => this.uiModal,
      // M6：X 键生成丧尸（调试键，对齐 mc-lite）。注入回调而非传 Game（依赖方向 §3，与 isModal 同手法）
      onSpawnZombie: () => this.spawnZombieNearPlayer(),
      // v2.43：B 键召唤玩家所在地图的 Boss。注入回调而非传 Game（依赖方向 §3，同手法）
      onSummonBoss: () => this.summonBoss(),
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
    this.player.spawn(startX, startY, startZ);
    // v2.62：把焰魔服务注入玩家物理（用户缺陷⑦「不动如山」）—— 玩家撞上焰魔身体盒
    // 就像撞上实心方块。注入而非让 `player/` import `entities/`（依赖方向 §3，与
    // `physics.minecarts` / `nests` / `turrets` 完全同一手法）。`this.ignises` 在 :665 已建好。
    this.player.physics.ignises = this.ignises;
    // 守卫同理（本次新增）：玩家撞上守卫身体盒就像撞上实心方块。
    // `_ejectFromBoss` 对两套 service 各探一次最近出口（双 Boss 同时在场时两套盒都生效）。
    this.player.physics.guardians = this.guardians;
    // 解卡（出生路径）：恢复的位置可能被埋（玩家上次停在结构/地形边缘，或存档里的 y
    // 与当前生成结果有出入）。常态下这里是一次 `collidesAt` 的 no-op。
    this._resolvePlayerStuck();
    // 位置落盘的节流基线：设成实际出生位置，**不写盘**（启动时读的就是存档里的值，
    // 写回去是冗余事务；玩家移动 ≥1 格后由帧循环的 `_maybeSavePlayerPos` 接管）。
    this._lastSavedPos = { x: startX, y: startY, z: startZ };
    this._lastSavedPosAt = performance.now();
    this.scene.add(this.player.highlight);

    // M6：把实体查询注入**同一个** M4 controller（M6 规格 §2）。只注入两个函数 ——
    // ① `EntityManager.raycast()`：实体命中唯一入口（红线 6 禁止 Raycaster，地形仍走 DDA）；
    // ② `ZombieService.damage()`：立即改权威 state + 置 flashedUntil。
    // controller 不持有任何实体集合、不 import entities/render（依赖方向 §3）。
    // 必须在 Player 构造之后调 —— weaponController 由 Player 构造期创建。
    this.player.weaponController.setEntityQuery({
      raycast: (origin, dir, maxDist, predicate) =>
        this.entities.raycast(origin, dir, maxDist, predicate),
      // v2.41：伤害改为按实体类型分发（不再硬编码丧尸）；predicate 读共享集合
      damage: (id, amount, nowMs) => this.damageEntity(id, amount, nowMs),
      isHittable: (entity) => WEAPON_HITTABLE_TYPES.includes(entity.type),
      // v2.65 近战剑：击退（方向由 Game 用玩家位置算，controller 只传 id 与距离）
      knockback: (id, dist) => this.knockbackEntity(id, dist),
      // v3.20 Storm Lance：五射线扫描 + 逐个扣血。controller 不持有 world/entities（依赖方向 §3）。
      sweepLance: (aim, cfg) => this._stormLanceSweep(aim, cfg),
    });

    // 天气 + 雨效（M3-3）：状态机自动周期（晴 60~180s → 雨 30~90s，5s 过渡），
    // rain 效果移植 mc-lite RainEffect（world.isSolid 地面截停；267 滴分批迁移削峰）
    // ⚠️ v1.96 起 cloud 是 `solid:true` → **雨滴会停在云顶**（Y=35/55 云簇完全在雨幕循环高度
    // 42 的范围内）。实测默认 seed 出生点 City 中心雨幕半径 18 内 0 个云列 → 地面附近体验不变。
    this.weather = new WeatherState();
    if (this._startWeather) this.weather.force(this._startWeather);
    this.rain = new RainEffect(this.scene, {
      world: this.world,
      playerPos: this.player.physics.pos,
      particleCount: this.rainParticleCount(this.settings.pixelRatio),
    });
    this.rain.setIntensity(this.weather.intensity);

    this._hud = new PerfHUD(this.perf, this._hudRoot,
      DEBUG_FLAGS.worldStats ? () => this.worldStats() : null);
    // M3-4 HUD：坐标+biome、快捷栏（atlas tile CSS 裁剪）、设置面板
    this._coordsHud = new CoordsHUD(this._hudRoot, this);
    // 生命系统显示层（用户 2026-11-05）：
    // ① 玩家血心 —— 10 颗心紧挨性能看板右侧。血量权威在 `player.health`（当前阶段恒满，
    //    掉血逻辑用户后续添加）；血量 → 心形的换算权威在 `player/health.js` 的 `heartsFor()`。
    this._healthHud = new HealthHUD(this._hudRoot, this.player);
    // ② 丧尸/Boss 受击浮动数字 —— DOM 覆盖层（零 draw call），显示「掉血后还剩的血量」。
    //    投影函数在这里注入（本模块 three-free，`src/ui/` 既有口径）。
    //    ⚠️ **必须先判「相机背后」再投影**：`Vector3.project()` 对背后的点会除以负 w，
    //    得到镜像到屏幕内的假坐标（形态：数字出现在身后实体的镜像位置）。
    //    three 相机看 −Z ⇒ 相机空间 z ≥ 0 即在背后。复用同一个 scratch Vector3（零分配）。
    const projVec = new THREE.Vector3();
    this._damageNumbers = new DamageNumbers(this._hudRoot, (worldPos) => {
      const cam = this.camera;
      projVec.set(worldPos[0], worldPos[1], worldPos[2]).applyMatrix4(cam.matrixWorldInverse);
      if (projVec.z >= -0.05) return null;
      projVec.set(worldPos[0], worldPos[1], worldPos[2]).project(cam);
      return [
        (projVec.x * 0.5 + 0.5) * window.innerWidth,
        (-projVec.y * 0.5 + 0.5) * window.innerHeight,
      ];
    });
    // 左下角迷你区域地图（v2.8）：玩家恒在中心，底图随位置滚动。
    // 区域判据在 `ui/minimap-regions.js`（纯函数，复用 gen 的既有权威）；本层只管画布与节流。
    // 启动时显式 `redraw()` 一次：`update()` 的时间节流初值是 `-Infinity`，本可以第一帧就画，
    // 但那样「开局地图是否可见」就寄望于一个远处的初值 —— 显式画一次更稳，也方便将来改节流初值。
    this._minimap = new Minimap(this._hudRoot, this);
    // 城市布局此刻已就绪（上面 `structureIndex.waitForRegion(0,0)` 已 await）→ 首帧就能画出城市。
    this._minimap.redraw();
    // 水面倒影常驻调参坞（v3.17，右下角）—— 七个滑块实时生效。
    // 不进设置面板：面板是全屏黑遮罩，开着它根本看不见水面 ⇒ 无法边看边调。
    this._reflectDock = new WaterReflectDock(this._hudRoot, this);
    // v3.16：「这里可以召唤 Boss」常驻提示（用户 2026-11-18）。
    // 判据转调按 B 的同一份权威（`bossMapAt` + `nextSummonableBoss`）⇒ 提示与召唤结果
    // 结构上不会分裂；本层只负责把它接进帧循环。
    //
    // ⚠️ **必须先 `warmBossAnchors(seed)`**：主线程的锚点 memo 与 Worker 的是两份，
    // 未预热时首次远点 `bossMapAt` 实测 **111ms**（computeArenaAnchor 的候选扫描）。
    // 按 B 时那一下没人计较，但提示要每 250ms 跑一次 ⇒ 把这笔一次性成本付在启动期
    //（此处已在等列加载之后，实测共 ~150ms）。预热后最坏 0.13ms / 中位 0.004ms。
    warmBossAnchors(this.seed);
    this._bossHint = new BossHintHUD(this._hudRoot, this);
    // 显式算一次（同迷你地图的 redraw 口径）：不寄望于「首帧恰好跑到节流分支」。
    // 恢复存档时玩家可能直接落在高台地带/围场里 ⇒ 开局就该看得到提示。
    this._bossHint.update(performance.now());
    // 准心配色自适应（v1.64）：按准心背后画面亮度在白色/黑色间切 —— 固定白在雪地/白墙上消失。
    // 挂在 `_hudRoot` 下（与其他 HUD 同层），但**独立于 HUD 的显示/隐藏**：它是准心不是 HUD。
    this.crosshair = new Crosshair(document.body, this);
    // v3.20：Storm Lance 蓄力环。⚠️ **挂 document.body，不是 #crosshair** ——
    // `tests/crosshair.spec.mjs` 钉死准心只有两笔 2px 笔画，往里加子节点会让它红。
    this._chargeRing = new ChargeRing(document.body);
    // v1.26：图标走预生成的 CSS 串（`npm run icons` → assets/icons.json）。
    // 两套尺寸档：hotbar=40px / inventory=32px —— 按显示尺寸烘焙，运行时零缩放。
    // 取代此前的 atlasTiles/atlasSize/tileOfName/atlasUrl 四个参数 + 运行时裁剪数学。
    const iconManifest = await loadIconManifest();
    // M3.1：快捷栏是背包前 HOTBAR_SIZE 格的视图（§4.5.4，v2.96 起 9 格），内容/高亮都读 inventory，
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
    // ⚠️ 构造期已解析过（见构造器），此处保留幂等赋值作兵二。
    this.settings = this.settings || resolveSettings(loadStoredSettings(), new URLSearchParams(location.search));
    this.settingsPanel = new SettingsPanel(this._hudRoot, this, this.settings);
    // 启动应用视觉风格（设置持久化：null=日夜循环，M2-6）
    // ⚠️ 风格已在 `new DayNight({visualStyle})` 构造首帧生效（用户 2026-10-31）；此处只在
    // **面板/持久化的值在 start() 期间被改过**时补一次 —— 未变时不重复 apply（避免无谓的一次全量写入）。
    if (this.settings.visualStyle && this.dayNight._styleOverride !== this.settings.visualStyle) {
      this.setVisualStyle(this.settings.visualStyle);
    }
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
    // 水面倒影开关（v3.17）：`?reflect=0` 时关掉。无条件走一道——把坞的按钮文案与
    // uniform 同步到真实生效值（只写字段不写 uniform 会留下「坞显示已开而实际没倒影」）。
    this.setReflectEnabled(this._reflectOption);
    this._reflectDock?._syncToggle();
    // 启动应用雾色模式（默认**开**，用户 2026-10-25 裁定）。
    // ⚠️ 必须在 sky 就绪之后（此处已是 start() 尾部）；`?skybox=0` 时 sky 为 null → 静默保持关。
    // 两条都要显式走：材质初值 `uFogColorMix` 恒 0（= 关闭，`materials.js` 的 mix 左端），
    // 所以「关」也不是空操作 —— 落到这里才把 uniform 写成 0，与设置面板点击同一路径。
    this.setFogColorEnabled(this.settings.fogColor);
    this.worldReady = true;

    window.addEventListener('resize', () => this._onResize());
    this._onResize();
    // 存档 flush：页面隐藏/退出立即写盘（§4.8）。M5 起实体 snapshot 同步 flush。
    // ⚠️ 玩家位置也在这里补写一次，但它只是**补充** —— CLAUDE.md 已实测 unload 期的
    // IndexedDB 事务常被中止，主保障是帧循环的 5s 节流（`_maybeSavePlayerPos`）。
    window.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this._savePlayerPos();
        this.persistence.flushNow(this.world); this.persistence.flushEntities();
      }
    });
    window.addEventListener('beforeunload', () => {
      this._savePlayerPos();
      this.persistence.flushNow(this.world); this.persistence.flushEntities();
    });

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
      // v2.62：玩家速度（焰魔跳跃劈砍的落点预判用）。**用位置差分实测**，不读
      // `physics.vel` —— `step()` 末尾把 vel.x/z 清零（无惯性手感），读它恒近 0。
      // ⚠️ 首帧 / dt=0 给 `[0,0,0]`（防 NaN 传进 Agent 的预判算式）。
      //
      // ⚠️ **合理性门是必需的**（final review P1-1）：传送路径（`_teleportTo` →
      // `player.spawn`）会让首帧差分出**几万格/秒**的伪速度（例：1200 格 / 0.016s
      // = 75000 格/秒），该值进跳劈预判 ⇒ 落点偏出几万格。`_teleportTo` 里已重置
      // `_prevPlayerPos`，这里是第二道防线：单帧位移超过 `PLAYER_TELEPORT_EPS`
      // 即视为传送 ⇒ 速度给 0。阈值不从 `physics.SPEED` 派生（避免把玩家速度权威
      // 拷进装配层，红线 1），取一个远大于任何合法单帧位移的常数。
      let pvel = [0, 0, 0];
      if (this._prevPlayerPos && dt > 0) {
        const dx = pp.x - this._prevPlayerPos.x;
        const dy = pp.y - this._prevPlayerPos.y;
        const dz = pp.z - this._prevPlayerPos.z;
        // 合法单帧位移上限：玩家 SPEED=8 × dt(≤0.1) = 0.8 格；飞行 16 × 0.1 = 1.6；
        // 矿车相向碰撞回弹实测单帧 ~2 格。取 4 格作为「超过即传送」的阈值。
        if (dx * dx + dy * dy + dz * dz <= 4 * 4) {
          pvel = [dx / dt, dy / dt, dz / dt];
        }
      }
      this._prevPlayerPos = { x: pp.x, y: pp.y, z: pp.z };
      // 矿车帧序：beginFrame 清瞬态（reservations/deferred/抬玩家意图）—— 必须在
      // entities.update 之前（mc-lite 的 frameReservations 同生命周期）
      this.minecarts.beginFrame();
      this.zombies.update(dt, { playerPosition: [pp.x, pp.y, pp.z] });
      // v2.61：焰魔的寻路拍（A\* + 决策），与丧尸同帧序 —— **必须在 entities.update 之前**，
      // 那样 Agent 本帧的移动意图才能读到本帧最新写好的 `state.navDir`。
      // 反序会让它用上帧的方向走一步（形态：长墙拐角晚一拍、看着像抖动）。
      // 内部 20Hz 节流，且只给 `needsPath` 的焰魔真跑 A\* —— 常态开销为零。
      this.ignises?.update(dt, { playerPosition: [pp.x, pp.y, pp.z], nowMs });
      // 守卫的寻路拍（同帧序、同节流口径）
      this.guardians?.update(dt, { playerPosition: [pp.x, pp.y, pp.z], nowMs });
      // ⚠️ **v2.43 起龙不再每帧自动 spawn**（原 `this.dragons.ensure()` 已删）：
      // 龙只在按 B 时召唤（`summonBoss()`）。保留自动生成的形态是「Boss1 已在 → 召唤 Boss2」
      // 永远命中「已在」，而高台地带没有 Boss2 ⇒ B 键对高台地带毫无作用。
      // 矿车 context：minecarts = service（跨车协调），player = 玩家位置（抬起判定）。
      // ⚠️ player 传**位置快照**而非 Player 对象 —— entities/ 是同构层，不得依赖 player/
      // ⚠️ **形状必须是 `{position:[x,y,z]}` 对象，不是裸数组** —— `resolvePlayerBlocking`
      // 读 `player.position`（mc-lite `checkPlayerCollision` 的入参形状）。传裸数组会让它
      // 解构 undefined → 每帧抛 TypeError → 帧循环中断 → **车永远停在起点**（实测：
      // idle 车在步骤①早退不读 player，故只有车真移动时才暴露；单测传对象/null 全绿）。
      // ⚠️ **复用上一行已有的 `pp`** —— 重复 `const pp` 会是 SyntaxError（同一块作用域）。
      this.entities.update(dt, {
        world: this.world, registry: this.registry,
        minecarts: this.minecarts,
        // v2.62：多传 `velocity`（焰魔跳跃劈砍的落点预判）。矿车/丧尸不读它，零影响。
        player: { position: [pp.x, pp.y, pp.z], velocity: pvel },
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
      // v2.44：飞龙火球。先消费龙本帧的开火意图（生成火球实体），再判定已有火球。
      // ⚠️ **顺序是载荷性的**：消费在前 ⇒ 本帧新生成的火球**不**在本帧被判定（它还没推进过，
      // `traveled=0`，判定会拿「步后位置 − direction×stepLen」还原出一条**向后**的线段 →
      // 可能误判命中龙自己脚下的方块）。下一帧 entities.update 推进后才判定，与弹丸同口径。
      this._consumeDragonFireRequests();
      this._updateFireballs(dt);
      // v2.55：焰魔的挥剑命中结算（消费 attackRequest）。
      // 位置与龙的火球无关，但同样必须在 `entities.update` 之后 —— Agent 本帧写入的
      // `attackRequest` 才存在。
      this._consumeIgnisAttackRequests();
      // 守卫的四招命中结算（同口径：必须在 entities.update 之后）
      this._consumeGuardianAttackRequests();
      // v3.04：焰魔砸击特效（地面火焰法阵 / 碎石圆环）。读的是 `attackFxRequest`，
      // 与伤害结算分开 —— 特效不受命中帧的新鲜视线复查影响（原版同口径）。
      this._consumeIgnisFxRequests(nowMs);
      // v2.64：Boss 战音频（BGM 交叉淡化 + 焰魔挥刀/跳跃音 + 飞龙随机吼叫）。
      // ⚠️ **必须在 `entities.update` 之后**（Agent 本帧写入的 mode/leapKind 才存在），
      // 且在 `_consumeIgnisAttackRequests` 之后（两者都读焰魔 state，顺序不影响结果但
      // 放一起便于阅读）。内部零分配门控：没 Boss 时只有两次 count() + 一次布尔判断。
      this._syncBossAudio(nowMs);
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
      // 玩家位置节流落盘（重启后恢复到上次停留的位置；常态成本 = 一次时间比较）
      this._maybeSavePlayerPos(nowMs);
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
      // v2.51：雨声（用户 2026-11-04：「雨声只有在下雨的时候才播放」）。
      // 强度直接当循环音量 → 淡入淡出与天气状态机同步（无雨时 intensity=0 → 停播）。
      this._syncRainSound();
      this._hud.update(nowMs);
      this._coordsHud.update(nowMs);
      // 迷你地图（v2.8）：内部 10Hz / 20Hz 双节流，每帧调用零成本（未到期直接 return）
      this._minimap.update(nowMs);
      // 倒影调参坞的读数（内部 250ms 节流，未到期只有一次时间比较）
      this._reflectDock?.update();
      this._hotbar.update(this.player.hotbarIndex);
      // 玩家血心：血量没变时内部直接 return（当前阶段恒满 → 每帧一次数值比较）
      this._healthHud.update(nowMs);
      // v3.16：Boss 召唤提示（内部 250ms 节流，未到期直接 return = 一次时间比较）。
      // 放在血心之后、实体发布之前：它只读 player.pos 与 entities，与渲染无关。
      this._bossHint.update(nowMs);
      // M5 帧序最后一步：把实体 pose 发布成 scene 节点（scheduler 可能已卸载/恢复实体，
      // 用最新集合 sync，节点数恒等于实体数 —— 生命周期对称）
      this.entityLayer.sync(this.entities.entities());
      // M8 Task 6：弹丸 pose 发布（差集驱动 slot —— 三条回收路径自动覆盖）
      this.projectileRenderer.sync(this.entities.entities());
      // v2.44：火球 pose 发布（同手法；无火球时 visible=false → draw call 归零）。
      // v2.45：传相机四元数（光晕 billboard 朝向）+ nowMs（光晕脉动闪烁）。
      this.fireballRenderer.sync(this.entities.entities(), this.camera.quaternion, nowMs);
      // M6：丧尸六部件实例发布（只读 pose → 位置/朝向 + 步态 + 200ms 红闪）。
      // 传时间戳而非 dt —— renderer 自己算 dt 累积步态相位（mc-lite `_walkTime` 口径）。
      this.zombieRenderer.sync(this.zombies, nowMs);
      // 祭坛飞龙（v2.41）：pose 发布（位置/yaw/bank + 动画采样 + 红闪）。无实体时
      // visible=false → draw call 归零。⚠️ 传 `nowMs`（performance.now 基准，红闪判定）。
      if (this.dragonRenderer) this.dragonRenderer.sync(this.dragons.activeEntities(), nowMs);
      // 焰魔（v2.55）：同口径的 pose 发布（池容量 2，含脚底补偿）
      if (this.ignisRenderer) this.ignisRenderer.sync(this.ignises.activeEntities(), nowMs);
      // 末影守卫：同口径的 pose 发布（池容量 1，含脚底补偿 +1.6243）
      if (this.guardianRenderer) this.guardianRenderer.sync(this.guardians.activeEntities(), nowMs);
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
      // v3.04：焰魔法阵推进（递延点亮 / 自转 / 末段淡出；全部结束后 visible=false）
      this.flameSigil?.update(nowMs);
      // v3.06：焰魔尖刺推进（递延升起 / 保持 / 缩回；全部结束后 visible=false）
      this.spikeFx?.update(nowMs);
      // v3.20：Storm Lance 蓄力环 + 闪电推进。
      // ⚠️ **读 controller 的轻量字段，不调 `weaponDebugState()`** —— 后者是调试 API，
      // 它每帧遍历全部音频计数 Map + 构造两个对象，把它放进帧循环是白付热路径成本（红线 3 精神）。
      // 蓄力进度的唯一权威仍是 controller（`stormChargeProgress`），这里不重算时长。
      {
        const wc = this.player.weaponController;
        const cfg = WEAPONS[WEAPON_IDS.SWORD].stormLance;
        const p = wc.selectedId === WEAPON_IDS.SWORD
          ? stormChargeProgress(wc.novaChargeElapsed, cfg) : 0;
        this._chargeRing?.update(p);
        if (p > 0) {
          const aim = this.player._buildAim();
          const axis = stormLanceAxis(aim, cfg);
          this.stormLance.setCharge(p, axis.origin, axis.side, nowMs, this.camera.quaternion);
        } else {
          this.stormLance.setCharge(0, null, null, nowMs);
        }
        this.stormLance.update(nowMs, dt);
      }
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
      // 水面倒影（v3.17）：**必须在主 render 之前** —— 后置会让 BatchedMesh 的
      // indirect 索引表被反射相机覆写 → 天空整片撕成黑多边形（详见 ocean.js 反射段）。
      this._renderWaterReflection();
      this.renderer.render(this.scene, this.camera);
      // 准心配色（v1.64）：**必须在 render 之后** —— WebGPU canvas 在 render 前不可读
      // （实测读到恒为 0，会让准心永远判为暗背景而恒白）。内部 100ms 节流 + 迟滞。
      this.crosshair.update(nowMs);
      // 丧尸/Boss 受击浮动数字（生命系统显示层）。
      // ⚠️ **必须在 render 之后**（与准心同一理由，但成因不同）：投影读
      // `camera.matrixWorldInverse`，而它由 `renderer.render()` 每帧重算 —— 在 render 之前
      // 读到的是上一帧的矩阵，数字会滞后一帧（龙飞 9 格/秒时肉眼可见地甩在身后）。
      this._damageNumbers.update(nowMs);
      // info 在每帧 render 前被 autoReset 清零，render 后捕获才是本帧真实值
      // （HUD/测试异步读取 renderer.info 会撞上重置点，必须在此快照）
      this._lastRenderInfo = {
        drawCalls: this.renderer.info.render.drawCalls,
        triangles: this.renderer.info.render.triangles,
      };
    });
  }

  /**
   * 等某个 column 加载完（GEN 完成）。
   *
   * ⚠️ **`driveX/driveZ` 是调度中心，不能省**（v1.92 实测踩坑）：原来的实现固定用
   * `this.spawnX/spawnZ` 驱动 `scheduler.update` —— 那对出生点是正确的（启动时帧循环
   * 还没跑，必须手动驱动），但**瞬移场景下目标是 1200 格外**，调度中心仍在出生点 →
   * 目标 column 永远不进加载半径 → 30 秒后抛 `spawn column timeout`
   * （实测瞬移按钮完全没反应，且 async 回调的异常被吞掉，toast 一个字都没有）。
   *
   * 默认值仍是出生点：既有调用方（`start()`）的行为逐位不变。
   *
   * @param {number} cx @param {number} cz 目标 column 坐标
   * @param {number} timeoutMs
   * @param {number} [driveX] 调度中心 x（缺省 = 出生点）
   * @param {number} [driveZ] 调度中心 z
   */
  _waitForColumn(cx, cz, driveX, driveZ) {
    const dx = driveX ?? this.spawnX, dz = driveZ ?? this.spawnZ;
    return new Promise((resolve) => {
      // 进展基线：**真的多了一列**才算进展（不是「GEN 在途」）
      let lastReady = this.world.columns.size;
      const timer = setInterval(() => {
        const nowReady = this.world.columns.size;
        if (nowReady > lastReady) { lastReady = nowReady; this._watchdog?.notifyProgress(); }
        if (this.world.hasColumn(cx, cz)) { clearInterval(timer); resolve(); return; }
        const verdict = this._watchdog ? this._watchdog.poll() : 'ok';
        // 零进展只通知 UI（弹诊断面板 + 自救按钮），**不中断等待**。
        // 旧实现在这里 reject(`column (...) 加载超时`) —— 实测慢网络下 worker 首个回包要
        // 90.9 秒，而预算 10 秒，于是「网络慢」被误报成「初始化失败」，游戏根本起不来。
        if ((verdict === 'stall' || verdict === 'hard-cap') && this.onLoadStalled) this.onLoadStalled(verdict);
        // 布局门控后 GEN 需后续帧驱动（启动期动画循环尚未启动；瞬移期目标远离玩家，
        // 也必须把调度中心推到目标附近，否则它永远不进入加载半径）
        this.scheduler.update(dx, dz);
      }, 50);
    });
  }

  /**
   * 带硬超时的 `_waitForColumn`：**只给「恢复位置」那条路径用**。
   *
   * 恢复位置与出生点是两种语义（不要合并）：
   *   · 出生点**必须到** —— 等多久都认，零进展只提示（玩家长时间等也比进不去好）；
   *   · 恢复位置去不了就**回落 City 出生点** —— 它已有 `try/catch` 兜底，无限等会让玩家
   *     卡在 loading 里永远进不去（这正是 v1.92 修过的形态）。
   *
   * @param {number} cx @param {number} cz @param {number} timeoutMs
   * @param {number} [driveX] @param {number} [driveZ]
   */
  _waitForColumnOrTimeout(cx, cz, timeoutMs, driveX, driveZ) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`恢复位置 column (${cx},${cz}) ${timeoutMs}ms 内未就绪`)),
        timeoutMs,
      );
      this._waitForColumn(cx, cz, driveX, driveZ).then(() => { clearTimeout(t); resolve(); });
    });
  }

  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    // 分辨率档位（v2.27）：setSize 只改尺寸、不改像素比 —— 但浏览器缩放/跨屏拖动时
    // `devicePixelRatio` 会变，而清晰档的像素比是它的**值**（不是固定 1）。不减不行：
    // 拖动窗口到不同 DPI 的屏幕上时，画面会一下变糊/变锐，而面板按钮显示的仍是「清晰」。
    // ⚠️ **走 `_applyPixelRatio()` 这个唯一入口**，不在这里直调 `renderer.setPixelRatio` ——
    // 两份写入点会造成真回归（实测负向验证时发现）：`start()` 先调 `setPixelRatioMode()`
    // 应用存档档位，紧接着 `_onResize()` 用旧的直调写法把它的效果**覆盖**掉 →
    // 「删掉 `setPixelRatioMode` 里的 renderer 调用」这个缺陷会被 `_onResize` 遮住（用例仍绿）。
    // 雨滴数不在这里重建（窗口缩放不改变档位，重建雨幕只是白白换一次几何）。
    this._applyPixelRatio(this.settings.pixelRatio);
  }

  /**
   * 像素比的**唯一写入点**（v2.27）：档位 × `devicePixelRatio` → `renderer.setPixelRatio()`。
   * 三处调用方：`start()`（应用生效设置）、`_onResize()`（dpr 变了要重算）、
   * `setPixelRatioMode()`（玩家切档）。**不得在其他地方直调 `renderer.setPixelRatio`** ——
   * 两份写入点会互相覆盖，且会让「哪一处写错了」变得无法从行为上判断。
   * @param {'sharp'|'performance'} mode @returns {number} 实际生效像素比
   */
  _applyPixelRatio(mode) {
    const ratio = pixelRatioFor(normPixelRatioMode(mode), window.devicePixelRatio);
    this.renderer.setPixelRatio(ratio);
    return ratio;
  }

  /**
   * 切换渲染分辨率档位（v2.27 设置面板「分辨率」行：清晰 / 性能）。
   *
   * ## 为什么这个开关**不重载页面**（与视距/画质刻意不同）
   *
   * `applyViewDistance` 与 `setBlurQuality` 都必须 `location.assign` 重载：前者要重建
   * `BatchedMesh`（maxInstances 构造期固定）、后者要重建 mip 链（在纹理创建期决定）。
   * 而像素比只是 drawing buffer 的物理尺寸 —— `renderer.setPixelRatio()` 会自己
   * `setSize(w, h, false)` 重建 canvas 后备缓冲（`three.webgpu.js:59017`）。
   * 重载反而是错的：它会把世界、实体、编辑、雨幕全部重建一遍（数秒）。
   *
   * ## 雨滴联动（对齐 mc-lite `refreshRainQualityIfNeeded()`）
   *
   * mc-lite 切分辨率时重建雨效，按档位选雨滴数（性能档 120 / 清晰档 267）。
   * ⚠️ **档位判据用 `mode` 而不是算出来的像素比**：本仓性能档在 Retina 屏（dpr=2）上
   * 像素比是 1.0，拿绝对像素比查表（mc-lite 的 `scale ≤ 0.4` 那种）会落回满雨滴档 →
   * 静默不联动。雨滴数是 `BufferGeometry` 的顶点数，构造期固定，故只能 dispose 重建。
   *
   * @param {'sharp'|'performance'} mode
   * @returns {'sharp'|'performance'} 实际生效的档位（非法值回落默认档）
   */
  setPixelRatioMode(mode) {
    const m = normPixelRatioMode(mode);
    this._applyPixelRatio(m);
    this._rebuildRain(m);
    return m;
  }

  /** 当前实际生效的渲染像素比（E2E 断言用；与 `renderer.getPixelRatio()` 同源） */
  get pixelRatio() { return this.renderer.getPixelRatio(); }

  /**
   * 按分辨率档重建雨效（雨滴数在 `BufferGeometry` 构造期固定）。
   * 无雨/无 rain 实例时也安全：只是重建一个不可见的雨幕，不产生任何画面/性能影响。
   * @param {'sharp'|'performance'} mode
   */
  _rebuildRain(mode) {
    if (!this.rain || !this.scene) return;
    this.rain.dispose();
    this.rain = new RainEffect(this.scene, {
      world: this.world,
      playerPos: this.player.physics.pos,
      particleCount: this.rainParticleCount(mode),
    });
    this.rain.setIntensity(this.weather.intensity);
  }

  /** 档位 → 雨滴数（唯一权威 = `RAIN` 常量，见 `render/weather.js`） */
  rainParticleCount(mode) {
    return normPixelRatioMode(mode) === 'performance'
      ? RAIN.PARTICLE_COUNT_PERFORMANCE
      : RAIN.PARTICLE_COUNT;
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
   * 水面倒影的反射 pass（v3.17）—— **主 `renderer.render()` 之前的唯一调用点**。
   *
   * ## 为什么在这里而不是让节点自动触发
   * 见 `ocean.js` 反射段的载荷性约束：reflector 自动触发时会在 transparent 队列末尾跑，
   * 而 BatchedMesh 的 instance 索引走 GPU 纹理、一帧内最后一次写入胜出 ⇒ 主画面天空被撕碎。
   *
   * ## 三道成本门（用户口径「几乎不影响性能」）
   *   ① **开关**：`?reflect=0` / 面板关掉 → 直接 return（零开销）；
   *   ② **可见性**：相机在水下 / 抬头看天 → 跳过（`reflectVisible`，纯函数可单测）；
   *   ③ **节流**：每 N 帧刷一次（`ReflectScheduler`）—— 这是成本主杠杆，
   *      实测 vd16 每帧 +0.93ms → 每 2 帧 +0.36ms。
   *
   * ⚠️ **第一人称手臂/武器必须临时隐身**：它们挂在 camera 下，反射用的是镜像虚拟相机
   * ⇒ 不藏的话水里会出现一条巨大手臂倒影。恢复在 `ocean.renderReflection` 的 finally 里。
   */
  _renderWaterReflection() {
    if (!this._reflectEnabled || !this.ocean || !this.player) return;
    const cam = this.camera;
    // 前向 y 分量：与 `player.js` 的相机姿态同口径（局部 −Z 经 camera 世界旋转）。
    // ⚠️ 用 `getWorldDirection` 而不是读 `camera.rotation.x`：后者在 yaw=π 时是等价表示，
    // 直读 pitch 会得出反向结论（AGENTS.md 已记的「判相机歪头读基向量」同一条教训）。
    const fwd = this._reflectForward || (this._reflectForward = new THREE.Vector3());
    cam.getWorldDirection(fwd);
    const halfFov = (cam.fov * Math.PI / 180) / 2;
    const visible = reflectVisible(cam.position.y, WATER_LEVEL_OFFSET, fwd.y, halfFov);
    // 高度衰减（v3.17b）—— **兼任性能门**：飞到 REFLECT_HEIGHT_ZERO 之上时 fade=0，
    // 此时整个反射 pass 不跑（而不是「跑了再把强度乘 0」—— 后者白付全部成本）。
    // ⚠️ **uniform 必须先写再判门**：否则飞高时 uniform 停在旧值（比如 0.6），
    // 水面仍混着 60% 的**旧 RT**（冻在低空那一帧的画面）—— 比「倒影不衰减」更坏。
    const fade = reflectHeightFade(cam.position.y, WATER_LEVEL_OFFSET,
      this._reflectHeightFull, this._reflectHeightZero);
    if (this.ocean.uReflectHeightFade) this.ocean.uReflectHeightFade.value = fade;
    if (!this.reflectScheduler.tick(visible && fade > 0.001)) return;
    const hidden = this._reflectHidden || (this._reflectHidden = []);
    hidden.length = 0;
    if (this.viewArm?.mesh) hidden.push(this.viewArm.mesh);
    if (this.viewWeapon?.node) hidden.push(this.viewWeapon.node);
    // v3.20：闪电的七个 mesh 也隐掉 —— 反射 pass 的成本主杠杆是 draw call 数（v3.17 实测），
    // 多 7 个是白付；且 additive 特效在镜像相机下的观感未标定。与第一人称物件同手法。
    if (this.stormLance) hidden.push(...this.stormLance.meshes);
    this.ocean.renderReflection(cam, this.ocean.plane.material, hidden);
  }

  /**
   * 水面倒影开关（面板与 `?reflect=0|1` 共用此入口）。
   *
   * 关掉时把混合强度置 0 → 水面颜色**逐位**回到无倒影的原式（mix 取左端），
   * 而不是只停掉 pass 却留着上一帧的旧 RT（那会让倒影冻在旧画面上）。
   * @param {boolean} enabled @returns {boolean} 实际生效值
   */
  setReflectEnabled(enabled) {
    this._reflectEnabled = !!enabled;
    const u = this.ocean?.uReflectStrength;
    if (u) u.value = this._reflectEnabled ? this._reflectStrength : 0;
    // 重新打开时强制下一帧刷新，避免显示关闭前的旧倒影
    if (this._reflectEnabled) this.reflectScheduler.invalidate();
    return this._reflectEnabled;
  }

  /** 倒影强度（0~1）。关闭状态下只存值不写 uniform（否则会把倒影偷偷打开）。 */
  setReflectStrength(v) {
    const n = Number(v);
    this._reflectStrength = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : REFLECT_STRENGTH;
    if (this._reflectEnabled && this.ocean?.uReflectStrength) {
      this.ocean.uReflectStrength.value = this._reflectStrength;
    }
    return this._reflectStrength;
  }

  /** 随波扰动幅度（0~0.08）。 */
  setReflectDistort(v) {
    const n = Number(v);
    const d = Number.isFinite(n) ? Math.max(0, Math.min(0.08, n)) : REFLECT_DISTORT;
    if (this.ocean?.uReflectDistort) this.ocean.uReflectDistort.value = d;
    return d;
  }

  /** 倒影朦胧度（mip 级别 0~4）。 */
  setReflectBlur(v) {
    const n = Math.round(Number(v));
    const b = Number.isFinite(n) ? Math.max(0, Math.min(4, n)) : REFLECT_MIP_LEVEL;
    if (this.ocean?.uReflectMip) this.ocean.uReflectMip.value = b;
    return b;
  }

  /** 倒影刷新节奏（每 N 帧）。 */
  setReflectEvery(v) {
    this.reflectScheduler.setEvery(v);
    this.reflectScheduler.invalidate();
    return this.reflectScheduler.every;
  }

  /**
   * 倒影开始衰减的高度（格，相对水面）。与归零高度互相钳制，
   * 保证 `full < zero`（否则 smoothstep 两个边界重合 → 除零）。
   * @returns {number} 实际生效值
   */
  setReflectHeightFull(v) {
    const n = Number(v);
    const want = Number.isFinite(n) ? Math.max(1, Math.min(200, n)) : REFLECT_HEIGHT_FULL;
    this._reflectHeightFull = Math.min(want, this._reflectHeightZero - 1);
    if (this.ocean?.uReflectHeightFade) this.reflectScheduler.invalidate();
    return this._reflectHeightFull;
  }

  /** 倒影完全消失的高度（格）。超过它反射 pass 整个不跑。 */
  setReflectHeightZero(v) {
    const n = Number(v);
    const want = Number.isFinite(n) ? Math.max(2, Math.min(240, n)) : REFLECT_HEIGHT_ZERO;
    this._reflectHeightZero = Math.max(want, this._reflectHeightFull + 1);
    if (this.ocean?.uReflectHeightFade) this.reflectScheduler.invalidate();
    return this._reflectHeightZero;
  }

  /**
   * 掠射（视角）项权重 0~1。0 = 关掉该项（倒影不随俯仰变）。
   * ⚠️ 改它需重建材质节点（它是编译期常量进了 mix 的左端），故走 uniform 路径。
   */
  setReflectGraze(v) {
    const n = Number(v);
    const g = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : REFLECT_GRAZE;
    if (this.ocean?.uReflectGraze) this.ocean.uReflectGraze.value = g;
    return g;
  }

  /**
   * 反射 RT 分辨率倍率（0.1~1）。**不是性能旋钮**（实测 0.125 与 0.5 只差 0.1ms），
   * 它改的是显存与倒影锐度。改完强制下一帧刷新（RT 要重建）。
   */
  setReflectScale(v) {
    const s = this.ocean?.setReflectScale ? this.ocean.setReflectScale(v) : REFLECT_RESOLUTION_SCALE;
    this.reflectScheduler.invalidate();
    return s;
  }

  /**
   * 倒影反射率（0.1~1）—— 水面吸收。1 = 理想镜面（会把水面抬到天空亮度）。
   * 与强度是两个独立自由度：降它保留倒影形体、只压亮度。
   */
  setReflectTint(v) {
    const n = Number(v);
    const t = Number.isFinite(n) ? Math.max(0.1, Math.min(1, n)) : REFLECT_TINT;
    if (this.ocean?.uReflectTint) this.ocean.uReflectTint.value = t;
    return t;
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

  // ==================== 瞬移（设置面板「瞬移」行，v1.92） ====================
  //
  // 四个入口的**唯一权威都在本类**（面板只做 DOM 与文案，不碰 world/player）—— 与
  // `setMusicEnabled` 同一手法：面板拿不到世界数据，散落进去就会逼它 import voxel/gen 层，
  // 违反依赖方向（§3）。

  /**
   * 瞬移到**最近的高台地带边缘**（设置面板「高台地带」按钮）。
   *
   * ## 落点为什么是「边缘」而不是圆心
   *
   * 用户 2026-10-29 裁定：「传送到高台地带的边缘处」。圆心是冰面 + 紫晶柱内环，
   * 传送进去会**埋在结构里**（紫晶柱内环半径 20，圆心正中就是柱群）；边缘在缓坡上，
   * 一睁眼就能看见整片地带，也方便直接往里走。
   *
   * ## y 用真实方块高度，不用 `findSpawnY`
   *
   * `findSpawnY` 从世界顶向下扫**第一个非空方块**，会把地带的巨型云（y∈[54,95]）当地面
   * —— 实测那是既有坑（CLAUDE.md「findSpawnY 会把空中结构当出生点」）。这里从 `plateauY`
   * 向上扫到第一个「脚下实心且自身与头顶都是空气」的格，云层天然被排除。
   * ⚠️ **v1.96 起 cloud 是 `solid:true`**，旧理由「云 `solid=0`」已失效 —— 真正的判据是
   * 「自身与头顶都是空气」：云块本身占格，露天的云顶格上方才是空气，所以逐列扫描时云
   * **不会**成为落点。行为零变化（`tarn-zone.spec` 把 cloud 列入 `SLOPE_NON_SURFACE`，同口径）。
   *
   * ## 传送后不等 column
   *
   * `player.spawn` 只改 `physics.pos`，渲染/调度由帧循环的 `scheduler.update(playerX, playerZ)`
   * 自动跟上（同 `spawn` 的既有路径）。远处目标会先看到天空再逐片长出地形 —— 这与
   * 玩家自己飞过去时完全一致，不必另建等待逻辑。
   *
   * @returns {{ok: true, x: number, y: number, z: number, dist: number} | {ok: false, reason: string}}
   */
  teleportToTarnZone() {
    const p = this.player?.physics?.pos;
    if (!p) return { ok: false, reason: 'no-player' };
    const found = findNearestTarnZone(p.x, p.z, this.seed);
    if (!found) return { ok: false, reason: 'not-found' };
    const lay = computeTarnZone(found.regionX, found.regionZ, this.seed);
    if (!lay) return { ok: false, reason: 'not-found' };

    // 落点 = 平台外缘再往外 TARN_TELEPORT_MARGIN 格（落在缓坡带上，看得见整片地带）。
    // ⚠️ 方向从圆心指向玩家：玩家是从自己这一侧过来的，落在近端边缘而不是绕到对面。
    const dx = p.x - lay.cx, dz = p.z - lay.cz;
    const len = Math.hypot(dx, dz) || 1;
    const r = lay.platformRadius + TARN_TELEPORT_MARGIN;
    const x = Math.round(lay.cx + (dx / len) * r);
    const z = Math.round(lay.cz + (dz / len) * r);

    // y 用**纯函数**算，不等 column 加载（见下面 `_teleportTo` 的说明）。
    const y = tarnSurfaceYAt(x, z, this.seed, lay) + 1; // +1 = 地表方块之上那一格（脚底）
    this._teleportTo(x, y, z);
    return { ok: true, kind: 'tarn', x, y, z, dist: Math.round(found.dist) };
  }

  /**
   * 传送的**唯一落地实现**（五个入口共用，红线 1）。
   *
   * ## 为什么不等目标 column 加载
   *
   * 第一版写成 `await _waitForColumn(...)` 再扫真实地表高度，**实测不可行**：
   * `_waitForColumn` 靠手动驱动 `scheduler.update` 逼 GEN，而 vd=2 时加载半径只有
   * 48 格 —— 目标在 1200 格外永远进不了半径 → 30 秒后抛超时，且 async 面板回调把异常
   * 吞掉，玩家看到的是「按钮完全没反应」（toast 一个字都没有）。
   * 把调度中心推过去也一样：那等于要求「在 tick 之外把整片目标区域加载完」，
   * 1500+ column 的 GEN 是秒级操作，面板点击不该阻塞那么久。
   *
   * ## 正确做法
   *
   * ① 高度用**纯函数**算（`tarnSurfaceYAt` 与地形生成同一份公式；标记位置直接存玩家踩过
   *    的 y），不依赖 column 是否已加载；
   * ② `player.spawn` 只改物理坐标，**不判断脚下有没有方块**；
   * ③ 传送后帧循环的 `scheduler.update(playerX, playerZ)` 自动把调度中心移过去，
   *    目标区域逐片加载 —— 与玩家自己飞过去时完全一致，没有额外的等待逻辑。
   * ④ 加载完成前玩家可能短暂悬空（下方是空气），由物理每帧重力拉落；`fillTarnPlateau`
   *    生成的地表一旦上传就站稳。
   *
   * @param {number} x @param {number} y @param {number} z
   */
  _teleportTo(x, y, z) {
    this.player.spawn(x, y, z);
    // v2.62：传送后位置突变，重置玩家速度差分的基准 —— 否则下一帧会算出
    // 「新pos − 旧pos」的伪速度（可达几万格/秒）传进焰魔跳劈预判（final review P1-1）。
    this._prevPlayerPos = null;
    // 解卡（近处传送）：目标 column 已加载时，落点可能已被地形/结构埋住 → 当场抬出来。
    // 远处传送此刻读到的全是空气（column 未加载），这里是 no-op，由 `onColumnReady`
    // 的那一次接管（见 `_resolvePlayerStuck`）。
    this._resolvePlayerStuck();
    // 传送后位置突变，不能等帧循环的 5s 节流 —— 否则「传送完立刻关页」会回到传送前的位置。
    this._savePlayerPos();
    // 把调度中心立刻推到目标：帧循环下一帧就会用它（`scheduler.update(playerX, playerZ)`
    // 本来每帧都读玩家位置，这里只是让**本帧剩余时间**就开始朝目标 GEN，省 16ms）。
    this.scheduler.update(x, z);
  }

  /**
   * 玩家被埋进方块时向上解卡（**唯一入口**，三个触发点共用）。
   *
   * ## 为什么需要（根因）
   *
   * `_teleportTo()` 刻意不等目标 column 加载 → 传送当帧目标区域全是未加载 column，
   * `getBlockId` 对缺失 column 返回 0（空气）→ 玩家悬空、重力一路拉到世界底；随后 column
   * GEN 完成，`fillColumn` 的「底部补实」把 `WORLD_MIN_Y` 到地表之间全填成 stone →
   * **玩家 AABB 整个埋在实心石头里**，而 `_moveAxis` 碰撞后二分回退到零位移并清零 `vel`
   * → 水平与竖直全部冻结（用户 2026-10-31 报告的「瞬移完卡在地底下动弹不得」）。
   *
   * ## 三个触发点（不放帧循环）
   *
   * ① `onColumnReady` —— **主根因的修复点**：传送/出生后目标 column 加载完成的那一刻；
   *    也覆盖「column 卸载重载后结构覆盖玩家」。
   * ② `_teleportTo` —— 近处传送（目标 column 已加载）。
   * ③ `start()` 的 `player.spawn` 之后 —— 恢复的位置被埋。
   *
   * 刻意**不**放帧循环：那里每帧跑会与矿车的 `pendingPlayerLift`（帧内把玩家顶到车顶）
   * 抢写 `pos.y`，而三个事件触发点已覆盖全部被埋路径。
   *
   * @param {import('../voxel/chunk-column.js').ChunkColumn} [column] 传入时先做「该 column 是否与
   *        玩家 AABB 覆盖的 column 范围相交」的门控 —— 远处 column 加载不该付这份钱
   *        （一帧可能有几十个 column ready）。
   * @returns {number} 实际抬升格数（0 = 没被埋 / 门控拦下 / 乘坐中）
   */
  _resolvePlayerStuck(column) {
    const physics = this.player?.physics;
    if (!physics) return 0;
    // 乘坐矿车期间位置由矿车锁定（`_updateMinecartRiding` 写 `pos.y = 车顶`），不得抢写 ——
    // 抢写会把乘客从车上抬走，下一帧又被锁回来（抖动）。
    if (this.player.ridingMinecartId) return 0;
    if (column) {
      // 相交判据走 `physics.aabb()`（PLAYER_WIDTH 的单一权威派生），不写 0.3 字面量副本。
      const b = physics.aabb();
      const cx0 = Math.floor(b.minX / 16), cx1 = Math.floor(b.maxX / 16);
      const cz0 = Math.floor(b.minZ / 16), cz1 = Math.floor(b.maxZ / 16);
      if (column.cx < cx0 || column.cx > cx1 || column.cz < cz0 || column.cz > cz1) return 0;
    }
    return physics.resolveStuck();
  }

  /**
   * 把玩家当前位置写进存档 meta（**唯一写入点**，三个调用方：帧循环节流 / 传送 / 页面隐藏退出）。
   *
   * ## `_lastSavedPos === null` 意味着「位置写盘未启用」
   *
   * 两个时机它是 null：① `start()` 还没跑到 `player.spawn`（Player 未构造）；
   * ② `_discardEdits()` 刚丢弃了玩家改动（换世界 / 删缓存 / 导入进度）。
   * ② 是**载荷性的**：那三条路径都用 `saveMeta` 整行 put（不含 playerPos）把旧位置作废，
   * 而随后的 `location.assign/reload` 会触发 `beforeunload` → 本方法。不拦的话旧世界的
   * 坐标会被写回新世界的 meta（新 seed 下那个坐标的地形完全不同）。同 CLAUDE.md 已记的
   * 「禁止只清 IndexedDB 不清内存 —— 残留会在任何来得及提交的时机写回」同一类竞态。
   *
   * 非有限数一律不写 —— 写 NaN 进存档会让下次启动读到非法位置（与 `teleportToSpawn` 的
   * 同一防御口径）。启动时读回的校验在 `validPlayerPos()`。
   */
  _savePlayerPos() {
    if (!this._lastSavedPos) return;   // 写盘未启用（见上）
    const p = this.player?.physics?.pos;
    if (!p || ![p.x, p.y, p.z].every((v) => Number.isFinite(v))) return;
    this._lastSavedPos = { x: p.x, y: p.y, z: p.z };
    this._lastSavedPosAt = performance.now();
    this.persistence.savePlayerPos([p.x, p.y, p.z]);
  }

  /**
   * 帧循环节流写盘：距上次写入 ≥ `PLAYER_POS_SAVE_INTERVAL_MS` **且** 移动 ≥
   * `PLAYER_POS_SAVE_MIN_MOVE` 格才写。
   *
   * 常态成本 = 一次时间比较（未到期直接 return）；到期后再做三次减法。静止时零写入、
   * 零 IndexedDB 事务（用户要求「不要影响性能」的落点）。
   *
   * ⚠️ 基线 `_lastSavedPos` 在 `start()` 里初始化（不写盘 —— 启动时读的就是存档里的值，
   * 写回去是冗余事务）；为 null 时直接返回，不得凭空写一次。
   * @param {number} nowMs 帧循环的 `performance.now()` 基准时间戳
   */
  _maybeSavePlayerPos(nowMs) {
    const last = this._lastSavedPos;
    if (!last) return;
    if (nowMs - this._lastSavedPosAt < PLAYER_POS_SAVE_INTERVAL_MS) return;
    const p = this.player.physics.pos;
    const dx = p.x - last.x, dy = p.y - last.y, dz = p.z - last.z;
    const min = PLAYER_POS_SAVE_MIN_MOVE;
    if (dx * dx + dy * dy + dz * dz < min * min) return;
    this._savePlayerPos();
  }

  /**
   * 记录当前玩家位置为「标记」（设置面板「标记位置」按钮）。
   *
   * 持久化到 localStorage（用户 2026-10-29 裁定「跨会话保留」），**不进设置对象** ——
   * 它不是一个「配置」，不参与 URL 覆盖、不进 `settingsVersion` 迁移。用独立 key。
   *
   * @returns {{ok: true, x: number, y: number, z: number} | {ok: false, reason: string}}
   */
  markPosition() {
    const p = this.player?.physics?.pos;
    if (!p) return { ok: false, reason: 'no-player' };
    const mark = { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
    try {
      localStorage.setItem(MARK_KEY, JSON.stringify(mark));
    } catch { /* 私密模式配额失败：内存里也记一份，本次会话仍可用 */ }
    this._markCache = mark;
    return { ok: true, kind: 'mark', ...mark };
  }

  /**
   * 瞬移到已记录的位置（设置面板「跳转」按钮）。
   *
   * ⚠️ **没有标记时不做任何事**（不传送、不改玩家状态），只返回 reason —— 传送到 (0,0)
   * 之类的兜底会让玩家莫名其妙被扔到出生点附近。
   *
   * @returns {{ok: true, x: number, y: number, z: number} | {ok: false, reason: string}}
   */
  teleportToMark() {
    const p = this.player?.physics?.pos;
    if (!p) return { ok: false, reason: 'no-player' };
    const mark = this.markedPosition();
    if (!mark) return { ok: false, reason: 'no-mark' };
    // y 用存档里的值（标记时玩家就站在那儿，比重新扫地表更忠实于「我刚站过的地方」），
    // 也因此不需要等目标 column 加载。
    this._teleportTo(mark.x, mark.y, mark.z);
    return { ok: true, kind: 'mark-go', ...mark };
  }

  /**
   * 回到出生点（设置面板「回家」按钮，v1.97）。
   *
   * 出生点 = `this.spawnX/spawnY/spawnZ`：启动期从 `getCitySpawnPoint(city)` 取 x/z、
   * `findSpawnY` 取 y（当时出生 column 已 `_waitForColumn` 完，横扫到的就是真实地表）。
   *
   * ## y 用启动时缓存的 spawnY，不在点击时重扫
   *
   * 点击时玩家可能在 1200 格外，出生 column 早已被卸载、世界里读到全是空气 ——
   * 此时 `findSpawnY` 会一路扫到兜底 `SEA_Y + 2`，把玩家传到半空或水面下。
   * 而缓存值来自「column 已加载」的启动期，与 `player.spawn(spawnX, spawnY, spawnZ)`
   * 走的是同一份数字（红线 1：出生点只有一份权威，不另建副本）。
   * 与 `teleportToMark` 同理：传送不等目标 column，落地后由帧循环的
   * `scheduler.update(playerX, playerZ)` 逐片加载（见 `_teleportTo`）。
   *
   * @returns {{ok: true, kind: 'spawn', x: number, y: number, z: number} | {ok: false, reason: string}}
   */
  teleportToSpawn() {
    if (!this.player?.physics?.pos) return { ok: false, reason: 'no-player' };
    const { spawnX: x, spawnY: y, spawnZ: z } = this;
    // `findSpawnY` 的兜底、以及 meta/URL 带来的异常值都可能是非有限数 —— 传送到 NaN
    // 会让玩家位置永久坏掉（物理层算不出碰撞），故宁可报错不动玩家。
    if (![x, y, z].every((v) => Number.isFinite(v))) return { ok: false, reason: 'not-found' };
    this._teleportTo(x, y, z);
    return { ok: true, kind: 'spawn', x, y, z };
  }

  /**
   * 瞬移到**围场**（原「小竞技场」= 城门竞技场，设置面板「围场」按钮，v2.10 新增、v2.87 改名）。
   *
   * ⚠️ **术语（用户 2026-11-09 裁定）**：「围场」= 本方法去的城南门外草地竞技场
   * （`gen/structures/arena.js`，41×79）；「竞技场」= 城东沙漠的大竞技场
   * （`burning-arena.js`，85×85×80，见 `teleportToBurningArena`）。两者互不重叠。
   * 方法名 `teleportToArena` **刻意保留**（与 `arena.js` / `computeArenaAnchor` /
   * `btn-teleport-arena` 同一族命名，改名会波及 E2E 与单测的 id/函数名），
   * 只有**玩家可见文案**改成「围场」。
   *
   * 落点 = 围场占地**中心**、y = `anchor.floorY + 1`（脚底踩在地板层上方一格）。
   * 这个 y 口径与 `apply.js` 阶段 2.9 的光栅化落位同源：那里 `rasterizeStructure(... ,
   * floorY - (floorRow - 1), ...)` 让**地板层**正好坐落在 `floorY`，故站在 `floorY + 1`
   * 就是站在场地上（与 `tarn` 的 `tarnSurfaceYAt(...) + 1` 同一手法）。
   *
   * ⚠️ **不与 `computeArenaAnchor` 的缓存脱钩**：那个函数带 64 项 seed 缓存、实测中位 56ms，
   * 每次点击算一次完全可接受 —— 不要为它建第二份落点副本（红线 1）。
   *
   * ⚠️ **没有围场时不做任何事**（`computeArenaAnchor` 在少数 seed 会返回 null ——
   * 南门外 240 格内找不到合法落点），只返回 `no-arena`。
   *
   * ⚠️ **reason 必须与「没找到高台」的 `not-found` 区分开**：两者是完全不同的处境
   * （一个换个 seed 就能碰上、一个得再走远点），合成一句「附近没有」会让玩家走错方向。
   * 面板 `_teleportMessage` 按 reason 逐条映射（v1.92 定的口径）。
   *
   * @returns {{ok: true, kind: 'arena', x: number, y: number, z: number} | {ok: false, reason: string}}
   */
  teleportToArena() {
    if (!this.player?.physics?.pos) return { ok: false, reason: 'no-player' };
    const a = computeArenaAnchor(this.seed);
    if (!a) return { ok: false, reason: 'no-arena' };
    const x = a.wx, z = a.wz, y = a.floorY + 1;
    if (![x, y, z].every((v) => Number.isFinite(v))) return { ok: false, reason: 'no-arena' };
    // 落地后由帧循环的 `scheduler.update(playerX, playerZ)` 逐片加载（同 `_teleportTo` 的说明）。
    this._teleportTo(x, y, z);
    return { ok: true, kind: 'arena', x, y, z };
  }

  /**
   * 瞬移到**大竞技场**（城东沙漠的 burning arena，设置面板「竞技场」按钮，v2.87）。
   *
   * ⚠️ **术语**：「竞技场」= 大竞技场（本方法）；「围场」= 原小竞技场（`teleportToArena`）。
   * 用户 2026-11-09：「原来设置面板中的『竞技场』按钮点击后跳转到现在刚增加的大竞技场，
   * 瞬移到大竞技场边缘的平地的位置」。
   *
   * 落点唯一权威 = `burningArenaTeleportPoint(seed)`（占地西缘外 6 格的沙漠平地，
   * y = 自然地表 + 1）—— 本方法**不复算**任何坐标（红线 1）。
   *
   * ⚠️ **reason 用独立的 `no-burning-arena`**：与围场的 `no-arena` 是两种处境
   * （大竞技场每 seed 必生成，返回 null 只可能是锚点搜索窗内无解），面板逐 reason 映射。
   *
   * @returns {{ok: true, kind: 'burning-arena', x: number, y: number, z: number} | {ok: false, reason: string}}
   */
  teleportToBurningArena() {
    if (!this.player?.physics?.pos) return { ok: false, reason: 'no-player' };
    const p = burningArenaTeleportPoint(this.seed);
    if (!p) return { ok: false, reason: 'no-burning-arena' };
    // 落地后由帧循环的 `scheduler.update(playerX, playerZ)` 逐片加载（同 `_teleportTo` 的说明）。
    this._teleportTo(p.x, p.y, p.z);
    return { ok: true, kind: 'burning-arena', ...p };
  }

  /**
   * 瞬移到**废弃堡垒**（城西干燥沙漠的 ruined citadel，设置面板「堡垒」按钮，v2.89）。
   *
   * ⚠️ **与大竞技场分居 City 两侧**：大竞技场在城东（`teleportToBurningArena`），本结构在城西。
   *
   * 落点唯一权威 = `ruinedCitadelTeleportPoint(seed)`（占地**东缘**外 6 格的沙漠平地，
   * y = 自然地表 + 1）—— 本方法**不复算**任何坐标（红线 1）。
   *
   * ⚠️ **reason 用独立的 `no-ruined-citadel`**：与大竞技场的 `no-burning-arena`、围场的
   * `no-arena` 是三种处境（本结构每 seed 必生成，返回 null 只可能是锚点搜索窗内无解），
   * 面板逐 reason 映射。
   *
   * @returns {{ok: true, kind: 'ruined-citadel', x: number, y: number, z: number} | {ok: false, reason: string}}
   */
  teleportToRuinedCitadel() {
    if (!this.player?.physics?.pos) return { ok: false, reason: 'no-player' };
    const p = ruinedCitadelTeleportPoint(this.seed);
    if (!p) return { ok: false, reason: 'no-ruined-citadel' };
    // 落地后由帧循环的 `scheduler.update(playerX, playerZ)` 逐片加载（同 `_teleportTo` 的说明）。
    this._teleportTo(p.x, p.y, p.z);
    return { ok: true, kind: 'ruined-citadel', ...p };
  }

  /**
   * 瞬移到**丛林要塞**（城西第一个丛林地带的 jungle fortress，面板「要塞」按钮，v3.13）。
   *
   * 落点唯一权威 = `jungleFortressTeleportPoint(seed)`（占地**东缘**外 6 格，
   * y = **整形后**地表 + 1）—— 本方法**不复算**任何坐标（红线 1）。
   *
   * ⚠️ **y 不能用自然高度**：落点在缓坡带内，8/8 seed 自然 h 4~5 而整形后 1~2
   * ⇒ 用自然值会让玩家悬空 2~3 格（判据已在单测里钉住）。
   *
   * ⚠️ **reason 用独立的 `no-jungle-fortress`**：与其余六个入口各自一种处境，面板逐 reason 映射。
   *
   * @returns {{ok: true, kind: 'jungle-fortress', x: number, y: number, z: number} | {ok: false, reason: string}}
   */
  teleportToJungleFortress() {
    if (!this.player?.physics?.pos) return { ok: false, reason: 'no-player' };
    const p = jungleFortressTeleportPoint(this.seed);
    if (!p) return { ok: false, reason: 'no-jungle-fortress' };
    this._teleportTo(p.x, p.y, p.z);
    return { ok: true, kind: 'jungle-fortress', ...p };
  }

  /**
   * 瞬移到浅水高台（设置面板「湖」按钮，v2.19）。
   *
   * 落点 = 湖心**正西（City 那一侧）**的岸边缓坡上（下面说明为什么要在西侧扫一圈方位），
   * 与「高台地带」按钮同一手法：
   * x/z 由现成的纯函数算出，y 由 `shallowTarnSurfaceYAt(...) + 1` 给出（与地形生成同一份公式），
   * 传送当帧不等目标 column 加载（见 `_teleportTo`）。
   *
   * ## 为什么要扫方位而不是死钉「正西」
   *
   * v2.15 的干湿两态会让**整条沙滩带**在「自然地形本身就是水」那一侧沉成水下坡（两侧水面连通）
   * —— 死钉正西时玩家可能落在水下坡上，而用户 2026-10-30 选的是「干燥落地」。
   * 故从正西开始向两侧对称试 `SHALLOW_TARN_SHORE_PROBES` 个方位，取**第一个地表不低于
   * 海平面**的（地表 ≥ `SEA_Y` ⟺ 上方没有水方块，与 `fillColumn` 的水体判据同源）。
   * 全部方位都湿（湖整个泡在海里）时回落正西 —— 按钮永远有反应，不因观感判据失效。
   *
   * ⚠️ **不与 `computeShallowTarnAnchor` 的 seed 缓存脱钩**：每次点击算一次完全可接受，
   * 不要为落点建第二份副本（红线 1）；湖岸半径也只走 `shallowTarnLakeRadiusAt`。
   *
   * ⚠️ **reason 必须是独立的 `no-lake`**：与「附近没有高台地带」的 `not-found` 是两种处境
   * （这个是换个 seed 才有，那个是走远点再试），面板逐 reason 映射（v1.92 口径）。
   *
   * @returns {{ok: true, kind: 'lake', x: number, y: number, z: number} | {ok: false, reason: string}}
   */
  teleportToShallowTarn() {
    if (!this.player?.physics?.pos) return { ok: false, reason: 'no-player' };
    const a = computeShallowTarnAnchor(this.seed);
    if (!a) return { ok: false, reason: 'no-lake' };
    const phase = shallowTarnShapePhase(this.seed);
    const WEST = Math.PI;
    let chosen = null;
    for (let k = 0; k < SHALLOW_TARN_SHORE_PROBES; k++) {
      // 0, +1, −1, +2, −2 … 从正西向两侧对称展开（先近后远，落点尽量贴 City 那一侧）
      const ang = WEST + (k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.ceil(k / 2) * SHALLOW_TARN_SHORE_STEP);
      const r = shallowTarnLakeRadiusAt(ang, phase) + SHALLOW_TARN_TELEPORT_OFFSET;
      const x = Math.round(a.wx + Math.cos(ang) * r);
      const z = Math.round(a.wz + Math.sin(ang) * r);
      const surfaceY = shallowTarnSurfaceYAt(x, z, this.seed, a);
      if (!chosen) chosen = { x, z, surfaceY };      // 兜底 = 正西（全湿时用它）
      if (surfaceY >= SEA_Y) { chosen = { x, z, surfaceY }; break; }
    }
    const { x, z } = chosen;
    const y = chosen.surfaceY + 1;                   // +1 = 地表方块之上那一格（脚底）
    if (![x, y, z].every((v) => Number.isFinite(v))) return { ok: false, reason: 'no-lake' };
    this._teleportTo(x, y, z);
    return { ok: true, kind: 'lake', x, y, z };
  }

  /**
   * 读取已记录的标记（内存优先，回落 localStorage）。
   * @returns {{x: number, y: number, z: number} | null}
   */
  markedPosition() {
    if (this._markCache) return this._markCache;
    let mark = null;
    try {
      const raw = localStorage.getItem(MARK_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      // 只认三个有限数 —— 坏存档（手改/旧版本）不得把玩家传到 NaN
      if (parsed && [parsed.x, parsed.y, parsed.z].every((v) => Number.isFinite(v))) {
        mark = { x: parsed.x, y: parsed.y, z: parsed.z };
      }
    } catch { /* 解析失败按「无标记」处理 */ }
    this._markCache = mark;
    return mark;
  }

  /**
   * 城市布局（region [0,0]，全世界唯一的城市）。
   *
   * **返回 null 表示布局尚未就绪**（启动早期 / fixture 页直建 Game 时）。消费方须容错 ——
   * `biomeAt` 与迷你地图都走这里，**不得各自去解引用 `scheduler.structureIndex._layouts`**
   * （那是对私有字段的重复访问，两个消费方会各写一份 `get('0,0')` 与空值判定）。
   * @returns {Object|null}
   */
  cityLayout() {
    return this.scheduler?.structureIndex?._layouts?.get('0,0')?.city ?? null;
  }

  /** 玩家位置的 biome 名（M3-4 坐标 HUD；CITY 布局边界优先，否则 getBiome 纯函数） */
  biomeAt(x, z) {
    const city = this.cityLayout();
    if (city && getCityInfo(Math.floor(x), Math.floor(z), city)) return 'CITY';
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
    await this.persistence.saveMeta({ seed: newSeed, spawn: [8, 8], blockFp: this.registry.fingerprint(), blockCount: this.registry.count, savedAt: Date.now() });
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
    // 位置写盘一并作废（见 `_savePlayerPos` 的 ②）：调用方随后都会 `saveMeta` 整行 put
    // （不含 playerPos）并导航重载，而 `beforeunload` 会再调一次 `_savePlayerPos` ——
    // 不清基线就会把旧世界的坐标写回新世界。
    this._lastSavedPos = null;
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
    await this.persistence.saveMeta({ seed: decoded.seed, spawn, blockFp: this.registry.fingerprint(), blockCount: this.registry.count, savedAt: Date.now() });
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

  /**
   * 伤害分发器（v2.41 祭坛飞龙，spec §5.3 分叉一方案 A）：按实体类型路由到对应 service。
   *
   * ⚠️ **这是「三处硬编码 zombie」的唯一收敛点**：武器射线（`setEntityQuery.damage`）、
   * 炮塔弹丸（`_updateProjectiles` 的 `onDamage`）都调它。Game 是装配层，依赖任何层合法
   * （§3）—— 不给 M5 EntityManager 加玩法接口（那是纯生命周期容器），也不复用
   * ZombieService 给龙（丧尸的 AI/物理/步态全不适用，开 `if (isDragon)` 分支是 mc-lite
   * 的补丁架构形态，红线 2/4 禁止）。
   *
   * ⚠️ **`this.dragons` 在 `start()` 的 service 装配段创建** → 这里保留 `if (!this.dragons) return null`
   * 守卫作纵深防御（构造器阶段或装配顺序错时不会抛 TypeError）。装配完成后该守卫自然不再触发。
   *
   * @param {string} id @param {number} amount @param {number} nowMs
   * @returns {{dead: boolean, health: number}|null} 未知 id / 不可击中类型返回 null
   */
  damageEntity(id, amount, nowMs) {
    const entity = this.entities.get(id);
    if (!entity) return null;
    let result = null;
    if (entity.type === 'zombie') result = this.zombies.damage(id, amount, nowMs);
    else if (entity.type === DRAGON_TYPE) {
      if (!this.dragons) return null;
      result = this.dragons.damage(id, amount, nowMs);
    } else if (entity.type === IGNIS_TYPE) {
      // v2.55 焰魔：与龙同形状的 damage 契约（红闪 + 死亡即 despawn）
      if (!this.ignises) return null;
      result = this.ignises.damage(id, amount, nowMs);
      // v3.15：焰魔受击音（用户 2026-11-18）。**这里原来一行都没有** ⇒ 焰魔挨枪只有枪声、
      // 没有受击反馈（扣血/红闪/伤害数字全对，纯静默缺陷）。与守卫共用 BOSS_HIT_SOUND。
      if (result && !result.dead) {
        this.audioManager?.play(BOSS_HIT_SOUND, SOUND_VOLUMES[BOSS_HIT_SOUND]);
      }
    } else if (entity.type === GUARDIAN_TYPE) {
      // 末影守卫：同形状契约。v3.15 起受击音与焰魔**统一**为 `BOSS_HIT_SOUND`
      //（原来是守卫专属的 `guardian_hurt`，用户 2026-11-18 裁定统一掉）。
      // 玩家被打仍走 `_damagePlayer` → ignis_hurt，两条路径不混。
      if (!this.guardians) return null;
      result = this.guardians.damage(id, amount, nowMs);
      if (result && !result.dead) {
        this.audioManager?.play(BOSS_HIT_SOUND, SOUND_VOLUMES[BOSS_HIT_SOUND]);
      }
    } else return null;
    // v2.51/v2.64：死亡音效 + 死亡特效。**判断落在 `dead` 上而不是 `amount` 上** ——
    // 打中但没死不该响。音量表在 `audio-config.js`（红线 1，不在装配层写字面量）。
    // ⚠️ TNT 爆炸炸死丧尸走另一条路（`_damageEntitiesInRadius`），那里也要接（同一助手）。
    if (result?.dead) this._onEntityDeath(entity, nowMs);
    // 生命系统显示层：受击后在头顶弹「掉血后还剩的血量」数字。
    // ⚠️ **必须在 `damage()` 之后**（`result.health` 才是掉血后的值），且与死亡音效同位点
    // —— 两条伤害路径（本方法 + `_damageEntitiesInRadius`）都要接，口径一致。
    if (result) this._emitDamageNumber(entity, result.health, nowMs);
    return result;
  }

  /**
   * 击退分发器（v2.65 近战剑）：按实体类型路由到对应 service 的 `knockback()`。
   *
   * 与 `damageEntity()` 同一手法（装配层按类型分发，不给 EntityManager 加玩法接口）。
   *
   * ## 方向在这里算，不在 controller 里
   *
   * controller 只传 `(id, dist)`：它是纯逻辑层，**不持有玩家位置**（依赖方向 §3）。
   * 击退方向 = 「背离玩家」= `normalize(entity.pos - player.pos)` 的水平分量，由本方法用
   * `this.player.physics.pos` 算。
   *
   * ## 退化情形：不猜方向
   *
   * 玩家与实体水平重合（`d < 1e-6`）⇒ 没有可用的「背离玩家」方向。此时**直接返回 false
   * 不击退**，而不是拿 yaw 兜一个方向 —— 两个理由：
   *
   * ① **yaw→前向的口径按实体类型不同**（实测）：丧尸是 `atan2(vx, vz)` ⇒ 前向
   *    `(sin yaw, cos yaw)`；焰魔与飞龙是 `atan2(-dx, -dz)` ⇒ 前向 `(-sin yaw, -cos yaw)`。
   *    在装配层写一张「类型 → 前向公式」表就是红线 1 的第二份权威（那两份公式的权威在
   *    各自的 `zombie-system.js` / `dragon-system.js` / `ignis-boss-agent.js`），且用错一侧的
   *    形态是「Boss 被砍一刀反而扑向玩家」。
   * ② **这个退化态各实体自己已有处理**：焰魔真重叠时走 `overlapEscapeDist` 后退自愈
   *    （v2.62 final review P1-3），丧尸/飞龙则被玩家物理挡住不会真重合。
   *
   * @param {string} id @param {number} dist 击退距离（格，来自 catalog 的 `knockbackDistance`）
   * @returns {boolean} false = 未知 id / 不可击退类型 / 方向退化 / 完全走不动
   */
  knockbackEntity(id, dist) {
    const entity = this.entities.get(id);
    if (!entity) return false;
    const amount = Number.isFinite(dist) ? dist : 0;
    if (!(amount > 0)) return false;
    const [ex, , ez] = entity.state.position;
    const p = this.player?.physics?.pos;
    if (!p) return false;
    const d = Math.hypot(ex - p.x, ez - p.z);
    if (!(d > 1e-6)) return false;   // 方向退化：不猜（见上）
    const dx = ((ex - p.x) / d) * amount;
    const dz = ((ez - p.z) / d) * amount;
    if (entity.type === 'zombie') return this.zombies.knockback(id, dx, dz);
    if (entity.type === IGNIS_TYPE) return this.ignises ? this.ignises.knockback(id, dx, dz) : false;
    if (entity.type === DRAGON_TYPE) return this.dragons ? this.dragons.knockback(id, dx, dz) : false;
    /**
     * 末影守卫：**与焰魔同口径**（用户 2026-11-11 裁定）。
     *
     * ⚠️⚠️ 这里曾经是硬早退 `return false`（v2.91 按原版 `KNOCKBACK_RESISTANCE = 1.0`
     * 判「完全免疫击退」）。已撤销 —— 那条判断把**两件不同的事**混成了一件：
     *
     * · **不动如山**（`guardian-boss-agent.js` 的 `_ringIntent` 死区站定）：玩家贴身推它时
     *   它**不主动退让**。这是每帧的走位策略，与击退无关，本次未碰。
     * · **受击后退**（本方法）：挨了一剑没死就往后退一小步。这是一次性位移反馈 ——
     *   用户要的「回退动作」正是这一条（焰魔 v2.65 的同口径实现）。
     *
     * 原版 `KNOCKBACK_RESISTANCE = 1.0` 指的是**击退附魔/爆炸的位移**（本仓无该机制），
     * 而不是「被剑砍有无受击反馈」—— 后者在焰魔那边已经定为「一律后退一小步」。
     *
     * 服务层 `GuardianService.knockback()` 与渲染层 `GuardianRenderer.noteKnockback()`
     * 早就齐备（v2.91 装配时就接了 `onKnockback` 钩子），只有这一行挡着。
     */
    if (entity.type === GUARDIAN_TYPE) return this.guardians ? this.guardians.knockback(id, dx, dz) : false;
    return false;
  }

  /**
   * 实体死亡时的音效与特效（v2.64，用户 2026-11-07）。
   *
   * **两条伤害路径共用**（`damageEntity` + `_damageEntitiesInRadius`），口径一致。
   *
   * 死亡音**按类型分型**（v2.64 用户裁定：「焰魔死亡的音效 ignis_die.ogg，飞龙的死亡音效
   * 也是 ignis_die.ogg」，丧尸沿用 v2.51 的 `z_die`）：
   *   · zombie → `z_die`（音量 0.3，mc-lite `TurretManager.js:286` 原值）；
   *   · dragon / ignis → `ignis_die`。
   *
   * 死亡特效（用户裁定形态 = 碎块爆散）：在身体中心向全球面撒一簇碎块
   * （`block-hit-fx.spawnDeathBurst`，复用枪击碎块池，不开第二个池）：
   *   · 丧尸 → 绿色（皮肤色）+ `DEATH_BURST` 口径；
   *   · 焰魔 → 火焰色 + `IGNIS_DEATH_BURST` 口径（v2.64b 用户追问后补上：体型更大 ⇒
   *     块更多、块更大、炸得更开）；
   *   · 飞龙本期不做（用户未要求；池子通用，要加是一行调用）。
   *
   * ⚠️ **爆散锚点 = 身体中心**（不是脚底）：丧尸 `position` 是脚底，身体中心 = `y + height/2`。
   * 用脚底会让碎块从地里往上炸（观感是「地面炸了」而不是「身体炸了」）。
   *
   * @param {import('../entities/entity-manager.js').Entity} entity 刚死亡的实体
   * @param {number} nowMs `performance.now()` 基准
   */
  _onEntityDeath(entity, nowMs, { silent = false } = {}) {
    const type = entity.type;
    if (type === 'zombie') {
      // ⚠️ `silent` 是 TNT 半径杀伤路径用的（一发炸死 N 只只响一声，聚合在调用方）；
      // 特效不静默 —— 每只死亡的丧尸都要有自己的碎块爆散。
      if (!silent) this.audioManager?.play('z_die', SOUND_VOLUMES.z_die);
      // 绿色碎块爆散：颜色取丧尸头部皮肤绿（`zombie-model.js` 的唯一权威，不写死字面量）。
      const hex = ZOMBIE_MODEL_DEFS.head.fallbackColor;
      const color = [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
      const [x, y, z] = entity.state.position;
      this.blockHitFx.spawnDeathBurst([x, y + ZOMBIE.height / 2, z], color, nowMs);
    } else if (type === DRAGON_TYPE || type === IGNIS_TYPE) {
      this.audioManager?.play('ignis_die', SOUND_VOLUMES.ignis_die);
      // v2.64b：焰魔死亡碎块爆散（火焰色，Boss 口径）。飞龙不做（用户未要求）。
      // ⚠️ 锚点同丧尸：身体中心（脚底 + height/2），用脚底会读作「地面炸了」。
      if (type === IGNIS_TYPE) {
        const [x, y, z] = entity.state.position;
        this.blockHitFx.spawnDeathBurst(
          [x, y + IGNIS.height / 2, z], IGNIS_DEATH_COLOR, nowMs, { burst: IGNIS_DEATH_BURST },
        );
      }
    } else if (type === GUARDIAN_TYPE) {
      // 守卫：专属死亡音 + 主题紫碎块爆散（眼睛层主色）。
      // ⚠️ 锚点同丧尸/焰魔：**身体中心**（脚底 + height/2），用脚底会读作「地面炸了」。
      this.audioManager?.play('guardian_die', SOUND_VOLUMES.guardian_die);
      const [x, y, z] = entity.state.position;
      this.blockHitFx.spawnDeathBurst(
        [x, y + GUARDIAN.height / 2, z], GUARDIAN_DEATH_COLOR, nowMs, { burst: IGNIS_DEATH_BURST },
      );
    }
  }

  /**
   * 在实体头顶弹出「掉血后还剩的血量」浮动数字（生命系统显示层，用户 2026-11-05）。
   *
   * 显示的是**剩余血量**（不是伤害值）—— 用户明确要「掉血之后还剩的血量」。
   *
   * ⚠️ **锚点 Y 按实体类型取**：丧尸 / 焰魔 `position` 是脚底 → 头顶 = `y + ZOMBIE.height` /
   * `y + IGNIS.height`；龙 `position` 是身体中心 → 头顶 = `y + DRAGON_CORE_OBB.halfExtents[1]`。
   * 常量都从各自 config import，不写字面量（红线 1）。
   *
   * ⚠️ **首帧位置 `initial` 与逐帧 `anchor()` 必须共用同一个 `headY`**（v2.59）：曾经两处各写一份三元式，
   * `anchor()` 漏了焰魔分支 ⇒ 焰魔的数字首帧在头顶（脚底 + 3.25），下一帧就被拉进龙的口径（+1.875，胸口）。
   * 「数字弹出来了、内容也对」的断言抓不到它，只有锚点高度能（`health-hud.spec.mjs` 的 Boss2 用例）。
   *
   * ⚠️ **致命一击也有数字**：实体同帧 despawn，故锚点函数首次调用即返回 null ——
   * 用发射时刻的 `initialPos` 兜底，数字冻结在死亡位置继续上浮淡出。
   *
   * ⚠️ **传 `entity.id` 启用「同实体只显示最新数字」**（用户 2026-11-05 追加）：
   * 机枪连射时每次命中都弹数字，旧的还没淡出会叠在一起不可读 —— 新数字直接顶掉旧的。
   *
   * @param {import('../entities/entity-manager.js').Entity} entity 被击中的实体
   * @param {number} remaining 掉血后的剩余血量
   * @param {number} nowMs
   */
  _emitDamageNumber(entity, remaining, nowMs) {
    if (!this._damageNumbers) return; // 构造期/装配顺序错时的纵深防御
    const state = entity.state;
    const [x, y, z] = state.position;
    // 头顶 y 的唯一权威（`initial` 与逐帧 `anchor` 共用，见上方说明）
    const headY = (t, baseY) => t === 'zombie'
      ? baseY + ZOMBIE.height
      : t === IGNIS_TYPE
        // ⚠️ 焰魔的 `position` 是**脚底**（地面实体）⇒ 头顶 = y + IGNIS.height
        ? baseY + IGNIS.height
        : t === GUARDIAN_TYPE
          // ⚠️ 守卫同理（脚底语义）。**漏这一支会落到飞龙口径**（身体中心 +1.875），
          // 数字飘在胸口而不是头顶（焰魔 v2.59 踩过，health-hud.spec.mjs 有同类用例）。
          ? baseY + GUARDIAN.height
          : baseY + DRAGON_CORE_OBB.halfExtents[1];
    const initial = [x, headY(entity.type, y), z];
    const type = entity.type;
    // ⚠️ **捕获 generation**（红线 7 版本协议在实体侧的对应物）：丧尸 id 从 slot 池复用
    // （`z0`~`z19`），若锚点只按 id 查，旧丧尸的冻结死亡数字会**挂到同 id 重生的新丧尸身上**
    // （形态：新丧尸头顶飘着旧的「0」）。代数不符即返回 null（数字保持冻结）。
    const gen = entity.generation;
    // 锚点函数：实体活着返回头顶世界坐标；已 despawn 返回 null（数字冻结）。
    // ⚠️ 每帧重查 `entities.get(id)` 而不是闭包捕获 state —— state 是逐帧重建的
    // （`createState` 不变式），捕获旧引用会读到过期的 position。
    const anchor = () => {
      const e = this.entities.get(entity.id);
      if (!e || e.type !== type || e.generation !== gen) return null;
      const [ex, ey, ez] = e.state.position;
      return [ex, headY(type, ey), ez];
    };
    this._damageNumbers.spawn(
      String(Math.max(0, Math.round(remaining))), anchor, initial, nowMs, entity.id,
    );
  }

  // ---- v2.43 Boss 召唤（按 B）----

  /**
   * 按 B 召唤玩家所在地图的 Boss（v2.43）。
   *
   * 流程（`boss-registry.js` 文件头）：定位地图 → 查名册 → 按 slot 升序找第一个空槽 →
   * 在地图中心召唤；全占着 → 提示「Boss 都在了」。
   *
   * ⚠️ **本方法是通用的**：它只读 `bossMapAt()` 与 `bossSlotsFor()`，对具体 Boss 类型
   * 一无所知 —— 加 Boss2 / 给别的地图加 Boss 只改 `boss-registry.js` 的名册与对应 service，
   * 不动这里。service 契约 = `summon(mapKey, cx, cz, slot)` 返回
   * `{ok:true, id} | {ok:false, reason:'exists'|'limit'}`。
   *
   * ⚠️ **召不出时必须给 toast**（用户裁定）：静默失败会让玩家以为按键坏了
   * （AGENTS.md v1.98「点了没反应」同源教训）。
   *
   * @returns {{ok: boolean, reason?: string, id?: string}}
   */
  summonBoss() {
    const p = this.player?.physics?.pos;
    if (!p) return { ok: false, reason: 'no-player' };
    const map = bossMapAt(p.x, p.z, this.seed);
    if (!map) {
      this._bossToast('这里没有可召唤的 Boss');
      return { ok: false, reason: 'no-map' };
    }
    const slots = bossSlotsFor(map.kind);
    if (!slots.length) {
      this._bossToast('这里没有可召唤的 Boss');
      return { ok: false, reason: 'no-boss' };
    }
    for (const slotDef of slots) {
      const svc = this[slotDef.service];
      if (!svc || typeof svc.summon !== 'function') continue;
      // ⚠️ **参考高度：地图带 `summonY` 就用它，否则用玩家 y**。
      // · 无 `summonY`（高台地带）：传玩家 y，焰魔的地面扫描据此取「玩家所在那一层」的
      //   地面，而不是地图中心列上的最低位置。高台地带有多层可站结构（广场地面 /
      //   高台顶 46 / 拱洞 / 巨云 54~95），不传会让焰魔落到与玩家相距 30+ 格的高度。
      // · 有 `summonY`（大竞技场）：**恒召到建筑最高层中心**，与玩家所在高度/层无关
      //   （用户裁定：「不管玩家在什么高度、在竞技场的哪个层，都可以召唤出 boss」）。
      //   实测不传的后果：玩家站碗内地板（y≈0）时，`_findGroundY` 取「离玩家最近的可站位置」
      //   ⇒ 焰魔落在中心熔岩柱顶（y=34）而不是顶层平台（y=70），差 36 格。
      // 飞龙忽略这个多余参数（它恒在轨道高度）。
      const refY = Number.isFinite(map.summonY) ? map.summonY : p.y;
      const r = svc.summon(map.key, map.cx, map.cz, slotDef.slot, refY);
      if (r.ok) {
        this._bossToast(`已召唤 Boss${slotDef.slot + 1}`);
        // v2.64：召唤音效（用户 2026-11-07：「焰魔和飞龙被创建的时候的音效 ignis_burn.ogg」）。
        // ⚠️ **接在 `summonBoss` 的成功分支而不是各 service 的 `summon()` 里**：
        // ① service 是同构层（不得碰音频，红线 8）；② 这里是飞龙与焰魔的**唯一**召唤入口
        // （按 B），一处接线两种 Boss 都覆盖。Boss 战 BGM 不用在这里触发 ——
        // `_syncBossAudio` 每帧按 `entities.count()` 判定，下一帧自然淡入。
        this.audioManager?.play('ignis_burn', SOUND_VOLUMES.ignis_burn);
        return r;
      }
      if (r.reason === 'limit') {
        this._bossToast('Boss 数量已达上限');
        return r;
      }
      // 'exists' → 该槽位已有，试下一个
    }
    this._bossToast('Boss 都在了');
    return { ok: false, reason: 'all-exist' };
  }

  /**
   * Boss 召唤的 toast（懒建）。
   *
   * ⚠️ **与设置面板的 Toast 共享同一个 `#mc-toast` DOM 元素**（`Toast._install` 按 id 幂等）。
   * 这是有意的：两个实例各建一个同 id 元素时，`document.getElementById` 只返回文档序里的
   * 第一个 ⇒ 后建的那个写的文案玩家永远看不到（v2.43 实测踩到，已修 `Toast._install`）。
   * ⚠️ 因此**不要给本实例调 `dispose()`** —— 它会把共享元素从文档里摘掉，
   * 设置面板的提示随之静默失效。
   */
  _bossToast(message) {
    if (!this._bossToastInstance) this._bossToastInstance = new Toast({});
    this._bossToastInstance.show(message);
    return undefined;
  }

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
   * ⚠️ **去重键的生命周期 = 一次引爆的进行中**（v2.97 修，用户报告「相邻 TNT 连锁后有些方块
   * 没消失、再点也没反应」）。键在**每次调用的出口无条件释放**，**包括中心格已经不含 TNT 的
   * 早退路径**（连锁幽灵项 / 枪击命中的格已被别处删掉 / column 暂时卸载导致写不进世界）。
   * 曾经的写法把 `delete(key)` 放在 `if (中心格是 tnt)` 之内 ⇒ 中心格是空气时键永久残留 ⇒
   * ① 该格**未来**放的 TNT 被 `has(key)` 静默拒绝引爆（方块永远炸不掉也永远不消失）；
   * ② 残留键参与 `_applyExplosion` 的 `pending` 过滤，把真 TNT 排除出破坏事务。
   *
   * ⚠️ **不在此加「中心格必须仍是 TNT 才引爆」的门控**（v2.97 曾试过、已回退）：① mc-lite 的
   * 到期回调也不重新校验（`PlayerInteraction.js:619-623`），本仓 `_updateTntChain` 的注释
   * 明确禁止这个偏离；② 它会顺带把语义改成「玩家可以在 500~1100ms 窗口内拆掉引信」——
   * 那是没被要求的玩法变更。**重复引爆靠第 ⑤ 步的入队去重解决**，不靠到期时重验。
   *
   * @param {number} x @param {number} y @param {number} z
   * @returns {boolean} false = 去重命中（已引爆过），零世界写入
   */
  explodeTnt(x, y, z) {
    // ① 去重（唯一入口 —— 三条路径共用同一集合）
    const key = `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
    if (this._ignitingTnt.has(key)) return false;
    this._ignitingTnt.add(key);
    // ①b 这一格若已在连锁队列里排期（玩家在 500~1100ms 窗口内抢先引爆）：撤掉排期项。
    //     不撤的话它到期时会再炸一次「空爆炸」—— 方块一格不少，却多一发音效/伤害/特效
    //     （v2.97 实测：三连 TNT 的 exploded 计数为 4 而非 3，就是重项造成的）。
    if (this._tntScheduled.delete(key)) {
      this._tntChain = this._tntChain.filter((t) => `${t.x},${t.y},${t.z}` !== key);
    }

    const result = computeExplosion({ world: this.world, registry: this.registry, center: [x, y, z] });
    const tntId = this.registry.idOf('tnt');
    // ③ 移除引爆格自身（**不受破坏开关影响** —— 见上方 ⚠️）
    if (this.world.getBlockId(result.center[0], result.center[1], result.center[2]) === tntId) {
      this.editor.setBlock({ x: result.center[0], y: result.center[1], z: result.center[2], id: 0 });
    }
    // ③b 键存活期到此结束 —— **无条件释放**（mc-lite `:687` 只在该格确实是 tnt 时删，
    //     但那正是「键永久残留」的来源，见开头 ⚠️）。中心格非 TNT 时键也必须走，
    //     否则该格之后再也炸不掉。
    this._ignitingTnt.delete(key);
    this._applyExplosion(result);
    return true;
  }

  /**
   * 爆炸执行（v2.44 从 `explodeTnt` 抽出，**不碰去重集合**）。
   *
   * ⚠️ **为什么必须抽出来、火球不能直接调 `explodeTnt`**（Review Focus 1）：
   * `explodeTnt` 的去重集合 `_ignitingTnt` 以「格坐标」为键，语义是「这个 TNT 格已引爆过」。
   * 火球爆炸的格**不是 TNT**，若走 `explodeTnt` 会把那个格的键永久留在集合里 ——
   * 之后玩家在同一格放 TNT 引爆会返回 false **静默不爆**（方块层面看不出，
   * 只有「先炸火球再放 TNT」的对照能抓 —— `tests/dragon-fireball.spec.mjs` 的负向验证）。
   *
   * ⚠️ **入参是 `computeExplosion` 的结果**（不是坐标）：TNT 路径在 self-removal 之前
   * 就算好了 result（chain 不含中心格，`explosion.js` 的 `dx===0&&dy===0&&dz===0 continue`），
   * 火球路径直接算 —— 两条路径共享本函数，行为逐位一致。
   *
   * @param {{center:[number,number,number], destroy:Array, chain:Array}} result
   */
  _applyExplosion(result) {
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
    //
    // ⚠️ **同格必须去重**（v2.97 修）：`computeExplosion` 只在**引爆的那一帧**枚举 5×5×5。
    //    首爆把 B、C 一起入队后，B 先炸时又把仍是 TNT 的 C 搜进了 chain ⇒ 队列里 C 有两项。
    //    C 被 B 那一项引爆后，**它自己的那一项到期时中心格已是空气** → 一次幽灵爆炸
    //    （计数 +1、音效/伤害/特效各多一次），且那一步的早退路径当年还泄了去重键。
    //    去重集合在 ③ 已释放（键生命周期只覆盖「进行中」），所以这里必须自己按格去重 ——
    //    判据是 `_tntScheduled`（「已排期、尚未引爆」的格集合），**不是 `_tntChain`**：
    //    `_updateTntChain` 在逐项引爆前把本帧到期的项**整批**从队列里抽走 ⇒ 只查
    //    `_tntChain` 时同批的两个项互相看不见，去重会失效（v2.97 实测：三连仍重复入队）。
    const now = performance.now();
    for (const t of result.chain) {
      const chainKey = `${t.x},${t.y},${t.z}`;
      if (this._tntScheduled.has(chainKey)) continue;
      this._tntScheduled.add(chainKey);
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
  }

  /**
   * Storm Lance 的五射线扫描 + 伤害结算（v3.20，装配层）。
   *
   * 几何与命中走纯函数 `stormLanceSweep`（`player/weapons/storm-lance.js`），本方法只加扣血。
   *
   * ⚠️⚠️ **必须走 `damageEntity`，不得复用 `_damageEntitiesInRadius`**：
   * 后者只遍历 `zombies.activeEntities()` ⇒ **Boss 压根打不到**，而用户明确要
   * 「boss 或者丧尸」都掉血。`damageEntity` 按类型分发到 zombie/dragon/ignis/guardian，
   * 红闪 / 伤害数字 / 死亡音效 / 死亡爆散全部自动跟上。
   *
   * ⚠️ **一次施法每个实体只扣一次**（用户裁定）：燃烧期不重复结算 ——
   * 本方法只在 `pointerUp` 那一帧被调一次，天然不重复。
   * ⚠️ **不写方块、不击退**（炸弹不击退，用户要「等同被炸弹炸到」）。
   *
   * @param {object} aim @param {object} cfg
   * @returns {{origin:number[], target:number[], side:number[], length:number, hits:Array}}
   */
  _stormLanceSweep(aim, cfg) {
    const res = stormLanceSweep({
      world: this.world,
      entities: this.entities,
      isHittable: (entity) => WEAPON_HITTABLE_TYPES.includes(entity.type),
      aim,
      cfg,
    });
    const now = performance.now();
    for (const hit of res.hits) this.damageEntity(hit.id, cfg.damage, now);
    return res;
  }

  /**
   * 只读 Storm Lance 诊断状态（E2E 与调试用）。
   * @returns {{active:boolean, phase:string, charge:number, charged:boolean, meshes:number}}
   */
  stormLanceDebugState() {
    const ws = this.player?.weaponDebugState?.() ?? { novaCharge: 0, novaCharged: false };
    return {
      active: this.stormLance?.active ?? false,
      phase: this.stormLance?.phase ?? 'idle',
      charge: ws.novaCharge,
      charged: ws.novaCharged,
      meshes: this.stormLance?.meshes.length ?? 0,
    };
  }

  /**
   * 半径内丧尸伤害。枚举 `ZombieService.activeEntities()`（slot 表是单一权威），
   * **不扫 EntityManager 全量集合** —— 那会把未来其它实体类型（弹丸/炮塔）也炸伤。
   * @param {[number,number,number]} center @param {number} radius
   * @param {number} damage @param {number} nowMs
   */
  _damageEntitiesInRadius(center, radius, damage, nowMs) {
    const cx = center[0] + 0.5, cy = center[1] + 0.5, cz = center[2] + 0.5;
    let killed = false;
    for (const entity of this.zombies.activeEntities()) {
      const [px, py, pz] = entity.state.position;
      const dy = py + ZOMBIE.height / 2;   // 度量用丧尸 AABB 中心（mc-lite 同口径）
      if (Math.hypot(px - cx, dy - cy, pz - cz) <= radius) {
        // v2.51/v2.64：爆炸炸死也算「丧尸被消灭」→ 死亡音效 + 碎块爆散。
        // ⚠️ **本函数绕过 `damageEntity()`**（它直接调 service），所以死亡处理要在这里再接一次；
        // 两处都只在 `dead` 上触发，且同一帧内只响一声（`killed` 聚合，`silent` 传入），
        // 否则一发 TNT 炸死 5 只会变成 5 连击音；但**碎块不聚合** —— 每只都要爆。
        if (this.zombies.damage(entity.id, damage, nowMs)?.dead) {
          killed = true;
          this._onEntityDeath(entity, nowMs, { silent: true });
        }
        // 生命系统显示层：TNT 路径也要弹数字（与 `damageEntity` 同口径）。
        // ⚠️ **本函数绕过 `damageEntity()`**，故显示也要在这里再接一次 ——
        // 与死亡音效的两站点模式一致（v2.51 注释同源）。读掉血后的剩余血量。
        const after = this.zombies.get(entity.id);
        this._emitDamageNumber(entity, after ? after.health : 0, nowMs);
      }
    }
    if (killed) this.audioManager?.play('z_die', 0.3);
  }

  /**
   * 雨声循环接续（v2.51）。
   *
   * 用户 2026-11-04：「增加雨声（rain.mp3）… 其中雨声只有在下雨的时候才播放」。
   * 判据 = `weather.intensity`（**含过渡期**，`WeatherState.isRaining` 同一口径）→
   * 强度直接当音量：淡入淡出与天气状态机同步，无雨时 `intensity === 0` → `stopLoop`。
   * 音量上限 0.2 = mc-lite `Game.js:719` 的 `playSound('rain', 0.2, true)`
   * （常量在 `RAIN.SOUND_VOLUME`，单一权威）。
   *
   * 每帧调用：`playLoop` 同名已在播时只改音量（不重启），`stopLoop` 幂等 ——
   * 因此常态成本就是两次 Map 查询。
   */
  _syncRainSound() {
    const am = this.audioManager;
    if (!am) return;
    const intensity = this.weather?.intensity ?? 0;
    if (intensity > 0) am.playLoop('rain', RAIN.SOUND_VOLUME * intensity);
    else am.stopLoop('rain');
  }

  /**
   * Boss 战音频总接线（v2.64，用户 2026-11-07）。帧循环每帧调（放在
   * `_consumeIgnisAttackRequests` 之后 —— 焰魔本帧的 mode/leapKind 已由 Agent 写入）。
   *
   * 四件事：
   *   ① **Boss 战 BGM 意图**：场上有任一 Boss（龙或焰魔）→ `setBossMusicActive(true)`，
   *      全灭 → false；再调 `audioManager.update(nowMs)` 逐帧推进交叉淡化。
   *      判据用 `entities.count()`（零分配，与 `_consumeDragonFireRequests` 同手法）。
   *   ② **焰魔起手音**：mode 迁入 `attack` 的那一帧，按本招的 `attackKind` 播对应音
   *      （`IGNIS_ATTACK_SOUNDS`：`swing` → `ignis_attack_swing`、`spin` → `ignis_attack_circle`，
   *      v2.79 用户裁定「旋斩只用 circle，不与挥刀音叠播」）。chase→attack 与 leap→attack
   *      两条路径都算。`attackKind` 在起手当帧就由 Agent 写进 state，所以迁移帧读到的一定是当招的值。
   *   ③ **焰魔跳跃音**：mode 迁入 `leap` 的那一帧响 `ignis_jump`
   *      （escape 脱困跳与 attack 跳劈都算，用户裁定「跳跃时」不分种类）。
   *   ④ **飞龙随机吼叫**：每条龙维护独立的下次吼叫时刻（`DRAGON_SHOUT` 区间内随机），
   *      到期响 `dragon_shout` 并续期。
   *
   * ⚠️ **为什么用「上一帧快照差分」而不是在 Agent 里直接响**：`ignis-boss-agent.js` 属于
   * Worker 同构层（红线 8：不得 import 渲染/DOM 依赖），碰不了音频。音效是纯表现层关注点，留在装配层。
   * （⚠️ 本注释刻意不写同构自声明的原字样：`check-architecture.mjs` 的
   * `ISOMORPHIC_DECLARED` 正则扫全文，game.js 里出现该字样会让本文件被误判成
   * 自声明同构模块 → 架构门 12 条误报，实测已踩到。）
   * 快照按 `{id → {mode, leapKind, generation}}` 存 `_bossAudioState`，**generation 不符
   * 视为新实体**（id 会被「死了又召」复用，与伤害数字的 generation 守卫同手法）——
   * 否则旧快照的 mode 会与新实体的 idle 构成假迁移。
   *
   * ⚠️ **常态成本**：没 Boss 时（绝大多数帧）= 两次 `count()` + 一次 `update()` 里的
   * 布尔判断 + 空 Map 遍历，零分配。
   *
   * @param {number} nowMs `performance.now()` 基准
   */
  _syncBossAudio(nowMs) {
    const am = this.audioManager;
    if (!am) return;

    // ① Boss 战 BGM：有 Boss 在场 → 战斗曲；全灭 → 淡回开局那首。
    const bossAlive = this.entities.count(DRAGON_TYPE) + this.entities.count(IGNIS_TYPE)
      + this.entities.count(GUARDIAN_TYPE) > 0;
    am.setBossMusicActive(bossAlive);
    am.update(nowMs);

    // ②③④ 需要逐实体读 state —— 没 Boss 时直接跳过（零分配门控，同 `_consumeDragonFireRequests`）
    if (!bossAlive) {
      if (this._bossAudioState.size > 0) this._bossAudioState.clear();
      return;
    }

    const prev = this._bossAudioState;

    // ---- 焰魔：挥刀 / 跳跃迁移检测 ----
    if (this.ignises && this.entities.count(IGNIS_TYPE) > 0) {
      for (const ignis of this.ignises.activeEntities()) {
        const { mode, leapKind } = ignis.state;
        const old = prev.get(ignis.id);
        // generation 不符（死了又召）→ 视为新实体，不触发迁移音（否则旧 mode 与新 idle
        // 构成假迁移；且召唤瞬间的 `ignis_burn` 已由 summonBoss 负责，不重复）。
        const isNew = !old || old.generation !== ignis.generation;
        if (!isNew) {
          if (old.mode !== 'attack' && mode === 'attack') {
            // v2.79：按本招选起手音（旋斩 → `ignis_attack_circle`，普攻 → `ignis_attack_swing`）。
            // 表与缺省回落都在 `audio-config.js`（红线 1：装配层不写招式分支）。
            const soundId = ignisAttackSound(ignis.state.attackKind);
            am.play(soundId, SOUND_VOLUMES[soundId]);
          }
          if (old.mode !== 'leap' && mode === 'leap') {
            am.play('ignis_jump', SOUND_VOLUMES.ignis_jump);
          }
        }
        // ⚠️ **原地改条目而不是每帧新建 Map**（分配）：`seenAt` 是本帧时间戳，
        // 扫完一轮后把 `seenAt !== nowMs` 的条目删掉 —— 那就是已 despawn 的实体。
        if (old) {
          old.mode = mode; old.leapKind = leapKind;
          old.generation = ignis.generation; old.seenAt = nowMs;
        } else {
          prev.set(ignis.id, {
            mode, leapKind, generation: ignis.generation, seenAt: nowMs, nextShoutAt: null,
          });
        }
      }
    }

    // ---- 末影守卫：起手 / 跳跃迁移检测 ----
    // ⚠️ **generation 守卫不可省**（同焰魔）：漏了会让「死了又召」的旧 mode 与新 idle
    // 构成假迁移（重召那一帧白响一声起手音）。
    // ⚠️ 四招共用一个起手音 `guardian_attack`（原版只有一个拳击音，不按招分）。
    if (this.guardians && this.entities.count(GUARDIAN_TYPE) > 0) {
      for (const g of this.guardians.activeEntities()) {
        const { mode, leapKind } = g.state;
        const old = prev.get(g.id);
        const isNew = !old || old.generation !== g.generation;
        if (!isNew) {
          if (old.mode !== 'attack' && mode === 'attack') {
            am.play('guardian_attack', SOUND_VOLUMES.guardian_attack);
          }
          if (old.mode !== 'leap' && mode === 'leap') {
            // 守卫只有脱困跳（无跳劈），沿用焰魔的跳跃音（不为它开第二个素材）
            am.play('ignis_jump', SOUND_VOLUMES.ignis_jump);
          }
        }
        if (old) {
          old.mode = mode; old.leapKind = leapKind;
          old.generation = g.generation; old.seenAt = nowMs;
        } else {
          prev.set(g.id, {
            mode, leapKind, generation: g.generation, seenAt: nowMs, nextShoutAt: null,
          });
        }
      }
    }

    // ---- 飞龙：随机吼叫 ----
    if (this.dragons && this.entities.count(DRAGON_TYPE) > 0) {
      for (const dragon of this.dragons.activeEntities()) {
        const old = prev.get(dragon.id);
        const isNew = !old || old.generation !== dragon.generation;
        let nextShoutAt = isNew ? null : old.nextShoutAt;
        if (nextShoutAt === null || nowMs >= nextShoutAt) {
          // 首次（或死了又召）不在当帧吼 —— 那一刻已有 `ignis_burn`；到期才吼并续期。
          if (!isNew) am.play('dragon_shout', SOUND_VOLUMES.dragon_shout);
          const { minSeconds: lo, maxSeconds: hi } = DRAGON_SHOUT;
          nextShoutAt = nowMs + (lo + Math.random() * (hi - lo)) * 1000;
        }
        // 龙的快照只存吼叫时刻（mode/leapKind 是焰魔的字段，龙没有）
        if (old && !isNew) {
          old.generation = dragon.generation; old.seenAt = nowMs; old.nextShoutAt = nextShoutAt;
        } else {
          prev.set(dragon.id, {
            mode: null, leapKind: null, generation: dragon.generation,
            seenAt: nowMs, nextShoutAt,
          });
        }
      }
    }

    // 清理已 despawn 的条目（本帧没被看到的）。常态最多 6 条，遍历成本可忽略。
    for (const [id, entry] of prev) {
      if (entry.seenAt !== nowMs) prev.delete(id);
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
    for (const t of due) {
      // 本批已从队列抽走 —— 同步释放排期键，该格以后才能重新排期（v2.97）
      this._tntScheduled.delete(`${t.x},${t.y},${t.z}`);
      this.explodeTnt(t.x, t.y, t.z);
    }
  }

  /** 设置 TNT 是否破坏地形（默认 false）。@returns {boolean} */
  setTntBlockDamage(enabled) {
    this.canTntDestroyBlocks = !!enabled;
    return this.canTntDestroyBlocks;
  }

  /** 只读连锁队列状态（测试钩子）。@returns {{pending: number, exploded: number, scheduled: number}} */
  tntChainDebugState() {
    return { pending: this._tntChain.length, exploded: this._tntExploded, scheduled: this._tntScheduled.size };
  }

  // ---- M6 调试键（X 键生成丧尸，对齐 mc-lite `Game.js:155-202`）----

  /**
   * 在玩家附近生成一只丧尸（X 键）。**调试入口，不是玩法** —— mc-lite 的 X 键同样是
   * `[Debug]` 用途（随机角度 + 随机距离 + console.log），M6 规格 §1 明确「无昼夜自然刷怪」，
   * 正式的生成入口是 M7 巢穴（经 `ZombieService.spawn()`）。
   *
   * **两处有意偏离 mc-lite**（都是 M6 验收时实测到的坑，详见验收报告 §4）：
   * ① 向下扫判据用 `isSolid`，不是 mc-lite 的「非空气」（`getBlock !== null && !== 'air'`）。
   *    理由：本判据必须与 `ZombieService.spawn` 的「脚下 solid」门控同源（红线 1）。
   *    ⚠️ v1.96 起 cloud 也是 `solid:true` → 云顶现在也满足本判据（扫描从玩家高度向下，
   *    实测出生点 City 中心雨幕半径内 0 个云列 → 地面附近的落点不受影响）。
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
    const targets = this.zombies.activeEntities().map((e) => ({
      id: e.id, position: [...e.state.position],
    }));
    // v2.41：炮塔也打龙（用户裁定）。⚠️ **龙传 `bodyOffsetY: 0`** —— 它的 position 就是
    // 身体中心，而丧尸的 position 是脚底（缺省 +1.2 抬到胸部，mc-lite `ENEMY_BODY_OFFSET_Y`）。
    // ⚠️ **v2.43 起是全部龙**（多实例），不是单条。
    for (const dragon of this.dragons?.activeEntities() ?? []) {
      targets.push({ id: dragon.id, position: [...dragon.state.position], bodyOffsetY: 0 });
    }
    // v2.55：炮塔也打焰魔（它进了 `WEAPON_HITTABLE_TYPES`）。
    // ⚠️ **焰魔的 `position` 是脚底** ⇒ 用缺省的 `bodyOffsetY`（抬到胸部），
    // 与丧尸同口径；而龙的 position 已是身体中心，故显式传 0。
    for (const ignis of this.ignises?.activeEntities() ?? []) {
      targets.push({ id: ignis.id, position: [...ignis.state.position] });
    }
    // 炮塔也打末影守卫（本次新增）。⚠️ **光加 WEAPON_HITTABLE_TYPES 不够** ——
    // 那张表只管「能不能被打中」，炮塔索敌是本处这份独立清单。
    // 守卫的 position 是脚底 ⇒ 用缺省 bodyOffsetY（抬到胸部），同丧尸/焰魔。
    for (const g of this.guardians?.activeEntities() ?? []) {
      targets.push({ id: g.id, position: [...g.state.position] });
    }
    const { updates } = computeTurretUpdates({
      turrets, targets, world: this.world, registry: this.registry,
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
   * 创建一颗火球（v2.44，M5 临时实体，不存档）。id 确定性派生（红线 2：不用 Math.random）。
   *
   * ⚠️ **与 `fireProjectile` 刻意分开**：火球速度 15（vs 弹丸 40）、遮挡只看 solid（vs
   * solid && opaque）、命中即爆炸（vs 伤害）。共用一个 spawn 会让两套语义纠缠。
   *
   * @param {number[]} position 出生点（龙的身体中心）
   * @param {number[]} direction 归一化方向（指向玩家胸部）
   * @param {string} source 发射者（龙 id）
   * @returns {boolean} false = 实体池满额
   */
  fireFireball(position, direction, source) {
    this._fireballSeq += 1;
    const id = `fireball-${this._fireballSeq}`;
    const spawned = this.entities.spawn({
      id, type: FIREBALL_TYPE,
      state: { position, direction, traveled: 0, source },
      persistent: false,   // 临时实体：随 column 卸载回收，不进 entities snapshot
    });
    if (!spawned) {
      // ⚠️ **不得静默吞掉**（评审 I3）：计入诊断 + 首次 warn，否则形态是「龙张嘴没喷出东西」
      this._fireballSpawnFailed += 1;
      if (this._fireballSpawnFailed === 1) {
        console.warn('[dragon] 火球 spawn 失败（实体池满额？）—— 见 fireballsDebugState().spawnFailed');
      }
    }
    return spawned !== null;
  }

  /**
   * 消费龙的开火意图（v2.44）。放在 `entities.update` **之后** —— 龙 AI 在 definition.update
   * 里把「要开火」写进 state.fireRequest，本方法读它并生成火球实体。
   *
   * ⚠️ **为什么不在 definition 里直接 spawn**：生成实体是主线程装配层职责（entities/ 同构层
   * 不得碰 EntityManager 的写接口），与矿车 `pendingPlayerLift`（definition 算意图、game.js 执行）
   * 同一先例。
   *
   * ⚠️ **fireRequest 是瞬态**：消费后不写回（state 每帧由 definition 重建，下一帧自然是 null）。
   * ⚠️ **这依赖一条不变式（评审 M2）：`EntityManager.update` 用 definition 的返回值整体替换
   * `entity.state`**（entity-manager.js 的 `entity.state = next`）。若将来某个 definition 改成
   * 原地更新 state，陈旧的 fireRequest 会被**重复消费**（形态是「龙每帧都喷一发」）。
   * 存档路径已由 serialize 白名单防住（不含 fireRequest 键），这条是运行时路径的同类风险。
   * 多条龙共存时逐条消费（activeEntities 返回快照，spawn 不改变它）。
   */
  _consumeDragonFireRequests() {
    if (!this.dragons) return;
    // ⚠️ **常态零分配门控**：`activeEntities()` 会新建一个数组，而本方法每帧都跑 ——
    // 场上没龙时（绝大多数时间）白付一次分配。`count()` 只遍历不分配。
    // （AGENTS.md：「每帧新建是分配」—— 炮塔 pose 的 Map 复用是同一个教训。）
    if (this.entities.count(DRAGON_TYPE) === 0) return;
    for (const dragon of this.dragons.activeEntities()) {
      const req = dragon.state.fireRequest;
      if (!req) continue;
      // v2.64：喷火球音效（用户 2026-11-07：「飞龙发出火球时的声音 dragon_fire.ogg」）。
      // ⚠️ **接在消费点而不是 `fireFireball()` 里**：后者是公开 API（测试与未来其它调用方
      // 都会走），把音效塞进去会让「程序化生成一颗火球」也响一声。这里才是「龙真的喷了」。
      this.audioManager?.play('dragon_fire', SOUND_VOLUMES.dragon_fire);
      this.fireFireball(req.position, req.direction, dragon.id);
    }
  }

  /**
   * 焰魔的挥剑命中结算（v2.55）。
   *
   * 消费 `state.attackRequest`（**瞬态**，由 `IgnisBossAgent` 在动画到达命中帧那一帧写入）。
   * 三条判据全过才扣血：
   *   ① 玩家水平距 ≤ **本招的 `hitRange`**（v2.75 起按 `req.kind` 取；两招都是 6.5）
   *   ② |Δyaw| ≤ **本招的 `hitConeDeg`**（横扫 35° = 作者 `arc 70` 的一半；
   *      旋斩 155° = 作者 `arc 310` 的一半 —— **不是 180**，那会抹掉作者刻意的背向死角）
   *   ③ 焰魔胸部 → 玩家胸部视线通
   *
   * ⚠️ **只在该帧判定一次**（不是每帧）：`attackRequest` 只在命中帧出现，Agent 下一帧自动置 null。
   * 否则玩家站在旁边会被连续扣血。
   *
   * ⚠️ **`attackRequest.at` 是焰魔的身体位置**（不是玩家位置）—— 距离与角度都要从它算。
   *
   * ⚠️ **伤害写 `player.health`（不走 `Player` 的方法）**：本仓 `Player.health` 没有
   * setter/伤害方法（`player/health.js` 的口径是「纯函数 + 外部写回」），而
   * `applyDamage` 已把钳制逻辑封装。用户 2026-11-05 裁定：**只扣血、不做死亡**。
   *
   * ⚠️ **常态零分配门控**：`activeEntities()` 会新建数组，而本方法每帧都跑 ——
   * 场上没焰魔时用 `count()` 直接返回（与 `_consumeDragonFireRequests` 同一手法）。
   */
  _consumeIgnisAttackRequests() {
    if (!this.ignises || !this.player) return;
    if (this.entities.count(IGNIS_TYPE) === 0) return;
    const p = this.player.physics?.pos;
    if (!p) return;
    for (const ignis of this.ignises.activeEntities()) {
      const req = ignis.state.attackRequest;
      if (!req) continue;
      const [ex, ey, ez] = req.at;
      // 本招的档案（v2.75）—— 射程与半角都按招取。
      // ⚠️ **不能读 `IGNIS_AI.hitRange/hitConeDeg`**：那是两招的**派生最大值**（6.5 / **155°**），
      // 用它判定普攻会把锥从 35° 扩到 155° —— 玩家绕到侧面也会被横扫打中，而数据层完全正常。
      const profile = IGNIS_ATTACKS[req.kind] || IGNIS_ATTACKS.swing;
      const dx = p.x - ex;
      const dz = p.z - ez;
      // ① 水平距
      if (Math.hypot(dx, dz) > profile.hitRange) continue;
      // ② 前方锥（本仓 yaw 口径：指向玩家 = atan2(−dx, −dz)）
      const toPlayerYaw = Math.atan2(-dx, -dz);
      const cone = profile.hitConeDeg * Math.PI / 180;
      if (Math.abs(shortestAngleDiff(req.yaw, toPlayerYaw)) > cone) continue;
      // ③ 视线（从焰魔胸部到玩家胸部；与炮塔 LOS / 飞龙火球同一份权威）
      const from = [ex, ey + IGNIS.height * 0.5, ez];
      const to = [p.x, p.y + 1.0, p.z];
      if (!hasLineOfSight({ world: this.world, registry: this.registry, from, to })) continue;
      // 三条全过 → 扣血（钳制在 applyDamage 里）
      this._damagePlayer(IGNIS.attackDamage);
    }
  }

  /**
   * 焰魔四招的**命中特效**结算（v3.04）。
   *
   * 与 `_consumeIgnisAttackRequests`（伤害）**刻意分开**：后者只在命中帧的
   * `freshLos` 新鲜视线复查通过时才有 `attackRequest`，而原版
   * `Ignis_Entity.aiStep()` 的特效调用（`ShieldSmashparticle` / `spawnFlameStrike`）
   * **不看视线** ⇒ 玩家侧移出锥/隔墙时仍看得到 Boss 大招的规模。
   *
   * ⚠️ **纯视觉，不带伤害**：原版法阵每 5 tick 扣血 + 叠燃烧 debuff，
   * 本轮按用户裁定③「只扣血」全部不取 —— 四招伤害仍走 `IGNIS.attackDamage`。
   *
   * ⚠️ **招式过滤在这里，不在 Agent 里**：Agent 四招都产请求，
   * 「哪些招出哪种特效」是装配层的决定（同构层不做装配层的事）。
   * `swing` / `spin` 本轮不出特效（原版它们的特效是剑尖拖焰，未选）。
   *
   * ⚠️ **常态零分配门控**：`activeEntities()` 会新建数组，而本方法每帧都跑。
   *
   * @param {number} nowMs 帧循环的 `performance.now()` 基准时间戳。
   *   ⚠️ **必须由调用方传入，不得在方法内新取 `performance.now()`** ——
   *   同帧两个时基会让特效的 `bornAt` 与 `update(nowMs)` 的基准错开一截
   *   （帧内耗时），寿命判定与递延点亮都跟着漂。同 `_syncBossAudio` / `_updateTntChain` 口径。
   */
  _consumeIgnisFxRequests(nowMs) {
    if (!this.ignises) return;
    if (this.entities.count(IGNIS_TYPE) === 0) return;
    for (const ignis of this.ignises.activeEntities()) {
      const req = ignis.state.attackFxRequest;
      if (!req) continue;
      // v3.09：旋斩也要进特效消费（它要铺地面法阵）。
      // ⚠️ **入口 gate 与下面的法阵段必须一起放行**：只改法阵段的形态是
      // 「改了却一点效果也没有」（spin 在这里就被 continue 掉，实测拓到）。
      if (req.kind !== 'shieldSmash' && req.kind !== 'shieldBash'
        && req.kind !== 'spikeSlash' && req.kind !== 'spin') continue;

      // ---- 碎石圆环（**仅持盾冲撞 / 举盾砸击**）----
      // ⚠️ 旋斩刻意**不出碎石**（用户 2026-11-16 裁定「只加法阵」）；
      // 尖刺攻击也不出（它有自己的火焰尖锥）。
      // 颜色取自**环心脚下那一格**（原版取的也是 `hit.below()`，不是 Boss 脚下）。
      // ⚠️ 环心走 `smashRingCenter` —— 与 `smashDebrisRing` 内部同一份公式（红线 1）。
      // 在 game.js 重写一遍就是第二份权威 ⇒ 颜色会取自错误的格。
      if (req.kind === 'shieldSmash' || req.kind === 'shieldBash') {
        const center = smashRingCenter(req.at, req.yaw);
        const gx = Math.floor(center[0]);
        const gy = Math.floor(req.at[1]) - 1;
        const gz = Math.floor(center[2]);
        let rgb = null;
        const resolver = this.blockHitFx?.colorResolver;
        if (resolver && this.world) {
          const name = this.registry.nameOf(this.world.getBlockId(gx, gy, gz));
          if (name && name !== 'air') rgb = resolver(name, null);
        }
        // 缺色（未加载列 / resolver 构造失败）退中性灰，不阻断特效
        this.blockHitFx.spawnSmashRing(req.at, req.yaw, rgb || [0.5, 0.5, 0.5], nowMs);
      }

      // ---- 火焰尖锥（仅尖刺攻击，v3.06）----
      // ⚠️ **带伤害**（`IGNIS_SPIKE.damage = 18`）：与法阵的「纯视觉」不同 ——
      // 那是 v3.04 对法阵的裁定，本轮用户明确要尖刺带 18。
      // ⚠️ **不看视线**：原版 `ShieldSmashDamage` / `UltimateAttack` 都不查 LOS，
      // 而 `attackFxRequest` 本身已绕过 `freshLos` ⇒ 结算侧不得再查。
      // ⚠️ **一次命中帧只扣一次**：命中即 break（不是逐根累加）。
      // 去重靠「`attackFxRequest` 是瞬态」：Agent 下一帧自动清 null ⇒ 天然只消费一次。
      if (req.kind === 'spikeSlash') {
        if (!this.world) continue;
        const spikes = [];
        for (const p of spikeSpawnPoints(req.at, req.yaw)) {
          const y = this._findSigilGroundY(p.x, p.z, req.at[1]);
          // 扫不到地面（未加载列 / 悬崖外）⇒ **跳过该根**，同法阵口径。
          if (y === null) continue;
          spikes.push({ x: p.x, y, z: p.z, delayMs: p.delayMs });
        }
        if (spikes.length > 0) this.spikeFx?.spawn(spikes, nowMs);
        // 伤害：玩家 AABB 与任一根尖刺的**那一格**正体积重叠
        //（尺寸权威走 `PlayerPhysics.overlapsBlock`，不在这里重算一遍）。
        const phys = this.player?.physics;
        if (phys) {
          for (const s of spikes) {
            if (phys.overlapsBlock(Math.floor(s.x), Math.floor(s.y), Math.floor(s.z))) {
              this._damagePlayer(IGNIS_SPIKE.damage);
              break;
            }
          }
        }
        continue;
      }

      // ---- 地面火焰法阵（举盾砸击 + 旋斩）----
      // v3.09：旋斩也铺法阵（用户 2026-11-16「旋转攻击也要加上法阵的图案，跟盾击攻击一样，
      // 图案的位置也跟盾击攻击一样」）。
      // ⚠️ **复用同一套 `sigilSpawnPoints` + `_findSigilGroundY`**，不得为旋斩另写落点公式 ——
      // 第二份权威会让两招位置漂移，而段数/间距/延迟/寿命全部仍然正确（静默失效）。
      if ((req.kind !== 'shieldBash' && req.kind !== 'spin') || !this.flameSigil || !this.world) continue;
      const points = [];
      for (const p of sigilSpawnPoints(req.at, req.yaw)) {
        const y = this._findSigilGroundY(p.x, p.z, req.at[1]);
        // 扫不到地面（未加载列 / 悬崖外）⇒ **跳过该段**，与原版「flag 为假则不生成」同语义。
        // 不得回落到 y=0 或世界底 —— 那会在空中/地底凭空出一个法阵。
        if (y === null) continue;
        points.push({ x: p.x, y, z: p.z, delayMs: p.delayMs });
      }
      if (points.length > 0) this.flameSigil.spawn(points, nowMs);
    }
  }

  /**
   * 法阵落点的地面顶面 y（原版 `spawnFlameStrike` 的向下扫描，`Ignis_Entity.java:2163-2189`）。
   *
   * ⚠️ **从 Boss 上方起扫，不是从脚底起扫**：前方有凸起地形时脚底高度已低于前方地表，
   * 从脚底扫会把法阵放进山体内部。窗口 `脚底+4 → 脚底−8`（共 12 格）。
   *
   * ⚠️ 未加载列 `getBlockId` 恒返 0（air）⇒ 扫完无地面 ⇒ 返回 null，调用方跳过该段。
   *
   * @param {number} wx @param {number} wz 世界 x/z（可为小数，内部 floor）
   * @param {number} feetY 焰魔脚底 y
   * @returns {number|null} 地面顶面 y（= 实心格 y + 1），无地面时 null
   */
  _findSigilGroundY(wx, wz, feetY) {
    const x = Math.floor(wx);
    const z = Math.floor(wz);
    const base = Math.floor(feetY);
    for (let y = base + 4; y >= base - 8; y--) {
      if (this.world.isSolid(x, y, z) && !this.world.isSolid(x, y + 1, z)) return y + 1;
    }
    return null;
  }

  /**
   * 末影守卫的四招命中结算（本次新增）。
   *
   * 与 `_consumeIgnisAttackRequests` 逐条对应，**两处不同**：
   * ① 档案读 `GUARDIAN_ATTACKS[req.kind]`（**四档**，射程/锥角各不相同）；
   * ② 视线起点用 `GUARDIAN.height * 0.5`。
   *
   * ⚠️ **踩踏的 hitConeDeg = 180**（全向）—— 不得加「半角必须 < 180」的守卫
   *（那是焰魔旋斩的口径，守卫踩踏是环形近战，spec §4.3）。
   * ⚠️ **只在该帧判定一次**：`attackRequest` 是瞬态，Agent 下一帧自动置 null。
   * ⚠️ **常态零分配门控**：`activeEntities()` 会新建数组，而本方法每帧都跑。
   */
  _consumeGuardianAttackRequests() {
    if (!this.guardians || !this.player) return;
    if (this.entities.count(GUARDIAN_TYPE) === 0) return;
    const p = this.player.physics?.pos;
    if (!p) return;
    for (const g of this.guardians.activeEntities()) {
      const req = g.state.attackRequest;
      if (!req) continue;
      const [ex, ey, ez] = req.at;
      // ⚠️ **按招取档案**，不读 `GUARDIAN_AI.hitRange/hitConeDeg`（那是四招的派生
      // 最大值 6.25 / **180°**）—— 用它判定重击会把锥从 35° 扩到 180°，
      // 玩家绕到背后也被打中，而数据层完全正常。
      const profile = GUARDIAN_ATTACKS[req.kind] || GUARDIAN_ATTACKS.strong_right;
      const dx = p.x - ex;
      const dz = p.z - ez;
      if (Math.hypot(dx, dz) > profile.hitRange) continue;
      const toPlayerYaw = Math.atan2(-dx, -dz);
      const cone = profile.hitConeDeg * Math.PI / 180;
      if (Math.abs(shortestAngleDiff(req.yaw, toPlayerYaw)) > cone) continue;
      const from = [ex, ey + GUARDIAN.height * 0.5, ez];
      const to = [p.x, p.y + 1.0, p.z];
      if (!hasLineOfSight({ world: this.world, registry: this.registry, from, to })) continue;
      this._damagePlayer(GUARDIAN.attackDamage);
    }
  }

  /**
   * 玩家受伤的唯一入口（v2.64）。
   *
   * 用户 2026-11-07：「玩家被击中时的音效（**不管被谁击中**，只要被击中就有这个音效）
   * ignis_hurt.ogg」。故把「扣血 + 受击音」收成一个方法 —— 将来任何新的伤害源
   * （火球直接扣血、坠落、其它 Boss）都调它，不会再出现「某条路径忘了配音效」。
   *
   * ⚠️ **抽这个方法不是为了少写一行**：v2.64 之前 `applyDamage` 只有一处调用点，
   * 音效本可以直接写在那里。但「不管被谁击中」是一条**对未来生效**的约束 ——
   * 散在调用点的音效无法保证它，唯一入口可以。
   *
   * ⚠️ **血量没真的变（已是 0）时不响**：用户裁定「只扣血、不做死亡」，血停在 0 后
   * 再被砍不算「被击中」的新反馈（否则站在焰魔面前会持续响，读作音效卡住）。
   *
   * @param {number} amount 伤害格数
   * @returns {number} 扣血后的剩余血量
   */
  _damagePlayer(amount) {
    const before = this.player.health;
    const after = applyDamage(before, amount);
    this.player.health = after;
    if (after < before) {
      this.audioManager?.play('ignis_hurt', SOUND_VOLUMES.ignis_hurt);
    }
    return after;
  }

  /**
   * 帧循环内判定火球（放在 `entities.update` 之后 —— 位置已推进，本方法只判定 + 爆炸 + despawn）。
   *
   * ⚠️ **推进不能做两遍**（同 `_updateProjectiles`）：位置推进已由 `fireballDefinition.update`
   * 经 `entities.update(dt, ctx)` 驱动；本方法**只调 `judgeFireball`（纯谓词）+ 爆炸 + despawn**。
   *
   * ⚠️ **爆炸走 `_applyExplosion`，不走 `explodeTnt`**（Review Focus 1）：后者会把火球炸过的格
   * 键永久留在 `_ignitingTnt` 去重集合里 → 之后玩家在同格放 TNT 静默不爆。
   * `_applyExplosion` 不碰去重集合。超距（`max-distance`）不爆炸（judgeFireball 不给 at）。
   */
  _updateFireballs(dt) {
    // ⚠️ **常态零分配门控**（与 `_consumeDragonFireRequests` 同理）：下面要构造 player 盒对象
    // + 快照展开实体集合，没火球时（绝大多数帧）这两笔分配是白付的。
    // 实测后果：bench 场景 ③ fastRemeshP95 1.1 → 4.5（GC 压力正是该指标的记录抖动源）。
    if (this.entities.count(FIREBALL_TYPE) === 0) return;
    const player = this.player && this.player.physics
      ? { position: [this.player.physics.pos.x, this.player.physics.pos.y, this.player.physics.pos.z],
          aabb: this._playerAabbLocal }
      : null;
    for (const entity of [...this.entities.entities()]) {   // 快照：despawn 会改底层集合
      if (entity.type !== FIREBALL_TYPE) continue;
      const { reason, at } = judgeFireball({
        next: entity.state, world: this.world, registry: this.registry,
        player, stepLen: FIREBALL.speed * dt,
      });
      if (!reason) continue;
      // 命中玩家或方块 → 爆炸（TNT 同口径）；超距 → 只消失不爆炸
      if (at) this._applyExplosion(computeExplosion({ world: this.world, registry: this.registry, center: at }));
      this.entities.despawn(entity.id, reason);
    }
  }

  /** 只读火球诊断状态。@returns {{count: number, spawnFailed: number}} */
  fireballsDebugState() {
    let count = 0;
    for (const entity of this.entities.entities()) if (entity.type === FIREBALL_TYPE) count++;
    return { count, spawnFailed: this._fireballSpawnFailed };
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
        onDamage: (id, amount, ms) => this.damageEntity(id, amount, ms),
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
    // 迷你地图（v2.8）：纯 DOM，摘除节点即可（无 GPU 资源、无事件监听）
    this._minimap?.dispose();
    this._reflectDock?.dispose();
    // v3.16：Boss 召唤提示（同口径：纯 DOM）
    this._bossHint?.dispose();
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
    // 祭坛飞龙（v2.41）：service 回收实体后释放渲染器（与启动顺序相反）
    this.dragons?.dispose();
    this.dragonRenderer?.dispose();
    // 焰魔（v2.55）：同口径（service 回收实体后释放渲染器）
    this.ignises?.dispose();
    this.ignisRenderer?.dispose();
    // 末影守卫：同口径（service 回收实体后释放渲染器）
    this.guardians?.dispose();
    this.guardianRenderer?.dispose();
    // 矿车：service 回收实体后释放渲染器（与启动顺序相反）
    this.minecarts?.dispose();
    this.minecartRenderer?.dispose();
    // M8：炮塔渲染层 + 爆炸特效池（Game 装配的独立 scene 节点，不经 player.dispose 释放）
    this.turretRenderer?.dispose();
    this.projectileRenderer?.dispose();
    // v2.44：火球渲染池（实体已由上面的 dragons.dispose / entities.dispose 回收，这里只释放 scene 节点）
    this.fireballRenderer?.dispose();
    this.explosionRenderer?.dispose();
    this.explosionSprite?.dispose();
    this.blockHitFx?.dispose();
    this.flameSigil?.dispose();
    this.spikeFx?.dispose();
    // v3.20：Storm Lance 渲染器与蓄力环（与启动顺序相反）
    this.stormLance?.dispose();
    this._chargeRing?.dispose();
    // v3.04：法阵贴图由 **Game 加载并持有**（渲染器只消费，不像 ignis/fireball 那样
    // 自己造纹理后 `_ownsTexture` 释放）⇒ 谁创建谁释放，不释会在换世界时泄漏。
    this._flameSigilTexture?.dispose();
    this.entities?.dispose();
    this.pool.dispose();
    this.renderer.dispose();
  }
}
