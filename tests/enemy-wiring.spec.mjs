import { test, expect } from 'playwright/test';
import { ENEMY_ROSTER, headTopOffset, bodyCenterOffset, blastEdgeRadius } from './enemy-roster.mjs';

/**
 * 敌人/Boss **接线完整性门**（方案 2）。
 *
 * 设计稿：docs/superpowers/specs/2026-11-23-enemy-wiring-completeness-gate-design.md
 *
 * ## 为何需要它（现有 spec 盖不到新类型）
 *
 * 实测：`boss-audio.spec.mjs` 共 10 个 test，**9 个标题写死了具体 Boss 名**
 *（「焰魔：挥刀播…」「末影守卫：枪击中播…」）⇒ 加一个新 Boss，那 9 个用例
 * 一个都不会覆盖它。而每加一个类型要在既有文件里插 15 处，其中 **7 处漏改是静默失效**
 *（死亡无声无爆散 / 数字飘胸口 / 溅射偏半个身高 / Boss 曲不响 / 起手音不响 /
 * 炮塔不打它 / 玩家停在身体盒内）—— git 里有它们真实发生过的记录。
 *
 * 本门遍历名册逐项验真实 `window.__MC_GAME__` 的接线，**不改任何生产代码**。
 *
 * ⚠️ **召唤一律走真实入口**（Boss 按 KeyB、丧尸走 spawnZombieNearPlayer）：
 * 直接调 service.summon 会漏掉「名册没登记 / service 没装配 / 地图判定不对」
 * 这类接线缺陷（guardian.spec.mjs 文件头教训）。
 */

const SEED = 12345;

/** 等世界就绪（照 guardian.spec.mjs:28） */
async function waitWorldReady(page) {
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
}

/** 把玩家挪到远离城市的开阔地（照 boss-audio.spec.mjs:51） */
async function gotoOpenField(page, { offsetX = 600, offsetZ = 600 } = {}) {
  await page.evaluate(async ([ox, oz]) => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    g._teleportTo(Math.floor(p.x) + ox, 45, Math.floor(p.z) + oz);
    await new Promise((r) => setTimeout(r, 2500));   // 等 column 加载 + 落地
  }, [offsetX, offsetZ]);
}

/** 把玩家放到指定位置并清零速度（照 guardian.spec.mjs:97；y 给脚底） */
async function putPlayer(page, x, y, z) {
  await page.evaluate(([px, py, pz]) => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    p.x = px; p.y = py; p.z = pz;
    g.player.physics.vel.x = g.player.physics.vel.y = g.player.physics.vel.z = 0;
  }, [x, y, z]);
}

/** 派真实 KeyB（照 guardian.spec.mjs:77） */
async function pressB(page) {
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      code: 'KeyB', repeat: false, bubbles: true, cancelable: true,
    }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyB', bubbles: true, cancelable: true }));
  });
}

test.describe.configure({ mode: 'serial' });

/**
 * 等玩家停止下坠。
 *
 * ⚠️ **不用 `isSolid(y-0.5)`**（ignis.spec.mjs:52 的写法）—— 实测它在 gotoOpenField
 * 落点恒假：玩家稳定 y=4.000、onGround=true、vy=0，而脚下 y=3 是 air、y=2 是 leaves。
 * `isSolid` 读 solidTable（leaves=0，cutout 语义），而玩家站立走 `supportsPlayer`
 *（另一张表）⇒ 两套语义。本 helper 要答的是「停止下坠了没有」，**物理 onGround 就是该事实的权威**。
 */
async function waitPlayerLanded(page) {
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    if (!g?.player?.physics) return false;
    const ph = g.player.physics;
    return ph.onGround === true && Math.abs(ph.vel.y) < 1e-6;
  }, null, { timeout: 30_000 });
  await page.waitForTimeout(400);
}

/** 等某列加载（照 guardian.spec.mjs:52） */
async function waitColumn(page, wx, wz, timeout = 180_000) {
  await page.waitForFunction(([x, z]) => {
    const g = window.__MC_GAME__;
    return g.world.hasColumn(Math.floor(x / 16), Math.floor(z / 16));
  }, [wx, wz], { timeout });
  await page.waitForTimeout(800);
}

