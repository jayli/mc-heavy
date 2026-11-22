// src/render/storm-grade.js — 雨天光影档的后处理链（WebGPU RenderPipeline + TSL）
//
// 上游：`bj-shooting-game/night-heron-src/src/gfx/renderer.js` 的
// COMPOSITE_FRAG（体积雾 + 远景雨幕）→ BLOOM_DOWN/UP → GRADE_FRAG（色差/暗角/冷调）。
// 常量在 `storm-grade-config.js`（three-free，可单测）。
//
// ## 移植范围（用户 2026-11-22 第二轮裁定）
//   · 弹孔不做（`carbine-fx.enableHoles = false`）；
//   · CA 与暗角：本仓此前**零实现**（程序化扫描确认）⇒ 照移植；
//   · ACES：本仓 renderer 已有（v1.70）⇒ **不重复移植**，由 RenderPipeline 链尾接上。
//
// ## 与上游的架构差异（必要适配）
//
// 上游是 WebGLRenderer + 手写 FullScreenQuad + 8 个 WebGLRenderTarget。
// 本仓是 WebGPURenderer（红线 9）⇒ 用 three 的 `RenderPipeline`（r183 起
// PostProcessing 已改名）+ `pass()` / `convertToTexture()`，RT 生命周期由 three 管。
//
// ## 三条载荷性约束
//
// ① **`pipeline.render()` 替代 `renderer.render()`**：它内部临时把 toneMapping 置
//    NoToneMapping、渲完恢复，并在链尾接 `renderOutput`（ACES + sRGB）
//    ⇒ **ACES 只应用一次**。
// ② **水面反射仍在 pipeline.render() 之前手动跑**（v3.17 的索引表约束不变）。
// ③ **bloom 用 convertToTexture 链**：three 的 RTTNode 自动跟随 drawing buffer 尺寸。
//
// ## 性能（用户明确要求）
//   · 关闭时整条链不跑（Game 直接 renderer.render，逐位回到改动前）；
//   · bloom 级数按分辨率档减（5 → 4）；
//   · 体积雾与远景雨幕合在一个 pass；
//   · 色差/暗角在 grade pass 顺带算；
//   · **不做 FXAA**：本仓 renderer 已开 MSAA（上游 antialias:false 才需要它）。
//
// ## 两处刻意简化（成本/复杂度取舍，注释里写明）
//   · **bloom 用双线性 4 抽头降采样**而不是上游的 13 抽头：mip 链本身是低通，
//     13 抽头的额外质量在 5 级链上肉眼不可辨，而采样数少 3.25×；
//   · **视线方向用固定 fov 近似**（本仓相机 fov 恒 70）而不是反投影矩阵：
//     体积雾与远景雨幕都是低频效果，近似误差远小于噪声调制幅度。
import * as THREE from 'three';
import {
  float, vec2, vec3, vec4, uniform, mix, max, min,
  abs, pow, dot, atan, normalize, length, smoothstep, oneMinus, clamp,
  floor, fract, hash, texture, mx_noise_float as perlin,
  pass, screenUV, convertToTexture, screenSize, renderOutput,
  cameraProjectionMatrixInverse, cameraWorldMatrix,
} from 'three/tsl';
import {
  STORM_FOG as FO, STORM_FAR_RAIN as FR, STORM_BLOOM as BL, STORM_GRADE as GR,
  stormBloomLevels,
} from './storm-grade-config.js';

/** 1×1 黑占位图（条纹图未就绪时的安全默认；懒建、全局共享） */
let _sheetPlaceholder = null;
function placeholderSheet() {
  if (!_sheetPlaceholder) {
    _sheetPlaceholder = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
    _sheetPlaceholder.wrapS = THREE.RepeatWrapping;
    _sheetPlaceholder.wrapT = THREE.RepeatWrapping;
    _sheetPlaceholder.colorSpace = THREE.NoColorSpace;
    _sheetPlaceholder.needsUpdate = true;
  }
  return _sheetPlaceholder;
}

