// src/gen/structures/shallow-water-terrain.js — 浅水高台：湖盆整形 + 五座高台落位 + 深浅草分流
//
// 设计文档：docs/superpowers/specs/2026-11-01-shallow-water-tarns-design.md §5 / §6
//
// 两段式里的「地形」那一半：`computeShallowTarnAnchor()`（`shallow-water-tarns.js`）算布局，
// 本文件把布局**落到方块**。调用顺序必须是
//   `fillColumn`（自然地形） → `carveCaves` → **`fillShallowTarnBasin`（本文件）**
//   → `rasterizeShallowTarnPlatforms`（本文件，五座高台）
// 放在 `fillColumn` 之前会被它覆盖；放在 `rasterizeStructure` 之后会把高台削掉。
//
// Worker 同构：本文件不得 import three、不得 fetch、不得自建 Worker。
// 生成路径：不记 edits、不 bump version（与 `fillColumn` / `fillTarnPlateau` 同口径）。

import { blockIndex, WORLD_MIN_Y, WORLD_MAX_Y, SEA_Y } from '../../voxel/constants.js';
import { generateHeight } from '../terrain.js';
import { rasterizeStructure } from './structure-json.js';
import {
  LAKE_RADIUS, BEACH_WIDTH, SLOPE_WIDTH, LAKE_FLOOR_Y, BEACH_OUTER_Y, BEACH_RISE,
  SHALLOW_TARN_OUTER_RADIUS, SHALLOW_TARN_GRASS_SALT, computeShallowTarnLayout,
  shallowTarnLakeRadiusAt, shallowTarnShapePhase,
} from './shallow-water-tarns.js';
import { GRASS_MARKER_BLOCK } from './shallow-water-tarn-data.js';
import { rollVegetation } from './vegetation.js';

// ==================== 湖岸径向坐标 ====================

/**
 * 某格到**湖岸**的径向偏移 `e = d − R(θ)`（负数 = 在湖盆里）。
 *
 * 这是 v2.15 的核心换元：旧实现用「到湖心的距离 `d`」，而湖岸变成不规则曲线后，
 * 三条带的判据必须是「到**岸**的距离」—— 否则凸出/凹进的方位上沙滩宽度就不一样了。
 *
 * ⚠️ **不得拿 `e` 当欧氏距离用**：它只在固定方位上是距离，跳方向会跳变（尖角）。
 * 需要欧氏距离的地方（如外接方形裁剪）继续用 `Math.hypot`。
 *
 * @param {number} wx @param {number} wz @param {number} seed
 * @param {{wx: number, wz: number}} anchor
 * @returns {number}
 */
function shallowTarnLakeOffset(wx, wz, seed, anchor) {
  const dx = wx - anchor.wx;
  const dz = wz - anchor.wz;
  const d = Math.hypot(dx, dz);
  return d - shallowTarnLakeRadiusAt(Math.atan2(dz, dx), shallowTarnShapePhase(seed));
}

// ==================== 表面材质 ====================

/**
 * 表面材质 —— **唯一权威**（公开版与植被路径共用这一份，红线 1）。
 *
 * | 带 | 到湖岸的偏移 `e` | 地表 |
 * |---|---|---|
 * | 湖盆 / 沙滩 | `e ≤ BEACH_WIDTH` | `sand` |
 * | 外坡 | 再往外 | `grass`（自然地表材质）|
 *
 * ⚠️ **湖盆与沙滩都用 `sand`**：这是「湖」而不是「水塘边的草地」——
 * 用户要的是「浅水高台」，一圈沙岸能让水域边界在水下也认得出，
 * 且沙不会像草那样与周围地形抢色。
 *
 * ⚠️ **缓坡带里「该列在水下」也铺沙**（`targetY ≤ SEA_Y-1`）：自然水底本来就是
 * sand + end_stone（见 `fillColumn`），铺草会让水下出现一块草地。这条也是植被
 * 「水下坡一株不长」的来源 —— 那里的地表不是 `grass`。
 *
 * ## 为什么要一个吃 `e` 的重载
 * `shallowTarnSurfaceBlock`（公开版）自己算 `e`（`hypot` + 四条谐波）；植被路径每个
 * (wx,wz) 已经为了判地面高度算过 `e`，不能再算第二遍。本函数是公开版的**内部形状**，
 * 两者逐位等价（公开版直接转调本函数）。
 *
 * @param {number} wx @param {number} wz @param {number} seed
 * @param {{wx:number, wz:number}} anchor
 * @param {number} e 到湖岸的径向偏移（负数 = 湖盆里）
 * @param {number} targetY 该列已算好的地表高度（判「该列在水下」用）
 * @returns {string}
 */
