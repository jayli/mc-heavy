// src/gen/structures/azalea-trees.js — 杜鹃树（Azalea Trees Epic）
//
// 替换原来代码生成的杜鹃树（`vegetation.js` 的 `azalea` 分支：高 6~8、冠 5×5、约 34 格）——
// 改用 `asset_oak.schem` 里**杜鹃主题行的 10 档造型**（高 12~29、冠 8~13、223~1352 格），1:1 原生尺度。
//
// 两段式（与 giant-trees.js 同构，红线 2：禁止预生成、禁止运行期分发状态）：
//   region layout 层  computeAzaleaTreeCandidates()：候选点 = 全局对齐网格 + 内缩抖动（无状态、跨 region 无缝、
//                     间距由构造保证），谓词（AZALEA biome + 陆上）只对每格 ≤1 个点求值；
//   column 应用层     applyAzaleaTrees()：合并 3×3 邻域候选 → 按 AABB 取交 → 排除（城市/地标/高台/金字塔）
//                     → 逐格光栅化 → 地基填充 → 返回「旧植被抑制」覆盖窗口。
//
// Worker 同构：本文件不得 import three、不得自建 Worker。
//
// ⚠️ 与 mc-lite 无对应物（mc-lite 的杜鹃树是代码生成的 5×5 小树）；树形数据来自 asset_oak.schem
//    （离线烘焙，见 tools/bake-azalea-trees.mjs），**不是**对 mc-lite 的移植。
import { seededRandom, getBiome } from '../noise.js';
import { generateHeight } from '../terrain.js';
import { makeColumnSetter } from './landmarks.js';
import { REGION_SIZE } from './region-config.js';
import { SKY_TREE_CHANCE, SKY_TREE_SALT, islandLayerRadius } from './sky-structures.js';
import { getGiantTreesSync, GIANT_FAMILY_ORDER, giantTreeRotation, rotateCell as giantRotateCell, treeBox as giantTreeBox } from './giant-trees.js';
import { SEA_Y } from '../../voxel/constants.js';
import { resourceUrl } from '../../core/resource-url.js';

/** 候选数组的 stride：[wx, wy, wz, sizeIdx] */
export const AZALEA_STRIDE = 4;

/**
 * 变体数 = 烘焙产物的档数（10，由小到大）。与 `tools/azalea-trees-fingerprint.mjs` 的
 * `VARIANT_COUNT` 同值 —— 运行时用它把 `variantHash % N` 落成变体下标。
 */
export const AZALEA_VARIANT_COUNT = 10;

/**
 * 带花叶概率 —— **用户 2026-10-28 裁定的口径：沿用旧杜鹃树的 30%**。
 *
 * 素材里花的分布（`flowering_azalea_leaves`）是作者作死的，若直接沿用会与旧树观感脱节；
 * 若把三种叶都按素材原样保留则花只占 5~12%。故烘焙时三种叶统一映射到 `LEAF` 哨兵槽，
 * 光栅化时逐格按本概率掷 —— 规则与 `vegetation.js` 的旧 azalea 分支**同一条**。
 */
export const AZALEA_FLOWER_CHANCE = 0.3;

/**
 * 地基填充的最大深度（与巨树同口径：地表 h ≤ 16、树高 ≤ 29，悬空量实测 p99 = 3、最大 9）。
 * 超出上限则不补 —— 宁可留空也不在平原上插一根 29 格高的树干柱子。
 */
export const AZALEA_SUPPORT_MAX = 10;

/**
 * 杜鹃树干与其他树干的**最小水平间距**（用户 2026-10-28 裁定：≥6 格）。
 *
 * 判据只作用于「树干」，**树叶不受限制**（用户明确：「树叶也可以相交，但是树干……还是要尽量隔开」）：
 * 树冠重叠是密林的观感，树干贴脸才是「两棵树搅在一起」。
 *
 * ⚠️ **只让杜鹃树避让，不改其他树的生成**（用户裁定「我只处理杜鹃花树和其他树的打架，其他树不管」）：
 * 其他树的既有布局一个方块都不动（零回归），只在杜鹃树的落位判据里避开它们。
 *
 * 实测冲突来源（seed 12345，整片 region）：
 *   · **空岛树**（`sky_wood`，Y≥55）41 处 —— 最大来源，`seededRandom(wx,wz,seed+113) < 0.05` 纯函数可预测；
 *   · **巨树锚点** 5 处 —— 候选数组已在 layouts 里，可直接读；
 *   · 普通树（`wood`/`birch_log`…）**0 处** —— AZALEA biome 里 `rollVegetation` 的树分支恒空。
 * 故判据只需覆盖前两类（第三类留作纵深防御的采样，见 `collectOtherTrunks`）。
 */
export const AZALEA_TRUNK_CLEARANCE = 6;

