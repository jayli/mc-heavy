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
  // 实测扫描线（相机高 14 俯视，墙沿 x，24.5px/block）：开阔平台 y∈[110,190]（AO=3）；
  // 墙基 z=7 行 y∈[200,226]：亮边 y≈200（远离墙，AO=3）→ 暗边 y≈226（贴墙，AO=1）。
  const bright = regionBrightness(png, 220, 110, 420, 190);
  // 渐变断言：z=7 行内取三条水平带（各 200×5px 抹平石头纹理噪声）。
  // 正确实现（顶点 AO → float varying 双线性插值）：亮度从亮边到暗边单调下降，
  // 带间存在中间亮度（连续渐变）。
  // flat 插值 bug（uint 属性 fragment 读取，three.webgpu.js:65404 对 int 强制 flat）：
  // 每三角形一个常量值 → 三条带亮度几乎相等（range≈0），渐变断言失败。
  const s1 = regionBrightness(png, 220, 201, 420, 205); // 亮边（AO≈3）
  const s2 = regionBrightness(png, 220, 211, 420, 215); // 中段（AO≈2）
  const s3 = regionBrightness(png, 220, 221, 420, 225); // 暗边（AO≈1）
  console.log('AO VISUAL:', JSON.stringify({ bright, s1, s2, s3 }));
  expect(s1 - s2).toBeGreaterThan(5); // 单调下降（容差覆盖纹理噪声）
  expect(s2 - s3).toBeGreaterThan(5);
  expect(s1 - s3).toBeGreaterThan(15); // 渐变跨度
  // 倒置回归：暗边必须明显暗于开阔地（AO1 factor 0.4 → ratio≈0.45）
  expect(s3 / bright).toBeLessThan(0.8);
});
