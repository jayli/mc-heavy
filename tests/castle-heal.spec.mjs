import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

// tests/castle-heal.spec.mjs — 回城回血的接线与观感（v3.56，用户 2026-11-28）
//
// 用户原话：「我增加一个给玩家回血的逻辑，当玩家回到最初诞生时的城堡的位置，就自动回血完成，
// 回血的过程是一个动画，比如玩家现在只有一格血，回到 City 中心的城堡时，就 100ms 半格血的
// 速度回血，直到满血。」后续裁定：「按你的判断做，每 100ms +1 格，直接开工」。
//
// ## 为什么这一层必须存在（纯函数单测拓不到的三类缺陷）
//
// `src/tests/test-castle-heal.js` 钉住了范围判据与推进器的全部数值语义，但它**不 import
// `core/game.js`**。以下三条只有真页面能拓到，且形态都是「静默」的：
//   ① **帧循环根本没调推进器** —— 玩家站在城堡里血不动（纯函数全绿）；
//   ② **写回丢了** —— 推进器算出 1→2，但没写回 `player.health`，血心不动；
//   ③ **HUD 没接 `healing`** —— 血真的回了，但**没有动画**（用户要的就是动画）。
//      `_healthHud.update(nowMs)` 漏传第二个参数就是这条，形态是「数值对、观感不对」。
//
// ## 判据选型
//
// - 数值：**读真实 `player.health` 随时间的序列**，不读内部 `_acc`（那是实现细节）。
//   同时钉「100ms 一格」的**斜率**与「离开城堡就停」「4 秒回满」两个边界。
// - 动画：**像素判据**（用户明确说「是一个动画」）。心跳脉冲只放大 1.35 倍（18px → 24px），
//   在整屏截图里约 60 像素的变化 —— 用「血心区非背景像素数」的差分来量，比 DOM 断言可靠
//   （DOM 上 `transform` 存在只证明设过，不证明真的画出来了）。
//   绿边用「四周带 vs 中心区」的差分（照 `damage-flash.spec.mjs` 已验证的口径 ——
//   单看带内绝对值会被草地/天空自身颜色淹没）。
//
// ## 冻结的动态源
//
// `?vd=4&shadows=0&reflect=0&stats=0` + 等玩家落地 + 固定 seed。回血期间玩家**不动**
// （`player.spawn` 后不喂输入），故 viewBob/stepLift 恒静；手臂在视野下方，不在血心区域。

const SEED = 12345;
const BAND = 40;

async function boot(page, query = '') {
  await page.goto(`/?vd=4&seed=${SEED}&shadows=0&reflect=0&stats=0${query}`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  // 等玩家真正落地（下坠会改变整个画面）
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    return g.world.isSolid(Math.floor(p.x), Math.floor(p.y - 0.5), Math.floor(p.z));
  }, null, { timeout: 30_000 });
  // 等血心图片全部解码（像素判据的前提）
  await page.waitForFunction(() => {
    const imgs = document.querySelectorAll('#mc-health img');
    return imgs.length === 20 && [...imgs].every((i) => i.complete && i.naturalWidth === 9);
  }, null, { timeout: 15_000 });
}

/** 把玩家挪到城堡中心（出生点）并等落地 */
async function gotoCastle(page, { dy = 0 } = {}) {
  await page.evaluate(async (d) => {
    const g = window.__MC_GAME__;
    g._teleportTo(g.spawnX, g.spawnY + d, g.spawnZ);
    await new Promise((r) => setTimeout(r, 400));
  }, dy);
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    return g.world.isSolid(Math.floor(p.x), Math.floor(p.y - 0.5), Math.floor(p.z));
  }, null, { timeout: 30_000 });
}

/** 把玩家挪到城堡范围之外（城市里但远离中心，用于「离开就停」） */
async function gotoOutside(page) {
  await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const { CASTLE_HEAL_HALF } = await import('/src/player/castle-heal.js');
    // 沿 +x 走 3 倍半径：仍在 City bounds 内（halfSize 实测 283），但明确在回血范围外
    g._teleportTo(g.spawnX + CASTLE_HEAL_HALF * 3, g.spawnY + 2, g.spawnZ);
    await new Promise((r) => setTimeout(r, 400));
  });
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    return g.world.isSolid(Math.floor(p.x), Math.floor(p.y - 0.5), Math.floor(p.z));
  }, null, { timeout: 30_000 });
}

