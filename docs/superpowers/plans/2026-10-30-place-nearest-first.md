# 放置就近优先 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **后续追加变更（2026-10-30，用户）**：命中 < 15 格直接放命中面前（对齐 mc-lite），头格 / 身体守卫保持本仓现状 —— 见设计说明 §10。本计划是追加**之前**的执行记录，其中「命中与打空共用就近优先」等表述以设计说明 §10 为准。

**Goal:** 单格方块右键放置时，落点 = 沿准心视线从近到远第一个可放的候选（命中面前的 A 排最后），相机所在格（头格）永不作候选。

**Architecture:** `place-ray.js` 新增「边扫边试」的 `scanPlaceCells`（候选判据的唯一实现，遍历复用 `raycastVoxel` 的 `onCell`），`findPlaceCell` 退化为取第一个候选的薄包装；`player.js` 新增 `_placeNearest`，命中与打空共用一条流程，写入与身体守卫仍只在 `_placeSingle()`。

**Tech Stack:** 纯 JavaScript（ES2022 模块 + JSDoc）；浏览器内单测（`src/tests/`）；Playwright E2E（`tests/`，端口 8081）。

**Spec:** `docs/superpowers/specs/2026-10-30-place-nearest-first-design.md`

## Global Constraints

- 纯 JS + JSDoc，禁 TypeScript；代码注释用中文；`place-ray.js` 保持无 three / 无 DOM。
- 红线 1：候选判据只写在 `scanPlaceCells`；身体守卫与写入只在 `_placeSingle()`。红线 6：遍历复用 `raycastVoxel` 的 `onCell`，不写第二份 DDA，不用 0.1 步长，不用 `THREE.Raycaster`。
- 不动：`PLACE_RAY_MAX_DIST = 15`、判据②③④与「遇实心即截止」、特殊物品（巢穴/炮塔/矿车）路径、v2.22 身体守卫口径（只拒实心方块）、A 路径行为。
- Tier 1：先写测试并确认红，再实现；断言一律取实测值（`testing-policy` §2.6 第 ⑤ 条）。改完 `src/**/*.js` 跑 `npm run lint`。
- **不自动提交**：每个任务末尾是「检查点」而非提交。
- 工作区里有用户未提交的改动（`apply.js`、`src/tests/index.html`、`test-shallow-tarn-gen.js`、`tests/shallow-water-tarns.spec.mjs`、`tools/check-data.mjs`，以及 `CLAUDE.md` / `docs/roadmap.md` 里的 v2.24 段）：不碰、不回退、不 stash；`CLAUDE.md` / `roadmap.md` 只改本次相关段落。
- 负向验证撤销注入只用 `cp` 备份还原，**禁止** `git checkout` / `git restore` / `git stash`（本任务与用户的未提交改动同在一个工作区）。
- 回归失败先单独复跑一次；仍红就停下来报告，**不改断言、不放宽阈值**。

## Review Focus

规格隐含、但最容易咬人的输入（每条的测试已加进对应任务）：

