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

test('spawns on the surface and jumps with space', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('import-new').click();
  await page.getByText('World ready').waitFor();

  const baseline = await page.evaluate(() => window.game!.player.position.y);
  expect(baseline).toBeGreaterThan(15);
  expect(baseline).toBeLessThan(40);

  await page.keyboard.press('Space');
  await page.waitForFunction((startY) => window.game!.player.position.y > startY + 0.2, baseline);
});

test('opens a chest on the first click and breaks it on the second', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('import-new').click();
  await page.getByText('World ready').waitFor();

  const result = await page.evaluate(() => {
    window.game!.setBlockForTest({ x: 0, y: 24, z: -1 }, 'chest');
    window.game!.player.setPosition({ x: 0.5, y: 25.5, z: 0.5 });
    window.game!.player.setLook(0, -1.05);
    const opened = window.game!.breakForTest();
    const lids = window.game!.activeChestLids();
    const broken = window.game!.breakForTest();
    return {
      opened,
      lids,
      broken,
      block: window.game!.readBlockForTest({ x: 0, y: 24, z: -1 }),
    };
  });

  expect(result).toEqual({ opened: true, lids: 1, broken: true, block: 'air' });
});

test('chains TNT and spawns explosion particles', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('import-new').click();
  await page.getByText('World ready').waitFor();

  await page.evaluate(() => {
    window.game!.setBlockForTest({ x: 0, y: 24, z: -1 }, 'tnt');
    window.game!.setBlockForTest({ x: 0, y: 24, z: -3 }, 'tnt');
  });

  const ignited = await page.evaluate(() => window.game!.igniteTntForTest({ x: 0, y: 24, z: -1 }));
  expect(ignited).toBe(true);
  expect(await page.evaluate(() => window.game!.activeParticles())).toBeGreaterThan(0);

  await page.waitForFunction(() => window.game!.readBlockForTest({ x: 0, y: 24, z: -3 }) === 'air', undefined, { timeout: 5_000 });
  expect(await page.evaluate(() => window.game!.readBlockForTest({ x: 0, y: 24, z: -1 }))).toBe('air');
});

test('switches quality tier and toggles rain from the settings panel', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('import-new').click();
  await page.getByText('World ready').waitFor();

  await page.getByTestId('settings-button').click();
  await page.getByTestId('quality-low').click();
  expect(await page.evaluate(() => window.game!.qualityForTest())).toBe('low');

  await page.getByTestId('rain-toggle').click();
  expect(await page.evaluate(() => window.game!.rainEnabled())).toBe(true);
  await page.getByTestId('rain-toggle').click();
  expect(await page.evaluate(() => window.game!.rainEnabled())).toBe(false);

  await page.getByTestId('settings-close').click();
});
