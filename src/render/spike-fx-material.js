// src/render/spike-fx-material.js — 尖刺破土火星 / 上浮余烬的两个 TSL 材质（v3.23）
//
// 两个 pass：
//   SPARK —— 条状火星（沿速度拉伸，破土那一瞬迸出去的锐利感）
//   EMBER —— 圆点余烬（往上飘，烧着的碎屑慢慢升起来）
//
// ## 结构逐字沿用本仓**已过像素实测**的暖色写法，不新发明
//
// 阻力积分位移 + 屏幕尺寸硬钳 + 四停靠渐变 + 视图空间沿速度拉伸
// → `fire-ring-material.js:makeSparkPass` / `cinder-fall-material.js:makeParticlePass`。
// 两者的**唯一实质差异**在这里是「重力符号」：火星 `sparkGravity < 0`（下坠），
// 余烬 `emberRise > 0`（上浮）。⚠️ 照抄同一个符号会让余烬往下掉，
// 读作「碎屑落地」而不是「烧着往上飘」，而所有计数/可见性判据全绿。
//
// ## 六条 TSL 口径（每条都有实测依据，违反任一都是「非像素判据全绿而画面全错」）
//
//   ① 世界摆放走 `vertexNode`（`positionNode` 的返回值会被 `modelViewMatrix` 再乘一次）；
//   ② 逐 pass 的 varying 用 `varyingProperty`，顶点写、片元读
//      （片元阶段读不到 instanced 属性，直读 `positionGeometry` 会静默拿 0）；
//   ③ 反向 smoothstep 写 `oneMinus(smoothstep(lo,hi,x))`；
//   ④ **常量色显式拆分量 `vec3(c.r,c.g,c.b)`** —— `vec3(new THREE.Color(hex))`
//      在 WebGPU 输出**纯黑且零报错**（v3.14 实测非黑像素 0 vs 10455）；
//   ⑤ **多层渐变一律嵌套 `mix(mix(a,b,t),c,t2)`，不得链式 `.mix()`**
//      （v3.21 实测：链式让暖色像素 78620 → 88，几乎全灭）；
//   ⑥ **节点不得与裸 JS 数字做算术**（`float(x) * 1.4` 生成 `NaN.0` 废掉整条管线），
//      一律 `.mul(1.4)`。
//
// ⚠️ **uniform 按调用闭包捕获，不用模块级 `let U`**（v3.22 火圈实测教训）：
// TSL 的 `Fn` 体是**惰性求值**（GPU build 期才跑 JS），模块级变量会被后一次构造覆写
// ⇒ 两个池读同一份 uTime。本文件两个 pass 工厂各把 uniforms 当参数捕获。
//
// ⚠️⚠️ **`aSpawn` 与 `uTime` 必须同一个时钟（绝对秒）**：混用两个时基的形态是
// 「粒子在某个瞬间全部消失」而相位/可见性/draw call 判据全绿（v3.20 实测）。
//
// **主线程专用**：构造 NodeMaterial / BufferGeometry 必然依赖 three。归属 `render/`。
import * as THREE from 'three';
import {
  Fn, float, vec2, vec3, vec4, uniform, attribute,
  varyingProperty, mx_noise_float as perlin,
  cameraProjectionMatrix, modelViewMatrix,
  positionGeometry,
  abs, pow, mix, smoothstep, oneMinus, clamp, max, min, step,
  normalize, length, Discard,
} from 'three/tsl';
import { SPIKE_SPARK_FX as FX } from './spike-fx-config.js';

/** hex → 显式分量 vec3（口径 ④，禁 `vec3(Color)`） */
function rgb(hex) {
  const c = new THREE.Color(hex);
  return vec3(c.r, c.g, c.b);
}

function makeUniforms() {
  return {
    /** 绝对秒（全局单一时钟；粒子 aSpawn 与它同源） */
    uTime: uniform(0),
    uGain: uniform(FX.gain),
  };
}

/** 公共设置（口径见文件头） */
function tune(mat) {
  mat.transparent = true;
  mat.depthWrite = false;
  mat.depthTest = true;
  mat.side = THREE.DoubleSide;
  // ⚠️ scene.fogNode 存在（setupFog）⇒ 不关掉的话远处火星被雾洗成天空色
  mat.fog = false;
  mat.lights = false;
  // 火星与余烬都是自发光亮点 ⇒ additive 才读作「迸出的火」（同 Cinder / 火圈的火星）
  mat.blending = THREE.AdditiveBlending;
  return mat;
}

/**
 * 一个粒子 pass。`streak=true` 是条状火星，false 是圆点余烬。
 *
 * ⚠️⚠️ **拉伸 + 条状轮廓缺一都退回圆点**（用户 v3.20 读作「冒爆米花」）：
 * 只拉伸不改轮廓 = 拉长的圆斑；只改轮廓不拉伸 = 竖直细条（不跟速度方向）。
 *
 * @param {object} U 本池的 uniform 组（**闭包捕获**，见文件头）
 * @param {boolean} streak
 */
