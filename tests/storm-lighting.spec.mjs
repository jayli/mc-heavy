import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';
import { STORM_AUDIO } from '../src/render/storm-rain-config.js';
import { RAIN } from '../src/render/weather.js';

/** 雨天档雨声音量（从运行时代码 import —— 不在 spec 里写第二份字面量） */
const STORM_RAIN_VOLUME = STORM_AUDIO.rainVolume;
/** 天气雨声满强度音量（`RAIN.SOUND_VOLUME` 是唯一权威） */
const RAIN_WEATHER_VOLUME = RAIN.SOUND_VOLUME;

// v3.30 雨天光影档：开关接线 / 持续雨上屏 / 室内不生效 / 树叶云空岛不拦 /
// 高度不超云层 / 湿地面反光 / 后处理链 / 雨声切换 / 关闭时零回归。
//
// ⚠️ 机位与噪声源冻结口径同既有 Tier 4 spec：?skybox=0 固定纯色天空、
// dayNight.setStyle('noon') 停日夜推进、隐藏 HUD、藏海面。

const BOOT = async (page, extra = '') => {
  await page.goto(`/?vd=4&seed=12345&skybox=0&weather=clear${extra}`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 120_000 });
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    g.dayNight.setStyle('noon');
    document.getElementById('hud-root').style.display = 'none';
    g.ocean.plane.visible = false;
  });
};

/** 两 PNG 的逐像素差分数（RGB 任一通道差 >16 记 1 像素） */
function diffPixels(a, b) {
  const pa = PNG.sync.read(a); const pb = PNG.sync.read(b);
  expect(pa.width).toBe(pb.width);
  expect(pa.height).toBe(pb.height);
  let n = 0;
  for (let i = 0; i < pa.width * pa.height; i++) {
    const o = i * 4;
    if (Math.abs(pa.data[o] - pb.data[o]) > 16
      || Math.abs(pa.data[o + 1] - pb.data[o + 1]) > 16
      || Math.abs(pa.data[o + 2] - pb.data[o + 2]) > 16) n++;
  }
  return n;
}

test('雨天光影：面板开关在瞬移行下方，点击后生效并持久化', async ({ page }) => {
  test.setTimeout(200_000);
  await BOOT(page);
  const r = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    // ⚠️ BOOT 隐藏了 #hud-root ⇒ offsetTop/scrollHeight 全 0（本轮实测）。
    // 量布局前必须临时显形，量完再隐回去。
    const hud = document.getElementById('hud-root');
    const prevDisplay = hud.style.display;
    hud.style.display = '';
    const panel = g.settingsPanel;
    panel.open();
    const teleport = document.querySelector('.mc-teleport');
    const stormRow = [...document.querySelectorAll('#settings-panel-main .mc-item')]
      .find((el) => el.querySelector('.mc-title')?.textContent === '雨天光影');
    const btns = stormRow ? [...stormRow.querySelectorAll('button')].map((b) => b.textContent) : [];
    // 落位：同一列内、雨天王行的 offsetTop 必须大于瞬移行
    const sameColumn = stormRow && teleport ? stormRow.parentElement === teleport.parentElement : null;
    const order = stormRow && teleport ? stormRow.offsetTop > teleport.offsetTop : null;
    // 面板不得出现纵向滚动条（三处冻结断言之一）
    const content = document.querySelector('#settings-modal .mc-content');
    const scroll = { h: content.scrollHeight, c: content.clientHeight };
    const before = g.stormLighting;
    // 点「开启」
    const onBtn = [...stormRow.querySelectorAll('button')].find((b) => b.textContent === '开启');
    onBtn.click();
    const after = g.stormLighting;
    const stored = JSON.parse(localStorage.getItem('mc_heavy_settings_v1') || '{}');
    panel.close();
    hud.style.display = prevDisplay;
    return { btns, order, sameColumn, scroll, before, after, storedStorm: stored.stormLighting, hasRow: !!stormRow };
  });
  console.log('STORM PANEL:', JSON.stringify(r));
  expect(r.hasRow).toBe(true);
  expect(r.btns).toEqual(['关闭', '开启']);
  expect(r.sameColumn).toBe(true);
  expect(r.order).toBe(true);
  expect(r.scroll.h, '面板内容不得溢出（出现纵向滚动条 = 高度涨了一档）')
    .toBeLessThanOrEqual(r.scroll.c + 1);
  expect(r.before).toBe(false);
  expect(r.after).toBe(true);
  expect(r.storedStorm).toBe(true);
});

