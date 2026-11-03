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
import { JevPlanner } from '../entities/zombies/zombie-jev-planner.js';
import { ZombieService, zombieDefinition } from '../entities/zombies/zombie-system.js';
import { EntityManager } from '../entities/entity-manager.js';
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

// ---------- 编排器（Task 8）----------

/** 可手动 resolve 的假 client（控制时序，验证「在途不重复入队」） */
function makeControlledClient() {
  const pending = [];
  return {
    pending,
    request(req) {
      return new Promise((resolve) => { pending.push({ req, resolve }); });
    },
  };
}

function makePlanner(world, client, opts = {}) {
  return new JevPlanner({
    world, client,
    breaker: opts.breaker ?? new FailureBreaker({ now: () => 0, log: makeLogger() }),
    speed: 1.2, log: makeLogger(), now: opts.now ?? (() => 0),
    onDecision: opts.onDecision ?? (() => {}),
    onFallback: opts.onFallback ?? (() => {}),
  });
}

test('JevPlanner：tick 发起请求，回包后回调 onDecision（north → vz=-speed）', async () => {
  const { world } = makeWindowWorld();
  const client = makeControlledClient();
  const decisions = [];
  const p = makePlanner(world, client, { onDecision: (id, d) => decisions.push([id, d]) });
  p.setEnabled(true);
  p.tick(0, [{ id: 'z0', position: [8.5, 1, 8.5], mobile: true }]);
  assertEqual(client.pending.length, 1, '应发出一条请求');
  assertEqual(p.debugState().inflight, 1);
  client.pending[0].resolve({ ok: true, answer: { type: 'choice', choice: 'north' }, model: 'm' });
  await new Promise((r) => setTimeout(r, 0));
  assertEqual(decisions.length, 1);
  assertEqual(decisions[0][0], 'z0');
  assertTrue(Math.abs(decisions[0][1].vz + 1.2) < 1e-9, `north 应给 vz=-speed，实际 ${decisions[0][1].vz}`);
  assertEqual(p.debugState().inflight, 0);
  assertEqual(p.debugState().decided, 1);
});

test('JevPlanner：并发上限 maxConcurrent 生效', () => {
  const { world } = makeWindowWorld({ columns: [[0, 0], [0, 1], [0, -1]] });
  const client = makeControlledClient();
  const p = makePlanner(world, client);
  p.setEnabled(true);
  const zs = Array.from({ length: 10 }, (_, i) => ({ id: `z${i}`, position: [8.5, 1, 8.5], mobile: true }));
  p.tick(0, zs);
  assertEqual(client.pending.length, JEV_AI.maxConcurrent, '在途不得超过上限');
});

test('JevPlanner：同一只在途期间不重复入队', () => {
  const { world } = makeWindowWorld();
  const client = makeControlledClient();
  const p = makePlanner(world, client);
  p.setEnabled(true);
  const z = [{ id: 'z0', position: [8.5, 1, 8.5], mobile: true }];
  p.tick(0, z);
  p.tick(10, z);
  assertEqual(client.pending.length, 1, '在途期间不得重复发起');
});

test('JevPlanner：失败走 onFallback 且 reason 逐条传出', async () => {
  const { world } = makeWindowWorld();
  const client = makeControlledClient();
  const fallbacks = [];
  const p = makePlanner(world, client, { onFallback: (id, reason) => fallbacks.push([id, reason]) });
  p.setEnabled(true);
  p.tick(0, [{ id: 'z0', position: [8.5, 1, 8.5], mobile: true }]);
  client.pending[0].resolve({ ok: false, reason: 'not-json' });
  await new Promise((r) => setTimeout(r, 0));
  assertEqual(fallbacks.length, 1);
  assertEqual(fallbacks[0][1], 'not-json');
  assertEqual(p.debugState().lastReason, 'not-json');
});

test('JevPlanner：非法方向也走 onFallback（不写进 state）', async () => {
  const { world } = makeWindowWorld();
  const client = makeControlledClient();
  const fallbacks = [];
  const decisions = [];
  const p = makePlanner(world, client, {
    onFallback: (id, reason) => fallbacks.push([id, reason]),
    onDecision: (id, d) => decisions.push([id, d]),
  });
  p.setEnabled(true);
  p.tick(0, [{ id: 'z0', position: [8.5, 1, 8.5], mobile: true }]);
  client.pending[0].resolve({ ok: true, answer: { choice: 'nowhere' }, model: 'm' });
  await new Promise((r) => setTimeout(r, 0));
  assertEqual(decisions.length, 0, '非法方向不得产生决策');
  assertEqual(fallbacks[0][1], 'unknown-direction');
});

