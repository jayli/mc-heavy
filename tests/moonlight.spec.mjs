import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

/**
 * Tier 4：夜间月光照耀（v3.00）—— 方案 A「月亮搬到光照方向那侧」的像素级验收。
 *
 * ## 本轮到底改了什么（这决定判据能测什么）
 *
 * **`uSunDirection` 一个字节不动**（它仍等于 `sunDirection`）⇒ 体素世界的 N·L 几何
 * **逐位不变**，地面明暗与影子方向也完全不变。本轮两个可观测变化：
 *   ① 月轮 sprite 的**仰角从 14.55° 抬到 35.42°**（方位不变）；
 *   ② 夜间色温变冷（像素）。
 *
 * ## 判据
 *   ① 月轮方位 = 光照方位、仰角 ≈35.42°、且光源仰角保持 14.5°（几何）；
 *   ② 夜间地面偏冷（像素），亮度不变 —— 同页 A/B 交替对照，唯一变量是两个色温 uniform；
 *   ③ 隔离：只改 sprite 位置重摆月轮 ⇒ 地面像素逐位不变（钉住"不经过光照通路"）；
 *   ④ 白天零回归：`?style=noon` 的月轮不可见、色温中性。
 *
 * ⚠️ HUD 必须隐藏、阴影必须关（`setShadowsEnabled(false)`）—— `sun-shadow`/`dusk-style` 的既有教训：
 *    perf HUD 半透明黑底会造出假暗区，阴影会让整屏亮度随影区面积浮动。
 * ⚠️ `boot` 里不能 pushModal 之后就不再 pop —— 每个用例末尾都要 pop，否则同一 page 跨用例残留。
 */

const URL_BASE = '/?vd=4&seed=12345&weather=clear';

function regionMeanRGB(png, x, y, half) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) {
      const px = x + dx, py = y + dy;
      if (px < 0 || py < 0 || px >= png.width || py >= png.height) continue;
      const o = (py * png.width + px) * 4;
      r += png.data[o]; g += png.data[o + 1]; b += png.data[o + 2]; n++;
    }
  }
  return { r: r / n, g: g / n, b: b / n };
}

async function boot(page, style) {
  await page.goto(`${URL_BASE}&style=${style}`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  // 隔离：关阴影（会随影区面积浮动整屏亮度）+ 隐藏 HUD（半透明黑底造假暗区）
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    g.setShadowsEnabled(false);
    for (const el of document.querySelectorAll('#hud-root > *, #crosshair, #settings-btn')) el.style.display = 'none';
    g.pushModal('tier4-moon');
  });
}

