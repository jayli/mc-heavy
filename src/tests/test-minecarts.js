// src/tests/test-minecarts.js — 矿车 Epic Tier 1 单测
// 覆盖「改坏了肉眼玩不出来」的部分：方向/转弯的模运算、铁轨判定的单一权威、
// 移动系统的跨格与吸附、连挂递归上限、serialize 往返、跨 column 索引迁移。
import { test } from './runner.js';
import { assertEqual, assertNotEqual, assertTrue, assertFalse, assertNull, assertNotNull } from './assert.js';
import * as THREE from 'three';
import {
  MinecartRenderer, createMinecartBodyTexture, createBodyGeometry,
} from '../render/minecart-renderer.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';
import { EntityManager } from '../entities/entity-manager.js';
import {
  MINECART, TRACK_BLOCK_TYPES, MINECART_ITEM, MINECART_TYPE, MOVEMENT, MINECART_AABB,
  directionOf, leftOf, rightOf, rotationAngleOf,
  isTrackBlock, hasTrackAt, hasSolidAt,
} from '../entities/minecarts/minecart-config.js';
import {
  cellKey, availableTrackDirections, alignToTrack, checkTurn, isHeadOn,
  canActivateStatic, findLinked, planMinecartStep,
  minecartDefinition, MinecartService,
} from '../entities/minecarts/minecart-system.js';

function makeRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}

/** 纯世界 fixture：预加载 cx/cz ∈ [-1, 2] 的 column（覆盖 x/z ∈ [-16, 47]）。 */
function makeWorld() {
  const registry = makeRegistry();
  const world = new WorldData(registry);
  for (let cx = -1; cx <= 2; cx++) {
    for (let cz = -1; cz <= 2; cz++) {
      const col = new ChunkColumn(cx, cz);
      col.state = 'ready';
      world.add(col);
    }
  }
  return { world, registry };
}

test('config: 冻结数值对齐 mc-lite GameConfig（速度/上限/连挂/AABB）', () => {
  assertEqual(MINECART.speed, 2.0, '速度 2.0 格/秒（mc-lite MINECART_SPEED，已乘 dt 故不 ×60）');
  assertEqual(MINECART.maxMinecarts, 50, '全局上限 50（mc-lite MAX_MINECARTS）');
  assertEqual(MINECART.maxLinked, 10, '连挂上限 10（mc-lite MAX_LINKED_MINECARTS）');
  assertEqual(MINECART.rideHeight, 0.9, '乘坐高度 0.9（mc-lite 车顶）');
  assertEqual(MINECART.interactRange, 15, '交互射程 15（mc-lite hits[0].distance < 15）');
  assertEqual(MINECART_ITEM, 'mine_cart');
  assertEqual(MINECART_TYPE, 'minecart');
  // AABB 与 mc-lite BOUNDING_BOX 1.0×0.9×1.0 一致（position 是占据格坐标 = 格角 → 盒从 0 起）
  assertEqual(MINECART_AABB.min[0], 0, 'position 是格角 → 盒从 0 起');
  assertEqual(MINECART_AABB.max[0], 1, '盒宽 = width（格角语义）');
  assertEqual(MINECART_AABB.max[1], 0.9);
});

test('config: TRACK_BLOCK_TYPES 两项都在 registry 内（拼错则门控静默失效）', () => {
  const registry = makeRegistry();
  assertEqual(TRACK_BLOCK_TYPES.length, 2);
  for (const name of TRACK_BLOCK_TYPES) {
    assertNotNull(registry.idOf(name), `"${name}" 必须在 registry 内`);
    assertTrue(isTrackBlock(registry.idOf(name), registry), `"${name}" 必须判为铁轨`);
  }
  // 负向：非铁轨方块不得判为铁轨
  assertFalse(isTrackBlock(registry.idOf('stone'), registry), 'stone 不是铁轨');
  assertFalse(isTrackBlock(0, registry), 'id 0（air）不是铁轨');
});

test('directionOf: 四朝向 × 前进/后退', () => {
  assertEqual(directionOf(0, MOVEMENT.FORWARD).x, 1, 'EAST 前进 → +x');
  assertEqual(directionOf(0, MOVEMENT.FORWARD).z, 0);
  assertEqual(directionOf(1, MOVEMENT.FORWARD).z, 1, 'SOUTH 前进 → +z');
  assertEqual(directionOf(2, MOVEMENT.FORWARD).x, -1, 'WEST 前进 → -x');
  assertEqual(directionOf(3, MOVEMENT.FORWARD).z, -1, 'NORTH 前进 → -z');
  assertEqual(directionOf(0, MOVEMENT.BACKWARD).x, -1, 'EAST 后退 → -x');
  assertEqual(directionOf(2, MOVEMENT.BACKWARD).x, 1, 'WEST 后退 → +x');
  // idle 也返回基础方向（mc-lite getDirectionVector 只判 BACKWARD，其余走 base）
  assertEqual(directionOf(0, MOVEMENT.IDLE).x, 1);
  // 越界朝向回落 EAST（mc-lite `|| DIRECTION_VECTORS[0]` 语义）
  assertEqual(directionOf(9, MOVEMENT.FORWARD).x, 1);
});

test('leftOf/rightOf: 与前进方向正交，且公式对齐 mc-lite', () => {
  for (let o = 0; o < 4; o++) {
    const f = directionOf(o, MOVEMENT.FORWARD);
    const l = leftOf(o);
    const r = rightOf(o);
    assertEqual(f.x * l.x + f.z * l.z, 0, `朝向 ${o} 的左向须与前进正交`);
    assertEqual(f.x * r.x + f.z * r.z, 0, `朝向 ${o} 的右向须与前进正交`);
    // mc-lite 公式：left = (-fz, fx)，right = (fz, -fx)
    assertEqual(l.x, -f.z, `朝向 ${o} 左向 x = -forward.z`);
    assertEqual(l.z, f.x, `朝向 ${o} 左向 z = forward.x`);
    assertEqual(r.x, f.z, `朝向 ${o} 右向 x = forward.z`);
    assertEqual(r.z, -f.x, `朝向 ${o} 右向 z = -forward.x`);
  }
});

test('rotationAngleOf: 朝向 → 弧度（渲染层与逻辑层共用）', () => {
  assertEqual(rotationAngleOf(0), 0);
  assertEqual(rotationAngleOf(1), Math.PI / 2);
  assertEqual(rotationAngleOf(2), Math.PI);
  assertEqual(rotationAngleOf(3), Math.PI * 1.5);
});

test('hasTrackAt / hasSolidAt: 读真实世界数据', () => {
  const { world, registry } = makeWorld();
  world.setBlock(4, 10, 4, registry.idOf('sand_train_track'), 0);
  world.setBlock(5, 10, 4, registry.idOf('sand_train_track_corner'), 0);
  world.setBlock(4, 11, 4, registry.idOf('stone'), 0);
  world.setBlock(6, 10, 4, registry.idOf('water'), 0);
  assertTrue(hasTrackAt(world, registry, 4, 10, 4), '直轨格判为铁轨');
  assertTrue(hasTrackAt(world, registry, 5, 10, 4), '角轨格判为铁轨');
  assertFalse(hasTrackAt(world, registry, 4, 11, 4), '石头格不是铁轨');
  assertFalse(hasTrackAt(world, registry, 9, 10, 9), '空气格不是铁轨');
  assertTrue(hasSolidAt(world, registry, 4, 11, 4), '石头判为实心');
  // 负向：非实心方块（water 声明 solid:false，blocks-data.js:20）不得判为实心 ——
  // 缺这条则「忽略 solidTable 恒返 true」的注入抓不到（testing-policy §2.7）。
  assertFalse(hasSolidAt(world, registry, 6, 10, 4), '水声明 solid:false → 不实心');
  assertFalse(hasSolidAt(world, registry, 9, 10, 9), '空气不实心');
  // 铁轨声明 solid:true（blocks-data.js:165）→ 判为实心。这是事实断言，不是同义反复。
  assertTrue(hasSolidAt(world, registry, 4, 10, 4), '铁轨声明 solid:true → 判为实心');
  // fallback：registry 缺省走 world.registry（minecart-config.js 的 `registry ?? world.registry`）
  assertTrue(hasTrackAt(world, null, 4, 10, 4), 'registry=null 时回落 world.registry');
  assertFalse(isTrackBlock(registry.idOf('sand_train_track'), undefined), 'registry=undefined → false（无 registry 可查）');
});

