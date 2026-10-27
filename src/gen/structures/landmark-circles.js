// src/gen/structures/landmark-circles.js — 本 region 的地标圆（半径 = 核心 + 过渡带）
//
// 从 `mesa.js` 搬出来（DR-11：沙漠孤立高台系统整体删除，但巨型金字塔仍需要这批地标圆）。
//
// **为什么必须单独一个文件而不能跟着 mesa.js 一起删**：
// `giant-pyramid.js` 的候选层 import `regionLandmarkCenters` 做排除（高台不能压在地标上）。
// 若把这段逻辑留在 `mesa.js` 而把文件删掉，`giant-pyramid.js` 会 import 一个不存在的模块
// → **Worker 启动失败 → 游戏页白屏**，而 `check:arch` 抓不到这类运行时解析失败。
//
// Worker 同构：本文件不得 import three、不得 fetch、不得自建 Worker。
import {
  getPyramidCenterInRegion, getFrozenMountainCenterInRegion,
  getPlainLandCenterInRegion, getIslandCenterInRegion,
  isPlainLandValid, isIslandValid,
} from './landmarks.js';
import {
  PYRAMID_SIZE, FROZEN_MOUNTAIN_SIZE, SNOW_LAND_SIZE, ISLAND_SIZE,
  PLAIN_LAND_SIZE, TRANSITION_SIZE,
} from './region-config.js';

/**
 * 各地标的排除半径（核心半宽 + 过渡带）。
 *
 * 半径取「核心 + 过渡带」的保守值：宁可多避让几格，也不要半个结构压在地标上。
 * ⚠️ 雪原**也在这里**（`snowLand`键），但 `regionLandmarkCenters()` 不返回它 ——
 * 它没有 `getSnowLandCenterInRegion` 导出，且只有曾经的 mesa 判据用它。
 * 键保留是为了将来需要时不必重新推导常量（推导过程记在这里）。
 */
export const LANDMARK_CLEARANCE = Object.freeze({
  pyramid: PYRAMID_SIZE / 2 + TRANSITION_SIZE.PYRAMID,
  frozenMountain: FROZEN_MOUNTAIN_SIZE / 2 + TRANSITION_SIZE.FROZEN_MOUNTAIN,
  snowLand: SNOW_LAND_SIZE / 2 + TRANSITION_SIZE.SNOW_LAND,
  island: ISLAND_SIZE / 2 + TRANSITION_SIZE.ISLAND,
  plainLand: PLAIN_LAND_SIZE / 2,
});

/**
 * 本 region 的地标圆（半径 = 核心 + 过渡带），**供多个候选层共用**。
 *
 * 抽出来的理由：巨型金字塔的候选层需要**同一批地标圆**做排除（红线 1：不留第二份副本）。
 *
 * ⚠️ **雪原刻意不在这里**：它没有导出中心函数（只有 `getSnowLandOffset` 那类推导），
 * 且当前没有消费者（原来用它的是已删除的 mesa 判据）。
 * ⚠️ **每次调用返回新数组**：调用方可以自由 push 而不污染下一次调用。
 *
 * @param {number} regionX @param {number} regionZ @param {number} seed
 * @returns {Array<{cx:number, cz:number, r:number}>}
 */
export function regionLandmarkCenters(regionX, regionZ, seed) {
  const circles = [];
  const push = (c, r) => { if (c) circles.push({ cx: c.cx, cz: c.cz, r }); };

  push(getPyramidCenterInRegion(regionX, regionZ, seed), LANDMARK_CLEARANCE.pyramid);
  push(getFrozenMountainCenterInRegion(regionX, regionZ, seed), LANDMARK_CLEARANCE.frozenMountain);

  // 平地与海岛是**条件地标**（isXxxValid 为假时 layout 里它们是 null）—— 这里同样只排除有效的
  const plain = getPlainLandCenterInRegion(regionX, regionZ, seed);
  if (isPlainLandValid(plain.cx, plain.cz, seed)) push(plain, LANDMARK_CLEARANCE.plainLand);
  const isl = getIslandCenterInRegion(regionX, regionZ, seed);
  if (isIslandValid(isl.islandCx, isl.islandCz, seed)) {
    push({ cx: isl.islandCx, cz: isl.islandCz }, LANDMARK_CLEARANCE.island);
  }

  return circles;
}
