// src/render/turret-armor-texture.js — 加载烘焙的炮塔装甲纹理（多区并排）
// 照 `zombie-head-texture.js` 同手法：主线程专用（运行时加载纹理必然依赖 three）。
// 加载失败返回 null → 渲染层退回纯色（单测 fixture 不需纹理也能跑；
// 玩家侧也只是「炮塔没有装甲贴图」而非崩溃，与 M4 武器模型同一容错口径）。
import * as THREE from 'three';

/** @returns {Promise<THREE.Texture|null>} */
export async function loadTurretArmorTexture() {
  try {
    const texture = await new THREE.TextureLoader().loadAsync('/assets/turret/armor.png');
    texture.magFilter = THREE.NearestFilter;   // mc-lite `NearestFilter` 同口径（保像素风）
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  } catch (err) {
    console.warn('[turret-armor] texture load failed:', err);
    return null;
  }
}