/**
 * 树干位置的**空间哈希网格**（cell 边长 = 查询半径）。
 *
 * 为什么不直接用数组 + 逐点距离：候选层有 625 格/region、空岛树在 AZALEA 区域可达数千个位点，
 * 朴素两层循环是 O(n×m)（实测 729 候选 × 7037 空岛树 = 513 万次距离计算 ≈ 40ms/region，撞 GEN 预算）。
 * 网格把每次查询降到「3×3 个 cell」。
 *
 * ⚠️ **cell 边长必须 ≥ 查询半径，且查询窗口要按边长算够** —— 这是本类唯一的正确性前提。
 * 一版写成「cell 边长 = clearance、扫 ±1 个 cell」，实测**漏判**：
 * 查询点 (0,0)、邻点 (-6.5,0) 落在 `floor(-6.5/6) = -2` 号 cell，而 ±1 只扫到 -1 → 返回 Infinity
 * （真正的距离是 6.5，应当拦下）。负坐标下 `floor` 向 -∞ 取整使「一个 cell」的跨度不对称，
 * 这类 off-by-one 只在负坐标出现 —— 本仓世界无边界、负坐标是常态。
 *
 * 现写法：cell 边长 = `spacing`（默认 2×clearance），查询扫 `±ceil(r/size)` 个 cell。
 * 取 2× 是为了让「半径 6 只扫 ±1 圈」（±1 × 12 = 12 ≥ 6，覆盖两圈仍过度，但一次 9 个 cell 很快）。
 */
export class TrunkGrid {
  constructor(cellSize = AZALEA_TRUNK_CLEARANCE * 2) {
    this.cellSize = cellSize;
    /** @type {Map<string, Array<[number, number]>>} key = `${ci},${cj}` */
    this.cells = new Map();
    this.size = 0;
  }

  _key(ci, cj) { return `${ci},${cj}`; }

  add(wx, wz) {
    const cs = this.cellSize;
    const k = this._key(Math.floor(wx / cs), Math.floor(wz / cs));
    let arr = this.cells.get(k);
    if (!arr) { arr = []; this.cells.set(k, arr); }
    arr.push([wx, wz]);
    this.size++;
  }

  /**
   * 到最近记录点的水平距离；网格为空返回 Infinity。
   * 扫描 `±ceil(maxR / cellSize)` 圈（maxR 默认 = clearance）：这样无论 cellSize 取多少，
   * 只要 `cellSize >= clearance` 就一定能看到所有可能更近的点（不会因负坐标的 floor 方向漏判）。
   */
  nearestDistance(wx, wz, maxR = AZALEA_TRUNK_CLEARANCE) {
    const cs = this.cellSize;
    const ci = Math.floor(wx / cs), cj = Math.floor(wz / cs);
    const span = Math.max(1, Math.ceil(maxR / cs));
    let best = Infinity;
    for (let i = ci - span; i <= ci + span; i++) {
      for (let j = cj - span; j <= cj + span; j++) {
        const arr = this.cells.get(this._key(i, j));
        if (!arr) continue;
        for (const [px, pz] of arr) {
          const dx = px - wx, dz = pz - wz;
          const d2 = dx * dx + dz * dz;
          if (d2 < best) best = d2;
        }
      }
    }
    return Math.sqrt(best);
  }
}

/** 该位置是否满足「距最近树干 ≥ clearance」。**闭区间**：正好等于 clearance 算通过。 */
export function isTrunkClear(wx, wz, grid, clearance = AZALEA_TRUNK_CLEARANCE) {
  return grid.nearestDistance(wx, wz) >= clearance;
}

/**
 * 一棵巨树的 y=0 层树干列（世界水平坐标）。**复用巨树的旋转/锚点放大口径**（不重写公式）。
 *
 * 巨树的候选 stride = 5：[wx, wy, wz, familyIdx, variantHash]；变体由
 * `families[GIANT_FAMILY_ORDER[familyIdx]][variantHash % len]` 选出，朝向由
 * `giantTreeRotation(wx, wz, seed)` 算 —— 与 `giant-trees.js resolveTree` 同一套。
 * 变体数据未加载（`getGiantTreesSync()` 为 null）时返回 null，调用方退化为锚点。
 */
function giantTrunkColumns(giantData, arr, i, wy) {
  if (!giantData || !giantData.families) return null;
  const list = giantData.families[GIANT_FAMILY_ORDER[arr[i + 3]]];
  if (!list || list.length === 0) return null;
  const v = list[arr[i + 4] % list.length];
  if (!v) return null;
  // 朝向的 seed 必须与巨树用的一致 —— `giantTreeRotation` 只吃 (wx, wz)，但需要 seed；
  // 这里由调用方传入的 seed 通过闭包不可得，故把 seed 挂在 giantData 上不可行 →
  // 改用「全 4 个朝向的树干列并集」：偏保守（多拦几格），但**不会漏判**，
  // 且免去在两处同步 seed 的耦合（两份 seed 来源漂移会静默漏判，代价远大于多拦）。
  const wx = arr[i], wz = arr[i + 2];
  const out = new Map();
  for (let rot = 0; rot < 4; rot++) {
    const box = giantTreeBox(v, rot, wx, wz);
    const cells = v.cells;
    for (let k = 0; k < cells.length; k += 4) {
      if (cells[k + 1] !== 0) continue; // 只要 y=0 层（树干底格）
      const [rx, rz] = giantRotateCell(v, rot, cells[k], cells[k + 2]);
      const px = box.x0 + rx, pz = box.z0 + rz;
      out.set(`${px},${pz}`, [px, pz]);
    }
  }
  void wy; void giantTreeRotation;
  return [...out.values()];
}

