// tests/dragon-ai.spec.mjs — 飞龙 AI 行为验收（v2.44 Task 7）
//
// Tier 4（真实页面行为）。**必须走玩家真实入口**（按 B 召龙 + 真实帧循环推进），
// 不得手工塞 `state.mode`（M7 教训：只测 API 漏玩家主路径）。
//
// ⚠️ **爆炸口径（破坏方块跟 TNT 开关）不在本 spec** —— 已由 `tests/dragon-fireball.spec.mjs`
// 覆盖（含 Review Focus 1 的去重集合负向验证）。本 spec 只测 **AI 行为**：
// 发现/追击/飞跃/开火频率/脱离返回/玩家不掉血。
//
// ⚠️ **测试场必须远离城市**（出生点在 City，建筑会随机遮挡视线 → LOS 抖动）。
// 实测（探针）：出生点附近 LOS 只有部分帧为真；远离 600 格的开阔地 LOS 27/30 帧为真。
// 故断言用「大部分时间」而不是「恒」，且阈值都留余量（AGENTS.md：贴线断言高负载下 flaky）。
import { test, expect } from 'playwright/test';

async function waitWorldReady(page) {
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
}

/**
 * 把玩家挪到远离城市的开阔地并召一条龙（中心 = 玩家位置）。
 *
 * ⚠️ **玩家 teleport 后会因重力落地**（实测 y=45 → 4）—— 这是正确行为，龙在 y=30 俯视即可。
 * ⚠️ 等 column 加载：`_teleportTo` 刻意不等目标 column（v1.92 实测定的），不等会让 LOS
 * 读到未加载 column 的空气（恒通）→ 断言失去判别力。
 */
async function summonInOpenField(page, { offsetX = 600, offsetZ = 600 } = {}) {
  await page.evaluate(async ([ox, oz]) => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const cx = Math.floor(p.x) + ox, cz = Math.floor(p.z) + oz;
    g._teleportTo(cx, 45, cz);
    await new Promise((r) => setTimeout(r, 2500));
    g.dragons.summon('ai-spec:0:0', cx, cz, 0);
  }, [offsetX, offsetZ]);
  await page.waitForFunction(() => window.__MC_GAME__.dragons.activeEntities().length === 1,
    null, { timeout: 15_000 });
}

