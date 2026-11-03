import { test, expect } from 'playwright/test';

// v2.46：在线丧尸 AI（Jev）真实接口验收（spec §5.2）。
//
// ⚠️ **会真实调用 https://js-perf.cn/typesafe**（用户 2026-11-03 已同意）：每步约 1100 input tokens。
// ⚠️ **单独跑**，不要与全量并发（会与计时型 spec 抢 CPU）：
//     npx playwright test tests/zombie-jev-ai.spec.mjs
//
// ## 判据为什么是「U 形墙」而不是「一道墙」
//
// 实测（2026-11-03）：一面 5 格宽的直墙对**离线 AI 不构成障碍** —— 它的 1.2 格探针
// 在墙角试到 ±90° 就能沿墙蹭过去，40 秒内关/开两种模式都能到玩家身边（endDist 4.1 / 4.9）。
// 那种地形测不出在线 AI 的价值，只能测「有没有接线」。
//
// U 形（三面封闭、开口朝玩家反方向）才是离线 AI 的死角：探针要连续多次偏移才能绕出 U 底，
// 而它没有记忆，会反复贴在同两面墙角上。这是 spec §2.3 rollout 里「长迷宫：离线 AI
// 循环失败 / Jev 走通」的同一类形态。
//
// ⚠️ 构造的两个口径来自既有用例（tests/zombies.spec.mjs 的 v2.40 绕墙用例）：
// ① **先造墙、后 spawn** —— spawn 校验脚格/头格必须 air；
// ② **必须找平坦地带** —— 默认 seed 的城市边缘有 10+ 格落差，那种地形本身走不通。

async function waitWorldReady(page) {
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    return !!(g && g.world && g.player && g.zombies);
  }, { timeout: 90_000 });
}

test('v2.46：墙端缺口绕行 —— 开在线 AI 能绕出，关时被墙挡住（对照）', async ({ page }) => {
  test.setTimeout(420_000);

  // ---------- 关（基线：离线 AI 应被困在 U 底）----------
  await page.goto('/?vd=4&seed=12345&zombieai=0');
  await waitWorldReady(page);
  expect(await page.evaluate(() => window.__MC_GAME__.onlineZombieAiEnabled())).toBe(false);
  const off = await runUScenario(page);
  expect(off.error, JSON.stringify(off)).toBeUndefined();

  // ---------- 开（在线 AI：期望绕出）----------
  await page.goto('/?vd=4&seed=12345&zombieai=1');
  await waitWorldReady(page);
  expect(await page.evaluate(() => window.__MC_GAME__.onlineZombieAiEnabled())).toBe(true);
  const on = await runUScenario(page);
  expect(on.error, JSON.stringify(on)).toBeUndefined();

  console.log('[zombie-jev-ai] off =', JSON.stringify(off));
  console.log('[zombie-jev-ai] on  =', JSON.stringify(on));

  const dbg = on.debug ?? {};
  // 网关会间歇性拦截（spec §2.1）。一次成功决策都没有 → 跳过质量断言而不是假红，
  // 但必须把 lastReason 带进 skip 信息里。
  test.skip((dbg.decided ?? 0) === 0,
    `在线 AI 全程未成功决策（lastReason=${dbg.lastReason ?? 'n/a'}），跳过质量断言`);

  // 载荷性断言：开的这次必须绕出 U（越过墙口所在平面）
  expect(on.escaped, `在线 AI 须绕出 U 形（trace=${JSON.stringify(on.trace)}）`).toBe(true);
  expect(on.endDist).toBeLessThan(on.startDist - 3);
  // 证明在线路径确实在工作（不是恰好被离线 AI 绕出去）
  expect(dbg.decided).toBeGreaterThan(0);
  // 内侧对照：离线 AI 在这种地形上不该同样轻松绕出（否则本用例没有判别力）
  expect(off.escaped, `离线 AI 不该绕出（trace=${JSON.stringify(off.trace)}）`).toBe(false);
});

/**
 * 在平坦开阔处摆一个 U 形（三面 3 格高墙 + 开口朝北），丧尸放在 U 底，玩家在 U 外北侧。
 * 跑 60 秒后读结果。
 */
