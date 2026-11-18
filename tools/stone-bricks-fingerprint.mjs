// tools/stone-bricks-fingerprint.mjs — 石砖/紫珀贴图的烘焙参数、目标均值与输入指纹
//
// 唯一权威（红线 1）：烘焙器 `bake-stone-bricks.mjs` 与数据契约门 `check-data.mjs`
// 都从这里 import，不得各写一份。手法照 `grass-textures-fingerprint.mjs`。
//
// 纯函数（图案签名 / 重映射 / texel 降采样）在 `stone-bricks-parse.mjs`（无 node: 依赖），
// 本模块从它 re-export 供 node 侧一站式 import；浏览器单测直接 import 那个纯函数模块。
//
// ⚠️ 本文件依赖 `node:fs` / `node:crypto` ⇒ **只在 node 侧使用**。
// `src/**` 与浏览器单测**绝不能** import 它（会解析失败 → 模块不加载 → 白屏）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export {
  TOP_FACE_GEOM, topFaceColorMap, remapPalette, downsampleByTexelCenter,
  patternSignature, meanRgb,
} from './stone-bricks-parse.mjs';
import { TOP_FACE_GEOM } from './stone-bricks-parse.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * 烘焙输入目录。
 *
 * ⚠️ **必须在 `assets/stone-bricks/src/` 而不是 `assets/textures/`**：
 * `build-atlas` 递归扫描后者，512×512 源图与 300×300 参考渲染图会各变成一个
 * 被降到 128×128 的巨型 tile（`atlas.spec.mjs` 还断言「tile 数 ≡ PNG 数」）。
 */
export const STONE_BRICKS_SRC_DIR = path.join(ROOT, 'assets', 'stone-bricks', 'src');
/** 参考渲染图目录（配色权威，只在烘焙期读，不进 atlas） */
export const STONE_BRICKS_REF_DIR = path.join(STONE_BRICKS_SRC_DIR, 'reference');
/** 产物目录（世界 atlas 会扫这里） */
export const STONE_BRICKS_OUT_DIR = path.join(ROOT, 'assets', 'textures');
/** 伴生 meta（尺寸 / 均值 / 指纹），`check:data` 读它判过期 */
export const STONE_BRICKS_META = path.join(STONE_BRICKS_OUT_DIR, 'stone_bricks.meta.json');

/** 目标 tile 边长（与 atlas 里普通方块同口径） */
export const STONE_BRICK_TILE_SIZE = 16;

/**
 * 用户提供的 purpur 放大图的取样参数（**实测标定**）。
 *
 * 源图 512×512，不透明 bbox `[25,486]²` ⇒ origin 25 / span 462 / 16 texel。
 * 每 texel 28.875px（非整数）—— 故取样相位错半格就会被众数一致性判据抓到。
 */
export const PURPUR_DOWNSAMPLE = Object.freeze({ origin: 25, span: 462, size: 16 });

/**
 * 四张产物的定义 —— **唯一权威**。
 *
 * 两种 mode：
 *   · `remap`：源图（blockrender 16×16）按参考渲染图顶面反解的映射换色，图案逐格不动；
 *   · `texel`：用户放大图按 texel 中心取样降回 16×16（配色保留用户图，**不重映射**）。
 *
 * ⚠️ `reference` 只在 remap 模式下有；它是**配色权威**，不是贴图来源。
 */
export const STONE_BRICK_TEXTURES = Object.freeze({
  mossy_stone_bricks: Object.freeze({
    source: 'mossy_stone_bricks.png', out: 'mossy_stone_bricks.png', mode: 'remap',
    reference: 'Mossy_Stone_Bricks_JE3_BE2.png',
  }),
  cracked_stone_bricks: Object.freeze({
    source: 'cracked_stone_bricks.png', out: 'cracked_stone_bricks.png', mode: 'remap',
    reference: 'Cracked_Stone_Bricks_JE3_BE2.png',
  }),
  chiseled_stone_bricks: Object.freeze({
    source: 'chiseled_stone_bricks.png', out: 'chiseled_stone_bricks.png', mode: 'remap',
    reference: 'Chiseled_Stone_Bricks_JE3_BE2.png',
  }),
  purpur_block: Object.freeze({
    source: 'purpur_block.png', out: 'purpur_block.png', mode: 'texel',
  }),
});

