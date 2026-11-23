import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

// 雨天的**四项水下排除**回归门（v3.30g 引入，v3.31 保留）。
//
// 用户裁定：落叶 / 雨滴 / 水花 / 地面反光都不得出现在水面以下。
// ⇒ 判据落在**真实 GPU 属性**（雨丝 aMinY、水花 aSpawn、落叶 aOrigin/aParams）
//   与**像素差分**（湿表面水下门），不读常量。
//
// ⚠️ v3.31：原有的两条「胶片颗粒各向同性」用例已删 —— 整条后处理链（含颗粒）
// 按用户 2026-11-22 裁定整体移除，那两条守的失效路径已不存在。
// 湿表面的材质分层 / 零光晕 / 不过曝判据在 `tests/wet-surface.spec.mjs`。
//
// ⚠️ 机位与噪声源冻结口径同既有 Tier 4 spec。

const SEED = 12345;

/** 注册一个模块内容替换（**必须在 goto 之前调**，否则注入静默失效） */
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

const BOOT = async (page, extra = '') => {
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 300)));
  await page.goto(`/?vd=4&seed=${SEED}&skybox=0&weather=clear${extra}`);
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

// ============================================================================
// ② 四项水下排除
// ============================================================================

/**
 * 传送到**浅水高台的湖里**并等世界收敛。
 * ⚠️ 用 `teleportToShallowTarn` 的同一份锚点权威算湖心，不写死坐标。
 */
async function gotoLake(page) {
  const site = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const { computeShallowTarnAnchor } = await import('/src/gen/structures/shallow-water-tarns.js');
    const a = computeShallowTarnAnchor(g.seed);
    if (!a) return null;
    return { x: a.wx + 0.5, z: a.wz + 0.5 };
  });
  expect(site, 'seed 必须有浅水高台落点').not.toBeNull();
  await page.evaluate(([x, z]) => window.__MC_GAME__._teleportTo(x, 40, z), [site.x, site.z]);
  await page.waitForTimeout(4000);
  await waitWorldStable(page);
  return site;
}