test('雨天光影：持续雨上屏（雨丝 + 水花），且循环雨滴被关掉', async ({ page }) => {
  test.setTimeout(200_000);
  await BOOT(page);
  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const before = {
      stormActive: g.stormLighting,
      oldRainVisible: g.rain.lines.visible,
      drawCalls: g.renderStats().drawCalls,
    };
    g.setStormLighting(true);
    // 推进几帧让雨丝/水花生成
    await new Promise((res) => setTimeout(res, 800));
    const st = g.stormRain.debugState();
    return {
      before,
      after: {
        stormActive: g.stormLighting,
        oldRainVisible: g.rain.lines.visible,
        oldRainOpacity: g.rain.uniforms.uOpacity.value,
        drawCalls: g.renderStats().drawCalls,
      },
      storm: st,
      wet: g.renderWorld.materials.wet.uWet.value,
    };
  });
  console.log('STORM ON:', JSON.stringify(r));
  expect(r.after.stormActive).toBe(true);
  // 用户：「默认把我现在的循环雨滴装下雨的特效关掉」
  expect(r.after.oldRainVisible).toBe(false);
  expect(r.after.oldRainOpacity).toBe(0);
  // 持续雨两个 mesh 都上屏
  expect(r.storm.streakVisible).toBe(true);
  expect(r.storm.splashVisible).toBe(true);
  expect(r.storm.capacity).toBeGreaterThan(1000);
  // 湿表面接线（v3.31：不再有后处理链）
  expect(r.wet).toBeGreaterThan(0);
});

test('雨天光影：雨丝真的画出像素（Tier 4 差分，开关单变量）', async ({ page }) => {
  test.setTimeout(240_000);
  await BOOT(page);
  // 关：基线
  await page.evaluate(() => { window.__MC_GAME__.setStormLighting(false); });
  await page.waitForTimeout(700);
  const off = await page.screenshot();
  // 开：只改这一个变量
  await page.evaluate(() => { window.__MC_GAME__.setStormLighting(true); });
  await page.waitForTimeout(1200);
  const on = await page.screenshot();
  const diff = diffPixels(off, on);
  const total = PNG.sync.read(on).width * PNG.sync.read(on).height;
  const ratio = diff / total;
  console.log('STORM PIXELS:', JSON.stringify({ diff, total, ratio: +ratio.toFixed(4) }));
  // 雨丝 + 水花 + 湿表面 ⇒ 差异必须显著（不是零）
  expect(ratio, '开启雨天档后画面必须有显著变化（零差异 = 雨与湿表面都没上屏）')
    .toBeGreaterThan(0.01);
});

