// src/gen/structures/landmarks.js — 地标位置/形状算法（移植 mc-lite workers/maps/*）
// M2-1：中心计算 + 金字塔；M2-2：雪原/冰封山/海岛/平地/城市地形（generateCity + detectNearbyLandmark）。
// Math.random → seededRandom 确定性化；terrainGen 依赖改为 generateHeight/getBiome 直调。
// Worker 同构：本文件不得 import three。
import { getRegionSeededCenter, clampCenterToRegion } from './region-center.js';
import {
  REGION_SIZE, REGION_MIN_MARGIN,
  PYRAMID_SIZE, FROZEN_MOUNTAIN_SIZE, PLAIN_LAND_SIZE, ISLAND_SIZE, SNOW_LAND_SIZE,
  TRANSITION_SIZE, LANDMARK_OFFSET, LANDMARK_MIN_DISTANCE,
  FROZEN_MOUNTAIN_STEEP_AXIS, FROZEN_MOUNTAIN_STEEP_FACTOR, FROZEN_MOUNTAIN_HEIGHT_FACTOR,
  ISLAND_SHAPE_NOISE_SCALE, ISLAND_EDGE_NOISE_SCALE,
  SNOW_LAND_CENTER_BOOST_RADIUS, CITY_TRANSITION_SIZE, CITY_TERRACE_WIDTH,
  ISLAND_SEA_LEVEL,
} from './region-config.js';
import { seededRandom, getBiome } from '../noise.js';
import { generateHeight, generateHeightForBiome } from '../terrain.js';
import { getCityInfo, getCitySurfaceY } from './city-layout.js';
import { SEA_Y, WORLD_MIN_Y, WORLD_MAX_Y, blockIndex } from '../../voxel/constants.js';

export { getCityInfo };

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
    if (idCache.has(name)) return idCache.get(name);
    const id = registry.idOf(name);
    idCache.set(name, id);
    return id;
  };
  return (wx, y, wz, name, meta = 0) => {
    const lx = wx - column.cx * 16;
    const lz = wz - column.cz * 16;
    if (lx < 0 || lx > 15 || lz < 0 || lz > 15) return;
    if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) return;
    const id = idOf(name);
    if (id === undefined) return; // 未注册方块名：跳过（防御 JSON 数据异常）
    const idx = blockIndex(lx, y, lz);
    column.blocks[idx] = id;
    column.meta[idx] = meta;
  };
}

// ==================== 雪原 ====================

/**
 * 雪原点位信息（mc-lite SnowLand.getSnowLandInfo，中心由布局给定）。
 *
 * ⚠️ **`snowLand` 为 null 时返回 null（`null` 是合法输入，不是错误）**：
 * 高台地带（`src/gen/structures/tarn-zone.js`）会压制地带 region 的雪原生成，
 * 但**不把 `layout.snowLand` 置 null**（它有 6 处既有消费方）；让路落在调用方
 * （`apply.js` 阶段 1 跳过 `generateSnowLand`）。这里的守卫是纵深防御：
 * 万一将来有人真的传 null 进来，应当是「没有雪原」而不是抛 TypeError 整页崩。
 * 同文件里的 `getPlainLandInfo` / `getFrozenMountainInfo` 的调用方都自带 `&&` 守卫，
 * 本函数在权威处自守，省得每个调用点各写一遍（红线 1）。
 * @param {{cx: number, cz: number}|null} snowLand
 */
export function getSnowLandInfo(wx, wz, snowLand, seed) {
  if (!snowLand) return null;
  const halfSize = Math.floor(SNOW_LAND_SIZE / 2);
  const transitionSize = TRANSITION_SIZE.SNOW_LAND;
  const totalHalfSize = halfSize + transitionSize;

  if (wx < snowLand.cx - totalHalfSize || wx > snowLand.cx + totalHalfSize ||
      wz < snowLand.cz - totalHalfSize || wz > snowLand.cz + totalHalfSize) {
    return null;
  }

  const dx = Math.abs(wx - snowLand.cx);
  const dz = Math.abs(wz - snowLand.cz);
  const distFromCenterMax = Math.max(dx, dz);
  const distFromCenterEuclid = Math.sqrt((wx - snowLand.cx) ** 2 + (wz - snowLand.cz) ** 2);

  let zone, transitionFactor;
  if (distFromCenterMax <= halfSize) {
    zone = 'core';
    transitionFactor = 0;
  } else {
    zone = 'transition';
    transitionFactor = (distFromCenterMax - halfSize) / transitionSize;
  }

  // 平缓高度噪声（高低差 ≤2）+ 中心抬升
  const noise1 = Math.sin(wx * 0.08 + seed * 0.5) * Math.cos(wz * 0.08 + seed * 0.3);
  const noise2 = Math.sin(wx * 0.15 + seed * 1.2) * Math.cos(wz * 0.15 + seed * 0.7) * 0.5;
  const centerBoost = Math.max(0, 2 - distFromCenterEuclid / SNOW_LAND_CENTER_BOOST_RADIUS);
  const heightOffset = Math.floor((noise1 + noise2) * 1.5 + centerBoost);

  return {
    centerX: snowLand.cx,
    centerZ: snowLand.cz,
    heightOffset,
    transitionFactor,
    zone,
  };
}

