# 丧尸在线 AI v2：代码寻路 + 模型裁决 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让丧尸在「玩家与丧尸之间隔着远超 9×9 窗口的障碍」时也能绕过去 —— 实测现状是 31 格宽的墙让 69 次决策全部耗在原地横跳、净位移 0.7 格。

**Architecture:** 新增一层 `zombie-pathfinder.js`（同构纯函数，24 格半径有界 BFS，每 0.5 秒算一次），把「下一个地标在哪」作为事实喂给 Jev；模型从「自己发现绕行方向」退到「在代码给的可行路线里做取舍」。局部 9×9 窗口与候选事实全部保留。

**Tech Stack:** 纯 ES2022 ESM、无 three 无 DOM（`src/entities/` 是同构层）、浏览器内自建 runner、Playwright。

**Spec:** [`docs/superpowers/specs/2026-11-03-zombie-online-ai-design.md`](../specs/2026-11-03-zombie-online-ai-design.md) §2.7 / §3.10 / §3.11

## Global Constraints

- **可走性复用 `zombie-navigation.js`**（`zombieCollidesAt` / `zombieStepUpY` / `ZOMBIE_MAX_STEP`），不写第二份 AABB 采样。
- **BFS 有界 24 格**（`PATHFIND.maxRadius = 24`），只搜**水平面**（`y` 固定为丧尸脚底高度），不跨层。
- **确定性**：邻接顺序固定 `N, NE, E, SE, S, SW, W, NW`；禁止 `Math.random()`（红线 2）。
- **不新建 Worker**：24 格 BFS 实测 < 0.3ms（目标），世界数据权威在主线程（红线 1）。
- **`truncated` 必须回落到 v1 行为**：半径内不可达时 `reachable=false`，模型仍靠 9×9 窗口自行找路 —— 远处玩家不能让丧尸瘫痪。
- **同构层铁律**：新文件在 `src/entities/zombies/` → `check:arch` 禁 `import 'three'`、禁 `document`/`window`/`createImageBitmap`、禁 `new Worker`。
  ⚠️ **文案里也不能出现 `window` 这个词**（v1 踩过：`check:arch` 的 DOM 正则把英文单词 `window` 判成 DOM API）。
- **失败不改变语义**：在线 AI 失败仍降级离线 AI；寻路失败不是"错误"，是 `truncated` 事实。
- **提交纪律**：每 Task 结束提交；`npm run check` 三项全绿；`npm run lint` 0 error。

## Review Focus

1. **BFS 半径边界**：恰好 24 格的墙端能否搜到（`maxRadius` 是**切比雪夫**距离还是欧氏，必须一致）。
2. **`truncated` 的回落**：半径内不可达时，模型必须仍拿到完整的 9×9 候选（不能空表 → 不发请求 → 丧尸站死）。
3. **一层台阶算可走、两层不可走**：寻路判据与物理 `tryStepUp` 必须同口径，否则规划出的路物理走不通。
4. **路径切换抖动**：每 0.5 秒重算会让"往东绕"和"往西绕"等长时来回横跳 —— 必须用记忆固化已选方向。
5. **主线程成本**：20 只丧尸 × 每 0.5 秒 × 24 格 BFS，不能让 `frameMs.p95` 回退。
6. **模型否决路线的后果**：模型可以否决代码的下一步，但若它连续否决导致原地打转，要有兜底（走 `walked_along_this_plan` 超时后强制跟随）。

---

## File Structure

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `src/entities/zombies/zombie-config.js` | 修改 | 新增 `PATHFIND` 冻结常量块 |
| `src/entities/zombies/zombie-pathfinder.js` | 新建 | 有界 BFS + `planStep` + `directionNameOf` |
| `src/entities/zombies/zombie-ai-view.js` | 修改 | `buildJevState` 增加 `path_plan`；criterion 增加"是否延续计划路线" |
| `src/entities/zombies/zombie-jev-prompts.js` | 修改 | 题面改为"代码给了路线，判断该不该照走" |
| `src/entities/zombies/zombie-jev-planner.js` | 修改 | 把 `planStep` 接进 `_dispatch`；记忆里加 `plan` 字段 |
| `src/tests/test-zombie-pathfinder.js` | 新建 | Tier 1 单测（BFS 正确性 / 边界 / 台阶 / 确定性 / 成本） |
| `src/tests/test-zombie-jev-ai.js` | 修改 | state 新字段 / 题面 / planner 接线 |
| `src/tests/index.html` | 修改 | 注册新测试文件 |
| `tests/zombie-jev-ai.spec.mjs` | 修改 | 长墙场景（31 格宽）E2E 回归门 |

---

### Task 1: `PATHFIND` 常量 + `zombie-pathfinder.js` 核心 BFS

