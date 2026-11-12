// src/mesh/atlas-loader.js — atlas 运行时加载（设计文档 §4.4.1）
import * as THREE from 'three';
import { resourceUrl } from '../core/resource-url.js';

/**
 * atlas 的 gutter（px）。**必须与 `tools/build-atlas.mjs` 的 GUTTER 一致** ——
 * 它决定 mip 链能安全降到多深（见 `SAFE_MAX_MIP`）。
 */
export const ATLAS_GUTTER = 16;

/**
 * mip 链的安全上限（最深 mip 的 index）。
 *
 * ## 为什么必须截断（v2.95 修复「远处方块出现异物纹理」）
 *
 * 每个 mip 级把 texel 放大 2 倍，gutter 的 texel 数随之减半。gutter 不足 1 texel 时，
 * 双线性插值必然把**邻 tile** 的颜色混进来 —— 而 atlas 里相邻两个 tile 可能色相完全无关
 * （实测：`procedural/sky_wood` rgb(219,159,219) 洋红，只隔 16px 就挨着
 * `procedural/swamp_grass_top` rgb(75,93,52) 深绿）。
 *
 *   安全 mip 上限 = floor(log2(gutter))      // gutter/2^m >= 1 texel
 *   16px gutter → mip 4（此时 gutter 恰剩 1 texel，atlas 已降到 128×128）
 *
 * 而 2048² 的 atlas 自动生成 **12 级**（0~11）→ 越界 7 级。那些级别在远处被选中时，
 * 画面就会出现横向暗纹 / 邻色斑点，且**走近就消失**（近距离回到 mip 0~3）。
 *
 * ⚠️ **为什么不是「截断会丢远处细节」**：用到 mip 4 时，1 texel 覆盖 16 原图像素 =
 * 恰好整个 16px tile，此时方块在屏幕上本就只有约 1 像素 —— 没有细节可丢。代价只是
 * 极远处少了 mip 5+ 的平均（轻微闪烁），远好于确定性渗色。
 *
 * ⚠️ **`texture.anisotropy = 8` 在本仓是死设置，不要指望它来救**：three 的 WebGPU 后端
 * （`vendor/three/three.webgpu.js:76441`）只在 magFilter/minFilter/mipmapFilter **三者全为
 * Linear** 时才把 anisotropy 写进 sampler descriptor。本仓 `magFilter = NearestFilter`
 * （保像素风）⇒ 该值从未生效，采样足迹就是纯双线性的 2×2。
 */
export const SAFE_MAX_MIP = Math.floor(Math.log2(ATLAS_GUTTER));

/** 预生成 mip 链的级数 = 最深 index + 1 */
export const SAFE_MIP_LEVELS = SAFE_MAX_MIP + 1;

/**
 * 从源图逐级生成 mip 链（box filter，2×2 平均），最多 `levels` 级。
 *
 * ## 为什么用 `texture.mipmaps` 而不是别的截断手段
 *
 * three 的 `WebGPUTextureUtils.getMipLevels()`（vendor:34470）**优先用
 * `texture.mipmaps.length` 决定 mip 级数**：
 *
 *     if ( texture.mipmaps.length > 0 ) mipLevelCount = texture.mipmaps.length;
 *     else mipLevelCount = floor(log2(max(w,h))) + 1;      // ← 12 级，越界
 *
 * 所以喂入一个更短的预生成链就能把链截断，且**仍然保留自动 LOD**（`LinearMipmapLinearFilter`
 * 正常工作，GPU 采到最后一层就是最深）。这是材质侧做不到的：
 * `texture(tex, uv, levelNode)` 会走 `textureSampleLevel` 完全接管 LOD（远处莫尔纹回来），
 * `biasNode` 只能加性偏移、无法钳制上限。
 *
 * @param {HTMLImageElement} image 源图（atlas.png）
 * @param {number} levels 目标级数（含第 0 级）
 * @returns {Array<{data: Uint8Array, width: number, height: number}>} mip 1..levels-1
 */
