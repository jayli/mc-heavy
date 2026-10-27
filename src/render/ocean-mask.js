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
import { REGION_SIZE } from '../gen/structures/region-config.js';
import { isTarnZone, computeTarnZone, TARN_POOL_RADIUS } from '../gen/structures/tarn-zone.js';

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
 * 世界坐标 → {"本点所在地带水池", null}（CPU 侧判据；GPU 侧同构实现见 `ocean.js` 的 `inTarnPool`）。
 *
 * 这是「池面在哪些地方渲染」的**唯一权威**（红线 1）：
 *   · `ocean.js` 的 TSL 着色器是同构实现（TSL 调不了 JS 函数），数值常量必须从本模块与
 *     `tarn-zone.js` 读，**不得在着色器里另写一份**；
 *   · `game.js` 的帧循环用它算 uniform（按玩家移动阈值节流）；
 *   · 单测（`test-tarn-water.js`）直接验它。
 *
 * ⚠️ **判据是按 region 而不是按距离**：先由世界坐标反推 region，再问 `isTarnZone`。
 * 这样「走出去再回来」与「首次到达」得到同一个答案（不依赖缓存/遍历顺序）。
 *
 * ⚠️ **`waterY` 是体素水**那一层**的 y**（= `plateauY`），不是水面平面的 y。
 * 水面平面在 `waterY + 0.5`（与 `ocean.js` 的 `WATER_LEVEL_OFFSET` 同口径）——
 * 两者差 0.5 是载荷性的：`mesher.js` 的水面经 `WATER_SURFACE_SINK = 0.5` 下沉后
 * 顶面正好在 `waterY + 0.5`，平面贴上去才不露出一条缝。
 *
 * @param {number} x @param {number} z @param {number} seed
 * @returns {{cx:number, cz:number, radius:number, waterY:number}|null}
 */
export function tarnPoolAt(x, z, seed) {
  const rx = Math.floor(x / REGION_SIZE);
  const rz = Math.floor(z / REGION_SIZE);
  if (!isTarnZone(rx, rz, seed)) return null;
  const lay = computeTarnZone(rx, rz, seed);       // `plateauY` 的唯一来源（几何常量）
  if (!lay) return null;
  // waterY = 体素水那一层的 y；水面平面在 waterY + 0.5
  return { cx: lay.cx, cz: lay.cz, radius: TARN_POOL_RADIUS, waterY: lay.plateauY };
}

/**
 * 该点是否落在地带水池圆内（`ocean.js` 的 GPU 侧用同一判据）。
 * @param {number} x @param {number} z @param {number} seed
 * @returns {boolean}
 */
export function isPointInTarnPool(x, z, seed) {
  const pool = tarnPoolAt(x, z, seed);
  if (!pool) return false;
  const dx = x - pool.cx, dz = z - pool.cz;
  return dx * dx + dz * dz <= pool.radius * pool.radius;
}

/**
 * 该点是否渲染水面平面（CPU 版判据；GPU 版见 `ocean.js` 的 `oceanMask`）。
 * @param {number} x @param {number} z @param {number} seed
 * @param {{minX:number,maxX:number,minZ:number,maxZ:number}} [cityBounds]
 * @returns {boolean}
 */
export function isOceanMasked(x, z, seed, cityBounds = OCEAN_MASK_NO_CITY) {
  // 城市门控优先：城市是被压平的陆地，一律不渲染（与阈值无关）
  if (inCityBounds(x, z, cityBounds)) return false;
  const off = OCEAN_MASK_OFFSET;
  return maskTerrainHeight(x, z, seed) < OCEAN_MASK_THRESHOLD
    || maskTerrainHeight(x + off, z, seed) < OCEAN_MASK_THRESHOLD
    || maskTerrainHeight(x - off, z, seed) < OCEAN_MASK_THRESHOLD
    || maskTerrainHeight(x, z + off, seed) < OCEAN_MASK_THRESHOLD
    || maskTerrainHeight(x, z - off, seed) < OCEAN_MASK_THRESHOLD;
}
