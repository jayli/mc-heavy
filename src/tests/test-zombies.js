// src/tests/test-zombies.js — M6：丧尸纯逻辑 + 受控渲染（M6 规格 §1/§3）
//
// 覆盖：合法出生校验（脚/头 air + 脚下 solid + column 已加载）、默认 20 上限、精确伤害与死亡回收、
// 六部件固定容量 InstancedMesh、slot 对称归还、200ms 红闪到期复位、步态速度 10 / 摆幅 π/8。
//
// 派生量一律从**冻结常量**算出而非硬编码字面量（docs/testing-policy.md §2.5：硬编码被测代码写入
// 的那个值会让「常量改错但关系式仍成立」的缺陷恒过）。舍入到 1e-6 抵消 IEEE754 累加噪声。
import * as THREE from 'three';
import { test } from './runner.js';
import {
  assertEqual, assertFalse, assertNull, assertTrue, assertDeepEqual, AssertionError,
} from './assert.js';
import { createRegistry } from '../voxel/block-registry.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';
import { WORLD_MIN_Y } from '../voxel/constants.js';
import { EntityManager } from '../entities/entity-manager.js';
import {
  ZOMBIE, ZOMBIE_FLASH_MS, ZOMBIE_WALK_SPEED, ZOMBIE_SWING, ZOMBIE_MOVING_EPSILON,
  ZOMBIE_SEPARATION, ZOMBIE_ARM_SWING, ZOMBIE_HEAD_SWAY,
  ZOMBIE_MAX_STEP, ZOMBIE_STEERING,
} from '../entities/zombies/zombie-config.js';
import {
  ZombieService, zombieDefinition, separationForce, computeAiUpdates,
} from '../entities/zombies/zombie-system.js';
import {
  zombieCollidesAt, zombieStepUpY, steerIntent,
} from '../entities/zombies/zombie-navigation.js';
import {
  ZombieRenderer, ZOMBIE_PARTS, ZOMBIE_PART_DEFS, HEAD_FRONT_VERTICES,
} from '../render/zombie-renderer.js';
import { ZOMBIE_MODEL_DEFS, ZOMBIE_SKIN_UV, SKIN_SIZE } from '../render/zombie-model.js';

/** 舍入到 1e-6：抵消 IEEE754 累加噪声，让派生量可与字面量比对（testing-policy §2.5） */
function round6(v) { return Math.round(v * 1e6) / 1e6; }

/** 浮点比较（步态相位等经 sin 后无法精确等于字面量） */
function assertClose(actual, expected, tolerance, message = '') {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new AssertionError(
      `${message ? message + ': ' : ''}Expected ~${expected} (±${tolerance}), got ${actual}`);
  }
}

/**
 * 小型 loaded-world fixture（M6 plan Task 1 Step 1）。
 *
 * **不用绝对世界原点或城市出生状态** —— 测试世界是自建的 4×1 column 平地（y=0 全 stone，
 * 其上全 air），落点条件完全由 fixture 掌控，可被测试改写（`world.setBlock`）来制造
 * 「头格被占用」等非法出生场景。
 *
 * @param {{maxActive?: number, withRenderer?: boolean, skinTexture?: THREE.Texture|null}} [opts]
 *   `skinTexture`：传一个 dummy 纹理即走「全身皮肤 + 每面 UV 矩形」路径；默认 null =
 *   纯色退回路径（既有测试不受影响，向后兼容）。
 */
export function makeZombieFixture({ maxActive = ZOMBIE.maxActive, withRenderer = true, skinTexture = null } = {}) {
  const registry = createRegistry();
  registry.register('air', { solid: false, opaque: false, cullMode: 'none' });
  registry.register('stone', { solid: true, opaque: true, cullMode: 'opaque' });
  // bedrock 必须注册：`WorldData.getBlockId` 对 `y < WORLD_MIN_Y` 返 `idOf('bedrock')`。
  // 缺了它，「y ≤ WORLD_MIN_Y + column 缺失」这个能让 **column 门控成为唯一拒绝者** 的
  // 边界情形测不出来（`solidTable[undefined]` 恒 0 → 脚下门控先拒绝，column 门控不被触发）。
  registry.register('bedrock', { solid: true, opaque: true, cullMode: 'opaque' });
  registry.freeze();
  const ids = { air: registry.idOf('air'), stone: registry.idOf('stone'), bedrock: registry.idOf('bedrock') };

  const world = new WorldData(registry);
  // cx 0..3 / cz 0 已加载（spawn 覆盖 x ∈ [0.5, 40.5] → cx 0..2；多留一列余量）
  for (let cx = 0; cx <= 3; cx++) {
    const column = new ChunkColumn(cx, 0);
    for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) column.set(lx, 0, lz, ids.stone);
    world.add(column);
  }

  const entities = new EntityManager();
  entities.registerType('zombie', zombieDefinition);

  const scene = new THREE.Scene();
  const renderer = withRenderer ? new ZombieRenderer({ scene, maxActive: ZOMBIE.maxActive, skinTexture }) : null;

  // 渲染 slot 由 service 的生命周期钩子驱动（service 是同构层，不得 import render —— 注入解耦，
  // 与 EntityManager.onDespawn 同一手法）。**slot 单一权威在 service**（它管 20 上限），
  // renderer 只接收 service 分配的 slot，不自建第二份 slot 池（红线 1）。
  const zombies = new ZombieService({
    entities, world, maxActive,
    onSpawn: renderer ? (id, slot) => renderer.acquireSlot(id, slot) : null,
    onDespawn: renderer ? (id) => renderer.releaseSlot(id) : null,
    // v2.81：击退的渲染层补间走同一条注入路径（与 Game 装配逐字同形）
    onKnockback: renderer ? (id, dx, dz) => renderer.noteKnockback(id, dx, dz) : null,
  });

  return { registry, ids, world, entities, zombies, renderer, scene };
}

// ---------- 冻结数据 ----------

test('ZOMBIE config: 冻结数值对齐 mc-lite（上限/生命/AABB/速度/范围/周期）', () => {
  assertEqual(ZOMBIE.maxActive, 20);
  assertEqual(ZOMBIE.health, 100);
  assertEqual(ZOMBIE.width, 0.6);
  assertEqual(ZOMBIE.height, 1.8);
  assertEqual(ZOMBIE.speed, 1.2);
  assertEqual(ZOMBIE.perceptionRange, 80);
  assertEqual(ZOMBIE.aiSleepDistance, 60);
  assertEqual(ZOMBIE.aiPeriod, 0.05);
  assertEqual(ZOMBIE_FLASH_MS, 200);
  assertEqual(ZOMBIE_WALK_SPEED, 10);
  assertEqual(ZOMBIE_SWING, Math.PI / 8);
  assertTrue(Object.isFrozen(ZOMBIE));
});

test('ZOMBIE_SEPARATION: 排斥参数对齐 mc-lite（最小距离照搬 / 排斥强度换算单位）', () => {
  // 逐项钉住 mc-lite `EnemyWorker.js:133-134` 的两个常量（`calculateSeparationForce` 内部）。
  // 这些是**玩法数据**（Tier 2 口径：改错了立刻可见 —— 丧尸挤成一坨或互相弹开 —— 但静默
  // 改错没人会发现），故用门禁断言而非目视。
  //
  // ⚠️ `minDistance: 1.2` 是 mc-lite 注释里的「略大于丧尸宽度」，**不是** `ZOMBIE.width`（0.6）
  // 的两倍 —— mc-lite 里它是独立硬编码常量。故断言写成独立字面量：若派生成 `ZOMBIE.width * 2`，
  // 改 AABB 宽度会连带改排斥半径，那不是同一个事实（红线 1 精神）。
  assertEqual(ZOMBIE_SEPARATION.minDistance, 1.2);

  // ⚠️ **repulsionStrength 是有意换算值，不是 mc-lite 原值**：mc-lite 是 `0.05`（格/帧单位，
  // 它的 `predictNextPosition` 不乘 dt）。mc-heavy 物理层乘 dt → velocity 是格/秒，故须 ×60
  // （与 `ZOMBIE.speed` 的 `0.02 格/帧 × 60 = 1.2` 同一口径）。
  // 断言钉住**换算关系**而非孤立数值 —— 只写 `assertEqual(3.0)` 会让「忘了换算」与「换算值改了」
  // 两种情况都看不出区别。钉住 `=== 0.05 × 60` 才能证明换算关系成立。
  const MC_LITE_REPULSION = 0.05; // mc-lite 原值（格/帧）
  assertEqual(ZOMBIE_SEPARATION.repulsionStrength, MC_LITE_REPULSION * 60);
  // 前提断言：换算值确实远大于 mc-lite 原值（否则这条换算关系形同虚设）
  assertTrue(ZOMBIE_SEPARATION.repulsionStrength > MC_LITE_REPULSION,
    '换算后的排斥强度须大于 mc-lite 原值（格/秒 vs 格/帧）');
  assertTrue(Object.isFrozen(ZOMBIE_SEPARATION));
});

// ---------- 实体间排斥（mc-lite EnemyWorker.js:131-155 移植） ----------

/**
 * 排斥力纯函数测试。派生量一律从**冻结常量**算出而非硬编码字面量（testing-policy §2.5）——
 * 硬编码被测代码写入的那个值会让「常量改错但关系式仍成立」的缺陷恒过。
 */
test('separationForce: 两只水平重叠 → 互相推开且方向相反', () => {
  // A 在 (0,0)，B 在 (0.5,0) → 水平距离 0.5 < minDistance 1.2 → 排斥生效
  // dx = enemy.x - other.x：A 相对 B 是 -0.5 → forceX 为负（向 -X 推开）
  const self = { id: 'a', position: [0, 1, 0] };
  const others = [{ id: 'a', position: [0, 1, 0] }, { id: 'b', position: [0.5, 1, 0] }];
  const f = separationForce(self, others);
  assertTrue(f.x < 0, `A 须向 -X 推开（远离 B），got ${f.x}`);
  assertTrue(Math.abs(f.z) < 1e-9, '纯水平排列不该有 Z 分量');
  // 对称性：B 的排斥力须与 A 大小相等、方向相反
  const fb = separationForce({ id: 'b', position: [0.5, 1, 0] }, others);
  assertClose(fb.x, -f.x, 1e-9, '两两排斥须对称（牛顿第三定律）');
});

test('separationForce: 距离恰在 minDistance 边界 → 不排斥（< 而非 <=）', () => {
  // mc-lite 判定 `distance < minDistance` —— 恰等于半径时**不**排斥。
  // 边界方向反了（写成 <=）会让「刚好分开的两只」继续被推开 → 永远散不到 1.2 格。
  //
  // ⚠️ **输入必须用字面量 1.2，不能从 `ZOMBIE_SEPARATION.minDistance` 派生** ——
  // 派生会让「改常量」与「改输入」同时发生 → 断言恒真（testing-policy §2.5 的恒真陷阱 ⑦：
  // `micro = EPSILON / 2` 同款）。实测踩过：注入「`<` 改 `<=`」后本测试仍全绿，
  // 因为输入随常量变化、且 `distance == minDistance` 时公式 `(minDistance-distance)` 本就为 0。
  // 故用字面量 + 前提断言钉住常量确实是 1.2。
  const self = { id: 'a', position: [0, 1, 0] };
  const others = [self, { id: 'b', position: [1.2, 1, 0] }]; // 字面量，不派生
  const f = separationForce(self, others);
  assertClose(f.x, 0, 1e-9, '恰在半径边界须零排斥');
  // 前提断言：常量确实是 1.2（否则上面的字面量输入就不在边界上，这条覆盖形同虚设）
  assertEqual(ZOMBIE_SEPARATION.minDistance, 1.2, '前提：半径须为 1.2');
});

test('separationForce: 略小于 minDistance → 有排斥（钉住边界是严格小于）', () => {
  // 上一条测「恰等于不排斥」，本条测「略小于有排斥」—— 两条合起来才能钉住 `<` 的边界语义。
  // 只有上一条的话，注入「`<` 改 `<=`」测不出来（见上方踩坑记录）。
  // 距离取 1.19（略小于 1.2）：期望 force = (1.2-1.19)/1.2 × 0.05，方向 -X。
  const { minDistance, repulsionStrength } = ZOMBIE_SEPARATION;
  const self = { id: 'a', position: [0, 1, 0] };
  const others = [self, { id: 'b', position: [1.19, 1, 0] }];
  const f = separationForce(self, others);
  assertClose(f.x, -(minDistance - 1.19) / minDistance * repulsionStrength, 1e-12);
  // 前提：1.19 确实落在「略小于半径」区间（否则这条也是恒真）
  assertTrue(1.19 < ZOMBIE_SEPARATION.minDistance, '前提：1.19 须小于半径');
});

test('separationForce: 距离越近排斥力越大（线性衰减）', () => {
  // force = (minDistance - distance) / minDistance × strength → 线性衰减。
  // 取三个距离，断言严格单调；并逐项比对公式（从常量派生，不硬编码结果）。
  const { minDistance, repulsionStrength } = ZOMBIE_SEPARATION;
  const forceAt = (d) => separationForce(
    { id: 'a', position: [0, 1, 0] },
    [{ id: 'a', position: [0, 1, 0] }, { id: 'b', position: [d, 1, 0] }],
  ).x;
  const d1 = 0.2, d2 = 0.6, d3 = 1.0;
  assertTrue(Math.abs(forceAt(d1)) > Math.abs(forceAt(d2)), '越近排斥越大（0.2 > 0.6）');
  assertTrue(Math.abs(forceAt(d2)) > Math.abs(forceAt(d3)), '越近排斥越大（0.6 > 1.0）');
  // 逐项比对公式：d1 的期望 = (1.2-0.2)/1.2 × 0.05，方向 -X（self 在 other 的左侧）
  assertClose(forceAt(d1), -(minDistance - d1) / minDistance * repulsionStrength, 1e-12);
});

test('separationForce: 完全重叠（distance ≈ 0）→ 用 id 派生方向推开（tie-break）', () => {
  // mc-lite 判定 `distance > 0.001` → 完全重叠时**跳过**不推开。这是 mc-lite 的既有行为，
  // 但**在 mc-heavy 里会造成永久死锁**（实测踩坑）：两只同位置丧尸的追逐速度完全相同 →
  // 永远同步移动、永不分开（实测 20 只强制同点生成后 3 秒仍 min=0、190 对全重叠）。
  // mc-lite 不会死锁是因为它有 S 路线随机偏移角（`EnemyWorker.js:186-207` `targetOffsetAngle`，
  // 2% 概率每帧）让丧尸不会精确同点 —— 而 mc-heavy 的 AI 是纯直线追逐，没移植那个机制。
  //
  // 故补 tie-break：完全重叠时用 **id 派生的确定性角度**推开。用 id 派生而非 `Math.random()`
  // 的理由：① 可测（确定性，断言能钉住具体方向）；② 无帧间抖动（random 会让丧尸每帧换方向
  // 抖个不停）。
  const self = { id: 'z0', position: [5, 1, 5] };
  const others = [self, { id: 'z1', position: [5, 1, 5] }];
  const f = separationForce(self, others);
  assertTrue(Number.isFinite(f.x) && Number.isFinite(f.z), '排斥力不得为 NaN');
  // 完全重叠时排斥力必须**非零**（否则死锁），且长度 = repulsionStrength
  const len = Math.hypot(f.x, f.z);
  assertClose(len, ZOMBIE_SEPARATION.repulsionStrength, 1e-9, '完全重叠须有非零排斥力（解死锁）');
});

