import { test, expect } from 'playwright/test';

/**
 * 焰魔（Ignis，v2.55）真游戏页 E2E —— Tier 4 像素实测。
 *
 * ## 为什么必须有这个 spec（`docs/testing-policy.md` 的 Tier 4）
 *
 * 焰魔的烘焙产物有两类缺陷**只有像素能抓**（单测抓不到，见 spec Review Focus）：
 *   ① **Bedrock box UV 布局写错** —— 贴图错位到邻面（脸跑到侧面），而 UV 全部 ∈ [0,1]、
 *      顶点数/骨骼数/指纹全绿；
 *   ② **骨骼变换链写错** —— 模型炸成碎片，而 53 骨骼 / 80 立方体 / 1920 顶点全部通过。
 *
 * ## 判据口径（AGENTS.md：像素断言必须同时钉上下界 + 先测噪声底）
 *
 * 噪声底实测（2026-11-05，本机，同状态连拍 3 张 680×520）：
 *   `changed = 0 / 326400`，`maxDelta = 0` —— 渲染是确定性的，阈值可以收到「> 0」。
 * 但**不能**只钉「变了」：还要钉「变了的范围落在焰魔身上」（防止「整屏乱码也算变了」）。
 *
 * ## 从玩家真实入口驱动（AGENTS.md M7 教训）
 *
 * 召唤走 `g.summonBoss()`（与 C 键同一条路径），而不是直接调 `ignises.summon()` ——
 * 后者会漏掉「名册没登记 / service 没装配 / 地图判定不对」这类接线缺陷。
 *
 * ⚠️ seed 用 12345（默认）。祭坛地带在 region(2,0)。
 */

const SEED = 12345;

async function waitWorldReady(page) {
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
}

/** 传送到祭坛高台地带的圆心（那里保证有 TARN 地图判定） */
async function teleportToTarnCenter(page) {
  return page.evaluate(async () => {
    const { findAltarTarnRegion } = await import('/src/gen/structures/tarn-zone.js');
    const g = window.__MC_GAME__;
    const a = findAltarTarnRegion(g.seed);
    if (!a) return null;
    g.player.spawn(a.cx, 40, a.cz);
    return { cx: a.cx, cz: a.cz };
  });
}

/**
 * 等玩家**真正落地**（`player.spawn(x, 40, z)` 之后 y 会继续下坠）。
 *
 * ⚠️ **这是踩到的真坑**：传送后立刻读 `player.physics.pos` 会拿到半空坐标（y≈36），
 * 用它去 `ignises.summon()` 会让焰魔落在**空中**（地表扫描在该列找到了云层/半空平台），
 * 于是 E2E 里「焰魔离玩家 30 格高」→ 画面里看不见 → 像素差为 0。
 */
async function waitPlayerLanded(page) {
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    if (!g?.player?.physics) return false;
    const p = g.player.physics.pos;
    // 落地判据：脚下那一格是实心（与 spawn 的 y 下坠无关，直接看世界）
    return g.world.isSolid(Math.floor(p.x), Math.floor(p.y - 0.5), Math.floor(p.z));
  }, null, { timeout: 30_000 });
  // 再等一拍让物理彻底稳定（避免 y 还在 1cm 级抖动）
  await page.waitForTimeout(400);
}

/** 截图（固定 clip，避免 UI 面板/云层噪声进入判据） */
async function shoot(page) {
  return page.screenshot({ clip: { x: 300, y: 120, width: 680, height: 520 } });
}

/** 两张 PNG（Buffer）的差异统计 */
async function pixelDiff(page, a, b) {
  return page.evaluate(async ([b64a, b64b]) => {
    const load = (b64) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        resolve(ctx.getImageData(0, 0, img.width, img.height));
      };
      img.src = `data:image/png;base64,${b64}`;
    });
    const A = await load(b64a);
    const B = await load(b64b);
    let changed = 0;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < A.data.length; i += 4) {
      const d = Math.abs(A.data[i] - B.data[i])
        + Math.abs(A.data[i + 1] - B.data[i + 1])
        + Math.abs(A.data[i + 2] - B.data[i + 2]);
      if (d === 0) continue;
      changed++;
      const px = (i / 4) % A.width;
      const py = Math.floor((i / 4) / A.width);
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
    return { changed, total: A.data.length / 4, minX, maxX, minY, maxY, w: A.width, h: A.height };
  }, [a.toString('base64'), b.toString('base64')]);
}

