// src/render/fire-ring-material.js — 焰魔扩散火圈的两个 TSL 材质（v3.22）
//
// 两个 pass：
//   RING  —— 贴地圆环：径向亮带随 uRadius 外扩 + 火舌噪声侵蚀 + 量化闪烁
//   SPARK —— 环缘条状火星（沿速度拉伸）
//
// ## 结构逐字沿用本仓**已过像素实测**的暖色写法，不新发明
//
//   · 径向亮带 `front / band` → `cinder-fall-material.js:makeShockPass`
//   · 火舌的流场 / 域扭曲 / 侵蚀 / 量化闪烁 → 同文件 `makeFlamePass`
//   · 条状火星的阻力积分 + 屏幕尺寸硬钳 + 四停靠渐变 → 同文件 `makeParticlePass`
//
// ## ⚠️⚠️ uniform 必须**按调用闭包捕获**，不能用模块级 `let U`
//
// `cinder-fall-material.js` / `storm-lance-material.js` 用的是模块级 `let U`，
// 那是因为**一个 Game 只造一组材质**。本渲染器**每个环各造一组**（两只焰魔的
// 半径/淡出/种子互不相同）⇒ 模块级变量会被后一次调用覆写。
// 而 TSL 的 `Fn` 体是**惰性求值**（`ShaderCallNodeInternal.call` 在 GPU build 期才跑 JS），
// 那时读到的 `U` 已是**最后一组** ⇒ 两个环读同一份 uniform。
// 形态：两只焰魔的火圈半径/亮度完全同步（而 activeCount=2、各自 position 正确、
// 所有 Node 侧判据全绿）。故本文件的 pass 工厂**把 uniforms 当参数闭包捕获**。
//
// ## 六条 TSL 口径（每条都有实测依据，违反任一都是「所有非像素判据全绿而画面全错」）
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
// ⚠️ **`Fn` 不返回多键对象**（SplitNode 陷阱：自定义键全部 undefined ⇒ 整片 pass 不上屏）。
//
// **主线程专用**：构造 NodeMaterial 必然依赖 three。归属 `render/`。
import * as THREE from 'three';
import {
  Fn, float, vec2, vec3, vec4, uniform, attribute,
  varyingProperty, mx_noise_float as perlin,
  cameraProjectionMatrix, modelViewMatrix,
  positionGeometry,
  sin, cos, abs, pow, mix, smoothstep, oneMinus, clamp, max, min, step,
  normalize, length, fract, floor, Discard, atan,
} from 'three/tsl';
import { FIRE_RING as FX } from './fire-ring-config.js';

/** hex → 显式分量 vec3（口径 ④，禁 `vec3(Color)`） */
function rgb(hex) {
  const c = new THREE.Color(hex);
  return vec3(c.r, c.g, c.b);
}

/** 2 octave fbm —— 火舌的湍流（两次展开，省一个 Loop 结构） */
const fbm2 = Fn(([p]) => {
  const q = vec3(p).toVar();
  const sum = perlin(q).mul(0.65).toVar();
  q.mulAssign(2.07).addAssign(vec3(11.3, 5.1, 7.7));
  sum.addAssign(perlin(q).mul(0.35));
  return sum;
});

function makeUniforms() {
  return {
    /** 绝对秒（全局单一时钟；火星 aSpawn 与它同源） */
    uTime: uniform(0),
    /** 当前环半径（格）—— CPU 侧 outQuint 算好后写进来 */
    uRadius: uniform(FX.startRadius),
    /**
     * 几何放大倍率（= mesh.scale = endRadius）。
     * 片元里把局部长度换算成**世界米数**，于是 bandWidth 是恒定米数。
     */
    uExtent: uniform(FX.endRadius),
    /** 环的亮度包络（末段淡出） */
    uFade: uniform(0),
    /** 逐环随机种子（两只焰魔的火舌形状不同，不是同一张贴图） */
    uSeed: uniform(0),
    uGain: uniform(FX.gain),
  };
}

