// src/gen/structures/structure-layout.js — region 确定性布局（设计文档 §4.2）
// 布局 = 该 region 的地标清单与位置（seed 确定性，任意 Worker 可重算且结果一致）。
// 布局在 Worker 'layout' RPC 里算一次，主线程缓存并随 GEN 任务下发（DR-13）。
// Worker 同构：本文件不得 import three。
import { REGION_SIZE, LANDMARK_OFFSET, CITY_REGION } from './region-config.js';
import { getRegionSeededCenter } from './region-center.js';
import {
  getPyramidCenterInRegion, getFrozenMountainCenterInRegion,
  getPlainLandCenterInRegion, estimatePlainLandBaseHeight,
  getIslandCenterInRegion, isIslandValid, isPlainLandValid,
} from './landmarks.js';
import { buildCityLayout } from './city-layout.js';
import { computeSkyCandidates } from './sky-structures.js';
import { computeScatterCandidates } from './scatter.js';
import { computeGiantTreeCandidates } from './giant-trees.js';
import { computeMesaAnchor } from './mesa.js';
import { computeGiantPyramidAnchor } from './giant-pyramid.js';

/**
 * 计算单个 region 的确定性布局（纯函数，无缓存——缓存由调用方 StructureIndex 管）。
 * @returns {{
 *   regionX: number, regionZ: number,
 *   pyramidRaw: {centerX:number, centerZ:number},
 *   pyramid: {cx:number, cz:number},
 *   frozenMountain: {cx:number, cz:number},
 *   snowLand: {cx:number, cz:number},
 *   plainLand: ({cx:number, cz:number, baseHeight:number}|null),
 *   island: ({cx:number, cz:number}|null),
 *   city: (Object|null),
 *   sky: {skyIslands: Int32Array, cloudClusters: Int32Array},
 *   scatter: {cityScatter: Int32Array, outsideScatter: Int32Array},
 *   giantTrees: {forest: Int32Array, beach: Int32Array, banyan: Int32Array},
 *   mesa: ({wx:number, wz:number, floorY:number}|null),
 *   giantPyramid: ({wx:number, wz:number, floorY:number}|null)
 * }}
 */
export function computeRegionLayout(regionX, regionZ, seed) {
  const raw = getRegionSeededCenter(regionX, regionZ, seed);
  const pyramidRaw = { cx: raw.centerX, cz: raw.centerZ };
  const pyramid = getPyramidCenterInRegion(regionX, regionZ, seed);
  const frozenMountain = getFrozenMountainCenterInRegion(regionX, regionZ, seed);

  // snowLand 与 mc-lite 一致：未 clamp 的原始中心 + 偏移（可跨 region，由邻区查询吸收）
  const snowLand = {
    cx: raw.centerX + LANDMARK_OFFSET.SNOW_LAND_X,
    cz: raw.centerZ + LANDMARK_OFFSET.SNOW_LAND_Z,
  };

  const plainLandCenter = getPlainLandCenterInRegion(regionX, regionZ, seed);
  const plainLand = isPlainLandValid(plainLandCenter.cx, plainLandCenter.cz, seed)
    ? { ...plainLandCenter, baseHeight: estimatePlainLandBaseHeight(plainLandCenter.cx, plainLandCenter.cz, seed) }
    : null;

  const { islandCx, islandCz } = getIslandCenterInRegion(regionX, regionZ, seed);
  const island = isIslandValid(islandCx, islandCz, seed) ? { cx: islandCx, cz: islandCz } : null;

  // City 全世界唯一，固定在 region [0,0]（mc-lite CITY_REGION 语义）
  const city = (regionX === CITY_REGION.X && regionZ === CITY_REGION.Z) ? buildCityLayout(seed) : null;

  // 空中候选（M2-7）：紧凑 Int32Array，GEN 侧按 AABB 裁剪到 column
  const sky = computeSkyCandidates(regionX, regionZ, seed);

  // 撒布候选（M2 欠账补齐）：同为紧凑 Int32Array，GEN 侧按 AABB 裁剪到 column。
  // 城市候选只在持有 city 布局的 region 算（见 computeScatterCandidates 的口径差异①）。
  const scatter = computeScatterCandidates(regionX, regionZ, seed, city);

  // 巨树候选（Giant Trees Epic）：全局对齐网格抖动，与 region 邻居无关（不需要 city）；
  // 城市/地标/撒布的排除在 GEN 侧（apply.js 阶段 2.8）用邻域 layouts 判定。
  const giantTrees = computeGiantTreeCandidates(regionX, regionZ, seed);

  // 高台（Cloudland Epic）：每 region 至多一个沙漠平地锚点。
  // 纯函数、无异步依赖（基座判据用 15×15 常量矩形，不读烘焙产物 —— 候选层不能 fetch，见 mesa.js 头注）。
  // 城市/地标让路在 GEN 侧阶段 2.75 判（城市 bounds 可跨 region，候选层只能过滤一半）。
  const mesa = computeMesaAnchor(regionX, regionZ, seed);

  // 巨型金字塔（Giant Pyramid Epic）：region 级候选，与高台同构。
  // 城市/地标/空岛/高台的排除都已在候选层（`giant-pyramid.js` 拿得到 `getCityBoundsForSeed`
  // 与 `computeRegionLocalAnchor`）；撒布结构的剔除在 GEN 侧阶段 2.7（那里拿得到布局）。
  const giantPyramid = computeGiantPyramidAnchor(regionX, regionZ, seed);

  return {
    regionX, regionZ, pyramidRaw, pyramid, frozenMountain, snowLand, plainLand,
    island, city, sky, scatter, giantTrees, mesa, giantPyramid,
  };
}

/**
 * column 覆盖的基 region 列表（column 可能横跨 region 边界 → 1/2/4 个）。
 * @returns {Array<{regionX: number, regionZ: number}>}
 */
export function regionsForColumn(cx, cz) {
  const minX = cx * 16, maxX = cx * 16 + 15;
  const minZ = cz * 16, maxZ = cz * 16 + 15;
  const out = [];
  for (const rx of [Math.floor(minX / REGION_SIZE), Math.floor(maxX / REGION_SIZE)]) {
    for (const rz of [Math.floor(minZ / REGION_SIZE), Math.floor(maxZ / REGION_SIZE)]) {
      if (!out.some((r) => r.regionX === rx && r.regionZ === rz)) out.push({ regionX: rx, regionZ: rz });
    }
  }
  return out;
}

/**
 * column 的查询域：全部基 region 的 3×3 邻域并集（跨 region 溢出解法，§4.2）。
 * @returns {string[]} regionKey 数组（"rx,rz"）
 */
export function neighborRegionKeys(cx, cz) {
  const keys = new Set();
  for (const { regionX, regionZ } of regionsForColumn(cx, cz)) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        keys.add(`${regionX + dx},${regionZ + dz}`);
      }
    }
  }
  return [...keys];
}
