import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

/**
 * Tier 4：天空盒（v1.58）—— 像素级验收。
 *
 * 判据：
 *   ① 正午天空是**贴图**而非纯色：采样区方差显著（纯色天空方差 ≈ 0）；
 *   ② 夜间天空显著更暗（星空贴图 + 深色基调）；
 *   ③ `uNightBlend` 与 `skyDim` 同向单调（混合因子由既有数据派生，不是独立权威）；
 *   ④ 月轮仅夜间可见（风格数据的 moonVisible 驱动）。
 *
 * ⚠️ 采样区必须在**屏幕上半且只看天空**：相机抬到玩家上方 400 格朝天看，地形/建筑/云簇
 * 全部落在视野外。照 `sun-shadow.spec` 的教训，HUD 必须全部隐藏（perf HUD 的半透明黑底
 * 会压暗左上象限，让「暗区」跟着屏幕走而非世界走）。
 */

/** 天空区（屏幕中央偏上）像素亮度均值与方差 —— 纯色天空方差≈0，贴图天空方差大 */
function skyStats(png) {
  const x0 = Math.round(png.width * 0.35), x1 = Math.round(png.width * 0.65);
  const y0 = Math.round(png.height * 0.15), y1 = Math.round(png.height * 0.45);
  const vals = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * png.width + x) * 4;
      vals.push((png.data[o] + png.data[o + 1] + png.data[o + 2]) / 3);
    }
  }
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
  return { mean, variance };
}

/** 固定机位：抬到高空朝天看，视野内只有天空 */
async function lookUpAtSky(page) {
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    g.pushModal('tier4-sky'); // 冻结玩家物理（否则相机会被物理拉回地面）
    const px = g.player.physics.pos.x, py = g.player.physics.pos.y, pz = g.player.physics.pos.z;
    g.camera.up.set(0, 1, 0);
    g.camera.position.set(px, py + 400, pz);
    g.camera.lookAt(px + 100, py + 460, pz + 60);
    g.camera.updateMatrixWorld();
    for (const el of document.querySelectorAll('#hud-root > *, #crosshair, #settings-btn')) {
      el.style.display = 'none';
    }
  });
  await page.waitForTimeout(900);
}

