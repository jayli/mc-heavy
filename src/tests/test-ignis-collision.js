// src/tests/test-ignis-collision.js — 碰撞/绕行判据参数化（v2.55 焰魔）
//
// ## 为什么改既有模块
//
// 焰魔是地面实体（AABB 1.0 × 3.25），需要与丧尸同一套「AABB × 实心方块」碰撞与
// 局部绕行。原实现把丧尸的 0.6 × 1.8 写死在 `zombieCollidesAt` / `steerIntent` 里。
//
// 红线 1（同一判据只留一份）⇒ 把盒尺寸提成参数，`zombieCollidesAt` / `steerIntent`
// 变成薄包装。**代价是本文件必须钉住丧尸零回归** —— 这是本次重构唯一真正的风险。
//
// Tier 1（纯函数算法 + 热路径的一部分）⇒ 必须 TDD。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse } from './assert.js';
import {
  zombieCollidesAt, aabbCollidesAt, steerIntent, steerIntentAabb,
} from '../entities/zombies/zombie-navigation.js';
import { ZOMBIE, ZOMBIE_MAX_STEP, ZOMBIE_STEERING } from '../entities/zombies/zombie-config.js';

/** 假世界：一个 Set 存实心格（`"x,y,z"`） */
function fakeWorld(solid) {
  return { isSolid: (x, y, z) => solid.has(`${x},${y},${z}`) };
}
const EMPTY = fakeWorld(new Set());

// ==================== 丧尸零回归（重构守门）====================

test('碰撞参数化: zombieCollidesAt 与 aabbCollidesAt(丧尸参数) 逐位等价', () => {
  const w = fakeWorld(new Set(['1,0,0', '2,1,0', '0,0,1', '0,2,0']));
  const pts = [
    [0.5, 0, 0.5], [0.5, 1, 0.5], [1.5, 0, 0.5], [0.5, 0, 1.5],
    [3.5, 0, 3.5], [0.5, 2, 0.5], [-0.5, 0, -0.5], [0.5, 0.25, 0.5],
  ];
  for (const p of pts) {
    assertEqual(
      zombieCollidesAt(w, p[0], p[1], p[2]),
      aabbCollidesAt(w, p[0], p[1], p[2], ZOMBIE.width / 2, ZOMBIE.height),
      `at ${JSON.stringify(p)}`,
    );
  }
});

test('碰撞参数化: steerIntent 与 steerIntentAabb(丧尸参数) 逐位等价', () => {
  const cases = [
    { solid: new Set(), pos: [0.5, 0, 0.5], v: [1.2, 0] },
    { solid: new Set(['1,0,0']), pos: [0.5, 0, 0.5], v: [1.2, 0] },
    { solid: new Set(['1,0,0', '1,0,1']), pos: [0.5, 0, 0.5], v: [1.2, 0] },
    { solid: new Set(['0,0,1']), pos: [0.5, 0, 0.5], v: [0, 1.2] },
    { solid: new Set(['0,0,0']), pos: [0.5, 0, 0.5], v: [0, 0] },   // 零速
  ];
  for (const c of cases) {
    const w = fakeWorld(c.solid);
    const a = steerIntent({ world: w, position: c.pos, vx: c.v[0], vz: c.v[1] });
    const b = steerIntentAabb({
      world: w, position: c.pos, vx: c.v[0], vz: c.v[1],
      halfWidth: ZOMBIE.width / 2, height: ZOMBIE.height,
      maxStep: ZOMBIE_MAX_STEP, steering: ZOMBIE_STEERING,
    });
    assertEqual(a.vx, b.vx, `vx at ${JSON.stringify(c)}`);
    assertEqual(a.vz, b.vz, `vz at ${JSON.stringify(c)}`);
    assertEqual(a.blocked, b.blocked, `blocked at ${JSON.stringify(c)}`);
  }
});

test('碰撞参数化: 无障碍时 steerIntent 原样返回输入（逐位零回归）', () => {
  const r = steerIntent({ world: EMPTY, position: [0.5, 0, 0.5], vx: 1.2, vz: 0 });
  assertEqual(r.vx, 1.2);
  assertEqual(r.vz, 0);
  assertFalse(r.blocked);
});

// ==================== 焰魔尺寸的差异化行为 ====================

test('碰撞参数化: 1.0×3.25 的 AABB 撞到丧尸撞不到的 3 格高天花板', () => {
  // 天花板在 y=3：丧尸（1.8 高，脚底 0 → 头顶 1.8）够不到；焰魔（3.25）够得到
  const w = fakeWorld(new Set(['0,3,0']));
  assertFalse(aabbCollidesAt(w, 0.5, 0, 0.5, ZOMBIE.width / 2, ZOMBIE.height));
  assertTrue(aabbCollidesAt(w, 0.5, 0, 0.5, 0.5, 3.25));
});

