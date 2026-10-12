// src/render/shadow-manager.js — 太阳阴影刷新节流（纯逻辑，无 DOM/three 依赖）
// mc-lite `World.requestShadowMapUpdate`（World.js:227-250）的 200ms 最小间隔 + `pendingShadowUpdate`
// 补刷同构：请求只挂起，由帧循环调 tick() 决定「本帧是否真的刷新」。
// ⚠️ 刷新口径是 **per-light**（WebGPU 后端经 `light.shadow.needsUpdate` 生效，spec DR-5）——
// 不是 mc-lite WebGL 的 `renderer.shadowMap.autoUpdate`，后者在本后端不生效。

/**
 * 阴影刷新节流器：调用方在触发点调 `request()`，每帧调 `tick(nowMs)` 取刷新许可。
 *
 * 时钟由调用方传入（`performance.now()` 基准），故本类是确定性纯逻辑，可直接单测。
 */
export class ShadowScheduler {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.minIntervalMs=200] 两次刷新最小间隔（mc-lite 原值 200ms）
   */
  constructor({ minIntervalMs = 200 } = {}) {
    this.minIntervalMs = minIntervalMs;
    this._lastFlushAt = -Infinity;
    this._pending = false;
  }

  /** 挂起一次刷新请求（节流期内不会丢，等窗口过后补刷一次） */
  request() {
    this._pending = true;
  }

  /**
   * 本帧是否应真正刷新阴影贴图。
   * @param {number} nowMs performance.now() 基准时刻
   * @returns {boolean} true = 应刷新（已消费 pending 并记录时刻）
   */
  tick(nowMs) {
    if (!this._pending) return false;
    if (nowMs - this._lastFlushAt < this.minIntervalMs) return false;
    this._pending = false;
    this._lastFlushAt = nowMs;
    return true;
  }
}
