import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

/**
 * 「这里可以召唤 Boss」提示（v3.16）真游戏页 E2E —— Tier 4 像素实测。
 *
 * ## 为什么单测不够
 *
 * 单测（`src/tests/test-boss-hint.js`）钉的是判据与 DOM class。三类缺陷它抓不到：
 *   ① **没接进帧循环** —— 玩家真的走过去时提示不动（class 恒 false），而单测里是自己
 *      手调 `update()` 的 ⇒ 全绿；
 *   ② **CSS 没生效 / 被别的 HUD 盖住 / 跑出屏幕** —— class 对但玩家看不见；
 *   ③ **锚点未预热** —— 首次走进未知区域时卡一帧（111ms），只有真实页能测。
 *
 * ## 判据选型（避坑）
 *
 * · 召唤一律走**真实 KeyB**（AGENTS.md M7 教训：直接调 service.summon 会漏接线缺陷）；
 * · 移动一律走 `_teleportTo`（它会加载目标 column；`player.spawn` 不加载）；
 * · 像素判据**同时钉上下界**（只钉「变亮」抓不到「整片纯白」），且先测同状态重复截图的
 *   噪声底 —— 本提示的呼吸动画只落在指示条上，故采样区取**文字区**（静态）；
 * · 「消失」用 `isVisible()` + computed visibility 双判（class 与 CSS 两层都要对）。
 */

const SEED = 12345;
const HINT = '#mc-boss-hint';

async function boot(page, query = '') {
  await page.goto(`/?vd=4&seed=${SEED}${query}`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
}

/** 读祭坛地带中心（gen 层权威，不自写一份） */
async function tarnCenter(page) {
  return page.evaluate(async () => {
    const { findAltarTarnRegion } = await import('/src/gen/structures/tarn-zone.js');
    const a = findAltarTarnRegion(window.__MC_GAME__.seed);
    return a ? { cx: a.cx, cz: a.cz } : null;
  });
}

/** 传送到某点上空并等该 column 加载（真实入口） */
async function goto(page, x, z, y = 40) {
  await page.evaluate(([px, py, pz]) => window.__MC_GAME__._teleportTo(px, py, pz), [x, y, z]);
  await page.waitForFunction(([px, pz]) => {
    const g = window.__MC_GAME__;
    return g.world.hasColumn(Math.floor(px / 16), Math.floor(pz / 16));
  }, [x, z], { timeout: 60_000 });
}

/** 按 B（真实键盘事件） */
async function pressB(page) {
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB', repeat: false, bubbles: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyB', bubbles: true, cancelable: true }));
  });
}

/** 提示的可见状态 + 文案 + 几何（一次 evaluate 取全，避免多轮往返期间状态漂移） */
const readHint = () => {
  const el = document.getElementById('mc-boss-hint');
  if (!el) return { exists: false };
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const sub = el.querySelector('.mc-bh-sub');
  return {
    exists: true,
    on: el.classList.contains('mc-boss-hint-on'),
    visibility: cs.visibility,
    opacity: Number(cs.opacity),
    zIndex: cs.zIndex,
    pointerEvents: cs.pointerEvents,
    parentIsHud: el.parentElement?.id === 'hud-root',
    text: el.textContent,
    sub: sub?.textContent ?? '',
    rect: { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom, right: r.right },
    vw: window.innerWidth, vh: window.innerHeight,
    hudVisible: window.__MC_GAME__._bossHint.isVisible(),
  };
};

/** 等提示达到期望的可见态（节流 250ms ⇒ 窗口给 5s 足够） */
async function waitHint(page, want, timeout = 8_000) {
  await page.waitForFunction((w) => {
    const g = window.__MC_GAME__;
    return !!g?._bossHint && g._bossHint.isVisible() === w;
  }, want, { timeout });
  // 过渡 0.18s：等它收尾，像素采样才稳定
  await page.waitForTimeout(320);
}

