import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { WORLD_MIN_Y, WORLD_MAX_Y, blockIndex, sectionOf, columnKey } from '../voxel/constants.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';

function makeRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}

test('constants: 索引与 section 换算', () => {
  assertEqual(blockIndex(0, WORLD_MIN_Y, 0), 0);
  assertEqual(blockIndex(15, WORLD_MIN_Y, 15), 15 + 15 * 16);
  assertEqual(blockIndex(0, WORLD_MIN_Y + 16, 0), 256 * 16);
  assertEqual(sectionOf(WORLD_MIN_Y), 0);
  assertEqual(sectionOf(WORLD_MAX_Y - 1), 7); // 顶层有效方块 y=95 → section 7（MAX_Y=96 为 exclusive 上界）
  assertEqual(columnKey(3, -2), '3,-2');
});

test('ChunkColumn: set/get + 脏标记 + 版本', () => {
  const col = new ChunkColumn(0, 0);
  const v0 = col.version;
  col.set(1, WORLD_MIN_Y + 20, 2, 5, 3);
  assertEqual(col.get(1, WORLD_MIN_Y + 20, 2), 5);
  assertEqual(col.meta[blockIndex(1, WORLD_MIN_Y + 20, 2)], 3);
  assertTrue(col.version > v0, 'version bumped');
  assertEqual(col.edits.size, 1);
  assertTrue(col.dirtySections[sectionOf(WORLD_MIN_Y + 20)] === 1, 'section dirty');
  const dirty = col.takeDirty();
  assertEqual(dirty.length, 1);
  assertEqual(col.takeDirty().length, 0, 'takeDirty clears');
});

test('ChunkColumn: y 越界行为', () => {
  const col = new ChunkColumn(0, 0);
  col.set(0, WORLD_MAX_Y + 1, 0, 5);   // 静默忽略
  assertEqual(col.get(0, WORLD_MAX_Y + 1, 0), 0);
  assertEqual(col.version, 0, 'no version bump on out-of-bounds');
});

test('ChunkColumn: applyEdits 重放', () => {
  const col = new ChunkColumn(0, 0);
  col.applyEdits([{ index: blockIndex(2, WORLD_MIN_Y + 5, 2), id: 7, meta: 1 }]);
  assertEqual(col.get(2, WORLD_MIN_Y + 5, 2), 7);
  assertEqual(col.edits.size, 0, 'replay does not re-record edits');
});

test('WorldData: 跨 column 读写 + 越界', () => {
  const world = new WorldData(makeRegistry());
  const a = new ChunkColumn(0, 0), b = new ChunkColumn(1, 0);
  world.add(a); world.add(b);
  world.setBlock(15, WORLD_MIN_Y + 3, 0, 9);   // column a
  world.setBlock(16, WORLD_MIN_Y + 3, 0, 10);  // column b（x=16 → cx=1, lx=0）
  assertEqual(world.getBlockId(15, WORLD_MIN_Y + 3, 0), 9);
  assertEqual(world.getBlockId(16, WORLD_MIN_Y + 3, 0), 10);
  assertEqual(a.get(15, WORLD_MIN_Y + 3, 0), 9);
  assertEqual(b.get(0, WORLD_MIN_Y + 3, 0), 10);
  // 缺 column 返回 air；y 低于世界底返回 bedrock
  assertEqual(world.getBlockId(100, WORLD_MIN_Y + 3, 0), 0);
  const bedrockId = world.registry.idOf('bedrock');
  assertEqual(world.getBlockId(0, WORLD_MIN_Y - 5, 0), bedrockId);
});

test('WorldData: setBlock 返回受影响 section（贴边跨 column）', () => {
  const world = new WorldData(makeRegistry());
  world.add(new ChunkColumn(0, 0)); world.add(new ChunkColumn(1, 0));
  const r = world.setBlock(15, WORLD_MIN_Y + 3, 0, 9); // lx=15 贴 +X 边
  assertEqual(r.sy, 0);
  const keys = r.affected.map((a) => columnKey(a.cx, a.cz) + ':' + a.sy);
  assertTrue(keys.includes('0,0:0'), 'own section');
  assertTrue(keys.includes('1,0:0'), 'neighbor boundary section');
});

test('WorldData: getSectionView 拼接 halo', () => {
  const world = new WorldData(makeRegistry());
  const a = new ChunkColumn(0, 0), b = new ChunkColumn(1, 0);
  a.set(15, WORLD_MIN_Y + 5, 8, 11);   // 贴 +X 边
  b.set(0, WORLD_MIN_Y + 5, 8, 12);    // 邻居侧
  world.add(a); world.add(b);
  const view = world.getSectionView(0, 0, 0); // section sy=0 覆盖 y ∈ [-32,-17)
  // 18³ halo 触及 9 个 column，此处只有 2 个 → missing=true（缺失方向按 air 填充，拼接数据仍正确）
  assertEqual(view.missing, true);
  // halo 坐标：中心 section 内 (15,5,8) → view (16, 5+1, 9)；邻居 (0,5,8) → view (17, 6, 9)
  assertEqual(view.data[16 + 9 * 18 + 6 * 324], 11);
  assertEqual(view.data[17 + 9 * 18 + 6 * 324], 12);
});

test('WorldData: getSectionView 缺邻居 → missing=true', () => {
  const world = new WorldData(makeRegistry());
  world.add(new ChunkColumn(0, 0));
  const view = world.getSectionView(0, 0, 0);
  assertEqual(view.missing, true);
});