/**
 * 后处理链的 uniform（模块级单例，装配层每帧写）。
 * ⚠️ `uEnabled = 0` 时全部效果中性（增益全 0）⇒ 输出逐位等于输入，供 Tier 4 A/B。
 *
 * ⚠️⚠️ **`uRainSheet` 必须是真实纹理**（本轮用户报告「雨雾像光栅扫描」的根因）：
 * 旧实现用 `hash(floor(uv))` 造雨丝 ⇒ **硬格子**，实测相邻像素 82% 完全相同
 * （场景本身只 4.6%）⇒ 大面积平坦色块 + 硬边界 = 光栅扫描观感。
 * 上游用的是**双线性采样的条纹纹理**（makeRainSheet：900 条竖直渐变细丝）。
 * 缺图时（加载失败）`uRainSheetOn = 0` ⇒ 远景雨幕层整体不画，其余效果照常。
 */
export const GRADE_UNIFORMS = {
  uEnabled: uniform(0),
  uTime: uniform(0),
  uSunDir: uniform(new THREE.Vector3(0, 0.8, 0.6)),
  uSkyDim: uniform(1),
  uFogGain: uniform(FO.gain),
  uRainGain: uniform(FR.gain),
  uBloomGain: uniform(BL.gain),
  uCA: uniform(GR.ca),
  uVignette: uniform(GR.vignette),
  uCold: uniform(GR.coldWeight),
  uGrain: uniform(GR.grain),
  /** 条纹图就绪门（0 = 不画远景雨幕） */
  uRainSheetOn: uniform(0),
};


/**
 * 远景雨幕的**纹理节点**（模块级单例，构造时绑占位图）。
 *
 * ⚠️⚠️ **必须传真实 Texture 实例，不能传 uniform(Texture)**（本轮全屏黑的根因）：
 * `texture(GRADE_UNIFORMS.uRainSheet, …)` 里第一个参数是 **UniformNode**，
 * 而 `TextureNode.setup` 要求 `value.isTexture === true` ⇒ 抛
 * `THREE.TSL: texture(value) function expects a valid instance of THREE.Texture()`
 * ⇒ **整条后处理链 build 失败 ⇒ 全屏黑（只剩 HUD/面板）**。
 * 正解：用真实 Texture 构造节点一次，加载完成后改 `node.value`（three 支持热替换）。
 */
const RAIN_SHEET_NODE = texture(placeholderSheet());

/**
 * 一层远景雨幕（上游 `rainLayer` 逐字）。
 *
 * 上游：`uv = (az/2π*tiles + el*wind + seed, el*L*0.22 + t*speed + seed*3.7)`，
 * 采样雨丝贴图的 .r。
 *
 * ⚠️⚠️ **必须采样纹理，不能用 hash 格子**（本轮像素实测的根因）：
 * `hash(floor(vec2(u*32, v*1.5)))` 是**硬格子** —— 每个 cell 整体亮或整体暗
 * ⇒ 屏幕上是一片轴对齐矩形块（用户读作「光栅扫描渲染」）。
 * 实测：雨幕层相邻像素**完全相同 82.06%**（场景本身 4.63%）。
 * 纹理是 900 条**亚像素宽、带纵向渐变的细丝** + 双线性/mip 采样 ⇒ 软、细、无块。
 */
function farRainLayer(az, el, t, layer) {
  const u = az.div(6.2831853).mul(layer.tiles).add(el.mul(FR.wind)).add(layer.seed);
  const v = el.mul(layer.L * 0.22).add(t.mul(layer.speed)).add(layer.seed * 3.7);
  return RAIN_SHEET_NODE.sample(vec2(u, v)).r;
}