test('雨天光影：室内逐点遮挡（棚下干、棚外湿，屋外雨仍上屏）', async ({ page }) => {
  test.setTimeout(300_000);
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 300)));
  await BOOT(page);

  /**
   * 夹具（spec §5 Tier 4）：抛光石地面一半盖屋顶、一半露天，
   * 相机在屋内朝门口方向 ⇒ 屋内地面 / 屋外地面 / 屋顶顶面 同帧入画。
   *
   * ⚠️ 取样区由**真实投影**算出（照 wet-surface.spec 口径），不写死屏幕坐标。
   * ⚠️ 五个动态源全冻（玩家下落 / 海面 / 手臂 / 昼夜 / viewBob+stepLift）。
   */
  const scene = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const ox = Math.floor(p.x); const oz = Math.floor(p.z); const P = Math.floor(p.y);
    const polished = g.registry.idOf('smooth_stone');
    const roofId = g.registry.idOf('stone_bricks');
    const ch = [];
    // 清空上方（云/空岛/建筑/树）
    for (let y = P + 1; y <= P + 24; y++) {
      for (let dx = -16; dx <= 16; dx++) for (let dz = -16; dz <= 16; dz++) {
        if (g.world.getBlockId(ox + dx, y, oz + dz) !== 0) ch.push({ x: ox + dx, y, z: oz + dz, id: 0 });
      }
    }
    // 地面：25×25 抛光石（POLISHED 类，水汪信号最强）
    for (let dx = -12; dx <= 12; dx++) for (let dz = -12; dz <= 12; dz++) {
      ch.push({ x: ox + dx, y: P, z: oz + dz, id: polished });
    }
    // 屋顶：只盖**北侧**（z ≤ oz-2），7 格高 ⇒ 南侧露天
    const ROOF_Y = P + 5;
    for (let dx = -6; dx <= 6; dx++) for (let dz = -10; dz <= -2; dz++) {
      ch.push({ x: ox + dx, y: ROOF_Y, z: oz + dz, id: roofId });
    }
    g.editor.setBlocks(ch);
    return { ox, oz, P, ROOF_Y };
  });
  await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    let last = -1; let stable = 0;
    for (let i = 0; i < 120 && stable < 3; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const n = g.renderWorld.slotMap.size;
      if (n === last) stable++; else { stable = 0; last = n; }
    }
  });

  // ---- C1/C2：玩家站屋内，屋外雨丝必须仍可见；屋顶正下方必须无雨 ----
  const drops = await page.evaluate(async ({ ox, oz, P }) => {
    const g = window.__MC_GAME__;
    g.setStormLighting(true);
    // 玩家站在屋顶正下方（屋内）
    g.player.physics.pos.x = ox + 0.5;
    g.player.physics.pos.y = P + 1;
    g.player.physics.pos.z = oz - 6 + 0.5;
    g.player.yaw = Math.PI; g.player.pitch = -0.15;   // 朝南（露天那半）
    g.player.update(0.016);
    await new Promise((r) => setTimeout(r, 1600));
    const st = g.stormRain.debugState();
    // 读真实 GPU 属性：逐滴算世界位置与 fade（与 mesher 同式）
    const geo = g.stormRain.streakGeo;
    const seed = geo.getAttribute('aSeed');
    const minY = geo.getAttribute('aMinY');
    const sh = geo.getAttribute('aShelter');
    const { STORM_STREAK: ST } = await import('/src/render/storm-rain-config.js');
    const c = g.stormRain._center;
    const t = g.stormRain._time;
    const half = [ST.box[0] / 2, ST.box[1] / 2, ST.box[2] / 2];
    const mod = (x, m) => ((x % m) + m) % m;
    const fract = (x) => x - Math.floor(x);
    let underRoofVisible = 0; let outsideVisible = 0; let total = 0;
    for (let i = 0; i < geo.instanceCount; i++) {
      const sx = seed.getX(i); const sy = seed.getY(i); const sz = seed.getZ(i);
      const sp = ST.speedMin + ST.speedRange * fract(sx * 7.31 + sz * 3.17);
      const wx = mod(sx * ST.box[0] + ST.vel[0] * t - c.x + half[0], ST.box[0]) - half[0] + c.x;
      const wy = mod(sy * ST.box[1] - ST.vel[1] * sp * t - c.y + half[1], ST.box[1]) - half[1] + c.y;
      const wz = mod(sz * ST.box[2] + ST.vel[2] * t - c.z + half[2], ST.box[2]) - half[2] + c.z;
      // 该滴是否可见（与 GPU 同式）。
      // ⚠️ v3.34：遮挡门已改成**逐顶点按当前 xz 采高度图**（与湿表面同构）：
      // 任何 CPU 预采的逐滴列级量（aMinY/aShelter）都跟不上 1.6 格/s 的水平飘移。
      // ⇒ 判据必须读**同一张高度图**在**滴的当前位置**的值，否则测的是旧量。
      const sm = g.rainShelterMap;
      const stopNow = sm.stopAt(wx, wz);
      const shelteredNow = stopNow !== null && stopNow > Math.floor(wy) + 1 + 1 / 512;
      const vis = wy >= minY.getX(i) && !shelteredNow;
      if (!vis) continue;
      total++;
      // 屋顶覆盖区：x ∈ [ox-6,ox+7)、z ∈ [oz-10,oz-1)、y < ROOF_Y
      const inRoofCol = wx >= ox - 6 && wx < ox + 7 && wz >= oz - 10 && wz < oz - 1;
      if (inRoofCol && wy < P + 5) underRoofVisible++;
      else outsideVisible++;
    }
    return {
      underRoof: st.underRoof, streakVisible: st.streakVisible,
      underRoofVisible, outsideVisible, total,
    };
  }, scene);
  console.log('SHELTER DROPS:', JSON.stringify(drops));
  expect(drops.underRoof, '前置：玩家确实在屋顶下').toBe(true);
  // ★ C1：这是用户报告的原缺陷 —— 旧实现在这里两个 mesh 直接 visible=false
  expect(drops.streakVisible, 'C1 玩家在屋内时雨丝 mesh 必须仍上屏（总闸已删）').toBe(true);
  expect(drops.outsideVisible, 'C1 屋外必须有可见雨滴（0 = 屋内看不见外面的雨）')
    .toBeGreaterThan(0);
  // ★ C2：只删总闸不改扫描起点 ⇒ 这里非零
  expect(drops.underRoofVisible, 'C2 屋顶正下方不得有可见雨滴').toBe(0);

  // ---- C3~C7：湿表面三态取样（冻帧循环 + 手动 render）----
  const regions = await page.evaluate(({ ox, oz, P, ROOF_Y }) => {
    const g = window.__MC_GAME__;
    g.renderer.setAnimationLoop(null);
    g.stormRain.setEnabled(false);          // 量湿表面时关雨（单变量）
    g.player.physics.step = () => {};
    if (g.player?.viewBob?.update) g.player.viewBob.update = () => {};
    if (g.player?._stepLift?.update) g.player._stepLift.update = () => {};
    if (g.viewArm?.mesh) g.viewArm.mesh.visible = false;
    if (g.viewWeapon?.node) g.viewWeapon.node.visible = false;
    if (g.dayNight?.update) g.dayNight.update = () => {};
    g.ocean.plane.visible = false;
    g.setShadowsEnabled(false);
    // 机位：**南侧远处压低平视**（P+2.0，oz+12）往北微仰。
    // ⚠️ 机位由**真实投影实测选定**，不凭直觉：五个候选机位里只有它
    // 能让「屋顶下地面 + 露天地面 + 屋顶顶面」三区**同时非退化**。
    // （相机放屋顶内往下看 ⇒ indoor 退化成零面积区 n=0，C3/C4 恒真；
    //   抬高俯视 ⇒ outdoor 退化。均已实测。）
    g.camera.up.set(0, 1, 0);
    g.camera.position.set(ox + 0.5, P + 2.0, oz + 12);
    g.camera.lookAt(ox + 0.5, P + 2.6, oz - 8);
    g.camera.updateMatrixWorld();
    g.camera.updateProjectionMatrix();
    const V = g.camera.position.constructor;
    const box = (pts) => {
      let x0 = 1e9; let x1 = -1e9; let y0 = 1e9; let y1 = -1e9; let ok = 0;
      for (const [x, y, z] of pts) {
        const v = new V(x, y, z); v.project(g.camera);
        if (v.z > 1) continue;
        const fx = v.x * 0.5 + 0.5; const fy = -v.y * 0.5 + 0.5;
        x0 = Math.min(x0, fx); x1 = Math.max(x1, fx);
        y0 = Math.min(y0, fy); y1 = Math.max(y1, fy); ok++;
      }
      if (ok < 4) return null;
      const mx = (x1 - x0) * 0.2; const my = (y1 - y0) * 0.2;
      const c = (v) => Math.max(0.02, Math.min(0.98, v));
      return [c(x0 + mx), c(y0 + my), c(x1 - mx), c(y1 - my)];
    };
    const corners = (xa, xb, ya, yb, za, zb) => {
      const out = [];
      for (const x of [xa, xb]) for (const y of [ya, yb]) for (const z of [za, zb]) out.push([x, y, z]);
      return out;
    };
    return {
      // 屋内地面：屋顶正下方（北侧），从南远处低角度看得到
      indoor: box(corners(ox - 4, ox + 5, P + 1, P + 1.01, oz - 9, oz - 3)),
      // 屋外地面：屋顶南沿之外（南侧，近）
      outdoor: box(corners(ox - 4, ox + 5, P + 1, P + 1.01, oz + 2, oz + 8)),
      // 屋顶自身顶面（它确实淋到雨 ⇒ 门不得碰它，G4）
      roof: box(corners(ox - 5, ox + 6, ROOF_Y + 1, ROOF_Y + 1.01, oz - 9, oz - 3)),
      ROOF_Y,
    };
  }, scene);
  console.log('SHELTER REGIONS:', JSON.stringify(regions));
  expect(regions.indoor, '前置：屋内地面取样区必须入画').not.toBeNull();
  expect(regions.outdoor, '前置：屋外地面取样区必须入画').not.toBeNull();
  expect(regions.roof, '前置：屋顶顶面取样区必须入画').not.toBeNull();
  // ⚠️ **非退化前置**：投影退化时 box 会钐成 [0.02,0.98,0.98,0.98]（零面积）
  // ⇒ 区内 n=0 ⇒ 所有判据恒真。必须当场抓下。
  for (const k of ['indoor', 'outdoor', 'roof']) {
    const r = regions[k];
    expect(r[2] - r[0], `${k} 取样区宽度不得为 0`).toBeGreaterThan(0.02);
    expect(r[3] - r[1], `${k} 取样区高度不得为 0`).toBeGreaterThan(0.002);
  }

  const grab = async (wet, shelter) => {
    await page.evaluate(({ w, s }) => {
      const g = window.__MC_GAME__;
      const U = g.renderWorld.materials.wet;
      U.uWet.value = w;
      U.uWetShelter.value = s;
      U.uPuddleReflect.value = 0;      // 关真倒影（单变量：只量程序化湿分支）
      g.renderer.render(g.scene, g.camera);
    }, { w: wet, s: shelter });
    await page.waitForTimeout(260);
    return PNG.sync.read(await page.screenshot());
  };
  const dry = await grab(0, 1);
  const gated = await grab(1, 1);
  const ungated = await grab(1, 0);
  const gated2 = await grab(1, 0);      // C7：二次取样与首次 0 逐位相同

  const bytes = (a, b, r) => {
    const x0 = Math.floor(a.width * r[0]); const x1 = Math.floor(a.width * r[2]);
    const y0 = Math.floor(a.height * r[1]); const y1 = Math.floor(a.height * r[3]);
    let diff = 0; let n = 0; let sumA = 0; let sumB = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const o = (y * a.width + x) * 4;
      for (let c = 0; c < 3; c++) { n++; if (a.data[o + c] !== b.data[o + c]) diff++; }
      sumA += 0.2126 * a.data[o] + 0.7152 * a.data[o + 1] + 0.0722 * a.data[o + 2];
      sumB += 0.2126 * b.data[o] + 0.7152 * b.data[o + 1] + 0.0722 * b.data[o + 2];
    }
    const px = Math.max(1, n / 3);
    return { diff, n, frac: +(diff / Math.max(1, n)).toFixed(6), dLuma: +((sumA - sumB) / px).toFixed(2) };
  };
  const out = {
    indoorDryVsGated: bytes(gated, dry, regions.indoor),
    indoorGateEffect: bytes(gated, ungated, regions.indoor),
    outdoorGateEffect: bytes(gated, ungated, regions.outdoor),
    roofGateEffect: bytes(gated, ungated, regions.roof),
    repeatZero: bytes(ungated, gated2, regions.outdoor),
  };
  console.log('SHELTER WET AB:', JSON.stringify(out));
  // C3：屋内地面本来就干 ⇒ gated 与 dry 几乎无差
  expect(out.indoorDryVsGated.frac, 'C3 棚下地面 gating 后应与全干基线几乎一致')
    .toBeLessThan(0.02);
  // C4：门必须真的作用在屋内地面（恒 0 的门 ⇒ 零差）
  expect(out.indoorGateEffect.frac, 'C4 遮挡门必须真的把屋内地面变干（0 = 门没接线）')
    .toBeGreaterThan(0.10);
  // C5：屋外地面 —— 门一个字节都不许碰（探针没法线偏移 ⇒ 非零）
  expect(out.outdoorGateEffect.diff, 'C5 屋外地面必须逐字节不变（门爬到露天上了）').toBe(0);
  // C6：屋顶自身顶面 —— 它确实淋到雨（G4），门不得碰
  expect(out.roofGateEffect.diff, 'C6 屋顶顶面必须逐字节不变（门爬到屋顶自己上了）').toBe(0);
  // C7：关档可重复，无状态残留
  expect(out.repeatZero.diff, 'C7 uWetShelter=0 二次取样必须逐位相同').toBe(0);

  // ---- 编辑往返：挖掉屋顶 ⇒ 屋内地面变湿 ----
  const editRound = await page.evaluate(async ({ ox, oz, ROOF_Y }) => {
    const g = window.__MC_GAME__;
    const ch = [];
    for (let dx = -6; dx <= 6; dx++) for (let dz = -10; dz <= -2; dz++) {
      ch.push({ x: ox + dx, y: ROOF_Y, z: oz + dz, id: 0 });
    }
    g.editor.setBlocks(ch);
    // 推进扫描（编辑插队首 + 每帧 8 column）
    const map = g.rainShelterMap;
    for (let i = 0; i < 40; i++) map.tick(8);
    return { queued: map.debugState().queued };
  }, scene);
  console.log('SHELTER EDIT:', JSON.stringify(editRound));
  const noRoofGated = await grab(1, 1);
  const noRoofUngated = await grab(1, 0);
  const afterEdit = bytes(noRoofGated, noRoofUngated, regions.indoor);
  console.log('SHELTER AFTER DIG:', JSON.stringify(afterEdit));
  expect(afterEdit.diff, '挖掉屋顶后屋内地面必须恢复湿（门与关档逐字节相同）').toBe(0);

  const gpuErrs = errs.filter((e) => /GPUValidationError|Invalid CommandBuffer/.test(e));
  expect(gpuErrs, `C8 不得有 WebGPU 验证错误：${gpuErrs.slice(0, 2).join(' | ')}`).toEqual([]);
});

