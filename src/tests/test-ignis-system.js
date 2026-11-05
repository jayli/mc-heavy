// src/tests/test-ignis-system.js — 焰魔实体定义与 service（v2.55）
//
// 覆盖：create 的 state 校验与缺省补全、实体 id 派生、service 的召唤幂等/上限/死亡即消失、
// 以及配置里的**实测度量**（防手改漂移）。
//
// Tier 1（数据模型 + 状态机地基）⇒ 必须 TDD。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertNull, assertNotNull } from './assert.js';
// config 与 system 分开 import（system 只 re-export 它需要的东西，不是全部）
import {
  IGNIS_TYPE, IGNIS, IGNIS_AI, IGNIS_CORE_OBB, IGNIS_MODEL_CENTER, ignisEntityIdFor,
} from '../entities/ignis/ignis-config.js';
import { ignisDefinition, IgnisService } from '../entities/ignis/ignis-system.js';
import { EntityManager } from '../entities/entity-manager.js';

/** 造一个只含空气的世界（落点扫描会一路向下找到兜底） */
function emptyWorld() {
  return {
    isSolid: () => false,
    getBlockId: () => 0,
  };
}

/** 造一个「地表在 y=groundY」的世界（y <= groundY 实心） */
function flatWorld(groundY) {
  return {
    isSolid: (_x, y, _z) => y <= groundY,
    getBlockId: (_x, y, _z) => (y <= groundY ? 1 : 0),
  };
}

// ==================== config 契约 ====================

test('焰魔: IGNIS_TYPE 是稳定的字符串常量', () => {
  assertEqual(IGNIS_TYPE, 'ignis');
});

test('焰魔: 玩法数值取自原作者（Ignis_Entity.java 的 ignis() 属性表）', () => {
  // 这些不是「可调参数」，是素材作者的真实值 —— 改成别的值需要明确理由
  assertEqual(IGNIS.health, 450);          // MAX_HEALTH
  assertEqual(IGNIS.attackDamage, 14);     // ATTACK_DAMAGE
  assertEqual(IGNIS_AI.sightRange, 50);    // FOLLOW_RANGE
  assertEqual(IGNIS_AI.chaseSpeed, 6.6);   // MOVEMENT_SPEED 0.33 格/tick × 20
});

test('焰魔: 近战判据取自 AreaAttack(6.5, 6, 70, ...)（arc 是总角度 ⇒ 半角 35）', () => {
  assertEqual(IGNIS_AI.hitRange, 6.5);
  assertEqual(IGNIS_AI.hitConeDeg, 35);
  // ⚠️ 若有人把 70 直接填进来（当成半角），扇面会翻倍到 140° —— 玩家绕到侧面也躲不掉
  assertTrue(IGNIS_AI.hitConeDeg < 70, 'hitConeDeg 必须是半角，不是 arc 原值');
});

test('焰魔: 命中帧 = SWING_ATTACK 的 tick 24 / 20 = 1.20 秒', () => {
  assertEqual(IGNIS_AI.hitFrameSeconds, 1.20);
  // 必须落在攻击动画时长之内，否则永远不会触发
  assertTrue(IGNIS_AI.hitFrameSeconds < IGNIS_AI.attackAnimSeconds,
    `命中帧 ${IGNIS_AI.hitFrameSeconds} 超出动画 ${IGNIS_AI.attackAnimSeconds}`);
});

test('焰魔: 碰撞盒取自 Bedrock collision_box（1.0 × 3.25）', () => {
  assertEqual(IGNIS.halfWidth, 0.5);
  assertEqual(IGNIS.height, 3.25);
});

test('焰魔: 模型脚底不在 y=0（最低顶点 -0.3042 格，渲染必须补偿）', () => {
  assertEqual(IGNIS.modelFeetOffsetY, 0.3042);
  assertTrue(IGNIS.modelFeetOffsetY > 0, '补偿量必须为正（模型往下探出了原点）');
});

test('焰魔: 实测度量（改烘焙器/素材后必须同步这里）', () => {
  assertEqual(IGNIS_CORE_OBB.halfExtents[0], 0.8264);
  assertEqual(IGNIS_CORE_OBB.halfExtents[1], 1.421);
  assertEqual(IGNIS_CORE_OBB.halfExtents[2], 0.777);
  assertEqual(IGNIS_MODEL_CENTER[0], 0);
  assertEqual(IGNIS_MODEL_CENTER[1], 1.7335);
  assertEqual(IGNIS_MODEL_CENTER[2], 0.0895);
});

test('焰魔: CORE_OBB.center 恒为 [0,0,0]（position 语义 = 身体核心中心）', () => {
  assertEqual(IGNIS_CORE_OBB.center[0], 0);
  assertEqual(IGNIS_CORE_OBB.center[1], 0);
  assertEqual(IGNIS_CORE_OBB.center[2], 0);
});

