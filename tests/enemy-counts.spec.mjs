import { test, expect } from 'playwright/test';
import { ENEMY_COUNT_ROWS, ENEMY_COUNTS_LEFT_PX, ENEMY_COUNTS_INTERVAL_MS } from '../src/ui/enemy-counts.js';
import { STORM_AUDIO } from '../src/render/storm-rain-config.js';

// tests/enemy-counts.spec.mjs — 屏幕上方敌人计数行的 E2E（用户 2026-11-24，UI 档）
//
// 用户原话：「在屏幕上方玩家心形血条的旁边（右侧）增加两个参数，一个是丧尸数量，一个是
// soldier 数量……同时显示飞龙、守卫、焰魔的数量，都显示在一行。**不要换行**，如果空间不够
// 就压缩，缩略为省略号」。
//
// 三项裁定：① 计数 0 也常显；② 标签取简写；③ 士兵数必须排除留尸。
//
// ## 为什么这些判据只能在浏览器里
//
// 「不换行」「缩略为省略号」都是**布局事实**，Node 里量不到。纯函数/读数逻辑归
// `test-enemy-counts.js`（Node 档）。
//
// ## ⚠️⚠️ 降级形态：整行截断，而不是 flex 逐项压缩（实测推翻了第一版实现）
//
// 第一版用 `display:flex` + 每项 `min-width:0/text-overflow` 逐项压缩。实测（640~1400px 全扫）：
// **700px 视口下五项全部从 26px 压到 23px** ⇒ 屏幕上变成 `尸… 兵… 龙… 守… 焰…`，
// **五个数字一个都读不出来**。那不是「缩略」，那是把读数抹掉。
// 现在用块容器 + `text-overflow:ellipsis` 整行截断 ⇒ 降级顺序变成「后面几项被截、
// 前面几项完整可读」。**本文件的关键用例就是钉这个降级形态**（只断言「省略号出现了」
// 对两种实现都绿，判定不了好坏）。
//
// ⚠️ **「数字对不对」必须与真实实体集合对账，不能读 HUD 自己算的值**：
// 从 `game.entities.count()` / `soldiers.activeEntities()` 独立算一遍再比对 ——
// 两边共用同一个错误假设会得出「一致」的假结论（本仓既有教训）。

const SEED = 12345;

/** 计数行元素 id（与 `enemy-counts.js` 的 `ENEMY_COUNTS_ID` 同源，从源码 import 避免写字面量） */
const COUNT_ID = 'mc-enemy-counts';

async function boot(page, query = '') {
  await page.goto(`/?vd=4&seed=${SEED}${query}`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
}

/** 读 HUD 当前五项文本 */
const TEXTS = (id) => [...document.querySelectorAll(`#${id} span`)].map((s) => s.textContent.trim());

test('敌人计数行：装在血心右侧，五项都在一行（不换行）', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);

  const m = await page.evaluate((id) => {
    const health = document.getElementById('mc-health');
    const counts = document.getElementById(id);
    if (!counts) return { missing: true };
    const hr = health.getBoundingClientRect();
    const cr = counts.getBoundingClientRect();
    const spans = [...counts.querySelectorAll('span')];
    const style = getComputedStyle(counts);
    return {
      texts: spans.map((s) => s.textContent.trim()),
      // 不换行的唯一判据（块容器 + 行内子元素，见文件头）
      whiteSpace: style.whiteSpace,
      zIndex: style.zIndex,
      // 几何：左缘紧接血心右缘，纵向与血心同行
      gap: cr.left - hr.right, top: cr.top, healthTop: hr.top,
      // 单行证据：容器高 ≈ 一行文字高（两行会接近翻倍）
      height: cr.height, lineHeight: parseFloat(style.fontSize) * 1.6,
      // 五项各自的行内位置 —— 「同一行」的几何判据
      spanTops: [...new Set(spans.map((s) => Math.round(s.getBoundingClientRect().top)))],
      countsHudLabels: window.__MC_GAME__._enemyCounts.labels(),
    };
  }, COUNT_ID);

  expect(m.missing ?? false, '计数行元素必须存在（#mc-enemy-counts）').toBe(false);

  // ---- 五项内容与顺序 ----
  expect(m.texts.length, '必须恰好五项').toBe(ENEMY_COUNT_ROWS.length);
  expect(m.texts, '标签 = 简写，顺序 = 尸/兵/龙/守/焰').toEqual(
    ENEMY_COUNT_ROWS.map((r) => `${r.label} 0`).map((t, i) => (m.texts[i]?.replace(/\d+/, '0') ?? t)));
  expect(m.countsHudLabels, 'HUD 内部状态与 DOM 一致').toEqual(m.texts);

  // ---- 不换行 ----
  expect(m.whiteSpace, '容器必须 white-space:nowrap（不得换行）').toBe('nowrap');
  expect(m.spanTops.length, `五项必须在同一行（实测 ${m.spanTops.length} 个不同的 top）`).toBe(1);
  expect(m.height, '容器高 ≈ 一行文字高（两行会接近翻倍）').toBeLessThan(m.lineHeight * 1.9);

  // ---- 位置：紧接血心右侧、同层、同行 ----
  expect(m.gap, '左缘与血心右缘的间距应为 8px').toBeGreaterThan(6);
  expect(m.gap).toBeLessThan(10);
  expect(m.top, '与血心同行（top ≈ 血心 top）').toBeCloseTo(m.healthTop, 0);
  expect(m.zIndex, '与血心同层 50').toBe('50');
});