export function shallowTarnSurfaceBlockAtOffset(wx, wz, seed, anchor, e, targetY) {
  if (e <= BEACH_WIDTH) return 'sand';
  // 缓坡带：该列在水下（接壤水系的坡面）也铺沙 —— 与公开版同一条理由。
  if (targetY <= SEA_Y - 1) return 'sand';
  return 'grass';
}

export function shallowTarnSurfaceBlock(wx, wz, seed, anchor, targetY) {
  return shallowTarnSurfaceBlockAtOffset(
    wx, wz, seed, anchor, shallowTarnLakeOffset(wx, wz, seed, anchor), targetY,
  );
}

/**
 * 某格的地表高度（纯函数）—— 三段式的**唯一权威**。
 *
 * 与 `fillShallowTarnBasin` 的目标高度公式是同一份（单测驱动、瞬移算落点也用它）。
 *
 * ## 三段（v2.15：判据是「到湖岸的偏移 `e = d − R(θ)`」，不是到湖心的距离）
 * 1. `e ≤ 0`（湖盆）：恒 `LAKE_FLOOR_Y`（= `SEA_Y-1`，其顶面 = `SEA_Y` → 水深 0.5 格）。
 * 2. `0 < e ≤ BEACH_WIDTH`：从 `LAKE_FLOOR_Y` **线性**抬到 `BEACH_OUTER_Y`。
 *    7 格内抬 3 格（= 0.43 格/格），玩家从水里走上来完全不需要跳（`MAX_STEP = 1.0`）。
 * 3. 再往外 `SLOPE_WIDTH` 格：从 `BEACH_OUTER_Y` **线性**插值到**平滑后的自然高度**。
 *    （v2.15 起这一段在「接壤水系」时会往下接自然水底，见 `shallowTarnSurfaceYAt` 的干湿两态）
 *
 * ⚠️ **缓坡必须用平滑高度，不能用本格的 `generateHeight`**（高台地带 v1.90 实测教训）：
 * 自然地形相邻高差实测最大 **11 格**（见设计文档 §5.3），直接插值会把它**放大成断崖**
 * —— 高台地带当时实测出现 6~7 格台阶，玩家被挡住。`slopeNaturalHeight`（半径 8 的均值）
 * 把「>1 格台阶」压到 0.000%。
 *
 * ⚠️ **缓坡之外返回自然高度本身**（不是插值终点的平滑值）：再往外必须是原生地形，
 * 否则本地图会把整片世界的地表都改写（缓坡终点与自然高度在这里本来就相等）。
 *
 * ## 为什么缓坡用「平滑值」而不是真实地形（本地图最关键的一条实测结论）
 * 高台地带 v1.90 的教训：直接用本格 `generateHeight` 会把自然陡坡**放大成断崖**
 * （实测 6~7 格台阶）。本地图更严重 —— 实测 seed 12345 的 ang=339° 射线上，
 * 自然地形在 **1 格内从 -3 跳到 -11（8 格）**（那是海岸线），而缓坡外缘正好压在它上面。
 *
 * 于是「缓坡末端贴合真实地形」这条路**根本走不通**：任何贴着 `generateHeight` 的接缝
 * 都会碰到这种 8 格断崖。三条修法都实测失败：
 * | 修法 | 结果（6 seed 最大单步落差） |
 * |---|---|
 * | 缓坡内全用平滑值（初版） | 带内 ≤1，但**外缘接缝处 3**（平滑值 ≠ 带外原始值）|
 * | 平滑→原始权重随 t 衰减（错误修法） | **5~7**（把自然陡坡掺回整条缓坡）|
 * | 平滑→原始只在最外 12 格过渡（错误修法） | **4~8**（过渡带内撞上那条 8 格海岸线）|
 * | **缓坡一平滑到底，不贴真实地形**（现行） | **≤1**（本地图范围内）；接缝落差落在缓坡**之外**的自然地形上 |
 *
 * ⇒ **正确的语义是「本地图自己是一块坡度可控的地，接缝处的自然落差由外边那块地承担」**，
 * 而不是「本地图把自然落差吸进来」。用户要的是「有梯度的衔接，不要生硬的断崖式衔接」——
 * 本地图这一侧永远是缓的（这才是它该负责的），外边那片海岸线本来就是个崖，不是本地图造出来的。
 *
 * @param {number} wx @param {number} wz @param {number} seed
 * @param {{wx: number, wz: number}} anchor
 * @returns {number} 该列地表的 y（方块所在的那一格）
 */
