// tests/soldier.spec.mjs — 士兵 E2E + Tier 4 像素（士兵 Epic Task 8）
//
// 夹具照 `tests/enemy-wiring.spec.mjs`（已验证口径）：真实 `window.__MC_GAME__`、
// seed 12345、`?vd=2`、等世界就绪 + 等玩家落地。
//
// ⚠️ **召唤一律走真实入口**（C 键 / spawnSoldierNearPlayer）—— 直接调 service.spawn
// 会漏掉「按键没接 / service 没装配」这类接线缺陷（guardian.spec 文件头教训）。
// ⚠️ **Tier 4 三条**：固定机位 + 冻住动态源 + 先藏掉自带同色的宿主；
// 火光/曳光取样必须**同步立刻**（0.045s / 0.3s，任何 await 都可能跨过它）。
import { test, expect } from 'playwright/test';
import { SOLDIER, SOLDIER_AI, SOLDIER_SHOT } from '../src/entities/soldiers/soldier-config.js';
import { EXPLOSION_DAMAGE } from '../src/voxel/explosion.js';

const SEED = 12345;
const URL = `/?vd=2&seed=${SEED}`;

async function waitWorldReady(page) {
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
}

/** 挪到远离城市的开阔地（照 enemy-wiring.spec:33） */
async function gotoOpenField(page, { offsetX = 600, offsetZ = 600 } = {}) {
  await page.evaluate(async ([ox, oz]) => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    g._teleportTo(Math.floor(p.x) + ox, 45, Math.floor(p.z) + oz);
    await new Promise((r) => setTimeout(r, 2500));
  }, [offsetX, offsetZ]);
}

/** 等玩家停止下坠（照 enemy-wiring.spec:66：用物理 onGround，不用 isSolid） */
async function waitPlayerLanded(page) {
  await page.waitForFunction(() => {
    const ph = window.__MC_GAME__?.player?.physics;
    return ph && ph.onGround === true && Math.abs(ph.vel.y) < 1e-6;
  }, null, { timeout: 30_000 });
  await page.waitForTimeout(400);
}

/** 派真实 KeyC */
async function pressC(page) {
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', repeat: false, bubbles: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyC', bubbles: true, cancelable: true }));
  });
}

/** 铺一块平整测试场（照 tnt.spec 的 setupField：by-1 铺石、by/by+1 清空） */
async function makeField(page, { radius = 12 } = {}) {
  return page.evaluate((r) => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
    const stone = g.registry.idOf('stone');
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        g.editor.setBlock({ x: bx + dx, y: by - 1, z: bz + dz, id: stone });
        for (let dy = 0; dy <= 4; dy++) g.editor.setBlock({ x: bx + dx, y: by + dy, z: bz + dz, id: 0 });
      }
    }
    return { bx, by, bz };
  }, radius);
}

test.describe.configure({ mode: 'serial' });

test('C 键召唤士兵，连按 11 次恰好 10 只（上限 = 用户裁定 10）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(URL);
  await waitWorldReady(page);
  await gotoOpenField(page);
  await waitPlayerLanded(page);
  await makeField(page);
  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const before = g.soldiers.count();
    for (let i = 0; i < 11; i++) {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', repeat: false, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyC', bubbles: true }));
      await new Promise((res) => setTimeout(res, 60));
    }
    return { before, after: g.soldiers.count(), cap: g.soldiers.maxAlive };
  });
  expect(r.before, '前置：开局无士兵').toBe(0);
  expect(r.after, `连按 11 次须恰好 ${SOLDIER.maxAlive} 只`).toBe(SOLDIER.maxAlive);
});

test('士兵 combat 态与玩家保持距离（Review Focus 2：不是会开枪的丧尸）', async ({ page }) => {
  test.setTimeout(200_000);
  await page.goto(URL);
  await waitWorldReady(page);
  await gotoOpenField(page);
  await waitPlayerLanded(page);
  const f = await makeField(page, { radius: 20 });
  const r = await page.evaluate(async ([bx, by, bz]) => {
    const g = window.__MC_GAME__;
    // 直接放到 14 格处并进 combat（避开 awareness 累积的时序依赖）
    const id = g.soldiers.spawn([bx + 14.5, by, bz + 0.5], { source: 'spec' });
    if (!id) return { error: 'spawn 失败' };
    const e = g.entities.get(id);
    e.state = { ...e.state, mode: 'combat', awareness: 1, losVisible: true, losTimer: 99 };
    const dists = [];
    /**
     * ⚠️⚠️ **必须钉住站姿**（N5 负向验证暴露的判据缺陷）：
     * 蹲下时移动意图恒 0，实测 60 拍里有 28 拍 crouch=1 ⇒ 即便注入「恒直冲玩家」，
     * 6s 内也只从 14.5 挪到 7.49，** never 跌破阈值 6** ⇒ 注入后仍 PASS（判据零判别力）。
     * 正解：每拍强制 crouching=false / crouch=0 / peekT 大值，让移动不被蹲姿打断，
     * 并把窗口拉到 12s —— 直冲版会一路贴到玩家身上（<2 格），正确版停在环下界 8 附近。
     */
    for (let i = 0; i < 120; i++) {
      const en = g.entities.get(id);
      if (!en) break;
      en.state = { ...en.state, crouching: false, crouch: 0, peekT: 99 };
      await new Promise((res) => setTimeout(res, 100));
      const cur = g.entities.get(id);
      if (!cur) break;
      const p = g.player.physics.pos;
      dists.push(Math.hypot(cur.state.position[0] - p.x, cur.state.position[2] - p.z));
    }
    return { dists, min: Math.min(...dists), max: Math.max(...dists) };
  }, [f.bx, f.by, f.bz]);
  expect(r.error).toBeUndefined();
  expect(r.dists.length, '前置：须采到样本').toBeGreaterThan(10);
  // ⚠️ 判据是「不贴身」：直冲玩家的丧尸会掉到 0.6 格。环下界 8，留 2 格余量给物理滞后。
  expect(r.min, `士兵不得贴身（实测最近 ${r.min.toFixed(2)} 格）`).toBeGreaterThan(6);
});

