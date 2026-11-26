// src/render/ashlar-tonemap-config.js — 上游 ASHLAR 色调映射的**纯数据常量**（three-free）
//
// 为什么单独成模块（与 `sky-config.js` / `sun-shade.js` 同一理由）：
//   ① `daynight.js` 是 three-free 的风格数据表，它要引用这个 toneMapping id；
//   ② Tier 1 单测与 `tools/check-data.mjs`（node）要能直接 import 它，不必经 three 的 GPU 初始化；
//   ③ 真正建 TSL 节点的 `ashlar-tonemap.js` 必然 import three —— 两者分开才不会把
//      three 依赖传染进风格数据表（那会让 daynight 的纯函数单测全部跑不起来）。
//
// 移植来源：上游 `source/src/main/25_post.js` 的 `G_TONEMAP_FRAG`（AgX + display-space punch）。

/**
 * `THREE.ACESFilmicToneMapping` 的值（`vendor/three/three.core.js:459`）。
 *
 * **为什么在这里写字面量而不 import three**：本模块必须 three-free（见文件头）。
 * 这个值是 vendor 冻结版本的常量，`ashlar-tonemap.js` 里有单测钉住它与
 * `THREE.ACESFilmicToneMapping` 逐位相等 —— 不是靠注释约定。
 */
export const ACES_FILMIC_TONE_MAPPING = 4;

/**
 * 上游 AgX+punch 的自定义 toneMapping id。
 *
 * ⚠️ **必须避开 three 已占用的 0~7**（`three.core.js`：NoToneMapping 0 / Linear 1 /
 * Reinhard 2 / Cineon 3 / ACESFilmic 4 / Custom 5 / AgX 6 / Neutral 7）。
 * `NodeLibrary.addType` 对已存在的 id 会 `warn` 并**拒绝覆盖**（`three.webgpu.js:56677`）
 * ⇒ 用已占用的 id 会静默不生效（toneMapping 设了但曲线还是旧的）。
 *
 * ⚠️ 它是 `renderer.toneMapping` 的取值，会进 `getOutputCacheKey()`
 * （`three.webgpu.js:56004`）⇒ 切换时输出 pass 自动重建，切回 ACES 逐位回到原值（已 GPU 实测）。
 */
export const ASHLAR_TONE_MAPPING = 91;

/**
 * 上游 AgX 的 inset / outset 矩阵（`25_post.js:390-391` 逐字）。
 *
 * ⚠️ **与 three 内置 AgX 不是同一组矩阵**（`three.webgpu.js:41565-41566` 那组走 Rec2020
 * 中间空间）。GPU 实测同一线性输入 0.2：上游 **110** / three 内置 **133** / ACES **135**
 * ⇒ 直接用 `THREE.AgXToneMapping` 得不到上游观感，必须自写。
 *
 * 存储口径：**列主序**（每个子数组是 GLSL `mat3(c0,c1,c2)` 的一个列向量），
 * 与上游 GLSL 源码的构造顺序逐项对应 —— 消费方按同样顺序喂 `mat3(vec3,vec3,vec3)`。
 * ⚠️ 转成行主序再乘会得出偏色的结果（实测中性灰 0.18 → 119,105,146 而非 104,104,104）。
 */
export const ASHLAR_AGX_INSET = Object.freeze([
  Object.freeze([0.842479062253094, 0.0423282422610123, 0.0423756549057051]),
  Object.freeze([0.0784335999999992, 0.878468636469772, 0.0784336]),
  Object.freeze([0.0792237451477643, 0.0791661274605434, 0.879142973793104]),
]);

export const ASHLAR_AGX_OUTSET = Object.freeze([
  Object.freeze([1.19687900512017, -0.0528968517574562, -0.0529716355144438]),
  Object.freeze([-0.0980208811401368, 1.15190312639708, -0.0980434501171241]),
  Object.freeze([-0.0990297440797205, -0.0989611768448433, 1.15107367264116]),
]);

/** AgX log 编码区间（上游 `clamp(log2(v), -12.47393, 4.026069)` 后 `/16.5`）。 */
export const ASHLAR_AGX_MIN_EV = -12.47393;
export const ASHLAR_AGX_MAX_EV = 4.026069;

/**
 * display-space「punch」两个参数（上游 `25_post.js:398-401`）：
 *   v = pow(v, 1.28); l = luma(v); v = l + 1.17*(v − l)
 * 即先压 gamma 提对比、再按亮度轴放大饱和。
 *
 * ⚠️ 这一步在 **display 空间**（AgX 对比曲线之后、outset 矩阵之前），
 * 挪到线性空间或 sRGB 之后都会得出不同结果 —— 顺序是载荷性的。
 */
export const ASHLAR_PUNCH_GAMMA = 1.28;
export const ASHLAR_PUNCH_SAT = 1.17;

/** Rec.709 亮度权重（上游 punch 与本项目其它 luma 口径同源）。 */
export const ASHLAR_LUMA_WEIGHTS = Object.freeze([0.2126, 0.7152, 0.0722]);