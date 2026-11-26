// src/render/ashlar-tonemap.js — 上游 ASHLAR 的 AgX + display-space punch（TSL）
//
// 设计文档：docs/superpowers/specs/2026-11-27-normal-env-style-ashlar-port-design.md §3.3
// 移植来源：上游 `source/src/main/25_post.js` 的 `G_TONEMAP_FRAG`（agx / agxContrast 两个函数）
//
// ## 为什么不改帧循环（已 GPU 实测，不是推断）
//
// `renderer.library.addToneMapping(fn, id)` 是**公开 API**（`three.webgpu.js:56602`），
// 而 `getOutputCacheKey()` 含 `toneMapping`（:56004）⇒ 写 `renderer.toneMapping = id`
// 就会让输出 pass 自动重建并真的用上这条曲线。一次性探针实测：
//
//   线性 0.05 / 0.2 / 0.6 →  上游 AgX **47 / 110 / 165**
//                          three 内置 AgX 70 / 133 / 182
//                          ACES          50 / 135 / 207
//   切回 ACES 后读数**逐位回到** [50,135,207]，零 GPU 校验错误。
//
// ⇒ **不需要 RenderPipeline、不需要 pass()、不碰帧循环**。这一点很关键：
// 准心配色 / 屏外敌人箭头 / 伤害数字 / renderer.info 快照全部依赖「主 render 之后」，
// 改成 pipeline.render() 会牵动 4 处静态守卫与 35 个读 info 的 spec。
//
// ## 为什么必须自写而不能用 THREE.AgXToneMapping
//
// three 内置那组矩阵走 Rec2020 中间空间，与上游不是同一组（见 config 注释）。
// 同一输入实测差 23 luma ⇒ 直接用内置 AgX 得不到上游观感。
//
// ⚠️ 常量（矩阵/ev 区间/punch 参数）权威在 `ashlar-tonemap-config.js`（three-free），
// 本模块只负责建 TSL 节点 —— 那边能被 daynight.js 与 node 单测直接 import。
import * as THREE from 'three';
import { Fn, vec3, float, mat3, log2, pow, max, clamp, mix } from 'three/tsl';
import {
  ASHLAR_TONE_MAPPING, ACES_FILMIC_TONE_MAPPING,
  ASHLAR_AGX_INSET, ASHLAR_AGX_OUTSET,
  ASHLAR_AGX_MIN_EV, ASHLAR_AGX_MAX_EV,
  ASHLAR_PUNCH_GAMMA, ASHLAR_PUNCH_SAT, ASHLAR_LUMA_WEIGHTS,
} from './ashlar-tonemap-config.js';

export { ASHLAR_TONE_MAPPING, ACES_FILMIC_TONE_MAPPING };

/** 列主序常量 → TSL mat3（三个 vec3 就是 GLSL 的三个列，顺序载荷性）。 */
function mat3FromCols(cols) {
  return mat3(
    vec3(cols[0][0], cols[0][1], cols[0][2]),
    vec3(cols[1][0], cols[1][1], cols[1][2]),
    vec3(cols[2][0], cols[2][1], cols[2][2]),
  );
}

/**
 * AgX 的对比曲线近似（上游 `agxContrast` 六次多项式，逐字）。
 *
 * ⚠️ **用普通 JS 函数而不是 `Fn`**：它只是「把几行节点表达式装起来」，不需要是 shader 函数。
 * pitfalls 已记：`Fn` 返回多键对象会被包成 SplitNode、自定义键全 undefined；
 * 而返回单个节点虽然能用，但这里没有跨 pass 复用的需求，普通函数更简单也更不易踩坑。
 */
function agxContrast(x) {
  const x2 = x.mul(x);
  const x4 = x2.mul(x2);
  return x4.mul(x2).mul(15.5)
    .sub(x4.mul(x).mul(40.14))
    .add(x4.mul(31.96))
    .sub(x2.mul(x).mul(6.868))
    .add(x2.mul(0.4298))
    .add(x.mul(0.1191))
    .sub(0.00232);
}

/**
 * 上游 AgX + display-space punch 的 TSL 实现。
 *
 * 签名必须是 `(color: vec3, exposure: float) => vec3` —— `ToneMappingNode` 就是这么调的
 * （`three.webgpu.js:10175`：`toneMappingFn(colorNode.rgb, this.exposureNode)`）。
 *
 * 步骤（顺序**载荷性**，与上游逐字对应）：
 *   ① c = inset × max(color × exposure, 1e-10)
 *   ② c = (clamp(log2(c), minEv, maxEv) − minEv) / (maxEv − minEv)
 *   ③ c = agxContrast(c)
 *   ④ **display-space punch**：c = pow(c, 1.28); l = luma(c); c = l + 1.17×(c − l)
 *   ⑤ c = outset × c
 *   ⑥ return pow(max(c, 0), 2.2)   ← 回到线性，随后由 renderOutput 做 sRGB 编码
 *
 * ⚠️ ④ 必须在 display 空间（③ 之后、⑤ 之前）。挪到线性空间或 sRGB 之后都会得出不同结果。
 * ⚠️ ⑥ 的 pow(2.2) 是上游 `agx()` 的收尾（它返回线性值，调用方再 toSrgb）——
 * 漏掉它会让整个画面偏亮一大截。
 */
