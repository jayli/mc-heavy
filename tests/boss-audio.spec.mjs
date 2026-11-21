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

  // ---- ① 挥刀音：钉住 `attackKind='swing'` 起手，不赌自然抽签 ----
  //
  // ⚠️⚠️ **v3.03 改写：原来是「等焰魔自然进入 attack」**（等 `ignis_attack_swing` 计数上涨）。
  // 四招权重改成 0.25/0.30/0.25/0.20 后，swing 从 0.35 降到 0.25，
  // 命中间隔（v3.07 前）[4.0,6.0] ⇒ 30s 窗口约 6 次起手，**一次都抽不到 swing 的概率从 7.5% 升到 17.8%**
  //（实测超时）。这不是 flaky 阈值问题，是用例本身在赌运气。
  //
  // 修法：**去掉随机性**而不是放宽超时 —— 直接把 state 钉到 `mode='attack'` +
  // `attackKind='swing'` + `attackAnimT=0`，让真实帧循环自己推进到命中帧。
  // 起手音的迁移检测在装配层（`_syncBossAudio`），走的仍是**真实帧循环 + 真实音表**，
  // 只是不再依赖抽签结果 —— 判据强度不降（它验的是「swing 起手→对应音」这条映射）。
  //
  // ⚠️⚠️ **必须先等 mode 稳定在非 attack 再注入**（实测踩到，两轮结果不同）：
  // 迁移检测的条件是 `old.mode !== 'attack' && mode === 'attack'`（`game.js:2867`）。
  // 若注入时焰魔**已在 attack 态**（自然起手了另一招），条件不成立 ⇒ 永不播音 ⇒ 超时。
  // 第一轮侥幸赶上非 attack 窗口（9.8s ✓），第二轮赶上 attack 中（30s ✗）——
  // 去掉抽签随机性后还残留着「注入时机」这个随机源，必须一并消除。
  await page.waitForFunction((id) => {
    const s = window.__MC_GAME__.entities.get(id)?.state;
    return !!s && s.mode !== 'attack';
  }, sum.id, { timeout: 60_000 });
  const swingBase = (await counts(page)).ignis_attack_swing ?? 0;
  await page.evaluate((id) => {
    const g = window.__MC_GAME__;
    const e = g.entities.get(id);
    if (e) e.state = { ...e.state, mode: 'attack', attackKind: 'swing', attackAnimT: 0, velocity: [0, 0, 0] };
  }, sum.id);
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
    const ids = ['ignis_attack_swing', 'ignis_attack_circle', 'ignis_attack_smash', 'ignis_attack_bash'];
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
      } else if (ids.reduce((sum, k) => sum + played[k], 0) > 0) {
        stray.push({ mode, frame, played });
      }
      prevMode = mode;
      window.__SPIN_AUDIO_PROBE__ = { events, stray };
      if (events.length < 12) requestAnimationFrame(tick);
    };
    window.__SPIN_AUDIO_PROBE__ = { events, stray };
    requestAnimationFrame(tick);
  }, sum.id);

  // 等采到足够多的起手样本。**v3.07 重算节奏**：冷却改成「收势后空档 [1.0,1.5]s」
  // ⇒ 一个完整周期 = 动画（1.90~3.89）+ 空档（1.0~1.5）≈ **4.1s 均值**（旧口径约 5.5s）；
  // 12 个样本约 50s，120s 窗口余量更充足（**窗口未改**）。Spin 权重 0.3 且带 8s 独立冷却
  // ⇒ 12 个样本里旋斩预期 3~4 次（完全一次都没抽中的概率 ≈ 0.7^15 ≈ 0.5%，窗口足够容错）。
  await page.waitForFunction(() => (window.__SPIN_AUDIO_PROBE__?.events.length ?? 0) >= 12,
    null, { timeout: 120_000 }).catch(() => {});

  const probe = await page.evaluate(() => window.__SPIN_AUDIO_PROBE__);
  const { events, stray } = probe;
  const spins = events.filter((e) => e.kind === 'spin');
  const swings = events.filter((e) => e.kind === 'swing');
  const smashes = events.filter((e) => e.kind === 'shieldSmash');
  const bashes = events.filter((e) => e.kind === 'shieldBash');
  const summary = events.map((e) =>
    `${e.kind}:swing=${e.played.ignis_attack_swing},circle=${e.played.ignis_attack_circle},smash=${e.played.ignis_attack_smash},bash=${e.played.ignis_attack_bash}`).join(' | ');

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
  //   持盾冲撞**也可能起手**（权重 0.35）。旧版的「非贴身不得出现持盾冲撞音」负向锚点**已作废**。
  //   现在的判据是「若出了持盾冲撞，它必须只播自己的音」（与①②同口径的分流判据）。
  //   不断言「必须出现」：本用例只等 12 个样本，35% 权重下仍可能一次也没抽到，
  //   「必须出现」交给下面那条专门等持盾冲撞的用例。
  for (const e of smashes) {
    expect(e.played.ignis_attack_smash, `持盾冲撞起手必须播 ignis_attack_smash（实际：${summary}）`).toBe(1);
    expect(e.played.ignis_attack_swing, '持盾冲撞起手不得播挥刀音').toBe(0);
    expect(e.played.ignis_attack_circle, '持盾冲撞起手不得播旋斩音').toBe(0);
  }
  // ⑤ v3.03 举盾砸击（权重 0.20）同口径：若出了它，必须只播自己的音。
  //   不断言「必须出现」（12 个样本下 20% 权重仍可能一次也没抽到）——
  //   「必须出现」交给下面那条确定性用例。
  for (const e of bashes) {
    expect(e.played.ignis_attack_bash, `举盾砸击起手必须播 ignis_attack_bash（实际：${summary}）`).toBe(1);
    expect(e.played.ignis_attack_swing, '举盾砸击起手不得播挥刀音').toBe(0);
    expect(e.played.ignis_attack_circle, '举盾砸击起手不得播旋斩音').toBe(0);
    expect(e.played.ignis_attack_smash, '举盾砸击起手不得播持盾冲撞音').toBe(0);
  }
});

