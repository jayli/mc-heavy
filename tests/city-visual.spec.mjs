import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

/** 统计截图中非天空蓝像素占比；天空蓝 0x87ceeb=(135,206,235)，容差 30 */
function nonSkyRatio(pngBuffer) {
  const png = PNG.sync.read(pngBuffer);
  let nonSky = 0;
  const n = png.width * png.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const r = png.data[o], g = png.data[o + 1], b = png.data[o + 2];
    if (Math.abs(r - 135) > 30 || Math.abs(g - 206) > 30 || Math.abs(b - 235) > 30) nonSky++;
  }
  return nonSky / n;
}

test('M2 验收：出生在城市中心，可见城市天际线（§7 M2 口径）', async ({ page }) => {
  test.setTimeout(180_000);
  // ⚠️ `skybox=0`（v1.58）：本 spec 用「像素落在 0x87ceeb ±30 内 = 天空」来数非天空占比。
  // 天空盒上线后天空是照片 → 天空像素被误判成地形，下界断言近乎恒真（判据失效）。
  // 按 testing-policy 的「只改被测 setup、断言与阈值逐字不动」口径 pin 纯色天空。
  // RedCity 起默认出生在 RedCity；本用例语义绑定 City 环境，pin spawn=city（RedCity spec §14.8）
  await page.goto('/?vd=8&seed=12345&skybox=0&spawn=city');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  // 视距内 column 大部分就绪（城市建筑随 GEN 落地）
  await page.waitForFunction(() => window.__MC_GAME__.world.columns.size >= 200, null, { timeout: 60_000 });

  // 1. 出生点 = 城市中心（mc-lite getCitySpawnPoint 语义）
  const spawnInfo = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return { spawnX: g.spawnX, spawnZ: g.spawnZ, spawnY: g.spawnY };
  });
  expect(spawnInfo.spawnX).toBeGreaterThan(100); // 城市中心被 clamp 在 [117,283]
  expect(spawnInfo.spawnZ).toBeGreaterThan(100);

  // 2. 数据级：城堡存在 + 出生点附近 column 有高出地表的建筑方块
  const cityCheck = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const layout = g.scheduler.structureIndex._layouts.get('0,0');
    const city = layout && layout.city;
    if (!city) return { ok: false, reason: 'no city layout' };
    const castle = city.placements.find((p) => p.type === 'castle');
    let tallBlocks = 0;
    const pcx = Math.floor(g.player.physics.pos.x / 16), pcz = Math.floor(g.player.physics.pos.z / 16);
    for (const [, col] of g.world.columns) {
      if (Math.max(Math.abs(col.cx - pcx), Math.abs(col.cz - pcz)) > 4) continue;
      for (let lx = 0; lx < 16; lx += 4) for (let lz = 0; lz < 16; lz += 4) {
        for (let y = 20; y < 60; y += 3) {
          if (col.get(lx, y, lz) !== 0) { tallBlocks++; break; }
        }
      }
    }
    return { ok: true, castle: !!castle, castleAt: castle && [castle.x, castle.z], tallBlocks, baseHeight: city.baseHeight };
  });
  expect(cityCheck.ok).toBe(true);
  expect(cityCheck.castle).toBe(true);
  expect(cityCheck.castleAt).toEqual([spawnInfo.spawnX, spawnInfo.spawnZ]);
  expect(cityCheck.tallBlocks).toBeGreaterThan(20); // 天际线：出生点周围有高层建筑方块

  // 3. 帧率与视觉采样：等启动填充/上传 burst 结束（vsync 口径同 M1）
  await new Promise((r) => setTimeout(r, 8000));
  const perf = await page.evaluate(() => window.__MC_GAME__.perfSnapshot());
  console.log('CITY FPS:', JSON.stringify({ fps: perf.fps, p95: perf.frameMs.p95 }));
  expect(perf.fps).toBeGreaterThan(process.env.CI ? 20 : 90);

  // 4. 视觉级：截图非天空像素占比显著（建筑群占据视野）
  const shot = await page.screenshot();
  const ratio = nonSkyRatio(shot);
  console.log('CITY VISUAL: nonSkyRatio=' + ratio.toFixed(3));
  expect(ratio).toBeGreaterThan(0.15);
});