/**
 * 按类型造出一个实体，**走真实入口**。
 *
 * ⚠️ **不得直接调 `service.summon()`** —— 那会漏掉「名册没登记 / service 没装配 /
 * 地图判定不对」这类接线缺陷（guardian.spec.mjs 与 ignis.spec.mjs 文件头同教训）。
 *
 * ⚠️ **地图约束是硬的**（`bossMapAt`）：
 *   · dragon / ignis —— 只在**祭坛高台地带**（TARN）。名册 slot 0=龙、1=焰魔
 *     ⇒ **召焰魔需按两次 B**（用户裁定「飞龙先，焰魔后」）。
 *   · guardian —— 只在**废弃堡垒**（或围场）占地内，且需站在甲板上（floorY+1）。
 *   · zombie —— `spawnZombieNearPlayer()`（与巢穴刷怪同一条路径）。
 *
 * @returns {Promise<{id: string, baseY: number}>} baseY = 该类型 state.position 的 y
 *   （⚠️ **不叫 feetY**：龙的 position 已是体心，字段名不得暗示单一种语义 —— ledger R1）
 */
async function summonFor(page, type, opts = {}) {
  const cfg = ENEMY_ROSTER[type];
  if (type === 'zombie') {
    await gotoOpenField(page, opts);
    await waitPlayerLanded(page);
    const id = await page.evaluate(() => {
      const g = window.__MC_GAME__;
      const before = new Set(g.zombies.activeEntities().map((e) => e.id));
      g.spawnZombieNearPlayer();
      const added = g.zombies.activeEntities().filter((e) => !before.has(e.id));
      return added[0]?.id ?? null;
    });
    expect(id, 'zombie 前置：spawnZombieNearPlayer 必须造出一只').not.toBeNull();
    /**
     * ⚠️ **必须等丧尸自己站稳**（flaky 真根因，探针实测）：spawn 后它仍在下坠/step-up，
     * y 可能是 0 或 -1。在它站稳前取 y 做 LOS 前置与钉位 ⇒ 钉在「脚底埋进地面」的高度，
     * 炮口到该点的视线被地面挡 ⇒ hasTarget 恒 false（直接调纯函数亦如此）。
     * Boss 分支早已等 onGround（guardian.spec:170 教训），丧尸分支原先漏了这一步。
     */
    await page.waitForFunction((i) => {
      const e = window.__MC_GAME__.entities.get(i);
      if (!e) return false;
      const y = e.state.position[1];
      const w = window.__Z_Y_HIST__ ?? (window.__Z_Y_HIST__ = []);
      w.push(y);
      if (w.length > 3) w.shift();
      // ⚠️ 判「y 连续 3 次不变」而非 onGround：丧尸 AI 每帧移动，走下台阶时
      // onGround 反复置 false（zombie-system.js:214）⇒ 那个标志不是「脚底已定」的可靠判据。
      return w.length === 3 && w.every((v) => v === w[0]);
    }, id, { timeout: 30_000, polling: 150 });
    await page.evaluate(() => { window.__Z_Y_HIST__ = []; });
    const baseY = await page.evaluate((i) => window.__MC_GAME__.entities.get(i).state.position[1], id);
    return { id, baseY };
  }
  if (type === 'dragon' || type === 'ignis') {
    const c = await page.evaluate(async () => {
      const { findAltarTarnRegion } = await import('/src/gen/structures/tarn-zone.js');
      const g = window.__MC_GAME__;
      const a = findAltarTarnRegion(g.seed);
      if (!a) return null;
      g.player.spawn(a.cx, 40, a.cz);
      return { cx: a.cx, cz: a.cz };
    });
    expect(c, `前置：seed ${SEED} 必须有祭坛地带`).not.toBeNull();
    await waitColumn(page, c.cx, c.cz);
    await waitPlayerLanded(page);
    // slot 0 = 龙；slot 1 = 焰魔 ⇒ 焰魔需第二次 summonBoss
    const presses = type === 'dragon' ? 1 : 2;
    for (let i = 0; i < presses; i++) {
      await pressB(page);
      await page.waitForTimeout(600);
    }
    await page.waitForFunction(([svc]) => {
      const g = window.__MC_GAME__;
      return g[svc].activeEntities().length >= 1;
    }, [cfg.service], { timeout: 30_000 });
    // 等物理真的站稳（guardian.spec.mjs:170 教训：召唤当帧还没跑重力积分）
    await page.waitForFunction(([svc]) => {
      const e = window.__MC_GAME__[svc].activeEntities()[0];
      return e?.state.onGround === true;
    }, [cfg.service], { timeout: 30_000 }).catch(() => {
      // 龙是飞行实体，永远不 onGround ⇒ 只对地面实体等
      if (type !== 'dragon') throw new Error(`${type} 未在 30s 内落地`);
    });
    return page.evaluate(([svc]) => {
      const e = window.__MC_GAME__[svc].activeEntities()[0];
      return { id: e.id, baseY: e.state.position[1] };
    }, [cfg.service]);
  }
  if (type === 'guardian') {
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
    expect(a, `前置：seed ${SEED} 必须有废弃堡垒`).not.toBeNull();
    // 玩家站甲板（floorY+1）：不传 summonY 时 _findGroundY 取「离玩家最近」的可站面
    await putPlayer(page, a.wx + 0.5, a.floorY + 1, a.wz + 0.5);
    await waitColumn(page, a.wx + a.dx, a.wz + a.dz);
    await pressB(page);
    await page.waitForFunction(
      () => window.__MC_GAME__.guardians.activeEntities().length === 1,
      null, { timeout: 30_000 });
    await page.waitForFunction(
      () => window.__MC_GAME__.guardians.activeEntities()[0]?.state.onGround === true,
      null, { timeout: 15_000 });
    return page.evaluate(() => {
      const e = window.__MC_GAME__.guardians.activeEntities()[0];
      return { id: e.id, baseY: e.state.position[1] };
    });
  }
  if (type === 'soldier') {
    // 士兵 Epic：走真实入口 spawnSoldierNearPlayer（与丧尸同手法，不直接调 service.spawn）
    await gotoOpenField(page, opts);
    await waitPlayerLanded(page);
    const id = await page.evaluate(() => {
      const g = window.__MC_GAME__;
      const before = new Set(g.soldiers.activeEntities().map((e) => e.id));
      g.spawnSoldierNearPlayer();
      const added = g.soldiers.activeEntities().filter((e) => !before.has(e.id));
      return added[0]?.id ?? null;
    });
    expect(id, 'soldier 前置：spawnSoldierNearPlayer 必须造出一名').not.toBeNull();
    // 等它自己站稳（照丧尸分支：y 连续 3 次不变，不用 onGround）
    await page.waitForFunction((i) => {
      const e = window.__MC_GAME__.entities.get(i);
      if (!e) return false;
      const w = window.__S_Y_HIST__ ?? (window.__S_Y_HIST__ = []);
      w.push(e.state.position[1]);
      if (w.length > 3) w.shift();
      return w.length === 3 && w.every((v) => v === w[0]);
    }, id, { timeout: 30_000, polling: 150 });
    await page.evaluate(() => { window.__S_Y_HIST__ = []; });
    const baseY = await page.evaluate((i) => window.__MC_GAME__.entities.get(i).state.position[1], id);
    return { id, baseY };
  }
  throw new Error(`summonFor: 未支持的类型 ${type}`);
}

