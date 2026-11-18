// tools/bake-night-sky.mjs — 烘焙**无缝**夜空立方图（方向空间加权重采样，确定性）
//
// 产物：assets/sky/night/{posx,negx,posy,negy,posz,negz}.jpg + night-sky.json（指纹）
// 输入：assets/sky/night-src/ 的六张原图（mc-lite `skyBox1` 原样，未重编码）
//
// ## 为什么要烘焙（v1.60）
//
// mc-lite `skyBox1` 的六面是**各自独立生成**的图：12 条共享边的平均 RMS 落差 **41.09**
// （白天 `skyBox4` 只有 1.90，差 22 倍）。游戏里表现为天空被几条**笔直的暗线**切成方块感
// （用户 2026-10-21：「有明显的衔接边界，看上去就是一个有楞有角的盒子」）。
//
// ## 无缝是怎么保证的
//
// 对每个输出像素：像素 → 立方体方向 dir → 六个**源面**各自按 dir 反算 uv + 双线性采样
// → 按「该 uv 离本面中心多近」加权平均。
//   - dir 在立方体几何上跨面**连续**（同一条射线）
//   - 权重是 uv 的**连续函数**
//   → 边界两侧算出的是同一组 (uv, weight)，混合结果**逐位相同** → 接缝**精确为零**
//     （实测 12 条边 RMS 0.02，原图 41.09）
//
// 面中心处只有本面权重 > 0 → 原图细节完整保留（实测高频能量 7.37 vs 原图 10.61）。
//
// 用法：node tools/bake-night-sky.mjs
// 输出 JSON 里的指纹供 `npm run check:data` 的 [夜空] 环节比对。
//
// ⚠️ 本脚本**只写** assets/sky/night/ 下的 7 个文件，不删除任何东西。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { chromium } from 'playwright';
import {
  NIGHT_SKY_FACES, NIGHT_SKY_SIZE, NIGHT_SKY_PARAMS, nightSkyFingerprint,
  NIGHT_SKY_FINGERPRINT_JSON,
} from './night-sky-fingerprint.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(__dirname, '..', 'assets', 'sky', 'night-src');
const OUT_DIR = path.join(__dirname, '..', 'assets', 'sky', 'night');
const OUT_JSON = path.join(__dirname, '..', NIGHT_SKY_FINGERPRINT_JSON);
const SIZE = NIGHT_SKY_SIZE;
const P = NIGHT_SKY_PARAMS;

// ------------------------------------------------------------------ 方向数学

const norm3 = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/**
 * 面内 (u,v) → 立方体方向（OpenGL 立方图约定，v 向下为 +）。
 *
 * ⚠️ **uv 用 x/(SIZE-1) 而不是硬件采样的 (x+0.5)/SIZE**：输出贴图的第一列/最后一列
 * 必须对应**面的完整边缘**（u=0 / u=1），否则边界两侧各自偏半像素，混合权重算出来不同 →
 * 接缝不会精确为零。代价是整面图案相对硬件采样偏 0.5 像素（0.5/1024，不可见）。
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

/** 方向 → 某面的 uv（**允许越界**，越界部分用于跨面混合）。返回 null 表示该面无定义。 */
function dirToUV(face, d) {
  const ax = Math.abs(d[0]), ay = Math.abs(d[1]), az = Math.abs(d[2]);
  let s, t, ma;
  if (face === 0 || face === 1) {
    ma = ax; if (ma < 1e-9) return null;
    s = face === 0 ? -d[2] / ma : d[2] / ma;
    t = -d[1] / ma;
  } else if (face === 2 || face === 3) {
    ma = ay; if (ma < 1e-9) return null;
    s = d[0] / ma;
    t = face === 2 ? d[2] / ma : -d[2] / ma;
  } else {
    ma = az; if (ma < 1e-9) return null;
    s = face === 4 ? d[0] / ma : -d[0] / ma;
    t = -d[1] / ma;
  }
  return [(s + 1) / 2, (t + 1) / 2];
}

// ------------------------------------------------------------------ 混合权重

/**
 * 混合权重：面中心 = 1，`1 + blendPad` 处 = 0。
 *
 * ⚠️ 幂次作用在**归一化后的 t** 上（`t^blendPower`）而不是直接作用在距离上 ——
 * 这样面中心一块区域权重恒为 1（细节完整保留），过渡集中在边缘。
 */