/** 体积雾 + 远景雨幕（一个 pass，上游 COMPOSITE_FRAG 同口径） */
function compositeNode(scenePass) {
  const U = GRADE_UNIFORMS;
  const colorNode = scenePass.getTextureNode('output');
  /**
   * 视线方向：**用真实相机矩阵反投影**（上游 `uInvProj` + `uCamWorld` 同口径）。
   *
   * ⚠️⚠️ 旧实现用固定 fov 的常量近似 `vec3(c.x*2.24, -c.y*1.4, -1)`，
   * 且**没有转到世界空间** ⇒ 雾与远景雨幕的柱面坐标跟着屏幕而不是世界
   * ⇒ 转镜头时雨幕跟着屏幕转（读作贴在屏幕上的一层网格）。
   * 现在：屏幕 uv → 相机空间射线（过 inverse projection）→ 世界空间（过 cameraWorldMatrix）。
   * ⚠️ 宽高比用 `screenSize` 取真实值，不写死 1.6。
   */
  const ndc = screenUV.mul(2).sub(vec2(1, 1));
  const clip = vec4(ndc.x, ndc.y.negate(), float(1), float(1));
  const viewRay = cameraProjectionMatrixInverse.mul(clip);
  const rdView = normalize(viewRay.xyz.div(viewRay.w.abs().max(1e-5)));
  const rd = normalize(cameraWorldMatrix.mul(vec4(rdView, 0)).xyz);
  const viewZ = scenePass.getViewZNode().abs();
  const T = min(viewZ, float(FO.maxDistance));

  /**
   * 体积雾的空间噪声：**连续 Perlin**（上游采样噪声贴图）。
   * ⚠️ 旧实现 `hash(floor(... * 24))` 是硬格子 ⇒ 雾也是一片矩形斑
   * （实测 fogOnly 层相邻像素完全相同 22.34%，且跳变间距集中在 2~6px）。
   * 改用 `mx_noise_float`（平滑插值）+ 两层 octave ⇒ 连续云难感。
   */
  const nCoord = vec3(
    rd.x.mul(FO.noiseScale).add(rd.y.mul(FO.noiseYScale)),
    rd.z.mul(FO.noiseScale),
    U.uTime.mul(FO.noiseSpeed),
  );
  const n1 = perlin(nCoord.mul(2.2)).mul(0.5).add(0.5);
  const n2 = perlin(nCoord.mul(5.1).add(vec3(11.3, 7.1, 3.7))).mul(0.5).add(0.5);
  const n = n1.mul(0.65).add(n2.mul(0.35));
  const noiseK = float(FO.noiseBase).add(n.mul(FO.noiseRange));
  const sunDot = max(dot(rd, normalize(U.uSunDir)), float(0));
  const sunTerm = pow(sunDot, FO.sunSharpness).mul(FO.sunWeight);
  const distK = T.div(T.add(float(18.0)));
  const ins = vec3(FO.sunColor[0], FO.sunColor[1], FO.sunColor[2]).mul(sunTerm)
    .add(vec3(FO.skyColor[0], FO.skyColor[1], FO.skyColor[2]))
    .mul(distK).mul(noiseK).mul(U.uFogGain).mul(U.uSkyDim).mul(U.uEnabled);

  // 远景雨幕（三层柱面投影）
  const az = atan(rd.x, rd.z);
  const horiz = max(length(vec2(rd.x, rd.z)), float(0.25));
  const el = rd.y.div(horiz);
  const L0 = FR.layers[0]; const L1 = FR.layers[1]; const L2 = FR.layers[2];
  const rain = farRainLayer(az, el, U.uTime, L0)
    .mul(smoothstep(float(L0.near), float(L0.far), T)).mul(L0.weight)
    .add(farRainLayer(az, el, U.uTime, L1)
      .mul(smoothstep(float(L1.near), float(L1.far), T)).mul(L1.weight))
    .add(farRainLayer(az, el, U.uTime, L2)
      .mul(smoothstep(float(L2.near), float(L2.far), T)).mul(L2.weight))
    .mul(oneMinus(smoothstep(float(FR.elevationFrom), float(FR.elevationTo), abs(el))));
  const amb = vec3(FO.skyColor[0], FO.skyColor[1], FO.skyColor[2]).mul(U.uSkyDim);
  const rainLit = ins.mul(FR.insGain).add(amb.mul(FR.ambGain))
    .mul(rain).mul(U.uRainGain).mul(U.uRainSheetOn).mul(U.uEnabled);

  return vec4(colorNode.rgb.add(ins).add(rainLit), colorNode.a);
}

/** 双线性 4 抽头降采样（见文件头「刻意简化」） */
function down4(src, texel) {
  const s = (x, y) => src.sample(screenUV.add(texel.mul(vec2(x, y)))).rgb;
  return s(-1, -1).add(s(1, -1)).add(s(-1, 1)).add(s(1, 1)).mul(0.25);
}

/** 亮部提取（软膝，上游 pre() 逐字）+ 降采样 */
function bloomDownFirst(src, texel) {
  const knee = float(BL.threshold * BL.kneeRatio);
  const thr = float(BL.threshold);
  const s = (x, y) => {
    const c0 = src.sample(screenUV.add(texel.mul(vec2(x, y)))).rgb;
    const c = min(c0, vec3(BL.clampMax, BL.clampMax, BL.clampMax));
    const br = max(c.r, max(c.g, c.b));
    const soft = clamp(br.sub(thr).add(knee), float(0), knee.mul(2));
    const softOut = soft.mul(soft).div(knee.mul(4).add(1e-4));
    return c.mul(max(softOut, br.sub(thr)).div(max(br, float(1e-4))));
  };
  return s(-1, -1).add(s(1, -1)).add(s(-1, 1)).add(s(1, 1)).mul(0.25);
}