/** 生成雪原方块（mc-lite generateSnowLand；dirt 层数与 short_grass 确定性化） */
export function generateSnowLand(wx, wz, h, slInfo, setBlock, seed) {
  const seaLevel = SEA_Y;

  let finalSurfaceY;
  if (slInfo.transitionFactor === 0) {
    finalSurfaceY = h + slInfo.heightOffset;
  } else {
    const baseHeight = h + slInfo.heightOffset;
    finalSurfaceY = Math.floor(h + (baseHeight - h) * (1 - slInfo.transitionFactor));
  }
  const heightDiff = finalSurfaceY - h;
  if (Math.abs(heightDiff) > 2) finalSurfaceY = h + Math.sign(heightDiff) * 2;

  const fillStartY = Math.min(h, finalSurfaceY);
  const fillEndY = Math.max(h, finalSurfaceY);
  const isBelowSeaLevel = finalSurfaceY <= seaLevel - 1;
  const dirtLayers = 3 + Math.floor(seededRandom(wx, wz, seed + 311) * 3);

  for (let y = fillStartY; y <= fillEndY; y++) {
    if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) continue;
    if (isBelowSeaLevel) setBlock(wx, y, wz, 'sand');
    else if (y === fillEndY) setBlock(wx, y, wz, 'snow_grass');
    else if (fillEndY - y < dirtLayers) setBlock(wx, y, wz, 'dirt');
    else setBlock(wx, y, wz, 'stone');
  }

  const rockBaseY = Math.min(h, finalSurfaceY);
  for (let k = 1; k <= 11; k++) {
    const rockY = rockBaseY - k;
    if (rockY < WORLD_MIN_Y) break;
    setBlock(wx, rockY, wz, k === 11 ? 'end_stone' : 'stone');
  }
  if (rockBaseY - 12 >= WORLD_MIN_Y) setBlock(wx, rockBaseY - 12, wz, 'end_stone');

  // 主体区 3% short_grass（原 Math.random，改 seeded）
  if (slInfo.transitionFactor === 0 && !isBelowSeaLevel && seededRandom(wx, wz, seed + 312) < 0.03) {
    if (fillEndY + 1 < WORLD_MAX_Y) setBlock(wx, fillEndY + 1, wz, 'short_grass');
  }
  return { surfaceY: fillEndY, isBelowSeaLevel };
}

// ==================== 冰封山峰 ====================

/** 山体噪声（mc-lite mountainNoise） */
function mountainNoise(x, z, seed, scale) {
  const nx = x + seed * 0.1;
  const nz = z + seed * 0.2;
  return Math.sin(nx * scale) * Math.cos(nz * scale * 0.8) +
         Math.sin(nx * scale * 2.3 + 1.3) * Math.cos(nz * scale * 1.7 + 0.5) * 0.5;
}

/**
 * 冰封山峰点位信息（mc-lite getFrozenMountainInfo 全量移植，中心由布局给定）。
 * @param {{cx: number, cz: number}} fm
 */
