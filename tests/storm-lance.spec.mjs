// tests/storm-lance.spec.mjs — 持剑蓄力大招 Storm Lance 的 E2E + Tier 4 像素实测（v3.20）
//
// 设计：docs/superpowers/specs/2026-11-19-storm-lance-sword-charge-design.md
//
// ## 为什么必须像素实测（AGENTS.md Tier 4）
//
// 六个 pass 全在 GPU 求值。数据层（`stormLanceDebugState().phase`、`meshes[i].visible`）对，
// **画面仍可能全错**：
//   · TSL 常量色写成 `vec3(new THREE.Color(hex))` ⇒ 整片 pass 纯黑且零报错（v3.14 实测）；
//   · kink 换成平滑噪声 ⇒ 闪电退化成扭动的管子，而顶点数/相位判据全绿；
//   · 火花退回圆形 quad ⇒ 用户读作「往外冒爆米花」（R3 的原始报告）；
//   · 爆壳电弧阈值放宽 ⇒ 实心球，用户读作「软绵绵」（R4 的原始报告）；
//   · 忘了 `fog: false` ⇒ 远处闪电被雾洗成天空色；
//   · `vertexNode` 漏设 ⇒ 参数化几何按 `(t,side,0)` 当坐标画，缩在原点一个像素里。
// 这六种缺陷下**所有计数类判据全绿**。
//
// ## ⚠️ 必须藏掉宿主噪声源
//
// 剑体是紫色且挥砍动画在动 ⇒ 两侧都先 `viewWeapon.node.visible = false`
// （同焰魔法阵 v3.04 的「藏掉同色宿主」教训）。
//
// ## ⚠️ 阈值在 1280×720（Playwright 默认 viewport）下实测标定
//
// 探针自设别的尺寸会因视野不同而稀释占比（AGENTS.md 记过 9.4× 的假红）。
import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

const SEED = 12345;
/** 按下 → 静默 1s → 蓄力 1s ⇒ 2s 后可发射。留 100ms 余量 */
const HOLD_MS = 2100;
/** 总视觉 1.179s + 火花衰亡窗口 1.0s ⇒ 2.4s 后应完全回基线 */
const SETTLE_MS = 2600;

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

/**
 * 选剑 + 平视 + 藏 HUD/剑体 + **冻住场景动态**（像素用例的前置）。
 * ⚠️ 不冻水面与日夜时同状态重复截图的噪声底高达 9340（实测），冻住后 0。
 */
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
    window.__SL__ = {
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
        throw new Error('no legal storm fixture position');
      },
      /** 蓄满并施放，返回 storm-lance 事件（走真实 controller 路径） */
      async chargeAndFire(holdMs = HOLD_MS) {
        const g = window.__MC_GAME__;
        const aim = g.player._buildAim();
        g.player.weaponController.pointerDown(aim);
        await new Promise((r) => setTimeout(r, holdMs));
        const effects = g.player.weaponController.pointerUp(g.player._buildAim());
        return effects.find((e) => e.type === 'storm-lance') ?? null;
      },
    };
  });
}

/** 差分统计：总差分数 / 蓝白簇 / 近白数 */
function diffStats(before, after) {
  const a = PNG.sync.read(before);
  const b = PNG.sync.read(after);
  let diff = 0, blue = 0, nearWhite = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const dr = b.data[i] - a.data[i];
    const dg = b.data[i + 1] - a.data[i + 1];
    const db = b.data[i + 2] - a.data[i + 2];
    if (Math.abs(dr) + Math.abs(dg) + Math.abs(db) > 12) {
      diff++;
      // Storm Lance 是冷蓝白：蓝显著高于红
      if (db > dr + 20 && db > 60) blue++;
    }
    if (b.data[i] > 245 && b.data[i + 1] > 245 && b.data[i + 2] > 245) nearWhite++;
  }
  return { diff, blue, nearWhite, total: a.width * a.height };
}

/**
 * 单个火花条带的的长宽比（R3 的像素判据）。
 *
 * ⚠️⚠️ **必须在「差分掩膜」上洪泛，不能直接在亮图上洪泛**（本判据首版就这么错）：
 * 直接在亮像素上洪泛时，扫描从左上角开始、先填满上限（实测 count 恒 = 上限 40），
 * 量到的是**背景簇**（地形/天空边缘），与特效无关 ⇒ 基线图与特效图读数**逐位相同**
 * （实测均为 count 40 / median 1.5 / p90 4）⇒ **零判别力**。
 * 正确做法：先用「两帧逐像素差 > 阈值」造掩膜，只在掩膜内簇。
 *
 * ⚠️ 束身自己是一整个大簇（会被尺寸过滤掉）；径向抛出的火花与束身分离，
 * 正是我们要量的那些。圆形羽化 quad 的簇近似正方形（比≈1），STREAK 明显狭长。
 */
