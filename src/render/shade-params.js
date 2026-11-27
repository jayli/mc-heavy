// src/render/shade-params.js — 光影地板/强度/半球的**标定常量权威**（three-free 纯数据）
//
// ## 为什么单独成模块（v3.44）
//
// 这三个常量原本住在 `sun-shade.js`（floor/intensity）与 `hemi-shade.js`（ground）。
// v3.44 把它们做成 per-style uniform 后，`daynight.js` 的 `_apply` 需要读它们做**缺省回落**。
// 但 `sun-shade.js` 在模块顶层就要读 `VISUAL_STYLES.noon.sunDirection` 来派生 `NOON_SUN_DIR`
// ⇒ 若 `daynight.js` 反过来 import `sun-shade.js`，就是**循环初始化**：
//
//   ReferenceError: Cannot access 'VISUAL_STYLES' before initialization
//
// （已实测，不是推断。）
//
// 处置：把三个**纯数值**搬到本模块，两边都从这里读 ⇒ 依赖变成单向
//   shade-params ← sun-shade / hemi-shade / daynight
// 权威仍只有一份（红线 1），且本模块不 import 任何东西 ⇒ 不可能成环。
//
// ⚠️ `sun-shade.js` / `hemi-shade.js` 继续 **re-export** 这三个常量：
// 既有 16 处调用方（含单测与 materials.js）的 import 路径一字不动。

/**
 * 影区 / 背光面的环境地板。同时是太阳项的环境地板（`SUN_AMBIENT`）。
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
 *
 * ⚠️ v3.44 起它是**缺省值**：「普通」档用 per-style 的 `shadowFloor`（v3.53 实调为 0.399），
 * 其余四档与自动循环回落到这里 ⇒ 逐位零回归。
 */
export const SHADOW_FLOOR = 0.38;

/** 太阳项的环境地板 —— **恒等于 SHADOW_FLOOR**（同一语义）。 */
export const SUN_AMBIENT = SHADOW_FLOOR;

/**
 * 正午太阳方向的 y 分量（归一化后 = 0.8）。
 *
 * ⚠️ **为什么在这里写 0.8 而不是从 VISUAL_STYLES 派生**：那正是造成循环初始化的那条边。
 * 这个值不是「第二份权威」——它是 `VISUAL_STYLES.noon.sunDirection = [0, 0.8, 0.6]`
 * 归一化后的 y 分量，而 `sun-shade.js` 仍从风格表派生 `NOON_SUN_DIR` 并**断言两者相等**
 * （`test-sun-shade.js` 的既有派生断言 + 本模块的一致性断言）。
 * 改风格表太阳方向时那条断言会立刻真红，不会静默漂移。
 */
export const NOON_SUN_Y_FOR_INTENSITY = 0.8;

/**
 * 太阳强度。取 `(1 − SUN_AMBIENT) / noonSunY` 是**唯一**能让
 * `SUN_AMBIENT + SUN_INTENSITY × noonSunY ≡ 1.0` 成立的取值 —— 也就是
 * **正午顶面亮度恒等于 v1.57 的 1.0**（零回归不变式）。
 *
 * 落地值（地板 0.38 → 强度 0.775；noon，strength=1，无阴影）：
 * 顶面 1.000（**不变**）/ +Z 0.845 / ±X 0.380 / −Z、−X 0.380。
 *
 * ⚠️ v3.44 起它是**缺省值**：「普通」档用 per-style 的 `sunIntensity`（v3.53 实调为 1.282）。
 */
export const SUN_INTENSITY = (1 - SUN_AMBIENT) / NOON_SUN_Y_FOR_INTENSITY;

/**
 * 朝下面收到的环境光相对朝上面的比例。0 = 底面全黑，1 = 关闭半球光。
 *
 * 取值 0.6 的依据：实测 ground=0.2 时朝下面亮度 −56%（97.1 → 42.8）而朝上面逐位不变。
 * 0.6 是「明显但不夸张」的中档 —— 底面 60% 天空光，符合室外地面反照率
 * （草地/石地约 0.2~0.4 反射率叠加多次弹射后的经验量级）。
 *
 * ⚠️ v3.44 起它是**缺省值**：「普通」档用 per-style 的 `hemiGround`（0.12）。
 */
export const HEMI_GROUND = 0.6;