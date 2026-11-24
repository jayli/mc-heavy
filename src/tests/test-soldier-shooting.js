// src/tests/test-soldier-shooting.js — 士兵开火判定纯函数（Tier 1，TDD）
//
// 覆盖 spec §5.4：命中率公式（上游 shootAt 逐项）、散布点域、弹道遮挡顺序。
// ⚠️ **不穿墙那条是 Review Focus 3**：体素世界随时被玩家挖改，Agent 的 10Hz 视线缓存
// 可能已过期，故弹道必须自己再走一次 DDA。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse } from './assert.js';
import { createRegistry } from '../voxel/block-registry.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';
import { playerHitboxLocal } from '../player/physics.js';
import { SOLDIER_SHOT } from '../entities/soldiers/soldier-config.js';
import {
  soldierHitChance, soldierMissPoint, judgeSoldierShot,
} from '../entities/soldiers/soldier-shooting.js';

/** 全空气 + y=0 地面的小世界（cx/cz 0..1 已加载），可按需砌墙 */
function makeShotFixture() {
  const registry = createRegistry();
  registry.register('air', { solid: false, opaque: false, cullMode: 'none' });
  registry.register('stone', { solid: true, opaque: true, cullMode: 'opaque' });
  // 玻璃：solid=1 但 opaque=0 ⇒ isProjectileOccluding 放行（判别性用例的载体）
  registry.register('glass_block', { solid: true, opaque: false, cullMode: 'transparent' });
  // 树叶：solid=1 opaque=1 ⇒ 两个判据都挡（只测它抓不到玻璃那条差异）
  registry.register('leaves', { solid: true, opaque: true, cullMode: 'cutout' });
  registry.register('bedrock', { solid: true, opaque: true, cullMode: 'opaque' });
  registry.freeze();
  const world = new WorldData(registry);
  for (let cx = 0; cx <= 1; cx++) {
    for (let cz = 0; cz <= 1; cz++) {
      const col = new ChunkColumn(cx, cz);
      for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) col.set(lx, 0, lz, registry.idOf('stone'));
      world.add(col);
    }
  }
  return { world, registry, ids: {
    stone: registry.idOf('stone'), glass: registry.idOf('glass_block'), leaves: registry.idOf('leaves'),
  } };
}

/** 玩家站在 (8.5, 1, 8.5)，枪口在 +Z 侧 5 格外朝 −Z 打 */
function makePlayer() {
  return { position: [8.5, 1, 8.5], aabb: playerHitboxLocal() };
}

/** 舍入到 1e-6：抵消 IEEE754 累加噪声（同 test-zombies.js 的 round6 口径）。
 *  ⚠️ 上游 `accuracy - d*0.011 - speed*0.03 - 0.12` 同样会产生这个尾差，
 *  实现不得为了凑字面量去改运算顺序（那会偏离上游）。 */
function round6(v) { return Math.round(v * 1e6) / 1e6; }

test('士兵命中率: 上游公式逐项 + 两端钳制', () => {
  assertEqual(round6(soldierHitChance({ accuracy: 0.66, distance: 10, playerSpeed: 0, playerGrounded: true })), 0.55);
  assertEqual(round6(soldierHitChance({ accuracy: 0.66, distance: 10, playerSpeed: 0, playerGrounded: false })), 0.43);
  assertEqual(round6(soldierHitChance({ accuracy: 0.4, distance: 100, playerSpeed: 8, playerGrounded: false })), 0.06);
  assertEqual(round6(soldierHitChance({ accuracy: 0.99, distance: 0, playerSpeed: 0, playerGrounded: true })), 0.82);
});

test('士兵命中率: 玩家速度真的压低命中（移动更难被打中）', () => {
  const still = soldierHitChance({ accuracy: 0.66, distance: 10, playerSpeed: 0, playerGrounded: true });
  const moving = soldierHitChance({ accuracy: 0.66, distance: 10, playerSpeed: 8, playerGrounded: true });
  assertTrue(moving < still, `移动须更难命中：${moving} < ${still}`);
  assertEqual(round6(still - moving), round6(8 * SOLDIER_SHOT.accuracyPerSpeed));
});

test('士兵弹道: 开阔地命中玩家盒', () => {
  const { world, registry } = makeShotFixture();
  const player = makePlayer();
  const muzzle = [8.5, 1.4, 13.5];
  const r = judgeSoldierShot({
    muzzle, target: [8.5, 1.4, 8.5], world, registry, player,
    maxDistance: SOLDIER_SHOT.maxDistance,
  });
  assertTrue(r.hitPlayer, '开阔地必须命中玩家');
  assertEqual(r.blockPos, null, '不该命中方块');
  assertTrue(r.end[2] > 8.5, `弹着点须落在玩家盒近侧表面，实测 z=${r.end[2]}`);
});

