// tests/about-tab.spec.mjs — 设置弹窗的两个 Tab（「游戏设置」/「关于游戏」，v3.25）
//
// **用户 2026-11-20 需求**：「游戏设置中增加一个 Tab，第一个 Tab 就是现在的配置信息『游戏设置』，
// 第二个 Tab 是『关于游戏』；切换 Tab 的时候整个设置弹框的尺寸不变。确定按钮在 Tab 内容之外。
// 确定按钮变长一倍。」「关于游戏」里放一段文案 + 一张三年级小朋友手写的提示词图
// （`assets/about/prompt.png`）。
//
// **为什么必须有这条 E2E**（单测证不了的三件事）：
//   ① 弹框尺寸在切换前后**逐位不变** —— 这是布局契约，只有真浏览器能算；
//   ② 「确定按钮在 Tab 内容之外」= 它不得是任一面板的 DOM 后代，且两个 Tab 下尺寸位置一致；
//   ③ 图片真的从 `resourceUrl()` 解析出的地址加载成功（4032×3024）—— 路径写错只会在
//      「切到关于页」时表现为破图，绝不会有报错。
import { test, expect } from 'playwright/test';

const READY = () => window.__MC_GAME__?.worldReady === true;

/** 打开面板（用 `#settings-btn` 的真实点击，与玩家路径一致） */
async function openPanel(page) {
  await page.locator('#settings-btn').click();
  await expect(page.locator('#settings-modal')).toBeVisible();
}

/** 量当前页签状态：尺寸、页签 active、确定按钮盒、面板可见性与溢出 */
const MEASURE = () => {
  const modal = document.getElementById('settings-modal');
  const content = modal.querySelector('.mc-content');
  const main = content.querySelector('#settings-panel-main');
  const about = content.querySelector('#settings-panel-about');
  const close = document.getElementById('settings-close');
  const footer = content.querySelector('.mc-footer');
  const box = (el) => {
    const b = el.getBoundingClientRect();
    return { w: Math.round(b.width * 100) / 100, h: Math.round(b.height * 100) / 100 };
  };
  return {
    tab: window.__MC_GAME__.settingsPanel._tab,
    content: box(content),
    contentScroll: [content.scrollHeight, content.clientHeight],
    footer: box(footer),
    close: box(close),
    closeInPanel: !!(close.closest('.mc-tab-panel')),
    tabs: [...modal.querySelectorAll('.mc-tab')].map((b) => ({
      id: b.id,
      text: b.textContent,
      active: b.classList.contains('active'),
      box: box(b),
    })),
    mainShown: getComputedStyle(main).display !== 'none',
    aboutShown: getComputedStyle(about).display !== 'none',
    mainScroll: [main.scrollHeight, main.clientHeight],
    aboutScroll: [about.scrollHeight, about.clientHeight],
  };
};