/**
 * 收集窗口内**其他树**的树干位置（不含杜鹃树自己 —— 自己人由 `applyAzaleaTrees` 逐棵插入网格时处理）。
 *
 * 两类来源，都是**纯函数可预测**的（不依赖其他树是否已写入 column）：
 *   ① 巨树锚点（`layout.giantTrees` 的三条路径数组，stride 5）；
 *   ② 空岛树基点（`layout.sky.skyIslands`，stride 5 = [cx, cz, bottomY, radius, height]；
 *      树基点 = 岛顶层圆内、`seededRandom(wx, wz, seed + SKY_TREE_SALT) < SKY_TREE_CHANCE` 的格）。
 *
 * ⚠️ **空岛树必须在这里预测，不能靠探 column**：阶段 2.85（杜鹃树）跑在阶段 2.5（空岛）
 * **之前** —— 那时 `sky_wood` 一个都还没写进 column（这是本判据必须放在候选层的直接原因）。
 * 判据与 `writeSkyTrees` 共用 `SKY_TREE_CHANCE` / `SKY_TREE_SALT` / `islandLayerRadius` 三份权威
 * （从 sky-structures.js import，不重写字面量 —— 否则两处漂移出「预测的位置与实际种下的不一致」）。
 *
 * 巨树的锚点偏移：巨树树干在锚点附近（AABB 内 ±2），这里按锚点算 —— 6 格的判据对 ±2 有足够余量。
 */
export function collectOtherTrunks(layouts, seed, families, win, giantData = null) {
  const grid = new TrunkGrid();
  for (const layout of layouts) {
    if (!layout) continue;
    // ① 巨树树干列
    //
    // ⚠️ **不能只加锚点**：实测巨树的 y=0 层树干有 1~19 列、相对锚点最多偏 **±5 格**
    // （cherry 变体锚点 [8,8]，树干铺满 17×17 的中段）。只用锚点会让「杜鹃树干离巨树树干
    // 只有 1 格」的情形漏判 —— 换 seed 424242 实测 57 处违反、minVsDist = **1**。
    // 故按候选里的 (族, 变体 hash, 朝向) 展开真实树干列；变体数据未加载时退化为锚点
    // （保守但漏判，故 GEN 入口必先 `await loadAzaleaTrees()`；巨树数据同理）。
    const gt = layout.giantTrees;
    if (gt) {
      // ⚠️ `getGiantTreesSync()` 在**页面主线程恒 null**（巨树数据只在 Worker 里加载 —— 见 AGENTS.md）。
      // 故优先用调用方传入的 giantData（Worker 内 apply.js 已 await loadGiantTrees()），
      // 退回模块缓存只是为了「同构层自洽」而不指望它在页面里可用。
      const giants = giantData || getGiantTreesSync();
      for (const key of Object.keys(gt)) {
        const arr = gt[key];
        if (!arr || arr.length === 0) continue;
        for (let i = 0; i < arr.length; i += 5) {
          const wx = arr[i], wy = arr[i + 1], wz = arr[i + 2];
          // 廉价预筛：最宽巨树 AABB 17 + 锚点偏移 5 → 离窗口超过 24 格不可能靠得近
          if (wx < win.minX - 24 || wx > win.maxX + 24 || wz < win.minZ - 24 || wz > win.maxZ + 24) continue;
          const cols = giantTrunkColumns(giants, arr, i, wy);
          if (cols) {
            for (const [px, pz] of cols) {
              if (px < win.minX || px > win.maxX || pz < win.minZ || pz > win.maxZ) continue;
              grid.add(px, pz);
            }
          } else if (wx >= win.minX && wx <= win.maxX && wz >= win.minZ && wz <= win.maxZ) {
            grid.add(wx, wz); // 兜底：变体数据缺失时退化到锚点
          }
        }
      }
    }
    // ② 空岛树基点
    const sky = layout.sky;
    if (sky && sky.skyIslands) {
      const arr = sky.skyIslands;
      for (let i = 0; i < arr.length; i += 5) {
        const centerX = arr[i] * 16 + 8, centerZ = arr[i + 1] * 16 + 8;
        const radius = arr[i + 3], height = arr[i + 4];
        const topY = arr[i + 2] + height;
        void topY;
        // 顶层圆半径（`islandLayerRadius(radius, height, height)`，与 writeSkyTrees 同口径）
        const r = islandLayerRadius(radius, height, height);
        // AABB 预筛（树冠外扩 ±2 已在 writeSkyTrees 里使用同一口径）
        if (centerX + r + 2 < win.minX || centerX - r - 2 > win.maxX ||
            centerZ + r + 2 < win.minZ || centerZ - r - 2 > win.maxZ) continue;
        for (let dx = -r; dx <= r; dx++) {
          for (let dz = -r; dz <= r; dz++) {
            if (dx * dx + dz * dz > r * r) continue;
            const wx = centerX + dx, wz = centerZ + dz;
            if (wx < win.minX || wx > win.maxX || wz < win.minZ || wz > win.maxZ) continue;
            if (seededRandom(wx, wz, seed + SKY_TREE_SALT) < SKY_TREE_CHANCE) grid.add(wx, wz);
          }
        }
      }
    }
  }
  void families;
  return grid;
}

