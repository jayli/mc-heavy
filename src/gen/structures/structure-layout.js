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
import { computeAzaleaTreeCandidates } from './azalea-trees.js';
import { computeGiantPyramidAnchor } from './giant-pyramid.js';
import { isTarnZone, computeTarnZone, inTarnRadius } from './tarn-zone.js';

/**
 * 计算单个 region 的确定性布局（纯函数，无缓存——缓存由调用方 StructureIndex 管）。
 * @returns {{
 *   regionX: number, regionZ: number,
 *   pyramidRaw: {centerX:number, centerZ:number},
 *   pyramid: ({cx:number, cz:number}|null),
 *   frozenMountain: ({cx:number, cz:number}|null),
 *   snowLand: {cx:number, cz:number},
 *   plainLand: ({cx:number, cz:number, baseHeight:number}|null),
 *   island: ({cx:number, cz:number}|null),
 *   city: (Object|null),
 *   sky: {skyIslands: Int32Array, cloudClusters: Int32Array},
 *   scatter: {cityScatter: Int32Array, outsideScatter: Int32Array},
 *   giantTrees: {forest: Int32Array, beach: Int32Array, banyan: Int32Array},
 *   azaleaTrees: Int32Array,
 *   giantPyramid: ({wx:number, wz:number, floorY:number}|null),
 *   tarn: (import('./tarn-zone.js').TarnLayout|null)
 * }}
 */
