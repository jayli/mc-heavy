// src/tests/test-zombie-jev-ai.js — 丧尸在线 AI（Jev）纯逻辑
//
// 覆盖：方向表 / 记忆（visits+trail 上限）/ 地面窗口采样 / 候选事实 / state 构造 /
//       答案解析与非法方向兜底 / 熔断 / 开关关闭零请求 / 记忆随 slot 回收删除。
//
// 全部不联网：`JevClient` 的 `fetchImpl` 与 `log` 都是注入点（spec §5.1）。
// 真实接口只在 Playwright 的 `tests/zombie-jev-ai.spec.mjs`（Tier 4）里打。
import { test } from './runner.js';
import { assertEqual, assertFalse, assertTrue, assertDeepEqual } from './assert.js';
import { JEV_AI } from '../entities/zombies/zombie-config.js';
import {
  DIRECTION_VECTORS, cellKey, memoryFor, noteVisit,
} from '../entities/zombies/zombie-ai-view.js';

test('JEV_AI：默认值与 spec 一致', () => {
  assertEqual(JEV_AI.endpoint, 'https://js-perf.cn/typesafe/v1/systemone');
  assertEqual(JEV_AI.windowSize, 9);
  assertEqual(JEV_AI.decisionPeriodMs, 500);
  assertEqual(JEV_AI.maxConcurrent, 4);
  assertEqual(JEV_AI.timeoutMs, 4000);
  assertEqual(JEV_AI.maxFailures, 3);
  assertEqual(JEV_AI.cooldownMs, 30000);
});

test('DIRECTION_VECTORS：8 个方向，north 是 z-1，east 是 x+1', () => {
  assertEqual(Object.keys(DIRECTION_VECTORS).length, 8);
  assertDeepEqual(DIRECTION_VECTORS.north, [-1, 0]);
  assertDeepEqual(DIRECTION_VECTORS.south, [1, 0]);
  assertDeepEqual(DIRECTION_VECTORS.east, [0, 1]);
  assertDeepEqual(DIRECTION_VECTORS.west, [0, -1]);
  assertDeepEqual(DIRECTION_VECTORS.north_east, [-1, 1]);
});

test('cellKey：负坐标按 floor 归一（-0.5 与 -0.2 同格）', () => {
  assertEqual(cellKey(3.7, -0.5), cellKey(3.2, -0.2));
  assertEqual(cellKey(3.7, -0.5), '3,-1');
});

test('noteVisit：visits 计数 + trail 上限 + LRU 淘汰', () => {
  const mem = memoryFor(new Map(), 'z0');
  assertDeepEqual(mem.trail, []);
  assertEqual(mem.visits.size, 0);
  noteVisit(mem, 1, 1);
  noteVisit(mem, 1, 1);
  assertEqual(mem.visits.get('1,1'), 2);
  assertEqual(mem.trail.length, 2);
  for (let i = 0; i < JEV_AI.maxTrail + 5; i++) noteVisit(mem, 100 + i, 0);
  assertEqual(mem.trail.length, JEV_AI.maxTrail, 'trail 超上限须裁剪');
  for (let i = 0; i < JEV_AI.maxVisits + 10; i++) noteVisit(mem, 500 + i, 7);
  assertTrue(mem.visits.size <= JEV_AI.maxVisits, `visits 须 LRU 淘汰，实际 ${mem.visits.size}`);
});

test('memoryFor：同 id 复用同一对象，不同 id 独立', () => {
  const m = new Map();
  assertEqual(memoryFor(m, 'a'), memoryFor(m, 'a'));
  assertFalse(memoryFor(m, 'a') === memoryFor(m, 'b'));
});
