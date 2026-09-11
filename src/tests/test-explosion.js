// src/tests/test-explosion.js — M8：爆炸计算（Tier 1，同构纯函数）
// 覆盖规格 §2.1/§2.2 的「改坏了肉眼玩不出来」的部分：破坏范围过滤 indestructible、
// 连锁延迟的确定性（红线 2 —— 用 Math.random 会让同一存档两次引爆时序不同）。
// ⚠️ 断言必须成对：只写 `delayMs >= 500` 会让「延迟恒返回 500」全绿（testing-policy §2.7）。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';
import {
  computeExplosion, EXPLOSION_DAMAGE_RADIUS, EXPLOSION_DAMAGE,
} from '../voxel/explosion.js';

function makeRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}

/**
 * 最小世界 fixture（**新建** —— test-zombie-nests.js 里只有 makeRegistry/makeNestFixture）。
 * 预加载 column (0,0)：覆盖 x/z ∈ [0,15]，够放下 5×5×5 的全部采样格。
 */
function makeWorldFixture() {
  const registry = makeRegistry();
  const world = new WorldData(registry);
  world.add(new ChunkColumn(0, 0));
  return { world, registry };
}

test('computeExplosion：3×3×3 破坏 + indestructible 过滤', () => {
  const { world, registry } = makeWorldFixture();
  const stoneId = registry.idOf('stone');
  world.setBlock(5, 1, 5, stoneId);
  world.setBlock(6, 1, 5, registry.idOf('bedrock'));   // 3×3×3 内的不可破坏格
  const r = computeExplosion({ world, registry, center: [5, 1, 5] });
  assertEqual(r.center[0], 5);
  // 3×3×3 = 27 格（空气格也进列表，与 mc-lite blocksToDestroy 同口径），bedrock 那格被过滤 → 26
  assertEqual(r.destroy.length, 26);
  assertEqual(r.destroy.some((c) => c.x === 6 && c.y === 1 && c.z === 5), false, 'bedrock 保留');
  // 中心格自身在列表内（由引爆路径移除自身，见 game.explodeTnt）
  assertTrue(r.destroy.some((c) => c.x === 5 && c.y === 1 && c.z === 5), '中心格在列表内');
  // stone 那格也在列表内（可破坏）
  assertTrue(r.destroy.some((c) => c.x === 5 && c.y === 1 && c.z === 5));
});

test('computeExplosion：空气格也进 destroy（与 mc-lite blocksToDestroy 同口径）', () => {
  const { world, registry } = makeWorldFixture();
  const r = computeExplosion({ world, registry, center: [5, 1, 5] });
  // 全空气的 3×3×3 → 27 格全部进列表（下游 setBlocks 会判 no-change 跳过，不需要在此过滤）
  assertEqual(r.destroy.length, 27);
});

test('computeExplosion：5×5×5 连锁 + 确定性延迟（同输入两次一致）', () => {
  const { world, registry } = makeWorldFixture();
  const tntId = registry.idOf('tnt');
  world.setBlock(5, 1, 5, tntId);   // 中心
  world.setBlock(7, 1, 5, tntId);   // dx=2 → 在 5×5×5 内
  world.setBlock(9, 1, 5, tntId);   // dx=4 → 超出
  const a = computeExplosion({ world, registry, center: [5, 1, 5] });
  assertEqual(a.chain.length, 1, '只有 dx=2 那格在范围内');
  assertEqual(a.chain[0].x, 7);
  assertTrue(a.chain[0].delayMs >= 500 && a.chain[0].delayMs <= 1100);
  // **红线 2**：同输入两次结果完全一致（不是 Math.random）
  const b = computeExplosion({ world, registry, center: [5, 1, 5] });
  assertEqual(b.chain[0].delayMs, a.chain[0].delayMs, '同输入两次一致');
  // 不同中心 → 范围外的 tnt 不进 chain（中心 x=20 时三格全部超出）
  const far = computeExplosion({ world, registry, center: [20, 1, 5] });
  assertEqual(far.chain.length, 0);
});

test('computeExplosion：延迟随中心变化（散列真的在生效，不是恒返回同一值）', () => {
  const { world, registry } = makeWorldFixture();
  const tntId = registry.idOf('tnt');
  world.setBlock(7, 1, 5, tntId);
  // 同一格 tnt，从两个不同中心看到（dx=2 vs dx=1）→ 偏移参与散列 → 延迟必须不同
  const from5 = computeExplosion({ world, registry, center: [5, 1, 5] });
  const from6 = computeExplosion({ world, registry, center: [6, 1, 5] });
  assertEqual(from5.chain.length, 1);
  assertEqual(from6.chain.length, 1);
  assertEqual(from5.chain[0].x, from6.chain[0].x, '同一格 tnt');
  assertTrue(from5.chain[0].delayMs !== from6.chain[0].delayMs, '不同中心延迟不同');
});

test('爆炸伤害常量是单一权威（game 与测试共用，不得各写字面量）', () => {
  assertEqual(EXPLOSION_DAMAGE_RADIUS, 4);   // mc-lite PlayerInteraction.js:629-630
  assertEqual(EXPLOSION_DAMAGE, 50);
});