export function computeRegionLayout(regionX, regionZ, seed) {
  // 高台地带（Cloudland Tarn Zone，spec DR-1/DR-2）：region 级判定 + 布局，算一次复用。
  // 地带是「地基级」内容 —— 它整形整个 region 的地表（台地 + 水池 + 巨型云），
  // 与其他地标互斥，故把这些地标整条压成 null（雪原例外，见下方 snowLand 注释）。
  const tarn = isTarnZone(regionX, regionZ, seed) ? computeTarnZone(regionX, regionZ, seed) : null;

  const raw = getRegionSeededCenter(regionX, regionZ, seed);
  const pyramidRaw = { cx: raw.centerX, cz: raw.centerZ };
  // ⚠️ 压制一律写成 `tarn ? null : <原表达式>`，**保留原表达式的求值位置与顺序** ——
  // 原值仍会被算出来（多花几次纯函数调用），换来的是零回归：非地带 region 的每个字段
  // 与 v1.x 逐位相同，不需要重新标定任何既有断言。
  const pyramid = tarn ? null : getPyramidCenterInRegion(regionX, regionZ, seed);
  const frozenMountain = tarn ? null : getFrozenMountainCenterInRegion(regionX, regionZ, seed);

  // snowLand 与 mc-lite 一致：未 clamp 的原始中心 + 偏移（可跨 region，由邻区查询吸收）。
  //
  // ⚠️ **地带 region 的 snowLand 字段仍然保留（不置 null）** —— 它与其它地标不同：
  // 雪原可以跨 region 溢出，压制粒度是「这座雪原是否压进某个地带圆」而不是「本 region
  // 是不是地带」。那个判定在 `snowLandSuppressedByTarn()`（tarn-zone.js），由 apply.js
  // 阶段 1 的跳过门消费。若在此处置 null，会连带打断 6 处消费方（test-structure-layout /
  // test-landmarks / test-giant-trees-gen / structure-gen.html 等直接解引用 `.snowLand.cx`）。
  const snowLand = {
    cx: raw.centerX + LANDMARK_OFFSET.SNOW_LAND_X,
    cz: raw.centerZ + LANDMARK_OFFSET.SNOW_LAND_Z,
  };

  const plainLandCenter = getPlainLandCenterInRegion(regionX, regionZ, seed);
  const plainLandRaw = isPlainLandValid(plainLandCenter.cx, plainLandCenter.cz, seed)
    ? { ...plainLandCenter, baseHeight: estimatePlainLandBaseHeight(plainLandCenter.cx, plainLandCenter.cz, seed) }
    : null;
  const plainLand = tarn ? null : plainLandRaw;

  const { islandCx, islandCz } = getIslandCenterInRegion(regionX, regionZ, seed);
  const islandRaw = isIslandValid(islandCx, islandCz, seed) ? { cx: islandCx, cz: islandCz } : null;
  const island = tarn ? null : islandRaw;

  // City 全世界唯一，固定在 region [0,0]（mc-lite CITY_REGION 语义）。
  // `isTarnZone` 对 CITY_REGION 恒 false（tarn-zone.js），故这里 `tarn` 恒 null、城市永不被压制 ——
  // 那条守卫留在这里只是让「压制」这一侧的判据不必知道城市的特例（单一权威仍在 isTarnZone）。
  const city = (regionX === CITY_REGION.X && regionZ === CITY_REGION.Z) ? buildCityLayout(seed) : null;

  // 空中候选（M2-7）：紧凑 Int32Array，GEN 侧按 AABB 裁剪到 column。
  // ⚠️ **必须无条件调用一次**（`skyFull`），不能写成 `tarn ? 空 : computeSkyCandidates(...)` ——
  // 后者在地带 region 会跳过计算，而 `cloudClusters` 在地带里**仍要保留**（巨型云要避开
  // 原有云簇，且既有云簇的形状/位置在非地带里也是同一份确定性候选）。只调一次也让「清空
  // skyIslands」不必付第二遍计算成本。
  const skyFull = computeSkyCandidates(regionX, regionZ, seed);
  // 地带里清空空岛（池面上不能插浮岛），云簇保留。
  const sky = tarn ? { skyIslands: new Int32Array(0), cloudClusters: skyFull.cloudClusters } : skyFull;

  // 撒布候选（M2 欠账补齐）：同为紧凑 Int32Array，GEN 侧按 AABB 裁剪到 column。
  // 城市候选只在持有 city 布局的 region 算（见 computeScatterCandidates 的口径差异①）。
  const scatterRaw = computeScatterCandidates(regionX, regionZ, seed, city);
  // 地带里不留撒布结构（house / ship / flower_bed …）：台地与水池要干净。
  const scatter = tarn
    ? { cityScatter: new Int32Array(0), outsideScatter: new Int32Array(0) }
    : scatterRaw;

  // 巨树候选（Giant Trees Epic）：全局对齐网格抖动，与 region 邻居无关（不需要 city）；
  // 城市/地标/撒布的排除在 GEN 侧（apply.js 阶段 2.8）用邻域 layouts 判定。
  const giantTreesRaw = computeGiantTreeCandidates(regionX, regionZ, seed);
  // 地带里没有旧植被（台地/水池要干净），故三条路径全空。
  const giantTrees = tarn
    ? { forest: new Int32Array(0), beach: new Int32Array(0), banyan: new Int32Array(0) }
    : giantTreesRaw;

  // 杜鹃树（Azalea Trees Epic）：单条路径，全局对齐网格抖动，与 region 邻居无关。
  //
  // ⚠️ **地带里只剔除「圆内」的候选，不是整块 region 清空**（v2.3 修掉的缺陷）：
  // `tarn ? 空 : compute…` 会把圆外的合法树一并抹掉 —— 地带圆半径 138 只覆盖 400×400 的
  // **37.4%**，圆外 62.6% 仍是普通地形（`pointContext` 只对圆内返回 `kind:'tarn'`）。
  // 实测（seed 12345）`region(2,0)` 的 28 个候选**全部在圆外**，整块清空后那一带留下
  // **104×91 格**的连续纯草地（用户 2026-10-28：「杜鹃花地带中有大片空地没有渲染出树」）。
  // 三个 seed 实测：圆外被误清 70~185 棵/seed（对应 12k~33k 格² 可种树面积）。
  // 判据 `inTarnRadius` 与 `pointContext` 的 `kind:'tarn'` 分支**同源**（红线 1）。
  //
  // ⚠️ 撒布 / 巨树 / 空岛的整块清空是**刻意保留**的：spec DR-6 明写「地带 region 内不出现
  // 撒布结构 / 巨树 / 空岛」，且 `test-tarn-zone.js` 钉住了那几项（不要顺手"修"它们）。
  const azaleaTrees = computeAzaleaTreeCandidates(regionX, regionZ, seed, undefined, tarn);

  // ⚠️ v1.80：沙漠孤立高台系统已整体删除（DR-11，由「高台地带」取代），`mesa` 字段不再存在。

  // 巨型金字塔（Giant Pyramid Epic）：region 级候选，与高台同构。
  // 城市/地标/空岛/高台的排除都已在候选层（`giant-pyramid.js` 拿得到 `getCityBoundsForSeed`
  // 与 `computeRegionLocalAnchor`）；撒布结构的剔除在 GEN 侧阶段 2.7（那里拿得到布局）。
  const giantPyramid = tarn ? null : computeGiantPyramidAnchor(regionX, regionZ, seed);

  return {
    regionX, regionZ, pyramidRaw, pyramid, frozenMountain, snowLand, plainLand,
    island, city, sky, scatter, giantTrees, azaleaTrees, giantPyramid, tarn,
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
