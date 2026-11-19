// src/render/storm-lance-material.js — Storm Lance 的五个 TSL 材质（v3.20）
//
// 上游是 raw GLSL `ShaderMaterial`（`materials/LightningMaterial.js` 两个 pass +
// `effects/BurstSphere.js` 的 STORM 模式 + `particles/ParticleSystem.js` 的 STREAK）。
// ⚠️⚠️ **本仓一行都不能直接用**：`vendor/three/three.webgpu.js:86728-86740` 的 NodeMaterial
// 库只注册 12 种内置材质，**没有 ShaderMaterial** ⇒ `fromMaterial()` 返回 null →
// `:53536` 报 `Material "ShaderMaterial" is not compatible.` 并回落空材质
// （画面什么都没有，且只有一行 console error）。红线 9 是 WebGPU 唯一后端 ⇒ 必须 TSL 重写。
//
// ## 闪电的三层叠加（这个特效的身份，逐字照上游 `boltPoint`）
//
//   1. **轴**   —— `mix(origin,target,t)` + `sag·sin(t·π)`。唯一知道「指向哪」的部分。
//   2. **扇**   —— 每条丝按 `aStrand` 在垂直面上取常量偏移，`spreadNear→spread` 张开，
//                  并绕轴滚 `twist + twistSpeed·time`。这是丝与丝分开的理由。
//   3. **kink** —— **分段线性** value noise 的 4 个 octave。
//
// ⚠️⚠️ **kink 必须分段线性，不得 smoothstep**。上游注释原文：「Linear on purpose:
// smoothstep would round the corners off, and the corners are the entire reason it
// reads as lightning rather than as a wobbly tube」。换成平滑噪声（含 `mx_noise_float`）
// ⇒ 闪电退化成扭动的管子，而顶点数/相位/draw call 判据全绿。
//
// ## 四条 TSL 口径（每条都有实测依据）
//
// **① 世界空间摆放用 `vertexNode` 而不是 `positionNode`。**
// 参数化几何的 `position` 是 `(t, side, 0)` 不是坐标。`positionNode` 的返回值会被
// `modelViewMatrix` 再乘一次 ⇒ 依赖「mesh 矩阵恒等」这个隐式前提。这里显式输出 clip 位置。
//
// **② 逐 pass 的 varying 用 `varyingProperty`，在 vertexNode 里 assign、colorNode 里读。**
// ⚠️ **不得在 colorNode 里直读 `positionGeometry`** —— 那会在片元阶段重新求值参数化顶点，
// 而 `aStrand` 是 instanced 属性，片元阶段读不到 ⇒ 静默拿到 0。
//
// **③ 反向 smoothstep 一律写 `oneMinus(smoothstep(lo, hi, x))`。**
// 上游 `smoothstep(uProgress, uProgress - tip, vT)` 依赖 `edge0 > edge1`（GLSL 未定义行为）。
//
// **④ 常量色显式拆分量 `vec3(c.r, c.g, c.b)`。**
// `vec3(new THREE.Color(hex))` 在 WebGPU 输出**纯黑且零报错**（v3.14 炮塔三档色调实测：
// 非黑像素数 0 vs 其余四种写法均 10455）。
//
// **主线程专用**：构造 NodeMaterial 必然依赖 three。归属 `render/`。
import * as THREE from 'three';
import {
  Fn, Loop, float, vec2, vec3, vec4, uniform, attribute,
  varyingProperty, mx_noise_float as perlin,
  cameraPosition, cameraProjectionMatrix, modelViewMatrix,
  positionGeometry, normalGeometry,
  sin, cos, abs, pow, mix, select, smoothstep, oneMinus, clamp, max,
  length, normalize, cross, dot, fract, floor, step, Discard,
  PI2,
} from 'three/tsl';
import { STORM_LANCE_FX as FX } from './storm-lance-config.js';

/** hex → 显式分量 vec3（口径 ④，禁 `vec3(Color)`） */
function rgb(hex) {
  const c = new THREE.Color(hex);
  return vec3(c.r, c.g, c.b);
}