/** 造一辆车的 state（形状与 createState 一致）。 */
function car(x, y, z, orientation = 0, movementState = MOVEMENT.IDLE, extra = {}) {
  return {
    position: [x, y, z], orientation, movementState,
    lastTrack: extra.lastTrack ?? null,
    pendingTargetCell: extra.pendingTargetCell ?? null,
    linked: extra.linked ?? [],
    ...(extra.id ? { id: extra.id } : {}),
  };
}

/** 铺一段铁轨：从 (x0,y,z0) 沿 (dx,dz) 铺 n 格。 */
function layTrack(world, registry, x0, y, z0, dx, dz, n, name = 'sand_train_track') {
  const trackId = registry.idOf(name);
  for (let i = 0; i < n; i++) world.setBlock(x0 + dx * i, y, z0 + dz * i, trackId, 0);
}

/**
 * 最小 service stub。**形状必须与真实 MinecartService 一致**（`carAt` 返回 `{id,state}`
 * 包装、`cars()` 返回数组）—— fake 与真实接线口径不一致会让断言恒真
 * （CLAUDE.md 活跃约束：M6 的 fake pool 盲区）。
 * `carsView`/`carAtRound` 是 fix round 2 新增的跨车读取接口（帧前快照 + round 基）；
 * stub 无帧循环 → 快照即实时。
 */
function makeServiceStub(cars = []) {
  const list = cars.map((c, i) => ({ id: c.id ?? `stub${i}`, state: c }));
  const roundKey = (x, y, z) => `${Math.round(x)},${Math.floor(y)},${Math.round(z)}`;
  return {
    reservations: new Map(),
    cars: () => list,
    carsView: () => list,                       // stub 无帧循环 → 快照即实时
    carAt: (x, y, z) => list.find((e) => cellKey(e.state.position[0], e.state.position[1], e.state.position[2]) === cellKey(x, y, z)) ?? null,
    carAtRound: (x, y, z) => list.find((e) => roundKey(...e.state.position) === roundKey(x, y, z)) ?? null,
  };
}

/** 跑一帧：beginFrame → plan → 应用（测试用的最小循环）。 */
function step(service, state, selfId, dt, world, registry, player = null) {
  return planMinecartStep({ state, dt, world, registry, service, selfId, player });
}

test('cellKey: floor 后拼串（负坐标同样正确）', () => {
  assertEqual(cellKey(1.7, 2.2, 3.9), '1,2,3');
  assertEqual(cellKey(-1.2, 5, -3.8), '-2,5,-4', '负坐标 floor 到更小的整数');
});

test('availableTrackDirections: 只统计车下方一格的四邻铁轨', () => {
  const { world, registry } = makeWorld();
  layTrack(world, registry, 3, 10, 4, 1, 0, 3);      // 车在 (4,11,4) → 铁轨层 y=10
  const dirs = availableTrackDirections(world, registry, 4, 11, 4);
  assertTrue(dirs.includes(0), '东邻有轨 → 含 EAST');
  assertTrue(dirs.includes(2), '西邻有轨 → 含 WEST');
  assertFalse(dirs.includes(1), '南邻无轨');
  assertFalse(dirs.includes(3), '北邻无轨');
  // 负向：铁轨铺在车同层（y=11）不算 —— 判据必须是下方一格
  const w2 = makeWorld();
  layTrack(w2.world, w2.registry, 3, 11, 4, 1, 0, 3);
  assertEqual(availableTrackDirections(w2.world, w2.registry, 4, 11, 4).length, 0, '同层铁轨不算');
});

test('alignToTrack: 可走原样返回；不可走选最近可用；全不可走返回 null', () => {
  const { world, registry } = makeWorld();
  layTrack(world, registry, 3, 10, 4, 1, 0, 3);      // 东西向
  assertEqual(alignToTrack(world, registry, 0, 4, 11, 4), 0, 'EAST 可走 → 原样');
  assertEqual(alignToTrack(world, registry, 2, 4, 11, 4), 2, 'WEST 可走 → 原样');
  const aligned = alignToTrack(world, registry, 3, 4, 11, 4);
  assertTrue(aligned === 0 || aligned === 2, `NORTH 不可走 → 须选到可用方向，实得 ${aligned}`);
  assertNull(alignToTrack(world, registry, 0, 20, 11, 20), '无相邻轨道 → null');
});

test('checkTurn: 左优先 —— 左右都有轨时必转左', () => {
  const { world, registry } = makeWorld();
  // ⚠️ 左右按 `leftOf(0) = {x:0, z:1}` 定：**左 = +z**（z=5）、右 = -z（z=3）。
  // （mc-lite 的注释把 leftOf 说成「顺时针」，但公式给出的是这一侧 —— 照公式不照注释）
  world.setBlock(4, 10, 5, registry.idOf('sand_train_track'), 0);   // 左（+z）
  world.setBlock(4, 10, 3, registry.idOf('sand_train_track'), 0);   // 右（-z）
  const r = checkTurn(world, registry, 0, MOVEMENT.FORWARD, { x: 4, y: 11, z: 4 });
  assertEqual(r.turn, 'left', '左右都有轨 → 左优先（mc-lite 统一转向优先级）');
  assertEqual(r.newOrientation, 1, 'EAST 左转 → SOUTH（(0+1)%4）');
  // 只有右轨（-z 侧）→ 转右
  const w2 = makeWorld();
  w2.world.setBlock(4, 10, 3, w2.registry.idOf('sand_train_track'), 0);
  const r2 = checkTurn(w2.world, w2.registry, 0, MOVEMENT.FORWARD, { x: 4, y: 11, z: 4 });
  assertEqual(r2.turn, 'right');
  assertEqual(r2.newOrientation, 3, 'EAST 右转 → NORTH（(0+3)%4）');
  // 都无轨 → null
  const w3 = makeWorld();
  assertEqual(checkTurn(w3.world, w3.registry, 0, MOVEMENT.FORWARD, { x: 4, y: 11, z: 4 }).turn, null);
});

test('checkTurn: 后退时左右反转（mc-lite 同口径）', () => {
  const { world, registry } = makeWorld();
  // 只在 +z 侧（前进口径的「左」）放轨：前进 → left；后退 → 左右互换 → right
  world.setBlock(4, 10, 5, registry.idOf('sand_train_track'), 0);
  const fwd = checkTurn(world, registry, 0, MOVEMENT.FORWARD, { x: 4, y: 11, z: 4 });
  const bwd = checkTurn(world, registry, 0, MOVEMENT.BACKWARD, { x: 4, y: 11, z: 4 });
  assertEqual(fwd.turn, 'left', '前进时 +z 侧算左');
  assertEqual(bwd.turn, 'right', '后退时同一侧算右（左右互换）');
  assertEqual(bwd.newOrientation, 3, '后退转右 → (0+3)%4');
});

test('isHeadOn: 只有「A 前方是 B 且 B 前方是 A」才判相向', () => {
  // ⚠️ 判据用 **round(position)**（fix round 2 改；**不是** mc-lite 的 floor），故相邻必须是
  // round 后的整数格相邻。为何有意偏离 mc-lite：mc-lite 自身 floor/round **混用**
  // （`MinecartCollisionSystem.js:55` 的 isHeadOn 用 floor，`MinecartMovementSystem.js:479`
  // 的前方格用 round）→ 它自己有相向碰撞死锁（controller 实测核实源码）。本仓库统一 round
  // 是对齐其**意图**（「相向 → 两车都停」）而非其 bug。
  // ⚠️ **勿把实现改回 floor** —— 那会重新引入死锁（本 Epic 花了 2 轮 fix round 才修掉）。
  // 详见 `minecart-system.js` 的 `isHeadOn` 注释。
  const a = car(4, 11, 4, 0, MOVEMENT.FORWARD);      // 朝东，round=4，前方 round=5
  const b = car(5, 11, 4, 2, MOVEMENT.FORWARD);      // 朝西，round=5，前方 round=4
  assertTrue(isHeadOn(a, b), '面对面 → 相向');
  assertFalse(isHeadOn(a, car(5, 11, 4, 0, MOVEMENT.FORWARD)), '同向追尾不是相向');
  assertFalse(isHeadOn(a, car(5, 11, 4, 2, MOVEMENT.IDLE)), 'idle 不判相向');
  assertFalse(isHeadOn(a, car(9, 11, 4, 2, MOVEMENT.FORWARD)), '不相邻不判相向');
  // ⚠️ **小数位判据的基准是 round（fix round 2 改）**：原断言用 floor 口径写
  // 「4.99/5.01 → floor 同为 4/5 → 仍判相向」，但 `planMinecartStep` 找前方车用
  // `frontX = round(position) + dir`，两个基准不一致会在浮点累积下漏判相向 → 永久死锁
  // （controller 实测）。统一到 round 后：round(4.99)=5 与 round(5.01)=5 **同格**，
  // 不再是「相邻」→ isHeadOn 判 false（同格相向由 planMinecartStep 的同格回查分支处理，
  // 见「浮点位置相向碰撞（偶数间距）」用例）。**判据意图不变**：小数位只要 round 到
  // 相邻格就仍判相向。
  assertTrue(isHeadOn(car(4.6, 11, 4, 0, MOVEMENT.FORWARD), car(5.6, 11, 4, 2, MOVEMENT.FORWARD)),
    'round 同为 5/6（相邻）→ 仍判相向');
  assertTrue(isHeadOn(car(4.4, 11, 4, 0, MOVEMENT.FORWARD), car(5.4, 11, 4, 2, MOVEMENT.FORWARD)),
    'round 同为 4/5（相邻）→ 仍判相向');
  // 负向：round 到同一格 → 不是「相邻」，isHeadOn 判 false（同格相向另有分支）
  assertFalse(isHeadOn(car(4.99, 11, 4, 0, MOVEMENT.FORWARD), car(5.01, 11, 4, 2, MOVEMENT.FORWARD)),
    'round 同为 5/5（同格非相邻）→ isHeadOn 判 false');
});

