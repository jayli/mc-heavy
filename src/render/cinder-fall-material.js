// src/render/cinder-fall-material.js — Cinder Fall 的三个 TSL 材质（v3.21）
//
// 上游是 raw GLSL（`materials/MeteorMaterial.js` 的 patched standard material +
// `effects/BurstSphere.js` 的 FIRE 模式）。⚠️⚠️ **本仓一行都不能直接用**：
// WebGPU 的 NodeMaterial 库不注册 ShaderMaterial（v3.20 实测），必须 TSL 重写。
//
// ## 三个 pass
//   ROCK  —— 程序化岩石：低频起伏 + 高频碎裂 + **熔岩缝**（越接近落点越亮）
//   BURST —— 落点爆壳：复用 Storm Lance 的 STORM 结构（噪声位移 + 硬阈值电弧），换暖色
//   SHOCK —— 冲击环：径向亮带随 age 外扩
//
// 火焰拖尾**不在这里** —— 它是 canvas 径向渐变贴图 + MeshBasicMaterial（零 shader，
// 照 `fireball-renderer.js` 的手法，用户 v3.20c 裁定）。
//
// ## 四条 TSL 口径（与 storm-lance-material 同源，每条都有实测依据）
//   ① 世界摆放用 `vertexNode` 而不是 `positionNode`；
//   ② 逐 pass 的 varying 用 `varyingProperty`，顶点写、片元读
//      （片元阶段读不到 instanced 属性，直读 `positionGeometry` 会静默拿 0）；
//   ③ 反向 smoothstep 写 `oneMinus(smoothstep(lo,hi,x))`；
//   ④ **常量色显式拆分量 `vec3(c.r,c.g,c.b)`** —— `vec3(new THREE.Color(hex))`
//      在 WebGPU 输出**纯黑且零报错**（v3.14 实测非黑像素 0 vs 10455）。
//
// **主线程专用**：构造 NodeMaterial 必然依赖 three。归属 `render/`。
import * as THREE from 'three';
import {
  Fn, float, vec3, vec4, uniform, attribute,
  varyingProperty, mx_noise_float as perlin,
  cameraProjectionMatrix, modelViewMatrix,
  positionGeometry, normalGeometry,
  sin, abs, pow, mix, smoothstep, oneMinus, clamp, max,
  normalize, dot, fract, floor, Discard,
} from 'three/tsl';
import { CINDER_FX as FX } from './cinder-fall-config.js';

/** hex → 显式分量 vec3（口径 ④，禁 `vec3(Color)`） */
function rgb(hex) {
  const c = new THREE.Color(hex);
  return vec3(c.r, c.g, c.b);
}

/** 4 octave fbm（上游 `fbm4`）—— 岩石起伏与熔岩缝都用它 */
const fbm4 = Fn(([p]) => {
  const q = vec3(p).toVar();
  const amp = float(0.5).toVar();
  const sum = float(0).toVar();
  // ⚠️ `Loop` 第一参必须写 {start,end,type}：裸数字会被包成 ConstNode ⇒ inputs 为空
  // ⇒ 解构的 i 是 undefined ⇒ 整片 pass 不上屏（v3.20 实测）。这里不用 i，但仍显式写。
  for (let k = 0; k < 4; k++) {
    sum.addAssign(amp.mul(perlin(q)));
    q.mulAssign(2.03).addAssign(vec3(17.3, 5.1, 9.7));
    amp.mulAssign(0.5);
  }
  return sum;
});

/** ridged multifractal（上游 `ridged`）—— 熔岩缝与爆壳电弧用它 */
const ridgedFbm = Fn(([p]) => {
  const q = vec3(p).toVar();
  const amp = float(0.5).toVar();
  const sum = float(0).toVar();
  for (let k = 0; k < 4; k++) {
    sum.addAssign(amp.mul(float(1).sub(abs(perlin(q)))));
    q.mulAssign(2.06);
    amp.mulAssign(0.5);
  }
  return sum;
});

function makeUniforms() {
  return {
    /** 绝对秒（全局单一时钟，与 Storm Lance 同口径） */
    uTime: uniform(0),
    /** 受热程度 0..1（飞行进度^chargeCurve）—— 熔岩缝随它张开变亮 */
    uHeat: uniform(0),
    /** 逐实例随机种子（由 instanced 属性喂进来，这里只做全局偏移） */
    uSeed: uniform(0),
    uGain: uniform(FX.gain),
    /** 爆壳 / 冲击环的**独立** age 与 fade（不共用，否则末尾硬 pop） */
    uBurstAge: uniform(0),
    uBurstFade: uniform(0),
    uShockAge: uniform(0),
    uShockFade: uniform(0),
  };
}

/** 模块级 uniform 组（由 createCinderMaterials 赋值；Fn 闭包引用它） */
let U = makeUniforms();

/** 公共设置（口径见文件头） */
function tune(mat, uniforms) {
  mat.transparent = true;
  mat.depthWrite = false;
  mat.depthTest = true;
  mat.side = THREE.DoubleSide;
  mat.blending = THREE.AdditiveBlending;
  mat.fog = false;
  mat.lights = false;
  mat.userData.cinderUniforms = uniforms;
  return mat;
}

