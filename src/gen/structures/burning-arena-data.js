// src/gen/structures/burning-arena-data.js — 灾变竞技场的产物基名与尺寸（纯数据，零 node 依赖）
//
// ⚠️ **必须与 `tools/burning-arena-fingerprint.mjs` 的 `BURNING_ARENA_VARIANTS` /
// `BURNING_ARENA_METRICS` 保持一致**：那份是 node 侧（依赖 `node:fs`，浏览器无法解析），
// 这份是浏览器/Worker 侧。`check:data` 的 `[灾变竞技场]` 环节双向钉住两者相等 ——
// 只加一边会让新变体**静默不出现**（`rasterizeStructure` 拿到空 blocks 直接 return，
// 方块层面完全看不出）。与 `arena-variants.js` 同一手法（双份 + 门禁断言）。
//
// ⚠️ **`src/**` 与浏览器单测绝不能 import `tools/burning-arena-fingerprint.mjs`** ——
// 它依赖 `node:fs`，浏览器解析会失败 → 整个模块不加载 → Worker 起不来 → 游戏白屏，
// 而 `check:arch` 抓不到这类运行时解析失败（B1 教训）。
//
// Worker 同构：本文件不得 import three、不得 fetch。

/** 灾变竞技场 `placement` 类型名（= 产物基名，camelCase） */
export const BURNING_ARENA_VARIANTS = Object.freeze(['burningArena']);

/**
 * 组装后的占地半宽（格）：(85−1)/2 = 42，故 x/z ∈ [−42, 42]。
 *
 * 消费方：`apply.js` 阶段 2.93 的 AABB 早退（`placementIntersects`）。
 * ⚠️ 口径与 `arena.js` 的 `ARENA_HALF_X = (ARENA_WIDTH−1)/2` 一致；
 * `placementIntersects` 内部另有 `INTERSECT_MARGIN`(2) 余量，无需再加。
 */
export const BURNING_ARENA_HALF = 42;
