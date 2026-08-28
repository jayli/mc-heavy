// src/gen/structures/sky-structures.js — M2-7 空中结构：悬浮空岛 + 云层（设计文档 §4.2）
// 移植 mc-lite Island.js / Cloud.js 的可见世界语义：候选与方块只由 (seed, chunk 坐标) 推导，
// 无 Math.random、无 structureCenters、无运行期跨 chunk 补刷。
// 覆盖层序（mc-lite 口径）：先写 Y=55 单云层（Task 3 追加 Y=35 云簇），后写空岛；
// 岛与单云相交处岛体覆盖云。所有写入裁剪到当前 column。
// Worker 同构：本文件不得 import three。
import { noise, seededRandom } from '../noise.js';
import { WORLD_MIN_Y, WORLD_MAX_Y } from '../../voxel/constants.js';
import { makeColumnSetter } from './landmarks.js';

/** 每 region 的来源 chunk 数（REGION_SIZE 400 / 16） */
const CHUNKS_PER_REGION = 25;

/** 单云层高度（mc-lite WorldWorker.js:1125 Cloud.generate(wx, 55, wz)） */
export const SINGLE_CLOUD_Y = 55;
/** 连通云簇高度（mc-lite WorldWorker.js:1177 Cloud.generateCluster(startX, 35, ...)） */
export const CLOUD_CLUSTER_Y = 35;

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
 * 不迁移宝箱与天空树）。仅遍历水平 AABB 相交候选；无条件写岛体目标格。
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
        const r = Math.floor(radius * Math.pow(y / height, 0.7));
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
 * column 空中结构注入（固定层序：云层先、空岛后）。
 * @param {import('../../voxel/chunk-column.js').ChunkColumn} column
 * @param {Array<{skyIslands: Int32Array, cloudClusters: Int32Array}>} skyCandidates
 */
export function applySkyStructures(column, skyCandidates, seed, registry) {
  writeClouds(column, skyCandidates, seed, registry);
  writeIslands(column, skyCandidates, registry);
}
