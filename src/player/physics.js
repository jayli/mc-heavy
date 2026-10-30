// src/player/physics.js — AABB 碰撞 + 定步长积分（§4.5.1，常数移植 mc-lite Physics.js）
const PLAYER_WIDTH = 0.6;
const PLAYER_HEIGHT = 1.8;
const GRAVITY = -24.0;
const JUMP_FORCE = 10.0;
const SPEED = 8.0;
/**
 * 飞行水平速度倍率（用户裁定 2026-10-25：走路 2 倍，不设 Ctrl 加速档）。
 * 原版创造飞行是走路的 2.5×，但本仓 `SPEED = 8` 已是原版疾跑（5.612）的 1.43 倍，
 * 照抄 2.5× 会到 20 格/秒 —— 故按「倍率」口径取 2（= 16 格/秒）。
 * 导出供测试读同一份权威（红线 1：测试与实现不得各写一份字面量）。
 */
export const FLY_SPEED_MULT = 2;
/**
 * 飞行垂直速度（格/秒，空格升 / Shift 降）。
 * ⚠️ **这是初值不是推导值**（原版无公开稳定数值可引）：8 ≈ 水平飞行速度的一半。
 * 实玩后若觉得爬升太慢/太快，只改这一个数 —— 与 `BOB.intensity` 同一标定口径。
 */
export const FLY_VERTICAL_SPEED = 8;
const MAX_STEP = 1.0;
const EPSILON = 0.001;

