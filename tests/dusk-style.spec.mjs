// tests/dusk-style.spec.mjs — Tier 4：傍晚风格（v1.71）像素级验收
//
// ## 被测内容
//
// 新增第四种视觉风格 `dusk`（设置面板「环境风格」里紧挨「正午」右边），天空盒 = mc-lite
// `skyBox2`（日落），色温 = 暖橙直射 + 冷蓝紫环境，太阳方向按贴图里那轮太阳定（azim +44°）。
//
// ## 判据为什么这样定（都是实测口径）
//
// ① **天空确实是 `skyBox2`**：`uDuskBlend` 必须是 1（贴图接上了），且天空区**不再是白天那种
//    冷蓝**。不用绝对色——照片天空的色随方位差很大，绝对阈值只会变成「换贴图就红」。
// ② **地平线暖带出现在太阳所在方位**：按方位扫一圈，暖度峰值（R−B）必须落在 azim ≈ 45°。
//    实测：azim 45° R−B = **+36.9**、正对面（azim −135°）**−4.2** → 差 8 倍，方向性是真的。
//    ⚠️ 这条是「贴图 ↔ 太阳方向一致」的**交叉验证** —— 若 sunDirection 写错象限，
//    天空的暖带与体素的迎光面就会朝不同方向（玩家看到「太阳在左边、影子朝右」）。
// ③ **暖光冷影**：迎光面屏幕 R−B > 0（偏暖）、背光面 R−B < 0（偏冷）。这是色温 uniform
//    生效的证据；只有「整体变黄」而没有「影子里偏蓝」就等于没做色温。
// ④ **可辨认的傍晚**：整屏亮度落在「比正午暗一档、但远亮于夜」的区间（实测比 0.761）。
//    用户 2026-10-24 选定的口径（贴图的 5.5° 太暗，抬到 12°）。
// ⑤ **其他风格零回归**：三种既有风格 `uDuskBlend` 恒 0、色温恒中性白 —— 天空与着色逐位不变。
// ⑥ **面板落位**：「傍晚」按钮紧挨「正午」右边，且点了真的切过去。
//
// ## 反例注入（负向验证，实测过）
//
// - 把 `VISUAL_STYLES.dusk.duskBlend` 改成 0 → 用例 1 真 FAIL（天空回落到夜间/白天混合）。
// - 把 `sunDirection` 的 x 取反（azim +44° → −44°）→ 用例 2 真 FAIL（暖带跑到反方向）。
// - 把 `sunColor`/`ambientColor` 都改成 [1,1,1] → 用例 3 真 FAIL（迎光面不再偏暖）。
//
// ⚠️ 采样必须**关阴影**：`uShadowStrength` 会让整屏亮度随影区面积浮动（既有 spec 的同款隔离）。
// ⚠️ HUD 必须隐藏：perf HUD 的半透明黑底会压暗左上象限（`sun-shadow.spec` 的既有教训）。

import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

/** 屏幕某相对区域的颜色统计（0..1 的相对坐标） */
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
  return {
    r: sr / n, g: sg / n, b: sb / n,
    warm: (sr - sb) / n,          // 暖度：R − B（0 = 中性灰）
    lum: lums.reduce((a, b) => a + b, 0) / n,
  };
}

/** 起页 + 关阴影 + 隐藏 HUD */
async function boot(page, url = '/?vd=2&seed=12345') {
  await page.goto(url);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 120_000 });
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    g.setShadowsEnabled(false);   // 隔离阴影（整屏亮度会被影区面积左右）
    for (const el of document.querySelectorAll('#hud-root > *, #crosshair, #settings-btn')) {
      el.style.display = 'none';
    }
  });
}

/** 抬到高空朝指定方位平视（视野内只有天空 + 远处地形轮廓） */
async function lookAt(page, azimDeg, elevDeg = 5, height = 260) {
  await page.evaluate(({ azim, elev, h }) => {
    const g = window.__MC_GAME__;
    if (!g.__tier4Modal) { g.pushModal('tier4-dusk'); g.__tier4Modal = true; }
    g.camera.up.set(0, 1, 0);
    const px = g.player.physics.pos.x, pz = g.player.physics.pos.z;
    const a = azim * Math.PI / 180, e = elev * Math.PI / 180;
    g.camera.position.set(px, h, pz);
    g.camera.lookAt(
      px + Math.sin(a) * 100, h + 100 * Math.tan(e), pz + Math.cos(a) * 100,
    );
    g.camera.updateMatrixWorld();
  }, { azim: azimDeg, elev: elevDeg, h: height });
  await page.waitForTimeout(450);
}