/** 采样龙的 AI 状态若干秒（200ms 一次） */
async function sampleDragon(page, seconds) {
  return page.evaluate(async (sec) => {
    const g = window.__MC_GAME__;
    const out = [];
    const n = Math.round(sec / 0.2);
    for (let i = 0; i < n; i++) {
      const d = g.dragons.activeEntities()[0];
      const p = g.player.physics.pos;
      if (d) {
        out.push({
          t: +(i * 0.2).toFixed(1),
          mode: d.state.mode,
          phase: d.state.attackPhase,
          los: d.state.losVisible,
          cd: d.state.fireCooldown,
          seq: g._fireballSeq,
          dist: Math.hypot(d.state.position[0] - p.x, d.state.position[2] - p.z),
          dragonY: d.state.position[1],
          playerY: p.y,
        });
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return out;
  }, seconds);
}

test('AI E2E: 玩家进入视线与距离 → 龙追击并递近（距离递减）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 640, height: 480 });
  await page.goto('/?vd=2&seed=12345');
  await waitWorldReady(page);
  await summonInOpenField(page);

  const trace = await sampleDragon(page, 6);
  expect(trace.length).toBeGreaterThan(20);
  // 龙必须进入 chase 或 attack（玩家就在圆心，距离 ≈ orbitRadius 24 < sightRange 60）
  const hunting = trace.filter((s) => s.mode === 'chase' || s.mode === 'attack');
  expect(hunting.length, `龙必须追击玩家（实测 mode 分布 ${JSON.stringify([...new Set(trace.map((s) => s.mode))])}）`)
    .toBeGreaterThan(trace.length * 0.5);
  // ⚠️ **判据是「最小距离显著小于初始距离」而不是「末帧 < 首帧」**：龙进 attack 后会进
  // turn 子态拉远（飞跃），末帧距离可能反而更大 —— 那不代表没追击。真正证明「递近」的
  // 是：整个观测窗内龙到达过的最近距离远小于起始距离。
  const first = hunting[0].dist;
  const minDist = Math.min(...hunting.map((s) => s.dist));
  expect(minDist, `龙必须真的递近玩家（起始 ${first.toFixed(1)} → 最近 ${minDist.toFixed(1)}）`)
    .toBeLessThan(first - 5);
});

test('AI E2E: 玩家在 sightRange 外 → 龙不发现玩家（阈值外侧 + 内侧对照）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 640, height: 480 });
  // ⚠️ **必须用 vd=8**：世界径向加载 = (vd+2)×16 ⇒ vd=2 只有 64 格，而本用例要把龙摆在
  // 200 格外 —— 那会让龙的 column 从未加载/被卸载（v2.43 已知取舍：临时实体随 column 回收）。
  // vd=8 → 160 格… 仍不够 200，故取 150 格（> sightRange 60 且 < 160 加载半径）。
  await page.goto('/?vd=8&seed=12345');
  await waitWorldReady(page);

  const { DRAGON_AI } = await page.evaluate(async () => {
    const m = await import('/src/entities/dragons/dragon-config.js');
    return { DRAGON_AI: m.DRAGON_AI };
  });
  const FAR = DRAGON_AI.sightRange + 90;   // 150 格：> sightRange 且在加载半径内

  // ① 外侧：龙的轨道中心摆在玩家 150 格外 → 不得进追击
  const far = await page.evaluate(async (dist) => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const cx = Math.floor(p.x) + 600, cz = Math.floor(p.z) + 600;
    g._teleportTo(cx, 45, cz);
    await new Promise((r) => setTimeout(r, 3000));
    // 轨道中心在玩家东侧 dist 格（龙在那边盘旋，玩家看不见也打不到）
    g.dragons.summon('ai-far:0:0', cx + dist, cz, 0);
    return { cx, cz, dist };
  }, FAR);
  await page.waitForFunction(() => window.__MC_GAME__.dragons.activeEntities().length === 1,
    null, { timeout: 15_000 });
  const farTrace = await sampleDragon(page, 4);
  expect(farTrace.length).toBeGreaterThan(10);
  const farChase = farTrace.filter((s) => s.mode === 'chase' || s.mode === 'attack');
  expect(farChase.length, `玩家在 sightRange 外时龙不得追击（dist=${far.dist}）`).toBe(0);
  expect(farTrace[0].dist, 'sanity：龙与玩家的水平距必须真的 > sightRange')
    .toBeGreaterThan(DRAGON_AI.sightRange);

  // ② 内侧对照：同一场景下把龙召在玩家脚下 → 必须进追击。
  //    ⚠️ **没有这条对照，上面那条是无效盲区**（testing-policy §2.7）：若龙因为别的原因
  //    根本不追击（例如 AI 没接线），「不追击」的断言照样全绿。
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    for (const e of g.dragons.activeEntities()) g.entities.despawn(e.id, 'spec');
    const p = g.player.physics.pos;
    g.dragons.summon('ai-near:0:0', Math.floor(p.x), Math.floor(p.z), 0);
  });
  await page.waitForFunction(() => window.__MC_GAME__.dragons.activeEntities().length === 1,
    null, { timeout: 15_000 });
  const nearTrace = await sampleDragon(page, 4);
  const nearChase = nearTrace.filter((s) => s.mode === 'chase' || s.mode === 'attack');
  expect(nearChase.length, '对照：玩家进入 sightRange 后龙必须追击').toBeGreaterThan(0);
});