export function getFrozenMountainInfo(wx, wz, fm, seed) {
  const halfSize = Math.floor(FROZEN_MOUNTAIN_SIZE / 2);
  const transitionSize = TRANSITION_SIZE.FROZEN_MOUNTAIN;
  const steepAxisFactor = FROZEN_MOUNTAIN_STEEP_FACTOR;
  const steepAxis = FROZEN_MOUNTAIN_STEEP_AXIS;

  const totalHalfSize = halfSize + transitionSize;
  if (wx < fm.cx - totalHalfSize || wx > fm.cx + totalHalfSize ||
      wz < fm.cz - totalHalfSize || wz > fm.cz + totalHalfSize) {
    return null;
  }

  const dx = wx - fm.cx;
  const dz = wz - fm.cz;
  const angle = Math.atan2(dz, dx);

  // 山形轮廓噪声
  const shapeNoise1 = mountainNoise(wx, wz, seed + 1000, 0.008);
  const shapeNoise2 = mountainNoise(wx, wz, seed + 2000, 0.015) * 0.5;
  const shapeNoise3 = mountainNoise(wx, wz, seed + 3000, 0.025) * 0.25;
  const shapeNoise = (shapeNoise1 + shapeNoise2 + shapeNoise3) * 0.5 + 0.5;

  const angleVariation = Math.sin(angle * 3 + seed * 0.1) * 4 +
                         Math.sin(angle * 5 + seed * 0.2) * 2 +
                         Math.sin(angle * 7 + seed * 0.3) * 1;
  const effectiveRadius = halfSize + angleVariation + (shapeNoise - 0.5) * 8;

  const adjustedDx = steepAxis === 'x' ? dx / steepAxisFactor : dx;
  const adjustedDz = steepAxis === 'z' ? dz / steepAxisFactor : dz;
  const euclidDist = Math.sqrt(adjustedDx * adjustedDx + adjustedDz * adjustedDz);
  const normalizedDist = euclidDist / Math.max(1, effectiveRadius);

  let zone, transitionFactor;
  if (normalizedDist <= 1.0) {
    zone = 'core';
    transitionFactor = 0;
  } else {
    zone = 'transition';
    const t = (normalizedDist - 1.0) / (transitionSize / halfSize);
    transitionFactor = Math.max(0, Math.min(1, t));
  }

  const flatRadiusNoise = mountainNoise(wx, wz, seed + 4000, 0.02) * 3;
  const flatRadius = Math.max(5, 10 + flatRadiusNoise);

  let baseHeightFloat;
  const summitHeight = (halfSize - 10) / FROZEN_MOUNTAIN_HEIGHT_FACTOR;

  if (normalizedDist < flatRadius / halfSize) {
    const summitNoise = mountainNoise(wx, wz, seed + 5000, 0.03) * 0.8;
    baseHeightFloat = summitHeight + summitNoise;
  } else {
    const slopeT = Math.max(0, Math.min(1,
      (normalizedDist - flatRadius / halfSize) / (1 - flatRadius / halfSize)));
    const slopeNoise1 = mountainNoise(wx, wz, seed + 6000, 0.006);
    const slopeNoise2 = mountainNoise(wx, wz, seed + 7000, 0.012) * 0.5;
    const slopeNoise = (slopeNoise1 + slopeNoise2) * 0.5 + 0.5;
    const profileExponent = 1.1 + slopeNoise * 0.7;
    const profile = 1 - Math.pow(slopeT, profileExponent);

    const bumpNoise1 = mountainNoise(wx, wz, seed + 8000, 0.025);
    const bumpNoise2 = mountainNoise(wx, wz, seed + 9000, 0.045) * 0.5;
    const bumpNoise3 = mountainNoise(wx, wz, seed + 10000, 0.08) * 0.25;
    const bumpNoise = bumpNoise1 + bumpNoise2 + bumpNoise3;
    const bumpMask = Math.sin(Math.PI * slopeT);
    const bumpOffset = bumpNoise * 2.5 * bumpMask;

    const ridgeAngle1 = angle * 3 + mountainNoise(wx, wz, seed + 11000, 0.01) * 0.5;
    const ridgeNoise1 = Math.sin(ridgeAngle1) * (1 - slopeT);
    const ridgeOffset = ridgeNoise1 * 1.5 * (1 - slopeT);

    baseHeightFloat = summitHeight * profile + bumpOffset + ridgeOffset;

    const ruggedNoise =
      mountainNoise(wx, wz, seed + 12000, 0.06) * 0.6 +
      mountainNoise(wx, wz, seed + 13000, 0.1) * 0.3 +
      mountainNoise(wx, wz, seed + 14000, 0.15) * 0.1;
    baseHeightFloat += ruggedNoise * bumpMask * 0.7;
  }

  const broadUndulation =
    mountainNoise(wx, wz, seed + 15000, 0.005) * 1.5 +
    mountainNoise(wx, wz, seed + 16000, 0.01) * 0.8;
  const undulationMask = Math.min(1, normalizedDist * 1.2);
  baseHeightFloat += broadUndulation * undulationMask;

  baseHeightFloat = Math.max(0, baseHeightFloat);

  // 确定性抖动取整
  const baseFloor = Math.floor(baseHeightFloat);
  const frac = Math.max(0, Math.min(1, baseHeightFloat - baseFloor));
  const dither = mountainNoise(wx, wz, seed + 777, 0.09) * 0.5 + 0.5;
  const baseHeight = baseFloor + (dither < frac ? 1 : 0);

  // 低频平滑扰动（十字采样）
  const sampleOffsets = [[0, 0], [1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5]];
  let smoothNoise = 0;
  for (const [ox, oz] of sampleOffsets) {
    const n1 = mountainNoise(wx + ox, wz + oz, seed + 37, 0.014);
    const n2 = mountainNoise(wx + ox, wz + oz, seed + 91, 0.022) * 0.35;
    smoothNoise += (n1 + n2);
  }
  smoothNoise /= sampleOffsets.length;

  const slopeT = Math.max(0, Math.min(1, (normalizedDist - flatRadius / halfSize) /
    Math.max(0.01, 1 - flatRadius / halfSize)));
  const slopeMask = Math.sin(Math.PI * slopeT);
  const noiseOffsetRaw = Math.round(smoothNoise * slopeMask * 1.1);
  const noiseOffset = Math.max(-1, Math.min(1, noiseOffsetRaw));

  const mountainLayerHeight = Math.max(0, baseHeight + noiseOffset);

  return {
    centerX: fm.cx,
    centerZ: fm.cz,
    layerHeight: mountainLayerHeight,
    isBaseLayer: mountainLayerHeight === 0,
    transitionFactor,
    zone,
  };
}

