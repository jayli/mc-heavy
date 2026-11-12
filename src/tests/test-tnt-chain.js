// src/tests/test-tnt-chain.js — TNT 连锁队列与去重键生命周期（v2.97）
//
// 覆盖 v2.97 排查出的静默失效：`_ignitingTnt` 的键在「中心格不是 TNT」时**永不释放** ⇒
// ① 连锁里同一格被入队两次（首爆 5×5×5 → 中间那格引爆时又把第三格搜一遍），第二次是
//    **幽灵爆炸**（计数 +1、多一次音效/伤害/特效）；
// ② 幽灵项到期时该格已是空气 ⇒ 走 ③ 段的 `if` 外侧 ⇒ 键永久残留；
// ③ 键残留后玩家在该格重新放 TNT 引爆被 `has(key)` 静默拒绝 → **方块永远不消失**（用户报告）。
//
// ⚠️ **为什么能纯单测驱动 `Game` 的这两个方法**：`explodeTnt` / `_applyExplosion` 只碰
// `world` / `registry` / `editor` / `_ignitingTnt` / `_tntChain` / `_tntExploded` 与三个可缺省的
// 玩法服务（`minecarts` / `zombies` / `audioManager`）。用 `Object.create(Game.prototype)` 造
// 原型链正确、只注入这七个字段的壳，就能在不构造 DOM/WebGPU 的前提下跑真代码路径 ——
// `new Game()` 需要 canvas/WebGPU，在浏览器内单测里只能走页面，抓不到「键泄漏」这种数据层缺陷。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { Game } from '../core/game.js';
import { WorldEditor } from '../core/world-editor.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';

function makeFixture({ readyColumns = [[0, 0]] } = {}) {
  const registry = createRegistry();
  for (const def of BLOCKS) registry.register(def.name, def);
  registry.freeze();
  const world = new WorldData(registry);
  for (const [cx, cz] of readyColumns) {
    const column = new ChunkColumn(cx, cz);
    column.state = 'ready';
    world.add(column);
  }
  const editor = new WorldEditor({ world, scheduler: { remeshSections() {}, enqueueLight() {} } });
  const game = Object.create(Game.prototype);
  game.world = world;
  game.registry = registry;
  game.editor = editor;
  game.canTntDestroyBlocks = false;
  game._ignitingTnt = new Set();
  game._tntChain = [];
  game._tntScheduled = new Set();
  game._tntExploded = 0;
  // 玩法服务：`_damageEntitiesInRadius` 直接调 `zombies.activeEntities()`（非可选链），故给空 stub；
  // 伤害/矿车/音效各有既有 spec 覆盖，本文件只验链条与去重键生命周期。
  game.zombies = { activeEntities: () => [] };
  game.minecarts = null;
  game.audioManager = null;
  game.explosionSprite = { spawn() {} };
  game.explosionRenderer = { burst() {} };
  return { game, world, registry, editor };
}

/**
 * 把队列里所有待引爆项一次性到期执行。
 * ⚠️ **必须走生产的 `_updateTntChain`**（不是自己 splice + explodeTnt）：后者会跳过
 * `_tntScheduled.delete(...)` 这一步，让测试里的排期集合与生产行为分叉 —— 那样的测试
 * 在「排期键泄漏」类缺陷上无判别力（实测：自己 splice 时「同格重复入队」用例变假绿）。
 */
function flushChain(game) {
  if (game._tntChain.length === 0) return 0;
  const n = game._tntChain.length;
  const far = Math.max(...game._tntChain.map((t) => t.dueAt)) + 1;
  game._updateTntChain(far);
  return n;
}

const key = (c) => `${c[0]},${c[1]},${c[2]}`;

