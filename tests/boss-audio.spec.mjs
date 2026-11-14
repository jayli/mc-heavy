// tests/boss-audio.spec.mjs — Boss 战音效与 BGM（v2.64）
//
// **为什么必须有这个 spec**：`src/tests/test-bgm.js` 证明了 AudioManager 的交叉淡化状态机
// 本身正确，`src/tests/test-block-hit-fx.js` 证明了碎块数学正确 —— 但证明不了它们在
// **游戏里被接上了**。漏接线的形态全是静默的（没有任何报错）：
//   ① 召唤没接 `ignis_burn` → 按 B 没声音；
//   ② 死亡音分型没接 → 打死龙/焰魔仍是 z_die（或没声音）；
//   ③ 挥刀/跳跃迁移检测没接 → 焰魔挥刀/跳跃没声音；
//      （v2.79 起起手音按 `attackKind` 分流：普攻 `ignis_attack_swing` / 旋斩 `ignis_attack_circle`）
//   ④ 火球/吼叫没接 → 龙喷火/叫唤没声音；
//   ⑤ Boss BGM 意图没接 → 召唤后战斗音乐不淡入、全灭后不淡回。
//
// ⚠️ **不断言「有没有声音」**：无头 Chromium 没有音频输出设备。断言落在可观测状态机上 ——
// `audioDebugState().playRequests`（播放请求计数）与 `audioManager.debugMusicState()`
// （boss 意图/在播/混合度），与既有 `audio-fx.spec.mjs` / `bgm.spec.mjs` 同口径。
//
// ⚠️ **必须走玩家真实入口**（AGENTS.md M7 教训）：召唤走真实 B 键派发，伤害走
// `damageEntity()`（武器/炮塔的共同入口），不手工塞 state.mode。
import { test, expect } from 'playwright/test';

const SEED = 12345;

async function waitWorldReady(page) {
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
}

/** 读播放请求计数（只读诊断口，见 `Game.audioDebugState`）。 */
async function counts(page) {
  return page.evaluate(() => window.__MC_GAME__.audioDebugState().playRequests);
}

/** 读音乐诊断状态（含 v2.64 的 boss 子对象）。 */
async function musicState(page) {
  return page.evaluate(() => window.__MC_GAME__.audioManager.debugMusicState());
}

/** 按 B（真实键盘事件路径，与 dragon.spec.mjs 同手法） */
async function pressC(page) {
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      code: 'KeyB', repeat: false, bubbles: true, cancelable: true,
    }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyB', bubbles: true, cancelable: true }));
  });
}

/**
 * 把玩家挪到远离城市的开阔地（测试场必须远离城市 —— 建筑遮挡视线会让 AI 抖动，
 * 与 dragon-ai.spec.mjs 同一理由）。
 */
async function gotoOpenField(page, { offsetX = 600, offsetZ = 600 } = {}) {
  await page.evaluate(async ([ox, oz]) => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    g._teleportTo(Math.floor(p.x) + ox, 45, Math.floor(p.z) + oz);
    await new Promise((r) => setTimeout(r, 2500));   // 等 column 加载 + 落地
  }, [offsetX, offsetZ]);
}

/** 读祭坛地带中心（从 gen 层权威，不自己写一份「哪个地带」） */
async function altarCenter(page) {
  return page.evaluate(async () => {
    const { findAltarTarnRegion } = await import('/src/gen/structures/tarn-zone.js');
    const a = findAltarTarnRegion(window.__MC_GAME__.seed);
    return a ? { cx: a.cx, cz: a.cz } : null;
  });
}

test.describe.configure({ mode: 'serial' });

