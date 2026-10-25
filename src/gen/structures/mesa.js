// src/gen/structures/mesa.js — Cloudland 高台（桌山景观）落点候选发现
// 设计文档 docs/superpowers/specs/2026-10-24-cloudland-mesa-design.md §3.3
//
// 两段式的**前一段**（与 scatter / giant-trees 同构，红线 2）：
//   本文件          computeMesaAnchor()：region 级候选发现（纯函数、无状态、跨 region 无缝）
//   apply.js 阶段 2.75  按锚点光栅化 + 让路判据
//
// Worker 同构：本文件不得 import three、不得自建 Worker、**不得 fetch**
// （候选在 layout 层算一次，DR-13；见「为什么用常量矩形而不是产物掩码」）。
//
// ## 素材形态决定了判据（实测，勿按「高台 = 下宽上窄」的直觉改）
// Landscape/9 是**桌山（蘑菇形）**：基座只有 15×15（164 格）、中部收腰、顶部 17×17 更宽。
// 所以「地基判据」必须落在**基座**上，不能落在 20×21 的并集外接框上 —— 并集里有 85 格
// （20%）在基座上根本没有方块，拿它做判据会把合法落点误杀，也会要求本不需要支撑的列。
//
// ## 为什么用常量矩形而不是烘焙产物里的 164 格掩码
// 掩码只存在于 `assets/structures/cloudland_mesa_small.json`，读它必须 fetch；而本函数在
// layout 层（Worker 内、纯函数）跑，fetch 会违反 DR-13 的「候选在 layout 层算一次」。
// 实测对照（16 个 region，同 seed 交替）：
//   A 164 格真实掩码 → 16/16 命中，锚点逐个一致，p50 0.39ms / max 0.95ms
//   B 15×15 实心矩形 → 16/16 命中，锚点逐个一致，p50 0.35ms / max 0.60ms
// B 只是多查 61 个角格；其 floorY 只会**更低或相等**（矩形包含对角低点）→ 埋没量略大但
// **绝不悬空**，方向安全。故取 B。
import { getBiome, seededRandom } from '../noise.js';
import { generateHeight } from '../terrain.js';
import { computeSkyCandidates } from './sky-structures.js';
import { SEA_Y } from '../../voxel/constants.js';
import {
  getPyramidCenterInRegion, getFrozenMountainCenterInRegion,
  getIslandCenterInRegion, getPlainLandCenterInRegion, isIslandValid, isPlainLandValid,
} from './landmarks.js';
import { getRegionSeededCenter } from './region-center.js';
import {
  REGION_SIZE, PYRAMID_SIZE, FROZEN_MOUNTAIN_SIZE, SNOW_LAND_SIZE, ISLAND_SIZE,
  PLAIN_LAND_SIZE, TRANSITION_SIZE, LANDMARK_OFFSET,
} from './region-config.js';

/**
 * 基座半宽：基座是 x∈[-7,7] z∈[-7,7] 的 15×15 框（实测 164 格全落在框内）。
 * 改这个值必须同步 `MESA_METRICS.baseCells` 的语义（那是真实掩码的格数，不是矩形格数）。
 */
export const MESA_BASE_RECT_HALF = 7;

/**
 * 并集外接框半宽：**全部 335 列**的占地 bbox 是 x∈[-9,10] z∈[-11,9]（实测），
 * 取两个方向的最大绝对值 11。两个用途：① region 内缩量；② 空岛冲突的 AABB 外扩。
 */
export const MESA_UNION_HALF = 11;

/**
 * 台顶最高位（相对产物 y=1 的层高，实测 Landscape/9 是 42）。
 * 空岛冲突判据用它：空岛底 y 必须高于 `floorY + MESA_TOP_REL_Y`，否则台顶穿岛。
 */
export const MESA_TOP_REL_Y = 42;

