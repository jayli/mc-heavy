// tools/bake-rain-sheet.mjs — 烘焙远景雨幕的**雨丝条纹图**（程序化，零美术资源）
//
// 上游：`bj-shooting-game/night-heron-src/src/gfx/textures.js` 的 `makeRainSheet()`：
//   512² 画布、900 条竖直渐变线段（长 18~64、宽 0.6~1.5、alpha 0.08~0.75），
//   两端透明、80% 处最亮，**上下各画一遍**保证竖直可平铺。
//
// ## 为什么必须烘焙成纹理而不是在 shader 里算
//
// **这是用户报告「雨雾像光栅扫描」的根因修复**（本轮像素实测）：
// 原实现用 `hash(floor(vec2(u*32, v*1.5)))` + `smoothstep(0.86,0.99,n)` ——
// 那是**硬格子**：每个 cell 整体亮或整体暗 ⇒ 屏幕上是一片轴对齐矩形块。
// 实测「雨幕层」相邻像素**完全相同的比例 82.06%**（场景本身只有 4.63%）
// ⇒ 大面积平坦色块 + 硬边界 = 光栅扫描观感。
// 上游用的是**双线性采样的条纹纹理**：细、软、有渐变 ⇒ 读作雨丝而不是网格。
//
// ⚠️ 烘焙 = 数据格式转换（把上游的 canvas 绘制换成离线 PNG），**不新增美术资源**。
// ⚠️ 确定性：固定种子 mulberry32（红线 2），三轮重烘逐字节一致。
//
// 用法：node tools/bake-rain-sheet.mjs（或 npm run rainsheet）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PNG = path.join(__dirname, '..', 'assets', 'effects', 'rain-sheet.png');
const OUT_JSON = path.join(__dirname, '..', 'assets', 'effects', 'rain-sheet.json');

import { RAIN_SHEET } from './bake-rain-sheet-params.mjs';
export { RAIN_SHEET };


function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 逐像素绘制（不依赖 canvas —— Node 无 DOM）。
 *
 * 每条线段 = 一个**竖直的软胶囊**：
 *   横向：`1 − (|dx| / halfWidth)²` 的平滑衰减（round cap 的等价）
 *   纵向：两端 0、peakStop 处 alpha 的三段线性渐变（上游 createLinearGradient）
 * 上下各画一遍（`oy ∈ {0, −S}`）保证竖直可平铺（上游同手法）。
 *
 * ⚠️ 用**最大值合成**而不是加法（上游 `stroke` 是 source-over，重叠处不叠成过曝）：
 * 加法会让密集处烧成白块 —— 那正是「光栅感」的另一种形态。
 */
function render(cfg) {
  const S = cfg.size;
  const out = new Float32Array(S * S);
  const rnd = mulberry32(cfg.seed);
  for (let i = 0; i < cfg.strokes; i++) {
    const x = rnd() * S;
    const y = rnd() * S;
    const len = cfg.lenMin + rnd() * (cfg.lenMax - cfg.lenMin);
    const a = cfg.alphaMin + rnd() * (cfg.alphaMax - cfg.alphaMin);
    const w = cfg.widthMin + rnd() * (cfg.widthMax - cfg.widthMin);
    const half = w / 2;
    const x0 = Math.floor(x - half - 1);
    const x1 = Math.ceil(x + half + 1);
    for (const oy of [0, -S]) {
      const yy = y + oy;
      const y0 = Math.floor(yy);
      const y1 = Math.ceil(yy + len);
      for (let py = y0; py <= y1; py++) {
        const ty = (py - yy) / len;
        if (ty < 0 || ty > 1) continue;
        // 纵向渐变：0 → peakStop(a) → 1(0)
        const g = ty <= cfg.peakStop
          ? a * (ty / cfg.peakStop)
          : a * (1 - (ty - cfg.peakStop) / (1 - cfg.peakStop));
        const row = ((py % S) + S) % S;
        for (let px = x0; px <= x1; px++) {
          const dx = Math.abs(px - x);
          if (dx > half + 0.5) continue;
          // 横向软边（亚像素覆盖）
          const cov = Math.max(0, Math.min(1, half + 0.5 - dx));
          const v = g * cov;
          const col = ((px % S) + S) % S;
          const idx = row * S + col;
          if (v > out[idx]) out[idx] = v;   // 最大值合成（见函数注释）
        }
      }
    }
  }
  return out;
}

function main() {
  const cfg = RAIN_SHEET;
  const f = render(cfg);
  const S = cfg.size;
  const png = new PNG({ width: S, height: S });
  let peak = 0;
  let sum = 0;
  let nonZero = 0;
  for (let i = 0; i < S * S; i++) {
    const v = Math.max(0, Math.min(1, f[i]));
    const b = Math.round(v * 255);
    png.data[i * 4] = b;
    png.data[i * 4 + 1] = b;
    png.data[i * 4 + 2] = b;
    png.data[i * 4 + 3] = 255;
    if (v > peak) peak = v;
    sum += v;
    if (v > 0.004) nonZero++;
  }
  fs.mkdirSync(path.dirname(OUT_PNG), { recursive: true });
  fs.writeFileSync(OUT_PNG, PNG.sync.write(png));
  // 内容指纹（FNV-1a，同其余烘焙脚本）
  const raw = fs.readFileSync(OUT_PNG);
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw[i];
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  const meta = {
    version: cfg.version,
    size: S,
    params: cfg,
    metrics: {
      peak: +peak.toFixed(4),
      mean: +(sum / (S * S)).toFixed(5),
      coverage: +(nonZero / (S * S)).toFixed(4),
    },
    fingerprints: {
      input: Object.entries(cfg).map(([k, v]) => `${k}:${v}`).join(';'),
      png: (h >>> 0).toString(36),
    },
    source: 'bj-shooting-game/night-heron-src/src/gfx/textures.js makeRainSheet()（逐字移植，离线渲染）',
  };
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`[rainsheet] ${S}² peak=${meta.metrics.peak} mean=${meta.metrics.mean} coverage=${meta.metrics.coverage}`);
  // 契约：覆盖率必须落在「稀疏细丝」区间 —— 太高会糊成一片白雾（光栅感的另一形态）
  if (meta.metrics.coverage < 0.02 || meta.metrics.coverage > 0.35) {
    throw new Error(`[rainsheet] 覆盖率 ${meta.metrics.coverage} 越界（应 0.02~0.35）`);
  }
  if (meta.metrics.peak < 0.3) throw new Error(`[rainsheet] 峰值 ${meta.metrics.peak} 过低`);
}

main();