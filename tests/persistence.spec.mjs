import { test, expect } from 'playwright/test';

test('最小存档：放块 → 重启 → 修改保留（§7 M1 验收）', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?vd=2');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 60_000 });

  // 1. 在玩家旁放一块石头并立即 flush（坐标相对出生点，出生点由城市布局决定）
  const placed = await page.evaluate(async () => {
    const game = window.__MC_GAME__;
    const px = Math.floor(game.player.physics.pos.x) + 2;
    const pz = Math.floor(game.player.physics.pos.z) + 2;
    let groundY = -1;
    for (let y = 90; y > -32; y--) { if (game.world.getBlockId(px, y, pz) !== 0) { groundY = y; break; } }
    const stoneId = game.registry.idOf('stone');
    const r = game.world.setBlock(px, groundY + 1, pz, stoneId);
    game.scheduler.remeshSections(r.affected, { fastPath: true });
    await game.persistence.flushNow(game.world);
    return { x: px, y: groundY + 1, z: pz, stoneId };
  });

  // 2. 整页刷新（模拟重启）
  await page.reload();
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 60_000 });
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    return g.world.hasColumn(Math.floor(g.spawnX / 16), Math.floor(g.spawnZ / 16));
  }, null, { timeout: 30_000 });

  // 3. 验证修改保留
  const restored = await page.evaluate(({ x, y, z, stoneId }) => {
    return window.__MC_GAME__.world.getBlockId(x, y, z) === stoneId;
  }, placed);
  expect(restored).toBe(true);
});

test('存档隔离：未修改的 column 不写 edits', async ({ page }) => {
  await page.goto('/?vd=2');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 60_000 });
  const count = await page.evaluate(async () => {
    const game = window.__MC_GAME__;
    await game.persistence.flushNow(game.world);
    return game.persistence.countSavedColumns();
  });
  // 首次进入无修改：edits store 应为 0（Playwright 每 test 新 context，IndexedDB 隔离）
  expect(count).toBe(0);
});
