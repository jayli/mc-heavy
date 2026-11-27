// tools/normal-sky-noise.mjs — 「普通」天空烘焙所需的三个噪声输入（Node 侧生成，three-free）
//
// 上游 ASHLAR 的体积云依赖三份噪声，本模块把它们在 Node 里逐字复现：
//
// | 上游 uniform    | 规格      | 来源                                   | 用途 |
// |-----------------|-----------|----------------------------------------|------|
// | `uNoiseTex`     | 256² RGBA | `shared/texgen.js` `generateWaterTextures().noise` | `cloudWeather()` 只用 **.b 通道** |
// | `uCloudNoise`   | 96³ RGBA  | `22_sky.js` `bakeCloudNoise()` 的 `uDetail=0` 分支 | 云的形状骨架 |
// | `uCloudDetail`  | 40³ RGBA  | 同上 `uDetail=1` 分支                  | 侵蚀细节 |
//
// ## 为什么 .b 通道是云量图
//
// `cloudWeather()` 读 `textureLod(uNoiseTex, q).b`，而 `generateWaterTextures` 把
// `.b` 写成 `pfbm(u, v, 4, 4, 6, 51) * 0.95 + 0.5` —— 一张低频大尺度 fbm。
// ⇒ 决定「哪里有云、哪里没有」的是这张低频图，不是两个 3D 体。
//
// ## 采样口径必须与 GPU 一致
//
// 上游三个纹理都是 `LinearFilter` + `RepeatWrapping` ⇒ 本模块一律**三线性 + 环绕**。
// 用最近邻会得到块状云，用 clamp 会得到边缘硬接缝。
// UV 映射用 `u * S - 0.5`（与 GPU `texture()` 的纹素中心约定一致）。
//
// ## 确定性
//
// 全部来自 `ihash` 与整数频率（`pnoise`/`pfbm`/`pworley` 都是周期函数），
// 无 `Math.random` ⇒ 同参数必定产出逐位相同的噪声，指纹才靠得住。

// ------------------------------------------------------------------ 哈希与插值（上游 noise.js 逐字）

/** 上游 `shared/noise.js` `ihash` 逐字。 */
export function ihash(x, y = 0, z = 0, s = 0) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)
        ^ Math.imul(z | 0, 0x9e3779b1) ^ Math.imul(s | 0, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

// ------------------------------------------------------------------ 2D 周期噪声（上游 texgen.js 逐字）

const TX_GR = (() => {
  const g = [];
  for (let i = 0; i < 16; i++) g.push([Math.cos(i * Math.PI / 8 + 0.13), Math.sin(i * Math.PI / 8 + 0.13)]);
  return g;
})();

/** 上游 `texgen.js` `pnoise` 逐字（周期梯度噪声）。 */
function pnoise(x, y, px, py, s) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const x0 = ((ix % px) + px) % px, x1 = (x0 + 1) % px, y0 = ((iy % py) + py) % py, y1 = (y0 + 1) % py;
  const g = (gx, gy, dx, dy) => { const v = TX_GR[ihash(gx, gy, s) & 15]; return v[0] * dx + v[1] * dy; };
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10), v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = g(x0, y0, fx, fy), b = g(x1, y0, fx - 1, fy), c = g(x0, y1, fx, fy - 1), d = g(x1, y1, fx - 1, fy - 1);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 1.5;
}

/** 上游 `texgen.js` `pfbm` 逐字（整数基频的 fbm，天然可平铺）。 */
function pfbm(u, v, fx, fy, oct, s, gain = 0.5) {
  let sum = 0, amp = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * pnoise(u * fx, v * fy, fx, fy, s + i * 101);
    norm += amp; amp *= gain; fx *= 2; fy *= 2;
  }
  return sum / norm;
}

// ------------------------------------------------------------------ 2D 噪声图集（weather 图）

