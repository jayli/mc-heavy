// src/render/sun-shade.js — 太阳方向光的标定常数与纯函数（**three-free**）
//
// 为什么单独成模块：
//   ① Tier 1 单测要能在浏览器内直接 import（不必经过 three 的 GPU 初始化）；
//   ② `tools/check-data.mjs`（node）也能 import 它断言常数关系；
//   ③ `materials.js` 的 TSL 与单测的 CPU 参考实现必须落在**同一份常数**上求值
//      （红线 1 —— 两处各写一份字面量会漂移出「单测说该亮、GPU 实际不亮」的撕裂，
//      而这类撕裂**没有断言之外的可观测异常**）。
//
// 背景：v1.58 之前体素材质是纯 unlit —— 顶点 shade 只有 `max(skylight, blocklight) × ao`，
// 户外 skylight 恒 15 → **一个方块六面亮度完全相同**，不存在任何朝向差异（「光影太平淡」的根因）。
// 本模块提供 N·L 方向光那一项的标定，materials.js 负责把它接进 TSL。
import { VISUAL_STYLES } from './daynight.js';

/**
 * 影区 / 背光面的环境地板。同时是太阳项的环境地板（见 `SUN_AMBIENT`）。
 *
 * **取值 0.38（v1.70，用户拍板的实测标定值）**。
 *
 * 历史：v1.58 取 0.5，依据是 mc-lite 的 `ambient/(ambient + sun·NdotL)`
 * = 2.3/(2.3 + 3.2×0.8) = 0.4733 → 四舍五入 0.5。但那个推导回答的是「mc-lite 的影区
 * 有多亮」，而不是「本仓该有多亮」—— mc-lite 的材质是受光的 `MeshStandardNodeMaterial`，
 * 而本仓是 unlit 管线，两边暗部基准不同（同 v1.45 的 `shadow.radius` 教训）。
 *
 * 0.38 的实测依据（960×540，`style=noon`，真实世界，16 组扫描）：
 *   · 暗部 p5：52（地板 0.5）→ **29**（地板 0.38）→ 22（地板 0.28，已发闷）
 *   · 对比跨度 p95−p5：163 → **183**
 *   · 迎光/背光比：1.302 → **1.46**
 * 0.28 的暗部更黑但影区内都会发闷，0.38 是「拉开动态范围」与「暗部不死黑」的交点。
 */
export const SHADOW_FLOOR = 0.38;

/** 太阳项的环境地板 —— **恒等于 SHADOW_FLOOR**（同一语义，见上）。 */
export const SUN_AMBIENT = SHADOW_FLOOR;

/**
 * 六个世界面法线（索引与 `mesher.js` 的 `FACE_DIRS` / packed bit10-12 **完全同序**）。
 * ⚠️ 顺序是载荷性的：packed 里存的就是这个索引，表序一改所有面的明暗都会错位。
 */
export const FACE_NORMALS = Object.freeze([
  Object.freeze([1, 0, 0]), Object.freeze([-1, 0, 0]),
  Object.freeze([0, 1, 0]), Object.freeze([0, -1, 0]),
  Object.freeze([0, 0, 1]), Object.freeze([0, 0, -1]),
]);

/**
 * 正午太阳方向（已归一化，新数组 —— 不改写 VISUAL_STYLES 的权威原值）。
 * 从风格数据派生而非写字面量：改风格太阳方向时强度与默认 uniform 自动跟上。
 */
const _noonRaw = VISUAL_STYLES.noon.sunDirection;
const _noonLen = Math.sqrt(_noonRaw[0] ** 2 + _noonRaw[1] ** 2 + _noonRaw[2] ** 2);
export const NOON_SUN_DIR = Object.freeze([
  _noonRaw[0] / _noonLen, _noonRaw[1] / _noonLen, _noonRaw[2] / _noonLen,
]);

/** 正午太阳方向归一化后的 y 分量（= 0.8）。 */
export const NOON_SUN_Y = NOON_SUN_DIR[1];

/**
 * 太阳强度。取 `(1 − SUN_AMBIENT) / NOON_SUN_Y` 是**唯一**能让
 * `SUN_AMBIENT + SUN_INTENSITY × noonSunY ≡ 1.0` 成立的取值 —— 也就是
 * **正午顶面亮度恒等于 v1.57 的 1.0**（零回归不变式，本项改动只动背光面与影区）。
 *
 * 落地值（地板 0.38 → 强度 0.775；noon，strength=1，无阴影）：
 * 顶面 1.000（**不变**）/ +Z 0.845 / ±X 0.380 / −Z、−X 0.380。
 * 对比度（顶面/背光面）**2.63×**（v1.58 的 0.5 地板时代是 2.0×）。
 */
export const SUN_INTENSITY = (1 - SUN_AMBIENT) / NOON_SUN_Y;

