// src/tests/test-orientation.js — M3.2 方块朝向放置交互（设计文档 §4.3，v1.17 定稿）
// 覆盖：nextOrientation 循环、放置朝向三分支（门控/原位重转/类型记忆/默认）、
// 原位判定要求 x/y/z/type 四者全等、跨位置沿用记忆、world.getBlockMeta 越界与缺列、
// 门控集合与 mc-lite 一致。
//
// 门控数字实测口径（2026-09-03，勿凭文档印象改）：
//   mc-lite   124 方块：orientationEnabled=true 40 / false 84
//   mc-heavy  126 方块：orientationModes>0     40 / ==0 86
// true 集合两侧零差异（roadmap 的比对结论成立）；false 是 86 而非文档写的 84——
// mc-heavy 比 mc-lite 多 sky_stone/sky_grass（M2-7 新增），二者门控均为 0。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { WorldData } from '../voxel/world-data.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WORLD_MIN_Y, WORLD_MAX_Y } from '../voxel/constants.js';
import { nextOrientation, getPlacementOrientation } from '../player/orientation.js';

/** 生产同源注册表（与 main.js/worker 一致：BLOCKS 全量注册后冻结） */
function makeRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}

// --- nextOrientation：顺时针 90°（mc-lite OrientationUtils.js 语义） ---

test('orientation: nextOrientation 顺时针循环 0→1→2→3→0', () => {
  assertEqual(nextOrientation(0), 1, 'EAST -> SOUTH');
  assertEqual(nextOrientation(1), 2, 'SOUTH -> WEST');
  assertEqual(nextOrientation(2), 3, 'WEST -> NORTH');
  assertEqual(nextOrientation(3), 0, 'NORTH -> EAST (循环)');
});

test('orientation: nextOrientation 非法输入回落 EAST（mc-lite `(current||0)+1` 语义）', () => {
  assertEqual(nextOrientation(null), 1, 'null → 1');
  assertEqual(nextOrientation(undefined), 1, 'undefined → 1');
  assertEqual(nextOrientation(0), 1, '0 不得被 `||` 吞成默认');
});

// --- 门控集合：复用 orientationModesTable，不新增字段 ---

test('orientation: 门控集合 = mc-heavy 41 项启用 / 98 项不参与旋转', () => {
  const reg = makeRegistry();
  const all = reg.all();
  assertEqual(all.length, 139);
  const enabled = all.filter((b) => reg.orientationModesTable[b.id] > 0);
  const disabled = all.filter((b) => reg.orientationModesTable[b.id] === 0);
  // ⚠️ 2026-11-04：realistic_oak_leaves（orientationModes=4）已删除 → 42 → 41。
  assertEqual(enabled.length, 41, '启用朝向的方块数（mc-lite 40 + 巨型金字塔 sand_step 1 + 中世纪船 planks_step_updown 1 − 已删 realistic_oak_leaves）');
  assertEqual(disabled.length, 98, '恒 EAST 的方块数（124 方块的 mc-lite 是 84，此处多 sky_stone/sky_grass、巨树 8 个 giant_*、sand_slab、浅水高台 2 个草、中世纪船 half_block_updown）');
  // 抽查：chest 启用、stone 不参与旋转、M2-7 新增的两个 sky 方块不参与旋转
  assertTrue(reg.orientationModesTable[reg.idOf('chest')] > 0, 'chest 启用朝向');
  assertEqual(reg.orientationModesTable[reg.idOf('stone')], 0, 'stone 不参与旋转');
  assertEqual(reg.orientationModesTable[reg.idOf('sky_stone')], 0, 'sky_stone 不参与旋转');
  assertEqual(reg.orientationModesTable[reg.idOf('sky_grass')], 0, 'sky_grass 不参与旋转');
});

// --- 三分支放置朝向 ---

/** 分支 ①：门控关闭 → 恒 0，且不写记忆（84/86 个方块不参与旋转） */
test('orientation: 分支① 门控关闭的方块恒返回 0，且无记忆时也不写记忆', () => {
  const reg = makeRegistry();
  const stone = reg.idOf('stone');
  const memory = new Map();
  assertEqual(getPlacementOrientation(10, 5, 10, stone, reg.orientationModesTable, null, memory), 0);
  assertEqual(memory.size, 0, '门控关闭不写类型记忆');
  // 即使有同类型记忆也仍恒 0（门控优先于记忆）
  memory.set(stone, 2);
  assertEqual(getPlacementOrientation(10, 5, 10, stone, reg.orientationModesTable, null, memory), 0);
});

