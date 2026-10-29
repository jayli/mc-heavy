// src/gen/structures/shallow-water-tarns.js — 浅水高台（Shallow Water Tarns）：锚点、环排布、占地判据
//
// 设计文档：docs/superpowers/specs/2026-11-01-shallow-water-tarns-design.md
//
// 三块职责，刻意放在同一个文件里（都已与 three 无关，Worker 同构）：
//   ① `computeShallowTarnAnchor` —— 落点（每个 seed 一个，City 正东第一个合法位置）
//   ② `computeShallowTarnLayout` —— 五座高台在湖中的环排布（纯函数 + seed 抖动）
//   ③ `inShallowTarnFootprint` / `shallowTarnOverlapsRegion` —— 占地判据（供 `pointContext`
//      与 `apply.js` 阶段 2.7 的撒布剔除消费，与 `arena.js` / `giant-pyramid.js` 同手法）
//
// Worker 同构：本文件不得 import three、不得 fetch、不得自建 Worker。
import {
  REGION_SIZE, CITY_TRANSITION_SIZE, LANDMARK_OFFSET,
} from './region-config.js';
import { getCityBoundsForSeed } from './city-layout.js';
import { getRegionSeededCenter } from './region-center.js';
import {
  getPyramidCenterInRegion, getFrozenMountainCenterInRegion,
  getPlainLandCenterInRegion, getIslandCenterInRegion,
} from './landmarks.js';
import { computeArenaAnchor, ARENA_HALF_X, ARENA_HALF_Z } from './arena.js';
import { isTarnZone, computeTarnZone, TARN_ZONE_RADIUS } from './tarn-zone.js';
import { seededRandom } from '../noise.js';
import { SEA_Y } from '../../voxel/constants.js';
import {
  SHALLOW_TARN_VARIANTS, SHALLOW_TARN_METRICS,
} from './shallow-water-tarn-data.js';

// ==================== 尺度常量 ====================

/**
 * 湖盆半径（格）。
 *
/**
 * 湖盆半径（格）。
 *
 * ⚠️ **v2.14 从 105 收到 99**（用户 2026-11-01：「中心区域的浅水高台距离岸边太远，
 * 浅水高台距离岸边的距离减少一半」）。
 *
 * 五座最远角恒为 **92.4 格**（环半径 45 + 最大半宽 35，与 seed 无关），
 * 所以岸畔留白 = `LAKE_RADIUS - 92.4`：
 * | 湖半径 | 岸畔留白 |
 * |---|---|
 * | 105（v2.13）| 12.6 |
 * | **99** | **6.6**（≈ 减半）|
 *
 * ⚠️ 不能比 99 更小：再往下就压到 92.4，那会让高台直接泡到沙滩里。
 * 用户的「减半」以 6.6 格实现（12.6 → 6.6）。
 */
export const LAKE_RADIUS = 99;

/**
 * 沙滩带宽度（格）。从湖盆外缘 `LAKE_RADIUS` 到 `LAKE_RADIUS + BEACH_WIDTH`，
 * 地表从湖底高度平滑抬到 `SEA_Y + 2`。
 *
 * ⚠️ **v2.14 从 14 收到 7**（用户 2026-11-01：「过渡带的梯度也要做个调整，
 * 梯度过渡带宽度减半，这样过渡带的坡度自然就会变的更陡一些」）。
 *
 * 3 格高差摊到 7 格 = **0.43 格/格**（旧值 14 格是 0.21）。仍远低于 `MAX_STEP = 1.0`，
 * 玩家跑着就能上去，但观感从「缓缓漫上去」变成明确的上坡。
 */
export const BEACH_WIDTH = 7;

/**
 * 宽缓坡宽度（格）。从沙滩外缘线性插值回**平滑后的自然地形高度**。
 *
 * ⚠️ **v2.14 从 44 收到 24**（用户 2026-11-01：「过渡带的梯度也要做个调整，
 * 梯度过渡带宽度减半，这样过渡带的坡度自然就会变的更陡一些」）。
 * 44 的一半是 22，但实测 **22 会突破「单步落差 ≤1」**（seed 88 达 **2 格**）：
 * | 缓坡宽 | 10 seed 最大单步落差 |
 * |---|---|
 * | 22 | **2** ✗ |
 * | **24** | **1** ✓ |
 * | 26 | 1 ✓ |
 * ⇒ 取 24（= 减半目标 22 + 2 格余量）：「梯度减半」的意图实现，同时守住无台阶。
 * ⚠️ **不要再往 22 以下压**：那会把「有梯度的衔接」变成「一条棱」，与用户最初
 * 「不要生硬的断崖式衔接」的要求相反。
 */