// ==================== definition.create ====================

test('焰魔: create 拒绝非法 position', () => {
  assertNull(ignisDefinition.create({ position: [NaN, 0, 0] }));
  assertNull(ignisDefinition.create({ position: [0, 0] }));
  assertNull(ignisDefinition.create({ position: null }));
  assertNull(ignisDefinition.create(null));
});

test('焰魔: create 补全缺省字段', () => {
  const st = ignisDefinition.create({ position: [1, 2, 3] });
  assertNotNull(st);
  assertEqual(st.health, IGNIS.health);
  assertEqual(st.mode, 'idle');
  assertEqual(st.attackAnimT, 0);
  assertEqual(st.attackCooldown, 0);
  assertEqual(st.attackRequest, null);
  assertEqual(st.yaw, 0);
  assertEqual(st.onGround, false);
  // velocity 必须是长度为 3 的数组（物理推进要写它）
  assertEqual(st.velocity.length, 3);
});

test('焰魔: create 保留传入的合法字段', () => {
  const st = ignisDefinition.create({
    position: [5, 6, 7], yaw: 1.5, health: 100, mode: 'chase', attackAnimT: 0.5,
  });
  assertEqual(st.position[0], 5);
  assertEqual(st.yaw, 1.5);
  assertEqual(st.health, 100);
  assertEqual(st.mode, 'chase');
  assertEqual(st.attackAnimT, 0.5);
});

test('焰魔: create 拒绝非法 mode（回落 idle）', () => {
  assertEqual(ignisDefinition.create({ position: [0, 0, 0], mode: 'flying' }).mode, 'idle');
});

test('焰魔: create 返回全新数组（不共享输入的 position）', () => {
  const pos = [1, 2, 3];
  const st = ignisDefinition.create({ position: pos });
  assertTrue(st.position !== pos, 'position 数组被复用（M5 索引迁移不变式会破）');
});

// ==================== 实体 id 派生 ====================

test('焰魔: 实体 id 由 (mapKey, slot) 派生，同参恒同 id', () => {
  assertEqual(ignisEntityIdFor('tarn:2:0', 1), ignisEntityIdFor('tarn:2:0', 1));
});

test('焰魔: 不同地图/槽位的 id 不同', () => {
  assertTrue(ignisEntityIdFor('tarn:2:0', 1) !== ignisEntityIdFor('tarn:3:0', 1));
  assertTrue(ignisEntityIdFor('tarn:2:0', 1) !== ignisEntityIdFor('tarn:2:0', 0));
});

test('焰魔: 与飞龙的 id 前缀不同（两种 Boss 不会撞 id）', () => {
  assertTrue(ignisEntityIdFor('tarn:2:0', 1).startsWith(IGNIS_TYPE),
    `id 应以 ${IGNIS_TYPE} 开头：${ignisEntityIdFor('tarn:2:0', 1)}`);
  assertTrue(!ignisEntityIdFor('tarn:2:0', 1).includes('dragon'));
});

// ==================== service.summon ====================

test('焰魔: summon 在地表落点生成实体（position.y 在地面之上）', () => {
  const em = new EntityManager();
  em.registerType(IGNIS_TYPE, ignisDefinition);
  const svc = new IgnisService({ entities: em, world: flatWorld(10), seed: 1 });
  const r = svc.summon('tarn:2:0', 100, 200, 1);
  assertTrue(r.ok, JSON.stringify(r));
  const e = em.get(r.id);
  assertNotNull(e);
  assertEqual(e.type, IGNIS_TYPE);
  // 脚底应落在地表方块之上（y = 11），不是悬空也不是埋在地下
  assertEqual(e.state.position[1], 11);
});

test('焰魔: summon 幂等（同槽位二次召唤返回 exists，不产生第二条）', () => {
  const em = new EntityManager();
  em.registerType(IGNIS_TYPE, ignisDefinition);
  const svc = new IgnisService({ entities: em, world: flatWorld(10), seed: 1 });
  const a = svc.summon('tarn:2:0', 100, 200, 1);
  assertTrue(a.ok);
  const b = svc.summon('tarn:2:0', 100, 200, 1);
  assertEqual(b.reason, 'exists');
  assertEqual([...em.entities()].filter((x) => x.type === IGNIS_TYPE).length, 1);
});

test('焰魔: 不同地图可以各召唤一条（共存）', () => {
  const em = new EntityManager();
  em.registerType(IGNIS_TYPE, ignisDefinition);
  const svc = new IgnisService({ entities: em, world: flatWorld(10), seed: 1 });
  assertTrue(svc.summon('tarn:2:0', 0, 0, 1).ok);
  assertTrue(svc.summon('tarn:3:0', 0, 0, 1).ok);
  assertEqual(svc.activeEntities().length, 2);
});