test('双向钉住：名册 ↔ entities 已注册的可击中类型集合相等', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=2&seed=12345');
  await waitWorldReady(page);
  const gap = await page.evaluate(async () => {
    const { WEAPON_HITTABLE_TYPES } = await import('/src/entities/entity-types.js');
    const { ENEMY_ROSTER } = await import('/tests/enemy-roster.mjs');
    const registered = WEAPON_HITTABLE_TYPES;
    const inRoster = Object.keys(ENEMY_ROSTER);
    const g = window.__MC_GAME__;
    return {
      missingInRoster: registered.filter((t) => !inRoster.includes(t)),
      danglingInRoster: inRoster.filter((t) => !registered.includes(t)),
      unwired: inRoster.filter((t) => !g[ENEMY_ROSTER[t].service]),
    };
  });
  expect(gap.missingInRoster, '可击中类型漏登记进名册 ⇒ 门会静默跳过它').toEqual([]);
  expect(gap.danglingInRoster, '名册登记了不可击中的类型（死登记）').toEqual([]);
  expect(gap.unwired, 'service 未装配 ⇒ 逐项断言会静默跳过').toEqual([]);
});
test('伤害/击退/受击音/死亡音与爆散：逐类型接线', async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto(`/?vd=2&seed=${SEED}`);
  await waitWorldReady(page);
  const rows = [];
  for (const type of Object.keys(ENEMY_ROSTER)) {
    const s = await summonFor(page, type);
    const r = await page.evaluate(async ([t, id]) => {
      const { ENEMY_ROSTER } = await import('/tests/enemy-roster.mjs');
      const cfg = ENEMY_ROSTER[t];
      const g = window.__MC_GAME__;
      const now = () => performance.now();
      const cnt = (k) => g.audioDebugState().playRequests[k] ?? 0;
      const before = g.entities.get(id);
      if (!before) return { error: '实体不存在' };
      const hp0 = before.state.health;
      const pos0 = [...before.state.position];
      // ① 非致死伤害 → damage 契约 + hit 音（只在 !dead 时播）
      const hitBefore = cfg.hitSound ? cnt(cfg.hitSound) : 0;
      const dmg = g.damageEntity(id, 1, now());
      const hitAfter = cfg.hitSound ? cnt(cfg.hitSound) : 0;
      // ② 击退（权威位移瞬时）
      const kbOk = g.knockbackEntity(id, 0.4);
      const pos1 = g.entities.get(id) ? [...g.entities.get(id).state.position] : null;
      const kbDist = pos1 ? Math.hypot(pos1[0] - pos0[0], pos1[2] - pos0[2]) : 0;
      // ③ 致死 → death 音 + 爆散（取样前 reset 清掉既有碎块）
      g.blockHitFx.reset();
      const debris0 = g.blockHitFx.activeDebrisCount;
      const deathBefore = cnt(cfg.deathSound);
      const kill = g.damageEntity(id, 99999, now());
      const deathAfter = cnt(cfg.deathSound);
      const debris1 = g.blockHitFx.activeDebrisCount;
      return {
        hp0, dmgNull: dmg === null, hpAfterHit: dmg?.health ?? null,
        hitDelta: hitAfter - hitBefore,
        kbOk, kbDist,
        killDead: kill?.dead === true,
        deathDelta: deathAfter - deathBefore,
        debrisDelta: debris1 - debris0,
      };
    }, [type, s.id]);
    rows.push({ type, ...r });
  }
  for (const r of rows) {
    const cfg = ENEMY_ROSTER[r.type];
    expect(r.error, `${r.type} 前置：实体必须存在`).toBeUndefined();
    expect(r.dmgNull, `${r.type} damageEntity 必须路由到 service（不得返回 null）`).toBe(false);
    expect(r.hpAfterHit, `${r.type} 非致死伤害必须扣 1 血`).toBe(r.hp0 - 1);
    expect(r.kbDist, `${r.type} 击退必须真的位移`).toBeGreaterThan(0);
    if (cfg.hitSound) {
      expect(r.hitDelta, `${r.type} 非致死命中必须播 ${cfg.hitSound}`).toBeGreaterThanOrEqual(1);
    }
    expect(r.killDead, `${r.type} 致死伤害必须 dead`).toBe(true);
    expect(r.deathDelta, `${r.type} 死亡必须播 ${cfg.deathSound}`).toBeGreaterThanOrEqual(1);
    if (cfg.burst) {
      expect(r.debrisDelta, `${r.type} 死亡必须爆散碎块`).toBeGreaterThan(0);
    } else {
      expect(r.debrisDelta, `${r.type} 刻意不做爆散（不是遗漏）`).toBe(0);
    }
  }
});