function streakAspect(before, after, { minSeed = 90, maxClusters = 400 } = {}) {
  const a = PNG.sync.read(before);
  const b = PNG.sync.read(after);
  const W = a.width, H = a.height;
  // 1. 差分掩膜（只留「真的亮了」的像素）
  const mask = new Uint8Array(W * H);
  for (let i = 0, p = 0; i < a.data.length; i += 4, p++) {
    const dr = b.data[i] - a.data[i];
    const dg = b.data[i + 1] - a.data[i + 1];
    const db = b.data[i + 2] - a.data[i + 2];
    // 偏蓝且明显变亮（排除地形/天空自身的边缘）
    if (db > 12 && db > dr && b.data[i + 2] > minSeed) mask[p] = 1;
  }
  const seen = new Uint8Array(W * H);
  const ratios = [];
  const stack = [];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const p = y * W + x;
      if (seen[p] || !mask[p]) continue;
      let minX = x, maxX = x, minY = y, maxY = y, n = 0;
      stack.length = 0;
      stack.push(x, y);
      seen[p] = 1;
      while (stack.length) {
        const cy = stack.pop(), cx = stack.pop();
        n++;
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const np = ny * W + nx;
          if (seen[np] || !mask[np]) continue;
          seen[np] = 1;
          stack.push(nx, ny);
        }
      }
      // 只取「像单个火花」的簇：太小=噪点，太大=束身/爆壳
      if (n < 4 || n > 400) continue;
      const w = maxX - minX + 1, h = maxY - minY + 1;
      ratios.push(Math.max(w, h) / Math.max(1, Math.min(w, h)));
      if (ratios.length >= maxClusters) break;
    }
    if (ratios.length >= maxClusters) break;
  }
  ratios.sort((x, y) => x - y);
  return {
    count: ratios.length,
    median: ratios.length ? ratios[ratios.length >> 1] : 0,
    p90: ratios.length ? ratios[Math.floor(ratios.length * 0.9)] : 0,
  };
}

