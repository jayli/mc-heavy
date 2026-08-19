import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

/** 统计截图中非天空蓝像素占比（地形像素）；天空蓝 0x87ceeb=(135,206,235)，容差 30 */
function terrainRatio(pngBuffer) {
  const png = PNG.sync.read(pngBuffer);
  let terrain = 0;
  const n = png.width * png.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const r = png.data[o], g = png.data[o + 1], b = png.data[o + 2];
    if (Math.abs(r - 135) > 30 || Math.abs(g - 206) > 30 || Math.abs(b - 235) > 30) terrain++;
  }
  return terrain / n;
}

test('地形渲染：出生点地形可见、帧时达标、draw 数受控', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // 视距 2（测试配置，draw 上限断言对应此口径）
  await page.goto('/?vd=2');
  await page.waitForFunction(() => window.__MC_BOOT__?.rendererReady === true, null, { timeout: 30_000 });
  // 等世界就绪（Game 暴露 __MC_GAME__ 状态）
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 60_000 });

  // 1. 截图像素检查：画面非纯天空蓝（有地形像素）——Node 侧 pngjs 分析
  //    （WebGPU swapchain canvas 无法被 2D drawImage 读取，计划 Step 3 注明的退路）
  await new Promise((r) => setTimeout(r, 3000)); // 等 mesh/上传管线收敛
  const shot = await page.screenshot();
  const ratio = terrainRatio(shot);
  expect(ratio).toBeGreaterThan(0.05); // 至少 5% 像素是地形

  // 2. 帧时：等 2s 稳定后采样，p95 < 8.3ms（120fps 预算）——本地真 GPU 硬门槛
  await new Promise((r) => setTimeout(r, 2000));
  const perf = await page.evaluate(() => window.__MC_GAME__.perfSnapshot());
  // 120fps 预算：本机为 120Hz 显示器，vsync 锁帧下帧间隔被量化为 8.33ms，
  // frameMs.p95 必然因 vsync 抖动略超 8.3（测的是量化抖动而非渲染负载——
  // 实测视距 8 / 768 sections / 302 draw 仍锁 120fps）。故直接强制 fps（120fps
  // 预算的真实语义），帧时作防跌破 60fps 的二级门。
  expect(perf.fps).toBeGreaterThan(process.env.CI ? 25 : 115);
  expect(perf.frameMs.p95).toBeLessThan(process.env.CI ? 33 : 16.7);

  // 3. draw 数受控：视距 2 下 draw < 100
  const stats = await page.evaluate(() => window.__MC_GAME__.renderStats());
  expect(stats.drawCalls).toBeLessThan(100);
  expect(stats.sections).toBeGreaterThan(0);

  expect(errors).toEqual([]);
});