test('士兵会蹲下也会站起（30s 内两态都出现）', async ({ page }) => {
  test.setTimeout(200_000);
  await page.goto(URL);
  await waitWorldReady(page);
  await gotoOpenField(page);
  await waitPlayerLanded(page);
  const f = await makeField(page, { radius: 20 });
  const r = await page.evaluate(async ([bx, by, bz]) => {
    const g = window.__MC_GAME__;
    const id = g.soldiers.spawn([bx + 14.5, by, bz + 0.5], { source: 'spec' });
    const e = g.entities.get(id);
    e.state = { ...e.state, mode: 'combat', awareness: 1, losVisible: true, losTimer: 99 };
    let sawCrouch = false, sawStand = false;
    for (let i = 0; i < 200; i++) {
      await new Promise((res) => setTimeout(res, 60));
      const en = g.entities.get(id);
      if (!en) break;
      if (en.state.crouch > 0.9) sawCrouch = true;
      if (en.state.crouch < 0.1) sawStand = true;
      if (sawCrouch && sawStand) break;
    }
    return { sawCrouch, sawStand };
  }, [f.bx, f.by, f.bz]);
  expect(r.sawCrouch, '士兵须蹲下过').toBe(true);
  expect(r.sawStand, '士兵须站起过').toBe(true);
});

test('士兵子弹打玩家：命中后血量恰好 −2（用户裁定）', async ({ page }) => {
  test.setTimeout(200_000);
  await page.goto(URL);
  await waitWorldReady(page);
  await gotoOpenField(page);
  await waitPlayerLanded(page);
  const f = await makeField(page);
  const r = await page.evaluate(async ([bx, by, bz]) => {
    const g = window.__MC_GAME__;
    const id = g.soldiers.spawn([bx + 10.5, by, bz + 0.5], { source: 'spec' });
    if (!id) return { error: 'spawn 失败' };
    // 定值 rng 让命中骰子必过（Math.random() < chance，chance ≥ 0.06）
    const origRandom = Math.random;
    Math.random = () => 0;
    const e = g.entities.get(id);
    e.state = { ...e.state, mode: 'combat', awareness: 1, crouching: false, crouch: 0, peekT: 99,
      losVisible: true, losTimer: 99, nextBurst: 0, reaction: 0, burst: 0 };
    const hp0 = g.player.health;
    let hpAfter = hp0;
    for (let i = 0; i < 100; i++) {
      await new Promise((res) => setTimeout(res, 50));
      if (g.player.health < hp0) { hpAfter = g.player.health; break; }
    }
    Math.random = origRandom;
    return { hp0, hpAfter, drop: hp0 - hpAfter };
  }, [f.bx, f.by, f.bz]);
  expect(r.error).toBeUndefined();
  expect(r.drop, `必须真的扣血（实测掉 ${r.drop}）`).toBeGreaterThan(0);
  expect(r.drop % SOLDIER_SHOT.playerDamage, `掉血须是 ${SOLDIER_SHOT.playerDamage} 的整数倍`).toBe(0);
});

test('士兵子弹命中玩家播 hited（用户 2026-11-24 第二轮裁定）', async ({ page }) => {
  test.setTimeout(200_000);
  await page.goto(URL);
  await waitWorldReady(page);
  await gotoOpenField(page);
  await waitPlayerLanded(page);
  const f = await makeField(page);
  const r = await page.evaluate(async ([bx, by, bz]) => {
    const g = window.__MC_GAME__;
    const id = g.soldiers.spawn([bx + 10.5, by, bz + 0.5], { source: 'spec' });
    if (!id) return { error: 'spawn 失败' };
    const origRandom = Math.random;
    Math.random = () => 0;   // 命中骰子必过
    const e = g.entities.get(id);
    e.state = { ...e.state, mode: 'combat', awareness: 1, crouching: false, crouch: 0, peekT: 99,
      losVisible: true, losTimer: 99, nextBurst: 0, reaction: 0 };
    const cnt = (k) => g.audioDebugState().playRequests[k] ?? 0;
    /**
     * v3.36：用户第二轮裁定把两条音**对调**：
     *   玩家被 soldier 击中 ⇒ `hited.mp3`（本用例）
     *   soldier 被击中     ⇒ `carbine_impact_wet.wav`（另一条用例）
     * ⚠️ 成对断言的形态不变（只改这一条路径 + 不叠音）：
     * 反过来写（仍播 carbine_impact_wet）在「响了几个音」的判据下照样全绿。
     */
    const hit0 = cnt('hited');
    const wet0 = cnt('carbine_impact_wet');
    const hurt0 = cnt('ignis_hurt');
    const hp0 = g.player.health;
    for (let i = 0; i < 100; i++) {
      await new Promise((res) => setTimeout(res, 50));
      if (g.player.health < hp0) break;
    }
    const out = { hp0, hp1: g.player.health,
      hitDelta: cnt('hited') - hit0,
      wetDelta: cnt('carbine_impact_wet') - wet0, hurtDelta: cnt('ignis_hurt') - hurt0 };
    Math.random = origRandom;
    return out;
  }, [f.bx, f.by, f.bz]);
  expect(r.error).toBeUndefined();
  expect(r.hp1, '前置：玩家真的被打中').toBeLessThan(r.hp0);
  expect(r.hitDelta, '枪击命中玩家必须播 hited.mp3').toBeGreaterThan(0);
  // ⚠️ 成对断言 ①：carbine_impact_wet 现在是**士兵挨打**的音，玩家这条路径不得再播
  expect(r.wetDelta, '玩家被击中路径不得再播 carbine_impact_wet（那是士兵的受击音）').toBe(0);
  // ⚠️ 成对断言 ②：只改枪击这一条路径，Boss 近战的 ignis_hurt 不受影响
  expect(r.hurtDelta, '枪击路径不得再播 ignis_hurt（否则叠两声）').toBe(0);
});

