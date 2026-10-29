// src/render/ocean-mask.js — 水面遮罩判据的唯一权威（纯函数版）
//
// 为什么单独成文件：判据有两处消费 —— 本文件的 CPU 版（单测可直接断言）与
// `ocean.js` 的 TSL 版（GPU 求值，单测测不到）。阈值/取样纵深/bounds 这些参数是数值，
// 两边 import 同一份；高度公式因 CPU/GPU 异构只能同构实现，但数值常量同样共享
// （`gen/terrain.js` 的 `TERRAIN_HEIGHT_PARAMS` 与 `gen/noise.js` 的 `BIOME_PARAMS`）。
// 各写一份会漂移出「单测说该渲染、GPU 实际没渲染」的撕裂。
//
// **遮罩高度 = 真实生成高度 `generateHeight`**（不是 mc-lite 的近似噪声）。
// 这样判据与 `fillColumn` 的水体判据同源 → 阈值可以直接取水体判据，不需要「floor 余量」
// 这类补偿项。mc-lite 用近似噪声（不含 biome 调整）是因为它把遮罩写在着色器里图省事，
// 代价是判据与真实地形偏差 +1.39~+6.71（DESERT/SWAMP 的 biome 调整没算进去）。
//
// **阈值口径**：`h < SEA_Y` ⟺ `h <= SEA_Y-1`（`generateHeight` 返回整数），
// 正是 `fillColumn` 的水体方块判据。实测三方案对照（10 seed × 城外 70080 采样点）：
//   近似+阈值-0.8（mc-lite 原值）→ 假水面 19.3% / 漏判真水 0.2%
//   真实高度+阈值 SEA_Y（本实现）→ 假水面  3.5% / 漏判真水 0.0%
//   真实高度+阈值 SEA_Y-1        → 假水面  0.2% / 漏判真水 13.1%（阈值取严会漏掉浅水湖）
// 残留的 3.5% 全是五点取样（±3.5 纵深）的**有意侵入**，判据偏差 = 0。
//
// **城市门控**：城市 bounds 内一律不渲染。`getBiome` 不含 CITY（它由结构系统叠加），
// 所以遮罩算不出 CITY 压平调整 —— 城市把地面压到接近海平面
// （`CITY_MIN_SURFACE_Y` = SEA_Y+1 = -1），而水面平面在 SEA_Y+0.5 = -1.5
// → 挖 2 格洞底顶面降到 -2 就低于水面平面，玩家在**陆地**上挖出一汪假水。
//
// ⚠️ **门控的已知代价（实测，勿当作零成本）**：bounds 内并非全无水体 —— 实测城内残留
// 水格 16600（10 seed 稀疏采样），其中 56 格暴露（水格之上无遮挡，seed=1234 占 50 格）。
// 成因是架构差异：mc-lite 的分支链 `if (inCity) → else if (h < wLvl)` 让城市与填水体
// **互斥**，城内永不填水；mc-heavy 是 `fillColumn` 无条件填整列 + `generateCity` 覆写，
// 覆写不到的水体残留。该缺口已一并修掉（`landmarks.js` `generateCity` 岩石层下沿补齐），
// 修完后 bounds 内零暴露水体 → 门控零误伤。
import { SEA_Y } from '../voxel/constants.js';
import { generateHeight } from '../gen/terrain.js';

/** 遮罩阈值（= SEA_Y；等价于水体方块判据 `h <= SEA_Y-1`，推导见文件头注释） */
export const OCEAN_MASK_THRESHOLD = SEA_Y;

/**
 * 遮罩取样纵深（mc-lite `Engine.js:672` 的 `offsetVal=3.5`）。
 * 这是「水面侵入地形的纵深」的来源：单点判定会让水陆边界锯齿化，
 * 五点取样（中心 + 四方向各 3.5 格）让水面沿海岸向内侵一小圈。
 */
export const OCEAN_MASK_OFFSET = 3.5;

/**
 * 门控哨兵：空 bounds（minX > maxX → 判定恒假 → 门控关闭）。
 * 未接线 city bounds 时（如测试环境无 Game 装配）用这个，不误伤任何点。
 */
export const OCEAN_MASK_NO_CITY = Object.freeze({ minX: 1, maxX: 0, minZ: 1, maxZ: 0 });

/**
 * 门控哨兵：空湖区（`radius <= 0` → 判定恒假 → 门控关闭）。
 * 与 `OCEAN_MASK_NO_CITY` 同一手法，供未接线或被重置时报安全值。
 */
export const OCEAN_MASK_NO_LAKE = Object.freeze({ cx: 0, cz: 0, radius: 0 });