export const SLOPE_WIDTH = 24;

/** 整片整形区的外缘半径 = 湖 + 沙滩 + 缓坡（落点净空按它算） */
export const SHALLOW_TARN_OUTER_RADIUS = LAKE_RADIUS + BEACH_WIDTH + SLOPE_WIDTH;

/** 湖底方块所在的高度（其顶面 = `SEA_Y`，故水深 0.5 格 —— 见设计文档 §5.2） */
export const LAKE_FLOOR_Y = SEA_Y - 1;

/** 沙滩外缘的地表高度（比海平面高 2 格，玩家从水里走上来不需要跳） */
export const BEACH_OUTER_Y = SEA_Y + 2;

/** 湖底到沙滩外缘的高差（格）—— 沙滩带的坡度用它算 */
export const BEACH_RISE = BEACH_OUTER_Y - LAKE_FLOOR_Y;

/** 圆心到城市 bounds 的最小净距（复用 `CITY_TRANSITION_SIZE`，红线 1 不另写 32） */
const CITY_CLEARANCE = CITY_TRANSITION_SIZE;

/**
 * 向东搜索的最远距离（格）。超过它就不生成（返回 null，不阻断 GEN）。
 *
 * 实测 10 个 seed 的合法落点都落在城东 190~900 格内（设计文档 §2.3），
 * 2400 是「再远就不值得」的工程上限。
 */
export const SHALLOW_TARN_MAX_GAP = 2400;

/** 向东推进的步长（格） */
const GAP_STEP = 20;

/**
 * 纬度试探偏移（相对城市 z 中心）。
 *
 * 城市东西向中线先试（0），不合法再上下错开 —— 与 `arena.js` 的 `DX_OFFSETS` 同手法。
 * 用户要求「城东边界外 + 中央纬度」，所以 0 必须排在最前。
 */
const DZ_OFFSETS = [0, -40, 40, -80, 80, -140, 140, -200, 200];

/**
 * 环半径（五座高台按等角+抖动摆在这个圆上）。
 *
 * ⚠️ **v2.13 从 74 收到 45**（用户 2026-11-01：「间距还是太大，再缩小到普通高台的 1.5 倍左右」）。
 * 基准 = 高台地带的 `TARN_GAP = 4` → 目标 **1.5 倍 ≈ 6 格**。
 *
 * 标定表（`SHALLOW_TARN_GAP` 分别取 5/6/7 时，经真实二分抖动后 10 个 seed 的实测最小间距）：
 * | 环半径 | GAP=6 时实测间距 | jitterMax | 最远角 |
 * |---|---|---|---|
 * | 44 | 6.23 ~ 8.24 | 1.47° | 91.3 |
 * | **45** | **6.47 ~ 10.78** | **3.05°** | **92.4** |
 * | 46 | 6.69 ~ 12.48 | 4.56° | 93.4 |
 * | 74（v2.12）| 24.79 | 18.6° | 119.8 |
 *
 * 取 **45 / GAP 6**：间距贴到目标 6，而 jitterMax 还有 **3.05°**。
 * ⚠️ **不能收到 44**：那里 jitterMax 只剩 **1.47°** —— 抖动预算几乎为零，
 * 「随机排布」会退化成机械等距（用户要的是「随机排布」+「适当空隙」两个都要）。
 * ⚠️ 再小（≤40）占角就超 360°，五座根本放不下（实测 R=40 时最小间距已为负）。
 */
export const SHALLOW_TARN_RING_RADIUS = 45;

/**
 * 相邻高台的最小 AABB 真实间距（格）。
 *
 * ⚠️ **v2.13 从 12 收到 6** —— 用户 2026-11-01：「再缩小到普通高台的 1.5 倍左右」，
 * 而高台地带的 `TARN_GAP = 4` ⇒ 4 × 1.5 = **6**。
 *
 * ⚠️ **这个值不是自由旋钮**：它是抖动二分的目标值（`shallowTarnJitterMax` 拿它当阈值），
 * 调大 → 间距变大（用户不要）；调小 → 抖动预算变大但间距可能小于玩家感知的「空隙」。
 * 两者与环半径绑定，改任一个都要重跑标定表（见 `SHALLOW_TARN_RING_RADIUS`）。
 */
export const SHALLOW_TARN_GAP = 6;