/**
 * 落位路径：**单条**，只落 AZALEA biome 的陆上。
 *
 * 密度旋钮（用户 2026-10-28 裁定：中等 C=16）：
 *   cell 边长 C = spacing + jitter = 8 + 5 = 13；每格至多 1 个点，落在格内 [0, jitter) × [0, jitter) 的内缩方块里
 *   ⇒ 相邻格的点切比雪夫距离 ≥ spacing + 1 = 9（构造性保证，不需要贪心/排序/跨 region 协调）。
 *
 * 实测（seed 12345）：AZALEA 占陆地采样 4.6%；视距 8 的 272×272 加载域内 AZALEA 面积 ≈ 3400 格²
 *   ⇒ 视域内约 **13 棵**，cutout 顶点 ≈ **50K**（初始容量 2.20M 的 2.3%，零扩容）。
 *   每 100×100 格约 39 棵，叶面覆盖率 ≈ 38%（俯视投影占地图比例）。
 *
 * ⚠️ **必须用网格抖动，不能沿用旧树的「逐格 4.5% 独立抽签」**：旧树只有 5×5 冠幅，互相重叠只是
 * 「灌木丛」；新造型冠幅 8~13，按旧密度（每 100×100 约 450 棵）会叠成一整块不透光的叶子山。
 *
 * 密度调法（与巨树同口径）：**拉大 spacing，不降 chance** —— 间距能让「每棵树都落在均匀格子里」，
 * 降 chance 会把格子挖空成成片空缺。密度减半 = cell 边长 ×√2。
 *
 * salt 用 1001~1003（程序化扫描确认空闲：src 下 1000/1020~1033 已占，1001~1019 空闲）。
 * ⚠️ **不要 grep 字面量判 salt 是否空闲** —— 带 `+ step` 偏移的调用点占用的是区间。
 */
export const AZALEA_TREE_PATH = Object.freeze({
  key: 'azalea', salt: 1001, spacing: 8, jitter: 5,
  /** 花叶掷签的 salt（与候选层分开，互不干扰） */
  flowerSalt: 1004,
});

/** 树朝向 0~3（90° 步进）。**必须 floor(r*4)**：seededRandom 返回 [0,1) 浮点，`& 3` 恒为 0。 */
export function azaleaTreeRotation(wx, wz, seed) {
  return Math.floor(seededRandom(wx, wz, seed + AZALEA_TREE_PATH.salt + 5) * 4);
}

/**
 * 该格是否是带花叶。**由世界坐标驱动**（不是局部下标、不是循环计数器）——
 * 这是「同一棵树被切到两个 column 时光位一致」的唯一保证（跨 column / 跨 Worker 同构）。
 * @returns {boolean} true = azalea_flowers，false = azalea_leaves
 */
export function azaleaFlowerAt(wx, wy, wz, seed) {
  // 三者各用不同的轴组合，避免 (x,y,z) 在同一平面上退化（与 vegetation.js 的 treeRand 同手法）
  return seededRandom(wx + wy * 11, wz, seed + AZALEA_TREE_PATH.flowerSalt) < AZALEA_FLOWER_CHANCE;
}

// ---------------------------------------------------------------- 候选发现（region 层）

/** 地表高度；陆上（> SEA_Y）且 biome 是 AZALEA 才可能落树。返回 null = 不满足。 */
function azaleaEligible(wx, wz, seed) {
  if (getBiome(wx, wz, seed) !== 'AZALEA') return null;
  const h = generateHeight(wx, wz, seed);
  return h > SEA_Y ? h : null;
}

/**
 * 单个 region 的候选（纯函数、确定性、与 region 邻居无关）。
 *
 * cell 按全局网格对齐（cell 下标 = floor(世界坐标 / C)），一个点属于它所在的 region
 * ⇒ 跨 region 的 cell 由两侧各算一次、各自只保留落在本 region 内的点，不重复、不遗漏。
 * @returns {Int32Array} stride = AZALEA_STRIDE
 */
