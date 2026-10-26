// src/mesh/atlas-loader.js — atlas 运行时加载（设计文档 §4.4.1）
import * as THREE from 'three';
import { resourceUrl } from '../core/resource-url.js';

/**
 * @param {{mipmap?: boolean}} [opts] blur 档位（§4.4.1）：mipmap=true 时远处三线性
 *        平均消除莫尔纹（2px gutter + 半 texel 内缩防渗色）；默认 false 像素风。
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
    // 各向异性：atlas tile 内 UV wrap 使接缝处单方向导数尖峰，isotropic lod 会取
    // 较大者 → 边界像素采样跨 tile 平均色（粉灰方格线）。aniso 的 lod 基于较小导数，
    // 尖峰消除；取值 8 与 build-atlas 的 16px gutter/8px bleed 配套（尖峰足迹半长 ≤8 texel）。
    texture.anisotropy = 8;
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
