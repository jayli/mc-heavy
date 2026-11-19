// tests/cinder-fall.spec.mjs — 第三秒大招 Cinder Fall 的 E2E + Tier 4 像素实测（v3.21）
//
// 设计：docs/superpowers/specs/2026-11-19-cinder-fall-staged-charge-design.md
//
// ## 为什么必须像素实测（AGENTS.md Tier 4）
//
// 岩石与爆壳全在 GPU 求值。数据层（`cinderDebugState().rocks`、`meshes[i].visible`）对，
// **画面仍可能全错**：
//   · TSL 常量色写成 `vec3(new THREE.Color(hex))` ⇒ 整片 pass 纯黑且零报错（v3.14 实测）；
//   · `vertexNode` 漏设 ⇒ 参数化几何缩在原点一个像素里；
//   · 忘了 `fog:false` ⇒ 远处岩石被雾洗成天空色；
//   · 光晕贴图没接上 ⇒ 只是块灰石头，不是「燃烧的岩石」。
// 这些缺陷下**所有计数类判据全绿**。
//
// ## ⚠️ 三条既有教训（照搬 storm-lance.spec 的口径）
//   · 量 draw call 必须 `?shadows=0&reflect=0`（不关倒影会把反射 pass 算进同一计数）；
//   · 两侧先藏 `viewWeapon.node`（宿主噪声源）；
//   · 阈值在 **1280×720**（Playwright 默认 viewport）下标定，自设别的尺寸会稀释占比。
import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

const SEED = 12345;
/** 按下 → 静默 1s → 第一段 1s ⇒ 2s 进第三秒。取 2.4s 留余量 */
const HOLD_CINDER_MS = 2400;
/** 第二秒内松手 ⇒ Storm Lance（v3.21 阶段门：进入那一秒就能发） */
const HOLD_LANCE_MS = 1500;
/** 飞行 20/18≈1.11s + 落点视觉 ⇒ 3s 后应完全回基线 */
const SETTLE_MS = 3400;

async function waitWorldReady(page) {
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
}

/** 开阔地（远离城市，建筑遮挡会让判定与像素都不稳） */
async function gotoOpenField(page, { ox = 1200, oz = 1200 } = {}) {
  await page.evaluate(async ([dx, dz]) => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    g._teleportTo(Math.floor(p.x) + dx, 45, Math.floor(p.z) + dz);
    await new Promise((r) => setTimeout(r, 3000));
  }, [ox, oz]);
}

/** 选剑 + 平视 + 藏 HUD/剑体 + 冻住场景动态（像素用例的前置） */
async function setupVisual(page) {
  await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    await g.selectWeapon('sword');
    await new Promise((r) => setTimeout(r, 800));
    g.player.setTestAim([0, -0.08, -1]);
    for (const el of document.querySelectorAll('#hud-root > *')) el.style.display = 'none';
    const sb = document.getElementById('settings-btn'); if (sb) sb.style.display = 'none';
    const ch = document.getElementById('crosshair'); if (ch) ch.style.display = 'none';
    const ring = document.getElementById('mc-charge-ring'); if (ring) ring.style.display = 'none';
    g.player.viewWeapon.node.visible = false;
    g.ocean.update = () => {};
    g.dayNight.update = () => {};
    if (g.sky) { g.sky.sunSprite.visible = false; g.sky.moonSprite.visible = false; }
    await new Promise((r) => setTimeout(r, 500));
  });
}

async function installHelpers(page) {
  await page.evaluate(() => {
    window.__CF__ = {
      /** 找一处可站立的空地（照 storm-lance.spec 的同名助手） */
      legalSpawnNear(distance) {
        const g = window.__MC_GAME__;
        const p = g.player.physics.pos;
        for (let r = distance; r <= distance + 14; r++) {
          for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r]]) {
            const x = Math.floor(p.x) + dx, z = Math.floor(p.z) + dz;
            for (let y = Math.floor(p.y); y >= Math.floor(p.y) - 64; y--) {
              if (g.world.getBlockId(x, y, z) === 0
                && g.world.getBlockId(x, y + 1, z) === 0
                && g.world.isSolid(x, y - 1, z)) return [x + 0.5, y, z + 0.5];
            }
          }
        }
        throw new Error('no legal cinder fixture position');
      },
      /** 蓄力并松手，返回指定类型的事件（走真实 controller 路径） */
      async chargeAndFire(holdMs, type = 'cinder-fall') {
        const g = window.__MC_GAME__;
        g.player.weaponController.pointerDown(g.player._buildAim());
        await new Promise((r) => setTimeout(r, holdMs));
        const effects = g.player.weaponController.pointerUp(g.player._buildAim());
        return effects.find((e) => e.type === type) ?? null;
      },
    };
  });
}

