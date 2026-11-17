// tools/grass-textures-fingerprint.mjs — 深草/浅草贴图的烘焙参数与指纹共享模块
//
// 烘焙脚本（`bake-grass-textures.mjs`）与数据契约门（`check-data.mjs` 的 `[草贴图]` 环节）
// **共同 import 这一份**（红线 1：两处各写一份参数会漂移出门禁检查错文件的假绿）。
//
// ⚠️ 本文件依赖 `node:fs` / `node:crypto` → **只在 node 侧使用**。
// `src/**` 与浏览器单测**绝不能** import 它（会解析失败 → 模块不加载 → 白屏）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// 着色常量与纯函数的唯一权威在同构模块（红线 1）—— 浏览器单测也 import 它。
// 本文件依赖 node:fs，浏览器拿不到；故常量不能反过来写在这里。
import { GRASS_TINT } from '../src/voxel/tint-math.js';

export { GRASS_TINT };

const __dirname = path.dirname(import.meta.url.replace('file://', ''));
export const ROOT = path.join(__dirname, '..');

/**
 * 源图目录。
 *
 * ⚠️ **必须放在 `assets/grass-textures/src/` 而不是 `assets/textures/`**：
 * `build-atlas` 会**递归扫描** `assets/textures/` 下所有 PNG 并逐个入图
 * （`atlas.spec.mjs` 还断言「tile 数 ≡ PNG 数」）—— 把 736×736 的源图/中间物留在那里
 * 会多出两个巨型 tile（被 `LARGE_TILE` 降到 128×128 白占 atlas 空间），
 * 且与「源素材不是渲染资源」的既有口径不符（同 `assets/sky/night-src/`、
 * `assets/arena/src/`、`assets/giant-trees/src/` 的处置）。
 */
export const SRC_DIR = path.join(ROOT, 'assets', 'grass-textures', 'src');
/** 产物目录（与其它程序化烘焙贴图同目录，会被 `build-atlas` 递归扫进世界 atlas） */
export const OUT_DIR = path.join(ROOT, 'assets', 'textures', 'procedural');
/** 伴生 meta（尺寸 + 指纹），`check:data` 读它判过期 */
export const GRASS_META = path.join(OUT_DIR, 'grass_textures.meta.json');

/** 目标 tile 尺寸：与 atlas 里普通方块的 tile 口径一致 */
export const GRASS_TILE_SIZE = 16;

/**
 * 两个草方块的烘焙定义 —— **产物的唯一权威**。
 *
 * 消费方三处，全部读这一份：
 *   ① `tools/bake-grass-textures.mjs`（写文件）
 *   ② `tools/check-data.mjs` 的 `[草贴图]`（判产物存在 / 均值 / 源图未改）
 *   ③ `src/tests/test-shallow-water-tarns.js` 的方块声明用例（判「方块名 ↔ 贴图名」对得上）
 *
 * 新增第三个草色时只改这里，三处自动跟上。
 */
export const GRASS_TEXTURES = Object.freeze({
  dark_grass: { source: 'grass-dark-green.jpg', out: 'dark_grass.png' },
  light_grass: { source: 'grass-light-green.jpg', out: 'light_grass.png' },
});

/**
 * vanilla 源图目录（**16×16 原尺寸**，与上面两张 736×736 照片不同路数）。
 *
 * 来源：blockrender.dev 的 `/texture/block/<id>.png`，已验
 * `grass_block_top` 与 wiki 官方 `Grass_Block_(top_texture)_JE4_BE2.png` **逐字节相同**，
 * `grass_block_side_overlay` 与 wiki `Grass_Block_(overlay_texture)_JE2.png` 逐字节相同。
 * 入库是为了烘焙可复现（不依赖网络）。
 *
 * ⚠️ 同样**绝不能放 `assets/textures/`**（build-atlas 递归扫描）。
 */
export const VANILLA_SRC_DIR = path.join(SRC_DIR, 'vanilla');

/** 世界贴图目录（tinted 产物有的落 procedural/、有的直接落这一层） */
export const TEX_DIR = path.join(ROOT, 'assets', 'textures');

/**
 * 着色类产物（v3.12）—— **与上面 GRASS_TEXTURES 是两条不同的烘焙路径**。
 *
 * 三种 mode：
 *   · `tint`   ：灰度源图 × GRASS_TINT（alpha 原样）
 *   · `fringe` ：base×(1−a) + ovGray×GRASS_TINT×a，a = overlay alpha/255
 *   · `copy`   ：直接用 vanilla 原字节（该 tile 本仓与 vanilla 同图案但配色偏了）
 *
 * ⚠️ **`out` 是相对 `assets/textures/` 的路径**（不是相对 OUT_DIR）——
 * 既有 tile 如 `grass_carried.png` 就在 `assets/textures/` 根下，不在 procedural/。
 * 用 `../` 拼接会很难读，故统一以 TEX_DIR 为基准。
 *
 * ⚠️ **`grass_side_carried` 的 base 必须是它自己的副本**（`grass_side_base.png`），
 * 不能用 `dirt.png`：vanilla side 的泥土区与 dirt.png 有 **48 个字节差**（side 自带一套
 * dirt 变体）。用 dirt 当 base 会把非草沿区一起改掉。
 */
