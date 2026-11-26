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
// v3.44：三个标定常量搬到 `shade-params.js`（three-free 纯数据）—— 因为 `daynight.js`
// 现在要读它们做 per-style 缺省回落，而本模块顶层就要读 VISUAL_STYLES
// ⇒ 直接相互 import 会循环初始化（已实测 ReferenceError）。
// **继续 re-export**：既有调用方（materials.js / 单测）的 import 路径一字不动。
import {
  SHADOW_FLOOR, SUN_AMBIENT, SUN_INTENSITY, NOON_SUN_Y_FOR_INTENSITY,
} from './shade-params.js';

export { SHADOW_FLOOR, SUN_AMBIENT, SUN_INTENSITY };

/**
 * 影区/背光面环境地板（`SHADOW_FLOOR`）、太阳项环境地板（`SUN_AMBIENT`）、
 * 太阳强度（`SUN_INTENSITY`）—— **权威已搬到 `shade-params.js`**（v3.44）。
 *
 * 搬家理由：`daynight.js` 现在要读它们做 per-style 缺省回落，而本模块顶层就要读
 * `VISUAL_STYLES.noon.sunDirection` ⇒ 相互 import 会循环初始化（已实测 ReferenceError）。
 * 本模块顶部 **re-export** 保持既有 import 路径不变；
 * 取值依据（v1.70 的 16 组实测扫描）与完整历史见 `shade-params.js` 的注释。
 */

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

// ⚠️ **一致性守卫**（v3.44）：`SUN_INTENSITY` 现在由 `shade-params.js` 的
// `NOON_SUN_Y_FOR_INTENSITY` 派生（为了断开循环依赖）。两者必须相等，
// 否则「正午顶面亮度 ≡ 1.0」这条零回归不变式会静默失效。
// 改风格表太阳方向时这里会立刻抛错（不是靠注释约定）。
if (Math.abs(NOON_SUN_Y - NOON_SUN_Y_FOR_INTENSITY) > 1e-12) {
  throw new Error(
    `[sun-shade] 正午太阳 y 分量（${NOON_SUN_Y}）与 shade-params.js 的 `
    + `NOON_SUN_Y_FOR_INTENSITY（${NOON_SUN_Y_FOR_INTENSITY}）不一致 —— `
    + '改了 VISUAL_STYLES.noon.sunDirection 就必须同步那个常量，'
    + '否则 SUN_INTENSITY 的零回归不变式失效。',
  );
}

/**
 * 太阳强度 `SUN_INTENSITY` 的权威同样在 `shade-params.js`（顶部 re-export）。
 *
 * 它取 `(1 − SUN_AMBIENT) / noonSunY` 是**唯一**能让
 * `SUN_AMBIENT + SUN_INTENSITY × noonSunY ≡ 1.0` 成立的取值 —— 也就是
 * **正午顶面亮度恒等于 v1.57 的 1.0**（零回归不变式）。
 * 上面那条一致性守卫保证「派生用的 y 分量」与风格表里的真值不会漂移。
 *
 * 落地值（地板 0.38 → 强度 0.775；noon，strength=1，无阴影）：
 * 顶面 1.000（**不变**）/ +Z 0.845 / ±X 0.380 / −Z、−X 0.380。
 */

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
 * @param {{shadowFloor?: number, sunIntensity?: number}} [params] v3.44：per-style 光影参数。
 *   **缺省回落全局常量** ⇒ 既有 16 处调用方（含单测与 materials.js）一字不动、逐位零回归。
 *   「普通」档传 `{shadowFloor: 0.14, sunIntensity: 0.956}`。
 *   ⚠️ 只接受这两个：`hemiGround` 是独立因子（由 `hemiFactorFor` 消费），不属于本公式。
 * @returns {[number, number, number]} 乘在 skylight 项上的太阳因子（逐通道）
 */
export function sunTermRGBFor(
  normalIndex, sunDir, strength, shadowKill,
  sunColor = NEUTRAL_LIGHT_COLOR, ambientColor = NEUTRAL_LIGHT_COLOR,
  params = null,
) {
  // 缺省回落：权威是 import 来的常量，不写字面量（红线 1）。
  const floor = typeof params?.shadowFloor === 'number' ? params.shadowFloor : SUN_AMBIENT;
  const intensity = typeof params?.sunIntensity === 'number' ? params.sunIntensity : SUN_INTENSITY;
  const n = FACE_NORMALS[normalIndex];
  const dot = Math.max(n[0] * sunDir[0] + n[1] * sunDir[1] + n[2] * sunDir[2], 0);
  const direct = intensity * dot * shadowKill;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const full = floor * ambientColor[c] + direct * sunColor[c];
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
 * @param {{shadowFloor?: number, sunIntensity?: number}} [params] v3.44：per-style 参数（透传给 RGB 版）
 * @returns {number} 乘在 skylight 项上的太阳因子
 */
export function sunTermFor(normalIndex, sunDir, strength, shadowKill, params = null) {
  return sunTermRGBFor(normalIndex, sunDir, strength, shadowKill, undefined, undefined, params)[0];
}

/**
 * 阴影把太阳拿走的比例（CPU 参考实现，与 `materials.js` 的 TSL 同公式）。
 *
 * ```
 * shadowFactor = mix(1, mix(floor, 1, shadow()), strength)
 * shadowKill   = clamp(1 − (1 − shadowFactor) / (1 − floor), 0, 1)
 * ```
 *
 * ⚠️⚠️ **分母里的 floor 必须与影区地板是同一个值**（v3.44）。
 * per-style 化之前两处都是全局 `SHADOW_FLOOR`，天然同步；现在地板可随风格变，
 * 若只改一处就会撕裂：影区地板是 0.14 而分母还是 0.62
 * ⇒ `shadowKill` 在影区算出 **0.774** 而不是 0 ⇒ 影区竟然还有 77% 的太阳
 * ⇒ 阴影几乎消失，而所有「地板值对不对」的数值判据全绿。
 *
 * 故把这段换算收成一个函数，让 TSL 与单测共用同一份公式（红线 1）。
 *
 * @param {number} shadowFactor 阴影因子（影区 = floor，受光 = 1）
 * @param {number} [floor] 影区地板（缺省 = 全局 `SHADOW_FLOOR`）
 * @returns {number} 0..1
 */
export function shadowKillFor(shadowFactor, floor = SHADOW_FLOOR) {
  const denom = 1 - floor;
  // 防御：floor→1 时分母趋零（关阴影档）→ 退化为「太阳全拿不走」，不产 NaN/Inf。
  if (!(denom > 1e-9)) return 1;
  const k = 1 - (1 - shadowFactor) / denom;
  return Math.min(1, Math.max(0, k));
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
