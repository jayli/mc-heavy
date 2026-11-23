import { test, expect } from 'playwright/test';
import { ENEMY_ROSTER } from './enemy-roster.mjs';

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
async function summonFor(page, type) {
  const cfg = ENEMY_ROSTER[type];
  if (type === 'zombie') {
    await gotoOpenField(page);
    await waitPlayerLanded(page);
    const id = await page.evaluate(() => {
      const g = window.__MC_GAME__;
      const before = new Set(g.zombies.activeEntities().map((e) => e.id));
      g.spawnZombieNearPlayer();
      const added = g.zombies.activeEntities().filter((e) => !before.has(e.id));
      return added[0]?.id ?? null;
    });
    expect(id, 'zombie 前置：spawnZombieNearPlayer 必须造出一只').not.toBeNull();
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
