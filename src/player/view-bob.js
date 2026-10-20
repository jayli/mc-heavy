// src/player/view-bob.js — 跑动视角晃动（纯逻辑，无 three、无 DOM）
//
// **相位由「走过的距离」驱动，不是时间** —— 这是 MC 原版的机制
// （`GameRenderer.bobView()`：`walkDist += 0.6 × 水平位移`，`phase = walkDist × π`）。
// 好处是**晃动节奏自动贴合步伐**：走慢则晃慢、走快则晃快，不需要任何速度分支，
// 停下时相位原地不涨，也不会出现「身体停了镜头还在晃」。
//
// 原版公式（1.21 `GameRenderer.bobView`，经 `minecraft-renderer` 的 `computeCameraBob`
// 逐行核对，两边一致）：
//   position.x =  sin(φ) × bob × 0.5
//   position.y = −|cos(φ)| × bob              ← **只向下**，一个周期两次下沉（每步一次）
//   rotation.z =  sin(φ) × bob × 3°           ← 本仓关闭（见下方 ②）
//   rotation.x =  |cos(φ − 0.2)| × bob × 5°   ← 本仓关闭（见下方 ②）
// 其中 φ = walkDist × π，且 `bob` 是「水平速度上限 0.1」经 0.4/tick 缓动后的值。
//
// 与 mc-lite 的差异（mc-lite 的 `updateCameraBob` 是**时间**驱动 + 单频 `cos(2t)` 的 y）：
//  ① **相位改距离驱动**（v1.52）：用户反馈「左一步右一步的晃动，频率要适配跑动步伐节奏，
//     现在太快了」。原版本来就用距离驱动，这是它天然贴合步伐的原因。
//     频率标定见 `phasePerBlock` 的注释（对齐原版**疾跑步频** 1.684Hz，不是照抄步幅）。
//  ② **零旋转**（v1.51 用户硬要求「不要歪头」）：`rollAmount` / `pitchAmount` 置 0。
//     原版有 roll/pitch，这是**有意偏离**。字段保留（置 0 = 关闭，将来要开回来只改数值）。
//  ③ y 分量改用原版的 `−|cos(φ)|`（只向下、双频），取代 mc-lite 的 `cos(2t)×0.5`（双侧）。
//     「脚步落地才有下沉」比双侧正弦更像跑动。
//
// 为什么单拆一个模块（而不是塞进 player.js）：`player.js` 依赖 three + DOM，无法在
// 浏览器内单测里驱动；本模块是纯函数式状态机，交给 `test-view-bob.js` 做 Tier 1 断言。
// 与 `step-lift.js`（同类「纯视觉层小块」）同一手法。
//
// 与 mc-lite 的等价实现（不是行为改变）：上游另有独立的 `isObstructed`（其 `isStuck` 标志）
// 参与判据；本仓库没有那个状态，但「实际位移 > 意图位移 × 0.95」这半条判据已经覆盖撞墙
// 不动的场景 —— 见 `shouldBob()`，**不新增状态字段**（新增一份「是否卡住」的权威会与
// physics 的真实位移漂移，红线 1）。

/**
 * 晃动参数（冻结常量，单一权威）。
 *
 * **频率的推导（v1.52，务必整段读）**：
 * - 原版一个完整 bob 周期 = `walkDist` 增加 2 = 走过 `2 / 0.6 = 3.3333 格`
 *   （`phase = walkDist×π`，`walkDist += 0.6×dist`）。
 * - 原版疾跑 5.612 格/秒 → **1.6836 Hz**（周期 0.594s，每步 297ms）；走路 4.317 → 1.295 Hz。
 * - ⚠️ **不能照抄「3.333 格/周期」**：本仓 `SPEED = 8` 格/秒（`physics.js`，比原版快 ~43%），
 *   照抄步幅得到 `8 / 3.3333 = 2.400 Hz` —— **比原版更快**，与「晃得太快」的反馈方向相反。
 * - 故按**节奏时间**对齐，再按实玩逐档放慢：
 *   v1.52 原版疾跑 1.6836Hz（每步 297ms）→ **v1.54「稍微慢一点」1.5Hz**（每步 333ms）
 *   → **v1.55「再慢一档」1.35Hz**（每步 370ms）。
 * - **下界依据**：原版**走路**是 1.295Hz。1.35Hz 只剩 ~4% 余量 —— 再往下降就会落进
 *   走路的节奏里（那时的观感是「在走」而不是「在跑」，需要重新确认设计意图）。
 * - 换算：`phasePerBlock = 2π × f / SPEED = 2π × 1.35 / 8 = 1.0603 rad/格`。
 *   **改频率就改这个值；改 `physics.js` 的 `SPEED` 也必须重算**（否则频率随速度漂移，
 *   且不会有任何显式报错 —— 只有 `test-view-bob.js` 的频率断言会抓到）。
 */
