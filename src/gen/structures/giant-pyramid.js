// src/gen/structures/giant-pyramid.js — 巨型金字塔落点候选发现（Giant Pyramid Epic）
// 设计文档 docs/superpowers/specs/2026-10-25-giant-pyramid-design.md §3 DR-1~DR-7
//
// 两段式的前一段（与 scatter / giant-trees / mesa 同构，红线 2）：
//   本文件               computeGiantPyramidAnchor()：region 级候选发现（纯函数、无状态、跨 region 无缝）
//   apply.js 阶段 2.76   按锚点光栅化 + 高台/城市/撒布的让路判据
//
// Worker 同构：本文件不得 import three、不得自建 Worker、**不得 fetch**
// （候选在 layout 层算一次，DR-13）。
//
// ## 为什么不像 desertPyramid 那样逐点撒布（DR-1）
// 逐点撒布没有间距护栏。本仓在高台（mesa）上实测过同类口径的失败形态：「一块沙漠里出现
// 2~4 个，最近一对仅隔 32 格」。金字塔占地 49×49 是沙漠神殿的 2 倍，重叠尤其难看。
//
// ## 为什么单位是「沙漠连通块」而不是 region（DR-2）
// region 是 400×400 的**矩形网格**，沙漠是**不规则块**。实测（8 格粒度，±1200）
// 沙漠连通块最大 bbox 跨度 **368 格**（跨 5 个 seed 稳定）→ 间距阈值取 384（>368）
// 即可保证「一块沙漠至多 1 座」。
import { getBiome, seededRandom } from '../noise.js';
import { generateHeight } from '../terrain.js';
import { SEA_Y } from '../../voxel/constants.js';
import { computeSkyCandidates } from './sky-structures.js';
// mesa 与 `regionLandmarkCenters` 是**单向依赖**（实测：mesa.js 只被 structure-layout / apply
// import，它自己不 import 本模块 —— 不成环）。
import { regionLandmarkCenters, computeRegionLocalAnchor, MESA_UNION_HALF } from './mesa.js';
import { getCityBoundsForSeed } from './city-layout.js';
import { REGION_SIZE } from './region-config.js';

/** 占地半宽：原模型 49×49 → 半宽 24（中心格 ±24 = 49 格）。 */
export const PYRAMID_HALF = 24;

/**
 * region 内缩量 = 半宽 + 1 格余量。
 *
 * 锚点离 region 边界更近时，49×49 占地会越界，而相邻 region 的 layout **不会**为它生成
 * 锚点（各 region 独立算候选）⇒ 金字塔半边永久消失。这是「跨 region 边界缺一块」的唯一护栏。
 */
export const PYRAMID_INSET = PYRAMID_HALF + 1;

/**
 * 结构高度（原模型有内容的 24 层，归一化后 y∈[1,24]）。
 * 塔顶世界高度 = `floorY + PYRAMID_HEIGHT`（`rasterizeStructure` 写入 y = `floorY + b.y`）。
 *
 * ⚠️ 改它之前先看 `test-giant-pyramid.js` 的「塔顶必须落在云层与空岛之下」用例：
 * 沙漠地表实测 max = 9，云簇 y=35、空岛底 y≥40 → 24 是安全上限。
 */
export const PYRAMID_HEIGHT = 24;

/**
 * 占地内地表高差上限（格）。
 *
 * 塔基最底层是**满铺 49×49 实心**（2401 格），所以不存在「整体悬空」。但占地内起伏太大时，
 * 低洼侧的塔身会一整段埋进沙里、高侧的底层会露在沙丘上方 —— 那不算悬空，却让底面不再是
 * 一条平线，观感上像「塔歪了」。
 *
 * 取值的实测依据（seed 12345，48 个非城市 region）：
 *   span ≤ 2 → 15% region 可用 / ≤ **4 → 31%** / ≤ 5 → 60% / ≤ 8 → 83%
 * 取 4 是「埋没量小」与「沙漠里不至于太稀」的折中（用户 2026-10-25 裁定）。
 */
export const PYRAMID_MAX_SURFACE_SPAN = 4;