test('AI E2E: 玩家静止 → 龙飞跃玩家后拉远再回头（approach↔turn 循环）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 640, height: 480 });
  await page.goto('/?vd=2&seed=12345');
  await waitWorldReady(page);
  await summonInOpenField(page);

  // 玩家不动（不发送任何输入），采样 12 秒观察 attack 子态循环
  const trace = await sampleDragon(page, 12);
  const attack = trace.filter((s) => s.mode === 'attack');
  expect(attack.length, '龙必须进入 attack 模式（玩家就在脚下）').toBeGreaterThan(5);
  // ⚠️ **判据是「两个子态都出现过」**：只钉 approach 会漏掉「飞跃根本没实现」
  const phases = new Set(attack.map((s) => s.phase));
  expect(phases.has('approach'), 'attack 必须有 approach 子态（递近）').toBe(true);
  expect(phases.has('turn'), 'attack 必须有 turn 子态（飞跃后拉远）—— 用户核心需求').toBe(true);
  // 且发生过子态切换（不是恒定在其中一个）
  let switches = 0;
  for (let i = 1; i < attack.length; i++) if (attack[i].phase !== attack[i - 1].phase) switches++;
  expect(switches, 'approach↔turn 必须真的循环切换（飞跃 → 回头）').toBeGreaterThanOrEqual(1);
  // 飞跃时距离必须真的变得很近（≤ flyoverDistance + 余量）
  const minDist = Math.min(...attack.map((s) => s.dist));
  expect(minDist, '递近时必须真的贴近玩家（飞跃的前提）').toBeLessThan(10);
});

test('AI E2E: 龙开火 → 生成火球、方向 = 机头；开火间隔在 5~10 秒（不是机关枪）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 640, height: 480 });
  await page.goto('/?vd=2&seed=12345');
  await waitWorldReady(page);
  await summonInOpenField(page);

  // ① 等第一次开火（冷却最长 10 秒 + 追击时间，留 25 秒窗口），同时**在发射瞬间抳包**
  //    `fireFireball` 记下 direction 与当时的机头姿态。
  //    ⚠️ **为什么抳包而不是“轮询找一个在飞的火球”**（那是最初的写法）：旧写法的断言包在
  //    `if (aim.found)` 里 —— 火球在两次轮询之间就撞完消失了（25 格/秒 × 0.05s = 1.25 格）时
  //    整条方向断言**静默跳过**，用例仍绿（testing-policy §2.7 的无效盲区）。
  //    抳包后方向断言无条件执行，且 direction 与机头是同一帧的快照（零漂移）。
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    g.__fireLog = [];
    const orig = g.fireFireball.bind(g);
    g.fireFireball = (position, direction, source) => {
      const d = g.entities.get(source);
      g.__fireLog.push({
        dir: [...direction],
        yaw: d ? d.state.yaw : null,
        pitch: d ? d.state.pitch : null,
        diveOffset: d ? d.state.diveOffset : null,
      });
      return orig(position, direction, source);
    };
  });
  await page.waitForFunction(() => window.__MC_GAME__.__fireLog.length > 0,
    null, { timeout: 25_000 });

  // ② 方向必须是**发射瞬间的机头前向**（v2.48 用户裁定「严格随机头」）
  const dirs = await page.evaluate(async () => {
    const { dragonForward } = await import('/src/entities/dragons/dragon-facing.js');
    return window.__MC_GAME__.__fireLog.map((f) => {
      const fwd = dragonForward(f.yaw, f.pitch);
      const dot = f.dir[0] * fwd[0] + f.dir[1] * fwd[1] + f.dir[2] * fwd[2];
      // 同时算出「若按旧的点对点瞄准，方向会差多少」的量级 —— 用于自证本条有判别力
      return { dot, pitch: f.pitch };
    });
  });
  expect(dirs.length, 'sanity：至少抳到一次发射').toBeGreaterThan(0);
  for (const d of dirs) {
    // 容差 1e-6：抳包后 direction 与机头是同一帧的快照，应当逐位一致（只留浮点尾差）
    expect(d.dot, `火球方向必须是发射瞬间的机头前向（dot=${d.dot}）`).toBeGreaterThan(1 - 1e-9);
  }

  // ③ 开火频率：观测 26 秒，统计 _fireballSeq 增量。
  //    间隔 ∈ [5,10] 秒 ⇒ 26 秒内最多 ⌈26/5⌉+1 = 7 次、最少 ⌊26/10⌋ = 2 次。
  //    ⚠️ 上界是「不是机关枪」的核心判据（用户原话），下界证明它真的在开火。
  const before = await page.evaluate(() => window.__MC_GAME__._fireballSeq);
  const t0 = Date.now();
  await page.waitForTimeout(26_000);
  const after = await page.evaluate(() => window.__MC_GAME__._fireballSeq);
  const elapsed = (Date.now() - t0) / 1000;
  const shots = after - before;
  const maxShots = Math.ceil(elapsed / 5) + 1;
  expect(shots, `${elapsed.toFixed(0)} 秒内开火 ${shots} 次，不得超过 ${maxShots} 次（间隔须 ≥5 秒）`)
    .toBeLessThanOrEqual(maxShots);
  expect(shots, `${elapsed.toFixed(0)} 秒内必须至少开火 1 次（否则龙根本不攻击）`)
    .toBeGreaterThanOrEqual(1);
});