/**
 * v3.01 持盾冲撞起手音的分流（确定性版：把玩家钉在焰魔前方）。
 *
 * ## v3.01 二次裁定后的变化
 *
 * 初版靠「贴身门」才能出持盾冲撞，所以必须把玩家钉进 3 格。用户 2026-11-14 裁定删掉贴身门后，
 * **任何起手距离都可能出持盾冲撞**（权重 0.35）。仍把玩家钉在 2.5 格的理由变成纯粋的**确定性**：
 * ① 保证 LOS 通、玩家不跑开（否则可能因看不见而不起手）；② 命中率高 ⇒ 样本密。
 * ⚠️ **只改 x/z 不改 y**（同 Tier 4 射程用例的教训：摩 y 会把玩家塞进地形）。
 *
 * ## 窗口
 *
 * 持盾冲撞权重 0.35 ⇒ 等到出现至少一次持盾冲撞起手，上限 40 个样本 / 180s；0.65^40 ≈ 3e-8 ⇒ 不依赖运气。
 */
test('焰魔(v3.01)：持盾冲撞起手播 ignis_attack_smash，且不播另两个音', async ({ page }) => {
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
    const ids = ['ignis_attack_swing', 'ignis_attack_circle', 'ignis_attack_smash', 'ignis_attack_bash'];
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
      } else if (ids.reduce((sum, k) => sum + played[k], 0) > 0) {
        stray.push({ mode, frame, played });
      }
      prevMode = mode;
      window.__SMASH_AUDIO_PROBE__ = { events, stray };
      if (events.length < 40) requestAnimationFrame(tick);
    };
    window.__SMASH_AUDIO_PROBE__ = { events, stray };
    requestAnimationFrame(tick);
  }, sum.id);

  // 等到出现至少一次持盾冲撞起手（而不是固定样本数）
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

  // 前置：持盾冲撞起手必须非空（否则下面两条测的是空集，会假绿）
  expect(smashes.length, `前置：必须抽到持盾冲撞起手（实际 ${events.length} 个起手：${summary}）`)
    .toBeGreaterThan(0);

  // ① 持盾冲撞起手 → 只播 ignis_attack_smash
  for (const e of smashes) {
    expect(e.played.ignis_attack_smash, `持盾冲撞起手必须播 ignis_attack_smash（实际：${summary}）`).toBe(1);
    expect(e.played.ignis_attack_swing, '持盾冲撞起手不得播挥刀音').toBe(0);
    expect(e.played.ignis_attack_circle, '持盾冲撞起手不得播旋斩音').toBe(0);
  }
  // ② 负向锚点：另两招仍各自播自己的音（证明分流真的按招，而不是恒播 smash）
  for (const e of swings) {
    expect(e.played.ignis_attack_swing, `普攻起手仍须播 swing（实际：${summary}）`).toBe(1);
    expect(e.played.ignis_attack_smash, '普攻起手不得播持盾冲撞音').toBe(0);
  }
  for (const e of spins) {
    expect(e.played.ignis_attack_circle, `旋斩起手仍须播 circle（实际：${summary}）`).toBe(1);
    expect(e.played.ignis_attack_smash, '旋斩起手不得播持盾冲撞音').toBe(0);
  }
  // ③ 不得有游离音
  expect(stray, `不得有游离的起手音（实际：${JSON.stringify(stray)}）`).toHaveLength(0);
});