test('canActivateStatic: 前方实心阻挡则不可激活；前方有轨或可转则可', () => {
  const { world, registry } = makeWorld();
  layTrack(world, registry, 3, 10, 4, 1, 0, 4);      // (3..6, 10, 4)
  const moving = car(4, 11, 4, 0, MOVEMENT.FORWARD);
  const staticCar = car(5, 11, 4, 0, MOVEMENT.IDLE);
  assertTrue(canActivateStatic(world, registry, moving, staticCar), '前方 (6,10,4) 有轨 → 可激活');
  world.setBlock(6, 11, 4, registry.idOf('stone'), 0);
  assertFalse(canActivateStatic(world, registry, moving, staticCar), '前方格实心阻挡 → 不可激活');
});

test('findLinked: 沿朝向递归找相邻同朝向车，含自身', () => {
  const cars = [];
  for (let i = 0; i < 5; i++) cars.push(car(2 + i, 11, 4, 0, MOVEMENT.IDLE, { id: `c${i}` }));
  const byId = new Map(cars.map((c) => [c.id, c]));
  const linked = findLinked(byId, 'c2');
  assertEqual(linked.length, 5, '中间那辆应带出整列 5 辆');
  assertTrue(linked.includes('c0') && linked.includes('c4'), '两端都要含');
  // 朝向不同的车不连挂（且隔断后面的车）
  cars[3].orientation = 1;
  const linked2 = findLinked(byId, 'c2');
  assertFalse(linked2.includes('c3'), '朝向不同 → 不连挂');
  assertFalse(linked2.includes('c4'), 'c4 被 c3 隔断 → 不连挂');
});

test('findLinked: 超过 maxLinked 截断（不得无限递归）', () => {
  const cars = [];
  for (let i = 0; i < MINECART.maxLinked + 5; i++) {
    cars.push(car(i, 11, 4, 0, MOVEMENT.IDLE, { id: `c${i}` }));
  }
  const byId = new Map(cars.map((c) => [c.id, c]));
  assertEqual(findLinked(byId, 'c0').length, MINECART.maxLinked, '截断到上限');
});

test('planMinecartStep: idle 车不动，且返回全新对象与全新数组', () => {
  const { world, registry } = makeWorld();
  const s = car(4, 11, 4, 0, MOVEMENT.IDLE);
  const out = step(makeServiceStub(), s, 'c0', 1 / 60, world, registry);
  assertEqual(out.state.position[0], 4, 'idle 不移动');
  assertTrue(out.state !== s, '必须返回全新 state 对象（M6 活跃约束）');
  assertTrue(out.state.position !== s.position, '必须返回全新 position 数组');
  assertEqual(out.deferred.length, 0);
  assertNull(out.liftPlayer);
});

test('planMinecartStep: 直轨上前进 —— 位移 = speed × dt', () => {
  const { world, registry } = makeWorld();
  layTrack(world, registry, 0, 10, 4, 1, 0, 12);
  const dt = 0.1;
  const out = step(makeServiceStub(), car(4, 11, 4, 0, MOVEMENT.FORWARD, { lastTrack: [4, 11, 4] }),
    'c0', dt, world, registry);
  assertEqual(out.state.position[0], 4 + MINECART.speed * dt, `位移须为 speed×dt`);
  assertEqual(out.state.position[2], 4, 'z 不变');
  assertEqual(out.state.movementState, MOVEMENT.FORWARD, '仍在前进');
});

test('planMinecartStep: 轨道尽头无可转 → 停止并吸附到当前轨道格中心', () => {
  const { world, registry } = makeWorld();
  layTrack(world, registry, 0, 10, 4, 1, 0, 6);      // (0..5, 10, 4)，尽头 x=5
  // 从 x=4.99 跨过 round 中心 5 → 触发终点检查；前方 (6,10,4) 无轨、左右无轨 → 停
  const out = step(makeServiceStub(), car(4.99, 11, 4, 0, MOVEMENT.FORWARD, { lastTrack: [4, 11, 4] }),
    'c0', 0.1, world, registry);
  assertEqual(out.state.movementState, MOVEMENT.IDLE, '尽头须停车');
  assertEqual(out.state.position[0], 5, '吸附到当前轨道格中心（round 基准）');
  assertEqual(out.state.position[2], 4);
});

test('planMinecartStep: 前方实心方块（即使有轨道）→ 停', () => {
  const { world, registry } = makeWorld();
  layTrack(world, registry, 0, 10, 4, 1, 0, 12);
  world.setBlock(6, 11, 4, registry.idOf('stone'), 0);
  const out = step(makeServiceStub(), car(4.99, 11, 4, 0, MOVEMENT.FORWARD, { lastTrack: [4, 11, 4] }),
    'c0', 0.1, world, registry);
  assertEqual(out.state.movementState, MOVEMENT.IDLE, '前方实心 → 停');
});

test('planMinecartStep: 相向碰撞 → 两车都停（对方经 deferred 排队，不原地改）', () => {
  const { world, registry } = makeWorld();
  layTrack(world, registry, 0, 10, 4, 1, 0, 12);
  // ⚠️ **a 必须在整数位 5.0，不能是 4.99**：本仓库的 `isHeadOn` 用 **`round(position)`** 判相邻
  // （fix round 2 改；mc-lite 用 floor 而它的前方格查询用 round —— 两者混用正是它自己相向
  // 碰撞死锁的根因，本仓库统一 round 是有意偏离其 bug），前方格用 `round(position)+dir`
  // → 两个判据同源。a=4.99 时 round=5、frontX=6，与 b（round=6）**同格**而非相邻 →
  // `isHeadOn` 判 false（同格相向由 planMinecartStep 的同格回查分支处理，见「浮点位置相向
  // 碰撞（偶数间距）」用例）。a=5.0 时 round=5、frontX=6 → `5+1 === 6` ✓；且 localX=0、
  // newLocalX>0 → 触发跨中心检查。
  // ⚠️ **勿把实现改回 floor** —— 那会重新引入死锁（详见 `isHeadOn` 注释）。
  const a = car(5.0, 11, 4, 0, MOVEMENT.FORWARD, { lastTrack: [5, 11, 4] });
  const b = car(6, 11, 4, 2, MOVEMENT.FORWARD, { lastTrack: [6, 11, 4], id: 'c1' });
  const out = step(makeServiceStub([b]), a, 'c0', 0.1, world, registry);
  assertEqual(out.state.movementState, MOVEMENT.IDLE, '本车停');
  assertEqual(out.deferred.length, 1, '对方须有一条待生效写入');
  assertEqual(out.deferred[0].id, 'c1');
  assertEqual(out.deferred[0].patch.movementState, MOVEMENT.IDLE, '对方也停');
  // ⚠️ 负向验证的关键断言：不得原地改对方 state
  assertEqual(b.movementState, MOVEMENT.FORWARD, '对方 state 不得被原地改写（排队语义）');
});

