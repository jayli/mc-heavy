# M5 实体运行时 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不创建具体玩法实体的前提下，交付可查询、可卸载、可渲染及可持久化的动态实体运行时。

**Architecture:** `EntityManager` 独占动态 state，column 索引、generation 和 render slot 全部是派生缓存；
`EntityRenderLayer` 只读取 pose。Scheduler 先发起可取消的异步 column 卸载准备，持久实体冻结并保存最小
JSON snapshot，下一帧才同步提交最终卸载；方块锚定状态仍归 `blockEntities`。

**Tech Stack:** ES2022 ESM、JSDoc、three.js r185.1 WebGPU、IndexedDB、Playwright。

**Spec:** `docs/superpowers/specs/2026-08-23-m5-entity-runtime-design.md`

## Global Constraints

- 依赖已验收的 M4；不改 M2/M3 冻结基线、DDA 地形命中或 `blocks + meta + blockEntities` 唯一权威。
- `src/entities/` 仅含可测试的 plain state；three 只能在 `src/render/`，不得新增 Worker。
- 地形碰撞只读 `world.isSolid()`；地形射线仍为 DDA，实体命中只由纯 AABB raycast 计算。
- 临时实体只在 Scheduler 最终卸载其所在 column 前回收；不可另设玩家距离销毁阈值。
- Scheduler 的 pending unload 仅是 key/handle 生命周期状态，不能复制体素数据；持久 snapshot 写入失败或玩家重入
  加载半径时，必须取消卸载、解冻实体并保留 world/render column。
- 每次先 RED、确认失败、再 GREEN；每个任务的提交均须先获得用户明确授权。

---

## 文件责任图

```text
src/entities/entity-manager.js          Entity Map、generation、派生 column 索引、AABB raycast
src/entities/entity-types.js            无 three 的 probe 类型和 state 校验 helper
src/render/entity-render-layer.js       只读实体 pose 到受控 scene node/instance
src/save/persistence.js                 DB v2 entities store 及持久 snapshot 读写
src/core/scheduler.js                   可取消卸载请求、pending handle、同步最终移除通知
src/core/game.js                        manager/layer 生命周期、持久保存/恢复、__MC_GAME__ 测试入口
src/tests/test-entity-manager.js        无 DOM 的 manager、generation、卸载单测
tests/entities.spec.mjs                 浏览器集成、IDB 重载、scene 对称和稳态性能
docs/m5-entity-runtime-acceptance-report.md  验收数据和回归结论
```

### Task 1: 纯 EntityManager、generation 与临时 column 生命周期

**Files:**

- Create: `src/entities/entity-manager.js`, `src/entities/entity-types.js`, `src/tests/test-entity-manager.js`
- Modify: `src/tests/index.html`
- Test: `tests/harness.spec.mjs`

**Interfaces:**

```js
const entity = manager.spawn({ id, type, state, persistent: false }); // Entity | null
manager.get(id);                 // Readonly<Entity> | null
manager.count(type);             // number
manager.entities();              // Iterable<Readonly<Entity>>，仅 render layer 枚举
manager.entitiesInColumn(key);   // Iterable<Readonly<Entity>>，卸载协调只读查询
manager.despawn(id, reason);     // boolean
manager.despawnColumn('0,0', 'column-unloaded');
manager.applyAsyncPose({ id, generation, position }); // boolean；过期返回 false
manager.raycast([0, 1, 0], [0, 0, -1], 40, (entity) => entity.type === 'probe');
// null | {id, type, dist, point}
```

- [ ] **Step 1: 写入失败的浏览器内单测**

  在 `test-entity-manager.js` 注册无 three 的 `probe` type：位置为 `[x,y,z]`，AABB 为
  `[-.3,0,-.3]..[.3,1.8,.3]`。测试必须同时覆盖重复 id、最近 AABB 命中、卸载和迟到回包：

  ```js
  test('EntityManager: 唯一 id、最近 AABB 和 column 卸载', () => {
    const m = makeProbeManager();
    assertTrue(m.spawn({ id: 'near', type: 'probe', state: { position: [0, 0, -3] } }) !== null);
    assertEqual(m.spawn({ id: 'near', type: 'probe', state: { position: [0, 0, -4] } }), null);
    assertTrue(m.spawn({ id: 'far', type: 'probe', state: { position: [0, 0, -6] } }) !== null);
    assertEqual(m.raycast([0, 1, 0], [0, 0, -1], 40).id, 'near');
    assertEqual(m.despawnColumn('0,-1', 'column-unloaded'), 2);
    assertEqual(m.count('probe'), 0);
  });

  test('EntityManager: generation 拒绝已销毁 id 的迟到结果', () => {
    const m = makeProbeManager();
    const first = m.spawn({ id: 'same', type: 'probe', state: { position: [0, 0, 0] } });
    m.despawn('same', 'test');
    const second = m.spawn({ id: 'same', type: 'probe', state: { position: [1, 0, 0] } });
    assertTrue(second.generation > first.generation);
    assertFalse(m.applyAsyncPose({ id: 'same', generation: first.generation, position: [9, 0, 0] }));
    assertDeepEqual(m.get('same').state.position, [1, 0, 0]);
  });
  ```

  在 `src/tests/index.html` 的 `runAndExpose()` 前静态 import 该文件，使 harness 能消费它。

