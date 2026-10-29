import { test, expect } from 'playwright/test';

/**
 * 左下角迷你区域地图（v2.8）的 Tier 4 像素实测。
 *
 * **为什么必须像素实测**：底图是 `putImageData` 写进 2D canvas 的，玩家点是 canvas 2D 路径 ——
 * 都在浏览器合成器里求值，纯逻辑单测只能验到 `paintMinimap` 的 RGB 缓冲（`test-minimap.js`），
 * 验不到「画布真的挂在左下角」「CSS 尺寸真的是 153px」「`pixelated` 真的没把色块糊成一团」
 * 「玩家点真的在正中」。这些恰好是用户能一眼看出、而单测完全测不到的部分
 * （testing-policy §5：GPU/合成结果只能像素级实测）。
 *
 * 判据选型（避坑）：
 *  - **不比绝对色值**，比「该像素是否落在某种类的色域内 + 种类之间是否显著不同」——
 *    渲染管线/DPR 差异不影响判据（同 turret-render / zombie-head 的手法）；
 *  - **每个用例都有判别性前提**（「南北两侧确实不同区域」「这个点是真水」）先断言，
 *    否则判据可能恒真（testing-policy §2.7 的无效盲区）；
 *  - 采样点由**Node 侧独立算出的世界格**给出（不读被测模块的 AREA_COLORS 去比它自己），
 *    但种类定义仍 import 同一个模块 —— 那是「期望值」，不是「被测实现副本」。
 */
import {
  AREA_COLORS, AREA_KINDS, MINIMAP_SAMPLES, MINIMAP_SPAN, MINIMAP_STEP, MINIMAP_MAP_SIZE,
  kindAt, minimapRegionContext, minimapAreaBounds, clearMinimapContextCache,
} from '../src/ui/minimap-regions.js';
import { isTarnZone, computeTarnZone } from '../src/gen/structures/tarn-zone.js';
import { generateHeight } from '../src/gen/terrain.js';
import { getBiome } from '../src/gen/noise.js';
import { SEA_Y } from '../src/voxel/constants.js';

const READY = () => window.__MC_GAME__?.worldReady === true;
const SEED = 12345;

/** 找一座地带（Node 侧算，与页面同 seed） */
function findTarn(seed, maxRing = 12) {
  for (let ring = 0; ring <= maxRing; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dz = -ring; dz <= ring; dz++) {
        if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dz) !== ring) continue;
        if (isTarnZone(dx, dz, seed)) return computeTarnZone(dx, dz, seed);
      }
    }
  }
  return null;
}

/** 从页面读某个 canvas 的像素（按 CSS 尺寸采样 → 用 canvas 自身分辨率） */
async function canvasPixels(page, selector) {
  return page.evaluate((sel) => {
    const c = document.querySelector(sel);
    if (!c) return null;
    const ctx = c.getContext('2d');
    const img = ctx.getImageData(0, 0, c.width, c.height);
    return { width: c.width, height: c.height, data: [...img.data] };
  }, selector);
}

/** 按「样本坐标 (i,j)」读底图颜色（样本 → canvas 像素：底图 canvas 就是 51×51，1:1） */
function sampleAt(pixels, i, j) {
  const o = (j * pixels.width + i) * 4;
  return [pixels.data[o], pixels.data[o + 1], pixels.data[o + 2]];
}

/** 颜色是否等于某种类（含世界锚定抖动容差 —— 抖动最大 6/通道，允许 drawImage 插值误差） */
function isKind(rgb, kind, tol = 10) {
  const c = AREA_COLORS[kind];
  return Math.abs(rgb[0] - c[0]) <= tol && Math.abs(rgb[1] - c[1]) <= tol && Math.abs(rgb[2] - c[2]) <= tol;
}

/** 把玩家瞬移到世界坐标（走真实的 `_teleportTo`，不直接改 physics.pos） */
async function teleport(page, x, z) {
  await page.evaluate(([px, pz]) => {
    const g = window.__MC_GAME__;
    g._teleportTo(px, g.player.physics.pos.y + 0.1, pz);
    g._minimap.redraw();
  }, [x, z]);
}

