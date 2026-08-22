# M4 玩家武器系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变第一阶段 M2/M3 验收边界的前提下，交付三把由受控 GLB 资源驱动、使用 DDA hitscan 的第一人称玩家武器，并为 TNT 等未来批量编辑提供唯一的世界写入入口。

**Architecture:** M4-0 先让 `WorldEditor` 协调 `WorldData` 的唯一 typed-array 真相、持久化 edits、光照和 REMESH；随后纯 JS 的武器状态机通过注入的 `BlockQuery`/`WorldEditor` 产生效果事件。GLB、Audio、相机视图模型和曳光都只运行在主线程渲染层，绝不进入 Worker 或体素 meshing 管线。

**Tech Stack:** ES2022 ESM、JSDoc、three.js r185.1 WebGPU、GLTFLoader（r185.1 本地 vendoring）、Web Audio、Playwright 1.62.1、仓库浏览器单测 runner。

**Spec:** `docs/superpowers/specs/2026-08-23-m4-player-weapons-design.md`

## Global Constraints

- M4 是第二阶段首个 Epic；不得改变第一阶段 M2/M3 的编号、范围、性能阈值或验收报告口径。
- 纯 JavaScript + JSDoc，禁止 TypeScript、编译器、bundler 和 CDN；three 固定本地 r185.1。
- `blocks + meta + blockEntities` 是世界唯一权威；`WorldEditor`、事件、光照、网格、模型缓存、曳光池均不得持有第二份体素真相。
- 所有地形命中必须用 `raycastVoxel()`；禁止 `THREE.Raycaster.intersectObjects()` 求地形或创建兼容路径。
- `WorldData.setBlock`/`setBlocks` 是唯一数据写入层；所有玩家写入经 `WorldEditor` 触发 remesh/light/event，武器不得直接写 typed array 或调用 `RenderWorld`。
- 批量编辑每个 column 只递增一次版本、每个有效格仍写入 `edits`；批量路径只走 Worker REMESH，不走同步快速网格。
- Worker、`src/voxel/`、`src/gen/`、`src/mesh/` 不得 import three；GLB/Audio/视图模型只在主线程加载。
- 只加载仓库受控的三件 glTF 2.0 `.glb`，禁止用户文件、OBJ/MTL、外链 buffer/image、Draco、KTX2、动画和皮肤。
- M4 不实现炮塔、飞行弹丸、丧尸、弹药/背包消耗、第三人称或网络同步；将来实体射线只能接入 `WeaponController` 的距离比较接口。
- 所有新增测试先 RED、确认失败后才 GREEN；每个源码任务结束运行其定向测试和 `npm run lint`，Task 7 的里程碑门禁再运行全量 `npm test`。
- 每个任务的提交信息已列出，但仓库规则要求**先取得用户明确提交指令**；未获指令时保留工作区，不执行 `git commit`。

---

## 文件责任图

```text
docs/phase-1-engine-design.md                         §9 的 M4 接入点说明
docs/superpowers/plans/2026-08-20-...roadmap.md       第一阶段后续 Epic 的链接
src/voxel/world-data.js                               单块/批量 typed-array 写入和编辑报告
src/core/world-editor.js                              remesh/light/event 的唯一主线程协调器
src/core/scheduler.js                                 队列收敛的只读诊断计数
src/player/weapons/weapon-catalog.js                 三把枪的无 three 参数与模型资源清单
src/player/weapons/weapon-target-policy.js           武器专属的可破坏判定
src/player/weapons/mag7-pattern.js                    无 three 的确定性 3×3 扫描
src/player/weapons/weapon-controller.js              输入状态、冷却、DDA 效果事件与世界编辑调用
src/render/weapon-model-loader.js                    GLB 模板缓存、归一化、clone/dispose
src/render/audio-manager.js                           用户手势解锁、预加载、播放请求计数
src/render/view-weapon.js                            相机子节点、举枪/后坐/加特林 YXZ 旋转
src/render/tracer-renderer.js                         一个 InstancedMesh、上限 32 的派生曳光池
src/render/render-world.js                            已发布 section 版本的只读诊断，不保存体素数据
src/player/player.js                                 输入分流、aim 快照、WeaponController 编排
src/core/game.js                                     装配 WorldEditor/渲染资源及公开测试 API
tools/validate-weapon-assets.mjs                     GLB 静态安全与大小验证
assets/models/weapons/*.glb                           受控的三把武器模型
assets/sounds/*.mp3                                  受控的四个武器音效
vendor/three/addons/{loaders,utils}/*                GLTFLoader 的 r185.1 依赖闭包
tests/weapons-world-edit.spec.mjs                     200 次普通枪 / 20 次 MAG7 的真实世界编辑压力
docs/m4-weapons-acceptance-report.md                 M4 实测基线、回归结论与环境记录
```

### Task 1: 固化 M4 的权威路线图入口（内容已同步，待提交授权）

**Files:**
- Modify: `docs/phase-1-engine-design.md:693-695,923-937`
- Modify: `docs/superpowers/plans/2026-08-20-phase1-remaining-roadmap.md:368-381`
- Modify: `README.md:1-74`
- Modify: `AGENTS.md:14-48`
- Create: `docs/superpowers/plans/2026-08-23-m4-player-weapons.md`（本文件）

**Interfaces:**
- Consumes: 已确认的 `docs/superpowers/specs/2026-08-23-m4-player-weapons-design.md`。
- Produces: 设计文档 §4.5.3/§9 与第一阶段 roadmap 都能定位到 M4 规格和本实施计划；代码任务可在不改设计的前提下开始。

- [x] **Step 1: 写入设计文档的失败检索条件**

在写入前执行以下检索，确认权威文档尚未包含 `M4 玩家武器`；2026-08-23 已完成该基线检查与后续写入。

```bash
rg -n "M4 玩家武器|WorldEditor|玩家 hitscan 武器" \
  docs/phase-1-engine-design.md \
  docs/superpowers/plans/2026-08-20-phase1-remaining-roadmap.md
```

记录：写入后的检索应在设计文档与 roadmap 均命中，见 Step 3。

- [x] **Step 2: 更新 §4.5.3 和 §9，保持 M2/M3 不变**

在 `docs/phase-1-engine-design.md` 的批量编辑段落补充以下不变式：`WorldEditor.setBlocks()` 在每 column 一次版本递增的同时逐格写 `edits`，对变更 column/边界邻居 enqueue light，并只下发 Worker REMESH。将 §9 的“炮塔/子弹/丧尸”行拆成两行：M4 的玩家 hitscan 先行，EntityManager/炮塔 Projectile 后置。

在 roadmap 的“后续阶段预留”表加入一行，内容为：

```markdown
| M4 玩家武器 | `WorldEditor` + DDA hitscan + 相机视图模型 | 规格：`docs/superpowers/specs/2026-08-23-m4-player-weapons-design.md`；计划：`docs/superpowers/plans/2026-08-23-m4-player-weapons.md` |
```

不要插入或重命名 M3 task；M4 只能位于“后续阶段预留”。规格文件当前状态已是 `**状态：** 已确认，待实施`，本任务只核对该状态而不覆盖已确认的内容。

- [x] **Step 3: 验证权威入口已经闭合**

Run:

```bash
rg -n "M4 玩家武器|WorldEditor|玩家 hitscan 武器" \
  docs/phase-1-engine-design.md \
  docs/superpowers/plans/2026-08-20-phase1-remaining-roadmap.md \
  docs/superpowers/specs/2026-08-23-m4-player-weapons-design.md
git diff --check
```

已验证：设计文档、第一阶段 roadmap 与 M4 规格均出现可追溯的 M4 入口；`git diff --check` 无输出。

- [ ] **Step 4: 在获明确授权后提交文档任务**

```bash
git add docs/phase-1-engine-design.md \
  docs/superpowers/plans/2026-08-20-phase1-remaining-roadmap.md \
  README.md AGENTS.md \
  docs/superpowers/specs/2026-08-23-m4-player-weapons-design.md \
  docs/superpowers/plans/2026-08-23-m4-player-weapons.md
git commit -m "docs: add M4 player weapons roadmap"
```

只有用户明确要求提交时执行本步骤。

### Task 2: M4-0 批量世界编辑与事件协调器

**Files:**
- Modify: `src/voxel/world-data.js:15-88`
- Create: `src/core/world-editor.js`
- Modify: `src/tests/test-chunk-column.js:1-105`
- Create: `src/tests/test-world-editor.js`
- Modify: `src/tests/index.html:10-27`
- Create: `tests/world-editor.spec.mjs`

**Interfaces:**
- Consumes: `WorldData`, `ChunkColumn`, `Scheduler.remeshSections(affected, {fastPath})`，以及 `registry.idOf/nameOf`。
- Produces:

```js
// src/voxel/world-data.js
world.getBlockMeta(x, y, z) // number，缺失/越界为 0
world.setBlocks(changes) // { changes, affected, changedColumns, skipped }

// src/core/world-editor.js
export class WorldEditor {
  constructor({ world, scheduler }) {}
  setBlock(change, { fastPath = true } = {}) // EditReport
  setBlocks(changes) // EditReport
  subscribe(listener) // () => void
}
```