/** 分支 ① 边界：门控关闭时即使原位重放同类型也不旋转 */
test('orientation: 门控关闭时原位重放同类型也不旋转（门控优先于原位重转）', () => {
  const reg = makeRegistry();
  const stone = reg.idOf('stone');
  const lastRemoved = { x: 10, y: 5, z: 10, id: stone, orientation: 3 };
  const memory = new Map();
  assertEqual(
    getPlacementOrientation(10, 5, 10, stone, reg.orientationModesTable, lastRemoved, memory),
    0,
  );
  assertEqual(memory.size, 0);
});

/** 分支 ②：原位重建同类型 → 旧朝向 +1 % 4，并写入类型记忆 */
test('orientation: 分支② 原位重建同类型 → 顺时针旋转并写入类型记忆', () => {
  const reg = makeRegistry();
  const chest = reg.idOf('chest');
  const memory = new Map();
  // 原位挖掉 meta=0 的 chest 再放回 → 1
  assertEqual(
    getPlacementOrientation(10, 5, 10, chest, reg.orientationModesTable,
      { x: 10, y: 5, z: 10, id: chest, orientation: 0 }, memory),
    1,
  );
  assertEqual(memory.get(chest), 1, '旋转结果写入类型记忆');
});

/** 分支 ② 连续四次原位挖放：1→2→3→0 循环（真实手感来源） */
test('orientation: 连续四次原位挖放 → 1→2→3→0 循环', () => {
  const reg = makeRegistry();
  const chest = reg.idOf('chest');
  const memory = new Map();
  const seq = [];
  let orientation = 0; // 初始放置 meta=0
  for (let i = 0; i < 4; i++) {
    // 挖块：记下旧朝向
    const removed = { x: 10, y: 5, z: 10, id: chest, orientation };
    // 原位放回
    orientation = getPlacementOrientation(10, 5, 10, chest, reg.orientationModesTable, removed, memory);
    seq.push(orientation);
  }
  assertEqual(seq.join(','), '1,2,3,0', '四次原位挖放的朝向序列');
});

/** 分支 ② 原位判定要求 x/y/z/id 四者全等：改任一即不触发重转 */
test('orientation: 原位判定要求 x/y/z/id 四者全等（改任一即走记忆分支）', () => {
  const reg = makeRegistry();
  const chest = reg.idOf('chest');
  const handrail = reg.idOf('handrail'); // 另一启用朝向的方块，用于「原位放别的类型」
  const memory = new Map([[chest, 2]]); // 有记忆 → 走分支③沿用 2
  const removed = { x: 10, y: 5, z: 10, id: chest, orientation: 0 };
  // x 不同
  assertEqual(getPlacementOrientation(11, 5, 10, chest, reg.orientationModesTable, removed, memory), 2);
  // y 不同
  assertEqual(getPlacementOrientation(10, 6, 10, chest, reg.orientationModesTable, removed, memory), 2);
  // z 不同
  assertEqual(getPlacementOrientation(10, 5, 11, chest, reg.orientationModesTable, removed, memory), 2);
  // 类型不同（原位放别的方块）
  assertEqual(getPlacementOrientation(10, 5, 10, handrail, reg.orientationModesTable, removed, memory), 0,
    'handrail 无记忆 → 默认 EAST');
  // 四者全等 → 旋转
  assertEqual(getPlacementOrientation(10, 5, 10, chest, reg.orientationModesTable, removed, memory), 1);
});

/** 分支 ③：跨位置放置同类型 → 沿用该类型的上次朝向（不旋转） */
test('orientation: 分支③ 跨位置放同类型沿用类型记忆，且不改写记忆', () => {
  const reg = makeRegistry();
  const chest = reg.idOf('chest');
  const memory = new Map([[chest, 3]]);
  assertEqual(getPlacementOrientation(99, 20, 99, chest, reg.orientationModesTable, null, memory), 3);
  assertEqual(memory.get(chest), 3, '沿用不改写记忆');
});

