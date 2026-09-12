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
 * biome 判定阈值与噪声参数（唯一权威）。
 *
 * ⚠️ **两个消费方**：`getBiome`（CPU/Worker 生成侧）与 `render/ocean.js` 的水面遮罩
 * （TSL 着色器）。着色器无法调 JS 函数，只能同构实现 —— 数值常量必须从这里读。
 * 各写一份字面量会漂移出「CPU 判 DESERT、GPU 判 PLAINS」的撕裂
 * （M6 同教训：两层共用的阈值须落在单一权威）。
 */
export const BIOME_PARAMS = Object.freeze({
  TEMP_SCALE: 0.01,
  HUMIDITY_SCALE: 0.015,
  /** humidity 的采样偏移（`noise(x+1000, z+1000)`，与 temp 去相关） */
  HUMIDITY_OFFSET: 1000,
  FOREST_TEMP_MIN: 1.2,
  AZALEA_TEMP_MIN: 0.6,
  AZALEA_HUMIDITY_MIN: 0,
  /** DESERT：`temp < DESERT_TEMP_MAX` */
  DESERT_TEMP_MAX: -1.5,
  /** SWAMP：`temp > DESERT_TEMP_MAX && temp < SWAMP_TEMP_MAX && humidity > SWAMP_HUMIDITY_MIN` */
  SWAMP_TEMP_MAX: -0.8,
  SWAMP_HUMIDITY_MIN: 0.5,
});

/**
 * 生物群系判定（阈值与 mc-lite getBiome 一致；CITY 由 M2 结构系统叠加）。
 *
 * ⚠️ CITY **不在**这里的判定里 —— 它由结构系统按城市 bounds 叠加
 * （`gen/structures/city-layout.js`）。所以水面遮罩算不出 CITY 调整，
 * 城市区域须靠 bounds 门控单独关掉（见 `render/ocean-mask.js`）。
 * @returns {'FOREST'|'AZALEA'|'DESERT'|'SWAMP'|'PLAINS'}
 */
export function getBiome(x, z, seed) {
  const P = BIOME_PARAMS;
  const temp = noise(x, z, seed, P.TEMP_SCALE);
  const humidity = noise(x + P.HUMIDITY_OFFSET, z + P.HUMIDITY_OFFSET, seed, P.HUMIDITY_SCALE);
  if (temp > P.FOREST_TEMP_MIN) return 'FOREST';
  if (temp > P.AZALEA_TEMP_MIN && temp <= P.FOREST_TEMP_MIN
    && humidity > P.AZALEA_HUMIDITY_MIN) return 'AZALEA';
  if (temp < P.DESERT_TEMP_MAX) return 'DESERT';
  if (temp > P.DESERT_TEMP_MAX && temp < P.SWAMP_TEMP_MAX
    && humidity > P.SWAMP_HUMIDITY_MIN) return 'SWAMP';
  return 'PLAINS';
}
