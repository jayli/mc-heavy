// src/gen/structures/city-layout.js — City 主城确定性布局（移植 mc-lite CityPlacementUtils + CityMap 布局段）
// 只产出布局数据（中心/边界/建筑 placement），不写方块；建筑光栅化在 M2-2。
// mc-lite 的 Math.random()（gate fallback）替换为 hash01 确定性版本。
// Worker 同构：本文件不得 import three。
import { getRegionSeededCenter, clampCenterToRegion } from './region-center.js';
import {
  REGION_MIN_MARGIN, LANDMARK_OFFSET, ISLAND_SEA_LEVEL,
  CITY_SIZE_MIN, CITY_SIZE_MAX, CITY_TRANSITION_SIZE, CITY_CORE_BUILD_MARGIN,
  CITY_GROUND_VARIANCE_MAX, CITY_REGION, CITY_STRUCTURE_FOOTPRINT, CITY_STRUCTURE_CONFIGS,
  CITY_PLACEMENT,
} from './region-config.js';
import { generateHeight } from '../terrain.js';

const CITY_MIN_SURFACE_Y = ISLAND_SEA_LEVEL + 1;

// ==================== CityPlacementUtils 移植 ====================

/** 确定性随机哈希（mc-lite hash01） */
export function hash01(v) {
  const s = Math.sin(v) * CITY_PLACEMENT.HASH_MULTIPLIER;
  return s - Math.floor(s);
}

export function getStructureBounds(x, z, type) {
  const fp = CITY_STRUCTURE_FOOTPRINT[type];
  if (!fp) return null;
  return { minX: x - fp.halfX, maxX: x + fp.halfX, minZ: z - fp.halfZ, maxZ: z + fp.halfZ };
}

function expandBounds(bounds, padding) {
  return { minX: bounds.minX - padding, maxX: bounds.maxX + padding, minZ: bounds.minZ - padding, maxZ: bounds.maxZ + padding };
}

function isPointInBounds(x, z, bounds) {
  return x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ;
}

export function getGapRequirement(typeA, typeB, seed, indexA, indexB) {
  const mixFactor = hash01(seed * 0.77 + indexA * 7.1 + indexB * 11.3);
  let gap = 10 + Math.floor(mixFactor * 4);
  const minGapA = CITY_STRUCTURE_FOOTPRINT[typeA]?.minGap || 10;
  const minGapB = CITY_STRUCTURE_FOOTPRINT[typeB]?.minGap || 10;
  gap = Math.max(gap, minGapA, minGapB);
  if (typeA === 'whiteTower' || typeB === 'whiteTower') gap = Math.max(gap, 12);
  return gap;
}

export function isNearPlacement(placements, x, z, padding = 0) {
  for (const p of placements) {
    const bounds = getStructureBounds(p.x, p.z, p.type);
    if (!bounds) continue;
    if (isPointInBounds(x, z, expandBounds(bounds, padding))) return true;
  }
  return false;
}

/** 环形候选点（mc-lite buildCandidates） */
export function buildCandidates(centerX, centerZ, minR, maxR, seed, salt) {
  const angleStep = CITY_PLACEMENT.CANDIDATE_ANGLE_STEP;
  const ringStep = CITY_PLACEMENT.CANDIDATE_RING_STEP;
  const jitter = CITY_PLACEMENT.CANDIDATE_JITTER;
  const candidates = [];
  for (let r = minR; r <= maxR; r += ringStep) {
    for (let angle = 0; angle < 360; angle += angleStep) {
      const rad = (angle / 180) * Math.PI;
      const jitterX = Math.floor((hash01(seed * 1.13 + salt * 0.71 + r * 0.21 + angle * 0.39) - 0.5) * jitter);
      const jitterZ = Math.floor((hash01(seed * 1.37 + salt * 0.67 + r * 0.27 + angle * 0.33) - 0.5) * jitter);
      const localX = Math.round(Math.cos(rad) * r) + jitterX;
      const localZ = Math.round(Math.sin(rad) * r) + jitterZ;
      candidates.push({ x: centerX + localX, z: centerZ + localZ, localX, localZ });
    }
  }
  return candidates;
}

