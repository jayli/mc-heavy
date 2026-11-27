// tests/light-tuning.spec.mjs — 「光影微调」Tab（v3.51）接线与布局验收
//
// 设计文档：docs/superpowers/specs/2026-11-27-light-tuning-tab-design.md
//
// ## 为什么必须有这条 E2E（Tier 1 单测证不了的四件事）
//
// ① **拖滑块真的改到 uniform**：单测用的是 stub 句柄，写成什么方法都能过；
//    真实页面里 `uShadowFloor` 是 `uniform()` 实例，接线漏了只有真浏览器能抓。
// ② **15 行两列在 448px 内不溢出**：布局契约只有真浏览器能算（既有三处面板高度冻结断言）。
// ③ **剪贴板两条路径**：`navigator.clipboard` 在无头/非安全上下文会抛，回落路径必须真的能用；
//    两条都失败时必须给失败 toast（静默失败 = 玩家看到「点了没反应」）。
// ④ **切风格后面板同步**：滑块显示上一档的值而实际生效本档值，是典型静默漂移。
//
// ## 判据选型（都是实测口径）
//
// - 拖滑块用 `input.value = ... + dispatchEvent(new Event('input'))`：Playwright 的
//   `fill()` 不支持 range，`click()` 只能点到某个位置算出的值（不可控）。
// - **零回归锚点**：打开面板不动任何滑块时，15 个滑块值必须逐项等于 `lightTuningValues`，
//   且 `uShadowFloor` 仍是 normal 档的 0.14。
// - **shadowFloor 拖到上界**：断言 `1 − floor > 0`（`materials.js` 的 shadowKill 分母），
//   这是「整屏 NaN」的唯一结构性防线。
// - 剪贴板记录器必须在 **goto 之前** 用 `addInitScript` 注入（既有教训：page.route 同理）。
import { test, expect } from 'playwright/test';

const READY = () => window.__MC_GAME__?.worldReady === true;

/** 参数表（浏览器侧直接 import 真实模块，不在 spec 里写第二份清单） */
async function loadDefs(page) {
  return page.evaluate(async () => {
    const m = await import('/src/render/light-tuning-config.js');
    return m.LIGHT_TUNING_PARAMS.map((d) => ({
      key: d.key, label: d.label, varName: d.varName,
      min: d.min, max: d.max, step: d.step, col: d.col, agxOnly: d.agxOnly === true,
      domKey: d.key.replace(/[[\]]/g, '-'),
    }));
  });
}

async function openPanel(page) {
  await page.locator('#settings-btn').click();
  await expect(page.locator('#settings-modal')).toBeVisible();
}

async function openTuning(page) {
  await page.locator('#settings-tab-tuning').click();
  await expect(page.locator('#settings-panel-tuning')).toBeVisible();
}

/**
 * 拖一个滑块到指定值（真实 input 事件，与玩家拖动同一条路径）。
 * ⚠️ **入参是完整 domKey**（`sunColor[0]` → `sunColor-0-`，**两个**方括号各换一个 `-`）。
 * 实测踩过：写成 `sunColor-0` 漏尾 ⇒ getElementById 返 null。
 */