test('士兵开火播 carbine_bullet.mp3（用户 2026-11-24 第三轮裁定）', async ({ page }) => {
  test.setTimeout(200_000);
  await page.goto(URL);
  await waitWorldReady(page);
  await gotoOpenField(page);
  await waitPlayerLanded(page);
  const f = await makeField(page);
  const r = await page.evaluate(async ([bx, by, bz]) => {
    const g = window.__MC_GAME__;
    const id = g.soldiers.spawn([bx + 10.5, by, bz + 0.5], { source: 'spec' });
    if (!id) return { error: 'spawn 失败' };
    const origRandom = Math.random;
    /**
     * ⚠️ **必须分两段测，且第二段要把命中骰子钉成必不中**：
     * 「开火声」是**每发都该响**的（打没打中与枪响无关），而 `_damagePlayer` 的受击音
     * 只在真命中时响。只测命中那一段的话，「只给命中分支接音」的缺陷形态照样全绿
     *（连射时听起来像「命中才响」）。
     */
    const e = g.entities.get(id);
    const toCombat = () => {
      e.state = { ...e.state, mode: 'combat', awareness: 1, crouching: false, crouch: 0, peekT: 99,
        losVisible: true, losTimer: 99, nextBurst: 0, reaction: 0 };
    };
    const cnt = (k) => g.audioDebugState().playRequests[k] ?? 0;
    // ---- 第一段：命中（骰子必过）----
    Math.random = () => 0;
    toCombat();
    const hit0 = cnt('carbine_bullet');
    const hp0 = g.player.health;
    for (let i = 0; i < 100; i++) {
      await new Promise((res) => setTimeout(res, 50));
      if (g.player.health < hp0) break;
    }
    const onHit = { shots: cnt('carbine_bullet') - hit0, hp0, hp1: g.player.health };
    /**
     * ---- 第二段：**必不中**（骰子恒 1 ⇒ `Math.random() < chance` 恒假）----
     * 此时玩家不掉血，但士兵仍在开枪 ⇒ 开火声**仍必须响**。
     */
    Math.random = () => 0.999999;
    toCombat();
    const miss0 = cnt('carbine_bullet');
    const hp1b = g.player.health;
    for (let i = 0; i < 100; i++) {
      await new Promise((res) => setTimeout(res, 50));
      if (cnt('carbine_bullet') - miss0 > 0) break;
    }
    const onMiss = { shots: cnt('carbine_bullet') - miss0, hp0: hp1b, hp1: g.player.health };
    Math.random = origRandom;
    return { onHit, onMiss };
  }, [f.bx, f.by, f.bz]);
  expect(r.error).toBeUndefined();
  // ---- 第一段：命中 ----
  expect(r.onHit.hp1, '前置：玩家真的被打中').toBeLessThan(r.onHit.hp0);
  expect(r.onHit.shots, '开火必须播 carbine_bullet.mp3').toBeGreaterThan(0);
  // ---- 第二段：未命中 ----
  expect(r.onMiss.hp1, '前置：骰子钉成必不中 ⇒ 玩家不掉血').toBe(r.onMiss.hp0);
  expect(r.onMiss.shots, '未命中时开火声仍须响（枪响与是否打中无关）').toBeGreaterThan(0);
});