/** 方向均衡评分（mc-lite scoreDirectionalBalance） */
export function scoreDirectionalBalance(candidate, existing, targetSpacing = 20) {
  if (existing.length === 0) return 1e6;
  const sectorAngle = Math.PI / 4;
  const dirDistances = [];
  for (let i = 0; i < 8; i++) {
    const angleStart = i * sectorAngle - sectorAngle / 2;
    const angleEnd = i * sectorAngle + sectorAngle / 2;
    let minDistInSector = Infinity;
    for (const p of existing) {
      const dx = p.x - candidate.x;
      const dz = p.z - candidate.z;
      const angle = Math.atan2(dz, dx);
      let normalizedAngle = angle;
      while (normalizedAngle < angleStart) normalizedAngle += Math.PI * 2;
      while (normalizedAngle > angleStart + Math.PI * 2) normalizedAngle -= Math.PI * 2;
      if (normalizedAngle >= angleStart && normalizedAngle <= angleEnd) {
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < minDistInSector) minDistInSector = dist;
      }
    }
    dirDistances.push(minDistInSector === Infinity ? targetSpacing * 3 : minDistInSector);
  }
  const avgDist = dirDistances.reduce((a, b) => a + b, 0) / dirDistances.length;
  const maxDist = Math.max(...dirDistances);
  const variance = dirDistances.reduce((sum, d) => sum + (d - avgDist) ** 2, 0) / dirDistances.length;
  const stdDev = Math.sqrt(variance);
  let minCenterDistSq = Infinity;
  for (const p of existing) {
    const dx = candidate.x - p.x, dz = candidate.z - p.z;
    const distSq = dx * dx + dz * dz;
    if (distSq < minCenterDistSq) minCenterDistSq = distSq;
  }
  const cv = avgDist > 0 ? stdDev / avgDist : 0;
  const balanceBonus = (1 - Math.min(cv, 1)) * targetSpacing * targetSpacing * 2;
  const gapFillBonus = maxDist > targetSpacing * 1.5 ? (maxDist - targetSpacing) * 10 : 0;
  const centerDistSq = candidate.localX * candidate.localX + candidate.localZ * candidate.localZ;
  const centerPenalty = centerDistSq * 0.02;
  return minCenterDistSq + balanceBonus + gapFillBonus - centerPenalty;
}

/** 结构数量（固定值或 seed 决定范围，mc-lite getStructureCount） */
export function getStructureCount(config, seed, salt) {
  if (config.count != null) return config.count;
  if (!config.countRange) return 1;
  const [min, max] = config.countRange;
  if (min === max) return min;
  const r = hash01(seed * CITY_PLACEMENT.SEED_MIX_X + salt * CITY_PLACEMENT.SEED_MIX_Z);
  return min + Math.floor(r * (max - min + 1));
}

/** 放置有效性（边界 + 过渡带 + 间距，mc-lite isPlacementValid） */
export function isPlacementValid(candidate, existing, seed, bounds = null, requireTransitionZone = true) {
  const fpA = CITY_STRUCTURE_FOOTPRINT[candidate.type];
  if (!fpA) return false;
  if (bounds) {
    const boundsA = getStructureBounds(candidate.x, candidate.z, candidate.type);
    if (!boundsA) return false;
    if (!isPointInBounds(boundsA.minX, boundsA.minZ, bounds) ||
        !isPointInBounds(boundsA.maxX, boundsA.maxZ, bounds)) {
      return false;
    }
    if (requireTransitionZone) {
      const innerBounds = {
        minX: bounds.minX + CITY_TRANSITION_SIZE,
        maxX: bounds.maxX - CITY_TRANSITION_SIZE,
        minZ: bounds.minZ + CITY_TRANSITION_SIZE,
        maxZ: bounds.maxZ - CITY_TRANSITION_SIZE,
      };
      if (!isPointInBounds(boundsA.minX, boundsA.minZ, innerBounds) ||
          !isPointInBounds(boundsA.maxX, boundsA.maxZ, innerBounds)) {
        return false;
      }
    }
  }
  for (let i = 0; i < existing.length; i++) {
    const p = existing[i];
    const fpB = CITY_STRUCTURE_FOOTPRINT[p.type];
    if (!fpB) continue;
    const dx = Math.abs(candidate.x - p.x);
    const dz = Math.abs(candidate.z - p.z);
    const gap = getGapRequirement(candidate.type, p.type, seed, candidate.index, i);
    if (dx <= fpA.halfX + fpB.halfX + gap && dz <= fpA.halfZ + fpB.halfZ + gap) return false;
  }
  return true;
}