test('Boss BGM：召唤 → 战斗曲淡入；全灭 → 淡回开局曲目', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`/?vd=2&seed=${SEED}`);
  await waitWorldReady(page);
  // 手势解锁 + 等普通 BGM 解码起播（无头环境 autoplay 放行，点击画布确保 unlock 路径走过）
  await page.locator('#app-canvas').click({ position: { x: 200, y: 200 } });
  await page.waitForFunction(
    () => window.__MC_GAME__.audioManager.debugMusicState().playing === true,
    null, { timeout: 60_000 });
  const normalTrack = (await musicState(page)).track;

  // ---- 召唤飞龙（真实 B 键路径）----
  const c = await altarCenter(page);
  expect(c, '前置：seed 12345 必须有祭坛地带').not.toBeNull();
  await page.evaluate(([x, z]) => window.__MC_GAME__._teleportTo(x, 40, z), [c.cx, c.cz]);
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    return g.world.hasColumn(Math.floor(g.player.physics.pos.x / 16),
      Math.floor(g.player.physics.pos.z / 16));
  }, null, { timeout: 30_000 });
  await pressC(page);
  await page.waitForFunction(
    () => window.__MC_GAME__.dragons.activeEntities().length === 1,
    null, { timeout: 30_000 });

  // 召唤音效（ignis_burn，飞龙/焰魔共用）
  expect((await counts(page)).ignis_burn ?? 0, '召唤必须播 ignis_burn').toBeGreaterThanOrEqual(1);

  // ---- 战斗曲淡入：意图置位 + 懒加载完成后 boss 槽在播、普通曲停 ----
  await page.waitForFunction(
    () => window.__MC_GAME__.audioManager.debugMusicState().boss.wanted === true,
    null, { timeout: 10_000 });
  // 懒加载 4.7MB ogg：等它解码完并淡变到位（mix → 1）。FADE 1.5s + 下载余量。
  await page.waitForFunction(
    () => window.__MC_GAME__.audioManager.debugMusicState().boss.mix >= 1,
    null, { timeout: 60_000 });
  const bossOn = await musicState(page);
  expect(bossOn.boss.playing, '战斗曲必须在播').toBe(true);
  expect(bossOn.playing, '淡变完成后普通曲必须停（不是两首叠播）').toBe(false);

  // ---- 击杀飞龙 → 全灭 → 淡回开局曲目 ----
  const dragonId = await page.evaluate(() => window.__MC_GAME__.dragons.activeEntities()[0].id);
  await page.evaluate((id) => {
    window.__MC_GAME__.damageEntity(id, 10_000, performance.now());
  }, dragonId);
  expect((await counts(page)).ignis_die ?? 0, '击杀飞龙必须播 ignis_die').toBeGreaterThanOrEqual(1);

  await page.waitForFunction(
    () => window.__MC_GAME__.audioManager.debugMusicState().boss.wanted === false,
    null, { timeout: 10_000 });
  await page.waitForFunction(
    () => window.__MC_GAME__.audioManager.debugMusicState().boss.mix <= 0,
    null, { timeout: 30_000 });
  const restored = await musicState(page);
  expect(restored.playing, '全灭后普通曲必须恢复在播').toBe(true);
  expect(restored.boss.playing, '全灭后战斗曲必须停').toBe(false);
  expect(restored.track, '恢复的是开局抽中的那首（不重新抽签）').toBe(normalTrack);
});

test('飞龙：喷火球播 dragon_fire，空中随机吼 dragon_shout', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`/?vd=2&seed=${SEED}`);
  await waitWorldReady(page);
  await gotoOpenField(page);
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    g.dragons.summon('audio-spec:0:0', Math.floor(p.x), Math.floor(p.z), 0);
  });
  await page.waitForFunction(
    () => window.__MC_GAME__.dragons.activeEntities().length === 1,
    null, { timeout: 15_000 });

  // ---- ① 喷火球 → dragon_fire（等 AI 自然开火，冷却最长 10s + 追击，留 30s 窗口）----
  const seqBase = await page.evaluate(() => window.__MC_GAME__._fireballSeq);
  const fireBase = (await counts(page)).dragon_fire ?? 0;
  await page.waitForFunction((base) => window.__MC_GAME__._fireballSeq > base,
    seqBase, { timeout: 30_000 });
  const fired = await page.evaluate((base) => window.__MC_GAME__._fireballSeq - base, seqBase);
  const firePlays = (await counts(page)).dragon_fire ?? 0;
  expect(firePlays - fireBase, '每喷一颗火球必须播一次 dragon_fire（一一对应）')
    .toBeGreaterThanOrEqual(fired);

  // ---- ② 随机吼叫 → dragon_shout（首次延迟 6~14s，留 20s 窗口）----
  const shoutBase = (await counts(page)).dragon_shout ?? 0;
  await page.waitForFunction((base) =>
    (window.__MC_GAME__.audioDebugState().playRequests.dragon_shout ?? 0) > base,
    shoutBase, { timeout: 20_000 });
  expect((await counts(page)).dragon_shout ?? 0, '飞龙在空中必须随机吼叫').toBeGreaterThan(shoutBase);
});

