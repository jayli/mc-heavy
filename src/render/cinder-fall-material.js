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
  Fn, float, vec2, vec3, vec4, uniform, attribute,
  varyingProperty, mx_noise_float as perlin,
  cameraProjectionMatrix, modelViewMatrix, cameraPosition,
  positionGeometry, normalGeometry,
  sin, cos, abs, pow, mix, smoothstep, oneMinus, clamp, max, min, step,
  normalize, dot, cross, length, sqrt, fract, floor, Discard, select,
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
    /** 火焰尾巴的两端（世界坐标，每帧由渲染器写） */
    uTail: uniform(new THREE.Vector3()),
    uHead: uniform(new THREE.Vector3()),
    /** 尾巴可见度与烧回进度（0 = 在飞，1 = 已烧完） */
    uTrailFade: uniform(0),
    uTrailBurn: uniform(0),
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
 * 火焰尾巴 —— 上游 `VolumetricFireMaterial` 的**简化移植**（ribbon 而不是 raymarch）。
 *
 * 用户：「有拖拽的一个火焰尾巴」。上游那套是 35 步/像素的体积积分（833 行），
 * 本仓按既有裁定不移植；改成**相机朝向的条带 + 四层噪声**，保留上游的四个身份层：
 *   ① **轮廓**（radiusProfile：头部粗、尾端细且膨大）
 *   ② **流场**（沿路径向后流 + 向上爬 —— trailSpeed / trailBuoyancy）
 *   ③ **湍流与域扭曲**（把噪声折成卷曲的火舌 —— trailTurbulence / trailWarp）
 *   ④ **烟灰吸收**（冷气体遮挡，尾巴末端撕成独立烟团 —— trailSoot / trailDetachment）
 *
 * ⚠️ **尾巴用 NormalBlending 而不是 additive**：它要能**遮挡**（上游 smoke 同理）。
 * 纯加法会让整条尾巴在亮天空下变成一层白雾，读不出「火」的层次；
 * 热核心靠颜色本身亮（colorHot 近白），烟灰靠 alpha 压暗。
 *
 * ⚠️ 世界摆放走 `vertexNode`（口径 ①）；`Fn` 不返回多键对象（SplitNode 陷阱）。
 */