export function shallowTarnSurfaceYAt(wx, wz, seed, anchor) {
  const e = shallowTarnLakeOffset(wx, wz, seed, anchor);
  if (e <= 0) return LAKE_FLOOR_Y;
  // 整形区之外：原生地形（逐方向边界 `R(θ)+BEACH+SLOPE`，不是名义圆）
  const hS = slopeNaturalHeight(wx, wz, seed);
  // 干湿两态（v2.15）：权重 0 = 自然地形本身就是水（接壤水系），1 = 干地
  //
  // ⚠️ **判据只读平滑高度 `hS`**：实测把真实 `generateHeight` 掺进来（`min(hS, hNat)`）
  // 会让端点逐格跳 1 格 → 出现 **2 格台阶**（seed 1 / ang 54 / d 111，两侧都露出水面）；
  // 只用 `hS` 时 7 seed × 180 方位逐格最大单步 = 1。
  const wetLo = SEA_Y - 1;                                  // 天然水 ⟺ hS ≤ wetLo
  const t = Math.min(1, Math.max(0, (hS - wetLo) / (BEACH_OUTER_Y - wetLo)));
  const w = t * t * (3 - 2 * t);                            // smoothstep
  // 干态（hS ≥ 0）→ endY = 0 → midY = BEACH_OUTER_Y（与 v2.11~v2.14 逐位相同）
  // 湿态（hS ≤ SEA_Y-1）→ endY = hS → 沙滩带成了**水下坡**，两侧水面连通
  const endY = Math.min(BEACH_OUTER_Y, hS) * (1 - w);
  // 沙滩带降幅封顶 BEACH_RISE（与上坡同坡度），余量摊到缓坡带（防 7 格里陡降）
  const midY = Math.max(LAKE_FLOOR_Y - BEACH_RISE, Math.min(endY, BEACH_OUTER_Y));
  if (e <= BEACH_WIDTH) {
    const tb = e / BEACH_WIDTH;
    return Math.round(LAKE_FLOOR_Y + (midY - LAKE_FLOOR_Y) * tb);
  }
  if (e > BEACH_WIDTH + SLOPE_WIDTH) return generateHeight(wx, wz, seed);
  const t2 = (e - BEACH_WIDTH) / SLOPE_WIDTH;
  return Math.round(midY * (1 - t2) + hS * t2);
}
/**
 * 平滑后的自然高度：半径 `SLOPE_SMOOTH_RADIUS` 内方形的**均值**。
 *
 * ⚠️ **必须与高台地带用同一个聚合方式（均值），不能用最小值**：
 * `tarn-terrain.js` 实测对比（半径 8）—— 不平滑 7 格台阶 / 最小值聚合 8 格 / **均值 1 格**。
 *
 * ## 缓存键必须是**精确坐标**（这是一条修正过的教训）
 * 初版为了性能用 `(wx >> 3, wz >> 3)` 把 8×8 格并成一格，存的是**第一个落进该键的列**的高度。
 * 后果：同一 8×8 块里 64 列共享一个高度 → **8 格宽的平台**，跨块边界时跳变
 * 实测最大单步 **4 格**（而平滑值本身逐格只变 1.01）—— 「无断崖」直接失效。
 *
 * ⇒ **不能对高度做任何降采样缓存**。改成精确坐标作键后命中率仍然很高：
 * 本 column 的 16×16 列之间会互相命中（半径 8 的均值在相邻列本来就接近），
 * 而一个 column 只算 256 次，成本已在 §2.5 的 genP95 实测里（见 `SLOPE_CACHE` 注释）。
 *
 * @param {number} wx @param {number} wz @param {number} seed
 * @returns {number}
 */
function slopeNaturalHeight(wx, wz, seed) {
  const key = `${wx},${wz},${seed}`;
  const hit = SLOPE_CACHE.get(key);
  if (hit !== undefined) return hit;
  let sum = 0;
  let n = 0;
  for (let dx = -SLOPE_SMOOTH_RADIUS; dx <= SLOPE_SMOOTH_RADIUS; dx++) {
    for (let dz = -SLOPE_SMOOTH_RADIUS; dz <= SLOPE_SMOOTH_RADIUS; dz++) {
      sum += generateHeight(wx + dx, wz + dz, seed);
      n++;
    }
  }
  const value = sum / n;
  if (SLOPE_CACHE.size >= SLOPE_CACHE_MAX) {
    // 简单 FIFO 淘汰（Map 的插入序）
    SLOPE_CACHE.delete(SLOPE_CACHE.keys().next().value);
  }
  SLOPE_CACHE.set(key, value);
  return value;
}

/** 平滑半径（格）—— 与 `tarn-terrain.js` 的 `SLOPE_SMOOTH_RADIUS` 取同一个值（同一份实测依据） */
const SLOPE_SMOOTH_RADIUS = 8;

/** 平滑高度缓存上限（`8×8` 为格 × 一个视域 272² 格 ≈ 1156 项，留 ~4 倍余量） */
const SLOPE_CACHE_MAX = 4096;
const SLOPE_CACHE = new Map();