// ==================== CityMap 布局段移植 ====================

function getCityCenter(seed) {
  const { centerX: pyramidCx, centerZ: pyramidCz } = getRegionSeededCenter(CITY_REGION.X, CITY_REGION.Z, seed);
  const cityCx = pyramidCx + LANDMARK_OFFSET.CITY_X;
  const cityCz = pyramidCz + LANDMARK_OFFSET.CITY_Z;
  const minMargin = Math.floor(CITY_SIZE_MAX / 2) + REGION_MIN_MARGIN;
  return clampCenterToRegion(CITY_REGION.X, CITY_REGION.Z, cityCx, cityCz, minMargin);
}

/** 城市基准高度：半径 28 九点采样 (min+max)/2 + 稳定偏移，下限海平面+1（mc-lite estimateCityBaseHeight） */
function estimateCityBaseHeight(centerX, centerZ, seed) {
  const sampleRadius = 28;
  const sampleOffsets = [
    [0, 0], [sampleRadius, 0], [-sampleRadius, 0], [0, sampleRadius], [0, -sampleRadius],
    [sampleRadius, sampleRadius], [sampleRadius, -sampleRadius],
    [-sampleRadius, sampleRadius], [-sampleRadius, -sampleRadius],
  ];
  let minHeight = Infinity;
  let maxHeight = -Infinity;
  for (const [ox, oz] of sampleOffsets) {
    const h = generateHeight(centerX + ox, centerZ + oz, seed);
    if (h < minHeight) minHeight = h;
    if (h > maxHeight) maxHeight = h;
  }
  const avg = Math.floor((minHeight + maxHeight) * 0.5);
  const { BASE_HEIGHT_SEED, BASE_HEIGHT_OFFSET_X, BASE_HEIGHT_OFFSET_Z } = CITY_PLACEMENT;
  const stableOffset = Math.floor(hash01(seed * BASE_HEIGHT_SEED + centerX * BASE_HEIGHT_OFFSET_X + centerZ * BASE_HEIGHT_OFFSET_Z) * 2);
  return Math.max(CITY_MIN_SURFACE_Y, avg + stableOffset);
}

function findPlacementWithFallback(state, type, index, k, seed, minR, maxR, bounds) {
  const salt = index + k * 17 + type.length * 13;
  const candidates = buildCandidates(state.cityCx, state.cityCz, minR, maxR, seed, salt);
  const targetSpacing = Math.max(CITY_PLACEMENT.TARGET_SPACING_BASE, (minR + maxR) / CITY_PLACEMENT.TARGET_SPACING_DIVISOR);

  let best = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    const candidate = { ...c, type, index };
    if (!isPlacementValid(candidate, state.placements, seed, bounds, true)) continue;
    const score = scoreDirectionalBalance(candidate, state.placements, targetSpacing);
    if (score > bestScore) { bestScore = score; best = candidate; }
  }
  if (best) return best;

  const expansions = [
    { min: maxR + CITY_PLACEMENT.FALLBACK_RING_EXPAND_1, max: maxR + CITY_PLACEMENT.FALLBACK_RING_EXPAND_2, saltAdd: 29 },
    { min: maxR + CITY_PLACEMENT.FALLBACK_RING_EXPAND_3, max: maxR + CITY_PLACEMENT.FALLBACK_RING_EXPAND_4, saltAdd: 53 },
    { min: maxR + CITY_PLACEMENT.FALLBACK_RING_EXPAND_4, max: maxR + 180, saltAdd: 71 },
    { min: maxR + 180, max: maxR + 420, saltAdd: 97 },
  ];
  for (const exp of expansions) {
    const expCandidates = buildCandidates(state.cityCx, state.cityCz, exp.min, exp.max, seed, salt + exp.saltAdd);
    for (const c of expCandidates) {
      const candidate = { ...c, type, index };
      if (isPlacementValid(candidate, state.placements, seed, bounds, false)) return candidate;
    }
  }
  return null;
}

