// src/gen/structures/apply.js — 结构注入：fillColumn 之后、光照之前叠加结构方块（设计文档 §4.2）
// 地形整形（地标 elif 链，mc-lite 列循环优先级 city > pyramid > island > plainLand > snowLand > fm）
// + JSON 结构光栅化（城市建筑 / 海岛塔 / 平地金字塔岛，按 AABB 裁剪到本 column）。
// 树木/植被 M2-3 追加。Worker 同构：本文件不得 import three。
import { generateHeight, generateHeightForBiome } from '../terrain.js';
import { getBiome, seededRandom } from '../noise.js';
import {
  getPyramidInfo, generatePyramid, makeColumnSetter,
  getSnowLandInfo, generateSnowLand, snowLandSurfaceY,
  getFrozenMountainInfo, generateFrozenMountain, frozenMountainSurfaceY,
  getIslandInfo, generateIsland, generateIslandSandRing, islandSurfaceY,
  getPlainLandInfo, generatePlainLand,
  getCityInfo, generateCity, getCityFinalSurfaceY,
} from './landmarks.js';
import { getCitySurfaceY, isPointNearCityStructure } from './city-layout.js';
import { CITY_STRUCTURE_FOOTPRINT, ISLAND_SEA_LEVEL, SCATTER_FOOTPRINT } from './region-config.js';
import { preloadStructures, rasterizeStructure, GROUND_SUPPORT_TYPES } from './structure-json.js';
import { applySkyStructures } from './sky-structures.js';
import { generateTree, rollVegetation, rollCityTree } from './vegetation.js';
import {
  SCATTER_TYPES, SCATTER_STRIDE, CODE_GENERATED_SCATTER_TYPES,
  generateCodeHouse, generateCodeShip, inCityBounds,
} from './scatter.js';
import { SEA_Y, blockIndex } from '../../voxel/constants.js';
import { applyGiantTrees, loadGiantTrees } from './giant-trees.js';
import { PYRAMID_HALF, inGiantPyramidFootprint } from './giant-pyramid.js';
import { TARN_ZONE_RADIUS, snowLandSuppressedByTarn, TARN_CLOUD_MIN_Y } from './tarn-zone.js';
import { fillTarnPlateau, tarnSnowCap } from './tarn-terrain.js';
import { KIT_VARIANTS, KIT_METRICS } from './cloudland-kit-data.js';

/** 城市 placement 用到的 JSON 结构（GEN 携带城市布局时预载）+ 植被树 JSON */
const CITY_STRUCTURE_TYPES = [
  'castle', 'bigHouse', 'regularHouse1', 'desertTempleTube', 'boxHouse', 'desertVillage',
  'doubleTower', 'treeTower', 'junglePyramid', 'pyramidIsland', 'smallHouse', 'treeHouse',
  'uglyHouse', 'whiteTower', 'woodHouse', 'gate', 'tank', 'tower',
  'birchTree', 'birchTreeWithSnow',
];

/**
 * 代码生成撒布类型的光栅化入口（无 JSON，几何由函数直接写方块）。
 *
 * 统一签名 `(x, y, z, setBlock, seed)` —— `generateCodeShip` 不吃 `seed`（mc-lite 的 ship
 * 几何不含 `Math.random`，天然确定性），多余实参被忽略，故两者可共用同一调用点。
 */
const CODE_GENERATORS = Object.freeze({
  house: generateCodeHouse,
  ship: generateCodeShip,
});

/**
 * 植被扫描外扩（树冠半径 ≤ 3）。阶段 3 的扫描窗口与阶段 2.8 巨树的「旧植被覆盖窗口」共用这一个值
 * （单一权威：两处各写一份会漂移出「旧树冠游离在巨树边缘」的缺陷）。
 */
const VEGETATION_EXT = 3;

/** AABB 相交判定余量（JSON 实测占地与 footprint 表最大偏差 1 格） */
const INTERSECT_MARGIN = 2;

/** placement AABB 是否与 column 相交 */
function placementIntersects(p, halfX, halfZ, cx, cz) {
  const minX = cx * 16, maxX = cx * 16 + 15, minZ = cz * 16, maxZ = cz * 16 + 15;
  return p.x + halfX + INTERSECT_MARGIN >= minX && p.x - halfX - INTERSECT_MARGIN <= maxX &&
         p.z + halfZ + INTERSECT_MARGIN >= minZ && p.z - halfZ - INTERSECT_MARGIN <= maxZ;
}

/**
 * 植被上下文（mc-lite 列循环各分支的植被挂载点）：
 * kind = city / tarn / island / snow / fm / normal / water / none（金字塔/平地不挂植被）。
 */