test.describe('Storm Lance（v3.20）', () => {
  test('R1 蓄力环：静默期不出现；1s 后出现并递减；2s 转就绪；松开消失', async ({ page }) => {
    await page.goto(`/?seed=${SEED}&vd=4`);
    await waitWorldReady(page);
    const r = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      await g.selectWeapon('sword');
      await new Promise((res) => setTimeout(res, 600));
      const ring = document.getElementById('mc-charge-ring');
      const arc = ring.querySelector('.mc-nc-arc');
      const read = () => ({
        on: ring.classList.contains('mc-nc-on'),
        ready: ring.classList.contains('mc-nc-ready'),
        off: Number(arc.getAttribute('stroke-dashoffset')),
      });
      const idle = read();
      // 按下后 0.3s / 0.9s：仍在静默期，环必须不出现（R1）
      g.player.weaponController.pointerDown(g.player._buildAim());
      await new Promise((res) => setTimeout(res, 300));
      const at300 = read();
      await new Promise((res) => setTimeout(res, 600));
      const at900 = read();
      g.player.weaponController.pointerUp(g.player._buildAim());
      await new Promise((res) => setTimeout(res, 200));
      const afterShort = read();
      // 长按：1.3s 时应已出现，2.2s 时应就绪
      g.player.weaponController.pointerDown(g.player._buildAim());
      await new Promise((res) => setTimeout(res, 1300));
      const at1300 = read();
      const samples = [];
      for (let i = 0; i < 5; i++) {
        await new Promise((res) => setTimeout(res, 200));
        samples.push(read());
      }
      const charged = read();
      g.player.weaponController.pointerUp(g.player._buildAim());
      await new Promise((res) => setTimeout(res, 300));
      const afterFire = read();
      return { idle, at300, at900, afterShort, at1300, samples, charged, afterFire };
    });
    expect(r.idle.on, '空闲时环必须隐藏').toBe(false);
    // R1 的核心：静默期零蓄力视觉
    expect(r.at300.on, '0.3s 仍在静默期，环不得出现（用户：画面太乱）').toBe(false);
    expect(r.at900.on, '0.9s 仍在静默期，环不得出现').toBe(false);
    expect(r.afterShort.on, '短按松开后环必须消失').toBe(false);
    expect(r.at1300.on, '1.3s 已越过静默期，环应出现').toBe(true);
    expect(r.at1300.ready, '1.3s 不该就绪').toBe(false);
    for (let i = 1; i < r.samples.length; i++) {
      expect(r.samples[i].off, `第 ${i} 次采样 dashoffset 必须 ≤ 前一次`)
        .toBeLessThanOrEqual(r.samples[i - 1].off + 1e-6);
    }
    expect(r.charged.ready, '2.2s 后必须转就绪态').toBe(true);
    expect(r.charged.off, '就绪时 dashoffset 应为 0').toBeCloseTo(0, 2);
    expect(r.afterFire.on, '施放后环必须消失').toBe(false);
  });

  test('蓄力环不是 #crosshair 的子节点（DOM 契约）', async ({ page }) => {
    await page.goto(`/?seed=${SEED}&vd=4`);
    await waitWorldReady(page);
    const r = await page.evaluate(() => {
      const ch = document.getElementById('crosshair');
      const ring = document.getElementById('mc-charge-ring');
      const strokes = [...ch.children].map((el) => {
        const b = el.getBoundingClientRect();
        return `${Math.round(b.width)}x${Math.round(b.height)}`;
      }).sort();
      return {
        ringInsideCrosshair: ch.contains(ring),
        strokes,
        zIndex: getComputedStyle(ring).zIndex,
        pointerEvents: getComputedStyle(ring).pointerEvents,
      };
    });
    expect(r.ringInsideCrosshair, '蓄力环绝不能挂进 #crosshair').toBe(false);
    expect(r.strokes, '准心仍必须只有两笔 2px 笔画').toEqual(['20x2', '2x20']);
    expect(r.zIndex, 'z-index 必须是 50').toBe('50');
    expect(r.pointerEvents, '不得拦输入').toBe('none');
  });

  test('Tier 4：闪电真的上屏，且是冷蓝白簇（不是纯黑 / 不是雾色）', async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`/?seed=${SEED}&vd=6&shadows=0`);
    await waitWorldReady(page);
    await gotoOpenField(page);
    await setupVisual(page);

    const n1 = await page.screenshot();
    await page.waitForTimeout(400);
    const n2 = await page.screenshot();
    const noise = diffStats(n1, n2);

    const baseline = await page.screenshot();
    const fire = await page.evaluate(async (holdMs) => {
      const g = window.__MC_GAME__;
      g.player.weaponController.pointerDown(g.player._buildAim());
      await new Promise((r) => setTimeout(r, holdMs));
      const effects = g.player.weaponController.pointerUp(g.player._buildAim());
      const beam = effects.find((e) => e.type === 'storm-lance');
      await new Promise((r) => setTimeout(r, 320));   // travel 完 → hold
      return { fired: !!beam, phase: g.stormLanceDebugState().phase };
    }, HOLD_MS);
    const shot = await page.screenshot();
    const s = diffStats(baseline, shot);

    expect(fire.fired, '必须真的施放了').toBe(true);
    expect(fire.phase, '截图时应在 hold 相位').toBe('hold');
    expect(noise.diff, `噪声底必须接近 0，实测 ${noise.diff}`).toBeLessThan(400);
    expect(s.diff, `闪电必须占一块屏幕，实测 ${s.diff}`).toBeGreaterThan(2000);
    expect(s.blue, `冷蓝白簇必须存在，实测 ${s.blue}`).toBeGreaterThan(300);
    // 上界：防两个 additive pass 叠成一片白
    expect(s.nearWhite / s.total, '近白像素占比不得失控').toBeLessThan(0.06);
  });

  test('R2：命中丧尸时 length 截到它身上，落点不在它后方', async ({ page }) => {
    await page.goto(`/?seed=${SEED}&vd=4`);
    await waitWorldReady(page);
    await installHelpers(page);
    const r = await page.evaluate(async (holdMs) => {
      const g = window.__MC_GAME__;
      await g.selectWeapon('sword');
      await new Promise((res) => setTimeout(res, 600));
      const pos = window.__SL__.legalSpawnNear(8);
      const id = g.zombies.spawn(pos, { source: 'test' });
      const cam = g.camera.position.toArray();
      g.player.setTestAim([pos[0] - cam[0], pos[1] + 0.9 - cam[1], pos[2] - cam[2]]);
      g.zombies.update = () => {};   // 冻住 AI（蓄力期它会走 ~2.5 格）
      const h0 = g.zombies.get(id).health;
      const beam = await window.__SL__.chargeAndFire(holdMs);
      const justAfter = g.zombies.get(id)?.health ?? null;
      await new Promise((res) => setTimeout(res, 2000));
      const later = g.zombies.get(id)?.health ?? null;
      // 落点到相机的距离 vs 丧尸到相机的距离
      const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      return {
        h0, justAfter, later,
        hits: beam?.hits?.length ?? 0,
        len: beam?.length ?? 0,
        kind: beam?.impactKind ?? null,
        impactDist: beam ? d(beam.target, cam) : null,
        zombieDist: d([pos[0], pos[1] + 0.9, pos[2]], cam),
        range: 24,
      };
    }, HOLD_MS);
    expect(r.hits, '必须命中 1 只').toBe(1);
    expect(r.justAfter, '一次施法扣 50').toBe(r.h0 - 50);
    expect(r.later, '保持期不得重复扣血').toBe(r.justAfter);
    expect(r.kind, 'impactKind 必须是 entity').toBe('entity');
    expect(r.len, `length 必须截断（< ${r.range}），实测 ${r.len}`).toBeLessThan(r.range);
    // R2 的核心：落点必须就在丧尸身上，而不是它后方的方块
    expect(Math.abs(r.impactDist - r.zombieDist),
      `落点必须贴丧尸（impact ${r.impactDist} vs zombie ${r.zombieDist}）`).toBeLessThan(1.5);
  });

  test('R2 负向：拆掉截断 ⇒ 落点跑到射程末端（证明上一条有判别力）', async ({ page }) => {
    await page.goto(`/?seed=${SEED}&vd=4`);
    await waitWorldReady(page);
    await installHelpers(page);
    const r = await page.evaluate(async (holdMs) => {
      const g = window.__MC_GAME__;
      await g.selectWeapon('sword');
      await new Promise((res) => setTimeout(res, 600));
      const pos = window.__SL__.legalSpawnNear(8);
      const id = g.zombies.spawn(pos, { source: 'test' });
      const cam = g.camera.position.toArray();
      g.player.setTestAim([pos[0] - cam[0], pos[1] + 0.9 - cam[1], pos[2] - cam[2]]);
      g.zombies.update = () => {};
      // 注入退化：把 sweepLance 换成「只发视觉、length 跑满」的旧口径
      const q = g.player.weaponController.entityQuery;
      const saved = q.sweepLance;
      q.sweepLance = (aim, cfg) => {
        const real = saved(aim, cfg);
        const f = aim.forward;
        return {
          ...real,
          length: cfg.range,
          impactKind: 'air',
          target: [
            real.origin[0] + f[0] * cfg.range,
            real.origin[1] + f[1] * cfg.range,
            real.origin[2] + f[2] * cfg.range,
          ],
        };
      };
      const beam = await window.__SL__.chargeAndFire(holdMs);
      q.sweepLance = saved;
      const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      return {
        len: beam?.length ?? 0,
        kind: beam?.impactKind ?? null,
        impactDist: beam ? d(beam.target, cam) : null,
        zombieDist: d([pos[0], pos[1] + 0.9, pos[2]], cam),
      };
    }, HOLD_MS);
    // 退化后落点必须明显远离丧尸 —— 这正是用户报告的缺陷形态
    expect(r.kind).toBe('air');
    expect(Math.abs(r.impactDist - r.zombieDist),
      '退化后落点应远离丧尸（证明正向用例的 <1.5 判据有判别力）').toBeGreaterThan(5);
  });

  test('范围：轴线两侧偏心的两只丧尸都掉血（证明不是单射线）', async ({ page }) => {
    await page.goto(`/?seed=${SEED}&vd=4`);
    await waitWorldReady(page);
    await installHelpers(page);
    const r = await page.evaluate(async (holdMs) => {
      const g = window.__MC_GAME__;
      await g.selectWeapon('sword');
      await new Promise((res) => setTimeout(res, 600));
      g.player.setTestAim([0, 0, -1]);
      await new Promise((res) => setTimeout(res, 100));
      const p = g.player.physics.pos;
      const cam = g.camera.position;
      const groundY = (x, z) => {
        for (let y = Math.floor(p.y) + 2; y >= Math.floor(p.y) - 40; y--) {
          if (g.world.isSolid(Math.floor(x), y, Math.floor(z))) return y + 1;
        }
        return null;
      };
      const zx = cam.x, zz = cam.z - 8;
      const yL = groundY(zx - 0.5, zz), yR = groundY(zx + 0.5, zz);
      if (yL === null || yR === null) return { skipped: true };
      const idL = g.zombies.spawn([zx - 0.5, yL, zz], { source: 'test' });
      const idR = g.zombies.spawn([zx + 0.5, yR, zz], { source: 'test' });
      if (!idL || !idR) return { skipped: true };
      g.zombies.update = () => {};
      const hL0 = g.zombies.get(idL).health, hR0 = g.zombies.get(idR).health;
      g.player.setTestAim([zx - cam.x, (yL + 0.9) - cam.y, zz - cam.z]);
      const beam = await window.__SL__.chargeAndFire(holdMs);
      return {
        skipped: false, hL0, hR0,
        hL1: g.zombies.get(idL)?.health ?? null,
        hR1: g.zombies.get(idR)?.health ?? null,
        hits: beam?.hits?.length ?? 0,
      };
    }, HOLD_MS);
    if (r.skipped) test.skip();
    expect(r.hits, '两只都该被扫到').toBe(2);
    expect(r.hL1).toBe(r.hL0 - 50);
    expect(r.hR1).toBe(r.hR0 - 50);
  });

  test('闪电不破坏方块（即使 gunBlockDamage 开着）', async ({ page }) => {
    await page.goto(`/?seed=${SEED}&vd=4`);
    await waitWorldReady(page);
    await installHelpers(page);
    const r = await page.evaluate(async (holdMs) => {
      const g = window.__MC_GAME__;
      await g.selectWeapon('sword');
      await new Promise((res) => setTimeout(res, 600));
      g.setGunBlockDamage(true);
      g.player.setTestAim([0, -0.3, -1]);
      await new Promise((res) => setTimeout(res, 100));
      const p = g.player.physics.pos;
      const cells = [];
      for (let d = 2; d <= 20; d++) {
        for (let dy = -3; dy <= 1; dy++) {
          const x = Math.floor(p.x), y = Math.floor(p.y) + dy, z = Math.floor(p.z) - d;
          cells.push([x, y, z, g.world.getBlockId(x, y, z)]);
        }
      }
      const beam = await window.__SL__.chargeAndFire(holdMs);
      await new Promise((res) => setTimeout(res, 2000));
      const changed = cells.filter(([x, y, z, id]) => g.world.getBlockId(x, y, z) !== id);
      return { fired: !!beam, changed: changed.length, sampled: cells.length };
    }, HOLD_MS);
    expect(r.fired).toBe(true);
    expect(r.sampled, '必须真的采样了方块').toBeGreaterThan(50);
    expect(r.changed, '闪电绝不能改任何方块').toBe(0);
  });

  test('遮挡：墙后丧尸不掉血，且 length 被截断', async ({ page }) => {
    await page.goto(`/?seed=${SEED}&vd=4`);
    await waitWorldReady(page);
    await installHelpers(page);
    const r = await page.evaluate(async (holdMs) => {
      const g = window.__MC_GAME__;
      await g.selectWeapon('sword');
      await new Promise((res) => setTimeout(res, 600));
      // 自己砌墙（搜天然遮挡在开阔地常找不到 ⇒ 用例永远 skip = 零覆盖）
      g.player.setTestAim([0, 0, -1]);
      await new Promise((res) => setTimeout(res, 150));
      const cam = g.camera.position;
      const stoneId = g.registry.idOf('stone');
      const wallZ = Math.floor(cam.z) - 6;
      const baseY = Math.floor(cam.y);
      const wall = [];
      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
          const c = { x: Math.floor(cam.x) + dx, y: baseY + dy, z: wallZ };
          wall.push({ ...c, prev: g.world.getBlockId(c.x, c.y, c.z) });
          g.world.setBlock(c.x, c.y, c.z, stoneId, 0);
        }
      }
      const bz = wallZ - 3;
      const bx = Math.floor(cam.x);
      const floorY = baseY - 2;
      const cleared = [];
      for (let dy = -1; dy <= 2; dy++) {
        const c = { x: bx, y: floorY + dy, z: bz };
        cleared.push({ ...c, prev: g.world.getBlockId(c.x, c.y, c.z) });
        g.world.setBlock(c.x, c.y, c.z, dy <= 0 ? stoneId : 0, 0);
      }
      const id = g.zombies.spawn([bx + 0.5, floorY + 1, bz + 0.5], { source: 'test' });
      if (!id) return { skipped: true };
      g.zombies.update = () => {};
      const h0 = g.zombies.get(id).health;
      g.player.setTestAim([0, 0, -1]);
      await new Promise((res) => setTimeout(res, 150));
      const beam = await window.__SL__.chargeAndFire(holdMs);
      const out = {
        skipped: false, h0, h1: g.zombies.get(id)?.health ?? null,
        len: beam?.length ?? null, hits: beam?.hits?.length ?? 0,
        kind: beam?.impactKind ?? null,
      };
      for (const c of [...wall, ...cleared]) g.world.setBlock(c.x, c.y, c.z, c.prev, 0);
      g.entities.despawn(id, 'test-cleanup');
      return out;
    }, HOLD_MS);
    if (r.skipped) test.skip();
    expect(r.hits, '墙后不得命中').toBe(0);
    expect(r.h1, '墙后不得掉血').toBe(r.h0);
    expect(r.kind, '撞墙时 impactKind 必须是 block').toBe('block');
    expect(r.len, `length 必须被墙截断（< 24），实测 ${r.len}`).toBeLessThan(24);
    expect(r.len, '墙在 6 格处 ⇒ length 应在 3~7 格').toBeGreaterThan(3);
  });

  test('draw call：空闲=基线 / 施放中增加 / 结束后回基线', async ({ page }) => {
    test.setTimeout(180_000);
    // ⚠️ 必须 reflect=0：水面倒影 pass 会把它的 draw call 算进同一个计数
    await page.goto(`/?seed=${SEED}&vd=6&shadows=0&reflect=0`);
    await waitWorldReady(page);
    await gotoOpenField(page);
    await installHelpers(page);
    const r = await page.evaluate(async ([holdMs, settleMs]) => {
      const g = window.__MC_GAME__;
      await g.selectWeapon('sword');
      await new Promise((res) => setTimeout(res, 800));
      g.player.setTestAim([0, -0.08, -1]);
      await new Promise((res) => setTimeout(res, 600));
      const idle = g.renderStats().drawCalls;
      g.player.weaponController.pointerDown(g.player._buildAim());
      await new Promise((res) => setTimeout(res, holdMs));
      const charging = g.renderStats().drawCalls;
      g.player.weaponController.pointerUp(g.player._buildAim());
      await new Promise((res) => setTimeout(res, 320));
      const firing = g.renderStats().drawCalls;
      const lit = g.stormLance.meshes.filter((m) => m.visible).length;
      await new Promise((res) => setTimeout(res, settleMs));
      const after = g.renderStats().drawCalls;
      const litAfter = g.stormLance.meshes.filter((m) => m.visible).length;
      return { idle, charging, firing, after, lit, litAfter, phase: g.stormLanceDebugState().phase };
    }, [HOLD_MS, SETTLE_MS]);
    expect(r.litAfter, '结束后全部 mesh 必须隐藏').toBe(0);
    expect(r.phase).toBe('idle');
    expect(r.lit, '施放中应有多个 pass 可见').toBeGreaterThanOrEqual(4);
    expect(r.firing, `施放中 draw call 必须增加（idle ${r.idle} → firing ${r.firing}）`)
      .toBeGreaterThan(r.idle);
    expect(r.firing - r.idle, `闪电自身增量不得失控（实测 ${r.firing - r.idle}）`)
      .toBeLessThanOrEqual(24);
    expect(Math.abs(r.after - r.idle), `结束后必须回基线（idle ${r.idle} / after ${r.after}）`)
      .toBeLessThanOrEqual(2);
  });

  test('连续 3 次蓄力+释放无泄漏（mesh 数恒定、draw call 回基线）', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto(`/?seed=${SEED}&vd=6&shadows=0&reflect=0`);
    await waitWorldReady(page);
    await gotoOpenField(page);
    await installHelpers(page);
    const r = await page.evaluate(async ([holdMs, settleMs]) => {
      const g = window.__MC_GAME__;
      await g.selectWeapon('sword');
      await new Promise((res) => setTimeout(res, 800));
      g.player.setTestAim([0, -0.08, -1]);
      await new Promise((res) => setTimeout(res, 600));
      const sceneCount0 = g.scene.children.length;
      const idle0 = g.renderStats().drawCalls;
      const rounds = [];
      for (let k = 0; k < 3; k++) {
        const beam = await window.__SL__.chargeAndFire(holdMs);
        await new Promise((res) => setTimeout(res, settleMs));
        rounds.push({
          fired: !!beam,
          phase: g.stormLanceDebugState().phase,
          dc: g.renderStats().drawCalls,
          lit: g.stormLance.meshes.filter((m) => m.visible).length,
          meshes: g.stormLance.meshes.length,
        });
      }
      return { sceneCount0, sceneCount1: g.scene.children.length, idle0, rounds };
    }, [HOLD_MS, SETTLE_MS]);
    expect(r.sceneCount1, '不得逐次新增 scene 节点').toBe(r.sceneCount0);
    for (const [i, rd] of r.rounds.entries()) {
      expect(rd.fired, `第 ${i + 1} 次必须施放成功`).toBe(true);
      expect(rd.phase, `第 ${i + 1} 次必须回到 idle`).toBe('idle');
      expect(rd.lit, `第 ${i + 1} 次结束后不得有可见 mesh`).toBe(0);
      expect(rd.meshes, 'mesh 数恒为 6').toBe(6);
      expect(Math.abs(rd.dc - r.idle0), `第 ${i + 1} 次 draw call 必须回基线`).toBeLessThanOrEqual(2);
    }
  });

  test('施法后剑体仍在屏上（防 onShot 收到无 recoil 事件写出 NaN）', async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`/?seed=${SEED}&vd=6&shadows=0`);
    await waitWorldReady(page);
    await gotoOpenField(page);
    await installHelpers(page);
    const r = await page.evaluate(async (holdMs) => {
      const g = window.__MC_GAME__;
      await g.selectWeapon('sword');
      await new Promise((res) => setTimeout(res, 900));
      g.player.setTestAim([0, -0.08, -1]);
      const node = g.player.viewWeapon.node;
      const posBefore = node.position.toArray();
      await window.__SL__.chargeAndFire(holdMs);
      await new Promise((res) => setTimeout(res, 600));
      return {
        posBefore, posAfter: node.position.toArray(),
        scaleAfter: node.scale.toArray(), visible: node.visible,
      };
    }, HOLD_MS);
    for (const v of [...r.posAfter, ...r.scaleAfter]) {
      expect(Number.isFinite(v), `剑体变换出现非有限数：${v}`).toBe(true);
    }
    expect(r.visible, '剑体必须仍可见').toBe(true);
    const drift = Math.hypot(
      r.posAfter[0] - r.posBefore[0],
      r.posAfter[1] - r.posBefore[1],
      r.posAfter[2] - r.posBefore[2],
    );
    expect(drift, `剑体位置漂移过大（${drift}）`).toBeLessThan(0.3);
  });

  test('负向对照：拆掉 sweepLance 注入 → 伤害消失而视觉仍在', async ({ page }) => {
    await page.goto(`/?seed=${SEED}&vd=4`);
    await waitWorldReady(page);
    await installHelpers(page);
    const r = await page.evaluate(async (holdMs) => {
      const g = window.__MC_GAME__;
      await g.selectWeapon('sword');
      await new Promise((res) => setTimeout(res, 600));
      const pos = window.__SL__.legalSpawnNear(8);
      const id = g.zombies.spawn(pos, { source: 'test' });
      const cam = g.camera.position.toArray();
      g.player.setTestAim([pos[0] - cam[0], pos[1] + 0.9 - cam[1], pos[2] - cam[2]]);
      g.zombies.update = () => {};
      const h0 = g.zombies.get(id).health;
      const q = g.player.weaponController.entityQuery;
      const saved = q.sweepLance;
      q.sweepLance = undefined;
      const beam = await window.__SL__.chargeAndFire(holdMs);
      q.sweepLance = saved;
      await new Promise((res) => setTimeout(res, 300));
      return {
        h0, h1: g.zombies.get(id)?.health ?? null,
        fired: !!beam, hits: beam?.hits?.length ?? -1,
        phase: g.stormLanceDebugState().phase,
      };
    }, HOLD_MS);
    expect(r.fired, '视觉仍须触发').toBe(true);
    expect(r.hits, '无注入 ⇒ hits 为空').toBe(0);
    expect(r.h1, '无注入 ⇒ 不掉血').toBe(r.h0);
    expect(r.phase, '闪电仍在跑').not.toBe('idle');
  });
});
// ---------------------------------------------------------------- R3 / R4 像素判据
//
// ⚠️ 这两条是用户实玩报告的两个缺陷（「曳光丢了」「爆炸软绵绵」）的**直接判据**。
// 前面那条「差分 + 蓝簇」对它们**零判别力**：圆形 quad 与实心球一样会产生差分与蓝簇。

