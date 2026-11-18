// tests/water-reflect.spec.mjs — 水面倒影（v3.17 / v3.17b，Tier 4 像素实测）
//
// 钉四件「数值判据抓不到」的事：
//   ① **主画面不被撕碎**：反射 pass 若后置，BatchedMesh 的 indirect 索引表被覆写 ⇒
//      地平线以上整片天空撕成黑多边形。调研实测近黑占比 1.26% → 11.66%，而
//      draw call / 三角数 / 帧时 / uniform 值**全对** ⇒ 只有像素能抓。
//   ② **倒影真的出现**：隐藏反射（strength=0）必须显著改变水区像素。
//   ③ **高度衰减**（v3.17b 用户要求）：相机升高 ⇒ 水区倒影贡献单调下降，
//      且超过归零高度后**反射 pass 完全不跑**（性能门，读 refreshes 计数）。
//   ④ **开关零回归**：关闭后与「无倒影」逐像素相同。
//
// ⚠️ 机位按数据选（不凭感觉）：浅水高台 02 号在 (655,138)，其西南岸 (616,158)
// 自然地表 h=8 ⇒ 站上去朝东北俯视，视野里既有大片水面又有竖直高台（倒影的载体）。
import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

const SEED = 12345;
const STAND = { x: 616, z: 158 };
const TARGET = { x: 655, z: 138 };
const YAW = Math.atan2(-(TARGET.x - STAND.x), -(TARGET.z - STAND.z));

const queueConverged = () => {
  const s = window.__MC_GAME__.scheduler;
  return s._inflightGen.size === 0 && s._meshQueue.length === 0 && s._inflightMesh.size === 0 &&
    s._uploadQueue.length === 0 && s._pendingMesh.size === 0 && s._lightQueue.size === 0 &&
    s._inflightLight.size === 0;
};

/** 近黑像素占比（撕碎缺陷的判别指标）。分上半屏与全屏两个口径。 */
function darkStats(png) {
  let all = 0, top = 0, topN = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const o = (y * png.width + x) * 4;
      const lum = 0.2126 * png.data[o] + 0.7152 * png.data[o + 1] + 0.0722 * png.data[o + 2];
      const isTop = y < png.height * 0.4;
      if (isTop) topN++;
      if (lum < 40) { all++; if (isTop) top++; }
    }
  }
  return { blackAll: all / (png.width * png.height), blackTop: top / topN };
}

/** 水区（画面下 55%~95%，避开天空与近景 HUD）逐像素差 */
function waterDiff(a, b) {
  let n = 0, tot = 0, sum = 0;
  for (let y = Math.floor(a.height * 0.55); y < Math.floor(a.height * 0.95); y++) {
    for (let x = Math.floor(a.width * 0.08); x < Math.floor(a.width * 0.92); x++) {
      const o = (y * a.width + x) * 4;
      const d = Math.abs(a.data[o] - b.data[o])
        + Math.abs(a.data[o + 1] - b.data[o + 1])
        + Math.abs(a.data[o + 2] - b.data[o + 2]);
      if (d > 12) n++;
      sum += d;
      tot++;
    }
  }
  return { frac: n / tot, mean: sum / tot };
}

const shot = async (page) => PNG.sync.read(await page.screenshot());

async function openGame(page) {
  await page.goto(`/?seed=${SEED}&vd=8&style=noon`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 150_000 });
  await page.evaluate(() => window.__MC_GAME__.setShadowsEnabled(false));
  await page.evaluate(([px, pz]) => window.__MC_GAME__._teleportTo(px, 30, pz), [STAND.x, STAND.z]);
  await page.waitForFunction(([px, pz]) => {
    const g = window.__MC_GAME__;
    const cx = Math.floor(px / 16), cz = Math.floor(pz / 16);
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
      if (!g.world.hasColumn(cx + dx, cz + dz)) return false;
    }
    return true;
  }, [STAND.x, STAND.z], { timeout: 180_000 });
  await page.waitForFunction(queueConverged, null, { timeout: 180_000 });
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('#hud-root > *, #crosshair, #settings-btn')) {
      el.style.display = 'none';
    }
  });
}

