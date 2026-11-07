import { test } from './runner.js';
import { assertTrue, assertFalse, assertNotNull, assertEqual } from './assert.js';
import { PlayerPhysics, FLY_SPEED_MULT, FLY_VERTICAL_SPEED, IGNIS_EJECT_SPEED } from '../player/physics.js';
import { WorldData } from '../voxel/world-data.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { WORLD_MIN_Y, WORLD_MAX_Y, WORLD_HEIGHT, blockIndex } from '../voxel/constants.js';
import { EntityManager } from '../entities/entity-manager.js';
import { MINECART_TYPE } from '../entities/minecarts/minecart-config.js';
import { MinecartService, minecartDefinition } from '../entities/minecarts/minecart-system.js';

/** 浮点容差（与 physics.js 的 EPSILON 同值；测试侧独立写一份会漂移，故只在这里声明一次） */
const EPS = 0.001;

function makeWorld() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  // y=0 铺一层石头地面
  for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
    col.blocks[blockIndex(lx, 0, lz)] = reg.idOf('stone');
  }
  world.add(col);
  return { world, reg };
}

test('physics: 自由落体到地面停止（onGround）', () => {
  const { world } = makeWorld();
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: 5, z: 8 };
  for (let i = 0; i < 300; i++) p.step(1 / 60);
  assertTrue(p.onGround, 'should land');
  assertTrue(Math.abs(p.pos.y - 1) < 0.01, `rest at y=1, got ${p.pos.y}`);
});

test('physics: 跳跃上升后回落', () => {
  const { world } = makeWorld();
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: 1, z: 8 };
  for (let i = 0; i < 10; i++) p.step(1 / 60); // 先落地
  p.jump();
  const y0 = p.pos.y;
  for (let i = 0; i < 10; i++) p.step(1 / 60);
  assertTrue(p.pos.y > y0 + 0.3, 'ascended after jump');
  for (let i = 0; i < 120; i++) p.step(1 / 60);
  assertTrue(p.onGround, 'landed back');
});

test('physics: 水平移动被墙阻挡', () => {
  const { world, reg } = makeWorld();
  const col = world.getColumn(0, 0);
  // x=10 处立一堵墙（y=1..3）
  for (let y = 1; y <= 3; y++) for (let lz = 0; lz < 16; lz++) {
    col.blocks[blockIndex(10, y, lz)] = reg.idOf('stone');
  }
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: 1, z: 8 };
  for (let i = 0; i < 10; i++) p.step(1 / 60);
  p.move(1, 0); // 向 +X
  for (let i = 0; i < 120; i++) p.step(1 / 60);
  assertTrue(p.pos.x < 10 - 0.3, `blocked by wall, x=${p.pos.x}`);
});

test('physics: 不穿底（世界底部以下 isSolid）', () => {
  const { world } = makeWorld();
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: WORLD_MIN_Y + 1, z: 8 };
  for (let i = 0; i < 60; i++) p.step(1 / 60);
  assertTrue(p.pos.y >= WORLD_MIN_Y, 'never below world');
});

// ==================== 焰魔阻挡玩家（v2.62 用户缺陷⑦）====================
//
// 「玩家奔跑向焰魔，撞到焰魔的身体，焰魔应该不动如山，玩家也应当停止前进，
// 就类似撞到实心方块一样」。实现：`_collides()` 把焰魔身体盒当实心（注入 service，
// 同 minecarts 手法）。本组用**注入一个假 service**（只实现 `overlapsAabb`）验证
// 玩家物理真的消费了它 —— 真 service 的 `overlapsAabb` 契约在 `test-ignis-system.js`。

test('physics: 玩家撞焰魔身体盒被挡（不动如山）', () => {
  const { world } = makeWorld();
  const p = new PlayerPhysics(world);
  // 假 service：焰魔身体盒占 x∈[9.5,10.5]、z∈[7.5,8.5]、y∈[1,4]（玩家正前方）
  p.ignises = {
    overlapsAabb: (box) => box.maxX > 9.5 && box.minX < 10.5
      && box.maxZ > 7.5 && box.minZ < 8.5 && box.maxY > 1 && box.minY < 4,
  };
  p.pos = { x: 8, y: 1, z: 8 };
  for (let i = 0; i < 10; i++) p.step(1 / 60);   // 先落地
  for (let i = 0; i < 120; i++) { p.move(1, 0); p.step(1 / 60); }   // 朝 +X 全速冲
  // 玩家半宽 0.3 ⇒ 撞到盒左缘 9.5 时中心停在 9.2
  assertTrue(p.pos.x < 9.5, `应被焰魔挡住，实际 x=${p.pos.x.toFixed(3)}`);
  assertTrue(p.pos.x > 8.5, `不应完全没动（否则测不到「冲过去被挡」），x=${p.pos.x.toFixed(3)}`);
});

test('physics: 无 ignises 注入时玩家照常穿过该区域（零回归）', () => {
  const { world } = makeWorld();
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: 1, z: 8 };
  for (let i = 0; i < 10; i++) p.step(1 / 60);
  for (let i = 0; i < 120; i++) { p.move(1, 0); p.step(1 / 60); }
  assertTrue(p.pos.x > 9.5, `无焰魔时应能走过 x=9.5，实际 x=${p.pos.x.toFixed(3)}`);
});

test('physics: 玩家爬不上焰魔（盒高 > 抬升后头顶）', () => {
  const { world } = makeWorld();
  const p = new PlayerPhysics(world);
  // 焰魔盒 y∈[1,4]（3 格高）：玩家 1.8 高，step-up 抬 1 格后头顶到 y=2.8 仍在盒内 ⇒ 上不去
  p.ignises = {
    overlapsAabb: (box) => box.maxX > 9.5 && box.minX < 10.5
      && box.maxZ > 7.5 && box.minZ < 8.5 && box.maxY > 1 && box.minY < 4,
  };
  p.pos = { x: 8, y: 1, z: 8 };
  for (let i = 0; i < 10; i++) p.step(1 / 60);
  for (let i = 0; i < 180; i++) { p.move(1, 0); p.step(1 / 60); }
  assertTrue(p.pos.x < 9.5, `不应爬上焰魔，实际 x=${p.pos.x.toFixed(3)}`);
  assertTrue(Math.abs(p.pos.y - 1) < 0.01, `不应被抬升，实际 y=${p.pos.y.toFixed(3)}`);
});