export const BOB = Object.freeze({
  /**
   * 平移振幅上限（格）—— 对应原版 `bob` 的上限（原版是 0.1）。
   * mc-lite 0.05 → v1.49 上调 0.09 → v1.50 回调 0.07 → v1.52 对齐原版 0.1 →
   * v1.53 上调 0.13 → **v1.57 再上调 0.15**（用户「晃动幅度还不够大，稍微大一些」）。
   *
   * ⚠️ **标称值 ≠ 玩家看到的幅度**：`smoothingRetention` 是一阶低通，在 1.35Hz 处通过率
   * ≈ **0.916**（实测），故标称 0.15 时实际 y 峰 ≈ 0.1375、x 峰 ≈ 0.0687。判定「幅度够不够」
   * 要看**扣掉平滑后的实际峰值**（`test-view-bob.js` 与 `view-bob.spec.mjs` 各有实测断言），
   * 不能只比标称值。
   * ⚠️ 继续上调前先看观感上限：`intensity` 逼近 0.2 时 y 峰已接近 0.18 格（≈ 眼高的 11%），
   * 再往上会从「在跑」变成「晕」。
   * ⚠️ 调大这个值前先想清楚：`x` 幅度 = `intensity × 0.5`，`y` 幅度 = `intensity`（只向下）。
   * 二者的观感配比是原版口径，改比例会破坏「左右小、上下大」的手感。
   */
  intensity: 0.15,
  /**
   * 相位推进速度（弧度/格）—— 见上方推导，= 2π × 1.35Hz / 8格每秒 = 1.0603。
   * 一整个 bob 周期 = 走过 `2π / phasePerBlock = 5.9259 格`（= 8格/秒 ÷ 1.35Hz）。
   */
  phasePerBlock: 1.0603,
  /** 加速系数：amount 向 intensity 收敛的 60Hz 保留率 */
  attackRetention: 0.9,
  /** 减速系数：amount 向 0 收敛的 60Hz 保留率 */
  releaseRetention: 0.8,
  /** 输出平滑系数：offset 向目标值收敛的 60Hz 保留率 */
  smoothingRetention: 0.7,
  /** 「全速」判据：实际位移须达到意图位移的这个比例 */
  fullSpeedRatio: 0.95,
  /** 「在移动」判据：一帧的实际位移下限（格），低于此视为静止 */
  movingEpsilon: 0.001,
  /** 横向幅度相对 intensity 的比（原版 `sin(φ)·bob·0.5`） */
  lateralRatio: 0.5,
  /**
   * 相机 roll 幅度（弧度，绕 Z 轴）。
   * **v1.51 置 0**：用户明确要求「不要歪头」—— roll 会让地平线变斜，跑动时镜头必须始终水平。
   * 字段保留（而非删除）：它是「可配置的旋转幅度」，置 0 = 关闭；将来要开回来只改数值。
   */
  rollAmount: 0,
  /**
   * 相机 pitch 幅度（弧度，绕 X 轴）。
   * **v1.51 置 0**：用户选「旋转全部去掉」（不只是 roll）。理由同 `rollAmount`。
   */
  pitchAmount: 0,
});

