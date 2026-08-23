# M7 玩家放置丧尸巢穴 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付玩家可放置、全局至多 8 个、关键顶端方块被破坏即失效，并按 mc-lite 参数定时刷怪的丧尸巢穴。

**Architecture:** 只读 JSON 蓝图经一次 `WorldEditor.setBlocks()` 写入；最高 `gold_block` 的
`blockEntity` 是唯一持久真相。`ZombieNestController` 只在 anchor column 已加载时存在，订阅 M4 的
`block-changed` 增量；`zombie_nest_alias_block` 只由最小创造模式选择入口触发，永不写入蓝图。

**Tech Stack:** ES2022 ESM、JSDoc、WorldEditor、blockEntities、IndexedDB、M4 AudioManager、Playwright。

**Spec:** `docs/superpowers/specs/2026-08-23-m7-zombie-nests-design.md`

## Global Constraints

- 依赖 M4、M5、M6；不修改 `StructureIndex` 或已验收的 M2 地标生成，巢穴不是世界生成地标。
- 所有方块/锚点写入、回滚和破坏均经 `WorldEditor`；禁止 ShadowStore、mesh 轮询、方块副本和专属 Worker。
- 纯 blockEntity 更新仍记入 `column.edits`，但不 bump version、不触发 remesh/light；Worker 不传对象 Map。
- 默认 M6 上限为 20；8 巢穴/30 丧尸仅为明确标注的中档压力 fixture，M7 不实现设置 UI。
- M7 不实现完整背包、Hotbar 扩展或 TNT；只提供受控创造模式选择和 TNT 等价批量编辑验收。
- 先 RED 后 GREEN；每个提交都必须等用户明确授权。

---

## 文件责任图

```text
src/entities/zombie-nests/nest-blueprint.js          JSON 读取、坐标展开、唯一关键格校验
src/entities/zombie-nests/zombie-nest-service.js     全局索引、预检、原子放置、hydrate/destroy
src/entities/zombie-nests/zombie-nest-controller.js  增量失效、8 秒出生搜索、column 生命周期
src/core/world-editor.js                              blockEntity 随 setBlock/setBlocks 的唯一事务写入
src/voxel/chunk-column.js                             restoreEdits：blocks/meta/entities/edits 一起恢复
src/voxel/world-data.js                               blockEntity accessor 与方块改写时清理规则
src/core/scheduler.js                                 GEN 接管时 restoreEdits、M5 生命周期 callback
src/save/persistence.js                               含 blockEntity 的 edits 序列化和 anchor cursor 枚举
src/player/player.js                                  selectPlaceable 与 alias 右键放置分流
src/core/game.js                                      nests hydrate、加载/卸载装配、测试 API
assets/sounds/put.mp3                                从 mc-lite 复制的受控放置音效
src/tests/test-zombie-nests.js                        蓝图、持久化、spawn 搜索及事件逻辑单测
tests/zombie-nests.spec.mjs                           浏览器事务、reload、TNT 等价和压力验收
docs/m7-zombie-nests-acceptance-report.md            验收和持久化回归数据
```

### Task 1: `blockEntities` edits、GEN 接管重放和持久化回归

**Files:**

- Modify: `src/voxel/chunk-column.js`, `src/voxel/world-data.js`, `src/core/world-editor.js`, `src/core/scheduler.js`, `src/save/persistence.js`, `src/tests/test-chunk-column.js`
- Create: `src/tests/test-zombie-nests.js`, `tests/zombie-nests.spec.mjs`
- Modify: `src/tests/index.html`

**Interfaces:**

```js
column.restoreEdits([{ index, id, meta, blockEntity? }]);
world.getBlockEntity(x, y, z); // object | null
editor.setBlockEntity({ x, y, z, value }); // EditReport；value=null 删除
editor.setBlocks([{ x, y, z, id, meta, blockEntity? }]);
persistence.listBlockEntities('zombie-nest'); // Promise<Array<{columnKey,index,blockEntity}>>
```