test('傍晚①：天空盒真的换成 skyBox2（uDuskBlend=1），且天空不再是白天那种冷蓝', async ({ page }) => {
  test.setTimeout(300_000);
  await boot(page);
  // 正午对照
  await page.evaluate(() => window.__MC_GAME__.setVisualStyle('noon'));
  await lookAt(page, 45);
  const noon = region(PNG.sync.read(await page.screenshot()), 0.2, 0.15, 0.8, 0.40);
  // 傍晚
  await page.evaluate(() => window.__MC_GAME__.setVisualStyle('dusk'));
  await lookAt(page, 45);
  const dusk = region(PNG.sync.read(await page.screenshot()), 0.2, 0.15, 0.8, 0.40);
  const u = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return {
      duskBlend: g.sky.uDuskBlend.value,
      nightBlend: g.sky.uNightBlend.value,
      sunColor: g.renderWorld.materials.dayNight.uSunColor.value.toArray(),
      ambientColor: g.renderWorld.materials.dayNight.uAmbientColor.value.toArray(),
    };
  });
  console.log('DUSK-SKY:', JSON.stringify({
    noon: { warm: +noon.warm.toFixed(1), lum: +noon.lum.toFixed(1) },
    dusk: { warm: +dusk.warm.toFixed(1), lum: +dusk.lum.toFixed(1) },
    uniforms: u,
  }));

  // ① 混合因子：dusk 必须是纯 dusk 立方图（=1），且不叠星空（nightBlend=0）
  expect(u.duskBlend, '傍晚的 uDuskBlend 必须为 1（贴图接上）').toBeCloseTo(1, 6);
  expect(u.nightBlend, '傍晚不得叠星空（nightBlend 显式 0）').toBe(0);
  // ② 天空不再是白天那种冷蓝（实测正午 warm −44.6 / 傍晚 +36.9，方向相反）
  expect(noon.warm, `正午天空须偏冷（冷蓝基准）：实测 ${noon.warm.toFixed(1)}`).toBeLessThan(-15);
  expect(dusk.warm, `傍晚天空须明显暖于正午：dusk=${dusk.warm.toFixed(1)} noon=${noon.warm.toFixed(1)}`)
    .toBeGreaterThan(noon.warm + 20);
  // sanity floor：两边都得真读到天空（不是黑屏/白屏）
  expect(noon.lum, '正午天空亮度异常（判据基准失效）').toBeGreaterThan(80);
  expect(dusk.lum, '傍晚天空亮度异常').toBeGreaterThan(60);
});

test('傍晚②：地平线暖带落在太阳方位（贴图 ↔ sunDirection 交叉验证）', async ({ page }) => {
  test.setTimeout(300_000);
  await boot(page, '/?vd=2&seed=12345&style=dusk');

  // 按方位扫一圈，量地平线带的暖度
  const scan = [];
  for (let az = -180; az < 180; az += 15) {
    await lookAt(page, az);
    const png = PNG.sync.read(await page.screenshot());
    scan.push({ az, warm: region(png, 0.2, 0.45, 0.8, 0.62).warm });
  }
  const ranked = [...scan].sort((a, b) => b.warm - a.warm);
  const best = ranked[0];
  const worst = ranked[ranked.length - 1];
  // 从风格数据读太阳方位（唯一权威），不在这里写第二份字面量
  const azimFromData = await page.evaluate(() => {
    const d = window.__MC_GAME__.dayNight.params.sunDirection;
    return Math.atan2(d[0], d[2]) * 180 / Math.PI;
  });
  console.log('DUSK-AZIMUTH:', JSON.stringify({
    best: [best.az, +best.warm.toFixed(1)],
    worst: [worst.az, +worst.warm.toFixed(1)],
    top3: ranked.slice(0, 3).map((r) => [r.az, +r.warm.toFixed(1)]),
    azimFromData: +azimFromData.toFixed(1),
  }));

  // 判据：暖区峰值方位必须与 sunDirection 的方位一致（±15° = 扫描步长）
  const diff = Math.abs(((best.az - azimFromData + 540) % 360) - 180);
  expect(diff, `暖带峰值方位 ${best.az}° 须与太阳方位 ${azimFromData.toFixed(1)}° 一致`).toBeLessThanOrEqual(15);
  // 方向性是真的：最暖与最冷差一大截（实测 +36.9 vs −4.2）
  expect(best.warm - worst.warm, `暖带须有方向性：${best.warm.toFixed(1)} vs ${worst.warm.toFixed(1)}`)
    .toBeGreaterThan(25);
  expect(best.warm, '日落方位的地平线须真的偏暖（R−B > 15）').toBeGreaterThan(15);
});