/**
 * 中性色温（= 不改变颜色）。其余三种风格与自动日夜循环全程用它 → **逐位回到**无颜色管线。
 * 冻结以免任何调用方原地改写这份共享常量。
 */
export const NEUTRAL_LIGHT_COLOR = Object.freeze([1, 1, 1]);

/**
 * 太阳项（**含色温**，CPU 参考实现，与 `materials.js` 的 TSL 同公式）。
 *
 * 每个通道分别计算、共享同一个 `dot × shadowKill`（几何只算一次，色温只换颜色）：
 * ```
 * full_c   = SUN_AMBIENT × ambientColor_c + SUN_INTENSITY × dot × shadowKill × sunColor_c
 * sunTerm_c = mix(1, full_c, strength)
 * ```
 *
 * 语义：**环境项吃环境色、直射项吃直射色**。v1.71 之前两者都乘同一个标量（全白），
 * 所以黄昏那种「暖橙直射 + 冷蓝环境」在旧公式里根本表达不出来 —— 这正是本函数存在的原因。
 *
 * ⚠️ **色温是相对乘数，不是颜色叠加**：两侧都是均值 ≈1 的乘数，改色相不改总曝光。
 * ⚠️ **中性色（全 1）时逐位等于旧的标量公式** —— `sunTermFor()` 就是它的 R 通道，
 * 不保留第二份公式（红线 1）。
 *
 * @param {number} normalIndex 0..5，`FACE_NORMALS` 索引（= packed bit10-12）
 * @param {readonly number[]} sunDir 已归一化的太阳方向
 * @param {number} strength `uSunStrength`（0 = 关闭，**逐位回到**无方向光的现状）
 * @param {number} shadowKill 阴影把太阳拿走的比例：`clamp((shadowFactor − SHADOW_FLOOR) /
 *   (1 − SHADOW_FLOOR), 0, 1)`。无太阳灯（fixture 路径）时传 1。
 * @param {readonly number[]} [sunColor] 直射光色温乘数（RGB，均值 ≈1）
 * @param {readonly number[]} [ambientColor] 环境光色温乘数（RGB，均值 ≈1）
 * @returns {[number, number, number]} 乘在 skylight 项上的太阳因子（逐通道）
 */
export function sunTermRGBFor(
  normalIndex, sunDir, strength, shadowKill,
  sunColor = NEUTRAL_LIGHT_COLOR, ambientColor = NEUTRAL_LIGHT_COLOR,
) {
  const n = FACE_NORMALS[normalIndex];
  const dot = Math.max(n[0] * sunDir[0] + n[1] * sunDir[1] + n[2] * sunDir[2], 0);
  const direct = SUN_INTENSITY * dot * shadowKill;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const full = SUN_AMBIENT * ambientColor[c] + direct * sunColor[c];
    out[c] = 1 + (full - 1) * strength; // mix(1, full, strength)
  }
  return out;
}

/**
 * 太阳项标量版 —— **只是 `sunTermRGBFor` 在中性白下的 R 通道**（不留第二份公式）。
 * 保留它是为了让既有调用方/测试的「明暗结构」断言语义不变（色温不参与时就是个标量）。
 *
 * @param {number} normalIndex 0..5，`FACE_NORMALS` 索引
 * @param {readonly number[]} sunDir 已归一化的太阳方向
 * @param {number} strength `uSunStrength`
 * @param {number} shadowKill 阴影把太阳拿走的比例
 * @returns {number} 乘在 skylight 项上的太阳因子
 */
export function sunTermFor(normalIndex, sunDir, strength, shadowKill) {
  return sunTermRGBFor(normalIndex, sunDir, strength, shadowKill)[0];
}

/**
 * sRGB 传递函数（线性 → sRGB 编码值，返回 0..1）。
 *
 * **为什么这个低层模块需要它**：判「暖/冷」这类色相结论时，**线性空间的比值与屏幕观感
 * 差一个数量级**（CLAUDE.md 里 `shadow.radius` 与太阳项的既有教训：线性 1.750 的比值过
 * sRGB 后只有 1.282）。所以色温参数的标定与断言都必须落在屏幕口径上 —— 把这两个函数
 * 收在这里，让 Tier 1 单测与 Tier 4 像素判据共用同一份公式（红线 1）。
 *
 * @param {number} x 线性值
 * @returns {number} sRGB 编码值（0..1）
 */
export function srgbEncode(x) {
  if (x <= 0.0031308) return x * 12.92;
  return 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

/**
 * ACES Filmic 色调映射的解析近似（Krzysztof Narkowicz 拟合）—— 与 GPU 侧
 * `THREE.ACESFilmicToneMapping` 同一个近似族。**只用于单测标定**（Tier 4 读真实像素）。
 *
 * @param {number} x 线性值（已乘曝光）
 * @returns {number} 映射后的线性值
 */
export function acesFilmic(x) {
  const a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return Math.min(1, Math.max(0, (x * (a * x + b)) / (x * (c * x + d) + e)));
}