// ==================== salt 分配 ====================
//
// ⚠️ **新增 salt 前必须程序化扫描占用区间**（不能只 grep 字面量 ——
// 带 `+ step` / `+ y` 的调用点占用的是**区间**）。当前已知占用：
//   1-58 / 100 / 113 / 200-201 / 270-397（landmarks 的 seed+302+y）/
//   301-303 / 311-314 / 800-805 / 911-958 / 960-961 / 999 /
//   1020-1033（高台地带全套）/ 58-107（云簇 frontier）
//
// 1034-1099 经扫描空闲，本设计占用 1034-1036。

/**
 * 锚点搜索的 salt —— **当前未使用**。
 *
 * ⚠️ 锚点是**纯几何搜索**（城东第一个合法位置），不含任何随机抽签：
 * 「每个 seed 一个」本身就是确定性的（城东第一步就命中或不命中）。
 * 保留这个常量只为将来加「多个候选取一个」时不必重新选号；
 * 若一直不用，宁可删掉也不要在搜索里塞一个不影响结果的 `seededRandom` 调用
 * （那会让 salt 占用表与实现不一致）。
 */
export const SHALLOW_TARN_ANCHOR_SALT = 1034;

/** 五座高台角向抖动的 salt。 */
export const SHALLOW_TARN_ANGLE_SALT = 1035;

/** 草方块深浅分流的 salt（`shallow-water-terrain.js` 消费）。 */
export const SHALLOW_TARN_GRASS_SALT = 1036;

// ==================== 几何工具 ====================

/**
 * 某个变体在产物坐标系里的**水平半宽**（`lo` = 向左/向下能伸多远，`hi` = 向右/向上）。
 *
 * ⚠️ **不能用 `width/2` 对称假设**：烘焙的原点是 `x0 + floor((x1-x0)/2)`，
 * 奇数跨度时左右不等（65 宽 → `lo=32, hi=32`；31 宽 → `lo=15, hi=15`；
 * 但 28 宽 → `lo=13, hi=14`）。AABB 判据与环上占角都必须用真实的 lo/hi，
 * 否则大座会「看起来没重叠但实际压住邻居 1 格」。
 *
 * @param {string} variant 产物基名
 * @returns {{loX: number, hiX: number, loZ: number, hiZ: number}}
 */
export function shallowTarnHalfWidth(variant) {
  const m = SHALLOW_TARN_METRICS[variant];
  const loX = Math.floor((m.width - 1) / 2);
  const loZ = Math.floor((m.depth - 1) / 2);
  return { loX, hiX: m.width - 1 - loX, loZ, hiZ: m.depth - 1 - loZ };
}

/**
 * 两个**轴对齐**矩形的真实最短距离（格，重叠为负）。
 *
 * ⚠️ 这是间距判据的**唯一实现**（红线 1）：布局自检、抖动二分、单测共用同一份。
 * 与 `tarn-zone.js` 的 `aabbGap` 语义完全相同 —— 刻意**不复用**它：
 * 那边的签名吃 `{cx, cz, halfX, halfZ}`（对称半宽），而这里吃 `{loX, hiX, loZ, hiZ}`
 * （非对称，产物坐标系的真实偏置）。硬套会把 lo/hi 压成对称值，正是要避免的误差源。
 *
 * @param {{cx:number, cz:number, loX:number, hiX:number, loZ:number, hiZ:number}} a
 * @param {{cx:number, cz:number, loX:number, hiX:number, loZ:number, hiZ:number}} b
 * @returns {number}
 */
export function shallowTarnAabbGap(a, b) {
  const dx = Math.abs(a.cx - b.cx) - (Math.max(a.loX, a.hiX) + Math.max(b.loX, b.hiX));
  const dy = Math.abs(a.cz - b.cz) - (Math.max(a.loZ, a.hiZ) + Math.max(b.loZ, b.hiZ));
  if (dx > 0 && dy > 0) return Math.hypot(dx, dy);
  return Math.max(dx, dy);
}

// ==================== ① 锚点 ====================

/** 锚点缓存（`seed → anchor | null`）。纯函数，`clearShallowTarnCache()` 供单测隔离。 */
const anchorCache = new Map();
const ANCHOR_CACHE_MAX = 64;

/** 固定占位物缓存（`seed → blockers[]`）。见 `fixedBlockers` 的成本注释。 */
const blockerCache = new Map();
const BLOCKER_CACHE_MAX = 8;

/** 清空锚点缓存（单测隔离用；生产代码不需要调用） */
export function clearShallowTarnCache() {
  anchorCache.clear();
  blockerCache.clear();
}

