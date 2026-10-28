import { test, expect } from 'playwright/test';

// M4 武器纯逻辑层（catalog / policy / MAG7 扫描 / 控制器）的 Tier 1 断言
// 落在浏览器内 runner 中，本 spec 只验证它们被页面加载且 0 失败。
test('M4：武器纯逻辑浏览器单测通过', async ({ page }) => {
  await page.goto('/src/tests/index.html');
  await page.waitForFunction(
    () => window.__MC_TEST_RESULTS__ !== undefined,
    null,
    { timeout: 90_000 },
  );
  const results = await page.evaluate(() => window.__MC_TEST_RESULTS__);
  expect(results.failed).toBe(0);
});
