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

test('binds mouse look and hotbar break and place input to the real world', async ({ page }) => {
  await page.goto('/');
  await page.getByText('World ready').waitFor();

  // Default seed 0x5eed1234: the first solid block below the y=50 spawn camera is
  // the coast surface at y=23 (sand), computed once with the pure generator.
  expect(await page.evaluate(() => window.game!.readBlockForTest({ x: 0, y: 23, z: 0 }))).toBe('sand');
  await expect(page.getByTestId('hotbar-slot-1')).toHaveAttribute('data-selected', 'true');

  await page.locator('canvas').click();

  await page.dispatchEvent('canvas', 'mousemove', { movementX: 100, movementY: -100 });
  const look = await page.evaluate(() => ({
    yaw: window.game!.player.yaw,
    pitch: window.game!.player.pitch,
  }));
  expect(look.yaw).toBeCloseTo(0.2, 5);
  expect(look.pitch).toBeCloseTo(0.2, 5);

  await page.evaluate(() => window.game!.player.setLook(0, -Math.PI / 2));
  await page.dispatchEvent('canvas', 'mousedown', { button: 0 });
  expect(await page.evaluate(() => window.game!.readBlockForTest({ x: 0, y: 23, z: 0 }))).toBe('air');

  await page.dispatchEvent('canvas', 'mousedown', { button: 2 });
  expect(await page.evaluate(() => window.game!.readBlockForTest({ x: 0, y: 23, z: 0 }))).toBe('stone');

  await page.keyboard.press('Digit2');
  await expect(page.getByTestId('hotbar-slot-2')).toHaveAttribute('data-selected', 'true');
  // Placement targets the face entered by the ray, so a second straight-down
  // place would target the water cell above the just-placed stone. Break the
  // stone again so grass lands in the same literal cell.
  await page.dispatchEvent('canvas', 'mousedown', { button: 0 });
  await page.dispatchEvent('canvas', 'mousedown', { button: 2 });
  expect(await page.evaluate(() => window.game!.readBlockForTest({ x: 0, y: 23, z: 0 }))).toBe('grass');
});

test('bounds renderer pages to loaded columns and reports physical-frustum visibility', async ({ page }) => {
  await page.goto('/');
  await page.getByText('World ready').waitFor();
  await expect(page.getByTestId('worker-queue')).toHaveText('Worker queue: 0', { timeout: 30_000 });
  await page.waitForFunction(() => {
    const text = document.querySelector('[data-testid="render-pages"]')?.textContent ?? '';
    return Number(text.split(': ')[1]) >= 27;
  });

  const initial = await page.evaluate(() => ({
    pages: Number(document.querySelector('[data-testid="render-pages"]')?.textContent?.split(': ')[1]),
    visible: Number(document.querySelector('[data-testid="visible-sections"]')?.textContent?.split(': ')[1]),
  }));
  expect(initial.pages).toBeGreaterThanOrEqual(27);
  expect(initial.pages).toBeLessThanOrEqual(867);
  expect(initial.visible).toBeLessThan(initial.pages);

  await page.evaluate(() => window.game!.player.step({ x: 1, z: 0 }, 100));
  await page.waitForFunction(() => document.querySelector('[data-testid="worker-queue"]')?.textContent !== 'Worker queue: 0');
  await expect(page.getByTestId('worker-queue')).toHaveText('Worker queue: 0', { timeout: 30_000 });

  const pagesAfterTravel = await page.getByTestId('render-pages').textContent();
  expect(Number(pagesAfterTravel?.split(': ')[1])).toBeLessThanOrEqual(867);
});
