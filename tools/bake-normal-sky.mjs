// tools/bake-normal-sky.mjs — 烘焙「普通」风格的天空立方图（确定性，无随机）
//
// 产物：assets/sky/normal/{posx,negx,posy,negy,posz,negz}.jpg + normal-sky.json（指纹）
// 输入：**上游 ASHLAR 的大气散射公式**（纯数值，见下方来源）+ tools/normal-sky-fingerprint.mjs 的参数
//
// ## 烘焙 = 数据格式转换，不产生新美术资源
//
// 上游 `source/src/main/22_sky.js` 的天空是 Hillaire 式程序化大气：
// 透射率 LUT 256×64 + 多重散射 LUT 32×32 + 天空视图 LUT，全部 GLSL 全屏 pass。
// **没有任何贴图文件可搬**。本脚本把那三个 pass 在 Node 里精确复现，
// 按立方图方向求值后写成与既有四套同规格的六张 JPEG。
//
// ## 为什么不能直接用上游的 CPU 镜像
//
// 上游 `Sky.radiance()` 是给**环境光**用的低精度近似（10 步、msTerm=0.045·clamp(...)、g=0.76），
// GPU 版走真多重散射 LUT（32 步、g=0.8）。实测两者比 0.92~1.16 —— 差异有限但存在。
// 本脚本用 **GPU 版公式**（三个 pass 逐字），不用那个近似。
//
// ## 无缝是怎么保证的
//
// 与 `bake-night-sky.mjs` 不同：那边是「六张源图重采样」，需要跨面加权混合；
// 这边**每个像素直接由方向求值**（`skyRadiance(dir)` 是方向的连续函数）
// ⇒ 同一条射线在相邻面算出的是同一个值 ⇒ 接缝**数学上为零**，不需要羽化。
// ⚠️ 但 uv 必须用 `x/(SIZE-1)`（面的完整边缘）而不是硬件采样的 `(x+0.5)/SIZE`，
// 否则边界两侧各偏半像素 → 方向不同 → 出现接缝（同 bake-night-sky 的教训）。
//
// 用法：node tools/bake-normal-sky.mjs
// 输出 JSON 里的指纹供 `npm run check:data` 的 [普通天空] 环节比对。
//
// ⚠️ 本脚本**只写** assets/sky/normal/ 下的 7 个文件，不删除任何东西。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { chromium } from 'playwright';
import {
  NORMAL_SKY_FACES, NORMAL_SKY_SIZE, NORMAL_SKY_PARAMS, normalSkyFingerprint,
  NORMAL_SKY_FINGERPRINT_JSON,
} from './normal-sky-fingerprint.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'assets', 'sky', 'normal');
const OUT_JSON = path.join(__dirname, '..', NORMAL_SKY_FINGERPRINT_JSON);
const SIZE = NORMAL_SKY_SIZE;
const P = NORMAL_SKY_PARAMS;

// ------------------------------------------------------------------ 大气常量（上游 G_ATMOS 逐字）

const RG = 6360.0, RT = 6460.0;                       // 地面/大气顶半径（km）
const RAY_S = [5.802e-3, 13.558e-3, 33.1e-3];         // Rayleigh 散射系数
const MIE_S = 3.996e-3, MIE_A = 4.4e-3;               // Mie 散射/吸收
const OZO_A = [0.650e-3, 1.881e-3, 0.085e-3];         // 臭氧吸收

/** 密度剖面（上游 atmDensity 逐字）。 */
function atmDensity(h) {
  const dr = Math.exp(-Math.max(h, 0) / 8.0);
  const dm = Math.exp(-Math.max(h, 0) / 1.2);
  const dz = Math.max(0.0, 1.0 - Math.abs(h - 25.0) / 15.0);
  const rayS = RAY_S.map((v) => v * dr);
  const mieS = MIE_S * dm;
  const ext = rayS.map((v, c) => v + (MIE_S + MIE_A) * dm + OZO_A[c] * dz);
  return { rayS, mieS, ext };
}

