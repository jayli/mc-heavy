// src/gen/structures/scatter.js — 结构撒布判定 + 代码生成结构（M2 撒布欠账补齐）
//
// 三条路径的算法语义移植自 mc-lite WorldWorker.js（只取语义/概率/门控，不照搬架构）：
// ① 城市撒布：flowerBed(:881) / house(:892) / tallWell(:1132) / pavilion(:1136)
// ② 城市外 house(:1108)：seed+4 千分之一 + chunk 内圈门控
// ③ 城市外大型静态结构(:136 resolveLargeStaticStructureType)
//
// **Worker 同构**：本文件不得 import three、不得自建 Worker（红线 8/10）。
//
// ## 与 mc-lite 的两处有意偏离（勿照 mc-lite 原样改回）
//
// **① `Math.random()` → `seededRandom()`**（generateCodeHouse）。mc-lite 的
// `generateStructure('house')` 用 `Math.random()` 选墙体材质、屋顶材质、烟囱位置 ——
// 照搬会让同一 seed 两次生成的 house 配色不同，违反红线 2（世界由 seed 确定性生成，
// 何时何地重算结果一致）。本仓库改用 `seededRandom(x, z, seed+salt)`，salt 各取一个
// 独立值避免材质间相关。
//
// **② 运行期 Set 门控 → 调用方传入的局部 Set**。mc-lite 的防重叠依赖 chunk 内累积的
// `cityFlowerBedCenters` / `cityPavilionFootprintCells` / `cityFillerHouseCenters` 等
// 运行期 Set；mc-heavy 是 column 级确定性生成、Worker 间无共享状态（红线 2/3/8）。
// 这些 Set 在 mc-lite 里**本就是 chunk 局部的**（每 chunk 独立生成、不跨 chunk 累积），
// 故由调用方（apply.js）在单个 column 的双循环里用局部 Set 累积后传入 → 语义等价，
// 且遍历顺序固定（lx/lz 升序）保证确定性。

import { seededRandom, getBiome } from '../noise.js';
import { getCityInfo, isPointNearCityStructure } from './city-layout.js';
import { rollCityTree, rollVegetation } from './vegetation.js';
import { generateHeight, surfaceTypeOfBiome } from '../terrain.js';
import { getCityFinalSurfaceY } from './landmarks.js';
import { SCATTER_FOOTPRINT, REGION_SIZE } from './region-config.js';
import { SEA_Y } from '../../voxel/constants.js';

/**
 * 城市撒布概率口径（mc-lite WorldWorker.js:91-93）。
 * pavilion / tallWell **不是独立常量**，是从 flowerBed 派生的倍数 —— 关系式断言钉住
 * 这条派生关系（硬编码数值会让改动后测试仍 PASS，testing-policy §2.5 陷阱②）。
 *
 * ⚠️ **有意偏离 mc-lite 密度（基值减半）**：mc-lite 的 0.0005 在 mc-heavy 会让 cutout
 * 通道 reserved 峰值涨到 1,943,845（323 列奔跑场景，实测）> 默认容量 1,800,000 → 触发
 * `setGeometrySize` ×1.5 扩容 → GPU 顶点缓冲 170MB，撞破 §4.10 的 150MB 冻结预算。
 * 基值减半后 pavilion/tallWell 按派生关系自动跟随减半（446→~223 / 77→~38），cutout 峰值
 * 回到容量内。`house` 不降（opaque 通道 + 代码生成，不吃 cutout 预算）。
 */
export const CITY_SCATTER_CHANCE = Object.freeze({
  flowerBed: 0.00025,        // seed+823（mc-lite 0.0005，减半以守 cutout 预算）
  house: 0.0007,             // seed+812（城市 filler house，代码生成；不降）
  // seed+824。⚠️ **v2.2 从 flowerBed×6 降到 ×3**（用户 2026-10-28：「pavilion 在 city 中
  // 出现的概率降低一倍」= 减半）。**有意偏离 mc-lite 的 ×6** —— 上游 WorldWorker.js:92-93
  // 是 pavilion=×6 / tallWell=×3，现在两者同档。
  // 理由：pavilion 的占地（10×6）与 flowerBed 同尺寸但方块密度高得多（128 vs 97），
  // 是 city cutout 通道的压力来源之一；且它常与 tallWell 挤在同一片街区。
  // 实测（seed 12345，region[0,0] 城市）：174 → 约 87 个；叠加下面的真实包围盒互斥后 ≈68 个。
  pavilion: 0.00025 * 3,
  tallWell: 0.00025 * 3,     // seed+826（CITY_TALL_WELL_CHANCE = flowerBed×3）
});

/**
 * 城市外撒布概率口径（mc-lite WorldWorker.js:136-152 / :1108）。
 *
 * ⚠️ **有意偏离 mc-lite 密度（大 JSON 减半）**：desertVillage(1181 方块)/uglyHouse(719)
 * 是 GEN 光栅化的大头 —— mc-lite 概率让 `structure-gen` fixture 的 16 column 并行 p95
 * 从 HEAD 的 6.5~7.1ms 涨到 8.5~9.2ms（实测），撞破 §4.2 的 8ms 冻结预算。两个大 JSON
 * 概率减半后光栅化成本回到预算内。`tank`/`house` 不降：tank/house 占地小或代码生成，
 * 不是 p95 大头。
 *
 * ⚠️ **desertPyramid 于 v1.77 按用户要求降到原来的 1/3**（「沙漠神殿现在出现的概率我觉得
 * 有点太高了」）。这条**不是**性能代偿（它本来就不降，方块少、吃预算的不是它）——
 * 纯观感标定。实测 seed=12345 / region ±6：326 → **109** 个（≈ 1/3）。
 * ⚠️ **它现在比 desertVillage 更稀**（0.0000533 < 0.00008）—— 用户只要求降神殿、
 * 村落不动，故「大 JSON 更稀」这条旧关系在此**刻意倒置**。`test-scatter.js` 的那条
 * 断言已按新的实测关系改写（不是删除，也不是放宽数值）。
 */