/**
 * 上游 `hash11`（`shaders/lib/noise.glsl.js`）逐字重建 —— **不用 vendor 的 `hash`**。
 * 理由：TSL 的 `hash` 与它不是同一个分布，换掉会让全部 kink 形状漂移，
 * 而「闪电看起来还是闪电」⇒ 数值判据拓不到。CPU 侧同款在 `storm-lance-config.js`。
 */
const hash11 = Fn(([p]) => {
  const x = fract(p.mul(0.1031)).toVar();
  x.mulAssign(x.add(33.33));
  x.mulAssign(x.add(x));
  return fract(x);
});

/**
 * **分段线性** value noise（上游 `vnoise`）。⚠️ 中点是 `fract(x)` 而不是 smoothstep。
 * @returns 节点 −1..1
 */
const vnoise = Fn(([x, seed]) => {
  const i = floor(x);
  const f = x.sub(i);
  // 线性插值：mix(a, b, f)。写成 smoothstep(0,1,f) 就把尖角磨圆了。
  return mix(hash11(i.add(seed)), hash11(i.add(1).add(seed)), f).mul(2).sub(1);
});

/**
 * 一条丝相对轴的偏移（上游 `kink`）：5 个 octave，逐 octave 门控。
 * 上游用固定 trip count + `step` 门控而不是动态循环上界（后者不可移植）。
 *
 * ⚠️⚠️ **`Loop` 的第一个参数必须写 `{start, end, type}`，不能写裸数字**（实测踩到）：
 * `Loop(5, ({i}) => …)` 里的 `5` 会被 `nodeArray` 包成 ConstNode（`isNode === true`），
 * 而 `LoopNode.getProperties` 只对 `isNode !== true` 的 param 建 `inputs` 键
 * ⇒ `inputs` 是 `{}` ⇒ 解构出的 `i` 是 **undefined** ⇒ `float(i)` 抛
 * `Cannot read properties of undefined (reading 'mul')`，**整片 pass 不上屏**
 * （实测 lit=0 / blue=0，而材质构造与 Node 单测全绿）。
 * 写成 `{start:0, end:5, type:'int'}` 后 `isNode===false` ⇒ `inputs.i` 存在。
 */
const kinkOffset = Fn(([t, seed, span]) => {
  const o = vec2(0).toVar();
  const amp = float(1).toVar();
  const freq = max(float(FX.jitterScale), float(0.01)).mul(span).toVar();
  const scroll = U.uTime.mul(FX.crawl).toVar();
  Loop({ start: 0, end: 5, type: 'int' }, ({ i }) => {
    const fi = float(i);
    const on = step(fi, float(FX.octaves).sub(1));
    o.x.addAssign(on.mul(amp).mul(vnoise(t.mul(freq).add(scroll), seed.add(fi.mul(13)))));
    o.y.addAssign(on.mul(amp).mul(
      vnoise(t.mul(freq).add(scroll.mul(1.17)), seed.add(71.3).add(fi.mul(13)))));
    amp.mulAssign(FX.jitterFalloff);
    freq.mulAssign(2);
    scroll.mulAssign(1.63);
  });
  return o;
});

/** ridged multifractal（上游 `ridged`，4 octave）—— 爆壳的电弧用它 */
const ridgedFbm = Fn(([p]) => {
  const q = vec3(p).toVar();
  const amp = float(0.5).toVar();
  const sum = float(0).toVar();
  Loop(4, () => {
    sum.addAssign(amp.mul(float(1).sub(abs(perlin(q)))));
    q.mulAssign(2.06);
    amp.mulAssign(0.5);
  });
  return sum;
});

/** 4 octave fbm（上游 `fbm4`）—— 蓄力光球表面用 */
const fbm4 = Fn(([p]) => {
  const q = vec3(p).toVar();
  const amp = float(0.5).toVar();
  const sum = float(0).toVar();
  Loop(4, () => {
    sum.addAssign(amp.mul(perlin(q)));
    q.mulAssign(2.03).addAssign(vec3(17.3, 5.1, 9.7));
    amp.mulAssign(0.5);
  });
  return sum;
});