/** 把相机钉在给定高度（物理停摆 + 朝向固定）；y 是脚底高度 */
async function pinAt(page, footY, pitch = -0.20) {
  await page.evaluate(([px, pz, py, ya, pi]) => {
    const g = window.__MC_GAME__;
    const ph = g.player.physics;
    g.player.physics.step = () => {};
    clearInterval(window.__PIN__);
    const put = () => {
      ph.pos.x = px; ph.pos.y = py; ph.pos.z = pz;
      ph.vel.x = ph.vel.y = ph.vel.z = 0;
      g.player.yaw = ya; g.player.pitch = pi;
    };
    put();
    window.__PIN__ = setInterval(put, 30);
  }, [STAND.x, STAND.z, footY, YAW, pitch]);
  await page.waitForTimeout(2500);
}

/** 冻住波纹与倒影动画（做静帧对照时噪声底才为 0） */
async function freezeAnim(page) {
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    if (!g.__origOceanUpdate) g.__origOceanUpdate = g.ocean.update.bind(g.ocean);
    g.ocean.update = () => {};
  });
  await page.waitForTimeout(700);
}
async function unfreezeAnim(page) {
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    if (g.__origOceanUpdate) g.ocean.update = g.__origOceanUpdate;
  });
  await page.waitForTimeout(700);
}

test('水面倒影：主画面不被撕碎 + 倒影真的出现 + 关闭零回归', async ({ page }) => {
  test.setTimeout(600_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await openGame(page);
  await pinAt(page, 11);          // 相对水面 12.5+1.62 ≈ 14 格 → 满强度区内
  await freezeAnim(page);

  // ---- ① 主画面完整性：开倒影 vs 关倒影，近黑占比不得上升 ----
  await page.evaluate(() => window.__MC_GAME__.setReflectEnabled(true));
  await page.waitForTimeout(1200);
  const onShot = await shot(page);
  const onDark = darkStats(onShot);

  await page.evaluate(() => window.__MC_GAME__.setReflectEnabled(false));
  await page.waitForTimeout(1200);
  const offShot = await shot(page);
  const offDark = darkStats(offShot);

  console.log('REFLECT DARK', JSON.stringify({ on: onDark, off: offDark }));
  // 判别力：调研实测撕碎态 blackTop 0.1166 / 正常 0.0126（9.3×）。
  // 阈值取 0.05 —— 距正常态 4×、距撕碎态 2.3×，两侧都不贴线。
  expect(onDark.blackTop, `开倒影后上半屏近黑占比 ${onDark.blackTop.toFixed(4)}（撕碎态实测 0.1166，正常 0.0126）`)
    .toBeLessThan(0.05);
  // 相对判据：开倒影不得比关倒影多出显著黑块（绝对阈值可能被机位地形影响）
  expect(onDark.blackAll, `开倒影的全屏近黑占比 ${onDark.blackAll.toFixed(4)} 不得超过关闭态 ${offDark.blackAll.toFixed(4)} + 0.01`)
    .toBeLessThan(offDark.blackAll + 0.01);

  // ---- ② 判别力：倒影必须真的改变水区画面 ----
  const signal = waterDiff(offShot, onShot);
  // 噪声底：同状态连拍两张
  await page.waitForTimeout(400);
  const offShot2 = await shot(page);
  const noise = waterDiff(offShot, offShot2);
  console.log('REFLECT SIGNAL', JSON.stringify({ signal, noise }));
  expect(noise.frac, `噪声底必须近零（动画已冻），实测 ${noise.frac.toFixed(4)}`).toBeLessThan(0.01);
  expect(signal.frac, `开关倒影必须显著改变水区（实测判别力），signal=${signal.frac.toFixed(4)}`)
    .toBeGreaterThan(0.05);

  // ---- ③ 关闭零回归：关闭态两张必须逐像素相同 ----
  expect(noise.frac, '关闭倒影后画面必须稳定（无残留反射 pass 写坏主画面）').toBe(0);

  // ---- ④ 反射真的在跑，且 RT 尺寸符合配置 ----
  const st = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    g.setReflectEnabled(true);
    const r = g.ocean.reflect;
    const rt = [...r.renderTargets.values()][0];
    return { refreshes: g.reflectScheduler.refreshes, rt: rt ? { w: rt.width, h: rt.height } : null };
  });
  expect(st.rt, '反射 RT 必须已创建').not.toBeNull();
  expect(st.refreshes, '反射 pass 必须真的跑过').toBeGreaterThan(0);
  expect(errors, `运行期错误：${errors.slice(0, 3).join(' | ')}`).toEqual([]);
});