// ---- 焰魔身体盒扫过玩家 → 玩家被推出（v2.78 用户缺陷：跑太近就卡死）----
//
// 用户 2026-11-07：「玩家跑进焰魔，跑的太近就会和焰魔靠在一起，然后玩家就不能动弹了，跳也不行，
// 前后左右都无法动弹」。真实游戏复现（seed=12345，真实 AI + 真实物理）：玩家站在焰魔身体盒的
// **斜角外**（d≈1.4），焰魔醒来转向玩家，盒子（身体 OBB 绕 yaw 旋转后的包围盒，随朝向变形）扫过去
// ⇒ 之后 30/40 帧 `overlap=true`，W/S/A/D/Space 六个方向位移**全是 0**；焰魔侧的自愈
//（`overlapEscapeDist = 1.15`，仅 chase 态）在 d≈1.4 时从不触发 ⇒ 永久软锁。
//
// 根因与取值见 `IGNIS_EJECT_SPEED`。本组用**会动的假盒子**（`overlapsAabb` 与真 service 同口径：
// 严格不等式）复现「盒子扫过静止的玩家」，断言玩家物理自己把人推出来。
// 真 service + 真 AI + 真输入的整条链路由 `tests/ignis.spec.mjs` 的 E2E 守。

/** 会动的假焰魔盒（世界坐标）。⚠️ 严格不等式：贴面不算重叠（同 `IgnisService.overlapsAabb`） */
function movingIgnisBox(box) {
  return {
    box,
    overlapsAabb(q) {
      const b = this.box;
      return q.minX < b.x1 && q.maxX > b.x0 && q.minZ < b.z1 && q.maxZ > b.z0
        && q.minY < b.y1 && q.maxY > b.y0;
    },
  };
}

/** 先让玩家落地站稳，再把盒子换成给定位置（避免「出生即重叠」影响落地） */
function landedPlayerWithBox(world, pos, box) {
  const p = new PlayerPhysics(world);
  const ig = movingIgnisBox({ x0: 100, x1: 101, z0: 100, z1: 101, y0: 1, y1: 4 });   // 远处
  p.ignises = ig;
  p.pos = { ...pos };
  for (let i = 0; i < 10; i++) p.step(1 / 60);
  ig.box = box;
  return { p, ig };
}

test('physics(v2.78): 焰魔身体盒扫过玩家后，玩家被推出盒外且不再四轴冻结', () => {
  const { world } = makeWorld();
  const p = new PlayerPhysics(world);
  const ig = movingIgnisBox({ x0: 9.0, x1: 11.0, z0: 7.0, z1: 9.0, y0: 1, y1: 4 });
  p.ignises = ig;
  p.pos = { x: 8.6, y: 1, z: 8 };                       // 玩家 x∈[8.3, 8.9]，盒 x0 = 9.0 ⇒ 贴近但不重叠
  for (let i = 0; i < 10; i++) p.step(1 / 60);          // 落地
  assertFalse(ig.overlapsAabb(p.aabb()), '前提：起初不重叠');

  // 焰魔转身，盒子向 −X 扩到 8.55：玩家陷进去 0.35 格（> 单步位移 SPEED/60 = 0.133）
  ig.box.x0 = 8.55;
  assertTrue(ig.overlapsAabb(p.aabb()), '前提：盒子扫过来后玩家被罩住');
  assertTrue(p._collides(), '前提：被罩住时 `_collides()` 恒真 —— 这正是四轴冻结的条件');

  let prevX = p.pos.x;
  let maxStep = 0;
  for (let i = 0; i < 30; i++) {
    p.step(1 / 60);
    maxStep = Math.max(maxStep, Math.abs(p.pos.x - prevX));
    prevX = p.pos.x;
  }
  assertFalse(ig.overlapsAabb(p.aabb()), `30 步后仍被罩住（四轴冻结），x=${p.pos.x.toFixed(3)}`);
  // 最近的面是 −X（陷入 0.35）而不是 +X（要走 2.4+ 格）
  assertTrue(p.pos.x < 8.6, `应向 −X 推出，实际 x=${p.pos.x.toFixed(3)}`);
  assertTrue(Math.abs(p.pos.z - 8) < 1e-9, `z 不应被动，实际 z=${p.pos.z}`);
  // 推出是「顶开」而不是瞬移：每步不超过速度上限（0.35 格深 ⇒ 至少分 3 步）
  assertTrue(maxStep <= IGNIS_EJECT_SPEED / 60 + 1e-9,
    `单步推出 ${maxStep.toFixed(3)} 超过上限 ${(IGNIS_EJECT_SPEED / 60).toFixed(3)}（瞬移）`);
  assertTrue(maxStep > 0.05, `应确实在推（单步最大 ${maxStep.toFixed(3)}）`);

  // 解冻：远离 / 贴着盒面平移 / 起跳 都能动；而朝盒子里走仍被挡（「不动如山」不变）
  const base = { x: p.pos.x, y: p.pos.y, z: p.pos.z };
  const walk = (mx, mz) => {
    p.pos = { ...base };
    p.vel = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 30; i++) { p.move(mx, mz); p.step(1 / 60); }
    return { dx: p.pos.x - base.x, dz: p.pos.z - base.z };
  };
  assertTrue(walk(-1, 0).dx < -2, '远离（−X）应能走');
  assertTrue(walk(0, 1).dz > 2, '贴着盒面向 +Z 平移应能走');
  assertTrue(walk(0, -1).dz < -2, '贴着盒面向 −Z 平移应能走');
  const into = walk(1, 0);
  assertTrue(into.dx < 0.05, `朝盒子里走仍应被挡（不动如山），实际前进 ${into.dx.toFixed(3)}`);
  assertFalse(ig.overlapsAabb(p.aabb()), '被挡住时也不应陷进盒内');
  p.pos = { ...base };
  p.vel = { x: 0, y: 0, z: 0 };
  p.jump();
  for (let i = 0; i < 10; i++) p.step(1 / 60);
  assertTrue(p.pos.y > base.y + 0.3, `起跳应能离地，实际抬升 ${(p.pos.y - base.y).toFixed(3)}`);
});

