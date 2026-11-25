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
import { SOLDIER, SOLDIER_AI, SOLDIER_TYPE, SOLDIER_STEERING } from '../entities/soldiers/soldier-config.js';
import {
  SoldierService, soldierDefinition, SOLDIER_AABB,
} from '../entities/soldiers/soldier-system.js';
import { physicsStepAabb, steerIntentAabb } from '../entities/zombies/zombie-navigation.js';
import { planStep } from '../entities/zombies/zombie-pathfinder.js';
import { ZOMBIE_MAX_STEP } from '../entities/zombies/zombie-config.js';
import { playerHitboxLocal } from '../player/physics.js';

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

// ---------------------------------------------------------------------------
// 上台阶能力：1 格 → 2 格（3 格仍上不去）—— 用户 2026-11-26
//
// ☠️☠️ **只改 `SOLDIER.maxStep` 是无效的**：`zombieStepUpY(y) = floor(y+0.01)+1`
// 恒抬 1 格，`maxStep` 只是「抬升量 ≤ maxStep」的门控 ⇒ 1.0 与 2.0 逐位等价
// （`docs/pitfalls.md`「maxStep 是死值」）。所以本组用例必须走**真实
// `physicsStepAabb`**，而不是断言常量等于 2.0 —— 后者在只改常量的缺陷版下照样全绿。
// ---------------------------------------------------------------------------

/**
 * 台阶夹具：`y < top` 全实心（地面），`x >= wallX` 的列额外加高 `stepH` 格。
 * 士兵从 x=3.5 沿 +X 全速跑向 x=5 的台壁。
 */
function makeStepWorld(stepH, { top = 10, wallX = 5 } = {}) {
  return {
    isSolid(x, y) {
      if (y < top) return true;
      if (x >= wallX) return y < top + stepH;
      return false;
    },
  };
}

/** 沿 +X 跑 seconds 秒的真实 60Hz 物理，返回末态与抬升历史 */
function runStepPhysics(stepH, { maxStep = SOLDIER.maxStep, seconds = 4, speed = 4, top = 10 } = {}) {
  const world = makeStepWorld(stepH, { top });
  const box = {
    halfWidth: SOLDIER.width / 2, height: SOLDIER.height,
    maxStep, gravity: SOLDIER.gravity,
  };
  const s = { position: [3.5, top, 3.5], velocity: [speed, 0, 0], onGround: true };
  const lifts = [];
  const n = Math.round(seconds * 60);
  for (let i = 0; i < n; i++) {
    const before = s.position[1];
    physicsStepAabb(s, world, 1 / 60, box);
    if (s.position[1] > before + 1e-9) lifts.push(+(s.position[1] - before).toFixed(6));
    s.velocity[0] = speed;   // AI 意图每拍覆写（与真实 Agent 同口径）
  }
  return { state: s, lifts };
}

test('士兵物理: 1 格台阶能上（既有能力零回归）', () => {
  const { state, lifts } = runStepPhysics(1);
  assertEqual(state.position[1], 11, '顶面 y=11');
  assertTrue(state.position[0] > 6, `须真的走过去了，实测 x=${state.position[0]}`);
  assertTrue(lifts.includes(1), `抬升历史里须有一次 +1，实测 ${JSON.stringify(lifts)}`);
});

test('士兵物理: 2 格台阶能上（用户本轮要求）', () => {
  const { state, lifts } = runStepPhysics(2);
  assertEqual(state.position[1], 12, `2 格台阶顶面 y=12，实测 ${state.position[1]}`);
  assertTrue(state.position[0] > 6, `须越过台壁，实测 x=${state.position[0]}`);
  assertTrue(lifts.some((d) => d >= 1.999),
    `需一次抬到顶（或两次 +1），实测抬升历史 ${JSON.stringify(lifts)}`);
});

test('士兵物理: 3 格台阶上不去（上限就是 2）', () => {
  const { state, lifts } = runStepPhysics(3);
  assertEqual(state.position[1], 10, `3 格不得上去，实测 y=${state.position[1]}`);
  assertTrue(state.position[0] < 5, `不得穿墙，实测 x=${state.position[0]}`);
  assertEqual(lifts.length, 0, '不得有任何 step-up 抬升');
});

test('士兵物理: maxStep=1 的 box 在 2 格台阶上仍卡住（丧尸/焰魔/守卫零回归守卫）', () => {
  // ☠️ 这条是「只改士兵」的唯一守卫：若实现改成直接改 `zombieStepUpY` 本身，
  // 丧尸那一组参数（maxStep=1.0）也会能上 2 格 ⇒ 本例真红。
  const { state } = runStepPhysics(2, { maxStep: ZOMBIE_MAX_STEP });
  assertEqual(state.position[1], 10, `maxStep=1 不得上 2 格，实测 y=${state.position[1]}`);
  assertTrue(state.position[0] < 5, `不得穿墙，实测 x=${state.position[0]}`);
});