async function slide(page, domKey, value) {
  await page.evaluate(({ id, v }) => {
    const el = document.getElementById(id);
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, { id: `lt-${domKey}`, v: value });
}

/** 读引擎侧全部相关状态 */
const STATE = () => {
  const g = window.__MC_GAME__;
  const u = g.renderWorld.materials.dayNight;
  return {
    shadowFloor: u.uShadowFloor.value,
    sunIntensity: u.uSunIntensity.value,
    hemiGround: u.uHemiGround.value,
    skyDim: u.uSkyDim.value,
    sunColorR: u.uSunColor.value.x,
    waterTint: [g.ocean.uWaterTint.value.x, g.ocean.uWaterTint.value.y, g.ocean.uWaterTint.value.z],
    toneMapping: g.renderer.toneMapping,
    exposure: g.renderer.toneMappingExposure,
    hour: g.dayNight.hour,
    style: g.dayNight._styleOverride,
    values: g.lightTuningValues,
  };
};

test('光影微调①：三个页签、顺序、等宽等高，切 Tab 弹框尺寸逐位不变', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=2&seed=12345&style=normal');
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await openPanel(page);

  const measure = () => page.evaluate(() => {
    const modal = document.getElementById('settings-modal');
    const content = modal.querySelector('.mc-content');
    const close = document.getElementById('settings-close');
    const box = (el) => {
      const b = el.getBoundingClientRect();
      return { w: Math.round(b.width * 100) / 100, h: Math.round(b.height * 100) / 100 };
    };
    return {
      tab: window.__MC_GAME__.settingsPanel._tab,
      content: box(content),
      close: box(close),
      tabs: [...modal.querySelectorAll('.mc-tab')].map((b) => ({
        id: b.id, text: b.textContent, active: b.classList.contains('active'), box: box(b),
      })),
    };
  });

  const init = await measure();
  expect(init.tabs.map((t) => t.text), '页签顺序：光影微调在中间（用户裁定）')
    .toEqual(['游戏设置', '光影微调', '关于游戏']);
  expect(init.tabs.map((t) => t.id))
    .toEqual(['settings-tab-settings', 'settings-tab-tuning', 'settings-tab-about']);
  // ☠️ **等宽必须容 subpixel 舍入**（实测）：三份 flex:1 平分 754px = 251.333…，
  // Chrome 按 1/64px 量化 ⇒ 实测 251.328125 / 251.34375 / 251.328125（最大差 **0.015625px**）。
  // 两个页签时 754/2 = 377 整除，所以这条旧断言从未暴露过量化。
  // 容差取 **0.02px**（= 1/64 的不到两倍，刚盖住量化单位）—— 不是放宽「等宽」语义：
  // 真的不等宽（如文案撑开某一项）差的是几到几十 px，远超此容差。
  const SUBPIXEL = 0.02;
  expect(Math.abs(init.tabs[0].box.w - init.tabs[1].box.w), '三个页签等宽（容 1/64px 量化）')
    .toBeLessThanOrEqual(SUBPIXEL);
  expect(Math.abs(init.tabs[1].box.w - init.tabs[2].box.w)).toBeLessThanOrEqual(SUBPIXEL);
  expect(init.tabs[0].box.h, '页签高度固定 40px').toBe(40);
  expect(init.tabs[1].box.h).toBe(40);
  expect(init.tabs[2].box.h).toBe(40);

  for (const key of ['tuning', 'about', 'settings']) {
    await page.locator(`#settings-tab-${key}`).click();
    const m = await measure();
    expect(m.tab).toBe(key);
    expect(m.content, `切到 ${key} 后弹框尺寸必须逐位不变`).toEqual(init.content);
    expect(m.close, `切到 ${key} 后确定按钮尺寸不变`).toEqual(init.close);
    expect(m.tabs.map((t) => t.box), '页签尺寸不得随选中态变化').toEqual(init.tabs.map((t) => t.box));
  }
});