/** 公共设置（口径见文件头） */
function tune(mat) {
  mat.transparent = true;
  mat.depthWrite = false;
  mat.depthTest = true;
  mat.side = THREE.DoubleSide;
  mat.fog = false;
  mat.lights = false;
  return mat;
}

/**
 * 贴地火舌环。
 *
 * 几何是 `PlaneGeometry(2,2)` 旋转成 XZ 平面、由渲染器 `scale(endRadius)`
 * ⇒ 顶点局部坐标范围 ±endRadius（**世界米数**）。片元里用它算真实半径，
 * 于是 `bandWidth` 是恒定的米数而不是随半径放大的比例（见 config 的 ⚠️）。
 *
 * ⚠️⚠️⚠️ **半径与方位角必须在片元阶段算，不能在顶点阶段算完传 varying**
 * （本轮隔离探针实测到的真根因）：`PlaneGeometry(2,2)` **只有 4 个顶点**，
 * 四个角的 `length(position.xz)` **恒等于 1.414214**（已程序化核实）⇒
 * 线性插值后 `vR` 在**整个 quad 上恒为该常数**，根本不存在「径向」。
 * 形态：波前扫过 1.414 附近时**整张 13×13 quad 一起亮**（读作实心橙饼），
 * 离开后**整片消失**（实测：常量纯红对照 158340 像素，真实材质只有 452）。
 * 正解：顶点只传**局部坐标 `positionGeometry.xz`**（它在 quad 上是线性的，
 * 插值无损），片元里再 `length()` ⇒ 逐像素真半径。世界米数 = 局部长度 × mesh scale。
 *
 * @param {object} U 本环的 uniform 组（**闭包捕获**，见文件头）
 */