function pointContext(wx, wz, layouts, cityLayout, seed) {
  const cityInfo = cityLayout && getCityInfo(wx, wz, cityLayout);
  if (cityInfo) {
    // 残丘已清除（generateCity 清 surfaceY+1..naturalH），树直接植根城市地表。
    return { kind: 'city', surfaceY: getCityFinalSurfaceY(wx, wz, cityInfo, seed) };
  }
  // 高台地带占地：整片让路（`kind: 'tarn'`，与巨型金字塔的 `kind: 'none'` 同手法 ——
  // 一个分支同时覆盖五个下游消费者：阶段 2.75 高台让路 / 阶段 2.8 巨树 allowedAt /
  // 阶段 3 的城市树·普通树·单格植物）。
  //
  // ⚠️ **必须在 snowLand 判定之前**：地带是地基级内容，压在地带圆内的雪原本来就不该生成
  // （apply 阶段 1 另有 `snowLandSuppressedByTarn` 跳过门，这里是把它的**植被**一并压掉）。
  // 放在 city 之后：城市优先级最高（且 CITY_REGION 恒非地带，两者互斥）。
  for (const layout of layouts) {
    const tarn = layout.tarn;
    if (!tarn) continue;
    if (Math.hypot(wx - tarn.cx, wz - tarn.cz) < TARN_ZONE_RADIUS) return { kind: 'tarn' };
  }
  // 巨型金字塔占地：让路给塔。
  //
  // `kind: 'none'` 一个分支就同时覆盖五个下游消费者（**不要为每一处各写一份判据**）：
  //   ① 阶段 2.75 高台的让路（它判 `kind !== 'normal'`）
  //   ② 阶段 2.8 巨树的 `allowedAt`（只允许 normal/water）
  //   ③ 阶段 3 的城市树 / 普通树 / 巨树覆盖窗口
  //   ④ 阶段 3 的单格植物与睡莲（`inColumn` 分支都按 kind 分流）
  //   ⑤ 将来的新植被路径
  // 放在 city 之后（保持「城市优先级最高」的既有语义）；金字塔占地不可能在城市内
  // （候选层已用 getCityBoundsForSeed 排除），两个分支互斥。
  for (const layout of layouts) {
    const gp = layout.giantPyramid;
    if (!gp) continue;
    if (Math.abs(wx - gp.wx) <= PYRAMID_HALF && Math.abs(wz - gp.wz) <= PYRAMID_HALF) {
      return { kind: 'none' };
    }
  }
  for (const layout of layouts) {
    if (getPyramidInfo(wx, wz, layout.pyramid)) return { kind: 'none' };
    if (layout.island) {
      const ii = getIslandInfo(wx, wz, layout.island, seed);
      if (ii) {
        const sy = islandSurfaceY(wx, wz, ii, seed);
        if (sy === null) return { kind: 'none' };
        return { kind: 'island', core: ii.zone === 'core', surfaceY: sy, island: layout.island };
      }
    }
    if (layout.plainLand && getPlainLandInfo(wx, wz, layout.plainLand)) return { kind: 'none' };
    const slInfo = getSnowLandInfo(wx, wz, layout.snowLand, seed);
    if (slInfo) {
      const sy = snowLandSurfaceY(generateHeight(wx, wz, seed), slInfo);
      return { kind: 'snow', core: slInfo.zone === 'core', belowSea: sy <= SEA_Y - 1, surfaceY: sy };
    }
    const fmInfo = getFrozenMountainInfo(wx, wz, layout.frozenMountain, seed);
    if (fmInfo) {
      const sy = frozenMountainSurfaceY(generateHeight(wx, wz, seed), fmInfo);
      return { kind: 'fm', core: fmInfo.zone === 'core', belowSea: sy <= SEA_Y - 1, surfaceY: sy };
    }
  }
  const biome = getBiome(wx, wz, seed);
  const h = generateHeight(wx, wz, seed);
  if (h < SEA_Y) return { kind: 'water', biome, h };
  return { kind: 'normal', biome, h };
}

/**
 * 巨树的「允许落位」判定（阶段 2.8 用；导出供单测复用同一份判据 —— 红线 1）：
 * 只允许 pointContext 为 normal / water 的点（water = 树冠悬在水面上）。其余 = 城市 / 金字塔 / 平地岛 /
 * 海岛 / 雪原 / 冰封山（kind 为 city/none/island/snow/fm），树让路。
 * @returns {(wx:number, wz:number) => boolean}
 */
export function giantAllowedAtFor(layouts, cityLayout, seed) {
  // ⚠️ v1.80：沙漠孤立高台已删除，不再有「巨树给高台让路」这一段。
  // 高台地带的占地让路走 `pointContext` 的 `kind:'tarn'`（一个分支覆盖全部下游消费者）。
  return (wx, wz) => {
    const kind = pointContext(wx, wz, layouts, cityLayout, seed).kind;
    return kind === 'normal' || kind === 'water';
  };
}