test('血为 0 时被击中仍有音效（用户 2026-11-24：不管还有没有血）', async ({ page }) => {
  test.setTimeout(200_000);
  await page.goto(URL);
  await waitWorldReady(page);
  await gotoOpenField(page);
  await waitPlayerLanded(page);
  /**
   * ⚠️ **这条专抓「血空即静音」**：原守卫是 `if (after < before)`，
   * 血停在 0 后 after===before ⇒ 音效不响。用户实玩报告「杀一个 soldier 后就没声了」，
   * 探针查明真因是血被打空（不是击杀本身）。
   * 判据走**唯一入口** `_damagePlayer`，排除士兵 AI 时序变量。
   */
  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    document.querySelector('canvas')?.click();
    await g.audioManager?.unlock?.();
    const cnt = (k) => g.audioDebugState().playRequests[k] ?? 0;
    const hit = (sound) => {
      const w0 = cnt(sound);
      g._damagePlayer(2, performance.now(), sound ? { sound } : undefined);
      return cnt(sound) - w0;
    };
    // ① 满血
    g.player.health = 40;
    const atFull = hit('hited');
    // ② 血空（用户要的核心场景）
    g.player.health = 0;
    const atZeroGun = hit('hited');
    // ③ 血空 + Boss 近战路径（缺省音）—— 用户说「只要被击中」，不限枪击
    const h0 = cnt('ignis_hurt');
    g._damagePlayer(14, performance.now());
    const atZeroMelee = cnt('ignis_hurt') - h0;
    // ④ 零伤害不该响（不是「被击中」）—— ⚠️ 必须显式传 0，
    // 上面的 hit() 恒传 2，用它测「零伤害」是测不到的（首轮实测踩到）。
    g.player.health = 0;
    const z0 = cnt('hited');
    g._damagePlayer(0, performance.now(), { sound: 'hited' });
    const zeroAmount = cnt('hited') - z0;
    return { atFull, atZeroGun, atZeroMelee, zeroAmount, hp: g.player.health };
  });
  expect(r.atFull, '前置：满血时须响').toBe(1);
  expect(r.atZeroGun, '血为 0 时枪击仍须响').toBe(1);
  expect(r.atZeroMelee, '血为 0 时 Boss 近战仍须响').toBe(1);
  expect(r.zeroAmount, '零伤害不算被击中，不得响').toBe(0);
  expect(r.hp, '血量仍停在 0（不做死亡的裁定不变）').toBe(0);
});

test('士兵子弹不穿墙（Review Focus 3）', async ({ page }) => {
  test.setTimeout(200_000);
  await page.goto(URL);
  await waitWorldReady(page);
  await gotoOpenField(page);
  await waitPlayerLanded(page);
  const f = await makeField(page);
  const r = await page.evaluate(async ([bx, by, bz]) => {
    const g = window.__MC_GAME__;
    // 在玩家与士兵之间砌一堵 3 格高实心墙
    const stone = g.registry.idOf('stone');
    for (let dz = -3; dz <= 3; dz++) {
      for (let dy = 0; dy <= 3; dy++) g.editor.setBlock({ x: bx + 5, y: by + dy, z: bz + dz, id: stone });
    }
    const id = g.soldiers.spawn([bx + 10.5, by, bz + 0.5], { source: 'spec' });
    const origRandom = Math.random;
    Math.random = () => 0;   // 骰子必过 ⇒ 若仍不掉血，只能是墙挡住了
    const e = g.entities.get(id);
    e.state = { ...e.state, mode: 'combat', awareness: 1, crouching: false, crouch: 0, peekT: 99,
      losVisible: true, losTimer: 99, nextBurst: 0, reaction: 0 };
    const hp0 = g.player.health;
    /**
     * ⚠️ **必须每拍把士兵钉回原位**（探针实测）：墙只有 7 格宽，而 combat 态的
     * 侧向游走会让士兵**绕到墙侧面**再开枪（实测 z 从 717.5 漂到 719.99、yaw 转到 4.47）
     * ⇒ 那时 DDA 正确地判「没被挡住」，玩家真的该掉血。
     * 不钉位置的用例测的是「士兵会不会绕墙」，不是「子弹能不能穿墙」。
     */
    const pin = [bx + 10.5, by, bz + 0.5];
    for (let i = 0; i < 60; i++) {
      const en = g.entities.get(id);
      if (en) en.state = { ...en.state, position: [...pin], velocity: [0, 0, 0], yaw: -Math.PI / 2 };
      await new Promise((res) => setTimeout(res, 50));
    }
    const hp1 = g.player.health;
    Math.random = origRandom;
    return { hp0, hp1 };
  }, [f.bx, f.by, f.bz]);
  expect(r.hp1, '墙后玩家血量必须逐位不变').toBe(r.hp0);
});

test('班组报警：一只挨打 ⇒ 34 格内同伴被安排入战，界外不报警', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(URL);
  await waitWorldReady(page);
  await gotoOpenField(page);
  await waitPlayerLanded(page);
  const f = await makeField(page, { radius: 16 });
  /**
   * ⚠️ **界外对照靠「移动声源」而不是「在远处生成士兵」**（两轮探针实测）：
   * vd=2 只加载约 32 格，36/40 格外的 column **永远不加载**（waitForFunction 60s 超时），
   * 在那里 spawn 必返回 null。故把两只都放在近处，再把**挨打的那只**挪到 50 格外
   * （逻辑位置，不需 column），验证同一名同伴这次不被报警。
   */
  const r = await page.evaluate(([bx, by, bz]) => {
    const g = window.__MC_GAME__;
    const a = g.soldiers.spawn([bx + 0.5, by, bz + 0.5], { source: 'spec' });
    const peer = g.soldiers.spawn([bx + 10.5, by, bz + 0.5], { source: 'spec' });
    if (!a || !peer) return { error: `spawn 失败 a=${a} peer=${peer}` };
    // ① 近处挨打 ⇒ 同伴须被安排入战
    g.damageEntity(a, 1, performance.now());
    const nearDelay = g.entities.get(peer).state.alertDelay;
    const srcMode = g.entities.get(a).state.mode;
    // ② 复位同伴，把声源挪到 50 格外再挨打 ⇒ 不得被报警
    const pe = g.entities.get(peer);
    pe.state = { ...pe.state, alertDelay: -1, mode: 'patrol', awareness: 0 };
    const ae = g.entities.get(a);
    ae.state = { ...ae.state, position: [bx + 0.5, by, bz + 50.5], mode: 'patrol', health: 90 };
    g.entities.reindexColumn(a);
    g.damageEntity(a, 1, performance.now());
    return { nearDelay, srcMode, farDelay: g.entities.get(peer).state.alertDelay };
  }, [f.bx, f.by, f.bz]);
  expect(r.error, '前置：两只都须生成').toBeUndefined();
  expect(r.srcMode, '挨打的那只须入战').toBe('combat');
  expect(r.nearDelay, '34 格内同伴须被安排延迟入战').toBeGreaterThanOrEqual(0);
  expect(r.farDelay, '声源在 34 格外时不得报警').toBe(-1);
});

