// src/render/wet-ground.js — 雨天「地面湿滑与反光」的 TSL 分支（挂在体素 opaque 材质上）
//
// 上游：`bj-shooting-game/night-heron-src/src/gfx/shaders.js` 的 `GROUND_FRAG`
// （puddle / film / rippleLayer / fresnel / planar reflection）+ `LIT_FRAG` 的
// rain wetness 段。**数学逐项移植**，常量在 `wet-ground-config.js`（three-free，可单测）。
//
// ## 为什么是「体素材质的一个分支」而不是独立地面 mesh
//
// 本仓地面就是体素本身（BatchedMesh 三通道）。红线 4/5 禁止第二份地形几何 /
// 独立 FaceCulling / consolidation 中间态 ⇒ **不能新建地面 mesh**。
// 故把上游那套效果做成本材质的一个 `mix` 分支：`uWet = 0` 时取左端
// ⇒ **逐位回到未开启时的颜色**（零回归锚点，Tier 4 单变量 A/B 靠它）。
//
// ## 反射复用既有 reflector（不新建第二条 pass）
//
// 见 `wet-ground-config.js` 文件头的完整理由：新建 reflector 会把
// 「必须在主 render 前手动跑」「藏第一人称物件」「节流」三个已解决的问题再踩一遍，
// 且两条 pass 会互相覆写 BatchedMesh 的 indirect 索引表（v3.17 实测的天空撕裂）。
// ⇒ 装配层把 `ocean.js` 的同一个 reflector 句柄交进来。
//
// ## 六条 TSL 口径（本仓已实测的教训）
//   ① 节点不与裸 JS 数字算术，一律 `.mul()`；
//   ② 常量色显式拆分量；
//   ③ 多层 mix 嵌套，不链式 `.mix()`；
//   ④ 径向量片元算（本分支全在片元，天然满足）；
//   ⑤ uniform 模块级单例（本分支只有一份，不存在两池互相覆写的问题）；
//   ⑥ 反向 smoothstep 写 `oneMinus(smoothstep(lo,hi,x))`。
import * as THREE from 'three';
import {
  float, vec2, vec3, vec4, uniform, mix, max, min, mul, add, dot, sub, div,
  abs, sin, pow, floor, fract, normalize, length, smoothstep, oneMinus, step,
  clamp, hash, positionWorld, cameraPosition, mx_noise_float as perlin,
} from 'three/tsl';
import {
  WET_UP_BASE, WET_UP_GAIN, WET_STREAK_GAIN,
  WET_FLOW_DIR, WET_FLOW_SCALE, WET_FLOW_Y_SCALE, WET_FLOW_SPEED,
  WET_FLOW_FROM, WET_FLOW_TO, WET_ALBEDO_DARKEN,
  WET_RIPPLE as RI, WET_PUDDLE, WET_REFLECT_STRENGTH,
  WET_REFLECT_DISTORT_ACROSS, WET_REFLECT_DISTORT_ALONG, WET_REFLECT_DISTORT_PUDDLE_K,
  WET_REFLECT_MIP, WET_FRESNEL_F0, WET_FRESNEL_F0_PUDDLE, WET_FRESNEL_POWER,
} from './wet-ground-config.js';
import { WATER_SURFACE_Y } from './water-surface.js';

/**
 * 湿地面的 uniform（**模块级单例**，与 `uSkyDim` / `uSunDirection` 同手法）。
 *
 * ⚠️ 恒创建（即使雨天档未开启）：句柄存在 ⇒ 装配层无条件可写，
 * 不需要判「材质是否已接线」（与 dayNight 那组 uniform 同一容错口径）。
 * ⚠️ `uWet` 初值 **0** ⇒ 未接线时逐位等于原材质（零回归）。
 */