test('雨天水下：雨丝与水花都截停在水面，不落进湖底', async ({ page }) => {
  test.setTimeout(300_000);
  const errs = await BOOT(page);
  await gotoLake(page);
  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const { WATER_SURFACE_Y, waterSurfaceYAt } = await import('/src/render/water-surface.js');
    const { rainShelterY } = await import('/src/render/rain-shelter.js');
    const { STORM_STREAK: ST } = await import('/src/render/storm-rain-config.js');
    g.setStormLighting(true);
    await new Promise((res) => setTimeout(res, 2500));
    const geo = g.stormRain.streakMesh.geometry;
    const minY = geo.getAttribute('aMinY');
    const seed = geo.getAttribute('aSeed');
    const U = g.stormRain.streakUniforms;
    const t = U.uTime.value;
    const c = U.uCenter.value;
    const box = ST.box;
    const half = [box[0] / 2, box[1] / 2, box[2] / 2];
    const fract = (x) => x - Math.floor(x);
    const mod = (x, m) => ((x % m) + m) % m;

    /**
     * ⚠️⚠️ **判据必须量「可见性」而不是「位置」**（本轮两次实测的判据坑）：
     *   ① `aMinY` 是**逐列**截停面，雨幕盒 24×18×24 覆盖水陆混合区
     *      ⇒ 陆地/干坑列的截停面天然低于 −1.5，而那些滴**不在水下**；
     *   ② 雨丝在 18 格高盒子里循环，盒底（实测 −11）远低于湖底
     *      ⇒ 总有滴的**位置**在水下；关键是它有没有**被画出来**。
     * ⇒ 量 GPU 侧真实的 fade 因子：`(1−aShelter) × aboveWater × step(aMinY, y)`。
     *   其中 aboveWater = aWaterCol ? (y ≥ uWaterY) : 1。
     */
    const wc = geo.getAttribute('aWaterCol');
    const sh = geo.getAttribute('aShelter');
    const waterY = U.uWaterY.value;
    let resolved = 0; let visibleUnderwater = 0; let atWater = 0; let onLand = 0;
    let visibleTotal = 0;
    const samples = [];
    for (let i = 0; i < minY.count; i++) {
      const v = minY.getX(i);
      if (v < -1e8) continue;
      resolved++;
      const sx = seed.getX(i); const sy = seed.getY(i); const sz = seed.getZ(i);
      const sp = ST.speedMin + ST.speedRange * fract(sx * 7.31 + sz * 3.17);
      const wx = mod(sx * box[0] + ST.vel[0] * t - c.x + half[0], box[0]) - half[0] + c.x;
      const wy = mod(sy * box[1] - ST.vel[1] * sp * t - c.y + half[1], box[1]) - half[1] + c.y;
      const wz = mod(sz * box[2] + ST.vel[2] * t - c.z + half[2], box[2]) - half[2] + c.z;
      const surf = waterSurfaceYAt(g.world, g.registry, wx, wz,
        Math.max(wy, WATER_SURFACE_Y + 1), 48);
      // GPU 侧真实的可见性（与 storm-rain-material 的 fade 同式，略去远近衰减）
      const aboveWater = wc.getX(i) === 1 ? (wy >= waterY ? 1 : 0) : 1;
      const visible = sh.getX(i) === 0 && aboveWater === 1 && wy >= v;
      if (visible) visibleTotal++;
      if (surf === null) { onLand++; continue; }
      if (Math.abs(v - surf) < 1e-4) atWater++;
      if (visible && wy < surf - 1e-4) {
        visibleUnderwater++;
        if (samples.length < 5) samples.push({ minY: +v.toFixed(2), wy: +wy.toFixed(2), surf, wc: wc.getX(i), sh: sh.getX(i) });
      }
    }
    // 水花落点
    const sp2 = g.stormRain.splashMesh.geometry.getAttribute('aSpawn');
    let splashes = 0; let splashBelow = 0; let splashAtWater = 0;
    for (let i = 0; i < sp2.count; i++) {
      if (sp2.getW(i) < -100) continue;
      splashes++;
      const y = sp2.getY(i);
      const surf = waterSurfaceYAt(g.world, g.registry, sp2.getX(i), sp2.getZ(i),
        Math.max(y, WATER_SURFACE_Y + 1), 48);
      if (surf !== null && y < surf - 1e-3) splashBelow++;
      if (Math.abs(y - WATER_SURFACE_Y) < 0.05) splashAtWater++;
    }
    // 对照：旧口径（只挡雨面）在湖心确实会给出低于水面的值 ⇒ 判据有判别力
    const p = g.player.physics.pos;
    const oldShelter = rainShelterY(g.world, g.registry, p.x, p.z, p.y + 1.6, 24);
    return {
      WATER_SURFACE_Y, resolved, visibleUnderwater, visibleTotal, atWater, onLand, samples,
      splashes, splashBelow, splashAtWater,
      oldShelter, playerY: +p.y.toFixed(3),
      streakVisible: g.stormRain.streakMesh.visible,
    };
  });
  console.log('UNDERWATER RAIN:', JSON.stringify(r));
  expect(r.streakVisible, '湖面上方应当仍在下雨（不是整池停）').toBe(true);
  expect(r.resolved, '必须有真的解析到截停面的雨滴（否则判据恒真）').toBeGreaterThan(50);
  expect(r.visibleTotal, '必须有真的可见的雨丝（否则「零水下雨丝」恒真）').toBeGreaterThan(50);
  expect(r.oldShelter, '对照：旧口径在湖心须给出低于水面的截停面（证明判据有判别力）')
    .toBeLessThan(r.WATER_SURFACE_Y);
  expect(r.atWater, '必须有雨滴恰好截停在水面（证明水门真的生效）').toBeGreaterThan(0);
  expect(r.visibleUnderwater,
    `不得有**可见的**雨丝在水下（实测 ${r.visibleUnderwater} 滴：${JSON.stringify(r.samples)}）`).toBe(0);
  expect(r.splashes, '必须有水花生成（湖面要生成 —— 用户裁定）').toBeGreaterThan(0);
  expect(r.splashBelow, `水花不得在水面之下（实测 ${r.splashBelow} 朵）`).toBe(0);
  expect(r.splashAtWater, '必须有水花落在湖面上').toBeGreaterThan(0);
  expect(errs).toEqual([]);
});