function makeFlamePass(uniforms) {
  const vT = varyingProperty('float', 'vCfFlameT');
  const vSide = varyingProperty('float', 'vCfFlameSide');
  const vHeat = varyingProperty('float', 'vCfFlameHeat');

  /**
   * 半径剖面（上游 radiusProfile，0 = 尾端、1 = **岩石中心**）—— 普通 JS 函数，不用 Fn。
   * ⚠️ 鼻锥段（t > noseStart）**不用它**，另走椭圆收拢，见顶点里的说明。
   */
  const radiusProfile = (u) => {
    const body = float(0.34).add(float(0.66).mul(pow(u, float(0.55))))
      .mul(float(1).add(float(FX.trailWakeSpread).mul(pow(oneMinus(u), float(1.8)))));
    return body.mul(float(1).add(float(FX.trailHeadSize - 1)
      .mul(smoothstep(float(0.62), float(1), u))));
  };

  const vertex = Fn(() => {
    const t = positionGeometry.x;
    const side = positionGeometry.y;
    const tail = U.uTail;
    const head = U.uHead;
    const axis = head.sub(tail).toVar();
    const axisLen = max(length(axis), float(1e-4));
    const dirRaw = axis.div(axisLen);

    /**
     * ⚠️⚠️ **鼻锥：把中心线沿运动方向前伸，并用椭圆剖面收到一点**。
     *
     * 用户 2026-11-19：「前进方向侧前面是平的…希望改成椭圆头或者尖头」。
     * 成因：ribbon 原本只铺到岩石中心（uHead），于是条带在球心处被一条
     * **垂直于运动方向的直边**截断；岩石与光晕盖不住超出球半径的那半圈宽度，
     * 读作「平头铲子」。
     *
     * 参数重映射：`t ∈ [0, noseStart]` → 躯干（tail→head）；
     *             `t ∈ (noseStart, 1]` → 鼻锥（head → head + dir×noseLength）。
     * 宽度在鼻锥段乘 `sqrt(1−s²)`：s=0 处导数为 0 ⇒ 与躯干**无缝且切线竖直**（圆润），
     * s→1 处收到 0 ⇒ 尖端。两者合起来就是卵形头。
     */
    const noseLen = float(FX.trailNoseLength);
    const total = axisLen.add(noseLen);
    const noseStart = axisLen.div(total);
    const inNose = step(noseStart, t);
    // 躯干参数（鼻锥段钳在 1 ⇒ 剖面取头部值，保证接缝同宽）
    const bodyT = clamp(t.div(max(noseStart, float(1e-4))), 0, 1);
    // 鼻锥进度 0..1
    const s = clamp(t.sub(noseStart).div(max(oneMinus(noseStart), float(1e-4))), 0, 1);
    const bodyPos = tail.add(axis.mul(bodyT));
    const nosePos = head.add(dirRaw.mul(noseLen).mul(s));
    const along = mix(bodyPos, nosePos, inNose);

    // 热气往上爬：越靠尾端（age 越大）浮得越高（上游 trailRise × age^1.5）
    // ⚠️ 鼻锥段不抬升（它是岩石前方的压缩热，不是已燃气体）
    const age = oneMinus(bodyT);
    const rise = float(FX.trailRise).mul(pow(age, float(1.5))).mul(oneMinus(inNose));
    const center = along.add(vec3(0, rise, 0));

    // 朝相机展开（与 Storm Lance ribbon 同手法）⇒ 任何角度看都保持表观粗细
    const toCam = normalize(cameraPosition.sub(center));
    const binRaw = cross(dirRaw, toCam);
    const bl = length(binRaw);
    const binormal = select(bl.greaterThan(1e-4), binRaw.div(max(bl, float(1e-6))),
      vec3(1, 0, 0));

    // 烧回：岩石没了之后尾巴从头部往尾端吃掉（上游 burn）
    const burn = clamp(U.uTrailBurn, 0, 1);
    const alive = oneMinus(smoothstep(float(1).sub(burn), float(1).sub(burn).add(0.12), t));

    // 椭圆收拢因子：躯干恒 1；鼻锥 sqrt(1−s²)（s=1 时为 0 ⇒ 真正的尖）
    const noseTaper = sqrt(max(oneMinus(s.mul(s)), float(0)));
    const taper = mix(float(FX.trailNoseJoin), noseTaper, inNose);
    const halfWidth = float(FX.trailWidth).mul(radiusProfile(bodyT)).mul(taper)
      .mul(float(1).sub(burn.mul(0.65)))
      .mul(alive).mul(U.uTrailFade);
    // 向上拉伸（浮力伸长）—— 只括上半边，读作舔舐的火舌而不是对称丝带
    // ⚠️ 鼻锥段**对称**（plume=1）：不对称会把卵形头拉成歪的斜切面
    const plume = select(side.greaterThan(0),
      mix(float(FX.trailPlume), float(1), inNose), float(1));
    const here = center.add(binormal.mul(side).mul(halfWidth).mul(plume));

    // 片元用的「躯干进度」：鼻锥段恒 1（满热），否则尖端会被当成冷尾发黑
    vT.assign(mix(bodyT, float(1), inNose));
    vSide.assign(side);
    vHeat.assign(alive);
    return cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(here, 1)));
  });

  const color = Fn(() => {
    const t = vT;
    const v = clamp(abs(vSide), 0, 1);
    // 流场坐标：沿路径向后流（−t 方向）+ 向上爬
    const flow = vec3(
      t.mul(float(FX.trailNoiseFrequency)).sub(U.uTime.mul(FX.trailSpeed * 0.35)),
      vSide.mul(float(1.7)).sub(U.uTime.mul(FX.trailBuoyancy * 0.22)),
      U.uSeed.mul(3.1),
    ).toVar();
    // 域扭曲：先用低频噪声把采样坐标推弯 ⇒ 噪声折成卷曲的片（上游 trailWarp）
    const warp = perlin(flow.mul(0.6)).mul(FX.trailWarp);
    flow.addAssign(vec3(warp, warp.mul(0.7), warp.mul(0.4)));
    const n1 = perlin(flow);
    const n2 = perlin(flow.mul(2.07).add(vec3(11.3, 5.1, 7.7)));
    const turb = n1.mul(0.65).add(n2.mul(0.35));

    /**
     * 轮廓：中心实、边缘被噪声吃掉（吃得多 = 火舌）。
     * ⚠️ 阈值不能太低：首版 smoothstep(0.06,0.5) 把大片低密度区也画成不透明，
     * 实测得到**一个巨大淡色圆锥**而不是火舌。
     */
    const body = oneMinus(pow(v, float(FX.trailTongue)));
    const eaten = body.add(turb.mul(FX.trailTurbulence))
      .sub(float(FX.trailTailFade).mul(pow(oneMinus(t), float(2.2))));
    const mask = smoothstep(float(0.35), float(0.85), eaten).mul(vHeat).mul(U.uTrailFade);
    Discard(mask.lessThanEqual(0.02));

    /**
     * 热度：**头部白热 → 中段炽橙 → 尾端暗红**（黑体辐射的观感）。
     * ⚠️ 不得把烟灰色混进主体：首版用 colorFlameSmoke 作基底，而它在大部分
     * 区域都占主导 ⇒ 整条尾巴发白/发青（实测截图）。烟交给独立的 smoke 粒子池。
     */
    const heat = clamp(t.mul(1.35).add(turb.mul(0.16)).add(float(0.22)), 0, 1);
    const core = smoothstep(float(0.62), float(1), heat).mul(oneMinus(v.mul(0.6)));
    /**
     * ⚠️⚠️ **不得链式 `.mix()`**（浏览器像素二分实测）：
     * `mix(a,b,t).mix(c,t2)` 会把红色像素从 **78620 崩到 88**（几乎全灭），
     * 而材质构造 / uniform / 零 console 错误 全绿。
     * ⇒ 多层渐变一律写成**嵌套 `mix(mix(a,b,t),c,t2)`**。
     */
    const col = mix(
      mix(rgb(FX.colorFlameEdge), rgb(FX.colorFlameMid),
        smoothstep(float(0.3), float(0.68), heat)),
      rgb(FX.colorHot), core,
    );

    // 闪烁（量化，不是正弦呼吸 —— 真火是在几个亮度之间跳）
    const flick = float(1).sub(float(FX.trailFlicker)
      .mul(fract(sin(floor(U.uTime.mul(18)).mul(12.9898).add(U.uSeed)).mul(43758.5453))));

    const a = clamp(mask.mul(float(FX.trailOpacity)), 0, 1);
    Discard(a.lessThanEqual(0.02));
    return vec4(col.mul(U.uGain).mul(float(1).add(core.mul(FX.trailGlow))).mul(flick), a);
  });

  const mat = new THREE.MeshBasicNodeMaterial();
  mat.vertexNode = vertex();
  mat.colorNode = color();
  tune(mat, uniforms);
  /**
   * ⚠️ **火焰走 additive**（与上游 trailMesh 同：renderOrder 11 在 additive 粒子之前）。
   * 首版用 NormalBlending 想做「烟灰遮挡」，但 ribbon 没有真正的体积吸收，
   * 普通混合只会把背景**洗成一片淡色**（实测：巨大白/青圆锥）。
   * 遮挡交给独立的 **smoke 粒子池**（它才是真正非加法的那一层）。
   */
  mat.blending = THREE.AdditiveBlending;
  return mat;
}

