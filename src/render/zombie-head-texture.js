// src/render/zombie-head-texture.js — 丧尸头部马赛克纹理加载（M6 遗留 TODO）
//
// **主线程专用**：运行时加载纹理必然依赖 three。分层归属 `render/`（不在
// `tools/check-architecture.mjs` 的 `ISOMORPHIC_DIRS` 里 → 天然不受同构检查，
// 无需白名单条目；对比 `mesh/atlas-loader.js` 因历史放在 `mesh/` 才需要白名单）。
//
// 产物由 `tools/bake-zombie-head.mjs` 离线烘焙（`npm run zombie`），图案参数权威在
// `tools/zombie-head-fingerprint.mjs`。纹理是双区并排 128×64：左半无眼睛 / 右半有眼睛 ——
// 分面靠 **head 几何的 UV 分区**（`zombie-renderer.js`），不是材质数组。
import * as THREE from 'three';

/**
 * @returns {Promise<THREE.Texture>} 128×64 双区纹理（左半无眼睛 / 右半有眼睛）
 */
export async function loadZombieHeadTexture() {
  // 绝对路径：fixture 页在 /src/tests/ 下，相对路径会解析成 /src/tests/assets/* → 404
  // （与 atlas-loader.js 同一踩坑记录）
  const texture = await new THREE.TextureLoader().loadAsync('/assets/zombie/head.png');
  texture.colorSpace = THREE.SRGBColorSpace; // mc-lite `createMosaicTexture` 同口径
  // 马赛克是像素风图案：nearest 采样保持硬边（mc-lite 同口径）。不开 mipmap ——
  // 丧尸只有 0.6 格大且总在近处，远处看不见，开了反而模糊马赛克边界
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  // wrap 保持默认 ClampToEdge：UV 严格落在 [0,0.5] / [0.5,1] 内，不需要重复采样
  return texture;
}
