// src/gen/structures/sky-structures.js — M2-7 空中结构：悬浮空岛 + 云层（设计文档 §4.2）
// 移植 mc-lite Island.js / Cloud.js 的可见世界语义：候选与方块只由 (seed, chunk 坐标) 推导，
// 无 Math.random、无 structureCenters、无运行期跨 chunk 补刷。
// 覆盖层序（mc-lite 口径）：先写 Y=55 单云层（Task 3 追加 Y=35 云簇），再写空岛，
// 最后写空岛顶层的天空树（writeSkyTrees，岛体与树几何上不重叠）；
// 岛与单云相交处岛体覆盖云。所有写入裁剪到当前 column。
// Worker 同构：本文件不得 import three。
import { noise, seededRandom } from '../noise.js';
import { WORLD_MIN_Y, WORLD_MAX_Y } from '../../voxel/constants.js';
import { makeColumnSetter } from './landmarks.js';
import { generateTree } from './vegetation.js';

/** 每 region 的来源 chunk 数（REGION_SIZE 400 / 16） */
const CHUNKS_PER_REGION = 25;

/** 单云层高度（mc-lite WorldWorker.js:1125 Cloud.generate(wx, 55, wz)） */
export const SINGLE_CLOUD_Y = 55;
/** 连通云簇高度（mc-lite WorldWorker.js:1177 Cloud.generateCluster(startX, 35, ...)） */
export const CLOUD_CLUSTER_Y = 35;

/**
 * 天空树的逐格生成概率。
 *
 * ⚠️ **有意偏离 mc-lite**：mc-lite `Island.js:48` 是 `Math.random() < 0.1`（10%），
 * 本仓取**其一半 0.05**（2026-09-29 用户指令「生成密度减少到原来的一半」）。
 * 只保留「逐格独立判定」的分布语义，密度按产品口径减半 —— 观感从 mc-lite 的
 * 「连绵叶团」变为「疏朗树木」。**改这个值会连带改变三处实测标定值**（勿只改数字）：
 * ① E2E `sky-structures.spec.mjs` 的 `treeWood`（0.1 时 =2，0.05 时 =1，余量极薄 →
 *    若变 0 须按 spec §6.1.1 处置②**扩大扫描窗口**，不得放宽成 `>= 0`）；
 * ② `test-structure-gen.html` 的含结构 genP95（树量减半 → 该门实测值下降）；
 * ③ 三通道 `reservedV` 占用百分比（树进 opaque 通道 → 占用随之下降）。
 *
 * **导出常量 = 单一权威（红线 1）**：实现与测试都从这里读，不各写字面量
 * （同 M6 `ZOMBIE_MOVING_EPSILON` 两层共用的教训）—— 故改这一处，测试期望自动跟随。
 */
export const SKY_TREE_CHANCE = 0.05;

/**
 * 天空树判定的 salt。
 *
 * ⚠️ **不能取 59**：`sky-structures.js` 注释写「云簇 frontier 每步 seed+58」，容易读成
 * 只占用 58，实际 `computeClusterCells` 的 step 上界 = size-1，而
 * `size = 30 + floor(r*21) ∈ [30,50]` → **云簇实际占用 58..107 连续区间**。
 * 同理 `landmarks.js:239` 的 `seed+302+y`（y∈[-32,96)）占用 270..397，
 * `terrain.js:100` 的 `seed+100+k`（k=2..12）占用 102..112。
 * 113 是程序化扫描（展开全部派生区间，234 个已占用 salt）后、紧跟空中结构族
 * （岛 50..57 / 云簇 58..107）的第一个空闲值；113..199 有 87 个连续空闲位备用。
 * **新增随机量前须重跑该扫描，不能 grep 字面量。**
 */
export const SKY_TREE_SALT = 113;

/**
 * 岛层半径（mc-lite Island.js:41 的逐层收窄判据 `floor(radius * (y/height)^0.7)`）。
 * **单一权威（红线 1）**：`writeIslands` 的岛体逐层圆与 `writeSkyTrees` 的树基点圆
 * 都从这里读。两处各写一份会漂移出「树长在岛体之外悬空」或「岛顶层有格却没被扫到」
 * 的撕裂（肉眼可见但难归因）。
 * @param {number} radius 岛的最大水平半径（候选里的 radius）
 * @param {number} y 当前层相对岛底的偏移（0..height）
 * @param {number} height 岛的总高度（层数）
 * @returns {number} 该层的圆半径
 */
export function islandLayerRadius(radius, y, height) {
  return Math.floor(radius * Math.pow(y / height, 0.7));
}

/**
 * 计算单个 region 的空中候选（紧凑数组，避免对象数组随 GEN 任务重复 structured-clone）。
 * salt 口径与 mc-lite chunkRandom 一致：岛候选/底部Y +50/+51（半径/高度 +56/+57 替代原未
 * seed 化的 Math.random），云簇候选/起点X/起点Z/大小 +52/+53/+54/+55。
 * @returns {{
 *   skyIslands: Int32Array,   // stride 5: [originCx, originCz, bottomY, radius, height]
 *   cloudClusters: Int32Array // stride 5: [originCx, originCz, startX, startZ, size]
 * }}
 */
