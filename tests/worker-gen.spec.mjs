import { test, expect } from 'playwright/test';

test('Worker GEN 管线全部用例通过', async ({ page }) => {
  await page.goto('/src/tests/test-worker-gen.html');
  await page.waitForFunction(() => window.__WORKER_GEN_RESULTS__ !== undefined, null, { timeout: 60_000 });
  const r = await page.evaluate(() => window.__WORKER_GEN_RESULTS__);
  expect(r.errors).toEqual([]);
  expect(r.failed).toBe(0);
  expect(r.passed).toBeGreaterThan(0);
});
