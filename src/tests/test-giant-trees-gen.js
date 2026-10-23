// src/tests/test-giant-trees-gen.js — 巨树景观 Tier 1：接线与真实 GEN（layout 字段 / 让路 / 旧植被互斥 / 植物规则 / 确定性）
//
// 全部走真实 layout + 真实 GEN 路径（fillColumn → applyStructuresToColumn），不靠合成捷径。
// 钉的缺陷：城市 / 地标 / 撒布结构让路（原设计 16% 的树进城、12.4% 压地标、9.4% 压撒布结构）；
//   单格植物不得顶掉树干底格；GEN 侧「拼接合并」没接线时森林 column 里几乎没有巨树。
// 每条「零闯入」断言都带「不排除时确有树会闯入」的对照（防恒真）。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertNotNull } from './assert.js';
import {
  GIANT_STRIDE, loadGiantTrees, rotateCell, collectGiantTrees, collectExclusionBoxes, isGiantTreeAllowed,
} from '../gen/structures/giant-trees.js';
import { computeRegionLayout, neighborRegionKeys } from '../gen/structures/structure-layout.js';
import { applyStructuresToColumn, giantAllowedAtFor } from '../gen/structures/apply.js';
import { fillColumn, generateHeight } from '../gen/terrain.js';
import { getBiome } from '../gen/noise.js';
import { rollVegetation } from '../gen/structures/vegetation.js';
import { getCityInfo } from '../gen/structures/city-layout.js';
import {
  getPyramidInfo, getIslandInfo, getPlainLandInfo, getSnowLandInfo, getFrozenMountainInfo,
} from '../gen/structures/landmarks.js';
import { SCATTER_TYPES, SCATTER_STRIDE } from '../gen/structures/scatter.js';
import { SCATTER_FOOTPRINT, CITY_STRUCTURE_FOOTPRINT, REGION_SIZE } from '../gen/structures/region-config.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { blockIndex, SEA_Y, WORLD_MIN_Y, WORLD_MAX_Y } from '../voxel/constants.js';

const SEED = 12345;
const EXT = 3; // 与 apply.js 的 VEGETATION_EXT 同值（植被树冠半径 ≤ 3）

function makeRegistry() {
  const r = createRegistry();
  for (const def of BLOCKS) r.register(def.name, def);
  r.freeze();
  return r;
}
const reg = makeRegistry();
const GIANT_IDS = new Set(BLOCKS.filter((b) => b.name.startsWith('giant_')).map((b) => reg.idOf(b.name)));
const OLD_TREE_IDS = new Set(['wood', 'birch_log', 'leaves', 'yellow_leaves'].map((n) => reg.idOf(n)));

const layoutCache = new Map();
function layoutOf(rx, rz) {
  const k = `${rx},${rz}`;
  if (!layoutCache.has(k)) layoutCache.set(k, computeRegionLayout(rx, rz, SEED));
  return layoutCache.get(k);
}
const layoutsForColumn = (cx, cz) => neighborRegionKeys(cx, cz).map((k) => layoutOf(...k.split(',').map(Number)));
const cityLayout = layoutOf(0, 0).city;

/** 真实 GEN 路径（与 world-worker 的 gen 一致：fillColumn → applyStructuresToColumn） */
async function genColumn(cx, cz, layouts = layoutsForColumn(cx, cz)) {
  const c = new ChunkColumn(cx, cz);
  fillColumn(c, SEED, reg);
  await applyStructuresToColumn(c, SEED, reg, layouts);
  return c;
}
const stripGiants = (layouts) => layouts.map((l) => ({ ...l, giantTrees: null }));
function countIds(col, ids) { let n = 0; for (let i = 0; i < col.blocks.length; i++) if (ids.has(col.blocks[i])) n++; return n; }