export function buildMipChain(image, levels) {
  const src = document.createElement('canvas');
  src.width = image.width;
  src.height = image.height;
  const srcCtx = src.getContext('2d', { willReadFrequently: true });
  srcCtx.drawImage(image, 0, 0);
  let prev = srcCtx.getImageData(0, 0, src.width, src.height);

  // ⚠️ **数组必须包含 base level（第 0 级 = 源图本身）**：
  // three 的注释（vendor:34265）明写「Normal textures ... define **base level + mips**
  // with their mipmap array」，因此 `texture.mipmaps.length` 就是**总级数**（含第 0 级）。
  // 只放降采样层会让数据整体错位一级 → 实测画面变成全黑剪影
  // （这是「单元测试全绿、静态门禁全绿、只有实拍能发现」的第二形态）。
  const out = [src];   // 第 0 级：源图 canvas
  for (let level = 1; level < levels; level++) {
    const w = Math.max(1, prev.width >> 1);
    const h = Math.max(1, prev.height >> 1);
    // ⚠️ 用 canvas 的 `createImageData` 而不是 `new ImageData(w,h)`：
    // 后者在 eslint 的 Node 环境 globals 里未声明（`no-undef` 报错），
    // 而 `createImageData` 走已有的 ctx、不引入新的全局依赖。
    const dst = srcCtx.createImageData(w, h);
    const sp = prev.data, dp = dst.data;
    const sw = prev.width;
    // box filter：2×2 平均（与 GPU 生成 mip 的口径一致）
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i00 = ((y * 2) * sw + x * 2) << 2;
        const i10 = i00 + 4;
        const i01 = ((y * 2 + 1) * sw + x * 2) << 2;
        const i11 = i01 + 4;
        const di = (y * w + x) << 2;
        for (let c = 0; c < 4; c++) {
          dp[di + c] = (sp[i00 + c] + sp[i10 + c] + sp[i01 + c] + sp[i11 + c]) >> 2;
        }
      }
    }
    // ⚠️ **必须回写成 ImageData/canvas 形态，不能只给 `{data, width, height}`**：
    // `TextureLoader` 加载的是普通 Texture（不是 DataTexture），其 mipmap 走
    // `_copyImageToTexture`（vendor:76965 分支），期望的是**可被 drawImage 消费的图像
    // 对象**；喂原始 Uint8Array 会让 `_copyBufferToTexture` 的假设落空 → 整片地形变黑
    // （实测过：截断后画面全黑剪影，而 mipmaps 长度断言仍全绿 —— 又一个「数据对、渲染错」）。
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').putImageData(dst, 0, 0);
    out.push(c);
    prev = dst;
  }
  return out;
}

/**
 * @param {{mipmap?: boolean}} [opts] blur 档位（§4.4.1）：mipmap=true 时远处三线性
 *        平均消除莫尔纹（gutter 内缩 + mip 链截断防渗色）；默认 false 像素风。
 * @returns {Promise<{texture: THREE.Texture, tileRect: (name: string) => {u0:number,v0:number,u1:number,v1:number}}>}
 */
export async function loadAtlas({ mipmap = false } = {}) {
  const [meta, texture] = await Promise.all([
    // 部署路径无关（v1.87）：`resourceUrl` 相对本仓模块的 import.meta.url 解析，
    // 根路径与子路径部署都对。旧写法是根绝对路径 `'/assets/atlas.json'` —— fixture 页
    // 在 /src/tests/ 下时躲开了「相对文档基址」的坑，但仓库挂子路径部署时会 404。
    fetch(resourceUrl('assets/atlas.json')).then((r) => r.json()),
    new THREE.TextureLoader().loadAsync(resourceUrl('assets/atlas.png')),
  ]);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter; // 近处恒像素风
  if (mipmap) {
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter; // blur 档（§4.4.1）
    // ⚠️ 保留 anisotropy 设置（与上游 mc-lite 口径一致），但它在本仓不生效 ——
    // 原因见 SAFE_MAX_MIP 的注释（magFilter=Nearest 时 three 不写 maxAnisotropy）。
    // 保留而不是删掉：若将来改 magFilter 为 Linear，这个值会立刻起作用。
    texture.anisotropy = 8;
    // ★ 关键：喂入预生成的**限深** mip 链 → three 的 getMipLevels() 用它定级数，
    // 从而把链截到 SAFE_MIP_LEVELS 级（见 SAFE_MAX_MIP 的推导）。
    // 这一步是「远处异物纹理」的根治点：不截断就会有 7 级落在渗色区。
    texture.mipmaps = buildMipChain(texture.image, SAFE_MIP_LEVELS);
  } else {
    texture.minFilter = THREE.NearestFilter; // 默认像素风，无 mipmap（§4.4.1）
    texture.generateMipmaps = false;
  }
  // flipY 保持默认 true：build-atlas.mjs 的 v 坐标按 PNG 行序预翻转
  // （v0 = 1 - (shelfY+h)/SIZE），该约定假设 flipY=true（v=0 在图像底部）。
  // 曾误设 flipY=false 导致所有 tile 采样到垂直镜像位置（黑色 gutter）——
  // M0 atlas 测试只校验 image.width/u1>u0 未暴露，Task 7 真实渲染才发现。

  const rects = new Map();
  for (const [name, t] of Object.entries(meta.tiles)) {
    rects.set(name, { u0: t.u0, v0: t.v0, u1: t.u1, v1: t.v1 });
  }
  return {
    texture,
    tileRect(name) {
      const r = rects.get(name);
      if (!r) throw new Error(`unknown atlas tile: ${name}`);
      return r;
    },
  };
}