function makeParticlePass(U, streak) {
  const tag = streak ? 'Sp' : 'Em';
  const vAge = varyingProperty('float', `vSk${tag}Age`);
  const vUv = varyingProperty('vec2', `vSk${tag}Uv`);
  const P = streak
    ? { drag: FX.sparkDrag, gravity: FX.sparkGravity, cap: FX.sparkMaxScreen,
      cA: FX.colorSparkA, cB: FX.colorSparkB, cC: FX.colorSparkC, cD: FX.colorSparkD }
    : { drag: FX.emberDrag, gravity: FX.emberRise, cap: FX.emberMaxScreen,
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
     * ⚠️⚠️ **屏幕空间尺寸硬钳**：玩家可能正站在刺上（尖刺伤害判据就是「压在刺格内」）
     * ⇒ 粒子离相机 0.3 格，固定世界尺寸会投影成上百像素的大光斑
     * （Cinder Fall 实测的「爆米花」成因）。
     *   视图空间半高 = |z|·tan(fov/2)，投影后尺寸 ∝ s/|z|
     *   ⇒ s_max = |z|·cap·2tan(fov/2)，本仓 fov 70° ⇒ 2tan35° ≈ 1.40
     */
    const depth = max(centerView.z.negate(), float(0.05));
    const sCap = depth.mul(float(P.cap).mul(1.4));
    const s = min(s0, sCap);

    const corner = vec2(0).toVar();
    if (streak) {
      // 沿速度方向拉伸（视图空间）—— 上游 ParticleSystem.js:461-467 逐字
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
      // 条状轮廓：横向窄核 × 纵向线性衰减（**不是圆形 mask**）
      const core = oneMinus(smoothstep(float(0), float(1), abs(vUv.x).mul(3.4)));
      const len = oneMinus(clamp(abs(vUv.y), 0, 1));
      mask.assign(core.mul(len));
    } else {
      // 圆点羽化（余烬就该是圆的小亚光点）
      mask.assign(oneMinus(smoothstep(float(0.15), float(1), length(vUv))));
    }
    Discard(mask.lessThanEqual(0.01));
    // 四停靠渐变（口径 ⑤：嵌套 mix，不得链式 .mix）
    const a1 = mix(rgb(P.cA), rgb(P.cB), smoothstep(float(0), float(0.34), vAge));
    const a2 = mix(a1, rgb(P.cC), smoothstep(float(0.30), float(0.68), vAge));
    const col = mix(a2, rgb(P.cD), smoothstep(float(0.64), float(1), vAge));
    const fade = oneMinus(smoothstep(float(0.5), float(1), vAge));
    const a = mask.mul(fade);
    Discard(a.lessThanEqual(0.003));
    return vec4(col.mul(U.uGain), a);
  });

  const mat = new THREE.MeshBasicNodeMaterial();
  mat.vertexNode = vertex();
  mat.colorNode = color();
  return tune(mat);
}

/**
 * 粒子 quad + 六个逐实例出生属性（照 `fire-ring-renderer.js:createFireRingSparkGeometry`）。
 *
 * ⚠️ **`aVel` 是 STREAK 拉伸的输入**：shader 用它算屏幕空间方向与拉伸倍数。
 * 只写位置不写速度会让全部火星退化成圆点（用户读作「冒爆米花」）。
 *
 * ⚠️ **`boundingSphere` 取 1e4**：几何自身在单位立方内，实际被 shader 摆到几十格外
 * ⇒ 正常包围球会让它被误剔除。渲染器另设 `frustumCulled=false` 双保险。
 *
 * @param {number} capacity 环形缓冲容量
 * @returns {THREE.InstancedBufferGeometry}
 */
export function createSpikeSparkGeometry(capacity) {
  const cap = Math.max(1, Math.round(capacity));
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
  ]), 3));
  geometry.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));

  const mk = (name, itemSize) => {
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(cap * itemSize), itemSize);
    attr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(name, attr);
    return attr;
  };
  mk('aOrigin', 3);
  mk('aVel', 3);
  mk('aSpawn', 1);
  mk('aLife', 1);
  mk('aSize', 1);
  mk('aSeed', 1);

  // 初始全部「已死」：aSpawn 远在过去、aLife 极小 ⇒ age/life > 1 ⇒ shader 缩零
  const spawn = geometry.getAttribute('aSpawn');
  const life = geometry.getAttribute('aLife');
  for (let i = 0; i < cap; i++) { spawn.setX(i, -1e3); life.setX(i, 1e-3); }

  geometry.instanceCount = cap;
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  return geometry;
}

/**
 * 造火星材质 + 它自己那组 uniform（**闭包捕获** ⇒ 与余烬池互不覆写）。
 * @returns {{spark:THREE.MeshBasicNodeMaterial, uniforms:object}}
 */
export function createSpikeSparkMaterial() {
  const uniforms = makeUniforms();
  return { spark: makeParticlePass(uniforms, true), uniforms };
}

/**
 * 造余烬材质 + 它自己那组 uniform。
 * @returns {{ember:THREE.MeshBasicNodeMaterial, uniforms:object}}
 */
export function createSpikeEmberMaterial() {
  const uniforms = makeUniforms();
  return { ember: makeParticlePass(uniforms, false), uniforms };
}