export class PlayerPhysics {
  /** @param {import('../voxel/world-data.js').WorldData} world */
  constructor(world) {
    this.world = world;
    this.pos = { x: 8, y: 40, z: 8 }; // 脚底中心
    this.vel = { x: 0, y: 0, z: 0 };
    this.onGround = false;
    this.inWater = false;
    /**
     * 飞行态（spec §4.1：**唯一权威在本类**，`Player` 不复制一份）。`true` 时 `step()` 走
     * `_stepFlying()`（零重力 + 恒定垂直速度），并且飞行中 `onGround` 恒为 false。
     */
    this.flying = false;
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

  /** 开/关飞行（边沿由调用方保证 —— `player.js` 的 `!e.repeat`）。同时清零竖直速度： */
  toggleFlight() {
    this.flying = !this.flying;
    // 清零是载荷性的：不清的话「下坠中按 F」会保留 −24 的竖直速度继续掉、
    // 「起跳上升段按 F」会保留 +10 继续窜。起飞/降落都从静止竖直速度开始（悬停）。
    this.vel.y = 0;
  }

  /**
   * 飞行垂直输入：`dir` = +1 升 / -1 降 / 0 悬停。非飞行态 no-op（地面态的空格仍走 `jump()`）。
   * 每步重设 `vel.y`（无惯性，与 `move()` 每步重设水平速度同一手感口径）。
   * @param {number} dir
   */
  moveVertical(dir) {
    if (!this.flying) return;
    this.vel.y = dir * FLY_VERTICAL_SPEED;
  }

  /** 单步积分（调用方按 60Hz 定步长驱动） */
  step(dt) {
    if (this.flying) { this._stepFlying(dt); return; }
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

  /**
   * 飞行物理（spec §4.3）。与地面路径共用 `_moveAxis` 的分轴碰撞与二分回退 ——
   * 区别只有「零重力 + 竖直速度由输入直接给」。
   *
   * ⚠️ **`onGround` 必须在移动前清零**：`onGround` 只由 `_moveAxis` 在向下碰撞时置 true，
   * 所以「清零 → 移动 → 判 onGround」恰好等价于「本步向下且触地」。不清零时，
   * 贴地悬停（竖直步长 0 → `_moveAxis` 直接 return）会带着上一步的 `true` 进来 →
   * **悬停被立即踢出飞行**（实测形态：按 F 在地面悬停一帧就掉回地面）。
   * 同一个 `onGround === false` 还是「飞行时不晃」的判据来源（`player.js` 传 `jumping: !onGround`）。
   * @param {number} dt 秒
   */
  _stepFlying(dt) {
    this._moveAxis(this.vel.x * dt, 0);
    this._moveAxis(this.vel.z * dt, 2);
    this.onGround = false;
    this._moveAxis(this.vel.y * dt, 1);
    // 向下触地 → 退出飞行（Java 口径）。向上顶到天花板不会置 onGround（只把 vel.y 归零）→ 仍在飞。
    if (this.onGround) { this.flying = false; this.vel.y = 0; }
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
   * 自动上台阶：水平碰撞时，尝试把脚底抬到上一格整数面。
   * 用完整 AABB 检测保证：2 格高墙抬不上去（目标位仍碰撞）、
   * 头顶净空不足抬不上去（1.8 高需 2 格净空）。
   *
   * **门控不是 `onGround`（v1.72 修）**：`onGround` 是**上一步**竖直碰撞的产物，
   * 而水平轴在竖直轴之前跑。玩家斜蹭台阶边沿时，AABB 跨出支撑格 → 本帧开始自由下落 →
   * `onGround === false`；与此同时前方高出的台壁把水平推进挡死 → 同一帧的 step-up 被拒
   * → **水平冻结、垂直下落**，落地后才重新爬上。观感就是用户报告的「奔跑中断」：
   * 「前进方向和方块边缘夹角太小的话，奔跑就会暂停，玩家垂直下落，感觉奔跑中断了」。
   * 实测（真实地形 seed=12345、15000 条轨迹 × 24 个方向）：基线 385 条（2.57%）出现
   * 「前进 <30% 全速且同时在下落」，最长连续 15 帧；本门控下归零，且穿模帧 0。
   *
   * 现在的门控 = **地面 或 下落中**；只有「跳跃上升段」仍拒绝 —— 跳起来撞墙本就该被挡
   * （实测三种门控在跳跃冲台阶场景轨迹完全相同，但保留它有明确语义）。
   * 「凭空爬墙」由抬升幅度的双重约束挡住：最多抬 1 格（`MAX_STEP`）+ 抬升后 AABB 必须
   * 无碰撞（实测空中贴 5 格墙下落时 `maxY` 不变，即不会被一格格爬上去）。
   *
   * ⚠️ **矿车也是本方法的「台阶」**（2026-10-01）：内部 `this._collides()` 把矿车占据格
   * 算作实心（mc-lite `Physics.isSolid` 同口径），故走进矿车会水平碰撞 → 本方法把玩家
   * 抬到 `carY+1`（与 mc-lite 实测同落点：上游的矿车专用分支在走进车场景因
   * `feetY = carY−1` 而 MISS，同样走通用循环）→ 与车顶 `carY+0.9` 差 0.1，被乘坐绑定
   * 容差 0.3 吸收 → 下一帧自动绑定。**本仓库不移植上游那条专用分支**（差异只在
   * 「已在车顶且未绑定」的冷却期场景，抬升 0.1 触发一次相机缓动，实际几乎不触发）——
   * 设计文档 §6 偏离 ⑧。
   * @returns {boolean} 是否成功登上
   */
  _tryStepUp() {
    // 飞行时没有「自动上台阶」的概念（原版飞行撞到方块边缘就是停住）。
    if (this.flying) return false;
    // 跳跃上升段拒绝（下落中允许 —— 见上方注释）。站立时本步 vel.y 已被重力压成负值，
    // 故「在地面上」也走这条放行分支。
    if (!this.onGround && this.vel.y > 0) return false;
    const oldY = this.pos.y;
    // 脚底抬到上一格顶面（站立时 y≈整数，+0.01 容错浮点噪声）
    const lifted = Math.floor(oldY + 0.01) + 1;
    // 超过一格不算台阶（与 zombie-system.js 的 MAX_STEP 同口径）。
    // 没有这条时 `oldY≈x.99` 会算出 `x+2`（抬 1.01 格）→ 抬过头后下一帧掉回，观感是「跳了一下」。
    if (lifted - oldY > MAX_STEP) return false;
    this.pos.y = lifted;
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
   * 玩家当前 AABB 与「某个单位立方体格」是否有**正体积重叠**（v2.22 放置守卫用）。
   *
   * 尺寸走 `aabb()`（`PLAYER_WIDTH`/`PLAYER_HEIGHT` 的单一权威，与碰撞检测同一份）——
   * 不得在消费方重算一遍（红线 1）。
   *
   * **判据必须用格近似的反例**：旧版 `Player._placeSingle()` 的守卫是
   * `x === floor(p.x) && z === floor(p.z) && (y === floor(p.y) || y === floor(p.y+1))`，
   * 它只覆盖「玩家所处的那一列 + 脚底/头顶两格」，两处漏判（实测 `(8.9,1,8.9)` 时有 **6 格**
   * 被放行但真实 AABB 相交）：
   * ① AABB 宽 0.6，`p.x` 小数部分 >0.7 或 <0.3 时**跨两列**；
   * ② 竖直用 `floor(p.y)+1` 而非真实顶面 → 跳跃/下落中（`p.y` 是小数）头顶格漏判。
   *
   * **严格不等式是载荷性的**：贴面（AABB 的某个面正好落在格边界上，如 `p.x = 8.7` 时右边界
   * 恰好是 `x = 9` 格的左面）**不算重叠** —— 用 `>=` 会把「贴着墙放的方块」误杀。
   * @param {number} x @param {number} y @param {number} z 方块格的整数坐标
   * @returns {boolean}
   */
  overlapsBlock(x, y, z) {
    const b = this.aabb();
    return b.minX < x + 1 && b.maxX > x &&
           b.minY < y + 1 && b.maxY > y &&
           b.minZ < z + 1 && b.maxZ > z;
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
    if (this.flying) return;   // 飞行中空格归 moveVertical(+1) 管（双保险，player.js 侧也已分流）
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
    const speed = this.flying ? SPEED * FLY_SPEED_MULT : SPEED * (this.inWater ? 0.6 : 1);
    this.vel.x = ix * speed;
    this.vel.z = iz * speed;
  }
}
