import { test, expect } from 'playwright/test';
import fs from 'node:fs';

/**
 * v1.43 验收：设置面板的「导入进度 / 导出进度」。
 *
 * 关键回归（Tier 1）两条，都**在方块层面看不出差别**，只有端到端才能暴露：
 * ① **导出前必须先 `flushNow`** —— 刚放下的方块还在内存 edits 里（5s 防抖未到），
 *    不落库就导出一份旧进度；文件照样生成、格式照样合法，只有导入后才发现少了方块。
 * ② **导入必须走 `_discardEdits`** —— 否则旧世界的改动残留（本用例把旧方块**显式落库**，
 *    不走 clear-save 那条「卸载事务能否提交」的时序不定路径 → 断言确定性成立）。
 *
 * ⚠️ 骨架与判据口径参照 `tests/clear-save.spec.mjs`（同一作者的既有 spec）：`STABLE` 必须
 * 等 sections 连续两次采样不变 + 队列归零，不能只看队列瞬时归零。
 */

const READY = () => window.__MC_GAME__?.worldReady === true;

const STABLE = () => {
  const g = window.__MC_GAME__;
  const s = g.scheduler.stats();
  const sections = g.renderStats().sections;
  const prev = window.__MC_STABLE_PREV__;
  window.__MC_STABLE_PREV__ = sections;
  return prev === sections &&
    s.inflight === 0 && s.meshInflight === 0 && s.uploadQueue === 0;
};

/** 起手式：固定 seed 入口 + 等世界稳定 */
async function boot(page, vd = 4, seed = 12345) {
  await page.goto(`/?vd=${vd}&seed=${seed}`);
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await page.waitForFunction(STABLE, null, { timeout: 60_000, polling: 500 });
}

/** 在玩家附近的地面上放一格方块；返回坐标与落库前的 savedColumns 快照 */
async function placeBlock(page, type = 'stone', offset = 2, flush = false) {
  return page.evaluate(async ({ type, offset, flush }) => {
    const g = window.__MC_GAME__;
    const px = Math.floor(g.player.physics.pos.x) + offset;
    const pz = Math.floor(g.player.physics.pos.z) + offset;
    let groundY = -1;
    for (let y = 90; y > -32; y--) { if (g.world.getBlockId(px, y, pz) !== 0) { groundY = y; break; } }
    const y = groundY + 1;
    const before = await g.persistence.countSavedColumns();
    const r = g.world.setBlock(px, y, pz, g.registry.idOf(type));
    g.scheduler.remeshSections(r.affected, { fastPath: true });
    if (flush) await g.persistence.flushNow(g.world);
    return { x: px, y, z: pz, before, after: await g.persistence.countSavedColumns() };
  }, { type, offset, flush });
}

test('进度导出：按钮存在，导出的 JSON 含 seed 与**刚放下**的方块（内存 edits 已落库）', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  await page.locator('#settings-btn').click();
  await expect(page.locator('#settings-modal')).toBeVisible();

  // 内存里放一格（**不落库**）→ 此刻 store 里必须还没有它，否则本用例测不到「export 前 flush」
  const placed = await placeBlock(page, 'stone', 2, false);
  expect(placed.after).toBe(placed.before);   // 前提成立：只在内存 edits 里

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btn-progress-export'),
  ]);
  const path = await download.path();
  const data = JSON.parse(fs.readFileSync(path, 'utf8'));

  expect(data.format).toBe('mc-heavy-progress');
  expect(data.version).toBe(1);
  expect(data.seed).toBe(12345);
  // 导出必须先把内存 edits 落库 —— 否则这里找不到刚放的那一格（注入 flushNow 后本断言真 FAIL）
  const cell = data.columns.flatMap((c) => c.cells)
    .find((c) => c.x === placed.x && c.y === placed.y && c.z === placed.z);
  expect(cell, '导出的包里必须有刚放下的方块（内存 edits 先落库）').toBeTruthy();
  expect(cell.type).toBe('stone');
  // 文件名带 seed（便于玩家区分多份进度）
  expect(download.suggestedFilename()).toMatch(/^mc-heavy-progress-12345-.*\.json$/);
});

