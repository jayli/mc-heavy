// src/tests/test-player-place.js — 放置的「自身 AABB 守卫」（v2.22）
//
// 用户反馈：「玩家放置方块时，如果放置的方块离玩家位置太近，会导致放完方块让玩家直接就穿模了，
// 所以需要在放置方块的时候加一个判断，如果判断放置方块的位置太近，导致方块和玩家碰撞穿模了，
// 就不放置方块。」
//
// **根因**（实测，见 docs/roadmap.md 的 v2.22 行）：`Player._placeSingle()` 的旧守卫是**格近似**
// 而非真实 AABB —— `x === floor(p.x) && z === floor(p.z) && (y === floor(p.y) || y === floor(p.y+1))`。
// 玩家 AABB 是 0.6×1.8×0.6，两处漏判：
//   ① 水平偏心时（p.x 小数部分 >0.7 或 <0.3）AABB **跨两列**，另一列整列放行；
//   ② 竖直用 `floor(p.y)+1` 而非真实顶面，跳跃/下落中（p.y 是小数）头顶格漏判。
// 实测 `(8.9, 1, 8.9)` 时有 **6 格**「旧守卫放行但真实 AABB 相交」：
//   (9,1,8) (9,2,8) (8,1,9) (8,2,9) (9,1,9) (9,2,9)
// 这些正是准心斜向下对着邻格顶面时 `prevPos` 落到的格。
//
// ⚠️ **本文件走真实 `placeBlock()` 全路径**（构造 `target` → `placeBlock()`），不是直接调
// `_placeSingle()`：后者会绕过「命中路径 / 兜底路径」的分流，属 M7「只测 API 漏玩家主路径」的
// 同类盲区。判据落在**编辑入口是否被调用**（`editor.calls`）而非只看 world —— 「零写入」的
// 真实原因是守卫拦住了，world 里没方块只是结果。
//
// v2.25（放置就近优先）：文件末尾的 ③ 增补「就近优先」用例 —— 同样走真实 `placeBlock()` 全路径，
// `target` 由真实 DDA 算出（`aimAndPlace`，与 `update()` 同款），相机姿态摆在眼睛处；
// 判据同样落在**编辑入口写了哪几格**（`editor.calls`），不是只看 world。
import { test } from './runner.js';
import { assertTrue, assertFalse, assertEqual } from './assert.js';
import { Player } from '../player/player.js';
import { WorldData } from '../voxel/world-data.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { raycastVoxel } from '../player/raycast.js';

/** 登记全部生产方块（守卫读 `solidTable`，必须与真实 registry 同源）。 */
function makeRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}

/**
 * 记录调用的 fake editor。`setBlock` 同时写 world（真实编辑器也写），
 * 这样「编辑真的发生时世界会变」与「编辑没被调用时世界不变」两条判据都成立。
 */
function makeEditor(world) {
  return {
    calls: [],
    setBlock(c) {
      this.calls.push(c);
      world.setBlock(c.x, c.y, c.z, c.id, c.meta ?? 0);
      return { changes: [c] };
    },
    setBlocks(cs) { this.calls.push(...cs); return { changes: cs }; },
    setBlockEntity(r) { this.calls.push(r); },
    subscribe: () => () => {},
  };
}

/** Player fixture：最小 world（一个 column 覆盖 x,z ∈ [0,16)）+ fake canvas。 */
function makeFixture() {
  const registry = makeRegistry();
  const world = new WorldData(registry);
  world.add(new ChunkColumn(0, 0));
  const editor = makeEditor(world);
  const player = new Player({
    world, registry, editor,
    canvas: { addEventListener: () => {}, removeEventListener: () => {}, requestPointerLock: () => {} },
    // camera 用真实 three 的对象不行（本文件不 import three）；Player 构造期只用它做射线基。
    camera: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0 }, getWorldDirection: () => ({ x: 0, y: 0, z: -1 }) },
    scheduler: null,
  });
  return { player, editor, world, registry };
}

/** 选中背包里的某个物品（`placeBlock()` 从 `inventory.getSelected()` 取物品） */
function selectItem(player, item) {
  const idx = player.inventory.slots.findIndex((s) => s.item === item);
  player.inventory.selectSlot(idx);
  return idx;
}

