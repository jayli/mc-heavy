import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

// v3.33 方案 A：积水真倒影（复用 ocean 已验收的 reflector RT）—— Tier 4 像素门。
//
// 复盘：docs/retro-2026-11-23-puddle-mirror-reflection.md
//
// ## 判据选型（每条都写明缺陷态会怎样）
//
// ⚠️⚠️ **内容级判据是核心**：用户两次退回「只看到亮度增高，没看到镜面反光」。
//    亮度/Δluma 对「是不是真倒影」零判别力 ⇒ 必须量**空间对应**：
//    亮塔（红砖）正下方的地面变化必须显著大于暗塔（蓝板）正下方。
//    实测：左 ΔR −9.92 vs 右 −1.70（5.8×）。
// ⚠️ **夹具前提必须先断言**：塔区呈红/蓝特征，否则一切结论作废
//    （前 8 轮探针因先停帧循环导致画面是旧世界，全部作废）。
// ⚠️ **天空与墙面必须逐位不动**：这是用户点名要避免的两个历史缺陷。

const BOOT = async (page) => {
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 300)));
  await page.goto('/?vd=4&seed=12345&skybox=0&weather=clear');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 150_000 });
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    g.dayNight.setStyle('noon');
    document.getElementById('hud-root').style.display = 'none';
    g.setShadowsEnabled(false);
  });
  return errs;
};

/** ⚠️ 与既有 wet-surface.spec 的 waitWorldStable 同口径（循环仍在跑） */
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

/**
 * 双塔夹具：左红砖（亮）右蓝板（暗），同 z、同高。
 * ⚠️ 时序铁律：setBlocks → waitWorldStable（循环仍跑）→ 才停循环。
 * setBlocks 走 fastPath:false（Worker REMESH），提前停循环 ⇒ 回传后不发布 ⇒ 画面是旧世界。
 */
async function buildTwinTowers(page) {
  const geo = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const ox = Math.floor(p.x), oz = Math.floor(p.z), P = Math.floor(p.y);
    const pol = g.registry.idOf('smooth_stone');
    const red = g.registry.idOf('bricks');
    const blue = g.registry.idOf('blue_planks');
    const stone = g.registry.idOf('stone');
    const ch = [];
    for (let y = P + 1; y <= P + 24; y++) {
      for (let dx = -14; dx <= 14; dx++) for (let dz = -14; dz <= 22; dz++) {
        if (g.world.getBlockId(ox + dx, y, oz + dz) !== 0) ch.push({ x: ox + dx, y, z: oz + dz, id: 0 });
      }
    }
    for (let dx = -12; dx <= 12; dx++) for (let dz = -12; dz <= 20; dz++) ch.push({ x: ox + dx, y: P, z: oz + dz, id: pol });
    for (let dx = -8; dx <= -4; dx++) for (let dy = 1; dy <= 8; dy++) ch.push({ x: ox + dx, y: P + dy, z: oz - 6, id: red });
    for (let dx = 4; dx <= 8; dx++) for (let dy = 1; dy <= 8; dy++) ch.push({ x: ox + dx, y: P + dy, z: oz - 6, id: blue });
    for (let dz = -2; dz <= 6; dz++) for (let dy = 1; dy <= 5; dy++) ch.push({ x: ox - 11, y: P + dy, z: oz + dz, id: stone });
    g.editor.setBlocks(ch);
    return { ox, oz, P };
  });
  await waitWorldStable(page);
  const regions = await page.evaluate(({ ox, oz, P }) => {
    const g = window.__MC_GAME__;
    g.setStormLighting(true);
    g.renderer.setAnimationLoop(null);
    g.stormRain.setEnabled(false);
    g.player.physics.step = () => {};
    g.camera.up.set(0, 1, 0);
    const camZ = oz + 16, camY = P + 3;
    g.camera.position.set(ox + 0.5, camY, camZ);
    const pitch = 11.8 * Math.PI / 180;
    g.camera.lookAt(ox + 0.5, camY + Math.tan(pitch) * 22, camZ - 22);
    g.camera.updateMatrixWorld(); g.camera.updateProjectionMatrix();
    const V = g.camera.position.constructor;
    const box = (pts) => {
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, ok = 0;
      for (const [x, y, z] of pts) {
        const v = new V(x, y, z); v.project(g.camera);
        if (v.z > 1) continue;
        const fx = v.x * 0.5 + 0.5, fy = -v.y * 0.5 + 0.5;
        x0 = Math.min(x0, fx); x1 = Math.max(x1, fx); y0 = Math.min(y0, fy); y1 = Math.max(y1, fy); ok++;
      }
      if (ok < 4) return null;
      const mx = (x1 - x0) * 0.12, my = (y1 - y0) * 0.12;
      const c = (v) => Math.max(0.02, Math.min(0.98, v));
      return [c(x0 + mx), c(y0 + my), c(x1 - mx), c(y1 - my)];
    };
    const cs = (xa, xb, ya, yb, za, zb) => {
      const o = [];
      for (const x of [xa, xb]) for (const y of [ya, yb]) for (const z of [za, zb]) o.push([x, y, z]);
      return o;
    };
    return {
      towerL: box(cs(ox - 8, ox - 3, P + 2, P + 8, oz - 5, oz - 4.9)),
      towerR: box(cs(ox + 4, ox + 9, P + 2, P + 8, oz - 5, oz - 4.9)),
      // ★ 塔倒影落点 = 塔基正下方那一小片地面（不是近处大片地面）
      reflL: box(cs(ox - 8, ox - 4, P + 1, P + 1.01, oz - 5, oz - 2)),
      reflR: box(cs(ox + 4, ox + 8, P + 1, P + 1.01, oz - 5, oz - 2)),
      wall: box(cs(ox - 11, ox - 10.9, P + 2, P + 5, oz - 1, oz + 5)),
      sky: [0.1, 0.03, 0.9, 0.2],
    };
  }, geo);
  await page.waitForTimeout(700);
  for (const k of ['towerL', 'towerR', 'reflL', 'reflR', 'wall']) {
    if (!regions[k]) throw new Error(`[夹具] ${k} 区投影失败`);
  }
  return { ...geo, regions };
}

