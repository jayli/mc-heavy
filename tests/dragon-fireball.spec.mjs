// tests/dragon-fireball.spec.mjs — 飞龙火球装配验收（v2.44 Task 5）
//
// Tier 1 断言落点说明：本 spec 的关键回归是「火球爆炸**不污染** TNT 去重集合」与
// 「fireRequest 消费」—— 两者在纯逻辑单测里都能全绿却仍可能失效（火球误走 explodeTnt →
// 去重键常驻 → 之后同格 TNT 静默不爆；fireRequest 漏消费 → 龙永远喷不出火球）。
// 故断言必须落在**真游戏页的世界状态与计数**上（同 tnt.spec.mjs 的落点理由）。
//
// ⚠️ 爆炸口径零回归（3×3×3 破坏 / 连锁 / 丧尸伤害 / 特效）由既有 `tests/tnt.spec.mjs` 兜
// （它就是爆炸回归门）；本 spec 只新增「火球专属」的三条：负向验证 + fireRequest 消费 + 开关口径。
import { test, expect } from 'playwright/test';

async function waitWorldSettled(page) {
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const s = g.scheduler.stats();
    const sections = g.renderStats().sections;
    const prev = window.__MC_STABLE_PREV__;
    window.__MC_STABLE_PREV__ = sections;
    return prev === sections &&
      s.genInflight === 0 && s.meshInflight === 0 && s.meshQueued === 0 &&
      s.pendingMesh === 0 && s.lightInflight === 0 && s.lightQueued === 0 && s.uploadQueue === 0;
  }, null, { timeout: 90_000, polling: 500 });
}

const URL = '/?vd=2&seed=12345';

async function boot(page) {
  await page.goto(URL);
  await waitWorldSettled(page);
}

/** 在玩家附近搭一片 stone 平台（y=by−1），清空 by/by+1 两层。返回中心格坐标。 */
async function setupPlatform(page) {
  return page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const bx = Math.floor(p.x) + 3, by = Math.floor(p.y), bz = Math.floor(p.z);
    const stone = g.registry.idOf('stone');
    for (let dx = -4; dx <= 4; dx++) {
      for (let dz = -4; dz <= 4; dz++) {
        g.editor.setBlock({ x: bx + dx, y: by - 1, z: bz + dz, id: stone });
        g.editor.setBlock({ x: bx + dx, y: by, z: bz + dz, id: 0 });
        g.editor.setBlock({ x: bx + dx, y: by + 1, z: bz + dz, id: 0 });
        g.editor.setBlock({ x: bx + dx, y: by + 2, z: bz + dz, id: 0 });
      }
    }
    return { bx, by, bz, neighbor: [bx + 1, by - 1, bz] };
  });
}

/** 当前火球实体数 */
function fireballCount(page) {
  return page.evaluate(() =>
    [...window.__MC_GAME__.entities.entities()].filter((e) => e.type === 'fireball').length);
}

test('火球爆炸不污染 TNT 去重集合（Review Focus 1 负向验证）', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  const setup = await setupPlatform(page);

  // ① 让一个火球在平台格 (bx, by−1, bz) 爆炸：从上方朝下发射，DDA 命中平台顶层 stone。
  const explodedBefore = await page.evaluate(() => window.__MC_GAME__.tntChainDebugState().exploded);
  await page.evaluate((c) => {
    const g = window.__MC_GAME__;
    // 从 (bx+0.5, by+2, bz+0.5) 朝下 → 撞 (bx, by−1, bz) 的 stone 顶面
    g.fireFireball([c.bx + 0.5, c.by + 2, c.bz + 0.5], [0, -1, 0], 'dragon:test');
  }, setup);
  // 等火球消失（爆炸或超距）—— 平台只有 3 格高，必然很快撞到
  await page.waitForFunction(() =>
    [...window.__MC_GAME__.entities.entities()].filter((e) => e.type === 'fireball').length === 0,
  null, { timeout: 10_000, polling: 50 });
  const explodedAfter = await page.evaluate(() => window.__MC_GAME__.tntChainDebugState().exploded);
  expect(explodedAfter, '火球撞方块必须触发一次爆炸（_applyExplosion 计数）').toBe(explodedBefore + 1);

  // ② **负向验证核心**：火球炸过的那格 (bx, by−1, bz)，之后放 TNT 引爆必须仍返回 true。
  //    若火球误走 explodeTnt，该格键会常驻 _ignitingTnt → 这里返回 false（静默不爆）。
  const tntWorks = await page.evaluate((c) => {
    const g = window.__MC_GAME__;
    const cell = [c.bx, c.by - 1, c.bz];   // 火球命中的平台格
    g.editor.setBlock({ x: cell[0], y: cell[1], z: cell[2], id: g.registry.idOf('tnt') });
    return g.explodeTnt(cell[0], cell[1], cell[2]);
  }, setup);
  expect(tntWorks, '火球炸过的格之后放 TNT 仍须能引爆（去重集合未被火球污染）').toBe(true);
});