/**
 * 摆出「准心命中 `block`、prevPos 为 `prev`」的真实 DDA target 形状，然后走 `placeBlock()`。
 * ⚠️ `Player.placeBlock()` 的**所有分支都不返回布尔值**（命中路径隐式 `undefined`、
 * 兜底路径返回布尔），所以「是否放下」的判据落在**编辑入口是否被调用** + world 的实际内容上 ——
 * 这也正是「零写入」的因果判据（世界没变只是结果）。
 * @returns {{editorCalls: number, cellId: number}}
 */
function placeAt(player, editor, world, cell) {
  const [x, y, z] = cell;
  // 真实 raycast 的语义：blockPos = 被命中的方块，prevPos = 命中面外侧的相邻空气格。
  // 这里让 blockPos 取放置格正下方（顶面命中），prevPos 就是放置格本身。
  player.target = {
    hit: true, blockPos: [x, y - 1, z], prevPos: [x, y, z], normal: [0, 1, 0], dist: 2,
  };
  const before = editor.calls.length;
  player.placeBlock();
  return { editorCalls: editor.calls.length - before, cellId: world.getBlockId(x, y, z) };
}

// ---------------------------------------------------------------------------
// ① overlapsBlock()：纯函数语义（尺寸的唯一权威 = physics.aabb()）
// ---------------------------------------------------------------------------

test('physics.overlapsBlock：真实 AABB 相交为 true，相切/邻居为 false', () => {
  const { player } = makeFixture();
  const ph = player.physics;
  ph.pos = { x: 8.5, y: 1, z: 8.5 };   // 脚底中心，AABB = [8.2,8.8]×[1,2.8]×[8.2,8.8]
  // 相交：AABB 正穿越的 4 格
  assertTrue(ph.overlapsBlock(8, 1, 8), '脚底所在格');
  assertTrue(ph.overlapsBlock(8, 2, 8), '上半身所在格');
  // 相切不算（严格不等式）：AABB 的 2.8 顶面落在 y=3 格的底面之下，格 3 的 y 区间 [3,4]
  assertFalse(ph.overlapsBlock(8, 3, 8), '头顶上方一格不重叠');
  // 竖直：脚底 y=1 的盒面正好是格 y=0 的顶面 → 相切，不算
  assertFalse(ph.overlapsBlock(8, 0, 8), '脚下方一格不重叠');
  // 水平：AABB 的 8.8 侧面没跨到 x=9 → 格 9 不重叠
  assertFalse(ph.overlapsBlock(9, 1, 8), 'x 侧邻格不重叠');
  assertFalse(ph.overlapsBlock(8, 1, 9), 'z 侧邻格不重叠');
  player.dispose();
});

test('physics.overlapsBlock：水平偏心时 AABB 跨两列（旧格近似的漏判来源）', () => {
  const { player } = makeFixture();
  const ph = player.physics;
  ph.pos = { x: 8.9, y: 1, z: 8.9 };   // AABB = [8.6,9.2]×[1,2.8]×[8.6,9.2] → 跨 8/9 两列
  // 实测的 6 格「旧守卫放行但真实相交」
  for (const [x, y, z] of [[9, 1, 8], [9, 2, 8], [8, 1, 9], [8, 2, 9], [9, 1, 9], [9, 2, 9]]) {
    assertTrue(ph.overlapsBlock(x, y, z), `偏心 0.4：(${x},${y},${z}) 与玩家 AABB 相交`);
  }
  // 反向：真外边仍不重叠（守卫不能过宽）
  assertFalse(ph.overlapsBlock(10, 1, 8), '东侧第二格不重叠');
  assertFalse(ph.overlapsBlock(9, 3, 8), '头顶上方的跨列格不重叠');
  player.dispose();
});

test('physics.overlapsBlock：贴面切线不误杀（p.x = 8.7 时 AABB 右边界正好落在 x=9 格面上）', () => {
  const { player } = makeFixture();
  const ph = player.physics;
  ph.pos = { x: 8.7, y: 1, z: 8.5 };   // AABB = [8.4,9.0] → 与格 9 只是相切
  assertFalse(ph.overlapsBlock(9, 1, 8), '相切不算重叠（严格不等式）');
  assertTrue(ph.overlapsBlock(8, 1, 8), '所在的格仍算重叠');
  player.dispose();
});

// ---------------------------------------------------------------------------
// ② 放置守卫：真实 AABB 拒绝（核心回归）
// ---------------------------------------------------------------------------