test('2×2×2 TNT 团组：炸完每格都消失，且不留任何去重键', () => {
  const { game, world, registry } = makeFixture();
  const tnt = registry.idOf('tnt');
  const cells = [];
  for (let dx = 0; dx < 2; dx++) {
    for (let dy = 0; dy < 2; dy++) {
      for (let dz = 0; dz < 2; dz++) {
        cells.push([4 + dx, 4 + dy, 4 + dz]);
        world.setBlock(4 + dx, 4 + dy, 4 + dz, tnt);
      }
    }
  }
  game.explodeTnt(4, 4, 4);
  flushChain(game);
  flushChain(game);   // 幽灵项可能引发新一轮入队 —— 再推一轮，确保收敛
  for (const [x, y, z] of cells) {
    assertEqual(world.getBlockId(x, y, z), 0, `TNT 格 ${x},${y},${z} 必须被移除`);
  }
  assertEqual(game._ignitingTnt.size, 0, '炸完不得残留去重键（否则该格之后再也炸不掉）');
});

test('连锁里同一格只被入队一次（首爆 5×5×5 已覆盖后不再重复）', () => {
  const { game, world, registry } = makeFixture();
  const tnt = registry.idOf('tnt');
  // 一排三格：首爆 (4,4,4) 时 5×5×5 内同时看到 (5,4,4) 与 (6,4,4)；
  // (5,4,4) 到期引爆时又会把仍是 TNT 的 (6,4,4) 搜一遍 → 重复入队（幽灵爆炸的来源）。
  for (const x of [4, 5, 6]) world.setBlock(x, 4, 4, tnt);
  game.explodeTnt(4, 4, 4);
  const firstBatch = game._tntChain.map((t) => key([t.x, t.y, t.z]));
  assertEqual(firstBatch.length, 2, '首爆入队两格');
  const before = new Set(firstBatch);
  assertTrue(before.has(key([6, 4, 4])), '第三格已在首爆那一批里');

  // **链式重复的直接判据**（不是只看 exploded 计数 —— 计数在「重复项逐项引爆」时
  // 可能因为中心格已空而看起来正确）：把队列逐项手动到期，断言**任何一格**都不会
  // 在队列里出现两次。
  const seen = [];
  let guard = 0;
  while (game._tntChain.length && guard++ < 10) {
    for (const t of game._tntChain) seen.push(key([t.x, t.y, t.z]));
    // 走生产的 `_updateTntChain`（含排期集合释放），不自己 splice
    const far = Math.max(...game._tntChain.map((t) => t.dueAt)) + 1;
    game._updateTntChain(far);
  }
  const dup = seen.filter((k, i) => seen.indexOf(k) !== i);
  assertEqual(dup.join(' / '), '', '连锁项不得重复入队');
  assertEqual(seen.length, 2, '总共只应入队两格（每格一次）');

  // 三格 TNT = 三次真实爆炸
  assertEqual(game._tntExploded, 3, '连锁后总数应为 3（首爆 1 + 连锁 2）');
  for (const x of [4, 5, 6]) assertEqual(world.getBlockId(x, 4, 4), 0, `${x} 必须消失`);
  assertEqual(game._ignitingTnt.size, 0, '不得残留去重键');
});

test('引爆后在同格重新放 TNT：仍能引爆（键随成功引爆释放）', () => {
  const { game, world, registry } = makeFixture();
  const tnt = registry.idOf('tnt');
  world.setBlock(4, 4, 4, tnt);
  assertTrue(game.explodeTnt(4, 4, 4), '首次引爆成功');
  assertEqual(game._ignitingTnt.size, 0, '成功引爆后键必须释放（该格已非 TNT）');
  world.setBlock(4, 4, 4, tnt);
  assertTrue(game.explodeTnt(4, 4, 4), '同格重新放的 TNT 必须仍能引爆');
  assertEqual(world.getBlockId(4, 4, 4), 0);
});

test('对空气格（连锁幽灵 / 枪击落空）引爆：不残留去重键', () => {
  const { game, world } = makeFixture();
  game.explodeTnt(4, 4, 4);   // 该格是空气
  assertEqual(game._ignitingTnt.size, 0, '中心格非 TNT 时键也必须释放');
  assertEqual(world.getBlockId(4, 4, 4), 0);
});

