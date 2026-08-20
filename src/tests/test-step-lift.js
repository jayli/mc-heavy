import { test } from './runner.js';
import { assertTrue } from './assert.js';
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