test('放置守卫：水平偏心时跨列格一律拒放（旧格近似曾放行 → 玩家穿模）', () => {
  const { player, editor, world } = makeFixture();
  selectItem(player, 'stone');
  player.physics.pos = { x: 8.9, y: 1, z: 8.9 };
  for (const [x, y, z] of [[9, 1, 8], [9, 2, 8], [8, 1, 9], [8, 2, 9], [9, 1, 9], [9, 2, 9]]) {
    const r = placeAt(player, editor, world, [x, y, z]);
    assertEqual(r.editorCalls, 0, `(${x},${y},${z}) 与玩家 AABB 相交 → 必须拒放（编辑入口不得被调用）`);
    assertEqual(r.cellId, 0, `(${x},${y},${z}) 世界仍是空气`);
  }
  player.dispose();
});

test('放置守卫：正向对照 —— 真外边的格子必须放得下（守卫不是「拒绝一切近处」）', () => {
  const { player, editor, world, registry } = makeFixture();
  selectItem(player, 'stone');
  player.physics.pos = { x: 8.9, y: 1, z: 8.9 };
  const r = placeAt(player, editor, world, [10, 1, 8]);
  assertEqual(r.editorCalls, 1, '东侧第二格不与玩家 AABB 相交 → 必须放下（一次写入）');
  assertEqual(r.cellId, registry.idOf('stone'), '方块真的写进世界');
  player.dispose();
});

test('放置守卫：跳跃中（p.y 为小数）的头顶格必须拒放（旧守卫用 floor(p.y)+1 漏判）', () => {
  const { player, editor, world } = makeFixture();
  selectItem(player, 'stone');
  // p.y = 1.5 → 真实 AABB y ∈ [1.5, 3.3]，覆盖格 1/2/3；旧守卫只挡 1/2
  player.physics.pos = { x: 8.5, y: 1.5, z: 8.5 };
  const r = placeAt(player, editor, world, [8, 3, 8]);
  assertEqual(r.editorCalls, 0, 'y=3 在玩家上半身内 → 必须拒放（零写入）');
  player.dispose();
});

test('放置守卫：贴面切线允许放（AABB 右边界恰好落在格面上）', () => {
  const { player, editor, world, registry } = makeFixture();
  selectItem(player, 'stone');
  player.physics.pos = { x: 8.7, y: 1, z: 8.5 };
  const r = placeAt(player, editor, world, [9, 1, 8]);
  assertEqual(r.editorCalls, 1, '相切不构成重叠 → 允许放（否则贴墙放块会被误杀）');
  assertEqual(r.cellId, registry.idOf('stone'));
  player.dispose();
});

test('放置守卫：非实心方块不受限（花草放进自己所在格不产生碰撞 = vanilla isUnblocked 口径）', () => {
  const { player, editor, world, registry } = makeFixture();
  const idx = selectItem(player, 'short_grass');
  assertTrue(idx >= 0, '前提：short_grass 在背包里');
  assertEqual(registry.solidTable[registry.idOf('short_grass')], 0, '前提：short_grass 非实心');
  player.physics.pos = { x: 8.5, y: 1, z: 8.5 };
  // 玩家自己所在格（实心方块放在这里会穿模 → 被拒；花草不放 → 可以放）
  const r = placeAt(player, editor, world, [8, 1, 8]);
  assertEqual(r.editorCalls, 1, '非实心方块放进玩家 AABB 不产生碰撞 → 允许放');
  assertEqual(r.cellId, registry.idOf('short_grass'), '方块真的写进世界');
  player.dispose();
});

test('放置守卫：实心方块放进玩家所在格仍拒放（门控不是恒真）', () => {
  const { player, editor, world } = makeFixture();
  selectItem(player, 'stone');
  player.physics.pos = { x: 8.5, y: 1, z: 8.5 };
  const r = placeAt(player, editor, world, [8, 1, 8]);
  assertEqual(r.editorCalls, 0, '实心方块 + AABB 相交 → 拒放（零写入）');
  player.dispose();
});