test('planMinecartStep: 运动车撞静止车 → 激活对方（deferred），本帧不推进自己', () => {
  const { world, registry } = makeWorld();
  layTrack(world, registry, 0, 10, 4, 1, 0, 12);
  const a = car(4.99, 11, 4, 0, MOVEMENT.FORWARD, { lastTrack: [4, 11, 4] });
  const b = car(6, 11, 4, 0, MOVEMENT.IDLE, { id: 'c1' });
  const out = step(makeServiceStub([b]), a, 'c0', 0.1, world, registry);
  assertEqual(out.state.position[0], 4.99, '激活成功时本帧不推进自己（避免重叠入格）');
  assertEqual(out.deferred.length, 1);
  assertEqual(out.deferred[0].patch.movementState, MOVEMENT.FORWARD, '对方继承前进');
  assertEqual(out.deferred[0].patch.orientation, 0, '对方继承朝向');
});

test('planMinecartStep: 前方格被他车声明 pendingTargetCell → 本帧等待但不停车', () => {
  const { world, registry } = makeWorld();
  layTrack(world, registry, 0, 10, 4, 1, 0, 12);
  const other = car(8, 11, 4, 0, MOVEMENT.FORWARD,
    { pendingTargetCell: { x: 6, y: 11, z: 4 }, id: 'c1' });
  const out = step(makeServiceStub([other]),
    car(4.99, 11, 4, 0, MOVEMENT.FORWARD, { lastTrack: [4, 11, 4] }), 'c0', 0.1, world, registry);
  assertEqual(out.state.position[0], 4.99, '声明冲突 → 本帧不动');
  assertEqual(out.state.movementState, MOVEMENT.FORWARD, '但不停车（下一帧再试）');
});

test('planMinecartStep: 玩家在前方且头顶有空间 → 抬起玩家，车继续走', () => {
  const { world, registry } = makeWorld();
  layTrack(world, registry, 0, 10, 4, 1, 0, 12);
  const out = step(makeServiceStub(),
    car(4.99, 11, 4, 0, MOVEMENT.FORWARD, { lastTrack: [4, 11, 4] }),
    'c0', 0.1, world, registry, { position: [6.4, 11, 4.5] });
  assertNotNull(out.liftPlayer, '须给出抬起玩家的意图');
  assertEqual(out.liftPlayer, 11 + MINECART.rideHeight, '抬到车顶 = 车Y + 0.9');
  assertEqual(out.state.movementState, MOVEMENT.FORWARD, '车继续走');
});

test('planMinecartStep: 玩家在前方但头顶被堵 → 停车且不抬', () => {
  const { world, registry } = makeWorld();
  layTrack(world, registry, 0, 10, 4, 1, 0, 12);
  // 车顶 y = 11.9 → 检查 floor(11.9+dy) for dy 0..2 = 11,12,13；堵 (6,13,4)
  world.setBlock(6, 13, 4, registry.idOf('stone'), 0);
  const out = step(makeServiceStub(),
    car(4.99, 11, 4, 0, MOVEMENT.FORWARD, { lastTrack: [4, 11, 4] }),
    'c0', 0.1, world, registry, { position: [6.4, 11, 4.5] });
  assertNull(out.liftPlayer, '头顶无空间不得抬');
  assertEqual(out.state.movementState, MOVEMENT.IDLE, '停车');
});

test('planMinecartStep: 同帧 reservations 防并发入同格', () => {
  const { world, registry } = makeWorld();
  layTrack(world, registry, 0, 10, 4, 1, 0, 12);
  const service = makeServiceStub();
  service.reservations.set(cellKey(5, 11, 4), 'other');   // 另一辆车已预占目标格
  const out = step(service, car(4.6, 11, 4, 0, MOVEMENT.FORWARD, { lastTrack: [4, 11, 4] }),
    'c0', 0.5, world, registry);
  assertEqual(out.state.position[0], 4.6, '目标格被预占 → 本帧不进入');
});

test('planMinecartStep: 转弯 —— 前方无轨但左侧有轨 → 改朝向且本帧不推进', () => {
  const { world, registry } = makeWorld();
  layTrack(world, registry, 0, 10, 4, 1, 0, 6);              // 东西向到 x=5
  // 左侧 = +z（`leftOf(0) = {x:0,z:1}`）→ 在 (5,10,5) 放轨；前方 (6,10,4) 无轨 → 转左
  world.setBlock(5, 10, 5, registry.idOf('sand_train_track'), 0);
  const out = step(makeServiceStub(), car(4.99, 11, 4, 0, MOVEMENT.FORWARD, { lastTrack: [4, 11, 4] }),
    'c0', 0.1, world, registry);
  assertEqual(out.state.orientation, 1, 'EAST 左转 → SOUTH（(0+1)%4）');
  assertEqual(out.state.position[0], 4.99, '转弯帧不推进（mc-lite 同口径）');
});

/**
 * 多帧循环 fixture（模拟 Task 3 的真实 service 接线）：每帧
 * `reservations.clear()` → 捕获帧前快照 → 按 order 逐车 `planMinecartStep`
 * → 收集 deferred → 统一 apply（等价 `service.applyDeferred()`）。
 *
 * ⚠️ **跨车读取必须走帧前快照**（`carsView`/`carAtRound`）—— 实时读会让行为依赖
 * 遍历顺序（先停的车被后跑的车当「静止车」重新激活），fix round 2 实测。
 * @param {Array<[string, object]>} initial [id, state] 列表
 * @param {string[]} order 遍历顺序
 */
function runFrames(world, registry, initial, order, frames = 60, dt = 1 / 60) {
  const cars = new Map(initial.map(([id, state]) => [id, { id, state }]));
  const roundKey = (x, y, z) => `${Math.round(x)},${Math.floor(y)},${Math.round(z)}`;
  let snapList = [];
  let snapRound = new Map();
  // ⚠️ 忠实口径（与 Task 3 真实 service 一致）：`cars()`/`carAt()` 读**实时** state
  // （既有方法），`carsView()`/`carAtRound()` 读**帧前快照**（fix round 2 新增）。
  // 若 carAt 也读快照，则「退回实时读 / 退回 floor 基」的回归抓不到（无效盲区）。
  const liveFloor = () => {
    const m = new Map();
    for (const [id, c] of cars) m.set(cellKey(...c.state.position), { id, state: c.state });
    return m;
  };
  const service = {
    reservations: new Map(),
    cars: () => [...cars.values()],
    carsView: () => snapList,
    carAt: (x, y, z) => liveFloor().get(cellKey(x, y, z)) ?? null,
    carAtRound: (x, y, z) => snapRound.get(roundKey(x, y, z)) ?? null,
  };
  let deferredTotal = 0;
  for (let f = 0; f < frames; f++) {
    service.reservations.clear();
    snapList = [...cars.values()].map((c) => ({ id: c.id, state: c.state }));
    snapRound = new Map();
    for (const c of snapList) snapRound.set(roundKey(...c.state.position), c);
    const pending = [];
    for (const id of order) {
      const c = cars.get(id);
      const out = planMinecartStep({
        state: c.state, dt, world, registry, service, selfId: id, player: null,
      });
      c.state = out.state;
      pending.push(...out.deferred);
    }
    deferredTotal += pending.length;
    for (const { id, patch } of pending) {
      const c = cars.get(id);
      if (c) c.state = { ...c.state, ...patch };
    }
  }
  const fin = {};
  for (const [id, c] of cars) fin[id] = c.state;
  return { fin, deferredTotal };
}

/** 断言两车都停且不重叠（相向碰撞的验收口径，设计文档 §3.2）。 */
function assertBothStoppedApart(r, msg) {
  assertEqual(r.fin.a.movementState, MOVEMENT.IDLE, `${msg}: a 须停`);
  assertEqual(r.fin.b.movementState, MOVEMENT.IDLE, `${msg}: b 须停`);
  assertNotEqual(cellKey(...r.fin.a.position), cellKey(...r.fin.b.position),
    `${msg}: 两车不得重叠同格`);
}

