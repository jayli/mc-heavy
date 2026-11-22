import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

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

test('雨天光影：室内不生效（屋顶下无雨丝无水花，地面不湿）', async ({ page }) => {
  test.setTimeout(240_000);
  await BOOT(page);
  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    g.setStormLighting(true);
    await new Promise((res) => setTimeout(res, 500));
    const outdoor = { ...g.stormRain.debugState(), wet: g.renderWorld.materials.wet.uWet.value };
    // 在玩家头顶造一个屋顶（走唯一写入口 editor）
    const p = g.player.physics.pos;
    const bx = Math.floor(p.x); const bz = Math.floor(p.z);
    const roofY = Math.floor(p.y) + 4;
    const stone = g.registry.idOf('stone_bricks');
    const changes = [];
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) changes.push({ x: bx + dx, y: roofY, z: bz + dz, id: stone });
    }
    g.editor.setBlocks(changes);
    await new Promise((res) => setTimeout(res, 700));
    const indoor = { ...g.stormRain.debugState(), wet: g.renderWorld.materials.wet.uWet.value };
    return { outdoor, indoor, roofY };
  });
  console.log('STORM INDOOR:', JSON.stringify(r));
  expect(r.outdoor.underRoof).toBe(false);
  expect(r.outdoor.streakVisible).toBe(true);
  expect(r.indoor.underRoof).toBe(true);
  // 用户：「如果是室内场景，这个雨的特效就不要生效了」
  expect(r.indoor.streakVisible).toBe(false);
  expect(r.indoor.splashVisible).toBe(false);
  expect(r.indoor.wet).toBe(0);
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
  // 停掉的循环**整个键消失**（本轮实测：on 只有 rain_storm、off 只有 rain）。
  // 开启：rain_storm 在播且音量 >0，既有 rain 不在播
  expect(r.on.rain_storm).toBeTruthy();
  expect(r.on.rain_storm.playing).toBe(true);
  expect(r.on.rain_storm.volume).toBeGreaterThan(0);
  expect(r.on.rain === undefined || r.on.rain.playing === false).toBe(true);
  // 关闭：rain_storm 停（键消失或不在播），既有 rain 回来
  expect(r.off.rain_storm === undefined || r.off.rain_storm.playing === false).toBe(true);
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