test('雨天光影：树叶 / 云 / 空岛都不拦雨，雨幕高度不超云层', async ({ page }) => {
  test.setTimeout(240_000);
  await BOOT(page);
  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const { RAIN_CEILING_Y, blocksRain } = await import('/src/render/rain-shelter.js');
    const { CLOUD_CLUSTER_Y, SINGLE_CLOUD_Y } = await import('/src/gen/structures/sky-structures.js');
    g.setStormLighting(true);
    await new Promise((res) => setTimeout(res, 500));
    const p = g.player.physics.pos;
    const bx = Math.floor(p.x); const bz = Math.floor(p.z);
    // ① 头顶堆树叶 ⇒ 仍应下雨
    const leaves = g.registry.idOf('leaves');
    const ch = [];
    for (let y = Math.floor(p.y) + 3; y <= Math.floor(p.y) + 7; y++) {
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) ch.push({ x: bx + dx, y, z: bz + dz, id: leaves });
    }
    g.editor.setBlocks(ch);
    await new Promise((res) => setTimeout(res, 600));
    const underLeaves = { ...g.stormRain.debugState() };
    // ② 判据级：云与空岛材料
    const cloudBlocks = blocksRain(g.registry.idOf('cloud'), g.registry);
    const stoneBlocks = blocksRain(g.registry.idOf('stone'), g.registry);
    const leavesBlocks = blocksRain(leaves, g.registry);
    return {
      underLeaves, cloudBlocks, stoneBlocks, leavesBlocks,
      ceilingY: RAIN_CEILING_Y, cloudClusterY: CLOUD_CLUSTER_Y, singleCloudY: SINGLE_CLOUD_Y,
      stormCenterY: g.stormRain.debugState().centerY,
      boxHeight: 18,
    };
  });
  console.log('STORM SHELTER:', JSON.stringify(r));
  // 树叶不拦：站在树下仍下雨
  expect(r.underLeaves.underRoof).toBe(false);
  expect(r.underLeaves.streakVisible).toBe(true);
  // 判据级
  expect(r.cloudBlocks).toBe(false);
  expect(r.leavesBlocks).toBe(false);
  expect(r.stoneBlocks).toBe(true);
  // 高度：雨幕盒顶不得高于最低云层
  expect(r.ceilingY).toBeLessThan(r.cloudClusterY);
  expect(r.ceilingY).toBeLessThan(r.singleCloudY);
  expect(r.stormCenterY + r.boxHeight / 2).toBeLessThanOrEqual(r.ceilingY);
});

