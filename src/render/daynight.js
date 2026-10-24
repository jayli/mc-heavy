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
  morning: {
    sky: 0xb7c6f7, fogColor: 0xb7c6f7, fogScale: 1.0, skyDim: 0.8, blockBoost: 1.0,
    sunDirection: [0.18, 0.45, 0.88],
    // ACES 曝光（v1.70）：**1.00，与 noon 同档**。
    // ⚠️ mc-lite 的 morning 是 1.35，但**照搬它会抹掉晨昏感**：morning 的 `skyDim = 0.8`
    // 本来就要比 noon 暗一档（同曝光下实测 |morning−noon| = **0.0609**），而 1.35 的曝光
    // 恰好把它提亮回 noon 水平（实测差值塌到 **0.0036**，低于「晨与午必须可见不同」的
    // 0.01 门槛）。mc-lite 用 1.35 是因为它还有 `colorBrightness 1.06` 与暖色相补偿，
    // 本仓不移植那层 CSS 分级（用户要「真实感」而非「鲜艳」）。
    // 晨昏感由**既有数据**提供：skyDim 0.8 + 晨光天空色 0xb7c6f7 —— 不靠曝光重复表达。
    toneMappingExposure: 1.0,
    // 月亮方向 / 可见性 / 尺寸：mc-lite Engine.js:75,109,111 原值（未归一化，消费前统一归一化）
    moonDirection: [-0.38, 0.45, -0.81], moonVisible: false, moonSize: 20,
  },
  noon: {
    sky: 0x87ceeb, fogColor: 0x87ceeb, fogScale: 1.0, skyDim: 1.0, blockBoost: 1.0,
    sunDirection: [0, 0.8, 0.6],
    // ACES 曝光（v1.70）：**本仓实测最优 1.0，不是 mc-lite 的 1.25**。
    // 实测（同一机位、同一几何，只改 exposure）：0.9 → 暗部 p5=40 / 1.0 → p5=44、天空细节完整 /
    // 1.25 → p5=53 但**天空被冲到接近纯白、云层细节丢失**。
    // mc-lite 用 1.25 是因为它的体素材质是受光的 `MeshStandardNodeMaterial`（光照强度基准
    // 与本仓 unlit 管线不同）—— 照搬上游参数前须检查它是否在补偿另一个差异（v1.45 的
    // `shadow.radius` 同教训）。
    toneMappingExposure: 1.0,
    moonDirection: [-0.25, 0.5, -0.82], moonVisible: false, moonSize: 18,
  },
  night: {
    // ⚠️ **`fogScale` 已从 mc-lite 的 4.0 改为 1.0**（v1.61，用户拍板）：4.0 会把雾距
    // 拉到 `(vd+2)*16*0.95*4`（vd=8 时 **608 格**），而世界径向只加载约 160 格 →
    // **视野内没有任何方块到达雾区** → 雾完全不可见，「雾色融入天空」在夜里无物可染
    // （实测开关切换的像素变化 **0.0%**，而把雾距改回正午口径后是 4.0% / 最大 184）。
    // mc-lite 用 4.0 是因为它的夜景需要把雾推到看不见来模拟“远处漆黑”，本仓有夜空
    // 贴图与星点，不需要这个代偿。雾色与天色一致时，远景观感反而更自然。
    sky: 0x050b1e, fogColor: 0x050b1e, fogScale: 1.0, skyDim: 0.25, blockBoost: 1.2,
    sunDirection: [0.08, 0.25, 0.96],
    // ACES 曝光（v1.70）：**1.6，比正午高（而 mc-lite 的 night 是 0.95）**。
    // ACES 的暗部压缩在低亮度区最陡，不补曝光就会把夜空与地面一起吃掉。实测（night 机位）：
    //   NoToneMapping → mean 48.1 / p5 16 / p95 78
    //   ACES 1.0     → mean 33.0 / p5  3 / p95 70  ← **过暗（p5=3 近乎死黑）**
    //   ACES 1.25    → mean 39.1 / p5  5 / p95 83  ← 仍偏暗
    //   ACES 1.6     → mean 47.0 / p5  7 / p95 99  ← **平均回到基线，动态范围 62→92**
    //   ACES 2.0     → mean 55.1 / p5 10 / p95 115 ← 偏亮发灰
    // 1.6 让夜间「平均亮度回到现状」却把动态范围拉开 —— 这正是「夜该暗，但不是糊成一片」。
    // mc-lite 用 0.95 是为了压暗，本仓用更高曝光达到「压暗暗部、保住亮部」的同一个**意图**。
    toneMappingExposure: 1.6,
    moonDirection: [-0.32, 0.58, -0.75], moonVisible: true, moonSize: 34,
  },
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
  const am = a.moonDirection, bm = b.moonDirection;
  return {
    sky: lerpHex(a.sky, b.sky, t),
    fogColor: lerpHex(a.fogColor, b.fogColor, t),
    fogScale: a.fogScale + (b.fogScale - a.fogScale) * t,
    skyDim: a.skyDim + (b.skyDim - a.skyDim) * t,
    blockBoost: a.blockBoost + (b.blockBoost - a.blockBoost) * t,
    // ACES 曝光与其它标量同等对待（线性插值）—— 缺了这一行会让风格切换时曝光二态跳变。
    toneMappingExposure: a.toneMappingExposure + (b.toneMappingExposure - a.toneMappingExposure) * t,
    sunDirection: [
      ad[0] + (bd[0] - ad[0]) * t,
      ad[1] + (bd[1] - ad[1]) * t,
      ad[2] + (bd[2] - ad[2]) * t,
    ],
    moonDirection: [
      am[0] + (bm[0] - am[0]) * t,
      am[1] + (bm[1] - am[1]) * t,
      am[2] + (bm[2] - am[2]) * t,
    ],
    // 月亮可见性/尺寸不插值：它们是“这一风格要不要画月亮”的开关语义，取插值段右端的值。
    // （t<1 时取左端会让天亮前一刻仍在画月亮，而天空已亮——观感就是“白天有月亮”。
    //  取右端则与“黎明已亮”同步：早晨段直接关掉。）
    moonVisible: t > 0 ? b.moonVisible : a.moonVisible,
    moonSize: a.moonSize + (b.moonSize - a.moonSize) * t,
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
  p.moonDirection = normalizeDirection(p.moonDirection);
  return p;
}

