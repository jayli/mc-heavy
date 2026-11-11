// src/tests/test-guardian-collision.js — 守卫身体盒 × 玩家物理（Review Focus #1）
//
// ## 为什么单开一个文件
//
// 守卫的核心盒比焰魔大得多（半宽 1.25 vs 0.83）**且前后不对称**（center.z = −0.4062）
// ⇒ 旋转后的 AABB 偏心，「玩家落进盒里」的最深陷入实测 **1.900 格**（焰魔 1.376），
// 而 `EJECT_MAX = 2.0` 的余量只剩 0.100。这条余量必须有断言钉住。
//
// ⚠️ 焰魔那条路径的零回归也必须守（泛化 `_ejectFromIgnis` → `_ejectFromBoss` 的唯一风险）。
//
// Tier 1（热路径 + 物理判据）⇒ 必须 TDD。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse } from './assert.js';
import { PlayerPhysics, IGNIS_EJECT_SPEED, EJECT_MAX } from '../player/physics.js';
import { WorldData } from '../voxel/world-data.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { blockIndex } from '../voxel/constants.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { createRegistry } from '../voxel/block-registry.js';
import { EntityManager } from '../entities/entity-manager.js';
import { guardianDefinition, GuardianService, guardianAabbFor } from '../entities/guardian/guardian-system.js';
import { GUARDIAN_TYPE, GUARDIAN, GUARDIAN_AI, GUARDIAN_CORE_OBB } from '../entities/guardian/guardian-config.js';
import { ignisDefinition, IgnisService } from '../entities/ignis/ignis-system.js';
import { IGNIS_TYPE } from '../entities/ignis/ignis-config.js';

/** 真实 WorldData：y=0 铺一层石头（与 test-physics.js 同口径） */
function makeWorld() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
    col.blocks[blockIndex(lx, 0, lz)] = reg.idOf('stone');
  }
  world.add(col);
  return { world, reg };
}

/** 装一个真 GuardianService，并在指定位置召一只守卫 */
function withGuardian(world, cx, cz, yaw = 0) {
  const em = new EntityManager();
  em.registerType(GUARDIAN_TYPE, guardianDefinition);
  const svc = new GuardianService({ entities: em, world, seed: 1 });
  const r = svc.summon('rc:0', cx, cz, 0, 1);
  assertTrue(r.ok, '守卫应召唤成功');
  const e = em.get(r.id);
  e.state = guardianDefinition.create({ ...e.state, yaw });
  return { em, svc, entity: e };
}

/** 会动的假盒（与真 service 同口径：严格不等式，贴面不算重叠） */
function fakeBoxService(box) {
  return {
    box,
    overlapsAabb(q) {
      const b = this.box;
      return q.minX < b.x1 && q.maxX > b.x0 && q.minZ < b.z1 && q.maxZ > b.z0
        && q.minY < b.y1 && q.maxY > b.y0;
    },
  };
}

// ==================== 阻挡（不动如山）====================

test('守卫碰撞: 玩家朝守卫身体盒走 → 被挡住（_collides 顶部判据）', () => {
  const { world } = makeWorld();
  const { svc } = withGuardian(world, 8, 8);
  const p = new PlayerPhysics(world);
  p.guardians = svc;
  // 守卫脚底 (8.5, 1, 8.5)，核心盒 y∈[2.5, 4.9]；玩家站 y=1，盒 y∈[1, 2.8] ⇒ y 有交集
  p.pos = { x: 8.5, y: 1, z: 4.0 };
  for (let i = 0; i < 10; i++) p.step(1 / 60);
  const z0 = p.pos.z;
  for (let i = 0; i < 60; i++) { p.move(0, 1); p.step(1 / 60); }   // 朝 +Z（守卫方向）走
  assertTrue(p.pos.z > z0, '应确实前进了一段');
  assertFalse(svc.overlapsAabb(p.aabb()), '不得陷进守卫身体盒');
  // 被挡在盒外：玩家前缘不得超过盒的 −Z 面
  const box = guardianAabbFor(svc.activeEntities()[0].state);
  const gz = svc.activeEntities()[0].state.position[2];
  assertTrue(p.pos.z + 0.3 <= gz + box.min[2] + 1e-6,
    `应停在盒外，玩家前缘 ${(p.pos.z + 0.3).toFixed(3)} vs 盒面 ${(gz + box.min[2]).toFixed(3)}`);
});