test('layout 带 giantTrees 字段：三个 Int32Array，长度是 stride 的倍数', () => {
  for (const [rx, rz] of [[0, 0], [1, 1], [-1, 0]]) {
    const g = layoutOf(rx, rz).giantTrees;
    assertNotNull(g, `region(${rx},${rz}) 有 giantTrees`);
    for (const k of ['forest', 'beach', 'banyan']) {
      assertTrue(g[k] instanceof Int32Array, `${k} 是 Int32Array`);
      assertEqual(g[k].length % GIANT_STRIDE, 0, `${k} 长度是 stride 的倍数`);
    }
  }
});

/** region(-1,0) 内 column 的扫描域：cx ∈ [-25,-1]、cz ∈ [0,24]（森林为主，实测每 column 含巨树的比例很高） */
function forestScanColumns(limit) {
  const out = [];
  for (let cx = -25; cx <= -1 && out.length < limit; cx += 2) for (let cz = 0; cz <= 24 && out.length < limit; cz += 2) out.push([cx, cz]);
  return out;
}

/** accepted 里的树落在本 column 内的格数（与 rasterizeGiantTree 的写入同一展开；地基填充的格都在 gy=0 底格同 column，不另算） */
function expectedCellsInColumn(accepted, cx, cz) {
  let n = 0;
  for (const t of accepted) {
    const v = t.variant;
    for (let k = 0; k < v.cells.length; k += 4) {
      const [rx, rz] = rotateCell(v, t.rot, v.cells[k], v.cells[k + 2]);
      const x = t.x0 + rx, z = t.z0 + rz, y = t.wy + v.cells[k + 1];
      if (x >= cx * 16 && x < cx * 16 + 16 && z >= cz * 16 && z < cz * 16 + 16 && y >= WORLD_MIN_Y && y < WORLD_MAX_Y) n++;
    }
  }
  return n;
}

test('真实 GEN：column 里有无巨树方块 ⇔ 生产判据下期望有无（拼接合并 + 排除接线回归）', async () => {
  const families = (await loadGiantTrees()).families;
  let expectedWith = 0, disagree = 0;
  for (const [cx, cz] of forestScanColumns(150)) {
    const layouts = layoutsForColumn(cx, cz);
    const win = { minX: cx * 16, maxX: cx * 16 + 15, minZ: cz * 16, maxZ: cz * 16 + 15 };
    const allowedAt = giantAllowedAtFor(layouts, cityLayout, SEED);
    const boxes = collectExclusionBoxes(layouts, win, EXT);
    const accepted = collectGiantTrees(layouts, SEED, families, win, EXT).filter((t) => isGiantTreeAllowed(t, allowedAt, boxes));
    const expected = expectedCellsInColumn(accepted, cx, cz) > 0;
    const has = countIds(await genColumn(cx, cz, layouts), GIANT_IDS) > 0;
    if (expected) expectedWith++;
    if (expected !== has) disagree++;
  }
  assertTrue(expectedWith >= 20, `扫描域内期望含巨树的 column ≥ 20（对照，防恒真；实测 ~60）：${expectedWith}`);
  assertEqual(disagree, 0, '期望与实际逐 column 一致');
});

test('真实 GEN：森林 column 里确有巨树方块（覆盖赋值的回归：原写法 625 个 column 只会出 1 棵）', async () => {
  let found = 0, tested = 0;
  for (const [cx, cz] of forestScanColumns(200)) {
    const col = await genColumn(cx, cz); tested++;
    if (countIds(col, GIANT_IDS) > 0) found++;
  }
  assertTrue(found >= 20, `测得 ${tested} 个森林 column，含巨树的 ${found} 个（≥ 20；实测 ~60）`);
});