/** 上采样 tent（3×3 权重 4/2/1 除以 16，上游 BLOOM_UP 逐字） */
function bloomUp(src, base, texel, spread) {
  const s = (x, y) => src.sample(screenUV.add(texel.mul(vec2(x, y)))).rgb;
  const sum = s(0, 0).mul(4)
    .add(s(1, 0).add(s(-1, 0)).add(s(0, 1)).add(s(0, -1)).mul(2))
    .add(s(1, 1).add(s(-1, 1)).add(s(1, -1)).add(s(-1, -1)));
  return base.sample(screenUV).rgb.add(sum.mul(spread.div(16)));
}

/** 色彩分级（上游 GRADE_FRAG，**去掉 aces()**：renderer 已应用） */
function gradeNode(hdr, bloom) {
  const U = GRADE_UNIFORMS;
  const c = screenUV.sub(vec2(0.5, 0.5));
  const r2 = dot(c, c);
  const off = c.mul(float(GR.caBase).add(r2.mul(GR.caRadial))).mul(U.uCA).mul(U.uEnabled);
  const hdrC = vec3(
    hdr.sample(screenUV.add(off)).r,
    hdr.sample(screenUV).g,
    hdr.sample(screenUV.sub(off)).b,
  );
  const blC = vec3(
    bloom.sample(screenUV.add(off.mul(1.5))).r,
    bloom.sample(screenUV).g,
    bloom.sample(screenUV.sub(off.mul(1.5))).b,
  );
  const col0 = hdrC.add(blC.mul(U.uBloomGain).mul(U.uEnabled)).mul(GR.exposure);
  const vig = oneMinus(smoothstep(float(GR.vignetteFrom), float(GR.vignetteTo), r2)
    .mul(U.uVignette).mul(U.uEnabled));
  const col1 = col0.mul(vig);
  /**
   * ⚠️⚠️ **冷调与 S 曲线必须在 ACES 之后的显示空间做**（本轮像素实测的根因）：
   * 上游 GRADE_FRAG 的顺序是「暗角 → **aces()** → 冷调 → S曲线 → pow(1/2.2)」，
   * 即 col ∈ [0,1] 的显示值。本仓 renderer 已设 ACES，链尾 `renderOutput` 才做它
   * ⇒ 若在这里（**线性空间**）做 S 曲线 `col²(3−2col)`，暗部 col≪1 会被
   * **平方级压暗**（0.02 → 0.0012）⇒ 再过 ACES ⇒ **天空/暗部近黑**。
   * 实测：全效果天空近黑占比 **0.1436**，关掉分级三项后 **0.0064**（≈ 无链的 0.0088）。
   *
   * ⇒ 正解：本 pass 只做**线性空间该做的事**（bloom 叠加、曝光、暗角、色差、颗粒），
   * 把冷调与 S 曲线移到 `renderOutput` **之后**（见 createStormGrade 的 outputColorTransform=false
   * + 显式 renderOutput + 分级尾段）。
   */
  const g = hash(floor(screenUV.mul(screenSize))
    .add(vec2(fract(U.uTime.mul(7.31)).mul(113), fract(U.uTime.mul(7.31)).mul(113))))
    .sub(0.5);
  const lumaLin = dot(col1, vec3(0.2126, 0.7152, 0.0722));
  const grainK = U.uGrain.mul(U.uEnabled)
    .mul(float(1 - GR.grainDarkBoost).add(oneMinus(lumaLin.min(1)).mul(GR.grainDarkBoost)));
  return vec4(col1.add(g.mul(grainK)), 1);
}

/**
 * 分级尾段（**在 ACES + sRGB 之后**，上游 GRADE_FRAG 的冷调 / S 曲线 / tint 段）。
 *
 * ⚠️ 入参是**显示空间**的 vec4（col ∈ [0,1]）—— 与上游 aces() 之后的 col 同一口径。
 * ⚠️ 这里不再做 pow(1/2.2)：`renderOutput` 已完成 sRGB 编码（上游是手写 gamma）。
 */
