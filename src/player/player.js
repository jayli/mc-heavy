// src/player/player.js — 输入/视角/交互编排（§4.5）
import * as THREE from 'three';
import { raycastVoxel } from './raycast.js';
import { PlayerPhysics } from './physics.js';
import { StepLift } from './step-lift.js';
import { HOTBAR_ITEMS as HOTBAR } from './hotbar-items.js';
import { createCreativeInventory } from './inventory.js';

const EYE_HEIGHT = 1.62;
const REACH = 40; // mc-lite 枪的 far 语义

export class Player {
  /**
   * @param {Object} opts
   * @param {import('../voxel/world-data.js').WorldData} opts.world
   * @param {THREE.PerspectiveCamera} opts.camera
   * @param {import('../core/scheduler.js').Scheduler} opts.scheduler
   * @param {*} opts.registry
   * @param {HTMLCanvasElement} opts.canvas - pointer lock 目标（M3.1 起公开为 `player.canvas`，
   *        面板关闭时 lock 回此处；mc-lite 锁 document.body，本仓库必须锁 canvas）
   * @param {() => boolean} [opts.isModal] 模态谓词（M3.1）：返回 true 时 keydown 全部拦截。
   *        注入而非直接引用 Game，保持 Player 不反向依赖 core/（依赖方向 §3）
   */
  constructor({ world, camera, scheduler, registry, canvas, isModal = () => false }) {
    this.world = world;
    this.camera = camera;
    this.scheduler = scheduler;
    this.registry = registry;
    this._isModal = isModal;
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
    this._bindInput();
  }

  spawn(x, y, z) {
    this.physics.pos = { x, y, z };
    this._stepLift.offset = 0; // 传送不继承缓动
  }

  _bindInput() {
    window.addEventListener('keydown', (e) => {
      // 模态守卫（M3.1，§4.5.4）：设置面板/背包打开时拦截全部按键——
      // 否则模态期间新按的键仍会写入 keys（主循环虽跳过 player.update，
      // 但 keys 残留会在关闭后粘滞）并改选中格。
      // **该守卫是 M4 Task 6 的前置条件**：M4 在此挂 KeyR 切武器，
      // 无守卫则面板开着按 R 会切武器并播 gun_load 音效。
      if (this._isModal()) { this.keys.clear(); return; }
      this.keys.add(e.code);
      if (e.code.startsWith('Digit')) {
        const n = Number(e.code.slice(5)) - 1;
        if (n >= 0 && n < HOTBAR.length) this.hotbarIndex = n;
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    this.canvas.addEventListener('click', () => this.canvas.requestPointerLock());
    window.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== this.canvas) return;
      this.yaw -= e.movementX * 0.002;
      this.pitch -= e.movementY * 0.002;
      this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.pitch));
    });
    window.addEventListener('mousedown', (e) => {
      if (document.pointerLockElement !== this.canvas) return;
      if (e.button === 0) this.digBlock();
      if (e.button === 2) this.placeBlock();
    });
    window.addEventListener('contextmenu', (e) => e.preventDefault());
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
    if (this.world.getBlockId(x, y, z) === this.registry.idOf('bedrock')) return; // 基岩不可挖
    const r = this.world.setBlock(x, y, z, 0);
    if (r) this.scheduler.remeshSections(r.affected, { fastPath: true });
  }

  placeBlock() {
    if (!this.target) return;
    const [x, y, z] = this.target.prevPos;
    // 不与玩家自身 AABB 重叠
    const p = this.physics.pos;
    if (x === Math.floor(p.x) && z === Math.floor(p.z) &&
        (y === Math.floor(p.y) || y === Math.floor(p.y + 1))) return;
    // §4.5.4 M3.1：取背包选中槽的物品（selectedSlot 可 > 4，由背包面板点击选中）
    const slot = this.inventory.getSelected();
    if (!slot || slot.isEmpty()) return; // 空槽不放块
    const id = this.registry.idOf(slot.item);
    if (id === undefined) return; // 无该方块（防御：物品集合与 registry 同源，正常不触发）
    const r = this.world.setBlock(x, y, z, id);
    if (r) this.scheduler.remeshSections(r.affected, { fastPath: true });
    // 创造模式不消耗：slot.count 保持 DEFAULT_INVENTORY_COUNT 不变
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