export function computeSkyCandidates(regionX, regionZ, seed) {
  const islands = [];
  const clusters = [];
  const baseCx = regionX * CHUNKS_PER_REGION;
  const baseCz = regionZ * CHUNKS_PER_REGION;
  for (let i = 0; i < CHUNKS_PER_REGION; i++) {
    for (let j = 0; j < CHUNKS_PER_REGION; j++) {
      const cx = baseCx + i, cz = baseCz + j;
      if (seededRandom(cx, cz, seed + 50) < 0.08) {
        islands.push(
          cx, cz,
          40 + Math.floor(seededRandom(cx, cz, seed + 51) * 30),
          5 + Math.floor(seededRandom(cx, cz, seed + 56) * 5),
          5 + Math.floor(seededRandom(cx, cz, seed + 57) * 3),
        );
      }
      if (seededRandom(cx, cz, seed + 52) < 0.20) {
        clusters.push(
          cx, cz,
          cx * 16 + Math.floor(seededRandom(cx, cz, seed + 53) * 16),
          cz * 16 + Math.floor(seededRandom(cx, cz, seed + 54) * 16),
          30 + Math.floor(seededRandom(cx, cz, seed + 55) * 21),
        );
      }
    }
  }
  return { skyIslands: Int32Array.from(islands), cloudClusters: Int32Array.from(clusters) };
}

/**
 * Y=55 噪声单云层（mc-lite TerrainGen.shouldGenerateCloud：noise(x,z,0.03) > 1.2）。
 * 无条件写目标格，岛后写覆盖。
 */
export function writeSingleCloudLayer(column, seed, registry) {
  const setBlock = makeColumnSetter(column, registry);
  for (let lx = 0; lx < 16; lx++) {
    for (let lz = 0; lz < 16; lz++) {
      const wx = column.cx * 16 + lx, wz = column.cz * 16 + lz;
      if (noise(wx, wz, seed, 0.03) > 1.2) setBlock(wx, SINGLE_CLOUD_Y, wz, 'cloud');
    }
  }
}

/** 云层统一入口：Y=55 单云层 + Y=35 连通云簇（均在空岛之前写，岛后写覆盖）。 */
export function writeClouds(column, skyCandidates, seed, registry) {
  writeSingleCloudLayer(column, seed, registry);
  writeCloudClusters(column, skyCandidates, seed, registry);
}

/**
 * 单个云簇的完整形状（mc-lite Cloud.generateCluster：frontier 游走，四邻接）。
 * Math.random 替换为确定性 hash：每步选点用 `seed+58+step`（step=已放置块数）。
 * @returns {Array<[number, number]>} size 个 [x, z]（含起点）
 */
export function computeClusterCells(startX, startZ, size, seed) {
  const placed = new Set();
  const cells = [];
  const frontier = [[startX, startZ]];
  const key = (x, z) => `${x},${z}`;
  let step = 0;
  while (placed.size < size && frontier.length > 0) {
    const idx = Math.floor(seededRandom(startX, startZ, seed + 58 + step) * frontier.length);
    const [fx, fz] = frontier.splice(idx, 1)[0];
    const k = key(fx, fz);
    if (!placed.has(k)) {
      placed.add(k);
      cells.push([fx, fz]);
      for (const [nx, nz] of [[fx + 1, fz], [fx - 1, fz], [fx, fz + 1], [fx, fz - 1]]) {
        if (!placed.has(key(nx, nz))) frontier.push([nx, nz]);
      }
      step++;
    }
  }
  return cells;
}

/**
 * Y=35 连通云簇（30..50 块）。每列完整重建簇形状，裁剪由 setBlock 承担，
 * 跨 column 逐格一致（无运行期补刷）。
 * @param {Array<{skyIslands: Int32Array, cloudClusters: Int32Array}>} skyCandidates
 */
export function writeCloudClusters(column, skyCandidates, seed, registry) {
  const setBlock = makeColumnSetter(column, registry);
  const minX = column.cx * 16, maxX = minX + 15;
  const minZ = column.cz * 16, maxZ = minZ + 15;
  for (const { cloudClusters } of skyCandidates) {
    for (let i = 0; i < cloudClusters.length; i += 5) {
      const startX = cloudClusters[i + 2], startZ = cloudClusters[i + 3], size = cloudClusters[i + 4];
      // 保守 AABB：簇最大直线延伸 ≤ size
      if (startX + size < minX || startX - size > maxX ||
          startZ + size < minZ || startZ - size > maxZ) continue;
      for (const [x, z] of computeClusterCells(startX, startZ, size, seed)) {
        setBlock(x, CLOUD_CLUSTER_Y, z, 'cloud');
      }
    }
  }
}

/**
 * 空岛写入（mc-lite Island.generate：逐层圆，顶层 sky_grass、其余 sky_stone；
 * 不迁移宝箱；天空树由 `writeSkyTrees` 在岛体之后写）。
 * 仅遍历水平 AABB 相交候选；无条件写岛体目标格。
 * @param {Array<{skyIslands: Int32Array, cloudClusters: Int32Array}>} skyCandidates
 */
