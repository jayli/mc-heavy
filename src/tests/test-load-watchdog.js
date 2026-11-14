// src/tests/test-load-watchdog.js — 启动进展计时器（v2.99）
//
// 失效形态（为什么要单测而非只靠 E2E）：判据错了有**两个相反的坏方向**，都很难在 E2E 里稳定复现 ——
//
//   ① 太敏感：慢网络下（有进展但慢）误判「卡住」→ 玩家看到「网络似乎已断开」，
//      而其实脚本还在一个个下载。这是本 Epic 要消灭的形态本身。
//   ② 太迟钝：真挂死时永不触发 → 玩家对着一根冻住的进度条无限等，没有任何自救入口。
//
// 两个方向都要求精确到毫秒的边界，故全部用**假时钟**（注入 `now`），不依赖真实等待。
import { test } from './runner.js';
import { assertEqual, assertFalse } from './assert.js';
import { LoadWatchdog } from '../core/load-watchdog.js';

/** 假时钟：手动推进，全程不用真等待（真等待会让 harness 的整页耗时不可控） */
function fakeClock() {
  let t = 0;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('LoadWatchdog: 每 30s 有进展 → 5 分钟内永不 stall（慢但不断线不得误杀）', () => {
  const c = fakeClock();
  const w = new LoadWatchdog({ now: c.now });
  for (let i = 0; i < 10; i++) {
    c.advance(30_000);
    w.notifyProgress();
    assertEqual(w.poll(), 'ok', `第 ${i + 1} 次 30s 后有进展，不得 stall`);
  }
});

test('LoadWatchdog: 零进展恰好 60s 触发一次 stall，之后 poll 不再重复报', () => {
  const c = fakeClock();
  const w = new LoadWatchdog({ now: c.now });
  w.notifyProgress();
  c.advance(59_999);
  assertEqual(w.poll(), 'ok', '59.999s 未到阈值');
  c.advance(1);
  assertEqual(w.poll(), 'stall', '正好 60s 必须触发');
  assertEqual(w.poll(), 'ok', '同一次 stall 只报一次（否则 UI 会被反复弹）');
  c.advance(60_000);
  assertEqual(w.poll(), 'ok', 'stalled 状态持续期间不重复报');
});

test('LoadWatchdog: reset() 后可再次 stall（玩家点「继续等待」）', () => {
  const c = fakeClock();
  const w = new LoadWatchdog({ now: c.now });
  c.advance(60_000);
  assertEqual(w.poll(), 'stall');
  w.reset();
  c.advance(30_000);
  assertEqual(w.poll(), 'ok', 'reset 后计时归零');
  c.advance(30_000);
  assertEqual(w.poll(), 'stall', 'reset 后满 60s 应再次 stall');
});

test('LoadWatchdog: 总时长超 hardCapMs 返回 hard-cap（独立于 stall）', () => {
  const c = fakeClock();
  const w = new LoadWatchdog({ now: c.now });
  // 一直有进展 ⇒ 永不 stall —— 只能靠 hardCap 兜（「每 59s 挪一格」的假进展）
  for (let i = 0; i < 19; i++) { c.advance(30_000); w.notifyProgress(); }
  assertEqual(w.poll(), 'ok', '9.5 分钟仍在正常区间');
  c.advance(30_000); w.notifyProgress(); // 10.0 分钟
  assertEqual(w.poll(), 'hard-cap', '到 10 分钟必须报 hard-cap');
});

test('LoadWatchdog: state() 暴露两个耗时（诊断文案要用）', () => {
  const c = fakeClock();
  const w = new LoadWatchdog({ now: c.now });
  c.advance(10_000); w.notifyProgress();
  c.advance(5_000);
  const s = w.state();
  assertEqual(s.elapsedMs, 15_000);
  assertEqual(s.sinceProgressMs, 5_000);
  assertFalse(s.stalled);
});