/**
 * 火星（STREAK）/ 余烬（SOFT）—— **同一份 GPU 模拟**，只差轮廓与拉伸。
 *
 * 结构逐字沿用 `storm-lance-material.js:makeSparkPass`（已验证的 TSL）：
 * 阻力积分位移 + 重力 + 尺寸曲线 + 四停靠渐变 + 视图空间沿速度拉伸。
 *
 * ⚠️⚠️ **`streak` 不是装饰选项**（用户：「火星粒子很多，是爆炸的样子」）：
 * 圆形羽化 quad 会被读作「冒爆米花 / 烟花」。**拉伸 + 条状轮廓缺一都退回圆点**：
 * 只拉伸不改轮廓 = 拉长的圆斑；只改轮廓不拉伸 = 竖直细条（不跟速度）。
 *
 * @param {object} uniforms @param {boolean} streak true = 火星条状，false = 余烬圆点
 */
function makeParticlePass(uniforms, streak) {
  const tag = streak ? 'Sp' : 'Em';
  const vAge = varyingProperty('float', `vCf${tag}Age`);
  const vUv = varyingProperty('vec2', `vCf${tag}Uv`);
  const P = streak
    ? { drag: FX.sparkDrag, gravity: FX.sparkGravity, glow: 1.0, cap: FX.sparkMaxScreen,
      cA: FX.colorSparkA, cB: FX.colorSparkB, cC: FX.colorSparkC, cD: FX.colorSparkD }
    : { drag: FX.emberDrag, gravity: FX.emberRise, glow: 1.2, cap: FX.emberMaxScreen,
      cA: FX.colorEmberA, cB: FX.colorEmberB, cC: FX.colorEmberC, cD: FX.colorEmberD };

  const vertex = Fn(() => {
    const origin = attribute('aOrigin', 'vec3');
    const vel = attribute('aVel', 'vec3');
    const spawn = attribute('aSpawn', 'float');
    const life = attribute('aLife', 'float');
    const size = attribute('aSize', 'float');
    const seed = attribute('aSeed', 'float');

    const age = U.uTime.sub(spawn);
    const k = clamp(age.div(max(life, float(1e-3))), 0, 1);
    // 阻力积分：位移 = v0·(1−e^(−drag·t))/drag
    const drag = float(P.drag);
    const decay = pow(float(2.718281828), drag.mul(age).negate());
    const integ = float(1).sub(decay).div(drag);
    const pos = origin.add(vel.mul(integ))
      .add(vec3(0, float(P.gravity).mul(age).mul(age).mul(0.5), 0));
    const velNow = vel.mul(decay);

    // 尺寸曲线：出生极小 → 峰值 → 末段收零
    const sizeCurve = mix(float(0.02), float(1), smoothstep(float(0), float(0.04), k))
      .mul(mix(float(1), float(0.25), smoothstep(float(0.55), float(1), k)));
    const alive = step(float(0), age).mul(step(k, float(0.999)));
    const jitter = float(1).add(perlin(vec3(seed.mul(13.7), k.mul(2.1), 0)).mul(0.18));
    const s0 = size.mul(sizeCurve).mul(alive).mul(jitter);

    const centerView = modelViewMatrix.mul(vec4(pos, 1));
    /**
     * ⚠️⚠️ **屏幕空间尺寸硬钳**（实测截图缺陷）：粒子在手点附近出生，
     * 那里离相机只有 0.5 格 ⇒ 固定世界尺寸会投影成**上百像素的大光斑**
     * （用户读作「爆米花 / 烟花」）。钳成「不超过屏高 × cap」：
     *   视图空间半高 = |z| · tan(fov/2)，投影后尺寸 ∝ s / |z|
     *   ⇒ s_max = |z| · cap · 2·tan(fov/2)，本仓 fov 70° ⇒ 2tan35° ≈ 1.40
     * 取 min 后：远处粒子保持世界尺寸（透视正确），近处不再糊成一片。
     */
    const depth = max(centerView.z.negate(), float(0.05));
    const sCap = depth.mul(float(P.cap).mul(1.4));
    const s = min(s0, sCap);
    // 余烬：普通 billboard（圆点）；火星：沿速度拉伸的条状
    const corner = vec2(0).toVar();
    if (streak) {
      const velView = modelViewMatrix.mul(vec4(velNow, 0)).xyz;
      const dir2 = normalize(velView.xy.add(vec2(1e-5)));
      const perp2 = vec2(dir2.y.negate(), dir2.x);
      const stretch = float(1).add(float(FX.sparkStretch).mul(length(velNow)));
      corner.assign(dir2.mul(positionGeometry.y.mul(s).mul(stretch))
        .add(perp2.mul(positionGeometry.x.mul(s))));
    } else {
      corner.assign(positionGeometry.xy.mul(s));
    }

    vAge.assign(k);
    vUv.assign(positionGeometry.xy.mul(2));
    return cameraProjectionMatrix.mul(vec4(centerView.xyz.add(vec3(corner, 0)), 1));
  });

  const color = Fn(() => {
    const mask = float(0).toVar();
    if (streak) {
      // 条状轮廓：横向窄核 × 纵向线性衰减
      const core = oneMinus(smoothstep(float(0), float(1), abs(vUv.x).mul(3.4)));
      const len = oneMinus(clamp(abs(vUv.y), 0, 1));
      mask.assign(core.mul(len));
    } else {
      // 圆点羽化（余烬就该是圆的小亚光点）
      mask.assign(oneMinus(smoothstep(float(0.15), float(1), length(vUv))));
    }
    Discard(mask.lessThanEqual(0.01));
    const a1 = mix(rgb(P.cA), rgb(P.cB), smoothstep(float(0), float(0.34), vAge));
    const a2 = mix(a1, rgb(P.cC), smoothstep(float(0.30), float(0.68), vAge));
    const col = mix(a2, rgb(P.cD), smoothstep(float(0.64), float(1), vAge));
    const fade = oneMinus(smoothstep(float(0.5), float(1), vAge));
    const a = mask.mul(fade);
    Discard(a.lessThanEqual(0.003));
    return vec4(col.mul(U.uGain).mul(P.glow), a);
  });

  const mat = new THREE.MeshBasicNodeMaterial();
  mat.vertexNode = vertex();
  mat.colorNode = color();
  return tune(mat, uniforms);
}

