// src/tests/test-health.js — 玩家血心的纯函数契约（生命系统显示层）
//
// 为什么单独成模块：`heartsFor()` 是「血量 → 心形数组」的唯一换算，错了肉眼看得出
// 但边界（半心、越界、非法值）容易漏。按 docs/testing-policy.md，纯函数算法 = Tier 1，
// 必须 TDD 钉住。渲染层（health-hud.js）只消费它的输出，不自己再算一遍（红线 1）。
//
// ⚠️ 本文件 import 的 `player/health.js` 是纯常量 + 纯函数模块（无 DOM、无 three），
// 与 `test-pixel-ratio.js` import `render/pixel-ratio.js` 同口径 —— 可在浏览器内单测里安全 import。
//
// ## v3.29（用户 2026-11-21）：满血 20 → **40 格**，心数 10 → **20 颗**
//
// 用户原话「玩家的血量默认在增加一倍，页面上方有玩家的血条一排小心心图案，向右数量增加一倍」。
// 每颗心仍 = 2 格血、半颗心仍 = 1 格（原版口径不变），所以 `heartsFor` 的换算逻辑一行未改，
// 只是上限与长度翻倍。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertDeepEqual } from './assert.js';
import {
  PLAYER_MAX_HEALTH, PLAYER_MAX_HEARTS, heartsFor, applyDamage,
} from '../player/health.js';

test('health: 常量自洽（40 血 = 20 心，半心 = 1 血）', () => {
  assertEqual(PLAYER_MAX_HEALTH, 40, '用户 2026-11-21 裁定：血量翻倍（原 20）');
  assertEqual(PLAYER_MAX_HEARTS, 20, '用户 2026-11-21 裁定：心数翻倍（原 10）');
  // 每颗心 2 血（半心 1 血）—— 这条关系是「半颗心对应一格血量」的数学表达
  assertEqual(PLAYER_MAX_HEALTH / PLAYER_MAX_HEARTS, 2, '每颗心 = 2 格血');
});

test('health: 满血 → 20 颗全满', () => {
  assertDeepEqual(heartsFor(40), Array(20).fill('full'));
});

test('health: 零血 → 20 颗全空', () => {
  assertDeepEqual(heartsFor(0), Array(20).fill('empty'));
});

test('health: 奇数血 → 末尾一颗半心（半颗心 = 一格血量）', () => {
  // 39 血 = 19 颗满 + 1 颗半（第 20 颗只剩 1 格）
  assertDeepEqual(heartsFor(39),
    [...Array(19).fill('full'), 'half']);
  // 1 血 = 0 颗满 + 1 颗半 + 19 颗空
  assertDeepEqual(heartsFor(1),
    ['half', ...Array(19).fill('empty')]);
  // 15 血 = 7 颗满 + 1 颗半 + 12 颗空（7×2 + 1 = 15）
  assertDeepEqual(heartsFor(15),
    [...Array(7).fill('full'), 'half', ...Array(12).fill('empty')]);
});

test('health: 偶数血 → 无半心（整颗整颗地亮）', () => {
  // 14 血 = 7 颗满 + 13 颗空
  assertDeepEqual(heartsFor(14),
    [...Array(7).fill('full'), ...Array(13).fill('empty')]);
  // 2 血 = 1 颗满 + 19 颗空
  assertDeepEqual(heartsFor(2),
    ['full', ...Array(19).fill('empty')]);
});

test('health: 输出长度恒为 20（渲染层按位画，长度漂移会画错格数）', () => {
  for (let hp = 0; hp <= 40; hp += 1) {
    assertEqual(heartsFor(hp).length, PLAYER_MAX_HEARTS, `血量 ${hp} 必须产出 20 颗心`);
  }
});

test('health: 每颗心的取值只能是 full/half/empty（渲染层据此选图）', () => {
  const allowed = new Set(['full', 'half', 'empty']);
  for (let hp = 0; hp <= 40; hp += 1) {
    for (const h of heartsFor(hp)) {
      assertTrue(allowed.has(h), `血量 ${hp} 产出了非法形态 ${h}`);
    }
  }
});

test('health: 血量单调 → 亮心数单调不减（掉血只会让心变暗，不会反向）', () => {
  const lit = (hp) => heartsFor(hp).reduce((n, h) => n + (h === 'full' ? 2 : h === 'half' ? 1 : 0), 0);
  for (let hp = 1; hp <= 40; hp += 1) {
    assertTrue(lit(hp) >= lit(hp - 1), `血量 ${hp} 的亮点数不得少于 ${hp - 1}`);
  }
  // 亮点数恰好等于血量（每格血 = 半个心 = 1 亮点单位）—— 这条钉死「半心 = 1 血」不被算错
  for (let hp = 0; hp <= 40; hp += 1) {
    assertEqual(lit(hp), hp, `血量 ${hp} 的亮点单位必须恰为 ${hp}`);
  }
});

