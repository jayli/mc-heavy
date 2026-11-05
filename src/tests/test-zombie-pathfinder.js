// src/tests/test-zombie-pathfinder.js — 有界 BFS 寻路 + 本地导航（v2.47）
//
// 判据全部落在「规划出的路物理走得通」与「默认设置下寻路真的生效」上。
// ⚠️ **历史的教训写在这里**：v2.46 把寻路挂在「在线 AI 开关」下，而那个开关默认关闭
// ⇒ 玩家实玩时寻路一行都没执行（实测 `plannerEnabled: false, decided: 0`），
// 表现为「丧尸完全没有任何寻路逻辑」。寻路是纯本地计算，**必须常开**。
import { test } from './runner.js';
import { assertEqual, assertFalse, assertTrue, assertDeepEqual } from './assert.js';
import { PATHFIND, DIRECTION_ORDER, ZOMBIE_MAX_STEP, ZOMBIE_STEERING } from '../entities/zombies/zombie-config.js';
import { DEFAULT_BOX, PathCache, directionNameOf, planStep } from '../entities/zombies/zombie-pathfinder.js';
import { DIRECTION_VECTORS, decideStep, memoryFor } from '../entities/zombies/zombie-navigator.js';
import { zombieCollidesAt, zombieStepUpY } from '../entities/zombies/zombie-navigation.js';
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

/**
 * 格坐标可走判据 —— **必须与生产实现同源**（`zombie-system._stepNavigator` 里的 `isWalkable`）。
 * 生产用 `zombieCollidesAt`（懂 AABB 与脚底语义）；测试也用它，别自己用 `isSolid` 拼，
 * 否则测的是另一套判据（初版就这么踩了：把「脚下是地面」误判成不可走）。
 */
function makeWalkable() {
  return (world, bx, y, bz) => {
    if (!zombieCollidesAt(world, bx + 0.5, y, bz + 0.5)) return true;
    const lifted = zombieStepUpY(y);
    return lifted - y <= ZOMBIE_MAX_STEP && !zombieCollidesAt(world, bx + 0.5, lifted, bz + 0.5);
  };
}

// ---------- 常量 ----------

test('PATHFIND：默认半径 24，探索上限覆盖方形搜索域', () => {
  assertEqual(PATHFIND.maxRadius, 24);
  assertTrue(PATHFIND.maxExplored >= (2 * 24 + 1) ** 2);
});

test('DIRECTION_ORDER 与 DIRECTION_VECTORS 键序一致（防方向张冠李戴）', () => {
  assertDeepEqual([...DIRECTION_ORDER], Object.keys(DIRECTION_VECTORS));
});

test('directionNameOf：8 向对齐给出名字，其他返回 null', () => {
  assertEqual(directionNameOf(0, -1), 'north');
  assertEqual(directionNameOf(0, 1), 'south');
  assertEqual(directionNameOf(1, 0), 'east');
  assertEqual(directionNameOf(-1, 0), 'west');
  assertEqual(directionNameOf(1, 1), 'south_east');
  assertEqual(directionNameOf(-1, -1), 'north_west');
  assertEqual(directionNameOf(0, 0), null);
  assertEqual(directionNameOf(2, 0), null);
});

// ---------- BFS ----------

test('planStep：空地直线 → reachable 且第一步朝玩家', () => {
  const { world } = makeFlat();
  const r = planStep(world, [10.5, 1, 10.5], [10.5, 1, 4.5]);
  assertTrue(r.reachable);
  assertDeepEqual(r.nextStep, [0, -1]);
  assertEqual(r.truncated, false);
  assertTrue(r.pathLength >= 5);
});

test('planStep：直达终点范围（≤1 格）返回 nextStep=null', () => {
  const { world } = makeFlat();
  const r = planStep(world, [10.5, 1, 10.5], [11.5, 1, 10.5]);
  assertTrue(r.reachable);
  assertEqual(r.nextStep, null);
});

test('planStep：5 格宽墙 → 仍可达，路径绕过墙端', () => {
  const { world, set } = makeFlat();
  for (let x = 5; x <= 9; x++) for (let dy = 0; dy < 3; dy++) set(x, 1 + dy, 7);
  const r = planStep(world, [7.5, 1, 10.5], [7.5, 1, 2.5]);
  assertTrue(r.reachable);
  const [dx, dz] = r.nextStep;
  assertTrue(dz < 0, `第一步必须朝玩家（实际 [${dx}, ${dz}]）`);
  // 墙占 x∈[5,9]，丧尸在 x=7 → 绕行必须横向离开
  assertTrue(dx !== 0, `第一步必须横向离开墙的覆盖区间（实际 [${dx}, ${dz}]）`);
});

