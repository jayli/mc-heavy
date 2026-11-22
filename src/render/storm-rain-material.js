// src/render/storm-rain-material.js — 持续雨的雨丝 / 水花 TSL 材质与实例几何
//
// 上游：`bj-shooting-game/night-heron-src/src/fx/rain.js` 的两个 ShaderMaterial。
// **顶点/片元数学逐字移植**，只把 GLSL 换成本仓 TSL 口径。
//
// ## 七条 TSL 口径（本仓已实测的教训）
//   ① 粒子用 `Mesh` + `InstancedBufferGeometry`，**禁 InstancedMesh**；
//   ② 世界摆放走 `vertexNode`；
//   ③ 逐实例参数走 instanced attribute + `varyingProperty`（片元读不到 instanced 属性）；
//   ④ 节点不与裸 JS 数字算术，一律 `.mul()`；
//   ⑤ 常量色显式拆分量；
//   ⑥ 径向量片元算；
//   ⑦ uniform 闭包捕获，禁模块级 `let U`。
//
// ⚠️ **WebGPU maxVertexBuffers = 8**：雨丝 4 个属性 + position = 5；水花 2 + position = 3。
//
// ## 与上游的两处必要改写
//   ① **遮挡走逐实例 `aMinY`**（CPU 按体素解析）而不是上游的 `uShelter` 贴图：
//      本仓世界可挖可放，静态贴图会过期。判据在 `rain-shelter.js`
//      （屋顶拦、树叶/云/空岛不拦、上界在云下）。
//   ② **亮度用天空环境色 × 日夜 skyDim**（复用体素那两个 uniform 实例），
//      不接上游的动态点光源（本仓全场景 unlit，接了只影响 PBR 材质）。
import * as THREE from 'three';
import {
  Fn, float, vec2, vec3, vec4, uniform, attribute, varyingProperty,
  positionGeometry, cameraProjectionMatrix, modelViewMatrix, cameraPosition,
  abs, cos, sin, mix, max, min, smoothstep, oneMinus, step, mod, fract,
  normalize, length, cross, Discard,
} from 'three/tsl';
import { STORM_STREAK as ST, STORM_SPLASH as SP } from './storm-rain-config.js';
import { WATER_SURFACE_Y } from './water-surface.js';

const QUAD_POS = Object.freeze([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0]);
const QUAD_IDX = Object.freeze([0, 1, 2, 0, 2, 3]);

function instancedQuad(capacity, attrs) {
  const cap = Math.max(1, Math.round(capacity));
  const names = Object.keys(attrs);
  if (names.length + 1 > 8) {
    throw new Error(`storm-rain: 逐实例属性 ${names.length} + position 超过 WebGPU 上限 8`);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(QUAD_POS), 3));
  g.setIndex(new THREE.BufferAttribute(new Uint16Array(QUAD_IDX), 1));
  for (const [name, size] of Object.entries(attrs)) {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * size), size);
    a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute(name, a);
  }
  g.instanceCount = cap;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  return g;
}

function tuneAdditive(mat) {
  mat.transparent = true;
  mat.blending = THREE.AdditiveBlending;
  mat.depthWrite = false;
  mat.depthTest = true;
  mat.side = THREE.DoubleSide;
  mat.fog = false;
  mat.lights = false;
  mat.toneMapped = false;
  mat.castShadow = false;
  mat.receiveShadow = false;
  return mat;
}

// ============================================================================
// 雨丝
// ============================================================================

