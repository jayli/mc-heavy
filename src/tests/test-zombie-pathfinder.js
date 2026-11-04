// src/tests/test-zombie-pathfinder.js — 有界 BFS 寻路（v2.46 在线 AI 的「代码寻路」层）
//
// 判据全部落在「规划出的路物理走得通」上：可走性复用 zombie-navigation.js，
// 与物理 tryStepUp 同口径（一层台阶可走、两层不可走）。
import { test } from './runner.js';
import { assertEqual, assertFalse, assertTrue, assertDeepEqual } from './assert.js';
import { PATHFIND, DIRECTION_ORDER } from '../entities/zombies/zombie-config.js';
import { directionNameOf, planStep } from '../entities/zombies/zombie-pathfinder.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';
import { createRegistry } from '../voxel/block-registry.js';
import { WORLD_MIN_Y } from '../voxel/constants.js';

/** 平地世界：size×size 全 stone（到 y=top），返回 { world, registry, set } */
function makeFlat({ size = 64, top = 0 } = {}) {
  const registry = createRegistry();
  registry.register('air', { solid: false, opaque: false, cullMode: 'none' });
  registry.register('stone', { solid: true, opaque: true, cullMode: 'opaque' });
  registry.register('bedrock', { solid: true, opaque: true, cullMode: 'opaque' });
  const world = new WorldData(registry);
  const stone = registry.idOf('stone');
  for (let cx = 0; cx * 16 < size; cx++) {
    for (let cz = 0; cz * 16 < size; cz++) {
      const col = new ChunkColumn(cx, cz);
      for (let lz = 0; lz < 16; lz++) {
        for (let lx = 0; lx < 16; lx++) {
          for (let y = WORLD_MIN_Y; y <= top; y++) col.set(lx, y, lz, stone);
        }
      }
      world.add(col);
    }
  }
  const set = (x, y, z) => world.setBlock(x, y, z, stone);
  return { world, registry, set, stone };
}

test('PATHFIND：默认半径 24，探索上限覆盖方形搜索域', () => {
  assertEqual(PATHFIND.maxRadius, 24);
  assertTrue(PATHFIND.maxExplored >= (2 * 24 + 1) ** 2, '探索上限须能覆盖整个方形搜索域');
});

test('DIRECTION_ORDER：8 项且顺序固定（确定性）', () => {
  assertEqual(DIRECTION_ORDER.length, 8);
  assertDeepEqual(DIRECTION_ORDER, [
    'north', 'north_east', 'east', 'south_east',
    'south', 'south_west', 'west', 'north_west',
  ]);
});

test('directionNameOf：8 向对齐给出名字，其他返回 null', () => {
  assertEqual(directionNameOf(0, -1), 'north');
  assertEqual(directionNameOf(0, 1), 'south');
  assertEqual(directionNameOf(1, 0), 'east');
  assertEqual(directionNameOf(-1, 0), 'west');
  assertEqual(directionNameOf(1, 1), 'south_east');
  assertEqual(directionNameOf(-1, -1), 'north_west');
  assertEqual(directionNameOf(0, 0), null, '原地不是方向');
  assertEqual(directionNameOf(2, 0), null, '两格不是「一步」');
  assertEqual(directionNameOf(2, 1), null);
});

test('planStep：空地直线 → reachable 且第一步朝玩家', () => {
  const { world } = makeFlat();
  const r = planStep(world, [10.5, 1, 10.5], [10.5, 1, 4.5]);
  assertTrue(r.reachable);
  assertDeepEqual(r.nextStep, [0, -1], '玩家在北 → 第一步 z-1');
  assertEqual(r.truncated, false);
  assertTrue(r.pathLength >= 5, `路径长度应约等于直线距离，实际 ${r.pathLength}`);
  assertTrue(r.explored > 0 && r.explored <= PATHFIND.maxExplored);
});

test('planStep：直达终点范围（≤1 格）返回 nextStep=null', () => {
  const { world } = makeFlat();
  const r = planStep(world, [10.5, 1, 10.5], [11.5, 1, 10.5]);
  assertTrue(r.reachable);
  assertEqual(r.nextStep, null, '已经贴脸了，不需要下一步');
});