export const OUTSIDE_SCATTER_CHANCE = Object.freeze({
  house: 0.001,             // seed+4（代码生成小房子，草地上的那个；不降）
  ship: 0.001,              // seed+13（沉船，深海限定；不降 —— 见下）
  // mc-lite 是 0.00016；v1.77 按用户要求 ÷3（见上注：纯观感标定，非性能代偿）
  desertPyramid: 0.00016 / 3,
  desertVillage: 0.00008,   // seed+26（mc-lite 0.00016，减半以守 genP95 预算）
  uglyHouse: 0.00004,       // seed+23（mc-lite 0.00008，减半以守 genP95 预算）
  tank: 0.0001,             // seed+5（grass 地表限定；不降，占地小）
});

/**
 * ship 的深海门控高度（mc-lite WorldWorker.js:988 `h < -6`）。
 *
 * 比海平面 `SEA_Y = -2` 低 4 格 → 桅杆顶（y+4）仍在水下 1~5 格，「沉船」名副其实。
 * 这是与陆地撒布**相反**的水位门控：陆地撒布要求 `h > SEA_Y`（v1.37 的有意偏离），
 * ship 要求 `h < -6`。两者互斥，在 `computeScatterCandidates` 里用同一个 `h` 分流。
 */
export const SHIP_DEEP_SEA_Y = -6;

/**
 * 城市 filler house 的占地面高差上限（格）。
 *
 * house 的落位取 5×5 占地**最低**城市地表（保证不悬空，代价是向高的一侧微埋）。
 * 但城市过渡带是**台阶式**的：占地内高差可以到 15 格（台阶每格 -1，累加）——
 * 那种位置落哪里都会一半悬空、一半埋没，应当**不撒**。
 * 实测 5 seed 的占地面高差：中位 0 / p90 = 1 / p99 = 3 / 最大 15；取 3 时剔除 0~2 个/seed，
 * 最大残留埋深 ≤ 3 格（略陷，远好于飘空）。
 */
export const HOUSE_MAX_SURFACE_SPAN = 3;

/** 撒布 seed salt（mc-lite 的 seed+N 偏移，照搬） */
const SALT = Object.freeze({
  flowerBed: 823, houseCity: 812, pavilion: 824, tallWell: 826,
  houseOutside: 4, ship: 13, desertPyramid: 25, desertVillage: 26, uglyHouse: 23, tank: 5,
  // generateCodeHouse 的材质/烟囱（mc-lite 用 Math.random，本仓库改 seededRandom 需自备 salt）
  wallMat: 300, roofMat: 301, chimney: 302, chimneyPos: 303,
});

/**
 * 城市撒布（house / pavilion / tallWell）的「避开树」门控半径
 * （**有意偏离 mc-lite 的 8 / 10 / 7 / 9**）。
 *
 * mc-lite 查的 `cityTreeCenters` 只记录**放置成功**的树，而它的树有半径 7 互斥门控
 * （`isNearRecordedCenter(cityTreeCenters, ..., 7)`）→ 实际树密度约 0.44%。
 * mc-heavy 的 `apply.js` 阶段 3 对城市树**没有互斥**（`rollCityTree` 命中即放置），
 * 故树密度实测 **1.39%** —— 比 mc-lite 高约 3 倍。
 *
 * 照搬 mc-lite 的半径会让门控把撒布结构**全部挡掉**（实测 seed=12345，各半径保留率）：
 *
 * | 半径 | house | pavilion | tallWell |
 * |---|---|---|---|
 * | 0 | 100% | 100% | 100% |
 * | 1 | 86% | 89% | 88% |
 * | **2** | **72%** | **70%** | **66%** |
 * | 3 | 33% | 48% | 48% |
 * | 5 | 9% | 21% | 13% |
 * | 7（mc-lite tallWell） | — | 2% | **3%** |
 * | 8/9（mc-lite house/pavilion） | **0%** | **0%** | **0%** |
 *
 * 半径 2 保留约 2/3，既保住「避开树」语义又让功能生效（半径 8/9 → 城市里一个都没有，
 * 补的功能等于没补）。勿照 mc-lite 改回大半径。
 */
const TREE_GATE_RADIUS_SMALL = 2;  // 普通树（mc-lite house 8 / pavilion-tallWell 5~7）
const TREE_GATE_RADIUS_LARGE = 2;  // 大树（mc-lite house 10 / tallWell 8）

/**
 * chunk 内圈门控（mc-lite WorldWorker.js:775 `x >= 3 && x <= 12 && z >= 3 && z <= 12`）。
 *
 * 为什么需要：撒布结构会跨 chunk 边界，在 chunk 边缘放置会被切割成两半（mc-lite 用
 * createStructureTask + owner 机制处理跨 chunk，mc-heavy 用 AABB 裁剪光栅化 —— 但内圈
 * 门控同时保证撒布点离边界 ≥3，让多数结构完整落在单 column 内）。
 *
 * 传入世界坐标，内部按 mod 16 归一化到局部坐标（负坐标须先加 16 再取模，否则 JS 的
 * `%` 对负数返回负值 → 判据失真）。
 */
export function safeForStructure(wx, wz) {
  const lx = ((wx % 16) + 16) % 16;
  const lz = ((wz % 16) + 16) % 16;
  return lx >= 3 && lx <= 12 && lz >= 3 && lz <= 12;
}

/**
 * 点是否在城市 bounds 内（mc-lite 的 `inCity` 判据）。
 *
 * 城市内外的**地形高度口径不同**：城内是 `generateCity` 整形后的地表
 * （`getCityFinalSurfaceY`，中心被压平、过渡带被抬升），城外是自然地形高度
 * （`generateHeight`）。拿城外的口径给城内落点，就会算出「房子飘在空中」
 * （实测悬空 37%~90%，最高 15 格）。
 *
 * 上游 mc-lite 的列循环是 `if (inCity) { 城市分支 } else { 城市外撒布 }` **互斥**
 * （WorldWorker.js:793 / :1084-1086），所以它天然不会出现这种错配。本仓库移植时
 * 城市外撒布是独立的候选层、两路都跑，必须显式排除 —— 这就是本函数的存在理由。
 */
