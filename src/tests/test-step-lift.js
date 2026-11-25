import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { StepLift } from '../player/step-lift.js';

test('step-lift: 触发后 offset=-lift，衰减收敛到 0', () => {
  const sl = new StepLift();
  sl.trigger(1);
  assertTrue(sl.offset === -1, `offset=${sl.offset}`);
  for (let i = 0; i < 120; i++) sl.update(1 / 60);
  assertTrue(sl.offset === 0, `converged, got ${sl.offset}`);
});

test('step-lift: ease-out 衰减 ~200ms 到 15% 以内', () => {
  const sl = new StepLift();
  sl.trigger(1);
  for (let i = 0; i < 12; i++) sl.update(1 / 60); // 200ms
  assertTrue(Math.abs(sl.offset) < 0.15, `offset=${sl.offset}`);
  assertTrue(sl.active, 'still active until cutoff');
});

test('step-lift: 连续上台阶滞后封顶 1 格（防相机插进楼梯）', () => {
  const sl = new StepLift();
  sl.trigger(1); sl.trigger(1); sl.trigger(1);
  assertTrue(sl.offset >= -1.0, `clamped, got ${sl.offset}`);
});

// ---- 滞后上限参数化（士兵能一次上 2 格，缺省仍是 1 格）----
//
// ⚠️ 为什么参数化而不是把 MAX_LAG 直接改成 2：玩家/丧尸/焰魔/守卫的台阶上限都是 1 格，
// 对它们来说 1 与 2 的封顶效果**逐位相同**（单次抬升不可能超 1）—— 但「连续上台阶时
// 允许欠下 2 格」会让相机/实体插进楼梯更深。缺省必须保持 1.0。

test('step-lift: 传入 maxLag=2 时单次 2 格抬升整段欠下（不被截断成 1 格）', () => {
  const sl = new StepLift(2);
  sl.trigger(2);
  assertEqual(sl.offset, -2, '整段 2 格都要缓动，不能只缓动 1 格');
});

test('step-lift: maxLag=2 时连续抬升仍按传入上限封顶', () => {
  const sl = new StepLift(2);
  sl.trigger(2); sl.trigger(2);
  assertEqual(sl.offset, -2, '累加后须被压到传入的 2 格上限');
});

test('step-lift: 缺省构造仍是 1 格上限（玩家/丧尸/焰魔/守卫零回归）', () => {
  const sl = new StepLift();
  sl.trigger(2);
  assertEqual(sl.offset, -1, '缺省不得跟着士兵变成 2');
});

test('step-lift: maxLag 只改封顶，不改衰减速率与归零阈值', () => {
  const a = new StepLift();
  const b = new StepLift(2);
  a.trigger(1); b.trigger(1);
  for (let i = 0; i < 12; i++) { a.update(1 / 60); b.update(1 / 60); }
  assertEqual(b.offset, a.offset, '同样 1 格抬升的衰减轨迹必须逐位相同');
});
