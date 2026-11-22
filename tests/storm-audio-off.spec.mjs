import { test, expect } from 'playwright/test';

// v3.30e 回归门（用户 2026-11-22 实玩报告的两个缺陷）：
//
// ① 「关掉雨天光影的时候，声音也应当关闭，现在是关掉后声音还留着」
//    根因：开启时 weather.force('rain') 把天气状态机推成下雨，关闭时只停 rain_storm，
//    天气却永久停在 rain ⇒ 帧循环的 _syncRainSound() 把旧的天气雨声 rain 又放出来
//    （实测：开启前 loops={} → 关闭后 rain 音量 0.12 → 4s 后 0.2）。
//    修法：首次开启时快照天气，关闭时还原（用户裁定「恢复开启前的天气」）。
//
// ② 「屏幕上有纹路，让屏幕看上去很粗糙」（用户裁定「远景雨幕整层去掉」）
//    根因：远景雨幕把 512² 细丝纹理按柱面投影铺满屏幕，横向密度 1.4~5.7 texel/px
//    ⇒ 欠采样走样。上游靠链尾 FXAA 抹掉，而本仓 MSAA 只抗几何边缘、对 shader 内
//    采样的高频纹理完全无效。实测（单变量换纹理内容）：
//      原图 512² → 竖纹 83.5 次/行；纵向渐变（无横向高频）→ 33.5（= 无雨幕基线）；
//      横向细丝 → 144.9；横向预滤波 R8 → 40.4。
//    ⇒ 修法：整层移除（近景雨丝 5200 条 + 水花 + 雾 + 湿地面全部保留）。
//
// ⚠️ 判据读**真实状态机与真实 GPU 像素**，不读常量。

const BOOT = async (page, extra = '', weather = 'clear') => {
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 300)));
  /**
   * ⚠️ **天气必须走参数，不能拼在 extra 里**（本轮实测的判据坑）：
   * 旧写法固定写 `&weather=clear` 再让调用方追加 `&weather=rain`，
   * URL 里就有**两个同名参数**，而 `params.get()` 取第一个 ⇒ 永远是晴天
   * ⇒ 等 intensity>0.99 超时 40s。那是测量方法错，不是被测缺陷。
   */
  await page.goto(`/?vd=4&seed=12345&skybox=0&weather=${weather}${extra}`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 150_000 });
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    g.dayNight.setStyle('noon');
    document.getElementById('hud-root').style.display = 'none';
  });
  return errs;
};

const AUDIO_STATE = () => {
  const g = window.__MC_GAME__;
  return {
    stormActive: g.stormLighting,
    weatherKind: g.weather.kind,
    weatherIntensity: g.weather.intensity,
    loops: g.audioManager?.debugLoops() ?? null,
  };
};

test('雨天光影：晴天开启后关闭，两条雨声都必须停（天气还原）', async ({ page }) => {
  test.setTimeout(240_000);
  const errs = await BOOT(page);
  const before = await page.evaluate(AUDIO_STATE);
  console.log('AUDIO BEFORE:', JSON.stringify(before));
  expect(before.weatherIntensity, '前置：启动是晴天').toBe(0);

  await page.evaluate(() => window.__MC_GAME__.setStormLighting(true));
  await page.waitForTimeout(1200);
  const on = await page.evaluate(AUDIO_STATE);
  console.log('AUDIO ON:', JSON.stringify(on));
  expect(on.loops.rain_storm?.playing, '开启时上游雨床在播').toBe(true);
  expect(on.loops.rain === undefined || on.loops.rain.playing === false,
    '开启时旧的天气雨声必须停（两条互斥）').toBe(true);

  await page.evaluate(() => window.__MC_GAME__.setStormLighting(false));
  // ⚠️ 关档后**立即**取样（不等）：用户要求「关掉就应当关闭」，不接受几秒淡出
  const off = await page.evaluate(AUDIO_STATE);
  console.log('AUDIO OFF (immediate):', JSON.stringify(off));
  expect(off.weatherKind, '天气必须还原成开启前的晴天').toBe('clear');
  expect(off.weatherIntensity, '强度必须立即归 0（不能留 5 秒过渡）').toBe(0);
  expect(off.loops.rain_storm === undefined || off.loops.rain_storm.playing === false,
    '上游雨床必须停').toBe(true);
  expect(off.loops.rain === undefined || off.loops.rain.playing === false,
    '⚠️ 旧的天气雨声也必须停 —— 这正是用户报告的残留').toBe(true);

  // 再等 4 秒：确认帧循环不会把它重新放出来（旧缺陷正是在这里复现）
  await page.waitForTimeout(4000);
  const off2 = await page.evaluate(AUDIO_STATE);
  console.log('AUDIO OFF +4s:', JSON.stringify(off2));
  expect(off2.loops.rain === undefined || off2.loops.rain.playing === false,
    '4 秒后仍不得有雨声（帧循环不得重新起播）').toBe(true);
  expect(Object.keys(off2.loops).length, '关档后循环音轨表必须为空').toBe(0);
  expect(errs, '不得有 console 错误').toEqual([]);
});

test('雨天光影：本来就在下雨时开启再关闭，回到天气雨声（不是静音）', async ({ page }) => {
  test.setTimeout(240_000);
  await BOOT(page, '', 'rain');
  await page.waitForFunction(() => window.__MC_GAME__.weather.intensity > 0.99, null, { timeout: 40_000 });
  const before = await page.evaluate(AUDIO_STATE);
  console.log('RAINY BEFORE:', JSON.stringify(before));
  expect(before.loops.rain?.playing, '前置：天气雨声在播').toBe(true);

  await page.evaluate(() => window.__MC_GAME__.setStormLighting(true));
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.__MC_GAME__.setStormLighting(false));
  await page.waitForTimeout(600);
  const after = await page.evaluate(AUDIO_STATE);
  console.log('RAINY AFTER:', JSON.stringify(after));
  expect(after.weatherKind, '天气还原成 rain').toBe('rain');
  expect(after.weatherIntensity, '强度还原成 1').toBeGreaterThan(0.99);
  expect(after.loops.rain?.playing, '本来就下雨 ⇒ 关档后回到天气雨声').toBe(true);
  expect(after.loops.rain_storm === undefined || after.loops.rain_storm.playing === false,
    '上游雨床必须停').toBe(true);
});

test('雨天光影：反复开关不残留（快照只在首次开启时存）', async ({ page }) => {
  test.setTimeout(240_000);
  await BOOT(page);
  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const out = [];
    for (let i = 0; i < 3; i++) {
      g.setStormLighting(true);
      await new Promise((res) => setTimeout(res, 400));
      // ⚠️ 重复调用 setStormLighting(true) 不得覆盖快照
      g.setStormLighting(true);
      await new Promise((res) => setTimeout(res, 400));
      g.setStormLighting(false);
      await new Promise((res) => setTimeout(res, 300));
      out.push({
        round: i,
        kind: g.weather.kind,
        intensity: g.weather.intensity,
        loops: Object.keys(g.audioManager.debugLoops()),
      });
    }
    return out;
  });
  console.log('TOGGLE ROUNDS:', JSON.stringify(r));
  for (const s of r) {
    expect(s.kind, `第 ${s.round} 轮：天气还原`).toBe('clear');
    expect(s.intensity, `第 ${s.round} 轮：强度归 0`).toBe(0);
    expect(s.loops, `第 ${s.round} 轮：无残留音轨`).toEqual([]);
  }
});