/**
 * 产物目标均值（不透明像素口径，alpha≥8）—— **实测冻结**。
 *
 * 这些数字是从入库素材算出来的，不是拍的：换素材或改算法后必须重算
 * （烘焙器与门禁都会比，偏差 >0.05/通道即红）。
 *
 * ⚠️ purpur 的均值比 vanilla `purpur_block`（169.92/125.92/169.68）**暗一档** ——
 * 那是用户指定图的配色，刻意保留（用户原话「面用的图是这张」）。
 */
export const STONE_BRICK_TARGET_MEAN = Object.freeze({
  mossy_stone_bricks: Object.freeze([113.0703, 118.6523, 103.0078]),
  cracked_stone_bricks: Object.freeze([115.8789, 115.2148, 115.8789]),
  chiseled_stone_bricks: Object.freeze([117.3125, 116.4375, 117.3125]),
  purpur_block: Object.freeze([135.5273, 100.3398, 135.2891]),
});

/** 源图完整路径 */
export function stoneBrickSourcePath(name) {
  return path.join(STONE_BRICKS_SRC_DIR, STONE_BRICK_TEXTURES[name].source);
}
/** 参考渲染图完整路径（texel 模式返回 null） */
export function stoneBrickReferencePath(name) {
  const ref = STONE_BRICK_TEXTURES[name].reference;
  return ref ? path.join(STONE_BRICKS_REF_DIR, ref) : null;
}
/** 产物完整路径 */
export function stoneBrickOutputPath(name) {
  return path.join(STONE_BRICKS_OUT_DIR, STONE_BRICK_TEXTURES[name].out);
}
/** 产物在 atlas 里的 tile 名（build-atlas 用相对 assets/textures/ 的路径作键） */
export function stoneBrickTileName(name) {
  return STONE_BRICK_TEXTURES[name].out.replace(/\.png$/, '');
}

/** 文件 sha256 */
export function fileSha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * 输入指纹：源图字节 + 参考图字节 + 全部烘焙参数 + 目标均值。
 *
 * ⚠️ **参考渲染图必须进指纹**：它决定产物配色，换了它而不重烘 = 静默过期。
 * ⚠️ **`TOP_FACE_GEOM` 与 `PURPUR_DOWNSAMPLE` 必须进指纹**：它们是取样相位，
 * 改了它们产物图案会整体错位，而尺寸/色数可能看着正常。
 *
 * 已知盲区（与既有烘焙产物同口径）：只改**算法实现**而不动参数/素材时指纹不变 ——
 * 那类回归靠「图案分区签名」与「众数一致性」两条内容级判据兜住。
 */
export function stoneBricksInputFingerprint() {
  const parts = [`tile:${STONE_BRICK_TILE_SIZE}`, `geom:${JSON.stringify(TOP_FACE_GEOM)}`,
    `purpur:${JSON.stringify(PURPUR_DOWNSAMPLE)}`];
  const sources = {};
  for (const [name, def] of Object.entries(STONE_BRICK_TEXTURES)) {
    const src = stoneBrickSourcePath(name);
    const sha = fs.existsSync(src) ? fileSha256(src) : 'missing';
    sources[name] = sha;
    let part = `${name}:${def.source}:${def.out}:${def.mode}:${sha}`;
    const ref = stoneBrickReferencePath(name);
    if (ref) {
      const refSha = fs.existsSync(ref) ? fileSha256(ref) : 'missing';
      sources[`${name}:reference`] = refSha;
      part += `:ref=${def.reference}:${refSha}`;
    }
    part += `:mean=${STONE_BRICK_TARGET_MEAN[name].join(',')}`;
    parts.push(part);
  }
  return {
    input: crypto.createHash('sha256').update(parts.join('|')).digest('hex'),
    sources,
  };
}