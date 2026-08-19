// src/gen/noise.js — 确定性噪声（逐行移植 mc-lite MathUtils，seed 参数化）
// Worker 同构：本文件不得 import three。

/**
 * 确定性伪随机（与 mc-lite seededRandom 完全一致，保证同 seed 世界可比对）。
 * @param {number} x @param {number} z @param {number} seed
 * @returns {number} [0,1)
 */
export function seededRandom(x, z, seed) {
  const val = Math.sin(x * 12.9898 + z * 78.233 + seed) * 43758.5453123;
  return val - Math.floor(val);
}

/**
 * 双层三角噪声（与 mc-lite noise 一致，seed 由参数传入替代全局 WORLD_CONFIG.SEED）。
 * @returns {number} [-4, 4]
 */
export function noise(x, z, seed, scale = 0.05) {
  const nx = x + seed, nz = z + seed;
  return Math.sin(nx * scale) * 2 + Math.cos(nz * scale) * 2;
}

/**
 * 生物群系判定（阈值与 mc-lite getBiome 一致；CITY 由 M2 结构系统叠加）。
 * @returns {'FOREST'|'AZALEA'|'DESERT'|'SWAMP'|'PLAINS'}
 */
export function getBiome(x, z, seed) {
  const temp = noise(x, z, seed, 0.01);
  const humidity = noise(x + 1000, z + 1000, seed, 0.015);
  if (temp > 1.2) return 'FOREST';
  if (temp > 0.6 && temp <= 1.2 && humidity > 0) return 'AZALEA';
  if (temp < -1.5) return 'DESERT';
  if (temp > -1.5 && temp < -0.8 && humidity > 0.5) return 'SWAMP';
  return 'PLAINS';
}
