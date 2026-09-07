import { test, expect } from 'playwright/test';

// M5：实体运行时集成验收（M5 规格 §4）。
//
// 分工（docs/testing-policy.md §2.4）：
// - **两阶段卸载的时序断言**走 fixture 页（`/src/tests/test-scheduler-unload.html`）：
//   保存 gate 期间 column 不得被同步删除，这个不变式只在「手动驱动 scheduler.update」下可控。
//   真游戏页的 rAF 每帧都在用真实玩家位置调 scheduler.update，会把 pending unload 立刻取消，
//   断言撞上不确定的帧边界 —— 竞态断言必须落在同步可观测的内存状态。
// - **IndexedDB round-trip**走真游戏页：只有真 IDB 能证明 DB v2 升级、snapshot 落库与重载恢复。

// ==================== 两阶段卸载（fixture 页） ====================

const FIXTURE_URL = '/src/tests/test-scheduler-unload.html';

async function openFixture(page) {
  await page.goto(FIXTURE_URL);
  await page.waitForFunction(() => window.__FIXTURE_READY__ === true, null, { timeout: 30_000 });
}

// 帧边界 flush（见下方各 evaluate 内的 `flush`）：生产路径里 scheduler.update 每帧由 rAF
// （macrotask）驱动，microtask 早已 drain 完。fixture 在同步紧循环里连调 update() 会跳过
// microtask drain，导致 ready.then 标记 / reject 链还没跑就读状态。setTimeout(0) 是 macrotask ——
// 排空全部 pending microtask，与 rAF 帧边界同构。

test('M5: 保存 gate 期间不越过删除边界，ready 成功后的下一帧才最终移除', async ({ page }) => {
  await openFixture(page);
  const result = await page.evaluate(async () => {
    const { make } = window.__FIXTURE__;
    const f = make();
    const events = f.events;
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    let resolveSave;
    f.persistence.gate = new Promise((resolve) => { resolveSave = resolve; });

    f.spawnProbe('persistent', [0.5, 1, 0.5], true);
    f.spawnProbe('temporary', [1.5, 1, 0.5], false);
    f.scheduler.update(16 * 8, 0); // viewDistance=1 → 0,0 已超过 R+2

    // 同帧：column/实体都还在，只发起了保存（异步保存绝不在同帧越过删除边界）
    const duringSave = {
      hasColumn: f.world.hasColumn(0, 0),
      persistent: f.entities.get('persistent') !== null,
      temporary: f.entities.get('temporary') !== null,
      events: [...events],
      pendingUnloads: f.stats().pendingUnloads,
    };

    resolveSave();
    await flush(); // 排空 ready.then 链（标记 readyResolved）—— 模拟帧边界
    // ready 已 resolve，但**尚未进入下一帧的 scheduler.update** → 仍不得删除（下一帧才同步提交）
    const afterReadyBeforeFrame = {
      hasColumn: f.world.hasColumn(0, 0),
      persistent: f.entities.get('persistent') !== null,
    };

    f.scheduler.update(16 * 8, 0); // ready 成功后的下一帧 → 最终移除
    const afterCommit = {
      hasColumn: f.world.hasColumn(0, 0),
      persistent: f.entities.get('persistent') !== null,
      temporary: f.entities.get('temporary') !== null,
      events: [...events],
      pendingUnloads: f.stats().pendingUnloads,
    };
    return { duringSave, afterReadyBeforeFrame, afterCommit };
  });

  expect(result.duringSave.hasColumn).toBe(true);
  expect(result.duringSave.persistent).toBe(true);
  expect(result.duringSave.temporary).toBe(true);
  expect(result.duringSave.events).toEqual([['save']]);
  expect(result.duringSave.pendingUnloads).toBe(1);

  expect(result.afterReadyBeforeFrame.hasColumn).toBe(true);
  expect(result.afterReadyBeforeFrame.persistent).toBe(true);

  // 最终移除的顺序：will-remove（广播时 column 仍在）→ commit → column 真的没了
  expect(result.afterCommit.events).toEqual([
    ['save'],
    ['will-remove', '0,0', true],
    ['commit', '0,0'],
  ]);
  expect(result.afterCommit.hasColumn).toBe(false);
  expect(result.afterCommit.persistent).toBe(false);
  expect(result.afterCommit.temporary).toBe(false);
  expect(result.afterCommit.pendingUnloads).toBe(0);
});