/**
 * 两座金字塔之间的最小切比雪夫距离（格）。
 *
 * 取值依据（实测，勿随意调小）：8 格粒度下沙漠连通块最大 bbox 跨度 **368 格**（跨 5 seed
 * 稳定），块内任意两点的切比雪夫距离 ≤ 该跨度 → 阈值只要 **> 368** 就不可能在同一块沙漠里
 * 留下两个。取 384（= 368 上取整到最近的 32 倍数）。
 *
 * ⚠️ **这是「一块沙漠一座」的唯一护栏**。原方案考虑过「每 region 一处」，但 region 是矩形
 * 网格、沙漠是不规则块，一块沙漠常横跨 2~4 个 region（与高台踩过的坑同源）。
 */
export const PYRAMID_MIN_SPACING = 384;

/**
 * 概率门：最终锚点保留概率。
 *
 * **间距**保证「一块沙漠至多 1 座」（0 或 1 的上界）；**概率门**把「有锚点的沙漠」再抽掉
 * 一部分 → 密度「每 2 块沙漠 1 座」（用户 2026-10-25 裁定）。
 *
 * 标定依据（跨 8 seed、窗 ±3200、分母 = 沙漠连通块数，实测合计 902 块）：
 *   gate=1.0 → 0.904 ｜ 0.58 → 0.514 ｜ 0.57 → 0.507 ｜ **0.56 → 0.499** ｜ 0.55 → 0.487
 * 0.56 落在目标 0.5 上。改它必须重跑 `test-giant-pyramid.js` 的密度用例。
 *
 * ⚠️ **0.56 而非设计文档初稿的 0.53**：初稿标定时占地判据用 step=2 采样（0.055ms/候选），
 * 后来发现采样会少算地表高差（388 个样本里 1 个），改为**逐格全检**（0.207ms/候选）后
 * 筛掉的锚点变多 → 同一 gate 下密度下降 → 重标为 0.56。实测值，非拍脑袋。
 *
 * ⚠️ 这是**纯观感标定，不是性能代偿** —— 金字塔的顶点占用（逐 section 实测 opaque 65080 /
 * cutout 73170）只占通道 1.5% / 3.3%，不吃预算。
 *
 * ⚠️ **密度口径依赖测量窗**：窗越小，边界效应越明显（锚点在窗内、它的去重邻居在窗外 →
 * 看起来「本该被让位却没被让」）。实测 ±1600 窗得 0.363、±3200 窗得 0.463（同 gate）→
 * 标定与断言一律用 **±3200**（约 4000 个 region，分母 902 块）。
 */
export const PYRAMID_CHANCE = 0.56;

/**
 * 候选排序（确定性乱序）的 salt。
 *
 * ⚠️ **程序化扫描确认空闲**（不能只 grep 字面量 —— 带 `+ step`/`+ k` 的调用点占用的是区间）：
 * 940..1015 段已占用 941（巨树 SALT_ROT）/ 950（MESA_SALT）/ 951 & 956（巨树 PATCH_SALT）/
 * 1000（landmarks 区间起点）。960 / 961 空闲。
 */
export const PYRAMID_SALT_ORDER = 960;
/** 概率门的 salt（必须与排序用不同值 —— 否则「排序靠前的候选更容易过门」，产生偏斜） */
export const PYRAMID_SALT_GATE = 961;

/**
 * 候选扫描步长。实测 step=12：一个 400×400 region 的沙漠采样点几十~上百个，
 * 贪心命中前几个就够（实测局部锚点 0.21ms/region）。
 */
const SCAN_STEP = 12;

/**
 * 占地全检的采样步长。
 *
 * ⚠️ **必须是 1（逐格全检）**：曾用 2 以省成本（0.207ms → 0.055ms/候选），实测 388 个
 * 沙漠样本里有 **1 个**「逐格 span=5 但 step2 采样 span=4」—— 地形起伏落在**未被采样的奇偶格**上。
 * 后果是判据放过一个高差 5 的位置，而测试/玩家看到的是「塔基一侧埋 5 格」。
 * 0.15ms/候选 × 首个命中前的少数候选 = 可忽略；**正确性优先**。
 */
const FOOTPRINT_STEP = 1;

