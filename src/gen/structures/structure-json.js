// src/gen/structures/structure-json.js — JSON 结构加载与光栅化（移植 mc-lite StructureLoader +
// generateStructureWithGroundSupport 语义）
// 每个 GEN Worker 按需 fetch 并模块级缓存（同结构只加载一次）；光栅化按 column 裁剪写入。
// Worker 同构：本文件不得 import three。
import { generateHeight } from '../terrain.js';
import { WORLD_MIN_Y, WORLD_MAX_Y, blockIndex } from '../../voxel/constants.js';
import { resourceUrl } from '../../core/resource-url.js';
// 高台地带的 35 个产物基名（纯数据、零 node 依赖 —— 浏览器/Worker 都能 import）。
// ⚠️ **不要 import `tools/cloudland-kit-fingerprint.mjs`**：它依赖 `node:fs`，在浏览器/Worker
// 里解析会失败 → 整个模块不加载 → **Worker 起不来 → 游戏白屏**（B1 教训，`check:arch` 抓不到
// 这类运行时解析失败）。映射表与指纹留在 `tools/` 侧，纯数据在 `src/gen/structures/` 侧。
import { KIT_VARIANTS } from './cloudland-kit-data.js';

/** placement 类型 → JSON 文件名（mc-lite structureLoaders 映射） */
const BASE_STRUCTURE_FILES = {
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
  // 巨型金字塔（Giant Pyramid Epic）：palette + 扁平数组格式（同高台地带的 35 个产物）
  giantPyramid: 'giant_pyramid.json',
};

// 高台地带（Cloudland Tarn Zone）：11 座高台 + 5 拱洞 + 7 紫晶柱 + 12 巨型云 = 35 个产物。
// ⚠️ **不要手写这 35 行清单** —— 从 `KIT_VARIANTS` 派生（红线 1：加第 12 座高台时不用改两处，
// 漏一行会让那个变体静默不出现：`rasterizeStructure` 拿到空 blocks 直接 return，
// 方块层面完全看不出是漏了映射）。
for (const base of [
  ...KIT_VARIANTS.tarn, ...KIT_VARIANTS.arch,
  ...KIT_VARIANTS.spire, ...KIT_VARIANTS.giantCloud,
]) {
  BASE_STRUCTURE_FILES[base] = `${base}.json`;
}

export const STRUCTURE_FILES = Object.freeze(BASE_STRUCTURE_FILES);

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
    // 部署路径无关（v1.87）：旧写法是根绝对路径 `/assets/structures/...`，
    // 仓库挂子路径部署时 Worker 内 fetch 全部 404（结构静默变空）。
    loading.set(type, fetch(resourceUrl(`assets/structures/${STRUCTURE_FILES[type]}`))
      .then((r) => r.json())
      .then((data) => {
        // 三种产物形状（`structure-json.js` 同时认）：
        //  ① 旧：{blocks:[{x,y,z,type,direction}]} —— mc-lite 移植的 18 个 JSON
        //  ② 新：{palette:[name...], blocks:[x,y,z,paletteIndex, ...]} —— 万格级结构。
        //     10712 格逐字写对象约 500KB，palette 索引压缩后 106KB。
        //  ③ **带朝向的 palette 格式**：`{palette, stride: 5, blocks: [x,y,z,paletteIndex,direction, ...]}`
        //     —— 需要逐格朝向的结构（巨型金字塔的台阶）。
        //     ⚠️ **为什么必须有这种格式**：② 的路里 `direction` 被硬编码为 0，
        //     任何「同一种方块要 4 个朝向」的结构（台阶/楼梯）在 ② 下**静默丢掉朝向** ——
        //     世界里全部按 orient=0 渲染（巨型金字塔的 1219 个台阶曾因此全朝东）。
        //     用 stride 显式声明，不在 ② 上「猜」是否有第 5 项（两种格式的 blocks 长度差 25%，
        //     靠长度推导会在一格 0 格的结构上歧义）。
        const stride = Number.isInteger(data.stride) ? data.stride : 4;
        let raw;
        if (Array.isArray(data.palette) && Array.isArray(data.blocks)) {
          if (stride !== 4 && stride !== 5) {
            throw new Error(`structure "${type}": stride=${stride} 不支持（只允许 4 = 无朝向 / 5 = 带朝向）`);
          }
          raw = [];
          for (let i = 0; i < data.blocks.length; i += stride) {
            raw.push({
              x: data.blocks[i], y: data.blocks[i + 1], z: data.blocks[i + 2],
              type: data.palette[data.blocks[i + 3]],
              direction: stride === 5 ? data.blocks[i + 4] : 0,
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
