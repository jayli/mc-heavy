// src/tests/test-damage-flash.js — 受伤红闪的纯函数契约（Tier 1）
//
// 只有淡出包络是有对错可言的逻辑（越界、NaN、边界）；DOM 布局与像素可见性
// 由 `tests/damage-flash.spec.mjs` 的 Tier 4 用例覆盖。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { DAMAGE_FLASH, flashOpacityAt } from '../ui/damage-flash.js';

test('damage flash: 常量口径（用户 2026-11-21 裁定）', () => {
  assertEqual(DAMAGE_FLASH.bandPx, 40, '屏幕四周 40 像素');
  assertEqual(DAMAGE_FLASH.lifeMs, 350, '0.35 秒淡出');
  assertTrue(DAMAGE_FLASH.zIndex > 55, '必须高于伤害数字 55');
  assertTrue(DAMAGE_FLASH.zIndex < 60, '必须低于设置按钮 60');
  assertTrue(DAMAGE_FLASH.zIndex < 100, '绝不得取 100+（会盖掉启动错误遮罩）');
  assertTrue(DAMAGE_FLASH.maxAlpha > 0 && DAMAGE_FLASH.maxAlpha < 1, '半透明红');
});

test('damage flash: 淡出包络（起点全亮、终点归零、中点半亮）', () => {
  assertEqual(flashOpacityAt(0), 1, '刚被打中 = 全亮');
  assertEqual(flashOpacityAt(DAMAGE_FLASH.lifeMs), 0, '寿命到 = 全透明');
  assertTrue(Math.abs(flashOpacityAt(DAMAGE_FLASH.lifeMs / 2) - 0.5) < 0.02, '中点半亮（线性）');
});

test('damage flash: 越界与非法值一律钳制，不抛异常', () => {
  assertEqual(flashOpacityAt(-100), 1, '负 age 按刚触发算（不返 >1）');
  assertEqual(flashOpacityAt(DAMAGE_FLASH.lifeMs * 10), 0, '远超寿命 = 0');
  assertEqual(flashOpacityAt(NaN), 0, 'NaN 不产生 NaN 透明度（否则 DOM 写入被静默忽略）');
  assertEqual(flashOpacityAt(undefined), 0, 'undefined 同上');
  assertEqual(flashOpacityAt(Infinity), 0, 'Infinity 同上');
});

test('damage flash: 包络单调不增（不得中途回亮）', () => {
  let prev = 1;
  for (let t = 0; t <= DAMAGE_FLASH.lifeMs; t += 10) {
    const o = flashOpacityAt(t);
    assertTrue(o <= prev + 1e-9, `t=${t} 时 ${o} > 前值 ${prev}`);
    prev = o;
  }
});

test('damage flash: 包络在 [0, lifeMs] 内恒在 [0,1]（写进 style.opacity 不会越界）', () => {
  for (let t = -50; t <= DAMAGE_FLASH.lifeMs + 50; t += 5) {
    const o = flashOpacityAt(t);
    assertTrue(o >= 0 && o <= 1, `t=${t} 时 ${o} 越界`);
  }
});
