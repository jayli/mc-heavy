# 丧尸在线 AI（Jev）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用在线模型（Jev / TypeSafe System One）替换丧尸的「无脑直线追逐 + 1.2 格局部避障」，让它在墙、U 形、螺旋、迷宫地形里能绕通；开关关闭时现有离线 AI 逐位不变。

**Architecture:** 新增 3 个纯逻辑模块（`zombie-ai-view.js` / `zombie-jev-client.js` / `zombie-jev-prompts.js`）挂在既有 `ZombieService` 上：每只丧尸独立异步决策（周期 0.5s，并发 ≤ 4），决策内容 = 代码算好「哪些方向可走 + 局部事实 + 走过的格数」，模型只做 1 个 `choice` 方向判断，答案再由代码校验可走性后写进既有 `_applyIntent`。失败静默降级到离线 AI 并打 `console.warn('[zombie-ai] …')`。

**Tech Stack:** 纯 ES2022 ESM（无 TS、无 bundler）、three r185.1 只在渲染层、浏览器内自建测试 runner（`src/tests/runner.js`）、Playwright 1.62.1、TypeSafe HTTP API（`POST https://js-perf.cn/typesafe/v1/systemone`）。

**Spec:** [`docs/superpowers/specs/2026-11-03-zombie-online-ai-design.md`](../specs/2026-11-03-zombie-online-ai-design.md)

## Global Constraints

- **开关关闭 = 逐位零回归**：`ZombieService.update()` 走原有 `pool.call('ai', …)` 分支，不构造 planner、不发 fetch、不建记忆表。
- **可走性由代码算，不问模型**：候选方向先由 `zombieCollidesAt` + `zombieStepUpY` 筛掉不可走的，模型只见可走方向（spec §2.2：只传矩阵时模型 4/12 次选墙）。
- **记忆由代码维护**：`visits` / `trail` / `deadEnds` 必须进 state（spec §2.4：去掉后退化成无限绕圈）。
- **窗口 9×9**（`JEV_AI.windowSize = 9`）：7×7 与 11×11 在长迷宫上会 runaway（spec §2.5）。
- **只 1 个 `choice`**，题名 `step`。**不用 noul 做任何几何判断**（spec §2.6：实测 0.70 对应「是墙」、0.29 对应「是空地」）。
- **失败必须打 log**（用户裁定）：`console.warn('[zombie-ai] <reason> id=<id>')`，reason ∈ `network-error` / `http-<status>` / `not-json` / `no-answer` / `illegal-direction` / `timeout`。
- **失败不当答案**：`not-json`（网关拦截返回 HTML）绝不能被读成「没有方向」。
- **连续失败 3 次 → 整体冷却 30 秒**；任何一次成功清零计数。
- **端点常量**：`JEV_AI.endpoint = 'https://js-perf.cn/typesafe/v1/systemone'`（不带 `?proxy=` —— 实测直连最快）。
- **同构层铁律**：三个新文件在 `src/entities/zombies/` 下 → `npm run check:arch` 禁止 `import 'three'`、禁止 `document`/`window`/`createImageBitmap`、禁止 `new Worker`。
- **不新增帧循环入口**：一切挂在既有 `zombies.update(dt, { playerPosition })` 内。
- **新设置字段 `onlineZombieAi` 默认 `false`，不做 `settingsVersion` 迁移**（旧存档无此字段 → 自然回落）。
- **提交纪律**：每个 Task 结束提交；不提 hook 跳过；`npm run lint` 必须 0 error。

## Review Focus

1. **网关拦截返回 HTML 时 `res.json()` 抛错** —— 必须落到 `not-json` 失败分支并走离线 AI，而不是让丧尸停住或抛穿帧循环（spec §3.8）。
2. **模型给出非法/过期方向**（墙里、地图外、未知名字）—— 必须校验可走性并判失败，不能照搬成速度（spec §3.7）。
3. **开关关闭时任何一处仍在发请求** → 额度被烧 + 离线路径被污染；判据是 spy 计数为 0。
4. **`steerIntent` 与在线决策的顺序** —— 在线只决定「往哪」，贴身的 1.2 格避障仍必须生效；写反会让丧尸撞墙（spec §3.3）。
5. **记忆表随 slot 回收泄漏** —— 丧尸死亡/column 卸载后 `_memory` 必须删除，否则 20 只上限下同一 id 会带上一只的访问历史。
6. **窗口把「未加载 column」画成墙** —— 玩家在加载边缘时丧尸会把空气当墙。这是**有意**的（spec §3.5），但必须写进 legend 让模型知道，否则它会在边界乱走。

---

## File Structure

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `src/entities/zombies/zombie-config.js` | 修改 | 新增 `JEV_AI` 冻结常量块（周期/并发/超时/窗口/熔断/端点） |
| `src/entities/zombies/zombie-ai-view.js` | 新建 | 纯函数：`sampleGroundWindow` / `buildCandidateSteps` / `buildJevState` / `memoryFor` / `noteVisit` / `DIRECTION_VECTORS` / `parseDirectionChoice` |
| `src/entities/zombies/zombie-jev-prompts.js` | 新建 | 文案唯一权威：`SITUATION` / `WINDOW_LEGEND` / `STEP_INSTRUCTIONS` / `criterionFor(name, facts)` |
| `src/entities/zombies/zombie-jev-client.js` | 新建 | 联网唯一入口：`JevClient.request(state, questions)`（超时、JSON 解析、失败分类）+ `FailureBreaker`（3 次冷却 30s） |
| `src/entities/zombies/zombie-jev-planner.js` | 新建 | 编排：选批 / 并发上限 / 等待期沿用上次方向 / 回包消费 / 降级 |
| `src/entities/zombies/zombie-system.js` | 修改 | `ZombieService` 增加 `onlineAi` 注入、`_memory` 表、`setOnlineAi()`、在既有 `update()` 里分叉 |
| `src/ui/settings.js` | 修改 | `DEFAULT_SETTINGS.onlineZombieAi = false` + `?zombieai=` URL + 归一化 |
| `src/ui/settings-panel.js` | 修改 | 左列新增「丧尸 AI」两按钮行 + 导出文案常量 |
| `src/core/game.js` | 修改 | 构造 `JevClient`/`JevPlanner` 注入 service + `setOnlineZombieAi(v)` + 启动接线 |
| `src/tests/test-zombie-jev-ai.js` | 新建 | Tier 1 单测（视图/解析/熔断/降级/零 fetch/记忆回收） |
| `src/tests/index.html` | 修改 | 注册新测试文件 |
| `tests/zombie-jev-ai.spec.mjs` | 新建 | Tier 4 真实 Jev E2E（U 形墙绕行，开关开/关对照） |

依赖方向：新模块只 import `zombie-config.js` / `zombie-navigation.js` / `zombie-ai-view.js`（同目录），**不 import three、不 import render/、不 import player/**。

---

### Task 1: `JEV_AI` 常量块 + 方向表 + 记忆（纯数据层）

**Files:**
- Modify: `src/entities/zombies/zombie-config.js`（文件末尾追加）
- Create: `src/entities/zombies/zombie-ai-view.js`
- Test: `src/tests/test-zombie-jev-ai.js`（新建，本任务只加第一段）
- Modify: `src/tests/index.html`

**Interfaces:**
- Consumes: `ZOMBIE.speed`、`ZOMBIE_MOVING_EPSILON`（既有）
- Produces:
  - `JEV_AI: Readonly<{endpoint: string, decisionPeriodMs: number, maxConcurrent: number, timeoutMs: number, windowSize: number, maxFailures: number, cooldownMs: number, maxVisits: number, maxTrail: number}>`
  - `DIRECTION_VECTORS: Readonly<Record<string, readonly [number, number]>>`（8 项，键 `north`/`north_east`/…，值为 `[dr, dc]`，`dr` = 行增量即 z/south 为正，`dc` = 列增量即 x/east 为正）
  - `memoryFor(memoryMap: Map<string, object>, id: string) -> object`（缺则创建）
  - `noteVisit(memory: object, x: number, z: number) -> void`（更新 `visits` LRU 与 `trail`）
  - `cellKey(x: number, z: number) -> string`（`"${Math.floor(x)},${Math.floor(z)}"`）

- [ ] **Step 1: 写失败测试**

在 `src/tests/test-zombie-jev-ai.js` 新建文件：

```js
// src/tests/test-zombie-jev-ai.js — 丧尸在线 AI（Jev）纯逻辑
// 覆盖：方向表 / 记忆（visits+trail 上限）/ 地面窗口采样 / 候选事实 / state 构造 /
//       答案解析与非法方向兜底 / 熔断 / 开关关闭零请求 / 记忆随 slot 回收删除
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse, assertDeepEqual } from './assert.js';
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
```

在 `src/tests/index.html` 的 `import './test-zombie-nests.js';` 之后加一行：

```html
    import './test-zombie-jev-ai.js';
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx playwright test tests/harness.spec.mjs -g "浏览器内单元测试" 2>&1 | tail -30`
Expected: FAIL —— `Failed to resolve module specifier` 或 `JEV_AI is not defined`（模块尚不存在）。

- [ ] **Step 3: 实现常量与纯函数**

`src/entities/zombies/zombie-config.js` 末尾追加：

```js
/**
 * 在线 AI（Jev / TypeSafe System One）参数（spec §3.3 / §3.8 / §3.9）。
 *
 * ⚠️ **`windowSize = 9` 是实测标定值不是推导值**：7×7 与 11×11 在「长迷宫」地形上都会
 * 让模型 runaway（59 步不出），只有 9×9 在全部 5 个困难地形上通过。
 * ⚠️ **`endpoint` 不带 `?proxy=`**：实测直连 ~330ms，补 `?proxy=1087` 反而慢 10 倍。
 * ⚠️ **`decisionPeriodMs = 500` 与 `timeoutMs = 4000` 是两个独立口径**：前者是「多久问一次」，
 * 后者是「一次最多等多久」。单次实测 330~800ms（中位 395），4000 只用于掐死挂住的请求。
 */
