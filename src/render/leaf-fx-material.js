// src/render/leaf-fx-material.js — 森林落叶的 TSL 材质与实例几何（v3.26）
//
// 设计：docs/superpowers/specs/2026-11-20-forest-leaves-and-fireflies-design.md §4.1
//
// 单色小叶片（**无贴图**，用户明确要求）从树冠高度带飘落：匀速下落 + 水平摆荡（风）
// + 三轴自转（翻飞），落地即钳住并淡出。运动全在顶点着色器，CPU 只写出生属性与淡出系数。
//
// ## 七条 TSL 口径（每条都有实测依据，违反任一都是「非像素判据全绿而画面全错」）
//
//   ① 粒子必须 `THREE.Mesh` + `InstancedBufferGeometry`，**禁 InstancedMesh**
//      （instanceMatrix 接管 modelViewMatrix ⇒ 由 aOrigin 定位的粒子全塌到原点，v3.21 实测）；
//   ② 世界摆放走 `vertexNode`（`positionNode` 的返回值会被 `modelViewMatrix` 再乘一次）；
//   ③ 逐实例参数走 instanced attribute + `varyingProperty`（片元读不到 instanced 属性）；
//   ④ 节点不得与裸 JS 数字算术（`float(x)*1.4` 生成 `NaN.0`），一律 `.mul()`；
//   ⑤ 多层 mix 嵌套，不得链式 `.mix()`（v3.21 实测暖色像素 78620→88）；
//   ⑥ `Fn` 不返回多键对象（SplitNode 陷阱：自定义键全 undefined ⇒ 整片 pass 不上屏）；
//   ⑦ uniform 按调用闭包捕获，禁模块级 `let U`（TSL `Fn` 体惰性求值，v3.22 两池互相覆写）。
//
// ⚠️⚠️ **落叶与萤火虫的空间口径刻意不同**：落叶是**世界轴向的翻转薄片**
// ⇒ 局部偏移必须在**世界空间**与中心相加，再一次性进视图；萤火虫是**屏幕对齐光点**
// ⇒ 在 centerView 上加 corner 才对（见 firefly-fx-material.js）。照抄任一侧到另一侧都会错。
//
// ⚠️ **昼夜亮度直接引用体素那两个 uniform 实例**（红线 1，同 turret-metal 复用
// `dayNight.uSunDirection` 的手法）：白天逐位乘 1（零回归）、夜里自动跟着体素变暗。
// 句柄缺失（fixture 路径）时退化为常量 1。
//
// **主线程专用**：NodeMaterial / BufferGeometry 必然依赖 three。归属 `render/`。
import * as THREE from 'three';
import {
  Fn, float, vec3, vec4, uniform, attribute, varyingProperty,
  cameraProjectionMatrix, modelViewMatrix, positionGeometry,
  abs, cos, sin, mix, max, min, rotate, Discard,
} from 'three/tsl';
import { LEAF_FX } from './ambient-fx-config.js';

/**
 * 逐实例属性名。**几何与材质共用这一份字面量**（各写一次会漂移成静默失效）。
 *
 * 每个属性答什么问题：
 *   aOrigin  出生点 (x,y,z)
 *   aParams  (minY, fallSpeed) —— 落地高度与下落速度
 *   aSway    (amp, freq, phase) —— 水平摆荡
 *   aSpin    (spinX, spinY, spinZ) —— 三轴自转角速度
 *   aColor   线性 RGB（来自既有 atlas resolver 的秋色抽签）
 *   aSize    叶片边长（格）
 *   aLife    vec2 = (born, alpha) —— born 是出生**绝对秒**（与 uTime 同一时钟），
 *            alpha 是 CPU 每帧写的淡出系数（落地后 1→0）
 *
 * ⚠️⚠️ **born 与 alpha 必须合成一个 vec2，不得各占一个属性**（本轮浏览器实测）：
 * WebGPU 的 `maxVertexBuffers` 是 **8**，而 position + 8 个逐实例属性 = **9**
 * ⇒ `Vertex buffer count (9) exceeds the maximum number of vertex buffers (8)`
 * ⇒ render pipeline 创建失败、**整池零像素**，而 visible / count / 属性值全对（静默失效）。
 */
export const LEAF_ATTR = Object.freeze({
  origin: 'aOrigin',
  params: 'aParams',
  sway: 'aSway',
  spin: 'aSpin',
  color: 'aColor',
  size: 'aSize',
  life: 'aLife',
});

/** 属性名 → itemSize（几何工厂的唯一口径） */
const LEAF_ATTR_SIZE = Object.freeze({
  [LEAF_ATTR.origin]: 3,
  [LEAF_ATTR.params]: 2,
  [LEAF_ATTR.sway]: 3,
  [LEAF_ATTR.spin]: 3,
  [LEAF_ATTR.color]: 3,
  [LEAF_ATTR.size]: 1,
  [LEAF_ATTR.life]: 2,
});

/**
 * 落叶 quad + 八个逐实例属性。
 *
 * ⚠️ **`boundingSphere` 取 1e4**：几何自身在单位立方内，实际被 shader 摆到几十格外
 * ⇒ 正常包围球会让它被误剔除。渲染器另设 `frustumCulled=false` 双保险。
 *
 * 初始全部不可见（`aLife = (-1e3, 0)`）⇒ 构造后即使误置 visible 也画不出东西。
 *
 * @param {number} capacity
 * @returns {THREE.InstancedBufferGeometry}
 */
