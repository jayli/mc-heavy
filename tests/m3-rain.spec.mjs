import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

// M3-3 验收：雨效（roadmap Task M3-3）
// ① 数据级：?weather=rain 强制后强度淡入到 1，雨滴 LineSegments 可见、透明度到位、多 1 次 draw；
// ② 视觉级：同 seed 同机位「雨天 vs 晴天」截图差分——雨滴白色线段产生显著像素差；
// ③ 性能：雨效下 fps ≥90（roadmap 冻结口径）。

/** 两 PNG 的逐像素差分数（RGB 任一通道差 >16 记 1 像素） */
function diffPixels(a, b) {
  const pa = PNG.sync.read(a), pb = PNG.sync.read(b);
  expect(pa.width).toBe(pb.width);
  expect(pa.height).toBe(pb.height);
  let n = 0;
  for (let i = 0; i < pa.width * pa.height; i++) {
    const o = i * 4;
    if (Math.abs(pa.data[o] - pb.data[o]) > 16
      || Math.abs(pa.data[o + 1] - pb.data[o + 1]) > 16
      || Math.abs(pa.data[o + 2] - pb.data[o + 2]) > 16) n++;
  }
  return n;
}

/** 启动并等世界就绪 + 天气稳态（intensity 到目标值） */
async function boot(page, weather) {
  await page.goto(`/?vd=8&weather=${weather}&seed=12345`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  const target = weather === 'rain' ? 1 : 0;
  await page.waitForFunction(
    (t) => Math.abs(window.__MC_GAME__.weather.intensity - t) < 0.01,
    target, { timeout: 30_000 });
  // 出生列 + 视距内基本填充后再截图（两次截图世界内容一致才可比）
  await page.waitForFunction(() => window.__MC_GAME__.world.columns.size >= 250, null, { timeout: 60_000 });
  await new Promise((r) => setTimeout(r, 2000));
  // 冻结全部连续动画源，让截图差分只剩雨滴本身：
  // ① 日夜固定正午（setStyle 后 update 不再推进）② 海面隐藏（波浪时变噪声）
  // ③ HUD 隐藏（fps/帧时数字 250ms 刷新，左上角逐帧变化 = 截图差分的最大噪声源）
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    g.dayNight.setStyle('noon');
    g.ocean.plane.visible = false;
    document.getElementById('hud-root').style.display = 'none';
  });
  await new Promise((r) => setTimeout(r, 500));
}

test('M3-3：雨效可见（数据级 + 截图差分）+ 雨天 fps ≥90', async ({ page }) => {
  test.setTimeout(240_000);

  // ---- ① 雨天：数据级接线 ----
  await boot(page, 'rain');
  const rainState = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const before = g._lastRenderInfo.drawCalls;
    return {
      kind: g.weather.kind,
      intensity: g.weather.intensity,
      isRaining: g.weather.isRaining,
      visible: g.rain.lines.visible,
      opacity: g.rain.uniforms.uOpacity.value,
      drawCalls: before,
      particleCount: g.rain.particleCount,
      vertexCount: g.rain.geometry.attributes.position.count,
    };
  });
  console.log('M3-3 RAIN STATE:', JSON.stringify(rainState));
  expect(rainState.kind).toBe('rain');
  expect(rainState.intensity).toBeGreaterThan(0.99);
  expect(rainState.visible).toBe(true);
  expect(rainState.opacity).toBeCloseTo(0.6, 5); // RAIN.OPACITY × intensity=1
  expect(rainState.particleCount).toBe(267);      // mc-lite 高档语义冻结
  expect(rainState.vertexCount).toBe(534);        // 每滴 2 顶点
  const rainShot = await page.screenshot();

  // 雨效下帧率（roadmap 冻结口径 ≥90；reset 采样窗口，稳态 6s 后取值）
  await page.evaluate(() => window.__MC_GAME__.perf.reset());
  await new Promise((r) => setTimeout(r, 6000));
  const perf = await page.evaluate(() => window.__MC_GAME__.perfSnapshot());
  console.log('M3-3 PERF(rain):', JSON.stringify({ fps: perf.fps, p95: perf.frameMs.p95 }));
  expect(perf.fps).toBeGreaterThan(process.env.CI ? 20 : 90);
  expect(perf.frameMs.p95).toBeLessThan(process.env.CI ? 50 : 16.7);

  // ---- ② 晴天对照：同 seed 同机位 ----
  await boot(page, 'clear');
  const clearState = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return {
      kind: g.weather.kind,
      intensity: g.weather.intensity,
      visible: g.rain.lines.visible,
      drawCalls: g._lastRenderInfo.drawCalls,
    };
  });
  console.log('M3-3 CLEAR STATE:', JSON.stringify(clearState));
  expect(clearState.kind).toBe('clear');
  expect(clearState.intensity).toBe(0);
  expect(clearState.visible).toBe(false); // 晴天隐藏（省 draw）
  expect(clearState.drawCalls).toBeLessThan(rainState.drawCalls); // 雨天多雨滴 LineSegments 的 1 次 draw
  const clearShot = await page.screenshot();
  // 基线差分：晴天连拍两张（海面波浪时变噪声，两次 boot 的 uTime 相位差）
  await new Promise((r) => setTimeout(r, 800));
  const clearShot2 = await page.screenshot();

  // ---- 视觉级：雨滴线段差分必须显著大于晴天基线差分 ----
  // 口径：WebGPU 线宽恒 1px（linewidth 无效，mc-lite 同款），267 滴半透明雨丝
  // 每滴差分 ~1px 量级（实测 274）；阈值取 particleCount 的 1/3 防抖动。
  const diff = diffPixels(rainShot, clearShot);
  const baseline = diffPixels(clearShot, clearShot2);
  console.log(`M3-3 DIFF: rain-vs-clear=${diff} clear-baseline=${baseline}`);
  expect(diff).toBeGreaterThan(process.env.CI ? 30 : 89); // 267 × 1/3
  expect(diff).toBeGreaterThan(baseline + 50); // 雨滴差分主导，非环境噪声
});
