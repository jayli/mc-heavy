// tools/zombie-head-fingerprint.mjs — 丧尸头部马赛克纹理的图案参数与输入指纹
//
// **两个消费者共用同一份逻辑**（红线 1：图案参数只有一份权威），沿用
// `tools/icon-fingerprint.mjs` 的既有模式：
//   - `tools/bake-zombie-head.mjs` 烘焙时按本参数生成并写进 `assets/zombie/head.json`
//   - `tools/check-data.mjs` 用当前参数重算并比对 → 不匹配即报「跑 npm run zombie」
//
// 纹理是**派生产物**，权威输入是本文件的图案参数。改了参数却忘跑 `npm run zombie`，
// 纹理会**静默过期**（渲染旧图案/旧配色，肉眼看不出）—— 与图标过期同一条失效路径
// （v1.24 记录过「改 mesher 几何忘跑 atlas」）。
//
// 图案参数逐项实测自 mc-lite `src/actors/enemy/ZombieInstancedRenderer.js`
// （`:99-119` `TEXTURE_CONFIG` + `:581-666` 绘制 + `drawEyes`），非凭字段名推断。
//
// node 侧模块（要读 PNG 文件），不进 src/，浏览器不消费。

import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 产物路径（烘焙脚本与门禁共用，避免两处各写一份） */
export const HEAD_PNG = path.join(__dirname, '..', 'assets', 'zombie', 'head.png');
export const HEAD_JSON = path.join(__dirname, '..', 'assets', 'zombie', 'head.json');

/**
 * 图案参数（mc-lite `TEXTURE_CONFIG` 逐项对应）。
 *
 * ⚠️ **`noiseProbability` 照字段名理解会把图案画反**：字段名是「噪点使用概率」、注释写
 * 「30% 的方块会使用噪点颜色」，但 mc-lite 的判定是 **`Math.random() > 0.7` 才用噪点**
 * （`generateMosaicColor`，`:633`）→ 实际只有 **30%** 的方块用噪点，70% 用基础色。
 * 若按字面理解成「70% 用噪点」，图案会噪点过密、基础绿几乎看不见。
 */
export const HEAD_TEXTURE_CONFIG = Object.freeze({
  /** 马赛克网格数（每面） */
  mosaicCount: 8,
  /** 每格像素 → 单区画布 64×64 */
  mosaicSize: 8,
  /** 基础色（深绿，mc-lite `headPalette.base`） */
  base: [64, 107, 48],
  /** 噪点色三选（mc-lite `headPalette.noise`） */
  noise: [[48, 80, 36], [80, 134, 60], [96, 160, 72]],
  /** 噪点阈值：`rand > 0.7` 才用噪点 → 实际 30%（见上方 ⚠️） */
  noiseProbability: 0.7,
  /** 基础色波动幅度（`(rand-0.5)×5`） */
  baseColorVariation: 5,
  /** 眼睛网格坐标（mc-lite `drawEyes`：第 3 列与第 6 列、第 4 行） */
  eyes: [[2, 3], [5, 3]],
  /** 眼睛像素色 */
  eyeColor: [0, 0, 0],
  /** 固定种子：mc-lite 用 `Math.random()`（每次加载图案都不同 → 违反红线 2），
   *  本仓库取其中一种稳定形态（同 `tools/bake-procedural-textures.mjs` 的既有先例） */
  seed: 20260908,
});

/** 单区尺寸（mosaicCount × mosaicSize） */
export const ZONE = HEAD_TEXTURE_CONFIG.mosaicCount * HEAD_TEXTURE_CONFIG.mosaicSize; // 64
/** 双区并排：左半无眼睛 / 右半有眼睛（不能用上下分区 —— 会把 8×8 马赛克压成 8×4） */
export const HEAD_WIDTH = ZONE * 2; // 128
export const HEAD_HEIGHT = ZONE;    // 64

/** 眼睛在网格里的方块数（关系型断言的基准：黑像素数 = 此值 × mosaicSize²） */
export const EYE_CELLS = HEAD_TEXTURE_CONFIG.eyes.length; // 2

/**
 * 固定种子 RNG（mulberry32）。与 `tools/bake-procedural-textures.mjs` 同款实现 ——
 * 两处是同一个算法的两个副本，但各自服务于不同产物，不共享调用序列，故不抽公共模块。
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 输入指纹 = 全部图案参数（与烘焙脚本读的东西一一对应）。
 *
 * 为什么用参数指纹而非颜色比对：指纹是**精确**判定（任一参数变了必不匹配），不依赖阈值调参；
 * 颜色启发式会有假阴（改了参数但主色恰好相近）。
 *
 * 已知盲区（与 `icon-fingerprint.mjs` 同类）：改**烘焙算法**而不动参数时指纹不变 ——
 * 这类改动须靠 Tier 4 像素实测兜住。
 */
export function headInputFingerprint() {
  const c = HEAD_TEXTURE_CONFIG;
  return [
    `mosaic:${c.mosaicCount}x${c.mosaicSize}`,
    `base:${c.base.join(',')}`,
    `noise:${c.noise.map((n) => n.join('.')).join('|')}`,
    `p:${c.noiseProbability}`,
    `var:${c.baseColorVariation}`,
    `eyes:${c.eyes.map((e) => e.join(',')).join('|')}#${c.eyeColor.join(',')}`,
    `seed:${c.seed}`,
  ].join(';');
}

/** PNG 内容哈希（FNV-1a 32bit，纯整数无依赖，同 `icon-fingerprint.mjs` 的 `texHash`） */
export function pngHash(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  let h = 0x811c9dc5;
  for (let i = 0; i < png.data.length; i++) {
    h ^= png.data[i];
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return (h >>> 0).toString(36);
}