test('planMinecartStep: 浮点位置相向碰撞（偶数间距）→ 两车都停且不重叠，与遍历顺序无关', () => {
  // ⚠️ 回归用例（fix round 2）：真实玩法里车是**连续移动的浮点位置**（会累积成
  // 4.9999999999999964），不是整数位。旧实现在此场景下**永久死锁**（a 卡在 4.9999…
  // 仍 forward、b 完全没动、deferred=0），而整数位用例因 floor==round 恰好通过 ——
  // 典型「断言描述想象中的世界」（testing-policy §2.6 ⑤）。
  // 偶数间距（cell4↔cell6）是最坑的场景：round 格距从 2 **直接跳到 0**，永远不等于 1。
  const { world, registry } = makeWorld();
  layTrack(world, registry, 0, 10, 4, 1, 0, 12);
  const initial = () => [
    ['a', car(4, 11, 4, 0, MOVEMENT.FORWARD, { lastTrack: [4, 11, 4] })],
    ['b', car(6, 11, 4, 2, MOVEMENT.FORWARD, { lastTrack: [6, 11, 4] })],
  ];
  const ab = runFrames(world, registry, initial(), ['a', 'b']);
  assertBothStoppedApart(ab, 'order=[a,b]');
  // 回弹到各自 lastTrack（a→cell4、b→cell6）—— 不是都吸附到相遇格 cell5
  assertEqual(ab.fin.a.position[0], 4, 'a 回弹到自己的 lastTrack（cell4）');
  assertEqual(ab.fin.b.position[0], 6, 'b 回弹到自己的 lastTrack（cell6）');
  // 顺序无关：[b,a] 必须收敛到同一结果
  const ba = runFrames(world, registry, initial(), ['b', 'a']);
  assertBothStoppedApart(ba, 'order=[b,a]');
  assertEqual(ba.fin.a.position[0], ab.fin.a.position[0], 'a 终态与遍历顺序无关');
  assertEqual(ba.fin.b.position[0], ab.fin.b.position[0], 'b 终态与遍历顺序无关');
});

test('planMinecartStep: 浮点位置相向碰撞（奇数间距）→ 走原 frontX 路径，同样都停不重叠', () => {
  // 奇数间距（cell4↔cell5）的 round 格距会经过 1 → 走「frontX 查到对方 + isHeadOn」
  // 原路径（与偶数间距的「同 round 格回查」是两条不同路径，两条都要绿）。
  const { world, registry } = makeWorld();
  layTrack(world, registry, 0, 10, 4, 1, 0, 12);
  const initial = () => [
    ['a', car(4, 11, 4, 0, MOVEMENT.FORWARD, { lastTrack: [4, 11, 4] })],
    ['b', car(5, 11, 4, 2, MOVEMENT.FORWARD, { lastTrack: [5, 11, 4] })],
  ];
  for (const order of [['a', 'b'], ['b', 'a']]) {
    const r = runFrames(world, registry, initial(), order);
    assertBothStoppedApart(r, `order=[${order}]`);
  }
  assertEqual(runFrames(world, registry, initial(), ['a', 'b']).fin.a.position[0], 4,
    'a 回弹到 cell4');
});

test('planMinecartStep: 同向同格不误伤 —— 同 round 格但同向时不得互停', () => {
  // 边界防护（controller 裁定）：同 round 格回查**只对反向**触发相向；同向车必须忽略
  // （那是「跟车」不是「撞车」）。若误伤会让同向列车互等 → 新死锁。
  const { world, registry } = makeWorld();
  layTrack(world, registry, 0, 10, 4, 1, 0, 12);
  const r = runFrames(world, registry, [
    ['a', car(5.0, 11, 4, 0, MOVEMENT.FORWARD, { lastTrack: [5, 11, 4] })],
    ['b', car(5.2, 11, 4, 0, MOVEMENT.FORWARD, { lastTrack: [5, 11, 4] })],
  ], ['a', 'b'], 20);
  assertEqual(r.fin.a.movementState, MOVEMENT.FORWARD, '同向同格 → a 不得被停');
  assertEqual(r.fin.b.movementState, MOVEMENT.FORWARD, '同向同格 → b 不得被停');
  assertEqual(r.deferredTotal, 0, '同向同格 → 不得产生任何跨车写入');
});

// ---------------------------------------------------------------- Task 3：definition + service

/** service fixture：真 EntityManager + 真 world + 假 persistence（entitiesCache 形状一致）。 */
function makeServiceFixture({ cached = [] } = {}) {
  const { world, registry } = makeWorld();
  const entities = new EntityManager();
  entities.registerType(MINECART_TYPE, minecartDefinition);
  const entitiesCache = new Map();
  for (const snap of cached) entitiesCache.set(snap.id, snap);
  // ⚠️ 假 persistence 必须建模真实的 cache 副作用（fix round 1）：真实 `flushEntities`
  // = `saveEntities(serializePersistent())` = **upsert 进 entitiesCache**（persistence.js:159-175），
  // 真实 `deleteEntity` = 从 cache 删 + 删 store 行。写成 no-op 会让「拾取后 count()===0」
  // 只在省略了 cache 副作用的假对象上成立 —— 与 M6 fake WorkerPool 盲区同型
  // （fake 与真实接线口径不一致 → 断言恒真，泄漏抓不到）。
  const persistence = {
    entitiesCache,
    flushEntities: async () => {
      for (const snap of entities.serializePersistent()) entitiesCache.set(snap.id, snap);
    },
    deleteEntity: async (id) => { entitiesCache.delete(id); },
  };
  const service = new MinecartService({ entities, world, registry, persistence });
  return { world, registry, entities, service, persistence };
}

test('definition: create 校验 state 形状（非法 position → null）', () => {
  assertNotNull(minecartDefinition.create({ position: [1, 2, 3] }));
  assertNull(minecartDefinition.create({ position: [1, 2] }), '长度不足 → null');
  assertNull(minecartDefinition.create({ position: [1, NaN, 3] }), 'NaN → null');
  assertNull(minecartDefinition.create({}), '无 position → null');
  const s = minecartDefinition.create({ position: [1, 2, 3] });
  assertEqual(s.orientation, 0);
  assertEqual(s.movementState, MOVEMENT.IDLE);
  assertNull(s.lastTrack);
  assertNull(s.pendingTargetCell);
  assertEqual(s.linked.length, 0);
});

test('definition: serialize/deserialize 往返（瞬态字段不入 snapshot）', () => {
  const s = minecartDefinition.create({
    position: [4, 11, 4], orientation: 2, movementState: MOVEMENT.FORWARD,
    lastTrack: [3, 11, 4], pendingTargetCell: { x: 5, y: 11, z: 4 }, linked: ['c1'],
  });
  const snap = minecartDefinition.serialize(s);
  assertEqual(snap.position[0], 4);
  assertEqual(snap.orientation, 2);
  assertEqual(snap.movementState, MOVEMENT.FORWARD);
  assertEqual(snap.lastTrack[0], 3);
  assertTrue(!('pendingTargetCell' in snap), 'pendingTargetCell 是瞬态，不入档');
  assertTrue(!('linked' in snap), 'linked 是瞬态，不入档');
  const back = minecartDefinition.deserialize(snap);
  assertEqual(back.orientation, 2);
  assertEqual(back.movementState, MOVEMENT.FORWARD);
  assertNull(back.pendingTargetCell, '恢复后瞬态字段重置');
  assertNull(minecartDefinition.deserialize(null));
  assertNull(minecartDefinition.deserialize({ position: [1, 2] }));
});

test('definition: raycastAabb 用矿车 AABB（1.0×0.9×1.0，position 是格角）', () => {
  const s = minecartDefinition.create({ position: [4, 11, 4] });
  // 盒 x∈[4,5] y∈[11,11.9] z∈[4,5]（格角语义）；从 (4.4,11.5,0) 往 +z 射
  const dist = minecartDefinition.raycastAabb(s, [4.4, 11.5, 0], [0, 0, 1], 20);
  assertNotNull(dist, '须命中');
  assertTrue(Math.abs(dist - 4.0) < 0.01, `命中距离应约 4.0（z 从 0 到 4），实得 ${dist}`);
  assertNull(minecartDefinition.raycastAabb(s, [4.5, 20, 4.5], [1, 0, 0], 20), 'y=20 不在盒内');
});

test('service.place: 铁轨上方空气格放置成功，朝向取铁轨 meta', () => {
  const f = makeServiceFixture();
  layTrack(f.world, f.registry, 3, 10, 4, 1, 0, 4);
  f.world.setBlock(4, 10, 4, f.registry.idOf('sand_train_track'), 2);   // meta 朝向 2
  const r = f.service.place({ cell: [4, 11, 4] });
  assertTrue(r.ok, `放置须成功，实得 ${JSON.stringify(r)}`);
  assertEqual(f.service.count(), 1);
  const st = f.entities.get(r.id).state;
  assertEqual(st.orientation, 2, '朝向须取下方铁轨的 meta（东西向直轨上 2=WEST 可用）');
  assertEqual(st.movementState, MOVEMENT.IDLE, '新放置的车是静止的');
  assertNotNull(f.service.carAt(4, 11, 4), '位置索引已建');
});

