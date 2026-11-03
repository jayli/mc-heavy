// src/tests/test-projectiles.js — M8：弹丸（推进 / DDA 阻挡 / 实体命中 / 伤害换算）
// Tier 1 单测。覆盖「改坏了肉眼玩不出来」的部分：
// ① **必须返回全新 state + 全新数组** —— `EntityManager.update()` 的跨 column 索引迁移判据
//    是「赋值前 vs 赋值后 position」，原地改写会让索引永不迁移 → column 卸载漏回收弹丸；
// ② 遮挡判据（实心且不透明才阻挡）与炮塔 LOS **共用同一份**（红线 1）；
// ③ 伤害换算 34 须在**临界值附近**断言（两发不死、三发死）—— 远离阈值测不出换算错误；
// ④ **判定线段还原本步穿越** —— 这是「DDA 取代 mc-lite 双点采样」的核心论证，
//    判定区间错了会让该论证失效（dt 尖峰时穿墙）。
//
// ⚠️ fixture 里的 `entities` 必须是**真实 `EntityManager`**（不是桩件）—— 命中判定走它的
// `raycast()`，桩件会让「命中真相只由 EntityManager 给出」这条红线测不出来（testing-policy §2.7）。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse, assertNull, assertNotNull } from './assert.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';
import { EntityManager } from '../entities/entity-manager.js';
import { TURRET } from '../entities/turrets/turret-config.js';
import {
  projectileDefinition, advanceProjectile, judgeProjectile, PROJECTILE_AABB,
} from '../entities/turrets/projectile-system.js';
import { ZombieService, zombieDefinition } from '../entities/zombies/zombie-system.js';
import { probeDefinition, WEAPON_HITTABLE_TYPES } from '../entities/entity-types.js';
import { dragonDefinition, DragonService } from '../entities/dragons/dragon-system.js';
import { DRAGON, DRAGON_TYPE } from '../entities/dragons/dragon-config.js';
import { ZOMBIE } from '../entities/zombies/zombie-config.js';

function makeRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}

/**
 * 弹丸 fixture。column 0 铺地面（丧尸 spawn 门控需要脚下 solid），世界全空气。
 * 弹丸不走 RPC → **不需要 fake pool**。
 */
function makeProjectileFixture() {
  const registry = makeRegistry();
  const world = new WorldData(registry);
  const stoneId = registry.idOf('stone');
  // ⚠️ **必须加载 cx/cz ∈ [0,1]**（不是只加 (0,0)）：测试的丧尸落点与弹丸路径跨到
  // z=16.5（cz=1），而 `ZombieService.spawn()` 的门控含 `world.hasColumn(cx,cz)` →
  // 缺列会让 spawn 返回 null，下面的伤害断言全部变成无效盲区（实测踩过）。
  for (let cx = 0; cx <= 1; cx++) {
    for (let cz = 0; cz <= 1; cz++) {
      const col = new ChunkColumn(cx, cz);
      col.state = 'ready';
      for (let lx = 0; lx < 16; lx++) {
        for (let lz = 0; lz < 16; lz++) col.set(lx, 4, lz, stoneId);   // y=4 铺地面
      }
      world.add(col);
    }
  }
  const entities = new EntityManager();
  entities.registerType('projectile', projectileDefinition);
  entities.registerType('zombie', zombieDefinition);
  entities.registerType('probe', probeDefinition);
  entities.registerType(DRAGON_TYPE, dragonDefinition);   // v2.41：弹丸也要能打龙
  const zombies = new ZombieService({ entities, world });   // 不需要 pool（本测试不发 AI RPC）
  // v2.41：龙 service。findAltar 注入成固定中心（本 fixture 的世界只有 column 0..1，
  // 真实祭坛地带在几百格外，用真实权威会让龙 spawn 在测试世界之外 → 断言成无效盲区）
  const dragons = new DragonService({
    entities, persistence: null, seed: 1, world,
    findAltar: () => ({ regionX: 0, regionZ: 0, cx: 8, cz: 8, dist: 0 }),
  });
  return { world, registry, entities, zombies, dragons };
}

/** 造一份合法弹丸 state（走 definition.create，保证方向已归一化） */
function makeProjectileState(position, direction = [0, 0, 1], traveled = 0) {
  return projectileDefinition.create({
    position, direction, traveled, source: 'turret-1',
  });
}

// ---------- 推进 ----------

