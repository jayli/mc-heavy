// src/tests/test-fireball.js — 飞龙火球（v2.44）：推进 / DDA 阻挡 / 玩家命中
//
// Tier 1 单测。覆盖「改坏了肉眼玩不出来」的部分：
// ① **必须返回全新 state + 全新数组**（M5 不变式：原地改写会让 column 索引永不迁移）；
// ② **遮挡判据只看 `solidTable`，有意不同于炮塔弹丸的 `isProjectileOccluding`**（solid && opaque）
//    —— 玻璃 `opaqueTable=0` 会被那个判据放过，而用户明确火球要「击中树叶、玻璃等半透明方块」
//    也爆炸。**只测树叶的用例抓不到这个差异**（树叶是 `opaque:true`，两个判据都挡），
//    故玻璃那条是判别性用例；
// ③ **判定线段还原本步穿越**（`from = position − direction × stepLen`）—— dt 尖峰时不穿墙；
// ④ 超距**不爆炸**（没撞到东西就消失），与 block/player 的语义区分。
//
// ⚠️ fixture 用**真实 `WorldData` + registry**（不是桩件）：`raycastVoxel` 内部读
// `world.registry.idOf('water')`，桩件缺它会让 DDA 直接抛错（testing-policy §2.7）。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertNull, assertNotNull } from './assert.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';
import { FIREBALL, FIREBALL_TYPE } from '../entities/dragons/dragon-config.js';
import {
  fireballDefinition, judgeFireball, advanceFireball, FIREBALL_AABB,
} from '../entities/dragons/fireball-system.js';
import { playerHitboxLocal } from '../player/physics.js';

function makeRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}

/** 全空气世界（column [0,1]²，与 test-projectiles 同口径：路径可能跨 column） */
function makeWorld() {
  const registry = makeRegistry();
  const world = new WorldData(registry);
  for (let cx = 0; cx <= 1; cx++) {
    for (let cz = 0; cz <= 1; cz++) {
      const col = new ChunkColumn(cx, cz);
      col.state = 'ready';
      world.add(col);
    }
  }
  return { world, registry };
}

function makeState(position, direction, over = {}) {
  return fireballDefinition.create({ position, direction, traveled: 0, source: 'dragon', ...over });
}

// ==================== state 构造 ====================

test('火球 state: create 校验形状并归一化方向', () => {
  const st = makeState([0.5, 30, 0.5], [0, 0, 2]);
  assertNotNull(st);
  assertEqual(st.direction[2], 1, '方向必须归一化');
  assertEqual(st.traveled, 0);
  assertEqual(st.source, 'dragon');
  // 非法输入
  assertNull(fireballDefinition.create({ position: [0, 0], direction: [1, 0, 0] }));
  assertNull(fireballDefinition.create({ position: [0, 0, 0], direction: [0, 0, 0] }));   // 零方向
  assertNull(fireballDefinition.create({ position: [NaN, 0, 0], direction: [1, 0, 0] }));
  // AABB 是 FIREBALL.radius 见方的小盒（渲染半径的等价表达）
  assertEqual(FIREBALL_AABB.max[0], FIREBALL.radius);
  assertEqual(FIREBALL_AABB.min[0], -FIREBALL.radius);
});

// ==================== 推进 ====================

test('火球推进: 一帧位移 = speed × dt，方向不变', () => {
  const dt = 0.016;
  const st = makeState([0.5, 30, 0.5], [0, 0, 1]);
  const next = fireballDefinition.update({ state: st }, dt, {});
  const expect = FIREBALL.speed * dt;
  assertTrue(Math.abs(next.position[2] - (0.5 + expect)) < 1e-12,
    `z 位移 ${next.position[2] - 0.5} ≠ ${expect}`);
  assertTrue(Math.abs(next.traveled - expect) < 1e-12, `traveled=${next.traveled}`);
  assertEqual(next.direction[2], 1, '方向不得漂移');
});

test('火球推进: 返回全新 state 与全新 position 数组（M5 不变式）', () => {
  const st = makeState([0.5, 30, 0.5], [1, 0, 0]);
  const before = [...st.position];
  const next = fireballDefinition.update({ state: st }, 0.016, {});
  assertTrue(next !== st, '必须返回新对象');
  assertTrue(next.position !== st.position, 'position 数组必须是新引用');
  assertEqual(st.position[0], before[0], '原 state 不得被改写');
});

test('火球推进: 1 秒飞行距离 ≈ speed 格（推进只做一遍）', () => {
  // ⚠️ 这条是「两处推进会让速度翻倍」的判据（与弹丸同款）
  let st = makeState([0.5, 30, 0.5], [0, 0, 1]);
  const dt = 1 / 60;
  for (let i = 0; i < 60; i++) st = fireballDefinition.update({ state: st }, dt, {});
  const dist = st.position[2] - 0.5;
  assertTrue(Math.abs(dist - FIREBALL.speed) < 1e-6, `1 秒飞了 ${dist} 格 ≠ ${FIREBALL.speed}`);
});

// ==================== 方块阻挡（判据只看 solid）====================