- [ ] **Step 1: 写入失败的重放/覆盖存档测试**

  在 `test-chunk-column.js` 增加 `restoreEdits()` 单测：预置一个普通 stone edit 和一个 `gold_block`
  anchor edit，调用后断言 `blocks/meta`、`column.edits.size===2` 和 `column.blockEntities.get(index)` 均存在，
  `version===0`。再用 `WorldData.setBlock()` 覆盖 anchor 格且不带 `blockEntity`，断言该格的 entity 被删除；
  以同一 change 带新的 `blockEntity` 时断言保留替换值。

  在新的 `test-zombie-nests.js` 写完整的持久化回归 fixture：

  ```js
  test('GEN 接管后 restoreEdits 保留旧 edits 与 anchor，下一次 flush 不覆盖', async () => {
    const key = '0,0';
    const edits = [
      { index: blockIndex(1, 1, 1), id: stoneId, meta: 0 },
      { index: blockIndex(2, 5, 2), id: goldId, meta: 0,
        blockEntity: { kind: 'zombie-nest', id: 'nest-a', origin: [2, 0, 2], critical: { x: 2, y: 5, z: 2, id: goldId }, lastSpawnAt: 0 } },
    ];
    persistence.editsCache.set(key, edits);
    scheduler._onGenResult(key, generatedColumnResult(key));
    const col = world.getColumn(0, 0);
    world.setBlock(3, 1, 3, dirtId); // 模拟后来编辑
    await persistence.flushNow(world);
    const saved = await persistence.loadColumnEdits(key);
    assertEqual(saved.length, 3);
    assertEqual(saved.find((e) => e.index === edits[1].index).blockEntity.kind, 'zombie-nest');
  });
  ```

  `generatedColumnResult` 必须构造与 Scheduler worker 回包同形的 `blocks/meta/light` ArrayBuffer；此测试直接覆盖
  真实 `_onGenResult` 接管路径，不能仅测 `ChunkColumn` 的孤立 Map。将新文件静态 import 到 harness。

- [ ] **Step 2: 验证 RED**

  Run: `npx playwright test tests/harness.spec.mjs`
  Expected: FAIL，`restoreEdits`、blockEntity 序列化或 Scheduler 重建逻辑尚不存在。

- [ ] **Step 3: 实现唯一 edits 路径**

  `ChunkColumn.restoreEdits(edits)` 逐项恢复 typed `blocks/meta`、`blockEntities` 和 `edits` Map，但不 bump
  version/dirty；保留旧 `applyEdits` 仅给无状态 legacy 调用，Scheduler 改为只用 `restoreEdits(this.getEdits(key))`
  接管 Worker GEN 结果。Persistence 写入时每个 edit 为 `{index,id,meta,blockEntity?}`，`flushNow()` 不能丢掉
  entity 字段；`listBlockEntities(kind)` 用 IndexedDB `edits` cursor 扫描 entry，返回匹配 `blockEntity.kind` 的
  `{columnKey,index,blockEntity}`。

  `WorldData` 提供坐标到 column/index 的 `getBlockEntity()`；WorldEditor 的 `setBlockEntity()` 只改该格
  `blockEntities` 和对应 `edits` entry、调用 `persistence.scheduleFlush(world)`，不 remesh/light/version。
  `setBlock/setBlocks` 改写方块时默认清除该 index 的旧 entity，只有同一 raw change 含 `blockEntity` 才在
  新 id 写入后保存。所有路径返回一份 `EditReport`，事件的 `changes` 也带 `oldBlockEntity/newBlockEntity`，
  但不保存 event log。

- [ ] **Step 4: 验证 GREEN 与不向 Worker 泄露对象**

  Run: `npx playwright test tests/harness.spec.mjs && npm run lint`
  Expected: 新旧 edits、anchor 和后续 edit 在 flush/reload 后均存在，纯 entity 写不 bump version/remesh。
  Run: `rg -n "blockEntities|restoreEdits" src/workers`
  Expected: 无匹配；Worker 仍只处理 typed buffer。