test('service.place: 四种失败原因各自可辨，且零副作用', () => {
  const f = makeServiceFixture();
  layTrack(f.world, f.registry, 3, 10, 4, 1, 0, 4);
  assertEqual(f.service.place({ cell: [4, 11, 20] }).reason, 'no-track', '下方无铁轨');
  f.world.setBlock(5, 11, 4, f.registry.idOf('stone'), 0);
  assertEqual(f.service.place({ cell: [5, 11, 4] }).reason, 'not-air', '目标格非空气');
  const first = f.service.place({ cell: [4, 11, 4] });
  assertTrue(first.ok);
  assertEqual(f.service.place({ cell: [4, 11, 4] }).reason, 'occupied', '该格已有车');
  assertEqual(f.service.place({ cell: [400, 11, 400] }).reason, 'no-column', '未加载 column');
  assertEqual(f.service.count(), 1, '失败路径不得产生实体');
});

test('service.place: 全局上限来自 entities store（走远再回来不能无限放）', () => {
  const cached = [];
  for (let i = 0; i < MINECART.maxMinecarts; i++) {
    cached.push({
      id: `minecart-${i}`, type: MINECART_TYPE,
      state: { position: [1000 + i, 11, 1000], orientation: 0, movementState: MOVEMENT.IDLE, lastTrack: null },
    });
  }
  const f = makeServiceFixture({ cached });
  layTrack(f.world, f.registry, 3, 10, 4, 1, 0, 4);
  const r = f.service.place({ cell: [4, 11, 4] });
  assertTrue(!r.ok, '已达上限须拒绝');
  assertEqual(r.reason, 'limit');
  assertEqual(f.service.count(), MINECART.maxMinecarts, '计数须含未加载的');
});

test('service.place: id 确定性派生（minecart-N，不用 Math.random）', () => {
  const f = makeServiceFixture({
    cached: [{
      id: 'minecart-7', type: MINECART_TYPE,
      state: { position: [1000, 11, 1000], orientation: 0, movementState: MOVEMENT.IDLE, lastTrack: null },
    }],
  });
  layTrack(f.world, f.registry, 3, 10, 4, 1, 0, 8);
  const r = f.service.place({ cell: [4, 11, 4] });
  assertEqual(r.id, 'minecart-8', '须取最大后缀 +1（cache 里有 minecart-7）');
});

test('service.pickUp: 移除实体 + 清索引；重复拾取返回 false', () => {
  const f = makeServiceFixture();
  layTrack(f.world, f.registry, 0, 10, 4, 1, 0, 8);
  const a = f.service.place({ cell: [4, 11, 4] });
  assertTrue(f.service.pickUp(a.id));
  assertNull(f.entities.get(a.id), '实体须已 despawn');
  assertNull(f.service.carAt(4, 11, 4), '索引须已清');
  assertEqual(f.service.count(), 0);
  assertFalse(f.service.pickUp(a.id), '重复拾取返回 false');
});

test('service.activate: 可走才激活；带出整列连挂车；后退参数生效', () => {
  const f = makeServiceFixture();
  layTrack(f.world, f.registry, 0, 10, 4, 1, 0, 12);
  const a = f.service.place({ cell: [4, 11, 4] });
  const b = f.service.place({ cell: [3, 11, 4] });   // 相邻同朝向 → 连挂
  assertTrue(f.service.activate(a.id, false));
  assertEqual(f.entities.get(a.id).state.movementState, MOVEMENT.FORWARD);
  assertEqual(f.entities.get(b.id).state.movementState, MOVEMENT.FORWARD, '连挂车一起激活');
  const c = f.service.place({ cell: [8, 11, 4] });
  assertTrue(f.service.activate(c.id, true));
  assertEqual(f.entities.get(c.id).state.movementState, MOVEMENT.BACKWARD, 'shift → 后退');
  // 孤格铁轨（四周无邻轨）→ 不可激活
  f.world.setBlock(30, 10, 4, f.registry.idOf('sand_train_track'), 0);
  const e = f.service.place({ cell: [30, 11, 4] });
  assertTrue(e.ok, '孤格铁轨上可放置');
  assertFalse(f.service.activate(e.id, false), '孤格无邻轨 → 不可激活');
  assertEqual(f.entities.get(e.id).state.movementState, MOVEMENT.IDLE);
});

test('service.destroyInRadius: 爆炸中心距车中心 ≤ 半径才摧毁（mc-lite 偏移口径）', () => {
  const f = makeServiceFixture();
  layTrack(f.world, f.registry, 0, 10, 4, 1, 0, 20);
  const near = f.service.place({ cell: [4, 11, 4] });
  const far = f.service.place({ cell: [15, 11, 4] });
  const n = f.service.destroyInRadius([4, 11, 4], MINECART.explosionRadius);
  assertEqual(n, 1, '只摧毁半径内那辆');
  assertNull(f.entities.get(near.id));
  assertNotNull(f.entities.get(far.id), '半径外的车须保留');
});

test('service: EntityManager.update 驱动移动 + 跨 column 索引迁移', () => {
  const f = makeServiceFixture();
  layTrack(f.world, f.registry, 0, 10, 4, 1, 0, 41);   // x 0..40，跨 cx 0/1/2
  const r = f.service.place({ cell: [14, 11, 4] });
  f.service.activate(r.id, false);
  for (let i = 0; i < 200; i++) {
    f.service.beginFrame();
    f.entities.update(1 / 60, { world: f.world, registry: f.registry, minecarts: f.service });
    f.service.applyDeferred();
    f.service.syncIndex();
  }
  const st = f.entities.get(r.id).state;
  assertTrue(st.position[0] > 16, `车须已跨过 column 边界（x=16），实得 x=${st.position[0]}`);
  // ✅ column key 格式已核实：`voxel/constants.js` 的 `columnKey(cx,cz)` = `cx + ',' + cz`，
  // `columnKeyAt(x,z)` = `columnKey(floor(x/16), floor(z/16))` → x=14 属 '0,0'、x=17 属 '1,0'
  const keys = [];
  for (const entity of f.entities.entitiesInColumn('0,0')) keys.push(entity.id);
  assertFalse(keys.includes(r.id), '旧 column（0,0）索引须已清');
  const newKeys = [];
  for (const entity of f.entities.entitiesInColumn('1,0')) newKeys.push(entity.id);
  assertTrue(newKeys.includes(r.id), '新 column（1,0）索引须已建');
  assertNotNull(f.service.carAt(Math.floor(st.position[0]), 11, 4), 'service 位置索引同步');
});

test('definition.update: 带真实 player context（{position}）不抛错且抬玩家生效', () => {
  // ⚠️ **钉住 context.player 的契约形状**：`{position:[x,y,z]}` 对象（mc-lite
  // `checkPlayerCollision` 入参形状）。真游戏页曾传裸数组 → `resolvePlayerBlocking` 解构
  // `player.position`（undefined）抛 "undefined is not iterable" → 帧循环中断 → 车永远
  // 停在起点（idle 车在步骤①早退不读 player，故只有车真移动时才暴露；本用例补上
  // 「definition 层带真实 player context」这个盲区 —— 此前单测传对象给 planMinecartStep、
  // 传 null 给 entities.update，两头都没钉住接线形状）。
  const f = makeServiceFixture();
  layTrack(f.world, f.registry, 0, 10, 4, 1, 0, 12);
  const r = f.service.place({ cell: [4, 11, 4] });
  f.service.activate(r.id, false);
  // 玩家在前方格内、脚底与车同层 → 跨中心帧应被抬到车顶。
  // ⚠️ 几何先实算再定值：车在整数格 x=4 → 首帧即跨中心（localX=0），frontX=round(4)+1=5；
  // overlapsX 要求 px−0.3 < 6 且 px+0.3 > 5 → px ∈ (4.7, 6.3)，故取 5.4（不是 6.4 ——
  // 6.4 不重叠前方格，抬玩家不触发，断言会假失败）。
  const ctx = {
    world: f.world, registry: f.registry, minecarts: f.service,
    player: { position: [5.4, 11, 4.5] },
  };
  let threw = null;
  f.service.beginFrame();
  try {
    f.entities.update(0.1, ctx);
    f.service.applyDeferred();
  } catch (e) { threw = e; }
  assertNull(threw, `definition.update 带 {position} context 不得抛错，实得 ${threw}`);
  assertNotNull(f.service.pendingPlayerLift, '玩家应被抬起（pendingPlayerLift 非 null）');
  assertEqual(f.service.pendingPlayerLift, 11 + MINECART.rideHeight, '抬到车顶 = 车Y + 0.9');
  // ⚠️ 本用例钉住的是**消费侧契约**（definition 层读到 `{position}` 就能工作）。
  // 生产侧（game.js 帧循环传的形状）由 E2E `tests/minecarts.spec.mjs` 的「激活与移动」
  // 与「乘坐穿低矮隧道」两条钉住 —— 它们实测过 FAIL（裸数组 → 每帧抛错 → 车不动）。
});

