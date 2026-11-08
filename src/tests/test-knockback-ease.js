// src/tests/test-knockback-ease.js — 击退视觉补间（v2.81，用户缺陷：后退是瞬移）
//
// 分工见 `render/knockback-ease.js` 的模块注释：权威位置瞬时、只有渲染位置滞后。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { KnockbackEase, KNOCKBACK_EASE_MAX_LAG } from '../render/knockback-ease.js';

test('击退缓动: 触发后 offset 欠下整段位移，收敛到 0', () => {
  const kb = new KnockbackEase();
  kb.trigger(0.6, 0.8); // 长度 1.0
  assertTrue(Math.abs(kb.offsetX - 0.6) < 1e-12, `offsetX=${kb.offsetX}`);
  assertTrue(Math.abs(kb.offsetZ - 0.8) < 1e-12, `offsetZ=${kb.offsetZ}`);
  for (let i = 0; i < 120; i++) kb.update(1 / 60);
  assertEqual(kb.offsetX, 0, '收敛后 offsetX 必须精确为 0（不是趋近 0）');
  assertEqual(kb.offsetZ, 0, '收敛后 offsetZ 必须精确为 0');
  assertTrue(!kb.active, '收敛后不应还在补间');
});

test('击退缓动: ease-out —— 50ms 走完约一半，165ms 走完 90%', () => {
  // 用户 2026-11-08 选定「约 0.2 秒走完」。判据按指数衰减的理论值给区间，
  // 不锁死具体帧数（改曲线形状时这里该红，改机器负载时不该红）。
  const kb = new KnockbackEase();
  kb.trigger(1, 0);
  for (let i = 0; i < 3; i++) kb.update(1 / 60); // 50ms
  const at50 = kb.offsetX;
  assertTrue(at50 > 0.35 && at50 < 0.65, `50ms 后剩余 ${at50.toFixed(3)}（应约 0.55）`);
  for (let i = 0; i < 7; i++) kb.update(1 / 60); // 累计 166ms
  const at166 = kb.offsetX;
  assertTrue(at166 > 0.02 && at166 < 0.2, `166ms 后剩余 ${at166.toFixed(3)}（应约 0.14）`);
});

test('击退缓动: 连续击退累加而不是重置（渲染位置不跳变）', () => {
  const kb = new KnockbackEase();
  kb.trigger(1, 0);
  for (let i = 0; i < 6; i++) kb.update(1 / 60); // 先衰减一半左右
  const mid = kb.offsetX;
  assertTrue(mid > 0 && mid < 1, `前置：应还在补间中，实际 ${mid}`);
  kb.trigger(1, 0); // 第二刀
  assertTrue(kb.offsetX > mid, `累加后应比衰减中的值大（${kb.offsetX} > ${mid}）`);
  assertTrue(kb.offsetX <= 2.0 + 1e-12, `累加不得无限增长，实际 ${kb.offsetX}`);
});

test('击退缓动: 累计位移按方向等比截断（超上限不改变方向）', () => {
  const kb = new KnockbackEase();
  const d = 3 / Math.hypot(3, 4); // 单位向量 (0.6, 0.8)
  kb.trigger(3, 4);
  const len = Math.hypot(kb.offsetX, kb.offsetZ);
  assertTrue(Math.abs(len - KNOCKBACK_EASE_MAX_LAG) < 1e-9, `长度应被压到 ${KNOCKBACK_EASE_MAX_LAG}，实际 ${len}`);
  assertTrue(Math.abs(kb.offsetX / len - 0.6 * d / d) < 1e-9,
    `方向必须保持（x 分量 ${(kb.offsetX / len).toFixed(3)} 应约 0.6）`);
  assertTrue(Math.abs(kb.offsetZ / len - 0.8) < 1e-9,
    `方向必须保持（z 分量 ${(kb.offsetZ / len).toFixed(3)} 应约 0.8）`);
});

test('击退缓动: dt=0 与非法 dt 不改变 offset（帧循环首帧 dt 为 0）', () => {
  const kb = new KnockbackEase();
  kb.trigger(1, 0);
  kb.update(0);
  assertEqual(kb.offsetX, 1, 'dt=0 不应衰减（否则首帧就吃掉一段）');
  kb.update(NaN);
  assertEqual(kb.offsetX, 1, 'NaN 不应污染 offset');
  kb.update(-0.016);
  assertEqual(kb.offsetX, 1, '负 dt 不应反向放大');
});