export function computeAzaleaTreeCandidates(regionX, regionZ, seed, path = AZALEA_TREE_PATH) {
  const C = path.spacing + path.jitter;
  const x0 = regionX * REGION_SIZE, z0 = regionZ * REGION_SIZE;
  const i0 = Math.floor(x0 / C), i1 = Math.floor((x0 + REGION_SIZE - 1) / C);
  const j0 = Math.floor(z0 / C), j1 = Math.floor((z0 + REGION_SIZE - 1) / C);
  const out = [];
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const wx = i * C + Math.floor(seededRandom(i, j, seed + path.salt + 1) * path.jitter);
      const wz = j * C + Math.floor(seededRandom(i, j, seed + path.salt + 2) * path.jitter);
      if (wx < x0 || wx >= x0 + REGION_SIZE || wz < z0 || wz >= z0 + REGION_SIZE) continue;
      const h = azaleaEligible(wx, wz, seed);
      if (h === null) continue;
      // 档位下标 ∈ [0, AZALEA_VARIANT_COUNT)。与巨树的区别：巨树一个族内有 4~8 个变体、候选层
      // 拿不到变体数（loadGiantTrees 异步）故存原始 hash；杜鹃树的「档」就是变体本身，档数在
      // src 侧是常量（烘焙产物的档数由 test-azalea-trees 的加载用例钉住），故直接算下标 ——
      // 少一个死字段（巨树的 variantHash 有用途，这里照搬会变成无消费者的第 5 项）。
      const sizeIdx = Math.floor(seededRandom(i, j, seed + path.salt + 4) * AZALEA_VARIANT_COUNT);
      out.push(wx, h + 1, wz, sizeIdx % AZALEA_VARIANT_COUNT);
    }
  }
  return Int32Array.from(out);
}

// ---------------------------------------------------------------- 变体加载与几何

let cache = null;
let loading = null;

/**
 * 加载烘焙产物（每个 Worker / 页面线程各一份，模块级缓存）。
 * `cells` 是扁平 Uint8Array 四元组 [gx, gy, gz, palIdx, …]（palIdx ≤ 1，装得下 Uint8）。
 * 失败不抛、不缓存：返回空 variants（本次 GEN 无杜鹃树），下一次调用会重试 ——
 * 与 giant-trees.js / structure-json.js 同口径，避免某个 Worker 永远无树。
 */
export function loadAzaleaTrees() {
  if (cache) return Promise.resolve(cache);
  if (!loading) {
    // 部署路径无关（v1.87）：走 resourceUrl，仓库挂子路径部署时不 404（否则树静默消失）。
    loading = fetch(resourceUrl('assets/azalea-trees/trees.json')).then((r) => r.json()).then((data) => {
      const variants = (data.trees || []).map((v) => ({
        pad: v.pad, w: v.w, d: v.d, h: v.h, anchor: v.anchor, palette: v.palette, cells: Uint8Array.from(v.blocks),
      }));
      cache = { variants, leafSlot: data.leafSlot || 'LEAF' };
      return cache;
    }).catch(() => { loading = null; return { variants: [], leafSlot: 'LEAF' }; });
  }
  return loading;
}

/** 同步读模块缓存；未加载完成返回 null（GEN 入口会先 await loadAzaleaTrees()） */
export function getAzaleaTreesSync() { return cache; }

/**
 * 变体下标 → 档位。对 `AZALEA_VARIANT_COUNT` 取模（负值也归正），越界兜底 0。
 * 候选层已经算好合法下标，这里只做防御 —— 但**必须是唯一一处**取模：光栅化与测试都走它
 * （两处各写一份 `% N` 会在 N 改动时漂移出「候选说 7 档、渲染出 3 档」）。
 */
export function azaleaTreeSize(sizeIdx) {
  const n = AZALEA_VARIANT_COUNT;
  return ((sizeIdx % n) + n) % n;
}

/**
 * 绕 AABB 顺时针旋转 90° × rot 后的局部坐标：rot=1 时 (x,z) → (d-1-z, x)。
 * 非正方形 AABB 旋转后宽深互换，调用方必须用 rotatedFootprint 取旋转后的 w/d。
 */
export function rotateCell(v, rot, x, z) {
  switch (rot & 3) {
    case 0: return [x, z];
    case 1: return [v.d - 1 - z, x];
    case 2: return [v.w - 1 - x, v.d - 1 - z];
    default: return [z, v.w - 1 - x];
  }
}

/** 旋转后的 AABB 宽深（rot 为奇数时互换） */
export function rotatedFootprint(v, rot) {
  return (rot & 1) === 1 ? { w: v.d, d: v.w } : { w: v.w, d: v.d };
}

/** 树的世界 AABB（闭区间）与原点：锚点对齐候选点 (wx, wz) */
export function treeBox(v, rot, wx, wz) {
  const fp = rotatedFootprint(v, rot);
  const a = rotateCell(v, rot, v.anchor[0], v.anchor[1]);
  const x0 = wx - a[0], z0 = wz - a[1];
  return { x0, z0, x1: x0 + fp.w - 1, z1: z0 + fp.d - 1 };
}

// ---------------------------------------------------------------- column 层

/** 候选 → 树对象（含变体、朝向、世界 AABB）。变体缺失（加载失败）则跳过。 */
function resolveTree(arr, i, seed, variants) {
  if (variants.length === 0) return null;
  // 烘焙产物的档数理论上 == AZALEA_VARIANT_COUNT（加载用例钉住），这里再对实际长度取模作纵深防御。
  const variant = variants[azaleaTreeSize(arr[i + 3]) % variants.length];
  if (!variant) return null;
  const wx = arr[i], wy = arr[i + 1], wz = arr[i + 2];
  const rot = azaleaTreeRotation(wx, wz, seed);
  return { wx, wy, wz, variant, rot, ...treeBox(variant, rot, wx, wz) };
}