async function runUScenario(page) {
  return page.evaluate(async () => {
    const g = window.__MC_GAME__;
    g.setShadowsEnabled(false);
    const surfaceAt = (x, z) => {
      for (let y = 60; y >= -20; y--) {
        if (g.world.isSolid(x, y, z) && g.world.getBlockId(x, y + 1, z) === 0 && g.world.getBlockId(x, y + 2, z) === 0) return y + 1;
      }
      return null;
    };
    const base = g.player.physics.pos;
    // ⚠️ **必须在城外找空地**：默认 seed 的出生点在 City 中心，半径 20 格内全是建筑
    // （实测高差 11~44 格），摆出来的 U 形墙会架在楼顶/楼缝里，测的是地形不是 AI。
    // 做法 = 沿 +x 方向找「整片 15×15 高差 ≤2」的平原（城市东侧是草地/浅水高台过渡带）。
    // 扫描「U 足迹完全同高」的锚点：只接受 maxDiff == 0（逐点比同一个基准高度）。
    // ⚠️ 不摊开搜整张图：城市中心半径 20 格内全是建筑（实测高差 11~44），
    // 开阔平原在距出生点 40 格以外（实测 (-40,+40) 高差 0）。
    const footprint = [];
    for (let k = -5; k <= 5; k++) for (let j = -6; j <= 5; j++) footprint.push([k, j]);
    let site = null;
    outer:
    for (let r = 0; r <= 200; r += 20) {
      for (const [dx, dz] of [[-r, r], [r, r], [-r, -r], [r, -r], [r, 0], [-r, 0], [0, r], [0, -r]]) {
        const ax = Math.floor(base.x) + dx;
        const az = Math.floor(base.z) + dz;
        const yHere = surfaceAt(ax, az);
        if (yHere === null) continue;
        let ok = true;
        for (const [k, j] of footprint) {
          if (surfaceAt(ax + k, az + j) !== yHere) { ok = false; break; }
        }
        if (!ok) continue;
        site = { x: ax, z: az, y: yHere };
        break outer;
      }
    }
    if (!site) return { error: 'no flat site found' };

    const stone = g.registry.idOf('stone');
    const { x: ax, y: ay, z: az } = site;
    // ---- 摆「短墙 + 端部缺口」（3 格高）----
    // 墙：z = az，x ∈ [ax-4, ax+2]（7 格宽）
    // 缺口：x ∈ [ax+3, ax+4]（墙东端以外 2 格）→ 丧尸必须向东绕 3~4 格再向北
    //
    // ## 为什么用「短墙缺口」而不是 U 形
    // 实测（2026-11-03，两轮）：U 形（内腔 5×5、开口朝南、丧尸在 U 底）**两侧都出不去** ——
    // 开口在 6~7 格外，超出 9×9 窗口的可见范围，模型看不到出口，记忆也只有局部信息。
    // 那不是接线缺陷，是 spec §7「已知取舍」写明的能力边界（只看 9×9 局部）。
    // 「短墙缺口」把出口**放进窗口内**，测的才是「在线 AI 能不能利用看到的出口绕行」——
    // 这正是在线模型相对 1.2 格局部探针的价值所在。
    for (let dy = 0; dy < 3; dy++) {
      for (let k = -4; k <= 2; k++) {
        g.editor.setBlock({ x: ax + k, y: ay + dy, z: az, id: stone });
      }
    }
    // ---- 玩家在墙北侧、正对墙心 ----
    g.player.physics.pos.x = ax + 0.5;
    g.player.physics.pos.z = az - 6 + 0.5;
    g.player.physics.pos.y = ay;
    g.player.physics.vel.x = 0; g.player.physics.vel.y = 0; g.player.physics.vel.z = 0;
    await new Promise((r2) => setTimeout(r2, 400));
    // ---- 丧尸在墙南侧、正对墙心（缺口在它东侧 3~4 格）----
    const sx = ax;
    const sz = az + 3;
    const id = g.zombies.spawn([sx + 0.5, ay, sz + 0.5], { source: 'test-online-ai' });
    if (!id) return { error: 'spawn rejected', site, spawn: [sx, ay, sz] };
    const p = g.player.physics.pos;
    const startDist = Math.hypot(sx + 0.5 - p.x, sz + 0.5 - p.z);
    await new Promise((r2) => setTimeout(r2, 45_000));
    const st = g.zombies.get(id);
    if (!st) return { error: 'zombie despawned', startDist, site };
    const now = st.position;
    return {
      id,
      site,
      startDist: +startDist.toFixed(2),
      endDist: +Math.hypot(now[0] - p.x, now[2] - p.z).toFixed(2),
      // 「绕出」= 越过墙所在平面（z=az）到达玩家那一侧
      escaped: now[2] < az,
      mode: st.mode,
      debug: g.zombies.debugOnlineAi(),
      trace: [[sx, ay, sz], now.map((v) => +v.toFixed(2))],
    };
  });
}