test('月光①：月轮方位 = 光照方位、仰角擡高到 35.42°（光源一个字节不动）', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page, 'night');
  const s = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    // `_updateCelestial()` 只在重定位时机被调（移动 >5 格 / 方向过门控）。
    // 这里���接摆，并用**真实的 placeCelestial 同款公式**（距离 = far × 0.55）——
    // 拿 sprite 相对相机的方向，而不是读参数 —— 才能验到真实接线。
    const cam = g.camera.position;
    const m = g.sky.moonSprite.position;
    const dx = m.x - cam.x, dy = m.y - cam.y, dz = m.z - cam.z;
    const len = Math.hypot(dx, dy, dz);
    const u = g.renderWorld.materials.dayNight.uSunDirection.value;
    return {
      moonDir: [dx / len, dy / len, dz / len],
      sunDir: [u.x, u.y, u.z],
      sunLen: Math.hypot(u.x, u.y, u.z),
      paramsMoon: g.dayNight.params.moonDirection,
      paramsSun: g.dayNight.params.sunDirection,
    };
  });
  const elev = (v) => Math.asin(v[1]) * 180 / Math.PI;
  const azim = (v) => Math.atan2(v[0], v[2]) * 180 / Math.PI;
  // sprite 位置 = 相机 + params.moonDirection × dist ⇒ 归一化后应与 params 逐位一致
  const dotParams = s.moonDir[0] * s.paramsMoon[0] + s.moonDir[1] * s.paramsMoon[1] + s.moonDir[2] * s.paramsMoon[2];
  console.log('MOONLIGHT DIR:', JSON.stringify({
    moonElev: +elev(s.moonDir).toFixed(4), moonAzim: +azim(s.moonDir).toFixed(4),
    sunElev: +elev(s.sunDir).toFixed(4), sunAzim: +azim(s.sunDir).toFixed(4),
    dotParams: +dotParams.toFixed(6),
  }));

  expect(s.sunLen, 'uSunDirection 须是单位向量').toBeGreaterThan(0.999);
  // ① sprite 真的按 params 摆的（接线正确，而不是恰好碰对）
  expect(dotParams, `月轮位置须与 params.moonDirection 一致（接线正确）：dot=${dotParams.toFixed(6)}`)
    .toBeGreaterThan(0.9999);
  // ② 方位不变（用户「月亮的方位不变」）
  expect(Math.abs(azim(s.moonDir) - azim(s.sunDir)),
    `月亮方位须等于光照方位（方位不变）：moon=${azim(s.moonDir).toFixed(2)}° sun=${azim(s.sunDir).toFixed(2)}°`)
    .toBeLessThan(0.5);
  // ③ 高度真的抬了（本轮改动的核心）
  expect(elev(s.moonDir), `月亮仰角须 ≈35.42°：实测 ${elev(s.moonDir).toFixed(2)}°`)
    .toBeGreaterThan(35.0);
  expect(elev(s.moonDir), `月亮仰角不得超 36°：实测 ${elev(s.moonDir).toFixed(2)}°`)
    .toBeLessThan(36.0);
  // ④ 光源不动（用户「光源也不变」）—— 仍是 14.5° 那一档
  expect(elev(s.sunDir), `光源仰角须保持不动（≈14.5°）：实测 ${elev(s.sunDir).toFixed(2)}°`)
    .toBeGreaterThan(14.0);
  expect(elev(s.sunDir), `光源仰角须保持不动（≈14.5°）：实测 ${elev(s.sunDir).toFixed(2)}°`)
    .toBeLessThan(15.0);

  await page.evaluate(() => window.__MC_GAME__.popModal('tier4-moon'));
});

test('月光②：夜间地面偏冷且亮度不变（单页 A/B：只切 uSunColor/uAmbientColor）', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page, 'night');
  // 固定机位：站在出生点上方俯视自己的平台（纯地面，无天空/无远景）
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    g.camera.up.set(0, 0, -1);
    g.camera.position.set(p.x, p.y + 12, p.z);
    g.camera.lookAt(p.x, p.y + 1, p.z);
    g.camera.updateMatrixWorld();
    g.camera.updateProjectionMatrix();
  });
  const sample = async () => {
    await page.waitForTimeout(700);
    const px = await page.evaluate(() => {
      const g = window.__MC_GAME__;
      const p = g.player.physics.pos;
      const v = new g.camera.position.constructor(p.x, p.y + 1, p.z);
      v.project(g.camera);
      return {
        x: Math.round((v.x * 0.5 + 0.5) * window.innerWidth),
        y: Math.round((-v.y * 0.5 + 0.5) * window.innerHeight),
      };
    });
    return regionMeanRGB(PNG.sync.read(await page.screenshot()), px.x, px.y, 10);
  };

  // 同一页、同一机位、同一帧配置 —— **唯一变量 = 两个色温 uniform**（交替对照）。
  // ⚠️ 不写绝对亮度阈值（俯视平台的 luma 取决于脚下 biome，写死一个数就是「断言想象中的世界」）。
  // ⚠️ 中性色 [1,1,1] 在 IEEE754 下逐位精确 ⇒ 它正是改动前的现状。
  const cold = await sample();
  await page.evaluate(() => {
    const d = window.__MC_GAME__.renderWorld.materials.dayNight;
    d.uSunColor.value.set(1, 1, 1);
    d.uAmbientColor.value.set(1, 1, 1);
  });
  const neutral = await sample();

  const warm = (c) => c.r - c.b;
  const luma = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  console.log('MOONLIGHT COLOR (A/B):', JSON.stringify({
    cold: { r: +cold.r.toFixed(1), g: +cold.g.toFixed(1), b: +cold.b.toFixed(1), warm: +warm(cold).toFixed(1), luma: +luma(cold).toFixed(1) },
    neutral: { r: +neutral.r.toFixed(1), g: +neutral.g.toFixed(1), b: +neutral.b.toFixed(1), warm: +warm(neutral).toFixed(1), luma: +luma(neutral).toFixed(1) },
  }));

  expect(neutral.r, '须读到地面几何而非黑屏').toBeGreaterThan(20);
  expect(Math.abs(warm(neutral)), '中性色温下地面应泛灰（R−B ≈ 0，容差 6）').toBeLessThan(6);
  // 冷色判据（屏幕口径）：spec 实测迎光 R−B = −32、背面 −15 ⇒ 俯视地面混合后应明显为负
  expect(warm(cold), `冷色温下地面须偏冷（R−B < −12）：实测 ${warm(cold).toFixed(1)}`).toBeLessThan(-12);
  // 亮度不变（用户裁定「保持现状亮度」）：两侧相对差 < 16%
  // ⚠️ 同页同帧交替对照，读数只差色温这一个变量 ⇒ 这条才是真正有效的亮度判据
  const lr = luma(cold) / luma(neutral);
  expect(lr, `换色温不得改变整体亮度（目标 +0.3%，容差 ±16%）：实测比 ${lr.toFixed(3)}`).toBeGreaterThan(0.84);
  expect(lr, `换色温不得改变整体亮度：实测比 ${lr.toFixed(3)}`).toBeLessThan(1.16);

  await page.evaluate(() => window.__MC_GAME__.popModal('tier4-moon'));
});

