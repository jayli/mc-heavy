// src/player/physics.js — AABB 碰撞 + 定步长积分（§4.5.1，常数移植 mc-lite Physics.js）
const PLAYER_WIDTH = 0.6;
const PLAYER_HEIGHT = 1.8;
const GRAVITY = -24.0;
const JUMP_FORCE = 10.0;
const SPEED = 8.0;
const EPSILON = 0.001;

export class PlayerPhysics {
  /** @param {import('../voxel/world-data.js').WorldData} world */
  constructor(world) {
    this.world = world;
    this.pos = { x: 8, y: 40, z: 8 }; // 脚底中心
    this.vel = { x: 0, y: 0, z: 0 };
    this.onGround = false;
    this.inWater = false;
  }

  /** 单步积分（调用方按 60Hz 定步长驱动） */
  step(dt) {
    const w = this.world;
    this.inWater = w.getBlockId(Math.floor(this.pos.x), Math.floor(this.pos.y + 0.5), Math.floor(this.pos.z)) === w.registry.idOf('water');
    const gravity = this.inWater ? GRAVITY * 0.4 : GRAVITY;
    this.vel.y += gravity * dt;
    if (this.inWater) { this.vel.y = Math.max(this.vel.y, -4); }
    const drag = this.inWater ? 0.6 : 1;
    // 分轴移动 + 碰撞
    this._moveAxis(this.vel.x * dt * drag, 0);
    this._moveAxis(this.vel.z * dt * drag, 2);
    this.onGround = false;
    this._moveAxis(this.vel.y * dt, 1);
    // 水平速度由 move() 每步重设，此处衰减为 0（无惯性，mc-lite 手感）
    this.vel.x = 0; this.vel.z = 0;
  }

  _moveAxis(delta, axis) {
    if (delta === 0) return;
    const p = this.pos;
    const keys = ['x', 'y', 'z'];
    const k = keys[axis];
    const old = p[k];
    p[k] += delta;
    if (this._collides()) {
      // 二分回退到不碰撞位置
      let lo = 0, hi = 1;
      for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) / 2;
        p[k] = old + delta * mid;
        if (this._collides()) hi = mid; else lo = mid;
      }
      p[k] = old + delta * lo;
      if (axis === 1 && delta < 0) this.onGround = true;
      this.vel[k] = 0;
    }
  }

  /** AABB 0.6×1.8×0.6 与实心方块采样检测 */
  _collides() {
    const w = this.world;
    const hw = PLAYER_WIDTH / 2;
    const x0 = Math.floor(this.pos.x - hw), x1 = Math.floor(this.pos.x + hw);
    const y0 = Math.floor(this.pos.y), y1 = Math.floor(this.pos.y + PLAYER_HEIGHT - EPSILON);
    const z0 = Math.floor(this.pos.z - hw), z1 = Math.floor(this.pos.z + hw);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      if (w.isSolid(x, y, z)) return true;
    }
    return false;
  }

  jump() {
    if (this.onGround) this.vel.y = JUMP_FORCE;
    else if (this.inWater) this.vel.y = 4; // 水中上浮
  }

  /** 按输入方向设置水平速度（调用方传入朝向旋转后的 inputX/inputZ ∈ [-1,1]） */
  move(inputX, inputZ) {
    let ix = inputX, iz = inputZ;
    const len = Math.hypot(ix, iz);
    if (len > 1) { ix /= len; iz /= len; }
    const speed = SPEED * (this.inWater ? 0.6 : 1);
    this.vel.x = ix * speed;
    this.vel.z = iz * speed;
  }
}
