// src/render/daynight.js — 日夜循环 + 三种视觉风格（M2-6，参数移植 mc-lite Engine.js visualStyles）
// 时间 uniform 驱动（0-24h 周期，关键帧线性插值 → 平滑无跳变）；
// 风格切换 setStyle(key) 固定参数（M3 设置面板接入），setStyle(null) 恢复循环。
// 黑夜：uSkyDim 压暗 skylight + uBlockBoost 相对增强 blocklight（§7 M2-6 口径）。
// 不依赖 three（颜色用整数 hex 手工插值；.set(hex) 由调用方 Color/uniform 接受）。

export const VISUAL_STYLE_KEYS = { MORNING: 'morning', NOON: 'noon', NIGHT: 'night' };

/**
 * 三种视觉风格（mc-lite morning/overcast/night 参数映射；fog 距与 mc-heavy 视距口径适配）
 * sunDirection 为 **mc-lite Engine.js:74/99/122 原值（未归一化）** —— 唯一权威是这里；
 * paramsAtHour 与 _apply 在消费前归一化（见 normalizeDirection），调用方不得用原值做长度换算。
 */
export const VISUAL_STYLES = {
  morning: { sky: 0xb7c6f7, fogColor: 0xb7c6f7, fogScale: 1.0, skyDim: 0.8, blockBoost: 1.0, sunDirection: [0.18, 0.45, 0.88] },
  noon: { sky: 0x87ceeb, fogColor: 0x87ceeb, fogScale: 1.0, skyDim: 1.0, blockBoost: 1.0, sunDirection: [0, 0.8, 0.6] },
  night: { sky: 0x050b1e, fogColor: 0x050b1e, fogScale: 4.0, skyDim: 0.25, blockBoost: 1.2, sunDirection: [0.08, 0.25, 0.96] },
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

/**
 * 方向归一化（手工 Math.sqrt —— 本文件不依赖 three，故不用 Vector3.normalize）。
 * 不判零长度：三组原值的 y 分量均 > 0，而插值是三个向量的凸组合 → 结果 y 必 > 0，
 * 长度恒非零（新增风格数据若破坏该前提，须在 VISUAL_STYLES 处一并评估）。
 * 始终返回新数组，绝不原地改写入参（入参可能是 VISUAL_STYLES 的权威数组）。
 */
function normalizeDirection(v) {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
}

function lerpParams(a, b, t) {
  const ad = a.sunDirection, bd = b.sunDirection;
  return {
    sky: lerpHex(a.sky, b.sky, t),
    fogColor: lerpHex(a.fogColor, b.fogColor, t),
    fogScale: a.fogScale + (b.fogScale - a.fogScale) * t,
    skyDim: a.skyDim + (b.skyDim - a.skyDim) * t,
    blockBoost: a.blockBoost + (b.blockBoost - a.blockBoost) * t,
    sunDirection: [
      ad[0] + (bd[0] - ad[0]) * t,
      ad[1] + (bd[1] - ad[1]) * t,
      ad[2] + (bd[2] - ad[2]) * t,
    ],
  };
}

/** 小时 → 插值参数（纯函数，测试可用）；返回的 sunDirection **已归一化** */
export function paramsAtHour(hour) {
  const h = ((hour % 24) + 24) % 24;
  let p = null;
  for (let i = 0; i < KEYFRAMES.length - 1; i++) {
    const [t0, k0] = KEYFRAMES[i];
    const [t1, k1] = KEYFRAMES[i + 1];
    if (h >= t0 && h <= t1) {
      const t = t1 === t0 ? 0 : (h - t0) / (t1 - t0);
      p = lerpParams(VISUAL_STYLES[k0], VISUAL_STYLES[k1], t);
      break;
    }
  }
  if (!p) p = lerpParams(VISUAL_STYLES.noon, VISUAL_STYLES.noon, 0);
  p.sunDirection = normalizeDirection(p.sunDirection);
  return p;
}

export class DayNight {
  /**
   * @param {Object} opts
   * @param {Object} opts.scene three Scene（background 为 Color 实例）
   * @param {{fogNear: Object, fogFar: Object, fogColor: Object}} opts.fog setupFog 返回的 uniform 句柄
   * @param {{uSkyDim: Object, uBlockBoost: Object, uShadowStrength?: Object}} opts.voxelUniforms 体素材质日夜 uniform
   *   （uShadowStrength 句柄由 createVoxelMaterials 提供、本类消费；句柄缺失时跳过写入）
   * @param {number} [opts.baseFogNear] @param {number} [opts.baseFogFar] 视距基准雾距（fogScale 乘算）
   * @param {number} [opts.cycleSeconds] 一天时长（秒），默认 1200
   * @param {number} [opts.startHour] 初始小时，默认 12（正午，与 M1 视觉口径一致）
   * @param {(dir: [number, number, number]) => void} [opts.onSunDirection] 太阳方向变化回调（已归一化）
   */
  constructor({ scene, fog, voxelUniforms, baseFogNear, baseFogFar, cycleSeconds = 1200, startHour = 12, onSunDirection = null }) {
    this.scene = scene;
    this.fog = fog;
    this.voxelUniforms = voxelUniforms;
    this.baseFogNear = baseFogNear;
    this.baseFogFar = baseFogFar;
    this.cycleSeconds = cycleSeconds;
    this.hour = startHour;
    this.onSunDirection = onSunDirection;
    this._styleOverride = null;
    // 阴影总开关标志（Game.setShadowsEnabled 写入）：_apply 每次日夜推进都写
    // uShadowStrength，必须遵守该标志 —— 否则「关阴影」会在正常日夜循环的下一帧
    // 被覆写回 skyDim（静默失效；override 风格下 update() early-return 测不出来）。
    this.shadowEnabled = true;
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

  /** 当前生效参数（测试断言用）；sunDirection 与 paramsAtHour 同口径（已归一化） */
  get params() {
    if (!this._styleOverride) return paramsAtHour(this.hour);
    const p = { ...VISUAL_STYLES[this._styleOverride] };
    p.sunDirection = normalizeDirection(p.sunDirection);
    return p;
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
    // 阴影强度随天空亮度联动（天黑阴影自然消失）。句柄由 createVoxelMaterials 提供，
    // 未提供时跳过 —— 避免真实材质尚未接线时构造抛错（消费点：materials.js 的 colorNode）。
    // ⚠️ 遵守 shadowEnabled 标志：关闭时写 0 而非 skyDim（见构造器注释的静默失效）。
    const uShadowStrength = this.voxelUniforms.uShadowStrength;
    if (uShadowStrength) uShadowStrength.value = this.shadowEnabled ? p.skyDim : 0;
    // setStyle 传的是风格原值、paramsAtHour 已归一化 → 此处统一归一化，两条路径口径一致
    if (this.onSunDirection) this.onSunDirection(normalizeDirection(p.sunDirection));
  }
}