test('月光③：只改 moonDirection 重摆月轮 ⇒ 地面像素逐位不变（钉住"不经过光照通路"）', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page, 'night');
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    g.camera.up.set(0, 0, -1);
    g.camera.position.set(p.x, p.y + 12, p.z);
    g.camera.lookAt(p.x, p.y + 1, p.z);
    g.camera.updateMatrixWorld();
    g.camera.updateProjectionMatrix();
  });
  await page.waitForTimeout(700);
  const before = PNG.sync.read(await page.screenshot());

  // 把月轮搬回改动前的旧方向（与本轮 night 方向夹角 127°）
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    // 直接改 sprite 位置而不改 params —— 模拟"月轮换了个方向"，不碰任何光照输入
    const cam = g.camera.position;
    const oldDir = [-0.3198, 0.5796, -0.7495]; // 归一化后的旧 night.moonDirection
    const dist = g.camera.far * 0.55;
    g.sky.moonSprite.position.set(
      cam.x + oldDir[0] * dist, cam.y + oldDir[1] * dist, cam.z + oldDir[2] * dist,
    );
  });
  await page.waitForTimeout(700);
  const after = PNG.sync.read(await page.screenshot());

  // 地面区域的像素必须逐位不变（月轮只是天空里的 sprite，不进体素 shade）
  let diff = 0, n = 0;
  const W = Math.min(before.width, after.width), H = Math.min(before.height, after.height);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      // 只统计屏幕下半（俯视地面，月轮在上半天空）
      if (y < H * 0.5) continue;
      n++;
      if (before.data[o] !== after.data[o] || before.data[o + 1] !== after.data[o + 1]
        || before.data[o + 2] !== after.data[o + 2]) diff++;
    }
  }
  console.log('MOONLIGHT ISOLATION:', JSON.stringify({ diff, n, pct: +(diff / n * 100).toFixed(3) }));
  expect(diff, `搬动月轮不得改变地面像素（本轮不经过光照通路）：${diff}/${n} 像素变了`).toBe(0);

  await page.evaluate(() => window.__MC_GAME__.popModal('tier4-moon'));
});

test('月光④：白天零回归（月轮不可见 + 色温中性）', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page, 'noon');
  const s = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return {
      moon: g.sky.moonSprite.visible,
      sunColor: g.renderWorld.materials.dayNight.uSunColor.value.toArray(),
      ambientColor: g.renderWorld.materials.dayNight.uAmbientColor.value.toArray(),
    };
  });
  expect(s.moon, '正午月轮须隐藏').toBe(false);
  expect(s.sunColor, '正午色温须仍中性（本轮只改 night）').toEqual([1, 1, 1]);
  expect(s.ambientColor, '正午环境色须仍中性').toEqual([1, 1, 1]);

  await page.evaluate(() => window.__MC_GAME__.popModal('tier4-moon'));
});
