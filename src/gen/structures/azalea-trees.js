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
import { inTarnRadius } from './tarn-zone.js';
import { rollVegetation } from './vegetation.js';

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
 * 杜鹃树干与其他树干的**最小水平间距**（**用户 2026-10-29 改为 3**；v2.0~v2.4 是 6）。
 *
 * 判据只作用于「树干」，**树叶不受限制**：树冠重叠是密林的观感。
 * ⚠️ **只让杜鹃树避让，不改其他树的生成**：其他树的既有布局一个方块都不动（零回归），
 * 只在杜鹃树的落位判据里避开它们。
 *
 * ## 为何从 6 降到 3（用户 2026-10-29）
 *
 * 用户反馈「空地上都给我再补充生成出来较矮的杜鹃花树，树木太空就不好看，稀稀拉拉的很难看……
 * 把杜鹃花树全都生成到杜鹃花地界里，别留空」。
 * 实测（seed 12345，可种树 AZALEA 陆地上的 4 格采样）：**空地里 61.2% 是被本阈值拒掉的** ——
 * 不是网格没位置，而是已经占住位置的树被毙了。降阈值是降空地最直接的一刀。
 *
 * 三 seed 实测（叶面覆盖 / 离树冠 >3 格的空地）：
 *   clearance 6 → 56.2% / 21.9%；**3 → 91.5% / 2.7%**；2 → 97.5% / 0.8%。
 * 取 3：基本填满且仍保证“树干不完全重叠”（两棵相邻树的树干中心至少隔 3 格）。
 *
 * ⚠️ **这是有意推翻 v2.0 的「树干要隔开」口径**，两条需求直接对立。若将来要恢复疏林，
 * 改回 6 即可；门禁与 E2E 的阈值都从本常量派生，不需要逐处改字面量。
 *
 * 冲突来源（均纯函数可预测，见 `collectOtherTrunks`）：空岛树基点 / 巨树树干格 / 普通树锚点。
 */
export const AZALEA_TRUNK_CLEARANCE = 3;

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
      // ⚠️ **必须是「所有 y 层的树干槽」，不能只要 y=0 层**（v2.4 实测修掉的真实缺陷）：
      // 巨树树干带分支/倾斜，上层树干相对 y=0 层水平偏移实测最大 **8 格**
      // （cherry / banyanLeafy 都是 8，tallOak 3、banyanBare 5、palm 2）。
      // 只取 y=0 层时，上部树干完全不在网格里 → 「杜鹃树干距巨树树干 ≥6」会被静默漏判。
      // 实测现象：杜鹃树干格 (571,-437) 与巨树 (567,-433) **y=9..25 的树干** 只隔 **5.66 格**，
      // 而巨树 y=0 层树干列离它 ≥8.49 格 —— 判据看不到上层树干。
      // 收紧到 y≤24（树干基部高度带，与 E2E 同口径）：y>24 的树干已经进入树冠层，
      // 那里与被测树的空间关系已不是「两棵树种得太近」这个语义。
      const gy = cells[k + 1];
      if (gy > GIANT_TRUNK_SCAN_MAX_Y) continue;
      if (cells[k + 3] !== 0) continue;
      const [rx, rz] = giantRotateCell(v, rot, cells[k], cells[k + 2]);
      const px = box.x0 + rx, pz = box.z0 + rz;
      out.set(`${px},${pz}`, [px, pz]);
    }
  }
  void wy; void giantTreeRotation;
  return [...out.values()];
}

/**
 * 巨树树干「算进间距判据」的高度上限 = **24**。
 *
 * ## 为何是 24（实测标定）
 *
 * 巨树树干最高到 **y=38**（tallOak 38 / snowSpruce 33 / banyanBare 25 / cherry 22 / banyanLeafy 19 / palm 14），
 * 杜鹃树高 12~29。取 **24** 是「两者的树干带交集的最小安全值」：
 * - 杜鹃树基部在 0~29，树干在 y≤17 左右就已进入树冠（实测各档树干最高 y=7~26）；
 * - 巨树在 y>24 的树干已**进入或高于杜鹃树冠层**（实测 y>29 的只有 26 格），
 *   那里的「水平贴合」不构成玩家看到的「两根树干搅在一起」。
 *
 * ⚠️ **试过改成 `Infinity`（全高度），结果是反而变差**（E2E 违反从 2 对升到 **24 对**）：
 * 巨树在多个高度层都有树干格，把它们**全部**当作独立的水平位置参与判据，会让贪心
 * 在「明明可以放」的位置上过度拒绝；而且高空段的树干本来就不该参与“地面上两棵树打架”的语义。
 * 结论：按固定高度带截断是**正确做法**，不是折中。
 *
 * ⚠️ E2E（`tests/azalea-trees.spec.mjs`）的扫描窗口**从本常量派生** —— 两处必须同源，
 * 否则会漂移出「判据管了 24 以上、测试不看」（v2.4 就是这个状态，漏掉了 y=24 的巨树树干）。
 */
export const GIANT_TRUNK_SCAN_MAX_Y = 24;

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
 *
 * @param {Array<Object>} layouts 查询域内的 region 布局
 * @param {number} seed
 * @param {*} families 保留参数（变体表由 giantData 提供）
 * @param {{minX:number,maxX:number,minZ:number,maxZ:number}} win 要收集的窗口
 * @param {*} [giantData] 巨树变体数据（`getGiantTreesSync()` 在主线程恒 null）
 * @param {Array<Object>|null} [probeRects] 保留参数（旧 API；网格现在按 `win` 全量缓存）
 */
