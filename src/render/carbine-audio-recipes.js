// src/render/carbine-audio-recipes.js — KV-9 与雨声的**合成配方**（three-free / DOM-free）
//
// 上游：`~/jaylli/bj-shooting-game/night-heron-src/src/audio.js`（Web Audio 全程序化合成，
// 零外部素材）。用户裁定「相关的音效可以从 bj-shooting-game 直接拷贝过来」——
// 上游没有音频文件可拷，**能拷的是合成配方**。本模块把那些配方逐字搬成纯数据。
//
// ## 为什么是「离线烘焙」而不是运行时合成
//
// 本仓 `AudioManager` 的既有口径是「预载 buffer + `THREE.Audio` 播放」（33 个素材文件）。
// 运行时合成要另建一套 AudioContext 图与生命周期，且上游的 `noise()`/`tone()` 每次都
// 新建 4~6 个 Web Audio 节点 —— 690 rpm 连射下每秒 ~70 个节点，与本仓「重计算离开主线程」
// 的取向相背。故把配方**离线渲染成 wav**（`tools/bake-carbine-audio.mjs` 用 Playwright 的
// Chromium + `OfflineAudioContext` 跑上游同一套 Web Audio 实现），运行时零合成成本。
//
// ⚠️ **这是数据格式转换，不产生新美术资源**：声音的参数、包络、滤波全部来自上游代码，
// 烘焙只是把「运行时算」换成「提前算」。
//
// ## 配方的两种原语（与上游 `noise()` / `tone()` 一一对应）
//
// `noise`：循环白/粉/棕噪声 buffer → BiquadFilter（可扫频）→ 增益包络 → 输出
// `tone` ：OscillatorNode（可扫频）→ 可选 lowpass → 增益包络 → 输出
//
// 包络统一是上游 `_env`：`0.0001 → peak`（线性 attack）→ `0.0001`（指数 decay）。
// ⚠️ **指数衰减不能到 0**（Web Audio 的 `exponentialRampToValueAtTime` 对 0 抛异常），
// 上游取 0.0001，本模块逐字保留。
//
// ⚠️ **本文件不 import three / 不碰 DOM**：`tools/*-fingerprint.mjs` 与 `check:data` 要在
// Node 里 import 它算指纹（同 `audio-config.js` 的理由）。
//
// ## 烘焙增益（CARBINE_AUDIO_MASTER_GAIN）—— 与上游的一处必要偏离
//
// 上游把多层相加后过 DynamicsCompressor（threshold −14dB / ratio 5）才不削顶。
// **实测（三轮重烘逐字节对比）：那个压缩器在 OfflineAudioContext 下逐次运行
// 输出不同字节**（时间相关的非线性器件，内部状态与渲染分块调度有关）
// ⇒ 把它烘进产物会让指纹门禁每次都报「过期」（短枪声 0.62s 恰好稳定，
// 12s 雨声床与 6.4s 雷声不稳定）。⇒ 烘焙只存**线性混音 × 固定标量增益**的波形
// （完全确定），防削顶靠 headroom 而不是压缩器。
// 听感差异：峰值不再被压住 ⇒ 瞬态更脆（枪声更「利」），但多层相对比例与频谱完全不变。

/** 采样率（离线渲染与指纹共用；上游用设备默认，本仓固定 44100 保证产物可复现） */
export const CARBINE_AUDIO_RATE = 44100;

/**
 * 烘焙总线增益（标量，**完全确定**）。
 *
 * 标定依据：各配方的「层峰值增益 + 混响送出」之和最大是 carbine_fire 的 **3.10**
 * （见 `recipeGainSum()`）。取 **0.28** ⇒ 理论上界 0.87，实测峰值落在 0.5~0.8，
 * 既留足 headroom 又不至于太小（产物 RMS 与本仓既有 mp3 素材同量级）。
 *
 * ⚠️ **不得改回「靠压缩器防削顶」**：那会让产物不可复现（见文件头实测）。
 * ⚠️ 改这个值必须重跑 `npm run carbineaudio`（它进指纹）。
 */