test('physics(v2.78): 推出走最近的面（不是固定朝某个方向）', () => {
  const { world } = makeWorld();
  const box = { x0: 7, x1: 9, z0: 7, z1: 9, y0: 1, y1: 4 };
  // ① 玩家陷在 +X 面附近（到 +X 面 0.5，到其余面 ≥ 1.3）⇒ 向 +X 出
  {
    const { p, ig } = landedPlayerWithBox(world, { x: 8.8, y: 1, z: 8 }, { ...box });
    assertTrue(ig.overlapsAabb(p.aabb()), '前提①：玩家在盒内');
    for (let i = 0; i < 40; i++) p.step(1 / 60);
    assertFalse(ig.overlapsAabb(p.aabb()), '①应已被推出');
    assertTrue(p.pos.x > 9.2, `①应从 +X 面出去，实际 x=${p.pos.x.toFixed(3)}`);
    assertTrue(Math.abs(p.pos.z - 8) < 1e-9, '①z 不应被动');
  }
  // ② 玩家陷在 −Z 面附近（到 −Z 面 0.6，到其余面 ≥ 1.3）⇒ 向 −Z 出
  {
    const { p, ig } = landedPlayerWithBox(world, { x: 8, y: 1, z: 7.3 }, { ...box });
    assertTrue(ig.overlapsAabb(p.aabb()), '前提②：玩家在盒内');
    for (let i = 0; i < 40; i++) p.step(1 / 60);
    assertFalse(ig.overlapsAabb(p.aabb()), '②应已被推出');
    assertTrue(p.pos.z < 6.8, `②应从 −Z 面出去，实际 z=${p.pos.z.toFixed(3)}`);
    assertTrue(Math.abs(p.pos.x - 8) < 1e-9, '②x 不应被动');
  }
});

test('physics(v2.78): 推出时不会把玩家推进方块里（最近的面被墙堵住就走次近的）', () => {
  const { world, reg } = makeWorld();
  const col = world.getColumn(0, 0);
  // x=7 立一堵墙（方块 [7,8)）：玩家向 −X 被推到 x≈8.0 时左缘 7.7 ⇒ 嵌进墙
  for (let y = 1; y <= 3; y++) for (let lz = 0; lz < 16; lz++) col.blocks[blockIndex(7, y, lz)] = reg.idOf('stone');
  // 玩家 x=8.4（x∈[8.1,8.7]，不碰墙）；盒 x0=8.3 ⇒ 陷入 0.4，最近的出口是 −X（0.4）但被墙堵住；
  // 次近是 ±Z（1.3）
  const { p, ig } = landedPlayerWithBox(world, { x: 8.4, y: 1, z: 8 }, { x0: 8.3, x1: 11, z0: 7, z1: 9, y0: 1, y1: 4 });
  assertTrue(ig.overlapsAabb(p.aabb()), '前提：玩家被罩住');
  for (let i = 0; i < 60; i++) {
    p.step(1 / 60);
    assertFalse(p.collidesAt(p.pos.x, p.pos.y, p.pos.z), `第 ${i} 步玩家被推进了方块，pos=${JSON.stringify(p.pos)}`);
  }
  assertFalse(ig.overlapsAabb(p.aabb()), '最终应从另一个方向被推出');
  assertTrue(Math.abs(p.pos.x - 8.4) < 1e-9, `不应往墙里推（x 应不变），实际 x=${p.pos.x.toFixed(3)}`);
});

test('physics(v2.78): 不重叠（含恰好贴面）时一动不动（热路径零影响）', () => {
  const { world } = makeWorld();
  // 玩家 x∈[8.3, 8.9]；盒 x0=8.9 ⇒ 恰好贴面（严格不等式：不算重叠）
  const { p, ig } = landedPlayerWithBox(world, { x: 8.6, y: 1, z: 8 }, { x0: 8.9, x1: 11, z0: 7, z1: 9, y0: 1, y1: 4 });
  assertFalse(ig.overlapsAabb(p.aabb()), '前提：贴面不重叠');
  const before = { x: p.pos.x, z: p.pos.z };
  for (let i = 0; i < 60; i++) p.step(1 / 60);
  assertEqual(p.pos.x, before.x, '不重叠时 x 不应被改');
  assertEqual(p.pos.z, before.z, '不重叠时 z 不应被改');
});

test('physics(v2.78): 盒边持续扫过（焰魔持续转身 / 前压）时玩家被一路顶开，每一步都不冻死', () => {
  const { world } = makeWorld();
  const { p, ig } = landedPlayerWithBox(world, { x: 8.6, y: 1, z: 8 }, { x0: 9.0, x1: 11, z0: 7, z1: 9, y0: 1, y1: 4 });
  let prevX = p.pos.x;
  let maxStep = 0;
  // 盒边每步前压 0.05（≈ 3 格/秒，与焰魔转身时盒边扫过的速度同量级），共 20 步 ⇒ 总共前压 1.0 格
  for (let i = 0; i < 20; i++) {
    ig.box.x0 -= 0.05;
    p.step(1 / 60);
    maxStep = Math.max(maxStep, Math.abs(p.pos.x - prevX));
    prevX = p.pos.x;
    assertFalse(ig.overlapsAabb(p.aabb()), `第 ${i} 步结束时玩家仍被罩住（推出没追上盒边），x=${p.pos.x.toFixed(3)}`);
  }
  assertTrue(p.pos.x + 0.3 <= ig.box.x0 + 1e-9, `盒边停住后玩家应在盒外，x=${p.pos.x.toFixed(3)} x0=${ig.box.x0.toFixed(3)}`);
  assertTrue(maxStep <= IGNIS_EJECT_SPEED / 60 + 1e-9, `单步推出 ${maxStep.toFixed(3)} 超过上限`);
});