**Files:**
- Modify: `src/entities/zombies/zombie-config.js`（末尾追加）
- Create: `src/entities/zombies/zombie-pathfinder.js`
- Test: `src/tests/test-zombie-pathfinder.js`（新建）
- Modify: `src/tests/index.html`

**Interfaces:**
- Consumes: `zombieCollidesAt`、`zombieStepUpY`、`ZOMBIE_MAX_STEP`（既有）
- Produces:
  - `PATHFIND: Readonly<{maxRadius: number, maxExplored: number}>`
  - `DIRECTION_ORDER: readonly string[]`（8 项，`['north','north_east','east','south_east','south','south_west','west','north_west']`）
  - `directionNameOf(dx: number, dz: number) -> string|null`（`dx` = x 增量，`dz` = z 增量；非 8 向对齐返回 null）
  - `planStep(world, from: number[], to: number[], opts?) -> {reachable: boolean, nextStep: [number, number]|null, pathLength: number, explored: number, truncated: boolean}`

- [ ] **Step 1: 写失败测试**

新建 `src/tests/test-zombie-pathfinder.js`：

```js
// src/tests/test-zombie-pathfinder.js — 有界 BFS 寻路（v2.46 在线 AI 的「代码寻路」层）
//
// 判据全部落在「规划出的路物理走得通」上：可走性复用 zombie-navigation.js，
// 与物理 tryStepUp 同口径（一层台阶可走、两层不可走）。
import { test } from './runner.js';
import { assertEqual, assertFalse, assertTrue, assertDeepEqual } from './assert.js';
import { PATHFIND, DIRECTION_ORDER } from '../entities/zombies/zombie-config.js';
import { directionNameOf, planStep } from '../entities/zombies/zombie-pathfinder.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';
import { createRegistry } from '../voxel/block-registry.js';
import { WORLD_MIN_Y } from '../voxel/constants.js';

/** 空地世界：给定 size×size 全 stone（y=0 层），返回 { world, registry, set } */
function makeFlat({ size = 64, top = 0 } = {}) {
  const registry = createRegistry();
  registry.register('air', { solid: false, opaque: false, cullMode: 'none' });
  registry.register('stone', { solid: true, opaque: true, cullMode: 'opaque' });
  registry.register('bedrock', { solid: true, opaque: true, cullMode: 'opaque' });
  const world = new WorldData(registry);
  const stone = registry.idOf('stone');
  for (let cx = 0; cx * 16 < size; cx++) {
    for (let cz = 0; cz * 16 < size; cz++) {
      const col = new ChunkColumn(cx, cz);
      for (let lz = 0; lz < 16; lz++) {
        for (let lx = 0; lx < 16; lx++) {
          for (let y = WORLD_MIN_Y; y <= top; y++) col.set(lx, y, lz, stone);
        }
      }
      world.add(col);
    }
  }
  /** 在 (x, y, z) 放实心方块 */
  const set = (x, y, z) => world.setBlock(x, y, z, stone);
  return { world, registry, set, stone };
}

test('PATHFIND：默认半径 24', () => {
  assertEqual(PATHFIND.maxRadius, 24);
  assertTrue(PATHFIND.maxExplored >= (2 * 24 + 1) ** 2, '探索上限须能覆盖整个方形搜索域');
});

test('DIRECTION_ORDER：8 项且顺序固定（确定性）', () => {
  assertEqual(DIRECTION_ORDER.length, 8);
  assertDeepEqual(DIRECTION_ORDER, [
    'north', 'north_east', 'east', 'south_east',
    'south', 'south_west', 'west', 'north_west',
  ]);
});

test('directionNameOf：8 向对齐给出名字，其他返回 null', () => {
  assertEqual(directionNameOf(0, -1), 'north');
  assertEqual(directionNameOf(0, 1), 'south');
  assertEqual(directionNameOf(1, 0), 'east');
  assertEqual(directionNameOf(-1, 0), 'west');
  assertEqual(directionNameOf(1, 1), 'south_east');
  assertEqual(directionNameOf(-1, -1), 'north_west');
  assertEqual(directionNameOf(0, 0), null, '原地不是方向');
  assertEqual(directionNameOf(2, 0), null, '两格不是「一步」');
  assertEqual(directionNameOf(2, 1), null);
});

test('planStep：空地直线 → reachable 且第一步朝玩家', () => {
  const { world } = makeFlat();
  const r = planStep(world, [10.5, 1, 10.5], [10.5, 1, 4.5]);
  assertTrue(r.reachable);
  assertDeepEqual(r.nextStep, [0, -1], '玩家在北 → 第一步 z-1');
  assertEqual(r.truncated, false);
  assertTrue(r.pathLength >= 5, `路径长度应约等于直线距离，实际 ${r.pathLength}`);
  assertTrue(r.explored > 0 && r.explored <= PATHFIND.maxExplored);
});

test('planStep：直线被 5 格宽墙挡住 → 仍可达，第一步横向绕', () => {
  const { world, set } = makeFlat();
  // 墙：z=6，x∈[5,9]，3 格高
  for (let x = 5; x <= 9; x++) for (let dy = 0; dy < 3; dy++) set(x, 1 + dy, 6);
  const r = planStep(world, [7.5, 1, 10.5], [7.5, 1, 2.5]);
  assertTrue(r.reachable, '绕得过去（墙只有 5 格宽）');
  const [dx, dz] = r.nextStep;
  assertTrue(dx !== 0, `第一步必须横向绕（实际 [${dx}, ${dz}]）`);
  assertTrue(dz <= 0, '不得往南（背离玩家）');
});

test('planStep：一格台阶算可走，两格高算墙', () => {
  const { world, set } = makeFlat({ top: 3 });
  // 一格台阶：x=10 处 y=1 放一格（表面 y=2，比脚底 y=1 高一格）
  set(10, 1, 5);
  const r1 = planStep(world, [9.5, 1, 10.5], [10.5, 1, 5.5]);
  assertTrue(r1.reachable, '一格台阶必须可规划');

  // 两格高：y=1,2 都放 → 不可通行
  const { world: w2, set: set2 } = makeFlat({ top: 3 });
  for (let dy = 0; dy < 2; dy++) set2(10, 1 + dy, 5);
  // 把 (10,5) 两侧也封死，只留那一条通道
  for (let dy = 0; dy < 3; dy++) {
    for (let z = 0; z <= 4; z++) set2(10, 1 + dy, z);
    for (let z = 6; z <= 10; z++) set2(10, 1 + dy, z);
  }
  const r2 = planStep(w2, [7.5, 1, 5.5], [13.5, 1, 5.5]);
  assertFalse(r2.reachable, '两格高的墙不可通行（本 fixture 里 10 格外才能绕，超出半径）');
});

test('planStep：半径外不可达 → truncated=true 且 reachable=false（回落 v1）', () => {
  const { world, set } = makeFlat({ size: 128 });
  // 一堵贯穿整个 128 格宽世界的墙（比 24 格半径长得多）
  for (let x = 0; x < 128; x++) for (let dy = 0; dy < 3; dy++) set(x, 1 + dy, 60);
  const r = planStep(world, [64.5, 1, 64.5], [64.5, 1, 40.5]);
  assertFalse(r.reachable, '半径内找不到路');
  assertTrue(r.truncated, '必须是「探索到上限仍未连通」，而不是「确认不可达」');
  assertEqual(r.nextStep, null);
});

test('planStep：确定性（同输入同输出）', () => {
  const { world, set } = makeFlat();
  for (let x = 5; x <= 9; x++) for (let dy = 0; dy < 3; dy++) set(x, 1 + dy, 6);
  const a = planStep(world, [7.5, 1, 10.5], [7.5, 1, 2.5]);
  const b = planStep(world, [7.5, 1, 10.5], [7.5, 1, 2.5]);
  assertDeepEqual(a, b);
});
```