export const JEV_AI = Object.freeze({
  endpoint: 'https://js-perf.cn/typesafe/v1/systemone',
  /** 同一只丧尸两次决策的最小间隔（从上次**回包**算起） */
  decisionPeriodMs: 500,
  /** 同时在途的请求上限（超出排队） */
  maxConcurrent: 4,
  /** 单次请求超时（AbortController） */
  timeoutMs: 4000,
  /** 地面窗口边长（必须是奇数，保证丧尸在正中） */
  windowSize: 9,
  /** 连续失败多少次进入冷却 */
  maxFailures: 3,
  /** 冷却时长 */
  cooldownMs: 30000,
  /** 记忆里最多保留多少个「走过的格」 */
  maxVisits: 64,
  /** 记忆里最多保留多少步轨迹（给模型看的 recent trail） */
  maxTrail: 12,
});
```

`src/entities/zombies/zombie-ai-view.js` 新建（本任务只写这部分）：

```js
// src/entities/zombies/zombie-ai-view.js — 在线 AI 的「世界 → state」纯函数层
//
// 同构层：**无 DOM、无 three、不新建 Worker**（`npm run check:arch` 静态门守）。
// 本模块是四件事的唯一实现（红线 1）：
//   ① `DIRECTION_VECTORS` —— 8 个候选方向的坐标增量（题面选项名与速度向量的唯一映射）
//   ② 地面窗口采样 `sampleGroundWindow` —— 「丧尸周围的方块矩阵」的唯一来源
//   ③ 候选事实 `buildCandidateSteps` —— 代码算的可走性/走廊长度/访问次数
//   ④ state 组装 `buildJevState` —— 送给模型的全部环境信息
//
// ⚠️ **可走性一律复用 `zombie-navigation.js` 的 `zombieCollidesAt` / `zombieStepUpY`**，
// 不写第二份 AABB 采样（两份会漂移成「模型说能走、物理撞墙」）。
import { JEV_AI } from './zombie-config.js';
import { zombieCollidesAt, zombieStepUpY } from './zombie-navigation.js';
import { ZOMBIE_MAX_STEP } from './zombie-config.js';

/** 8 个候选方向：[dr, dc] = [z 增量, x 增量]（dr<0 为 north，dc>0 为 east） */
export const DIRECTION_VECTORS = Object.freeze({
  north: Object.freeze([-1, 0]),
  north_east: Object.freeze([-1, 1]),
  east: Object.freeze([0, 1]),
  south_east: Object.freeze([1, 1]),
  south: Object.freeze([1, 0]),
  south_west: Object.freeze([1, -1]),
  west: Object.freeze([0, -1]),
  north_west: Object.freeze([-1, -1]),
});

/** 格键（负坐标按 floor 归一 —— `wx % 16` 那类取余陷阱的同源教训） */
export function cellKey(x, z) {
  return `${Math.floor(x)},${Math.floor(z)}`;
}

/** 取（或创建）某只丧尸的记忆 */
export function memoryFor(memoryMap, id) {
  let mem = memoryMap.get(id);
  if (!mem) {
    mem = { visits: new Map(), trail: [], deadEnds: new Set(), lastDecision: null };
    memoryMap.set(id, mem);
  }
  return mem;
}

/**
 * 记录一次「站在 (x,z) 格上」。
 *
 * `visits` 是 LRU（Map 的插入序）：超上限时删最早插入的键。
 * ⚠️ **不删 `deadEnds`** —— 死胡同是地图性质，与 LRU 无关。
 */
export function noteVisit(mem, x, z) {
  const k = cellKey(x, z);
  mem.visits.set(k, (mem.visits.get(k) ?? 0) + 1);
  mem.trail.push([Math.floor(x), Math.floor(z)]);
  if (mem.trail.length > JEV_AI.maxTrail) mem.trail.splice(0, mem.trail.length - JEV_AI.maxTrail);
  while (mem.visits.size > JEV_AI.maxVisits) {
    const oldest = mem.visits.keys().next().value;
    mem.visits.delete(oldest);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx playwright test tests/harness.spec.mjs -g "浏览器内单元测试" 2>&1 | tail -20`
Expected: PASS（`failed: 0`），且新用例数 ≥ 5。

- [ ] **Step 5: 提交**

```bash
git add src/entities/zombies/zombie-config.js src/entities/zombies/zombie-ai-view.js src/tests/test-zombie-jev-ai.js src/tests/index.html
git commit -m "feat(zombie): JEV_AI 常量、方向表与旅行记忆"
```

---

### Task 2: 地面窗口采样 `sampleGroundWindow`

**Files:**
- Modify: `src/entities/zombies/zombie-ai-view.js`
- Test: `src/tests/test-zombie-jev-ai.js`

**Interfaces:**
- Consumes: `JEV_AI.windowSize`、`zombieCollidesAt`、`zombieStepUpY`、`ZOMBIE_MAX_STEP`
- Produces: `sampleGroundWindow(world, position: number[], playerPosition: number[]) -> string[]`
  —— 返回 `windowSize` 个字符串，每个长 `windowSize`；字符 ∈ `'.'`（可走）/ `'#'`（不可走或未加载）/ `'Z'`（丧尸所在格，正中）/ `'P'`（玩家所在格）

- [ ] **Step 1: 写失败测试**

追加到 `src/tests/test-zombie-jev-ai.js`：

```js
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';
import { createRegistry } from '../voxel/block-registry.js';
import { WORLD_MIN_Y } from '../voxel/constants.js';
import { sampleGroundWindow } from '../entities/zombies/zombie-ai-view.js';

/** 平地 fixture：指定 (cx,cz) column 内 y=0 全 stone，其余 air */
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
        for (let y = WORLD_MIN_Y; y <= solidTop; y++) {
          col.set(lx, y, lz, stone);
        }
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
  // 其余（除 Z/P）平地应可走
  const others = rows.join('').replace(/[ZP]/g, '');
  assertEqual([...others].filter((c) => c !== '.').length, 0, '平地窗口不该有 #');
});

test('sampleGroundWindow：墙写 #，且未加载 column 也写 #', () => {
  const { world, registry } = makeWindowWorld({ columns: [[0, 0]] });
  const stone = registry.idOf('stone');
  // 丧尸站在 (8,1,8)，北面 (8,1,7) 放一格墙（脚格，够 1 格高挡人）
  world.setBlock(8, 1, 7, stone);
  const rows = sampleGroundWindow(world, [8.5, 1, 8.5], [8.5, 1, 12.5]);
  const mid = (JEV_AI.windowSize - 1) / 2;
  assertEqual(rows[mid - 1][mid], '#', '北一格是墙');
  // 窗口跨到 column (1,0) 之外时（x≥16）→ 未加载 → '#'
  const far = sampleGroundWindow(world, [15.5, 1, 8.5], [15.5, 1, 12.5]);
  const fm = (JEV_AI.windowSize - 1) / 2;
  assertEqual(far[fm][fm + 1], '#', 'x=16 未加载须当墙');
});

