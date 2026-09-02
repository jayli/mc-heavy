// src/render/weather.js — 天气状态机（M3-3）：晴 → 雨 → 晴 随机周期
// roadmap Task M3-3 验收口径：mc-lite 是手动 toggle（Game.js toggleRain），
// mc-heavy 实现自动随机周期 + force 手动覆盖，共用同一过渡语义。
// 本文件不依赖 three（与 daynight.js 同口径，浏览器内单测可直接构造）。

/** 冻结常量（roadmap M3-3；视觉参数 = mc-lite getRainQualityOptions 高档实测值） */
export const RAIN = {
  // 天气状态机周期（秒）
  TRANSITION_SECONDS: 5,        // 淡入/淡出过渡时长
  CLEAR_RANGE: [60, 180],       // 晴天随机周期
  RAIN_RANGE: [30, 90],         // 雨天随机周期
  // 雨滴视觉（mc-lite 高档：particleCount 267 / radius 18 / speed 24 / dropLength 0.5）
  PARTICLE_COUNT: 267,
  RADIUS: 18,
  SPEED: 24,
  DROP_LENGTH: 0.5,
  LINE_WIDTH: 2,
  REFRESH_DISTANCE: 8,          // 玩家移动超过 8m 触发雨幕迁移
  CYCLE_HEIGHT: 42,             // GPU 下落循环高度
  OPACITY: 0.6,
};

/**
 * 天气状态机：clear（晴）→ rain（雨）→ clear 循环，周期随机；
 * intensity ∈ [0,1] 为雨强度（过渡期线性淡入/淡出，视觉/雾效消费口径）。
 * force(kind) 手动切天气（设置面板/调试），从当前 intensity 平滑过渡，语义与自动周期一致。
 */
export class WeatherState {
  /**
   * @param {Object} [opts]
   * @param {() => number} [opts.rng] [0,1) 随机源，默认 Math.random
   * @param {[number,number]} [opts.clearRange] @param {[number,number]} [opts.rainRange]
   * @param {number} [opts.transition] 过渡秒数
   */
  constructor({ rng = Math.random, clearRange = RAIN.CLEAR_RANGE, rainRange = RAIN.RAIN_RANGE, transition = RAIN.TRANSITION_SECONDS } = {}) {
    this._rng = rng;
    this._clearRange = clearRange;
    this._rainRange = rainRange;
    this.transition = transition;
    /** 'clear'|'rain'（目标天气；过渡中即为过渡目标） */
    this.kind = 'clear';
    /** 雨强度 0..1（过渡期连续变化，稳态为 0 或 1） */
    this.intensity = 0;
    /** 'steady'|'transition' */
    this._phase = 'steady';
    this._timer = 0;
    this._startIntensity = 0;
    this._targetIntensity = 0;
    /** 当前稳态段时长（构造即抽第一个晴天周期） */
    this.stateSeconds = this._nextClear();
  }

  /** intensity > 0 即在降雨（含过渡）——雨滴可见性/雾效联动判据 */
  get isRaining() { return this.intensity > 0; }

  _nextClear() {
    const [lo, hi] = this._clearRange;
    return lo + this._rng() * (hi - lo);
  }

  _nextRain() {
    const [lo, hi] = this._rainRange;
    return lo + this._rng() * (hi - lo);
  }

  /** 手动切天气：从当前 intensity 进入对应过渡（幂等，重复 force 不跳变） */
  force(kind) {
    const target = kind === 'rain' ? 1 : 0;
    if (this.intensity === target && this._phase === 'steady') {
      this.kind = kind;
      this._timer = 0;
      this.stateSeconds = kind === 'rain' ? this._nextRain() : this._nextClear();
      return;
    }
    this._enterTransition(kind);
  }

  _enterTransition(kind) {
    this.kind = kind;
    this._phase = 'transition';
    this._timer = 0;
    this._startIntensity = this.intensity;
    this._targetIntensity = kind === 'rain' ? 1 : 0;
  }

  _finishTransition() {
    this._phase = 'steady';
    this._timer = 0;
    this.intensity = this._targetIntensity;
    // 稳态段时长在进入时抽取：rain 稳态用雨周期，clear 稳态用晴周期
    this.stateSeconds = this.kind === 'rain' ? this._nextRain() : this._nextClear();
  }

  _computeIntensity() {
    if (this._phase === 'transition') {
      const t = Math.min(this._timer / this.transition, 1);
      this.intensity = this._startIntensity + (this._targetIntensity - this._startIntensity) * t;
    }
  }

  /**
   * 推进天气。dt 允许大步长（测试/后台切回）：内部按阶段边界切分消费，
   * 跨多个周期也保持状态机语义（guard 防异常 dt 死循环）。
   * @param {number} dt 秒
   */
  update(dt) {
    let remaining = Math.max(0, dt);
    let guard = 0;
    while (remaining > 1e-9 && guard++ < 100000) {
      if (this._phase === 'steady') {
        const left = this.stateSeconds - this._timer;
        if (remaining < left) { this._timer += remaining; remaining = 0; }
        else {
          remaining -= left;
          this._enterTransition(this.kind === 'clear' ? 'rain' : 'clear');
        }
      } else {
        const left = this.transition - this._timer;
        if (remaining < left) { this._timer += remaining; this._computeIntensity(); remaining = 0; }
        else { remaining -= left; this._finishTransition(); }
      }
    }
    this._computeIntensity();
  }
}
