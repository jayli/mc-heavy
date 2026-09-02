import { test, expect } from 'playwright/test';

// M3-2 验收：预算参数标定（60Hz/120Hz 双档，roadmap Task M3-2）
// 档位数值冻结在 core/budget.js（浏览器单测 test-budget.js 覆盖判定逻辑，
// 含 16.7ms 帧间隔喂样 → 判 low 的 60Hz 模拟）。本 spec 验证端到端接线：
// ① 本机 120Hz：auto 档运行时测量判 'high'，fps ≥115；
// ② 显式 ?budget=low（60Hz 档参数注入）：Scheduler 消费 6ms/128 预算，fps ≥55
//    （120Hz vsync 下跑 low 档只会更宽松，验证低档位不劣化性能）。
// 注：roadmap 原拟 --disable-frame-rate-limit 模拟 60Hz，实测该 flag 是解除限帧
// 而非产生 60Hz vsync，无法真实模拟；60Hz 判定改由单测喂帧间隔覆盖（口径等价）。

test('M3-2：auto 档 120Hz 判 high + fps ≥115', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/?vd=8&seed=12345');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => window.__MC_GAME__.world.columns.size >= 289, null, { timeout: 90_000 });
  // 等启动 burst 完全收敛（队列归零），再等 6s 让 PerfMonitor 600 帧窗口
  // 全部刷成稳态帧——窗口若含 burst 尾段（mesh-inflight p95=64），fps 被拉低到 ~106
  await page.waitForFunction(() => {
    const s = window.__MC_GAME__.scheduler.stats();
    return s.inflight === 0 && s.meshInflight === 0 && s.uploadQueue === 0;
  }, null, { timeout: 60_000 });
  await new Promise((r) => setTimeout(r, 6000));

  const snap = await page.evaluate(() => window.__MC_GAME__.budget.snapshot());
  console.log('M3-2 AUTO:', JSON.stringify(snap));
  // 本机 120Hz（headless channel:'chromium' 跟随显示器刷新）：120 帧窗口后应锁定 high
  expect(snap.profile).toBe('auto');
  expect(snap.resolved).toBe('high');
  expect(snap.meshUploadBudgetMs).toBe(3);
  expect(snap.meshDispatchPerFrame).toBe(64);

  const perf = await page.evaluate(() => window.__MC_GAME__.perfSnapshot());
  console.log('M3-2 PERF(high):', JSON.stringify({ fps: perf.fps, p95: perf.frameMs.p95 }));
  expect(perf.fps).toBeGreaterThan(process.env.CI ? 20 : 115);
  expect(perf.frameMs.p95).toBeLessThan(process.env.CI ? 50 : 16.7);
});

test('M3-2：?budget=low 显式 60Hz 档生效 + fps ≥55', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/?vd=8&budget=low&seed=12345');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => window.__MC_GAME__.world.columns.size >= 250, null, { timeout: 90_000 });
  await new Promise((r) => setTimeout(r, 3000));

  // 显式档位立即生效，且 Scheduler 消费的就是这份配置
  const snap = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return { game: g.budget.snapshot(), schedulerSame: g.scheduler.budget === g.budget };
  });
  console.log('M3-2 LOW:', JSON.stringify(snap));
  expect(snap.schedulerSame).toBe(true);
  expect(snap.game.resolved).toBe('low');
  expect(snap.game.meshUploadBudgetMs).toBe(6);
  expect(snap.game.meshDispatchPerFrame).toBe(128);

  // low 档（更宽松预算）在 120Hz 下不劣化：fps ≥55（roadmap 口径），实测应为 vsync 满帧
  await page.evaluate(() => { window.__MC_GAME__.player.keys.add('KeyW'); });
  await new Promise((r) => setTimeout(r, 8_000));
  await page.evaluate(() => { window.__MC_GAME__.player.keys.delete('KeyW'); });
  const perf = await page.evaluate(() => window.__MC_GAME__.perfSnapshot());
  console.log('M3-2 PERF(low):', JSON.stringify({ fps: perf.fps, p95: perf.frameMs.p95 }));
  expect(perf.fps).toBeGreaterThan(process.env.CI ? 20 : 55);
  expect(perf.frameMs.p95).toBeLessThan(process.env.CI ? 50 : 16.7);
});