/**
 * 造一组共享 uniform。**六个材质引用同一组句柄** ⇒ 渲染器每帧只写一次。
 */
function makeUniforms() {
  return {
    /** 绝对秒（与火花 aSpawn 同一时钟，见 geometry 注释） */
    uTime: uniform(0),
    /** 施放内时间（秒）—— 爆壳/环的 age 用它 */
    uAge: uniform(0),
    uOrigin: uniform(new THREE.Vector3()),
    uTarget: uniform(new THREE.Vector3(0, 0, -1)),
    uSide: uniform(new THREE.Vector3(1, 0, 0)),
    uProgress: uniform(0),
    uFade: uniform(1),
    uCharge: uniform(0),
    uSeed: uniform(0),
    uStrands: uniform(FX.strands),
    uGain: uniform(FX.gain),
    /**
     * 爆壳 / 冲击环的**独立淡出与 age**。
     * ⚠️ 不得共用 `uFade`：后者在 hold 期恒 1，共用会让这两个只缩不淡，
     * 寿命到时在满亮度上硬 pop 消失（Nova Beam 版实测踩到）。
     */
    uBurstFade: uniform(0),
    uBurstAge: uniform(0),
    uShockFade: uniform(0),
    uShockAge: uniform(0),
  };
}

/** 模块级 uniform 组（由 createStormLanceMaterials 赋值；Fn 闭包引用它） */
let U = makeUniforms();

/**
 * 束的局部坐标系（上游 `main` 里的 Gram-Schmidt）。
 * 轴从手斜向下，`uSide` 只是近似垂直 ⇒ 必须投影掉平行分量。
 *
 * ⚠️⚠️ **必须是普通 JS 函数，不能用 `Fn` 包**（实测踩到，画面 lit=0）：
 * `Fn` 返回对象时会被包成 **SplitNode**（swizzle），只认 `x/y/z/w` 四通道。
 * 实测：返 `{a,b}` 时碰巧能解构（映到 swizzle 通道），而返
 * `{dir,n1,n2,span}` 时 **四个键全部 undefined** ⇒ `n1.mul(...)` 抛
 * `Cannot read properties of undefined (reading 'mul')` ⇒ 整片 pass 不上屏，
 * 而材质构造与 Node 单测全绿。普通函数直接返节点对象，不经 SplitNode。
 * （它只是「把几行节点表达式装起来」，本来就不需要是 shader 函数。）
 */
function boltFrame() {
  const delta = U.uTarget.sub(U.uOrigin);
  const span = max(length(delta), float(0.01));
  const dir = delta.div(span).toVar();
  const lateral = U.uSide.sub(dir.mul(dot(U.uSide, dir)));
  const latLen = length(lateral);
  const n1 = normalize(select(latLen.greaterThan(1e-4), lateral, cross(dir, vec3(0, 1, 0)))).toVar();
  const n2 = normalize(cross(dir, n1)).toVar();
  return { dir, n1, n2, span };
}

/**
 * 一条丝上一点（上游 `boltPoint` 逐字）。
 * @param t 沿束 0..1 @param seed 该丝本次重击的种子 @param radial 该丝在扇里的位置 0..1
 */
const boltPoint = Fn(([t, seed, radial, n1, n2, span]) => {
  const axis = mix(U.uOrigin, U.uTarget, t).toVar();
  axis.y.addAssign(float(FX.sag).mul(sin(t.mul(Math.PI))));

  // 两端钉直：手端恒钉，远端按 converge 钉（「落在别处读作 bug」——上游注释）
  const pinch = max(float(FX.pinch), float(1e-3));
  const ends = smoothstep(float(0), pinch, t)
    .mul(mix(float(1), smoothstep(float(0), pinch, float(1).sub(t)), clamp(float(FX.converge), 0, 1)));

  const offset = kinkOffset(t, seed, span).mul(FX.jitter).mul(ends).toVar();

  const angle = seed.mul(PI2).add(t.mul(FX.twist).add(U.uTime.mul(FX.twistSpeed)).mul(PI2));
  const reach = mix(float(FX.spreadNear), float(FX.spread),
    pow(clamp(t, 0, 1), max(float(FX.spreadCurve), float(0.01))));
  offset.addAssign(vec2(cos(angle), sin(angle)).mul(reach).mul(radial));

  return axis.add(n1.mul(offset.x)).add(n2.mul(offset.y));
});