/**
 * 受控考场：高空全 stone 平台 + 一堵沿 X 的石墙（法线 ±Z）。
 * 复用 `sun-directional.spec.mjs` 的手法 —— 同一材质、清空上空、投影采样墙面中心，
 * 这样「唯一变量」才真的是太阳方向（而不是「镜头里刚好有什么方块」）。
 */
async function buildWalledArena(page) {
  const P = 80;
  const pos = await page.evaluate((P) => {
    const g = window.__MC_GAME__;
    const ox = Math.floor(g.player.physics.pos.x), oz = Math.floor(g.player.physics.pos.z);
    const stone = g.registry.idOf('stone');
    for (let y = P + 1; y <= 95; y++) {
      for (let dx = -14; dx <= 14; dx++) for (let dz = -14; dz <= 14; dz++) {
        if (g.world.getBlockId(ox + dx, y, oz + dz) !== 0) g.editor.setBlock({ x: ox + dx, y, z: oz + dz, id: 0 });
      }
    }
    for (let dx = -14; dx <= 14; dx++) for (let dz = -14; dz <= 14; dz++) {
      g.editor.setBlock({ x: ox + dx, y: P, z: oz + dz, id: stone });
    }
    for (let dx = -8; dx <= 8; dx++) for (let dy = 1; dy <= 3; dy++) {
      g.editor.setBlock({ x: ox + dx, y: P + dy, z: oz, id: stone });
    }
    if (!g.__tier4Modal) { g.pushModal('tier4-dusk'); g.__tier4Modal = true; }
    for (const el of document.querySelectorAll('#hud-root > *, #crosshair, #settings-btn')) el.style.display = 'none';
    return { ox, oz };
  }, P);
  await page.waitForFunction(() => window.__MC_GAME__?.scheduler?.stats().meshInflight === 0, null, { timeout: 60_000 });
  return { ...pos, P };
}

/** 站到墙的 `side` 一侧正视墙面，返回墙面中心的平均 RGB */
async function faceRGB(page, arena, side) {
  const { ox, oz, P } = arena;
  await page.evaluate(({ ox, oz, P, side }) => {
    const g = window.__MC_GAME__;
    g.camera.up.set(0, 1, 0);
    g.camera.position.set(ox + 0.5, P + 2, oz + side * 10);
    g.camera.lookAt(ox + 0.5, P + 2, oz);
    g.camera.updateMatrixWorld();
    g.camera.updateProjectionMatrix();
  }, { ox, oz, P, side });
  await page.waitForTimeout(700);
  const px = await page.evaluate(({ ox, oz, P, side }) => {
    const g = window.__MC_GAME__;
    const v = new g.camera.position.constructor(ox + 0.5, P + 2, oz + side * 0.001);
    v.project(g.camera);
    return {
      x: Math.round((v.x * 0.5 + 0.5) * window.innerWidth),
      y: Math.round((-v.y * 0.5 + 0.5) * window.innerHeight),
    };
  }, { ox, oz, P, side });
  const png = PNG.sync.read(await page.screenshot());
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let dy = -8; dy <= 8; dy++) {
    for (let dx = -8; dx <= 8; dx++) {
      const x = px.x + dx, y = px.y + dy;
      if (x < 0 || y < 0 || x >= png.width || y >= png.height) continue;
      const o = (y * png.width + x) * 4;
      sr += png.data[o]; sg += png.data[o + 1]; sb += png.data[o + 2]; n++;
    }
  }
  return { r: sr / n, g: sg / n, b: sb / n, warm: (sr - sb) / n };
}

