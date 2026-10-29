import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

// 背包 hover 浮层验收（v1.93）。
//
// 用户 2026-10-29：「按 z 换出的背包面板里，鼠标移动到某个方块上的时候，hover 住的时候
// 要在鼠标旁边显示 hover 的方块的名字全称」，并裁定「就原样显示，方块本来叫什么名字，
// 就显示什么名字，比如 polished_blackstone_bricks」。
//
// ⚠️ **必须用真实鼠标移动**（`page.mouse.move`），不能直接 dispatchEvent ——
// `mouseenter` 是浏览器合成的（不冒泡、不能靠 dispatch 精确模拟），只测 dispatching
// 会漏掉「事件根本没挂上」这类缺陷。

const READY = () => window.__MC_GAME__?.worldReady === true;

/** 等世界稳定：sections 连续两次采样不变 + 三条队列归零 */
const STABLE = () => {
  const g = window.__MC_GAME__;
  const s = g.scheduler.stats();
  const sections = g.renderStats().sections;
  const prev = window.__MC_STABLE_PREV__;
  window.__MC_STABLE_PREV__ = sections;
  return prev === sections && s.inflight === 0 && s.meshInflight === 0 && s.uploadQueue === 0;
};

test('背包：hover 槽位时在鼠标旁显示方块完整名字（原样 id）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=2&seed=12345');
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await page.waitForFunction(STABLE, null, { timeout: 60_000, polling: 500 });

  // 按 Z 打开背包（用户原话：「按 z 换出的背包面板」）
  await page.keyboard.press('KeyZ');
  const modal = page.locator('#inventory-modal');
  await expect(modal).toBeVisible();

  const tooltip = page.locator('#inventory-tooltip');
  // ① 打开但没 hover 时浮层不可见
  await expect(tooltip).toBeHidden();

  // ② hover 第一个槽位 → 浮层出现，文本 = 该槽的方块 id **原样**
  const first = page.locator('#inventory-modal .mc-slot').first();
  await expect(first).toBeVisible();
  const itemName = await first.evaluate((el) => el.querySelector('.mc-item-name')?.textContent ?? '');
  expect(itemName.length).toBeGreaterThan(0);

  const box = await first.boundingBox();
  const mx = box.x + box.width / 2, my = box.y + box.height / 2;
  await page.mouse.move(mx, my);
  await expect(tooltip).toBeVisible();
  // ⚠️ 文案必须与槽位里的名字**逐字符相同**（用户裁定原样显示，不做下划线转空格/翻译）
  await expect(tooltip).toHaveText(itemName);
  // 且必须真的在鼠标旁边（不是固定在某个角落）—— 允许 0~80px 偏移
  const tb = await tooltip.boundingBox();
  expect(Math.abs(tb.x - mx)).toBeLessThan(80);
  expect(Math.abs(tb.y - my)).toBeLessThan(80);

  // ③ 移到另一个槽位 → 文案跟着换（证明不是「只显示第一个」）
  const second = page.locator('#inventory-modal .mc-slot').nth(1);
  const secondName = await second.evaluate((el) => el.querySelector('.mc-item-name')?.textContent ?? '');
  expect(secondName).not.toBe(itemName);
  const b2 = await second.boundingBox();
  await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2);
  await expect(tooltip).toHaveText(secondName);

  // ④ 移到面板空白处 → 浮层消失（不能一直挂着跟鼠标跑）
  await page.mouse.move(box.x + box.width + 200, box.y - 200);
  await expect(tooltip).toBeHidden();

  // ⑤ 长名字不被裁断（用户举的例子就是 26 字符的 polished_blackstone_bricks）。
  //    直接构造一个长名槽位不现实，改为断言浮层样式：nowrap + 无 text-overflow。
  const styleOk = await page.evaluate(() => {
    const t = document.getElementById('inventory-tooltip');
    const cs = getComputedStyle(t);
    return { wrap: cs.whiteSpace, overflow: cs.textOverflow, pe: cs.pointerEvents };
  });
  // 槽位里的小字被 ellipsis 裁掉是既有设计；浮层必须完整显示 → nowrap 且不省略
  expect(styleOk.wrap).toBe('nowrap');
  expect(styleOk.overflow).not.toBe('ellipsis');
  // pointer-events:none —— 否则浮层挡住光标会触发 mouseleave 循环闪烁
  expect(styleOk.pe).toBe('none');

  // ⑥ 关掉背包后浮层不残留（position:fixed 挂 body，hide 必须在 close 里做）
  //
  // ⚠️ **必须让鼠标停在槽位上再关**（负向验证实测的盲区）：第 ④ 步已经把鼠标移到空白处
  // 触发了 mouseleave → 浮层已隐藏，此时再关面板，`_hideTooltip()` 有没有写都看不出差别
  // —— 注入「close 里删掉 _hideTooltip()」后本用例仍然全绿（实测）。
  // 正解：先把鼠标移回**槽位上**（浮层出现），再按 Escape 关面板，然后断言浮层消失。
  await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2);
  await expect(tooltip).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
  await expect(tooltip).toBeHidden();
});

