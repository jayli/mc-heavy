import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

// v3.31：雨天光影的 Tier 4 回归门（**重写**）。
//
// ## 为什么重写而不是改
//
// v3.30d/e 的三条用例分别守「远景雨幕竖纹」「体积雾世界锚定」「湿地面近中远反光」——
// 那三层已按用户 2026-11-22 裁定**整体删除**（上游湿地面 + 第二条反射 pass + 整条后处理链）。
// 根因取证见 `docs/superpowers/specs/2026-11-22-wet-surface-rebuild-design.md` §2：
//   · 岩壁竖直亮带 = 侧面 wet 实测 0.85 + 流水纹竖直拉伸 12.2× + 反射投影只对镜面那一层成立；
//   · 高空云层光晕 = cloud 走 opaque 通道吃满强度湿分支 + 屏幕空间体积雾对天空吃满额距离权重；
//   · bloom 把上面两处亮斑扩散成「光晕」。
// 新湿表面的材质分层/零光晕/不过曝判据在 `tests/wet-surface.spec.mjs`。
//
// ## 本文件保留的三条（雨本身 + 主画面完整性 + 零回归）
//
// ⚠️ 机位与噪声源冻结口径同既有 Tier 4 spec。
// ⚠️ **主画面不撕碎**这条必须留：反射 pass 与主 pass 共用 BatchedMesh 的
//    `_multiDraw*` / `_indirectTexture`，守卫漏了就会让主视锥内、反射视锥外的几何
//    整帧不绘制（v3.17 实测近黑占比 1.26% → 11.66%，而 draw call/帧时/uniform 全对）。

const BOOT = async (page, extra = '') => {
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 300)));
  await page.goto(`/?vd=4&seed=12345&skybox=0&weather=clear${extra}`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 150_000 });
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    g.dayNight.setStyle('noon');
    document.getElementById('hud-root').style.display = 'none';
  });
  return errs;
};

/** 等世界收敛（section 数连续 3 次不变）—— 只看队列瞬时归零不够 */
async function waitWorldStable(page) {
  await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    let last = -1; let stable = 0;
    for (let i = 0; i < 120 && stable < 3; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const n = g.renderWorld.slotMap.size;
      if (n === last) stable++; else { stable = 0; last = n; }
    }
  });
}

test('雨天：雨丝与水花真的画出像素（开关单变量）', async ({ page }) => {
  test.setTimeout(240_000);
  const errs = await BOOT(page);
  await waitWorldStable(page);
  await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    g.setStormLighting(true);
    await new Promise((r) => setTimeout(r, 1500));
    g.renderer.setAnimationLoop(null);
    // 湿表面归零 ⇒ 差分只量雨丝与水花（单变量）
    g.renderWorld.materials.wet.uWet.value = 0;
    g.player.pitch = 0.05; g.player.yaw = 0.4;
    g.player.update(0.016);
  });
  const grab = async (rainOn) => {
    await page.evaluate((on) => {
      const g = window.__MC_GAME__;
      g.stormRain.setEnabled(on);
      if (on) g.stormRain.update(g.player.physics.pos, 0.016, performance.now());
      g.renderer.render(g.scene, g.camera);
    }, rainOn);
    await page.waitForTimeout(250);
    return PNG.sync.read(await page.screenshot());
  };
  const off = await grab(false);
  const on = await grab(true);
  let diff = 0;
  for (let i = 0; i < on.width * on.height; i++) {
    const o = i * 4;
    const d = Math.abs(on.data[o] - off.data[o]) + Math.abs(on.data[o + 1] - off.data[o + 1])
      + Math.abs(on.data[o + 2] - off.data[o + 2]);
    if (d > 8) diff++;
  }
  const frac = diff / (on.width * on.height);
  console.log('RAIN PIXELS:', JSON.stringify({ diff, frac: +frac.toFixed(4) }));
  expect(frac, '雨丝/水花必须真的上屏（0 = 池没画出来）').toBeGreaterThan(0.002);
  expect(errs, '不得有 console 错误').toEqual([]);
});