test('separationForce: 完全重叠的两只 → 方向相反（互相推开而非同向）', () => {
  // 死锁的本质是「两只速度完全相同」→ tie-break 必须让同位置的两只朝**相反**方向走。
  // 若两只派生出同一角度，它们仍会同步移动 → 死锁没解开。
  const a = { id: 'z0', position: [5, 1, 5] };
  const b = { id: 'z1', position: [5, 1, 5] };
  const fa = separationForce(a, [a, b]);
  const fb = separationForce(b, [a, b]);
  assertClose(fa.x, -fb.x, 1e-9, '完全重叠的两只须朝相反方向推开（X）');
  assertClose(fa.z, -fb.z, 1e-9, '完全重叠的两只须朝相反方向推开（Z）');
});

test('separationForce: tie-break 方向由 id 确定性派生（同 id 同方向）', () => {
  // 钉住「确定性」：同一 id 多次调用须得到相同方向 —— 若用 Math.random() 会每帧抖。
  const a = { id: 'z0', position: [5, 1, 5] };
  const b = { id: 'z1', position: [5, 1, 5] };
  const f1 = separationForce(a, [a, b]);
  const f2 = separationForce(a, [a, b]);
  assertClose(f1.x, f2.x, 1e-12, '同 id 多次调用须同方向（确定性）');
  assertClose(f1.z, f2.z, 1e-12, '同 id 多次调用须同方向（确定性）');
  // 不同 id 须有不同方向（否则所有丧尸朝同一方向走 → 仍重叠）
  const f3 = separationForce({ id: 'z2', position: [5, 1, 5] }, [a, b]);
  assertTrue(Math.abs(f1.x - f3.x) > 1e-9 || Math.abs(f1.z - f3.z) > 1e-9,
    '不同 id 须派生不同方向（否则仍会重叠）');
});

test('separationForce: 不重叠（距离 > minDistance）→ 零排斥', () => {
  const self = { id: 'a', position: [0, 1, 0] };
  const others = [self, { id: 'b', position: [5, 1, 5] }];
  const f = separationForce(self, others);
  assertClose(f.x, 0, 1e-9);
  assertClose(f.z, 0, 1e-9);
});

test('separationForce: 多个邻居的排斥力累加', () => {
  // 三个邻居分别在不同方向 → 合力是各分量之和（mc-lite 的 `+=` 累加语义）。
  const self = { id: 'a', position: [0, 1, 0] };
  const others = [
    self,
    { id: 'b', position: [0.5, 1, 0] },   // +X 方向 → A 向 -X 推
    { id: 'c', position: [-0.5, 1, 0] },  // -X 方向 → A 向 +X 推
  ];
  const f = separationForce(self, others);
  // 对称排列 → X 分量互相抵消
  assertClose(f.x, 0, 1e-9, '对称排列的 X 排斥须抵消');
  // 再加一个 Z 方向邻居 → 只产生 Z 分量
  const others2 = [...others, { id: 'd', position: [0, 1, 0.5] }];
  const f2 = separationForce(self, others2);
  assertTrue(f2.z < 0, 'Z 方向邻居须产生 -Z 排斥');
});

test('separationForce: 排斥力叠加进 AI 速度（worker ai 分支的口径）', () => {
  // 钉住 mc-lite `EnemyWorker.js:218-220` 的「最终期望速度 = AI 速度 + 排斥力」。
  // **静止丧尸也会被推开**：排斥力是无条件叠加的（不在「感知范围内」分支里），
  // 故 aiVelocity=0 时 velocity 仍非零。这正是「已经挤在一起的静止丧尸会散开」的来源。
  const zombies = [
    { id: 'z0', generation: 1, position: [0, 1, 0], yaw: 0, mode: 'idle' },
    { id: 'z1', generation: 1, position: [0.5, 1, 0], yaw: 0, mode: 'idle' },
  ];
  // 玩家极远 → 感知门外（perceptionRange 80）→ AI 速度为 0，只剩排斥力
  const reply = computeAiUpdates({ playerPosition: [500, 1, 500], dt: 0.05, zombies });
  const u0 = reply.updates.find((u) => u.id === 'z0');
  const u1 = reply.updates.find((u) => u.id === 'z1');
  assertTrue(Math.abs(u0.vx) > 0, '感知门外 + 重叠 → 排斥力仍让 vx 非零（静止丧尸也会被推开）');
  assertTrue(u0.vx < 0, 'z0 须向 -X 推开');
  assertTrue(u1.vx > 0, 'z1 须向 +X 推开');
  assertEqual(u0.mode, 'idle', '感知门外仍须 idle（排斥力不改变 mode）');
});

test('separationForce: 排斥力不改变追逐语义（感知门内仍朝玩家）', () => {
  // 排斥力叠加在追逐速度之上 → 丧尸仍朝玩家走，只是会绕开同伴。
  // 断言：单只丧尸（无同伴）时 vx/vz 就是纯追逐方向（排斥力为 0，不影响既有 M6 语义）。
  const zombies = [{ id: 'z0', generation: 1, position: [0, 1, 0], yaw: 0, mode: 'idle' }];
  const reply = computeAiUpdates({ playerPosition: [10, 1, 0], dt: 0.05, zombies });
  const u0 = reply.updates[0];
  assertEqual(u0.mode, 'chasing');
  assertClose(u0.vx, ZOMBIE.speed, 1e-9, '单只无同伴 → vx 恒为追逐速度（排斥力 0）');
  assertClose(u0.vz, 0, 1e-9);
});

// ---------- 出生、上限、伤害 ----------

test('ZombieService: 合法出生、默认 20 上限和精确伤害', () => {
  const { zombies, world, ids } = makeZombieFixture({ maxActive: 20 });
  const zombieIds = [];
  for (let i = 0; i < 20; i++) zombieIds.push(zombies.spawn([i * 2 + .5, 1, .5], { source: 'test' }));
  assertTrue(zombieIds.every(Boolean));
  assertEqual(zombies.count(), 20);
  // 第 21 只的落点必须在**已加载 column 内**（fixture 只建 cx 0..3）—— 若用 `[99.5,…]`
  // （cx=6 未加载），column 门控会先拒绝，**上限门控根本不被触发** → 注入「缺上限门控」
  // 仍然全绿（实测踩坑：无效负向验证）。x=50.5 → cx=3 已加载，且其余三道门全过。
  assertEqual(zombies.spawn([50.5, 1, .5], { source: 'test' }), null, '超上限须拒绝');
  const id = zombieIds[0];
  assertEqual(zombies.damage(id, 25, 100).health, 75);
  zombies.damage(id, 35, 110); zombies.damage(id, 35, 120); zombies.damage(id, 35, 130);
  assertEqual(zombies.get(id), null); // 100-25-35*3 = -30 → 死亡回收
  assertEqual(zombies.count(), 19);
  world.setBlock(40, 2, 0, ids.stone);
  assertEqual(zombies.spawn([40.5, 1, .5], { source: 'test' }), null); // head 被占用
});

test('ZombieService: 出生校验四道门（脚/头 air、脚下 solid、column 已加载）', () => {
  const { zombies, world, ids } = makeZombieFixture();
  // ① 脚下不 solid（y=5 悬空，y=4 是 air）
  assertNull(zombies.spawn([0.5, 5, .5], { source: 'test' }), '脚下不 solid 须拒绝');
  // ② 脚格被占用
  world.setBlock(4, 1, 0, ids.stone);
  assertNull(zombies.spawn([4.5, 1, .5], { source: 'test' }), '脚格被占用须拒绝');
  // ③ 头格被占用
  world.setBlock(6, 2, 0, ids.stone);
  assertNull(zombies.spawn([6.5, 1, .5], { source: 'test' }), '头格被占用须拒绝');
  // ④ column 未加载（cz=1 整列不存在）。注意：缺失 column 时 `getBlockId` 对范围内 y 恒返 0、
  // `isSolid` 恒 false，所以**常规高度下脚下门控总会先拒绝**，column 门控是冗余防御 ——
  // 仅断言这条 `[0.5,1,16.5]` 无法证明 column 门控本身生效（注入「删 column 门控」仍全绿）。
  // 故补一条能让 column 门控成为**唯一拒绝者**的边界：`y = WORLD_MIN_Y` 时脚下 `y-1 < WORLD_MIN_Y`
  // → `getBlockId` 返 bedrock（solid）→ 脚下门控通过，只剩 column 门控能拒绝。
  assertNull(zombies.spawn([0.5, 1, 16.5], { source: 'test' }), 'column 未加载须拒绝');
  assertNull(zombies.spawn([0.5, WORLD_MIN_Y, 16.5], { source: 'test' }),
    'column 门控是唯一拒绝者（脚下 bedrock 通过、脚/头 air 通过）');
  assertEqual(zombies.count(), 0, '任何失败路径都不得产生实体');
  // 合法出生仍然成功（失败路径没有污染后续状态）
  assertTrue(zombies.spawn([8.5, 1, .5], { source: 'test' }) !== null);
});

test('ZombieService: source 写入 state，state 形状为 M6 规格 §2 口径', () => {
  const { zombies } = makeZombieFixture();
  const id = zombies.spawn([0.5, 1, .5], { source: 'nest' });
  const state = zombies.get(id);
  assertEqual(state.source, 'nest');
  assertEqual(state.health, ZOMBIE.health);
  assertDeepEqual(state.position, [0.5, 1, .5]);
  assertDeepEqual(state.velocity, [0, 0, 0]);
  assertEqual(state.mode, 'idle');
  assertEqual(state.flashedUntil, 0);
  // generation **不在 state 里** —— Entity wrapper 是唯一权威（红线 1：不得复制第二份代数）
  assertFalse('generation' in state);
});

test('ZombieService: damage 未知 id 返回 null，damage 记录 flashedUntil', () => {
  const { zombies } = makeZombieFixture();
  assertNull(zombies.damage('never', 25, 100));
  const id = zombies.spawn([0.5, 1, .5], { source: 'test' });
  const result = zombies.damage(id, 25, 1_000);
  assertEqual(result.dead, false);
  assertEqual(result.health, 75);
  assertEqual(zombies.get(id).flashedUntil, 1_000 + ZOMBIE_FLASH_MS);
});

test('ZombieService: despawnColumn 回收该 column 的丧尸并返回计数', () => {
  const { zombies } = makeZombieFixture();
  const a = zombies.spawn([0.5, 1, .5], { source: 'test' });   // column 0,0
  const b = zombies.spawn([1.5, 1, .5], { source: 'test' });   // column 0,0
  zombies.spawn([20.5, 1, .5], { source: 'test' });            // column 1,0
  assertEqual(zombies.despawnColumn('0,0'), 2);
  assertNull(zombies.get(a));
  assertNull(zombies.get(b));
  assertEqual(zombies.count(), 1);
});

test('ZombieService: dispose 回收全部丧尸', () => {
  const { zombies } = makeZombieFixture();
  zombies.spawn([0.5, 1, .5], { source: 'test' });
  zombies.spawn([2.5, 1, .5], { source: 'test' });
  zombies.dispose();
  assertEqual(zombies.count(), 0);
});

test('ZombieService: id 复用后 generation 单调递增（迟到 AI 回包的拒绝前提）', () => {
  const { zombies, entities } = makeZombieFixture();
  const first = zombies.spawn([0.5, 1, .5], { source: 'test' });
  const firstGen = entities.get(first).generation;
  zombies.damage(first, 999, 100); // 死亡 → id 归还可复用
  // 反复出生直到拿回同一个 id（slot/id 低位优先分配）
  let second = null;
  for (let i = 0; i < ZOMBIE.maxActive && second === null; i++) {
    const candidate = zombies.spawn([i * 2 + 2.5, 1, .5], { source: 'test' });
    if (candidate === first) second = candidate;
  }
  assertTrue(second !== null, 'id 必须可复用（否则 generation 协议无从验证）');
  assertTrue(entities.get(second).generation > firstGen);
});

test('ZombieRenderer: 缺省容量从 ZOMBIE.maxActive 派生（非硬编码字面量）', () => {
  // fixture 一律显式传 `maxActive`，会覆盖被测的默认参数 → 注入「默认参数写死 30」时
  // fixture 构造的渲染器仍是 20，全绿（实测踩坑：默认参数路径不被任何断言覆盖）。
  // 故这里**不传 maxActive**，钉住默认值真的从 config 派生。
  const scene = new THREE.Scene();
  const renderer = new ZombieRenderer({ scene });
  for (const part of ZOMBIE_PARTS) {
    assertEqual(renderer.meshes[part].count, ZOMBIE.maxActive, `${part} 缺省容量须 = ZOMBIE.maxActive`);
    assertEqual(renderer.maxActive, ZOMBIE.maxActive);
  }
  renderer.dispose();
});

test('ZombieService: 缺省上限从 ZOMBIE.maxActive 派生', () => {
  // 同上：fixture 显式传 maxActive，默认参数路径无断言覆盖 → 注入「默认写死 21」不被发现。
  const { world, entities } = makeZombieFixture();
  const zombies = new ZombieService({ entities, world }); // 不传 maxActive
  assertEqual(zombies.maxActive, ZOMBIE.maxActive);
  const ids = [];
  for (let i = 0; i < ZOMBIE.maxActive; i++) ids.push(zombies.spawn([i * 2 + .5, 1, .5], { source: 'test' }));
  assertTrue(ids.every(Boolean), '缺省上限内必须全部成功');
  assertEqual(zombies.spawn([50.5, 1, .5], { source: 'test' }), null, '超出缺省上限须拒绝');
});

// ---------- AABB ----------

test('ZombieService: 实体 AABB = ZOMBIE.width × height × width（射线命中距离从常量派生）', () => {
  const { zombies, entities } = makeZombieFixture();
  // 落点在已加载 column 内（fixture 只建 cz=0）—— 用负 z 会让 spawn 恒 null、断言恒真
  const pos = [0.5, 1, 0.5];
  const id = zombies.spawn(pos, { source: 'test' });
  assertTrue(id !== null, '前提：实体必须真的出生（否则后续断言不触发射线分支）');
  const origin = [pos[0], pos[1] + ZOMBIE.height / 2, 10];
  const dir = [0, 0, -1];
  // 命中距离 = 盒正面（position.z + width/2）到起点的距离。**从 ZOMBIE 常量派生**而非硬编码
  const expected = round6(-(pos[2] + ZOMBIE.width / 2 - origin[2]));
  const hit = entities.raycast(origin, dir, 40, (e) => e.type === 'zombie');
  assertEqual(hit.id, id);
  assertEqual(round6(hit.dist), expected);
  // 头顶以上不命中 → 盒高真的是 ZOMBIE.height（把 height 改小/改大都会让这条失败）
  const above = [pos[0], pos[1] + ZOMBIE.height + 0.5, 10];
  assertNull(entities.raycast(above, dir, 40, (e) => e.type === 'zombie'), 'AABB 上界之外不得命中');
  // 半宽之外不命中 → 盒宽真的是 ZOMBIE.width
  const side = [pos[0] + ZOMBIE.width / 2 + 0.5, pos[1] + ZOMBIE.height / 2, 10];
  assertNull(entities.raycast(side, dir, 40, (e) => e.type === 'zombie'), 'AABB 半宽之外不得命中');
});