/** 血心区（`#mc-health` 的矩形）的截图裁剪 —— 键名必须是 `width`/`height`（`page.screenshot` 的 clip 契约） */
const HEARTS_RECT = () => {
  const r = document.getElementById('mc-health').getBoundingClientRect();
  return {
    x: Math.floor(r.left), y: Math.floor(r.top),
    width: Math.ceil(r.width), height: Math.ceil(r.height),
  };
};

/** 血心区「非 HUD 底色」像素数：脉冲放大后心形覆盖面积会变多 */
function countHeartPixels(png) {
  const { width, height, data } = png;
  let n = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (width * y + x) * 4;
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      // 心是饱和红（255,19,19）或它的暗描边；背景是世界（草地/沙/天空）。
      // 判据取「红显著高于绿蓝」—— 与 health-hud.spec.mjs 同一口径。
      if (r > 110 && r - g > 45 && r - b > 45) n += 1;
    }
  }
  return n;
}

/**
 * 四周 bandPx 带内的「偏绿度」均值 = mean(g − max(r,b))。
 *
 * ⚠️ **为什么用均值而不是计数**（本航实测推翻了自己的首版）：
 * 首版数「偏绿像素个数」，基线 **2294 → 3794**（仅 +1500）—— 因为**草地**本身就偏绿，
 * 计数里 60% 是背景。换成逐像素均值后同一对截图是 **−8.88 → +11.69（Δ+20.6）**，
 * 而中心区 −4.70 → −3.53（Δ+0.8）—— 两种信号完全分开（25 倍）。
 * 这正是 AGENTS.md 「判据选型比断言数量重要」那一条：计数类的分母被背景掎走了。
 */
function meanEdgeGreen(png, bandPx = BAND) {
  const { width, height, data } = png;
  let sum = 0, n = 0;
  for (let y = 0; y < height; y += 1) {
    const inBandY = y < bandPx || y >= height - bandPx;
    for (let x = 0; x < width; x += 1) {
      if (!inBandY && x >= bandPx && x < width - bandPx) continue;
      const i = (width * y + x) * 4;
      sum += data[i + 1] - Math.max(data[i], data[i + 2]);
      n += 1;
    }
  }
  return sum / n;
}

/** 中心区的同一个统计量 —— 绿边只该贴在四周，不得污染画面中央 */
function meanCenterGreen(png, bandPx = BAND) {
  const { width, height, data } = png;
  const x0 = Math.floor(width * 0.35), x1 = Math.floor(width * 0.65);
  const y0 = Math.max(bandPx * 2, Math.floor(height * 0.35));
  const y1 = Math.min(height - bandPx * 2, Math.floor(height * 0.65));
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (width * y + x) * 4;
      sum += data[i + 1] - Math.max(data[i], data[i + 2]);
      n += 1;
    }
  }
  return sum / n;
}

test.describe.configure({ mode: 'serial' });

test('回城回血：站进城堡范围后每 100ms 回 1 格，离开立刻停', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  await gotoCastle(page);

  // 打到 1 格（用户举例的起点），并确认在城堡范围内
  const start = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    g.player.health = 1;
    return { hp: g.player.health, inZone: g.isInCastleHealZone() };
  });
  expect(start.inZone, '前置：玩家必须在城堡回血范围内（spawnX/spawnZ 是 castle 中心）').toBe(true);
  expect(start.hp, '前置：血量打到 1 格').toBe(1);

  // 采样 2 秒（约 20 格）—— 读真实 player.health 而不是内部 _acc
  const samples = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const out = [];
    const t0 = performance.now();
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      out.push({ t: Math.round(performance.now() - t0), hp: g.player.health, active: g._castleHeal.active });
      if (g.player.health >= 40) break;
    }
    return out;
  });

  expect(samples.length, '必须有采样').toBeGreaterThan(4);
  expect(samples[0].active, '前置：回血推进器必须已激活（帧循环真的调了 _updateCastleHeal）').toBe(true);
  // 斜率：每 100ms 一格 ⇒ 从 1 走到 40 需要 3.9 秒。这里只验证「确实在涨」与「不超速」。
  const last = samples[samples.length - 1];
  expect(last.hp, '血量必须真的上涨（写回 player.health）').toBeGreaterThan(1);
  // 速度上界：耗时 2 秒内最多回 20 格（+ 1 格由采样抖动容差）
  const elapsed = last.t;
  const healed = last.hp - 1;
  const perSec = healed / (elapsed / 1000);
  expect(perSec, `回血速率必须≈10 格/秒（实测 ${perSec.toFixed(2)} 格/秒，${elapsed}ms 回 ${healed} 格）`)
    .toBeGreaterThan(6);
  expect(perSec, `回血速率不得明显超速（实测 ${perSec.toFixed(2)} 格/秒）`).toBeLessThan(14);

  // ---- 离开城堡：立刻停 ----
  await gotoOutside(page);
  const outside = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    g.player.health = 20;
    const hpBefore = g.player.health;
    await new Promise((r) => setTimeout(r, 700));   // 远超一个 100ms tick
    return {
      inZone: g.isInCastleHealZone(),
      hpBefore,
      hpAfter: g.player.health,
      active: g._castleHeal.active,
      glow: g._healGlow.active,
    };
  });
  expect(outside.inZone, '前置：玩家确实在城堡回血范围之外').toBe(false);
  expect(outside.hpAfter, '离开城堡后血量不得变化（不是继续回，也不是掉血）').toBe(outside.hpBefore);
  expect(outside.active, '离开后推进器必须 active=false').toBe(false);
  expect(outside.glow, '离开后绿边必须隐藏').toBe(false);
});

