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

/**
 * 撒布结构占地配置（按 JSON 实测**完整包围盒**，非底层面块）。
 *
 * 为什么不复用 `CITY_STRUCTURE_FOOTPRINT`：那表的 `minGap` 字段是城市 placement 放置算法
 * 专用的，撒布结构不参与 placement 配额（它们是逐点概率撒布），混进一张表会让 `minGap`
 * 对撒布结构成为无意义的死字段。两张表语义互斥（红线 1：同一事实只有一份权威）。
 *
 * ⚠️ 本表有**两个消费方**，改值前两边都要评估：
 *   ① `apply.js:240` 的 AABB 裁剪（决定哪些 column 会光栅化该候选）；
 *   ② `scatter.js` 的 `isFirstInFootprint`（同类型候选互斥抑制范围 → **直接影响密度**）。
 *
 * ⚠️ `tallWell` 的 **24/20 是历史遗留的抑制范围，不是真实包围盒**（表头「按 JSON 实测
 * 完整包围盒」的唯一例外）：2026-09-30 前 JSON 里有一个孤立的 `chest@(24,51,20)` 把包围盒
 * 撑到 x[-5,24] z[-4,20]（mc-lite 上游数据异常，井体本身只到 y=16、x[-5,3] z[-4,4]）。
 * 那个宝箱在 y=51 完全悬空 → 用户报告「天空中好多悬空宝箱」，已从 JSON 删除（数据勘误，
 * 同 big_house 删 lilypad）。**删 chest 后刻意保留 24/20 不收缩**：收缩到真实包围盒 5/4
 * 会缩小 ② 的抑制范围 → 井密度 70→103（+47%，seed=12345 实测），增加 cutout 通道压力
 * （roadmap 警告 cutout 峰值 81.9% 已近预算，扩容是离散 ×1.5 跳增），且沙箱阻止浏览器
 * bench 无法实测验证。保留 24/20 维持用户当前看到的井密度，仅浪费少量 AABB 裁剪计算。
 */
