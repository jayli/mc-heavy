// src/tests/test-tarn-water.js — 高台地带池水 Tier 1（CPU 判据 + 游泳语义）
//
// 钉两件事：
//   ① 池面判据的 **CPU 版**（`ocean-mask.js` 的 `tarnPoolAt` / `isPointInTarnPool`）
//      —— GPU 侧 `ocean.js` 的 TSL 是同构实现，数值常量必须从这里来（红线 1）
//   ② **玩家在池里真的能游泳** —— `physics.js:74` 的游泳判据显式查 `water` 方块，
//      若池内没放水（或水放错层）这条会**静默失效**（不报错，只是踩在池底走）
import { test } from './runner.js';
import { assertEqual, assertTrue, assertNull, assertNotNull } from './assert.js';
import { isPointInTarnPool, tarnPoolAt } from '../render/ocean-mask.js';
import { computeTarnZone, isTarnZone, TARN_POOL_RADIUS } from '../gen/structures/tarn-zone.js';
import { computeRegionLayout } from '../gen/structures/structure-layout.js';
import { applyStructuresToColumn } from '../gen/structures/apply.js';
import { buildDefaultRegistry } from '../voxel/block-registry.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { blockIndex } from '../voxel/constants.js';
import { fillColumn } from '../gen/terrain.js';

const SEED = 12345;

function findTarnRegion() {
  for (let rx = -6; rx <= 6; rx++) for (let rz = -6; rz <= 6; rz++) {
    if (isTarnZone(rx, rz, SEED)) return { rx, rz };
  }
  throw new Error('没找到地带 region');
}

test('池面判据：tarnPoolAt 只对地带 region 返回对象', () => {
  const { rx, rz } = findTarnRegion();
  const lay = computeTarnZone(rx, rz, SEED);
  const pool = tarnPoolAt(lay.cx, lay.cz, SEED);
  assertNotNull(pool, `地带中心 (${lay.cx},${lay.cz}) 必须有池`);
  assertEqual(pool.radius, TARN_POOL_RADIUS, '池半径');
  assertEqual(pool.waterY, lay.plateauY, 'waterY = plateauY（池底水体那一层）');

  // 非地带 region 的中心：必须 null
  let normal = null;
  for (let rx2 = -6; rx2 <= 6 && !normal; rx2++) for (let rz2 = -6; rz2 <= 6; rz2++) {
    if (!isTarnZone(rx2, rz2, SEED)) { normal = { rx: rx2, rz: rz2 }; break; }
  }
  const nlay = computeTarnZone(normal.rx, normal.rz, SEED);
  assertNull(nlay, '非地带 region 的 computeTarnZone 必须是 null');
  const nx = normal.rx * 400 + 200, nz = normal.rz * 400 + 200;
  assertNull(tarnPoolAt(nx, nz, SEED), '非地带 region 中心不得有池');
});

test('池面判据：isPointInTarnPool 在池内/池外两侧都对', () => {
  const { rx, rz } = findTarnRegion();
  const lay = computeTarnZone(rx, rz, SEED);
  assertTrue(isPointInTarnPool(lay.cx, lay.cz, SEED), '池心在池内');
  assertTrue(isPointInTarnPool(lay.cx + TARN_POOL_RADIUS - 1, lay.cz, SEED), '池边内侧在池内');
  assertTrue(!isPointInTarnPool(lay.cx + TARN_POOL_RADIUS + 2, lay.cz, SEED), '池边外侧不在池内');
  // 池外但在台地环带内：不是池
  assertTrue(!isPointInTarnPool(lay.cx + TARN_POOL_RADIUS + 20, lay.cz, SEED), '台地环带不算池');
});

test('池面判据：池圆周上取 16 点，内圈全 true / 外圈全 false', () => {
  const { rx, rz } = findTarnRegion();
  const lay = computeTarnZone(rx, rz, SEED);
  for (let a = 0; a < 16; a++) {
    const ang = (a / 16) * Math.PI * 2;
    const inR = TARN_POOL_RADIUS - 3, outR = TARN_POOL_RADIUS + 3;
    assertTrue(isPointInTarnPool(lay.cx + inR * Math.cos(ang), lay.cz + inR * Math.sin(ang), SEED),
      `角度 ${a} 内圈应在池内`);
    assertTrue(!isPointInTarnPool(lay.cx + outR * Math.cos(ang), lay.cz + outR * Math.sin(ang), SEED),
      `角度 ${a} 外圈应在池外`);
  }
});