export function collectOtherTrunks(layouts, seed, families, win, giantData = null, probeRects = null) {
  void probeRects;
  // ⚠️ **整个网格按 `win` 缓存**（不只是锚点列表）：每次调用都要重插几万点到 `TrunkGrid`，
  // 实测热缓存下仍要 **17.5ms**（HEAD 整体才 7.1ms）⇒ 撞 genP95 门，
  // 并让浏览器单测整页从 27s 漂到 51s（超过 `harness.spec.mjs` 的 30s 窗口）。
  // 同一个 `win`（3×3 region）下的全部 column 看到的是**完全相同**的网格 ⇒ 直接复用。
  // 纯派生数据，无可变状态（红线 1）。
  const ck = `${seed}|${win.minX},${win.maxX},${win.minZ},${win.maxZ}|${giantData ? 1 : 0}`;
  const cached = otherGridCache.get(ck);
  if (cached) return cached;
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

  // ③ **普通树**（`rollVegetation` 的 FOREST / PLAINS / SWAMP 分支）
  //
  // ⚠️ **这是 v2.4 修掉的真实缺陷：旧实现根本不收普通树**。
  // 当初的理由是「AZALEA biome 里 `rollVegetation` 的树分支恒空 ⇒ 普通树 0 处」——
  // 但那**只对「锚点在 AZALEA 内」成立**。相邻 FOREST biome 的树（4% 命中）会长在
  // AZALEA 边界外几格，树冠（半径 ≤3）越界伸进来；实测 v2.4 提密度后第一对违反就是
  // 杜鹃树干 (540,-489) 撞 FOREST 的 `wood` 树干 (535,-486)（距 **5.83**）。
  // 密度越高、越靠近 biome 边界，这类「边界外的树」就越容易被撞上。
  //
  // ⚠️ **性能：不能扫 `win`**。`win` 在逐 column 路径上是 **1200×1200 = 144 万个点**，
  // 全扫一遍实测 **122ms/次** ⇒ 直接撞破 genP95 10ms 门。
  // 做法：**整个 `win` 只扫一次并缓存**（见 `plainTreeCache`），后续每个 column 只是从缓存的
  // 锚点列表里挑「落在本列 probeRects 内的」—— O(锚点数) 而不是 O(窗口面积)。
  //
  // ⚠️ `probeRects` 必须覆盖**全部** `fixedCandidates`（不只本列相交的）：
  // `acceptAzaleaTrunks` 是在全候选集上贪心的，它的结论必须与 column 无关（v2.0 核心不变式）。
  const anchors = collectPlainTreeAnchors(win, seed);
  if (probeRects && probeRects.length > 0) {
    // 按包围盒粗筛（盒子之间会重叠，重复 add 无害 —— TrunkGrid 只用于距离查询，
    // 同一个点重复插入不影响 `nearestDistance` 的结果）
    let px0 = Infinity, px1 = -Infinity, pz0 = Infinity, pz1 = -Infinity;
    for (const r of probeRects) {
      if (r.minX < px0) px0 = r.minX; if (r.maxX > px1) px1 = r.maxX;
      if (r.minZ < pz0) pz0 = r.minZ; if (r.maxZ > pz1) pz1 = r.maxZ;
    }
    for (const [wx, wz] of anchors) {
      if (wx < px0 || wx > px1 || wz < pz0 || wz > pz1) continue;
      grid.add(wx, wz);
    }
  } else {
    for (const [wx, wz] of anchors) grid.add(wx, wz);
  }

  void families;
  if (otherGridCache.size >= OTHER_GRID_CACHE_MAX) {
    otherGridCache.delete(otherGridCache.keys().next().value);
  }
  otherGridCache.set(ck, grid);
  return grid;
}

/**
 * 普通树冠对外的水平最大延伸（格）。
 *
 * 取 4：`generateTree` 的树冠半径最大 3（`big` 类的 5×5 冠是 ±2，`azalea`/`big` 顶到 ±3）。
 * ⚠️ **树干本身不水平平移**（永远在锚点列），所以这个外扩只对「锚点刚好在窗口外、
 * 树冠盖到窗口内」有意义；取 4 留一格余量。
 */
export const TREE_CROWN_REACH = 4;

/**
 * `collectOtherTrunks` 的网格缓存（按 seed + 窗口）。
 * 容量上限 8：同时存活的窗口最多几个（换 seed / 换区域时旧项自然淘汰）。
 */
const otherGridCache = new Map();
const OTHER_GRID_CACHE_MAX = 8;

/** 清空 `collectOtherTrunks` 的网格缓存（单测需要确定性时调） */
export function clearOtherGridCache() { otherGridCache.clear(); plainTreeCache.clear(); }

/**
 * 普通树锚点的**跨调用缓存**。
 *
 * 为何必需（实测）：`collectOtherTrunks` 每个 column 调一次，而同一个 `fullWin`
 * （3×3 region = 1200×1200）下的全部 column 看到的是**同一批**普通树。不缓存就要每个 column
 * 重扫一遍 ~7.5 万个候选格 —— 实测单次 **18ms**（HEAD 的 `collectOtherTrunks` 整体才 7.1ms）
 * ⇒ 直接撞破 genP95 10ms 门，并让浏览器单测整页从 27s 漂到 51s（超过 `harness.spec.mjs` 的 30s 窗口）。
 *
 * 缓存键 = `seed + 完整窗口`（`win` 传入前已被调用方外扩 ±ext，同窗口即同结果）。
 * 纯函数、无别处可变状态（红线 1：这只是一份可重建的派生数据，不引入第二份权威）。
 * 容量上限 8：同时存活的 `fullWin` 最多几个（改 seed / 换区域时旧项自然淘汰）。
 */
const plainTreeCache = new Map();
const PLAIN_TREE_CACHE_MAX = 8;

/** 清空普通树锚点缓存（单测需要确定性时调；生产不需要） */
export function clearPlainTreeCache() { plainTreeCache.clear(); }

/**
 * 收集窗口内的**普通树干锚点**（`rollVegetation` 的 FOREST / PLAINS / SWAMP 分支）。
 *
 * 结果按窗口缓存（见 `plainTreeCache`）。返回 `Array<[number, number]>`。
 */
