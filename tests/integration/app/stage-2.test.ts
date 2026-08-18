import { expect, test } from '@playwright/test';

test('imports a JSON legacy snapshot and reports preserved entries', async ({ page }) => {
  await page.goto('/');
  const legacy = {
    player: { x: 1, y: 30, z: 2, pitch: 0, yaw: 0 },
    seed: 5,
    worldDeltas: [{
      key: '0,0',
      blocks: {
        '1,2,3': { type: 'wood', orientation: 2 },
        '4,5,6': { type: 'future_block', orientation: 0 },
      },
      entities: {},
    }],
  };

  await page.getByTestId('import-file-input').setInputFiles({
    name: 'legacy.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(legacy)),
  });
  await page.getByText('World ready').waitFor();

  expect(await page.evaluate(() => window.game!.readBlockForTest({ x: 1, y: 2, z: 3 }))).toBe('wood');
  await expect(page.getByTestId('import-report')).toContainText('封存 1');
});