function stat(png, r) {
  let n = 0, R = 0, G = 0, B = 0;
  for (let y = Math.floor(png.height * r[1]); y < Math.floor(png.height * r[3]); y++)
    for (let x = Math.floor(png.width * r[0]); x < Math.floor(png.width * r[2]); x++) {
      const o = (y * png.width + x) * 4;
      n++; R += png.data[o]; G += png.data[o + 1]; B += png.data[o + 2];
    }
  return { R: R / n, G: G / n, B: B / n, n };
}

/** 逐字节差异（弱效应区域的判据，比 luma 阈值判别力高） */
function diffBytes(a, b, r) {
  let diff = 0, n = 0;
  for (let y = Math.floor(a.height * r[1]); y < Math.floor(a.height * r[3]); y++)
    for (let x = Math.floor(a.width * r[0]); x < Math.floor(a.width * r[2]); x++) {
      const o = (y * a.width + x) * 4;
      for (let c = 0; c < 3; c++) { n++; if (a.data[o + c] !== b.data[o + c]) diff++; }
    }
  return { diff, n };
}

/** 单变量 uPuddleReflect 0↔1；反射 pass 与主 render 同产品顺序 */
async function reflectAB(page) {
  const grab = async (v) => {
    await page.evaluate((s) => {
      const g = window.__MC_GAME__;
      g.renderWorld.materials.wet.uPuddleReflect.value = s;
      g._renderWaterReflection();
      g.renderer.render(g.scene, g.camera);
    }, v);
    await page.waitForTimeout(450);
    return PNG.sync.read(await page.screenshot());
  };
  return { off: await grab(0), on: await grab(1) };
}

test('真倒影①：内容级空间对应 —— 亮塔下方变化显著大于暗塔下方', async ({ page }) => {
  test.setTimeout(300_000);
  const errs = await BOOT(page);
  const scene = await buildTwinTowers(page);
  const { off, on } = await reflectAB(page);
  const tL = stat(on, scene.regions.towerL), tR = stat(on, scene.regions.towerR);
  console.log('FIXTURE:', JSON.stringify({ tL: { R: +tL.R.toFixed(1), G: +tL.G.toFixed(1) }, tR: { R: +tR.R.toFixed(1), B: +tR.B.toFixed(1) } }));
  // ★ 夹具前提：必须先证明双塔真的上屏（前 8 轮探针就是栽在这）
  expect(tL.R, '左塔须呈红砖特征 R>G（否则夹具没上屏，后续判据全部作废）').toBeGreaterThan(tL.G);
  expect(tR.B, '右塔须呈蓝板特征 B>R').toBeGreaterThan(tR.R);

  const l0 = stat(off, scene.regions.reflL), l1 = stat(on, scene.regions.reflL);
  const r0 = stat(off, scene.regions.reflR), r1 = stat(on, scene.regions.reflR);
  const dL = Math.abs(l1.R - l0.R) + Math.abs(l1.G - l0.G) + Math.abs(l1.B - l0.B);
  const dR = Math.abs(r1.R - r0.R) + Math.abs(r1.G - r0.G) + Math.abs(r1.B - r0.B);
  console.log('CONTENT CORRESPONDENCE:', JSON.stringify({ brightTowerBelow: +dL.toFixed(2), darkTowerBelow: +dR.toFixed(2), ratio: +(dL / Math.max(1e-6, dR)).toFixed(2) }));
  /**
   * ⚠️ 这是**内容级**判据：倒影若只是「整体变亮/变暗」，两侧变化会同量级（ratio≈1）；
   * 只有真的映出塔，亮塔下方才会显著大于暗塔下方。实测 5.8×，阈值取 2.5（两侧都不贴线）。
   */
  expect(dL / Math.max(1e-6, dR), '亮塔下方的倒影变化须显著大于暗塔下方（真倒影的空间对应）')
    .toBeGreaterThan(2.5);
  expect(errs.filter((e) => /GPUValidation|Invalid CommandBuffer|synchronization scope/i.test(e)),
    '不得有 WebGPU 验证错误（读写同同步域 / feedback）').toEqual([]);
});