/** 射线-球最近正交点（上游 raySphere 逐字）；无交点返回 -1。 */
function raySphere(o, d, r) {
  const b = o[0] * d[0] + o[1] * d[1] + o[2] * d[2];
  const c = o[0] * o[0] + o[1] * o[1] + o[2] * o[2] - r * r;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  if (-b - s > 0) return -b - s;
  return -b + s > 0 ? -b + s : -1;
}

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
const norm3 = (v) => { const l = len3(v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

/** 透射率 LUT 的 uv 参数化（上游 transUV 逐字）。 */
function transUV(r, mu) {
  const H = Math.sqrt(RT * RT - RG * RG);
  const rho = Math.sqrt(Math.max(r * r - RG * RG, 0));
  const d = -r * mu + Math.sqrt(Math.max(r * r * (mu * mu - 1) + RT * RT, 0));
  const dmin = RT - r, dmax = rho + H;
  return [(d - dmin) / (dmax - dmin), rho / H];
}

const phaseRay = (c) => 3 / (16 * Math.PI) * (1 + c * c);
const phaseMie = (c) => {
  const g = 0.8, g2 = g * g;
  return 3 / (8 * Math.PI) * ((1 - g2) * (1 + c * c))
    / ((2 + g2) * Math.pow(1 + g2 - 2 * g * c, 1.5));
};

// ------------------------------------------------------------------ pass 1：透射率 LUT

function bakeTransmittance() {
  const W = P.transW, H = P.transH;
  const lut = new Float32Array(W * H * 3);
  const Hmax = Math.sqrt(RT * RT - RG * RG);
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    const rho = Hmax * v, r = Math.sqrt(rho * rho + RG * RG);
    const dmin = RT - r, dmax = rho + Hmax;
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      const d = dmin + u * (dmax - dmin);
      let mu = d === 0 ? 1 : (Hmax * Hmax - rho * rho - d * d) / (2 * r * d);
      mu = Math.min(1, Math.max(-1, mu));
      const od = [0, 0, 0];
      const dt = d / 40;
      for (let i = 0; i < 40; i++) {
        const t = (i + 0.5) * dt;
        const h = Math.sqrt(r * r + t * t + 2 * r * mu * t) - RG;
        const { ext } = atmDensity(h);
        for (let c = 0; c < 3; c++) od[c] += ext[c] * dt;
      }
      const o = (y * W + x) * 3;
      for (let c = 0; c < 3; c++) lut[o + c] = Math.exp(-od[c]);
    }
  }
  return lut;
}

/** 双线性采样（GPU 侧是 LinearFilter，这里同口径）。 */
function makeSampler(lut, W, H) {
  return (u, v) => {
    const px = Math.min(W - 1.001, Math.max(0, u * W - 0.5));
    const py = Math.min(H - 1.001, Math.max(0, v * H - 0.5));
    const x0 = Math.floor(px), y0 = Math.floor(py);
    const fx = px - x0, fy = py - y0;
    const at = (x, y, c) => lut[(y * W + x) * 3 + c];
    const out = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const top = at(x0, y0, c) + (at(x0 + 1, y0, c) - at(x0, y0, c)) * fx;
      const bot = at(x0, y0 + 1, c) + (at(x0 + 1, y0 + 1, c) - at(x0, y0 + 1, c)) * fx;
      out[c] = top + (bot - top) * fy;
    }
    return out;
  };
}

// ------------------------------------------------------------------ pass 2：多重散射 LUT

