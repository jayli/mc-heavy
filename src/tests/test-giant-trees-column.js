// src/tests/test-giant-trees-column.js — 巨树景观 Tier 1：column 层（合并 / 排除 / 跨 column 光栅化 / 地基 / 覆盖窗口）
//
// 钉的缺陷：
//   · 邻域候选必须「拼接」而非「覆盖」（覆盖赋值 → 区域内只生成 0.3% 的树）
//   · 跨 column 光栅化逐格无缺漏（非正方形变体 × 4 朝向；Review Focus ①②）
//   · 悬空的树干底格要补地基（22% 的树基部悬空 ≥1 格）
//   · 旧植被覆盖窗口必须外扩 EXT（只覆盖本 column → 每 256 个 column 游离 5,332 格没有树干的旧树冠）
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse, assertNotNull, assertDeepEqual } from './assert.js';
import {
  GIANT_SUPPORT_MAX, loadGiantTrees, rotateCell, treeBox, collectGiantTrees, collectExclusionBoxes,
  isGiantTreeAllowed, rasterizeGiantTree, buildCoveredWindow, applyGiantTrees,
} from '../gen/structures/giant-trees.js';
import { generateHeight } from '../gen/terrain.js';
import { makeColumnSetter } from '../gen/structures/landmarks.js';
import { SCATTER_TYPES } from '../gen/structures/scatter.js';
import { SCATTER_FOOTPRINT, CITY_STRUCTURE_FOOTPRINT } from '../gen/structures/region-config.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { blockIndex, WORLD_MIN_Y } from '../voxel/constants.js';

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
function countIds(col, ids) { let n = 0; for (let i = 0; i < col.blocks.length; i++) if (ids.has(col.blocks[i])) n++; return n; }

/** 造一棵指定变体、朝向、锚点位置的树对象（与 resolveTree 的产出同形） */
function makeTree(variant, rot, wx, wy, wz) {
  return { path: 'forest', wx, wy, wz, variant, rot, ...treeBox(variant, rot, wx, wz) };
}

test('collectGiantTrees：合并全部邻域 layouts（拼接而非覆盖）+ 规范顺序（与 layouts 下发顺序无关）', async () => {
  const { families } = await loadGiantTrees();
  const mk = (wx, wz) => ({ giantTrees: { forest: Int32Array.from([wx, 30, wz, 0, 0]), beach: new Int32Array(0), banyan: new Int32Array(0) } });
  const layouts = [mk(0, 0), mk(100, 0), mk(200, 0)];
  const win = { minX: -50, maxX: 300, minZ: -50, maxZ: 50 };
  const a = collectGiantTrees(layouts, SEED, families, win, EXT);
  assertEqual(a.length, 3, '3 个 layout 各 1 棵 → 共 3 棵（覆盖赋值只会剩 1 棵）');
  const b = collectGiantTrees([...layouts].reverse(), SEED, families, win, EXT);
  assertDeepEqual(a.map((t) => [t.wx, t.wz]), b.map((t) => [t.wx, t.wz]), '顺序与 layouts 顺序无关');
});

test('isGiantTreeAllowed：九点/锚点任一不允许即拒；撒布外包盒相交即拒', async () => {
  const { families } = await loadGiantTrees();
  const v = families.cherry[0];
  const t = makeTree(v, 0, 100, 30, 100);
  assertTrue(isGiantTreeAllowed(t, () => true, []), '全允许、无撒布 → 通过');
  for (const [x, z] of [[t.x0, t.z0], [t.x1, t.z1], [(t.x0 + t.x1) >> 1, (t.z0 + t.z1) >> 1], [t.wx, t.wz]]) {
    assertFalse(isGiantTreeAllowed(t, (px, pz) => !(px === x && pz === z), []), `(${x},${z}) 不允许 → 拒`);
  }
  assertFalse(isGiantTreeAllowed(t, () => true, [{ x0: t.x1, x1: t.x1 + 5, z0: t.z0, z1: t.z1 }]), '撒布盒与 AABB 相交（共享一列）→ 拒');
  assertTrue(isGiantTreeAllowed(t, () => true, [{ x0: t.x1 + 1, x1: t.x1 + 5, z0: t.z0, z1: t.z1 }]), '撒布盒紧贴但不相交 → 通过');
});

