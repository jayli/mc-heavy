import { test, expect } from 'playwright/test';

test('WorkerPool RPC 全部用例通过', async ({ page }) => {
  await page.goto('/src/tests/test-worker-pool.html');
  await page.waitForFunction(() => window.__WORKER_POOL_RESULTS__ !== undefined, null, { timeout: 30_000 });
  const r = await page.evaluate(() => window.__WORKER_POOL_RESULTS__);
  expect(r.errors).toEqual([]);
  expect(r.failed).toBe(0);
  expect(r.passed).toBeGreaterThan(0);
});