/**
 * 头顶数字锚点：`_emitDamageNumber` 的 headY 三元链是否覆盖该类型。
 *
 * ⚠️ **必须多等几帧**（health-hud.spec.mjs:273）：`update()` 逐帧用 `anchor()` 覆盖
 * `lastPos`，首帧的 `initial` 不算数 —— 只读首帧抓不到「anchor 漏分支」，而那正是本项要防的缺陷。
 *
 * ⚠️ **期望值用 `headTopOffset`（已按 semantics 分派）**，不额外减 height：
 * 龙的 position 已是体心，offset 实为 offsetFromCenter。
 */
test('头顶锚点：逐类型 = 派生的 headTopOffset', async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto(`/?vd=2&seed=${SEED}`);
  await waitWorldReady(page);
  const rows = [];
  for (const type of Object.keys(ENEMY_ROSTER)) {
    const s = await summonFor(page, type);
    const r = await page.evaluate(async ([t, id, baseY]) => {
      const g = window.__MC_GAME__;
      g._damageNumbers.reset?.();
      g.damageEntity(id, 1, performance.now());
      // 多等几帧让 anchor() 覆盖 lastPos（首帧 initial 不算数）
      await new Promise((res) => setTimeout(res, 400));
      const e = g.entities.get(id);
      const nowY = e ? e.state.position[1] : baseY;
      const slots = g._damageNumbers._slots.filter((x) => x.active && x.entityId === id)
        .map((x) => ({ offset: x.lastPos[1] - nowY }));
      return { slots, nowY };
    }, [type, s.id, s.baseY]);
    rows.push({ type, ...r });
  }
  for (const r of rows) {
    const want = headTopOffset(r.type);
    expect(r.slots.length, `${r.type} 受击后头顶应恰有一个数字`).toBe(1);
    expect(Math.abs(r.slots[0].offset - want),
      `${r.type} 锚点应在 position.y + ${want}，实测 + ${r.slots[0].offset.toFixed(4)}`)
      .toBeLessThan(1e-6);
  }
});

