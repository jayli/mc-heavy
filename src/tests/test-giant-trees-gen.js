// src/tests/test-giant-trees-gen.js — 巨树景观 Tier 1：接线与真实 GEN（layout 字段 / 让路 / 旧植被互斥 / 植物规则 / 确定性）
//
// 全部走真实 layout + 真实 GEN 路径（fillColumn → applyStructuresToColumn），不靠合成捷径。
// 钉的缺陷：城市 / 地标 / 撒布结构让路（原设计 16% 的树进城、12.4% 压地标、9.4% 压撒布结构）；
//   单格植物不得顶掉树干底格；GEN 侧「拼接合并」没接线时森林 column 里几乎没有巨树。
// 每条「零闯入」断言都带「不排除时确有树会闯入」的对照（防恒真）。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertNotNull } from './assert.js';
import {
  GIANT_STRIDE, GIANT_SUPPORT_MAX, loadGiantTrees, rotateCell, collectGiantTrees, collectExclusionBoxes, isGiantTreeAllowed,
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
/**
 * 「巨树方块」的识别口径（2026-11-14 修正）。
 *
 * ⚠️ **旧口径是「方块名前缀是 `giant_`」—— 那个代理判据从树叶混表上线起就失效了**：
 * 普通矮树/高树现在会写 `giant_oak_leaves` 等四种叶（用户要「树叶丰富」），于是「城市里出现
 * giant_ 前缀的格」不再意味着「巨树入侵」—— 实测该误报把本文件 5 条断言同时打红
 *（城市 45 格 / 撒布 331 格 / 地标 221 格 / 互斥 1668 格），而真正的巨树让路一行没变。
 *
 * 新口径 = **差分归属**：同 column 跑两遍 GEN —— 一遍正常、一遍 `stripGiants`（只将
 * `layout.giantTrees` 置 null，其余全同），**只读生产产出**（不重算 `isGiantTreeAllowed`），
 * 两遍之间有差异的格就是巨树写的格。
 *
 * ⚠️ 为何不用「测试侧重算判据」：那样注入「删掉 `isGiantTreeAllowed` 过滤」时测试会跟着
 * 一起变（自己证明自己）—— 实测负向验证下三条断言仍全绿。差分法的对照严格只差一个变量。
 */
const GIANT_IDS = new Set(BLOCKS.filter((b) => b.name.startsWith('giant_')).map((b) => reg.idOf(b.name)));

/**
 * 差分归属：返回一个 column 里**巨树自己写进的格**（局部坐标键 `lx,y,lz`）。
 *
 * 判据 = 「正常运行 ≠ `stripGiants` 运行」**且**「该格在正常运行下是 `giant_*` 方块」。
 *
 * ⚠️ 两个条件缺一不可（实测踩过）：
 *   · 只取差分会把「**被巨树覆盖窗口抑制掉的旧树格**」也算进来（差异有两个方向，
 *     旧树格在 `withGiants` 里是空气 —— 那才是 `stripGiants` 对照的真正用途），
 *     实测这使地标断言误报 33 格、撒布误报 8 格；
 *   · 只取 `giant_*` 前缀会把**普通树的混表叶**算进来（2026-11-14 树叶混表上线后失效，
 *     实测误报城市 45 / 撒布 331 / 地标 221 / 互斥 1668）。
 * 交集的大小恰好是「巨树写的格」：普通树的 `giant_*_leaves` 不受 `stripGiants` 影响（不在差分里），
 * 被抑制的旧树格不是 `giant_*` 方块。
 *
 * @param {number} cx @param {number} cz
 * @returns {Promise<Set<string>>}
 */
async function giantOwnedCells(cx, cz) {
  const layouts = layoutsForColumn(cx, cz);
  const withGiants = await genColumn(cx, cz, layouts);
  const without = await genColumn(cx, cz, stripGiants(layouts));
  const owned = new Set();
  for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
    for (let y = WORLD_MIN_Y; y < WORLD_MAX_Y; y++) {
      const i = blockIndex(lx, y, lz);
      if (withGiants.blocks[i] !== without.blocks[i] && GIANT_IDS.has(withGiants.blocks[i])) owned.add(`${lx},${y},${lz}`);
    }
  }
  return owned;
}
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

/**
 * accepted 里的树落在本 column 内的格数（含主格与地基填充桩）。
 *
 * ⚠️ 地基桩必须算进来（2026-11-14 修）：`rasterizeGiantTree` 在 gy=0 树干格悬空时会向下补
 * 同种树干（≤ `GIANT_SUPPORT_MAX` 格），那些格也是巨树写的；漏算会在「树锚点在本列、但主格
 * 被 WORLD_MIN_Y 裁掉」的边缘列上造成「期望 false / 实际 true」。
 *
 * ⚠️ **搜索域必须比本 column 外扩 `EXT`**（2026-11-14 修，实测踩到列(-15,12)）：
 * `applyGiantTrees` 的候选窗口是**本 column**，但 `collectGiantTrees(…, win, ext)` 会把
 * 「AABB 与窗口相交」的邻列树一并纳入（AABB 直径可达 15 格）。只按本 column 收候选会漏掉
 * 「锚点在邻列、树冠伸进本列」的树 —— 那种树写进的格照样是巨树格，差分判据能看见，
 * 本展开看不见，于是出现「期望 false / 实际 true」。
 *
 * @param {Array<Object>} accepted **外扩 `EXT` 后**的树
 * @param {number} cx @param {number} cz
 */