/**
 * 将布局覆盖本 column 的结构方块裁剪写入 column（生成路径：不记 edits、不 bump version）。
 * 异步：城市布局需预载建筑 JSON（Worker 内 fetch + 模块缓存）。
 * @param {import('../../voxel/chunk-column.js').ChunkColumn} column
 * @param {number} seed
 * @param {*} registry
 * @param {Array<Object>} layouts 查询域内全部 region 布局（StructureIndex.layoutsForColumn）
 */
export async function applyStructuresToColumn(column, seed, registry, layouts) {
  if (!layouts || layouts.length === 0) return;
  const setBlock = makeColumnSetter(column, registry);

  // 雪原让路（spec DR-6）：某个 region 的雪原若压进任一邻域「高台地带」的圆 → 该雪原整座不生成。
  //
  // 判定是**纯 region 级**的，与 column / 点无关 → 在 column 的 16×16 循环之前按 layout 算一次
  // （逐点调用等于同一换算做 256 × layouts 遍）。
  // ⚠️ 入参是 **region 坐标**（`layout.regionX/regionZ`），不是 `column.cx/cz` —— 后者是
  // column 坐标（16 格一格），两者差 25 倍。
  const snowSuppressed = layouts.map((l) => snowLandSuppressedByTarn(l.regionX, l.regionZ, seed));

  const cityLayout = layouts.find((l) => l.city)?.city || null;
  // 预载清单按布局内容确定：城市建筑 / 海岛中心塔 / 平地金字塔岛 / 植被树
  // （跨 column 光栅化要求凡查询域内出现对应地标即载入，否则 rasterize 静默跳过）
  const needTypes = new Set(['birchTree', 'birchTreeWithSnow']);
  if (cityLayout) for (const t of CITY_STRUCTURE_TYPES) needTypes.add(t);
  for (const layout of layouts) {
    if (layout.island) needTypes.add('tower');
    if (layout.plainLand) needTypes.add('pyramidIsland');
  }

  // 撒布候选（阶段 2.7 光栅化用）：先收集，**据实际出现的类型惰性预载**。
  //
  // ⚠️ 不能无条件预载全部 7 个撒布 JSON —— 实测冷 fetch 并行 **3.1ms**（flowerBed 2.9 /
  // uglyHouse 2.8 / tank 2.8 …），每个新 GEN Worker 的**首个任务**都要付这个代价 →
  // `genP95` 从 6.5~7.1ms 涨到 8.5~9.2ms（+30%），撞破 §4.2 的 8ms 冻结预算。
  // 按实际候选预载后，大多数 column 只需 0~2 个类型（撒布命中稀疏），成本回到噪声级。
  const scatterCandidates = [];
  /** 城市撒布数组（与 outsideScatter 区分：城市自撒的不做城市 bounds 剔除） */
  const cityScatterArrs = new Set();
  for (const layout of layouts) {
    if (!layout.scatter) continue;
    for (const arr of [layout.scatter.cityScatter, layout.scatter.outsideScatter]) {
      if (!arr || arr.length === 0) continue;
      scatterCandidates.push(arr);
      if (arr === layout.scatter.cityScatter) cityScatterArrs.add(arr);
      // 扫一遍 typeIndex 收集本 column 查询域实际出现的类型（廉价：只读 Int32Array）。
      // 代码生成类型（house/ship）无 JSON，跳过 —— 从 CODE_GENERATED_SCATTER_TYPES 派生，
      // 勿写成 `t !== 'house'` 字面量（漏 ship → 白 fetch 一个不存在的 JSON）。
      for (let i = 3; i < arr.length; i += SCATTER_STRIDE) {
        const t = SCATTER_TYPES[arr[i]];
        if (!CODE_GENERATED_SCATTER_TYPES.includes(t)) needTypes.add(t);
      }
    }
  }
  // 高台：只在锚点存在时需要。命中才预载（同撒布结构的惰性预载理由：
  // 无条件预载会让每个新 Worker 的首个 GEN 多付一次冷 fetch）。
  // 巨型金字塔：同理只在锚点存在时预载
  if (layouts.some((l) => l.giantPyramid)) needTypes.add('giantPyramid');
  // 高台地带：35 个产物。惰性预载 —— 只有地带 region 才拉（1/3 的 region）。
  // 从 KIT_VARIANTS 派生而不是手写清单（红线 1）。
  // ⚠️ 用 `some` 而不是 `find(Boolean)` —— 只要邻域里**有任何一个**地带就需要这 35 个文件。
  if (layouts.some((l) => l.tarn)) {
    for (const base of [
      ...KIT_VARIANTS.tarn, ...KIT_VARIANTS.arch,
      ...KIT_VARIANTS.spire, ...KIT_VARIANTS.giantCloud,
    ]) needTypes.add(base);
  }
  await preloadStructures([...needTypes]);
  // 巨树变体加载。Worker 里已在模块加载期预热（world-worker.js 的 giantPreloadPromise，layout 入口 await），
  // 这里命中缓存 ≈ 0ms；⚠️ 不预热的话每个 Worker 的首个 GEN 要付 fetch+解析（实测使 structure-gen 的
  // genP95 从 ~9ms 涨到 ~12ms，撞破 10ms 门）。fetch 失败不阻断 GEN（空 families → 本列无巨树）。
  await loadGiantTrees();

  // ---- 阶段 1：地形整形（mc-lite 列循环 elif 链）----
  for (let lx = 0; lx < 16; lx++) {
    for (let lz = 0; lz < 16; lz++) {
      const wx = column.cx * 16 + lx;
      const wz = column.cz * 16 + lz;

      // CITY biome 压平：城内点走 CITY 分支（mc-lite 语义的逐点近似）
      const cityInfo = cityLayout ? getCityInfo(wx, wz, cityLayout) : null;
      const h = cityInfo
        ? generateHeightForBiome(wx, wz, seed, 'CITY')
        : generateHeight(wx, wz, seed);

      if (cityInfo) {
        generateCity(wx, wz, h, cityInfo, setBlock, seed);
        continue;
      }

      let handled = false;
      for (let li = 0; li < layouts.length; li++) {
        if (handled) break;
        const layout = layouts[li];
        const pyInfo = getPyramidInfo(wx, wz, layout.pyramid);
        if (pyInfo) { generatePyramid(wx, wz, h, pyInfo, setBlock, seed); handled = true; break; }

        if (layout.island) {
          const islandInfo = getIslandInfo(wx, wz, layout.island, seed);
          if (islandInfo) {
            const islandResult = generateIsland(wx, wz, islandInfo, setBlock, seed);
            // 过渡圈沙洲与岛内形状噪声挖除处的补沙（mc-lite 列循环 island 分支）
            const dist = islandInfo.distFromCenter;
            if ((dist > 19 && dist < 39) || (!islandResult && dist <= 19)) {
              generateIslandSandRing(wx, wz, islandInfo, setBlock);
            }
            handled = true;
            break;
          }
        }

        if (layout.plainLand) {
          const plainInfo = getPlainLandInfo(wx, wz, layout.plainLand);
          if (plainInfo) { generatePlainLand(wx, wz, h, plainInfo, setBlock); handled = true; break; }
        }

        // 雪原：被邻域地带压进圆内时整座跳过（`snowSuppressed[li]`），否则照旧。
        // 跳过的形态必须是「当作这里没有雪原」而不是「continue 整列」—— 后面的冰封山仍要判。
        if (!snowSuppressed[li]) {
          const slInfo = getSnowLandInfo(wx, wz, layout.snowLand, seed);
          if (slInfo) { generateSnowLand(wx, wz, h, slInfo, setBlock, seed); handled = true; break; }
        }

        const fmInfo = getFrozenMountainInfo(wx, wz, layout.frozenMountain, seed);
        if (fmInfo) { generateFrozenMountain(wx, wz, h, fmInfo, setBlock, seed); handled = true; break; }
      }
    }
  }

  // ---- 阶段 2.4：高台地带（Cloudland Tarn Zone）----
  //
  // 层序理由：台地整形必须在阶段 1 的 `fillColumn` 之后（它覆盖原始地层），
  // 而高台与装饰件在台地之后写（后写胜）。城市结构不该写进地带（地带已在 layout 层
  // 压制了 `city`，所以下面的阶段 2 对地带 region 是空转）。
  //
  // ⚠️ **y 参数是 `plateauY`，不是 `plateauY + 1`**（易错一格）：
  //   · 池底实心在 `plateauY - 1`、水在 `plateauY`；
  //   · `rasterizeStructure(type, x, y, z, …)` 把**最低那层写成 y**（内部是 `y + b.y - 1`，
  //     而产物已把最低点归一化为 b.y = 1）；
  //   · 故 `y = plateauY` ⇒ 台基最低层正好落在水那一层、坐在池底上（台体占掉它自己的水格）。
  //   传 `plateauY + 1` 会让整座高台**悬在水面上方一格**（区块层面看不出，只是台子浮在水上）。
  // ⚠️ **必须遍历全部 tarn layout，不能只取第一个**：3×3 邻域里可能同时有**两个**地带
  // （地带半径 160、region 边长 400，相邻两个 region 各自中奖是常见的 —— 实测
  // seed 12345 的 column(-188,-113) 邻域里同时有 (-9,-6) 与 (-8,-5) 两个）。
  // 写成 `layouts.map(l => l.tarn).find(Boolean)` 会只取字典序第一个，
  // 而它可能完全不覆盖本 column ⇒ **台地整形静默不生效**（池心 y=2 是空气不是水，
  // 方块层面看不出是取错了 layout），且纯函数单测全绿。
  const tarnLayouts = layouts.map((l) => l.tarn).filter(Boolean);
  for (const tarnLayout of tarnLayouts) {
    fillTarnPlateau(column, tarnLayout, seed, registry);

    // 8 座高台（`TARN_KEPT_TARN_IDS`；烘焙有 11 个产物，运行时只用 8 座）
    for (const t of tarnLayout.tarns) {
      const wx = Math.round(tarnLayout.cx + t.ring * Math.cos(t.ang));
      const wz = Math.round(tarnLayout.cz + t.ring * Math.sin(t.ang));
      // ⚠️ 轴对齐摆放下 AABB 半宽就是 `halfX` / `halfZ` 本身（spec DR-7 方案 1，不旋转）。
      //    不要写成 `halfX + halfZ`（那是旋转假设下的保守投影，轴对齐下会把裁剪框撑大一倍）。
      if (!placementIntersects({ x: wx, z: wz }, t.halfX, t.halfZ, column.cx, column.cz)) continue;
      // `rasterizeStructure` 签名不动（无 orientation 参数）—— 方案 1 不新增旋转机制。
      rasterizeStructure(t.variant, wx, tarnLayout.plateauY, wz, setBlock, column, registry, seed, false);
    }

    // 12 个装饰件：⚠️ **拱洞与紫晶柱的 y 口径不同**（DR-8 把拱洞移到了池外台地）：
    //   · 紫晶柱在**池内** → 最低层落在 `plateauY`（= 水那一层），坐在池底 `plateauY - 1` 上；
    //   · 拱洞在**池外台地** → 台地地表方块就在 `plateauY`，故最低层要落在 `plateauY + 1`
    //     （坐在地表之上）。传 `plateauY` 会把拱洞最底下一层**埋进台地地表**。
    for (const d of tarnLayout.decos) {
      const wx = Math.round(tarnLayout.cx + d.ring * Math.cos(d.ang));
      const wz = Math.round(tarnLayout.cz + d.ring * Math.sin(d.ang));
      if (!placementIntersects({ x: wx, z: wz }, d.halfX, d.halfZ, column.cx, column.cz)) continue;
      const dy = d.kind === 'arch' ? tarnLayout.plateauY + 1 : tarnLayout.plateauY;
      rasterizeStructure(d.variant, wx, dy, wz, setBlock, column, registry, seed, false);
    }

    // 3. 高台顶层换雪（v1.91，用户 2026-10-28 裁定：「一圈高台的位置用雪方块铺设……
    //    高台顶层也换雪」）。
    //
    // ⚠️ **必须在光栅化之后做**，不能在 `fillTarnPlateau` 里做 —— 那时高台还没长出来。
    // ⚠️ **只换「露天顶层那一格」**：用「向上第一格是空气」判据逐列找地表。
    //    写成「从 y=plateauY 到天上全部换」会把高台内部的楼层/墙面也换掉（那就不再是建筑了）。
    // ⚠️ **只在雪环带内换**（`TARN_ICE_RADIUS` 到 `TARN_SNOW_RADIUS` 的温度带）：
    //    高台环半径 58 落在带内（44~72），而紫晶柱内环 20 在冰区、拱洞环 96 在草斑区 ——
    //    如果全圆无条件换雪，会把冰区地面和草斑地面也变成雪。
    tarnSnowCap(column, tarnLayout, seed, registry, setBlock);

    // 4 朵巨型云（用户要求「原有云朵可以渲染」的额外一层 —— 与 `sky.cloudClusters` 的
    // 既有小云簇**并存**，不是替代）。
    //
    // ⚠️ y = `TARN_CLOUD_MIN_Y`（= 54），不是 `plateauY`：云是空中结构，不是台地附属物。
    // ⚠️ 半宽从 `KIT_METRICS` 读，**不要写 30 之类的字面量** —— 每个变体尺寸不同
    //    （实测 21×16×20 ~ 60×38×60），写死会让大云在部分 column 被误判不相交 → 缺半边
    //    且静默（方块层面看不出是裁剪判据写错了）。
    for (const cloud of tarnLayout.clouds) {
      const wx = Math.round(tarnLayout.cx + cloud.ring * Math.cos(cloud.ang));
      const wz = Math.round(tarnLayout.cz + cloud.ring * Math.sin(cloud.ang));
      const m = KIT_METRICS[cloud.variant];
      if (!m) continue;
      if (!placementIntersects({ x: wx, z: wz }, m.width / 2, m.depth / 2, column.cx, column.cz)) continue;
      rasterizeStructure(cloud.variant, wx, TARN_CLOUD_MIN_Y, wz, setBlock, column, registry, seed, false);
    }
  }

  // ---- 阶段 2：JSON 结构光栅化（AABB 覆盖本 column 的全部 placement）----
  if (cityLayout) {
    const all = [...cityLayout.placements, ...cityLayout.fillerPlacements];
    for (const p of all) {
      const fp = CITY_STRUCTURE_FOOTPRINT[p.type];
      const halfX = fp ? fp.halfX : 12; // filler tank 无 footprint 表项，用实测占地
      const halfZ = fp ? fp.halfZ : 12;
      if (!placementIntersects(p, halfX, halfZ, column.cx, column.cz)) continue;
      const surfaceY = getCitySurfaceY(p.x, p.z, cityLayout, seed);
      const centerY = (surfaceY === null ? cityLayout.baseHeight : surfaceY) + 1;
      rasterizeStructure(p.type, p.x, centerY, p.z, setBlock, column, registry, seed,
        GROUND_SUPPORT_TYPES.has(p.type));
    }
  }

  for (const layout of layouts) {
    // 海岛中心塔（表面 = 海平面）：塔占地 9×10 可跨 column，按 AABB 相交裁剪
    if (layout.island) {
      const t = layout.island;
      const fp = CITY_STRUCTURE_FOOTPRINT.tower;
      if (placementIntersects({ x: t.cx, z: t.cz }, fp.halfX, fp.halfZ, column.cx, column.cz)) {
        rasterizeStructure('tower', t.cx, ISLAND_SEA_LEVEL + 1, t.cz, setBlock, column, registry, seed, false);
      }
    }
    // 平地中心金字塔岛（mc-lite：y = 自然地形 h + 1，ground support 补平）：
    // 占地 34×39 必跨多 column，按 AABB 相交裁剪（仅中心 column 光栅化会被 chunk 切割）
    if (layout.plainLand) {
      const pl = layout.plainLand;
      const fp = CITY_STRUCTURE_FOOTPRINT.pyramidIsland;
      if (placementIntersects({ x: pl.cx, z: pl.cz }, fp.halfX, fp.halfZ, column.cx, column.cz)) {
        const h = generateHeight(pl.cx, pl.cz, seed);
        rasterizeStructure('pyramidIsland', pl.cx, h + 1, pl.cz, setBlock, column, registry, seed, true);
      }
    }
  }

  // ---- 阶段 2.7：撒布结构光栅化（M2 欠账补齐，flower_bed/pavilion/tall_well/house/沙漠结构）----
  // 候选在 region layout 层算一次（computeScatterCandidates，DR-13），这里只做 AABB 裁剪
  // 光栅化（与 pyramidIsland/tower 同模式）—— 每个候选点被所有相交 column 各自光栅化本 column
  // 部分，接缝无缝拼接（判定是 region 级纯函数，跨 column 结论恒一致）。
  //
  // 层序：放在 JSON 结构之后、空中结构之前 —— 撒布结构是地面级内容，须先于空中云/岛写入，
  // 但晚于城市 placement（mc-lite 城市后置填充在主结构之后，WorldWorker.js:1132）。
  // 复用上面预载阶段已收集的候选数组（勿在此重新收集 —— 重复声明 `scatterCandidates`
  // 会让整个模块 SyntaxError → 页面白屏，且重复扫一遍 layouts 是浪费）。
  //
  // 巨型金字塔锚点列表（阶段 2.7 的撒布剔除用）：只算一次，不每个候选重算
  const giantAnchors = layouts.map((l) => l.giantPyramid);
  for (const arr of scatterCandidates) {
    for (let i = 0; i < arr.length; i += SCATTER_STRIDE) {
      const x = arr[i], y = arr[i + 1], z = arr[i + 2];
      const type = SCATTER_TYPES[arr[i + 3]];
      // 「远离主建筑 / 避开树 / 避开 flowerBed」等门控已在候选层（rollCityScatter）做过，
      // 这里只做几何裁剪，不重复判定（重复门控会引入第二份判据 → 红线 1）。
      //
      // ⚠️ **唯一例外：城市 bounds 内的「城市外撒布」必须在这里跳过**（同一判据
      // `inCityBounds`，不是第二份：候选层只能过滤**持有 city 布局的 region [0,0]**，
      // 而城市 bounds 可跨 region（实测 seed=12345 bounds=[0,566]×[-166,400]），
      // 落在 region [1,0] 扫描范围内那部分只有 apply.js 能判 —— 它拿得到 cityLayout）。
      // 不跳过的后果：城市外的落点用自然地形高度、而城内地面已被 generateCity 整形
      // → 房子飘在空中（实测悬空率 37%~90%，最高 15 格）。上游 mc-lite 是
      // `if (inCity) {...} else {城市外撒布}` 互斥（WorldWorker.js:793 / :1084-1086）。
      // 城市自己的撒布（cityScatter）不受影响。
      if (cityLayout && !cityScatterArrs.has(arr) && inCityBounds(x, z, cityLayout)) continue;
      // 巨型金字塔占地内的撒布候选一律不落地（用户裁定：巨型金字塔不与任何撒布结构重合）。
      // 判据函数在 `giant-pyramid.js`（与 `inCityBounds` 同手法：单一权威，不在此另写一份）。
      // 不剔除的后果：24 格高的小沙漠神殿会长在塔身内部（从外面看像塔上多出一块）；
      // 且因为金字塔在阶段 2.76 **后写胜**，被埋的神殿方块会被塔身覆盖掉一半，剩下的露在空里。
      if (inGiantPyramidFootprint(x, z, giantAnchors)) continue;
      const fp = SCATTER_FOOTPRINT[type];
      if (!fp) continue;
      if (!placementIntersects({ x, z }, fp.halfX, fp.halfZ, column.cx, column.cz)) continue;
      // 代码生成类型走映射表（house/ship），其余走 JSON 光栅化。
      // 用映射表而非 if/else if 链 —— 加第三个代码生成类型时不用改分支逻辑。
      const codeGen = CODE_GENERATORS[type];
      if (codeGen) {
        codeGen(x, y, z, setBlock, seed);
      } else {
        rasterizeStructure(type, x, y, z, setBlock, column, registry, seed,
          GROUND_SUPPORT_TYPES.has(type));
      }
    }
  }

  // ---- 阶段 2.75：Cloudland 高台（桌山景观）----
  // 层序理由：撒布结构（2.7）是地面级小内容，先写；高台是地面级固定景观，在其上（后写胜）；
  // 巨树（2.8）有 allowedAt 判据可避让，故高台先于巨树。
  //
  // 让路必须在**这里**判而不能在候选层：城市 bounds 可跨 region（实测 seed=12345
  // bounds x∈[0,566]），只有持有 city 的 region [0,0] 拿得到 cityLayout —— 与 v1.74
  // 修「City 里 house 悬空」的判据落点完全同源（见 scatter.js 的口径差异②）。
  // `pointContext().kind !== 'normal'` 一次性排除：城市 / 金字塔 / 平地 / 雪原 / 冰封山 /
  // 海岛（island/snow/fm/none/city/water 六类），只允许纯自然陆地。

  // ---- 阶段 2.76：巨型金字塔（Giant Pyramid Epic）----
  // 层序理由：撒布结构（2.7）与高台（2.75）都是地面级内容，先写；金字塔是 24 格高的大型结构，
  // 在其上（后写胜）；巨树（2.8）有 allowedAt 判据可避让（`pointContext` 已对金字塔占地返回
  // `kind:'none'`），故金字塔先于巨树。
  //
  // 让路已在候选层做过（城市 / 地标 / 空岛 / 高台），这里只做两项**纵深防御**：
  //   ① 城市 bounds —— 候选层用的是 `getCityBoundsForSeed` 的同一份数据，理论上不会命中，
  //      但城市 bounds 可跨 region（实测 4 个），这里用 cityLayout 再判一次零成本；
  //   ② 高台 —— **只在同一 region** 可能相交（内缩量保证相邻 region 不相交，见 spec DR-7），
  //      候选层已排除，这里再判一次防“将来有人改内缩量”。
  for (const layout of layouts) {
    const anchor = layout.giantPyramid;
    if (!anchor) continue;
    if (cityLayout &&
        anchor.wx + PYRAMID_HALF >= cityLayout.minX && anchor.wx - PYRAMID_HALF <= cityLayout.maxX &&
        anchor.wz + PYRAMID_HALF >= cityLayout.minZ && anchor.wz - PYRAMID_HALF <= cityLayout.maxZ) continue;
    if (!placementIntersects({ x: anchor.wx, z: anchor.wz }, PYRAMID_HALF, PYRAMID_HALF, column.cx, column.cz)) continue;
    // 不补 groundSupport：底层是满铺 49×49 实心（2401 格），补柱会在沙漠里插 2401 根沙柱
    rasterizeStructure('giantPyramid', anchor.wx, anchor.floorY + 1, anchor.wz,
      setBlock, column, registry, seed, false);
  }

  // ---- 阶段 2.8：巨树景观（Giant Trees Epic）----
  // 候选在 region 层算好（computeGiantTreeCandidates），这里：合并邻域候选 → 排除（地标/撒布/城市）→ 光栅化 →
  // 返回覆盖窗口供阶段 3 抑制旧植被。排除只允许 pointContext 为 normal/water 的点（water = 树冠悬在水面上）。
  const giant = applyGiantTrees(column, layouts, seed, registry, {
    ext: VEGETATION_EXT,
    allowedAt: giantAllowedAtFor(layouts, cityLayout, seed),
  });

  // ---- 阶段 2.5：空中结构（M2-7：Y=55 单云 + 空岛，层序先云后岛；mc-lite 空中内容后写）----
  const skyCandidates = layouts.map((l) => l.sky).filter(Boolean);
  if (skyCandidates.length > 0) {
    applySkyStructures(column, skyCandidates, seed, registry);
  }

  // ---- 阶段 3：植被（M2-3，mc-lite 各分支植被规则）----
  // 树冠半径 ≤3：扫描扩展 3 格，树在基点光栅化（setBlock 自动裁剪到本 column）；
  // 单格植物只在本 column 内的点写入。
  const EXT = VEGETATION_EXT;
  const minX = column.cx * 16, maxX = column.cx * 16 + 15;
  const minZ = column.cz * 16, maxZ = column.cz * 16 + 15;
  for (let wx = minX - EXT; wx <= maxX + EXT; wx++) {
    for (let wz = minZ - EXT; wz <= maxZ + EXT; wz++) {
      const inColumn = wx >= minX && wx <= maxX && wz >= minZ && wz <= maxZ;
      const ctx = pointContext(wx, wz, layouts, cityLayout, seed);
      // 巨树覆盖区内的旧植被树不再生成（替换语义）。覆盖窗口含 column 外 EXT 格带：带内旧树的树冠会写进本 column。
      const inGiant = giant.covers(wx, wz);

      if (inColumn && ctx.kind === 'water' && ctx.biome === 'SWAMP' && seededRandom(wx, wz, seed + 12) < 0.08) {
        // 睡莲放在水面格的**上一格**（SEA_Y+1，原本是空气），不是 SEA_Y：
        // ① 不覆盖 y=SEA_Y 的水 → 消除「水洞」（原实现盖掉最高一层水格，四周水还在，
        //    且 lilypad.solid=false → 玩家踩上去会掉进洞里）；
        // ② 配合 TEMPLATES.lilypad 的 y=-0.48 → 叶面 (SEA_Y+1)-0.48 = -1.48，恰好高出
        //    下沉后的暴露水面顶面 (SEA_Y+1)-0.5 = -1.50 两厘米 → 紧贴水面、不沉水。
        // mc-lite 的 lilypad 是装饰实体（EntityManager.js:412）不占体素格，故天然无水洞；
        // 本仓库搬成体素方块后必须显式选格。详见 §4.3。
        setBlock(wx, SEA_Y + 1, wz, 'lilypad');
      }

      let tree = null;
      let baseY = null;
      if (ctx.kind === 'normal') {
        const roll = rollVegetation(wx, wz, ctx.biome, seed);
        // 单格植物：覆盖区内若目标格已被巨树方块占用（树干底格/贴地叶）则不覆盖 —— 否则单树干的树
        // 会被一朵花顶掉唯一的底格而悬空。目标格是空气则照常生成（树下长草合理）。
        if (inColumn && roll.plant &&
            !(inGiant && column.blocks[blockIndex(wx - minX, ctx.h + 1, wz - minZ)] !== 0)) {
          setBlock(wx, ctx.h + 1, wz, roll.plant);
        }
        if (roll.tree) { tree = roll.tree; baseY = ctx.h + 1; }
      } else if (ctx.kind === 'city') {
        if (!isPointNearCityStructure(wx, wz, cityLayout, 2)) {
          const roll = rollCityTree(wx, wz, seed);
          if (roll.tree) { tree = roll.tree; baseY = ctx.surfaceY + 1; }
        }
      } else if (ctx.kind === 'snow') {
        if (ctx.core && !ctx.belowSea && seededRandom(wx, wz, seed + 10) < 0.002) {
          tree = { type: 'birchTreeWithSnow' }; baseY = ctx.surfaceY + 1;
        }
      } else if (ctx.kind === 'fm') {
        if (ctx.core && !ctx.belowSea && seededRandom(wx, wz, seed + 11) < 0.001) {
          tree = { type: 'birchTreeWithSnow' }; baseY = ctx.surfaceY + 1;
        }
      } else if (inColumn && ctx.kind === 'island' && ctx.core) {
        // 海岛树：基点抽数量，偏移落点（mc-lite 语义）
        const treeChance = seededRandom(wx, wz, seed + 100);
        const treeCount = treeChance < 0.0015 ? 2 : treeChance < 0.003 ? 1 : 0;
        for (let i = 0; i < treeCount; i++) {
          const ox = Math.floor(seededRandom(i, i + 10, seed + 200) * 10) - 5;
          const oz = Math.floor(seededRandom(i + 5, i + 15, seed + 201) * 10) - 5;
          const treeX = wx + ox, treeZ = wz + oz;
          const tInfo = getIslandInfo(treeX, treeZ, ctx.island, seed);
          const distTower = Math.max(Math.abs(treeX - ctx.island.cx), Math.abs(treeZ - ctx.island.cz));
          if (tInfo && tInfo.zone === 'core' && distTower > 5) {
            generateTree(treeX, ctx.surfaceY + 1, treeZ, setBlock, seed, 'default');
          }
        }
      }

      if (tree && !inGiant) {
        if (tree.type === 'birchTree') {
          rasterizeStructure('birchTree', wx, baseY, wz, setBlock, column, registry, seed, false);
        } else if (tree.type === 'birchTreeWithSnow') {
          rasterizeStructure('birchTreeWithSnow', wx, baseY, wz, setBlock, column, registry, seed, false);
        } else {
          generateTree(wx, baseY, wz, setBlock, seed, tree.type, tree.customLog || null, tree.customLeaf || null);
        }
      }
    }
  }
}