/**
 * 溅射判定中心：`_cinderBlast` 的 half 三元链是否覆盖该类型。
 *
 * ⚠️⚠️ **边界几何是判别力的全部来源**（spec §7.2，设计期实测）：
 * 朴素写法（爆心放实体正上方 h/2）对三个脚底类型**全部零判别力** ——
 * 漏改时 dist = h/2 = 0.9 / 1.625 / 1.9，全都仍在 blastRadius=4 内 ⇒ 漏改也扣血。
 *
 * 正解：爆心放在**水平距离 r = blastEdgeRadius(type)、垂直高度 = 实体真实中心**：
 *   · 正确实现 dist = r ≤ 4     ⇒ 扣血
 *   · 漏改（half 落 0）dist = hypot(r, h/2) > 4 ⇒ 不扣血
 *
 * ⚠️ **坐标口径**：`_cinderBlast` 用 `const [cx,cy,cz] = at`，**不加 0.5**
 * （TNT 的 `_damageEntitiesInRadius` 才 +0.5）。搬错引入 0.5 格误差，
 * 而 zombie 的 r 区间只有 0.103 格宽 ⇒ 判据翻转。
 *
 * ⚠️ **只遍历 feet 语义**：龙是体心（half 本就 0），漏改与正确一致 ⇒ 无判别力，
 * **刻意排除，不是遗漏**。
 *
 * ⚠️ **实体必须静止**：AI 每帧在动 ⇒ 取样前冻住 entities.update，否则 r 精度失守。
 */
test('溅射中心：边界几何下逐 feet 类型必须扣血', async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto(`/?vd=2&seed=${SEED}`);
  await waitWorldReady(page);
  const feetTypes = Object.keys(ENEMY_ROSTER)
    .filter((t) => ENEMY_ROSTER[t].semantics === 'feet');
  const rows = [];
  for (const type of feetTypes) {
    const s = await summonFor(page, type);
    const r = await page.evaluate(async ([t, id]) => {
      const { ENEMY_ROSTER, bodyCenterOffset, blastEdgeRadius } = await import('/tests/enemy-roster.mjs');
      const g = window.__MC_GAME__;
      // 冻住 AI/物理推进：r 的判别区间最窄只有 0.103 格，实体动一点就失守
      const origUpdate = g.entities.update.bind(g.entities);
      g.entities.update = () => {};
      const e = g.entities.get(id);
      const [ex, ey, ez] = e.state.position;
      const c = bodyCenterOffset(t);
      const rr = blastEdgeRadius(t);
      const hp0 = e.state.health;
      // 爆心：水平 +rr（沿 +X）、垂直 = 实体真实中心 ey + c
      const at = [ex + rr, ey + c, ez];
      g._cinderBlast(at, 'block', null, performance.now(), [0, 1, 0]);
      const after = g.entities.get(id);
      const hp1 = after ? after.state.health : 0;
      g.entities.update = origUpdate;
      return { hp0, hp1, rr, c, distCorrect: rr, distIfMissing: Math.hypot(rr, c) };
    }, [type, s.id]);
    rows.push({ type, ...r });
  }
  for (const r of rows) {
    // 前置：几何本身必须有判别力（否则这条 test 是恒真的）
    expect(r.distCorrect, `${r.type} 正确实现的 dist 必须 ≤ 4`).toBeLessThanOrEqual(4);
    expect(r.distIfMissing, `${r.type} 漏改时 dist 必须 > 4`).toBeGreaterThan(4);
    // 主判据：正确实现下必须扣血
    expect(r.hp1, `${r.type} 边界几何下溅射必须命中（half 三元链漏该类型则不扣血）`)
      .toBeLessThan(r.hp0);
  }
});

/** 手势解锁音频 + 等普通 BGM 起播（照 boss-audio.spec.mjs:76） */
async function unlockAudio(page) {
  await page.locator('#app-canvas').click({ position: { x: 200, y: 200 } });
  await page.waitForFunction(
    () => window.__MC_GAME__.audioManager.debugMusicState().playing === true,
    null, { timeout: 60_000 });
}

/**
 * Boss 战 BGM：`bossAlive` 求和是否覆盖该类型。
 *
 * ⚠️ **`boss` 字段的判别力**：丧尸在场**不得**拉起 Boss 曲（`bossAlive` 只求和三 Boss）。
 * 合并循环时若遍历全表，丧尸会把战斗曲拉起来 = 玩法变更。
 */
