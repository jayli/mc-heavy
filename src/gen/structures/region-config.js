// src/gen/structures/region-config.js — 区域地图配置（整体移植 mc-lite RegionMapConfig）
// Worker 同构：本文件不得 import three。

/** 区域尺寸：每个区域 400×400 格 */
export const REGION_SIZE = 400;

/** 区域坐标边界的最小边距（防止地标生成在区域边缘） */
export const REGION_MIN_MARGIN = 5;

// ==================== 地标尺寸配置 ====================

export const PYRAMID_SIZE = 40;
export const FROZEN_MOUNTAIN_SIZE = 80;
export const SNOW_LAND_SIZE = 40;
export const ISLAND_SIZE = 30;
export const PLAIN_LAND_SIZE = 30;
export const CITY_SIZE_MIN = 112;
export const CITY_SIZE_MAX = 224;

// ==================== City 主城配置 ====================

export const CITY_TRANSITION_SIZE = 32;
export const CITY_TERRACE_WIDTH = 3;
export const CITY_CORE_BUILD_MARGIN = 30;
export const CITY_GROUND_VARIANCE_MAX = 3;
/** City 区域坐标（固定生成在区域 [0,0]） */
export const CITY_REGION = { X: 0, Z: 0 };

/** City 结构占地配置（按 JSON 实测边界） */
export const CITY_STRUCTURE_FOOTPRINT = Object.freeze({
  castle: { halfX: 23, halfZ: 26, minGap: 10 },
  whiteTower: { halfX: 15, halfZ: 6, minGap: 12 },
  bigHouse: { halfX: 18, halfZ: 20, minGap: 10 },
  regularHouse1: { halfX: 8, halfZ: 8, minGap: 10 },
  desertTempleTube: { halfX: 3, halfZ: 3, minGap: 10 },
  boxHouse: { halfX: 9, halfZ: 5, minGap: 10 },
  desertVillage: { halfX: 13, halfZ: 14, minGap: 10 },
  doubleTower: { halfX: 18, halfZ: 7, minGap: 10 },
  treeTower: { halfX: 10, halfZ: 11, minGap: 10 },
  junglePyramid: { halfX: 12, halfZ: 12, minGap: 10 },
  gate: { halfX: 13, halfZ: 5, minGap: 10 },
  pyramidIsland: { halfX: 17, halfZ: 20, minGap: 12 },
  smallHouse: { halfX: 16, halfZ: 16, minGap: 10 },
  tower: { halfX: 4, halfZ: 5, minGap: 10 },
  treeHouse: { halfX: 8, halfZ: 7, minGap: 10 },
  uglyHouse: { halfX: 20, halfZ: 20, minGap: 10 },
  woodHouse: { halfX: 8, halfZ: 9, minGap: 10 },
});

/** City 结构生成配额配置 */
export const CITY_STRUCTURE_CONFIGS = Object.freeze([
  { type: 'castle', count: 1, fixedCenter: true },
  // 大尺寸结构优先放置
  { type: 'pyramidIsland', count: 1 },
  { type: 'bigHouse', count: 2 },
  { type: 'regularHouse1', count: 2 },
  { type: 'desertTempleTube', count: 2 },
  { type: 'whiteTower', countRange: [2, 3] },
  { type: 'desertVillage', countRange: [2, 3] },
  { type: 'doubleTower', count: 1 },
  { type: 'treeTower', count: 1 },
  { type: 'junglePyramid', count: 1 },
  { type: 'boxHouse', count: 2 },
  { type: 'smallHouse', count: 2 },
  { type: 'tower', count: 1 },
  { type: 'treeHouse', count: 3 },
  { type: 'uglyHouse', count: 3 },
  { type: 'woodHouse', count: 4 },
]);

