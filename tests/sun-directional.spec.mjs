import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

/**
 * Tier 4：太阳方向光（v1.58）—— 「太阳照到的面更亮、光的背面更暗」的像素级验收。
 *
 * 隔离场景：P 高度全 stone 平台 + 一堵沿 X 的墙（y ∈ [P+1, P+3]，z = oz）。
 * 相机分别从墙的 +Z 与 −Z 两侧**正视墙面**，读同一块墙面的亮度。
 * 唯一变量 = `uSunStrength`（0 = 关闭方向光，逐位回到 v1.57 的现状）。
 *
 * 判据（双侧，两处都不贴线）：
 *   ① 关闭时两面**等亮**（ratioOff ∈ [0.95, 1.05]）—— 证明读法本身无偏，②才有意义；
 *   ② 打开后迎光面显著更亮（noon 太阳 z=+0.6 → +Z 面迎光）；
 *   ③ 顶面（+Y）亮度**不随开关变化** —— 零回归不变式。
 *
 * ⚠️ **②的阈值是 sRGB 口径，且已含 ACES 与 0.38 地板（v1.70 重标）**——
 *   v1.58 记的「理论值域 1.286~1.347」是 **0.5 地板 + 无色调映射**时代的数，已作废。
 *   现在的链路是 `shade = 地板0.38 + 强度0.775×NdotL` → **ACES(exposure 1.0)** → sRGB：
 *   · 不含色调映射时线性比 = 0.845/0.38 = 2.224 → sRGB 约 1.44（实测不带 ACES 为 1.486）
 *   · ACES 对**暗端压缩更强**（暗部落在线性段、亮部先进肩部）→ 比值被推高到 **1.847**
 *   · 理论值域随贴图基色变化（基色线性 0.08 → 2.24；0.25 → 1.83；1.0 → 1.37），
 *     stone 落在 0.10~0.15 一段 → 理论 1.85~1.99，与实测 1.847 吻合
 *   区间取 **[1.20, 2.05]**：下界钉「真有朝向差异」，上界钉「对比度不失控」（实测余量 10.7%）。
 *   同坑见 `tests/test-view-bob.js` 的「屏幕读数须按 sRGB 断」。
 *
 * ⚠️ 只钉上界（或只钉下界）都是无效盲区：把 sunTerm 乘在**整个 shade**上（而非只乘太阳项）
 * 会让背光面也变暗 → 比值反而更大，单侧上界抓不到「背光面被压到地板以下」的缺陷；
 * 而 ③ 才是抓「关掉方向光不等于回到现状」的真正锚点。
 */

const URL = '/?vd=4&seed=12345&style=noon';

function regionMeanLuma(png, x, y, half) {
  let sum = 0, n = 0;
  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) {
      const px = x + dx, py = y + dy;
      if (px < 0 || py < 0 || px >= png.width || py >= png.height) continue;
      const o = (py * png.width + px) * 4;
      sum += (png.data[o] + png.data[o + 1] + png.data[o + 2]) / 3;
      n++;
    }
  }
  return sum / n;
}

async function waitWorldSettled(page) {
  await page.waitForFunction(() => window.__MC_GAME__?.scheduler?.stats().meshInflight === 0,
    null, { timeout: 60_000 });
}

