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
