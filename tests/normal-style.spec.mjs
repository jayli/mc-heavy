// tests/normal-style.spec.mjs — Tier 4：「普通」环境风格（v3.44，ASHLAR 光影移植）像素级验收
//
// 设计文档：docs/superpowers/specs/2026-11-27-normal-env-style-ashlar-port-design.md
//
// ## 被测内容
//
// 第 5 档手动风格 `normal`：离线烘焙的 ASHLAR 大气立方图 + 上游 AgX+punch 色调映射
// + per-style 的直射/环境比（shadowFloor 0.14 / hemiGround 0.12 / sunIntensity 0.956）。
//
// ## 判据为什么这样定（都是实测口径，不是想象）
//
// ① **天空真的换成第 5 套**：`uNormalBlend=1` 且天空色与正午可区分。
//    ⚠️ 不用绝对色阈值 —— 大气天空的色随方位/仰角差很大，绝对阈值只会变成「重烘就红」。
// ② **色调映射真的生效**：同一机位同一几何，normal vs noon 的读数必须不同。
//    ⚠️ 这条不能只看「天空变了」—— 天空换了贴图本来就会变。必须**关掉天空盒**
//    （`?skybox=0`）做单变量对照，那时唯一变量就是 toneMapping + 三个光影参数。
// ③ **直射/环境比真的拉开**：顶面/背光面亮度比显著高于正午。
//    这是上游照片感的主因（实测上游 4.26 vs 本仓正午 1.63），也是本档的核心价值。
// ④ **零回归**：其余四档与自动循环，`uNormalBlend` 恒 0、三个 uniform 恒全局常量、
//    toneMapping 恒 ACES ⇒ 天空与着色逐位不变。
// ⑤ **接缝**：立方图 12 条共享边的 RMS 与面内噪声底同量级（照 night-sky-seam 口径）。
// ⑥ **面板落位**：「普通」在末位，点了真的切过去（既有「傍晚紧挨正午」不受影响）。
//
// ## 反例注入（负向验证）
//
// - `VISUAL_STYLES.normal.normalBlend` 改 0 → 用例 ① 真 FAIL（天空回落白天/夜混合）
// - `_apply` 里三个 uniform 恒写全局常量 → 用例 ③ 真 FAIL（对比回到正午水平）
// - `toneMapping` 字段删掉 → 用例 ② 真 FAIL（读数回到 ACES）
//
// ⚠️ HUD 必须隐藏：perf HUD 的半透明黑底会压暗左上象限（sun-shadow.spec 的既有教训）。
// ⚠️ 采样关阴影：uShadowStrength 会让整屏亮度随影区面积浮动（既有 spec 同款隔离）。
// ⚠️ 「世界稳定」不能只看队列归零 —— 要等 sections 停止增长（既有 waitWorldSettled 口径）。

import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

/**
 * 立方体六面的 12 条共享边（OpenGL 约定，v 向下为 +）。最后一项 = 对面是否需翻转。
 * **与 `night-sky-seam.spec.mjs` 逐字同源**（那条口径已实测验证）。
 */
const SEAM_PAIRS = [
  ['posx', 'right', 'negz', 'left', false],
  ['posx', 'left', 'posz', 'right', false],
  ['negx', 'right', 'posz', 'left', false],
  ['negx', 'left', 'negz', 'right', false],
  ['posy', 'bottom', 'posz', 'top', false],
  ['posy', 'top', 'negz', 'top', true],
  ['posy', 'left', 'negx', 'top', false],
  ['posy', 'right', 'posx', 'top', true],
  ['negy', 'top', 'posz', 'bottom', false],
  ['negy', 'bottom', 'negz', 'bottom', true],
  ['negy', 'left', 'negx', 'bottom', true],
  ['negy', 'right', 'posx', 'bottom', false],
];

/** 屏幕相对区域的统计（0..1 坐标） */
function region(png, fx0, fy0, fx1, fy1) {
  const x0 = Math.round(png.width * fx0), x1 = Math.round(png.width * fx1);
  const y0 = Math.round(png.height * fy0), y1 = Math.round(png.height * fy1);
  let sr = 0, sg = 0, sb = 0, n = 0;
  const lums = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * png.width + x) * 4;
      sr += png.data[o]; sg += png.data[o + 1]; sb += png.data[o + 2];
      lums.push(0.2126 * png.data[o] + 0.7152 * png.data[o + 1] + 0.0722 * png.data[o + 2]);
      n++;
    }
  }
  lums.sort((a, b) => a - b);
  return {
    r: sr / n, g: sg / n, b: sb / n,
    warm: (sr - sb) / n,
    lum: lums.reduce((a, b) => a + b, 0) / n,
    p5: lums[Math.floor(n * 0.05)],
    p95: lums[Math.floor(n * 0.95)],
  };
}