test('水面倒影：相机升高时倒影越来越弱，超过阈值完全消失且 pass 停跑', async ({ page }) => {
  test.setTimeout(600_000);
  await openGame(page);

  // 三档高度：满强度区内 / 衰减中段 / 归零之上。
  // 水面 −1.5，眼高 1.62 ⇒ 相对高度 = footY + 1.62 + 1.5
  const H = await page.evaluate(async () => {
    const m = await import('/src/render/water-reflect-config.js');
    return { full: m.REFLECT_HEIGHT_FULL, zero: m.REFLECT_HEIGHT_ZERO };
  });
  const midRel = (H.full + H.zero) / 2;
  const cases = [
    { tag: 'low', rel: H.full - 4 },
    { tag: 'mid', rel: midRel },
    { tag: 'high', rel: H.zero + 12 },
  ].map((c) => ({ ...c, footY: c.rel - 1.62 - 1.5 }));

  const readings = [];
  for (const c of cases) {
    await pinAt(page, c.footY, -0.34);   // 略俯，保证水面在视野内
    await freezeAnim(page);
    // 同一机位下量「开/关倒影」的水区差 = 该高度的倒影贡献
    await page.evaluate(() => window.__MC_GAME__.setReflectEnabled(true));
    await page.waitForTimeout(1300);
    const on = await shot(page);
    await page.evaluate(() => window.__MC_GAME__.setReflectEnabled(false));
    await page.waitForTimeout(1300);
    const off = await shot(page);
    const contrib = waterDiff(off, on);
    const st = await page.evaluate(() => {
      const g = window.__MC_GAME__;
      return {
        fade: g.ocean.uReflectHeightFade.value,
        camY: g.camera.position.y,
      };
    });
    // 性能门：归零档下让反射重新开启，观察 refreshes 是否还在涨
    const gate = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      g.setReflectEnabled(true);
      const a = g.reflectScheduler.refreshes;
      await new Promise((r) => setTimeout(r, 1200));
      return g.reflectScheduler.refreshes - a;
    });
    readings.push({ tag: c.tag, rel: c.rel, fade: st.fade, camY: st.camY, contrib: contrib.frac, mean: contrib.mean, newRefreshes: gate });
    console.log('HEIGHT', c.tag, JSON.stringify(readings[readings.length - 1]));
    await unfreezeAnim(page);
  }

  const [low, mid, high] = readings;
  // fade 单调下降（这是 uniform 侧，Tier 1 已钉纯函数；这里钉它真的接上了）
  expect(low.fade, `低空 fade 应为 1，实得 ${low.fade}`).toBeCloseTo(1, 5);
  expect(mid.fade, `中段 fade 应在 (0,1)，实得 ${mid.fade}`).toBeGreaterThan(0.05);
  expect(mid.fade).toBeLessThan(0.95);
  expect(high.fade, `高空 fade 应为 0，实得 ${high.fade}`).toBe(0);

  // 画面侧：倒影贡献必须单调下降（mean 是逐像素三通道差均值，比 frac 更稳）
  expect(low.mean, `低空倒影贡献 ${low.mean.toFixed(2)} 必须强于中段 ${mid.mean.toFixed(2)}`)
    .toBeGreaterThan(mid.mean);
  expect(mid.mean, `中段倒影贡献 ${mid.mean.toFixed(2)} 必须强于高空 ${high.mean.toFixed(2)}`)
    .toBeGreaterThan(high.mean);
  // 高空必须真的没有倒影（贡献接近 0）
  expect(high.mean, `超过归零高度后倒影必须消失，实测贡献 ${high.mean.toFixed(3)}`).toBeLessThan(0.5);

  // 性能门：低空必须还在刷，高空必须完全停
  expect(low.newRefreshes, '低空反射 pass 必须在刷').toBeGreaterThan(0);
  expect(high.newRefreshes, `高空反射 pass 必须停跑（实测新增 ${high.newRefreshes} 次）`).toBe(0);
});

