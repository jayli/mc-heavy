// src/gen/structures/vegetation.js — 树木/植被生成（移植 mc-lite Tree.js + WorldWorker 植被扫描）
// Math.random → 世界坐标 seededRandom 确定性化；树木按 AABB 裁剪到 column（setBlock 自带裁剪）。
// Worker 同构：本文件不得 import three。
import { seededRandom } from '../noise.js';

/** 树内局部随机（世界坐标稳定，跨 column 光栅化一致） */
function treeRand(x, z, seed, salt) {
  return seededRandom(x, z, seed + salt);
}

/**
 * 树叶混表的 salt（**程序化扫描确认空闲**）。
 *
 * 扫描口径：`src/**` + `tools/**` + `tests/**` 里全部 `seed + N` 与 `*SALT = N` 常量，
 * 已占区间 `0~5 10~21 23~26 37 50~58 91 100 113 200~201 301~303 311~314 777 800~805 812
 * 823~824 826 951 956 1000 1004 1020~1027 1029~1040 2000 3000 … 16000`。
 * 1041/1042 落在 1020~1040 段之后的第一个空档。
 * ⚠️ 用错 salt 是**静默的确定性污染**（不报错，只是叶子分布与另一个系统纠缠），
 * 故新增 salt 前必须重跑一次扫描，不能凭 1020~1040「已占满」直接推 1041 安全。
 */
export const SAPLING_LEAF_SALT = 1041;
export const TALL_LEAF_SALT = 1042;

/** 四种巨树叶（矮树 / 高树的混表共用同一批候选，只有权重不同） */
const GIANT_LEAF_SPECIES = Object.freeze([
  'giant_oak_leaves', 'giant_spruce_leaves', 'giant_palm_leaves', 'giant_banyan_leaves',
]);

/**
 * 树叶混表抽签：给定 σ 落在 [0,1)，返回该 σ 对应的叶种。
 *
 * 权重口径（用户 2026-11-14 两轮裁定）：
 *   · 矮树（草地 PLAINS）：「更保守」档 —— `leaves` 80%，四种巨树叶各 5%
 *     （`leaves` 随机性最高）；
 *   · 高树（森林 FOREST）：`leaves` 60% + `yellow_leaves` **25%** + 四种巨树叶各 3.75%
 *     —— 黄叶比例由首轮的 35% 降为 25%（用户二次裁定「yellow_leaves 在森林中的比例
 *     降低为 25%」），降下的 10% **由 `leaves` 吸收**，巨树叶份额不动（那是首轮
 *     「更保守」档的裁定，本轮未推翻）。
 *
 * ⚠️ 三个份额必须合计 100%（`0.6 + 0.25 + 4 × 0.0375 = 1`）：改任一档都要重算另外两档，
 * 否则抽签尾部会落空（σ 超出已知区间时 `pickLeaf` 默认返回 `leaves`，会静默放大它的实际占比）。
 *
 * @param {number} sigma [0,1) 的抽签值
 * @param {boolean} tall 高树（true）还是矮树（false）
 * @returns {string} 方块名
 */
function pickLeaf(sigma, tall) {
  const giantShare = tall ? 0.0375 : 0.05;
  const giantCount = GIANT_LEAF_SPECIES.length * giantShare;
  if (sigma < giantCount) return GIANT_LEAF_SPECIES[Math.floor(sigma / giantShare)];
  if (!tall) return 'leaves';
  // 高树：σ 区间切三段 —— 巨树叶占前 0.15（4 × 0.0375），黄叶接着占 0.25（= 总占比 25%），
  // 剩下 0.60 归 leaves。三个宽度直接相加 = 1，不需再除以剩余区间长度。
  return sigma - giantCount < 0.25 ? 'yellow_leaves' : 'leaves';
}

