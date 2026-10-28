// src/gen/structures/vegetation.js — 树木/植被生成（移植 mc-lite Tree.js + WorldWorker 植被扫描）
// Math.random → 世界坐标 seededRandom 确定性化；树木按 AABB 裁剪到 column（setBlock 自带裁剪）。
// Worker 同构：本文件不得 import three。
import { seededRandom } from '../noise.js';

/** 树内局部随机（世界坐标稳定，跨 column 光栅化一致） */
function treeRand(x, z, seed, salt) {
  return seededRandom(x, z, seed + salt);
}

/**
 * 树木生成（mc-lite Tree.generate 移植：default/big/azalea/swamp）。
 * @param {(wx:number,y:number,wz:number,name:string,meta?:number)=>void} setBlock
 */
export function generateTree(wx, y, wz, setBlock, seed, type = 'default', customLog = null, customLeaf = null) {
  const blocks = [];

  if (type === 'default' || type === 'skyTree') {
    const wT = customLog || (type === 'skyTree' ? 'sky_wood' : 'wood');
    const lT = customLeaf || (type === 'skyTree' ? 'sky_leaves' : 'leaves');
    for (let i = 0; i < 4; i++) blocks.push({ x: wx, y: y + i, z: wz, type: wT });
    for (let lx = wx - 2; lx <= wx + 2; lx++) {
      for (let ly = y + 2; ly <= y + 4; ly++) {
        for (let lz = wz - 2; lz <= wz + 2; lz++) {
          if ((lx !== wx || lz !== wz || ly > y + 3) && treeRand(lx, lz, seed + ly * 7, 401) > 0.3) {
            blocks.push({ x: lx, y: ly, z: lz, type: lT });
          }
        }
      }
    }
  } else if (type === 'big') {
    const h = 6 + Math.floor(treeRand(wx, wz, seed, 402) * 8);
    const logMat = customLog || 'wood';
    const leafMat = customLeaf || 'leaves';
    for (let i = 0; i < h; i++) blocks.push({ x: wx, y: y + i, z: wz, type: logMat });
    for (let lx = wx - 2; lx <= wx + 2; lx++) {
      for (let ly = y + h - 3; ly <= y + h; ly++) {
        for (let lz = wz - 2; lz <= wz + 2; lz++) {
          blocks.push({ x: lx, y: ly, z: lz, type: leafMat });
        }
      }
    }
  } else if (type === 'azalea') {
    const h = 4 + Math.floor(treeRand(wx, wz, seed, 403) * 3);
    for (let i = 0; i < h; i++) blocks.push({ x: wx, y: y + i, z: wz, type: 'azalea_log' });
    for (let lx = wx - 2; lx <= wx + 2; lx++) {
      for (let ly = y + h - 2; ly <= y + h; ly++) {
        for (let lz = wz - 2; lz <= wz + 2; lz++) {
          if (lx !== wx || lz !== wz || ly >= y + h) {
            const dist = Math.abs(lx - wx) + Math.abs(lz - wz);
            if (dist <= 2 && treeRand(lx, lz, seed + ly * 7, 404) > 0.2) {
              const leafType = treeRand(lx, lz, seed + ly * 11, 405) < 0.3 ? 'azalea_flowers' : 'azalea_leaves';
              blocks.push({ x: lx, y: ly, z: lz, type: leafType });
            }
          }
        }
      }
    }
  } else if (type === 'swamp') {
    const h = 5 + Math.floor(treeRand(wx, wz, seed, 406) * 4);
    const logMat = customLog || 'wood';
    for (let i = 0; i < h; i++) blocks.push({ x: wx, y: y + i, z: wz, type: logMat });
    for (let lx = wx - 3; lx <= wx + 3; lx++) {
      for (let lz = wz - 3; lz <= wz + 3; lz++) {
        if (Math.abs(lx - wx) + Math.abs(lz - wz) <= 3.5) {
          blocks.push({ x: lx, y: y + h - 1, z: lz, type: 'leaves' });
          blocks.push({ x: lx, y: y + h, z: lz, type: 'leaves' });
          if (treeRand(lx, lz, seed, 407) < 0.3 && Math.abs(lx - wx) > 1) {
            for (let v = 1; v <= 3; v++) blocks.push({ x: lx, y: y + h - 1 - v, z: lz, type: 'vine' });
          }
        }
      }
    }
  }

  // _addOptimized：完全被树块包围的透明叶不写（mc-lite 语义：isTransparent 动态判定，
  // 含 azalea_flowers——Tree.js:118 仅排除 vine）
  const keySet = new Set(blocks.map((b) => `${b.x},${b.y},${b.z}`));
  const TRANSPARENT_LEAF = new Set(['leaves', 'yellow_leaves', 'sky_leaves', 'azalea_leaves', 'azalea_flowers', 'swamp_leaves', 'snow_leaves', 'realistic_oak_leaves', 'realistic_yellow_leaves']);
  for (const b of blocks) {
    if (TRANSPARENT_LEAF.has(b.type)) {
      const surrounded = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
        .every(([dx, dy, dz]) => keySet.has(`${b.x + dx},${b.y + dy},${b.z + dz}`));
      if (surrounded) continue;
    }
    setBlock(b.x, b.y, b.z, b.type);
  }
}

