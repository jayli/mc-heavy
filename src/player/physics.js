// src/player/physics.js — AABB 碰撞 + 定步长积分（§4.5.1，常数移植 mc-lite Physics.js）
import { WORLD_HEIGHT } from '../voxel/constants.js';

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
/**
 * 水中水平阻力系数：`step()` 里水平位移 = vel × dt × drag。
 * 导出供 `player.js` 传给 `viewBob.update`（脚步声判据要按它折算期望位移，
 * 否则水中 actual/expected 恒 0.6 → 误判「被阻挡」→ 水中脚步声永不播，v2.54 根因）。
 * 红线 1：`step()` 内不得再写字面量 0.6。
 */
export const WATER_DRAG = 0.6;

/**
 * 玩家被焰魔身体盒「罩住」时的推出速度上限（格/秒，v2.78）。
 *
 * ## 为什么需要（用户缺陷）
 *
 * 「玩家跑进焰魔，跑的太近就会和焰魔靠在一起，然后玩家就不能动弹了，跳也不行，前后左右都无法动弹」。
 * 根因：`_collides()` 把焰魔身体盒当实心，而这个盒子是**身体 OBB 绕 yaw 旋转后的轴对齐包围盒**，
 * 随焰魔朝向变形（yaw=0° 时重叠区单边 1.13，45° 时 1.54）。焰魔醒来 / 追击 / 起手都会转向玩家，
 * 盒子扫过站得近的玩家 ⇒ 玩家落进盒内（实测斜角站位陷入 0.3~0.4 格，而单步位移只有
 * `SPEED / 60 = 0.133`）⇒ 每个候选位置都仍与盒重叠 ⇒ 四轴 + 跳跃全部被拒。
 * 焰魔侧的自愈（`overlapEscapeDist = 1.15`，仅 `chase` 态）覆盖不到：斜角站位 `d ≈ 1.4`。
 *
 * ## 取值
 *
 * 9 格/秒（60Hz 下 0.15 格/步）：① 要**快过盒子扫过来的速度**（焰魔追击 4.4 格/秒、转身时盒边约
 * 3~4 格/秒），否则推出追不上盒子、玩家仍被罩住；② 要**像被顶开而不是瞬移**（0.35 格深的陷入约
 * 3 步 = 50ms 推完）。略大于玩家疾跑速度（`SPEED = 8`），玩家无法靠「往里顶」抵消推出。
 * 导出供测试读同一份权威（红线 1）。
 */
export const IGNIS_EJECT_SPEED = 9;
/** 推出探测：沿 ±X / ±Z 逐 `EJECT_PROBE` 格找「第一个不再重叠」的平移量（精度 0.02 格，随后每步继续收敛） */
const EJECT_PROBE = 0.02;
/**
 * 推出探测的最大平移（格）。须 > 最深的陷入。
 *
 * 焰魔：身体盒单边最大 1.236（yaw=45°）+ 玩家半宽 0.3 = 1.54，留余量取 2.0。
 * 守卫（本次新增）：核心盒更大且 `center.z = −0.4062` 使旋转后 AABB **不对称**
 *（yaw45° 时 x ∈ [−1.900, +1.326]，不是 ±1.6205）。实测扫全 yaw × 盒内玩家位置，
 * 「沿 ±X/±Z 推出所需最大距离」= **1.900 格**（焰魔对照 1.376）。
 *
 * ⚠️ **值保持 2.0 不变**：1.900 < 2.0 够用，但余量只剩 **0.100**
 *⇒ **不得再调大守卫核心盒尺寸**（`test-guardian-collision.js` 有余量断言钉住）。
 * 也不得因为「余量小」就调大本值 —— 调大会让玩家被顶得更远。
 * 导出供测试读同一份权威（红线 1，同 `IGNIS_EJECT_SPEED` 已导出的先例）。
 */
export const EJECT_MAX = 2.0;
const EJECT_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
/** 探测用的临时盒（复用同一个对象，避免重叠期每步分配几百个 —— `overlapsAabb` 不持有入参） */
const _probeBox = { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };

/**
 * 玩家命中盒（**相对脚底中心的局部盒**，v2.44 火球命中用）。
 *
 * ⚠️ **尺寸从本文件的 `PLAYER_WIDTH`/`PLAYER_HEIGHT` 派生**（红线 1：玩家尺寸的唯一权威
 * 在此）—— 不得在火球侧重算一遍，否则碰撞盒与命中盒会漂移出「物理说没碰到、火球说命中」。
 *
 * ⚠️ **为什么是独立导出而不是让 entities/ import 本文件**：矿车先例 —— `entities/` 不得
 * import `player/`（依赖方向），故由装配层（game.js）调用本函数后**注入** ctx.playerAabb。
 *
 * ⚠️ **形状是 `{min: number[], max: number[]}`**（与 `raycastAabbSlab` 的 aabb 参数同形），
 * 不是 `aabb()` 的 `{minX, maxX, ...}` 世界盒 —— 两者语义不同：这个是「模板」，
 * 调用方加 position 得世界盒。
 *
 * @returns {{min: [number,number,number], max: [number,number,number]}}
 */
