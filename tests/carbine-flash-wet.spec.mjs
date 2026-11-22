import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

// v3.30b 修复验证（用户报告的两个缺陷）：
// ① 枪口火光是「方块纸片」而不是柔光星芒；
// ② 雨天湿地面反光没呈现。
//
// 根因（GPU 像素逐层取证，见 pitfalls「视图模型 quad 的 uv 口径」与
// 「reflector.clone 的 value 不跟住真 RT」两节）：
// ① PlaneGeometry 的 position.xy 是**真实尺寸**（±0.12）而不是单位 quad ⇒
//    vUv=position*2 只到 ±0.24 ⇒ r 永远到不了边缘门 ⇒ 整片满亮；
//    且 additive + HDR 在正午亮天空上必钳白（本仓 fire-ring/cinder 同一条教训）。
// ② ReflectorNode.clone() 的 value 独立，reflector 内部只写 base.textureNode.value
//    ⇒ clone 永远停在从未渲染过的默认占位 RT ⇒ 反射项恒黑。

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

test('雨天湿地面：反射项真的改变像素（Tier 4 单变量 A/B）', async ({ page }) => {
  test.setTimeout(240_000);
  await BOOT(page);
  const st = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    g.setStormLighting(true);
    await new Promise((r) => setTimeout(r, 900));
    g.renderer.setAnimationLoop(null);
    g.player.pitch = -0.7;      // 朝下看地面（湿地面只在朝上面生效）
    g.player.update(0.016);
    // v3.30d：湿分支改用**独立地面反射**（镜面 = 玩家脚下地面）。
    // ⚠️ 不再读 ocean.reflectTexture —— 海平面镜面在几何上不可能正确（见设计稿 §10.4）。
    const gr = g.groundReflect;
    const sample = gr.texture;
    const base = gr.base;
    return {
      stormActive: g.stormLighting,
      uWet: g.renderWorld.materials.wet.uWet.value,
      // 采样节点必须已跟住地面 pass 的真 RT（不是 1×1 占位图）
      cloneIsRealRT: sample.value === base.textureNode.value,
      cloneW: sample.value?.image?.width,
      mirrorY: gr.mirrorY,
      playerY: g.player.physics.pos.y,
      refreshes: gr.refreshes,
    };
  });
  console.log('WET FIXED STATE:', JSON.stringify(st));
  expect(st.stormActive).toBe(true);
  expect(st.uWet).toBeGreaterThan(0);
  expect(st.cloneIsRealRT, '湿分支的反射节点必须指向真 RT（不是默认占位图）').toBe(true);
  expect(st.refreshes, '地面反射 pass 必须真的跑过').toBeGreaterThan(0);
  expect(Math.abs(st.mirrorY - st.playerY), '镜面必须贴玩家脚下地面').toBeLessThan(2);

  const grab = async (refl) => {
    await page.evaluate((v) => {
      const g = window.__MC_GAME__;
      g.renderWorld.materials.wet.uWet.value = 1;
      g.renderWorld.materials.wet.uWetReflect.value = v;
      g.renderWorld.materials.wet.uWetTime.value = 12.0;
      g._renderWaterReflection();
      g.renderer.render(g.scene, g.camera);
    }, refl);
    await page.waitForTimeout(220);
    return page.screenshot();
  };
  const off = await grab(0);
  const on = await grab(0.35);
  const pa = PNG.sync.read(off); const pb = PNG.sync.read(on);
  let diff = 0; let brighter = 0;
  for (let i = 0; i < pa.width * pa.height; i++) {
    const o = i * 4;
    const d = Math.abs(pa.data[o] - pb.data[o]) + Math.abs(pa.data[o + 1] - pb.data[o + 1]) + Math.abs(pa.data[o + 2] - pb.data[o + 2]);
    if (d > 12) {
      diff++;
      const la = 0.299 * pa.data[o] + 0.587 * pa.data[o + 1] + 0.114 * pa.data[o + 2];
      const lb = 0.299 * pb.data[o] + 0.587 * pb.data[o + 1] + 0.114 * pb.data[o + 2];
      if (lb > la) brighter++;
    }
  }
  const frac = diff / (pa.width * pa.height);
  console.log('WET REFLECT FIXED AB:', JSON.stringify({ diff, brighter, frac: +frac.toFixed(5) }));
  // 缺陷态 diff = 0（反射项恒黑）；修后必须显著非零
  expect(frac, '湿地面反射项必须真的改变画面（0 = 采到空 RT）').toBeGreaterThan(0.02);
  // 反射是**加项**（上游 col += refl*fres）⇒ 必须有变亮的像素
  expect(brighter, '反射必须让部分地面变亮（镜面高光）').toBeGreaterThan(1000);
});

test('雨天湿地面：关闭雨天档后反射节点不再影响画面（零回归）', async ({ page }) => {
  test.setTimeout(240_000);
  await BOOT(page);
  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    g.setStormLighting(true);
    await new Promise((res) => setTimeout(res, 700));
    g.setStormLighting(false);
    await new Promise((res) => setTimeout(res, 500));
    return {
      uWet: g.renderWorld.materials.wet.uWet.value,
      stormActive: g.stormLighting,
    };
  });
  console.log('WET OFF:', JSON.stringify(r));
  expect(r.stormActive).toBe(false);
  expect(r.uWet).toBe(0);
});