test('Boss 提示: 出生在城市里不显示；走进高台地带自动出现（真实帧循环驱动）', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  const c = await tarnCenter(page);
  expect(c, '前提：seed 12345 有祭坛地带').not.toBeNull();

  // ① 出生点在城市 bounds 内（城市没登记 Boss）
  const atSpawn = await page.evaluate(readHint);
  expect(atSpawn.exists, '提示元素必须已装配').toBe(true);
  expect(atSpawn.hudVisible, '城市里不得提示（那里没有 Boss）').toBe(false);
  expect(atSpawn.visibility, 'CSS 层也必须真的隐藏').toBe('hidden');

  // ② 走进地带 —— **不手调 update**，靠帧循环自己算出来
  await goto(page, c.cx, c.cz);
  await waitHint(page, true);
  const inZone = await page.evaluate(readHint);
  expect(inZone.on).toBe(true);
  expect(inZone.visibility).toBe('visible');
  expect(inZone.opacity, '完全显形').toBeCloseTo(1, 1);
  expect(inZone.text).toContain('可召唤 Boss');
  expect(inZone.text).toContain('B');
  expect(inZone.sub, '副行点名下一个 Boss = 祭坛飞龙').toContain('祭坛飞龙');
  expect(inZone.sub).toContain('Boss1');

  // ③ 层级 / 命中 / 归属 / 在屏内
  expect(inZone.zIndex, '与看板/血心同层').toBe('50');
  expect(inZone.pointerEvents, '不得挡交互').toBe('none');
  expect(inZone.parentIsHud, '挂 hud-root 下（随 HUD 一起被隐藏）').toBe(true);
  expect(inZone.rect.w).toBeGreaterThan(80);
  expect(inZone.rect.h).toBeGreaterThan(20);
  expect(inZone.rect.x, '左缘在屏内').toBeGreaterThanOrEqual(0);
  expect(inZone.rect.right, '右缘在屏内').toBeLessThanOrEqual(inZone.vw);
  expect(inZone.rect.bottom, '底缘在屏内').toBeLessThanOrEqual(inZone.vh);

  // ④ 不与快捷栏重叠（提示在它上方）
  const gap = await page.evaluate(() => {
    const hint = document.getElementById('mc-boss-hint').getBoundingClientRect();
    const bar = document.getElementById('mc-hotbar').getBoundingClientRect();
    return bar.top - hint.bottom;
  });
  expect(gap, '提示必须完整落在快捷栏上方（不遮挡物品栏）').toBeGreaterThanOrEqual(10);

  // ⑤ 走出去 → 消失（真实帧循环）
  await goto(page, 9999, 9999);
  await waitHint(page, false);
  const outside = await page.evaluate(readHint);
  expect(outside.on).toBe(false);
  expect(outside.visibility).toBe('hidden');
});

test('Boss 提示: 按 B 召出 Boss1 后提示仍在（还能召 Boss2），召满才消失', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  const c = await tarnCenter(page);
  await goto(page, c.cx, c.cz);
  await waitHint(page, true);
  // 等玩家落地（焰魔的落点扫描要真实地面；悬空时会召到空中结构上）
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    return g.world.isSolid(Math.floor(p.x), Math.floor(p.y - 0.5), Math.floor(p.z));
  }, null, { timeout: 60_000 });

  // 第一次 B → 飞龙
  await pressB(page);
  await page.waitForFunction(() => (window.__MC_GAME__.dragons?.activeEntities().length ?? 0) >= 1,
    null, { timeout: 20_000 });
  await waitHint(page, true);
  const afterFirst = await page.evaluate(readHint);
  expect(afterFirst.sub, '⚠️ 还能召 Boss2 ⇒ 提示必须还在，且副行换成焰魔').toContain('焰魔');
  expect(afterFirst.sub).toContain('Boss2');

  // 第二次 B → 焰魔（两个槽位都占）
  await pressB(page);
  await page.waitForFunction(() => (window.__MC_GAME__.ignises?.activeEntities().length ?? 0) >= 1,
    null, { timeout: 20_000 });
  await waitHint(page, false);
  const afterSecond = await page.evaluate(readHint);
  expect(afterSecond.on, '召满了 ⇒ 提示消失（用户明确要求）').toBe(false);
  expect(afterSecond.visibility).toBe('hidden');

  // 第三次 B 确实召不出（提示与真实结果一致的交叉验证）
  await pressB(page);
  await page.waitForTimeout(400);
  const toast = await page.evaluate(() => document.getElementById('mc-toast')?.textContent ?? '');
  expect(toast, '按 B 的真实结果必须是「都在了」').toContain('Boss 都在了');
});