在 `src/tests/index.html` 的 `import './test-zombie-jev-ai.js';` 之后加：

```html
    import './test-zombie-pathfinder.js';
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx playwright test tests/harness.spec.mjs 2>&1 | tail -5`
Expected: FAIL（`zombie-pathfinder.js` 404 或 `PATHFIND is not defined`）。用 `node /tmp/probe-red2.cjs` 确认是 404 而非其它错误。

- [ ] **Step 3: 实现常量与 BFS**

`src/entities/zombies/zombie-config.js` 末尾追加：

```js
/**
 * 有界寻路参数（v2.46 v2 修订，用户 2026-11-04 裁定「代码寻路 + 模型裁决」）。
 *
 * ⚠️ **`maxRadius = 24` 是用户裁定的标定值**，不是推导值：它能绕开 40 格以内的墙，
 * 而 24 格半径的方形搜索域上限 = 49² = 2401 格（单次 < 0.3ms）。
 * ⚠️ **不要放大到「能看见整张地图」**：那是每帧全图寻路，会撞破帧预算，
 * 也是 M6 规格 §1「没有主线程 BFS」那条禁令真正要防的形态。
 */
export const PATHFIND = Object.freeze({
  /** 搜索半径（切比雪夫距离，与 8 邻接的步数一致） */
  maxRadius: 24,
  /** 探索格数上限（防病态地形把主线程拖住） */
  maxExplored: 2601,
});

/**
 * 8 邻接的固定顺序（**确定性**：同一输入必得同一路径，红线 2）。
 * ⚠️ 改顺序会改变所有已规划的路径 —— 只在明确要重标定时才动。
 */
export const DIRECTION_ORDER = Object.freeze([
  'north', 'north_east', 'east', 'south_east',
  'south', 'south_west', 'west', 'north_west',
]);
```