test('service: 两阶段卸载 —— 冻结期不推进，commit 后实体回收', () => {
  const f = makeServiceFixture();
  layTrack(f.world, f.registry, 0, 10, 4, 1, 0, 12);
  const r = f.service.place({ cell: [4, 11, 4] });
  f.service.activate(r.id, false);
  const unload = f.entities.beginColumnUnload('0,0');
  assertEqual(unload.snapshots.length, 1, '持久实体须进 snapshot');
  assertEqual(unload.snapshots[0].type, MINECART_TYPE);
  const frozenX = f.entities.get(r.id).state.position[0];
  f.service.beginFrame();
  f.entities.update(1 / 60, { world: f.world, registry: f.registry, minecarts: f.service });
  f.service.applyDeferred();
  assertEqual(f.entities.get(r.id).state.position[0], frozenX, '冻结期不得推进');
  unload.commit();
  assertNull(f.entities.get(r.id), 'commit 后须回收');
  f.service.syncIndex();
  assertNull(f.service.carAt(4, 11, 4), 'service 索引须同步清');
});

test('service: applyDeferred 生效跨车写入（相向碰撞双方都停且不重叠）', () => {
  const f = makeServiceFixture();
  layTrack(f.world, f.registry, 0, 10, 4, 1, 0, 12);
  const a = f.service.place({ cell: [4, 11, 4] });
  const b = f.service.place({ cell: [6, 11, 4] });
  f.service.activate(a.id, false);
  // b 改成朝西前进（面对面）—— 经 definition.create 重建（守新对象约束）
  const bEntity = f.entities.get(b.id);
  bEntity.state = minecartDefinition.create({
    ...bEntity.state, orientation: 2, movementState: MOVEMENT.FORWARD,
  });
  let deferredTotal = 0;
  for (let i = 0; i < 60; i++) {
    f.service.beginFrame();
    f.entities.update(1 / 60, { world: f.world, registry: f.registry, minecarts: f.service });
    deferredTotal += f.service.applyDeferred();
    f.service.syncIndex();
  }
  assertEqual(f.entities.get(a.id).state.movementState, MOVEMENT.IDLE, 'A 须停');
  assertEqual(f.entities.get(b.id).state.movementState, MOVEMENT.IDLE, 'B 须停（deferred 生效）');
  // ⚠️ 必须证明是**跨车 deferred 路径**让两车停下，而不是各自撞到轨道尽头碰巧停
  // （reviewer Minor ⑤：同 round 格相向为单侧检出，另一侧靠对方 deferred patch 停）。
  assertTrue(deferredTotal >= 1, `须至少生效一条跨车写入，实得 ${deferredTotal}`);
  const ax = Math.round(f.entities.get(a.id).state.position[0]);
  const bx = Math.round(f.entities.get(b.id).state.position[0]);
  assertTrue(ax !== bx, `两车不得停在同格，实得 ${ax} / ${bx}`);
  // 回弹 lastTrack：a 回 cell4、b 回 cell6（不是都吸到相遇格 5）
  assertEqual(ax, 4, 'A 回弹到自己的 lastTrack（cell4）');
  assertEqual(bx, 6, 'B 回弹到自己的 lastTrack（cell6）');
});

test('service.ridingCarFor: 站在车顶才返回（绑定容差 0.3）', () => {
  const f = makeServiceFixture();
  layTrack(f.world, f.registry, 0, 10, 4, 1, 0, 12);
  f.service.place({ cell: [4, 11, 4] });
  assertNotNull(f.service.ridingCarFor([4.5, 11.9, 4.5]), '站在车顶 → 命中');
  assertNotNull(f.service.ridingCarFor([4.5, 12.05, 4.5]), '容差 0.3 内 → 命中');
  assertNull(f.service.ridingCarFor([4.5, 13.0, 4.5]), '太高 → 不命中');
  assertNull(f.service.ridingCarFor([4.5, 10.0, 4.5]), '在车下方 → 不命中');
  assertNull(f.service.ridingCarFor([8.5, 11.9, 8.5]), '水平不在车上 → 不命中');
});

test('service: 相向回弹跨 column 后 EntityManager 派生索引随之迁移（reindexColumn）', () => {
  // ⚠️ 回归用例：`applyDeferred` 在 EntityManager.update 循环**之外**写 position
  // （相向回弹 lastTrack 可跨 column 边界），绕过 update 的 before/after 索引迁移 →
  // 索引永久停在旧 column（车 idle 后 before===after 不自愈）→ 旧 column 卸载会误回收
  // 实际已离开的车。probe 实测（.tmp-probe-column-index.mjs）：修复前 entitiesInColumn
  // 报告 B 在 '1,0'（STALE），真实位置 column 是 '0,0'。
  const f = makeServiceFixture();
  // 直轨跨 column 边界：x=10..20（cx 0 覆盖 x 0..15，cx 1 覆盖 x 16..31）
  layTrack(f.world, f.registry, 10, 10, 4, 1, 0, 11);
  const a = f.service.place({ cell: [15, 11, 4] });   // cx 0
  const b = f.service.place({ cell: [16, 11, 4] });   // cx 1
  f.service.activate(a.id, false);
  // B 改成朝西前进，位置推到 16.4（cx 1），lastTrack 记在 cell15（cx 0）——
  // 相向回弹会把它拉回 cx 0（与 probe 场景逐位一致）
  const bEntity = f.entities.get(b.id);
  bEntity.state = minecartDefinition.create({
    ...bEntity.state, orientation: 2, movementState: MOVEMENT.FORWARD,
    position: [16.4, 11, 4], lastTrack: [15, 11, 4],
  });
  f.service.syncIndex();
  let deferredTotal = 0;
  for (let i = 0; i < 10; i++) {
    f.service.beginFrame();
    f.entities.update(1 / 60, { world: f.world, registry: f.registry, minecarts: f.service });
    deferredTotal += f.service.applyDeferred();
    f.service.syncIndex();
  }
  assertTrue(deferredTotal >= 1, `须走跨车 deferred 路径，实得 ${deferredTotal}`);
  const bState = f.entities.get(b.id).state;
  assertEqual(bState.movementState, MOVEMENT.IDLE, 'B 须停');
  assertEqual(Math.round(bState.position[0]), 15, 'B 回弹到 lastTrack（cell15，cx 0）');
  // 派生 column 索引必须跟随回弹迁移
  const inOld = [];
  for (const entity of f.entities.entitiesInColumn('1,0')) inOld.push(entity.id);
  assertFalse(inOld.includes(b.id), '旧 column（1,0）索引须已清');
  const inNew = [];
  for (const entity of f.entities.entitiesInColumn('0,0')) inNew.push(entity.id);
  assertTrue(inNew.includes(b.id), '新 column（0,0）索引须已建');
});

// ---------------------------------------------------------------- fix round 1：store 单删

test('service: 拾取的车不占全局上限槽位（store 行被删）', () => {
  const f = makeServiceFixture();
  layTrack(f.world, f.registry, 0, 10, 4, 1, 0, 12);
  const r = f.service.place({ cell: [4, 11, 4] });
  // 模拟真实路径：放置后 flush（写进 cache）
  return f.persistence.flushEntities().then(() => {
    assertEqual(f.service.count(), 1, '放置后 count=1');
    f.service.pickUp(r.id);
    return f.persistence.flushEntities();   // 拾取后 flush
  }).then(() => {
    assertEqual(f.service.count(), 0, '拾取后 count 必须回 0（store 行已删，不再占槽位）');
    assertEqual(f.persistence.entitiesCache.size, 0, 'cache 里不得残留已拾取的车');
  });
});

test('service: 拾取的车 reload 后不复活', () => {
  const f = makeServiceFixture();
  layTrack(f.world, f.registry, 0, 10, 4, 1, 0, 12);
  const r = f.service.place({ cell: [4, 11, 4] });
  return f.persistence.flushEntities().then(() => {
    f.service.pickUp(r.id);
    return f.persistence.flushEntities();
  }).then(() => {
    // 模拟 reload：从 cache 恢复
    const restored = new EntityManager();
    restored.registerType(MINECART_TYPE, minecartDefinition);
    const res = restored.restorePersistent([...f.persistence.entitiesCache.values()]);
    assertEqual(res.restored, 0, '已拾取的车不得从 cache 复活');
  });
});