test('physics: 1 格台阶可登上（step-up）', () => {
  const { world, reg } = makeWorld();
  const col = world.getColumn(0, 0);
  // x=10..15 放 1 格高台阶（grid y=1，顶面 y=2），形成可站立的平台
  for (let x = 10; x <= 15; x++) for (let lz = 0; lz < 16; lz++) {
    col.blocks[blockIndex(x, 1, lz)] = reg.idOf('stone');
  }
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: 1, z: 8 };
  for (let i = 0; i < 10; i++) p.step(1 / 60); // 先落地
  for (let i = 0; i < 50; i++) { p.move(1, 0); p.step(1 / 60); } // 每步重设速度（无惯性手感）
  assertTrue(p.pos.y > 1.9, `climbed onto step, feet y=${p.pos.y}`);
  assertTrue(p.pos.x > 10, `moved past step face, x=${p.pos.x}`);
});

test('physics: 2 格高墙不可登上（非台阶）', () => {
  const { world, reg } = makeWorld();
  const col = world.getColumn(0, 0);
  for (let y = 1; y <= 2; y++) for (let lz = 0; lz < 16; lz++) {
    col.blocks[blockIndex(10, y, lz)] = reg.idOf('stone');
  }
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: 1, z: 8 };
  for (let i = 0; i < 10; i++) p.step(1 / 60);
  for (let i = 0; i < 120; i++) { p.move(1, 0); p.step(1 / 60); }
  assertTrue(p.pos.x < 10 - 0.3, `blocked by 2-high wall, x=${p.pos.x}`);
  assertTrue(Math.abs(p.pos.y - 1) < 0.05, `stays on ground, y=${p.pos.y}`);
});

test('physics: 头顶净空不足的台阶不可登上', () => {
  const { world, reg } = makeWorld();
  const col = world.getColumn(0, 0);
  // 台阶 grid y=1（顶面 y=2）
  for (let x = 10; x <= 15; x++) for (let lz = 0; lz < 16; lz++) {
    col.blocks[blockIndex(x, 1, lz)] = reg.idOf('stone');
  }
  // 天花板 grid y=3（占 [3,4)），压在台阶上方 → 抬头空间不足
  for (let x = 9; x <= 15; x++) for (let lz = 0; lz < 16; lz++) {
    col.blocks[blockIndex(x, 3, lz)] = reg.idOf('stone');
  }
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: 1, z: 8 };
  for (let i = 0; i < 10; i++) p.step(1 / 60);
  for (let i = 0; i < 120; i++) { p.move(1, 0); p.step(1 / 60); }
  assertTrue(p.pos.x < 10 - 0.3, `blocked by low ceiling, x=${p.pos.x}`);
});

// ---- 云：v1.96 起 solid=true（不可穿越；supportsPlayer 仍保留 = 可站立）----
// ⚠️ v1.96 前这里的两条是「穿过云」的反向断言（M2-7 口径：云 non-solid、只在向下碰撞时生效）。
// 用户 2026-10-28 裁定「云不可穿越」→ 语义翻转：水平/向上/向下全部走 `solid` 分支。

function makeCloudFloor(world, reg, y) {
  const col = world.getColumn(0, 0);
  for (let lx = 1; lx < 15; lx++) for (let lz = 1; lz < 15; lz++) {
    col.blocks[blockIndex(lx, y, lz)] = reg.idOf('cloud');
  }
}

test('physics: 下落落在云上（云是实心地面，v1.96）', () => {
  const { world, reg } = makeWorld();
  makeCloudFloor(world, reg, 10);
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: 15, z: 8 };
  for (let i = 0; i < 300; i++) p.step(1 / 60);
  assertTrue(p.onGround, 'lands on cloud');
  assertTrue(Math.abs(p.pos.y - 11) < 0.01, `rest at cloud top y=11, got ${p.pos.y}`);
});

test('physics: 上跳被头顶云挡住（v1.96 前是穿过去）', () => {
  const { world, reg } = makeWorld(); // stone 地面 y=0
  const col = world.getColumn(0, 0);
  // 头顶云 grid y=4（占 [4,5)）。玩家 1.8 高 → 头不能进 y=4 格 ⇒ 脚底上限 4−1.8 = 2.2。
  // ⚠️ **阈值必须落在「被挡住」与「穿过去」两个实测值之间**（实测：被挡 2.2008 / 自由跳跃 3.0）：
  //    取中点 2.6 —— 两侧各留 0.4 余量。
  //    写成 `maxY < 4` 是**无效盲区** —— 自由跳跃的 3.0 也 < 4，注入回退照样全绿（实测确认）。
  for (let lx = 4; lx < 12; lx++) for (let lz = 4; lz < 12; lz++) {
    col.blocks[blockIndex(lx, 4, lz)] = reg.idOf('cloud');
  }
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: 1, z: 8 };
  for (let i = 0; i < 10; i++) p.step(1 / 60); // 先落地
  p.jump();
  let maxY = 0;
  for (let i = 0; i < 90; i++) { p.step(1 / 60); maxY = Math.max(maxY, p.pos.y); }
  assertTrue(maxY < 2.6, `jump blocked by cloud bottom y=4 (实测被挡 2.2008 / 自由跳跃 3.0), peak=${maxY}`);
});

test('physics: X/Z 被侧面云墙挡住（v1.96 前是穿过去）', () => {
  const { world, reg } = makeWorld();
  const col = world.getColumn(0, 0);
  // x=10 立一面云墙（y=1..3），与同文件 stone 墙用例同款布局 → 两者断言可直接对照
  for (let y = 1; y <= 3; y++) for (let lz = 0; lz < 16; lz++) {
    col.blocks[blockIndex(10, y, lz)] = reg.idOf('cloud');
  }
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: 1, z: 8 };
  for (let i = 0; i < 10; i++) p.step(1 / 60);
  for (let i = 0; i < 120; i++) { p.move(1, 0); p.step(1 / 60); }
  assertTrue(p.pos.x < 10 - 0.3, `blocked by cloud wall, x=${p.pos.x}`);
});

