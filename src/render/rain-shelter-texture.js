// src/render/rain-shelter-texture.js — 遮挡高度图的 GPU 封装（**依赖 three**）
//
// ⚠️ 本文件 import three ⇒ 必须放 `render/`，**不能放 `voxel/`**（红线 8/10：
// Worker 同构层禁止 three 依赖，`check:arch` 静态门会抓）。
// 数据与编码的唯一权威在 `voxel/rain-occlusion-data.js`（那一层才是 three-free 的）。
//
// ## 为什么走模块级单例
//
// 照 `WET_SURFACE_UNIFORMS` 同一手法：`wet-surface.js` 直接 import 本单例
// ⇒ **不改 `RenderWorld` / `createVoxelMaterials` 的构造签名**，也不依赖装配顺序。
// 反射 pass 的替身材质重建时同样拿到**同一份**纹理（它不是构造参、也不是 RT）
// ⇒ RT 里的干湿分布与主画面一致，无读写冲突。
//
// ## 构造配方（已实测 PASS，不得凭直觉改）
//
// 一次性探针实测：`copyTextureToBuffer` 读回的原始字节与 CPU 写入**逐位相同**
// （三种 colorSpace 下均如此 ⇒ 数据纹理不被 sRGB 解码）；片元 `textureLoad`
// 取回 64/64 texel 三通道全对，零 GPU 验证错误。
// ⚠️ `textureLoad` 在 vendor 里 = `texture(...).setSampler(false)` ⇒ **它自己关采样器**，
// 直接喂普通 `DataTexture` 即可，不需 `storageTexture`、不需 `unwrap`。
import * as THREE from 'three';
import { SHELTER_MAP_SIZE } from '../voxel/rain-occlusion-data.js';

/**
 * 遮挡高度图单例（512×512 RGBA8 = 1 MiB）。
 *
 * 初值**全 0** = 全窗未知 = 不遮挡 ⇒ 未接线时逐位等于改动前。
 * ⚠️ `flipY` 显式写死 false：WebGPU 的 `isFlipY()` 恒 false，但 three 上传时
 * 仍按 `texture.flipY` 决定是否翻面 —— 不写死会在将来翻行（本轮探针踩过行错位的坑）。
 * ⚠️ Nearest 而非 Linear：高度场插值会在屋檐边缘产生「半湿」渐变带，
 * 且相邻列高度差可达十几格 ⇒ 插出来的中间高度是**物理上不存在的面**。
 */
export const SHELTER_TEXTURE = new THREE.DataTexture(
  new Uint8Array(SHELTER_MAP_SIZE * SHELTER_MAP_SIZE * 4),
  SHELTER_MAP_SIZE, SHELTER_MAP_SIZE,
  THREE.RGBAFormat, THREE.UnsignedByteType,
);
SHELTER_TEXTURE.flipY = false;
SHELTER_TEXTURE.generateMipmaps = false;
SHELTER_TEXTURE.minFilter = THREE.NearestFilter;
SHELTER_TEXTURE.magFilter = THREE.NearestFilter;
SHELTER_TEXTURE.wrapS = THREE.ClampToEdgeWrapping;
SHELTER_TEXTURE.wrapT = THREE.ClampToEdgeWrapping;
SHELTER_TEXTURE.needsUpdate = true;

/**
 * 把 map 的字节送进单例。
 *
 * ⚠️ **只在真的重扫过 ≥1 column 时调用**（静止世界零上传）；
 * ⚠️ **必须早于本帧所有 render pass**（反射 / 阴影 / 主）—— 它是模块级单例，
 * pass 中途更新会让同一帧内不同 pass 读到不同版本 ⇒ 主画面与 RT 干湿不一致。
 *
 * @param {Uint8Array} data `RainShelterMap.data`
 */
export function uploadShelterTexture(data) {
  SHELTER_TEXTURE.image.data.set(data);
  SHELTER_TEXTURE.needsUpdate = true;
}