test('minimap Tier4：左下角可见、尺寸正确、玩家点恒在中心', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`/?vd=2&seed=${SEED}`);
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await page.waitForTimeout(1200);

  // ① 元素存在且在左下角（几何断言，不是「看起来在左下」）
  const geo = await page.evaluate(() => {
    const el = document.getElementById('mc-minimap');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: r.x, y: r.y, w: r.width, h: r.height,
      vw: window.innerWidth, vh: window.innerHeight,
      parentIsHud: el.parentElement?.id === 'hud-root',
      pointerEvents: getComputedStyle(el).pointerEvents,
      baseW: document.getElementById('mc-minimap-base').width,
      baseH: document.getElementById('mc-minimap-base').height,
      baseRendering: getComputedStyle(document.getElementById('mc-minimap-base')).imageRendering,
      north: document.getElementById('mc-minimap-north')?.textContent,
    };
  });
  expect(geo, '#mc-minimap 必须存在').not.toBeNull();
  expect(geo.w).toBe(MINIMAP_MAP_SIZE);
  expect(geo.h).toBe(MINIMAP_MAP_SIZE);
  // 左下角：贴左 + 贴底（留 12px 边距），且居右半边还远
  expect(geo.x).toBeGreaterThanOrEqual(8);
  expect(geo.x).toBeLessThan(30);
  expect(geo.vh - (geo.y + geo.h)).toBeGreaterThanOrEqual(8);
  expect(geo.vh - (geo.y + geo.h)).toBeLessThan(30);
  expect(geo.x + geo.w).toBeLessThan(geo.vw / 2); // 确实在左边
  expect(geo.y).toBeGreaterThan(geo.vh / 2);      // 确实在下边
  // ② 不吃鼠标（否则挡住准星/放置）
  expect(geo.pointerEvents).toBe('none');
  // ③ 底图画布是 51×51 且 CSS 放大用 pixelated（否则色块被插值糊成渐变）
  expect([geo.baseW, geo.baseH]).toEqual([MINIMAP_SAMPLES, MINIMAP_SAMPLES]);
  expect(geo.baseRendering).toBe('pixelated');
  // ④ 挂在 hud-root 下（与其它 HUD 同层，一起被「隐藏 HUD」类隔离措施覆盖）
  expect(geo.parentIsHud).toBe(true);
  // ⑤ 罗盘 N 存在（上北下南的显式标识）
  expect(geo.north).toBe('N');

  // ⑥ 玩家点恒在 overlay 正中（白色圆点 + 深色描边）
  const overlay = await canvasPixels(page, '#mc-minimap-overlay');
  expect(overlay).not.toBeNull();
  const cx = (overlay.width - 1) / 2, cy = (overlay.height - 1) / 2;
  const o = (Math.round(cy) * overlay.width + Math.round(cx)) * 4;
  const dot = [overlay.data[o], overlay.data[o + 1], overlay.data[o + 2], overlay.data[o + 3]];
  expect(dot[3], '中心必须有玩家点（alpha > 0）').toBeGreaterThan(200);
  expect(dot[0]).toBeGreaterThan(200);
  expect(dot[1]).toBeGreaterThan(200);
  expect(dot[2]).toBeGreaterThan(200);

  // ⑦ 世界保持可玩（地图不吃帧）：帧率主断言同 M1 口径
  await page.waitForTimeout(2000);
  const perf = await page.evaluate(() => window.__MC_GAME__.perfSnapshot());
  console.log('MINIMAP FPS:', JSON.stringify({ fps: perf.fps, p95: perf.frameMs.p95 }));
  expect(perf.fps).toBeGreaterThan(process.env.CI ? 20 : 110);
});

