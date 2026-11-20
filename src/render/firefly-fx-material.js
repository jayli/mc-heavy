// src/render/firefly-fx-material.js — 草地萤火虫的 TSL 材质与实例几何（v3.26）
//
// 设计：docs/superpowers/specs/2026-11-20-forest-leaves-and-fireflies-design.md §4.2
//
// 稀疏的自发光小光点：三轴异频李萨如式游走（读作「乱飞」而不是绕圈）+ 三次幂呼吸闪烁，
// additive 混合，夜里更亮更密（gain 与只数由装配层按 `nightBlendOf` 派生）。
//
// ## 与落叶刻意不同的两处
//
//   ① **屏幕对齐 billboard**：局部 corner 加在 `centerView` 上（视图空间）才对；
//      落叶是**世界轴向的翻转薄片**，必须在世界空间相加（见 leaf-fx-material.js）。
//      照抄任一侧到另一侧都会错。
//   ② **AdditiveBlending**：自发光。落叶是不透明实体 ⇒ 正常混合。
//
// ## 载荷性口径（与 spike-fx-material 同源，每条都有实测依据）
//
//   · 粒子必须 `THREE.Mesh` + `InstancedBufferGeometry`（禁 InstancedMesh，v3.21）；
//   · 世界摆放走 `vertexNode`（`positionNode` 会被 modelViewMatrix 再乘一次）；
//   · 逐实例参数走 instanced attribute + `varyingProperty`（片元读不到 instanced 属性）；
//   · **常量色显式拆分量 `vec3(c.r,c.g,c.b)`**（`vec3(Color)` 在 WebGPU 输出纯黑且零报错，v3.14）；
//   · 节点不得与裸 JS 数字算术（`NaN.0`）；多层 mix 嵌套不链式；
//   · `Fn` 不返回多键对象（SplitNode 陷阱）；uniform 按调用闭包捕获；
//   · **径向量必须在片元算**：quad 只有 4 顶点，顶点算 `length()` 插值后恒为常数
//     （v3.23 实测整片 quad 一起亮再整片消失）；
//   · 光晕要有幂衰减 + quad 比可见光晕大一圈 ⇒ 几何硬边落在完全透明处
//     （v3.20b「发光鸡蛋」的既有教训）。
//
// **主线程专用**（依赖 three）。归属 `render/`。
import * as THREE from 'three';
import {
  Fn, float, vec3, vec4, uniform, attribute, varyingProperty,
  cameraProjectionMatrix, modelViewMatrix, positionGeometry,
  pow, sin, mix, smoothstep, oneMinus, clamp, max, min, step, length, Discard,
} from 'three/tsl';
import { FIREFLY_FX } from './ambient-fx-config.js';

/**
 * 逐实例属性名（几何与材质共用这一份字面量）。
 *
 *   aOrigin  出生点 (x,y,z)
 *   aAmp     三轴正弦幅度
 *   aFreq    三轴角频率（**互不相同且非整数倍** ⇒ 轨迹不闭合）
 *   aPhase   三轴相位
 *   aSizeAlive vec4 = (size, alive, breatheFreq, breathePhase)
 *            size = 光点边长（格）；alive = 0/1 存活标志（夜间密度用：容量固定，
 *            只数差走它，不靠 instanceCount，spec §3.5）；后两项是呼吸闪烁的频率与相位
 *   aLife    vec2 = (born, life) —— born 是出生**绝对秒**（与 uTime 同一时钟），life 是寿命秒数
 *   aDriftGround vec3 = (driftX, driftZ, groundY) —— 水平慢漂移 + 该列地面 y（供 y 钳制）
 *            ⚠️ **y 无漂移项**（只正弦）⇒ 不飘上天也不钻地
 *
 * ⚠️⚠️ **属性必须打包到 ≤7 个（+position = 8）**（本轮浏览器实测）：WebGPU 的
 * `maxVertexBuffers` 是 **8** —— 首版 position + 11 个逐实例属性 = 12
 * ⇒ `Vertex buffer count exceeds the maximum number of vertex buffers (8)`
 * ⇒ render pipeline 创建失败、**整池零像素**，而所有数值判据全对（静默失效）。
 * 打包口径：size+alive+breatheFreq+breathePhase 合 **vec4**、born+life 合 vec2、
 * driftX/Z+ground 合 vec3 ⇒ 7 个逐实例属性 + position = **8**，刚好卡上限。
 */
export const FIREFLY_ATTR = Object.freeze({
  origin: 'aOrigin',
  amp: 'aAmp',
  freq: 'aFreq',
  phase: 'aPhase',
  sizeAlive: 'aSizeAlive',
  life: 'aLife',
  driftGround: 'aDriftGround',
});

const FIREFLY_ATTR_SIZE = Object.freeze({
  [FIREFLY_ATTR.origin]: 3,
  [FIREFLY_ATTR.amp]: 3,
  [FIREFLY_ATTR.freq]: 3,
  [FIREFLY_ATTR.phase]: 3,
  [FIREFLY_ATTR.sizeAlive]: 4,
  [FIREFLY_ATTR.life]: 2,
  [FIREFLY_ATTR.driftGround]: 3,
});

/** hex → 显式分量 vec3（禁 `vec3(new THREE.Color(hex))`：WebGPU 输出纯黑且零报错） */
function rgb(hex) {
  const c = new THREE.Color(hex);
  return vec3(c.r, c.g, c.b);
}

/**
 * 萤火虫 quad + 逐实例属性。初始全部已死（`aLife=(-1e3, 1e-3)` / `aSizeAlive.y=0`）。
 * @param {number} capacity
 * @returns {THREE.InstancedBufferGeometry}
 */
