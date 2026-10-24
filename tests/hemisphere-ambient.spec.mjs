import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

/**
 * Tier 4：半球环境光（v1.70）—— 「朝上的面比朝下的面亮」的像素级验收。
 *
 * 隔离场景：一块**悬空厚板**（y = P..P+1，13×13）。顶面与底面是同一材质、都入画，
 * 唯一差别是面法线的 y 分量。相机分别从上方俯视顶面、从下方仰视底面。
 * 唯一变量 = `uHemiGround`（1.0 = 关闭，逐位回到 v1.69）。
 *
 * 判据（双侧，两处都不贴线）：
 *   ① 顶面**只改 uHemiGround 时逐位不变** —— 这条是**正向对照**：证明半球因子只作用于
 *      朝下的面，不会整体压暗画面。缺了它，「底面变暗」可能只是「全世界变暗」。
 *   ② 底面显著变暗（实测 ground=0.2 时 −56%，见设计文档 §6.2）。
 *   ③ sanity floor：两支读数都必须是几何（不是天空、不是黑屏）—— 否则「恒定」恒真。
 *
 * ⚠️ **光源必须手动摆到被测物上方**：`_updateSunPosition()` 把阴影相机居中到**玩家**
 *    （±48 覆盖 96 格），而本平台在 P=80、玩家在 y≈22 → 平台整体在阴影相机视锥外。
 *    与 `sun-shadow.spec` 同一手法：这不是补机制缺位，只是把被测物挪进视锥。
 *    实测踩坑记录：不做这一步时「柱子旁边的地面」被误当影区，读数完全无意义。
 *
 * ⚠️ **隐藏全部 HUD**：`perf-hud` 的半透明黑底（rgba(0,0,0,.55)）会造出跟随屏幕的假暗区。
 */

const URL = '/?vd=4&seed=12345&style=noon&weather=clear';

/** 区域平均亮度（照 tests/sun-shadow.spec.mjs 的 regionRGB 手法，取三通道均值） */
function regionLuma(png, cx, cy, r) {
  let sum = 0, n = 0;
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || y < 0 || x >= png.width || y >= png.height) continue;
      const o = (y * png.width + x) * 4;
      sum += (png.data[o] + png.data[o + 1] + png.data[o + 2]) / 3;
      n++;
    }
  }
  return n ? sum / n : NaN;
}

async function waitWorldSettled(page) {
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const s = g.scheduler.stats();
    const sections = g.renderStats().sections;
    const prev = window.__MC_STABLE_PREV__;
    window.__MC_STABLE_PREV__ = sections;
    return prev === sections && s.genInflight === 0 && s.meshInflight === 0 &&
      s.meshQueued === 0 && s.pendingMesh === 0 && s.uploadQueue === 0;
  }, null, { timeout: 90_000, polling: 500 });
}