test('焰魔：挥刀播 ignis_attack_swing、跳跃播 ignis_jump、死亡播 ignis_die', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`/?vd=2&seed=${SEED}`);
  await waitWorldReady(page);
  await gotoOpenField(page);

  // 召唤焰魔到玩家身边 4 格（attackRange 5.5 内 → 会起手挥砍）
  const sum = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    return g.ignises.summon('audio-spec:0:1', Math.floor(p.x), Math.floor(p.z) + 4, 1, Math.floor(p.y));
  });
  expect(sum.ok, `前置：焰魔召唤成功（${sum.reason ?? ''}）`).toBe(true);

  // ---- ① 挥刀音：等焰魔自然进入 attack（迁移检测在装配层，走真实帧循环）----
  const swingBase = (await counts(page)).ignis_attack_swing ?? 0;
  await page.waitForFunction((base) =>
    (window.__MC_GAME__.audioDebugState().playRequests.ignis_attack_swing ?? 0) > base,
    swingBase, { timeout: 30_000 });
  expect((await counts(page)).ignis_attack_swing ?? 0, '焰魔挥刀必须播 ignis_attack_swing')
    .toBeGreaterThan(swingBase);

  // ---- ② 死亡音：打死焰魔 → ignis_die（不是 z_die）----
  const zDieBase = (await counts(page)).z_die ?? 0;
  const ignisDieBase = (await counts(page)).ignis_die ?? 0;
  // v2.64b：死亡碎块爆散的前置读数（reset 清掉之前挖方块的碎块）
  await page.evaluate(() => window.__MC_GAME__.blockHitFx.reset());
  const debrisBase = await page.evaluate(() => window.__MC_GAME__.blockHitFx.activeDebrisCount);
  const dead = await page.evaluate((id) => {
    const g = window.__MC_GAME__;
    return g.damageEntity(id, 10_000, performance.now());
  }, sum.id);
  expect(dead?.dead, '前置：致死伤害').toBe(true);
  expect((await counts(page)).ignis_die ?? 0, '焰魔死亡必须播 ignis_die').toBe(ignisDieBase + 1);
  expect((await counts(page)).z_die ?? 0, '焰魔死亡不得播 z_die（那是丧尸的）').toBe(zDieBase);
  // v2.64b：焰魔死亡特效（用户追问后补上）—— 火焰色碎块爆散，Boss 口径比丧尸更多块
  const debrisAfter = await page.evaluate(() => window.__MC_GAME__.blockHitFx.activeDebrisCount);
  expect(debrisBase, '前置：reset 后碎块池应为空').toBe(0);
  expect(debrisAfter, '焰魔死亡必须爆出碎块（不得直接消失）').toBeGreaterThanOrEqual(20);
});