test('池面判据：waterY 与真实体素水那一层一致（口径必须同源）', async () => {
  const { rx, rz } = findTarnRegion();
  const lay = computeTarnZone(rx, rz, SEED);
  const pool = tarnPoolAt(lay.cx, lay.cz, SEED);
  const reg = await buildDefaultRegistry();
  const waterId = reg.idOf('water');
  const cx = Math.floor(lay.cx / 16), cz = Math.floor(lay.cz / 16);
  const col = new ChunkColumn(cx, cz);
  fillColumn(col, SEED, reg);
  await applyStructuresToColumn(col, SEED, reg, [computeRegionLayout(rx, rz, SEED)]);
  const lx = lay.cx - cx * 16, lz = lay.cz - cz * 16;
  // waterY 之上是空气（不然水面会被顶起来）
  assertEqual(col.blocks[blockIndex(lx, pool.waterY + 1, lz)], 0,
    `waterY+1 必须是空气，实际 id=${col.blocks[blockIndex(lx, pool.waterY + 1, lz)]}`);
  // waterY 那格是水
  assertEqual(col.blocks[blockIndex(lx, pool.waterY, lz)], waterId,
    'waterY 那格必须是 water');
});

test('池水：玩家踩在池底时 physics 查的那一格正是 water（能游泳）', async () => {
  // `physics.js:74` 的游泳判据：
  //   getBlockId(floor(pos.x), floor(pos.y + 0.5), floor(pos.z)) === idOf('water')
  // 玩家站在池底（池底是 plateauY-1 的实心）⇒ pos.y = plateauY
  //   ⇒ floor(pos.y + 0.5) = plateauY = waterY  ← 必须正好是 water
  // ⚠️ 那个 +0.5 是载荷性的：若水只在 waterY-1（池底被顶掉）就游不了；若水在 waterY+1
  //    则玩家站在池底时身体中心落在空气里，也游不了。
  const { rx, rz } = findTarnRegion();
  const lay = computeTarnZone(rx, rz, SEED);
  const pool = tarnPoolAt(lay.cx, lay.cz, SEED);
  const reg = await buildDefaultRegistry();
  const waterId = reg.idOf('water');

  // 取池内多个点（不只池心，避免「只在池心放了一格水」蒙混）
  for (let a = 0; a < 8; a++) {
    const ang = (a / 8) * Math.PI * 2;
    const wx = Math.round(lay.cx + (TARN_POOL_RADIUS - 20) * Math.cos(ang));
    const wz = Math.round(lay.cz + (TARN_POOL_RADIUS - 20) * Math.sin(ang));
    const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
    const col = new ChunkColumn(cx, cz);
    fillColumn(col, SEED, reg);
    await applyStructuresToColumn(col, SEED, reg, [computeRegionLayout(rx, rz, SEED)]);
    const lx = wx - cx * 16, lz = wz - cz * 16;
    const playerFeetY = pool.waterY;                     // 站在池底上
    const physicsProbeY = Math.floor(playerFeetY + 0.5); // = waterY
    assertEqual(col.blocks[blockIndex(lx, physicsProbeY, lz)], waterId,
      `角度 ${a} 处 physics 探针格 y=${physicsProbeY} 必须是 water（否则踩在池底走，不能游泳）`);
    // 池底必须是实心（不能是空气/水，否则玩家会掉下去）
    const floorId = col.blocks[blockIndex(lx, pool.waterY - 1, lz)];
    assertTrue(floorId !== 0 && floorId !== waterId,
      `角度 ${a} 处 waterY-1 必须是实心池底，实际 id=${floorId}`);
  }
});

test('池水：池内水面之上是空气（不是水柱）', async () => {
  const { rx, rz } = findTarnRegion();
  const lay = computeTarnZone(rx, rz, SEED);
  const pool = tarnPoolAt(lay.cx, lay.cz, SEED);
  const reg = await buildDefaultRegistry();
  const waterId = reg.idOf('water');
  const cx = Math.floor(lay.cx / 16), cz = Math.floor(lay.cz / 16);
  const col = new ChunkColumn(cx, cz);
  fillColumn(col, SEED, reg);
  await applyStructuresToColumn(col, SEED, reg, [computeRegionLayout(rx, rz, SEED)]);
  const lx = lay.cx - cx * 16, lz = lay.cz - cz * 16;
  // 从 waterY 往上数连续水格 —— 必须只有 1 层
  let layers = 0;
  for (let y = pool.waterY; y <= pool.waterY + 10; y++) {
    if (col.blocks[blockIndex(lx, y, lz)] === waterId) layers++;
    else break;
  }
  assertEqual(layers, 1, `池心水面之上必须立刻是空气（实测连续水格 ${layers} 层）`);
});