test('planStep：一格台阶算可走，整列封死则不可达', () => {
  const one = makeFlat({ top: 3 });
  one.set(10, 1, 5);
  assertTrue(planStep(one.world, [9.5, 1, 5.5], [10.5, 1, 5.5]).reachable, '一格台阶可规划');

  const two = makeFlat({ top: 3 });
  for (let z = 0; z <= 10; z++) for (let dy = 0; dy < 3; dy++) two.set(10, 1 + dy, z);
  const r2 = planStep(two.world, [7.5, 1, 5.5], [13.5, 1, 5.5]);
  assertFalse(r2.reachable);
  assertTrue(r2.explored < PATHFIND.maxExplored, '前沿耗尽而非撞上限');
});

test('planStep：半径外不可达 → truncated=true', () => {
  const { world, set } = makeFlat({ size: 128 });
  for (let x = 0; x < 128; x++) for (let dy = 0; dy < 3; dy++) set(x, 1 + dy, 60);
  const r = planStep(world, [64.5, 1, 64.5], [64.5, 1, 40.5]);
  assertFalse(r.reachable);
  assertTrue(r.truncated);
  assertEqual(r.nextStep, null);
});

test('planStep：31 格长墙（远超 9x9 窗口）也能规划出绕行', () => {
  const { world, set } = makeFlat({ size: 128 });
  for (let x = 20; x <= 50; x++) for (let dy = 0; dy < 3; dy++) set(x, 1 + dy, 30);
  const r = planStep(world, [35.5, 1, 40.5], [35.5, 1, 20.5]);
  assertTrue(r.reachable, '24 格半径内能绕过 31 格宽的墙（墙端在 15 格外）');
  assertTrue(r.pathLength > 30, `必须绕远（实际 ${r.pathLength}）`);
});

test('planStep：确定性（同输入同输出）', () => {
  const { world, set } = makeFlat();
  for (let x = 5; x <= 9; x++) for (let dy = 0; dy < 3; dy++) set(x, 1 + dy, 6);
  assertDeepEqual(
    planStep(world, [7.5, 1, 10.5], [7.5, 1, 2.5]),
    planStep(world, [7.5, 1, 10.5], [7.5, 1, 2.5]),
  );
});

// ---------- 缓存 ----------

test('PathCache：沿路径前进时命中', () => {
  const { world } = makeFlat();
  const c = new PathCache();
  const a = c.plan(world, [10.5, 1, 10.5], [10.5, 1, 4.5], { agentId: 'z0', nowMs: 0 });
  // ⚠️ 起点必须**恰好在缓存路径上**（`onCachedPath` 是精确匹配，不留 ±1 容差 ——
  // 有容差会让丧尸偏离路线后仍沿旧方向走，那是一个实测 bug，见 onCachedPath 的注释）。
  // 从 (10,10) 朝 (10,4) 的 A* 路径第一格是 (10,9)。
  const b = c.plan(world, [10.5, 1, 9.5], [10.5, 1, 4.5], { agentId: 'z0', nowMs: 500 });
  assertEqual(a, b, '沿路径前进必须复用');
  assertEqual(c.debugState().misses, 1);
  // 偏离路线一格 → 必须重算
  const d = c.plan(world, [13.5, 1, 9.5], [10.5, 1, 4.5], { agentId: 'z0', nowMs: 600 });
  assertEqual(c.debugState().misses, 2, '偏离路线必须重算（精确匹配语义）');
  assertTrue(d.reachable);
});

test('PathCache：目标换格 / 超时 / 不同丧尸 各自重算', () => {
  const { world } = makeFlat();
  const c = new PathCache({ maxAgeMs: 1000 });
  c.plan(world, [10.5, 1, 10.5], [10.5, 1, 4.5], { agentId: 'z0', nowMs: 0 });
  c.plan(world, [10.5, 1, 9.5], [14.5, 1, 4.5], { agentId: 'z0', nowMs: 500 });   // 目标变
  assertEqual(c.debugState().misses, 2);
  c.plan(world, [10.5, 1, 9.5], [14.5, 1, 4.5], { agentId: 'z0', nowMs: 5000 });  // 超时
  assertEqual(c.debugState().misses, 3);
  c.plan(world, [10.5, 1, 9.5], [14.5, 1, 4.5], { agentId: 'z1', nowMs: 5000 });  // 另一只
  assertEqual(c.debugState().misses, 4);
});