`changes` 中每项都为 `{x,y,z,oldId,oldMeta,newId,newMeta}`；`affected` 是去重后的 `{cx,cz,sy}`；`skipped` 中每项附带 `reason: 'out-of-bounds'|'column-missing'|'bedrock'|'no-change'`。后续 Task 3 的 `WeaponController` 只能依赖 `WorldEditor`，不能触碰 `WorldData.blocks`。

- [ ] **Step 1: 写失败的批量语义与协调器测试**

新建 `src/tests/test-world-editor.js`，复用 `test-chunk-column.js` 的 `makeRegistry()` 模式，编写以下测试。先把它追加到 `src/tests/index.html`，此时 import 必须失败，因为 `../core/world-editor.js` 尚不存在。

```js
import { test } from './runner.js';
import { assertDeepEqual, assertEqual, assertTrue } from './assert.js';
import { WorldEditor } from '../core/world-editor.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';

function makeReadyWorldWithTwoColumns() {
  const registry = createRegistry();
  for (const def of BLOCKS) registry.register(def.name, def);
  registry.freeze();
  const world = new WorldData(registry);
  for (const cx of [0, 1]) {
    const column = new ChunkColumn(cx, 0);
    column.state = 'ready';
    world.add(column);
  }
  return { world, registry };
}

test('WorldEditor.setBlocks: 同 column 只 bump 一次，逐格记录 edits 并合并重建', () => {
  const { world, registry } = makeReadyWorldWithTwoColumns();
  const calls = [];
  const editor = new WorldEditor({ world, scheduler: {
    remeshSections: (affected, opts) => calls.push({ affected, opts }),
    enqueueLight: (cx, cz) => calls.push({ light: [cx, cz] }),
  } });
  const stone = registry.idOf('stone');
  const column = world.getColumn(0, 0);
  world.setBlock(1, 0, 1, registry.idOf('dirt'));
  const beforeVersion = column.version;
  const events = [];
  editor.subscribe((event) => events.push(event));

  const report = editor.setBlocks([
    { x: 1, y: 0, z: 1, id: stone },
    { x: 1, y: 0, z: 1, id: 0 },
    { x: 15, y: 0, z: 1, id: stone },
  ]);

  assertEqual(column.version, beforeVersion + 1);
  assertEqual(world.getBlockId(1, 0, 1), 0);
  assertEqual(world.getBlockId(15, 0, 1), stone);
  assertEqual(column.edits.size, 2);
  assertEqual(report.changes.length, 2);
  assertEqual(events.length, 1);
  assertEqual(calls.filter((x) => x.opts?.fastPath === false).length, 1);
  assertTrue(report.affected.some((s) => s.cx === 1 && s.cz === 0));
});

test('WorldEditor.setBlocks: 基岩目标和越界不变，单块保持 fast path', () => {
  const { world, registry } = makeReadyWorldWithTwoColumns();
  const calls = [];
  const editor = new WorldEditor({ world, scheduler: {
    remeshSections: (affected, opts) => calls.push({ affected, opts }),
    enqueueLight: () => {},
  } });
  const bedrock = registry.idOf('bedrock');
  world.setBlock(2, 0, 2, bedrock);
  const report = editor.setBlocks([
    { x: 2, y: 0, z: 2, id: 0 },
    { x: 1, y: 96, z: 1, id: registry.idOf('stone') },
  ]);
  assertEqual(world.getBlockId(2, 0, 2), bedrock);
  assertDeepEqual(report.skipped.map((x) => x.reason), ['bedrock', 'out-of-bounds']);
  editor.setBlock({ x: 1, y: 1, z: 1, id: registry.idOf('stone') });
  assertEqual(calls.at(-1).opts.fastPath, true);
});
```

在 `src/tests/test-chunk-column.js` 额外断言 `world.setBlocks()` 跨两个 column 后每列只增一次版本、每个变更都被 `edits` 记录、`getBlockMeta()` 返回写入的 meta。

新建 `tests/world-editor.spec.mjs`，按现有 `tests/harness.spec.mjs` 的浏览器 runner 模式验证上述单测实际被页面加载：

```js
import { test, expect } from 'playwright/test';

test('M4-0：WorldEditor 浏览器单测通过', async ({ page }) => {
  await page.goto('/src/tests/index.html');
  await page.waitForFunction(
    () => window.__MC_TEST_RESULTS__ !== undefined,
    null,
    { timeout: 30_000 },
  );
  const results = await page.evaluate(() => window.__MC_TEST_RESULTS__);
  expect(results.failed).toBe(0);
});
```

RED 阶段，将 `test-world-editor.js` 注册到 `src/tests/index.html` 后，整页 ESM import 会因尚不存在的 `../core/world-editor.js` 失败，`__MC_TEST_RESULTS__` 不会出现；这正是本 Playwright spec 应观察到的失败模式，不能把新测试临时从 index 移除来“通过” RED。

- [ ] **Step 2: 运行 RED 验证**

```bash
npm test -- tests/world-editor.spec.mjs
```

Expected: FAIL，浏览器单测因 `world-editor.js` 或 `WorldData.setBlocks` 未导出而失败。

- [ ] **Step 3: 实现 WorldData 的批量原子写入**

在 `WorldData` 中新增 `getBlockMeta(x,y,z)`（越界或 column 缺失返回 `0`），并抽取 `_affectedFor(cx,cz,lx,y,lz)`；现有 `setBlock()` 和新的批量方法都调用它，避免两种编辑在 section 边界的脏标记不同。批量方法使用“最后一次坐标写入获胜”的 `Map`，读取旧 id/meta 后按 column 分组，在每组循环写 `blocks`、`meta`、`edits` 和 dirty section，循环结束后再 `column.version++` 一次。禁止对每格调用 `ChunkColumn.set()`，因为该方法会重复 bump version。

```js
_affectedFor(cx, cz, lx, y, lz) {
  const sy = (y - WORLD_MIN_Y) >> 4;
  const affected = [{ cx, cz, sy }];
  const yInSection = y - WORLD_MIN_Y - sy * 16;
  if (lx === 0) affected.push({ cx: cx - 1, cz, sy });
  if (lx === 15) affected.push({ cx: cx + 1, cz, sy });
  if (lz === 0) affected.push({ cx, cz: cz - 1, sy });
  if (lz === 15) affected.push({ cx, cz: cz + 1, sy });
  if (yInSection === 0 && sy > 0) affected.push({ cx, cz, sy: sy - 1 });
  if (yInSection === 15 && sy < 7) affected.push({ cx, cz, sy: sy + 1 });
  return affected;
}

getBlockMeta(x, y, z) {
  if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) return 0;
  const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
  const column = this.getColumn(cx, cz);
  return column ? column.meta[blockIndex(x - cx * 16, y, z - cz * 16)] : 0;
}

setBlocks(rawChanges) {
  const lastByPos = new Map();
  for (const change of rawChanges) lastByPos.set(`${change.x},${change.y},${change.z}`, change);
  const byColumn = new Map();
  const changes = [], skipped = [], affected = new Map();
  const bedrock = this.registry.idOf('bedrock');

  for (const change of lastByPos.values()) {
    if (change.y < WORLD_MIN_Y || change.y >= WORLD_MAX_Y) { skipped.push({ ...change, reason: 'out-of-bounds' }); continue; }
    const cx = Math.floor(change.x / 16), cz = Math.floor(change.z / 16);
    const column = this.getColumn(cx, cz);
    if (!column) { skipped.push({ ...change, reason: 'column-missing' }); continue; }
    const oldId = this.getBlockId(change.x, change.y, change.z);
    if (oldId === bedrock && change.id !== bedrock) { skipped.push({ ...change, reason: 'bedrock' }); continue; }
    const oldMeta = this.getBlockMeta(change.x, change.y, change.z);
    const newMeta = change.meta ?? 0;
    if (oldId === change.id && oldMeta === newMeta) { skipped.push({ ...change, reason: 'no-change' }); continue; }
    const lx = change.x - cx * 16, lz = change.z - cz * 16;
    const sy = (change.y - WORLD_MIN_Y) >> 4;
    const entry = { column, index: blockIndex(lx, change.y, lz), sy, newId: change.id, newMeta };
    const key = columnKey(cx, cz);
    if (!byColumn.has(key)) byColumn.set(key, []);
    byColumn.get(key).push(entry);
    changes.push({ x: change.x, y: change.y, z: change.z, oldId, oldMeta, newId: change.id, newMeta });
    for (const section of this._affectedFor(cx, cz, lx, change.y, lz)) {
      affected.set(`${section.cx},${section.cz},${section.sy}`, section);
    }
  }
  for (const entries of byColumn.values()) {
    for (const entry of entries) {
      entry.column.blocks[entry.index] = entry.newId;
      entry.column.meta[entry.index] = entry.newMeta;
      entry.column.edits.set(entry.index, { id: entry.newId, meta: entry.newMeta });
      entry.column.markDirty(entry.sy);
    }
    entries[0].column.version++;
  }
  return { changes, affected: [...affected.values()], changedColumns: [...byColumn.keys()], skipped };
}
```

保留现有 `setBlock()` 的同步 `recomputeSkylightAt()` 行为，防止 M1 挖/放当帧视觉回归；批量方法不做逐格同步光照，交给下一步的异步 light 队列。

- [ ] **Step 4: 实现无缓存的 WorldEditor**

