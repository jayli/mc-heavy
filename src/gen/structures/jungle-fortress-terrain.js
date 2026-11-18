// src/gen/structures/jungle-fortress-terrain.js — 丛林要塞地形耦合（v3.16）
//
// 权威：docs/superpowers/specs/2026-11-18-jungle-fortress-terrain-coupling-design.md DR-2/3/4/10
//
// ## v3.16 语义变更（与 v3.13 相反）
// v3.13 把占地 161×155 **整片削平**到 floorY（挖 17.7 万格）+ 16 格遇湿即止缓坡。
// v3.16 改为原版 RepurposedStructures 语义：**地形保留自然起伏**，结构整体抬到
// 占地自然高度的 75 分位（`anchor.floorY` = baseY），底面悬空处逐列补石墩。
// ⇒ 削平/铺地表/填实三步与 16 格插值缓坡**全部删除**。
//
// ## 本文件现在只做三件事
//   ① `jungleFortressSurfaceYAt`：地表唯一权威（内部 = generateHeight）
//   ② `inJungleFortressTerraform`：植被管理区（占地 + 16，范围与 v3.13 相同）
//   ③ `fillJungleFortressPiers` / `fillJungleFortressSkirt`（后续 Task 加）
//
// Worker 同构：本文件不得 import three。
//
// ⚠️ 本 Task（T2）删削平后地形函数暂时无体素写入，故只留高度/biome 查询依赖；
//    T3（墩）与 T5（裙边）会重新用到 blockIndex / surfaceTypeOfBiome / SEA_Y 等。
import { generateHeight } from '../terrain.js';
import { JUNGLE_FORTRESS_HALF_X, JUNGLE_FORTRESS_HALF_Z } from './jungle-fortress-data.js';

/**
 * 植被管理区的外延宽度（格）。
 *
 * ⚠️ v3.16：**不再用于地形整形**（削平与插值缓坡已删）。保留它只为了
 *    `inJungleFortressTerraform` 的植被管理范围 —— 用户 v3.13b 裁定「过渡带也要有树」。
 */
export const JUNGLE_FORTRESS_SLOPE_BAND = 16;

/**
 * 某列的地表高度（**唯一权威**：墩/裙边/瞬移落点/植被/单测共用）。
 *
 * ⚠️ 不得在别处再写一份 —— 两份漂移会让瞬移落点与真实地表差几格
 * （浅水高台踩过完全同形的坑：玩家悬空或埋进土里）。
 *
 * ⚠️ v3.16：**恒返回数值，不再返回 null**（旧语义的 null = 「在自适应带外不整形」，
 *    现在全区都有定义）。内部恒 = `generateHeight`；Task 5 加裙边后过渡带返回包络值 T。
 *
 * @param {number} wx @param {number} wz @param {number} seed
 * @param {{wx:number, wz:number, floorY:number}} _anchor 保留签名（T5 裙边要用锚点算包络）
 * @returns {number}
 */
export function jungleFortressSurfaceYAt(wx, wz, seed, _anchor) {
  return generateHeight(wx, wz, seed);
}

/**
 * 点是否落在**植被管理区**内（占地 + 16 格的外接方形）。
 *
 * ⚠️ v3.16 语义改为「植被管理区」（旧名「整形区」保留以免改全部调用方）：
 *    地形不再被削平，但这片区的植被由本结构的专属分支接管（密度/让位/树种）。
 *    范围与 v3.13 逐位相同 ⇒ 用户「过渡带也要有树」的裁定仍成立。
 *
 * ⚠️ **不是占地**：撒布剔除用 `inJungleFortressFootprint`（占地），两个判据分开。
 */
export function inJungleFortressTerraform(wx, wz, anchors) {
  if (!anchors) return false;
  const bx = JUNGLE_FORTRESS_HALF_X + JUNGLE_FORTRESS_SLOPE_BAND;
  const bz = JUNGLE_FORTRESS_HALF_Z + JUNGLE_FORTRESS_SLOPE_BAND;
  for (const a of anchors) {
    if (!a) continue;
    if (Math.abs(wx - a.wx) <= bx && Math.abs(wz - a.wz) <= bz) return true;
  }
  return false;
}