test('水面倒影：常驻调参坞九个控件实时生效', async ({ page }) => {
  test.setTimeout(600_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openGame(page);
  // 本用例要看见坞 ⇒ 恢复 HUD 显示
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('#hud-root > *')) el.style.display = '';
    document.getElementById('settings-btn').style.display = '';
  });
  await pinAt(page, 11);

  const dock = await page.evaluate(() => {
    const el = document.getElementById('mc-reflect-dock');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const ids = ['strength', 'tint', 'blur', 'distort', 'graze', 'heightFull', 'heightZero', 'scale', 'every'];
    return {
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      sliders: ids.map((k) => {
        const i = document.getElementById(`rd-${k}`);
        return i ? { k, value: Number(i.value), min: Number(i.min), max: Number(i.max) } : null;
      }),
      buttons: ['rd-toggle', 'rd-reset', 'rd-preset'].map((id) => !!document.getElementById(id)),
      zIndex: Number(getComputedStyle(el).zIndex),
      folded: el.classList.contains('rd-folded'),
      foldMark: el.querySelector('.rd-fold').textContent,
    };
  });
  expect(dock, '常驻调参坞必须存在').not.toBeNull();
  // ⚠️ **默认折起**（用户 2026-11-18 裁定「水面倒影的 HUD 面板默认关闭」）。
  // 但它必须**仍在场且可点开** —— 彻底隐藏会让这个功能失去唯一入口。
  expect(dock.folded, '坞启动时必须默认折起').toBe(true);
  expect(dock.foldMark, '折起时图标必须是 ＋').toBe('+');
  const collapsedH = dock.rect.h;
  expect(collapsedH, `折起时只应剩标题条（实测 ${collapsedH}px），不得仍是完整面板`)
    .toBeLessThan(60);
  // 展开后才是完整面板（后续用例都在展开态下量）
  await page.evaluate(() => document.querySelector('#mc-reflect-dock .rd-head').click());
  await page.waitForTimeout(500);
  const expanded = await page.evaluate(() => {
    const el = document.getElementById('mc-reflect-dock');
    return { folded: el.classList.contains('rd-folded'), h: el.getBoundingClientRect().height,
      mark: el.querySelector('.rd-fold').textContent };
  });
  expect(expanded.folded, '点标题条必须能展开').toBe(false);
  expect(expanded.mark).toBe('−');
  expect(expanded.h, '展开后面板必须真的长开').toBeGreaterThan(collapsedH * 2);

  expect(dock.sliders.filter(Boolean).length, '必须有九个滑块').toBe(9);
  expect(dock.buttons.every(Boolean), '开关/复位/换档三个按钮都必须在').toBe(true);
  // 层级：50（常驻信息层），必须低于设置面板 70 与背包 80
  expect(dock.zIndex).toBe(50);
  // 在视口内、不与左下迷你地图重叠
  const vp = page.viewportSize();
  expect(dock.rect.x + dock.rect.w).toBeLessThanOrEqual(vp.width + 1);
  expect(dock.rect.y + dock.rect.h).toBeLessThanOrEqual(vp.height + 1);
  const mm = await page.evaluate(() => {
    const r = document.getElementById('mc-minimap')?.getBoundingClientRect();
    return r ? { x: r.x, right: r.right } : null;
  });
  if (mm) expect(dock.rect.x, '坞在右下，不得与左下迷你地图重叠').toBeGreaterThan(mm.right);

  // ---- 布局可达性：四个视口下控件都不得被裁掉/重叠 ----
  // ⚠️ **手机竖屏必须单独钉不重叠**：初版只在 820 档钉了它，390×780 实测
  // overlapsHotbar=**true**（快捷栏居中且几乎占满宽 ⇒ 右下角必定压它）—— 漏网。
  // 修法：≤560px 改靠右上（top:104px，避开坐标面板）。
  for (const vp of [{ width: 1280, height: 720 }, { width: 1280, height: 560 }, { width: 820, height: 620 }, { width: 390, height: 780 }]) {
    await page.setViewportSize(vp);
    await page.waitForTimeout(900);
    const geo = await page.evaluate(() => {
      const d = document.getElementById('mc-reflect-dock');
      const body = d.querySelector('.rd-body');
      const r = d.getBoundingClientRect();
      const ids = ['strength', 'tint', 'blur', 'distort', 'graze', 'heightFull', 'heightZero', 'scale', 'every'];
      const items = ids.map((k) => {
        const b = document.getElementById(`rd-${k}`).getBoundingClientRect();
        return b.width > 40 && b.height > 8;
      });
      body.scrollTop = body.scrollHeight;
      const last = document.getElementById('rd-preset').getBoundingClientRect();
      const br = body.getBoundingClientRect();
      const reachable = last.bottom <= br.bottom + 1 && last.top >= br.top - 1;
      body.scrollTop = 0;
      const hit = (o) => o ? !(r.x >= o.right || r.right <= o.x || r.y >= o.bottom || r.bottom <= o.y) : false;
      const box = (sel) => {
        const e = document.querySelector(sel);
        if (!e) return null;
        const b = e.getBoundingClientRect();
        return [Math.round(b.x), Math.round(b.y), Math.round(b.right), Math.round(b.bottom)];
      };
      return {
        dockBox: [Math.round(r.x), Math.round(r.y), Math.round(r.right), Math.round(r.bottom)],
        hotbarBox: box('#mc-hotbar'), minimapBox: box('#mc-minimap'),
        inViewport: r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 && r.x >= -1 && r.y >= -1,
        allItems: items.every(Boolean), reachable,
        overlapsMinimap: hit(document.getElementById('mc-minimap')?.getBoundingClientRect()),
        overlapsHotbar: hit(document.getElementById('mc-hotbar')?.getBoundingClientRect()),
        hScroll: document.documentElement.scrollWidth > innerWidth,
      };
    });
    console.log(`DOCK-LAYOUT ${vp.width}x${vp.height}`, JSON.stringify(geo));
    expect(geo.inViewport, `${vp.width}×${vp.height}：坞必须完整在视口内`).toBe(true);
    expect(geo.allItems, `${vp.width}×${vp.height}：九个滑块都不得被裁掉`).toBe(true);
    expect(geo.reachable, `${vp.width}×${vp.height}：滚到底后「换档」必须完整可见`).toBe(true);
    expect(geo.overlapsMinimap, `${vp.width}×${vp.height}：不得压迷你地图`).toBe(false);
    expect(geo.overlapsHotbar, `${vp.width}×${vp.height}：不得压快捷栏`).toBe(false);
    expect(geo.hScroll, `${vp.width}×${vp.height}：不得出现横向滚动`).toBe(false);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForTimeout(600);

  // 逐个拖动滑块 → 对应 uniform / 字段必须真的变
  const applied = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const set = (k, v) => {
      const i = document.getElementById(`rd-${k}`);
      i.value = String(v);
      i.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const out = {};
    set('strength', 0.83); out.strength = g.ocean.uReflectStrength.value;
    set('tint', 0.66); out.tint = g.ocean.uReflectTint.value;
    set('blur', 4); out.blur = g.ocean.uReflectMip.value;
    set('distort', 0.05); out.distort = g.ocean.uReflectDistort.value;
    set('graze', 0.9); out.graze = g.ocean.uReflectGraze.value;
    set('heightFull', 30); out.full = g._reflectHeightFull;
    set('heightZero', 90); out.zero = g._reflectHeightZero;
    set('scale', 0.6); out.scale = g.ocean.reflect.resolutionScale;
    set('every', 5); out.every = g.reflectScheduler.every;
    // 读数文本必须跟着变（不是只改了内部值）
    out.labelStrength = document.getElementById('rd-val-strength').textContent;
    out.labelEvery = document.getElementById('rd-val-every').textContent;
    return out;
  });
  expect(applied.strength).toBeCloseTo(0.83, 5);
  expect(applied.tint).toBeCloseTo(0.66, 5);
  expect(applied.blur).toBe(4);
  expect(applied.distort).toBeCloseTo(0.05, 5);
  expect(applied.graze).toBeCloseTo(0.9, 5);
  expect(applied.full).toBe(30);
  expect(applied.zero).toBe(90);
  expect(applied.scale).toBeCloseTo(0.6, 5);
  expect(applied.every).toBe(5);
  expect(applied.labelStrength).toBe('83%');
  expect(applied.labelEvery).toBe('5 帧');

  // 两个高度阈值互相钳制：把 full 拉到 zero 之上，必须钳住且两个滑块同步
  const clamp = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const i = document.getElementById('rd-heightFull');
    i.value = '150';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return {
      full: g._reflectHeightFull, zero: g._reflectHeightZero,
      sliderFull: Number(document.getElementById('rd-heightFull').value),
      sliderZero: Number(document.getElementById('rd-heightZero').value),
    };
  });
  expect(clamp.full, 'full 必须被钳到 zero 之下').toBeLessThan(clamp.zero);
  expect(clamp.sliderFull, '滑块必须回写成真实生效值').toBe(clamp.full);
  expect(clamp.sliderZero).toBe(clamp.zero);

  // 复位：全部回到设计默认
  const reset = await page.evaluate(async () => {
    const m = await import('/src/render/water-reflect-config.js');
    document.getElementById('rd-reset').click();
    const g = window.__MC_GAME__;
    return {
      strength: g.ocean.uReflectStrength.value, wantStrength: m.REFLECT_STRENGTH,
      tint: g.ocean.uReflectTint.value, wantTint: m.REFLECT_TINT,
      blur: g.ocean.uReflectMip.value, wantBlur: m.REFLECT_MIP_LEVEL,
      every: g.reflectScheduler.every, wantEvery: m.REFLECT_REFRESH_EVERY,
      full: g._reflectHeightFull, wantFull: m.REFLECT_HEIGHT_FULL,
    };
  });
  expect(reset.strength).toBeCloseTo(reset.wantStrength, 5);
  expect(reset.tint).toBeCloseTo(reset.wantTint, 5);
  expect(reset.blur).toBe(reset.wantBlur);
  expect(reset.every).toBe(reset.wantEvery);
  expect(reset.full).toBe(reset.wantFull);

  // 开关按钮：文案与状态同步，且真的停掉 pass
  const toggled = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const b = document.getElementById('rd-toggle');
    b.click();
    const offState = { enabled: g._reflectEnabled, label: b.textContent, strength: g.ocean.uReflectStrength.value };
    const a = g.reflectScheduler.refreshes;
    await new Promise((r) => setTimeout(r, 900));
    offState.newRefreshes = g.reflectScheduler.refreshes - a;
    b.click();
    offState.backOn = g._reflectEnabled;
    offState.labelOn = b.textContent;
    return offState;
  });
  expect(toggled.enabled).toBe(false);
  expect(toggled.label).toBe('已关闭');
  expect(toggled.strength, '关闭时混合强度必须归零（逐位回到原式）').toBe(0);
  expect(toggled.newRefreshes, '关闭时反射 pass 必须停跑').toBe(0);
  expect(toggled.backOn).toBe(true);
  expect(toggled.labelOn).toBe('已开启');

  // 折叠 / 展开
  const fold = await page.evaluate(() => {
    const el = document.getElementById('mc-reflect-dock');
    // 进入时是展开态（本用例开头已展开）⇒ 第一次点击应折起，第二次展开
    el.querySelector('.rd-head').click();
    const a = { folded: el.classList.contains('rd-folded'), mark: el.querySelector('.rd-fold').textContent };
    el.querySelector('.rd-head').click();
    a.unfolded = !el.classList.contains('rd-folded');
    a.markAfter = el.querySelector('.rd-fold').textContent;
    return a;
  });
  expect(fold.folded).toBe(true);
  expect(fold.mark).toBe('+');
  expect(fold.unfolded).toBe(true);
  expect(fold.markAfter).toBe('−');

  // 换档：三档循环，每档都真的改了参数
  const preset = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const b = document.getElementById('rd-preset');
    const seen = [];
    for (let i = 0; i < 3; i++) {
      b.click();
      seen.push({ blur: g.ocean.uReflectMip.value, every: g.reflectScheduler.every });
    }
    return seen;
  });
  const uniq = new Set(preset.map((p) => `${p.blur}/${p.every}`));
  expect(uniq.size, `三档预设必须互不相同，实得 ${JSON.stringify(preset)}`).toBe(3);

  expect(errors, `运行期错误：${errors.slice(0, 3).join(' | ')}`).toEqual([]);
});