test('sampleGroundWindow：抬一格可走的台阶写成 "."（复用 step-up 判据）', () => {
  const { world, registry } = makeWindowWorld();
  const stone = registry.idOf('stone');
  world.setBlock(8, 1, 7, stone); // 一格高台阶（脚底 y=1，台阶表面 y=2）
  const rows = sampleGroundWindow(world, [8.5, 1, 8.5], [8.5, 1, 12.5]);
  const mid = (JEV_AI.windowSize - 1) / 2;
  assertEqual(rows[mid - 1][mid], '.', '一格台阶应可走');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx playwright test tests/harness.spec.mjs -g "浏览器内单元测试" 2>&1 | tail -20`
Expected: FAIL —— `sampleGroundWindow is not a function`。

- [ ] **Step 3: 实现采样**

追加到 `src/entities/zombies/zombie-ai-view.js`：

```js
/**
 * 某格（脚底高度 y）能不能站 —— 一格台阶算能站（物理 step-up 会抬上去）。
 * 唯一实现，`buildCandidateSteps` 与窗口采样共用（红线 1）。
 */
function standableAt(world, bx, y, bz) {
  const x = bx + 0.5, z = bz + 0.5;
  if (!zombieCollidesAt(world, x, y, z)) return true;
  const lifted = zombieStepUpY(y);
  return lifted - y <= ZOMBIE_MAX_STEP && !zombieCollidesAt(world, x, lifted, z);
}

/**
 * 采样丧尸周围的地面窗口（**用户要的「方块矩阵」**）。
 *
 * 语义：
 * - 边长 `JEV_AI.windowSize`（9），丧尸脚底所在格在**正中**标 `Z`；
 * - 玩家在窗口范围内则标 `P`（优先于可走性，方便模型对齐方位）；
 * - 可走 → `.`；不可走 → `#`；
 * - **世界未加载的 column → `#`**（有意与墙同码：对丧尸而言同样是「过不去」）。
 *   ⚠️ 这条必须同步写进 `zombie-jev-prompts.js` 的 legend，否则模型会把加载边缘当墙乱走。
 *
 * @param {{getBlockId(x,y,z): number, hasColumn(cx: number, cz: number): boolean}} world
 * @param {number[]} position 丧尸脚底 [x, y, z]
 * @param {number[]} playerPosition 玩家脚底 [x, y, z]
 * @returns {string[]} 9 行，每行 9 字符
 */
export function sampleGroundWindow(world, position, playerPosition) {
  const n = JEV_AI.windowSize;
  const half = (n - 1) / 2;
  const [zc, y, xc] = position;              // 注意：position 是 [x,y,z]
  const zx = Math.floor(xc), zz = Math.floor(zc);
  const px = Math.floor(playerPosition[0]), pz = Math.floor(playerPosition[2]);
  const rows = [];
  for (let dr = -half; dr <= half; dr++) {
    let line = '';
    for (let dc = -half; dc <= half; dc++) {
      const bx = zx + dc, bz = zz + dr;
      if (dr === 0 && dc === 0) { line += 'Z'; continue; }
      if (bx === px && bz === pz) { line += 'P'; continue; }
      const cx = Math.floor(bx / 16), cz = Math.floor(bz / 16);
      if (typeof world.hasColumn === 'function' && !world.hasColumn(cx, cz)) { line += '#'; continue; }
      line += standableAt(world, bx, y, bz) ? '.' : '#';
    }
    rows.push(line);
  }
  return rows;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx playwright test tests/harness.spec.mjs -g "浏览器内单元测试" 2>&1 | tail -20`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/entities/zombies/zombie-ai-view.js src/tests/test-zombie-jev-ai.js
git commit -m "feat(zombie): 9x9 地面窗口采样（未加载 column 当墙）"
```

---

### Task 3: 候选事实 `buildCandidateSteps` + state 组装 `buildJevState`

**Files:**
- Modify: `src/entities/zombies/zombie-ai-view.js`
- Test: `src/tests/test-zombie-jev-ai.js`

**Interfaces:**
- Consumes: `DIRECTION_VECTORS`、`cellKey`、`standableAt`、`sampleGroundWindow`
- Produces:
  - `buildCandidateSteps(world, position, playerPosition, memory) -> Record<string, {direction, player_lies_toward, straight_line_distance_after_step, closer_or_farther, open_ground_ahead, other_ways_out_after_the_step, times_already_visited}>`
    —— **只含可走方向**；空对象表示四面皆墙
  - `buildJevState(world, position, playerPosition, memory) -> {situation, player_direction_from_zombie, straight_line_distance_now, steps_already_walked, ground_window, candidate_steps}`
  - `bearingWords(from: number[], to: number[]) -> string`（如 `"north and west"`）
  - `markDeadEnd(memory, x, z) -> void`

- [ ] **Step 1: 写失败测试**

追加到 `src/tests/test-zombie-jev-ai.js`：

```js
import {
  bearingWords, buildCandidateSteps, buildJevState, markDeadEnd, memoryFor as memOf,
} from '../entities/zombies/zombie-ai-view.js';

test('bearingWords：方位文案（北/西为负）', () => {
  assertEqual(bearingWords([0, 0], [0, 1]), 'south and east');
  assertEqual(bearingWords([0, 0], [-3, 0]), 'north');
  assertEqual(bearingWords([0, 0], [0, -2]), 'west');
  assertEqual(bearingWords([0, 0], [0, 0]), 'the same square');
});

test('buildCandidateSteps：只含可走方向，四面围墙时为空', () => {
  const { world, registry } = makeWindowWorld();
  const all = buildCandidateSteps(world, [8.5, 1, 8.5], [8.5, 1, 12.5], memOf(new Map(), 'z'));
  assertEqual(Object.keys(all).length, 8, '平地 8 个方向都可走');
  for (const [name, f] of Object.entries(all)) {
    assertEqual(f.direction, name.replace('_', ' '));
    assertEqual(f.times_already_visited, 0);
    assertTrue(typeof f.open_ground_ahead === 'string' && f.open_ground_ahead.endsWith(' meters'));
  }
  // 围死
  const stone = registry.idOf('stone');
  for (const [, dr, dc] of [[0, -1, 0], [1, 1, 0], [2, 0, 1], [3, 1, 1], [4, 1, 0], [5, 1, -1], [6, 0, -1], [7, -1, -1]].map(([i, a, b]) => [i, a, b])) {
    for (let dy = 0; dy < 3; dy++) world.setBlock(8 + dc, 1 + dy, 8 + dr, stone);
  }
  const none = buildCandidateSteps(world, [8.5, 1, 8.5], [8.5, 1, 12.5], memOf(new Map(), 'z'));
  assertEqual(Object.keys(none).length, 0, '四面围死时无候选');
});

test('buildCandidateSteps：times_already_visited 来自记忆', () => {
  const { world } = makeWindowWorld();
  const mem = memOf(new Map(), 'z');
  noteVisit(mem, 9, 7); // 北一格（z-1）已走过一次
  const cands = buildCandidateSteps(world, [8.5, 1, 8.5], [8.5, 1, 12.5], mem);
  assertEqual(cands.north.times_already_visited, 1);
  assertEqual(cands.south.times_already_visited, 0);
});

test('buildCandidateSteps：死胡同标记进候选事实', () => {
  const { world } = makeWindowWorld();
  const mem = memOf(new Map(), 'z');
  markDeadEnd(mem, 9, 7);
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
  // 必须能被 JSON 序列化（送网络的前提）
  assertEqual(JSON.parse(JSON.stringify(st)).ground_window.rows.length, JEV_AI.windowSize);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx playwright test tests/harness.spec.mjs -g "浏览器内单元测试" 2>&1 | tail -20`
Expected: FAIL —— `buildCandidateSteps is not a function`。

- [ ] **Step 3: 实现三件事**

追加到 `src/entities/zombies/zombie-ai-view.js`：

```js
/**
 * 方位文案（题面与选项描述共用）。from/to 是 [x, z]。
 * ⚠️ 只说方位不给坐标 —— 坐标是绝对值，进 state 既不必要也难读。
 */
export function bearingWords(from, to) {
  const dz = to[1] - from[1];   // 注意 from/to 是 [x,z]
  const dx = to[0] - from[0];
  const ns = dz < 0 ? 'north' : dz > 0 ? 'south' : '';
  const ew = dx < 0 ? 'west' : dx > 0 ? 'east' : '';
  const w = [ns, ew].filter(Boolean).join(' and ');
  return w || 'the same square';
}

/** 沿某方向连续可站的格数（最多 cap） */
function openGroundAhead(world, bx, y, bz, dr, dc, cap = 16) {
  let n = 0;
  for (let k = 1; k <= cap; k++) {
    if (!standableAt(world, bx + dc * k, y, bz + dr * k)) break;
    n++;
  }
  return n;
}

/** 某格的「除来路外的可走方向数」 */
function exitsBesides(world, bx, y, bz, cameDr, cameDc) {
  let n = 0;
  for (const [, dr, dc] of Object.entries(DIRECTION_VECTORS)) {
    const nx = bx + dc, nz = bz + dr;
    if (nx === bx + cameDc && nz === bz + cameDr) continue; // 来路
    if (standableAt(world, nx, y, nz)) n++;
  }
  return n;
}

/** 标记死胡同（地图性质，不随 LRU 淘汰） */
export function markDeadEnd(mem, x, z) {
  mem.deadEnds.add(cellKey(x, z));
}

/**
 * 计算候选方向事实。**只含可走方向**（spec §2.2：让模型看到墙时它会 4/12 次选墙）。
 *
 * @returns {Record<string, object>} 键为方向名，空对象 = 四面皆不可走
 */
export function buildCandidateSteps(world, position, playerPosition, memory) {
  const [xb, y, zb] = position;
  const bx = Math.floor(xb), bz = Math.floor(zb);
  const px = Math.floor(playerPosition[0]), pz = Math.floor(playerPosition[2]);
  const hereDist = Math.hypot(bx - px, bz - pz);
  const out = {};
  for (const [name, [dr, dc]] of Object.entries(DIRECTION_VECTORS)) {
    const nx = bx + dc, nz = bz + dr;
    if (!standableAt(world, nx, y, nz)) continue;
    const afterDist = Math.hypot(nx - px, nz - pz);
    out[name] = {
      direction: name.replace('_', ' '),
      player_lies_toward: bearingWords([nx, nz], [px, pz]),
      straight_line_distance_after_step: `${afterDist.toFixed(1)} meters`,
      closer_or_farther: afterDist < hereDist - 0.05 ? 'closer to the player'
        : afterDist > hereDist + 0.05 ? 'farther from the player' : 'about the same distance',
      open_ground_ahead: `${openGroundAhead(world, bx, y, bz, dr, dc)} meters`,
      other_ways_out_after_the_step: exitsBesides(world, nx, y, nz, dr, dc),
      times_already_visited: memory.visits.get(cellKey(nx, nz)) ?? 0,
      marked_dead_end: memory.deadEnds.has(cellKey(nx, nz)),
    };
  }
  return out;
}

/**
 * 组装送模型的完整 state（spec §3.5）。**这是「环境信息」的唯一权威。**
 * 输出必须完全可 JSON 序列化（送网络的前提）。
 */
export function buildJevState(world, position, playerPosition, memory) {
  const [xb, y, zb] = position;
  const px = Math.floor(playerPosition[0]), pz = Math.floor(playerPosition[2]);
  const bx = Math.floor(xb), bz = Math.floor(zb);
  return {
    situation: SITUATION,
    player_direction_from_zombie: bearingWords([bx, bz], [px, pz]),
    straight_line_distance_now: `${Math.hypot(bx - px, bz - pz).toFixed(1)} meters`,
    steps_already_walked: Math.max(0, memory.trail.length - 1),
    ground_window: {
      rows: sampleGroundWindow(world, position, playerPosition),
      top_is: 'north',
      left_is: 'west',
      legend: WINDOW_LEGEND,
    },
    candidate_steps: buildCandidateSteps(world, position, playerPosition, memory),
  };
}
```

同文件顶部加 import：

```js
import { SITUATION, WINDOW_LEGEND } from './zombie-jev-prompts.js';
```

（`zombie-jev-prompts.js` 在 Task 4 建；本任务先建**最小版**，只含 `SITUATION` 与 `WINDOW_LEGEND` 两个常量，Task 4 再补题面与 criterion 函数。）

`src/entities/zombies/zombie-jev-prompts.js` 新建最小版：

```js
// src/entities/zombies/zombie-jev-prompts.js — 在线 AI 的文案唯一权威
//
// **为什么单独一个文件**：题面 / 选项描述 / 阈值是集成里被审计和修改最多的部分（TypeSafe
// 官方 skill 的「Keep all question wording in one place」）。散在 view/client 里会就地漂移。
// 同构层：无 DOM、无 three。

export const SITUATION = 'A zombie chases the player through terrain with walls. Walls can only be walked around, never broken. The ground window shows the terrain around the zombie.';

export const WINDOW_LEGEND = "Every character is one square meter of ground. '.' is flat ground the zombie can walk on. '#' is a solid wall, or ground more than one meter higher, or terrain that has not loaded yet: the zombie cannot enter it. 'Z' is the zombie, in the middle of the window. 'P' is the player.";
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx playwright test tests/harness.spec.mjs -g "浏览器内单元测试" 2>&1 | tail -20`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/entities/zombies/zombie-ai-view.js src/entities/zombies/zombie-jev-prompts.js src/tests/test-zombie-jev-ai.js
git commit -m "feat(zombie): 候选方向事实与 Jev state 组装"
```

---

### Task 4: 题面 `zombie-jev-prompts.js`（文案唯一权威）

**Files:**
- Modify: `src/entities/zombies/zombie-jev-prompts.js`
- Test: `src/tests/test-zombie-jev-ai.js`

**Interfaces:**
- Produces:
  - `QUESTION_ID = 'step'`
  - `STEP_INSTRUCTIONS: string`
  - `criterionFor(directionName: string, facts: object) -> string`
  - `buildQuestions(candidateSteps: Record<string, object>) -> Record<string, object>`
    —— 返回完整的 `questions` 对象，可直接拼进请求
  - `SITUATION` / `WINDOW_LEGEND`（Task 3 已建）

- [ ] **Step 1: 写失败测试**

追加到 `src/tests/test-zombie-jev-ai.js`：

```js
import {
  QUESTION_ID, STEP_INSTRUCTIONS, buildQuestions, criterionFor, SITUATION, WINDOW_LEGEND,
} from '../entities/zombies/zombie-jev-prompts.js';

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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx playwright test tests/harness.spec.mjs -g "浏览器内单元测试" 2>&1 | tail -20`
Expected: FAIL —— `buildQuestions is not a function`。

- [ ] **Step 3: 实现文案与问题构造**

追加到 `src/entities/zombies/zombie-jev-prompts.js`：

```js
export const QUESTION_ID = 'step';

/**
 * 题干（spec §3.6）。
 *
 * 句式约束（TypeSafe 官方 skill）：
 * - **一个判断**，不合并「且/或」；
 * - **不在题干里描述选项**（描述归 criteria）；
 * - **不用双重否定**；
 * - **明说该避免什么**（重复访问 / 死胡同）—— 实测这两句是长迷宫通过的关键。
 */
export const STEP_INSTRUCTIONS = 'Which candidate step is most likely to lead `Z` to `P` without getting stuck? Use both the ground window and the candidate facts. Do not step onto a square the zombie has already visited when another step keeps the route open. It is better to walk farther in a straight line while keeping a way forward than to walk into a dead end or back the way it came.';

/**
 * 单个方向选项的描述。
 * ⚠️ **选项名是方向名**（`north`…），不是 `A`/`option_1` —— 官方 skill：位置名给不了模型信息。
 */
export function criterionFor(name, f) {
  return `Step ${name.replace('_', ' ')}. After the step the player lies ${f.player_lies_toward} and is `
    + `${f.straight_line_distance_after_step} away, so this step is ${f.closer_or_farther}. `
    + `Open ground continuing that way: ${f.open_ground_ahead}. `
    + `Other ways out after the step: ${f.other_ways_out_after_the_step}. `
    + `The zombie has stood on that square ${f.times_already_visited} times before. `
    + (f.marked_dead_end ? 'The zombie already found out that this square leads to a dead end.' : 'This square is not known to be a dead end.');
}

/**
 * 构造完整 `questions`。**无候选返回空对象** —— 调用方据此跳过请求（四面围墙时不烧额度）。
 */
export function buildQuestions(candidateSteps) {
  const names = Object.keys(candidateSteps);
  if (names.length === 0) return {};
  const criteria = {};
  for (const name of names) criteria[name] = criterionFor(name, candidateSteps[name]);
  return { [QUESTION_ID]: { type: 'choice', instructions: STEP_INSTRUCTIONS, criteria } };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx playwright test tests/harness.spec.mjs -g "浏览器内单元测试" 2>&1 | tail -20`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/entities/zombies/zombie-jev-prompts.js src/tests/test-zombie-jev-ai.js
git commit -m "feat(zombie): Jev 题面与选项描述（文案唯一权威）"
```

---

### Task 5: 答案解析与非法方向兜底 `parseDirectionChoice`

**Files:**
- Modify: `src/entities/zombies/zombie-ai-view.js`
- Test: `src/tests/test-zombie-jev-ai.js`

**Interfaces:**
- Produces: `parseDirectionChoice(answer: object|null, candidateSteps: object) -> {ok: true, direction: string, vx: number, vz: number} | {ok: false, reason: string}`
  - `reason` ∈ `'no-answer'` / `'unknown-direction'` / `'blocked-direction'`
  - `vx`/`vz` = 单位向量（不含速度大小 —— 大小由调用方乘 `ZOMBIE.speed`）

- [ ] **Step 1: 写失败测试**

追加到 `src/tests/test-zombie-jev-ai.js`：

```js
import { parseDirectionChoice } from '../entities/zombies/zombie-ai-view.js';

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
  // 模型给了不在候选里的方向（候选已按可走性过滤）→ 必须判 blocked，不能照搬
  assertEqual(parseDirectionChoice({ choice: 'south' }, { north: {} }).reason, 'blocked-direction');
});

test('parseDirectionChoice：答案里的 choice 是墙时不得放行', () => {
  const cands = { north: {} };
  const r = parseDirectionChoice({ choice: 'north_east' }, cands);
  assertFalse(r.ok, '不在候选表里的方向一律拒绝');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx playwright test tests/harness.spec.mjs -g "浏览器内单元测试" 2>&1 | tail -20`
Expected: FAIL —— `parseDirectionChoice is not a function`。

- [ ] **Step 3: 实现解析**

追加到 `src/entities/zombies/zombie-ai-view.js`：

```js
/**
 * 把模型答案翻译成单位速度向量（spec §3.7）。
 *
 * **三条失败 reason 逐条独立**（不合成一句「失败」，见 spec §3.8 的口径）：
 * - `no-answer`：没回包 / 缺 `choice` 字段；
 * - `unknown-direction`：回了个不认识的字符串（模型幻觉）；
 * - `blocked-direction`：认识的方向，但**不在候选表里**（= 那格不可走）。
 *
 * ⚠️ **候选表是唯一合法性依据**：`buildCandidateSteps` 已用物理判据筛过，故「在表里」
 * 等价于「现在能走」。不在这里重新采样世界（会让判据变成第二份）。
 *
 * @returns {{ok: true, direction: string, vx: number, vz: number} | {ok: false, reason: string}}
 */
export function parseDirectionChoice(answer, candidateSteps) {
  const choice = answer?.choice;
  if (typeof choice !== 'string' || choice.length === 0) return { ok: false, reason: 'no-answer' };
  const vec = DIRECTION_VECTORS[choice];
  if (!vec) return { ok: false, reason: 'unknown-direction' };
  if (!candidateSteps || !(choice in candidateSteps)) return { ok: false, reason: 'blocked-direction' };
  const [dr, dc] = vec;                      // dr = z 增量，dc = x 增量
  const len = Math.hypot(dr, dc);
  return { ok: true, direction: choice, vx: dc / len, vz: dr / len };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx playwright test tests/harness.spec.mjs -g "浏览器内单元测试" 2>&1 | tail -20`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/entities/zombies/zombie-ai-view.js src/tests/test-zombie-jev-ai.js
git commit -m "feat(zombie): 方向答案解析与三类失败兜底"
```

---

### Task 6: HTTP 客户端 `zombie-jev-client.js`（联网唯一入口 + 失败分类）

**Files:**
- Create: `src/entities/zombies/zombie-jev-client.js`
- Test: `src/tests/test-zombie-jev-ai.js`

**Interfaces:**
- Produces:
  - `JevClient` 类：`constructor({endpoint = JEV_AI.endpoint, timeoutMs = JEV_AI.timeoutMs, fetchImpl = globalThis.fetch, log = console})`
  - `client.request({state, questions}) -> Promise<{ok: true, answer: object, model: string} | {ok: false, reason: string}>`
    - `reason` ∈ `'network-error'` / `'http-<status>'` / `'not-json'` / `'no-answer'` / `'timeout'`
    - **永不 reject**（调用方只处理返回值）
    - 每个失败都 `log.warn('[zombie-ai] <reason>')`
  - `createJevClient(opts)` 便捷工厂

- [ ] **Step 1: 写失败测试**

追加到 `src/tests/test-zombie-jev-ai.js`：

```js
import { JevClient } from '../entities/zombies/zombie-jev-client.js';

/** 记录 warn 调用的假 logger（断言「必须打 log」） */
function makeLogger() {
  const warns = [];
  return { warns, warn: (...a) => warns.push(a.join(' ')), info: () => {}, error: (...a) => warns.push(a.join(' ')) };
}

/** 造一个只回固定响应的假 fetch */
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx playwright test tests/harness.spec.mjs -g "浏览器内单元测试" 2>&1 | tail -20`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现客户端**

`src/entities/zombies/zombie-jev-client.js` 新建：

```js
// src/entities/zombies/zombie-jev-client.js — 在线 AI 的 HTTP 客户端（**唯一联网点**）
//
// 同构层：无 DOM、无 three、不自建 Worker。世界数据的唯一权威在主线程（红线 1），
// 而 HTTP 本身就是异步 IO —— 不需要 Worker。
//
// ## 三条载荷性约定
//
// ① **永不 reject**：调用方只处理返回值。抛异常会穿到帧循环（game.js 的 setAnimationLoop
//    回调）→ 整个游戏停摆。故所有路径收敛成 `{ok:false, reason}`。
// ② **`not-json` 与「没有答案」是两件事**：js-perf.cn 前面的安全网关会间歇性返回一段 HTML
//    （实测同一分钟内可能 5 次 403 后连续 200）。把它读成「模型没给方向」会让丧尸静默停住
//    —— 这是 spec §3.8 明确点名的失败形态。
// ③ **每个失败都打 log**（用户 2026-11-03 明确要求便于排查），格式固定
//    `[zombie-ai] <reason>` 便于 grep。
import { JEV_AI } from './zombie-config.js';
import { QUESTION_ID } from './zombie-jev-prompts.js';

export class JevClient {
  /**
   * @param {{endpoint?: string, timeoutMs?: number, model?: string,
   *          fetchImpl?: Function, log?: {warn: Function, info?: Function}}} [opts]
   *   `fetchImpl`/`log` 可注入 —— 单测不联网、不污染真实 console。
   */
  constructor({ endpoint = JEV_AI.endpoint, timeoutMs = JEV_AI.timeoutMs,
    model = 'jev-latest', fetchImpl = null, log = null } = {}) {
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
    this.model = model;
    this._fetch = fetchImpl ?? ((...a) => globalThis.fetch(...a));
    this._log = log ?? ((typeof console !== 'undefined') ? console : { warn() {} });
  }

  /**
   * 发一次请求。**永不 reject。**
   * @param {{state: object, questions: object}} req
   * @returns {Promise<{ok: true, answer: object, model: string}|{ok: false, reason: string}>}
   */
  async request({ state, questions }) {
    // 无题目就别烧额度（四面围墙时 buildQuestions 返回 {}）
    if (!questions || Object.keys(questions).length === 0) return this._fail('no-answer');
    // AbortController 只在存在时用（fixture/老环境降级为不超时）
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), this.timeoutMs) : null;
    let res;
    let text;
    try {
      res = await this._fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, state, questions }),
        ...(ctl ? { signal: ctl.signal } : {}),
      });
      text = await res.text();
    } catch (e) {
      const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message ?? '')));
      return this._fail(aborted ? 'timeout' : 'network-error');
    } finally {
      if (timer) clearTimeout(timer);
    }
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    // ⚠️ 解析失败优先判 not-json（哪怕状态码是 200/403）—— 网关拦页面正是这个形状
    if (json === null) return this._fail('not-json');
    if (!res.ok) return this._fail(`http-${res.status}`);
    const answer = json?.answers?.[QUESTION_ID];
    if (!answer) return this._fail('no-answer');
    return { ok: true, answer, model: typeof json.model === 'string' ? json.model : '' };
  }

  _fail(reason) {
    try { this._log.warn(`[zombie-ai] ${reason}`); } catch { /* 日志失败不得影响主流程 */ }
    return { ok: false, reason };
  }
}

