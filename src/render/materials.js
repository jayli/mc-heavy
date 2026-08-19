// src/render/materials.js — TSL 体素材质（packed 属性解包 + atlas 采样 + 雾）
// r185.1 TSL：attribute('packed','uint') 读自定义顶点属性；位运算 bitAnd/shiftRight 已核验可用。
import * as THREE from 'three';
import {
  texture, attribute, float, vec4, mul, max,
  rangeFogFactor, uniform, fog,
} from 'three/tsl';

/**
 * 创建三通道体素材质。
 * @param {THREE.Texture} atlasTexture
 * @returns {{opaque: THREE.MeshBasicNodeMaterial, cutout: THREE.MeshBasicNodeMaterial, transparent: THREE.MeshBasicNodeMaterial}}
 */
export function createVoxelMaterials(atlasTexture) {
  const makeMaterial = ({ alphaTest = 0, transparent = false }) => {
    const mat = new THREE.MeshBasicNodeMaterial();
    // packed 属性解包：bit0-7 light（sky<<4|block），bit8-9 AO
    const packed = attribute('packed', 'uint');
    const lightByte = packed.bitAnd(0xFF);
    const sky = float(lightByte.shiftRight(4)).div(15);
    const block = float(lightByte.bitAnd(0xF)).div(15);
    const brightness = max(sky, block);
    const ao = float(packed.shiftRight(8).bitAnd(3));
    const aoFactor = float(1).sub(mul(ao, 0.2)); // AO 0→1.0, 3→0.4
    const uvNode = attribute('uv', 'vec2');
    const texColor = texture(atlasTexture, uvNode);
    mat.colorNode = vec4(mul(texColor.rgb, mul(brightness, aoFactor)), texColor.a);
    if (alphaTest > 0) { mat.alphaTest = alphaTest; }
    if (transparent) { mat.transparent = true; mat.depthWrite = false; }
    mat.side = THREE.FrontSide;
    return mat;
  };

  return {
    opaque: makeMaterial({}),
    cutout: makeMaterial({ alphaTest: 0.5 }),
    transparent: makeMaterial({ transparent: true }),
  };
}

/** 场景雾（与视距联动，§4.4.3 简化版：M1 固定雾距，M2 接日夜）
 *  r185.1 语义：`fog(color, factor)` 返回 vec4 混合节点，
 *  factor = rangeFogFactor(near, far)（0=无雾 1=全雾），赋给 scene.fogNode 即生效。 */
export function setupFog(scene, viewDistance) {
  const fogNear = uniform(viewDistance * 16 * 0.5);
  const fogFar = uniform(viewDistance * 16 * 0.95);
  const fogColor = uniform(new THREE.Color(0x87ceeb));
  scene.fogNode = fog(fogColor, rangeFogFactor(fogNear, fogFar));
  return { fogNear, fogFar, fogColor };
}