export function inCityBounds(wx, wz, city) {
  return wx >= city.minX && wx <= city.maxX && wz >= city.minZ && wz <= city.maxZ;
}

/**
 * 城市 filler house 的落位高度（`y`，地基格 = `y - 1`）。
 *
 * = 5×5 占地内**最低**城市地表 + 1。取最低而不是中心点，是因为城市地表在 5×5 占地内
 * 有 1~2 格起伏（过渡带台阶）：按中心落位时四周低一格的地基就悬空 1 格（用户报告的症状）。
 * 取最低的代价是向高的一侧微埋（实测最坏 3 格）—— 埋一点远好过飘起来。
 *
 * 两个前置门控，命中任一则返回 `null`（这个位置放不了房子）：
 *  - **占地必须全在城市 bounds 内**：出界那格的地面是自然地形（可高实测 15 格），
 *    按城内最低地表落位会把房子埋进去。
 *  - **占地内地表高差 ≤ `HOUSE_MAX_SURFACE_SPAN`**：高差更大是过渡带陡台阶，
 *    落哪里都会一半悬空、一半埋没。
 *
 * @param {Object} cityInfo `getCityInfo` 结果（spread 了 city，含 minX/maxX/minZ/maxZ）
 * @returns {number|null}
 */
export function houseAnchorY(wx, wz, cityInfo, seed) {
  // 用**候选点的** cityInfo 拿边界（getCityInfo 已 spread 了 city 的 bounds 字段），
  // 占地内逐格重新取 info：靠边时部分格子会在 bounds 外（getCityInfo 返回 null）。
  const fp = SCATTER_FOOTPRINT.house;
  let lowest = Infinity, highest = -Infinity;
  for (let dx = -fp.halfX; dx <= fp.halfX; dx++) {
    for (let dz = -fp.halfZ; dz <= fp.halfZ; dz++) {
      const info = getCityInfo(wx + dx, wz + dz, cityInfo);
      if (!info) return null;                       // 占地出界
      const surfaceY = getCityFinalSurfaceY(wx + dx, wz + dz, info, seed);
      if (surfaceY < lowest) lowest = surfaceY;
      if (surfaceY > highest) highest = surfaceY;
    }
  }
  if (highest - lowest > HOUSE_MAX_SURFACE_SPAN) return null;   // 陡台阶
  return lowest + 1;
}

/**
 * 城市撒布判定（mc-lite 城市分支 :881/:892 + 后置填充 :1132/:1136 的合并纯函数）。
 *
 * 返回**优先级最高的单个类型**：mc-lite 四条判定各自独立、理论上一个点可同时命中多个，
 * 但概率都是 1e-4 量级 → 同点命中两个的概率 ≈ 0，故合并为单一返回不改变实际行为，
 * 且让判定结果可比较（确定性断言需要）。优先级按 mc-lite 的判定顺序：
 * flowerBed → house →（后置填充）tallWell → pavilion。
 *
 * @param {number} wx
 * @param {number} wz
 * @param {Object} cityInfo getCityInfo 结果（spread 了 city，含 placements）
 * @param {number} surfaceY 城市地表高度 —— 调用方（apply.js）用 `getCityFinalSurfaceY` 算。
 *   mc-lite 的 `surfaceY` 来自 `CityMap.generate()` 的**返回值**，mc-heavy 的
 *   `getCityInfo` 不带这个字段，故必须由调用方传入（本函数保持不读体素数据的纯函数）。
 * @param {number} seed
 * @returns {{type: string, x: number, y: number, z: number}|null}
 *   y = surfaceY + 1（结构底层面块落在地表上一格，mc-lite 口径）。
 *   **不含空间净空检查** —— 那要读方块数据，由调用方（apply.js）在光栅化前做，
 *   保持本函数为不读体素数据的纯函数（跨 column 确定性）。
 *
 * ## 为什么没有「同类中心已占用」参数（勿照直觉加回去）
 *
 * mc-lite 的防重叠靠 chunk 局部运行期 Set（`cityFlowerBedCenters` 等）累积，**跨 chunk
 * 不生效**（每 chunk 重新创建）。若把它移植成参数，判定结果就会依赖调用方传入的 Set →
 * **同一个点在不同 column 的扫描范围里得出不同结论** → 跨 column 光栅化时接缝断裂
 * （一半结构在一个 column、另一半被判定为「不撒」而缺失）。实测：给同一坐标传空 Set
 * 与传含该点的 Set，判定结果相反。
 *
 * 取舍依据（实测计算）：mc-lite 单 chunk(256 格) 内同类命中 ≥2 的概率仅
 * flowerBed **0.75%** / house **1.42%** —— 防重叠的收益是极低概率下的「两个花坛挨太近」，
 * 代价是「半个亭子」。故选择纯函数（跨 column 结论恒一致，接缝无缝拼接），
 * 与 mc-lite 跨 chunk 的既有行为一致。
 */