/**
 * 一棵树的叶种（**整棵树一种**，用户 2026-11-14 的粒度裁定）。
 *
 * ⚠️ **掷签只吃 `(wx, wz, seed)`，不吃 y / 不吃叶格坐标**：`generateTree` 的调用方会
 * 在世界坐标变体下逐格调用（同一棵树跨 column 光栅化两次），吃 y 或局部坐标会让
 * 「半边树一种叶、另半边换一种」—— 那是用户明确否掉的粒度。
 *
 * ⚠️ `customLeaf` 优先：显式指定的黄叶树 / 定制树不被混表改写。
 *
 * @param {number} wx @param {number} wz @param {number} seed @param {string|null} customLeaf
 * @param {'sapling'|'tall'|null} mix 混表档位（null = 不混，保持旧行为）
 * @param {string} fallback 旧默认叶种
 */
function leafTypeFor(wx, wz, seed, customLeaf, mix, fallback) {
  if (customLeaf) return customLeaf;
  if (!mix) return fallback;
  const salt = mix === 'tall' ? TALL_LEAF_SALT : SAPLING_LEAF_SALT;
  return pickLeaf(treeRand(wx, wz, seed, salt), mix === 'tall');
}

/**
 * 树木生成（mc-lite Tree.generate 移植：default/big/azalea/swamp）。
 *
 * 树叶混表（2026-11-14，用户："我希望每种树的树叶随机用不同的树叶方块来渲染"）：
 * 由调用方通过 `leafMix` 指定档位，**权重的唯一权威在 `pickLeaf`**。
 *
 * @param {(wx:number,y:number,wz:number,name:string,meta?:number)=>void} setBlock
 * @param {'sapling'|'tall'|null} [leafMix] 树叶混表档位；null = 保持旧行为（单一 `leaves`）
 */
export function generateTree(wx, y, wz, setBlock, seed, type = 'default', customLog = null, customLeaf = null, leafMix = null) {
  const blocks = [];

  if (type === 'default' || type === 'skyTree') {
    const wT = customLog || (type === 'skyTree' ? 'sky_wood' : 'wood');
    const lT = leafTypeFor(wx, wz, seed, customLeaf, type === 'skyTree' ? null : leafMix,
      type === 'skyTree' ? 'sky_leaves' : 'leaves');
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
    const leafMat = leafTypeFor(wx, wz, seed, customLeaf, leafMix, 'leaves');
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
  const TRANSPARENT_LEAF = new Set(['leaves', 'yellow_leaves', 'sky_leaves', 'azalea_leaves', 'azalea_flowers', 'swamp_leaves', 'snow_leaves', 'realistic_yellow_leaves', ...GIANT_LEAF_SPECIES]);
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
 * @returns {{plant?: string, tree?: Object}} plant=单格方块名；tree={type, customLog, customLeaf, leafMix}
 *   ⚠️ `leafMix` 是树叶混表档位（`'sapling'` 草地矮树 / `'tall'` 森林高树 / 缺省 = 不混）。
 *   它由本函数按 biome 判定 —— 城市树 / 海岛树 / 天空树走别的分支，**不受影响**。
 */
export function rollVegetation(wx, wz, biome, seed) {
  if (biome === 'FOREST') {
    const forestRand = seededRandom(wx, wz, seed + 14);
    if (forestRand < 0.04) {
      // 高树叶混表（2026-11-14）：叶种由 `generateTree` 按 `leafMix:'tall'` 掷签（内含黄叶）。
      //
      // ⚠️ **`seed + 15` 这个抽签必须保留，只是不再决定叶种**：它原本是「15% 直接出黄叶大树」
      // 的提前返回分支，而那条分支同时挡住了 `seed + 16` 的桦树抽签。删掉它会让桦树占比从
      // 8.5%（= 0.85 × 0.10）升到 10% —— 实测森林里多出 25 格 `birch_log`，而树叶混表本身
      // 对此零关系。保留抽签 = 树种分布逐位不变，只有叶种换成了混表。
      const yellowDraw = seededRandom(wx, wz, seed + 15);
      if (yellowDraw >= 0.15 && seededRandom(wx, wz, seed + 16) < 0.1) return { tree: { type: 'birchTree' } };
      const logType = seededRandom(wx, wz, seed + 18) < 0.1 ? 'birch_log' : null;
      return { tree: { type: 'big', customLog: logType, leafMix: 'tall' } };
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
  if (seededRandom(wx, wz, seed + 1) < 0.005) return { tree: { type: 'default', leafMix: 'sapling' } };
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