1. 相机恰在格边界（x 为整数）时，头格之后的下一格 `t === 0`，期望仍作候选 —— Task 1「相机恰在格边界」。
2. 手持非实心方块（花草）时的头格：期望打空零写入、命中落在 A，绝不进头格 —— Task 2「头格出局」×2。
3. 站位离格边界 <0.3，头格之后的第二格压到身体：期望跳过它继续找 —— Task 2「跳过被身体压住」。
4. 命中格本身是非实心（花草）且其后还有候选：期望不越过命中格 —— Task 1「stopAt」+ Task 2「候选止于命中格」。
5. 命中面前一格正好是头格（贴墙站着）：期望 A 路径不变，非实心可放、实心被拒 —— Task 2「A 路径不动」。

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/player/place-ray.js`（改） | 候选判据与扫描的唯一实现：`scanPlaceCells`；`findPlaceCell` 薄包装 |
| `src/player/player.js`（改） | `_placeNearest` + `placeBlock()` / `_placeByRayFallback()` 两处调用 + 注释 |
| `src/tests/test-place-ray.js`（改） | 纯函数单测 |
| `src/tests/test-player-place.js`（改） | 走真实 `placeBlock()` 全路径的单测（真实 DDA target） |
| `tests/place-fallback.spec.mjs`（改） | 真实页面 E2E（`setTestAim → update → placeBlock`） |
| `tests/tmp-unit-filter.spec.mjs`（新，诊断用） | 只打印名字匹配 `UNIT_FILTER` 的浏览器单测结果；`tests/tmp-*` 已被 `.gitignore` 忽略 |
| `CLAUDE.md`、`docs/roadmap.md`（改） | 文档同步（Task 4） |

---

### Task 1: `scanPlaceCells` 纯函数 + `findPlaceCell` 薄包装

**Files:**
- Modify: `src/player/place-ray.js`
- Test: `src/tests/test-place-ray.js`
- Create: `tests/tmp-unit-filter.spec.mjs`

**Interfaces:**
- Produces: `scanPlaceCells(world, origin, dir, visit, opts)`，Task 2 消费：
  - `world: WorldData`；`origin: number[3]`；`dir: number[3]`（无需归一化）
  - `visit: (x: number, y: number, z: number, neighbor: number[3]) => boolean` —— 每个候选按 DDA 顺序（近→远）调一次；返回 `true` = 已放置，立即中止遍历
  - `opts?: { maxDist?: number /* 缺省 PLACE_RAY_MAX_DIST */, stopAt?: number[3] | null /* 走到该格即截止，不含 */ }`
  - 返回 `{ hit: boolean, placeCell?: number[3], neighbor?: number[3] }`（`hit` = 某次 `visit` 返回了 true）
- 保持：`findPlaceCell(world, origin, dir, maxDist = PLACE_RAY_MAX_DIST)` 签名与返回形状不变，实现改为 `scanPlaceCells(..., () => true, { maxDist })`。

- [ ] **Step 1: 建诊断 spec（只打印匹配的浏览器单测，省得读整页结果）**

`tests/tmp-unit-filter.spec.mjs`：

```js
// 诊断用（.gitignore 已忽略 tests/tmp-*）：打印名字匹配 UNIT_FILTER（正则）的浏览器单测结果
import { test } from 'playwright/test';

test('打印匹配的浏览器单测', async ({ page }) => {
  const re = process.env.UNIT_FILTER ?? '.';
  await page.goto('/src/tests/index.html');
  await page.waitForFunction(() => window.__MC_TEST_RESULTS__ !== undefined, null, { timeout: 110_000 });
  const rows = await page.evaluate((src) => window.__MC_TEST_RESULTS__.suites.flatMap((s) => s.tests)
    .filter((t) => new RegExp(src).test(t.name))
    .map((t) => `${t.status === 'passed' ? 'PASS' : 'FAIL'}  ${t.name}${t.error ? `\n      ↳ ${t.error}` : ''}`), re);
  console.log(`\n匹配 /${re}/ 共 ${rows.length} 条\n${rows.join('\n')}`);
});
```

- [ ] **Step 2: 写失败的单测（追加到 `src/tests/test-place-ray.js`）**

import 行改为 `import { assertEqual, assertTrue, assertFalse } from './assert.js';` 与 `import { PLACE_RAY_MAX_DIST, findPlaceCell, scanPlaceCells } from '../player/place-ray.js';`。追加（期望值全部来自原型实测）：

```js
// ---- scanPlaceCells（v2.25 就近优先）----
const EYE = [3.5, 2.62, 8.5];            // 头格 = (3,2,8)，视线朝 +X
const J = JSON.stringify;
const row = (x0, x1) => Array.from({ length: x1 - x0 + 1 }, (_, i) => [x0 + i, 2, 8]);
/** y=3 的一排顶（x∈[x0,x1], z=8）：视线在 y=2 行 → 沿途每格「头顶」都是实心邻居 */
function ceilingRow(world, reg, x0 = 1, x1 = 13) { for (let x = x0; x <= x1; x++) put(world, reg, x, 3, 8); }
/** 收集 visit 到的候选；stopOn 决定哪个候选「放成功」（缺省全部放不下 → 一路扫到头） */
function scan(world, eye, dir, opts = {}, stopOn = () => false) {
  const seen = [];
  const r = scanPlaceCells(world, eye, dir, (x, y, z) => { seen.push([x, y, z]); return stopOn(x, y, z); }, opts);
  return { r, seen };
}

