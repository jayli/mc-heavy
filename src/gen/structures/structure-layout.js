// src/gen/structures/structure-layout.js — region 确定性布局（设计文档 §4.2）
// 布局 = 该 region 的地标清单与位置（seed 确定性，任意 Worker 可重算且结果一致）。
// 布局在 Worker 'layout' RPC 里算一次，主线程缓存并随 GEN 任务下发（DR-13）。
// Worker 同构：本文件不得 import three。
import { REGION_SIZE, LANDMARK_OFFSET, CITY_REGION } from './region-config.js';
import { getRegionSeededCenter } from './region-center.js';
import {
  getPyramidCenterInRegion, getFrozenMountainCenterInRegion,
  getPlainLandCenterInRegion, estimatePlainLandBaseHeight,
  getIslandCenterInRegion, isIslandValid, isPlainLandValid,
} from './landmarks.js';
import { buildCityLayout } from './city-layout.js';
import { computeSkyCandidates } from './sky-structures.js';
import { computeScatterCandidates } from './scatter.js';
import { computeGiantTreeCandidates } from './giant-trees.js';
import { computeAzaleaTreeCandidates } from './azalea-trees.js';
import { computeGiantPyramidAnchor } from './giant-pyramid.js';
import { computeArenaAnchor, arenaOverlapsRegion } from './arena.js';
import { computeShallowTarnAnchor, shallowTarnOverlapsRegion, shallowTarnSuppressedLandmarks } from './shallow-water-tarns.js';
import {
  computeBurningArenaAnchor, burningArenaOverlapsRegion, burningArenaSuppressedLandmarks,
  snowLandSuppressedByBurningArena,
} from './burning-arena.js';
import {
  computeRuinedCitadelAnchor, ruinedCitadelOverlapsRegion, ruinedCitadelSuppressedLandmarks,
  snowLandSuppressedByRuinedCitadel,
} from './ruined-citadel.js';
import { isTarnZone, computeTarnZone, inTarnRadius } from './tarn-zone.js';

/**
 * 计算单个 region 的确定性布局（纯函数，无缓存——缓存由调用方 StructureIndex 管）。
 * @returns {{
 *   regionX: number, regionZ: number,
 *   pyramidRaw: {centerX:number, centerZ:number},
 *   pyramid: ({cx:number, cz:number}|null),
 *   frozenMountain: ({cx:number, cz:number}|null),
 *   snowLand: {cx:number, cz:number},
 *   plainLand: ({cx:number, cz:number, baseHeight:number}|null),
 *   island: ({cx:number, cz:number}|null),
 *   city: (Object|null),
 *   sky: {skyIslands: Int32Array, cloudClusters: Int32Array},
 *   scatter: {cityScatter: Int32Array, outsideScatter: Int32Array},
 *   giantTrees: {forest: Int32Array, beach: Int32Array, banyan: Int32Array},
 *   azaleaTrees: Int32Array,
 *   giantPyramid: ({wx:number, wz:number, floorY:number}|null),
 *   arena: ({wx:number, wz:number, floorY:number, maxH:number, span:number}|null),
 *   burningArena: ({wx:number, wz:number, floorY:number, span:number}|null),
 *   ruinedCitadel: ({wx:number, wz:number, floorY:number, span:number}|null),
 *   tarn: (import('./tarn-zone.js').TarnLayout|null)
 * }}
 */
