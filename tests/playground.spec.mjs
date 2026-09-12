import { test, expect } from 'playwright/test';

/**
 * M9 创造台验收。
 *
 * ⚠️ **没有共享 helper 模块** —— `boot` / `waitWorldSettled` 都是各 spec 自带的局部 helper
 * （实测：`tests/` 下无共享 .js 模块）。本 spec 把 `waitWorldSettled` 整段从
 * `tests/zombie-nests.spec.mjs` 复制过来（含其判据注释）。
 *
 * Tier 1 断言落点说明：本 spec 的关键回归是「重启后从锚点恢复创造台状态」。该缺陷在方块层面
 * 看不出差别（平台方块还在渲染），只在「flush → reload → hydrate」时暴露 —— 若锚点没随 edits
 * 落库，reload 后 `isActive()` 会是 false。故断言必须落在**重启后的服务状态**上。
 */

/**
 * 等世界真正稳定。
 *
 * ⚠️ **不能只判队列归零** —— 那是瞬时状态。`worldReady === true` 仅表示出生点邻域就绪，
 * 后台仍在填充 column/sections；高负载下队列可能短暂归零而 column 还在加载。此时选址会对
 * 未加载位置读到 `getBlockId === 0` → 判「安全」→ 产出半个平台。
 *
 * 正确判据 = **sections 连续两次采样不变**（跨帧比较）+ 队列归零。
 */
async function waitWorldSettled(page) {
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const s = g.scheduler.stats();
    const sections = g.renderStats().sections;
    const prev = window.__MC_STABLE_PREV__;
    window.__MC_STABLE_PREV__ = sections;
    return prev === sections &&
      s.genInflight === 0 && s.meshInflight === 0 && s.meshQueued === 0 &&
      s.pendingMesh === 0 && s.lightInflight === 0 && s.lightQueued === 0 && s.uploadQueue === 0;
  }, null, { timeout: 90_000, polling: 500 });
}

/** 起手式：导航 + 等世界稳定。⚠️ 视距口径见各用例注释（平台跨约 20 个 column）。 */
async function boot(page, vd = 4) {
  await page.goto(`/?vd=${vd}&seed=12345`);
  await waitWorldSettled(page);
}

test('创造台：生成 54×54 平台 + 中心块，平台方块不可挖', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page, 4);   // vd=4：平台跨约 20 个 column，须视距够大才能全部加载（实测 vd=2 → not-loaded）
  const created = await page.evaluate(() => window.__MC_GAME__.createPlayground());
  expect(created.ok).toBe(true);
  const origin = created.origin;
  // 平台格抽样验证：四角 + 中心
  const blocks = await page.evaluate((o) => {
    const g = window.__MC_GAME__;
    const blockId = g.registry.idOf('playground_block');
    const centerId = g.registry.idOf('playground_center_block');
    return {
      corner: g.world.getBlockId(o[0], o[1], o[2]),
      center: g.world.getBlockId(o[0] + 27, o[1], o[2] + 27),
      blockId, centerId,
      anchor: g.world.getBlockEntity(o[0] + 27, o[1], o[2] + 27),
    };
  }, origin);
  expect(blocks.corner).toBe(blocks.blockId);
  expect(blocks.center).toBe(blocks.centerId);
  expect(blocks.anchor.kind).toBe('playground');
  // ⚠️ **选址正确性的真实判据 = 净空区全空**：`_findSafeHeight` 只返回「平台层 + 上方净空
  // 10 格全为空」的高度，而平台写入**只覆盖平台层**（origin.y）→ 净空区（origin.y+1..+10）
  // 在创建后必须仍是 air。若 `_hasOverlap` 恒判「无重叠」，平台会落在地面上方第一格、净空区
  // 里塞满地形方块 → 本断言真 FAIL（这是注入①的唯一可观测判据：平台层本身被写入覆盖了，
  // 无法事后判定写入前是否为空）。
  // 抽样 5 个点（四角 + 中心）× 10 层 = 50 次读取，不在 E2E 里跑 3.2 万次全扫。
  const clearance = await page.evaluate((o) => {
    const g = window.__MC_GAME__;
    const pts = [[0, 0], [53, 0], [0, 53], [53, 53], [27, 27]];
    const nonAir = [];
    for (const [dx, dz] of pts) {
      for (let dy = 1; dy <= 10; dy++) {
        const id = g.world.getBlockId(o[0] + dx, o[1] + dy, o[2] + dz);
        if (id !== 0) nonAir.push([o[0] + dx, o[1] + dy, o[2] + dz]);
      }
    }
    return nonAir;
  }, origin);
  expect(clearance).toEqual([]);
  // 徒手挖平台方块 → 零写入（indestructible 门控；断言落在编辑入口未产生变更上）
  const dig = await page.evaluate((o) => {
    const g = window.__MC_GAME__;
    let writes = 0;
    const off = g.editor.subscribe(() => { writes++; });
    g.player.target = { blockPos: [o[0], o[1], o[2]], prevPos: [o[0], o[1] + 1, o[2]],
      normal: [0, 1, 0], dist: 2 };
    g.player.digBlock();
    off();
    return { id: g.world.getBlockId(o[0], o[1], o[2]), writes };
  }, origin);
  expect(dig.id).toBe(blocks.blockId);   // 还在
  expect(dig.writes).toBe(0);            // 编辑入口零调用（不是「方块恰好还在」）
});

