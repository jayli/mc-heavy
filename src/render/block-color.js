// src/render/block-color.js — 命中特效的「按方块材质取色」（主线程，含 canvas 采样）
//
// 命中特效的碎块颜色取自**该方块命中那一面**在 atlas 里的真实像素，
// 而不是一张通用碎屑图 —— 这是它与 mc-lite `block_crash.png`（灰渣）的根本区别：
// 打石头出灰、打草出绿、打木头出棕，且贴着方块自己的纹理。
//
// 三个易错点（都有单测钉住，`test-block-color.js`）：
//   ① **面索引顺序是载荷性的**：0:+X 1:-X 2:+Y 3:-Y 4:+Z 5:-Z，与 `mesher.js` 的
//      `FACE_DIRS` / packed bit10-12 同序。映射错了特效照常播，只是颜色微妙地不对。
//   ② **必须在 sRGB 空间平均**：atlas 是 sRGB 图像，直接对 0-255 求平均等于线性空间平均，
//      结果整体偏亮。做法是先转线性、再平均、再转回 sRGB（three 的 `Color` 工作空间是线性的，
//      所以最终返回的其实是**线性**色，见 `averageTileColor`）。
//   ③ **全透明像素不参与**：叶片/花的 tile 大量镂空，算进去会把平均色拉向图集底色。
//
// 归属 `render/`：运行时构造像素缓冲必然依赖 DOM（canvas），与 `atlas-loader.js` 同性质，
// 不在 `tools/check-architecture.mjs` 的 `ISOMORPHIC_DIRS` 里，无需白名单。
import { FACES_DATA } from '../voxel/faces-data.js';

/** 全透明 / 未知 tile 的兜底色（sRGB 中灰）——退回「石头灰」，碎块不会变成看不见的黑块 */
const FALLBACK_SRGB = [0.5, 0.5, 0.5];

/**
 * 面法线 → 面索引（与 mesher 的 `FACE_DIRS` 同序）。
 * 异常/缺失法线退回顶面（2）—— 顶面是最常见的可见面，且绝不返回 -1 让下游静默取错。
 * @param {number[]|null} normal @returns {number} 0..5
 */
export function faceIndexFromNormal(normal) {
  if (!normal) return 2;
  const [x, y, z] = normal;
  if (x > 0) return 0;
  if (x < 0) return 1;
  if (y > 0) return 2;
  if (y < 0) return 3;
  if (z > 0) return 4;
  if (z < 0) return 5;
  return 2;
}

/**
 * 方块某面的 atlas tile 名。未知方块 / 该面为 null → `'stone'`（兜底同 `getFaceTile`）。
 * @param {string} blockName @param {number} faceIdx
 */
export function tileForBlockFace(blockName, faceIdx) {
  const entry = FACES_DATA[blockName];
  if (!entry) return 'stone';
  if (typeof entry === 'string') return entry;
  const tile = entry[faceIdx];
  return tile ?? 'stone';
}

/** sRGB（0..1）→ 线性（three 的 `Color` 工作空间） */
export function srgbToLinear(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** 线性（0..1）→ sRGB（0..1） */
export function linearToSrgb(v) {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/**
 * 一个 tile 的平均色（返回**线性** RGB，可直接喂 `THREE.Color.setRGB(r,g,b)` 默认工作空间）。
 *
 * @param {{width:number, height:number, data:Uint8ClampedArray|Uint8Array}} atlasPixels
 *        整幅 atlas 的 RGBA 像素（`ctx.getImageData` 的结果）
 * @param {{tiles: Record<string, {x:number,y:number,w:number,h:number}>}} atlasMeta
 * @param {string} tileName
 * @returns {number[]} 线性 [r,g,b]，三分量恒有限
 */
export function averageTileColor(atlasPixels, atlasMeta, tileName) {
  const tile = atlasMeta?.tiles?.[tileName];
  if (!tile || !atlasPixels) return FALLBACK_SRGB.map(srgbToLinear);
  const { data, width, height } = atlasPixels;
  let sr = 0; let sg = 0; let sb = 0; let n = 0;
  const x1 = Math.min(tile.x + tile.w, width);
  const y1 = Math.min(tile.y + tile.h, height);
  for (let y = Math.max(tile.y, 0); y < y1; y++) {
    for (let x = Math.max(tile.x, 0); x < x1; x++) {
      const o = (y * width + x) * 4;
      const a = data[o + 3];
      if (a < 8) continue;   // 全透明 / 近全透明（描边抗锯齿）不参与
      // 在 sRGB 空间累加 → 最后转线性（等价于「sRGB 平均」，见文件头 ②）
      sr += data[o];
      sg += data[o + 1];
      sb += data[o + 2];
      n++;
    }
  }
  if (n === 0) return FALLBACK_SRGB.map(srgbToLinear);
  return [
    srgbToLinear(sr / n / 255),
    srgbToLinear(sg / n / 255),
    srgbToLinear(sb / n / 255),
  ];
}

/**
 * 构造 `(blockName, normal) => linearRGB` 解析器，内部按 `tile名` 缓存（每 tile 只扫一次像素）。
 *
 * @param {{atlasPixels: {width:number,height:number,data:Uint8ClampedArray|Uint8Array},
 *          atlasMeta: object, faces?: Record<string, string|(string|null)[]>}} deps
 *        `faces` 可注入（测试用）；缺省读 `FACES_DATA` 这一单一权威。
 * @returns {(blockName: string, normal: number[]|null) => number[]}
 */
export function createBlockColorResolver({ atlasPixels, atlasMeta, faces = FACES_DATA }) {
  const cache = new Map();
  return function resolve(blockName, normal) {
    const faceIdx = faceIndexFromNormal(normal);
    const entry = faces?.[blockName];
    const tile = !entry ? 'stone'
      : typeof entry === 'string' ? entry
      : (entry[faceIdx] ?? 'stone');
    let color = cache.get(tile);
    if (!color) {
      color = averageTileColor(atlasPixels, atlasMeta, tile);
      cache.set(tile, color);
    }
    return color;
  };
}

/**
 * 从已加载的 atlas 纹理读回像素（`TextureLoader` 的 image 是 HTMLImageElement）。
 * 用 canvas 而不是 `createImageBitmap`：需要同步拿到 `ImageData`，且读一次即缓存。
 *
 * @param {HTMLImageElement|ImageBitmap} image @returns {{width:number,height:number,data:Uint8ClampedArray}}
 */
export function readAtlasPixels(image) {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, image.width, image.height);
}

/**
 * 便捷入口：从 atlas 纹理 + meta 构造解析器（`game.js` 用法）。
 * @param {{texture: {image: any}, atlasMeta: object}} deps
 */
export function createAtlasColorResolver({ texture, atlasMeta }) {
  const image = texture?.image;
  if (!image) return () => FALLBACK_SRGB.map(srgbToLinear);
  return createBlockColorResolver({
    atlasPixels: readAtlasPixels(image),
    atlasMeta,
  });
}