test('M5: 保存尚未结束时玩家重入 → cancel 且不得最终删除', async ({ page }) => {
  await openFixture(page);
  const result = await page.evaluate(async () => {
    const { make } = window.__FIXTURE__;
    const f = make();
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    let resolveReentry;
    f.persistence.gate = new Promise((resolve) => { resolveReentry = resolve; });

    f.spawnProbe('persistent', [0.5, 1, 0.5], true);
    f.scheduler.update(16 * 8, 0);
    const pending = f.stats().pendingUnloads;

    f.scheduler.update(0, 0); // 玩家回到 0,0 → 重入（2a 同步 cancel）
    const afterReentry = {
      pendingUnloads: f.stats().pendingUnloads,
      hasColumn: f.world.hasColumn(0, 0),
      persistent: f.entities.get('persistent') !== null,
      frozen: f.entities.get('persistent').frozen,
      events: [...f.events],
    };

    resolveReentry(); // 已完成的旧写入允许存在；后续状态保存会覆盖
    await flush();
    f.scheduler.update(0, 0); // 重入后再跑一帧：不得复活那次卸载
    const afterFrame = {
      hasColumn: f.world.hasColumn(0, 0),
      persistent: f.entities.get('persistent') !== null,
      events: [...f.events],
    };
    return { pending, afterReentry, afterFrame };
  });

  expect(result.pending).toBe(1);
  expect(result.afterReentry.pendingUnloads).toBe(0);
  expect(result.afterReentry.hasColumn).toBe(true);
  expect(result.afterReentry.persistent).toBe(true);
  expect(result.afterReentry.frozen).toBe(false); // 解冻
  expect(result.afterReentry.events).toEqual([['save'], ['cancel', '0,0']]);
  expect(result.afterFrame.hasColumn).toBe(true);
  expect(result.afterFrame.persistent).toBe(true);
  expect(result.afterFrame.events).toEqual([['save'], ['cancel', '0,0']]);
});

test('M5: 写盘失败 → cancel、保留 column 与实体、记录可诊断错误', async ({ page }) => {
  await openFixture(page);
  const result = await page.evaluate(async () => {
    const { make } = window.__FIXTURE__;
    const f = make();
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    let rejectSave;
    f.persistence.gate = new Promise((_, reject) => { rejectSave = reject; });

    f.spawnProbe('persistent', [0.5, 1, 0.5], true);
    f.scheduler.update(16 * 8, 0);
    rejectSave(new Error('IDB write failed'));
    // reject 经 ready.catch 异步 settle → cancel：须排空 microtask（帧边界）才能读到结果
    await flush();

    const afterReject = {
      pendingUnloads: f.stats().pendingUnloads,
      lastUnloadError: f.stats().lastUnloadError,
      hasColumn: f.world.hasColumn(0, 0),
      persistent: f.entities.get('persistent') !== null,
      frozen: f.entities.get('persistent').frozen,
      events: [...f.events],
    };

    // 失败后的后续正常卸载周期可重试（不得静默放弃这个 column）
    let resolveRetry;
    f.persistence.gate = new Promise((resolve) => { resolveRetry = resolve; });
    f.scheduler.update(16 * 8, 0);
    const retryPending = f.stats().pendingUnloads;
    resolveRetry();
    await flush();
    f.scheduler.update(16 * 8, 0);
    const afterRetry = {
      hasColumn: f.world.hasColumn(0, 0),
      persistent: f.entities.get('persistent') !== null,
      lastUnloadError: f.stats().lastUnloadError,
    };
    return { afterReject, retryPending, afterRetry };
  });

  expect(result.afterReject.pendingUnloads).toBe(0);
  expect(result.afterReject.lastUnloadError).toContain('0,0');
  expect(result.afterReject.hasColumn).toBe(true);
  expect(result.afterReject.persistent).toBe(true);
  expect(result.afterReject.frozen).toBe(false);
  expect(result.afterReject.events).toEqual([['save'], ['cancel', '0,0']]);

  // 重试路径：下一个卸载周期能重新发起保存并最终移除（失败不是永久放弃）
  expect(result.retryPending).toBe(1);
  expect(result.afterRetry.hasColumn).toBe(false);
  expect(result.afterRetry.persistent).toBe(false);
});