test('弹丸直线推进：40 格/秒 × dt，traveled 累积', () => {
  const { world } = makeProjectileFixture();
  const state = makeProjectileState([10, 5, 10], [0, 0, 1], 0);
  const next = projectileDefinition.update({ state }, 1 / 60, { world });
  // 40 × 1/60 ≈ 0.667 格（mc-lite PROJECTILE_SPEED 已是格/秒，不做 ×60 换算）
  assertTrue(Math.abs(next.position[2] - (10 + TURRET.projectileSpeed / 60)) < 1e-6);
  assertTrue(Math.abs(next.traveled - TURRET.projectileSpeed / 60) < 1e-6);
  // ⚠️ **必须是全新对象 + 全新数组**（CLAUDE.md 活跃约束：原地改写会让 EntityManager 的
  // 跨 column 索引迁移判据恒相等 → 索引永不迁移 → column 卸载漏回收弹丸）
  assertTrue(next !== state, '全新 state 对象');
  assertTrue(next.position !== state.position, '全新 position 数组');
  assertTrue(next.direction !== state.direction, '全新 direction 数组');
  // 原 state 未被污染
  assertEqual(state.position[2], 10);
});

test('弹丸 create：方向归一化 + 非法输入返回 null', () => {
  const s = projectileDefinition.create({ position: [0, 0, 0], direction: [3, 0, 0], traveled: 0 });
  assertTrue(Math.abs(s.direction[0] - 1) < 1e-9, '方向归一化');
  // 零方向 / 非有限数 → null
  assertNull(projectileDefinition.create({ position: [0, 0, 0], direction: [0, 0, 0] }));
  assertNull(projectileDefinition.create({ position: [0, NaN, 0], direction: [1, 0, 0] }));
  assertNull(projectileDefinition.create({ position: [0, 0], direction: [1, 0, 0] }));
  // AABB 是 0.3 见方的小盒（mc-lite `_projectileRadius = 0.3` 的等价表达）
  assertEqual(PROJECTILE_AABB.max[0], 0.15);
  assertEqual(PROJECTILE_AABB.min[0], -0.15);
  // 临时实体不存档
  assertNull(projectileDefinition.serialize({ position: [0, 0, 0] }));
});

// ---------- 方块阻挡 ----------

test('弹丸撞实心不透明方块即停，透明方块可穿透', () => {
  const { world, registry, entities } = makeProjectileFixture();
  world.setBlock(10, 5, 14, registry.idOf('stone'));
  const r = advanceProjectile({
    state: makeProjectileState([10.5, 5.5, 10.5], [0, 0, 1]),
    dt: 0.1, world, registry, entities, nowMs: 0,
  });
  assertEqual(r.alive, false);
  assertEqual(r.reason, 'block');
  // 换成 glass_block（实心但透明）→ 穿透。⚠️ 方块名是 `glass_block`，本仓 registry **无 `glass`**
  world.setBlock(10, 5, 14, registry.idOf('glass_block'));
  const r2 = advanceProjectile({
    state: makeProjectileState([10.5, 5.5, 10.5], [0, 0, 1]),
    dt: 0.1, world, registry, entities, nowMs: 0,
  });
  assertTrue(r2.alive, 'glass_block 可穿透');
  // leaves（2026-10-23 起 opaqueTable=1）→ **现在会被截停**（用户裁定：树叶挡弹丸）
  world.setBlock(10, 5, 14, registry.idOf('leaves'));
  const rLeaf = advanceProjectile({
    state: makeProjectileState([10.5, 5.5, 10.5], [0, 0, 1]),
    dt: 0.1, world, registry, entities, nowMs: 0,
  });
  assertEqual(rLeaf.alive, false, 'leaves 截停弹丸（opaqueTable=1）');
  assertEqual(rLeaf.reason, 'block');
});

test('弹丸判定线段还原本步穿越：dt 尖峰时不穿墙（DDA 取代双点采样）', () => {
  const { world, registry, entities } = makeProjectileFixture();
  // 1 格厚的墙在 z=13；弹丸从 z=12.5 出发，dt=0.05 → stepLen = 40×0.05 = **2 格**
  // → 步后位置 14.5 已在墙**之后**。若判定只从步后位置起算（14.5→16.5），会漏掉这堵墙
  // （这正是 mc-lite 双点采样的失效模式，也是本任务的核心论证）。
  world.setBlock(10, 5, 13, registry.idOf('stone'));
  const r = advanceProjectile({
    state: makeProjectileState([10.5, 5.5, 12.5], [0, 0, 1]),
    dt: 0.05, world, registry, entities, nowMs: 0,
  });
  assertEqual(r.reason, 'block', '2 格步长仍须命中 1 格厚的墙');
  assertEqual(r.alive, false);
  // 对照：墙在**步后位置之后**（z=16）时不该命中（证明判定区间是「本步」而不是无限长）
  world.setBlock(10, 5, 13, 0);
  world.setBlock(10, 5, 16, registry.idOf('stone'));
  const r2 = advanceProjectile({
    state: makeProjectileState([10.5, 5.5, 12.5], [0, 0, 1]),
    dt: 0.05, world, registry, entities, nowMs: 0,
  });
  assertTrue(r2.alive, '本步未穿越到 z=16 → 不该命中');
});