test('碰撞参数化: 1.0 宽的 AABB 占的列比 0.6 宽多（半宽真的生效）', () => {
  // 实心只在两侧的 ±1 列，中心 0.5：
  //   丧尸 半宽 0.3 → x∈[0.2,0.8] → 只采列 0     ⇒ 不撞
  //   焰魔 半宽 0.5 → x∈[0.0,1.0] → 采列 0 和 1  ⇒ 撞到列 1
  // ⚠️ 这条同时说明「float 边界也要小心」：x=1.0 属于列 1，`floor(1.0)` 不会退到 0。
  const w = fakeWorld(new Set(['-1,0,0', '1,0,0']));
  assertFalse(aabbCollidesAt(w, 0.5, 0, 0.5, 0.3, 1.8), '丧尸 x∈[0.2,0.8] 只采列 0');
  assertTrue(aabbCollidesAt(w, 0.5, 0, 0.5, 0.5, 3.25), '焰魔 x∈[0,1] 采到列 1');
  // ⚠️ **不要把中心挪到 0.0 去「验证反向」**：`floor(-0.3) = -1`（JS 对负数向下取整），
  // 所以中心 0.0 的丧尸本来就采列 -1 和 0 ⇒ 会撞。实测踩到，那是我的夹具算错而非实现错。
  // 更宽的盒**必然**覆盖更窄盒的列（同一中心下），故不存在「只碰丧尸不碰焰魔」的位置。
});

test('碰撞参数化: 恰好贴合的高度不算碰撞（PHYS_EPSILON 门控保留）', () => {
  // 脚底 y=1，身高 1.8 ⇒ 头顶恰 2.8，占地格 y∈[1,2]（floor(2.8-eps)=2）。
  // 天花板在 y=3 不该被判为碰撞 —— 这条守住 PHYS_EPSILON 的「恰好 1.8 净空」语义。
  const w = fakeWorld(new Set(['0,3,0']));
  assertFalse(aabbCollidesAt(w, 0.5, 1, 0.5, ZOMBIE.width / 2, ZOMBIE.height));
});

test('碰撞参数化: 探针会为一格台阶放行（maxStep 生效）', () => {
  // 正前方一格高的台阶：丧尸能上（MAX_STEP=1.0），焰魔也能上（同样 1.0）
  const w = fakeWorld(new Set(['1,0,0']));   // 脚下前方一格实心
  const r = steerIntentAabb({
    world: w, position: [0.5, 0, 0.5], vx: 1.2, vz: 0,
    halfWidth: ZOMBIE.width / 2, height: ZOMBIE.height,
    maxStep: ZOMBIE_MAX_STEP, steering: ZOMBIE_STEERING,
  });
  assertFalse(r.blocked, '一格台阶应被探针放行（交给物理 step-up）');
});

test('碰撞参数化: maxStep 传 0 时一格台阶被拒绝（参数真的生效）', () => {
  const w = fakeWorld(new Set(['1,0,0']));
  const r = steerIntentAabb({
    world: w, position: [0.5, 0, 0.5], vx: 1.2, vz: 0,
    halfWidth: ZOMBIE.width / 2, height: ZOMBIE.height,
    maxStep: 0, steering: ZOMBIE_STEERING,
  });
  // maxStep=0 ⇒ 抬一格也超限 ⇒ 只能靠偏角绕开或 blocked
  assertTrue(r.blocked || r.vx !== 1.2 || r.vz !== 0,
    'maxStep=0 应让直行被拒（绕行或 blocked）');
});

test('碰撞参数化: 全部候选被挡时返回零速 + blocked', () => {
  // ⚠️ 夹具必须让**所有偏角档**（22.5°/45°/67.5°/90°，每档 ±）的落点都撞。
  // 探针距离 1.2，故最远的候选落点水平偏移 ≤ 1.2 格；把中心周围 3 格半径整片填实即可
  // （含 y 0..3，让「抬一格」也救不了）。
  const solid = new Set();
  for (let dx = -4; dx <= 4; dx++) {
    for (let dz = -4; dz <= 4; dz++) {
      // 中心自己那一格留空（否则「当前位置被埋」也会影响判据语义）
      if (dx === 0 && dz === 0) continue;
      for (let dy = 0; dy <= 3; dy++) solid.add(`${dx},${dy},${dz}`);
    }
  }
  const r = steerIntentAabb({
    world: fakeWorld(solid), position: [0.5, 0, 0.5], vx: 1.2, vz: 0,
    halfWidth: 0.5, height: 3.25, maxStep: 1.0, steering: ZOMBIE_STEERING,
  });
  assertTrue(r.blocked, '被完全围住时应 blocked');
  assertEqual(r.vx, 0);
  assertEqual(r.vz, 0);
});

test('碰撞参数化: 传入 null world 时 collides 返回 false（不抛）', () => {
  assertFalse(aabbCollidesAt(null, 0, 0, 0, 0.5, 3.25));
  assertFalse(aabbCollidesAt({}, 0, 0, 0, 0.5, 3.25));
});