export function createLeafGeometry(capacity) {
  const cap = Math.max(1, Math.round(capacity));
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
  ]), 3));
  geometry.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));

  for (const [name, itemSize] of Object.entries(LEAF_ATTR_SIZE)) {
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(cap * itemSize), itemSize);
    attr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(name, attr);
  }
  const life = geometry.getAttribute(LEAF_ATTR.life);
  for (let i = 0; i < cap; i++) life.setXY(i, -1e3, 0);

  geometry.instanceCount = cap;
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  return geometry;
}

/**
 * 造落叶材质 + 它自己那组 uniform（**闭包捕获** ⇒ 与萤火虫池互不覆写）。
 *
 * @param {object} [deps]
 * @param {{value:number}} [deps.skyDim] 体素材质的 `uSkyDim` **实例**（缺省 → 内部常量 1）
 * @param {{value:number}} [deps.shadowStrength] 体素材质的 `uShadowStrength` **实例**
 * @returns {{material:THREE.MeshBasicNodeMaterial, uniforms:{uTime:object,uSkyDim:object,uShadowStrength:object}}}
 */
export function createLeafMaterial({ skyDim, shadowStrength } = {}) {
  const U = {
    /** 绝对秒（全局单一时钟；aBorn 与它同源） */
    uTime: uniform(0),
    // ⚠️ 传入实例原样透出（单测用 === 钉住）：自己 new 一个会让日夜变了而落叶钉在正午亮度
    uSkyDim: skyDim || uniform(1),
    uShadowStrength: shadowStrength || uniform(1),
  };

  const vColor = varyingProperty('vec3', 'vLeafColor');
  const vShade = varyingProperty('float', 'vLeafShade');
  const vAlpha = varyingProperty('float', 'vLeafAlpha');

  const vertex = Fn(() => {
    const origin = attribute(LEAF_ATTR.origin, 'vec3');
    const params = attribute(LEAF_ATTR.params, 'vec2');
    const sway = attribute(LEAF_ATTR.sway, 'vec3');
    const spin = attribute(LEAF_ATTR.spin, 'vec3');
    const col = attribute(LEAF_ATTR.color, 'vec3');
    const size = attribute(LEAF_ATTR.size, 'float');
    const life = attribute(LEAF_ATTR.life, 'vec2');

    const t = U.uTime.sub(life.x);
    // ⚠️⚠️ tEff 的 min 是载荷性的：y 钳到 minY 之后若继续摆荡/自转，读作「叶子在地上打转」
    const tLand = origin.y.sub(params.x).div(params.y);
    const tEff = min(t, tLand);

    const pos = vec3(
      origin.x.add(sway.x.mul(sin(sway.y.mul(tEff).add(sway.z)))),
      max(origin.y.sub(params.y.mul(t)), params.x),
      origin.z.add(sway.x.mul(cos(sway.y.mul(0.83).mul(tEff).add(sway.z)))),
    );
    const rot = spin.mul(tEff);

    // 屏幕尺寸硬钳（只用于算 depth 的 centerView，**不参与最终位置**）
    const centerView = modelViewMatrix.mul(vec4(pos, 1));
    const depth = max(centerView.z.negate(), float(0.05));
    const s = min(size, depth.mul(float(LEAF_FX.maxScreen).mul(1.4)));

    // ⚠️ 世界轴向的局部偏移（薄片自己翻飞，**不做 billboard**）
    const local = rotate(positionGeometry.mul(s), rot);

    // 朝向近似：翻到侧面时略暗（读作「有厚度」）。
    // ⚠️ 刻意不接体素太阳方向：自由翻转的薄片接方向光会一半时间全黑。
    vShade.assign(mix(float(LEAF_FX.sideShade), float(1), abs(cos(rot.x))));
    vColor.assign(col);
    vAlpha.assign(life.y);

    // ⚠️ 先在**世界空间**相加，再一次性进视图（把 local 加进 centerView 会随镜头转歪）
    return cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(pos.add(local), 1)));
  });

  const color = Fn(() => {
    Discard(vAlpha.lessThanEqual(0.004));
    // 昼夜：白天 uSkyDim=1 ⇒ 逐位乘 1（零回归）；夜里跟着体素变暗。
    // ⚠️ 外层 mix(1, uSkyDim, uShadowStrength)：关阴影（strength=0）时不受影区影响。
    const dim = mix(float(1), U.uSkyDim, U.uShadowStrength);
    return vec4(vColor.mul(dim).mul(vShade), vAlpha);
  });

  const material = new THREE.MeshBasicNodeMaterial();
  material.vertexNode = vertex();
  material.colorNode = color();
  material.transparent = true;
  // ⚠️ **正常混合，不是 additive**：落叶是不透明实体，additive 会让它在亮草地上消失
  material.blending = THREE.NormalBlending;
  material.depthWrite = false;
  material.depthTest = true;
  material.side = THREE.DoubleSide;   // 薄片翻到背面也要看得见
  material.fog = false;               // scene.fogNode 存在 ⇒ 不关掉远处会被雾洗成天空色
  material.lights = false;
  material.castShadow = false;        // transparent 双 false（VSM 硬约束）
  material.receiveShadow = false;
  return { material, uniforms: U };
}