/** 距离城市 z 中心的两组试探顺序（0 优先：「中央纬度」是用户要求） */
function* candidateCenters(seed) {
  const cityBounds = getCityBoundsForSeed(seed);
  const cityZ = Math.round((cityBounds.minZ + cityBounds.maxZ) / 2);
  // 东侧起点：整个整形区都要出城（不是圆心出城 —— 用户要求「只显示在 City 东方」，
  // 湖的整个圆都在城东才成立）。
  //
  // ⚠️ **必须 +1**（v2.11 实测踩到的 off-by-one）：不加的话第一个候选的
  // 「圆→城市 AABB 净距」恰好等于 `OUTER + CLEAR`，而判据 `gap <= 0` 会把
  // **恰好接触**当成重叠 → 全体候选被拒 → **永远返回 null**（且因为每个候选都要
  // 重建 `fixedBlockers`，探错路径要跑 1000+ 次 ≈ 18 秒才返回）。
  const baseX = cityBounds.maxX + LAKE_RADIUS + BEACH_WIDTH + CITY_CLEARANCE + 1;
  for (let gap = 0; gap <= SHALLOW_TARN_MAX_GAP; gap += GAP_STEP) {
    for (const dz of DZ_OFFSETS) {
      yield { wx: baseX + gap, wz: cityZ + dz, cityBounds };
    }
  }
}

/**
 * 固定占位物集合（本结构必须让路的东西）—— **按 seed 算一次、全部候选共用**。
 *
 * ## ⚠️ 这里只收两类：高台地带 + 城门竞技场
 *
 * **地标（金字塔 / 冰封山 / 岛 / 平地 / 雪原）刻意不在这个列表里** ——
 * 实测（10 seed）把它们全算进来时 **无一个落点合法**：
 * `regionLandmarkCenters` 每个 region 返回 2~4 个圆、雪原再一个，而 region 边长仅 400 格；
 * 木湖半径 262（湖+沙滩）的面积 21.5 万格 > region 面积 16 万格 ⇒ 圆几乎必然压到至少一个。
 * 实测清空率约 0.2%，盲搜无解。
 *
 * ✅ **正确做法（与高台地带同源）**：不避让地标，而是**落点所在 region 压制自己的地标**
 * （见 `shallowTarnSuppressedLandmarks`，由 `structure-layout.js` 消费
 * ——`pyramid / frozenMountain / plainLand / island = null`，与 `tarn ? null : …` 同一手法）。
 * 地段是**地基级内容**，压过地标是既有已定口径。
 *
 * ## 只收「地基级大结构」，不收点状内容
 * 撒布结构 / 树 / 巨树 / 杜鹃由本结构**反向让路**（`pointContext` 的
 * `kind:'shallowTarn'` 一个分支覆盖五个消费者 + `apply.js` 阶段 2.7 的
 * `inShallowTarnFootprint` 剔除）。与竞技场、巨型金字塔同一裁定（设计文档 §12）。
 *
 * ## 性能：全区一次收集、全部候选共用
 * ⚠️ **不能写成「按候选点算」**：搜索路径 1000+ 个候选 × 每个候选 ~50 个 region，
 * 而 `computeRegionLocalGiantPyramid` 实测 **1.44 ms/次** ⇒ 1000 候选 ≈ 13 秒（v2.11 实测）。
 * 现在只收集两类（且高台地带的 `isTarnZone` 廉价门先挡掉 80%），~50 region ≈ 几十毫秒，每 seed 一次。
 *
 * @param {number} seed @param {{maxX:number,minZ:number,maxZ:number}} cityBounds
 * @returns {Array<{minX:number,maxX:number,minZ:number,maxZ:number}>}
 */