export const CARBINE_AUDIO_MASTER_GAIN = 0.28;

/**
 * 噪声 buffer 的种类与生成参数（上游 `init()` 里的三段 `makeBuffer`）。
 *
 * `white`：均匀白噪声。
 * `pink` ：Paul Kellet 的三阶滤波近似（系数逐字取自上游）。
 * `brown`：一阶积分 + 泄漏（`l = (l + 0.02*w)/1.02`，输出 ×3.2）。
 * `patter`：520 个随机短正弦「雨点击打」叠加（雨声专用，见 `RAIN_RECIPE`）。
 *
 * ⚠️ **长度进入指纹**：循环 buffer 的长度决定循环周期，改了声音的「纹理」会变。
 */
export const NOISE_BUFFERS = Object.freeze({
  white: Object.freeze({ kind: 'white', seconds: 2, channels: 1 }),
  pink: Object.freeze({ kind: 'pink', seconds: 4, channels: 2 }),
  brown: Object.freeze({ kind: 'brown', seconds: 5, channels: 2 }),
  patter: Object.freeze({ kind: 'patter', seconds: 6, channels: 2, drops: 520 }),
});

/**
 * 混响脉冲（上游 `init()` 的 street-canyon reverb）。
 *
 * ⚠️ 它是**上游枪声「在巷子里」的空间感来源**：`gunshot()` 的四层里有三层带 `rev`。
 * 去掉它枪声会变成「贴耳的干响」，与上游听感明显不同。
 * 参数逐字：2.6s / 2 声道 / 一阶低通 0.45 / 衰减指数 2.2 与 exp(-1.6t) /
 * 前 12ms 淡入 / t≈0.11 与 t≈0.23 处两次早期反射（×2）。
 */
export const REVERB_IR = Object.freeze({
  seconds: 2.6, channels: 2, lp: 0.45, decayPow: 2.2, decayExp: 1.6,
  fadeIn: 0.012, reflections: Object.freeze([0.11, 0.23]), reflectionGain: 2,
  sendGain: 0.55,
  /**
   * IR 能量归一化（**与 Web Audio ConvolverNode 的 `normalize=true` 默认同语义**）。
   *
   * ⚠️⚠️ **必需，不是可调旋钮**（实测）：不归一化时 IR 的抽头平方和很大
   * （lp 0.45 的一阶低通使相邻抽头强相关，能量远高于白噪 IR），
   * 卷积后雷声峰值冲到 **1.95**（削顶）。Web Audio 的 ConvolverNode 默认就会
   * 按 IR 能量缩放（spec 的 normalization scale），所以上游听感本来就是归一化后的。
   * 本项让纯 JS 卷积与它对齐 —— 取 true 时烘焙时按 sqrt(Σh²) 归一。
   */
  normalize: true,
});

/**
 * 压缩器（上游 `init()` 的 DynamicsCompressor）—— **只在运行时应用，不进烘焙产物**。
 *
 * ⚠️⚠️ **实测结论（三轮重烘对比）**：`DynamicsCompressorNode` 在
 * `OfflineAudioContext` 下**逐次运行输出不同字节**（它是时间相关的非线性器件，
 * 内部状态与渲染分块调度有关）⇒ 把它烘进产物会让指纹门禁每次都报「过期」。
 * 短音效（枪声 0.62s）恰好稳定，但雨声床（12s）与雷声（6.4s）不稳定。
 *
 * ⇒ 烘焙只存「线性混音后的波形」，压缩留给运行时（本仓 `AudioManager` 可在
 * listener 上挂一个）。本常量保留作为**运行时参数权威**与指纹的一部分。
 */
export const MASTER_COMP = Object.freeze({
  threshold: -14, knee: 12, ratio: 5, attack: 0.003, release: 0.2,
});

