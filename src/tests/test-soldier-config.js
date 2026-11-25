// src/tests/test-soldier-config.js — 士兵玩法数值冻结表（Tier 1，TDD）
//
// 覆盖：spec §5.2/§5.3/§5.4 的冻结数值逐条钉住 + 载荷性不变式。
// 数值来源：上游 `bj-shooting-game/night-heron-src/src/game/enemies.js` 的 `Soldier` 类
// + 三条用户裁定（上限 10 / 每发 2 血 / 方案 B 的距离环）。
//
// ⚠️ 本文件只测**常量表与三个纯函数**，不碰 Agent/Service/渲染器（各自用例里测）。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { ZOMBIE, ZOMBIE_MAX_STEP } from '../entities/zombies/zombie-config.js';
import {
  SOLDIER_TYPE, SOLDIER, SOLDIER_AI, SOLDIER_SHOT, SOLDIER_TRACER, SOLDIER_GAIT,
  SOLDIER_STEERING, soldierEntityIdFor, soldierAwarenessRate, soldierEyeY, soldierMuzzleWorld,
} from '../entities/soldiers/soldier-config.js';

test('士兵: SOLDIER_TYPE 是稳定的字符串常量', () => {
  assertEqual(SOLDIER_TYPE, 'soldier');
});

test('士兵: 体形与丧尸同宽同高（复用寻路/碰撞几何的前提）', () => {
  assertEqual(SOLDIER.width, ZOMBIE.width, '宽 = 丧尸宽');
  assertEqual(SOLDIER.height, ZOMBIE.height, '高 = 丧尸高');
});

test('士兵: 上台阶上限 2 格，且严格强于丧尸（用户 2026-11-26）', () => {
  // ☠️ 常量断言只能钉「意图」，不能证明能力生效 —— `maxStep` 在旧实现下是死值
  // （`zombieStepUpY` 恒抬 1 格）。真实能力由 test-soldier-system.js 的物理用例守。
  assertEqual(SOLDIER.maxStep, 2.0, '士兵能上 2 格');
  assertTrue(SOLDIER.maxStep > ZOMBIE_MAX_STEP, '必须严格强于丧尸（只改士兵）');
});

test('士兵: 上限 10、血量 100、留尸 1.2s（用户裁定）', () => {
  assertEqual(SOLDIER.maxAlive, 10, '同时存活上限 = 用户裁定 10');
  assertEqual(SOLDIER.health, 100, '血量 = 上游 this.health = 100');
  assertEqual(SOLDIER.deadLingerSeconds, 1.2, '留尸 = 上游 deadT < 1.2');
});

test('士兵: 每发扣玩家 2 血（用户裁定）', () => {
  assertEqual(SOLDIER_SHOT.playerDamage, 2);
});

test('士兵: 距离环落在开火射程内（否则站定了打不到）', () => {
  assertTrue(SOLDIER_AI.standoffMax < SOLDIER_AI.combatLosRange,
    '站定环外沿须小于开火视线射程');
  assertTrue(SOLDIER_AI.standoffMin < SOLDIER_AI.standoffMax, '环下界须小于上界');
});

test('士兵: awareness 速率四档 + 疾跑/search 倍率（上游逐值）', () => {
  assertEqual(soldierAwarenessRate(5, false, false), 4.2);
  assertEqual(soldierAwarenessRate(10, false, false), 1.7);
  assertEqual(soldierAwarenessRate(18, false, false), 0.9);
  assertEqual(soldierAwarenessRate(25, false, false), 0.5);
  assertEqual(soldierAwarenessRate(10, true, false), 1.7 * 1.5);
  assertEqual(soldierAwarenessRate(10, false, true), 1.7 * 1.8);
});

test('士兵: eyeY 站姿 1.56 / 蹲姿 1.0（上游 lerp 两端）', () => {
  assertEqual(soldierEyeY(0), SOLDIER_AI.eyeYStand);
  assertEqual(soldierEyeY(1), SOLDIER_AI.eyeYCrouch);
});

test('士兵: 枪口世界坐标随 yaw 旋转、随蹲下降低', () => {
  const stand = soldierMuzzleWorld([0, 0, 0], 0, 0);
  const crouch = soldierMuzzleWorld([0, 0, 0], 0, 1);
  assertTrue(stand[1] - crouch[1] > 0.4, `蹲下枪口必须降低，实测差 ${stand[1] - crouch[1]}`);
  // ⚠️ yaw→前向口径必须与丧尸一致：前向 = (sin yaw, cos yaw)。
  // yaw=π/2 ⇒ 前向 +X ⇒ 枪口 x 显著为正、z 近 0。用 Boss 那套 (-sin,-cos) 会背对玩家开枪。
  const side = soldierMuzzleWorld([0, 0, 0], Math.PI / 2, 0);
  assertTrue(side[0] > 0.9, `yaw=π/2 枪口须在 +X，实测 x=${side[0]}`);
  assertTrue(Math.abs(side[2]) < 0.1, `yaw=π/2 枪口 z 须近 0，实测 z=${side[2]}`);
});

test('士兵: 枪口在身前（yaw=0 时 +Z），不是身后', () => {
  const m = soldierMuzzleWorld([0, 0, 0], 0, 0);
  assertTrue(m[2] > 0.9, `yaw=0 前向是 +Z，枪口 z 须为正，实测 ${m[2]}`);
});

test('士兵: 枪口随 position 平移', () => {
  const a = soldierMuzzleWorld([0, 0, 0], 0.7, 0.3);
  const b = soldierMuzzleWorld([10, 5, -4], 0.7, 0.3);
  assertEqual(b[0] - a[0], 10);
  assertEqual(b[1] - a[1], 5);
  assertEqual(b[2] - a[2], -4);
});

test('士兵: id 由 slot 派生（与丧尸 z0~z19 同手法，不用 Math.random）', () => {
  assertEqual(soldierEntityIdFor(0), 's0');
  assertEqual(soldierEntityIdFor(9), 's9');
});

test('士兵: 点射节奏取上游逐值', () => {
  assertEqual(SOLDIER_SHOT.burstMin, 3);
  assertEqual(SOLDIER_SHOT.burstMax, 6);
  assertEqual(SOLDIER_SHOT.shotInterval, 0.105);
  assertEqual(SOLDIER_SHOT.maxConcurrentBursts, 2, '同一时刻最多 2 名士兵点射');
  assertEqual(SOLDIER_SHOT.accuracyFirst, 0.4);
  assertEqual(SOLDIER_SHOT.accuracyRest, 0.66);
});

test('士兵: 曳光参数取上游士兵色（不是玩家 KV-9 的色）', () => {
  assertEqual(SOLDIER_TRACER.speed, 170);
  assertEqual(SOLDIER_TRACER.width, 0.013);
  assertEqual(SOLDIER_TRACER.color[0], 12);
});

test('士兵: 全部表与嵌套数组都冻结（玩法数据唯一权威）', () => {
  for (const t of [SOLDIER, SOLDIER_AI, SOLDIER_SHOT, SOLDIER_TRACER, SOLDIER_GAIT, SOLDIER_STEERING]) {
    assertTrue(Object.isFrozen(t), '表须冻结');
  }
  assertTrue(Object.isFrozen(SOLDIER_SHOT.muzzleLocal));
  assertTrue(Object.isFrozen(SOLDIER_STEERING.anglesDeg));
});