创建 `src/core/world-editor.js`。构造器只保存传入的 `world`、`scheduler` 和 listener 集合。`setBlock()` 先检查 y、目标 column、基岩目标和 no-change；有效时读取 old 值后调用既有 `world.setBlock()`，形成 `EditReport`、调用 `scheduler.remeshSections(affected,{fastPath})` 并广播一次事件，因而保留单块同步 `recomputeSkylightAt()`。`setBlocks()` 调用新 `world.setBlocks()`，对每个 `affected` 唯一 `(cx,cz)` 调用 `scheduler.enqueueLight(cx,cz)`，再调用一次 `scheduler.remeshSections(report.affected,{fastPath:false})`，最后只在 `changes.length > 0` 时广播事件。

```js
import { WORLD_MIN_Y, WORLD_MAX_Y, columnKey } from '../voxel/constants.js';

setBlock(change, { fastPath = true } = {}) {
  const { x, y, z, id } = change;
  const meta = change.meta ?? 0;
  if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) return { changes: [], affected: [], skipped: [{ ...change, reason: 'out-of-bounds' }] };
  const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
  if (!this.world.getColumn(cx, cz)) return { changes: [], affected: [], skipped: [{ ...change, reason: 'column-missing' }] };
  const oldId = this.world.getBlockId(x, y, z), oldMeta = this.world.getBlockMeta(x, y, z);
  if (oldId === this.world.registry.idOf('bedrock') && id !== oldId) return { changes: [], affected: [], skipped: [{ ...change, reason: 'bedrock' }] };
  if (oldId === id && oldMeta === meta) return { changes: [], affected: [], skipped: [{ ...change, reason: 'no-change' }] };
  const write = this.world.setBlock(x, y, z, id, meta);
  const changes = [{ x, y, z, oldId, oldMeta, newId: id, newMeta: meta }];
  const report = { changes, affected: write.affected, changedColumns: [columnKey(cx, cz)], skipped: [] };
  this.scheduler.remeshSections(report.affected, { fastPath });
  this._emit(changes);
  return report;
}

setBlocks(changes) {
  const report = this.world.setBlocks(changes);
  if (report.changes.length === 0) return report;
  for (const key of new Set(report.affected.map(({ cx, cz }) => columnKey(cx, cz)))) {
    const [cx, cz] = key.split(',').map(Number);
    this.scheduler.enqueueLight(cx, cz);
  }
  this.scheduler.remeshSections(report.affected, { fastPath: false });
  this._emit(report.changes);
  return report;
}

_emit(changes) {
  if (changes.length === 0) return;
  const event = { type: 'block-changed', changes };
  for (const listener of this._listeners) listener(event);
}

subscribe(listener) {
  this._listeners.add(listener);
  return () => this._listeners.delete(listener);
}
```

不得把 event log、light 值或 world snapshot 放进 `WorldEditor`。

- [ ] **Step 5: 验证 GREEN 与持久化回归**

```bash
npm test -- tests/world-editor.spec.mjs tests/interaction.spec.mjs tests/persistence.spec.mjs
npm run lint
```

Expected: 新批量语义、既有交互和 edits 重启恢复均 PASS；lint 0 error。

- [ ] **Step 6: 在获明确授权后提交 M4-0**

```bash
git add src/voxel/world-data.js src/core/world-editor.js \
  src/tests/test-chunk-column.js src/tests/test-world-editor.js src/tests/index.html \
  tests/world-editor.spec.mjs
git commit -m "feat: add atomic world editor"
```

只有用户明确要求提交时执行本步骤。

### Task 3: 纯武器规则、MAG7 扫描与 DDA 控制器

**Files:**
- Create: `src/player/weapons/weapon-catalog.js`
- Create: `src/player/weapons/weapon-target-policy.js`
- Create: `src/player/weapons/mag7-pattern.js`
- Create: `src/player/weapons/weapon-controller.js`
- Create: `src/tests/test-weapons.js`
- Modify: `src/tests/index.html`
- Create: `tests/weapons-logic.spec.mjs`

**Interfaces:**
- Consumes: Task 2 `WorldEditor`, `raycastVoxel()` 已产生的 `{hit,blockPos,dist}`，以及只读 `BlockQuery`。
- Produces:

```js
export const WEAPON_IDS = Object.freeze({ ARM: 'arm', PISTOL: 'pistol', MAG7: 'mag7', MINIGUN: 'minigun' });
export const MAX_ACTIVE_TRACERS = 32;
export function isWeaponDestructible(id, registry);
export function collectMag7Changes(aim, blockQuery, registry);

export class WeaponController {
  constructor({ registry, blockQuery, editor, onEffect = () => {} }) {}
  select(id) // boolean
  cycle() // selected id
  setBlockDamage(enabled) // boolean
  pointerDown(aim) // Effect[]
  pointerUp()
  update(dt, aim) // Effect[]
  fireOnce(aim) // Effect[]，仍遵守冷却
  debugState() // {selectedId,cooldown,triggerHeld,shotsFired,lastEffect}
}
```

`aim` 只使用 plain arrays：`{origin,forward,right,up,target}`。其中 `target` 是 Player 已算好的 DDA 结果；控制器不 import three、不重新跑 terrain Raycaster。

- [ ] **Step 1: 写失败的纯逻辑测试**

新建 `src/tests/test-weapons.js`，先导入尚不存在的模块，并加入如下覆盖：catalog 的三套冷却/transform/`MAX_ACTIVE_TRACERS=32`；武器 policy；MAG7 扫描；按住逻辑。测试文件先定义如下独立 fixture，不能依赖其他测试文件的非导出 helper：

```js
import { test } from './runner.js';
import { assertEqual, assertFalse, assertTrue } from './assert.js';
import { createRegistry } from '../voxel/block-registry.js';
import { WEAPON_IDS, WEAPONS, MAX_ACTIVE_TRACERS } from '../player/weapons/weapon-catalog.js';
import { collectMag7Changes } from '../player/weapons/mag7-pattern.js';
import { WeaponController } from '../player/weapons/weapon-controller.js';

function makeRegistryWithWeaponBlocks() {
  const registry = createRegistry();
  for (const name of ['air', 'stone', 'water', 'bedrock', 'end_stone', 'end_stone_bricks', 'playground_block', 'playground_center_block']) {
    registry.register(name, { solid: name !== 'air' && name !== 'water', cullMode: name === 'water' ? 'transparent' : 'opaque' });
  }
  registry.freeze();
  return {
    registry,
    ids: Object.fromEntries(['air', 'stone', 'water', 'bedrock', 'end_stone', 'end_stone_bricks', 'playground_block', 'playground_center_block']
      .map((name) => [name === 'end_stone' ? 'endStone' : name === 'playground_block' ? 'playground' : name, registry.idOf(name)])),
  };
}

function makeControllerFixture() {
  const { registry, ids } = makeRegistryWithWeaponBlocks();
  const editor = {
    singleCalls: 0,
    batchCalls: 0,
    setBlock() { this.singleCalls++; return { changes: [{}] }; },
    setBlocks() { this.batchCalls++; return { changes: [{}] }; },
  };
  const effects = [];
  const aim = {
    origin: [0, 0, 0], forward: [1, 0, 0], right: [0, 0, 1], up: [0, 1, 0],
    target: { hit: true, blockPos: [2, 0, 0], dist: 2 },
  };
  return {
    editor,
    aim,
    controller: new WeaponController({
      registry,
      blockQuery: { getBlockId: () => ids.stone },
      editor,
      onEffect: (effect) => effects.push(effect),
    }),
    effects,
  };
}
```

```js
test('MAG7: 3×3 扫描先过滤再计 40，水可删且创造台/end_stone/基岩不可删', () => {
  const { registry, ids } = makeRegistryWithWeaponBlocks();
  const query = {
    getBlockId: (x, y, z) => x === 3 && y === 0 && z === 0 ? ids.water
      : x === 4 && y === 0 && z === 0 ? ids.endStone
      : x === 5 && y === 0 && z === 0 ? ids.playground : ids.stone,
  };
  const changes = collectMag7Changes({
    origin: [0, 0, 0], forward: [1, 0, 0], right: [0, 0, 1], up: [0, 1, 0],
  }, query, registry);
  assertTrue(changes.length <= 40);
  assertTrue(changes.some((c) => c.x === 3 && c.id === 0));
  assertFalse(changes.some((c) => c.x === 4 || c.x === 5));
});

test('WeaponController: MAG7 单发且无视开关，手枪按住依冷却重复', () => {
  const { controller, editor, aim } = makeControllerFixture();
  controller.select('mag7');
  controller.setBlockDamage(false);
  controller.pointerDown(aim);
  controller.update(1.5, aim);
  assertEqual(editor.batchCalls, 1);
  controller.pointerUp(); controller.select('pistol');
  controller.setBlockDamage(true);
  controller.pointerDown(aim); controller.update(.09, aim);
  assertEqual(editor.singleCalls, 2);
});
```

追加下列用例：手/枪循环四次回到手；普通枪关闭开关时 `fireOnce(aim)` 返回一个 end 为 `[2,0,0]` 的效果但 `singleCalls===0`；同一次冷却期间再次 `fireOnce(aim)` 返回空数组；开启开关、推进 `.09` 秒后手枪删首个命中；`end_stone` 命中仍令效果终点停在 `target.dist` 但不调用 editor；加特林 `pointerDown()` 后仅在两次 `update(.07,aim)` 各增加一次 `shotsFired`。在 catalog 断言中固定 `WEAPONS[WEAPON_IDS.PISTOL].cooldown===.09`、MAG7 `.scan.maxBlocks===40`、加特林 `.transform.rotationOrder==='YXZ'` 与 `MAX_ACTIVE_TRACERS===32`。