- [ ] **Step 2: 验证 RED**

  Run: `npx playwright test tests/harness.spec.mjs`
  Expected: FAIL，因 `entity-manager.js` 尚不存在或 `makeProbeManager` 无法导入；不是“0 个新测试”。

- [ ] **Step 3: 实现最小纯运行时**

  `EntityManager` 用 `Map<id, Entity>` 保存唯一 state，另以 `Map<columnKey, Set<id>>` 作为位置派生索引。
  spawn 仅在 type 已注册、id 不重复且 `definition.create(state)` 返回合法 state 时成功；同 id 的 generation
  计数不在 despawn 后重置。每次 `update()` 后重新定位发生跨 column 的实体；`despawnColumn()` 只 despawn
  `persistent === false` 实体并返回回收数。`raycast()` 对候选 type 调 `raycastAabb()`，返回最小 `dist >= 0`
  且 `dist <= maxDist` 的命中；不读 three 或 world mesh。

- [ ] **Step 4: 验证 GREEN 与静态边界**

  Run: `npx playwright test tests/harness.spec.mjs && npm run lint`
  Expected: 新的四项断言和既有 harness 全绿，lint 0 error；`rg -n "from 'three'|new Worker" src/entities`
  无匹配。

- [ ] **Step 5: 准备任务提交（仅获授权后执行）**

  ```bash
  git add src/entities/entity-manager.js src/entities/entity-types.js \
    src/tests/test-entity-manager.js src/tests/index.html
  git commit -m "feat(entities): add pure entity manager"
  ```

### Task 2: 持久实体 snapshot 与可取消的两阶段 Scheduler 卸载

**Files:**

- Modify: `src/save/persistence.js`, `src/core/scheduler.js`, `src/core/game.js`, `src/entities/entity-manager.js`, `src/tests/test-entity-manager.js`
- Test: `tests/entities.spec.mjs`, `tests/harness.spec.mjs`

**Interfaces:**

```js
persistence.saveEntities([{ id, type, state }]); // Promise<void>
persistence.loadEntities();                      // Promise<Array<{id,type,state}>>
persistence.flushEntities();                     // Promise<void>；测试/页面隐藏立即保存
scheduler.onColumnUnloadRequested((key, column) => ({
  ready: Promise.resolve(), // reject 时取消本次卸载
  commit() {},              // ready 成功且下一帧仍在半径外时同步调用
  cancel() {},              // 玩家重入或 ready reject 时调用
})); // unsubscribe function
scheduler.onColumnWillRemove((key, column) => {}); // 最终移除前同步通知；返回值不等待
manager.beginColumnUnload(key); // { snapshots, commit(): number, cancel(): void }
scheduler.stats().pendingUnloads; // number，只读诊断
scheduler.stats().lastUnloadError; // string | null，只读诊断
manager.serializePersistent();
manager.restorePersistent(snapshots);             // { restored, skipped }
```