test('进度导入：覆盖当前改动、写入包里的方块与 seed', async ({ page }) => {
  test.setTimeout(240_000);
  await boot(page, 4, 12345);
  // ⚠️ **必须先开面板** —— 两个按钮在 `#settings-modal` 内，模态框关闭时是 `display:none`，
  // 对隐藏元素 click 不会触发 file input → `waitForEvent('filechooser')` 等满超时
  // （实测踩坑：5 个用例的 spec 跑到 4 分钟没有任何输出）。
  await page.locator('#settings-btn').click();
  await expect(page.locator('#settings-modal')).toBeVisible();

  // ① 旧世界的方块**显式落库**（不靠 beforeunload 的时序不定写回）。
  //    ⚠️ 坐标选在**与导入格不同的 column**（偏移 33 → 隔壁第二列），这样「导入没清旧改动」
  //    会让 store 里留下两行（savedColumns===1 的断言才能真 FAIL）；同时该 column 在 vd=4 内已加载。
  const old = await placeBlock(page, 'dirt', 33, true);
  expect(old.after).toBeGreaterThan(0);

  // ② 构造一个包：换 seed（777）+ 在**出生点附近**放一格 stone。
  //    坐标必须落在重载后**会加载且会应用 edits** 的范围内。⚠️ 这里刻意不用「换 seed 后新出生点」
  //    的坐标 —— 换 seed 后出生点会跳到几百格之外，那里的 edits 在当前实现下**不会应用**
  //    （既有缺陷，已登记；实测：种子 12345→777 时出生点 283,117 → 117,181）。
  //    故包里的格子取**当前出生点旁**（同一 seed 的位置是确定性的）。
  const pkg = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const x = Math.floor(g.spawnX) + 1, z = Math.floor(g.spawnZ) + 1;
    const key = `${Math.floor(x / 16)},${Math.floor(z / 16)}`;
    return {
      json: JSON.stringify({
        format: 'mc-heavy-progress',
        version: 1,
        seed: 777,
        spawn: null,
        columns: [{ key, cells: [{ x, y: g.spawnY + 5, z, type: 'stone', meta: 0 }] }],
        entities: [],
      }),
      x, y: g.spawnY + 5, z, key,
    };
  });

  // ③ 点「导入进度」→ 文件选择 → 导航监听**先武装**（clear-save 的踩坑教训）
  const nav = page.waitForNavigation({ waitUntil: 'load' });
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('#btn-progress-import'),
  ]);
  await chooser.setFiles({
    name: 'progress.json',
    mimeType: 'application/json',
    buffer: Buffer.from(pkg.json, 'utf8'),
  });
  await nav;
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await page.waitForFunction(STABLE, null, { timeout: 60_000, polling: 500 });

  // ④ 直接把包里的格子读出来（坐标在出生点加载窗口内，无需传送）。
  const after = await page.evaluate(async (p) => {
    const rows = await window.__MC_GAME__.persistence.listEdits();
    return {
      seed: window.__MC_GAME__.seed,
      savedColumns: await window.__MC_GAME__.persistence.countSavedColumns(),
      keys: rows.map((r) => r.columnKey),
      cells: rows.reduce((n, r) => n + r.edits.length, 0),
      oldColumnKey: p.oldColumnKey,
    };
  }, { ...pkg, oldColumnKey: `${Math.floor(old.x / 16)},${Math.floor(old.z / 16)}` });

  expect(after.seed).toBe(777);                 // 包里的 seed 写入 meta（锚定「导入确实改了 seed」）
  // ⚠️ **不断言「包里的方块出现在世界里」** —— 本包用了与当前不同的 seed（777），出生点随之
  // 变到几百格之外，而**远处 column 的 edits 在当前实现下不会被应用**（既有缺陷，已 A/B 实测
  // 在 HEAD 上同样复现并登记在 docs/roadmap.md）。世界写入路径的验证由「导出含刚放入内存的
  // 方块」那条用例 + codec 单测的往返断言承担。
  // ⚠️ **覆盖语义的断言落在持久层**，不是落在旧坐标的方块 id 上 —— 重载后是同一 seed，
  // 但旧坐标那格在新世界可能是地形实心块（id≠0），用 id 判会假失败。
  // 「旧改动被清掉」的精确判据 = store 里只剩包里那一列（旧 column 行的映射已消失）。
  expect(after.savedColumns).toBe(1);
  expect(after.keys).toEqual([pkg.key]);
  expect(after.keys).not.toContain(after.oldColumnKey);
  expect(after.cells).toBe(1);
});