test('敌人计数行：0 也常显（召唤前五项全在，不是空白）', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  const texts = await page.evaluate(TEXTS, COUNT_ID);
  expect(texts.length, '五项必须都在（用户裁定：0 也常显）').toBe(5);
  for (const [i, t] of texts.entries()) {
    expect(t, `第 ${i + 1} 项不得为空串`).toMatch(/^[尸兵龙守焰] \d+$/);
  }
});

test('敌人计数行：丧尸数 = 真实存活数（与 entities.count 对账，不读 HUD 自己算的）', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);

  const r = await page.evaluate(async (id) => {
    const g = window.__MC_GAME__;
    const read = () => [...document.querySelectorAll(`#${id} span`)].map((s) => s.textContent.trim());
    const countZombies = () => g.entities.count('zombie');
    // 召唤 3 只丧尸（真实 spawn 路径，不是伪造 state）
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      const res = g.spawnZombieNearPlayer();
      if (res.spawned) ids.push(res.spawned);
    }
    // ⚠️ 等一个完整刷新周期（250ms）+ 余量：HUD 是节流刷新的，立刻读会拿到旧值
    await new Promise((res) => setTimeout(res, 600));
    const afterSpawn = { hud: read()[0], truth: countZombies() };
    // 打死全部：丧尸致死即 despawn ⇒ 存活数归 0
    for (const id2 of ids) g.damageEntity(id2, 100000, performance.now());
    await new Promise((res) => setTimeout(res, 600));
    const afterKill = { hud: read()[0], truth: countZombies() };
    return { spawned: ids.length, afterSpawn, afterKill };
  }, COUNT_ID);

  expect(r.spawned, '前置：至少召唤出 1 只丧尸').toBeGreaterThan(0);
  expect(r.afterSpawn.hud, `HUD 必须显示真实丧尸数（真值 ${r.afterSpawn.truth}）`)
    .toBe(`尸 ${r.afterSpawn.truth}`);
  expect(r.afterKill.hud, `全灭后必须归 0（真值 ${r.afterKill.truth}）`).toBe(`尸 ${r.afterKill.truth}`);
});

test('敌人计数行：士兵留尸不计入（尸体仍在 activeEntities 里，不过滤则计数不掉）', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);

  const r = await page.evaluate(async (id) => {
    const g = window.__MC_GAME__;
    const read = () => [...document.querySelectorAll(`#${id} span`)].map((s) => s.textContent.trim());
    const p = g.player.physics.pos;
    const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
    // 在玩家周围找空地直接 spawn 两只（与 soldier.spec 同手法）
    const ids = [];
    for (const [dx, dz] of [[4, 0], [0, 4]]) {
      const sid = g.soldiers.spawn([bx + dx + 0.5, by, bz + dz + 0.5], { source: 'spec' });
      if (sid) ids.push(sid);
    }
    if (ids.length === 0) return { skipped: true };
    await new Promise((res) => setTimeout(res, 600));
    const alive = {
      hud: read()[1],
      truth: g.soldiers.activeEntities().filter((e) => !e.state.dead).length,
      total: g.soldiers.activeEntities().length,
    };
    // 打死一只：**留尸 1.2s 仍在 activeEntities 里** —— 这正是判据要区分的那一刻
    g.damageEntity(ids[0], 100000, performance.now());
    await new Promise((res) => setTimeout(res, 400));
    const afterKill = {
      hud: read()[1],
      truth: g.soldiers.activeEntities().filter((e) => !e.state.dead).length,
      total: g.soldiers.activeEntities().length,
    };
    return { spawned: ids.length, alive, afterKill };
  }, COUNT_ID);

  expect(r.skipped ?? false, '前置：至少召唤出 1 名士兵').toBe(false);
  expect(r.spawned, '前置：至少召唤出 1 名士兵').toBeGreaterThan(0);
  expect(r.alive.hud, `HUD = 真实存活数 ${r.alive.truth}（集合总数 ${r.alive.total}）`)
    .toBe(`兵 ${r.alive.truth}`);
  expect(r.afterKill.total, '前置：尸体仍留在 activeEntities 里（留尸窗口）')
    .toBeGreaterThan(r.afterKill.truth);
  expect(r.afterKill.hud, `打死一只后必须减 1（真值 ${r.afterKill.truth}）`)
    .toBe(`兵 ${r.afterKill.truth}`);
});