/**
 * 普通地形植被（mc-lite WorldWorker else 分支逐 biome 规则，确定性 seed 原样保留）。
 * 单格植物直接写；树木返回描述由调用方光栅化（跨 column 裁剪）。
 * @returns {{plant?: string, tree?: Object}} plant=单格方块名；tree={type, customLog, customLeaf}
 */
export function rollVegetation(wx, wz, biome, seed) {
  if (biome === 'FOREST') {
    const forestRand = seededRandom(wx, wz, seed + 14);
    if (forestRand < 0.04) {
      if (seededRandom(wx, wz, seed + 15) < 0.15) return { tree: { type: 'big', customLeaf: 'yellow_leaves' } };
      if (seededRandom(wx, wz, seed + 16) < 0.1) return { tree: { type: 'birchTree' } };
      const leafType = seededRandom(wx, wz, seed + 17) < 0.1 ? 'yellow_leaves' : null;
      const logType = seededRandom(wx, wz, seed + 18) < 0.1 ? 'birch_log' : null;
      return { tree: { type: 'big', customLog: logType, customLeaf: leafType } };
    }
    if (forestRand < 0.10) {
      const plantRand = seededRandom(wx, wz, seed + 19);
      if (plantRand < 0.25) return { plant: 'azure_bluet' };
      if (plantRand < 0.40) return { plant: 'oxeye_daisy' };
      if (plantRand < 0.55) return { plant: 'red_mushroom' };
      if (plantRand < 0.70) return { plant: 'dead_bush' };
    }
    return {};
  }
  // AZALEA 的树已改由 `structures/azalea-trees.js`（阶段 2.85）用 asset_oak 的 10 档造型生成 ——
  // 旧的代码生成小树（`type: 'azalea'`，高 6~8、冠 5×5、约 34 格）**不再落位**。
  // 故这里返回空：不留 4.5% 的旧树，否则会与新高树叠在一起（旧树的 5×5 冠埋在新树里，
  // 表现为「新树根部多出一坨形状怪异的叶子」）。
  // `generateTree` 的 `'azalea'` 分支保留（它不是只服务本分支的私有实现，删掉会让
  // `generateTree(type)` 的公开契约缺一档；且将来若要「小杜鹃树」变体可直接复用）。
  if (biome === 'AZALEA') return {};
  if (biome === 'SWAMP') {
    if (seededRandom(wx, wz, seed + 20) < 0.03) return { tree: { type: 'swamp' } };
    return {};
  }
  if (biome === 'DESERT') {
    if (seededRandom(wx, wz, seed + 21) < 0.01) return { plant: 'cactus' };
    if (seededRandom(wx, wz, seed + 24) < 0.005) return { plant: 'dead_bush' };
    return {};
  }
  // PLAINS 等
  if (seededRandom(wx, wz, seed + 1) < 0.005) return { tree: { type: 'default' } };
  const randPlant = seededRandom(wx, wz, seed + 2);
  if (randPlant < 0.05) return { plant: 'short_grass' };
  if (randPlant < 0.10) {
    const flowerRand = seededRandom(wx, wz, seed + 3);
    return { plant: flowerRand < 0.33 ? 'allium' : flowerRand < 0.66 ? 'flower' : 'azure_bluet' };
  }
  if (randPlant < 0.11) return { plant: 'oxeye_daisy' };
  if (randPlant < 0.115) return { plant: 'red_mushroom' };
  if (randPlant < 0.13) return { plant: 'dead_bush' };
  return {};
}

/**
 * 城市树木概率（mc-lite 城市分支 5 种，seed+800~805）。
 * 近建筑检查由调用方做（布局 footprint 确定性版本）。
 */
export function rollCityTree(wx, wz, seed) {
  if (seededRandom(wx, wz, seed + 800) < 0.0044) return { tree: { type: 'default' } };
  if (seededRandom(wx, wz, seed + 801) < 0.0017) return { tree: { type: 'big' } };
  if (seededRandom(wx, wz, seed + 803) < 0.0044) return { tree: { type: 'swamp' } };
  if (seededRandom(wx, wz, seed + 804) < 0.0022) return { tree: { type: 'big', customLeaf: 'yellow_leaves' } };
  if (seededRandom(wx, wz, seed + 805) < 0.00147) return { tree: { type: 'birchTree' } };
  return {};
}