test('judgeProjectile 只判定不推进（纯谓词）', () => {
  const { world, registry, entities } = makeProjectileFixture();
  world.setBlock(10, 5, 13, registry.idOf('stone'));
  const next = makeProjectileState([10.5, 5.5, 14.5], [0, 0, 1]);
  const before = next.position[2];
  const verdict = judgeProjectile({
    next, world, registry, entities, stepLen: TURRET.projectileSpeed * 0.05, nowMs: 0,
  });
  assertEqual(verdict.reason, 'block');
  // ⚠️ **不得改 state**（推进由 entities.update 驱动，两处推进会让弹丸速度翻倍）
  assertEqual(next.position[2], before);
});

// ---------- 实体命中与伤害换算 ----------

test('弹丸命中丧尸：经 EntityManager.raycast，伤害 34（三发死）', () => {
  const { world, registry, entities, zombies } = makeProjectileFixture();
  // 丧尸脚格 y=5（空气）、脚下 y=4（stone）→ 合法落点
  const zid = zombies.spawn([10.5, 5, 16.5], { source: 'projectile-spec' });
  assertNotNull(zid, '丧尸须生成成功（否则下面的断言是无效盲区）');
  assertEqual(zombies.get(zid).health, ZOMBIE.health);
  // ⚠️ **必须传 `onDamage`** —— `judgeProjectile` 里是 `if (onDamage) onDamage(...)`，
  // 不传则伤害不发生（上一版审查报过的缺陷）
  const onDamage = (id, amount, ms) => zombies.damage(id, amount, ms);
  // **临界值附近断言**：两发不死、三发死（远离阈值测不出 34 这个换算值）
  let r;
  for (let i = 0; i < 2; i++) {
    r = advanceProjectile({
      state: makeProjectileState([10.5, 5.9, 15.5], [0, 0, 1]),
      dt: 0.1, world, registry, entities, nowMs: i * 100, onDamage,
    });
    assertEqual(r.reason, 'entity');
    assertEqual(r.hitId, zid);
  }
  assertEqual(zombies.get(zid).health, ZOMBIE.health - TURRET.projectileDamage * 2);  // 66 → 两发不死
  assertTrue(zombies.get(zid).health > 0, '两发不死');
  r = advanceProjectile({
    state: makeProjectileState([10.5, 5.9, 15.5], [0, 0, 1]),
    dt: 0.1, world, registry, entities, nowMs: 200, onDamage,
  });
  assertEqual(r.reason, 'entity');
  assertNull(zombies.get(zid), '第三发 66−34 ≤ 0 → despawn');
});

test('弹丸只打丧尸，不打其它实体（predicate 过滤）', () => {
  const { world, registry, entities } = makeProjectileFixture();
  // 放一个 probe 实体在弹丸路径上（fixture 已注册 probeDefinition → 它有 raycastAabb，
  // 若无 predicate 过滤就会被命中）。断言它**不**被命中 = predicate 真的在过滤。
  const probe = entities.spawn({
    id: 'probe-1', type: 'probe', state: { position: [10.5, 5.5, 16.5] }, persistent: false,
  });
  assertNotNull(probe, 'probe 须生成成功（否则 predicate 过滤测不到）');
  const r = advanceProjectile({
    state: makeProjectileState([10.5, 5.5, 15.5], [0, 0, 1]),
    dt: 0.1, world, registry, entities, nowMs: 0,
  });
  assertTrue(r.alive, '路径上只有非丧尸实体 → 不该命中');
  assertEqual(entities.get('probe-1') !== null, true, 'probe 未被 despawn');
});

// ---------- 超距 ----------