function collectPlainTreeAnchors(win, seed) {
  const key = `${seed}|${win.minX},${win.maxX},${win.minZ},${win.maxZ}`;
  const hit = plainTreeCache.get(key);
  if (hit) return hit;
  const out = [];
  // ⚠️ **树的树干永远在锚点列**（`generateTree` 不水平平移树干）⇒ 只需看锚点本身。
  // 外扩 `TREE_CROWN_REACH` 是为了覆盖「锚点在窗口外、树冠/树干伸进来」：树干不会伸，
  // 所以这个外扩实际上只是为了与调用方的语义一致，可保留（成本为 O(周长)）。
  const bx0 = Math.floor(win.minX - TREE_CROWN_REACH);
  const bx1 = Math.ceil(win.maxX + TREE_CROWN_REACH);
  const bz0 = Math.floor(win.minZ - TREE_CROWN_REACH);
  const bz1 = Math.ceil(win.maxZ + TREE_CROWN_REACH);
  for (let wx = bx0; wx <= bx1; wx++) {
    for (let wz = bz0; wz <= bz1; wz++) {
      // 廉价预筛：`rollVegetation` 在 AZALEA 恒空（旧小树已停用）、DESERT 只有仙人掌
      const biome = getBiome(wx, wz, seed);
      if (biome === 'AZALEA' || biome === 'DESERT') continue;
      const roll = rollVegetation(wx, wz, biome, seed);
      if (!roll || !roll.tree) continue;
      out.push([wx, wz]);
    }
  }
  if (plainTreeCache.size >= PLAIN_TREE_CACHE_MAX) {
    // 简单 FIFO 淘汰（Map 保持插入序）
    plainTreeCache.delete(plainTreeCache.keys().next().value);
  }
  plainTreeCache.set(key, out);
  return out;
}

/**
 * 落位路径：**单条**，只落 AZALEA biome 的陆上。
 *
 * **C = spacing + jitter = 2 + 6 = 8**（v2.5；v2.4 是 11、v2.3 是 13）。
 * 每格至多 1 个点，落在格内 `[0, jitter)²` 的内缩方块里。
 *
 * ## C 才是密度的真正旋钮（用户 2026-10-29「别留空、都给我种上」）
 *
 * 三 seed 实测（可种树 AZALEA 陆地，4 格采样）：
 *
 * | C | spacing/jitter | 落树 | 叶面覆盖 | 空地 >3 格 | 叶块倍数 | cutout 实测 |
 * |---|---|---|---|---|---|---|
 * | 11 | 6/5  | 608  | 56.2% | 21.9% | 1.00× | 531k = 24.2% |
 * | 11 | 0/11 | 852  | 63.6% | 10.7% | 1.34× | 564k = 25.6% |
 * | **8** | **2/6** | **1542** | **87.7%** | **3.5%** | 2.45× | **672k = 30.5%** |
 * | 7 | 1/6  | 1876 | 89.9% | 2.7% | 2.83× | 未测 |
 * | 6 | 1/5  | 2379 | 93.0% | 1.8% | 3.38× | 未测 |
 *
 * ⇒ 取 **C=8**：空地降到 3.5%（视觉上基本“不空”），cutout 只到 **30.5%**（容量 100%，余量充足）。
 * 再往下收益递减（87.7% → 89.9%）而叶块继续 ×1.15。
 *
 * ⚠️ **jitter 不要改成「填满 cell」**（v2.5 试过 `spacing:0 / jitter:11`，结果**更差**）：
 * 覆盖率 63.6%（C=11）而不是预期的更高——因为锚点在整个 cell 内乱跳会让 `acceptAzaleaTrunks`
 * 的贪心更难排开。**部分抖动的规则网格反而更容易填满**。这个结论反直觉，改参前先重跑那张表。
 *
 * ⚠️ **构造性最小锚距 = `C - (jitter - 1)` = 8 − 5 = 3**，恰好等于 `AZALEA_TRUNK_CLEARANCE`。
 * ⇒ 网格本身不再保证间距，**全部交给 `acceptAzaleaTrunks` 的贪心判据**。
 * 这是 v2.5 的有意设计（用户：「树叶之间有交叉没问题，只要树干别贴合到一起就行」）。
 *
 * salt 用 1001~1003（程序化扫描确认空闲：src 下 1000/1020~1033 已占，1001~1019 空闲）。
 * ⚠️ **不要 grep 字面量判 salt 是否空闲** —— 带 `+ step` 偏移的调用点占用的是区间。
 */
export const AZALEA_TREE_PATH = Object.freeze({
  key: 'azalea', salt: 1001, spacing: 2, jitter: 6,
  /** 花叶掷签的 salt（与候选层分开，互不干扰） */
  flowerSalt: 1004,
  /** 档位错落的类别扰动 salt（与候选/朝向/花叶三者都分开，占 1034） */
  staggerSalt: 1034,
});

// ---------------------------------------------------------------- 档位错落（v2.3：两类棋盘）

/**
 * 档位高度 → 高度类别（0 = 矮、1 = 高）。**两类**，不再是 v2.2 的三类。
 *
 * 分类依据是**烘焙产物的实际高度**（`trees.json` 的 `h`），不是档位下标 ——
 * 下标只是尺寸列的顺序（实测 `[12,13,17,22,21,25,26,27,28,29]`，注意档 3/4 是 22/21 回折）：
 *   矮 ≤17（档 0/1/2，h=12/13/17）· 高 ≥21（档 3~9，h=21/22/25/26/27/28/29）
 * 两类最小可辨差 = 21 − 17 = **4 格**。
 *
 * ## 为什么从三类改成两类（v2.3，用户 2026-10-28 裁定）
 *
 * v2.2 的三类表是 矮[12,13,17] / 中[21,22,25] / 高[26..29]，而**中→高 的最小可辨差只有 1 格**
 * （中最高 25 vs 高最低 26）。实测真实相邻对：中→高 |Δh| **中位 4、最小 1** —— 玩家眼里
 * 那是同一档高度，「错落相间」自然看不出来。
 * 即使用最优三类组合（穷举 210 个组：类别切法 × 图案 × 类内取值），正交相邻 |Δh| ≤ 4 的
 * 占比下限也只能到 **29.9%**；两类棋盘能做到 **11.0%**。
 *
 * ⚠️ **两类会让对角相邻必为同类**（棋盘结构的数学后果）—— 所以「8 邻域同类率」这个口径
 * 对两类**结构性失效**（恒 50%），不能再拿做门禁；改用「**正交**相邻同类率」
 * （两类下最优可达 0%，实测含低频扰动后 11~13%）。
 */