test('Boss BGM：逐 boss 类型召唤后 wanted=true，丧尸不触发', async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto(`/?vd=2&seed=${SEED}`);
  await waitWorldReady(page);
  await unlockAudio(page);
  // ① 只有丧尸：boss.wanted 必须仍为 false
  await summonFor(page, 'zombie');
  await page.waitForTimeout(600);
  const zombieOnly = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return { wanted: g.audioManager.debugMusicState().boss.wanted, zombies: g.zombies.activeEntities().length };
  });
  expect(zombieOnly.zombies, '前置：丧尸必须在场').toBeGreaterThan(0);
  expect(zombieOnly.wanted, '丧尸在场不得拉起 Boss 曲（boss 字段的判别力）').toBe(false);
  // ② 逐 boss 类型：召唤后 wanted 必须为 true
  for (const type of Object.keys(ENEMY_ROSTER).filter((t) => ENEMY_ROSTER[t].boss)) {
    await summonFor(page, type);
    await page.waitForTimeout(600);
    const wanted = await page.evaluate(() => window.__MC_GAME__.audioManager.debugMusicState().boss.wanted);
    expect(wanted, `${type} 在场必须拉起 Boss 曲（bossAlive 漏该类型则恒 false）`).toBe(true);
  }
});

/**
 * 玩家阻挡：`physics._collides` 是否覆盖该类型的身体盒。
 *
 * ⚠️ **漏这一行的形态**（physics.js:364 注释记录的实测）：`_collides()` 返回 false 而
 * `overlapsAabb()` 返回 true ⇒ 玩家走进身体盒，然后被 `_ejectFromBoss` 每帧往外推一点、
 * 下一步又走回来 ⇒ 净效果是「停在盒内 0.12 格深处」而不是盒外。
 *
 * ⚠️ 只对 `blocksPlayer: true` 的类型（丧尸不阻挡是实测现状）。
 */
test('玩家阻挡：逐 blocksPlayer 类型 _collides 必须为真', async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto(`/?vd=2&seed=${SEED}`);
  await waitWorldReady(page);
  const types = Object.keys(ENEMY_ROSTER).filter((t) => ENEMY_ROSTER[t].blocksPlayer);
  expect(types.length, '前置：至少焰魔与守卫阻挡玩家').toBeGreaterThanOrEqual(2);
  const rows = [];
  for (const type of types) {
    const s = await summonFor(page, type);
    const r = await page.evaluate(([id]) => {
      const g = window.__MC_GAME__;
      const origUpdate = g.entities.update.bind(g.entities);
      g.entities.update = () => {};
      const e = g.entities.get(id);
      const [ex, ey, ez] = e.state.position;
      const ph = g.player.physics;
      const save = { x: ph.pos.x, y: ph.pos.y, z: ph.pos.z };
      // ⚠️ **`_collides(includeSupportsPlayer)` 不收坐标**，它读 `this.pos`
      // ⇒ 必须真的把玩家盒挪到实体脚底同格（盒必然重叠）。
      ph.pos.x = ex; ph.pos.y = ey; ph.pos.z = ez;
      ph.vel.x = ph.vel.y = ph.vel.z = 0;
      const inside = ph._collides();
      // 对照：远处同高一点不得因实体而碰撞（排除「地形本身就实心」的假绿）
      ph.pos.x = ex + 40; ph.pos.z = ez + 40;
      const far = ph._collides();
      ph.pos.x = save.x; ph.pos.y = save.y; ph.pos.z = save.z;
      g.entities.update = origUpdate;
      return { inside, far };
    }, [s.id]);
    rows.push({ type, ...r });
  }
  for (const r of rows) {
    expect(r.inside, `${r.type} 玩家盒重叠时 _collides 必须为真（漏该行则玩家走进身体）`).toBe(true);
    /**
     * 对照：远处同高不得因**实体**而碰撞 —— 排除「地形本身就实心」的假绿。
     * ⚠️ 远处可能踩到真实地形，故只要求「不是两处都碰撞」：
     * 若 inside 与 far 同时为真，无法区分「实体阻挡」与「地形阻挡」⇒ 判据失去判别力。
     */
    expect(r.far, `${r.type} 远处对照点不得也碰撞（否则无法区分实体阻挡与地形阻挡）`).toBe(false);
  }
});

/**
 * 起手音：`_syncBossAudio` 的逐类型循环是否覆盖该类型。
 *
 * ⚠️ **必须先等 mode 稳定在非 attack 再注入**（boss-audio.spec.mjs:188 实测踩到）：
 * 迁移检测条件是 `old.mode !== 'attack' && mode === 'attack'`，若注入时已在 attack 态
 * 则条件不成立 ⇒ 永不播音 ⇒ 超时（那是注入时机问题，不是缺陷）。
 *
 * ⚠️ **焰魔按招分音**（`ignisAttackSound(attackKind)`）⇒ 注入 `attackKind:'swing'`
 * 并断言该招对应的音，不写死「任一 attack 音」（那会让「播错招的音」也通过）。
 */