/** 分支 ④：无记忆 → 默认 EAST 0 */
test('orientation: 分支④ 无记忆且非原位 → 默认 0（EAST）', () => {
  const reg = makeRegistry();
  const chest = reg.idOf('chest');
  assertEqual(
    getPlacementOrientation(10, 5, 10, chest, reg.orientationModesTable, null, new Map()),
    0,
  );
});

/** 分支优先级：原位重转优先于类型记忆（mc-lite if/else if 顺序） */
test('orientation: 分支② 优先于分支③（原位重转覆盖已有记忆）', () => {
  const reg = makeRegistry();
  const chest = reg.idOf('chest');
  const memory = new Map([[chest, 3]]); // 记忆是 3
  const removed = { x: 10, y: 5, z: 10, id: chest, orientation: 1 }; // 原位挖掉的是 1
  // 原位重转基于 lastRemovedBlock.orientation（1 → 2），不是记忆的 3 → 4
  assertEqual(getPlacementOrientation(10, 5, 10, chest, reg.orientationModesTable, removed, memory), 2);
  assertEqual(memory.get(chest), 2, '记忆被旋转结果覆写');
});

/** 记忆值为 0 是合法记忆状态（沿用 0，不是「无记忆」） */
test('orientation: 记忆值 0 仍算有记忆（沿用 0，不被 falsy 判空当成无记忆）', () => {
  const reg = makeRegistry();
  const chest = reg.idOf('chest');
  // 先把 chest 转到 0（连续四次原位挖放的最后一步），记忆即 0
  const memory = new Map();
  let orientation = 0;
  for (let i = 0; i < 4; i++) {
    const removed = { x: 10, y: 5, z: 10, id: chest, orientation };
    orientation = getPlacementOrientation(10, 5, 10, chest, reg.orientationModesTable, removed, memory);
  }
  assertEqual(memory.get(chest), 0, '循环回到 EAST 后记忆值为 0');
  // 跨位置放置：沿用记忆 0（若实现误写成 `memory.get(id) || 0` 恰好等价，
  // 但写成「记忆值 falsy 即视为无记忆并改走分支④」则会丢掉这条记忆语义）
  assertEqual(getPlacementOrientation(50, 10, 50, chest, reg.orientationModesTable, null, memory), 0);
  // 且分支③不改写记忆
  assertEqual(memory.size, 1);
});

// --- world.getBlockMeta：O(1) 直查，越界/缺列返回 0 ---

test('world.getBlockMeta: 返回 setBlock 写入的 meta', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  world.add(new ChunkColumn(0, 0));
  world.setBlock(3, WORLD_MIN_Y + 20, 4, reg.idOf('chest'), 2);
  assertEqual(world.getBlockMeta(3, WORLD_MIN_Y + 20, 4), 2);
});

test('world.getBlockMeta: 未写入的方块返回 0', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  world.add(new ChunkColumn(0, 0));
  world.setBlock(3, WORLD_MIN_Y + 20, 4, reg.idOf('stone'), 0);
  assertEqual(world.getBlockMeta(3, WORLD_MIN_Y + 20, 4), 0);
});

test('world.getBlockMeta: column 缺失返回 0（不抛错）', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg); // 无任何 column
  assertEqual(world.getBlockMeta(3, WORLD_MIN_Y + 20, 4), 0);
});

test('world.getBlockMeta: y 越界返回 0（上界与下界，含 bedrock 防穿底层）', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  world.add(new ChunkColumn(0, 0));
  assertEqual(world.getBlockMeta(3, WORLD_MAX_Y, 4), 0, 'y >= MAX_Y 上界');
  assertEqual(world.getBlockMeta(3, WORLD_MAX_Y + 100, 4), 0, 'y 远超上界');
  // 下界：getBlockId 在 y < MIN_Y 时返回 bedrock 防穿底，但 meta 无 bedrock 记录 → 0
  assertEqual(world.getBlockMeta(3, WORLD_MIN_Y - 1, 4), 0, 'y < MIN_Y 下界');
});