test('scanPlaceCells: 头格（起点格）不进候选 —— 背靠墙时没有任何候选', () => {
  const { world, reg } = makeWorld();
  put(world, reg, 2, 2, 8);                       // 墙在头格 (3,2,8) 的 -X 侧；旧实现会把头格当候选
  const { r, seen } = scan(world, EYE, [1, 0, 0]);
  assertEqual(J(seen), '[]', '唯一满足②③④的是头格 → 出局后无候选');
  assertFalse(r.hit);
});

test('scanPlaceCells: 头顶有天花板 → 候选从头格的下一格起，按近→远', () => {
  const { world, reg } = makeWorld();
  ceilingRow(world, reg);
  assertEqual(J(scan(world, EYE, [1, 0, 0]).seen), J(row(4, 13)));
});

test('scanPlaceCells: visit 返回 true → 立刻中止并返回该格；返回 false → 继续下一个', () => {
  const { world, reg } = makeWorld();
  ceilingRow(world, reg);
  const { r, seen } = scan(world, EYE, [1, 0, 0], {}, (x) => x === 6);
  assertEqual(J(seen), J(row(4, 6)), '访问到 6 为止，之后不再访问');
  assertTrue(r.hit);
  assertEqual(r.placeCell.join(','), '6,2,8');
  assertEqual(r.neighbor.join(','), '6,3,8');
});

test('scanPlaceCells: stopAt（命中格）严格不含 —— 命中格是花草时也在它之前截止', () => {
  const { world, reg } = makeWorld();
  ceilingRow(world, reg);
  put(world, reg, 8, 2, 8, 'short_grass');        // 非实心：主射线会命中它，扫描却不会被它遮挡
  assertEqual(J(scan(world, EYE, [1, 0, 0], { stopAt: [8, 2, 8] }).seen), J(row(4, 7)));
  // 对照：不给 stopAt 则穿过花草一路扫到 13（证明上一条断言有判别力）
  assertEqual(J(scan(world, EYE, [1, 0, 0]).seen), J(row(4, 13)));
});

test('scanPlaceCells: maxDist 之外的候选不访问', () => {
  const { world, reg } = makeWorld();
  ceilingRow(world, reg);
  assertEqual(J(scan(world, EYE, [1, 0, 0], { maxDist: 3 }).seen), J(row(4, 6)));
});

test('scanPlaceCells: 相机恰在格边界 —— 头格之后 t=0 的那一格仍是候选（不能用 t===0 识别起点）', () => {
  const { world, reg } = makeWorld();
  ceilingRow(world, reg);
  // x=4.0 朝 -X：头格 = 4；DDA 第一步进入格 3 时 t 恰为 0
  assertEqual(J(scan(world, [4.0, 2.62, 8.5], [-1, 0, 0]).seen), J([[3, 2, 8], [2, 2, 8], [1, 2, 8]]));
});

test('scanPlaceCells: 遮挡 / 前方实心判据保持（x=10 是实心墙 → 候选止于 8）', () => {
  const { world, reg } = makeWorld();
  ceilingRow(world, reg);
  put(world, reg, 10, 2, 8);
  assertEqual(J(scan(world, EYE, [1, 0, 0]).seen), J(row(4, 8)), '9 的 +X 邻居是墙（视线前方）→ 否决；10 实心 → 中止');
});

