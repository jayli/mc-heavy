// src/gen/structures/apply.js — 结构注入：fillColumn 之后、光照之前叠加结构方块（设计文档 §4.2）
// 地形整形（地标 elif 链，mc-lite 列循环优先级 city > pyramid > island > plainLand > snowLand > fm）
// + JSON 结构光栅化（城市建筑 / 海岛塔 / 平地金字塔岛，按 AABB 裁剪到本 column）。
// 树木/植被 M2-3 追加。Worker 同构：本文件不得 import three。
import { generateHeight, generateHeightForBiome, surfaceBlocksOfBiome } from '../terrain.js';
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
import {
  CITY_STRUCTURE_FOOTPRINT, ISLAND_SEA_LEVEL, SCATTER_FOOTPRINT, REDCITY_FILL_BLOCK, REDCITY_VEG_CLEARANCE, TREE_CANOPY_RADIUS,
} from './region-config.js';
import { getRedCityInfo } from './redcity-layout.js';
import { erasedFlags, shapeRedCityCore, shapeRedCityRing, ringSurfaceY } from './redcity-surface.js';
import { getRedCityData, forEachRedCityBlock } from './redcity-data.js';
import { preloadStructures, rasterizeStructure, GROUND_SUPPORT_TYPES } from './structure-json.js';
import { applySkyStructures } from './sky-structures.js';
import { generateTree, rollVegetation, rollCityTree } from './vegetation.js';
import {
  SCATTER_TYPES, SCATTER_STRIDE, CODE_GENERATED_SCATTER_TYPES,
  generateCodeHouse, generateCodeShip,
} from './scatter.js';
import { SEA_Y } from '../../voxel/constants.js';

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

let _warnedNoRedCityData = false;
function warnNoRedCityData() {
  if (_warnedNoRedCityData) return;
  _warnedNoRedCityData = true;
  console.warn('[redcity] 产物未注入：RedCity core 退化为平地（检查 redcity-data 的 broadcast 是否先于首个 gen）');
}

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
 * kind = city / island / snow / fm / normal / water / none（金字塔/平地不挂植被）。
 */