/** 便捷工厂（Game 装配用） */
export function createJevClient(opts) {
  return new JevClient(opts);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx playwright test tests/harness.spec.mjs -g "浏览器内单元测试" 2>&1 | tail -20`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/entities/zombies/zombie-jev-client.js src/tests/test-zombie-jev-ai.js
git commit -m "feat(zombie): Jev HTTP 客户端（失败分类 + 永不 reject）"
```

---

### Task 7: 熔断 `FailureBreaker`

**Files:**
- Modify: `src/entities/zombies/zombie-jev-client.js`
- Test: `src/tests/test-zombie-jev-ai.js`

**Interfaces:**
- Produces:
  - `FailureBreaker` 类：`constructor({maxFailures = JEV_AI.maxFailures, cooldownMs = JEV_AI.cooldownMs, now = () => Date.now(), log = null})`
  - `.available(nowMs?) -> boolean`
  - `.recordFailure(reason: string, nowMs?: number) -> void`
  - `.recordSuccess() -> void`
  - `.state() -> {fails: number, openUntil: number, suspended: boolean}`（只读测试钩子）

- [ ] **Step 1: 写失败测试**

追加到 `src/tests/test-zombie-jev-ai.js`：

```js
import { FailureBreaker } from '../entities/zombies/zombie-jev-client.js';

test('FailureBreaker：连续 3 次失败进入冷却，期间 available=false', () => {
  const log = makeLogger();
  let t = 1000;
  const b = new FailureBreaker({ now: () => t, log });
  assertTrue(b.available());
  b.recordFailure('network-error'); b.recordFailure('timeout'); b.recordFailure('not-json');
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
  b.recordFailure('x'); b.recordFailure('y');
  b.recordSuccess();
  assertEqual(b.state().fails, 0);
  b.recordFailure('z');
  assertTrue(b.available(), '清零后一次失败不该触发冷却');
});

test('FailureBreaker：失败计数不因中间成功而累加', () => {
  const b = new FailureBreaker({ now: () => 0, log: makeLogger() });
  for (let i = 0; i < 5; i++) { b.recordFailure('f'); b.recordSuccess(); }
  assertTrue(b.available(), '交替失败/成功永远不该冷却');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx playwright test tests/harness.spec.mjs -g "浏览器内单元测试" 2>&1 | tail -20`
Expected: FAIL —— `FailureBreaker is not a constructor`。

- [ ] **Step 3: 实现熔断**

追加到 `src/entities/zombies/zombie-jev-client.js`：

```js
/**
 * 失败熔断（spec §3.8：连续 3 次失败 → 整体暂停 30 秒）。
 *
 * **为什么需要**：单次超时 4s，若网关持续拦截，20 只丧尸 × 4 并发会一直堆叠 4s 的挂起请求。
 * 熔断把它们整体切回离线 AI，30 秒后再试。
 *
 * ⚠️ **`recordSuccess()` 清零**是载荷性的：网关是**间歇性**拦截的（实测同一分钟内 5 次 403
 * 后连续 200）。改成「滑窗计数」会让长期跑图的人被零星失败拖进冷却。
 */
export class FailureBreaker {
  constructor({ maxFailures = JEV_AI.maxFailures, cooldownMs = JEV_AI.cooldownMs,
    now = () => Date.now(), log = null } = {}) {
    this.maxFailures = maxFailures;
    this.cooldownMs = cooldownMs;
    this._now = now;
    this._log = log ?? ((typeof console !== 'undefined') ? console : { warn() {}, info() {} });
    this.fails = 0;
    this.openUntil = 0;
  }

  available(nowMs = this._now()) {
    return nowMs >= this.openUntil;
  }

  recordFailure(reason, nowMs = this._now()) {
    if (!this.available(nowMs)) return;     // 冷却期内的失败不再累计（否则恢复后立刻又进冷却）
    this.fails++;
    if (this.fails >= this.maxFailures) {
      this.openUntil = nowMs + this.cooldownMs;
      this.fails = 0;
      try {
        this._log.warn(`[zombie-ai] suspended for ${this.cooldownMs}ms after ${this.maxFailures} failures (last: ${reason})`);
      } catch { /* ignore */ }
    }
  }

  recordSuccess() {
    if (this.fails !== 0) {
      this.fails = 0;
      try { (this._log.info ?? this._log.warn)('[zombie-ai] resumed'); } catch { /* ignore */ }
    }
  }

  state() {
    return { fails: this.fails, openUntil: this.openUntil, suspended: !this.available() };
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx playwright test tests/harness.spec.mjs -g "浏览器内单元测试" 2>&1 | tail -20`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/entities/zombies/zombie-jev-client.js src/tests/test-zombie-jev-ai.js
git commit -m "feat(zombie): 在线 AI 失败熔断（3 次 / 30 秒）"
```

---

### Task 8: 编排器 `zombie-jev-planner.js`（选批 / 并发 / 等待期沿用 / 死胡同）

**Files:**
- Create: `src/entities/zombies/zombie-jev-planner.js`
- Test: `src/tests/test-zombie-jev-ai.js`

**Interfaces:**
- Consumes: `JevClient`、`FailureBreaker`、`buildJevState`、`buildQuestions`、`parseDirectionChoice`、`memoryFor`、`noteVisit`、`markDeadEnd`、`DIRECTION_VECTORS`
- Produces:
  - `JevPlanner` 类：
    - `constructor({world, client, breaker, speed, log, now, onDecision})`
      - `onDecision(id, {vx, vz, mode})` —— 决策成功时回调（Game 侧接 `ZombieService._applyIntent`）
      - `onFallback(id, reason)` —— 失败降级时回调（用于让调用方走离线路径）
    - `.tick(nowMs, zombies: Array<{id, position, mobile}>) -> void`（发起 + 消费，不 await）
    - `.setEnabled(on: boolean) -> void`（关时清空在途并清记忆）
    - `.resetMemory(id: string) -> void`
    - `.debugState() -> {inflight: number, decided: number, failed: number, lastReason: string, memorySize: number}`
  - `DEAD_END_TURNS = 1`（死胡同标记后强制换向的轮数）

- [ ] **Step 1: 写失败测试**

追加到 `src/tests/test-zombie-jev-ai.js`：

```js
import { JevPlanner } from '../entities/zombies/zombie-jev-planner.js';

/** 可手动 resolve 的假 client（控制时序） */
function makeControlledClient() {
  const pending = [];
  return {
    pending,
    request(req) {
      return new Promise((resolve) => { pending.push({ req, resolve }); });
    },
  };
}

test('JevPlanner：tick 发起请求，回包后回调 onDecision', async () => {
  const { world } = makeWindowWorld();
  const client = makeControlledClient();
  const decisions = [];
  const p = new JevPlanner({
    world, client, breaker: new FailureBreaker({ now: () => 0, log: makeLogger() }),
    speed: 1.2, log: makeLogger(), now: () => 0,
    onDecision: (id, d) => decisions.push([id, d]),
    onFallback: () => {},
  });
  p.setEnabled(true);
  p.tick(0, [{ id: 'z0', position: [8.5, 1, 8.5], mobile: true }]);
  assertEqual(client.pending.length, 1, '应发出一条请求');
  assertEqual(p.debugState().inflight, 1);
  // 回包
  client.pending[0].resolve({ ok: true, answer: { type: 'choice', choice: 'north' }, model: 'm' });
  await new Promise((r) => setTimeout(r, 0));
  assertEqual(decisions.length, 1);
  assertEqual(decisions[0][0], 'z0');
  assertTrue(Math.abs(decisions[0][1].vz + 1) < 1e-9, 'north 应给 vz=-1');
  assertEqual(p.debugState().inflight, 0);
  assertEqual(p.debugState().decided, 1);
});

test('JevPlanner：并发上限 maxConcurrent 生效', () => {
  const { world } = makeWindowWorld();
  const client = makeControlledClient();
  const p = new JevPlanner({
    world, client, breaker: new FailureBreaker({ now: () => 0, log: makeLogger() }),
    speed: 1.2, log: makeLogger(), now: () => 0, onDecision: () => {}, onFallback: () => {},
  });
  p.setEnabled(true);
  const zs = Array.from({ length: 10 }, (_, i) => ({ id: `z${i}`, position: [8.5, 1, 8.5 + i], mobile: true }));
  p.tick(0, zs);
  assertEqual(client.pending.length, JEV_AI.maxConcurrent, '在途不得超过上限');
});

test('JevPlanner：同一只在途期间不重复入队（周期按回包算）', async () => {
  const { world } = makeWindowWorld();
  const client = makeControlledClient();
  const p = new JevPlanner({
    world, client, breaker: new FailureBreaker({ now: () => 0, log: makeLogger() }),
    speed: 1.2, log: makeLogger(), now: () => 0, onDecision: () => {}, onFallback: () => {},
  });
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
  const p = new JevPlanner({
    world, client, breaker: new FailureBreaker({ now: () => 0, log: makeLogger() }),
    speed: 1.2, log: makeLogger(), now: () => 0, onDecision: () => {},
    onFallback: (id, reason) => fallbacks.push([id, reason]),
  });
  p.setEnabled(true);
  p.tick(0, [{ id: 'z0', position: [8.5, 1, 8.5], mobile: true }]);
  client.pending[0].resolve({ ok: false, reason: 'not-json' });
  await new Promise((r) => setTimeout(r, 0));
  assertEqual(fallbacks.length, 1);
  assertEqual(fallbacks[0][1], 'not-json');
});

test('JevPlanner：熔断期内不发请求', () => {
  const { world } = makeWindowWorld();
  const client = makeControlledClient();
  const breaker = new FailureBreaker({ now: () => 0, log: makeLogger() });
  breaker.recordFailure('a'); breaker.recordFailure('b'); breaker.recordFailure('c');
  assertFalse(breaker.available());
  const p = new JevPlanner({
    world, client, breaker, speed: 1.2, log: makeLogger(), now: () => 0,
    onDecision: () => {}, onFallback: () => {},
  });
  p.setEnabled(true);
  p.tick(0, [{ id: 'z0', position: [8.5, 1, 8.5], mobile: true }]);
  assertEqual(client.pending.length, 0, '冷却期不得发请求');
});

test('JevPlanner：关闭时不发请求且清空记忆', () => {
  const { world } = makeWindowWorld();
  const client = makeControlledClient();
  const p = new JevPlanner({
    world, client, breaker: new FailureBreaker({ now: () => 0, log: makeLogger() }),
    speed: 1.2, log: makeLogger(), now: () => 0, onDecision: () => {}, onFallback: () => {},
  });
  p.setEnabled(true);
  p.tick(0, [{ id: 'z0', position: [8.5, 1, 8.5], mobile: true }]);
  assertTrue(p.debugState().memorySize > 0);
  p.setEnabled(false);
  assertEqual(p.debugState().memorySize, 0, '关闭须清记忆');
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
  for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
    for (let y = WORLD_MIN_Y; y <= 1; y++) col.set(lx, y, lz, stone);
  }
  // 把 (8,8) 周围 3 格高全部围死（含对角 —— 8 方向都不可走 ⇒ buildCandidateSteps 返回空对象）
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    if (dx === 0 && dz === 0) continue;
    for (let dy = 1; dy <= 3; dy++) col.set(8 + dx, dy, 8 + dz, stone);
  }
  world.add(col);
  const client = makeControlledClient();
  const p = new JevPlanner({
    world, client, breaker: new FailureBreaker({ now: () => 0, log: makeLogger() }),
    speed: 1.2, log: makeLogger(), now: () => 0, onDecision: () => {}, onFallback: () => {},
  });
  p.setEnabled(true);
  p.tick(0, [{ id: 'z0', position: [8.5, 1, 8.5], mobile: true }]);
  assertEqual(client.pending.length, 0, '无候选不得发请求');
});