test('弹丸飞满 50 格即消失', () => {
  const { world, registry, entities } = makeProjectileFixture();
  const state = makeProjectileState([10, 5, 10], [1, 0, 0], TURRET.projectileMaxDistance - 0.1);
  const r = advanceProjectile({ state, dt: 0.1, world, registry, entities, nowMs: 0 });
  assertEqual(r.alive, false);
  assertEqual(r.reason, 'max-distance');
  // ⚠️ 判定顺序：超距**先于**方块/实体（否则弹丸可能在「已飞超最大距离」的位置上命中丧尸）
  const zombies = new ZombieService({ entities, world });
  const zid = zombies.spawn([10.5, 5, 16.5], { source: 'projectile-spec' });
  assertNotNull(zid);
  const over = advanceProjectile({
    state: makeProjectileState([10.5, 5.9, 15.5], [0, 0, 1], TURRET.projectileMaxDistance),
    dt: 0.1, world, registry, entities, nowMs: 0,
    onDamage: (id, amount, ms) => zombies.damage(id, amount, ms),
  });
  assertEqual(over.reason, 'max-distance', '超距优先于实体命中');
  assertEqual(zombies.get(zid).health, ZOMBIE.health, '超距时不掉血');
});

// ---------- 跨 column 索引迁移（注入①的判据） ----------

test('弹丸跨 column 飞行后，派生 column 索引跟随迁移', () => {
  const { world, entities } = makeProjectileFixture();
  // 沿 +X 飞行，从 x=15.5（cx=0）跨到 x=16.5（cx=1）—— 弹丸寿命 1.25s、跨 column 是常态
  const e = entities.spawn({
    id: 'p-1', type: 'projectile',
    state: { position: [15.5, 6.5, 8.5], direction: [1, 0, 0], traveled: 0, source: 'turret-1' },
    persistent: false,
  });
  assertNotNull(e, '弹丸须生成成功');
  assertEqual(entities.entitiesInColumn('0,0').length, 1, '初始索引在 cx=0');
  assertEqual(entities.entitiesInColumn('1,0').length, 0);
  // 推进跨过 column 边界（1 格 / (40 格/秒) = 0.025s；取 dt=0.05 → 2 格，稳跨边界）
  entities.update(0.05, { world });
  assertEqual(entities.entitiesInColumn('0,0').length, 0, '索引须迁出 cx=0');
  assertEqual(entities.entitiesInColumn('1,0').length, 1, '索引须迁入 cx=1');
  // ⚠️ 这条是注入①（`update` 原地改写后返回同一对象）的判据：原地改写会让
  // `before`/`after` 从同一份已改位置算出 → 恒相等 → **索引永不迁移** →
  // column 卸载时 `despawnColumn('0,0')` 找不到它 → 漏回收（弹丸照常在飞，肉眼看不出）。
  const n = entities.despawnColumn('1,0', 'column-unload');
  assertEqual(n, 1, '按新 column 能回收到它');
  assertNull(entities.get('p-1'), '已 despawn');
});

// ---------- 斜射穿薄墙（注入②的判据） ----------

test('弹丸斜射 + 步长尖峰仍能命中薄墙（DDA 取代双点采样）', () => {
  const { world, registry, entities } = makeProjectileFixture();
  // ⚠️ **必须用「斜射 + dt 尖峰」的组合**（实测修正）：步长 ≤ 墙厚时，判定线段的**终点必然
  // 落在墙格内** → 双点采样也能抓到 → 断言对注入②没有牙齿。故取 dt=0.05（stepLen=2，
  // 斜射每轴 1.414 格）：起点 z=12.6（空气）、步后 z≈14.0（空气），两端采样点**都落空**，
  // 而线段中途穿过 (11,5,13) 那格 —— 这正是 mc-lite 双点采样漏穿的失效模式。
  const dt = 0.05;
  world.setBlock(11, 5, 13, registry.idOf('stone'));
  const r = advanceProjectile({
    state: makeProjectileState([10.1, 5.5, 12.6], [1, 0, 1]),
    dt, world, registry, entities, nowMs: 0,
  });
  assertEqual(r.reason, 'block', '斜射 + 2 格步长仍须命中中途的墙格');
});

// ---------- 速度（注入⑤「两处推进」的判据） ----------

test('弹丸 1 秒飞行距离 ≈ 40 格（推进只做一遍）', () => {
  const { world } = makeProjectileFixture();
  // ⚠️ 这条是注入⑤（`_updateProjectiles` 里也推进位置）的判据：两处推进会让弹丸
  // 速度翻倍（80 格/秒），而弹丸照常在飞、照常命中 → 肉眼看不出，只有这条定量断言能抓到。
  // 与丧尸「两处物理会让丧尸推进两遍」同一类缺陷。
  let state = makeProjectileState([0.5, 6.5, 0.5], [0, 0, 1], 0);
  const dt = 1 / 60;
  for (let i = 0; i < 60; i++) {
    state = projectileDefinition.update({ state }, dt, { world });
  }
  // 60 步 × 1/60 秒 = 1 秒 → traveled 应 ≈ projectileSpeed（40），不是 80
  assertTrue(Math.abs(state.traveled - TURRET.projectileSpeed) < 1e-6,
    `1 秒 traveled=${state.traveled}（须 ≈ ${TURRET.projectileSpeed}）`);
  assertTrue(Math.abs(state.position[2] - (0.5 + TURRET.projectileSpeed)) < 1e-6,
    `1 秒位移=${state.position[2] - 0.5}（须 ≈ ${TURRET.projectileSpeed}）`);
});

