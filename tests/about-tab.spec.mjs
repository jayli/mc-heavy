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
//
// **用户 2026-11-26 追加**：「在设置面板里关于游戏 tab 的内容里的右下角放一个链接，点击链接
// 跳转到这个技术架构图的 html，这个 html 和游戏的 html 在同一个目录，路径也要用相对路径」。
// 第二条用例守它。⚙️ 链接**不经** `resourceUrl()`（那是仓库根基址），而是 './architecture.html'
// 按**文档基址**解析 —— 用户要的「同目录」语义只有后者能保证，故判据比**解析后的目录**而不是字串后缀。
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

/**
 * 用户 2026-11-26：关于页右下角的技术架构图链接。
 *
 * **为什么必须 E2E 而不是单测**：要证的四件事全部只在真浏览器里成立 ——
 *   ① **位置**：「与图片底边对齐的右下角」是布局事实（链接组底边 ≈ 图片底边、竖直区间在图片内），只有真排版能算；
 *   ② **相对路径且同目录**：必须比 `new URL(href, location.href)` 解析后的**目录**与游戏页相等，
 *      而不是钉字串 —— 写成 '/architecture.html' 在根部署下看起来一模一样，子路径部署才 404；
 *   ③ **新标签真的打开且真的是架构图**：只断言 `target=_blank` 拓不到「文件不存在 / 404」；
 *   ④ **不推高弹框**：链接行不得把关于页撑出纵向滚动条（第一条用例已钉总契约）。
 *
 * ⚠️ **不写死屏幕坐标**：面板位置随视口变，全部判据取 getBoundingClientRect() 的相对关系。
 * ⚠️ **新标签里不能等 `__MC_GAME__`**：架构图是纯静态页（不引 three / 不开 Worker），它永远不会有。
 */
