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
  await page.waitForFunction(() => {
    const el = document.getElementById('loading-overlay');
    if (!el) return true;
    const cs = getComputedStyle(el);
    return cs.display === 'none' || cs.opacity === '0';
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