// ---------- 渲染器 ----------

test('ZombieRenderer: 六个固定容量 20 的 InstancedMesh，无每尸 Group', () => {
  const { renderer } = makeZombieFixture();
  assertEqual(ZOMBIE_PARTS.length, 6);
  assertDeepEqual([...ZOMBIE_PARTS].sort(),
    ['body', 'head', 'leftArm', 'leftLeg', 'rightArm', 'rightLeg']);
  for (const part of ZOMBIE_PARTS) {
    const mesh = renderer.meshes[part];
    assertTrue(mesh.isInstancedMesh === true, `${part} 必须是 InstancedMesh`);
    assertEqual(mesh.count, ZOMBIE.maxActive, `${part} 容量必须是 ${ZOMBIE.maxActive}`);
    assertTrue(mesh.geometry.type === 'BoxGeometry', `${part} 几何必须是程序化盒体`);
  }
  // 六个 mesh 全在 scene 上（不是每尸一个 Group）
  assertEqual(renderer.scene.children.length, ZOMBIE_PARTS.length);
  for (const child of renderer.scene.children) {
    assertFalse(child.type === 'Group', '不得为每只丧尸创建 Group');
  }
  // 材质必须是 unlit 的 MeshBasicMaterial：mc-heavy 全场景是 unlit 设计，灯光只为 PBR 武器
  // 模型标定（game.js 的 Ambient/Directional 注释）。用 mc-lite 的 MeshLambertMaterial 会让
  // 丧尸吃到为枪标定的 2.3 环境光强度 → 偏亮且随日夜灯光漂移。与 ocean/rain/tracer 同口径。
  for (const part of ZOMBIE_PARTS) {
    assertEqual(renderer.meshes[part].material.type, 'MeshBasicMaterial', `${part} 材质须 unlit`);
  }
});

test('ZombieRenderer: 死亡归还同一六部件 slot，红闪到期复位', () => {
  const { zombies, renderer } = makeZombieFixture();
  const id = zombies.spawn([.5, 1, .5], { source: 'test' });
  const slot = renderer.slotOf(id);
  assertTrue(slot !== null);
  assertEqual(renderer.activeCount(), 1);
  zombies.damage(id, 1, 1_000);
  renderer.sync(zombies, 1_100);
  assertTrue(renderer.isFlashing(slot));
  renderer.sync(zombies, 1_000 + ZOMBIE_FLASH_MS + 1);
  assertFalse(renderer.isFlashing(slot));
  zombies.damage(id, 999, 1_202);
  assertEqual(renderer.slotOf(id), null);
  assertEqual(renderer.activeCount(), 0);
  // 六部件矩阵全部清空（零 scale 不可见）—— slot 归还是对称的，不留残影
  for (const part of ZOMBIE_PARTS) {
    const mesh = renderer.meshes[part];
    const m = new THREE.Matrix4();
    mesh.getMatrixAt(slot, m);
    const e = m.elements;
    assertEqual(e[0], 0, `${part} 的 slot 矩阵须清零（scale.x）`);
    assertEqual(e[5], 0, `${part} 的 slot 矩阵须清零（scale.y）`);
    assertEqual(e[10], 0, `${part} 的 slot 矩阵须清零（scale.z）`);
  }
});

test('ZombieRenderer: slot 复用不串色，活跃 slot 数恒等于丧尸数', () => {
  const { zombies, renderer } = makeZombieFixture();
  const a = zombies.spawn([0.5, 1, .5], { source: 'test' });
  const slotA = renderer.slotOf(a);
  zombies.damage(a, 999, 100);
  const b = zombies.spawn([2.5, 1, .5], { source: 'test' });
  assertEqual(renderer.slotOf(b), slotA, '低位 slot 优先复用');
  // **sync 之前**断言初始红闪态：`acquireSlot` 必须把 pose 重置为不红闪。若断言放在 sync
  // 之后，sync 会按新 state 的 flashedUntil=0 重算 → 初值被覆盖，注入「acquireSlot 置
  // flashing:true」仍然全绿（实测踩坑：断言没落在被测路径）。
  assertFalse(renderer.isFlashing(slotA), 'acquireSlot 须重置红闪初值');
  renderer.sync(zombies, 200);
  assertFalse(renderer.isFlashing(slotA), '复用 slot 不得继承上一只的红闪');
  assertEqual(renderer.activeCount(), zombies.count());
});

test('ZombieRenderer: 步态按时间累积（速度 10 / 摆幅 π/8，左右腿取反）', () => {
  const { zombies, renderer } = makeZombieFixture();
  const id = zombies.spawn([0.5, 1, .5], { source: 'test' });
  const slot = renderer.slotOf(id);
  renderer.sync(zombies, 0);
  assertEqual(renderer.legSwingOf(slot), 0, '静止时摆幅为 0');

  // mc-lite `calculateWalkAnimation`：移动中 `_walkTime += deltaTime`，摆幅 =
  // sin(_walkTime × speed) × legSwingAngle；静止归零。**从冻结常量派生**而非硬编码。
  //
  // **用 vz 驱动而非 vx**（实测踩坑）：朝向派生 `yaw = atan2(vx, vz)`，若用 vx 驱动则
  // yaw=π/2，父级 Y 旋转会混进实例矩阵 → `euler.x` 分解出的不再是纯摆幅而是混合值
  // （实测 `Expected ~-0.3766, got -1.5708`）。用 vz 驱动时 yaw=atan2(0, 1.2)=0，
  // 下面的矩阵级断言前提（父级无旋转）才成立。摆幅本身与驱动轴无关（只看是否移动）。
  const dtMs = 500;
  zombies.setIntent(id, { vx: 0, vz: ZOMBIE.speed, mode: 'chasing' });
  renderer.sync(zombies, dtMs);
  const expected = Math.sin((dtMs / 1000) * ZOMBIE_WALK_SPEED) * ZOMBIE_SWING;
  assertClose(renderer.legSwingOf(slot), expected, 1e-9, '左腿摆幅');
  assertClose(renderer.legSwingOf(slot, 'rightLeg'), -expected, 1e-9, '右腿取反');
  assertTrue(Math.abs(renderer.legSwingOf(slot)) <= ZOMBIE_SWING, '摆幅不得超过 π/8');

  // **矩阵级断言**：`legSwingOf` 读的是 pose 内存值，而「右腿取反」的真实落点是实例矩阵。
  // 只断言 legSwingOf 时，注入「右腿不取反」（改矩阵写入那行）仍然全绿 —— 断言没落在被测路径。
  // 故从两个腿的实例矩阵反解 x 轴旋转，断言符号相反。
  const euler = new THREE.Euler();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const m = new THREE.Matrix4();
  renderer.meshes.leftLeg.getMatrixAt(slot, m);
  m.decompose(p, q, s);
  euler.setFromQuaternion(q);
  const leftRot = euler.x;
  renderer.meshes.rightLeg.getMatrixAt(slot, m);
  m.decompose(p, q, s);
  euler.setFromQuaternion(q);
  const rightRot = euler.x;
  assertClose(leftRot, expected, 1e-6, '左腿矩阵旋转');
  assertClose(rightRot, -expected, 1e-6, '右腿矩阵旋转取反');

  // 静止 → 相位归零（mc-lite `_walkTime = 0`），不是冻结在上一个摆幅
  zombies.setIntent(id, { vx: 0, vz: 0, mode: 'idle' });
  renderer.sync(zombies, dtMs + 500);
  assertEqual(renderer.legSwingOf(slot), 0, '静止后摆幅归零');
});

test('ZombieRenderer: 朝向矩阵反映 state.yaw —— 渲染真的消费朝向（非恒 0）', () => {
  // **必须钉住渲染消费 yaw**（本次修复的落点）：修复前 yaw 恒为 0，渲染层虽然读 pose.yaw
  // 并写进 `_parent.rotation.set(0, yaw, 0)`，但读到的恒是 0 → 丧尸出生后永远面向同一方向。
  // 只断言 `state.yaw` 变了不够 —— 那测的是逻辑层；这里从**实例矩阵**反解 Y 轴旋转，
  // 证明朝向真的传到了渲染几何上（否则注入「渲染层不写 yaw」仍然全绿）。
  //
  // **反解口径必须用 `atan2(elements[8], elements[0])`，不能用 `Euler.setFromQuaternion`**
  // （自查发现的盲区，实测踩坑）：three 的 Euler 'XYZ' 序对 Y 轴用 `asin(m13)`，而
  // `asin(sin θ)` 在 `|θ| > π/2` 时会**折叠**回 [-π/2, π/2] —— 实测 yaw=2.4805 时
  // Euler.y 读出 0.661。若用 Euler 口径，本测试只在 yaw 落在 [-π/2, π/2] 时才成立：
  // 原先选的 π/2 与 0 恰好在范围内 → 断言通过纯属侥幸，换一个方向就会假失败。
  // 纯 Y 旋转下 `elements[0] = cos θ`、`elements[8] = sin θ`，`atan2(sin, cos)` 范围无关。
  const { zombies, renderer } = makeZombieFixture();
  const id = zombies.spawn([0.5, 1, .5], { source: 'test' });
  const slot = renderer.slotOf(id);
  const m = new THREE.Matrix4();
  // head 本地旋转为 [0,0,0] → 其世界旋转 = 父级 yaw（纯 Y 轴）
  const readMatrixYaw = () => {
    renderer.meshes.head.getMatrixAt(slot, m);
    return Math.atan2(m.elements[8], m.elements[0]);
  };

  // 三个方向，其中一个**故意落在 asin 折叠区**（|yaw| > π/2）
  const cases = [
    { vx: ZOMBIE.speed, vz: 0, note: '朝 +X' },
    { vx: 0, vz: ZOMBIE.speed, note: '转向 +Z' },
    // 折叠区要求 `vz < 0`（yaw = atan2(vx, vz)，参数顺序是 (vx, vz)）。
    // 实测踩坑：写成 `vx:-0.7, vz:0.9` 得 atan2(-0.7, 0.9) ≈ -0.66，**不在**折叠区 →
    // 前提断言失败。须用 vz 为负的组合，如 (0.7, -0.9) → 2.4805。
    { vx: 0.7, vz: -0.9, note: '斜向（yaw≈2.48，落在 asin 折叠区）' },
  ];
  for (const c of cases) {
    zombies.setIntent(id, { vx: c.vx, vz: c.vz, mode: 'chasing' });
    renderer.sync(zombies, 0);
    const expected = Math.atan2(c.vx, c.vz);
    // 逻辑层 state.yaw
    assertClose(zombies.get(id).yaw, expected, 1e-9, `${c.note}: state.yaw`);
    // 渲染层实例矩阵（范围无关口径）
    assertClose(readMatrixYaw(), expected, 1e-6, `${c.note}: head 矩阵 Y 旋转`);
  }
  // 折叠区用例的前提断言：确实选了 |yaw| > π/2（否则这条盲区覆盖形同虚设）
  const folded = Math.atan2(0.7, -0.9);
  assertTrue(Math.abs(folded) > Math.PI / 2, '前提：第三个用例须落在 asin 折叠区');
});

test('丧尸: 步态与朝向共用同一个移动阈值（跨层一致性，红线 1）', () => {
  // **钉住两层阈值同源**（自查发现的盲区，实测踩坑）：`ZOMBIE_MOVING_EPSILON` 有两个消费方 ——
  // `zombie-system.js`（朝向派生）与 `zombie-renderer.js`（步态相位累积）。注入「渲染层改用
  // 本地字面量 0.5」后，上一版负向验证**全绿** —— 因为步态测试用速度 1.2（远大于 0.5），
  // 判定结果不变，检测不到漂移。
  //
  // 真实危害是：两层阈值不同 → 出现「腿在摆但朝向没跟上」或「朝向转了但腿不动」的撕裂状态。
  // 故在**临界值附近**断言两者同时生效。输入用字面量 0.0015（不从被测常量派生，否则注入把
  // 常量改大时输入也跟着变大 → 断言恒真，与上一轮同一个陷阱）。
  const { zombies, renderer } = makeZombieFixture();
  const id = zombies.spawn([0.5, 1, .5], { source: 'test' });
  const slot = renderer.slotOf(id);
  renderer.sync(zombies, 0); // 首帧 dt=0

  // 略高于真实阈值（0.001）的速度：应同时触发朝向派生与步态累积
  zombies.setIntent(id, { vx: 0.0015, vz: 0, mode: 'chasing' });
  renderer.sync(zombies, 500); // dt=0.5 秒 → walkTime 累积

  // 朝向侧（entities 层）：yaw = atan2(0.0015, 0) = π/2
  assertClose(zombies.get(id).yaw, Math.atan2(0.0015, 0), 1e-9, '略高于阈值须派生朝向');
  // 步态侧（render 层）：腿必须开始摆（不是静止）
  assertTrue(renderer.legSwingOf(slot) !== 0, '略高于阈值须累积步态（两层阈值须同源）');
  // 前提断言：输入确实高于真实阈值（否则这条盲区覆盖形同虚设）
  assertTrue(0.0015 > ZOMBIE_MOVING_EPSILON, '前提：测试输入须高于真实阈值');
});

test('ZombieRenderer: 六部件尺寸/偏移派生自 zombie-model（原版人形口径）', () => {
  // 断言的是**派生关系**：`ZOMBIE_PART_DEFS` 必须等于 `ZOMBIE_MODEL_DEFS` 的投影，
  // 而不是各写一份数值（两份会漂移）。同时钉住「不许有人把旧的自定义尺寸改回去」。
  for (const part of ZOMBIE_PARTS) {
    const model = ZOMBIE_MODEL_DEFS[part];
    const def = ZOMBIE_PART_DEFS[part];
    assertDeepEqual(def.size, [...model.size], `${part}.size 须派生自 zombie-model`);
    assertDeepEqual(def.offset, [...model.pivot], `${part}.offset 须 = 模型轴心`);
    assertEqual(def.color, model.fallbackColor, `${part}.color 须 = 模型退回色`);
  }
  // 关键绝对值（原版口径）：躯干 0.5×0.75×0.25、四肢 0.25×0.75×0.25
  assertDeepEqual(ZOMBIE_PART_DEFS.body.size, [0.5, 0.75, 0.25]);
  assertDeepEqual(ZOMBIE_PART_DEFS.leftLeg.size, [0.25, 0.75, 0.25]);
  // 臂仍保留基准前伸角逐（左右略不对称，现状口径）
  assertEqual(ZOMBIE_PART_DEFS.leftArm.rotation[0], -Math.PI / 2 + 0.12 * Math.PI);
  // Z 轴不外张：原版丧尸双臂向前直伸、几乎平行。
  // （实测试过 ±0.10π 外张，观感像企鹅摊手 —— 不是原版）
  assertEqual(ZOMBIE_PART_DEFS.leftArm.rotation[2], 0, '左臂不应向外张开');
  assertEqual(ZOMBIE_PART_DEFS.rightArm.rotation[2], 0, '右臂不应向外张开');
  assertEqual(ZOMBIE_PART_DEFS.rightArm.rotation[0], -Math.PI / 2 + 0.09 * Math.PI);
  // 腿的静态 rotation 为 null（摆幅由步态给）
  assertNull(ZOMBIE_PART_DEFS.leftLeg.rotation);
  assertNull(ZOMBIE_PART_DEFS.rightLeg.rotation);
});

