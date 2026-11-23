import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

// KV-9 枪口火光的 Tier 4 回归门（v3.30b）。
//
// 用户报告「枪口火焰是一个方块，应该是有柔光的」。根因（GPU 像素逐层取证，
// 见 pitfalls「视图模型 quad 的 uv 口径」节）：
// ① PlaneGeometry 的 position.xy 是**真实尺寸**（±0.12）而不是单位 quad ⇒
//    vUv=position*2 只到 ±0.24 ⇒ r 永远到不了边缘门 ⇒ 整片满亮；
// ② additive + HDR 在正午亮天空上必钳白（本仓 fire-ring/cinder 同一条教训）。
//
// ⚠️ v3.31：原有的两条「雨天湿地面反射」用例已删 —— 上游湿地面与第二条反射 pass
// 按用户 2026-11-22 裁定整体移除。新湿表面的判据在 `tests/wet-surface.spec.mjs`。
// 文件名保留（火光两条仍在这里，改名会动分档清单）。

const BOOT = async (page) => {
  await page.goto('/?vd=4&seed=12345&skybox=0&weather=clear');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 120_000 });
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    g.dayNight.setStyle('noon');
    document.getElementById('hud-root').style.display = 'none';
    g.ocean.plane.visible = false;
  });
};

/** 矩形内亮像素统计（fill = 亮像素/总面积；星芒应远小于 1） */
function stat(png, x0, y0, x1, y1) {
  let bright = 0; let warm = 0; let total = 0; let sr = 0; let sg = 0; let sb = 0;
  const rows = [];
  for (let y = y0; y < y1; y++) {
    let rb = 0;
    for (let x = x0; x < x1; x++) {
      const o = (y * png.width + x) * 4;
      const r = png.data[o]; const g = png.data[o + 1]; const b = png.data[o + 2];
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      total++;
      if (l > 150) { bright++; rb++; sr += r; sg += g; sb += b; }
      if (r > 140 && r > b + 30) warm++;
    }
    rows.push(rb);
  }
  const rw = rows.filter((r) => r > 0);
  return {
    bright, warm, total,
    fill: +(bright / Math.max(1, total)).toFixed(4),
    avg: bright ? [Math.round(sr / bright), Math.round(sg / bright), Math.round(sb / bright)] : null,
    rowMin: rw.length ? Math.min(...rw) : 0, rowMax: rw.length ? Math.max(...rw) : 0,
  };
}

test('KV-9 火光：是柔光星芒而不是白方块（Tier 4）', async ({ page }) => {
  test.setTimeout(200_000);
  await BOOT(page);
  const box = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    await g.selectWeapon('carbine');
    for (let i = 0; i < 60; i++) g.carbineView.update(1 / 60, { reloadT: -1, yaw: 0, pitch: 0 });
    g.renderer.setAnimationLoop(null);
    const v = g.carbineView;
    // 藏掉枪体，只量火光本身（排除枪体高光混入）
    v.gun.visible = false; v.mag.visible = false;
    v.armL.visible = false; v.armR.visible = false; v.reticle.visible = false;
    v.onShot(() => 0.5);
    v.flashUniforms.uPower.value = 1.0;
    v.flash.visible = true;
    g.renderer.render(g.scene, g.camera);
    const THREE = await import('three');
    const pts = [];
    v.flash.children.forEach((m) => {
      m.updateWorldMatrix(true, false);
      const bb = new THREE.Box3().setFromObject(m);
      for (const x of [bb.min.x, bb.max.x]) for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z]) {
        const p = new THREE.Vector3(x, y, z).project(g.camera);
        pts.push([(p.x * 0.5 + 0.5) * window.innerWidth, (-p.y * 0.5 + 0.5) * window.innerHeight]);
      }
    });
    return {
      x0: Math.max(0, Math.floor(Math.min(...pts.map((p) => p[0])))),
      y0: Math.max(0, Math.floor(Math.min(...pts.map((p) => p[1])))),
      x1: Math.min(1280, Math.ceil(Math.max(...pts.map((p) => p[0])))),
      y1: Math.min(720, Math.ceil(Math.max(...pts.map((p) => p[1])))),
      blending: v.flashMaterial.blending,
      lights: v.flashMaterial.lights,
    };
  });
  await page.waitForTimeout(250);
  const png = PNG.sync.read(await page.screenshot());
  const s = stat(png, box.x0, box.y0, box.x1, box.y1);
  console.log('FLASH FIXED:', JSON.stringify({ box, ...s }));
  // ① 不得是「整片满亮」的方块（缺陷态 fill=1.00）
  expect(s.fill, '火光不得填满整个包围盒（那是白方块）').toBeLessThan(0.85);
  // ② 必须有形状：逐行宽度差异显著（星芒/十字的行列宽窄不一）
  expect(s.rowMax, '火光必须有可见宽度').toBeGreaterThan(10);
  expect(s.rowMin / s.rowMax, '逐行宽度必须有显著变化（方块的话比值≈1）').toBeLessThan(0.8);
  // ③ 必须是暖色（火，不是白弧）—— 本仓 fire-ring/cinder 的同一条判据
  expect(s.warm, '火光必须有暖橙像素（r>140 且 r>b+30）').toBeGreaterThan(200);
  // ④ 混合模式与灯光口径（防回归）
  expect(box.blending).toBe(1);      // NormalBlending
  expect(box.lights).toBe(false);
});

test('KV-9 火光：功率衰减时火光自身像素单调减少（柔光包络）', async ({ page }) => {
  test.setTimeout(200_000);
  await BOOT(page);
  await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    await g.selectWeapon('carbine');
    for (let i = 0; i < 60; i++) g.carbineView.update(1 / 60, { reloadT: -1, yaw: 0, pitch: 0 });
    g.renderer.setAnimationLoop(null);
    const v = g.carbineView;
    v.gun.visible = false; v.mag.visible = false;
    v.armL.visible = false; v.armR.visible = false; v.reticle.visible = false;
    v.flash.visible = true;
    v.flash.children.forEach((m, i) => { m.visible = i === 0; });
  });
  // ⚠️ **量「相对无火光基线的增量」，不量绝对阈值**：
  // power<1 时 col*gain 整体变暗，绝对暖色阈值（r>140）会全部落空（实测 2325→0→0），
  // 那是阈值选错而不是包络错。正确口径：先拍 power=0 的基线，再数各功率下
  // 「相对基线变亮」的像素 —— 它只反映火光自身的覆盖与强度。
  const shot = async (p) => {
    await page.evaluate((v) => {
      const g = window.__MC_GAME__;
      g.carbineView.flashUniforms.uPower.value = v;
      g.renderer.render(g.scene, g.camera);
    }, p);
    await page.waitForTimeout(200);
    return PNG.sync.read(await page.screenshot());
  };
  const base = await shot(0);
  const counts = [];
  for (const power of [1.0, 0.6, 0.3]) {
    const png = await shot(power);
    let n = 0;
    for (let y = 369; y < 498; y++) {
      for (let x = 632; x < 761; x++) {
        const o = (y * png.width + x) * 4;
        const d = (png.data[o] - base.data[o]) + (png.data[o + 1] - base.data[o + 1]) + (png.data[o + 2] - base.data[o + 2]);
        if (d > 24) n++;
      }
    }
    counts.push(n);
  }
  console.log('FLASH ENVELOPE (delta):', JSON.stringify(counts));
  expect(counts[0]).toBeGreaterThan(counts[1]);
  expect(counts[1]).toBeGreaterThan(counts[2]);
});