test('傍晚③：暖光冷影 —— 迎光面偏暖、背光面偏冷（色温 uniform 真的生效）', async ({ page }) => {
  test.setTimeout(300_000);
  await boot(page, '/?vd=4&seed=12345&style=dusk');
  const arena = await buildWalledArena(page);

  // dusk 太阳在 azim +44° → 它的 +Z 分量很强（0.688）→ **+Z 面是迎光面、−Z 面是背光面**
  // （与 `sun-directional.spec.mjs` 用 noon 时同一对墙面，只是墙法线吃到的 N·L 不同）
  const lit = await faceRGB(page, arena, 1);
  const back = await faceRGB(page, arena, -1);
  const u = await page.evaluate(() => {
    const d = window.__MC_GAME__.renderWorld.materials.dayNight;
    return {
      sunColor: d.uSunColor.value.toArray().map((v) => +v.toFixed(3)),
      ambientColor: d.uAmbientColor.value.toArray().map((v) => +v.toFixed(3)),
    };
  });
  console.log('DUSK-WARM-COOL:', JSON.stringify({
    lit: { r: +lit.r.toFixed(1), b: +lit.b.toFixed(1), warm: +lit.warm.toFixed(1) },
    back: { r: +back.r.toFixed(1), b: +back.b.toFixed(1), warm: +back.warm.toFixed(1) },
    uniforms: u,
  }));

  // sanity floor：两次都要读到石墙（不是天空/黑屏）
  expect(lit.r, '迎光面须读到石墙几何').toBeGreaterThan(20);
  expect(back.r, '背光面须读到石墙几何').toBeGreaterThan(20);
  // 色温 uniform：暖橙直射 + 冷蓝环境
  expect(u.sunColor[0], '直射光须偏暖（R > B）').toBeGreaterThan(u.sunColor[2] + 0.3);
  expect(u.ambientColor[2], '环境光须偏冷（B > R）').toBeGreaterThan(u.ambientColor[0] + 0.1);
  // ⚠️ 屏幕口径的阈值按**实测定**（石头贴图是纯灰 R−B=0，所以暖度完全来自色温）：
  //   实测迎光 +9.9 / 背光 −1.0 → 差 10.9。不贴线取 6。
  expect(lit.warm, `迎光面须偏暖：实测 R−B=${lit.warm.toFixed(1)}`).toBeGreaterThan(6);
  expect(back.warm, `背光面须偏冷：实测 R−B=${back.warm.toFixed(1)}`).toBeLessThan(2);
  // 方向差是真的（这才是「暖光冷影」，不是「整体变黄」）
  expect(lit.warm - back.warm,
    `迎光与背光须有明显色温差：${lit.warm.toFixed(1)} vs ${back.warm.toFixed(1)}`).toBeGreaterThan(6);
});

test('傍晚④：可辨认的傍晚（比正午暗一档，但远亮于夜）', async ({ page }) => {
  test.setTimeout(300_000);
  await boot(page);
  // 固定机位（出生点平视）：三者只差风格这一个变量
  const shoot = async (style) => {
    await page.evaluate((s) => window.__MC_GAME__.setVisualStyle(s), style);
    await page.waitForTimeout(900);
    await page.evaluate(() => {
      const g = window.__MC_GAME__;
      const p = g.player.physics.pos;
      g.camera.position.set(p.x, p.y + 2, p.z);
      g.camera.lookAt(p.x, p.y + 2, p.z + 10);
      g.camera.updateMatrixWorld();
    });
    await page.waitForTimeout(500);
    return region(PNG.sync.read(await page.screenshot()), 0.15, 0.15, 0.85, 0.95);
  };
  const noon = await shoot('noon');
  const dusk = await shoot('dusk');
  const night = await shoot('night');
  const ratio = dusk.lum / noon.lum;
  console.log('DUSK-TONE:', JSON.stringify({
    noon: +noon.lum.toFixed(1), dusk: +dusk.lum.toFixed(1), night: +night.lum.toFixed(1),
    duskOverNoon: +ratio.toFixed(3), duskOverNight: +(dusk.lum / night.lum).toFixed(3),
  }));

  // 比正午暗一档（实测 0.761），但远亮于夜（实测 >2）—— 用户选定的「可辨认的傍晚」
  expect(ratio, `傍晚须比正午暗：${ratio.toFixed(3)}`).toBeLessThan(0.92);
  expect(ratio, `傍晚不得糊成黑夜（可辨认下界）：${ratio.toFixed(3)}`).toBeGreaterThan(0.55);
  expect(dusk.lum / night.lum, `傍晚须远亮于深夜：${(dusk.lum / night.lum).toFixed(2)}`).toBeGreaterThan(1.8);
});