/**
 * 各音效的配方。**逐字对应上游同名方法**。
 *
 * 字段口径：
 *   `dur`  产物总长（秒）—— 必须 ≥ 最晚一层的 `at + a + d`，否则尾部被截断（静默变短）
 *   `layers` 层数组，每层 `{ kind:'noise'|'tone', ... }`
 *     公共：`at`（起始偏移秒）`a`（attack）`d`（decay）`g`（峰值增益）`rev`（混响送出量）
 *     noise：`buf`（噪声种类）`type`（滤波类型，缺省 bandpass）`f` `f2`（扫频终点）`q` `rate`
 *     tone ：`type`（振荡波形，缺省 sine）`f` `f2` `glide`（扫频时长，缺省 d）`lp`（后置低通）
 *
 * ⚠️ **`rand` 字段**：上游用 `rand(a,b)` 让每发枪声略有不同（音高抖动 ±5%）。
 * 离线烘焙只能定一个值 ⇒ 取**区间中点**（`r = 1`），并把「运行时逐发音高抖动」交给
 * `AudioManager` 的 `setDetune`（若将来要）。当前不做：上游抖动仅 ±5%，
 * 而 690rpm 下相邻两发间隔 87ms，听感差异远小于连射本身的密度。
 */
export const CARBINE_RECIPES = Object.freeze({
  /** 上游 `gunshot()`（r = 1，即 rand 中点） */
  carbine_fire: Object.freeze({
    dur: 0.62,
    layers: Object.freeze([
      { kind: 'noise', buf: 'white', type: 'highpass', f: 2600, d: 0.035, g: 0.5 },
      { kind: 'noise', buf: 'white', type: 'lowpass', f: 3800, f2: 320, q: 0.6, d: 0.15, g: 1.0, rev: 0.5 },
      { kind: 'tone', f: 165, f2: 46, d: 0.11, g: 1.0 },
      { kind: 'noise', buf: 'white', type: 'bandpass', f: 1200, q: 0.7, a: 0.01, d: 0.4, g: 0.12, rev: 1.6 },
      { kind: 'tone', type: 'square', f: 2100, d: 0.012, g: 0.1, at: 0.035 },
    ]),
  }),
  /** 上游 `reload(0)`：卸弹匣（卡扣 + 匣体滑落） */
  carbine_reload_out: Object.freeze({
    dur: 0.32,
    layers: Object.freeze([
      { kind: 'noise', buf: 'white', f: 1800, q: 2, d: 0.06, g: 0.5 },
      { kind: 'tone', type: 'square', f: 600, f2: 300, d: 0.05, g: 0.2 },
      { kind: 'noise', buf: 'white', f: 900, q: 1, d: 0.12, g: 0.25, at: 0.12 },
    ]),
  }),
  /** 上游 `reload(1)`：插新弹匣（到位咔嗒） */
  carbine_reload_in: Object.freeze({
    dur: 0.2,
    layers: Object.freeze([
      { kind: 'noise', buf: 'white', f: 2400, q: 2.5, d: 0.05, g: 0.6 },
      { kind: 'tone', type: 'square', f: 900, f2: 1500, d: 0.04, g: 0.22 },
      { kind: 'tone', f: 180, f2: 90, d: 0.06, g: 0.5 },
    ]),
  }),
  /** 上游 `reload(2)`：拉机柄（两声金属） */
  carbine_reload_rack: Object.freeze({
    dur: 0.24,
    layers: Object.freeze([
      { kind: 'noise', buf: 'white', f: 2800, q: 2, d: 0.045, g: 0.55 },
      { kind: 'noise', buf: 'white', f: 3400, q: 2, d: 0.05, g: 0.6, at: 0.09 },
      { kind: 'tone', type: 'square', f: 1300, d: 0.02, g: 0.2, at: 0.09 },
    ]),
  }),
  /**
   * 上游 `casing(x,y,z,n)`：弹壳落地叮声。
   * ⚠️ 上游频率是 `rand(4300,5600)`、增益 `0.2/n`（n = 第几次弹跳）。
   * 烘焙取中点 4950 与 n=1；弹跳衰减由播放侧音量表达（`carbine-fx` 逐次减半）。
   */
  carbine_casing: Object.freeze({
    dur: 0.14,
    layers: Object.freeze([
      { kind: 'tone', f: 4950, d: 0.07, g: 0.2 },
      { kind: 'tone', f: 4950 * 1.48, d: 0.05, g: 0.1 },
    ]),
  }),
  /** 上游 `impact(...,'concrete')`：命中混凝土/石头 */
  carbine_impact_stone: Object.freeze({
    dur: 0.2,
    layers: Object.freeze([
      { kind: 'noise', buf: 'white', f: 2000, f2: 700, q: 0.7, d: 0.09, g: 1.3 },
      { kind: 'tone', f: 190, f2: 80, d: 0.05, g: 0.7 },
    ]),
  }),
  /** 上游 `impact(...,'metal')`：命中金属（取 rand 中点） */
  carbine_impact_metal: Object.freeze({
    dur: 0.3,
    layers: Object.freeze([
      { kind: 'tone', type: 'triangle', f: 2450, f2: 1150, d: 0.16, g: 0.7 },
      { kind: 'noise', buf: 'white', f: 4200, q: 1.2, d: 0.05, g: 0.9 },
    ]),
  }),
  /** 上游 `impact(...,'wet')`：命中湿地面/水面 */
  carbine_impact_wet: Object.freeze({
    dur: 0.26,
    layers: Object.freeze([
      { kind: 'noise', buf: 'white', f: 1500, f2: 500, q: 0.8, d: 0.12, g: 1.1 },
      { kind: 'noise', buf: 'white', type: 'highpass', f: 3600, d: 0.09, g: 0.4 },
    ]),
  }),
  /** 上游 `hit(kill=false, head=false)`：命中敌人的提示音（不含击杀后缀） */
  carbine_hit: Object.freeze({
    dur: 0.1,
    layers: Object.freeze([
      { kind: 'tone', type: 'square', f: 1900, d: 0.035, g: 0.17 },
    ]),
  }),
  /** 上游 `hit(kill=true)`：击杀提示音（三声上行） */
  carbine_kill: Object.freeze({
    dur: 0.36,
    layers: Object.freeze([
      { kind: 'tone', type: 'square', f: 1900, d: 0.035, g: 0.17 },
      { kind: 'tone', type: 'triangle', f: 1250, d: 0.09, g: 0.3, at: 0.05 },
      { kind: 'tone', type: 'triangle', f: 1870, d: 0.16, g: 0.3, at: 0.12, rev: 0.4 },
    ]),
  }),
});

