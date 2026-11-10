// src/gen/structures/ruined-citadel-data.js — 废弃堡垒的产物基名与占地半宽（纯数据，零 node 依赖）
//
// ⚠️ **必须与 `tools/ruined-citadel-fingerprint.mjs` 的 `RUINED_CITADEL_VARIANTS` /
// `RUINED_CITADEL_METRICS` 保持一致**：那份是 node 侧（依赖 `node:fs`，浏览器无法解析），
// 这份是浏览器/Worker 侧。`check:data` 的 `[废弃堡垒]` 环节双向钉住两者相等 ——
// 只加一边会让新变体**静默不出现**（`rasterizeStructure` 拿到空 blocks 直接 return，
// 方块层面完全看不出）。与 `burning-arena-data.js` / `arena-variants.js` 同一手法（双份 + 门禁断言）。
//
// ⚠️ **`src/**` 与浏览器单测绝不能 import `tools/ruined-citadel-fingerprint.mjs`** ——
// 它依赖 `node:fs`，浏览器解析会失败 → 整个模块不加载 → Worker 起不来 → 游戏白屏，
// 而 `check:arch` 抓不到这类运行时解析失败（B1 教训）。
//
// Worker 同构：本文件不得 import three、不得 fetch。

/** 废弃堡垒 `placement` 类型名（= 产物基名，camelCase） */
export const RUINED_CITADEL_VARIANTS = Object.freeze(['ruinedCitadel']);

/**
 * 组装后的占地半宽（格）—— **非空气 bbox 106×108** 的半宽，不是产物 bbox（107×110）。
 *
 * ⚠️ **两者差 1 格，别混**：产物含甲板以下空气，空气伸到 x=-53 / z=-55；而 footprint
 * （干燥判据 / 避让 / 压制 / column 相交裁剪的口径）只看非空气部分 x∈[-52,53] / z∈[-53,54]。
 * 多出的那 1 格空气在 ny=1（世界 y = floorY-44 ≤ -40 < WORLD_MIN_Y），恒被越界守卫丢弃，
 * 永不写入世界 ⇒ 它不参与任何占地判据。
 * `test-ruined-citadel-gen.js` 从产物重算这两个值钉住（红线 1：产物是权威）。
 *
 * 消费方：`apply.js` 阶段 2.94 的 AABB 早退（`placementIntersects`）、
 * `ruined-citadel.js` 的锚点搜索与压制判据。
 * ⚠️ x/z 半宽**不同**（53/54），故所有消费方必须分开传，不得写成同一个值
 * （本结构不是正方形；`placementIntersects` 内部另有 `INTERSECT_MARGIN`(2) 余量）。
 */
export const RUINED_CITADEL_HALF_X = 53;
export const RUINED_CITADEL_HALF_Z = 54;