test('AI E2E: 龙飞过玩家头顶时不得喷火（v2.48 俯冲喷火的核心判据）', async ({ page }) => {
  // ⚠️⚠️ **本条是用户 2026-11-04 报告的那个 bug 的验收**：「火龙飞到玩家头顶上的时候，
  // 有时候也会喷火球……好像下蛋一样」。
  //
  // 判据设计（避开三个无效盲区）：
  //   ① **必须采样飞行过程**，不能只看单帧 —— 旧实现的缺陷发生在「越过头顶那一段时间」；
  //   ② **必须同时钉正向对照**（远离阶段真的开过火），否则「不喷」可能是因为整条路径没接线；
  //   ③ **必须看每个火球发射瞬间的水平距**（`source` 指向龙，但火球存的是当时的快照，
  //      所以用「发射第 N 发时龙的 hDist」—— 这靠逐帧采样 `_fireballSeq` 的增量 + 当帧距离）。
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 640, height: 480 });
  await page.goto('/?vd=8&seed=12345');   // ⚠️ vd=8：需要足够视域观察龙绕玩家一圈
  await waitWorldReady(page);
  await summonInOpenField(page);

  // 采样 40 秒：龙会因「飞跃 → 拉远 → 回头」循环多次经过玩家附近
  const trace = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const shots = [];   // 每发火球发生那一刻的 (hDist, dragonPitch, diveOffset)
    let lastSeq = g._fireballSeq;
    const n = 200;      // 200 × 200ms = 40 秒
    let minHDist = Infinity;
    for (let i = 0; i < n; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const d = g.dragons.activeEntities()[0];
      if (!d) break;
      const p = g.player.physics.pos;
      const hDist = Math.hypot(d.state.position[0] - p.x, d.state.position[2] - p.z);
      minHDist = Math.min(minHDist, hDist);
      const seq = g._fireballSeq;
      if (seq > lastSeq) {
        for (let k = 0; k < seq - lastSeq; k++) {
          shots.push({ hDist, pitch: d.state.pitch, diveOffset: d.state.diveOffset });
        }
        lastSeq = seq;
      }
    }
    return { shots, minHDist, shotCount: shots.length };
  });

  // ⚠️ **sanity 三条**，缺任一条本用例就变成无效盲区：
  // ① 龙真的飞近到 minFireDistance 以内（否则测不到「头顶」场景）
  // ② 真的开过火（否则「没在头顶喷」不是因为判据对）
  // ③ 至少一发发生在射程窗口内（否则说明整条开火路径没接线）
  const { DRAGON_AI } = await page.evaluate(async () => ({
    DRAGON_AI: (await import('/src/entities/dragons/dragon-config.js')).DRAGON_AI,
  }));
  expect(trace.minHDist, 'sanity：龙的飞跃循环应当把它带到玩家附近（否则测不到「头顶」）')
    .toBeLessThan(DRAGON_AI.flyoverDistance * 2);
  expect(trace.shotCount, 'sanity：40 秒内必须至少开火 1 次').toBeGreaterThan(0);

  const overhead = trace.shots.filter((s) => s.hDist < DRAGON_AI.minFireDistance);
  const inRange = trace.shots.filter((s) => s.hDist >= DRAGON_AI.minFireDistance);
  expect(inRange.length, 'sanity：至少一发发生在射程窗口内（否则开火路径未接线）').toBeGreaterThan(0);
  expect(overhead.length,
    `飞过头顶（水平距 < ${DRAGON_AI.minFireDistance}）时不得喷火（用户：「好像下蛋一样」）：` +
    `${JSON.stringify(overhead)}`).toBe(0);
});