/**
 * v3.03 举盾砸击起手音的分流（**确定性版**）。
 *
 * 为什么不靠自然抽签：权重只有 **0.20**，等它自然出现要赌运气
 *（同上面持盾冲撞那条的教训，以及本轮实测到的 swing 超时）。
 * 本用例直接把 state 钉到 `attackKind='shieldBash'` 起手，走**真实帧循环 + 真实音表**，
 * 只去掉抽签随机性 —— 判据强度不降（验的是「shieldBash 起手 → 只播 bash 音」这条映射）。
 *
 * 负向锚点：同一只焰魔再钉一次 `swing` 起手，必须改播 swing 音且**不播 bash** ——
 * 两条成对才钉得住「按招分流」（恒播 bash 时第一条绿、第二条红）。
 */
test('焰魔(v3.03)：举盾砸击起手播 ignis_attack_bash，且不播另三个音', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`/?vd=2&seed=${SEED}`);
  await waitWorldReady(page);
  await gotoOpenField(page);

  const sum = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    return g.ignises.summon('audio-spec:0:bash', Math.floor(p.x), Math.floor(p.z) + 4, 1, Math.floor(p.y));
  });
  expect(sum.ok, `前置：焰魔召唤成功（${sum.reason ?? ''}）`).toBe(true);

  const IDS = ['ignis_attack_swing', 'ignis_attack_circle', 'ignis_attack_smash', 'ignis_attack_bash'];
  /**
   * 钉一次起手，等它的音落地，返回本次各音的增量。
   *
   * ⚠️⚠️ **取基线与注入必须在**一次** `page.evaluate` 里完成**（实测踩到两次）：
   * 分两次 evaluate 时，中间隔着 CDP 往返（数十毫秒 = 多帧），而焰魔在冷却已好时
   * 会在那个间隙**自然起手另一招**（实测混进过 swing 与 circle）⇒ 那次音被算进增量
   * ⇒ 误报「bash 起手同时播了别的音」。
   * 逐帧探针实测：同一帧内取基线+注入时，增量是 **bash:1、其余全 0**
   * ⇒ 装配层无缺陷（`game.js:2870` 一次迁移只 `am.play` 一个音）。
   *
   * ⚠️ **还必须先等 mode 稳定在非 attack**：迁移检测条件是
   * `old.mode !== 'attack' && mode === 'attack'`（`game.js:2867`），
   * 若注入时已在 attack 态则永不播音。
   */
  const fire = async (kind, waitId) => {
    // ⚠️⚠️ **整个「等非 attack → 取基线 → 注入」必须在**浏览器侧一次 evaluate** 内完成。
    // 实测：即使把取基线+注入合并，只要「等 mode」还是单独的 waitForFunction，
    // 它返回到下一次 evaluate 之间仍有 CDP 往返间隙 ⇒ 焰魔仍可能在间隙里自然起手
    //（三轮实测：原子化后 2/3 通过，第 1 轮仍混进别的音）。
    // 在页内用 rAF 逐帧等，条件满足的**那一帧**立即取基线并注入 ⇒ 零间隙。
    const before = await page.evaluate(async ([id, k, ids]) => {
      const g = window.__MC_GAME__;
      const waitNonAttack = () => new Promise((resolve, reject) => {
        const t0 = performance.now();
        const tick = () => {
          const e = g.entities.get(id);
          if (!e) { reject(new Error('entity gone')); return; }
          if (e.state.mode !== 'attack') { resolve(e); return; }
          if (performance.now() - t0 > 60_000) { reject(new Error('等 mode 非 attack 超时')); return; }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      const e = await waitNonAttack();
      const c = g.audioDebugState().playRequests;
      const snap = Object.fromEntries(ids.map((x) => [x, c[x] ?? 0]));
      e.state = { ...e.state, mode: 'attack', attackKind: k, attackAnimT: 0, velocity: [0, 0, 0] };
      return snap;
    }, [sum.id, kind, IDS]);
    await page.waitForFunction(([base, key]) =>
      (window.__MC_GAME__.audioDebugState().playRequests[key] ?? 0) > base,
    [before[waitId], waitId], { timeout: 30_000 });
    const after = await page.evaluate((ids) => {
      const c = window.__MC_GAME__.audioDebugState().playRequests;
      return Object.fromEntries(ids.map((k) => [k, c[k] ?? 0]));
    }, IDS);
    return Object.fromEntries(IDS.map((k) => [k, after[k] - before[k]]));
  };

  // ① 举盾砸击起手 → 只播 bash
  const bash = await fire('shieldBash', 'ignis_attack_bash');
  expect(bash.ignis_attack_bash, `举盾砸击起手必须播 ignis_attack_bash（实际 ${JSON.stringify(bash)}）`).toBe(1);
  expect(bash.ignis_attack_swing, '举盾砸击起手不得播挥刀音').toBe(0);
  expect(bash.ignis_attack_circle, '举盾砸击起手不得播旋斩音').toBe(0);
  expect(bash.ignis_attack_smash, '举盾砸击起手不得播持盾冲撞音').toBe(0);

  // ② 负向锚点：同一只焰魔改钉 swing 起手 → 改播 swing 且不播 bash
  // ⚠️ **不在这里额外等「播完回 chase」**：`fire()` 内部已经先等 mode 稳定在非 attack。
  // 实测踩到：多写一道 30s 等待反而超时 —— 本招 3.89s + 空档（v3.07 起 [1.0,1.5]s），若玩家跑开导致
  // 它进了 idle/chase 循环，两道等待的语义重叠但窗口各自计时，白白多一个失败点。
  const swing = await fire('swing', 'ignis_attack_swing');
  expect(swing.ignis_attack_swing, `普攻起手必须播 swing（实际 ${JSON.stringify(swing)}）`).toBe(1);
  expect(swing.ignis_attack_bash, '普攻起手不得播举盾砸击音（否则是恒播 bash）').toBe(0);
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
  // 等玩家真的被砍到（血量下降）。焰魔 14 伤害 / 玩家 40 格血（v3.29 血量翻倍）
  // ⇒ 需要三刀才归 0，故窗口内只要看到一次扣血即可（不要求多次）。
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    return (g.audioDebugState().playRequests.ignis_hurt ?? 0) > 0 && g.player.health < 40;
  }, null, { timeout: 40_000 });

  const r = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return { health: g.player.health, hurt: g.audioDebugState().playRequests.ignis_hurt ?? 0 };
  });
  expect(r.health, '前置：玩家真的被砍到了（血量下降）').toBeLessThan(40);
  expect(r.hurt, '玩家被击中必须播 ignis_hurt').toBeGreaterThan(hurtBase);
});