test('士兵物理: 空中贴高墙下落不得被一格格「爬」上去', () => {
  // 8 格高墙（y>=10 且 x>=5 全实心），士兵从 y=18 贴墙下落。
  // ☠️ 多级抬升最容易引入的回归：把「下落中允许 step-up」变成「凭空爬墙」。
  const world = { isSolid: (x, y) => (y < 10 ? true : x >= 5) };
  const box = {
    halfWidth: SOLDIER.width / 2, height: SOLDIER.height,
    maxStep: SOLDIER.maxStep, gravity: SOLDIER.gravity,
  };
  const s = { position: [4.69, 18, 3.5], velocity: [4, -2, 0], onGround: false };
  let maxY = 18;
  for (let i = 0; i < 120; i++) {
    physicsStepAabb(s, world, 1 / 60, box);
    s.velocity[0] = 4;
    maxY = Math.max(maxY, s.position[1]);
  }
  assertEqual(maxY, 18, `下落中不得升高，实测 maxY=${maxY}`);
});

test('士兵避障探针: 2 格台阶不算障碍（与物理同口径，否则贴台壁反复试探）', () => {
  const world = makeStepWorld(2);
  const r = steerIntentAabb({
    world, position: [4.5, 10, 3.5], vx: 4, vz: 0,
    halfWidth: SOLDIER.width / 2, height: SOLDIER.height,
    maxStep: SOLDIER.maxStep, steering: SOLDIER_STEERING,
  });
  assertFalse(r.blocked, '2 格台阶物理能上 ⇒ 探针不得判 blocked');
  assertEqual(r.vx, 4, '前方能上台阶 ⇒ 不该偏转（0° 命中逐位原样返回）');
  assertEqual(r.vz, 0);
});

test('士兵避障探针: 3 格台阶仍算障碍（靠偏转绕，不是直撞）', () => {
  // ☠️ 夹具不能用「无限长墙」（首版就这么写，实测假红）：±90° 候选沿墙走本来就通，
  // 3 格墙也会返回 blocked=false。要钉「3 格不可通行」必须把侧向也堵死：
  // 只留 x∈[3,5) × z∈[3,4) 一条 1 格宽走廊，前方是 3 格台壁。
  const world = {
    isSolid(x, y, z) {
      if (y < 10) return true;
      if (x >= 5) return y < 13;          // 3 格台阶
      return !(x >= 3 && z >= 3 && z < 4); // 走廊之外全实心（堵侧向）
    },
  };
  const r = steerIntentAabb({
    world, position: [4.5, 10, 3.5], vx: 4, vz: 0,
    halfWidth: SOLDIER.width / 2, height: SOLDIER.height,
    maxStep: SOLDIER.maxStep, steering: SOLDIER_STEERING,
  });
  assertTrue(r.blocked, '3 格台壁 + 侧向堵死 ⇒ 必须判不可通行');
  // 同一夹具改成 2 格 ⇒ 必须通行（证明 blocked 源于台阶高度而不是夹具全堵）
  const two = {
    isSolid(x, y, z) {
      if (y < 10) return true;
      if (x >= 5) return y < 12;
      return !(x >= 3 && z >= 3 && z < 4);
    },
  };
  const r2 = steerIntentAabb({
    world: two, position: [4.5, 10, 3.5], vx: 4, vz: 0,
    halfWidth: SOLDIER.width / 2, height: SOLDIER.height,
    maxStep: SOLDIER.maxStep, steering: SOLDIER_STEERING,
  });
  assertFalse(r2.blocked, '同夹具 2 格必须通行（否则上一条零判别力）');
});

test('士兵 A*: 2 格台阶上的目标可达（规划得出且物理走得通）', () => {
  const world = makeStepWorld(2);
  const box = { halfWidth: SOLDIER.width / 2, height: SOLDIER.height, maxStep: SOLDIER.maxStep };
  const r = planStep(world, [3.5, 10, 3.5], [9.5, 12, 3.5], { box });
  assertTrue(r.reachable, '2 格台阶后的目标必须可达');
  assertTrue(r.nextStep !== null && r.nextStep[0] > 0,
    `第一步须朝 +X 台壁，实测 ${JSON.stringify(r.nextStep)}`);
});

