import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

/** 矩形区域平均亮度（0-255，RGB 均值） */
function regionBrightness(png, x0, y0, x1, y1) {
  let sum = 0, n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const o = (y * png.width + x) * 4;
      sum += (png.data[o] + png.data[o + 1] + png.data[o + 2]) / 3;
      n++;
    }
  }
  return sum / n;
}

test('AO 视觉：墙角顶点比开阔地暗（mc-lite AONodeSystem 曲线口径）', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 480 });
  await page.goto('/src/tests/test-ao.html');
  await page.waitForFunction(() => window.__AO_READY__ === true || window.__AO_ERROR__, null, { timeout: 60_000 });
  const err = await page.evaluate(() => window.__AO_ERROR__);
  expect(err).toBeUndefined();

  const shot = await page.screenshot();
  const png = PNG.sync.read(shot);
  // 实测扫描线（相机高 14 俯视，墙沿 x）：开阔平台 y∈[110,190] 亮度 ~62（AO=3）；
  // 墙基 AO 暗带 y∈[202,224] 亮度 ~26（AO=1，factor 0.4）。取大块区域粗采样，
  // 不依赖手算投影（墙高透视位移会让逐像素公式失真）。
  const bright = regionBrightness(png, 220, 110, 420, 190);
  const dark = regionBrightness(png, 220, 202, 420, 224);
  console.log('AO VISUAL:', JSON.stringify({ bright, dark, ratio: dark / bright }));
  // 修复后：dark≈0.4×bright（AO1 暗带 vs AO3 开阔地）→ ratio≈0.4，远 <0.8。
  // 修复前（映射倒置）：开阔地被压暗、暗带反而亮 → ratio>1，测试失败。
  expect(dark / bright).toBeLessThan(0.8);
});
