import { test, expect } from 'playwright/test';

// 回归：初始化（GEN 叠加存档 edits 产生悬挑）时的阴影必须经扩散收敛，
// 无需玩家操作。此前 _enqueueLightIfOverhang 是死代码（在最高非air块之上找
// opaque，必为 air → 永不触发），导致进游戏即见悬挑/洞穴下方黑面，
// 放一个块才消失（实玩 bug）。
test('初始化：存档悬挑阴影自动扩散收敛（无需玩家操作）', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/src/tests/test-light-init.html');
  await page.waitForFunction(() => window.__LIGHT_INIT_RESULTS__ !== undefined, null, { timeout: 60_000 });
  const r = await page.evaluate(() => window.__LIGHT_INIT_RESULTS__);
  expect(r.errors).toEqual([]);
  expect(r.failed).toBe(0);
  expect(r.passed).toBeGreaterThan(0);
});