function expectedCellsInColumn(accepted, cx, cz) {
  let n = 0;
  const inCol = (x, z) => x >= cx * 16 && x < cx * 16 + 16 && z >= cz * 16 && z < cz * 16 + 16;
  for (const t of accepted) {
    const v = t.variant;
    for (let k = 0; k < v.cells.length; k += 4) {
      const [rx, rz] = rotateCell(v, t.rot, v.cells[k], v.cells[k + 2]);
      const x = t.x0 + rx, z = t.z0 + rz, y = t.wy + v.cells[k + 1];
      if (!inCol(x, z)) continue;
      if (y >= WORLD_MIN_Y && y < WORLD_MAX_Y) n++;
      if (v.cells[k + 1] === 0 && v.cells[k + 3] === 0) {
        const depth = (t.wy - 1) - generateHeight(x, z, SEED);
        if (depth >= 1 && depth <= GIANT_SUPPORT_MAX) {
          for (let yy = t.wy - 1; yy > t.wy - 1 - depth; yy--) if (yy >= WORLD_MIN_Y && yy < WORLD_MAX_Y) n++;
        }
      }
    }
  }
  return n;
}

test('真实 GEN：巨树该落的 column 必须真的长出来（拼接合并 + 排除接线回归）', async () => {
  const families = (await loadGiantTrees()).families;
  let expectedWith = 0, missing = 0, extra = 0;
  for (const [cx, cz] of forestScanColumns(150)) {
    const layouts = layoutsForColumn(cx, cz);
    const win = { minX: cx * 16, maxX: cx * 16 + 15, minZ: cz * 16, maxZ: cz * 16 + 15 };
    const allowedAt = giantAllowedAtFor(layouts, cityLayout, SEED);
    const boxes = collectExclusionBoxes(layouts, win, EXT);
    // 期望展开必须用**外扩 EXT 的窗口**收候选（AABB 直径可达 15 格：邻列树的树冠会伸进本列）
    const candWin = { minX: win.minX - EXT, maxX: win.maxX + EXT, minZ: win.minZ - EXT, maxZ: win.maxZ + EXT };
    const forExpected = collectGiantTrees(layouts, SEED, families, candWin, EXT).filter((t) => isGiantTreeAllowed(t, allowedAt, boxes));
    const expected = expectedCellsInColumn(forExpected, cx, cz) > 0;
    const has = (await giantOwnedCells(cx, cz)).size > 0;
    if (expected) expectedWith++;
    // 判据是**单向**：期望有巨树的列必须真的有（本用例钉的是「拼接合并没接线 / 排除接线漏了」
    // 这类**遗漏**，不是「多出来」）。
    //
    // ⚠️ 为何不写成双向等价（曾是双向，2026-11-14 改为单向）：差分归属有固有假阳性 ——
    // 实测列(-15,12)：巨树的覆盖窗口抑制了普通树 C，于是更早写的普通树 D（混表叶
    // `giant_banyan_leaves`）留了下来；无巨树时 C 存在并后写盖成 `leaves`。那 7 格**从来不是
    // 巨树写的**，但在「差异 ∧ giant_ 前缀」里无法与真巨树格区分（两棵普通树的胜负被巨树改变了）。
    // 「实际多出期望」的反向检测由本文件其余四条更精确的断言（城市/撒布/地标/互斥）覆盖。
    if (expected && !has) missing++;
    if (!expected && has) extra++;
  }
  assertTrue(expectedWith >= 20, `扫描域内期望含巨树的 column ≥ 20（对照，防恒真；实测 ~60）：${expectedWith}`);
  assertEqual(missing, 0, `期望含巨树的 column 必须真的长出来（遗漏 ${missing} 列；反向噪声 ${extra} 列，见注释）`);
});

test('真实 GEN：森林 column 里确有巨树方块（覆盖赋值的回归：原写法 625 个 column 只会出 1 棵）', async () => {
  let found = 0, tested = 0;
  for (const [cx, cz] of forestScanColumns(200)) {
    const col = await genColumn(cx, cz); tested++;
    // 差分归属：与 stripGiants 基线的差异格
    const owned = await giantOwnedCells(cx, cz);
    if ([...owned].some((k) => {
      const [lx, y, lz] = k.split(',').map(Number);
      return GIANT_IDS.has(col.blocks[blockIndex(lx, y, lz)]);
    })) found++;
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
      // 差分归属：普通树写的 giant_ 叶不参与本断言（旧前缀口径会误报，见 GIANT_IDS 注释）
      for (const k of await giantOwnedCells(cx, cz)) {
        const [lx, y, lz] = k.split(',').map(Number);
        void y;
        total++;
        if (getCityInfo(x0 + lx, z0 + lz, cityLayout)) inside++;
      }
    }
  }
  assertTrue(total > 0, `城外环带里有巨树方块（对照，防恒真）：${total}`);
  assertEqual(inside, 0, '城市 bounds 内不得有巨树方块');
});