function pointContext(wx, wz, layouts, cityLayout, seed, redCity = null, erased = null) {
  const cityInfo = cityLayout && getCityInfo(wx, wz, cityLayout);
  if (cityInfo) {
    // 残丘已清除（generateCity 清 surfaceY+1..naturalH），树直接植根城市地表。
    return { kind: 'city', surfaceY: getCityFinalSurfaceY(wx, wz, cityInfo, seed) };
  }
  if (redCity) {
    const rc = getRedCityInfo(wx, wz, redCity);
    if (rc) {
      // core ⊕ REDCITY_VEG_CLEARANCE 内一律不长（树冠半径 ≤3：根在 d>=4 的树，树冠最近只到 d=1，永不进 core）。
      if (rc.zone === 'core' || rc.edgeDistance <= REDCITY_VEG_CLEARANCE) return { kind: 'none' };
      // ring 其余部分保留自然植被，但按 ring 的**实际地表**落点（否则悬空或埋入）。水域已被补实成陆地 → 一律 normal。
      return { kind: 'normal', biome: getBiome(wx, wz, seed), h: ringSurfaceY(rc.edgeDistance, generateHeight(wx, wz, seed), redCity.baseY) };
    }
  }
  for (let li = 0; li < layouts.length; li++) {
    const layout = layouts[li];
    const er = erased ? erased[li] : null;   // 被 RedCity 吞并的地标：阶段 1/2 已不生成，植被上下文也必须当它不存在
    if (!(er && er.pyramid) && getPyramidInfo(wx, wz, layout.pyramid)) return { kind: 'none' };
    if (layout.island && !(er && er.island)) {
      const ii = getIslandInfo(wx, wz, layout.island, seed);
      if (ii) {
        const sy = islandSurfaceY(wx, wz, ii, seed);
        if (sy === null) return { kind: 'none' };
        return { kind: 'island', core: ii.zone === 'core', surfaceY: sy, island: layout.island };
      }
    }
    if (layout.plainLand && !(er && er.plainLand) && getPlainLandInfo(wx, wz, layout.plainLand)) return { kind: 'none' };
    const slInfo = (er && er.snowLand) ? null : getSnowLandInfo(wx, wz, layout.snowLand, seed);
    if (slInfo) {
      const sy = snowLandSurfaceY(generateHeight(wx, wz, seed), slInfo);
      return { kind: 'snow', core: slInfo.zone === 'core', belowSea: sy <= SEA_Y - 1, surfaceY: sy };
    }
    const fmInfo = (er && er.frozenMountain) ? null : getFrozenMountainInfo(wx, wz, layout.frozenMountain, seed);
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
 * 将布局覆盖本 column 的结构方块裁剪写入 column（生成路径：不记 edits、不 bump version）。
 * 异步：城市布局需预载建筑 JSON（Worker 内 fetch + 模块缓存）。
 * @param {import('../../voxel/chunk-column.js').ChunkColumn} column
 * @param {number} seed
 * @param {*} registry
 * @param {Array<Object>} layouts 查询域内全部 region 布局（StructureIndex.layoutsForColumn）
 * @param {Object|null} [redCity] RedCity 布局（core/influence/baseY/size）。**全局下发**（不在 layouts 里取），缺省 null = 无 RedCity
 */
export async function applyStructuresToColumn(column, seed, registry, layouts, redCity = null) {
  if (!layouts || layouts.length === 0) return;
  const setBlock = makeColumnSetter(column, registry);
  // RedCity：被吞并标志每次调用只算一次，阶段 1 / 2 / 3 共用（见 erasedFlags 注释）
  const erased = redCity ? layouts.map((l) => erasedFlags(l, redCity)) : null;
  const rcModel = redCity ? getRedCityData() : null;
  if (rcModel && (rcModel.width !== redCity.size.X || rcModel.length !== redCity.size.Z)) {
    throw new Error(`redcity: 产物尺寸 ${rcModel.width}×${rcModel.length} 与布局 ${redCity.size.X}×${redCity.size.Z} 不符`);
  }
  const fillId = registry.idOf(REDCITY_FILL_BLOCK);
  const ringIds = new Map();   // biome → {surf, sub, fill}
  const ringIdsOf = (biome) => {
    let v = ringIds.get(biome);
    if (!v) { const [s, u] = surfaceBlocksOfBiome(biome); v = { surf: registry.idOf(s), sub: registry.idOf(u), fill: fillId }; ringIds.set(biome, v); }
    return v;
  };

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
  for (const layout of layouts) {
    if (!layout.scatter) continue;
    for (const arr of [layout.scatter.cityScatter, layout.scatter.outsideScatter]) {
      if (!arr || arr.length === 0) continue;
      scatterCandidates.push(arr);
      // 扫一遍 typeIndex 收集本 column 查询域实际出现的类型（廉价：只读 Int32Array）。
      // 代码生成类型（house/ship）无 JSON，跳过 —— 从 CODE_GENERATED_SCATTER_TYPES 派生，
      // 勿写成 `t !== 'house'` 字面量（漏 ship → 白 fetch 一个不存在的 JSON）。
      for (let i = 3; i < arr.length; i += SCATTER_STRIDE) {
        const t = SCATTER_TYPES[arr[i]];
        if (!CODE_GENERATED_SCATTER_TYPES.includes(t)) needTypes.add(t);
      }
    }
  }
  await preloadStructures([...needTypes]);

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

      // RedCity（城市之后、地标之前）：influence 内整列接管，地标分支全部跳过（吞并）
      const rcInfo = redCity ? getRedCityInfo(wx, wz, redCity) : null;
      if (rcInfo) {
        if (rcInfo.zone === 'core') {
          // 降级路径（产物未注入）：core 退化为 baseY 平地、不写内容、**不抛错**（世界仍可玩；spec 裁定）。
          // 生产上不会发生——主线程 await 完 fetch 并 broadcast 之后才会有第一个 gen（postMessage 保序）。
          // 但「静默变平地」正是最难发现的失效形态，故首次命中时 warn 一次。
          if (!rcModel) warnNoRedCityData();
          shapeRedCityCore(column, lx, lz, redCity.baseY + (rcModel ? rcModel.ground[rcInfo.oz * rcModel.width + rcInfo.ox] : 0), h, fillId);
        } else {
          shapeRedCityRing(column, lx, lz, ringSurfaceY(rcInfo.edgeDistance, h, redCity.baseY), h, ringIdsOf(getBiome(wx, wz, seed)));
        }
        continue;
      }

      let handled = false;
      for (let li = 0; li < layouts.length; li++) {
        const layout = layouts[li];
        const er = erased ? erased[li] : null;
        if (handled) break;
        const pyInfo = (er && er.pyramid) ? null : getPyramidInfo(wx, wz, layout.pyramid);
        if (pyInfo) { generatePyramid(wx, wz, h, pyInfo, setBlock, seed); handled = true; break; }

        if (layout.island && !(er && er.island)) {
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

        if (layout.plainLand && !(er && er.plainLand)) {
          const plainInfo = getPlainLandInfo(wx, wz, layout.plainLand);
          if (plainInfo) { generatePlainLand(wx, wz, h, plainInfo, setBlock); handled = true; break; }
        }

        const slInfo = (er && er.snowLand) ? null : getSnowLandInfo(wx, wz, layout.snowLand, seed);
        if (slInfo) { generateSnowLand(wx, wz, h, slInfo, setBlock, seed); handled = true; break; }

        const fmInfo = (er && er.frozenMountain) ? null : getFrozenMountainInfo(wx, wz, layout.frozenMountain, seed);
        if (fmInfo) { generateFrozenMountain(wx, wz, h, fmInfo, setBlock, seed); handled = true; break; }
      }
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

  for (let li = 0; li < layouts.length; li++) {
    const layout = layouts[li];
    const er = erased ? erased[li] : null;   // 被吞并地标的 JSON 结构（海岛塔 / 平原金字塔岛）同样跳过
    // 海岛中心塔（表面 = 海平面）：塔占地 9×10 可跨 column，按 AABB 相交裁剪
    if (layout.island && !(er && er.island)) {
      const t = layout.island;
      const fp = CITY_STRUCTURE_FOOTPRINT.tower;
      if (placementIntersects({ x: t.cx, z: t.cz }, fp.halfX, fp.halfZ, column.cx, column.cz)) {
        rasterizeStructure('tower', t.cx, ISLAND_SEA_LEVEL + 1, t.cz, setBlock, column, registry, seed, false);
      }
    }
    // 平地中心金字塔岛（mc-lite：y = 自然地形 h + 1，ground support 补平）：
    // 占地 34×39 必跨多 column，按 AABB 相交裁剪（仅中心 column 光栅化会被 chunk 切割）
    if (layout.plainLand && !(er && er.plainLand)) {
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
  for (const arr of scatterCandidates) {
    for (let i = 0; i < arr.length; i += SCATTER_STRIDE) {
      const x = arr[i], y = arr[i + 1], z = arr[i + 2];
      const type = SCATTER_TYPES[arr[i + 3]];
      // 「远离主建筑 / 避开树 / 避开 flowerBed」等门控已在候选层（rollCityScatter）做过，
      // 这里只做几何裁剪，不重复判定（重复门控会引入第二份判据 → 红线 1）。
      const fp = SCATTER_FOOTPRINT[type];
      if (!fp) continue;
      if (!placementIntersects({ x, z }, fp.halfX, fp.halfZ, column.cx, column.cz)) continue;
      // RedCity：footprint 与 influence 相交的候选整体丢弃。⚠️ 现状对 City bounds 也没有这层过滤（scatter.js 的注释声称
      // 由本文件过滤，实际没有），这里自写、只管 RedCity，不替 City 补。
      if (redCity) {
        const r = redCity.influence;
        if (!(x + fp.halfX < r.minX || x - fp.halfX > r.maxX || z + fp.halfZ < r.minZ || z - fp.halfZ > r.maxZ)) continue;
      }
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

  // ---- 阶段 2.5：空中结构（M2-7：Y=55 单云 + 空岛，层序先云后岛；mc-lite 空中内容后写）----
  const skyCandidates = layouts.map((l) => l.sky).filter(Boolean);
  if (skyCandidates.length > 0) {
    applySkyStructures(column, skyCandidates, seed, registry);
  }

  // ---- 阶段 2.9：RedCity 烘焙内容（后写胜：云/空岛在其前写入，故只占空气格）----
  // 世界 y = baseY + dy（dy 是相对 baseY 的行号，不是相对该列地面；ground 不参与方块放置）。越界 y 由 setBlock 静默丢弃。
  if (redCity && rcModel) {
    const cMinX = column.cx * 16, cMinZ = column.cz * 16;
    const ox0 = Math.max(0, cMinX - redCity.core.minX), ox1 = Math.min(rcModel.width - 1, cMinX + 15 - redCity.core.minX);
    const oz0 = Math.max(0, cMinZ - redCity.core.minZ), oz1 = Math.min(rcModel.length - 1, cMinZ + 15 - redCity.core.minZ);
    for (let oz = oz0; oz <= oz1; oz++) {
      for (let ox = ox0; ox <= ox1; ox++) {
        const wx = redCity.core.minX + ox, wz = redCity.core.minZ + oz;
        forEachRedCityBlock(rcModel, ox, oz, (dy, name) => setBlock(wx, redCity.baseY + dy, wz, name));
      }
    }
  }

  // ---- 阶段 3：植被（M2-3，mc-lite 各分支植被规则）----
  // 树冠半径 ≤3：扫描扩展 3 格，树在基点光栅化（setBlock 自动裁剪到本 column）；
  // 单格植物只在本 column 内的点写入。
  const EXT = TREE_CANOPY_RADIUS;
  const minX = column.cx * 16, maxX = column.cx * 16 + 15;
  const minZ = column.cz * 16, maxZ = column.cz * 16 + 15;
  for (let wx = minX - EXT; wx <= maxX + EXT; wx++) {
    for (let wz = minZ - EXT; wz <= maxZ + EXT; wz++) {
      const inColumn = wx >= minX && wx <= maxX && wz >= minZ && wz <= maxZ;
      const ctx = pointContext(wx, wz, layouts, cityLayout, seed, redCity, erased);

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
        if (inColumn && roll.plant) setBlock(wx, ctx.h + 1, wz, roll.plant);
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

      if (tree) {
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
