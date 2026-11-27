// tools/normal-sky-clouds.mjs — 把上游 ASHLAR 的体积云求值成「烘焙期可用的颜色」（three-free）
//
// ## 用途
//
// `bake-normal-sky.mjs` 在烘焙每个立方图像素时调用 `shadeSkyWithClouds()`：
// 沿该像素的方向 march 一次云层，得到被云挡掉的透射率 `T` 与云自身的发光 `S`，
// 与既有的大气辐射合成后写进静态 JPEG。
//
// **运行时零改动** —— 云是烘焙期的实现细节，交付物只是六张图。
//
// ## 与上游的关系（逐字 vs 降级）
//
// 云密度、weather、相位、powder、自阴影全部按上游 `22_sky.js` 逐字移植。降级项：
//
// | 上游 | 这里 | 理由 |
// |---|---|---|
// | `uHistoryWeight` 时间累积 | 不用 | 静态图要收敛结果 |
// | 每帧抖动 `ign(gl_FragCoord, uFrame)` | 固定分层 jitter（`jit = (i+0.5)/N`） | 无帧概念；分层仍能打散条带 |
// | `sceneDist` 地形遮挡 | 不处理 | 天空盒里没有地形 |
// | `uStorm` / `uFlash` | 恒 0 | 本档晴天 |
// | `uMaxDist` 截断 + `fade` | 保留 | 地平线处云自然淡出 |
// | `uSkyView` 查大气 LUT | 回调注入 `skyRadiance` | 与本仓既有大气烘焙同源，不引第二份 |
//
// ⚠️ **相位函数不能省**：`hg(cosT, 0.78)` 的正向散射是用户截图里「云边亮边」的来源；
// `powder` 项是「云顶亮、云底灰」的来源。二者都是观感判据里的关键特征。
//
// ⚠️ **自阴影是必需的**：去掉 5 步 light-march 后云会变成平掉的白色块，
// 这也是为什么纯 2D 噪声画云达不到要求（见设计文档 §4 路线 B）。

import { makeSampler2D, makeSampler3D } from './normal-sky-noise.mjs';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
// ⚠️ `mix` 必须在 `cloudDensity` 之前声明：后者引用了它，而 `const` 有暂时性死区
// （声明前的调用会抛 `ReferenceError`，不是静默失败 —— 但会直接卡住烘焙）。
const mix = lerp;
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** 上游 `rmp()` 逐字：把 v 从 [a,b] 线性映射到 [c,d]。 */
const rmp = (v, a, b, c, d) => c + (v - a) * (d - c) / (b - a);

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

// ------------------------------------------------------------------ 云层常量（上游逐字）

/** 云层下界/上界（米）。上游 `const float CB = 336.0, CTOP = 585.0;` */
export const CLOUD_BASE = 336.0;
export const CLOUD_TOP = 585.0;

/** 消光系数（上游 `const float SIG = 0.085;`） */
const SIG = 0.085;

/**
 * 构造一个云求值器。
 *
 * @param {Object} opts
 * @param {Uint8Array} opts.weatherNoise 2D 噪声图集（`bakeWeatherNoise`），用 .b 通道
 * @param {number} opts.weatherSize 2D 图尺寸（256）
 * @param {Uint8Array} opts.cloudNoise 3D 骨架（`bakeCloudNoise(96,false)`）
 * @param {number} opts.cloudNoiseRes 96
 * @param {Uint8Array} opts.cloudDetail 3D 细节（`bakeCloudNoise(40,true)`）
 * @param {number} opts.cloudDetailRes 40
 * @param {Object} opts.params 云参数（见 normal-sky-fingerprint.mjs）
 * @param {Function} opts.skyRadiance `(dir) => [r,g,b]` 大气辐射（线性），用于云的空气透视与 ambTop/Bot
 * @returns {{ shadeSkyWithClouds: Function, stats: Object }}
 */