- [ ] **Step 5: 准备任务提交（仅获授权后执行）**

  ```bash
  git add src/voxel/chunk-column.js src/voxel/world-data.js src/core/world-editor.js \
    src/core/scheduler.js src/save/persistence.js src/tests/test-chunk-column.js \
    src/tests/test-zombie-nests.js src/tests/index.html tests/zombie-nests.spec.mjs
  git commit -m "fix(save): restore block entity edits after generation"
  ```

### Task 2: 蓝图校验、一次事务放置、最小创造模式入口与音频

**Files:**

- Create: `src/entities/zombie-nests/nest-blueprint.js`, `src/entities/zombie-nests/zombie-nest-service.js`
- Modify: `src/player/player.js`, `src/core/game.js`, `src/core/world-editor.js`, `src/tests/test-zombie-nests.js`, `tests/zombie-nests.spec.mjs`, `src/tests/index.html`
- Create: `assets/sounds/put.mp3`

**Interfaces:**

```js
const blueprint = loadNestBlueprint(registry); // { changesAt(origin), criticalAt(origin), boundsAt(origin) }
nests.place({ origin, playerAabb });
// {ok:true,id,anchor:[x,y,z]} | {ok:false,reason:'limit'|'bounds'|'occupied'|'player-overlap'|'invalid-blueprint'}
player.selectPlaceable('zombie_nest_alias_block'); // boolean；受控创造模式入口
game.selectPlaceable(id);                           // 同上，供 Playwright 调用
game.audioDebugState();                             // {playRequests:{put:number,...}}；只读测试钩子
```

- [ ] **Step 1: 写失败测试**

  纯测试读取实际 `assets/structures/zombie_nest.json`，断言展开后恰为 38 项、唯一最高相对坐标为
  `[0,5,0]`、名称为 `gold_block`；若 JSON 有两个最高格或没有 gold，`loadNestBlueprint` 抛出
  `invalid-blueprint`。用记录调用的 fake editor 和全局 index fixture 写下列事务测试：

  ```js
  test('ZombieNestService: 第九个、碰撞和玩家重叠均零写入', () => {
    const { nests, editor, playerAabb } = makeNestFixture();
    for (let i = 0; i < 8; i++) assertTrue(nests.place({ origin: [i * 12, 0, 0], playerAabb: null }).ok);
    const before = editor.calls.length;
    assertEqual(nests.place({ origin: [100, 0, 0], playerAabb: null }).reason, 'limit');
    assertEqual(nests.place({ origin: [0, 0, 0], playerAabb: null }).reason, 'occupied');
    assertEqual(nests.place({ origin: [120, 0, 0], playerAabb }).reason, 'player-overlap');
    assertEqual(editor.calls.length, before);
  });
  ```

  成功放置必须断言 `editor.setBlocks` 只调用一次、changes 中没有 `zombie_nest_alias_block`，且 anchor change
  含 `{kind:'zombie-nest', id, origin, critical, lastSpawnAt}`。浏览器 spec 调 `game.selectPlaceable(alias)`，
  用 Player 的 DDA `prevPos` 右键路径放置；确认普通五格 hotbar index 没改变、`game.audioDebugState().playRequests.put`
  增加一次。不存在 alias 时 `selectPlaceable` 返回 false 且不写世界。

- [ ] **Step 2: 验证 RED**

  Run: `npx playwright test tests/zombie-nests.spec.mjs tests/harness.spec.mjs`
  Expected: FAIL，blueprint/service/创造模式入口或 put 音效未定义。