test('半球环境光：顶面恒亮、底面随 uHemiGround 变暗', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 960, height: 540 });
  await page.goto(URL);
  await waitWorldSettled(page);

  const P = 80;
  const geo = await page.evaluate((P) => {
    const g = window.__MC_GAME__;
    const ox = Math.floor(g.player.physics.pos.x), oz = Math.floor(g.player.physics.pos.z);
    const stone = g.registry.idOf('stone');
    // 清板上空：云 / 空岛 / 建筑全部清掉 → 采样区只剩这块厚板
    for (let y = P + 1; y <= P + 30; y++) {
      for (let dx = -12; dx <= 12; dx++) for (let dz = -12; dz <= 12; dz++) {
        const x = ox + dx, z = oz + dz;
        if (g.world.getBlockId(x, y, z) !== 0) g.editor.setBlock({ x, y, z, id: 0 });
      }
    }
    // 悬空厚板（y = P..P+1）：顶面朝上、底面朝下，两者同材质
    for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) {
      for (let dy = 0; dy <= 1; dy++) {
        g.editor.setBlock({ x: ox + dx, y: P + dy, z: oz + dz, id: stone });
      }
    }
    // 光源摆到被测物上方（理由见文件头注释）
    const dir = g.dayNight.params.sunDirection;
    g.sunLight.position.set(ox + 0.5 + dir[0] * 60, P + dir[1] * 60, oz + 0.5 + dir[2] * 60);
    g.sunLight.target.position.set(ox + 0.5, P + 1, oz + 0.5);
    g.sunLight.target.updateMatrixWorld();
    g.sunLight.shadow.needsUpdate = true;
    g.pushModal('tier4-hemi');
    for (const el of document.querySelectorAll('#hud-root > *, #crosshair, #settings-btn')) {
      el.style.display = 'none';
    }
    return { ox, oz };
  }, P);
  await waitWorldSettled(page);
  await page.waitForTimeout(800);

  /** 取一个机位的采样点亮度；cam.atY = 采样点在世界坐标里的 y（P+1 顶面 / P 底面） */
  async function sample(cam) {
    await page.evaluate(({ ox, oz, P, cam }) => {
      const g = window.__MC_GAME__;
      g.camera.up.set(...cam.up); // ⚠️ 必须避开 lookAt 退化（正下方/正上方时 up 与视线平行）
      g.camera.position.set(ox + cam.pos[0], P + cam.pos[1], oz + cam.pos[2]);
      g.camera.lookAt(ox + 0.5, P + cam.atY, oz + 0.5);
      g.camera.updateMatrixWorld();
      g.camera.updateProjectionMatrix();
    }, { ...geo, P, cam });
    await page.waitForTimeout(500);
    const png = PNG.sync.read(await page.screenshot());
    const pt = await page.evaluate(({ ox, oz, P, atY }) => {
      const g = window.__MC_GAME__;
      const v = new (g.camera.position.constructor)(ox + 0.5, P + atY, oz + 0.5);
      v.project(g.camera);
      return {
        x: Math.round((v.x * 0.5 + 0.5) * window.innerWidth),
        y: Math.round((-v.y * 0.5 + 0.5) * window.innerHeight),
      };
    }, { ...geo, P, atY: cam.atY });
    return regionLuma(png, pt.x, pt.y, 6);
  }

  const TOP_CAM = { pos: [0.5, 14, 0.5], atY: 1, up: [0, 0, -1] };
  const BOT_CAM = { pos: [0.5, -10, 0.5], atY: 0, up: [0, 0, -1] };

  const setHemi = (v) => page.evaluate((v) => {
    window.__MC_GAME__.renderWorld.materials.dayNight.uHemiGround.value = v;
  }, v);

  // 关（1.0 = 逐位回到 v1.69）
  await setHemi(1.0);
  await page.waitForTimeout(400);
  const topOff = await sample(TOP_CAM);
  const botOff = await sample(BOT_CAM);

  // 开（0.2 = 强档，仅用于把差异放大到判据可分辨；正式值 0.6 的读数另记）
  await setHemi(0.2);
  await page.waitForTimeout(400);
  const topOn = await sample(TOP_CAM);
  const botOn = await sample(BOT_CAM);

  const topRatio = topOn / topOff;
  const botRatio = botOn / botOff;
  console.log('HEMI-AMBIENT:', JSON.stringify({
    topOff: +topOff.toFixed(1), topOn: +topOn.toFixed(1), topRatio: +topRatio.toFixed(3),
    botOff: +botOff.toFixed(1), botOn: +botOn.toFixed(1), botRatio: +botRatio.toFixed(3),
  }));

  // sanity floor ①：两支读数都必须是几何（不是天空 ≈192、不是黑屏）
  expect(topOff, `顶面读数须为几何：${topOff.toFixed(1)}`).toBeGreaterThan(20);
  expect(botOff, `底面读数须为几何：${botOff.toFixed(1)}`).toBeGreaterThan(20);
  expect(topOff, `顶面读数不得到天空亮度：${topOff.toFixed(1)}`).toBeLessThan(185);
  // sanity floor ②：采到的确实是**不同**的面（否则两条判据测的是同一件事）
  expect(Math.abs(topOff - botOff),
    `顶面与底面读数须不同（证明采到了两个面）：top=${topOff.toFixed(1)} bot=${botOff.toFixed(1)}`)
    .toBeGreaterThan(5);

  // 主判据 ①：顶面只改 uHemiGround 时逐位不变（正向对照 —— 半球是纯加项）
  expect(topRatio, `顶面须恒亮（半球只作用于朝下的面）：${JSON.stringify({ topOff, topOn })}`)
    .toBeGreaterThan(0.99);
  expect(topRatio).toBeLessThan(1.01);
  // 主判据 ②：底面显著变暗（实测 ground=0.2 时约 −77%）
  expect(botRatio, `底面须显著变暗：${JSON.stringify({ botOff, botOn })}`).toBeLessThan(0.75);

  // 主判据 ③：**页面启动时的 uniform 初值**必须是 HEMI_GROUND（而不是 1）——
  // 前两条判据都是显式写 uniform 测的，所以「常量初值写错」这类缺陷它们抓不到
  // （负向验证实测：把 HEMI_GROUND 改成 1.0 后前两条仍全绿）。开新页读初值，避开本页已改过的状态。
  const page2 = await page.context().newPage();
  await page2.goto(URL);
  await page2.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  const initHemi = await page2.evaluate(() => {
    const g = window.__MC_GAME__;
    const u = g.renderWorld.materials.dayNight.uHemiGround;
    return u ? u.value : null;
  });
  await page2.close();
  expect(initHemi, 'uniform 初值须为 HEMI_GROUND=0.6（取 1 等于功能关闭，整项静默失效）').toBe(0.6);

  await page.evaluate(() => window.__MC_GAME__.popModal('tier4-hemi'));
});