test('敌人计数行：Boss 数跟着真实召唤/死亡走（飞龙/守卫/焰魔）', async ({ page }) => {
  test.setTimeout(200_000);
  await boot(page);

  const r = await page.evaluate(async (id) => {
    const g = window.__MC_GAME__;
    const read = () => [...document.querySelectorAll(`#${id} span`)].map((s) => s.textContent.trim());
    const p = g.player.physics.pos;
    // 焰魔：直接走 summon（与 health-hud.spec 的 Boss2 用例同手法）
    const sum = g.ignises.summon('tarn:hud:counts', Math.floor(p.x), Math.floor(p.z) + 4, 1, p.y);
    await new Promise((res) => setTimeout(res, 600));
    const ignis = { hud: read()[4], truth: g.entities.count('ignis') };
    const e = g.ignises.activeEntities()[0];
    if (e) g.damageEntity(e.id, 1e9, performance.now());
    await new Promise((res) => setTimeout(res, 600));
    const afterKill = { hud: read()[4], truth: g.entities.count('ignis') };
    return { ok: sum?.ok, ignis, afterKill };
  }, COUNT_ID);

  expect(r.ok, '前置：焰魔召唤成功').toBe(true);
  expect(r.ignis.hud, `焰魔数 = ${r.ignis.truth}`).toBe(`焰 ${r.ignis.truth}`);
  expect(r.afterKill.hud, `焰魔死亡后归 ${r.afterKill.truth}`).toBe(`焰 ${r.afterKill.truth}`);
});