test('火球撞实心不透明方块 → block，at = 那个 blockPos', () => {
  const { world, registry } = makeWorld();
  world.setBlock(10, 5, 14, registry.idOf('stone'));
  const r = judgeFireball({
    next: makeState([10.5, 5.5, 14.5], [0, 0, 1]),
    world, registry, player: null, stepLen: FIREBALL.speed * 0.1,
  });
  assertEqual(r.reason, 'block');
  assertEqual(r.at[0], 10); assertEqual(r.at[1], 5); assertEqual(r.at[2], 14);
});

test('火球撞玻璃（solid 但 opaqueTable=0）→ block（**判别性用例**）', () => {
  // ⚠️ 这条是 Review Focus 2 的判据：误用炮塔的 `isProjectileOccluding`（solid && opaque）
  // 时玻璃会被放过 → reason 为 null → 本用例真 FAIL。
  // 用户原话：「火球触碰到玩家身体，或者击中实体方块（**包括树叶、玻璃等半透明方块**）都会产生爆炸」
  const { world, registry } = makeWorld();
  const glassId = registry.idOf('glass_block');
  assertEqual(registry.solidTable[glassId], 1, 'sanity：玻璃是 solid');
  assertEqual(registry.opaqueTable[glassId], 0, 'sanity：玻璃 opaqueTable=0（炮塔弹丸会穿过它）');
  world.setBlock(10, 5, 14, glassId);
  const r = judgeFireball({
    next: makeState([10.5, 5.5, 14.5], [0, 0, 1]),
    world, registry, player: null, stepLen: FIREBALL.speed * 0.1,
  });
  assertEqual(r.reason, 'block', '火球必须被玻璃挡住（与炮塔弹丸口径有意不同）');
});

test('火球撞树叶（cutout + opaque:true）→ block', () => {
  const { world, registry } = makeWorld();
  world.setBlock(10, 5, 14, registry.idOf('leaves'));
  const r = judgeFireball({
    next: makeState([10.5, 5.5, 14.5], [0, 0, 1]),
    world, registry, player: null, stepLen: FIREBALL.speed * 0.1,
  });
  assertEqual(r.reason, 'block');
});

test('火球穿过水与花草（非 solid）→ 不爆', () => {
  const { world, registry } = makeWorld();
  for (const name of ['water', 'short_grass', 'flower', 'vine']) {
    world.setBlock(10, 5, 14, registry.idOf(name));
    const r = judgeFireball({
      next: makeState([10.5, 5.5, 14.5], [0, 0, 1]),
      world, registry, player: null, stepLen: FIREBALL.speed * 0.1,
    });
    assertNull(r.reason, `${name} 不是 solid，火球必须穿过（reason=${r.reason}）`);
    world.setBlock(10, 5, 14, 0);
  }
});

test('火球撞台阶/半砖（solid 但 opaque:false）→ block', () => {
  // 与玻璃同类：`isProjectileOccluding` 会放过它们（opaque:false），火球必须挡住。
  // ⚠️ 方块名必须是 registry 里真实存在的：`half_block` / `planks_step` 是**几何名**不是方块名
  // （首版用 `half_block` 让 `idOf` 返回 undefined，sanity 断言当场拓到）。
  const { world, registry } = makeWorld();
  for (const name of ['sand_step', 'sand_slab', 'chimney', 'half_block_updown']) {
    const id = registry.idOf(name);
    assertEqual(registry.solidTable[id], 1, `sanity：${name} 是 solid`);
    assertEqual(registry.opaqueTable[id], 0,
      `sanity：${name} 的 opaqueTable 必须是 0（否则本用例对「误用 isProjectileOccluding」没有牙齿）`);
    world.setBlock(10, 5, 14, id);
    const r = judgeFireball({
      next: makeState([10.5, 5.5, 14.5], [0, 0, 1]),
      world, registry, player: null, stepLen: FIREBALL.speed * 0.1,
    });
    assertEqual(r.reason, 'block', `${name} 必须挡住火球`);
    world.setBlock(10, 5, 14, 0);
  }
});

test('火球判定线段还原本步穿越：dt 尖峰时不穿墙', () => {
  const { world, registry } = makeWorld();
  // 1 格厚的墙在 z=13；火球从 z=12.5 出发，dt=0.2 → stepLen = 15×0.2 = **3 格**
  // → 步后位置 15.5 已在墙**之后**。只从步后位置起算会漏掉这堵墙。
  world.setBlock(10, 5, 13, registry.idOf('stone'));
  const r = judgeFireball({
    next: makeState([10.5, 5.5, 15.5], [0, 0, 1]),
    world, registry, player: null, stepLen: FIREBALL.speed * 0.2,
  });
  assertEqual(r.reason, 'block', '3 格步长仍须命中 1 格厚的墙');
  assertEqual(r.at[2], 13, 'at 必须是墙那一格（不是步后位置）');
  // 对照：墙在本步**之外**（z=20）→ 不该命中（证明判定区间是「本步」而不是无限长）
  world.setBlock(10, 5, 13, 0);
  world.setBlock(10, 5, 20, registry.idOf('stone'));
  const r2 = judgeFireball({
    next: makeState([10.5, 5.5, 15.5], [0, 0, 1]),
    world, registry, player: null, stepLen: FIREBALL.speed * 0.2,
  });
  assertNull(r2.reason, '本步未穿越到 z=20 → 不该命中');
});

