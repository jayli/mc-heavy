// src/render/water-surface.js — **水面高度与水下判据**（three-free，可 Tier 1 单测）
//
// 用户 2026-11-22 裁定（四项，共用本文件这一份权威）：
//   「落叶不要在水下出现，开启雨天光影的时候，雨滴不要在水下出现，
//     地面反光特效不要在水面以下出现，雨滴撞击到地面泛起的水珠也不要在水面以下出现。」
//
// ## 为什么单独成文件而不是塞进 rain-shelter.js
//
// `rain-shelter.js` 答的是「**哪些方块挡雨**」（屋顶语义：实心 ∧ 非 cutout ∧ 非云）。
// 水在那里**有意不挡雨**（`solid=false`，第一条就排除）—— 那条语义是对的，不能改。
// 但「不挡雨的屋顶」与「截停雨滴的表面」是两件事：雨落进湖里应当停在**水面**，
// 而不是穿过水一直落到湖底。故本文件只答「水面在哪 / 某点是否在水下」，
// 由调用方把两者取 max（见 `storm-rain.js`）。
//
// ## 判据走 registry 的表，不写名字白名单（红线 1）
//
// 水体 = **非实心 ∧ transparent 通道**。实测 159 个方块声明里恰好命中
// `water` 与 `swamp_water` 两种；玻璃虽然也是 transparent 但 `solid:true` ⇒ 自动排除。
// 与 `registry.isPlant` 的「派生而非声明」同一手法：将来新增水体只要按既有口径声明
// 就自动纳入，不需要改本文件。
//
// ## 水面高度口径（与 mesher 严格同源）
//
// mesher 对**暴露水面**（上方既无 opaque 覆盖也非同种水）把顶边顶点下沉
// `WATER_SURFACE_SINK` ⇒ 水面顶面 = 水格 y + 1 − SINK。本文件用同一个常量
// （已提级到 `voxel/constants.js`），**不写第二份 0.5**。
//
// ⚠️ 沉在水下的水格**不是水面**（上方还是水）—— 只有最上层那一格算。
// 漏掉这条会让「水面」落在湖底，四项排除全部失效而计数类判据全绿。
//
// 本文件不 import three（Node 单测直接构造 registry + 假 world 即可断言）。
import { SEA_Y, WORLD_MIN_Y, WATER_SURFACE_SINK } from '../voxel/constants.js';

/**
 * 全局水面高度（世界 y）。
 *
 * = `SEA_Y + 1 − WATER_SURFACE_SINK` = **−1.5**，与 `ocean.js` 的
 * `WATER_LEVEL_OFFSET` 严格相等（两者语义同源：SEA_Y + 0.5）。
 *
 * ⚠️ **为什么可以是一个常量而不是逐列查询**：本仓三处写水
 * （`fillColumn` / `fillShallowTarnBasin` / `fillTarnPlateau`）都以 `SEA_Y` 为**上界**，
 * mesher 又统一下沉 SINK ⇒ **所有暴露水面严格共面**。
 * 这条前提由 `test-water-surface.js` 用**真实 fillColumn** 扫一片区域钉住
 * （断言「暴露水面只有一个高度」），不是靠常量互推。
 *
 * ⚠️ 它是**片元侧水下门**（湿地面反光）的基准：TSL 读不到体素，只能用世界高度。
 * 若将来出现非共面的水面（例如可堆叠的半格水），那条门必须改成逐列方案 ——
 * 单测会先红，不会静默失效。
 */
export const WATER_SURFACE_Y = SEA_Y + 1 - WATER_SURFACE_SINK;

/**
 * 该方块是否**水体**（派生判据，不是名字白名单）。
 *
 * 两条：① `solidTable[id] === 0`（非实心）；② `cullTable[id] === 2`（transparent 通道）。
 * ⚠️ 玻璃是 transparent 但 `solid:true` ⇒ 第一条排除（它是屋顶，不是水）。
 * ⚠️ 空气是 `none` 通道、花草是 `cutout` ⇒ 第二条排除。
 *
 * @param {number} id
 * @param {ReturnType<import('../voxel/block-registry.js').createRegistry>} registry
 * @returns {boolean}
 */
export function isWaterLike(id, registry) {
  if (!Number.isInteger(id) || id <= 0) return false;
  if (registry.solidTable[id] !== 0) return false;
  // cullMode: opaque 0 / cutout 1 / transparent 2 / none 3
  return registry.cullTable[id] === 2;
}

/**
 * 该列**暴露水面**的顶面 y（雨丝截停 / 水花落点 / 落叶排除的基准）。
 *
 * 从 `fromY` 往下扫，遇到第一个水体格就判它是否「暴露」：
 * 上方一格既不是 opaque 也不是同种水 ⇒ 它是水面，返回 `y + 1 − SINK`。
 *
 * ⚠️ **x/z 必须取整**：`WorldData.getBlockId` 用 `blockIndex(x - cx*16, …)`，
 * 小数坐标会算出小数数组下标 ⇒ undefined ⇒ 全读成 air（玩家坐标恒带 .5）。
 * ⚠️ **下界钳在 `WORLD_MIN_Y`**：`getBlockId` 对 y < MIN_Y 返回 bedrock（防穿底），
 * 不钳会让未加载列一路扫到世界底。
 * ⚠️ 扫不到返回 **null**（调用方**跳过**，不回落到玩家 y 或世界底 —— 同
 * `rainShelterY` / `leaf-fx._resolveGroundY` 的既有口径）。
 *
 * @param {{getBlockId:(x:number,y:number,z:number)=>number}} world
 * @param {object} registry
 * @param {number} x @param {number} z
 * @param {number} fromY 扫描起点（世界 y）
 * @param {number} [searchDepth=48] 最多往下扫几格
 * @returns {number|null} 水面顶面世界 y；该列无暴露水面时 null
 */
export function waterSurfaceYAt(world, registry, x, z, fromY, searchDepth = 48) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const start = Math.floor(fromY);
  const end = Math.max(WORLD_MIN_Y, start - searchDepth);
  for (let y = start; y >= end; y--) {
    const cid = world.getBlockId(ix, y, iz);
    if (!isWaterLike(cid, registry)) continue;
    // 暴露判据与 mesher 的 `waterSurface` 同式：上方非 opaque 且非同种水
    const aboveId = world.getBlockId(ix, y + 1, iz);
    if (registry.opaqueTable[aboveId] === 1 || aboveId === cid) continue;
    return y + 1 - WATER_SURFACE_SINK;
  }
  return null;
}

/**
 * 该点是否**在水面以下**（落叶 / 雨滴 / 水花 / 湿地面反光的排除判据）。
 *
 * 判据：该列有暴露水面 ∧ 点的 y **严格小于**水面高度。
 * ⚠️ **恰好共面不算水下**：边界取严格不等号，防水面附近的点逐帧翻转（读作闪）。
 * ⚠️ 无暴露水面（陆地 / 屋内积水被盖住）⇒ 恒 false，哪怕 y 很低。
 *
 * @param {{getBlockId:Function}} world
 * @param {object} registry
 * @param {number} x @param {number} y @param {number} z
 * @param {number} [searchDepth=48]
 * @returns {boolean}
 */
export function isBelowWater(world, registry, x, y, z, searchDepth = 48) {
  // 从该点上方一格起扫：点自己所在那格是水时也要能找到它的水面
  const surf = waterSurfaceYAt(world, registry, x, z, Math.ceil(y), searchDepth);
  if (surf === null) return false;
  return y < surf;
}