export const WET_UNIFORMS = Object.freeze({
  /** 湿度总强度 0..1（装配层按「雨天档 ∧ 在下雨 ∧ 非室内」写） */
  uWet: uniform(0),
  /**
   * 反射项开关（0 = 不采样反射 RT，只留压暗/涟潪）。
   *
   * ⚠️⚠️ **它存在的理由是 WebGPU 的读写冲突**（本轮实测）：反射 pass 把 RT 当
   * 渲染目标（写），而挂了湿分支的体素 opaque 材质在同一 pass 里采样它（读）
   * ⇒ `writable usage and another usage in the same synchronization scope`。
   *
   * ⚠️ **不能用「反射期间藏掉 opaque 通道」解决**（本轮单变量 A/B 实测）：
   * 藏掉后反射 RT 里没有地面 ⇒ **水面倒影映的全是天空** ⇒ 水色真的变了
   * （morning luma 130→127、noon 99→146、share 4600→12000，撞冻结色阶）。
   * 那是真实观感回归，不是测量误差。
   *
   * ⇒ 正解：反射 pass 期间把本 uniform 置 0（湿分支不采样 RT），结束后置回。
   * 地面仍在反射里可见 ⇒ 水面倒影不变；而读写冲突消失。
   * ⚠️ 由 `ocean.renderReflection` 前后写（它才知道 pass 的起止）。
   */
  uWetReflectOn: uniform(1),
  /** 绝对秒（涟漪与流水纹的时钟；与体素其余动画无关，独立推进） */
  uWetTime: uniform(0),
  /** 反射强度上限（0 = 关掉反射项，只留压暗/涟漪；供 Tier 4 单变量 A/B） */
  uWetReflect: uniform(WET_REFLECT_STRENGTH),
  /**
   * v3.30d：**镜面投影矩阵**（bias · reflProj · reflView）。
   *
   * ⚠️⚠️ **它修的是用户报告的「像在地下又有一层模糊的透射」**：
   * 旧实现用**片元自己的 screenUV** 采样反射 RT，但 RT 是从**镜像相机**渲的
   * ⇒ 同一屏幕坐标在两张图里对应不同的世界点。地面高于镜面时
   *（本仓地形 y≈22、镜面 −1.5，实测差 **23.5 格**）偏差极大
   * ⇒ 采到「该屏幕位置下方的另一个物体」⇒ 读作地下一层模糊透射。
   * 上游 GROUND_VERT：vReflPos = uReflMatrix * vec4(wp.x, 0.0, wp.z, 1.0)
   * —— 把世界点**压到镜面高度**后过反射相机的投影。
   * 由 ocean.renderReflection 每帧写入（唯一权威）。
   */
  uWetReflMatrix: uniform(new THREE.Matrix4()),
  /** 镜面高度（世界 y）—— 世界点压到它再投影（上游的 0.0，本仓 = WATER_LEVEL_OFFSET） */
  uWetMirrorY: uniform(-1.5),
  /** 反射采样的 mip 级别（朦胧度） */
  uWetReflectMip: uniform(WET_REFLECT_MIP),
  /**
   * v3.30g：**水面高度**（世界 y）—— 逐片元水下门的基准。
   *
   * 用户「地面反光特效不要在水面以下出现」。片元 y < 本值 ⇒ wet 归 0。
   * ⚠️ **不能只靠 CPU 的 `uWet` 总强度**：站在岸上看湖底是「相机在水上、
   * 片元在水下」，总强度门对它零判别力。
   * ⚠️ 初值 = `WATER_SURFACE_Y`（−1.5，与海面平面共面）；写成 uniform 而不是硬编码
   * 是为了让 Tier 4 能单变量把它推到极低（= 关门）做 A/B。
   */
  uWetWaterY: uniform(WATER_SURFACE_Y),
});

/**
 * 一层涟漪（上游 `rippleLayer` 逐字）。
 *
 * 格子内随机相位的扩张圆环：
 *   c = floor(p), f = fract(p) − 0.5
 *   h = hash3(c + seedOffset)
 *   ph = fract(t*(0.75+0.6*h.z) + h.x*9)
 *   d = f − (h.xy−0.5)*0.44;  r = |d|;  R = ph*0.27
 *   w = sin((r−R)*70) * smoothstep(0.05,0,|r−R|) * (1−ph)²
 *   return normalize(d) * w
 *
 * ⚠️ **hash 用 TSL 的 `hash(vec2)`**（上游是 hash32）：本仓只需要两个随机分量
 * （中心抖动 + 相位），故用两次不同种子的 hash 而不是三维 hash —— 分布等价，
 * 且少一次节点构造。
 *
 * @param {object} p 世界 xz × 尺度
 * @param {object} t 时间
 * @param {number} seedOffset
 * @returns {object} vec2 法线扰动
 */
function rippleLayer(p, t, seedOffset) {
  const c = floor(p);
  const f = fract(p).sub(vec2(0.5, 0.5));
  const hx = hash(c.add(vec2(seedOffset, seedOffset * 1.7)));
  const hy = hash(c.add(vec2(seedOffset + 31.7, seedOffset * 2.3 + 11.1)));
  const hz = hash(c.add(vec2(seedOffset + 57.3, seedOffset * 3.1 + 7.7)));
  const ph = fract(t.mul(float(RI.rateMin).add(hz.mul(RI.rateRange))).add(hx.mul(RI.phaseGain)));
  const d = f.sub(vec2(hx.sub(0.5), hy.sub(0.5)).mul(RI.centerJitter));
  const r = length(d);
  const R = ph.mul(RI.radiusGain);
  const band = oneMinus(smoothstep(float(0), float(RI.bandWidth), abs(r.sub(R))));
  const decay = oneMinus(ph);
  const w = sin(r.sub(R).mul(RI.waveFreq)).mul(band).mul(decay).mul(decay);
  return d.div(max(r, float(1e-3))).mul(w);
}

