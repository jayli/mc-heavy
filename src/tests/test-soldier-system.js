// src/tests/test-soldier-system.js — 士兵 Service（Tier 1，TDD）
//
// 覆盖 spec §5.2：上限、留尸、伤害/红闪、击退、三条回收路径、班组联动。
// ⚠️ **留尸期上限那条是 Review Focus 1**：用 entities.count() 判上限会把尸体算进名额。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse, assertNull } from './assert.js';
import { createRegistry } from '../voxel/block-registry.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';
import { EntityManager } from '../entities/entity-manager.js';
import { SOLDIER, SOLDIER_AI, SOLDIER_TYPE } from '../entities/soldiers/soldier-config.js';
import {
  SoldierService, soldierDefinition, SOLDIER_AABB,
} from '../entities/soldiers/soldier-system.js';

/** 全空气 + y=0 地面，cx/cz 0..3 已加载（覆盖 x,z ∈ [0,64)） */
function makeSoldierFixture({ maxAlive = SOLDIER.maxAlive } = {}) {
  const registry = createRegistry();
  registry.register('air', { solid: false, opaque: false, cullMode: 'none' });
  registry.register('stone', { solid: true, opaque: true, cullMode: 'opaque' });
  registry.register('bedrock', { solid: true, opaque: true, cullMode: 'opaque' });
  registry.freeze();
  const world = new WorldData(registry);
  for (let cx = 0; cx <= 3; cx++) {
    for (let cz = 0; cz <= 3; cz++) {
      const col = new ChunkColumn(cx, cz);
      for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) col.set(lx, 0, lz, registry.idOf('stone'));
      world.add(col);
    }
  }
  const entities = new EntityManager();
  entities.registerType(SOLDIER_TYPE, soldierDefinition);
  const spawned = [];
  const despawned = [];
  const soldiers = new SoldierService({
    entities, world, maxAlive, rng: () => 0.5,
    onSpawn: (id, slot) => spawned.push({ id, slot }),
    onDespawn: (id) => despawned.push(id),
  });
  return { world, registry, entities, soldiers, spawned, despawned };
}

/** 在第 i 个合法落点生成（x 间隔 2 格，避免同点） */
function spawnAt(soldiers, i) {
  return soldiers.spawn([i * 2 + 0.5, 1, 0.5], { source: 'test' });
}

test('士兵 Service: 上限 10，第 11 只返回 null', () => {
  const { soldiers } = makeSoldierFixture();
  const ids = [];
  for (let i = 0; i < SOLDIER.maxAlive; i++) ids.push(spawnAt(soldiers, i));
  assertTrue(ids.every(Boolean), '前 10 只必须都成功');
  assertEqual(soldiers.count(), 10);
  // ⚠️ 第 11 只的落点必须在已加载 column 内，否则 column 门控先拒绝、上限门控不被触发
  assertNull(spawnAt(soldiers, 11), '第 11 只须被上限拒绝');
});

test('士兵 Service: 出生四道门（脚格/头格 air + 脚下 solid + column 已加载）', () => {
  const { soldiers, world, registry } = makeSoldierFixture();
  const stone = registry.idOf('stone');
  world.setBlock(2, 1, 2, stone);        // 占住脚格
  assertNull(soldiers.spawn([2.5, 1, 2.5]), '脚格被占须拒绝');
  world.setBlock(2, 1, 2, 0);
  world.setBlock(2, 2, 2, stone);        // 占住头格
  assertNull(soldiers.spawn([2.5, 1, 2.5]), '头格被占须拒绝');
  world.setBlock(2, 2, 2, 0);
  assertNull(soldiers.spawn([2.5, 5, 2.5]), '脚下无支撑须拒绝');
  assertNull(soldiers.spawn([200.5, 1, 200.5]), 'column 未加载须拒绝');
});