test('Boss 提示: 打死一只 Boss 后提示自己回来（不记「已召过」标记）', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  const c = await tarnCenter(page);
  await goto(page, c.cx, c.cz);
  await waitHint(page, true);
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    return g.world.isSolid(Math.floor(p.x), Math.floor(p.y - 0.5), Math.floor(p.z));
  }, null, { timeout: 60_000 });

  await pressB(page);
  await page.waitForFunction(() => (window.__MC_GAME__.dragons?.activeEntities().length ?? 0) >= 1,
    null, { timeout: 20_000 });
  await pressB(page);
  await page.waitForFunction(() => (window.__MC_GAME__.ignises?.activeEntities().length ?? 0) >= 1,
    null, { timeout: 20_000 });
  await waitHint(page, false);

  // 打死飞龙（真实伤害入口）
  const killed = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const e = g.dragons.activeEntities()[0];
    return g.damageEntity(e.id, 100000, performance.now())?.dead === true;
  });
  expect(killed, '前提：飞龙被打死').toBe(true);
  await waitHint(page, true);
  const revived = await page.evaluate(readHint);
  expect(revived.sub, '空出来的是 slot0 ⇒ 副行回到飞龙').toContain('祭坛飞龙');
  expect(revived.sub).toContain('Boss1');
});

test('Boss 提示: 单 Boss 地图（围场）召一只就消失，且与真实按键结果一致', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  const a = await page.evaluate(async () => {
    const { computeArenaAnchor } = await import('/src/gen/structures/arena.js');
    const x = computeArenaAnchor(window.__MC_GAME__.seed);
    return x ? { wx: x.wx, wz: x.wz, floorY: x.floorY } : null;
  });
  expect(a, '前提：seed 12345 有围场').not.toBeNull();
  await goto(page, a.wx, a.wz, a.floorY + 2);
  await waitHint(page, true);
  const before = await page.evaluate(readHint);
  expect(before.sub, '围场唯一的 Boss 是末影守卫').toContain('末影守卫');
  expect(before.sub).toContain('Boss1');

  await pressB(page);
  await page.waitForFunction(() => (window.__MC_GAME__.guardians?.activeEntities().length ?? 0) >= 1,
    null, { timeout: 20_000 });
  await waitHint(page, false);
  expect((await page.evaluate(readHint)).on, '围场只有一个 Boss ⇒ 召了就没了').toBe(false);
});

test('Boss 提示: 像素实测 —— 提示区真的画出来了（显示/隐藏两态对照 + 噪声底）', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  const c = await tarnCenter(page);
  await goto(page, c.cx, c.cz);
  await waitHint(page, true);
  // 冻结画面变量：日夜/阴影/物理（提示自身的呼吸动画不落在采样区 —— 只取文字区）
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    g.setVisualStyle('noon');
    g.setShadowsEnabled(false);
    g.player.physics.step = () => {};
  });
  await page.waitForTimeout(600);

  /** 采样区 = 提示的文字区（避开左侧脉动指示条，那是唯一在动的部分） */
  const box = await page.evaluate(() => {
    const t = document.querySelector('#mc-boss-hint .mc-bh-text').getBoundingClientRect();
    return { x: Math.floor(t.x), y: Math.floor(t.y), w: Math.ceil(t.width), h: Math.ceil(t.height) };
  });
  expect(box.w, '前置：文字区有实际尺寸').toBeGreaterThan(40);
  expect(box.h).toBeGreaterThan(14);

  /** 数「琥珀金主标题」像素：r>g>b 且 r−b>60（金 #ffd75e = 255,215,94） */
  const countGold = (png, b) => {
    let n = 0;
    for (let y = b.y; y < b.y + b.h; y += 1) {
      for (let x = b.x; x < b.x + b.w; x += 1) {
        const i = (png.width * y + x) * 4;
        const [r, g, bl] = [png.data[i], png.data[i + 1], png.data[i + 2]];
        if (r > 170 && r > g && g > bl && r - bl > 60) n += 1;
      }
    }
    return n;
  };
  const shot = async () => PNG.sync.read(await page.screenshot());

  // 噪声底：同状态重复两次（呼吸动画不影响文字区）
  const n1 = countGold(await shot(), box);
  const n2 = countGold(await shot(), box);
  const noise = Math.abs(n1 - n2);

  // 隐藏态（走出去）：同一屏幕区域的金像素数
  await goto(page, 9999, 9999);
  await waitHint(page, false);
  await page.waitForTimeout(400);
  const off = countGold(await shot(), box);

  // 再走回来：确认是可复现的显示（不是偶然的一次渲染）
  await goto(page, c.cx, c.cz);
  await waitHint(page, true);
  await page.waitForTimeout(400);
  const on2 = countGold(await shot(), box);

  // 上下界都钉：下界防「没画/404/被盖住」，上界防「整片纯金」（那不是文字）
  const area = box.w * box.h;
  expect(n1, `显示态金像素必须显著多于隐藏态（on=${n1} off=${off} noise=${noise}）`)
    .toBeGreaterThan(off + noise + 60);
  expect(on2, '再次显示必须复现（与首次相差在噪声量级）').toBeGreaterThan(off + noise + 60);
  expect(Math.abs(on2 - n1), '两次显示态读数应稳定').toBeLessThan(Math.max(40, n1 * 0.25));
  expect(n1, '金像素不得超过采样区一半（超过说明整片被涂满，不是文字）').toBeLessThan(area * 0.5);
  expect(off, `隐藏态该区几乎无金像素（实测 ${off}）`).toBeLessThan(60);
});