test('JevPlanner：熔断期内不发请求', () => {
  const { world } = makeWindowWorld();
  const client = makeControlledClient();
  const breaker = new FailureBreaker({ now: () => 0, log: makeLogger() });
  breaker.recordFailure('a'); breaker.recordFailure('b'); breaker.recordFailure('c');
  assertFalse(breaker.available());
  const p = makePlanner(world, client, { breaker });
  p.setEnabled(true);
  p.tick(0, [{ id: 'z0', position: [8.5, 1, 8.5], mobile: true }]);
  assertEqual(client.pending.length, 0, '冷却期不得发请求');
});

test('JevPlanner：关闭时不发请求且清空记忆', () => {
  const { world } = makeWindowWorld();
  const client = makeControlledClient();
  const p = makePlanner(world, client);
  p.setEnabled(true);
  p.tick(0, [{ id: 'z0', position: [8.5, 1, 8.5], mobile: true }]);
  assertTrue(p.debugState().memorySize > 0);
  p.setEnabled(false);
  assertEqual(p.debugState().memorySize, 0, '关闭须清记忆');
  assertEqual(p.debugState().inflight, 0, '关闭须清在途');
  p.tick(0, [{ id: 'z0', position: [8.5, 1, 8.5], mobile: true }]);
  assertEqual(client.pending.length, 1, '关闭后不得新增请求');
});

test('JevPlanner：四面围墙时不发请求（buildQuestions 为空）', () => {
  const registry = createRegistry();
  registry.register('air', { solid: false, opaque: false, cullMode: 'none' });
  registry.register('stone', { solid: true, opaque: true, cullMode: 'opaque' });
  registry.register('bedrock', { solid: true, opaque: true, cullMode: 'opaque' });
  const world = new WorldData(registry);
  const col = new ChunkColumn(0, 0);
  const stone = registry.idOf('stone');
  for (let lz = 0; lz < 16; lz++) {
    for (let lx = 0; lx < 16; lx++) {
      for (let y = WORLD_MIN_Y; y <= 1; y++) col.set(lx, y, lz, stone);
    }
  }
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue;
      for (let dy = 1; dy <= 3; dy++) col.set(8 + dx, dy, 8 + dz, stone);
    }
  }
  world.add(col);
  const client = makeControlledClient();
  const fallbacks = [];
  const p = makePlanner(world, client, { onFallback: (id, r) => fallbacks.push([id, r]) });
  p.setEnabled(true);
  p.tick(0, [{ id: 'z0', position: [8.5, 1, 8.5], mobile: true }]);
  assertEqual(client.pending.length, 0, '无候选不得发请求');
  assertEqual(fallbacks[0][1], 'no-candidates');
});

test('JevPlanner：resetMemory 清掉单只记忆（slot 回收路径）', () => {
  const { world } = makeWindowWorld();
  const p = makePlanner(world, makeControlledClient());
  p.setEnabled(true);
  p.tick(0, [{ id: 'z0', position: [8.5, 1, 8.5], mobile: true }]);
  assertEqual(p.debugState().memorySize, 1);
  p.resetMemory('z0');
  assertEqual(p.debugState().memorySize, 0);
});

test('JevPlanner：mobile=false 的丧尸不参与决策', () => {
  const { world } = makeWindowWorld();
  const client = makeControlledClient();
  const p = makePlanner(world, client);
  p.setEnabled(true);
  p.tick(0, [{ id: 'z0', position: [8.5, 1, 8.5], mobile: false }]);
  assertEqual(client.pending.length, 0, 'blocked 的丧尸不该烧额度');
});

// ---------- ZombieService 接线（Task 9）----------

/** 造一个装了 ZombieService 的 fixture（pool=null：不发离线 RPC） */
function makeServiceFixture({ planner = null, world = null, registry = null } = {}) {
  const w = world ?? makeWindowWorld();
  const entities = new EntityManager();
  // ⚠️ spawn 需要已注册的类型（漏了会恒返回 null）
  entities.registerType('zombie', zombieDefinition);
  const svc = new ZombieService({ entities, world: w.world, pool: null, planner });
  return { world: w.world, registry: w.registry, entities, svc };
}