test('ZombieRenderer: 有纹理时每个面的 UV 落在该部件对应的皮肤矩形内', () => {
  const dummy = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const { renderer } = makeZombieFixture({ skinTexture: dummy });
  const FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
  for (const part of ZOMBIE_PARTS) {
    const uv = renderer.meshes[part].geometry.getAttribute('uv');
    const table = ZOMBIE_SKIN_UV[part];
    FACES.forEach((face, faceIndex) => {
      const r = table[face];
      const u0 = Math.min(r[0], r[2]) / SKIN_SIZE, u1 = Math.max(r[0], r[2]) / SKIN_SIZE;
      const v0 = Math.min(r[1], r[3]) / SKIN_SIZE, v1 = Math.max(r[1], r[3]) / SKIN_SIZE;
      for (let k = 0; k < 4; k++) {
        const i = faceIndex * 4 + k;
        const u = uv.getX(i), v = uv.getY(i);
        assertTrue(u >= u0 - 1e-6 && u <= u1 + 1e-6,
          `${part}.${face} 顶点 ${i} 的 u=${u} 须落在 [${u0}, ${u1}]`);
        assertTrue(v >= v0 - 1e-6 && v <= v1 + 1e-6,
          `${part}.${face} 顶点 ${i} 的 v=${v} 须落在 [${v0}, ${v1}]`);
      }
    });
  }
});

test('ZombieRenderer: 反向书写的 UV 矩形被映射成镜像（不规范化）', () => {
  const dummy = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const { renderer } = makeZombieFixture({ skinTexture: dummy });
  // body.py（+Y 面，faceIndex 2）的矩形是 [28,16,20,20]（u 反向：u0=28 → u1=20）
  const uv = renderer.meshes.body.geometry.getAttribute('uv');
  const pts = [0, 1, 2, 3].map((k) => ({ u: uv.getX(2 * 4 + k), v: uv.getY(2 * 4 + k) }));
  // 矩形规范化后应是 u ∈ [20/64, 28/64]、v ∈ [16/64, 20/64]
  const uMin = 20 / 64, uMax = 28 / 64, vMin = 16 / 64, vMax = 20 / 64;
  for (const p of pts) {
    assertTrue(p.u >= uMin - 1e-6 && p.u <= uMax + 1e-6, `u=${p.u} 超界`);
    assertTrue(p.v >= vMin - 1e-6 && p.v <= vMax + 1e-6, `v=${p.v} 超界`);
  }
  // **镜像判据**：默认 BoxGeometry 的某面四个顶点 UV 是 (0,1)(1,1)(0,0)(1,0) ——
  // 即「v 相等的两个顶点」之间 u 递增。矩形 u1 < u0 ⇒ 映射后那对顶点的 u 必须**递减**。
  // 规范化成 min/max 会让它们递增 → 该面水平镜像（衣服纹理左右反了）。
  // ⚠️ 不能用「u 最大处的 v」做判据：四个顶点的 (u,v) 只取两个值组合，u 与 v 两组配对
  // 完全相同（实测两侧都是 0.3125）—— 那样写会得出恒真的无效断言。
  const pair = pts.filter((p) => Math.abs(p.v - Math.max(...pts.map((q) => q.v))) < 1e-9);
  assertEqual(pair.length, 2, '前提：该面有两个顶点的 v 相等');
  assertTrue(pair[0].u > pair[1].u,
    `body.py 在等高 v 处 u 应递减（矩形 [28,16,20,20]），实测 ${pair[0].u} vs ${pair[1].u}`);
});

test('ZombieRenderer: 腿几何轴心在大腿根部（mc-lite translate 语义）', () => {
  const { renderer } = makeZombieFixture();
  const def = ZOMBIE_PART_DEFS.leftLeg;
  const geo = renderer.meshes.leftLeg.geometry;
  // BoxGeometry 默认原点在盒中心；mc-lite :203 做了 translate(0,-h/2,0) 把轴心移到髋部。
  // 用包围盒判定：轴心在髋部 → minY = -h、maxY = 0；未 translate → ±h/2。
  geo.computeBoundingBox();
  assertClose(geo.boundingBox.max.y, 0, 1e-6, '腿几何 maxY 须为 0（轴心在髋部）');
  assertClose(geo.boundingBox.min.y, -def.size[1], 1e-6, '腿几何 minY 须为 -height');
  // head 不 translate（offset 是盒中心）→ 包围盒对称
  renderer.meshes.head.geometry.computeBoundingBox();
  assertClose(renderer.meshes.head.geometry.boundingBox.max.y, ZOMBIE_PART_DEFS.head.size[1] / 2, 1e-6);
});

test('ZombieRenderer: HEAD_FRONT_VERTICES 确实是正面（pz），且 UV 落在头部正脸矩形内', () => {
  // dummy 纹理（DataTexture，无需 DOM/canvas）：只为触发「有 map」路径，内容不重要
  const dummy = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const { renderer } = makeZombieFixture({ skinTexture: dummy });
  const geo = renderer.meshes.head.geometry;
  const uv = geo.getAttribute('uv');
  const pos = geo.getAttribute('position');

  // ① **前提断言：HEAD_FRONT_VERTICES 确实是「正面（pz）」的顶点**。
  //    必须独立于被测常量验证 —— 否则把常量改成错误索引（如 [0,1,2,3] = 右面）时，
  //    下面的 UV 断言**仍会全绿**（它读的就是那个被改错的常量）→ 恒真陷阱。
  //    判据用**法线**而非 position.z：棱上的顶点被多个面共享 z 值。
  const normal = geo.getAttribute('normal');
  for (const i of HEAD_FRONT_VERTICES) {
    assertClose(normal.getX(i), 0, 1e-6, `顶点 ${i} 法线 x 须为 0`);
    assertClose(normal.getY(i), 0, 1e-6, `顶点 ${i} 法线 y 须为 0`);
    assertClose(normal.getZ(i), 1, 1e-6, `顶点 ${i} 须是正面（法线 z = +1）`);
  }
  // ② 反向前提：法线 (0,0,+1) 的顶点**恰好**是 HEAD_FRONT_VERTICES → 钉住「不多不少」
  const byNormal = [];
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(normal.getZ(i) - 1) < 1e-6 && Math.abs(normal.getX(i)) < 1e-6 && Math.abs(normal.getY(i)) < 1e-6) {
      byNormal.push(i);
    }
  }
  assertDeepEqual(byNormal.sort((a, b) => a - b), [...HEAD_FRONT_VERTICES].sort((a, b) => a - b),
    '正面顶点须恰好是 HEAD_FRONT_VERTICES（不多不少）');

  // ③ 正面采到的是**皮肤里头部正脸那块矩形**（`ZOMBIE_SKIN_UV.head.pz`，眼睛在里面）。
  //    取代旧版「采双区纹理右半」的断言：现在整张皮肤是一套标准 64×64 版式，
  //    不再是「左半无眼 / 右半有眼」的分区。
  const [u1, v1, u2, v2] = ZOMBIE_SKIN_UV.head.pz;
  const uMin = Math.min(u1, u2) / SKIN_SIZE, uMax = Math.max(u1, u2) / SKIN_SIZE;
  const vMin = Math.min(v1, v2) / SKIN_SIZE, vMax = Math.max(v1, v2) / SKIN_SIZE;
  for (const i of HEAD_FRONT_VERTICES) {
    const u = uv.getX(i), v = uv.getY(i);
    assertTrue(u >= uMin - 1e-6 && u <= uMax + 1e-6,
      `正面顶点 ${i} 的 u=${u} 须落在头部正脸矩形 [${uMin}, ${uMax}]`);
    assertTrue(v >= vMin - 1e-6 && v <= vMax + 1e-6,
      `正面顶点 ${i} 的 v=${v} 须落在头部正脸矩形 [${vMin}, ${vMax}]`);
  }

  // ④ 六部件全部带 map（皮肤是全身的，不再只有头）
  assertTrue(!!renderer.meshes.head.material.map, 'head 材质须带 map');
  assertTrue(renderer.hasSkinTexture(), 'hasSkinTexture 须为真');
  for (const part of ZOMBIE_PARTS) {
    assertTrue(!!renderer.meshes[part].material.map, `${part} 材质须带 map（全身皮肤）`);
  }
});

test('ZombieRenderer: 无纹理时六部件退回各自视觉色（不渲染成纯白方人）', () => {
  const { renderer } = makeZombieFixture(); // 无 skinTexture
  assertFalse(renderer.hasSkinTexture(), '默认 fixture 不应有纹理');
  const c = new THREE.Color();
  for (const part of ZOMBIE_PARTS) {
    assertNull(renderer.meshes[part].material.map, `${part} 无纹理时不应带 map`);
    renderer.meshes[part].getColorAt(0, c);
    // 退回色的权威在 zombie-model.js 的 fallbackColor（不读 ZOMBIE_PART_DEFS.head.color ——
    // 那已经派生自同一处，读它会让「派生断了」这类缺陷测不出来）
    assertEqual(c.getHex(), ZOMBIE_MODEL_DEFS[part].fallbackColor, `${part} 退回色`);
  }
});

test('ZombieRenderer: 有纹理时六部件基色为白底（避免基色 × 纹理变暗）', () => {
  const dummy = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const { renderer } = makeZombieFixture({ skinTexture: dummy });
  const c = new THREE.Color();
  for (const part of ZOMBIE_PARTS) {
    assertTrue(!!renderer.meshes[part].material.map, `${part} 有纹理时须带 map`);
    renderer.meshes[part].getColorAt(0, c);
    // 有 map → 白底乘纹理色。若读到深色基色，会与纹理叠加 → 整体严重变暗
    assertEqual(c.getHex(), 0xffffff, `${part} 有纹理时基色须为白底`);
  }
});

test('ZombieRenderer: pose 跟随实体位置与朝向（只读发布，不回写 state）', () => {
  const { zombies, renderer, entities } = makeZombieFixture();
  const id = zombies.spawn([0.5, 1, .5], { source: 'test' });
  const slot = renderer.slotOf(id);
  const pos = [3.5, 1, -2.5];
  entities.applyAsyncPose({ id, generation: entities.get(id).generation, position: pos });
  renderer.sync(zombies, 0);
  const pose = renderer.poseOf(slot);
  assertDeepEqual(pose.position.map(round6), pos.map(round6));
  // 渲染层不回写 state（M5 受控渲染层口径）：改 pose 读到的位置不改变权威 state
  assertDeepEqual(zombies.get(id).position.map(round6), pos.map(round6));
});

test('ZombieRenderer: dispose 清空全部 slot 并从 scene 释放六部件', () => {
  const { zombies, renderer } = makeZombieFixture();
  zombies.spawn([0.5, 1, .5], { source: 'test' });
  zombies.spawn([2.5, 1, .5], { source: 'test' });
  renderer.sync(zombies, 0);
  renderer.dispose();
  assertEqual(renderer.activeCount(), 0);
  assertEqual(renderer.scene.children.length, 0);
});

// ---------- Task 2：批量 AI RPC + 60Hz 物理 + column 生命周期 ----------

/**
 * AI fixture：可控距离 + 可注入回包的 fake pool。
 *
 * 玩家固定在 `[0.5, 1, 0.5]`，丧尸按**精确距离**放置（10 / 59 / 61 格）—— 60 格门控的
 * 断言必须落在「59 进批次、61 不进」这个边界上，靠真实地形扫描落点无法控制距离。
 */
function makeAiFixture({ worldColumns = 8, withRenderer = false } = {}) {
  const registry = createRegistry();
  registry.register('air', { solid: false, opaque: false, cullMode: 'none' });
  registry.register('stone', { solid: true, opaque: true, cullMode: 'opaque' });
  registry.register('bedrock', { solid: true, opaque: true, cullMode: 'opaque' });
  registry.freeze();
  const ids = { air: registry.idOf('air'), stone: registry.idOf('stone') };

  const world = new WorldData(registry);
  // 平地：cx 0..worldColumns-1 / cz 0，y=0 全 stone（覆盖 x ∈ [0, 16×worldColumns)）
  for (let cx = 0; cx < worldColumns; cx++) {
    const column = new ChunkColumn(cx, 0);
    for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) column.set(lx, 0, lz, ids.stone);
    world.add(column);
  }

  const entities = new EntityManager();
  entities.registerType('zombie', zombieDefinition);

  const scene = new THREE.Scene();
  const renderer = withRenderer ? new ZombieRenderer({ scene, maxActive: ZOMBIE.maxActive }) : null;

  /**
   * fake pool：记录每次 `ai` 调用的 payload，可注入回包。
   * **返回 `{id, promise}` 而非裸 promise** —— 必须与真实 `WorkerPool.call` 的返回形状一致
   * （worker-pool.js:71）。实测踩坑：原先返回 `Promise.resolve(...)`，纯逻辑测试全绿，但真实
   * 接线时 `zombie-system` 走同步分支拿到 `{id,promise}` 对象 → 意图写不进去、丧尸原地不动。
   * 口径不一致的 fixture 会让接线缺陷静默逃逸（testing-policy §2.5）。
   */
  const pool = {
    calls: [],
    /** @type {Array<{updates: Array}>} 预置回包队列（按顺序消费） */
    replies: [],
    /** 非 null 时：回包挂起在这个 promise 上（制造真实的在途窗口，测「在途不重复调用」） */
    deferred: null,
    _nextId: 1,
    call(method, payload) {
      this.calls.push({ method, payload });
      const promise = this.deferred ?? Promise.resolve(this.replies.shift() ?? { updates: [] });
      return { id: this._nextId++, promise };
    },
  };

  const zombies = new ZombieService({
    entities, world, pool,
    // 渲染层可选：物理用例不需要它（construction 成本 + 与断言无关）；
    // 上台阶缓动用例必须走真实「service 分配 slot → renderer 发布 pose」链路。
    onSpawn: withRenderer ? (id, slot) => renderer.acquireSlot(id, slot) : null,
    onDespawn: withRenderer ? (id) => renderer.releaseSlot(id) : null,
    // v2.81：击退的渲染层补间（与 Game 装配逐字同形）
    onKnockback: withRenderer ? (id, dx, dz) => renderer.noteKnockback(id, dx, dz) : null,
  });
  const playerPosition = [0.5, 1, 0.5];

  return { registry, ids, world, entities, zombies, pool, playerPosition, renderer: withRenderer ? renderer : null };
}