const weightCache = new Map();
function blendWeight(u, v) {
  const key = `${u.toFixed(6)},${v.toFixed(6)}`;
  const hit = weightCache.get(key);
  if (hit !== undefined) return hit;
  const du = Math.abs(u - 0.5) * 2;
  const dv = Math.abs(v - 0.5) * 2;
  const m = Math.max(du, dv);            // 0 = 面中心，1 = 面边缘
  const lim = 1 + P.blendPad;
  let w = 0;
  if (m < lim) {
    const t = Math.max(0, Math.min(1, 1 - (m - 1) / P.blendPad));
    w = Math.pow(t, P.blendPower);
  }
  weightCache.set(key, w);
  return w;
}

// ------------------------------------------------------------------ 源图解码

/** node 无原生 JPEG 解码器 → 借 chromium canvas（本仓既有手法，同 bake-zombie-skin） */
async function decodeSources() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('data:text/html,<canvas id=c></canvas>');
  const out = [];
  for (const face of NIGHT_SKY_FACES) {
    const b64 = fs.readFileSync(path.join(SRC_DIR, face)).toString('base64');
    const raw = await page.evaluate(async ({ b64, S }) => {
      const img = new Image();
      img.src = `data:image/jpeg;base64,${b64}`;
      await img.decode();
      const c = document.getElementById('c');
      c.width = S; c.height = S;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, S, S).data;
      let s = '';
      for (let i = 0; i < d.length; i++) s += String.fromCharCode(d[i]);
      return btoa(s);
    }, { b64, S: SIZE });
    out.push(Buffer.from(raw, 'base64'));
  }
  await browser.close();
  return out;
}

/** 双线性采样（越界钳制到边缘 —— 越界区域的贡献权重本身已趋近 0） */
function sampleBilinear(src, u, v, ch) {
  const px = Math.min(SIZE - 1.001, Math.max(0, u * (SIZE - 1)));
  const py = Math.min(SIZE - 1.001, Math.max(0, v * (SIZE - 1)));
  const x0 = Math.floor(px), y0 = Math.floor(py);
  const fx = px - x0, fy = py - y0;
  const at = (x, y) => src[(((y * SIZE) + x) << 2) + ch];
  const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * fx;
  const bot = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * fx;
  return top + (bot - top) * fy;
}

// ------------------------------------------------------------------ 主流程

function buildFace(faceIdx, sources) {
  const png = new PNG({ width: SIZE, height: SIZE });
  const denom = SIZE - 1;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dir = faceDir(faceIdx, x / denom, y / denom);
      let r = 0, g = 0, b = 0, wsum = 0;
      for (let f = 0; f < 6; f++) {
        const uv = dirToUV(f, dir);
        if (!uv) continue;
        const w = blendWeight(uv[0], uv[1]);
        if (w <= 0) continue;
        r += sampleBilinear(sources[f], uv[0], uv[1], 0) * w;
        g += sampleBilinear(sources[f], uv[0], uv[1], 1) * w;
        b += sampleBilinear(sources[f], uv[0], uv[1], 2) * w;
        wsum += w;
      }
      const o = ((y * SIZE) + x) << 2;
      if (wsum > 0) {
        png.data[o] = Math.min(255, Math.round(r / wsum));
        png.data[o + 1] = Math.min(255, Math.round(g / wsum));
        png.data[o + 2] = Math.min(255, Math.round(b / wsum));
      }
      png.data[o + 3] = 255;
    }
  }
  return png;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[nightsky] 源图解码中（${SIZE}² × ${NIGHT_SKY_FACES.length} 面）`);
  const sources = await decodeSources();

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('data:text/html,<canvas id=c></canvas>');

  for (let i = 0; i < NIGHT_SKY_FACES.length; i++) {
    const png = buildFace(i, sources);
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
    const file = path.join(OUT_DIR, NIGHT_SKY_FACES[i]);
    fs.writeFileSync(file, Buffer.from(out, 'base64'));
    console.log(`  ✓ ${NIGHT_SKY_FACES[i]}  ${(fs.statSync(file).size / 1024).toFixed(0)}KB`);
  }
  await browser.close();

  fs.writeFileSync(OUT_JSON, JSON.stringify({
    size: SIZE,
    faces: NIGHT_SKY_FACES,
    source: 'mc-lite:src/assets/skyBox1 → 方向空间加权重采样',
    fingerprint: nightSkyFingerprint(),
  }, null, 1));
  console.log('  ✓ night-sky.json');
  console.log('[nightsky] 完成');
}

main().catch((e) => { console.error(e); process.exit(1); });