/**
 * 雨声床（上游 `_startAmbience()` 的四条雨循环 + LFO）。
 *
 * ⚠️ **只取雨的四条**：上游同一段还起了 `traffic`（远处车流）与霓虹嗡鸣、警笛、
 * 汽车喇叭 —— 那些是「滨城巷战」的城市氛围，本仓是 Minecraft 世界，**不移植**。
 *
 * 四条循环（上游逐字）：
 *   rainHiss  white → highpass 5200 Q0.5 gain 0.045
 *   rainBody  pink  → bandpass 1500 Q0.4 gain 0.22（+ LFO 0.11Hz 深度 0.05）
 *   rainLow   brown → lowpass   420 Q0.5 gain 0.20
 *   rainPat   patter→ highpass  900 Q0.5 gain 0.42
 *
 * ⚠️ **LFO 必须保留**：它是雨声「一阵一阵」的来源。去掉后是恒定白噪，
 * 听感从「下雨」退化成「电视没信号」。
 *
 * 产物是**一条 12 秒的立体声循环**（四条已在离线渲染时混好）——
 * 运行时只需一个 `playLoop('rain_storm')`，与本仓既有 `rain.mp3` 的接法完全一致。
 * 12s = 上游 patter buffer(6s) 的 2 倍 ⇒ 循环接缝处击打纹理不重复。
 */