// ==================== v2.47：本地导航接管决策（原 6 条 RPC 用例的重写） ====================
//
// **为什么整段重写**：用户 2026-11-04 裁定「完全去掉 Jev、只依赖本地计算」后，
// `pool.call('ai', …)` 的离线 RPC 决策分支被整体删除 —— 它与本地导航**抢写同一份
// `state.velocity`**（实测：速度在 ±1.2 之间翻转、净位移接近 0）。
// 决策权的唯一写者现在是 `_stepNavigator` → `_applyIntent`。
//
// 原来 6 条用例钉的是「RPC 批次的可靠性」（周期节流、在途不重复、代数校验、60 格门控）。
// 它们服务的机制已不存在，但**其中三条的意图对新机制仍然成立**，故重写而不是删除：
//   ① 决策有周期节流（不是每帧重算）
//   ② 朝向从速度派生（移动时跟随、静止保持）
//   ③ 过期/无主意图不得写入
// 另加一条本轮最重要的回归门：**默认设置下导航必须真的在跑**。

test('v2.47 ZombieService: 导航按 aiPeriod 节流（不是每帧重算）', () => {
  const { zombies, playerPosition } = makeAiFixture();
  zombies.spawn([10.5, 1, .5], { source: 'test' });
  const before = zombies.debugNavigator().navDecisions;
  // 0.049 秒 < aiPeriod(0.05) → 尚未到周期
  zombies.update(0.049, { playerPosition });
  assertEqual(zombies.debugNavigator().navDecisions, before, '未到周期不得决策');
  // 再推进 0.001 → 恰好一个周期
  zombies.update(0.001, { playerPosition });
  assertEqual(zombies.debugNavigator().navDecisions, before + 1, '每周期决策一次');
});

test('v2.47 ZombieService: 默认设置下导航**真的在跑**（本轮核心回归门）', () => {
  // ⚠️ **这条用例来自一次真实的实玩事故**：v2.46 把寻路挂在「在线 AI 开关」下，而那个开关
  // 默认关闭 ⇒ 玩家打开游戏时寻路一行都没执行（实测 `plannerEnabled: false, decided: 0`），
  // 用户反馈「丧尸完全没有任何寻路逻辑」。寻路是纯本地计算，必须常开、不受任何开关控制。
  const { zombies, playerPosition } = makeAiFixture();
  const id = zombies.spawn([10.5, 1, .5], { source: 'test' });
  // 玩家在丧尸正西 → 导航应给出朝西的速度
  zombies.update(ZOMBIE.aiPeriod, { playerPosition: [0.5, 1, 0.5] });
  const st = zombies.get(id);
  assertTrue(zombies.debugNavigator().navDecisions > 0, '默认就必须有导航决策');
  assertTrue(Math.hypot(st.velocity[0], st.velocity[2]) > 0, `默认就必须写出速度，实际 ${st.velocity}`);
  assertTrue(st.velocity[0] < 0, `须朝西（玩家在西），实际 vx=${st.velocity[0]}`);
});

test('v2.47 ZombieService: 朝向从速度派生（移动跟随、静止保持）', () => {
  // mc-lite 口径保留：`yaw = atan2(vx, vz)`，**仅在移动时更新**，静止保持原朝向。
  const { zombies, playerPosition } = makeAiFixture();
  const id = zombies.spawn([10.5, 1, .5], { source: 'test' });
  assertEqual(zombies.get(id).yaw, 0, '出生朝向为 0');
  // 玩家在正东 → 朝 +X → yaw = atan2(vx, 0) = π/2
  zombies.update(ZOMBIE.aiPeriod, { playerPosition: [30.5, 1, 0.5] });
  const st = zombies.get(id);
  assertTrue(st.velocity[0] > 0, `应朝东，实际 vx=${st.velocity[0]}`);
  assertClose(st.yaw, Math.atan2(st.velocity[0], st.velocity[2]), 1e-9, '朝向须由速度派生');
  // 静止（无玩家位移且无速度）时保持 —— 由 setIntent 的「移动才派生」保证
  const yawBefore = st.yaw;
  zombies.setIntent(id, { vx: 0, vz: 0, mode: 'idle' });
  assertClose(zombies.get(id).yaw, yawBefore, 1e-9, '静止时必须保持原朝向');
});

test('v2.47 ZombieService: 导航绕墙（端到端，不是只测纯函数）', () => {
  // 端到端回归：真 service + 真世界 + 真导航，丧尸必须横向绕墙。
  const { zombies, ids, playerPosition } = makeAiFixture();
  // 在 (10,5) 摆 3 格高墙，横跨 3 格（丧尸在 (10,10)，玩家在 (10,0)）
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = 0; dy < 3; dy++) {
      zombies.world.setBlock(10 + dx, 1 + dy, 5, ids.stone);
    }
  }
  const id = zombies.spawn([10.5, 1, 10.5], { source: 'test' });
  zombies.update(ZOMBIE.aiPeriod, { playerPosition });
  const st = zombies.get(id);
  assertTrue(Math.hypot(st.velocity[0], st.velocity[2]) > 0, '必须有移动意图');
  assertTrue(Math.abs(st.velocity[0]) > 0.3,
    `必须横向绕墙（vx=${st.velocity[0]}, vz=${st.velocity[2]}）`);
});

test('v2.47 ZombieService: 过期 generation 的意图不得写入', () => {
  // 代数协议仍然有效（`_applyIntent` 的第一道门），与 RPC 是否存在无关。
  const { zombies, playerPosition, entities } = makeAiFixture();
  const id = zombies.spawn([10.5, 1, .5], { source: 'test' });
  const staleGeneration = entities.get(id).generation;
  zombies.damage(id, 999, 100);                 // 死亡 → id 可复用
  const reborn = zombies.spawn([10.5, 1, .5], { source: 'test' });
  assertEqual(reborn, id, 'id 必须被复用（否则代数协议无从验证）');
  assertTrue(entities.get(reborn).generation > staleGeneration);
  const applied = zombies._applyIntent({
    id, generation: staleGeneration, vx: 1.2, vz: 0, mode: 'chasing',
  });
  assertFalse(applied, '过期代数的意图必须被丢弃');
});

test('ZombieService: 80 格感知保留为 type 数据（AI 只受 60 格预算门控）', () => {
  // 感知范围（80）与 AI 预算门（60）是两个独立口径：超 60 格不进批次，但 80 格数据仍保留
  // —— worker 侧按 80 格判定 idle（M6 规格 §2）。这条钉住两者不被混为一处。
  assertEqual(ZOMBIE.perceptionRange, 80);
  assertEqual(ZOMBIE.aiSleepDistance, 60);
  assertTrue(ZOMBIE.perceptionRange > ZOMBIE.aiSleepDistance);
});

// ---------- 60Hz 物理（definition.update，由 EntityManager 驱动） ----------

test('丧尸物理: 水平位移 = velocity × dt（1.2 格/秒 → 1/60 秒位移 1.2/60）', () => {
  const { zombies, entities, world } = makeAiFixture();
  const id = zombies.spawn([10.5, 1, .5], { source: 'test' });
  zombies.setIntent(id, { vx: ZOMBIE.speed, vz: 0, mode: 'chasing' });
  const beforeX = zombies.get(id).position[0];
  entities.update(1 / 60, { world });
  const afterX = zombies.get(id).position[0];
  // **从 ZOMBIE.speed 派生**而非硬编码 0.02（testing-policy §2.5）
  assertClose(round6(afterX - beforeX), round6(ZOMBIE.speed / 60), 1e-6, '一步位移');
  // 竖直方向不漂移（站在地面上，重力被碰撞吸收）
  assertEqual(zombies.get(id).position[1], 1);
});

test('丧尸物理: AABB 碰撞 —— 撞墙停下，不穿墙', () => {
  const { zombies, entities, world, ids } = makeAiFixture();
  const id = zombies.spawn([10.5, 1, .5], { source: 'test' });
  // 在 +X 方向 2 格处立一堵墙（y=1..2 两格高，丧尸 1.8 高撞不上去）
  world.setBlock(13, 1, 0, ids.stone);
  world.setBlock(13, 2, 0, ids.stone);
  zombies.setIntent(id, { vx: ZOMBIE.speed, vz: 0, mode: 'chasing' });
  // 推 10 秒（600 步）—— 若无碰撞会走出 12 格穿墙
  for (let i = 0; i < 600; i++) entities.update(1 / 60, { world });
  const x = zombies.get(id).position[0];
  // 墙在 x=13（占据 [13,14)），丧尸半宽 0.3 → 必须停在 12.7 之前
  assertTrue(x <= 12.7 + 1e-6, `不得穿墙：x=${x}`);
  assertTrue(x > 10.5, '确实朝墙移动过');

  // **撞墙后 velocity 必须保留 AI 意图**（自查发现的盲区）：原先只断言「没穿墙 + 移动过」，
  // 注入「水平撞墙清零 velocity」时丧尸贴墙停住 —— 这两条仍然成立，测试全绿。
  // 真实危害：AI RPC 每 0.05 秒才刷新一次意图，物理跑 60Hz；清零会让丧尸在两次 RPC 之间
  // 彻底卡住。故断言撞墙后意图仍在，且**移除墙后能继续走**（这才是意图保留的可观测后果）。
  assertEqual(zombies.get(id).velocity[0], ZOMBIE.speed, '撞墙不得清零水平意图');
  world.setBlock(13, 1, 0, 0); // 拆墙
  world.setBlock(13, 2, 0, 0);
  const xBeforeWall = zombies.get(id).position[0];
  for (let i = 0; i < 120; i++) entities.update(1 / 60, { world });
  assertTrue(zombies.get(id).position[0] > xBeforeWall, '拆墙后须继续前进（意图未被清零）');
});

test('丧尸物理: 一格 step-up（1 格台阶能上，2 格墙不能上）', () => {
  // **台阶必须是连续高台，不能是孤立一格**（实测踩坑）：只放 `(12,1)` 一格时，丧尸确实
  // 登上 y=2（逐步追踪可见 i=60 处 y: 1→2），但继续朝 +X 走越过 x=12 后脚下无支撑 →
  // 掉回 y=1 → 300 步后断言 `y===2` 失败，看起来像「step-up 失效」，其实是 fixture 缺陷。
  // 故把 x ≥ 12 做成一整段高台（顶面 y=2），丧尸登上后持续保持在 y=2。
  const { zombies, entities, world, ids } = makeAiFixture();
  const a = zombies.spawn([10.5, 1, .5], { source: 'test' });
  for (let x = 12; x < 60; x++) world.setBlock(x, 1, 0, ids.stone);
  zombies.setIntent(a, { vx: ZOMBIE.speed, vz: 0, mode: 'chasing' });
  for (let i = 0; i < 300; i++) entities.update(1 / 60, { world });
  assertEqual(zombies.get(a).position[1], 2, '一格台阶须登上（脚底抬到 y=2）');
  assertTrue(zombies.get(a).position[0] > 12, '前提：确实走到台阶上');

  // 两格墙：y=1..2 → 1.8 高的丧尸登不上去（需 2 格净空），且不得穿墙
  const { zombies: z2, entities: e2, world: w2, ids: ids2 } = makeAiFixture();
  const b = z2.spawn([10.5, 1, .5], { source: 'test' });
  for (let x = 12; x < 60; x++) { w2.setBlock(x, 1, 0, ids2.stone); w2.setBlock(x, 2, 0, ids2.stone); }
  z2.setIntent(b, { vx: ZOMBIE.speed, vz: 0, mode: 'chasing' });
  for (let i = 0; i < 300; i++) e2.update(1 / 60, { world: w2 });
  assertEqual(z2.get(b).position[1], 1, '两格墙不得登上');
  assertTrue(z2.get(b).position[0] <= 11.7 + 1e-6, `两格墙不得穿过：x=${z2.get(b).position[0]}`);
});

test('丧尸物理: 重力落地 —— 悬空出生会落到地面', () => {
  const { zombies, entities, world } = makeAiFixture();
  // 直接构造悬空 state（绕过 spawn 的脚下 solid 门控，只为测重力）
  const entity = entities.spawn({ id: 'faller', type: 'zombie', state: { position: [10.5, 6, .5] } });
  assertTrue(entity !== null);
  for (let i = 0; i < 600; i++) entities.update(1 / 60, { world });
  // 地面在 y=0（stone），丧尸脚底须落到 y=1（站在方块顶面上）。
  // **用容差而非 assertEqual**：二分回退 `old + delta*lo` 收敛到不碰撞位置时会留 ~2.6e-5 的
  // 浮点余量（与 player/physics.js 同行为 —— 实测踩坑：`assertEqual(y,1)` 得 1.000026 失败，
  // 看着像「没落地」，其实是物理固有的落地余量）。
  assertClose(zombies.get('faller').position[1], 1, 1e-3, '须落到地面');
});

test('丧尸物理: 跨 column 移动后派生 column 索引跟随迁移', () => {
  const { zombies, entities, world } = makeAiFixture();
  // 出生在 column 0 的右边界附近，朝 +X 走到 column 1
  const id = zombies.spawn([14.5, 1, .5], { source: 'test' });
  assertEqual([...entities.entitiesInColumn('0,0')].length, 1);
  zombies.setIntent(id, { vx: ZOMBIE.speed, vz: 0, mode: 'chasing' });
  for (let i = 0; i < 120; i++) entities.update(1 / 60, { world });
  assertTrue(zombies.get(id).position[0] > 16, '前提：确实跨过 column 边界');
  assertEqual([...entities.entitiesInColumn('0,0')].length, 0, '旧 column 索引须清空');
  assertEqual([...entities.entitiesInColumn('1,0')].length, 1, '新 column 索引须收录');
  // 卸载回收必须能命中新索引（否则丧尸泄漏 —— 这是索引迁移的意义）
  assertEqual(zombies.despawnColumn('1,0'), 1);
});

test('丧尸物理: 帧 dt 与 60Hz 步长不对齐时，accumulator 跨 update 保留余量', () => {
  // **必须用非对齐 dt**（自查发现的盲区）：其余物理测试都用 dt = 1/60，正好等于固定步长 →
  // accumulator 恒为 0，`createState` 丢掉 `_physAccum` 也看不出差别（注入后全绿）。
  // 这里用 dt = 0.025（= 1.5 步）：每次 update 跑 1 步、余 0.00833 秒；连续调用时余量必须
  // 累积到下个周期，否则每帧都丢弃余量 → 丧尸移动比应有的慢 1/3。
  const { zombies, entities, world } = makeAiFixture();
  const id = zombies.spawn([10.5, 1, .5], { source: 'test' });
  zombies.setIntent(id, { vx: ZOMBIE.speed, vz: 0, mode: 'chasing' });
  const x0 = zombies.get(id).position[0];
  // 4 次 × 0.025 秒 = 0.1 秒 → 应走满 6 步（0.1 / (1/60)），不是 4 步
  for (let i = 0; i < 4; i++) entities.update(0.025, { world });
  const moved = zombies.get(id).position[0] - x0;
  // **从 ZOMBIE.speed 派生**：0.1 秒 × 1.2 格/秒 = 0.12 格（若每帧丢余量则只有 0.08）
  assertClose(round6(moved), round6(ZOMBIE.speed * 0.1), 1e-6, '非对齐 dt 下余量须跨 update 累积');
});