/** 清空平滑缓存（单测隔离用；生产代码不需要调用） */
export function clearShallowTarnTerrainCache() {
  SLOPE_CACHE.clear();
  PLATFORM_METRICS_CACHE.clear();
}

// ==================== 草方块深浅分流 ====================

/**
 * 世界坐标的**不可分离**噪声 —— 等值线是弯曲的闭合斑块，不是十字/菱形。
 *
 * ⚠️ **不能直接用 `noise()`**：它的实现是 `sin((x+seed)·s)·2 + cos((z+seed)·s)·2`，
 * x 项与 z 项**可分离相加** → 等值线必然是十字/菱形，边界上会出现几十格长的
 * 水平/垂直线段（高台地带 v1.93 实测到 36 格的直线段，用户报告「边界过于横平竖直」）。
 *
 * ⚠️ **这是 `tarn-terrain.js` 的 `blobNoise` 的同构副本**，刻意**不复用**：
 * 那个函数是 `tarn-terrain.js` 的内部工具（未导出），而把两个地图模块耦合成
 * 「改高台地带的斑块尺度会改浅水高台的草地」是不该有的耦合。
 * 两者都是 12 行纯函数、公式完全一致 —— 若哪天要统一，应该提取到一个共享模块，
 * 而不是从一边 import 另一边（那会让依赖方向出现横跨两张地图的隐含约束）。
 *
 * 值域标定在 **[-4, 4]**（与 `noise()` 同口径 ⇒ 阈值不必重标）。
 * @param {number} x @param {number} z @param {number} seed @param {number} scale
 * @returns {number} [-4, 4]
 */
function blobNoise(x, z, seed, scale) {
  const nx = x * scale;
  const nz = z * scale;
  const s = seed * scale;
  const a = Math.sin(nx + s) * Math.cos(nz + s * 0.7) * 2;
  const b = Math.sin(nx * 0.7 + nz * 1.3 + s * 1.3) * 1.4;
  const c = Math.cos(Math.hypot(nx, nz) * 1.1 + s) * 0.6;
  return a + b + c;
}

/**
 * 草哨兵 → 实际方块（`dark_grass` / `light_grass`）。
 *
 * 用户 2026-11-01：「高台模型里的草方块请用浅草方块和深草方块」+ 选定「成片分块」。
 *
 * ## 为什么按**世界坐标**噪声分而不是按素材局部坐标
 * 按素材坐标（烘焙期决定）会让分块**固定在模型里**，五座高台各自的摆放位置与朝向会让
 * 深浅分区在世界里随摆放漂移；按世界坐标算则同一片区域连成一片，与周围地形的关系也自然
 * （与高台地带的 `tarnSurfaceBlock` 用世界坐标同源）。
 *
 * ## 为什么是噪声而不是逐格随机
 * 逐格二选一会得到**棋盘状噪点**，与用户要的「成片分块」相反。
 * `SHALLOW_GRASS_SCALE = 0.09` → 波长约 11 格，斑块大小与高台台面（15~65 格）匹配。
 *
 * @param {number} wx @param {number} wz @param {number} seed
 * @returns {'dark_grass'|'light_grass'}
 */
export function shallowTarnGrassBlock(wx, wz, seed) {
  const v = blobNoise(wx, wz, seed + SHALLOW_TARN_GRASS_SALT, SHALLOW_GRASS_SCALE);
  return v > 0 ? 'light_grass' : 'dark_grass';
}

/**
 * 草斑块的噪声尺度（`1/0.09 ≈ 11 格`周期）。
 *
 * ⚠️ 改这个值必须重跑 `test-shallow-water-tarns.js` 的「成片分块」用例：
 * 尺度太小（>0.3）会退化成逐格噪点，太大（<0.03）会让每座高台只有一种颜色。
 */
const SHALLOW_GRASS_SCALE = 0.09;

// ==================== 地形整形 ====================