test('physics: 云上对 solid 台阶仍走 _tryStepUp（云是实心地面）', () => {
  const { world, reg } = makeWorld();
  makeCloudFloor(world, reg, 10); // 站立面 y=11
  const col = world.getColumn(0, 0);
  // x>=10 放 1 格高 solid 台阶（grid y=11，顶面 y=12 = 站立面以上一格）
  for (let x = 10; x <= 15; x++) for (let lz = 0; lz < 16; lz++) {
    col.blocks[blockIndex(x, 11, lz)] = reg.idOf('stone');
  }
  const p = new PlayerPhysics(world);
  p.pos = { x: 5, y: 15, z: 8 };
  for (let i = 0; i < 120; i++) p.step(1 / 60); // 先落在云上
  assertTrue(Math.abs(p.pos.y - 11) < 0.01, `starts on cloud top, y=${p.pos.y}`);
  // 50 帧 ≈ 前进 6.7 格：登上台阶且未走出 column 边界（x<16）
  for (let i = 0; i < 50; i++) { p.move(1, 0); p.step(1 / 60); }
  assertTrue(p.pos.x > 10, `moved past step face, x=${p.pos.x}`);
  assertTrue(p.pos.y > 11.9, `step-up from cloud onto stone, y=${p.pos.y}`);
});

/**
 * 矿车 fixture：**真 MinecartService + 真 EntityManager**（不用 fake）。
 * ⚠️ 用真 service 是有意的 —— `_collides` 消费的是 `carAt(x,y,z)` 的 floor 基格查询，
 * 手写 fake 会让「格换算口径」这个正是被测的东西变成断言恒真（CLAUDE.md「fake 必须建模
 * 真实对象的副作用，不能只是形状一致」）。
 * 布局：stone 地面 y=0 → 铁轨 y=1（solid，玩家踩在其顶面 = 脚底 y=2）→ 矿车占据格 y=2。
 * ⚠️ 铁轨铺满 x=2..14（不是只铺车附近）：玩家 8 格/秒，走满用例会越过轨尾掉落 →
 * 「对照用例 y 停在轨面」会因错误原因失败（断言描述想象中的世界，testing-policy §2.6 ⑤）。
 */
function makeMinecartWorld() {
  const { world, reg } = makeWorld();
  for (let x = 2; x <= 14; x++) world.setBlock(x, 1, 4, reg.idOf('sand_train_track'), 0);
  const entities = new EntityManager();
  entities.registerType(MINECART_TYPE, minecartDefinition);
  const service = new MinecartService({ entities, world, registry: reg });
  const placed = service.place({ cell: [6, 2, 4] });
  assertTrue(placed.ok, `fixture 放车须成功，got ${placed.reason}`);
  service.syncIndex();
  return { world, reg, service, carCell: [6, 2, 4] };
}

test('physics: 矿车占据格对玩家是实心 —— 走进车不穿模，被抬到车顶（mc-lite isSolid 同口径）', () => {
  const { world, service, carCell } = makeMinecartWorld();
  const p = new PlayerPhysics(world);
  p.minecarts = service;
  p.pos = { x: 3.5, y: 2, z: 4.5 };
  for (let i = 0; i < 10; i++) p.step(1 / 60);   // 先落到轨面
  // 逐帧走向车；记录「脚底格 == 车格」的每一帧 y —— 穿模的判据就是这些帧里 y 仍停在轨面。
  // ⚠️ 走到车格就停（不按固定帧数）：穿过车格后玩家会掉回轨面，末尾断言会因错误原因失败。
  let overCar = 0;
  let clipped = false;
  let frames = 0;
  while (frames < 60) {
    p.move(1, 0);
    p.step(1 / 60);
    frames++;
    if (Math.floor(p.pos.x) === carCell[0] && Math.floor(p.pos.z) === carCell[2]) {
      overCar++;
      if (p.pos.y < carCell[1] + 0.9 - 0.05) clipped = true;   // 低于车顶 = 与车体重叠
      break;
    }
  }
  assertTrue(overCar > 0, '玩家确实走到了车所在格（否则用例没考察到东西）');
  assertFalse(clipped, '站在车格内时脚底不得低于车顶（穿模）');
  assertTrue(p.pos.y > carCell[1] + 0.8, `在车格上时被抬到车顶之上，y=${p.pos.y}`);
});

test('physics: 未注入 minecarts 时矿车格不挡人（对照 —— 证明上一条不是恒真）', () => {
  const { world, carCell } = makeMinecartWorld();
  const p = new PlayerPhysics(world);   // 不注入 service
  p.pos = { x: 3.5, y: 2, z: 4.5 };
  for (let i = 0; i < 10; i++) p.step(1 / 60);
  for (let i = 0; i < 60; i++) { p.move(1, 0); p.step(1 / 60); }
  assertTrue(p.pos.x > carCell[0] + 1.5, `无车碰撞时径直穿过，x=${p.pos.x}`);
  assertTrue(Math.abs(p.pos.y - 2) < 0.01, `且始终停在轨面（未被抬起），y=${p.pos.y}`);
});

test('physics: 踩上矿车后 ridingCarFor 命中（step-up 落点与绑定容差 0.3 咬合）', () => {
  const { world, service, carCell } = makeMinecartWorld();
  const p = new PlayerPhysics(world);
  p.minecarts = service;
  p.pos = { x: 4.5, y: 2, z: 4.5 };
  for (let i = 0; i < 10; i++) p.step(1 / 60);
  // 走到车格就停（不按固定帧数 —— 否则玩家会走过车，判据变成「车后面那格有没有车」）
  let frames = 0;
  while (Math.floor(p.pos.x) !== carCell[0] && frames < 60) {
    p.move(1, 0); p.step(1 / 60); frames++;
  }
  assertTrue(Math.floor(p.pos.x) === carCell[0], `应已走到车格，x=${p.pos.x}`);
  // step-up 把脚底抬到 carY+1 = 3，而车顶是 carY+0.9 = 2.9 → 差 0.1，须被容差 0.3 吸收
  const car = service.ridingCarFor([p.pos.x, p.pos.y, p.pos.z]);
  assertNotNull(car, `站在车格上方应可绑定乘坐，y=${p.pos.y}`);
});