test('findPlaceCell: 薄包装 = 第一个候选，头格同样出局', () => {
  const { world, reg } = makeWorld();
  ceilingRow(world, reg);
  const r = findPlaceCell(world, EYE, [1, 0, 0]);
  assertTrue(r.hit);
  assertEqual(r.placeCell.join(','), '4,2,8', '头格 (3,2,8) 出局');
  assertEqual(r.neighbor.join(','), '4,3,8');
});
```

- [ ] **Step 3: 加导出桩，让模块能链接**

`place-ray.js` 里临时加 `export function scanPlaceCells() { return { hit: false }; }`。没有它，缺失的具名导出会让整页单测模块链接失败，表现是整页无结果、只超时，看不到逐条红。

- [ ] **Step 4: 运行确认红**

Run: `UNIT_FILTER='scanPlaceCells|findPlaceCell|place-ray:' npx playwright test tests/tmp-unit-filter.spec.mjs`
Expected: 新增 8 条里 7 条 `FAIL`（桩从不调 `visit`，`seen` 恒为空；`薄包装` 则因旧实现仍把头格当候选）；唯独 `头格出局 —— 背靠墙` 在桩下空洞通过（它期望的就是「无候选」，判别力由 Task 3 负向验证 #1 证明）；既有 `place-ray:` 全部 `PASS`。

- [ ] **Step 5: 实现 `scanPlaceCells`，`findPlaceCell` 改为薄包装，并重写文件头注释**

`onCell` 内的检查顺序是载荷性的：① 命中 `stopAt` 格 → 中止（不评估）；② 该格实心 → 中止（遮挡；起点格也适用）；③ 起点格 → 不作候选；④ 判据②③④（沿用现有邻居逻辑，`neighbor` 取第一个实心邻居）；⑤ 调 `visit`，返回 true 则记录结果并中止。起点格用「第一次进入回调」的标志位识别，不用 `t === 0`。遍历仍是 `raycastVoxel(world, origin, nd, maxDist, () => false, onCell)`。文件头注释按 v2.25 重写：落点语义改为「命中与打空共用，沿视线近→远，头格出局，止于命中格」，并删去「调用时机是 `player.target === null`」那段过时说明。

- [ ] **Step 6: 运行确认绿，再跑 lint**

Run: `UNIT_FILTER='scanPlaceCells|findPlaceCell|place-ray:' npx playwright test tests/tmp-unit-filter.spec.mjs`
Expected: 所有匹配行 `PASS`（既有 + 新增 8 条），无 `FAIL`。
Run: `npm run lint`
Expected: 退出码 0。

- [ ] **Step 7: 检查点（不提交）**

Run: `git status --short`
Expected: 本任务只新增 `M src/player/place-ray.js`、`M src/tests/test-place-ray.js`（诊断 spec 被忽略）。待用户同意提交时的建议信息：`feat(player): place-ray 新增 scanPlaceCells（近→远逐候选、头格出局、止于命中格）`。

---

### Task 2: `Player._placeNearest` + 玩家层单测

**Files:**
- Modify: `src/player/player.js`（import；`placeBlock()`；`_placeByRayFallback()`；新增 `_placeNearest()`；相关注释）
- Test: `src/tests/test-player-place.js`

**Interfaces:**
- Consumes: Task 1 的 `scanPlaceCells`
- Produces: `Player._placeNearest(id: number, hit: object | null): boolean` —— `hit` = `this.target`（打空传 `null`）；返回是否真的放下一块。

- [ ] **Step 1: 写失败的单测（追加到 `src/tests/test-player-place.js`，并更新文件头注释提到 v2.25）**

顶部加 `import { raycastVoxel } from '../player/raycast.js';`。追加 helper 与 10 条用例（期望值全部来自原型实测）。⚠️ 一条用例里要换手持物品重放时，**每次都新建 fixture**：第一次放置会改世界，同一世界里第二次的主射线会命中刚放的方块（实测 A 从 `13,2,8` 变成 `12,2,8`）。

```js
// ---- ③ 就近优先（v2.25）：走真实 placeBlock()，target 用真实 DDA 算（与 update() 同款）----
const FEET = [3.5, 1, 8.5];              // 眼睛 y=2.62 → 头格 (3,2,8)，视线朝 +X
const J = JSON.stringify;
const row = (x0, x1, y, z) => Array.from({ length: x1 - x0 + 1 }, (_, i) => [x0 + i, y, z]);
function setBlocks(world, registry, cells, name = 'stone') {
  for (const [x, y, z] of cells) world.setBlock(x, y, z, registry.idOf(name), 0);
}
/** 摆姿态（相机在眼睛处、getWorldDirection 回写 dir）、算真实 target、走 placeBlock() */
function aimAndPlace(player, editor, feet, dir) {
  player.physics.pos = { x: feet[0], y: feet[1], z: feet[2] };
  const eye = [feet[0], feet[1] + 1.62, feet[2]];
  const len = Math.hypot(...dir);
  const d = dir.map((v) => v / len);
  player.camera.position = { x: eye[0], y: eye[1], z: eye[2] };
  player.camera.getWorldDirection = (t) => { t.x = d[0]; t.y = d[1]; t.z = d[2]; return t; };
  const r = raycastVoxel(player.world, eye, d, 40);
  player.target = r.hit ? r : null;
  const before = editor.calls.length;
  player.placeBlock();
  return { placed: editor.calls.slice(before).map((c) => [c.x, c.y, c.z]), target: player.target };
}
```

| 用例名 | 场景（stone，除非注明） | 断言 |
|---|---|---|
| `就近优先：命中远处方块，但视线擦过更近的可贴格 → 放在近处` | `[6,2,7]`（侧墙）+ `[14,2,8]` | `target.prevPos` = `13,2,8`（前提）；`placed` = `[[6,2,8]]`；`getBlockId(13,2,8)` = 0 |
| `就近优先：没有更近的候选时仍放在命中面前` | `[14,2,8]` | `placed` = `[[13,2,8]]` |
| `头格出局：背靠墙面朝外、远处命中 —— 花草与石头都落在命中面前` | `[2,2,8]`（头格 -X 侧的墙）+ `[14,2,8]`，分别手持 `short_grass`、`stone` | 两次 `placed` 均 `[[13,2,8]]`；头格 `(3,2,8)` 仍是 0 |
| `头格出局：打空且头格是唯一候选 → 零写入（实心 / 非实心一样）` | `[2,2,8]`，手持 `stone`、`short_grass` 各一次 | `target` 为 null；`placed` 均 `[]` |
| `跳过被身体压住的候选：站位离格边界 <0.3 → 继续放下一个` | `row(1,13,3,8)`（天花板）+ `[14,2,8]`；脚底 `[3.9,1,8.5]` | `placed` = `[[5,2,8]]`（`(4,2,8)` 压到身体被守卫拒绝） |
| `A 路径不动：命中面前一格就是头格 —— 非实心可放、实心被拒` | `[4,2,8]`；手持 `short_grass` 一次、`stone` 一次 | 花草 `placed` = `[[3,2,8]]`；石头 `placed` = `[]`；`target.prevPos` = `3,2,8` |
| `A 路径不动：命中在 15 格之外且无候选 → 仍放在命中面前（15 格只约束 B）` | `[8,30,8]`；脚底 `[8.5,1,8.5]`，视线朝 `[0,1,0]` | `target.prevPos` = `8,29,8`（前提，命中距离≈27.4）；`placed` = `[[8,29,8]]` |
| `打空路径同一流程：越过头格取下一个候选` | `row(1,13,3,8)`，视线朝 +X 无命中 | `target` 为 null；`placed` = `[[4,2,8]]` |
| `候选止于命中格：命中格是花草时，不越过它放后面的候选` | `row(9,13,3,8)` + `(8,2,8)` 摆 `short_grass`；手持 `stone` | `target.blockPos` = `8,2,8`（前提）；`placed` = `[[7,2,8]]` |
| `特殊物品（巢穴）命中时不走就近放置` | `[6,2,7]` + `[14,2,8]`；手持 `zombie_nest_alias_block`（`selectItem` 返回 ≥ 0） | `placed` = `[]`，无异常 |

每条用例开头 `const { player, editor, world, registry } = makeFixture(); selectItem(player, item);`，结尾 `player.dispose();`，沿用本文件既有写法。

- [ ] **Step 2: 运行确认红**

Run: `UNIT_FILTER='就近优先|头格出局|跳过被身体|A 路径不动|打空路径同一流程|候选止于命中格|特殊物品（巢穴）|放置守卫|overlapsBlock' npx playwright test tests/tmp-unit-filter.spec.mjs`
Expected:
- `FAIL`（改前行为不同）：`就近优先：命中远处方块…`、`头格出局：打空…`、`跳过被身体压住…`、`打空路径同一流程…`；
- `PASS`（回归钉，改前改后都成立）：`没有更近的候选…`、`头格出局：背靠墙…远处命中`、两条 `A 路径不动…`、`候选止于命中格…`、`特殊物品（巢穴）…`，以及全部既有 `放置守卫` / `overlapsBlock` 用例。

- [ ] **Step 3: 实现**

- `player.js` 顶部 import 由 `findPlaceCell` 改为 `scanPlaceCells`。
- 新增 `_placeNearest(id, hit)`：`scanPlaceCells(this.world, 相机位置, 视线方向（沿用现有 `getWorldDirection(_forward)`）, (x, y, z) => this._placeSingle(x, y, z, id), { stopAt: hit ? hit.blockPos : null })`；`hit` 字段为真则返回 true；否则有 `hit` 时返回 `this._placeSingle(...hit.prevPos, id)`，无 `hit` 返回 false。
- `placeBlock()`：删掉末尾已不再使用的 `const [x, y, z] = this.target.prevPos;`，把最后一行 `this._placeSingle(x, y, z, id)` 改为 `this._placeNearest(id, this.target)`；特殊物品两个分支、空槽 / 未知 id 守卫、`if (!this.target) { this._placeByRayFallback(); return; }` 原样不动。
- `_placeByRayFallback()`：保留开头的三道守卫（选中态 / 空槽 / 特殊物品 / 未知 id），末尾改为 `return this._placeNearest(id, null);`。
- 注释：重写 `placeBlock()` 顶部的「裁决（v1.70）：兜底只在完全未命中时生效」整段，以及 `_placeByRayFallback()` 的说明，改为 v2.25 语义（命中与打空共用 `_placeNearest`；A 被身体守卫拒绝时不再找别处，因为 A 已是最后一个候选）。

- [ ] **Step 4: 运行确认绿，再跑 lint**

Run: 同 Step 2 的命令。
Expected: 所有匹配行 `PASS`，无 `FAIL`。
Run: `npm run lint`
Expected: 退出码 0。

- [ ] **Step 5: 检查点（不提交）**

Run: `git status --short`
Expected: 新增 `M src/player/player.js`、`M src/tests/test-player-place.js`。建议提交信息：`feat(player): 放置就近优先——命中与打空共用 _placeNearest，头格出局（v2.25）`。

---

### Task 3: E2E、负向验证与回归

**Files:**
- Modify: `tests/place-fallback.spec.mjs`

**Interfaces:**
- Consumes: Task 2 的 `Player.placeBlock()` 行为。

- [ ] **Step 1: 写 E2E**

在 `tests/place-fallback.spec.mjs` 追加 helper 与两条用例（沿用文件内现有 `boot` / `selectItem`，用 `setTestAim → rAF → placeBlock`，不手塞 target）：

```js
/** 搭「视线走廊」：高空清出 x∈[px-2,px+14] × z∈[pz-2,pz+2] × y∈[topY-3,topY+4]，玩家站 1×1 石柱（脚底 y=topY），
 *  再按 extra（相对 [px, topY, pz] 的偏移）摆石块。头格 = (px, topY+1, pz)。 */