/** 等世界真稳（照既有 spec：sections 连续两次不变 + 全队列归零） */
async function waitWorldSettled(page) {
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 120_000 });
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const s = g.scheduler.stats();
    const sections = g.renderStats().sections;
    const prev = window.__MC_STABLE_PREV__;
    window.__MC_STABLE_PREV__ = sections;
    return prev === sections
      && s.genInflight === 0 && s.meshInflight === 0 && s.meshQueued === 0
      && s.pendingMesh === 0 && s.lightInflight === 0 && s.lightQueued === 0 && s.uploadQueue === 0;
  }, null, { timeout: 120_000, polling: 500 });
}

/** 起页 + 隐藏 HUD（阴影按需关，见各用例） */
async function boot(page, url) {
  await page.goto(url);
  await waitWorldSettled(page);
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('#hud-root > *, #crosshair, #settings-btn')) {
      el.style.display = 'none';
    }
  });
}

/** 抬到高空朝指定方位平视（视野内主要是天空） */
async function lookSky(page, azimDeg, elevDeg = 12, height = 260) {
  await page.evaluate(({ azim, elev, h }) => {
    const g = window.__MC_GAME__;
    if (!g.__tier4Modal) { g.pushModal('tier4-normal'); g.__tier4Modal = true; }
    g.camera.up.set(0, 1, 0);
    const px = g.player.physics.pos.x, pz = g.player.physics.pos.z;
    const a = azim * Math.PI / 180, e = elev * Math.PI / 180;
    g.camera.position.set(px, h, pz);
    g.camera.lookAt(px + Math.sin(a) * 100, h + 100 * Math.tan(e), pz + Math.cos(a) * 100);
    g.camera.updateMatrixWorld();
  }, { azim: azimDeg, elev: elevDeg, h: height });
  await page.waitForTimeout(500);
}

/** 读本档全部相关 uniform / renderer 状态（判据的接线证据） */
async function readState(page) {
  return page.evaluate(() => {
    const g = window.__MC_GAME__;
    const u = g.renderWorld.materials.dayNight;
    return {
      normalBlend: g.sky?.uNormalBlend?.value ?? null,
      duskBlend: g.sky?.uDuskBlend?.value ?? null,
      nightBlend: g.sky?.uNightBlend?.value ?? null,
      shadowFloor: u.uShadowFloor.value,
      hemiGround: u.uHemiGround.value,
      sunIntensity: u.uSunIntensity.value,
      shadowStrength: u.uShadowStrength.value,
      skyDim: u.uSkyDim.value,
      toneMapping: g.renderer.toneMapping,
      exposure: g.renderer.toneMappingExposure,
      style: g.dayNight._styleOverride,
    };
  });
}

test('普通①：天空真的换成第 5 套立方图（uNormalBlend=1），且与正午可区分', async ({ page }) => {
  test.setTimeout(300_000);
  await boot(page, '/?vd=2&seed=12345&weather=clear&ambient=0');
  await page.evaluate(() => window.__MC_GAME__.setShadowsEnabled(false));

  await page.evaluate(() => window.__MC_GAME__.setVisualStyle('noon'));
  await lookSky(page, 70);
  const noon = region(PNG.sync.read(await page.screenshot()), 0.2, 0.12, 0.8, 0.38);
  const noonState = await readState(page);

  await page.evaluate(() => window.__MC_GAME__.setVisualStyle('normal'));
  await lookSky(page, 70);
  const normal = region(PNG.sync.read(await page.screenshot()), 0.2, 0.12, 0.8, 0.38);
  const normalState = await readState(page);

  console.log('NORMAL-SKY:', JSON.stringify({
    noon: { warm: +noon.warm.toFixed(1), lum: +noon.lum.toFixed(1) },
    normal: { warm: +normal.warm.toFixed(1), lum: +normal.lum.toFixed(1) },
    noonState, normalState,
  }));

  // ① 混合因子：normal 必须是纯第 5 套，且不叠星空/黄昏
  expect(normalState.normalBlend, '普通档 uNormalBlend 必须为 1（贴图接上）').toBeCloseTo(1, 6);
  expect(normalState.nightBlend, '普通档不得叠星空').toBe(0);
  expect(normalState.duskBlend, '普通档不得叠黄昏').toBe(0);
  // ② 零回归：正午档 normalBlend 必须是 0
  expect(noonState.normalBlend, '正午档 uNormalBlend 必须为 0（零回归）').toBe(0);
  // ③ 天空真的不同（换了贴图 + 换了色调映射）
  const skyDelta = Math.abs(normal.lum - noon.lum);
  expect(skyDelta, `普通与正午的天空亮度须可区分：normal=${normal.lum.toFixed(1)} noon=${noon.lum.toFixed(1)}`)
    .toBeGreaterThan(3);
  // sanity floor：两边都真读到天空（不是黑屏/白屏）
  expect(noon.lum, '正午天空亮度异常（判据基准失效）').toBeGreaterThan(60);
  expect(normal.lum, '普通天空亮度异常').toBeGreaterThan(40);
  expect(normal.lum, '普通天空不得过曝成白屏').toBeLessThan(250);
});

