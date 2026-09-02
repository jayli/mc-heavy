import { test, expect } from 'playwright/test';

// 回归：初始化城市房屋（含 glowstone/窗户）内光照必须收敛——glowstone 邻域空气
// 不得全黑。此前 light 任务写回全部 5 列 last-write-wins，region 不完整的后到 task
// 清零覆盖邻列已收敛的好光 → 房屋内偶现大片全黑面 + 黑核周围截断渐变环（实玩 bug）。
test('房屋内 glowstone 邻域光照收敛（非全黑）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?seed=12345');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 60_000 });
  await page.waitForFunction(() => {
    const s = window.__MC_GAME__.scheduler;
    return s._lightQueue.size === 0 && s.stats().lightInflight === 0;
  }, null, { timeout: 120_000, polling: 500 });

  const result = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const { world, registry } = g;
    const MIN_Y = -32;
    const idx = (lx, y, lz) => lx + lz * 16 + (y - MIN_Y) * 256;
    const glowId = registry.idOf('glowstone');
    const bad = [];
    let glows = 0;
    for (const [key, col] of world.columns) {
      for (let i = 0; i < col.blocks.length; i++) {
        if (col.blocks[i] !== glowId) continue;
        glows++;
        const gx = i & 15, gz = (i >> 4) & 15, gy = (i >> 8) + MIN_Y;
        for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (let dy = 0; dy <= 2; dy++) {
          const lx = gx + dx, lz = gz + dz;
          if (lx < 0 || lx > 15 || lz < 0 || lz > 15) continue;
          const li = idx(lx, gy + dy, lz);
          if (col.blocks[li] !== 0) continue;
          const sky = col.light[li] >> 4, bl = col.light[li] & 15;
          if (Math.max(sky, bl) === 0) bad.push({ key, at: [lx, gy + dy, lz] });
        }
      }
    }
    return { glows, badCount: bad.length, badSample: bad.slice(0, 5) };
  });
  expect(result.glows).toBeGreaterThan(0);
  expect(result.badSample).toEqual([]);
  expect(result.badCount).toBe(0);
});
