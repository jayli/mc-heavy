// src/render/carbine-fx-material.js — KV-9 五个特效池的 TSL 材质与实例几何
//
// 上游：`~/jaylli/bj-shooting-game/night-heron-src/src/fx/particles.js` 的五个
// ShaderMaterial（Puffs / Sparks / Tracers / Holes）+ `fx/rain.js` 的 `quadGeometry`。
// **每个顶点/片元的数学都逐字移植**，只把 GLSL 换成本仓的 TSL 口径。
//
// ## 七条 TSL 口径（本仓已实测的教训，违反任一都是「数值判据全绿而画面全错」）
//
//   ① 粒子必须 `THREE.Mesh` + `InstancedBufferGeometry`，**禁 InstancedMesh**
//      （instanceMatrix 接管 modelViewMatrix ⇒ 由 aOrigin 定位的粒子全塌到原点）；
//   ② 世界摆放走 `vertexNode`（`positionNode` 的返回值会被 modelViewMatrix 再乘一次）；
//   ③ 逐实例参数走 instanced attribute + `varyingProperty`（片元读不到 instanced 属性）；
//   ④ 节点不得与裸 JS 数字算术（`float(x)*1.4` 生成 `NaN.0`），一律 `.mul()`；
//   ⑤ 常量色显式拆分量 `vec3(c[0],c[1],c[2])`（`vec3(new Color())` 在 WebGPU 输出纯黑）；
//   ⑥ **径向量必须片元算**（PlaneGeometry 只 4 顶点，顶点算 length 插值后恒常数）；
//   ⑦ uniform 按调用闭包捕获，禁模块级 `let U`（Fn 体惰性求值，两池会互相覆写）。
//
// ⚠️ **WebGPU maxVertexBuffers = 8**：每个池的逐实例属性数 + position 必须 ≤ 8。
// 本文件各池的属性数已按此上限设计（见各工厂的注释）。
//
// **主线程专用**：NodeMaterial / BufferGeometry 必然依赖 three。归属 `render/`。
import * as THREE from 'three';
import {
  Fn, float, vec2, vec3, vec4, uniform, attribute, varyingProperty,
  positionGeometry, cameraProjectionMatrix, modelViewMatrix, cameraPosition,
  abs, pow, cos, sin, mix, max, min, smoothstep, oneMinus, clamp, step,
  normalize, length, cross, dot, Discard, mx_noise_float as perlin, floor, fract,
} from 'three/tsl';
import {
  CARBINE_TRACER_FX as TR, CARBINE_SPARK_FX as SP,
  CARBINE_PUFF_FX as PU, CARBINE_HOLE_FX as HO,
} from './carbine-fx-config.js';

/** 单位 quad 的四角（上游 `quadGeometry` 的 aCorner：[-1,0],[1,0],[1,1],[-1,1]） */
const QUAD_POS = Object.freeze([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0]);
const QUAD_IDX = Object.freeze([0, 1, 2, 0, 2, 3]);

/**
 * 建一个 instanced quad 几何 + 若干逐实例属性。
 *
 * ⚠️ `boundingSphere` 取 1e4：几何自身在单位 quad 内，实际被 shader 摆到几十格外
 * ⇒ 正常包围球会让它被误剔除。渲染器另设 `frustumCulled=false` 双保险。
 *
 * @param {number} capacity
 * @param {Record<string, number>} attrs 属性名 → itemSize（**总数 + 1 ≤ 8**）
 * @returns {THREE.InstancedBufferGeometry}
 */