- [ ] **Step 2: 运行 RED 验证**

```bash
npm test -- tests/weapons-logic.spec.mjs
```

Expected: FAIL，浏览器单测报告 `weapon-catalog.js`、`mag7-pattern.js` 或 `weapon-controller.js` 无法导入。

- [ ] **Step 3: 实现 catalog、policy 和扫描器**

在 `weapon-catalog.js` 使用下面完整 literal；`freeze()` 必须递归冻结对象与数组，防止渲染层意外改写玩法目录。所有坐标均为相机局部坐标，`cooldown` 单位为秒。

```js
export const WEAPON_IDS = Object.freeze({ ARM: 'arm', PISTOL: 'pistol', MAG7: 'mag7', MINIGUN: 'minigun' });
export const MAX_ACTIVE_TRACERS = 32;

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export const WEAPONS = freeze({
  [WEAPON_IDS.PISTOL]: {
    id: 'pistol', model: 'pistol', cooldown: 0.09, recoil: 0.05, sound: 'gun_fire', volume: 0.09,
    transform: { scale: [0.09, 0.09, 0.09], position: [0.3, -0.85, -0.4], rotation: [0, 0, 0] },
    muzzleOffset: [0.3, -0.82, -0.44], localStart: [0.3, -0.33, -0.98],
    tracer: { color: 0xffff00, thickness: 1, lifetime: 0.1 }, automatic: true,
  },
  [WEAPON_IDS.MAG7]: {
    id: 'mag7', model: 'mag7', cooldown: 1.5, recoil: 0.15, sound: 'mag7_fire', volume: 0.2,
    transform: { scale: [1.3, 1.3, 1.3], position: [0.44, -0.5, -0.8], rotation: [0, -Math.PI / 2, 0] },
    muzzleOffset: [0.3, -0.82, -0.44], localStart: [0.55, -0.4, -1.8],
    tracer: { color: 0xff6600, thickness: 6, lifetime: 0.15 }, automatic: false,
    scan: { min: 1, max: 10, step: 0.5, halfWidth: 1, maxBlocks: 40 },
  },
  [WEAPON_IDS.MINIGUN]: {
    id: 'minigun', model: 'minigun', cooldown: 0.07, recoil: 0, sound: 'minigun_fire', volume: 0.15,
    transform: { scale: [0.5, 0.5, 0.5], position: [0.48, -0.56, 0.6], rotation: [-Math.PI / 2, -Math.PI / 2, -Math.PI], rotationOrder: 'YXZ' },
    muzzleOffset: [0.3, -0.82, -0.44], localStart: [0.5, -0.5, -1.8],
    tracer: { color: 0xffff00, thickness: 0.5, lifetime: 0.08 }, automatic: true,
    spin: { targetRadiansPerSecond: 25, shootingRetentionAt60Hz: 0.9, idleRetentionAt60Hz: 0.85 },
  },
});
```

`weapon-target-policy.js` 使用名字集合而非 BlockRegistry 新字段：

```js
const IMMUNE_NAMES = new Set(['bedrock', 'end_stone', 'playground_block', 'playground_center_block']);

export function isWeaponDestructible(id, registry) {
  const name = registry.nameOf(id);
  return name !== 'air' && !IMMUNE_NAMES.has(name);
}

export function isMag7Candidate(id, registry) {
  return isWeaponDestructible(id, registry);
}
```

在 `mag7-pattern.js` 按规格构造坐标，`Math.floor` 后以 `${x},${y},${z}` 去重；只有通过 policy 的格才消耗 40 配额，输出 `{x,y,z,id:0,meta:0,group}`，按 `group` 升序稳定排序。水会通过 policy，`end_stone_bricks` 也会通过；不要扩展免疫名单。

- [ ] **Step 4: 实现 WeaponController，不创建 three 对象**

控制器维护 `selectedId`、`cooldown`、`triggerHeld`、`shotsFired`、`blockDamageEnabled` 和效果队列。`pointerDown()` 对 pistol/minigun 立即尝试一次并置 `triggerHeld=true`；MAG7 仅在边沿尝试一次。`update(dt,aim)` 先将冷却钳为 `Math.max(0,cooldown-dt)`，只让 pistol/minigun 在 triggerHeld 时重复。对普通枪调用 `editor.setBlock({x,y,z,id:0})` 的条件是开关开启且 `isWeaponDestructible()`；对 MAG7 无视开关并只调用一次 `editor.setBlocks(collectMag7Changes(...))`。

效果事件必须是可测试的纯对象：

```js
{
  type: 'shot', weaponId: 'pistol', sound: 'gun_fire', volume: .09,
  start: [number, number, number], end: [number, number, number],
  localStart: [number, number, number], recoil: .05,
  tracer: { color: 0xffff00, thickness: 1, lifetime: .1 }
}
```

`start` 必须按 `origin + right*localStart[0] + up*localStart[1] - forward*localStart[2]` 计算；没有 DDA 命中时 `end=origin+forward*40`，有命中时使用 `target.dist`。MAG7 用扫描中第一个距离组的中心候选作为效果终点，无候选时用 10 格前方。每次 effect 调用 `onEffect(effect)`，但状态机自身不播放声音或创建 mesh。

- [ ] **Step 5: 验证 GREEN 和 DDA 红线**

```bash
npm test -- tests/weapons-logic.spec.mjs
rg -n "Raycaster|intersectObjects" src/player/weapons
npm run lint
```

Expected: 逻辑 spec PASS；第二条命令无输出；lint 0 error。

- [ ] **Step 6: 在获明确授权后提交纯逻辑任务**

```bash
git add src/player/weapons src/tests/test-weapons.js src/tests/index.html tests/weapons-logic.spec.mjs
git commit -m "feat: add DDA weapon controller"
```

只有用户明确要求提交时执行本步骤。

### Task 4: 受控 GLB、音频和本地 r185.1 加载链

**Files:**
- Create: `assets/models/weapons/pistol.glb`（复制 mc-lite `silahful.glb`）
- Create: `assets/models/weapons/mag7.glb`（复制 mc-lite `mag7.glb`）
- Create: `assets/models/weapons/minigun.glb`（复制 mc-lite `minigun.glb`）
- Create: `assets/sounds/gun_load.mp3`, `assets/sounds/gun_fire.mp3`, `assets/sounds/mag7_fire.mp3`, `assets/sounds/minigun_fire.mp3`
- Create: `vendor/three/addons/loaders/GLTFLoader.js`
- Create: `vendor/three/addons/utils/BufferGeometryUtils.js`
- Create: `vendor/three/addons/utils/SkeletonUtils.js`
- Create: `src/render/weapon-model-loader.js`
- Create: `src/render/audio-manager.js`
- Create: `tools/validate-weapon-assets.mjs`
- Modify: `package.json:6-17`
- Create: `tests/weapon-assets.spec.mjs`
- Modify: `README.md:49-70`

**Interfaces:**
- Consumes: Task 3 `WEAPONS` 的 model/audio id；既有 `index.html:31` 的 `three/addons/` import map。
- Produces:

```js
export class WeaponModelLoader {
  constructor({ urls = WEAPON_ASSET_URLS, loader = new GLTFLoader() } = {}) {}
  load(id) // Promise<THREE.Group>，返回可独立挂载的 clone
  dispose()
}

export class AudioManager {
  constructor(camera, { loadBuffer } = {}) {}
  preload(ids) // Promise<void>
  unlock() // Promise<boolean>
  play(id, volume) // boolean
  get playRequests() // ReadonlyMap<string, number>
  dispose()
}
```

`npm run validate:weapon-assets` 在复制资产、Playwright 和提交前必须通过。

- [ ] **Step 1: 写失败的资源加载测试**

新建 `tests/weapon-assets.spec.mjs`，使用 WebGPU Chromium 动态导入尚不存在的 `WeaponModelLoader`，并验证三件资源均有 child、pistol 有 3 个 primitive、未知 id 的错误包含 id、加载失败不让页面 boot 崩溃。

```js
test('M4 GLB 资源经本地 r185 loader 加载且无外链依赖', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__MC_BOOT__?.rendererReady === true);
  const result = await page.evaluate(async () => {
    const { WeaponModelLoader } = await import('/src/render/weapon-model-loader.js');
    const loader = new WeaponModelLoader();
    const pistol = await loader.load('pistol');
    const mag7 = await loader.load('mag7');
    const minigun = await loader.load('minigun');
    let pistolMeshes = 0;
    pistol.traverse((node) => { if (node.isMesh) pistolMeshes++; });
    let unknownError = '';
    try { await loader.load('unknown'); } catch (error) { unknownError = error.message; }
    const broken = new WeaponModelLoader({ urls: { pistol: '/assets/models/weapons/missing.glb' } });
    let missingError = '';
    try { await broken.load('pistol'); } catch (error) { missingError = error.message; }
    broken.dispose();
    loader.dispose();
    return {
      pistolMeshes,
      mag7Children: mag7.children.length,
      minigunChildren: minigun.children.length,
      unknownError,
      missingError,
      worldReady: window.__MC_GAME__?.worldReady,
    };
  });
  expect(result.pistolMeshes).toBe(3);
  expect(result.mag7Children).toBeGreaterThan(0);
  expect(result.minigunChildren).toBeGreaterThan(0);
  expect(result.unknownError).toContain('unknown');
  expect(result.missingError).toContain('pistol');
  expect(result.worldReady).toBe(true);
});
```