/**
 * 邻域去重查多少圈 region：`ceil(PYRAMID_MIN_SPACING / REGION_SIZE) + 1 = 2`。
 * 384 / 400 → 1，+1 余量（锚点可在 region 内任意位置，1 圈不一定足够）。
 */
const NEIGHBOR_RINGS = Math.ceil(PYRAMID_MIN_SPACING / REGION_SIZE) + 1;

/**
 * 「占地是否压在地标上」的圆近似：金字塔外接圆半径 = 半宽 × √2 ≈ 33.9。
 * 用圆近似保证对角方向也不漏（矩形近似只比到边中点）。
 */
const PYRAMID_REACH = PYRAMID_HALF * Math.SQRT2;

/**
 * `computeRegionLocalGiantPyramid` 的结果缓存。
 *
 * **为什么必须有**：邻域去重要查 `(2*2+1)² - 1 = 24` 个邻域 region，而单次局部锚点实测
 * 0.21ms → 不去重 0.21ms、去重后约 5ms/region。缓存后跨 region 复用（与 mesa 同手法）。
 *
 * 缓存是**安全的**：局部锚点是 `(regionX, regionZ, seed)` 的纯函数，同一 seed 下结果恒定
 * （红线 2）。键里带 seed，换 seed 不会读到旧值。容量上限 512（≈ 视距内全部 region 的 3×3 邻域）。
 */
const localCache = new Map();
const LOCAL_CACHE_MAX = 512;

/** @returns {{wx:number, wz:number, floorY:number}|null} */
function cachedLocal(regionX, regionZ, seed) {
  const key = `${seed}:${regionX},${regionZ}`;
  if (localCache.has(key)) return localCache.get(key);
  const v = computeRegionLocalGiantPyramid(regionX, regionZ, seed);
  if (localCache.size >= LOCAL_CACHE_MAX) localCache.delete(localCache.keys().next().value);
  localCache.set(key, v);
  return v;
}

/** 清空缓存（单测隔离用；生产代码不需要调用） */
export function clearGiantPyramidCache() {
  localCache.clear();
}

/**
 * 台体是否压在地标上（用外接圆近似）。
 * @param {Array<{cx:number, cz:number, r:number}>} circles
 */
function overlapsLandmark(circles, wx, wz) {
  for (const c of circles) {
    if (Math.abs(c.cx - wx) > c.r + PYRAMID_REACH) continue;
    if (Math.abs(c.cz - wz) > c.r + PYRAMID_REACH) continue;
    return true;
  }
  return false;
}

/**
 * 金字塔与空岛 AABB 的冲突判定（塔顶不得撞岛）。
 * @param {Int32Array} islands stride 5: [originCx, originCz, bottomY, radius, height]
 */
function skyConflicts(islands, wx, wz, floorY) {
  const topY = floorY + PYRAMID_HEIGHT;
  for (let i = 0; i < islands.length; i += 5) {
    const ox = islands[i] * 16 + 8;
    const oz = islands[i + 1] * 16 + 8;
    const bottomY = islands[i + 2];
    const radius = islands[i + 3];
    if (Math.abs(ox - wx) > radius + PYRAMID_HALF) continue;
    if (Math.abs(oz - wz) > radius + PYRAMID_HALF) continue;
    if (bottomY <= topY) return true;
  }
  return false;
}