/** 生成冰封山峰方块（mc-lite generateFrozenMountain；dirt 层数/short_grass 确定性化） */
export function generateFrozenMountain(wx, wz, h, fmInfo, setBlock, seed) {
  const seaLevel = SEA_Y;
  const originalMountainHeight = h + fmInfo.layerHeight;

  let finalSurfaceY;
  if (fmInfo.transitionFactor === 0) {
    finalSurfaceY = originalMountainHeight;
  } else {
    const smoothHeight = Math.floor(h + (originalMountainHeight - h) * (1 - fmInfo.transitionFactor));
    const maxDiff = 2;
    const heightDiff = smoothHeight - h;
    finalSurfaceY = Math.abs(heightDiff) <= maxDiff ? smoothHeight : h + Math.sign(heightDiff) * maxDiff;
  }

  const fillStartY = Math.min(h, finalSurfaceY);
  const fillEndY = Math.max(h, finalSurfaceY);
  const isBelowSeaLevel = finalSurfaceY <= seaLevel - 1;
  const dirtLayers = 1 + Math.floor(seededRandom(wx, wz, seed + 313) * 2);

  for (let y = fillStartY; y <= fillEndY; y++) {
    if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) continue;
    if (isBelowSeaLevel) setBlock(wx, y, wz, 'sand');
    else if (y === fillEndY) setBlock(wx, y, wz, 'snow_grass');
    else if (fillEndY - y < dirtLayers) setBlock(wx, y, wz, 'dirt');
    else setBlock(wx, y, wz, 'stone');
  }

  const rockBaseY = Math.min(h, finalSurfaceY);
  for (let k = 1; k <= 11; k++) {
    const rockY = rockBaseY - k;
    if (rockY < WORLD_MIN_Y) break;
    setBlock(wx, rockY, wz, k === 11 ? 'end_stone' : 'stone');
  }
  if (rockBaseY - 12 >= WORLD_MIN_Y) setBlock(wx, rockBaseY - 12, wz, 'end_stone');

  if (fmInfo.transitionFactor === 0 && !isBelowSeaLevel && seededRandom(wx, wz, seed + 314) < 0.03) {
    if (fillEndY + 1 < WORLD_MAX_Y) setBlock(wx, fillEndY + 1, wz, 'short_grass');
  }
  return { surfaceY: fillEndY, isBelowSeaLevel };
}

// ==================== 海岛 ====================

/**
 * 海岛点位信息（mc-lite getIslandInfo；海洋有效性已在布局期判定）。
 * @param {{cx: number, cz: number}} island
 */
export function getIslandInfo(wx, wz, island, seed) {
  void seed;
  const halfSize = Math.floor(ISLAND_SIZE / 2);
  const totalHalfSize = halfSize + TRANSITION_SIZE.ISLAND;

  const dx = Math.abs(wx - island.cx);
  const dz = Math.abs(wz - island.cz);
  if (dx > totalHalfSize || dz > totalHalfSize) return null;

  const distFromCenter = Math.max(dx, dz);
  const zone = distFromCenter <= halfSize ? 'core' : 'transition';
  const transitionFactor = zone === 'core' ? 0 : (distFromCenter - halfSize) / TRANSITION_SIZE.ISLAND;

  return { centerX: island.cx, centerZ: island.cz, zone, transitionFactor, distFromCenter };
}