test('collectExclusionBoxes：撒布 +1、平地金字塔岛 JSON 占地（halfX17/halfZ20）+2、海岛塔 +2；窗口外的不收', () => {
  const house = SCATTER_TYPES.indexOf('house');
  const layouts = [{
    plainLand: { cx: 100, cz: 100 }, island: { cx: 300, cz: 100 },
    scatter: { outsideScatter: Int32Array.from([50, 20, 60, house, 102, 20, 100, house]) },
  }];
  assertEqual(collectExclusionBoxes(layouts, { minX: -400, maxX: -385, minZ: 0, maxZ: 15 }, EXT).length, 0, '全都在窗口 24+ext 格之外 → 一个都不收');
  const boxes = collectExclusionBoxes(layouts, { minX: 90, maxX: 105, minZ: 90, maxZ: 105 }, EXT);
  const pi = CITY_STRUCTURE_FOOTPRINT.pyramidIsland, hs = SCATTER_FOOTPRINT.house;
  assertTrue(boxes.some((b) => b.x0 === 100 - pi.halfX - 2 && b.x1 === 100 + pi.halfX + 2 && b.z0 === 100 - pi.halfZ - 2 && b.z1 === 100 + pi.halfZ + 2),
    '平地金字塔岛占地盒 = footprint + 2（比 getPlainLandInfo 的 ±15 沙台大）');
  assertTrue(boxes.some((b) => b.x0 === 102 - hs.halfX - 1 && b.x1 === 102 + hs.halfX + 1 && b.z0 === 100 - hs.halfZ - 1), 'house 撒布盒 = footprint + 1');
  assertEqual(boxes.length, 2, '海岛塔(300,100)与远处 house(50,60) 都不在窗口附近');
});

test('跨 column 光栅化：4 个朝向 × 含非正方形变体，2×2 个 column 逐格 == 期望（双向：无缺格、无多格）', async () => {
  const { families } = await loadGiantTrees();
  const nonSquare = families.tallOak.find((v) => v.w !== v.d);
  assertNotNull(nonSquare, '存在非正方形变体（Review Focus ②）');
  for (const v of [families.cherry[0], nonSquare]) {
    for (let rot = 0; rot < 4; rot++) {
      // 锚点放在 4 个 column 的交点（世界坐标 (16,16)）；WY=56：树顶 ≤ 56+42 < WORLD_MAX_Y，不被世界高度裁剪；
      // 地表 h ≤ 16 → 地基深度 ≥ 38 > GIANT_SUPPORT_MAX，不产生额外方块
      const WY = 56;
      const t = makeTree(v, rot, 16, WY, 16);
      const cols = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([cx, cz]) => new ChunkColumn(cx, cz));
      for (const c of cols) rasterizeGiantTree(makeColumnSetter(c, reg), t, SEED);
      // 期望：独立展开变体全部格
      const want = new Map();
      for (let k = 0; k < v.cells.length; k += 4) {
        const [rx, rz] = rotateCell(v, rot, v.cells[k], v.cells[k + 2]);
        want.set(`${t.x0 + rx},${WY + v.cells[k + 1]},${t.z0 + rz}`, reg.idOf(v.palette[v.cells[k + 3]]));
      }
      let written = 0, mismatched = 0;
      for (const c of cols) for (let ly = 0; ly < 128; ly++) for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
        const id = c.blocks[blockIndex(lx, ly + WORLD_MIN_Y, lz)];
        if (id === 0) continue;
        written++;
        if (want.get(`${c.cx * 16 + lx},${ly + WORLD_MIN_Y},${c.cz * 16 + lz}`) !== id) mismatched++;
      }
      // 期望格都落在这 4 个 column 的范围内（锚点在交点附近，树宽 ≤ 17）
      let expectedInRange = 0;
      for (const k of want.keys()) { const [x, , z] = k.split(',').map(Number); if (x >= 0 && x < 32 && z >= 0 && z < 32) expectedInRange++; }
      assertEqual(expectedInRange, want.size, `rot=${rot} 树的全部格都在 4 个 column 内（否则本用例无判别力）`);
      assertEqual(mismatched, 0, `rot=${rot} ${v.w}×${v.d}：写入的方块都等于期望`);
      assertEqual(written, want.size, `rot=${rot} ${v.w}×${v.d}：写入格数 == 变体格数（AABB 裁剪未丢格）`);
    }
  }
});