test('PathCache：forget(id) 只清该只', () => {
  const { world } = makeFlat();
  const c = new PathCache();
  c.plan(world, [10.5, 1, 10.5], [10.5, 1, 4.5], { agentId: 'z0', nowMs: 0 });
  c.plan(world, [10.5, 1, 10.5], [10.5, 1, 4.5], { agentId: 'z1', nowMs: 0 });
  c.forget('z0');
  c.plan(world, [10.5, 1, 10.5], [10.5, 1, 4.5], { agentId: 'z0', nowMs: 100 });
  assertEqual(c.debugState().misses, 3);
  // z1 的缓存还在（起点在它自己的路径上）→ 命中
  c.plan(world, [10.5, 1, 9.5], [10.5, 1, 4.5], { agentId: 'z1', nowMs: 100 });
  assertEqual(c.debugState().hits, 1);
});

// ---------- 记忆的契约（v2.49 清理后只剩 plan）----------

test('记忆：只保留 plan 一个字段（死字段不得加回来）', () => {
  // v2.49 清理：`visits` / `trail` / `deadEnds` / `lastStep` 原本是喂给已删除的 Jev 模型的
  // 「事实」，删掉 Jev 后它们**只写不读**（`isBacktrack` 只有测试在调）。
  // 每次决策多写一个 Map 和一个数组（20 只 × 20Hz = 每秒 400 次无用写入）→ 全部删除。
  // ⚠️ **加回任何字段前先确认它有生产消费者**，别让死代码再长出来。
  const mem = memoryFor(new Map(), 'z0');
  assertDeepEqual(Object.keys(mem).sort(), ['__id', 'plan']);
});

test('记忆：同 id 复用同一对象，不同 id 独立', () => {
  const m = new Map();
  assertEqual(memoryFor(m, 'a'), memoryFor(m, 'a'));
  assertFalse(memoryFor(m, 'a') === memoryFor(m, 'b'));
});

// ---------- decideStep（本地决策的核心）----------

test('decideStep：空地 → 朝玩家的单位向量', () => {
  const { world } = makeFlat();
  const r = decideStep({
    world, position: [10.5, 1, 10.5], playerPosition: [10.5, 1, 4.5],
    memory: memoryFor(new Map(), 'z0'), pathCache: new PathCache(), nowMs: 0,
    isWalkable: makeWalkable(),
  });
  assertFalse(r.blocked);
  assertEqual(r.mode, 'chasing');
  assertEqual(r.plannedDirection, 'north');
  assertTrue(r.vz < 0, `应朝北，实际 vz=${r.vz}`);
  assertTrue(Math.abs(Math.hypot(r.vx, r.vz) - 1) < 1e-9, '必须是单位向量');
});

test('decideStep：长墙 → 横向绕行（核心用例）', () => {
  const { world, set } = makeFlat();
  for (let x = 20; x <= 50; x++) for (let dy = 0; dy < 3; dy++) set(x, 1 + dy, 30);
  const r = decideStep({
    world, position: [35.5, 1, 40.5], playerPosition: [35.5, 1, 20.5],
    memory: memoryFor(new Map(), 'z0'), pathCache: new PathCache(), nowMs: 0,
    isWalkable: makeWalkable(),
  });
  assertFalse(r.blocked);
  assertTrue(Math.abs(r.vx) > 0.3, `必须横向绕墙（vx=${r.vx}, vz=${r.vz}）`);
});

test('decideStep：不可达（truncated）→ 回落直线朝玩家 + 局部绕行', () => {
  const { world, set } = makeFlat({ size: 128 });
  for (let x = 0; x < 128; x++) for (let dy = 0; dy < 3; dy++) set(x, 1 + dy, 60);
  const r = decideStep({
    world, position: [64.5, 1, 64.5], playerPosition: [64.5, 1, 40.5],
    memory: memoryFor(new Map(), 'z0'), pathCache: new PathCache(), nowMs: 0,
    isWalkable: makeWalkable(),
  });
  assertFalse(r.reachable, 'BFS 不可达');
  assertFalse(r.blocked, '但贴墙仍可沿墙滑行（v2.40 口径）');
});