test('焰魔：旋斩起手播 ignis_attack_circle、普攻起手播 ignis_attack_swing（两音不混）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`/?vd=2&seed=${SEED}`);
  await waitWorldReady(page);
  await gotoOpenField(page);

  // 召唤焰魔到玩家身边 4 格（attackRange 5.5 内 → 会自然起手）
  const sum = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    return g.ignises.summon('audio-spec:0:4', Math.floor(p.x), Math.floor(p.z) + 4, 1, Math.floor(p.y));
  });
  expect(sum.ok, `前置：焰魔召唤成功（${sum.reason ?? ''}）`).toBe(true);

  // ⚠️ **探针必须装在页面里逐帧采样**，而且必须同时录两样东西：
  //   · **起手事件**（`mode` 从非 attack 迁入 attack 的那一帧）与当时的 `attackKind`；
  //   · 该帧两个音的**播放增量**（`playRequests` 差分）。
  // 只录音符就分不清「这音是哪一招响的」；只录 mode 就不知道到底出没出声。
  // 从 Playwright 侧轮询更不行：迁移那一帧一瞬即逝，而轮询跨进程往返 ~10ms。
  //
  // ⚠️ **同一 tick 内的一致性**：`Game.update()` 里先推实体、后调 `_syncBossAudio()`
  //（迁移检测 + play），所以任一 rAF 快照都能看到一个完整 tick —— 要么都还没发生、
  // 要么两件都已完成，不会读到半帧。
  await page.evaluate((id) => {
    const g = window.__MC_GAME__;
    const ids = ['ignis_attack_swing', 'ignis_attack_circle', 'ignis_attack_smash'];
    const snap = {};
    for (const k of ids) snap[k] = g.audioDebugState().playRequests[k] ?? 0;
    /** @type {Array<{kind: string|null, frame: number, played: Record<string, number>}>} */
    const events = [];
    /** 有播放但没有对应的起手事件（游离音）—— 那也是一种缺陷 */
    const stray = [];
    let frame = 0;
    const modeOf = () => g.entities.get(id)?.state?.mode ?? null;
    let prevMode = modeOf();
    const tick = () => {
      frame += 1;
      const countsNow = g.audioDebugState().playRequests;
      const played = {};
      for (const k of ids) {
        played[k] = (countsNow[k] ?? 0) - snap[k];
        snap[k] = countsNow[k] ?? 0;
      }
      const mode = modeOf();
      const started = prevMode !== 'attack' && mode === 'attack';
      if (started) {
        events.push({
          kind: g.entities.get(id)?.state?.attackKind ?? null, frame, played,
        });
      } else if (played.ignis_attack_swing + played.ignis_attack_circle + played.ignis_attack_smash > 0) {
        stray.push({ mode, frame, played });
      }
      prevMode = mode;
      window.__SPIN_AUDIO_PROBE__ = { events, stray };
      if (events.length < 12) requestAnimationFrame(tick);
    };
    window.__SPIN_AUDIO_PROBE__ = { events, stray };
    requestAnimationFrame(tick);
  }, sum.id);

  // 等采到足够多的起手样本。冷却 [3.5,6.0]s + 动画 1.9/2.75s ⇒ 每个起手 ~5.5s 均值；
  // 12 个样本约 65s，留 120s 窗口。Spin 权重 0.3 且带 8s 独立冷却 ⇒ 12 个样本里
  // 旋斩预期 3~4 次（完全一次都没抽中的概率 ≈ 0.7^15 ≈ 0.5%，窗口足够容错）。
  await page.waitForFunction(() => (window.__SPIN_AUDIO_PROBE__?.events.length ?? 0) >= 12,
    null, { timeout: 120_000 }).catch(() => {});

  const probe = await page.evaluate(() => window.__SPIN_AUDIO_PROBE__);
  const { events, stray } = probe;
  const spins = events.filter((e) => e.kind === 'spin');
  const swings = events.filter((e) => e.kind === 'swing');
  const smashes = events.filter((e) => e.kind === 'shieldSmash');
  const summary = events.map((e) =>
    `${e.kind}:swing=${e.played.ignis_attack_swing},circle=${e.played.ignis_attack_circle},smash=${e.played.ignis_attack_smash}`).join(' | ');

  // 前置：两类招式都真的出现过（只采到普攻时，下面「旋斩播 circle」那条测的是空集）
  expect(events.length, '前置：必须采到多个起手（实际没有 → 焰魔一直没起手）')
    .toBeGreaterThanOrEqual(4);
  expect(swings.length, `前置：普攻起手必须非空（实际：${summary}）`).toBeGreaterThan(0);
  expect(spins.length, `前置：旋斩起手必须非空（实际：${summary}）`).toBeGreaterThan(0);

  // ① 旋斩起手 → 只播 ignis_attack_circle（不播、或同时播挥刀音都算错）
  for (const e of spins) {
    expect(e.played.ignis_attack_circle, `旋斩起手必须播 ignis_attack_circle（实际：${summary}）`).toBe(1);
    expect(e.played.ignis_attack_swing, '旋斩起手不得再播挥刀音（用户裁定只用 circle）').toBe(0);
  }
  // ② 普攻起手 → 只播 ignis_attack_swing（负向锚点：
  //   把触发点写成恒 `ignis_attack_swing` 时，① 红而 ② 仍绿 —— 两条成对才能钉住「分流」）
  for (const e of swings) {
    expect(e.played.ignis_attack_swing, `普攻起手必须播 ignis_attack_swing（实际：${summary}）`).toBe(1);
    expect(e.played.ignis_attack_circle, '普攻起手不得播旋斩音').toBe(0);
  }
  // ③ 不得有游离音：每次播放都必须对得上一次起手（否则计数被别处悄悄写到，
  //   ① 、② 可能描的是一个与真实起手无关的分支）
  expect(stray, `不得有游离的起手音（实际：${JSON.stringify(stray)}）`).toHaveLength(0);
  // ④ **v3.01 二次裁定（用户 2026-11-14）：贴身门已删** ⇒ 本用例的 4 格距离下
  //   盾击**也可能起手**（权重 0.35）。旧版的「非贴身不得出现盾击音」负向锚点**已作废**。
  //   现在的判据是「若出了盾击，它必须只播自己的音」（与①②同口径的分流判据）。
  //   不断言「必须出现」：本用例只等 12 个样本，35% 权重下仍可能一次也没抽到，
  //   「必须出现」交给下面那条专门等盾击的用例。
  for (const e of smashes) {
    expect(e.played.ignis_attack_smash, `盾击起手必须播 ignis_attack_smash（实际：${summary}）`).toBe(1);
    expect(e.played.ignis_attack_swing, '盾击起手不得播挥刀音').toBe(0);
    expect(e.played.ignis_attack_circle, '盾击起手不得播旋斩音').toBe(0);
  }
});

