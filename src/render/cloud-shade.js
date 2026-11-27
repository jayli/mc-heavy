// src/render/cloud-shade.js — 云专属着色地板的**标定常量与 CPU 参考实现**（three-free）
//
// 设计稿：docs/superpowers/specs/2026-11-27-cloud-soft-translucency-design.md
//
// ## 要解决什么（用户 2026-11-27）
//
// 「云方块是完全不透明的……我希望给云方块增加一些半透光的光影效果，这样显得云方块
//   组成的云朵不会这么硬（像飘在空中的石头方块一样）。」
//
// **落地语义 = 云自身着色柔和**（用户裁定），不是「能看穿云」。云的贴图实测是
// 64×64 全 255 纯白零细节 ⇒ 它的立体感 100% 来自与石头共用的那套着色公式：
// 正午底面屏幕亮度 145 vs 顶面 226（比 1.559），云簇凹角侧面掉到 99。
//
// ## 为什么是 `max(原值, 地板)` 而不是「改系数」或「wrap lighting」
//
// 三条都算过（设计稿 §4.1），`max` 是唯一同时满足两个硬要求的：
//   · **亮面逐位不动**：原值已高于地板的面 `max` 恒等返回 ⇒ 结构上不可能过曝，
//     也不动 crosshair 的「最亮方块 < 200」阈值。改 hemiGround/shadowFloor 系数
//     会把顶面与迎光面一起抬亮；wrap lighting `(dot+w)/(1+w)` 连顶面的 dot=0.8 也抬
//     （线性 1.0 → 1.0775），要保顶面恒 1 就得重标定 intensity，引入第二套派生。
//   · **无需重标定强度**：地板是加在既有因子之上的下界，不改因子的斜率。
//
// ## 为什么单独成模块（零 import）
//
// 与 `shade-params.js` 同一理由：`daynight.js` 要读本模块做 per-style 派生，
// 而 `sun-shade.js` 顶层就要读 `VISUAL_STYLES.noon.sunDirection`
// ⇒ 若本模块 import `sun-shade.js`，`daynight ↔ sun-shade` 那条环会复活
// （已实测 `ReferenceError: Cannot access 'VISUAL_STYLES' before initialization`）。
// 本模块**不 import 任何东西** ⇒ 不可能成环。三个地板的入参由调用方传进来。
//
// ## 三个 lift 的职责分离（**不是冻结常量**）
//
// 值域 [0,1]：0 = 该因子不抬（逐位回到现状），1 = 该因子完全不致暗。
//   · CLOUD_SUN_LIFT  控「背光面有多亮」
//   · CLOUD_HEMI_LIFT 控「云底面有多亮」
//   · CLOUD_AO_LIFT   控「云簇内部凹角有多亮」
// 实玩觉得「云内部失去层次」⇒ 只降 AO 那个；觉得「还不够柔」⇒ 抬前两个。
// 改后需重标 Tier 4 的「云底面变亮」下界（亮面不动那几条是不变式，不动）。
//
// Worker 同构无关（本模块只被 render 层消费），但仍保持 three-free 以便 Node 单测直接 import。

/** 太阳项地板的抬升比例。0.35 ⇒ 全局档地板 0.38 → 0.597。 */
export const CLOUD_SUN_LIFT = 0.35;

/** 半球环境地板的抬升比例。0.50 ⇒ 全局档 0.6 → 0.8（云底不再是黑底板）。 */
export const CLOUD_HEMI_LIFT = 0.50;

/**
 * AO 地板的抬升比例。2/3 ⇒ 最暗 AO 因子 0.1 → 0.7。
 * ⚠️ 取 2/3 而不是 0.67：`0.1 + 0.9 × (2/3)` 恰好落在 0.7（实测 0.7000000000000001），
 * 而 0.67 给 0.703 —— 前者让「云簇凹角最暗 = 开阔面的 70%」这个口径是个整数百分点。
 */
export const CLOUD_AO_LIFT = 2 / 3;