export function playerHitboxLocal() {
  const hw = PLAYER_WIDTH / 2;
  return {
    min: [-hw, 0, -hw],
    max: [hw, PLAYER_HEIGHT, hw],
  };
}

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
    /**
     * 焰魔服务（Player 构造后由装配层注入，同 `minecarts` 手法 —— physics 不 import entities/）。
     *
     * 非 null 时 `_collides` 把**焰魔身体盒**视为实心（v2.62 用户缺陷⑦）：玩家奔跑撞上
     * 焰魔就停住（二分回退），而焰魔站定不动 —— 「不动如山」。
     * 原版佐证：`KNOCKBACK_RESISTANCE = 1.0`（`Ignis_Entity.java:508`，完全免疫击退）。
     *
     * ⚠️ **阻挡是单向的**：焰魔自己的物理（`ignis-boss-agent.js`）看不见玩家，
     * 故飞跃期靠 Agent 里的「与玩家过近则本步水平意图清零」守卫防穿（spec §2.5）。
     * ⚠️ **重叠自愈（v2.62 final review P1-3 → v2.78 补全）**：玩家若落在焰魔身体盒
     * **内部**，本方法会让 `_collides()` 恒真 ⇒ 玩家四轴全冻结（走不开也落不下）。
     * v2.62 的自愈在 Agent 侧：`_ringIntent` 的「真重叠例外后退」档（`d < overlapEscapeDist`
     * = 1.15，仅 chase 态）。**它覆盖不全**（v2.78 用户缺陷「跑太近就卡死」）：盒子随焰魔朝向变形
     * （重叠区单边 1.13 ~ 1.54），斜角站位被盒子扫到时 `d ≈ 1.4`，固定距离阈值永不触发。
     * 故 v2.78 起由**玩家物理自己兜底**：`step()` 开头 `_ejectFromBoss` 用同一判据
     * `overlapsAabb` 探出最近的出口并有界速度推出（不论盒子为何扫到玩家）。Agent 侧的后退保留，
     * 只是不再是唯一防线。⚠️ **不能只靠「玩家等焰魔走开」**—— 去退让后焰魔在贴近时站定、
     * 永不主动离开，那是个真软锁（详见 spec §2.7）。
     * @type {import('../entities/ignis/ignis-system.js').IgnisService|null}
     */
    this.ignises = null;
    /**
     * 末影守卫服务（装配层注入，同 `ignises` 手法 —— physics 不 import entities/）。
     *
     * 语义与焰魔完全一致：非 null 时 `_collides` 把**守卫身体盒**视为实心（「不动如山」），
     * 且 `_ejectFromBoss` 对两套 service 各探一次最近出口。
     * 原版佐证：守卫的 `KNOCKBACK_RESISTANCE = 1.0`（完全免疫击退）。
     * ⚠️ 守卫的盒比焰魔大得多（核心半宽 1.25 vs 0.83）且不对称，故推出余量更紧
     *（见 `EJECT_MAX` 注释）。
     * @type {import('../entities/guardian/guardian-system.js').GuardianService|null}
     */
    this.guardians = null;
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

  /**
   * 玩家被 **Boss 身体盒**「罩住」时，把玩家推出盒外（v2.78 焰魔；本次泛化到双 Boss）。
   *
   * ## 问题
   *
   * `_collides()` 把焰魔身体盒当实心，但**没有「已经在盒里怎么办」的分支**：玩家一旦落进盒内，
   * 每个候选位置都仍与盒重叠 ⇒ `_moveAxis` 与 `_tryStepUp` 全部被拒 ⇒ 前后左右 + 跳跃四轴冻结。
   * 玩家落进盒内的途径：焰魔转身（盒子 = 身体 OBB 绕 yaw 旋转后的包围盒，随朝向变形，扫过站得近的
   * 玩家，实测斜角站位陷入 0.3~0.4 格）/ 焰魔走位 / 传送 / 矿车下车。焰魔侧的自愈（`overlapEscapeDist`，
   * 仅 chase 态、仅 `d < 1.15`）覆盖不全，所以必须由玩家物理兜底 —— 与方块的处理一致：
   * 活塞推到实体就是把实体顶出去，而不是把它焊死在里面。
   *
   * ## 做法：用**同一个判据**探出最近的出口
   *
   * 冻结的条件是 `ignises.overlapsAabb(box)` 为真；推出的终点就是沿 ±X / ±Z 四个方向各自「第一次
   * 让该判据为假」的平移量，取最短的 ⇒ 与阻挡判据**按构造一致**，不再复制一份焰魔盒几何，也就不会
   * 出现「自愈用的几何与阻挡用的几何对不上」（旧自愈的固定距离阈值正是这么失效的）。
   * 只在重叠时才探（≤ 4 方向 × 100 次）；不重叠的绝大多数帧只多一次 `overlapsAabb`。
   *
   * ## 约束
   *
   * - **有界速度**（`IGNIS_EJECT_SPEED · dt`）：是被顶开，不是瞬移。
   * - **不能推进方块里**：出口位置用 `collidesAt`（只查方块）校验，堵住的方向放弃、改走次近的。
   * - **只推水平**：重叠时竖直方向由重力/站立照常处理；玩家站在盒顶是贴面，不算重叠。
   * - 不改「不动如山」：朝盒子里走仍被 `_collides()` 挡住，本方法只处理「已经在里面」。
   * @param {number} dt 秒
   */
  _ejectFromBoss(dt) {
    const services = [];
    if (this.ignises) services.push(this.ignises);
    if (this.guardians) services.push(this.guardians);
    if (services.length === 0) return;
    const box = this.aabb();
    const inside = services.filter((svc) => svc.overlapsAabb(box));
    if (inside.length === 0) return;              // 绝大多数帧到此为止
    const { x, y, z } = this.pos;
    let best = null;
    for (let d = 0; d < EJECT_DIRS.length; d++) {
      const dx = EJECT_DIRS[d][0], dz = EJECT_DIRS[d][1];
      for (let s = EJECT_PROBE; s <= EJECT_MAX; s += EJECT_PROBE) {
        if (best && s >= best.s) break;           // 不可能比已找到的更短
        _probeBox.minX = box.minX + dx * s; _probeBox.maxX = box.maxX + dx * s;
        _probeBox.minZ = box.minZ + dz * s; _probeBox.maxZ = box.maxZ + dz * s;
        _probeBox.minY = box.minY; _probeBox.maxY = box.maxY;
        // ⚠️ **双 Boss 同时在场时两套盒都不得重叠**才算出口（只判一套会推进另一只里）
        if (inside.some((svc) => svc.overlapsAabb(_probeBox))) continue;
        // 这个方向第一个不与任何 Boss 相交的位置：嵌进方块就放弃这个方向（再往外只会更深）
        if (!this.collidesAt(x + dx * s, y, z + dz * s)) best = { s, dx, dz };
        break;
      }
    }
    if (!best) return;
    const move = Math.min(best.s, IGNIS_EJECT_SPEED * dt);
    const nx = x + best.dx * move, nz = z + best.dz * move;
    if (!this.collidesAt(nx, y, nz)) { this.pos.x = nx; this.pos.z = nz; }
  }

  /** 单步积分（调用方按 60Hz 定步长驱动） */
  step(dt) {
    // 先把玩家从 Boss 身体盒里推出来（若被罩住）：否则下面的移动会因 `_collides()` 恒真而四轴冻结
    this._ejectFromBoss(dt);
    if (this.flying) { this._stepFlying(dt); return; }
    const w = this.world;
    this.inWater = w.getBlockId(Math.floor(this.pos.x), Math.floor(this.pos.y + 0.5), Math.floor(this.pos.z)) === w.registry.idOf('water');
    const gravity = this.inWater ? GRAVITY * 0.4 : GRAVITY;
    this.vel.y += gravity * dt;
    if (this.inWater) { this.vel.y = Math.max(this.vel.y, -4); }
    const drag = this.horizontalDrag;
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
    // 焰魔身体盒视为实心（v2.62 用户缺陷⑦：「焰魔应该不动如山，玩家也应当停止前进，
    // 就类似撞到实心方块一样」）。
    //
    // ⚠️ **放在函数顶部而不是末尾**：`_moveAxis` 与 `_tryStepUp` 都是「先改 `this.pos`
    // 到候选位置、再问 `_collides()`」，故本方法读到的 `this.aabb()` 已经是候选位置 ——
    // 两处调用都因此自动生效（包括「抬一格后是否仍与焰魔重叠」⇒ 玩家爬不上焰魔）。
    //
    // ⚠️ **尺寸权威不互拷**（红线 1）：玩家盒由本文件的 `PLAYER_WIDTH/HEIGHT` 给出
    //（经 `aabb()`），焰魔盒由 `IgnisService.overlapsAabb` 内部的 `ignisAabbFor` 给出。
    if (this.ignises && this.ignises.overlapsAabb(this.aabb())) return true;
    // 守卫同理（本次新增）：两套盒都在**顶部**判 ⇒ `_moveAxis` 与 `_tryStepUp`
    // 两处调用自动生效（玩家爬不上任何一个 Boss）。
    // ⚠️ **漏这一行的形态**：`_collides()` 返回 false 而 `overlapsAabb()` 返回 true
    //⇒ 玩家直接走进守卫身体盒，然后被 `_ejectFromBoss` 每帧往外推一点、下一步又走回来
    //⇒ 净效果是「停在盒内 0.12 格深处」而不是盒外（实测踩到）。
    if (this.guardians && this.guardians.overlapsAabb(this.aabb())) return true;
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
   * 被埋进方块时**向上解卡**（传送 / 出生 / column 后到三条路径共用，唯一实现）。
   *
   * ## 为什么需要它
   *
   * `Game._teleportTo()` **刻意不等目标 column 加载**（v1.92 实测：等 1200 格外的 column
   * 会让面板点击阻塞秒级，且 async 异常被吞成「按钮没反应」）。传送当帧目标区域全是未加载
   * column，`WorldData.getBlockId()` 对缺失 column 返回 **0（空气）** → 玩家悬空、重力一路
   * 拉到世界底；随后 column GEN 完成，`fillColumn` 的「底部补实」把 `WORLD_MIN_Y` 到地表之间
   * 全填成 stone → **玩家 AABB 整个埋在实心石头里**。而 `_moveAxis` 只在 `delta !== 0` 时检测
   * 碰撞、碰撞后二分回退到零位移并清零 `vel` → 水平与竖直全部冻结（用户报告的
   * 「瞬移完卡在地底下动弹不得」）。
   *
   * ## 判据复用 `collidesAt`，不另写一份
   *
   * `collidesAt(x, y, z)` 与 `_collides()` 共用 `PLAYER_WIDTH`/`PLAYER_HEIGHT` 这唯一一份尺寸权威
   * （红线 1），且**只查方块、不查矿车** —— 正是这里需要的语义：站在矿车上/车里不得被误判成
   * 「卡住」而被抬走。
   *
   * ## 成本
   *
   * 常态 = 一次 `collidesAt`（≤12 次 `getBlockId`，微秒级）即返回 0，**位置与速度逐位不变**
   * （不做任何浮点运算，故「常态零副作用」是可断言的）。只有真被埋时才逐格上扫，最坏
   * `WORLD_HEIGHT` 次 ≈ 0.1ms，且是一次性的。
   *
   * ## 抬到**整数** y，不是「当前 y + 1」
   *
   * 被埋时正确的落点是「站在地表上」，而地表高度是整数 —— 直接落到整数 y 有三个好处：
   * ① **不过冲**：玩家因 column 未加载而下坠了 0.44 格时，「+1 格」会抬到地表上方 0.56 格
   *    再掉回来（一次可见弹跳，且中间态会被「column ready 后立即读坐标」的用例读到）；
   * ② 恰好还原传送的 intended 落点（`tarnSurfaceYAt + 1` / `floorY + 1` 都是整数）；
   * ③ 与物理常态的静止位置同口径（`_moveAxis` 二分回退后玩家总是停在整数面上）。
   *
   * 抬升后可能悬空 → 由既有重力自然落下站稳，不做额外处理（与传送后短暂悬空同一口径）。
   *
   * @param {number} [maxRaise] 最多抬几格（默认整个世界高度）。抬到上限仍被埋 → **放弃并原地不动**，
   *        不静默抬到半路（半路仍在实心里等于没解卡，却让人以为解了）。
   * @returns {number} 实际抬升量（0 = 本来没被埋，或抬到上限仍无解）
   */
  resolveStuck(maxRaise = WORLD_HEIGHT) {
    if (!this.collidesAt(this.pos.x, this.pos.y, this.pos.z)) return 0;
    // 起点 = 不低于当前 y 的最小整数（当前 y 已知被埋，故整数 y 恰好等于它时 dy=0 也会被跳过）
    const base = Math.ceil(this.pos.y);
    for (let dy = 0; dy <= maxRaise; dy++) {
      const y = base + dy;
      if (!this.collidesAt(this.pos.x, y, this.pos.z)) {
        const raised = y - this.pos.y;
        this.pos.y = y;
        // 清零是载荷性的：被埋时重力已把 vel.y 压到很大的负值，不清会让解卡当帧又往下顶。
        this.vel.y = 0;
        return raised;
      }
    }
    return 0;
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

  /**
   * 本步的水平阻力系数（水中 `WATER_DRAG` / 其余 1）。
   *
   * **`step()` 与 `player.js` 的 footsteps 判据共用这一份**（红线 1）：后者要把期望位移
   * 按同一系数折算，否则「物理实际走的」与「判据以为应该走的」不同口径 ——
   * 这正是 v2.51 水中脚步声永不播的根因（actual/expected 恒 0.6 < 0.95）。
   * @returns {number}
   */
  get horizontalDrag() { return this.inWater ? WATER_DRAG : 1; }

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