/**
 * v3.01 盾击起手音的分流（确定性版：把玩家钉在焰魔前方）。
 *
 * ## v3.01 二次裁定后的变化
 *
 * 初版靠「贴身门」才能出盾击，所以必须把玩家钉进 3 格。用户 2026-11-14 裁定删掉贴身门后，
 * **任何起手距离都可能出盾击**（权重 0.35）。仍把玩家钉在 2.5 格的理由变成纯粋的**确定性**：
 * ① 保证 LOS 通、玩家不跑开（否则可能因看不见而不起手）；② 命中率高 ⇒ 样本密。
 * ⚠️ **只改 x/z 不改 y**（同 Tier 4 射程用例的教训：摩 y 会把玩家塞进地形）。
 *
 * ## 窗口
 *
 * 盾击权重 0.35 ⇒ 等到出现至少一次盾击起手，上限 40 个样本 / 180s；0.65^40 ≈ 3e-8 ⇒ 不依赖运气。
 */
test('焰魔(v3.01)：盾击起手播 ignis_attack_smash，且不播另两个音', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto(`/?vd=2&seed=${SEED}`);
  await waitWorldReady(page);
  await gotoOpenField(page);

  const sum = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    return g.ignises.summon('audio-spec:0:7', Math.floor(p.x), Math.floor(p.z) + 4, 1, Math.floor(p.y));
  });
  expect(sum.ok, `前置：焰魔召唤成功（${sum.reason ?? ''}）`).toBe(true);

  await page.evaluate((id) => {
    const g = window.__MC_GAME__;
    const ids = ['ignis_attack_swing', 'ignis_attack_circle', 'ignis_attack_smash'];
    const snap = {};
    for (const k of ids) snap[k] = g.audioDebugState().playRequests[k] ?? 0;
    const events = [];
    const stray = [];
    let frame = 0;
    const modeOf = () => g.entities.get(id)?.state?.mode ?? null;
    let prevMode = modeOf();
    const tick = () => {
      frame += 1;
      // 每帧把玩家钉在焰魔前方 2.5 格（保证 LOS 与命中密度）—— 只改 x/z，y 保持玩家真实高度
      const e = g.entities.get(id);
      if (e) {
        const [ex, , ez] = e.state.position;
        g.player.physics.pos.x = ex;
        g.player.physics.pos.z = ez - 2.5;
      }
      const countsNow = g.audioDebugState().playRequests;
      const played = {};
      for (const k of ids) {
        played[k] = (countsNow[k] ?? 0) - snap[k];
        snap[k] = countsNow[k] ?? 0;
      }
      const mode = modeOf();
      const started = prevMode !== 'attack' && mode === 'attack';
      if (started) {
        events.push({ kind: g.entities.get(id)?.state?.attackKind ?? null, frame, played });
      } else if (played.ignis_attack_swing + played.ignis_attack_circle + played.ignis_attack_smash > 0) {
        stray.push({ mode, frame, played });
      }
      prevMode = mode;
      window.__SMASH_AUDIO_PROBE__ = { events, stray };
      if (events.length < 40) requestAnimationFrame(tick);
    };
    window.__SMASH_AUDIO_PROBE__ = { events, stray };
    requestAnimationFrame(tick);
  }, sum.id);

  // 等到出现至少一次盾击起手（而不是固定样本数）
  await page.waitForFunction(() => {
    const p = window.__SMASH_AUDIO_PROBE__;
    return (p?.events ?? []).some((e) => e.kind === 'shieldSmash') || (p?.events.length ?? 0) >= 40;
  }, null, { timeout: 180_000 }).catch(() => {});

  const probe = await page.evaluate(() => window.__SMASH_AUDIO_PROBE__);
  const { events, stray } = probe;
  const smashes = events.filter((e) => e.kind === 'shieldSmash');
  const swings = events.filter((e) => e.kind === 'swing');
  const spins = events.filter((e) => e.kind === 'spin');
  const summary = events.map((e) =>
    `${e.kind}:swing=${e.played.ignis_attack_swing},circle=${e.played.ignis_attack_circle},smash=${e.played.ignis_attack_smash}`).join(' | ');

  // 前置：盾击起手必须非空（否则下面两条测的是空集，会假绿）
  expect(smashes.length, `前置：必须抽到盾击起手（实际 ${events.length} 个起手：${summary}）`)
    .toBeGreaterThan(0);

  // ① 盾击起手 → 只播 ignis_attack_smash
  for (const e of smashes) {
    expect(e.played.ignis_attack_smash, `盾击起手必须播 ignis_attack_smash（实际：${summary}）`).toBe(1);
    expect(e.played.ignis_attack_swing, '盾击起手不得播挥刀音').toBe(0);
    expect(e.played.ignis_attack_circle, '盾击起手不得播旋斩音').toBe(0);
  }
  // ② 负向锚点：另两招仍各自播自己的音（证明分流真的按招，而不是恒播 smash）
  for (const e of swings) {
    expect(e.played.ignis_attack_swing, `普攻起手仍须播 swing（实际：${summary}）`).toBe(1);
    expect(e.played.ignis_attack_smash, '普攻起手不得播盾击音').toBe(0);
  }
  for (const e of spins) {
    expect(e.played.ignis_attack_circle, `旋斩起手仍须播 circle（实际：${summary}）`).toBe(1);
    expect(e.played.ignis_attack_smash, '旋斩起手不得播盾击音').toBe(0);
  }
  // ③ 不得有游离音
  expect(stray, `不得有游离的起手音（实际：${JSON.stringify(stray)}）`).toHaveLength(0);
});