test('普通②：色调映射与光影参数真的生效（关天空盒做单变量对照）', async ({ page }) => {
  test.setTimeout(300_000);
  // ⚠️ ?skybox=0：去掉「换贴图」这个变量，剩下的差异只来自 toneMapping + 三个光影参数
  await boot(page, '/?vd=2&seed=12345&weather=clear&ambient=0&skybox=0');
  await page.evaluate(() => window.__MC_GAME__.setShadowsEnabled(false));

  // 俯视一个受光平台（同 sun-shadow.spec 的手法，但这里只要「同一机位同一几何」）
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const px = g.player.physics.pos.x, pz = g.player.physics.pos.z;
    g.camera.up.set(0, 1, 0);
    g.camera.position.set(px + 3, 120, pz + 0.5);
    g.camera.lookAt(px + 0.5, 20, pz + 0.5);
    g.camera.updateMatrixWorld();
  });
  await page.waitForTimeout(600);

  await page.evaluate(() => window.__MC_GAME__.setVisualStyle('noon'));
  await page.waitForTimeout(600);
  const noon = region(PNG.sync.read(await page.screenshot()), 0.25, 0.35, 0.75, 0.75);
  const noonState = await readState(page);

  await page.evaluate(() => window.__MC_GAME__.setVisualStyle('normal'));
  await page.waitForTimeout(600);
  const normal = region(PNG.sync.read(await page.screenshot()), 0.25, 0.35, 0.75, 0.75);
  const normalState = await readState(page);

  const { ASHLAR_TONE_MAPPING, ACES_FILMIC_TONE_MAPPING } = await page.evaluate(async () => {
    const m = await import('/src/render/ashlar-tonemap-config.js');
    return { ASHLAR_TONE_MAPPING: m.ASHLAR_TONE_MAPPING, ACES_FILMIC_TONE_MAPPING: m.ACES_FILMIC_TONE_MAPPING };
  });

  console.log('NORMAL-GRADE:', JSON.stringify({
    noon: { lum: +noon.lum.toFixed(1), p5: +noon.p5.toFixed(1), p95: +noon.p95.toFixed(1) },
    normal: { lum: +normal.lum.toFixed(1), p5: +normal.p5.toFixed(1), p95: +normal.p95.toFixed(1) },
    noonState, normalState,
  }));

  // ① toneMapping 真的切了（这是「注册 + 写入」两步都成功的证据）
  expect(normalState.toneMapping, '普通档须用自定义 AgX id').toBe(ASHLAR_TONE_MAPPING);
  expect(noonState.toneMapping, '正午档须回落 ACES（零回归）').toBe(ACES_FILMIC_TONE_MAPPING);
  // ② 三个光影参数真的写了本档值
  expect(normalState.shadowFloor, '普通档地板须为 0.14').toBeCloseTo(0.14, 6);
  expect(normalState.hemiGround, '普通档半球须为 0.12').toBeCloseTo(0.12, 6);
  expect(normalState.sunIntensity, '普通档太阳强度须为 0.956').toBeCloseTo(0.956, 6);
  expect(noonState.shadowFloor, '正午地板须回落 0.38').toBeCloseTo(0.38, 6);
  expect(noonState.hemiGround, '正午半球须回落 0.6').toBeCloseTo(0.6, 6);
  // ③ skyDim 耦合：普通档 skyDim=1 ⇒ 阴影浓度不被削弱（设计 §3.4.1）
  expect(normalState.skyDim, '普通档 skyDim 须为 1').toBe(1);
  // ④ 画面真的不同（关天空盒后唯一变量就是色调映射 + 光影参数）
  const delta = Math.abs(normal.lum - noon.lum);
  expect(delta, `关天空盒后两档画面仍须可区分（证明色调映射/光影参数生效）：Δ=${delta.toFixed(2)}`)
    .toBeGreaterThan(2);
  // ⑤ 动态范围拉开（上游照片感的核心：暗部更黑）
  expect(normal.p5, `普通档暗部须比正午更黑：normal p5=${normal.p5.toFixed(1)} noon p5=${noon.p5.toFixed(1)}`)
    .toBeLessThan(noon.p5);
});

