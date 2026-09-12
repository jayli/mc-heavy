// src/player/player.js — 输入/视角/交互编排（§4.5）
import * as THREE from 'three';
import { raycastVoxel } from './raycast.js';
import { PlayerPhysics } from './physics.js';
import { StepLift } from './step-lift.js';
import { HOTBAR_ITEMS as HOTBAR } from './hotbar-items.js';
import { createCreativeInventory } from './inventory.js';
import { getPlacementOrientation, recordRemovedBlock } from './orientation.js';
import { WeaponController } from './weapons/weapon-controller.js';
import { WEAPON_IDS } from './weapons/weapon-catalog.js';
import { NEST_ALIAS_BLOCK } from '../entities/zombie-nests/nest-config.js';
import { TURRET_ALIAS_BLOCK, defaultTurretRotation } from '../entities/turrets/turret-config.js';

const EYE_HEIGHT = 1.62;
const REACH = 40; // mc-lite 枪的 far 语义

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
 *   2. 放置 origin 用**命中方块格**（`target.blockPos`），不是 `prevPos`：结构最低层要落在
 *      玩家脚下的地面格上。两条路径（背包分流与 `selectPlaceable`）的 origin 语义必须一致。
 */
// 物品名派生自 nest-config.js 的单一权威，不在此写第二份字面量（红线 1：两处会漂移）
const CREATIVE_SPECIALS = new Set([NEST_ALIAS_BLOCK, TURRET_ALIAS_BLOCK]);

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
   * @param {{viewWeapon?: object, tracerRenderer?: object, audioManager?: object}} [opts.weaponRuntime]
   *        M4 武器渲染/音频运行时（Game 注入）。weaponController 由 Game 在 Player 创建后注入
   *        （onEffect 需委派回 player，避免循环引用）
   * @param {() => boolean} [opts.isModal] 模态谓词（M3.1）：返回 true 时 keydown 全部拦截。
   *        注入而非直接引用 Game，保持 Player 不反向依赖 core/（依赖方向 §3）
   */
  constructor({ world, camera, scheduler, registry, canvas, editor, weaponRuntime = null, isModal = () => false, onSpawnZombie = null, nests = null, turrets = null, onIgniteTnt = null }) {
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
    /** @type {WeaponController | null} */
    this.weaponController = null;
    this.physics = new PlayerPhysics(world);
    this._stepLift = new StepLift(); // 上台阶相机缓动（物理瞬时，视觉 ease-out）
    this.yaw = 0; this.pitch = 0;
    this.keys = new Set();
    /**
     * 背包 = 物品权威（§4.5.4 M3.1）。创造模式无限背包：122 项全量入包、
     * 每格 count=1500 占位不消耗。快捷栏是 `slots[0..4]` 的视图，不是独立容器。
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
      this.keys.add(e.code);
      if (e.code.startsWith('Digit')) {
        const n = Number(e.code.slice(5)) - 1;
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
    };
    const onKeyUp = (e) => this.keys.delete(e.code);
    // pointer lock 请求必须吞掉拒绝（mc-lite Player.js:292 同款 `.catch(() => {})`）：
    // 浏览器规定退出锁后 ~1s 内不得重新锁定，用户按 Esc 后立刻点击 canvas 会抛
    // SecurityError: "Pointer lock cannot be acquired immediately after the user has
    // exited the lock."——不吞掉就是控制台未捕获错误（用户会误判为游戏坏了）。
    // 本次点击放弃锁定即可，下次点击自然成功。
    const onClick = () => this.canvas.requestPointerLock().catch(() => {});
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
        if (this.weaponController.debugState().selectedId === WEAPON_IDS.ARM) this.digBlock();
        else this.weaponController.pointerDown(this._buildAim());
      }
      if (e.button === 2) this.placeBlock(); // 右键始终放块
    };
    const onMouseUp = (e) => {
      if (document.pointerLockElement !== this.canvas) return;
      if (e.button === 0) this.weaponController.pointerUp();
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
    this._acc += dt;
    const step = 1 / 60;
    let n = 0;
    while (this._acc >= step && n < 5) {
      this._applyInput();
      this.physics.step(step);
      this._acc -= step; n++;
    }
    // 消费本帧 step-up 抬升：物理已瞬时到位，相机从旧高度 ease-out 追平
    if (this.physics.stepLiftAccum > 0) {
      this._stepLift.trigger(this.physics.stepLiftAccum);
      this.physics.stepLiftAccum = 0;
    }
    this._stepLift.update(dt);
    // 相机同步（眼高 1.62 + 台阶缓动偏移）
    const p = this.physics.pos;
    const camY = p.y + EYE_HEIGHT + this._stepLift.offset;
    this.camera.position.set(p.x, camY, p.z);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(this.yaw);
    this.camera.rotateX(this.pitch);
    // 每帧 1 次主射线（§4.5.2）；原点用相机视觉位置，交互与画面一致
    const dir = new THREE.Vector3(0, 0, -1).applyEuler(this.camera.rotation);
    const r = raycastVoxel(this.world, [p.x, camY, p.z], [dir.x, dir.y, dir.z], REACH);
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
    if (this.tracerRenderer) this.tracerRenderer.update(dt, aim);
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
      target: this.target ? { hit: true, blockPos: this.target.blockPos, dist: this.target.dist } : null,
    };
  }

  /** 效果事件统一出口：视图模型后坐 → 曳光 → 音效（顺序固定，M4 规格 §4.2）。 */
  _applyWeaponEffect(effect) {
    if (this.viewWeapon) this.viewWeapon.onShot(effect);
    if (this.tracerRenderer) this.tracerRenderer.spawn(effect);
    if (this.audioManager) this.audioManager.play(effect.sound, effect.volume);
  }

  /**
   * 选择武器（公开 API）。先由控制器校验/切换，再异步加载视图模型；
   * 非徒手时播放 gun_load。模型加载失败不阻塞玩法（控制器仍可开火）。
   * @param {string} id @returns {Promise<string>} 当前选中 id
   */
  async selectWeapon(id) {
    if (!this.weaponController.select(id)) return this.weaponController.debugState().selectedId;
    if (this.viewWeapon) await this.viewWeapon.select(id);
    if (id !== WEAPON_IDS.ARM && this.audioManager) this.audioManager.play('gun_load', 0.4);
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
    const fwd = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
    const strafe = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
    if (fwd || strafe) {
      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
      this.physics.move(-sin * fwd + cos * strafe, -cos * fwd - sin * strafe);
    }
    if (this.keys.has('Space')) this.physics.jump();
  }

  digBlock() {
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
    this.editor.setBlock({ x, y, z, id: 0 });
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
    if (!this.target) return;
    const [x, y, z] = this.target.prevPos;
    // 不与玩家自身 AABB 重叠
    const p = this.physics.pos;
    if (x === Math.floor(p.x) && z === Math.floor(p.z) &&
        (y === Math.floor(p.y) || y === Math.floor(p.y + 1))) return;
    // M7：受控创造模式物品优先分流（测试 API 路径）。失败保留世界，不写任何方块。
    // ⚠️ origin 必须用 **`blockPos`（命中方块）**，不能用 `prevPos` —— 两条放置路径
    // （本分支与下方背包分流）的 origin 语义必须一致，否则结构会整体上移一格悬空
    // （实测踩坑：用 prevPos 时 38 格里 30 格落在未清理的位置 → 放置大面积失败）。
    if (this._selectedPlaceable) {
      const hit = this.target.blockPos;
      if (hit) this._placeSpecial(this._selectedPlaceable, [hit[0], hit[1], hit[2]]);
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
      // origin = **命中方块所在格**（`blockPos`），不是 `prevPos`：巢穴最低层要落在
      // 玩家脚下的地面上（mc-lite `generateBlocks` 的 `y + block.y - 1` 同口径）。
      // 用 prevPos 会让结构悬空一格（最低层落在 prevPos+1）。
      const hit = this.target.blockPos;
      if (hit) this._placeSpecial(slot.item, [hit[0], hit[1], hit[2]]);
      return; // 分流后不回落到单格放置
    }
    // M3.2：算放置朝向（三分支，不看玩家 yaw）。与 M3.1 的取物品逻辑正交叠加。
    const meta = getPlacementOrientation(x, y, z, id, this.registry.orientationModesTable,
      this.lastRemovedBlock, this.placementOrientationMemory);
    // M4-0：改走唯一编辑路径。朝向作为 meta 传入——不得退化为只传 id（M3.2 语义）。
    const report = this.editor.setBlock({ x, y, z, id, meta });
    if (report.changes.length > 0) {
      // 放置成功后清除挖块记忆（§4.3 定稿口径：mc-lite 是算完朝向即无条件清空，
      // 本仓库改为成功后清空——放置失败时保留记忆，避免记忆跨次放置串用）
      this.lastRemovedBlock = null;
    }
    // 创造模式不消耗：slot.count 保持 DEFAULT_INVENTORY_COUNT 不变
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
        // mc-lite `TurretPlacementHandler.js:144` 的 `playSound('put', 0.3)`。
        // ⚠️ 音量与巢穴不同（0.3 vs 0.6）—— 这是 mc-lite 的实际值，不是笔误。
        try {
          this.audioManager.play('put', 0.3);
        } catch (err) {
          // 只记诊断，不回滚（同上）
          console.warn('[audio] put play failed:', err);
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
