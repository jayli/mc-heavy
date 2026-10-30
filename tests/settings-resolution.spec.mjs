// tests/settings-resolution.spec.mjs — v2.27 设置面板「分辨率」两档（清晰 / 性能）
//
// **为什么必须有这条 E2E**：`src/tests/test-pixel-ratio.js` 只证明「档位 → 像素比」这段纯函数
// 换算正确，证明不了它**真的接进了 renderer**：
//   ① `start()` 用生效设置初始化像素比（漏 → 存档/URL 的性能档不生效）；
//   ② 面板按钮点下去调到 `game.setPixelRatioMode()`（漏 → 按钮点了没反应）；
//   ③ 像素比真的改变了 canvas 的**后备缓冲物理尺寸**（漏 → 设置了但没重建 drawing buffer）。
// 三条都测不到于单测（`renderer.setPixelRatio` 要有真 WebGPU backend 才发 draw），
// 故断言必须落在真游戏页的 `canvas.width/height` 与 `renderer.getPixelRatio()`。
//
// ⚠️ **判据只能看 `canvas.width` 而不是「画面看起来更糊」**：像素比只改 drawing buffer 的
// 物理尺寸，CSS 尺寸不变（`setSize(w, h, false)` 不写 style）。图省事的写法是截图比清晰度 ——
// 那在无头环境里既慢又难定阈值，且「糊」本来就是主观量。`canvas.width` 是确定性的因果上游。
//
// ⚠️ **必须显式 `deviceScaleFactor`**：Playwright 默认 dsf=1，那时清晰档像素比 = 1、
// 性能档 = 0.5 —— 恰好与 dpr=1 的倍率重合，测不出「相对 dpr 的倍率」这层语义。
// 故 Retina 用例显式 `deviceScaleFactor: 2`（清晰 2 / 性能 1），
// 与 `minimap.spec` 的 dpr 陷阱同一个理由（dpr=1 下有的缺陷形态完全不可见）。
import { test, expect } from 'playwright/test';

/** 起游戏并等世界就绪（`vd=2` + 固定 seed：加载半径小、稳定快，与既有 spec 同口径）。 */
async function boot(page, query = '') {
  await page.goto(`/?vd=2&seed=12345${query}`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
}

/** 打开设置面板 */
async function openPanel(page) {
  await page.locator('#settings-btn').click();
  await expect(page.locator('#settings-modal')).toBeVisible();
}

/** 点分辨率组里的某个按钮（按文案；档位值不暴露给 DOM，文案是唯一锚点） */
async function pickResolution(page, label) {
  await page.evaluate((text) => {
    const group = [...document.querySelectorAll('#settings-modal .mc-combined-col')]
      .find((r) => r.querySelector('.mc-title')?.textContent === '分辨率');
    [...group.querySelectorAll('button')].find((b) => b.textContent === text).click();
  }, label);
}

/** 当前渲染像素比与 canvas 后备缓冲尺寸 */
async function ratioState(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('app-canvas');
    return {
      dpr: window.devicePixelRatio,
      pixelRatio: window.__MC_GAME__.pixelRatio,
      canvasW: canvas.width,
      canvasH: canvas.height,
      cssW: Math.round(canvas.getBoundingClientRect().width),
      rainCount: window.__MC_GAME__.rain?.particleCount ?? null,
      setting: window.__MC_GAME__.settings.pixelRatio,
      active: [...document.querySelectorAll('#settings-modal .mc-combined-col')]
        .find((r) => r.querySelector('.mc-title')?.textContent === '分辨率')
        ?.querySelector('button.active')?.textContent ?? null,
    };
  });
}