export function createFireflyGeometry(capacity) {
  const cap = Math.max(1, Math.round(capacity));
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
  ]), 3));
  geometry.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));

  for (const [name, itemSize] of Object.entries(FIREFLY_ATTR_SIZE)) {
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(cap * itemSize), itemSize);
    attr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(name, attr);
  }
  const life = geometry.getAttribute(FIREFLY_ATTR.life);
  const sizeAlive = geometry.getAttribute(FIREFLY_ATTR.sizeAlive);
  for (let i = 0; i < cap; i++) { life.setXY(i, -1e3, 1e-3); sizeAlive.setY(i, 0); }

  geometry.instanceCount = cap;
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  return geometry;
}

/**
 * 造萤火虫材质 + 它自己那组 uniform（**闭包捕获** ⇒ 与落叶池互不覆写）。
 * @returns {{material:THREE.MeshBasicNodeMaterial, uniforms:{uTime:object,uGain:object}}}
 */
export function createFireflyMaterial() {
  const U = {
    /** 绝对秒（全局单一时钟；aBorn 与它同源） */
    uTime: uniform(0),
    /** 亮度增益（白天 0.55 → 夜里 1.15，由装配层按 nightBlend 插值） */
    uGain: uniform(FIREFLY_FX.gainDay),
  };

  const vUv = varyingProperty('vec2', 'vFlyUv');
  const vBreathe = varyingProperty('float', 'vFlyBreathe');
  const vK = varyingProperty('float', 'vFlyK');

  const vertex = Fn(() => {
    const origin = attribute(FIREFLY_ATTR.origin, 'vec3');
    const amp = attribute(FIREFLY_ATTR.amp, 'vec3');
    const freq = attribute(FIREFLY_ATTR.freq, 'vec3');
    const phase = attribute(FIREFLY_ATTR.phase, 'vec3');
    const sizeAlive = attribute(FIREFLY_ATTR.sizeAlive, 'vec4');
    const life = attribute(FIREFLY_ATTR.life, 'vec2');
    const driftGround = attribute(FIREFLY_ATTR.driftGround, 'vec3');

    const t = U.uTime.sub(life.x);
    // 三轴各用自己的频率与相位（同频 ⇒ 轨迹闭合 ⇒ 读作绕圈）
    const pos = vec3(
      origin.x.add(driftGround.x.mul(t)).add(amp.x.mul(sin(freq.x.mul(t).add(phase.x)))),
      max(
        origin.y.add(amp.y.mul(sin(freq.y.mul(t).add(phase.y)))),
        driftGround.z.add(float(FIREFLY_FX.floorClearance)),
      ),
      origin.z.add(driftGround.y.mul(t)).add(amp.z.mul(sin(freq.z.mul(t).add(phase.z)))),
    );

    const k = clamp(t.div(max(life.y, float(1e-3))), 0, 1);
    const alive = step(float(0), t).mul(step(k, float(0.999))).mul(sizeAlive.y);
    // 三次幂 ⇒ 暗的时间长、亮的时间短（读作闪烁而不是匀速正弦）
    const wave = float(0.5).add(float(0.5).mul(sin(sizeAlive.z.mul(U.uTime).add(sizeAlive.w))));
    const breatheNow = float(0.15).add(float(0.85).mul(pow(wave, 3)));

    const sizeCurve = mix(float(0.02), float(1), smoothstep(float(0), float(0.06), k))
      .mul(mix(float(1), float(0.3), smoothstep(float(0.8), float(1), k)));
    const s0 = sizeAlive.x.mul(alive).mul(sizeCurve);

    // 屏幕对齐 billboard + 屏幕尺寸硬钳（照 spike-fx-material:makeParticlePass 逐字）
    const centerView = modelViewMatrix.mul(vec4(pos, 1));
    const depth = max(centerView.z.negate(), float(0.05));
    const s = min(s0, depth.mul(float(FIREFLY_FX.maxScreen).mul(1.4)));
    const corner = positionGeometry.xy.mul(s);

    vUv.assign(positionGeometry.xy.mul(2));
    vBreathe.assign(breatheNow);
    vK.assign(k);
    return cameraProjectionMatrix.mul(vec4(centerView.xyz.add(vec3(corner, 0)), 1));
  });

  const color = Fn(() => {
    // ⚠️⚠️ 径向量**在片元算**：quad 只有 4 顶点，顶点算 length 插值后恒为常数（v3.23）
    const r = length(vUv);
    const core = oneMinus(smoothstep(float(0), float(FIREFLY_FX.coreEdge), r));
    const halo = pow(max(oneMinus(r), float(1e-4)), float(FIREFLY_FX.haloFalloff));
    const mask = max(core, halo.mul(0.55));
    const fade = oneMinus(smoothstep(float(0.8), float(1), vK));
    const a = mask.mul(vBreathe).mul(fade);
    Discard(a.lessThanEqual(0.004));
    return vec4(rgb(FIREFLY_FX.colorHex).mul(U.uGain).mul(vBreathe), a);
  });

  const material = new THREE.MeshBasicNodeMaterial();
  material.vertexNode = vertex();
  material.colorNode = color();
  material.transparent = true;
  material.blending = THREE.AdditiveBlending;   // 自发光
  material.depthWrite = false;
  material.depthTest = true;
  material.side = THREE.DoubleSide;
  material.fog = false;
  material.lights = false;
  material.castShadow = false;
  material.receiveShadow = false;
  return { material, uniforms: U };
}