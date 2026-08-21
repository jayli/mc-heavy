// src/render/daynight.js — 日夜循环 + 三种视觉风格（M2-6，参数移植 mc-lite Engine.js visualStyles）
// 时间 uniform 驱动（0-24h 周期，关键帧线性插值 → 平滑无跳变）；
// 风格切换 setStyle(key) 固定参数（M3 设置面板接入），setStyle(null) 恢复循环。
// 黑夜：uSkyDim 压暗 skylight + uBlockBoost 相对增强 blocklight（§7 M2-6 口径）。
// 不依赖 three（颜色用整数 hex 手工插值；.set(hex) 由调用方 Color/uniform 接受）。

export const VISUAL_STYLE_KEYS = { MORNING: 'morning', NOON: 'noon', NIGHT: 'night' };

/** 三种视觉风格（mc-lite morning/overcast/night 参数映射；fog 距与 mc-heavy 视距口径适配） */
export const VISUAL_STYLES = {
  morning: { sky: 0xb7c6f7, fogColor: 0xb7c6f7, fogScale: 1.0, skyDim: 0.8, blockBoost: 1.0 },
  noon: { sky: 0x87ceeb, fogColor: 0x87ceeb, fogScale: 1.0, skyDim: 1.0, blockBoost: 1.0 },
  night: { sky: 0x050b1e, fogColor: 0x050b1e, fogScale: 4.0, skyDim: 0.25, blockBoost: 1.2 },
};

// 日夜关键帧（小时 → 风格参数线性插值）：夜→晨→午→晨(暖)→夜
const KEYFRAMES = [
  [0, 'night'], [5, 'night'], [7, 'morning'], [9, 'noon'],
  [17, 'noon'], [19, 'morning'], [21, 'night'], [24, 'night'],
];

function lerpHex(a, b, t) {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

function lerpParams(a, b, t) {
  return {
    sky: lerpHex(a.sky, b.sky, t),
    fogColor: lerpHex(a.fogColor, b.fogColor, t),
    fogScale: a.fogScale + (b.fogScale - a.fogScale) * t,
    skyDim: a.skyDim + (b.skyDim - a.skyDim) * t,
    blockBoost: a.blockBoost + (b.blockBoost - a.blockBoost) * t,
  };
}

/** 小时 → 插值参数（纯函数，测试可用） */
export function paramsAtHour(hour) {
  const h = ((hour % 24) + 24) % 24;
  for (let i = 0; i < KEYFRAMES.length - 1; i++) {
    const [t0, k0] = KEYFRAMES[i];
    const [t1, k1] = KEYFRAMES[i + 1];
    if (h >= t0 && h <= t1) {
      const t = t1 === t0 ? 0 : (h - t0) / (t1 - t0);
      return lerpParams(VISUAL_STYLES[k0], VISUAL_STYLES[k1], t);
    }
  }
  return lerpParams(VISUAL_STYLES.noon, VISUAL_STYLES.noon, 0);
}

export class DayNight {
  /**
   * @param {Object} opts
   * @param {Object} opts.scene three Scene（background 为 Color 实例）
   * @param {{fogNear: Object, fogFar: Object, fogColor: Object}} opts.fog setupFog 返回的 uniform 句柄
   * @param {{uSkyDim: Object, uBlockBoost: Object}} opts.voxelUniforms 体素材质日夜 uniform
   * @param {number} [opts.baseFogNear] @param {number} [opts.baseFogFar] 视距基准雾距（fogScale 乘算）
   * @param {number} [opts.cycleSeconds] 一天时长（秒），默认 1200
   * @param {number} [opts.startHour] 初始小时，默认 12（正午，与 M1 视觉口径一致）
   */
  constructor({ scene, fog, voxelUniforms, baseFogNear, baseFogFar, cycleSeconds = 1200, startHour = 12 }) {
    this.scene = scene;
    this.fog = fog;
    this.voxelUniforms = voxelUniforms;
    this.baseFogNear = baseFogNear;
    this.baseFogFar = baseFogFar;
    this.cycleSeconds = cycleSeconds;
    this.hour = startHour;
    this._styleOverride = null;
    this._apply(paramsAtHour(this.hour));
  }

  /** 固定风格（M3 设置面板用）；null 恢复日夜循环 */
  setStyle(key) {
    this._styleOverride = key;
    if (key) this._apply({ ...VISUAL_STYLES[key] });
  }

  /** 直接设置时间（测试/调试） */
  setTime(hour) {
    this.hour = hour;
    if (!this._styleOverride) this._apply(paramsAtHour(hour));
  }

  /** 当前生效参数（测试断言用） */
  get params() {
    return this._styleOverride ? { ...VISUAL_STYLES[this._styleOverride] } : paramsAtHour(this.hour);
  }

  update(dt) {
    if (this._styleOverride) return;
    this.hour = (this.hour + dt * 24 / this.cycleSeconds) % 24;
    this._apply(paramsAtHour(this.hour));
  }

  _apply(p) {
    if (this.scene.background && this.scene.background.set) this.scene.background.set(p.sky);
    this.fog.fogColor.value.set(p.fogColor);
    if (this.baseFogNear !== undefined) {
      this.fog.fogNear.value = this.baseFogNear * p.fogScale;
      this.fog.fogFar.value = this.baseFogFar * p.fogScale;
    }
    this.voxelUniforms.uSkyDim.value = p.skyDim;
    this.voxelUniforms.uBlockBoost.value = p.blockBoost;
  }
}
