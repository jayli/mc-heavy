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
import { test } from './runner.js';
import { assertTrue, assertFalse, assertEqual } from './assert.js';
import { Player } from '../player/player.js';
import { WorldData } from '../voxel/world-data.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';

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