test('士兵 Service: 伤害与红闪，致死置 dead 但不立即 despawn', () => {
  const { soldiers, entities } = makeSoldierFixture();
  const id = spawnAt(soldiers, 0);
  const r = soldiers.damage(id, 25, 1000);
  assertEqual(r.dead, false);
  assertEqual(r.health, 75);
  assertEqual(soldiers.get(id).flashedUntil, 1000 + SOLDIER.flashMs);
  const kill = soldiers.damage(id, 999, 2000);
  assertEqual(kill.dead, true, '致死须报 dead');
  assertTrue(entities.get(id) !== null, '致死当帧不得立即 despawn（要留尸播倒地）');
  assertEqual(soldiers.get(id).dead, true);
});

test('士兵 Service: 留尸 1.2s 后才 despawn，且期间不可被射线击中', () => {
  const { soldiers, entities } = makeSoldierFixture();
  const id = spawnAt(soldiers, 0);
  soldiers.damage(id, 999, 1000);
  const e = entities.get(id);
  // 留尸期间射线打不到（否则鞭尸还扣血、还弹伤害数字）
  const hit = soldierDefinition.raycastAabb(e.state, [0.5, 1.4, 5.5], [0, 0, -1], 20);
  assertNull(hit, '留尸期间不得可击中');
  // 推进不足 1.2s：仍在
  soldiers.update(0.5, { playerPosition: [0.5, 1, 10.5], nowMs: 1500 });
  assertTrue(entities.get(id) !== null, '0.5s 时尸体须仍在');
  // 再推进到超过 1.2s：回收
  soldiers.update(0.8, { playerPosition: [0.5, 1, 10.5], nowMs: 2300 });
  assertNull(entities.get(id), '超过 1.2s 须回收');
});

test('士兵 Service: 留尸期上限不占名额（Review Focus 1）', () => {
  const { soldiers, entities } = makeSoldierFixture();
  const ids = [];
  for (let i = 0; i < SOLDIER.maxAlive; i++) ids.push(spawnAt(soldiers, i));
  soldiers.damage(ids[0], 999, 1000);
  // ⚠️ 此刻 entities.count 仍是 10（尸体还在），但存活只有 9
  assertEqual(entities.count(SOLDIER_TYPE), 10, '前置：尸体仍占着 EntityManager 名额');
  assertEqual(soldiers.count(), 9, '存活计数须是 9');
  const again = spawnAt(soldiers, 12);
  assertTrue(again !== null, '打死一只后必须能立刻补上（用户要的是「同时存活 10」）');
});

test('士兵 Service: 三条回收路径都归还 slot（死亡/卸载/dispose）', () => {
  const f = makeSoldierFixture();
  const a = spawnAt(f.soldiers, 0);
  // ① 死亡 → 留尸到期回收
  f.soldiers.damage(a, 999, 0);
  f.soldiers.update(1.5, { playerPosition: [0.5, 1, 10.5], nowMs: 2000 });
  assertEqual(f.soldiers.count(), 0);
  assertEqual(f.soldiers.slotOf(a), null, '死亡路径须归还 slot');
  // ② column 卸载
  const b = spawnAt(f.soldiers, 0);
  assertEqual(f.soldiers.despawnColumn('0,0'), 1);
  assertEqual(f.soldiers.slotOf(b), null, '卸载路径须归还 slot');
  // ③ dispose
  const c = spawnAt(f.soldiers, 0);
  f.soldiers.dispose();
  assertEqual(f.soldiers.count(), 0);
  assertEqual(f.soldiers.slotOf(c), null, 'dispose 路径须归还 slot');
  // slot 可复用：回收后再召满仍成功
  const g = makeSoldierFixture();
  for (let i = 0; i < SOLDIER.maxAlive; i++) spawnAt(g.soldiers, i);
  g.soldiers.dispose();
  for (let i = 0; i < SOLDIER.maxAlive; i++) assertTrue(spawnAt(g.soldiers, i) !== null, 'dispose 后须能再召满');
});

test('士兵 Service: 击退是位置位移（不写 velocity）且真的动了', () => {
  const { soldiers } = makeSoldierFixture();
  const id = spawnAt(soldiers, 0);
  const before = [...soldiers.get(id).position];
  const ok = soldiers.knockback(id, 0.9, 0);
  assertTrue(ok, '开阔地击退须成功');
  const after = soldiers.get(id).position;
  assertTrue(after[0] > before[0] + 0.5, `须沿 +X 位移，实测 ${after[0] - before[0]}`);
});