function bakeMultiScatter(sampleTrans) {
  const S = P.msSize;
  const lut = new Float32Array(S * S * 3);
  for (let y = 0; y < S; y++) {
    const v = (y + 0.5) / S;
    const r = RG + 0.01 + v * (RT - RG - 0.02);
    for (let x = 0; x < S; x++) {
      const u = (x + 0.5) / S;
      const sunMu = u * 2 - 1;
      const sunD = [Math.sqrt(Math.max(0, 1 - sunMu * sunMu)), sunMu, 0];
      const lum = [0, 0, 0], fms = [0, 0, 0];
      // 8×8 球面方向积分（上游 msPass 逐字）
      for (let a = 0; a < 8; a++) {
        for (let b = 0; b < 8; b++) {
          const ct = 1 - 2 * (b + 0.5) / 8;
          const st = Math.sqrt(1 - ct * ct);
          const ph = 2 * Math.PI * (a + 0.5) / 8;
          const dir = [st * Math.cos(ph), ct, st * Math.sin(ph)];
          const ro = [0, r, 0];
          const tG = raySphere(ro, dir, RG), tT = raySphere(ro, dir, RT);
          const tMax = tG > 0 ? tG : tT;
          const T = [1, 1, 1], L = [0, 0, 0], F = [0, 0, 0];
          const dt = tMax / 20;
          for (let i = 0; i < 20; i++) {
            const t = (i + 0.5) * dt;
            const p = [ro[0] + dir[0] * t, ro[1] + dir[1] * t, ro[2] + dir[2] * t];
            const pr = len3(p), h = pr - RG;
            const { rayS, mieS, ext } = atmDensity(h);
            const sT = ext.map((e) => Math.exp(-e * dt));
            const sc = rayS.map((v2) => v2 + mieS);
            const mu = dot3(p.map((v2) => v2 / pr), sunD);
            const [tu, tv] = transUV(pr, mu);
            const shadowed = raySphere(p, sunD, RG) > 0 ? 0 : 1;
            const trSun = sampleTrans(tu, tv).map((v2) => v2 * shadowed);
            for (let c = 0; c < 3; c++) {
              const Sc = trSun[c] * sc[c] / (4 * Math.PI);
              L[c] += T[c] * (Sc - Sc * sT[c]) / Math.max(ext[c], 1e-7);
              F[c] += T[c] * (sc[c] - sc[c] * sT[c]) / Math.max(ext[c], 1e-7);
              T[c] *= sT[c];
            }
          }
          // 地面反照项（上游 tG>0 分支）
          if (tG > 0) {
            const p = ro.map((v2, c) => v2 + dir[c] * tG);
            const n = norm3(p);
            const mu = dot3(n, sunD);
            const [tu, tv] = transUV(RG, mu);
            const tr = sampleTrans(tu, tv);
            for (let c = 0; c < 3; c++) L[c] += T[c] * tr[c] * Math.max(mu, 0) * 0.22 / Math.PI;
          }
          for (let c = 0; c < 3; c++) { lum[c] += L[c]; fms[c] += F[c]; }
        }
      }
      const o = (y * S + x) * 3;
      for (let c = 0; c < 3; c++) lut[o + c] = (lum[c] / 64) / (1 - fms[c] / 64);
    }
  }
  return lut;
}

// ------------------------------------------------------------------ pass 3：天空视图（逐方向求值）

/**
 * 某个方向的天空辐射（上游 skyPass 的方向积分，32 步二次分布）。
 *
 * ⚠️ 只算**太阳**贡献：「普通」是白昼手动档，`moonVisible:false`、`uNight=0`
 * ⇒ 上游那个月亮项在本档恒 0，搬进来只会多一份未测代码路径。
 * ⚠️ airglow floor 保留（上游有，且它让天顶不纯黑）。
 * ⚠️ storm 混色不做（本档 `uStorm=0`）。
 */
function skyRadiance(dir, sunDir, sampleTrans, sampleMS) {
  const ro = [0, RG + P.altitude, 0];
  const tG = raySphere(ro, dir, RG), tT = raySphere(ro, dir, RT);
  const tMax = tG > 0 ? tG : tT;
  const T = [1, 1, 1], L = [0, 0, 0];
  const cS = dot3(dir, sunDir);
  const pR = phaseRay(cS), pM = phaseMie(cS);
  let prev = 0;
  for (let i = 0; i < 32; i++) {
    const f = (i + 1) / 32;
    const tNew = f * f * tMax;      // 二次分布：近处密、远处疏
    const dt = tNew - prev;
    const t = prev + dt * 0.5;
    prev = tNew;
    const p = [ro[0] + dir[0] * t, ro[1] + dir[1] * t, ro[2] + dir[2] * t];
    const pr = len3(p), h = pr - RG;
    const { rayS, mieS, ext } = atmDensity(h);
    const up = p.map((v) => v / pr);
    const muS = dot3(up, sunDir);
    const [tu, tv] = transUV(pr, muS);
    const shadowed = raySphere(p, sunDir, RG) > 0 ? 0 : 1;
    const trS = sampleTrans(tu, tv).map((v) => v * shadowed);
    const msS = sampleMS(muS * 0.5 + 0.5, (pr - RG) / (RT - RG));
    for (let c = 0; c < 3; c++) {
      const S = P.sunIllum * (trS[c] * (rayS[c] * pR + mieS * pM) + msS[c] * (rayS[c] + mieS));
      const sT = Math.exp(-ext[c] * dt);
      L[c] += T[c] * (S - S * sT) / Math.max(ext[c], 1e-7);
      T[c] *= sT;
    }
  }
  // airglow floor（上游逐字）
  const k = 1 + 0.6 * Math.pow(1 - Math.abs(dir[1]), 4);
  L[0] += 0.0011 * k; L[1] += 0.0019 * k; L[2] += 0.0042 * k;
  return L;
}