/**
 * 岩石本体 —— 上游 `MeteorMaterial` 的身份三件：**起伏的石头 + 熔岩缝 + 前缘热**。
 *
 * ⚠️ **岩石走 NormalBlending 而不是 additive**：它是不透明的石头，加法混合会让
 * 灰色岩石在亮天空上消失（与 `block-hit-fx` 碎块同一条教训）。只有熔岩缝是自发光的，
 * 那部分靠颜色本身亮出来，不需要 additive。
 *
 * ⚠️ **岩石写深度**（`depthWrite=true`）：它是实体，光晕与爆壳要能被它正确遮挡。
 */
function makeRockPass(uniforms) {
  const vNrm = varyingProperty('vec3', 'vCfRockNrm');
  const vDisp = varyingProperty('float', 'vCfRockDisp');
  const vFacing = varyingProperty('float', 'vCfRockFacing');
  const vSeed = varyingProperty('float', 'vCfRockSeed');

  const vertex = Fn(() => {
    const seed = attribute('aSeed', 'float');
    const n = normalGeometry;
    // 低频起伏（lumpiness）+ 高频碎裂（surfaceRoughness）
    const lump = fbm4(n.mul(FX.lumpScale).add(vec3(seed.mul(7.3))));
    const chip = perlin(n.mul(FX.rockScale * 2.4).add(vec3(seed.mul(3.1))));
    const disp = lump.mul(FX.lumpiness).add(chip.mul(FX.surfaceRoughness)).toVar();
    const local = positionGeometry.add(n.mul(disp));
    const here = modelViewMatrix.mul(vec4(local, 1));
    vNrm.assign(n);
    vDisp.assign(disp);
    vSeed.assign(seed);
    vFacing.assign(abs(dot(normalize(here.xyz.negate()), normalize(n))));
    return cameraProjectionMatrix.mul(here);
  });

  const color = Fn(() => {
    const heat = clamp(U.uHeat, 0, 1);
    const n = vNrm;
    // 熔岩缝：ridged 噪声的**窄带**（缝宽随受热张开，上游 crackWidth 满热时翻倍）
    const field = ridgedFbm(n.mul(FX.crackScale * 3.2)
      .add(vec3(vSeed.mul(5.7)))
      .add(vec3(0, U.uTime.mul(FX.crackFlowSpeed * 0.3), 0)));
    const w = float(FX.crackWidth).mul(float(1).add(heat)).mul(6);
    const seam = smoothstep(float(1).sub(w), float(1), field);
    // 细缝分叉（更高频、更弱）
    const fine = smoothstep(float(0.86), float(0.99),
      ridgedFbm(n.mul(FX.crackScale * 7.1).add(vec3(vSeed.mul(11.2)))));
    const cracks = clamp(seam.add(fine.mul(FX.crackBranches)), 0, 1);
    // 岩浆亮度爬行
    const flow = float(1).add(perlin(n.mul(2.1).add(vec3(0, U.uTime.mul(FX.crackFlow), 0)))
      .mul(FX.crackFlow * 0.5));

    // 石头本体：基岩色 + 逐面明暗打散（读作石头而不是塑料球）
    const facet = fract(sin(dot(floor(n.mul(3)), vec3(12.9898, 78.233, 37.719))).mul(43758.5453));
    const rockCol = mix(rgb(FX.colorRock), rgb(FX.colorChar),
      clamp(vDisp.mul(-1).mul(FX.cavity * 3).add(facet.mul(FX.facetTint * 0.4)), 0, 1));
    // 缝两侧焦黑
    const sootBand = smoothstep(float(0.55), float(0.95), field).mul(FX.soot);
    const base = mix(rockCol, rgb(FX.colorChar), sootBand.mul(oneMinus(cracks)));

    // 熔岩发光：越接近落点越亮（chargeCurve 已在 CPU 侧算进 uHeat）
    const glowAmt = cracks.mul(flow).mul(FX.crackGlow).mul(float(0.25).add(heat.mul(0.95)));
    const seamCol = mix(rgb(FX.colorCrack), rgb(FX.colorHot), heat.mul(cracks));
    // 轮廓热鞘 + 前缘压缩热（读作「正在烧着冲过来」）
    const rim = pow(oneMinus(clamp(vFacing, 0, 1)), float(2.4)).mul(FX.rimHeat).mul(heat);
    const col = base
      .add(seamCol.mul(glowAmt))
      .add(rgb(FX.colorFlameMid).mul(rim))
      .add(rgb(FX.colorHot).mul(pow(clamp(vFacing, 0, 1), float(FX.leadSharp))
        .mul(FX.leadGlow * 0.25).mul(heat)));

    // 岩石不透明（它是实体）；alpha 恒 1，靠深度与颜色表达
    return vec4(col.mul(U.uGain), 1);
  });

  const mat = new THREE.MeshBasicNodeMaterial();
  mat.vertexNode = vertex();
  mat.colorNode = color();
  tune(mat, uniforms);
  // ⚠️ 岩石是实体：不透明混合 + 写深度（见函数注释）
  mat.blending = THREE.NormalBlending;
  mat.transparent = false;
  mat.depthWrite = true;
  return mat;
}