- [ ] **Step 2: 运行 RED 验证**

```bash
npm test -- tests/weapon-assets.spec.mjs
```

Expected: FAIL，`/src/render/weapon-model-loader.js` 尚不存在。

- [ ] **Step 3: 复制二进制资产和 three 依赖闭包**

从 mc-lite 复制且只复制下列文件，保留二进制字节，不引入 `gun.gltf`、OBJ/MTL、Draco/KTX2 loader 或任何 CDN URL：

```bash
mkdir -p assets/models/weapons assets/sounds vendor/three/addons/loaders vendor/three/addons/utils
cp /Users/bachi/jaylli/mc-lite/src/assets/mod/silahful.glb assets/models/weapons/pistol.glb
cp /Users/bachi/jaylli/mc-lite/src/assets/mod/mag7.glb assets/models/weapons/mag7.glb
cp /Users/bachi/jaylli/mc-lite/src/assets/mod/minigun.glb assets/models/weapons/minigun.glb
cp /Users/bachi/jaylli/mc-lite/src/assets/sound/gun_load.mp3 assets/sounds/gun_load.mp3
cp /Users/bachi/jaylli/mc-lite/src/assets/sound/gun_fire.mp3 assets/sounds/gun_fire.mp3
cp /Users/bachi/jaylli/mc-lite/src/assets/sound/mag7_fire.mp3 assets/sounds/mag7_fire.mp3
cp /Users/bachi/jaylli/mc-lite/src/assets/sound/minigun_fire.mp3 assets/sounds/minigun_fire.mp3
```

从 **npm `three@0.185.1`** 解包后的 `examples/jsm/` 复制 `GLTFLoader.js` 及它的两个直接依赖 `BufferGeometryUtils.js`、`SkeletonUtils.js` 到上述 vendor 路径；不得从不明 Git 分支、CDN 或其他 three 小版本取源。这与当前本地构建 `vendor/three/three.core.js` 的 `REVISION = '185'` 同源。验证 `GLTFLoader.js` 只从 `three`、`../utils/BufferGeometryUtils.js` 和 `../utils/SkeletonUtils.js` 导入。不要修改 `index.html`：它已映射 `three/addons/`。

- [ ] **Step 4: 实现可审计的 GLB 验证器和 loader**

`tools/validate-weapon-assets.mjs` 读取 GLB header（magic `0x46546c67`、version 2、JSON chunk），验证三个 manifest 条目、文件精确上限（pistol 2 MiB、mag7 256 KiB、minigun 128 KiB）、无 `buffers[].uri`/`images[].uri` 外链、无 `extensionsRequired`，并输出每个文件的 bytes、mesh、primitive、image、animation、skin 数。失败必须 `process.exitCode=1` 并打印 id/path/reason。新增 package script：

```json
"validate:weapon-assets": "node tools/validate-weapon-assets.mjs"
```

定义 `WEAPON_ASSET_URLS=Object.freeze({pistol:'/assets/models/weapons/pistol.glb',mag7:'/assets/models/weapons/mag7.glb',minigun:'/assets/models/weapons/minigun.glb'})`。`WeaponModelLoader` 使用 `GLTFLoader.loadAsync(url)`，以 id 缓存唯一模板 promise；构造器允许测试传入替换 url 或 loader。模板归一化与 mc-lite 一致：`Box3.setFromObject(scene)`、平移负中心、`rotation.y=Math.PI`、外层 group 以最大维度缩放到 1。`load(id)` 只返回 template clone；失败抛出 `weapon asset <id> failed: <url>: <message>`。`dispose()` 必须遍历所有模板，dispose geometry/material/texture 后清空 cache。

- [ ] **Step 5: 实现用户手势安全的 AudioManager**

`AudioManager` 在 camera 上安装唯一 `THREE.AudioListener`；`preload()` 只接受 catalog 中四个 id 并从 `/assets/sounds/<id>.mp3` 加载。`unlock()` 检查 `listener.context.state`，调用 `resume()` 后返回是否进入 `running`。`play()` 无论 context 是否可播都先递增只读的播放请求计数；只有 buffer 已加载且 context 已 running 才创建/复用 `THREE.Audio`。不要使用定时器清理声音；使用 `source.onended` 归还实例。`dispose()` 停止 active sound、从 camera 移除 listener、清空 buffer/计数。

在 README 的目录树补上 `assets/models/weapons/`、`assets/sounds/` 和 `vendor/three/addons/`，并说明三件模型为受控 GLB。

- [ ] **Step 6: 验证 GREEN、资产边界和 lint**

```bash
npm run validate:weapon-assets
npm test -- tests/weapon-assets.spec.mjs
rg -n "https?://|DRACOLoader|KTX2Loader|OBJLoader|MTLLoader" src/render/weapon-model-loader.js vendor/three/addons/loaders/GLTFLoader.js
npm run lint
```

Expected: validator 输出三件资产统计并退出 0；加载 spec PASS；第三条只可能显示 GLTFLoader 的文档注释，`weapon-model-loader.js` 无命中；lint 0 error。

- [ ] **Step 7: 在获明确授权后提交资产任务**

```bash
git add assets/models/weapons assets/sounds vendor/three/addons \
  src/render/weapon-model-loader.js src/render/audio-manager.js \
  tools/validate-weapon-assets.mjs package.json README.md tests/weapon-assets.spec.mjs
git commit -m "feat: add controlled weapon assets"
```

只有用户明确要求提交时执行本步骤。

### Task 5: 相机视图模型与上限曳光渲染

**Files:**
- Create: `src/render/view-weapon.js`
- Create: `src/render/tracer-renderer.js`
- Create: `tests/weapon-view.spec.mjs`

**Interfaces:**
- Consumes: Task 3 `WEAPONS`/效果事件，Task 4 `WeaponModelLoader`/`AudioManager`，`THREE.PerspectiveCamera` 和 `THREE.Scene`。
- Produces:

```js
export class ViewWeapon {
  constructor({ camera, modelLoader }) {}
  async select(id) // arm 时移除模型；返回当前 id
  onShot(effect)
  update(dt, { recoil, shooting })
  get state() // { selectedId, loaded, rotationOrder }
  dispose()
}

export class TracerRenderer {
  constructor({ scene, maxActive = MAX_ACTIVE_TRACERS }) {}
  spawn(effect) // boolean
  update(dt, cameraBasis)
  get activeCount() // number
  dispose()
}
```

- [ ] **Step 1: 写失败的视图模型与对象池测试**

新建 `tests/weapon-view.spec.mjs`。页面 boot 后动态导入两个尚不存在类，使用返回 `new THREE.Group()` 的 fake modelLoader，断言 pistol 挂在 camera、select arm 后移除、minigun 的 `rotation.order` 为 `YXZ`，连续 `spawn()` 33 次后 active count 为 32，最旧 tracer 被回收。

```js
const result = await page.evaluate(async () => {
  const THREE = await import('three');
  const { ViewWeapon } = await import('/src/render/view-weapon.js');
  const { TracerRenderer } = await import('/src/render/tracer-renderer.js');
  const camera = new THREE.PerspectiveCamera();
  const scene = new THREE.Scene();
  const view = new ViewWeapon({ camera, modelLoader: { load: async () => new THREE.Group() } });
  await view.select('minigun');
  const beforeArm = { children: camera.children.length, order: view.state.rotationOrder };
  await view.select('arm');
  const tracers = new TracerRenderer({ scene });
  for (let i = 0; i < 33; i++) {
    tracers.spawn({
      start: [0, 0, 0], localStart: [0, 0, -1], end: [0, 0, -4 - i],
      tracer: { color: i % 2 ? 0xffff00 : 0xff6600, thickness: 1, lifetime: 1 },
    });
  }
  const active = tracers.activeCount;
  const tracerNodes = scene.children.length;
  tracers.dispose();
  view.dispose();
  return { beforeArm, afterArm: camera.children.length, active, tracerNodes, disposedTracerNodes: scene.children.length };
});
expect(result.beforeArm).toEqual({ children: 1, order: 'YXZ' });
expect(result.afterArm).toBe(0);
expect(result.active).toBe(32);
expect(result.tracerNodes).toBe(1);
expect(result.disposedTracerNodes).toBe(0);
```

- [ ] **Step 2: 运行 RED 验证**

```bash
npm test -- tests/weapon-view.spec.mjs
```

Expected: FAIL，两个渲染模块无法导入。

- [ ] **Step 3: 实现 ViewWeapon 的异步选择与动画**

`select(id)` 每次递增请求 token；`id==='arm'` 立即移除现有 node。其他 id await `modelLoader.load(id)` 后只有 token 仍匹配时才 add 到 camera，否则丢弃本次 clone。每帧将 catalog 的数组写入 position/rotation/scale；举枪使用 `drawProgress=min(1,drawProgress+dt*4)` 和 `pow(1-drawProgress,2)*1.2` 下移。`onShot(effect)` 将当前后坐设为 `effect.recoil`；`update()` 将它按 `recoil *= Math.pow(.8, dt*60)` 衰减并加到 local z。加特林建 node 前设 `rotation.order='YXZ'`；射击时用 `1-Math.pow(.9,dt*60)` 向 `25 rad/s` 插值，停火时用 `1-Math.pow(.85,dt*60)` 向 0 插值，随后 `spinRotation += spinVelocity*dt`，令 `rotation.x = baseRotationX + spinRotation`。这等价于 mc-lite 在 60Hz 的 0.9/0.85 插值口径，同时不让旋转随帧率变化。