/**
 * region 内部的局部锚点（不含邻域去重与概率门）—— 只给 `computeGiantPyramidAnchor`
 * 与去重循环自己用。命名带 `Local` 是提醒：这是**候选**，对外一律用
 * `computeGiantPyramidAnchor`。
 *
 * 判据五条，缺一不可（每条都对应一种「静默产出一个看起来正常的错误金字塔」）：
 *   ① 占地 49×49 每采样列都是 DESERT            —— 否则一半坐在草地上
 *   ② 占地 49×49 每采样列 generateHeight > SEA_Y —— 否则一半扎在海底
 *   ③ 占地内地表高差 ≤ PYRAMID_MAX_SURFACE_SPAN  —— 否则一侧深埋/一侧露底
 *   ④ 不与任何城市 bounds 相交                    —— 否则塔基建在城市整形后的地面上
 *   ⑤ 不压地标（金字塔/冰封山/海岛/平地）与空岛    —— 否则半边压在山里 / 塔顶穿岛
 *   ⑥（构造性）锚点内缩 PYRAMID_INSET → 占地不越 region 边界
 *
 * ⚠️ **高台排除必须在候选层，不能只靠 apply 层**（实测踩到的真缺陷）：只在 apply 阶段 2.76 判
 * 「`layout.mesa` 与本锚点占地是否相交」时，实测 seed 12345 ±6 region 里 **27 个 region 两者都有、
 * 其中 5 个（19%）占地重叠** —— apply 会正确地丢弃那 5 个金字塔，但后果与高台踩过的坑同源：
 *   ① 那 5 个 region 的金字塔**静默消失**（不是错位，是完全没有）；
 *   ② `pointContext` 已对锚点占地返回 `kind='none'` → 那片区域植被/巨树被抑制却长不出塔 → 空地。
 * 所以候选选择时就要跳过高台占地（与地标/城市逻辑）。apply 层的判据**仍然保留**作纵深防御。
 *
 * 用 `computeRegionLocalAnchor`（本 region 的**局部**高台，不触发它的 384 间距去重）——
 * 那比「最终高台」更保守（排除得更多），方向安全。
 *
 * @returns {{wx:number, wz:number, floorY:number}|null}
 */
export function computeRegionLocalGiantPyramid(regionX, regionZ, seed) {
  const baseX = regionX * REGION_SIZE;
  const baseZ = regionZ * REGION_SIZE;
  const loX = baseX + PYRAMID_INSET;
  const hiX = baseX + REGION_SIZE - PYRAMID_INSET;
  const loZ = baseZ + PYRAMID_INSET;
  const hiZ = baseZ + REGION_SIZE - PYRAMID_INSET;

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
    const ra = seededRandom(cands[ia], cands[ia + 1], seed + PYRAMID_SALT_ORDER);
    const rb = seededRandom(cands[ib], cands[ib + 1], seed + PYRAMID_SALT_ORDER);
    if (ra !== rb) return ra - rb;
    const dx = cands[ia] - cands[ib];
    if (dx !== 0) return dx;
    return cands[ia + 1] - cands[ib + 1];
  });

  // ③ 一次性取好全部排除项（每个 region 只需算一次）
  const sky = computeSkyCandidates(regionX, regionZ, seed).skyIslands;
  const circles = regionLandmarkCenters(regionX, regionZ, seed);
  const city = getCityBoundsForSeed(seed);
  // 本 region 的局部高台（不触发 384 间距去重 —— 那需要邻域，候选层不该算）
  const mesa = computeRegionLocalAnchor(regionX, regionZ, seed);

  // ④ 就近命中即停
  for (const i of order) {
    const wx = cands[i], wz = cands[i + 1];

    const hw = PYRAMID_HALF;
    // 判据 ①②③ 一趟全检（同时算最低/最高地表）
    let minH = Infinity, maxH = -Infinity, ok = true;
    for (let dz = -hw; dz <= hw && ok; dz += FOOTPRINT_STEP) {
      for (let dx = -hw; dx <= hw; dx += FOOTPRINT_STEP) {
        const nx = wx + dx, nz = wz + dz;
        if (getBiome(nx, nz, seed) !== 'DESERT') { ok = false; break; }
        const h = generateHeight(nx, nz, seed);
        if (h <= SEA_Y) { ok = false; break; }
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
    }
    if (!ok) continue;
    if (maxH - minH > PYRAMID_MAX_SURFACE_SPAN) continue;

    // 判据 ④：城市 bounds（跨 region —— 只有 getCityBoundsForSeed 拿得到，DR-6）
    if (wx + hw >= city.minX && wx - hw <= city.maxX &&
        wz + hw >= city.minZ && wz - hw <= city.maxZ) continue;

    // 判据 ⑤：地标（含条件地标）与空岛
    if (overlapsLandmark(circles, wx, wz)) continue;
    if (skyConflicts(sky, wx, wz, minH)) continue;

    // 判据 ⑥：高台占地（见 computeRegionLocalGiantPyramid 的 JSDoc）
    if (mesa && Math.abs(wx - mesa.wx) <= hw + MESA_UNION_HALF &&
        Math.abs(wz - mesa.wz) <= hw + MESA_UNION_HALF) continue;

    // ⑥ region 内缩由扫描窗构造性保证（扫描点本身就内缩了）
    return { wx, wz, floorY: minH };
  }
  return null;
}