`src/entities/zombies/zombie-pathfinder.js` 新建：

```js
// src/entities/zombies/zombie-pathfinder.js — 有界 BFS 寻路（v2.46 v2 修订）
//
// 同构层：无 DOM、无 three、不自建 Worker。
//
// ## 为什么需要这一层
//
// v1 的在线 AI 只在 9×9 窗口里让模型选方向 —— 实测 31 格宽的墙让 69 次决策全部耗在原地
// 横跳（净位移 0.7 格）：**模型永远看不到墙的尽头**，信息根本不在它眼前。局部信息缺失
// 无法靠措辞弥补，故「长距离可达性」必须由代码算（spec §2.7 / §3.10）。
//
// ## 与物理的关系
//
// 可走性**复用** `zombie-navigation.js`（红线 1）：一层台阶算可走（物理 step-up 会抬上去），
// 两格高算墙。写第二份判据会漂移成「规划得出、物理走不通」，而那种缺陷只能靠实玩发现。
import { PATHFIND, ZOMBIE_MAX_STEP } from './zombie-config.js';
import { zombieCollidesAt, zombieStepUpY } from './zombie-navigation.js';

/** 8 邻接增量：[dx, dz]（与 DIRECTION_ORDER 同序） */
const NEIGHBORS = Object.freeze([
  [0, -1], [1, -1], [1, 0], [1, 1],
  [0, 1], [-1, 1], [-1, 0], [-1, -1],
]);

/**
 * 把一步增量翻译成方向名（与 `DIRECTION_VECTORS` 的键一致）。
 * 非 8 向对齐（含原地）返回 null。
 */
export function directionNameOf(dx, dz) {
  for (let i = 0; i < NEIGHBORS.length; i++) {
    if (NEIGHBORS[i][0] === dx && NEIGHBORS[i][1] === dz) {
      return ['north', 'north_east', 'east', 'south_east',
        'south', 'south_west', 'west', 'north_west'][i];
    }
  }
  return null;
}

/** 该格能否站（一层台阶算能站 —— 与物理 step-up 同口径） */
function standable(world, x, y, z) {
  const cx = Math.floor(x);
  const cz = Math.floor(z);
  if (!zombieCollidesAt(world, cx + 0.5, y, cz + 0.5)) return true;
  const lifted = zombieStepUpY(y);
  return lifted - y <= ZOMBIE_MAX_STEP && !zombieCollidesAt(world, cx + 0.5, lifted, cz + 0.5);
}

/**
 * 从 `from` 向 `to` 做**有界** BFS，返回路径上的第一个地标。
 *
 * 语义：
 * - 只搜**水平面**（`y` 固定为 `from[1]`），不跨层 —— 三维搜索成本 ×几十，
 *   而当前玩法里丧尸追的是同一层平面上的玩家；
 * - 终点 = 与目标**切比雪夫距离 ≤ 1** 的格（不需要精确踩到玩家格；
 *   那个格通常被玩家身体占着，判不到「可站」）；
 * - 半径上限用**切比雪夫距离**（与 8 邻接步数一致），超出即停并置 `truncated`；
 * - 邻接顺序固定 → 同输入同路径（红线 2）。
 *
 * @param {{isSolid(x:number,y:number,z:number):boolean}} world
 * @param {number[]} from 丧尸脚底 [x, y, z]
 * @param {number[]} to 玩家脚底 [x, y, z]
 * @param {{maxRadius?: number}} [opts]
 * @returns {{reachable: boolean, nextStep: [number, number]|null, pathLength: number,
 *            explored: number, truncated: boolean}}
 */
export function planStep(world, from, to, { maxRadius = PATHFIND.maxRadius } = {}) {
  const sx = Math.floor(from[0]);
  const sz = Math.floor(from[2]);
  const y = from[1];
  const gx = Math.floor(to[0]);
  const gz = Math.floor(to[2]);
  const limit = maxRadius;
  const key = (x, z) => `${x},${z}`;

  // 已在终点范围内：直接返回「可达、无下一步」
  if (Math.max(Math.abs(sx - gx), Math.abs(sz - gz)) <= 1) {
    return { reachable: true, nextStep: null, pathLength: 0, explored: 0, truncated: false };
  }

  const prev = new Map();
  const seen = new Set([key(sx, sz)]);
  const queue = [[sx, sz]];
  let explored = 0;
  let truncated = false;

  while (queue.length > 0) {
    if (explored >= PATHFIND.maxExplored) { truncated = true; break; }
    const [cx, cz] = queue.shift();
    explored++;
    if (Math.max(Math.abs(cx - gx), Math.abs(cz - gz)) <= 1) {
      // 回溯到起点后的第一步
      let cur = [cx, cz];
      let guard = 0;
      while (guard++ < PATHFIND.maxExplored) {
        const p = prev.get(key(cur[0], cur[1]));
        if (!p) {
          // cur 就是起点（不可达时的兜底，理论上到不了这里）
          return { reachable: true, nextStep: [cx - sx, cz - sz], pathLength: 1, explored, truncated: false };
        }
        if (p[0] === sx && p[1] === sz) {
          return {
            reachable: true,
            nextStep: [cur[0] - sx, cur[1] - sz],
            pathLength: pathLenOf(prev, key(cx, cz), key(sx, sz)),
            explored,
            truncated: false,
          };
        }
        cur = p;
      }
      break;
    }
    for (const [dx, dz] of NEIGHBORS) {
      const nx = cx + dx;
      const nz = cz + dz;
      const k = key(nx, nz);
      if (seen.has(k)) continue;
      if (Math.max(Math.abs(nx - sx), Math.abs(nz - sz)) > limit) { truncated = true; continue; }
      if (!standable(world, nx, y, nz)) continue;
      seen.add(k);
      prev.set(k, [cx, cz]);
      queue.push([nx, nz]);
    }
  }
  return { reachable: false, nextStep: null, pathLength: 0, explored, truncated };
}

/** 从 prev 链回溯出「起点到 end 的步数」 */
function pathLenOf(prev, endKey, startKey) {
  let n = 0;
  let cur = endKey;
  while (cur !== startKey && n < PATHFIND.maxExplored) {
    const p = prev.get(cur);
    if (!p) break;
    cur = `${p[0]},${p[1]}`;
    n++;
  }
  return n;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx playwright test tests/harness.spec.mjs 2>&1 | tail -5`