test('放置守卫：掉落中 p.y 极接近下界时不误判边界（floor 口径与物理同源）', () => {
  const { player, editor, world, registry } = makeFixture();
  selectItem(player, 'stone');
  // p.y = 1.2009 → AABB y ∈ [1.2009, 3.0009]；physics 的 y1 = floor(y+1.8-1e-3) = 3
  player.physics.pos = { x: 8.5, y: 1.2009, z: 8.5 };
  const touched = placeAt(player, editor, world, [8, 3, 8]);
  assertEqual(touched.editorCalls, 0, 'y=3 与 AABB 正相交 → 拒放');
  // 而 y=4 完全在上方 → 允许（证明门控不是把所有上方格都拒了）
  const ok = placeAt(player, editor, world, [8, 4, 8]);
  assertEqual(ok.editorCalls, 1, 'y=4 在上方一格 → 允许放');
  assertEqual(ok.cellId, registry.idOf('stone'));
  player.dispose();
});

// ---------------------------------------------------------------------------
// ③ 就近优先（v2.25）：走真实 placeBlock()，target 用真实 DDA 算（与 update() 同款）
// ---------------------------------------------------------------------------
// ⚠️ 一条用例里要换手持物品重放时，**每次都新建 fixture**：第一次放置会改世界，同一世界里
// 第二次的主射线会命中刚放的方块（实测 A 从 13,2,8 变成 12,2,8）。

const FEET = [3.5, 1, 8.5];              // 眼睛 y=2.62 → 头格 (3,2,8)，视线朝 +X
const J = JSON.stringify;
const row = (x0, x1, y, z) => Array.from({ length: x1 - x0 + 1 }, (_, i) => [x0 + i, y, z]);
function setBlocks(world, registry, cells, name = 'stone') {
  for (const [x, y, z] of cells) world.setBlock(x, y, z, registry.idOf(name), 0);
}
/** 摆姿态（相机在眼睛处、getWorldDirection 回写 dir）、算真实 target、走 placeBlock() */
function aimAndPlace(player, editor, feet, dir) {
  player.physics.pos = { x: feet[0], y: feet[1], z: feet[2] };
  const eye = [feet[0], feet[1] + 1.62, feet[2]];
  const len = Math.hypot(...dir);
  const d = dir.map((v) => v / len);
  player.camera.position = { x: eye[0], y: eye[1], z: eye[2] };
  player.camera.getWorldDirection = (t) => { t.x = d[0]; t.y = d[1]; t.z = d[2]; return t; };
  const r = raycastVoxel(player.world, eye, d, 40);
  player.target = r.hit ? r : null;
  const before = editor.calls.length;
  player.placeBlock();
  return { placed: editor.calls.slice(before).map((c) => [c.x, c.y, c.z]), target: player.target };
}

// v2.25 追加（用户 2026-10-30，对齐 mc-lite `interact()` 的 `hits[0].distance < 15`）：命中 **< 15 格**
// 直接放命中面前（A），不看沿途候选；命中 ≥ 15 格与打空才先找沿途候选。单列夹具世界只有 16 格宽，
// 要造 ≥ 15 格的水平命中就给世界再加一列（x∈[16,31]）。
function addEastColumn(world) { world.add(new ChunkColumn(1, 0)); }

test('近处命中（<15 格）：直接放命中面前，不看沿途候选', () => {
  const { player, editor, world, registry } = makeFixture();
  selectItem(player, 'stone');
  setBlocks(world, registry, [[6, 2, 7], [14, 2, 8]]);        // 侧墙（视线擦过，是候选）+ 近处被命中的方块
  const r = aimAndPlace(player, editor, FEET, [1, 0, 0]);
  assertEqual(r.target.prevPos.join(','), '13,2,8', '前提：主射线命中，A = (13,2,8)');
  assertTrue(r.target.dist < 15, `前提：命中距离 ${r.target.dist} < 15`);
  assertEqual(J(r.placed), '[[13,2,8]]', '直接放命中面前；沿途的 (6,2,8) 虽是候选也不看');
  assertEqual(world.getBlockId(6, 2, 8), 0, '沿途候选仍是空气');
  player.dispose();
});

test('命中一律优先：远处命中（≥15 格）且沿途有候选 → 仍放命中面前（v2.54）', () => {
  const { player, editor, world, registry } = makeFixture();
  selectItem(player, 'stone');
  setBlocks(world, registry, [[9, 10, 8], [8, 30, 8]]);        // 柱子（竖直视线擦过）+ 远处被命中的方块
  const r = aimAndPlace(player, editor, [8.5, 1, 8.5], [0, 1, 0]);   // 正上方
  assertEqual(r.target.prevPos.join(','), '8,29,8', '前提：命中距离≈27.4 ≥ 15，A = (8,29,8)');
  // v2.54（用户 2026-11-05）：「准心对准可放置面 → 优先级永远最高」，不再按 15 格分流。
  // 旧期望是 [[8,10,8]]（贴柱子的最近候选）—— 那正是「瞄哪儿不放哪儿」的缺陷形态。
  assertEqual(J(r.placed), '[[8,29,8]]', '命中即放 A，不看沿途候选');
  assertEqual(world.getBlockId(8, 10, 8), 0, '沿途候选仍是空气');
  player.dispose();
});