/**
 * 收集与窗口 [minX-ext, maxX+ext]×[minZ-ext, maxZ+ext] 相交的树（AABB 外扩 ext 后相交即收），
 * 合并**全部**邻域 layouts（拼接而非覆盖），并按 (wx, wz) 排成**规范顺序** ——
 * 逐格「后写胜」的结果因此与 layouts 的下发顺序无关。
 * @param {Array<Object>} layouts 查询域内 region 布局（每项可带 azaleaTrees）
 */
export function collectAzaleaTrees(layouts, seed, variants, win, ext) {
  const trees = [];
  for (const layout of layouts) {
    const arr = layout && layout.azaleaTrees;
    if (!arr || arr.length === 0) continue;
    for (let i = 0; i < arr.length; i += AZALEA_STRIDE) {
      // 廉价预筛：最大树宽 13、锚点偏移 ≤ 3 → 候选点离窗口超过 17 格的不可能相交
      if (arr[i] < win.minX - 17 || arr[i] > win.maxX + 17 || arr[i + 2] < win.minZ - 17 || arr[i + 2] > win.maxZ + 17) continue;
      const t = resolveTree(arr, i, seed, variants);
      if (!t) continue;
      if (t.x1 + ext < win.minX || t.x0 - ext > win.maxX || t.z1 + ext < win.minZ || t.z0 - ext > win.maxZ) continue;
      trees.push(t);
    }
  }
  trees.sort((a, b) => a.wx - b.wx || a.wz - b.wz);
  return trees;
}

/**
 * 一棵杜鹃树的**全部树干列**（世界水平坐标）。判据必须按这个集合算，不能只看锚点。
 *
 * ⚠️ **实测踩到**：素材各档的 y=0 层树干是 1~6 列、相对锚点最多偏 **±2 格**
 * （#0/#1 单列偏移 0，#3~#7 偏移到 2）。只用锚点判「距其他树干 ≥6」时，锚点距离 6.71 通过，
 * 但树干的某一列实际只离空岛树干 **5.39 格** —— 判据形同虚设（实测 23 处违反）。
 * 故判据落在**列的集合**上：任一列 < clearance 即整棵拒。
 *
 * @returns {Array<[number, number]>} 世界坐标的树干列（去重后）
 */
export function trunkColumnsOf(variant, rot, x0, z0) {
  const out = new Map();
  const cells = variant.cells;
  for (let k = 0; k < cells.length; k += 4) {
    // y=0 层 + 树干槽（palette[0]）才是「树干底格」——地基填充也从这些列往下补
    if (cells[k + 1] !== 0 || cells[k + 3] !== 0) continue;
    const [rx, rz] = rotateCell(variant, rot, cells[k], cells[k + 2]);
    out.set(`${x0 + rx},${z0 + rz}`, [x0 + rx, z0 + rz]);
  }
  return [...out.values()];
}

/**
 * 树干间距贪心（**跨 column 确定性**的关键）。
 *
 * 输入是**固定的候选全集**（该 column 的 3×3 邻域 region 全部杜鹃候选），输出按 (wx, wz)
 * 规范顺序逐个接受、落一个就把位置加进网格 —— 因此同一个候选在**任何** column 里算出的
 * 「接受/拒绝」结论都相同（判据只依赖候选全集与全序，与 column 无关）。
 *
 * ⚠️ **不能按 column 各自贪心**（v2.0 第一版就是这样，实测 `selfMin=1` 完全没生效）：
 * 两棵分属相邻 column 的杜鹃树在各自 column 的候选集里都「第一名」，各自都通过 → 合起来只隔
 * 1 格。这是「跨 column 协调」的经典坑（本仓 M6 的跨实体协调同源）。
 *
 * 也**不能省掉贪心**指望「region 内候选间距 ≥ spacing+1=9 > 6」：那只保证 region **内部**，
 * 相邻 region 各自独立选点，跨边界仍可能 <6（实测存在）。
 *
 * @param {Array<{wx:number,wz:number}>} candidates 已按 (wx,wz) 排序的候选全集
 * @param {TrunkGrid} blocked 「其他树」的树干网格（只读，不往里加）
 * @returns {Set<string>} 被接受候选的 `"wx,wz"` 键集合
 */
export function acceptAzaleaTrunks(candidates, blocked, clearance = AZALEA_TRUNK_CLEARANCE) {
  const own = new TrunkGrid();
  const accepted = new Set();
  for (const c of candidates) {
    // 树的**每一根**树干列都要满足，不只锚点（见 trunkColumnsOf 的实测说明）
    const cols = c.trunkCols || trunkColumnsOf(c.variant, c.rot, c.x0, c.z0);
    let ok = true;
    for (const [wx, wz] of cols) {
      if (!isTrunkClear(wx, wz, blocked, clearance) || !isTrunkClear(wx, wz, own, clearance)) { ok = false; break; }
    }
    if (!ok) continue;
    accepted.add(`${c.wx},${c.wz}`);
    for (const [wx, wz] of cols) own.add(wx, wz);
  }
  return accepted;
}

