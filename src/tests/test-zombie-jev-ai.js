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
import { FailureBreaker, JevClient } from '../entities/zombies/zombie-jev-client.js';
import {
  QUESTION_ID, STEP_INSTRUCTIONS, buildQuestions, criterionFor, SITUATION, WINDOW_LEGEND,
} from '../entities/zombies/zombie-jev-prompts.js';
import {
  DIRECTION_VECTORS, cellKey, memoryFor, noteVisit, sampleGroundWindow,
  bearingWords, buildCandidateSteps, buildJevState, markDeadEnd, parseDirectionChoice,
} from '../entities/zombies/zombie-ai-view.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';
import { createRegistry } from '../voxel/block-registry.js';
import { WORLD_MIN_Y } from '../voxel/constants.js';

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

// ---------- 地面窗口采样（Task 2）----------

/** 平地 fixture：指定 (cx,cz) column 内 y<=solidTop 全 stone，其余 air */
function makeWindowWorld({ columns = [[0, 0]], solidTop = 0 } = {}) {
  const registry = createRegistry();
  registry.register('air', { solid: false, opaque: false, cullMode: 'none' });
  registry.register('stone', { solid: true, opaque: true, cullMode: 'opaque' });
  registry.register('bedrock', { solid: true, opaque: true, cullMode: 'opaque' });
  const world = new WorldData(registry);
  const stone = registry.idOf('stone');
  for (const [cx, cz] of columns) {
    const col = new ChunkColumn(cx, cz);
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        for (let y = WORLD_MIN_Y; y <= solidTop; y++) col.set(lx, y, lz, stone);
      }
    }
    world.add(col);
  }
  return { world, registry };
}

test('sampleGroundWindow：尺寸为 9×9，丧尸在正中（Z），平地全可走', () => {
  const { world } = makeWindowWorld();
  const rows = sampleGroundWindow(world, [8.5, 1, 8.5], [8.5, 1, 4.5]);
  assertEqual(rows.length, JEV_AI.windowSize);
  for (const r of rows) assertEqual(r.length, JEV_AI.windowSize);
  const mid = (JEV_AI.windowSize - 1) / 2;
  assertEqual(rows[mid][mid], 'Z');
  // 玩家在丧尸正北 4 格 → 窗口内 (mid-4, mid) 是 P
  assertEqual(rows[mid - 4][mid], 'P');
  const others = rows.join('').replace(/[ZP]/g, '');
  assertEqual([...others].filter((c) => c !== '.').length, 0, '平地窗口不该有 #');
});

test('sampleGroundWindow：两格高的墙写 #，未加载 column 也写 #', () => {
  const { world, registry } = makeWindowWorld({ columns: [[0, 0]] });
  const stone = registry.idOf('stone');
  // ⚠️ **必须两格高**：一格高是「可上台阶」，判定为可走（见下一条用例）。
  // 一层方块写 # 会让本用例与下一条直接矛盾 —— 计划初稿就是这么写的，由 RED 抓到。
  world.setBlock(8, 1, 7, stone);
  world.setBlock(8, 2, 7, stone);
  const rows = sampleGroundWindow(world, [8.5, 1, 8.5], [8.5, 1, 12.5]);
  const mid = (JEV_AI.windowSize - 1) / 2;
  assertEqual(rows[mid - 1][mid], '#', '北一格是两格高的墙');
  const far = sampleGroundWindow(world, [15.5, 1, 8.5], [15.5, 1, 12.5]);
  const fm = (JEV_AI.windowSize - 1) / 2;
  assertEqual(far[fm][fm + 1], '#', 'x=16 未加载须当墙');
});

test('sampleGroundWindow：抬一格可走的台阶写成 "."（复用 step-up 判据）', () => {
  const { world, registry } = makeWindowWorld();
  const stone = registry.idOf('stone');
  world.setBlock(8, 1, 7, stone);
  const rows = sampleGroundWindow(world, [8.5, 1, 8.5], [8.5, 1, 12.5]);
  const mid = (JEV_AI.windowSize - 1) / 2;
  assertEqual(rows[mid - 1][mid], '.', '一格台阶应可走');
});

// ---------- 候选事实与 state（Task 3）----------

const memOf = memoryFor;