/**
 * 焰魔受击音（用户 2026-11-18）：「焰魔被击中的时候没有被击中的声音……都用 gun_hit.ogg」。
 *
 * ⚠️ **必须走玩家真实开火路径**（`setTestAim` + `fireWeaponOnce`），不能直接调
 * `damageEntity()`：后者只能证明「装配层播了音」，证明不了「枪打中焰魔时那条路真的经过它」
 * （AGENTS.md M7 教训：接线类测试必须从玩家真实入口进入）。
 *
 * ⚠️ 判据同时钉三件事，缺一就有假绿：
 *   ① 这一枪真的命中（effect `entity-hit` + 扣血 25）—— 否则测的是「挥空」；
 *   ② `gun_hit` 计数 +1 —— 只钉「有声音」的话接错 id 也会通过；
 *   ③ 枪声 `gun_fire` 也在 —— 证明受击音是**叠加**而不是把枪声顶掉。
 */
test('焰魔：枪击中播 gun_hit（受击音，与守卫统一）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`/?vd=2&seed=${SEED}`);
  await waitWorldReady(page);
  await gotoOpenField(page);

  const sum = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    return g.ignises.summon('audio-spec:0:hit', Math.floor(p.x), Math.floor(p.z) + 6, 1, Math.floor(p.y));
  });
  expect(sum.ok, `前置：焰魔召唤成功（${sum.reason ?? ''}）`).toBe(true);
  await page.waitForFunction((id) =>
    window.__MC_GAME__.entities.get(id)?.state.onGround === true, sum.id, { timeout: 30_000 });

  const r = await page.evaluate(async (id) => {
    const g = window.__MC_GAME__;
    await g.selectWeapon('pistol');
    await new Promise((res) => setTimeout(res, 600));   // 等视图模型（与既有剑用例同口径）
    const st = g.entities.get(id).state;
    const [bx, by, bz] = st.position;
    // 玩家挪到焰魔正前方 6 格、同高（手枪射程 40，开阔地无遮挡）
    const p = g.player.physics.pos;
    p.x = bx; p.y = by; p.z = bz - 6;
    g.player.physics.vel.x = g.player.physics.vel.y = g.player.physics.vel.z = 0;
    await new Promise((res) => setTimeout(res, 300));
    // ⚠️ 瞄准用**当下**位置（焰魔 AI 每帧在动），且瞄身体中心（脚底 + 1.6）
    const now = g.entities.get(id).state;
    const [nx, ny, nz] = now.position;
    const cam = g.camera.position.toArray();
    g.player.setTestAim([nx - cam[0], ny + 1.6 - cam[1], nz - cam[2]]);
    const c = g.audioDebugState().playRequests;
    const before = { hit: c.gun_hit ?? 0, fire: c.gun_fire ?? 0, health: now.health };
    const effects = g.fireWeaponOnce();
    const after = g.audioDebugState().playRequests;
    return {
      effectType: effects[0]?.type ?? null,
      healthAfter: g.entities.get(id)?.state.health ?? -1,
      healthBefore: before.health,
      hitDelta: (after.gun_hit ?? 0) - before.hit,
      fireDelta: (after.gun_fire ?? 0) - before.fire,
      decoded: g.audioManager._buffers.has('gun_hit'),
    };
  }, sum.id);

  expect(r.effectType, '前置：这一枪必须命中实体（entity-hit）').toBe('entity-hit');
  expect(r.healthAfter, '前置：手枪必须扣血 25').toBe(r.healthBefore - 25);
  expect(r.decoded, 'gun_hit 必须已预载解码（否则只涨计数、永远不出声）').toBe(true);
  expect(r.hitDelta, '枪击中焰魔必须播一次 gun_hit').toBe(1);
  expect(r.fireDelta, '受击音是叠加，枪声不得被顶掉').toBe(1);
});

