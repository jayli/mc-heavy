// src/gen/structures/region-center.js — 区域内地标随机中心计算（移植 mc-lite RegionCenterUtils）
// Worker 同构：本文件不得 import three。
import { REGION_SIZE, CENTER_OFFSET, RANDOM_SEED_MULTIPLIERS } from './region-config.js';

/**
 * 计算区域内确定性随机中心（与 mc-lite getRegionSeededCenter 公式一致）。
 * @param {number} regionX @param {number} regionZ @param {number} seed
 * @param {Object} [options] 覆盖默认偏移参数
 * @returns {{centerX: number, centerZ: number}}
 */
export function getRegionSeededCenter(regionX, regionZ, seed, {
  offsetScaleX = CENTER_OFFSET.SCALE_X,
  offsetScaleZ = CENTER_OFFSET.SCALE_Z,
  offsetBaseX = CENTER_OFFSET.BASE_X,
  offsetBaseZ = CENTER_OFFSET.BASE_Z,
} = {}) {
  const randX = Math.abs(Math.sin(seed * RANDOM_SEED_MULTIPLIERS.X + regionX * RANDOM_SEED_MULTIPLIERS.REGION));
  const randZ = Math.abs(Math.sin(seed * RANDOM_SEED_MULTIPLIERS.Z + regionZ * RANDOM_SEED_MULTIPLIERS.REGION));
  const offsetX = Math.floor(randX * offsetScaleX) + offsetBaseX;
  const offsetZ = Math.floor(randZ * offsetScaleZ) + offsetBaseZ;
  return {
    centerX: regionX * REGION_SIZE + offsetX,
    centerZ: regionZ * REGION_SIZE + offsetZ,
  };
}

/**
 * 将中心点裁剪到区域边界内，保证与边界至少保留 minMargin 距离。
 * @returns {{cx: number, cz: number}}
 */
export function clampCenterToRegion(regionX, regionZ, centerX, centerZ, minMargin, { regionSize = REGION_SIZE } = {}) {
  let cx = centerX;
  let cz = centerZ;
  const regionLeft = regionX * regionSize;
  const regionRight = (regionX + 1) * regionSize;
  const regionTop = regionZ * regionSize;
  const regionBottom = (regionZ + 1) * regionSize;

  if (cx - minMargin < regionLeft) cx = regionLeft + minMargin;
  else if (cx + minMargin > regionRight) cx = regionRight - minMargin;

  if (cz - minMargin < regionTop) cz = regionTop + minMargin;
  else if (cz + minMargin > regionBottom) cz = regionBottom - minMargin;

  return { cx, cz };
}