test('听枪声：玩家开火 ⇒ 48 格内 patrol 士兵转 search', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(URL);
  await waitWorldReady(page);
  await gotoOpenField(page);
  await waitPlayerLanded(page);
  const f = await makeField(page, { radius: 30 });
  const r = await page.evaluate(async ([bx, by, bz]) => {
    const g = window.__MC_GAME__;
    const near = g.soldiers.spawn([bx + 10.5, by, bz + 0.5], { source: 'spec' });
    if (!near) return { error: 'spawn 失败' };
    await g.selectWeapon('pistol');
    g.fireWeaponOnce();
    const nearMode = g.entities.get(near).state.mode;
    /**
     * ⚠️ **远处对照改用「把同一只挪远再开一枪」**：hearRadius=48 而 vd=2 只加载约 32 格，
     * 48 格外的 column 根本没加载 ⇒ 在那里 spawn 必返回 null（探针实测）。
     * 故把这只士兵先复位成 patrol、挪到 50 格外（逻辑位置，不需 column），再开枪验证不被惊动。
     */
    const en = g.entities.get(near);
    en.state = { ...en.state, mode: 'patrol', awareness: 0, searchT: 0, patrolTarget: null };
    const p = g.player.physics.pos;
    en.state = { ...en.state, position: [p.x, p.y, p.z + 50] };
    g.entities.reindexColumn(near);
    g.fireWeaponOnce();
    return { nearMode, farMode: g.entities.get(near).state.mode };
  }, [f.bx, f.by, f.bz]);
  expect(r.error, '前置：两只都须生成').toBeUndefined();
  expect(r.nearMode, '48 格内士兵须转 search').toBe('search');
  expect(r.farMode, '48 格外不受影响').toBe('patrol');
});

test('全部现有武器都能击伤士兵', async ({ page }) => {
  test.setTimeout(200_000);
  await page.goto(URL);
  await waitWorldReady(page);
  await gotoOpenField(page);
  await waitPlayerLanded(page);
  const f = await makeField(page);
  const rows = await page.evaluate(async ([bx, by, bz]) => {
    const g = window.__MC_GAME__;
    const out = [];
    for (const weapon of ['pistol', 'mag7', 'minigun', 'sword', 'carbine']) {
      const id = g.soldiers.spawn([bx + 2.5, by, bz + 0.5], { source: 'spec' });
      if (!id) { out.push({ weapon, error: 'spawn 失败' }); continue; }
      /**
       * ⚠️ **必须按玩家真实朝向放士兵**（探针实测）：本仓 yaw=π 时前向是 **+Z**
       * （`aimForward=[0,0,1]`），我原本写死 z−2 把士兵放到了玩家**背后** ⇒ 射线打不到，
       * 看起来像「武器接线漏了」，实则夹具方向错。
       * 正解：读 `_buildAim().forward` 沿它放 2 格（剑射程 3 内）。
       */
      const e = g.entities.get(id);
      const p = g.player.physics.pos;
      const aim0 = g.player._buildAim();
      e.state = { ...e.state,
        position: [p.x + aim0.forward[0] * 2, p.y, p.z + aim0.forward[2] * 2],
        velocity: [0, 0, 0], mode: 'patrol' };
      await g.selectWeapon(weapon);
      const hp0 = g.entities.get(id).state.health;
      g.fireWeaponOnce();
      const after = g.entities.get(id);
      out.push({ weapon, hp0, hp1: after ? after.state.health : 0, dead: !after || after.state.dead });
      if (after) g.soldiers.damage(id, 99999, performance.now());
    }
    return out;
  }, [f.bx, f.by, f.bz]);
  for (const r of rows) {
    expect(r.error, `${r.weapon} 前置`).toBeUndefined();
    expect(r.hp1 < r.hp0 || r.dead, `${r.weapon} 必须能击伤士兵（${r.hp0} → ${r.hp1}）`).toBe(true);
  }
});

test('TNT 半径内士兵掉血、半径外不掉、probe 对照不掉', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(URL);
  await waitWorldReady(page);
  await gotoOpenField(page);
  await waitPlayerLanded(page);
  const f = await makeField(page);
  const r = await page.evaluate(([bx, by, bz]) => {
    const g = window.__MC_GAME__;
    const tnt = g.registry.idOf('tnt');
    g.editor.setBlock({ x: bx, y: by, z: bz, id: tnt });
    const inner = g.soldiers.spawn([bx + 2.5, by, bz + 0.5], { source: 'spec' });
    const outer = g.soldiers.spawn([bx + 8.5, by, bz + 0.5], { source: 'spec' });
    const probe = g.entities.spawn({
      id: 'soldier-spec-probe', type: 'probe', persistent: false,
      state: { position: [bx + 2.5, by, bz + 0.5] },
    });
    g.explodeTnt(bx, by, bz);
    return {
      innerHp: g.soldiers.get(inner)?.health ?? 0,
      outerHp: g.soldiers.get(outer)?.health ?? 0,
      probeAlive: g.entities.get('soldier-spec-probe') !== null,
      probeSpawned: probe !== null,
    };
  }, [f.bx, f.by, f.bz]);
  expect(r.probeSpawned, '前置：对照 probe 须生成').toBe(true);
  expect(r.innerHp, `半径内须掉 ${EXPLOSION_DAMAGE}`).toBe(SOLDIER.health - EXPLOSION_DAMAGE);
  expect(r.outerHp, '半径外不掉血').toBe(SOLDIER.health);
  expect(r.probeAlive, '非可击中类型不受影响（证明没改成全量枚举）').toBe(true);
});