test('方向光：迎光面更亮、背光面更暗；关闭时两面等亮（零回归）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(URL);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });

  const P = 80;
  const pos = await page.evaluate((P) => {
    const g = window.__MC_GAME__;
    const ox = Math.floor(g.player.physics.pos.x), oz = Math.floor(g.player.physics.pos.z);
    const stone = g.registry.idOf('stone');
    // 清平台上空 ±14（y = P+1..95）：云/空岛/建筑全部清掉 → 采样区只剩墙面
    for (let y = P + 1; y <= 95; y++) {
      for (let dx = -14; dx <= 14; dx++) for (let dz = -14; dz <= 14; dz++) {
        if (g.world.getBlockId(ox + dx, y, oz + dz) !== 0) g.editor.setBlock({ x: ox + dx, y, z: oz + dz, id: 0 });
      }
    }
    // 全 stone 平台（同一材质 → 同一贴图 tile，消除材质差异这个变量）
    for (let dx = -14; dx <= 14; dx++) for (let dz = -14; dz <= 14; dz++) {
      g.editor.setBlock({ x: ox + dx, y: P, z: oz + dz, id: stone });
    }
    // 墙：x ∈ [ox-8, ox+8]，y ∈ [P+1, P+3]，z = oz（沿 X 展开，法线 ±Z → 正对 noon 的太阳 z 分量）
    for (let dx = -8; dx <= 8; dx++) for (let dy = 1; dy <= 3; dy++) {
      g.editor.setBlock({ x: ox + dx, y: P + dy, z: oz, id: stone });
    }
    // 冻结玩家（pushModal → 帧循环跳过 player.update → 相机不会被物理挪走）
    g.pushModal('tier4-sun');
    // 隐藏全部 HUD 覆盖物（perf HUD 半透明黑底会造出假暗区）
    for (const el of document.querySelectorAll('#hud-root > *, #crosshair, #settings-btn')) el.style.display = 'none';
    return { ox, oz };
  }, P);
  await waitWorldSettled(page);

  /**
   * 把相机摆到墙的 `side` 一侧正视墙面，返回该墙面的平均亮度。
   * @param {number} side +1 = 站在 +Z 侧看 +Z 面；−1 = 站在 −Z 侧看 −Z 面
   * @param {number} strength uSunStrength 写入值（0 = 关方向光 / 1 = 满强度）
   */
  async function faceLuma(side, strength) {
    await page.evaluate(({ ox, oz, P, side, strength }) => {
      const g = window.__MC_GAME__;
      const u = g.renderWorld.materials.dayNight.uSunStrength;
      if (u) u.value = strength; // 句柄缺失 → 下面的比值断言会 FAIL（不做静默跳过）
      g.camera.up.set(0, 1, 0);
      g.camera.position.set(ox + 0.5, P + 2, oz + side * 10);
      g.camera.lookAt(ox + 0.5, P + 2, oz);
      g.camera.updateMatrixWorld();
      g.camera.updateProjectionMatrix();
    }, { ox: pos.ox, oz: pos.oz, P, side, strength });
    await page.waitForTimeout(700);
    const px = await page.evaluate(({ ox, oz, P, side }) => {
      const g = window.__MC_GAME__;
      // 采样点取墙面正中（世界坐标 z 贴墙，投影到屏幕中心）
      const v = new g.camera.position.constructor(ox + 0.5, P + 2, oz + side * 0.001);
      v.project(g.camera);
      return {
        x: Math.round((v.x * 0.5 + 0.5) * window.innerWidth),
        y: Math.round((-v.y * 0.5 + 0.5) * window.innerHeight),
      };
    }, { ox: pos.ox, oz: pos.oz, P, side });
    const png = PNG.sync.read(await page.screenshot());
    return regionMeanLuma(png, px.x, px.y, 8);
  }

  const litOff = await faceLuma(1, 0);
  const darkOff = await faceLuma(-1, 0);
  const litOn = await faceLuma(1, 1);
  const darkOn = await faceLuma(-1, 1);
  console.log('SUN-DIRECTIONAL:', JSON.stringify({
    litOff: +litOff.toFixed(1), darkOff: +darkOff.toFixed(1),
    litOn: +litOn.toFixed(1), darkOn: +darkOn.toFixed(1),
    ratioOff: +(litOff / darkOff).toFixed(3), ratioOn: +(litOn / darkOn).toFixed(3),
    // ⚠️ 字段名叫 litOnVsOff（**不是** topRatio）：它量的是迎光墙面的「开/关比」。
    // 正午 +Z 墙面的 sunTerm = 0.845 < 1.0（关闭时）→ **本字段应 < 1**，这是正确行为
    // （模型的意图是「侧面变暗、顶面不变」，零回归不变式只作用于顶面，见下方 ③）。
    // 顶面的开/关比在下方 ③ 单独量并打印为 `SUN-DIRECTIONAL TOP`（实测 1.000）。
    litOnVsOff: +(litOn / litOff).toFixed(3),
  }));

  // sanity floor：四个读数都须读到墙面几何而非黑屏/天空
  for (const [k, v] of Object.entries({ litOff, darkOff, litOn, darkOn })) {
    expect(v, `${k} 须读到墙面几何而非黑屏/天空：${v.toFixed(1)}`).toBeGreaterThan(20);
  }

  // ① 关闭方向光时两面等亮 —— 证明读法本身无偏（否则 ② 的比值可能来自采样偏差）
  expect(litOff / darkOff, `关闭方向光时 +Z/−Z 两面须等亮（读法无偏）：${litOff.toFixed(1)} vs ${darkOff.toFixed(1)}`)
    .toBeGreaterThan(0.95);
  expect(litOff / darkOff, `关闭方向光时 +Z/−Z 两面须等亮（读法无偏）：${litOff.toFixed(1)} vs ${darkOff.toFixed(1)}`)
    .toBeLessThan(1.05);

  // ② 打开后迎光面显著更亮（含 ACES 与 0.38 地板：理论 1.85~1.99，实测 1.847）。双侧：
  //    下界钉「真的有朝向差异」，上界钉「对比度不失控」。
  expect(litOn / darkOn, `迎光面须显著更亮（sRGB 理论 ~1.85）：lit=${litOn.toFixed(1)} dark=${darkOn.toFixed(1)}`)
    .toBeGreaterThan(1.2);
  expect(litOn / darkOn, `对比度不得失控（sRGB 理论 ~1.85）：lit=${litOn.toFixed(1)} dark=${darkOn.toFixed(1)}`)
    .toBeLessThan(2.05);

  // ③ 零回归不变式：顶面（+Y，dot=0.8）亮度不随开关变化 ——
  //    SUN_INTENSITY 被标定成「正午顶面 sunTerm ≡ 1.0」而不是任意值，就是为了这一条。
  //    俯视平台读顶面（平台上空已清空 → 无阴影，shadowKill=1）。
  async function topLuma(strength) {
    await page.evaluate(({ ox, oz, P, strength }) => {
      const g = window.__MC_GAME__;
      const u = g.renderWorld.materials.dayNight.uSunStrength;
      if (u) u.value = strength;
      g.camera.up.set(0, 0, -1);
      g.camera.position.set(ox + 0.5, P + 12, oz + 6);
      g.camera.lookAt(ox + 0.5, P + 1, oz + 6);
      g.camera.updateMatrixWorld();
      g.camera.updateProjectionMatrix();
    }, { ox: pos.ox, oz: pos.oz, P, strength });
    await page.waitForTimeout(700);
    const px = await page.evaluate(({ ox, oz, P }) => {
      const g = window.__MC_GAME__;
      const v = new g.camera.position.constructor(ox + 0.5, P + 1, oz + 6);
      v.project(g.camera);
      return {
        x: Math.round((v.x * 0.5 + 0.5) * window.innerWidth),
        y: Math.round((-v.y * 0.5 + 0.5) * window.innerHeight),
      };
    }, { ox: pos.ox, oz: pos.oz, P });
    const png = PNG.sync.read(await page.screenshot());
    return regionMeanLuma(png, px.x, px.y, 8);
  }
  const topOff = await topLuma(0);
  const topOn = await topLuma(1);
  console.log('SUN-DIRECTIONAL TOP:', JSON.stringify({ topOff: +topOff.toFixed(1), topOn: +topOn.toFixed(1) }));
  expect(topOff, `顶面基线须正常照亮：${topOff.toFixed(1)}`).toBeGreaterThan(20);
  expect(topOn / topOff, `顶面亮度不得随方向光开关变化（零回归）：${topOff.toFixed(1)} → ${topOn.toFixed(1)}`)
    .toBeGreaterThan(0.99);
  expect(topOn / topOff, `顶面亮度不得随方向光开关变化（零回归）：${topOff.toFixed(1)} → ${topOn.toFixed(1)}`)
    .toBeLessThan(1.01);

  await page.evaluate(() => window.__MC_GAME__.popModal('tier4-sun'));
});