/**
 * 末影守卫受击音统一（同上用户裁定）：守卫原来播 `guardian_hurt`，现在也播 `gun_hit`。
 *
 * ⚠️ 守卫只在**废弃堡垒占地内**能按 B 召出（`bossMapAt`），故夹具与 guardian.spec 同源：
 * 传送到堡垒甲板 → 等落点列 → 真实 KeyB。开阔地里 `guardians.summon` 虽然也能造出实体，
 * 但那样就绕过了「玩家真能召出它」这条真实入口。
 *
 * ⚠️ 负向锚点：`guardian_hurt` 计数必须**不变** —— 只钉 gun_hit 上涨的话，
 * 「两个音一起播」也会通过（用户要的是统一，不是叠加）。
 */
test('末影守卫：枪击中播 gun_hit，不再播 guardian_hurt', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto(`/?vd=2&seed=${SEED}`);
  await waitWorldReady(page);
  const a = await page.evaluate(async () => {
    const m = await import('/src/gen/structures/ruined-citadel.js');
    const g = window.__MC_GAME__;
    const an = m.computeRuinedCitadelAnchor(g.seed);
    if (!an) return null;
    return {
      wx: an.wx, wz: an.wz, floorY: an.floorY,
      dx: m.RUINED_CITADEL_SUMMON_DX, dz: m.RUINED_CITADEL_SUMMON_DZ,
    };
  });
  expect(a, '前置：seed 12345 必须有废弃堡垒').not.toBeNull();
  await page.evaluate(([x, y, z]) => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    p.x = x; p.y = y; p.z = z;
    g.player.physics.vel.x = g.player.physics.vel.y = g.player.physics.vel.z = 0;
  }, [a.wx + 0.5, a.floorY + 1, a.wz + 0.5]);
  await page.waitForFunction(([x, z]) => {
    const g = window.__MC_GAME__;
    return g.world.hasColumn(Math.floor(x / 16), Math.floor(z / 16));
  }, [a.wx + a.dx, a.wz + a.dz], { timeout: 120_000 });
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB', repeat: false, bubbles: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyB', bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(
    () => window.__MC_GAME__.guardians.activeEntities()[0]?.state.onGround === true,
    null, { timeout: 30_000 });

  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    await g.selectWeapon('pistol');
    await new Promise((res) => setTimeout(res, 600));
    const e = g.guardians.activeEntities()[0];
    if (!e) return { summoned: false };
    const id = e.id;
    const [gx, gy, gz] = g.entities.get(id).state.position;
    // 玩家站到守卫正前方 4 格、同高（上层房间内，与 guardian.spec 的命中用例同手法）
    const p = g.player.physics.pos;
    p.x = gx; p.y = gy; p.z = gz - 4;
    g.player.physics.vel.x = g.player.physics.vel.y = g.player.physics.vel.z = 0;
    await new Promise((res) => setTimeout(res, 300));
    const now = g.entities.get(id).state;
    const [nx, ny, nz] = now.position;
    const cam = g.camera.position.toArray();
    // 守卫核心盒从脚底 +1.5 起 ⇒ 瞄 +2.6（照抄焰魔的 +1.6 会打在盒下沿之下）
    g.player.setTestAim([nx - cam[0], ny + 2.6 - cam[1], nz - cam[2]]);
    const c = g.audioDebugState().playRequests;
    const before = { hit: c.gun_hit ?? 0, old: c.guardian_hurt ?? 0, health: now.health };
    const effects = g.fireWeaponOnce();
    const after = g.audioDebugState().playRequests;
    return {
      summoned: true,
      effectType: effects[0]?.type ?? null,
      healthBefore: before.health,
      healthAfter: g.entities.get(id)?.state.health ?? -1,
      hitDelta: (after.gun_hit ?? 0) - before.hit,
      oldDelta: (after.guardian_hurt ?? 0) - before.old,
    };
  });

  expect(r.summoned, '前置：守卫必须被召出').toBe(true);
  expect(r.effectType, '前置：这一枪必须命中守卫（entity-hit）').toBe('entity-hit');
  expect(r.healthAfter, '前置：手枪必须扣血 25').toBe(r.healthBefore - 25);
  expect(r.hitDelta, '枪击中守卫必须播一次 gun_hit').toBe(1);
  expect(r.oldDelta, '不得再播 guardian_hurt（统一，不是叠加）').toBe(0);
});