test('ZombieService：默认在线 AI 关闭，关闭时 planner 不被 tick', () => {
  const planning = [];
  const fakePlanner = {
    enabled: false,
    setEnabled(v) { this.enabled = v; },
    resetMemory() {},
    tick: (...a) => planning.push(a),
    debugState() { return { memorySize: 0, inflight: 0, decided: 0, failed: 0, lastReason: '' }; },
  };
  const { svc } = makeServiceFixture({ planner: fakePlanner });
  assertFalse(svc.onlineAiEnabled());
  svc.update(0.1, { playerPosition: [0, 0, 0] });
  assertEqual(planning.length, 0, '关闭时 planner 不该被 tick');
});

test('ZombieService.setOnlineAi：开启后 tick 到 planner', () => {
  const calls = [];
  const fakePlanner = {
    enabled: false, _mem: 0,
    setEnabled(v) { this.enabled = v; if (!v) this._mem = 0; },
    resetMemory() {},
    tick: (now, zs) => { calls.push(now); },
    debugState() { return { memorySize: this._mem, inflight: 0, decided: 0, failed: 0, lastReason: '' }; },
  };
  const { svc } = makeServiceFixture({ planner: fakePlanner });
  svc.setOnlineAi(true);
  assertTrue(svc.onlineAiEnabled());
  assertTrue(fakePlanner.enabled);
  svc.update(0.1, { playerPosition: [0, 0, 0] });
  assertEqual(calls.length, 1, '开启后应 tick 到 planner');
  svc.setOnlineAi(false);
  assertFalse(fakePlanner.enabled);
});

test('ZombieService：在线回包写进 state.velocity（经 _applyIntent）', async () => {
  const { world, registry, entities, svc } = makeServiceFixture();
  const client = makeControlledClient();
  const planner = new JevPlanner({
    world, client, breaker: new FailureBreaker({ now: () => 0, log: makeLogger() }),
    speed: 1.2, log: makeLogger(), now: () => 0,
    onDecision: (id, d) => {
      const e = entities.get(id);
      svc._applyIntent({ id, generation: e.generation, vx: d.vx, vz: d.vz, mode: 'chasing' });
    },
    onFallback: () => {},
  });
  svc.planner = planner;
  const id = svc.spawn([8.5, 1, 8.5]);
  assertTrue(typeof id === 'string', 'spawn 应成功');
  svc.setOnlineAi(true);
  svc.update(0.1, { playerPosition: [8.5, 1, 12.5] });
  assertTrue(client.pending.length >= 1, '应发起在线请求');
  client.pending[0].resolve({ ok: true, answer: { choice: 'north' }, model: 'm' });
  await new Promise((r) => setTimeout(r, 0));
  const st = svc.get(id);
  assertTrue(Math.abs(st.velocity[2] + 1.2) < 0.2, `vz 应约 -1.2，实际 ${st.velocity[2]}`);
});

test('ZombieService：死亡时清该只记忆（slot 回收）', () => {
  const { world } = makeWindowWorld();
  const reset = [];
  const fakePlanner = {
    enabled: false, setEnabled(v) { this.enabled = v; },
    tick() {}, resetMemory(id) { reset.push(id); },
    debugState() { return { memorySize: 0, inflight: 0, decided: 0, failed: 0, lastReason: '' }; },
  };
  const entities = new EntityManager();
  entities.registerType('zombie', zombieDefinition);
  const svc = new ZombieService({ entities, world, pool: null, planner: fakePlanner });
  const s = svc.spawn([8.5, 1, 8.5]);
  svc.damage(s, 999, 0);
  assertTrue(reset.includes(s), 'damage 致死须 resetMemory');
});

test('ZombieService：debugOnlineAi 在未注入 planner 时给出全零形状', () => {
  const { svc } = makeServiceFixture();
  const d = svc.debugOnlineAi();
  assertFalse(d.enabled);
  assertEqual(d.inflight, 0);
  assertEqual(d.memorySize, 0);
});

