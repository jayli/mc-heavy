// src/mesh/atlas-loader.js — atlas 运行时加载（设计文档 §4.4.1）
import * as THREE from 'three';

/**
 * @returns {Promise<{texture: THREE.Texture, tileRect: (name: string) => {u0:number,v0:number,u1:number,v1:number}}>}
 */
export async function loadAtlas() {
  const [meta, texture] = await Promise.all([
    // 绝对路径：fixture 页在 /src/tests/ 下，相对路径会解析成 /src/tests/assets/* → 404
    fetch('/assets/atlas.json').then((r) => r.json()),
    new THREE.TextureLoader().loadAsync('/assets/atlas.png'),
  ]);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter; // 默认像素风，无 mipmap（§4.4.1）
  texture.generateMipmaps = false;
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