- [ ] **Step 1: 写入失败测试**

  在纯测试中为一个 `persistent: true` probe 调 `serializePersistent()`，确认临时 probe 不出现；再以一个
  未注册 type 和一个非法 state 混入恢复数组，断言只恢复有效条目。浏览器集成 spec 使用独立 seed/IDB 清理，
  先创建位于 `0,0` 的持久和临时 probe、执行 `await game.persistence.flushEntities()`，重载页面后返回：

  ```js
  expect(result).toEqual({ persistent: true, temporary: false, restoredExactlyOnce: true });
  ```

  在 `tests/entities.spec.mjs` 的 Scheduler fixture 加一个可控的 `saveEntities` gate；fixture 固定
  `viewDistance: 1`、预先接管 ready 的 `0,0` column，并以 `scheduler.update(playerX, playerZ)` 驱动。
  `world.hasColumn(0, 0)`、`game.entities.get(id)` 和 `game.persistence.loadEntities()` 是唯一断言读口，
  用它验证异步保存绝不在同帧越过删除边界：

  ```js
  const events = [];
  let resolveSave;
  const saveGate = new Promise((resolve) => { resolveSave = resolve; });
  game.persistence.saveEntities = async (snapshots) => {
    events.push(['save', snapshots.map(({ id }) => id)]);
    await saveGate;
  };
  game.scheduler.onColumnWillRemove((key) => {
    events.push(['will-remove', key, game.world.hasColumn(0, 0)]);
  });

  game.entities.spawn({ id: 'persistent', type: 'probe', persistent: true, state: { position: [.5, 1, .5] } });
  game.entities.spawn({ id: 'temporary', type: 'probe', persistent: false, state: { position: [1.5, 1, .5] } });
  game.scheduler.update(16 * 8, 0); // viewDistance=1 时，0,0 已超过 R+2。
  expect(game.world.hasColumn(0, 0)).toBe(true);
  expect(game.entities.get('persistent')).not.toBeNull();
  expect(game.entities.get('temporary')).not.toBeNull();
  expect(events).toEqual([['save', ['persistent']]]);

  resolveSave();
  await Promise.resolve();
  game.scheduler.update(16 * 8, 0); // ready 成功后的下一帧才最终移除。
  expect(events).toContainEqual(['will-remove', '0,0', true]);
  expect(game.world.hasColumn(0, 0)).toBe(false);
  expect(game.entities.get('persistent')).toBeNull();
  expect(game.entities.get('temporary')).toBeNull();
  ```

  以两个独立 fixture 覆盖取消和失败；不要把 re-entry 与 reject 混在同一个 pending handle：

  ```js
  // A. 保存尚未结束时重入：cancel 后不能最终删除。
  let resolveReentry;
  game.persistence.saveEntities = () => new Promise((resolve) => { resolveReentry = resolve; });
  game.scheduler.update(16 * 8, 0);
  expect(game.scheduler.stats().pendingUnloads).toBe(1);
  game.scheduler.update(0, 0);
  expect(game.scheduler.stats().pendingUnloads).toBe(0);
  expect(game.world.hasColumn(0, 0)).toBe(true);
  expect(game.entities.get('persistent')).not.toBeNull();
  resolveReentry(); // 已完成的旧写入允许存在；后续状态保存会覆盖。

  // B. 写盘失败：reject 后同样保留 column 和冻结前的运行时实体。
  let rejectSave;
  game.persistence.saveEntities = () => new Promise((_, reject) => { rejectSave = reject; });
  game.scheduler.update(16 * 8, 0);
  rejectSave(new Error('IDB write failed'));
  await Promise.resolve();
  expect(game.scheduler.stats().pendingUnloads).toBe(0);
  expect(game.scheduler.stats().lastUnloadError).toContain('0,0');
  expect(game.world.hasColumn(0, 0)).toBe(true);
  expect(game.entities.get('persistent')).not.toBeNull();
  ```

  最终把已成功最终卸载的 column 再移入加载半径，断言持久 probe 恰恢复一次、临时 probe 不恢复。为支持该
  确定性测试，Task 2 在 `Scheduler.stats()` 增加只读 `pendingUnloads` 与
  `lastUnloadError`；二者只观测 `_pendingColumnUnloads`/最近错误，不能驱动调度决策。

- [ ] **Step 2: 验证 RED**

  Run: `npx playwright test tests/entities.spec.mjs tests/harness.spec.mjs`
  Expected: FAIL，`entities` store、两阶段卸载 API 或恢复 API 未定义；不能因同步删除 column 而误绿。