/** City 放置算法常量 */
export const CITY_PLACEMENT = Object.freeze({
  HASH_MULTIPLIER: 43758.5453123,
  SEED_MIX_X: 1.213,
  SEED_MIX_Z: 13.11,
  BASE_HEIGHT_SEED: 0.311,
  BASE_HEIGHT_OFFSET_X: 0.019,
  BASE_HEIGHT_OFFSET_Z: 0.023,
  CANDIDATE_ANGLE_STEP: 12,
  CANDIDATE_RING_STEP: 6,
  CANDIDATE_JITTER: 5,
  TARGET_SPACING_BASE: 15,
  TARGET_SPACING_DIVISOR: 8,
  LARGE_STRUCT_MIN_RADIUS: 30,
  LARGE_STRUCT_MAX_RADIUS: 180,
  NORMAL_STRUCT_MIN_RADIUS: 15,
  NORMAL_STRUCT_MAX_RADIUS: 150,
  FALLBACK_RING_EXPAND_1: 6,
  FALLBACK_RING_EXPAND_2: 28,
  FALLBACK_RING_EXPAND_3: 18,
  FALLBACK_RING_EXPAND_4: 96,
  FORCED_GAP_STRICT: 10,
  FORCED_GAP_LOOSE: 5,
  FORCED_GAP_MINIMAL: 0,
  GATE_COUNT: 2,
  GATE_Z_OFFSET_MAX: 15,
  GATE_X_SCAN_STEP: 2,
  FILLER_TANK_COUNT: 2,
  FILLER_TANK_HALF_SIZE: 20,
  FILLER_TANK_MIN_GAP: 18,
  FILLER_TANK_BUILDING_PADDING: 4,
  FILLER_TANK_ATTEMPTS: 120,
});

// ==================== 过渡带配置 ====================

export const TRANSITION_SIZE = Object.freeze({
  PYRAMID: 8,
  FROZEN_MOUNTAIN: 8,
  FROZEN_MOUNTAIN_CORE: 4,
  SNOW_LAND: 8,
  ISLAND: 10,
});

// ==================== 地标间距配置 ====================

/** 地标间距离偏移配置（相对于金字塔中心） */
export const LANDMARK_OFFSET = Object.freeze({
  FROZEN_MOUNTAIN_X: -160,
  FROZEN_MOUNTAIN_Z: 0,
  SNOW_LAND_X: 160,
  SNOW_LAND_Z: 0,
  PLAIN_LAND_X: 0,
  PLAIN_LAND_Z: 160,
  CITY_X: 0,
  CITY_Z: -170,
});

/** 地标间最小距离限制（防止重叠） */
export const LANDMARK_MIN_DISTANCE = Object.freeze({
  ISLAND_FROM_MOUNTAIN: 130,
  ISLAND_FROM_PYRAMID: 50,
});

// ==================== 随机中心偏移配置 ====================

export const CENTER_OFFSET = Object.freeze({
  SCALE_X: 300,
  SCALE_Z: 300,
  BASE_X: 100,
  BASE_Z: 100,
});

/** 区域随机中心计算的种子乘数参数 */
export const RANDOM_SEED_MULTIPLIERS = Object.freeze({
  X: 1.5,
  Z: 2.5,
  REGION: 0.1,
});

// ==================== 冰封山峰特有配置 ====================

export const FROZEN_MOUNTAIN_STEEP_AXIS = 'z';
export const FROZEN_MOUNTAIN_STEEP_FACTOR = 0.65;
export const FROZEN_MOUNTAIN_FLAT_RADIUS = 10;
export const FROZEN_MOUNTAIN_HEIGHT_FACTOR = 1.3;

// ==================== 海岛特有配置 ====================

export const ISLAND_SEA_LEVEL = -2;
export const ISLAND_MIN_DISTANCE_FROM_LAND = 20;
export const ISLAND_SHAPE_NOISE_SCALE = 0.30;
export const ISLAND_EDGE_NOISE_SCALE = 0.25;
export const ISLAND_SAND_PATCH_COUNT = 4;
export const ISLAND_STONE_PATCH_COUNT = 3;
export const ISLAND_PATCH_NOISE_SCALE = 0.15;
export const ISLAND_MIN_TREES = 1;
export const ISLAND_MAX_TREES = 2;
export const ISLAND_TREE_SPAWN_OFFSET = 1;

// ==================== 雪地特有配置 ====================

export const SNOW_LAND_CENTER_BOOST_MAX = 2;
export const SNOW_LAND_CENTER_BOOST_RADIUS = 15;
export const SNOW_LAND_NOISE_SCALE_1 = 0.08;
export const SNOW_LAND_NOISE_SCALE_2 = 0.15;
