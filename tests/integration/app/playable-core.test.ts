import { expect, test } from '@playwright/test';

test('loads a spawn safety ring and changes a targeted block through the public game API', async ({ page }) => {
  await page.goto('/');
  await page.getByText('World ready').waitFor();

  await expect(page.getByTestId('backend')).toHaveText(/Backend: (webgpu|webgl2)/);
  await expect(page.getByTestId('average-fps')).toHaveText(/Average FPS: \d+\.\d/);
  await expect(page.getByTestId('one-percent-low')).toHaveText(/1% low: \d+\.\d FPS/);
  await expect(page.getByTestId('p99-frame-ms')).toHaveText(/p99 frame: \d+\.\d ms/);
  await expect(page.getByTestId('visible-sections')).toHaveText(/Visible sections: \d+/);
  await expect(page.getByTestId('worker-queue')).toHaveText(/Worker queue: \d+/);
  await expect(page.getByTestId('upload-bytes')).toHaveText(/Upload bytes: \d+/);

  await page.evaluate(() => window.game!.placeForTest({ x: 1, y: 1, z: 1 }, 'wood'));

  await expect(page.getByTestId('block-at-1-1-1')).toHaveText('wood');
});

test('bounds renderer pages to loaded columns and reports physical-frustum visibility', async ({ page }) => {
  await page.goto('/');
  await page.getByText('World ready').waitFor();
  await expect(page.getByTestId('worker-queue')).toHaveText('Worker queue: 0', { timeout: 30_000 });

  const initial = await page.evaluate(() => ({
    pages: Number(document.querySelector('[data-testid="render-pages"]')?.textContent?.split(': ')[1]),
    visible: Number(document.querySelector('[data-testid="visible-sections"]')?.textContent?.split(': ')[1]),
  }));
  expect(initial.pages).toBeGreaterThan(0);
  expect(initial.pages).toBeLessThanOrEqual(289);
  expect(initial.visible).toBeLessThan(initial.pages);

  await page.evaluate(() => window.game!.player.step({ x: 1, z: 0 }, 100));
  await page.waitForFunction(() => document.querySelector('[data-testid="worker-queue"]')?.textContent !== 'Worker queue: 0');
  await expect(page.getByTestId('worker-queue')).toHaveText('Worker queue: 0', { timeout: 30_000 });

  const pagesAfterTravel = await page.getByTestId('render-pages').textContent();
  expect(Number(pagesAfterTravel?.split(': ')[1])).toBeLessThanOrEqual(289);
});