test.describe('Storm Lance 观感身份（R3 / R4）', () => {
  test('R3：火花是狭长条带而不是圆点（单连通簇长宽比）', async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`/?seed=${SEED}&vd=6&shadows=0&reflect=0`);
    await waitWorldReady(page);
    await gotoOpenField(page);
    await setupVisual(page);

    // 基线的簇长宽比（无特效时应几乎没有合格簇）
    const baseShot = await page.screenshot();
    const noiseShot = await page.screenshot();
    // ⚠️ `streakAspect` 必须吃「两帧」：只在差分掩膜上洪泛。
    // 拿同一个文件当两帧 ⇒ 掩膜全空 ⇒ count=0（本身就是一条自检）。
    const selfCheck = streakAspect(noiseShot, noiseShot);
    expect(selfCheck.count, '同一帧自比必须得到 0 个簇（掩膜为空）').toBe(0);

    await page.evaluate(async (holdMs) => {
      const g = window.__MC_GAME__;
      g.player.weaponController.pointerDown(g.player._buildAim());
      await new Promise((r) => setTimeout(r, holdMs));
      g.player.weaponController.pointerUp(g.player._buildAim());
    }, HOLD_MS);
    // hold 期火花最密
    await page.waitForTimeout(330);
    const fireShot = await page.screenshot();
    const fireAsp = streakAspect(baseShot, fireShot);

    console.log('R3_ASPECT', JSON.stringify({ fireAsp }));
    expect(fireAsp.count, `必须采到足够多的火花簇，实测 ${fireAsp.count}`).toBeGreaterThanOrEqual(5);
    // 圆形 quad 的簇恒近正方形（比≈1），**与速度无关**；STREAK 沿速度拉伸。
    // ⚠️ **判据取 p90 而不是中位数**：火花速度方向与视线的夹角均匀分布，
    // 正对视线的那部分投影后本来就接近方形 ⇒ 中位数稳定落在 1.4（物理正确，不是缺陷）。
    // 拉伸只在上分位看得见：实测 p90 **2.33**，与 stretch=1+0.18·|vel|（2.0~3.3）吹合。
    // 阈值 1.8 落在「圆点≈1.0~1.2」与「实测 2.33」之间，两侧都不贴线。
    expect(fireAsp.p90,
      `火花簇 p90 长宽比必须明显 >1.8（圆点≈1），实测 ${fireAsp.p90}`).toBeGreaterThan(1.8);
    // 中位数只作弱下界：钉「整体确实变狭长了」，不拿它做主要判据
    expect(fireAsp.median,
      `火花簇中位长宽比应 >1.1（圆点≈1），实测 ${fireAsp.median}`).toBeGreaterThan(1.1);
  });

  test('R4：落点爆壳前 20% 寿命就猛扩（outQuint 而非慢胀）', async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`/?seed=${SEED}&vd=6&shadows=0&reflect=0`);
    await waitWorldReady(page);
    await gotoOpenField(page);
    await setupVisual(page);

    const r = await page.evaluate(async (holdMs) => {
      const g = window.__MC_GAME__;
      g.player.weaponController.pointerDown(g.player._buildAim());
      await new Promise((res) => setTimeout(res, holdMs));
      g.player.weaponController.pointerUp(g.player._buildAim());
      // 等 travel 走完（24/105 ≈ 229ms）+ 一点余量 ⇒ 爆壳刚生成
      await new Promise((res) => setTimeout(res, 260));
      const born = g.stormLance._burstAt;
      const size = g.stormLance._burstSize;
      const from = g.stormLance._burstFrom;
      const life = g.stormLance._burstLife * 1000;
      const readAt = async (frac) => {
        // 直接推进到指定寿命比例（不等真实时间，避免采样抖动）
        g.stormLance.update(born + life * frac, 0.016);
        return g.stormLance.burstMesh.scale.x;
      };
      const s10 = await readAt(0.10);
      const s20 = await readAt(0.20);
      const s50 = await readAt(0.50);
      return { size, from, s10, s20, s50, kind: g.stormLance._impactKind };
    }, HOLD_MS);

    const ratio = (s) => (s - r.from) / (r.size - r.from);
    console.log('R4_BURST', JSON.stringify({ ...r, r10: ratio(r.s10), r20: ratio(r.s20), r50: ratio(r.s50) }));
    // outQuint: t=0.1 → 0.410, t=0.2 → 0.672, t=0.5 → 0.969
    // outCubic: t=0.1 → 0.271, t=0.2 → 0.488, t=0.5 → 0.875
    // 取 0.6 作为分界（outQuint 0.672 过，outCubic 0.488 不过）
    expect(ratio(r.s20),
      `20% 寿命时必须已扩张 >60%（outQuint 0.672 / outCubic 0.488），实测 ${ratio(r.s20).toFixed(3)}`)
      .toBeGreaterThan(0.6);
    expect(ratio(r.s10),
      `10% 寿命时应 >35%（outQuint 0.410 / outCubic 0.271），实测 ${ratio(r.s10).toFixed(3)}`)
      .toBeGreaterThan(0.35);
  });
});