function fixedBlockers(seed, cityBounds) {
  const cached = blockerCache.get(seed);
  if (cached) return cached;

  const out = [];
  const R = LAKE_RADIUS + BEACH_WIDTH;
  const cityZ = Math.round((cityBounds.minZ + cityBounds.maxZ) / 2);
  const baseX = cityBounds.maxX + R + CITY_CLEARANCE + 1;
  const maxDz = DZ_OFFSETS.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const pad = R + 200;
  const rxLo = Math.floor((baseX - pad) / REGION_SIZE);
  const rxHi = Math.floor((baseX + SHALLOW_TARN_MAX_GAP + pad) / REGION_SIZE);
  const rzLo = Math.floor((cityZ - maxDz - pad) / REGION_SIZE);
  const rzHi = Math.floor((cityZ + maxDz + pad) / REGION_SIZE);
  for (let rx = rxLo; rx <= rxHi; rx++) {
    for (let rz = rzLo; rz <= rzHi; rz++) {
      // 高台地带：整圆让路（地带是地基级内容，与本地图同级别，两者不得重叠）。
      if (isTarnZone(rx, rz, seed)) {
        const t = computeTarnZone(rx, rz, seed);
        if (t) {
          out.push({
            minX: t.cx - TARN_ZONE_RADIUS, maxX: t.cx + TARN_ZONE_RADIUS,
            minZ: t.cz - TARN_ZONE_RADIUS, maxZ: t.cz + TARN_ZONE_RADIUS,
          });
        }
      }
    }
  }
  // 城门竞技场（全世界一个，与本地图同属「地面级大结构」，互不重叠）
  const arena = computeArenaAnchor(seed);
  if (arena) {
    out.push({
      minX: arena.wx - ARENA_HALF_X, maxX: arena.wx + ARENA_HALF_X,
      minZ: arena.wz - ARENA_HALF_Z, maxZ: arena.wz + ARENA_HALF_Z,
    });
  }

  if (blockerCache.size >= BLOCKER_CACHE_MAX) {
    blockerCache.delete(blockerCache.keys().next().value);
  }
  blockerCache.set(seed, out);
  return out;
}

function circleRectGap(cx, cz, radius, rect) {
  const dx = Math.max(0, rect.minX - cx, cx - rect.maxX);
  const dz = Math.max(0, rect.minZ - cz, cz - rect.maxZ);
  return Math.hypot(dx, dz) - radius;
}

/**
 * 浅水高台的落点（每个 seed 至多一个）。
 *
 * ## 判据（全部满足才算合法）
 *   ① **整个整形区都在 City 东侧**（`baseX` 已含 `OUTER_RADIUS + CITY_CLEARANCE`）；
 *   ② 与城市 bounds 的净距 ≥ `CITY_TRANSITION_SIZE`；
 *   ③ 与任何固定地标圆 / 巨型金字塔 / 高台地带 / 雪原 / 城门竞技场不重叠。
 *
 * ⚠️ **刻意不判「天然地形是浅水」**：实测扫 3 个 seed（x∈[640,2600] × z∈[-900,900]，
 * 步长 60）**没有一个点**满足「半径 240 的圆外 60 格环带 97% 干燥」（最高 84%）——
 * 基础地形噪声波长约 78 格而 `SEA_Y` 恰在中位，大范围都是半湿半干。
 * 故地形必须自己整形（`shallow-water-terrain.js`），要求天然浅水会让落点恒为 null。
 *
 * @param {number} seed
 * @returns {{wx:number, wz:number, lakeFloorY:number, cityBounds:Object}|null}
 */
export function computeShallowTarnAnchor(seed) {
  const cached = anchorCache.get(seed);
  if (cached !== undefined) return cached;

  // 硬净空半径 = 湖 + 沙滩（**不含缓坡**）。
  //
  // ⚠️ **缓坡不参与净空判据**：缓坡只是「地表高度插值回自然地形」，它不把地标变成
  // 本地图的一部分，也不与地标争地（自然地标本身会覆写地形）。把它算进净空会让
  // 有效半径从 262 涨到 342，在 400 格 region 网格上几乎必然撞到邻区地标（实测 0.2% 通过率）。
  // 而缓坡带内若有地标（金字塔/雪原），地标自己的整形会赢 —— 那正是「有梯度的衔接」的正确表现。
  const HARD = LAKE_RADIUS + BEACH_WIDTH;
  let result = null;
  let blockers = null;
  for (const cand of candidateCenters(seed)) {
    const { wx, wz, cityBounds } = cand;
    // ② 城市：硬净空圆整圆都在城东（`>=` 留净距，不是「圆心出城」）
    if (wx - HARD - CITY_CLEARANCE < cityBounds.maxX) continue;
    const cityRect = {
      minX: cityBounds.minX, maxX: cityBounds.maxX,
      minZ: cityBounds.minZ, maxZ: cityBounds.maxZ,
    };
    if (circleRectGap(wx, wz, HARD + CITY_CLEARANCE, cityRect) <= 0) continue;
    // ③ 高台地带 / 竞技场（懒建：只有真进到这一步才付一次性收集成本）
    if (!blockers) blockers = fixedBlockers(seed, cityBounds);
    if (blockers.some((b) => circleRectGap(wx, wz, HARD, b) <= 0)) continue;
    result = {
      wx, wz,
      lakeFloorY: LAKE_FLOOR_Y,
      cityBounds,
      // 硬净空半径（湖 + 沙滩）—— `shallowTarnSuppressedLandmarks` 用它判「哪些地标在湖里」。
      // ⚠️ 刻意不含缓坡：见 `fixedBlockers` 的注释（含缓坡会让 10 seed 全部失效）。
      hardRadius: HARD,
    };
    break;
  }

  if (anchorCache.size >= ANCHOR_CACHE_MAX) {
    anchorCache.delete(anchorCache.keys().next().value);
  }
  anchorCache.set(seed, result);
  return result;
}