/**
 * 造湿地面分支节点。
 *
 * @param {{baseRgb: object, faceNormal: object, reflect?: object|null}} deps
 *   `baseRgb`   原亮度项（texColor.rgb × shade，含自发光）
 *   `faceNormal` 面法线（packed bit10-12 解出的六选一，**已有节点**，不新增属性）
 *   `reflect`   既有 reflector 句柄（`{ node }`；缺省 null ⇒ 不采样反射）
 * @returns {object} vec3 最终颜色
 */
export function createWetGroundNode({ baseRgb, faceNormal, reflect = null }) {
  const U = WET_UNIFORMS;
  const wp = positionWorld;
  const toCam = cameraPosition.sub(wp);
  const dist = length(toCam);
  const viewDir = normalize(toCam);

  // ---- 流水纹（上游 flowN → streak）----
  // 上游用噪声贴图的 .g 通道；本仓用 TSL 的 hash 平滑替代（同为 [0,1] 空间噪声）。
  // ⚠️ 竖直方向随时间下移（`y*0.045 − t*0.03`）⇒ 读作「水往下流」。
  const flowCoord = vec2(
    dot(wp.xz, vec2(WET_FLOW_DIR[0], WET_FLOW_DIR[1])).mul(WET_FLOW_SCALE),
    wp.y.mul(WET_FLOW_Y_SCALE).sub(U.uWetTime.mul(WET_FLOW_SPEED)),
  );
  // ⚠️ **连续 perlin 而不是 hash(floor(...))**（v3.30d，同雨雾的光栅根因）：
  // 硬格子会让流水纹变成轴对齐矩形斑；上游采样的是平滑噪声贴图。
  const flowN = perlin(vec3(flowCoord.mul(3.2), float(0))).mul(0.5).add(0.5)
    .mul(0.7)
    .add(perlin(vec3(flowCoord.mul(7.1).add(vec2(5.3, 11.7)), float(0))).mul(0.5).add(0.5).mul(0.3));
  const streak = smoothstep(float(WET_FLOW_FROM), float(WET_FLOW_TO), flowN);

  // ---- 湿度（上游 wet = clamp(uWet*(0.3+0.7*up+0.55*streak), 0, 1)）----
  const up = max(faceNormal.y, float(0));
  /**
   * ⚠️⚠️ **水下门（v3.30g，用户裁定）**：片元在水面以下 ⇒ 完全不湿。
   * `step(waterY, wp.y)` = wp.y ≥ waterY ? 1 : 0（恰好共面算水上，不抖）。
   * 乘进 wet ⇒ 下游的压暗 / 涟潪 / 菲涅尔 / 反射 **四项一起归零**，
   * 末尾 `mix(baseRgb, lit, uWet)` 不受影响 ⇒ 水下片元逐位回到原色。
   * ⚠️ 必须乘在 **wet** 上而不是只乘 reflTerm：只关反射会留下「湖底被压暗 + 涟潪」。
   */
  const aboveWater = step(U.uWetWaterY, wp.y);
  const wet = clamp(
    U.uWet.mul(float(WET_UP_BASE).add(up.mul(WET_UP_GAIN)).add(streak.mul(WET_STREAK_GAIN))),
    float(0), float(1),
  ).mul(aboveWater);

  // ---- 压暗（上游 albedo *= mix(1, 0.6, wet*porous)；体素全是多孔材质）----
  const darkened = baseRgb.mul(mix(float(1), float(WET_ALBEDO_DARKEN), wet));

  // ---- 涟漪扰动（只在朝上面 + 近处；上游 rfade = smoothstep(26,8,dist)）----
  const rfade = oneMinus(smoothstep(float(RI.fadeNear), float(RI.fadeFar), dist));
  const wuv = wp.xz;
  const rip = rippleLayer(wuv.mul(RI.scaleA), U.uWetTime, 0)
    .add(rippleLayer(wuv.mul(RI.scaleB).add(vec2(RI.offsetB, RI.offsetB)),
      U.uWetTime.mul(RI.speedB), RI.seedB));
  const amp = float(RI.ampBase).add(float(RI.ampPuddle).mul(WET_PUDDLE));
  const nxy = rip.mul(amp).mul(rfade).mul(wet);
  // 扰动后的法线（上游 normalize(vec3(nxy.x, 1, -nxy.y))）
  const N = normalize(vec3(nxy.x, float(1), nxy.y.negate()));

  // ---- 菲涅尔（上游 f0 = mix(0.05,0.1,puddle)，pow(1−NoV, 4)）----
  const noV = clamp(dot(N, viewDir), float(0), float(1));
  const f0 = float(WET_FRESNEL_F0 + (WET_FRESNEL_F0_PUDDLE - WET_FRESNEL_F0) * WET_PUDDLE);
  // 湿表面的粗糙度很低（上游 puddle 档 prough = 0.025）
  const rough = float(0.025);
  const fres = f0.add(max(float(1).sub(rough), f0).sub(f0)
    .mul(pow(oneMinus(noV), WET_FRESNEL_POWER)));

  // ---- 反射（复用既有 reflector；缺省 null ⇒ 该项恒 0）----
  //
  // ⚠️⚠️ **不用 `.toVar()` + `.assign()`**（本轮浏览器实测）：本函数是在
  // `makeMaterial` 里**直接调**的（不在 `Fn()` 体内），而 TSL 的 `.assign()` 要求
  // 当前有 stack ⇒ 报 `No stack defined for assign operation`，且**只在该 spec
  // 收集 console 错误时才被发现**（画面照常渲染，其他 spec 全绿）。
  // 正解：用**普通 JS 变量持有节点**（三元选），不用 TSL 可变量。
  let reflTerm = float(0);
  let reflColor = vec3(0, 0, 0);
  if (reflect?.node) {
    /**
     * ⚠️⚠️ **采样坐标 = 镜面投影，不是片元自己的 screenUV**（v3.30d 根因修复）：
     * 反射 RT 是从**镜像相机**渲的 ⇒ 同一屏幕坐标在两张图里对应不同世界点。
     * 地面高于镜面（本仓实测差 23.5 格）时偏差极大 ⇒ 采到「屏幕位置下方的
     * 另一个物体」⇒ 用户读作「地下一层模糊的透射」。
     * 上游 GROUND_VERT：`vReflPos = uReflMatrix * vec4(wp.x, 0.0, wp.z, 1.0)`
     * ⇒ 把世界点**压到镜面高度**后过 bias·reflProj·reflView，再透视除法。
     */
    const flat = vec4(wp.x, U.uWetMirrorY, wp.z, float(1));
    const rp = U.uWetReflMatrix.mul(flat);
    const mirrorUV = rp.xy.div(max(rp.w.abs(), float(1e-4)));
    // 上游扰动：沿视线方向拉伸更大 ⇒ 竖直长条反光（湿地面的身份特征）
    const vd = normalize(wp.xz.sub(cameraPosition.xz).add(vec2(1e-4, 1e-4)));
    const along = dot(N.xz, vd);
    const across = dot(N.xz, vec2(vd.y.negate(), vd.x));
    const dk = float(1).sub(float(WET_REFLECT_DISTORT_PUDDLE_K).mul(WET_PUDDLE));
    const uvOff = vec2(across.mul(WET_REFLECT_DISTORT_ACROSS), along.mul(WET_REFLECT_DISTORT_ALONG))
      .mul(dk).mul(wet);
    reflect.node.uvNode = mirrorUV.add(uvOff);
    reflect.node.levelNode = U.uWetReflectMip;
    // ⚠️ 显式拆分量（`vec3(node)` 在 WebGPU 静默输出黑）
    reflColor = vec3(reflect.node.r, reflect.node.g, reflect.node.b);
    /**
     * ⚠️ **反射不再乘 rfade**（v3.30d）：rfade 是**涟漪**的距离衰减（8~26 格），
     * 上游把它只用在 nxy 上；旧实现误把它乘进 reflTerm ⇒ **26 格外完全没反光**
     * （用户：「有的方块并不是呈现反射效果」）。反射的距离衰减由 fresnel 与
     * 雾自然承担（上游同口径）。
     */
    reflTerm = fres.mul(U.uWetReflect).mul(wet).mul(U.uWetReflectOn);
  }


  // ---- 合成：压暗后的基色 + 反射项 ----
  // ⚠️ **反射是加项而不是 mix**（上游 `col += refl*fres*(1−0.45*prough)`）：
  // 湿表面的反光是「叠加在自身颜色上的镜面高光」，mix 会把地面本身的颜色抹掉。
  // ⚠️ `uWet = 0` 时 wet=0 ⇒ darkened = baseRgb×1、reflTerm=0 ⇒ **逐位回到原色**。
  const lit = add(darkened, reflColor.mul(reflTerm));
  return mix(baseRgb, lit, U.uWet);
}