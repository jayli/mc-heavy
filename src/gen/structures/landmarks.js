// src/gen/structures/landmarks.js — 地标位置/形状算法（移植 mc-lite workers/maps/*）
// M2-1 范围：各 landmark 中心计算 + 金字塔 info/generate；
// 其余地标 info/generate 随 M2-2 追加。
// Worker 同构：本文件不得 import three。
import { getRegionSeededCenter, clampCenterToRegion } from './region-center.js';
import {
  REGION_SIZE, REGION_MIN_MARGIN,
  PYRAMID_SIZE, FROZEN_MOUNTAIN_SIZE, PLAIN_LAND_SIZE, ISLAND_SIZE,
  TRANSITION_SIZE, LANDMARK_OFFSET, LANDMARK_MIN_DISTANCE,
} from './region-config.js';
import { seededRandom, getBiome } from '../noise.js';
import { generateHeight } from '../terrain.js';
import { SEA_Y, WORLD_MIN_Y, WORLD_MAX_Y, blockIndex } from '../../voxel/constants.js';

// ==================== 中心计算 ====================

/** 金字塔中心（含边界约束；mc-lite Pyramid.getPyramidCenterInRegion） */
export function getPyramidCenterInRegion(regionX, regionZ, seed) {
  const halfSize = Math.floor(PYRAMID_SIZE / 2);
  const totalHalfSize = halfSize + TRANSITION_SIZE.PYRAMID;
  const minMargin = totalHalfSize + REGION_MIN_MARGIN;
  const { centerX, centerZ } = getRegionSeededCenter(regionX, regionZ, seed);
  return clampCenterToRegion(regionX, regionZ, centerX, centerZ, minMargin);
}

/** 冰封山峰中心（金字塔位 + (-160,0)，mc-lite FrozenMountain.getFrozenMountainCenterInRegion） */
export function getFrozenMountainCenterInRegion(regionX, regionZ, seed) {
  const { centerX: pyramidCx, centerZ: pyramidCz } = getRegionSeededCenter(regionX, regionZ, seed);
  const mountainCx = pyramidCx + LANDMARK_OFFSET.FROZEN_MOUNTAIN_X;
  const mountainCz = pyramidCz + LANDMARK_OFFSET.FROZEN_MOUNTAIN_Z;
  // mc-lite 的 margin 用 FROZEN_MOUNTAIN_CORE（4）而非完整过渡带，保持一致
  const fmHalfSize = Math.floor(FROZEN_MOUNTAIN_SIZE / 2);
  const fmTotalHalfSize = fmHalfSize + TRANSITION_SIZE.FROZEN_MOUNTAIN_CORE;
  const fmMinMargin = fmTotalHalfSize + REGION_MIN_MARGIN;
  return clampCenterToRegion(regionX, regionZ, mountainCx, mountainCz, fmMinMargin);
}

/** 平地中心（金字塔位 + (0,160)，mc-lite PlainLand.getPlainLandCenterInRegion） */
export function getPlainLandCenterInRegion(regionX, regionZ, seed) {
  const { centerX: pyramidCx, centerZ: pyramidCz } = getRegionSeededCenter(regionX, regionZ, seed);
  const plainLandCx = pyramidCx + LANDMARK_OFFSET.PLAIN_LAND_X;
  const plainLandCz = pyramidCz + LANDMARK_OFFSET.PLAIN_LAND_Z;
  const halfSize = Math.floor(PLAIN_LAND_SIZE / 2);
  const minMargin = halfSize + REGION_MIN_MARGIN;
  return clampCenterToRegion(regionX, regionZ, plainLandCx, plainLandCz, minMargin);
}

/** 平地基准高度：9 点采样最低值 + 稳定扰动（mc-lite estimatePlainLandBaseHeight） */
export function estimatePlainLandBaseHeight(centerX, centerZ, seed) {
  const halfSize = Math.floor(PLAIN_LAND_SIZE / 2);
  const sampleOffsets = [
    [0, 0], [halfSize, 0], [-halfSize, 0], [0, halfSize], [0, -halfSize],
    [halfSize, halfSize], [halfSize, -halfSize], [-halfSize, halfSize], [-halfSize, -halfSize],
  ];
  let minHeight = Infinity;
  for (const [ox, oz] of sampleOffsets) {
    const h = generateHeight(centerX + ox, centerZ + oz, seed);
    if (h < minHeight) minHeight = h;
  }
  const stableOffset = Math.floor(Math.abs(Math.sin(seed * 0.17 + centerX * 0.01 + centerZ * 0.013)) * 0.5);
  return minHeight + stableOffset;
}

/**
 * 海岛中心（独立偏移参数 + 与冰封山/金字塔的最小距离修正 + 边界钳制，
 * mc-lite IslandMap.getIslandCenterInRegion）。
 * @returns {{islandCx: number, islandCz: number}}
 */