// ==================== ② 环排布 ====================

/**
 * 五座的环上落位（纯函数，`(seed)` 决定抖动）。
 *
 * ## 算法（与 `tarn-zone.js` 的 `tarnRingMetrics` 同构）
 * 1. 按 `max(hiX, hiZ)` **降序**入环 —— 大座先占角，占角才与真实占地同序
 *    （否则大小悬殊的五座会被均分到等角位上，大座互相插进去）。
 * 2. 占角 `occ_i = 2·asin(maxHalf_i / RING_RADIUS)`。
 * 3. 缝角 `gap = (2π − Σocc) / 5`。
 * 4. **零和抖动**：每缝加 `(seededRandom − 0.5)·2·jitterMax` 后**减去均值**
 *    （Σ 缝角守恒；否则 5 个缝整体偏一点，最后一座会绕回第一座撞上）。
 *
 * ## `jitterMax` 逐 seed 二分求
 * 上界 = 「`JITTER_SAMPLE_COUNT` 组抽样下，相邻 AABB 真实间距仍 ≥ `SHALLOW_TARN_GAP`」
 * 的最大幅度，再乘 `JITTER_SAFETY_RATIO`（0.8）留余量。
 *
 * ⚠️ **不得写死 jitterMax**（与 `tarn-zone.js` 的 `tarnJitterMax` 同一理由）：
 * 真实上界由环半径 / 变体组合 / 间距阈值耦合决定，写死任一个数都会在改其中一项时
 * **静默失效**（抖动超出预算 → 两座压在一起）。
 *
 * @param {number} seed
 * @returns {{
 *   ang: number, cx: number, cz: number, variant: string,
 *   loX: number, hiX: number, loZ: number, hiZ: number
 * }[]} 五座（已按入环顺序）
 */
export function computeShallowTarnLayout(seed) {
  const placed = [];
  const R = SHALLOW_TARN_RING_RADIUS;
  const variants = SHALLOW_TARN_VARIANTS
    .map((variant) => ({ variant, ...shallowTarnHalfWidth(variant) }))
    .sort((a, b) => Math.max(b.hiX, b.hiZ, b.loX, b.loZ) - Math.max(a.hiX, a.hiZ, a.loX, a.loZ));
  const occ = variants.map((v) => 2 * Math.asin(Math.max(v.hiX, v.hiZ, v.loX, v.loZ) / R));
  const totalOcc = occ.reduce((s, v) => s + v, 0);
  const gapAngle = (2 * Math.PI - totalOcc) / variants.length;
  const jitterMax = shallowTarnJitterMax(occ, gapAngle);
  const raw = [];
  for (let i = 0; i < variants.length; i++) {
    raw.push((seededRandom(i, 0, seed + SHALLOW_TARN_ANGLE_SALT) - 0.5) * 2 * jitterMax);
  }
  const mean = raw.reduce((s, v) => s + v, 0) / raw.length;
  const jitter = raw.map((v) => v - mean);

  let cursor = 0;
  for (let i = 0; i < variants.length; i++) {
    cursor += occ[i];
    const ang = cursor - occ[i] / 2;
    cursor += gapAngle + jitter[i];
    const v = variants[i];
    placed.push({
      variant: v.variant,
      ang,
      cx: R * Math.cos(ang),
      cz: R * Math.sin(ang),
      loX: v.loX, hiX: v.hiX, loZ: v.loZ, hiZ: v.hiZ,
    });
  }
  return placed;
}

/** 抖动抽样组数（二分用） */
const JITTER_SAMPLE_COUNT = 240;
/** 二分步数 */
const JITTER_BISECT_STEPS = 28;
/** 抖动取二分上界的 0.8 倍（留 20% 余量） */
const JITTER_SAFETY_RATIO = 0.8;

const jitterCache = new Map();

/**
 * @param {number[]} occ @param {number} gapAngle @returns {number} jitterMax（弧度）
 */