test('雨天光影：玩家飞到云上时雨幕不跟着上去', async ({ page }) => {
  test.setTimeout(240_000);
  await BOOT(page);
  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const { RAIN_CEILING_Y } = await import('/src/render/rain-shelter.js');
    g.setStormLighting(true);
    await new Promise((res) => setTimeout(res, 400));
    const low = g.stormRain.debugState().centerY;
    // 把玩家抬到云上（走物理位置，与瞬移同口径）
    g.player.physics.pos.y = 80;
    await new Promise((res) => setTimeout(res, 500));
    const high = g.stormRain.debugState().centerY;
    return { low, high, ceiling: RAIN_CEILING_Y, boxHeight: 18 };
  });
  console.log('STORM CEILING:', JSON.stringify(r));
  // ⚠️ 判据是**盒顶不超上界**，不是「盒心不动」：玩家从 y=22 飞到 80 时，
  // 盒心会从 22 抬到 25（= 34 − 18/2）然后**钳住不再跟**。写「盒心不动」是错的
  // （低空时盒心本来就该跟着玩家）。
  expect(r.high + r.boxHeight / 2).toBeLessThanOrEqual(r.ceiling);
  expect(r.high).toBe(r.ceiling - r.boxHeight / 2);   // 恰好钳在上界下
  expect(r.high).toBeLessThan(80);                    // 没跟着飞到 80
});