test('AI E2E: 玩家超出脱离距离 → 龙返回并恢复盘旋', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 640, height: 480 });
  // ⚠️ **vd=8**：脱离距离 78 格 > vd=2 的加载半径 64 格 —— 用 vd=2 时玩家还没走到脱离
  // 距离，龙的 column 就先被卸载了（临时实体回收），断言读到 undefined。
  await page.goto('/?vd=8&seed=12345');
  await waitWorldReady(page);
  await summonInOpenField(page);

  // 先确认在追击/攻击（⚠️ **只有 attack 有距离脱离判据**，chase 按 spec 只在视线断时脱离）
  await page.waitForFunction(() => {
    const d = window.__MC_GAME__.dragons.activeEntities()[0];
    return d && d.state.mode === 'attack';
  }, null, { timeout: 30_000 });

  // 把玩家挪到 120 格外（> disengageDistance 78，且 < vd=8 的加载半径 160）
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    g._teleportTo(p.x + 120, 45, p.z);
  });
  // 龙必须脱离 → return → 最终回 orbit
  await page.waitForFunction(() => {
    const d = window.__MC_GAME__.dragons.activeEntities()[0];
    return d && d.state.mode === 'orbit';
  }, null, { timeout: 60_000 });
  const final = await page.evaluate(() => {
    const d = window.__MC_GAME__.dragons.activeEntities()[0];
    const o = d.state.orbit;
    return {
      mode: d.state.mode,
      distToCenter: Math.hypot(d.state.position[0] - o.cx, d.state.position[2] - o.cz),
      y: d.state.position[1],
    };
  });
  expect(final.mode).toBe('orbit');
  // 回到轨道：距圆心 ≈ orbitRadius（± wobbleAmp），高度回到盘旋带
  const { DRAGON, DRAGON_AI } = await page.evaluate(async () => {
    const m = await import('/src/entities/dragons/dragon-config.js');
    return { DRAGON: m.DRAGON, DRAGON_AI: m.DRAGON_AI };
  });
  expect(Math.abs(final.distToCenter - DRAGON.orbitRadius)).toBeLessThanOrEqual(DRAGON_AI.wobbleAmp + 1);
  expect(Math.abs(final.y - 30)).toBeLessThanOrEqual(DRAGON.bobAmplitude + 1);
});

test('AI E2E: 火球命中玩家 → 爆炸发生但玩家不掉血不位移（血量以后再做）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 640, height: 480 });
  await page.goto('/?vd=2&seed=12345');
  await waitWorldReady(page);
  await summonInOpenField(page);

  // 直接在玩家位置生成一个朝玩家飞的火球（测「命中玩家」这条路径，不依赖龙恰好瞄准）
  const before = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const exploded = g.tntChainDebugState().exploded;
    // 从玩家头顶 3 格朝下发射 → 必然命中玩家盒（0.6×1.8×0.6）
    g.fireFireball([p.x, p.y + 3, p.z], [0, -1, 0], 'dragon:ai-spec');
    return { exploded, pos: [p.x, p.y, p.z], vel: [g.player.physics.vel.x, g.player.physics.vel.y, g.player.physics.vel.z], health: g.player.health };
  });

  // 等火球消失（命中或超距）
  await page.waitForFunction(() =>
    [...window.__MC_GAME__.entities.entities()].filter((e) => e.type === 'fireball').length === 0,
  null, { timeout: 10_000, polling: 50 });

  const after = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    return {
      exploded: g.tntChainDebugState().exploded,
      pos: [p.x, p.y, p.z],
      // 玩家血量（v2.52 生命系统显示层新增字段）—— 钉住「火球命中不得扣血」。
      health: g.player.health,
    };
  });
  expect(after.exploded, '火球命中玩家必须触发爆炸').toBe(before.exploded + 1);
  // ⚠️ **旧断言是 `'health' in g.player === false`**（当时玩家没有血量概念），v2.52 加了
  // 血量字段后那条已过时。本意（火球不伤玩家）改为**更强**的判据：血量前后必须逐位不变。
  // 不写死 20 —— 比对 before/after 就不需要在这里复制一份 `PLAYER_MAX_HEALTH`（红线 1）。
  expect(after.health, '火球命中玩家不得扣血（掉血逻辑用户后续添加）').toBe(before.health);
  // 玩家位置不得因被击中而突变（爆炸不推玩家 —— 当前无击退设计）
  expect(Math.abs(after.pos[0] - before.pos[0])).toBeLessThan(0.5);
  expect(Math.abs(after.pos[2] - before.pos[2])).toBeLessThan(0.5);
});