test('bearingWords：方位文案（参数是 [x,z]：z 减小为北、x 减小为西）', () => {
  assertEqual(bearingWords([0, 0], [1, 1]), 'south and east');  // x+1 东、z+1 南
  assertEqual(bearingWords([0, 0], [1, 0]), 'east');            // 只动 x
  assertEqual(bearingWords([0, 0], [0, 1]), 'south');           // 只动 z
  assertEqual(bearingWords([0, 0], [0, -3]), 'north');
  assertEqual(bearingWords([0, 0], [-2, 0]), 'west');
  assertEqual(bearingWords([0, 0], [0, 0]), 'the same square');
});

test('buildCandidateSteps：只含可走方向，四面围墙时为空', () => {
  const { world, registry } = makeWindowWorld();
  const all = buildCandidateSteps(world, [8.5, 1, 8.5], [8.5, 1, 12.5], memOf(new Map(), 'z'));
  assertEqual(Object.keys(all).length, 8, '平地 8 个方向都可走');
  for (const [name, f] of Object.entries(all)) {
    assertEqual(f.direction, name.replace('_', ' '));
    assertEqual(f.times_already_visited, 0);
    assertTrue(typeof f.open_ground_ahead === 'string' && f.open_ground_ahead.endsWith('meters'));
  }
  const stone = registry.idOf('stone');
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue;
      for (let dy = 0; dy < 3; dy++) world.setBlock(8 + dx, 1 + dy, 8 + dz, stone);
    }
  }
  const none = buildCandidateSteps(world, [8.5, 1, 8.5], [8.5, 1, 12.5], memOf(new Map(), 'z'));
  assertEqual(Object.keys(none).length, 0, '四面围死时无候选');
});

test('buildCandidateSteps：times_already_visited 来自记忆', () => {
  const { world } = makeWindowWorld();
  const mem = memOf(new Map(), 'z');
  // ⚠️ 坐标是 (x, z)：丧尸在格 (8,8)，北一格是 (8,7)
  noteVisit(mem, 8, 7);
  const cands = buildCandidateSteps(world, [8.5, 1, 8.5], [8.5, 1, 12.5], mem);
  assertEqual(cands.north.times_already_visited, 1);
  assertEqual(cands.south.times_already_visited, 0);
});

test('buildCandidateSteps：死胡同标记进候选事实', () => {
  const { world } = makeWindowWorld();
  const mem = memOf(new Map(), 'z');
  markDeadEnd(mem, 8, 7);   // (x,z)：北一格
  const cands = buildCandidateSteps(world, [8.5, 1, 8.5], [8.5, 1, 12.5], mem);
  assertEqual(cands.north.marked_dead_end, true);
  assertEqual(cands.south.marked_dead_end, false);
});

test('buildJevState：形状与 spec §3.5 一致，可 JSON 序列化', () => {
  const { world } = makeWindowWorld();
  const st = buildJevState(world, [8.5, 1, 8.5], [8.5, 1, 4.5], memOf(new Map(), 'z'));
  assertTrue(typeof st.situation === 'string' && st.situation.length > 20);
  assertEqual(st.player_direction_from_zombie, 'north');
  assertTrue(st.straight_line_distance_now.endsWith('meters'));
  assertEqual(st.steps_already_walked, 0);
  assertEqual(st.ground_window.rows.length, JEV_AI.windowSize);
  assertEqual(st.ground_window.top_is, 'north');
  assertEqual(st.ground_window.left_is, 'west');
  assertTrue(st.ground_window.legend.length > 50);
  assertTrue(Object.keys(st.candidate_steps).length > 0);
  assertEqual(JSON.parse(JSON.stringify(st)).ground_window.rows.length, JEV_AI.windowSize);
});

// ---------- 题面（Task 4）----------

test('buildQuestions：1 个 choice，题名 step，选项 = 可走方向', () => {
  const { world } = makeWindowWorld();
  const st = buildJevState(world, [8.5, 1, 8.5], [8.5, 1, 12.5], memOf(new Map(), 'z'));
  const qs = buildQuestions(st.candidate_steps);
  assertEqual(Object.keys(qs).length, 1);
  assertEqual(QUESTION_ID, 'step');
  const q = qs.step;
  assertEqual(q.type, 'choice');
  assertEqual(q.instructions, STEP_INSTRUCTIONS);
  assertDeepEqual(Object.keys(q.criteria).sort(), Object.keys(st.candidate_steps).sort());
});