export function computeRegionLayout(regionX, regionZ, seed) {
  // 高台地带（Cloudland Tarn Zone，spec DR-1/DR-2）：region 级判定 + 布局，算一次复用。
  // 地带是「地基级」内容 —— 它整形整个 region 的地表（台地 + 水池 + 巨型云），
  // 与其他地标互斥，故把这些地标整条压成 null（雪原例外，见下方 snowLand 注释）。
  const tarn = isTarnZone(regionX, regionZ, seed) ? computeTarnZone(regionX, regionZ, seed) : null;

  const raw = getRegionSeededCenter(regionX, regionZ, seed);
  const pyramidRaw = { cx: raw.centerX, cz: raw.centerZ };

  // 浅水高台（Shallow Water Tarns，2026-11-01）：城东外一个。
  //
  // ⚠️ **必须早于地标赋值**：它要把落在湖区内的地标压掉。
  // 为什么是压制而不是避让 —— 见 `shallow-water-tarns.js` 的 `fixedBlockers` 注释：
  // 地标圆每 region 2~4 个 + 雪原一个，而 region 仅 400 格、湖半径 262 ⇒ 避让实测 10 seed 全部失效。
  // 这与高台地带 `tarn ? null : …` 是同一裁定（地基级内容压过地标）。
  const shallowTarnAll = computeShallowTarnAnchor(seed);
  const shallowTarn = shallowTarnOverlapsRegion(shallowTarnAll, regionX, regionZ) ? shallowTarnAll : null;
  // 本 region 的**哪些地标**被压：判据是「该地标中心是否落在湖的硬半径内」，
  // **不是**「本 region 是不是圆心所在 region」。
  //
  // ⚠️ 两种写法实测差别很大：湖直径 524（含沙滩）跨 2~3 个 region，而圆心所在的那个 region
  // 里可能一个地标都没有、地标全在邻居 region。按「圆心 region」压制会
  // ① 压掉一个本来没冲突的地标（零回归失败），
  // ② 又不压真正冲突的那些。
  const suppress = shallowTarnAll
    ? shallowTarnSuppressedLandmarks(shallowTarnAll, regionX, regionZ, seed)
    : null;
  // 大竞技场（burning arena，v2.85）：城东最近的沙漠里**恰好一个**（用户裁定「必须且唯一」）。
  //
  // ⚠️ **同样必须早于地标赋值**：它要把落在占地内的地标 / 巨型金字塔 / 空岛压掉。
  // 为什么是压制而不是避让 —— 见 `burning-arena.js` 文件头：实测把地标/金字塔/空岛当避让项时
  // seed 12345 在 span≤8 下**一个落点都找不到**（与浅水高台 `fixedBlockers` 记录的是同一个坑），
  // 而用户要求「必须生成」⇒ 只能压制。改用压制后 8/8 seed 命中 span=5，搜索 2ms。
  const burningArenaAll = computeBurningArenaAnchor(seed);
  const burningArena = burningArenaOverlapsRegion(burningArenaAll, regionX, regionZ) ? burningArenaAll : null;
  const baSuppress = burningArenaAll
    ? burningArenaSuppressedLandmarks(burningArenaAll, regionX, regionZ, seed)
    : null;
  // 废弃堡垒（Ruined Citadel，v2.89）：**城西**最近的干燥沙漠里恰好一个（与大竞技场分居 City 两侧）。
  //
  // ⚠️ 同样必须早于地标赋值：它要把落在占地内的地标 / 巨型金字塔 / 空岛压掉。
  // 为什么是压制而不是避让 —— 见 `ruined-citadel.js` 文件头（与大竞技场同一裁定：
  // 实测把地标当避让项会让部分 seed 一个落点都找不到，而用户要求「必须生成」）。
  // 改用压制后 8/8 seed 命中 span=5，搜索 63~141ms（已预热在 world-worker.js 的 layout 入口）。
  const ruinedCitadelAll = computeRuinedCitadelAnchor(seed);
  const ruinedCitadel = ruinedCitadelOverlapsRegion(ruinedCitadelAll, regionX, regionZ) ? ruinedCitadelAll : null;
  const rcSuppress = ruinedCitadelAll
    ? ruinedCitadelSuppressedLandmarks(ruinedCitadelAll, regionX, regionZ, seed)
    : null;

  // ⚠️ 三个地基级结构（浅水高台 / 大竞技场 / 废弃堡垒）的压制项**取并集**：它们彼此已在
  // 锚点层互斥（`fixedBlockerAt` 里互相避让），故同一 region 至多被其中一个压，但判据仍要
  // 写成并集 —— 否则将来放宽互斥时会静默漏压。
  const suppressPyramid = !!suppress?.pyramid || !!baSuppress?.pyramid || !!rcSuppress?.pyramid;
  const suppressFrozenMountain = !!suppress?.frozenMountain || !!baSuppress?.frozenMountain
    || !!rcSuppress?.frozenMountain;
  const suppressPlainLand = !!suppress?.plainLand || !!baSuppress?.plainLand || !!rcSuppress?.plainLand;
  const suppressIsland = !!suppress?.island || !!baSuppress?.island || !!rcSuppress?.island;
  const suppressGiantPyramid = !!baSuppress?.giantPyramid || !!rcSuppress?.giantPyramid;
  // ⚠️ **空岛压制是大竞技场特有的**（浅水高台没有这一项）：它高 80 格（塔顶实测 y=79~84），
  // 而空岛底 y≥40 ⇒ 水平重叠即相撞。且空岛在 apply 阶段 2.5 光栅化，**晚于**大竞技场的 2.93
  // ⇒ 不压制的话空岛会反过来打穿竞技场上半部（后写胜）。实测 8 seed 中 7 个需要压制。
  // 用户 2026-11-09 裁定：「大竞技场上面的空岛可以先不显示，空岛给大竞技场让路」。
  //
  // ⚠️ 废弃堡垒也带这一项，但它的塔顶只有 floorY+18（世界 y=17~22）而空岛底 y≥40
  // ⇒ `bottomY <= topY` 恒假，**当前从不触发**（spec DR-6：保留判据是为了将来加高塔楼时
  // 不会静默失效）。并集写法使它一旦触发就生效，无需回来改这里。
  const suppressSkyIslands = !!baSuppress?.skyIslands || !!rcSuppress?.skyIslands;

  // ⚠️ `suppress.snowLand` 算出来了但**不在本文件用**：雪原的压制粒度是「这座雪原是否压进湖里」，
  // 走 `apply.js` 阶段 1 的跳过门（与 `snowLandSuppressedByTarn` 同手法），
  // 而**不是**把 `snowLand` 字段置 null —— 6 处消费方直接解引用 `.cx`，置 null 会抛 TypeError。
  // 它仍被 `shallowTarnSuppressedLandmarks` 返回，供单测与将来接入使用。

  // ⚠️ 压制一律写成 `cond ? null : <原表达式>`，**保留原表达式的求值位置与顺序** ——
  // 原值仍会被算出来（多花几次纯函数调用），换来的是零回归：非地带 region 的每个字段
  // 与 v1.x 逐位相同，不需要重新标定任何既有断言。
  const pyramid = (tarn || suppressPyramid) ? null : getPyramidCenterInRegion(regionX, regionZ, seed);
  const frozenMountain = (tarn || suppressFrozenMountain) ? null : getFrozenMountainCenterInRegion(regionX, regionZ, seed);

  // snowLand 与 mc-lite 一致：未 clamp 的原始中心 + 偏移（可跨 region，由邻区查询吸收）。
  //
  // ⚠️ **地带 region 的 snowLand 字段仍然保留（不置 null）** —— 它与其它地标不同：
  // 雪原可以跨 region 溢出，压制粒度是「这座雪原是否压进某个地带圆」而不是「本 region
  // 是不是地带」。那个判定在 `snowLandSuppressedByTarn()`（tarn-zone.js），由 apply.js
  // 阶段 1 的跳过门消费。若在此处置 null，会连带打断 6 处消费方（test-structure-layout /
  // test-landmarks / test-giant-trees-gen / structure-gen.html 等直接解引用 `.snowLand.cx`）。
  //
  // ## 大竞技场 / 废弃堡垒占地的雪压（v2.94）
  // **这里不一样：置 null**。理由是消费者语义变了：一座被占地压掉的雪原应在**地图**
  // （`minimap-regions.js`）与 **Boss 定位**（`boss-map.js`）上一起消失，否则会出现
  // 「地图上有片雪白块、飞过去却是沙漠」—— 与 `snowLandSuppressedByTarn` 的既有处置
  // （那两个消费者各自调它过滤）一致，只是那两条各自写了一份过滤，这里直接给「不存在」。
  //
  // ⚠️ **与地带那条不矛盾**：地带压制是「被邻域地带圆波及」的**跨 region** 判定，
  // 与 region 身份无关；而这里是「**本 region 的雪原中心**是否与某个占地相交」——
  // 雪原盒归属恰好由 `getRegionSeededCenter(regionX, regionZ)` 唯一确定，故可以就地判。
  // 两个判据不互推，各自独立生效（两个都真时任一个都会让它不生成，幂等）。
  const snowSuppressedHere = snowLandSuppressedByBurningArena(regionX, regionZ, seed) ||
                             snowLandSuppressedByRuinedCitadel(regionX, regionZ, seed);
  const snowLand = snowSuppressedHere ? null : {
    cx: raw.centerX + LANDMARK_OFFSET.SNOW_LAND_X,
    cz: raw.centerZ + LANDMARK_OFFSET.SNOW_LAND_Z,
  };

  const plainLandCenter = getPlainLandCenterInRegion(regionX, regionZ, seed);
  const plainLandRaw = isPlainLandValid(plainLandCenter.cx, plainLandCenter.cz, seed)
    ? { ...plainLandCenter, baseHeight: estimatePlainLandBaseHeight(plainLandCenter.cx, plainLandCenter.cz, seed) }
    : null;
  const plainLand = (tarn || suppressPlainLand) ? null : plainLandRaw;

  const { islandCx, islandCz } = getIslandCenterInRegion(regionX, regionZ, seed);
  const islandRaw = isIslandValid(islandCx, islandCz, seed) ? { cx: islandCx, cz: islandCz } : null;
  const island = (tarn || suppressIsland) ? null : islandRaw;

  // City 全世界唯一，固定在 region [0,0]（mc-lite CITY_REGION 语义）。
  // `isTarnZone` 对 CITY_REGION 恒 false（tarn-zone.js），故这里 `tarn` 恒 null、城市永不被压制 ——
  // 那条守卫留在这里只是让「压制」这一侧的判据不必知道城市的特例（单一权威仍在 isTarnZone）。
  const city = (regionX === CITY_REGION.X && regionZ === CITY_REGION.Z) ? buildCityLayout(seed) : null;

  // 空中候选（M2-7）：紧凑 Int32Array，GEN 侧按 AABB 裁剪到 column。
  // ⚠️ **必须无条件调用一次**（`skyFull`），不能写成 `tarn ? 空 : computeSkyCandidates(...)` ——
  // 后者在地带 region 会跳过计算，而 `cloudClusters` 在地带里**仍要保留**（巨型云要避开
  // 原有云簇，且既有云簇的形状/位置在非地带里也是同一份确定性候选）。只调一次也让「清空
  // skyIslands」不必付第二遍计算成本。
  const skyFull = computeSkyCandidates(regionX, regionZ, seed);
  // 地带里清空空岛（池面上不能插浮岛），云簇保留。
  // 大竞技场占地上空同样清空空岛（`suppressSkyIslands`，理由见上方注释）。
  // ⚠️ **`cloudClusters` 两种情况都必须保留**：云簇是既有小云，与空岛是两套内容；
  //    一并清掉会让地带/竞技场上空的云消失（地带那条的既有口径就是只清空岛）。
  const sky = (tarn || suppressSkyIslands)
    ? { skyIslands: new Int32Array(0), cloudClusters: skyFull.cloudClusters }
    : skyFull;

  // 撒布候选（M2 欠账补齐）：同为紧凑 Int32Array，GEN 侧按 AABB 裁剪到 column。
  // 城市候选只在持有 city 布局的 region 算（见 computeScatterCandidates 的口径差异①）。
  const scatterRaw = computeScatterCandidates(regionX, regionZ, seed, city);
  // 地带里不留撒布结构（house / ship / flower_bed …）：台地与水池要干净。
  const scatter = tarn
    ? { cityScatter: new Int32Array(0), outsideScatter: new Int32Array(0) }
    : scatterRaw;

  // 巨树候选（Giant Trees Epic）：全局对齐网格抖动，与 region 邻居无关（不需要 city）；
  // 城市/地标/撒布的排除在 GEN 侧（apply.js 阶段 2.8）用邻域 layouts 判定。
  const giantTreesRaw = computeGiantTreeCandidates(regionX, regionZ, seed);
  // 地带里没有旧植被（台地/水池要干净），故三条路径全空。
  const giantTrees = tarn
    ? { forest: new Int32Array(0), beach: new Int32Array(0), banyan: new Int32Array(0) }
    : giantTreesRaw;

  // 杜鹃树（Azalea Trees Epic）：单条路径，全局对齐网格抖动，与 region 邻居无关。
  //
  // ⚠️ **地带里只剔除「圆内」的候选，不是整块 region 清空**（v2.3 修掉的缺陷）：
  // `tarn ? 空 : compute…` 会把圆外的合法树一并抹掉 —— 地带圆半径 138 只覆盖 400×400 的
  // **37.4%**，圆外 62.6% 仍是普通地形（`pointContext` 只对圆内返回 `kind:'tarn'`）。
  // 实测（seed 12345）`region(2,0)` 的 28 个候选**全部在圆外**，整块清空后那一带留下
  // **104×91 格**的连续纯草地（用户 2026-10-28：「杜鹃花地带中有大片空地没有渲染出树」）。
  // 三个 seed 实测：圆外被误清 70~185 棵/seed（对应 12k~33k 格² 可种树面积）。
  // 判据 `inTarnRadius` 与 `pointContext` 的 `kind:'tarn'` 分支**同源**（红线 1）。
  //
  // ⚠️ 撒布 / 巨树 / 空岛的整块清空是**刻意保留**的：spec DR-6 明写「地带 region 内不出现
  // 撒布结构 / 巨树 / 空岛」，且 `test-tarn-zone.js` 钉住了那几项（不要顺手"修"它们）。
  const azaleaTrees = computeAzaleaTreeCandidates(regionX, regionZ, seed, undefined, tarn);

  // ⚠️ v1.80：沙漠孤立高台系统已整体删除（DR-11，由「高台地带」取代），`mesa` 字段不再存在。

  // 巨型金字塔（Giant Pyramid Epic）：region 级候选，与高台同构。
  // 城市/地标/空岛/高台的排除都已在候选层（`giant-pyramid.js` 拿得到 `getCityBoundsForSeed`
  // 与 `computeRegionLocalAnchor`）；撒布结构的剔除在 GEN 侧阶段 2.7（那里拿得到布局）。
  const giantPyramid = (tarn || suppressGiantPyramid) ? null : computeGiantPyramidAnchor(regionX, regionZ, seed);

  // 城门竞技场（Arena，2026-10-29）：城南门外**一个**（每个 seed 一个）。
  //
  // ⚠️ **裁剪到「与本 region 相交」才携带**：锚点可能落在任何 region，而每个 column 的
  // 查询域只拿 3×3 region 布局 —— 不相交的 region 携带它只会白抬 payload（与巨型金字塔
  // 不同：那个的内缩量保证锚点必在本 region，竞技场没有内缩）。
  //
  // ⚠️ **不能写成 `tarn ? null : …`**（与其它地标不同）：竞技场占地 41×79 可跨 region，
  // 而 `arenaOverlapsRegion` 只让相交的 region 携带它。若地带 region 把 `arena` 整条压成
  // null，**该 region 负责的那部分竞技场就会缺半边** —— 实测 20 个 seed 里有 **2 个**
  // （seed 1 / 5150）的占地 AABB 确实跨进了地带 region。
  // 这也与「地带是地基级内容」不矛盾：锚点候选层已经把**整圆**当作阻挡物
  // （`fixedBlockers` 里的 `TARN_ZONE_RADIUS`），所以合法锚点永远不会落在池/台地上；
  // 这里能相交的只是占地 AABB 的边缘探进了地带 region 的矩形范围（圆外那部分仍是普通地形）。
  const arenaAll = computeArenaAnchor(seed);
  const arena = arenaOverlapsRegion(arenaAll, regionX, regionZ) ? arenaAll : null;

  return {
    regionX, regionZ, pyramidRaw, pyramid, frozenMountain, snowLand, plainLand,
    island, city, sky, scatter, giantTrees, azaleaTrees, giantPyramid, arena, tarn, shallowTarn,
    burningArena, ruinedCitadel,
  };
}

/**
 * column 覆盖的基 region 列表（column 可能横跨 region 边界 → 1/2/4 个）。
 * @returns {Array<{regionX: number, regionZ: number}>}
 */
export function regionsForColumn(cx, cz) {
  const minX = cx * 16, maxX = cx * 16 + 15;
  const minZ = cz * 16, maxZ = cz * 16 + 15;
  const out = [];
  for (const rx of [Math.floor(minX / REGION_SIZE), Math.floor(maxX / REGION_SIZE)]) {
    for (const rz of [Math.floor(minZ / REGION_SIZE), Math.floor(maxZ / REGION_SIZE)]) {
      if (!out.some((r) => r.regionX === rx && r.regionZ === rz)) out.push({ regionX: rx, regionZ: rz });
    }
  }
  return out;
}

/**
 * column 的查询域：全部基 region 的 3×3 邻域并集（跨 region 溢出解法，§4.2）。
 * @returns {string[]} regionKey 数组（"rx,rz"）
 */
export function neighborRegionKeys(cx, cz) {
  const keys = new Set();
  for (const { regionX, regionZ } of regionsForColumn(cx, cz)) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        keys.add(`${regionX + dx},${regionZ + dz}`);
      }
    }
  }
  return [...keys];
}