test('column 未加载的 TNT 格：引爆不得留下永久脏键（该格重载后仍能炸）', () => {
  const { game, registry } = makeFixture();
  const tnt = registry.idOf('tnt');
  // 按 column 坐标不一定可写：此处直接覆盖到「写不进世界」的形态 ——
  // column (2,2) 不存在时 `editor.setBlock` 返回 `column-missing`，方块实际还在。
  // **键必须依旧释放**（无条件释放），否则该格重载后永远炸不掉。
  game.explodeTnt(40, 4, 40);
  assertEqual(game._ignitingTnt.size, 0, '写不进世界的引爆也不得残留去重键');
  // 对照：column 就绪后同一坐标必须能正常引爆（证明判据不是恒真）
  const col = new ChunkColumn(2, 2);
  col.state = 'ready';
  game.world.add(col);
  game.world.setBlock(40, 4, 40, tnt);
  assertTrue(game.explodeTnt(40, 4, 40), 'column 就绪后必须能引爆');
  assertEqual(game.world.getBlockId(40, 4, 40), 0);
  assertEqual(game._ignitingTnt.size, 0);
});

test('玩家在连锁延迟窗口内抢先引爆同一格：不得再触发一次空爆炸', () => {
  const { game, world, registry } = makeFixture();
  const tnt = registry.idOf('tnt');
  for (const x of [4, 5, 6]) world.setBlock(x, 4, 4, tnt);
  game.explodeTnt(4, 4, 4);
  assertEqual(game._tntChain.length, 2, '首爆入队 B、C');
  // 玩家在 500~1100ms 窗口内自己再点 C（枪击/左键都能做到）
  assertTrue(game.explodeTnt(6, 4, 4), '玩家可以直接引爆已在排期的格');
  // C 的排期项必须被撤掉：否则它到期时中心格已是空气 → 一次空爆炸
  // （方块一格不少，但多一发音效 / 伤害 / 特效 —— 计数就能看到）
  const stillQueued = game._tntChain.filter((t) => t.x === 6 && t.y === 4 && t.z === 4).length;
  assertEqual(stillQueued, 0, '已引爆格的排期项必须被撤掉');
  assertEqual(game._tntScheduled.has(key([6, 4, 4])), false, '排期集合也必须同步释放');
  flushChain(game);
  // 三格 TNT = 三次爆炸，不能是 4 次
  assertEqual(game._tntExploded, 3, '总计数必须是 3（多出即空爆炸）');
  for (const x of [4, 5, 6]) assertEqual(world.getBlockId(x, 4, 4), 0, `${x} 必须消失`);
  assertEqual(game._ignitingTnt.size, 0);
  assertEqual(game._tntScheduled.size, 0, '排期集合不得残留');
});

test('破坏开关开启时，待爆的连锁 TNT 仍不被自身的破坏事务删除', () => {
  const { game, world, registry } = makeFixture();
  const tnt = registry.idOf('tnt');
  const stone = registry.idOf('stone');
  for (const x of [4, 5, 6]) world.setBlock(x, 4, 4, tnt);
  world.setBlock(5, 3, 4, stone);   // 3×3×3 内的普通方块（对照：它必须被炸掉）
  game.canTntDestroyBlocks = true;
  game.explodeTnt(4, 4, 4);
  assertEqual(world.getBlockId(5, 4, 4), tnt, '待爆的连锁 TNT 不得被首爆的破坏事务删掉');
  assertEqual(world.getBlockId(5, 3, 4), 0, '普通方块必须被破坏（证明开关真的生效）');
  flushChain(game);
  for (const x of [4, 5, 6]) assertEqual(world.getBlockId(x, 4, 4), 0, `${x} 必须消失`);
  assertEqual(game._ignitingTnt.size, 0);
});