test('真实 GEN：撒布结构 footprint 内零巨树方块（树让路；原设计 9.4% 的树压撒布结构）', async () => {
  /** column → 差分归属格集合（缓存，避免同一列跑四遍 GEN） */
  const ownedCache = new Map();
  const ownedOf = async (cx, cz) => {
    const k = `${cx},${cz}`;
    if (!ownedCache.has(k)) ownedCache.set(k, await giantOwnedCells(cx, cz));
    return ownedCache.get(k);
  };
  let structures = 0, violations = 0;
  const arr = layoutOf(-1, 0).scatter.outsideScatter;
  for (let i = 0; i < arr.length; i += SCATTER_STRIDE) {
    const fp = SCATTER_FOOTPRINT[SCATTER_TYPES[arr[i + 3]]]; if (!fp) continue;
    const [sx, sz] = [arr[i], arr[i + 2]];
    if (sx < -380 || sx > -20 || sz < 20 || sz > 380) continue; // 远离 region 边界，邻域 layout 齐全
    structures++;
    for (let x = sx - fp.halfX; x <= sx + fp.halfX; x++) for (let z = sz - fp.halfZ; z <= sz + fp.halfZ; z++) {
      const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
      const lx = x - cx * 16, lz = z - cz * 16;
      for (const k of await ownedOf(cx, cz)) {
        const [klx, , klz] = k.split(',').map(Number);
        if (klx === lx && klz === lz) violations++;
      }
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
    // ⚠️ **必须判 null**：高台地带（Task 3）把地带 region 的 `pyramid` / `frozenMountain`
    // 压成 null。当前 seed 下扫到的第一个 region(-6,-6) 恰好不是地带 region 所以没崩，
    // 但改 `TARN_ZONE_CHANCE` / 换 seed 就会踩到。`snowLand` 不用判（字段常驻）。
    if (!inst.pyramid.length && l.pyramid) inst.pyramid.push({ l, c: [l.pyramid.cx, l.pyramid.cz], r: 60 });
    if (l.island) inst.island.push({ l, c: [l.island.cx, l.island.cz], r: 60 });
    if (l.plainLand) inst.plainLand.push({ l, c: [l.plainLand.cx, l.plainLand.cz], r: 30 });
    if (!inst.snowLand.length) inst.snowLand.push({ l, c: [l.snowLand.cx, l.snowLand.cz], r: 60 });
    if (!inst.frozenMountain.length && l.frozenMountain) inst.frozenMountain.push({ l, c: [l.frozenMountain.cx, l.frozenMountain.cz], r: 110 });
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
        // 对照：不做任何排除时，会闯入该地标范围的树（用 allowedAt 全真 + 无外包盒收集，再按地标范围判）
        const win = { minX: cx * 16, maxX: cx * 16 + 15, minZ: cz * 16, maxZ: cz * 16 + 15 };
        for (const t of collectGiantTrees(layouts, SEED, families, win, 0)) {
          const mx = (t.x0 + t.x1) >> 1, mz = (t.z0 + t.z1) >> 1;
          if ([[t.x0, t.z0], [t.x1, t.z1], [mx, mz], [t.wx, t.wz]].some(([x, z]) => inLandmark(k, l, x, z))) intruders++;
        }
        // 差分归属：与 `stripGiants` 基线的差异格（只读生产产出，不在这里重算判据）
        const giantOwned = await giantOwnedCells(cx, cz);
        for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
          if (!inLandmark(k, l, cx * 16 + lx, cz * 16 + lz)) continue;
          scannedCells++;
          // 精确归属：同样地标范围内、但**不是巨树写的** giant_ 叶（普通树的混表产物）不计入
          for (const key of giantOwned) {
            const [gx, , gz] = key.split(',').map(Number);
            if (gx === lx && gz === lz) { violations++; break; }
          }
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
    // 差分归属：巨树自己写的格（同时给出「本列有巨树」这个事实，不需要旧前缀口径）
    const owned = await giantOwnedCells(cx, cz);
    if (owned.size === 0) continue;
    const col = await genColumn(cx, cz, layouts);
    colsChecked++;
    const base = await genColumn(cx, cz, stripGiants(layouts));
    for (const key of owned) {
      const [lx, y, lz] = key.split(',').map(Number);
      const i = blockIndex(lx, y, lz);
      if (OLD_TREE_IDS.has(base.blocks[i])) baselineOld++;
      if (OLD_TREE_IDS.has(col.blocks[i])) giantOld++;
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