/** 六个材质的公共设置（口径见文件头） */
function tune(mat, uniforms) {
  mat.transparent = true;
  mat.depthWrite = false;
  mat.depthTest = true;
  mat.side = THREE.DoubleSide;
  mat.blending = THREE.AdditiveBlending;
  // ⚠️ scene.fogNode 存在（setupFog）⇒ 不关掉的话远处闪电被雾洗成天空色
  mat.fog = false;
  mat.lights = false;
  mat.userData.stormUniforms = uniforms;
  return mat;
}

/**
 * 闪电束的一个 pass。`glow=true` 是宽而淡的光晕，false 是热丝本体。
 * **两个 pass 共用同一份 ribbon 几何**，只差 widthScale 与 passOpacity。
 */
function makeBoltPass(glow, uniforms) {
  const tag = glow ? 'Glow' : 'Core';
  const vT = varyingProperty('float', `vSlT${tag}`);
  const vSide = varyingProperty('float', `vSlSide${tag}`);
  const vStrand = varyingProperty('float', `vSlStrand${tag}`);
  const vFlash = varyingProperty('float', `vSlFlash${tag}`);

  const vertex = Fn(() => {
    const { dir, n1, n2, span } = boltFrame();
    const t = positionGeometry.x;
    const side = positionGeometry.y;
    const strand = attribute('aStrand', 'float');

    // restrike：每秒重新抽 24 次形状；crawl 在其间连续滑动。
    // 两者缺一 ⇒ 保持期读作静态丝带。
    const strike = floor(U.uTime.mul(max(float(FX.restrike), float(0.01))));
    const seed = hash11(strand.mul(7.13).add(U.uSeed).add(strike.mul(3.77))).mul(97).toVar();
    const radial = select(U.uStrands.lessThanEqual(1), float(0),
      strand.div(max(U.uStrands.sub(1), float(1)))).toVar();

    const here0 = boltPoint(t, seed, radial, n1, n2, span).toVar();

    // 有限差分求切线；末端镜像让最后一个节点仍有邻居可看
    const h = float(0.02);
    const ahead = t.add(h);
    const flip = float(1).toVar();
    const aheadClamped = select(ahead.greaterThan(1), t.sub(h), ahead).toVar();
    flip.assign(select(ahead.greaterThan(1), float(-1), float(1)));
    const tangentRaw = boltPoint(aheadClamped, seed, radial, n1, n2, span).sub(here0).mul(flip);
    const tl = length(tangentRaw);
    const tangent = normalize(select(tl.greaterThan(1e-5), tangentRaw, dir));

    // 朝相机展开 ribbon ⇒ 从任何角度看都保持表观粗细，且不是屏幕空间线
    const binRaw = cross(tangent, normalize(cameraPosition.sub(here0)));
    const bl = length(binRaw);
    const binormal = select(bl.greaterThan(1e-4), binRaw.div(max(bl, float(1e-6))), n1);

    // 逐丝频闪（量化到 flickerSpeed，整束同一时钟而不是各自闪）
    const flash = mix(float(1),
      hash11(floor(U.uTime.mul(FX.flickerSpeed)).add(strand.mul(3.7)).add(U.uSeed)),
      float(FX.strandFlash)).toVar();

    const halfWidth = float(FX.width)
      .mul(float(glow ? FX.glowWidth : 1))
      .mul(mix(float(1), float(FX.widthTip), pow(clamp(t, 0, 1), max(float(FX.widthCurve), float(0.01)))))
      .mul(mix(float(FX.coreWidth), float(1), radial))
      .mul(flash).mul(U.uFade);

    const here = here0.add(binormal.mul(side).mul(halfWidth));
    vT.assign(t);
    vSide.assign(side);
    vStrand.assign(radial);
    vFlash.assign(flash);
    return cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(here, 1)));
  });

  const color = Fn(() => {
    const tip = max(float(FX.tipLength), float(1e-3));
    // 口径 ③：反向 smoothstep 写成 1 − smoothstep
    const drawn = oneMinus(smoothstep(U.uProgress.sub(tip), U.uProgress, vT));
    Discard(drawn.lessThanEqual(0.002));

    const v = clamp(abs(vSide), 0, 1);
    const col = vec3(0).toVar();
    const profile = float(0).toVar();
    if (glow) {
      profile.assign(pow(oneMinus(v), max(float(FX.glowFalloff), float(0.05))));
      col.assign(mix(rgb(FX.colorHalo), rgb(FX.colorOuter), profile));
    } else {
      profile.assign(pow(oneMinus(v), max(float(FX.coreSharp), float(0.05))));
      col.assign(mix(rgb(FX.colorOuter), rgb(FX.colorInner), smoothstep(float(0), float(0.5), profile)));
      col.assign(mix(col, rgb(FX.colorCore), smoothstep(float(0.45), float(1), profile)));
    }

    // 前沿是空气真正被击穿的地方
    col.addAssign(rgb(FX.colorCore)
      .mul(smoothstep(U.uProgress.sub(tip.mul(2)), U.uProgress, vT)).mul(FX.tipGlow));

    // 量化频闪（不是正弦呼吸 —— 真闪电是在几个亮度之间跳）
    const flicker = float(1).sub(float(FX.flicker)
      .mul(hash11(floor(U.uTime.mul(FX.flickerSpeed)).add(U.uSeed))));

    const a = profile.mul(drawn).mul(flicker).mul(vFlash).mul(U.uFade)
      .mul(float(glow ? FX.glowOpacity : 1)).mul(FX.opacity)
      .mul(mix(float(1), clamp(float(FX.branchDim), 0, 1), vStrand));
    Discard(a.lessThanEqual(0.003));
    return vec4(col.mul(U.uGain).mul(FX.glow), a);
  });

  const mat = new THREE.MeshBasicNodeMaterial();
  mat.vertexNode = vertex();
  mat.colorNode = color();
  return tune(mat, uniforms);
}