test('minimap Tier4：底图内容与真实区域一致（城市 / 高台地带 / 水面）', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(`/?vd=2&seed=${SEED}`);
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await page.waitForTimeout(1200);

  // ---- ① 出生点在城市中心 ⇒ 中心样本必须是 CITY（前提由 Node 侧独立核实）----
  const spawn = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return { x: g.player.physics.pos.x, z: g.player.physics.pos.z, seed: g.seed };
  });
  expect(spawn.seed).toBe(SEED);
  const mid = (MINIMAP_SAMPLES - 1) >> 1;
  const cityKind = kindAt(Math.floor(spawn.x), Math.floor(spawn.z), SEED, { city: null, tarns: [], snows: [] });
  // 前提核实：出生点确实在城市 bounds 内（用页面里的城市布局，而不是 Node 侧重新 build）
  const inCity = await page.evaluate(([x, z]) => {
    const g = window.__MC_GAME__;
    const city = g.cityLayout();
    return city ? (x >= city.minX && x <= city.maxX && z >= city.minZ && z <= city.maxZ) : null;
  }, [spawn.x, spawn.z]);
  expect(inCity, '出生点须在城市 bounds 内（M2-2 语义）').toBe(true);

  let base = await canvasPixels(page, '#mc-minimap-base');
  const center = sampleAt(base, mid, mid);
  expect(isKind(center, 'CITY'), `出生点中心应为 CITY，实测 ${center}`).toBe(true);

  // ---- ② 瞬移到高台地带 ⇒ 中心样本变 TARN，且与 CITY 显著不同 ----
  const tarn = findTarn(SEED);
  expect(tarn, '须找到一座地带').not.toBeNull();
  await teleport(page, tarn.cx, tarn.cz);
  await page.waitForTimeout(400);
  base = await canvasPixels(page, '#mc-minimap-base');
  const tarnCenter = sampleAt(base, mid, mid);
  expect(isKind(tarnCenter, 'TARN'), `地带中心应为 TARN，实测 ${tarnCenter}`).toBe(true);
  const dist = Math.hypot(tarnCenter[0] - center[0], tarnCenter[1] - center[1], tarnCenter[2] - center[2]);
  expect(dist, 'TARN 与 CITY 的颜色必须显著不同').toBeGreaterThan(40);

  // ---- ③ 瞬移到真实海面 ⇒ 中心样本变 WATER ----
  // 前提：先找到 h < SEA_Y 的深水点（不能凭想象）
  let water = null;
  for (let r = 200; r <= 4000 && !water; r += 40) {
    for (let a = 0; a < 16 && !water; a++) {
      const wx = Math.round(tarn.cx + r * Math.cos((a * Math.PI) / 8));
      const wz = Math.round(tarn.cz + r * Math.sin((a * Math.PI) / 8));
      if (generateHeight(wx, wz, SEED) < SEA_Y - 3) water = { x: wx, z: wz };
    }
  }
  expect(water, '须找到一块真实海面').not.toBeNull();
  await teleport(page, water.x, water.z);
  await page.waitForTimeout(400);
  base = await canvasPixels(page, '#mc-minimap-base');
  const waterCenter = sampleAt(base, mid, mid);
  expect(isKind(waterCenter, 'WATER'), `海面中心应为 WATER，实测 ${waterCenter}`).toBe(true);
});

test('minimap Tier4：上北下南（跨城南边界时北侧必是城市）', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(`/?vd=2&seed=${SEED}`);
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await page.waitForTimeout(1200);

  // 站到城市「南边界」上：北侧（z 小）在城里，南侧（z 大）在城外。
  const city = await page.evaluate(() => {
    const c = window.__MC_GAME__.cityLayout();
    return c ? { minX: c.minX, maxX: c.maxX, minZ: c.minZ, maxZ: c.maxZ } : null;
  });
  expect(city).not.toBeNull();
  // 前提：南边界往南 SPAN/2 格确实已出城（否则判据无判别力）
  const px = Math.round((city.minX + city.maxX) / 2);
  const pz = city.maxZ;
  expect(pz + MINIMAP_SPAN / 2 > city.maxZ, '南侧须出城').toBe(true);

  await teleport(page, px, pz);
  await page.waitForTimeout(400);
  const base = await canvasPixels(page, '#mc-minimap-base');
  const mid = (MINIMAP_SAMPLES - 1) >> 1;
  const top = sampleAt(base, mid, 0);        // 顶行 = 北 = z 小 = 城内
  const bottom = sampleAt(base, mid, MINIMAP_SAMPLES - 1); // 底行 = 南 = z 大 = 城外
  console.log('NORTH/SOUTH:', JSON.stringify({ top, bottom }));
  expect(isKind(top, 'CITY'), `顶行（北）应是城市，实测 ${top}`).toBe(true);
  expect(isKind(bottom, 'CITY'), `底行（南）不应是城市，实测 ${bottom}`).toBe(false);
  // 上下两行必须显著不同（否则「上北下南」无判别力）
  expect(Math.hypot(top[0] - bottom[0], top[1] - bottom[1], top[2] - bottom[2])).toBeGreaterThan(40);
});