function findForcedPlacement(state, type, index, k, seed, maxR, gap) {
  const salt = index + k * 17 + type.length * 13;
  const fpA = CITY_STRUCTURE_FOOTPRINT[type];
  if (!fpA) return null;
  const candidates = buildCandidates(state.cityCx, state.cityCz, 10, maxR + 200, seed, salt + 137);
  for (const c of candidates) {
    const candidate = { ...c, type, index };
    let tooClose = false;
    for (const p of state.placements) {
      const fpB = CITY_STRUCTURE_FOOTPRINT[p.type];
      if (!fpB) continue;
      const dx = Math.abs(candidate.x - p.x);
      const dz = Math.abs(candidate.z - p.z);
      if (dx <= fpA.halfX + fpB.halfX + gap && dz <= fpA.halfZ + fpB.halfZ + gap) { tooClose = true; break; }
    }
    if (!tooClose) return candidate;
  }
  return null;
}

function placeType(state, type, count, seed, minR, maxR, bounds = null) {
  let placed = 0;
  for (let k = 0; k < count; k++) {
    const index = state.placements.length;
    let best = findPlacementWithFallback(state, type, index, k, seed, minR, maxR, bounds);
    if (!best) best = findForcedPlacement(state, type, index, k, seed, maxR, CITY_PLACEMENT.FORCED_GAP_STRICT);
    if (!best) best = findForcedPlacement(state, type, index, k, seed, maxR + 100, CITY_PLACEMENT.FORCED_GAP_LOOSE);
    if (!best) best = findForcedPlacement(state, type, index, k, seed, maxR + 300, CITY_PLACEMENT.FORCED_GAP_MINIMAL);
    if (!best) {
      const salt = index + k * 17 + type.length * 13;
      const randomCandidates = buildCandidates(state.cityCx, state.cityCz, maxR + 100, maxR + 600, seed, salt + 317);
      if (randomCandidates.length > 0) best = { ...randomCandidates[0], type, index };
    }
    if (!best) {
      const salt = index + k * 17 + type.length * 13;
      const angle = hash01(seed * 0.5 + salt * 0.3) * Math.PI * 2;
      const dist = maxR + 50 + hash01(seed * 0.7 + salt * 0.5) * 200;
      best = {
        x: Math.floor(state.cityCx + Math.cos(angle) * dist),
        z: Math.floor(state.cityCz + Math.sin(angle) * dist),
        localX: Math.floor(Math.cos(angle) * dist),
        localZ: Math.floor(Math.sin(angle) * dist),
        type, index,
      };
    }
    if (best) { state.placements.push(best); placed++; }
  }
  return placed;
}

function isGatePlacementValid(candidate, placements, fp) {
  for (const p of placements) {
    const pFp = CITY_STRUCTURE_FOOTPRINT[p.type];
    if (!pFp) continue;
    const dx = Math.abs(candidate.x - p.x);
    const dz = Math.abs(candidate.z - p.z);
    const gap = Math.max(fp.minGap, pFp.minGap, 10);
    if (dx < fp.halfX + pFp.halfX + gap && dz < fp.halfZ + pFp.halfZ + gap) return false;
  }
  return true;
}

