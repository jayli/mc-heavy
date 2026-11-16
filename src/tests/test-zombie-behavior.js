// src/tests/test-zombie-behavior.js — 丧尸行为层（犹豫/后退/徘徊/速度包络/转身限速）
//
// 设计：docs/superpowers/specs/2026-11-16-zombie-behavior-realism-design.md
// 计划：docs/superpowers/plans/2026-11-16-zombie-behavior-realism.md
//
// ⚠️ 断言里的期望值一律用**字面量**，不从被测常量派生（testing-policy §2.7 第 7 类：
// 输入从被测常量派生时，注入把常量改错的缺陷会让断言恒真）。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { ZOMBIE_BEHAVIOR } from '../entities/zombies/zombie-config.js';

// ==================== Task 1：冻结常量表 ====================

test('ZOMBIE_BEHAVIOR: 阈值取实测标定值', () => {
  assertEqual(ZOMBIE_BEHAVIOR.arriveDistance, 1.5);
  assertEqual(ZOMBIE_BEHAVIOR.stuckWindowSeconds, 1.5);
  assertEqual(ZOMBIE_BEHAVIOR.stuckDistance, 0.35);
  assertEqual(ZOMBIE_BEHAVIOR.awayAngleDeg, 120);
  assertEqual(ZOMBIE_BEHAVIOR.cruiseScaleMin, 0.92);
  assertEqual(ZOMBIE_BEHAVIOR.turnRateDegPerSec, 540);
});

test('ZOMBIE_BEHAVIOR: 载荷性不变式（到达门/巡航下界/卡住阈值/区间顺序）', () => {
  // ① 到达门必须大于正常抵达距离 0.67（实测），否则「追到就退开」
  assertTrue(ZOMBIE_BEHAVIOR.arriveDistance > 0.67, '到达门须大于实测抵达距离 0.67');
  // ② 到达门必须小于信号B距离门（两信号职责不重叠：A 管远而走不动，B 管近而没路）
  assertTrue(ZOMBIE_BEHAVIOR.arriveDistance < ZOMBIE_BEHAVIOR.nearPlayerDistance,
    '到达门须小于信号B距离门');
  // ③ 巡航下界不得低于 0.90（既有 12s 绕墙 E2E 的实测余量：0.80 贴线、0.70 FAIL）
  assertTrue(ZOMBIE_BEHAVIOR.cruiseScaleMin >= 0.90, '巡航下界须保住既有 E2E 余量');
  assertTrue(ZOMBIE_BEHAVIOR.cruiseScaleMax <= 1.0, '巡航不得超过 ZOMBIE.speed');
  // ④ 卡住阈值须小于正常绕墙的窗口净位移最小值 0.85（实测）
  assertTrue(ZOMBIE_BEHAVIOR.stuckDistance < 0.85, '卡住阈值须小于正常绕墙最小净位移');
  // ⑤ 区间上下界顺序
  assertTrue(ZOMBIE_BEHAVIOR.hesitateSecondsMin < ZOMBIE_BEHAVIOR.hesitateSecondsMax);
  assertTrue(ZOMBIE_BEHAVIOR.backoffDistanceMin < ZOMBIE_BEHAVIOR.backoffDistanceMax);
  assertTrue(ZOMBIE_BEHAVIOR.cruisePeriodSecondsMin < ZOMBIE_BEHAVIOR.cruisePeriodSecondsMax);
  assertTrue(ZOMBIE_BEHAVIOR.paceStepsMin <= ZOMBIE_BEHAVIOR.paceStepsMax);
  // ⑥ 各状态速度倍率都不得超过 1（速度上限权威仍是 ZOMBIE.speed）
  assertTrue(ZOMBIE_BEHAVIOR.backoffSpeedScale <= 1.0);
  assertTrue(ZOMBIE_BEHAVIOR.wanderSpeedScale <= 1.0);
  assertTrue(ZOMBIE_BEHAVIOR.turnSlowFloor > 0 && ZOMBIE_BEHAVIOR.turnSlowFloor <= 1.0);
});