/**
 * 把一个 column 的浅水高台地形整形到布局指定的高度。
 *
 * ## 三条分支
 * | 距离（到湖心） | 内容 |
 * |---|---|
 * | `≤ LAKE_RADIUS` | 地表 = `LAKE_FLOOR_Y`，材质 `sand`；之上清空，之后由 §水体 填一格水 |
 * | `(LAKE_RADIUS, LAKE_RADIUS+BEACH_WIDTH]` | 沙滩：地表从湖底线性抬到 `BEACH_OUTER_Y`，材质 `sand` |
 * | 再往外 `SLOPE_WIDTH` | 缓坡：地表插值到平滑自然高度，材质 `grass`；圆外不动 |
 *
 * ## 水体（R3「只有一格浅水」，用户裁定水深 0.5 格）
 * 湖底**方块**在 `LAKE_FLOOR_Y = SEA_Y-1`，其顶面 = `SEA_Y`。
 * 本函数在 `y = SEA_Y` 写**一格** `water`；mesher 的 `WATER_SURFACE_SINK = 0.5`
 * 让水面顶面下沉到 `SEA_Y + 0.5` ⇒ 水深 = 0.5 格，且与海面平面 `WATER_LEVEL_OFFSET`
 * 严格共面。这与 `fillColumn` 对天然水湾的处理**完全同一机制**（用户明确要求照此实现）。
 *
 * ⚠️ **沙滩带内若自然高度低于海平面**，也要把 `(targetY, SEA_Y]` 填满水 ——
 * 否则会出现「水面平面显示而体素水缺格」的撕裂（`ocean-mask.js` 的判据读的是
 * `generateHeight`，它看不到我们的整形）。填满后沙滩带内低于海平面的部分自然成为浅滩。
 *
 * ⚠️ **`targetY` 以上必须显式写 0**：`fillColumn` 已按自然地形填过整列，
 * 不清掉就会在湖面上方留下原来的山体 —— 观感是「湖长在山里」，而方块层面
 * 完全看不出是整形漏了（地形本来就在那）。
 *
 * @param {import('../../voxel/chunk-column.js').ChunkColumn} column
 * @param {{wx: number, wz: number, lakeFloorY?: number}} anchor
 * @param {number} seed
 * @param {import('../../voxel/block-registry.js').BlockRegistry} registry
 */
export function fillShallowTarnBasin(column, anchor, seed, registry) {
  const { wx: cx, wz: cz } = anchor;
  const colMinX = column.cx * 16, colMinZ = column.cz * 16;

  // 只扫「本 column 与整形区外接方形」的交集 —— 圆外一格都不碰
  const x0 = Math.max(colMinX, Math.ceil(cx - SHALLOW_TARN_OUTER_RADIUS));
  const x1 = Math.min(colMinX + 15, Math.floor(cx + SHALLOW_TARN_OUTER_RADIUS));
  const z0 = Math.max(colMinZ, Math.ceil(cz - SHALLOW_TARN_OUTER_RADIUS));
  const z1 = Math.min(colMinZ + 15, Math.floor(cz + SHALLOW_TARN_OUTER_RADIUS));
  if (x0 > x1 || z0 > z1) return;

  const stoneId = registry.idOf('stone');
  const waterId = registry.idOf('water');
  const idCache = new Map();
  const idOfName = (name) => {
    if (idCache.has(name)) return idCache.get(name);
    const id = registry.idOf(name);
    idCache.set(name, id);
    return id;
  };
  const outer2 = SHALLOW_TARN_OUTER_RADIUS * SHALLOW_TARN_OUTER_RADIUS;

  for (let wx = x0; wx <= x1; wx++) {
    const dx = wx - cx;
    for (let wz = z0; wz <= z1; wz++) {
      const dz = wz - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 > outer2) continue;                       // 保守圆外：一定不在整形区（廉价预筛）
      // 真实整形区边界是「逐方向的 `e ≤ BEACH+SLOPE`」。
      // ⚠️ **不能只用保守圆**（v2.15）：谐波内凹的方位上保守圆会多出最多 `Σamp` 圈，
      // 那些列 `targetY` 就是自然高度 —— 但下面的「削平 + 铺地表」会**把自然地表材质刷成 grass**
      // （沙漠里会冒出一圈绿色）。故必须逐列用 `e` 精确裁。
      if (shallowTarnLakeOffset(wx, wz, seed, anchor) > BEACH_WIDTH + SLOPE_WIDTH) continue;

      const lx = wx - colMinX, lz = wz - colMinZ;
      const targetY = shallowTarnSurfaceYAt(wx, wz, seed, anchor);

      // ── 1. 削平：targetY 以上一律清空（含原山体与原水体） ──
      for (let y = targetY + 1; y < WORLD_MAX_Y; y++) {
        const idx = blockIndex(lx, y, lz);
        if (column.blocks[idx] !== 0) column.blocks[idx] = 0;
      }

      // ── 2. 地表 ──
      column.blocks[blockIndex(lx, targetY, lz)] = idOfName(shallowTarnSurfaceBlock(wx, wz, seed, anchor, targetY));

      // ── 3. 向下填实（防玩家从地表掉进洞穴/原地下水腔） ──
      // ⚠️ `carveCaves` 在 `fillColumn` **之后**挖洞 —— 不填实的话玩家挖开湖底会掉进洞里
      // （与竞技场的「地板下方补实」同一条理由；实测竞技场占地内 236 列曾在地板正下方就是空气）。
      // ⚠️ **天然水也要填成石头**：`fillColumn` 在整形前把整列按自然地形填过，
      // 其中低于海平面的部分有 `water` 方块。只填空气的话，湖底**正下方**会留一层天然水
      // → 真实页面实测 **492 列**在 `lakeFloorY-1` 是水（用户看到的是「湖底下面还有一层水」）。
      // 填成 stone 与高台地带的 `fillTarnPlateau` 同口径（那里也是「地下水也要换成石头」）。
      for (let y = WORLD_MIN_Y + 1; y < targetY; y++) {
        const idx = blockIndex(lx, y, lz);
        const cur = column.blocks[idx];
        if (cur === 0 || cur === waterId) column.blocks[idx] = stoneId;
      }

      // ── 4. 水体：湖盆恒一格，沙滩带按需填到海平面 ──
      //
      // 湖盆：`targetY = LAKE_FLOOR_Y = SEA_Y-1` ⇒ 只写 `y = SEA_Y` 这一格。
      // 沙滩/缓坡：若 `targetY < SEA_Y`，则 `(targetY, SEA_Y]` 都要有水（否则与水面平面撕裂）。
      // 若 `targetY >= SEA_Y`（多数沙滩列），这段是空转。
      for (let y = targetY + 1; y <= SEA_Y; y++) {
        column.blocks[blockIndex(lx, y, lz)] = waterId;
      }
    }
  }
}