test('真倒影②：天空与墙面逐位零污染（用户点名的两个历史缺陷）', async ({ page }) => {
  test.setTimeout(300_000);
  const errs = await BOOT(page);
  const scene = await buildTwinTowers(page);
  const { off, on } = await reflectAB(page);
  const sky = diffBytes(on, off, scene.regions.sky);
  const wall = diffBytes(on, off, scene.regions.wall);
  console.log('ZERO POLLUTION:', JSON.stringify({ sky, wall }));
  // ⚠️ 用位级判据：墙面湿强度只 0.187，luma 阈值会被 8bit 量化吞掉（本仓已记）
  expect(sky.diff, '天空必须逐字节不动（历史缺陷：撕成黑多边形 / 噪音线）').toBe(0);
  expect(wall.diff, '墙面必须逐字节不动（历史缺陷：岩壁光晕；本轮只管地面）').toBe(0);
  expect(errs.filter((e) => /GPUValidation|Invalid CommandBuffer/i.test(e))).toEqual([]);
});

test('真倒影③：uPuddleReflect=0 是第三级零回归锚点（可重复）', async ({ page }) => {
  test.setTimeout(300_000);
  const errs = await BOOT(page);
  await buildTwinTowers(page);
  const grab = async (v) => {
    await page.evaluate((s) => {
      const g = window.__MC_GAME__;
      g.renderWorld.materials.wet.uPuddleReflect.value = s;
      g._renderWaterReflection();
      g.renderer.render(g.scene, g.camera);
    }, v);
    await page.waitForTimeout(450);
    return PNG.sync.read(await page.screenshot());
  };
  const a = await grab(0);
  await grab(1);
  const b = await grab(0);
  let diff = 0;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) diff++;
  console.log('ZERO REGRESSION:', JSON.stringify({ diffBytes: diff }));
  expect(diff, '写回 0 必须与首次 0 逐位相同（无状态残留）').toBe(0);
  expect(errs.filter((e) => /GPUValidation|Invalid CommandBuffer/i.test(e))).toEqual([]);
});

test('真倒影④：关掉雨天档后逐位回到未开启（第一级锚点不被破坏）', async ({ page }) => {
  test.setTimeout(300_000);
  const errs = await BOOT(page);
  await buildTwinTowers(page);
  const grab = async (wet) => {
    await page.evaluate((w) => {
      const g = window.__MC_GAME__;
      g.renderWorld.materials.wet.uWet.value = w;
      g._renderWaterReflection();
      g.renderer.render(g.scene, g.camera);
    }, wet);
    await page.waitForTimeout(450);
    return PNG.sync.read(await page.screenshot());
  };
  const base = await grab(0);
  await grab(1);
  const back = await grab(0);
  let diff = 0;
  for (let i = 0; i < base.data.length; i++) if (base.data[i] !== back.data[i]) diff++;
  console.log('WET ZERO REGRESSION:', JSON.stringify({ diffBytes: diff }));
  expect(diff, 'uWet 写回 0 必须逐位回到基线').toBe(0);
  expect(errs.filter((e) => /GPUValidation|Invalid CommandBuffer/i.test(e))).toEqual([]);
});

test('负向：把边缘淡出与朝向门去掉 ⇒ 墙面零污染判据必须 FAIL', async ({ page }) => {
  test.setTimeout(300_000);
  // ⚠️ 注入点：puddleW 里的 topGate（真正载荷性的朝向门）
  await page.route('**/wet-surface.js*', async (route) => {
    const res = await route.fetch();
    const body = await res.text();
    const next = body.replace('  const topGate = select(isTop, float(1), float(0));',
      '  const topGate = float(1);')
      .replace('    .mul(select(isTop, float(1), float(0)))\n', '');
    if (next === body) throw new Error('[负向对照] 注入模式未命中 —— 注入静默失效');
    await route.fulfill({ response: res, body: next, headers: { ...res.headers(), 'content-type': 'application/javascript' } });
  });
  const errs = await BOOT(page);
  const injected = await page.evaluate(async () => {
    const src = await (await fetch('/src/render/wet-surface.js')).text();
    const code = src.split('\n').filter((l) => { const t = l.trim(); return t && !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*'); });
    return {
      hasPuddleGate: code.some((l) => l.includes('.mul(select(isTop, float(1), float(0)))')),
      topGateIsOne: code.some((l) => l.includes('const topGate = float(1);')),
    };
  });
  console.log('NEG INJECT:', JSON.stringify(injected));
  expect(injected.hasPuddleGate, 'puddle 的朝向门须已删除').toBe(false);
  expect(injected.topGateIsOne, 'topGate 须已改成恒 1').toBe(true);
  const scene = await buildTwinTowers(page);
  const { off, on } = await reflectAB(page);
  const wall = diffBytes(on, off, scene.regions.wall);
  console.log('NEG WALL:', JSON.stringify(wall));
  expect(wall.diff, `注入后墙面必须不再逐位不动（实测 ${wall.diff} 字节），否则判据对缺陷零判别力`)
    .toBeGreaterThan(0);
  void errs;
});