/**
 * 候选排序（确定性乱序）的 salt。
 *
 * ⚠️ **程序化扫描确认空闲**，不能只 grep 字面量（带 `+ step`/`+ y` 的调用点占用的是区间）：
 *   · 已占用单值：100 / 200 / 201 / 301 / 302 / 303 / 311~314 / 777 / 800 / 801 /
 *     803~805 / 812 / 823 / 824 / 826 / 911 / 921 / 931 / 1000 / 2000 / … / 16000
 *   · 已占用区间：58..107（云簇 frontier `seed+58+step`）、270..397（landmarks `seed+302+y`）、
 *     102..112（terrain `seed+100+k`）
 *   → 空闲带 932..999，本设计取 950。
 */
export const MESA_SALT = 950;

/**
 * 候选扫描步长。实测 step=8：`getBiome` 全扫 0.067ms/region；step=1 要 3.79ms/region。
 * 步长 8 在 400×400 里仍有 ~250~1100 个沙漠候选点，贪心命中前 1~11 个就够（实测 max 11）。
 */
const SCAN_STEP = 8;

/**
 * region 内缩量：并集半宽 + 2 格余量。
 * 锚点离 region 边界更近时，20×21 的占地会越界，而相邻 region 的 layout **不会**为它生成
 * 锚点（各 region 独立算候选）⇒ 高台半边永久消失。这是「跨 region 边界缺一块」的唯一护栏。
 */
const REGION_INSET = MESA_UNION_HALF + 2;

/**
 * 两个高台之间的最小切比雪夫距离（格）。小于这个距离时，**字典序更小的 region 保留、后来的让位**。
 *
 * 取值依据（实测，勿随意调小）：
 * 沙漠按 8 格粒度切连通块，±1200 格内 24 块，**最大跨度 368 格**。块内任意两点的
 * 切比雪夫距离 ≤ 该块跨度 → 阈值只要 **> 368**，就不可能在同一块沙漠里留下两个高台。
 * 取 384（= 368 上取整到最近的 32 倍数 + 余量）。
 *
 * ⚠️ **这是「一块沙漠地界只有一个高台」的唯一护栏**。原来的「每 region 一个」不够：
 * region 是 400×400 的**矩形网格**，而沙漠是**不规则块**，一块沙漠经常横跨 2~4 个 region
 * → 每个 region 各放一个 → 一块沙漠里 2~4 个（实测 ±6 region 内 163 个高台里 150 个
 * 有 <400 格的邻居，最近一对仅隔 32 格）。
 */
export const MESA_MIN_SPACING = 384;

/**
 * 邻域去重需要查多少圈 region。`ceil(MESA_MIN_SPACING / REGION_SIZE) + 1`：
 * 384 / 400 → 1，+1 余量 → 2（锚点可在 region 内任意位置，1 圈不一定足够）。
 */
const NEIGHBOR_RINGS = Math.ceil(MESA_MIN_SPACING / REGION_SIZE) + 1;

/**
 * `computeRegionLocalAnchor` 的结果缓存。
 *
 * **为什么必须有**：邻域去重要查 `(2*2+1)² - 1 = 24` 个邻域 region，而单次
 * `computeRegionLocalAnchor` 实测 0.32ms（要扫 400×400 的 biome + 对命中点做 164 格全检）
 * → 不去重 0.32ms、去重后实测 **3.46ms/region**（+10×）。layout 全量会从 2.9~3.3ms
 * 推到 6.5ms+，撞破 §1.2 的「layout 增加 ≤ 15%」门。
 *
 * 缓存是**安全的**：`computeRegionLocalAnchor` 是 `(regionX, regionZ, seed)` 的纯函数，
 * 同一 seed 下结果恒定（红线 2）。键里带 seed，换 seed 不会读到旧值。
 * 容量上限 512 项（≈ 足够装下视距内全部 region 的 3×3 邻域），LRU 淘汰。
 */
const localAnchorCache = new Map();
const LOCAL_CACHE_MAX = 512;

/** @returns {{wx:number, wz:number, floorY:number}|null} */
function cachedLocalAnchor(regionX, regionZ, seed) {
  const key = `${seed}:${regionX},${regionZ}`;
  if (localAnchorCache.has(key)) return localAnchorCache.get(key);
  const v = computeRegionLocalAnchor(regionX, regionZ, seed);
  if (localAnchorCache.size >= LOCAL_CACHE_MAX) {
    // 简单 LRU：删最早插入的一项（Map 保序）
    localAnchorCache.delete(localAnchorCache.keys().next().value);
  }
  localAnchorCache.set(key, v);
  return v;
}