test('planStep：直线被 5 格宽墙挡住 → 仍可达，路径绕过墙端', () => {
  const { world, set } = makeFlat();
  // 墙：x∈[5,9]、z=7（丧尸在 z=10，墙在 3 格外）
  for (let x = 5; x <= 9; x++) for (let dy = 0; dy < 3; dy++) set(x, 1 + dy, 7);
  const r = planStep(world, [7.5, 1, 10.5], [7.5, 1, 2.5]);
  assertTrue(r.reachable, '绕得过去（墙只有 5 格宽）');
  // ⚠️ **两条初版判据都被实测推翻，记在这里避免重犯**：
  // ① 「第一步必须横向」—— 墙在 3 格外时先朝北走是合理的（BFS 给最短路径）；
  // ② 「步数必须比直线多」—— 8 邻接允许斜穿，绕墙端的**斜线**只有 7 步，比直线 8 步更短。
  // 有判别力的判据 = **路径必须离开墙覆盖的 x 区间**（那才是「绕过墙端」的本质）。
  // 这里墙占 x∈[5,9]，丧尸在 x=7 → 绕行必然要走到 x ≥ 10 或 x ≤ 4，即第一步横向离开 x=7。
  const [dx, dz] = r.nextStep;
  assertTrue(dz < 0, `第一步必须朝玩家（实际 [${dx}, ${dz}]）`);
  assertTrue(dx !== 0, `第一步必须横向离开墙的覆盖区间（实际 [${dx}, ${dz}]）`);
});

test('planStep：一格台阶算可走，两格高算墙', () => {
  // 一格台阶：y=1 放一格（表面 y=2，比脚底 y=1 高一格）→ 可走
  const one = makeFlat({ top: 3 });
  one.set(10, 1, 5);
  const r1 = planStep(one.world, [9.5, 1, 5.5], [10.5, 1, 5.5]);
  assertTrue(r1.reachable, '一格台阶必须可规划');

  // 两格高的墙：x=10 整列（z 0..10）封成 3 格高 → 24 格半径内绕不过去
  const two = makeFlat({ top: 3 });
  for (let z = 0; z <= 10; z++) for (let dy = 0; dy < 3; dy++) two.set(10, 1 + dy, z);
  const r2 = planStep(two.world, [7.5, 1, 5.5], [13.5, 1, 5.5]);
  assertFalse(r2.reachable, '整列封死 → 24 格半径内绕不过去');
  // ⚠️ **`truncated` 不必然为 true**：整列只有 11 格长，BFS 的探索前沿会被墙完全挡住，
  // 队列自然耗尽（explored 远小于上限）→ 那是「确认不可达」，不是「探索到上限」。
  // `truncated` 只在**真的撞到半径/格数上限**时才置位（见下一条用例）。
  assertTrue(r2.explored < PATHFIND.maxExplored, `前沿耗尽而非撞上限，实际 explored=${r2.explored}`);
});

test('planStep：半径外不可达 → truncated=true 且 reachable=false（回落 v1）', () => {
  const { world, set } = makeFlat({ size: 128 });
  for (let x = 0; x < 128; x++) for (let dy = 0; dy < 3; dy++) set(x, 1 + dy, 60);
  const r = planStep(world, [64.5, 1, 64.5], [64.5, 1, 40.5]);
  assertFalse(r.reachable, '半径内找不到路');
  assertTrue(r.truncated, '必须是「探索到上限仍未连通」');
  assertEqual(r.nextStep, null);
});

test('planStep：5 格宽墙恰好超出半径时也不误判可达', () => {
  const { world, set } = makeFlat({ size: 128 });
  // 墙在 z=40（距丧尸 24 格），x 从 0 到 127 全封 —— 绕不过
  for (let x = 0; x < 128; x++) for (let dy = 0; dy < 3; dy++) set(x, 1 + dy, 40);
  const r = planStep(world, [64.5, 1, 64.5], [64.5, 1, 20.5], { maxRadius: 24 });
  assertFalse(r.reachable);
});

test('planStep：确定性（同输入同输出）', () => {
  const { world, set } = makeFlat();
  for (let x = 5; x <= 9; x++) for (let dy = 0; dy < 3; dy++) set(x, 1 + dy, 6);
  const a = planStep(world, [7.5, 1, 10.5], [7.5, 1, 2.5]);
  const b = planStep(world, [7.5, 1, 10.5], [7.5, 1, 2.5]);
  assertDeepEqual(a, b);
});