// ==================== v3.52：面间明暗分离（侧面提亮 / 顶底压暗）====================
//
// 设计稿：docs/superpowers/specs/2026-11-27-cloud-side-face-contrast-design.md
//
// ## 要解决什么（用户 2026-11-27，附缺陷图与 MC 原版参考图）
//
// 「小云朵就模糊不清……因为云朵底色、垂直的面的颜色和背后的大云岛的底色完全一样，
//   肉眼分辨不出来。我希望让云方块的侧面的四个面比顶面和底面更亮一些、更白一些。」
//
// ## 根因是一个恒等式，不是参数没调够
//
// `CLOUD_HEMI_LIFT = 0.50` ⇒ `cloudHemiFloorFor(g, 0.5) = (1+g)/2`
// **恰好等于四个侧面的 hemi 因子**（g=0.6 两边都是 0.8；g=0.12 都是 0.56）；
// 同时正午太阳 [0,0.8,0.6] 下侧面与底面的 N·L 都 ≤0 ⇒ 太阳项落到同一地板 0.597。
// 两项相乘 ⇒ **底面与四侧面逐位同色**（五档侧/底屏幕比实测全是 1.000）。
// 实测缺陷图：大云岛底面 160.9 / 准心处小云朵 152.1；原版参考：底 182 / 侧面亮带 218（比 1.198）。
//
// ## 为什么是「逐面灰阶 gain」而不是改 lift / 改地板
//
// 三条都算过（五档 × 6 面 × 4 AO = 120 组 CPU 扫描，设计稿 §4.1）：
//   · 只压暗底面 ⇒ 侧面没变白，与用户「更亮更白」的字面要求不符；
//   · 改三个 lift 让地板按面分档 ⇒ normal 档底面掉到 93、侧/底 1.98，档间失衡；
//   · 逐面灰阶 gain ⇒ 五档侧/底 ∈ [1.175, 1.502]，最小差 33 灰阶。
//
// ⚠️ **灰阶是载荷性的**：gain 是**标量**，等比缩放整个 vec3 ⇒ 色相不变。
// 逐通道给不同 gain 会把云拉出色偏，与「更白」相背（同 v3.46b 手臂那轮的裁定）。
//
// ⚠️ **不加 cap 兜底**：实测 `min(v, 1)` 会把 night +Z 面的 R−B 从 −32.4 抹成 **0**；
// 等比钳 `min(v, base×k)` 则吃掉对比增益。正解是把幅度取在安全上界内（见下）。

/**
 * 四个侧面（|N.y| < 0.5）的亮度 gain。
 *
 * ⚠️⚠️ **1.38 是实测安全上界，不是随手取的**（设计稿 §4.2，全 5 档 × 6 面 × 4 AO 扫描）：
 *   1.30 → 最大线性 0.9500 / 1.35 → 0.9634 / **1.38 → 0.9848** / 1.40 → 0.9990（贴线）
 *   / **1.42 → 1.0133 ❌ 削顶** / 1.45 → 1.0347 ❌
 * 越线的位置恒为 dusk 的 +Z 面（暖直射色 R 通道 1.5 倍）。
 * 削顶 ⇒ ACES 钳平三通道 ⇒ 色相消失，而所有亮度判据仍绿。
 * 由 `test-cloud-shade.js` 的「全档全面最大线性 <1.0」用例钉住（含 1.42 的判别力对照）。
 */
export const CLOUD_SIDE_FACE_GAIN = 1.38;

/** 顶面 gain（略压暗，让「顶底比侧面暗」成立）。noon 实测 231.6 → 230.2。 */
export const CLOUD_TOP_FACE_GAIN = 0.95;

/** 底面 gain（压暗最多 —— 它正是与侧面糊在一起的那个面）。noon 实测 203.6 → 185.4。 */
export const CLOUD_BOTTOM_FACE_GAIN = 0.72;

/**
 * 面类别亮度 gain（CPU 参考实现，与 `materials.js` 的 TSL 同式 —— 红线 1）。
 *
 * ```
 * faceK = N.y > 0.5 ? TOP : N.y < −0.5 ? BOTTOM : SIDE
 * gain  = 1 + (faceK − 1) × contrast     ≡ mix(1, faceK, contrast)
 * ```
 *
 * ⚠️ 写成 `1 + (k−1)×contrast` 而非 `contrast ? k : 1`：与 TSL 的 `mix` 同形，
 * 保 `contrast=0` 的**逐位**性两侧同源（同三个地板的口径）。
 *
 * ⚠️ `contrast` 由**独立** uniform `uCloudFaceContrast` 提供，**不是 `uCloudSoften`** ——
 * 后者 =0 会同时关掉 v3.50 的三个地板，那就不是本轮的单变量对照了。
 *
 * @param {number} normalIndex 0..5，`FACE_NORMALS` 索引（= packed bit10-12）
 * @param {number} [contrast] 0..1，缺省 1（满档）；0 ⇒ 恒 1（逐位回到 v3.50）
 * @returns {number}
 */
