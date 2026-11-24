// tools/footstep-water-dsp.mjs — 水中脚步声的**信号处理核心**（零依赖纯函数）
//
// 从 `bake-footstep-water.mjs` 拆出来的理由：烘焙脚本要 `node:child_process`（ffmpeg 解码 mp3），
// 而**单测需要同一份算法**来钉「无缝性 / 步频 / 左右交替」这些判据 ——
// 让单测 import 一个会 spawn 进程的脚本不合适，且浏览器侧根本跑不了。
// 本模块只吃 Float64Array、吐 Float64Array，无 fs / 无 DOM / 无 three（红线 8 的同一精神）。
//
// ⚠️ **算法只有一份**（红线 1）：烘焙与单测都调 `bakeFootstepWater()`，
// 不在测试里另写一份叠接逻辑（那会让两侧共享同一个错误假设，得出「两者一致」的假结论）。
//
// ⚠️ **参数直接从 `src/render/footstep-water-recipe.js` 读，不经 fingerprint 模块**：
// 后者 import 了 `node:fs/path/crypto`，浏览器侧单测 import 它会当场解析失败。
// 本模块必须保持零 node 依赖，才能被 `src/tests/test-footstep-water.js` 在两种运行环境共用。
import {
  FOOTSTEP_WATER_RATE, FOOTSTEP_WATER_STEPS, FOOTSTEP_WATER_GRAIN_SECONDS,
  FOOTSTEP_WATER_GRAIN_PRE_SECONDS, FOOTSTEP_WATER_TAIL_FADE_SECONDS,
  FOOTSTEP_WATER_GRAINS, FOOTSTEP_WATER_ALT, FOOTSTEP_WATER_NORM_POWER,
  FOOTSTEP_WATER_EQ, FOOTSTEP_WATER_TARGET_RMS,
  FOOTSTEP_WATER_WARMUP_LOOPS, FOOTSTEP_WATER_RENDER_LOOPS,
  footstepWaterPeriodSamples, footstepWaterLoopSamples,
} from '../src/render/footstep-water-recipe.js';

/** RMS（与门禁 / 烘焙同一口径） */
export function rms(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(x.length, 1));
}

/** 峰值绝对值 */
export function peak(x) {
  let p = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > p) p = a; }
  return p;
}

/**
 * RBJ biquad cookbook 系数（归一化 a0），与 Web Audio `BiquadFilterNode` 同公式。
 * ⚠️ 与 `carbine-synth.mjs` 的 `biquad()` 同一套公式，但那份只支持 lp/hp/bandpass，
 * 这里还要 peaking EQ 与 high shelf（抬泼溅 / 压嘶声），故不共用而是补齐类型。
 */