export function rollCityScatter(wx, wz, cityInfo, surfaceY, seed) {
  const y = surfaceY + 1;

  // flowerBed：mc-lite :881 —— 只在城市核心区（transitionFactor===0），远离主建筑
  if (cityInfo.transitionFactor === 0 &&
      seededRandom(wx, wz, seed + SALT.flowerBed) < CITY_SCATTER_CHANCE.flowerBed &&
      !isPointNearCityStructure(wx, wz, cityInfo, 1)) {
    return { type: 'flowerBed', x: wx, y, z: wz };
  }

  // house（城市 filler）：mc-lite :892 —— 无 transitionFactor 门控（与 flowerBed 不同），
  // 但要远离主建筑/树。mc-lite 用运行期 Set 查树中心，本仓库改为**扫邻域调用 rollCityTree**
  // —— 树落点本就是 (wx,wz,seed) 的纯函数，扫邻域即可确定性复现「附近有没有树」，
  // 无需运行期 Set，故跨 column 结论恒一致。
  if (seededRandom(wx, wz, seed + SALT.houseCity) < CITY_SCATTER_CHANCE.house &&
      !isPointNearCityStructure(wx, wz, cityInfo, 4) &&
      !nearCityTree(wx, wz, seed, TREE_GATE_RADIUS_SMALL, TREE_GATE_RADIUS_LARGE)) {
    const anchorY = houseAnchorY(wx, wz, cityInfo, seed);
    // `null` = 占地伸出城市 bounds 或占地内地表高差过大 → 这个位置放不了房子。
    // **不回落到 surfaceY**（那正是悬空的来源）；返回 null 让候选不产出，与其它类型的
    // 门控未通过同语义（一个点最多一个结构）。
    if (anchorY !== null) return { type: 'house', x: wx, y: anchorY, z: wz };
  }

  // tallWell：mc-lite :1132（后置填充先跑 tallWell）—— 候选点来自 cityCoreCandidates
  // （只收 transitionFactor===0），故此处同样门控核心区。mc-lite canPlaceCityTallWell
  // （:739-752）的门控含 flowerBed + 五种树；本仓库用邻域扫描确定性复现两者。
  if (cityInfo.transitionFactor === 0 &&
      seededRandom(wx, wz, seed + SALT.tallWell) < CITY_SCATTER_CHANCE.tallWell &&
      !isPointNearCityStructure(wx, wz, cityInfo, 6) &&
      !nearCityFlowerBed(wx, wz, cityInfo, seed, 5) &&
      !nearCityTree(wx, wz, seed, TREE_GATE_RADIUS_SMALL, TREE_GATE_RADIUS_LARGE)) {
    return { type: 'tallWell', x: wx, y, z: wz };
  }

  // pavilion：mc-lite :1136（后置填充后跑 pavilion）。canPlaceCityPavilion（:669-680）
  // 的门控含 flowerBed + 五种树，同样用邻域扫描复现。
  if (cityInfo.transitionFactor === 0 &&
      seededRandom(wx, wz, seed + SALT.pavilion) < CITY_SCATTER_CHANCE.pavilion &&
      !isPointNearCityStructure(wx, wz, cityInfo, 6) &&
      !nearCityFlowerBed(wx, wz, cityInfo, seed, 8) &&
      !nearCityTree(wx, wz, seed, TREE_GATE_RADIUS_SMALL, TREE_GATE_RADIUS_LARGE)) {
    return { type: 'pavilion', x: wx, y, z: wz };
  }

  return null;
}

/**
 * 邻域内是否有城市树（mc-lite `isNearRecordedCenter(cityTreeCenters/cityTallTreeCenters)`
 * 的确定性等价）。
 *
 * mc-lite 用两个运行期 Set；本仓库改为**扫邻域调用 `rollCityTree`** —— 树落点本就是
 * `(wx, wz, seed)` 的纯函数，扫一遍即可确定性复现「附近有没有树」，且任意 column 扫到
 * 同一点得同一结论（跨 column 一致，接缝不断裂）。
 *
 * 一次扫描覆盖两个半径（mc-lite：普通树 8 / 大树 10），避免扫两遍。
 * `rollCityTree` 返回优先级最高的树，`type==='big'` 即 mc-lite 的 tallTree（seed+801/804）。
 *
 * 成本可控：本函数只在概率门控**已通过**后才调用（0.0007 量级），故每 column 只跑几次。
 */
function nearCityTree(wx, wz, seed, radiusSmall, radiusLarge) {
  const r = Math.max(radiusSmall, radiusLarge);
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dz));
      const roll = rollCityTree(wx + dx, wz + dz, seed);
      if (!roll.tree) continue;
      if (roll.tree.type === 'big') { if (dist <= radiusLarge) return true; }
      else if (dist <= radiusSmall) return true;
    }
  }
  return false;
}

/**
 * 邻域内是否有 flowerBed（mc-lite `isNearRecordedCenter(cityFlowerBedCenters)` 的确定性等价）。
 *
 * ⚠️ **不能递归调用 `rollCityScatter`** —— 那样每个邻域点又会触发 tree 扫描
 * （21×21×730 次 seededRandom），成本爆炸（实测：单城市约 4200 万次 sin）。
 * 这里只复现 flowerBed 分支自己的条件（概率 + 核心区 + 远离主建筑），语义等价且极廉价。
 */
function nearCityFlowerBed(wx, wz, cityInfo, seed, radius) {
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      const nx = wx + dx, nz = wz + dz;
      const info = getCityInfo(nx, nz, cityInfo);
      if (!info || info.transitionFactor !== 0) continue;
      if (seededRandom(nx, nz, seed + SALT.flowerBed) >= CITY_SCATTER_CHANCE.flowerBed) continue;
      if (isPointNearCityStructure(nx, nz, info, 1)) continue;
      return true;
    }
  }
  return false;
}

/**
 * 城市外撒布判定（mc-lite resolveLargeStaticStructureType，WorldWorker.js:136）。
 *
 * mc-lite 的 `occupied` 由同点的植被判定链推出（cactus seed+21 / dead_bush seed+24 /
 * gunman seed+0）；本仓库的 `rollVegetation` DESERT 分支已含 cactus+dead_bush，调用方
 * 据此传入。**gunman / rover 是实体（M6/M7 范畴），本次未搬** —— 故 occupied 比 mc-lite
 * 少一层（mc-lite 的 gunman 会占用点位），属已知细微差异。
 *
 * @returns {string|null} 'desertPyramid'|'desertVillage'|'uglyHouse'|'tank'|'house'|null
 */
