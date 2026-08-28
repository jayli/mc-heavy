import { test } from './runner.js';
import { assertTrue } from './assert.js';
import { PlayerPhysics } from '../player/physics.js';
import { WorldData } from '../voxel/world-data.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { WORLD_MIN_Y, blockIndex } from '../voxel/constants.js';

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

test('WorldData.supportsPlayer: 坐标查询（M2-7）', () => {
  const { world, reg } = makeWorld();
  const col = world.getColumn(0, 0);
  col.blocks[blockIndex(8, 10, 8)] = reg.idOf('cloud');
  assertTrue(world.supportsPlayer(8, 10, 8), 'cloud supports');
  assertTrue(!world.supportsPlayer(8, 0, 8), 'stone does not');
  assertTrue(!world.supportsPlayer(8, 20, 8), 'air does not');
});