export function makeCloudShader(opts) {
  const {
    weatherNoise, weatherSize, cloudNoise, cloudNoiseRes,
    cloudDetail, cloudDetailRes, params, skyRadiance,
  } = opts;

  // 上游 `textureLod(uNoiseTex, q, 0.0).b` —— weather 只用 .b
  const sampleWeatherB = makeSampler2D(weatherNoise, weatherSize, 2);
  const sampleCloud = makeSampler3D(cloudNoise, cloudNoiseRes);
  const sampleDetail = makeSampler3D(cloudDetail, cloudDetailRes);

  const cover = params.cloudCover;
  const cloudDensityScale = params.cloudDensity;
  const maxDist = params.cloudMaxDist;
  const camY = params.cloudCamY;
  /**
   * 直射/环境项的全局增益（见 fingerprint 里 `cloudGain` 的说明）。
   * 上游拿 1.0（它的 HDR 管线容得下 187），天空盒的 8bit 容不下。
   */
  const cloudGain = params.cloudGain ?? 1.0;

  // ------------------------------------------------------------------ 环境光（上游 computeSH 的抽样口径）

  /**
   * 云的环境光。上游在 `computeSH()` 里用 40 个上半球方向算 SH，
   * 再在片元里 `shIrradiance(+Y)` / `(-Y)` 取上下两个辐照度。
   *
   * 这里直接按同一 40 方向抽样、只取**上半球辐照度**（按 y 加权积分），
   * 因为本档只有太阳一个光源、且静态 ⇒ 不需要完整 9 系数 SH。
   * ⚠️ 这不是「简化到能看就行」：`ambTop`/`ambBot` 决定云底的颜色与亮度，
   * 上游 `ambBot = shIrradiance(-Y) * 0.8 + ambTop * 0.32` 里 -Y 的贡献主要来自
   * 地面反照（`ground` 项）。静态烘焙没有地面 ⇒ 用 `params.groundAlbedo` 显式给。
   */
  const ambient = (() => {
    const N = 40, dW = (4 * Math.PI) / N;
    const sum = [0, 0, 0];
    for (let i = 0; i < N; i++) {
      const y = 1 - 2 * (i + 0.5) / N;
      if (y <= 0) continue;
      const r = Math.sqrt(1 - y * y), ph = i * 2.39996323;
      const d = [Math.cos(ph) * r, y, Math.sin(ph) * r];
      const L = skyRadiance(d);
      for (let c = 0; c < 3; c++) sum[c] += L[c] * y * dW;
    }
    const ambTop = sum.map((v) => v * 1.15);
    const gAlb = params.groundAlbedo;
    // 地面辐照 ≈ 反照率 × (天空辐照) / π（上游 `ground` 项的同一形式）
    const sunDir = params.sunDir;
    const keyLight = skyRadiance(norm3([sunDir[0], Math.max(sunDir[1], 0.02), sunDir[2]]));
    const ambBot = [0, 1, 2].map((c) =>
      (gAlb[c] * (keyLight[c] * 0.75 * Math.max(sunDir[1], 0) + sum[c])) / Math.PI * 0.8
      + ambTop[c] * 0.32);
    return { ambTop, ambBot };
  })();

  // ------------------------------------------------------------------ 云密度（上游 cloudWeather + cloudDensity 逐字）

  /** 上游 `cloudWeather()` 逐字。`uCloudOffset` = 0（静态天空取原点）。 */
  function cloudWeather(x, z) {
    const qx = x / 4300.0, qz = z / 4300.0;
    const n = sampleWeatherB(qx, qz) * 0.7
            + sampleWeatherB(qx * 2.31 + 0.37, qz * 2.31 + 0.37) * 0.3;
    const n2 = (n - 0.5) * 1.9 + 0.5;
    return clamp(smoothstep(1.0 - cover - 0.2, 1.0 - cover + 0.26, n2), 0, 1);
  }

  /**
   * 上游 `cloudDensity(p, detail)` 逐字。
   * `uStorm = 0` ⇒ storm 分支整段不搬（本档晴天，搬进来只是未测代码）。
   */
  function cloudDensity(px, py, pz, detail) {
    const h = (py - CLOUD_BASE) / (CLOUD_TOP - CLOUD_BASE);
    if (h <= 0.0 || h >= 1.0) return 0.0;
    const cov = cloudWeather(px, pz);
    if (cov <= 0.001) return 0.0;
    // `textureLod(uCloudDetail, q/410, 0)` 对采样坐标做偏移
    const det = sampleDetail(px / 410.0, py / 410.0, pz / 410.0);
    const wob = [(det[0] - 0.5) * 46.0, (det[1] - 0.5) * 46.0, (det[2] - 0.5) * 46.0];
    const b = sampleCloud(
      (px + wob[0]) / 690.0,
      (py + wob[1]) / 690.0,
      (pz + wob[2]) / 690.0,
    );
    const fbm = b[1] * 0.625 + b[2] * 0.25 + b[3] * 0.125;
    let base = clamp(rmp(b[0], fbm - 1.0, 1.0, 0.0, 1.0), 0, 1);
    // uStorm = 0 ⇒ topFall = mix(0.42, 0.9, cov)
    const topFall = mix(0.42, 0.9, cov);
    const grad = smoothstep(0.0, 0.085, h) * (1.0 - smoothstep(topFall * 0.45, topFall, h));
    base *= grad;
    let d = clamp(rmp(base, 1.0 - cov * 0.82, 1.0, 0.0, 1.0), 0, 1) * mix(0.55, 1.0, cov);
    if (detail && d > 0.0) {
      const dn = sampleDetail((px) / 128.0, (py) / 128.0, (pz) / 128.0);
      const hf = dn[0] * 0.625 + dn[1] * 0.25 + dn[2] * 0.125;
      let md = mix(hf, 1.0 - hf, clamp(h * 5.0, 0, 1));
      const dn2 = sampleDetail(px / 47.0, py / 47.0, pz / 47.0);
      md = mix(md, dn2[0] * 0.7 + dn2[1] * 0.3, 0.28);
      d = clamp(rmp(d, md * 0.5, 1.0, 0.0, 1.0), 0, 1);
    }
    return d * cloudDensityScale;
  }

  /** 上游 `hg()` 逐字。 */
  function hg(c, g) {
    const g2 = g * g;
    return (1.0 - g2) / (12.566 * Math.pow(1.0 + g2 - 2.0 * g * c, 1.5));
  }

  // ------------------------------------------------------------------ march（上游 G_CLOUD_FRAG 的循环体）

  const sunDir = params.sunDir;
  const sunColor = params.sunColor;   // uLightColor（透射率 × 辐照 × sunFade）
  const steps = params.cloudSteps;

  /**
   * 沿 `rd` march 云层。
   *
   * @param {number[]} rd 单位方向
   * @returns {{ T: number, S: number[] }} 透射率与被云散射的颜色（均为线性）
   */
  function marchClouds(rd) {
    const res = { T: 1, S: [0, 0, 0] };
    // 上游：相机在云层下方（本档玩家始终在地面）
    if (rd[1] <= 0.004) return res;
    let t0 = (CLOUD_BASE - camY) / rd[1];
    let t1 = (CLOUD_TOP - camY) / rd[1];
    t1 = Math.min(t1, maxDist);
    if (t0 >= t1) return res;
    const len = Math.min(t1 - t0, 2600.0);
    const N = Math.floor(steps * clamp(len / 700.0, 0.45, 1.0));
    if (N <= 0) return res;
    const ds = len / N;

    const cosT = dot3(rd, sunDir);
    const ambTop = ambient.ambTop, ambBot = ambient.ambBot;
    let S = [0, 0, 0], T = 1.0;

    for (let i = 0; i < N; i++) {
      if (T < 0.012) break;
      // 固定分层 jitter（上游每像素抖动；静态图用分层，打散条带且确定）
      const jit = (i + 0.5) / N;
      const t = t0 + ds * i + ds * jit;
      const px = rd[0] * t, py = camY + rd[1] * t, pz = rd[2] * t;
      const d = cloudDensity(px, py, pz, true);
      if (d > 0.002) {
        // 5 步 light-march（上游逐字）
        let od = 0.0, st = 11.0;
        for (let j = 0; j < 5; j++) {
          const lt = st * (0.55 + jit * 0.25);
          od += cloudDensity(
            px + sunDir[0] * lt, py + sunDir[1] * lt, pz + sunDir[2] * lt,
            j < 2,
          ) * st * 0.62;
          st *= 1.9;
        }
        // 三 lobe Henyey-Greenstein
        let sun = [0, 0, 0], a = 1.0, b = 1.0, c = 1.0;
        for (let k = 0; k < 3; k++) {
          const ph = lerp(hg(cosT, 0.78 * c), hg(cosT, -0.18 * c), 0.32) + 0.018;
          const ext = Math.exp(-od * SIG * b);
          for (let ch = 0; ch < 3; ch++) sun[ch] += a * ph * ext;
          a *= 0.52; b *= 0.34; c *= 0.55;
        }
        const h = clamp((py - CLOUD_BASE) / (CLOUD_TOP - CLOUD_BASE), 0, 1);
        const powder = 1.0 - 0.72 * Math.exp(-d * 7.0) * (1.0 - clamp(cosT * 0.5 + 0.5, 0, 1));
        const damp = 0.55 + 0.45 * Math.exp(-od * SIG * 0.22);
        const src = [0, 1, 2].map((ch) =>
          (sunColor[ch] * sun[ch] * 7.2 * powder
            * (1.0 - 0.62 * smoothstep(0.02, -0.12, sunDir[1]))
            + lerp(ambBot[ch], ambTop[ch], smoothstep(0.0, 0.85, h)) * damp * 0.92) * cloudGain);
        const ext = d * SIG;
        const stepT = Math.exp(-ext * ds);
        for (let ch = 0; ch < 3; ch++) S[ch] += T * src[ch] * (1.0 - stepT);
        T *= stepT;
      }
    }

    const alpha = 1.0 - T;
    if (alpha > 0.001) {
      // 云自身的空气透视：与同方向天空色混合（上游逐字；uMaxDist 淡出保留）
      const dist = t0 + ds * N * 0.5;   // 上游用加权距离；静态近似取中位
      const hz = skyRadiance(norm3([rd[0], Math.max(rd[1], 0.035), rd[2]]));
      const fog = 1.0 - Math.exp(-Math.max(dist - 250.0, 0.0) / 2700.0);
      for (let ch = 0; ch < 3; ch++) S[ch] = lerp(S[ch], hz[ch] * alpha, fog * 0.92);
      const fade = 1.0 - smoothstep(maxDist * 0.62, maxDist, dist);
      for (let ch = 0; ch < 3; ch++) S[ch] *= fade;
      T = 1.0 - alpha * fade;
    }

    return { T, S };
  }

  /** 供 `buildFace` 调用：返回「被云修饰后的天空色」（线性）。 */
  function shadeSkyWithClouds(dir, skyRGB) {
    if (dir[1] <= 0.004) return skyRGB;
    const { T, S } = marchClouds(dir);
    return [0, 1, 2].map((c) => skyRGB[c] * T + S[c]);
  }

  return {
    shadeSkyWithClouds,
    /** 暴露给自检/调试：不渲染也能查云密度与相位 */
    _cloudDensity: cloudDensity,
    _cloudWeather: cloudWeather,
    _ambient: ambient,
  };
}