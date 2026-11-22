// tools/carbine-synth.mjs — KV-9 / 雨声的**离线合成器**（纯 JS，零 Web Audio / 零 DOM）
//
// 由 `tools/bake-carbine-audio.mjs` 调用。配方权威在
// `src/render/carbine-audio-recipes.js`（运行时/单测/烘焙三方共用）。
//
// ⚠️⚠️ **为什么不用 OfflineAudioContext**（实测三轮重烘逐字节对比后的必要偏离）：
// Web Audio 的节点图在**长产物**上逐次运行输出不同字节（12s 雨声床与 6.4s 雷声不稳定；
// ≤0.62s 的短音效恰好稳定）。去掉 DynamicsCompressor、去掉随机起始相位、
// 每个产物独立 RNG 流之后**仍然不稳定** ⇒ 与分块调度/节点内部状态有关。
// 烘焙产物必须可复现（指纹门禁），故整条链改成确定性 JS：
//   · 滤波器 = RBJ biquad cookbook + Direct Form I（与 BiquadFilterNode 同公式）；
//   · 扫频 = 指数插值逐样本更新系数（与 exponentialRampToValueAtTime 同式）；
//   · 包络 = 上游 _env 的逐样本版（线性 attack → 指数 decay 到 0.0001）；
//   · 混响 = 与 IR 的 FFT 卷积（ConvolverNode normalize=false 语义）。
// 声音内容（波形/滤波/包络/层增益/混响量）全部读同一份配方 ⇒ 与上游一致，
// 唯一听感差异是总线不再过压缩器而改用固定标量增益 + headroom（瞬态更脆，频谱不变）。
//
// ⚠️ **确定性**（红线 2）：噪声与雨点击打用固定种子 mulberry32，且**每个产物独立 RNG 流**
// （种子 = 全局种子 XOR id 的 FNV 哈希）—— 共用一条流时新增任一配方都会让其余产物变字节。

/**
 * 渲染全部配方。
 * @param {{rate:number, seed:number, gain:number, buffers:object, ir:object,
 *          recipes:object, rainBed:object, thunder:object}} cfg
 * @returns {Record<string,{channels:number,frames:number,samples:number[]}>}
 */