/**
 * 雨丝几何：三个逐实例属性（+position = 4）。
 *   aSeed  [0,1)³ —— 盒内初始位置比例（上游 `position` 属性就是种子）
 *   aMinY  该滴的截停高度（CPU 按体素解析；−1e9 = 无截停）
 *   aShelter 该滴是否被屋顶完全遮住（0/1；1 ⇒ 整滴不可见）
 *   aWaterCol 该滴所在列有没有暴露水面（0/1，v3.30g）—— 与 GPU 侧的
 *             `uWaterY` 相乘成水下门；分开是因为「列有水」变化慢（可 10Hz 采样）
 *             而「滴的 y」每帧在变（必须 GPU 逐顶点判）。
 *
 * ⚠️ **aMinY 与 aShelter 分开**：前者是「落到哪一层」（雨丝底部钳住），
 * 后者是「这一格整个在屋顶下」（整滴不画）。合成一个会丢掉「雨中庭」的情形
 * （头顶有盖但侧面漏雨 —— 上游用 shelter 贴图的高度比较表达，本仓两项等价）。
 */
export function createStormStreakGeometry(capacity = ST.count) {
  const g = instancedQuad(capacity, { aSeed: 3, aMinY: 1, aShelter: 1, aWaterCol: 1 });
  const minY = g.getAttribute('aMinY');
  const sh = g.getAttribute('aShelter');
  const wc = g.getAttribute('aWaterCol');
  for (let i = 0; i < g.instanceCount; i++) { minY.setX(i, -1e9); sh.setX(i, 1); wc.setX(i, 0); }
  return g;
}

/**
 * 雨丝材质（上游顶点/片元逐字）。
 *
 * 顶点：
 *   sp = 0.75 + 0.5*fract(seed.x*7.31 + seed.z*3.17)
 *   vel = (uVel.x, −uVel.y*sp, uVel.z)
 *   p = seed*uBox + vel*uTime，再绕相机 wrap 到盒内
 *   dir = normalize(vel)；side = normalize(cross(dir, toCam))
 *   wp = p + dir*(corner.y*0.34*sp) + side*(corner.x*w)
 *   fade = smoothstep(1,3.2,dist) * (1 − smoothstep(box.x*0.36, box.x*0.5, dist))
 *   **遮雨**：p.y < aMinY ⇒ 不可见；aShelter=1 ⇒ 不可见
 * 片元：横向羽化 × 纵向两端淡出（上游同式）。
 *
 * @param {{skyDim?:object, shadowStrength?:object}} [deps] 体素材质的 uniform 实例（红线 1）
 */