function tryPlaceGate(state, cfg, cityBounds, innerMinX, innerMaxX, fp, index, _seed) {
  const { GATE_Z_OFFSET_MAX, GATE_X_SCAN_STEP } = CITY_PLACEMENT;
  for (let offset = 0; offset <= GATE_Z_OFFSET_MAX; offset++) {
    const candidateZ = cfg.preferredZ + offset * cfg.zDir;
    if (candidateZ - fp.halfZ < cityBounds.minZ || candidateZ + fp.halfZ > cityBounds.maxZ) continue;
    const centerX = state.cityCx;
    const xRange = Math.floor((innerMaxX - innerMinX) / 2);
    for (let xOffset = 0; xOffset <= xRange; xOffset += GATE_X_SCAN_STEP) {
      const scanPositions = xOffset === 0 ? [centerX] : [centerX + xOffset, centerX - xOffset];
      for (const scanX of scanPositions) {
        const safeScanX = Math.max(innerMinX, Math.min(innerMaxX, scanX));
        if (safeScanX - fp.halfX < cityBounds.minX || safeScanX + fp.halfX > cityBounds.maxX) continue;
        const candidate = {
          type: 'gate', x: safeScanX, z: candidateZ,
          localX: safeScanX - state.cityCx, localZ: candidateZ - state.cityCz,
          index: state.placements.length + index,
        };
        if (isGatePlacementValid(candidate, state.placements, fp)) return candidate;
      }
    }
  }
  return null;
}

// mc-lite 此 fallback 用 Math.random() 抽 x；新引擎改 hash01 确定性抽样（布局必须可复现）
function tryPlaceGateFallback(state, cfg, cityBounds, innerMinX, innerMaxX, fp, index, seed) {
  for (let offset = 0; offset <= 25; offset++) {
    const candidateZ = cfg.preferredZ + offset * cfg.zDir;
    if (candidateZ - fp.halfZ < cityBounds.minZ || candidateZ + fp.halfZ > cityBounds.maxZ) continue;
    for (let attempt = 0; attempt < 50; attempt++) {
      const randomX = innerMinX + Math.floor(hash01(seed * 3.71 + index * 13.3 + offset * 1.7 + attempt * 0.61) * (innerMaxX - innerMinX));
      const safeScanX = Math.max(innerMinX, Math.min(innerMaxX, randomX));
      if (safeScanX - fp.halfX < cityBounds.minX || safeScanX + fp.halfX > cityBounds.maxX) continue;
      const candidate = {
        type: 'gate', x: safeScanX, z: candidateZ,
        localX: safeScanX - state.cityCx, localZ: candidateZ - state.cityCz,
        index: state.placements.length + index,
      };
      if (isGatePlacementValid(candidate, state.placements, fp)) return candidate;
    }
  }
  return null;
}

function placeGates(state, seed, cityBounds) {
  const fp = CITY_STRUCTURE_FOOTPRINT.gate;
  const innerMinX = cityBounds.minX + CITY_TRANSITION_SIZE + fp.halfX;
  const innerMaxX = cityBounds.maxX - CITY_TRANSITION_SIZE - fp.halfX;
  const northZ = cityBounds.minZ + CITY_TRANSITION_SIZE + fp.halfZ;
  const southZ = cityBounds.maxZ - CITY_TRANSITION_SIZE - fp.halfZ;
  const sideConfigs = [
    { side: 'north', preferredZ: northZ, zDir: 1 },
    { side: 'south', preferredZ: southZ, zDir: -1 },
  ];
  const gates = [];
  for (let i = 0; i < CITY_PLACEMENT.GATE_COUNT; i++) {
    const cfg = sideConfigs[i];
    let placed = tryPlaceGate(state, cfg, cityBounds, innerMinX, innerMaxX, fp, i, seed);
    if (!placed) placed = tryPlaceGateFallback(state, cfg, cityBounds, innerMinX, innerMaxX, fp, i, seed);
    if (placed) gates.push(placed);
  }
  for (const g of gates) state.placements.push(g);
}