test('buildQuestions：无候选时返回空对象（不发请求）', () => {
  assertDeepEqual(buildQuestions({}), {});
});

test('criterionFor：包含方位、距离、走廊长度、访问次数、死胡同', () => {
  const text = criterionFor('north', {
    direction: 'north',
    player_lies_toward: 'north and west',
    straight_line_distance_after_step: '12.3 meters',
    closer_or_farther: 'closer to the player',
    open_ground_ahead: '6 meters',
    other_ways_out_after_the_step: 2,
    times_already_visited: 3,
    marked_dead_end: true,
  });
  for (const frag of ['north', '12.3 meters', 'closer to the player', '6 meters', '3 times', 'dead end']) {
    assertTrue(text.includes(frag), `criterion 缺片段 ${frag}: ${text}`);
  }
});

test('文案常量：legend 必须解释 # 含「未加载」（spec §3.5）', () => {
  assertTrue(WINDOW_LEGEND.includes('not loaded'), 'legend 必须说明未加载地形也画成 #');
  assertTrue(SITUATION.length > 30);
  assertFalse(STEP_INSTRUCTIONS.includes('\n'), '题干不应换行（保持单段）');
});

// ---------- 答案解析（Task 5）----------

test('parseDirectionChoice：合法方向给出单位向量', () => {
  const cands = { north: {}, east: {} };
  const r = parseDirectionChoice({ type: 'choice', choice: 'north' }, cands);
  assertTrue(r.ok);
  assertEqual(r.direction, 'north');
  assertEqual(r.vx, 0);
  assertEqual(r.vz, -1, 'north 是 z 减小');
  const e = parseDirectionChoice({ type: 'choice', choice: 'east' }, cands);
  assertEqual(e.vx, 1);
  assertEqual(e.vz, 0);
});

test('parseDirectionChoice：对角线是单位向量（不是 (±1,±1)）', () => {
  const r = parseDirectionChoice({ choice: 'north_east' }, { north_east: {} });
  assertTrue(r.ok);
  const len = Math.hypot(r.vx, r.vz);
  assertTrue(Math.abs(len - 1) < 1e-9, `须单位向量，实际长度 ${len}`);
});

test('parseDirectionChoice：三种失败 reason 逐条独立（不合成一句）', () => {
  assertEqual(parseDirectionChoice(null, { north: {} }).reason, 'no-answer');
  assertEqual(parseDirectionChoice({}, { north: {} }).reason, 'no-answer');
  assertEqual(parseDirectionChoice({ choice: 'up' }, { north: {} }).reason, 'unknown-direction');
  assertEqual(parseDirectionChoice({ choice: 'south' }, { north: {} }).reason, 'blocked-direction');
});

test('parseDirectionChoice：答案里的 choice 不在候选表时不得放行', () => {
  const cands = { north: {} };
  const r = parseDirectionChoice({ choice: 'north_east' }, cands);
  assertFalse(r.ok, '不在候选表里的方向一律拒绝');
});

// ---------- HTTP 客户端（Task 6）----------

/** 记录 warn 调用的假 logger（断言「每个失败都必须打 log」） */
function makeLogger() {
  const warns = [];
  return { warns, warn: (...a) => warns.push(a.join(' ')), info: () => {}, error: (...a) => warns.push(a.join(' ')) };
}

/** 造一个只回固定响应的假 fetch（并记录调用） */
function fakeFetch(responder) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return responder(url, init); };
  fn.calls = calls;
  return fn;
}

const okJson = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });

test('JevClient：成功时返回 answer，并以 POST + JSON 打到 endpoint', async () => {
  const log = makeLogger();
  const f = fakeFetch(() => okJson({ model: 'jev-1.14.0', answers: { step: { type: 'choice', choice: 'north' } } }));
  const c = new JevClient({ fetchImpl: f, log });
  const r = await c.request({ state: { a: 1 }, questions: { step: { type: 'choice', criteria: { north: 'x' } } } });
  assertTrue(r.ok);
  assertEqual(r.answer.choice, 'north');
  assertEqual(r.model, 'jev-1.14.0');
  assertEqual(f.calls.length, 1);
  assertEqual(f.calls[0].url, JEV_AI.endpoint);
  assertEqual(f.calls[0].init.method, 'POST');
  assertEqual(f.calls[0].body.model, 'jev-latest');
  assertEqual(f.calls[0].body.state.a, 1);
});