test('回城回血：从 0 血 4 秒回满，满血后停止且不再累积', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  await gotoCastle(page);

  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    g.player.health = 0;
    const t0 = performance.now();
    // 等到回满（最多 8 秒，理论 4.0 秒）
    while (g.player.health < 40 && performance.now() - t0 < 8000) {
      await new Promise((r2) => setTimeout(r2, 40));
    }
    const fullAt = performance.now() - t0;
    // 满血后再观察 400ms：不得溢出、推进器必须停
    await new Promise((r2) => setTimeout(r2, 400));
    return {
      hp: g.player.health,
      fullAt: Math.round(fullAt),
      active: g._castleHeal.active,
      totalHealed: g._castleHeal.totalHealed,
    };
  });

  expect(r.hp, '必须回满 40 格').toBe(40);
  // 40 格 × 100ms = 4000ms。浏览器帧调度会让它略长，但不得翻倍。
  expect(r.fullAt, `从 0 回满应≈4000ms（实测 ${r.fullAt}ms）`).toBeGreaterThan(3600);
  expect(r.fullAt, `从 0 回满不得慢于 6 秒（实测 ${r.fullAt}ms）`).toBeLessThan(6000);
  expect(r.active, '满血后推进器必须 active=false').toBe(false);
  expect(r.totalHealed, `本次统计应恰为 40 格（实测 ${r.totalHealed}）`).toBe(40);
});

test('回城回血动画 Tier 4：回血时血心脉冲放大（像素判据）', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  await gotoCastle(page);

  // 用「同一血量、回血 vs 不回血」对照，把「心数变化」这个混淆项排除掉：
  // 血量都停在 19 → heartsFor 给出同一个心形数组（9 颗满 + 1 颗半），
  // 两次截图的唯一差别就是**脉冲放大**。
  const rect = await page.evaluate(HEARTS_RECT);

  // ① 不回血（在范围外）：静止基线
  await gotoOutside(page);
  await page.evaluate(() => { window.__MC_GAME__.player.health = 19; });
  await page.waitForTimeout(250);   // 让 HUD 追上血量、脉冲彻底结束
  const idle = await page.screenshot({ clip: rect });
  const idleHearts = countHeartPixels(PNG.sync.read(idle));

  // ② 回血中：站回城堡，等下一次 tick 触发脉冲，立刻截图
  await gotoCastle(page);
  const pulsed = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    g.player.health = 19;
    // 等推进器真的回了一格（脉冲在血量变化那一帧启动）
    const t0 = performance.now();
    while (g.player.health === 19 && performance.now() - t0 < 2000) {
      await new Promise((r) => setTimeout(r, 16));
    }
    return { hp: g.player.health, pulsing: g._healthHud.pulsing, pulseIndex: g._healthHud.pulseIndex };
  });
  const healing = PNG.sync.read(await page.screenshot({ clip: rect }));
  const healingHearts = countHeartPixels(healing);

  expect(pulsed.hp, '前置：回血真的把血从 19 推到 20').toBe(20);
  expect(pulsed.pulsing, '前置：血心脉冲必须已启动（HUD 接了 healing 参数）').toBe(true);
  // ⚠️ 脉冲下标必须对应「最后一个非空的心」：20 格 = 10 颗满心 ⇒ 下标 9（第二排第一颗）
  expect(pulsed.pulseIndex, `脉冲下标应为最后一个亮起的心（实测 ${pulsed.pulseIndex}）`).toBe(9);

  expect(healingHearts, `回血脉冲必须让血心覆盖更多像素（回血 ${healingHearts} vs 静止 ${idleHearts}）`)
    .toBeGreaterThan(idleHearts + 30);
});

