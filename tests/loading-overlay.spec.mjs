// tests/loading-overlay.spec.mjs — 启动 loading 占位图（v2.51）
//
// **为什么需要 E2E**：单测做不到（要真实页面生命周期与真实网络），而这条功能的失效
// 形态特别隐蔽 ——
//   ① 占位图由 JS 创建 → 模块解析期间仍是黑屏（占位图**完全失效**，但「游戏能开」）；
//   ② 就绪后没摘掉遮罩 → 玩家看得见世界却点不动（`pointer-events` 挡住画布）；
//   ③ favicon 指错路径 → 标签页图标变空白，浏览器只发一条 404。
// 三者都不会让任何既有断言变红。
//
// ⚠️ **断言必须落在 DOM/请求上，不能靠截图目视**：截图在无头环境里读不出「玩家看到什么」，
// 本仓既有口径也是像素/DOM 几何实测（testing-policy §5）。
import { test, expect } from 'playwright/test';

/** loading 遮罩的就绪前置：`__MC_BOOT__.rendererReady` 为真即世界已可玩。 */
async function bootAndWait(page, query = '') {
  await page.goto(`/?vd=2&seed=12345${query}`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
}

test('loading：占位图与 logo 在页面静态 HTML 里就存在（不依赖 JS）', async ({ page }) => {
  test.setTimeout(180_000);
  // **禁用 JS 的上下文**：这条钉的是「模块还没跑起来时的画面」。若占位图由 main.js 创建，
  // 本例必须看不到它 —— 这是唯一能区分「静态占位」与「JS 创建占位」的判据。
  const noJs = await page.context().newPage();
  await noJs.route('**/*.js', (route) => route.abort());
  await noJs.goto('/');
  const overlay = noJs.locator('#loading-overlay');
  await expect(overlay, '禁用 JS 时占位图必须已经可见（静态 HTML）').toBeVisible();
  // logo 的 naturalWidth > 0 = 图片真的加载成功（不是 404 后的破图占位）
  const logo = await noJs.evaluate(() => {
    const img = document.querySelector('#loading-overlay .mc-loading-logo');
    return img ? { src: img.getAttribute('src'), w: img.naturalWidth, h: img.naturalHeight } : null;
  });
  expect(logo, 'logo 元素必须存在').not.toBeNull();
  expect(logo.src, '素材路径').toBe('./assets/ui/Minecraft-Logo.png');
  expect(logo.w, 'logo 图片必须真的加载成功（naturalWidth > 0）').toBeGreaterThan(0);
  // 「loading 字样」是用户明确要求的
  await expect(noJs.locator('#loading-overlay .mc-loading-text')).toHaveText(/loading/i);
  await noJs.close();
});

test('loading：就绪后自动淡出并让位给画布（不挡点击）', async ({ page }) => {
  test.setTimeout(180_000);
  await bootAndWait(page);

  // ① 就绪后必须是「不可见」——用 display:none 判（渐隐期间仍 visible，故要等它收尾）
  //
  // ⚠️ **等待条件必须与下面的断言一致**（v2.99 修）：旧写法是
  // `cs.display === 'none' || cs.opacity === '0'`，而 `|| opacity === '0'` 会接受一个
  // **断言必然失败**的中间态 —— 淡出的 50ms 窗口里（transition 0.25s 先结束、
  // `setTimeout(300)` 后置 display）opacity 已是 0 而 display 仍是 flex，
  // 条件就此返回，紧接着的 `toBe('none')` 必红（实测报 `Received: "flex"`）。
  // 旧代码碰巧一直绿，是因为 hideLoading 那时跟在 `await game.start()` 后立即执行，
  // 测试等到 worldReady 再发轮询时 300ms 早已过完；v2.99 把 hideLoading 挪到首帧 rAF 之后，
  // 窗口才对上了这次轮询。修的是条件（改成与断言同一个状态），不是放宽断言。
  await page.waitForFunction(() => {
    const el = document.getElementById('loading-overlay');
    if (!el) return true;
    return getComputedStyle(el).display === 'none';
  }, null, { timeout: 20_000 });
  const state = await page.evaluate(() => {
    const el = document.getElementById('loading-overlay');
    const cs = getComputedStyle(el);
    return { display: cs.display, opacity: Number(cs.opacity), pe: cs.pointerEvents };
  });
  expect(state.display, '淡出结束后必须摘成 display:none（残留全屏盒子会参与合成）').toBe('none');

  // ② 画布中心必须命中 canvas 本身 —— 若遮罩还在上层（哪怕 display:block + opacity 0），
  //    `pointer-events:none` 已挡住这种情况，这里再钉一次真实的命中测试。
  const top = await page.evaluate(() => {
    const c = document.getElementById('app-canvas');
    const r = c.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { tag: hit?.tagName, id: hit?.id };
  });
  expect(top.id, '画布中心必须命中 #app-canvas（不是 loading 遮罩）').toBe('app-canvas');

  // ③ 世界已可玩（占位图没把启动卡住）
  expect(await page.evaluate(() => window.__MC_BOOT__.rendererReady)).toBe(true);
});

test('loading：favicon 指向 assets/ui/icon.png 且能取到', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  const href = await page.evaluate(() => document.querySelector('link[rel="icon"]')?.getAttribute('href'));
  expect(href, 'favicon 必须是 mc-lite 的 icon.png，不是 data: 空占位').toBe('./assets/ui/icon.png');
  const response = await page.request.get('/assets/ui/icon.png');
  expect(response.status(), 'favicon 资源必须可访问（否则标签页图标是空白）').toBe(200);
});