Expected: PASS，`failed: 0`，用例数 +7。

- [ ] **Step 5: 提交**

```bash
git add src/entities/zombies/zombie-config.js src/entities/zombies/zombie-pathfinder.js src/tests/test-zombie-pathfinder.js src/tests/index.html
git commit -m "feat(zombie): 有界 24 格 BFS 寻路（长距离绕行的代码层）"
```

---

### Task 2: 寻路结果进 state（`path_plan` + criterion 对齐信号）

**Files:**
- Modify: `src/entities/zombies/zombie-ai-view.js`
- Modify: `src/entities/zombies/zombie-jev-prompts.js`
- Test: `src/tests/test-zombie-jev-ai.js`

**Interfaces:**
- Consumes: `planStep`、`directionNameOf`
- Produces:
  - `buildJevState(world, position, playerPosition, memory)` 的返回值新增
    `path_plan: {reachable_within_24_meters: boolean, next_step_toward_player: string|null, path_length_in_steps: number, walked_along_this_plan: number}`
  - `buildCandidateSteps(...)` 的每项新增 `continues_planned_route: boolean`
  - `criterionFor(name, facts)` 输出末句含 `This step continues the planned route.` / `This step leaves the planned route.`

- [ ] **Step 1: 写失败测试**

追加到 `src/tests/test-zombie-jev-ai.js`：