export function cloudFaceGainFor(normalIndex, contrast = 1) {
  const ny = CLOUD_FACE_NORMALS[normalIndex][1];
  const k = ny > 0.5 ? CLOUD_TOP_FACE_GAIN
    : ny < -0.5 ? CLOUD_BOTTOM_FACE_GAIN : CLOUD_SIDE_FACE_GAIN;
  return 1 + (k - 1) * contrast;
}

/**
 * AO 曲线系数（`1 − (3−ao)/3 × K`）：ao=3（开阔）→ 1.0，ao=0（墙角）→ 1−K。
 * **唯一权威在此**：`materials.js` 原先写字面量 0.9，v3.50 起 import 本常量（红线 1）。
 */
export const AO_CURVE_K = 0.9;

/**
 * ao ∈ 0..3 → AO 因子（与 `materials.js` 的 `aoFactor` 同式）。
 * @param {number} ao @returns {number}
 */
export function aoFactorFor(ao) {
  return 1 - (3 - ao) / 3 * AO_CURVE_K;
}

/**
 * 云的太阳项地板 —— 由**当前生效的**影区地板派生，不写字面量。
 *
 * ⚠️ 入参必须是调用方刚写给 `uShadowFloor` 的那个值（per-style：normal 档 0.399，
 * 其余四档回落全局 0.38）。两处各算一遍会漂移出「两个端点一致而半影撕裂」
 * ——本仓 `uShadowFloor` 同时当影区地板与 shadowKill 分母那轮已实测过这个形态。
 *
 * @param {number} floor 当前影区地板（`uShadowFloor.value`）
 * @param {number} [lift] 抬升比例，缺省 `CLOUD_SUN_LIFT`；传 0 ⇒ 逐位返回 floor
 * @returns {number}
 */
export function cloudSunFloorFor(floor, lift = CLOUD_SUN_LIFT) {
  return floor + (1 - floor) * lift;
}

/**
 * 云太阳项地板的**逐通道**版 —— 保色相（v3.50 自审修复）。
 *
 * ☠️☠️ **为什么必须逐通道**：`materials.js` 的 `sunTerm` 是 **vec3**
 * （已乘 `uSunColor` / `uAmbientColor` 色温），而标量地板做 `max(vec3, float)`
 * 是**逐分量取大** ⇒ 背光面三通道被抬到同一个值 ⇒ **色相被抹成中性灰**。
 * 实测背光面 R−B：dusk **−0.129 → 0**、night **−0.097 → 0**、normal **−0.044 → 0**
 * ⇒ 傍晚的「暖光冷影」在云上消失。正午色温中性（全 1）故当时没暴露。
 *
 * 做法：把标量地板按**当前环境色的相对比例**分配到三通道，
 * 并归一化使**三通道均值 ≡ 标量地板** ⇒ 亮度语义不变，只换色相分配。
 * 中性色温（全 1）时三通道都等于标量地板 ⇒ **逐位零回归**。
 *
 * ⚠️ 用 `ambientColor` 而不是 `sunColor`：地板抬的是**背光面**，
 * 而背光面的 sunTerm 只剩环境项（`ambientColor × floor`）—— 两者必须同源。
 *
 * @param {number} floor 当前影区地板（与 `cloudSunFloorFor` 同一入参）
 * @param {readonly number[]} ambientColor 当前环境色温乘数（均值 ≈1）
 * @param {number} [lift] 缺省 `CLOUD_SUN_LIFT`
 * @returns {number[]} 长度 3 的**新数组**（绝不暴露入参权威数组）
 */
export function cloudSunFloorRGBFor(floor, ambientColor, lift = CLOUD_SUN_LIFT) {
  const base = cloudSunFloorFor(floor, lift);
  const mean = (ambientColor[0] + ambientColor[1] + ambientColor[2]) / 3;
  // 防御：均值非正（异常色温）时退化为标量地板，不产 NaN/Inf
  if (!(mean > 1e-9)) return [base, base, base];
  return [
    base * ambientColor[0] / mean,
    base * ambientColor[1] / mean,
    base * ambientColor[2] / mean,
  ];
}

/**
 * 云的半球环境地板 —— 由当前 `uHemiGround` 派生（同上口径）。
 * @param {number} ground 当前朝下面的环境光比例
 * @param {number} [lift] 缺省 `CLOUD_HEMI_LIFT`；传 0 ⇒ 逐位返回 ground
 * @returns {number}
 */
export function cloudHemiFloorFor(ground, lift = CLOUD_HEMI_LIFT) {
  return ground + (1 - ground) * lift;
}

/**
 * 云的 AO 地板 —— 与 style 无关（AO 曲线是全局常量），故只由模块初值提供。
 * @param {number} [lift] 缺省 `CLOUD_AO_LIFT`；传 0 ⇒ 逐位返回最暗 AO 因子
 * @returns {number}
 */