test('光影微调②：15 个滑块两列 8/7、无滚动条、初值等于当前风格值', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=2&seed=12345&style=normal');
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await openPanel(page);
  await openTuning(page);
  const defs = await loadDefs(page);

  const layout = await page.evaluate(() => {
    const panel = document.getElementById('settings-panel-tuning');
    const rows = (id) => [...document.getElementById(id).querySelectorAll('.mc-tuning-row')];
    const inputs = [...panel.querySelectorAll('input[type=range]')];
    return {
      count: inputs.length,
      left: rows('lt-col-left').length,
      right: rows('lt-col-right').length,
      scroll: [panel.scrollHeight, panel.clientHeight],
      inner: (() => {
        const s = panel.querySelector('.mc-tuning-scroll');
        return [s.scrollHeight, s.clientHeight];
      })(),
      vals: inputs.map((el) => ({ id: el.id, value: Number(el.value) })),
      texts: [...panel.querySelectorAll('.mc-tuning-val')].map((el) => el.textContent),
      footerOutsideScroll: !document.getElementById('lt-copy')
        .closest('.mc-tuning-scroll'),
    };
  });
  expect(layout.count, '15 个滑块').toBe(15);
  expect(layout.left, '左列 8 行').toBe(8);
  expect(layout.right, '右列 7 行').toBe(7);
  expect(layout.scroll[0], '调参页不得出现纵向滚动条')
    .toBeLessThanOrEqual(layout.scroll[1] + 1);
  expect(layout.inner[0], '滑块区自身也不得溢出（两列必须真的放得下）')
    .toBeLessThanOrEqual(layout.inner[1] + 1);
  expect(layout.footerOutsideScroll, '复制/复位按钮必须在滚动区之外').toBe(true);
  for (const t of layout.texts) {
    expect(t, '每行读数必须是三位小数').toMatch(/^-?\d+\.\d{3}$/);
  }

  // 零回归锚点：不动滑块时，滑块值逐项等于生效值，且 uniform 仍是 normal 档原值。
  // ☠️ **比较必须容 step 量化**（实测）：HTML range 把 value 吸到 step 网格。
  // v3.53 后 normal 档 ambientColor 改成三位小数（0.854 / 0.975 / 1.170）⇒ 15 项偏差均应为 0；
  // 但容差断言**不改** —— 它守的是控件固有行为（将来又出现四位小数参数时不该被当成接线错）。
  // 真的接线错（读了别的档的值）差的是 0.1 量级，远超此容差。
  const st = await page.evaluate(STATE);
  for (const d of defs) {
    const got = layout.vals.find((v) => v.id === `lt-${d.domKey}`);
    expect(got, `缺滑块 lt-${d.domKey}`).toBeTruthy();
    expect(Math.abs(got.value - st.values[d.key]),
      `${d.key} 滑块初值须等于生效值（容 step/2 量化）`)
      .toBeLessThanOrEqual(d.step / 2 + 1e-9);
  }
  expect(st.shadowFloor, '未调整时 normal 档地板仍是 0.399').toBeCloseTo(0.399, 6);
  expect(st.exposure, '未调整时曝光仍是 1.63').toBeCloseTo(1.63, 6);
});

test('光影微调③：拖滑块真改 uniform，拖到上界分母仍为正', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=2&seed=12345&style=normal');
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await openPanel(page);
  await openTuning(page);
  const defs = await loadDefs(page);
  const floorDef = defs.find((d) => d.key === 'shadowFloor');

  await slide(page, 'shadowFloor', 0.3);
  let st = await page.evaluate(STATE);
  expect(st.shadowFloor, '拖到 0.3 后 uniform 必须真的变').toBeCloseTo(0.3, 6);
  let text = await page.locator('#lt-val-shadowFloor').textContent();
  expect(text, '读数须同步').toBe('0.300');

  // 拖到上界：分母 1 − floor 必须仍为正（否则 shadowKill 除零 → 整屏 NaN）
  await slide(page, 'shadowFloor', floorDef.max);
  st = await page.evaluate(STATE);
  expect(st.shadowFloor, '上界生效').toBeCloseTo(floorDef.max, 6);
  expect(1 - st.shadowFloor, '1 − floor 必须为正（shadowKill 分母）').toBeGreaterThan(0);

  // 色温与水面：vec3 句柄走 .value.set，接线漏了单测抓不到
  await slide(page, 'sunColor-0-', 1.8);
  await slide(page, 'waterTint', 0.2);
  st = await page.evaluate(STATE);
  expect(st.sunColorR, '直射色红分量真的写进 vec3 uniform').toBeCloseTo(1.8, 6);
  expect(st.waterTint[0], '水面亮度写进 ocean 的 uWaterTint').toBeCloseTo(0.2, 6);
  expect(st.waterTint[1], '三通道必须相等（只改亮度不改色相）').toBeCloseTo(st.waterTint[0], 9);
  expect(st.waterTint[2]).toBeCloseTo(st.waterTint[0], 9);

  // 曝光走 renderer 属性，不是 uniform
  await slide(page, 'toneMappingExposure', 3.1);
  st = await page.evaluate(STATE);
  expect(st.exposure, '曝光真的写到 renderer').toBeCloseTo(3.1, 6);
});

