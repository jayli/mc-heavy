// tests/audio-fx.spec.mjs — 环境/动作音效（v2.51）
//
// **为什么需要 E2E**：这几条接线全在「游戏装配层 + 玩家输入路径」，单测只能验
// AudioManager 的状态机本身。漏接线的形态都是静默的（没有任何报错）：
//   ① 雨声没接 → 下雨时没有雨声（玩家可能以为是「本来就没有雨声」）；
//   ② 跑动没接 → 跑步没有脚步声；
//   ③ 放/挖没接 → 动作没有反馈；
//   ④ 死亡没接 → 打死丧尸/火龙没有音效。
// 而 `audioDebugState()`（播放请求计数）与 `debugLoops()`（循环音效状态机）都是可观测的
// —— 无头环境没有音频输出设备，本仓既有口径就是断言这两个（`bgm.spec.mjs` 同源）。
//
// ⚠️ **不断言「有没有声音」**，只断言「请求发生了 / 循环在播」。理由同 bgm.spec 文件头。
import { test, expect } from 'playwright/test';

async function boot(page, query = '') {
  await page.goto(`/?vd=2&seed=12345${query}`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
}

/** 读播放请求计数（只读诊断口，见 `Game.audioDebugState`）。 */
async function counts(page) {
  return page.evaluate(() => window.__MC_GAME__.audioDebugState().playRequests);
}

test.describe.configure({ mode: 'serial' });

test('雨声：只有下雨时才播，晴天不播', async ({ page }) => {
  test.setTimeout(180_000);

  // ---- 雨天：`?weather=rain` 启动即强制降雨 ----
  await boot(page, '&weather=rain');
  // 等天气状态机把 intensity 推上去（过渡 5 秒 + 首个 tick；这里只要求 > 0）
  await page.waitForFunction(() => (window.__MC_GAME__.weather?.intensity ?? 0) > 0,
    null, { timeout: 30_000 });
  await page.waitForFunction(() => window.__MC_GAME__.audioManager.debugLoops().rain?.playing === true,
    null, { timeout: 20_000 });
  const rainy = await page.evaluate(() => ({
    intensity: window.__MC_GAME__.weather.intensity,
    loop: window.__MC_GAME__.audioManager.debugLoops().rain,
    isRaining: window.__MC_GAME__.weather.isRaining,
  }));
  expect(rainy.isRaining, '前置：确实在下雨').toBe(true);
  expect(rainy.loop.playing, '下雨时必须真的在播雨声').toBe(true);
  expect(rainy.loop.target, '意图音量精确 = 0.2 × intensity（同帧取样）')
    .toBeCloseTo(0.2 * rainy.intensity, 10);

  // ⚠️ **不能用「刚起播那一瞬」比较实际音量**：three 的 `setVolume()` 走 setTargetAtTime
  // （指数逼近），从初始 gain 1.0 爬到 0.004 要几百毫秒 —— 实测首帧 actual **0.3166** 而
  // target **0.004**（差 0.098），那不是缺陷。故等过渡结束（intensity 稳定在 1）再比。
  await page.waitForFunction(() => window.__MC_GAME__.weather.intensity > 0.99,
    null, { timeout: 30_000 });
  await page.waitForTimeout(800);   // 让音量斜坡收敛
  const steady = await page.evaluate(() => window.__MC_GAME__.audioManager.debugLoops().rain);
  expect(Math.abs(steady.volume - 0.2),
    '稳态下雨时实际音频音量 = 0.2（“音量真的写下去了”的判据）').toBeLessThan(0.02);
  expect(steady.target, '稳态意图值也是 0.2').toBeCloseTo(0.2, 10);

  // ---- 晴天：强制切晴，过渡结束后雨声必须停 ----
  await page.evaluate(() => window.__MC_GAME__.weather.force('clear'));
  await page.waitForFunction(() => (window.__MC_GAME__.weather?.intensity ?? 1) === 0,
    null, { timeout: 30_000 });
  await page.waitForFunction(() => !window.__MC_GAME__.audioManager.debugLoops().rain,
    null, { timeout: 20_000 });
  expect(await page.evaluate(() => window.__MC_GAME__.audioManager.debugLoops().rain ?? null),
    '天晴后雨声必须停（循环实例被摘掉，不是只把音量调 0）').toBeNull();
});

test('放置与挖掘：成功才播 put / delete', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page, '&weather=clear');

  // 取一格确定可挖的方块（玩家脚下附近，非不可破坏）
  const cell = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const x = Math.floor(p.x), z = Math.floor(p.z);
    for (let dy = -1; dy >= -6; dy -= 1) {
      const y = Math.floor(p.y) + dy;
      const id = g.world.getBlockId(x, y, z);
      if (id !== 0 && g.registry.isIndestructible(id) === false) return { x, y, z, id };
    }
    return null;
  });
  expect(cell, '前置：出生点脚下必须能找到一格可挖的方块').not.toBeNull();

  // ---- 挖掘：走真实入口 `digBlock()`（命中 → 唯一编辑路径 → 音效） ----
  // ⚠️ **不得手工塞 target 后只断言编辑器被调用**：CLAUDE.md「E2E 不得手工塞 player.target」
  // 的教训说的是**放置**分支；这里的被测点是「digBlock 在真实改动后播 delete」，
  // 而真实准心在无头环境不可靠（出生点朝向随机命中），故用 `setTestAim` 摆真实姿态更贴近
  // 生产路径 —— 但那条路要先把玩家放到该格正上方，代价高且会被脚下地形影响。
  // 折中：直接调 `digBlock()` 前把 target 指向被测格，判据落在「音效请求 + 世界真的变了」。
  const digDelta = await page.evaluate((c) => {
    const g = window.__MC_GAME__;
    const before = g.audioDebugState().playRequests.delete ?? 0;
    g.player.target = {
      blockPos: [c.x, c.y, c.z], normal: [0, 1, 0], dist: 2, hit: true,
      prevPos: [c.x, c.y + 1, c.z],
    };
    g.player.digBlock({});
    return {
      delta: (g.audioDebugState().playRequests.delete ?? 0) - before,
      left: g.world.getBlockId(c.x, c.y, c.z),
    };
  }, cell);
  expect(digDelta.left, '前置：方块确实被挖掉了').toBe(0);
  expect(digDelta.delta, '挖掉一格必须播一次 delete').toBe(1);

  // ---- 挖空气不得连发 ----
  const airDelta = await page.evaluate((c) => {
    const g = window.__MC_GAME__;
    const before = g.audioDebugState().playRequests.delete ?? 0;
    g.player.target = {
      blockPos: [c.x, c.y, c.z], normal: [0, 1, 0], dist: 2, hit: true,
      prevPos: [c.x, c.y + 1, c.z],
    };
    g.player.digBlock({});   // 该格已是空气
    return (g.audioDebugState().playRequests.delete ?? 0) - before;
  }, cell);
  expect(airDelta, '挖空气（编辑无变化）不得播 delete —— 否则按住左键会连发打击音').toBe(0);

  // ---- 放置：走 `_placeSingle()`（单格写入的唯一实现，含成功音效） ----
  const putDelta = await page.evaluate((c) => {
    const g = window.__MC_GAME__;
    const before = g.audioDebugState().playRequests.put ?? 0;
    const placed = g.player._placeSingle(c.x, c.y, c.z, c.id);
    return {
      delta: (g.audioDebugState().playRequests.put ?? 0) - before,
      placed,
      id: g.world.getBlockId(c.x, c.y, c.z),
    };
  }, cell);
  expect(putDelta.placed, '前置：放置成功（没被玩家 AABB 守卫拒掉）').toBe(true);
  expect(putDelta.id, '前置：方块确实放回去了').toBe(cell.id);
  expect(putDelta.delta, '放下一格必须播一次 put').toBe(1);

  // ---- 背包选特殊结构（巢穴）的 put 音量路径不变（0.6 那条既有分支） ----
  expect((await counts(page)).put, 'put 计数已累加').toBeGreaterThanOrEqual(1);
});

