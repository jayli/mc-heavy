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
/**
 * 飞行 20/18≈1.11s + 下落（最多 ~1.5s）+ **粒子自然衰亡窗口 3.2s**
 * ⇒ 取 7.5s 后应完全回基线。
 * ⚠️ v3.21b 加了火星/余烬/烟三个 GPU 池，它们**不随爆壳硬切**（否则尾巴上的
 * 火星凭空消失）⇒ 旧的 3.4s 不够，会在粒子仍在飞时就断言 draw call 回基线。
 */
const SETTLE_MS = 7500;

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

  /**
   * ⚠️⚠️ 用户 2026-11-19：「火球要求**碰到地面才爆炸**，而不是空中爆炸」。
   *
   * 旧口径在瞄准点 `end-of-flight` 自爆，实测离地 **4.76 格**（平视）/
   * **10.39 格**（仰视）—— 而 `blasts=1` / `rocks=0` / draw call 回基线 **全绿**。
   * ⇒ 判据必须落在**落点高度 vs 该列地面高度**上，计数类对这类缺陷零判别力。
   * 三个机位都要测：平视/仰视是缺陷形态，俯视是本来就对的对照。
   */
  test('落地才爆：平视/仰视/俯视三个机位的落点都贴地（不空中自爆）', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto(`/?seed=${SEED}&vd=4&shadows=0&reflect=0`);
    await waitWorldReady(page);
    await gotoOpenField(page);
    await installHelpers(page);
    const runs = await page.evaluate(async (holdMs) => {
      const g = window.__MC_GAME__;
      await g.selectWeapon('sword');
      await new Promise((r) => setTimeout(r, 900));
      const rec = [];
      const origBlast = g._cinderBlast.bind(g);
      g._cinderBlast = (at, kind, hitId, nowMs, normal) => {
        rec.push({ at: [...at], kind, normal: normal ? [...normal] : null });
        return origBlast(at, kind, hitId, nowMs, normal);
      };
      const out = [];
      for (const aim of [[0, -0.08, -1], [0, 0.25, -1], [0, -0.35, -1]]) {
        rec.length = 0;
        g.player.setTestAim(aim);
        await new Promise((r) => setTimeout(r, 500));
        const b0 = g.cinderDebugState().blasts;
        const ev = await window.__CF__.chargeAndFire(holdMs);
        // 飞 1.1s + 下落最多 ~2s ⇒ 给 5s
        await new Promise((r) => setTimeout(r, 5000));
        const blast = rec.find((x) => x.at);
        let groundTop = null;
        if (blast) {
          const x = Math.floor(blast.at[0]), z = Math.floor(blast.at[2]);
          for (let y = Math.floor(blast.at[1]) + 2; y >= -32; y--) {
            if (g.world.isSolid(x, y, z)) { groundTop = y + 1; break; }
          }
        }
        out.push({
          aim, fired: !!ev, kind: blast?.kind ?? null,
          blasts: g.cinderDebugState().blasts - b0,
          rocks: g.cinderDebugState().rocks,
          blastY: blast ? blast.at[1] : null, groundTop,
          gap: blast && groundTop !== null ? blast.at[1] - groundTop : null,
          // ⚠️ 爆炸中心本身不得在实心内（用户：「不是跑到方块内部爆炸」）
          centerInsideSolid: blast
            ? g.world.isSolid(Math.floor(blast.at[0]), Math.floor(blast.at[1]), Math.floor(blast.at[2]))
            : null,
          normal: blast?.normal ?? null,
        });
        await new Promise((r) => setTimeout(r, 3200));   // 等冷却
      }
      return out;
    }, HOLD_CINDER_MS);
    console.log('CF_GROUND ' + JSON.stringify(runs));
    for (const r of runs) {
      const tag = `aim=${JSON.stringify(r.aim)}`;
      expect(r.fired, `${tag} 必须真的抛出`).toBe(true);
      expect(r.blasts, `${tag} 必须炸了一次`).toBe(1);
      expect(r.rocks, `${tag} 结束后不得残留岩石`).toBe(0);
      expect(r.kind, `${tag} 必须是贴地/命中口径，不得是空中自爆`).toBe('block');
      expect(r.groundTop, `${tag} 落点下方必须有地面`).not.toBeNull();
      // ⚠️⚠️ 落点必须是**表面接触点**：旧口径给格坐标、装配层 +0.5 ⇒ 爆心在块内
      //（实测 centerInsideSolid=true）。现在 at 已是世界坐标接触点，不得再 +0.5。
      expect(r.centerInsideSolid, `${tag} 爆炸中心不得在实心方块内部`).toBe(false);
      expect(r.normal, `${tag} 必须给命中面法线`).not.toBeNull();
      // 落点贴面：高度与地面顶面差 ≤ 1 格（墙面命中时 y 可低于顶面，故取区间）
      expect(r.gap, `${tag} 落点离地高度实测 ${r.gap} 格`).toBeLessThanOrEqual(1);
      expect(r.gap, `${tag} 落点不得钻到地面以下过深 ${r.gap}`).toBeGreaterThanOrEqual(-1);
    }
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
      expect(rd.meshes, 'mesh 数恒为 8（岩石+光晕+火焰尾巴+火星+余烬+烟+爆壳+冲击环）').toBe(8);
      expect(Math.abs(rd.dc - r.idle0), `第 ${i + 1} 次 draw call 必须回基线`)
        .toBeLessThanOrEqual(2);
    }
  });
});