/**
 * 夜间程度 0..1 —— 天空盒双图交叉淡入因子（v1.58）。
 *
 * **从既有 `skyDim` 派生，不新增权威**（红线 1）：正午 skyDim=1 → 0（全白天云图）；
 * skyDim 降到 night 的 0.25 → 1（全星空）。于是「天空变暗」与「星空浮现」天然同步，
 * 随关键帧插值**连续变化**，没有硬切换跳帧。
 *
 * 端点与中间值：noon 0 / morning 0.267 / night 1。
 * @param {{skyDim: number}} params paramsAtHour 或 VISUAL_STYLES 的结果
 */
export function nightBlendOf(params) {
  const nightDim = VISUAL_STYLES.night.skyDim;
  const raw = (1 - params.skyDim) / (1 - nightDim);
  // 钳制：skyDim 越界（未来新增风格 >1 或 <night）不得让混合因子溢出成负或 >1
  return Math.min(1, Math.max(0, raw));
}

export class DayNight {
  /**
   * @param {Object} opts
   * @param {Object} opts.scene three Scene（background 为 Color 实例）
   * @param {{fogNear: Object, fogFar: Object, fogColor: Object}} opts.fog setupFog 返回的 uniform 句柄
   * @param {{uSkyDim: Object, uBlockBoost: Object, uShadowStrength?: Object, uSunDirection?: Object}} opts.voxelUniforms 体素材质日夜 uniform
   *   （uShadowStrength / uSunDirection 句柄由 createVoxelMaterials 提供、本类消费；句柄缺失时跳过写入）
   * @param {{uNightBlend?: {value: number}} | null} [opts.skyUniforms] 天空盒 uniform 句柄
   *   （`setupSky` 提供；`?skybox=0` 或加载失败时为 null —— 本类必须容错）
   * @param {number} [opts.baseFogNear] @param {number} [opts.baseFogFar] 视距基准雾距（fogScale 乘算）
   * @param {number} [opts.cycleSeconds] 一天时长（秒），默认 1200
   * @param {number} [opts.startHour] 初始小时，默认 12（正午，与 M1 视觉口径一致）
   * @param {{toneMappingExposure: number}|null} [opts.renderer] 渲染器（只消费 `toneMappingExposure`
   *   属性）。**仅消费这一个字段**，所以 stub 传 `{ set toneMappingExposure(v){} }` 即可测；
   *   缺省 null（未装配 / 单测）→ 跳过写入。
   * @param {(dir: [number, number, number]) => void} [opts.onSunDirection] 太阳方向变化回调（已归一化）
   */
  constructor({ scene, fog, voxelUniforms, skyUniforms = null, baseFogNear, baseFogFar, cycleSeconds = 1200, startHour = 12, renderer = null, onSunDirection = null }) {
    this.scene = scene;
    this.fog = fog;
    this.voxelUniforms = voxelUniforms;
    this.skyUniforms = skyUniforms;
    this.renderer = renderer;
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

  /** 当前生效参数（测试断言用）；sunDirection / moonDirection 与 paramsAtHour 同口径（已归一化） */
  get params() {
    if (!this._styleOverride) return paramsAtHour(this.hour);
    const p = { ...VISUAL_STYLES[this._styleOverride] };
    p.sunDirection = normalizeDirection(p.sunDirection);
    p.moonDirection = normalizeDirection(p.moonDirection);
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
    // setStyle 传的是风格原值、paramsAtHour 已归一化 → 此处统一归一化，两条路径口径一致。
    // ⚠️ 归一化只算一次并**复用**同一个值：本函数在日夜循环下每帧跑，再来一遍就白付两次分配
    // 并且两处公式会各自漂移（红线 1 精神）。`_apply` 是所有写入路径的唯一收口点。
    const sunDir = normalizeDirection(p.sunDirection);
    // 太阳方向写给体素材质的 N·L 方向光（v1.58）。句柄由 createVoxelMaterials 提供；
    // fixture / 尚未接线时缺失 → 跳过（与 uShadowStrength 同一容错口径）。
    const uSunDirection = this.voxelUniforms.uSunDirection;
    if (uSunDirection && uSunDirection.value && typeof uSunDirection.value.set === 'function') {
      uSunDirection.value.set(sunDir[0], sunDir[1], sunDir[2]);
    }
    // ACES 色调映射的曝光随风格/日夜插值（v1.70）。**单一收口点**：setStyle 与日夜循环
    // 两条路径都经 _apply → 口径一致，不会出现「点风格按钮后曝光不跟」的撕裂。
    // renderer 缺省 null（单测 stub / 尚未装配）→ 跳过（与 uShadowStrength 同一容错口径）。
    if (this.renderer && typeof p.toneMappingExposure === 'number') {
      this.renderer.toneMappingExposure = p.toneMappingExposure;
    }
    // 天空盒双图交叉淡入因子（v1.58）：由既有 skyDim 派生，句柄由 setupSky 提供。
    const uNightBlend = this.skyUniforms && this.skyUniforms.uNightBlend;
    if (uNightBlend) uNightBlend.value = nightBlendOf(p);
    if (this.onSunDirection) this.onSunDirection(sunDir);
  }
}
