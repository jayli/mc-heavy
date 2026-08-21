// src/render/materials.js — TSL 体素材质（顶点阶段 shade + atlas 采样 + 雾）
// r185.1 TSL：attribute('packed','uint') 读自定义顶点属性；位运算 bitAnd/shiftRight 已核验可用。
//
// AO/light 渐变的关键：shade 必须在【顶点阶段】算成 float，经 float varying 传到片元，
// GPU 才会双线性插值出平滑渐变。若直接在片元读 uint 属性，three.webgpu.js:65404 对
// int 类型 varying 强制加 `flat` 限定符 → 每三角形一个常量值 → 无色块间渐变
// （这正是"看不到 AO 渐变"的根因）。mc-lite AONodeSystem.js:140 同款机制
// （vAo = varying(vertexStage(aoComputed))）。
import * as THREE from 'three';
import {
  texture, attribute, float, vec4, mul, max,
  rangeFogFactor, uniform, fog,
  varying, vertexStage,
} from 'three/tsl';

// ---- 顶点阶段 shade（light × AO），float varying 传片元 ----
// packed 属性解包：bit0-7 light（sky<<4|block），bit8-9 AO
const packed = attribute('packed', 'uint');
const lightByte = packed.bitAnd(0xFF);
// 日夜调制（M2-6）：uSkyDim 黑夜压暗 skylight，uBlockBoost 黑夜相对增强 blocklight
const uSkyDim = uniform(1.0);
const uBlockBoost = uniform(1.0);
const sky = float(lightByte.shiftRight(4)).div(15).mul(uSkyDim);
const block = float(lightByte.bitAnd(0xF)).div(15).mul(uBlockBoost);
const brightness = max(sky, block);
const ao = float(packed.shiftRight(8).bitAnd(3));
// AO 曲线（mc-lite AONodeSystem.js:129 口径）：ao=3（开阔）→1.0，ao=0（墙角）→0.1
const aoFactor = float(1).sub(float(3).sub(ao).div(3).mul(0.9));
// 逐顶点最终亮度 = light × AO（Minecraft 原版即逐顶点算最终亮度再插值），float varying
const vShade = varying(vertexStage(mul(brightness, aoFactor)), 'vShade');

/**
 * 创建三通道体素材质。
 * @param {THREE.Texture} atlasTexture
 * @returns {{opaque: THREE.MeshBasicNodeMaterial, cutout: THREE.MeshBasicNodeMaterial, transparent: THREE.MeshBasicNodeMaterial}}
 */
export function createVoxelMaterials(atlasTexture) {
  const makeMaterial = ({ alphaTest = 0, transparent = false, side = THREE.FrontSide }) => {
    const mat = new THREE.MeshBasicNodeMaterial();
    const uvNode = attribute('uv', 'vec2');
    const texColor = texture(atlasTexture, uvNode);
    mat.colorNode = vec4(mul(texColor.rgb, vShade), texColor.a);
    if (alphaTest > 0) { mat.alphaTest = alphaTest; }
    if (transparent) { mat.transparent = true; mat.depthWrite = false; }
    mat.side = side;
    return mat;
  };

  return {
    opaque: makeMaterial({}),
    // 树叶/cross 植被双面可见（mc-lite 口径）
    cutout: makeMaterial({ alphaTest: 0.5, side: THREE.DoubleSide }),
    transparent: makeMaterial({ transparent: true }),
    dayNight: { uSkyDim, uBlockBoost },
  };
}

/** 场景雾（与视距联动，§4.4.3 简化版：M1 固定雾距，M2 接日夜）
 *  r185.1 语义：`fog(color, factor)` 返回 vec4 混合节点，
 *  factor = rangeFogFactor(near, far)（0=无雾 1=全雾），赋给 scene.fogNode 即生效。 */
export function setupFog(scene, viewDistance) {
  // 雾距与相机 far / 世界加载半径联动（避免边缘 pop-in）：
  // 世界加载半径 = (viewDistance+2)*16（滞回 +2），雾在加载边缘前完成（0.95 系数），
  // 相机 far 覆盖对角线（1.5 > sqrt2）。近景（< 0.75*vd*16）保持清晰。
  const fogNear = uniform(viewDistance * 16 * 0.75);
  const fogFar = uniform((viewDistance + 2) * 16 * 0.95);
  const fogColor = uniform(new THREE.Color(0x87ceeb));
  scene.fogNode = fog(fogColor, rangeFogFactor(fogNear, fogFar));
  return { fogNear, fogFar, fogColor };
}