/**
 * 点是否落在**浅水高台的整形区**内（含 `margin` 格外延）。
 *
 * ## 为什么需要这个门控（v2.14，用户报告「水面的波纹并没有覆盖全部」）
 * 上面的地形高度判据读的是 `generateHeight`（**自然**地形），而浅水高台的整形把湖底
 * 压到了 `SEA_Y-1` —— **自然高度根本没有变**。于是：
 *   · 自然高度恰好 < `SEA_Y` 的格子 → 水面平面渲染 ✓（有波纹）
 *   · 自然高度 ≥ `SEA_Y` 的格子（湖盆的大多数）→ 遮罩关掉平面 ✗
 *     → 只剩体素水的**静态顶面**（无波纹、无高光）—— 这就是「波纹只盖了一部分」。
 *
 * ⇒ 湖区内必须**强制渲染**水面平面，与地形高度无关。
 * ⚠️ 这与城市门控是**相反方向**：城市是「强制不渲」（压平的陆地），湖区是「强制渲」。
 *
 * ## 传入的半径是**整形区最大半径**（v2.15）
 * 湖岸不再是正圆（径向谐波），而 TSL 里重算谐波必然是第二份实现 → 改成传一个**保守圆**：
 * `SHALLOW_TARN_OUTER_RADIUS`（最大湖岸半径 + 沙滩 + 缓坡）。这在语义上是**正确**的，
 * 不是绕过问题：整形区内「淹不淹」由本地图自己的 target 决定 ——
 *   · 干燥列：地表恒 `≥ SEA_Y`（顶面 ≥ -1），平面在 -1.5 → 被深度测试遮掉；
 *   · 淹水列：体素水面顶面也是 -1.5 → 与平面共面（既有机制）。
 * ⇒ 放大只会让平面在**陆地下面**多画几片（不可见），但能盖住接壤水系的水下方坡。
 *
 * @param {number} x @param {number} z
 * @param {{cx:number, cz:number, radius:number}} lake 湖心 + **整形区最大半径**
 * @param {number} [margin=0] 外延（用于五点取样时把边界包住）
 * @returns {boolean}
 */
export function inLakeCircle(x, z, lake, margin = 0) {
  if (!lake || !(lake.radius > 0)) return false;
  const dx = x - lake.cx, dz = z - lake.cz;
  const r = lake.radius + margin;
  return dx * dx + dz * dz <= r * r;
}

/**
 * 遮罩用的地形高度 = 真实生成高度（与 `fillColumn` 同源，见文件头注释）。
 * @param {number} x @param {number} z @param {number} seed
 * @returns {number} 整数高度
 */
export function maskTerrainHeight(x, z, seed) {
  return generateHeight(x, z, seed);
}

/** 点是否落在城市 bounds 内（与 `getCityInfo` 的 bounds 判定同一不等式，勿另写一份） */
export function inCityBounds(x, z, cityBounds) {
  if (!cityBounds) return false;
  return x >= cityBounds.minX && x <= cityBounds.maxX
    && z >= cityBounds.minZ && z <= cityBounds.maxZ;
}

/**
 * 该点是否渲染水面平面（CPU 版判据；GPU 版见 `ocean.js` 的 `oceanMask`）。
 * @param {number} x @param {number} z @param {number} seed
 * @param {{minX:number,maxX:number,minZ:number,maxZ:number}} [cityBounds]
 * @param {{cx:number,cz:number,radius:number}} [lake] 浅水高台的湖盆圆（强制渲）
 * @returns {boolean}
 */
export function isOceanMasked(x, z, seed, cityBounds = OCEAN_MASK_NO_CITY, lake = OCEAN_MASK_NO_LAKE) {
  // 湖区门控**优先于一切**：湖底被整形压到 SEA_Y-1，而 `generateHeight` 看不到这件事
  // → 必须无条件渲染水面平面（否则只剩体素水的静态顶面，无波纹）。
  // ⚠️ 五点取样会把湖岸外一圈也拉进来 —— 那是**有意的**：让平面与沙滩带重叠，
  // 否则岸边会出现一圈「体素水顶面 / 平面」的硬边界（与 OCEAN_MASK_OFFSET 同一理由）。
  if (inLakeCircle(x, z, lake, OCEAN_MASK_OFFSET)) return true;
  // 城市门控：城市是被压平的陆地，一律不渲染（与阈值无关）
  if (inCityBounds(x, z, cityBounds)) return false;
  const off = OCEAN_MASK_OFFSET;
  return maskTerrainHeight(x, z, seed) < OCEAN_MASK_THRESHOLD
    || maskTerrainHeight(x + off, z, seed) < OCEAN_MASK_THRESHOLD
    || maskTerrainHeight(x - off, z, seed) < OCEAN_MASK_THRESHOLD
    || maskTerrainHeight(x, z + off, seed) < OCEAN_MASK_THRESHOLD
    || maskTerrainHeight(x, z - off, seed) < OCEAN_MASK_THRESHOLD;
}
