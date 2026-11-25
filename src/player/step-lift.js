// src/player/step-lift.js — 上台阶视觉缓动（纯视觉层，不影响物理碰撞状态）
// 物理 step-up 必须瞬时（AABB 状态精确），相机侧用 ease-out 指数衰减
// 把抬升量在 ~190ms 内过渡完，消除"瞬移"感。下落/跳跃不走这里（重力自带过渡）。
const DECAY_RATE = 12;  // 指数衰减速率（到 10% 约 190ms）
const CUTOFF = 0.004;   // 视觉不可见阈值，归零收敛
/**
 * 缺省滞后上限（1 格）：连续上台阶时防止相机插进楼梯。
 *
 * ⚠️ **能上多格台阶的实体必须传入自己的 maxStep**（士兵 = 2）：不传时一次抬 2 格
 * 会被截断成 −1，画面上是「瞬时跳 1 格 + 缓动 1 格」（用户 2026-11-26 裁定要整段缓动）。
 * 衰减率与归零阈值**不参数化** —— 那两份是全局唯一手感（红线 1）。
 */
const MAX_LAG = 1.0;

export class StepLift {
  /** @param {number} [maxLag=1.0] 滞后上限（格），取该实体的台阶上限 */
  constructor(maxLag = MAX_LAG) {
    this.offset = 0;
    this._maxLag = Number.isFinite(maxLag) && maxLag > 0 ? maxLag : MAX_LAG;
  }
  /** 一次 step-up 触发：把相机拉回旧高度（累加，保持相机位置连续不跳变） */
  trigger(lift) { this.offset = Math.max(this.offset - lift, -this._maxLag); }
  /** 每渲染帧衰减（ease-out），收敛到 0 */
  update(dt) {
    if (this.offset === 0) return;
    this.offset *= Math.exp(-DECAY_RATE * dt);
    if (Math.abs(this.offset) < CUTOFF) this.offset = 0;
  }
  get active() { return this.offset !== 0; }
}