export function rollOutsideScatter(wx, wz, biome, surfaceType, occupied, seed) {
  if (!safeForStructure(wx, wz) || occupied) return null;

  if (biome === 'DESERT') {
    if (seededRandom(wx, wz, seed + SALT.desertPyramid) < OUTSIDE_SCATTER_CHANCE.desertPyramid) {
      return 'desertPyramid';
    }
    if (seededRandom(wx, wz, seed + SALT.desertVillage) < OUTSIDE_SCATTER_CHANCE.desertVillage) {
      return 'desertVillage';
    }
    if (seededRandom(wx, wz, seed + SALT.uglyHouse) < OUTSIDE_SCATTER_CHANCE.uglyHouse) {
      return 'uglyHouse';
    }
    return null;
  }

  // tank：mc-lite :1108 之外的 grass 地表分支（resolveLargeStaticStructureType 末段）
  if (surfaceType === 'grass' && seededRandom(wx, wz, seed + SALT.tank) < OUTSIDE_SCATTER_CHANCE.tank) {
    return 'tank';
  }

  // house：mc-lite :1108 —— 草地上的小房子（代码生成，非 JSON）
  if (surfaceType === 'grass' && seededRandom(wx, wz, seed + SALT.houseOutside) < OUTSIDE_SCATTER_CHANCE.house) {
    return 'house';
  }

  return null;
}

/**
 * ship 沉船判定（mc-lite WorldWorker.js:988）。
 *
 * **与陆地撒布的关键差异（勿「补齐」门控）**：mc-lite 的 ship 门控只有
 * `h < -6` + 概率 + `safeForStructure` —— **不看 biome、不看 occupied**。实测 109 个命中里
 * 有 11 个（10%）带植被、分布在 4 个 biome（AZALEA/FOREST/PLAINS/SWAMP，无 DESERT ——
 * DESERT 高度被 `h*0.5+2` 抬高，不会低于 -6），所以给它加 biome/occupied 门控会让命中数
 * 从 109 掉到 98，且沙漠永远不会出现沉船。
 *
 * `safeForStructure` 由调用方（`computeScatterCandidates`）在外层循环先行判定，
 * 本函数只负责 h + 概率两个判据 —— 保持纯函数、不重复判定（红线 1）。
 *
 * @param {number} wx
 * @param {number} wz
 * @param {number} h 地形高度（调用方已算好；ship 落点 = h + 1）
 * @param {number} seed
 * @returns {boolean}
 */
export function rollShipScatter(wx, wz, h, seed) {
  return h < SHIP_DEEP_SEA_Y &&
    seededRandom(wx, wz, seed + SALT.ship) < OUTSIDE_SCATTER_CHANCE.ship;
}

// ==================== region 级候选发现（与 computeSkyCandidates 同构）====================

/**
 * 撒布类型 → 紧凑数组里的索引（`computeScatterCandidates` 输出 Int32Array 用）。
 * 城市 filler house 与城市外 house 共用 `'house'`（几何同为 `generateCodeHouse`）。
 */
export const SCATTER_TYPES = Object.freeze([
  'flowerBed', 'house', 'tallWell', 'pavilion',
  'desertPyramid', 'desertVillage', 'uglyHouse', 'tank', 'ship',
]);
const TYPE_INDEX = Object.freeze(SCATTER_TYPES.reduce((m, t, i) => { m[t] = i; return m; }, {}));

/**
 * 代码生成的撒布类型（无 JSON 文件，走 `generateCodeXxx`）—— **单一权威**。
 *
 * 预载清单（`SCATTER_JSON_TYPES`）、`apply.js` 的预载循环与光栅化分支、以及 `check:data`
 * 门禁的 `jsonTypes` 都从它派生（红线 1）。⚠️ 勿把派生基准写成「排除 house」的字面量 ——
 * 那样加第二个代码生成类型（如 ship）时门禁会要求它有 JSON 映射 + 磁盘文件 → 误报；
 * 反过来若某类型没被识别为代码生成 → 走 `rasterizeStructure` → cache 未命中 →
 * **结构静默消失**（方块层面看不出差别，实测踩过同类坑）。
 */
export const CODE_GENERATED_SCATTER_TYPES = Object.freeze(['house', 'ship']);

/**
 * 撒布类型里需要 fetch JSON 的子集（代码生成的类型无 JSON）。
 *
 * **从 `SCATTER_TYPES` 与 `CODE_GENERATED_SCATTER_TYPES` 派生，不另写一份清单** ——
 * 手写第二份清单会漂移（红线 1），漂移后果是某类型没被预载 → cache 未命中 →
 * `rasterizeStructure` 静默 return → 结构消失。
 */
export const SCATTER_JSON_TYPES = Object.freeze(
  SCATTER_TYPES.filter((t) => !CODE_GENERATED_SCATTER_TYPES.includes(t)));

/** 候选紧凑数组 stride：[x, y, z, typeIndex] */
export const SCATTER_STRIDE = 4;

/** 内部判定入口：自己算 cityInfo + surfaceY（供邻域扫描递归调用） */
function rollCityScatterAt(wx, wz, city, seed) {
  const info = getCityInfo(wx, wz, city);
  if (!info) return null;
  return rollCityScatter(wx, wz, info, getCityFinalSurfaceY(wx, wz, info, seed), seed);
}

/**
 * 候选是否为本 footprint 内的「首个」—— mc-lite 运行期 footprint Set 的**确定性等价**。
 *
 * mc-lite 用 `cityPavilionFootprintCells` / `cityTallWellFootprintCells`（chunk 局部 Set）
 * 做「占地预订」，跨 chunk 不生效。本仓库改为**字典序最小者胜出**：footprint 邻域内若存在
 * 坐标更小的同类型候选，则本点被抑制。这是 `(wx, wz, seed)` 的纯函数 →
 * 任意 column 扫到同一点得同一结论（跨 column 一致，接缝不断裂）。
 */