/** 清空缓存（单测隔离用；生产代码不需要调用） */
export function clearMesaAnchorCache() {
  localAnchorCache.clear();
}

/**
 * 各 region 地标的「占地半径」表（用于候选层排除）。
 *
 * ⚠️ **为什么地标排除必须在候选层而不能只在 apply 层**（实测踩到的真缺陷）：
 * 只靠 apply 层让路时，候选层会选出一个落在冰封山上的锚点（实测 region(1,-1) 的
 * 锚点 (589,-131) 距冰封山中心仅 **11 格** → `pointContext` 判 `fm` → apply 正确丢弃），
 * 后果有两个：
 *   ① 那个 region 的高台**静默消失**（不是错位，是完全没有）；
 *   ② 间距去重基于了错误的落点集合 —— 一个其实不存在的高台把邻居高台挤掉了。
 * 所以候选选择时就要跳过地标占地。apply 层的 `pointContext` 仍然保留，作纵深防御
 * （城市 bounds 跳 region 那种情况候选层判不了）。
 *
 * 半径取「核心 + 过渡带」的保守值：宁可多避让几格，也不要一个半边压在地标上的台。
 */
const LANDMARK_CLEARANCE = Object.freeze({
  pyramid: PYRAMID_SIZE / 2 + TRANSITION_SIZE.PYRAMID,
  frozenMountain: FROZEN_MOUNTAIN_SIZE / 2 + TRANSITION_SIZE.FROZEN_MOUNTAIN,
  snowLand: SNOW_LAND_SIZE / 2 + TRANSITION_SIZE.SNOW_LAND,
  island: ISLAND_SIZE / 2 + TRANSITION_SIZE.ISLAND,
  plainLand: PLAIN_LAND_SIZE / 2,
});

/** 地标中心与半径（一个 region 只需算一次） */
function landmarkCircles(regionX, regionZ, seed) {
  const circles = [];
  const push = (c, r) => { if (c) circles.push({ cx: c.cx, cz: c.cz, r }); };

  push(getPyramidCenterInRegion(regionX, regionZ, seed), LANDMARK_CLEARANCE.pyramid);
  push(getFrozenMountainCenterInRegion(regionX, regionZ, seed), LANDMARK_CLEARANCE.frozenMountain);

  // 雪原：与 structure-layout.js 同一推导（未 clamp 的原始中心 + 偏移）——
  // 没有 `getSnowLandCenterInRegion` 导出，这里复现那两行（若 layout 改了须同步）。
  const raw = getRegionSeededCenter(regionX, regionZ, seed);
  push({ cx: raw.centerX + LANDMARK_OFFSET.SNOW_LAND_X, cz: raw.centerZ + LANDMARK_OFFSET.SNOW_LAND_Z },
    LANDMARK_CLEARANCE.snowLand);

  // 平地与海岛是**条件地标**（isXxxValid 为假时 layout 里它们是 null）—— 这里同样只排除有效的
  const plain = getPlainLandCenterInRegion(regionX, regionZ, seed);
  if (isPlainLandValid(plain.cx, plain.cz, seed)) push(plain, LANDMARK_CLEARANCE.plainLand);
  const isl = getIslandCenterInRegion(regionX, regionZ, seed);
  if (isIslandValid(isl.islandCx, isl.islandCz, seed)) push({ cx: isl.islandCx, cz: isl.islandCz }, LANDMARK_CLEARANCE.island);

  return circles;
}

/**
 * 台体是否压在地标上（用并集外接框的圆近似：`MESA_UNION_HALF * √2` 保守覆盖对角）。
 */
function overlapsLandmark(circles, wx, wz) {
  const reach = MESA_UNION_HALF * Math.SQRT2;
  for (const c of circles) {
    if (Math.abs(c.cx - wx) > c.r + reach) continue;
    if (Math.abs(c.cz - wz) > c.r + reach) continue;
    return true;
  }
  return false;
}