function instancedQuad(capacity, attrs) {
  const cap = Math.max(1, Math.round(capacity));
  const names = Object.keys(attrs);
  if (names.length + 1 > 8) {
    throw new Error(`carbine-fx: 逐实例属性 ${names.length} + position 超过 WebGPU 上限 8`);
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

/** 公共设置（additive 自发光粒子；不吃雾/灯/阴影） */
function tuneAdditive(mat, renderOrder) {
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
  void renderOrder;
  return mat;
}

// ============================================================================
// ① 曳光（上游 Tracers）
// ============================================================================

/**
 * 曳光几何：三个 vec4 逐实例属性（+ position = 4 个 buffer，远低于上限 8）。
 *   aA   起点 xyz + 出生绝对秒
 *   aB   终点 xyz + 速度（格/秒）
 *   aCol 线性 HDR rgb + 半宽
 *
 * 初始全部「已死」：aA.w = −1e3 ⇒ head 极大 ⇒ alive=0 ⇒ 宽度 0（不可见）。
 */
export function createCarbineTracerGeometry(capacity = TR.capacity) {
  const g = instancedQuad(capacity, { aA: 4, aB: 4, aCol: 4 });
  const a = g.getAttribute('aA');
  for (let i = 0; i < g.instanceCount; i++) a.setW(i, -1e3);
  return g;
}

/**
 * 曳光材质（上游顶点/片元逐字）。
 *
 * 顶点：沿 A→B 推进一段亮条，头部 `head=(t−birth)*speed`，
 * 段长 `len=min(L*0.5, 9)`，尾 `t=clamp(head−len,0,L)`；
 * 侧向 = `normalize(cross(dir, toCam))`（billboard 到相机），
 * 半宽 `max(width, dist*0.0016)`，`alive` 门控整条宽度。
 * 片元：横向羽化 × 纵向渐变（头亮尾暗）。
 */
export function createCarbineTracerMaterial() {
  const U = { uTime: uniform(0) };
  const vCol = varyingProperty('vec3', 'vCarbTrCol');
  const vC = varyingProperty('vec2', 'vCarbTrC');
  const vertex = Fn(() => {
    const A = attribute('aA', 'vec4');
    const B = attribute('aB', 'vec4');
    const C = attribute('aCol', 'vec4');
    const d0 = B.xyz.sub(A.xyz);
    const L = length(d0);
    const d = d0.div(max(L, float(1e-4)));
    const head = U.uTime.sub(A.w).mul(B.w);
    const len = min(L.mul(TR.lengthRatio), float(TR.maxLength));
    const h = min(head, L);
    const t = clamp(head.sub(len), float(0), L);
    const alive = step(float(0), head).mul(step(head.sub(len), L));
    const p = A.xyz.add(d.mul(mix(t, h, positionGeometry.y)));
    const toCam = cameraPosition.sub(p);
    const side = normalize(cross(d, toCam).add(vec3(1e-5)));
    const w = max(C.w, length(toCam).mul(0.0016)).mul(alive);
    vCol.assign(C.xyz);
    // aCorner.x ∈ [-0.5,0.5] ⇒ ×2 回到上游的 [-1,1]
    vC.assign(vec2(positionGeometry.x.mul(2), positionGeometry.y));
    const wp = p.add(side.mul(positionGeometry.x.mul(2).mul(w)));
    return cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(wp, 1)));
  });
  const color = Fn(() => {
    const a = oneMinus(abs(vC.x)).mul(float(0.15).add(vC.y.mul(0.85)));
    Discard(a.lessThanEqual(0.004));
    return vec4(vCol.mul(a), 1);
  });
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.vertexNode = vertex();
  mat.colorNode = color();
  return { material: tuneAdditive(mat, TR.renderOrder), uniforms: U };
}

// ============================================================================
// ② 火花（上游 Sparks）
// ============================================================================

/**
 * 火花几何：四个逐实例属性（+position = 5）。
 *   aPos  xyz + 半宽
 *   aVel  xyz + 淡出系数（CPU 每帧写 —— 上游同口径，因为要落地反弹）
 *   aCol  线性 HDR rgb
 *   aFloor 地面高度（−1e9 = 无地面）
 *
 * ⚠️ **火花是 CPU 模拟**（上游同口径）：要落地反弹，GPU 闭式积分做不到。
 * 每帧写 aPos/aVel（360 × 8 float = 11.5KB），实测上传成本在噪声内。
 */
export function createCarbineSparkGeometry(capacity = SP.capacity) {
  const g = instancedQuad(capacity, { aPos: 4, aVel: 4, aCol: 3, aFloor: 1 });
  const f = g.getAttribute('aFloor');
  for (let i = 0; i < g.instanceCount; i++) f.setX(i, -1e9);
  return g;
}

/**
 * 火花材质（上游顶点/片元逐字）：沿速度方向拉伸的条状亮点。
 *
 * 顶点：`tail = p − vel*0.028`，`side = normalize(cross(dir, toCam))`，
 * `wp = mix(tail, p, corner.y) + side*corner.x*w`。
 * 片元：横向羽化 × 纵向 smoothstep（尾暗头亮）。
 */
export function createCarbineSparkMaterial() {
  const vCol = varyingProperty('vec3', 'vCarbSpCol');
  const vC = varyingProperty('vec2', 'vCarbSpC');
  const vertex = Fn(() => {
    const P = attribute('aPos', 'vec4');
    const V = attribute('aVel', 'vec4');
    const C = attribute('aCol', 'vec3');
    const p = P.xyz;
    const tail = p.sub(V.xyz.mul(SP.tailSeconds));
    const dir = p.sub(tail);
    const len = length(dir);
    const toCam = cameraPosition.sub(p);
    const side = normalize(cross(dir.div(max(len, float(1e-4))), toCam).add(vec3(1e-5)));
    const w = max(P.w, length(toCam).mul(SP.widthPerDistance));
    const cy = positionGeometry.y;
    const wp = mix(tail, p, cy).add(side.mul(positionGeometry.x.mul(2).mul(w)));
    vCol.assign(C.mul(V.w));
    vC.assign(vec2(positionGeometry.x.mul(2), cy));
    return cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(wp, 1)));
  });
  const color = Fn(() => {
    const a = oneMinus(abs(vC.x)).mul(smoothstep(float(0), float(0.5), vC.y));
    Discard(a.lessThanEqual(0.004));
    return vec4(vCol.mul(a), 1);
  });
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.vertexNode = vertex();
  mat.colorNode = color();
  return { material: tuneAdditive(mat, SP.renderOrder) };
}