test('雨天：主画面不被撕碎（反射 pass 与主 pass 的索引表隔离）', async ({ page }) => {
  test.setTimeout(240_000);
  await BOOT(page);
  const shot = async (stormOn) => {
    await page.evaluate(async (on) => {
      const g = window.__MC_GAME__;
      g.setStormLighting(on);
      await new Promise((r) => setTimeout(r, 1200));
      g.renderer.setAnimationLoop(null);
      g.player.pitch = 0.05;        // 平视：地平线以上的天空占大半
      g.player.update(0.016);
      g._renderWaterReflection();
      g.renderer.render(g.scene, g.camera);
    }, stormOn);
    await page.waitForTimeout(300);
    return PNG.sync.read(await page.screenshot());
  };
  const off = await shot(false);
  const on = await shot(true);
  /**
   * ⚠️⚠️ **取样区必须是「中心天空区」，不能是整条上带**（v3.30d 实测的判据坑）：
   * 机位左侧可能有建筑/地形，把它算进来会让「建筑本来就暗」被误判成撕碎。
   * 撕碎的形态是**随机多边形污染整片**（v3.17 实测近黑 1.26%→11.66%），
   * 中心天空区（x∈[0.35,0.65]、y∈[0,0.2]）在无缺陷时是纯天空 ⇒ 判别力最强。
   */
  const blackSky = (png) => {
    let n = 0; let black = 0; let sum = 0;
    const x0 = Math.floor(png.width * 0.35); const x1 = Math.floor(png.width * 0.65);
    const y1 = Math.floor(png.height * 0.2);
    for (let y = 0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * png.width + x) * 4;
        const l = 0.299 * png.data[o] + 0.587 * png.data[o + 1] + 0.114 * png.data[o + 2];
        n++; sum += l;
        if (l < 24) black++;
      }
    }
    return { frac: black / n, luma: sum / n };
  };
  const a = blackSky(off); const b = blackSky(on);
  console.log('CENTER SKY:', JSON.stringify({
    off: { frac: +a.frac.toFixed(5), luma: Math.round(a.luma) },
    on: { frac: +b.frac.toFixed(5), luma: Math.round(b.luma) },
  }));
  expect(b.frac, '中心天空区不得被撕成黑多边形').toBeLessThan(0.02);
  expect(b.luma, '中心天空必须仍亮（>120）').toBeGreaterThan(120);
});

test('雨天：关闭后零回归（雨丝/水花/湿表面全停，且无残留 pass）', async ({ page }) => {
  test.setTimeout(240_000);
  await BOOT(page);
  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    g.setStormLighting(true);
    await new Promise((res) => setTimeout(res, 1200));
    const on = {
      wet: g.renderWorld.materials.wet.uWet.value,
      streak: g.stormRain.streakMesh.visible,
    };
    g.setStormLighting(false);
    await new Promise((res) => setTimeout(res, 800));
    const off1 = {
      stormActive: g.stormLighting,
      wet: g.renderWorld.materials.wet.uWet.value,
      streak: g.stormRain.streakMesh.visible,
      splash: g.stormRain.splashMesh.visible,
      hasGrade: !!g.stormGrade,
      hasGroundReflect: !!g.groundReflect,
    };
    // Review Focus #4：关闭后再等一段，uWet 必须**恒 0**（早退路径漏写会残留）
    await new Promise((res) => setTimeout(res, 600));
    const off2 = { wet: g.renderWorld.materials.wet.uWet.value };
    return { on, off1, off2 };
  });
  console.log('STORM OFF:', JSON.stringify(r));
  expect(r.on.wet).toBeGreaterThan(0);
  expect(r.on.streak).toBe(true);
  expect(r.off1.stormActive).toBe(false);
  expect(r.off1.wet).toBe(0);
  expect(r.off1.streak).toBe(false);
  expect(r.off1.splash).toBe(false);
  expect(r.off2.wet, '关闭后 uWet 必须恒 0（不得被任何路径写回）').toBe(0);
  // 结构性防线：两条被删的子系统不得复活
  expect(r.off1.hasGrade, 'Game 不得再持有 stormGrade').toBe(false);
  expect(r.off1.hasGroundReflect, 'Game 不得再持有 groundReflect').toBe(false);
});