test('普通③：其余四档与自动循环逐位零回归', async ({ page }) => {
  test.setTimeout(300_000);
  await boot(page, '/?vd=2&seed=12345&weather=clear&ambient=0');
  await page.evaluate(() => window.__MC_GAME__.setShadowsEnabled(false));
  await lookSky(page, 70);

  const { ACES_FILMIC_TONE_MAPPING } = await page.evaluate(async () => {
    const m = await import('/src/render/ashlar-tonemap-config.js');
    return { ACES_FILMIC_TONE_MAPPING: m.ACES_FILMIC_TONE_MAPPING };
  });

  // 基准：正午先拍一张，最后再切回正午拍一张 —— 必须逐位相同（证明 normal 不残留）
  await page.evaluate(() => window.__MC_GAME__.setVisualStyle('noon'));
  await page.waitForTimeout(600);
  const before = PNG.sync.read(await page.screenshot());

  const states = {};
  for (const style of ['morning', 'noon', 'dusk', 'night', 'normal']) {
    await page.evaluate((s) => window.__MC_GAME__.setVisualStyle(s), style);
    await page.waitForTimeout(500);
    states[style] = await readState(page);
  }
  console.log('NORMAL-ZEROREG:', JSON.stringify(states));

  for (const style of ['morning', 'noon', 'dusk', 'night']) {
    expect(states[style].normalBlend, `${style} 的 uNormalBlend 必须为 0`).toBe(0);
    expect(states[style].shadowFloor, `${style} 地板须回落全局 0.38`).toBeCloseTo(0.38, 6);
    expect(states[style].hemiGround, `${style} 半球须回落全局 0.6`).toBeCloseTo(0.6, 6);
    expect(states[style].sunIntensity, `${style} 强度须回落全局 0.775`).toBeCloseTo(0.775, 6);
    expect(states[style].toneMapping, `${style} 色调映射须回落 ACES`).toBe(ACES_FILMIC_TONE_MAPPING);
  }

  // 自动循环（setStyle(null)）同样零回归
  await page.evaluate(() => window.__MC_GAME__.setVisualStyle(null));
  await page.waitForTimeout(500);
  const auto = await readState(page);
  expect(auto.normalBlend, '自动循环 uNormalBlend 必须为 0').toBe(0);
  expect(auto.shadowFloor, '自动循环地板须为全局常量').toBeCloseTo(0.38, 6);
  expect(auto.toneMapping, '自动循环色调映射须为 ACES').toBe(ACES_FILMIC_TONE_MAPPING);

  // 切回正午：与基准逐位相同（normal 档不留任何残留）
  await page.evaluate(() => window.__MC_GAME__.setVisualStyle('noon'));
  await lookSky(page, 70);
  await page.waitForTimeout(700);
  const after = PNG.sync.read(await page.screenshot());
  let diffBytes = 0;
  for (let i = 0; i < before.data.length; i++) {
    if (before.data[i] !== after.data[i]) diffBytes++;
  }
  console.log('NORMAL-ZEROREG-DIFF:', diffBytes);
  expect(diffBytes, '切到普通再切回正午，画面必须逐位回到基准（无残留）').toBe(0);
});