export function azaleaHeightClass(height) {
  return height <= AZALEA_CLASS_SPLIT_H ? 0 : 1;
}

/**
 * 矮/高两类的分界高度（含）：≤该值为矮类，> 为高类。
 *
 * **4 格可辨差是标定值，不是推导值**：产物里可用作分界的高度是 17 / 21 / 22（相邻档差分别是
 * 4 / 5）；取 17 让两类档数比 3:7，各类内部仍有 3 与 7 种高度（不会整齐划一）。
 * 改这个值必须重跑 `test-azalea-trees` 的相邻 |Δh| 用例（它钉的是「≤ 4 占比」上界）。
 */
export const AZALEA_CLASS_SPLIT_H = 17;

/** 两个高度类别各自的档位下标（顺序小→大；`test-azalea-trees` 从产物实测值钉住这张表） */
export const AZALEA_STAGGER_CLASSES = Object.freeze([
  Object.freeze([0, 1, 2]),                    // 矮 ≤17（h=12/13/17）
  Object.freeze([3, 4, 5, 6, 7, 8, 9]),         // 高 ≥21（h=21/22/25/26/27/28/29）
]);

/**
 * 档位下标 → 高度类别（0/1）。`AZALEA_STAGGER_CLASSES` 的反查。
 *
 * ⚠️ **不要写成 `azaleaHeightClass(sizeIdx)`** —— 后者吃的是**实际高度**（12~29），
 * 把下标 0~9 传进去会全部命中 `≤17` 判成矮类（实测踩过：相邻同类比例算出 1.000）。
 */
export function azaleaSizeClass(sizeIdx) {
  const n = azaleaTreeSize(sizeIdx);
  for (let c = 0; c < AZALEA_STAGGER_CLASSES.length; c++) {
    if (AZALEA_STAGGER_CLASSES[c].includes(n)) return c;
  }
  return 0;
}

/**
 * 候选 cell 的档位下标（v2.3：两类棋盘交替 —— 「一个高树挨着它的应该是矮树」）。
 *
 * ## 为什么不能继续用独立抽签
 *
 * 原实现是 `floor(seededRandom(i, j, salt) × 10)` —— 纯独立随机。用户 2026-10-28 反馈
 * 「高树和矮树错落相间一些，别一下子高树扎堆、或者矮树扎堆」。实测（seed 12345、264 棵）：
 * 最近邻与自己**同类**的比例 **0.409**，而独立抽签的理论期望只有 Σp² = **0.34**。
 *
 * ## 做法：类别 = 棋盘奇偶，类别内再随机
 *
 * `class = (i + j + shift) % 2` —— **正交相邻 cell（差 1）必然异类**，这正是用户要的
 * 「一个高树挨着它的应该是矮树」。对角相邻必然同类（棋盘结构的数学后果，不可避免）。
 * 类别内均匀取一档 ⇒ 矮组 3 种高度、高组 7 种高度，不会整齐划一。
 *
 * ## 实测（三 seed 平均，真实 accepted 树位置）
 *
 * | 口径 | 现状 v2.2 三类 | v2.3 两类棋盘 |
 * |---|---|---|
 * | 正交相邻 \|Δh\| ≤ 4 | 39.1% | **11.0%** |
 * | 正交相邻 \|Δh\| ≤ 2 | 21.8% | **5.3%** |
 * | 正交相邻 \|Δh\| ≥ 8 | 49.0% | **80.9%** |
 * | 单轴「几乎看不出」最高比例 | 48% | **13%** |
 *
 * ⚠️ **v2.2 的 `(4,5)` 系数有严重各向异性（真实缺陷）**：环 `[0,1,2,…]` 下 `4i+5j mod 10`
 * 让 ±X 方向同类率 **40.0%**、±Z 方向 **0.0%** —— 沿 X 走时而 36% 的相邻对同类。
 * AGENTS.md 里记的「正交 0.20」是两轴均值，把 40% 那条轴藏住了。棋盘结构天然无各向异性。
 *
 * ⚠️ **为什么保留低频扰动 `shift`**：不加它，`(i+j)%2` 在全国范围内是固定相位，虽然正交相邻
 * 仍必然异类（不受影响），但整片地图只有一种「哪个奇偶是矮」的分配 —— 相邻两个 region 之间
 * 会出现一条「相位切换带」（两条带在地图上各自一致而彼此相反）。`shift` 由粗格坐标决定
 * 只改相位不改奇偶关系 ⇒ **正交相邻必然异类这个不变式不受影响**（这是与 v2.2 最大的区别）。
 *
 * ⚠️ **不能按「邻居已落树的档位」做排斥**：候选层跑在 region layout 阶段，此时拿不到邻域的
 * 最终落树集合（间距判据 `acceptAzaleaTrunks` 要到 apply 阶段才产出），且互相依赖会形成循环。
 * 本做法完全不读邻居，故任意 column 算出的候选逐位相同。
 *
 * ## 不变式的准确口径（**不是「全国范围正交必异类」**）
 *
 * ⚠️ 低频扰动的相位是**逐粗格**取的（边长 `AZALEA_STAGGER_CELL` 个 cell）。
 * 粗格**内部**相位一致 ⇒ 粗格内每个正交相邻对**必为异类**（实测 0/22720）；
 * 但**跨粗格**的那一层相邻对，两侧相位可能不同 ⇒ 奇偶关系翻转 ⇒ **必然同类**
 * （实测 1170/2880 = 40.6%）。而跨粗格的正交对占全部正交对的 **11.25%**。
 * ⇒ 全国口径的正交同类率 = **0.0457**（实测），不是 0。
 *
 * 这个代价是**刻意接受**的：相位扰动的价值是把「纯棋盘的对角线无限同类带」压成
 * ~54 cell 一段（见 `AZALEA_STAGGER_CELL` 的标定表）；不扰动则是 4.5% 正交同类但
 * **无限长**的斜向同高带。两害取其轻。
 * ⇒ **门禁不能写「`same === 0`」**（那会把正确的实现判 FAIL，实测踩过）。
 * 正确判据：粗格内的同类对必须为 0，且全国口径的同类型率必须远低于独立抽签。
 *
 * @param {number} i cell 的全局 x 下标
 * @param {number} j cell 的全局 y 下标
 * @param {number} seed 世界 seed
 * @param {object} path 路径参数（至少含 salt / staggerSalt）
 * @returns {number} 档位下标 ∈ [0, AZALEA_VARIANT_COUNT)
 */