- [ ] **Step 3: 升级 DB，并在保存成功后同步提交最终卸载**

  将 `DB_VERSION` 升为 2，`onupgradeneeded` 中仅在不存在时创建 `entities` store（keyPath 为 `id`）。
  `saveEntities()` 覆盖当前 persistent snapshot，`loadEntities()` 返回 [] 而不是 null；持久实体状态变化和
  `visibilitychange` 触发保存。Scheduler 新增 `_pendingColumnUnloads: Map<key,{column,handles,ready}>` 和
  `onColumnUnloadRequested()`：column 首次超过 `R+2` 时调用每个 listener 一次并保留 world/render column；
  任何 `ready` reject 都调用所有 handle 的 `cancel()`、删除 pending 记录、记录 `lastUnloadError`，不调用
  `world.remove()`。每帧先取消已回到 `R+2` 内的 pending entry；所有 ready 成功后也必须到**下一帧**并再次确认
  距离仍超界，才依次同步调用 `onColumnWillRemove`、各 handle `commit()`、`world.remove(key)`、
  `renderWorld.removeColumn()` 和 `_cleanupColumn()`。`onColumnWillRemove` 不接受 Promise，因而没有异步删除竞态。

  Game 的 requested listener 调 `entities.beginColumnUnload(key)`：它从派生 column 索引找候选，冻结其中的
  persistent entity、生成 `snapshots`，并返回 `{ ready: persistence.saveEntities(snapshots), commit, cancel }`。
  `commit()` 先失效 generation，再回收冻结的 persistent entity 和该 column 内仍在的临时 entity；`cancel()`
  解冻而不复制 state。`onColumnReady` 以 snapshot 的 `state.position` 过滤同一 column，调用
  `restorePersistent()`；已存在 id 跳过，故不会重复恢复。

- [ ] **Step 4: 验证 GREEN**

  Run: `npx playwright test tests/entities.spec.mjs tests/harness.spec.mjs && npm run lint`
  Expected: DB v2 首次打开/旧库升级、保存 gate 期间 world/render 未删除、重入/失败均取消且解冻、临时不恢复、
  持久只恢复一次、最终卸载顺序均 PASS。

- [ ] **Step 5: 准备任务提交（仅获授权后执行）**

  ```bash
  git add src/save/persistence.js src/core/scheduler.js src/core/game.js src/entities/entity-manager.js \
    src/tests/test-entity-manager.js tests/entities.spec.mjs
  git commit -m "feat(entities): persist durable entities across streaming"
  ```

### Task 3: 受控渲染层、Game 装配与可测试入口

**Files:**

- Create: `src/render/entity-render-layer.js`, `tests/entities.spec.mjs`
- Modify: `src/core/game.js`, `src/entities/entity-manager.js`

**Interfaces:**

```js
layer.register('probe', { createNode, applyPose, disposeNode });
layer.sync(manager.entities());
layer.activeCount('probe');
layer.dispose();
window.__MC_GAME__.entities; // manager；仅测试访问
window.__MC_GAME__.entityLayer; // layer；仅测试访问
```

- [ ] **Step 1: 写失败的浏览器集成断言**

  ```js
  test('M5: render node 与 EntityManager 生命周期对称', async ({ page }) => {
    await page.goto('/?vd=2');
    await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true);
    const result = await page.evaluate(() => {
      const g = window.__MC_GAME__;
      g.entities.spawn({ id: 'render-probe', type: 'probe', state: { position: [2, 2, 2] } });
      g.entities.update(1 / 60, { world: g.world });
      g.entityLayer.sync(g.entities.entities());
      const during = g.entityLayer.activeCount('probe');
      g.entities.despawn('render-probe', 'test');
      g.entityLayer.sync(g.entities.entities());
      return { during, after: g.entityLayer.activeCount('probe') };
    });
    expect(result).toEqual({ during: 1, after: 0 });
  });
  ```

  同一 spec 追加独立的视距 8 稳态 case；它不复用上例的 `?vd=2` 页面，也不从 loading 期采样：

  ```js
  test('M5: 视距 8 的实体运行时在队列收敛后保持对称', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/?vd=8');
    await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
    await page.waitForFunction(() => window.__MC_GAME__.world.columns.size >= 289, null, { timeout: 90_000 });
    await page.waitForFunction(() => {
      const s = window.__MC_GAME__.scheduler.stats();
      return s.genInflight === 0 && s.meshInflight === 0 && s.meshQueued === 0 &&
        s.pendingMesh === 0 && s.lightInflight === 0 && s.lightQueued === 0 && s.uploadQueue === 0;
    }, null, { timeout: 60_000 });
    await page.waitForTimeout(5_000);
    const settled = await page.evaluate(() => ({
      scheduler: window.__MC_GAME__.scheduler.stats(),
      active: window.__MC_GAME__.entityLayer.activeCount('probe'),
    }));
    expect(settled.active).toBe(0);
    expect(settled.scheduler).toMatchObject({
      genInflight: 0, meshInflight: 0, meshQueued: 0, pendingMesh: 0,
      lightInflight: 0, lightQueued: 0, uploadQueue: 0,
    });
  });
  ```