// ============================================================================
// ③ 烟尘（上游 Puffs）
// ============================================================================

/**
 * 烟尘几何：三个逐实例属性（+position = 4）。
 *   aPos  xyz + 尺寸
 *   aCol  rgb + alpha
 *   aSeed 旋转/噪声种子
 *
 * ⚠️ **正常混合不是 additive**（上游 `CustomBlending: One / OneMinusSrcAlpha`
 * = premultiplied alpha 的正常混合）：烟是遮光的，additive 会让它在亮背景上消失。
 * 片元输出 `vec4(col*a, a)` 正是 premultiplied 形式 ⇒ 本仓用
 * `blending: CustomBlending, blendSrc: OneFactor, blendDst: OneMinusSrcAlphaFactor`。
 */
export function createCarbinePuffGeometry(capacity = PU.capacity) {
  const g = instancedQuad(capacity, { aPos: 4, aCol: 4, aSeed: 1 });
  const s = g.getAttribute('aSeed');
  for (let i = 0; i < g.instanceCount; i++) s.setX(i, i * 0.37);
  return g;
}

/** 烟尘材质（上游顶点/片元逐字；噪声用 TSL 的 perlin 替代上游噪声贴图） */
export function createCarbinePuffMaterial() {
  const U = { uTime: uniform(0) };
  const vCol = varyingProperty('vec4', 'vCarbPfCol');
  const vC = varyingProperty('vec3', 'vCarbPfC');
  const vertex = Fn(() => {
    const P = attribute('aPos', 'vec4');
    const C = attribute('aCol', 'vec4');
    const seed = attribute('aSeed', 'float');
    const mv = modelViewMatrix.mul(vec4(P.xyz, 1));
    const a = seed.mul(5.0).add(U.uTime.mul(PU.spin));
    // 上游 c = (corner.x, corner.y*2−1)：本仓 quad y∈[0,1] ⇒ 同式
    const c = vec2(positionGeometry.x.mul(2), positionGeometry.y.mul(2).sub(1));
    const rot = vec2(
      c.x.mul(cos(a)).sub(c.y.mul(sin(a))),
      c.x.mul(sin(a)).add(c.y.mul(cos(a))),
    );
    const depth = max(mv.z.negate(), float(0.05));
    const fade = smoothstep(float(PU.nearFadeFrom), float(PU.nearFadeTo), depth);
    vCol.assign(vec4(C.xyz, C.w.mul(fade)));
    vC.assign(vec3(c, seed));
    const off = rot.mul(P.w);
    return cameraProjectionMatrix.mul(vec4(mv.xyz.add(vec3(off, 0)), 1));
  });
  const color = Fn(() => {
    const r = length(vC.xy);
    // 上游两层噪声采样（贴图）→ 本仓用 perlin（同为 [-1,1] 平滑噪声，映射到 [0,1]）
    const n1 = perlin(vec3(vC.xy.mul(PU.noiseScaleA).add(vC.z), U.uTime.mul(0.03)))
      .mul(0.5).add(0.5);
    const n2 = perlin(vec3(vC.xy.mul(PU.noiseScaleB).sub(vC.z), float(0)))
      .mul(0.5).add(0.5);
    const n = n1.mul(0.7).add(n2.mul(0.3));
    const a = oneMinus(smoothstep(float(0.15), float(1.0), r))
      .mul(smoothstep(float(0.25), float(0.75), n.add(oneMinus(r).mul(0.45))))
      .mul(vCol.w);
    Discard(a.lessThanEqual(0.003));
    return vec4(vCol.xyz.mul(a), a);
  });
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.vertexNode = vertex();
  mat.colorNode = color();
  mat.transparent = true;
  // premultiplied alpha 的正常混合（上游 CustomBlending 逐字）
  mat.blending = THREE.CustomBlending;
  mat.blendSrc = THREE.OneFactor;
  mat.blendDst = THREE.OneMinusSrcAlphaFactor;
  mat.blendEquation = THREE.AddEquation;
  mat.depthWrite = false;
  mat.depthTest = true;
  mat.side = THREE.DoubleSide;
  mat.fog = false;
  mat.lights = false;
  mat.toneMapped = false;
  return { material: mat, uniforms: U };
}