export function azaleaStaggeredSizeIdx(i, j, seed, path = AZALEA_TREE_PATH) {
  // 粗格相位偏移 ∈ {0,1}：只改「哪一奇偶是矮」，不改粗格**内部**的奇偶关系
  const ci = Math.floor(i / AZALEA_STAGGER_CELL);
  const cj = Math.floor(j / AZALEA_STAGGER_CELL);
  const shift = Math.floor(seededRandom(ci, cj, seed + (path.staggerSalt ?? AZALEA_TREE_PATH.staggerSalt)) * 2);
  const cls = (((i + j + shift) % 2) + 2) % 2;
  const bucket = AZALEA_STAGGER_CLASSES[cls];
  // 类别内均匀取一档（矮组 3 种、高组 7 种 ⇒ 同类之间仍有高矮差异）
  const k = Math.floor(seededRandom(i, j, seed + path.salt + 4) * bucket.length);
  return bucket[Math.min(bucket.length - 1, k)];
}

/**
 * 把变体按“冠幅面积升序”排序（同面积时按高度升序，保证确定性）。
 *
 * 降级用：最大档放不下时，先试面积最小的 —— 面积越小越容易放下。
 * ⚠️ **不能按档位下标排**：产物里下标 3/4 的高度是 22/21 回折，且冠幅并不随下标单调。
 *
 * @param {Array<object>} variants 烘焙产物
 * @returns {Array<object>} 按冠幅面积升序的变体
 */
export function variantsByFootprint(variants) {
  return [...variants].sort((a, b) => (a.w * a.d) - (b.w * b.d) || a.h - b.h);
}

/**
 * 低频扰动步长（单位 = cell 个数）：9 个 cell ≈ 117 格。
 *
 * **标定值（三 seed 实测，真实 accepted 树的 cell 正交相邻对）**：
 *
 * | SC | 正交 ≤2 | 正交 ≤4 | 正交 ≥8 | 单轴最差 ≤4 | 最长对角同类段 |
 * |---|---|---|---|---|---|
 * | 无 | 0.0% | 4.5% | 90.6% | 5% | **120**（无限长 → 斜向同高带） |
 * | 5 | 6.0% | 11.6% | 82.2% | 12% | 45 |
 * | **9** | **2.0%** | **7.8%** | **87.6%** | **8%** | 54 |
 * | 17 | 2.5% | 6.8% | 88.6% | 8% | 102 |
 *
 * ⇒ 取 9：扰动足够密集、把「无限长的斜向同高带」压到 ~54 cell 一段，同时邻接指标几乎不退化。
 * ⚠️ **SC=0（纯棋盘）不能用**：`(i+j)%2` 的相位在全国范围内固定 → 对角线上同类别**无限延伸**
 * （实测最长段 = 整个采样区 120 cell），玩家会看到大量的斜向「同高带」。
 * ⚠️ 粗格太小（5）会把正交 ≤4 抬到 11.6%（跨粗格占 20% 的正交对相位不同）—— 这是从 4.5% 的
 * 90.6% 型表现退化的主要原因。改这个值必须重跑 `test-azalea-trees` 的相邻 |Δh| 用例。
 */
export const AZALEA_STAGGER_CELL = 9;

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

/**
 * 每个候选 cell 内最多探测几个点（v2.3）。
 *
 * 每个 cell 只在**一个点**判 biome 时，点落空（落入非 AZALEA / 水下）整个 169 格² 就没树 ——
 * 实测占「可种树 AZALEA 面积」的 7.0% / 15.8% / 7.4%（seed 12345 / 424242 / 777），
 * 且聚成连续空地（最大一块 38×38 格）。三次重试可挽回约 **44%**；再多收益递减
 * （5 次只到 49%，而候选层计算量 +67% → 撞 GEN 预算）。
 * ⚠️ 重试点始终留在原抖动盒内 ⇒ 间距构造性保证（相邻 cell ≥ spacing+1）不变。
 */
export const AZALEA_CELL_PROBES = 3;

/**
 * 从候选数组里剔除落在地带圆**内**的点（保留圆外）。
 *
 * ⚠️ **`computeAzaleaTreeCandidates` 已逐次探测做过一次地带让路**（那样重试才有意义），
 * 本函数仅供**外部事后过滤**用（比如测试把非地带参数算出的候选列表按某座地带裁剪）。
 * 生产路径不调它 —— 两处同时用会造成「圆内剔两次」这种看不出差别的冗余。
 *
 * @param {Int32Array} arr stride = AZALEA_STRIDE 的候选数组
 * @param {{cx: number, cz: number}|null} tarn 地带布局（null 时原样返回）
 * @returns {Int32Array}
 */