/**
 * 火花（GPU 模拟）—— **速度拉伸的条状**（R3，用户报「曳光效果丢了」）。
 *
 * 上游 `ParticleSystem.js:461-467` 逐字：
 *   velView = (modelViewMatrix * vec4(vel,0)).xyz
 *   dir     = normalize(velView.xy + 1e-5)
 *   perp    = vec2(-dir.y, dir.x)
 *   stretch = 1 + uStretch * length(vel)
 *   corner  = dir*(position.y*size*stretch) + perp*(position.x*size)
 *
 * ⚠️ 上一版用的是圆形羽化 quad（`ParticleShape.SOFT`）⇒ 用户读作「往外冒爆米花」。
 * **拉伸 + 条状轮廓两者缺一都退回圆点**：只拉伸不改轮廓 = 拉长的圆斑；
 * 只改轮廓不拉伸 = 竖直细条（不跟速度方向）。
 */
function makeSparkPass(uniforms) {
  const vAge = varyingProperty('float', 'vSlSparkAge');
  const vUv = varyingProperty('vec2', 'vSlSparkUv');

  const vertex = Fn(() => {
    const origin = attribute('aOrigin', 'vec3');
    const vel = attribute('aVel', 'vec3');
    const spawn = attribute('aSpawn', 'float');
    const life = attribute('aLife', 'float');
    const size = attribute('aSize', 'float');
    const seed = attribute('aSeed', 'float');

    const age = U.uTime.sub(spawn);
    const k = clamp(age.div(max(life, float(1e-3))), 0, 1);
    // 阻力积分（上游 uDrag=1.4）：位移 = v0·(1−e^(−drag·t))/drag
    const drag = float(1.4);
    const integ = float(1).sub(pow(float(2.718281828), drag.mul(age).negate())).div(drag);
    const pos = origin.add(vel.mul(integ))
      .add(vec3(0, float(FX.sparkGravity).mul(age).mul(age).mul(0.5), 0));
    // 当前速度（阻力衰减后）—— 拉伸用它而不是初速，否则末段仍拉长
    const velNow = vel.mul(pow(float(2.718281828), drag.mul(age).negate()));

    // 尺寸曲线：出生 0.02 → 峰值 → 末段 0.25（上游 uSizeIn/uEndSize）
    const sizeCurve = mix(float(0.02), float(1), smoothstep(float(0), float(0.03), k))
      .mul(mix(float(1), float(0.25), smoothstep(float(0.55), float(1), k)));
    const alive = step(float(0), age).mul(step(k, float(0.999)));
    const jitter = float(1).add(perlin(vec3(seed.mul(13.7), k.mul(2.1), 0)).mul(0.15));
    const s = size.mul(sizeCurve).mul(alive).mul(jitter);

    // ---- STREAK：视图空间里沿速度方向拉伸 ----
    const centerView = modelViewMatrix.mul(vec4(pos, 1));
    const velView = modelViewMatrix.mul(vec4(velNow, 0)).xyz;
    const dir2 = normalize(velView.xy.add(vec2(1e-5)));
    const perp2 = vec2(dir2.y.negate(), dir2.x);
    const stretch = float(1).add(float(FX.sparkStretch).mul(length(velNow)));
    const corner = dir2.mul(positionGeometry.y.mul(s).mul(stretch))
      .add(perp2.mul(positionGeometry.x.mul(s)));

    vAge.assign(k);
    vUv.assign(positionGeometry.xy.mul(2));
    return cameraProjectionMatrix.mul(vec4(centerView.xyz.add(vec3(corner, 0)), 1));
  });

  const color = Fn(() => {
    // 条状轮廓（上游 SHAPE==2）：横向窄核 × 纵向线性衰减
    // ⚠️ 不是圆形羽化 —— 那个是 SOFT，用户读作爆米花
    const core = oneMinus(smoothstep(float(0), float(1), abs(vUv.x).mul(3.4)));
    const len = oneMinus(clamp(abs(vUv.y), 0, 1));
    const mask = core.mul(len);
    Discard(mask.lessThanEqual(0.01));
    // 四停靠渐变：白 → 白 → 淡蓝 → 深蓝
    const c0 = rgb(FX.colorSparkA), c1 = rgb(FX.colorSparkB);
    const c2 = rgb(FX.colorSparkC), c3 = rgb(FX.colorSparkD);
    const a1 = mix(c0, c1, smoothstep(float(0), float(0.34), vAge));
    const a2 = mix(a1, c2, smoothstep(float(0.30), float(0.68), vAge));
    const col = mix(a2, c3, smoothstep(float(0.64), float(1), vAge));
    const fade = oneMinus(smoothstep(float(0.55), float(1), vAge));
    const a = mask.mul(fade);
    Discard(a.lessThanEqual(0.003));
    return vec4(col.mul(U.uGain).mul(FX.glow).mul(0.6), a);
  });

  const mat = new THREE.MeshBasicNodeMaterial();
  mat.vertexNode = vertex();
  mat.colorNode = color();
  return tune(mat, uniforms);
}