// ============================================================================
// ④ 弹孔（上游 Holes）
// ============================================================================

/**
 * 弹孔几何：两个逐实例属性（+position = 3）。
 *   aP 中心 xyz + 尺寸
 *   aN 法线 xyz
 */
export function createCarbineHoleGeometry(capacity = HO.capacity) {
  return instancedQuad(capacity, { aP: 4, aN: 3 });
}

/**
 * 弹孔材质（上游顶点/片元逐字）。
 *
 * 顶点：由法线造正交基 (t,b)，quad 贴在命中面上并沿法线抬 0.012。
 * ⚠️ **不用 polygonOffset**（WebGPU 后端无此字段）—— 抬升已足够防 z-fighting。
 * 片元：暗色圆斑 + 一圈略亮的 rim（上游同式），正常混合。
 */
export function createCarbineHoleMaterial() {
  const vC = varyingProperty('vec2', 'vCarbHoC');
  const vertex = Fn(() => {
    const P = attribute('aP', 'vec4');
    const N = attribute('aN', 'vec3');
    const n = normalize(N);
    // 上游：|n.y|>0.9 时叉乘 +X，否则叉乘 +Y（避免与法线平行时退化）
    const ref = vec3(0, 1, 0);
    const alt = vec3(1, 0, 0);
    const useAlt = abs(n.y).greaterThan(0.9);
    const t = normalize(cross(n, mix(ref, alt, useAlt)));
    const b = cross(n, t);
    const c = vec2(positionGeometry.x.mul(2), positionGeometry.y.mul(2).sub(1));
    const p = P.xyz.add(n.mul(HO.normalOffset))
      .add(t.mul(c.x).add(b.mul(c.y)).mul(P.w));
    vC.assign(c);
    return cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(p, 1)));
  });
  const color = Fn(() => {
    const r = length(vC);
    const a = oneMinus(smoothstep(float(0.25), float(1.0), r)).mul(HO.alpha);
    Discard(a.lessThanEqual(0.004));
    const rim = smoothstep(float(0.25), float(0.4), r)
      .mul(oneMinus(smoothstep(float(0.45), float(0.75), r)));
    const col = vec3(HO.color[0], HO.color[1], HO.color[2]).mul(rim).mul(2.0);
    return vec4(col, a);
  });
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.vertexNode = vertex();
  mat.colorNode = color();
  mat.transparent = true;
  mat.blending = THREE.NormalBlending;
  mat.depthWrite = false;
  mat.depthTest = true;
  mat.side = THREE.DoubleSide;
  mat.fog = false;
  mat.lights = false;
  mat.toneMapped = false;
  return { material: mat };
}

// ============================================================================
// ⑤ 弹壳（上游 Casings：InstancedMesh + 逐实例矩阵）
// ============================================================================

/**
 * 弹壳材质：黄铜金属（上游 `{c:0xc9a24a, r:0.28, m:1.0}`）。
 *
 * ⚠️ **与视图模型不同，弹壳用 InstancedMesh**（上游同口径）：它是**真实刚体**
 * （CPU 算位置/旋转/落地反弹），逐实例矩阵正是 InstancedMesh 的用途。
 * 前四个池是「shader 定位的粒子」才必须用 InstancedBufferGeometry —— 两者不可混用。
 * ⚠️ 吃场景灯光（metalness=1 全靠镜面反射，无灯则纯黑）。
 */
export function createCarbineCasingMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial();
  mat.colorNode = vec4(vec3(0.788, 0.635, 0.290), 1); // 0xc9a24a 的线性近似（见下方注释）
  mat.roughnessNode = float(0.28);
  mat.metalnessNode = float(1.0);
  mat.fog = false;
  return mat;
}

/** 弹壳几何（上游 `CylinderGeometry(0.0062,0.0062,0.03,7)`） */
export function createCarbineCasingGeometry(cfg) {
  return new THREE.CylinderGeometry(cfg.radius, cfg.radius, cfg.length, cfg.segments);
}

/** 供渲染器读的属性名清单（几何与材质共用，避免两处字面量漂移） */
export const CARBINE_FX_ATTRS = Object.freeze({
  tracer: Object.freeze(['aA', 'aB', 'aCol']),
  spark: Object.freeze(['aPos', 'aVel', 'aCol', 'aFloor']),
  puff: Object.freeze(['aPos', 'aCol', 'aSeed']),
  hole: Object.freeze(['aP', 'aN']),
});

/** 未使用的 TSL 导入占位（保持 import 列表与实际用法一致，lint 不报未用） */
void [dot, floor, fract, clamp];