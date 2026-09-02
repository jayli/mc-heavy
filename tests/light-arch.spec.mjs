import { test, expect } from 'playwright/test';

// 回归：玩家编辑（放块搭石拱）后，横梁下方空气 skylight 必须经异步区域扩散
// 收敛到 >0（非纯黑）。此前 remeshSections 漏调 enqueueLight → 编辑后光永不
// 重算 → 上凹角/悬挑投影下全黑（实玩 bug）。
test('石拱横梁下方光照经编辑后异步收敛（非全黑）', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?vd=2&seed=12345');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 60_000 });
  await page.waitForFunction(() => window.__MC_GAME__.world.columns.size >= 20, null, { timeout: 30_000 });

  const result = await page.evaluate(async () => {
    const game = window.__MC_GAME__;
    const { world, registry, scheduler, player } = game;
    const stoneId = registry.idOf('stone');
    const px = Math.floor(player.physics.pos.x);
    const pz = Math.floor(player.physics.pos.z);
    let groundY = -1;
    for (let y = 60; y > -32; y--) { if (world.getBlockId(px + 3, y, pz) !== 0) { groundY = y; break; } }
    const baseY = groundY + 1;
    // 搭石拱：两柱 + 横梁（玩家 placeBlock 等价路径：setBlock + remeshSections）
    for (let dy = 0; dy < 2; dy++) {
      for (const dx of [0, 4]) {
        const r = world.setBlock(px + 3 + dx, baseY + dy, pz, stoneId);
        if (r) scheduler.remeshSections(r.affected, { fastPath: true });
      }
    }
    for (let dx = 0; dx <= 4; dx++) {
      const r = world.setBlock(px + 3 + dx, baseY + 2, pz, stoneId);
      if (r) scheduler.remeshSections(r.affected, { fastPath: true });
    }
    // 等异步 light 收敛（下发 + Worker 区域重算 + 回写 + 重 mesh）
    const bx = px + 5, bz = pz;
    const cx = Math.floor(bx / 16), cz = Math.floor(bz / 16);
    const { blockIndex } = await import('/src/voxel/constants.js');
    let skyUnder = 0;
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const col = world.getColumn(cx, cz);
      if (!col) continue;
      skyUnder = col.light[blockIndex(bx - cx * 16, baseY + 1, bz - cz * 16)] >> 4;
      if (skyUnder > 0 && scheduler.stats().lightInflight === 0) break;
    }
    return { skyUnder };
  });

  // 横梁下方空气：垂直模型为 0（全黑），区域扩散后应 >0（光从拱门两侧渗入）
  expect(result.skyUnder).toBeGreaterThan(0);
});