function shallowTarnJitterMax(occ, gapAngle) {
  const key = `${occ.map((v) => v.toFixed(6)).join(',')}|${gapAngle.toFixed(6)}`;
  const cached = jitterCache.get(key);
  if (cached !== undefined) return cached;

  let lo = 0;
  let hi = gapAngle / 2;
  for (let step = 0; step < JITTER_BISECT_STEPS; step++) {
    const mid = (lo + hi) / 2;
    if (worstAdjacentGap(occ, gapAngle, mid) >= SHALLOW_TARN_GAP) lo = mid;
    else hi = mid;
  }
  const jitterMax = lo * JITTER_SAFETY_RATIO;
  jitterCache.set(key, jitterMax);
  return jitterMax;
}

/**
 * 一组抖动幅度下，`JITTER_SAMPLE_COUNT` 组抽样里**最坏**的相邻 AABB 间距。
 *
 * ⚠️ 抽样序列 `(i, sampleIndex, seed=SALT)` 是**载荷性约定**：换一套会得到不同的
 * jitterMax 区间 —— 数字对不上不是实现错，是约定变了（`tarn-zone.js` 的同一条教训）。
 */
function worstAdjacentGap(occ, gapAngle, amplitude) {
  const R = SHALLOW_TARN_RING_RADIUS;
  const n = occ.length;
  const hw = SHALLOW_TARN_VARIANTS
    .map((v) => ({ v, ...shallowTarnHalfWidth(v) }))
    .sort((a, b) => Math.max(b.hiX, b.hiZ, b.loX, b.loZ) - Math.max(a.hiX, a.hiZ, a.loX, a.loZ));
  let worst = Infinity;
  for (let sample = 0; sample < JITTER_SAMPLE_COUNT; sample++) {
    const raw = [];
    for (let i = 0; i < n; i++) {
      raw.push((seededRandom(i, sample, SHALLOW_TARN_ANGLE_SALT) - 0.5) * 2 * amplitude);
    }
    const mean = raw.reduce((s, v) => s + v, 0) / n;
    const jitter = raw.map((v) => v - mean);
    let cursor = 0;
    const placed = [];
    for (let i = 0; i < n; i++) {
      cursor += occ[i];
      const ang = cursor - occ[i] / 2;
      cursor += gapAngle + jitter[i];
      const w = hw[i];
      placed.push({
        cx: R * Math.cos(ang), cz: R * Math.sin(ang),
        loX: w.loX, hiX: w.hiX, loZ: w.loZ, hiZ: w.hiZ,
      });
    }
    for (let i = 0; i < n; i++) {
      const gap = shallowTarnAabbGap(placed[i], placed[(i + 1) % n]);
      if (gap < worst) worst = gap;
    }
  }
  return worst;
}

// ==================== ③ 占地判据 ====================

/**
 * 点是否落在浅水高台的**整形区**内（湖 + 沙滩 + 缓坡，半径 `OUTER_RADIUS`）。
 *
 * 供 `apply.js` 的 `pointContext` 与阶段 2.7 的撒布剔除消费。
 * 与 `inGiantPyramidFootprint` / `inArenaFootprint` 同签名同语义：
 * 传 `layouts.map(l => l.shallowTarn)` 即可，`null` 元素安全跳过。
 *
 * ⚠️ **判据用「整形区」而不是「湖」**：整个整形区的地表都被改写过（缓坡也是），
 * 树/结构中在缓坡上会穿模；且用户要的是「与其他地形有梯度的衔接」——
 * 缓坡是本地图的一部分。
 *
 * @param {number} wx @param {number} wz
 * @param {Array<{wx:number, wz:number}|null>} anchors
 */
export function inShallowTarnFootprint(wx, wz, anchors) {
  if (!anchors) return false;
  const r2 = SHALLOW_TARN_OUTER_RADIUS * SHALLOW_TARN_OUTER_RADIUS;
  for (const a of anchors) {
    if (!a) continue;
    const dx = wx - a.wx, dz = wz - a.wz;
    if (dx * dx + dz * dz < r2) return true;
  }
  return false;
}