test('physics: 斜蹭台阶边沿时前进不中断（onGround 抖动不得冻结水平推进）', () => {
  // 缺陷根因（实测定位，v1.72）：`_tryStepUp` 曾用 `onGround` 当门控，而 `onGround` 是
  // **上一步**竖直碰撞的产物，而水平轴在竖直轴之前跑。玩家斜蹭台阶边沿时，AABB 跨出
  // 支撑格 → 本帧开始自由下落 → `onGround=false`；与此同时前方高出的台壁把水平推进
  // 挡死 → 同一帧的 step-up 被门控拒绝 → **水平冻结、垂直下落**，落地后才重新爬上 ——
  // 观感就是用户报告的「奔跑中断」。
  //
  // 最小复现几何（程序化筛出来的，与真实地形同构）：**每格沿对角线升 1 格的斜阶梯**
  // `顶面 = 5 + clamp(x+z, 0, 3)`，玩家沿对角方向斜切（8°）向上跑。实测旧门控下前
  // 6 帧连续「前进<30% 且在下落」，新门控下 0 帧；真实地形 seed=12345 上 15000 条
  // 轨迹中 385 条（2.57%）中招、最长 15 帧。
  const { world, reg } = makeWorld();
  // 跨 column 的斜面：用 world.setBlock（(0,0) column 只有 16×16，斜面会越过边界）
  for (let x = -8; x < 12; x++) for (let z = -8; z < 12; z++) {
    const top = 5 + Math.max(0, Math.min(3, x + z));
    for (let y = 0; y < top; y++) world.setBlock(x, y, z, reg.idOf('stone'), 0);
  }
  const p = new PlayerPhysics(world);
  p.pos = { x: 0.5, y: 6, z: 0.5 };
  for (let i = 0; i < 10; i++) p.step(1 / 60);
  const a = 8 * Math.PI / 180;
  const ux = Math.cos(a), uz = Math.sin(a);
  const full = 8 / 60;
  let stalls = 0;
  for (let i = 0; i < 40; i++) {
    const bx = p.pos.x, bz = p.pos.z, by = p.pos.y;
    p.move(ux, uz);
    p.step(1 / 60);
    const fwd = ((p.pos.x - bx) * ux + (p.pos.z - bz) * uz) / full;
    if (fwd < 0.3 && p.pos.y < by - EPS) stalls++;
  }
  assertEqual(stalls, 0, '不得出现「前进中断 + 下落」帧');
  assertTrue(p.pos.y > 7, `应已爬上斜阶梯，y=${p.pos.y}`);
});

test('physics: 普通 1 格台阶可登、2 格高墙不可登（v1.72 门控放宽后的护栏）', () => {
  // 两个场景各自建一份物理实例（间隔开：同一份世界里台阶会叠成可登的连续级）
  // ① 1 格台阶（x>=10 铺 y=1，比地面顶面 y=1 高一格）
  {
    const { world, reg } = makeWorld();
    const col = world.getColumn(0, 0);
    for (let lx = 10; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
      col.blocks[blockIndex(lx, 1, lz)] = reg.idOf('stone');
    }
    const p = new PlayerPhysics(world);
    p.pos = { x: 8.5, y: 1, z: 8.5 };
    for (let i = 0; i < 10; i++) p.step(1 / 60);
    for (let i = 0; i < 40; i++) { p.move(1, 0); p.step(1 / 60); }
    assertTrue(p.pos.y > 1.9, `1 格台阶应可登上，y=${p.pos.y}`);
    assertTrue(p.pos.x > 10, `应越过台阶面，x=${p.pos.x}`);
  }
  // ② 2 格高墙（x>=13 同时铺 y=1 与 y=2 → 顶面 y=3，比地面顶面高两格）
  {
    const { world, reg } = makeWorld();
    const col = world.getColumn(0, 0);
    for (let lx = 13; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
      col.blocks[blockIndex(lx, 1, lz)] = reg.idOf('stone');
      col.blocks[blockIndex(lx, 2, lz)] = reg.idOf('stone');
    }
    const p = new PlayerPhysics(world);
    p.pos = { x: 8.5, y: 1, z: 8.5 };
    for (let i = 0; i < 10; i++) p.step(1 / 60);
    for (let i = 0; i < 40; i++) { p.move(1, 0); p.step(1 / 60); }
    assertTrue(p.pos.x < 12.7, `2 格高墙应挡住，x=${p.pos.x}`);
    assertTrue(Math.abs(p.pos.y - 1) < 0.05, `应仍在地面，y=${p.pos.y}`);
  }
});

test('physics: 真腾空下落时贴墙不得被 step-up 抬升（放宽门控的负向护栏）', () => {
  // 门控从 `onGround` 放宽到「地面 或 下落中」后，**真正悬空**时仍必须被拒绝，否则
  // 玩家在空中贴墙就能一格一格往上爬。约束靠抬升幅度：最多 1 格 + 抬完 AABB 必须无碰撞。
  const { world, reg } = makeWorld();
  const col = world.getColumn(0, 0);
  for (let lx = 10; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
    for (let y = 1; y <= 5; y++) col.blocks[blockIndex(lx, y, lz)] = reg.idOf('stone');
  }
  const p = new PlayerPhysics(world);
  p.pos = { x: 9.6, y: 9, z: 8.5 };
  let maxY = 0;
  for (let i = 0; i < 200; i++) { p.move(1, 0); p.step(1 / 60); maxY = Math.max(maxY, p.pos.y); }
  assertTrue(maxY <= 9.001, `空中贴墙不得被抬升，最高 y=${maxY}`);
});

test('WorldData.supportsPlayer: 坐标查询（M2-7）', () => {
  const { world, reg } = makeWorld();
  const col = world.getColumn(0, 0);
  col.blocks[blockIndex(8, 10, 8)] = reg.idOf('cloud');
  assertTrue(world.supportsPlayer(8, 10, 8), 'cloud supports');
  assertTrue(!world.supportsPlayer(8, 0, 8), 'stone does not');
  assertTrue(!world.supportsPlayer(8, 20, 8), 'air does not');
});

// ---- 飞行（spec 2026-10-25-player-flight-design.md §4.3）----