/**
 * `generateWaterTextures(size).noise` 的逐字复现。
 *
 * 只算云要用的通道，但**四个通道全算**——这样万一将来要搬水体也能直接用，
 * 且与上游逐位可比（本地校验时能整张对照）。
 *
 * - R：cellular foam（两层 worley 边缘）
 * - G：caustic web（两层 worley 脊）
 * - **B：soft fbm —— `cloudWeather()` 读的就是它**
 * - A：finer fbm
 *
 * 注意 `clamp(...) * 255` 的取整口径：上游写进 Uint8Array 是隐式截断，
 * 这里显式 `| 0` 保持同值（否则 `Math.round` 会偏半个量化级）。
 */
export function bakeWeatherNoise(size) {
  const S = size;
  const out = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S, i = (y * S + x) * 4;
      // ⚠️ 上游对 u,v 做了 warp（`wu`/`wv`），但 B/A 通道用的是**未 warp 的** u,v。
      // 逐字照抄：R/G 用 warp 后的，B/A 用原始 u,v。
      const wu = u + pfbm(u, v, 4, 4, 3, 5) * 0.06, wv = v + pfbm(u, v, 4, 4, 3, 6) * 0.06;
      const f = pworley2(wu, wv, 18, 18, 21, 1);
      const f3 = pworley2(u + pfbm(u, v, 9, 9, 3, 31) * 0.04, v, 40, 40, 23, 1);
      out[i] = clamp((1 - sstep(0.04, 0.3, f.f2 - f.f1)) * 0.75
                   + (1 - sstep(0.04, 0.34, f3.f2 - f3.f1)) * 0.45, 0, 1) * 255 | 0;
      const c1 = pworley2(wu, wv, 7, 7, 41, 1);
      const c2 = pworley2(wv, wu, 11, 11, 43, 1);
      out[i + 1] = clamp(Math.pow(1 - sstep(0.0, 0.38, c1.f2 - c1.f1), 2.4) * 0.8
                       + Math.pow(1 - sstep(0.0, 0.34, c2.f2 - c2.f1), 2.6) * 0.45, 0, 1) * 255 | 0;
      out[i + 2] = clamp(pfbm(u, v, 4, 4, 6, 51) * 0.95 + 0.5, 0, 1) * 255 | 0;
      out[i + 3] = clamp(pfbm(u, v, 16, 16, 5, 61) * 0.95 + 0.5, 0, 1) * 255 | 0;
    }
  }
  return out;
}

const smooth01 = (t) => t * t * (3 - 2 * t);
function sstep(a, b, v) { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }

/** 上游 `texgen.js` `pworley` 逐字（返回 {f1,f2}；云只需要距离）。 */
function pworley2(u, v, fx, fy, s, jit = 0.85) {
  const x = u * fx, y = v * fy, ix = Math.floor(x), iy = Math.floor(y);
  let f1 = 9, f2 = 9;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = ix + i, cy = iy + j;
      const wx = ((cx % fx) + fx) % fx, wy = ((cy % fy) + fy) % fy;
      const h = ihash(wx, wy, s);
      const px = cx + 0.5 + (((h & 1023) / 1023) - 0.5) * jit;
      const py = cy + 0.5 + ((((h >>> 10) & 1023) / 1023) - 0.5) * jit;
      const dx = px - x, dy = py - y, d = dx * dx + dy * dy;
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
  }
  return { f1: Math.sqrt(f1), f2: Math.sqrt(f2) };
}

// ------------------------------------------------------------------ 3D 噪声体（上游 bakeCloudNoise 逐字）

/** 上游 `bakeCloudNoise` 的 GLSL 辅助函数逐字（uint 运算用 >>>0 保持无符号）。 */
function h33(px, py, pz) {
  const qx = Math.imul(px | 0, 1597334673) >>> 0;
  const qy = Math.imul(py | 0, 3812015801) >>> 0;
  const qz = Math.imul(pz | 0, 2798796415) >>> 0;
  let n = (qx ^ qy ^ qz) >>> 0;
  const r0 = Math.imul(n, 1597334673) >>> 0;
  const r1 = Math.imul(n, 3812015801) >>> 0;
  const r2 = Math.imul(n, 2798796415) >>> 0;
  const k = 1 / 4294967295;
  return [r0 * k, r1 * k, r2 * k];
}