test('decideStep：四面围死 → blocked（不写任何持久状态 —— 玩家可能拆墙）', () => {
  const { world, set } = makeFlat({ top: 0 });
  // 丧尸 (10,1,10) 周围 8 格全部 3 格高
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue;
      for (let dy = 0; dy < 3; dy++) set(10 + dx, 1 + dy, 10 + dz);
    }
  }
  const mem = memoryFor(new Map(), 'z0');
  const r = decideStep({
    world, position: [10.5, 1, 10.5], playerPosition: [10.5, 1, 18.5],
    memory: mem, pathCache: new PathCache(), nowMs: 0,
    isWalkable: makeWalkable(),
  });
  assertTrue(r.blocked);
  assertEqual(r.mode, 'blocked');
  assertEqual(r.vx, 0);
  assertEqual(r.vz, 0);
  // ⚠️ **blocked 不得往记忆里写任何东西**：这一格只是「此刻」走不出去，玩家随时可能拆墙。
  // 早先版本会 `markDeadEnd`，导致拆墙后仍然 blocked（v2.40 的恢复用例因此失败）；
  // v2.49 起连 `deadEnds` 字段都删了（它只写不读）—— 这里钉住「围死不产生副作用」。
  assertDeepEqual(Object.keys(mem).sort(), ['__id', 'plan'],
    'blocked 不得给记忆加字段');
  assertEqual(mem.plan, null, '围死时没有计划可固化');
});

test('decideStep：规划方向被挡住时沿墙滑行（不直接 blocked）', () => {
  // ⚠️ `top: 0`（地面只到 y=0）—— 若用 `top: 3`，整层 y=1..3 都是实心，
  // 丧尸站的地方本身就被填满了，东西两侧也不可走 → 测出来的是 fixture 错，不是实现错。
  const { world, set } = makeFlat({ top: 0 });
  // 丧尸 (10,1,10)，正北 (10,9) 是 3 格高墙，但东西两侧空
  for (let dy = 0; dy < 3; dy++) set(10, 1 + dy, 9);
  const r = decideStep({
    world, position: [10.5, 1, 10.5], playerPosition: [10.5, 1, 4.5],
    memory: memoryFor(new Map(), 'z0'), pathCache: new PathCache(), nowMs: 0,
    isWalkable: makeWalkable(),
  });
  assertFalse(r.blocked, '必须沿墙滑行而不是站死');
  assertTrue(r.vx !== 0, `应横向绕（vx=${r.vx}）`);
});

test('decideStep：确定性（同输入同输出）', () => {
  const { world, set } = makeFlat();
  for (let x = 20; x <= 50; x++) for (let dy = 0; dy < 3; dy++) set(x, 1 + dy, 30);
  const mk = () => decideStep({
    world, position: [35.5, 1, 40.5], playerPosition: [35.5, 1, 20.5],
    memory: memoryFor(new Map(), 'z0'), pathCache: new PathCache(), nowMs: 0,
    isWalkable: makeWalkable(),
  });
  const a = mk(); const b = mk();
  assertEqual(a.vx, b.vx);
  assertEqual(a.vz, b.vz);
  assertEqual(a.plannedDirection, b.plannedDirection);
});

test('PathCache：不可达结果不缓存（拆墙后必须立刻恢复，实测缺陷）', () => {
  // 回归门：缓存「不可达」会让丧尸在墙被拆开后仍装作没路最多 maxAgeMs（4 秒）。
  // 实测形态：拆墙后 1050ms 仍返回 reachable=false，要到 6000ms 超时才恢复。
  //
  // ⚠️ **前提必须是「真不可达」**：`planStep` 对「目标在半径外」有专门语义
  // （走向半径内离目标最近的可达格），故不能用「远的墙」造不可达 ——
  // 实测踩到两次：① 只封 z∈[0,10] 时 BFS 从墙端绕过去了；
  // ② 封了 128 格长的墙，半径外模式照样给了 reachable=true。
  // 这里改用**把丧尸整圈围死**（8 个方向都封），那才是真·不可达。
  const { world, set } = makeFlat();
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue;
      for (let dy = 0; dy < 3; dy++) set(10 + dx, 1 + dy, 10 + dz);
    }
  }
  const c = new PathCache();
  const pos = [10.5, 1, 10.5];
  const goal = [10.5, 1, 4.5];
  const a = c.plan(world, pos, goal, { agentId: 'z0', nowMs: 1000 });
  assertFalse(a.reachable, '前提：整圈围死 → 不可达');
  // 拆开北面那格（丧尸能走出去了）
  for (let dy = 0; dy < 3; dy++) world.setBlock(10, 1 + dy, 9, 0);
  const b = c.plan(world, pos, goal, { agentId: 'z0', nowMs: 1050 });
  assertTrue(b.reachable, '拆开后必须立刻可达（不得缓存「不可达」）');
});

