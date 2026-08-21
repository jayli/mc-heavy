// src/gen/structures/apply.js — 结构注入：fillColumn 之后、光照之前叠加结构方块（设计文档 §4.2）
// 地形整形（地标 elif 链，mc-lite 列循环优先级 city > pyramid > island > plainLand > snowLand > fm）
// + JSON 结构光栅化（城市建筑 / 海岛塔 / 平地金字塔岛，按 AABB 裁剪到本 column）。
// 树木/植被 M2-3 追加。Worker 同构：本文件不得 import three。
import { generateHeight, generateHeightForBiome } from '../terrain.js';
import {
  getPyramidInfo, generatePyramid, makeColumnSetter,
  getSnowLandInfo, generateSnowLand,
  getFrozenMountainInfo, generateFrozenMountain,
  getIslandInfo, generateIsland, generateIslandSandRing,
  getPlainLandInfo, generatePlainLand,
  getCityInfo, generateCity,
} from './landmarks.js';
import { getCitySurfaceY } from './city-layout.js';
import { CITY_STRUCTURE_FOOTPRINT, ISLAND_SEA_LEVEL } from './region-config.js';
import { preloadStructures, rasterizeStructure, GROUND_SUPPORT_TYPES } from './structure-json.js';

/** 城市 placement 用到的 JSON 结构（GEN 携带城市布局时预载） */
const CITY_STRUCTURE_TYPES = [
  'castle', 'bigHouse', 'regularHouse1', 'desertTempleTube', 'boxHouse', 'desertVillage',
  'doubleTower', 'treeTower', 'junglePyramid', 'pyramidIsland', 'smallHouse', 'treeHouse',
  'uglyHouse', 'whiteTower', 'woodHouse', 'gate', 'tank', 'tower',
];

/** AABB 相交判定余量（JSON 实测占地与 footprint 表最大偏差 1 格） */
const INTERSECT_MARGIN = 2;

/** placement AABB 是否与 column 相交 */
function placementIntersects(p, halfX, halfZ, cx, cz) {
  const minX = cx * 16, maxX = cx * 16 + 15, minZ = cz * 16, maxZ = cz * 16 + 15;
  return p.x + halfX + INTERSECT_MARGIN >= minX && p.x - halfX - INTERSECT_MARGIN <= maxX &&
         p.z + halfZ + INTERSECT_MARGIN >= minZ && p.z - halfZ - INTERSECT_MARGIN <= maxZ;
}

/**
 * 将布局覆盖本 column 的结构方块裁剪写入 column（生成路径：不记 edits、不 bump version）。
 * 异步：城市布局需预载建筑 JSON（Worker 内 fetch + 模块缓存）。
 * @param {import('../../voxel/chunk-column.js').ChunkColumn} column
 * @param {number} seed
 * @param {*} registry
 * @param {Array<Object>} layouts 查询域内全部 region 布局（StructureIndex.layoutsForColumn）
 */
export async function applyStructuresToColumn(column, seed, registry, layouts) {
  if (!layouts || layouts.length === 0) return;
  const setBlock = makeColumnSetter(column, registry);

  const cityLayout = layouts.find((l) => l.city)?.city || null;
  if (cityLayout) await preloadStructures(CITY_STRUCTURE_TYPES);

  // ---- 阶段 1：地形整形（mc-lite 列循环 elif 链）----
  for (let lx = 0; lx < 16; lx++) {
    for (let lz = 0; lz < 16; lz++) {
      const wx = column.cx * 16 + lx;
      const wz = column.cz * 16 + lz;

      // CITY biome 压平：城内点走 CITY 分支（mc-lite 语义的逐点近似）
      const cityInfo = cityLayout ? getCityInfo(wx, wz, cityLayout) : null;
      const h = cityInfo
        ? generateHeightForBiome(wx, wz, seed, 'CITY')
        : generateHeight(wx, wz, seed);

      if (cityInfo) {
        generateCity(wx, wz, h, cityInfo, setBlock, seed);
        continue;
      }

      let handled = false;
      for (const layout of layouts) {
        if (handled) break;
        const pyInfo = getPyramidInfo(wx, wz, layout.pyramid);
        if (pyInfo) { generatePyramid(wx, wz, h, pyInfo, setBlock, seed); handled = true; break; }

        if (layout.island) {
          const islandInfo = getIslandInfo(wx, wz, layout.island, seed);
          if (islandInfo) {
            const islandResult = generateIsland(wx, wz, islandInfo, setBlock, seed);
            // 过渡圈沙洲与岛内形状噪声挖除处的补沙（mc-lite 列循环 island 分支）
            const dist = islandInfo.distFromCenter;
            if ((dist > 19 && dist < 39) || (!islandResult && dist <= 19)) {
              generateIslandSandRing(wx, wz, islandInfo, setBlock);
            }
            handled = true;
            break;
          }
        }

        if (layout.plainLand) {
          const plainInfo = getPlainLandInfo(wx, wz, layout.plainLand);
          if (plainInfo) { generatePlainLand(wx, wz, h, plainInfo, setBlock); handled = true; break; }
        }

        const slInfo = getSnowLandInfo(wx, wz, layout.snowLand, seed);
        if (slInfo) { generateSnowLand(wx, wz, h, slInfo, setBlock, seed); handled = true; break; }

        const fmInfo = getFrozenMountainInfo(wx, wz, layout.frozenMountain, seed);
        if (fmInfo) { generateFrozenMountain(wx, wz, h, fmInfo, setBlock, seed); handled = true; break; }
      }
    }
  }

  // ---- 阶段 2：JSON 结构光栅化（AABB 覆盖本 column 的全部 placement）----
  if (cityLayout) {
    const all = [...cityLayout.placements, ...cityLayout.fillerPlacements];
    for (const p of all) {
      const fp = CITY_STRUCTURE_FOOTPRINT[p.type];
      const halfX = fp ? fp.halfX : 12; // filler tank 无 footprint 表项，用实测占地
      const halfZ = fp ? fp.halfZ : 12;
      if (!placementIntersects(p, halfX, halfZ, column.cx, column.cz)) continue;
      const surfaceY = getCitySurfaceY(p.x, p.z, cityLayout, seed);
      const centerY = (surfaceY === null ? cityLayout.baseHeight : surfaceY) + 1;
      rasterizeStructure(p.type, p.x, centerY, p.z, setBlock, column, registry, seed,
        GROUND_SUPPORT_TYPES.has(p.type));
    }
  }

  for (const layout of layouts) {
    // 海岛中心塔（表面 = 海平面）
    if (layout.island) {
      const t = layout.island;
      if (Math.floor(t.cx / 16) === column.cx && Math.floor(t.cz / 16) === column.cz) {
        rasterizeStructure('tower', t.cx, ISLAND_SEA_LEVEL + 1, t.cz, setBlock, column, registry, seed, false);
      }
    }
    // 平地中心金字塔岛（mc-lite：y = 自然地形 h + 1，ground support 补平）
    if (layout.plainLand) {
      const pl = layout.plainLand;
      if (Math.floor(pl.cx / 16) === column.cx && Math.floor(pl.cz / 16) === column.cz) {
        const h = generateHeight(pl.cx, pl.cz, seed);
        rasterizeStructure('pyramidIsland', pl.cx, h + 1, pl.cz, setBlock, column, registry, seed, true);
      }
    }
  }
}