// ==================== 超距 ====================

test('火球超距 → max-distance 且**不给 at**（不爆炸）', () => {
  const { world, registry } = makeWorld();
  const st = makeState([0.5, 30, 0.5], [0, 0, 1], { traveled: FIREBALL.maxDistance });
  const r = judgeFireball({
    next: st, world, registry, player: null, stepLen: FIREBALL.speed * 0.016,
  });
  assertEqual(r.reason, 'max-distance');
  assertEqual(r.at, undefined, '超距是「没撞到东西」，不得给爆炸中心');
});

test('火球超距阈值两侧区分（maxDistance−1 不超 / +1 超）', () => {
  const { world, registry } = makeWorld();
  const near = judgeFireball({
    next: makeState([0.5, 30, 0.5], [0, 0, 1], { traveled: FIREBALL.maxDistance - 1 }),
    world, registry, player: null, stepLen: 0.1,
  });
  assertNull(near.reason, 'maxDistance−1 不得判超距');
  const far = judgeFireball({
    next: makeState([0.5, 30, 0.5], [0, 0, 1], { traveled: FIREBALL.maxDistance + 1 }),
    world, registry, player: null, stepLen: 0.1,
  });
  assertEqual(far.reason, 'max-distance');
});

// ==================== 玩家命中 ====================

test('火球命中玩家盒 → player，at = 命中点（玩家不掉血）', () => {
  const { world, registry } = makeWorld();
  const box = playerHitboxLocal();
  // 玩家脚底 (10.5, 5, 14.5) → 盒 y∈[5, 6.8]、x/z ∈ [10.2, 10.8]
  const player = { position: [10.5, 5, 14.5], aabb: box };
  const r = judgeFireball({
    next: makeState([10.5, 5.5, 14.5], [0, 0, 1]),
    world, registry, player, stepLen: FIREBALL.speed * 0.1,
  });
  assertEqual(r.reason, 'player', '火球必须能命中玩家身体');
  assertNotNull(r.at, '命中玩家要给爆炸中心');
});

test('火球从玩家头顶飞过（y 高于盒顶）→ 不命中', () => {
  const { world, registry } = makeWorld();
  const box = playerHitboxLocal();
  const player = { position: [10.5, 5, 14.5], aabb: box };   // 盒顶 y = 6.8
  const r = judgeFireball({
    next: makeState([10.5, 8.5, 14.5], [0, 0, 1]),   // y=8.5 > 6.8
    world, registry, player, stepLen: FIREBALL.speed * 0.1,
  });
  assertNull(r.reason, 'y 高于玩家盒顶不得命中（盒尺寸必须真的参与判定）');
});

test('火球从玩家身侧飞过（x 偏出盒）→ 不命中', () => {
  const { world, registry } = makeWorld();
  const player = { position: [10.5, 5, 14.5], aabb: playerHitboxLocal() };   // x∈[10.2,10.8]
  const r = judgeFireball({
    next: makeState([12.5, 5.5, 14.5], [0, 0, 1]),   // x=12.5 远在盒外
    world, registry, player, stepLen: FIREBALL.speed * 0.1,
  });
  assertNull(r.reason, 'x 偏出玩家盒不得命中');
});

test('playerHitboxLocal: 盒尺寸来自 PLAYER_WIDTH/HEIGHT 的唯一权威', () => {
  const box = playerHitboxLocal();
  // 宽 0.6 → 半宽 0.3；高 1.8 → y∈[0, 1.8]（position 是脚底中心）
  assertEqual(box.min[0], -0.3);
  assertEqual(box.max[0], 0.3);
  assertEqual(box.min[1], 0, 'y 下界 = 0（position 就是脚底，不偏移）');
  assertEqual(box.max[1], 1.8);
  assertEqual(box.min[2], -0.3);
  assertEqual(box.max[2], 0.3);
});

// ==================== advanceFireball（单测薄封装）====================

test('advanceFireball: 推进 + 判定一次完成（单测用，帧循环不用）', () => {
  const { world, registry } = makeWorld();
  world.setBlock(10, 5, 14, registry.idOf('stone'));
  const r = advanceFireball({
    state: makeState([10.5, 5.5, 10.5], [0, 0, 1]),
    dt: 0.3, world, registry, player: null,
  });
  assertEqual(r.alive, false);
  assertEqual(r.reason, 'block');
  assertEqual(r.at[2], 14);
});

test('火球 type 常量与 definition 形状', () => {
  assertEqual(FIREBALL_TYPE, 'fireball');
  assertTrue(typeof fireballDefinition.create === 'function');
  assertTrue(typeof fireballDefinition.update === 'function');
  assertTrue(typeof fireballDefinition.raycastAabb === 'function');
  // 临时实体不存档（与弹丸同口径）
  assertNull(fireballDefinition.serialize({ position: [0, 0, 0] }));
});