function gradeTailNode(displayCol) {
  const U = GRADE_UNIFORMS;
  const col = displayCol.rgb;
  const luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  const coldK = oneMinus(smoothstep(float(GR.coldFrom), float(GR.coldTo), luma))
    .mul(U.uCold).mul(U.uEnabled);
  const col2 = mix(col, col.mul(vec3(GR.coldTint[0], GR.coldTint[1], GR.coldTint[2])), coldK);
  const sc = col2.mul(col2).mul(vec3(3, 3, 3).sub(col2.mul(2)));
  const col3 = mix(col2, sc, float(GR.contrastMix).mul(U.uEnabled));
  return vec4(col3, displayCol.a);

}

/**
 * 建后处理链。
 * @param {{renderer: object, scene: object, camera: object,
 *          mode?: 'sharp'|'performance', sunDir?: object, skyDim?: object}} deps
 */
export function createStormGrade({ renderer, scene, camera, mode = 'sharp', sunDir, skyDim }) {
  const U = GRADE_UNIFORMS;
  // 复用体素的 uniform 实例（红线 1：日夜/太阳方向只有一份权威）
  if (sunDir) U.uSunDir = sunDir;
  if (skyDim) U.uSkyDim = skyDim;

  const scenePass = pass(scene, camera);
  const composite = convertToTexture(compositeNode(scenePass));
  let levels = stormBloomLevels(mode);
  let downs = [];
  let bloomOut = null;

  const buildChain = () => {
    downs = [];
    let src = composite;
    for (let i = 0; i < levels; i++) {
      // 纹素尺寸 = 1 / (屏幕尺寸 × 2^(i+1))。screenSize 是 RT 尺寸（自动跟随）。
      const scale = Math.pow(2, i + 1);
      const texel = vec2(float(1), float(1)).div(screenSize.mul(scale));
      const node = i === 0 ? bloomDownFirst(src, texel) : down4(src, texel);
      const t = convertToTexture(node);
      downs.push(t);
      src = t;
    }
    let up = downs[levels - 1];
    for (let i = levels - 2; i >= 0; i--) {
      const scale = Math.pow(2, i + 2);
      const texel = vec2(float(1), float(1)).div(screenSize.mul(scale));
      up = convertToTexture(bloomUp(up, downs[i], texel, float(BL.spread)));
    }
    return up;
  };
  bloomOut = buildChain();
  /**
   * ⚠️⚠️ **outputColorTransform = false + 显式 renderOutput**（v3.30d）：
   * 分级分两段 —— 线性段（bloom/曝光/暗角/色差/颗粒）→ **ACES + sRGB** →
   * 显示段（冷调 / S 曲线）。上游 GRADE_FRAG 就是这个顺序。
   * 若保持 true，three 会在**最外层**接 renderOutput ⇒ 冷调与 S 曲线落在线性空间
   * ⇒ 暗部被平方级压暗 ⇒ 天空近黑（实测 0.1436 vs 0.0064）。
   * ⚠️ 置 false 后**必须自己调 renderOutput**，否则画面是线性值（发灰、无 gamma）。
   */
  const buildOutput = () => gradeTailNode(
    renderOutput(gradeNode(composite, bloomOut), renderer.toneMapping, renderer.outputColorSpace),
  );
  const pipeline = new THREE.RenderPipeline(renderer, buildOutput());
  pipeline.outputColorTransform = false;

  return {
    pipeline,
    uniforms: U,
    /**
     * v3.30d：注入远景雨幕条纹图（**改 TextureNode.value，不是 uniform**）。
     * ⚠️ 传 null 表示加载失败 ⇒ 关掉远景雨幕层（其余效果照常）。
     */
    setRainSheet(tex) {
      if (tex) {
        RAIN_SHEET_NODE.value = tex;
        U.uRainSheetOn.value = 1;
      } else {
        U.uRainSheetOn.value = 0;
      }
      return !!tex;
    },
    setMode(m) {
      const next = stormBloomLevels(m);
      if (next === levels) return levels;
      levels = next;
      bloomOut = buildChain();
      pipeline.outputNode = buildOutput();
      pipeline.needsUpdate = true;
      return levels;
    },
    get levels() { return levels; },
    dispose() { pipeline.dispose(); },
  };
}