`dispose()` 递增 token、从 camera 移除 active node、清空引用；它不得 dispose `WeaponModelLoader` 的共享 geometry/material。

- [ ] **Step 4: 实现 TracerRenderer 的纯派生对象池**

创建一次共享 cylinder geometry 和一个 `THREE.InstancedMesh(geometry, material, 32)`，只将这一个节点加入 scene；初始化每个 slot 的 instance matrix 为零 scale，实例颜色在 `spawn()` 时写入 `effect.tracer.color`。每条 active record 仅保存 `{slot,lifetime,end,localStart,thickness}`；空闲 slot 用数组管理。`spawn(effect)` 优先取空闲 slot，满 32 时先回收 `active[0]`，因此第 33 条必定淘汰最旧者。`update(dt,cameraBasis)` 将每条 `localStart` 用 `origin + right*x + up*y - forward*z` 重算为当前枪口起点，朝固定 `end` 写入该实例的位移/旋转/粗细矩阵；寿命到 0 时将 slot 写回零 scale 并归还。该起点在寿命内随当前相机基底移动是**保留 mc-lite 语义**：mc-lite 的 `PlayerInteraction.updateTracers()` 同样每帧以 `localStart.applyQuaternion(camera.quaternion).add(camera.position)` 重算，而非固定首次发射时的世界起点。更新后置 `instanceMatrix.needsUpdate=true` 和 `instanceColor.needsUpdate=true`。`dispose()` 从 scene 移除这一个 mesh，并 dispose 共享 geometry/material。

不要把 tracer 加入 RenderWorld、BatchedMesh、Worker 或 persistence；它只是可丢弃的视觉派生数据。

- [ ] **Step 5: 验证 GREEN 与资源释放**

```bash
npm test -- tests/weapon-view.spec.mjs
npm run lint
```

Expected: PASS；dispose 后 camera/scene 不含 view weapon/tracer；lint 0 error。

- [ ] **Step 6: 在获明确授权后提交视图任务**

```bash
git add src/render/view-weapon.js src/render/tracer-renderer.js tests/weapon-view.spec.mjs
git commit -m "feat: render player weapon view models"
```

只有用户明确要求提交时执行本步骤。

### Task 6: 装配到 Player/Game、输入与可测试公开 API

**Files:**
- Modify: `src/player/player.js:1-143`
- Modify: `src/core/game.js:1-195`
- Modify: `tests/interaction.spec.mjs:1-49`
- Create: `tests/weapons.spec.mjs`

**Interfaces:**
- Consumes: Tasks 2–5 的 `WorldEditor`、`WeaponController`、`WeaponModelLoader`、`AudioManager`、`ViewWeapon`、`TracerRenderer`。
- Produces:

```js
// Game 的实际公开游戏 API；Playwright 与 UI 都走这些方法。
game.selectWeapon(id) // Promise<string>
game.fireWeaponOnce() // Effect[]
game.setGunBlockDamage(enabled) // boolean
game.weaponDebugState() // { selectedId, cooldown, triggerHeld, shotsFired, activeTracers, lastEffect, viewLoaded, audioPlayRequests }
```

`Player` 构造器新增 `editor`、`weaponRuntime` 注入；不公开 raw typed array 给控制器。`Game.dispose()` 必须调用 Player/Audio/ModelLoader 的 dispose。

- [ ] **Step 1: 写失败的无 pointer-lock 集成测试**

新建 `tests/weapons.spec.mjs`，先调用尚不存在的 Game API。初始视线固定为 yaw/pitch 都为零的 `-Z`，故在相机前方 2 格眼高处通过 `game.editor.setBlock()` 放置石头，并把 `player.target` 固定为该格的 `{hit:true,blockPos,dist}`；以关闭/开启开关各开一枪（两枪之间等待 100ms 让 0.09s 冷却结束）。随后额外等待 1.5 秒让 MAG7 冷却结束，重放石头后再选择 MAG7；关闭开关开火仍须删除该候选。最后选择加特林并隔两个冷却周期调用两次 `fireWeaponOnce()`，验证 `shotsFired` 增长。测试同时断言第一人称模型已加载、tracer count 不超过 32、audio 播放请求增长。

```js
const result = await page.evaluate(async () => {
  const g = window.__MC_GAME__;
  g.player.yaw = 0; g.player.pitch = 0;
  const x = Math.floor(g.camera.position.x);
  const y = Math.floor(g.camera.position.y);
  const z = Math.floor(g.camera.position.z) - 2;
  g.editor.setBlock({ x, y, z, id: g.registry.idOf('stone') });
  g.player.target = { hit: true, blockPos: [x, y, z], dist: 2 };
  await g.selectWeapon('pistol');
  g.setGunBlockDamage(false);
  const blocked = g.fireWeaponOnce();
  await new Promise((resolve) => setTimeout(resolve, 100));
  g.player.target = { hit: true, blockPos: [x, y, z], dist: 2 };
  g.setGunBlockDamage(true);
  const destroyed = g.fireWeaponOnce();
  const pistolDestroyed = g.world.getBlockId(x, y, z) === 0;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  g.editor.setBlock({ x, y, z, id: g.registry.idOf('stone') });
  g.player.target = { hit: true, blockPos: [x, y, z], dist: 2 };
  await g.selectWeapon('mag7');
  g.setGunBlockDamage(false);
  const mag7 = g.fireWeaponOnce();
  const mag7Destroyed = g.world.getBlockId(x, y, z) === 0;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await g.selectWeapon('minigun');
  await new Promise((resolve) => setTimeout(resolve, 70));
  const beforeMinigun = g.weaponDebugState().shotsFired;
  g.fireWeaponOnce();
  await new Promise((resolve) => setTimeout(resolve, 70));
  g.fireWeaponOnce();
  const state = g.weaponDebugState();
  return { blocked, destroyed, pistolDestroyed, mag7, mag7Destroyed, beforeMinigun, state };
});
expect(result.blocked.length).toBe(1);
expect(result.destroyed.length).toBe(1);
expect(result.pistolDestroyed).toBe(true);
expect(result.mag7.length).toBe(1);
expect(result.mag7Destroyed).toBe(true);
expect(result.state.shotsFired).toBeGreaterThan(result.beforeMinigun);
expect(result.state.activeTracers).toBeLessThanOrEqual(32);
expect(result.state.viewLoaded).toBe(true);
expect(result.state.audioPlayRequests).toBeGreaterThan(0);
```

在 `tests/interaction.spec.mjs` 把直接的 `world.setBlock()+scheduler.remeshSections()` 改为 `game.editor.setBlock()`，使既有放挖验收也走唯一编辑路径。

- [ ] **Step 2: 运行 RED 验证**

```bash
npm test -- tests/weapons.spec.mjs tests/interaction.spec.mjs
```

Expected: FAIL，`Game.selectWeapon` 未定义；现有 interaction 在迁移后也会指出 `game.editor` 未定义。

- [ ] **Step 3: 在 Game 中装配基础设施并迁移 Player 的世界编辑**

在 `Game.start()` 创建 scheduler 后立即创建 `this.editor = new WorldEditor({world:this.world,scheduler:this.scheduler})`；创建 `WeaponModelLoader`、`AudioManager(this.camera)` 并预加载四个声音（单个失败记录到 console，不中止 `worldReady`）；创建 Player 时注入 editor 和这些运行时对象。`dispose()` 的反向顺序是 Player → AudioManager → WeaponModelLoader → WorkerPool → renderer。

将 `Player.digBlock()`/`placeBlock()` 改为 `this.editor.setBlock(...)`，但保留徒手的 bedrock 拦截和 fast path。创建 controller 时注入唯一的 `onEffect: (effect) => this._applyWeaponEffect(effect)`；后者按顺序调用 `viewWeapon.onShot(effect)`、`tracerRenderer.spawn(effect)`、`audioManager.play(effect.sound,effect.volume)`，不再由 update 返回数组重复播放。每帧相机更新、DDA `target` 计算完成后，用 `_buildAim()` 创建 plain `aim`（origin、forward、right、up、target），调用 `weaponController.update(dt,aim)`、`viewWeapon.update(dt,{shooting: weaponController.debugState().triggerHeld})` 和 `tracerRenderer.update(dt,aim)`。现有高亮逻辑保持使用同一 DDA 结果。

- [ ] **Step 4: 改造真实输入和公开 API**

`keydown` 的非重复 `KeyR` 调用 `void cycleWeapon()` 并 `void audio.unlock()`。必须保留现有真实鼠标入口的第一道守卫：`if (document.pointerLockElement !== this._canvas) return;`；只有守卫通过后，`mousedown` 才在该真实用户手势中调用 `void audio.unlock()`，并让左键在徒手时挖掘、持枪时 `weaponController.pointerDown(_buildAim())`。`mouseup` 左键调用 `pointerUp()`；右键始终放块。不得为了自动化移除此 pointer-lock 守卫；无头测试只使用下列公开 API。`selectWeapon(id)` 先由 controller 校验/切换 id，再 await `viewWeapon.select(id)`，非徒手时播放 `gun_load`（音量 `.4`）；`cycleWeapon()` 复用相同流程。测试 API 只委派给同一 controller，不复制玩法逻辑：