async function buildRayCorridor(page, extra, topY = 60) {
  return page.evaluate(async ({ topY, extra }) => {
    const g = window.__MC_GAME__, pl = g.player, stone = g.registry.idOf('stone');
    const px = Math.floor(pl.physics.pos.x), pz = Math.floor(pl.physics.pos.z);
    for (let dx = -2; dx <= 14; dx++) for (let dz = -2; dz <= 2; dz++)
      for (let y = topY - 3; y <= topY + 4; y++) g.editor.setBlock({ x: px + dx, y, z: pz + dz, id: 0 });
    g.editor.setBlock({ x: px, y: topY - 1, z: pz, id: stone });
    for (const [dx, dy, dz] of extra) g.editor.setBlock({ x: px + dx, y: topY + dy, z: pz + dz, id: stone });
    pl.physics.pos.x = px + 0.5; pl.physics.pos.y = topY; pl.physics.pos.z = pz + 0.5;
    pl.physics.vel.x = 0; pl.physics.vel.y = 0; pl.physics.vel.z = 0;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { px, pz, headY: topY + 1 };
  }, { topY, extra });
}
```

- `就近优先：命中远处方块，但视线擦过更近的可贴格 → 放在近处（真实页面）`：`extra = [[3,1,-1],[12,1,0]]`，手持 `stone`，`setTestAim([1,0,0])`，等一帧。断言：`pl.target.blockPos` = `[px+12, headY, pz]`（前提）；放前 `(px+3,headY,pz)` 与 `(px+11,headY,pz)` 均为 0；放后前者 = stone id、后者 = 0。
- `头格出局：背靠墙面朝外瞄远处，手持花草落在命中面前、不进头格（真实页面）`：`extra = [[-1,1,0],[12,1,0]]`，手持 `short_grass`（`selectItem` 返回 ≥ 0），同样朝 +X。断言：`target.blockPos` = `[px+12, headY, pz]`；放后头格 `(px,headY,pz)` = 0，`(px+11,headY,pz)` = `short_grass` 的 id。
- 既有第 2 条用例：标题改为 `命中但没有更近候选时仍走 A（俯视脚下：A 被身体守卫拒绝 → 世界零变化，不回落到别处）`，注释里「兜底不越过主射线命中」一类已过时的表述按 v2.25 语义重写；断言与场景一字不动。

- [ ] **Step 2: 运行**

Run: `npx playwright test tests/place-fallback.spec.mjs`
Expected: `5 passed`。

- [ ] **Step 3: 负向验证（四处注入，逐一转红再还原）**

流程（每处相同）：`cp <文件> $SCRATCH/<文件名>.bak`（`$SCRATCH` = 本会话 scratchpad 目录）→ 用 Edit 注入 → `grep` 确认改到的是预期位置（`place-ray.js` / `player.js` 里同形代码有多处）→ 跑下表「必须转红」→ `cp` 备份还原 → `diff -q` 确认还原无差 → 重跑确认转绿。

| # | 文件 | 注入 | 至少转红 |
|---|---|---|---|
| 1 | `place-ray.js` | 删掉「起点格不作候选」那一行（Task 1 Step 5 的第③项；头格重新可作候选） | 单测 `头格（起点格）不进候选`、`头顶有天花板`、`相机恰在格边界`、`findPlaceCell: 薄包装`；玩家单测 `头格出局：打空…`、`头格出局：背靠墙…`；E2E `头格出局`（`-g "头格出局"`） |
| 2 | `place-ray.js` | 删掉「走到 `stopAt` 格即中止」的判断（Task 1 Step 5 的第①项） | 单测 `stopAt（命中格）严格不含`；玩家单测 `候选止于命中格` |
| 3 | `player.js` | `placeBlock()` 末尾改回只放 `this.target.prevPos`（命中即放 A） | 玩家单测 `就近优先：命中远处方块…`、`跳过被身体压住…`；E2E `就近优先`（`-g "就近优先"`） |
| 4 | `player.js` | `_placeNearest` 的回调改成 `(x, y, z) => { this._placeSingle(x, y, z, id); return true; }`（只试第一个候选） | 玩家单测 `跳过被身体压住的候选` |

- [ ] **Step 4: 回归**

Run: `npm run check` → Expected: 退出码 0。
Run: `npx playwright test tests/harness.spec.mjs` → Expected: `1 passed`（整页约 64s）。
Run（逐个，串行；它们都走被改的 `placeBlock()` 路径）：

```bash
for s in m3-1-inventory m3-2-orientation minecarts tnt turrets view-bob zombie-nests; do
  npx playwright test tests/$s.spec.mjs || echo "FAILED: $s"