/**
 * 差分统计：总差分数 / **暖色簇** / 近白数。
 *
 * ⚠️ 暖色判据 `r > b + 25 && r > 60`：Cinder 是炽橙（r 显著高于 b）。
 * 只用「变亮了」会把天空/地形边缘算进来（storm-lance 的蓝簇判据同理）。
 */
function diffStats(before, after) {
  const a = PNG.sync.read(before);
  const b = PNG.sync.read(after);
  let diff = 0, warm = 0, nearWhite = 0;
  let sumX = 0, sumY = 0, warmCount = 0;
  for (let i = 0, p = 0; i < a.data.length; i += 4, p++) {
    const dr = b.data[i] - a.data[i];
    const dg = b.data[i + 1] - a.data[i + 1];
    const db = b.data[i + 2] - a.data[i + 2];
    if (Math.abs(dr) + Math.abs(dg) + Math.abs(db) > 12) {
      diff++;
      if (dr > db + 25 && b.data[i] > 60) {
        warm++;
        sumX += p % a.width; sumY += Math.floor(p / a.width); warmCount++;
      }
    }
    if (b.data[i] > 245 && b.data[i + 1] > 245 && b.data[i + 2] > 245) nearWhite++;
  }
  return {
    diff, warm, nearWhite, total: a.width * a.height,
    cx: warmCount ? sumX / warmCount : -1,
    cy: warmCount ? sumY / warmCount : -1,
  };
}