test('守卫碰撞: 玩家爬不上守卫（_tryStepUp 也走同一判据）', () => {
  const { world } = makeWorld();
  const { svc } = withGuardian(world, 8, 8);
  const p = new PlayerPhysics(world);
  p.guardians = svc;
  p.pos = { x: 8.5, y: 1, z: 5.0 };
  for (let i = 0; i < 10; i++) p.step(1 / 60);
  for (let i = 0; i < 120; i++) { p.move(0, 1); p.step(1 / 60); }
  assertTrue(p.pos.y < 2.5, `不该被抬到守卫盒上方，实际 y=${p.pos.y.toFixed(3)}`);
});

test('守卫碰撞: 用身体盒而非粗碰撞盒（玩家不该隔空被挡）', () => {
  const { world } = makeWorld();
  const { svc, entity } = withGuardian(world, 8, 8);
  const p = new PlayerPhysics(world);
  p.guardians = svc;
  const gp = entity.state.position;
  const core = guardianAabbFor(entity.state);
  // 站在「粗碰撞盒内、核心盒外」的位置：粗盒半宽 1.25，核心盒半宽也是 1.25（x 向）
  // 但 z 向核心盒只到 +0.625，粗盒到 +1.25 ⇒ 取 z 偏移 1.0
  p.pos = { x: gp[0], y: 1, z: gp[2] + 1.0 };
  for (let i = 0; i < 5; i++) p.step(1 / 60);
  assertFalse(svc.overlapsAabb(p.aabb()),
    '核心盒外的站位不该被判重叠（用粗碰撞盒会让玩家隔空被挡）');
  assertTrue(Math.abs(core.max[2]) < GUARDIAN.halfWidth,
    '前提：核心盒 z 半宽确实小于粗碰撞盒半宽');
});

// ==================== 推出（真重叠的兜底）====================

test('守卫碰撞: 玩家已在盒内 → 有界推出，不瞬移、不嵌进方块', () => {
  const { world } = makeWorld();
  const p = new PlayerPhysics(world);
  // 先用远处的假盒落地，再把盒挪到玩家身上（避免出生即重叠影响落地）
  const svc = fakeBoxService({ x0: 100, x1: 101, z0: 100, z1: 101, y0: 1, y1: 5 });
  p.guardians = svc;
  p.pos = { x: 8.5, y: 1, z: 8 };
  for (let i = 0; i < 10; i++) p.step(1 / 60);
  // 盒扫过来：玩家陷入 0.4 格（> 单步位移 8/60 = 0.133）
  svc.box = { x0: 8.4, x1: 11.0, z0: 7.0, z1: 9.0, y0: 1, y1: 5 };
  assertTrue(svc.overlapsAabb(p.aabb()), '前提：玩家被罩住');
  assertTrue(p._collides(), '前提：_collides 恒真（四轴冻结的条件）');
  let prevX = p.pos.x, maxStep = 0;
  for (let i = 0; i < 40; i++) {
    p.step(1 / 60);
    maxStep = Math.max(maxStep, Math.abs(p.pos.x - prevX));
    prevX = p.pos.x;
  }
  assertFalse(svc.overlapsAabb(p.aabb()), `40 步后仍被罩住，x=${p.pos.x.toFixed(3)}`);
  assertTrue(maxStep <= IGNIS_EJECT_SPEED / 60 + 1e-9,
    `单步推出 ${maxStep.toFixed(3)} 超上限（瞬移）`);
  assertFalse(p.collidesAt(p.pos.x, p.pos.y, p.pos.z), '出口不得嵌进方块');
});

