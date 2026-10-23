// RedCity 全局下发（Tier 1）：redCity 不走 3×3 查询域——越界 seed 的远端 column 仍拿得到；未就绪不下发
import { test } from './runner.js';
import { assertEqual, assertTrue, assertDeepEqual, assertNull, assertNotNull } from './assert.js';
import { computeRegionLayout, neighborRegionKeys } from '../gen/structures/structure-layout.js';
import { StructureIndex } from '../gen/structure-index.js';
import { buildRedCityLayout } from '../gen/structures/redcity-layout.js';
import { Scheduler } from '../core/scheduler.js';
import { WorldData } from '../voxel/world-data.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';

const SEED = 12345;                  // 影响域 x 到 864 > 799：区间外的 column 看不到 region(0,0) 的 3×3 查询域
function makeRegistry() { const reg = createRegistry(); for (const d of BLOCKS) reg.register(d.name, d); reg.freeze(); return reg; }
/** 把某 column 的 3×3 查询域 + (0,0) 的布局全部预置进 index（不经 Worker） */
function seedIndex(index, cx, cz, { withGlobal = true } = {}) {
  for (const k of neighborRegionKeys(cx, cz)) { const [rx, rz] = k.split(',').map(Number); index._layouts.set(k, computeRegionLayout(rx, rz, SEED)); }
  if (withGlobal && !index._layouts.has('0,0')) index._layouts.set('0,0', computeRegionLayout(0, 0, SEED));
}

test('越界投递：影响域 x>799 的远端 column 的 3×3 查询域不含 (0,0)，但 redCity() 仍给得出且几何覆盖该 column', () => {
  const index = new StructureIndex({ pool: null, seed: SEED });
  const cx = 53, cz = 6;                                            // 世界 x∈[848,863] z∈[96,111]
  seedIndex(index, cx, cz);
  const keys = neighborRegionKeys(cx, cz);
  assertTrue(!keys.includes('0,0'), '前提：该 column 的 3×3 查询域不含 region(0,0)');
  assertTrue(!index.layoutsForColumn(cx, cz).some((l) => l.regionX === 0 && l.regionZ === 0), 'layouts 里没有 (0,0) 的布局 → 旧口径下它拿不到 redCity');
  const rc = index.redCity();
  assertNotNull(rc, '全局下发：redCity() 与查询域无关');
  assertTrue(rc.influence.maxX >= cx * 16 + 15 && rc.influence.minX <= cx * 16, 'influence 覆盖该 column（x>799 的部分没有被截成直边）');
  assertTrue(rc.influence.maxX > 799, '前提：本 seed 的影响域确实越过了 3×3 域的 x=799 边界');
});

test('readyForColumn / ensureForColumn：除 3×3 查询域外还要求 (0,0)；(0,0) 未就绪时不放行也不给 redCity', () => {
  const index = new StructureIndex({ pool: null, seed: SEED });
  seedIndex(index, 53, 6, { withGlobal: false });
  assertTrue(!index.readyForColumn(53, 6), '3×3 域就绪但 (0,0) 未到 → false');
  assertNull(index.redCity());
  index.ensureForColumn(53, 6);
  assertEqual(index._pending.filter((p) => p.key === '0,0').length, 1, '(0,0) 被入队且只入队一次');
  index.ensureForColumn(53, 6);
  assertEqual(index._pending.filter((p) => p.key === '0,0').length, 1, '重复 ensure 不重复入队');
  index._layouts.set('0,0', computeRegionLayout(0, 0, SEED));
  assertTrue(index.readyForColumn(53, 6), '(0,0) 到了 → 放行');
});

test('Scheduler：gen 任务 payload 携带 redCity（几何与 region(0,0) 布局一致）；未就绪的 column 不下发任务', () => {
  const calls = [];
  const pool = { call(method, payload) { calls.push({ method, payload }); return { id: calls.length, promise: new Promise(() => {}) }; }, cancel() {}, broadcast() {} };
  const reg = makeRegistry();
  const scheduler = new Scheduler({ world: new WorldData(reg), pool, registry: reg, seed: SEED, viewDistance: 0 });
  // 玩家在 x=855,z=100（cx=53,cz=6）：先让它 3×3 域就绪但 (0,0) 未到
  seedIndex(scheduler.structureIndex, 53, 6, { withGlobal: false });
  scheduler.update(855, 100);
  assertEqual(calls.filter((c) => c.method === 'gen').length, 0, '(0,0) 未就绪 → 不下发 gen（否则该 column 会永久缺 RedCity）');
  scheduler.structureIndex._layouts.set('0,0', computeRegionLayout(0, 0, SEED));
  scheduler.update(855, 100);
  const gens = calls.filter((c) => c.method === 'gen');
  assertEqual(gens.length, 1);
  assertDeepEqual(gens[0].payload.redCity, computeRegionLayout(0, 0, SEED).redCity, 'payload.redCity === region(0,0) 的 redCity');
  assertTrue(!gens[0].payload.layouts.some((l) => l.regionX === 0 && l.regionZ === 0), 'layouts 仍是 3×3 域；redCity 是单独字段');
});

test('computeRegionLayout：只有 region(0,0) 持有 redCity（= buildRedCityLayout(seed, 它自己的 city)），其余 region 为 null', () => {
  const seed = 12345;
  const l00 = computeRegionLayout(0, 0, seed);
  assertNotNull(l00.redCity);
  assertDeepEqual(l00.redCity, buildRedCityLayout(seed, l00.city));
  assertNull(computeRegionLayout(1, 0, seed).redCity);
  assertNull(computeRegionLayout(-1, -1, seed).redCity);
});