- [ ] **Step 3: 实现预检后的一次 WorldEditor 事务**

  blueprint loader 用 registry `idOf()` 展开 JSON，预先验证唯一最高 `gold_block`。`ZombieNestService.place()` 先
  完成全局索引上限、world 高度/column、所有位置空闲、player AABB 和蓝图校验；任何失败在调用 editor 前
  返回固定 reason。所有预检通过后才构造 38 个 raw changes，并仅在 critical change 附上 blockEntity，调用一次
  `editor.setBlocks(changes)`。根据 report 确认 38 项均有效后写入派生索引与 controller；若 report 不是完整
  成功，视为实现 bug，报告并通过同一 editor 以反向 changes 恢复预检前 id/meta，不创建索引或 controller。

  Player 新增只包含 `zombie_nest_alias_block` 的 `CREATIVE_SPECIALS` 集合和 `selectPlaceable(id)`；不变更
  `HOTBAR`、数字键、HUD 或库存。当 `placeBlock()` 选中 alias 时以 `target.prevPos` 为 origin、现有 physics
  AABB 为 `playerAabb` 调 `nests.place()`，成功后调用 M4 AudioManager 的 `play('put', .6)`；失败保留世界，
  可选地交给 HUD 消息。把 mc-lite `put.mp3` 复制为 `assets/sounds/put.mp3`，在 Game 的既有 AudioManager
  preload manifest 增加 `put`。音频拒绝/加载失败只记诊断，不影响 `place()` 返回成功和 world 事务。

- [ ] **Step 4: 验证 GREEN**

  Run: `npx playwright test tests/zombie-nests.spec.mjs tests/harness.spec.mjs && npm run lint`
  Expected: 38 方块/唯一 anchor、八上限、零写入失败、单次成功事务、alias 不落块、原 Hotbar 不变与 put
  播放请求均 PASS。

- [ ] **Step 5: 准备任务提交（仅获授权后执行）**

  ```bash
  git add src/entities/zombie-nests/nest-blueprint.js src/entities/zombie-nests/zombie-nest-service.js \
    src/player/player.js src/core/game.js src/core/world-editor.js src/tests/test-zombie-nests.js \
    src/tests/index.html tests/zombie-nests.spec.mjs assets/sounds/put.mp3
  git commit -m "feat(zombie-nests): add atomic player placement"
  ```

### Task 3: 事件失效、六层刷怪、column 重建与全局索引

**Files:**

- Create: `src/entities/zombie-nests/zombie-nest-controller.js`
- Modify: `src/entities/zombie-nests/zombie-nest-service.js`, `src/core/game.js`, `src/core/scheduler.js`, `src/entities/zombies/zombie-system.js`, `src/tests/test-zombie-nests.js`, `tests/zombie-nests.spec.mjs`

**Interfaces:**

```js
controller.onWorldChange({ type: 'block-changed', changes });
controller.update(nowMs);
nests.hydrate();
nests.controllers(); // ReadonlyMap<string, ZombieNestController>
nests.destroy(id);   // boolean；删除 anchor/index/controller，不扫描 world
scheduler.onColumnReady((key, column) => {});
scheduler.onColumnWillRemove((key, column) => {});
```

- [ ] **Step 1: 写失败的事件与出生搜索测试**

  用可控 clock 的 fixture 预置 anchor 并创建 controller。`controller.update(7_999)` 必须不 spawn；
  `controller.update(8_000)` 必须首先传入 `[origin.x+.5, origin.y+4, origin.z+3.5]`，即第一个正交 offset
  `{0,3}` 的最高合法层 `dy=3`。依次阻塞脚/头/脚下，断言扫描精确遵循八个 offsets 和 `dy=3..-2` 的六层，
  不是笼统的“半径 3/五层”。`zombies.spawn` 返回 null 时同样断言 anchor 的 `lastSpawnAt===8_000`。

  浏览器测试至少包含三条不同写入来源，但均调同一编辑入口：

  ```js
  const nest = g.nests.place({ origin: legalOrigin(g), playerAabb: null });
  const state = g.world.getBlockEntity(...nest.anchor);
  g.editor.setBlock({ x: state.critical.x, y: state.critical.y, z: state.critical.z, id: 0 }); // 徒手等价
  // 第二次：weapon 选 pistol 且开启方块破坏，瞄准 critical
  // 第三次：g.editor.setBlocks([{x, y, z, id:0}]) // TNT 等价批量变更
  ```

  每条都断言 `{controllers:0, anchor:null, globalCount:7}`，而不是只检查 scene。另预置 Persisted 8 anchors
  后只调 `await nests.hydrate()`，即使没有已加载 controller，第九次 `place()` 也必须返回 `limit`。