function biquadCoef(kind, f0, q, gainDb, sr) {
  const w0 = 2 * Math.PI * f0 / sr;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  let alpha = sw / (2 * q);
  let b0; let b1; let b2; let a0; let a1; let a2;
  if (kind === 'hp') {
    b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  } else if (kind === 'lp') {
    b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  } else if (kind === 'peak') {
    const A = 10 ** (gainDb / 40);
    alpha = sw / (2 * q);
    b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
    a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
  } else if (kind === 'highshelf') {
    const A = 10 ** (gainDb / 40);
    const s = 2 * Math.sqrt(A) * alpha;
    b0 = A * ((A + 1) + (A - 1) * cw + s);
    b1 = -2 * A * ((A - 1) + (A + 1) * cw);
    b2 = A * ((A + 1) + (A - 1) * cw - s);
    a0 = (A + 1) - (A - 1) * cw + s;
    a1 = 2 * ((A - 1) - (A + 1) * cw);
    a2 = (A + 1) - (A - 1) * cw - s;
  } else {
    throw new Error(`未知滤波器类型 ${kind}`);
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** Direct Form I 逐样本滤波（与 Web Audio 同差分方程） */
function applyBiquad(x, c) {
  const y = new Float64Array(x.length);
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = c.b0 * x[i] + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/** 8 个带通能量占比的频带边界（Hz）。选粒依据与产物契约共用同一口径。 */
export const FOOTSTEP_BANDS = Object.freeze([
  [0, 80], [80, 200], [200, 500], [500, 1200], [1200, 2500],
  [2500, 5000], [5000, 8000], [8000, 22050],
]);

/** 原地迭代 radix-2 FFT（零依赖；N 必须是 2 的幂） */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang); const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1; let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k]; const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

/**
 * 带能量占比（1024 点 Hann 窗功率谱累加，帧移 512）。
 * ⚠️ 「是不是踩水声」的可测代理：泼溅主体 0.5~5kHz 占比高、泥闷 <200Hz 与嘶声 >8kHz 低。
 * @param {Float64Array} x @param {number} rate @returns {number[]} 与 FOOTSTEP_BANDS 同序
 */
export function bandShares(x, rate) {
  const N = 1024;
  const hop = 512;
  const acc = new Float64Array(N / 2 + 1);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  let frames = 0;
  for (let s = 0; s + N <= x.length; s += hop) {
    for (let i = 0; i < N; i++) { re[i] = x[s + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k <= N / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  if (!frames) return FOOTSTEP_BANDS.map(() => 0);
  let tot = 0;
  for (const v of acc) tot += v;
  if (tot <= 0) return FOOTSTEP_BANDS.map(() => 0);
  return FOOTSTEP_BANDS.map(([lo, hi]) => {
    let s = 0;
    for (let k = 0; k <= N / 2; k++) {
      const f = k * rate / N;
      if (f >= lo && f < hi) s += acc[k];
    }
    return s / tot;
  });
}

/**
 * RMS 包络（判步频与谷峰比用）。
 * @param {Float64Array} x @param {number} rate
 * @param {number} winSeconds @param {number} hopSeconds
 * @returns {{e: Float64Array, hop: number}}
 */
export function envelope(x, rate, winSeconds = 0.004, hopSeconds = 0.001) {
  const win = Math.round(winSeconds * rate);
  const hop = Math.round(hopSeconds * rate);
  const m = Math.floor((x.length - win) / hop) + 1;
  if (m <= 0) return { e: new Float64Array(0), hop };
  const e = new Float64Array(m);
  // 前缀平方和：O(n) 而不是 O(n·win)
  const sq = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) sq[i + 1] = sq[i] + x[i] * x[i];
  for (let i = 0; i < m; i++) e[i] = Math.sqrt((sq[i * hop + win] - sq[i * hop]) / win);
  return { e, hop };
}

/**
 * 烘焙主体。返回产物与逐颗粒指标（写进清单，供门禁与人工核对）。
 * @param {{x: Float64Array, rate: number}} source
 */
export function bakeFootstepWater(source) {
  const { x: mud, rate } = source;
  if (rate !== FOOTSTEP_WATER_RATE) throw new Error(`素材采样率 ${rate} ≠ ${FOOTSTEP_WATER_RATE}`);
  if (FOOTSTEP_WATER_STEPS % 2 !== 0) {
    throw new Error(`步数必须偶数（左右脚交替在接缝处才对得上），当前 ${FOOTSTEP_WATER_STEPS}`);
  }
  if (FOOTSTEP_WATER_GRAINS.length !== FOOTSTEP_WATER_STEPS
    || FOOTSTEP_WATER_ALT.length !== FOOTSTEP_WATER_STEPS) {
    throw new Error('颗粒时刻 / 音量系数的个数必须都等于步数');
  }
  const GL = Math.round(FOOTSTEP_WATER_GRAIN_SECONDS * rate);
  const PRE = Math.round(FOOTSTEP_WATER_GRAIN_PRE_SECONDS * rate);
  const FADE = Math.round(FOOTSTEP_WATER_TAIL_FADE_SECONDS * rate);
  const P = footstepWaterPeriodSamples();
  const N = footstepWaterLoopSamples();
  const coefs = FOOTSTEP_WATER_EQ.map((b) => biquadCoef(b.kind, b.f0, b.q, b.gainDb, rate));

  // ---- 截颗粒 + EQ + 尾部淡出 ----
  const grains = [];
  const grainMetrics = [];
  for (let k = 0; k < FOOTSTEP_WATER_STEPS; k++) {
    const t = FOOTSTEP_WATER_GRAINS[k];
    const start = Math.round(t * rate) - PRE;
    if (start < 0 || start + GL > mud.length) {
      throw new Error(`颗粒 ${k}（素材 ${t}s）越界：[${start}, ${start + GL}) / ${mud.length}`);
    }
    let g = mud.slice(start, start + GL);
    for (const c of coefs) g = applyBiquad(g, c);
    // 尾部淡出（1.5 次幂：前段保能量、末段快速归零）
    for (let i = 0; i < FADE; i++) {
      const w = 1 - i / (FADE - 1);
      g[GL - FADE + i] *= w ** 1.5;
    }
    grains.push(g);
    grainMetrics.push({ t, rms: +rms(g).toFixed(6) });
  }

  // ---- 部分能量归一（压掉步与步的悬殊差异，但保留自然起伏） ----
  const gm = grains.reduce((a, g) => a + rms(g), 0) / grains.length;
  for (let k = 0; k < grains.length; k++) {
    const scale = (gm / rms(grains[k])) ** FOOTSTEP_WATER_NORM_POWER;
    const g = grains[k];
    for (let i = 0; i < g.length; i++) g[i] *= scale;
    grainMetrics[k].gain = +scale.toFixed(6);
  }

  // ---- 多圈渲染（预热 + 稳态取样 + 校验余量） ----
  const total = N * FOOTSTEP_WATER_RENDER_LOOPS + GL;
  const long = new Float64Array(total);
  for (let k = 0; k < FOOTSTEP_WATER_STEPS * FOOTSTEP_WATER_RENDER_LOOPS; k++) {
    const g = grains[k % FOOTSTEP_WATER_STEPS];
    const off = k * P;
    const a = FOOTSTEP_WATER_ALT[k % FOOTSTEP_WATER_STEPS];
    for (let i = 0; i < GL; i++) long[off + i] += g[i] * a;
  }
  const warm = FOOTSTEP_WATER_WARMUP_LOOPS * N;
  const steady = long.slice(warm, warm + N);

  // ---- 响度对齐 running_land ----
  const gain = FOOTSTEP_WATER_TARGET_RMS / rms(steady);
  const loop = new Float64Array(N);
  for (let i = 0; i < N; i++) loop[i] = steady[i] * gain;

  // ---- 无缝判据：产物平铺 4 圈 ≡ 稳态长渲染的对应段（逐样本） ----
  let tileErr = 0;
  for (let i = 0; i < N * 4; i++) {
    const d = Math.abs(loop[i % N] - long[warm + i] * gain);
    if (d > tileErr) tileErr = d;
  }
  const bands = bandShares(loop, rate);
  return {
    loop,
    metrics: {
      periodSamples: P,
      loopSamples: N,
      seconds: +(N / rate).toFixed(6),
      peak: +peak(loop).toFixed(6),
      rms: +rms(loop).toFixed(6),
      loudnessGain: +gain.toFixed(6),
      tileMaxError: tileErr,
      bandShares: bands.map((v) => +v.toFixed(4)),
      grains: grainMetrics,
    },
  };
}

