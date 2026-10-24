// src/gen/structures/structure-json.js — JSON 结构加载与光栅化（移植 mc-lite StructureLoader +
// generateStructureWithGroundSupport 语义）
// 每个 GEN Worker 按需 fetch 并模块级缓存（同结构只加载一次）；光栅化按 column 裁剪写入。
// Worker 同构：本文件不得 import three。
import { generateHeight } from '../terrain.js';
import { WORLD_MIN_Y, WORLD_MAX_Y, blockIndex } from '../../voxel/constants.js';

/** placement 类型 → JSON 文件名（mc-lite structureLoaders 映射） */
export const STRUCTURE_FILES = Object.freeze({
  castle: 'castle.json',
  bigHouse: 'big_house.json',
  regularHouse1: 'regular_house_1.json',
  desertTempleTube: 'desert_temple_tube.json',
  boxHouse: 'box_house.json',
  desertVillage: 'desert_village.json',
  doubleTower: 'double_tower.json',
  treeTower: 'tree_tower.json',
  junglePyramid: 'jungle_pyramid.json',
  pyramidIsland: 'pyramid_island.json',
  smallHouse: 'small_house.json',
  treeHouse: 'tree_house.json',
  uglyHouse: 'ugly_house.json',
  whiteTower: 'white_tower.json',
  woodHouse: 'wood_house.json',
  gate: 'gate.json',
  tank: 'tank.json',
  tower: 'tower.json',
  birchTree: 'brich_tree.json',
  birchTreeWithSnow: 'brich_tree_with_snow.json',
  // 撒布结构（M2 欠账补齐）。注意 JSON 文件名与 placement 类型名的拼写差异：
  // flower_bed（下划线）/ pavilion / tall_well（下划线）/ desert_pyramid（下划线）
  flowerBed: 'flower_bed.json',
  pavilion: 'pavilion.json',
  tallWell: 'tall_well.json',
  desertPyramid: 'desert_pyramid.json',
  // Cloudland 高台（桌山景观）：palette + 扁平数组格式，见上 loadStructure 的两形状归一化
  cloudlandMesaSmall: 'cloudland_mesa_small.json',
});

/**
 * 需要底部支撑柱补地的结构（mc-lite generateStructureWithGroundSupport 清单）。
 *
 * ⚠️ 撒布结构里只有 `desertPyramid` / `desertVillage` / `uglyHouse` 在此清单 ——
 * mc-lite 实测：这三个走 `generateStructureWithGroundSupport`（WorldWorker.js:3085/3097/3283），
 * 而 `flowerBed` / `pavilion` / `tallWell` / `tank` 走 `loader.generate(...)`（:3049/3061/3072/767）
 * **不补支撑柱**。勿按「都是撒布结构」一刀切加进来 —— 加了会让花坛/亭子多出支撑柱（实测踩坑）。
 */
export const GROUND_SUPPORT_TYPES = new Set([
  'castle', 'gate', 'bigHouse', 'regularHouse1', 'desertTempleTube', 'boxHouse',
  'desertVillage', 'doubleTower', 'treeTower', 'junglePyramid', 'pyramidIsland',
  'smallHouse', 'treeHouse', 'woodHouse', 'uglyHouse', 'whiteTower',
  'desertPyramid',
]);

const cache = new Map();   // type → {blocks: [...]}（Y 已归一化，最低点=1）
const loading = new Map(); // type → Promise

