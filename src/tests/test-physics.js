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
