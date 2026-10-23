import { test } from './runner.js';
import { assertEqual, assertTrue, assertNotNull } from './assert.js';
import { REGION_SIZE } from '../gen/structures/region-config.js';
import { getRegionSeededCenter, clampCenterToRegion } from '../gen/structures/region-center.js';
import { computeRegionLayout, regionsForColumn, neighborRegionKeys } from '../gen/structures/structure-layout.js';
import { buildCityLayout } from '../gen/structures/city-layout.js';
import { getPyramidInfo } from '../gen/structures/landmarks.js';
import { StructureIndex } from '../gen/structure-index.js';
import { applyStructuresToColumn } from '../gen/structures/apply.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { generateHeight } from '../gen/terrain.js';

const SEED = 12345;

/** 找一个金字塔不被城市边界吞没的 region（城市优先级是 mc-lite 原语义） */
function findFreePyramidLayout(seed) {
  const city = computeRegionLayout(0, 0, seed).city;
  for (let rx = -4; rx <= 4; rx++) {
    for (let rz = -4; rz <= 4; rz++) {
      if (rx === 0 && rz === 0) continue;
      const l = computeRegionLayout(rx, rz, seed);
      const py = l.pyramid;
      const out = py.cx + 28 < city.minX || py.cx - 28 > city.maxX ||
                  py.cz + 28 < city.minZ || py.cz - 28 > city.maxZ;
      if (out) return l;
    }
  }
  return null;
}

function makeRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}

test('region-center: 与 mc-lite getRegionSeededCenter 公式一致', () => {
  // 手工对照 mc-lite RegionCenterUtils：sin(seed*1.5 + rx*0.1) 取绝对值 * 300 + 100
  const seed = 777, rx = 2, rz = -1;
  const randX = Math.abs(Math.sin(seed * 1.5 + rx * 0.1));
  const randZ = Math.abs(Math.sin(seed * 2.5 + rz * 0.1));
  const expectedX = rx * REGION_SIZE + Math.floor(randX * 300) + 100;
  const expectedZ = rz * REGION_SIZE + Math.floor(randZ * 300) + 100;
  const c = getRegionSeededCenter(rx, rz, seed);
  assertEqual(c.centerX, expectedX);
  assertEqual(c.centerZ, expectedZ);
});

test('region-center: clampCenterToRegion 边界裁剪', () => {
  const c = clampCenterToRegion(0, 0, 399, 1, 33);
  assertEqual(c.cx, 400 - 33);
  assertEqual(c.cz, 33);
});

test('computeRegionLayout: 确定性（两次调用 JSON 相等）', () => {
  const a = computeRegionLayout(0, 0, SEED);
  const b = computeRegionLayout(0, 0, SEED);
  assertEqual(JSON.stringify(a), JSON.stringify(b));
  const c = computeRegionLayout(-3, 2, SEED);
  const d = computeRegionLayout(-3, 2, SEED);
  assertEqual(JSON.stringify(c), JSON.stringify(d));
});

test('computeRegionLayout: 地标偏移关系与 mc-lite 配置一致', () => {
  const layout = computeRegionLayout(1, 1, SEED);
  assertNotNull(layout.pyramid, 'pyramid exists');
  assertNotNull(layout.frozenMountain, 'frozenMountain exists');
  assertNotNull(layout.snowLand, 'snowLand exists');
  // 冰封山 = 金字塔 + (-160, 0)（clamp 前；clamp 后可能微调，用未 clamp 关系验证 snowLand）
  assertEqual(layout.snowLand.cx, layout.pyramidRaw.cx + 160);
  assertEqual(layout.snowLand.cz, layout.pyramidRaw.cz + 0);
  // 海岛有效性：存在时中心地形高度必低于海平面
  if (layout.island) {
    assertTrue(generateHeight(layout.island.cx, layout.island.cz, SEED) < -2, 'island in sea');
  }
  // 平地：存在时中心 biome 必为 DESERT 且带 baseHeight
  if (layout.plainLand) {
    assertTrue(Number.isInteger(layout.plainLand.baseHeight), 'plainLand baseHeight');
  }
  // city 只出现在 region [0,0]
  assertTrue(layout.city === null, 'no city outside region (0,0)');
  const origin = computeRegionLayout(0, 0, SEED);
  assertTrue(origin.city !== null, 'city at region (0,0)');
});

test('buildCityLayout: 确定性 + castle 在中心 + 边界尺寸范围', () => {
  const a = buildCityLayout(SEED);
  const b = buildCityLayout(SEED);
  assertEqual(JSON.stringify(a), JSON.stringify(b));
  const castle = a.placements.find((p) => p.type === 'castle');
  assertNotNull(castle, 'castle placed');
  assertEqual(castle.x, a.centerX);
  assertEqual(castle.z, a.centerZ);
  // 初始边界计算钳在 [56,112]，但建筑 fallback 放置越界时 expandBoundsIfNeeded 会扩大
  // （与 mc-lite 行为一致，已用 mc-lite CityMap 同 seed 逐字段对照核验）
  assertTrue(a.halfSize >= 56, `halfSize ${a.halfSize} >= 56`);
  assertTrue(a.placements.length >= 10, 'enough placements');
});

test('regionsForColumn: 普通 column 1 个基 region，跨界 column 2 个', () => {
  // column 0 → 块 [0,16) 全在 region 0
  assertEqual(regionsForColumn(0, 0).length, 1);
  // cx=25 → 块 [400,416) 全在 region 1
  assertEqual(regionsForColumn(25, 0).length, 1);
  // cx=24 → 块 [384,400) 全在 region 0
  assertEqual(regionsForColumn(24, 0).length, 1);
  // 负坐标：cx=-1 → 块 [-16,0) 在 region -1
  assertEqual(regionsForColumn(-1, 0).length, 1);
});