// ---------- v2.41 祭坛飞龙：弹丸命中 predicate 泛化 ----------

test('弹丸命中龙：经 EntityManager.raycast，伤害 34（九发死）', () => {
  const { world, registry, entities, dragons } = makeProjectileFixture();
  dragons.ensure();
  const dragon = dragons.active();
  assertNotNull(dragon, '龙须 spawn 成功（否则下面的断言是无效盲区）');
  assertEqual(dragon.state.health, DRAGON.health);
  const p = dragon.state.position;
  // ⚠️ **必须传 `onDamage`** —— `judgeProjectile` 里是 `if (onDamage) onDamage(...)`
  const onDamage = (id, amount, ms) => dragons.damage(id, amount, ms);
  // ⚠️ **起点必须让「本步判定线段」穿过盒中心，与 yaw 无关**：龙的 yaw 由 phase 随机，
  // yaw≈π/2 时长轴转到 x、z 方向只剩宽轴半长 1.125 → 从 6 格外射会脱靶（假失败）。
  // stepLen = 40×0.1 = 4 格，故从 p[2]−2 出发 → 判定线段 [p[2]−2, p[2]+2] 必过盒中心 p[2]。
  const from = [p[0], p[1], p[2] - 2];
  // **临界值附近断言**：300 血 / 34 伤害 → 八发不死（300−272=28）、九发死
  let r;
  for (let i = 0; i < 8; i++) {
    r = advanceProjectile({
      state: makeProjectileState(from, [0, 0, 1]),
      dt: 0.1, world, registry, entities, nowMs: i * 100, onDamage,
    });
    assertEqual(r.reason, 'entity', `第 ${i + 1} 发须命中实体`);
    assertEqual(r.hitId, dragon.id);
  }
  assertEqual(dragons.active().state.health, DRAGON.health - TURRET.projectileDamage * 8);
  assertTrue(dragons.active().state.health > 0, '八发不死（300−272=28）');
  r = advanceProjectile({
    state: makeProjectileState(from, [0, 0, 1]),
    dt: 0.1, world, registry, entities, nowMs: 800, onDamage,
  });
  assertEqual(r.reason, 'entity');
  assertNull(dragons.active(), '第九发 28−34 ≤ 0 → despawn');
  assertEqual(dragons.isDead(), true);
});

test('弹丸打龙：predicate 走 WEAPON_HITTABLE_TYPES（不是硬编码 zombie）', () => {
  // ⚠️ 这条是「predicate 改回 `=== 'zombie'`」的回归门（plan Task 6 负向验证表第 2 行）。
  // 判据落在**共享集合本身**：龙必须在里面，且集合是冻结的（改它须显式动手）。
  assertTrue(WEAPON_HITTABLE_TYPES.includes(DRAGON_TYPE), '龙必须在可击中集合里');
  assertTrue(WEAPON_HITTABLE_TYPES.includes('zombie'), '丧尸必须在可击中集合里');
  assertFalse(WEAPON_HITTABLE_TYPES.includes('probe'), 'probe 是测试 fixture，不得可击中');
  assertFalse(WEAPON_HITTABLE_TYPES.includes('projectile'), '弹丸不得可击中（否则连锁误伤）');
});

test('弹丸仍不打 probe（泛化后过滤语义不变）', () => {
  const { world, registry, entities } = makeProjectileFixture();
  const probe = entities.spawn({
    id: 'probe-1', type: 'probe', state: { position: [10.5, 5.5, 16.5] }, persistent: false,
  });
  assertNotNull(probe);
  const r = advanceProjectile({
    state: makeProjectileState([10.5, 5.5, 15.5], [0, 0, 1]),
    dt: 0.1, world, registry, entities, nowMs: 0,
  });
  assertTrue(r.alive, 'probe 不在可击中集合 → 弹丸应穿过');
  // ⚠️ 未命中时 `advanceProjectile` 返回 `{state, alive:true}`，**不含 reason 字段**
  // （`projectile-system.js:146`）→ 判 undefined，不是 null。
  assertEqual(r.reason, undefined);
});
