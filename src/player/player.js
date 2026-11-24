// src/player/player.js — 输入/视角/交互编排（§4.5）
import * as THREE from 'three';
import { raycastVoxel } from './raycast.js';
import { scanPlaceCells } from './place-ray.js';
import { PlayerPhysics } from './physics.js';
import { StepLift } from './step-lift.js';
import { ViewBob } from './view-bob.js';
import { HOTBAR_ITEMS as HOTBAR } from './hotbar-items.js';
import { createCreativeInventory } from './inventory.js';
import { getPlacementOrientation, recordRemovedBlock } from './orientation.js';
import { PLAYER_MAX_HEALTH } from './health.js';
import { WeaponController } from './weapons/weapon-controller.js';
import { WEAPON_IDS, WEAPONS } from './weapons/weapon-catalog.js';
import { NEST_ALIAS_BLOCK } from '../entities/zombie-nests/nest-config.js';
import { TURRET_ALIAS_BLOCK, defaultTurretRotation } from '../entities/turrets/turret-config.js';
import { MINECART_ITEM, MINECART_TYPE, MINECART } from '../entities/minecarts/minecart-config.js';
import { footstepSurfaceOf, FOOTSTEP_LOOPS, otherFootstepId } from './footstep-surface.js';

const EYE_HEIGHT = 1.62;
const REACH = 40; // mc-lite 枪的 far 语义

/**
 * **出生朝向 = 南**（用户 2026-10-29：「让玩家出生的时候，面朝南方」）。
 *
 * 坐标语义（实测，勿凭印象）：`update()` 用 `camera.rotateY(this.yaw)`，
 * 故相机前向 = `(sin(−yaw), 0, −cos(yaw))`：
 *
 * | yaw | 前向 (x, z) | 方位 |
 * |---|---|---|
 * | `0` | `(0, −1)` | 北（−Z） |
 * | `Math.PI` | `(0, +1)` | **南（+Z）** |
 * | `−Math.PI/2` | `(+1, 0)` | 东（+X） |
 * | `Math.PI/2` | `(−1, 0)` | 西（−X） |
 *
 * ⇒ 南 = `Math.PI`。数值上等价于 `-Math.PI`（两者余弦相同、正弦符号相反但为 0），
 * 取正值只为了与「+Z 为南」的直觉一致（`rotateY(π)` 与 `rotateY(−π)` 是同一个朝向）。
 *
 * ⚠️ **它只是构造初值**：`spawn()`（包括传送）不得重置朝向 —— 玩家自己转过的视角
 * 不应该在传送后被打回南。回归门见 `test-player-input.js`。
 */
export const SPAWN_YAW = Math.PI;

/**
 * 方向键（v1.80）：与 WASD 等价地驱动移动，故 keydown 里需吞掉默认行为。
 * 只列四个移动键 —— 不要泛化成「所有 Arrow*」（没意义），也不要扩到 F5/F12 这类浏览器快捷键。
 */
const ARROW_CODES = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

// _buildAim 复用的临时向量（避免每帧分配）
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();

/**
 * 受控创造模式专属物品（M7）：**放置走物品名路由，不落到常规单格 `editor.setBlock`**。
 *
 * ⚠️ 这些物品**就在**背包物品集合内（计数以 `npm run check:data` 的 `[物品集合]` 为准；实测
 * `buildItemNames()` 含 `zombie_nest_alias_block`，
 * 槽位索引 75）。玩家从背包面板选中图标 → 右键 → 走的是常规单格放置路径，**必须在这里分流**，
 * 否则只放出一个贴了图案的正方体而不是整个结构（M7 实测缺陷，见验收报告 §3.7）。
 * mc-lite 同手法：`PlayerInteraction.tryPlaceBlock()` 判 `entityRegistry.isSpecialBlock(type)`
 * → 交 placement handler。
 *
 * `selectPlaceable()` 是**额外的**测试/调试通道（置标志位，右键时优先查它），与背包路径并存。
 *
 * **加新项时的连带改动**：
 *   1. 若该物品代表**多方块结构**，图标须走平面路径 —— 把名字加进
 *      `tools/icon-fingerprint.mjs` 的 `FLAT_BLOCKS`（对齐 mc-lite `getCustomIconPath()` 的手工
 *      图标表）并跑 `npm run icons`。否则背包里显示的是一个立方体等轴测图 —— 错的表达。
 *   2. 放置 origin 按**物品类型**区分：多格结构（巢穴/炮塔）用**命中方块格**
 *      （`target.blockPos`）—— 结构最低层要落在玩家脚下的地面格上；单格实体（矿车）用
 *      `target.prevPos`（命中面的相邻空气格）。两条路径（背包分流与 `selectPlaceable`）
 *      的 origin 语义必须一致。
 */
// 物品名派生自 nest-config.js / turret-config.js / minecart-config.js 的单一权威，
// 不在此写第二份字面量（红线 1：两处会漂移）
const CREATIVE_SPECIALS = new Set([NEST_ALIAS_BLOCK, TURRET_ALIAS_BLOCK, MINECART_ITEM]);