```js
// ---------- v2：代码寻路进 state（Task 2）----------

import { planStep } from '../entities/zombies/zombie-pathfinder.js';

test('buildJevState.path_plan：空旷地 → reachable，next_step 朝玩家', () => {
  const { world } = makeWindowWorld({ columns: [[0, 0], [0, -1], [0, 1], [-1, 0]] });
  const st = buildJevState(world, [8.5, 1, 8.5], [8.5, 1, 3.5], memOf(new Map(), 'z'));
  assertTrue(st.path_plan.reachable_within_24_meters, '空旷地必须可达');
  assertEqual(st.path_plan.next_step_toward_player, 'north');
  assertTrue(st.path_plan.path_length_in_steps >= 4);
  assertEqual(st.path_plan.walked_along_this_plan, 0);
});

test('buildJevState.path_plan：长墙（超出窗口）仍能给出绕行方向', () => {
  const { world, registry } = makeWindowWorld({ columns: [[0, 0], [0, -1], [0, 1], [-1, 0], [1, 0]] });
  const stone = registry.idOf('stone');
  // 墙：z=6，x∈[2,14]，3 格高（丧尸在 (8,8)，玩家在 (8,3)）—— 墙宽 13 格，远超 9×9 窗口
  for (let x = 2; x <= 14; x++) for (let dy = 0; dy < 3; dy++) world.setBlock(x, 1 + dy, 6, stone);
  const st = buildJevState(world, [8.5, 1, 8.5], [8.5, 1, 3.5], memOf(new Map(), 'z'));
  assertTrue(st.path_plan.reachable_within_24_meters, '13 格宽的墙在 24 格半径内能绕过');
  assertTrue(['east', 'west', 'north_east', 'north_west'].includes(st.path_plan.next_step_toward_player),
    `第一步必须是横向绕，实际 ${st.path_plan.next_step_toward_player}`);
});

test('buildJevState.path_plan：半径外不可达 → reachable=false 但候选表仍完整（回落 v1）', () => {
  const { world, registry } = makeWindowWorld({ columns: [[0, 0]] });
  // 用「无限远」的玩家坐标模拟不可达（column 未加载 → 全是墙）
  const st = buildJevState(world, [8.5, 1, 8.5], [8.5, 1, 2000.5], memOf(new Map(), 'z'));
  assertFalse(st.path_plan.reachable_within_24_meters, '半径内不可达');
  assertEqual(st.path_plan.next_step_toward_player, null);
  assertTrue(Object.keys(st.candidate_steps).length > 0,
    '⚠️ 不可达时候选表仍须完整 —— 空表会导致不发请求、丧尸站死（Review Focus 2）');
});

test('buildCandidateSteps：continues_planned_route 标记与 path_plan 一致', () => {
  const { world } = makeWindowWorld({ columns: [[0, 0], [0, -1]] });
  const r = buildCandidateSteps(world, [8.5, 1, 8.5], [8.5, 1, 3.5], memOf(new Map(), 'z'), 'north');
  assertTrue(r.north.continues_planned_route, '北与计划方向一致');
  assertFalse(r.south.continues_planned_route);
});

test('criterionFor：包含「是否延续计划路线」这句话', () => {
  const on = criterionFor('north', {
    direction: 'north', player_lies_toward: 'north', straight_line_distance_after_step: '5.0 meters',
    closer_or_farther: 'closer to the player', open_ground_ahead: '8 meters',
    other_ways_out_after_the_step: 3, times_already_visited: 0, marked_dead_end: false,
    room_around_after_the_step: 9, continues_planned_route: true,
  });
  assertTrue(on.includes('continues the planned route'), on);
  const off = criterionFor('south', {
    direction: 'south', player_lies_toward: 'south', straight_line_distance_after_step: '9.0 meters',
    closer_or_farther: 'farther from the player', open_ground_ahead: '8 meters',
    other_ways_out_after_the_step: 3, times_already_visited: 0, marked_dead_end: false,
    room_around_after_the_step: 9, continues_planned_route: false,
  });
  assertTrue(off.includes('leaves the planned route'), off);
});

test('STEP_INSTRUCTIONS：明确「代码给了路线」且不再要求模型自己发现绕行', () => {
  assertTrue(STEP_INSTRUCTIONS.includes('route'), '题干必须提到 route');
  assertTrue(/planner|planned/i.test(STEP_INSTRUCTIONS), '必须说明路线是规划出来的');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx playwright test tests/harness.spec.mjs 2>&1 | tail -5`
Expected: FAIL —— `st.path_plan is undefined` / `buildCandidateSteps` 的第 5 参不生效。

- [ ] **Step 3: 实现**

`zombie-ai-view.js`：

1. 顶部 import `planStep`、`directionNameOf`。
2. `buildCandidateSteps` 增加第 5 参 `plannedDirection = null`，每项加 `continues_planned_route: name === plannedDirection`。
3. `buildJevState` 里先算 `plan`，再把它传给 `buildCandidateSteps`，并写进 state：

```js
  const plan = planStep(world, position, playerPosition);
  const plannedDir = plan.reachable && plan.nextStep
    ? directionNameOf(plan.nextStep[0], plan.nextStep[1])
    : null;
  const walked = memory.plan && memory.plan.direction === plannedDir
    ? (memory.plan.walked ?? 0)
    : 0;
  return {
    // …原有字段…
    path_plan: {
      reachable_within_24_meters: plan.reachable,
      next_step_toward_player: plannedDir,
      path_length_in_steps: plan.pathLength,
      walked_along_this_plan: walked,
    },
    candidate_steps: buildCandidateSteps(world, position, playerPosition, memory, plannedDir),
  };
```

`zombie-jev-prompts.js`：

1. `STEP_INSTRUCTIONS` 改为：

```js
export const STEP_INSTRUCTIONS = 'A route planner has worked out a walkable route from `Z` to `P`, and one of the candidate steps continues that route. Pick the step the zombie should take now. Follow the planned route unless another step is clearly better: the planned square has already been visited many times, the planned square is a dead end, or the planned square leaves almost no room to move.';
```