test('Boss 提示: 窄屏（手机竖屏）不换行、不溢出、不压快捷栏', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 780 });
  await boot(page);
  const c = await tarnCenter(page);
  await goto(page, c.cx, c.cz);
  await waitHint(page, true);
  const m = await page.evaluate(() => {
    const el = document.getElementById('mc-boss-hint');
    const r = el.getBoundingClientRect();
    const title = el.querySelector('.mc-bh-title');
    const sub = el.querySelector('.mc-bh-sub');
    // ⚠️ **折行判据只能数「不同的行顶边 y」，不能数行盒个数**（实测踩到）：
    // 副行含 <b> + 匿名文本 + <i>，`Range.getClientRects()` 在**单行**时就返回 4 个盒
    //（每个行内节点一个，且部分重叠）⇒ 拿 `length === 1` 当单行判据会恒红。
    // 同理 `scrollWidth <= clientWidth` 对折行无判别力（AGENTS.md 已记）。
    const lines = (node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return new Set([...range.getClientRects()].map((b) => Math.round(b.y))).size;
    };
    const bar = document.getElementById('mc-hotbar').getBoundingClientRect();
    return {
      x: r.x, right: r.right, bottom: r.bottom, h: r.height,
      vw: window.innerWidth, vh: window.innerHeight,
      titleLines: lines(title), subLines: lines(sub),
      barTop: bar.top, barLeft: bar.x, barRight: bar.right,
      fontSize: getComputedStyle(title).fontSize,
    };
  });
  expect(m.x, '左缘不得出屏').toBeGreaterThanOrEqual(0);
  expect(m.right, '右缘不得出屏').toBeLessThanOrEqual(m.vw);
  expect(m.bottom, '底缘不得出屏').toBeLessThanOrEqual(m.vh);
  expect(m.titleLines, '主标题必须单行').toBe(1);
  expect(m.subLines, '副行必须单行').toBe(1);
  // 实测回归：窄屏档曾写 bottom:64px ⇒ gap **0**（与快捷栏黑边紧贴）。
  // 快捷栏顶边距屏底 64px（12 + 52 总盒高），提示 bottom:76 ⇒ 恒 12px 间距。
  expect(m.barTop - m.bottom, '窄屏下仍须与快捷栏留间距（实测曾为 0）').toBeGreaterThanOrEqual(10);
});

test('Boss 提示: 帧循环里的判据开销 —— 预热后单次 bossMapAt < 2ms（不卡帧）', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  const m = await page.evaluate(async () => {
    const { bossMapAt } = await import('/src/entities/bosses/boss-map.js');
    const g = window.__MC_GAME__;
    const samples = [];
    for (let i = 0; i < 200; i++) {
      const x = (i * 137) % 12000 - 4000, z = (i * 311) % 12000 - 4000;
      const t = performance.now();
      bossMapAt(x, z, g.seed);
      samples.push(performance.now() - t);
    }
    samples.sort((a, b) => a - b);
    return { worst: samples[samples.length - 1], p99: samples[197], median: samples[100] };
  });
  // 未预热时首次远点调用实测 111ms（Node 侧）。启动期 warmBossAnchors 之后必须落到 ms 以下量级。
  expect(m.worst, `预热后最坏耗时应 < 2ms（实测 ${m.worst.toFixed(3)}ms）`).toBeLessThan(2);
});