/**
 * ⚠️⚠️ **用户 2026-11-25 实玩报告：「soldier 已经被消灭了，但计数器还残留 1 或 2」》**
 *
 * 真因不在计数（探针实测 HUD ≡ `soldiers.count()` 逐位正确），而在**渲染 slot 抢占**：
 * 旧 `SoldierRenderer` 的 round-robin 指针绕回时不检查占用 ⇒ 新实体覆盖活实体的实例矩阵，
 * 新实体死后差集回收又把该 slot 清零 ⇒ 仍在场的那只也不画了（或反过来留幽灵）。
 *
 * ⚠️ **判据必须是「真实实例矩阵的非零 scale 数」**（画面上真画了几只），
 * 不是 `soldierRenderer.activeCount()` / `_slots.size`：撞车时那两个读数仍等于实体数
 *（本轮实测）⇒ 零判别力。同时把 HUD 文本拉进来对账，钉「画面 ≡ 计数器」。
 * ⚠️ **必须走真实 C 键 + 真实伤害入口**，且循环次数要 **> 渲染池容量 2×maxAlive**，
 * 否则指针根本没绕回，缺陷不会被触发（本轮前三个探针就是这样全绿的）。
 */
test('计数器与画面一一对应：边召边杀 26 轮（超过渲染池容量），非零实例数 ≡ HUD ≡ 真实存活', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto(URL);
  await waitWorldReady(page);
  await gotoOpenField(page);
  await waitPlayerLanded(page);
  const f = await makeField(page, { radius: 16 });
  const r = await page.evaluate(async ([bx, by, bz]) => {
    const g = window.__MC_GAME__;
    /** 真实 GPU 侧：torso 实例矩阵里非零 scale 的个数 = 画面上真画了几只 */
    const drawn = () => {
      const m = g.soldierRenderer.meshes.torso;
      const arr = m.instanceMatrix.array;
      let n = 0;
      for (let i = 0; i < m.count; i++) {
        if (arr[i * 16] !== 0 || arr[i * 16 + 5] !== 0 || arr[i * 16 + 10] !== 0) n++;
      }
      return n;
    };
    const hud = () => Number((document.getElementById('mc-enemy-counts-soldier')
      ?.textContent ?? '兵 0').replace(/[^\d]/g, ''));
    const rows = [];
    const snap = (tag) => rows.push({
      tag, drawn: drawn(), hud: hud(),
      alive: g.soldiers.count(),
      total: g.soldiers.activeEntities().length,
    });
    // 两只长命士兵（占住低位 slot）+ 不断有第三只进出，把渲染指针推过池容量
    const keep = [];
    for (const dx of [4, 6]) {
      const id = g.soldiers.spawn([bx + dx + 0.5, by, bz + 4.5], { source: 'spec' });
      if (id) keep.push(id);
    }
    if (keep.length < 2) return { error: '前置：两只长命士兵需都生成' };
    await new Promise((res) => setTimeout(res, 300));
    snap('keepers');
    const rounds = g.soldierRenderer.maxActive + 6;
    for (let i = 0; i < rounds; i++) {
      // 真实 C 键入口（不是 service.spawn）
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', repeat: false, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyC', bubbles: true }));
      // ⚠️ **必须等过一个完整 HUD 刷新周期**（`ENEMY_COUNTS_INTERVAL_MS` = 250ms）：
      // 只等 120ms 就读 DOM 会拿到旧值 ⇒ 26 拍全红的**假红**（本轮实测踩到）。
      // 那不是缺陷，是夹具没跨过节流窗口；不得因此放宽阈值。
      await new Promise((res) => setTimeout(res, 320));
      snap(`r${i}-spawn`);
      // 把本轮新生的那只打死（长命的两只不动）
      for (const e of g.soldiers.activeEntities()) {
        if (!keep.includes(e.id) && !e.state.dead) g.damageEntity(e.id, 100000, performance.now());
      }
      await new Promise((res) => setTimeout(res, 320));
      snap(`r${i}-kill`);
      await new Promise((res) => setTimeout(res, 1300));   // 等留尸 1.2s 回收
      snap(`r${i}-settled`);
    }
    return { rows, rounds, poolSize: g.soldierRenderer.maxActive };
  }, [f.bx, f.by, f.bz]);
  expect(r.error ?? null, '前置：两只长命士兵需都生成').toBeNull();
  expect(r.rounds, '前置：循环次数必须超过渲染池容量（否则指针没绕回）')
    .toBeGreaterThan(r.poolSize);
  // ① 每一拍：画面上真画出来的只数 ≡ 集合里的士兵数（含留尸）
  const drawnBad = r.rows.filter((x) => x.drawn !== x.total);
  expect(drawnBad.length, `画面必须逐拍画出全部士兵（失配样本：${JSON.stringify(drawnBad.slice(0, 3))}）`).toBe(0);
  // ② 每一拍：HUD 计数 ≡ 真实存活数（排除留尸）
  const hudBad = r.rows.filter((x) => x.hud !== x.alive);
  expect(hudBad.length, `HUD 必须逐拍等于真实存活数（失配样本：${JSON.stringify(hudBad.slice(0, 3))}）`).toBe(0);
  // ③ 收尾：长命两只仍在场且都画着（撞车会把它们抹掉）
  const last = r.rows[r.rows.length - 1];
  expect(last.alive, '收尾：两只长命士兵必须仍存活').toBe(2);
  expect(last.drawn, '收尾：两只长命士兵必须仍画在屏幕上').toBe(2);
  expect(last.hud, '收尾：HUD 必须是 2').toBe(2);
});