test('士兵 A*: maxStep=1 时同一地形不可达（零回归守卫）', () => {
  const world = makeStepWorld(2);
  const box = { halfWidth: SOLDIER.width / 2, height: SOLDIER.height, maxStep: ZOMBIE_MAX_STEP };
  const r = planStep(world, [3.5, 10, 3.5], [9.5, 12, 3.5], { box });
  assertFalse(r.reachable, '丧尸口径下 2 格台阶仍是墙');
});

test('士兵 Service: 2 格深坑里的士兵能自己走出来（用户报的真实场景）', () => {
  // 真实 WorldData：坑底 y=1，周围地面 y=3（2 格高差），玩家在坑外。
  //
  // ☠️☠️ **必须走真实帧序**：`soldiers.update`（编排/寻路拍）→ `entities.update`
  // （Agent 决策 + 60Hz 物理）。首版只调前者，实测 240 拍位置恒 [2.5,1,0.5]、
  // 速度恒 0、`nav.decisions=0` —— 那是在测「根本没推进」，与台阶能力无关。
  const { world, registry, entities, soldiers } = makeSoldierFixture();
  const stone = registry.idOf('stone');
  for (let x = 6; x < 32; x++) {
    for (let z = 0; z < 16; z++) {
      world.setBlock(x, 1, z, stone);
      world.setBlock(x, 2, z, stone);
    }
  }
  const id = soldiers.spawn([2.5, 1, 8.5], { source: 'pit' });
  assertTrue(id !== null, '前置：坑底落点合法');
  // ☠️ **玩家必须远于站定环上界 20 格**（首版放 10 格外，实测假红）：
  // 环内是纯侧向游走，士兵会沿 −Z 走出地板掉进虚空（y → −930），
  // 根本不会朝台壁推进。取 24 格 ⇒ 径向推进分量 towardFar 生效。
  const player = { position: [26.5, 3, 8.5], aabb: playerHitboxLocal(), speed: 0, grounded: true };
  const e = entities.get(id);
  e.state = {
    ...e.state, mode: 'combat', awareness: 1, losVisible: true, losTimer: 99,
    crouching: false, crouch: 0, peekT: 99,
  };
  let maxY = 1;
  const dt = 1 / 60;
  for (let i = 0; i < 600; i++) {
    const cur = entities.get(id);
    if (!cur) break;
    // 钉站姿（否则蹲下时移动意图恒 0 —— 距离环用例已记的教训）
    cur.state = { ...cur.state, crouching: false, crouch: 0, peekT: 99 };
    const nowMs = 1000 + i * dt * 1000;
    soldiers.update(dt, { playerPosition: player.position, nowMs });
    entities.update(dt, {
      world, registry, player, nowMs, ...soldiers.agentContext(),
    });
    maxY = Math.max(maxY, entities.get(id)?.state.position[1] ?? maxY);
  }
  const after = entities.get(id)?.state;
  assertTrue(after !== undefined, '士兵不得消失');
  assertTrue(maxY >= 3 - 1e-6, `必须爬上 2 格高差到 y=3，实测 maxY=${maxY}`);
  assertTrue(after.position[0] > 6, `必须真的走出坑，实测 x=${after.position[0]}`);
});

test('士兵 Service: 3 格深坑里出不来（上限就是 2，真实帧序）', () => {
  const { world, registry, entities, soldiers } = makeSoldierFixture();
  const stone = registry.idOf('stone');
  for (let x = 6; x < 32; x++) {
    for (let z = 0; z < 16; z++) {
      for (let y = 1; y <= 3; y++) world.setBlock(x, y, z, stone);
    }
  }
  const id = soldiers.spawn([2.5, 1, 8.5], { source: 'pit3' });
  assertTrue(id !== null, '前置：坑底落点合法');
  const player = { position: [26.5, 4, 8.5], aabb: playerHitboxLocal(), speed: 0, grounded: true };
  const e = entities.get(id);
  e.state = {
    ...e.state, mode: 'combat', awareness: 1, losVisible: true, losTimer: 99,
    crouching: false, crouch: 0, peekT: 99,
  };
  let maxY = 1;
  const dt = 1 / 60;
  for (let i = 0; i < 600; i++) {
    const cur = entities.get(id);
    if (!cur) break;
    cur.state = { ...cur.state, crouching: false, crouch: 0, peekT: 99 };
    const nowMs = 1000 + i * dt * 1000;
    soldiers.update(dt, { playerPosition: player.position, nowMs });
    entities.update(dt, { world, registry, player, nowMs, ...soldiers.agentContext() });
    maxY = Math.max(maxY, entities.get(id)?.state.position[1] ?? maxY);
  }
  assertTrue(maxY < 4 - 1e-6, `3 格高差不得上去，实测 maxY=${maxY}`);
});