// ---------- v2.49：绕出障碍后必须直冲玩家，不能沿旧计划回头 ----------

test('PathCache：绕出墙端后不得往回走（用户实测 bug 的回归门）', () => {
  // 用户 2026-11-04：「绕过障碍之后已经可以直线走向玩家了，这时丧尸和玩家之间已经没有障碍了，
  // 但是丧尸直接回头原路返回了，没有走向玩家」。
  //
  // ## 根因（不是缓存，是 `planStep` 用纯 BFS）
  //
  // 等代价 BFS 只保证「步数最少」。目标在 10 格内时常有**多条等步数路径**，BFS 按邻接顺序
  // （N,NE,E,SE,S,SW,W,NW）任选一条 ⇒ 选中「先贴墙、再拐向玩家」那条。
  // 实测：丧尸 (288,170)、玩家 (283,168)，NW `(287,169)` 曼哈顿只有 5（最靠近玩家），
  // 但 BFS 先探到 SW `(287,171)`（曼哈顿 7，**背离玩家**），因为总步数同样是 4。
  // 观感 = 「绕出墙端后又往反方向走」。
  //
  // ## 判据
  //
  // 沿整条绕行路径走一遍，**每一步都必须让「到玩家的距离」不增加**
  // （允许持平：沿墙滑行时确实可能暂时不靠近）。
  // 这条判据直接对应用户看到的现象，且不依赖「缓存必须等于实时」这种过强的假设。
  const { world, set } = makeFlat({ size: 128 });
  for (let x = 20; x <= 40; x++) for (let dy = 0; dy < 3; dy++) set(x, 1 + dy, 30);
  const goal = [30.5, 1, 20.5];
  const c = new PathCache();
  let pos = [30, 40];
  let t = 0;
  let lastDist = Math.hypot(pos[0] - goal[0], pos[1] - goal[2]);
  const regressions = [];
  for (let i = 0; i < 40; i++) {
    const r = c.plan(world, [pos[0] + 0.5, 1, pos[1] + 0.5], goal, { agentId: 'z0', nowMs: t });
    if (!r.reachable || r.nextStep === null) break;
    const nxt = [pos[0] + r.nextStep[0], pos[1] + r.nextStep[1]];
    const dist = Math.hypot(nxt[0] - goal[0], nxt[1] - goal[2]);
    if (dist > lastDist + 1e-9) regressions.push({ from: [...pos], step: r.nextStep, distBefore: +lastDist.toFixed(2), distAfter: +dist.toFixed(2) });
    lastDist = dist;
    pos = nxt;
    t += 500;
  }
  assertEqual(regressions.length, 0,
    `绕行途中不得远离玩家（实测回归：${JSON.stringify(regressions.slice(0, 2))}）`);
});


test('PathCache：nearRadius 默认 1（实测标定值，不是随手取的）', () => {
  // 固定地形、1 格宽窄门、20 只丧尸的对照实测：
  // | nearRadius | 到达 | 命中率 | 真实 A* |
  // | 0（精确）  | 18/20 |  7.5% | 13674 |
  // | **1**      | **18/20** | **66.1%** | 5021 |
  // | 2          | 17/20 | 69.2% | 4545 |
  // ⇒ 取 1：到达率与精确匹配完全相同，真实 A* 少 63%；取 2 只多 3% 命中率却丢一只。
  assertEqual(new PathCache().nearRadius, 1);
});

test('PathCache：拥挤微动仍命中，但计划方向背离目标时立刻重算', () => {
  // 两个判据缺一不可：
  // ① 容忍 ≤nearRadius 的推挤抖动（否则命中率 7%）；
  // ② 计划首步若让「到目标的距离」变大 → 立刻重算（否则会沿旧路径走进墙里，
  //    实测 nearRadius=2 时 20 只只到了 17 只）。
  const { world } = makeFlat();
  const c = new PathCache();
  const goal = [10.5, 1, 4.5];
  c.plan(world, [10.5, 1, 10.5], goal, { agentId: 'z0', nowMs: 0 });
  // 微动 1 格内 → 命中
  c.plan(world, [10.5, 1, 9.5], goal, { agentId: 'z0', nowMs: 500 });
  assertEqual(c.debugState().hits, 1, '沿路径微动必须命中');
  // 偏离很远 → 重算
  c.plan(world, [15.5, 1, 10.5], goal, { agentId: 'z0', nowMs: 600 });
  assertEqual(c.debugState().misses, 2, '远离路径必须重算');
});