const modp = (a, p) => ((a % p) + p) % p;

/** 上游 `bakeCloudNoise` 的 `worley`（3×3×3 邻域）。 */
function worley3(px, py, pz, f) {
  const x = px * f, y = py * f, z = pz * f;
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const frx = x - ix, fry = y - iy, frz = z - iz;
  let d = 1;
  for (let cz = -1; cz <= 1; cz++) {
    for (let cy = -1; cy <= 1; cy++) {
      for (let cx = -1; cx <= 1; cx++) {
        const h = h33(modp(ix + cx, f) + 7, modp(iy + cy, f) + 7, modp(iz + cz, f) + 7);
        const rx = cx + h[0] - frx, ry = cy + h[1] - fry, rz = cz + h[2] - frz;
        const dd = rx * rx + ry * ry + rz * rz;
        if (dd < d) d = dd;
      }
    }
  }
  return 1 - Math.sqrt(d);
}

/** 上游 `bakeCloudNoise` 的 `grad`（周期梯度）。 */
function grad3(cx, cy, cz, fx, fy, fz, per) {
  const g = h33(modp(cx, per) + 31, modp(cy, per) + 31, modp(cz, per) + 31);
  let gx = g[0] * 2 - 1, gy = g[1] * 2 - 1, gz = g[2] * 2 - 1;
  const l = Math.hypot(gx, gy, gz) || 1;
  gx /= l; gy /= l; gz /= l;
  return gx * fx + gy * fy + gz * fz;
}

/** 上游 `bakeCloudNoise` 的 `perlin`（三次平滑的 3D 周期梯度噪声）。 */
function perlin3(px, py, pz, f) {
  const x = px * f, y = py * f, z = pz * f;
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const a = grad3(ix, iy, iz, fx, fy, fz, f);
  const b = grad3(ix + 1, iy, iz, fx - 1, fy, fz, f);
  const c = grad3(ix, iy + 1, iz, fx, fy - 1, fz, f);
  const d = grad3(ix + 1, iy + 1, iz, fx - 1, fy - 1, fz, f);
  const e = grad3(ix, iy, iz + 1, fx, fy, fz - 1, f);
  const g = grad3(ix + 1, iy, iz + 1, fx - 1, fy, fz - 1, f);
  const h = grad3(ix, iy + 1, iz + 1, fx, fy - 1, fz - 1, f);
  const k = grad3(ix + 1, iy + 1, iz + 1, fx - 1, fy - 1, fz - 1, f);
  return lerp(
    lerp(lerp(a, b, ux), lerp(c, d, ux), uy),
    lerp(lerp(e, g, ux), lerp(h, k, ux), uy),
    uz,
  );
}

/**
 * `bakeCloudNoise()` 的逐字复现。
 *
 * @param {number} res 体素边长（上游 96 / 40）
 * @param {boolean} detail `false` = uCloudNoise（形状骨架），`true` = uCloudDetail（侵蚀细节）
 * @returns {Uint8Array} res³×4 RGBA
 *
 * ⚠️ 上游按 z 切片逐张渲染，`p.z = (slice+0.5)/uRes` —— 三个轴都是 0..1 归一化空间。
 * 本函数把三层循环直接写成体素遍历，与之一致。
 */