test('焰魔：脱困飞跃播 ignis_jump（2 格高围栏困住 → 卡住后跳出）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`/?vd=2&seed=${SEED}`);
  await waitWorldReady(page);
  await gotoOpenField(page);

  // 召唤焰魔并等落地，再围着它垒 2 格高围栏（与 ignis.spec.mjs 围困脱困用例同手法：
  // 2 格 > maxStep(1.0) 上不去、< 飞跃顶点 2.52 格跳得出 → 只能靠脱困飞跃）
  const built = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const sum = g.ignises.summon('audio-spec:0:2', Math.floor(p.x), Math.floor(p.z) + 6, 1, Math.floor(p.y));
    if (!sum.ok) return { err: sum.reason };
    await new Promise((r) => setTimeout(r, 1500));   // 等落地站稳
    const e = g.entities.get(sum.id);
    if (!e) return { err: 'despawned' };
    const [ex, ey, ez] = e.state.position;
    const stone = g.registry.idOf('stone');
    const bx = Math.floor(ex), by = Math.floor(ey), bz = Math.floor(ez);
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (Math.abs(dx) !== 2 && Math.abs(dz) !== 2) continue;   // 只垒环
        for (let dy = 0; dy < 2; dy++) {
          g.editor.setBlock({ x: bx + dx, y: by + dy, z: bz + dz, id: stone });
        }
      }
    }
    return { id: sum.id };
  });
  expect(built.err, `前置：焰魔召唤与围栏（${built.err ?? ''}）`).toBeUndefined();

  // 等脱困飞跃（卡住阈值 4s + 余量）→ 迁移进 leap 那一帧播 ignis_jump
  const jumpBase = (await counts(page)).ignis_jump ?? 0;
  await page.waitForFunction((base) =>
    (window.__MC_GAME__.audioDebugState().playRequests.ignis_jump ?? 0) > base,
    jumpBase, { timeout: 30_000 });
  expect((await counts(page)).ignis_jump ?? 0, '焰魔脱困飞跃必须播 ignis_jump')
    .toBeGreaterThan(jumpBase);
});