export function writeIslands(column, skyCandidates, registry) {
  const setBlock = makeColumnSetter(column, registry);
  const minX = column.cx * 16, maxX = minX + 15;
  const minZ = column.cz * 16, maxZ = minZ + 15;
  for (const { skyIslands } of skyCandidates) {
    for (let i = 0; i < skyIslands.length; i += 5) {
      const centerX = skyIslands[i] * 16 + 8, centerZ = skyIslands[i + 1] * 16 + 8;
      const bottomY = skyIslands[i + 2], radius = skyIslands[i + 3], height = skyIslands[i + 4];
      if (centerX + radius < minX || centerX - radius > maxX ||
          centerZ + radius < minZ || centerZ - radius > maxZ) continue;
      for (let y = 0; y <= height; y++) {
        const blockY = bottomY + y;
        if (blockY < WORLD_MIN_Y || blockY >= WORLD_MAX_Y) continue;
        const r = islandLayerRadius(radius, y, height);
        const name = (y === height) ? 'sky_grass' : 'sky_stone';
        for (let dx = -r; dx <= r; dx++) {
          for (let dz = -r; dz <= r; dz++) {
            if (dx * dx + dz * dz > r * r) continue;
            setBlock(centerX + dx, blockY, centerZ + dz, name);
          }
        }
      }
    }
  }
}

/**
 * 天空树写入（mc-lite `Island.js:44-50`：岛顶层逐格 10% 概率长 skyTree）。
 *
 * 层序：在 `writeIslands` **之后**调用 —— 树基点 = `topY + 1`（岛体最高格是 `topY`），
 * 几何上不重叠，故层序不影响结果；但保持「岛体先、树后」与 mc-lite 的生成顺序一致
 * （mc-lite 在写岛体格的同一个循环里长树）。
 *
 * ⚠️ **AABB 门控必须比岛体宽 2 格**（spec §2.4，本次最易出 bug 的点）：
 * 树冠从基点向外扩 ±2（`vegetation.js:22-29` 的 lx/lz 循环），故树的水平足迹是
 * `centerX ± (radius + 2)`。若沿用岛体的 `± radius` 门控，会出现「某 column 与岛体
 * AABB 不相交、却有树冠落入」→ 该 column 被 continue 跳过 → **树冠在相邻 column 上
 * 断裂缺角**。方块层面岛体完全正常，肉眼只看到「岛边缘的树缺了一角」，很难归因。
 *
 * 跨 column 逐格一致的保证：判定（`seededRandom(wx, wz, ...)`）与生成
 * （`generateTree` 内部 `treeRand(lx, lz, ...)`）**都只吃世界坐标** → 同一格在任何
 * column 的生成过程中结果完全相同；写入裁剪由 `setBlock`（`makeColumnSetter`）承担。
 *
 * @param {import('../../voxel/chunk-column.js').ChunkColumn} column
 * @param {Array<{skyIslands: Int32Array, cloudClusters: Int32Array}>} skyCandidates
 * @param {number} seed
 * @param {*} registry
 */
export function writeSkyTrees(column, skyCandidates, seed, registry) {
  const setBlock = makeColumnSetter(column, registry);
  const minX = column.cx * 16, maxX = minX + 15;
  const minZ = column.cz * 16, maxZ = minZ + 15;
  for (const { skyIslands } of skyCandidates) {
    for (let i = 0; i < skyIslands.length; i += 5) {
      const centerX = skyIslands[i] * 16 + 8, centerZ = skyIslands[i + 1] * 16 + 8;
      const bottomY = skyIslands[i + 2], radius = skyIslands[i + 3], height = skyIslands[i + 4];
      // 树冠外扩 ±2 → 门控放宽 2（见函数注释）
      if (centerX + radius + 2 < minX || centerX - radius - 2 > maxX ||
          centerZ + radius + 2 < minZ || centerZ - radius - 2 > maxZ) continue;
      const topY = bottomY + height;
      // 树基点落在岛顶层（y === height → 半径恰为 radius，见 islandLayerRadius）
      const r = islandLayerRadius(radius, height, height);
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (dx * dx + dz * dz > r * r) continue;
          const wx = centerX + dx, wz = centerZ + dz;
          // 判定用世界坐标 → 跨 column 同格判定一致
          if (seededRandom(wx, wz, seed + SKY_TREE_SALT) < SKY_TREE_CHANCE) {
            generateTree(wx, topY + 1, wz, setBlock, seed, 'skyTree');
          }
        }
      }
    }
  }
}

/**
 * column 空中结构注入（固定层序：云层先、空岛次之、天空树最后）。
 * @param {import('../../voxel/chunk-column.js').ChunkColumn} column
 * @param {Array<{skyIslands: Int32Array, cloudClusters: Int32Array}>} skyCandidates
 */
export function applySkyStructures(column, skyCandidates, seed, registry) {
  writeClouds(column, skyCandidates, seed, registry);
  writeIslands(column, skyCandidates, registry);
  writeSkyTrees(column, skyCandidates, seed, registry);
}
