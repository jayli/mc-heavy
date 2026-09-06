import { test, expect } from 'playwright/test';

// M4-0：WorldEditor 浏览器单测通过（批量语义 + 事件协调器的 Tier 1 断言
// 全部落在浏览器内 runner 中，本 spec 只验证它们被页面加载且 0 失败）
test('M4-0：WorldEditor 浏览器单测通过', async ({ page }) => {
  await page.goto('/src/tests/index.html');
  await page.waitForFunction(
    () => window.__MC_TEST_RESULTS__ !== undefined,
    null,
    { timeout: 30_000 },
  );
  const results = await page.evaluate(() => window.__MC_TEST_RESULTS__);
  expect(results.failed).toBe(0);
});