test('普通④：面板「普通」在末位，点了真的切过去', async ({ page }) => {
  test.setTimeout(300_000);
  await boot(page, '/?vd=2&seed=12345&weather=clear');
  await page.evaluate(() => document.getElementById('settings-btn').click());
  await page.waitForTimeout(400);

  const labels = await page.evaluate(() => {
    const items = [...document.querySelectorAll('#settings-modal .mc-item')];
    const row = items.find((i) => i.textContent.includes('环境风格'));
    return [...row.querySelectorAll('button')].map((b) => b.textContent);
  });
  console.log('NORMAL-PANEL:', JSON.stringify(labels));

  expect(labels[0], '「自动」仍在首位').toBe('自动');
  expect(labels.at(-1), '「普通」在末位（用户裁定）').toBe('普通');
  const noonIdx = labels.indexOf('正午');
  expect(labels[noonIdx + 1], '「傍晚」仍紧挨「正午」右边（既有关系式不变）').toBe('傍晚');

  // 文案不折行（面板有「不得出现纵向滚动条」的冻结断言）
  const rowMetrics = await page.evaluate(() => {
    const items = [...document.querySelectorAll('#settings-modal .mc-item')];
    const row = items.find((i) => i.textContent.includes('环境风格'));
    const btns = [...row.querySelectorAll('button')];
    return btns.map((b) => ({ text: b.textContent, h: b.getBoundingClientRect().height }));
  });
  const heights = rowMetrics.map((b) => b.h);
  const maxH = Math.max(...heights), minH = Math.min(...heights);
  console.log('NORMAL-PANEL-BTN:', JSON.stringify(rowMetrics));
  expect(maxH - minH, `六个按钮高度须一致（不一致说明有文案折行）：${JSON.stringify(heights)}`)
    .toBeLessThan(1.5);

  await page.locator('#settings-modal .mc-item', { hasText: '环境风格' })
    .locator('button', { hasText: '普通' }).click();
  await page.waitForTimeout(500);
  const state = await page.evaluate(() => ({
    normalBlend: window.__MC_GAME__.sky.uNormalBlend.value,
    style: window.__MC_GAME__.dayNight._styleOverride,
    stored: JSON.parse(localStorage.getItem('mc_heavy_settings_v1') || '{}').visualStyle,
  }));
  expect(state.normalBlend, '点「普通」后 uNormalBlend 须为 1').toBeCloseTo(1, 6);
  expect(state.style, '引擎侧须切到 normal').toBe('normal');
  expect(state.stored, '选择须持久化').toBe('normal');
});