test('士兵 Service: alertNearby 只影响 34 格内非 combat 同伴', () => {
  const { soldiers, entities } = makeSoldierFixture();
  const src = soldiers.spawn([0.5, 1, 0.5], { source: 't' });
  const near = soldiers.spawn([10.5, 1, 0.5], { source: 't' });   // 10 格
  const far = soldiers.spawn([50.5, 1, 0.5], { source: 't' });    // 50 格 > 34
  soldiers.alertNearby(src, 1000);
  assertTrue(entities.get(near).state.alertDelay >= 0, '34 格内同伴须被安排延迟入战');
  assertEqual(entities.get(far).state.alertDelay, -1, '34 格外不得被报警');
});

test('士兵 Service: hearShot 让 48 格内 patrol 士兵转 search', () => {
  const { soldiers, entities } = makeSoldierFixture();
  const near = soldiers.spawn([10.5, 1, 0.5], { source: 't' });
  const far = soldiers.spawn([60.5, 1, 0.5], { source: 't' });
  soldiers.hearShot([0.5, 1, 0.5], 1000);
  assertEqual(entities.get(near).state.mode, 'search', '48 格内须转 search');
  assertTrue(entities.get(near).state.awareness >= SOLDIER_AI.hearAwarenessFloor);
  assertEqual(entities.get(far).state.mode, 'patrol', '48 格外不受影响');
});

test('士兵 Service: 并发点射统计不超过 maxConcurrentBursts', () => {
  const { soldiers } = makeSoldierFixture();
  for (let i = 0; i < SOLDIER.maxAlive; i++) soldiers.spawn([i * 2 + 0.5, 1, 0.5], { source: 't' });
  // 全部推进 combat（直接写 state，避免依赖 AI 时序）
  for (const e of soldiers.activeEntities()) {
    e.state = { ...e.state, mode: 'combat', awareness: 1, nextBurst: 0, reaction: 0, crouching: false, crouch: 0, peekT: 99 };
  }
  let maxBursting = 0;
  for (let i = 0; i < 40; i++) {
    soldiers.update(0.05, { playerPosition: [0.5, 1, 12.5], nowMs: 1000 + i * 50 });
    maxBursting = Math.max(maxBursting, soldiers.debugState().bursting);
  }
  assertTrue(maxBursting <= 2, `并发点射须 ≤2，实测峰值 ${maxBursting}`);
});

test('士兵 Service: activeEntities 含留尸（渲染要画它），count 只数活的', () => {
  const { soldiers } = makeSoldierFixture();
  const a = spawnAt(soldiers, 0);
  spawnAt(soldiers, 1);
  soldiers.damage(a, 999, 0);
  assertEqual(soldiers.count(), 1, 'count 只数活的');
  assertEqual(soldiers.activeEntities().length, 2, 'activeEntities 含留尸');
});

test('士兵 AABB: 0.6×1.8×0.6 相对脚底（min.y = 0）', () => {
  assertEqual(SOLDIER_AABB.min[1], 0);
  assertEqual(SOLDIER_AABB.max[1], SOLDIER.height);
  assertEqual(SOLDIER_AABB.min[0], -SOLDIER.width / 2);
});

test('士兵 definition: 临时实体不写 snapshot', () => {
  assertNull(soldierDefinition.serialize({ position: [0, 1, 0] }));
  assertNull(soldierDefinition.deserialize({ position: [0, 1, 0] }));
});

test('士兵 definition: update 返回全新对象与数组（跨 column 索引迁移不变式）', () => {
  const { soldiers, entities, world, registry } = makeSoldierFixture();
  const id = spawnAt(soldiers, 0);
  const e = entities.get(id);
  const before = e.state;
  const next = soldierDefinition.update(e, 1 / 60, {
    world, registry, player: { position: [0.5, 1, 10.5] }, nowMs: 100,
    bursting: 0, lastKnown: null, lastSeenAny: -1e9, advancerId: null, selfId: id,
  });
  assertFalse(next === before, '不得返回同一对象');
  assertFalse(next.position === before.position, 'position 须新数组');
});