test('光影微调④：切风格互不污染，切回来还记得；面板滑块跟着同步', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=2&seed=12345&style=normal');
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await openPanel(page);
  await openTuning(page);
  await slide(page, 'shadowFloor', 0.3);

  // 切风格必须走玩家真实入口（第一个 Tab 的「环境风格」按钮），不是测试 API
  await page.locator('#settings-tab-settings').click();
  await page.locator('#settings-panel-main .mc-item', { hasText: '环境风格' })
    .locator('button', { hasText: '正午' }).click();
  let st = await page.evaluate(STATE);
  expect(st.style).toBe('noon');
  expect(st.shadowFloor, '正午回落全局 0.38（不被 normal 的 override 污染）').toBeCloseTo(0.38, 6);

  await page.locator('#settings-tab-tuning').click();
  let slider = await page.locator('#lt-shadowFloor').inputValue();
  expect(Number(slider), '切档后滑块必须同步到本档值').toBeCloseTo(0.38, 6);

  await page.locator('#settings-tab-settings').click();
  await page.locator('#settings-panel-main .mc-item', { hasText: '环境风格' })
    .locator('button', { hasText: '普通' }).click();
  st = await page.evaluate(STATE);
  expect(st.shadowFloor, '切回普通仍是调过的 0.3').toBeCloseTo(0.3, 6);
  await page.locator('#settings-tab-tuning').click();
  slider = await page.locator('#lt-shadowFloor').inputValue();
  expect(Number(slider)).toBeCloseTo(0.3, 6);
});

test('光影微调⑤：非法输入不写 NaN；恢复默认回到风格缺省', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=2&seed=12345&style=normal');
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await openPanel(page);
  await openTuning(page);
  await slide(page, 'shadowFloor', 0.3);

  const bad = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return {
      nan: g.setLightTuning('shadowFloor', NaN),
      str: g.setLightTuning('shadowFloor', '0.5'),
      unknown: g.setLightTuning('nope', 1),
      after: g.renderWorld.materials.dayNight.uShadowFloor.value,
    };
  });
  expect(bad.nan, 'NaN 拒绝').toBeNull();
  expect(bad.str, '字符串拒绝').toBeNull();
  expect(bad.unknown, '未知 key 拒绝').toBeNull();
  expect(bad.after, '非法输入后 uniform 保持上一次的值').toBeCloseTo(0.3, 6);

  await page.locator('#lt-reset').click();
  const st = await page.evaluate(STATE);
  const defs = await loadDefs(page);
  expect(st.shadowFloor, '恢复默认后回 normal 档 0.399').toBeCloseTo(0.399, 6);
  expect(st.exposure).toBeCloseTo(1.63, 6);
  for (const d of defs) {
    const v = await page.locator(`#lt-${d.domKey}`).inputValue();
    expect(Math.abs(Number(v) - st.values[d.key]),
      `${d.key} 滑块须回到缺省（容 step/2 量化）`)
      .toBeLessThanOrEqual(d.step / 2 + 1e-9);
  }
});

test('光影微调⑥：自动循环下拖动冻结日夜，恢复默认解冻', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=2&seed=12345');   // 不带 style = 自动日夜循环
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await openPanel(page);
  await openTuning(page);

  // ☠️ **先量「不冻结时同窗口会走多少」作对照**：没有这条，「hour 不变」在
  // 主循环恰好没跑的环境下是恒真判据（本仓 pitfalls：判据必须能区分两种世界）。
  const a0 = await page.evaluate(() => window.__MC_GAME__.dayNight.hour);
  await page.waitForTimeout(600);
  const a1 = await page.evaluate(() => window.__MC_GAME__.dayNight.hour);
  expect(a1, '前提：未调参时 600ms 内日夜必须真的在走（否则下面的冻结判据恒真）')
    .toBeGreaterThan(a0);

  // ☠️ **基准必须在拖动落地之后取**（实测踩过）：旧写法先读 h0 再拖，
  // 而读 h0 到 input 事件落地之间主循环还在跑 ⇒ 实测差 **0.000166 小时 ≈ 一帧**
  // （0.02s × 24/1200 = 0.0004 同量级）—— 那是测量方法错，不是冻结失效。
  await slide(page, 'skyDim', 0.5);
  await page.waitForTimeout(100);
  const h1 = await page.evaluate(() => window.__MC_GAME__.dayNight.hour);
  await page.waitForTimeout(600);
  const frozen = await page.evaluate(STATE);
  expect(frozen.style, '仍是自动循环').toBeNull();
  expect(frozen.hour, '冻结后 hour 逐位不变（否则滑块值被每帧插值抹掉）').toBe(h1);
  expect(frozen.skyDim, 'override 值稳得住').toBeCloseTo(0.5, 6);

  await page.locator('#lt-reset').click();
  // 面板是模态，主循环跳过 player.update 但 dayNight.update 仍在跑（game.js:1620 只对 player 门控）
  await page.waitForTimeout(600);
  const resumed = await page.evaluate(() => window.__MC_GAME__.dayNight.hour);
  expect(resumed, '恢复默认后日夜必须继续走').toBeGreaterThan(h1);
});