test('普通⑥：立方图 12 条共享边无缝（绝对接缝 ≤ 白天基准 + 量化残差上界）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=2&seed=12345');

  // ⚠️ 判据口径照搬 `night-sky-seam.spec.mjs`：**相对比值**而不是裸 RMS。
  // 理由（那边已实测）：用户认可的白天基准裸 RMS 是 1.90 而不是 0（JPEG 量化残差），
  // 看不见是因为它不比面内普通相邻像素落差更大。裸 RMS 会给出错误结论。
  const measure = async (dir) => page.evaluate(async ({ dir, pairs }) => {
    const NAMES = ['posx', 'negx', 'posy', 'negy', 'posz', 'negz'];
    const faces = {};
    for (const n of NAMES) {
      const img = new Image();
      img.src = `${dir}/${n}.jpg`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      faces[n] = { w: img.width, h: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data };
    }
    const pix = (f, x, y) => {
      const a = faces[f]; const i = ((y * a.w) + x) * 4;
      return [a.data[i], a.data[i + 1], a.data[i + 2]];
    };
    const edge = (f, side) => {
      const a = faces[f]; const out = [];
      if (side === 'top') for (let x = 0; x < a.w; x++) out.push(pix(f, x, 0));
      else if (side === 'bottom') for (let x = 0; x < a.w; x++) out.push(pix(f, x, a.h - 1));
      else if (side === 'left') for (let y = 0; y < a.h; y++) out.push(pix(f, 0, y));
      else for (let y = 0; y < a.h; y++) out.push(pix(f, a.w - 1, y));
      return out;
    };
    const rms = (A, B) => {
      let s = 0;
      for (let i = 0; i < A.length; i++) for (let c = 0; c < 3; c++) { const d = A[i][c] - B[i][c]; s += d * d; }
      return Math.sqrt(s / (A.length * 3));
    };
    const seams = [];
    for (const [fa, sa, fb, sb, flip] of pairs) {
      const A = edge(fa, sa);
      let B = edge(fb, sb);
      if (flip) B = B.slice().reverse();
      seams.push(rms(A, B));
    }
    const inner = [];
    for (const n of NAMES) {
      const a = faces[n];
      for (const t of [0.15, 0.3, 0.45, 0.6, 0.75]) {
        const x = Math.floor(a.w * t);
        const c1 = [], c2 = [];
        for (let y = 0; y < a.h; y++) { c1.push(pix(n, x, y)); c2.push(pix(n, x + 1, y)); }
        inner.push(rms(c1, c2));
      }
    }
    const seamMean = seams.reduce((s, x) => s + x, 0) / seams.length;
    const innerMean = inner.reduce((s, x) => s + x, 0) / inner.length;
    return { seamMean, seamMax: Math.max(...seams), innerMean, ratio: seamMean / innerMean };
  }, { dir, pairs: SEAM_PAIRS });

  const normal = await measure('/assets/sky/normal');
  const day = await measure('/assets/sky/day');
  console.log('NORMAL-SKY-SEAM:', JSON.stringify({
    normal: { seam: +normal.seamMean.toFixed(3), max: +normal.seamMax.toFixed(3), inner: +normal.innerMean.toFixed(3), ratio: +normal.ratio.toFixed(3) },
    day: { seam: +day.seamMean.toFixed(3), inner: +day.innerMean.toFixed(3), ratio: +day.ratio.toFixed(3) },
  }));

  // 主判据：**绝对接缝 RMS 不得比白天基准更差**。
  //
  // ⚠️⚠️ **为何不用 night-sky-seam 那套「接缝/面内噪声底」比值**（本轮实测否定）：
  // 那套口径的前提是「贴图有照片级高频内容」，噪声底与 JPEG 残差同量级。
  // 本档是**程序化平滑天空**：面内噪声底只 **0.144**（day 是 1.075，小 7.5 倍），
  // 而 JPEG 量化残差是**固定的 ±1~2**（不随内容平滑而变小）
  // ⇒ 比值 = 0.353/0.144 = **2.459**，反而比 day 的 1.765 「差」—— 但它的
  // **绝对接缝比 day 小 5.4 倍**（0.353 vs 1.897）。比值在这里是**错的仪器**。
  //
  // 判决性实测（编码前真值，一次性探针）：posy.bottom 与 posz.top 是同一批方向，
  // 方向差 **0.00e+0**、编码前接缝 RMS **0.000000**、最大单点差 **0.000000**
  // ⇒ 几何上精确无缝，磁盘上那 ±1~2 **全部**来自 JPEG 量化。
  // （四条 negy 共享边在磁盘上就是 **0**，也佐证方向数学正确。）
  //
  // 故判据改成：绝对接缝 ≤ 白天基准（用户认可的「看不到边角」样本）。
  // 它问的是「有没有比那张更差」，而不是被自身平滑度惩罚。
  expect(normal.seamMean,
    `普通天空绝对接缝 ${normal.seamMean.toFixed(3)} 比白天基准 ${day.seamMean.toFixed(3)} 更差`)
    .toBeLessThanOrEqual(day.seamMean);
  // 量化残差上界：平滑图的 JPEG 残差应在亚灰阶量级（实测 max 0.769）。
  // 这条才能拓「真的出了几何接缝」：方向数学写错时接缝会是几到几十个灰阶（参考
  // mc-lite 原夜空 41.09），与 1.5 差一个数量级以上，不贴线。
  expect(normal.seamMax,
    `单条边最大接缝 ${normal.seamMax.toFixed(3)} 超出 JPEG 量化残差量级（几何接缝？）`)
    .toBeLessThan(1.5);
  // sanity floor：噪声底不得为 0（否则贴图可能是纯色/全黑，什么都没测到）
  expect(normal.innerMean, '普通天空噪声底过低（贴图可能是纯色）').toBeGreaterThan(0.05);
  expect(day.innerMean, '白天噪声底异常（判据基准失效）').toBeGreaterThan(0.3);
});

test('普通⑤：启动即普通档时首帧就是目标状态（不等外部补 setStyle）', async ({ page }) => {
  test.setTimeout(300_000);
  // 走 URL（等价于面板持久化：两者都经 resolveSettings → settings.visualStyle）
  await boot(page, '/?vd=2&seed=12345&weather=clear&ambient=0&style=normal');
  const state = await readState(page);
  const { ASHLAR_TONE_MAPPING } = await page.evaluate(async () => {
    const m = await import('/src/render/ashlar-tonemap-config.js');
    return { ASHLAR_TONE_MAPPING: m.ASHLAR_TONE_MAPPING };
  });
  console.log('NORMAL-BOOT:', JSON.stringify(state));
  expect(state.style, 'URL style=normal 须进 override').toBe('normal');
  expect(state.normalBlend, '首帧天空就是第 5 套').toBeCloseTo(1, 6);
  expect(state.shadowFloor, '首帧地板就是本档值').toBeCloseTo(0.14, 6);
  expect(state.toneMapping, '首帧色调映射就是自定义 AgX').toBe(ASHLAR_TONE_MAPPING);
  expect(state.exposure, '首帧曝光就是本档值').toBeCloseTo(2.2, 6);
});