function isFirstInFootprint(wx, wz, type, city, seed) {
  const fp = SCATTER_FOOTPRINT[type];
  if (!fp) return true;
  // ⚠️ **扫描半径是 `±half`，不是 `±2×half`** —— 即使它的语义严格讲该扫 2×half
  // （两个相距 ≤2×half 的同类候选本来就重叠），也不能改：
  // 实测把 tallWell（抑制范围 24×20）的窗口放到 ±2×half 会把井从 70 个砂到 **29 个**（seed 12345），
  // 这同时是一个观感回归与 cutout 预算的重标定事件。
  // 故 **pavilion 不走这条函数**，它的同类互斥改用 `filterPavilionOverlaps` 的真实包围盒
  // 全局过滤（它没有历史遗留的抑制范围，改起来零副作用）。tallWell 的同类重叠保留为
  // 已知问题（本次不动，已在计划文档「明确不做」里点名）。
  for (let dx = -fp.halfX; dx <= fp.halfX; dx++) {
    for (let dz = -fp.halfZ; dz <= fp.halfZ; dz++) {
      if (dx === 0 && dz === 0) continue;
      const nx = wx + dx, nz = wz + dz;
      if (nx > wx || (nx === wx && nz >= wz)) continue; // 只看字典序更小的
      if (rollCityScatterAt(nx, nz, city, seed)?.type === type) return false;
    }
  }
  return true;
}

/**
 * 两个撒布候选的**真实包围盒**是否相交（v2.2）。
 *
 * ⚠️ **必须用 `SCATTER_FOOTPRINT[t].real`，不得用 `halfX/halfZ`**：后者是「抑制/裁剪范围」，
 * 可以大于真实占地（`tallWell` 是 24/20 vs 真实 5/4）。混用后果实测：pavilion×tallWell
 * 从真实的 16 对膨胀到 157 对，pavilion 保留量从 151 跌到 52。
 *
 * 与 `landmarks.js` 的候选层让路同口径（那里也是用真实占地判），不另造一套几何语义。
 */
function scatterBoxesOverlap(ax, az, aType, bx, bz, bType) {
  const a = SCATTER_FOOTPRINT[aType]?.real;
  const b = SCATTER_FOOTPRINT[bType]?.real;
  if (!a || !b) return false;
  return ax + a.maxX >= bx + b.minX && bx + b.maxX >= ax + a.minX &&
         az + a.maxZ >= bz + b.minZ && bz + b.maxZ >= az + a.minZ;
}

/**
 * **pavilion 的真实包围盒互斥**（v2.2，用户 2026-10-28：「渲染的时候注意不要跟其他实体有重叠」）。
 *
 * 输入**全部城市候选**（含 pavilion 自己），按 `(wx, wz)` 规范顺序贪心：一个 pavilion 只有在
 * 不与任何**已保留的非 pavilion 候选**、也不与**已保留的 pavilion** 相交时才保留。
 *
 * ## 为何是后置全局过滤，而不是逐点判定
 *
 * 逐点判定只能看到「自己周围」的邻域，而邻域扫描会递归触发 `rollCityScatter`（每条卡在
 * 概率门后才跑树扫描）—— 实测单城市会从 40ms 爆到秒级（`nearCityFlowerBed` 的注释里有
 * 同类踩坑：4200 万次 sin）。全局过滤只需一次 O(n²) 的纯算术比较（n≈250 → 6 万次），
 * 且仍然是 `(regionX, regionZ, seed, city)` 的纯函数 → 任意 column 算出的集合逐位相同
 * （跨 column 不变式不破）。
 *
 * ## 为何非 pavilion 候选优先
 *
 * 它们是**先于** pavilion 判定的类型（`rollCityScatter` 的优先级顺序是 flowerBed → house →
 * tallWell → pavilion），且 flowerBed/tallWell 有「互不靠近」的既有门控。让后判的 pavilion
 * 让位保持现状语义，不会反过来改变其它类型的密度。
 *
 * @param {Array<{x:number,z:number,type:string}>} all 全部城市候选（顺序无所谓）
 * @returns {Array<{x:number,z:number,type:string}>} 过滤后的候选（保持非 pavilion 全量）
 */
export function filterPavilionOverlaps(all) {
  // 规范顺序：非 pavilion 先入位（顺序不影响结果 —— 它们之间不做互斥），
  // pavilion 按 (wx, wz) 字典序依次决定，保证结果与输入顺序无关。
  const kept = all.filter((c) => c.type !== 'pavilion');
  const pavilions = all.filter((c) => c.type === 'pavilion')
    .sort((a, b) => (a.x - b.x) || (a.z - b.z));
  for (const p of pavilions) {
    let blocked = false;
    for (const q of kept) {
      if (scatterBoxesOverlap(p.x, p.z, 'pavilion', q.x, q.z, q.type)) { blocked = true; break; }
    }
    if (!blocked) kept.push(p);
  }
  return kept;
}

/**
 * 计算单个 region 的撒布候选（紧凑 Int32Array，避免对象数组随 GEN 任务重复 structured-clone）。
 *
 * **候选发现在 region 层算一次**（`structure-index.js` 的 DR-13：各 GEN Worker 只做
 * rasterize，不重复跑候选发现），与 `computeSkyCandidates` 同构。
 *
 * @param {Object|null} city 本 region 的城市布局（只有 region [0,0] 非 null）
 * @returns {{cityScatter: Int32Array, outsideScatter: Int32Array}}
 *
 * ## 两处与 mc-lite 的口径差异（勿照 mc-lite 改回）
 *
 * **① 城市候选不按 region 裁剪**：城市 bounds 可跨 region（实测 seed=12345 时
 * bounds=[0,566]×[-166,400]，横跨 region [0,0] 与 [1,0]），而 city 布局只在 region [0,0]
 * 的 layout 里。故城市候选**全量**算在 region [0,0]，靠 `neighborRegionKeys` 的查询域
 * 机制自然投递给需要的 column（region [1,0] 的 column 查询域含 [0,0]；region [2,0] 不含
 * 但城市 x 上界 566 < 800，本就无候选）。若按 region 裁剪，跨区那部分城市装饰物会永久丢失。
 *
 * **② 城市外候选不在这里做城市排除**：只有持有 city 的 region [0,0] 拿得到 city bounds，
 * 而城市 bounds 可跨 region（实测 seed=12345 bounds=[0,566]×[-166,400]，maxX 566 已落入
 * region [1,0]）—— 那里落入城内的候选在这里判不了。故**唯一权威在 apply.js 阶段 2.7**
 * （它拿得到 cityLayout，且只对它生效）：那里用同一个 `inCityBounds` 剔除。
 * 不剔除的后果：城市外的落点用自然地形高度、而城内地面已被 generateCity 整形 → 房子飘在
 * 空中（实测悬空率 37%~90%，最高 15 格，用户报告的症状）。上游 mc-lite 是
 * `if (inCity) {...} else {城市外撒布}` **互斥**（WorldWorker.js:793 / :1084-1086）。
 */
