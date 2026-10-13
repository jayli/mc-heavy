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
  texture, attribute, float, vec3, vec4, mul, add, max,
  rangeFogFactor, uniform, fog,
  varying, vertexStage,
  shadow, mix,
} from 'three/tsl';

// ---- 顶点阶段 shade（light × AO），float varying 传片元 ----
// packed 属性解包：bit0-7 light（sky<<4|block），bit8-9 AO，bit13 材质自发光标记（§4.3）
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

// ---- 材质自发光（§4.3 bit13，v1.21）----
// 对齐 mc-lite `MeshStandardNodeMaterial` 的 emissive：实测 mc-lite **只有 hanging_lamp**
// 一处有材质自发光（`MaterialManager.js:1199`，`emissive:'#FFE4B5'` × `emissiveIntensity:0.8`），
// 故不能给整个通道加（会让 vine/flower/leaves 全部发光），必须按方块区分 → 顶点 bit13 传递。
// **与 blocks-data 的 `emissive:15` 是不同概念**：那是 blocklight 光照源（照亮周围方块），
// 这里是材质自身发亮。四个发光方块都有 blocklight 源，但只有 hanging_lamp 有材质自发光。
//
// 语义：three `MeshStandardMaterial` 的 emissive 是**独立加项**——不乘贴图色、不受光照/AO 影响，
// 直接加在 diffuse 之上（黑夜中灯依然发亮）。故加在 `× vShade` 之后。
// 标记是逐顶点常量（同一 quad 4 顶点同值），走 vertexStage float varying 即可，无需渐变。
const vEmissive = varying(vertexStage(float(packed.shiftRight(13).bitAnd(1))), 'vEmissive');
const EMISSIVE_COLOR = vec3(0xFF / 255, 0xE4 / 255, 0xB5 / 255); // '#FFE4B5'（暖黄色）
const EMISSIVE_INTENSITY = 0.8; // mc-lite emissiveIntensity

// ---- 太阳阴影（shadow map 接收，§4.4.4）----
// uShadowStrength = 日夜联动的阴影浓度（白天 1.0 / 夜里随 uSkyDim 淡出，DR-6）。
// 恒创建（模块顶层单例，与 uSkyDim/uBlockBoost 同口径），供 DayNight 写入；
// 即使 sunLight 为 null（fixture 路径）句柄也存在，消费方判句柄存在再写。
const uShadowStrength = uniform(1.0);

/**
 * 创建三通道体素材质。
 * @param {THREE.Texture} atlasTexture
 * @param {THREE.DirectionalLight} [sunLight] 太阳灯（传 null 时不乘 shadowFactor，保持原路径）
 * @returns {{opaque: THREE.MeshBasicNodeMaterial, cutout: THREE.MeshBasicNodeMaterial, transparent: THREE.MeshBasicNodeMaterial, dayNight: Object}}
 */
export function createVoxelMaterials(atlasTexture, sunLight = null) {
  // 阴影因子：sunLight 非 null 时 = mix(1, shadow(sunLight), uShadowStrength)。
  // shadow() 返回 0（影内）~1（影外）；uShadowStrength 缩放浓度（日夜联动）。
  // ⚠️ shadow() 第二参数是 LightShadow 实例（可选，缺省 = light.shadow），**不是** filter
  // 函数 —— PCF 滤波由 renderer.shadowMap.type 自动映射（PCFSoftShadowMap → PCFSoftShadowFilter）。
  // 误传 filter 函数会让 setupRenderTarget 读 shadow.mapSize 崩溃。故只传单参数。
  const shadowFactor = sunLight
    ? mix(float(1), shadow(sunLight), uShadowStrength)
    : null;

  const makeMaterial = ({ alphaTest = 0, transparent = false, side = THREE.FrontSide, emissive = false }) => {
    const mat = new THREE.MeshBasicNodeMaterial();
    const uvNode = attribute('uv', 'vec2');
    const texColor = texture(atlasTexture, uvNode);
    // emissive 只挂在需要的通道（hanging_lamp 走 cutout）：opaque 是最大通道，
    // 给它加一个恒为 0 的加项会白付一次逐像素 mul+add。
    // 亮度项 = texColor.rgb × vShade × shadowFactor（阴影相乘在 emissive 加项之前）。
    let rgb;
    if (emissive) {
      const base = shadowFactor
        ? mul(mul(texColor.rgb, vShade), shadowFactor)
        : mul(texColor.rgb, vShade);
      rgb = add(base, mul(EMISSIVE_COLOR, EMISSIVE_INTENSITY).mul(vEmissive));
    } else {
      rgb = shadowFactor
        ? mul(mul(texColor.rgb, vShade), shadowFactor)
        : mul(texColor.rgb, vShade);
    }
    mat.colorNode = vec4(rgb, texColor.a);
    if (alphaTest > 0) { mat.alphaTest = alphaTest; }
    if (transparent) { mat.transparent = true; mat.depthWrite = false; }
    mat.side = side;
    return mat;
  };

  return {
    opaque: makeMaterial({}),
    // cutout = FrontSide + alphaTest 0.3（mc-lite 树叶族口径：leaves 0.3/FrontSide，
    // 树冠内表面背向相机不可见 → 堆积不过密）。cross 植被与 DoubleSide 方块
    // （realistic_oak_leaves）由 mesher 双向绕线复刻双面可见，保持单材质单通道。
    // emissive: true —— hanging_lamp 的材质自发光走本通道（§4.3 bit13）。
    cutout: makeMaterial({ alphaTest: 0.3, side: THREE.FrontSide, emissive: true }),
    transparent: makeMaterial({ transparent: true }),
    dayNight: { uSkyDim, uBlockBoost, uShadowStrength },
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