test('JevPlanner：resetMemory 清掉单只记忆（slot 回收路径）', () => {
  const { world } = makeWindowWorld();
  const p = new JevPlanner({
    world, client: makeControlledClient(), breaker: new FailureBreaker({ now: () => 0, log: makeLogger() }),
    speed: 1.2, log: makeLogger(), now: () => 0, onDecision: () => {}, onFallback: () => {},
  });
  p.setEnabled(true);
  p.tick(0, [{ id: 'z0', position: [8.5, 1, 8.5], mobile: true }]);
  assertEqual(p.debugState().memorySize, 1);
  p.resetMemory('z0');
  assertEqual(p.debugState().memorySize, 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx playwright test tests/harness.spec.mjs -g "浏览器内单元测试" 2>&1 | tail -20`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现编排器**

`src/entities/zombies/zombie-jev-planner.js` 新建：

```js
// src/entities/zombies/zombie-jev-planner.js — 在线 AI 编排（选批 / 并发 / 等待期沿用 / 降级）
//
// 同构层：无 DOM、无 three、不自建 Worker。
//
// ## 三条关键口径
//
// ① **决策周期从「回包」算起**，不是从发起算起（spec §3.3）—— 否则慢请求会让同一只被反复排队。
// ② **在途期间沿上一次决策方向走**：`onDecision` 只在回包时调用，这期间 `ZombieService`
//    的 state.velocity 保持不变（Game 侧不覆盖），于是丧尸平滑跟随。
// ③ **完全不 await**：`tick()` 只发起与消费，帧循环零阻塞。
import { JEV_AI } from './zombie-config.js';
import {
  buildJevState, cellKey, DIRECTION_VECTORS, markDeadEnd, memoryFor, noteVisit, parseDirectionChoice,
} from './zombie-ai-view.js';
import { buildQuestions } from './zombie-jev-prompts.js';

export const DEAD_END_TURNS = 1;

export class JevPlanner {
  constructor({ world, client, breaker, speed, log = null, now = () => Date.now(),
    onDecision = () => {}, onFallback = () => {} } = {}) {
    this.world = world;
    this.client = client;
    this.breaker = breaker;
    this.speed = speed;
    this._now = now;
    this._log = log ?? ((typeof console !== 'undefined') ? console : { warn() {} });
    this._onDecision = onDecision;
    this._onFallback = onFallback;
    this.enabled = false;
    /** @type {Map<string, object>} id → 记忆 */
    this._memory = new Map();
    /** @type {Map<string, {startedAt: number}>} 在途请求 */
    this._inflight = new Map();
    /** @type {Map<string, number>} id → 下次可决策的时间戳 */
    this._nextAt = new Map();
    this._stats = { decided: 0, failed: 0, lastReason: '' };
  }

  setEnabled(on) {
    this.enabled = on === true;
    if (!this.enabled) {
      this._inflight.clear();
      this._nextAt.clear();
      this._memory.clear();
    }
  }

  resetMemory(id) { this._memory.delete(id); }

  /**
   * 每帧推进（**不 await**）。
   * @param {number} nowMs
   * @param {Array<{id: string, position: number[], mobile: boolean, playerPosition?: number[]}>} zombies
   *   `mobile=false` 的丧尸（如 blocked）不参与决策
   */
  tick(nowMs, zombies) {
    if (!this.enabled) return;
    if (!this.breaker.available(nowMs)) return;
    for (const z of zombies ?? []) {
      if (!z.mobile) continue;
      if (this._inflight.has(z.id)) continue;                       // 在途：不重复入队
      const next = this._nextAt.get(z.id) ?? 0;
      if (nowMs < next) continue;                                    // 周期未到
      if (this._inflight.size >= JEV_AI.maxConcurrent) break;         // 并发已满
      this._dispatch(z, nowMs);
    }
  }

  async _dispatch(z, nowMs) {
    const mem = memoryFor(this._memory, z.id);
    const playerPosition = z.playerPosition ?? z.position;
    noteVisit(mem, z.position[0], z.position[2]);
    // 死胡同判定（代码侧，spec §3.4）：本格除来路外无出口
    if (mem.trail.length >= 2) {
      const candsHere = buildJevState(this.world, z.position, playerPosition, mem).candidate_steps;
      if (Object.keys(candsHere).length === 0) markDeadEnd(mem, z.position[0], z.position[2]);
    }
    const state = buildJevState(this.world, z.position, playerPosition, mem);
    const questions = buildQuestions(state.candidate_steps);
    if (Object.keys(questions).length === 0) {
      // 四面皆墙：不发请求，交给离线路径（它会输出 blocked）
      this._nextAt.set(z.id, nowMs + JEV_AI.decisionPeriodMs);
      this._onFallback(z.id, 'no-candidates');
      return;
    }
    this._inflight.set(z.id, { startedAt: nowMs });
    const res = await this.client.request({ state, questions });
    this._inflight.delete(z.id);
    this._nextAt.set(z.id, this._now() + JEV_AI.decisionPeriodMs);
    if (!res.ok) {
      this._stats.failed++;
      this._stats.lastReason = res.reason;
      this.breaker.recordFailure(res.reason, this._now());
      this._onFallback(z.id, res.reason);
      return;
    }
    this.breaker.recordSuccess();
    const parsed = parseDirectionChoice(res.answer, state.candidate_steps);
    if (!parsed.ok) {
      this._stats.failed++;
      this._stats.lastReason = parsed.reason;
      try { this._log.warn(`[zombie-ai] ${parsed.reason} id=${z.id}`); } catch { /* ignore */ }
      this._onFallback(z.id, parsed.reason);
      return;
    }
    this._stats.decided++;
    mem.lastDecision = { vx: parsed.vx, vz: parsed.vz, at: nowMs };
    this._onDecision(z.id, {
      vx: parsed.vx * this.speed, vz: parsed.vz * this.speed, mode: 'online',
    });
  }

  debugState() {
    return {
      inflight: this._inflight.size,
      decided: this._stats.decided,
      failed: this._stats.failed,
      lastReason: this._stats.lastReason,
      memorySize: this._memory.size,
    };
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx playwright test tests/harness.spec.mjs -g "浏览器内单元测试" 2>&1 | tail -20`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/entities/zombies/zombie-jev-planner.js src/tests/test-zombie-jev-ai.js
git commit -m "feat(zombie): Jev 编排器（并发上限 / 周期 / 降级回调）"
```

---

### Task 9: `ZombieService` 接线（开关 + 分叉 + 记忆回收）

**Files:**
- Modify: `src/entities/zombies/zombie-system.js`
- Test: `src/tests/test-zombie-jev-ai.js`（追加）
- Test: `src/tests/test-zombies.js`（既有，必须保持全绿）

**Interfaces:**
- Consumes: `JevPlanner`
- Produces:
  - `ZombieService` 构造参数新增 `planner = null`
  - `ZombieService.setOnlineAi(on: boolean) -> void`
  - `ZombieService.onlineAiEnabled() -> boolean`
  - `ZombieService.debugOnlineAi() -> {enabled: boolean, inflight: number, decided: number, failed: number, lastReason: string, memorySize: number}`
  - `ZombieService.update()` 的分叉：`planner.enabled` 为真时**额外**调 `planner.tick(...)`（离线 RPC 照跑，作为兜底方向源；在线回包后写胜）
  - **不改 `_applyIntent` / `setIntent` 的签名**：在线回包走 game.js 的 `onDecision` 回调，内部调既有的 `_applyIntent({id, generation, vx, vz, mode})` —— 它已含 `steerIntent` 贴身避障与速度钳制，故在线决策天然叠加离线避让（spec §3.3 的叠加关系）

- [ ] **Step 1: 写失败测试**

追加到 `src/tests/test-zombie-jev-ai.js`：

```js
import { ZombieService, zombieDefinition } from '../entities/zombies/zombie-system.js';
import { EntityManager } from '../entities/entity-manager.js';

/** 造一个装了 ZombieService 的 fixture（pool 用假 pool，返回真 promise） */
function makeServiceFixture({ planner = null } = {}) {
  const { world, registry } = makeWindowWorld();
  const entities = new EntityManager();
  entities.registerType('zombie', zombieDefinition);   // spawn 需要已注册的类型
  const svc = new ZombieService({ entities, world, pool: null, planner });
  return { world, registry, entities, svc };
}

test('ZombieService：默认在线 AI 关闭，且关闭时不调用 planner', () => {
  const planning = [];
  const fakePlanner = { enabled: false, tick: (...a) => planning.push(a), setEnabled(v) { this.enabled = v; } };
  const { svc } = makeServiceFixture({ planner: fakePlanner });
  assertFalse(svc.onlineAiEnabled());
  svc.update(0.1, { playerPosition: [0, 0, 0] });
  assertEqual(planning.length, 0, '关闭时 planner 不该被 tick');
});

test('ZombieService.setOnlineAi：开启后 tick 到 planner，关闭后清记忆', () => {
  const calls = [];
  const fakePlanner = {
    enabled: false,
    _mem: 0,
    setEnabled(v) { this.enabled = v; if (!v) this._mem = 0; },
    tick: (now, zs) => { calls.push(zs.length); },
    debugState() { return { memorySize: this._mem, inflight: 0, decided: 0, failed: 0, lastReason: '' }; },
    resetMemory() {},
  };
  const { svc } = makeServiceFixture({ planner: fakePlanner });
  svc.setOnlineAi(true);
  assertTrue(svc.onlineAiEnabled());
  assertTrue(fakePlanner.enabled);
  svc.setOnlineAi(false);
  assertFalse(fakePlanner.enabled);
});

test('ZombieService：在线回包写进 state.velocity（走过 _applyIntent）', async () => {
  const { world, registry, entities, svc } = makeServiceFixture();
  // 用真 planner + 受控 client；onDecision 直接接 service 的唯一消费点 _applyIntent
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
  const memSizes = [];
  const fakePlanner = {
    enabled: false, setEnabled(v) { this.enabled = v; },
    tick() {}, resetMemory(id) { memSizes.push(id); },
    debugState() { return { memorySize: 0, inflight: 0, decided: 0, failed: 0, lastReason: '' }; },
  };
  const entities = new EntityManager();
  entities.registerType('zombie', zombieDefinition);
  const svc = new ZombieService({ entities, world, pool: null, planner: fakePlanner });
  const s = svc.spawn([8.5, 1, 8.5]);
  svc.damage(s, 999, 0);
  assertTrue(memSizes.includes(s), 'damage 致死须 resetMemory');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx playwright test tests/harness.spec.mjs -g "浏览器内单元测试" 2>&1 | tail -30`
Expected: FAIL —— `svc.onlineAiEnabled is not a function`。

- [ ] **Step 3: 接线**

在 `src/entities/zombies/zombie-system.js`：

1. 构造函数签名加 `planner = null`，并保存 `this.planner = planner;`
2. 追加三个方法（放在 `debugAiState()` 附近）：

```js
  /**
   * 开关在线 AI（用户 2026-11-03 裁定：面板 + URL 控制）。
   *
   * ⚠️ **关闭必须清记忆与在途**：planner.setEnabled(false) 内部清 `_memory`/`_inflight`。
   * 不清的形态是「关掉再开，丧尸带着关闭前的访问历史」，会以为某些格走过而乱绕。
   * ⚠️ **不销毁 planner**：它只持有常量与 planner 自管理状态，重新开启零成本。
   */
  setOnlineAi(on) {
    this.planner?.setEnabled?.(on === true);
  }

  /** @returns {boolean} 在线 AI 是否启用（planner 未注入时恒 false） */
  onlineAiEnabled() {
    return this.planner?.enabled === true;
  }

  /** @returns {object} 只读测试钩子（未注入 planner 时给全零形状） */
  debugOnlineAi() {
    const base = { enabled: false, inflight: 0, decided: 0, failed: 0, lastReason: '', memorySize: 0 };
    if (!this.planner) return base;
    return { enabled: this.planner.enabled === true, ...(this.planner.debugState?.() ?? {}) };
  }
```

3. 在 `_releaseSlot(id)` 里加一行（三个回收路径共用它）：

```js
    this.planner?.resetMemory?.(id);
```

4. 在 `update(dt, { playerPosition } = {})` 的**开头**（`if (!this.pool) return;` 之前）加：

```js
    // 在线 AI（v2.46）：独立节流，与下面的离线 RPC 互不干扰。
    // ⚠️ **离线路径仍然跑**（作为兜底方向源）：在途期间的 400ms 里丧尸沿离线方向走，
    // 比站着不动自然；在线回包后写胜（后写胜）。
    // ⚠️ `nowMs` 从 `this._nowMs ?? performance.now()` 取 —— 可注入以便单测（浏览器内单测
    // 没有真实帧循环，硬编码 performance.now() 会让「周期未到」这类断言不可控）。
    if (this.planner?.enabled) {
      const nowMs = this._nowMs ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const zs = [];
      for (const entity of this.entities.entities()) {
        if (entity.type !== 'zombie') continue;
        zs.push({
          id: entity.id,
          position: [...entity.state.position],
          playerPosition: [...playerPosition],
          mobile: entity.state.mode !== 'blocked',
        });
      }
      this.planner.tick(nowMs, zs);
    }
    if (!this.pool) return;
```

- [ ] **Step 4: 跑测试确认通过（含既有 test-zombies.js 零回归）**

Run: `npx playwright test tests/harness.spec.mjs -g "浏览器内单元测试" 2>&1 | tail -30`
Expected: PASS，且 `test-zombies.js` 的既有用例全部仍绿（离线路径零回归）。

- [ ] **Step 5: 提交**

```bash
git add src/entities/zombies/zombie-system.js src/tests/test-zombie-jev-ai.js
git commit -m "feat(zombie): ZombieService 接入在线 AI 开关与记忆回收"
```

---

### Task 10: 设置项 + 面板 + Game 装配

**Files:**
- Modify: `src/ui/settings.js`
- Modify: `src/ui/settings-panel.js`
- Modify: `src/core/game.js`
- Test: `src/tests/test-ui.js`

**Interfaces:**
- Produces:
  - `DEFAULT_SETTINGS.onlineZombieAi = false`
  - `resolveSettings` 支持 `?zombieai=1|0`
  - `settings-panel.js` 导出 `ZOMBIE_AI_LABELS = ['关闭', '在线']`
  - `Game.setOnlineZombieAi(on: boolean) -> boolean`
  - `Game.onlineZombieAiEnabled() -> boolean`

- [ ] **Step 1: 写失败测试**

追加到 `src/tests/test-ui.js`：

```js
test('设置：onlineZombieAi 默认关闭，URL ?zombieai=1 可开', () => {
  const base = resolveSettings(null, new URLSearchParams(''));
  assertEqual(base.onlineZombieAi, false, '默认关闭（spec §3.9）');
  const on = resolveSettings(null, new URLSearchParams('zombieai=1'));
  assertEqual(on.onlineZombieAi, true);
  const off = resolveSettings(null, new URLSearchParams('zombieai=0'));
  assertEqual(off.onlineZombieAi, false);
});

test('设置：存档里的 onlineZombieAi 被尊重，且不需要 settingsVersion 迁移', () => {
  const stored = { settingsVersion: 2, onlineZombieAi: true };
  assertEqual(resolveSettings(stored, null).onlineZombieAi, true);
  // 旧存档（无该字段）自然回落默认，不需要迁移
  const old = { settingsVersion: 2 };
  assertEqual(resolveSettings(old, null).onlineZombieAi, false);
});

test('面板：丧尸 AI 文案常量导出且 ≤ 2 字', () => {
  assertDeepEqual(ZOMBIE_AI_LABELS, ['关闭', '在线']);
  for (const l of ZOMBIE_AI_LABELS) assertTrue([...l].length <= 2, `文案须 ≤2 字：${l}`);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx playwright test tests/harness.spec.mjs -g "浏览器内单元测试" 2>&1 | tail -20`
Expected: FAIL —— `onlineZombieAi` undefined / `ZOMBIE_AI_LABELS` 不存在。

- [ ] **Step 3: 三处接线**

`src/ui/settings.js`：`DEFAULT_SETTINGS` 加字段

```js
  // 在线丧尸 AI（v2.46，用户 2026-11-03）：开 = 走 Jev 模型决策，关 = 现有离线 AI（逐位不变）。
  // ⚠️ **不需要 settingsVersion 迁移**：旧存档里根本没有这个字段 → 缺字段自然回落默认
  // （与 chunkPace / pixelRatio 同理；与 fogColor 那次「默认值是关时顺带落盘的假值」相反）。
  onlineZombieAi: false,
```

`resolveSettings` 的 stored 分支加：

```js
    if (typeof stored.onlineZombieAi === 'boolean') s.onlineZombieAi = stored.onlineZombieAi;
```

URL 分支加：

```js
    if (params.has('zombieai')) s.onlineZombieAi = params.get('zombieai') === '1';
```

`src/ui/settings-panel.js`：导出文案常量（放文件顶部导出区）

```js
/** 丧尸 AI 两档文案（≤2 字，左列 375px ÷ 2 按钮的分宽约束） */
export const ZOMBIE_AI_LABELS = ['关闭', '在线'];
```

左列追加一行（`left.appendChild(this._rowTeleport());` 之后）：

```js
    left.appendChild(this._rowZombieAi());
```

新增行构造器（放在 `_rowMusic` 之后）：

```js
  /**
   * v2.46：「丧尸 AI」开关（用户 2026-11-03 裁定：面板 + URL）。
   * **落位 = 左列**：判据是「不抬高面板高度的那一列」（v1.63/v1.92 口径）——
   * 落位前须实测两列高度与 `.mc-content` 是否出现滚动条（本计划 Task 12 的验证步骤）。
   */
  _rowZombieAi() {
    return this._makeGroup('丧尸 AI', [false, true], ZOMBIE_AI_LABELS,
      this.settings.onlineZombieAi,
      (v) => {
        this.settings.onlineZombieAi = v;
        this._save();
        this.game.setOnlineZombieAi(v);   // 运行期立即生效（关 → 取消在途 + 清记忆）
      });
  }
```

`src/core/game.js`：

1. import：

```js
import { JevClient, FailureBreaker } from '../entities/zombies/zombie-jev-client.js';
import { JevPlanner } from '../entities/zombies/zombie-jev-planner.js';
```

2. 在 `this.zombies = new ZombieService({...})` **之前**构造 planner（因为 service 构造要用它）。
   `ZOMBIE` 已在 game.js 第 33 行 import（`import { ZOMBIE } from '../entities/zombies/zombie-config.js';`），**不需要新增 import**：

```js
    // 在线丧尸 AI（v2.46）：client 与 breaker 是**全局**的（额度/冷却按整体算），
    // planner 按 service 注入。⚠️ 必须在 ZombieService 构造之前创建 —— 构造参数要用到它。
    this.jevClient = new JevClient();
    this.jevBreaker = new FailureBreaker();
    this.jevPlanner = new JevPlanner({
      world: this.world,
      client: this.jevClient,
      breaker: this.jevBreaker,
      speed: ZOMBIE.speed,
      onDecision: (id, d) => {
        const entity = this.entities.get(id);
        if (entity) this.zombies._applyIntent({ id, generation: entity.generation, vx: d.vx, vz: d.vz, mode: 'chasing' });
      },
      onFallback: () => { /* 失败已由 client/breaker 打 log；这里保持沉默，让丧尸继续走离线方向 */ },
    });
```

3. `new ZombieService({ ... })` 里加 `planner: this.jevPlanner,`

4. `start()` 的接线（与 `setFogColorEnabled` 的「无条件调用」同手法 —— 不得写成 `if (...) setOnlineZombieAi(true)`）：

```js
    this.setOnlineZombieAi(this.settings.onlineZombieAi === true);
```

5. 新增方法（放在 `setMusicEnabled` 附近）：

```js
  /**
   * 开关在线丧尸 AI（v2.46）。
   * ⚠️ **无条件调用**是载荷性的（与 `setFogColorEnabled` 同一教训）：写成
   * `if (settings.onlineZombieAi) setOnlineZombieAi(true)` 会让「开关为 false」这条路径
   * 依赖一个远处的初值，两条路径口径不对等。
   * @param {boolean} on @returns {boolean} 生效后的状态
   */
  setOnlineZombieAi(on) {
    this.zombies.setOnlineAi(on === true);
    return this.onlineZombieAiEnabled();
  }

  /** @returns {boolean} */
  onlineZombieAiEnabled() {
    return this.zombies.onlineAiEnabled();
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx playwright test tests/harness.spec.mjs -g "浏览器内单元测试" 2>&1 | tail -30`
Expected: PASS（含既有 UI 用例）。

- [ ] **Step 5: 提交**

```bash
git add src/ui/settings.js src/ui/settings-panel.js src/core/game.js src/tests/test-ui.js
git commit -m "feat(zombie): 在线 AI 开关（面板 + ?zombieai= URL + Game 装配）"
```

---

### Task 11: 真实 Jev E2E（Tier 4，U 形墙开关对照）

**Files:**
- Create: `tests/zombie-jev-ai.spec.mjs`

**Interfaces:**
- Consumes: `zombies.spawn()`、`editor.setBlock()`、`game.onlineZombieAiEnabled()`、`?zombieai=` URL

- [ ] **Step 1: 写用例（`tests/zombie-jev-ai.spec.mjs`）**

```js
import { test, expect } from 'playwright/test';

// v2.46：在线丧尸 AI（Jev）真实接口验收（spec §5.2）。
//
// ⚠️ **会真实调用 https://js-perf.cn/typesafe**（用户 2026-11-03 已同意）：每步约 1100 input tokens。
// ⚠️ **单独跑**，不要与全量并发（会与计时型 spec 抢 CPU）：
//     npx playwright test tests/zombie-jev-ai.spec.mjs
//
// 判据 = 开关开/关的对照（spec §5.2 的载荷性要求：若在线 AI 根本没接线，「到不了」与「到了」
// 都会恒定，只有两侧都测才有判别力）。

async function waitWorldReady(page) {
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    return !!(g && g.world && g.player && g.zombies);
  }, { timeout: 90_000 });
}

test('v2.46：开 ?zombieai=1 时丧尸绕墙追上玩家；关时绕不过（对照）', async ({ page }) => {
  test.setTimeout(240_000);

  // ---------- 关：基线（离线 AI 只会 1.2 格局部绕行，5 格宽墙绕不过）----------
  await page.goto('/?vd=4&seed=12345&zombieai=0');
  await waitWorldReady(page);
  const off = await runWallScenario(page);
  expect(await page.evaluate(() => window.__MC_GAME__.onlineZombieAiEnabled())).toBe(false);

  // ---------- 开：在线 AI ----------
  await page.goto('/?vd=4&seed=12345&zombieai=1');
  await waitWorldReady(page);
  // 网关会间歇性拦截（spec §2.1）：首次请求若 not-json 就重试几次，仍失败则跳过
  const on = await runWallScenario(page);
  expect(await page.evaluate(() => window.__MC_GAME__.onlineZombieAiEnabled())).toBe(true);

  const dbg = await page.evaluate(() => window.__MC_GAME__.zombies.debugOnlineAi());

  // 若在线路径一次成功决策都没有（网关全拦），跳过而不是假红
  test.skip(dbg.decided === 0, `在线 AI 全程失败（lastReason=${dbg.lastReason}），跳过质量断言`);

  console.log('[zombie-jev-ai] off =', JSON.stringify(off), 'on =', JSON.stringify(on), 'debug =', JSON.stringify(dbg));
  // 载荷性判据：开的那次必须真的绕过去
  expect(on.crossed, `在线 AI 须绕到墙的玩家这一侧（trace=${JSON.stringify(on.trace)}）`).toBe(true);
  expect(on.endDist).toBeLessThan(on.startDist - 2);
});

/**
 * 造一面 3 格高 × 5 格宽的墙，把丧尸放在墙对面，跑 40 秒。
 * 墙宽取 5（与既有 v2.40 用例同口径）：1.2 格步长的探针要让开 5 格需连续多次偏移。
 */
async function runWallScenario(page) {
  return page.evaluate(async () => {
    const g = window.__MC_GAME__;
    g.setShadowsEnabled(false);                     // 隔离：减半 GPU 负载，不影响 AI
    const p = g.player.physics.pos;
    // 找墙外的一个落点（与玩家同列，往北 9 格）
    const stone = g.registry.idOf('stone');
    const x0 = Math.floor(p.x), z0 = Math.floor(p.z) - 3;      // 墙所在 z
    const y0 = Math.floor(p.y);
    // 5 格宽 × 3 格高
    for (let k = -2; k <= 2; k++) {
      for (let dy = 0; dy < 3; dy++) {
        g.editor.setBlock({ x: x0 + k, y: y0 + dy, z: z0, id: stone });
      }
    }
    // 丧尸放在墙北侧（玩家在墙南侧）
    const spawnX = x0 + 0.5, spawnZ = z0 - 8 + 0.5;
    // 向下扫真实地面
    let spawnY = null;
    for (let y = y0 + 2; y >= y0 - 40; y--) {
      if (g.world.getBlockId(Math.floor(spawnX), y, Math.floor(spawnZ)) === 0
        && g.world.getBlockId(Math.floor(spawnX), y + 1, Math.floor(spawnZ)) === 0
        && g.world.isSolid(Math.floor(spawnX), y - 1, Math.floor(spawnZ))) { spawnY = y; break; }
    }
    if (spawnY === null) return { error: 'no spawn y' };
    const id = g.zombies.spawn([spawnX, spawnY, spawnZ], { source: 'test-online-ai' });
    if (!id) return { error: 'spawn rejected' };
    const startDist = Math.hypot(spawnX - p.x, spawnZ - p.z);
    await new Promise((r) => setTimeout(r, 40_000));
    const st = g.zombies.get(id);
    if (!st) return { error: 'zombie despawned', startDist };
    const now = st.position;
    return {
      id, startDist,
      endDist: Math.hypot(now[0] - p.x, now[2] - p.z),
      crossed: (now[2] - z0) * (p.z - z0) > 0,
      mode: st.mode,
      debug: g.zombies.debugOnlineAi(),
      trace: [[+spawnX.toFixed(2), spawnY, +spawnZ.toFixed(2)], now.map((v) => +v.toFixed(2))],
    };
  });
}
```

- [ ] **Step 2: 跑用例（真实接口）**

Run: `npx playwright test tests/zombie-jev-ai.spec.mjs 2>&1 | tail -40`
Expected: PASS。若打出 `skipped` 且原因是「在线 AI 全程失败（lastReason=…）」，先把 `lastReason` 记下来（多半是 `not-json` = 网关拦截），稍后重跑。

- [ ] **Step 3: 负向验证（必须真红）**

临时把 `Game.setOnlineZombieAi` 改成 no-op（`this.zombies.setOnlineAi(false); return false;`），重跑同一用例。
Expected: **FAIL** —— `expect(await page.evaluate(... onlineZombieAiEnabled())).toBe(true)` 先红（证明开关真的接线）。
改回。

- [ ] **Step 4: 提交**

```bash
git add tests/zombie-jev-ai.spec.mjs
git commit -m "test(zombie): 在线 AI 真实接口 E2E（U 形墙开关对照）"
```

---

### Task 12: 门禁、面板实测与文档

**Files:**
- Modify: `CLAUDE.md`（活跃约束段）
- Modify: `docs/roadmap.md`（版本行）
- Modify: `src/tests/test-ui.js`（如需补面板高度用例）

- [ ] **Step 1: 跑全套门禁**

```bash
npm run check
```
Expected: `check:arch` ✓、`check:data` ✓、`lint` 0 error。

- [ ] **Step 2: 面板高度实测（spec §6.1）**

在真游戏页 evaluate：

```js
const cols = [...document.querySelectorAll('#settings-modal .mc-column')].map((c) => c.getBoundingClientRect().height);
const body = document.querySelector('#settings-modal .mc-content');
({ cols, scrollH: body.scrollHeight, clientH: body.clientHeight, overflow: body.scrollHeight > body.clientHeight });
```

Expected: `overflow === false`（不出现纵向滚动条）。若为 true，把「丧尸 AI」行从左列移到右列并重测。

- `[ ]` **Step 3: 主线程成本实测（spec §6.2）**

在真游戏页 `?zombieai=1`、20 只丧尸时读 `perf.snapshot().frameMs`（**不是** rAF 包 `performance.now()`）。
Expected: p95 与关闭时相差 < 1ms。若回退，先把 `JEV_AI.windowSize` 降到 7 并重测（7×7 只在长迷宫上退化，游戏内通常够）。

- [ ] **Step 4: 真实游戏内绕通验证（spec §6.3）**

`?vd=4&seed=12345&zombieai=1`，按 `K`（调试键）在玩家附近刷丧尸，观察它是否绕过障碍。
Expected: 观察到绕路行为；`console` 无 `[zombie-ai]` 报错刷屏。

- [ ] **Step 5: 文档**

`CLAUDE.md` 追加一节「丧尸在线 AI 沉淀的活跃约束」，至少包含：
- 可走性由代码算、模型只做方向取舍（只传矩阵时 4/12 选墙）；
- 记忆必须由代码维护（去掉后退化成无限绕圈）；
- `windowSize = 9` 是实测标定值；
- `not-json` 与「没有答案」必须区分（网关拦截返回 HTML）；
- 开关关闭必须逐位零回归；
- 真游戏页 E2E 会消耗额度。

`docs/roadmap.md` 追加 v2.46 行。

- [ ] **Step 6: 提交**

```bash
git add CLAUDE.md docs/roadmap.md src/tests/test-ui.js
git commit -m "docs: 丧尸在线 AI 活跃约束与 roadmap v2.46"
```

---

## 自检记录

**已修正的执行期陷阱**（写完计划后核对既有代码发现，全部已改在正文里）：

1. `ChunkColumn` 的写方法是 **`set(lx,y,lz,id)`**（不是 `setBlock`），`WorldData` 的挂载是 **`world.add(col)`**（不是 `addColumn`）—— 否则 fixture 根本建不起来。
2. `EntityManager` 在 `spawn` 前必须 **`entities.registerType('zombie', zombieDefinition)`**，否则 spawn 恒失败。
3. Task 9 的两条用例原本引用了未定义的 `svc`（变量名不一致）—— 改为统一从 `makeServiceFixture()` 解构，并显式用 `await` 而非 `return promise`（真实 runner 不 await 测试返回值）。
4. Task 9 原本写「`_applyIntent` 增加第三参 `viaOnline`」—— **实际上不需要改签名**：在线回包走 game.js 的 `onDecision` → 既有 `_applyIntent({id,generation,vx,vz,mode})`，它已含 `steerIntent` 与速度钳制（这正是 spec §3.3 要的叠加关系）。签名改动已删除。
5. `update()` 里的时钟原本硬编码 `performance.now()` —— 改为 `this._nowMs ?? performance.now()`，让单测能控制「周期未到」。
6. game.js 的 `ZOMBIE` 已在文件头 import，不需要新增（计划里已注明）。

- **spec 覆盖**：§1.2 目标 → Task 8/9；§1.3 非目标（不做寻路）→ 全程无 A*/BFS；§2.2 可走性由代码算 → Task 3；§2.4 记忆 → Task 1/8；§2.5 窗口 9 → Task 1；§2.6 只 1 个 choice → Task 4；§3.3 周期/并发 → Task 1/8；§3.4 死胡同 → Task 8；§3.5 state 形状 → Task 3；§3.6 题面 → Task 4；§3.7 答案映射与兜底 → Task 5；§3.8 失败与熔断 → Task 6/7；§3.9 开关 → Task 10；§4.1 零回归 → Task 9 Step 4；§4.2 主线程成本 → Task 12 Step 3；§5 测试计划 → Task 1~11；§6 落地实测 → Task 12；§7 取舍 → 文档 Task 12。
- **类型一致性**：`buildJevState`/`buildCandidateSteps`/`buildQuestions`/`parseDirectionChoice`/`JevClient.request`/`FailureBreaker`/`JevPlanner.tick` 的签名在 Task 3~8 之间逐处对齐；`_applyIntent({id, generation, vx, vz, mode})` 沿用既有签名（Task 9 未改它）。
- **Review Focus 覆盖**：① `not-json` → Task 6 Step 1 的 HTML 用例；② 非法方向 → Task 5 的三个 reason 用例 + Task 8 的 `blocked-direction`；③ 开关关闭零请求 → Task 8「关闭时不发请求」；④ `steerIntent` 顺序 → Task 9 走 `_applyIntent`（既有实现里已含 steer）；⑤ 记忆泄漏 → Task 9 的死亡重置用例 + Task 8 的 `resetMemory`；⑥ 未加载 column 当墙 → Task 2 用例 + Task 4 的 legend 断言。