test('minimap Tier4：移动时地图随之滚动（玩家点不动、底图内容变）', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(`/?vd=2&seed=${SEED}`);
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await page.waitForTimeout(1200);

  const before = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return {
      x: g.player.physics.pos.x, z: g.player.physics.pos.z,
      baseDraws: g._minimap.baseDraws,
      overlayDraws: g._minimap.overlayDraws,
    };
  });
  const mid = (MINIMAP_SAMPLES - 1) >> 1;

  // 走到 2 个 region 之外（> 地图跨度），确保底图必须整体换掉
  const target = { x: before.x + MINIMAP_SPAN * 2, z: before.z + MINIMAP_SPAN * 2 };
  await teleport(page, target.x, target.z);
  await page.waitForTimeout(500);

  const after = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return {
      x: g.player.physics.pos.x, z: g.player.physics.pos.z,
      baseDraws: g._minimap.baseDraws,
      overlayDraws: g._minimap.overlayDraws,
    };
  });
  expect(after.baseDraws, '移动后必须真的重绘底图').toBeGreaterThan(before.baseDraws);

  // ① 玩家点仍在 overlay 正中（redraw 只换底图，点不动）
  const overlay = await canvasPixels(page, '#mc-minimap-overlay');
  const ocx = Math.round((overlay.width - 1) / 2), ocy = Math.round((overlay.height - 1) / 2);
  const oo = (ocy * overlay.width + ocx) * 4;
  expect(overlay.data[oo]).toBeGreaterThan(200);
  expect(overlay.data[oo + 3]).toBeGreaterThan(200);

  // ② 底图中心像素 = 新位置的真实区域色（Node 侧独立算）
  const base = await canvasPixels(page, '#mc-minimap-base');
  const centerPx = sampleAt(base, mid, mid);
  const expectKind = kindAt(Math.floor(after.x), Math.floor(after.z), SEED,
    minimapRegionContext(SEED, after.x, after.z, null));
  expect(isKind(centerPx, expectKind),
    `中心应为 ${expectKind}，实测 ${centerPx}`).toBe(true);

  // ③ 节流真的生效：**逐帧强行拉大位移**，让「移动阈值」这道门全开，只剩时间节流。
  //    ⚠️ **不能用「按 W 跑 1 秒」**：跑速 8 格/秒 ⇒ 每 62ms 才移动 0.5 格，
  //    `BASE_REDRAW_MIN_MOVE` 本身就把它限到 ~16 次/秒 —— 实测去掉时间节流后
  //    「按 W」仍只有 ~16 次，断言全绿（**无效盲区**，已实测碰到）。
  //    改成每帧 +3 格（≈360 格/秒）：时间节流在 ⇒ ~10 次；不在 ⇒ ~120 次（差一个数量级）。
  const throttle = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const t0 = performance.now();
    const b0 = g._minimap.baseDraws;
    let frames = 0;
    await new Promise((resolve) => {
      const step = () => {
        g.player.physics.pos.x += 3;
        frames++;
        if (performance.now() - t0 < 1000) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
    return { draws: g._minimap.baseDraws - b0, frames, ms: performance.now() - t0 };
  });
  console.log('THROTTLE:', JSON.stringify(throttle));
  // 10Hz × 1s ≈ 10 次；给到 25 的上界（无时间节流时 ≈ 一个帧数，实测 120 上下）
  expect(throttle.frames, '本用例需要有足够多的帧才能区分节流').toBeGreaterThan(40);
  expect(throttle.draws).toBeLessThan(25);
  expect(throttle.draws).toBeGreaterThan(0);
});

test('minimap Tier4：R 键/视角转动只重画玩家点，不重算整张地图', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`/?vd=2&seed=${SEED}`);
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await page.waitForTimeout(1200);

  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const b0 = g._minimap.baseDraws, o0 = g._minimap.overlayDraws;
    // 只转视角（不移动）：yaw 变化必须只触发 overlay 重绘
    for (let k = 0; k < 20; k++) {
      g.player.yaw += 0.15;
      await new Promise((res) => requestAnimationFrame(res));
    }
    return { base: g._minimap.baseDraws - b0, overlay: g._minimap.overlayDraws - o0 };
  });
  console.log('YAW-ONLY:', JSON.stringify(r));
  expect(r.base, '静止转视角不得重算整张地图').toBe(0);
  expect(r.overlay, '转视角必须更新玩家点朝向').toBeGreaterThan(0);
});

