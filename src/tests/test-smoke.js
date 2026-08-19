import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';

test('harness 冒烟：断言库工作正常', () => {
  assertEqual(1 + 1, 2);
  assertTrue(true);
});
