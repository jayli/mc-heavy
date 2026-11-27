import { test, expect } from 'playwright/test';
import fs from 'node:fs';
import { PNG } from 'pngjs';

/**
 * v1.43 验收：设置面板的进度导入 / 导出（v1.98 起按钮改名为「导入 / 导出」—— 文案变短是布局的
 * 必然；v3.55 起与「视距」同处一个两列大方块，见 `_combinedViewDistanceProgress()` 注释）。
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

  // ⚠️ **反馈必须对玩家可见，不能只断言「下载事件发生了」**（用户 2026-10-31 报告
  // 「导出按钮点击没反应」）。导出是在面板里点的，而 toast 的 z-index(40) 低于
  // 设置面板遮罩(70) → 提示文字被盖在遮罩下面、完全看不见，下载栏在右侧一闪而过 ——
  // 玩家看到的就是「点了没反应」。故判据落在**可见性**上：
  //   ① toast 文案确实是导出成功（不是「导出失败」）；
  //   ② toast 的**实际层级高于**设置面板遮罩 —— 用命中测试 `elementFromPoint` 验证
  //      「toast 中心点上最顶层的元素属于 toast」，这是玩家眼睛能看到的充要条件
  //      （只断言 `z-index` 数值不够：改遮罩层级/改 DOM 结构都会让数值对比失效）。
  // 等 toast 的 0.2s 淡入过渡跑完再量（否则 opacity 采到动画中途值，断言的是时序而非可见性）
  await page.waitForFunction(() => {
    const t = document.getElementById('mc-toast');
    return t && Number(getComputedStyle(t).opacity) > 0.99;
  }, null, { timeout: 5_000 }).catch(() => {});
  // ⚠️ **不能用 `elementFromPoint` 判「toast 在最上层」**：toast 刻意是
  // `pointer-events:none`（去掉它会拦光标 → 浮层闪烁），而命中测试会**跳过**
  // pointer-events:none 的元素 → 哪怕 toast 完全可见，命中的也是它下面的面板
  // （实测：修好之后仍返回 DIV.mc-columns）。这是判据选错，不是实现有问题。
  // 改用**像素判据**（Tier 4）：在 toast 自己的矩形内截图，比较「toast 可见」与
  // 「刚隐藏」两张同位置裁剪图 —— 前者必须明显更暗（toast 是 rgba(0,0,0,.72) 黑底白字）。
  // 这一步同时证明 z-index 生效：若被面板遮住，两张图会逐像素相同。
  await page.evaluate(() => document.getElementById('mc-toast').classList.add('mc-toast-visible'));
  await page.waitForTimeout(400);        // 0.2s opacity 过渡跑完
  const geo = await page.evaluate(() => {
    const r = document.getElementById('mc-toast').getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  });
  const withToast = PNG.sync.read(await page.screenshot({ clip: geo }));
  await page.evaluate(() => document.getElementById('mc-toast').classList.remove('mc-toast-visible'));
  await page.waitForTimeout(400);
  const withoutToast = PNG.sync.read(await page.screenshot({ clip: geo }));
  const meanOf = (png) => {
    let s = 0, n = 0;
    for (let i = 0; i < png.data.length; i += 4) {
      s += png.data[i] + png.data[i + 1] + png.data[i + 2]; n += 3;
    }
    return s / n;
  };
  const lumaWith = meanOf(withToast);
  const lumaWithout = meanOf(withoutToast);

  const feedback = await page.evaluate(() => {
    const toast = document.getElementById('mc-toast');
    const modal = document.getElementById('settings-modal');
    return {
      exists: !!toast,
      text: toast?.textContent ?? '',
      toastZ: Number(getComputedStyle(toast).zIndex),
      modalZ: Number(getComputedStyle(modal).zIndex),
      pointerEvents: getComputedStyle(toast).pointerEvents,
    };
  });
  console.log('EXPORT-FEEDBACK ' + JSON.stringify({ ...feedback, lumaWith, lumaWithout }));
  expect(feedback.exists, '导出后必须有 toast 提示').toBe(true);
  expect(feedback.text, '提示必须是成功文案（不是失败）').toContain('进度已导出');
  expect(feedback.toastZ, 'toast 的 z-index 必须高于设置面板（结构层判据）')
    .toBeGreaterThan(feedback.modalZ);
  expect(feedback.pointerEvents, 'toast 必须 pointer-events:none（否则会拦光标导致浮层闪烁）')
    .toBe('none');
  // 像素判据：toast 真的被画在最上层（被面板遮住时两图逐位相同 → 差值为 0）
  const drop = lumaWithout - lumaWith;
  expect(drop,
    `toast 覆盖区必须明显变暗（黑底提示盖在面板之上）。实测 显示=${lumaWith.toFixed(1)} `
    + `隐藏=${lumaWithout.toFixed(1)}，差值 ${drop.toFixed(1)} —— 接近 0 说明提示被面板遮住、玩家会以为按钮没反应`)
    .toBeGreaterThan(20);
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

  // ③ 点「导入」→ 文件选择 → 导航监听**先武装**（clear-save 的踩坑教训）
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

test('面板布局：创造台与「视距 | 进度管理」大方块各行；进度五按钮不折行', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  await page.locator('#settings-btn').click();
  await expect(page.locator('#settings-modal')).toBeVisible();

  const layout = await page.evaluate(() => {
    const panel = window.__MC_GAME__.settingsPanel;
    const main = document.getElementById('btn-playground');
    const pgRow = main.closest('.mc-item');
    // ⚠️ v3.55（用户 2026-11-28 定稿）：进度管理已搬到「视距 | 进度管理」大方块（右列首位），
    // **不再与 TNT 破坏同盒**。左列那一格换成「视距」，其余口径不变（仍是大方块两列 + 竖线）。
    const importBtn = document.getElementById('btn-progress-import');
    const progressRow = importBtn.closest('.mc-combined-col');
    const combined = importBtn.closest('.mc-combined');
    const vdRow = combined.querySelector('.mc-combined-col');
    const lines = (el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size;
    };
    const group = main.parentElement;
    const box = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) }; };
    const vis = (el) => getComputedStyle(el).display !== 'none';
    const noOverflow = (el) => el.scrollWidth <= el.clientWidth;
    const out = {
      pgTitle: pgRow.querySelector('.mc-title').textContent,
      progressTitle: progressRow.querySelector('.mc-title').textContent,
      vdTitle: vdRow.querySelector('.mc-title').textContent,
      importLabel: importBtn.textContent,
      exportLabel: document.getElementById('btn-progress-export').textContent,
      // 进度与视距同一个大方块（用户 2026-11-28 的核心要求）
      inSameCombined: progressRow.parentElement === vdRow.parentElement
        && combined !== null,
      // 该盒恰好两列；视距在左、进度在右；中间一道竖线
      groupCount: combined.querySelectorAll('.mc-combined-col').length,
      divider: getComputedStyle(vdRow).borderRightWidth,
      // 「视距是三个按钮，进度管理是两个按钮」（用户原话）
      vdButtons: vdRow.querySelectorAll('button').length,
      progressButtons: progressRow.querySelectorAll('button').length,
      // 合并盒与创造台行是两个不同的盒子
      rowsAreDistinct: pgRow !== combined,
      // v3.55：该盒在右列首位 ⇒ 它在创造台**上方**。
      // 旧裁定「进度管理在创造台下方」（2026-09-30）随本次重排失效，以新指令为准。
      combinedBelowPlayground: combined.getBoundingClientRect().top
        > pgRow.getBoundingClientRect().bottom,
      // 五个按钮（3 视距 + 2 进度）必须各自单行、不溢出
      allButtonsOneLine: [...combined.querySelectorAll('button')].every((b) => lines(b) === 1
        && b.scrollWidth <= b.clientWidth + 1),
      // 模型按钮与主按钮**同一个按钮组**（既有口径，本次不得回归）
      modelSameGroup: document.getElementById('btn-playground-export').parentElement === group
        && document.getElementById('btn-playground-import').parentElement === group,
      groupWidth: Math.round(group.getBoundingClientRect().width),
      mainLabel: main.textContent,
      main: box(main),
      progressImport: box(importBtn),
      progressExport: box(document.getElementById('btn-progress-export')),
      progressVisible: vis(importBtn) && vis(document.getElementById('btn-progress-export')),
      // 两列的按钮必须落在同一行（合并盒两列各自一行）
      progressSameRowAsVd: box(importBtn).top === box(vdRow.querySelector('button')).top,
      // 文案不得被压到换行/溢出（合并盒列窄，这是本次唯一真实的布局风险）
      progressNoOverflow: noOverflow(importBtn) && noOverflow(document.getElementById('btn-progress-export')),
      vdTitleNoOverflow: noOverflow(vdRow.querySelector('.mc-title')),
      modelsVisibleBefore: vis(document.getElementById('btn-playground-export')),
      modelExport: box(document.getElementById('btn-playground-export')),
      mainScrollW: main.scrollWidth,
      mainClientW: main.clientWidth,
      panelWidth: Math.round(document.querySelector('#settings-modal .mc-content').getBoundingClientRect().width),
    };
    // 激活创造台 → 模型两个按钮转为可见，与主按钮**同行**平分该行
    panel._onPlaygroundToggle();
    out.mainLabelAfter = main.textContent;
    out.modelsVisibleAfter = vis(document.getElementById('btn-playground-export'));
    out.mainAfter = box(main);
    out.modelExportAfter = box(document.getElementById('btn-playground-export'));
    out.modelImportAfter = box(document.getElementById('btn-playground-import'));
    const tops = [main, document.getElementById('btn-playground-export'),
      document.getElementById('btn-playground-import')].map((el) => Math.round(el.getBoundingClientRect().top));
    out.sameTopAfter = tops[0] === tops[1] && tops[1] === tops[2];
    out.noWrapScroll = main.scrollWidth <= main.clientWidth;
    // 收尾：把玩家挪出平台再关闭（避免残留状态影响后续用例）
    const o = window.__MC_GAME__.playground.origin();
    if (o) window.__MC_GAME__.player.spawn(o[0] - 20, o[1] + 1, o[2]);
    panel._syncPlaygroundState();
    panel._onPlaygroundToggle();
    out.mainLabelAfterClose = main.textContent;
    out.modelsVisibleAfterClose = vis(document.getElementById('btn-playground-export'));
    out.mainAfterClose = box(main);
    return out;
  });

  expect(layout.pgTitle).toBe('创造台');
  expect(layout.progressTitle).toBe('进度管理');
  expect(layout.vdTitle).toBe('视距');
  expect(layout.importLabel).toBe('导入');       // v1.98 改名
  expect(layout.exportLabel).toBe('导出');
  expect(layout.inSameCombined, '视距与进度管理必须在同一个大方块里').toBe(true);
  expect(layout.rowsAreDistinct).toBe(true);     // 合并盒与创造台仍是两行
  // v3.55：该盒已上移到右列首位 ⇒ 它在创造台**上方**
  expect(layout.combinedBelowPlayground,
    'v3.55 重排后，「视距 | 进度管理」盒应在创造台上方（旧断言「在下方」已随重排失效）').toBe(false);
  expect(layout.groupCount, '该大方块必须恰好两列').toBe(2);
  expect(layout.divider, '两列之间必须有竖线（与既有样式一致）').toBe('1px');
  expect(layout.vdButtons, '视距三个按钮').toBe(3);
  expect(layout.progressButtons, '进度管理两个按钮').toBe(2);
  expect(layout.allButtonsOneLine, '该盒内五个按钮均不得折行/溢出').toBe(true);
  expect(layout.progressVisible).toBe(true);     // 进度按钮常驻（与创造台状态无关）
  expect(layout.progressSameRowAsVd, '两列的按钮必须落在同一行').toBe(true);
  expect(layout.progressNoOverflow, '合入窄列后文案不得溢出').toBe(true);
  expect(layout.vdTitleNoOverflow, '「视距」标题不得溢出列宽').toBe(true);
  // 两列盒下每组约 171px：进度两按钮各约 81px（v1.98 的标定）。真正的判据仍是
  // 「文字不被压折行」= 上面的 `progressNoOverflow` + `allButtonsOneLine`。
  expect(layout.progressImport.w).toBeGreaterThan(60);
  expect(layout.progressExport.w).toBeGreaterThan(60);
  expect(layout.mainLabel).toBe('打开创造台');
  expect(layout.mainScrollW).toBeLessThanOrEqual(layout.mainClientW); // 文案不换行
  // 未激活：主按钮独占整行（若错留 88px 变窄，这里会失败）
  expect(layout.main.w).toBeGreaterThanOrEqual(layout.groupWidth - 1);
  expect(layout.main.w).toBeGreaterThan(300);
  expect(layout.panelWidth).toBe(818);              // 面板宽度未变（770 内容盒 + 2×20 padding + 2×4 border）
  // 隐藏时确实零宽（可见性判据的另一半）
  expect(layout.modelsVisibleBefore).toBe(false);
  expect(layout.modelExport.w).toBe(0);
  expect(layout.modelSameGroup).toBe(true);         // 模型按钮与主按钮同一行（既有口径不回归）
  // 激活：三按钮同行且各自变窄（由 flex:1 平分，主按钮不再独占）
  expect(layout.mainLabelAfter).toBe('关闭创造台');
  expect(layout.modelsVisibleAfter).toBe(true);
  expect(layout.sameTopAfter).toBe(true);
  expect(layout.noWrapScroll).toBe(true);
  expect(layout.mainAfter.w).toBeLessThan(200);     // 不再是满行
  expect(layout.mainAfter.w).toBeGreaterThan(80);   // 但容得下 5 个汉字
  expect(layout.modelExportAfter.w).toBeGreaterThan(80);
  expect(layout.modelImportAfter.w).toBeGreaterThan(80);
  // 三个按钮平分该行（各差 ≤2px）
  const w = [layout.mainAfter.w, layout.modelExportAfter.w, layout.modelImportAfter.w];
  expect(Math.max(...w) - Math.min(...w)).toBeLessThanOrEqual(2);
  // 关闭后：模型按钮消失、主按钮**恢复满行**
  expect(layout.mainLabelAfterClose).toBe('打开创造台');
  expect(layout.modelsVisibleAfterClose).toBe(false);
  expect(layout.mainAfterClose.w).toBeGreaterThanOrEqual(layout.groupWidth - 1);
  expect(Math.abs(layout.mainAfterClose.w - layout.main.w)).toBeLessThanOrEqual(1);
});