/** 海岛形状噪声（mc-lite getIslandShapeNoise） */
function getIslandShapeNoise(wx, wz, seed) {
  const baseNoise = Math.sin(wx * ISLAND_SHAPE_NOISE_SCALE + seed) * Math.cos(wz * ISLAND_SHAPE_NOISE_SCALE + seed);
  const midNoise = Math.sin(wx * ISLAND_SHAPE_NOISE_SCALE * 2 + seed * 1.5) * Math.cos(wz * ISLAND_SHAPE_NOISE_SCALE * 2 + seed * 1.5) * 0.5;
  const detailNoise = Math.sin(wx * ISLAND_EDGE_NOISE_SCALE + seed * 2) * Math.cos(wz * ISLAND_EDGE_NOISE_SCALE + seed * 2) * 0.5;
  const fineNoise = Math.sin(wx * ISLAND_EDGE_NOISE_SCALE * 2 + seed * 3) * Math.cos(wz * ISLAND_EDGE_NOISE_SCALE * 2 + seed * 3) * 0.25;
  return baseNoise * ISLAND_SHAPE_NOISE_SCALE + midNoise * ISLAND_SHAPE_NOISE_SCALE * 0.5 +
    detailNoise * ISLAND_EDGE_NOISE_SCALE + fineNoise * ISLAND_EDGE_NOISE_SCALE * 0.5;
}

/** 是否在海岛范围内（形状噪声扰动海岸线，mc-lite isInIsland） */
function isInIsland(wx, wz, islandInfo, seed) {
  const shapeNoise = getIslandShapeNoise(wx, wz, seed);
  const effectiveDist = islandInfo.distFromCenter - shapeNoise * 8;
  const halfSize = Math.floor(ISLAND_SIZE / 2);
  return effectiveDist <= halfSize + TRANSITION_SIZE.ISLAND;
}

/** 生成海岛方块（mc-lite generateIsland：表面齐海平面，边缘 sand 内部 stone） */
export function generateIsland(wx, wz, islandInfo, setBlock, seed) {
  if (!isInIsland(wx, wz, islandInfo, seed)) return null;

  const surfaceY = ISLAND_SEA_LEVEL;
  const halfSize = Math.floor(ISLAND_SIZE / 2);
  const distFromCenter = islandInfo.distFromCenter;

  const shapeNoise = getIslandShapeNoise(wx, wz, seed);
  const beachThreshold = (halfSize - 3) + shapeNoise * 3;
  const surfaceBlock = distFromCenter > beachThreshold ? 'sand' : 'stone';

  if (surfaceY >= WORLD_MIN_Y && surfaceY < WORLD_MAX_Y) setBlock(wx, surfaceY, wz, surfaceBlock);

  // 地表下 2 层 dirt，再往下 stone 到 surfaceY-11
  const bedrockY = surfaceY - 11;
  for (let y = surfaceY - 1; y >= bedrockY; y--) {
    if (y < WORLD_MIN_Y) break;
    setBlock(wx, y, wz, y >= surfaceY - 2 ? 'dirt' : 'stone');
  }
  return { surfaceY, isBelowSeaLevel: surfaceY <= ISLAND_SEA_LEVEL - 1 };
}

/** 海岛过渡圈沙洲柱（mc-lite 列循环 island 分支的 sand 填充段） */
export function generateIslandSandRing(wx, wz, islandInfo, setBlock) {
  const seaY = ISLAND_SEA_LEVEL;
  const bedrockY = seaY - 11;
  for (let y = seaY - 1; y >= bedrockY; y--) {
    if (y < WORLD_MIN_Y) break;
    setBlock(wx, y, wz, 'sand');
  }
}

// ==================== 平地 ====================

/** 平地点位信息（mc-lite getPlainLandInfo；biome/baseHeight 已在布局期判定） */
export function getPlainLandInfo(wx, wz, plainLand) {
  const halfSize = Math.floor(PLAIN_LAND_SIZE / 2);
  const dx = Math.abs(wx - plainLand.cx);
  const dz = Math.abs(wz - plainLand.cz);
  if (dx > halfSize || dz > halfSize) return null;
  return { centerX: plainLand.cx, centerZ: plainLand.cz, baseHeight: plainLand.baseHeight, halfSize };
}

/** 生成平地方块（mc-lite generatePlainLand：全 sand 填平到 baseHeight） */
export function generatePlainLand(wx, wz, h, plainInfo, setBlock) {
  const surfaceY = plainInfo.baseHeight;
  const fillStartY = Math.min(h, surfaceY);
  const fillEndY = Math.max(h, surfaceY);
  for (let y = fillStartY; y <= fillEndY; y++) {
    if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) continue;
    setBlock(wx, y, wz, 'sand');
  }
  const rockBaseY = Math.min(h, surfaceY);
  for (let k = 1; k <= 11; k++) {
    const rockY = rockBaseY - k;
    if (rockY < WORLD_MIN_Y) break;
    setBlock(wx, rockY, wz, k === 11 ? 'end_stone' : 'stone');
  }
  if (rockBaseY - 12 >= WORLD_MIN_Y) setBlock(wx, rockBaseY - 12, wz, 'end_stone');
  return { surfaceY };
}