export function getIslandCenterInRegion(regionX, regionZ, seed) {
  const { centerX: pyramidCx, centerZ: pyramidCz } = getRegionSeededCenter(regionX, regionZ, seed);
  const { cx: frozenMountainCx, cz: frozenMountainCz } = getFrozenMountainCenterInRegion(regionX, regionZ, seed);

  const { centerX: initialIslandCx, centerZ: initialIslandCz } = getRegionSeededCenter(regionX, regionZ, seed, {
    offsetScaleX: REGION_SIZE - 100,
    offsetScaleZ: REGION_SIZE - 100,
    offsetBaseX: 50,
    offsetBaseZ: 50,
  });

  let islandCx = initialIslandCx;
  let islandCz = initialIslandCz;

  // 距离检查：远离冰封山峰
  const minMountainDistance = LANDMARK_MIN_DISTANCE.ISLAND_FROM_MOUNTAIN;
  let distFromMountain = Math.max(Math.abs(islandCx - frozenMountainCx), Math.abs(islandCz - frozenMountainCz));
  if (distFromMountain < minMountainDistance) {
    islandCx = frozenMountainCx + (islandCx > frozenMountainCx ? -minMountainDistance : minMountainDistance);
    islandCz = frozenMountainCz + (islandCz > frozenMountainCz ? -minMountainDistance : minMountainDistance);
  }

  // 距离检查：远离金字塔
  const minPyramidDistance = LANDMARK_MIN_DISTANCE.ISLAND_FROM_PYRAMID;
  let distFromPyramid = Math.max(Math.abs(islandCx - pyramidCx), Math.abs(islandCz - pyramidCz));
  if (distFromPyramid < minPyramidDistance) {
    islandCx = pyramidCx + (islandCx > pyramidCx ? -minPyramidDistance : minPyramidDistance);
    islandCz = pyramidCz + (islandCz > pyramidCz ? -minPyramidDistance : minPyramidDistance);
  }

  // 边界检查
  const halfSize = Math.floor(ISLAND_SIZE / 2);
  const totalHalfSize = halfSize + TRANSITION_SIZE.ISLAND;
  const minMargin = totalHalfSize + REGION_MIN_MARGIN;
  const regionLeft = regionX * REGION_SIZE;
  const regionRight = (regionX + 1) * REGION_SIZE;
  const regionTop = regionZ * REGION_SIZE;
  const regionBottom = (regionZ + 1) * REGION_SIZE;

  if (islandCx - minMargin < regionLeft) islandCx = regionLeft + minMargin;
  else if (islandCx + minMargin > regionRight) islandCx = regionRight - minMargin;
  if (islandCz - minMargin < regionTop) islandCz = regionTop + minMargin;
  else if (islandCz + minMargin > regionBottom) islandCz = regionBottom - minMargin;

  // 边界调整后再次确保远离冰封山峰（不行则退到四角候选）
  distFromMountain = Math.max(Math.abs(islandCx - frozenMountainCx), Math.abs(islandCz - frozenMountainCz));
  if (distFromMountain < minMountainDistance) {
    const candidates = [
      { x: regionLeft + minMargin, z: regionTop + minMargin },
      { x: regionLeft + minMargin, z: regionBottom - minMargin },
      { x: regionRight - minMargin, z: regionTop + minMargin },
      { x: regionRight - minMargin, z: regionBottom - minMargin },
    ];
    let bestCandidate = null;
    let bestDist = 0;
    for (const candidate of candidates) {
      const d = Math.max(Math.abs(candidate.x - frozenMountainCx), Math.abs(candidate.z - frozenMountainCz));
      if (d > bestDist) { bestDist = d; bestCandidate = candidate; }
    }
    if (bestCandidate && bestDist >= minMountainDistance) {
      islandCx = bestCandidate.x;
      islandCz = bestCandidate.z;
    }
  }

  // 再次检查金字塔距离
  distFromPyramid = Math.max(Math.abs(islandCx - pyramidCx), Math.abs(islandCz - pyramidCz));
  if (distFromPyramid < minPyramidDistance) {
    islandCx = islandCx > pyramidCx
      ? Math.min(regionRight - minMargin, pyramidCx + minPyramidDistance)
      : Math.max(regionLeft + minMargin, pyramidCx - minPyramidDistance);
    islandCz = islandCz > pyramidCz
      ? Math.min(regionBottom - minMargin, pyramidCz + minPyramidDistance)
      : Math.max(regionTop + minMargin, pyramidCz - minPyramidDistance);
  }

  return { islandCx, islandCz };
}

/** 海岛是否成立：中心地形高度低于海平面才生成（布局期一次性判定） */
export function isIslandValid(islandCx, islandCz, seed) {
  return generateHeight(islandCx, islandCz, seed) < SEA_Y;
}

/** 平地是否成立：中心 biome 为 DESERT（布局期一次性判定） */
export function isPlainLandValid(cx, cz, seed) {
  return getBiome(cx, cz, seed) === 'DESERT';
}