// ==================== v2.99：启动进度与「零进展才提示」 ====================
//
// 这三条是本 Epic 的主验收，**失效形态都不能靠既有断言发现**：
//   ① 慢网络下把「网络慢」误报成「启动失败」（用户报告的原缺陷）；
//   ② 进度条倒退 / 冻住（玩家以为卡死，自行刷新）；
//   ③ 真卡住时没有任何诊断与自救入口（对着一根冻住的条无限等）。

/** 给页面套 CDP 限速。档位取自实测：250 KB/s + 250 ms 是本机稳定复现旧缺陷的条件。 */
async function throttle(page, { latencyMs, bytesPerSec }) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: latencyMs,
    downloadThroughput: bytesPerSec,
    uploadThroughput: bytesPerSec,
  });
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
}

test('loading：慢网络（250KB/s）下必须启动成功，不得报「加载超时」', async ({ page }) => {
  // ⚠️ 必须自己放宽超时：全局 200s 装不下「限速下的完整启动」
  // （改动前实测：HEAD 在 147 秒失败于 `column (17,7) 加载超时`）。
  test.setTimeout(600_000);
  await throttle(page, { latencyMs: 250, bytesPerSec: 250_000 });
  await page.goto('/?vd=2&seed=12345', { waitUntil: 'commit' });
  await page.waitForFunction(
    () => window.__MC_BOOT__ && (window.__MC_BOOT__.rendererReady || window.__MC_BOOT__.error),
    null, { timeout: 540_000 },
  );
  const boot = await page.evaluate(() => window.__MC_BOOT__);
  expect(boot.error, `启动必须成功（实际 error=${boot.error}）`).toBeNull();
  expect(boot.rendererReady, '必须走到 rendererReady').toBe(true);
  // 诊断文案不得再出现「加载超时」——那正是把「网络慢」误报成「功能坏了」的那句
  const texts = await page.evaluate(() => ({
    detail: document.getElementById('webgpu-error-detail')?.textContent || '',
    note: document.getElementById('webgpu-error-note')?.textContent || '',
    stat: document.getElementById('loading-stat')?.textContent || '',
  }));
  for (const [k, v] of Object.entries(texts)) {
    expect(v, `${k} 不得包含「加载超时」`).not.toMatch(/加载超时/);
  }
});

test('loading：进度百分比单调不倒退，且最终到 100', async ({ page }) => {
  test.setTimeout(200_000);
  // 在页面里高频采样（跨进程采样会掩盖抖动；100ms 与 UI 同频）
  await page.addInitScript(() => {
    window.__PROGRESS_LOG__ = [];
    setInterval(() => {
      const l = window.__MC_BOOT__?.loading;
      if (l && typeof l.percent === 'number') window.__PROGRESS_LOG__.push(l.percent);
    }, 100);
  });
  await bootAndWait(page);
  await page.waitForFunction(() => window.__MC_BOOT__?.loading?.percent >= 99, null, { timeout: 60_000 });
  const log = await page.evaluate(() => window.__PROGRESS_LOG__);
  expect(log.length, '至少采到若干样本').toBeGreaterThan(5);
  for (let i = 1; i < log.length; i++) {
    expect(log[i], `第 ${i} 个样本倒退：${log[i - 1]} → ${log[i]}`).toBeGreaterThanOrEqual(log[i - 1]);
  }
  expect(Math.max(...log), '最终必须到 100').toBeGreaterThanOrEqual(99.5);
});

test('loading：真卡住时给诊断与自救按钮，且不说「加载超时」', async ({ page }) => {
  // 零进展阈值 60s，留余量：本用例最长 180s
  test.setTimeout(200_000);
  // 挂死结构产物：GEN 永远拿不到布局所需资源 ⇒ 有连接但无进展
  await page.route('**/assets/structures/**', () => new Promise(() => {}));
  await page.goto('/?vd=2&seed=12345', { waitUntil: 'commit' });
  await page.waitForFunction(
    () => { const el = document.getElementById('loading-actions'); return !!el && !el.hidden; },
    null, { timeout: 150_000 },
  );
  const ui = await page.evaluate(() => ({
    stat: document.getElementById('loading-stat')?.textContent || '',
    hasContinue: !!document.getElementById('loading-continue'),
    hasReload: !!document.getElementById('loading-reload'),
    errorBox: document.getElementById('webgpu-error')?.textContent || '',
    errorDisplay: getComputedStyle(document.getElementById('webgpu-error')).display,
  }));
  expect(ui.stat, '必须点名可诊断信息（已加载 N 个脚本 / 无进展）').toMatch(/已加载|无进展|等待/);
  expect(ui.hasContinue, '必须有「继续等待」').toBe(true);
  expect(ui.hasReload, '必须有「重新加载页面」').toBe(true);
  expect(ui.errorBox, '不得出现「加载超时」').not.toMatch(/加载超时/);
  expect(ui.errorDisplay, '不得弹启动错误遮罩（stall 只提示，不判死）').toBe('none');
});