// ==================== 城市地形 ====================

const CITY_MIN_SURFACE_Y = ISLAND_SEA_LEVEL + 1;

/**
 * 城市过渡带混合用的近旁地标探测（mc-lite detectNearbyLandmark 逐行移植——
 * 注意 mc-lite 此处用 region 几何中心估算金字塔/冰封山位置，与布局中心不同，保留原语义）。
 */
export function detectNearbyLandmark(wx, wz, seed) {
  const regionX = Math.floor(wx / REGION_SIZE);
  const regionZ = Math.floor(wz / REGION_SIZE);

  const pyramidOffsetX = LANDMARK_OFFSET.FROZEN_MOUNTAIN_X + 160;
  const pyramidOffsetZ = LANDMARK_OFFSET.FROZEN_MOUNTAIN_Z;
  const regionCenterX = regionX * REGION_SIZE + REGION_SIZE / 2;
  const regionCenterZ = regionZ * REGION_SIZE + REGION_SIZE / 2;
  const pyramidCx = regionCenterX + pyramidOffsetX;
  const pyramidCz = regionCenterZ + pyramidOffsetZ;
  const fmCx = regionCenterX + LANDMARK_OFFSET.FROZEN_MOUNTAIN_X;
  const fmCz = regionCenterZ + LANDMARK_OFFSET.FROZEN_MOUNTAIN_Z;

  const distToPyramid = Math.sqrt((wx - pyramidCx) ** 2 + (wz - pyramidCz) ** 2);
  const distToFM = Math.sqrt((wx - fmCx) ** 2 + (wz - fmCz) ** 2);

  const PYRAMID_HALF_SIZE = PYRAMID_SIZE / 2;
  const PYRAMID_TRANSITION_SIZE = TRANSITION_SIZE.PYRAMID;
  const PYRAMID_TOTAL_HALF = PYRAMID_HALF_SIZE + PYRAMID_TRANSITION_SIZE;
  const FM_HALF_SIZE = FROZEN_MOUNTAIN_SIZE / 2;
  const FM_TRANSITION_SIZE = TRANSITION_SIZE.FROZEN_MOUNTAIN;
  const FM_TOTAL_HALF = FM_HALF_SIZE + FM_TRANSITION_SIZE;

  const inPyramidRange = distToPyramid <= PYRAMID_TOTAL_HALF + 32;
  const inFMRange = distToFM <= FM_TOTAL_HALF + 32;
  if (!inPyramidRange && !inFMRange) return null;

  if (inPyramidRange) {
    const pyramidDist = Math.max(Math.abs(wx - pyramidCx), Math.abs(wz - pyramidCz));
    if (pyramidDist <= PYRAMID_TOTAL_HALF) {
      const layerHeight = Math.floor((PYRAMID_HALF_SIZE - pyramidDist) / 2);
      if (layerHeight > 0) {
        const pyramidBaseHeight = generateHeight(pyramidCx, pyramidCz, seed);
        return {
          type: 'pyramid',
          height: pyramidBaseHeight + layerHeight,
          distance: Math.max(0, pyramidDist - PYRAMID_HALF_SIZE),
          maxDistance: PYRAMID_TRANSITION_SIZE + 32,
        };
      }
    }
  }

  if (inFMRange) {
    const fmDx = wx - fmCx;
    const fmDz = wz - fmCz;
    const fmDist = Math.sqrt(fmDx * fmDx + fmDz * fmDz);
    if (fmDist <= FM_TOTAL_HALF) {
      const fmBaseHeight = generateHeight(fmCx, fmCz, seed);
      if (fmDist <= FM_HALF_SIZE) {
        const summitHeight = (FM_HALF_SIZE - 10) / FROZEN_MOUNTAIN_HEIGHT_FACTOR;
        const slopeT = fmDist / FM_HALF_SIZE;
        const profile = 1 - Math.pow(slopeT, 1.4);
        const layerHeight = Math.max(0, Math.floor(summitHeight * profile));
        return {
          type: 'frozenMountain',
          height: fmBaseHeight + layerHeight,
          distance: Math.max(0, fmDist - FM_HALF_SIZE * 0.7),
          maxDistance: FM_TRANSITION_SIZE + FM_HALF_SIZE * 0.3 + 32,
        };
      }
      return {
        type: 'frozenMountain',
        height: fmBaseHeight,
        distance: fmDist - FM_HALF_SIZE,
        maxDistance: FM_TRANSITION_SIZE + 32,
      };
    }
  }
  return null;
}