test('回城回血动画 Tier 4：绿边只出现在屏幕四周，不污染中心区', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  await gotoCastle(page);

  // 基线：站在城堡里但**满血**（不触发绿边）
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    g.player.health = 40;
    g._healGlow.reset();
  });
  await page.waitForTimeout(400);
  const before = PNG.sync.read(await page.screenshot());
  const edgeBefore = meanEdgeGreen(before);
  const centerBefore = meanCenterGreen(before);

  // 掉血 → 绿边亮起（直接写血量，不经 `_damagePlayer`：本用例只测绿边，不要红闪混入）
  await page.evaluate(() => { window.__MC_GAME__.player.health = 20; });
  await page.waitForFunction(() => window.__MC_GAME__._healGlow.active === true,
    null, { timeout: 5000 });

  // ⚠️ **呼吸会走谷底，不能取单张**：
  // 实测同一个 700ms 周期里 opacity 在 0.02 与 0.997 之间摆 —— 拍在谷底就量到
  // 「与基线逐位相同」的假阴性。扫一个完整周期取**最亮的那一帧**。
  // （截图本身 ~50ms，故用 6 张 × 100ms ≈ 覆盖 0.85 个周期；取 max）
  let edgePeak = -Infinity, centerAtPeak = 0, peakOpacity = 0;
  for (let i = 0; i < 8; i += 1) {
    const shot = PNG.sync.read(await page.screenshot());
    const op = await page.evaluate(() => Number(getComputedStyle(document.getElementById('mc-heal-glow')).opacity));
    const e = meanEdgeGreen(shot);
    if (e > edgePeak) { edgePeak = e; centerAtPeak = meanCenterGreen(shot); peakOpacity = op; }
    await page.waitForTimeout(90);
  }
  const glowActive = await page.evaluate(() => window.__MC_GAME__._healGlow.active);

  expect(glowActive, '前置：绿边已激活').toBe(true);
  expect(peakOpacity, '前置：扫到的确实是亮峰（不是呼吸谷底）').toBeGreaterThan(0.5);
  // 实测：基线 −8.88，亮峰 +11.69（Δ≈20.6）。阈值取 12 留两侧余量。
  expect(edgePeak - edgeBefore,
    `四周带内偏绿度必须显著上升（基线 ${edgeBefore.toFixed(2)} → 亮峰 ${edgePeak.toFixed(2)}）`)
    .toBeGreaterThan(12);
  // 实测：中心区 −4.70 → 同帧 ≈ −3.5（Δ<1.5）。阈值取 3。
  expect(Math.abs(centerAtPeak - centerBefore),
    `中心区不得被绿边污染（基线 ${centerBefore.toFixed(2)} → 同帧 ${centerAtPeak.toFixed(2)}）`)
    .toBeLessThan(3);
});

test('回城回血：绿边 z-index = 56（与红闪同层，压在红闪之上）且不吃输入', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  const m = await page.evaluate(async () => {
    const { HEAL_GLOW } = await import('/src/ui/heal-glow.js');
    const { DAMAGE_FLASH } = await import('/src/ui/damage-flash.js');
    const el = document.getElementById('mc-heal-glow');
    const red = document.getElementById('mc-damage-flash');
    return {
      declared: HEAL_GLOW.zIndex,
      damage: DAMAGE_FLASH.zIndex,
      actual: getComputedStyle(el).zIndex,
      pointerEvents: getComputedStyle(el).pointerEvents,
      band: HEAL_GLOW.bandPx,
      damageBand: DAMAGE_FLASH.bandPx,
      // 红闪先插入 ⇒ 绿边在 DOM 序里更后 ⇒ 同层时压在上方
      glowAfterDamage: !!(red && el && (red.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)),
      idleHidden: getComputedStyle(el).display === 'none',
    };
  });
  expect(m.declared, '绿边与红闪同层（56）').toBe(m.damage);
  expect(m.actual, '实际 z-index = 56').toBe('56');
  expect(m.declared, '不得取 100+（会盖掉启动错误遮罩）').toBeLessThan(100);
  expect(m.pointerEvents, '不吃输入').toBe('none');
  expect(m.band, '带宽必须复用红闪的 40px（切换状态时屏幕形状不得变化）').toBe(m.damageBand);
  expect(m.glowAfterDamage, '绿边必须在 DOM 序里晚于红闪 ⇒ 同层时压在它上面').toBe(true);
  expect(m.idleHidden, '空闲时必须 display:none（不占合成层）').toBe(true);
});