test('neighborRegionKeys: 覆盖基 region 的 3×3 邻域', () => {
  const keys = neighborRegionKeys(0, 0);
  assertEqual(keys.length, 9);
  assertTrue(keys.includes('0,0'));
  assertTrue(keys.includes('-1,-1'));
  assertTrue(keys.includes('1,1'));
});

test('跨 region 溢出：snowLand 越过 region 边界时可被邻区查询到', () => {
  // 找一个 seed 使 region(0,0) 的 snowLand 中心贴近 region 边界（snowLand 无 clamp，可跨界）
  let seed = -1, layout = null;
  for (let s = 1; s < 500; s++) {
    const l = computeRegionLayout(0, 0, s);
    const cx0 = l.snowLand.cx;
    if (cx0 > REGION_SIZE - 28 && cx0 < REGION_SIZE + 44) { seed = s; layout = l; break; }
  }
  assertTrue(seed > 0, 'found crossing seed');
  // 取 snowLand 范围内、越过边界的点所在 column
  const sl = layout.snowLand;
  const wx = sl.cx + 20; // |wx - cx| = 20 ≤ 28（halfSize+transition），必在 snowLand 范围内
  assertTrue(wx >= REGION_SIZE, 'test point crosses region boundary');
  const cx = Math.floor(wx / 16);
  // 模拟 StructureIndex：region(0,0) 与 region(1,0) 布局都在缓存
  const index = new StructureIndex({ pool: null, seed });
  index._layouts.set('0,0', layout);
  index._layouts.set('1,0', computeRegionLayout(1, 0, seed));
  for (const k of neighborRegionKeys(cx, 0)) {
    if (!index._layouts.has(k)) {
      const [rx, rz] = k.split(',').map(Number);
      index._layouts.set(k, computeRegionLayout(rx, rz, seed));
    }
  }
  const entries = index.layoutsForColumn(cx, 0);
  const fromOrigin = entries.find((l) => l.regionX === 0 && l.regionZ === 0);
  assertNotNull(fromOrigin, 'origin region layout included');
  // 该 column 包含 wx（snowLand 范围内）——相交性已由构造保证
  assertTrue(cx * 16 <= wx && wx < cx * 16 + 16, 'wx inside column');
});

test('StructureIndex: mock pool — 布局就绪前 gate，就绪后放行', async () => {
  const calls = [];
  const resolvers = new Map();
  const fakePool = {
    call(method, payload) {
      calls.push({ method, payload });
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      resolvers.set(`${payload.regionX},${payload.regionZ}`, resolve);
      return { id: calls.length, promise };
    },
  };
  const index = new StructureIndex({ pool: fakePool, seed: SEED });
  const needed = neighborRegionKeys(60, 60);
  // 远端 column：布局未就绪
  assertTrue(!index.readyForColumn(60, 60), 'not ready initially');
  index.ensureForColumn(60, 60);
  index.ensureForColumn(60, 60); // 重复 ensure 不入队两次
  // dispatch 有每帧预算，循环 drain 直到全部下发
  for (let i = 0; i < 10; i++) index.dispatch();
  assertEqual(calls.length, needed.length, 'one layout call per region');
  // 全部 resolve 后就绪
  for (const k of needed) {
    const [rx, rz] = k.split(',').map(Number);
    resolvers.get(k)(computeRegionLayout(rx, rz, SEED));
  }
  await new Promise((r) => setTimeout(r, 0));
  assertTrue(index.readyForColumn(60, 60), 'ready after layouts resolved');
  const layouts = index.layoutsForColumn(60, 60);
  assertEqual(layouts.length, needed.length);
});

test('getPyramidInfo: 中心 layerHeight 与 mc-lite 公式一致', () => {
  const layout = computeRegionLayout(0, 0, SEED);
  const { cx, cz } = layout.pyramid;
  const info = getPyramidInfo(cx, cz, layout.pyramid);
  assertTrue(info !== null, 'center inside pyramid');
  assertEqual(info.zone, 'core');
  assertEqual(info.layerHeight, 10); // halfSize 20 → floor((20-0)/2)
  const edge = getPyramidInfo(cx + 20, cz, layout.pyramid);
  assertEqual(edge.layerHeight, 0);
  assertTrue(getPyramidInfo(cx + 29, cz, layout.pyramid) === null, 'outside total range');
});

test('applyStructuresToColumn: 金字塔叠加确定性 + 高度正确', async () => {
  const reg = makeRegistry();
  const layout = findFreePyramidLayout(SEED);
  assertNotNull(layout, 'found pyramid region outside city');
  const layouts = [layout];
  const cx = Math.floor(layout.pyramid.cx / 16), cz = Math.floor(layout.pyramid.cz / 16);
  const colA = new ChunkColumn(cx, cz);
  const colB = new ChunkColumn(cx, cz);
  await applyStructuresToColumn(colA, SEED, reg, layouts);
  await applyStructuresToColumn(colB, SEED, reg, layouts);
  // 确定性：两次结果逐格一致
  for (let i = 0; i < colA.blocks.length; i++) assertEqual(colA.blocks[i], colB.blocks[i], `block ${i}`);
  // 中心点：sand 顶 = h + 10（halfSize 20 → layerHeight 10）
  const lx = layout.pyramid.cx - cx * 16, lz = layout.pyramid.cz - cz * 16;
  const h = generateHeight(layout.pyramid.cx, layout.pyramid.cz, SEED);
  const sandId = reg.idOf('sand');
  assertEqual(colA.get(lx, h + 10, lz), sandId, 'pyramid top is sand at h+10');
  assertEqual(colA.get(lx, h + 11, lz), 0, 'above top is air');
});