export const SCATTER_FOOTPRINT = Object.freeze({
  flowerBed: { halfX: 5, halfZ: 3 },      // x[-4,5] z[-2,3]
  pavilion: { halfX: 5, halfZ: 3 },       // x[-4,5] z[-2,3]
  tallWell: { halfX: 24, halfZ: 20 },     // 历史遗留抑制范围（孤立 chest 已删，见上注释）
  desertPyramid: { halfX: 12, halfZ: 12 }, // x[-12,12] z[-12,12]
  desertVillage: { halfX: 8, halfZ: 8 },   // x[-8,8] z[-8,8]
  uglyHouse: { halfX: 6, halfZ: 10 },      // x[-6,4] z[-4,10]
  tank: { halfX: 12, halfZ: 8 },           // x[-12,9] z[-8,-2]
  house: { halfX: 2, halfZ: 2 },           // 代码生成：5×5 地基 + 屋顶
  ship: { halfX: 2, halfZ: 3 },            // 代码生成：dx -2..2 (5) × dz -3..3 (7)
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

// ==================== RedCity（spec §13 / §14，v1.68）====================
// 常量唯一权威 = 本文件（红线 1）：烘焙脚本（tools/）与 check:data 从这里 import，产物记录其值并由 check:data 比对。

/** 烘焙包围盒（= 模型内容的水平尺寸；redcity.json 的 width/length 必须等于它） */
export const REDCITY_SIZE = Object.freeze({ X: 250, Z: 289 });
/** 过渡环宽度 W */
export const REDCITY_TRANSITION = 24;
/** core 与 City bounds 之间的间隙。= W：过渡环恰好填满，与 City 自己的内缘过渡（32 格）首尾相接、互不叠加 */
export const REDCITY_GAP = 24;
/** 岛最低处的地面下限（相对 baseY）。同时是烘焙钳制值与 baseY 的下限推导：baseY >= SEA_Y + 1 - 本值 */
export const REDCITY_GROUND_FLOOR = -5;
/** core 全深度实心填充材料（与 City 的 clay 基底同族） */
export const REDCITY_FILL_BLOCK = 'clay';
/** 布局期 baseY 上界（钳制，不抛错）。与 REDCITY_DY_MAX_BUDGET 配对：8 + 87 = 95 = WORLD_MAX_Y - 1 */
export const REDCITY_BASE_Y_MAX = 8;
/** 烘焙期 dyMax 预算（相对 baseY 的最高行号）。实测当前产物 dyMax = 80 */
export const REDCITY_DY_MAX_BUDGET = 87;
/**
 * 树冠最大水平半径（唯一权威）。apply.js 阶段 3 的扫描外扩 EXT 与 RedCity 的植被避让距离都取它——
 * 实测 generateTree 各型 ≤3（swamp 的 |dx|+|dz|≤3.5 取到 3，其余 2），桦树 JSON ±2。
 * `test-redcity-vegetation.js` 用 generateTree 实测钉「最大半径 ≤ 本值」；加更大的树型必须先改这里。
 */
export const TREE_CANOPY_RADIUS = 3;
/** 植被避让距离：core ⊕ 本值。= 树冠最大半径：根在 d>=4 的树，树冠最近也只到 d=1，永不进 core */
export const REDCITY_VEG_CLEARANCE = TREE_CANOPY_RADIUS;

// ==================== RedCity 地表可跑动性（spec §15，v1.69）====================
// 用户在 v1.68 实玩后反馈：地表碎石嶙峋、中央台基爬不上去、玻璃过多。§15 的方案把这四项做成显式常量。
// **唯一权威仍在本文件**：烘焙脚本从 tools/redcity-config.mjs 引用（tools 可 import src，反向禁止），
// `check:data` 的 `[RedCity]` 环节比对产物里记录的值。

/**
 * 岛内相邻列的高差上限（格）。= 2：1 格台阶由 `MAX_STEP=1.0` 直接走上去，2 格需跳，>2 则被迫绕路。
 * 消费者 = 烘焙的 Lipschitz 平滑器；`check:data` 重算产物地面场校验。
 * 〔实测〕旧产物 |Δ|>2 占 10.8%（最大 35）→ 本值生效后 0.0%（最大 2）。
 */
export const REDCITY_MAX_STEP = 2;
/**
 * 「薄构件」厚度上限（格）。厚度 = maxY - minY + 1。
 * 薄构件（铺装/地砖/玻璃网）逐列跟随地面（形变 ≤ MAX_STEP，不可见）；更厚的走刚性平移。
 */
export const REDCITY_THIN_MAX = 3;
/**
 * 连通体按「列底面高度」再拆分的容差（格）。
 * 底面高度跨度 > 本值的连通体（地砖把多栋房子连成一片）按列底面高度 ±本值的连通性切成子分量，
 * 各自求单一平移量 —— 否则对整片做刚性平移必然「一部分被埋、一部分悬空」。
 * 〔实测〕拆分前 baseRange p50 4 / p90 17 / max 44，被埋 30.3%；拆分后 p50 0 / p90 4 / max 6，被埋 18.8%。
 */
export const REDCITY_BASE_TOL = 3;
/**
 * 玻璃「窗框」判据：至少这么多个实心（非玻璃）六邻接才保留。
 * 〔实测〕源模型 46,787 块玻璃里只有 3.6% 满足 ≥2 —— 96.4% 是无框玻璃壳/网（最大单个连通体 18,089 块）。
 * 统计必须在**输出空间、删除前**做（边删边统计会让邻接关系自我改变）。
 */
export const REDCITY_GLASS_FRAME_MIN = 2;
/**
 * 基座填土上限（格）。footprint 列 ground+1 .. 建筑底面-1 填 `REDCITY_FILL_BLOCK`，超过本值即判定为
 * 拱洞/挑檐 → **保持通透**（spec §2.4 明确要求保留拱洞，把挑檐填实会让拱门消失）。
 */
export const REDCITY_MAX_FILL = 12;

/**
 * 孤立方块过滤（spec §15.9，v1.70）：六邻接全空的方块删除。
 *
 * 用户实玩反馈「空中有大量的悬空方块」。实测当前产物有 **3,760** 个六邻接全空的方块（占 1.96%），
 * 其中 3,607 个悬空、3,154 个悬在 11 格以上。**不是删玻璃的次生后果**：玻璃全保留时仍有 3,888 个
 * （源模型自带）。实测**无级联效应**（删一轮即到不动点）。
 *
 * ⚠️ 这是**布尔开头的语义常量**，不是阈值：`true` 时删除、`false` 时全部保留。
 * 实施时设为 `true` 并进指纹（改开关也必须重烘）。
 */
export const REDCITY_DROP_ISOLATED = true;
