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
    // 本帧 step-up 累积抬升量（供相机视觉缓动消费；物理位置本身瞬时到位）
    this.stepLiftAccum = 0;
    /**
     * 矿车服务（Player 构造时注入，同 `minecarts` 参数手法 —— physics 不 import entities/）。
     * 非 null 时 `_collides` 把矿车占据格视为实心（mc-lite `Physics.isSolid` 的
     * MinecartManager 分支同口径）—— 玩家走进车被挡 + 既有 `_tryStepUp` 抬上 →
     * 脚底落 carY+1，与车顶 carY+0.9 差 0.1，被 `ridingCarFor` 容差 0.3 吸收 → 绑定乘坐。
     * ⚠️ **不需要「排除自己坐的车」**：`_collides` 只在非乘坐时被调（乘坐期
     * `physics.step` 整段跳过，见 player.js），而 `ridingMinecartId` 非 null 时
     * 必然在乘坐 → 没有需要排除的车。乘坐跟随的障碍检测走 `collidesAt`（仅方块，
     * 矿车 Epic 既有口径），不经本字段。
     * @type {import('../entities/minecarts/minecart-system.js').MinecartService|null}
     */
    this.minecarts = null;
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
    // M2-7：仅 Y 轴向下把 supportsPlayer（云）计入碰撞；向上/水平/_tryStepUp 只查 solid
    const supportDown = axis === 1 && delta < 0;
    p[k] += delta;
    if (this._collides(supportDown)) {
      // 水平轴：尝试自动上台阶（mc-lite tryStepUp 手感，MAX_STEP=1.0）
      if (axis !== 1 && this._tryStepUp()) return;
      // 二分回退到不碰撞位置
      let lo = 0, hi = 1;
      for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) / 2;
        p[k] = old + delta * mid;
        if (this._collides(supportDown)) hi = mid; else lo = mid;
      }
      p[k] = old + delta * lo;
      if (axis === 1 && delta < 0) this.onGround = true;
      this.vel[k] = 0;
    }
  }

  /**
   * 自动上台阶：水平碰撞且在地面时，尝试把脚底抬到上一格整数面。
   * 用完整 AABB 检测保证：2 格高墙抬不上去（目标位仍碰撞）、
   * 头顶净空不足抬不上去（1.8 高需 2 格净空）。
   * @returns {boolean} 是否成功登上
   */
  _tryStepUp() {
    if (!this.onGround) return false;
    const oldY = this.pos.y;
    // 脚底抬到上一格顶面（站立时 y≈整数，+0.01 容错浮点噪声）
    this.pos.y = Math.floor(oldY + 0.01) + 1;
    if (!this._collides()) {
      this.stepLiftAccum += this.pos.y - oldY; // 记录抬升量（相机缓动用）
      this.vel.y = 0;
      return true;
    }
    this.pos.y = oldY;
    return false;
  }

  /**
   * AABB 0.6×1.8×0.6 与实心方块采样检测。
   * @param {boolean} [includeSupportsPlayer=false] 为 true 时 supportsPlayer（云）也计碰撞
   *        （M2-7：仅 Y 轴向下使用，云可站立但非墙）
   */
  _collides(includeSupportsPlayer = false) {
    const w = this.world;
    const hw = PLAYER_WIDTH / 2;
    const x0 = Math.floor(this.pos.x - hw), x1 = Math.floor(this.pos.x + hw);
    const y0 = Math.floor(this.pos.y), y1 = Math.floor(this.pos.y + PLAYER_HEIGHT - EPSILON);
    const z0 = Math.floor(this.pos.z - hw), z1 = Math.floor(this.pos.z + hw);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      if (w.isSolid(x, y, z)) return true;
      if (includeSupportsPlayer && w.supportsPlayer(x, y, z)) return true;
      // 矿车占据格视为实心（mc-lite `Physics.isSolid` 的 MinecartManager 分支）。
      // cell-based 与 mc-lite 同口径；车高 0.9 与整格 1.0 的 0.1 差由乘坐绑定容差吸收。
      if (this.minecarts && this.minecarts.carAt(x, y, z)) return true;
    }
    return false;
  }

  /**
   * 指定位置的玩家 AABB 是否与实心方块重叠（乘坐跟随的分轴障碍检测用）。
   * ⚠️ 与 `_collides()` 同判据（`world.isSolid` + PLAYER_WIDTH/PLAYER_HEIGHT），但
   * **不读 `this.pos`** —— 乘坐跟随要「先试探再决定写不写」，不能先改 pos 再回滚。
   * 设计文档 §4.4：「分轴，各轴单独做障碍检测」。
   * @param {number} x @param {number} y @param {number} z 候选脚底中心
   * @returns {boolean}
   */
  collidesAt(x, y, z) {
    const w = this.world;
    const hw = PLAYER_WIDTH / 2;
    const x0 = Math.floor(x - hw), x1 = Math.floor(x + hw);
    const y0 = Math.floor(y), y1 = Math.floor(y + PLAYER_HEIGHT - EPSILON);
    const z0 = Math.floor(z - hw), z1 = Math.floor(z + hw);
    for (let bx = x0; bx <= x1; bx++) {
      for (let by = y0; by <= y1; by++) {
        for (let bz = z0; bz <= z1; bz++) {
          if (w.isSolid(bx, by, bz)) return true;
        }
      }
    }
    return false;
  }

  /**
   * 玩家当前 AABB（M7）：尺寸派生自本文件的 `PLAYER_WIDTH`/`PLAYER_HEIGHT` 常量 ——
   * **不得在消费方重算一遍**。巢穴放置的 player-overlap 预检必须用与碰撞检测**同一个** AABB，
   * 否则会撕裂出「物理说没撞墙、巢穴说压住了玩家」（或反之）的不一致判定（红线 1）。
   * `pos` 是脚底中心，故 minY=pos.y、maxY=pos.y+height。
   * @returns {{minX:number,maxX:number,minY:number,maxY:number,minZ:number,maxZ:number}}
   */
  aabb() {
    const hw = PLAYER_WIDTH / 2;
    return {
      minX: this.pos.x - hw, maxX: this.pos.x + hw,
      minY: this.pos.y, maxY: this.pos.y + PLAYER_HEIGHT,
      minZ: this.pos.z - hw, maxZ: this.pos.z + hw,
    };
  }

  jump() {
    if (this.onGround) this.vel.y = JUMP_FORCE;
    else if (this.inWater) this.vel.y = 4; // 水中上浮
  }

  /**
   * 下车起跳（矿车乘坐用）。**与 `jump()` 的区别：不判 `onGround`** ——
   * 乘坐期间玩家被锁在车顶高度、`onGround` 恒为 false（物理步被跳过），
   * 走 `jump()` 会因 `if (this.onGround)` 门控而**完全无效**（空格下车静默失效）。
   * 常量单一权威：`JUMP_FORCE` 是本模块私有，故起跳逻辑放这里而不是让
   * `player.js` 写 `vel.y = 10.0` 字面量（红线 1）。
   */
  dismountJump() {
    this.vel.y = JUMP_FORCE;
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
