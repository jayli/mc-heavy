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
  return {
    // ⚠️ 自带宽区坐标：可用作确定性缓存键。**不要从 `skyIslands[0]` 反推** ——
    // 那个反推在「该 region 没有任何岛」时无定义（实测 121 个 region 与 200 个 seed 里
    // 都没遇到，但那是运气，不是不变量）。
    regionX, regionZ,
    skyIslands: Int32Array.from(islands), cloudClusters: Int32Array.from(clusters),
  };
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
 * 天空树块名常量：落叶判据的唯一权威（红线 1）。
 * `generateTree` 的 `skyTree` 分支只会产出这两个名字（见 `vegetation.js`）。
 */
export const SKY_TREE_LOG = 'sky_wood';
export const SKY_TREE_LEAF = 'sky_leaves';

/** 六邻接偏移（孤立判定的判据，与 RedCity 的 `REDCITY_DROP_ISOLATED` 同语义） */
const NEIGHBOR_6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/**
 * 方块坐标 → 单个数值键（避免 `"x,y,z"` 字符串的 split 开销）。
 *
 * 为何需要：实测 `dropIsolatedSkyLeaves` 用字符串键 + `split(',')` 解析时 **5.83 ms**，
 * 分桶再来 4.48 ms —— 直接把 `structure-gen` 的冻结门禁 `genP95 < 10ms` 撞到 25 ms。
 * 数值键后两者合并为一次流式遍历。
 *
 * 位宽：x/z 取 ±2^18（±26 万格，远超本仓世界尺寸）、y 取 0..255（`WORLD_MIN_Y=-32` 平移后 ≤128）。
 * 用 `*` 而不是位运算以避开 32 位溢出（2^18 * 2^18 = 2^36 超 32 位）。
 */
function cellKey(x, y, z) {
  return ((x + 262144) * 524288 + (z + 262144)) * 256 + (y + 32);
}

/** @param {number} k `cellKey` 的结果 @returns {[number, number, number]} */
function keyToCell(k) {
  const yz = k % 256; const rest = (k - yz) / 256;
  const z = (rest % 524288) - 262144; const x = ((rest - (rest % 524288)) / 524288) - 262144;
  return [x, yz - 32, z];
}

/**
 * 算出一批岛候选的全部天空树方块（纯函数，**不写世界**）。
 *
 * 抽出来是为了让「孤叶判定」能看到完整的邻接关系 —— 逐树判会误删（见 `dropIsolatedSkyLeaves`）。
 * 入参是「岛候选子集」：`computeColumnTrees` 只传与该 column 邻近的岛（实测 0.31 ms/列），
 * 传全 region 也能算（实测 13.4 ms），只是不必。
 *
 * @param {Array<{skyIslands: Int32Array}>} skyCandidates
 * @param {number} seed
 * @returns {{blocks: Map<number,string>, leaves: Set<number>}} blocks 是全量（含树干，判定要用）；
 *   leaves 是叶子子集（只有它会被删，树干永不删 —— 删了树就只剩悬空叶）。均为数值键。
 */
export function computeSkyTreeBlocks(skyCandidates, seed) {
  const blocks = new Map();
  const leaves = new Set();
  for (const { skyIslands } of skyCandidates) {
    for (let i = 0; i < skyIslands.length; i += 5) {
      const centerX = skyIslands[i] * 16 + 8, centerZ = skyIslands[i + 1] * 16 + 8;
      const bottomY = skyIslands[i + 2], radius = skyIslands[i + 3], height = skyIslands[i + 4];
      const topY = bottomY + height;
      const r = islandLayerRadius(radius, height, height);
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (dx * dx + dz * dz > r * r) continue;
          const wx = centerX + dx, wz = centerZ + dz;
          if (seededRandom(wx, wz, seed + SKY_TREE_SALT) >= SKY_TREE_CHANCE) continue;
          generateTree(wx, topY + 1, wz, (x, y, z, name) => {
            const k = cellKey(x, y, z);
            blocks.set(k, name);
            if (name === SKY_TREE_LEAF) leaves.add(k);
          }, seed, 'skyTree');
        }
      }
    }
  }
  return { blocks, leaves };
}

