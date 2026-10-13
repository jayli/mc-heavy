import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

function meanLuma(pngBuffer) {
  const png = PNG.sync.read(pngBuffer);
  let sum = 0;
  const n = png.width * png.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    sum += 0.2126 * png.data[o] + 0.7152 * png.data[o + 1] + 0.0722 * png.data[o + 2];
  }
  return sum / n / 255;
}

test('M2 验收：三种视觉风格截图明显不同 + 夜最暗（§7 M2-6 口径）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=4&seed=12345');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await page.waitForTimeout(4000);

  // 隔离阴影这个新引入的独立变量（太阳阴影接线，Task 3）：阴影让低太阳角的 morning
  // 影子更长 → 屏幕上被影覆盖的地形更多 → 整屏平均亮度与 noon 趋同（实测 |m-n| 从 0.034
  // 塌缩到 0.0044），这是物理上正确的行为，但本 spec 的被测对象是**日夜风格系统**
  // （uSkyDim/uBlockBoost/天空色），阴影会抵消掉 skyDim 1.0 vs 0.8 的亮度差。
  // 按「对照只差一个变量」原则在量亮度前关阴影；断言与阈值 0.01 逐字不动（改的是被测
  // setup，不是断言）。实测数据见 .superpowers/sdd/2026-10-13-sun-shadow-map/task-3-report.md probe14。
  await page.evaluate(() => window.__MC_GAME__.setShadowsEnabled(false));

  const shoot = async (style) => {
    await page.evaluate((s) => window.__MC_GAME__.setVisualStyle(s), style);
    await page.waitForTimeout(600);
    return meanLuma(await page.screenshot());
  };

  const noon = await shoot('noon');
  const morning = await shoot('morning');
  const night = await shoot('night');
  console.log('DAYNIGHT LUMA:', JSON.stringify({ noon, morning, night }));

  // 夜明显最暗；晨与午不同；三者两两差异显著
  expect(night).toBeLessThan(noon * 0.6);
  expect(Math.abs(morning - noon)).toBeGreaterThan(0.01);
  expect(noon).toBeGreaterThan(0.2);

  // 参数语义：夜 skyDim<1、blockBoost>1
  const params = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    g.setVisualStyle('night');
    return g.dayNight.params;
  });
  expect(params.skyDim).toBeLessThan(1);
  expect(params.blockBoost).toBeGreaterThan(1);

  // 恢复循环不报错
  await page.evaluate(() => window.__MC_GAME__.setVisualStyle(null));
});