// ==================== 五座高台 ====================

/**
 * 变体 → 光栅化所需的 AABB 半宽缓存（由产物尺寸派生，避免每次重算）。
 *
 * ⚠️ **不能缓存 `rasterizeStructure` 的产物**：它是一次性写入的，缓存数据会与
 * `structure-json.js` 的模块缓存重复（那是权威）。
 */
const PLATFORM_METRICS_CACHE = new Map();

/**
 * 在湖里光栅化五座高台（用户要求「随机排布，之间留有适当的空隙」）。
 *
 * ## y 口径（易错一格）
 * `rasterizeStructure(type, x, y, z, …)` 把**最低那层写成 y**（内部是 `y + b.y - 1`，
 * 而产物已把最低点归一化为 `b.y = 1`）。故传 `lakeFloorY = SEA_Y - 1` ⇒
 * 高台底座最低层正好落在湖底方块那一层，坐在湖底上（占掉它自己的水格）。
 *
 * ⚠️ **传 `lakeFloorY + 1` 会让整座高台悬在水面上方一格** —— 高台地带踩过完全同形的坑
 * （`plateauY` vs `plateauY + 1`），方块层面看不出，只是「台子浮在水上」。
 *
 * ## 裁剪
 * 按 AABB 与 column 相交才光栅化（每座跨多个 column，各自光栅化自己那一部分，
 * 接缝无缝拼接 —— 判定是 region 级纯函数，跨 column 结论恒一致）。
 *
 * @param {import('../../voxel/chunk-column.js').ChunkColumn} column
 * @param {{wx: number, wz: number, lakeFloorY: number}} anchor
 * @param {number} seed
 * @param {import('../../voxel/block-registry.js').BlockRegistry} registry
 * @param {(wx:number, y:number, wz:number, name:string, meta?:number) => void} setBlock
 */
export function rasterizeShallowTarnPlatforms(column, anchor, seed, registry, setBlock) {
  const layout = computeShallowTarnLayout(seed);
  const colMinX = column.cx * 16, colMaxX = colMinX + 15;
  const colMinZ = column.cz * 16, colMaxZ = colMinZ + 15;
  const marginal = 2;   // 与 `apply.js` 的 `INTERSECT_MARGIN` 同口径

  for (const p of layout) {
    const wx = Math.round(anchor.wx + p.cx);
    const wz = Math.round(anchor.wz + p.cz);
    // 轴对齐摆放（`rasterizeStructure` 无旋转参数）：AABB 半宽直接是 lo/hi 的最大值
    const halfX = Math.max(p.loX, p.hiX);
    const halfZ = Math.max(p.loZ, p.hiZ);
    if (wx + halfX + marginal < colMinX || wx - halfX - marginal > colMaxX) continue;
    if (wz + halfZ + marginal < colMinZ || wz - halfZ - marginal > colMaxZ) continue;
    rasterizeStructure(p.variant, wx, anchor.lakeFloorY, wz, setBlock, column, registry, seed, false);
  }
}