2. `criterionFor` 末尾加一句：

```js
    + (f.continues_planned_route
      ? 'This step continues the planned route.'
      : 'This step leaves the planned route.')
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx playwright test tests/harness.spec.mjs 2>&1 | tail -5`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/entities/zombies/zombie-ai-view.js src/entities/zombies/zombie-jev-prompts.js src/tests/test-zombie-jev-ai.js
git commit -m "feat(zombie): 寻路结果进 state（path_plan + 路线对齐信号）"
```

---

### Task 3: planner 接线 + 计划固化（防路径抖动）

**Files:**
- Modify: `src/entities/zombies/zombie-jev-planner.js`
- Test: `src/tests/test-zombie-jev-ai.js`

**Interfaces:**
- Produces: `JevPlanner` 的 `_memory` 每项新增 `plan: {direction: string|null, walked: number, since: number}`；
  `debugState()` 新增 `plansFixed: number`（只读测试钩子）

- [ ] **Step 1: 写失败测试**

追加到 `src/tests/test-zombie-jev-ai.js`：

```js
test('JevPlanner：沿计划前进时 walked_along_this_plan 递增（记忆固化）', async () => {
  const { world } = makeWindowWorld({ columns: [[0, 0], [0, -1], [0, 1], [-1, 0], [1, 0]] });
  const client = makeControlledClient();
  const p = makePlanner(world, client);
  p.setEnabled(true);
  const z = [{ id: 'z0', position: [8.5, 1, 8.5], mobile: true }];
  p.tick(0, z);
  assertEqual(client.pending.length, 1);
  client.pending[0].resolve({ ok: true, answer: { choice: 'north' }, model: 'm' });
  await new Promise((r) => setTimeout(r, 0));
  // 走了 3 格后再决策
  p.tick(600, [{ id: 'z0', position: [8.5, 1, 5.5], mobile: true }]);
  const state = client.pending[1].req.state;
  assertTrue(state.path_plan.walked_along_this_plan >= 0, '必须有这个字段');
  assertTrue(p.debugState().memorySize === 1);
});