/**
 * v2.17：浮层必须画在**背包与设置面板之上**（用户 2026-11-03 报告「设置面板中，hover 到方块图上的
 * 时候，hover 出现的浮层显示到了设置面板之下」）。
 *
 * 根因：浮层挂在 `body` 下、两个模态挂在 `#hud-root` 下，而 `#hud-root` 没有 CSS
 * （不建层叠上下文）⇒ 三方在同一个根层叠上下文里比 z-index。浮层原值 **60**，既低于设置面板的
 * **70**、也低于背包自己的 **80** → 被不透明的背包内容框（`#c6c6c6`）整个盖住，
 * 面板之外那一小圈还被 70% 黑遮罩压暗。
 *
 * ⚠️ **既有用例（上面那条）在缺陷态全绿**：`toBeHidden/toBeVisible` 只看 CSS `display`，
 * 不看「画没画在最上层」。故本用例的判据落在**像素**上：同一位置裁剪图，「浮层可见」
 * 必须比「浮层隐藏」明显更暗（浮层是 rgba(0,0,0,.88) 黑底白字，底下是浅灰面板 #c6c6c6）。
 * 缺陷态两张图**逐位相同**（实测 Δ=0，因为浮层根本没被画出来）。
 *
 * 两种栈位都要测，它们拓到不同的回归：
 * ① 仅背包 —— 抓「z-index ≤ 80」；② 设置面板 + 背包 —— 抓「z-index ≤ 70」（用户报的那个）。
 */
test('背包 hover 浮层必须画在背包与设置面板之上（像素判据）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=2&seed=12345');
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await page.waitForFunction(STABLE, null, { timeout: 60_000, polling: 500 });

  const modal = page.locator('#inventory-modal');
  const tooltip = page.locator('#inventory-tooltip');

  /** 量一次「浮层可见 vs 隐藏」的同位置裁剪图（只改一个变量：`mc-visible` 类） */
  const measure = async () => {
    const first = page.locator('#inventory-modal .mc-slot').first();
    const box = await first.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect(tooltip).toBeVisible();

    const geo = await page.evaluate(() => {
      const r = document.getElementById('inventory-tooltip').getBoundingClientRect();
      const z = (id) => Number(getComputedStyle(document.getElementById(id)).zIndex);
      return {
        clip: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
        tooltipZ: z('inventory-tooltip'),
        inventoryZ: z('inventory-modal'),
        settingsZ: document.getElementById('settings-modal').style.display === 'none'
          ? null : z('settings-modal'),
      };
    });
    const shown = PNG.sync.read(await page.screenshot({ clip: geo.clip }));
    await page.evaluate(() => document.getElementById('inventory-tooltip').classList.remove('mc-visible'));
    const hidden = PNG.sync.read(await page.screenshot({ clip: geo.clip }));
    await page.evaluate(() => document.getElementById('inventory-tooltip').classList.add('mc-visible'));
    const meanOf = (png) => {
      let s = 0, n = 0;
      for (let i = 0; i < png.data.length; i += 4) {
        s += png.data[i] + png.data[i + 1] + png.data[i + 2]; n += 3;
      }
      return s / n;
    };
    return { ...geo, withTooltip: meanOf(shown), withoutTooltip: meanOf(hidden) };
  };
  /** 像素判据 + 结构判据（两者互补：像素验「真画上去了」，z-index 验「常量没被改回去」） */
  const assertOnTop = (m, label) => {
    const drop = m.withoutTooltip - m.withTooltip;
    console.log(`TOOLTIP-LAYER[${label}] ` + JSON.stringify({ ...m, drop: +drop.toFixed(1) }));
    expect(m.tooltipZ, `${label}：浮层 z-index 必须高于背包`).toBeGreaterThan(m.inventoryZ);
    if (m.settingsZ !== null) {
      expect(m.tooltipZ, `${label}：浮层 z-index 必须高于设置面板`).toBeGreaterThan(m.settingsZ);
    }
    expect(drop,
      `${label}：浮层覆盖区必须明显变暗（黑底浮层画在最上层）。实测 显示=${m.withTooltip.toFixed(1)} `
      + `隐藏=${m.withoutTooltip.toFixed(1)}，差值 ${drop.toFixed(1)} —— 接近 0 说明浮层被面板盖住、`
      + '玩家根本看不到它').toBeGreaterThan(20);
  };

  // ① 仅背包：浮层必须高于背包自己的 80
  await page.keyboard.press('KeyZ');
  await expect(modal).toBeVisible();
  assertOnTop(await measure(), 'inventory-only');
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();

  // ② 设置面板 + 背包（用户报的栈位）：浮层还必须高于设置面板的 70
  // ⚠️ 关背包会恢复 pointer lock → 真实点击会被 canvas 截获（探针实测），故用 DOM click
  //    开面板；被测对象是浮层层级，不是这个按钮的命中路径。
  await page.evaluate(() => document.getElementById('settings-btn').click());
  await expect(page.locator('#settings-modal')).toBeVisible();
  await page.keyboard.press('KeyZ');
  await expect(modal).toBeVisible();
  assertOnTop(await measure(), 'settings+inventory');
});