- [ ] **Step 2: 验证 RED**

  Run: `npx playwright test tests/zombie-nests.spec.mjs tests/harness.spec.mjs`
  Expected: critical 改写后 controller/anchor 仍存在、spawn 搜索层数错误，或 hydrate 只数已加载 controller。

- [ ] **Step 3: 实现增量 controller 和对称加载生命周期**

  Game 在开放放置前 `await nests.hydrate()`，建立只含 id/anchor 的派生索引。只在
  `scheduler.onColumnReady` 检查该 column 的 `blockEntities` 并创建没有同 id 的 controller；在
  `onColumnWillRemove` 销毁 controller 但不删 anchor/index。全局只订阅一次 `editor.subscribe()`，再把 event
  分派给 `nests.controllers()`；controller 发现 `changes` 覆盖 critical 且 `newId !== critical.id` 时调用
  `nests.destroy(id)`。destroy 用 `editor.setBlockEntity({ ...anchor, value:null })` 删除锚点、从索引与 map
  移除；绝不扫描未加载 column、mesh 或 controller 列表来判定全局数量。

  每 controller 以传入 `nowMs` 判断 `nowMs-lastSpawnAt>=8000`，按固定 offsets 和 `dy=3` 至 `-2` 查
  `world.getBlockId()/isSolid()`，首个合法位置调用 `zombies.spawn([baseX+.5,footY,baseZ+.5], {source:id})`，
  随后不论成功/失败均通过 `editor.setBlockEntity` 持久化同一 `nowMs`。将 M6 的 `ZombieService` mock 和真实
  service 均统一为 `string | null` 返回，不引入 `false` 或未声明的 `firstId()`。

- [ ] **Step 4: 验证 GREEN 与卸载重载**

  Run: `npx playwright test tests/zombie-nests.spec.mjs tests/harness.spec.mjs && npm run lint`
  Expected: 三种破坏来源同义、八精确 offsets/六层、节流、满额更新时钟、未加载的八 anchor 上限和 column
  reload 单 controller 均 PASS。

- [ ] **Step 5: 准备任务提交（仅获授权后执行）**

  ```bash
  git add src/entities/zombie-nests/zombie-nest-controller.js \
    src/entities/zombie-nests/zombie-nest-service.js src/core/game.js src/core/scheduler.js \
    src/entities/zombies/zombie-system.js src/tests/test-zombie-nests.js tests/zombie-nests.spec.mjs
  git commit -m "feat(zombie-nests): spawn and invalidate anchored nests"
  ```

### Task 4: 重启持久化、8 巢穴压力验收与文档回填

**Files:**

- Create: `docs/m7-zombie-nests-acceptance-report.md`
- Modify: `tests/zombie-nests.spec.mjs`, `docs/superpowers/specs/2026-08-23-m7-zombie-nests-design.md`, `docs/superpowers/plans/2026-08-23-m7-zombie-nests.md`, `docs/superpowers/plans/2026-08-20-phase1-remaining-roadmap.md`, `docs/phase-1-engine-design.md`, `AGENTS.md`, `README.md`