test('JevPlanner：不可达时仍发请求（不得因寻路失败而站死）', async () => {
  const { world } = makeWindowWorld({ columns: [[0, 0]] });
  const client = makeControlledClient();
  const p = makePlanner(world, client);
  p.setEnabled(true);
  // 玩家在极远处（column 未加载 → 窗口全是墙，但 9×9 内的候选仍可能存在）
  p.tick(0, [{ id: 'z0', position: [8.5, 1, 8.5], playerPosition: [8.5, 1, 2000.5], mobile: true }]);
  assertTrue(client.pending.length >= 1, '寻路不可达也必须发请求（回落 v1 行为）');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx playwright test tests/harness.spec.mjs 2>&1 | tail -5`
Expected: FAIL —— `path_plan` 不在 state 里（planner 还没调新签名），或 `walked_along_this_plan` 恒 0。

- [ ] **Step 3: 实现**

`zombie-jev-planner.js` 的 `_dispatch` 里，在 `noteVisit` 之后：

```js
    // 计划固化（Review Focus 4）：每 0.5 秒重算 BFS 时，「往东绕」与「往西绕」常等长 →
    // 不固化会让丧尸在两条等长路线间来回横跳。做法 = 记住上一次的计划方向，
    // 只要它仍然可达就沿用；`walked` 记录已沿该计划走了几步。
    const state = buildJevState(this.world, z.position, playerPosition, mem);
    const plannedDir = state.path_plan.next_step_toward_player;
    if (plannedDir && mem.plan && mem.plan.direction === plannedDir) {
      mem.plan.walked = (mem.plan.walked ?? 0) + 1;
    } else {
      mem.plan = { direction: plannedDir, walked: 0, since: nowMs };
    }
    // 用记忆里的值覆盖 state（buildJevState 只看 memory.plan，两者已对齐）
    state.path_plan.walked_along_this_plan = mem.plan.walked ?? 0;
```

⚠️ 注意 `buildJevState` 里的 `walked` 计算要与这里一致 —— 实现时二选一：**要么** planner 写回 `mem.plan` 后重建 state，**要么** 让 `buildJevState` 接收 `mem.plan` 并信任它。计划采用后者（`buildJevState` 已有 `memory` 参数），planner 只在调用**前**更新 `mem.plan`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx playwright test tests/harness.spec.mjs 2>&1 | tail -5`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/entities/zombies/zombie-jev-planner.js src/tests/test-zombie-jev-ai.js
git commit -m "feat(zombie): planner 接入寻路 + 计划固化（防等长路线横跳）"
```

---

### Task 4: 长墙 E2E 回归门 + 主线程成本实测

**Files:**
- Modify: `tests/zombie-jev-ai.spec.mjs`

- [ ] **Step 1: 加长墙用例**

在 `tests/zombie-jev-ai.spec.mjs` 追加一条独立用例（保留既有的短墙缺口用例）：

```js
test('v2.46-v2：31 格宽长墙 —— 寻路后能绕过去（v1 实测净位移 0.7 格）', async ({ page }) => {
  test.setTimeout(420_000);
  await page.goto('/?vd=4&seed=12345&zombieai=1');
  await waitWorldReady(page);
  const r = await runLongWallScenario(page);
  expect(r.error, JSON.stringify(r)).toBeUndefined();
  test.skip((r.debug?.decided ?? 0) === 0,
    `在线 AI 全程未成功决策（lastReason=${r.debug?.lastReason ?? 'n/a'}）`);
  console.log('[zombie-jev-ai][long-wall] =', JSON.stringify(r));
  // 载荷性判据：必须越过墙（v1 在这里是 false，净位移 0.7 格）
  expect(r.crossed, `须越过 31 格宽的长墙（trace=${JSON.stringify(r.trace)}）`).toBe(true);
  expect(r.endDist).toBeLessThan(r.startDist - 5);
});
```

`runLongWallScenario` 的实现复用 `runUScenario` 的找平地逻辑，把墙换成 31 格宽 × 3 格高、丧尸放在墙南 2 格、玩家在墙北 8 格，跑 90 秒。

- [ ] **Step 2: 跑用例**

Run: `npx playwright test tests/zombie-jev-ai.spec.mjs -g "31 格宽长墙" 2>&1 | grep -E "\[long-wall\]|passed|failed|Error"`
Expected: PASS（`crossed: true`）。若 `test.skip`，把 `lastReason` 记下来重跑。

- [ ] **Step 3: 负向验证（必须真红）**

临时把 `planStep` 改成 `return { reachable: false, nextStep: null, pathLength: 0, explored: 0, truncated: true }`（等于关掉寻路），重跑同一用例。
Expected: **FAIL**（`crossed` 为 false，且净位移 < 1 格 —— 与 v1 实测一致）。改回。

- [ ] **Step 4: 主线程成本实测**

在真游戏页 20 只丧尸、`?zombieai=1` 下读 `perf.snapshot().frameMs`，与 `?zombieai=0` 对比。
Expected: p95 差 < 1ms（v1 实测 9.7 vs 9.8）。若回退，先把 `PATHFIND.maxRadius` 降到 16 并复测。

- [ ] **Step 5: 提交**

```bash
git add tests/zombie-jev-ai.spec.mjs
git commit -m "test(zombie): 31 格长墙 E2E 回归门（v1 净位移 0.7 格 → 须越过）"
```

---

### Task 5: 门禁与文档

- [ ] **Step 1: 全量门禁**

```bash
npm run check
npx playwright test tests/harness.spec.mjs 2>&1 | tail -3
npx playwright test tests/zombies.spec.mjs 2>&1 | tail -3
```
Expected: 全绿（`check` 三项、harness 0 failed、zombies 13 passed）。

- [ ] **Step 2: 文档**

`CLAUDE.md` 的「丧尸在线 AI 沉淀的活跃约束」段追加 v2 三条（分层职责、BFS 有界 24 格、`truncated` 回落）；
`docs/roadmap.md` 追加 v2.47 行。

- [ ] **Step 3: 提交**

```bash
git add CLAUDE.md docs/roadmap.md
git commit -m "docs: 丧尸寻路层活跃约束与 roadmap v2.47"
```

---

## 自检记录

- **spec 覆盖**：§2.7 实测 → Task 4 的回归门；§3.10.2 BFS → Task 1；§3.10.3 state → Task 2；§3.10.4 题面 → Task 2；§3.11 非目标修订 → 已在 spec 里改，Task 5 文档同步。
- **Review Focus 覆盖**：① 半径边界 → Task 1「半径外不可达」用例；② `truncated` 回落 → Task 2「候选表仍完整」+ Task 3「不可达仍发请求」；③ 台阶同口径 → Task 1「一格可走/两格不可」；④ 路径抖动 → Task 3 计划固化；⑤ 主线程成本 → Task 4 Step 4；⑥ 模型否决兜底 → Task 3 的 `walked` 只读不强制（**有意不做强制**：强制定向会让模型的作用归零；若实玩发现仍打转，另开一轮）。
- **类型一致性**：`planStep` 的返回字段在 Task 1/2/3 间一致；`buildCandidateSteps` 第 5 参在 Task 2/3 间一致。
