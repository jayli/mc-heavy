import { test, expect } from 'playwright/test';

// M4 验收：视距 8 完整场景下持续加特林连射，不使 M3 冻结基线回退。
// 帧时口径与全部性能 spec 一致：fps 为主断言，frameMs.p95<16.7 作防跌破 60fps 二级门
// （120Hz vsync 锁帧下 p95<8.3 数学上不可满足，见 CLAUDE.md「性能验收口径」）。
// draw call：minigun 不得高于徒手 +2（视图模型 1 draw + 曳光 InstancedMesh 1 draw）。

async function waitForStableVD8(page) {
  await page.goto('/?vd=8');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => window.__MC_GAME__.world.columns.size >= 289, null, { timeout: 90_000 });
  await page.waitForFunction(() => {
    const s = window.__MC_GAME__.scheduler.stats();
    return s.genInflight === 0 && s.meshInflight === 0 && s.meshQueued === 0 &&
      s.pendingMesh === 0 && s.lightInflight === 0 && s.lightQueued === 0 && s.uploadQueue === 0;
  }, null, { timeout: 60_000 });
  await page.waitForTimeout(5_000);
}

test('M4：视距 8 下持续加特林不回退 M3 基线', async ({ page }) => {
  test.setTimeout(180_000);
  await waitForStableVD8(page);
  // 隔离阴影这个新引入的独立变量（太阳阴影接线）：本 URL 不带 style= → 日夜循环模式，
  // `DayNight.update()` 每帧触发 onSunDirection → 阴影贴图每 200ms 重渲一次，而 VSM 下
  // receiveShadow 对象也进阴影 pass → 重渲帧 drawCalls 尖峰（vd=8 实测稳态 460/514 →
  // 尖峰 525/624，+50~110，逐帧 600 次采样中占 4.0%）。且加特林连射本身经
  // editor.subscribe 请求阴影刷新 → 射击窗口内尖峰概率进一步升高。断言
  // `during <= before + 2` 容差仅 +2，during 撞尖峰即吹爆（实测 10 次连跑中 1 次 FAIL：
  // 454→504，Δ50 = 尖峰而非武器 draw）。本 spec 的被测对象是**武器渲染开销**
  // （minigun 不得高于徒手 +2），不是阴影 —— 按「对照只差一个变量」原则在世界稳定后关阴影，
  // 覆盖全部 3 处 drawCalls 读取（before/during/after）。手法同 render-terrain /
  // daynight-visual 的隔离；断言与阈值逐字不动。
  // ⚠️ 关阴影是零开销关闭（onSunDirection 的 castShadow 门控，见 game.js）：实测关后
  // 逐帧采样恒为单值、无尖峰。该门控由 sun-shadow.spec.mjs 的专项用例钉住。
  await page.evaluate(() => window.__MC_GAME__.setShadowsEnabled(false));
  await page.waitForTimeout(300);   // 跨过节流窗口，让关阴影前挂起的请求被 tick 消费完
  const before = await page.evaluate(() => ({
    ...window.__MC_GAME__.perfSnapshot(),
    drawCalls: window.__MC_GAME__.renderStats().drawCalls,
  }));
  await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    await g.selectWeapon('minigun');
    for (let i = 0; i < 100; i++) {
      g.fireWeaponOnce();
      if (i < 99) await new Promise((resolve) => setTimeout(resolve, 70));
    }
  });
  const during = await page.evaluate(() => ({
    ...window.__MC_GAME__.perfSnapshot(),
    drawCalls: window.__MC_GAME__.renderStats().drawCalls,
    weapon: window.__MC_GAME__.weaponDebugState(),
  }));
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const s = g.scheduler.stats();
    return s.genInflight === 0 && s.meshInflight === 0 && s.meshQueued === 0 &&
      s.pendingMesh === 0 && s.lightInflight === 0 && s.lightQueued === 0 &&
      s.uploadQueue === 0 && g.weaponDebugState().activeTracers === 0;
  }, null, { timeout: 60_000 });
  const after = await page.evaluate(() => ({
    ...window.__MC_GAME__.perfSnapshot(),
    drawCalls: window.__MC_GAME__.renderStats().drawCalls,
    weapon: window.__MC_GAME__.weaponDebugState(),
    scheduler: window.__MC_GAME__.scheduler.stats(),
  }));
  expect(after.fps).toBeGreaterThan(process.env.CI ? 20 : 90);
  expect(after.frameMs.p95).toBeLessThan(process.env.CI ? 50 : 16.7);
  expect(during.drawCalls).toBeLessThanOrEqual(before.drawCalls + 2);
  expect(during.weapon.activeTracers).toBeLessThanOrEqual(32);
  expect(after.scheduler.genInflight).toBe(0);
  expect(after.scheduler.meshInflight).toBe(0);
  expect(after.scheduler.meshQueued).toBe(0);
  expect(after.scheduler.pendingMesh).toBe(0);
  expect(after.scheduler.lightInflight).toBe(0);
  expect(after.scheduler.lightQueued).toBe(0);
  expect(after.scheduler.uploadQueue).toBe(0);
});