const ashlarAgxToneMapping = Fn(([color, exposure]) => {
  const inset = mat3FromCols(ASHLAR_AGX_INSET);
  const outset = mat3FromCols(ASHLAR_AGX_OUTSET);
  const minEv = float(ASHLAR_AGX_MIN_EV);
  const maxEv = float(ASHLAR_AGX_MAX_EV);
  const lumaW = vec3(ASHLAR_LUMA_WEIGHTS[0], ASHLAR_LUMA_WEIGHTS[1], ASHLAR_LUMA_WEIGHTS[2]);

  const c = vec3(color).toVar();
  c.assign(inset.mul(max(c.mul(exposure), vec3(1e-10))));
  c.assign(clamp(log2(c), minEv, maxEv).sub(minEv).div(maxEv.sub(minEv)));
  c.assign(agxContrast(c));
  // display-space punch
  c.assign(pow(max(c, vec3(0.0)), vec3(ASHLAR_PUNCH_GAMMA)));
  const l = c.dot(lumaW);
  c.assign(mix(vec3(l), c, float(ASHLAR_PUNCH_SAT)));
  c.assign(outset.mul(c));
  return pow(max(c, vec3(0.0)), vec3(2.2));
}).setLayout({
  name: 'ashlarAgxToneMapping',
  type: 'vec3',
  inputs: [
    { name: 'color', type: 'vec3' },
    { name: 'exposure', type: 'float' },
  ],
});

/**
 * 把自定义曲线注册到 renderer 的 NodeLibrary（**幂等**）。
 *
 * ⚠️ **必须在写 `renderer.toneMapping = ASHLAR_TONE_MAPPING` 之前调**：
 * `getToneMappingFunction` 返 null 时输出 pass 会报
 * 「ToneMappingNode: Unsupported Tone Mapping configuration」并回落无色调映射。
 *
 * ⚠️ `addType` 对**已存在的 id** 会 `warn` 并**拒绝覆盖**（`three.webgpu.js:56677`）
 * ⇒ 重复调不仅无意义还会刷警告。故用 WeakSet 记住已注册的 renderer。
 *
 * @param {THREE.WebGPURenderer} renderer
 * @returns {boolean} 本次是否真的执行了注册（已注册过则 false）
 */
const registered = new WeakSet();
export function ensureAshlarToneMapping(renderer) {
  if (!renderer || !renderer.library) return false;
  if (registered.has(renderer)) return false;
  renderer.library.addToneMapping(ashlarAgxToneMapping, ASHLAR_TONE_MAPPING);
  registered.add(renderer);
  return true;
}

/**
 * 一致性守卫：config 里写的 ACES 常量必须与 vendor 的 `THREE.ACESFilmicToneMapping` 相等。
 *
 * **为什么需要它**：`ashlar-tonemap-config.js` 必须 three-free（daynight.js 要 import 它），
 * 所以那里写的是字面量 4。这条断言把「字面量」钉到 vendor 真值上 ——
 * 换 three 版本导致常量变化时立刻抛错，而不是静默回落到错误的色调映射。
 */
if (ACES_FILMIC_TONE_MAPPING !== THREE.ACESFilmicToneMapping) {
  throw new Error(
    `[ashlar-tonemap] config 的 ACES_FILMIC_TONE_MAPPING（${ACES_FILMIC_TONE_MAPPING}）`
    + `与 THREE.ACESFilmicToneMapping（${THREE.ACESFilmicToneMapping}）不一致 —— `
    + 'vendor three 版本变了，必须同步 ashlar-tonemap-config.js。',
  );
}

/** 自定义 id 不得撞 three 已占用的 0~7（撞了会静默不生效，见 config 注释）。 */
if (ASHLAR_TONE_MAPPING <= THREE.NeutralToneMapping) {
  throw new Error(
    `[ashlar-tonemap] ASHLAR_TONE_MAPPING（${ASHLAR_TONE_MAPPING}）撞上了 three 已占用的 id`
    + '（0~7）—— addType 会拒绝覆盖，曲线静默不生效。',
  );
}