export function createStormStreakMaterial({ skyDim, shadowStrength } = {}) {
  const U = {
    uTime: uniform(0),
    uGain: uniform(1),
    // ⚠️ 传入实例原样透出（单测用 === 钉住）：自己 new 会让日夜变了而雨钉在正午亮度
    uSkyDim: skyDim || uniform(1),
    uShadowStrength: shadowStrength || uniform(1),
    // 雨幕盒心（装配层每帧写；已钳在云层之下）
    uCenter: uniform(new THREE.Vector3()),
    /**
     * v3.30g：**水面高度**（世界 y）—— GPU 侧水下门的基准。
     *
     * ⚠️⚠️ **为何不能只靠 CPU 的 `aShelter`**（本轮浏览器实测）：
     * 雨丝在 18 格高的盒子里循环，而 `aShelter` 是 **10Hz 分批采样**的
     * ⇒ 某滴被采样时在盒子顶部（水上、sh=0），下一帧已绕到盒底（水下）
     * ⇒ sh 仍是 0 ⇒ **水下雨丝照样上屏**（实测 994 滴 sh=0 但位置在水下）。
     *
     * ⚠️⚠️ **但不能无条件把「y < 水面」当成水下**：本仓地形有低于海平面的
     * **干坑/峡谷**（实测 29 滴在无水列且 y < −1.5）—— 那里的雨是合法的。
     * ⇒ 与 `aWaterCol`（该列有没有暴露水面，CPU 逐列解析）相乘：
     * **只有水体列才适用这道门**。列的水陆属性变化慢（不像滴的 y 每帧变）
     * ⇒ 10Hz 采样对它足够，而对 y 不够 —— 两者分工正是本修法的要点。
     */
    uWaterY: uniform(WATER_SURFACE_Y),
  };
  const vCol = varyingProperty('vec3', 'vStormStCol');
  const vC = varyingProperty('vec2', 'vStormStC');
  const vertex = Fn(() => {
    const seed = attribute('aSeed', 'vec3');
    const minY = attribute('aMinY', 'float');
    const shelter = attribute('aShelter', 'float');
    const waterCol = attribute('aWaterCol', 'float');
    const box = vec3(ST.box[0], ST.box[1], ST.box[2]);
    const sp = float(ST.speedMin).add(
      fract(seed.x.mul(7.31).add(seed.z.mul(3.17))).mul(ST.speedRange));
    const vel = vec3(ST.vel[0], float(ST.vel[1]).mul(sp).negate(), ST.vel[2]);
    // 盒内循环（上游 mod(p - camPos + box/2, box) - box/2 + camPos；本仓用 uCenter）
    const raw = seed.mul(box).add(vel.mul(U.uTime));
    const half = box.mul(0.5);
    const p = mod(raw.sub(U.uCenter).add(half), box).sub(half).add(U.uCenter);
    const dir = normalize(vel);
    const toCam = cameraPosition.sub(p);
    const dist = length(toCam);
    const side = normalize(cross(dir, toCam).add(vec3(1e-5)));
    const w = max(float(ST.widthMin), dist.mul(ST.widthPerDistance));
    // 淡入淡出
    const near = smoothstep(float(ST.nearFadeFrom), float(ST.nearFadeTo), dist);
    const far = oneMinus(smoothstep(
      float(ST.box[0] * ST.farFadeFromRatio), float(ST.box[0] * ST.farFadeToRatio), dist));
    // 遮雨门：低于截停高度 / 整格在屋顶下 ⇒ 宽度归零（整滴不可见）
    const aboveFloor = step(minY, p.y);
    const notSheltered = oneMinus(shelter);
    /**
     * ⚠️⚠️ **水下门（v3.30g，用户「雨滴不要在水下出现」）**：
     * 逐顶点判「该滴此刻是不是在水面之下」—— y 每帧在变，故这道门不能交给
     * 10Hz 采样的 aShelter（实测会漏 994 滴）。而「该列有没有水」变化慢，
     * 由 aWaterCol 给 ⇒ 两者相乘：水体列 ∧ y < 水面 ⇒ 不画。
     * 干坑/峡谷（无水列）的雨不受影响。
     * `mix(1, step(waterY, p.y), waterCol)`：waterCol=0 ⇒ 恒 1；=1 ⇒ 取水上判定。
     */
    const aboveWater = mix(float(1), step(U.uWaterY, p.y), waterCol);
    const fade = near.mul(far).mul(aboveFloor).mul(notSheltered).mul(aboveWater);
    // 亮度：天空环境色（冷蓝）× 日夜。⚠️ 显式拆分量（口径⑤）
    const amb = vec3(0.62, 0.72, 0.92);
    const dim = mix(float(1), U.uSkyDim, U.uShadowStrength);
    vCol.assign(amb.mul(dim).mul(fade).mul(U.uGain).mul(ST.gain));
    vC.assign(vec2(positionGeometry.x.mul(2), positionGeometry.y));
    const wp = p.add(dir.mul(positionGeometry.y.mul(ST.length).mul(sp)))
      .add(side.mul(positionGeometry.x.mul(2).mul(w).mul(fade)));
    return cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(wp, 1)));
  });
  const color = Fn(() => {
    // 上游：(1−|x|) * smoothstep(0,0.25,y) * (1−smoothstep(0.55,1,y))
    const a = oneMinus(abs(vC.x))
      .mul(smoothstep(float(0), float(0.25), vC.y))
      .mul(oneMinus(smoothstep(float(0.55), float(1.0), vC.y)));
    Discard(a.lessThanEqual(0.004));
    return vec4(vCol.mul(a), 1);
  });
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.vertexNode = vertex();
  mat.colorNode = color();
  return { material: tuneAdditive(mat), uniforms: U };
}

// ============================================================================
// 水花冠
// ============================================================================

