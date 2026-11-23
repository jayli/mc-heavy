import { test, expect } from 'playwright/test';
import {
  ENEMY_ROSTER, bodyCenterOffset, headTopOffset, aimOffset, blastEdgeRadius,
} from './enemy-roster.mjs';
import { EXPLOSION_DAMAGE_RADIUS as R } from '../src/voxel/explosion.js';

// 冻结基线（spec §4.2 实测表）：四类型 × 三口径
const FROZEN = {
  zombie:   { center: 0.9,   head: 1.8,   aim: 1.2 },
  ignis:    { center: 1.625, head: 3.25,  aim: 1.2 },
  guardian: { center: 1.9,   head: 3.8,   aim: 1.2 },
  dragon:   { center: 0,     head: 1.875, aim: 0 },
};

test('Y 口径派生：12 个数值逐位等于冻结基线', () => {
  for (const [type, want] of Object.entries(FROZEN)) {
    expect(bodyCenterOffset(type), `${type} 中心`).toBe(want.center);
    expect(headTopOffset(type), `${type} 头顶`).toBe(want.head);
    expect(aimOffset(type), `${type} 瞄准`).toBe(want.aim);
  }
});

test('龙不满足「头顶 = 2×中心」（语义独立的证据）', () => {
  expect(headTopOffset('dragon')).not.toBe(2 * bodyCenterOffset('dragon'));
});

/**
 * 溅射边界 r 的判别力。
 *
 * ⚠️ **只遍历 `feet` 语义**：龙是体心（c=0），half 三元链的 else 分支本就返回 0
 * ⇒ 漏改与正确行为一致 ⇒ 本项对龙**无判别力**。**刻意排除，不是遗漏**。
 */
test('溅射边界 r：正确实现在半径内、漏改（中心落 0）在半径外', () => {
  const feetTypes = Object.keys(ENEMY_ROSTER)
    .filter((t) => ENEMY_ROSTER[t].semantics === 'feet');
  expect(feetTypes.length, '前置：至少有三个脚底语义类型').toBeGreaterThanOrEqual(3);
  for (const type of feetTypes) {
    const r = blastEdgeRadius(type);
    const c = bodyCenterOffset(type);
    expect(r, `${type} r 必须 ≤ R`).toBeLessThanOrEqual(R);
    expect(Math.hypot(r, c), `${type} 漏改时 dist 必须 > R（否则判据恒真）`).toBeGreaterThan(R);
  }
});

test('未登记类型必须 throw（不静默回落龙的口径）', () => {
  expect(() => bodyCenterOffset('bogus')).toThrow(/未登记的敌人类型/);
  expect(() => headTopOffset('bogus')).toThrow(/未登记的敌人类型/);
  expect(() => aimOffset('bogus')).toThrow(/未登记的敌人类型/);
});