test('守卫碰撞: 斜角站位（yaw=45°）也能推出 —— 焰魔 v2.78 软锁的同源场景', () => {
  const { world } = makeWorld();
  const { svc, entity } = withGuardian(world, 8, 8, Math.PI / 4);
  const p = new PlayerPhysics(world);
  p.guardians = svc;
  const gp = entity.state.position;
  // 直接把玩家放进旋转后的盒中心（最坏情形：传送到盒正中）
  p.pos = { x: gp[0], y: 1, z: gp[2] };
  assertTrue(svc.overlapsAabb(p.aabb()), '前提：盒中心必然重叠');
  for (let i = 0; i < 60; i++) p.step(1 / 60);
  assertFalse(svc.overlapsAabb(p.aabb()),
    `斜角盒中心应能推出，实际 pos=(${p.pos.x.toFixed(2)},${p.pos.z.toFixed(2)})`);
  assertFalse(p.collidesAt(p.pos.x, p.pos.y, p.pos.z), '出口不得嵌进方块');
});

test('守卫碰撞: EJECT_MAX 余量 —— 必须 > 守卫最深陷入 1.900（余量仅 0.100）', () => {
  // ⚠️ 这条是**配置守卫**：核心盒尺寸再调大就会超出推出上限 ⇒ 玩家永久卡死。
  assertTrue(EJECT_MAX > 1.900,
    `EJECT_MAX(${EJECT_MAX}) 必须 > 守卫最深陷入 1.900；余量仅 ${(EJECT_MAX - 1.900).toFixed(3)}`);
  assertEqual(EJECT_MAX, 2.0, 'EJECT_MAX 值不变（调大会让玩家被顶得更远）');
  // 独立复算：扫全 yaw × 盒内玩家站位，求「沿四轴推出的**最小**所需距离」的最大值。
  // ⚠️⚠️ **不是「最大绝对半宽 + 玩家半宽」**（实测 1.9050 + 0.3 = 2.205 > 2.0，会误报）：
  // 推出走的是**最近的一个面**，不是最远侧。四个方向取 min 后再对站位取 max，
  // 实测得 **1.9000**（yaw 42°、玩家站位 (−0.29,−0.30)）—— 与冻结值逐位一致。
  const HW = 0.3;
  let worst = 0;
  for (let deg = 0; deg < 360; deg += 1) {
    const b = guardianAabbFor({ position: [0, 0, 0], yaw: deg * Math.PI / 180 });
    for (let px = b.min[0] + 0.05; px < b.max[0]; px += 0.05) {
      for (let pz = b.min[2] + 0.05; pz < b.max[2]; pz += 0.05) {
        if (!(px - HW < b.max[0] && px + HW > b.min[0]
          && pz - HW < b.max[2] && pz + HW > b.min[2])) continue;
        const need = Math.min(
          b.max[0] - (px - HW), (px + HW) - b.min[0],
          b.max[2] - (pz - HW), (pz + HW) - b.min[2],
        );
        if (need > worst) worst = need;
      }
    }
  }
  assertTrue(Math.abs(worst - 1.900) < 0.01,
    `独立复算的最深陷入 ${worst.toFixed(4)} 应 ≈ 1.900`);
  assertTrue(worst <= EJECT_MAX, `最深陷入 ${worst.toFixed(4)} 必须 ≤ EJECT_MAX`);
  assertTrue(GUARDIAN_CORE_OBB.center[2] !== 0, '前提：盒确实不对称（否则本用例退化成对称盒）');
});

test('守卫碰撞: 推出后玩家解冻（远离/平移/起跳都能动），朝盒里走仍被挡', () => {
  const { world } = makeWorld();
  const p = new PlayerPhysics(world);
  const svc = fakeBoxService({ x0: 100, x1: 101, z0: 100, z1: 101, y0: 1, y1: 5 });
  p.guardians = svc;
  p.pos = { x: 8.5, y: 1, z: 8 };
  for (let i = 0; i < 10; i++) p.step(1 / 60);
  svc.box = { x0: 8.4, x1: 11.0, z0: 7.0, z1: 9.0, y0: 1, y1: 5 };
  for (let i = 0; i < 40; i++) p.step(1 / 60);
  const base = { ...p.pos };
  const walk = (mx, mz) => {
    p.pos = { ...base };
    p.vel = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 30; i++) { p.move(mx, mz); p.step(1 / 60); }
    return { dx: p.pos.x - base.x, dz: p.pos.z - base.z };
  };
  assertTrue(walk(-1, 0).dx < -2, '远离（−X）应能走');
  assertTrue(walk(0, 1).dz > 2, '贴盒面 +Z 平移应能走');
  assertTrue(walk(1, 0).dx < 0.05, '朝盒里走仍被挡（不动如山不变）');
});