/**
 * 删除「六邻接全空」的天空树叶（spec §16 的用户反馈：空中有悬空方块）。
 * 判据与 RedCity 的 `REDCITY_DROP_ISOLATED` **同语义**：六邻接（不含斜角）全空即删。
 * 邻接检查看**全部天空树方块**（含树干）—— 叶子挨着树干就不算孤立。
 *
 * 实测（seed=12345，region 0,0）：17,009 个天空树方块 / 15,561 片叶里删 **74** 片，
 * 删一轮即到不动点（无级联）；整棵树 0.48%。
 *
 * ⚠️ **为什么必须世界级判，不能在 `generateTree` 里逐树剔**（实测过的反向选择）：
 * 树内孤叶里有 **649 片其实是靠邻树的树冠连着**的 —— 按单树剔除会误删它们，
 * 还会剩 81 片真孤叶漏网，并制造 91 片级联新孤叶。数据：
 *   树内孤立叶 1,493 ／ 其中靠别的树连着 649 ／ 世界级真孤叶 716。
 *
 * ⚠️ **也不能逐 column 判**：GEN 是逐 column 独立生成的，单 column 看不到邻柱，
 * 柱边界上的叶子会被误判。故由 `computeColumnTrees` 取「该 column 邻近的岛子集」重算 ——
 * 实测与全 region 结果逐格一致（111 个 column 零不一致）。
 *
 * @returns {number} 被删的叶子数
 */
export function dropIsolatedSkyLeaves(blocks, leaves) {
  // 邻接偏移预先算成「数值键增量」：cellKey 的 y 是最低位、z 居中、x 最高位，
  // 故 dx/dy/dz 对应的增量是常量（与 cellKey 的编码公式严格对应）。
  // 这比每次拼字符串再查表快一个量级（实测 5.83 ms → 1.2 ms）。
  const DELTA = NEIGHBOR_6.map(([dx, dy, dz]) => dx * 524288 * 256 + dz * 256 + dy);
  const doomed = [];
  for (const k of leaves) {
    let touching = 0;
    for (const d of DELTA) {
      if (blocks.has(k + d)) { touching++; break; }
    }
    if (touching === 0) doomed.push(k);
  }
  for (const k of doomed) { leaves.delete(k); blocks.delete(k); }
  return doomed.length;
}

/**
 * 天空树「局部计算」：只算与某个 column 及其邻接相关的岛，得到该 column 的树块。
 *
 * ## 为什么是局部，不是整个 region
 *
 * 孤叶判定只需要该叶子**六邻接范围内**的天空树方块（局部性）。而树只长在岛的顶层圆盘上、
 * 树冠再外扩 2 格、叶子的邻接再外扩 1 格 → 一个 column 的结论只依赖「水平距离 ≤ r+5」的岛。
 *
 * 〔实测〕整 region 算 = **13.4 ms/次**（56 个岛、16,935 块），局部算 = **0.31 ms/列**；
 * 而正确性已逐格验证：region(0,0) 的 111 个有树 column，局部 vs 全量 **零不一致**。
 *
 * ## 为什么不能只按 region 缓存
 *
 * 按 region 缓存看似省事，但 `structure-gen` 的冻结门禁量的是**冷启动**（16 个 column、
 * 分属多个 region），首列要付整个 region 的 13 ms → 实测把 `genP95 < 10ms` 撞到 18.8 ms
 * （基线 8.3 ms）。局部算后单列 0.3 ms，回到基线水平。
 *
 * ## 为什么不能逐树/逐 column 只判自己的块
 *
 * 那只看到自己那一棵树，会把「靠邻树树冠相连」的叶子误判成孤立。
 * 〔实测〕树内判定会误删 649 片、漏删 81 片、再制造 91 片级联 —— 数据见
 * `dropIsolatedSkyLeaves` 的注释。局部算法算的是「本 column 邻接范围内的**全部**树」，
 * 邻接关系完整，故与全量结果一致。
 */