/**
 * 烟团 —— **非加法混合**（它要遮挡，这是爆炸层次的来源）。
 * 上游 `meteor.smoke`：additive:false / curl:true / uEndSize 3.6（越飘越大）。
 */
function makeSmokePass(uniforms) {
  const vAge = varyingProperty('float', 'vCfSmAge');
  const vUv = varyingProperty('vec2', 'vCfSmUv');
  const vSeed = varyingProperty('float', 'vCfSmSeed');

  const vertex = Fn(() => {
    const origin = attribute('aOrigin', 'vec3');
    const vel = attribute('aVel', 'vec3');
    const spawn = attribute('aSpawn', 'float');
    const life = attribute('aLife', 'float');
    const size = attribute('aSize', 'float');
    const seed = attribute('aSeed', 'float');
    const age = U.uTime.sub(spawn);
    const k = clamp(age.div(max(life, float(1e-3))), 0, 1);
    const drag = float(FX.smokeDrag);
    const integ = float(1).sub(pow(float(2.718281828), drag.mul(age).negate())).div(drag);
    const pos = origin.add(vel.mul(integ))
      .add(vec3(0, float(FX.smokeRise).mul(age), 0));
    // 烟越飘越大（上游 uSizeIn 0.12 → uEndSize 3.6）
    const grow = mix(float(0.18), float(2.4), pow(k, float(0.6)));
    const alive = step(float(0), age).mul(step(k, float(0.999)));
    const s0 = size.mul(grow).mul(alive);
    const centerView = modelViewMatrix.mul(vec4(pos, 1));
    // ⚠️ 同火星：屏幕空间硬钳（手点附近的烟否则糊成一大片灰雾）
    const depth = max(centerView.z.negate(), float(0.05));
    const s = min(s0, depth.mul(float(FX.smokeMaxScreen).mul(1.4)));
    // 逐实例自转（烟团要滚，不是硬卡片）
    const ang = seed.mul(6.28).add(age.mul(0.6));
    const ca = cos(ang), sa = sin(ang);
    const p = positionGeometry.xy.mul(s);
    const rot = vec2(p.x.mul(ca).sub(p.y.mul(sa)), p.x.mul(sa).add(p.y.mul(ca)));
    vAge.assign(k);
    vUv.assign(positionGeometry.xy.mul(2));
    vSeed.assign(seed);
    return cameraProjectionMatrix.mul(vec4(centerView.xyz.add(vec3(rot, 0)), 1));
  });

  const color = Fn(() => {
    const r = length(vUv);
    // 噪声侵蚀边缘（否则是完美圆盘）
    const n = perlin(vec3(vUv.mul(1.9), vSeed.mul(7.3).add(vAge.mul(1.4))));
    const mask = oneMinus(smoothstep(float(0.25), float(1), r.add(n.mul(0.3))));
    const fadeIn = smoothstep(float(0), float(0.18), vAge);
    const fadeOut = oneMinus(smoothstep(float(0.45), float(1), vAge));
    const a = mask.mul(fadeIn).mul(fadeOut).mul(FX.smokeOpacity);
    Discard(a.lessThanEqual(0.003));
    const c1 = mix(rgb(FX.colorSmokeA), rgb(FX.colorSmokeB), smoothstep(float(0), float(0.4), vAge));
    const col = mix(c1, rgb(FX.colorSmokeD), smoothstep(float(0.35), float(1), vAge));
    return vec4(col.mul(U.uGain), a);
  });

  const mat = new THREE.MeshBasicNodeMaterial();
  mat.vertexNode = vertex();
  mat.colorNode = color();
  tune(mat, uniforms);
  mat.blending = THREE.NormalBlending;
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

    // ⚠️ 嵌套 mix，不链式 .mix（见 flame pass 里的实测注释）
    // ⚠️⚠️ **rim/arcs 的增益必须比 Storm Lance 低很多**：冷蓝白本身就接近白，
    // 加法叠 3.6 倍仍读得出蓝；而暖橙的 r 已经=1.0，再叠就**全部钳到白**
    // （实测 warmPct 2.7% = 几乎无色）。
    const col = mix(
      mix(rgb(FX.colorBurstA), rgb(FX.colorBurstB), heat.mul(0.5)),
      rgb(FX.colorBurstC), arcs.mul(0.6),
    )
      .add(rgb(FX.colorBurstB).mul(rim).mul(0.35))
      .add(rgb(FX.colorBurstC).mul(arcs).mul(0.9));

    /**
     * ⚠️⚠️ **壳必须保持「空」**（上游注释：the body of it contributes almost nothing）。
     * 首版沿用 Storm Lance 的 `rim*0.55 + arcs*0.9` ⇒ 实测截图里是**一张盖满屏幕的
     * 淡色薄膜**（fresnel 在球背面也大，而 DoubleSide 把两面都画了）。
     * 修法：rim 权重降到 0.18、arcs 提到 1.0 ⇒ **只剩细分叉丝**，壳内透光。
     */
    const a = float(FX.burstOpacity)
      .mul(float(1).sub(age))
      .mul(rim.mul(0.18).add(arcs.mul(1.0)))
      .mul(U.uBurstFade);
    Discard(a.lessThanEqual(0.02));
    return vec4(col.mul(U.uGain).mul(FX.burstIntensity), a);
  });

  const mat = new THREE.MeshBasicNodeMaterial();
  mat.vertexNode = vertex();
  mat.colorNode = color();
  tune(mat, uniforms);
  /**
   * ⚠️⚠️ **爆壳走 NormalBlending**（与 Storm Lance 的冷蓝壳刻意不同）。
   *
   * 加法混合下暖橙会被**背景色洗掉**：在蓝水/白沙滩上实测均值
   * **B=180 > R=173**（warmPct 3.2%）—— 看起来是白/青而不是火。
   * 暖色的 r 已接近 1.0，加法只能把 g/b 抬上去 ⇒ 必然趋向白。
   * 普通混合才能**保住橙红色相**（上游 fireball 也是不透明的热核）。
   */
  mat.blending = THREE.NormalBlending;
  return mat;
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
    flame: makeFlamePass(uniforms),
    spark: makeParticlePass(uniforms, true),
    ember: makeParticlePass(uniforms, false),
    smoke: makeSmokePass(uniforms),
    burst: makeBurstPass(uniforms),
    shock: makeShockPass(uniforms),
    uniforms,
  };
}