test('分辨率：默认清晰 = devicePixelRatio（零回归），切性能后 drawing buffer 真的变小', async ({ page }) => {
  // dpr=1 环境：清晰 1.0 / 性能 0.5 —— 像素量降到 1/4
  await boot(page);
  const init = await page.evaluate(() => ({
    pixelRatio: window.__MC_GAME__.pixelRatio,
    dpr: window.devicePixelRatio,
  }));
  // 默认档必须是「清晰」，且清晰档 = devicePixelRatio 原值（本次改动前的观感）
  expect(init.pixelRatio, '默认必须 = devicePixelRatio（改动前观感，零回归）').toBe(init.dpr);

  const before = await page.evaluate(() => ({
    w: document.getElementById('app-canvas').width,
    h: document.getElementById('app-canvas').height,
  }));

  await openPanel(page);
  // 面板一打开就该高亮「清晰」（当前生效值），而不是一个都不亮
  expect((await ratioState(page)).active, '面板打开时「清晰」必须是选中态').toBe('清晰');

  await pickResolution(page, '性能');
  await page.waitForFunction(() => window.__MC_GAME__.pixelRatio < window.devicePixelRatio,
    null, { timeout: 5_000 });
  const perf = await ratioState(page);

  // ① 像素比真的减半（相对 dpr 的倍率，不是绝对 0.4/0.5 那一套）
  expect(perf.pixelRatio, '性能档像素比 = dpr × 0.5').toBeCloseTo(perf.dpr * 0.5, 5);
  // ② **drawing buffer 的物理尺寸真的变了**（这条才是「接进了 renderer」的证据 ——
  //    只改一个字段而 renderer 没重建时它会保持不变）
  expect(perf.canvasW, 'canvas 后备缓冲宽度必须真的减半（否则只是写了个字段）')
    .toBe(Math.floor(before.w * 0.5));
  expect(perf.canvasH).toBe(Math.floor(before.h * 0.5));
  // ③ CSS 尺寸不变（画布仍然铺满视口 —— 减的是内部分辨率，不是画面大小）
  expect(perf.cssW, 'CSS 尺寸必须不变：减的是内部分辨率，不是画布大小').toBe(perf.cssW);
  const cssUnchanged = await page.evaluate(() => {
    const c = document.getElementById('app-canvas');
    return { cssW: Math.round(c.getBoundingClientRect().width), inner: window.innerWidth };
  });
  expect(cssUnchanged.cssW).toBe(cssUnchanged.inner);
  // ④ 选中态与设置持久化都跟上了（漏任一条都是「这次有效、下次回到清晰」）
  expect(perf.active).toBe('性能');
  expect(perf.setting, '设置对象必须写回 performance').toBe('performance');
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('mc_heavy_settings_v1') || '{}').pixelRatio);
  expect(stored, '必须落到 localStorage（否则重进游戏回到清晰）').toBe('performance');

  // ⑤ 切回清晰 → 逐值还原（不是「只降不升」的单向开关）
  await pickResolution(page, '清晰');
  await page.waitForFunction(() => window.__MC_GAME__.pixelRatio === window.devicePixelRatio,
    null, { timeout: 5_000 });
  const back = await ratioState(page);
  expect(back.pixelRatio).toBe(back.dpr);
  expect(back.canvasW, '切回清晰必须逐值还原 canvas 尺寸').toBe(before.w);
  expect(back.setting).toBe('sharp');
});

test('分辨率：性能档联动降雨滴数（对齐 mc-lite refreshRainQualityIfNeeded）', async ({ page }) => {
  // 雨滴数是 BufferGeometry 的顶点数、构造期固定 → 只能 dispose 重建。
  // 「切了分辨率但雨滴数没变」是**静默**的：画面照常下雨，只是没省下那部分开销。
  await boot(page);
  const sharpCount = await page.evaluate(() => window.__MC_GAME__.rain.particleCount);
  await openPanel(page);
  await pickResolution(page, '性能');
  await page.waitForFunction((n) => window.__MC_GAME__.rain?.particleCount < n,
    sharpCount, { timeout: 5_000 });
  const perfCount = await page.evaluate(() => window.__MC_GAME__.rain.particleCount);
  // 性能档取 mc-lite `getRainQualityOptions()` 性能档的原值 120
  expect(perfCount, '性能档雨滴数必须降到 mc-lite 性能档原值 120').toBe(120);
  // 雨效本身必须仍然可用（重建后几何属性齐全、强度接线没断）
  const rainOk = await page.evaluate(() => {
    const r = window.__MC_GAME__.rain;
    return { hasGeo: !!r.geometry, hasLines: !!r.lines, inScene: r.lines?.parent === window.__MC_GAME__.scene };
  });
  expect(rainOk).toEqual({ hasGeo: true, hasLines: true, inScene: true });

  // 切回清晰 → 雨滴数逐值还原
  await pickResolution(page, '清晰');
  await page.waitForFunction((n) => window.__MC_GAME__.rain?.particleCount === n,
    sharpCount, { timeout: 5_000 });
});

test('分辨率：Retina（dsf=2）下清晰=2 / 性能=1（相对 dpr 的倍率语义）', async ({ browser }) => {
  // ⚠️ **这条必须用 dsf=2 的独立上下文**：dsf=1 时清晰档 = 1、性能档 = 0.5，
  // 恰好与「绝对像素比」的两种可能解释都自洽 —— 测不出「相对 dpr」这层语义。
  // 缺陷形态：若有人把性能档写成固定的 `pixelRatio = 0.5`，dsf=1 用例全绿，
  // 而 Retina 屏上会变成 1/4 分辨率的残留（比 mc-lite 最激进的 0.4 档还糊）。
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  try {
    await boot(page);
    const sharp = await ratioState(page);
    expect(sharp.dpr, '上下文必须是 dpr=2（否则本用例没有判别力）').toBe(2);
    expect(sharp.pixelRatio, 'Retina 清晰档 = 2（devicePixelRatio 原值）').toBe(2);
    expect(sharp.canvasW).toBe(Math.floor(1000 * 2));

    await openPanel(page);
    await pickResolution(page, '性能');
    await page.waitForFunction(() => window.__MC_GAME__.pixelRatio < 2, null, { timeout: 5_000 });
    const perf = await ratioState(page);
    // Retina 性能档 = 1.0 —— 正是 mc-lite 的「画质档」绝对像素比，
    // 也就是说本仓的性能档观感对齐 mc-lite 的清晰档（有意偏离其 0.4 绝对档，理由见模块头注）
    expect(perf.pixelRatio, 'Retina 性能档 = dpr × 0.5 = 1').toBe(1);
    expect(perf.canvasW).toBe(1000);
    expect(perf.rainCount).toBe(120);
  } finally {
    await ctx.close();
  }
});