test('JevPlanner：默认时钟与 tick 的时间基准同源（不得混用 Date.now）', async () => {
  // 回归门：曾经 `now` 默认 Date.now()（epoch ~1.7e12）而 tick 传 performance.now()（~1e4）
  // → `nowMs < _nextAt` 恒真 → **整个过程只决策一次**（E2E 实测 40 秒 decided=1）。
  const { world } = makeWindowWorld();
  const client = makeControlledClient();
  const p = new JevPlanner({
    world, client, breaker: new FailureBreaker({ now: () => 0, log: makeLogger() }),
    speed: 1.2, log: makeLogger(),   // 故意不传 now：用默认值
    onDecision: () => {}, onFallback: () => {},
  });
  p.setEnabled(true);
  const z = [{ id: 'z0', position: [8.5, 1, 8.5], mobile: true }];
  const perfNow = (typeof performance !== 'undefined') ? performance.now() : Date.now();
  p.tick(perfNow, z);
  client.pending[0].resolve({ ok: true, answer: { choice: 'north' }, model: 'm' });
  await new Promise((r) => setTimeout(r, 0));
  // 周期已过 → 下一帧必须能再决策（若时钟混用，这里恒为 0 次新请求）
  p.tick(perfNow + JEV_AI.decisionPeriodMs + 50, z);
  assertEqual(client.pending.length, 2, '周期到点后必须能再次入队（时钟同源的判据）');
});

test('ZombieService：在线意图新鲜期内，离线回包不得覆盖速度', () => {
  // 回归门（E2E 实测抓到的缺陷）：离线 RPC 20Hz、在线决策 2Hz。两者都无脑写 velocity 时，
  // 在线方向会在 50ms 内被离线回包覆盖 → 速度左右翻转、净位移接近 0
  // （实测 24 秒只前进 0.1 格，vx 在 ±1.19 之间来回翻转）。
  const { world, entities, svc } = makeServiceFixture();
  const fakePlanner = {
    enabled: true, setEnabled(v) { this.enabled = v; }, resetMemory() {}, tick() {},
    debugState() { return { memorySize: 0, inflight: 0, decided: 0, failed: 0, lastReason: '' }; },
  };
  svc.planner = fakePlanner;
  svc._nowMs = 1000;
  const id = svc.spawn([8.5, 1, 8.5]);
  assertTrue(typeof id === 'string');
  const gen = entities.get(id).generation;
  // 在线意图：向 +x
  svc._applyIntent({ id, generation: gen, vx: 1.2, vz: 0, mode: 'chasing', source: 'online' });
  svc.noteOnlineIntent();
  // 50ms 后离线回包想写 -x：必须被拒
  svc._nowMs = 1050;
  const applied = svc._applyIntent({ id, generation: gen, vx: -1.2, vz: 0, mode: 'chasing', source: 'offline' });
  assertFalse(applied, '在线意图新鲜期内离线回包须让位');
  assertTrue(Math.abs(svc.get(id).velocity[0] - 1.2) < 1e-9, '速度应保持在线方向');
  // 超过 8 个离线周期后，离线重新接管
  svc._nowMs = 1000 + 8 * 200 + 50;
  const applied2 = svc._applyIntent({ id, generation: gen, vx: -1.2, vz: 0, mode: 'chasing', source: 'offline' });
  assertTrue(applied2, '超过新鲜期后离线须重新接管');
});

test('ZombieService：关闭在线 AI 后离线回包立刻恢复自主（不受新鲜期阻挡）', () => {
  const { world, entities, svc } = makeServiceFixture();
  const fakePlanner = {
    enabled: true, setEnabled(v) { this.enabled = v; }, resetMemory() {}, tick() {},
    debugState() { return { memorySize: 0, inflight: 0, decided: 0, failed: 0, lastReason: '' }; },
  };
  svc.planner = fakePlanner;
  svc._nowMs = 1000;
  const id = svc.spawn([8.5, 1, 8.5]);
  const gen = entities.get(id).generation;
  svc._applyIntent({ id, generation: gen, vx: 1.2, vz: 0, mode: 'chasing', source: 'online' });
  svc.noteOnlineIntent();
  svc.setOnlineAi(false);
  svc._nowMs = 1010;
  assertTrue(svc._applyIntent({ id, generation: gen, vx: -1.2, vz: 0, source: 'offline' }),
    '关掉在线 AI 后离线必须立刻接管');
});

