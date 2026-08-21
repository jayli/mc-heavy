import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

/** 统计蓝色水像素占比（b>r+30 且 b>g+30 排除天空 0x87ceeb 与地形） */
function waterRatio(pngBuffer) {
  const png = PNG.sync.read(pngBuffer);
  let water = 0;
  const n = png.width * png.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const r = png.data[o], g = png.data[o + 1], b = png.data[o + 2];
    if (b > r + 30 && b > g + 30 && b > 120) water++;
  }
  return water / n;
}

test('M2 验收：海面可见 + 跟随相机 + 帧率达标（§7 M2-5 口径）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=8');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });

  // 找一片海：扫描窗口内最低点（保证视野中心是水面）
  const sea = await page.evaluate(async () => {
    const { generateHeight } = await import('/src/gen/terrain.js');
    const seed = window.__MC_GAME__.seed;
    let best = null;
    for (let x = -640; x <= -480; x += 8) {
      for (let z = -600; z <= -460; z += 8) {
        const h = generateHeight(x, z, seed);
        if (h < -3 && (!best || h < best.h)) best = { x, z, h };
      }
    }
    return best;
  });
  expect(sea).not.toBeNull();

  // 传送玩家到海面上方；钉住 y=6 悬浮观察（物理会下沉，视觉测试期间固定高度）
  await page.evaluate(({ x, z }) => {
    const g = window.__MC_GAME__;
    g.player.physics.pos.x = x; g.player.physics.pos.z = z;
    g.player.physics.pos.y = 6;
    window.__PIN_Y__ = setInterval(() => { g.player.physics.pos.y = 6; }, 50);
  }, sea);
  await page.waitForTimeout(9000);
  await page.evaluate(() => clearInterval(window.__PIN_Y__));

  // 海面跟随相机（无限水面）
  const follow = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return {
      px: g.ocean.plane.position.x, pz: g.ocean.plane.position.z,
      cx: g.camera.position.x, cz: g.camera.position.z,
      y: g.ocean.plane.position.y,
    };
  });
  expect(Math.abs(follow.px - follow.cx)).toBeLessThan(2);
  expect(Math.abs(follow.pz - follow.cz)).toBeLessThan(2);
  expect(follow.y).toBe(-1.5); // SEA_Y + 0.5

  // 截图：海面蓝占比显著
  const shot = await page.screenshot();
  const ratio = waterRatio(shot);
  console.log('WATER VISUAL: ratio=' + ratio.toFixed(3));
  expect(ratio).toBeGreaterThan(0.05);

  // 帧率
  const perf = await page.evaluate(() => window.__MC_GAME__.perfSnapshot());
  console.log('WATER FPS:', perf.fps.toFixed(1));
  expect(perf.fps).toBeGreaterThan(process.env.CI ? 20 : 90);
});