export function computeScatterCandidates(regionX, regionZ, seed, city) {
  const cityOut = [];
  /** 城市候选的临时对象表（pavilion 真实包围盒互斥需要全局视角，见下方过滤） */
  const cityCands = [];
  const outsideOut = [];
  const baseX = regionX * REGION_SIZE, baseZ = regionZ * REGION_SIZE;

  // ---- ① 城市撒布（只在持有 city 布局的 region）----
  if (city) {
    for (let wx = city.minX; wx <= city.maxX; wx++) {
      for (let wz = city.minZ; wz <= city.maxZ; wz++) {
        const info = getCityInfo(wx, wz, city);
        if (!info) continue;
        // 廉价概率预门控：四个概率全不中才跳过（避免为 22 万点全算 surfaceY）
        if (seededRandom(wx, wz, seed + SALT.flowerBed) >= CITY_SCATTER_CHANCE.flowerBed &&
            seededRandom(wx, wz, seed + SALT.houseCity) >= CITY_SCATTER_CHANCE.house &&
            seededRandom(wx, wz, seed + SALT.tallWell) >= CITY_SCATTER_CHANCE.tallWell &&
            seededRandom(wx, wz, seed + SALT.pavilion) >= CITY_SCATTER_CHANCE.pavilion) continue;
        const r = rollCityScatter(wx, wz, info, getCityFinalSurfaceY(wx, wz, info, seed), seed);
        if (!r) continue;
        // footprint 互斥（tallWell 的抑制范围 24×20 足够大，逐点判定即可）。
        // ⚠️ **pavilion 不在这里判**（v2.2）：它需要与**跨类型**及全量同类做真实包围盒互斥，
        // 逐点邻域扫描会把 21 对同类重叠全部漏掉（详见 `isFirstInFootprint` 的半径注释与
        // `filterPavilionOverlaps`），统一在循环外后置过滤。
        if (r.type === 'tallWell' && !isFirstInFootprint(wx, wz, r.type, city, seed)) continue;
        cityCands.push({ x: r.x, y: r.y, z: r.z, type: r.type });
      }
    }
    // pavilion 真实包围盒互斥（v2.2）：与所有非 pavilion 候选、以及已保留的 pavilion 不相交。
    // 纯函数（结果与候选遍历顺序无关）→ 跨 column 结论恒一致。
    for (const c of filterPavilionOverlaps(cityCands)) {
      cityOut.push(c.x, c.y, c.z, TYPE_INDEX[c.type]);
    }
  }

  // ---- ② 城市外撒布（逐 region，裁剪到本 region）----
  const endX = baseX + REGION_SIZE, endZ = baseZ + REGION_SIZE;
  for (let wx = baseX; wx < endX; wx++) {
    for (let wz = baseZ; wz < endZ; wz++) {
      // chunk 内圈门控先行（廉价，砍掉 61% 的点）
      if (!safeForStructure(wx, wz)) continue;
      // 廉价概率预门控：沙漠三条 + grass 两条全不中才跳过（避免为 16 万点全算 biome）
      const desertHit =
        seededRandom(wx, wz, seed + SALT.desertPyramid) < OUTSIDE_SCATTER_CHANCE.desertPyramid ||
        seededRandom(wx, wz, seed + SALT.desertVillage) < OUTSIDE_SCATTER_CHANCE.desertVillage ||
        seededRandom(wx, wz, seed + SALT.uglyHouse) < OUTSIDE_SCATTER_CHANCE.uglyHouse;
      const grassHit =
        seededRandom(wx, wz, seed + SALT.tank) < OUTSIDE_SCATTER_CHANCE.tank ||
        seededRandom(wx, wz, seed + SALT.houseOutside) < OUTSIDE_SCATTER_CHANCE.house;
      // ship 的深海门控与陆地撒布**相反**（要求 h < -6），故必须并入同一个预门控，
      // 否则 ship 永远走不到 generateHeight（陆地撒布的水下门控会把它挡掉）。
      const shipHit = seededRandom(wx, wz, seed + SALT.ship) < OUTSIDE_SCATTER_CHANCE.ship;
      if (!shipHit && !desertHit && !grassHit) continue;

      // `h` 提前算：ship 的深海门控与陆地撒布的水下门控都需要它（只算一次，分流共用）
      const h = generateHeight(wx, wz, seed);

      // ---- 水下路径：ship 沉船（门控 h < -6，不看 biome/occupied）----
      // shipHit 已在预门控验过概率，rollShipScatter 是判定权威（它同样验概率 + h，
      // 概率部分幂等 → 实际只生效 h 门控）。一个点最多一个结构（与 rollOutsideScatter
      // 的单一返回语义一致）。
      if (shipHit && rollShipScatter(wx, wz, h, seed)) {
        outsideOut.push(wx, h + 1, wz, TYPE_INDEX.ship);
        continue;
      }

      // ---- 陆地路径：水下不撒（**有意偏离 mc-lite**：mc-lite 无此门控，会把房子放进水里。
      // mc-heavy 地形水下面积大，照搬会产出大量水下房子 —— 观感明显错误）----
      if (h <= SEA_Y) continue;

      // 到这里才付昂贵代价（biome + 植被 occupied）。放在水下门控**之后**是有意的：
      // 水下点本来就要丢弃，不该为它们算 biome/植被（实测 ship 让水下点变多，
      // 提前算会白付代价）。陆地撒布的判定逻辑与结果不变。
      const biome = getBiome(wx, wz, seed);
      const occupied = !!rollVegetation(wx, wz, biome, seed).plant;
      const type = rollOutsideScatter(wx, wz, biome, surfaceTypeOfBiome(biome), occupied, seed);
      if (!type) continue;
      outsideOut.push(wx, h + 1, wz, TYPE_INDEX[type]);
    }
  }

  return { cityScatter: Int32Array.from(cityOut), outsideScatter: Int32Array.from(outsideOut) };
}