test('近处命中且沿途无候选：放在命中面前', () => {
  const { player, editor, world, registry } = makeFixture();
  selectItem(player, 'stone');
  setBlocks(world, registry, [[14, 2, 8]]);
  const r = aimAndPlace(player, editor, FEET, [1, 0, 0]);
  assertEqual(J(r.placed), '[[13,2,8]]', '与改前一致：落在命中面前');
  player.dispose();
});

test('头格出局：背靠墙面朝外、远处命中（≥15 格）—— 花草与石头都落在命中面前', () => {
  for (const item of ['short_grass', 'stone']) {
    const { player, editor, world, registry } = makeFixture();   // 每个物品新建 fixture
    addEastColumn(world);
    selectItem(player, item);
    setBlocks(world, registry, [[2, 2, 8], [20, 2, 8]]);        // 头格 (3,2,8) 的 -X 侧是墙；命中在 16.5 格外
    const r = aimAndPlace(player, editor, FEET, [1, 0, 0]);
    assertTrue(r.target.dist >= 15, `前提：命中距离 ${r.target.dist} ≥ 15`);
    assertEqual(J(r.placed), '[[19,2,8]]', `${item}：落在命中面前`);
    assertEqual(world.getBlockId(3, 2, 8), 0, `${item}：头格仍是空气`);
    player.dispose();
  }
});

test('头格出局：打空且头格是唯一候选 → 零写入（实心 / 非实心一样）', () => {
  for (const item of ['stone', 'short_grass']) {
    const { player, editor, world, registry } = makeFixture();
    selectItem(player, item);
    setBlocks(world, registry, [[2, 2, 8]]);
    const r = aimAndPlace(player, editor, FEET, [1, 0, 0]);
    assertEqual(r.target, null, '前提：视线上没有可命中的方块（打空）');
    assertEqual(J(r.placed), '[]', `${item}：头格出局 → 零写入`);
    player.dispose();
  }
});

test('跳过被身体压住的候选（打空路径）：继续放下一个，不是整次右键作废', () => {
  const { player, editor, world, registry } = makeFixture();
  selectItem(player, 'stone');
  setBlocks(world, registry, row(1, 13, 3, 8));                  // 只有天花板，视线朝 +X 无命中
  const r = aimAndPlace(player, editor, [3.9, 1, 8.5], [1, 0, 0]);   // AABB x∈[3.6,4.2] 压到格 4
  assertEqual(r.target, null, '前提：打空');
  assertEqual(J(r.placed), '[[5,2,8]]', '旧兜底只试第一个候选 (4,2,8)，被身体守卫拒绝后整次作废');
  player.dispose();
});

test('A 路径不动：命中面前一格就是头格 —— 非实心可放、实心被拒', () => {  for (const [item, expected] of [['short_grass', '[[3,2,8]]'], ['stone', '[]']]) {
    const { player, editor, world, registry } = makeFixture();
    selectItem(player, item);
    setBlocks(world, registry, [[4, 2, 8]]);                     // 紧挨头格的墙：A = 头格 (3,2,8)
    const r = aimAndPlace(player, editor, FEET, [1, 0, 0]);
    assertEqual(r.target.prevPos.join(','), '3,2,8', '前提：A 就是头格');
    assertEqual(J(r.placed), expected, `${item}：非实心可放进头格，实心被身体守卫拒绝（v2.22 口径）`);
    player.dispose();
  }
});

test('A 路径不动：命中在 15 格之外且无候选 → 仍放在命中面前', () => {
  const { player, editor, world, registry } = makeFixture();
  selectItem(player, 'stone');
  setBlocks(world, registry, [[8, 30, 8]]);
  const r = aimAndPlace(player, editor, [8.5, 1, 8.5], [0, 1, 0]);   // 正上方
  assertEqual(r.target.prevPos.join(','), '8,29,8', '前提：命中距离≈27.4 > 15');
  assertEqual(J(r.placed), '[[8,29,8]]');
  player.dispose();
});

