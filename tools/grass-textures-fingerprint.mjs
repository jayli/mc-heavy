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
  return {
    input: crypto.createHash('sha256').update(parts.join('|')).digest('hex'),
    sources,
  };
}