function makeRingPass(U) {
  const vLocal = varyingProperty('vec2', 'vFrRingLocal');

  const vertex = Fn(() => {
    // 只传线性量（局部 xz）—— 半径/角度留到片元算，见函数注释的 ⚠️
    vLocal.assign(positionGeometry.xz);
    const here = modelViewMatrix.mul(vec4(positionGeometry, 1));
    return cameraProjectionMatrix.mul(here);
  });

  const color = Fn(() => {
    // 局部坐标 → 世界米数（mesh.scale 恒为 endRadius，由 uExtent 喂进来）
    const r = length(vLocal).mul(U.uExtent);
    // 方位角（两参 atan 在 WebGPU 下转 atan2）—— 火舌沿圆周分布的坐标
    const vAng = atan(vLocal.y, vLocal.x);
    const front = U.uRadius;
    const w = max(float(FX.bandWidth), float(0.02));
    // 径向亮带：到环心的距离与当前波前的差，带宽恒定（米数）
    const band = oneMinus(smoothstep(float(0), w, abs(r.sub(front))));

    /**
     * 火舌：沿圆周的噪声把环带边缘吃掉。
     * ⚠️ 采样坐标用 **sin/cos 形式的圆周坐标**，不能直接用角度 ——
     * 角度在 ±π 处跳变会让环上出现一条笔直的缝（数值判据拓不到）。
     */
    const flow = vec3(
      sin(vAng).mul(FX.tongueScale),
      cos(vAng).mul(FX.tongueScale).add(r.mul(1.7)),
      U.uTime.mul(FX.flowSpeed).add(U.uSeed.mul(3.1)),
    ).toVar();
    // 域扭曲：先把采样坐标推弯 ⇒ 噪声折成卷曲的火舌（照 makeFlamePass）
    const warp = perlin(flow.mul(0.6)).mul(0.8);
    flow.addAssign(vec3(warp, warp.mul(0.7), warp.mul(0.4)));
    const turb = fbm2(flow);

    // 侵蚀：噪声把环带边缘吃成火舌。
    // ⚠️ **噪声必须能真的把带吃掉**（否则是一条光滑丝带，读作光环而不是火）：
    // 先把 band 乘一个 >1 的增益再减噪声，使得带的外缘（band 小）被吃掉、
    // 内缘（band→1）保留 ⇒ 边缘呈锯齿状火舌。turbulence 控制吃得多狠。
    const eaten = band.mul(float(FX.bandGain)).sub(abs(turb).mul(FX.turbulence));
    const mask = smoothstep(float(0.18), float(0.62), eaten);
    /**
     * 内圈余烬：扫过的地方留一点**越靠波前越亮**的余光。
     * ⚠️⚠️ **不得写成恒定值**（本轮实测缺陷）：恒定 0.14 会把波前以内的
     * **整个圆盘**填成一片橙 ⇒ 用户看到的是实心饼而不是「一圈火」。
     * 取到波前的归一化距离的幂：r→front 时→满，r→0 时→ 0。
     */
    const innerT = clamp(r.div(max(front, float(0.01))), 0, 1);
    // ⚠️ `pow` 的底数不得恰为 0（WGSL 下 pow(0,y) 未定义，可能整片 NaN）
    const inner = oneMinus(smoothstep(float(0), max(front, float(0.01)), r))
      .mul(pow(max(innerT, float(1e-4)), float(FX.innerFalloff)))
      .mul(FX.innerGlow);

    /**
     * 热度：**波前白热 → 带内炽橙 → 外缘暗红**。
     * ⚠️ 口径 ⑤：嵌套 mix，不得链式 `.mix()`。
     */    /**
     * 热度：**带体炽橙 → 窄波前白热 → 外缘暗红**。
     *
     * ⚠️⚠️ **白热区必须窄**（本轮像素实测 + CPU 复刻数学定位）：
     * 旧写法 `heat = band×1.25 + turb×0.18 + 0.2` 在 band≥0.64 就**恒达 1.0**，
     * 而 mask 只在 band 较大处才不为 0 ⇒ **所有画出来的像素都是 colorHot
     * (255,243,208)**，橙色只存在于 alpha≈0 的地方 ⇒ 画面是一条白弧。
     * 实测：藏本体后环像素均值 g>r（168~176 vs 159~172）。
     * 现在把白热限制在**波前最内侧的一小段**（core 取 band 的高次幂），
     * 带体保持炽橙，外缘由 turb 推到暗红。
     */
    const heat = clamp(band.mul(0.85).add(turb.mul(0.22)).add(float(0.12)), 0, 1);
    // 白热核：只有紧贴波前（band→1）才超阈，带宽的约 1/4
    const core = pow(clamp(band, 0, 1), float(FX.coreSharp));
    // 带体基色往红端偏（拉开与亮草地的色相距离，避免读作白弧）
    const body = mix(rgb(FX.colorMid), rgb(FX.colorEdge), float(FX.bodyRedBias));
    const col = mix(
      mix(rgb(FX.colorEdge), body, smoothstep(float(0.15), float(0.55), heat)),
      rgb(FX.colorHot), core,
    );

    // 量化闪烁（真火在几个亮度之间跳，不是正弦呼吸）
    const flick = float(1).sub(float(FX.flicker)
      .mul(fract(sin(floor(U.uTime.mul(18)).mul(12.9898).add(U.uSeed)).mul(43758.5453))));

    const a = clamp(mask.add(inner).mul(U.uFade).mul(FX.opacity), 0, 1);
    Discard(a.lessThanEqual(0.004));
    return vec4(col.mul(U.uGain).mul(flick), a);
  });

  const mat = new THREE.MeshBasicNodeMaterial();
  mat.vertexNode = vertex();
  mat.colorNode = color();
  tune(mat);
  /**
   * ⚠️⚠️ **环走 NormalBlending 而不是 additive**（本轮像素实测）：
   * 暖橙的 r 已≈ 1.0，加法混合只能把 g/b 抬上去 ⇒ 在亮草地上**钳成白**。
   * 实测（藏掉焰魔本体的干净对照）：additive 下环像素均值 **r159 / g170 / b127**
   * —— **g > r**，画面是一条白弧而不是火（与 Cinder Fall 爆壳同一条教训）。
   * 普通混合才能保住橙红色相；alpha 仍由 mask 控制 ⇒ 边缘依旧羽化。
   */
  mat.blending = THREE.NormalBlending;
  return mat;
}