test('minimap Tier4：朝向短刺与相机前向一致（上北下南的第二个证据）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`/?vd=2&seed=${SEED}`);
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await page.waitForTimeout(1200);

  /**
   * 四个基方向上：「画出来的刺质心方向」必须与「相机的世界前向」在屏幕上一致。
   *
   * ⚠️ **为什么不能只断言 `dx>0 / dy<0` 之类的符号**：那只能拓到「完全没有刺」；
   * 刺被画到反方向（南北/东西颠倒）时符号仍然能蒙对一半 —— 必须**逐个基方向**比对，
   * 且真值取自相机的 `quaternion`（`player.js` 的接线），不是另写一份三角函数。
   */
  const r = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const mm = g._minimap;
    const c = mm.overlayCanvas;
    const ctx = c.getContext('2d');
    const cx = (c.width - 1) / 2, cy = (c.height - 1) / 2;
    const out = [];
    for (const [name, yaw] of [['north', 0], ['east', -Math.PI / 2], ['south', Math.PI], ['west', Math.PI / 2]]) {
      // 真值：相机（`player.js` 里 rotateY(yaw)）的世界前向 → 投影到地图平面的 (dx, dz)
      g.player.yaw = yaw;
      g.player.camera.rotation.set(0, 0, 0);
      g.player.camera.rotateY(yaw);
      const f = new g.camera.position.constructor(0, 0, -1).applyQuaternion(g.player.camera.quaternion);
      // 地图平面：屏幕 x = 世界 +x；屏幕 y = 世界 +z（上 = -z）
      const truth = { dx: f.x, dy: f.z };

      mm.drawOverlay(yaw);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let sw = 0, sx = 0, sy = 0, cnt = 0;
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          const o = (y * c.width + x) * 4;
          if (d[o + 3] < 40) continue;
          const lum = (d[o] + d[o + 1] + d[o + 2]) / 3;
          const dist = Math.hypot(x - cx, y - cy);
          if (dist < 5.2 || lum < 120) continue; // 剔除圆点本身
          sw += lum; sx += (x - cx) * lum; sy += (y - cy) * lum; cnt++;
        }
      }
      const spike = cnt > 0 ? { dx: sx / sw, dy: sy / sw } : null;
      out.push({ name, truth, spike, cnt });
    }
    return out;
  });

  console.log('FACING:', JSON.stringify(r));
  for (const item of r) {
    expect(item.cnt, `${item.name}：必须画出刺（否则本用例无判别力）`).toBeGreaterThan(0);
    const len = Math.hypot(item.truth.dx, item.truth.dy);
    const t = { dx: item.truth.dx / len, dy: item.truth.dy / len };
    const sLen = Math.hypot(item.spike.dx, item.spike.dy);
    const s = { dx: item.spike.dx / sLen, dy: item.spike.dy / sLen };
    // 方向余弦 > 0.9（即夹角 < 26°）—— 实测四个基方向都是 1.000（完全同向）
    const cos = t.dx * s.dx + t.dy * s.dy;
    expect(cos, `${item.name}：刺方向 ${JSON.stringify(s)} 与相机前向 ${JSON.stringify(t)} 不一致`)
      .toBeGreaterThan(0.9);
  }
});

/**
 * **玩家点的重绘必须清掉整张画布（含 dpr > 1 的高分画布）**。
 *
 * 缺陷形态（用户 2026-10-29 报告「转一圈留一圈残影，看不清最终朝向」）：
 * overlay 画布内部是 `MINIMAP_MAP_SIZE × dpr` 设备像素，而 `clearRect` 的参数是
 * **CSS 像素**（153）—— 两者在 dpr = 2 时差一倍，每次只清掉左上 1/4，
 * 落在其他区域的朝向刺像素永远清不掉 → 转一圈就叠一圈。
 *
 * ⚠️ **必须在 dpr = 2 的上下文里测**：dpr = 1 时 CSS 像素恰好等于设备像素，
 * 缺陷完全不可见（实测 dpr=1 非透明像素恒 76~82，dpr=2 从 268 单调涨到 886）。
 * 用默认上下文（dsf=1）写这个用例会得到**无效盲区**。
 *
 * 判据选型：「转一圈后非透明像素数不得随转动次数增长」。不用绝对像素数 —— 那会把
 * 圆点半径、描边宽度这些设计参数钉死；这里只说「重绘不应累积」。
 */