test('起手音：逐 boss 类型 attack 起手必须播对应音', async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto(`/?vd=2&seed=${SEED}`);
  await waitWorldReady(page);
  await unlockAudio(page);
  // 各类型的起手音（从生产权威读，不写字面量）
  const soundOf = await page.evaluate(async () => {
    const { ignisAttackSound } = await import('/src/render/audio-config.js');
    return { ignis: ignisAttackSound('swing'), guardian: 'guardian_attack' };
  });
  for (const type of ['ignis', 'guardian']) {
    const s = await summonFor(page, type);
    await page.waitForFunction((id) => {
      const st = window.__MC_GAME__.entities.get(id)?.state;
      return !!st && st.mode !== 'attack';
    }, s.id, { timeout: 60_000 });
    const sound = soundOf[type];
    const base = await page.evaluate((k) => window.__MC_GAME__.audioDebugState().playRequests[k] ?? 0, sound);
    /**
     * ⚠️ **先把玩家挪到实体近旁**（实测必需）：守卫的 attack 分支要求
     * `losVisible && hDist <= disengageRange`（guardian-boss-agent.js:192），否则 Agent
     * 第一帧就把注入的 attack 覆写成 chase ⇒ 迁移检测窗口错过 ⇒ 超时。
     * 焰魔无此门，但同口径处理使夹具一致。
     */
    await page.evaluate((id) => {
      const g = window.__MC_GAME__;
      const e = g.entities.get(id);
      if (!e) return;
      const [ex, ey, ez] = e.state.position;
      const p = g.player.physics.pos;
      p.x = ex; p.y = ey; p.z = ez - 3;
      g.player.physics.vel.x = g.player.physics.vel.y = g.player.physics.vel.z = 0;
    }, s.id);
    await page.waitForTimeout(500);
    await page.evaluate((id) => {
      const g = window.__MC_GAME__;
      const e = g.entities.get(id);
      if (e) e.state = { ...e.state, mode: 'attack', attackKind: 'swing', attackAnimT: 0, velocity: [0, 0, 0] };
    }, s.id);
    await page.waitForFunction(([k, b]) =>
      (window.__MC_GAME__.audioDebugState().playRequests[k] ?? 0) > b,
      [sound, base], { timeout: 30_000 });
    const after = await page.evaluate((k) => window.__MC_GAME__.audioDebugState().playRequests[k] ?? 0, sound);
    expect(after, `${type} attack 起手必须播 ${sound}（_syncBossAudio 漏该类型则恒不播）`)
      .toBeGreaterThan(base);
  }
});

/**
 * 炮塔索敌：`_runTurretAi` 的手写清单是否覆盖该类型。
 *
 * ⚠️ **这是已确认的第二份权威**（game.js:4402 注释原文）：
 * 「光加 `WEAPON_HITTABLE_TYPES` 不够 —— 那张表只管能不能被打中，炮塔索敌是本处这份独立清单」。
 * 漏一处的形态是「武器能打它、炮塔不打它」，数值全绿。
 *
 * ⚠️ 炮塔要放在**开阔地玩家附近**（与实体同 column 区域），且实体须在 detectionRange=50 内。
 * ⚠️ AI 是 8Hz（aiPeriodMs=125）⇒ 至少等 300ms 让它跑过一拍。
 */