test('回城回血：城堡范围判定用真实世界坐标（不是"全城回血"）', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  await gotoCastle(page);

  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const { CASTLE_HEAL_HALF } = await import('/src/player/castle-heal.js');
    const out = [];
    // 沿 +x / +z / 斜向各取几个距离，全部走真实 `isInCastleHealZone()`（读游戏里的 spawnX/spawnZ）
    for (const d of [0, CASTLE_HEAL_HALF - 1, CASTLE_HEAL_HALF]) {
      g._teleportTo(g.spawnX + d, g.spawnY, g.spawnZ);
      await new Promise((rr) => setTimeout(rr, 60));
      out.push({ d, inside: g.isInCastleHealZone(), kind: 'inside' });
    }
    g._teleportTo(g.spawnX, g.spawnY, g.spawnZ + CASTLE_HEAL_HALF + 1);
    await new Promise((rr) => setTimeout(rr, 60));
    out.push({ d: CASTLE_HEAL_HALF + 1, inside: g.isInCastleHealZone(), kind: 'outside' });
    // 城市边缘（halfSize 实测 283）也必须在外
    const { buildCityLayout } = await import('/src/gen/structures/city-layout.js');
    const city = buildCityLayout(g.seed);
    g._teleportTo(city.centerX + city.halfSize - 2, g.spawnY, city.centerZ);
    await new Promise((rr) => setTimeout(rr, 60));
    out.push({ d: city.halfSize - 2, inside: g.isInCastleHealZone(), kind: 'cityEdge' });
    return out;
  });

  // ⚠️ 按 `kind` 分流而不是按距离比大小：首版把「27 格」也筛进了「≤ half」那一组
  // ⇒ 断言写着「≤26 必在范围内」却在 27 格上报红（测试自己的错，不是实现的错）。
  for (const s of r.filter((x) => x.kind === 'inside')) {
    expect(s.inside, `距中心 ${s.d} 格（≤ half=${26}）必须在范围内`).toBe(true);
  }
  const far = r.find((x) => x.kind === 'outside');
  expect(far.inside, `距中心 ${far.d} 格（> half=26）必须在范围外`).toBe(false);
  const edge = r.find((x) => x.kind === 'cityEdge');
  expect(edge.inside, '城市边缘不得回血（否则「回到城堡」的语义消失）').toBe(false);
});

test('回城回血：挨打不会误触发脉冲（只有回血才脉冲）', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  // ⚠️ **必须在城堡外打**：首版在城堡里打 —— 掉血后回血机制立刻介入（玩家在范围内且
  // 未满血），脉冲就真的启动了。那是**正确行为**，红的是测试的设定，不是实现。
  await gotoOutside(page);

  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    g.player.health = 40;
    // 等 HUD 追上满血、脉冲彻底结束
    for (let i = 0; i < 5; i += 1) await new Promise((r2) => requestAnimationFrame(r2));
    const beforePulse = g._healthHud.pulsing;
    g._damagePlayer(5, performance.now());
    // 等两帧让 HUD 追上掉血
    for (let i = 0; i < 4; i += 1) await new Promise((r2) => requestAnimationFrame(r2));
    return {
      hp: g.player.health, beforePulse, pulsing: g._healthHud.pulsing,
      inZone: g.isInCastleHealZone(), hearts: g._healthHud.hearts(),
    };
  });
  expect(r.inZone, '前置：玩家在城堡范围外（否则回血会合法地触发脉冲）').toBe(false);
  expect(r.beforePulse, '前置：打之前没有脉冲').toBe(false);
  expect(r.hp, '前置：掉血 5 格').toBe(35);
  expect(r.pulsing, '掉血不得触发血心脉冲（那是回血的动画，不是受击反馈）').toBe(false);
  // 血心读数仍必须正确反映掉血（脉冲与画心是两件事）
  expect(r.hearts[17], '35 格 = 17 颗满 + 1 颗半（第 18 颗）').toBe('half');
  expect(r.hearts[18], '第 19 颗空').toBe('empty');
});