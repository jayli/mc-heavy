import { test, expect } from 'playwright/test';

test('结构生成管线全部用例通过（layout RPC / GEN 注入 / 预算 / 调度全链路）', async ({ page }) => {
  await page.goto('/src/tests/test-structure-gen.html');
  await page.waitForFunction(() => window.__STRUCTURE_GEN_RESULTS__ !== undefined, null, { timeout: 60_000 });
  const r = await page.evaluate(() => window.__STRUCTURE_GEN_RESULTS__);
  expect(r.errors).toEqual([]);
  expect(r.failed).toBe(0);
  expect(r.passed).toBeGreaterThan(0);
});