function buildCityFillerTanks(layout, seed) {
  const tanks = [];
  const { FILLER_TANK_HALF_SIZE, FILLER_TANK_COUNT, FILLER_TANK_MIN_GAP, FILLER_TANK_ATTEMPTS, FILLER_TANK_BUILDING_PADDING } = CITY_PLACEMENT;
  const minX = layout.minX + CITY_TRANSITION_SIZE + FILLER_TANK_HALF_SIZE + 2;
  const maxX = layout.maxX - CITY_TRANSITION_SIZE - FILLER_TANK_HALF_SIZE - 2;
  const minZ = layout.minZ + CITY_TRANSITION_SIZE + FILLER_TANK_HALF_SIZE + 2;
  const maxZ = layout.maxZ - CITY_TRANSITION_SIZE - FILLER_TANK_HALF_SIZE - 2;
  if (minX > maxX || minZ > maxZ) return tanks;
  const rangeX = Math.max(1, maxX - minX + 1);
  const rangeZ = Math.max(1, maxZ - minZ + 1);
  for (let i = 0; i < FILLER_TANK_COUNT; i++) {
    for (let attempt = 0; attempt < FILLER_TANK_ATTEMPTS; attempt++) {
      const rx = Math.floor(hash01(seed * 1.91 + i * 13.7 + attempt * 0.73) * rangeX);
      const rz = Math.floor(hash01(seed * 2.03 + i * 17.1 + attempt * 0.67) * rangeZ);
      const x = minX + rx;
      const z = minZ + rz;
      if (isNearPlacement(layout.placements, x, z, FILLER_TANK_BUILDING_PADDING)) continue;
      const nearOtherTank = tanks.some((t) => Math.max(Math.abs(t.x - x), Math.abs(t.z - z)) < FILLER_TANK_MIN_GAP);
      if (nearOtherTank) continue;
      tanks.push({ type: 'tank', x, z, id: `tank_fill_${i}` });
      break;
    }
  }
  return tanks;
}

function calculateCityBoundsFromPlacements(placements, cityCx, cityCz) {
  let buildMinX = cityCx, buildMaxX = cityCx, buildMinZ = cityCz, buildMaxZ = cityCz;
  for (const p of placements) {
    if (p.type === 'gate') continue;
    const fp = CITY_STRUCTURE_FOOTPRINT[p.type];
    if (!fp) continue;
    buildMinX = Math.min(buildMinX, p.x - fp.halfX);
    buildMaxX = Math.max(buildMaxX, p.x + fp.halfX);
    buildMinZ = Math.min(buildMinZ, p.z - fp.halfZ);
    buildMaxZ = Math.max(buildMaxZ, p.z + fp.halfZ);
  }
  const requiredMinX = buildMinX - CITY_CORE_BUILD_MARGIN - CITY_TRANSITION_SIZE;
  const requiredMaxX = buildMaxX + CITY_CORE_BUILD_MARGIN + CITY_TRANSITION_SIZE;
  const requiredMinZ = buildMinZ - CITY_CORE_BUILD_MARGIN - CITY_TRANSITION_SIZE;
  const requiredMaxZ = buildMaxZ + CITY_CORE_BUILD_MARGIN + CITY_TRANSITION_SIZE;
  const requiredHalfX = Math.max(Math.abs(requiredMaxX - cityCx), Math.abs(cityCx - requiredMinX));
  const requiredHalfZ = Math.max(Math.abs(requiredMaxZ - cityCz), Math.abs(cityCz - requiredMinZ));
  const requiredHalfSize = Math.max(requiredHalfX, requiredHalfZ);
  const minHalfSize = Math.floor(CITY_SIZE_MIN / 2);
  const cityMaxHalfSize = Math.floor(CITY_SIZE_MAX / 2);
  const halfSize = Math.max(minHalfSize, Math.min(cityMaxHalfSize, requiredHalfSize));
  return { minX: cityCx - halfSize, maxX: cityCx + halfSize, minZ: cityCz - halfSize, maxZ: cityCz + halfSize, halfSize };
}