test('地基：gy=0 树干格下方悬空 1~MAX 格时补同种树干；悬空 > MAX 不补', async () => {
  const { families } = await loadGiantTrees();
  const v = families.tallOak[0]; // gy=0 层只有 1 个树干格
  const [wx, wz] = [40, 40]; const h = generateHeight(wx, wz, SEED);
  const trunkName = v.palette[0];
  for (const [hang, expectFill] of [[3, true], [GIANT_SUPPORT_MAX, true], [GIANT_SUPPORT_MAX + 1, false]]) {
    const c = new ChunkColumn(2, 2); // 世界 x,z ∈ [32,48)
    const t = makeTree(v, 0, wx, h + 1 + hang, wz);
    rasterizeGiantTree(makeColumnSetter(c, reg), t, SEED);
    const id = reg.idOf(trunkName);
    for (let y = h + 1; y < h + 1 + hang; y++) {
      assertEqual(c.blocks[blockIndex(wx - 32, y, wz - 32)] === id, expectFill, `悬空 ${hang} 格：y=${y} ${expectFill ? '应补' : '不应补'}树干`);
    }
    assertEqual(c.blocks[blockIndex(wx - 32, h + 1 + hang, wz - 32)], id, '锚点树干格本身在');
  }
});

test('覆盖窗口：AABB 外扩 EXT；column 外 EXT 格带内也覆盖；窗口外恒 false', async () => {
  const { families } = await loadGiantTrees();
  const v = families.palm[1]; // 11×11
  const col = new ChunkColumn(0, 0);
  const t0 = makeTree(v, 0, 8, 40, 8);
  const t = makeTree(v, 0, 8 + (15 - t0.x1), 40, 8); // AABB 东边界贴着 column 的 x=15
  assertEqual(t.x1, 15);
  const cw = buildCoveredWindow(col, [t], EXT);
  assertTrue(cw.covers(t.x0, t.z0), 'AABB 角落被覆盖');
  assertTrue(cw.covers(t.x0 - EXT, t.z0), 'AABB 外扩 EXT 仍覆盖');
  assertFalse(cw.covers(t.x0 - EXT - 1, t.z0), '再外一格不覆盖');
  assertTrue(cw.covers(15 + EXT, t.z0), 'column 外 EXT 格带内也覆盖（旧树树干在带内时其树冠会写进本 column）');
  assertFalse(cw.covers(15 + EXT + 1, t.z0), '窗口外恒 false（东）');
  assertFalse(cw.covers(-EXT - 1, 0), '窗口外恒 false（西）');
  assertFalse(buildCoveredWindow(col, [], EXT).covers(8, 8), '无树 → 不覆盖');
});

test('applyGiantTrees（合成场景）：允许 → 写入方块并返回覆盖；不允许 → 零方块、不覆盖', async () => {
  await loadGiantTrees(); // applyGiantTrees 读模块缓存（getGiantTreesSync），须先加载
  const mkLayouts = () => [{ giantTrees: { forest: Int32Array.from([8, 56, 8, 0, 0]), beach: new Int32Array(0), banyan: new Int32Array(0) } }];
  const a = new ChunkColumn(0, 0);
  const ca = applyGiantTrees(a, mkLayouts(), SEED, reg, { allowedAt: () => true, ext: EXT });
  assertTrue(countIds(a, GIANT_IDS) > 0, '允许 → 有巨树方块');
  assertTrue(ca.covers(8, 8), '允许 → 锚点被覆盖');
  const b = new ChunkColumn(0, 0);
  const cb = applyGiantTrees(b, mkLayouts(), SEED, reg, { allowedAt: () => false, ext: EXT });
  assertEqual(countIds(b, GIANT_IDS), 0, '不允许 → 零巨树方块');
  assertFalse(cb.covers(8, 8), '不允许 → 不覆盖（旧树照常生成）');
});