export function bakeCloudNoise(res, detail) {
  const out = new Uint8Array(res * res * res * 4);
  for (let z = 0; z < res; z++) {
    const pz = (z + 0.5) / res;
    for (let y = 0; y < res; y++) {
      const py = (y + 0.5) / res;
      for (let x = 0; x < res; x++) {
        const px = (x + 0.5) / res;
        const o = ((z * res + y) * res + x) * 4;
        if (detail) {
          const w1 = worley3(px, py, pz, 4), w2 = worley3(px, py, pz, 8), w3 = worley3(px, py, pz, 16);
          out[o] = (w1 * 0.65 + w2 * 0.35) * 255 | 0;
          out[o + 1] = (w2 * 0.65 + w3 * 0.35) * 255 | 0;
          out[o + 2] = w3 * 255 | 0;
          out[o + 3] = 255;
        } else {
          let pf = 0, a = 1, nm = 0, f = 4;
          for (let i = 0; i < 4; i++) { pf += a * perlin3(px, py, pz, f); nm += a; a *= 0.55; f *= 2; }
          pf = clamp(pf / nm * 1.15 + 0.5, 0, 1);
          const w1 = worley3(px, py, pz, 4), w2 = worley3(px, py, pz, 8);
          const w3 = worley3(px, py, pz, 14), w4 = worley3(px, py, pz, 24);
          const wf = w1 * 0.625 + w2 * 0.25 + w3 * 0.125;
          const pw = clamp(wf + (pf - 0) * (1 - wf), 0, 1);
          out[o] = pw * 255 | 0;
          out[o + 1] = (w1 * 0.625 + w2 * 0.25 + w3 * 0.125) * 255 | 0;
          out[o + 2] = (w2 * 0.625 + w3 * 0.25 + w4 * 0.125) * 255 | 0;
          out[o + 3] = (w3 * 0.75 + w4 * 0.25) * 255 | 0;
        }
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ 采样器（与 GPU 同口径）

/**
 * 2D 采样器：双线性 + RepeatWrapping，取指定通道，返回 0..1。
 *
 * UV 用 `u * S - 0.5`：GPU `texture()` 把 uv=[0,1] 映射到整张图，纹素中心在
 * `(i+0.5)/S` ⇒ 反解得 `px = u*S - 0.5`。uv 在整数格上时落在两个纹素正中（权重各半）。
 */
export function makeSampler2D(data, size, channel) {
  const S = size;
  const at = (x, y, c) => data[((modp(y, S) * S) + modp(x, S)) * 4 + c];
  return (u, v) => {
    const fx = u * S - 0.5, fy = v * S - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const a = at(x0, y0, channel), b = at(x0 + 1, y0, channel);
    const c = at(x0, y0 + 1, channel), d = at(x0 + 1, y0 + 1, channel);
    const top = a + (b - a) * tx, bot = c + (d - c) * tx;
    return (top + (bot - top) * ty) / 255;
  };
}

/**
 * 3D 采样器：三线性 + RepeatWrapping，返回 [r,g,b,a] 各在 0..1。
 *
 * ⚠️ 上游 warp 用的是 `RepeatWrapping`（每轴独立环绕）⇒ 这里每轴 `modp`。
 */
export function makeSampler3D(data, res) {
  const S = res, S2 = res * res;
  const at = (x, y, z, c) => data[((modp(z, S) * S2) + (modp(y, S) * S) + modp(x, S)) * 4 + c];
  return (u, v, w) => {
    const fx = u * S - 0.5, fy = v * S - 0.5, fz = w * S - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
    const tx = fx - x0, ty = fy - y0, tz = fz - z0;
    const out = [0, 0, 0, 0];
    for (let c = 0; c < 4; c++) {
      const c000 = at(x0, y0, z0, c), c100 = at(x0 + 1, y0, z0, c);
      const c010 = at(x0, y0 + 1, z0, c), c110 = at(x0 + 1, y0 + 1, z0, c);
      const c001 = at(x0, y0, z0 + 1, c), c101 = at(x0 + 1, y0, z0 + 1, c);
      const c011 = at(x0, y0 + 1, z0 + 1, c), c111 = at(x0 + 1, y0 + 1, z0 + 1, c);
      const x00 = c000 + (c100 - c000) * tx, x01 = c010 + (c110 - c010) * tx;
      const x10 = c001 + (c101 - c001) * tx, x11 = c011 + (c111 - c011) * tx;
      const y0v = x00 + (x01 - x00) * ty, y1v = x10 + (x11 - x10) * ty;
      out[c] = (y0v + (y1v - y0v) * tz) / 255;
    }
    return out;
  };
}