// ------------------------------------------------------------------ 方向 ↔ 立方图面

/**
 * 面内 (u,v) → 立方体方向（OpenGL 立方图约定，v 向下为 +）。
 * **与 `bake-night-sky.mjs` 的 faceDir 逐字同源**（那条管线已实测无缝）。
 *
 * ⚠️ uv 用 `x/(SIZE-1)`：输出贴图的首末列必须对应面的**完整边缘**，
 * 否则边界两侧各偏半像素 → 方向不同 → 出现接缝。
 */
function faceDir(face, u, v) {
  const s = u * 2 - 1;
  const t = v * 2 - 1;
  switch (face) {
    case 0: return norm3([1, -t, -s]);   // posx
    case 1: return norm3([-1, -t, s]);   // negx
    case 2: return norm3([s, 1, t]);     // posy
    case 3: return norm3([s, -1, -t]);   // negy
    case 4: return norm3([s, -t, 1]);    // posz
    case 5: return norm3([-s, -t, -1]);  // negz
    default: throw new Error(`bad face ${face}`);
  }
}

/** 上游 `Sky.update(hours)` 的太阳方向（逐字；与 VISUAL_STYLES.normal.sunDirection 同源）。 */
function sunDirAt(hours) {
  const a = (hours - 6) / 24 * Math.PI * 2;
  return norm3([Math.cos(a), Math.sin(a) * 0.9, Math.sin(a) * 0.36 + 0.12]);
}

// ------------------------------------------------------------------ 编码

const srgbEncode = (x) => {
  const v = Math.min(1, Math.max(0, x));
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
};

const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * 日轮 + 光晕（上游 `23_glsl_lighting.js` 的 `skyColor()` 太阳段，逐字）。
 *
 *   ang = acos(dot(rd, sunDir))
 *   盘面（ang < SR×1.15）：limb-darkening `0.42 + 0.58×sqrt(1−x²)`，边缘 smoothstep 抗齿
 *   光晕：exp(−ang²×2600)×0.012 + exp(−ang×26)×0.0016
 *
 * ⚠️ `horizon = smoothstep(-0.03, 0.05, rd.y)`：地平线以下不画日轮
 * （否则太阳会出现在地面那半）。本档太阳仰角 32.4°，恒在可见区。
 * ⚠️ 日轮颜色 = 透射率×820（上游 uSunDisc）—— 清晨/傍晚它会自然偏红，
 * 因为蓝光被大气散射掉了。本档 h=8.5 仰角 32° ⇒ 接近白。
 */
function sunDisc(dir, sunDir, sampleTrans) {
  const cs = Math.min(1, Math.max(-1, dot3(dir, sunDir)));
  const ang = Math.acos(cs);
  const SR = P.sunAngularRadius;
  const horizon = smoothstep(-0.03, 0.05, dir[1]);
  // 太阳方向的透射率（决定日轮颜色）—— 上游 prepareSky 用 max(sunY, 0)
  const [tu, tv] = transUV(RG + P.altitude, Math.max(sunDir[1], 0));
  const tr = sampleTrans(tu, tv);
  const gain = P.sunDiscGain * horizon;
  const out = [0, 0, 0];
  if (ang < SR * 1.15) {
    const x = ang / SR;
    const mu = Math.sqrt(Math.max(0, 1 - x * x));
    const limb = (0.42 + 0.58 * mu) * smoothstep(1.08, 0.92, x);
    for (let c = 0; c < 3; c++) out[c] += tr[c] * gain * limb;
  }
  const glow = Math.exp(-ang * ang * 2600) * 0.012 + Math.exp(-ang * 26) * 0.0016;
  for (let c = 0; c < 3; c++) out[c] += tr[c] * gain * glow;
  return out;
}

