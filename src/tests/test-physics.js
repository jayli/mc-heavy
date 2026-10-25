import { test } from './runner.js';
import { assertTrue, assertFalse, assertNotNull, assertEqual } from './assert.js';
import { PlayerPhysics, FLY_SPEED_MULT, FLY_VERTICAL_SPEED } from '../player/physics.js';
import { WorldData } from '../voxel/world-data.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { WORLD_MIN_Y, blockIndex } from '../voxel/constants.js';
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

// ---- M2-7：cloud 可站立、非实心（仅向下 Y 支撑）----

function makeCloudFloor(world, reg, y) {
  const col = world.getColumn(0, 0);
  for (let lx = 1; lx < 15; lx++) for (let lz = 1; lz < 15; lz++) {
    col.blocks[blockIndex(lx, y, lz)] = reg.idOf('cloud');
  }
}

test('physics: 下落落在云上（仅向下 Y 支撑，M2-7）', () => {
  const { world, reg } = makeWorld();
  makeCloudFloor(world, reg, 10);
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: 15, z: 8 };
  for (let i = 0; i < 300; i++) p.step(1 / 60);
  assertTrue(p.onGround, 'lands on cloud');
  assertTrue(Math.abs(p.pos.y - 11) < 0.01, `rest at cloud top y=11, got ${p.pos.y}`);
});

test('physics: 上跳穿过头顶云（向上不碰撞，M2-7）', () => {
  const { world, reg } = makeWorld(); // stone 地面 y=0
  const col = world.getColumn(0, 0);
  // 头顶云 grid y=4：若云挡头顶，跳跃峰值被压在 y≈2.2；自由峰值 ≈3.1
  for (let lx = 4; lx < 12; lx++) for (let lz = 4; lz < 12; lz++) {
    col.blocks[blockIndex(lx, 4, lz)] = reg.idOf('cloud');
  }
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: 1, z: 8 };
  for (let i = 0; i < 10; i++) p.step(1 / 60); // 先落地
  p.jump();
  let maxY = 0;
  for (let i = 0; i < 90; i++) { p.step(1 / 60); maxY = Math.max(maxY, p.pos.y); }
  assertTrue(maxY > 2.8, `jump passed through cloud, peak=${maxY}`);
});

test('physics: X/Z 穿过侧面云（水平不碰撞，M2-7）', () => {
  const { world, reg } = makeWorld();
  const col = world.getColumn(0, 0);
  // x=10 立一面云墙（y=1..3），对照石墙测试的同款布局
  for (let y = 1; y <= 3; y++) for (let lz = 0; lz < 16; lz++) {
    col.blocks[blockIndex(10, y, lz)] = reg.idOf('cloud');
  }
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: 1, z: 8 };
  for (let i = 0; i < 10; i++) p.step(1 / 60);
  for (let i = 0; i < 120; i++) { p.move(1, 0); p.step(1 / 60); }
  assertTrue(p.pos.x > 11, `walked through cloud wall, x=${p.pos.x}`);
});

test('physics: 云上对 solid 台阶仍走 _tryStepUp（M2-7）', () => {
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
