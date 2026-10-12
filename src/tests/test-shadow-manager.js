// src/tests/test-shadow-manager.js — 太阳阴影刷新节流（Tier 1 纯函数）
// 本文件覆盖「改坏了肉眼玩不出来」的部分：节流窗口的边界判定（≥ 而不是 >）、
// pending 补刷不丢请求（丢请求 = 放块后影子停在原地，只有像素实测才看得出来）。
//
// ⚠️ 时间参数显式传入（tick(nowMs) 无时钟依赖），故用例完全确定性 —— 不受机器负载影响。
import { test } from './runner.js';
import { assertTrue, assertFalse } from './assert.js';
import { ShadowScheduler } from '../render/shadow-manager.js';

test('shadow：首次 request 后 tick 立即刷新', () => {
  const s = new ShadowScheduler();
  s.request();
  assertTrue(s.tick(1000), '首次请求无历史刷新时刻，应立即刷新');
});

test('shadow：200ms 内的重复请求被节流', () => {
  const s = new ShadowScheduler();
  s.request();
  assertTrue(s.tick(1000), '首帧刷新');
  s.request();
  assertFalse(s.tick(1100), '距上次刷新仅 100ms < 200ms，应被节流');
});

test('shadow：节流期内的请求不丢（pending 补刷）', () => {
  const s = new ShadowScheduler();
  s.request();
  assertTrue(s.tick(1000), '首帧刷新');
  s.request();
  assertFalse(s.tick(1100), '节流期内不刷新');
  assertTrue(s.tick(1250), '距 1000 已 250ms ≥ 200ms，补刷挂起的请求');
});

test('shadow：无请求时 tick 恒 false', () => {
  const s = new ShadowScheduler();
  assertFalse(s.tick(5000), '从未 request，不应刷新');
  s.request();
  assertTrue(s.tick(5001), '有请求则刷新');
  assertFalse(s.tick(9999), '刷新后无新请求，恒 false');
});

test('shadow：minIntervalMs 可配', () => {
  const s = new ShadowScheduler({ minIntervalMs: 50 });
  s.request();
  assertTrue(s.tick(0), '首次刷新');
  s.request();
  assertFalse(s.tick(49), '49 < 50，节流');
  assertTrue(s.tick(50), '50 ≥ 50，边界应放行');
});