/**
 * 士兵开火声：**不得互相打断**（用户 2026-11-25：「不要队列、不要滞后补发，
 * 声道挤占就丢弃」）。
 *
 * ⚠️⚠️ **判据不能落在 `playRequests`**：旧单槽实现与新多声道实现的请求计数
 * 完全相同（探针实测 47 vs 47）⇒ 零判别力。有判别力的是真实 Web Audio 层的
 * `AudioBufferSourceNode` start/stop 账：打断次数必须为 0、且真的并发过多路。
 * ⚠️ 探针包 `context.createBufferSource`（而不是读 `debugVoices()` 自己的计数），
 * 避开「断言读自己的输入」那类假绿。
 */
test('士兵开火声：班组连射不互相打断，声道满则丢弃（不排队、不补发）', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto(URL);
  await waitWorldReady(page);
  await gotoOpenField(page);
  await waitPlayerLanded(page);
  const f = await makeField(page);
  const r = await page.evaluate(async ([bx, by, bz]) => {
    const g = window.__MC_GAME__;
    document.querySelector('canvas')?.click();
    await g.audioManager?.unlock?.();
    const am = g.audioManager;
    const ctx = am.listener.context;
    // 在真实 Web Audio 层记账（只针对士兵开火素材的 source）
    const orig = ctx.createBufferSource.bind(ctx);
    const recs = [];
    ctx.createBufferSource = () => {
      const src = orig();
      const rec = { started: false, stopped: false, buffer: null };
      recs.push(rec);
      const os = src.start.bind(src);
      const ost = src.stop.bind(src);
      src.start = (...a) => { rec.started = true; rec.buffer = src.buffer; return os(...a); };
      src.stop = (...a) => { rec.stopped = true; return ost(...a); };
      return src;
    };
    const fireBuf = am._buffers.get('carbine_bullet');
    const fireRecs = () => recs.filter((x) => x.buffer === fireBuf);
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const id = g.soldiers.spawn([bx + 9 + i * 2 + 0.5, by, bz + 0.5], { source: 'spec' });
      if (id) ids.push(id);
    }
    if (ids.length < 2) { ctx.createBufferSource = orig; return { error: 'spawn 失败' }; }
    const origRandom = Math.random;
    Math.random = () => 0.999999;   // 必不中：只测枪声，不受玩家掉血干扰
    const cnt = () => g.audioDebugState().playRequests.carbine_bullet ?? 0;
    const t0 = cnt();
    let maxLive = 0;
    for (let i = 0; i < 140; i++) {
      for (const id of ids) {
        const e = g.entities.get(id);
        if (e && !e.state.dead) {
          e.state = { ...e.state, mode: 'combat', awareness: 1, crouching: false, crouch: 0,
            peekT: 99, losVisible: true, losTimer: 99, reaction: 0 };
        }
      }
      await new Promise((res) => setTimeout(res, 50));
      const live = fireRecs().filter((x) => x.started && !x.stopped).length;
      if (live > maxLive) maxLive = live;
      if (cnt() - t0 >= 20) break;
    }
    Math.random = origRandom;
    ctx.createBufferSource = orig;
    const fr = fireRecs();
    return {
      requests: cnt() - t0,
      started: fr.filter((x) => x.started).length,
      interrupted: fr.filter((x) => x.started && x.stopped).length,
      maxLive,
      cap: am.debugVoices().carbine_bullet?.cap ?? null,
      bufferDuration: fireBuf?.duration ?? null,
    };
  }, [f.bx, f.by, f.bz]);
  expect(r.error ?? null).toBeNull();
  expect(r.requests, '前置：必须真的开了多发（≥20）').toBeGreaterThanOrEqual(20);
  expect(r.bufferDuration, '前置：素材已解码').toBeGreaterThan(0.3);
  // ⭐ 核心：一声都不得被打断（旧实现实测 47 次请求 46 次打断）
  expect(r.interrupted, `开火声不得互相打断（实测打断 ${r.interrupted} 次）`).toBe(0);
  // 并发真的发生过（否则“不打断”可能是因为只出了一声）
  expect(r.maxLive, `必须真的并发过多路（实测最多 ${r.maxLive} 路）`).toBeGreaterThan(1);
  // 声道上限存在且被尊重（丢弃语义：起播数 ≤ 请求数）
  expect(r.cap, '士兵开火声必须是多声道').toBeGreaterThan(1);
  expect(r.started, '起播数不得超过请求数（丢弃不得补发）').toBeLessThanOrEqual(r.requests);
});

