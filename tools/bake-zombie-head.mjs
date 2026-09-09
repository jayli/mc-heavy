// tools/bake-zombie-head.mjs — 烘焙丧尸头部马赛克纹理为 PNG（确定性）
//
// mc-lite 的丧尸头部纹理是**运行时 canvas 程序化绘制**（`ZombieInstancedRenderer.js:581-666`
// `createMosaicTexture` / `drawMosaicBackground` / `generateMosaicColor` / `drawEyes`），无 PNG
// 文件。mc-heavy 离线烘焙成 PNG 入库（同 `tools/bake-procedural-textures.mjs` 的既有先例）。
//
// **为什么是双区并排（128×64）而不是 mc-lite 的两张独立纹理**：本仓库的 WebGPU 后端
// **不支持** `InstancedMesh` + 材质数组 + `geometry.groups`（实测：`three.webgpu.js:34592`
// `getMaterial()` 直接 `return material`，不遍历 draw range、不取 `materialIndex` →
// 六面恒用 `material[0]`，正面拿不到有眼睛那张）。故改走**单材质 + 单纹理 + UV 分区**：
// 左半无眼睛 / 右半有眼睛，head 几何的正面顶点 UV 改写到右半（见 `zombie-renderer.js`）。
// 不能用上下分区（64×128）—— 马赛克是 8×8 网格 × 8px，压到 64×32 会破坏马赛克比例。
//
// 产物：`assets/zombie/head.png`（128×64）+ `head.json`（尺寸 + 输入指纹，供门禁比对）。
// **不放 `assets/textures/`**：那里被 `build-atlas.mjs` 的 `collectPngs` 递归扫描进世界 atlas，
// 丧尸头部纹理不属世界方块贴图，进去会污染 atlas。
//
// 用法：node tools/bake-zombie-head.mjs（或 npm run zombie）
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import {
  HEAD_TEXTURE_CONFIG, ZONE, HEAD_WIDTH, HEAD_HEIGHT, HEAD_PNG, HEAD_JSON,
  mulberry32, headInputFingerprint,
} from './zombie-head-fingerprint.mjs';

const OUT_DIR = path.dirname(HEAD_PNG);

/**
 * 生成单个马赛克格的颜色（mc-lite `generateMosaicColor` 逐行复刻）。
 *
 * **RNG 调用序列必须与 mc-lite 一致**（每格：1 次噪点判定；走噪点则再 1 次选色，
 * 否则 3 次波动 —— `base.map` 里每个分量各调一次 `Math.random()`）。序列不同会让
 * 同一份种子产出完全不同的图案，而本仓库靠种子钉住确定性。
 */
function mosaicColor(rng, cfg) {
  // ⚠️ 判定是 `> noiseProbability` → 实际仅 30% 用噪点（照字段名理解会画反，见共享模块注释）
  if (rng() > cfg.noiseProbability) {
    const idx = Math.floor(rng() * cfg.noise.length);
    return cfg.noise[idx].map((c) => Math.floor(c));
  }
  return cfg.base.map((c) => {
    const variation = (rng() - 0.5) * cfg.baseColorVariation;
    return Math.floor(Math.max(0, Math.min(255, c + variation)));
  });
}

/** 画马赛克背景（mc-lite `drawMosaicBackground`）：按格填充，每格一色 */
function drawMosaicBackground(buf, ox, rng, cfg) {
  const { mosaicSize } = cfg;
  for (let gy = 0; gy < ZONE; gy += mosaicSize) {
    for (let gx = 0; gx < ZONE; gx += mosaicSize) {
      const [r, g, b] = mosaicColor(rng, cfg);
      for (let y = gy; y < gy + mosaicSize; y++) {
        for (let x = gx; x < gx + mosaicSize; x++) {
          // 绝对像素 = 区内偏移 x（不是格内偏移）+ 区起点 ox
          const i = (y * HEAD_WIDTH + ox + x) << 2;
          buf.data[i] = r;
          buf.data[i + 1] = g;
          buf.data[i + 2] = b;
          buf.data[i + 3] = 255;
        }
      }
    }
  }
}

/** 画眼睛（mc-lite `drawEyes`）：网格 (2,3) 与 (5,3)，各一格纯黑 */
function drawEyes(buf, ox, cfg) {
  const { mosaicSize, eyeColor } = cfg;
  for (const [gx, gy] of cfg.eyes) {
    for (let py = gy * mosaicSize; py < (gy + 1) * mosaicSize; py++) {
      for (let px = gx * mosaicSize; px < (gx + 1) * mosaicSize; px++) {
        const i = (py * HEAD_WIDTH + ox + px) << 2;
        buf.data[i] = eyeColor[0];
        buf.data[i + 1] = eyeColor[1];
        buf.data[i + 2] = eyeColor[2];
        buf.data[i + 3] = 255;
      }
    }
  }
}

/** 把左半的背景复制到右半（两区共用同一份马赛克 —— 有意偏离，见下） */
function copyLeftToRight(buf) {
  for (let y = 0; y < HEAD_HEIGHT; y++) {
    for (let x = 0; x < ZONE; x++) {
      const src = (y * HEAD_WIDTH + x) << 2;
      const dst = (y * HEAD_WIDTH + ZONE + x) << 2;
      buf.data[dst] = buf.data[src];
      buf.data[dst + 1] = buf.data[src + 1];
      buf.data[dst + 2] = buf.data[src + 2];
      buf.data[dst + 3] = 255;
    }
  }
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const buf = new PNG({ width: HEAD_WIDTH, height: HEAD_HEIGHT });
  const cfg = HEAD_TEXTURE_CONFIG;
  const rng = mulberry32(cfg.seed);

  // ① 左半：无眼睛马赛克背景
  drawMosaicBackground(buf, 0, rng, cfg);
  // ② 右半：**复制**左半背景 + 叠加眼睛。
  //    有意偏离 mc-lite：mc-lite 调两次 `createMosaicTexture`（两次独立 `Math.random()`）
  //    → 正面与侧面是**两张不同的随机图**。那是 `Math.random` 的副作用，非设计意图；
  //    六面共用同一份图案视觉上更连贯，也让「侧面 vs 正面」的差异只剩眼睛这一项
  //    （Tier 4 断言的变量更少、更容易归因）。
  copyLeftToRight(buf);
  drawEyes(buf, ZONE, cfg);

  fs.writeFileSync(HEAD_PNG, PNG.sync.write(buf));

  const fingerprint = headInputFingerprint();
  fs.writeFileSync(HEAD_JSON, JSON.stringify({
    width: HEAD_WIDTH,
    height: HEAD_HEIGHT,
    zone: ZONE,
    eyes: cfg.eyes,
    fingerprint,
  }, null, 2) + '\n');

  console.log(`[zombie] 烘焙完成：assets/zombie/head.png ${HEAD_WIDTH}×${HEAD_HEIGHT}`);
  console.log(`[zombie]   左半无眼睛 / 右半有眼睛（眼睛格 ${JSON.stringify(cfg.eyes)}）`);
  console.log(`[zombie]   指纹 ${fingerprint}`);
}

main();