export const TINTED_TEXTURES = Object.freeze({
  grass_carried: Object.freeze({
    source: 'grass_block_top.png', out: 'grass_carried.png', mode: 'tint',
  }),
  grass_side_carried: Object.freeze({
    source: 'grass_block_side_overlay.png', out: 'grass_side_carried.png', mode: 'fringe',
    base: 'grass_side_base.png',
  }),
  double_plant_grass_carried: Object.freeze({
    source: 'tall_grass_top.png', out: 'double_plant_grass_carried.png', mode: 'tint',
  }),
  bush_grass: Object.freeze({
    source: 'short_grass.png', out: 'procedural/bush_grass.png', mode: 'tint',
  }),
  sand_side: Object.freeze({
    source: 'sand.png', out: 'sand_side.png', mode: 'copy',
  }),
  Light_Gray_Cloth: Object.freeze({
    source: 'light_gray_wool.png', out: 'Light_Gray_Cloth.png', mode: 'copy',
  }),
});

/** tinted 项的源图完整路径 */
export function tintedSourcePath(name) {
  return path.join(VANILLA_SRC_DIR, TINTED_TEXTURES[name].source);
}

/** tinted 项的 base 完整路径（只有 fringe 模式有） */
export function tintedBasePath(name) {
  const def = TINTED_TEXTURES[name];
  return def.base ? path.join(VANILLA_SRC_DIR, def.base) : null;
}

/** tinted 项的产物完整路径 */
export function tintedOutputPath(name) {
  return path.join(TEX_DIR, TINTED_TEXTURES[name].out);
}

/**
 * 着色类产物的**目标均值**（不透明像素口径，alpha>=8）。
 *
 * 这些数字是从入库的 vanilla 源图 + GRASS_TINT **算出来的**，不是拍的：
 * 改 T 或换源图后必须重算（烘焙器会把实测值与这里比，偏差 >0.05/通道就 throw）。
 *
 * ⚠️ **不能复用「均值偏差 ≤2/通道」那条旧断言**：那是盒式降采样的判据
 * （降采样应该保住源图均值）；着色就是要改均值，两条路径的判据必须不同。
 *
 * `grass_side_carried` 记的是**全图**均值；草沿（45 texel）单独的均值见
 * `FRINGE_TARGET_MEAN` —— 全图均值被 dirt 区主导，对「草沿改对了没」判别力弱。
 */
export const TINTED_TARGET_MEAN = Object.freeze({
  grass_carried: Object.freeze([68.95, 107.88, 58.71]),
  grass_side_carried: Object.freeze([119.53, 96.41, 64.05]),
  double_plant_grass_carried: Object.freeze([70.44, 109.13, 60.02]),
  bush_grass: Object.freeze([68.16, 106.29, 58.12]),
  sand_side: Object.freeze([219.16, 207.22, 163.10]),
  Light_Gray_Cloth: Object.freeze([142.03, 142.16, 134.60]),
});

/** 草沿（overlay alpha=255 的 45 个 texel）的目标均值 —— 比全图均值判别力强 */
export const FRINGE_TARGET_MEAN = Object.freeze([72.13, 113.11, 61.49]);
/** 草沿 texel 数（overlay alpha=255）—— 内容级判据，防止遮罩用错 */
export const FRINGE_TEXEL_COUNT = 45;

/** 一份草贴图的完整路径 */
export function sourcePath(name) {
  return path.join(SRC_DIR, GRASS_TEXTURES[name].source);
}

/** 产物 PNG 的完整路径 */
export function outputPath(name) {
  return path.join(OUT_DIR, GRASS_TEXTURES[name].out);
}

/** 产物在 atlas 里的 tile 名（`build-atlas` 用相对 `assets/textures/` 的路径作键） */
export function tileName(name) {
  return `procedural/${GRASS_TEXTURES[name].out.replace(/\.png$/, '')}`;
}

/** 文件 sha256（源图未改的判据） */
export function fileSha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * 输入指纹：覆盖「源图的字节内容」+「烘焙参数」。
 *
 * ⚠️ 已知盲区（与所有烘焙产物同）：只改**算法**而不动参数/源图时指纹不变 ——
 * 那类回归靠单测（均值偏差断言）与 Tier 4 兜住。
 *
 * @returns {{input: string, sources: Object<string,string>}}
 */
export function grassTextureInputFingerprint() {
  const sources = {};
  const parts = [];
  for (const [name, def] of Object.entries(GRASS_TEXTURES)) {
    const file = sourcePath(name);
    const sha = fs.existsSync(file) ? fileSha256(file) : 'missing';
    sources[name] = sha;
    parts.push(`${name}:${def.source}:${def.out}:${sha}`);
  }
  parts.push(`tile:${GRASS_TILE_SIZE}`);
  // 着色类产物（v3.12）。⚠️ **GRASS_TINT 本身必须进指纹**：
  // 只钉源图 sha 的话，「改了 tint 忘重烘」会静默放行（产物还是旧色）。
  parts.push(`tint:${GRASS_TINT.join(',')}`);
  for (const [name, def] of Object.entries(TINTED_TEXTURES)) {
    const file = tintedSourcePath(name);
    const sha = fs.existsSync(file) ? fileSha256(file) : 'missing';
    sources[name] = sha;
    let part = `${name}:${def.source}:${def.out}:${def.mode}:${sha}`;
    const basePath = tintedBasePath(name);
    if (basePath) {
      const baseSha = fs.existsSync(basePath) ? fileSha256(basePath) : 'missing';
      sources[`${name}:base`] = baseSha;
      part += `:base=${def.base}:${baseSha}`;
    }
    parts.push(part);
  }
  return {
    input: crypto.createHash('sha256').update(parts.join('|')).digest('hex'),
    sources,
  };
}