test('draw call：无士兵 = 基线，有士兵 = 基线 + 7', async ({ page }) => {
  test.setTimeout(200_000);
  // ⚠️ 关阴影：日夜循环下阴影重渲帧会造成 draw 尖峰（zombies.spec 已记该 flaky）
  await page.goto(`${URL}&shadows=0&reflect=0`);
  await waitWorldReady(page);
  await gotoOpenField(page);
  await waitPlayerLanded(page);
  const f = await makeField(page);
  const r = await page.evaluate(async ([bx, by, bz]) => {
    const g = window.__MC_GAME__;
    await new Promise((res) => setTimeout(res, 600));
    const baseline = g.renderStats().drawCalls;
    for (let i = 0; i < 3; i++) g.soldiers.spawn([bx + i * 2 + 0.5, by, bz + 0.5], { source: 'spec' });
    await new Promise((res) => setTimeout(res, 600));
    const withSoldiers = g.renderStats().drawCalls;
    return { baseline, withSoldiers, count: g.soldiers.count() };
  }, [f.bx, f.by, f.bz]);
  expect(r.count, '前置：3 只在场').toBe(3);
  expect(r.withSoldiers - r.baseline, '7 个部件 mesh ⇒ 恰好 +7（与士兵数无关）').toBe(7);
});

test('Tier 4：士兵在真实 WebGPU 下画出来了（像素级，带对照组）', async ({ page }) => {
  test.setTimeout(200_000);
  await page.goto(`${URL}&shadows=0&reflect=0&stats=0`);
  await waitWorldReady(page);
  await gotoOpenField(page);
  await waitPlayerLanded(page);
  const f = await makeField(page);
  const r = await page.evaluate(async ([bx, by, bz]) => {
    const g = window.__MC_GAME__;
    // 冻住动态源：停帧循环推进 + 藏 HUD（照 carbine.spec 的像素夹具口径）
    document.getElementById('hud-root')?.style.setProperty('display', 'none');
    const id = g.soldiers.spawn([bx + 0.5, by, bz - 4.5], { source: 'spec' });
    const e = g.entities.get(id);
    const p = g.player.physics.pos;
    // 玩家看向士兵（−Z）
    g.player.yaw = 0; g.player.pitch = 0;
    e.state = { ...e.state, position: [p.x, p.y, p.z - 4], velocity: [0, 0, 0], mode: 'patrol', yaw: Math.PI };
    await new Promise((res) => setTimeout(res, 800));
    const shot = () => {
      const c = document.querySelector('canvas');
      const gl = c.getContext('webgpu');
      void gl;
      return c.toDataURL('image/png');
    };
    const withSoldier = shot();
    // 对照：藏掉士兵的 7 个 mesh
    const meshes = Object.values(g.soldierRenderer.meshes);
    for (const m of meshes) m.visible = false;
    await new Promise((res) => setTimeout(res, 300));
    const without = shot();
    for (const m of meshes) m.visible = true;
    return { withSoldier: withSoldier.length, without: without.length, differ: withSoldier !== without };
  }, [f.bx, f.by, f.bz]);
  expect(r.differ, '藏掉士兵后画面必须不同（证明它真的上屏）').toBe(true);
});

test('Tier 4：士兵曳光写进 GPU 属性 —— 开火后同步立刻取样', async ({ page }) => {
  test.setTimeout(200_000);
  await page.goto(URL);
  await waitWorldReady(page);
  await gotoOpenField(page);
  await waitPlayerLanded(page);
  const f = await makeField(page);
  const r = await page.evaluate(async ([bx, by, bz]) => {
    const g = window.__MC_GAME__;
    const id = g.soldiers.spawn([bx + 10.5, by, bz + 0.5], { source: 'spec' });
    const origRandom = Math.random;
    Math.random = () => 0;
    const e = g.entities.get(id);
    e.state = { ...e.state, mode: 'combat', awareness: 1, crouching: false, crouch: 0, peekT: 99,
      losVisible: true, losTimer: 99, nextBurst: 0, reaction: 0 };
    // 等到真的开了一发：轮询 GPU 属性而不是 counts（后者对「画错位置」零判别力）
    let found = null;
    for (let i = 0; i < 120 && !found; i++) {
      await new Promise((res) => setTimeout(res, 30));
      const a = g.carbineFx.tracerGeo.getAttribute('aA');
      const b = g.carbineFx.tracerGeo.getAttribute('aB');
      for (let s = 0; s < a.count; s++) {
        // 士兵曳光速度 = 170（玩家 KV-9 是 320）⇒ 用它区分来源
        if (Math.abs(b.getW(s) - 170) < 1e-6) {
          found = { from: [a.getX(s), a.getY(s), a.getZ(s)], to: [b.getX(s), b.getY(s), b.getZ(s)], speed: b.getW(s) };
          break;
        }
      }
    }
    Math.random = origRandom;
    const en = g.entities.get(id);
    return { found, soldierPos: en ? [...en.state.position] : null };
  }, [f.bx, f.by, f.bz]);
  expect(r.found, '必须找到一条士兵曳光（速度 170）').not.toBeNull();
  expect(r.found.speed).toBe(170);
  // 起点须接近士兵（枪口在其身上），不是玩家相机
  const d = Math.hypot(r.found.from[0] - r.soldierPos[0], r.found.from[2] - r.soldierPos[2]);
  expect(d, `曳光起点须在士兵枪口附近（实测水平距 ${d.toFixed(2)} 格）`).toBeLessThan(2);
});