test('丧尸物理: 受伤/AI 回包重建 state 后，accumulator 余量不丢失', async () => {
  // **必须中途重建 state 才能暴露**（自查发现的盲区）：物理累积靠 `zombieDefinition.update`
  // 里的 `state._physAccum = (prev._physAccum ?? 0) + dt` **直接赋值**，不经 createState ——
  // 所以注入「createState 丢 _physAccum」在纯物理循环里完全不可检测（上一版负向验证漏网）。
  // 只有 `damage` / `setIntent` 这类经 `createState` 重建 state 的路径才会丢余量。
  // 这里在余量非零的时刻插一次 damage，验证之后的步数仍然正确。
  const { zombies, entities, world } = makeAiFixture();
  const id = zombies.spawn([10.5, 1, .5], { source: 'test' });
  zombies.setIntent(id, { vx: ZOMBIE.speed, vz: 0, mode: 'chasing' });
  const x0 = zombies.get(id).position[0];
  // 推 0.025 秒（= 1.5 步 → 走 1 步、余 0.00833 秒）
  entities.update(0.025, { world });
  // 中途受伤：damage 经 createState 重建 state（此刻余量必须被带过去）
  zombies.damage(id, 10, 1000);
  assertTrue(zombies.get(id)._physAccum > 0, '前提：受伤后 accumulator 余量须保留');
  // 再推 0.075 秒（= 4.5 步），合计 0.1 秒 → 仍应走满 6 步
  entities.update(0.075, { world });
  const moved = zombies.get(id).position[0] - x0;
  assertClose(round6(moved), round6(ZOMBIE.speed * 0.1), 1e-6, '受伤重建后余量不得丢失');
});

test('丧尸物理: 不跳跃、不越界（y 稳定在地面，不累积漂移）', () => {
  const { zombies, entities, world } = makeAiFixture();
  const id = zombies.spawn([10.5, 1, .5], { source: 'test' });
  zombies.setIntent(id, { vx: 0, vz: 0, mode: 'idle' });
  for (let i = 0; i < 600; i++) entities.update(1 / 60, { world });
  // 静止 10 秒后仍在地面（重力被碰撞吸收，不累积下沉/上浮）
  assertEqual(zombies.get(id).position[1], 1);
  assertEqual(zombies.get(id).position[0], 10.5, '静止不漂移');
});

test('丧尸物理: velocity 上限钳制（意图不得让丧尸超速）', () => {
  // 常量口径：把 speed 改大会让丧尸追得上玩家（玩法失衡）
  assertEqual(ZOMBIE.speed, 1.2);
  assertTrue(ZOMBIE.speed < 8.0, '丧尸速度须明显低于玩家 8 格/秒（否则追得上）');

  // **必须真的触发钳制代码**：直接走 `_applyIntent`（唯一写入口），不经过任何 RPC。
  // v2.47 删掉了离线 RPC 分支，故这里直调 —— 钳制逻辑本身没变，只是入口唯一了。
  const { zombies } = makeAiFixture();
  const id = zombies.spawn([10.5, 1, .5], { source: 'test' });
  const generation = zombies.entities.get(id).generation;
  // 超速意图（10 格/秒）→ 必须被钳到 ZOMBIE.speed
  zombies._applyIntent({ id, generation, vx: 10, vz: 0, mode: 'chasing' });
  const vel = zombies.get(id).velocity;
  assertClose(Math.hypot(vel[0], vel[2]), ZOMBIE.speed, 1e-9, '超速意图须钳到 ZOMBIE.speed');
  // 斜向超速同样钳制（保方向、改长度）
  zombies._applyIntent({ id, generation, vx: 8, vz: 8, mode: 'chasing' });
  const vel2 = zombies.get(id).velocity;
  assertClose(Math.hypot(vel2[0], vel2[2]), ZOMBIE.speed, 1e-9, '斜向超速同样钳制');
  assertClose(vel2[0], vel2[2], 1e-9, '钳制须保方向（两轴等分量）');
});

test('ZOMBIE config: 手臂与头部摆动幅度是冻结常量（渲染层不得写字面量）', () => {
  assertEqual(ZOMBIE_ARM_SWING, Math.PI / 12);
  assertEqual(ZOMBIE_HEAD_SWAY, Math.PI / 24);
  // 幅度必须小于腿的摆幅（原版：腿的跨步比手臂前后甩大）
  assertTrue(ZOMBIE_ARM_SWING < ZOMBIE_SWING, '臂摆幅须小于腿摆幅');
  assertTrue(ZOMBIE_HEAD_SWAY < ZOMBIE_ARM_SWING, '头摆幅须小于臂摆幅');
});

test('ZombieRenderer: 手臂与腿反相摆动、头部半频摆动', () => {
  const { zombies, renderer } = makeZombieFixture();
  const id = zombies.spawn([0.5, 1, .5], { source: 'test' });
  const slot = renderer.slotOf(id);
  renderer.sync(zombies, 0);
  // 静止：三者全部为 0
  assertEqual(renderer.armSwingOf(slot), 0, '静止时臂摆幅为 0');
  assertEqual(renderer.headSwayOf(slot), 0, '静止时头摆幅为 0');

  const dtMs = 500;
  zombies.setIntent(id, { vx: 0, vz: ZOMBIE.speed, mode: 'chasing' });
  renderer.sync(zombies, dtMs);
  const phase = (dtMs / 1000) * ZOMBIE_WALK_SPEED;
  const expectedLeg = Math.sin(phase) * ZOMBIE_SWING;
  const expectedArm = Math.sin(phase) * ZOMBIE_ARM_SWING;
  const expectedHead = Math.sin(phase * 0.5) * ZOMBIE_HEAD_SWAY;
  assertClose(renderer.legSwingOf(slot), expectedLeg, 1e-9, '腿摆幅');
  assertClose(renderer.armSwingOf(slot, 'leftArm'), expectedArm, 1e-9, '左臂摆幅');
  assertClose(renderer.armSwingOf(slot, 'rightArm'), -expectedArm, 1e-9, '右臂取反');
  assertClose(renderer.headSwayOf(slot), expectedHead, 1e-9, '头摆幅（半频）');

  // **矩阵级断言**（pose 内存值不是落点）：左臂/右臂的实例矩阵绕 X 的旋转必须反相，
  // 且各自 = 基准前伸角 + 摆幅。基准角来自 ZOMBIE_PART_DEFS，不与摆动混淆。
  const euler = new THREE.Euler();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const m = new THREE.Matrix4();
  const readRotX = (part) => {
    renderer.meshes[part].getMatrixAt(slot, m);
    m.decompose(p, q, s);
    euler.setFromQuaternion(q);
    return euler.x;
  };
  assertClose(readRotX('leftArm'), ZOMBIE_PART_DEFS.leftArm.rotation[0] + expectedArm, 1e-6, '左臂矩阵 = 基准角 + 摆幅');
  assertClose(readRotX('rightArm'), ZOMBIE_PART_DEFS.rightArm.rotation[0] - expectedArm, 1e-6, '右臂矩阵 = 基准角 − 摆幅');
  // 头：绕 Y 的摆动（摆幅远小于 π/2，Euler.y 反解安全）
  assertClose(readRotX('head'), 0, 1e-6, '头部不得绕 X 旋转');
  renderer.meshes.head.getMatrixAt(slot, m);
  m.decompose(p, q, s);
  euler.setFromQuaternion(q);
  assertClose(euler.y, expectedHead, 1e-6, '头部矩阵绕 Y = 头摆幅');
  assertClose(euler.z, 0, 1e-6, '头部不得绕 Z 旋转');

  // 静止 → 三者归零（不是冻结在上一个摆幅）
  zombies.setIntent(id, { vx: 0, vz: 0, mode: 'idle' });
  renderer.sync(zombies, dtMs + 500);
  assertEqual(renderer.legSwingOf(slot), 0);
  assertEqual(renderer.armSwingOf(slot), 0);
  assertEqual(renderer.headSwayOf(slot), 0);
});

test('ZombieRenderer: 皮肤 UV 的 v 方向 —— 世界顶部须采到皮肤矩形顶边（不是底边）', () => {
  // **这条钉的是「脸有没有倒过来」**（用户 2026-11-04 实玩报告：眼睛在下、嘴在上）。
  //
  // 两套坐标系方向天然相反，是本 bug 的根源：
  //   · `BoxGeometry` 的 `+Z` 面 `vdir = -1` ⇒ **世界顶部**的顶点 uv `v = 1`
  //   · 皮肤矩形按图片像素写（左上角原点）⇒ **矩形顶边**是 `v_img = v1`（小值）
  // 故映射必须把 `v = 1` 对到 `v1`、`v = 0` 对到 `v2`。
  //
  // 取样面用 head 的正脸（`pz`）：它的矩形 `[8,8,16,16]` 里有眼睛（v_img≈11）与嘴（v_img≈13），
  // 是唯一「上下有明确结构」的面 —— 其余面是随机噪点，倒过来看不出来。
  //
  // ⚠️ `DataTexture` 的 `flipY` 默认 **false**，而 `TextureLoader` 是 **true** ——
  // 两条路径的最终 uv 数值不同。故本用例显式覆盖两种取值，避免「单测走 false、
  // 真实页走 true」的口径分裂（那正是这个 bug 溜过单测的原因）。
  const [u1, v1, u2, v2] = ZOMBIE_SKIN_UV.head.pz;
  for (const flipY of [true, false]) {
    const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    tex.flipY = flipY;
    const { renderer } = makeZombieFixture({ skinTexture: tex });
    const geo = renderer.meshes.head.geometry;
    const uv = geo.getAttribute('uv');
    const pos = geo.getAttribute('position');

    // 找 +Z 面（顶点 16-19）里 position.y 最大的两个顶点 = 世界顶部
    const front = [0, 1, 2, 3].map((k) => 16 + k);
    const topY = Math.max(...front.map((i) => pos.getY(i)));
    const topVerts = front.filter((i) => Math.abs(pos.getY(i) - topY) < 1e-6);
    assertEqual(topVerts.length, 2, '前提：正面上有两个顶点的 y 相等且最高');
    // 背面前提：另外两个顶点的 y 必须更低（证明「最高」真的是顶部而不是全平）
    for (const i of front) {
      if (topVerts.includes(i)) continue;
      assertTrue(pos.getY(i) < topY - 1e-6, `顶点 ${i} 应低于顶部（前提：面有上下之分）`);
    }

    // 期望的 uv.y：世界顶部 → 皮肤矩形顶边（v_img = v1）
    // flipY=true 时纹理行序被翻转 ⇒ t = 1 - v_img/SIZE；false 时 t = v_img/SIZE
    const expected = flipY ? 1 - v1 / SKIN_SIZE : v1 / SKIN_SIZE;
    const wrongIfFlipped = flipY ? 1 - v2 / SKIN_SIZE : v2 / SKIN_SIZE;
    for (const i of topVerts) {
      const v = uv.getY(i);
      assertClose(v, expected, 1e-6,
        `flipY=${flipY}: 世界顶部顶点 ${i} 的 uv.v 须指向矩形顶边`
        + `（期望 ${expected}，若为 ${wrongIfFlipped} 则脸是倒的）`);
    }
  }
});

// ---------- v2.39：上台阶视觉缓动（物理仍瞬时，只有渲染层平滑） ----------
//
// ==================== 击退视觉补间（v2.81，用户缺陷：后退是瞬移）====================
//
// 用户 2026-11-08：「每次击杀都会让敌人向后移动一个短小的距离 …… 这个后退的逻辑是瞬移的，
// 不是缓动的，我要从现在的瞬移变成缓动」。
//
// 分工与上台阶 y 缓动完全一致：权威 `state.position` 瞬时（服务层 `knockback`），只滞后
// **渲染位置**。触发是显式事件（`noteKnockback`，由 `ZombieService` 的注入钩子上报实际位移），
// 不能用「比位置增量猜」 —— 丧尸 AI 每帧 0.02 格 vs 0.9 格击退，阈值两侧都会误伤。

test('ZombieRenderer: 击退 → 渲染位置从旧位置缓动追平（不是瞬移）', () => {
  const { zombies, renderer, ids } = makeAiFixture({ withRenderer: true });
  const id = zombies.spawn([10.5, 1, .5], { source: 'test' });
  const slot = renderer.slotOf(id);
  let nowMs = 0;
  renderer.sync(zombies, nowMs);
  // 走真实服务层（不手调 trigger）：`knockback` 改权威位置并经注入钩子通知渲染层
  const x0 = zombies.get(id).position[0];
  assertTrue(zombies.knockback(id, 0.9, 0), '前提：击退应成功');
  assertTrue(zombies.get(id).position[0] > x0 + 0.89, '前提：权威位置必须当帧移满 0.9');

  nowMs += 1000 / 120;
  renderer.sync(zombies, nowMs);
  const firstVis = renderer._poses[slot].position[0] - renderer.knockOffsetXOf(slot);
  // 首帧只吃掉一小段（指数衰减理论值 = 0.9 × (1 − e^(−12/120)) ≈ 8.6%）—— 瞬移的形态是
  // 首帧就到物理位置。
  assertTrue(firstVis > x0 && firstVis < x0 + 0.2,
    `击退首帧渲染 x=${firstVis.toFixed(4)}，应只走了不到 22% 的距离（旧位置 ${x0.toFixed(4)}）`);

  // 逐帧单调追平，收敛到物理位置（CUTOFF=0.004 ⇒ ~460ms；这里走 80 帧 @120Hz = 667ms）
  let prev = renderer.knockOffsetXOf(slot);
  for (let i = 0; i < 80; i++) {
    nowMs += 1000 / 120;
    renderer.sync(zombies, nowMs);
    const cur = renderer.knockOffsetXOf(slot);
    assertTrue(cur <= prev + 1e-12, `偏移应单调减小（ease-out），${prev} → ${cur}`);
    prev = cur;
  }
  assertTrue(prev < 0.02,
    `约 667ms 后偏移应收敛（实际 ${prev}）；完全归零靠 CUTOFF=0.004`);
  // ②b **矩阵级断言**：`poseOf` 读的是内部量，「缓动真的发布了」的落点是实例矩阵。
  // 只断言内部量时，注入「`_writeSlot` 不减去 knock.offset」（= 等价回退到瞬移）仍全绿。
  const mtx = new THREE.Matrix4();
  renderer.meshes.body.getMatrixAt(slot, mtx);
  assertTrue(Math.abs(mtx.elements[12] - zombies.get(id).position[0]) < 0.02,
    `偏移收敛后实例矩阵 x 应贴近物理 x（矩阵 ${mtx.elements[12]} / 物理 ${zombies.get(id).position[0]}）`);
});

test('ZombieRenderer: 击退当帧实例矩阵仍在旧位置（断言落在发布路径上）', () => {
  const { zombies, renderer } = makeAiFixture({ withRenderer: true });
  const id = zombies.spawn([10.5, 1, .5], { source: 'test' });
  const slot = renderer.slotOf(id);
  renderer.sync(zombies, 0);
  const x0 = zombies.get(id).position[0];
  zombies.knockback(id, 0.9, 0);
  renderer.sync(zombies, 1000 / 120);
  const mtx = new THREE.Matrix4();
  renderer.meshes.body.getMatrixAt(slot, mtx);
  assertTrue(mtx.elements[12] > x0 && mtx.elements[12] < x0 + 0.2,
    `击退首帧实例矩阵 x=${mtx.elements[12].toFixed(3)}，应只走了不到 22% 的距离（旧位置 ${x0.toFixed(3)}）`);
  assertTrue(mtx.elements[12] < zombies.get(id).position[0] - 0.5, '矩阵必须滞后于物理位置');
});