test('创造台：reload 后从锚点恢复激活状态，全局仍最多 1 个', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page, 4);
  await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const r = g.createPlayground();
    if (!r.ok) throw new Error(`create failed: ${r.reason}`);
    await g.persistence.flushNow(g.world);   // ⚠️ 测试侧 reload 前落库，供 reload 后 hydrate 读取
  });
  await page.reload();
  await waitWorldSettled(page);
  // 锚点恢复 → active === true（不遍历已加载 column，走 listBlockEntities 扫库）
  const restored = await page.evaluate(() => window.__MC_GAME__.playgroundDebugState());
  expect(restored.active).toBe(true);
  expect(restored.origin).not.toBeNull();
  // 再 create → 'exists'（全局最多 1 个，上限判定不依赖已加载 column）
  const second = await page.evaluate(() => window.__MC_GAME__.createPlayground());
  expect(second.ok).toBe(false);
  expect(second.reason).toBe('exists');
});

test('创造台：vd=2 时平台跨未加载 column → not-loaded 且零写入', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page, 2);   // vd=2 的加载半径不足以覆盖 54×54 平台 → 触发选址的未加载判据
  const r = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    let writes = 0;
    const off = g.editor.subscribe(() => { writes++; });
    const result = g.createPlayground();
    off();
    return { result, writes };
  });
  expect(r.result.ok).toBe(false);
  expect(r.result.reason).toBe('not-loaded');
  expect(r.writes).toBe(0);   // 失败路径零世界写入
});

test('创造台：导出 JSON 可被结构管线消费（dimensions 形状与 structures 一致）', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page, 4);
  const result = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const created = g.createPlayground();
    if (!created.ok) throw new Error(`create failed: ${created.reason}`);
    const o = created.origin;
    // 在平台上雕两格 stone 模型（平台上方一格）
    const stoneId = g.registry.idOf('stone');
    const cx = o[0] + 27, cz = o[2] + 27;
    g.editor.setBlocks([
      { x: cx, y: o[1] + 1, z: cz, id: stoneId },
      { x: cx + 1, y: o[1] + 1, z: cz, id: stoneId },
    ]);
    const exp = g.playground.exportModel();   // **同步**返回（规格 §2.4）
    return { ok: exp.ok, json: exp.json, blocks: exp.blocks };
  });
  expect(result.ok).toBe(true);
  expect(result.blocks).toBe(2);
  const data = JSON.parse(result.json);
  expect(Array.isArray(data.blocks)).toBe(true);
  expect(data.blocks.length).toBe(2);
  expect(data.blocks[0]).toHaveProperty('type', 'stone');
  expect(Number.isFinite(data.blocks[0].x)).toBe(true);
  expect(Number.isFinite(data.blocks[0].direction)).toBe(true);
  // ⚠️ dimensions 键名必须是 width/height/depth（实测结构 JSON 口径），不得有旧形状的 x 键
  expect(data.metadata.dimensions).toHaveProperty('width');
  expect(data.metadata.dimensions).toHaveProperty('height');
  expect(data.metadata.dimensions).toHaveProperty('depth');
  expect(data.metadata.dimensions.x).toBeUndefined();
});

test('创造台：玩家在平台内时拒绝关闭；区域外关闭只删平台层、保留模型', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page, 4);
  const result = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const created = g.createPlayground();
    if (!created.ok) throw new Error(`create failed: ${created.reason}`);
    const o = created.origin;
    // 雕一格模型（关闭后须保留 —— 只删平台层，不删模型）
    const stoneId = g.registry.idOf('stone');
    const cx = o[0] + 27, cz = o[2] + 27;
    g.editor.setBlocks([{ x: cx, y: o[1] + 1, z: cz, id: stoneId }]);
    // ① 玩家在平台内 → 拒绝关闭（⚠️ physics.pos 是普通对象，用 player.spawn 传送，无 .set()）
    g.player.spawn(o[0] + 5, o[1] + 1, o[2] + 5);
    const inside = g.closePlayground();
    // ② 玩家移出平台 → 关闭成功
    g.player.spawn(o[0] - 20, o[1] + 1, o[2]);
    const outside = g.closePlayground();
    return {
      insideReason: inside.reason,
      outsideOk: outside.ok,
      platformGone: g.world.getBlockId(o[0], o[1], o[2]) === 0,   // 平台层变 air
      modelKept: g.world.getBlockId(cx, o[1] + 1, cz) === stoneId, // 模型保留
    };
  });
  expect(result.insideReason).toBe('player-in-playground');
  expect(result.outsideOk).toBe(true);
  expect(result.platformGone).toBe(true);
  expect(result.modelKept).toBe(true);   // ⚠️ 只删平台层，模型方块保留
});

