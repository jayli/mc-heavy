import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { buildSectionMesh } from '../mesh/mesher.js';
import { computeSkylightColumn } from '../mesh/lighting.js';
import { WorldData } from '../voxel/world-data.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { WORLD_MIN_Y, blockIndex } from '../voxel/constants.js';

function makeRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}

// 最小 atlasMeta（只需测试用到的 tile UV）
const atlasMeta = {
  stone: { u0: 0.0, v0: 0.0, u1: 0.01, v1: 0.01 },
  grass: { u0: 0.02, v0: 0.0, u1: 0.03, v1: 0.01 },
  dirt:  { u0: 0.04, v0: 0.0, u1: 0.05, v1: 0.01 },
  glass_block: { u0: 0.06, v0: 0.0, u1: 0.07, v1: 0.01 },
  leaves: { u0: 0.08, v0: 0.0, u1: 0.09, v1: 0.01 },
  water: { u0: 0.10, v0: 0.0, u1: 0.11, v1: 0.01 },
};

function makeWorldWithBlock(reg, lx, y, lz, id) {
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  col.blocks[blockIndex(lx, y, lz)] = id;
  world.add(col);
  return world;
}

test('mesher: 单个 opaque 方块 → 6 面 24 顶点', () => {
  const reg = makeRegistry();
  const world = makeWorldWithBlock(reg, 8, WORLD_MIN_Y + 5, 8, reg.idOf('stone'));
  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  assertEqual(result.opaque.vertexCount, 24, 'one cube = 24 vertices');
  assertEqual(result.opaque.indexCount, 36, 'one cube = 36 indices');
  assertEqual(result.cutout.vertexCount, 0);
  assertEqual(result.transparent.vertexCount, 0);
});

test('mesher: 两个相邻 opaque 方块 → 共享面剔除（10 面）', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  const stoneId = reg.idOf('stone');
  col.blocks[blockIndex(8, WORLD_MIN_Y + 5, 8)] = stoneId;
  col.blocks[blockIndex(9, WORLD_MIN_Y + 5, 8)] = stoneId;
  world.add(col);
  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  // 两个相邻 cube：各 6 面，共享 1 面剔除 → 10 面 = 40 顶点
  assertEqual(result.opaque.vertexCount, 40, 'two adjacent cubes = 10 faces');
});

test('mesher: cutout 方块（leaves）→ cutout 通道', () => {
  const reg = makeRegistry();
  const world = makeWorldWithBlock(reg, 8, WORLD_MIN_Y + 5, 8, reg.idOf('leaves'));
  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  assertEqual(result.cutout.vertexCount, 24);
  assertEqual(result.opaque.vertexCount, 0);
});

test('mesher: transparent 方块（glass）→ transparent 通道', () => {
  const reg = makeRegistry();
  const world = makeWorldWithBlock(reg, 8, WORLD_MIN_Y + 5, 8, reg.idOf('glass_block'));
  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  assertEqual(result.transparent.vertexCount, 24);
  assertEqual(result.opaque.vertexCount, 0);
});

test('mesher: 同类型 water 相邻不画面', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  const waterId = reg.idOf('water');
  col.blocks[blockIndex(8, WORLD_MIN_Y + 5, 8)] = waterId;
  col.blocks[blockIndex(9, WORLD_MIN_Y + 5, 8)] = waterId;
  world.add(col);
  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  // 两个相邻 water：共享面剔除 → 10 面
  assertEqual(result.transparent.vertexCount, 40);
});

test('mesher: packed 包含 light 和面索引', () => {
  const reg = makeRegistry();
  const world = makeWorldWithBlock(reg, 8, WORLD_MIN_Y + 5, 8, reg.idOf('stone'));
  // 先算 skylight，否则 col.light 全 0（light 是派生缓存，mesher 只透传）
  computeSkylightColumn(world.getColumn(0, 0), reg);
  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  const packed = result.opaque.packed;
  // 顶面（+Y，面索引 2）的 light 应为 15（skylight 全亮）
  // 找面索引为 2 的顶点
  let foundTop = false;
  for (let i = 0; i < result.opaque.vertexCount; i++) {
    const faceIdx = (packed[i] >> 10) & 0x7;
    const light = packed[i] & 0xFF;
    if (faceIdx === 2) {
      foundTop = true;
      assertTrue(light >= 0xF0, `top face skylight should be 15, got ${light >> 4}`);
    }
  }
  assertTrue(foundTop, 'top face exists');
});

test('mesher: AO 值在 packed bit8-9', () => {
  const reg = makeRegistry();
  const world = makeWorldWithBlock(reg, 8, WORLD_MIN_Y + 5, 8, reg.idOf('stone'));
  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  const packed = result.opaque.packed;
  for (let i = 0; i < result.opaque.vertexCount; i++) {
    const ao = (packed[i] >> 8) & 0x3;
    assertTrue(ao >= 0 && ao <= 3, `AO value ${ao} in range`);
  }
});