test('minimap Tier4：转一圈不残留朝向残影（dpr=2 下重绘不累积）', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 700 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(`/?vd=2&seed=${SEED}`);
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await page.waitForTimeout(800);

  const r = await page.evaluate(() => {
    const mm = window.__MC_GAME__._minimap;
    const c = mm.overlayCanvas;
    const g2 = c.getContext('2d');
    const opaque = () => {
      const d = g2.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
      return n;
    };
    // 前置条件：本用例要求 dpr > 1（dpr=1 时 CSS 像素 == 设备像素，缺陷不可见）
    if (mm._dpr <= 1) return { skipReason: `dpr=${mm._dpr}，无法拓到缺陷`, dpr: mm._dpr };

    const samples = [];
    // 转一整圈：24 个基方向 + 回到起点
    for (let k = 0; k <= 24; k++) {
      mm.drawOverlay(k * (Math.PI * 2 / 24));
      samples.push(opaque());
    }
    return {
      dpr: mm._dpr, canvas: [c.width, c.height],
      first: samples[0], last: samples[24],
      max: Math.max(...samples), min: Math.min(...samples),
      samples,
    };
  });
  await ctx.close();

  expect(r.skipReason, '本用例必须有 dpr > 1 的上下文').toBeUndefined();
  console.log('GHOST:', JSON.stringify({ dpr: r.dpr, canvas: r.canvas, first: r.first, last: r.last, max: r.max }));
  // 转完一整圈后的像素数必须回到与起步同一量级：
  // 修复后实测 first === last === 268（逐位相同）；缺陷存在时 last ≈ 3.3 × first。
  expect(r.last, `转一圈后像素数从 ${r.first} 涨到 ${r.last}（残影累积）`)
    .toBeLessThanOrEqual(r.first * 1.15);
});

test('minimap Tier4：出生时面朝南（相机前向 +Z，地图刺朝下方）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`/?vd=2&seed=${SEED}`);
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await page.waitForTimeout(1500);

  const r = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const V = g.camera.position.constructor;
    const fwd = new V(0, 0, -1).applyQuaternion(g.camera.quaternion);
    // 地图上的刺（质心方向）—— 独立于相机再算一次，两边必须同向
    const c = g._minimap.overlayCanvas, ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const cx = (c.width - 1) / 2, cy = (c.height - 1) / 2;
    let sw = 0, sx = 0, sy = 0;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const o = (y * c.width + x) * 4;
        if (d[o + 3] < 40) continue;
        const lum = (d[o] + d[o + 1] + d[o + 2]) / 3;
        if (Math.hypot(x - cx, y - cy) < 5.2 || lum < 120) continue;
        sw += lum; sx += (x - cx) * lum; sy += (y - cy) * lum;
      }
    }
    return { yaw: g.player.yaw, fwd: [fwd.x, fwd.y, fwd.z], spike: { dx: sx / sw, dy: sy / sw } };
  });
  console.log('SPAWN FACING:', JSON.stringify(r));

  // ① 出生朝向 = 南（π）。这里**不 import `player.js`** —— 它 import three，而 Playwright spec
  // 在 **node 侧**求值（顶级 import 会报 `Cannot find package 'three'`）。故直接比字面值，
  // 并在注释里注明它与 `SPAWN_YAW` 是同一常量（单测那边已钉住 `SPAWN_YAW === Math.PI`）。
  expect(r.yaw).toBeCloseTo(Math.PI, 9);
  // ② 相机实际前向 = +Z（南）——「面朝南」的**可观测**含义，不是只看 yaw 数字
  expect(r.fwd[2], `相机前向 z 必须 ≈ +1（南），实测 ${JSON.stringify(r.fwd)}`).toBeGreaterThan(0.999);
  expect(Math.abs(r.fwd[0]), '不得有东西向分量').toBeLessThan(1e-6);
  // ③ 地图刺朝屏幕下方（上北下南 => 南 = +y 像素）—— 与相机交叉比对：
  //    只验一个的话，地图方向反了或相机没跟上都会各自全绿。
  expect(r.spike.dy, `地图刺必须朝下（南），实测 dy=${r.spike.dy}`).toBeGreaterThan(3);
  expect(Math.abs(r.spike.dx), `不得有东西偏移，实测 dx=${r.spike.dx}`).toBeLessThan(2);
});

