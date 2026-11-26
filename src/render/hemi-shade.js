// src/render/hemi-shade.js — 半球环境光的标定常数与纯函数（**three-free**）
//
// 为什么单独成模块（与 `sun-shade.js` 平行）：
//   ① Tier 1 单测要在浏览器内直接 import（不必经过 three 的 GPU 初始化）；
//   ② `materials.js` 的 TSL 与单测的 CPU 参考实现必须落在**同一份公式**上求值
//      （红线 1 —— 两处各写一份字面量会漂移出「单测说朝下该暗、GPU 实际没暗」的撕裂，
//      而这类撕裂**没有断言之外的可观测异常**）。
//
// 背景：真实世界里「天空来的环境光」比「地面反射的环境光」亮得多。本仓此前所有面吃同一个
// skylight（户外恒 15，DR-14），所以一个方块的顶面与底面亮度完全一样 —— 这是「一个色块、
// 没立体感」的来源之一，也是「卡通感」的一部分。
//
// 语义边界（**载荷性**）：
//   · 本因子只乘 **skylight 项**，不乘 blocklight（火把照亮的洞穴底面不该变暗）；
//   · 本因子与太阳**无关** —— 它是「环境光的方向性」，所以 `uSunStrength = 0`（关闭方向光）
//     时它**仍然生效**。若把它接进太阳项，关掉方向光会让半球差异一起消失，且夜间月光下
//     朝下面不暗 —— 这是一个用户可见的语义错误。
import { FACE_NORMALS } from './sun-shade.js';
// v3.44：`HEMI_GROUND` 权威搬到 `shade-params.js`（断开 daynight ↔ sun-shade 循环依赖），
// 本模块 re-export 保持既有 import 路径不变。取值依据见那边的注释。
import { HEMI_GROUND } from './shade-params.js';

export { HEMI_GROUND };

/**
 * 朝下面收到的环境光相对朝上面的比例 `HEMI_GROUND` ——
 * **权威已搬到 `shade-params.js`**（v3.44，顶部 re-export 保持 import 路径不变）。
 *
 * 取值 0.6 的依据：实测 ground=0.2 时朝下面亮度 −56%（97.1 → 42.8）而朝上面逐位不变。
 * 0.6 是「明显但不夸张」的中档。完整说明见 `shade-params.js`。
 *
 * ⚠️ v3.44 起它是**缺省值**：「普通」档用 per-style 的 `hemiGround`（0.12），
 * 其余四档与自动循环回落到这里 ⇒ 逐位零回归。
 */

/**
 * 某面法线的半球环境光因子（CPU 参考实现，与 `materials.js` 的 TSL 同公式）。
 *
 * `factor = mix(HEMI_GROUND, 1, n.y × 0.5 + 0.5)`
 *   · 朝上（n.y = +1）→ 1.0（与现状逐位相同 —— 零回归锚点）
 *   · 朝下（n.y = −1）→ ground
 *   · 四侧面（n.y = 0）→ (ground + 1) / 2
 *
 * 权重是 `n.y` 的线性函数，六面之外不会有别的取值，故不需要查表。
 *
 * @param {number} normalIndex 0..5，`FACE_NORMALS` 索引（= packed bit10-12）
 * @param {number} ground 朝下面的因子（`uHemiGround`；1 = 关闭）
 * @returns {number} 乘在 skylight 项上的因子
 */
export function hemiFactorFor(normalIndex, ground) {
  const ny = FACE_NORMALS[normalIndex][1];
  return ground + (1 - ground) * (ny * 0.5 + 0.5);
}