test('士兵弹道: 实心墙挡在中间 ⇒ 不打玩家（Review Focus 3）', () => {
  const { world, registry, ids } = makeShotFixture();
  const player = makePlayer();
  // 在 z=11 砌一堵墙（枪口 z=13.5、玩家 z=8.5 之间），x 8..9、y 1..3
  for (let x = 7; x <= 10; x++) for (let y = 1; y <= 3; y++) world.setBlock(x, y, 11, ids.stone);
  const r = judgeSoldierShot({
    muzzle: [8.5, 1.4, 13.5], target: [8.5, 1.4, 8.5], world, registry, player,
    maxDistance: SOLDIER_SHOT.maxDistance,
  });
  assertFalse(r.hitPlayer, '墙后的玩家不得被打中');
  assertTrue(r.blockPos !== null, '必须报出被命中的方块');
  assertEqual(r.blockPos[2], 11, '命中的是那堵墙');
  assertTrue(r.end[2] > 11, `弹着点须在墙的枪口侧表面，实测 z=${r.end[2]}`);
});

test('士兵弹道: 玻璃挡不住（isProjectileOccluding 口径，与炮塔同源）', () => {
  const { world, registry, ids } = makeShotFixture();
  const player = makePlayer();
  for (let x = 7; x <= 10; x++) for (let y = 1; y <= 3; y++) world.setBlock(x, y, 11, ids.glass);
  const r = judgeSoldierShot({
    muzzle: [8.5, 1.4, 13.5], target: [8.5, 1.4, 8.5], world, registry, player,
    maxDistance: SOLDIER_SHOT.maxDistance,
  });
  assertTrue(r.hitPlayer, '玻璃是 opaque=0 ⇒ 弹道须穿透（用 solid-only 判据会误挡）');
});

test('士兵弹道: 树叶挡住（与玻璃成对，证明判据真的读 opaque 而不是恒放行）', () => {
  const { world, registry, ids } = makeShotFixture();
  const player = makePlayer();
  for (let x = 7; x <= 10; x++) for (let y = 1; y <= 3; y++) world.setBlock(x, y, 11, ids.leaves);
  const r = judgeSoldierShot({
    muzzle: [8.5, 1.4, 13.5], target: [8.5, 1.4, 8.5], world, registry, player,
    maxDistance: SOLDIER_SHOT.maxDistance,
  });
  assertFalse(r.hitPlayer, '树叶 opaque=1 ⇒ 须挡住');
});

test('士兵弹道: 超距不判定', () => {
  const { world, registry } = makeShotFixture();
  const player = makePlayer();
  const r = judgeSoldierShot({
    muzzle: [8.5, 1.4, 13.5], target: [8.5, 1.4, 8.5], world, registry, player,
    maxDistance: 2,   // 玩家在 5 格外
  });
  assertFalse(r.hitPlayer, '超出 maxDistance 的玩家不得被打中');
});

test('士兵弹道: player 为 null 时不抛错，只判方块', () => {
  const { world, registry } = makeShotFixture();
  const r = judgeSoldierShot({
    muzzle: [8.5, 1.4, 13.5], target: [8.5, 1.4, 8.5], world, registry, player: null,
    maxDistance: SOLDIER_SHOT.maxDistance,
  });
  assertFalse(r.hitPlayer);
  assertTrue(Array.isArray(r.end) && r.end.length === 3);
});

test('士兵散布点: 落在玩家周围环形域内（上游 0.5~1.6）', () => {
  const p = [8.5, 1, 8.5];
  for (const v of [0, 0.25, 0.5, 0.75, 0.999]) {
    const m = soldierMissPoint(p, () => v);
    const d = Math.hypot(m[0] - p[0], m[2] - p[2]);
    assertTrue(d >= SOLDIER_SHOT.missRadiusMin - 1e-9 && d <= SOLDIER_SHOT.missRadiusMin + SOLDIER_SHOT.missRadiusRange + 1e-9,
      `水平距离须在 [0.5,1.6]，rand=${v} 时实测 ${d}`);
    assertTrue(m[1] >= p[1] + SOLDIER_SHOT.missYMin - 1e-9
      && m[1] <= p[1] + SOLDIER_SHOT.missYMin + SOLDIER_SHOT.missYRange + 1e-9,
      `高度须在 [y+0.4,y+2.0]，实测 ${m[1]}`);
  }
});