function buildFace(faceIdx, sunDir, sampleTrans, sampleMS, horizonColor) {
  const png = new PNG({ width: SIZE, height: SIZE });
  const denom = SIZE - 1;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dir = faceDir(faceIdx, x / denom, y / denom);
      let rgb;
      if (dir[1] >= P.groundBlend) {
        // 上半：纯大气 + 日轮/光晕
        const sky = skyRadiance(dir, sunDir, sampleTrans, sampleMS);
        const disc = sunDisc(dir, sunDir, sampleTrans);
        rgb = [0, 1, 2].map((c) => (sky[c] + disc[c]) * P.bakeExposure);
      } else {
        // 天底半：中性地面色（不画地形 —— 用户红线）。
        // 过渡带内与「贴地平线的天空」平滑混合，避免地平线处出现硬边。
        const upDir = norm3([dir[0], Math.max(dir[1], 0.002), dir[2]]);
        const sky = skyRadiance(upDir, sunDir, sampleTrans, sampleMS).map((v) => v * P.bakeExposure);
        const ground = horizonColor.map((v) => v * P.groundFactor);
        const w = smoothstep(-P.groundBlend, P.groundBlend, dir[1]);
        rgb = [0, 1, 2].map((c) => ground[c] + (sky[c] - ground[c]) * w);
      }
      const o = ((y * SIZE) + x) << 2;
      for (let c = 0; c < 3; c++) png.data[o + c] = Math.round(srgbEncode(rgb[c]) * 255);
      png.data[o + 3] = 255;
    }
  }
  return png;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const sunDir = sunDirAt(P.hour);
  console.log(`[normalsky] h=${P.hour} 太阳仰角 ${(Math.asin(sunDir[1]) * 180 / Math.PI).toFixed(2)}°`);

  console.log(`[normalsky] 烘焙透射率 LUT ${P.transW}×${P.transH}`);
  const trans = bakeTransmittance();
  const sampleTrans = makeSampler(trans, P.transW, P.transH);

  console.log(`[normalsky] 烘焙多重散射 LUT ${P.msSize}×${P.msSize}（8×8 方向 × 20 步）`);
  const ms = bakeMultiScatter(sampleTrans);
  const sampleMS = makeSampler(ms, P.msSize, P.msSize);

  // 地平线色（天底半的中性地面色由它派生）：取朝阳侧地平方向的辐射
  const horizDir = norm3([sunDir[0], 0.02, sunDir[2]]);
  const horizonColor = skyRadiance(horizDir, sunDir, sampleTrans, sampleMS)
    .map((v) => v * P.bakeExposure);
  console.log(`[normalsky] 地平线色（线性）${horizonColor.map((v) => v.toFixed(4)).join(', ')}`);

  // node 无原生 JPEG 编码器 → 借 chromium canvas（本仓既有手法，同 bake-night-sky）
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('data:text/html,<canvas id=c></canvas>');

  for (let i = 0; i < NORMAL_SKY_FACES.length; i++) {
    const png = buildFace(i, sunDir, sampleTrans, sampleMS, horizonColor);
    const b64 = png.data.toString('base64');
    const out = await page.evaluate(async ({ w, h, data, q }) => {
      const c = document.getElementById('c');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      const bin = atob(data);
      const arr = new Uint8ClampedArray(bin.length);
      for (let k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);
      ctx.putImageData(new ImageData(arr, w, h), 0, 0);
      const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', q));
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let k = 0; k < buf.length; k++) s += String.fromCharCode(buf[k]);
      return btoa(s);
    }, { w: SIZE, h: SIZE, data: b64, q: P.jpegQuality });
    const file = path.join(OUT_DIR, NORMAL_SKY_FACES[i]);
    fs.writeFileSync(file, Buffer.from(out, 'base64'));
    console.log(`  ✓ ${NORMAL_SKY_FACES[i]}  ${(fs.statSync(file).size / 1024).toFixed(0)}KB`);
  }
  await browser.close();

  fs.writeFileSync(OUT_JSON, JSON.stringify({
    size: SIZE,
    faces: NORMAL_SKY_FACES,
    source: 'ASHLAR atmosphere (22_sky.js transPass/msPass/skyPass) → 方向求值 → 立方图',
    fingerprint: normalSkyFingerprint(),
  }, null, 1));
  console.log('  ✓ normal-sky.json');
  console.log('[normalsky] 完成');
}

main().catch((e) => { console.error(e); process.exit(1); });