/**
 * 蓄力光球核心。
 *
 * ⚠️⚠️ **v3.20b 朝胧化**（用户：「边界太清晰，就有点像一个发光的鸡蛋」）。
 * 「发光鸡蛋」有三个可定位的成因，旧实现三个都中了：
 *   ① `alpha = 0.2 + rim·0.9 + …` 的**基础项 0.2** ⇒ 整球不透明 ⇒ 实心蛋；
 *   ② **rim·0.9** 把轮廓边提得比中心还亮 ⇒ 一条亮硬边；
 *   ③ 噪声沿法线位移 **0.24** ⇒ 把球捏成凹凸的蛋形。
 * 现在：基础项 0.04、rim 降到 0.18、位移 0.08，并新增**中心热区**
 * （`pow(facing, orbCoreSharp)`）把亮度从轮廓搬到中心 —— 发光体应当中心最亮。
 *
 * ⚠️ **但光靠这三项仍消不掉硬边**：闭合网格的几何轮廓本身就是硬截断。
 * 真正让它朝胧的是另加的 **径向渐变贴图 billboard 光晕**
 * （`makeStormHaloTexture` + `MeshBasicMaterial`，照祭坛飞龙火球的手法）。
 */
function makeOrbPass(uniforms) {
  const vDisp = varyingProperty('float', 'vSlOrbDisp');
  const vFacing = varyingProperty('float', 'vSlOrbFacing');
  const vNrm = varyingProperty('vec3', 'vSlOrbNrm');

  const vertex = Fn(() => {
    // 光球走 model 矩阵（渲染器摆位置与缩放）
    const n = normalGeometry;
    const np = n.mul(FX.orbScale).add(vec3(U.uSeed.mul(3.1)))
      .sub(vec3(0, U.uTime.mul(FX.orbFlow), 0));
    const disp = fbm4(np).mul(0.6).add(ridgedFbm(np.mul(1.4)).mul(0.4));
    const local = positionGeometry.add(n.mul(disp).mul(FX.orbTurbulence));
    const here = modelViewMatrix.mul(vec4(local, 1));
    vDisp.assign(disp);
    vNrm.assign(n);
    // 视图空间里相机在原点 ⇒ 视线 = −here.xyz
    vFacing.assign(abs(dot(normalize(here.xyz.negate()), normalize(n))));
    return cameraProjectionMatrix.mul(here);
  });

  const color = Fn(() => {
    const facing = clamp(vFacing, 0, 1);
    const rim = pow(oneMinus(facing), float(FX.orbRim));
    // 中心热区：正对视线（facing→1）最亮 ⇒ 读作「从里向外发光」
    const core = pow(facing, float(FX.orbCoreSharp));
    const heat = clamp(vDisp.mul(0.5).add(0.5), 0, 1);
    const fil = smoothstep(float(0.74), float(0.98),
      ridgedFbm(vNrm.mul(FX.orbBands)
        .add(vec3(0, U.uTime.mul(FX.orbFlow * 2), 0)).add(U.uSeed)));
    const col = mix(rgb(FX.colorOuter), rgb(FX.colorInner), heat)
      .mix(rgb(FX.colorCore), clamp(fil.add(core.mul(0.6)), 0, 1))
      .add(rgb(FX.colorCore).mul(fil).mul(1.6));
    const a = float(FX.orbBaseAlpha)
      .add(rim.mul(FX.orbRimAlpha))
      .add(core.mul(FX.orbCoreAlpha))
      .add(fil.mul(FX.orbFilAlpha))
      .mul(U.uCharge).mul(FX.orbOpacity);
    Discard(a.lessThanEqual(0.003));
    return vec4(col.mul(U.uGain).mul(FX.orbGlow), a);
  });

  const mat = new THREE.MeshBasicNodeMaterial();
  mat.vertexNode = vertex();
  mat.colorNode = color();
  return tune(mat, uniforms);
}