test('world.getBlockMeta: 跨 column 定位正确（负坐标 column）', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  world.add(new ChunkColumn(-1, -2));
  world.setBlock(-5, WORLD_MIN_Y + 10, -20, reg.idOf('chest'), 3);
  assertEqual(world.getBlockMeta(-5, WORLD_MIN_Y + 10, -20), 3);
  // 同 column 另一格不受影响
  assertEqual(world.getBlockMeta(-6, WORLD_MIN_Y + 10, -20), 0);
});

test('world.getBlockMeta: meta 写入随 edits 持久化通路（重启后朝向保留的数据基础）', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  world.add(col);
  world.setBlock(3, WORLD_MIN_Y + 20, 4, reg.idOf('chest'), 2);
  // edits 条目带 meta（M2 既有通路，本项不改 schema）
  const edit = [...col.edits.values()][0];
  assertEqual(edit.meta, 2, 'edits 记录 meta');
  assertEqual(edit.id, reg.idOf('chest'));
  // 重放后 meta 复原（applyEdits 通路）
  const fresh = new ChunkColumn(0, 0);
  fresh.applyEdits([...col.edits.entries()].map(([index, e]) => ({ index, id: e.id, meta: e.meta })));
  const world2 = new WorldData(reg);
  world2.add(fresh);
  assertEqual(world2.getBlockMeta(3, WORLD_MIN_Y + 20, 4), 2, '重放后朝向保留');
});

// --- 挖块记忆 / 放置清空的纯逻辑（Player 集成走 Playwright） ---

test('orientation: 挖块记录的旧朝向来自 meta（记 null 表示无记录）', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  world.add(new ChunkColumn(0, 0));
  world.setBlock(3, WORLD_MIN_Y + 20, 4, reg.idOf('chest'), 2);
  // 挖前读 meta（Player.digBlock 的口径）
  const orientation = world.getBlockMeta(3, WORLD_MIN_Y + 20, 4);
  const removed = { x: 3, y: WORLD_MIN_Y + 20, z: 4, id: reg.idOf('chest'), orientation };
  assertEqual(removed.orientation, 2, '记下的旧朝向 = 世界 meta');
  // 原位放回 → 3
  assertEqual(
    getPlacementOrientation(3, WORLD_MIN_Y + 20, 4, removed.id, reg.orientationModesTable, removed, new Map()),
    3,
  );
});

test('orientation: 无挖块记录（null）时放置走记忆/默认分支', () => {
  const reg = makeRegistry();
  const chest = reg.idOf('chest');
  // null 记录 = 放置成功清空后的状态
  assertEqual(getPlacementOrientation(1, 2, 3, chest, reg.orientationModesTable, null, new Map()), 0);
  assertEqual(
    getPlacementOrientation(1, 2, 3, chest, reg.orientationModesTable, null, new Map([[chest, 1]])),
    1,
  );
});

test('orientation: 纯函数无副作用（不改传入的 lastRemovedBlock，只写 memory）', () => {
  const reg = makeRegistry();
  const chest = reg.idOf('chest');
  const removed = { x: 1, y: 2, z: 3, id: chest, orientation: 1 };
  const memory = new Map();
  const result = getPlacementOrientation(1, 2, 3, chest, reg.orientationModesTable, removed, memory);
  assertEqual(result, 2, '原位重转 1 → 2');
  assertEqual(removed.orientation, 1, 'lastRemovedBlock.orientation 不被改写');
  assertEqual(removed.x, 1, 'lastRemovedBlock 坐标不被改写');
  assertEqual(memory.size, 1, '副作用只有 memory 一处（世界权威不受影响）');
});

test('orientation: 记忆 Map 为空时分支②仍写记忆（首次旋转即建立类型记忆）', () => {
  const reg = makeRegistry();
  const chest = reg.idOf('chest');
  const memory = new Map();
  assertEqual(memory.size, 0);
  getPlacementOrientation(7, 8, 9, chest, reg.orientationModesTable,
    { x: 7, y: 8, z: 9, id: chest, orientation: 2 }, memory);
  assertEqual(memory.get(chest), 3);
  // 此后跨位置放 chest 沿用 3
  assertEqual(getPlacementOrientation(100, 100, 100, chest, reg.orientationModesTable, null, memory), 3);
});
