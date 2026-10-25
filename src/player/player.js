// src/player/player.js — 输入/视角/交互编排（§4.5）
import * as THREE from 'three';
import { raycastVoxel } from './raycast.js';
import { findPlaceCell } from './place-ray.js';
import { PlayerPhysics } from './physics.js';
import { StepLift } from './step-lift.js';
import { ViewBob } from './view-bob.js';
import { HOTBAR_ITEMS as HOTBAR } from './hotbar-items.js';
import { createCreativeInventory } from './inventory.js';
import { getPlacementOrientation, recordRemovedBlock } from './orientation.js';
import { WeaponController } from './weapons/weapon-controller.js';
import { WEAPON_IDS } from './weapons/weapon-catalog.js';
import { NEST_ALIAS_BLOCK } from '../entities/zombie-nests/nest-config.js';
import { TURRET_ALIAS_BLOCK, defaultTurretRotation } from '../entities/turrets/turret-config.js';
import { MINECART_ITEM, MINECART_TYPE, MINECART } from '../entities/minecarts/minecart-config.js';

const EYE_HEIGHT = 1.62;
const REACH = 40; // mc-lite 枪的 far 语义

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
  constructor({ world, camera, scheduler, registry, canvas, editor, weaponRuntime = null, isModal = () => false, onSpawnZombie = null, nests = null, turrets = null, minecarts = null, onIgniteTnt = null }) {
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
    /** @type {WeaponController | null} */
    this.weaponController = null;
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
      // 方向键也参与移动（v1.80）→ 需吞掉默认行为（滚动页面 / 触发聚焦元素）。
      // 只对方向键 preventDefault，不影响 F5 / F12 等浏览器快捷键。
      if (ARROW_CODES.has(e.code)) e.preventDefault();
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
        });
      } else {
        // 乘坐期物理不跑（位置由矿车锁定）→ 无自主位移，晃动自然衰减到 0
        this.viewBob.update(step, { dx: 0, dz: 0, inputSpeed: 0 });
      }
      this._acc -= step; n++;
    }
    // 消费本帧 step-up 抬升：物理已瞬时到位，相机从旧高度 ease-out 追平
    if (this.physics.stepLiftAccum > 0) {
      this._stepLift.trigger(this.physics.stepLiftAccum);
      this.physics.stepLiftAccum = 0;
    }
    this._stepLift.update(dt);
    // 相机同步（眼高 1.62 + 台阶缓动偏移 + 跑动晃动）
    // ⚠️ 晃动**融进这一次全量 set**，不得改成 `camera.position.x += bob`：
    // 那样上一帧的偏移会被下一帧当基线继承，逐渐累积漂移（本方法每帧都会重写位置，
    // 全量 set 天然幂等）。
    const p = this.physics.pos;
    const bob = this.viewBob.offset;
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
    };
  }

  /** 效果事件统一出口：视图模型后坐 → 曳光 → 音效 → 命中特效（顺序固定，M4 规格 §4.2）。 */
  _applyWeaponEffect(effect) {
    if (this.viewWeapon) this.viewWeapon.onShot(effect);
    if (this.tracerRenderer) this.tracerRenderer.spawn(effect);
    if (this.audioManager) this.audioManager.play(effect.sound, effect.volume);
    // v1.64：方块被击碎/击中的特效（白闪 + 碎块；MAG7 只有白闪）。
    // 纯视觉，池满丢最旧，不回头影响玩法状态。
    if (this.blockHitFx) this.blockHitFx.spawnFromEffect(effect, performance.now());
  }

  /**
   * 选择武器（公开 API）。先由控制器校验/切换，再异步加载视图模型；
   * 非徒手时播放 gun_load。模型加载失败不阻塞玩法（控制器仍可开火）。
   * @param {string} id @returns {Promise<string>} 当前选中 id
   */
  async selectWeapon(id) {
    if (!this.weaponController.select(id)) return this.weaponController.debugState().selectedId;
    if (this.viewWeapon) await this.viewWeapon.select(id);
    // 手臂与持枪视图模型互斥：arm 时显示手臂，其余隐藏（mc-lite `updateArm` 同口径）
    if (this.viewArm) this.viewArm.setWeapon(id);
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
    if (k.has('Space')) this.physics.jump();
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
    this.editor.setBlock({ x, y, z, id: 0 });
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
    // 裁决（v1.70）：兜底**只在完全未命中时**生效（mc-lite 的 `doSkyPlace` 同理 ——
    // 它只在「命中距离 ≥ 15」时接管，即主射线没有可用命中）。
    // ⚠️ 「命中但放不下」（`prevPos` 被玩家 AABB 占住）**刻意不走兜底**：那属于
// 「目标明确但不可放置」，回落到射线找别处会把方块放到玩家没对准的地方。
    if (!this.target) { this._placeByRayFallback(); return; }
    const [x, y, z] = this.target.prevPos;
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
    this._placeSingle(x, y, z, id);
  }

  /**
   * 沿视线找最近可贴格并放置（v1.70 兜底）。**只在主射线完全未命中时被调用**。
   *
   * 场景（用户报告）：玩家站在一块方块上朝下看，只能看到脚底方块的顶面，看不到它的
   * 水平侧面 —— 想把方块接续放在它东侧时，准心对准那侧的空位，主射线打空（`target`
   * 为 null）→ 以前右键完全无反应。
   *
   * 对齐 mc-lite `PlayerInteraction.js:781-806` 的 `doSkyPlace()`，判据与射程见
   * `place-ray.js`（纯函数，Tier 1 单测 `test-place-ray.js`）。
   *
   * ⚠️ **特殊物品（巢穴/炮塔/矿车）不走兜底**：它们的 origin 语义依赖**命中格**
   *（多格结构用 `blockPos`、矿车用 `prevPos`），未命中时没有合法 origin —— 强行用
   * 兜底格会让 38 格结构落在半空。保持「未命中即静默不动作」的现状。
   * @returns {boolean} 是否真的放下了一块
   */
  _placeByRayFallback() {
    // 选中态（`selectPlaceable` 测试 API）与背包里的特殊物品都不兜底（见上方注释）
    if (this._selectedPlaceable) return false;
    const slot = this.inventory.getSelected();
    if (!slot || slot.isEmpty()) return false;
    if (CREATIVE_SPECIALS.has(slot.item)) return false;
    const id = this.registry.idOf(slot.item);
    if (id === undefined) return false;
    const cp = this.camera.position;
    this.camera.getWorldDirection(_forward);
    const found = findPlaceCell(this.world, [cp.x, cp.y, cp.z],
      [_forward.x, _forward.y, _forward.z]);
    if (!found.hit) return false;
    const [x, y, z] = found.placeCell;
    return this._placeSingle(x, y, z, id);
  }

  /**
   * 单格放置的唯一写入路径（v1.70 抽出）：AABB 守卫 → 朝向三分支 → `editor.setBlock`
   * → 成功清记忆并挥动。
   *
   * **两个调用方**：`placeBlock()` 的命中路径（origin = `target.prevPos`）与
   * `_placeByRayFallback()` 的兜底路径（origin = 沿视线找到的格）。两处共用这一份，
   * 否则会出现「一条路径有 AABB 守卫/朝向/挥动，另一条静默没有」的撕裂
   * （M7 曾因两条放置路径不一致踩过同类坑，见 CLAUDE.md 活跃约束）。
   * @param {number} x @param {number} y @param {number} z 放置格
   * @param {number} id 方块 id
   * @returns {boolean} 是否真的放下了一块
   */
  _placeSingle(x, y, z, id) {
    // 不与玩家自身 AABB 重叠
    const p = this.physics.pos;
    if (x === Math.floor(p.x) && z === Math.floor(p.z) &&
        (y === Math.floor(p.y) || y === Math.floor(p.y + 1))) return false;
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
          this.audioManager.play('put', 0.3);   // mc-lite MinecartPlacementHandler 同音量
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