test('天空盒：贴图真的在渲染（非纯色）+ 日夜混合生效 + 月轮仅夜间可见', async ({ page }) => {
  test.setTimeout(180_000);
  // 不传 &style：走日夜循环，才能用 setTime 驱动插值（override 模式下 setTime early-return）
  await page.goto('/?vd=2&seed=12345');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await lookUpAtSky(page);

  // ---- 正午 ----
  await page.evaluate(() => window.__MC_GAME__.dayNight.setTime(12));
  await page.waitForTimeout(1000);
  const noon = skyStats(PNG.sync.read(await page.screenshot()));
  const noonState = await page.evaluate(() => ({
    blend: window.__MC_GAME__.sky.uNightBlend.value,
    skyDim: window.__MC_GAME__.dayNight.params.skyDim,
    moon: window.__MC_GAME__.sky.moonSprite.visible,
    sun: window.__MC_GAME__.sky.sunSprite.visible,
  }));

  // ---- 深夜 ----
  await page.evaluate(() => window.__MC_GAME__.dayNight.setTime(0));
  await page.waitForTimeout(1200);
  const night = skyStats(PNG.sync.read(await page.screenshot()));
  const nightState = await page.evaluate(() => ({
    blend: window.__MC_GAME__.sky.uNightBlend.value,
    skyDim: window.__MC_GAME__.dayNight.params.skyDim,
    moon: window.__MC_GAME__.sky.moonSprite.visible,
    moonPos: window.__MC_GAME__.sky.moonSprite.position.toArray().map((v) => +v.toFixed(1)),
  }));

  // ---- 黄昏（插值中间态，证明是连续过渡而不是二态硬切）----
  await page.evaluate(() => window.__MC_GAME__.dayNight.setTime(19));
  await page.waitForTimeout(1000);
  const duskState = await page.evaluate(() => ({
    blend: window.__MC_GAME__.sky.uNightBlend.value,
    skyDim: window.__MC_GAME__.dayNight.params.skyDim,
  }));

  console.log('SKYBOX:', JSON.stringify({
    noon: { mean: +noon.mean.toFixed(1), variance: +noon.variance.toFixed(1), ...noonState },
    night: { mean: +night.mean.toFixed(1), variance: +night.variance.toFixed(1), ...nightState },
    dusk: duskState,
  }));

  // sanity floor：两个读数都须真读到天空（不是黑屏/白屏）
  expect(noon.mean, `正午天空须正常照亮：${noon.mean.toFixed(1)}`).toBeGreaterThan(60);
  expect(noon.mean, `正午天空须非纯白过曝：${noon.mean.toFixed(1)}`).toBeLessThan(250);

  // ① 贴图天空：方差显著（纯色天空方差实测 ≈ 0）
  expect(noon.variance,
    `正午天空须是贴图而非纯色（纯色方差≈0）：variance=${noon.variance.toFixed(2)}`)
    .toBeGreaterThan(4);
  // 夜间星空也有纹理（星星）—— 防「夜间贴图没加载、只是深色纯色」这个失败形态
  expect(night.variance,
    `夜间天空也须是贴图（星星/星云）：variance=${night.variance.toFixed(2)}`)
    .toBeGreaterThan(1.5);

  // ② 夜间显著更暗
  expect(night.mean,
    `夜间天空须显著暗于正午：noon=${noon.mean.toFixed(1)} night=${night.mean.toFixed(1)}`)
    .toBeLessThan(noon.mean * 0.5);

  // ③ 混合因子与 skyDim 同向：正午 0 / 夜 1 / 黄昏居中（连续过渡）
  expect(noonState.blend, '正午 uNightBlend 须 = 0').toBe(0);
  expect(nightState.blend, '深夜 uNightBlend 须 = 1').toBeGreaterThan(0.999);
  expect(duskState.blend, '黄昏 uNightBlend 须居中（连续过渡，非二态硬切）')
    .toBeGreaterThan(0.05);
  expect(duskState.blend, '黄昏 uNightBlend 须居中（连续过渡，非二态硬切）')
    .toBeLessThan(0.95);
  // 混合因子必须与 skyDim 反向单调（派生关系：skyDim 越低 → 星空越多）
  expect(duskState.skyDim, '黄昏 skyDim 须介于夜与午之间')
    .toBeGreaterThan(nightState.skyDim);
  expect(duskState.skyDim, '黄昏 skyDim 须介于夜与午之间')
    .toBeLessThan(noonState.skyDim);

  // ④ 月轮仅夜间可见（风格数据驱动），且被摆到相机远裁面内
  expect(nightState.moon, '夜间月轮须可见').toBe(true);
  expect(noonState.moon, '正午月轮须隐藏').toBe(false);
  // 太阳：三套风格原值全 false（skyBox4 贴图自带太阳光晕，再画一个会变两个太阳）
  expect(noonState.sun, '日轮默认不显示（mc-lite 原值，贴图已含光晕）').toBe(false);

  await page.evaluate(() => window.__MC_GAME__.popModal('tier4-sky'));
});

test('天空盒关闭（?skybox=0）：退回纯色天空，观测口径与 v1.57 一致', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?vd=2&seed=12345&skybox=0');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await lookUpAtSky(page);

  const state = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return {
      hasSky: g.sky !== null,
      bgNode: g.scene.backgroundNode,
      isColor: g.scene.background?.isColor === true,
    };
  });
  const stats = skyStats(PNG.sync.read(await page.screenshot()));
  console.log('SKYBOX OFF:', JSON.stringify({ ...state, mean: +stats.mean.toFixed(1), variance: +stats.variance.toFixed(2) }));

  expect(state.hasSky, '?skybox=0 时不得装配天空盒').toBe(false);
  expect(state.bgNode === null || state.bgNode === undefined, '不得设置 backgroundNode').toBe(true);
  expect(state.isColor, '须退回纯色背景（scene.background 为 Color）').toBe(true);
  // 纯色天空的方差必须接近 0 —— 这条反过来证明 ① 的方差判据真的在测贴图
  expect(stats.variance, `纯色天空方差须 ≈0（实测 ${stats.variance.toFixed(2)}）`).toBeLessThan(1);
  expect(stats.mean, `纯色天空须正常照亮（实测 ${stats.mean.toFixed(1)}）`).toBeGreaterThan(60);

  await page.evaluate(() => window.__MC_GAME__.popModal('tier4-sky'));
});