// ==================== 可走性参数化（v2.61：焰魔复用同一份 A*）====================
//
// ## 为什么要参数化而不是给焰魔写第二份
//
// 寻路的漂移形态是「一个实体绕得过去、另一个绕不过去」，且两边的注释都自圆其说 ——
// 只能靠实玩发现。故必须同一份实现 + 缺省等于丧尸参数（红线 1）。

/**
 * 一道带门洞的墙：z = 10 这一列全高封死，只在 y ∈ [1, 洞高] 开一个 3 格宽的洞。
 *
 * ⚠️ **必须有地板（y ≤ 0 实心）**：`standable` 的快路径入口是「脚底那格空气 + 脚下实心」——
 * 没有地板就永远走不到快路径，本组用例就测不到「层数」这一层逻辑（实测踩到：
 * 空世界版本下把 `spans` 写死回 2 仍然全绿）。
 */
function makeDoorWorld({ doorHeight }) {
  const inHole = (x, y) => x >= 9 && x <= 11 && y >= 1 && y <= doorHeight;
  const solid = (x, y, z) => {
    if (y <= 0) return true;                       // 地板
    if (z !== 10) return false;
    return !inHole(x, y);                          // 墙（洞以外全是实心）
  };
  return { isSolid: solid, getBlockId: (x, y, z) => (solid(x, y, z) ? 1 : 0) };
}

test('planStep：丧尸缺省参数与显式传 DEFAULT_BOX 逐位相同（零回归硬判据）', () => {
  const { world, set } = makeFlat({ size: 128 });
  for (let x = 20; x <= 50; x++) for (let dy = 0; dy < 3; dy++) set(x, 1 + dy, 30);
  const from = [35.5, 1, 40.5];
  const to = [35.5, 1, 20.5];
  const a = planStep(world, from, to);
  const b = planStep(world, from, to, { box: DEFAULT_BOX });
  // 逐字段比 —— 只比 reachable 会漏掉「nextStep 变了但都可达」这种静默漂移
  assertDeepEqual(b, a, '显式传默认 box 必须与不传逐位相同');
});

test('planStep：门洞高度真的参与可走性（2 格挡丧尸之外、4 格放行）', () => {
  // 焰魔 halfWidth 0.5 / height 3.25 —— 与 IGNIS 常量同值，但不 import 它：
  // 本用例守的是 pathfinder 的通用能力，不该依赖某个 Boss 的配置文件
  const IGNIS_BOX = { halfWidth: 0.5, height: 3.25, maxStep: 1.0 };
  const ZOMBIE_BOX = { halfWidth: 0.3, height: 1.8, maxStep: 1.0 };

  // ⚠️ 洞高 2：丧尸（1.8 高）过得去，焰魔（3.25 高）过不去。
  //   这是「层数写死 2」唯一能被红的地方 —— 快路径只看两层时焰魔会误判可走。
  const low = makeDoorWorld({ doorHeight: 2 });
  assertTrue(planStep(low, [10.5, 1, 13.5], [10.5, 1, 7.5], { box: ZOMBIE_BOX }).reachable,
    '丧尸（1.8 高）应能穿过 2 格高的洞');
  assertFalse(planStep(low, [10.5, 1, 13.5], [10.5, 1, 7.5], { box: IGNIS_BOX }).reachable,
    '焰魔（3.25 高）不得穿过 2 格高的洞');

  // 洞高 4：两者都能过（防止上一条只是「一律不可达」的假阳性）
  const high = makeDoorWorld({ doorHeight: 4 });
  assertTrue(planStep(high, [10.5, 1, 13.5], [10.5, 1, 7.5], { box: IGNIS_BOX }).reachable,
    '焰魔应能穿过 4 格高的洞');
});

test('decideStep：不传 steering/box 时行为与显式传默认值一致（零回归）', () => {
  const { world } = makeFlat();
  const p = [10.5, 1, 10.5];
  const goal = [10.5, 1, 4.5];
  const base = {
    world, position: p, playerPosition: goal, nowMs: 0,
    isWalkable: makeWalkable(),
  };
  const a = decideStep({ ...base, memory: memoryFor(new Map(), 'z0'), pathCache: new PathCache() });
  const b = decideStep({
    ...base, memory: memoryFor(new Map(), 'z0'), pathCache: new PathCache(),
    box: DEFAULT_BOX, steering: ZOMBIE_STEERING,
  });
  assertDeepEqual(b, a, '缺省值必须与显式默认逐位相同');
});