test('焰魔: 超出 maxAlive 返回 limit', () => {
  const em = new EntityManager();
  em.registerType(IGNIS_TYPE, ignisDefinition);
  const svc = new IgnisService({ entities: em, world: flatWorld(10), seed: 1 });
  for (let i = 0; i < IGNIS.maxAlive; i++) {
    assertTrue(svc.summon(`tarn:${i}:0`, 0, 0, 1).ok, `第 ${i} 条应成功`);
  }
  const over = svc.summon('tarn:99:0', 0, 0, 1);
  assertEqual(over.reason, 'limit');
});

test('焰魔: 空世界（isSolid 恒 false）也能召唤（兜底落点，不抛）', () => {
  const em = new EntityManager();
  em.registerType(IGNIS_TYPE, ignisDefinition);
  const svc = new IgnisService({ entities: em, world: emptyWorld(), seed: 1 });
  const r = svc.summon('tarn:2:0', 0, 0, 1);
  assertTrue(r.ok, JSON.stringify(r));
  assertTrue(Number.isFinite(em.get(r.id).state.position[1]), 'y 必须是有限数');
});

// ==================== service.damage ====================

test('焰魔: damage 扣血并设置红闪', () => {
  const em = new EntityManager();
  em.registerType(IGNIS_TYPE, ignisDefinition);
  const svc = new IgnisService({ entities: em, world: flatWorld(10), seed: 1 });
  const { id } = svc.summon('tarn:2:0', 0, 0, 1);
  const r = svc.damage(id, 100, 5000);
  assertEqual(r.dead, false);
  assertEqual(r.health, IGNIS.health - 100);
  assertEqual(em.get(id).state.health, IGNIS.health - 100);
});

test('焰魔: damage 到 0 即 despawn（死后槽位可重召）', () => {
  const em = new EntityManager();
  em.registerType(IGNIS_TYPE, ignisDefinition);
  const svc = new IgnisService({ entities: em, world: flatWorld(10), seed: 1 });
  const { id } = svc.summon('tarn:2:0', 0, 0, 1);
  const r = svc.damage(id, IGNIS.health, 5000);
  assertEqual(r.dead, true);
  assertNull(em.get(id));
  // 死后可重召（槽位清空）
  assertTrue(svc.summon('tarn:2:0', 0, 0, 1).ok, '死亡后应能重新召唤');
});

test('焰魔: damage 对未知 id / 非焰魔实体返回 null', () => {
  const em = new EntityManager();
  em.registerType(IGNIS_TYPE, ignisDefinition);
  const svc = new IgnisService({ entities: em, world: flatWorld(10), seed: 1 });
  assertNull(svc.damage('nope', 10, 0));
});

test('焰魔: activeEntities 返回快照数组（可安全在遍历中 damage）', () => {
  const em = new EntityManager();
  em.registerType(IGNIS_TYPE, ignisDefinition);
  const svc = new IgnisService({ entities: em, world: flatWorld(10), seed: 1 });
  svc.summon('tarn:2:0', 0, 0, 1);
  const list = svc.activeEntities();
  assertTrue(Array.isArray(list), '必须是数组而不是迭代器');
  // 遍历中 despawn 不该炸
  for (const e of list) svc.damage(e.id, IGNIS.health, 0);
  assertEqual(svc.activeEntities().length, 0);
});

test('焰魔: dispose 清空全部', () => {
  const em = new EntityManager();
  em.registerType(IGNIS_TYPE, ignisDefinition);
  const svc = new IgnisService({ entities: em, world: flatWorld(10), seed: 1 });
  svc.summon('tarn:2:0', 0, 0, 1);
  svc.dispose();
  assertEqual(svc.activeEntities().length, 0);
});

// ==================== 射线命中 ====================

test('焰魔: raycastAabb 用 CORE_OBB（正面水平射线能打中）', () => {
  const em = new EntityManager();
  em.registerType(IGNIS_TYPE, ignisDefinition);
  const svc = new IgnisService({ entities: em, world: flatWorld(10), seed: 1 });
  const { id } = svc.summon('tarn:2:0', 0, 0, 1);
  const e = em.get(id);
  const st = e.state;
  // 从实体正前方（-Z 方向，yaw=0 的前向）水平射过去
  const origin = [st.position[0], st.position[1] + IGNIS_CORE_OBB.halfExtents[1], st.position[2] - 10];
  const hit = ignisDefinition.raycastAabb(st, origin, [0, 0, 1], 20);
  assertNotNull(hit, '正面射线应命中');
  // 从背后 10 格外朝外射（反方向）不该命中
  const miss = ignisDefinition.raycastAabb(st, origin, [0, 0, -1], 20);
  assertNull(miss, '朝远离方向射不该命中');
});
