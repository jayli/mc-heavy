// src/gen/terrain.js — 地形高度 + column 填充 + 出生点（移植 mc-lite TerrainGen/WorldWorker 地层规则）
// M1 范围：地层 + 水面 + 基岩。树/花/草/云/结构 = M2。
// Worker 同构：本文件不得 import three。
import { seededRandom, noise, getBiome } from './noise.js';
import { SEA_Y, WORLD_MIN_Y, WORLD_MAX_Y, blockIndex } from '../voxel/constants.js';

/** 指定 biome 的地形高度（biome 调整规则与 mc-lite TerrainGen.generateHeight 一致） */
export function generateHeightForBiome(x, z, seed, biome) {
  let h = Math.floor(noise(x, z, seed, 0.08) + noise(x, z, seed, 0.02) * 3);
  if (biome === 'DESERT') h = Math.floor(h * 0.5 + 2);
  if (biome === 'SWAMP') h = Math.floor(h * 0.3 - 2);
  if (biome === 'CITY') h = Math.floor(h * 0.25 + 1); // CITY 压平（M2：城市区域）
  return h;
}

/** 地形高度（自动取 biome；CITY 判定由结构系统在列循环显式传入 biome） */
export function generateHeight(x, z, seed) {
  return generateHeightForBiome(x, z, seed, getBiome(x, z, seed));
}

const SURFACE_BY_BIOME = {
  PLAINS: ['grass', 'dirt'],
  FOREST: ['grass', 'dirt'],
  DESERT: ['sand', 'sand'],
  AZALEA: ['moss', 'dirt'],
  SWAMP: ['swamp_grass', 'dirt'],
};

/**
 * biome 的地表方块名 —— `SURFACE_BY_BIOME` 的唯一权威读出口（红线 1）。
 *
 * 撒布门控需要按「地表是不是 grass」判定（mc-lite resolveLargeStaticStructureType），
 * 若让消费者自己写第二份 biome→地表映射表就会漂移（漂移后果：tank/house 撒到沙地上）。
 * @returns {string}
 */
export function surfaceTypeOfBiome(biome) {
  return SURFACE_BY_BIOME[biome]?.[0] ?? 'grass';
}

/**
 * 填充整个 column（地层规则逐条移植 mc-lite WorldWorker.js:983-1015）。
 * 直接写 column.blocks（生成路径，不走 set()——不记 edits、不 bump version，
 * GEN 完成接管后由调度器统一置 version 基线）。
 * @param {import('../voxel/chunk-column.js').ChunkColumn} column
 * @param {number} seed
 * @param {ReturnType<import('../voxel/block-registry.js').createRegistry>} registry
 */
export function fillColumn(column, seed, registry) {
  const id = (name) => registry.idOf(name);
  const waterId = id('water'), stoneId = id('stone'), endStoneId = id('end_stone');
  const bedrockId = id('bedrock'), sandId = id('sand'), goldId = id('gold_ore');
  const surfIds = {};
  for (const [b, [s, sub]] of Object.entries(SURFACE_BY_BIOME)) surfIds[b] = [id(s), id(sub)];

  for (let lx = 0; lx < 16; lx++) {
    for (let lz = 0; lz < 16; lz++) {
      const wx = column.cx * 16 + lx, wz = column.cz * 16 + lz;
      const biome = getBiome(wx, wz, seed);
      const h = generateHeight(wx, wz, seed);
      const [surfId, subId] = surfIds[biome];

      if (h < SEA_Y) {
        // 水底：sand + end_stone（mc-lite WorldWorker.js:983-984）
        column.blocks[blockIndex(lx, h, lz)] = sandId;
        column.blocks[blockIndex(lx, h - 1, lz)] = endStoneId;
        // 水面填充：(h, SEA_Y]
        for (let y = h + 1; y <= SEA_Y; y++) column.blocks[blockIndex(lx, y, lz)] = waterId;
      } else {
        column.blocks[blockIndex(lx, h, lz)] = surfId;
        column.blocks[blockIndex(lx, h - 1, lz)] = subId;
        // k=2..12 地层（mc-lite WorldWorker.js:1002-1014）
        for (let k = 2; k <= 12; k++) {
          const y = h - k;
          if (y < WORLD_MIN_Y) break;
          if (k === 12) { column.blocks[blockIndex(lx, y, lz)] = endStoneId; continue; }
          if (k === 11) { column.blocks[blockIndex(lx, y, lz)] = stoneId; continue; }
          const r = seededRandom(wx, wz, seed + 100 + k);
          column.blocks[blockIndex(lx, y, lz)] = r < 0.01 ? goldId : stoneId;
        }
      }
      // 底部补实：从最深已填充层之下到基岩之上全填 stone（防悬空空洞——
      // mc-lite 稀疏存储下方留空，新引擎补实；水面分支 deepest=h-1，陆地分支 deepest=h-12）
      const deepest = (h < SEA_Y) ? h - 1 : Math.max(h - 12, WORLD_MIN_Y + 1);
      for (let y = deepest - 1; y > WORLD_MIN_Y; y--) {
        column.blocks[blockIndex(lx, y, lz)] = stoneId;
      }
      // 基岩层
      column.blocks[blockIndex(lx, WORLD_MIN_Y, lz)] = bedrockId;
    }
  }
}

/**
 * 出生点安全（复刻 mc-lite spawn on dry ground，§4.2）：
 * 从顶向下找首个非 air 方块，返回其上方一格 y。
 * @param {import('../voxel/world-data.js').WorldData} world
 */
export function findSpawnY(world, x, z) {
  for (let y = WORLD_MAX_Y - 1; y > WORLD_MIN_Y; y--) {
    if (world.getBlockId(x, y, z) !== 0) return y + 1;
  }
  return SEA_Y + 2; // 兜底
}
