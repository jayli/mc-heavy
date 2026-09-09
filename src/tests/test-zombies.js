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
  ZOMBIE_SEPARATION,
} from '../entities/zombies/zombie-config.js';
import {
  ZombieService, zombieDefinition, separationForce, computeAiUpdates,
} from '../entities/zombies/zombie-system.js';
import {
  ZombieRenderer, ZOMBIE_PARTS, ZOMBIE_PART_DEFS, HEAD_FRONT_VERTICES,
} from '../render/zombie-renderer.js';

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
 * @param {{maxActive?: number, withRenderer?: boolean, headTexture?: THREE.Texture|null}} [opts]
 *   `headTexture`：传一个 dummy 纹理即走「head 马赛克纹理 + UV 分区」路径；默认 null =
 *   纯色退回路径（既有测试不受影响，向后兼容）。
 */
export function makeZombieFixture({ maxActive = ZOMBIE.maxActive, withRenderer = true, headTexture = null } = {}) {
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
  const renderer = withRenderer ? new ZombieRenderer({ scene, maxActive: ZOMBIE.maxActive, headTexture }) : null;

  // 渲染 slot 由 service 的生命周期钩子驱动（service 是同构层，不得 import render —— 注入解耦，
  // 与 EntityManager.onDespawn 同一手法）。**slot 单一权威在 service**（它管 20 上限），
  // renderer 只接收 service 分配的 slot，不自建第二份 slot 池（红线 1）。
  const zombies = new ZombieService({
    entities, world, maxActive,
    onSpawn: renderer ? (id, slot) => renderer.acquireSlot(id, slot) : null,
    onDespawn: renderer ? (id) => renderer.releaseSlot(id) : null,
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

test('ZombieRenderer: 六部件尺寸/偏移/旋转/配色对齐 mc-lite（防数值漂移）', () => {
  // 逐项钉住实测自 mc-lite ZombieInstancedRenderer.js:28-82 的数值。这些是**视觉数据**
  // （Tier 2 口径：改错了立刻可见，但静默改错没人会发现），故用门禁断言而非目视。
  // head.color 现在是 **0xffffff**（白底乘纹理色，mc-lite 同口径）—— 头部马赛克纹理已接线
  // （M6 遗留 TODO 补齐），真实颜色由纹理给。曾一度用视觉色 0x406b30（无纹理时的退回），
  // 那个值现在只在 `_baseColorOf` 的「无纹理退回路径」里，不再是定义色（见下方专测）。
  assertDeepEqual(ZOMBIE_PART_DEFS.head.size, [0.6, 0.6, 0.6]);
  assertDeepEqual(ZOMBIE_PART_DEFS.head.offset, [0, 1.8, 0]);
  assertEqual(ZOMBIE_PART_DEFS.head.color, 0xffffff);
  assertDeepEqual(ZOMBIE_PART_DEFS.body.size, [0.55, 0.63, 0.45]);
  assertDeepEqual(ZOMBIE_PART_DEFS.body.offset, [0, 1.15, 0]);
  assertEqual(ZOMBIE_PART_DEFS.body.color, 0x037c7c);
  assertDeepEqual(ZOMBIE_PART_DEFS.leftArm.size, [0.23, 0.8, 0.23]);
  assertDeepEqual(ZOMBIE_PART_DEFS.leftArm.offset, [-0.43, 1.3, 0.3]);
  assertEqual(ZOMBIE_PART_DEFS.leftArm.rotation[0], -Math.PI / 2.4);
  assertDeepEqual(ZOMBIE_PART_DEFS.rightArm.offset, [0.43, 1.3, 0.3]);
  assertEqual(ZOMBIE_PART_DEFS.rightArm.rotation[0], -Math.PI / 2.7);
  assertDeepEqual(ZOMBIE_PART_DEFS.leftLeg.size, [0.26, 1.0, 0.26]);
  assertDeepEqual(ZOMBIE_PART_DEFS.leftLeg.offset, [-0.14, 0.9, 0]);
  assertEqual(ZOMBIE_PART_DEFS.leftLeg.color, 0x322b71);
  assertDeepEqual(ZOMBIE_PART_DEFS.rightLeg.offset, [0.14, 0.9, 0]);
  // 腿的 rotation 为 null：摆幅由步态运行时给，不是静态旋转
  assertNull(ZOMBIE_PART_DEFS.leftLeg.rotation);
  assertNull(ZOMBIE_PART_DEFS.rightLeg.rotation);
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

test('ZombieRenderer: head UV 分区 —— 正面采纹理右半（有眼睛）、其余五面采左半', () => {
  // dummy 纹理（DataTexture，无需 DOM/canvas）：只为触发「有 map」路径，内容不重要
  const dummy = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const { renderer } = makeZombieFixture({ headTexture: dummy });
  const geo = renderer.meshes.head.geometry;
  const uv = geo.getAttribute('uv');
  const pos = geo.getAttribute('position'); // 用 count 遍历全部顶点（法线判据见下）

  // ① **前提断言：HEAD_FRONT_VERTICES 确实是「正面（pz）」的顶点**。
  //    必须独立于被测常量验证 —— 否则把常量改成错误索引（如 [0,1,2,3] = 右面）时，
  //    下面的 UV 断言**仍会全绿**（它读的就是那个被改错的常量）→ 恒真陷阱
  //    （testing-policy §2.5「测试输入从被测常量派生」）。
  //    判据用**法线**而非 position.z：正面顶点法线恒 (0,0,+1)，而 position.z 不行 ——
  //    棱上的顶点被多个面共享 z 值（顶/底/左/右面各有 2 个顶点也在 z=+size/2），
  //    用它做反向判据会多出 8 个假命中（实测踩过）。
  const normal = geo.getAttribute('normal');
  for (const i of HEAD_FRONT_VERTICES) {
    assertClose(normal.getX(i), 0, 1e-6, `顶点 ${i} 法线 x 须为 0`);
    assertClose(normal.getY(i), 0, 1e-6, `顶点 ${i} 法线 y 须为 0`);
    assertClose(normal.getZ(i), 1, 1e-6, `顶点 ${i} 须是正面（法线 z = +1）`);
  }
  // ② 反向前提：法线 (0,0,+1) 的顶点**恰好**是 HEAD_FRONT_VERTICES → 钉住「不多不少」
  const frontSet = new Set(HEAD_FRONT_VERTICES);
  const byNormal = [];
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(normal.getZ(i) - 1) < 1e-6 && Math.abs(normal.getX(i)) < 1e-6 && Math.abs(normal.getY(i)) < 1e-6) {
      byNormal.push(i);
    }
  }
  assertDeepEqual(byNormal.sort((a, b) => a - b), [...HEAD_FRONT_VERTICES].sort((a, b) => a - b),
    '正面顶点须恰好是 HEAD_FRONT_VERTICES（不多不少）');

  // ③ UV 分区生效：正面 u ∈ [0.5, 1]（右半有眼睛）；其余 u ∈ [0, 0.5]（左半无眼睛）。
  //    只压 u 不动 v → 保持 8×8 马赛克比例（若压 v 会把格子压成 8×4，图案变扁）。
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i);
    if (frontSet.has(i)) {
      assertTrue(u >= 0.5 - 1e-6 && u <= 1 + 1e-6, `正面顶点 ${i} 的 u 须在 [0.5,1]，got ${u}`);
    } else {
      assertTrue(u >= -1e-6 && u <= 0.5 + 1e-6, `非正面顶点 ${i} 的 u 须在 [0,0.5]，got ${u}`);
    }
  }
  // ④ v 未被改写：六面 v 仍覆盖 [0,1] 全幅（默认 BoxGeometry 值）→ 纵向没被压扁
  let minV = Infinity, maxV = -Infinity;
  for (let i = 0; i < uv.count; i++) { minV = Math.min(minV, uv.getY(i)); maxV = Math.max(maxV, uv.getY(i)); }
  assertClose(minV, 0, 1e-6, 'v 最小值须为 0（未改写纵向）');
  assertClose(maxV, 1, 1e-6, 'v 最大值须为 1（未改写纵向）');

  // ⑤ head 材质确实带 map；其余五部件不带（它们不该吃头部纹理）
  assertTrue(!!renderer.meshes.head.material.map, 'head 材质须带 map');
  assertTrue(renderer.headHasTexture(), 'headHasTexture 须为真');
  for (const part of ZOMBIE_PARTS) {
    if (part === 'head') continue;
    assertNull(renderer.meshes[part].material.map, `${part} 材质不应带 map`);
  }
});

test('ZombieRenderer: 无纹理时 head 退回视觉色（不渲染成纯白头）', () => {
  // 单测 fixture 默认不传纹理 → head 必须退回视觉色 0x406b30（= headPalette.base 的等价纯色）。
  // **不能读 ZOMBIE_PART_DEFS.head.color**（那是 0xffffff 白底，退回色在 `_baseColorOf`）——
  // 若这里改成读定义色，断言会在「退回路径失效」时仍全绿（恒真陷阱）。
  const { renderer } = makeZombieFixture(); // 无 headTexture
  assertFalse(renderer.headHasTexture(), '默认 fixture 不应有纹理');
  assertNull(renderer.meshes.head.material.map, '无纹理时 head 不应带 map');
  // instanceColor 是退回色的可观测落点（构造器初始化每个 slot 时写入）
  const c = new THREE.Color();
  renderer.meshes.head.getColorAt(0, c);
  assertEqual(c.getHex(), 0x406b30, 'head 无纹理时基色须为视觉色 0x406b30');
  // 对照：body 无纹理/有纹理都恒用定义色（不吃退回路径）
  renderer.meshes.body.getColorAt(0, c);
  assertEqual(c.getHex(), 0x037c7c);
});

test('ZombieRenderer: 有纹理时 head 基色为白底（避免深绿 × 深绿变暗）', () => {
  const dummy = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const { renderer } = makeZombieFixture({ headTexture: dummy });
  const c = new THREE.Color();
  renderer.meshes.head.getColorAt(0, c);
  // 有 map → 白底乘纹理色。若这里读到 0x406b30，会与纹理的深绿叠加 → 头部严重变暗
  assertEqual(c.getHex(), 0xffffff, 'head 有纹理时基色须为白底 0xffffff');
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
function makeAiFixture({ worldColumns = 8 } = {}) {
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

  const zombies = new ZombieService({ entities, world, pool });
  const playerPosition = [0.5, 1, 0.5];

  return { registry, ids, world, entities, zombies, pool, playerPosition };
}

test('ZombieService: 20Hz 单条批量 AI RPC + 60 格门控（59 进、61 不进）', async () => {
  const { zombies, pool, playerPosition } = makeAiFixture();
  zombies.spawn([10.5, 1, .5], { source: 'test' });   // 距玩家 10 格
  zombies.spawn([59.5, 1, .5], { source: 'test' });   // 距玩家 59 格 → 在 60 格门内
  zombies.spawn([61.5, 1, .5], { source: 'test' });   // 距玩家 61 格 → 超门，不进批次

  // 0.049 秒 < aiPeriod(0.05) → 尚未到周期，不发 RPC
  zombies.update(0.049, { playerPosition, nowMs: 1000 });
  assertEqual(zombies.debugAiState().calls, 0, '未到 aiPeriod 不得发 RPC');
  assertEqual(pool.calls.length, 0);

  // 再推进 0.001 秒 → 累计 0.05 秒 = 一个周期 → 恰好一条 RPC
  zombies.update(0.001, { playerPosition, nowMs: 1050 });
  assertEqual(pool.calls.length, 1, '每周期只发一条 RPC');
  assertEqual(zombies.debugAiState().lastBatchSize, 2, '批次只含 60 格内的 2 只');

  const payload = pool.calls[0].payload;
  assertEqual(pool.calls[0].method, 'ai');
  assertEqual(payload.zombies.length, 2);
  // **不传局部体素 view**（M6 规格 §2：worker 不读世界）
  assertFalse('localVoxelView' in payload, '不得传 localVoxelView');
  assertFalse('world' in payload, '不得传 world');
  // 批次内每只都带 id/generation（回包验证的前提）+ 位置/朝向/mode
  for (const z of payload.zombies) {
    assertTrue(typeof z.id === 'string');
    assertTrue(Number.isFinite(z.generation));
    assertTrue(Array.isArray(z.position));
    assertTrue('mode' in z);
  }
  assertDeepEqual(payload.playerPosition, playerPosition);
  // 61 格那只不在批次里（门控生效）
  const positions = payload.zombies.map((z) => round6(z.position[0]));
  assertEqual(positions.includes(61.5), false, '超 60 格的丧尸不进批次');
  assertEqual(positions.includes(59.5), true, '59 格的丧尸进批次');
});

test('ZombieService: 朝向从速度派生 —— 移动时跟随，静止保持（mc-lite Zombie.js:230-239）', async () => {
  // mc-lite 口径：`setDesiredVelocity(vx, vz)` 写速度的同时派生 `rotation.y = atan2(vx, vz)`，
  // **仅在移动时更新**（`abs(vx) > 0.001 || abs(vz) > 0.001`），静止保持原朝向。
  // 断言从 `atan2` 派生而非硬编码角度值（testing-policy §2.5）。
  const { zombies, pool, playerPosition } = makeAiFixture();
  const id = zombies.spawn([10.5, 1, .5], { source: 'test' });
  const generation = zombies.entities.get(id).generation;
  assertEqual(zombies.get(id).yaw, 0, '出生朝向为 0');

  // 朝 +X 走 → yaw = atan2(vx, vz) = atan2(1.2, 0) = π/2
  pool.replies.push({ updates: [{ id, generation, vx: 1.2, vz: 0, mode: 'chasing' }] });
  zombies.update(ZOMBIE.aiPeriod, { playerPosition, nowMs: 1000 });
  await Promise.resolve(); await Promise.resolve();
  assertClose(zombies.get(id).yaw, Math.atan2(1.2, 0), 1e-9, '朝 +X 的朝向');

  // 转向 +Z → yaw = atan2(0, 1.2) = 0（朝向必须**跟着变**，不是停在第一个方向）
  pool.replies.push({ updates: [{ id, generation, vx: 0, vz: 1.2, mode: 'chasing' }] });
  zombies.update(ZOMBIE.aiPeriod, { playerPosition, nowMs: 1050 });
  await Promise.resolve(); await Promise.resolve();
  assertClose(zombies.get(id).yaw, Math.atan2(0, 1.2), 1e-9, '转向 +Z 后朝向须更新');

  // 斜向 → atan2(vx, vz)（保方向）
  pool.replies.push({ updates: [{ id, generation, vx: 0.6, vz: 0.6, mode: 'chasing' }] });
  zombies.update(ZOMBIE.aiPeriod, { playerPosition, nowMs: 1100 });
  await Promise.resolve(); await Promise.resolve();
  assertClose(zombies.get(id).yaw, Math.atan2(0.6, 0.6), 1e-9, '斜向朝向');

  // **静止时保持原朝向**（mc-lite：只在移动时更新）→ 零速度回包不得把 yaw 清零
  const yawBeforeIdle = zombies.get(id).yaw;
  pool.replies.push({ updates: [{ id, generation, vx: 0, vz: 0, mode: 'idle' }] });
  zombies.update(ZOMBIE.aiPeriod, { playerPosition, nowMs: 1150 });
  await Promise.resolve(); await Promise.resolve();
  assertEqual(zombies.get(id).yaw, yawBeforeIdle, '静止时须保持原朝向（不得清零）');

  // **低于阈值的微小速度也不得派生朝向**（自查发现的盲区，实测踩坑两轮）：
  // ① 只测精确零速度时，注入「阈值改成 0」仍然全绿 —— 对精确零 `|0| > 0` 为 false，yaw 照样不变；
  // ② 第一版修法写成 `micro = ZOMBIE_MOVING_EPSILON / 2` —— **测试输入从被测常量派生**，
  //    注入把常量改成 0 时 micro 也变成 0 → 回到精确零 → 断言恒真（testing-policy §2.5 的
  //    「硬编码/派生被测代码写入的那个值」陷阱）。故这里用**字面量** 0.0005：
  //    它低于真实阈值 0.001（正确实现按静止处理），但注入阈值 0 后 `|0.0005| > 0` 为真 →
  //    朝向被派生 → 断言 FAIL。断言才有牙齿。
  // 阈值的真正用途是挡浮点噪声（worker 回包可能给出 1e-9 级残余速度）。
  pool.replies.push({ updates: [{ id, generation, vx: 0.0005, vz: 0, mode: 'chasing' }] });
  zombies.update(ZOMBIE.aiPeriod, { playerPosition, nowMs: 1200 });
  await Promise.resolve(); await Promise.resolve();
  assertEqual(zombies.get(id).yaw, yawBeforeIdle, '低于阈值的微小速度须按静止处理（不派生朝向）');
  // 前提断言：字面量确实低于真实阈值（否则这条盲区覆盖形同虚设）
  assertTrue(0.0005 < ZOMBIE_MOVING_EPSILON, '前提：测试输入须低于真实阈值');
});

test('ZombieService: 60 格外的丧尸不进批次 → 朝向也不变（AI 预算门语义）', async () => {
  // 超 60 格的丧尸根本不进 AI 批次 → worker 不会给它意图 → 朝向保持出生值。
  // 这条钉住「朝向派生发生在回包应用时」而非每帧无条件重算。
  const { zombies, playerPosition } = makeAiFixture();
  const farId = zombies.spawn([61.5, 1, .5], { source: 'test' }); // 距玩家 61 格 → 超门
  zombies.update(ZOMBIE.aiPeriod, { playerPosition, nowMs: 1000 });
  await Promise.resolve(); await Promise.resolve();
  assertEqual(zombies.get(farId).yaw, 0, '超 AI 预算门的丧尸朝向不变');
  assertEqual(zombies.get(farId).velocity[0], 0, '速度也不变（意图未被写入）');
});

test('ZombieService: 在途期间不重复发 RPC（真实在途窗口）', async () => {
  // **必须制造真实的在途窗口**（自查发现的盲区）：原先「AI 回包写入意图，在途期间不重复调用」
  // 那条测试用 fake pool 的 `Promise.resolve`，回包在同一微任务里就完成了 → 两次 update 之间
  // `_aiInFlight` 早已被清零 → 注入「删在途门控」测试仍全绿，断言没落在被测路径。
  // 这里把回包挂在一个手动 resolve 的 promise 上，制造真正的跨帧在途窗口。
  const { zombies, pool, playerPosition } = makeAiFixture();
  zombies.spawn([10.5, 1, .5], { source: 'test' });
  zombies.spawn([59.5, 1, .5], { source: 'test' });

  let resolveReply;
  pool.deferred = new Promise((resolve) => { resolveReply = resolve; });

  // 第一条 RPC 发出并挂起（不回包）
  zombies.update(ZOMBIE.aiPeriod, { playerPosition, nowMs: 1000 });
  assertEqual(pool.calls.length, 1);
  assertEqual(zombies.debugAiState().pending, 1, '在途计数须为 1');

  // 在途期间连推 5 个周期 → **不得**再发 RPC（否则回包互相覆盖、意图抖动）
  for (let i = 0; i < 5; i++) zombies.update(ZOMBIE.aiPeriod, { playerPosition, nowMs: 1050 + i * 50 });
  assertEqual(pool.calls.length, 1, '在途期间不得重复发 RPC');
  assertEqual(zombies.debugAiState().pending, 1);

  // 回包落地后，下一周期才恢复发送
  resolveReply({ updates: [] });
  await Promise.resolve(); await Promise.resolve();
  assertEqual(zombies.debugAiState().pending, 0, '回包落地后在途计数归零');
  zombies.update(ZOMBIE.aiPeriod, { playerPosition, nowMs: 1400 });
  assertEqual(pool.calls.length, 2, '回包落地后恢复每周期一条');
  pool.deferred = null;
});

test('ZombieService: AI 回包写入意图，在途期间不重复调用', async () => {
  const { zombies, pool, playerPosition } = makeAiFixture();
  const id = zombies.spawn([10.5, 1, .5], { source: 'test' });
  pool.replies.push({
    updates: [{ id, generation: zombies.entities.get(id).generation, vx: 1.2, vz: 0, mode: 'chasing' }],
  });
  zombies.update(ZOMBIE.aiPeriod, { playerPosition, nowMs: 1000 });
  assertEqual(pool.calls.length, 1);
  // 回包是 Promise —— 需等微任务排空后才写入意图
  await Promise.resolve();
  await Promise.resolve();
  assertEqual(zombies.get(id).velocity[0], 1.2);
  assertEqual(zombies.get(id).mode, 'chasing');
  // 下一周期才发第二条（在途期间不重复调用）
  zombies.update(ZOMBIE.aiPeriod, { playerPosition, nowMs: 1050 });
  assertEqual(pool.calls.length, 2);
});

test('ZombieService: 迟到 generation 回包不改变已 despawn/reused id 的实体', async () => {
  const { zombies, pool, playerPosition, entities } = makeAiFixture();
  const id = zombies.spawn([10.5, 1, .5], { source: 'test' });
  const staleGeneration = entities.get(id).generation;
  zombies.damage(id, 999, 100); // 死亡 → id 归还可复用
  const reborn = zombies.spawn([10.5, 1, .5], { source: 'test' });
  assertEqual(reborn, id, 'id 必须被复用（否则代数协议无从验证）');
  assertTrue(entities.get(reborn).generation > staleGeneration);
  const beforeX = zombies.get(reborn).position[0];

  // 送达旧代数的回包 → 必须被丢弃
  pool.replies.push({ updates: [{ id, generation: staleGeneration, vx: 1.2, vz: 0, mode: 'chasing' }] });
  zombies.update(ZOMBIE.aiPeriod, { playerPosition, nowMs: 1000 });
  await Promise.resolve();
  await Promise.resolve();
  assertEqual(zombies.get(reborn).velocity[0], 0, '过期回包不得写入意图');
  assertEqual(zombies.get(reborn).position[0], beforeX);
});

test('ZombieService: 无丧尸时不发 AI RPC（空批次不浪费往返）', () => {
  const { zombies, pool, playerPosition } = makeAiFixture();
  zombies.update(ZOMBIE.aiPeriod * 10, { playerPosition, nowMs: 1000 });
  assertEqual(pool.calls.length, 0);
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

test('丧尸物理: velocity 上限钳制（AI 回包不得给出超速意图）', async () => {
  // 常量口径：把 speed 改大会让丧尸追得上玩家（玩法失衡）
  assertEqual(ZOMBIE.speed, 1.2);
  assertTrue(ZOMBIE.speed < 8.0, '丧尸速度须明显低于玩家 8 格/秒（否则追得上）');

  // **必须真的触发钳制代码**（自查发现的盲区）：原先这条只断言常量，删掉钳制分支测试仍全绿
  // —— 断言没落在被测路径。走真实回包路径（`update()` → `_applyIntent`），不直接调私有方法。
  const { zombies, pool, playerPosition } = makeAiFixture();
  const id = zombies.spawn([10.5, 1, .5], { source: 'test' });
  const generation = zombies.entities.get(id).generation;
  // 超速回包（10 格/秒）→ 必须被钳到 ZOMBIE.speed（恶意/错误回包不得让丧尸超速追上玩家）
  pool.replies.push({ updates: [{ id, generation, vx: 10, vz: 0, mode: 'chasing' }] });
  zombies.update(ZOMBIE.aiPeriod, { playerPosition, nowMs: 1000 });
  await Promise.resolve(); await Promise.resolve();
  const vel = zombies.get(id).velocity;
  assertClose(Math.hypot(vel[0], vel[2]), ZOMBIE.speed, 1e-9, '超速回包须钳到 ZOMBIE.speed');
  // 斜向超速同样钳制（保方向、改长度）
  pool.replies.push({ updates: [{ id, generation, vx: 8, vz: 8, mode: 'chasing' }] });
  zombies.update(ZOMBIE.aiPeriod, { playerPosition, nowMs: 1050 });
  await Promise.resolve(); await Promise.resolve();
  const vel2 = zombies.get(id).velocity;
  assertClose(Math.hypot(vel2[0], vel2[2]), ZOMBIE.speed, 1e-9, '斜向超速同样钳制');
  assertClose(vel2[0], vel2[2], 1e-9, '钳制保方向（两轴等分量）');
});