test('创造台面板：文案随状态切换、导出/导入仅激活时可见、toast 不阻塞世界操作', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page, 4);
  const r = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const panel = g.settingsPanel;
    const OPEN = '打开创造台', CLOSE = '关闭创造台';
    const vis = (el) => el.style.display !== 'none';
    const out = {};
    panel.open();
    // 初始态（未激活）：文案 = 打开创造台，导出/导入隐藏
    out.openLabel = panel._playgroundBtn.textContent;
    out.exportVisibleBefore = vis(panel._exportBtn);
    out.importVisibleBefore = vis(panel._importBtn);
    // toast 未显示时，模态栈只有 settings 一项（toast 不进栈）
    out.modalsBefore = [...g._modals];
    // 点击主按钮 → 生成创造台
    panel._onPlaygroundToggle();
    out.labelAfterCreate = panel._playgroundBtn.textContent;
    out.exportVisibleAfter = vis(panel._exportBtn);
    out.importVisibleAfter = vis(panel._importBtn);
    // ⚠️ toast 不进 uiModal 栈：此刻栈内仍只有 settings（若 toast 进了栈会是两项）
    out.modalsAfterToast = [...g._modals];
    out.toastVisible = panel._toast.isVisible();
    out.toastMessage = panel._toast.message();
    // 创造台已激活（服务侧真实状态）
    out.active = g.playground.isActive();
    // 再点一次 → 关闭（玩家在平台外才成功；先把玩家挪出平台区域）
    const o = g.playground.origin();
    g.player.spawn(o[0] - 20, o[1] + 1, o[2]);
    panel._syncPlaygroundState();   // 同步服务真实状态（玩家已移出 → 可关闭）
    panel._onPlaygroundToggle();
    out.labelAfterClose = panel._playgroundBtn.textContent;
    out.activeAfterClose = g.playground.isActive();
    panel.close();
    return out;
  });
  expect(r.openLabel).toBe('打开创造台');
  expect(r.exportVisibleBefore).toBe(false);
  expect(r.importVisibleBefore).toBe(false);
  expect(r.labelAfterCreate).toBe('关闭创造台');
  expect(r.exportVisibleAfter).toBe(true);
  expect(r.importVisibleAfter).toBe(true);
  expect(r.active).toBe(true);
  // ⚠️ toast 不进模态栈（规格 §3 验收项）：栈内始终只有 settings
  expect(r.modalsBefore).toEqual(['settings']);
  expect(r.modalsAfterToast).toEqual(['settings']);
  expect(r.toastVisible).toBe(true);
  expect(r.toastMessage).toBe('创造台已创建');
  expect(r.labelAfterClose).toBe('打开创造台');
  expect(r.activeAfterClose).toBe(false);
});

test('创造台面板：busy 锁生效——操作进行中的第二次点击被拒绝', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page, 4);
  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const panel = g.settingsPanel;
    panel.open();
    // ⚠️ 负向验证口径：若去掉 busy 锁，两次点击都会走到 createPlayground ——
    // 第一次成功、第二次返回 exists，**断言仍能通过**（这是无效盲区）。
    // 故断言落在**锁本身的可见状态**上：busy 期间主按钮必须 disabled，
    // 且第二次调用直接 return（不触碰服务 → createPlayground 调用次数不增加）。
    let calls = 0;
    const origCreate = g.createPlayground.bind(g);
    g.createPlayground = () => { calls++; return origCreate(); };
    panel._playgroundBusy = true;          // 模拟「操作进行中」
    panel._playgroundBtn.disabled = true;
    panel._onPlaygroundToggle();           // 第二次点击（busy 中）
    const duringBusy = { calls, disabled: panel._playgroundBtn.disabled, busy: panel._playgroundBusy };
    // 释放锁后再点 → 真正走到服务
    panel._playgroundBusy = false;
    panel._onPlaygroundToggle();
    const afterRelease = { calls, active: g.playground.isActive() };
    g.createPlayground = origCreate;
    panel.close();
    return { duringBusy, afterRelease };
  });
  expect(r.duringBusy.calls).toBe(0);      // busy 期间第二次点击**没触碰服务**
  expect(r.duringBusy.disabled).toBe(true);
  expect(r.afterRelease.calls).toBe(1);    // 释放后才真正执行一次
  expect(r.afterRelease.active).toBe(true);
});