/** 加载结构 JSON（缓存；失败返回空结构，与 mc-lite 兜底一致） */
export function loadStructure(type) {
  if (cache.has(type)) return Promise.resolve(cache.get(type));
  if (!loading.has(type)) {
    loading.set(type, fetch(`/assets/structures/${STRUCTURE_FILES[type]}`)
      .then((r) => r.json())
      .then((data) => {
        // 两种产物形状（`structure-json.js` 同时认两神）：
        //  ① 旧：{blocks:[{x,y,z,type,direction}]} —— mc-lite 移植的 18 个 JSON
        //  ② 新：{palette:[name...], blocks:[x,y,z,paletteIndex, ...]} —— 万格级结构。
        //     10712 格逐字写对象约 500KB，palette 索引压缩后 106KB。
        let raw;
        if (Array.isArray(data.palette) && Array.isArray(data.blocks)) {
          raw = [];
          for (let i = 0; i < data.blocks.length; i += 4) {
            raw.push({
              x: data.blocks[i], y: data.blocks[i + 1], z: data.blocks[i + 2],
              type: data.palette[data.blocks[i + 3]], direction: 0,
            });
          }
        } else raw = data.blocks;
        let minY = Infinity;
        for (const b of raw) if (b.y < minY) minY = b.y;
        const normalized = {
          blocks: raw.map((b) => ({
            x: b.x, y: b.y - minY + 1, z: b.z,
            type: b.type, direction: b.direction !== undefined ? b.direction : 0,
          })),
        };
        cache.set(type, normalized);
        return normalized;
      })
      .catch(() => {
        const empty = { blocks: [] };
        cache.set(type, empty);
        return empty;
      }));
  }
  return loading.get(type);
}

/** 批量预载（GEN 携带城市布局时一次拉齐全部城市结构） */
export function preloadStructures(types) {
  return Promise.all(types.map(loadStructure));
}

/**
 * 光栅化：(x, y, z) = 结构中心与地面参考高度（底层面块落在 y），裁剪写入 column。
 * @param {(wx:number, y:number, wz:number, name:string, meta?:number) => void} setBlock
 * @param {import('../../voxel/chunk-column.js').ChunkColumn} column ground support 探地用
 * @param {*} registry solid 判定
 * @param {number} seed support 兜底地形估算用
 * @param {boolean} groundSupport 是否补底部支撑柱
 */
export function rasterizeStructure(type, x, y, z, setBlock, column, registry, seed, groundSupport) {
  const data = cache.get(type);
  if (!data || !data.blocks.length) return;

  for (const b of data.blocks) {
    setBlock(Math.floor(x + b.x), Math.floor(y + b.y - 1), Math.floor(z + b.z), b.type, b.direction || 0);
  }

  if (!groundSupport) return;

  // ground support（mc-lite generateStructureWithGroundSupport）：
  // 本地 y=1（贴地层）方块向下探 ≤5 格，悬空则用自身类型补支撑柱。
  const maxFloatingBlocks = 5;
  const supportColumns = new Map();
  for (const b of data.blocks) {
    if (Math.floor(b.y) !== 1) continue;
    const wx = Math.floor(x + b.x);
    const wy = Math.floor(y + (b.y - 1));
    const wz = Math.floor(z + b.z);
    supportColumns.set(`${wx},${wz}`, { x: wx, y: wy, z: wz, type: b.type });
  }

  const isSolidAt = (wx, wy, wz) => {
    const lx = wx - column.cx * 16, lz = wz - column.cz * 16;
    if (lx < 0 || lx > 15 || lz < 0 || lz > 15) return false;
    if (wy < WORLD_MIN_Y || wy >= WORLD_MAX_Y) return false;
    const id = column.blocks[blockIndex(lx, wy, lz)];
    return id !== 0 && registry.solidTable[id] === 1;
  };

  for (const base of supportColumns.values()) {
    const baseY = base.y;
    const probeMinY = Math.max(WORLD_MIN_Y, baseY - (maxFloatingBlocks + 1));
    let supportGroundY = null;

    for (let probeY = baseY - 1; probeY >= probeMinY; probeY--) {
      if (isSolidAt(base.x, probeY, base.z)) { supportGroundY = probeY; break; }
    }

    // 兜底：探不到（本 column 无该列数据）→ 地形高度估算，1~5 格悬空才补
    if (supportGroundY === null) {
      const terrainY = generateHeight(base.x, base.z, seed);
      const floatingBlocks = baseY - terrainY - 1;
      if (floatingBlocks >= 1 && floatingBlocks <= maxFloatingBlocks) supportGroundY = terrainY;
    }
    if (supportGroundY === null) continue;

    for (let fillY = baseY - 1; fillY > supportGroundY; fillY--) {
      setBlock(base.x, fillY, base.z, base.type, 0);
    }
  }
}