test('真实 GEN：城市 bounds 内零巨树方块（Review Focus ⑤；原设计 16% 的树进城）', async () => {
  const { minX, maxX, minZ, maxZ } = cityLayout; let total = 0, inside = 0;
  // 城市外环带：与「城市 bounds 外扩 24」相交、且靠近边界线的 column
  for (let cx = Math.floor((minX - 24) / 16); cx <= Math.floor((maxX + 24) / 16); cx++) {
    for (let cz = Math.floor((minZ - 24) / 16); cz <= Math.floor((maxZ + 24) / 16); cz++) {
      const x0 = cx * 16, z0 = cz * 16;
      const deep = x0 > minX + 24 && x0 + 15 < maxX - 24 && z0 > minZ + 24 && z0 + 15 < maxZ - 24; // 城内深处：整列都在城里，跳过
      if (deep) continue;
      const col = await genColumn(cx, cz);
      for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
        let g = 0;
        for (let y = WORLD_MIN_Y; y < WORLD_MAX_Y; y++) if (GIANT_IDS.has(col.blocks[blockIndex(lx, y, lz)])) g++;
        if (g === 0) continue;
        total += g;
        if (getCityInfo(x0 + lx, z0 + lz, cityLayout)) inside += g;
      }
    }
  }
  assertTrue(total > 0, `城外环带里有巨树方块（对照，防恒真）：${total}`);
  assertEqual(inside, 0, '城市 bounds 内不得有巨树方块');
});

test('真实 GEN：撒布结构 footprint 内零巨树方块（树让路；原设计 9.4% 的树压撒布结构）', async () => {
  const colCache = new Map();
  const colOf = async (cx, cz) => { const k = `${cx},${cz}`; if (!colCache.has(k)) colCache.set(k, await genColumn(cx, cz)); return colCache.get(k); };
  let structures = 0, violations = 0;
  const arr = layoutOf(-1, 0).scatter.outsideScatter;
  for (let i = 0; i < arr.length; i += SCATTER_STRIDE) {
    const fp = SCATTER_FOOTPRINT[SCATTER_TYPES[arr[i + 3]]]; if (!fp) continue;
    const [sx, sz] = [arr[i], arr[i + 2]];
    if (sx < -380 || sx > -20 || sz < 20 || sz > 380) continue; // 远离 region 边界，邻域 layout 齐全
    structures++;
    for (let x = sx - fp.halfX; x <= sx + fp.halfX; x++) for (let z = sz - fp.halfZ; z <= sz + fp.halfZ; z++) {
      const col = await colOf(Math.floor(x / 16), Math.floor(z / 16));
      const lx = x - col.cx * 16, lz = z - col.cz * 16;
      for (let y = WORLD_MIN_Y; y < WORLD_MAX_Y; y++) if (GIANT_IDS.has(col.blocks[blockIndex(lx, y, lz)])) violations++;
    }
  }
  assertTrue(structures >= 5, `region(-1,0) 内有足够多的撒布结构可测（对照）：${structures}`);
  assertEqual(violations, 0, '撒布结构 footprint 内不得有巨树方块');
});