/** 城市最终地表高：核心高度或与自然地形混合后的过渡带高度。 */
export function getCityFinalSurfaceY(wx, wz, cityInfo, seed) {
  const citySurfaceY = getCitySurfaceY(wx, wz, cityInfo, seed);
  let surfaceY = citySurfaceY;

  const nearbyLandmark = detectNearbyLandmark(wx, wz, seed);

  if (cityInfo.isTransition) {
    const naturalBiome = getBiome(wx, wz, seed);
    const naturalH = generateHeightForBiome(wx, wz, seed, naturalBiome);

    let targetHeight = citySurfaceY;
    let blendFactor = 0;
    if (nearbyLandmark) {
      const distFactor = Math.max(0, Math.min(1, nearbyLandmark.distance / nearbyLandmark.maxDistance));
      targetHeight = nearbyLandmark.height;
      blendFactor = (1 - distFactor) * cityInfo.transitionFactor;
    }

    const delta = targetHeight - naturalH;
    const terraceNoise = Math.sin((wx + seed * 0.23) * 0.08) + Math.cos((wz - seed * 0.29) * 0.075);
    const terraceBias = terraceNoise > 0.75 ? 1 : (terraceNoise < -0.75 ? -1 : 0);
    const effectiveEdgeDistance = cityInfo.edgeDistance <= 0
      ? 0
      : Math.max(0, cityInfo.edgeDistance + terraceBias);
    const maxDelta = Math.max(0, Math.floor(effectiveEdgeDistance / CITY_TERRACE_WIDTH));

    let clampedDelta;
    if (nearbyLandmark && blendFactor > 0) {
      const rawDelta = targetHeight - naturalH;
      clampedDelta = Math.max(-2, Math.min(2, rawDelta));
      const naturalDelta = Math.max(-maxDelta, Math.min(maxDelta, citySurfaceY - naturalH));
      clampedDelta = naturalDelta * (1 - blendFactor) + clampedDelta * blendFactor;
    } else {
      clampedDelta = Math.max(-maxDelta, Math.min(maxDelta, delta));
    }

    surfaceY = naturalH + Math.round(clampedDelta);
    surfaceY = Math.max(surfaceY, Math.min(citySurfaceY, naturalH));

    if (nearbyLandmark) {
      const heightDiff = surfaceY - nearbyLandmark.height;
      if (Math.abs(heightDiff) > 3) surfaceY = nearbyLandmark.height + Math.sign(heightDiff) * 3;
    }
  }

  surfaceY = Math.max(CITY_MIN_SURFACE_Y, surfaceY);

  return surfaceY;
}

/**
 * 生成城市地形（mc-lite CityMap.generate 移植：核心 getCitySurfaceY +
 * 过渡带台阶式混合 + sand/clay/moss 地表分区）。
 * @param {number} h CITY 压平后的地形高度
 * @param {Object} cityInfo getCityInfo 结果（含布局字段）
 * @returns {{surfaceY: number}}
 */
