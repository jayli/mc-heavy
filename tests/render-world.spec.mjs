import { test, expect } from 'playwright/test';

test('RenderWorld BatchedMesh 发布层全部用例通过', async ({ page }) => {
  await page.goto('/src/tests/test-render-world.html');
  await page.waitForFunction(() => window.__RENDER_WORLD_RESULTS__ !== undefined, null, { timeout: 60_000 });
  const r = await page.evaluate(() => window.__RENDER_WORLD_RESULTS__);
  expect(r.errors).toEqual([]);
  expect(r.failed).toBe(0);
  expect(r.passed).toBeGreaterThan(0);
});