// 用户报告「丧尸上台阶是瞬移，下台阶有下落动画」。实测根因：`tryStepUp` 把脚底**一帧**
// 抬到上一格整数面（物理必须瞬时，AABB 状态要精确），而渲染层把 `state.position` 原样发布成
// 实例平移 → 画面上就是瞬移。下台阶没这问题，因为重力天然一帧一帧下落（实测 19 帧 / 283ms）。
//
// 修法 = **只在渲染层**缓动整体 y（复用玩家相机的 `StepLift`）。物理/射线/存档一律不动。

test('ZombieRenderer: 上台阶整体 y 缓动（非瞬移），~200ms 内追平物理且单调上升', () => {
  // **走真实物理路径**（不是手工调 trigger）：`entities.update` 驱动 step-up，`renderer.sync`
  // 消费新 y —— 这正是游戏里的两行。只测 `renderer._poses[slot].lift.trigger()` 会漏掉
  // 「sync 没接线」这个真实失效形态（M6/M7 的「单测测不到没接线」同类）。
  const { zombies, renderer, entities, world, ids } = makeAiFixture({ withRenderer: true });
  // x ≥ 12 做成一整段高台（顶面 y=2）—— 孤立一格会让丧尸登上后又掉回（实测踩坑，见物理用例）
  for (let x = 12; x < 60; x++) world.setBlock(x, 1, 0, ids.stone);
  const id = zombies.spawn([10.5, 1, .5], { source: 'test' });
  const slot = renderer.slotOf(id);
  zombies.setIntent(id, { vx: ZOMBIE.speed, vz: 0, mode: 'chasing' });

  let nowMs = 0;
  renderer.sync(zombies, nowMs);
  const y0 = zombies.get(id).position[1];
  // 逐帧推进（1/120 渲染帧，与游戏 120Hz 一致），直到物理 y 抬升
  let stepFrame = -1;
  for (let i = 0; i < 600 && stepFrame < 0; i++) {
    entities.update(1 / 120, { world });
    nowMs += 1000 / 120;
    renderer.sync(zombies, nowMs);
    if (zombies.get(id).position[1] > y0 + 0.5) stepFrame = i;
  }
  assertTrue(stepFrame > 0, '前提：丧尸须在窗口内登上台阶');

  const physY = zombies.get(id).position[1];
  const renderY = renderer.renderYOf(slot);
  // ① 抬升那一帧：渲染 y 必须**低于**物理 y（滞后），否则就是瞬移（本次修复的落点）
  assertTrue(renderY < physY - 0.05,
    `抬升帧渲染 y 须滞后于物理 y（渲染 ${renderY} / 物理 ${physY}）`);
  // ② 不得反向越界：渲染 y 必须仍在旧高度之上（起点 = 旧物理 y）
  assertTrue(renderY >= y0 - 1e-6, `渲染 y 不得落回旧高度以下（${renderY} < ${y0}）`);
  // ②b **矩阵级断言**：`renderYOf` 读的是 pose 内存值，而「缓动真的发布了」的落点是
  // 实例矩阵的平移分量。只断言内部量时，注入「`_writeSlot` 不加上 lift.offset」（= 等价回退
  // 到瞬移）仍然全绿 —— 断言没落在被测路径（testing-policy §2.7，v1.48 玩家晃动同类踩坑）。
  // 取六部件任意一个的矩阵：父级只有 yaw 旋转 + 平移，`head` 的 y 还会叠加本地轴心偏移，
  // 故与 `body`（无 local rotation）的差值不恒定 —— 直接比对「矩阵 y − 同帧理论值」不可行。
  // 改为比对**相对旧物理 y 的偏移量**：两帧的部件本地偏移相同，差值只能来自 lift。
  const matrixY = (m) => { renderer.meshes.body.getMatrixAt(slot, m); return m.elements[13]; };
  const mtx = new THREE.Matrix4();
  const matrixAtStep = matrixY(mtx);
  // 下一帧把 lift 清零后重写矩阵，得到「无 lift」的基准
  renderer._poses[slot].lift.offset = 0;
  renderer._writeSlot(slot, renderer._poses[slot]);
  const matrixNoLift = matrixY(mtx);
  assertTrue(matrixAtStep < matrixNoLift - 0.05,
    `实例矩阵的 y 必须含 lift 偏移（含 lift ${matrixAtStep} 须低于无 lift ${matrixNoLift}）`);

  // ③ 收敛：与玩家相机**同一口径**（`StepLift` 是一阶低通，`DECAY_RATE=12`）：
  //    ~240ms 后残差 ≤ 15%（视觉上已追平 85%），完全归零靠 `CUTOFF=0.004`（~460ms）。
  //    ⚠️ **不得断言「200ms 内数值归零」**：那要 575ms，与玩家上台阶的相机手感不一致。
  const monotone = [];
  let visuallyCaught = -1;
  for (let i = 0; i < 29; i++) { // 29 帧 @120Hz ≈ 242ms
    entities.update(1 / 120, { world });
    nowMs += 1000 / 120;
    renderer.sync(zombies, nowMs);
    const y = renderer.renderYOf(slot);
    monotone.push(y);
    if (visuallyCaught < 0 && Math.abs(y - zombies.get(id).position[1]) <= 0.15) visuallyCaught = i;
  }
  assertTrue(visuallyCaught >= 0,
    `须在 ~240ms（29 帧）内把残差收到 15% 以内，实测未达`);
  // ④ 单调上升（缓动不得抖动 —— 抖动的观感是「卡顿」而非「迈上去」）
  for (let i = 1; i < monotone.length; i++) {
    assertTrue(monotone[i] >= monotone[i - 1] - 1e-6,
      `渲染 y 须单调上升（第 ${i} 帧 ${monotone[i]} < 第 ${i - 1} 帧 ${monotone[i - 1]}）`);
  }
  // ⑤ 最终归零（不是永远留一段残差）
  for (let i = 0; i < 60; i++) {
    entities.update(1 / 120, { world });
    nowMs += 1000 / 120;
    renderer.sync(zombies, nowMs);
  }
  assertEqual(renderer.liftOffsetOf(slot), 0, '~750ms 后缓动须归零（CUTOFF 收敛）');
  assertClose(renderer.renderYOf(slot), zombies.get(id).position[1], 1e-9,
    '归零后渲染 y 与物理 y 逐位相等');
  // ⑤ 物理不受影响：缓动只在渲染层，权威 state 的 y 仍是整数格面
  assertEqual(zombies.get(id).position[1], 2, '物理 y 须仍是整数台阶面（缓动不得改物理）');
});

test('ZombieRenderer: 下台阶立即跟随物理（缓动必须清零，不得拖成悬空）', () => {
  // 下台阶的「动画」本来就来自重力（实测 19 帧 / 283ms），渲染层必须**原样跟随**。
  // 若缓动只在上升步触发、下降步不清零，那么刚爬完台阶立刻走下坡时会残留滞后 → 模型陷进台阶下方。
  const { zombies, renderer, entities } = makeZombieFixture();
  const id = zombies.spawn([0.5, 1, .5], { source: 'test' });
  const slot = renderer.slotOf(id);
  renderer.sync(zombies, 0);
  // 先欠下一点缓动（模拟刚爬完台阶）
  zombies.setIntent(id, { vx: 0, vz: 0, mode: 'idle' });
  entities.applyAsyncPose({ id, generation: entities.get(id).generation, position: [0.5, 2, .5] });
  renderer.sync(zombies, 100);
  assertTrue(renderer.liftOffsetOf(slot) !== 0, '前提：上升后须留有滞后');
  // 再下降一格：偏移必须立即清零
  entities.applyAsyncPose({ id, generation: entities.get(id).generation, position: [0.5, 1, .5] });
  renderer.sync(zombies, 200);
  assertEqual(renderer.liftOffsetOf(slot), 0, '下落须立即清零缓动（缓动只服务上台阶）');
  assertClose(renderer.renderYOf(slot), 1, 1e-9, '下落帧渲染 y 直接等于物理 y');
});

test('ZombieRenderer: 首帧/新 slot 不做缓动（不出现「从地底升上来」）', () => {
  // `acquireSlot` 的 pose.position 初值是 [0,0,0]，若首帧把「physicalY − 0」当成抬升量，
  // 每只丧尸出生时都会从 y=0 升到自己脚下 —— 这个坑在实现里是**必然**踩到的。
  // 用合法出生点（脚下 y=0 是 stone），y=1 与初值 0 差整 1 格 —— 缺陷态下 renderY 会读成 0。
  const { zombies, renderer } = makeZombieFixture();
  const id = zombies.spawn([0.5, 1, .5], { source: 'test' });
  assertTrue(id !== null, '前提：出生须成功（脚下 y=0 是 stone）');
  const slot = renderer.slotOf(id);
  renderer.sync(zombies, 0);
  assertEqual(renderer.liftOffsetOf(slot), 0, '首帧 lift offset 须为 0');
  assertClose(renderer.renderYOf(slot), 1, 1e-9, '首帧渲染 y 直接等于物理 y（不得从 0 升上来）');
});

test('ZombieRenderer: 多只丧尸的 lift 各自独立（互不串扰）', () => {
  const { zombies, renderer, entities } = makeZombieFixture();
  const a = zombies.spawn([0.5, 1, .5], { source: 'test' });
  const b = zombies.spawn([2.5, 1, .5], { source: 'test' });
  const slotA = renderer.slotOf(a);
  const slotB = renderer.slotOf(b);
  renderer.sync(zombies, 0);
  entities.applyAsyncPose({ id: a, generation: entities.get(a).generation, position: [0.5, 2, .5] });
  renderer.sync(zombies, 100);
  assertTrue(renderer.liftOffsetOf(slotA) !== 0, 'A 爬台阶须有滞后');
  assertEqual(renderer.liftOffsetOf(slotB), 0, 'B 未动，lift offset 须恒 0');
  assertClose(renderer.renderYOf(slotB), 1, 1e-9, 'B 渲染 y 恒等于物理 y');
});

test('ZombieRenderer: slot 归还后重分配不继承上一只的缓动', () => {
  const { zombies, renderer, entities } = makeZombieFixture();
  const a = zombies.spawn([0.5, 1, .5], { source: 'test' });
  const slot = renderer.slotOf(a);
  renderer.sync(zombies, 0);
  entities.applyAsyncPose({ id: a, generation: entities.get(a).generation, position: [0.5, 2, .5] });
  renderer.sync(zombies, 100);
  assertTrue(renderer.liftOffsetOf(slot) !== 0, '前提：旧实例留有滞后');
  zombies.damage(a, 999, 200); // 死亡 → 归还 slot
  assertNull(renderer.slotOf(a));
  // 新实例复用同一 slot（低位优先），且第一次 sync 就有正确的 y
  const b = zombies.spawn([4.5, 1, .5], { source: 'test' });
  assertEqual(renderer.slotOf(b), slot, '前提：slot 被复用');
  renderer.sync(zombies, 300);
  assertEqual(renderer.liftOffsetOf(slot), 0, '新实例不得继承上一只的 lift offset');
  assertClose(renderer.renderYOf(slot), 1, 1e-9, '新实例渲染 y 直接等于物理 y');
});

// ---------- 局部避障（zombie-navigation，v2.40） ----------
//
// 覆盖规格 §6.1 的 a~i。**全部只调纯函数**（接线由 Task 2 的 j~l 覆盖）。
// fixture：`makeAiFixture()` 的平地 —— cx 0..7 / cz 0（x ∈ [0,128)、z ∈ [0,16)），y=0 全 stone、
// 脚底 y=1。墙用 `world.setBlock(x, y, z, ids.stone)` 现造。
//
// ⚠️ **期望的偏角是按几何算出来的，不是拍脑袋的常数**（实施时发现计划初稿写「正前 1 格墙 → 22.5°」
// 在几何上不可能）：丧尸半宽 0.3、探针 1.2 格，要让 AABB 横向让开紧邻的那一列需要
// Δz > 0.3 + 0.5 ⇒ sinθ > 0.8/1.2 ⇒ θ > 41.8°，所以「正前方一列墙」的最小可通偏角是 **45°**。
// 22.5° 只在「0° 的 AABB 横向跨两列、22.5° 恰好只压一列」的斜擦场景才是答案（用例 d 就是这个夹具）。

test('避障 a) 无障碍 → 输出逐位等于输入（平地零回归）', () => {
  const { world } = makeAiFixture();
  const pos = [10.5, 1, 2.5];
  const out = steerIntent({ world, position: pos, vx: ZOMBIE.speed, vz: 0 });
  // **逐位相等**（Object.is）而不是 close：归一化重建会让 1.2 变成 1.1999999999999997，
  // 而「平地也被打偏」这个缺陷只有逐位判定才抓得到（观感是丧尸走路开始画龙）。
  assertTrue(Object.is(out.vx, ZOMBIE.speed), `vx 须逐位等于 ${ZOMBIE.speed}，实得 ${out.vx}`);
  assertTrue(Object.is(out.vz, 0), `vz 须逐位等于 0，实得 ${out.vz}`);
  assertFalse(out.blocked, '无障碍不得判 blocked');
  // 斜向同样逐位回归（三条路径共用同一个"0° 原样返回"分支，但仍要覆盖斜向归一化）
  const out2 = steerIntent({ world, position: pos, vx: 0.6, vz: -0.8 });
  assertTrue(Object.is(out2.vx, 0.6) && Object.is(out2.vz, -0.8), '斜向也须逐位回归');
  // ⚠️ **必须覆盖“归一化往返不精确”的输入**（负向验证发现的盲区）：像 (1.2, 0)、(0.6,-0.8)
  // 这类 len 恰为整数或短小数的输入，`vx/len*len === vx` 逐位成立 → 把实现改成在 0° 分支重建
  // 速度向量时它们仍然全绿（实测注入后 1283/1283 全过）。下面两个是实测能产生 1 ULP 误差的值，
  // 它们才是“平地也被打偏”的真正判据。
  for (const [vx, vz] of [[-0.720745, 1.028745], [1.05292, -0.870183]]) {
    const o = steerIntent({ world, position: pos, vx, vz });
    assertTrue(Object.is(o.vx, vx) && Object.is(o.vz, vz),
      `非精确往返输入 (${vx}, ${vz}) 须逐位原样返回，实得 (${o.vx}, ${o.vz})`);
  }
});

test('避障 b) 正前 1 列墙 → 最小可通偏角 +45°（22.5° 仍压墙）', () => {
  const { world, ids } = makeAiFixture();
  // 丧尸在 z=2.5 中线；墙在 (11, y=1..2, z=2) —— 正好挡住 +X 直线
  world.setBlock(11, 1, 2, ids.stone);
  world.setBlock(11, 2, 2, ids.stone);
  const out = steerIntent({ world, position: [10.5, 1, 2.5], vx: ZOMBIE.speed, vz: 0 });
  assertFalse(out.blocked, '端头留空，不该 blocked');
  const theta = ZOMBIE_STEERING.anglesDeg[1] * Math.PI / 180; // 45°
  assertClose(out.vx, Math.cos(theta) * ZOMBIE.speed, 1e-12, 'vx = cos45 × speed（+侧优先）');
  assertClose(out.vz, Math.sin(theta) * ZOMBIE.speed, 1e-12, 'vz = sin45 × speed');
});