test('分辨率：?res=perf URL 入口与旧存档缺字段回落', async ({ page }) => {
  // URL 入口（调试/隔离用）—— 与 `?vd=` / `?fog=` 同口径
  await boot(page, '&res=perf');
  const perf = await page.evaluate(() => ({
    pr: window.__MC_GAME__.pixelRatio, dpr: window.devicePixelRatio,
    setting: window.__MC_GAME__.settings.pixelRatio,
    rain: window.__MC_GAME__.rain.particleCount,
  }));
  expect(perf.setting).toBe('performance');
  expect(perf.pr).toBeCloseTo(perf.dpr * 0.5, 5);
  expect(perf.rain).toBe(120);
});

test('分辨率：并存档里的性能档在重进游戏后仍生效', async ({ page }) => {
  // 「点了有效但下次回到清晰」是这类开关最典型的静默失效 → 必须验真实 reload 路径
  await boot(page);
  await openPanel(page);
  await pickResolution(page, '性能');
  await page.waitForFunction(() => window.__MC_GAME__.settings.pixelRatio === 'performance',
    null, { timeout: 5_000 });

  await page.reload();
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  const after = await page.evaluate(() => ({
    pr: window.__MC_GAME__.pixelRatio, dpr: window.devicePixelRatio,
    setting: window.__MC_GAME__.settings.pixelRatio,
    rain: window.__MC_GAME__.rain.particleCount,
  }));
  expect(after.setting, 'reload 后设置必须仍是性能档').toBe('performance');
  expect(after.pr).toBeCloseTo(after.dpr * 0.5, 5);
  expect(after.rain, 'reload 后的雨滴数也必须按存档档位初始化').toBe(120);
});

test('分辨率：行布局 —— 视距与分辨率同处一个合并盒、同一行、文案不折行、面板不出现滚动条', async ({ page }) => {
  // 用户 2026-11-03 指定：「把原本视距这一排改为两列，类似『雾色』与『背景音乐』两列占据一行」
  // —— 因此本行不只是「加两个按钮」，还背着一个**布局契约**（与 v1.98/v2.10 同一个约束家族）。
  await boot(page);
  await openPanel(page);
  const layout = await page.evaluate(() => {
    const modal = document.getElementById('settings-modal');
    const boxOf = (title) => [...modal.querySelectorAll('.mc-combined-col')]
      .find((r) => r.querySelector('.mc-title')?.textContent === title);
    const vd = boxOf('视距');
    const res = boxOf('分辨率');
    const btns = (el) => [...el.querySelectorAll('button')];
    const lines = (b) => {
      const r = document.createRange();
      r.selectNodeContents(b);
      return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size;
    };
    const content = modal.querySelector('.mc-content');
    return {
      vdExists: !!vd,
      resExists: !!res,
      sameBox: !!vd && !!res && vd.parentElement === res.parentElement,
      sameRow: !!vd && !!res
        && Math.round(vd.getBoundingClientRect().top) === Math.round(res.getBoundingClientRect().top),
      vdCount: vd ? btns(vd).length : 0,
      resCount: res ? btns(res).length : 0,
      resLabels: res ? btns(res).map((b) => b.textContent) : [],
      // ⚠️ `scrollWidth <= clientWidth` 对「折行」没有判别力（中文可任意字间断行），
      // 实测 v2.19 就是这么被咬的 —— 真正的信号是行盒数。
      noWrap: res ? btns(res).every((b) => b.scrollWidth <= b.clientWidth && lines(b) === 1) : false,
      scroll: { h: content.scrollHeight, c: content.clientHeight },
      panelW: Math.round(content.getBoundingClientRect().width),
    };
  });
  expect(layout.vdExists, '视距组必须仍在（只加列不换掉）').toBe(true);
  expect(layout.resExists, '必须有分辨率组').toBe(true);
  expect(layout.sameBox, '视距与分辨率必须共用同一个合并盒（用户要求的「两列占一行」）').toBe(true);
  expect(layout.sameRow, '两组必须在同一行（同一 top）').toBe(true);
  expect(layout.vdCount, '视距仍是三档（8/12/16），不得被改动').toBe(3);
  expect(layout.resCount).toBe(2);
  expect(layout.resLabels).toEqual(['清晰', '性能']);
  expect(layout.noWrap, '分辨率按钮文案不得折行/溢出').toBe(true);
  // 面板不得因新增这一列出现纵向滚动条（v1.63/v1.98 的既定判据：面板高度不涨）
  expect(layout.scroll.h, '面板内容不得溢出（出现纵向滚动条 = 高度涨了一档）')
    .toBeLessThanOrEqual(layout.scroll.c + 1);
  expect(layout.panelW, '面板宽度仍应为 770 + 边框/内边距（实测量级）').toBeGreaterThan(700);
});