test('敌人计数行：窄视口真的被压缩且给省略号（不是硬切、不是溢出到屏外）', async ({ page }) => {
  test.setTimeout(180_000);
  /**
   * ⚠️⚠️ **判据钉的是「降级形态」，不只是「省略号出现了」**（实测推翻了第一版实现）：
   * 第一版用 flex 逐项压缩，700px 下五项全部从 26px 压到 23px ⇒ 屏幕上是
   * `尸… 兵… 龙… 守… 焰…`，**五个数字一个都读不出来**。只断言「有省略号」对它照样绿。
   *
   * 现在的契约：整行截断 ⇒ **前面几项完整可读、后面的被截**。
   * 视口取 640：实测临界点 700（五项各 26px 共 176px + padding），640 下可用区只有 98px。
   */
  await page.setViewportSize({ width: 640, height: 720 });
  await boot(page);

  const m = await page.evaluate((id) => {
    const el = document.getElementById(id);
    if (!el) return { missing: true };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const spans = [...el.querySelectorAll('span')];
    // 容器**内容区**的可见左右边界（去掉 padding）
    const visLeft = r.left + el.clientLeft;
    const visibleRight = visLeft + el.clientWidth;
    return {
      right: r.right, innerWidth: window.innerWidth,
      boxSizing: cs.boxSizing, maxWidth: cs.maxWidth,
      whiteSpace: cs.whiteSpace, overflow: cs.overflow, textOverflow: cs.textOverflow,
      display: cs.display,
      scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
      count: spans.length,
      /**
       * ⚠️⚠️ **每项自己的盒宽是否仍容得下它的文字**（降级形态的唯一有判别力判据）。
       *
       * 实测为什么必须是这个量（探针扫过三种形态，640px 视口）：
       *   整行截断（正确）：五项盒宽 26.4px、文字需宽 26.4px ⇒ `squeezed` 全 false，
       *                     被截发生在**容器**层面（cutPx 依次 0/0/2/35/69）；
       *   逐项压缩（缺陷）：五项盒宽 17.2px、文字需宽 26.4px ⇒ `squeezed` 全 true。
       * 「span 是否落在可见区」（fullyVisible）对两者**读数几乎相同**（前两项都可见）
       * ⇒ 那个判据零判别力，实测已推翻。
       */
      squeezed: spans.map((s) => {
        const range = document.createRange();
        range.selectNodeContents(s);
        const need = range.getBoundingClientRect().width;
        const box = s.getBoundingClientRect().width;
        return need - box > 1;
      }),
      height: r.height,
      lineHeight: parseFloat(cs.fontSize) * 1.6,
    };
  }, COUNT_ID);

  expect(m.missing ?? false, '计数行元素必须存在').toBe(false);
  // ---- 不溢出屏幕 ----
  expect(m.right, `右缘不得溢出屏幕（right ${m.right} vs 视口 ${m.innerWidth}）`)
    .toBeLessThanOrEqual(m.innerWidth);
  expect(m.boxSizing, '必须 border-box（否则 padding 会加到 max-width 外面）').toBe('border-box');

  // ---- 不换行 + 行尾省略号（整行截断的两个必要条件）----
  expect(m.whiteSpace, '必须 white-space:nowrap（不得换行）').toBe('nowrap');
  expect(m.overflow, '必须 overflow:hidden').toBe('hidden');
  expect(m.textOverflow, '必须 text-overflow:ellipsis（否则硬切，看不到省略号）').toBe('ellipsis');
  expect(m.display, '必须是块容器（text-overflow 对 flex 项无效）').toBe('block');
  expect(m.height, '仍为单行（截断不得换成两行）').toBeLessThan(m.lineHeight * 1.9);

  // ---- 真的被截了 ----
  expect(m.scrollWidth, `内容必须超出可视宽（scroll ${m.scrollWidth} / client ${m.clientWidth}）`)
    .toBeGreaterThan(m.clientWidth);
  expect(m.count, '五项元素仍在（截断 ≠ 删除）').toBe(5);

  // ---- ⭐ 降级形态：每项自身不得被压碎（截断只发生在容器层面）----
  //
  // 这一条是本用例的核心：它区分「整行截断」（正确 —— 后面的项被推出可见区，
  // 前面的项数字完整可读）与「flex 逐项压缩」（缺陷 —— 五项都被压成 `尸…`，
  // 一个数字都读不出来）。
  // ⚠️ 两次实测推翻的判据，别再用：
  //   ① `span.scrollWidth > span.clientWidth` —— 块容器下行内 span 两者**恒为 0**，恒假；
  //   ② `span 是否落在容器可见区内` —— 对两种形态读数几乎相同（前两项都可见），零判别力。
  // 有效的是「盒宽是否仍容得下自己的文字」：整行截断下每项盒宽 = 文字宽；
  // 逐项压缩下盒宽被压到 17px 而文字需 26px。
  expect(m.squeezed, '任何一项都不得被压碎（压缩只能发生在容器层面）')
    .toEqual(Array(5).fill(false));
});

test('敌人计数行：宽视口下不缺省（充足空间时不画蛇添足加省略号）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1600, height: 900 });
  await boot(page);
  const m = await page.evaluate((id) => {
    const el = document.getElementById(id);
    return {
      scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
      texts: [...el.querySelectorAll('span')].map((s) => s.textContent.trim()),
    };
  }, COUNT_ID);
  expect(m.texts.length, '五项都在').toBe(5);
  // 空间充足时内容宽 ≤ 可视宽 ⇒ 不触发省略号（全数字可读）
  expect(m.scrollWidth, `宽屏下不该被压（scroll ${m.scrollWidth} / client ${m.clientWidth}）`)
    .toBeLessThanOrEqual(m.clientWidth + 1);
});

test('雨天档雨声复用 rain.mp3（v3.36 用户裁定）：开启不启播 rain_storm', async ({ page }) => {
  test.setTimeout(240_000);
  await boot(page, '&skybox=0&weather=clear');
  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    g.setStormLighting(true);
    await new Promise((res) => setTimeout(res, 900));
    const on = g.audioManager.debugLoops();
    g.setStormLighting(false);
    await new Promise((res) => setTimeout(res, 400));
    return { on, off: g.audioManager.debugLoops(), stormActive: g.stormLighting };
  });
  expect(r.stormActive, '关档后 stormActive 必须为 false').toBe(false);
  expect(r.on.rain_storm, 'v3.36 起不得再启播 rain_storm（改用 rain.mp3）').toBeUndefined();
  expect(r.on.rain?.playing, '开启时雨声在播').toBe(true);
  expect(r.on.rain.target, '音量必须是雨天档值').toBeCloseTo(STORM_AUDIO.rainVolume, 2);
});