/**
 * 把已光栅化的高台里的**草标记格**按噪声刷成两种草方块。
 *
 * ## 数据流
 * 烘焙产物把素材的 `grass_block` 烘成 `GRASS_MARKER_BLOCK`（v2.15 起是 `light_grass` —— 临时标记），
 * 本函数把每一格标记格刷成 `dark_grass` / `light_grass`。
 *
 * ⚠️ **只吃标记格**：`green_wool` 烘成的 `dark_grass` 是终态，不得改写（否则 moss 区会
 * 出现浅草斑块，违反用户 2026-11-02 的「所有 moss 换成深草」）。
 *
 * ⚠️⚠️ **本函数扫的是整列（`[lakeFloorY, +64] × 256 格`），所以标记必须是「自然世界里永不出现」
 * 的方块**：曾用香草 `grass` 当标记 → 缓坡带地表就是 `grass`，普通地形的草方块被一起刷成
 * 深浅草（**用户 2026-11-02 报的真实缺陷**）。现在标记 = `light_grass`（只由烘焙产物产生）。
 *
 * ## 为什么不是烘焙期直接定深浅
 * 烘焙期处于**素材坐标系** —— 分块会固定在模型里，五座高台各自的摆放位置不同，
 * 深浅分区就会随摆放漂移；而按世界坐标算则同一片区域连成一片，与周围地形的关系也自然
 * （与高台地带的 `tarnSurfaceBlock` 用世界坐标同源）。
 *
 * ## 为什么不弄「哨兵槽 + 事后整块替换」
 * 初稿写过一个 `GRASS_PLACEHOLDER` 哨兵：`makeColumnSetter` 对未注册名字是**静默 return**
 * → 哨兵根本写不进世界（那格变 air）。v2.15 改用**已注册的真方块** `light_grass` 作标记：
 * 写得进世界、刷色后落入深浅两种草之一、漏刷时降级成浅草（观感可接受，不是空洞）。
 * 只需扫描高台覆盖的 **y 区间 × 本 column 的 256 格**。
 *
 * ## 为什么两种颜色都要显式写（v2.15）
 * 标记现在是 `light_grass`（真方块），不再是「深草的基准色」——
 * 深色那一支**也必须写 `dark_grass`**，否则标记原样留在世界里。
 * （v2.11~v2.14 靠「不写」实现深色，那是因为标记与终态同名。）
 *
 * @param {import('../../voxel/chunk-column.js').ChunkColumn} column
 * @param {{wx: number, wz: number, lakeFloorY: number}} anchor
 * @param {number} seed
 * @param {import('../../voxel/block-registry.js').BlockRegistry} registry
 * @param {(wx:number, y:number, wz:number, name:string, meta?:number) => void} setBlock
 */
export function paintShallowTarnGrass(column, anchor, seed, registry, setBlock) {
  const markerId = registry.idOf(GRASS_MARKER_BLOCK);
  if (markerId === undefined) return;
  const colMinX = column.cx * 16, colMinZ = column.cz * 16;
  const yMin = anchor.lakeFloorY;
  const yMax = Math.min(WORLD_MAX_Y - 1, anchor.lakeFloorY + SHALLOW_TARN_MAX_PLATFORM_HEIGHT);
  for (let lx = 0; lx < 16; lx++) {
    const wx = colMinX + lx;
    for (let lz = 0; lz < 16; lz++) {
      const wz = colMinZ + lz;
      // 每种草的判定与 y 无关 → 每个 (wx,wz) 只算一次（噪声是纯函数）
      let target = null;
      for (let y = yMin; y <= yMax; y++) {
        if (column.blocks[blockIndex(lx, y, lz)] !== markerId) continue;
        if (target === null) target = shallowTarnGrassBlock(wx, wz, seed);
        setBlock(wx, y, wz, target);
      }
    }
  }
}

/** 高台的最大高度（产物里最高 56 层）—— `paintShallowTarnGrass` 的扫描上界 */
const SHALLOW_TARN_MAX_PLATFORM_HEIGHT = 64;

// ==================== 缓坡草地植被（v2.22） ====================

/**
 * 缓坡草地上的单格植被（v2.22）。
 *
 * ## 用户需求（2026-11-03）
 * 「浅水高台的路基部分，如果是草地方块的话，就按照草地地图的地标植被的渲染方式，增加地表植被的
 * 渲染，包括草、花、蘑菇等，频率密度跟草地地标保持一样即可。」
 *
 * ## 判据与密度
 * - **只长在缓坡自然草地上**：`shallowTarnSurfaceBlock(...) === 'grass'`。
 *   沙滩 / 湖盆 / 水下坡（接壤水系那一侧的 `sand`）/ 整形区外**一株不长** ——
 *   用户说的是「草地方块的话」才长。
 * - **密度/物种表零拷贝**：直接调 `rollVegetation(wx, wz, 'PLAINS', seed)`。
 *   改 `vegetation.js` 的 PLAINS 表，草地地标与本图**同时变**（红线 1）——
 *   不另写第二份概率表（那会漂移出「同一片草，两套密度」）。
 * - **不种树**：用户只点名「草、花、蘑菇等」。缓坡仅 24 格宽，树会挡路并遮住高台。
 *   故只取 `roll.plant`，`roll.tree` 的抽签格返回 `null`（**根本不去长**，不是「长不出来」）。
 *
 * ## 为什么整格都算（不搞 patch / 聚类）
 * 高台地带 v1.93 用独立 salt 复刻了 PLAINS 的两项概率，那套做法在这里**不适用**：
 * 本图要的是「逐格与草地地标完全一致」，逐格转调是唯一能自动跟随上游变化的形式。
 * 实测（seed 12345 全量扫描 9985 列草地）：13.08% 的草地格长植物 ——
 * 草 5.01% / 花 5.04% / 雏菊 0.98% / 红蘑菇 0.62% / 枯木 1.42%。
 *
 * @param {number} wx @param {number} wz @param {number} seed
 * @param {{wx:number, wz:number}} anchor
 * @returns {string|null} 方块名，或 null（= 这一格不长）
 */
