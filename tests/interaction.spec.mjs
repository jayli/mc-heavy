import { test, expect } from 'playwright/test';

test('放块挖块当帧生效（§7 M1 验收）', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?vd=2');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 60_000 });

  // 通过编程接口模拟放块/挖块（pointer lock 在无头环境不可用，直接调方法）
  const result = await page.evaluate(async () => {
    const game = window.__MC_GAME__;
    const { player, world, registry } = { player: game.player, world: game.world, registry: game.registry };
    // 在玩家面前地面放一块石头
    const px = Math.floor(player.physics.pos.x), pz = Math.floor(player.physics.pos.z);
    let groundY = -1;
    for (let y = 60; y > -32; y--) { if (world.getBlockId(px + 2, y, pz) !== 0) { groundY = y; break; } }
    const stoneId = registry.idOf('stone');
    const before = world.getBlockId(px + 2, groundY + 1, pz);
    const r = world.setBlock(px + 2, groundY + 1, pz, stoneId);
    game.scheduler.remeshSections(r.affected, { fastPath: true });
    const after = world.getBlockId(px + 2, groundY + 1, pz);
    // edits 记录了修改
    const col = world.getColumn(Math.floor((px + 2) / 16), Math.floor(pz / 16));
    const editRecorded = col.edits.size > 0;
    // 挖掉
    world.setBlock(px + 2, groundY + 1, pz, 0);
    const dug = world.getBlockId(px + 2, groundY + 1, pz);
    return { before, after, dug, stoneId, editRecorded };
  });
  expect(result.before).toBe(0);
  expect(result.after).toBe(result.stoneId);
  expect(result.dug).toBe(0);
  expect(result.editRecorded).toBe(true);

  // 帧时仍达标（编辑后不卡）——与 render-terrain 同口径：
  // 120Hz vsync 锁帧下 frameMs.p95 被量化为 ~8.3ms+抖动，直接强制 fps（120fps 预算真实语义），
  // 帧时作防跌破 60fps 二级门。
  // 先等 mesh 管线排空（worldReady 后仍有 ~百个 section 在途，采样会混入加载期帧时），
  // 再等足够久让 600 帧采样窗口全部为稳态帧（120fps 下 600 帧 = 5s）。
  await page.waitForFunction(() => {
    const s = window.__MC_GAME__.scheduler.stats();
    return s.meshInflight === 0 && s.uploadQueue === 0;
  }, null, { timeout: 30_000 });
  await new Promise((r) => setTimeout(r, 5000));
  const perf = await page.evaluate(() => window.__MC_GAME__.perfSnapshot());
  expect(perf.fps).toBeGreaterThan(process.env.CI ? 25 : 115);
  expect(perf.frameMs.p95).toBeLessThan(process.env.CI ? 33 : 16.7);
});