test('fireRequest 消费：龙有开火请求 → 生成火球；null → 不生成', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);

  // 召一条龙（直接用 summon，中心取玩家附近 —— 测消费接线，不依赖真实高台地带）
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    g.dragons.summon('test:0:0', Math.floor(p.x), Math.floor(p.z), 0);
  });
  await page.waitForFunction(() => window.__MC_GAME__.dragons.activeEntities().length === 1,
    null, { timeout: 10_000 });

  // ⑤ 注入 fireRequest → 消费 → 生成一个火球，position/direction 逐位等于请求值
  const consumed = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const d = g.dragons.activeEntities()[0];
    const req = { position: [d.state.position[0], d.state.position[1], d.state.position[2]], direction: [0, -1, 0] };
    d.state.fireRequest = req;
    const before = [...g.entities.entities()].filter((e) => e.type === 'fireball').length;
    g._consumeDragonFireRequests();
    const fb = [...g.entities.entities()].find((e) => e.type === 'fireball');
    return {
      before,
      after: [...g.entities.entities()].filter((e) => e.type === 'fireball').length,
      pos: fb ? [...fb.state.position] : null,
      dir: fb ? [...fb.state.direction] : null,
      reqPos: req.position, reqDir: req.direction,
    };
  });
  expect(consumed.after, '有 fireRequest 必须生成一个火球').toBe(consumed.before + 1);
  expect(consumed.pos).toEqual(consumed.reqPos);
  expect(consumed.dir).toEqual(consumed.reqDir);

  // ⑥ fireRequest = null → 不生成
  const noop = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    // 清掉上一发的火球，避免干扰计数
    for (const e of [...g.entities.entities()]) if (e.type === 'fireball') g.entities.despawn(e.id, 'test');
    const d = g.dragons.activeEntities()[0];
    d.state.fireRequest = null;
    const before = [...g.entities.entities()].filter((e) => e.type === 'fireball').length;
    g._consumeDragonFireRequests();
    return { before, after: [...g.entities.entities()].filter((e) => e.type === 'fireball').length };
  });
  expect(noop.after, 'fireRequest 为 null 不得生成火球').toBe(noop.before);
});

test('火球 spawn 失败（实体池满额）不得静默吞掉（评审 I3）', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);

  // 召一条龙，注入「entities.spawn 恒返回 null」（= 池满额），断言诊断计数增加。
  // ⚠️ **形态是「龙张嘴没喷出东西，然后长时间不喷」**（冷却已重置）—— 玩家会读作 AI 坏了，
  // 而概率虽低（需 EntityManager 全量满额）却是**静默**的 —— 与本 spec 第一条的去重污染同类，
  // 本仓文化里值得一个防线。
  const r = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    g.dragons.summon('i3:0:0', Math.floor(p.x), Math.floor(p.z), 0);
    const d = g.dragons.activeEntities()[0];
    const before = g.fireballsDebugState().spawnFailed;
    const realSpawn = g.entities.spawn.bind(g.entities);
    g.entities.spawn = () => null;   // 注入：池满额
    d.state.fireRequest = { position: [...d.state.position], direction: [0, -1, 0] };
    g._consumeDragonFireRequests();
    g.entities.spawn = realSpawn;
    return { before, after: g.fireballsDebugState().spawnFailed };
  });
  expect(r.after, 'spawn 失败必须计入诊断（不得静默吞掉）').toBe(r.before + 1);
});

test('火球爆炸口径跟 TNT 开关：开启破坏方块、关闭不破坏（用户核心需求）', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  const setup = await setupPlatform(page);

  // 默认关（canTntDestroyBlocks=false）：火球撞方块爆炸，但邻居 stone 不被破坏
  await page.evaluate((c) => {
    window.__MC_GAME__.fireFireball([c.bx + 0.5, c.by + 2, c.bz + 0.5], [0, -1, 0], 'dragon:test');
  }, setup);
  await page.waitForFunction(() =>
    [...window.__MC_GAME__.entities.entities()].filter((e) => e.type === 'fireball').length === 0,
  null, { timeout: 10_000, polling: 50 });
  const intactAfterOff = await page.evaluate((n) =>
    window.__MC_GAME__.world.getBlockId(n[0], n[1], n[2]) !== 0, setup.neighbor);
  expect(intactAfterOff, '破坏开关关：火球爆炸不得破坏方块').toBe(true);

  // 开启破坏：再炸一次 → 邻居 stone 被破坏（与 TNT 同 3×3×3 口径）
  await page.evaluate(() => window.__MC_GAME__.setTntBlockDamage(true));
  await page.evaluate((c) => {
    window.__MC_GAME__.fireFireball([c.bx + 0.5, c.by + 2, c.bz + 0.5], [0, -1, 0], 'dragon:test');
  }, setup);
  await page.waitForFunction(() =>
    [...window.__MC_GAME__.entities.entities()].filter((e) => e.type === 'fireball').length === 0,
  null, { timeout: 10_000, polling: 50 });
  const destroyedAfterOn = await page.evaluate((n) =>
    window.__MC_GAME__.world.getBlockId(n[0], n[1], n[2]) === 0, setup.neighbor);
  expect(destroyedAfterOn, '破坏开关开：火球爆炸须破坏方块（TNT 同口径）').toBe(true);
});