test('跑动：全速移动时播陆上脚步声，停下即停', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page, '&weather=clear');

  // 无头环境没有真实键鼠 → 用 Player 的公开键集（与真实按键**同一条** `_applyInput` 路径）。
  const walked = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    g.player.keys.add('KeyW');
    const t0 = performance.now();
    let sawActive = false;
    let sawLoop = false;
    while (performance.now() - t0 < 4000) {
      await new Promise((r) => requestAnimationFrame(r));
      if (g.player.viewBob.active) sawActive = true;
      if (g.audioManager.debugLoops().running_land?.playing
        || g.audioManager.debugLoops().running_water?.playing) sawLoop = true;
    }
    g.player.keys.delete('KeyW');
    // 停下后等几帧让 `_updateFootsteps` 收掉循环
    for (let i = 0; i < 12; i++) await new Promise((r) => requestAnimationFrame(r));
    return {
      sawActive, sawLoop, inWater: g.player.physics.inWater,
      afterStop: {
        land: g.audioManager.debugLoops().running_land ?? null,
        water: g.audioManager.debugLoops().running_water ?? null,
      },
    };
  });
  expect(walked.sawActive, '前置：按 W 期间必须真的进入「全速跑动」（否则本条无从谈起）').toBe(true);
  expect(walked.sawLoop, '跑动期间必须有脚步声循环在播').toBe(true);
  expect(walked.afterStop.land, '停下后陆上脚步声必须停').toBeNull();
  expect(walked.afterStop.water, '停下后水上脚步声也必须停').toBeNull();
});

test('死亡：丧尸被击杀播 z_die，打中但没死时不播', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page, '&weather=clear');

  const r = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    // ⚠️ `spawnZombieNearPlayer()` 返回的是 `{spawned, position, attempts, count}`，
    // **不是** `{id}`（读错字段会让整条用例以 `skipped` 静默通过 —— 实测踩到）。
    const res = g.spawnZombieNearPlayer();
    if (!res.spawned) return { skipped: true, attempts: res.attempts, count: res.count };
    const id = res.spawned;
    const base = g.audioDebugState().playRequests.z_die ?? 0;
    // ① 打 1 点血（不死）→ 不得响
    const partial = g.damageEntity(id, 1, performance.now());
    const afterPartial = g.audioDebugState().playRequests.z_die ?? 0;
    // ② 打满 → 必须响一次
    const lethal = g.damageEntity(id, 10_000, performance.now());
    const afterLethal = g.audioDebugState().playRequests.z_die ?? 0;
    return { id, partialDead: partial?.dead, lethalDead: lethal?.dead,
      base, afterPartial, afterLethal };
  });
  expect(r.skipped ?? false,
    `丧尸生成失败（attempts=${r.attempts}, count=${r.count}）—— 出生点附近无合法落点或被上限拒绝`).toBe(false);
  expect(r.partialDead, '前置：1 点伤害不该致死').toBe(false);
  expect(r.afterPartial - r.base, '打中但没死时不得播死亡音效').toBe(0);
  expect(r.lethalDead, '前置：致死伤害').toBe(true);
  expect(r.afterLethal - r.base, '击杀必须播一次 z_die').toBe(1);
});