test('真实 GEN：金字塔 / 平地岛 / 海岛 / 雪原 / 冰封山的地标范围内零巨树方块（对照：不排除时确有树会闯入）', async () => {
  // 在 region [-6,6]² 里取地标实例（独立于 pointContext：直接用 landmarks.js 的 getXxxInfo 判范围）。
  // 小地标（平地岛 / 海岛）取全部实例 —— 只取第一个会因种子巧合漏掉「树恰好只擦到 JSON 占地」的情形；
  // 大地标（金字塔 / 雪原 / 冰封山）各取第一个（冰封山单个就要扫 ~80 个 column）。
  const inst = { pyramid: [], island: [], plainLand: [], snowLand: [], frozenMountain: [] };
  for (let rx = -6; rx <= 6; rx++) for (let rz = -6; rz <= 6; rz++) {
    const l = layoutOf(rx, rz);
    if (!inst.pyramid.length) inst.pyramid.push({ l, c: [l.pyramid.cx, l.pyramid.cz], r: 60 });
    if (l.island) inst.island.push({ l, c: [l.island.cx, l.island.cz], r: 60 });
    if (l.plainLand) inst.plainLand.push({ l, c: [l.plainLand.cx, l.plainLand.cz], r: 30 });
    if (!inst.snowLand.length) inst.snowLand.push({ l, c: [l.snowLand.cx, l.snowLand.cz], r: 60 });
    if (!inst.frozenMountain.length) inst.frozenMountain.push({ l, c: [l.frozenMountain.cx, l.frozenMountain.cz], r: 110 });
  }
  const kinds = ['pyramid', 'island', 'plainLand', 'snowLand', 'frozenMountain'];
  const families = (await loadGiantTrees()).families;
  for (const k of kinds) assertTrue(inst[k].length > 0, `找到 ${k} 实例`);
  const inLandmark = (k, l, x, z) => ({
    pyramid: () => getPyramidInfo(x, z, l.pyramid), island: () => getIslandInfo(x, z, l.island, SEED),
    // 平地岛：沙台（±15）∪ pyramid_island.json 的占地（halfX17/halfZ20，比沙台大）—— 后者 pointContext 覆盖不到
    plainLand: () => getPlainLandInfo(x, z, l.plainLand) ||
      (Math.abs(x - l.plainLand.cx) <= CITY_STRUCTURE_FOOTPRINT.pyramidIsland.halfX && Math.abs(z - l.plainLand.cz) <= CITY_STRUCTURE_FOOTPRINT.pyramidIsland.halfZ),
    snowLand: () => getSnowLandInfo(x, z, l.snowLand, SEED),
    frozenMountain: () => getFrozenMountainInfo(x, z, l.frozenMountain, SEED),
  })[k]();
  let intruders = 0, violations = 0, scannedCells = 0;
  for (const k of kinds) for (const { l, c, r } of inst[k]) {
    for (let cx = Math.floor((c[0] - r) / 16); cx <= Math.floor((c[0] + r) / 16); cx++) {
      for (let cz = Math.floor((c[1] - r) / 16); cz <= Math.floor((c[1] + r) / 16); cz++) {
        const layouts = layoutsForColumn(cx, cz);
        const col = await genColumn(cx, cz, layouts);
        // 对照：不做任何排除时，会闯入该地标范围的树（用 allowedAt 全真 + 无外包盒收集，再按地标范围判）
        const win = { minX: cx * 16, maxX: cx * 16 + 15, minZ: cz * 16, maxZ: cz * 16 + 15 };
        for (const t of collectGiantTrees(layouts, SEED, families, win, 0)) {
          const mx = (t.x0 + t.x1) >> 1, mz = (t.z0 + t.z1) >> 1;
          if ([[t.x0, t.z0], [t.x1, t.z1], [mx, mz], [t.wx, t.wz]].some(([x, z]) => inLandmark(k, l, x, z))) intruders++;
        }
        for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
          if (!inLandmark(k, l, cx * 16 + lx, cz * 16 + lz)) continue;
          scannedCells++;
          for (let y = WORLD_MIN_Y; y < WORLD_MAX_Y; y++) if (GIANT_IDS.has(col.blocks[blockIndex(lx, y, lz)])) violations++;
        }
      }
    }
  }
  assertTrue(scannedCells > 5000, `扫描到足够多的地标格（对照）：${scannedCells}`);
  assertTrue(intruders > 0, `对照：不排除时确有树会闯入地标范围（${intruders}）—— 否则本用例无判别力`);
  assertEqual(violations, 0, '地标范围内不得有巨树方块');
});