/**
 * 排除判定（纯函数，对「覆盖这棵树的任一 column」结论恒一致 —— 它只依赖树本身与 allowedAt）：
 * AABB 九点（四角 + 四边中点 + 中心）与锚点：allowedAt 必须全真。
 * allowedAt 由 apply.js 用 pointContext + biome 构造（只允许 AZALEA biome 的 natural 陆地）。
 */
export function isAzaleaTreeAllowed(t, allowedAt, crownAllowedAt = allowedAt) {
  // 九点（树冠范围）用 crownAllowedAt，锚点用 allowedAt —— 两者语义不同，见 apply.js 的
  // `azaleaCrownAllowedAtFor` 注释（用同一个严格判据会让 70% 的候选被拒、密林落空）。
  const mx = (t.x0 + t.x1) >> 1, mz = (t.z0 + t.z1) >> 1;
  const xs = [t.x0, mx, t.x1], zs = [t.z0, mz, t.z1];
  for (const x of xs) for (const z of zs) if (!crownAllowedAt(x, z)) return false;
  return allowedAt(t.wx, t.wz);
}

/**
 * 把一棵树写进 column（setBlock 自带 column 裁剪）+ 地基填充。
 *
 * **花叶相间**：叶子槽（palette[1] === LEAF）按 `azaleaFlowerAt(世界坐标)` 逐格掷成
 * `azalea_flowers` 或 `azalea_leaves` —— 与旧杜鹃树同一条 30% 规则，且由世界坐标驱动
 * （跨 column / 跨 Worker 一致，不会出现「同一棵树两半花位不同」）。
 *
 * 地基：y=0 层的树干格（palette[0]）下方若悬空（地表 h < wy-1），用同种树干向下补到 h+1
 * （≤ AZALEA_SUPPORT_MAX 格）。对应既有 GROUND_SUPPORT_TYPES 机制（structure-json.js）的同一语义；
 * 这里直接用 generateHeight（纯函数、跨 column 一致），不探 column 内容 —— 探测在 column 边缘取不到邻列数据。
 */
export function rasterizeAzaleaTree(setBlock, t, seed) {
  const v = t.variant, cells = v.cells, pal = v.palette;
  for (let k = 0; k < cells.length; k += 4) {
    const [rx, rz] = rotateCell(v, t.rot, cells[k], cells[k + 2]);
    const wx = t.x0 + rx, wy = t.wy + cells[k + 1], wz = t.z0 + rz;
    let name = pal[cells[k + 3]];
    if (name === 'LEAF') {
      name = azaleaFlowerAt(wx, wy, wz, seed) ? 'azalea_flowers' : 'azalea_leaves';
    }
    setBlock(wx, wy, wz, name);
    if (cells[k + 1] === 0 && cells[k + 3] === 0) {
      const depth = (t.wy - 1) - generateHeight(wx, wz, seed);
      if (depth >= 1 && depth <= AZALEA_SUPPORT_MAX) {
        for (let y = t.wy - 1; y > t.wy - 1 - depth; y--) setBlock(wx, y, wz, pal[0]);
      }
    }
  }
}

/**
 * 覆盖窗口：column 外扩 ext 的 (16+2ext)² 位图。树的**覆盖区 = AABB 外扩 ext**
 * （旧植被树冠半径 ≤ ext，树干落在覆盖区内的旧树，其树冠才可能碰到新树 AABB）。
 * `covers(wx,wz)` 对窗口外恒 false。
 * ⚠️ 只在本 column 内标记不够：阶段 3 的植被扫描会外扩 ext 格，column 外 3 格带里的旧树树干
 * 会把树冠写进本 column（巨树实测每 256 个 column 游离 5,332 格没有树干的旧树冠）。
 */
export function buildCoveredWindow(column, trees, ext) {
  const W = 16 + 2 * ext;
  const minX = column.cx * 16 - ext, minZ = column.cz * 16 - ext;
  const cov = new Uint8Array(W * W);
  for (const t of trees) {
    const xa = Math.max(t.x0 - ext, minX), xb = Math.min(t.x1 + ext, minX + W - 1);
    const za = Math.max(t.z0 - ext, minZ), zb = Math.min(t.z1 + ext, minZ + W - 1);
    for (let x = xa; x <= xb; x++) for (let z = za; z <= zb; z++) cov[(x - minX) + (z - minZ) * W] = 1;
  }
  return { covers: (wx, wz) => { const lx = wx - minX, lz = wz - minZ; return lx >= 0 && lz >= 0 && lx < W && lz < W && cov[lx + lz * W] === 1; } };
}

const NO_COVER = Object.freeze({ covers: () => false });