- [ ] **Step 1: 写入 reload 与压力等待逻辑**

  浏览器 spec 成功放置一个巢穴、额外编辑该 column 的普通方块、`await g.persistence.flushNow(g.world)` 后 reload；
  等待 `worldReady` 与该 anchor column ready，断言普通 edit、gold anchor、blockEntity 和一个 controller 都恢复。
  再重复一次 reload，controller count 仍为 1。将 8 巢穴/30 丧尸压力段作为独立浏览器 case：先以
  `/?vd=8` 打开页面、等待 `worldReady` 和完整 289 column，再使用 fixture 显式构造 8 个 anchors 与
  `ZombieService({maxActive:30})`。创建 fixture 前必须使用与 M4 相同的完整收敛等待；其刷怪/卸载/重载
  序列完成后，对相同七项字段作逐项零值断言：

  ```js
  await page.goto('/?vd=8');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => window.__MC_GAME__.world.columns.size >= 289, null, { timeout: 90_000 });
  await page.waitForFunction(() => {
    const s = window.__MC_GAME__.scheduler.stats();
    return s.genInflight === 0 && s.meshInflight === 0 && s.meshQueued === 0 &&
      s.pendingMesh === 0 && s.lightInflight === 0 && s.lightQueued === 0 && s.uploadQueue === 0;
  }, null, { timeout: 90_000 });
  await page.waitForTimeout(5_000);
  ```

  采集每个 anchor 的 controller 数、zombie count、renderer slots、scheduler queues、draw 和 fps；断言不会因
  repeated hydrate、失效或 column reload 增长，并对 `genInflight`、`meshInflight`、`meshQueued`、`pendingMesh`、
  `lightInflight`、`lightQueued`、`uploadQueue` 逐项断言为 0。报告和测试名称都必须写“30 丧尸中档 fixture”，
  不能称默认。

- [ ] **Step 2: 验证 RED**

  Run: `npx playwright test tests/zombie-nests.spec.mjs`
  Expected: 在 `restoreEdits`/hydrate/controller 去重未完成前，reload 后旧普通 edits 或 anchor 缺失，或 controller 重复。

- [ ] **Step 3: 运行完整门禁并写验收报告**

  Run: `npm test && npm run lint && git diff --check`
  Expected: 三条命令退出 0。报告记录设备/WebGPU 后端、蓝图 38/critical、8 上限、alias/put、三种破坏、
  8 秒搜索坐标、GEN 接管存档回归、repeated reload、默认 20 和中档 30 fixture 的 fps/draw/queue/slot 数据。
  若超过 M3 冻结基线 10% 或队列/slot 未收敛，报告阻断，不修改性能阈值。

- [ ] **Step 4: 回填路线图和权威入口**

  仅在全部门禁通过后，将 M7 规格标为已实施/验收，roadmap/设计文档/AGENTS/README 标为完成，并在后续
  功能表说明“巢穴持久锚点/控制器模式已可供炮塔等方块装置复用”。未通过则状态保持待实施并只记录原因。

- [ ] **Step 5: 准备验收提交（仅获授权后执行）**

  ```bash
  git add tests/zombie-nests.spec.mjs docs/m7-zombie-nests-acceptance-report.md \
    docs/superpowers/specs/2026-08-23-m7-zombie-nests-design.md \
    docs/superpowers/plans/2026-08-23-m7-zombie-nests.md \
    docs/superpowers/plans/2026-08-20-phase1-remaining-roadmap.md \
    docs/phase-1-engine-design.md AGENTS.md README.md
  git commit -m "docs: record m7 zombie nest acceptance"
  ```

## 计划自检

- Task 1 独立覆盖真实 GEN 接管后的 edits/blockEntity 存档回归；Task 2 覆盖蓝图、原子事务、最小入口和音频；
  Task 3 覆盖事件完整性、精确刷怪搜索与 lifecycle；Task 4 以 M4 一致的完整加载、七项队列收敛、reload、
  压力和全局文档回填收尾。
- 没有新增 StructureIndex 地标、背包、完整 TNT、设置面板或第二份方块真相；这些仍分别在后续 Epic 实施。
