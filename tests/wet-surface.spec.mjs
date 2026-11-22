import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

// v3.31：按材质分类的湿表面 —— Tier 4 像素门。
//
// 设计稿：docs/superpowers/specs/2026-11-22-wet-surface-rebuild-design.md §9.2
//
// ## 用户报告的缺陷（本文件的第一条用例就是它的直接防线）
//
// 「为什么远处的云层和近处的岩壁上有光晕，很明显」（附两张实玩截图）。
// 根因三条（实测取证见 spec §2）：
//   ① 墙侧面 wet 实测 0.85（上游公式在 up=0 时仍给近满强度）；
//   ② 流水纹沿 y 的空间频率只有 xz 的 1/12.2 ⇒ 竖直长条亮带；
//   ③ 反射投影只对「玩家脚下那一层」成立 ⇒ 墙面/云层采到别处内容（天空暖白）；
//   ④ cloud 走 opaque 通道吃满强度湿分支 + 屏幕空间体积雾 + bloom 放大。
//
// ## 判据选型（每条都写明「缺陷态会怎样」）
//
// ⚠️ **云与岩壁必须逐位几乎不变，同时地面必须显著变** —— 两侧都要：
//    只判「云/墙不变」会被「整体没生效」蒙过（恒真）；
//    只判「地面变」会被「云/墙也一起变」蒙过（正是缺陷态）。
// ⚠️ **材质分层必须用同法线单变量**：不同法线下 N·L/菲涅尔会造出亮度差，
//    即使分类完全退化也能全绿（v3.14 已实测过这个盲区）。
// ⚠️ **不过曝判据拦「加法钳白」**：反光若写成 add 而非 mix，亮端必被 ACES 削平。

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
    g.ocean.plane.visible = false;
    g.setShadowsEnabled(false);
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

/** 注册模块内容替换（**必须在 goto 之前调**，否则注入静默失效） */
async function routeModule(page, file, transform) {
  await page.route(`**/${file}*`, async (route) => {
    const res = await route.fetch();
    const body = await res.text();
    const next = transform(body);
    if (next === body) throw new Error(`[负向对照] ${file} 的注入模式未命中 —— 注入静默失效`);
    await route.fulfill({
      response: res, body: next,
      headers: { ...res.headers(), 'content-type': 'application/javascript' },
    });
  });
}

/**
 * 造一个「云 + 岩壁 + 地面」同框的夹具，并把相机摆好。
 *
 * 几何（全部走唯一写入口 editor）：
 *   · 地面：y=P 铺 25×25 石头（玩家脚下那一层）
 *   · 岩壁：x∈[-8,8]、y∈[P+1,P+6]、z=oz-6（法线 ±Z，正对相机）
 *   · 云簇：y=P+16 的 7×7 cloud（远高于地面 ⇒ 上游那套投影必然错位）
 *   · 其余上方清空（避免既有建筑污染取样区）
 * 相机：站在墙南侧 12 格、眼高 P+3，仰角约 +0.25 ⇒ 下半屏地面、中部墙、上部云。
 */