/**
 * 计算单个 region 的高台锚点（至多 1 个）。
 *
 * 判据四条，缺一不可（每条都对应一种「静默产出错误高台」的缺陷，见 test-mesa.js）：
 *   ① 基座 15×15 每列都是 DESERT              —— 否则高台一半长在草地上
 *   ② 基座 15×15 每列 generateHeight > SEA_Y   —— 否则高台一半扎在海底
 *   ③ 不与任何空岛 AABB 相交（台顶不得穿岛）
 *   ④ 并集外接框完整落在本 region 内（内缩 REGION_INSET）
 *
 * `floorY = min(基座各列地表 h)` —— 取 **min** 而非中心点高度：min 保证任何一列基座都不悬空
 * （取中心点会让低洼侧露出空隙，实测 8% 的候选会有 4~8 格空隙）。代价是占地内高处的地形被
 * 台体埋没 ≤span 格（实测 span p50=1 / p95=3 / max=4，与「山体埋进地形」同一观感）。
 *
 * @param {number} regionX
 * @param {number} regionZ
 * @param {number} seed
 * @returns {{wx: number, wz: number, floorY: number}|null} 无沙漠 / 无合法落点时 null
 */
export function computeMesaAnchor(regionX, regionZ, seed) {
  const own = cachedLocalAnchor(regionX, regionZ, seed);
  if (!own) return null;

  // 邻域去重：一块沙漠只留一个高台（判据见 MESA_MIN_SPACING 的注释）。
  //
  // 为什么是「只跟字典序更小的 region 比」而不是「互相让位」：互相让位会让相邻两个
  // region 各自看到对方、双双放弃 → 那块沙漠一个高台都没有（与需求相反）。
  // 单向比较（后来的让给先到的）保证至少一个能留下，且**跨 region 结果一致**
  // ——每个 region 自己那一侧算的是同一批纯函数调用，不需要任何共享状态（红线 2）。
  //
  // ⚠️ **先按 region 矩形距离剪枝，再算邻域的 localAnchor**（性能关键）：
  // 单个 localAnchor 实测 0.28ms（要扫 400×400 的 biome + 对命中点做 225 格全检），
  // 24 个邻域全算 = 6.7ms → layout 从 3ms 涨到 4.9ms，撞破 §1.2 的 15% 门。
  // 剪枝依据：本 region 的任何一个点都落在它自己的 400×400 矩形里，邻 region 同理
  // → 两个矩形的最小切比雪夫距离 = `(|dx|-1)*REGION_SIZE`（dx 以 region 为单位）。
  // 若该距离 ≥ MESA_MIN_SPACING，那它不可能在阈值内 → 直接跳过，一次 localAnchor 都不算。
  for (let dx = -NEIGHBOR_RINGS; dx <= NEIGHBOR_RINGS; dx++) {
    for (let dz = -NEIGHBOR_RINGS; dz <= NEIGHBOR_RINGS; dz++) {
      if (dx === 0 && dz === 0) continue;
      const nx = regionX + dx, nz = regionZ + dz;
      // 只查字典序更小的 region（单向，防互让全灭）
      if (nx > regionX || (nx === regionX && nz >= regionZ)) continue;
      // 两个 region 矩形的最近可能切比雪夫距离（同轴时 =0，相邻时 =0，隔一圈时 =400…）
      const minRectDist = Math.max(Math.abs(dx) - 1, 0, Math.abs(dz) - 1) * REGION_SIZE;
      if (minRectDist >= MESA_MIN_SPACING) continue;
      const other = cachedLocalAnchor(nx, nz, seed);
      if (!other) continue;
      const d = Math.max(Math.abs(own.wx - other.wx), Math.abs(own.wz - other.wz));
      if (d < MESA_MIN_SPACING) return null;
    }
  }
  return own;
}

/**
 * region 内部的局部锚点（不含邻域去重）—— 只给 `computeMesaAnchor` 与去重循环自己用。
 * 命名带 `Local` 是提醒：这是**候选**，对外一律用 `computeMesaAnchor`。
 *
 * @param {number} regionX @param {number} regionZ @param {number} seed
 * @returns {{wx: number, wz: number, floorY: number}|null}
 */