/**
 * 环缘条状火星（STREAK）。结构逐字沿用 `cinder-fall-material.js:makeParticlePass`。
 *
 * ⚠️⚠️ **拉伸 + 条状轮廓缺一都退回圆点**（用户 v3.20 读作「冒爆米花」）：
 * 只拉伸不改轮廓 = 拉长的圆斑；只改轮廓不拉伸 = 竖直细条（不跟速度）。
 *
 * @param {object} U 共享 uniform 组（只用 uTime / uGain）
 */
function makeSparkPass(U) {
  const vAge = varyingProperty('float', 'vFrSpAge');
  const vUv = varyingProperty('vec2', 'vFrSpUv');

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
    const drag = float(FX.sparkDrag);
    const decay = pow(float(2.718281828), drag.mul(age).negate());
    const integ = float(1).sub(decay).div(drag);
    const pos = origin.add(vel.mul(integ))
      .add(vec3(0, float(FX.sparkGravity).mul(age).mul(age).mul(0.5), 0));
    const velNow = vel.mul(decay);

    const sizeCurve = mix(float(0.02), float(1), smoothstep(float(0), float(0.04), k))
      .mul(mix(float(1), float(0.25), smoothstep(float(0.55), float(1), k)));
    const alive = step(float(0), age).mul(step(k, float(0.999)));
    const jitter = float(1).add(perlin(vec3(seed.mul(13.7), k.mul(2.1), 0)).mul(0.18));
    const s0 = size.mul(sizeCurve).mul(alive).mul(jitter);

    const centerView = modelViewMatrix.mul(vec4(pos, 1));
    // 屏幕空间硬钳（玩家可能站在火圈里 ⇒ 粒子离相机 0.3 格）
    const depth = max(centerView.z.negate(), float(0.05));
    const sCap = depth.mul(float(FX.sparkMaxScreen).mul(1.4));
    const s = min(s0, sCap);

    // 沿速度方向拉伸（视图空间）
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
    // 条状轮廓：横向窄核 × 纵向线性衰减（**不是圆形 mask**）
    const core = oneMinus(smoothstep(float(0), float(1), abs(vUv.x).mul(3.4)));
    const len = oneMinus(clamp(abs(vUv.y), 0, 1));
    const mask = core.mul(len);
    Discard(mask.lessThanEqual(0.01));
    // 四停靠渐变（口径 ⑤：嵌套 mix）
    const a1 = mix(rgb(FX.colorSparkA), rgb(FX.colorSparkB), smoothstep(float(0), float(0.34), vAge));
    const a2 = mix(a1, rgb(FX.colorSparkC), smoothstep(float(0.30), float(0.68), vAge));
    const col = mix(a2, rgb(FX.colorSparkD), smoothstep(float(0.64), float(1), vAge));
    const fade = oneMinus(smoothstep(float(0.5), float(1), vAge));
    const a = mask.mul(fade);
    Discard(a.lessThanEqual(0.003));
    return vec4(col.mul(U.uGain), a);
  });

  const mat = new THREE.MeshBasicNodeMaterial();
  mat.vertexNode = vertex();
  mat.colorNode = color();
  tune(mat);
  // 火星是小白热亮点，additive 才读作「迸出的火」（同 Cinder / Storm 的火星）
  mat.blending = THREE.AdditiveBlending;
  return mat;
}

/**
 * 造一组 uniform + 环材质（**每个环一组**，闭包捕获 ⇒ 互不覆写）。
 * @returns {{ring:THREE.MeshBasicNodeMaterial, uniforms:object}}
 */
export function createFireRingMaterial() {
  const uniforms = makeUniforms();
  return { ring: makeRingPass(uniforms), uniforms };
}

/**
 * 造火星材质（**全局一个池**，只需 uTime / uGain）。
 * @returns {{spark:THREE.MeshBasicNodeMaterial, uniforms:object}}
 */
export function createFireSparkMaterial() {
  const uniforms = makeUniforms();
  return { spark: makeSparkPass(uniforms), uniforms };
}