test('玩家受击：焰魔砍中玩家 → 扣血 + 播 ignis_hurt', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`/?vd=2&seed=${SEED}`);
  await waitWorldReady(page);
  await gotoOpenField(page);

  // ⚠️ **走真实路径而不是直接调 `_damagePlayer()`**：后者是私有方法，只调它会漏掉
  // 「挥砍命中结算根本没接到扣血入口」这类接线缺陷（AGENTS.md：接线类测试必须从玩家
  // 真实入口进入）。故召唤焰魔到玩家身边，等它**真的砍到玩家**（血量下降）。
  const sum = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    return g.ignises.summon('audio-spec:0:3', Math.floor(p.x), Math.floor(p.z) + 4, 1, Math.floor(p.y));
  });
  expect(sum.ok, `前置：焰魔召唤成功（${sum.reason ?? ''}）`).toBe(true);

  const hurtBase = (await counts(page)).ignis_hurt ?? 0;
  // 等玩家真的被砍到（血量下降）。焰魔 14 伤害 / 玩家 20 格血 ⇒ 第二刀就到 0，
  // 故窗口内只要看到一次扣血即可（不要求多次）。
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    return (g.audioDebugState().playRequests.ignis_hurt ?? 0) > 0 && g.player.health < 20;
  }, null, { timeout: 40_000 });

  const r = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return { health: g.player.health, hurt: g.audioDebugState().playRequests.ignis_hurt ?? 0 };
  });
  expect(r.health, '前置：玩家真的被砍到了（血量下降）').toBeLessThan(20);
  expect(r.hurt, '玩家被击中必须播 ignis_hurt').toBeGreaterThan(hurtBase);
});