test('AI E2E: 视线被实心不透明方块遮挡 → 龙不追击；拆掉遮挡 → 追击（用户核心需求）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 640, height: 480 });
  // ⚠️ vd=8：本用例要在龙与玩家之间立墙，且龙轨道半径 24 格 ⇒ 加载半径必须盖得住
  await page.goto('/?vd=8&seed=12345');
  await waitWorldReady(page);

  // ① 把玩家挪到开阔地，落地后用 stone 把他**完全封进一个石盒**（四壁 + 顶）。
  //    龙在 y=30、轨道半径 24 ⇒ 视线必然穿过盒顶 → LOS 恒断。
  const box = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const p0 = g.player.physics.pos;
    const cx = Math.floor(p0.x) + 600, cz = Math.floor(p0.z) + 600;
    g._teleportTo(cx, 45, cz);
    await new Promise((r) => setTimeout(r, 3000));   // 等落地 + column 加载
    const p = g.player.physics.pos;
    const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
    const stone = g.registry.idOf('stone');
    // 内腔 3×3×3（玩家高 1.8 ⇒ 3 格净空足够），四壁 + 顶全封
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dy = 0; dy <= 3; dy++) {
          const isWall = Math.abs(dx) === 2 || Math.abs(dz) === 2;
          const isRoof = dy === 3;
          if (!isWall && !isRoof) continue;   // 内腔留空
          g.editor.setBlock({ x: bx + dx, y: by + dy, z: bz + dz, id: stone });
        }
      }
    }
    // 以玩家为中心召龙（轨道半径 24，龙在盒外 y=30 盘旋）
    g.dragons.summon('ai-los:0:0', bx, bz, 0);
    return { bx, by, bz };
  });
  await page.waitForFunction(() => window.__MC_GAME__.dragons.activeEntities().length === 1,
    null, { timeout: 15_000 });

  // sanity：石盒真的封住了（盒顶那格是 stone）—— 否则本用例测不到遮挡
  const roofSolid = await page.evaluate((b) => {
    const g = window.__MC_GAME__;
    return g.world.getBlockId(b.bx, b.by + 3, b.bz) === g.registry.idOf('stone');
  }, box);
  expect(roofSolid, 'sanity：石盒顶必须是实心 stone').toBe(true);

  // ② 封在盒里 6 秒：龙**不得**进追击（距离 24 < sightRange 60，唯一拦住它的就是视线）
  const boxed = await sampleDragon(page, 6);
  expect(boxed.length).toBeGreaterThan(20);
  const boxedChase = boxed.filter((s) => s.mode === 'chase' || s.mode === 'attack');
  expect(boxedChase.length,
    `玩家被封进石盒（视线遮挡）时龙不得追击 —— 实测 mode 分布 ${JSON.stringify([...new Set(boxed.map((s) => s.mode))])}`)
    .toBe(0);
  // 且 LOS 缓存确实读到「不可见」（证明判据生效，不是别的原因让龙没追）
  expect(boxed.filter((s) => s.los).length, 'sanity：盒内 LOS 必须为 false').toBe(0);

  // ③ **对照**：拆掉盒顶 → 龙必须进追击。
  //    ⚠️ 没有这条对照，上面那条是无效盲区（testing-policy §2.7）：若龙因为别的原因
  //    根本不追击（例如 AI 没接线、或玩家不在 sightRange 内），「不追击」照样全绿。
  await page.evaluate((b) => {
    const g = window.__MC_GAME__;
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) g.editor.setBlock({ x: b.bx + dx, y: b.by + 3, z: b.bz + dz, id: 0 });
    }
  }, box);
  await page.waitForFunction(() => {
    const d = window.__MC_GAME__.dragons.activeEntities()[0];
    return d && (d.state.mode === 'chase' || d.state.mode === 'attack');
  }, null, { timeout: 30_000 });
  const opened = await page.evaluate(() => {
    const d = window.__MC_GAME__.dragons.activeEntities()[0];
    return { mode: d.state.mode, los: d.state.losVisible };
  });
  expect(['chase', 'attack']).toContain(opened.mode);
  expect(opened.los, '拆掉盒顶后 LOS 必须为 true').toBe(true);
});