test('进度导入：坏文件被拒，不重载、当前世界原样保留', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  await page.locator('#settings-btn').click();
  await expect(page.locator('#settings-modal')).toBeVisible();
  const placed = await placeBlock(page, 'stone', 2, true);

  const cases = [
    ['not-json.json', 'not json at all', '文件不是合法的 JSON'],
    ['wrong-format.json', JSON.stringify({ format: 'other-game', version: 1, seed: 5 }),
      '这不是 mc-heavy 的进度文件'],
    ['future.json', JSON.stringify({ format: 'mc-heavy-progress', version: 999, seed: 5 }),
      '进度文件版本过新'],
    ['no-seed.json', JSON.stringify({ format: 'mc-heavy-progress', version: 1 }),
      '进度文件缺少有效的世界种子'],
  ];
  for (const [name, text, expectedToast] of cases) {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.click('#btn-progress-import'),
    ]);
    await chooser.setFiles({ name, mimeType: 'application/json', buffer: Buffer.from(text, 'utf8') });
    // ⚠️ **必须等文件读取 + 写入尝试真正结束再进下一轮** —— busy 锁在异步 `file.text()` 完成时
    // 才释放（见 `_onImportProgress`）。若不等就再点一次，第二次点击会被 busy 锁直接 return
    // （**连 file input 都不会创建**）→ 下一轮 `waitForEvent('filechooser')` 永久挂住
    // （实测踩坑：5 个用例的 spec 跑到 4 分钟不结束、零输出）。
    await page.waitForFunction((msg) =>
      !window.__MC_GAME__.settingsPanel._progressBusy
      && window.__MC_GAME__.settingsPanel._toast?.message()?.includes(msg),
    expectedToast, { timeout: 10_000 });
    // 不重载是可断言的稳定事实（真重载会终止 evaluate）
    const state = await page.evaluate(async (p) => ({
      seed: window.__MC_GAME__.seed,
      block: window.__MC_GAME__.world.getBlockId(p.x, p.y, p.z),
      savedColumns: await window.__MC_GAME__.persistence.countSavedColumns(),
    }), placed);
    expect(state.seed, `${name}：不得改 seed`).toBe(12345);
    expect(state.block, `${name}：不得动世界`).not.toBe(0);
    expect(state.savedColumns, `${name}：不得清库`).toBeGreaterThan(0);
  }
});

test('进度导入/导出：busy 锁拒绝并发点击（异步文件读取期间再点无效）', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  await page.locator('#settings-btn').click();
  const result = await page.evaluate(async () => {
    const panel = window.__MC_GAME__.settingsPanel;
    panel._progressBusy = true;                       // 模拟「上一次操作进行中」
    const before = await window.__MC_GAME__.persistence.countSavedColumns();
    // 导出在 busy 时必须直接 return（不得生成下载 / 不得 flush）
    await panel._onExportProgress();
    const out = { busyAfter: panel._progressBusy, disabled: panel._progressExportBtn.disabled };
    panel._progressBusy = false;
    return { ...out, before, after: await window.__MC_GAME__.persistence.countSavedColumns() };
  });
  expect(result.busyAfter).toBe(true);   // 被拒绝的点击不得清掉正在进行的锁
  expect(result.disabled).toBe(false);   // 被拒绝的点击不得改动按钮状态（改了就永久禁用）
  expect(result.after).toBe(result.before);
});