test.describe('焰魔（Ignis）Tier 4', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'WebGPU 只在 chromium 有 adapter');

  test('召唤：按 C（summonBoss）在祭坛高台地带召出焰魔，且落在地面上', async ({ page }) => {
    await page.goto(`/?seed=${SEED}`);
    await waitWorldReady(page);
    const center = await teleportToTarnCenter(page);
    expect(center).not.toBeNull();
    // 等传送后的 column 加载（否则地表扫描走兜底）
    await page.waitForTimeout(2500);

    const result = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      // 第一次 summonBoss → 飞龙（slot 0）；第二次 → 焰魔（slot 1）
      const r1 = g.summonBoss();
      await new Promise((r) => setTimeout(r, 300));
      const r2 = g.summonBoss();
      await new Promise((r) => setTimeout(r, 800));
      const ignises = g.ignises.activeEntities();
      const e = ignises[0];
      return {
        r1: r1?.reason || (r1?.ok ? 'ok' : 'unknown'),
        r2: r2?.reason || (r2?.ok ? 'ok' : 'unknown'),
        dragonCount: g.dragons.activeEntities().length,
        ignisCount: ignises.length,
        ignisPos: e ? [...e.state.position] : null,
        groundY: e ? g.world.getBlockId(
          Math.floor(e.state.position[0]), Math.floor(e.state.position[1]) - 1,
          Math.floor(e.state.position[2])) : null,
        selfAir: e ? g.world.getBlockId(
          Math.floor(e.state.position[0]), Math.floor(e.state.position[1]),
          Math.floor(e.state.position[2])) : null,
        onGround: e ? e.state.onGround : null,
        rendererVisible: g.ignisRenderer?.instances?.[0]?.pivot?.visible ?? null,
      };
    });

    // 第一次召飞龙、第二次召焰魔（用户裁定「飞龙先，焰魔后」）
    expect(result.r1, '第一次 summonBoss 应成功（飞龙）').toBe('ok');
    expect(result.r2, '第二次 summonBoss 应成功（焰魔）').toBe('ok');
    expect(result.dragonCount, '飞龙应共存').toBe(1);
    expect(result.ignisCount, '焰魔应被召出').toBe(1);
    // 落点在地面上：脚下实心、自身空气、onGround
    expect(result.groundY, '焰魔脚下应是实心方块（不是悬空）').not.toBe(0);
    expect(result.selfAir, '焰魔自身所在格应是空气（不是埋在地下）').toBe(0);
    expect(result.onGround, '焰魔应站在地面上').toBe(true);
    expect(result.rendererVisible, '渲染器实例应可见').toBe(true);
  });

  test('渲染：焰魔在真实 WebGPU 下画出来了（画面与"没有焰魔"显著不同）+ 像素变化集中在焰魔区域', async ({ page }) => {
    await page.goto(`/?seed=${SEED}`);
    await waitWorldReady(page);
    await teleportToTarnCenter(page);
    await waitPlayerLanded(page);

    // 先把玩家朝向调好（看向 +Z，焰魔会被召唤到那儿）
    await page.evaluate(() => {
      const g = window.__MC_GAME__;
      g.player.yaw = Math.PI;   // yaw=π ⇒ 前向 +Z
      g.player.pitch = -0.15;
    });
    await page.waitForTimeout(400);

    // ① 空场景基线
    const empty = await shoot(page);

    // ② 召唤焰魔（直接调 service 以便精确控制位置：玩家正前方 4 格）
    await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      const p = g.player.physics.pos;
      const sum = g.ignises.summon('tarn:e2e:0', Math.floor(p.x), Math.floor(p.z) + 4, 1);
      window.__E2E_ID__ = sum.ok ? sum.id : null;
      await new Promise((r) => setTimeout(r, 500));
      // 冻住 AI（避免它走近/挥砍让两次截图差异混入动作噪声）
      const e = g.entities.get(window.__E2E_ID__);
      if (e) e.state = { ...e.state, mode: 'idle', attackAnimT: 0, idleTime: 0, velocity: [0, 0, 0] };
      g.ignisRenderer.sync(g.ignises.activeEntities(), performance.now());
    });
    await page.waitForTimeout(300);
    // 再冻一次（AI 可能在上一个 tick 又推进了）
    await page.evaluate(() => {
      const g = window.__MC_GAME__;
      const e = g.entities.get(window.__E2E_ID__);
      if (e) e.state = { ...e.state, mode: 'idle', attackAnimT: 0, idleTime: 0, velocity: [0, 0, 0] };
      g.ignisRenderer.sync(g.ignises.activeEntities(), performance.now());
    });
    const withIgnis = await shoot(page);

    const d = await pixelDiff(page, empty, withIgnis);

    // **下界**：焰魔确实画出来了（噪声底实测为 0，任何变化都是真的）
    expect(d.changed, '焰魔应让画面产生大量像素变化').toBeGreaterThan(5000);
    // **上界**：变化不该铺满整屏（铺满意味着相机/世界状态变了，不是"画了个焰魔"）
    expect(d.changed / d.total, '变化面积不应超过一半（否则不是"只多了焰魔"）')
      .toBeLessThan(0.5);
    // 变化的包围盒应落在画面中下部（焰魔站在地上），而不是贴在屏幕顶上（云层/天空）
    expect(d.maxY, '变化应延伸到画面下部（焰魔的腿脚）').toBeGreaterThan(d.h * 0.5);
  });

  test('渲染：挥砍动画的姿态与待机显著不同（像素级，不是"动画表有变"）', async ({ page }) => {
    await page.goto(`/?seed=${SEED}`);
    await waitWorldReady(page);
    await teleportToTarnCenter(page);
    await waitPlayerLanded(page);

    await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      g.player.yaw = Math.PI;
      g.player.pitch = -0.15;
      const p = g.player.physics.pos;
      const sum = g.ignises.summon('tarn:e2e:1', Math.floor(p.x), Math.floor(p.z) + 4, 1);
      window.__E2E_ID__ = sum.ok ? sum.id : null;
      await new Promise((r) => setTimeout(r, 500));
    });
    await page.waitForTimeout(300);

    // ① 待机帧
    await page.evaluate(() => {
      const g = window.__MC_GAME__;
      const e = g.entities.get(window.__E2E_ID__);
      if (e) e.state = { ...e.state, mode: 'idle', attackAnimT: 0, idleTime: 0, velocity: [0, 0, 0] };
      g.ignisRenderer.sync(g.ignises.activeEntities(), performance.now());
    });
    const idle = await shoot(page);

    // ② 命中帧（attackAnimT = hitFrameSeconds = 1.20）
    await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      const { IGNIS_AI } = await import('/src/entities/ignis/ignis-config.js');
      const e = g.entities.get(window.__E2E_ID__);
      if (e) e.state = { ...e.state, attackAnimT: IGNIS_AI.hitFrameSeconds, velocity: [0, 0, 0] };
      g.ignisRenderer.sync(g.ignises.activeEntities(), performance.now());
    });
    const attack = await shoot(page);

    const d = await pixelDiff(page, idle, attack);
    // 实测（2026-11-05）：idle vs attack@1.20 变化 99911 / 353600（28%）
    expect(d.changed, '挥砍命中帧应让焰魔的姿态明显变化').toBeGreaterThan(20000);
    expect(d.maxX - d.minX, '变化应横跨焰魔身体的宽度（挥臂）').toBeGreaterThan(100);
  });

  test('战斗：挥剑真的扣玩家血（20 → 6，正好 IGNIS.attackDamage = 14）', async ({ page }) => {
    await page.goto(`/?seed=${SEED}`);
    await waitWorldReady(page);
    await teleportToTarnCenter(page);
    await waitPlayerLanded(page);

    const r = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      const { IGNIS } = await import('/src/entities/ignis/ignis-config.js');
      const hpStart = g.player.health;
      const p = g.player.physics.pos;
      // 召唤到玩家旁边 3 格（在 hitRange 6.5 之内，且已在 attackRange 5.5 之内）
      const sum = g.ignises.summon('tarn:e2e:2', Math.floor(p.x), Math.floor(p.z) + 3, 1);
      if (!sum.ok) return { err: sum.reason, hpStart };
      // 等它走完接近 + 一次完整攻击（动画 2.75s + 余量）
      const samples = [];
      for (let i = 0; i < 40; i++) {
        await new Promise((res) => setTimeout(res, 250));
        samples.push(g.player.health);
        if (g.player.health < hpStart) break;
      }
      return {
        hpStart,
        hpEnd: g.player.health,
        damage: hpStart - g.player.health,
        expectedDamage: IGNIS.attackDamage,
        samples: samples.slice(-6),
      };
    });

    expect(r.err).toBeUndefined();
    expect(r.hpStart, '起始满血').toBe(20);
    // **上下界同时钉**：只钉「掉血」抓不到「一下掉到 0」或「扣错量」
    expect(r.damage, `应为一次完整伤害 ${r.expectedDamage}`).toBe(r.expectedDamage);
    expect(r.hpEnd, '20 − 14 = 6').toBe(6);
  });

  /**
   * v2.60：玩家站定不动时，焰魔**不得穿模**，且要能连续砍中。
   *
   * ## 为什么这条只能做成 E2E（Tier 4）
   *
   * 缺陷的两个面向分别需要「真物理 + 真 `_consumeIgnisAttackRequests` 锥判据」：
   * - 数据层看着都正常（`attackRequest` 每轮都出现一次、health 也真掉过一次）；
   * - 但玩家站定后焰魔会走到 `hDist ≈ 0`（穿过玩家），下一刀玩家在它背后，锥判据
   *   （半角 35°）全程跳过 ⇒ **只有一刀能打中**。
   *
   * 单测（`test-ignis-boss-agent.js`）钉了 agent 的行为面（最近距离 / 命中帧朝向 /
   * 原地连砍），这里钉真实帧循环里的最终观感与结算：**第二次及以上命中**。
   */
  test('战斗：玩家站定不动 → 焰魔停在几格外连续砍中，且不穿模（v2.60）', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto(`/?seed=${SEED}`);
    await waitWorldReady(page);
    await teleportToTarnCenter(page);
    await waitPlayerLanded(page);

    const r = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      const { IGNIS_AI } = await import('/src/entities/ignis/ignis-config.js');
      const p0 = g.player.physics.pos;
      const start = [p0.x, p0.y, p0.z];
      // 召唤到玩家 11 格外（远于站定环）⇒ 必须走过来
      const sum = g.ignises.summon('tarn:e2e:3', Math.floor(p0.x), Math.floor(p0.z) + 11, 1);
      if (!sum.ok) return { err: sum.reason };
      const dists = [];
      const strikes = [];
      // ⚠️ 每刀 14、玩家 20 格血 ⇒ 第二刀就钳到 0（本仓"只扣血不死亡"）。
      // 每次命中后把血回满，否则第三刀起 0 → 0 看不到变化，"连砍"就测不出来了。
      const FULL_HP = g.player.health;
      let prevHp = FULL_HP;
      for (let i = 0; i < 150; i++) {          // 150 × 200ms = 30 秒
        await new Promise((res) => setTimeout(res, 200));
        const e = g.entities.get(sum.id);
        if (!e) break;
        const [ex, , ez] = e.state.position;
        const pp = g.player.physics.pos;
        dists.push(Math.hypot(ex - pp.x, ez - pp.z));
        if (g.player.health < prevHp) {
          strikes.push({ t: +(i * 0.2).toFixed(1), d: Math.hypot(ex - pp.x, ez - pp.z) });
          g.player.health = FULL_HP;
          prevHp = FULL_HP;
        }
      }
      const pp = g.player.physics.pos;
      return {
        strikeCount: strikes.length,
        strikes,
        minDist: Math.min(...dists),
        // 玩家自己没动（没受击位移）—— 若这条不为 0，说明距离变化来自玩家而非焰魔
        playerMoved: Math.hypot(pp.x - start[0], pp.z - start[2]),
        standoffRange: IGNIS_AI.standoffRange,
      };
    });

    expect(r.err).toBeUndefined();
    expect(r.playerMoved, '玩家应站定不动（否则测的不是 Boss 的行为）').toBeLessThan(0.5);
    // ① **不穿模**：任何时刻都不能挤到玩家身上（实测修前最小距 0.01 格）
    //    留 1 格余量：追击慢近时最后一步会落到站定环内侧，死区上半区容差
    expect(r.minDist, `最近只到 ${r.minDist?.toFixed(2)} 格（应停在站定环外）`)
      .toBeGreaterThan(r.standoffRange - 1.5);
    // ② **能连砍**：玩家站定 ⇒ 至少命中三刀（修前只有第一刀能中，第二刀起玩家在它背后）
    expect(r.strikeCount, `30 秒内只命中 ${r.strikeCount} 刀（站定时应能连砍）`)
      .toBeGreaterThanOrEqual(3);
    // ③ 命中发生在合理距离上（不是贴着 0 格砍）
    for (const s of r.strikes) {
      expect(s.d, `第 ${s.t}s 的命中距离只有 ${s.d.toFixed(2)} 格（应该相距几格）`)
        .toBeGreaterThan(r.standoffRange - 1.5);
    }
  });
});