test('关于游戏 Tab：两个页签、切换弹框尺寸不变、确定按钮在内容之外且宽度翻倍', async ({ page }) => {
  test.setTimeout(180_000);
  // 记录关于页图片的请求时机 —— 图片是 14MB，必须延迟到首次切页才请求
  const imageRequests = [];
  page.on('request', (r) => { if (r.url().includes('assets/about/prompt.png')) imageRequests.push(r.url()); });

  await page.goto('/?vd=2&seed=12345');
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await openPanel(page);

  // ---- ① 页签：两个、等宽、文案与顺序是用户指定的 ----
  const init = await page.evaluate(MEASURE);
  expect(init.tab, '打开面板默认停在第一个 Tab「游戏设置」').toBe('settings');
  expect(init.tabs.map((t) => t.text)).toEqual(['游戏设置', '关于游戏']);
  expect(init.tabs.map((t) => t.id)).toEqual(['settings-tab-settings', 'settings-tab-about']);
  expect(init.tabs[0].active).toBe(true);
  expect(init.tabs[1].active).toBe(false);
  expect(init.mainShown).toBe(true);
  expect(init.aboutShown).toBe(false);
  // 两个页签等宽（flex:1 平分）—— 这条同时钉住「高度写死 40px」不被文案撑开
  expect(init.tabs[0].box.w).toBe(init.tabs[1].box.w);
  expect(init.tabs[0].box.h).toBe(init.tabs[1].box.h);
  expect(init.tabs[0].box.h, '页签高度固定 40px（切换时不得变）').toBe(40);

  // ---- ② 确定按钮：在 Tab 内容之外 + 宽度是改前（78px）的两倍 ----
  expect(init.closeInPanel, '确定按钮不得位于任一 Tab 面板内部').toBe(false);
  expect(init.close.w, '确定按钮宽度 = 78 × 2').toBe(156);
  expect(init.close.w / 2).toBe(78);   // 自证「翻倍」的基准（改前一版实测 78px）

  // ---- ③ 「游戏设置」页内容完整、无滚动条 ----
  expect(init.contentScroll[0], '游戏设置页不得出现纵向滚动条')
    .toBeLessThanOrEqual(init.contentScroll[1] + 1);
  expect(await page.locator('#settings-panel-main .mc-columns').count()).toBe(1);
  expect(await page.locator('#settings-modal .mc-combined').count(), '既有档位组必须还在')
    .toBeGreaterThanOrEqual(4);

  // ---- ④ 切到「关于游戏」 ----
  expect(imageRequests.length, '关于页图片不得在打开面板时就请求（14MB，延迟到首次切页）').toBe(0);
  await page.locator('#settings-tab-about').click();
  await expect(page.locator('#settings-panel-about')).toBeVisible();
  // 等图片真的下载完（14MB 原图，本地也要几百毫秒）—— 不等就量 naturalWidth 拿到 0
  await page.waitForFunction(() => {
    const img = document.getElementById('about-image');
    return img && img.complete && img.naturalWidth > 0;
  }, null, { timeout: 60_000 });
  const about = await page.evaluate(MEASURE);
  expect(about.tab).toBe('about');
  expect(about.tabs[1].active).toBe(true);
  expect(about.tabs[0].active).toBe(false);
  expect(about.mainShown).toBe(false);

  // 尺寸不变（用户明确要求）—— 三处逐位相等，任一处变化都会让弹窗跳动
  expect(about.content, '切换 Tab 后弹框尺寸必须逐位不变').toEqual(init.content);
  expect(about.content.h, '内容盒高 = 用户指定的 560（+边框/内边距 = 608）').toBe(608);
  expect(about.close, '确定按钮尺寸/位置不得随 Tab 变化').toEqual(init.close);
  expect(about.footer, '底栏尺寸不得随 Tab 变化').toEqual(init.footer);
  expect(about.tabs.map((t) => t.box), '页签尺寸不得随选中态变化').toEqual(init.tabs.map((t) => t.box));
  expect(about.aboutScroll[0], '关于游戏页不得出现纵向滚动条')
    .toBeLessThanOrEqual(about.aboutScroll[1] + 1);

  // ---- ⑤ 文案与配图 ----
  const aboutContent = await page.evaluate(() => {
    const img = document.getElementById('about-image');
    const panel = document.getElementById('settings-panel-about');
    const pb = panel.getBoundingClientRect();
    const ib = img.getBoundingClientRect();
    return {
      text: document.querySelector('.mc-about-text').textContent,
      // 配图旁**不得有旁白**（用户 2026-11-20 裁定）
      noCaption: document.querySelector('#settings-panel-about .mc-about-caption') === null,
      src: img.getAttribute('src'),
      alt: img.getAttribute('alt'),
      natural: [img.naturalWidth, img.naturalHeight],
      complete: img.complete,
      imgBox: [Math.round(ib.width), Math.round(ib.height)],
      // 图片必须完整落在面板内（不能溢出到「确定」按钮或面板边框外）
      inside: ib.top >= pb.top - 1 && ib.bottom <= pb.bottom + 1
        && ib.left >= pb.left - 1 && ib.right <= pb.right + 1,
    };
  });
  // 文案是用户给的原文（钉住「没有被摘要/改写」这个事实，不钉排版）
  expect(aboutContent.text).toContain('我上小学三年级');
  expect(aboutContent.text).toContain('爸爸给我做了一个“我的世界”让我偷偷玩');
  expect(aboutContent.text).toContain('只要我语文再考优');
  expect(aboutContent.text.length).toBeGreaterThan(100);
  expect(aboutContent.noCaption, '图片旁不得有任何旁白（用户 2026-11-20 裁定的那句话已删）').toBe(true);
  expect(aboutContent.src, '图片地址必须指向 assets/about/prompt.png（经 resourceUrl 解析）')
    .toMatch(/\/assets\/about\/prompt\.png$/);
  expect(aboutContent.complete, '图片必须加载完成（路径写错时这里为 false）').toBe(true);
  expect(aboutContent.natural, '原图 4032×3024').toEqual([4032, 3024]);
  expect(aboutContent.alt.length, '图片必须有替代文本').toBeGreaterThan(10);
  expect(aboutContent.imgBox[0], '图片必须真的渲染出面积').toBeGreaterThan(200);
  expect(aboutContent.imgBox[1]).toBeGreaterThan(150);
  expect(aboutContent.inside, '图片必须完整落在面板内').toBe(true);
  expect(imageRequests.length, '切到关于页后图片必须真的被请求').toBe(1);

  // ---- ⑥ 切回「游戏设置」：尺寸仍不变，内容没有丢 ----
  await page.locator('#settings-tab-settings').click();
  const back = await page.evaluate(MEASURE);
  expect(back.tab).toBe('settings');
  expect(back.content).toEqual(init.content);
  expect(back.close).toEqual(init.close);
  expect(await page.locator('#btn-teleport-tarn').count(), '切回来瞬移行仍在（面板不是重建的）').toBe(1);

  // ---- ⑦ 确定按钮在两个 Tab 下都能关掉面板（它在内容之外 ⇒ 与页签无关） ----
  await page.locator('#settings-tab-about').click();
  await page.locator('#settings-close').click();
  await expect(page.locator('#settings-modal')).toBeHidden();
  expect(await page.evaluate(() => window.__MC_GAME__.uiModal)).toBe(false);

  // 重新打开回到第一个 Tab（玩家点 ⚙ 时预期看到的是设置）。
  // ⚠️ close() 会向 canvas 申请 pointer lock；成功后浏览器把鼠标事件定向给 canvas，
  // Playwright 的 hit-test 会报「canvas intercepts pointer events」⇒ 先主动退出锁再点。
  await page.evaluate(() => document.exitPointerLock?.());
  await openPanel(page);
  expect(await page.evaluate(() => window.__MC_GAME__.settingsPanel._tab)).toBe('settings');
});
