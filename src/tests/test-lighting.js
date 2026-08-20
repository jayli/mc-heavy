import { test } from './runner.js';
import { assertEqual } from './assert.js';
import { computeSkylightColumn, computeBlocklightRegion, recomputeLight } from '../mesh/lighting.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';
import { WORLD_MIN_Y, blockIndex } from '../voxel/constants.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';

function makeRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}
const sky = (col, lx, y, lz) => col.light[blockIndex(lx, y, lz)] >> 4;
const blk = (col, lx, y, lz) => col.light[blockIndex(lx, y, lz)] & 0xF;

test('skylight: 露天列全程 15', () => {
  const reg = makeRegistry();
  const col = new ChunkColumn(0, 0);
  computeSkylightColumn(col, reg);
  assertEqual(sky(col, 8, 90, 8), 15);
  assertEqual(sky(col, 8, WORLD_MIN_Y + 1, 8), 15);
});

test('skylight: opaque 方块遮挡（下方为 0，封闭洞穴正确）', () => {
  const reg = makeRegistry();
  const col = new ChunkColumn(0, 0);
  const stoneId = reg.idOf('stone');
  col.blocks[blockIndex(8, 50, 8)] = stoneId;
  computeSkylightColumn(col, reg);
  assertEqual(sky(col, 8, 51, 8), 15);
  assertEqual(sky(col, 8, 50, 8), 0, 'opaque block itself is dark');
  assertEqual(sky(col, 8, 49, 8), 0, 'below opaque is dark');
  assertEqual(sky(col, 8, 20, 8), 0);
});

test('skylight: 透明方块不遮挡（玻璃下方仍 15）', () => {
  const reg = makeRegistry();
  const col = new ChunkColumn(0, 0);
  col.blocks[blockIndex(8, 50, 8)] = reg.idOf('glass_block');
  computeSkylightColumn(col, reg);
  assertEqual(sky(col, 8, 49, 8), 15);
});

test('blocklight: 光源 flood fill 衰减', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  world.add(col);
  col.blocks[blockIndex(8, 50, 8)] = reg.idOf('glowstone'); // emissive 15
  computeBlocklightRegion(world, 0, 0, reg);
  assertEqual(blk(col, 8, 50, 8), 15);
  assertEqual(blk(col, 8, 51, 8), 14);
  assertEqual(blk(col, 9, 50, 8), 14);
  assertEqual(blk(col, 8, 55, 8), 10);
  assertEqual(blk(col, 8, 66, 8), 0, 'beyond radius 15 is dark');
});

test('blocklight: opaque 阻挡传播', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  world.add(col);
  col.blocks[blockIndex(8, 50, 8)] = reg.idOf('glowstone');
  // 在光源上方盖一层石头
  for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
    col.blocks[blockIndex(lx, 52, lz)] = reg.idOf('stone');
  }
  computeBlocklightRegion(world, 0, 0, reg);
  assertEqual(blk(col, 8, 51, 8), 14, 'below lid still lit');
  assertEqual(blk(col, 8, 53, 8), 0, 'above lid dark');
});

test('blocklight: 跨 column 泄漏', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const a = new ChunkColumn(0, 0), b = new ChunkColumn(1, 0);
  world.add(a); world.add(b);
  a.blocks[blockIndex(15, 50, 8)] = reg.idOf('glowstone'); // 贴 +X 边
  computeBlocklightRegion(world, 0, 0, reg);
  assertEqual(blk(b, 0, 50, 8), 14, 'light leaks into neighbor column');
});

test('recomputeLight: 挖掉光源后降光（全 column 重算兜底，§4.6）', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  world.add(col);
  col.blocks[blockIndex(8, 50, 8)] = reg.idOf('glowstone');
  recomputeLight(world, 0, 0, reg);
  assertEqual(blk(col, 8, 51, 8), 14);
  col.blocks[blockIndex(8, 50, 8)] = 0; // 挖掉
  recomputeLight(world, 0, 0, reg);
  assertEqual(blk(col, 8, 51, 8), 0, 'light removed after recompute');
});

test('recomputeLight: 挖掉 opaque 后 skylight 恢复（挖块黑面 bug 回归）', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  world.add(col);
  // 铺一层石头地面 y=50：下方全黑
  for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
    col.blocks[blockIndex(lx, 50, lz)] = reg.idOf('stone');
  }
  recomputeLight(world, 0, 0, reg);
  assertEqual(sky(col, 8, 49, 8), 0, 'below ground is dark');
  // 挖掉 (8,50,8)：下方应恢复 skylight 15
  col.blocks[blockIndex(8, 50, 8)] = 0;
  recomputeLight(world, 0, 0, reg);
  assertEqual(sky(col, 8, 50, 8), 15, 'dug cell lit');
  assertEqual(sky(col, 8, 49, 8), 15, 'below dug cell lit');
  assertEqual(sky(col, 8, 30, 8), 15, 'deep below dug cell lit');
  assertEqual(sky(col, 9, 49, 8), 0, 'unrelated column still dark');
});

test('setBlock: 挖块走真实路径后 skylight 增量恢复（黑面 bug 端到端）', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  world.add(col);
  for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
    col.blocks[blockIndex(lx, 50, lz)] = reg.idOf('stone');
  }
  recomputeLight(world, 0, 0, reg);
  assertEqual(sky(col, 8, 49, 8), 0, 'below ground is dark');
  // 真实游玩路径：world.setBlock 挖块 → 内部增量重算同列 skylight
  world.setBlock(8, 50, 8, 0);
  assertEqual(sky(col, 8, 50, 8), 15, 'dug cell lit after setBlock');
  assertEqual(sky(col, 8, 49, 8), 15, 'below dug cell lit after setBlock');
  assertEqual(sky(col, 9, 49, 8), 0, 'unrelated column unaffected');
});