// ==================== 双 Boss 同时在场（泛化零回归）====================

test('守卫碰撞: 焰魔与守卫同时在场时两套盒都生效', () => {
  const { world } = makeWorld();
  const em = new EntityManager();
  em.registerType(GUARDIAN_TYPE, guardianDefinition);
  em.registerType(IGNIS_TYPE, ignisDefinition);
  const gsvc = new GuardianService({ entities: em, world, seed: 1 });
  const isvc = new IgnisService({ entities: em, world, seed: 1 });
  assertTrue(gsvc.summon('rc:0', 4, 8, 0, 1).ok);
  assertTrue(isvc.summon('tarn:0', 11, 8, 1, 1).ok);
  const p = new PlayerPhysics(world);
  p.guardians = gsvc;
  p.ignises = isvc;
  // 分别走到两只面前，都应被挡
  for (const [svc, name] of [[gsvc, '守卫'], [isvc, '焰魔']]) {
    const e = svc.activeEntities()[0];
    const gp = e.state.position;
    p.pos = { x: gp[0], y: 1, z: gp[2] - 3.0 };
    p.vel = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 10; i++) p.step(1 / 60);
    for (let i = 0; i < 90; i++) { p.move(0, 1); p.step(1 / 60); }
    assertFalse(svc.overlapsAabb(p.aabb()), `${name}：不得陷进身体盒`);
  }
});

test('守卫碰撞: 只装焰魔时行为与泛化前一致（零回归）', () => {
  const { world } = makeWorld();
  const p = new PlayerPhysics(world);
  const svc = fakeBoxService({ x0: 100, x1: 101, z0: 100, z1: 101, y0: 1, y1: 5 });
  p.ignises = svc;                      // ⚠️ 不装 guardians
  p.pos = { x: 8.5, y: 1, z: 8 };
  for (let i = 0; i < 10; i++) p.step(1 / 60);
  svc.box = { x0: 8.4, x1: 11.0, z0: 7.0, z1: 9.0, y0: 1, y1: 5 };
  assertTrue(p._collides(), '焰魔盒仍被视为实心');
  for (let i = 0; i < 40; i++) p.step(1 / 60);
  assertFalse(svc.overlapsAabb(p.aabb()), '焰魔路径的推出仍生效');
  assertTrue(p.pos.x < 8.5, '仍朝最近的面（−X）推出');
});

test('守卫碰撞: 两套 service 都为 null 时 _collides 只看方块（常态零开销）', () => {
  const { world } = makeWorld();
  const p = new PlayerPhysics(world);
  p.pos = { x: 8.5, y: 1, z: 8 };
  for (let i = 0; i < 10; i++) p.step(1 / 60);
  assertFalse(p._collides(), '空地上不该碰撞');
  p.pos = { x: 8.5, y: 0, z: 8 };   // 站进石头层
  assertTrue(p._collides(), '方块碰撞仍生效');
});

// ==================== 走位不变式（与 Agent 侧配合）====================

test('守卫碰撞: 死区下界 > 最大重叠半径 ⇒ 正常走位永远碰不到它', () => {
  const inner = GUARDIAN_AI.standoffRange - GUARDIAN_AI.standoffDeadband;
  let worst = 0;
  for (let deg = 0; deg < 360; deg += 0.5) {
    const b = guardianAabbFor({ position: [0, 0, 0], yaw: deg * Math.PI / 180 });
    worst = Math.max(worst, (b.max[0] - b.min[0]) / 2, (b.max[2] - b.min[2]) / 2);
  }
  assertTrue(inner > worst + 0.3,
    `死区下界 ${inner} 必须 > 最大半宽 ${worst.toFixed(4)} + 玩家半宽 0.3`);
  assertTrue(GUARDIAN_AI.overlapEscapeDist < inner,
    '重叠自愈阈必须 < 死区下界（否则正常贴近也会触发后退，反转不动如山）');
});