```js
async selectWeapon(id) { return this.player.selectWeapon(id); }
fireWeaponOnce() { return this.player.fireWeaponOnce(); }
setGunBlockDamage(enabled) { return this.player.setGunBlockDamage(enabled); }
weaponDebugState() { return this.player.weaponDebugState(); }
```

为 Player 的 window/canvas event listener 保存 bound function，并在 `Player.dispose()` remove，避免重启或 Playwright reload 后监听器叠加。`_buildAim()` 在每次调用时从 `camera.position`、`camera.getWorldDirection()`、camera quaternion 计算 `right/up`，并读取当时的 `player.target`；`fireWeaponOnce()` 必须调用它，不能读取上一个帧缓存的 aim，且仍遵守冷却。`weaponDebugState()` 以 controller `debugState()` 为基底合并 `tracerRenderer.activeCount`、`viewWeapon.state.loaded` 与 AudioManager 全部播放请求数。若模型仍加载，玩法控制器仍可开火、视图模型稍后显示。

- [ ] **Step 5: 验证 GREEN、交互不回归和模型可见性**

```bash
npm test -- tests/weapons.spec.mjs tests/interaction.spec.mjs tests/persistence.spec.mjs
npm run lint
```

Expected: 三把枪的 API 驱动、MAG7 开关豁免、徒手放挖和 edits 重启恢复都 PASS；lint 0 error。

- [ ] **Step 6: 在获明确授权后提交集成任务**

```bash
git add src/player/player.js src/core/game.js tests/interaction.spec.mjs tests/weapons.spec.mjs
git commit -m "feat: integrate player weapons"
```

只有用户明确要求提交时执行本步骤。

### Task 7: M4 验收、性能回归与交付记录

**Files:**
- Create: `tests/weapons-performance.spec.mjs`
- Create: `tests/weapons-world-edit.spec.mjs`
- Modify: `src/core/scheduler.js:407-417`
- Modify: `src/render/render-world.js:31-186`
- Create: `docs/m4-weapons-acceptance-report.md`
- Modify: `README.md:1-74`
- Modify: `docs/superpowers/specs/2026-08-23-m4-player-weapons-design.md:1-141`
- Modify: `docs/superpowers/plans/2026-08-23-m4-player-weapons.md`

**Interfaces:**
- Consumes: `Game.renderStats()`, `Game.perfSnapshot()`, `Game.weaponDebugState()`，以及全部 M4 API。
- Produces: 可重复的 M4 性能/真实世界编辑门禁、只读版本诊断、实测验收报告和标记为已实施的规格/计划；不修改 M3 冻结断言或阈值。

```js
// Scheduler：保留既有字段，并只增加队列长度的观测值。
scheduler.stats() // { inflight, genInflight, ready, meshInflight, meshQueued,
                  //   pendingMesh, uploadQueue, sections, lightInflight, lightQueued }

// RenderWorld：已由 Scheduler 版本校验后发布的 section 版本；无记录时为 undefined。
renderWorld.getSectionVersion(cx, sy, cz) // number | undefined
```

两个诊断接口均为只读派生状态：不保存 blocks/meta/light，不参与调度分支，也不改变 Worker 协议；它们只让 Playwright 对“队列已收敛、过期 mesh 未写回”作直接断言。


- [ ] **Step 1: 写失败的视距 8 连射与真实世界编辑压力测试**

新建 `tests/weapons-performance.spec.mjs`。以 `/?vd=8` 启动后，必须依次等待 `worldReady`、完整 289 column、全部 GEN/MESH/LIGHT/upload 队列清空，再沉淀 5 秒；不得直接从加载期采样。完整测试如下。它要求：本机 fps ≥90（CI ≥20）、frame p95 <16.7ms（CI <50ms）、minigun draw call 不高于徒手 +2、`activeTracers<=32`、所有队列收敛。

```js
import { test, expect } from 'playwright/test';

async function waitForStableVD8(page) {
  await page.goto('/?vd=8');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => window.__MC_GAME__.world.columns.size >= 289, null, { timeout: 90_000 });
  await page.waitForFunction(() => {
    const s = window.__MC_GAME__.scheduler.stats();
    return s.genInflight === 0 && s.meshInflight === 0 && s.meshQueued === 0 &&
      s.pendingMesh === 0 && s.lightInflight === 0 && s.lightQueued === 0 && s.uploadQueue === 0;
  }, null, { timeout: 60_000 });
  await page.waitForTimeout(5_000);
}

test('M4：视距 8 下持续加特林不回退 M3 基线', async ({ page }) => {
  test.setTimeout(180_000);
  await waitForStableVD8(page);
const before = await page.evaluate(() => ({
  ...window.__MC_GAME__.perfSnapshot(),
  drawCalls: window.__MC_GAME__.renderStats().drawCalls,
}));
await page.evaluate(async () => {
  const g = window.__MC_GAME__;
  await g.selectWeapon('minigun');
  for (let i = 0; i < 100; i++) {
    g.fireWeaponOnce();
    if (i < 99) await new Promise((resolve) => setTimeout(resolve, 70));
  }
});
const during = await page.evaluate(() => ({
  ...window.__MC_GAME__.perfSnapshot(),
  drawCalls: window.__MC_GAME__.renderStats().drawCalls,
  weapon: window.__MC_GAME__.weaponDebugState(),
}));
await page.waitForFunction(() => {
  const g = window.__MC_GAME__;
  const s = g.scheduler.stats();
  return s.genInflight === 0 && s.meshInflight === 0 && s.meshQueued === 0 &&
    s.pendingMesh === 0 && s.lightInflight === 0 && s.lightQueued === 0 &&
    s.uploadQueue === 0 && g.weaponDebugState().activeTracers === 0;
}, null, { timeout: 60_000 });
const after = await page.evaluate(() => ({
  ...window.__MC_GAME__.perfSnapshot(),
  drawCalls: window.__MC_GAME__.renderStats().drawCalls,
  weapon: window.__MC_GAME__.weaponDebugState(),
  scheduler: window.__MC_GAME__.scheduler.stats(),
}));
expect(after.fps).toBeGreaterThan(process.env.CI ? 20 : 90);
expect(after.frameMs.p95).toBeLessThan(process.env.CI ? 50 : 16.7);
expect(during.drawCalls).toBeLessThanOrEqual(before.drawCalls + 2);
expect(during.weapon.activeTracers).toBeLessThanOrEqual(32);
expect(after.scheduler.genInflight).toBe(0);
expect(after.scheduler.meshInflight).toBe(0);
expect(after.scheduler.meshQueued).toBe(0);
expect(after.scheduler.pendingMesh).toBe(0);
expect(after.scheduler.lightInflight).toBe(0);
expect(after.scheduler.lightQueued).toBe(0);
expect(after.scheduler.uploadQueue).toBe(0);
});
```

新建 `tests/weapons-world-edit.spec.mjs`。这不是上例“开关关闭”的替代品：它必须真正开启普通枪破坏并连续 200 次，同时按 MAG7 固定 1.5 秒冷却连续 20 次。普通枪计时只包围真实 `fireWeaponOnce()` 删除路径，因此产生验收报告的 `world-edit p95`；MAG7 也记录批量提交 p95，但不新增未冻结的阈值。WebGPU 的 `renderer.info.memory` 不是稳定的对象计数口径，所以以 scene/camera child 数和 `activeTracers` 作为可观测的 three 对象增长证据；Task 5 已证明曳光始终只有一个 InstancedMesh，本测试再确保连续射击后没有悬挂曳光或新增 scene/camera 节点。