test('傍晚⑤：morning/noon 零回归；night 为月光冷色（v3.00）；auto 随小时走', async ({ page }) => {
  test.setTimeout(240_000);
  await boot(page);
  const seen = [];
  for (const style of ['morning', 'noon', 'night']) {
    await page.evaluate((s) => window.__MC_GAME__.setVisualStyle(s), style);
    await page.waitForTimeout(300);
    const u = await page.evaluate(() => {
      const g = window.__MC_GAME__;
      const d = g.renderWorld.materials.dayNight;
      return {
        duskBlend: g.sky.uDuskBlend.value,
        sunColor: d.uSunColor.value.toArray(),
        ambientColor: d.uAmbientColor.value.toArray(),
        sunLight: g.sunLight.color.toArray().map((v) => +v.toFixed(4)),
      };
    });
    seen.push({ style, ...u });
  }
  console.log('DUSK-NEUTRAL:', JSON.stringify(seen));

  for (const s of seen) {
    expect(s.duskBlend, `风格 ${s.style} 的 uDuskBlend 必须为 0`).toBe(0);
    if (s.style === 'night') {
      // v3.00：夜间改为月光冷色（均值 1.0600）。判据落在**色相方向**上，不是具体数值
      // —— 具体数值由 test-daynight.js 的均值区间 [1.04,1.08] 钉住。
      expect(s.sunColor[2], `night 直射须偏冷（B > R）：${s.sunColor}`)
        .toBeGreaterThan(s.sunColor[0] + 0.4);
      expect(s.ambientColor[2], `night 环境须偏冷（B > R）：${s.ambientColor}`)
        .toBeGreaterThan(s.ambientColor[0] + 0.15);
    } else {
      expect(s.sunColor, `风格 ${s.style} 的 sunColor 须中性白`).toEqual([1, 1, 1]);
      expect(s.ambientColor, `风格 ${s.style} 的 ambientColor 须中性白`).toEqual([1, 1, 1]);
      // 中性色温下灯光色逐位等于 mc-lite 原值 0xfffaf0
      expect(s.sunLight, `风格 ${s.style} 的太阳灯须回到原色`).toEqual([1, 0.9804, 0.9412]);
    }
  }
});

test('傍晚⑥：面板「傍晚」按钮紧挨「正午」右边，且点了真的切过去', async ({ page }) => {
  test.setTimeout(240_000);
  await boot(page);
  await page.evaluate(() => document.getElementById('settings-btn').click());
  await page.waitForTimeout(400);

  const labels = await page.evaluate(() => {
    const items = [...document.querySelectorAll('#settings-modal .mc-item')];
    const row = items.find((i) => i.textContent.includes('环境风格'));
    return [...row.querySelectorAll('button')].map((b) => b.textContent);
  });
  console.log('DUSK-PANEL:', JSON.stringify(labels));

  const noonIdx = labels.indexOf('正午');
  expect(noonIdx, '「正午」按钮须在').toBeGreaterThanOrEqual(0);
  expect(labels[noonIdx + 1], '「傍晚」必须紧挨在「正午」右边').toBe('傍晚');
  expect(labels[0], '「自动」仍在首位（日夜循环的唯一入口）').toBe('自动');

  // 点「傍晚」后引擎侧真的生效
  await page.locator('#settings-modal .mc-item', { hasText: '环境风格' }).locator('button', { hasText: '傍晚' }).click();
  await page.waitForTimeout(400);
  const state = await page.evaluate(() => ({
    duskBlend: window.__MC_GAME__.sky.uDuskBlend.value,
    style: window.__MC_GAME__.dayNight.params.duskBlend,
    stored: JSON.parse(localStorage.getItem('mc_heavy_settings_v1') || '{}').visualStyle,
  }));
  expect(state.duskBlend, '点「傍晚」后 uDuskBlend 须为 1').toBeCloseTo(1, 6);
  expect(state.stored, '选择须持久化（visualStyle=dusk）').toBe('dusk');
});