test('flight: 悬停不掉落（零重力），且 toggleFlight 清零竖直速度', () => {
  const { world } = makeWorld();
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: 20, z: 8 };
  // 先让它掉一会儿，模拟「下坠中按 F」—— toggleFlight 必须吃掉这份速度
  p.step(1 / 60);
  assertTrue(p.vel.y < 0, `前提：须处于下坠，vel.y=${p.vel.y}`);
  p.toggleFlight();
  assertTrue(p.flying, 'toggleFlight 后处于飞行态');
  assertEqual(p.vel.y, 0, 'toggleFlight 必须清零竖直速度（否则按 F 后仍在加速下坠）');
  const y0 = p.pos.y;
  for (let i = 0; i < 60; i++) { p.moveVertical(0); p.step(1 / 60); }
  assertTrue(Math.abs(p.pos.y - y0) < 1e-9, `悬停 60 步高度须不变，y0=${y0} y=${p.pos.y}`);
});

test('flight: 空格上升 / Shift 下降的速度等于 FLY_VERTICAL_SPEED', () => {
  const { world } = makeWorld();
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: 20, z: 8 };
  p.toggleFlight();
  const y0 = p.pos.y;
  for (let i = 0; i < 60; i++) { p.moveVertical(1); p.step(1 / 60); }
  const up = p.pos.y - y0;
  assertTrue(Math.abs(up - FLY_VERTICAL_SPEED) < FLY_VERTICAL_SPEED * 0.05,
    `上升 1 秒的距离须 ≈ ${FLY_VERTICAL_SPEED} 格（实测 ${up}）`);
  const y1 = p.pos.y;
  for (let i = 0; i < 60; i++) { p.moveVertical(-1); p.step(1 / 60); }
  const down = y1 - p.pos.y;
  assertTrue(Math.abs(down - FLY_VERTICAL_SPEED) < FLY_VERTICAL_SPEED * 0.05,
    `下降 1 秒的距离须 ≈ ${FLY_VERTICAL_SPEED} 格（实测 ${down}）`);
});

test('flight: 下降触地退出飞行（Java 口径），落地后不再飞', () => {
  const { world } = makeWorld();       // y=0 一层石头地面，站立脚底 y=1
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: 6, z: 8 };
  p.toggleFlight();
  for (let i = 0; i < 120 && p.flying; i++) { p.moveVertical(-1); p.step(1 / 60); }
  assertFalse(p.flying, '一直下降必须触地退出飞行');
  assertTrue(p.onGround, '退出时确实在地面上');
  assertTrue(Math.abs(p.pos.y - 1) < 0.02, `停在石面 y=1，实测 ${p.pos.y}`);
});

test('flight: 贴地悬停不误退出（onGround 每步清零的护栏）', () => {
  const { world } = makeWorld();
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: 1, z: 8 };
  for (let i = 0; i < 10; i++) p.step(1 / 60);   // 先落地 → onGround = true
  assertTrue(p.onGround, '前提：须已站在地面上');
  p.toggleFlight();
  for (let i = 0; i < 60; i++) { p.moveVertical(0); p.step(1 / 60); }
  assertTrue(p.flying, '贴地悬停不得被踢出飞行');
  assertFalse(p.onGround, '飞行态 onGround 必须恒 false（同时是「飞行不晃」的判据来源）');
});

test('flight: 水平速度恰为走路的 2 倍（不比走路慢）', () => {
  const { world } = makeWorld();
  const walk = new PlayerPhysics(world);
  walk.pos = { x: 2, y: 1, z: 8 };
  for (let i = 0; i < 10; i++) walk.step(1 / 60);
  const wx = walk.pos.x;
  for (let i = 0; i < 12; i++) { walk.move(1, 0); walk.step(1 / 60); }
  const walkDist = walk.pos.x - wx;

  const fly = new PlayerPhysics(world);
  fly.pos = { x: 2, y: 40, z: 8 };
  fly.toggleFlight();
  const fx = fly.pos.x;
  for (let i = 0; i < 12; i++) { fly.move(1, 0); fly.step(1 / 60); }
  const flyDist = fly.pos.x - fx;

  assertTrue(walkDist > 0.5, `前提：走路须真的前进，实测 ${walkDist}`);
  const ratio = flyDist / walkDist;
  assertTrue(Math.abs(ratio - FLY_SPEED_MULT) < 0.02, `飞行/走路速度比须 = ${FLY_SPEED_MULT}，实测 ${ratio}`);
});

test('flight: 飞行时不自动上台阶（撞 1 格台阶被挡住）', () => {
  const { world, reg } = makeWorld();
  const col = world.getColumn(0, 0);
  for (let x = 10; x <= 15; x++) for (let lz = 0; lz < 16; lz++) {
    col.blocks[blockIndex(x, 1, lz)] = reg.idOf('stone');
  }
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: 1, z: 8 };        // 与台阶同高（台面 y=2）
  p.toggleFlight();
  for (let i = 0; i < 60; i++) { p.move(1, 0); p.step(1 / 60); }
  assertTrue(p.pos.x < 10, `飞行时不得被抬上台阶，x=${p.pos.x}`);
  assertTrue(Math.abs(p.pos.y - 1) < 1e-6, `高度不变，y=${p.pos.y}`);
});

test('flight: 关闭飞行后恢复重力（自由落体）', () => {
  const { world } = makeWorld();
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: 10, z: 8 };
  p.toggleFlight();
  for (let i = 0; i < 30; i++) { p.moveVertical(0); p.step(1 / 60); }
  assertTrue(Math.abs(p.pos.y - 10) < 1e-9, '飞行时悬停在 y=10');
  p.toggleFlight();
  assertFalse(p.flying, '再次 toggle 退出飞行');
  for (let i = 0; i < 180; i++) p.step(1 / 60);
  assertTrue(p.onGround, '退出飞行后必须落地');
  assertTrue(Math.abs(p.pos.y - 1) < 0.02, `落在石面 y=1，实测 ${p.pos.y}`);
});