export function cloudAoFloorFor(lift = CLOUD_AO_LIFT) {
  const lo = aoFactorFor(0);
  return lo + (1 - lo) * lift;
}

/**
 * 单面最终 shade 的 CPU 参考实现（与 `materials.js` 的 TSL 同公式，红线 1）。
 *
 * ```
 * sunTerm = floor + intensity × max(N·sunDir, 0) × shadowKill
 * hemi    = ground + (1 − ground) × (N.y/2 + 0.5)
 * ao      = 1 − (3 − ao)/3 × AO_CURVE_K
 * 每项    = max(原值, 原值 + (地板 − 原值) × soften)
 * shade   = sunTerm' × hemi' × ao'
 * ```
 *
 * ⚠️ **地板走 `原值 + (地板 − 原值) × soften` 再 `Math.max`，与 TSL 的
 * `mix(原值, max(原值, 地板), cloudT)` 同形** —— 这样 `soften=0` 的逐位性两侧同源
 * （已预验 `mix(a,b,0) = a + (b−a)×0` 在非整比输入上逐位等于 a）。
 * 写成 `soften ? max(...) : 原值` 会出两条路径，TSL 侧无法表达（且未测的那条静默劣化）。
 *
 * ⚠️ 本函数不含 blocklight 项：它标定的是「太阳照亮的面」，
 * 与 `materials.js` 的 `max(sky×hemi×sunTerm, block)` 在 block=0 时同式。
 *
 * @param {object} o
 * @param {number} o.normalIndex 0..5，`FACE_NORMALS` 索引（= packed bit10-12）
 * @param {number} o.ao 0..3
 * @param {readonly number[]} o.sunDir 已归一化的太阳方向
 * @param {number} o.shadowKill 阴影把太阳拿走的比例 0..1（无阴影时 1）
 * @param {number} o.shadowFloor 当前影区地板
 * @param {number} o.sunIntensity 当前太阳强度
 * @param {number} o.hemiGround 当前半球地面比例
 * @param {number} o.soften `uCloudSoften` 0..1（0 ⇒ 逐位回到现状）
 * @param {number} [o.faceContrast] v3.52 面间对比强度 0..1。**缺省 0 = 逐位回到 v3.50**
 *   （既有 7 组不变式与 7776 组零回归用例一字不动）；1 ⇒ 侧 1.38 / 顶 0.95 / 底 0.72。
 * @returns {number}
 */
export function cloudShadeFor({
  normalIndex, ao, sunDir, shadowKill,
  shadowFloor, sunIntensity, hemiGround, soften, faceContrast = 0,
}) {
  // 面法线：与 FACE_NORMALS 同序（+X,-X,+Y,-Y,+Z,-Z）。
  // 本模块零 import ⇒ 这里必须自带一份；由 test-cloud-shade 的交叉一致性用例
  // 与 sun-shade.js 的 FACE_NORMALS 钉住（改序会当场红）。
  const n = CLOUD_FACE_NORMALS[normalIndex];
  const dot = Math.max(n[0] * sunDir[0] + n[1] * sunDir[1] + n[2] * sunDir[2], 0);
  const sunTerm = shadowFloor + sunIntensity * dot * shadowKill;
  const hemi = hemiGround + (1 - hemiGround) * (n[1] * 0.5 + 0.5);
  const aoF = aoFactorFor(ao);
  const sunFloor = cloudSunFloorFor(shadowFloor);
  const hemiFloor = cloudHemiFloorFor(hemiGround);
  const aoFloor = cloudAoFloorFor();
  return Math.max(sunTerm, sunTerm + (sunFloor - sunTerm) * soften)
    * Math.max(hemi, hemi + (hemiFloor - hemi) * soften)
    * Math.max(aoF, aoF + (aoFloor - aoF) * soften)
    * cloudFaceGainFor(normalIndex, faceContrast);
}

/**
 * 面法线表（与 `sun-shade.js` 的 `FACE_NORMALS` 同序同值）。
 * ⚠️ 这是**零 import 的代价**：本模块不能 import sun-shade（会成环）。
 * 两份的一致性由 `test-cloud-shade.js` 的交叉一致性用例钉住，不靠注释约定。
 */
const CLOUD_FACE_NORMALS = Object.freeze([
  Object.freeze([1, 0, 0]), Object.freeze([-1, 0, 0]),
  Object.freeze([0, 1, 0]), Object.freeze([0, -1, 0]),
  Object.freeze([0, 0, 1]), Object.freeze([0, 0, -1]),
]);