// ---------------------------------------------------------------- Tier 4 像素判据

test.describe('Cinder Fall 观感身份（Tier 4）', () => {
  /**
   * ⚠️⚠️ 用户 2026-11-19：「他的实现是一个**黑色的燃烧的火球**，有**拖拽的一个火焰尾巴**，
   * 爆炸的时候**蹦出的火星粒子很多**，是爆炸的样子，而不是现在一样像烟花」。
   *
   * 本组用例钉的就是这三件。它们全部是**像素级**的 —— 本轮实测证明：
   * 链式 `.mix()` 让暖色像素从 78620 崩到 88、`float(x)*1.40` 生成 `NaN.0` 直接
   * 废掉整个粒子管线，而 **visible / 存活计数 / draw call / 单测全绿**。
   */
  test('火焰尾巴 + 火星：飞行中尾巴与粒子都上屏，且是暖色（不是白/青）', async ({ page }) => {
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

    const baseline = await page.screenshot();
    const st = await page.evaluate(async (holdMs) => {
      const g = window.__MC_GAME__;
      // 平视略俯 ⇒ 岩石真的飞一段（俯视太狠会 0.2s 就落地，拍不到尾巴）
      g.player.setTestAim([0, -0.05, -1]);
      await new Promise((r) => setTimeout(r, 300));
      const ev = await window.__CF__.chargeAndFire(holdMs);
      await new Promise((r) => setTimeout(r, 560));
      const lit = {};
      for (const m of g.cinderFall.meshes) lit[m.name] = m.visible;
      const sp = g.cinderFall._sparkGeo.getAttribute('aSpawn');
      const vel = g.cinderFall._sparkGeo.getAttribute('aVel');
      let liveSpark = 0;
      let moving = 0;
      for (let i = 0; i < sp.count; i++) {
        if (sp.getX(i) > 0) liveSpark++;
        if (Math.hypot(vel.getX(i), vel.getY(i), vel.getZ(i)) > 0.1) moving++;
      }
      const u = g.cinderFall.uniforms;
      return {
        fired: !!ev, rocks: g.cinderDebugState().rocks, lit, liveSpark, moving,
        tail: u.uTail.value.toArray(), head: u.uHead.value.toArray(),
        trailFade: u.uTrailFade.value,
      };
    }, HOLD_CINDER_MS);
    const shot = await page.screenshot();
    const s = diffStats(baseline, shot);
    console.log('CINDER_TRAIL', JSON.stringify({ st, s }));

    expect(errs.length, `不得有 TSL/GPU 报错：${errs.slice(0, 3).join(' | ')}`).toBe(0);
    expect(st.fired).toBe(true);
    expect(st.rocks, '截图时岩石必须在飞').toBeGreaterThan(0);
    expect(st.lit['cinder:flame'], '火焰尾巴必须上屏（用户点名要的）').toBe(true);
    expect(st.lit['cinder:spark'], '火星必须上屏').toBe(true);
    expect(st.lit['cinder:ember'], '余烬必须上屏').toBe(true);
    // 尾巴两端必须真的分开（否则退化成一个点）
    const tailLen = Math.hypot(st.head[0] - st.tail[0], st.head[1] - st.tail[1], st.head[2] - st.tail[2]);
    expect(tailLen, `尾巴长度实测 ${tailLen}`).toBeGreaterThan(1);
    expect(st.liveSpark, `飞行中必须已撒出火星（实测 ${st.liveSpark}）`).toBeGreaterThan(20);
    // ⚠️ aVel 非零是 STREAK 拉伸的输入：零速度 ⇒ 全部退回圆点（用户读作爆米花）
    expect(st.moving, `火星必须带速度（实测 ${st.moving}）`).toBeGreaterThan(20);
    /**
     * 像素色相判据：**冻结全局后只切 flame 一个变量**。
     *
     * ⚠️⚠️ 三个假红陷阱已实测排除（勿重试）：
     * ① `warm/diff` 比值 —— diff 含烟的压暗（实测 9.4% 但画面正确）；
     * ② 基于差分判青 —— 烟遮蓝水使 dr/dg 负得比 db 多（cyan≈warm）；
     * ③ 绝对色+变亮 —— additive 把背后蓝天抬亮，仍满足 b>r。
     * ④ **不冻结就拍两张** —— 岩石在飞、粒子在动，两张图差的是**整个场景**
     *    （实测 coolAbs 138398，而画面里没青）。
     *
     * ⇒ 正解：先停掉岩石/粒子/相机的一切推进（冻住），再拍「flame 开/关」两张，
     * 两张**只差 flame 这一个变量**（AGENTS.md：对照组必须同机位单变量）。
     */
    const hue = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      // 冻住：岩石不再推进、渲染器不再改 uniform/矩阵、粒子不再发射
      g.entities.update = () => {};
      g.cinderFall.update = () => {};
      g.cinderFall.sync = () => {};
      g._updateCinders = () => {};
      const flame = g.cinderFall.meshes.find((m) => m.name === 'cinder:flame');
      for (const m of g.cinderFall.meshes) m.visible = false;
      // ⚠️ 冻住后 `uTime` 不再推进 ⇒ 火焰噪声停在某一帧，可能正好很细。
      // 手动把它推到一个**中游时刻**（与基准帧同一时钟）⇒ 两张图只差 flame 开关。
      const u = g.cinderFall.uniforms;
      u.uTime.value = performance.now() / 1000;
      u.uTrailFade.value = 1;
      u.uTrailBurn.value = 0;
      await new Promise((r) => setTimeout(r, 150));
      window.__FLAME__ = flame;
      return true;
    });
    expect(hue).toBe(true);
    const offShot = await page.screenshot();
    await page.evaluate(() => { window.__FLAME__.visible = true; });
    await page.waitForTimeout(150);
    const onShot = await page.screenshot();
    let warmAbs = 0;
    let coolAbs = 0;
    {
      const a = PNG.sync.read(offShot);
      const b = PNG.sync.read(onShot);
      for (let i = 0; i < a.data.length; i += 4) {
        const dr = b.data[i] - a.data[i];
        const dg = b.data[i + 1] - a.data[i + 1];
        const db = b.data[i + 2] - a.data[i + 2];
        if (Math.abs(dr) + Math.abs(dg) + Math.abs(db) < 20) continue;
        const r = b.data[i], g2 = b.data[i + 1], bl = b.data[i + 2];
        if (r > bl + 30 && r > 90) warmAbs++;
        else if (bl > r + 30 && g2 > r + 15) coolAbs++;
      }
    }
    console.log('CINDER_TRAIL_HUE', JSON.stringify({ warmAbs, coolAbs, warm: s.warm }));
    expect(s.warm, `暖色像素实测 ${s.warm}`).toBeGreaterThan(3000);
    /**
     * 判据取**暖:冷 比例**，不钉绝对像素下限。
     *
     * ⚠️ 冻结后火焰噪声停在某一帧，绝对像素数随那一帧的肥瘦漂
     * （实测 149 / 96 / 97）—— 钉任何硬下限都是 flaky。
     * 而**色相比例稳定**（实测 74× / 96×）；链式 .mix() 缺陷下 flame 自身
     * warmPct 仅 **0.4%**（冷色占主导）⇒ 比例判据两侧有判别力。
     * 「尾巴真的上屏了吗」已由上方 `s.warm > 3000` 回答，不重复钉。
     */
    expect(warmAbs, `尾巴自身必须是暖色主导（warm=${warmAbs} cool=${coolAbs}）`)
      .toBeGreaterThan(Math.max(20, coolAbs * 3));
  });

  /**
   * ⚠️⚠️ 用户 2026-11-19：「火焰球的前进方向侧，前面是平的，而不是尖的，
   * 平的不好看，希望从平头改成椭圆头或者尖头」。
   *
   * 判据落在**真实 ribbon 几何的半宽序列**上（而不是目视）：
   * 平头 = 末端半宽仍接近最大值后突然截断；椭圆头 = 单调收拢到 ~0。
   * 在 CPU 侧复算顶点（读真实几何属性 + uniform），与 shader 同公式。
   */
  test('鼻锥：火焰尾巴前端是椭圆尖头（半宽单调收拢到 0，不是平截）', async ({ page }) => {
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

    const r = await page.evaluate(async (holdMs) => {
      const g = window.__MC_GAME__;
      g.player.setTestAim([0, -0.05, -1]);
      await new Promise((res) => setTimeout(res, 300));
      await window.__CF__.chargeAndFire(holdMs);
      await new Promise((res) => setTimeout(res, 520));
      // 冻住推进（否则量到的是下一帧的几何）
      g.entities.update = () => {};
      g._updateCinders = () => {};
      const cf = g.cinderFall;
      cf.update = () => {};
      cf.sync = () => {};
      const THREE = await import('three');
      const { CINDER_FX: FX } = await import('/src/render/cinder-fall-config.js');
      const u = cf.uniforms;
      const tail = u.uTail.value.clone();
      const head = u.uHead.value.clone();
      const axis = head.clone().sub(tail);
      const axisLen = Math.max(axis.length(), 1e-4);
      const dir = axis.clone().divideScalar(axisLen);
      const noseLen = FX.trailNoseLength;
      const noseStart = axisLen / (axisLen + noseLen);
      const sm = (a, b, v) => {
        const k = Math.min(1, Math.max(0, (v - a) / (b - a)));
        return k * k * (3 - 2 * k);
      };
      const radiusProfile = (x) => {
        const body = (0.34 + 0.66 * Math.pow(x, 0.55))
          * (1 + FX.trailWakeSpread * Math.pow(1 - x, 1.8));
        return body * (1 + (FX.trailHeadSize - 1) * sm(0.62, 1, x));
      };
      const pos = cf.flameMesh.geometry.getAttribute('position');
      const samples = [];
      for (let i = 0; i < pos.count; i += 2) {
        const t = pos.getX(i);
        const inNose = t >= noseStart;
        const bodyT = Math.min(1, Math.max(0, t / Math.max(noseStart, 1e-4)));
        const s = Math.min(1, Math.max(0, (t - noseStart) / Math.max(1 - noseStart, 1e-4)));
        const taper = inNose ? Math.sqrt(Math.max(0, 1 - s * s)) : FX.trailNoseJoin;
        const halfWidth = FX.trailWidth * radiusProfile(bodyT) * taper;
        const center = inNose
          ? head.clone().add(dir.clone().multiplyScalar(noseLen * s))
          : tail.clone().add(axis.clone().multiplyScalar(bodyT));
        samples.push({
          fwd: center.clone().sub(tail).dot(dir),
          halfWidth, inNose,
        });
      }
      const nose = samples.filter((x) => x.inNose);
      const last = samples[samples.length - 1];
      return {
        visible: cf.flameMesh.visible,
        axisLen, noseStart, noseLen,
        noseRings: nose.length,
        tipHalfWidth: last.halfWidth,
        tipFwd: last.fwd,
        headFwd: axisLen,
        maxHalfWidth: Math.max(...samples.map((x) => x.halfWidth)),
        noseWidths: nose.map((x) => +x.halfWidth.toFixed(4)),
      };
    }, HOLD_CINDER_MS);
    console.log('CINDER_NOSE', JSON.stringify(r));

    expect(errs.length, `不得有 TSL/GPU 报错：${errs.slice(0, 3).join(' | ')}`).toBe(0);
    expect(r.visible, '尾巴必须上屏').toBe(true);
    // ① 尖端必须真的收到零（平头的特征是末端半宽≈最大值）
    expect(r.tipHalfWidth, `尖端半宽实测 ${r.tipHalfWidth}`).toBeLessThan(0.02);
    expect(r.tipHalfWidth / r.maxHalfWidth, '尖端不得超过最大宽的 2%')
      .toBeLessThan(0.02);
    // ② 尖端必须**前伸过岩石中心**（否则仍在球心处被直边截断）
    expect(r.tipFwd - r.headFwd, `前伸量实测 ${(r.tipFwd - r.headFwd).toFixed(3)}`)
      .toBeGreaterThan(0.8);
    // ③ 鼻锥内采样要够密（否则椭圆退化成多边形斜切面）
    expect(r.noseRings, `鼻锥环数实测 ${r.noseRings}`).toBeGreaterThanOrEqual(8);
    // ④ 半宽必须**单调不增**（台阶/回升 = 接缝处有平边）
    for (let i = 1; i < r.noseWidths.length; i++) {
      expect(r.noseWidths[i], `鼻锥半宽必须单调收拢（i=${i}）`)
        .toBeLessThanOrEqual(r.noseWidths[i - 1] + 1e-6);
    }
  });

  test('落点爆炸：火星大量喷出（≥150）且带速度，不是只有一圈光环', async ({ page }) => {
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

    const r = await page.evaluate(async (holdMs) => {
      const g = window.__MC_GAME__;
      // 俯视近处地面：落点必须在相机视野内（远处水下的落点会被地形遮住 ⇒ 零判别力）
      g.player.setTestAim([0, -0.55, -1]);
      await new Promise((res) => setTimeout(res, 300));
      const b0 = g.cinderDebugState().blasts;
      const ev = await window.__CF__.chargeAndFire(holdMs);
      // 等真的炸了（不猜毫秒：岩石飞满瞄准点后还要下落一段）
      const t0 = performance.now();
      while (g.cinderDebugState().blasts === b0 && performance.now() - t0 < 12000) {
        await new Promise((res) => setTimeout(res, 50));
      }
      const sp = g.cinderFall._sparkGeo.getAttribute('aSpawn');
      const vel = g.cinderFall._sparkGeo.getAttribute('aVel');
      let liveSpark = 0;
      let fast = 0;
      for (let i = 0; i < sp.count; i++) {
        if (sp.getX(i) > 0) liveSpark++;
        if (Math.hypot(vel.getX(i), vel.getY(i), vel.getZ(i)) > 3) fast++;
      }
      const em = g.cinderFall._emberGeo.getAttribute('aSpawn');
      let liveEmber = 0;
      for (let i = 0; i < em.count; i++) if (em.getX(i) > 0) liveEmber++;
      const lit = {};
      for (const m of g.cinderFall.meshes) lit[m.name] = m.visible;
      return {
        fired: !!ev, blasts: g.cinderDebugState().blasts - b0,
        liveSpark, fast, liveEmber, lit,
      };
    }, HOLD_CINDER_MS);
    const shot = await page.screenshot();
    console.log('CINDER_BLAST_SPARKS', JSON.stringify(r));

    expect(errs.length, `不得有 TSL/GPU 报错：${errs.slice(0, 3).join(' | ')}`).toBe(0);
    expect(r.fired).toBe(true);
    expect(r.blasts, '必须真的炸了').toBe(1);
    // 上游 burstSparks 180 / burstEmbers 260 ⇒ 环形缓冲里至少留这么多
    expect(r.liveSpark, `落点火星数实测 ${r.liveSpark}`).toBeGreaterThanOrEqual(150);
    expect(r.liveEmber, `落点余烬数实测 ${r.liveEmber}`).toBeGreaterThanOrEqual(200);
    // ⚠️ **高速**是「爆炸」与「烟花」的分界：慢速圆点飘散读作烟花
    expect(r.fast, `高速火星数实测 ${r.fast}（速度 >3 格/秒）`).toBeGreaterThan(100);
    expect(r.lit['cinder:smoke'], '烟必须上屏（遮挡 = 爆炸的层次）').toBe(true);
    expect(shot.length).toBeGreaterThan(1000);
  });

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