export function outsideTarnRadius(arr, tarn) {
  if (!tarn) return arr;
  const out = [];
  for (let i = 0; i < arr.length; i += AZALEA_STRIDE) {
    if (inTarnRadius(arr[i], arr[i + 2], tarn)) continue;
    out.push(arr[i], arr[i + 1], arr[i + 2], arr[i + 3]);
  }
  return Int32Array.from(out);
}

// ---------------------------------------------------------------- 候选发现（region 层）

/** 地表高度；陆上（> SEA_Y）且 biome 是 AZALEA 才可能落树。返回 null = 不满足。 */
function azaleaEligible(wx, wz, seed) {
  if (getBiome(wx, wz, seed) !== 'AZALEA') return null;
  const h = generateHeight(wx, wz, seed);
  return h > SEA_Y ? h : null;
}

/**
 * 候选 cell 内第 `k` 次探测的落点。
 *
 * 约束一：**落点必须始终在 `[i*C, i*C + jitter)` × `[j*C, j*C + jitter)` 盒内**。
 * 这是间距构造性保证的前提 —— 相邻 cell 的点切比雪夫距离 ≥ `C − (jitter−1)` = `spacing + 1`。
 * 任何把重试点推出这个盒的写法（比如改到整 cell 内均匀采样）会破掉这个保证，
 * 需要重新做间距标定。
 *
 * 约束二：`k === 0` 必须与 v2.2 逐位一致 —— 首试通过时行为零回归。
 *
 * ## 重试方案是实测验过的（不要改成 `(ox+2k) % jitter`）
 *
 * 首版的 `(ox + 2k) % jitter` 在 jitter=5 时：k=1/2 的偏移只比首试挪 2/4 格，
 * 且 `ox=4` 时 `(4+2)%5=1`、`(4+4)%5=3` —— 三个点全落在同一条 `x+z` 对角线上，
 * 实测挽回率只有 **20.8%**（而独立哈希是 **13.9~17.8%**、纯首试为基准）。
 * 现写法：每次重试**两轴各自独立重新掷骰**（`i + k·7919` / `j + k·104729`，两个大素数），
 * 让三个点在整个盒内近似独立分布。
 *
 * ## 为什么重试（v2.3 实测）
 * 每个 cell 只在**一个点**判 biome，点落空（落入非 AZALEA / 水下）整个 169 格² 就没树。
 * 实测「有可种树 AZALEA 面积却无候选」的 cell 覆盖了可种树面积的
 * **21.4% / 20.5% / 21.3%**（seed 12345 / 424242 / 777）；
 * 三次重试降到 **16.5% / 14.9% / 15.7%**（挽回了约 1/4）。
 * 再多收益递减（5 次只到 15.1% / 13.2% / 14.3%），而候选层计算量随 T 线性增长 → 撞 GEN 预算。
 *
 * @returns {[number, number]} 世界坐标 [wx, wz]
 */
function azaleaCellProbe(i, j, k, seed, path) {
  const C = path.spacing + path.jitter;
  if (k === 0) {
    return [
      i * C + Math.floor(seededRandom(i, j, seed + path.salt + 1) * path.jitter),
      j * C + Math.floor(seededRandom(i, j, seed + path.salt + 2) * path.jitter),
    ];
  }
  return [
    i * C + Math.floor(seededRandom(i + k * 7919, j + k * 104729, seed + path.salt + 1) * path.jitter),
    j * C + Math.floor(seededRandom(i + k * 104729, j + k * 7919, seed + path.salt + 2) * path.jitter),
  ];
}

/**
 * 单个 region 的候选（纯函数、确定性、与 region 邻居无关）。
 *
 * ## cell 归属判据：看「cell 原点」，不看「探测点」
 *
 * 每一个 cell 只能由一个 region 负责。旧实现（v2.2）用「**探测点**落在本 region 内」判定，
 * 在「每格只探测一次」时碰巧等价；**加了格内重试（v2.3）就不等价了** ——
 * 跨 region 边界的 cell，两侧各自从自己的探测序列里挑出第一个合法点，
 * 两个点都落在各自 region 内 ⇒ **同一个 cell 产出两棵树且相距可少至 1 格**
 * （实测 C=11 时最小切比雪夫 = **1**，间距构造性保证被静默破坏）。
 *
 * 现口径：cell 归属由**它自身的位置**唯一确定 —— 取 cell 中心点所在 region。
 * 跨 region 的 cell 只由中心点落入的那个 region 生成，另一侧完全不碰它
 * ⇒ 既不重复也不遗漏，且**与 `path` / 重试次数无关**（改回单次探测也不会变）。
 *
 * @param {number} regionX @param {number} regionZ @param {number} seed
 * @param {object} [path] 路径参数
 * @param {{cx: number, cz: number}|null} [tarn] 本 region 的地带布局（null = 不是地带）
 * @returns {Int32Array} stride = AZALEA_STRIDE
 */