test('雨天光影：关闭后逐位回到改动前（雨丝/水花/湿表面全关）', async ({ page }) => {
  test.setTimeout(240_000);
  await BOOT(page);
  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    g.setStormLighting(true);
    await new Promise((res) => setTimeout(res, 600));
    const on = {
      streak: g.stormRain.streakMesh.visible,
      wet: g.renderWorld.materials.wet.uWet.value,
      drawCalls: g.renderStats().drawCalls,
    };
    g.setStormLighting(false);
    await new Promise((res) => setTimeout(res, 600));
    const off = {
      streak: g.stormRain.streakMesh.visible,
      splash: g.stormRain.splashMesh.visible,
      wet: g.renderWorld.materials.wet.uWet.value,
      drawCalls: g.renderStats().drawCalls,
      stormActive: g.stormLighting,
    };
    return { on, off };
  });
  console.log('STORM OFF:', JSON.stringify(r));
  expect(r.on.streak).toBe(true);
  expect(r.on.wet).toBeGreaterThan(0);
  expect(r.off.stormActive).toBe(false);
  expect(r.off.streak).toBe(false);
  expect(r.off.splash).toBe(false);
  expect(r.off.wet).toBe(0);
});

test('雨天光影：雨声换成上游雨床，且与既有 rain 互斥', async ({ page }) => {
  test.setTimeout(200_000);
  await BOOT(page);
  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const am = g.audioManager;
    g.setStormLighting(true);
    await new Promise((res) => setTimeout(res, 600));
    const on = am.debugLoops();
    g.setStormLighting(false);
    await new Promise((res) => setTimeout(res, 400));
    const off = am.debugLoops();
    return { on, off };
  });
  console.log('STORM AUDIO:', JSON.stringify(r));
  // ⚠️ debugLoops 的字段是 {playing, volume, target}（不是 wanted）——
  // 停掉的循环**整个键消失**。
  // v3.36：雨天档雨声改用既有 rain.mp3（用户 2026-11-24 裁定）⇒ **只有一个键**，
  // 不再有 rain_storm。判据必须钉**音量**而不只是 playing：
  // 同一个循环实例在两种档位下都在播，忘了写音量的形态是「开了雨天档但雨声没变大」。
  expect(r.on.rain_storm, 'v3.36 起 rain_storm 不再被启播').toBeUndefined();
  expect(r.on.rain).toBeTruthy();
  expect(r.on.rain.playing).toBe(true);
  expect(r.on.rain.target, '开启时音量 = 雨天档值').toBeCloseTo(STORM_RAIN_VOLUME, 2);
  // 关闭：音量回到天气驱动值（晴天 ⇒ 不在播）
  expect(r.off.rain_storm, 'v3.36 起 rain_storm 不再被启播').toBeUndefined();
  if (r.off.rain) {
    expect(r.off.rain.target, '关档后音量回到天气值')
      .toBeLessThanOrEqual(RAIN_WEATHER_VOLUME + 1e-6);
  }
});

test('雨天光影：性能档雨丝减半（v3.31：bloom 已删，不再有级数）', async ({ page }) => {
  test.setTimeout(240_000);
  await BOOT(page);
  const r = await page.evaluate(async () => {
    const { stormStreakCount } = await import('/src/render/storm-rain-config.js');
    const gradeGone = await import('/src/render/storm-grade-config.js')
      .then(() => false).catch(() => true);
    return {
      sharpCount: stormStreakCount('sharp'),
      perfCount: stormStreakCount('performance'),
      gradeGone,
      hasGrade: !!window.__MC_GAME__.stormGrade,
    };
  });
  console.log('STORM PERF:', JSON.stringify(r));
  expect(r.perfCount).toBeLessThan(r.sharpCount);
  expect(r.perfCount).toBe(Math.floor(r.sharpCount / 2));
  // 结构性防线：后处理链已整体删除（防将来凭直觉补齐而让高空光晕复活）
  expect(r.gradeGone, 'storm-grade-config.js 必须已删除').toBe(true);
  expect(r.hasGrade, 'Game 不得再持有 stormGrade').toBe(false);
});