test('JevClient：网关拦截返回 HTML → reason=not-json 且打 warn', async () => {
  const log = makeLogger();
  const f = fakeFetch(() => ({ ok: false, status: 403, text: async () => '<html>抱歉，您要访问的域名…</html>' }));
  const c = new JevClient({ fetchImpl: f, log });
  const r = await c.request({ state: {}, questions: { step: {} } });
  assertFalse(r.ok);
  assertEqual(r.reason, 'not-json', 'HTML 必须是 not-json，绝不能读成「没有方向」');
  assertTrue(log.warns.some((w) => w.includes('[zombie-ai]') && w.includes('not-json')));
});

test('JevClient：HTTP 错误码带上状态码', async () => {
  const log = makeLogger();
  const f = fakeFetch(() => ({ ok: false, status: 429, text: async () => '{"detail":"rate"}' }));
  const c = new JevClient({ fetchImpl: f, log });
  const r = await c.request({ state: {}, questions: { step: {} } });
  assertEqual(r.reason, 'http-429');
});

test('JevClient：网络异常 → network-error（不 reject）', async () => {
  const log = makeLogger();
  const f = async () => { throw new Error('ECONNREFUSED'); };
  const c = new JevClient({ fetchImpl: f, log });
  const r = await c.request({ state: {}, questions: { step: {} } });
  assertEqual(r.reason, 'network-error');
});

test('JevClient：JSON 里没有 answers.step → no-answer', async () => {
  const log = makeLogger();
  const f = fakeFetch(() => okJson({ model: 'x', answers: {} }));
  const c = new JevClient({ fetchImpl: f, log });
  const r = await c.request({ state: {}, questions: { step: {} } });
  assertEqual(r.reason, 'no-answer');
});

test('JevClient：空 questions 不发请求（省额度）', async () => {
  const f = fakeFetch(() => okJson({}));
  const c = new JevClient({ fetchImpl: f, log: makeLogger() });
  const r = await c.request({ state: {}, questions: {} });
  assertEqual(r.reason, 'no-answer');
  assertEqual(f.calls.length, 0);
});

// ---------- 失败熔断（Task 7）----------

test('FailureBreaker：连续 3 次失败进入冷却，期间 available=false', () => {
  const log = makeLogger();
  let t = 1000;
  const b = new FailureBreaker({ now: () => t, log });
  assertTrue(b.available());
  b.recordFailure('network-error');
  b.recordFailure('timeout');
  b.recordFailure('not-json');
  assertFalse(b.available(), '3 次后进入冷却');
  assertTrue(log.warns.some((w) => w.includes('suspended')), '进入冷却须打日志');
  t += JEV_AI.cooldownMs - 1;
  assertFalse(b.available(), '冷却未到仍不可用');
  t += 2;
  assertTrue(b.available(), '冷却到点恢复');
  assertEqual(b.state().fails, 0, '恢复后计数清零');
});

test('FailureBreaker：任意一次成功清零计数', () => {
  const b = new FailureBreaker({ now: () => 0, log: makeLogger() });
  b.recordFailure('x');
  b.recordFailure('y');
  b.recordSuccess();
  assertEqual(b.state().fails, 0);
  b.recordFailure('z');
  assertTrue(b.available(), '清零后一次失败不该触发冷却');
});

test('FailureBreaker：失败与成功交替永不冷却', () => {
  const b = new FailureBreaker({ now: () => 0, log: makeLogger() });
  for (let i = 0; i < 5; i++) { b.recordFailure('f'); b.recordSuccess(); }
  assertTrue(b.available());
});

test('FailureBreaker：冷却期内的失败不累计（否则恢复后立刻又进冷却）', () => {
  let t = 0;
  const b = new FailureBreaker({ now: () => t, log: makeLogger() });
  b.recordFailure('a'); b.recordFailure('b'); b.recordFailure('c');
  const openUntil = b.state().openUntil;
  t += 10;
  b.recordFailure('during-cooldown');
  assertEqual(b.state().openUntil, openUntil, '冷却期不得延长');
});