test('面板布局：创造台行两行按钮、主按钮变窄、进度按钮常驻、模型按钮仅激活时可见', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  await page.locator('#settings-btn').click();
  await expect(page.locator('#settings-modal')).toBeVisible();

  const layout = await page.evaluate(() => {
    const panel = window.__MC_GAME__.settingsPanel;
    const row = document.getElementById('btn-playground').closest('.mc-item');
    const line1 = document.getElementById('btn-playground').parentElement;
    const line2 = document.getElementById('btn-playground-export').parentElement;
    const box = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
    const vis = (el) => getComputedStyle(el).display !== 'none';
    const out = {
      title: row.querySelector('.mc-title').textContent,
      line1: line1.className, line2: line2.className,
      sameLine: line1 === line2,
      line1Top: line1.getBoundingClientRect().top,
      line2Top: line2.getBoundingClientRect().top,
      main: box(document.getElementById('btn-playground')),
      progressImport: box(document.getElementById('btn-progress-import')),
      progressExport: box(document.getElementById('btn-progress-export')),
      modelExport: box(document.getElementById('btn-playground-export')),
      modelImport: box(document.getElementById('btn-playground-import')),
      mainLabel: document.getElementById('btn-playground').textContent,
      progressVisibleBefore: vis(document.getElementById('btn-progress-import'))
        && vis(document.getElementById('btn-progress-export')),
      modelsVisibleBefore: vis(document.getElementById('btn-playground-export')),
      // 主按钮文案不得换行（5 个汉字 + 88px 变窄是本次改动的风险点）
      mainScrollW: document.getElementById('btn-playground').scrollWidth,
      mainClientW: document.getElementById('btn-playground').clientWidth,
      // 面板总宽口径（回归防线：面板固定 770px 内容盒）
      panelWidth: Math.round(document.querySelector('#settings-modal .mc-content').getBoundingClientRect().width),
    };
    // 激活创造台 → 模型两个按钮转为可见。
    // ⚠️ 模型按钮的**几何必须在变可见之后量** —— `display:none` 的元素 `getBoundingClientRect()`
    // 恒返回宽 0，用激活前量的值断言会假失败（实测踩坑：断言 `>150` 收到 0）。
    panel._onPlaygroundToggle();
    out.mainLabelAfter = document.getElementById('btn-playground').textContent;
    out.modelsVisibleAfter = vis(document.getElementById('btn-playground-export'));
    out.modelExportAfter = box(document.getElementById('btn-playground-export'));
    out.modelImportAfter = box(document.getElementById('btn-playground-import'));
    out.line2HeightAfter = Math.round(line2.getBoundingClientRect().height);
    out.line1HeightAfter = Math.round(line1.getBoundingClientRect().height);
    out.line2TopAfter = line2.getBoundingClientRect().top;
    out.line1TopAfter = line1.getBoundingClientRect().top;
    // 收尾：把玩家挪出平台再关闭（避免残留状态影响后续用例）
    const o = window.__MC_GAME__.playground.origin();
    if (o) window.__MC_GAME__.player.spawn(o[0] - 20, o[1] + 1, o[2]);
    panel._syncPlaygroundState();
    panel._onPlaygroundToggle();
    return out;
  });

  expect(layout.title).toBe('创造台和进度管理');
  expect(layout.sameLine).toBe(false);                 // 两行：主按钮+进度 / 模型
  expect(layout.line2TopAfter).toBeGreaterThan(layout.line1TopAfter);
  expect(layout.line2HeightAfter).toBeGreaterThan(0);   // 第二行确实占位（不是零高盒）
  expect(layout.main.w).toBeLessThan(100);             // 主按钮变窄（基线 flex:1 时会约 351px）
  expect(layout.progressImport.w).toBeGreaterThan(100); // 进度按钮分到余量
  expect(layout.progressExport.w).toBeGreaterThan(100);
  expect(layout.mainLabel).toBe('打开创造台');
  expect(layout.mainLabelAfter).toBe('关闭创造台');
  expect(layout.mainScrollW).toBeLessThanOrEqual(layout.mainClientW); // 文案不换行
  expect(layout.progressVisibleBefore).toBe(true);      // 进度按钮常驻（与创造台状态无关）
  expect(layout.modelsVisibleBefore).toBe(false);       // 模型按钮仍只在激活时可见
  expect(layout.modelExport.w).toBe(0);                 // 隐藏时确实零宽（可见性判据的另一半）
  expect(layout.modelsVisibleAfter).toBe(true);
  expect(layout.modelExportAfter.w).toBeGreaterThan(150);  // 模型行两个按钮平分整行
  expect(layout.modelImportAfter.w).toBeGreaterThan(150);
  expect(layout.panelWidth).toBe(818);                  // 面板宽度未变（770 内容盒 + 2×20 padding + 2×4 border）
});
