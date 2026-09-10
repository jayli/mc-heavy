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

test('ChunkColumn: restoreEdits 重建 blocks/meta/edits/blockEntities 且不 bump version', () => {
  const col = new ChunkColumn(0, 0);
  const stoneIdx = blockIndex(1, WORLD_MIN_Y + 1, 1);
  const anchorIdx = blockIndex(2, WORLD_MIN_Y + 5, 2);
  col.restoreEdits([
    { index: stoneIdx, id: 5, meta: 0 },
    { index: anchorIdx, id: 7, meta: 1, blockEntity: { kind: 'zombie-nest', id: 'nest-a' } },
  ]);
  assertEqual(col.get(1, WORLD_MIN_Y + 1, 1), 5);
  assertEqual(col.get(2, WORLD_MIN_Y + 5, 2), 7);
  assertEqual(col.meta[anchorIdx], 1);
  assertEqual(col.edits.size, 2, 'edits Map 一并重建（flush 不得只写新编辑）');
  assertEqual(col.blockEntities.size, 1);
  assertEqual(col.blockEntities.get(anchorIdx).id, 'nest-a');
  assertEqual(col.version, 0, '重放不 bump version');
  assertEqual(col.edits.get(stoneIdx).blockEntity, undefined, '无 entity 的 edit 不带该字段');
});

test('WorldData: setBlock 默认清除该格旧 blockEntity', () => {
  const world = new WorldData(makeRegistry());
  world.add(new ChunkColumn(0, 0));
  const gold = world.registry.idOf('gold_block');
  const anchorIdx = blockIndex(2, WORLD_MIN_Y + 5, 2);
  world.setBlock(2, WORLD_MIN_Y + 5, 2, gold, 0, { kind: 'zombie-nest', id: 'nest-a' });
  assertEqual(world.getBlockEntity(2, WORLD_MIN_Y + 5, 2).id, 'nest-a');
  // 底层 blockEntities Map 的 index 落点 = 局部坐标换算后的 index（防越界换算错位）
  assertTrue(world.getColumn(0, 0).blockEntities.has(anchorIdx), 'entity 落在正确 index');
  // 徒手挖掉关键方块：同一格改写不带 blockEntity → 旧 entity 必须消失
  world.setBlock(2, WORLD_MIN_Y + 5, 2, 0);
  assertEqual(world.getBlockEntity(2, WORLD_MIN_Y + 5, 2), null, '改写清除旧 entity');
  assertEqual(world.getColumn(0, 0).blockEntities.size, 0, '底层 Map 一并清空');
  assertEqual(world.getBlockEntity(999, 0, 999), null, '缺 column 返回 null');
  assertEqual(world.getBlockEntity(0, WORLD_MAX_Y + 1, 0), null, 'y 越界返回 null');
});

test('WorldData: setBlock 同一 change 显式给 blockEntity 时保留替换值', () => {
  const world = new WorldData(makeRegistry());
  world.add(new ChunkColumn(0, 0));
  const gold = world.registry.idOf('gold_block');
  world.setBlock(2, WORLD_MIN_Y + 5, 2, gold, 0, { kind: 'zombie-nest', id: 'nest-a' });
  world.setBlock(2, WORLD_MIN_Y + 5, 2, gold, 0, { kind: 'zombie-nest', id: 'nest-b', lastSpawnAt: 8000 });
  assertEqual(world.getBlockEntity(2, WORLD_MIN_Y + 5, 2).id, 'nest-b', '替换生效');
  assertEqual(world.getBlockEntity(2, WORLD_MIN_Y + 5, 2).lastSpawnAt, 8000);
});

test('WorldData: setBlocks 携带 blockEntity 一次事务写入', () => {
  const world = new WorldData(makeRegistry());
  const a = new ChunkColumn(0, 0);
  world.add(a);
  a.state = 'ready';
  const gold = world.registry.idOf('gold_block');
  const sand = world.registry.idOf('sand');
  const r = world.setBlocks([
    { x: 1, y: WORLD_MIN_Y + 1, z: 1, id: sand },
    { x: 2, y: WORLD_MIN_Y + 5, z: 2, id: gold, blockEntity: { kind: 'zombie-nest', id: 'nest-a', lastSpawnAt: 0 } },
  ]);
  assertEqual(r.changes.length, 2);
  assertEqual(world.getBlockEntity(2, WORLD_MIN_Y + 5, 2).id, 'nest-a');
  assertEqual(world.getBlockEntity(1, WORLD_MIN_Y + 1, 1), null, '不带 entity 的格无 entity');
  assertEqual(a.blockEntities.size, 1);
  assertEqual(a.edits.get(blockIndex(2, WORLD_MIN_Y + 5, 2)).blockEntity.id, 'nest-a', 'edits 记录带 entity');
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

test('WorldData: setBlocks 跨 column 原子写入（每列一次版本 + 逐格 edits + meta）', () => {
  const world = new WorldData(makeRegistry());
  const a = new ChunkColumn(0, 0), b = new ChunkColumn(1, 0);
  world.add(a); world.add(b);
  a.state = 'ready'; b.state = 'ready';
  const va = a.version, vb = b.version;
  const r = world.setBlocks([
    { x: 1, y: WORLD_MIN_Y + 3, z: 0, id: 9, meta: 2 },   // column a
    { x: 2, y: WORLD_MIN_Y + 3, z: 0, id: 10 },           // column a
    { x: 16, y: WORLD_MIN_Y + 3, z: 0, id: 11, meta: 1 }, // column b（x=16 → cx=1）
    { x: 1, y: WORLD_MIN_Y + 3, z: 0, id: 12 },           // 同坐标再写：最后一次获胜
  ]);
  assertEqual(a.version, va + 1, 'column a 只 bump 一次');
  assertEqual(b.version, vb + 1, 'column b 只 bump 一次');
  assertEqual(r.changes.length, 3, '同坐标去重后 3 项变更');
  assertEqual(world.getBlockId(1, WORLD_MIN_Y + 3, 0), 12, '最后写入获胜');
  assertEqual(world.getBlockMeta(1, WORLD_MIN_Y + 3, 0), 0, '最后写入的 meta 生效');
  assertEqual(world.getBlockMeta(16, WORLD_MIN_Y + 3, 0), 1, 'meta 写入');
  assertEqual(a.edits.size, 2, 'column a 逐格记录 edits');
  assertEqual(b.edits.size, 1, 'column b 逐格记录 edits');
  assertTrue(r.changedColumns.includes(columnKey(0, 0)));
  assertTrue(r.changedColumns.includes(columnKey(1, 0)));
});

test('WorldData: getBlockMeta 越界/缺 column 返回 0', () => {
  const world = new WorldData(makeRegistry());
  assertEqual(world.getBlockMeta(0, WORLD_MAX_Y + 1, 0), 0, 'y 越上界');
  assertEqual(world.getBlockMeta(0, WORLD_MIN_Y - 1, 0), 0, 'y 越下界');
  assertEqual(world.getBlockMeta(999, 0, 999), 0, 'column 缺失');
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
