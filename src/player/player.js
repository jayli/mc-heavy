// src/player/player.js — 输入/视角/交互编排（§4.5）
import * as THREE from 'three';
import { raycastVoxel } from './raycast.js';
import { PlayerPhysics } from './physics.js';
import { StepLift } from './step-lift.js';
import { HOTBAR_ITEMS as HOTBAR } from './hotbar-items.js';

const EYE_HEIGHT = 1.62;
const REACH = 40; // mc-lite 枪的 far 语义

export class Player {
  /**
   * @param {Object} opts
   * @param {import('../voxel/world-data.js').WorldData} opts.world
   * @param {THREE.PerspectiveCamera} opts.camera
   * @param {import('../core/scheduler.js').Scheduler} opts.scheduler
   * @param {*} opts.registry
   * @param {HTMLCanvasElement} opts.canvas - pointer lock 目标
   */
  constructor({ world, camera, scheduler, registry, canvas }) {
    this.world = world;
    this.camera = camera;
    this.scheduler = scheduler;
    this.registry = registry;
    this.physics = new PlayerPhysics(world);
    this._stepLift = new StepLift(); // 上台阶相机缓动（物理瞬时，视觉 ease-out）
    this.yaw = 0; this.pitch = 0;
    this.keys = new Set();
    this.hotbarIndex = 0;
    this.target = null; // 当前射线命中
    this._canvas = canvas;
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
      this.keys.add(e.code);
      if (e.code.startsWith('Digit')) {
        const n = Number(e.code.slice(5)) - 1;
        if (n >= 0 && n < HOTBAR.length) this.hotbarIndex = n;
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    this._canvas.addEventListener('click', () => this._canvas.requestPointerLock());
    window.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== this._canvas) return;
      this.yaw -= e.movementX * 0.002;
      this.pitch -= e.movementY * 0.002;
      this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.pitch));
    });
    window.addEventListener('mousedown', (e) => {
      if (document.pointerLockElement !== this._canvas) return;
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
    const id = this.registry.idOf(HOTBAR[this.hotbarIndex]);
    const r = this.world.setBlock(x, y, z, id);
    if (r) this.scheduler.remeshSections(r.affected, { fastPath: true });
  }

  get highlight() { return this._highlight; }
}