test('避障 c) +侧被墙封住 → 走 −侧（−45°），双向都被试过', () => {
  const { world, ids } = makeAiFixture();
  // z=2 与 z=3 都立墙：+45/+67.5/+90 全部压墙，只有 −45（z=−1 那一列… 实为 z=1）能过
  for (const z of [2, 3]) {
    world.setBlock(11, 1, z, ids.stone);
    world.setBlock(11, 2, z, ids.stone);
  }
  const out = steerIntent({ world, position: [10.5, 1, 2.5], vx: ZOMBIE.speed, vz: 0 });
  assertFalse(out.blocked);
  const theta = ZOMBIE_STEERING.anglesDeg[1] * Math.PI / 180; // 45°
  assertClose(out.vx, Math.cos(theta) * ZOMBIE.speed, 1e-12, 'vx');
  assertClose(out.vz, -Math.sin(theta) * ZOMBIE.speed, 1e-12, 'vz 为负（−侧）');
});

test('避障 d) 斜擦场景 → 22.5° 才是最小可通偏角（细档真的会被用到）', () => {
  const { world, ids } = makeAiFixture();
  // 丧尸在 z=2.9：0° 探针的 AABB 横向跨 z=2..3（压到 z=2 的墙）；
  // 而 +22.5° 把落点推到 z≈3.36，AABB 只压 z=3（空气）→ 更小的偏角就够。
  world.setBlock(11, 1, 2, ids.stone);
  world.setBlock(11, 2, 2, ids.stone);
  const out = steerIntent({ world, position: [10.5, 1, 2.9], vx: ZOMBIE.speed, vz: 0 });
  assertFalse(out.blocked);
  const theta = ZOMBIE_STEERING.anglesDeg[0] * Math.PI / 180; // 22.5°
  assertClose(out.vx, Math.cos(theta) * ZOMBIE.speed, 1e-12, 'vx');
  assertClose(out.vz, Math.sin(theta) * ZOMBIE.speed, 1e-12, 'vz');
  // 与 b（45°）区分：这一条证明阶梯从细到粗按序试，不是直接跳 45°
  assertTrue(Math.abs(out.vz) < Math.sin(ZOMBIE_STEERING.anglesDeg[1] * Math.PI / 180),
    '22.5° 的横向分量必须小于 45° 的');
});

test('避障 e) 一格台阶不算障碍；补成 2 格高才偏转', () => {
  const { world, ids } = makeAiFixture();
  const pos = [10.5, 1, 2.5];
  world.setBlock(11, 1, 2, ids.stone); // 只有 1 格高 = 台阶
  const step = steerIntent({ world, position: pos, vx: ZOMBIE.speed, vz: 0 });
  assertFalse(step.blocked, '台阶不得判 blocked');
  assertTrue(Object.is(step.vx, ZOMBIE.speed) && Object.is(step.vz, 0),
    '一格台阶须原样直行（交给物理 step-up）');
  // 补第二格 → 1.8 高的丧尸过不去 → 必须偏转
  world.setBlock(11, 2, 2, ids.stone);
  const wall = steerIntent({ world, position: pos, vx: ZOMBIE.speed, vz: 0 });
  assertFalse(wall.blocked);
  assertTrue(Math.abs(wall.vz) > 0.1, `两格墙须偏转，实得 vz=${wall.vz}`);
});

test('避障 f) 四面围死 → blocked 且零速度', () => {
  const { world, ids } = makeAiFixture();
  // 把丧尸周围整片填成实心：探针 9 个方向全部撞墙（比"按候选算环"简单且无遗漏）。
  // ⚠️ 探针只回答「目标点能不能站」，不判「当前是否已被埋」—— 后者归物理层，不在本用例范围。
  for (let x = 8; x <= 14; x++) {
    for (let y = 1; y <= 8; y++) {
      for (let z = 6; z <= 12; z++) world.setBlock(x, y, z, ids.stone);
    }
  }
  const out = steerIntent({ world, position: [10.5, 4, 8.5], vx: ZOMBIE.speed, vz: 0 });
  assertTrue(out.blocked, '四面实心须判 blocked');
  assertEqual(out.vx, 0, 'blocked 时 vx 须为 0');
  assertEqual(out.vz, 0, 'blocked 时 vz 须为 0');
});

test('避障 g) 只换方向、不改速度长度（9 个方向逐一）', () => {
  const { world } = makeAiFixture();
  const pos = [10.5, 1, 2.5];
  for (let k = 0; k < 9; k++) {
    const a = (k * 40) * Math.PI / 180;
    const vx = Math.cos(a) * ZOMBIE.speed, vz = Math.sin(a) * ZOMBIE.speed;
    const out = steerIntent({ world, position: pos, vx, vz });
    assertClose(Math.hypot(out.vx, out.vz), Math.hypot(vx, vz), 1e-12, `方向 ${k * 40}° 的长度守恒`);
  }
});

test('避障 h) 净空 1.8 的走廊不判 blocked（脚底 y=1.0 与"顶面恰贴边界"的 y=1.2 都要通）', () => {
  const { world, ids } = makeAiFixture();
  // 整层 y=3 做顶栅：净空恰 1.8（y=1..2）
  for (let x = 0; x < 128; x++) for (let z = 0; z < 16; z++) world.setBlock(x, 3, z, ids.stone);
  for (const y of [1, 1.2]) {
    const out = steerIntent({ world, position: [10.5, y, 2.5], vx: ZOMBIE.speed, vz: 0 });
    assertFalse(out.blocked, `脚底 y=${y} 的走廊不得判 blocked（AABB 采样须带 PHYS_EPSILON）`);
    assertTrue(Object.is(out.vx, ZOMBIE.speed) && Object.is(out.vz, 0), `y=${y} 须原样直行`);
  }
});

test('避障 i) 零速/亚阈值意图 → 原样返回、不判 blocked', () => {
  const { world, ids } = makeAiFixture();
  world.setBlock(11, 1, 2, ids.stone);
  world.setBlock(11, 2, 2, ids.stone);
  const pos = [10.5, 1, 2.5];
  for (const [vx, vz] of [[0, 0], [1e-4, 0], [0, -1e-4]]) {
    const out = steerIntent({ world, position: pos, vx, vz });
    assertFalse(out.blocked, `意图 (${vx},${vz}) 不得判 blocked`);
    assertTrue(Object.is(out.vx, vx) && Object.is(out.vz, vz), `意图 (${vx},${vz}) 须逐位原样返回`);
  }
});

test('避障: zombieCollidesAt 与 zombieStepUpY 是本仓的单一权威（物理与探针共用）', () => {
  const { world, ids } = makeAiFixture();
  // 平地：脚底 y=1 不撞、y=0（嵌进地面）撞
  assertFalse(zombieCollidesAt(world, 10.5, 1, 2.5), '站在地面上不撞');
  assertTrue(zombieCollidesAt(world, 10.5, 0, 2.5), '嵌进地面须撞');
  // 一格台阶：y=1 那一层撞（台阶本体）、y=2 不撞（台阶上方）
  world.setBlock(11, 1, 2, ids.stone);
  assertTrue(zombieCollidesAt(world, 11.5, 1, 2.5), '台阶那一层须撞');
  assertFalse(zombieCollidesAt(world, 11.5, 2, 2.5), '台阶上方不撞');
  // **`ZOMBIE_MAX_STEP` 是「一格」**：`zombieStepUpY` 在整数脚底上恰抬 1 格（不多不少），
  // 且抬升量与常量一致 —— 派生断言（不在测试里再写一份 1.0）
  assertEqual(round6(zombieStepUpY(1)), round6(1 + ZOMBIE_MAX_STEP), '整数脚底恰抬 ZOMBIE_MAX_STEP');
  assertTrue(zombieStepUpY(1.2) - 1.2 <= ZOMBIE_MAX_STEP, '小数脚底的抬升量不超过上限');
  assertEqual(zombieStepUpY(1.99), 3, '1.99 被 +0.01 推到 2.0 → 抬到 3（即“抬一格”的语义，不会只提到 2）');
  assertEqual(zombieStepUpY(1.98), 2, '1.98 的 +0.01 仍是 1.99 → 抬到 2');
  // world 缺失/畸形时返回 false（探针不抛错 —— 它在 AI 回包回调里跑，抛错会中断整条回包）
  assertFalse(zombieCollidesAt(null, 0, 0, 0), '无世界上下文时按不碰撞处理');
});

// ---------- 局部避障的接线（Task 2：j~l） ----------
//
// 纯函数用例（a~i）只证明「探针本身对」；这一组证明「它真的接在 AI 回包路径上」——
// M6/M7 的教训：只测纯函数会漏掉「没接线」，而那在方块与位置上完全看不出来。

test('避障 j) _applyIntent 写入的是偏转后的速度（接线，不是纯函数）', () => {
  // ⚠️ v2.47 起决策来自本地导航，**离线 RPC 回包路径已删除** ⇒ 原先用 `pool.replies`
  // 注入「纯 +X 速度」的方式失效。这里直接调 `_applyIntent`（它就是偏转发生的唯一位置），
  // 测的仍然是同一件事：**写进 state 的速度必须是偏转后的**，而不是原始意图。
  const { zombies, world, ids } = makeAiFixture();
  // 2 格高墙挡住 +X 直线（丧尸半宽 0.3、墙在 x=11）
  world.setBlock(11, 1, 0, ids.stone);
  world.setBlock(11, 2, 0, ids.stone);
  const id = zombies.spawn([10.5, 1, 0.5], { source: 'test' });
  const generation = zombies.entities.get(id).generation;
  zombies._applyIntent({ id, generation, vx: ZOMBIE.speed, vz: 0, mode: 'chasing' });
  const st = zombies.get(id);
  // 回包给的是纯 +X，但直线被墙挡住 → 写入 state 的速度必须已被偏转
  assertTrue(Math.abs(st.velocity[2]) > 0.1, `速度须被偏转（vz=${st.velocity[2]}）`);
  assertEqual(st.mode, 'chasing', '未被围死 → mode 仍是 chasing');
  // 速度长度仍等于 ZOMBIE.speed（转向只换方向、不改长度）
  assertClose(Math.hypot(st.velocity[0], st.velocity[2]), ZOMBIE.speed, 1e-9, '长度守恒');
});

test('避障 k) mode "blocked" 不被静默规范化成 idle（createState 与 setIntent 两处都要）', () => {
  const { zombies } = makeAiFixture();
  const id = zombies.spawn([10.5, 1, 0.5], { source: 'test' });
  zombies.setIntent(id, { vx: 0, vz: 0, mode: 'blocked' });
  assertEqual(zombies.get(id).mode, 'blocked', 'setIntent 路径须保留 blocked');
  // damage 走 createState 重建 state —— 另一份三元表达式的消费路径
  zombies.damage(id, 1, 0);
  assertEqual(zombies.get(id).mode, 'blocked', 'createState 路径也须保留 blocked');
});

test('避障 l) 四面围死 → 原地站住；拆墙后下一周期恢复 chasing 并移动', async () => {
  const { zombies, entities, pool, playerPosition, world, ids } = makeAiFixture();
  // 把丧尸周围整片填实（探针 9 个方向全部撞墙）
  for (let x = 8; x <= 14; x++) {
    for (let y = 1; y <= 8; y++) for (let z = 6; z <= 12; z++) world.setBlock(x, y, z, ids.stone);
  }
  // 先挖出丧尸自己那一格（否则 spawn 的脚/头格 air 门控会拒绝）
  world.setBlock(10, 4, 8, 0);
  world.setBlock(10, 5, 8, 0);
  world.setBlock(10, 3, 8, ids.stone); // 脚下仍有支撑
  const id = zombies.spawn([10.5, 4, 8.5], { source: 'test' });
  assertTrue(id !== null, '前提：围死格内仍能生成（脚/头 air + 脚下 solid）');
  const generation = zombies.entities.get(id).generation;
  const x0 = zombies.get(id).position[0];
  pool.replies.push({ updates: [{ id, generation, vx: ZOMBIE.speed, vz: 0, mode: 'chasing' }] });
  zombies.update(ZOMBIE.aiPeriod, { playerPosition, nowMs: 1000 });
  await Promise.resolve(); await Promise.resolve();
  assertEqual(zombies.get(id).mode, 'blocked', '四面实心 → blocked');
  assertEqual(zombies.get(id).velocity[0], 0, 'blocked → 水平速度归零');
  for (let i = 0; i < 120; i++) entities.update(1 / 60, { world });
  assertClose(zombies.get(id).position[0], x0, 0.05, '围死 2 秒内不得移动');

  // 拆出一条**通道**（不是只拆一行）：v2.47 起决策来自本地导航（8 邻接 BFS +
  // `steerIntent` 的 1.2 格前探）。只挖 z=8 一行时，斜向候选（东南/东北）的前探落点
  // 仍压在石头上，`steerIntent` 会正确地判 blocked —— 那不是缺陷，是 fixture 的
  // 「一维通道」假设已经不成立（旧实现只有 8 个角度探针、没有 BFS）。
  // 这里挖 2 格宽 × 2 格高的通道，让 8 邻接的候选都有安身之处。
  for (let x = 11; x <= 15; x++) {
    for (let y = 4; y <= 5; y++) {
      for (let z = 8; z <= 9; z++) world.setBlock(x, y, z, 0);
    }
  }
  zombies.update(ZOMBIE.aiPeriod, { playerPosition, nowMs: 1050 });
  assertEqual(zombies.get(id).mode, 'chasing', '拆墙后须恢复 chasing（导航无缓存阻塞记忆）');
  const xBefore = zombies.get(id).position[0];
  for (let i = 0; i < 120; i++) entities.update(1 / 60, { world });
  assertTrue(zombies.get(id).position[0] > xBefore + 0.1, `拆墙后须继续前进（x=${zombies.get(id).position[0]}）`);
});

// ==================== v3.11：行为层的 mode 白名单 ====================
//
// ⚠️ **两条路径都要测**：`setIntent`（AI 意图写入）与 `createState`（damage 重建 state）。
// v2.40 的教训：`normalizeMode` 曾是两处各写一份三元表达式，漏改一处的形态是
// 「速度与位置全对、只有 mode 错」—— 任何只看「它没动」的断言都抓不到。

test('v3.11 行为层 mode 白名单: hesitating/backing/wandering 不被规范化成 idle', () => {
  const { zombies } = makeAiFixture();
  const id = zombies.spawn([10.5, 1, .5], { source: 'test' });
  for (const mode of ['hesitating', 'backing', 'wandering']) {
    zombies.setIntent(id, { vx: 0, vz: 0, mode });
    assertEqual(zombies.get(id).mode, mode, `setIntent 路径须保留 ${mode}`);
    // damage 走 createState 重建 state —— 另一条消费 normalizeMode 的路径
    zombies.damage(id, 1, 0);
    assertEqual(zombies.get(id).mode, mode, `createState 路径也须保留 ${mode}`);
  }
});