test('M5: 最终卸载后重入 → 持久 probe 恰恢复一次，临时 probe 不恢复', async ({ page }) => {
  await openFixture(page);
  const result = await page.evaluate(async () => {
    const { make } = window.__FIXTURE__;
    const f = make();
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    f.spawnProbe('persistent', [0.5, 1, 0.5], true);
    f.spawnProbe('temporary', [1.5, 1, 0.5], false);

    // 走完整卸载流程（无 gate → ready 立即成功）。两次 update 之间须 flush：
    // 第一次请求卸载（异步 ready.then 标记 readyResolved），下一帧才同步提交（帧边界）。
    f.scheduler.update(16 * 8, 0);
    await flush();
    f.scheduler.update(16 * 8, 0);
    const unloaded = {
      hasColumn: f.world.hasColumn(0, 0),
      persistent: f.entities.get('persistent') !== null,
      temporary: f.entities.get('temporary') !== null,
    };

    // 模拟持久化层回读（snapshot 来自卸载时写盘的那份）
    f.persistence.loaded = [{ id: 'persistent', type: 'probe', state: { position: [0.5, 1, 0.5] } }];
    const restoreFirst = f.entities.restorePersistent(f.persistence.loaded);

    // 玩家重入：column 重新生成，恢复只应发生一次（已存在 id 跳过）
    f.reAddColumn(0, 0);
    const restoreSecond = f.entities.restorePersistent(f.persistence.loaded);

    const restoredEntity = f.entities.get('persistent');
    return {
      unloaded,
      restoreFirst,
      restoreSecond,
      persistentExists: restoredEntity !== null,
      // 恢复的实体必须是持久实体 —— 若恢复成临时的，下次卸载不写盘 → 永久丢失
      // （负向验证实测：restorePersistent 恢复成 temporary 时此断言 FAIL）。
      persistentFlag: restoredEntity?.persistent === true,
      temporary: f.entities.get('temporary') !== null,
      persistentEntityCount: f.entities.count('probe'),
      position: restoredEntity?.state?.position,
    };
  });

  expect(result.unloaded.hasColumn).toBe(false);
  expect(result.unloaded.persistent).toBe(false);
  expect(result.unloaded.temporary).toBe(false);

  expect(result.restoreFirst).toEqual({ restored: 1, skipped: 0 });
  expect(result.restoreSecond).toEqual({ restored: 0, skipped: 1 }); // 已存在 → 不重复恢复
  expect(result.persistentExists).toBe(true);
  expect(result.persistentFlag).toBe(true);
  expect(result.temporary).toBe(false); // 临时实体不恢复
  expect(result.persistentEntityCount).toBe(1);
  expect(result.position).toEqual([0.5, 1, 0.5]);
});