/**
 * 水花几何：一个逐实例属性（+position = 2）。
 *   aSpawn  出生点 xyz + 出生绝对秒（上游 `aSpawn` 同形状）
 *
 * 初始全部「已死」：w = −1e3 ⇒ age 极大 ⇒ alive=0。
 */
export function createStormSplashGeometry(capacity = SP.capacity) {
  const g = instancedQuad(capacity, { aSpawn: 4 });
  const a = g.getAttribute('aSpawn');
  for (let i = 0; i < g.instanceCount; i++) a.setW(i, -1e3);
  return g;
}

/**
 * 水花材质（上游顶点/片元逐字）。
 *
 * 顶点：age = (t − birth)/0.26；宽 (0.02+age*0.05)、高 (0.012+sin(age*π)*0.075)；
 *       billboard 到相机（right = cross(up, toCam)）；亮度按年龄与距离衰减。
 * 片元：**冠形**（抛物线边缘）+ 中心核（上游两项相加）。
 */
export function createStormSplashMaterial({ skyDim, shadowStrength } = {}) {
  const U = {
    uTime: uniform(0),
    uGain: uniform(1),
    uSkyDim: skyDim || uniform(1),
    uShadowStrength: shadowStrength || uniform(1),
  };
  const vCol = varyingProperty('vec3', 'vStormSpCol');
  const vC = varyingProperty('vec3', 'vStormSpC');
  const vertex = Fn(() => {
    const spawn = attribute('aSpawn', 'vec4');
    const age = U.uTime.sub(spawn.w).div(SP.life);
    const p = spawn.xyz;
    const toCam = cameraPosition.sub(p);
    const right = normalize(cross(vec3(0, 1, 0), toCam).add(vec3(1e-5)));
    const alive = step(float(0), age).mul(step(age, float(1)));
    const w = float(SP.widthBase).add(age.mul(SP.widthGrow)).mul(alive);
    const h = float(SP.heightBase).add(sin(age.mul(3.14159265)).mul(SP.heightArc)).mul(alive);
    const cy = positionGeometry.y;
    const wp = p.add(right.mul(positionGeometry.x.mul(2).mul(w)))
      .add(vec3(0, cy.mul(h), 0));
    const dist = length(toCam);
    const distFade = oneMinus(smoothstep(float(SP.distFadeTo), float(SP.distFadeFrom), dist));
    const amb = vec3(0.62, 0.72, 0.92);
    const dim = mix(float(1), U.uSkyDim, U.uShadowStrength);
    vCol.assign(amb.mul(dim).mul(SP.gain)
      .mul(max(float(0), float(1).sub(age.mul(SP.ageFade))))
      .mul(distFade).mul(U.uGain).mul(alive));
    vC.assign(vec3(positionGeometry.x.mul(2), cy, age));
    return cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(wp, 1)));
  });
  const color = Fn(() => {
    const x = vC.x;
    const y = vC.y;
    // 冠：抛物线边缘 (1−x²)*0.8 附近的一条亮带
    const crown = oneMinus(smoothstep(float(0), float(0.3),
      abs(y.sub(oneMinus(x.mul(x)).mul(0.8)))))
      .mul(oneMinus(abs(x).mul(0.6)))
      .mul(float(0.4).add(vC.z.mul(0.6)));
    // 核：中心一团（出生时最亮）
    const core = oneMinus(smoothstep(float(0), float(0.5),
      length(vec2(x.mul(1.3), y.sub(0.25).mul(0.8)))))
      .mul(oneMinus(vC.z)).mul(1.6);
    const a = crown.add(core);
    Discard(a.lessThanEqual(0.004));
    return vec4(vCol.mul(a), 1);
  });
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.vertexNode = vertex();
  mat.colorNode = color();
  return { material: tuneAdditive(mat), uniforms: U };
}

/** 属性名清单（几何与渲染器共用，避免两处字面量漂移） */
export const STORM_ATTRS = Object.freeze({
  streak: Object.freeze(['aSeed', 'aMinY', 'aShelter', 'aWaterCol']),
  splash: Object.freeze(['aSpawn']),
});

void [min, cos];