test('雨天水下：湿地面反光在水面以下逐位归零（片元门，不是总强度门）', async ({ page }) => {
  test.setTimeout(300_000);
  const errs = await BOOT(page);
  await gotoLake(page);
  const st = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const { WATER_SURFACE_Y } = await import('/src/render/water-surface.js');
    g.setStormLighting(true);
    await new Promise((res) => setTimeout(res, 2000));
    g.renderer.setAnimationLoop(null);
    // 相机在水面**之上**、朝下看湖底 —— 这正是总强度门零判别力的机位
    const p = g.player.physics.pos;
    p.y = WATER_SURFACE_Y + 3.0;
    g.player.pitch = -0.75; g.player.yaw = 0;
    g.player.update(0.016);
    g.ocean.plane.visible = false;   // 藏海面平面，直接看湖底体素
    const wet = g.renderWorld.materials.wet;
    return {
      camY: +g.camera.position.y.toFixed(3),
      waterY: WATER_SURFACE_Y,
      uWet: wet.uWet.value,
      uWetWaterY: wet.uWetWaterY.value,
    };
  });
  console.log('UNDERWATER WET STATE:', JSON.stringify(st));
  expect(st.camY, '相机必须在水面之上（否则这条用例测的是别的情形）').toBeGreaterThan(st.waterY);
  expect(st.uWet, '总强度必须是开的（否则归零是总开关造成的，判据恒真）').toBeGreaterThan(0);

  const grab = async (waterY) => {
    await page.evaluate((wy) => {
      const g = window.__MC_GAME__;
      const wet = g.renderWorld.materials.wet;
      wet.uWet.value = 1;
      wet.uWetWaterY.value = wy;
      // ⚠️ v3.31：新湿表面**无时钟**（静态，用户未选涟漪/流水动画）⇒ 不再写 uWetTime。
      g._renderWaterReflection();
      g.renderer.render(g.scene, g.camera);
    }, waterY);
    await page.waitForTimeout(260);
    return PNG.sync.read(await page.screenshot());
  };
  // 门开（真实水面高度）vs 门关（把基准推到世界底之下 ⇒ 全部片元都算水上）
  const gated = await grab(st.waterY);
  const ungated = await grab(-1000);
  // 下半屏 = 湖底（相机朝下 43°）
  let n = 0; let changed = 0;
  for (let y = Math.floor(gated.height * 0.55); y < Math.floor(gated.height * 0.95); y++) {
    for (let x = Math.floor(gated.width * 0.15); x < Math.floor(gated.width * 0.85); x++) {
      const o = (y * gated.width + x) * 4;
      const d = Math.abs(gated.data[o] - ungated.data[o])
        + Math.abs(gated.data[o + 1] - ungated.data[o + 1])
        + Math.abs(gated.data[o + 2] - ungated.data[o + 2]);
      n++;
      if (d > 8) changed++;
    }
  }
  const frac = changed / n;
  console.log('UNDERWATER WET DIFF:', JSON.stringify({ changed, n, frac: +frac.toFixed(4) }));
  /**
   * 缺陷态（无片元门）：两图**完全相同** ⇒ frac = 0。
   * 修后湖底那一大片必须回到原色 ⇒ frac 显著非零。
   */
  expect(frac, '水下门必须真的改变湖底像素（0 = 门没生效，与缺陷态无法区分）')
    .toBeGreaterThan(0.1);
  const gpuErrs = errs.filter((e) => /GPUValidationError|Invalid CommandBuffer/.test(e));
  expect(gpuErrs, `不得有 WebGPU 验证错误：${gpuErrs.slice(0, 2).join(' | ')}`).toEqual([]);
});