export function computeAzaleaTreeCandidates(regionX, regionZ, seed, path = AZALEA_TREE_PATH, tarn = null) {
  const C = path.spacing + path.jitter;
  const x0 = regionX * REGION_SIZE, z0 = regionZ * REGION_SIZE;
  const x1 = x0 + REGION_SIZE, z1 = z0 + REGION_SIZE;
  const i0 = Math.floor(x0 / C), i1 = Math.floor((x1 - 1) / C);
  const j0 = Math.floor(z0 / C), j1 = Math.floor((z1 - 1) / C);
  const out = [];
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      // ⭐ **归属判据：cell 几何中心所属的 region**（与探测点、重试次数都无关）。
      // 用中心而不是原点：`floor((i*C + C/2) / REGION_SIZE)` 对任意 C 都不偏，
      // 而原点在 C 不整除 REGION_SIZE 时会系统性偏向左侧的 region。
      const ownerX = Math.floor((i * C + C / 2) / REGION_SIZE);
      const ownerZ = Math.floor((j * C + C / 2) / REGION_SIZE);
      if (ownerX !== regionX || ownerZ !== regionZ) continue;
      // 格内最多试 AZALEA_CELL_PROBES 次（见 azaleaCellProbe 的重试理由）
      for (let k = 0; k < AZALEA_CELL_PROBES; k++) {
        const [wx, wz] = azaleaCellProbe(i, j, k, seed, path);
        // ⚠️ **不能拿 `wx`/`wz` 是否落在本 region 内做过滤**（v2.2 的写法）：
        // 加入重试后它会让同一个 cell 在两个 region 各产出一棵（见函数头注）。
        // 这里仍需要一道纵深防御：世界边界外的点不可能被任何 column 覆盖 ——
        // 但 REGION 网格无边界，故不设额外裁剪。
        //
        // 地带让路必须**逐次探测**判定，不能事后过滤整个数组 —— 否则落在圆内的首试
        // 白白占掉这个 cell，而圆外的第三次探测本可落树。
        // 判据与 apply.js 的 `kind:'tarn'` 分支同源（红线 1：`inTarnRadius`）。
        if (inTarnRadius(wx, wz, tarn)) continue;
        const h = azaleaEligible(wx, wz, seed);
        if (h === null) continue;
        // 档位下标 ∈ [0, AZALEA_VARIANT_COUNT)。**走 azaleaStaggeredSizeIdx 做高矮相间**，
        // 不是独立抽签 —— 理由与实测见该函数的注释。
        // 与巨树的区别：巨树一个族内有 4~8 个变体、候选层拿不到变体数（loadGiantTrees 异步）故存
        // 原始 hash；杜鹃树的「档」就是变体本身，档数在 src 侧是常量，故直接算下标。
        const sizeIdx = azaleaStaggeredSizeIdx(i, j, seed, path);
        out.push(wx, h + 1, wz, sizeIdx % AZALEA_VARIANT_COUNT);
        break;
      }
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
 * 一棵杜鹃树的**全部树干列**（含上层、世界水平坐标）—— **间距判据专用**。
 *
 * ## 为何不能只看 y=0 层（v2.5 修的真 bug）
 *
 * 杜鹃树树干带分支/倾斜，**上层树干相对 y=0 层的水平偏移实测最大 4 格**
 * （档 8 h=28：y=20 的树干格偏出 4 格；其余档 2~3 格）。
 * 只看 y=0 层会让「上层树干贴住其他树」完全在判据盲区里。
 * 实测现象：杜鹃树干 (561,-360) 在 **y=19** 与巨树 (560,-360) 的树干只隔 **1 格**，
 * 而 y=0 层判据看到的最坏距离仍是 3（阈值）—— 于是被放行。
 *
 * 与巨树那侧的 `GIANT_TRUNK_SCAN_MAX_Y = 24` 同一道理（那边截断到 24 是因为
 * y>24 已进入/高于杜鹃树冠层；杜鹃树自己的树干全高都在 0~26，故不截断）。
 *
 * ⚠️ **与 `trunkBaseColumnsOf` 的区别是语义性的，不可合并**：
 * - 本函数：**间距判据**要看到“所有会与别的树干撞的柱”；
 * - `trunkBaseColumnsOf`：**地基填充**只需 y=0 层（向下补到地表），
 *   用本函数会让上层树干也去补地基（多出几根地下柱子）。
 *
 * @returns {Array<[number, number]>} 世界坐标的树干列（去重后）
 */
export function trunkColumnsOf(variant, rot, x0, z0) {
  const out = new Map();
  const cells = variant.cells;
  for (let k = 0; k < cells.length; k += 4) {
    // 树干槽（palette[0]）的**每一格**都算 —— 不限 y 层
    if (cells[k + 3] !== 0) continue;
    const [rx, rz] = rotateCell(variant, rot, cells[k], cells[k + 2]);
    out.set(`${x0 + rx},${z0 + rz}`, [x0 + rx, z0 + rz]);
  }
  return [...out.values()];
}

/**
 * 一棵杜鹃树的 **y=0 层树干列** —— **地基填充专用**。
 *
 * 地基只从「树干底格」向下补（见 `rasterizeAzaleaTree`）。
 * 若改用 `trunkColumnsOf`（全高），上层树干也会各向下补一根柱子 → 地下多出好几根。
 */
export function trunkBaseColumnsOf(variant, rot, x0, z0) {
  const out = new Map();
  const cells = variant.cells;
  for (let k = 0; k < cells.length; k += 4) {
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
export function acceptAzaleaTrunks(candidates, blocked, clearance = AZALEA_TRUNK_CLEARANCE, opts = null) {
  const own = new TrunkGrid();
  const accepted = new Set();
  // opts.chosen：可选，返回「锚点键 → 实际采用的变体下标/对象」。
  // 降级（v2.5「高树种不下就种矮的」）需要调用方知道**最后用的是哪个档**，
  // 否则光看 `accepted` 无法区分「原样接受」与「降级接受」。
  const chosen = opts && opts.chosen ? opts.chosen : null;
  const downgrade = opts && opts.downgrade ? opts.downgrade : null;
  for (const c of candidates) {
    const key = `${c.wx},${c.wz}`;
    // ⭐ 先试首选档；放不下时按「冠幅面积升序」逐个降级重试（v2.5，用户要求「高树种不下就种矮的」）。
    // ⚠️ 所有降级共用**同一个锚点**（wx/wz 不变）⇒ accepted 键仍只有一条，
    // 「每个 cell 至多一棵树」的不变式不受影响。
    const variantsToTry = downgrade && typeof downgrade === 'function'
      ? downgrade(c)
      : [c];
    let picked = null;
    let pickedCols = null;
    for (const cand of variantsToTry) {
      // 树的**每一根**树干列都要满足，不只锚点（见 trunkColumnsOf 的实测说明）
      const cols = cand.trunkCols || trunkColumnsOf(cand.variant, cand.rot, cand.x0, cand.z0);
      let ok = true;
      for (const [wx, wz] of cols) {
        if (!isTrunkClear(wx, wz, blocked, clearance) || !isTrunkClear(wx, wz, own, clearance)) { ok = false; break; }
      }
      if (ok) { picked = cand; pickedCols = cols; break; }
    }
    if (!picked) continue;
    accepted.add(key);
    if (chosen) chosen.set(key, picked);
    for (const [wx, wz] of pickedCols) own.add(wx, wz);
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
  // 「其他树」的树干：巨树树干列 + 空岛树基点 + 普通树锚点（纯函数可预测；见 collectOtherTrunks 注释）
  //
  // ⚠️ **传 `probeRects`**：普通树的扫描不能扫整个 `fullWin`（逐 column 时它是 1200×1200
  // = 144 万点，实测光扫一遍就 122ms，直接撞破 genP95 10ms 门）。
  //
  // ⚠️ **必须覆盖 `fixedCandidates` 全部，不能只覆盖「与本列相交」的那些**：
  // `acceptAzaleaTrunks` 是在**全候选集**上贪心的，它的「接受/拒绝」结论必须与 column 无关
  // （v2.0 的核心不变式）。若只把本列附近的普通树塞进网格，跳列的候选会看到不同的网格
  // → 同一棵树在不同 column 算出不同结论 → 间距判据静默失效。
  //
  // 所以完整覆盖 + **按 fullWin 缓存**锚点列表（同一 fullWin 的每个 column 只扫一次）：
  // 实测首扫 ~18ms（每 fullWin 一次）、此后命中缓存 ~0ms。
  const probeRects = fixedCandidates.map((t) => ({
    minX: t.x0 - AZALEA_TRUNK_CLEARANCE, maxX: t.x1 + AZALEA_TRUNK_CLEARANCE,
    minZ: t.z0 - AZALEA_TRUNK_CLEARANCE, maxZ: t.z1 + AZALEA_TRUNK_CLEARANCE,
  }));
  const otherGrid = ctx.otherTrunks
    || collectOtherTrunks(layouts, seed, data.variants, {
      minX: fullWin.minX - ctx.ext, maxX: fullWin.maxX + ctx.ext,
      minZ: fullWin.minZ - ctx.ext, maxZ: fullWin.maxZ + ctx.ext,
    }, ctx.giantData || getGiantTreesSync(), probeRects);

  // ⭐ v2.5：降级（「高树种不下就种矮的」）。
  //
  // ⚠️ **降级必须发生在 `isAzaleaTreeAllowed` 之前（这是第一版写错的地方）**：
  // 首选档被 `allowed` 拒掉的候选，正是「树冠超出 biome/地标/水面」的那些 ——
  // 而矮树冠幅 8×9（72 格²）只占高树 13×13（169 格²）的 **43%**，它们本来能放下。
  // 第一版把降级链挂在 `allowed` **之后**，只能救「放得下但被间距拒」的那一批，
  // 实测只在 56.2% → 62.5%（而纯方案 C 是 91.5%）。
  // 现改为：先对每个候选展开「首选档 + 按冠幅升序的降级链」，**逐档过 allowed**，
  // 再交给贪心选第一个能同时过 allowed 与间距的。
  //
  // ⚠️ **所有降级共用同一个锚点**（wx/wz 不变）⇒ 「每个 cell 至多一棵树」的不变式不受影响。
  const footprintOrder = variantsByFootprint(data.variants);
  const downgradeOf = (c) => {
    // ⚠️ **链首也必须过 `isAzaleaTreeAllowed`**（v2.5 修的一个真 bug）：
    // 候选集改成了全量 `fixedCandidates`（因为降级需要看到「首选档放不下」的那些），
    // 于是原来由 `allowedAll` 做的那层过滤**必须搬进这里**。
    // 漏了它 → `allowedAt: () => false` 时仍会把首选档写进世界（实测合成场景写入 223 格）。
    const out = [];
    if (isAzaleaTreeAllowed(c, ctx.allowedAt, ctx.crownAllowedAt)) out.push(c);
    for (const v of footprintOrder) {
      if (v === c.variant) continue;
      const cand = { wx: c.wx, wy: c.wy, wz: c.wz, variant: v, rot: c.rot, ...treeBox(v, c.rot, c.wx, c.wz) };
      // ⚠️ 降级候选必须**逐档重新判**（矮树 AABB 不同，不能拿首选档的结论套给它）。
      // 按面积升序遍历时不能早退（只跳过这一档，继续试下一个）。
      if (!isAzaleaTreeAllowed(cand, ctx.allowedAt, ctx.crownAllowedAt)) continue;
      out.push(cand);
    }
    return out;
  };
  // ⚠️ **候选集必须是全量的 `fixedCandidates`**（不能先按首选档过滤）——
  // 否则「首选档放不下、矮树能放下」的那些树永远进不了贪心。
  const chosen = new Map();
  const acceptedAll = acceptAzaleaTrunks(fixedCandidates, otherGrid, AZALEA_TRUNK_CLEARANCE,
    { downgrade: downgradeOf, chosen });

  // 实际要写入的树 = 贪心选中的那个（**可能已降级为矮树**）
  const accepted = [];
  for (const [key, t] of chosen) {
    if (!acceptedAll.has(key)) continue;
    accepted.push(t);
  }
  if (accepted.length === 0) return NO_COVER;
  const setBlock = makeColumnSetter(column, registry);
  for (const t of accepted) {
    if (t.x1 < win.minX || t.x0 > win.maxX || t.z1 < win.minZ || t.z0 > win.maxZ) continue; // 只覆盖区相交、本列无方块
    rasterizeAzaleaTree(setBlock, t, seed);
  }
  return buildCoveredWindow(column, accepted, ctx.ext);
}