test('M5: 卸载只登记 key/handle，不复制体素数据（pending 记录不含 blocks）', async ({ page }) => {
  await openFixture(page);
  const result = await page.evaluate(() => {
    const { make } = window.__FIXTURE__;
    const f = make();
    f.spawnProbe('persistent', [0.5, 1, 0.5], true);
    f.scheduler.update(16 * 8, 0);
    const pending = [...f.scheduler._pendingColumnUnloads.values()][0];
    return {
      keys: Object.keys(pending).sort(),
      hasBlocks: 'blocks' in pending,
      hasMeta: 'meta' in pending,
      hasLight: 'light' in pending,
      columnIsSameObject: pending.column === f.world.getColumn(0, 0),
      pendingUnloads: f.stats().pendingUnloads,
    };
  });

  // pending 只有生命周期状态，绝不缓存 blocks/meta/light（M5 规格 §2 + 红线 1）。
  // 不钉精确字段清单（将来加字段不算缺陷）：只钉「不含体素数据 + 含核心生命周期字段」。
  expect(result.keys).not.toContain('blocks');
  expect(result.keys).not.toContain('meta');
  expect(result.keys).not.toContain('light');
  expect(result.keys).toEqual(expect.arrayContaining(['column', 'handles', 'key', 'ready']));
  expect(result.hasBlocks).toBe(false);
  expect(result.hasMeta).toBe(false);
  expect(result.hasLight).toBe(false);
  expect(result.columnIsSameObject).toBe(true); // 持有引用，不是副本
  expect(result.pendingUnloads).toBe(1);
});

// ==================== IndexedDB round-trip（真游戏页） ====================

test('M5: 持久 probe 跨重载恢复、临时 probe 不恢复（DB v2 entities store）', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?vd=2');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 60_000 });

  // 1. 创建持久与临时 probe，立即 flush
  await page.evaluate(async () => {
    const game = window.__MC_GAME__;
    game.entities.spawn({ id: 'm5-persistent', type: 'probe', persistent: true, state: { position: [0.5, 1, 0.5] } });
    game.entities.spawn({ id: 'm5-temporary', type: 'probe', persistent: false, state: { position: [1.5, 1, 0.5] } });
    await game.persistence.flushEntities();
  });

  // 2. 整页刷新（导航监听须在触发动作之前武装 —— CLAUDE.md 实测踩坑）
  const nav = page.waitForNavigation({ waitUntil: 'load', timeout: 60_000 });
  await page.evaluate(() => location.reload());
  await nav;
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 60_000 });

  // 3. 读回 store：持久 snapshot 在库里，临时实体不在
  const result = await page.evaluate(async () => {
    const game = window.__MC_GAME__;
    const stored = await game.persistence.loadEntities();
    const restored = game.entities.restorePersistent(stored);
    // 再调一次：证明「恰恢复一次」（已存在 id 跳过）
    const second = game.entities.restorePersistent(stored);
    return {
      storedIds: stored.map((s) => s.id).sort(),
      persistent: game.entities.get('m5-persistent') !== null,
      temporary: game.entities.get('m5-temporary') !== null,
      restoredExactlyOnce: restored.restored === 1 && second.restored === 0,
      position: game.entities.get('m5-persistent')?.state?.position,
      shape: Object.keys(stored[0] || {}).sort(),
    };
  });

  expect(result.storedIds).toEqual(['m5-persistent']);
  expect(result.persistent).toBe(true);
  expect(result.temporary).toBe(false);
  expect(result.restoredExactlyOnce).toBe(true);
  expect(result.position).toEqual([0.5, 1, 0.5]);
  expect(result.shape).toEqual(['id', 'state', 'type']);
});

test('M5: saveEntities 是 upsert —— 保存一个 column 不得抹掉其它 column 的持久实体', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?vd=2');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 60_000 });

  // 一次 column 卸载只保存**该 column** 的持久实体（M5 规格 §3「不得扫描整世界」）。
  // 若 saveEntities 是 clear+write 而非 upsert，column B 的这次写盘会把 column A 的装置抹掉 ——
  // 玩家走一圈回来，远处的炮塔全没了，且肉眼看不出来（重启才暴露的静默数据丢失）。
  // 负向验证实测：把 saveEntities 改成 clear+write，本用例 FAIL（storedIds 只剩 B）。
  const result = await page.evaluate(async () => {
    const game = window.__MC_GAME__;
    // column A = (0,0) 范围内的持久实体
    await game.persistence.saveEntities([{ id: 'col-a', type: 'probe', state: { position: [0.5, 1, 0.5] } }]);
    // column B = (40,40) → column (2,2)，模拟另一次卸载只写它自己的 snapshot
    await game.persistence.saveEntities([{ id: 'col-b', type: 'probe', state: { position: [40.5, 1, 40.5] } }]);
    const stored = await game.persistence.loadEntities();
    return { storedIds: stored.map((s) => s.id).sort() };
  });

  // 两批都必须在库里 —— upsert 而非整库替换
  expect(result.storedIds).toEqual(['col-a', 'col-b']);
});