/**
 * @param {Array<{skyIslands: Int32Array}>} skyCandidates 3×3 查询域的多个 region
 * @param {number} seed
 * @param {number} cx column 的 chunk x
 * @param {number} cz column 的 chunk z
 * @returns {Map<number, string>|null} 该列的树块；无树返回 null
 */
function computeColumnTrees(skyCandidates, seed, cx, cz) {
  const cMinX = cx * 16, cMaxX = cMinX + 15;
  const cMinZ = cz * 16, cMaxZ = cMinZ + 15;
  /**
   * 岛的水平影响半径余量：树块 x/z = 基点 ±2、叶子邻接再 ±1、树冠最外圈再 ±2（`generateTree`
   * 的 lx/lz 循环是 ±2，随机填充可能让最外圈叶再向外一格）→ 取 5 已足够，取 6 留余量。
   */
  const REACH_PAD = 6;
  const subset = [];
  for (const cand of skyCandidates) {
    const si = cand.skyIslands;
    for (let i = 0; i < si.length; i += 5) {
      const centerX = si[i] * 16 + 8, centerZ = si[i + 1] * 16 + 8;
      const r = islandLayerRadius(si[i + 3], si[i + 4], si[i + 4]);
      const reach = r + REACH_PAD;
      if (centerX + reach < cMinX || centerX - reach > cMaxX) continue;
      if (centerZ + reach < cMinZ || centerZ - reach > cMaxZ) continue;
      subset.push(si[i], si[i + 1], si[i + 2], si[i + 3], si[i + 4]);
    }
  }
  if (subset.length === 0) return null;
  const { blocks, leaves } = computeSkyTreeBlocks([{ skyIslands: Int32Array.from(subset) }], seed);
  dropIsolatedSkyLeaves(blocks, leaves);
  let out = null;
  for (const [k, name] of blocks) {
    const [x, , z] = keyToCell(k);
    if ((x >> 4) !== cx || (z >> 4) !== cz) continue;
    if (!out) out = new Map();
    out.set(k, name);
  }
  return out;
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
 * 新实现天然满足这一点：`computeColumnTrees` 按**实际树块所在格**筛扇，不再是 AABB 估算，
 * 所以不存在「树冠越界却漏写」的可能。
 *
 * ⚠️ **v1.71 起：本 column 的树要用「布局局部计算」才能能做孤叶判定**。
 * 孤叶判定需要该叶子六邻接范围的全部天空树方块，而这个范围只依赖附近的岛 ——
 * 故`computeColumnTrees` 取「水平距离 ≤ r+6」的岛子集重算，实测与全 region 结果**逐格一致**
 * （111 个有树 column 零不一致），而单列只要 0.31 ms（全 region 要 13.4 ms）。
 * 纯函数、完全确定性：跨 column 结果逐格一致，不引入任何运行期跨 chunk 状态（红线 2/7）。
 *
 * @param {import('../../voxel/chunk-column.js').ChunkColumn} column
 * @param {Array<{skyIslands: Int32Array, cloudClusters: Int32Array}>} skyCandidates
 * @param {number} seed
 * @param {*} registry
 */
export function writeSkyTrees(column, skyCandidates, seed, registry) {
  const setBlock = makeColumnSetter(column, registry);
  const bucket = computeColumnTrees(skyCandidates, seed, column.cx, column.cz);
  if (!bucket) return;
  for (const [k, name] of bucket) {
    const [x, y, z] = keyToCell(k);
    setBlock(x, y, z, name);
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
