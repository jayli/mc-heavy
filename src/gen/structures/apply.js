// src/gen/structures/apply.js — 结构注入：fillColumn 之后、光照之前叠加结构方块（设计文档 §4.2）
// 地形整形（地标 elif 链，mc-lite 列循环优先级 city > pyramid > island > plainLand > snowLand > fm）
// + JSON 结构光栅化（城市建筑 / 海岛塔 / 平地金字塔岛，按 AABB 裁剪到本 column）。
// 树木/植被 M2-3 追加。Worker 同构：本文件不得 import three。
import { generateHeight, generateHeightForBiome } from '../terrain.js';
import { getBiome, seededRandom } from '../noise.js';
import {
  getPyramidInfo, generatePyramid, makeColumnSetter,
  getSnowLandInfo, generateSnowLand, snowLandSurfaceY,
  getFrozenMountainInfo, generateFrozenMountain, frozenMountainSurfaceY,
  getIslandInfo, generateIsland, generateIslandSandRing, islandSurfaceY,
  getPlainLandInfo, generatePlainLand,
  getCityInfo, generateCity, getCityFinalSurfaceY,
} from './landmarks.js';
import { getCitySurfaceY, isPointNearCityStructure } from './city-layout.js';
import { CITY_STRUCTURE_FOOTPRINT, ISLAND_SEA_LEVEL } from './region-config.js';
import { preloadStructures, rasterizeStructure, GROUND_SUPPORT_TYPES } from './structure-json.js';
import { applySkyStructures } from './sky-structures.js';
import { generateTree, rollVegetation, rollCityTree } from './vegetation.js';
import { SEA_Y } from '../../voxel/constants.js';