test('雨天水下：落叶落点钳在水面之上，潜水时整池不上屏', async ({ page }) => {
  test.setTimeout(300_000);
  const errs = await BOOT(page);
  // 森林机位（落叶只在 FOREST 生效）—— 用既有 spec 已标定的坐标
  await page.evaluate(() => window.__MC_GAME__._teleportTo(-393.5, 60, -399.5));
  await page.waitForFunction(() => window.__MC_GAME__.player.physics.onGround === true,
    null, { timeout: 60_000, polling: 400 });
  await page.waitForTimeout(3000);
  await waitWorldStable(page);
  const dry = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const { LEAF_ATTR } = await import('/src/render/leaf-fx-material.js');
    const { WATER_SURFACE_Y } = await import('/src/render/water-surface.js');
    await new Promise((res) => setTimeout(res, 1500));
    const geo = g.leafFx?.mesh?.geometry;
    if (!geo) return { ok: false };
    const o = geo.getAttribute(LEAF_ATTR.origin);
    const p = geo.getAttribute(LEAF_ATTR.params);
    let seeded = 0; let below = 0;
    for (let i = 0; i < o.count; i++) {
      if (o.getY(i) === 0) continue;
      seeded++;
      if (p.getX(i) < WATER_SURFACE_Y - 1e-4 || o.getY(i) < WATER_SURFACE_Y - 1e-4) below++;
    }
    return { ok: true, seeded, below, dbg: g.leafFx.debugState(), WATER_SURFACE_Y };
  });
  console.log('UNDERWATER LEAF DRY:', JSON.stringify(dry));
  expect(dry.ok, 'leafFx 须已装配').toBe(true);
  expect(dry.seeded, '森林里必须有真的播种的落叶（否则判据恒真）').toBeGreaterThan(0);
  expect(dry.below, `陆地森林的落叶落点/出生点不得在水面之下（实测 ${dry.below}）`).toBe(0);
  expect(dry.dbg.underwater, '陆地上不该判为水下').toBe(false);

  // 潜水：在**玩家自己那一层**造水并把玩家压到水面之下。
  // ⚠️⚠️ **两个机位坑（本轮实测）**：
  //   ① 浅水高台的湖是 **SWAMP** biome ⇒ 落叶池的 biome 门先 early-return，
  //      水下门根本跑不到（dbg.underwater 恒 false）⇒ 必须在 **FOREST 列**上造水；
  //   ② 森林机位实测在 **y=56**（山地），把水写在 SEA_Y=−2 根本泡不到玩家
  //      ⇒ 必须以**玩家当前 y** 为基准造水面。
  const wet = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const { isWaterLike } = await import('/src/render/water-surface.js');
    const p = g.player.physics.pos;
    const bx = Math.floor(p.x); const bz = Math.floor(p.z);
    // 在玩家脚底那一格写水（下方已有实心地面），周围 9×9 一并写
    // ⇒ 该列的暴露水面 = floor(p.y) + 1 − 0.5
    const waterId = g.registry.idOf('water');
    const baseY = Math.floor(p.y);
    const ch = [];
    for (let dx = -4; dx <= 4; dx++) {
      for (let dz = -4; dz <= 4; dz++) {
        ch.push({ x: bx + dx, y: baseY, z: bz + dz, id: waterId });
      }
    }
    g.editor.setBlocks(ch);
    await new Promise((res) => setTimeout(res, 1500));
    const surfY = baseY + 1 - 0.5;
    // 确认水真的写进去了（否则后面全是假结论）
    const wroteWater = isWaterLike(g.world.getBlockId(bx, baseY, bz), g.registry);
    // 潜到水面之下
    p.y = surfY - 0.8;
    g.leafFx.update(p, 0.016);
    const submerged = { dbg: g.leafFx.debugState(), visible: g.leafFx.mesh.visible, py: +p.y.toFixed(2) };
    // 浮回水面之上 ⇒ 立即恢复
    p.y = surfY + 1.5;
    g.leafFx.update(p, 0.016);
    const surfaced = { dbg: g.leafFx.debugState(), visible: g.leafFx.mesh.visible, py: +p.y.toFixed(2) };
    return { submerged, surfaced, surfY, wroteWater, biome: g.leafFx.debugState().biome };
  });
  console.log('UNDERWATER LEAF WET:', JSON.stringify(wet));
  expect(wet.biome, '机位必须仍在 FOREST（否则 biome 门先 early-return，水下门测不到）').toBe('FOREST');
  expect(wet.wroteWater, '水必须真的写进体素（否则后面全是假结论）').toBe(true);
  expect(wet.submerged.py, '玩家须真的在水面之下').toBeLessThan(wet.surfY);
  expect(wet.submerged.dbg.underwater, '水下门必须判为 true').toBe(true);
  expect(wet.submerged.visible, '水下时落叶池不得上屏').toBe(false);
  expect(wet.surfaced.py, '出水后玩家须在水面之上').toBeGreaterThan(wet.surfY);
  expect(wet.surfaced.dbg.underwater, '出水后水下门须解除').toBe(false);
  expect(wet.surfaced.visible, '出水后落叶须恢复上屏').toBe(true);
  expect(errs).toEqual([]);
});