test('service: carsView/carAtRound 返回帧前快照（帧内改 state 不影响跨车读取）', () => {
  // 直接钉住快照语义（fix round 1 Minor 1）：此前只被相向测试**间接**覆盖（单一插入顺序）。
  // 若把 carAtRound 改成返回实时 state 本用例 FAIL —— 正是它要钉住的。
  const f = makeServiceFixture();
  layTrack(f.world, f.registry, 0, 10, 4, 1, 0, 12);
  const r = f.service.place({ cell: [4, 11, 4] });
  f.service.activate(r.id, false);   // 让帧前 state 是 FORWARD（place 出来是 IDLE）
  f.service.beginFrame();   // 捕获快照
  const snapState = f.service.carAtRound(4, 11, 4)?.state;
  assertNotNull(snapState, '快照里须能查到车');
  // 帧内带外改 entity.state（模拟 EntityManager.update 立即生效）
  const entity = f.entities.get(r.id);
  entity.state = minecartDefinition.create({ ...entity.state, movementState: MOVEMENT.IDLE });
  // 跨车读取必须仍返回**帧前**的 state（不是刚改的）
  const after = f.service.carAtRound(4, 11, 4)?.state;
  assertTrue(after === snapState, 'carAtRound 须返回帧前快照对象（顺序无关的关键）');
  assertNotEqual(after.movementState, MOVEMENT.IDLE, '快照里的 movementState 是帧前的 forward');
});

// ── Task 4：渲染器（几何 / 纹理 / InstancedMesh 池 / sync 差集驱动）─────────────

test('renderer: 车斗几何是倒梯形开口盒（5 面 20 顶点，底部内缩 0.8）', () => {
  const g = createBodyGeometry();
  const pos = g.getAttribute('position');
  assertEqual(pos.count, 20, '5 个四边形 = 20 顶点（mc-lite addFace 逐面 4 顶点）');
  assertEqual(g.getIndex().count, 30, '5 面 × 2 三角 × 3 = 30 索引');
  let maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let hasShrunk = false;
  const bottomHalf = MINECART.bodyWidth * MINECART.bodyShrinkRatio / 2;
  for (let i = 0; i < pos.count; i++) {
    maxX = Math.max(maxX, pos.getX(i));
    minY = Math.min(minY, pos.getY(i));
    maxY = Math.max(maxY, pos.getY(i));
    if (Math.abs(Math.abs(pos.getX(i)) - bottomHalf) < 1e-6) hasShrunk = true;
  }
  // ⚠️ Float32BufferAttribute 会把 0.45/0.8 舍入成 float32（实测 0.44999998807907104 /
  // 0.800000011920929）—— 舍入到 1e-6 再比，同 test-zombies 的 round6 口径（testing-policy §2.5）
  assertEqual(Math.round(maxX * 1e6) / 1e6, MINECART.bodyWidth / 2, '顶部半宽 = 0.45');
  assertEqual(Math.round((maxY - minY) * 1e6) / 1e6, MINECART.bodyHeight, '高度 = 0.8');
  assertTrue(hasShrunk, '底部须内缩到 0.36（倒梯形）');
  assertEqual(g.getAttribute('uv').count, 20, 'UV 与顶点同数');
});

test('renderer: 车斗纹理是 128² canvas 产物（运行时生成）', () => {
  const tex = createMinecartBodyTexture();
  assertNotNull(tex);
  assertEqual(tex.image.width, MINECART.textureSize);
  assertEqual(tex.image.height, MINECART.textureSize);
  assertEqual(tex.magFilter, THREE.NearestFilter, 'mc-lite 同口径：mag 用 Nearest');
  assertTrue(tex.generateMipmaps, 'min 用 mipmap');
  tex.dispose();
});

test('renderer: 两个 InstancedMesh，容量从 config 派生，初始 visible=false', () => {
  const scene = new THREE.Scene();
  const r = new MinecartRenderer({ scene });
  assertNotNull(r.meshes.body);
  assertNotNull(r.meshes.wheel);
  assertEqual(r.meshes.body.count, MINECART.maxMinecarts, '车斗容量 = 上限 50');
  assertEqual(r.meshes.wheel.count, MINECART.maxMinecarts * 4, '车轮容量 = 50×4');
  assertFalse(r.meshes.body.visible, '零实例时不得提交渲染（M6 活跃约束）');
  assertFalse(r.meshes.wheel.visible);
  assertEqual(r.slotCount(), 0);
  // ⚠️ **材质必须是 unlit（MeshBasicMaterial）** —— mc-heavy 全场景 unlit 设计，灯光只为
  // PBR 武器模型而设（`zombie-renderer.js:32` 同口径）。用 MeshStandardMaterial 会让矿车
  // 吃到为枪标定的 2.3 环境光 → 偏亮且随日夜漂移。这条断言钉住该决定。
  assertEqual(r.meshes.body.material.type, 'MeshBasicMaterial',
    '车斗材质须 unlit（不得用 MeshStandardMaterial）');
  assertEqual(r.meshes.wheel.material.type, 'MeshBasicMaterial', '车轮材质须 unlit');
  r.dispose();
});

test('renderer.sync: 差集驱动 slot，矩阵含 +0.5 换算与朝向旋转（atan2 反解）', () => {
  const scene = new THREE.Scene();
  const r = new MinecartRenderer({ scene });
  const entities = new EntityManager();
  entities.registerType(MINECART_TYPE, minecartDefinition);
  entities.spawn({
    id: 'minecart-1', type: MINECART_TYPE, persistent: true,
    state: { position: [4, 11, 4], orientation: 1, movementState: MOVEMENT.IDLE, lastTrack: null },
  });
  r.sync(entities.entities());
  assertEqual(r.slotCount(), 1);
  assertTrue(r.meshes.body.visible, '有车时须提交渲染');
  const m = new THREE.Matrix4();
  r.meshes.body.getMatrixAt(0, m);
  const e = m.elements;
  assertEqual(Math.round(e[12] * 1000) / 1000, 4.5, 'x 须 +0.5（块底角 → 块中心）');
  assertEqual(Math.round(e[14] * 1000) / 1000, 4.5, 'z 须 +0.5');
  const expectedY = 11 + MINECART.bodyHeight / 2 + MINECART.wheelRadius;
  assertEqual(Math.round(e[13] * 1000) / 1000, Math.round(expectedY * 1000) / 1000,
    'y = 车Y + bodyHeight/2 + wheelRadius');
  // ⚠️ 反解 yaw 必须用 atan2(e[8], e[0])（M6 活跃约束：Euler 反解会折叠）
  const yaw = Math.atan2(e[8], e[0]);
  assertEqual(Math.round(yaw * 1000) / 1000, Math.round(rotationAngleOf(1) * 1000) / 1000,
    '朝向 1 → yaw = π/2');
  const wm = new THREE.Matrix4();
  for (let i = 0; i < 4; i++) {
    r.meshes.wheel.getMatrixAt(i, wm);
    assertTrue(wm.elements[0] !== 0, `车轮 ${i} 矩阵须非零`);
  }
  // 消失 → slot 归还 + visible=false
  entities.despawn('minecart-1', 'test');
  r.sync(entities.entities());
  assertEqual(r.slotCount(), 0);
  assertFalse(r.meshes.body.visible, '无车时须停止提交');
  r.dispose();
});

test('renderer.sync: 朝向 3 的 yaw 反解不折叠（负向验证 atan2 口径）', () => {
  const scene = new THREE.Scene();
  const r = new MinecartRenderer({ scene });
  const entities = new EntityManager();
  entities.registerType(MINECART_TYPE, minecartDefinition);
  entities.spawn({
    id: 'minecart-2', type: MINECART_TYPE, persistent: true,
    state: { position: [0, 11, 0], orientation: 3, movementState: MOVEMENT.IDLE, lastTrack: null },
  });
  r.sync(entities.entities());
  const m = new THREE.Matrix4();
  r.meshes.body.getMatrixAt(0, m);
  const yaw = Math.atan2(m.elements[8], m.elements[0]);
  // 朝向 3 → 3π/2 ≈ 4.712；atan2 值域内等价表示为 −π/2 ≈ −1.571。不得是折叠值 ±π/2 中的 +π/2
  const ok = Math.abs(yaw - Math.PI * 1.5) < 1e-6 || Math.abs(yaw + Math.PI / 2) < 1e-6;
  assertTrue(ok, `朝向 3 的 yaw 反解须为 3π/2 或 −π/2，实得 ${yaw}`);
  r.dispose();
});