/**
 * 落点爆壳 —— 结构照 Storm Lance 的 STORM（噪声位移 + 硬阈值电弧 + fresnel rim），
 * 配色换暖橙。⚠️ **扩张走 outQuint**（渲染器侧），不是 outCubic。
 */
function makeBurstPass(uniforms) {
  const vFacing = varyingProperty('float', 'vCfBurstFacing');
  const vDisp = varyingProperty('float', 'vCfBurstDisp');
  const vNrmW = varyingProperty('vec3', 'vCfBurstNrmW');

  const vertex = Fn(() => {
    const n = normalGeometry;
    const age = U.uBurstAge;
    const np = n.mul(float(1.6).add(age.mul(1.4)))
      .add(vec3(U.uSeed.mul(13)))
      .sub(vec3(0, U.uTime.mul(0.6), 0));
    const nz = fbm4(np).mul(0.6).add(ridgedFbm(np.mul(1.3)).mul(0.4));
    const amount = float(FX.burstDisplace).mul(float(0.35).add(age.mul(0.9)));
    const local = positionGeometry.add(n.mul(nz).mul(amount));
    const here = modelViewMatrix.mul(vec4(local, 1));
    vDisp.assign(nz);
    vNrmW.assign(normalize(n));
    vFacing.assign(abs(dot(normalize(here.xyz.negate()), normalize(n))));
    return cameraProjectionMatrix.mul(here);
  });

  const color = Fn(() => {
    const age = U.uBurstAge;
    const fil = ridgedFbm(vNrmW.mul(float(5).add(age.mul(7)))
      .add(vec3(U.uSeed.mul(9)))
      .add(vec3(0, U.uTime.mul(3.4), 0)));
    // ⚠️ 阈值必须硬：放宽会把壳填成实心球（上游注释 reads as a rock）
    const arcs = smoothstep(float(FX.burstArcLo), float(FX.burstArcHi), fil)
      .mul(float(1).sub(age.mul(0.6)));
    const fres = pow(oneMinus(clamp(vFacing, 0, 1)), float(2.2)).mul(FX.burstFresnel);
    const rim = pow(clamp(fres, 0, 1), float(1.6));
    const heat = clamp(vDisp.mul(0.5).add(0.5), 0, 1);

    const col = mix(rgb(FX.colorBurstA), rgb(FX.colorBurstB), heat.mul(0.5))
      .mix(rgb(FX.colorBurstC), arcs)
      .add(rgb(FX.colorBurstC).mul(rim).mul(1.2))
      .add(rgb(FX.colorBurstC).mul(arcs).mul(2.4));

    const a = float(FX.burstOpacity)
      .mul(float(1).sub(age))
      .mul(rim.mul(0.55).add(arcs.mul(0.9)))
      .mul(U.uBurstFade);
    Discard(a.lessThanEqual(0.004));
    return vec4(col.mul(U.uGain).mul(FX.burstIntensity), a);
  });

  const mat = new THREE.MeshBasicNodeMaterial();
  mat.vertexNode = vertex();
  mat.colorNode = color();
  return tune(mat, uniforms);
}

/** 冲击环：亮带随 age 从中心外扩，带宽恒定。朝向由渲染器写 matrix。 */
function makeShockPass(uniforms) {
  const vR = varyingProperty('float', 'vCfShockR');

  const vertex = Fn(() => {
    vR.assign(positionGeometry.xy.length());
    const here = modelViewMatrix.mul(vec4(positionGeometry, 1));
    return cameraProjectionMatrix.mul(here);
  });

  const color = Fn(() => {
    const front = mix(float(0.15), float(0.95), clamp(U.uShockAge, 0, 1));
    const w = max(float(FX.shockWidth), float(0.01));
    const band = oneMinus(smoothstep(float(0), w, abs(vR.sub(front))));
    const inner = oneMinus(smoothstep(float(0), front, vR)).mul(0.12);
    const col = mix(rgb(FX.colorShockA), rgb(FX.colorShockB), band);
    const a = band.add(inner).mul(U.uShockFade).mul(FX.shockIntensity);
    Discard(a.lessThanEqual(0.003));
    return vec4(col.mul(U.uGain).mul(1.8), a);
  });

  const mat = new THREE.MeshBasicNodeMaterial();
  mat.vertexNode = vertex();
  mat.colorNode = color();
  return tune(mat, uniforms);
}

/**
 * 造三个材质 + 共享 uniform 组。
 * ⚠️ **每次调用造一组新 uniform**（不是模块级单例）：多个 Game 实例会互相覆写。
 * @returns {{rock,burst,shock,uniforms}}
 */
export function createCinderMaterials() {
  U = makeUniforms();
  const uniforms = U;
  return {
    rock: makeRockPass(uniforms),
    burst: makeBurstPass(uniforms),
    shock: makeShockPass(uniforms),
    uniforms,
  };
}