export function generateCity(wx, wz, h, cityInfo, setBlock, seed) {
  const surfaceY = getCityFinalSurfaceY(wx, wz, cityInfo, seed);
  const naturalH = generateHeight(wx, wz, seed);

  const fillStartY = Math.min(h, surfaceY);
  const fillEndY = surfaceY;

  // sand/clay/moss 成片地表（moss 约为 clay 的 1/10）
  const patch = Math.sin((wx + seed * 0.31) * 0.09) + Math.cos((wz - seed * 0.27) * 0.08);
  const patch2 = Math.sin((wx + wz + seed * 0.73) * 0.037);
  let surfaceType;
  if (patch + patch2 > 0) {
    surfaceType = 'sand';
  } else {
    const mossNoise = Math.sin((wx * 0.15 + seed * 0.17) * 0.5) + Math.cos((wz * 0.13 - seed * 0.19) * 0.5);
    surfaceType = mossNoise > 1.2 ? 'moss' : 'clay';
  }
  const subType = surfaceType === 'sand' ? 'sand' : 'clay';

  for (let y = fillStartY; y <= fillEndY; y++) {
    if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) continue;
    setBlock(wx, y, wz, y === fillEndY ? surfaceType : subType);
  }

  const rockBaseY = surfaceY;
  for (let k = 1; k <= 11; k++) {
    const rockY = rockBaseY - k;
    if (rockY < WORLD_MIN_Y) break;
    setBlock(wx, rockY, wz, k === 11 ? 'end_stone' : subType);
  }
  if (rockBaseY - 12 >= WORLD_MIN_Y) setBlock(wx, rockBaseY - 12, wz, 'end_stone');

  // 补掉城市内的水体残留（mc-lite 分支链语义：`if (inCity)` 与 `else if (h < wLvl)` 填水
  // **互斥** → 城内永不填水体方块）。mc-heavy 是两阶段：`fillColumn` 无条件填整列（含水体
  // `(naturalH, SEA_Y]`）+ 城市覆写，覆写不到的水体会残留。
  //
  // 覆写范围 = 地表填充 `[fillStartY, surfaceY]` + 岩石层 `[surfaceY-12, surfaceY-1]`；
  // 当 `surfaceY-12 > naturalH` 时（城市地表被压高、自然地形是海床），`fillColumn` 填的水
  // 落在覆写范围之外 → 残留。实测后果：城市地表下挖 2 格露出悬空水格（顶面 -1.5 恰与
  // 水面平面同高，肉眼就是「陆地上挖出一汪水」）。
  //
  // 用城市岩石材料**补实**而不是清成 air —— 清成 air 会在城市地下造出空洞，
  // 玩家挖下去会掉进洞里（比看到水更糟）。
  //
  // 覆写范围（合并后）= `[coverBottomY, surfaceY]`；水体范围 = `[naturalH+1, SEA_Y]`。
  // 未覆写的水体在 coverBottomY **之下**：`[naturalH+1, min(coverBottomY-1, SEA_Y)]`。
  const coverBottomY = Math.min(fillStartY, Math.max(rockBaseY - 12, WORLD_MIN_Y));
  if (naturalH < SEA_Y) {
    const gapTopY = Math.min(coverBottomY - 1, SEA_Y);
    for (let y = naturalH + 1; y <= gapTopY && y < WORLD_MAX_Y; y++) {
      setBlock(wx, y, wz, subType);
    }
  }

  // 清除城市地表上方的自然地形残留（M2 收尾：残丘修复）。
  // fillColumn 按自然 biome 预填整列到 naturalH；城市覆写仅写至城市地表 surfaceY。
  // 当 naturalH > surfaceY 时，surfaceY+1..naturalH 的预填草/土/石残留为接地的自然地形丘，
  // 凸出于城市地表并包裹按城市地表放置的建筑。mc-lite 稀疏存储不预填城内自然地形故无此问题。
  // 注意：传入的 h 是 CITY 压平高度（很低），不能用作清除上界；须另取自然高度 generateHeight。
  // 本函数运行于地形整形阶段（结构/植被注入之前），此处清除不会误伤建筑或树木。
  for (let y = surfaceY + 1; y <= naturalH && y < WORLD_MAX_Y; y++) {
    setBlock(wx, y, wz, 'air');
  }

  return { surfaceY };
}

export { CITY_TRANSITION_SIZE };

// ==================== 植被用 surface 计算（与 generate* 同公式，纯函数） ====================

/** 雪原最终表面高（mc-lite generateSnowLand 高差钳制段） */
export function snowLandSurfaceY(h, slInfo) {
  let finalSurfaceY;
  if (slInfo.transitionFactor === 0) finalSurfaceY = h + slInfo.heightOffset;
  else {
    const baseHeight = h + slInfo.heightOffset;
    finalSurfaceY = Math.floor(h + (baseHeight - h) * (1 - slInfo.transitionFactor));
  }
  const heightDiff = finalSurfaceY - h;
  if (Math.abs(heightDiff) > 2) finalSurfaceY = h + Math.sign(heightDiff) * 2;
  return finalSurfaceY;
}

/** 冰封山最终表面高（mc-lite generateFrozenMountain 高差钳制段） */
export function frozenMountainSurfaceY(h, fmInfo) {
  const originalMountainHeight = h + fmInfo.layerHeight;
  let finalSurfaceY;
  if (fmInfo.transitionFactor === 0) finalSurfaceY = originalMountainHeight;
  else {
    const smoothHeight = Math.floor(h + (originalMountainHeight - h) * (1 - fmInfo.transitionFactor));
    const heightDiff = smoothHeight - h;
    finalSurfaceY = Math.abs(heightDiff) <= 2 ? smoothHeight : h + Math.sign(heightDiff) * 2;
  }
  return finalSurfaceY;
}

/** 海岛内表面（形状噪声判定，mc-lite isInIsland）：岛内 = 海平面，岛外 null */
export function islandSurfaceY(wx, wz, islandInfo, seed) {
  return isInIsland(wx, wz, islandInfo, seed) ? ISLAND_SEA_LEVEL : null;
}