/** 城市 placement 用到的 JSON 结构（GEN 携带城市布局时预载）+ 植被树 JSON */
const CITY_STRUCTURE_TYPES = [
  'castle', 'bigHouse', 'regularHouse1', 'desertTempleTube', 'boxHouse', 'desertVillage',
  'doubleTower', 'treeTower', 'junglePyramid', 'pyramidIsland', 'smallHouse', 'treeHouse',
  'uglyHouse', 'whiteTower', 'woodHouse', 'gate', 'tank', 'tower',
  'birchTree', 'birchTreeWithSnow',
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
 * 植被上下文（mc-lite 列循环各分支的植被挂载点）：
 * kind = city / island / snow / fm / normal / water / none（金字塔/平地不挂植被）。
 */
function pointContext(wx, wz, layouts, cityLayout, seed) {
  const cityInfo = cityLayout && getCityInfo(wx, wz, cityLayout);
  if (cityInfo) {
    // 残丘已清除（generateCity 清 surfaceY+1..naturalH），树直接植根城市地表。
    return { kind: 'city', surfaceY: getCityFinalSurfaceY(wx, wz, cityInfo, seed) };
  }
  for (const layout of layouts) {
    if (getPyramidInfo(wx, wz, layout.pyramid)) return { kind: 'none' };
    if (layout.island) {
      const ii = getIslandInfo(wx, wz, layout.island, seed);
      if (ii) {
        const sy = islandSurfaceY(wx, wz, ii, seed);
        if (sy === null) return { kind: 'none' };
        return { kind: 'island', core: ii.zone === 'core', surfaceY: sy, island: layout.island };
      }
    }
    if (layout.plainLand && getPlainLandInfo(wx, wz, layout.plainLand)) return { kind: 'none' };
    const slInfo = getSnowLandInfo(wx, wz, layout.snowLand, seed);
    if (slInfo) {
      const sy = snowLandSurfaceY(generateHeight(wx, wz, seed), slInfo);
      return { kind: 'snow', core: slInfo.zone === 'core', belowSea: sy <= SEA_Y - 1, surfaceY: sy };
    }
    const fmInfo = getFrozenMountainInfo(wx, wz, layout.frozenMountain, seed);
    if (fmInfo) {
      const sy = frozenMountainSurfaceY(generateHeight(wx, wz, seed), fmInfo);
      return { kind: 'fm', core: fmInfo.zone === 'core', belowSea: sy <= SEA_Y - 1, surfaceY: sy };
    }
  }
  const biome = getBiome(wx, wz, seed);
  const h = generateHeight(wx, wz, seed);
  if (h < SEA_Y) return { kind: 'water', biome, h };
  return { kind: 'normal', biome, h };
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
  // 预载清单按布局内容确定：城市建筑 / 海岛中心塔 / 平地金字塔岛 / 植被树
  // （跨 column 光栅化要求凡查询域内出现对应地标即载入，否则 rasterize 静默跳过）
  const needTypes = new Set(['birchTree', 'birchTreeWithSnow']);
  if (cityLayout) for (const t of CITY_STRUCTURE_TYPES) needTypes.add(t);
  for (const layout of layouts) {
    if (layout.island) needTypes.add('tower');
    if (layout.plainLand) needTypes.add('pyramidIsland');
  }
  await preloadStructures([...needTypes]);

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
    // 海岛中心塔（表面 = 海平面）：塔占地 9×10 可跨 column，按 AABB 相交裁剪
    if (layout.island) {
      const t = layout.island;
      const fp = CITY_STRUCTURE_FOOTPRINT.tower;
      if (placementIntersects({ x: t.cx, z: t.cz }, fp.halfX, fp.halfZ, column.cx, column.cz)) {
        rasterizeStructure('tower', t.cx, ISLAND_SEA_LEVEL + 1, t.cz, setBlock, column, registry, seed, false);
      }
    }
    // 平地中心金字塔岛（mc-lite：y = 自然地形 h + 1，ground support 补平）：
    // 占地 34×39 必跨多 column，按 AABB 相交裁剪（仅中心 column 光栅化会被 chunk 切割）
    if (layout.plainLand) {
      const pl = layout.plainLand;
      const fp = CITY_STRUCTURE_FOOTPRINT.pyramidIsland;
      if (placementIntersects({ x: pl.cx, z: pl.cz }, fp.halfX, fp.halfZ, column.cx, column.cz)) {
        const h = generateHeight(pl.cx, pl.cz, seed);
        rasterizeStructure('pyramidIsland', pl.cx, h + 1, pl.cz, setBlock, column, registry, seed, true);
      }
    }
  }

  // ---- 阶段 2.5：空中结构（M2-7：Y=55 单云 + 空岛，层序先云后岛；mc-lite 空中内容后写）----
  const skyCandidates = layouts.map((l) => l.sky).filter(Boolean);
  if (skyCandidates.length > 0) {
    applySkyStructures(column, skyCandidates, seed, registry);
  }

  // ---- 阶段 3：植被（M2-3，mc-lite 各分支植被规则）----
  // 树冠半径 ≤3：扫描扩展 3 格，树在基点光栅化（setBlock 自动裁剪到本 column）；
  // 单格植物只在本 column 内的点写入。
  const EXT = 3;
  const minX = column.cx * 16, maxX = column.cx * 16 + 15;
  const minZ = column.cz * 16, maxZ = column.cz * 16 + 15;
  for (let wx = minX - EXT; wx <= maxX + EXT; wx++) {
    for (let wz = minZ - EXT; wz <= maxZ + EXT; wz++) {
      const inColumn = wx >= minX && wx <= maxX && wz >= minZ && wz <= maxZ;
      const ctx = pointContext(wx, wz, layouts, cityLayout, seed);

      if (inColumn && ctx.kind === 'water' && ctx.biome === 'SWAMP' && seededRandom(wx, wz, seed + 12) < 0.08) {
        // 睡莲放在水面格的**上一格**（SEA_Y+1，原本是空气），不是 SEA_Y：
        // ① 不覆盖 y=SEA_Y 的水 → 消除「水洞」（原实现盖掉最高一层水格，四周水还在，
        //    且 lilypad.solid=false → 玩家踩上去会掉进洞里）；
        // ② 配合 TEMPLATES.lilypad 的 y=-0.48 → 叶面 (SEA_Y+1)-0.48 = -1.48，恰好高出
        //    下沉后的暴露水面顶面 (SEA_Y+1)-0.5 = -1.50 两厘米 → 紧贴水面、不沉水。
        // mc-lite 的 lilypad 是装饰实体（EntityManager.js:412）不占体素格，故天然无水洞；
        // 本仓库搬成体素方块后必须显式选格。详见 §4.3。
        setBlock(wx, SEA_Y + 1, wz, 'lilypad');
      }

      let tree = null;
      let baseY = null;
      if (ctx.kind === 'normal') {
        const roll = rollVegetation(wx, wz, ctx.biome, seed);
        if (inColumn && roll.plant) setBlock(wx, ctx.h + 1, wz, roll.plant);
        if (roll.tree) { tree = roll.tree; baseY = ctx.h + 1; }
      } else if (ctx.kind === 'city') {
        if (!isPointNearCityStructure(wx, wz, cityLayout, 2)) {
          const roll = rollCityTree(wx, wz, seed);
          if (roll.tree) { tree = roll.tree; baseY = ctx.surfaceY + 1; }
        }
      } else if (ctx.kind === 'snow') {
        if (ctx.core && !ctx.belowSea && seededRandom(wx, wz, seed + 10) < 0.002) {
          tree = { type: 'birchTreeWithSnow' }; baseY = ctx.surfaceY + 1;
        }
      } else if (ctx.kind === 'fm') {
        if (ctx.core && !ctx.belowSea && seededRandom(wx, wz, seed + 11) < 0.001) {
          tree = { type: 'birchTreeWithSnow' }; baseY = ctx.surfaceY + 1;
        }
      } else if (inColumn && ctx.kind === 'island' && ctx.core) {
        // 海岛树：基点抽数量，偏移落点（mc-lite 语义）
        const treeChance = seededRandom(wx, wz, seed + 100);
        const treeCount = treeChance < 0.0015 ? 2 : treeChance < 0.003 ? 1 : 0;
        for (let i = 0; i < treeCount; i++) {
          const ox = Math.floor(seededRandom(i, i + 10, seed + 200) * 10) - 5;
          const oz = Math.floor(seededRandom(i + 5, i + 15, seed + 201) * 10) - 5;
          const treeX = wx + ox, treeZ = wz + oz;
          const tInfo = getIslandInfo(treeX, treeZ, ctx.island, seed);
          const distTower = Math.max(Math.abs(treeX - ctx.island.cx), Math.abs(treeZ - ctx.island.cz));
          if (tInfo && tInfo.zone === 'core' && distTower > 5) {
            generateTree(treeX, ctx.surfaceY + 1, treeZ, setBlock, seed, 'default');
          }
        }
      }

      if (tree) {
        if (tree.type === 'birchTree') {
          rasterizeStructure('birchTree', wx, baseY, wz, setBlock, column, registry, seed, false);
        } else if (tree.type === 'birchTreeWithSnow') {
          rasterizeStructure('birchTreeWithSnow', wx, baseY, wz, setBlock, column, registry, seed, false);
        } else {
          generateTree(wx, baseY, wz, setBlock, seed, tree.type, tree.customLog || null, tree.customLeaf || null);
        }
      }
    }
  }
}