export const RAIN_STORM_RECIPE = Object.freeze({
  id: 'rain_storm',
  dur: 12,
  beds: Object.freeze([
    { buf: 'white', type: 'highpass', f: 5200, q: 0.5, gain: 0.045 },
    { buf: 'pink', type: 'bandpass', f: 1500, q: 0.4, gain: 0.22, lfoHz: 0.11, lfoDepth: 0.05 },
    { buf: 'brown', type: 'lowpass', f: 420, q: 0.5, gain: 0.2 },
    { buf: 'patter', type: 'highpass', f: 900, q: 0.5, gain: 0.42 },
  ]),
});

/**
 * 上游 `thunder(strength)`：远雷（雨天氛围）。
 * ⚠️ 用户没点名要雷声，但上游雨景里它是「远处雨雾」的听觉对应物，且**零新增素材**
 * （同一段合成配方）。取 strength=1 的原值。
 */
export const THUNDER_RECIPE = Object.freeze({
  id: 'rain_thunder',
  dur: 6.4,
  layers: Object.freeze([
    { kind: 'noise', buf: 'brown', type: 'lowpass', f: 420, f2: 60, q: 0.4, a: 0.06, d: 4.2, g: 1.25, rev: 0.6 },
    { kind: 'noise', buf: 'brown', type: 'lowpass', f: 160, f2: 40, q: 0.4, a: 0.6, d: 5.5, g: 0.9, at: 0.5 },
    { kind: 'noise', buf: 'white', type: 'bandpass', f: 2600, f2: 500, q: 0.6, a: 0.004, d: 0.5, g: 0.22, rev: 0.8 },
  ]),
});

/**
 * 配方的「层峰值增益 + 混响送出」之和（headroom 估算用）。
 * ⚠️ 它是**保守上界**而不是真实峰值：各层包络峰值不同时到达，真实峰值更低。
 * 单测钉住「最大上界 × MASTER_GAIN < 1」（防削顶的关系式）。
 * @param {object} r 配方
 * @returns {number}
 */
export function recipeGainSum(r) {
  if (r.beds) return r.beds.reduce((n, b) => n + b.gain + (b.lfoDepth ?? 0), 0);
  return (r.layers ?? []).reduce((n, l) => n + l.g * (1 + (l.rev ?? 0) * REVERB_IR.sendGain), 0);
}

/**
 * 全部产物 id（烘焙脚本与 `audio-config.SOUND_IDS` 的对账口径）。
 * ⚠️ 顺序固定（进入指纹）。
 */
export const CARBINE_AUDIO_IDS = Object.freeze([
  ...Object.keys(CARBINE_RECIPES), RAIN_STORM_RECIPE.id, THUNDER_RECIPE.id,
]);

/**
 * 配方 → 稳定串（供指纹）。**只序列化影响声音的字段**，键序固定。
 * @param {object} r 配方
 * @returns {string}
 */
export function recipeKey(r) {
  if (r.beds) {
    return `beds:${r.dur}|${r.beds.map((b) => [b.buf, b.type, b.f, b.q, b.gain, b.lfoHz ?? 0, b.lfoDepth ?? 0].join(',')).join(';')}`;
  }
  const layers = (r.layers ?? []).map((l) => [
    l.kind, l.buf ?? '', l.type ?? '', l.f ?? '', l.f2 ?? '', l.q ?? '',
    l.a ?? '', l.d, l.g, l.at ?? 0, l.rev ?? 0, l.lp ?? '', l.glide ?? '', l.rate ?? '',
  ].join(','));
  return `dur:${r.dur}|${layers.join(';')}`;
}