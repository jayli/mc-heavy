// src/render/knockback-ease.js — 击退的**视觉**补间（纯渲染层，不影响权威位置）
//
// 用户 2026-11-08：「挥剑击杀敌人的时候，每次击杀都会让敌人向后移动一个短小的距离，现在
// 这个 boss 后退的逻辑是瞬移的，不是缓动的，我要从现在的瞬移变成缓动，中间有补间动画」。
//
// ## 分工（与 `player/step-lift.js` 的 y 缓动同一套，只是水平二维）
//
// 击退的**权威位移是瞬时的**：服务层 `knockback()` 在那一帧就把 `state.position` 移满
// `knockbackDistance`（0.9 格）。这不能改成逐帧挪 —— AABB、实体射线（剑的命中判据）、
// 方块碰撞、AI 的起点全部读 `state.position`，一旦它滞后，形态是「砍出去的那一刀按旧位置
// 判命中」「被推开的敌人卡进方块里」。所以滞后只落在**渲染位置**上：
//
//   渲染位置 = state.position − offset       （offset 在 ~0.2s 内 ease-out 归零）
//
// offset 的记忆口径是「**还欠多少没画出来**」：服务层每推 d 格就 `trigger(d)` 累加 d，
// 每渲染帧按指数衰减。故渲染位置从**旧位置**出发平滑追到新位置，收敛后两者逐位相等。
//
// ## 为什么不能「按位置增量自动触发」（不用阈值猜）
//
// 直觉做法是「渲染位置与物理位置差得多就平滑」，但那需要阈值：丧尸 AI 每帧 0.02 格、
// 飞龙 0.15 格、焰魔 0.09 格，且击退 0.9 格分三帧走完时每帧也只有 0.3 格 —— 阈值两侧
// 都会误伤（要么把正常追击也补间成「拖影」，要么漏掉分帧的击退）。故触发是**显式事件**：
// 服务层知道这一帧确实发生了击退（它刚算完 `next − prev`），通过注入的钩子上报。

/**
 * 指数衰减速率（1/秒）。与 `player/step-lift.js` 的 `DECAY_RATE` 同值同依据：
 * 12 ⇒ 50ms 走完 45%、100ms 走完 70%、165ms 走完 90%、190ms 走完 ≈10%（用户 2026-11-08
 * 选定「约 0.2 秒」）。相机侧沿用 12 的手感，这里不另调一套曲线 —— 观感统一，也不新增
 * 第二个需要标定的数字。
 */
const DECAY_RATE = 12;

/** 视觉不可见阈值（格）：低于它就归零收敛（否则指数衰减永远不会真正到 0） */
const CUTOFF = 0.004;

/**
 * 单次叠加的上限（格）：连续被砍时累计待补间位移不得无限增长，否则「砍十刀」会让敌人
 * 滞后画到 9 格。上限取 2 倍单次击退距离量级（0.9 × 2），超过就截断 —— 视觉上仍明显。
 */
const MAX_LAG = 2.0;

export class KnockbackEase {
  constructor() {
    /** 还欠画出来的水平位移（格）。渲染位置 = 物理位置 − offset */
    this.offsetX = 0;
    this.offsetZ = 0;
  }

  /**
   * 一次击退触发：把这段位移欠进 offset（累加，保持渲染位置连续不跳变）。
   * @param {number} dx @param {number} dz 已实际发生的水平位移（格，服务层算出的 `next − prev`）
   */
  trigger(dx, dz) {
    const ox = Number.isFinite(dx) ? dx : 0;
    const oz = Number.isFinite(dz) ? dz : 0;
    let nx = this.offsetX + ox;
    let nz = this.offsetZ + oz;
    const len = Math.hypot(nx, nz);
    if (len > MAX_LAG) {
      // 按比例截断：保持方向，只压长度（分别对两轴截断会让方向偏掉）
      const k = MAX_LAG / len;
      nx *= k;
      nz *= k;
    }
    this.offsetX = nx;
    this.offsetZ = nz;
  }

  /** 每渲染帧衰减（ease-out），收敛到 0 */
  update(dt) {
    if (this.offsetX === 0 && this.offsetZ === 0) return;
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const k = Math.exp(-DECAY_RATE * step);
    this.offsetX *= k;
    this.offsetZ *= k;
    if (Math.hypot(this.offsetX, this.offsetZ) < CUTOFF) {
      this.offsetX = 0;
      this.offsetZ = 0;
    }
  }

  /** 是否还有未补完的位移（测试/调试用；渲染层判零可以省一次乘法） */
  get active() { return this.offsetX !== 0 || this.offsetZ !== 0; }
}

export { DECAY_RATE as KNOCKBACK_EASE_DECAY_RATE, MAX_LAG as KNOCKBACK_EASE_MAX_LAG };
