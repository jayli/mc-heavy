import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { raycastVoxel } from '../player/raycast.js';
import { WorldData } from '../voxel/world-data.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { blockIndex } from '../voxel/constants.js';

function makeWorld() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
    col.blocks[blockIndex(lx, 0, lz)] = reg.idOf('stone');
  }
  world.add(col);
  return { world, reg };
}

test('raycast: 垂直向下命中地面（blockPos + prevPos）', () => {
  const { world } = makeWorld();
  const r = raycastVoxel(world, [8, 5, 8], [0, -1, 0], 40);
  assertTrue(r.hit, 'hit ground');
  assertEqual(r.blockPos[1], 0, 'hit y=0 stone');
  assertEqual(r.prevPos[1], 1, 'prev y=1 (placement spot)');
  assertEqual(r.normal[1], 1, 'normal points up');
});

test('raycast: 未命中返回 hit=false', () => {
  const { world } = makeWorld();
  const r = raycastVoxel(world, [8, 5, 8], [0, 1, 0], 40); // 朝天
  assertEqual(r.hit, false);
});

test('raycast: 斜向命中正确格', () => {
  const { world, reg } = makeWorld();
  const col = world.getColumn(0, 0);
  col.blocks[blockIndex(12, 1, 8)] = reg.idOf('stone');
  const r = raycastVoxel(world, [8, 1.5, 8], [1, 0, 0], 40);
  assertTrue(r.hit);
  assertEqual(r.blockPos[0], 12);
});

test('raycast: maxDist 截断', () => {
  const { world } = makeWorld();
  const r = raycastVoxel(world, [8, 5, 8], [0, -1, 0], 2); // 距离 5 > 2
  assertEqual(r.hit, false, 'beyond maxDist');
});

test('raycast: cloud 可命中（non-solid 不跳过）、water 仍跳过（M2-7）', () => {
  const { world, reg } = makeWorld();
  const col = world.getColumn(0, 0);
  col.blocks[blockIndex(8, 3, 8)] = reg.idOf('cloud');
  const r = raycastVoxel(world, [8, 6, 8], [0, -1, 0], 40);
  assertTrue(r.hit, 'hits cloud');
  assertEqual(r.blockPos[1], 3, 'hit block is cloud');
  // water 仍被跳过，命中其下方 stone
  col.blocks[blockIndex(4, 3, 8)] = reg.idOf('water');
  col.blocks[blockIndex(4, 2, 8)] = reg.idOf('stone');
  const r2 = raycastVoxel(world, [4, 6, 8], [0, -1, 0], 40);
  assertEqual(r2.blockPos[1], 2, 'water skipped, hits stone below');
});