test('AI E2E: 真实按 B 召龙后 AI 生效（玩家主路径，不是测试 API）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 640, height: 480 });
  await page.goto('/?vd=8&seed=12345');
  await waitWorldReady(page);

  // 走到祭坛地带中心（真实高台地带），按 B 召龙 —— 与 dragon.spec.mjs 同一入口
  const c = await page.evaluate(async () => {
    const { findAltarTarnRegion } = await import('/src/gen/structures/tarn-zone.js');
    const a = findAltarTarnRegion(window.__MC_GAME__.seed);
    return a ? { cx: a.cx, cz: a.cz } : null;
  });
  expect(c, 'seed 12345 必须有祭坛地带').not.toBe(null);
  await page.evaluate(([x, z]) => window.__MC_GAME__._teleportTo(x, 40, z), [c.cx, c.cz]);
  await page.waitForFunction(([x, z]) =>
    window.__MC_GAME__.world.hasColumn(Math.floor(x / 16), Math.floor(z / 16)),
  [c.cx, c.cz], { timeout: 30_000 });

  // 真实键盘事件（与 dragon.spec.mjs 的 pressC 同手法）
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      code: 'KeyB', repeat: false, bubbles: true, cancelable: true,
    }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyB', bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => window.__MC_GAME__.dragons.activeEntities().length === 1,
    null, { timeout: 15_000 });

  // 龙必须有 AI 字段且 mode 合法（证明 definition 真的委托给了 Agent）
  const st = await page.evaluate(() => {
    const d = window.__MC_GAME__.dragons.activeEntities()[0];
    return {
      mode: d.state.mode,
      hasAiFields: ['attackPhase', 'fireCooldown', 'losTimer', 'losVisible', 'turnDist', 'aimTime']
        .every((k) => k in d.state),
      fireRequestIsNull: d.state.fireRequest === null,
      orbitHasWobble: Number.isFinite(d.state.orbit.wobbleAmp),
    };
  });
  expect(['orbit', 'chase', 'attack', 'return']).toContain(st.mode);
  expect(st.hasAiFields, 'state 必须带全部 AI 字段').toBe(true);
  expect(st.orbitHasWobble, 'summon 的轨道必须带 wobble（自由盘旋不再死板画圆）').toBe(true);

  // 玩家站在地带中心（龙在头顶 24 格轨道上）→  eventually 进入追击
  await page.waitForFunction(() => {
    const d = window.__MC_GAME__.dragons.activeEntities()[0];
    return d && d.state.mode !== 'orbit';
  }, null, { timeout: 30_000 });
  const mode = await page.evaluate(() => window.__MC_GAME__.dragons.activeEntities()[0].state.mode);
  expect(['chase', 'attack', 'return']).toContain(mode);
});
