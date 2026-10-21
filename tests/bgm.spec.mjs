// tests/bgm.spec.mjs — v1.63 背景音乐开关（Tier 1：真游戏页的接线）
//
// **为什么必须有这条 E2E**：`src/tests/test-bgm.js` 能证明 AudioManager 的状态机本身正确，
// 但证明不了它在**游戏里被接上了** —— 三个接线点漏任何一个都是静默失效：
//   ① `Game` 构造参数 `bgmEnabled` 取自生效设置（漏 → 默认值来源错误）；
//   ② `Player` 的 canvas 点击调 `unlock()`（漏 → 永远等不到手势，音乐永不响）；
//   ③ 面板「背景音乐」按钮 → `game.setMusicEnabled()`（漏 → 按钮点了没反应）。
// 三条单测都测不到（面板要 DOM、手势要 pointer 事件），故断言必须落在真游戏页。
//
// ⚠️ **不断言「有没有声音」**：无头 Chromium 没有音频输出设备。断言落在可观测状态机上
// （意图位 + buffer 已解码 + context 已 running + `THREE.Audio.isPlaying`），
// 与既有 `AudioManager.play()`「无论能否出声都计请求数」的口径同源。
//
// ⚠️ **两条环境事实决定了本用例的构造方式**：
//   a. Playwright 默认带 `--autoplay-policy=no-user-gesture-required`，AudioContext 一建好就是
//      running → 解码完即自动起播，「手势未到」在生产里不会自发出现。故用例**主动
//      `ctx.suspend()`** 来构造那个状态（实测确可复现：suspend 后停在 false、点击后起播）。
//   b. localhost 上 4MB mp3 可能几十毫秒就解码完 —— 那时「先点击、后解码」这个顺序根本测不到，
//      而它恰是**真实玩家路径**（进游戏第一下点击远早于音乐下载完）。故用 `page.route`
//      把 mp3 推迟 1.5s，把这个顺序**确定性地**造出来。不做这一步时，
//      「preload 完成后不补起播」这个缺陷注入**会漏过**（实测已确认是无效盲区）。
import { test, expect } from 'playwright/test';

/**
 * 起游戏并等世界就绪。
 * `?vd=2` 与既有 spec 同口径（加载半径小 → 稳定快）；`seed` 钉死避免每次地形不同。
 */
async function boot(page, query = '') {
  await page.goto(`/?vd=2&seed=12345${query}`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
}

/** 等 BGM 解码完成（4MB mp3）。超时说明 preload 路径断了。 */
async function waitDecoded(page) {
  await page.waitForFunction(() => window.__MC_GAME__?.audioManager?.debugMusicState().decoded === true,
    null, { timeout: 60_000 });
}

/** 让音乐文件的下载慢一点，把「先点击手势、后解码完成」这个真实顺序造出来。 */
async function delayMusicDownload(page, ms = 1500) {
  await page.route('**/assets/sounds/bgm.mp3', async (route) => {
    await new Promise((r) => setTimeout(r, ms));
    await route.continue();
  });
}

test('背景音乐：手势早于解码也能起播，面板可关可开', async ({ page }) => {
  test.setTimeout(180_000);
  await delayMusicDownload(page);
  await boot(page);

  // ---- ① 构造「玩家想听、但手势与解码都还没到」的真实初始态 ----
  const gate = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    g.setMusicEnabled(false);                        // 清掉自动播放策略可能已起的播
    await g.audioManager.listener.context.suspend(); // 模拟浏览器自动播放拦截
    g.setMusicEnabled(true);                         // 玩家想听
    return { ...g.audioManager.debugMusicState(),
      contextState: g.audioManager.listener.context.state };
  });
  expect(gate.enabled, '默认应处于「想听」状态（settings.bgm 默认 true）').toBe(true);
  expect(gate.contextState, '前置：context 已被挂起').not.toBe('running');
  expect(gate.decoded, '前置：音乐解码尚未完成（route 延迟生效）').toBe(false);
  expect(gate.playing, '条件缺二时不得谎报在播').toBe(false);

  // ---- ② 点画布（手势到位，但解码还没完）：这就是生产里唯一的解锁入口 ----
  await page.locator('#app-canvas').click({ position: { x: 200, y: 200 } });
  await page.waitForFunction(() => window.__MC_GAME__.audioManager.debugMusicState().unlocked === true,
    null, { timeout: 20_000 });
  expect(await page.evaluate(() => window.__MC_GAME__.audioManager.debugMusicState().playing),
    'buffer 还没解码完 → 此处必须仍未起播（否则说明没等 buffer 就硬播了）').toBe(false);

  // ---- ③ 解码完成后必须**自动**补上起播（这一条钉的是 preload 侧的条件对齐） ----
  await waitDecoded(page);
  await page.waitForFunction(() => window.__MC_GAME__.audioManager.debugMusicState().playing === true,
    null, { timeout: 20_000 });
  const st = await page.evaluate(() => window.__MC_GAME__.audioManager.debugMusicState());
  expect(st.volume, 'BGM 音量为 mc-lite 原值 0.15，不受 volume 设置影响').toBe(0.15);

  // ---- ④ 面板「背景音乐 → 关闭」必须真的停播（不是只改按钮高亮） ----
  // 点击画布会拿到 pointer lock，此时其它元素收不到点击（canvas 拦截 pointer events）
  // → 先主动退出锁再点面板（生产里玩家按 Esc 也是同一条路径）。
  await page.evaluate(() => document.exitPointerLock());
  await page.locator('#settings-btn').click();
  const row = page.locator('#settings-modal .mc-item', { hasText: '背景音乐' });
  await expect(row, '面板必须有「背景音乐」一行').toHaveCount(1);
  await expect(row.getByRole('button', { name: '开启' })).toHaveClass(/active/,
    '默认开 → 「开启」按钮高亮');
  await row.getByRole('button', { name: '关闭' }).click();
  await page.waitForFunction(() => window.__MC_GAME__.musicEnabled === false);
  expect(await page.evaluate(() => window.__MC_GAME__.audioManager.debugMusicState().playing),
    '按「关闭」必须真的停播').toBe(false);

  // ---- ⑤ 重新开启 → 立即恢复（buffer 与手势都还在，不该再等一次点击） ----
  await row.getByRole('button', { name: '开启' }).click();
  await page.waitForFunction(() => window.__MC_GAME__.audioManager.debugMusicState().playing === true,
    null, { timeout: 20_000 });

  // ---- ⑥ 面板开关持久化到 localStorage（下次开游戏仍是玩家的选择） ----
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('mc_heavy_settings_v1') || '{}'));
  expect(stored.bgm, '面板改动必须落盘').toBe(true);
});

test('背景音乐：?bgm=0 启动即关，且点击画布不会偷播', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page, '&bgm=0');
  await waitDecoded(page);
  await page.locator('#app-canvas').click({ position: { x: 200, y: 200 } });
  await page.waitForTimeout(500);
  const st = await page.evaluate(() => window.__MC_GAME__.audioManager.debugMusicState());
  expect(st.enabled, '?bgm=0 → 意图位必须为关').toBe(false);
  expect(st.playing, '玩家关了音乐，手势到了也不得偷播').toBe(false);
  // 面板此时应显示「关闭」高亮
  await page.evaluate(() => document.exitPointerLock());
  await page.locator('#settings-btn').click();
  const row = page.locator('#settings-modal .mc-item', { hasText: '背景音乐' });
  await expect(row.getByRole('button', { name: '关闭' })).toHaveClass(/active/);
});