async function buildScene(page) {
  const geo = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const ox = Math.floor(p.x); const oz = Math.floor(p.z);
    const P = Math.floor(p.y);
    const stone = g.registry.idOf('stone');
    const cloud = g.registry.idOf('cloud');
    const changes = [];
    // 清空上方（云/空岛/建筑）
    for (let y = P + 1; y <= P + 24; y++) {
      for (let dx = -14; dx <= 14; dx++) for (let dz = -14; dz <= 14; dz++) {
        if (g.world.getBlockId(ox + dx, y, oz + dz) !== 0) changes.push({ x: ox + dx, y, z: oz + dz, id: 0 });
      }
    }
    // 地面
    for (let dx = -12; dx <= 12; dx++) for (let dz = -12; dz <= 12; dz++) {
      changes.push({ x: ox + dx, y: P, z: oz + dz, id: stone });
    }
    // 岩壁（法线 ±Z）
    for (let dx = -8; dx <= 8; dx++) for (let dy = 1; dy <= 6; dy++) {
      changes.push({ x: ox + dx, y: P + dy, z: oz - 6, id: stone });
    }
    // 云簇
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
      changes.push({ x: ox + dx, y: P + 16, z: oz - 6 + dz, id: cloud });
    }
    g.editor.setBlocks(changes);
    return { ox, oz, P };
  });
  await waitWorldStable(page);
  await page.evaluate(({ ox, oz, P }) => {
    const g = window.__MC_GAME__;
    g.setStormLighting(true);
    g.renderer.setAnimationLoop(null);
    g.stormRain.setEnabled(false);      // 雨丝会污染差分 ⇒ 只量湿表面
    g.player.physics.step = () => {};
    g.camera.up.set(0, 1, 0);
    g.camera.position.set(ox + 0.5, P + 3, oz + 6.5);
    g.camera.lookAt(ox + 0.5, P + 6, oz - 6);
    g.camera.updateMatrixWorld();
    g.camera.updateProjectionMatrix();
  }, geo);
  await page.waitForTimeout(700);
  return geo;
}

/** 三个取样区（相对屏幕坐标）：云 / 墙 / 地面 */
const REGIONS = {
  cloud: [0.30, 0.02, 0.70, 0.20],
  wall: [0.30, 0.34, 0.70, 0.52],
  ground: [0.15, 0.78, 0.85, 0.97],
};

function regionDiff(on, off, [fx0, fy0, fx1, fy1]) {
  let n = 0; let changed = 0; let sumOn = 0; let sumOff = 0;
  const x0 = Math.floor(on.width * fx0); const x1 = Math.floor(on.width * fx1);
  const y0 = Math.floor(on.height * fy0); const y1 = Math.floor(on.height * fy1);
  const lum = (p, o) => 0.2126 * p.data[o] + 0.7152 * p.data[o + 1] + 0.0722 * p.data[o + 2];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * on.width + x) * 4;
      const d = Math.abs(on.data[o] - off.data[o]) + Math.abs(on.data[o + 1] - off.data[o + 1])
        + Math.abs(on.data[o + 2] - off.data[o + 2]);
      n++; if (d > 8) changed++;
      sumOn += lum(on, o); sumOff += lum(off, o);
    }
  }
  return {
    frac: +(changed / Math.max(1, n)).toFixed(4),
    lumaOn: +(sumOn / Math.max(1, n)).toFixed(1),
    lumaOff: +(sumOff / Math.max(1, n)).toFixed(1),
  };
}

/** 单变量 uWet 0↔1，返回三区读数 */
async function wetAB(page) {
  const grab = async (v) => {
    await page.evaluate((w) => {
      const g = window.__MC_GAME__;
      g.renderWorld.materials.wet.uWet.value = w;
      g.renderer.render(g.scene, g.camera);
    }, v);
    await page.waitForTimeout(260);
    return PNG.sync.read(await page.screenshot());
  };
  const off = await grab(0);
  const on = await grab(1);
  const out = {};
  for (const [k, r] of Object.entries(REGIONS)) out[k] = regionDiff(on, off, r);
  return { out, on, off };
}

test('湿表面①：云与岩壁零光晕，同时地面必须显著变湿（用户报告缺陷的直接防线）', async ({ page }) => {
  test.setTimeout(300_000);
  const errs = await BOOT(page);
  await buildScene(page);
  const { out } = await wetAB(page);
  console.log('WET ZERO-GLOW:', JSON.stringify(out));
  // 云：完全不湿（NONE 类）⇒ 逐位不变
  expect(out.cloud.frac, `云区不得被湿表面改变（缺陷态：云吃满强度湿分支 ⇒ 高空光晕）`)
    .toBeLessThan(0.02);
  // 墙：只有极弱压暗与极弱广角反光 ⇒ 变化远小于地面
  expect(out.wall.frac, '墙面变化必须远小于地面（缺陷态：竖直长条亮带）')
    .toBeLessThan(out.ground.frac * 0.5);
  // 地面：必须显著变（防「整体没生效」的恒真）
  expect(out.ground.frac, '地面必须显著变湿（0 = 湿表面根本没上屏）')
    .toBeGreaterThan(0.10);
  expect(errs, '不得有 console 错误').toEqual([]);
});