test('负向：去掉雨的水下两道门 ⇒ 水下判据必须 FAIL', async ({ page }) => {
  test.setTimeout(300_000);
  /**
   * ⚠️⚠️ **负向验证要注入「能真正到达产物」的缺陷**（本轮实测的多层防御陷阱）：
   * 只把 GPU 的 `aboveWater` 退为恒 1 **不够** —— 实测分解：2046 滴位置在水下，
   * 其中 1003 被 `aShelter` 拦、剩下 1043 被 `step(aMinY, y)` 拦（aMinY 已是水面 −1.5）
   * ⇒ visibleBelow **仍为 0**，会误读成「判据失效」。
   * ⇒ 同时退回**两道门**：CPU 的截停面去掉水面项（rainStopY）+ GPU 的 aboveWater。
   * 那才是 v3.30e 的真实行为（雨丝穿过水落到湖底）。
   */
  await routeModule(page, 'rain-shelter.js', (b) => b.replace(
    '  const water = waterSurfaceYAt(world, registry, x, z, start, searchDepth);',
    '  const water = null;'));
  await routeModule(page, 'storm-rain-material.js', (b) => b.replace(
    'const aboveWater = mix(float(1), step(U.uWaterY, p.y), waterCol);',
    'const aboveWater = float(1);'));
  const errs = await BOOT(page);
  await gotoLake(page);
  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const { WATER_SURFACE_Y, waterSurfaceYAt } = await import('/src/render/water-surface.js');
    const { STORM_STREAK: ST } = await import('/src/render/storm-rain-config.js');
    g.setStormLighting(true);
    await new Promise((res) => setTimeout(res, 2500));
    const geo = g.stormRain.streakMesh.geometry;
    const minY = geo.getAttribute('aMinY');
    const seed = geo.getAttribute('aSeed');
    const sh = geo.getAttribute('aShelter');
    const wc = geo.getAttribute('aWaterCol');
    const U = g.stormRain.streakUniforms;
    const t = U.uTime.value; const c = U.uCenter.value;
    const box = ST.box; const half = [box[0] / 2, box[1] / 2, box[2] / 2];
    const fract = (x) => x - Math.floor(x);
    const mod = (x, m) => ((x % m) + m) % m;
    let resolved = 0; let below = 0;
    for (let i = 0; i < minY.count; i++) {
      const v = minY.getX(i);
      if (v < -1e8) continue;
      resolved++;
      const sx = seed.getX(i); const sy = seed.getY(i); const sz = seed.getZ(i);
      const sp = ST.speedMin + ST.speedRange * fract(sx * 7.31 + sz * 3.17);
      const wx = mod(sx * box[0] + ST.vel[0] * t - c.x + half[0], box[0]) - half[0] + c.x;
      const wy = mod(sy * box[1] - ST.vel[1] * sp * t - c.y + half[1], box[1]) - half[1] + c.y;
      const wz = mod(sz * box[2] + ST.vel[2] * t - c.z + half[2], box[2]) - half[2] + c.z;
      const surf = waterSurfaceYAt(g.world, g.registry, wx, wz, Math.max(wy, WATER_SURFACE_Y + 1), 48);
      if (surf === null) continue;
      // 注入后的可见性：aboveWater 恒 1
      const visible = sh.getX(i) === 0 && wy >= v;
      if (visible && wy < surf - 1e-4) below++;
    }
    // 注入生效确认：读回浏览器侧两个模块的源码
    const srcMat = await (await fetch('/src/render/storm-rain-material.js')).text();
    const srcSh = await (await fetch('/src/render/rain-shelter.js')).text();
    return { WATER_SURFACE_Y, resolved, below,
      injected: srcMat.includes('const aboveWater = float(1);') && srcSh.includes('const water = null;'),
      hasReal: srcMat.includes('step(U.uWaterY, p.y), waterCol') };
  });
  console.log('NEG-RAIN-GATE:', JSON.stringify(r));
  expect(r.injected, '两道门的注入都须真的落地').toBe(true);
  expect(r.hasReal, '真实 GPU 门须已被替掉').toBe(false);
  expect(r.resolved).toBeGreaterThan(50);
  expect(r.below, `注入后必须真有可见雨丝在水下（实测 ${r.below}）`).toBeGreaterThan(0);
  expect(errs).toEqual([]);
});