export function synthAll(cfg) {
  const { rate, seed, buffers, ir, comp, recipes, rainBed, thunder, gain } = cfg;

  // ---- 固定种子 RNG（mulberry32，与 tools/*-fingerprint.mjs 同款）----
  let a = seed >>> 0;
  const rnd = () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // ---- 噪声 buffer（上游 init() 的四段 makeBuffer，逐字）----
  function makeBuffer(ctx, spec) {
    const n = Math.floor(ctx.sampleRate * spec.seconds);
    const buf = ctx.createBuffer(spec.channels, n, ctx.sampleRate);
    for (let c = 0; c < spec.channels; c++) {
      const d = buf.getChannelData(c);
      if (spec.kind === 'white') {
        for (let i = 0; i < n; i++) d[i] = rnd() * 2 - 1;
      } else if (spec.kind === 'pink') {
        let b0 = 0, b1 = 0, b2 = 0;
        for (let i = 0; i < n; i++) {
          const w = rnd() * 2 - 1;
          b0 = 0.99765 * b0 + w * 0.099046;
          b1 = 0.963 * b1 + w * 0.2965164;
          b2 = 0.57 * b2 + w * 1.0526913;
          d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
        }
      } else if (spec.kind === 'brown') {
        let l = 0;
        for (let i = 0; i < n; i++) { l = (l + 0.02 * (rnd() * 2 - 1)) / 1.02; d[i] = l * 3.2; }
      } else if (spec.kind === 'patter') {
        for (let k = 0; k < spec.drops; k++) {
          const at = Math.floor(rnd() * (n - 2000));
          const f = 1400 + rnd() * 5200;
          const len = 90 + Math.floor(rnd() * 500);
          const g = Math.pow(rnd(), 2) * 0.55;
          for (let i = 0; i < len; i++) {
            d[at + i] += Math.sin((i / ctx.sampleRate) * f * 6.283) * Math.exp(-i / (len * 0.22)) * g * (0.5 + rnd());
          }
        }
      }
    }
    return buf;
  }

  // ---- 混响 IR（上游 init() 的 street-canyon reverb，逐字）----
  function makeIR(ctx) {
    const n = Math.floor(ctx.sampleRate * ir.seconds);
    const buf = ctx.createBuffer(ir.channels, n, ctx.sampleRate);
    for (let c = 0; c < ir.channels; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / ctx.sampleRate;
        const w = (rnd() * 2 - 1) * Math.pow(1 - i / n, ir.decayPow) * Math.exp(-t * ir.decayExp);
        lp += (w - lp) * ir.lp;
        let v = lp * (t < ir.fadeIn ? t / ir.fadeIn : 1);
        for (const r of ir.reflections) if (Math.abs(t - r) < 0.002) v += w * ir.reflectionGain;
        d[i] = v;
      }
    }
    return buf;
  }

  // ---- 包络（上游 _env 的**逐样本**版：线性 attack → 指数 decay 到 0.0001）----
  function envAt(t, t0, atk, dec, peak) {
    if (t < t0) return 0;
    const u = t - t0;
    if (u < atk) return 0.0001 + (peak - 0.0001) * (u / atk);
    const v = u - atk;
    if (v > dec) return 0;
    return peak * Math.pow(0.0001 / peak, v / dec);
  }

  /**
   * 渲染一个「层数组」配方 —— **纯 JS 逐样本求值，不用 Web Audio 节点**。
   *
   * ⚠️⚠️ **这是实测后的必要偏离，不是省事**（三轮重烘逐字节对比）：
   * 'OfflineAudioContext' 的节点图在**长产物**上逐次运行输出不同字节
   * （12s 雨声床与 6.4s 雷声不稳定；≤0.62s 的短音效恰好稳定）。
   * 去掉 DynamicsCompressor、去掉随机起始相位、每个产物独立 RNG 流之后**仍然不稳定**
   * ⇒ 与分块调度/节点内部状态有关，不是配方问题。烘焙产物必须可复现（指纹门禁），
   * 故整条链改成确定性 JS。
   *
   * **与上游的等价性**（逐项对齐，不是「重新设计声音」）：
   *   · 噪声/振荡波形、滤波类型与截止/Q、包络形状、层增益、混响送出量 —— 全部读同一份配方；
   *   · 滤波器 = RBJ biquad cookbook + Direct Form I（Web Audio BiquadFilterNode 同公式）；
   *   · 扫频 = 指数插值（与 exponentialRampToValueAtTime 同式），逐样本更新系数；
   *   · 混响 = 与 IR 的直接卷积（ConvolverNode 的 normalize=false 语义），
   *     用 FFT 加速（长度 2.6s × 44100 = 114660 抽头，直接卷积要 1e10 次乘法）。
   *
   * ⚠️ **唯一听感差异**：上游总线过 DynamicsCompressor（峰值被压住），本仓改用固定
   * 标量增益 + headroom（见配方文件的 CARBINE_AUDIO_MASTER_GAIN）。瞬态更脆，频谱不变。
   */
  function renderLayers(spec, seconds) {
    const n = Math.ceil(rate * seconds);
    const outL = new Float32Array(n);
    const outR = new Float32Array(n);
    // 只生成本配方用到的噪声 buffer（未用到的不得消耗 RNG）
    const need = [...new Set(spec.layers.filter((l) => l.kind === 'noise').map((l) => l.buf || 'white'))];
    const raw = {};
    for (const k of need) raw[k] = makeRawBuffer(buffers[k]);
    // 混响 IR（只在本配方有 rev 层时才生成 —— 同样不白耗 RNG）
    const hasRev = spec.layers.some((l) => l.rev);
    const irData = hasRev ? makeRawIR() : null;
    const wetL = hasRev ? new Float32Array(n) : null;
    const wetR = hasRev ? new Float32Array(n) : null;

    for (const l of spec.layers) {
      const t0 = l.at || 0;
      const atk = l.a || 0.002;
      const end = t0 + atk + l.d + 0.05;   // 上游 stop() 的时刻
      const i0 = Math.max(0, Math.floor(t0 * rate));
      const i1 = Math.min(n, Math.ceil(end * rate));
      const isNoise = l.kind === 'noise';
      const src = isNoise ? raw[l.buf || 'white'] : null;
      // 上游 noise 的随机起始相位（固定种子）；tone 无相位偏移
      const phase0 = isNoise ? rnd() * 1.5 : 0;
      const fStart = l.f || (isNoise ? 1000 : 440);
      const fEnd = l.f2 || 0;
      const sweepEnd = t0 + (isNoise ? atk + l.d : (l.glide || l.d));
      // 振荡器相位累积（扫频时必须逐样本积分，不能按 sin(2π f t) 算 —— 那会跑调）
      let oscPhase = 0;
      // 滤波器状态（每声道独立；tone 的 lp 是静态低通）
      const st = [];
      for (let c = 0; c < 2; c++) st.push({ x1: 0, x2: 0, y1: 0, y2: 0, lx1: 0, lx2: 0, ly1: 0, ly2: 0 });
      for (let i = i0; i < i1; i++) {
        const t = i / rate;
        const g = envAt(t, t0, atk, l.d, l.g);
        if (g <= 0) continue;
        const f = fEnd ? fStart * Math.pow(fEnd / fStart, Math.min(1, (t - t0) / Math.max(1e-6, sweepEnd - t0))) : fStart;
        const coef = isNoise || l.lp ? biquad(isNoise ? (l.type || 'bandpass') : 'lowpass', isNoise ? f : l.lp, isNoise ? (l.q ?? 0.8) : 0.7071, rate) : null;
        for (let c = 0; c < 2; c++) {
          let x0;
          if (isNoise) {
            const d = src[Math.min(c, src.length - 1)];
            const pos = (t - t0 + phase0) * rate * (l.rate || 1);
            x0 = d[((Math.floor(pos) % d.length) + d.length) % d.length];
          } else {
            oscPhase += 2 * Math.PI * f / rate;
            x0 = wave(l.type || 'sine', oscPhase);
          }
          let y = x0;
          const s = st[c];
          if (coef) {
            y = coef.b0 * x0 + coef.b1 * s.x1 + coef.b2 * s.x2 - coef.a1 * s.y1 - coef.a2 * s.y2;
            s.x2 = s.x1; s.x1 = x0; s.y2 = s.y1; s.y1 = y;
          }
          const v = y * g;
          if (c === 0) outL[i] += v; else outR[i] += v;
          if (hasRev && l.rev) { if (c === 0) wetL[i] += v * l.rev; else wetR[i] += v * l.rev; }
        }
      }
    }
    // 混响：wet × IR（FFT 卷积），再按 ir.sendGain 混回。
    // ⚠️ **IR 能量归一化**（ConvolverNode 的 normalize=true 默认语义）：
    // 不归一时 lp 0.45 的强相关 IR 会把雷声峰值推到 1.95（实测削顶）。
    if (hasRev) {
      const norm = ir.normalize ? irNormScale(irData) : 1;
      const cvL = convolve(wetL, irData[0]);
      const cvR = convolve(wetR, irData[Math.min(1, irData.length - 1)]);
      for (let i = 0; i < n; i++) {
        outL[i] += cvL[i] * ir.sendGain * norm;
        outR[i] += cvR[i] * ir.sendGain * norm;
      }
    }
    const samples = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { samples[i * 2] = outL[i] * gain; samples[i * 2 + 1] = outR[i] * gain; }
    return { channels: 2, frames: n, samples: Array.from(samples) };
  }

  /** 振荡波形（sine / square / triangle / sawtooth；与 Web Audio 同定义） */
  function wave(type, phase) {
    const p = phase / (2 * Math.PI);
    const f = p - Math.floor(p);
    if (type === 'square') return f < 0.5 ? 1 : -1;
    if (type === 'triangle') return f < 0.5 ? (4 * f - 1) : (3 - 4 * f);
    if (type === 'sawtooth') return 2 * f - 1;
    return Math.sin(phase);
  }

  /** 混响 IR 的纯 JS 版（与上游 makeIR 同公式、同一 RNG 流） */
  function makeRawIR() {
    const n = Math.floor(rate * ir.seconds);
    const chans = [];
    for (let c = 0; c < ir.channels; c++) {
      const d = new Float32Array(n);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        const w = (rnd() * 2 - 1) * Math.pow(1 - i / n, ir.decayPow) * Math.exp(-t * ir.decayExp);
        lp += (w - lp) * ir.lp;
        let v = lp * (t < ir.fadeIn ? t / ir.fadeIn : 1);
        for (const r of ir.reflections) if (Math.abs(t - r) < 0.002) v += w * ir.reflectionGain;
        d[i] = v;
      }
      chans.push(d);
    }
    return chans;
  }

  /**
   * IR 归一化尺度（Web Audio spec 的简化版：按全声道能量 sqrt 归一）。
   * 真正的 spec 还乘一个与长度/采样率有关的因子；本仓取能量归一 ——
   * 目标是「混响不致削顶且各产物间比例一致」，而不是逐样本复刻 Chromium。
   */
  function irNormScale(chans) {
    let e = 0;
    let n = 0;
    for (const d of chans) { for (let i = 0; i < d.length; i++) e += d[i] * d[i]; n += d.length; }
    return e > 0 ? 1 / Math.sqrt(e / Math.max(1, chans.length)) * Math.sqrt(1 / rate) * 100 : 1;
  }

  /**
   * FFT 卷积（overlap-add，块长 4096）。
   * ⚠️ 直接卷积是 O(n·m)：12s × 2.6s @44100 ≈ 6e10 次乘法（分钟级）。
   * FFT 版 O(n log n)，实测整个烘焙 < 2s。
   * ⚠️ 只取前 n 个样本（与 ConvolverNode 的输出长度一致，尾部混响尾巴被产物长度截断
   * —— 上游也是这个语义：音效 buffer 长度固定）。
   */
  function convolve(x, h) {
    const n = x.length;
    const out = new Float32Array(n);
    const B = 4096;
    const M = B + h.length - 1;
    let N = 1; while (N < M) N <<= 1;
    const H = fftReal(padTo(h, N));
    for (let start = 0; start < n; start += B) {
      const len = Math.min(B, n - start);
      const blk = new Float32Array(N);
      for (let i = 0; i < len; i++) blk[i] = x[start + i];
      const X = fftReal(blk);
      // 复数乘
      const Yre = new Float32Array(N), Yim = new Float32Array(N);
      for (let k = 0; k < N; k++) {
        Yre[k] = X.re[k] * H.re[k] - X.im[k] * H.im[k];
        Yim[k] = X.re[k] * H.im[k] + X.im[k] * H.re[k];
      }
      const y = ifftReal(Yre, Yim, N);
      for (let i = 0; i < N && start + i < n; i++) out[start + i] += y[i];
    }
    return out;
  }
  function padTo(a, n) { const o = new Float32Array(n); o.set(a.subarray(0, Math.min(a.length, n))); return o; }

  /** 迭代 radix-2 FFT（实输入 → 复谱） */
  function fftReal(re0) {
    const N = re0.length;
    const re = Float32Array.from(re0);
    const im = new Float32Array(N);
    fftInPlace(re, im, false);
    return { re, im };
  }
  function ifftReal(re0, im0, N) {
    const re = Float32Array.from(re0);
    const im = Float32Array.from(im0);
    fftInPlace(re, im, true);
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) out[i] = re[i] / N;
    return out;
  }
  function fftInPlace(re, im, inverse) {
    const N = re.length;
    for (let i = 1, j = 0; i < N; i++) {
      let bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= N; len <<= 1) {
      const ang = (inverse ? 2 : -2) * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < N; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k], ui = im[i + k];
          const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
          const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }  /**
   * 渲染雨声床（四条循环 + LFO）。
   *
   * ⚠️⚠️ **不用 Web Audio 节点，纯 JS 算**（实测三轮重烘对比后的必要偏离）：
   * 长循环床（12s）经 'BufferSource(loop) + BiquadFilter + OscillatorNode(LFO)' 渲染时
   * **逐次运行输出不同字节**（即使去掉压缩器、去掉随机相位、每个产物独立 RNG 流）。
   * 短音效（≤0.62s）走节点路径稳定，长床不稳定 ⇒ 分块调度/内部状态相关。
   *
   * 滤波器用**标准 RBJ biquad  cookbook 系数 + Direct Form I**（与 Web Audio 的
   * BiquadFilterNode 同一套公式）；LFO 是正弦调制 gain（上游同口径）。
   * 噪声 buffer 仍用同一份 'makeBuffer'（配方参数不变）⇒ 声音内容与上游一致，
   * 只是求值路径换成完全确定的 JS。
   */
  function renderBeds(spec) {
    // 噪声 buffer 用普通数组版（不靠 AudioContext）。**只生成床用到的几种**
    // （同 renderLayers 的理由：未用到的 buffer 不得消耗 RNG）。
    const n = Math.ceil(rate * spec.dur);
    const raw = {};
    for (const k of new Set(spec.beds.map((b) => b.buf))) raw[k] = makeRawBuffer(buffers[k]);
    const outL = new Float32Array(n);
    const outR = new Float32Array(n);
    for (const b of spec.beds) {
      const src = raw[b.buf];
      const coef = biquad(b.type, b.f, b.q, rate);
      for (let ch = 0; ch < 2; ch++) {
        const d = src[Math.min(ch, src.length - 1)];
        const out = ch === 0 ? outL : outR;
        let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
        const sn = d.length;
        for (let i = 0; i < n; i++) {
          const x0 = d[i % sn];
          const y0 = coef.b0 * x0 + coef.b1 * x1 + coef.b2 * x2 - coef.a1 * y1 - coef.a2 * y2;
          x2 = x1; x1 = x0; y2 = y1; y1 = y0;
          const g = b.lfoHz ? b.gain + b.lfoDepth * Math.sin(2 * Math.PI * b.lfoHz * (i / rate)) : b.gain;
          out[i] += y0 * g;
        }
      }
    }
    // 尾部 40ms 线性淡出（循环接缝不咔嗒）+ 总线增益
    const fade = Math.floor(rate * 0.04);
    for (let i = 0; i < n; i++) {
      const k = i >= n - fade ? (n - i) / fade : 1;
      outL[i] *= gain * k; outR[i] *= gain * k;
    }
    const samples = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { samples[i * 2] = outL[i]; samples[i * 2 + 1] = outR[i]; }
    return { channels: 2, frames: n, samples: Array.from(samples) };
  }

  /** 噪声 buffer 的纯 JS 版（与 makeBuffer 同一套公式与同一个 RNG 流） */
  function makeRawBuffer(spec) {
    const n = Math.floor(rate * spec.seconds);
    const chans = [];
    for (let c = 0; c < spec.channels; c++) {
      const d = new Float32Array(n);
      if (spec.kind === 'white') {
        for (let i = 0; i < n; i++) d[i] = rnd() * 2 - 1;
      } else if (spec.kind === 'pink') {
        let b0 = 0, b1 = 0, b2 = 0;
        for (let i = 0; i < n; i++) {
          const w = rnd() * 2 - 1;
          b0 = 0.99765 * b0 + w * 0.099046;
          b1 = 0.963 * b1 + w * 0.2965164;
          b2 = 0.57 * b2 + w * 1.0526913;
          d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
        }
      } else if (spec.kind === 'brown') {
        let l = 0;
        for (let i = 0; i < n; i++) { l = (l + 0.02 * (rnd() * 2 - 1)) / 1.02; d[i] = l * 3.2; }
      } else if (spec.kind === 'patter') {
        for (let k = 0; k < spec.drops; k++) {
          const at = Math.floor(rnd() * (n - 2000));
          const f = 1400 + rnd() * 5200;
          const len = 90 + Math.floor(rnd() * 500);
          const g = Math.pow(rnd(), 2) * 0.55;
          for (let i = 0; i < len; i++) {
            d[at + i] += Math.sin((i / rate) * f * 6.283) * Math.exp(-i / (len * 0.22)) * g * (0.5 + rnd());
          }
        }
      }
      chans.push(d);
    }
    return chans;
  }

  /** RBJ biquad cookbook 系数（归一化 a0），与 Web Audio BiquadFilterNode 同公式 */
  function biquad(type, f0, Q, sr) {
    const w0 = 2 * Math.PI * f0 / sr;
    const cw = Math.cos(w0), sw = Math.sin(w0);
    const alpha = sw / (2 * Q);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'lowpass') {
      b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
    } else if (type === 'highpass') {
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
    } else { // bandpass（constant 0dB peak gain，Web Audio 同口径）
      b0 = alpha; b1 = 0; b2 = -alpha;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
    }
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  }

  /** AudioBuffer → 交错 Float32（回传给 Node 写 wav） */
  function interleave(buf) {
    const ch = buf.numberOfChannels, n = buf.length;
    const out = new Float32Array(n * ch);
    const data = [];
    for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) out[i * ch + c] = data[c][i];
    return { channels: ch, frames: n, samples: Array.from(out) };
  }

  const out = {};
  /**
   * 每个产物用独立的 RNG 流（种子 = 全局种子 XOR id 的 FNV 哈希）。
   *
   * 实测踩到：共用一条流时 rain_storm 的噪声取决于它前面所有配方消耗了多少
   * 随机数 ⇒ 新增/改动任何一个枪声配方都会让雨声产物变字节（指纹报过期，
   * 而雨的声音根本没改）。分流后每个产物只依赖它自己的参数。
   */
  function seedFor(id) {
    let h = 0x811c9dc5;
    for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return (seed ^ h) >>> 0;
  }
  function resetRnd(id) {
    a = seedFor(id);
  }
  for (const [id, spec] of Object.entries(recipes)) { resetRnd(id); out[id] = renderLayers(spec, spec.dur); }
  resetRnd(thunder.id); out[thunder.id] = renderLayers(thunder, thunder.dur);
  resetRnd(rainBed.id); out[rainBed.id] = renderBeds(rainBed);
  return out;
}