test('湿表面②：材质分层 —— 同法线单变量下反光强度按类单调', async ({ page }) => {
  test.setTimeout(300_000);
  const errs = await BOOT(page);
  const geo = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const ox = Math.floor(p.x); const oz = Math.floor(p.z); const P = Math.floor(p.y);
    const stone = g.registry.idOf('smooth_stone');
    const changes = [];
    for (let y = P + 1; y <= P + 20; y++) {
      for (let dx = -10; dx <= 10; dx++) for (let dz = -10; dz <= 10; dz++) {
        if (g.world.getBlockId(ox + dx, y, oz + dz) !== 0) changes.push({ x: ox + dx, y, z: oz + dz, id: 0 });
      }
    }
    for (let dx = -8; dx <= 8; dx++) for (let dz = -8; dz <= 8; dz++) {
      changes.push({ x: ox + dx, y: P, z: oz + dz, id: stone });
    }
    g.editor.setBlocks(changes);
    return { ox, oz, P };
  });
  await waitWorldStable(page);
  // ① 内容级判据：读真实 GPU packed 的类位（不依赖亮度）
  const cls = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const { WET_CLASS } = await import('/src/voxel/wet-material-data.js');
    const bm = g.renderWorld.meshes.opaque;
    const packed = bm.geometry.getAttribute('packed');
    const seen = new Set();
    for (let i = 0; i < packed.count; i++) seen.add((packed.getX(i) >>> 15) & 0xF);
    return {
      distinct: [...seen].sort((a, b) => a - b),
      polished: WET_CLASS.POLISHED,
      tableLen: g.renderWorld.materials.wet.uWetParams.array.length,
    };
  });
  console.log('WET CLASS ON GPU:', JSON.stringify(cls));
  expect(cls.distinct.includes(cls.polished), 'GPU 上必须真的出现 POLISHED 类位').toBe(true);
  expect(cls.tableLen, 'uniform 数组长度必须是 9').toBe(9);

  // ② 同法线单变量：同一块地面，只改 uWetParams 里 POLISHED 那一项
  await page.evaluate(({ ox, oz, P }) => {
    const g = window.__MC_GAME__;
    g.setStormLighting(true);
    g.renderer.setAnimationLoop(null);
    g.stormRain.setEnabled(false);
    g.player.physics.step = () => {};
    g.camera.up.set(0, 1, 0);
    g.camera.position.set(ox + 0.5, P + 6, oz + 6);
    g.camera.lookAt(ox + 0.5, P + 1, oz - 2);   // 俯视 45° 左右
    g.camera.updateMatrixWorld();
    g.camera.updateProjectionMatrix();
  }, geo);
  await page.waitForTimeout(700);

  const R = [0.25, 0.62, 0.75, 0.92];
  const grab = async (params) => {
    await page.evaluate((p) => {
      const g = window.__MC_GAME__;
      const U = g.renderWorld.materials.wet;
      U.uWet.value = 1;
      const v = U.uWetParams.array[1];   // POLISHED
      v.set(p[0], p[1], p[2], p[3]);
      g.renderer.render(g.scene, g.camera);
    }, params);
    await page.waitForTimeout(260);
    const png = PNG.sync.read(await page.screenshot());
    let n = 0; let sum = 0; let bright = 0;
    const x0 = Math.floor(png.width * R[0]); const x1 = Math.floor(png.width * R[2]);
    const y0 = Math.floor(png.height * R[1]); const y1 = Math.floor(png.height * R[3]);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const o = (y * png.width + x) * 4;
      const l = 0.2126 * png.data[o] + 0.7152 * png.data[o + 1] + 0.0722 * png.data[o + 2];
      n++; sum += l; if (l >= 250) bright++;
    }
    return { luma: +(sum / n).toFixed(2), over: +(bright / n).toFixed(5) };
  };
  // 从「完全不湿」到「布」到「土」到「木」到「石」到「抛光」——specGain 递增
  const ladder = {
    none: [0, 1, 1, 0],
    fabric: [1, 0.55, 0.90, 0.04],
    plant: [0.35, 0.88, 0.85, 0.05],
    soil: [1, 0.62, 0.62, 0.18],
    wood: [0.80, 0.74, 0.45, 0.35],
    stone: [0.85, 0.72, 0.35, 0.45],
    polished: [1, 0.82, 0.06, 1.00],
  };
  const r = {};
  for (const [k, p] of Object.entries(ladder)) r[k] = await grab(p);
  console.log('WET MATERIAL LADDER:', JSON.stringify(r));
  // 反光强度单调（luma 越高 = 混入的天空色越多）
  expect(r.polished.luma, '抛光 > 石').toBeGreaterThan(r.stone.luma);
  expect(r.stone.luma, '石 > 木').toBeGreaterThan(r.wood.luma);
  expect(r.wood.luma, '木 > 土').toBeGreaterThan(r.soil.luma);
  expect(r.soil.luma, '土 > 布').toBeGreaterThan(r.fabric.luma);
  expect(r.fabric.luma, '布 > 不湿').toBeGreaterThan(r.none.luma - 0.01);
  // 分类退化的反向防线：若把四类参数写成一样，上面四条会全红
  expect(errs, '不得有 console 错误').toEqual([]);
});

