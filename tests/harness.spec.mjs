import { test, expect } from 'playwright/test';

test('浏览器测试 harness 正常运行且 0 失败', async ({ page }) => {
  await page.goto('/src/tests/index.html');
  await page.waitForFunction(() => window.__MC_TEST_RESULTS__ !== undefined, null, { timeout: 30_000 });
  const results = await page.evaluate(() => window.__MC_TEST_RESULTS__);
  expect(results.total).toBeGreaterThan(0);
  expect(results.failed).toBe(0);
});