/**
 * column 层入口。
 * @param {import('../../voxel/chunk-column.js').ChunkColumn} column
 * @param {Array<Object>} layouts 查询域内 region 布局
 * @param {number} seed
 * @param {*} registry
 * @param {{allowedAt: (wx:number, wz:number) => boolean, ext: number}} ctx
 * @returns {{covers: (wx:number, wz:number) => boolean}} 旧植被抑制覆盖窗口
 */
export function applyAzaleaTrees(column, layouts, seed, registry, ctx) {
  const data = getAzaleaTreesSync();
  if (!data || data.variants.length === 0) return NO_COVER;
  const win = { minX: column.cx * 16, maxX: column.cx * 16 + 15, minZ: column.cz * 16, maxZ: column.cz * 16 + 15 };
  const candidates = collectAzaleaTrees(layouts, seed, data.variants, win, ctx.ext);
  if (candidates.length === 0) return NO_COVER;

  // 树干间距判据（v2.0）：先收「其他树」的树干，再按规范顺序逐棵落位，每落一棵就插进网格 ——
  // 这样**杜鹃树之间**也自动保持 ≥ AZALEA_TRUNK_CLEARANCE（用户：「树的树干还是要尽量隔开」）。
  //
  // 窗口取 AABB 外扩 ext：杜鹃树的树冠会伸进邻列，故邻列的树干位置也要算进判据，
  // 否则两棵分属相邻 column 的杜鹃树在各自 column 里都「通过」，合起来却贴脸。
  // ---- 树干间距判据（v2.0）----
  //
  // 关键：**候选全集与贪心顺序必须与 column 无关**，否则两棵分属相邻 column 的树各自「第一名」
  // 都通过 → 合起来贴脸（v2.0 第一版就是这样，实测 selfMin=1，完全没生效）。
  // 故这里用「3×3 邻域 region 的全部杜鹃候选」作为固定全集，按 (wx, wz) 规范顺序贪心 ——
  // 任何 column 都算出同一份 accepted 集合，本列只是从里面挑「落在我身上的」。
  //
  // 全集取 3×3 邻域而不是「本列的 AABB 窗口」：邻域 region 覆盖本列周边 400~1200 格，
  // 远超树 AABB(≤13) + clearance(6)，足以决定边界处的取舍；同时与
  // `neighborRegionKeys` / `layoutsForColumn` 的既有查询域**同一个口径**（不引入第二套范围）。
  //
  // `layouts` 就是本 column 的 3×3 邻域 region（`neighborRegionKeys` 的结果），故把窗口
  // 放到「全部 layouts 的外包」即可 —— 不要自己拼 region 半径（那会成为第二份范围权威）。
  let lx0 = Infinity, lx1 = -Infinity, lz0 = Infinity, lz1 = -Infinity;
  for (const l of layouts) {
    if (!l) continue;
    const x0 = l.regionX * REGION_SIZE, z0 = l.regionZ * REGION_SIZE;
    if (x0 < lx0) lx0 = x0;
    if (x0 + REGION_SIZE - 1 > lx1) lx1 = x0 + REGION_SIZE - 1;
    if (z0 < lz0) lz0 = z0;
    if (z0 + REGION_SIZE - 1 > lz1) lz1 = z0 + REGION_SIZE - 1;
  }
  // 兜底：合成场景（单测）的 layouts 可能不带 regionX/regionZ。退化为「本列的 AABB 窗口外扩
  // 一整棵树宽 + clearance」，足以容纳影响本列的候选（树半宽 ≤6、clearance 6）。
  const fullWin = Number.isFinite(lx0)
    ? { minX: lx0, maxX: lx1, minZ: lz0, maxZ: lz1 }
    : { minX: win.minX - 13, maxX: win.maxX + 13, minZ: win.minZ - 13, maxZ: win.maxZ + 13 };
  const fixedCandidates = collectAzaleaTrees(layouts, seed, data.variants, fullWin, ctx.ext);
  // 「其他树」的树干：巨树锚点 + 空岛树基点（纯函数可预测；见 collectOtherTrunks 注释）
  const otherGrid = ctx.otherTrunks
    || collectOtherTrunks(layouts, seed, data.variants, {
      minX: fullWin.minX - ctx.ext, maxX: fullWin.maxX + ctx.ext,
      minZ: fullWin.minZ - ctx.ext, maxZ: fullWin.maxZ + ctx.ext,
    }, ctx.giantData || getGiantTreesSync());

  const allowedAll = fixedCandidates.filter((t) => isAzaleaTreeAllowed(t, ctx.allowedAt, ctx.crownAllowedAt));
  const acceptedAll = acceptAzaleaTrunks(allowedAll, otherGrid);
  const accepted = allowedAll.filter((t) => acceptedAll.has(`${t.wx},${t.wz}`));
  if (accepted.length === 0) return NO_COVER;
  const setBlock = makeColumnSetter(column, registry);
  for (const t of accepted) {
    if (t.x1 < win.minX || t.x0 > win.maxX || t.z1 < win.minZ || t.z0 > win.maxZ) continue; // 只覆盖区相交、本列无方块
    rasterizeAzaleaTree(setBlock, t, seed);
  }
  return buildCoveredWindow(column, accepted, ctx.ext);
}