test('湿表面③：不过曝（反光是 mix 不是 add）', async ({ page }) => {
  test.setTimeout(300_000);
  await BOOT(page);
  await buildScene(page);
  const { on, off } = await wetAB(page);
  const overFrac = (png) => {
    let n = 0; let b = 0;
    for (let i = 0; i < png.width * png.height; i++) {
      const o = i * 4;
      const l = 0.2126 * png.data[o] + 0.7152 * png.data[o + 1] + 0.0722 * png.data[o + 2];
      n++; if (l >= 250) b++;
    }
    return b / n;
  };
  const a = overFrac(off); const b = overFrac(on);
  console.log('WET OVEREXPOSURE:', JSON.stringify({ off: +a.toFixed(5), on: +b.toFixed(5) }));
  expect(b, '开湿表面后过曝像素占比不得显著上升（缺陷态：add 在亮端钳白）')
    .toBeLessThan(a + 0.005);
});

test('湿表面④：积水斑不是轴对齐矩形（连续噪声，不是 hash(floor)）', async ({ page }) => {
  test.setTimeout(300_000);
  await BOOT(page);
  await buildScene(page);
  const { on, off } = await wetAB(page);
  // 量**效应层自身**（开−关差分）的「相邻像素差为 0 的比例」：
  // 硬格子 ⇒ 该比例极高（同一 cell 整体同值）；连续噪声 ⇒ 接近场景水平。
  const sameRate = (dx, dy) => {
    let n = 0; let same = 0;
    const x0 = Math.floor(on.width * 0.15); const x1 = Math.floor(on.width * 0.85);
    const y0 = Math.floor(on.height * 0.78); const y1 = Math.floor(on.height * 0.97);
    const d = (p, x, y) => {
      const o = (y * p.width + x) * 4;
      return (p.data[o] - off.data[o]) + (p.data[o + 1] - off.data[o + 1]) + (p.data[o + 2] - off.data[o + 2]);
    };
    for (let y = y0; y < y1 - dy; y++) for (let x = x0; x < x1 - dx; x++) {
      n++;
      if (d(on, x, y) === d(on, x + dx, y + dy)) same++;
    }
    return same / Math.max(1, n);
  };
  const sceneSame = (() => {
    let n = 0; let same = 0;
    const x0 = Math.floor(on.width * 0.15); const x1 = Math.floor(on.width * 0.85);
    const y0 = Math.floor(on.height * 0.78); const y1 = Math.floor(on.height * 0.97);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1 - 1; x++) {
      const o = (y * off.width + x) * 4; const p = o + 4;
      n++;
      if (off.data[o] === off.data[p] && off.data[o + 1] === off.data[p + 1] && off.data[o + 2] === off.data[p + 2]) same++;
    }
    return same / Math.max(1, n);
  })();
  const eff = sameRate(1, 0);
  console.log('WET PUDDLE CONTINUITY:', JSON.stringify({ eff: +eff.toFixed(4), scene: +sceneSame.toFixed(4) }));
  // 硬格子态该比例会接近 1（v3.30d 实测 82%）；连续噪声应远低于它
  expect(eff, '积水斑不得是硬格子（相邻像素差分恒等的比例过高 = 轴对齐矩形斑）')
    .toBeLessThan(0.60);
});