test('health: 越界与非法值钳制（>满血按满血、<0/NaN 按空，绝不产出越界形态）', () => {
  // 超满血（未来若有吸收/增益）不得画出第 21 颗心或负空格
  assertDeepEqual(heartsFor(999), Array(20).fill('full'));
  // ⚠️ 边界从 21 改成 41：21 现在是**合法**血量（= 10 满 + 1 半），
  // 沿用 21 会把「合法值」误当成「越界值」测，而断言仍会绿（21 格亮 10 满 1 半
  // 的形态与「钳到满」不同，所以那条会红 —— 正是它揭示了边界搬家的必要）。
  assertDeepEqual(heartsFor(41), Array(20).fill('full'));
  // 负血 / NaN / 非数 → 全空（缺陷形态是静默画错，不是抛异常）
  assertDeepEqual(heartsFor(-5), Array(20).fill('empty'));
  assertDeepEqual(heartsFor(NaN), Array(20).fill('empty'));
  assertDeepEqual(heartsFor(undefined), Array(20).fill('empty'));
  // 小数血：向下取整到格（1.9 血 = 1 格亮点 = 半心），不得产出非法形态
  const frac = heartsFor(1.9);
  assertEqual(frac.length, 20);
  assertEqual(frac[0], 'half', '1.9 血向下取整到 1 格 = 首颗半心');
});


// ==================== applyDamage：v2.55 焰魔扣血 ====================

test('applyDamage: 正常扣血', () => {
  assertEqual(applyDamage(40, 3), 37);
  assertEqual(applyDamage(10, 10), 0);
  assertEqual(applyDamage(4, 3), 1);
});

test('applyDamage: 下限钳到 0（用户裁定「停在 0 不动」）', () => {
  assertEqual(applyDamage(1, 3), 0);
  assertEqual(applyDamage(0, 99), 0);
  assertEqual(applyDamage(2, 100), 0);
});

test('applyDamage: 负数伤害不收血（不是治疗）', () => {
  assertEqual(applyDamage(40, -5), 40);
  assertEqual(applyDamage(10, -5), 10);
});

test('applyDamage: 结果永不超过满血', () => {
  for (let hp = 0; hp <= 40; hp++) {
    for (const dmg of [0, 1, 14, 100]) {
      const r = applyDamage(hp, dmg);
      assertTrue(r >= 0 && r <= PLAYER_MAX_HEALTH, `hp=${hp} dmg=${dmg} → ${r}`);
    }
  }
});

test('applyDamage: 非法值不产生 NaN（血量按满血兜底，伤害按 0）', () => {
  assertEqual(applyDamage(NaN, 3), PLAYER_MAX_HEALTH - 3);
  assertEqual(applyDamage(undefined, 3), PLAYER_MAX_HEALTH - 3);
  assertEqual(applyDamage(20, NaN), 20);
  assertEqual(applyDamage(20, Infinity), 20);
  assertEqual(applyDamage(20, -Infinity), 20);
  assertEqual(applyDamage(20, '5'), 20);   // 字符串伤害不生效（不是隐式转换）
});

test('applyDamage: 焰魔的一击（14）打三次才让满血归 0（血量翻倍后的新标定）', () => {
  // ⚠️ 这条在 v3.29 之前是「两次即死」（20 格血 ÷ 14 = 2 刀）—— 那是作者原版的压迫感。
  // 用户 2026-11-21 裁定血量翻倍后，同一句压迫感的形态变成三刀（40 ÷ 14 = 2.86 ⇒ 3 刀）。
  // 改回两次的形态是「断言描述想象中的世界」（40 格血下两刀后还剩 12）。
  let hp = PLAYER_MAX_HEALTH;
  hp = applyDamage(hp, 14);
  assertEqual(hp, 26);
  hp = applyDamage(hp, 14);
  assertEqual(hp, 12);
  hp = applyDamage(hp, 14);
  assertEqual(hp, 0);
});

test('applyDamage: 纯函数（不改输入、同参同结果）', () => {
  const hp = 40;
  assertEqual(applyDamage(hp, 5), 35);
  assertEqual(hp, 40, '输入未被修改');
  assertEqual(applyDamage(hp, 5), applyDamage(hp, 5));
});
