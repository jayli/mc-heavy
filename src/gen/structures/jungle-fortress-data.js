// src/gen/structures/jungle-fortress-data.js — 丛林要塞的纯数据（零 node 依赖）
//
// ⚠️ **不要 import `tools/jungle-fortress-fingerprint.mjs`**：它依赖 `node:fs`，
// 浏览器/Worker 里解析会失败 → 整个模块不加载 → Worker 起不来 → 游戏白屏
// （B1 教训，`check:arch` 抓不到这类运行时解析失败）。
// 映射表与指纹留在 `tools/` 侧，运行期需要的纯数据在这里。
//
// 权威：docs/superpowers/specs/2026-11-17-jungle-fortress-port-design.md

/** placement 类型名（`structure-json.js` 的 STRUCTURE_FILES 从这里派生） */
export const JUNGLE_FORTRESS_VARIANTS = Object.freeze(['jungleFortress']);

/**
 * 占地半宽（**非空气 footprint** 口径，spec §2.4）。
 *
 * 实测非空气 bbox x∈[-78,80]、z∈[-77,77] ⇒ HALF_X=80、HALF_Z=77（**两轴不同**）。
 * ⚠️ 不得在本仓别处再写一份字面量（红线 1）：两份会漂移出「AABB 裁剪判据与产物尺寸
 * 两套口径」，形态是结构缺一整条边而方块层面看不出。
 */
export const JUNGLE_FORTRESS_HALF_X = 80;
export const JUNGLE_FORTRESS_HALF_Z = 77;

/**
 * 地板层在**归一化坐标**里的 y（= 产物 JSON 的 floorRow）。
 *
 * 结构 y=6 是 center_room 的满铺实心层（大厅地板），归一化后 = 6 − (−6) + 1 = 13。
 * 落位时使该层正好坐在 floorY 上：`rasterizeStructure(type, wx, floorY - (FLOOR_ROW - 1), wz, …)`。
 *
 * ⚠️ **不能用 `floorRowOf()` 读**：它读主线程模块缓存，而产物只在 GEN Worker 里加载过
 * ⇒ 主线程恒返回兜底值 1（废弃堡垒与大竞技场都踩过同源坑）。故这里是**派生冻结值**，
 * 与 `tools/jungle-fortress-fingerprint.mjs` 的 FLOOR_ROW 同源，由单测的产物对账用例钉住。
 */
export const JUNGLE_FORTRESS_FLOOR_ROW = 13;

/** 产物总高（归一化 y ∈ [1,33]）。塔顶世界高度 = floorY + (33 − 13) = floorY + 20。 */
export const JUNGLE_FORTRESS_HEIGHT = 33;