test.describe('Cinder Fall（v3.21）', () => {
  test('阶段门：1.5s 松手发 Storm Lance，2.4s 松手发 Cinder Fall', async ({ page }) => {
    await page.goto(`/?seed=${SEED}&vd=4&shadows=0&reflect=0`);
    await waitWorldReady(page);
    await installHelpers(page);
    const r = await page.evaluate(async ([hL, hC]) => {
      const g = window.__MC_GAME__;
      await g.selectWeapon('sword');
      await new Promise((res) => setTimeout(res, 600));
      const lance = await window.__CF__.chargeAndFire(hL, 'storm-lance');
      const afterLance = g.cinderDebugState();
      await new Promise((res) => setTimeout(res, 3200));   // 等冷却
      const cinder = await window.__CF__.chargeAndFire(hC, 'cinder-fall');
      await new Promise((res) => setTimeout(res, 120));
      const afterCinder = g.cinderDebugState();
      return {
        lanceFired: !!lance, cinderFired: !!cinder,
        rocksAfterLance: afterLance.rocks, rocksAfterCinder: afterCinder.rocks,
        stage: afterCinder.stage,
      };
    }, [HOLD_LANCE_MS, HOLD_CINDER_MS]);
    expect(r.lanceFired, '第二秒松手必须发 Storm Lance').toBe(true);
    expect(r.rocksAfterLance, 'Storm Lance 不得生成岩石').toBe(0);
    expect(r.cinderFired, '第三秒松手必须发 Cinder Fall').toBe(true);
    expect(r.rocksAfterCinder, 'Cinder Fall 必须真的生成了飞行岩石').toBeGreaterThan(0);
  });

  test('接线：事件真的走到装配层（不是只发了事件就完事）', async ({ page }) => {
    await page.goto(`/?seed=${SEED}&vd=4&shadows=0&reflect=0`);
    await waitWorldReady(page);
    await installHelpers(page);
    const r = await page.evaluate(async (holdMs) => {
      const g = window.__MC_GAME__;
      await g.selectWeapon('sword');
      await new Promise((res) => setTimeout(res, 600));
      g.player.setTestAim([0, -0.08, -1]);
      // ⚠️⚠️ **这条专抓「事件发了但没人消费」**（本轮实测踩到）：
      // controller 造出 cinder-fall 事件、音效也响了，但 `player._applyWeaponEffect`
      // 漏了这一支 ⇒ 落到通用分支（只认 tracer/impacts）⇒ **天上没岩石**。
      // 只断言「事件存在」的用例对这类缺陷零判别力。
      const hookInstalled = typeof g.player.onCinderLaunch === 'function';
      const b0 = g.cinderDebugState().rocks;
      const ev = await window.__CF__.chargeAndFire(holdMs);
      const rocksRightAfter = g.cinderDebugState().rocks - b0;
      return { hookInstalled, fired: !!ev, rocksRightAfter };
    }, HOLD_CINDER_MS);
    expect(r.hookInstalled, '装配层必须注入 onCinderLaunch').toBe(true);
    expect(r.fired, 'controller 必须发出事件').toBe(true);
    expect(r.rocksRightAfter, '事件必须真的生成了岩石（松手同帧）').toBeGreaterThan(0);
  });

  test('短按只挥剑：两招都不发', async ({ page }) => {
    await page.goto(`/?seed=${SEED}&vd=4&shadows=0&reflect=0`);
    await waitWorldReady(page);
    await installHelpers(page);
    const r = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      await g.selectWeapon('sword');
      await new Promise((res) => setTimeout(res, 600));
      const c = await window.__CF__.chargeAndFire(400, 'cinder-fall');
      const l = await window.__CF__.chargeAndFire(400, 'storm-lance');
      return { cinder: !!c, lance: !!l, rocks: g.cinderDebugState().rocks };
    });
    expect(r.cinder).toBe(false);
    expect(r.lance).toBe(false);
    expect(r.rocks).toBe(0);
  });

  test('命中丧尸：扣一次 50 且岩石消失（不穿身）', async ({ page }) => {
    await page.goto(`/?seed=${SEED}&vd=4&shadows=0&reflect=0`);
    await waitWorldReady(page);
    await installHelpers(page);
    const r = await page.evaluate(async (holdMs) => {
      const g = window.__MC_GAME__;
      await g.selectWeapon('sword');
      await new Promise((res) => setTimeout(res, 600));
      const pos = window.__CF__.legalSpawnNear(8);
      const id = g.zombies.spawn(pos, { source: 'test' });
      const cam = g.camera.position.toArray();
      g.player.setTestAim([pos[0] - cam[0], pos[1] + 0.9 - cam[1], pos[2] - cam[2]]);
      g.zombies.update = () => {};
      const h0 = g.zombies.get(id).health;
      const b0 = g.cinderDebugState().blasts;
      const ev = await window.__CF__.chargeAndFire(holdMs);
      // 飞 8 格约 0.45s，留足余量
      await new Promise((res) => setTimeout(res, 1200));
      return {
        fired: !!ev, h0, h1: g.zombies.get(id)?.health ?? null,
        blasts: g.cinderDebugState().blasts - b0,
        rocks: g.cinderDebugState().rocks,
      };
    }, HOLD_CINDER_MS);
    expect(r.fired, '必须真的抛出了').toBe(true);
    expect(r.blasts, '必须炸了一次').toBe(1);
    expect(r.h1, '丧尸必须掉血（100 → 50 或直接死）').toBeLessThan(r.h0);
    expect(r.h0 - r.h1, '掉血幅度必须 = 一颗炸弹（50）').toBe(50);
    expect(r.rocks, '命中后岩石必须消失').toBe(0);
  });

  test('不破坏方块（即使 gunBlockDamage 开着）', async ({ page }) => {
    await page.goto(`/?seed=${SEED}&vd=4&shadows=0&reflect=0`);
    await waitWorldReady(page);
    await installHelpers(page);
    const r = await page.evaluate(async (holdMs) => {
      const g = window.__MC_GAME__;
      await g.selectWeapon('sword');
      await new Promise((res) => setTimeout(res, 600));
      g.setGunBlockDamage(true);
      g.player.setTestAim([0, -0.3, -1]);
      await new Promise((res) => setTimeout(res, 100));
      // ⚠️ **直接采样真实方块**，不用 `worldStats().edits`（那个字段不存在，
      // 两侧都是 undefined ?? 0 ⇒ 恒真，零判别力）—— 照 storm-lance.spec 同手法。
      const p = g.player.physics.pos;
      const cells = [];
      for (let d = 2; d <= 20; d++) {
        for (let dy = -3; dy <= 1; dy++) {
          const x = Math.floor(p.x), y = Math.floor(p.y) + dy, z = Math.floor(p.z) - d;
          cells.push([x, y, z, g.world.getBlockId(x, y, z)]);
        }
      }
      const ev = await window.__CF__.chargeAndFire(holdMs);
      await new Promise((res) => setTimeout(res, 2000));
      const changed = cells.filter(([x, y, z, id]) => g.world.getBlockId(x, y, z) !== id);
      return { fired: !!ev, changed: changed.length, sampled: cells.length };
    }, HOLD_CINDER_MS);
    expect(r.fired).toBe(true);
    expect(r.sampled, '必须真的采样了方块').toBeGreaterThan(50);
    expect(r.changed, 'Cinder Fall 绝不能改任何方块').toBe(0);
  });

  test('draw call：空闲=基线 / 飞行中增加 / 结束后回基线', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto(`/?seed=${SEED}&vd=6&shadows=0&reflect=0`);
    await waitWorldReady(page);
    await gotoOpenField(page);
    await installHelpers(page);
    const r = await page.evaluate(async ([holdMs, settleMs]) => {
      const g = window.__MC_GAME__;
      await g.selectWeapon('sword');
      await new Promise((res) => setTimeout(res, 900));
      g.player.setTestAim([0, -0.08, -1]);
      await new Promise((res) => setTimeout(res, 400));
      const idle = g.renderStats().drawCalls;
      const idleLit = g.cinderFall.meshes.filter((m) => m.visible).length;
      await window.__CF__.chargeAndFire(holdMs);
      await new Promise((res) => setTimeout(res, 250));   // 飞行中
      const flying = g.renderStats().drawCalls;
      const flyLit = g.cinderFall.meshes.filter((m) => m.visible).length;
      await new Promise((res) => setTimeout(res, settleMs));
      const after = g.renderStats().drawCalls;
      const afterLit = g.cinderFall.meshes.filter((m) => m.visible).length;
      return { idle, idleLit, flying, flyLit, after, afterLit, state: g.cinderDebugState() };
    }, [HOLD_CINDER_MS, SETTLE_MS]);
    expect(r.idleLit, '空闲时不得有可见 mesh').toBe(0);
    expect(r.flyLit, '飞行中必须有可见 mesh').toBeGreaterThan(0);
    expect(r.flying, '飞行中 draw call 必须增加').toBeGreaterThan(r.idle);
    expect(r.afterLit, '结束后全部 mesh 必须隐藏').toBe(0);
    expect(r.state.rocks, '结束后不得残留岩石').toBe(0);
    expect(Math.abs(r.after - r.idle), `draw call 必须回基线（${r.after} vs ${r.idle}）`)
      .toBeLessThanOrEqual(2);
  });

  test('连续 3 次抛掷无泄漏（mesh 数恒定、draw call 回基线）', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto(`/?seed=${SEED}&vd=6&shadows=0&reflect=0`);
    await waitWorldReady(page);
    await gotoOpenField(page);
    await installHelpers(page);
    const r = await page.evaluate(async ([holdMs, settleMs]) => {
      const g = window.__MC_GAME__;
      await g.selectWeapon('sword');
      await new Promise((res) => setTimeout(res, 900));
      g.player.setTestAim([0, -0.08, -1]);
      await new Promise((res) => setTimeout(res, 400));
      const idle0 = g.renderStats().drawCalls;
      const rounds = [];
      for (let i = 0; i < 3; i++) {
        const ev = await window.__CF__.chargeAndFire(holdMs);
        await new Promise((res) => setTimeout(res, settleMs));
        rounds.push({
          fired: !!ev,
          rocks: g.cinderDebugState().rocks,
          lit: g.cinderFall.meshes.filter((m) => m.visible).length,
          meshes: g.cinderFall.meshes.length,
          dc: g.renderStats().drawCalls,
        });
      }
      return { idle0, rounds, sceneCount: g.scene.children.length };
    }, [HOLD_CINDER_MS, SETTLE_MS]);
    for (const [i, rd] of r.rounds.entries()) {
      expect(rd.fired, `第 ${i + 1} 次必须抛出`).toBe(true);
      expect(rd.rocks, `第 ${i + 1} 次结束后不得残留岩石`).toBe(0);
      expect(rd.lit, `第 ${i + 1} 次结束后不得有可见 mesh`).toBe(0);
      expect(rd.meshes, 'mesh 数恒为 4（岩石+光晕+爆壳+冲击环）').toBe(4);
      expect(Math.abs(rd.dc - r.idle0), `第 ${i + 1} 次 draw call 必须回基线`)
        .toBeLessThanOrEqual(2);
    }
  });
});

