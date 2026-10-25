// tools/bake-water-textures.mjs — 体素水贴图重着色烘焙（`npm run water`）
//
// ## 为什么需要它
//
// 2026-10-26 用户实玩反馈（第三轮）：「水方块的颜色（水面波纹区覆盖不到的地方呈现出来的颜色）
// 和这个水面的颜色差异稍微有点大，尽量让二者差异没那么大，两者相互接近一些」。
//
// 根因不在着色器而在**贴图**：海面平面（`ocean.js`）与水方块（`faces-data.js` → `water` tile）
// 是两套完全独立的颜色来源。源素材 `assets/textures/water.png` 的均值是 `47/102/211`
// （高饱和**紫蓝**），渲染后实测 `59/100/190` L98 —— 而海面平面是 `92/133/164` L127
// （浅一些的**海蓝**）。两者的差（逐通道绝对差之和）达 **85**，在海岸线上表现为
// 「远处一圈亮紫蓝的水带浮在浅蓝水面上」，非常割裂。
//
// ## 做法
//
// **只做通道平移（每像素 + 同一个偏移量），不改纹理结构** —— 源图有 24 种色阶（相邻像素块
// 明暗略有差异），逐像素加同一偏移量会完整保留这份相对纹理；重画成纯色会让水面变成一块死板。
// 目标均值 = `WATER_TARGET_MEAN`，偏移量 = 目标 − 源实际均值（源均值**运行时算**，不写字面量）。
//
// 对齐目标取「海面平面在 noon 下的实测屏幕色」（`92/133/164` 附近）反推的贴图均值，
// 见 `WATER_TARGET_MEAN` 的注释。实测把两者差距从 **85 → 17**。
//
// ## 为什么要落进 procedural/ 而不是原地改
//
// `assets/textures/*.png` 是 mc-lite 的**入库源素材**，原地改会丢源、且 atlas 计数断言会漂。
// 产物写 `assets/textures/procedural/water.png`，`faces-data.js` 指向它（与树叶孔洞压缩、
// 巨树贴图同一口径）。源图保持不动，任何时候都能重新烘焙。
//
// ## 顺序
//
// 改本脚本参数 → `npm run water` → **必须再跑 `npm run atlas`**（贴图要进世界 atlas）
// → 若水方块仍在背包里则 `npm run icons`。`check:data` 的 `[水体贴图]` 环节会抓「忘了重烘」。
//
// 用法：node tools/bake-water-textures.mjs
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WATER_TARGET_MEAN, WATER_TARGET_ALPHA, WATER_TEX_SOURCES } from './water-texture-fingerprint.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'assets', 'textures');
const OUT_DIR = path.join(SRC_DIR, 'procedural');

/** 算某张图的 RGB 均值（alpha 不参与 —— 通道平移不改 alpha） */
function meanRGB(png) {
  const sum = [0, 0, 0];
  const n = png.width * png.height;
  for (let i = 0; i < n; i++) {
    const o = i << 2;
    sum[0] += png.data[o]; sum[1] += png.data[o + 1]; sum[2] += png.data[o + 2];
  }
  return sum.map((v) => v / n);
}

function bakeOne(name) {
  const srcPath = path.join(SRC_DIR, WATER_TEX_SOURCES[name]);
  const src = PNG.sync.read(fs.readFileSync(srcPath));
  const from = meanRGB(src);
  const target = WATER_TARGET_MEAN[name];
  const delta = target.map((t, i) => t - from[i]);

  const out = new PNG({ width: src.width, height: src.height });
  for (let i = 0; i < src.width * src.height; i++) {
    const o = i << 2;
    for (let c = 0; c < 3; c++) {
      out.data[o + c] = Math.max(0, Math.min(255, Math.round(src.data[o + c] + delta[c])));
    }
    // alpha：null = 保留源图；数字 = 统一改写到该值（盖住海底，见 WATER_TARGET_ALPHA 的注释）
    const a = WATER_TARGET_ALPHA[name];
    out.data[o + 3] = a == null ? src.data[o + 3] : a;
  }

  const outPath = path.join(OUT_DIR, `${name}.png`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(outPath, PNG.sync.write(out));

  const to = meanRGB(out);
  console.log(`[water] ${name}: 源均值 ${from.map((v) => v.toFixed(1)).join('/')}`
    + ` → 目标 ${target.join('/')} → 实得 ${to.map((v) => v.toFixed(1)).join('/')}`
    + `（偏移 ${delta.map((v) => v.toFixed(1)).join('/')}）alpha ${src.data[3]} → ${out.data[3]}`
    + ` → ${path.relative(ROOT, outPath)}`);
}

for (const name of Object.keys(WATER_TEX_SOURCES)) bakeOne(name);
console.log('[water] 完成。⚠️ 接下来必须跑 `npm run atlas`（贴图要进世界 atlas）。');