done
```

Expected: 无 `FAILED:` 输出。任何一条红：单独复跑；仍红则停下来报告读数，**不改断言**。

- [ ] **Step 5: 检查点（不提交）**

Run: `git status --short`
Expected: 新增 `M tests/place-fallback.spec.mjs`；`place-ray.js` / `player.js` 已还原到 Task 1~2 的实现（`diff` 已确认）。建议提交信息：`test(player): 放置就近优先 E2E（真实 DDA + 头格出局）`。

---

### Task 4: 文档同步

**Files:**
- Modify: `CLAUDE.md`、`docs/roadmap.md`

- [ ] **Step 1: 改 `CLAUDE.md`（只动下列段落，用 Edit 按段首文字定位，别按行号）**

- 「当前进度」：在 `**v2.24**` 段之后新增 `**v2.25**` 段：用户原话要点（沿视线总是先就近放置；头格任何时候都不放）、一句话机制（命中与打空共用 `_placeNearest`，候选近→远逐个交给 `_placeSingle`，A 排最后）、实测（背靠墙 / 低天花板时最近候选就是头格；离格边界 <0.3 时第二格压身体约占每个方向 30%；扫描 ≤5 µs，仅右键触发），以及已知行为变化（低天花板通道里沿通道瞄远处，方块放在面前一格、贴着天花板，这是「就近优先」的字面结果）。
- 「活跃约束」里改写三条：`**\`placeBlock()\` 有两条路，不是一条**` 改为「单格放置只有一个入口 `_placeNearest()`」；`**兜底只在完全未命中时生效（用户裁定）**` 改为已被 v2.25 取代，写清新规则（头格出局、被拒候选跳过、止于命中格、A 路径不动、A 被拒不找别处）；`**四个判据缺一不可**` 补第五条「头格不作候选」与「止于命中格」。其余相关条目（特殊物品不兜底、单格写入只有一处、自身 AABB 守卫、DDA 复用 `onCell`、E2E 不得手工塞 target）语义不变，不动。

- [ ] **Step 2: 改 `docs/roadmap.md`**

在 v2.24 行之后加 v2.25 行（列格式同相邻行：版本 / 标题 / 状态 / 说明）；v1.72 行里 `设计两条用户裁定**：① 兜底**只在完全未命中时**生效…` 之后追加「（⚠️ v2.25 已取代：命中时也走就近优先）」。

- [ ] **Step 3: 验证**

Run: `npm run check` → Expected: 退出码 0。
Run: `git diff --stat -- CLAUDE.md docs/roadmap.md` → Expected: 两个文件各自只多出本次相关的增删，v2.24 段落内容不变。

- [ ] **Step 4: 检查点（不提交）并清理诊断 spec**

Run: `mv tests/tmp-unit-filter.spec.mjs "$SCRATCH/"`（诊断 spec 移到 scratchpad，不用通配符删除）。
最终向用户汇报：实际改动文件清单、各验证命令的实测输出、负向验证四处的转红 / 还原结果；提醒 `CLAUDE.md` 与 `roadmap.md` 里本次改动与用户的 v2.24 未提交改动混在同一文件，提交时需分开暂存。建议提交信息：`docs: v2.25 放置就近优先（CLAUDE.md 活跃约束 + roadmap）`。