// ---------------------------------------------------------------- Tier 4 像素判据

test.describe('Cinder Fall 观感身份（Tier 4）', () => {
  test('岩石真的上屏，且是暖橙簇（不是纯黑 / 不是雾色）', async ({ page }) => {
    test.setTimeout(180_000);
    const errs = [];
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', (e) => errs.push(String(e)));
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`/?seed=${SEED}&vd=6&shadows=0&reflect=0`);
    await waitWorldReady(page);
    await gotoOpenField(page);
    await setupVisual(page);
    await installHelpers(page);

    const n1 = await page.screenshot();
    await page.waitForTimeout(400);
    const n2 = await page.screenshot();
    const noise = diffStats(n1, n2);

    const baseline = await page.screenshot();
    const state = await page.evaluate(async (holdMs) => {
      const g = window.__MC_GAME__;
      const ev = await window.__CF__.chargeAndFire(holdMs);
      await new Promise((r) => setTimeout(r, 250));   // 飞行中
      return { fired: !!ev, rocks: g.cinderDebugState().rocks };
    }, HOLD_CINDER_MS);
    const shot = await page.screenshot();
    const s = diffStats(baseline, shot);
    console.log('CINDER_ROCK', JSON.stringify({ noise: noise.diff, state, s }));

    expect(errs.length, `不得有 TSL/GPU 报错：${errs.slice(0, 3).join(' | ')}`).toBe(0);
    expect(state.fired, '必须真的抛出了').toBe(true);
    expect(state.rocks, '截图时岩石必须在飞').toBeGreaterThan(0);
    expect(noise.diff, `噪声底必须接近 0，实测 ${noise.diff}`).toBeLessThan(400);
    expect(s.diff, `岩石+光晕必须占一块屏幕，实测 ${s.diff}`).toBeGreaterThan(500);
    expect(s.warm, `暖橙簇必须存在，实测 ${s.warm}`).toBeGreaterThan(150);
    expect(s.nearWhite / s.total, '近白像素占比不得失控（防 additive 叠成一片白）')
      .toBeLessThan(0.06);
  });

  test('岩石在飞（两次截图暖簇质心位移），不是贴在手上的静态球', async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`/?seed=${SEED}&vd=6&shadows=0&reflect=0`);
    await waitWorldReady(page);
    await gotoOpenField(page);
    await setupVisual(page);
    await installHelpers(page);
    const base = await page.screenshot();
    const r = await page.evaluate(async (holdMs) => {
      const g = window.__MC_GAME__;
      await window.__CF__.chargeAndFire(holdMs);
      await new Promise((res) => setTimeout(res, 150));
      const p1 = g.entities.entities();
      let pos1 = null;
      for (const e of p1) if (e.type === 'cinder') pos1 = [...e.state.position];
      return { pos1 };
    }, HOLD_CINDER_MS);
    const shot1 = await page.screenshot();
    await page.waitForTimeout(300);
    const shot2 = await page.screenshot();
    const s1 = diffStats(base, shot1);
    const s2 = diffStats(base, shot2);
    const move = Math.hypot(s2.cx - s1.cx, s2.cy - s1.cy);
    console.log('CINDER_FLIGHT', JSON.stringify({ s1, s2, move }));
    expect(s1.warm, '第一帧必须有暖簇').toBeGreaterThan(100);
    expect(s2.warm, '第二帧必须有暖簇').toBeGreaterThan(100);
    expect(move, `暖簇质心必须移动（实测 ${move.toFixed(1)}px）`).toBeGreaterThan(8);
  });

  test('落点爆炸：亮像素猛增且壳内有暗区（防实心球）', async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`/?seed=${SEED}&vd=6&shadows=0&reflect=0`);
    await waitWorldReady(page);
    await gotoOpenField(page);
    await setupVisual(page);
    await installHelpers(page);
    /**
     * ⚠️⚠️ **基线必须在松手之后取**（首版这里错过，实测得到 79% 屏幕差分）：
     * 蓄力中的**暖橙光球**直径占屏很大，拿「蓄力前」当基线会把光球本身算进差分
     * ⇒ 量到的是光球而不是爆炸（同 AGENTS.md「先藏掉自带同色的宿主」那条教训）。
     */
    const st = await page.evaluate(async (holdMs) => {
      const g = window.__MC_GAME__;
      g.player.setTestAim([0, -0.55, -1]);
      const b0 = g.cinderDebugState().blasts;
      g.player.weaponController.pointerDown(g.player._buildAim());
      await new Promise((r) => setTimeout(r, holdMs));
      return { b0 };
    }, HOLD_CINDER_MS);
    const base = await page.screenshot();      // 满蓄力态（含光球）= 真正的对照基线
    const fired = await page.evaluate(async (b0) => {
      const g = window.__MC_GAME__;
      // ⚠️ **松手前重钉一次俯射角**：截图期间 viewBob/物理仍在跑，
      // 而 `_buildAim()` 读的是**当前**相机姿态 ⇒ 不重钉就沿旧的平视角抛出（飞 20 格不撞地）。
      g.player.setTestAim([0, -0.55, -1]);
      const evs = g.player.weaponController.pointerUp(g.player._buildAim());
      const ev = evs.find((e) => e.type === 'cinder-fall');
      // 实测：俯射 3.36 格 ⇒ **t≈150ms 撞地**，爆壳寿命 0.9s
      // ⇒ 等 250ms 时爆壳正在猛扩（outQuint 已过 20%）。
      await new Promise((r) => setTimeout(r, 250));
      return { fired: !!ev, blasts: g.cinderDebugState().blasts - b0, dist: ev?.launch?.distance };
    }, st.b0);
    const shot = await page.screenshot();
    const s = diffStats(base, shot);
    console.log('CINDER_BURST', JSON.stringify({ fired, s }));
    expect(fired.fired, '必须真的抛出了').toBe(true);
    expect(fired.blasts, '必须真的炸了').toBeGreaterThan(0);
    expect(s.diff, `爆炸必须占一块屏幕，实测 ${s.diff}`).toBeGreaterThan(3000);
    expect(s.warm, `爆炸暖簇必须存在，实测 ${s.warm}`).toBeGreaterThan(1000);
    // 上界：壳必须是「空」的（细弧 + rim），不是实心球
    expect(s.nearWhite / s.total, '近白占比不得失控（实心球会叠成一片白）')
      .toBeLessThan(0.10);
  });

  test('蓄力换色：第二秒冷蓝、第三秒暖橙（同机位单变量）', async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`/?seed=${SEED}&vd=6&shadows=0&reflect=0`);
    await waitWorldReady(page);
    await gotoOpenField(page);
    await setupVisual(page);
    // 关吸入粒子：本组只量光球本身的颜色
    await page.evaluate(() => { window.__MC_GAME__.stormLance._emitIntake = () => {}; });
    const base = await page.screenshot();
    const cold = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      g.player.weaponController.pointerDown(g.player._buildAim());
      await new Promise((r) => setTimeout(r, 1600));   // 第二秒内
      return { warm: g.stormLance.uniforms.uWarm.value, charge: g.stormLanceDebugState().charge };
    });
    const shotCold = await page.screenshot();
    const warm = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      await new Promise((r) => setTimeout(r, 900));    // 进第三秒
      const s = { warm: g.stormLance.uniforms.uWarm.value, orb: g.stormLance.orbMesh.scale.x };
      return s;
    });
    const shotWarm = await page.screenshot();
    await page.evaluate(() => {
      window.__MC_GAME__.player.weaponController.pointerUp(window.__MC_GAME__.player._buildAim());
    });
    const sc = diffStats(base, shotCold);
    const sw = diffStats(base, shotWarm);
    // 冷蓝：蓝显著高于红；暖橙：红显著高于蓝
    const blueOf = (before, after) => {
      const a = PNG.sync.read(before), b = PNG.sync.read(after);
      let n = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        const dr = b.data[i] - a.data[i], db = b.data[i + 2] - a.data[i + 2];
        if (Math.abs(dr) + Math.abs(b.data[i + 1] - a.data[i + 1]) + Math.abs(db) > 12
          && db > dr + 20 && b.data[i + 2] > 60) n++;
      }
      return n;
    };
    const coldBlue = blueOf(base, shotCold);
    const warmBlue = blueOf(base, shotWarm);
    console.log('CINDER_WARM', JSON.stringify({ cold, warm, sc, sw, coldBlue, warmBlue }));
    expect(cold.warm, '第二秒 uWarm 必须是 0').toBe(0);
    expect(warm.warm, '第三秒 uWarm 必须是 1').toBe(1);
    expect(coldBlue, `第二秒必须是冷蓝簇，实测 ${coldBlue}`).toBeGreaterThan(200);
    expect(sw.warm, `第三秒必须是暖橙簇，实测 ${sw.warm}`).toBeGreaterThan(200);
    expect(warmBlue, `第三秒冷蓝簇必须显著减少（${warmBlue} vs ${coldBlue}）`)
      .toBeLessThan(coldBlue * 0.5);
    expect(warm.orb, '第三秒球不得闪断（尺寸仍 > 0）').toBeGreaterThan(0.01);
  });

  test('负向对照：arc 归零 ⇒ 抛物线退化成直线（证明拱起判据有牙齿）', async ({ page }) => {
    test.setTimeout(180_000);
    // ⚠️⚠️ **route 必须在 `goto` 之前注册**（本轮实测踩到）：
    // 放在 goto 之后时模块已加载完毕，拦截永远不会触发 ⇒ arc 仍 1.5，
    // 而用例报「注入未生效」看起来像生产代码问题。对照探针里先注册后 goto 即命中。
    // ⚠️ 常量在 catalog 里 ⇒ 只能换模块内容（浏览器侧改冻结对象无效）。
    await page.route('**/weapon-catalog.js*', async (route) => {
      const res = await route.fetch();
      let body = await res.text();
      body = body.replace(/arc: 1\.5,/, 'arc: 0,');
      await route.fulfill({
        response: res, body,
        headers: { ...res.headers(), 'content-type': 'application/javascript' },
      });
    });
    await page.goto(`/?seed=${SEED}&vd=4&shadows=0&reflect=0`);
    await waitWorldReady(page);
    await installHelpers(page);
    const r = await page.evaluate(async (holdMs) => {
      const g = window.__MC_GAME__;
      await g.selectWeapon('sword');
      await new Promise((res) => setTimeout(res, 600));
      g.player.setTestAim([0, -0.08, -1]);
      await window.__CF__.chargeAndFire(holdMs);
      const ys = [];
      for (let i = 0; i < 12; i++) {
        await new Promise((res) => setTimeout(res, 50));
        for (const e of g.entities.entities()) {
          if (e.type === 'cinder') ys.push(e.state.position[1]);
        }
      }
      return { arc: g.player.weaponController.lastEffect?.launch?.arc, ys };
    }, HOLD_CINDER_MS);
    expect(r.arc, '注入必须真的生效（否则本对照零判别力）').toBe(0);
    const span = Math.max(...r.ys) - Math.min(...r.ys);
    // 平视略俯（-0.08）⇒ 直线飞行 y 单调下降，跨度很小；有拱起时会先升后降
    console.log('CINDER_ARC_NEG', JSON.stringify({ span, n: r.ys.length }));
    expect(span, `arc=0 时 y 跨度必须很小（实测 ${span.toFixed(3)}）`).toBeLessThan(1.0);
  });
});