/**
 * 代码生成的小房子（mc-lite WorldWorker.js:2946 `generateStructure('house')`）。
 *
 * 几何逐条照搬：5×5 stone 地基（y-1）→ perimeter 3 层墙（门洞在 +z 侧中部）→
 * 两侧 ±x 的 j=0 列做窗（y 墙体 / y+1 glass_block / y+2 墙体）→ 3 层递减屋顶 →
 * y+5 脊 3 格 → 1/3 概率屋顶烟囱 → bookbox(x-1,y,z-1) + chest(x+1,y,z-1)。
 *
 * ⚠️ 材质与烟囱用 `seededRandom` 而非 mc-lite 的 `Math.random()`（见文件头偏离①）。
 *
 * @param {(wx:number, y:number, wz:number, name:string, meta?:number) => void} setBlock
 */
export function generateCodeHouse(x, y, z, setBlock, seed) {
  const wallMat = seededRandom(x, z, seed + SALT.wallMat) < 0.33 ? 'bricks' : 'planks';
  const roofMat = seededRandom(x, z, seed + SALT.roofMat) < 0.5 ? 'dark_planks' : 'oak_planks';

  // 地基 5×5 stone（y-1 层）
  for (let i = -2; i <= 2; i++) {
    for (let j = -2; j <= 2; j++) setBlock(x + i, y - 1, z + j, 'stone');
  }

  // 墙体：perimeter 3 层。门洞 = i===0 && j===2；窗 = ±x 侧 j===0 列
  for (let i = -2; i <= 2; i++) {
    for (let j = -2; j <= 2; j++) {
      if (Math.abs(i) !== 2 && Math.abs(j) !== 2) continue;
      if (i === 0 && j === 2) continue; // 门洞
      if ((i === -2 || i === 2) && j === 0) {
        setBlock(x + i, y, z + j, wallMat);
        setBlock(x + i, y + 1, z + j, 'glass_block');
        setBlock(x + i, y + 2, z + j, wallMat);
      } else {
        for (let h = 0; h < 3; h++) setBlock(x + i, y + h, z + j, wallMat);
      }
    }
  }

  // 屋顶：3 层递减实心（mc-lite 每层 [-2+h, 2-h] 全填），同时记录屋顶方块供烟囱选址
  const roofBlocks = [];
  for (let h = 0; h < 3; h++) {
    for (let i = -2 + h; i <= 2 - h; i++) {
      for (let j = -2 + h; j <= 2 - h; j++) {
        setBlock(x + i, y + 3 + h, z + j, roofMat);
        if (h === 2 || Math.abs(i) === 2 - h || Math.abs(j) === 2 - h) {
          roofBlocks.push({ x: x + i, y: y + 3 + h, z: z + j });
        }
      }
    }
  }

  // 脊：y+5 的 j=-1..1 三格
  for (let j = -1; j <= 1; j++) {
    setBlock(x, y + 5, z + j, roofMat);
    roofBlocks.push({ x, y: y + 5, z: z + j });
  }

  // 烟囱：1/3 概率，从「低于 y+5 的屋顶方块」里选址（mc-lite 优先 lowerRoofBlocks）
  if (seededRandom(x, z, seed + SALT.chimney) < 0.33) {
    const lower = roofBlocks.filter((b) => b.y < y + 5);
    const pool = lower.length > 0 ? lower : roofBlocks;
    if (pool.length > 0) {
      const pos = pool[Math.floor(seededRandom(x, z, seed + SALT.chimneyPos) * pool.length) % pool.length];
      setBlock(pos.x, pos.y + 1, pos.z, 'chimney');
    }
  }

  // 室内家具（mc-lite :2990-2991）。solid 属性由 registry 决定，setBlock 只写方块
  setBlock(x - 1, y, z - 1, 'bookbox');
  setBlock(x + 1, y, z - 1, 'chest');
}

/**
 * 代码生成的沉船（mc-lite WorldWorker.js:2987-2997 `generateStructure('ship')`）。
 *
 * 几何逐条照搬：7×5 船体（dz -3..3 × dx -2..2）→ 外围一圈双层（y+1 `wood` / y+2 `planks`）
 * + 内部甲板（y `planks`）→ 桅杆 5 格 `wood`（y..y+4）→ 货箱 `chest` 在 (x, y+1, z+2)。
 *
 * **与 `generateCodeHouse` 的差异**：mc-lite 的 ship 几何**不含 `Math.random`**
 * （house 的材质/烟囱才是随机的），故 ship 无需 seededRandom 替代 —— 天然确定性。
 *
 * 落点 y = h + 1（深海地表上一格）。门控 h < -6 使桅杆顶（y+4）仍在水下 1~5 格
 * （海平面 SEA_Y = -2），是真正的「沉船」而非浮在水面的船。
 *
 * @param {(wx:number, y:number, wz:number, name:string, meta?:number) => void} setBlock
 */
export function generateCodeShip(x, y, z, setBlock) {
  // 船体：外围一圈双层（wood/planks），内部甲板单层 planks
  for (let dz = -3; dz <= 3; dz++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (Math.abs(dx) === 2 || Math.abs(dz) === 3) {
        setBlock(x + dx, y + 1, z + dz, 'wood');
        setBlock(x + dx, y + 2, z + dz, 'planks');
      } else {
        setBlock(x + dx, y, z + dz, 'planks');
      }
    }
  }
  // 桅杆 5 格（mc-lite :2995）
  for (let i = 0; i < 5; i++) setBlock(x, y + i, z, 'wood');
  // 货箱（mc-lite :2996）
  setBlock(x, y + 1, z + 2, 'chest');
}