test('湿表面⑤：关闭后逐位回到未开启（同一 page 内单变量）', async ({ page }) => {
  test.setTimeout(300_000);
  await BOOT(page);
  await buildScene(page);
  const grab = async (v) => {
    await page.evaluate((w) => {
      const g = window.__MC_GAME__;
      g.renderWorld.materials.wet.uWet.value = w;
      g.renderer.render(g.scene, g.camera);
    }, v);
    await page.waitForTimeout(260);
    return PNG.sync.read(await page.screenshot());
  };
  const base = await grab(0);
  await grab(1);
  const back = await grab(0);
  let diff = 0;
  for (let i = 0; i < base.data.length; i++) if (base.data[i] !== back.data[i]) diff++;
  console.log('WET ZERO-REGRESSION:', JSON.stringify({ diffBytes: diff }));
  expect(diff, 'uWet 写回 0 后必须与基线逐位相同').toBe(0);
});

test('湿表面⑥：水下逐片元归零（相机在水上、片元在水下）', async ({ page }) => {
  test.setTimeout(300_000);
  const errs = await BOOT(page);
  const site = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const { computeShallowTarnAnchor } = await import('/src/gen/structures/shallow-water-tarns.js');
    const a = computeShallowTarnAnchor(g.seed);
    return a ? { x: a.wx + 0.5, z: a.wz + 0.5 } : null;
  });
  expect(site, 'seed 必须有浅水高台落点').not.toBeNull();
  await page.evaluate(([x, z]) => window.__MC_GAME__._teleportTo(x, 40, z), [site.x, site.z]);
  await page.waitForTimeout(4000);
  await waitWorldStable(page);
  const st = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const { WATER_SURFACE_Y } = await import('/src/render/water-surface.js');
    g.setStormLighting(true);
    await new Promise((r) => setTimeout(r, 1500));
    g.renderer.setAnimationLoop(null);
    g.stormRain.setEnabled(false);
    g.player.physics.step = () => {};
    const p = g.player.physics.pos;
    p.y = WATER_SURFACE_Y + 3.0;
    g.player.pitch = -0.75; g.player.yaw = 0;
    g.player.update(0.016);
    g.ocean.plane.visible = false;
    const U = g.renderWorld.materials.wet;
    return { camY: +g.camera.position.y.toFixed(3), waterY: WATER_SURFACE_Y, uWet: U.uWet.value };
  });
  console.log('WET UNDERWATER STATE:', JSON.stringify(st));
  expect(st.camY, '相机必须在水面之上（否则测的是别的情形）').toBeGreaterThan(st.waterY);
  expect(st.uWet, '总强度必须是开的（否则归零是总开关造成的，判据恒真）').toBeGreaterThan(0);
  const grab = async (waterY) => {
    await page.evaluate((wy) => {
      const g = window.__MC_GAME__;
      const U = g.renderWorld.materials.wet;
      U.uWet.value = 1;
      U.uWetWaterY.value = wy;
      g.renderer.render(g.scene, g.camera);
    }, waterY);
    await page.waitForTimeout(260);
    return PNG.sync.read(await page.screenshot());
  };
  const gated = await grab(st.waterY);
  const ungated = await grab(-1000);
  const r = regionDiff(gated, ungated, [0.15, 0.55, 0.85, 0.95]);
  console.log('WET UNDERWATER DIFF:', JSON.stringify(r));
  expect(r.frac, '水下门必须真的改变湖底像素（0 = 门没生效）').toBeGreaterThan(0.10);
  const gpuErrs = errs.filter((e) => /GPUValidationError|Invalid CommandBuffer/.test(e));
  expect(gpuErrs, `不得有 WebGPU 验证错误：${gpuErrs.slice(0, 2).join(' | ')}`).toEqual([]);
});