test('minimap Tier4：底图色块分明（pixelated 未失效 —— 相邻样本是硬边不是渐变）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`/?vd=2&seed=${SEED}`);
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await page.waitForTimeout(1200);

  // ⚠️ **必须去一个「多种区域并存」的位置**：出生点在城市中心，而城市 bounds 宽 566
  // > 地图跨度 1000 的 56% ⇒ 中心附近仍可能整张图都是 CITY（只有抖动，`kinds.size === 1`）。
  // 实测就是这样碰到「种类数 = 1」的（断言在出生点无判别力）。故 Node 侧先扫一个窗口。
  let spot = null, bestKinds = 0;
  for (let x = -1600; x <= 1600 && bestKinds < 4; x += 137) {
    for (let z = -1600; z <= 1600 && bestKinds < 4; z += 149) {
      const ctx = minimapRegionContext(SEED, x, z, null);
      const set = new Set();
      for (let j = 0; j < MINIMAP_SAMPLES; j += 2) {
        for (let i = 0; i < MINIMAP_SAMPLES; i += 2) {
          set.add(kindAt(Math.floor(x) + (i - 25) * MINIMAP_STEP,
            Math.floor(z) + (j - 25) * MINIMAP_STEP, SEED, ctx));
        }
      }
      if (set.size > bestKinds) { bestKinds = set.size; spot = { x, z, kinds: set.size }; }
    }
  }
  expect(spot, '须找到一个多区域窗口').not.toBeNull();
  expect(bestKinds, `所选位置应至少 3 种区域（实测 ${bestKinds}）`).toBeGreaterThanOrEqual(3);
  await teleport(page, spot.x, spot.z);
  await page.waitForTimeout(400);

  // 直接从底图 canvas 读（1 个样本 = 1 个像素）→ 每个像素都必须能归入某个种类
  // （归不进去就说明缓冲被插值/被污染了）。
  const base = await canvasPixels(page, '#mc-minimap-base');
  const S = MINIMAP_SAMPLES;
  const kinds = new Set();
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const rgb = sampleAt(base, i, j);
      let found = null;
      for (const k of AREA_KINDS) if (isKind(rgb, k, 8)) { found = k; break; }
      expect(found, `(${i},${j}) 的 ${rgb} 不属于任何种类（缓冲被插值了？）`).not.toBeNull();
      kinds.add(found);
    }
  }
  expect(kinds.size, `地图上应可见多种区域，实测 ${[...kinds]}`).toBeGreaterThan(1);

  // 屏幕层面：把地图区域截图，检查一小块「硬边色块内部方差小」——
  // 这是 `image-rendering:pixelated` 真的生效的判别式（bilinear 放大时，
  // 同一生物群系内部会被插值出连续渐变，方差显著抬升；`pixelated` 下只受抖动影响）。
  const rect = await page.evaluate(() => {
    const r = document.getElementById('mc-minimap').getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  });
  const { PNG } = await import('pngjs');
  const png = PNG.sync.read(await page.screenshot({ clip: rect }));
  const quadStat = (x0, y0, x1, y1) => {
    const vals = [];
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * png.width + x) * 4;
        vals.push(0.2126 * png.data[o] + 0.7152 * png.data[o + 1] + 0.0722 * png.data[o + 2]);
      }
    }
    const m = vals.reduce((a, b) => a + b, 0) / vals.length;
    return { mean: m, variance: vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length };
  };
  // 找一块「内部方差最小」的 18×18 CSS 区（= 6×6 个样本，必然落在同一区域内）
  let minVar = Infinity, minAt = null;
  for (let y = 6; y < png.height - 24; y += 6) {
    for (let x = 6; x < png.width - 24; x += 6) {
      const s = quadStat(x, y, x + 18, y + 18);
      if (s.variance < minVar) { minVar = s.variance; minAt = { x, y, ...s }; }
    }
  }
  console.log('MINIMAP PIXELATED STATS:', JSON.stringify({ spotKinds: spot.kinds, minVar, minAt }));
  // 硬边色块内部：亮度只因抖动变化（±6/通道 → 方差上限约 36）；
  // bilinear 放大每格都会插入中间值，方差会翻几倍。阀值取 100（实测值见上）。
  expect(minVar).toBeLessThan(100);
});
