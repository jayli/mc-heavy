// src/render/zombie-skin-texture.js — 丧尸全身皮肤（标准 64×64 版式）纹理加载
//
// **主线程专用**：运行时加载纹理必然依赖 three。分层归属 `render/`（不在
// `tools/check-architecture.mjs` 的 `ISOMORPHIC_DIRS` 里 → 天然不受同构检查）。
//
// 产物由 `tools/bake-zombie-skin.mjs` 离线烘焙（`npm run zombieskin`），版式与配色的权威在
// `tools/zombie-skin-fingerprint.mjs`（+ re-export 的 `src/render/zombie-model.js` 的 UV 表）。
//
// **一张皮肤管全身**：六个部件共用同一个 `THREE.Texture` 实例，各自一个 `MeshBasicMaterial`
// （`map` 指向同一个纹理）→ 只有一份 GPU 上传。分面靠 **每面 UV 矩形**（`ZOMBIE_SKIN_UV`），
// 不是材质数组 —— WebGPU 后端的 `getMaterial()` 不遍历 `geometry.groups`（见 renderer 文件头）。
import * as THREE from 'three';
import { resourceUrl } from '../core/resource-url.js';

/**
 * @returns {Promise<THREE.Texture>} 64×64 标准皮肤（六面各自的 UV 矩形由渲染层给）
 */
export async function loadZombieSkinTexture() {
  // 部署路径无关（v1.87）：走 resourceUrl，仓库挂子路径部署也不 404。
  const texture = await new THREE.TextureLoader().loadAsync(resourceUrl('assets/zombie/skin.png'));
  texture.colorSpace = THREE.SRGBColorSpace; // 与烘焙时的 sRGB 口径一致
  // 像素风图案：nearest 采样保持硬边（眼睛/衣服分界是 1px 尺度，线性采样会糊掉）。
  // 不开 mipmap —— 丧尸只有 0.5 格宽且总在近处，远处看不见，开了反而模糊五官。
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  // wrap 保持默认 ClampToEdge：UV 严格落在各自矩形内，不需要重复采样
  return texture;
}