test('关于页右下角：技术架构图链接在同目录、新标签真的打开架构图', async ({ page, context }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=2&seed=12345');
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await openPanel(page);
  await page.locator('#settings-tab-about').click();
  await expect(page.locator('#settings-panel-about')).toBeVisible();

  const link = page.locator('#about-arch-link');
  await expect(link, '关于页必须有架构图链接').toBeVisible();

  // ---- ① 属性：相对路径 / 新标签 / 有文案 ----
  const attrs = await link.evaluate((a) => ({
    href: a.getAttribute('href'),
    resolved: a.href,
    target: a.getAttribute('target'),
    rel: a.getAttribute('rel'),
    text: a.textContent,
    docDir: new URL('.', location.href).href,
    linkDir: new URL('.', a.href).href,
    gamePath: location.pathname,
    linkPath: new URL(a.href).pathname,
  }));
  expect(attrs.text.trim(), '链接必须有可读文案').not.toBe('');
  expect(attrs.text.trim(), '文案是「架构图」（用户 2026-11-26 改短）').toBe('架构图');
  expect(attrs.href.startsWith('/'), 'href 不得是站点根绝对路径（子路径部署会 404）').toBe(false);
  expect(attrs.href, 'href 必须是指向同目录 html 的相对路径').toMatch(/^\.\/[^/]+\.html$/);
  expect(attrs.target, '必须新标签打开（当前页跳转会离开游戏）').toBe('_blank');
  expect(attrs.rel, '新标签需 noopener').toContain('noopener');

  // ---- ② 同目录（用户明确要求）—— 比解析后的目录，不是比字串 ----
  expect(attrs.linkDir, '架构图必须与游戏页在**同一目录**').toBe(attrs.docDir);
  expect(attrs.linkPath.split('/').pop(), '文件名必须是 architecture.html').toBe('architecture.html');
  expect(attrs.gamePath.split('/').pop() || 'index.html', '游戏页本身是 index.html').toBe('index.html');

  // ---- ③ 位置：与图片底边对齐的右下角（**不另起一行**）----
  // ⚠️ 用户 2026-11-26 追加：「改为和图片底边对齐，不要再新起一行了」。
  // 故判据从「链接在图片**下方**」反转为「链接底边 ≈ 图片底边」，且链接不得占据独立行：
  // 它的竖直区间必须**落在图片的竖直区间内**（叠在图片容器右下角空白处）。
  const geom = await page.evaluate(() => {
    const panel = document.getElementById('settings-panel-about');
    const a = document.getElementById('about-arch-link');
    const repo = document.getElementById('about-repo-link');
    const harness = document.getElementById('about-harness-link');
    const img = document.getElementById('about-image');
    const box = document.getElementById('about-arch-link').parentElement;
    const r = (el) => {
      const b = el.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, w: b.width, h: b.height };
    };
    return {
      panel: r(panel), link: r(a), repo: r(repo), harness: r(harness), img: r(img), links: r(box),
      pos: getComputedStyle(box).position,
      order: [...box.querySelectorAll('a')].map((x) => x.id),
      panelScroll: [panel.scrollHeight, panel.clientHeight],
    };
  });
  expect(geom.link.w, '链接必须真的渲染出面积').toBeGreaterThan(20);
  expect(geom.link.h).toBeGreaterThan(8);
  expect(geom.pos, '链接组必须绝对定位（否则会占一行把图片顶短）').toBe('absolute');
  // 右对齐：三条链接右边缘一致且贴面板右
  expect(geom.panel.right - geom.link.right, '架构图链接必须靠面板右侧').toBeLessThanOrEqual(2);
  expect(geom.panel.right - geom.repo.right, '仓库链接必须右对齐').toBeLessThanOrEqual(2);
  expect(geom.panel.right - geom.harness.right, 'harness 链接必须右对齐').toBeLessThanOrEqual(2);
  expect(Math.abs(geom.link.right - geom.repo.right), '架构图与仓库右边缘必须对齐').toBeLessThanOrEqual(1);
  expect(Math.abs(geom.repo.right - geom.harness.right), '仓库与 harness 右边缘必须对齐').toBeLessThanOrEqual(1);
  expect(geom.link.left, '链接只占右下角，不得横跨整行')
    .toBeGreaterThan(geom.panel.left + geom.panel.w * 0.5);
  // 底边对齐（本轮的核心诉求）：链接组底边 ≈ 图片底边，而不是在图片下方另起一行
  expect(Math.abs(geom.links.bottom - geom.img.bottom), '链接组底边必须与图片底边对齐')
    .toBeLessThanOrEqual(2);
  expect(geom.links.top, '链接组不得另起一行（竖直区间必须在图片内）')
    .toBeGreaterThanOrEqual(geom.img.top - 1);
  // 上下顺序：架构图 → 仓库地址 → harness 工具（用户指定的次序）
  expect(geom.order, '链接顺序必须是架构图 / 仓库地址 / harness 工具')
    .toEqual(['about-arch-link', 'about-repo-link', 'about-harness-link']);
  expect(geom.repo.top, '仓库链接必须在架构图链接下方').toBeGreaterThanOrEqual(geom.link.bottom - 1);
  expect(geom.harness.top, 'harness 链接必须在仓库链接下方').toBeGreaterThanOrEqual(geom.repo.bottom - 1);
  expect(geom.harness.bottom, '最后一条链接不得溢出面板').toBeLessThanOrEqual(geom.panel.bottom + 1);
  expect(geom.img.bottom, '图片仍须完整在面板内').toBeLessThanOrEqual(geom.panel.bottom + 1);
  expect(geom.panelScroll[0], '关于页仍不得出现纵向滚动条')
    .toBeLessThanOrEqual(geom.panelScroll[1] + 1);

  // ---- ③b 仓库链接：外站 GitHub、新标签 ----
  const repoAttrs = await page.locator('#about-repo-link').evaluate((a) => ({
    href: a.getAttribute('href'), target: a.getAttribute('target'),
    rel: a.getAttribute('rel'), text: a.textContent,
  }));
  expect(repoAttrs.href, '仓库地址必须是用户指定的 GitHub 地址')
    .toBe('https://github.com/jayli/mc-heavy');
  expect(repoAttrs.target, '仓库链接也要新标签打开').toBe('_blank');
  expect(repoAttrs.rel, '外站新标签需 noopener').toContain('noopener');
  expect(repoAttrs.text.trim(), '仓库链接必须有可读文案').not.toBe('');

  // ---- ③c harness 工具链接：外站 pi.dev、新标签 ----
  const harnessAttrs = await page.locator('#about-harness-link').evaluate((a) => ({
    href: a.getAttribute('href'), target: a.getAttribute('target'),
    rel: a.getAttribute('rel'), text: a.textContent,
  }));
  expect(harnessAttrs.href, 'harness 地址必须是用户指定的 pi.dev 包地址')
    .toBe('https://pi.dev/packages/@bachi/pi-coder');
  expect(harnessAttrs.target, 'harness 链接也要新标签打开').toBe('_blank');
  expect(harnessAttrs.rel, '外站新标签需 noopener').toContain('noopener');
  expect(harnessAttrs.text.trim(), '文案是「harness 工具」').toBe('harness 工具');

  // ---- ④ 真的点下去：新标签打开的确实是架构图（而不只是 target 属性对）----
  const popupPromise = context.waitForEvent('page');
  await link.click();
  const arch = await popupPromise;
  await arch.waitForLoadState('domcontentloaded');
  // 直接请求同一 URL 核 HTTP 状态：文件不存在时 popup 会拿到 404 页，光看 title 拓不到
  const status = (await arch.request.get(arch.url())).status();
  expect(status, '架构图 URL 必须 200（文件真的在游戏页同目录）').toBe(200);
  expect(new URL(arch.url()).pathname, '新标签地址必须与 href 解析结果一致')
    .toBe(new URL(attrs.resolved).pathname);
  await expect(arch).toHaveTitle(/技术架构图/);
  // 首屏内容：分层图与两条管线的锚点真的存在（不是空页 / 不是 404 页）
  expect(await arch.locator('#layers').count(), '架构图必须有分层节').toBe(1);
  expect(await arch.locator('#gen').count(), '架构图必须有 GEN 管线节').toBe(1);
  expect(await arch.locator('#edit').count(), '架构图必须有编辑管线节').toBe(1);
  expect(await arch.locator('#redlines').count(), '架构图必须有红线节').toBe(1);
  const backHref = await arch.locator('nav .back a').getAttribute('href');
  expect(backHref, '返回链接也必须是相对路径').toBe('./index.html');
  expect(await page.evaluate(() => window.__MC_GAME__?.worldReady === true),
    '游戏页必须仍在运行（链接不得把当前页导航走）').toBe(true);
  await arch.close();
});