/**
 * 落点爆壳 —— **上游 `BurstMode.STORM` 逐字复刻**（R4，用户报「软绵绵」）。
 *
 * 顶点（`BurstSphere.js:44-51`）：
 *   np = normal*(1.6+age*1.4) + seed*13 − vec3(0,time*0.6,0)
 *   n  = fbm4(np)*0.6 + ridged(np*1.3)*0.4
 *   amount = displace*(0.35+age*0.9)
 *   pos = position + normal*n*amount
 *
 * 片元（`:135-149`）：
 *   fil  = ridged(normalW*(5+age*7) + seed*9 + vec3(0,time*3.4,0))
 *   arcs = smoothstep(0.80,0.97,fil) * (1−age*0.6)
 *   rim  = pow(fres,1.6)
 *   color = mix(A,B,heat*0.5) → mix(·,C,arcs) + C*rim*1.2 + C*arcs*2.4
 *   alpha *= (1−age)*(rim*0.55 + arcs*0.9)
 *
 * ⚠️⚠️ **壳必须保持「空」**：上游注释「The shell has to stay *empty*: the body of it
 * contributes almost nothing, and what you see is thin filaments racing over the
 * surface plus the fresnel rim」。电弧阈值放宽 ⇒ 实心球 ⇒ 又变回软绵绵。
 * ⚠️ **扩张走 outQuint**（渲染器侧 `stormBurstScale`），不是 outCubic。
 */