test('buildCandidateSteps：room_around_after_the_step 反映活动空间（U 底小、开阔地 9）', () => {
  const { world, registry } = makeWindowWorld();
  const stone = registry.idOf('stone');
  // 开阔地：8 邻域全可走 → 落点处 room ≈ 9
  const open = buildCandidateSteps(world, [8.5, 1, 8.5], [8.5, 1, 12.5], memOf(new Map(), 'z'));
  assertEqual(open.north.room_around_after_the_step, 9, '开阔地落点周围应为 9');

  // 造一条 1 格宽走廊：z=8 整行除 x=8 外全封 3 格高 → 北侧落点 (8,7) 周围活动空间很小
  for (let x = 4; x <= 12; x++) {
    if (x === 8) continue;
    for (let dy = 0; dy < 3; dy++) world.setBlock(x, 1 + dy, 7, stone);
  }
  const narrow = buildCandidateSteps(world, [8.5, 1, 8.5], [8.5, 1, 12.5], memOf(new Map(), 'z'));
  assertTrue(narrow.north.room_around_after_the_step < 9,
    `窄走廊里落点活动空间须小于开阔地，实际 ${narrow.north.room_around_after_the_step}`);
});

test('buildJevState.path_to_player：开阔地可达玩家，墙挡住时只有几格', () => {
  const { world, registry } = makeWindowWorld();
  const stone = registry.idOf('stone');
  // 开阔地：丧尸 (8,8)、玩家正北 (8,4) → 直线可走 4 步且玩家在线上
  const open = buildJevState(world, [8.5, 1, 8.5], [8.5, 1, 4.5], memOf(new Map(), 'z'));
  assertEqual(open.path_to_player.walkable_steps_toward_player, 3,
    '到玩家前一步（k=1..3 可走，k=4 是玩家格本身）');
  assertTrue(open.path_to_player.player_is_on_that_line, '玩家应在直线上');

  // 在 (8,6) 摆 3 格高墙 → 直线只通 1 步
  for (let dy = 0; dy < 3; dy++) world.setBlock(8, 1 + dy, 6, stone);
  const blocked = buildJevState(world, [8.5, 1, 8.5], [8.5, 1, 4.5], memOf(new Map(), 'z'));
  assertEqual(blocked.path_to_player.walkable_steps_toward_player, 1, '墙在 2 格外 → 只通 1 步');
  assertFalse(blocked.path_to_player.player_is_on_that_line, '直线被墙截断');
});

test('JevPlanner：等待期间关闭开关 → 该次回包作废（不得写进 state）', async () => {
  // 回归门：setEnabled(false) 清了 _inflight，但已发出的请求仍会 return。
  // 不拦的话关掉开关后还会被在线方向驱动约 400ms（直到下一次离线回包）。
  const { world } = makeWindowWorld();
  const client = makeControlledClient();
  const decisions = [];
  const p = makePlanner(world, client, { onDecision: (id, d) => decisions.push([id, d]) });
  p.setEnabled(true);
  p.tick(0, [{ id: 'z0', position: [8.5, 1, 8.5], mobile: true }]);
  p.setEnabled(false);                                   // 请求在途时关闭
  client.pending[0].resolve({ ok: true, answer: { choice: 'north' }, model: 'm' });
  await new Promise((r) => setTimeout(r, 0));
  assertEqual(decisions.length, 0, '关闭后到达的回包必须作废');
  assertEqual(p.debugState().memorySize, 0, '记忆也不该被回包重新创建');
});

test('buildJevState.path_to_player：斜向射线不重复计数（同格只数一次）', () => {
  // 回归门：Math.round 的斜向采样会让相邻 k 落在同一格（实测 30° 射线上每 5 步有 2 次重复），
  // 不跳过会虚高「能通几格」——而模型正是拿这个数判「该直走还是绕」。
  const { world } = makeWindowWorld({ columns: [[0, 0]] });
  // 丧尸 (4,4)，玩家 (14,10)：约 31° 斜线，开阔地整条都能走
  const st = buildJevState(world, [4.5, 1, 4.5], [14.5, 1, 10.5], memOf(new Map(), 'z'));
  const steps = st.path_to_player.walkable_steps_toward_player;
  // 直线距离 ≈ 11.66 格 → 去重后最多 11 步（不含玩家格本身）
  assertTrue(steps <= 11, `不得因重复采样虚高（实际 ${steps}）`);
  assertTrue(steps >= 9, `也不该少得离谱（实际 ${steps}）`);
});