- [ ] **Step 2: 验证 RED**

  Run: `npx playwright test tests/entities.spec.mjs`
  Expected: FAIL，`game.entities`、`entityLayer` 或 `sync()` 未定义。

- [ ] **Step 3: 实现只读 pose 发布**

  layer 只为当前 EntityManager 集合创建/更新/销毁 node；不得由 node 回写 state。Game 的每帧顺序固定为
  `player.update → entities.update → scheduler.update → entityLayer.sync → render`，`dispose()` 反向释放
  layer、manager、WorkerPool 和 renderer。Probe 的 node 是单个受控 `THREE.Group`，仅本任务作 render
  contract fixture；未来丧尸会改用自己的实例渲染器，不复用 per-entity Group。

- [ ] **Step 4: 验证 GREEN、scene 对称与稳态**

  Run: `npx playwright test tests/entities.spec.mjs && npm run lint`
  Expected: spawn/despawn/`dispose()` 后 active node 数对称；上一步新增的视距 8 case 必须完整等待：

  ```js
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => window.__MC_GAME__.world.columns.size >= 289, null, { timeout: 90_000 });
  await page.waitForFunction(() => {
    const s = window.__MC_GAME__.scheduler.stats();
    return s.genInflight === 0 && s.meshInflight === 0 && s.meshQueued === 0 &&
      s.pendingMesh === 0 && s.lightInflight === 0 && s.lightQueued === 0 && s.uploadQueue === 0;
  }, null, { timeout: 60_000 });
  await page.waitForTimeout(5_000);
  ```

  然后报告相对 M3 的 fps/draw 回退不超过 10%；采样后的同七个字段仍全为 0。

- [ ] **Step 5: 准备任务提交（仅获授权后执行）**

  ```bash
  git add src/render/entity-render-layer.js src/core/game.js src/entities/entity-manager.js \
    tests/entities.spec.mjs
  git commit -m "feat(entities): render managed entity poses"
  ```

### Task 4: M5 验收、文档回填与全局门禁

**Files:**

- Create: `docs/m5-entity-runtime-acceptance-report.md`
- Modify: `docs/superpowers/specs/2026-08-23-m5-entity-runtime-design.md`, `docs/superpowers/plans/2026-08-23-m5-entity-runtime.md`, `docs/superpowers/plans/2026-08-20-phase1-remaining-roadmap.md`, `docs/phase-1-engine-design.md`, `AGENTS.md`, `README.md`

- [ ] **Step 1: 运行完整门禁并记录原始数据**

  Run: `npm test && npm run lint && git diff --check`
  Expected: 三条命令退出 0。报告必须列出设备/WebGPU 后端、probe AABB 命中、临时/持久 reload、generation
  丢弃、卸载顺序、scene active count、稳态 fps/draw 与 M3 对照；不得只写“通过”。

- [ ] **Step 2: 回填状态和依赖**

  仅在所有门禁通过后，把 M5 规格状态改为“已实施、已验收”，roadmap/AGENTS/README 的 M5 改为完成，
  并把 M6 的前置条件标为“可开始”。若任何冻结指标未达标，只在报告记录阻断原因，所有路线图状态保持未完成。

- [ ] **Step 3: 准备验收提交（仅获授权后执行）**

  ```bash
  git add docs/m5-entity-runtime-acceptance-report.md \
    docs/superpowers/specs/2026-08-23-m5-entity-runtime-design.md \
    docs/superpowers/plans/2026-08-23-m5-entity-runtime.md \
    docs/superpowers/plans/2026-08-20-phase1-remaining-roadmap.md \
    docs/phase-1-engine-design.md AGENTS.md README.md
  git commit -m "docs: record m5 entity runtime acceptance"
  ```

## 计划自检

- Task 1 覆盖唯一权威、AABB、column 索引与 generation；Task 2 覆盖 DB v2、可取消异步保存、失败/重入
  取消与同步最终卸载；Task 3 覆盖渲染隔离、游戏装配和与 M4 一致的七项队列收敛；Task 4 覆盖性能、验收
  和全局文档回填。
- 本计划未创建具体敌人、投射物、矿车或额外 Worker；M6 才消费 manager 的实体命中与 AI 扩展点。