function makeBurstPass(uniforms) {
  const vFacing = varyingProperty('float', 'vSlBurstFacing');
  const vDisp = varyingProperty('float', 'vSlBurstDisp');
  const vNrmW = varyingProperty('vec3', 'vSlBurstNrmW');

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
    // 世界法线：mesh 只做等比缩放（+ squash），故模型法线方向不变
    vNrmW.assign(normalize(n));
    vFacing.assign(abs(dot(normalize(here.xyz.negate()), normalize(n))));
    return cameraProjectionMatrix.mul(here);
  });

  const color = Fn(() => {
    const age = U.uBurstAge;
    // 疾走的分叉电弧（沿法线方向滚动的 ridged 噪声，硬阈值）
    const fil = ridgedFbm(vNrmW.mul(float(5).add(age.mul(7)))
      .add(vec3(U.uSeed.mul(9)))
      .add(vec3(0, U.uTime.mul(3.4), 0)));
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

/**
 * 冲击环（R4「要有冲击波」，上游 `DecalType.SHOCKWAVE`）。
 *
 * 几何是 XY 平面 quad ⇒ 半径 = `length(position.xy)`。
 * ⚠️ **朝向由渲染器写 matrix**：命中实体时朝玩家、命中地面时贴地（R2）。
 * 亮带随 age 从中心向外扫（`uShockAge`），带宽恒定 ⇒ 读作「一圈冲击波荡开」。
 */
function makeShockPass(uniforms) {
  const vR = varyingProperty('float', 'vSlShockR');

  const vertex = Fn(() => {
    vR.assign(length(positionGeometry.xy));
    const here = modelViewMatrix.mul(vec4(positionGeometry, 1));
    return cameraProjectionMatrix.mul(here);
  });

  const color = Fn(() => {
    // 亮带位置随 age 外扩：0.15 → 0.95（留出边缘余量，避免贴 quad 边界被切）
    const front = mix(float(0.15), float(0.95), clamp(U.uShockAge, 0, 1));
    const w = max(float(FX.shockWidth), float(0.01));
    const band = oneMinus(smoothstep(float(0), w, abs(vR.sub(front))));
    // 内侧极淡的余晖（读作波过之后的空气仍在动）
    const inner = oneMinus(smoothstep(float(0), front, vR)).mul(0.12);
    const col = mix(rgb(FX.colorShockA), rgb(FX.colorShockB), band);
    const a = band.add(inner).mul(U.uShockFade).mul(FX.shockIntensity);
    Discard(a.lessThanEqual(0.003));
    return vec4(col.mul(U.uGain).mul(FX.glow).mul(0.8), a);
  });

  const mat = new THREE.MeshBasicNodeMaterial();
  mat.vertexNode = vertex();
  mat.colorNode = color();
  return tune(mat, uniforms);
}

/**
 * 造六个材质 + 共享 uniform 组。
 *
 * ⚠️ **每次调用造一组新 uniform**（不是模块级单例）：fixture 页可能构造多个 Game，
 * 共享单例会让两个实例互相覆写。模块级 `U` 只在本次构造期间被 Fn 闭包捕获。
 *
 * @returns {{glow,core,spark,orb,burst,shock,uniforms}}
 */
export function createStormLanceMaterials() {
  U = makeUniforms();
  const uniforms = U;
  return {
    glow: makeBoltPass(true, uniforms),
    core: makeBoltPass(false, uniforms),
    spark: makeSparkPass(uniforms),
    orb: makeOrbPass(uniforms),
    burst: makeBurstPass(uniforms),
    shock: makeShockPass(uniforms),
    uniforms,
  };
}