```js
import { test, expect } from 'playwright/test';

async function waitForStableVD8(page) {
  await page.goto('/?vd=8');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => window.__MC_GAME__.world.columns.size >= 289, null, { timeout: 90_000 });
  await page.waitForFunction(() => {
    const s = window.__MC_GAME__.scheduler.stats();
    return s.genInflight === 0 && s.meshInflight === 0 && s.meshQueued === 0 &&
      s.pendingMesh === 0 && s.lightInflight === 0 && s.lightQueued === 0 && s.uploadQueue === 0;
  }, null, { timeout: 60_000 });
  await page.waitForTimeout(5_000);
}

test('M4：200 次普通枪和 20 次 MAG7 破坏后版本与队列收敛', async ({ page }) => {
  test.setTimeout(180_000);
  await waitForStableVD8(page);
  const run = await page.evaluate(async () => {
    const p95 = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length * .95)];
    const g = window.__MC_GAME__;
    const stone = g.registry.idOf('stone');
    g.player.yaw = 0; g.player.pitch = 0;
    const x = Math.floor(g.camera.position.x);
    const y = Math.floor(g.camera.position.y);
    const z = Math.floor(g.camera.position.z) - 2;
    await g.selectWeapon('pistol');
    g.setGunBlockDamage(true);
    const objectCountBefore = { scene: g.scene.children.length, camera: g.camera.children.length };
    const pistolTimes = [];
    let pistolEffects = 0;
    let pistolAir = true;
    for (let i = 0; i < 200; i++) {
      g.editor.setBlock({ x, y, z, id: stone });
      g.player.target = { hit: true, blockPos: [x, y, z], dist: 2 };
      const t0 = performance.now();
      const effects = g.fireWeaponOnce();
      pistolTimes.push(performance.now() - t0);
      pistolEffects += effects.length;
      pistolAir &&= g.world.getBlockId(x, y, z) === 0;
      if (i < 199) await new Promise((resolve) => setTimeout(resolve, 95));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    await g.selectWeapon('mag7');
    g.setGunBlockDamage(false); // MAG7 必须仍然破坏。
    const mag7Times = [];
    let mag7Effects = 0;
    let mag7Air = true;
    const cells = [];
    for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) {
      cells.push({ x: x + dx, y: y + dy, z: Math.floor(g.camera.position.z) - 1 });
    }
    for (let i = 0; i < 20; i++) {
      for (const cell of cells) g.editor.setBlock({ ...cell, id: stone });
      const t0 = performance.now();
      const effects = g.fireWeaponOnce();
      mag7Times.push(performance.now() - t0);
      mag7Effects += effects.length;
      mag7Air &&= cells.every((cell) => g.world.getBlockId(cell.x, cell.y, cell.z) === 0);
      if (i < 19) await new Promise((resolve) => setTimeout(resolve, 1_510));
    }
    const { WORLD_MIN_Y } = await import('/src/voxel/constants.js');
    return {
      pistolP95: p95(pistolTimes),
      mag7P95: p95(mag7Times),
      pistolEffects,
      mag7Effects,
      pistolAir,
      mag7Air,
      objectCountBefore,
      section: {
        cx: Math.floor(x / 16),
        sy: Math.floor((y - WORLD_MIN_Y) / 16),
        cz: Math.floor(z / 16),
      },
    };
  });
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const s = g.scheduler.stats();
    return s.genInflight === 0 && s.meshInflight === 0 && s.meshQueued === 0 &&
      s.pendingMesh === 0 && s.lightInflight === 0 && s.lightQueued === 0 &&
      s.uploadQueue === 0 && g.weaponDebugState().activeTracers === 0;
  }, null, { timeout: 60_000 });
  const settled = await page.evaluate(({ cx, sy, cz, objectCountBefore }) => {
    const g = window.__MC_GAME__;
    return {
      scheduler: g.scheduler.stats(),
      columnVersion: g.world.getColumn(cx, cz).version,
      publishedVersion: g.renderWorld.getSectionVersion(cx, sy, cz),
      objectCountAfter: { scene: g.scene.children.length, camera: g.camera.children.length },
      objectCountBefore,
      activeTracers: g.weaponDebugState().activeTracers,
    };
  }, { ...run.section, objectCountBefore: run.objectCountBefore });
  expect(run.pistolEffects).toBe(200);
  expect(run.mag7Effects).toBe(20);
  expect(run.pistolAir).toBe(true);
  expect(run.mag7Air).toBe(true);
  expect(run.pistolP95).toBeLessThan(2); // 既有单块编辑冻结口径。
  expect(run.mag7P95).toBeGreaterThanOrEqual(0);
  expect(settled.scheduler.genInflight).toBe(0);
  expect(settled.scheduler.meshInflight).toBe(0);
  expect(settled.scheduler.meshQueued).toBe(0);
  expect(settled.scheduler.pendingMesh).toBe(0);
  expect(settled.scheduler.lightInflight).toBe(0);
  expect(settled.scheduler.lightQueued).toBe(0);
  expect(settled.scheduler.uploadQueue).toBe(0);
  expect(settled.publishedVersion).toBe(settled.columnVersion);
  expect(settled.activeTracers).toBe(0);
  expect(settled.objectCountAfter).toEqual(settled.objectCountBefore);
});
```

- [ ] **Step 2: 运行 RED 验证**

```bash
npm test -- tests/weapons-performance.spec.mjs tests/weapons-world-edit.spec.mjs
```

Expected: 在 Task 6 前因 API 缺失而失败；Task 6 完成后仍会因 `scheduler.stats()` 尚无新队列字段或 `renderWorld.getSectionVersion()` 不存在而失败。若接口齐全但性能不达标，保留真实测量结果并停止，不放宽阈值。

- [ ] **Step 3: 以最小只读诊断接口转 GREEN**

在 `Scheduler.stats()` 保留既有 `inflight`，并追加下列字段；它们只读取已有容器的 `size`/`length`：

```js
stats() {
  return {
    inflight: this._inflightGen.size,
    genInflight: this._inflightGen.size,
    ready: this.world.columns.size,
    meshInflight: this._inflightMesh.size,
    meshQueued: this._meshQueue.length,
    pendingMesh: this._pendingMesh.size,
    uploadQueue: this._uploadQueue.length,
    sections: this._meshedSections.size,
    lightInflight: this._inflightLight.size,
    lightQueued: this._lightQueue.size,
  };
}
```

在 `RenderWorld` 构造器创建 `this._sectionVersions = new Map()`，key 固定为 ``${cx},${sy},${cz}``。`uploadSection(cx, sy, cz, channel, geomData, version)` 在处理零顶点删除和正常上传前写入当前 section 的 `version`；`removeSection(cx, sy, cz)` 在删完三个 channel 后删掉该 key；新增如下只读 getter。该 map 只记录已通过 Scheduler 版本检查的渲染发布版本，不是体素副本，也不能由游戏逻辑读取后作写入决定。

```js
getSectionVersion(cx, sy, cz) {
  return this._sectionVersions.get(`${cx},${sy},${cz}`);
}
```

重新运行 Step 2 的两个 spec。通过表示：200 次普通枪和 20 次 MAG7 的真实编辑路径在队列清空后，目标 section 已发布版本等于权威 column 版本；这覆盖 `_onMeshResult()` 与 `_processUploadQueue()` 的过期结果丢弃协议，而不是只凭代码注释声称它存在。

- [ ] **Step 4: 只针对测得根因优化，并保留 M3 基线**

先记录 `before`/`after` 的 fps、p95、drawCalls、普通枪/MAG7 world-edit p95、tracer 数、scene/camera child 数和 scheduler stats。若 draw 高于 +2，检查 minigun 是否只有一个 primitive、`TracerRenderer` 是否只发布一个 InstancedMesh，禁止回退为每 tracer 一个 mesh；若 active tracer 超限或 child 数增长，修复最旧 slot 回收或不受控的模型/音频节点创建；若 light/mesh 不收敛或发布版本不等，检查 Task 2 的 `affected` 去重、`enqueueLight` 调用与既有 Scheduler 版本丢弃分支。不要为通过性能测试降低视距、减少 M3 的加载集合、修改 M3 冻结阈值或把 Worker 工作放回主线程。

将 README 的运行说明补充：`npm run validate:weapon-assets`、KeyR、左键持续射击/ MAG7 单击、武器方块破坏默认关闭，以及 M4 不支持用户导入模型。

- [ ] **Step 5: 验证完整 M4 门禁**

```bash
npm run validate:weapon-assets
npm test
npm run lint
git diff --check
```

Expected: validator、所有 Playwright spec 和 lint PASS；diff check 无输出。创建 `docs/m4-weapons-acceptance-report.md`，记录日期、设备/浏览器/WebGPU adapter、`before`/`after` 的 fps/p95/drawCalls、普通枪/MAG7 world-edit p95、200/20 次编辑后的队列统计、权威/发布版本比对、scene/camera child 计数、命令输出摘要及相对 M3 基线的百分比；性能回退超过 10% 时停止，不创建通过结论。将规格状态改为 `**状态：** 已实施，验收报告：docs/m4-weapons-acceptance-report.md`，并在本计划 Task 1–7 标题后补充实际测试命令与测得的 fps/draw 值，不改任何冻结数字。

- [ ] **Step 6: 在获明确授权后提交验收任务**

```bash
git add src/core/scheduler.js src/render/render-world.js \
  tests/weapons-performance.spec.mjs tests/weapons-world-edit.spec.mjs \
  docs/m4-weapons-acceptance-report.md README.md \
  docs/superpowers/specs/2026-08-23-m4-player-weapons-design.md \
  docs/superpowers/plans/2026-08-23-m4-player-weapons.md
git commit -m "test: add M4 weapon acceptance coverage"
```

只有用户明确要求提交时执行本步骤。

## 计划自检

- 规格 §1/§2 的里程碑边界由 Task 1 固化；没有 M2/M3 重编号。
- 规格 §3/§4.1 的批量版本、edits、光照、事件、基岩语义由 Task 2 实现并回归测试。
- 规格 §3/§4.2 的 DDA、MAG7 扫描、开关豁免、40 候选、end_stone/创造台/水语义和单发模式由 Task 3 覆盖。
- 规格 §4.3/§4.4 的本地 GLB、音频、AudioContext、模型 transform、YXZ、32 曳光和测试 API 分别由 Tasks 4–6 覆盖。
- 规格 §6 的 WebGPU、性能、队列收敛、资源释放和全量验证由 Tasks 5–7 覆盖；Task 7 单独覆盖 200 次普通枪和 20 次 MAG7 的真实世界写入、权威/发布版本一致性及无 three 节点增长。
- 已扫描本计划，不含未决占位标记、未定义接口或跨任务省略实现步骤。