test('光影微调⑦：复制参数文本格式正确；剪贴板失败时给失败提示（不静默）', async ({ page }) => {
  test.setTimeout(180_000);
  // ⚠️ 必须在 goto 之前注入（既有教训：page.route / addInitScript 都得先注册）
  await page.addInitScript(() => {
    window.__CLIP__ = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (t) => { window.__CLIP__.push(t); } },
    });
  });
  await page.goto('/?vd=2&seed=12345&style=normal');
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await openPanel(page);
  await openTuning(page);
  await page.locator('#lt-copy').click();
  await page.waitForFunction(() => window.__CLIP__.length > 0, null, { timeout: 10_000 });

  const text = await page.evaluate(() => window.__CLIP__[0]);
  const lines = text.split('\n');
  expect(lines.length, '首行风格 + 15 项').toBe(16);
  expect(lines[0]).toBe('风格，visualStyle: normal');
  expect(lines, '须含用户举例的那一行').toContain('强光，sunIntensity: 1.282');
  for (const line of lines.slice(1)) {
    expect(line, '每行格式「参数名，变量名:值」').toMatch(/^.+，[A-Za-z][\w[\]]*: -?\d+\.\d{3}$/);
  }
  await expect(page.locator('#mc-toast')).toContainText('已复制');

  // 两条路径都失败 ⇒ 必须给失败 toast，不得静默
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => { throw new Error('denied'); } },
    });
    document.execCommand = () => false;
  });
  await page.locator('#lt-copy').click();
  await expect(page.locator('#mc-toast')).toContainText('复制失败', { timeout: 10_000 });
});

test('光影微调⑧：对比度/饱和度只在普通档可调，且真的改到 punch uniform', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=2&seed=12345&style=normal');
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await openPanel(page);
  await openTuning(page);

  expect(await page.locator('#lt-punchGamma').isDisabled(), '普通档下对比度可调').toBe(false);
  expect(await page.locator('#lt-punchSat').isDisabled()).toBe(false);

  // v3.53：未拖滑块时两项须是**本档实调值** 1.34 / 0.94（不是全局常量 1.28 / 1.17）。
  // 这条是 per-style 接线的直接证据：只验「拖了能变」拓不到「初值读错档」。
  const init = await page.evaluate(async () => {
    const m = await import('/src/render/ashlar-tonemap.js');
    return {
      gamma: m.ASHLAR_PUNCH_UNIFORMS.uPunchGamma.value,
      sat: m.ASHLAR_PUNCH_UNIFORMS.uPunchSat.value,
    };
  });
  expect(init.gamma, '普通档初值对比度须为 1.34').toBeCloseTo(1.34, 6);
  expect(init.sat, '普通档初值饱和度须为 0.94').toBeCloseTo(0.94, 6);

  await slide(page, 'punchGamma', 1.6);
  const punch = await page.evaluate(async () => {
    const m = await import('/src/render/ashlar-tonemap.js');
    return {
      gamma: m.ASHLAR_PUNCH_UNIFORMS.uPunchGamma.value,
      sat: m.ASHLAR_PUNCH_UNIFORMS.uPunchSat.value,
    };
  });
  expect(punch.gamma, '拖对比度真的改到运行时 uniform').toBeCloseTo(1.6, 6);

  await page.locator('#settings-tab-settings').click();
  await page.locator('#settings-panel-main .mc-item', { hasText: '环境风格' })
    .locator('button', { hasText: '正午' }).click();
  await page.locator('#settings-tab-tuning').click();
  expect(await page.locator('#lt-punchGamma').isDisabled(), '正午走 ACES ⇒ 对比度置灰').toBe(true);
  expect(await page.locator('#lt-punchSat').isDisabled()).toBe(true);
  const back = await page.evaluate(async () => {
    const m = await import('/src/render/ashlar-tonemap.js');
    return m.ASHLAR_PUNCH_UNIFORMS.uPunchGamma.value;
  });
  expect(back, '切走后 punch 回落常量 1.28（零回归）').toBeCloseTo(1.28, 6);
});