// ==================== 金字塔 ====================

/**
 * 金字塔点位信息（mc-lite Pyramid.getPyramidInfo，中心由布局给定）。
 * @param {{cx: number, cz: number}} pyramid 布局中的金字塔中心
 * @returns {Object|null}
 */
export function getPyramidInfo(wx, wz, pyramid) {
  const halfSize = Math.floor(PYRAMID_SIZE / 2);
  const transitionSize = TRANSITION_SIZE.PYRAMID;
  const totalHalfSize = halfSize + transitionSize;

  if (wx < pyramid.cx - totalHalfSize || wx > pyramid.cx + totalHalfSize ||
      wz < pyramid.cz - totalHalfSize || wz > pyramid.cz + totalHalfSize) {
    return null;
  }

  const dx = Math.abs(wx - pyramid.cx);
  const dz = Math.abs(wz - pyramid.cz);
  const distFromCenter = Math.max(dx, dz);

  let zone, transitionFactor;
  if (distFromCenter <= halfSize) {
    zone = 'core';
    transitionFactor = 0;
  } else {
    zone = 'transition';
    transitionFactor = (distFromCenter - halfSize) / transitionSize;
  }

  // 坡度：每 2 格水平距离降 1 格
  const pyramidLayerHeight = Math.floor((halfSize - distFromCenter) / 2);

  return {
    centerX: pyramid.cx,
    centerZ: pyramid.cz,
    layerHeight: Math.max(0, pyramidLayerHeight),
    isBaseLayer: pyramidLayerHeight === 0,
    transitionFactor,
    zone,
  };
}

/**
 * 生成金字塔方块（mc-lite generatePyramid 移植；Math.random → seededRandom 确定性化）。
 * @param {number} h 自然地形高度
 * @param {(wx:number, y:number, wz:number, name:string) => void} setBlock
 */
export function generatePyramid(wx, wz, h, pyInfo, setBlock, seed) {
  const originalPyramidHeight = h + pyInfo.layerHeight;

  let finalSurfaceY;
  if (pyInfo.transitionFactor === 0) {
    finalSurfaceY = originalPyramidHeight;
  } else {
    const smoothHeight = Math.floor(h + (originalPyramidHeight - h) * (1 - pyInfo.transitionFactor));
    const maxDiff = 2;
    const heightDiff = smoothHeight - h;
    finalSurfaceY = Math.abs(heightDiff) <= maxDiff ? smoothHeight : h + Math.sign(heightDiff) * maxDiff;
  }

  const fillStartY = Math.min(h, finalSurfaceY);
  const fillEndY = Math.max(h, finalSurfaceY);

  // 沙层数 3~4（原 Math.random() 2 选 1，改 seeded）
  const sandLayers = 3 + Math.floor(seededRandom(wx, wz, seed + 301) * 2);

  for (let y = fillStartY; y <= fillEndY; y++) {
    if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) continue;
    const depthFromSurface = fillEndY - y;
    if (depthFromSurface < sandLayers) {
      setBlock(wx, y, wz, 'sand');
    } else {
      // 30% 鹅卵石（原 Math.random()，改 seeded，y 参与混合）
      const rockType = seededRandom(wx, wz, seed + 302 + y) < 0.3 ? 'cobblestone' : 'stone';
      setBlock(wx, y, wz, rockType);
    }
  }

  // 岩石基础层（1~11 层 + 底部 end_stone，与 mc-lite 一致）
  const rockBaseY = Math.min(h, finalSurfaceY);
  for (let k = 1; k <= 11; k++) {
    const rockY = rockBaseY - k;
    if (rockY < WORLD_MIN_Y) break;
    if (k === 11) setBlock(wx, rockY, wz, 'end_stone');
    else if (k === 10) setBlock(wx, rockY, wz, 'stone');
    else {
      const rockType = seededRandom(wx, wz, seed + 303 + k) < 0.3 ? 'cobblestone' : 'stone';
      setBlock(wx, rockY, wz, rockType);
    }
  }
  if (rockBaseY - 12 >= WORLD_MIN_Y) setBlock(wx, rockBaseY - 12, wz, 'end_stone');
}

/** column 写块 helper 工厂：世界坐标 → column 局部写入（GEN 路径，不记 edits/不 bump version） */
export function makeColumnSetter(column, registry) {
  const idCache = new Map();
  const idOf = (name) => {
    let id = idCache.get(name);
    if (id === undefined) { id = registry.idOf(name); idCache.set(name, id); }
    return id;
  };
  return (wx, y, wz, name) => {
    const lx = wx - column.cx * 16;
    const lz = wz - column.cz * 16;
    if (lx < 0 || lx > 15 || lz < 0 || lz > 15) return;
    if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) return;
    column.blocks[blockIndex(lx, y, lz)] = idOf(name);
  };
}