/**
 * 计算单个 region 的巨型金字塔锚点（至多 1 个）。
 *
 * 三步：局部候选 → 邻域单向去重 → 概率门。
 *
 * ⚠️⚠️ **概率门位置是载荷性的**：必须在**去重之后**，而且**去重时必须比较未过门的邻居**。
 * 若门放在去重之前（或去重时只比已过门的邻居），会让「本该让位的邻居因为自己被门掉而不参与
 * 比较」→ 两个锚点可能贴在一起（间距门失效）。实现上 `cachedLocal` 存的是**未过门**的局部
 * 锚点（供去重），门只作用在返回值上。
 *
 * @returns {{wx:number, wz:number, floorY:number}|null}
 */
export function computeGiantPyramidAnchor(regionX, regionZ, seed) {
  const own = cachedLocal(regionX, regionZ, seed);
  if (!own) return null;

  // 邻域去重：一块沙漠只留一个（判据见 PYRAMID_MIN_SPACING）。
  //
  // 为什么是「只跟字典序更小的 region 比」而不是「互相让位」：互相让位会让相邻两个
  // region 各自看到对方、双双放弃 → 那块沙漠一个都没有（与需求相反）。
  // 单向比较（后来的让给先到的）保证至少一个能留下，且**跨 region 结果一致**
  // ——每个 region 自己那一侧算的是同一批纯函数调用，不需要任何共享状态（红线 2）。
  for (let dx = -NEIGHBOR_RINGS; dx <= NEIGHBOR_RINGS; dx++) {
    for (let dz = -NEIGHBOR_RINGS; dz <= NEIGHBOR_RINGS; dz++) {
      if (dx === 0 && dz === 0) continue;
      const nx = regionX + dx, nz = regionZ + dz;
      // 只查字典序更小的 region（单向，防互让全灭）
      if (nx > regionX || (nx === regionX && nz >= regionZ)) continue;
      // 先按 region 矩形的最近可能切比雪夫距离剪枝（两个 400×400 矩形的最小间距）：
      // 若它已 ≥ 阈值，那批点不可能落在阈值内 → 一次 localAnchor 都不算（性能关键）
      const minRectDist = Math.max(Math.abs(dx) - 1, 0, Math.abs(dz) - 1) * REGION_SIZE;
      if (minRectDist >= PYRAMID_MIN_SPACING) continue;
      const other = cachedLocal(nx, nz, seed);
      if (!other) continue;
      const d = Math.max(Math.abs(own.wx - other.wx), Math.abs(own.wz - other.wz));
      if (d < PYRAMID_MIN_SPACING) return null;
    }
  }

  // 概率门：放在去重**之后**（见函数头注释）
  if (seededRandom(own.wx, own.wz, seed + PYRAMID_SALT_GATE) >= PYRAMID_CHANCE) return null;

  return own;
}

/**
 * 点是否落在任一金字塔的占地内（49×49 方形）。
 *
 * 唯一权威（红线 1）：`apply.js` 阶段 2.7 的撒布剔除与将来的消费者都用这一份，
 * 不得各自写一遍 `Math.abs(dx) <= 24`。
 *
 * @param {number} wx @param {number} wz
 * @param {Array<{wx:number, wz:number}|null>} anchors 邻域 layouts 的 `giantPyramid`（null 项自动跳过）
 * @returns {boolean}
 */
export function inGiantPyramidFootprint(wx, wz, anchors) {
  if (!anchors) return false;
  for (const a of anchors) {
    if (!a) continue;
    if (Math.abs(wx - a.wx) <= PYRAMID_HALF && Math.abs(wz - a.wz) <= PYRAMID_HALF) return true;
  }
  return false;
}