function expandBoundsIfNeeded(placements, bounds, cityCx, cityCz) {
  let { minX, maxX, minZ, maxZ } = bounds;
  const safeMinX = minX + CITY_TRANSITION_SIZE;
  const safeMaxX = maxX - CITY_TRANSITION_SIZE;
  const safeMinZ = minZ + CITY_TRANSITION_SIZE;
  const safeMaxZ = maxZ - CITY_TRANSITION_SIZE;
  let needExpand = false;
  for (const p of placements) {
    const fp = CITY_STRUCTURE_FOOTPRINT[p.type];
    if (!fp) continue;
    const pMinX = p.x - fp.halfX, pMaxX = p.x + fp.halfX;
    const pMinZ = p.z - fp.halfZ, pMaxZ = p.z + fp.halfZ;
    if (pMinX < safeMinX || pMaxX > safeMaxX || pMinZ < safeMinZ || pMaxZ > safeMaxZ) {
      needExpand = true;
      if (pMinX < safeMinX) minX -= (safeMinX - pMinX) + 2;
      if (pMaxX > safeMaxX) maxX += (pMaxX - safeMaxX) + 2;
      if (pMinZ < safeMinZ) minZ -= (safeMinZ - pMinZ) + 2;
      if (pMaxZ > safeMaxZ) maxZ += (pMaxZ - safeMaxZ) + 2;
    }
  }
  if (needExpand) {
    const maxSize = Math.max(maxX - minX, maxZ - minZ);
    return {
      minX: cityCx - Math.floor(maxSize / 2), maxX: cityCx + Math.floor(maxSize / 2),
      minZ: cityCz - Math.floor(maxSize / 2), maxZ: cityCz + Math.floor(maxSize / 2),
      halfSize: Math.floor(maxSize / 2),
    };
  }
  return bounds;
}

function clampPlacementsToBounds(placements, bounds) {
  const safeMinX = bounds.minX + CITY_TRANSITION_SIZE;
  const safeMaxX = bounds.maxX - CITY_TRANSITION_SIZE;
  const safeMinZ = bounds.minZ + CITY_TRANSITION_SIZE;
  const safeMaxZ = bounds.maxZ - CITY_TRANSITION_SIZE;
  for (const p of placements) {
    const fp = CITY_STRUCTURE_FOOTPRINT[p.type];
    if (!fp) continue;
    const pMinX = p.x - fp.halfX, pMaxX = p.x + fp.halfX;
    const pMinZ = p.z - fp.halfZ, pMaxZ = p.z + fp.halfZ;
    if (pMinX < safeMinX) p.x = safeMinX + fp.halfX + 2;
    if (pMaxX > safeMaxX) p.x = safeMaxX - fp.halfX - 2;
    if (pMinZ < safeMinZ) p.z = safeMinZ + fp.halfZ + 2;
    if (pMaxZ > safeMaxZ) p.z = safeMaxZ - fp.halfZ - 2;
  }
}

/**
 * 构建城市布局（mc-lite buildCityLayout；确定性，可在任意 Worker 复现）。
 * 返回纯对象（无 Map），可直接 postMessage。
 */