// ==================== resolveStuck（瞬移/出生被埋进方块时向上解卡） ====================
//
// 为什么需要它：`Game._teleportTo()` **刻意不等目标 column 加载**（v1.92 实测：等 1200 格外的
// column 会让面板点击阻塞秒级）。传送当帧目标区域全是未加载 column，`getBlockId` 对缺失 column
// 返回 0（空气）→ 玩家悬空一路掉到世界底；随后 column GEN 完成，`fillColumn` 的「底部补实」把
// y=-32 到地表之间全填成 stone → **玩家 AABB 整个埋在实心石头里**，而 `_moveAxis` 只在
// `delta !== 0` 时检测碰撞、碰撞后二分回退到零位移 → 水平与竖直全部冻结（用户报告的
// 「瞬移完卡在地底下动弹不得」）。
//
// ⚠️ **判据必须复用 `collidesAt`**（与 `_collides` 同一份 PLAYER_WIDTH/HEIGHT 权威，且
// **只查方块、不查矿车**）—— 站在矿车上/车里不得被误判成「卡住」。

test('resolveStuck: 埋进实心石头里 → 抬到地表之上且清零竖直速度', () => {
  const { world, reg } = makeWorld();
  const col = world.getColumn(0, 0);
  // 把整列填实到 y=5（模拟「掉到世界底后 column 才生成、底部补实把玩家埋住」）
  for (let y = WORLD_MIN_Y; y <= 5; y++) {
    for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
      col.blocks[blockIndex(lx, y, lz)] = reg.idOf('stone');
    }
  }
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: -30, z: 8 };
  p.vel = { x: 0, y: -24, z: 0 };
  assertTrue(p.collidesAt(p.pos.x, p.pos.y, p.pos.z), '前提：该位置必须真的被埋');

  const raised = p.resolveStuck();
  assertEqual(p.pos.y, 6, '须抬到第一个 AABB 无碰撞的高度（实心到 y=5 ⇒ 脚底 6）');
  assertEqual(raised, 36, '返回实际抬升量');
  assertEqual(p.vel.y, 0, '抬升后须清零竖直速度（不得带着 -24 继续掉）');
  assertFalse(p.collidesAt(p.pos.x, p.pos.y, p.pos.z), '解卡后必须不再与方块重叠');
});

test('resolveStuck: 只有头埋进方块（脚底在空气里）也要解卡', () => {
  const { world, reg } = makeWorld();
  const col = world.getColumn(0, 0);
  // y=0 地面 + y=2 一层天花板：玩家站 y=1 时脚格是空气、头格（floor(1+1.8-0.001)=2）是实心
  for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
    col.blocks[blockIndex(lx, 2, lz)] = reg.idOf('stone');
  }
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: 1, z: 8 };
  assertTrue(p.collidesAt(p.pos.x, p.pos.y, p.pos.z), '前提：头格被埋');
  const raised = p.resolveStuck();
  assertEqual(raised, 2, '须抬到天花板之上（y=3）');
  assertEqual(p.pos.y, 3);
  assertFalse(p.collidesAt(p.pos.x, p.pos.y, p.pos.z));
});

test('resolveStuck: 没被埋时零副作用（返回 0、y 逐位不变、不动 vel）', () => {
  const { world } = makeWorld();
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: 1, z: 8 };      // 站在 y=0 石面上（常态）
  p.vel = { x: 3, y: -1.5, z: -2 };
  const y0 = p.pos.y;
  assertEqual(p.resolveStuck(), 0, '常态必须返回 0');
  assertTrue(p.pos.y === y0, `y 必须逐位不变（不得做任何浮点运算），实测 ${p.pos.y}`);
  assertEqual(p.vel.y, -1.5, '不得清零速度（常态零副作用）');
  assertEqual(p.vel.x, 3);
});

test('resolveStuck: 水与花草（solid=false）不算被埋', () => {
  const { world, reg } = makeWorld();
  const col = world.getColumn(0, 0);
  for (let y = 1; y <= 3; y++) {
    for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
      col.blocks[blockIndex(lx, y, lz)] = reg.idOf(y === 3 ? 'short_grass' : 'water');
    }
  }
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: 1, z: 8 };
  assertEqual(p.resolveStuck(), 0, '水里/草丛里不得被抬走（与 _collides 同一份 solidTable）');
  assertEqual(p.pos.y, 1);
});

test('resolveStuck: 一路到世界顶都实心 → 停在 WORLD_MAX_Y 不越界', () => {
  const { world, reg } = makeWorld();
  const col = world.getColumn(0, 0);
  for (let y = WORLD_MIN_Y; y < WORLD_MAX_Y; y++) {
    for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
      col.blocks[blockIndex(lx, y, lz)] = reg.idOf('stone');
    }
  }
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: WORLD_MIN_Y, z: 8 };
  p.resolveStuck();
  assertTrue(p.pos.y <= WORLD_MAX_Y, `不得抬出世界上界，实测 ${p.pos.y}`);
  assertEqual(p.pos.y, WORLD_MAX_Y, '上界那一格 getBlockId 恒为空气 ⇒ 恰好停在这里');
});

test('resolveStuck: maxRaise 不够时返回 0 且原地不动（不静默抬到半路）', () => {
  const { world, reg } = makeWorld();
  const col = world.getColumn(0, 0);
  for (let y = WORLD_MIN_Y; y <= 5; y++) {
    for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
      col.blocks[blockIndex(lx, y, lz)] = reg.idOf('stone');
    }
  }
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: -30, z: 8 };
  assertEqual(p.resolveStuck(3), 0, '抬 3 格仍在实心里 ⇒ 必须放弃');
  assertEqual(p.pos.y, -30, '放弃时位置必须逐位不变');
  assertTrue(WORLD_HEIGHT >= WORLD_MAX_Y - WORLD_MIN_Y, '默认上限须覆盖整个世界高度');
});

test('flight: 顶到天花板不退出飞行（撞头 ≠ 落地）', () => {
  const { world, reg } = makeWorld();
  const col = world.getColumn(0, 0);
  for (let lz = 0; lz < 16; lz++) col.blocks[blockIndex(8, 6, lz)] = reg.idOf('stone');
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: 3, z: 8 };
  p.toggleFlight();
  for (let i = 0; i < 120; i++) { p.moveVertical(1); p.step(1 / 60); }
  assertTrue(p.flying, '顶到天花板仍须保持飞行态');
  assertTrue(p.pos.y < 6 - 1.7, `被天花板挡住（脚底 + 1.8 ≤ 6），y=${p.pos.y}`);
});