test('炮塔索敌：逐可击中类型必须被锁定为 targetId', async ({ page }) => {
  test.setTimeout(900_000);
  await page.goto(`/?vd=2&seed=${SEED}`);
  await waitWorldReady(page);
  const rows = [];
  let fieldIdx = 0;
  for (const type of Object.keys(ENEMY_ROSTER)) {
    /**
     * ⚠️ **每类型用不同场地**（实测必需）：四类共用同一 page，前一类型放的炮塔仍占格
     * ⇒ 同落点会报 `placeTurret 失败: occupied`（前置失败，不是判据失败）。
     */
    const s = await summonFor(page, type, { offsetX: 600 + fieldIdx * 80, offsetZ: 600 });
    fieldIdx += 1;
    const r = await page.evaluate(async ([t, id]) => {
      const { hasLineOfSight: los } = await import('/src/entities/turrets/turret-system.js');
      const g = window.__MC_GAME__;
      const e = g.entities.get(id);
      if (!e) return { error: '实体不存在' };
      const [ex, ey, ez] = e.state.position;
      // 在实体附近找合法炮塔 origin。
      // ⚠️ **用生产权威 `blueprint.changesAt` 逐格自检**，不自写净空几何：
      // service 的 occupied 判据是「蓝图全部 11 格必须为空气或植物」（turret-service.js:92），
      // 自写「中心列 3 格净空」是第二份假设 ⇒ 3×3 底座踩到地形即 occupied（实测踩到）。
      let origin = null;
      const bp = g.turrets.blueprint;
      for (let d = 4; d <= 16 && !origin; d++) {
        for (const [dx, dz] of [[d, 0], [-d, 0], [0, d], [0, -d], [d, d], [-d, -d]]) {
          const ox = Math.floor(ex) + dx, oz = Math.floor(ez) + dz;
          let groundY = null;
          // ⚠️ **一路向下扫到世界底**：龙在 y=30 盘旋而地表在 y≈2，
          // 只在 ey±few 的窄带找地面会扫不到（实测踩到）。
          for (let y = Math.floor(ey) + 2; y > -32; y--) {
            if (g.world.getBlockId(ox, y, oz) !== 0) { groundY = y; break; }
          }
          if (groundY === null || !g.world.isSolid(ox, groundY, oz)) continue;
          const base = [ox, groundY, oz];
          if (!bp.inWorldBounds(base)) continue;
          const changes = bp.changesAt(base);
          const free = changes.every((c) => {
            if (!g.world.hasColumn(Math.floor(c.x / 16), Math.floor(c.z / 16))) return false;
            const bid = g.world.getBlockId(c.x, c.y, c.z);
            return bid === 0 || g.registry.isPlant(bid);
          });
          if (!free) continue;
          /**
           * ⚠️ **LOS 前置**（实测必需）：索敌要求视线通（turret-system.js:42）。
           * 守卫在堡垒地下房间（y=-7），炮塔若建在地表（y=3.3）则被地层挡 ⇒ 锁不到
           * 是**正确行为**，不是漏接线。故候选必须自身满足 LOS，否则测的是 LOS 而非清单。
           */
          const pivot = [ox + 0.5, groundY + 4.3, oz + 0.5];
          const aimY = ey + (t === 'dragon' ? 0 : 1.2);
          /**
           * ⚠️ **要求 LOS 有余量，不接受擦边通过**（flaky 根因，探针实测）：
           * LOS 采样步长 0.5 格，而实体物理每帧仍改 position（清 velocity 不阻重力/step-up，
           * 实测漂移 0.19~0.24 格）⇒ 擦边候选会随漂移翻转 LOS ⇒ 单跑偶过、负载下必失败。
           * 故要求 ±0.4 格四向扰动下 LOS 仍通（> 实测最大漂移）。
           */
          const MARGIN = 0.4;
          const robust = [[0, 0], [MARGIN, 0], [-MARGIN, 0], [0, MARGIN], [0, -MARGIN]]
            .every(([mx, mz]) => los({
              world: g.world, registry: g.registry, from: pivot,
              to: [ex + mx, aimY, ez + mz],
            }));
          if (!robust) continue;
          origin = base; break;
        }
      }
      if (!origin) return { error: '找不到合法炮塔 origin' };
      const placed = g.placeTurret(origin);
      if (!placed?.ok) return { error: `placeTurret 失败: ${placed?.reason ?? 'unknown'}` };
      // ⚠️ **不得冻住 entities.update**（实测踩到）：那会同时停掉索敌依赖的实体推进链路
      // ⇒ targetId 恒 null。改为等 1200ms 让 8Hz AI 跑约 9 拍；
      // detectionRange=50 vs 1.2s 内实体移动约 2 格，余量充足。
      /**
       * ⚠️ **钉住目标位置**（实测必需）：LOS 前置用的是造出时的位置，而丧尸 1.2s 内
       * 走 3+ 格 ⇒ 锁定时刻视线已变。只钉这一个实体（每 200ms 复位），
       * **不停 entities.update** —— 索敌链路必须照常跑。
       */
      const pin = [ex, ey, ez];
      for (let i = 0; i < 6; i++) {
        const en = g.entities.get(id);
        if (en) en.state = { ...en.state, position: [...pin], velocity: [0, 0, 0] };
        await new Promise((res) => setTimeout(res, 200));
      }
      const targets = [...g.turrets.controllers().values()].map((c) => c.targetId);
      return { targets, origin, id };
    }, [type, s.id]);
    rows.push({ type, ...r });
  }
  for (const r of rows) {
    expect(r.error, `${r.type} 前置`).toBeUndefined();
    expect(r.targets, `${r.type} 必须被某炮塔锁定为 targetId（_runTurretAi 手写清单漏该类型则永不锁定）`)
      .toContain(r.id);
  }
});