export function computeRegionLocalAnchor(regionX, regionZ, seed) {
  const baseX = regionX * REGION_SIZE;
  const baseZ = regionZ * REGION_SIZE;
  const loX = baseX + REGION_INSET;
  const hiX = baseX + REGION_SIZE - REGION_INSET;
  const loZ = baseZ + REGION_INSET;
  const hiZ = baseZ + REGION_SIZE - REGION_INSET;

  // ① 便宜门：只查 biome 收集沙漠候选点（无候选 → 绝大多数非沙漠 region 在这里就返回）
  const cands = [];
  for (let wz = loZ; wz < hiZ; wz += SCAN_STEP) {
    for (let wx = loX; wx < hiX; wx += SCAN_STEP) {
      if (getBiome(wx, wz, seed) === 'DESERT') cands.push(wx, wz);
    }
  }
  if (cands.length === 0) return null;

  // ② 确定性乱序：按 seededRandom 升序，tie 用坐标字典序 → 跨机 / 跨 Worker 一致
  const order = [];
  for (let i = 0; i < cands.length; i += 2) order.push(i);
  order.sort((ia, ib) => {
    const ra = seededRandom(cands[ia], cands[ia + 1], seed + MESA_SALT);
    const rb = seededRandom(cands[ib], cands[ib + 1], seed + MESA_SALT);
    if (ra !== rb) return ra - rb;
    const dx = cands[ia] - cands[ib];
    if (dx !== 0) return dx;
    return cands[ia + 1] - cands[ib + 1];
  });

  const H = MESA_BASE_RECT_HALF;
  const sky = computeSkyCandidates(regionX, regionZ, seed).skyIslands;
  const circles = landmarkCircles(regionX, regionZ, seed);

  // ③ 就近命中即停
  for (const i of order) {
    const wx = cands[i], wz = cands[i + 1];

    // 基座全检（判据 ①②）：一趟同时算 biome、海平面、最低地表
    let minH = Infinity;
    let ok = true;
    for (let dz = -H; dz <= H && ok; dz++) {
      for (let dx = -H; dx <= H; dx++) {
        const nx = wx + dx, nz = wz + dz;
        if (getBiome(nx, nz, seed) !== 'DESERT') { ok = false; break; }
        const h = generateHeight(nx, nz, seed);
        if (h <= SEA_Y) { ok = false; break; }
        if (h < minH) minH = h;
      }
    }
    if (!ok) continue;

    // 判据 ③：不与任何空岛 AABB 相交（空岛底必须高于台顶）
    if (skyConflicts(sky, wx, wz, minH)) continue;

    // 判据 ④：不压地标（见 LANDMARK_CLEARANCE 的注释 —— 只在 apply 层判定会让高台静默消失）
    if (overlapsLandmark(circles, wx, wz)) continue;

    // 判据 ⑤（region 内缩）已由 REGION_INSET 的扫描窗构造性保证（扫描点本身就内缩了）
    return { wx, wz, floorY: minH };
  }
  return null;
}

/**
 * 台体与空岛的 AABB 冲突判定。
 *
 * 用 AABB 粗判而非逐格：空岛底 y∈[40,68]（region(1,1) 实测 68 个岛）、台顶最高 ≤ 53，
 * 判据已足够；逐格会引入不必要的复杂度，且空岛几何是逐层收窄的圆（AABB 已覆盖）。
 *
 * @param {Int32Array} islands stride 5: [originCx, originCz, bottomY, radius, height]
 */
function skyConflicts(islands, wx, wz, floorY) {
  const topY = floorY + MESA_TOP_REL_Y;
  for (let i = 0; i < islands.length; i += 5) {
    const ox = islands[i] * 16 + 8;
    const oz = islands[i + 1] * 16 + 8;
    const bottomY = islands[i + 2];
    const radius = islands[i + 3];
    // 水平不相交 → 不可能冲突
    if (Math.abs(ox - wx) > radius + MESA_UNION_HALF) continue;
    if (Math.abs(oz - wz) > radius + MESA_UNION_HALF) continue;
    // 空岛底低于台顶 → 穿岛
    if (bottomY <= topY) return true;
  }
  return false;
}