export function shallowTarnPlantAt(wx, wz, seed, anchor) {
  const dx = wx - anchor.wx, dz = wz - anchor.wz;
  const d = Math.hypot(dx, dz);
  // 整形区分方预筛：圆外一定不在整形区（廉价，避免每格都算谐波）
  if (d > SHALLOW_TARN_OUTER_RADIUS) return null;
  const e = d - shallowTarnLakeRadiusAt(Math.atan2(dz, dx), shallowTarnShapePhase(seed));
  // 三条带之外（湖盆内 / 沙滩内 / 缓坡之外）直接出局：只有缓坡可能是草地
  if (e <= BEACH_WIDTH || e > BEACH_WIDTH + SLOPE_WIDTH) return null;
  const targetY = shallowTarnSurfaceYAt(wx, wz, seed, anchor);
  if (shallowTarnSurfaceBlockAtOffset(wx, wz, seed, anchor, e, targetY) !== 'grass') return null;
  const roll = rollVegetation(wx, wz, 'PLAINS', seed);
  return roll.plant || null;   // 树抽签（roll.tree）**刻意不种**，见函数注释
}

/**
 * 在整片缓坡草地上撒单格植被（v2.22）。
 *
 * ## 落位
 * 植物的 y = 该列地表 **`+1`**（`surfaceY + 1`）—— 写成 `surfaceY` 会把草埋进地里
 * （高台地带的 `tarnPlantAt` 同样口径：`plateauY + 1`）。
 *
 * ## 目标格已非空气时不写
 * 沙岸旁边的缓坡上可能已经有别的方块（撒布结构边缘、其它植被路径）。
 * **后写胜会把它顶掉**，与既有巨树覆盖守卫同手法（仅当目标格是空气才写）。
 *
 * ## 性能
 * 逐列算 `shallowTarnSurfaceYAt` → 它会调 `slopeNaturalHeight`（半径 8 的均值，289 次采样）。
 * 靠 `SLOPE_CACHE` 的**精确坐标**缓存命中：调用点紧跟 `fillShallowTarnBasin`
 * （同一个 column、同一个 seed），整列 256 格几乎全命中（实测整页单测无可见增长）。
 * ⚠️ **不要把调用点搬到别的阶段**：缓存是按 column 访问顺序获益的，搬远了会退化成
 * 「每列重新探 289 次」。
 *
 * @param {import('../../voxel/chunk-column.js').ChunkColumn} column
 * @param {{wx: number, wz: number, lakeFloorY: number}} anchor
 * @param {number} seed
 * @param {import('../../voxel/block-registry.js').BlockRegistry} registry
 * @param {(wx:number, y:number, wz:number, name:string, meta?:number) => void} setBlock
 */
export function plantShallowTarnGrass(column, anchor, seed, registry, setBlock) {
  const colMinX = column.cx * 16, colMinZ = column.cz * 16;
  void registry;    // 判据全在纯函数里（不需要查 id）；保留形参与同目录其它函数一致
  for (let lx = 0; lx < 16; lx++) {
    const wx = colMinX + lx;
    for (let lz = 0; lz < 16; lz++) {
      const wz = colMinZ + lz;
      const plant = shallowTarnPlantAt(wx, wz, seed, anchor);
      if (plant === null) continue;
      const y = shallowTarnSurfaceYAt(wx, wz, seed, anchor) + 1;
      if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) continue;
      if (column.blocks[blockIndex(lx, y, lz)] !== 0) continue;   // 已占用：不顶掉别人
      setBlock(wx, y, wz, plant);
    }
  }
}

// ==================== 供测试复用的导出 ====================

export { SLOPE_SMOOTH_RADIUS, SHALLOW_GRASS_SCALE };
export { LAKE_RADIUS, BEACH_WIDTH, SLOPE_WIDTH, LAKE_FLOOR_Y, BEACH_OUTER_Y };