test('真实 GEN：巨树覆盖区内零旧植被树方块，且基线（无巨树）里同位置确有旧树（互斥生效，带对照）', async () => {
  let baselineOld = 0, giantOld = 0, colsChecked = 0;
  for (const [cx, cz] of forestScanColumns(120)) {
    const layouts = layoutsForColumn(cx, cz);
    const col = await genColumn(cx, cz, layouts);
    if (countIds(col, GIANT_IDS) === 0) continue;
    colsChecked++;
    const base = await genColumn(cx, cz, stripGiants(layouts));
    for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
      let hasGiant = false;
      for (let y = WORLD_MIN_Y; y < WORLD_MAX_Y && !hasGiant; y++) hasGiant = GIANT_IDS.has(col.blocks[blockIndex(lx, y, lz)]);
      if (!hasGiant) continue;
      for (let y = WORLD_MIN_Y; y < WORLD_MAX_Y; y++) {
        if (OLD_TREE_IDS.has(base.blocks[blockIndex(lx, y, lz)])) baselineOld++;
        if (OLD_TREE_IDS.has(col.blocks[blockIndex(lx, y, lz)])) giantOld++;
      }
    }
  }
  assertTrue(colsChecked >= 10, `含巨树的 column ≥ 10：${colsChecked}`);
  assertTrue(baselineOld > 0, `对照：基线里巨树占地内有旧树方块（${baselineOld}），否则本用例无判别力`);
  assertEqual(giantOld, 0, '有巨树的列格上不得出现旧植被树方块');
});

test('真实 GEN：单格植物不顶掉巨树树干底格（植物判定命中的位置，底格仍是树干）', async () => {
  const families = (await loadGiantTrees()).families;
  const v = families.tallOak[0];
  const trunkId = reg.idOf(v.palette[0]);
  let tried = 0, checked = 0;
  // 在 region(-1,0) 森林里找一个「rollVegetation 会出植物」且在 column 内圈的点，放一棵合成树（锚点 = 该点）
  for (let wx = -300; wx < -100 && checked < 3; wx++) for (let wz = 100; wz < 300 && checked < 3; wz++) {
    const lx = ((wx % 16) + 16) % 16, lz = ((wz % 16) + 16) % 16;
    if (lx < 4 || lx > 11 || lz < 4 || lz > 11) continue;
    if (getBiome(wx, wz, SEED) !== 'FOREST') continue;
    const h = generateHeight(wx, wz, SEED); if (h <= SEA_Y) continue;
    if (!rollVegetation(wx, wz, 'FOREST', SEED).plant) continue;
    const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
    const base = layoutsForColumn(cx, cz);
    const synth = base.map((l) => ({ ...l, giantTrees: { forest: new Int32Array(0), beach: new Int32Array(0), banyan: new Int32Array(0) } }));
    const own = synth.findIndex((l) => l.regionX === Math.floor(wx / REGION_SIZE) && l.regionZ === Math.floor(wz / REGION_SIZE));
    synth[own].giantTrees.forest = Int32Array.from([wx, h + 1, wz, 0, 0]); // 族 0 = tallOak，hash 0 → 变体 0
    // 该合成树必须被 apply 层接受（否则无从断言）
    const win = { minX: cx * 16, maxX: cx * 16 + 15, minZ: cz * 16, maxZ: cz * 16 + 15 };
    const t = collectGiantTrees(synth, SEED, families, win, EXT)[0];
    if (!t || !isGiantTreeAllowed(t, giantAllowedAtFor(synth, cityLayout, SEED), collectExclusionBoxes(synth, win, EXT))) continue;
    tried++;
    const col = await genColumn(cx, cz, synth);
    assertEqual(col.blocks[blockIndex(wx - cx * 16, h + 1, wz - cz * 16)], trunkId, `(${wx},${wz}) 植物判定命中，但锚点底格必须仍是树干`);
    checked++;
  }
  assertTrue(checked >= 1, `至少核对 1 个「植物命中 + 合成树被接受」的位置（试了 ${tried}）`);
});

test('真实 GEN：确定性——同一 column 两次生成逐格一致', async () => {
  for (const [cx, cz] of [[-13, 12], [-20, 5]]) {
    const a = await genColumn(cx, cz), b = await genColumn(cx, cz);
    for (let i = 0; i < a.blocks.length; i++) { if (a.blocks[i] !== b.blocks[i]) { assertEqual(a.blocks[i], b.blocks[i], `column(${cx},${cz}) block ${i}`); break; } }
  }
});