/** 60Hz 保留率 → 本帧插值系数（帧率无关，与 mc-lite `1 - pow(k, dt*60)` 同式） */
function frameLerp(retention, dt) {
  return 1 - Math.pow(retention, dt * 60);
}

export class ViewBob {
  constructor() {
    /**
     * 相位（弧度）。**由走过的距离累积**（不是时间）—— 原版 `walkDist × π` 同口径。
     * 静止时归零（mc-lite 同口径，不是冻结在上一个相位）。
     */
    this.timer = 0;
    /** 当前振幅（格），上限 `intensity` */
    this.amount = 0;
    /** 施加到相机的位移（格）。**派生值**，每帧向 `timer` 推出的目标值收敛 */
    this.offset = { x: 0, y: 0 };
    /**
     * 施加到相机的旋转（弧度）。与 `offset` 同源、同步收敛。
     * 静止时两者都归零（不得残留歪头）。
     */
    this.roll = 0;
    this.pitch = 0;
  }

  /**
   * 判定本帧是否应晃动（mc-lite `shouldBob` 的同义判据）。
   * @param {{dx:number, dz:number, inputSpeed:number, jumping?:boolean, dt:number}} m
   *        `dx/dz` 本帧**实际**位移（格，调用方从物理前后位置算差值）；
   *        `inputSpeed` 玩家意图水平速度（格/秒）；`jumping` 在空中则 true
   * @returns {boolean}
   */
  static shouldBob({ dx, dz, inputSpeed, jumping = false, dt }) {
    if (jumping) return false;
    if (!(inputSpeed > 0)) return false;
    const expected = inputSpeed * dt;
    if (!(expected > 0)) return false;
    const actual = Math.sqrt(dx * dx + dz * dz);
    if (!(actual > BOB.movingEpsilon)) return false;
    return actual > expected * BOB.fullSpeedRatio;
  }

  /**
   * 每渲染帧推进。
   * @param {number} dt 秒
   * @param {{dx:number, dz:number, inputSpeed:number, jumping?:boolean}} motion
   */
  update(dt, motion) {
    const active = ViewBob.shouldBob({ ...motion, dt });
    if (active) {
      // **距离驱动**：相位增量 = 本帧走过的水平距离 × phasePerBlock（原版 walkDist 口径）。
      // 按物理步调用时，每步位移 × 每格弧度 = 恒定角速度；帧率无关是副产品。
      const dist = Math.sqrt(motion.dx * motion.dx + motion.dz * motion.dz);
      this.timer += dist * BOB.phasePerBlock;
      this.amount += (BOB.intensity - this.amount) * frameLerp(BOB.attackRetention, dt);
    } else {
      this.timer = 0;
      this.amount += (0 - this.amount) * frameLerp(BOB.releaseRetention, dt);
    }
    // 原版口径：x = sin(φ)·bob·0.5（双侧）；y = −|cos(φ)|·bob（只向下，每步一次下沉）
    const targetX = Math.sin(this.timer) * this.amount * BOB.lateralRatio;
    const targetY = -Math.abs(Math.cos(this.timer)) * this.amount;
    const k = frameLerp(BOB.smoothingRetention, dt);
    this.offset.x += (targetX - this.offset.x) * k;
    this.offset.y += (targetY - this.offset.y) * k;
    // 旋转分量（v1.49 引入 / v1.51 归零）：幅度由 `rollAmount` / `pitchAmount` 决定，
    // **两者当前均为 0 → 跑动全程零旋转，地平线恒水平**（用户 v1.51 的硬要求）。
    // 仍按 amount 缩放（与平移同源）：将来把幅度调回非 0 时，静止收敛的语义保持不变。
    // ⚠️ 这里是**唯一**写旋转的地方 —— `player.js` 只消费 `bob.roll` / `bob.pitch`，
    // 不得在那里另加常量（否则两处漂移，且「零旋转」这个不变式会静默失效）。
    const scale = this.amount / BOB.intensity;
    this.roll = Math.sin(this.timer) * BOB.rollAmount * scale;
    this.pitch = Math.abs(Math.cos(this.timer)) * BOB.pitchAmount * scale;
  }
}