export class Player {
  /**
   * @param {Object} opts
   * @param {import('../voxel/world-data.js').WorldData} opts.world
   * @param {THREE.PerspectiveCamera} opts.camera
   * @param {import('../core/scheduler.js').Scheduler} opts.scheduler
   * @param {*} opts.registry
   * @param {HTMLCanvasElement} opts.canvas - pointer lock 目标（M3.1 起公开为 `player.canvas`，
   *        面板关闭时 lock 回此处；mc-lite 锁 document.body，本仓库必须锁 canvas）
   * @param {import('../core/world-editor.js').WorldEditor} opts.editor 唯一世界写入入口（M4-0）
   * @param {{viewWeapon?: object, tracerRenderer?: object, audioManager?: object,
   *          blockHitFx?: object}} [opts.weaponRuntime]
   *        M4 武器渲染/音频运行时（Game 注入）。weaponController 由 Game 在 Player 创建后注入
   *        （onEffect 需委派回 player，避免循环引用）
   * @param {() => boolean} [opts.isModal] 模态谓词（M3.1）：返回 true 时 keydown 全部拦截。
   *        注入而非直接引用 Game，保持 Player 不反向依赖 core/（依赖方向 §3）
   */
  constructor({ world, camera, scheduler, registry, canvas, editor, weaponRuntime = null, isModal = () => false, onSpawnZombie = null, onSpawnSoldier = null, onPlayerShot = null, onSummonBoss = null, nests = null, turrets = null, minecarts = null, onIgniteTnt = null, isRainWetGround = null }) {
    this.world = world;
    this.camera = camera;
    this.scheduler = scheduler;
    this.registry = registry;
    this.editor = editor;
    this._isModal = isModal;
    /**
     * M6 X 键生成丧尸的回调（Game 注入 `() => this.spawnZombieNearPlayer()`）。
     * 注入而非直接引用 Game —— 保持 Player 不反向依赖 core/（依赖方向 §3，与 `isModal` 同手法）。
     * 缺省 null → X 键无效果（Player 单独构造时，如测试 fixture）。
     */
    this._onSpawnZombie = onSpawnZombie;
    /** 士兵 Epic：C 键召唤士兵（Game 注入；缺省 null ⇒ C 键无效果，fixture 安全） */
    this._onSpawnSoldier = onSpawnSoldier;
    /** 士兵 Epic：玩家开火时通知士兵班组（听枪声搜索）。缺省 null ⇒ 不通知 */
    this._onPlayerShot = onPlayerShot;
    /**
     * v2.43 B 键召唤 Boss 的回调（Game 注入 `() => this.summonBoss()`）。
     * 注入而非直接引用 Game —— 保持 Player 不反向依赖 core/（依赖方向 §3，与 `isModal` 同手法）。
     * 缺省 null → B 键无效果（Player 单独构造时，如测试 fixture）。
     */
    this._onSummonBoss = onSummonBoss;
    /**
     * v3.38：玩家此刻是否站在**被雨淋着的湿地**上（Game 注入
     * `() => this._isOnRainWetGround()`，判据本体在 `render/rain-shelter.js`）。
     * 注入而非直接 import `render/` —— 与 `isModal` / `onSpawnZombie` 同一手法
     * （依赖方向 §3：`player/` 不反向依赖 `render/`）。
     * 缺省 null ⇒ 恒 false ⇒ 脚步声恒 `running_land`（fixture 单独构造时安全）。
     */
    this._isRainWetGround = isRainWetGround;
    /**
     * M7 巢穴服务（Game 注入）。同样注入而非直接引用 —— `src/entities/**` 是同构层，
     * Player 不得反向依赖它；缺省 null → alias 右键放置无效果（fixture 单独构造时）。
     * @type {import('../entities/zombie-nests/zombie-nest-service.js').ZombieNestService|null}
     */
    this.nests = nests;
    /**
     * M8 炮塔服务（Game 注入）。同样注入而非直接引用 —— `src/entities/**` 是同构层，
     * Player 不得反向依赖它；缺省 null → alias 右键放置无效果（fixture 单独构造时）。
     * @type {import('../entities/turrets/turret-service.js').TurretService|null}
     */
    this.turrets = turrets;
    /**
     * 矿车服务（Game 注入）。同 nests/turrets 手法 —— `src/entities/**` 是同构层，
     * Player 不得反向依赖它；缺省 null → 矿车交互无效果（fixture 单独构造时）。
     * @type {import('../entities/minecarts/minecart-system.js').MinecartService|null}
     */
    this.minecarts = minecarts;
    /** 乘坐状态（mc-lite Player.js 同字段语义） */
    this.ridingMinecartId = null;
    this._lastRidePos = null;          // 上帧车位（跟随增量基准）
    this._remountCooldown = 0;         // 下车后禁止自动重绑（秒）
    this._spaceReleased = true;        // 空格边沿检测（防按住连续下车/重绑）
    /**
     * M8 引爆回调（Game 注入）。Player 不反向依赖 core/（依赖方向 §3，与 `onSpawnZombie`
     * 同惯例）。缺省 null → `igniteTnt()` 返回 false 且不写世界（fixture 单独构造时）。
     * ⚠️ **去重集合不在 player 侧** —— 三条引爆路径（左键 / 枪击 / 连锁到期）中后两条不经
     * player，若去重只在 player 侧，连锁路径会绕开它 → A↔B 相距 ≤2 的 TNT 永久互爆。
     * @type {((x:number,y:number,z:number)=>boolean)|null}
     */
    this._onIgniteTnt = onIgniteTnt;
    /** 当前选中的受控创造模式物品名（null = 走常规背包槽）。见 CREATIVE_SPECIALS */
    this._selectedPlaceable = null;
    // M4 武器运行时（视图模型/曳光/音频由 Game 注入；controller 随后由 Game 赋值）
    this.viewWeapon = weaponRuntime?.viewWeapon ?? null;
    this.tracerRenderer = weaponRuntime?.tracerRenderer ?? null;
    this.audioManager = weaponRuntime?.audioManager ?? null;
    /** 命中方块的特效渲染器（v1.64，Game 装配后注入；fixture 里可为 null） */
    this.blockHitFx = weaponRuntime?.blockHitFx ?? null;
    /**
     * v3.30 KV-9 卡宾枪的视图模型与特效池（Game 注入；缺省 null ⇒ 只玩法不出视觉）。
     * ⚠️ 与 `viewWeapon` **互斥**：同一时刻只能有一个第一人称武器节点挂在相机上，
     * 否则切到 KV-9 时会同时看到旧枪（两个节点重叠）。
     */
    this.carbineView = weaponRuntime?.carbineView ?? null;
    this.carbineFx = weaponRuntime?.carbineFx ?? null;
    /** Storm Lance 渲染器（v3.20，Game 注入；缺省 null ⇒ 只扣血不出视觉） */
    this.stormLanceRenderer = weaponRuntime?.stormLanceRenderer ?? null;
    /**
     * Cinder Fall 的岩石生成回调（v3.21，Game 注入）。
     * ⚠️ **注入而非 import**：player/ 不持有 EntityManager，也不依赖装配层（依赖方向 §3）。
     * 缺省 null ⇒ 只放音效不生岩石（fixture / 旧单测不注入则走缺省，不报错）。
     * @type {((launch:object)=>boolean)|null}
     */
    this.onCinderLaunch = weaponRuntime?.onCinderLaunch ?? null;
    /** @type {WeaponController | null} */
    this.weaponController = null;
    /**
     * v3.30 KV-9：相机后坐弹簧（上游 player.js 的 recoilP/Y 与 recoilVP/VY）。
     *
     * 上游：`recoilVP += (-recoilP*95 - recoilVP*15)*dt`，`recoilP += recoilVP*dt`，
     * 且 **一部分爬升留在矄准上**：`pitch += recoilVP*dt*0.22`（连射时枪口往上走）。
     * ⚠️ 那一项是**真实改变矄准**（不是纯视觉）—— 上游同口径，保留。
     * ⚠️ 只对 KV-9 生效（其余枪的 recoil 走 viewWeapon 的节点位移，不动相机）。
     */
    this._recoilP = 0;
    this._recoilY = 0;
    this._recoilVP = 0;
    this._recoilVY = 0;
    /** v3.30：意图水平速度（散布用；在物理步里写，见 `_lastInputSpeed` 赋值处） */
    this._lastInputSpeed = 0;
    /**
     * v3.30：hitstop / 震动回调（Game 注入）。缺省 null ⇒ 只扣血不出反馈
     * （fixture / 旧单测不注入则走缺省，与 `onCinderLaunch` 同一手法）。
     * @type {((seconds:number)=>void)|null}
     */
    this.onHitstop = weaponRuntime?.onHitstop ?? null;
    /** @type {((amount:number)=>void)|null} */
    this.onShake = weaponRuntime?.onShake ?? null;
    /**
     * 第一人称手臂（徒手可见 + 挖/放挥动）。由 Game 注入，同 `viewWeapon` 手法。
     * 缺省 null → 无手臂（fixture 单独构造时）。
     * @type {import('../render/view-arm.js').ViewArm | null}
     */
    this.viewArm = weaponRuntime?.viewArm ?? null;
    /**
     * 跑动视角晃动（纯逻辑，无 three —— 见 view-bob.js 文件头）。
     * 自己构造而非注入：它不依赖任何渲染资源，且 fixture 也需要它（物理一旦走动就晃）。
     */
    this.viewBob = new ViewBob();
    this.physics = new PlayerPhysics(world);
    // 矿车占据格对玩家是实心（mc-lite `Physics.isSolid` 同口径）：注入 service 而非让
    // physics import entities/（依赖方向 §3）。缺省 null → 矿车格不挡人（fixture 单独构造时）。
    this.physics.minecarts = minecarts;
    this._stepLift = new StepLift(); // 上台阶相机缓动（物理瞬时，视觉 ease-out）
    /**
     * 玩家血量（格，满 = 20）。权威常量在 `player/health.js`。
     *
     * ⚠️ **当前阶段只显示、不掉血**（用户裁定）：恒为满血，掉血逻辑由用户后续添加。
     * 血心 HUD（`ui/health-hud.js`）每帧读它换算成 10 颗心。不入存档（值恒为 20，
     * 存档字段等真做掉血时再加，避免现在白做一次 settingsVersion 迁移）。
     */
    this.health = PLAYER_MAX_HEALTH;
    this.yaw = SPAWN_YAW; this.pitch = 0;
    this.keys = new Set();
    /**
     * 背包 = 物品权威（§4.5.4 M3.1）。创造模式无限背包：122 项全量入包、
     * 每格 count=1500 占位不消耗。快捷栏是 `slots[0..HOTBAR_SIZE-1]` 的视图，不是独立容器。
     */
    this.inventory = createCreativeInventory(registry);
    this.target = null; // 当前射线命中
    /**
     * M3.2 方块朝向交互态（§4.3，对齐 mc-lite `Player.js:164,168`）。
     * 二者都是 **UI 交互态，不入世界数据、不持久化**——世界权威只有 meta 通道；
     * player 侧记录归第二阶段（v1.15 ②）。
     */
    /** 最近挖掉的方块（`{x,y,z,id,orientation}`），原位重放时的旋转依据；放置成功后清空 */
    this.lastRemovedBlock = null;
    /** 按方块类型记忆的朝向（跨位置、本次会话内持久）：`Map<id, orientation>` */
    this.placementOrientationMemory = new Map();
    /**
     * pointer lock 目标 canvas（M3.1 改为公开：面板关闭时 lock 回此处，
     * 口径见 §4.5.4——mc-lite 锁 document.body，本仓库必须锁 canvas，
     * 否则 `document.pointerLockElement !== this.canvas` 守卫会令视角与放挖全失效）
     */
    this.canvas = canvas;
    this._acc = 0;
    this._highlight = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)),
      new THREE.LineBasicMaterial({ color: 0x000000 }));
    this._highlight.visible = false;
    // M4：武器状态机。blockQuery 只读体素；editor 是唯一写世界入口；onEffect 委派回本类
    // 的 _applyWeaponEffect（视图模型/曳光/音频）。controller 不 import three、不创建 mesh。
    this.weaponController = new WeaponController({
      registry,
      blockQuery: { getBlockId: (x, y, z) => this.world.getBlockId(x, y, z) },
      editor,
      onEffect: (effect) => this._applyWeaponEffect(effect),
      // M8：枪击命中 TNT 的引爆路由。**经本类的 `igniteTnt()` 而非直接调 game** ——
      // 保持「去重只有一个入口」（红线 1）：左键挖块与枪击两条路径最终都落到
      // `game.explodeTnt()`，controller 不持有任何去重集合。
      onIgniteTnt: (x, y, z) => this.igniteTnt(x, y, z),
      // v3.30 KV-9：抖动后的弹道需要自己发一条 DDA（准心 target 是未抖动方向）。
      // 用的仍是唯一那条 DDA（player/raycast.js）—— 不写第二份射线（红线 6）。
      world: this.world,
    });
    // 事件监听器保存 bound 引用，dispose 时移除（避免重启/Playwright reload 后监听器叠加）
    this._boundHandlers = {};
    this._bindInput();
  }

  spawn(x, y, z) {
    this.physics.pos = { x, y, z };
    this._stepLift.offset = 0; // 传送不继承缓动
  }

  _bindInput() {
    const onKeyDown = (e) => {
      // 模态守卫（M3.1，§4.5.4）：设置面板/背包打开时拦截全部按键——
      // 否则模态期间新按的键仍会写入 keys（主循环虽跳过 player.update，
      // 但 keys 残留会在关闭后粘滞）并改选中格。M4 在此挂 KeyR 切武器，
      // 无守卫则面板开着按 R 会切武器并播 gun_load 音效。
      if (this._isModal()) { this.keys.clear(); return; }
      // 方向键也参与移动（v1.80）→ 需吞掉默认行为（滚动页面 / 触发聚焦元素）。
      // 只对方向键 preventDefault，不影响 F5 / F12 等浏览器快捷键。
      if (ARROW_CODES.has(e.code)) e.preventDefault();
      this.keys.add(e.code);
      if (e.code.startsWith('Digit')) {
        const n = Number(e.code.slice(5)) - 1;
        // 上限派生自 HOTBAR_ITEMS（v2.96 起 9 格）—— 与 `ui/hotbar.js` 的 DOM 格数同源
        if (n >= 0 && n < HOTBAR.length) this.hotbarIndex = n;
      }
      // M4：KeyR 循环切武器（徒手→手枪→MAG7→加特林）。非重复事件才触发，
      // 并在用户手势内解锁音频（浏览器自动播放策略）。
      if (e.code === 'KeyR' && !e.repeat) {
        void this.cycleWeapon();
        if (this.audioManager) void this.audioManager.unlock();
      }
      // M6：KeyX 生成一只丧尸（对齐 mc-lite `Game.js:155`，调试用途）。非重复事件才触发 ——
      // 否则按住 X 会以键盘重复率（约 30Hz）连续生成，瞬间填满 20 上限。
      // 上限校验由 `ZombieService.spawn()` 负责（满额返回 null），这里不重复判断。
      if (e.code === 'KeyX' && !e.repeat && this._onSpawnZombie) this._onSpawnZombie();
      // 士兵 Epic：KeyC 召唤一名士兵（上限 10 由 SoldierService.spawn 负责，这里不重复判）。
      // 同样非重复事件才触发 —— 按住 C 会以键盘重复率连续召唤。
      // C 曾是 Boss 召唤键（v2.43 改为 B），现已空闲。
      if (e.code === 'KeyC' && !e.repeat && this._onSpawnSoldier) this._onSpawnSoldier();
      // v2.43：KeyB 召唤玩家所在地图的 Boss（用户 2026-11-07：从 C 改为 B，C 不再绑定）。
      // 同样**非重复事件**才触发 —— 按住 B 会以
      // 键盘重复率（约 30Hz）连续调用，虽然 `summon` 对已占槽位幂等（返回 'exists'），
      // 但会刷出一串 toast（后一条覆盖前一条，观感是提示在闪）。
      // 不 preventDefault：B 不是浏览器功能键（与 KeyF / KeyX 同口径）。
      if (e.code === 'KeyB' && !e.repeat && this._onSummonBoss) this._onSummonBoss();
      // 飞行开关（spec 2026-10-25 §4.4）：单击 F，**非重复事件**才触发 ——
      // 按住 F 时键盘重复率约 30Hz，不判 `e.repeat` 会让飞行状态疯狂抖动。
      // 不 preventDefault：F 不是浏览器功能键（与 ARROW_CODES 只拦方向键的口径一致）。
      // 乘坐矿车期间忽略：物理步在乘坐期整段跳过，`flying` 在车里既无法生效也永远清不掉，
      // 所以干脆不让这个输入生效（spec §4.5.1）。⚠️ 不声称「因此消除了所有
      // 视觉在车上、状态说在飞」的并存态 —— 碰撞绑定那条路径仍可造出它，
      // 而 spec 本身裁定「进车不解除飞行、下车继续飞」是可接受行为。
      if (e.code === 'KeyF' && !e.repeat && !this.ridingMinecartId) this.physics.toggleFlight();
    };
    const onKeyUp = (e) => this.keys.delete(e.code);
    // pointer lock 请求必须吞掉拒绝（mc-lite Player.js:292 同款 `.catch(() => {})`）：
    // 浏览器规定退出锁后 ~1s 内不得重新锁定，用户按 Esc 后立刻点击 canvas 会抛
    // SecurityError: "Pointer lock cannot be acquired immediately after the user has
    // exited the lock."——不吞掉就是控制台未捕获错误（用户会误判为游戏坏了）。
    // 本次点击放弃锁定即可，下次点击自然成功。
    const onClick = () => {
      this.canvas.requestPointerLock().catch(() => {});
      // v1.63：首次点击即起播背景音乐（mc-lite `Player.js:292-298` 同口径 ——
      // 浏览器自动播放策略要求 AudioContext 必须在**用户手势内**恢复，故起播时机只能是点击。
      // 不另挂 document 级 click 监听：这里的 onClick 就是那个入口，再挂一个会重复解锁。
      if (this.audioManager) void this.audioManager.unlock();
    };
    const onMouseMove = (e) => {
      if (document.pointerLockElement !== this.canvas) return;
      this.yaw -= e.movementX * 0.002;
      this.pitch -= e.movementY * 0.002;
      this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.pitch));
    };
    const onMouseDown = (e) => {
      // pointer-lock 守卫保留（不得为自动化移除；无头测试只走公开 API）
      if (document.pointerLockElement !== this.canvas) return;
      if (e.button === 0) {
        if (this.audioManager) void this.audioManager.unlock();
        // 徒手左键挖掘；持枪左键按下式射击（手枪/加特林按住连射，MAG7 单发）
        if (this.weaponController.debugState().selectedId === WEAPON_IDS.ARM) {
          this.digBlock({ ctrl: e.ctrlKey, shift: e.shiftKey });
        } else this.weaponController.pointerDown(this._buildAim());
      }
      if (e.button === 2) this.placeBlock(); // 右键始终放块
    };
    const onMouseUp = (e) => {
      if (document.pointerLockElement !== this.canvas) return;
      // v3.20：传 aim —— 蓄满时 controller 靠它施放 Storm Lance。
      // （无 aim 的 `pointerUp()` 仍合法：只清状态不施法，既有单测/spec 这么调。）
      if (e.button === 0) this.weaponController.pointerUp(this._buildAim());
    };
    const onContextMenu = (e) => e.preventDefault();
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    this.canvas.addEventListener('click', onClick);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('contextmenu', onContextMenu);
    this._boundHandlers = { onKeyDown, onKeyUp, onClick, onMouseMove, onMouseDown, onMouseUp, onContextMenu };
  }

  /** 60Hz 定步长累加器（渲染帧率与物理解耦，§4.5.1） */
  update(dt) {
    // ---- 矿车乘坐（mc-lite updateMinecartRiding 语义）----
    // 必须在物理步之前跑：跟随读上帧车位（mc-lite 同序）。
    this._updateMinecartRiding(dt);
    this._acc += dt;
    const step = 1 / 60;
    let n = 0;
    // ⚠️ 乘坐期间跳过自主移动与重力：`_applyInput` 会把玩家从车上推走，
    // `physics.step` 的重力会把玩家从车顶拉下去（位置已由 _updateMinecartRiding 锁定）。
    const riding = !!this.ridingMinecartId;
    while (this._acc >= step && n < 5) {
      if (!riding) {
        const bx = this.physics.pos.x;
        const bz = this.physics.pos.z;
        this._applyInput();
        // 意图水平速度：必须在 `physics.step()` 之前读 —— step 末尾会把 vel.x/vel.z 清零
        // （无惯性手感）。该值是 `physics.move()` 刚写进去的 SPEED×输入，即「本步想走多快」。
        const inputSpeed = Math.hypot(this.physics.vel.x, this.physics.vel.z);
        // v3.30 KV-9：记下意图速度供散布用（同一个值，不重算 —— 红线 1）。
        this._lastInputSpeed = inputSpeed;
        this.physics.step(step);
        // 视角晃动**按物理步推进**（不是每渲染帧）——
        // 物理是 60Hz 定步长 + accumulator，120Hz 渲染下隔帧才走一步。若按渲染帧推进，
        // 没走物理的那些帧位移为 0 → 判据判「没在动」→ 相位每帧归零 → 永不稳定晃动。
        // 按步推进后相位严格是 12 rad/s（= speed×60），与渲染帧率无关。
        this.viewBob.update(step, {
          dx: this.physics.pos.x - bx,
          dz: this.physics.pos.z - bz,
          inputSpeed,
          jumping: !this.physics.onGround,
          // 水中阻力（v2.54）：实际位移是阻力后的、`inputSpeed` 是阻力前的，
          // 不传就会把「水中正常行走」误判成「被阻挡」→ 脚步声永不播。
          // 读 getter 而不是重算 `inWater ? 0.6 : 1`（红线 1：阻力系数只有 physics 一份权威）。
          drag: this.physics.horizontalDrag,
        });
      } else {
        // 乘坐期物理不跑（位置由矿车锁定）→ 无自主位移，晃动自然衰减到 0
        this.viewBob.update(step, { dx: 0, dz: 0, inputSpeed: 0 });
        this._lastInputSpeed = 0;
      }
      this._acc -= step; n++;
    }
    // 消费本帧 step-up 抬升：物理已瞬时到位，相机从旧高度 ease-out 追平
    if (this.physics.stepLiftAccum > 0) {
      this._stepLift.trigger(this.physics.stepLiftAccum);
      this.physics.stepLiftAccum = 0;
    }
    this._stepLift.update(dt);
    // 跑动脚步声（v2.51；v2.54 改读 `viewBob.walking`）。**判据读 `walking` 而不是 `active`**：
    // 两者共用 `ViewBob.shouldBob()` 同一份实现，区别只在 `active` 强制 `drag: 1`（镜头，水中不晃，
    // 用户裁定 2026-11-05）、`walking` 按真实阻力折算（水中 ratio 回到 1.0 → 能播）。
    // 旧版读 `active` 的后果：本仓物理有水中阻力（mc-lite 没有）→ 水中 actual/expected 恒 0.6
    // < fullSpeedRatio 0.95 → `active` 恒 false → 水中脚步声 **永不播**（实测 0/120 帧）。
    // 每帧调一次：`playLoop` 同名已在播时只改音量，不会重启（否则听到断续“哒哒哒”）。
    this._updateFootsteps();
    // 相机同步（眼高 1.62 + 台阶缓动偏移 + 跑动晃动）
    // ⚠️ 晃动**融进这一次全量 set**，不得改成 `camera.position.x += bob`：
    // 那样上一帧的偏移会被下一帧当基线继承，逐渐累积漂移（本方法每帧都会重写位置，
    // 全量 set 天然幂等）。
    const p = this.physics.pos;
    const bob = this.viewBob.offset;
    /**
     * v3.30 KV-9：相机后坐弹簧推进（上游 player.js:85-88 逐字）。
     *
     * ⚠️ **必须在写相机姿态之前推进**：本帧的 recoilP/Y 要进本帧的相机。
     * ⚠️ **矄准爬升（pitch += recoilVP*dt*0.22）是真实改变矄准**（上游同口径）：
     * 连射时枪口往上走，玩家得往下拉 —— 那是后坐力手感的一部分。
     * 它写进 `this.pitch`（与鼠标输入同一个字段）⇒ 与转向/射线完全同源。
     * ⚠️ 非 KV-9 时四个量恒 0 ⇒ 本段是四次乘加，成本在噪声内（无需门控）。
     */
    this._recoilVP += (-this._recoilP * 95 - this._recoilVP * 15) * dt;
    this._recoilVY += (-this._recoilY * 95 - this._recoilVY * 15) * dt;
    this._recoilP += this._recoilVP * dt;
    this._recoilY += this._recoilVY * dt;
    if (this._recoilVP !== 0 || this._recoilVY !== 0) {
      this.pitch += this._recoilVP * dt * 0.22;
      this.yaw += this._recoilVY * dt * 0.22;
      // pitch 钳制（与鼠标输入同一上限，防连射把视角翻过头）。
      // ⚠️ 上限表达式与 onMouseMove 处逐字一致（不另写常量 —— 两处必须同值）。
      this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.pitch));
    }
    const camY = p.y + EYE_HEIGHT + this._stepLift.offset + bob.y;
    this.camera.position.set(p.x + bob.x, camY, p.z);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(this.yaw);
    this.camera.rotateX(this.pitch);
    // 跑动旋转分量（v1.49）：在相机基准姿态**之后**叠加，否则会被前面的
    // `rotation.set(0,0,0)` 清掉。
    // ⚠️ **必须叠加在已构造好的 yaw/pitch 之后（局部轴）**，不得先把 roll 加进 `this.yaw` ——
    // 那会把视角的“水平方向”一起转，玩家会撞向侧面（roll 是**镜头歪头**，不是转头）。
    // pitch 用 `rotateX`（局部轴，与 `rotateX(this.pitch)` 同轴），roll 用 `rotateZ`。
    // 幅度由 `viewBob` 自己按 amount 缩放 → 静止时严格为 0，不会残留歪头。
    this.camera.rotateX(this.viewBob.pitch);
    this.camera.rotateZ(this.viewBob.roll);
    // v3.30 KV-9：后坐的相机分量（局部轴，同上口径）。非 KV-9 时恒 0。
    if (this._recoilP !== 0) this.camera.rotateX(this._recoilP);
    if (this._recoilY !== 0) this.camera.rotateY(this._recoilY);
    // 每帧 1 次主射线（§4.5.2）；原点用相机视觉位置（含晃动偏移），交互与画面一致
    const dir = new THREE.Vector3(0, 0, -1).applyEuler(this.camera.rotation);
    const cp = this.camera.position;
    const r = raycastVoxel(this.world, [cp.x, cp.y, cp.z], [dir.x, dir.y, dir.z], REACH);
    this.target = r.hit ? r : null;
    if (this.target) {
      this._highlight.visible = true;
      this._highlight.position.set(r.blockPos[0] + 0.5, r.blockPos[1] + 0.5, r.blockPos[2] + 0.5);
    } else this._highlight.visible = false;
    // M4：武器状态机推进（按住连射/冷却）、视图模型动画、曳光寿命。
    // aim 每帧从当前相机姿态重建（plain arrays），控制器不 import three。
    const aim = this._buildAim();
    this.weaponController.update(dt, aim);
    if (this.viewWeapon) this.viewWeapon.update(dt, { shooting: this.weaponController.debugState().triggerHeld });
    if (this.viewArm) this.viewArm.update(dt);
    if (this.tracerRenderer) this.tracerRenderer.update(dt, aim);
  }

  /**
   * 跑动脚步声（v2.51，用户 2026-11-04：「跑步的声音」；v3.38 加雨天湿地档）。
   *
   * 三档地表，选哪一路由 `footstep-surface.js` 的 `footstepSurfaceOf()` 决定（唯一权威）：
   *   · `water` 入水（`physics.inWater`）→ `running_wet` 0.25；
   *   · `wet` 雨天被雨淋着的湿地 → `running_wet` **0.2**（v3.38，用户 2026-11-24）；
   *   · `land` 其余 → `running_land` 0.2。
   * 音量与「入水换音效」的语义照搬 mc-lite `PlayerInteraction.js:911-915`。
   *
   * 判据用 `viewBob.walking`（v2.54；单一权威在 `ViewBob.shouldBob`，按水中阻力折算）
   * + `physics.inWater` + 注入的 `_isRainWetGround()`，停下或上台阶时两路一起停
   * （`stopLoop` 幂等，重复调用无成本）。
   *
   * ⚠️ **不得改回读 `viewBob.active`**：`active` 是镜头判据（强制 `drag: 1`），水中恒 false
   * → 脚步声永不播（v2.51~v2.53 的实际缺陷，实测 0/120 帧）。用户裁定 2026-11-05：
   * **只让声音响、镜头保持不晃** —— 故两个标志刻意分开，不是遗漏。
   *
   * ⚠️ **v3.38：`water` 与 `wet` 共用 `running_wet` 这个 id**（同一素材、不同音量）⇒
   * 「停另一路」不能靠 id 互斥（`playLoop` 同名只改音量、不会重建），
   * 必须只停 `otherFootstepId()` 给出的那一条。
   *
   * ⚠️ **乘坐矿车时不播** —— 玩家没有自主移动，播放会变成“车开着我却一直在跑”。
   */
  _updateFootsteps() {
    const am = this.audioManager;
    if (!am) return;
    const walking = this.viewBob.walking && !this.ridingMinecartId;
    if (!walking) {
      am.stopLoop('running_land');
      am.stopLoop('running_wet');
      return;
    }
    /**
     * `_isRainWetGround` 缺省 null（fixture）⇒ `onRainWetGround` 为 false ⇒ `land`。
     * 谓词抛错不得弄崩帧循环：本函数在每帧的 `update()` 里调，一次异常就是黑屏。
     */
    let wetGround = false;
    if (typeof this._isRainWetGround === 'function') {
      try { wetGround = this._isRainWetGround() === true; } catch { wetGround = false; }
    }
    const surface = footstepSurfaceOf({
      inWater: this.physics.inWater === true,
      onRainWetGround: wetGround,
    });
    const loop = FOOTSTEP_LOOPS[surface];
    const other = otherFootstepId(surface);
    if (other) am.stopLoop(other);
    am.playLoop(loop.id, loop.volume);
  }

  /**
   * 矿车乘坐（设计文档 §4.4）。在物理步之前跑 —— 跟随读上帧车位（mc-lite 同序）。
   * 绑定：站在车顶 ±容差内且不在重绑冷却；跟随：按车位移增量推玩家（y 锁车顶）；
   * 下车：空格（起跳 + 重绑冷却）或水平偏离超阈值。
   * @param {number} dt 秒
   */
  _updateMinecartRiding(dt) {
    if (!this.minecarts) return;
    if (this._remountCooldown > 0) this._remountCooldown -= dt;
    // 空格边沿状态复位。**必须放在函数顶部（两个分支之前）** —— 乘坐分支末尾有
    // `return`，若复位只写在未绑定分支里，一旦绑定成功 `_spaceReleased` 就永远回不到
    // true → **空格下车彻底失效**（实测确认：按住空格上车 → 松开 → 再按，状态机卡在
    // false，永不下车）。边沿触发的正确语义 = 「先松开再按才能下车」，两个分支都要复位。
    if (!this.keys.has('Space')) this._spaceReleased = true;
    const p = this.physics.pos;

    if (this.ridingMinecartId) {
      const entity = this.minecarts.entities.get(this.ridingMinecartId);
      // 车已消失（拾取/爆炸/卸载）→ 立即解绑
      if (!entity || entity.type !== MINECART_TYPE) {
        this.ridingMinecartId = null;
        this._lastRidePos = null;
        return;
      }
      const [cx, cy, cz] = entity.state.position;
      // 跟随增量（mc-lite：dx/dz = 车位 − 上帧车位）。
      // ⚠️ **分轴障碍检测**（设计文档 §4.4）：各轴单独试探，被挡的那一轴不推进 ——
      // 否则车穿过低矮隧道会把玩家 AABB 埋进实心块，下车后 `_moveAxis` 二分收敛到
      // 零位移 → 玩家卡死。y 仍锁车顶（车顶净空由矿车移动的 ⑥/⑦ 分支保证：
      // 前方玩家头顶无空间则停车，有空间则抬玩家）。
      // ⚠️ **排除自己乘坐的这辆车**：mc-lite `checkAABBExcludeMinecart` 把其他矿车也当障碍；
      // 本仓库 `collidesAt` 只查方块（矿车不是方块）→ 天然不会把自己乘坐的车当障碍。
      // 「其他矿车当障碍」那一层**不做**（controller 裁定）：矿车-矿车碰撞已由
      // `planMinecartStep` 的相向/追尾逻辑处理（两车都停）→ 玩家跟随自然停下 ——
      // 记入偏离表（Task 8 写文档）。
      // 跟随段**无条件应用**车位增量（对齐 mc-lite `Player.js:568-609`）。
      // ⚠️ **不得在此处加任何位移阈值钳制**：模态期的基线冻结由 `syncRideBaseline()`
      // （Game 在 `player.update` 被门控时每帧调用）负责刷平；而相向碰撞回弹是
      // **合法单帧位移**（实测 1.9986 格，`lastTrack` 整格回弹），钳制会把它削减到
      // 偏离阈值 0.6 以上 → **同帧把乘客甩下车**（实测复现）。
      if (this._lastRidePos) {
        const dx = cx - this._lastRidePos[0];
        const dz = cz - this._lastRidePos[2];
        const topY = cy + MINECART.rideHeight;
        if (dx !== 0 && !this.physics.collidesAt(p.x + dx, topY, p.z)) p.x += dx;
        if (dz !== 0 && !this.physics.collidesAt(p.x, topY, p.z + dz)) p.z += dz;
      }
      p.y = cy + MINECART.rideHeight;
      this.physics.vel.y = 0;
      this._lastRidePos = [cx, cy, cz];
      // 水平偏离超阈值 → 自动下车。⚠️ **从车中心（`position + 0.5`）量是有意偏离 mc-lite**：
      // mc-lite 从块角量（`|player.x − minecart.position.x|`）而绑定判据是
      // `getMinecartAt(floor(player.x), …)` → 玩家站在车的**远半格**（如 cx+0.7）时
      // deviation=0.7 > 0.6 → **人还在车上就被自动下车**。本仓库从车中心量（与渲染原点
      // 换算同源）：cx+0.7 时 deviation=0.2 → 保持乘坐；走到 cx+1.2（真离车）时 0.7 > 0.6
      // → 下车。符合设计文档 §4.4 的意图（「水平偏离车中心 > 0.6」）—— 记入偏离表。
      if (Math.abs(p.x - (cx + 0.5)) > MINECART.dismountDeviation
          || Math.abs(p.z - (cz + 0.5)) > MINECART.dismountDeviation) {
        this.ridingMinecartId = null;
        this._lastRidePos = null;
        // ⚠️ 解绑后必须 return —— 否则同帧按空格会再触发一次 dismountJump + 重绑冷却
        // （空格分支不重新检查 ridingMinecartId）。
        return;
      }
      // 空格下车（边沿触发）
      if (this.keys.has('Space') && this._spaceReleased) {
        this._spaceReleased = false;
        this.physics.dismountJump();   // 下车起跳（常量单一权威在 physics.js，不得写 10.0 字面量）
        this.ridingMinecartId = null;
        this._lastRidePos = null;
        this._remountCooldown = MINECART.remountCooldown;
      }
      return;
    }

    // 未绑定：检测脚下是否有车（重绑冷却内不绑）
    if (this._remountCooldown <= 0) {
      const car = this.minecarts.ridingCarFor([p.x, p.y, p.z]);
      if (car) {
        this.ridingMinecartId = car.id;
        this._lastRidePos = [...car.state.position];
        // ⚠️ 绑定时强制「空格未释放」—— 玩家跳上车时通常还按着空格，若此时
        // `_spaceReleased` 仍为 true，第一个乘坐帧就会触发下车（立即被弹下）。
        // 边沿触发的正确语义：要求先松开空格再按才能下车（复位在函数顶部）。
        this._spaceReleased = false;
      }
    }
  }

  /**
   * 模态期刷新乘坐基线（`game.js` 在 `player.update` 被 `!uiModal` 门控时每帧调用）。
   *
   * 为什么需要：模态开着时 `player.update` 被跳过（→ 本类的 `_updateMinecartRiding` 不跑，
   * 而 `_lastRidePos` 冻结），但 `game.js` 的 `entities.update` **不受门控** → 矿车继续移动。
   * 不刷基线的话，解除模态那一帧的跟随增量 = 模态期**全部累积位移**（实测 6.02 格），
   * 且该增量在偏离检查**之前**应用 → 玩家瞬移到车的位置（可穿墙）。每帧把基线刷成车位，
   * 解除模态那帧的增量退化为**至多一帧车位移**（实测 0.0164 格）；车已走远时由
   * `_updateMinecartRiding` 既有的偏离检查自然下车。
   *
   * **这是模态侧唯一的同步点** —— 模态期不得改调 `_updateMinecartRiding`（那会连带执行
   * 空格下车 / 自动重绑 / 相机同步，爆炸半径更大）。
   *
   * 只写 `_lastRidePos`：不移动玩家、不碰 y、不碰 `ridingMinecartId`。
   */
  syncRideBaseline() {
    if (!this.minecarts) return;
    if (!this.ridingMinecartId) return;
    const entity = this.minecarts.entities.get(this.ridingMinecartId);
    // 车已消失（拾取/爆炸/卸载）→ 清基线，但**不**解绑（解绑是 `_updateMinecartRiding` 的职责，
    // 且模态期没有跟随逻辑需要它）。基线为 null 时跟随段整段跳过，不会用陈旧车位算增量。
    if (!entity || entity.type !== MINECART_TYPE) {
      this._lastRidePos = null;
      return;
    }
    this._lastRidePos = [...entity.state.position];
  }

  /**
   * 从当前相机姿态构建 aim 快照（plain arrays，供无 three 的控制器消费）。
   * 每次调用实时读取 camera.position / getWorldDirection / quaternion 与当前 player.target，
   * 不使用帧缓存——fireWeaponOnce 等公开 API 必须拿到调用时刻的姿态。
   * @returns {{origin:number[], forward:number[], right:number[], up:number[], target:object|null}}
   */
  _buildAim() {
    const pos = this.camera.position;
    this.camera.getWorldDirection(_forward);
    _right.crossVectors(_forward, _up.set(0, 1, 0)).normalize();
    _up.crossVectors(_right, _forward).normalize();
    return {
      origin: [pos.x, pos.y, pos.z],
      forward: [_forward.x, _forward.y, _forward.z],
      right: [_right.x, _right.y, _right.z],
      up: [_up.x, _up.y, _up.z],
      // v1.64：`normal` = 命中面法线（`raycastVoxel` 已经算好了，此前被丢掉）。
      // 命中特效靠它把碎块朝被打的那一面外推、并选出正确的面贴图/平均色。
      target: this.target
        ? { hit: true, blockPos: this.target.blockPos, normal: this.target.normal, dist: this.target.dist }
        : null,
      // v3.30 KV-9：散布需要「是否着地」与「水平速度」（上游 fire() 的 spr 两项）。
      // ⚠️ 速度用**意图速度**而不是 physics.vel：step() 末尾会把 vel.x/z 清零
      // （无惯性手感）⇒ 读它恒近 0，移动散布永不生效（静默失效）。
      grounded: this.physics.onGround,
      speed: this._lastInputSpeed ?? 0,
    };
  }

  /** 效果事件统一出口：视图模型后坐 → 曳光 → 音效 → 命中特效（顺序固定，M4 规格 §4.2）。 */
  _applyWeaponEffect(effect) {
    // v3.20 Storm Lance：三种新事件在这里分流，**都不调 `viewWeapon.onShot`**。
    // ⚠️ 理由：`onShot` 对非 melee 事件写 `this._recoil = effect.recoil`，而蓄力事件
    // 本不应产生后坐；就算 controller 已给 recoil:0，让剑体在蓄力/施放时跑一遗后坐衰减
    // 也是错的观感。分流后剑体姿态完全由挥砍动画控制。
    if (effect.type === 'storm-charge-start' || effect.type === 'storm-charge-ready'
      || effect.type === 'cinder-charge-start' || effect.type === 'cinder-charge-ready') {
      if (this.audioManager) this.audioManager.play(effect.sound, effect.volume);
      return;
    }
    /**
     * v3.21：第三秒大招 —— 抛出飞行岩石。
     * ⚠️ **命中不在这里判**：岩石是实体，后续帧由 `Game._updateCinders()` 逐步判定
     * （用户：「扔出去的球只要碰到实体方块…或者丧尸或者 boss 都爆炸」）。
     * ⚠️ **同样不调 `viewWeapon.onShot`**（蓄力类招式不应产生后坐）。
     * ⚠️ **漏这一支的形态是静默的**：事件发了、音效响了、但天上没岩石
     * （落到下面的通用分支，而它只认 tracer/impacts）—— 本轮实测踩到。
     */
    if (effect.type === 'cinder-fall') {
      if (this.audioManager) this.audioManager.play(effect.sound, effect.volume);
      if (this.onCinderLaunch) this.onCinderLaunch(effect.launch);
      return;
    }
    if (effect.type === 'storm-lance') {
      if (this.audioManager) this.audioManager.play(effect.sound, effect.volume);
      if (this.stormLanceRenderer) this.stormLanceRenderer.fire(effect, performance.now());
      // 落点音（与 TNT 爆炸同一条素材）—— 只在真的有落点时响
      if (this.audioManager && effect.impactSound && effect.length > 0) {
        this.audioManager.play(effect.impactSound, effect.impactVolume ?? 0.4);
      }
      return;
    }
    if (this.viewWeapon) this.viewWeapon.onShot(effect);
    // v3.30 KV-9：卡宾枪的视觉走**独立路径**（上游 fire() 的视觉段）。
    // ⚠️ 上面那行 `viewWeapon.onShot` 对 KV-9 无害：它此时 node 为 null（已 unmount）。
    if (effect.carbineTracer || effect.type === 'carbine-reload-start'
      || effect.type === 'carbine-reload-stage') {
      this._applyCarbineEffect(effect);
      return;
    }
    // v2.65 近战剑：effect 无 `tracer`（剑不发曳光）—— 判存在才 spawn，枪行为逐位不变
    if (this.tracerRenderer && effect.tracer) this.tracerRenderer.spawn(effect);
    if (this.audioManager) this.audioManager.play(effect.sound, effect.volume);
    // 士兵 Epic：枪响通知班组（48 格内 patrol 士兵转 search 并走向声源）。
    // ⚠️ 只枪类走到这里 —— 近战剑在上面已 return，故挥刀不会惊动士兵（上游 hearShot 同源）。
    if (this._onPlayerShot) {
      const p = this.physics.pos;
      this._onPlayerShot([p.x, p.y, p.z]);
    }
    // v2.65 近战剑：砍中敌人的音效（`emp_activated`）—— 与挥砍音分开：
    // 挥空也响 `effect.sound`（player_swing），只有命中才响 `hitSound`。
    if (this.audioManager && effect.hitSound) {
      this.audioManager.play(effect.hitSound, effect.hitVolume ?? 1);
    }
    // v2.51：枪击摧毁方块 → 销毁音效（用户 2026-11-04：「销毁方块的声音」）。
    // 判据 = `impacts[].destroyed`（控制器在**写入删除之前**读到的真实结果），
    // 不是“枪开了就播”。普通枪最多 1 个 impact，MAG7 是 1 个带 `stagger` 的 impact
    // → 一次散弹只播一次，不会 40 连击音。
    // 音量与徒手挖块同一档（0.6，见 `digBlock` 处的 v2.53 裁定注释）。
    if (this.audioManager && effect.impacts?.some((imp) => imp.destroyed)) {
      this.audioManager.play('delete', 0.6);
    }
    // v1.64：方块被击碎/击中的特效（白闪 + 碎块；MAG7 只有白闪）。
    // 纯视觉，池满丢最旧，不回头影响玩法状态。
    if (this.blockHitFx) this.blockHitFx.spawnFromEffect(effect, performance.now());
  }

  /**
   * v3.30 KV-9：卡宾枪的效果事件消费（上游 fire() 的视觉/听觉段）。
   *
   * 三类事件：
   *   · 开火（带 carbineTracer）→ 视图模型 kick + 火光、五个特效池、枪声、
   *     命中音、hitstop / 震动；
   *   · carbine-reload-start → 无额外动作（视图模型自己读 reloadT 摆姿态）；
   *   · carbine-reload-stage → 播对应那一段换弹音。
   *
   * ⚠️ **不调 blockHitFx.spawnFromEffect**：KV-9 的命中反馈是上游那套
   * （火花 + 烟尘 + 弹孔），与本仓既有枪的「白闪 + 碎块」是**两套不同的观感**。
   * 同时播会互相打架（白闪盖住火花）。方块破坏本身仍由 controller 走 editor（玩法不变）。
   * ⚠️ **hitstop / 震动的回调由 Game 注入**（player/ 不反向依赖 core/，依赖方向 §3）。
   *
   * @param {object} effect
   */
  _applyCarbineEffect(effect) {
    const am = this.audioManager;
    if (effect.type === 'carbine-reload-start') return;   // 视图模型自己读 reloadT
    if (effect.type === 'carbine-reload-stage') {
      if (am && effect.sound) am.play(effect.sound, effect.volume ?? 0.5);
      return;
    }
    // ---- 开火 ----
    const view = this.carbineView;
    if (view?.mounted) view.onShot();
    if (am) am.play(effect.sound, effect.volume);
    // 后坐冲量 → 相机弹簧（上游 player.recoil(p,y)：vel += p*34）
    if (effect.carbineKick) {
      this._recoilVP += effect.carbineKick.pitch * 34;
      this._recoilVY += effect.carbineKick.yaw * 34;
      this.onShake?.(effect.carbineKick.trauma);
    }
    // 五个特效池（需要世界空间的枪口/抛壳口与相机基底）
    const fx = this.carbineFx;
    if (fx && view?.mounted) {
      const aim = this._buildAim();
      /**
       * ⚠️⚠️ **取完一个锚点就立刻展开成数组，不要持有 Vector3 引用**
       * （本轮用户实玩报告「曳光起点偏右」的根因）：
       * 旧写法 `const mw = view.muzzleWorld(); const pw = view.portWorld();`
       * 两个方法曾共用同一个 scratch ⇒ 对象字面量在两次调用之后才求值
       * ⇒ `muzzle` 读到的是 **port** 坐标 ⇒ 曳光从抛壳口射出。
       * 渲染层已拆成两个独立 scratch（第一道防线）；这里再改成
       * 「取完立即快照」作第二道防线 —— 即使将来又改回共享 scratch 也不会错。
       */
      const mw = view.muzzleWorld();
      const muzzle = [mw.x, mw.y, mw.z];
      const pw = view.portWorld();
      const port = [pw.x, pw.y, pw.z];
      const r = fx.spawnFromEffect(effect, {
        muzzle,
        port,
        right: aim.right, up: aim.up, forward: aim.forward,
        playerVel: [this.physics.vel.x, this.physics.vel.y, this.physics.vel.z],
      }, performance.now());
      if (am && r.impactSound) am.play(r.impactSound, 0.4);
    }
    // 命中实体：提示音 + hitstop + 额外震动（上游区分击杀/未死）
    if (effect.carbineHit) {
      if (am) am.play(effect.carbineHit.killed ? 'carbine_kill' : 'carbine_hit', 0.5);
      this.onHitstop?.(effect.carbineHit.hitstop);
      this.onShake?.(effect.carbineHit.trauma);
    }
    // 方块真被破坏 → 销毁音（与既有枪同口径）
    if (am && effect.impacts?.some((i) => i.destroyed)) am.play('delete', 0.6);
  }

  /**
   * 选择武器（公开 API）。先由控制器校验/切换，再异步加载视图模型；
   * 非徒手时播放 gun_load。模型加载失败不阻塞玩法（控制器仍可开火）。
   * @param {string} id @returns {Promise<string>} 当前选中 id
   */
  async selectWeapon(id) {
    if (!this.weaponController.select(id)) return this.weaponController.debugState().selectedId;
    /**
     * v3.30 KV-9：视图模型**互斥**切换。
     *
     * ⚠️ **两边都要显式做**：只 mount 不 unmount 会两个枪节点重叠；
     * 只 unmount 不 mount 则 KV-9 没枪（而弹药/音效/特效全对 —— 静默失效）。
     * ⚠️ `viewWeapon.select(id)` 对 KV-9 会因 `WEAPONS[id]` 存在而去加载 GLB，
     * 而 catalog 的 `model: 'carbine'` 在 `WEAPON_ASSET_URLS` 里没有 ⇒ 报错。
     * 故 KV-9 **不走 viewWeapon.select**，而是让它 select(ARM) 把旧节点摸掉。
     */
    const isCarbine = !!WEAPONS[id]?.carbine;
    if (isCarbine) {
      if (this.viewWeapon) await this.viewWeapon.select(WEAPON_IDS.ARM);
      this.carbineView?.mount();
    } else {
      this.carbineView?.unmount();
      if (this.viewWeapon) await this.viewWeapon.select(id);
    }
    /**
     * ⚠️⚠️ **两个分支都要清特效与后坐**（本轮浏览器实测）：
     * 初版只在「进入 KV-9」分支清 ⇒ **切走时弹壳/曳光永久留在画面上**
     * （已 unmount 的枪不再抛壳，但旧弹壳还在地上躺着直到 3.5s 寿命——
     * 而玩家已经拿着加特林了）。切枪即清是上游 `reset()` 的语义。
     */
    this.carbineFx?.clear();
    this._recoilP = this._recoilY = this._recoilVP = this._recoilVY = 0;
    // 手臂与持枪视图模型互斥：arm 时显示手臂，其余隐藏（mc-lite `updateArm` 同口径）
    if (this.viewArm) this.viewArm.setWeapon(id);
    // v2.65：近战剑不播 gun_load（那是枪的上膛音；剑的出场音就是挥砍时的 player_swing）
    // v3.30：KV-9 也不播 —— 它有自己的三段换弹音，叠一声 gun_load 会多一响。
    const weapon = WEAPONS[id];
    if (id !== WEAPON_IDS.ARM && !weapon?.melee && !weapon?.carbine && this.audioManager) {
      this.audioManager.play('gun_load', 0.4);
    }
    return this.weaponController.debugState().selectedId;
  }

  /** R 键循环切武器（与键鼠同路径）。@returns {Promise<string>} */
  async cycleWeapon() {
    const next = this.weaponController.cycle();
    return this.selectWeapon(next);
  }

  /** 自动化测试入口：走与键鼠完全相同的控制器路径，仍遵守冷却。@returns {object[]} */
  fireWeaponOnce() {
    return this.weaponController.fireOnce(this._buildAim());
  }

  /**
   * 仅测试的朝向 helper（M6 plan Task 3）：把「看向某个世界点」翻译成 yaw/pitch，
   * 并**在同一帧重新计算 DDA target**。
   *
   * 为什么需要它（无头环境的约束）：Playwright 无真实键鼠/pointer lock，`onMouseMove` 有
   * `document.pointerLockElement !== this.canvas` 守卫 → 无法用真实输入转向。而无头测试
   * 需要精确瞄准某只丧尸来验证实体伤害。
   *
   * **它不绕过 WeaponController，也不替换真实 pointer-lock 输入**（M6 plan Task 3 明确口径）：
   * 只写 `this.yaw`/`this.pitch`（真实输入路径写的同一对字段），再跑一遍 `update()` 里
   * 同款的相机姿态 → DDA 射线流程，让 `this.target` 与画面一致。之后 `fireWeaponOnce()`
   * 走的仍是 `_buildAim()` + controller 状态机，与键鼠路径完全相同。
   *
   * 为什么必须重算 target：`_buildAim()` 读的是 `this.target`（上一帧的 DDA 结果）。只改
   * yaw/pitch 不重算 → 射线方向变了但 target 还是旧的 → 命中判定用的是旧方向（实测踩坑：
   * 手动设 yaw/pitch 后开火，实体没被命中）。
   *
   * @param {number[]} dir 从相机指向目标的向量（世界空间，无需归一化）
   * @returns {{yaw: number, pitch: number, target: object|null}}
   */
  setTestAim(dir) {
    const len = Math.hypot(dir[0], dir[1], dir[2]);
    if (!(len > 0)) return null;
    // 与 `onMouseMove` 同一约定：yaw 绕 Y 轴（atan2(-x, -z) 使 -Z 为前方）、pitch 绕 X 轴，
    // 并钳在与真实输入相同的范围内（±(π/2 - 0.01)，防止万向锁/射线退化）
    this.yaw = Math.atan2(-dir[0], -dir[2]);
    this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, Math.asin(dir[1] / len)));
    // 同一帧重算相机姿态 + DDA target（与 update() 里的流程同款）
    const p = this.physics.pos;
    const camY = p.y + EYE_HEIGHT + this._stepLift.offset;
    this.camera.position.set(p.x, camY, p.z);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(this.yaw);
    this.camera.rotateX(this.pitch);
    const forward = new THREE.Vector3(0, 0, -1).applyEuler(this.camera.rotation);
    const r = raycastVoxel(this.world, [p.x, camY, p.z], [forward.x, forward.y, forward.z], REACH);
    this.target = r.hit ? r : null;
    return { yaw: this.yaw, pitch: this.pitch, target: this.target };
  }

  /** 设置普通枪是否破坏方块（MAG7 不受限）。@param {boolean} enabled @returns {boolean} */
  setGunBlockDamage(enabled) {
    return this.weaponController.setBlockDamage(enabled);
  }

  /**
   * 只读调试状态（合并控制器 + 曳光池 + 视图模型 + 音频请求计数）。
   * @returns {{selectedId:string, cooldown:number, triggerHeld:boolean, shotsFired:number,
   *            activeTracers:number, lastEffect:object|null, viewLoaded:boolean, audioPlayRequests:number}}
   */
  weaponDebugState() {
    const base = this.weaponController.debugState();
    let audioPlayRequests = 0;
    if (this.audioManager) {
      for (const n of this.audioManager.playRequests.values()) audioPlayRequests += n;
    }
    return {
      ...base,
      activeTracers: this.tracerRenderer ? this.tracerRenderer.activeCount : 0,
      viewLoaded: this.viewWeapon ? this.viewWeapon.state.loaded : false,
      audioPlayRequests,
    };
  }

  _applyInput() {
    // 方向控制：WASD 与**方向键**等价（用户 v1.80 要求「asdw 可以控制方向之外，
    // 让键盘的方向键也可以控制方向」）。两套键共用同一判定 → 同时按不叠加（取 1 不取 2）。
    const k = this.keys;
    const fwd = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) -
                (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const strafe = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) -
                   (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    if (fwd || strafe) {
      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
      this.physics.move(-sin * fwd + cos * strafe, -cos * fwd - sin * strafe);
    }
    // 飞行态：空格/Shift 是垂直输入（原版口径），不是跳跃/潜行。
    // 升降同按时取差 → 0 = 悬停（原版同口径，不是「两个动作互相取消」）。
    // ⚠️ 非飞行态的分支必须保留原样：地面上的空格仍是 `jump()`，Shift 在键位层面不产生任何位移。
    if (this.physics.flying) {
      const up = k.has('Space') ? 1 : 0;
      const down = (k.has('ShiftLeft') || k.has('ShiftRight')) ? 1 : 0;
      this.physics.moveVertical(up - down);
    } else if (k.has('Space')) this.physics.jump();
  }

  /**
   * 矿车交互射线（拾取/激活共用）。**实体命中唯一入口 = EntityManager.raycast**
   * （红线 6），与 DDA 方块命中做最近距离比较（M6 统一遮挡口径）：
   * 实体更近才命中 —— 矿车在墙后点不到。
   * ⚠️ 射程 = `MINECART.interactRange`（15 格，mc-lite 同值），**不是** DDA 的 REACH=40。
   * @returns {{id: string, dist: number}|null}
   */
  _raycastMinecart() {
    if (!this.minecarts) return null;
    // 射线从相机沿视线（与 _buildAim 同源口径）
    const pos = this.camera.position;
    const dir = new THREE.Vector3(0, 0, -1).applyEuler(this.camera.rotation);
    const entities = this.minecarts.entities;
    const hit = entities.raycast([pos.x, pos.y, pos.z], [dir.x, dir.y, dir.z],
      MINECART.interactRange, (entity) => entity.type === MINECART_TYPE);
    if (!hit) return null;
    // 方块遮挡：DDA 命中更近 → 矿车被挡住
    if (this.target && this.target.hit && !(hit.dist < this.target.dist)) return null;
    return hit;
  }

  /**
   * 挖块（徒手左键）。`mods` 由 `onMouseDown` 传入修饰键快照 —— 矿车交互分流需要
   * ctrl（激活）/ shift（后退）。缺省 `{}` → 不触发任何矿车分支（fixture / 测试 API 直接调）。
   * @param {{ctrl?: boolean, shift?: boolean}} [mods]
   */
  digBlock(mods = {}) {
    // 手臂挥动（v1.50 口径，对齐 mc-lite）：**只要玩家试图挖掘就挥手，不管有没有成功**。
    // mc-lite 的 `PlayerInteraction.js` 无条件 `this.swing()`——命中路径 `:199-200`
    // （`removeBlock(hit, true); this.swing();`）与**未命中**的 `else` 分支 `:207`
    // （`} else { this.swing(); }`）都挥。
    // ⚠️ **必须放在所有早退分支之前**（矿车命中 / 无 target / TNT 引爆 / 不可破坏）：
    // 放在 `setBlock` 旁边时，上面任何一个 `return` 都会让挥动静默消失（v1.49 就是这样）。
    // 这不是纯视觉细节 —— 挖掘是**按住连续点**，无反馈会让玩家以为卡住了。
    // 代价：越肩挖空气也会挥手，但这正是原版行为。
    if (this.viewArm) this.viewArm.swing();

    // 矿车交互优先（mc-lite：左键先判矿车再挖块）。ctrl+左键 = 激活；徒手左键 = 拾取。
    if (mods.ctrl || this.minecarts) {
      const hit = this._raycastMinecart();
      if (hit) {
        if (mods.ctrl) {
          this.minecarts.activate(hit.id, !!mods.shift);   // shift → 后退
        } else {
          this.minecarts.pickUp(hit.id);
        }
        return;
      }
      // ⚠️ **ctrl+左键未命中矿车时不得 `return`** —— 要继续走下面的既有挖块逻辑（含 TNT 引爆分支）。
      // 理由：mc-heavy 的 TNT 引爆已在 `digBlock()` 内（M8 交付：徒手左键命中 tnt 即引爆），
      // 若 ctrl 分支提前 return 会让「ctrl+左键点 TNT」不再引爆 —— 而当前（未改前）ctrl+左键
      // 本来就会引爆（mods 根本没被检查）→ 那是功能回退。
      // mc-lite 同口径：`PlayerInteraction.js` 的 ctrl 分支先试矿车、**再试 TNT**、最后才 return。
      // 本仓库把 TNT 交给既有 digBlock 逻辑即可（不在此重写 TNT 分支）。
    }
    if (!this.target) return;
    const [x, y, z] = this.target.blockPos;
    const id = this.world.getBlockId(x, y, z);
    // M8：命中 tnt → 引爆而非挖块。⚠️ **这是新增偏离**：mc-lite **没有**「普通左键挖块命中
    // tnt 即引爆」这条入口（它只有 ctrl+左键 `PlayerInteraction.js:172` 与枪击 `:1048`）。
    // 本仓库把徒手挖块也接成引爆，是因为 mc-heavy 的左键挖块是 `digBlock()`（无 ctrl 修饰键
    // 路径）—— 记进 M8 验收报告偏离表。
    if (id === this.registry.idOf('tnt')) { this.igniteTnt(x, y, z); return; }
    // M8：不可破坏门控改读 registry 单一权威（此前只硬拦 bedrock 字面量）。徒手拦截保留 ——
    // editor 的 bedrock 门控只覆盖 bedrock，故两处都要拦。M9 追加 playground 两项后，
    // 这一行自动覆盖它们（无需改代码 —— 单一权威的收益）。
    if (this.registry.isIndestructible(id)) return;
    // M3.2：挖前记下旧朝向（原位重放时的旋转依据）。必须在编辑之前读——
    // setBlock 会把 meta 清成 0，之后再读就丢了朝向。
    this.lastRemovedBlock = recordRemovedBlock(x, y, z, id, this.world.getBlockMeta(x, y, z));
    // M4-0：改走唯一编辑路径（remesh fast path / 事件由 WorldEditor 协调）
    const removed = this.editor.setBlock({ x, y, z, id: 0 });
    // v2.51：挖掉音效（用户 2026-11-04：「销毁方块的声音… delete.mp3」）。
    // ⚠️ **音量 0.6 是本仓裁定值，不是 mc-lite 原值**（mc-lite
    // `PlayerInteraction.js:469-585` 是 `playSound('delete_get', 0.3)`）。v2.53 用户
    // 2026-11-05：「删除方块时的声音太小，适当放大一些」→ 统一翻倍到 0.6。
    // 根因不只是那个 0.3：对调前实测素材峰值 put −13.5 dB / delete −7.8 dB，
    // 而 `gun_fire.mp3` / `explosion.mp3` 都是 0.0 dB —— 同样 0.3 的增益下放置声
    // （输出峰值 0.063）比手枪射击（0.090）还轻。用户 2026-11-05 手工对调了两个
    // 素材（现 put −7.8 dB / delete −13.5 dB，不再与 mc-lite 逐位相同），0.6 增益保留。
    // ⚠️ **判实际改动而不是无条件播**：`setBlock` 对“本来就是空气”的格返回零 changes，
    // 无条件播会让“按住左键挖空气”变成连发打击音。
    if (removed?.changes?.length > 0 && this.audioManager) {
      try { this.audioManager.play('delete', 0.6); } catch (err) {
        console.warn('[audio] delete play failed:', err);
      }
    }
    // ⚠️ 挥手**不在这里** —— 已提到函数顶部（v1.50：试图挖就挥手，与是否成功无关）。
  }

  /**
   * 引爆一格 TNT（M8）—— **薄路由**，去重判定在 `game.explodeTnt()` 内（单一权威）。
   *
   * ⚠️ **去重不放在 player 侧**：三条引爆路径（左键 / 枪击 / 连锁到期）中，后两条不经 player
   * —— 若去重只在 player 侧，连锁路径会绕开它 → A↔B 两格相距 ≤2 的 TNT 永久互爆。
   * mc-lite 的 `player.ignitingTNTs` 之所以够用，是因为它的四个入口全部在
   * `PlayerInteraction` 内（`:172`/`:617`/`:1048`/`:1083`）；本仓库的连锁队列在 `Game`，
   * 故去重必须下沉到 `Game.explodeTnt()`。
   * @param {number} x @param {number} y @param {number} z @returns {boolean} false = 已引爆过
   */
  igniteTnt(x, y, z) {
    if (!this._onIgniteTnt) return false;
    // 返回值透传 game.explodeTnt 的去重结果（false = 已引爆过）
    return this._onIgniteTnt(Math.floor(x), Math.floor(y), Math.floor(z));
  }

  /**
   * 受控创造模式选择入口（M7 规格 §2）：选中 `CREATIVE_SPECIALS` 里的物品。
   *
   * **不改 Hotbar index、不改背包槽、不改 HUD** —— 那五格的 UI 与选择语义保持原样。
   * 只置一个标志位，右键时由 `placeBlock()` 先查这个标志。未知物品返回 false 且不写世界。
   * @param {string} id @returns {boolean}
   */
  selectPlaceable(id) {
    if (!CREATIVE_SPECIALS.has(id)) return false;
    this._selectedPlaceable = id;
    return true;
  }

  placeBlock() {
    // 单格方块的落点（v2.54，用户 2026-11-05），两种情形走同一个入口 `_placeNearest()`：
    //  · **命中（不论远近）**：直接放命中面前（A = `target.prevPos`），**不看沿途候选** ——
    //    「准心对准可放置面 → 优先级永远最高」；
    //  · **打空**：沿视线**从近到远第一个可放的候选**（就近原则）。
    // ⚠️ 这**取代了 v2.25 的 15 格分流**（命中 <15 放 A、≥15 先看候选）：那道分界会让同一条
    // 视线的落点在 15 格处跳变，且与「命中优先级永远最高」矛盾。详见 `_placeNearest()` 的注释。
    // A 被玩家 AABB 占住时**不再找别处**（mc-lite `tryPlaceBlock` 失败即作罢，同款）。
    // ⚠️ 特殊物品（巢穴/炮塔/矿车）不参与就近放置：它们的 origin 取**命中格**，无命中即无合法 origin。
    if (!this.target) { this._placeByRayFallback(); return; }
    // M7：受控创造模式物品优先分流（测试 API 路径）。失败保留世界，不写任何方块。
    // ⚠️ origin 必须用 **`blockPos`（命中方块）**，不能用 `prevPos` —— 两条放置路径
    // （本分支与下方背包分流）的 origin 语义必须一致，否则结构会整体上移一格悬空
    // （实测踩坑：用 prevPos 时 38 格里 30 格落在未清理的位置 → 放置大面积失败）。
    if (this._selectedPlaceable) {
      const hit = this.target.blockPos;
      if (hit) {
        // 矿车是单格实体 → origin 用 prevPos（命中面的相邻空气格）；
        // 多格结构（巢穴/炮塔）→ blockPos（结构最低层落在命中格）。
        // ⚠️ 两条放置路径（本分支与背包分流）的 origin 语义必须一致。
        // ⚠️ prevPos 可能为 null（射线起点就在方块内的极端情况）—— 判空后再调。
        const origin = this._selectedPlaceable === MINECART_ITEM
          ? this.target.prevPos : hit;
        if (origin) this._placeSpecialSwing(this._selectedPlaceable, [origin[0], origin[1], origin[2]]);
      }
      // 成功或失败都不回落到背包槽 —— 选中态期间玩家意图明确是放巢穴，不是放石头
      return;
    }
    // §4.5.4 M3.1：取背包选中槽的物品（selectedSlot 可 > 4，由背包面板点击选中）
    const slot = this.inventory.getSelected();
    if (!slot || slot.isEmpty()) return; // 空槽不放块
    const id = this.registry.idOf(slot.item);
    if (id === undefined) return; // 无该方块（防御：物品集合与 registry 同源，正常不触发）
    // M7（**玩家主路径**）：按**物品名**分流到实体放置 —— 对齐 mc-lite
    // `PlayerInteraction.tryPlaceBlock()` 的 `entityRegistry.isSpecialBlock(type)` 路由。
    // 巢穴是 38 方块的**多格结构**，不是单格方块：从背包选中它的图标后右键，必须一次性
    // 放置整个结构 + 建巢穴实例，**绝不能落到下面的单格 setBlock**（那会放出一个贴了
    // 巢穴图案的正方体 —— 实玩报告的缺陷）。
    if (CREATIVE_SPECIALS.has(slot.item)) {
      // 多格结构（巢穴/炮塔）：origin = **命中方块所在格**（`blockPos`），不是 `prevPos`：
      // 结构最低层要落在玩家脚下的地面上（mc-lite `generateBlocks` 的 `y + block.y - 1`
      // 同口径）。用 prevPos 会让结构悬空一格（最低层落在 prevPos+1）。
      // 矿车是单格实体 → origin 用 prevPos（命中面的相邻空气格，设计文档 §4.1）。
      // ⚠️ 两条放置路径（本分支与 selectPlaceable 测试 API）的 origin 语义必须一致。
      const hit = this.target.blockPos;
      if (hit) {
        // ⚠️ prevPos 可能为 null（射线起点就在方块内的极端情况）—— 判空后再调。
        const origin = slot.item === MINECART_ITEM ? this.target.prevPos : hit;
        if (origin) this._placeSpecialSwing(slot.item, [origin[0], origin[1], origin[2]]);
      }
      return; // 分流后不回落到单格放置
    }
    this._placeNearest(id, this.target);
  }

  /**
   * 打空路径：主射线**完全未命中**时的单格放置（v1.72 兜底；v2.54 起命中一律走 A 路径，
   * 本扫描只服务打空）。
   *
   * 场景（用户报告）：玩家站在一块方块上朝下看，只能看到脚底方块的顶面，看不到它的
   * 水平侧面 —— 想把方块接续放在它东侧时，准心对准那侧的空位，主射线打空（`target`
   * 为 null）→ 以前右键完全无反应。
   *
   * 对齐 mc-lite `PlayerInteraction.js:781-806` 的 `doSkyPlace()`，判据与射程见
   * `place-ray.js`（纯函数，Tier 1 单测 `test-place-ray.js`）。
   *
   * ⚠️ **特殊物品（巢穴/炮塔/矿车）不走就近放置**：它们的 origin 语义依赖**命中格**
   *（多格结构用 `blockPos`、矿车用 `prevPos`），未命中时没有合法 origin —— 强行用
   * 候选格会让 38 格结构落在半空。保持「未命中即静默不动作」的现状。
   * @returns {boolean} 是否真的放下了一块
   */
  _placeByRayFallback() {
    // 选中态（`selectPlaceable` 测试 API）与背包里的特殊物品都不走就近放置（见上方注释）
    if (this._selectedPlaceable) return false;
    const slot = this.inventory.getSelected();
    if (!slot || slot.isEmpty()) return false;
    if (CREATIVE_SPECIALS.has(slot.item)) return false;
    const id = this.registry.idOf(slot.item);
    if (id === undefined) return false;
    return this._placeNearest(id, null);
  }

  /**
   * 单格放置的入口（v2.54）。**命中一律优先**：主射线命中任何方块（不论远近）都直接放
   * 命中面前那一格 A（`hit.prevPos`），**不看沿途候选**，A 被拒（身体守卫 / 编辑无变化）就作罢。
   * 只有**完全打空**时才走就近优先：沿视线从近到远，把每个候选格依次交给 `_placeSingle()`，
   * 第一个放成功的算数；候选被拒就继续往远处找（mc-lite `doSkyPlace` 同款）。
   *
   * ⚠️ **v2.54 取代了 v2.25 的 15 格分流**（用户 2026-11-05：「如果十字准心对准了任何一个
   * 可以放置方块的面，则优先在这个面上放置方块，这个优先级永远是最高的。只有十字准心不对准
   * 任何一个可以放置方块的面时，才采用就近原则」）。旧分流让「瞄哪儿放哪儿」在 15 格处跳变：
   * 同一条视线打到 14 格放 A、打到 16 格却放到沿途某个玩家没对准的格。
   * 连带删除：`PLACE_NEAR_HIT_DIST` 与 `scanPlaceCells` 的 `opts.stopAt`（命中不再进扫描 → 无消费者）。
   *
   * - 候选判据与「头格出局」只在 `place-ray.js` 的 `scanPlaceCells` 一处（红线 1）；
   *   身体守卫与写入只在 `_placeSingle()` 一处。
   * - 回调里放成功即中止遍历，不存在「写后读」；扫描 ≤ 15 格、仅右键触发，开销 ≤ 5 µs 量级。
   * @param {number} id 方块 id
   * @param {object | null} hit 主射线命中（`this.target`）；打空传 null
   * @returns {boolean} 是否真的放下了一块
   */
  _placeNearest(id, hit) {
    // 命中一律优先：直接放命中面前，不看沿途候选。
    // ⚠️ 不再判 `hit.dist`：v2.25 的 `typeof hit.dist === 'number'` 守卫是为了让「缺 dist 的手塞
    // target」退回扫描路径；现在命中与距离无关，手塞 target（多个既有 spec 用）与真实 target 同路。
    if (hit) {
      const [x, y, z] = hit.prevPos;
      return this._placeSingle(x, y, z, id);
    }
    // 打空：沿视线就近优先
    const cp = this.camera.position;
    this.camera.getWorldDirection(_forward);
    const r = scanPlaceCells(this.world, [cp.x, cp.y, cp.z], [_forward.x, _forward.y, _forward.z],
      (x, y, z) => this._placeSingle(x, y, z, id));
    return r.hit;
  }

  /**
   * 单格放置的唯一写入路径（v1.70 抽出）：AABB 守卫 → 朝向三分支 → `editor.setBlock`
   * → 成功清记忆并挥动。
   *
   * **唯一调用方是 `_placeNearest()`**（v2.25）：沿视线的候选格与命中面前的 A 都经此处，
   * 命中路径与打空路径共用这一份，否则会出现「一条路径有 AABB 守卫/朝向/挥动，另一条静默没有」的
   * 撕裂（M7 曾因两条放置路径不一致踩过同类坑，见 CLAUDE.md 活跃约束）。
   * 返回 false 有两种原因（被 AABB 守卫拒绝 / 编辑无变化），调用方一律当作「这格放不下」。
   * @param {number} x @param {number} y @param {number} z 放置格
   * @param {number} id 方块 id
   * @returns {boolean} 是否真的放下了一块
   */
  _placeSingle(x, y, z, id) {
    // 不与玩家自身 AABB 重叠（v2.22）。
    //
    // **必须是真实 AABB，不得退回格近似**：旧实现是
    // `x === floor(p.x) && z === floor(p.z) && (y === floor(p.y) || y === floor(p.y+1))`，
    // 玩家 AABB 是 0.6×1.8×0.6，它只覆盖玩家那一列 + 脚底/头顶两格 —— 实测 `(8.9,1,8.9)` 时
    // 有 6 格被放行但真实相交，方块嵌进玩家身体后物理把它当墙/天花板（用户报告的穿模）。
    // mc-lite `PlayerInteraction.tryPlaceBlock` 用的就是真实 AABB 精确判据，本仓移植时退化了。
    //
    // **只对实心方块拒绝**（相对 mc-lite 的**有意偏离**，它有 `isSolid` 早退但那条查的是**目标格**
    // 现状，不是「新方块会不会阻挡玩家」）：花草/水/藤/睡莲等 `solidTable === 0` 的方块放进
    // 玩家 AABB 也**不产生任何碰撞**（`physics._collides` 只读这张表），不存在穿模；
    // 这是 vanilla `Level.isUnblocked()`（只对非空碰撞形状拒绝）的口径，也是唯一会让守卫
    // 「合法地放行」的情形。
    if (this.registry.solidTable[id] === 1 && this.physics.overlapsBlock(x, y, z)) return false;
    // M3.2：算放置朝向（三分支，不看玩家 yaw）。与 M3.1 的取物品逻辑正交叠加。
    const meta = getPlacementOrientation(x, y, z, id, this.registry.orientationModesTable,
      this.lastRemovedBlock, this.placementOrientationMemory);
    // M4-0：改走唯一编辑路径。朝向作为 meta 传入——不得退化为只传 id（M3.2 语义）。
    const report = this.editor.setBlock({ x, y, z, id, meta });
    if (report.changes.length === 0) return false;
    // 放置成功后清除挖块记忆（§4.3 定稿口径：mc-lite 是算完朝向即无条件清空，
    // 本仓库改为成功后清空——放置失败时保留记忆，避免记忆跨次放置串用）
    this.lastRemovedBlock = null;
    // 手臂挥动（mc-lite `PlayerInteraction.js:143` 同语义：放置成功才 `swing()`）
    if (this.viewArm) this.viewArm.swing();
    // v2.51：放置音效（用户 2026-11-04：「放置方块… put.mp3」）。
    // ⚠️ **音量 0.6 是本仓裁定值**（mc-lite `PlayerInteraction.js:315/768` 是 0.3）——
    // v2.53 用户 2026-11-05 要求放大，与挖块同档，理由见 `digBlock` 处的注释。
    // ⚠️ 音频失败不得影响返回值：世界已经写成功，回滚会让玩家看到方块消失。
    if (this.audioManager) {
      try { this.audioManager.play('put', 0.6); } catch (err) {
        console.warn('[audio] put play failed:', err);
      }
    }
    // 创造模式不消耗：slot.count 保持 DEFAULT_INVENTORY_COUNT 不变
    return true;
  }

  /**
   * 放置受控创造模式物品（M7）。当前只有巢穴 alias。
   *
   * 以 `[x,y,z]`（准心指向格）为巢穴 **origin** —— 蓝图相对坐标以此为基点展开
   * （最低层 y=origin.y+1，关键方块 y=origin.y+5）。
   * `playerAabb` 传玩家当前 AABB：放置预检会拒绝结构压住玩家（M7 规格 §2）。
   * 成功后播放 `put` 音效（mc-lite 同语义）—— **音频失败绝不回滚世界事务**：
   * 声音只是反馈，世界写入已成功，回滚会让玩家看到「方块消失」（M7 规格 §2）。
   * @param {string} id @param {[number, number, number]} origin
   * @returns {boolean} 是否成功放置
   */
  /**
   * `_placeSpecial` 的包装：**成功才挥手**（与单格放置同语义）。
   * 两条放置路径（背包分流与 `selectPlaceable` 测试 API）都经此处，不得各自写一份 ——
   * 否则其中一条会静默没有动画（M7 实测过同类「两条路径一测一用」的撕裂）。
   * @param {string} id @param {[number, number, number]} origin
   * @returns {boolean}
   */
  _placeSpecialSwing(id, origin) {
    const ok = this._placeSpecial(id, origin);
    if (ok && this.viewArm) this.viewArm.swing();
    return ok;
  }

  _placeSpecial(id, origin) {
    // M7：巢穴分支（既有实现不变）
    if (id === NEST_ALIAS_BLOCK) {
      if (!this.nests) return false;
      // AABB 派生自 physics（不得在此重算尺寸 —— 否则与碰撞检测的 AABB 撕裂，红线 1）
      const playerAabb = this.physics.aabb();
      const result = this.nests.place({ origin, playerAabb });
      if (!result.ok) return false;
      if (this.audioManager) {
        try {
          this.audioManager.play('put', 0.6);
        } catch (err) {
          // 只记诊断，不回滚（见上方注释）
          console.warn('[audio] put play failed:', err);
        }
      }
      return true;
    }
    // M8：炮塔分支。**origin = 命中方块格**（调用方传的是 `target.blockPos`）——
    // 底座最低层要落在玩家脚下的地面格上。⚠️ 用 prevPos 会让结构整体上移一格悬空
    // （CLAUDE.md 活跃约束；M7 实测踩坑）。两条放置路径（背包分流与 selectPlaceable
    // 测试 API）的 origin 语义必须一致。
    if (id === TURRET_ALIAS_BLOCK) {
      if (!this.turrets) return false;
      // 默认朝向 = 玩家相对炮塔的方向、取最近四方向之一（mc-lite `DIRECTIONS` 语义）。
      // 函数本体在 turret-config.js（单一权威）—— 两条放置路径共用，不得各写一份。
      const rotation = defaultTurretRotation(this.physics.pos, origin);
      const result = this.turrets.place({
        origin, playerAabb: this.physics.aabb(), rotation,
      });
      if (!result.ok) return false;
      if (this.audioManager) {
        // mc-lite `TurretPlacementHandler.js:144` 是 `playSound('put', 0.3)`，与巢穴的 0.6
        // 不同；v2.53 起本仓把**所有** put/delete 统一到 0.6，这个差异刻意不再保留。
        try {
          this.audioManager.play('put', 0.6);
        } catch (err) {
          // 只记诊断，不回滚（同上）
          console.warn('[audio] put play failed:', err);
        }
      }
      return true;
    }
    // 矿车分支。⚠️ **origin 语义与巢穴/炮塔不同**：矿车是**单格实体**，放在
    // `target.prevPos`（命中面的相邻空气格）—— 玩家准心对着铁轨顶面时 prevPos 正是
    // 铁轨上方的空气格（设计文档 §4.1）。调用方传入的 origin 由 placeBlock 决定：
    // 见 `placeBlock()` 的 origin 分流（矿车用 prevPos，其余用 blockPos）。
    if (id === MINECART_ITEM) {
      if (!this.minecarts) return false;
      const result = this.minecarts.place({ cell: origin });
      if (!result.ok) return false;
      if (this.audioManager) {
        try {
          this.audioManager.play('put', 0.6);   // v2.53 统一档（mc-lite 原值 0.3）
        } catch (err) {
          console.warn('[audio] put play failed:', err);   // 只记诊断，不回滚
        }
      }
      return true;
    }
    return false;
  }

  /** 移除 window/canvas 事件监听（重启或 Playwright reload 后不叠加）。 */
  dispose() {
    const h = this._boundHandlers;
    if (h.onKeyDown) {
      window.removeEventListener('keydown', h.onKeyDown);
      window.removeEventListener('keyup', h.onKeyUp);
      this.canvas.removeEventListener('click', h.onClick);
      window.removeEventListener('mousemove', h.onMouseMove);
      window.removeEventListener('mousedown', h.onMouseDown);
      window.removeEventListener('mouseup', h.onMouseUp);
      window.removeEventListener('contextmenu', h.onContextMenu);
      this._boundHandlers = {};
    }
    if (this.viewWeapon) this.viewWeapon.dispose();
    if (this.viewArm) this.viewArm.dispose();
    if (this.tracerRenderer) this.tracerRenderer.dispose();
  }

  get highlight() { return this._highlight; }

  /**
   * 选中槽索引的兼容别名（M3.1）：真相只有 `inventory.selectedSlot`。
   * 保留别名是因为快捷栏高亮（`game.js` 每帧读）与既有 Playwright 断言
   * （`tests/m3-hud.spec.mjs`）都读 `player.hotbarIndex`。
   * 数字键写入受快捷栏 5 格上限约束；背包面板点击可令 `selectedSlot > 4`，
   * 此时读出的 `hotbarIndex` 也 > 4，快捷栏 5 格无高亮（mc-lite 同行为）。
   */
  get hotbarIndex() { return this.inventory.selectedSlot; }
  set hotbarIndex(n) { this.inventory.selectSlot(n); }
}