test('负向①：把 cloud 改成 STONE ⇒ 零光晕判据必须 FAIL', async ({ page }) => {
  test.setTimeout(300_000);
  await routeModule(page, 'wet-material-data.js', (b) => b
    .replace('  cloud: WET_CLASS.NONE,', '  cloud: WET_CLASS.STONE,'));
  await BOOT(page);
  // 注入生效确认：读回浏览器侧源码
  const injected = await page.evaluate(async () => {
    const src = await (await fetch('/src/voxel/wet-material-data.js')).text();
    return { hasOld: src.includes('cloud: WET_CLASS.STONE'), hasNew: src.includes('cloud: WET_CLASS.NONE') };
  });
  console.log('NEG-CLOUD INJECT:', JSON.stringify(injected));
  expect(injected.hasOld, '注入须真的落地').toBe(true);
  expect(injected.hasNew, '原写法须已被替换').toBe(false);
  await buildScene(page);
  const { out } = await wetAB(page);
  console.log('NEG-CLOUD ZERO-GLOW:', JSON.stringify(out));
  expect(out.cloud.frac, '注入后云区必须被改变（否则判据对缺陷零判别力）')
    .toBeGreaterThan(0.02);
});

test('负向②：把反光 mix 改成 add ⇒ 不过曝判据必须 FAIL', async ({ page }) => {
  test.setTimeout(300_000);
  await routeModule(page, 'wet-surface.js', (b) => b
    .replace('  const withSky = mix(albedo, skyEnv, reflK);',
      '  const withSky = add(albedo, skyEnv.mul(reflK.mul(6.0)));'));
  await BOOT(page);
  const injected = await page.evaluate(async () => {
    const src = await (await fetch('/src/render/wet-surface.js')).text();
    return { hasAdd: src.includes('skyEnv.mul(reflK.mul(6.0))'), hasMix: src.includes('mix(albedo, skyEnv, reflK)') };
  });
  console.log('NEG-ADD INJECT:', JSON.stringify(injected));
  expect(injected.hasAdd, '注入须真的落地').toBe(true);
  expect(injected.hasMix, '原写法须已被替换').toBe(false);
  await buildScene(page);
  const { on, off } = await wetAB(page);
  const overFrac = (png) => {
    let n = 0; let b = 0;
    for (let i = 0; i < png.width * png.height; i++) {
      const o = i * 4;
      const l = 0.2126 * png.data[o] + 0.7152 * png.data[o + 1] + 0.0722 * png.data[o + 2];
      n++; if (l >= 250) b++;
    }
    return b / n;
  };
  const a = overFrac(off); const b = overFrac(on);
  console.log('NEG-ADD OVEREXPOSURE:', JSON.stringify({ off: +a.toFixed(5), on: +b.toFixed(5) }));
  expect(b, '注入后过曝占比必须显著上升（否则判据对加法钳白零判别力）')
    .toBeGreaterThan(a + 0.005);
});