test('打空路径同一流程：越过头格取下一个候选（旧兜底只试第一个，会被头格吞掉）', () => {
  const { player, editor, world, registry } = makeFixture();
  selectItem(player, 'stone');
  setBlocks(world, registry, row(1, 13, 3, 8));                  // 头顶一排天花板，视线朝 +X 没有可命中的方块
  const r = aimAndPlace(player, editor, FEET, [1, 0, 0]);
  assertEqual(r.target, null, '前提：打空');
  assertEqual(J(r.placed), '[[4,2,8]]', '头格 (3,2,8) 出局，放下一格 (4,2,8)');
  player.dispose();
});

test('命中格是花草（非实心）：仍放命中面前，不把花草当候选替换掉', () => {
  const { player, editor, world, registry } = makeFixture();
  addEastColumn(world);
  selectItem(player, 'stone');
  setBlocks(world, registry, [[18, 3, 8]]);                      // 命中格上方的方块
  setBlocks(world, registry, [[18, 2, 8]], 'short_grass');       // 非实心的命中格
  const r = aimAndPlace(player, editor, [3.0, 1, 8.5], [1, 0, 0]);
  assertEqual(r.target.blockPos.join(','), '18,2,8', '前提：主射线命中花草');
  assertEqual(J(r.placed), '[[17,2,8]]', '放在命中面前');
  player.dispose();
});

test('命中恰为 15 格：一律放命中面前（v2.54 删掉了 15 格分流，阈值不再是分界）', () => {
  const { player, editor, world, registry } = makeFixture();
  addEastColumn(world);
  selectItem(player, 'stone');
  setBlocks(world, registry, [[8, 2, 7], [18, 2, 8]]);           // 侧墙（旧实现会让 (8,2,8) 成为候选）+ 恰在 15.0 格处的命中方块
  const r = aimAndPlace(player, editor, [3.0, 1, 8.5], [1, 0, 0]);
  assertEqual(r.target.dist, 15, '前提：命中距离恰为 15');
  assertEqual(J(r.placed), '[[17,2,8]]', '命中即放 A；旧实现会走候选扫描放到 (8,2,8)');
  assertEqual(world.getBlockId(8, 2, 8), 0, '沿途候选仍是空气');
  player.dispose();
});

// ---- 打空路径的就近原则（v2.54 面级筛选）----
// 用户报告的缺陷：准心没对准任何可放置面时，射线扫过多个「背对玩家视线的面」，
// 旧实现把落点给了**更远**的那个。根因是判据③的「格级否决」：近处那格同时挨着
// 背对面（合法）与正对面（如它头顶的方块）→ 整格出局 → 退到远处。

test('打空 + 近处候选格同时有正对面与背对面 → 就近放置（不退到远处的背对面）', () => {
  const { player, editor, world, registry } = makeFixture();
  selectItem(player, 'stone');
  // 眼 (0.5,2.5,8.5) 朝 (1,0.2,0)：主射线全程不命中（探针实测 hit=null）→ 走候选扫描。
  setBlocks(world, registry, [[5, 2, 8], [5, 4, 8], [12, 3, 8]]);
  const r = aimAndPlace(player, editor, [0.5, 0.88, 8.5], [1, 0.2, 0]);   // 脚底 y = 2.5 − 1.62
  assertEqual(r.target, null, '前提：打空（否则测的是 A 路径）');
  assertEqual(J(r.placed), '[[5,3,8]]', '就近：贴背对面 (5,2,8)；旧实现落到 7 格外的 (12,4,8)');
  assertEqual(world.getBlockId(12, 4, 8), 0, '远处的背对面不放');
  player.dispose();
});

test('特殊物品（巢穴）命中时不走就近放置', () => {
  const { player, editor, world, registry } = makeFixture();
  assertTrue(selectItem(player, 'zombie_nest_alias_block') >= 0, '前提：巢穴物品在背包里');
  setBlocks(world, registry, [[6, 2, 7], [14, 2, 8]]);
  const r = aimAndPlace(player, editor, FEET, [1, 0, 0]);
  assertEqual(J(r.placed), '[]', '特殊物品走实体放置（fixture 无 nests 服务 → 不写任何方块），不得落到单格就近放置');
  player.dispose();
});