// ==================== Task 3：受控渲染层与生命周期对称 ====================

test('M5: render node 与 EntityManager 生命周期对称', async ({ page }) => {
  await page.goto('/?vd=2');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 60_000 });
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

test('M5: render node 落在实体的 pose 上，且不得回写 state（渲染层只读）', async ({ page }) => {
  await page.goto('/?vd=2');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 60_000 });
  const result = await page.evaluate(async () => {
    const THREE = await import('three');
    const g = window.__MC_GAME__;
    const pos = [2, 2, 2];
    g.entities.spawn({ id: 'pose-probe', type: 'probe', state: { position: pos } });
    g.entities.update(1 / 60, { world: g.world });
    g.entityLayer.sync(g.entities.entities());
    // 从 scene 找到该 probe 的节点（节点按 id 命名 —— 受控层给每个节点打了标识）
    const node = g.scene.getObjectByName('entity:pose-probe');
    const nodePos = node ? [node.position.x, node.position.y, node.position.z] : null;
    // 渲染层只读：改 scene 节点位置不得改变实体 state（state 是唯一权威，红线 1）
    if (node) node.position.set(99, 99, 99);
    g.entities.update(1 / 60, { world: g.world });
    const stateAfter = g.entities.get('pose-probe').state.position;
    const isGroup = node ? node.isGroup === true : null;
    g.entities.despawn('pose-probe', 'test');
    g.entityLayer.sync(g.entities.entities());
    const gone = g.scene.getObjectByName('entity:pose-probe') === undefined;
    return { nodePos, stateAfter, isGroup, gone };
  });

  expect(result.nodePos).toEqual([2, 2, 2]); // 节点落在实体 pose 上
  expect(result.stateAfter).toEqual([2, 2, 2]); // 渲染层不得回写 state
  expect(result.isGroup).toBe(true); // probe 的 node 是受控 THREE.Group（plan Task 3）
  expect(result.gone).toBe(true); // despawn 后 scene 无该节点
});

test('M5: dispose 后 scene 无实体节点、layer 无活动 instance', async ({ page }) => {
  await page.goto('/?vd=2');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 60_000 });
  const result = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    g.entities.spawn({ id: 'd1', type: 'probe', state: { position: [1, 1, 1] } });
    g.entities.spawn({ id: 'd2', type: 'probe', state: { position: [3, 1, 3] } });
    g.entities.update(1 / 60, { world: g.world });
    g.entityLayer.sync(g.entities.entities());
    const beforeDispose = {
      active: g.entityLayer.activeCount('probe'),
      inScene: g.scene.children.filter((c) => c.name?.startsWith('entity:')).length,
    };
    // 反向释放：layer.dispose() 必须清掉全部 scene 节点（Game.dispose 调它）
    g.entityLayer.dispose();
    const afterDispose = {
      active: g.entityLayer.activeCount('probe'),
      inScene: g.scene.children.filter((c) => c.name?.startsWith('entity:')).length,
    };
    return { beforeDispose, afterDispose };
  });

  expect(result.beforeDispose.active).toBe(2);
  expect(result.beforeDispose.inScene).toBe(2);
  expect(result.afterDispose.active).toBe(0);
  expect(result.afterDispose.inScene).toBe(0);
});

// 独立的视距 8 稳态 case：不复用上例的 ?vd=2 页面，也不从 loading 期采样。
// 与 M4 一致地等七项队列收敛 + 5s 稳定（world-stable 判据见 MEMORY.md：sections 停止增长 + 队列归零）。
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