export function buildCityLayout(seed) {
  const { cx: cityCx, cz: cityCz } = getCityCenter(seed);
  const baseHeight = estimateCityBaseHeight(cityCx, cityCz, seed);

  const state = { cityCx, cityCz, placements: [] };
  const globalMaxHalfSize = Math.floor(CITY_SIZE_MAX / 2);
  const maxBounds = {
    minX: cityCx - globalMaxHalfSize, maxX: cityCx + globalMaxHalfSize,
    minZ: cityCz - globalMaxHalfSize, maxZ: cityCz + globalMaxHalfSize,
  };

  state.placements.push({ type: 'castle', x: cityCx, z: cityCz, localX: 0, localZ: 0, index: 0 });

  let salt = 1;
  for (const config of CITY_STRUCTURE_CONFIGS) {
    if (config.fixedCenter) continue;
    const count = getStructureCount(config, seed, salt++);
    if (count <= 0) continue;
    const isLarge = config.type === 'whiteTower' || config.type === 'pyramidIsland' ||
      config.type === 'regularHouse1' || config.type === 'desertTempleTube';
    const minR = isLarge ? CITY_PLACEMENT.LARGE_STRUCT_MIN_RADIUS : CITY_PLACEMENT.NORMAL_STRUCT_MIN_RADIUS;
    const maxR = isLarge ? CITY_PLACEMENT.LARGE_STRUCT_MAX_RADIUS : CITY_PLACEMENT.NORMAL_STRUCT_MAX_RADIUS;
    placeType(state, config.type, count, seed, minR, maxR, maxBounds);
  }

  let bounds = calculateCityBoundsFromPlacements(state.placements, cityCx, cityCz);
  bounds = expandBoundsIfNeeded(state.placements, bounds, cityCx, cityCz);
  clampPlacementsToBounds(state.placements, bounds);
  placeGates(state, seed, bounds);

  const placements = state.placements.map((p, idx) => ({ ...p, id: `${p.type}_${idx}` }));
  const fillerPlacements = buildCityFillerTanks(
    { centerX: cityCx, centerZ: cityCz, ...bounds, placements }, seed);

  return {
    centerX: cityCx, centerZ: cityCz, baseHeight,
    halfSize: bounds.halfSize,
    minX: bounds.minX, maxX: bounds.maxX, minZ: bounds.minZ, maxZ: bounds.maxZ,
    placements, fillerPlacements,
  };
}

/**
 * 城市点位信息（mc-lite getCityInfo）：越界 null，附边缘距离/过渡因子。
 * @param {Object} city buildCityLayout 结果
 */
export function getCityInfo(wx, wz, city) {
  if (wx < city.minX || wx > city.maxX || wz < city.minZ || wz > city.maxZ) return null;
  const edgeDistance = Math.min(wx - city.minX, city.maxX - wx, wz - city.minZ, city.maxZ - wz);
  const transitionFactor = edgeDistance >= CITY_TRANSITION_SIZE
    ? 0
    : (CITY_TRANSITION_SIZE - edgeDistance) / CITY_TRANSITION_SIZE;
  return { ...city, edgeDistance, transitionFactor, isTransition: transitionFactor > 0 };
}

/**
 * 城内地面高度（mc-lite getCitySurfaceY）：baseHeight + 距离分档的宏观噪声起伏。
 * @param {Object} city buildCityLayout 结果
 * @returns {number|null}
 */
export function getCitySurfaceY(wx, wz, city, seed) {
  const cityInfo = getCityInfo(wx, wz, city);
  if (!cityInfo) return null;
  const dx = wx - cityInfo.centerX;
  const dz = wz - cityInfo.centerZ;
  const dist = Math.max(Math.abs(dx), Math.abs(dz));
  const coreFlatRadius = Math.floor(cityInfo.halfSize * 0.35);
  const midRadius = Math.floor(cityInfo.halfSize * 0.75);

  let amplitude = 0;
  const ampMax = Math.min(2, CITY_GROUND_VARIANCE_MAX);
  if (dist > coreFlatRadius && dist <= midRadius) amplitude = 1;
  else if (dist > midRadius) amplitude = ampMax;

  const coarseX = Math.floor((wx + seed * 0.37) / 12);
  const coarseZ = Math.floor((wz - seed * 0.41) / 12);
  const macroA = Math.sin((coarseX + seed * 0.013) * 0.8);
  const macroB = Math.cos((coarseZ - seed * 0.017) * 0.75);
  const macroC = Math.sin((coarseX + coarseZ + seed * 0.011) * 0.5);
  const macro = macroA * 0.45 + macroB * 0.35 + macroC * 0.2;

  const variance = Math.round(macro * amplitude);
  return Math.max(CITY_MIN_SURFACE_Y, cityInfo.baseHeight + variance);
}