/**
 * 浅水高台的整形区是否与本 region 相交（layout 层裁剪用：不相交则不携带锚点，
 * 省掉跨 region 的无谓下发）。
 *
 * ⚠️ **不能写成 `tarn ? null : …`**（与竞技场同一条教训）：整形区半径 342 可跨 region，
 * 而它只应让**相交的** region 携带。若地带 region 把它压成 null，该 region 负责的那部分
 * 就**静默缺半边**（方块层面看不出是 layout 缺字段）。
 * 本结构的锚点判据已避开高台地带（§`fixedBlockers`），能相交的只是整形区边缘探进
 * 地带 region 的矩形范围（圆外那部分仍是普通地形）。
 *
 * @param {{wx:number, wz:number}|null} anchor
 * @param {number} regionX @param {number} regionZ
 */
export function shallowTarnOverlapsRegion(anchor, regionX, regionZ) {
  if (!anchor) return false;
  const minX = anchor.wx - SHALLOW_TARN_OUTER_RADIUS, maxX = anchor.wx + SHALLOW_TARN_OUTER_RADIUS;
  const minZ = anchor.wz - SHALLOW_TARN_OUTER_RADIUS, maxZ = anchor.wz + SHALLOW_TARN_OUTER_RADIUS;
  const rMinX = regionX * REGION_SIZE, rMaxX = rMinX + REGION_SIZE - 1;
  const rMinZ = regionZ * REGION_SIZE, rMaxZ = rMinZ + REGION_SIZE - 1;
  return minX <= rMaxX && maxX >= rMinX && minZ <= rMaxZ && maxZ >= rMinZ;
}

/**
 * 本 region 的**哪些地标**落在浅水高台的硬半径（湖 + 沙滩）内 → 供 `structure-layout.js` 压成 null。
 *
 * ## 为什么用「地标中心是否在湖内」而不是「本 region 是不是圆心 region」
 * 湖直径 324（含沙滩）跨 1~2 个 region，而圆心所在那个 region 里可能一个地标都没有、
 * 地标全在邻居 region。按「圆心 region」压制会同时错两头：
 * ① 压掉一个本来没冲突的地标（零回归失败 —— `test-tarn-zone.js` 的
 *    「非地带且雪原未让路的 region 逐字段零回归」当场拓到）；
 * ② 又不压真正冲突的那些。
 *
 * ## 与 `fixedBlockers`（锚点层）的分工
 * `fixedBlockers` 回避的是「不能与本地图共存的地基级大结构」（高台地带 / 竞技场）——
 * 那些必须在**选点前**就排除。地标不是回避对象，而是「选点后把它压掉」，
 * 因为回避在几何上不可能（见 `fixedBlockers` 注释）。
 *
 * @param {{wx:number, wz:number, hardRadius:number}} anchor
 * @param {number} regionX @param {number} regionZ @param {number} seed
 * @returns {{pyramid:boolean, frozenMountain:boolean, plainLand:boolean, island:boolean, snowLand:boolean}}
 */
export function shallowTarnSuppressedLandmarks(anchor, regionX, regionZ, seed) {
  const R2 = anchor.hardRadius * anchor.hardRadius;
  const inside = (cx, cz) => {
    const dx = cx - anchor.wx, dz = cz - anchor.wz;
    return dx * dx + dz * dz < R2;
  };
  const out = { pyramid: false, frozenMountain: false, plainLand: false, island: false, snowLand: false };

  const py = getPyramidCenterInRegion(regionX, regionZ, seed);
  if (py && inside(py.cx, py.cz)) out.pyramid = true;
  const fm = getFrozenMountainCenterInRegion(regionX, regionZ, seed);
  if (fm && inside(fm.cx, fm.cz)) out.frozenMountain = true;
  const plain = getPlainLandCenterInRegion(regionX, regionZ, seed);
  if (plain && inside(plain.cx, plain.cz)) out.plainLand = true;
  const isl = getIslandCenterInRegion(regionX, regionZ, seed);
  if (isl && inside(isl.islandCx, isl.islandCz)) out.island = true;
  // 雪原：中心由 region 播种中心 + 固定偏移派生（与 `computeRegionLayout` 同源常量）
  const raw = getRegionSeededCenter(regionX, regionZ, seed);
  const sx = raw.centerX + LANDMARK_OFFSET.SNOW_LAND_X;
  const sz = raw.centerZ + LANDMARK_OFFSET.SNOW_LAND_Z;
  if (inside(sx, sz)) out.snowLand = true;
  return out;
}

/** 供测试与面板复用的导出（避免单测自己写一份常量） */
export const SHALLOW_TARN_CITY_CLEARANCE = CITY_CLEARANCE;

/** 城市 bounds 的派生只读快照（面板/瞬移要用，避免调用方自己解引用 scheduler 内部结构） */
export function shallowTarnCityBounds(seed) {
  return getCityBoundsForSeed(seed);
}
