import { test, expect } from 'playwright/test';

/**
 * Boss 召唤（v2.43）+ 祭坛飞龙 真游戏页 E2E。
 *
 * ⚠️ **必须从玩家真实入口验证**（AGENTS.md M7 教训：只测 API 会漏「面板/武器没接线」）。
 * 召唤走**真实 C 键派发**（`window.dispatchEvent(new KeyboardEvent('keydown', {code:'KeyC'}))`，
 * 与 zombies.spec.mjs 同手法 —— keydown 监听挂在 window 上，不用 `page.keyboard.press`
 * 是因为它需要元素焦点），射击走 `setTestAim` + `fireWeaponOnce`（与右键同路径）。
 *
 * ⚠️ **v2.43 的语义变更**（本文件全部用例按新语义写）：
 * - 龙**不再自动生成**：走到高台地带天上没有龙，必须按 C 召唤；
 * - 龙**不再绑定祭坛地带**：玩家站在哪个高台地带，龙就在哪个地带的圆心盘旋；
 * - **永久死亡已移除**：打死后槽位清空，再按 C 会重新召唤（满血）；
 * - 实体 id 是**派生的**（`dragon:<mapKey>:<slot>`），不再是固定的 `dragon-altar`。
 *
 * ⚠️ **reload 类用例的导航监听必须在触发 reload 之前武装**（clear-save.spec.mjs:97 实测竞态）：
 * `waitForLoadState('load')` 写在 reload 之后会看到「当前页已是 load 态」立即返回 → 读到旧页。
 *
 * ⚠️ **seed 用 12345**（默认）：实测它的祭坛地带在 region(2,0)。
 */

const SEED = 12345;

async function waitWorldReady(page) {
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
}

/** 读祭坛地带中心（从 gen 层权威，不自己写一份「哪个地带」） */
async function altarCenter(page) {
  return page.evaluate(async () => {
    const { findAltarTarnRegion } = await import('/src/gen/structures/tarn-zone.js');
    const a = findAltarTarnRegion(window.__MC_GAME__.seed);
    return a ? { cx: a.cx, cz: a.cz, regionX: a.regionX, regionZ: a.regionZ } : null;
  });
}

/** 找一个**非祭坛**的高台地带（验证「龙不再绑定祭坛地带」） */
async function nonAltarTarnCenter(page) {
  return page.evaluate(async () => {
    const { isTarnZone, tarnZoneCenter, findAltarTarnRegion } = await import('/src/gen/structures/tarn-zone.js');
    const seed = window.__MC_GAME__.seed;
    const altar = findAltarTarnRegion(seed);
    for (let rx = -8; rx <= 8; rx++) {
      for (let rz = -8; rz <= 8; rz++) {
        if (altar && rx === altar.regionX && rz === altar.regionZ) continue;
        if (!isTarnZone(rx, rz, seed)) continue;
        const c = tarnZoneCenter(rx, rz);
        return { cx: c.cx, cz: c.cz, regionX: rx, regionZ: rz };
      }
    }
    return null;
  });
}

/** 把玩家挪到指定地图中心上空并等该 column 加载 */
async function gotoCenter(page, cx, cz) {
  await page.evaluate(([x, z]) => {
    window.__MC_GAME__._teleportTo(x, 40, z);   // 高空，避免埋进结构
  }, [cx, cz]);
  await page.waitForFunction(([x, z]) => {
    const g = window.__MC_GAME__;
    return g.world.hasColumn(Math.floor(x / 16), Math.floor(z / 16));
  }, [cx, cz], { timeout: 30_000 });
  return { cx, cz };
}

/** 按 C（真实键盘事件路径） */
async function pressC(page) {
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      code: 'KeyC', repeat: false, bubbles: true, cancelable: true,
    }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyC', bubbles: true, cancelable: true }));
  });
}

/** 等至少 n 条龙存在 */
async function waitDragonCount(page, n = 1, timeout = 15_000) {
  await page.waitForFunction(
    (want) => (window.__MC_GAME__.dragons?.activeEntities().length ?? 0) >= want,
    n, { timeout });
}

/** 当前 toast 文案（`#mc-toast` 淡出后 textContent 仍保留） */
async function toastText(page) {
  return page.evaluate(() => document.getElementById('mc-toast')?.textContent ?? '');
}

/** 读运行时冻结常量（⚠️ 不硬编码：改 config 时用例自动跟上） */
async function dragonConst(page, name) {
  return page.evaluate(async (k) => {
    const m = await import('/src/entities/dragons/dragon-config.js');
    return m[k];
  }, name);
}

/** 读 `DRAGON` 里的某个玩法数值 */
async function dragonValue(page, field) {
  return page.evaluate(async (k) => {
    const { DRAGON } = await import('/src/entities/dragons/dragon-config.js');
    return DRAGON[k];
  }, field);
}

test('Boss E2E: 高台地带按 C 召唤出龙（轨道中心 = 玩家所在地图中心）', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`/?vd=8&seed=${SEED}`);
  await waitWorldReady(page);
  const c = await altarCenter(page);
  expect(c).not.toBeNull();
  await gotoCenter(page, c.cx, c.cz);
  // ⚠️ **v2.43 的核心判据：不按 C 就没有龙**（自动生成已移除）
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => window.__MC_GAME__.dragons.activeEntities().length)).toBe(0);
  await pressC(page);
  await waitDragonCount(page, 1);
  const s = await page.evaluate(() => {
    const e = window.__MC_GAME__.dragons.activeEntities()[0];
    return {
      id: e.id, type: e.type, health: e.state.health, persistent: e.persistent,
      pos: [...e.state.position], orbit: { ...e.state.orbit },
    };
  });
  expect(s.type).toBe('dragon');
  expect(s.id).toBe(`dragon:tarn:${c.regionX}:${c.regionZ}:0`);   // 派生 id
  expect(s.health).toBe(await dragonValue(page, 'health'));
  expect(s.persistent).toBe(false);   // 临时实体（位置不进存档，红线 2）
  // 轨道中心 = 玩家所在地图中心
  expect(s.orbit.cx).toBe(c.cx);
  expect(s.orbit.cz).toBe(c.cz);
  // 位置在轨道上：水平距中心 = orbitRadius，y 在盘旋带内
  const R = await dragonValue(page, 'orbitRadius');
  const r = Math.hypot(s.pos[0] - c.cx, s.pos[2] - c.cz);
  expect(Math.abs(r - R)).toBeLessThan(1e-6);
  expect(s.pos[1]).toBeGreaterThan(26);
  expect(s.pos[1]).toBeLessThan(34);
  expect(await toastText(page)).toContain('已召唤 Boss1');
});

test('Boss E2E: 再按 C 提示「Boss 都在了」，不产生第二条', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`/?vd=8&seed=${SEED}`);
  await waitWorldReady(page);
  const c = await altarCenter(page);
  await gotoCenter(page, c.cx, c.cz);
  await pressC(page);
  await waitDragonCount(page, 1);
  await pressC(page);
  await page.waitForTimeout(500);
  // 高台地带名册只有 Boss1（用户：「目前还没有 Boss2」）⇒ 槽位已满
  expect(await page.evaluate(() => window.__MC_GAME__.dragons.activeEntities().length)).toBe(1);
  expect(await toastText(page)).toContain('Boss 都在了');
});

test('Boss E2E: 不在任何地标级地图内按 C → 提示且什么都不召唤', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`/?vd=8&seed=${SEED}`);
  await waitWorldReady(page);
  // 找一个「不在任何地标级地图内」的点（bossMapAt 返回 null）
  const spot = await page.evaluate(async () => {
    const { bossMapAt } = await import('/src/entities/bosses/boss-map.js');
    const seed = window.__MC_GAME__.seed;
    for (let x = -4000; x <= 4000; x += 37) {
      for (let z = -4000; z <= 4000; z += 37) {
        if (bossMapAt(x, z, seed) === null) return { x, z };
      }
    }
    return null;
  });
  expect(spot).not.toBeNull();
  await gotoCenter(page, spot.x, spot.z);
  await pressC(page);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__MC_GAME__.dragons.activeEntities().length)).toBe(0);
  expect(await toastText(page)).toContain('这里没有可召唤的 Boss');
});

test('Boss E2E: 非祭坛的高台地带也能召唤（龙不再绑定祭坛地带）', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`/?vd=8&seed=${SEED}`);
  await waitWorldReady(page);
  const c = await nonAltarTarnCenter(page);
  expect(c).not.toBeNull();
  await gotoCenter(page, c.cx, c.cz);
  await pressC(page);
  await waitDragonCount(page, 1);
  const s = await page.evaluate(() => {
    const e = window.__MC_GAME__.dragons.activeEntities()[0];
    return { id: e.id, cx: e.state.orbit.cx, cz: e.state.orbit.cz };
  });
  expect(s.id).toBe(`dragon:tarn:${c.regionX}:${c.regionZ}:0`);
  expect(s.cx).toBe(c.cx);
  expect(s.cz).toBe(c.cz);
});

test('Boss E2E: 用枪打龙会掉血并红闪（走真实武器路径）', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`/?vd=8&seed=${SEED}`);
  await waitWorldReady(page);
  const c = await altarCenter(page);
  await gotoCenter(page, c.cx, c.cz);
  await pressC(page);
  await waitDragonCount(page, 1);
  const result = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const e = g.dragons.activeEntities()[0];
    const before = e.state.health;
    // ⚠️ **玩家必须放在龙的正下方、且在神龛之外**：祭坛中心 7×7 是神龛（铁柱/绿宝/钻石，
    // 占 y=3..4），把玩家放圆心会让**眼睛所在格本身就是方块** → DDA 起点在方块内 →
    // `target.dist = 0` → `blockDist = 0`，而实体命中判据是 `hit.dist < blockDist`
    // （严格小于）→ 永远为假 → 打不中（实测血量纹丝不动）。
    // 龙在半径 24 的轨道上，广场半径 28 内地表恒 plateauY=2 → 脚底 y=3、眼高 4.62，
    // 头顶是空气（射线向上无方块命中 → blockDist = Infinity → 实体命中生效）。
    g.player.physics.pos.x = e.state.position[0];
    g.player.physics.pos.z = e.state.position[2];
    g.player.physics.pos.y = 3;
    g.player.physics.vel.x = g.player.physics.vel.y = g.player.physics.vel.z = 0;
    // ⚠️ **先选枪再瞄准**：`await selectWeapon` 会让出控制权、帧循环推进 → 龙以 6 格/秒移动。
    // 瞄准与开火之间不得有 await，否则瞄的是旧位置。
    await g.selectWeapon('pistol');
    // ⚠️ **瞄准方向必须从玩家新位置的眼点算**，不能读 `camera.position` ——
    // 相机在 `player.update()`（帧循环）里才跟随 physics.pos，此刻还是传送时的旧位置（y=40）。
    const eye = [g.player.physics.pos.x, g.player.physics.pos.y + 1.62, g.player.physics.pos.z];
    const dp = g.dragons.activeEntities()[0].state.position;
    g.player.setTestAim([dp[0] - eye[0], dp[1] - eye[1], dp[2] - eye[2]]);
    const effects = g.fireWeaponOnce();
    const after = g.dragons.activeEntities()[0]?.state.health ?? null;
    return {
      id: e.id, before, after,
      effectType: effects[0]?.type ?? null,
      entityId: effects[0]?.entityId ?? null,
      entityDamage: effects[0]?.entityDamage ?? null,
      flashedUntil: g.dragons.activeEntities()[0]?.state.flashedUntil ?? 0,
      now: performance.now(),
    };
  });
  // 命中：health 下降 25（手枪 entityDamage）
  expect(result.after).toBe(result.before - 25);
  expect(result.effectType).toBe('entity-hit');
  expect(result.entityId).toBe(result.id);
  expect(result.entityDamage).toBe(25);
  // 红闪：flashedUntil 与 performance.now() 同量级（不是 Date.now() 的天文数字）
  expect(result.flashedUntil).toBeGreaterThan(result.now);
  expect(result.flashedUntil).toBeLessThan(result.now + 1000);
});

test('Boss E2E: 打死后槽位清空，再按 C 重新召唤（永久死亡已移除）', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`/?vd=8&seed=${SEED}`);
  await waitWorldReady(page);
  const c = await altarCenter(page);
  await gotoCenter(page, c.cx, c.cz);
  await pressC(page);
  await waitDragonCount(page, 1);
  const firstId = await page.evaluate(() => window.__MC_GAME__.dragons.activeEntities()[0].id);
  // 打死（用 service.damage 加速，不走 120 发手枪）
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    g.dragons.damage(g.dragons.activeEntities()[0].id, 99999, performance.now());
  });
  expect(await page.evaluate(() => window.__MC_GAME__.dragons.activeEntities().length)).toBe(0);
  // ⚠️ **v2.43 的核心语义变更**：死后再按 C 会重新召唤（v2.41 是永久死亡）
  await pressC(page);
  await waitDragonCount(page, 1);
  const second = await page.evaluate(() => {
    const e = window.__MC_GAME__.dragons.activeEntities()[0];
    return { id: e.id, health: e.state.health };
  });
  expect(second.id).toBe(firstId);   // 复用同一派生 id（幂等，不攒第二条）
  expect(second.health).toBe(await dragonValue(page, 'health'));   // 满血
  // ⚠️ **存档里不得再有 dragonDead**（永久死亡标记已随本次改动移除）
  const meta = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    await g.persistence.flushNow(g.world);
    return g.persistence.loadMeta();
  });
  expect(meta?.dragonDead ?? null).toBeNull();
});

test('Boss E2E: 炮塔能索敌到龙（targets 接线 + bodyOffsetY=0）', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`/?vd=8&seed=${SEED}`);
  await waitWorldReady(page);
  const c = await altarCenter(page);
  await gotoCenter(page, c.cx, c.cz);
  await pressC(page);
  await waitDragonCount(page, 1);
  const dragonId = await page.evaluate(() => window.__MC_GAME__.dragons.activeEntities()[0].id);
  // 在祭坛广场放炮塔。⚠️ **不能放正中心**（神龛 7×7 占地 → place 以 'occupied' 拒）。
  // 偏移到广场半径 12 处（神龛外、广场半径 28 内），先探地表 y（从 y=40 向下扫第一个实心格）。
  const placed = await page.evaluate(([cx, cz]) => {
    const g = window.__MC_GAME__;
    const tx = cx + 12, tz = cz;
    let surfaceY = null;
    for (let y = 40; y > -30; y--) {
      if (g.world.getBlockId(tx, y, tz) !== 0) { surfaceY = y; break; }
    }
    if (surfaceY === null) return { ok: false, reason: 'no-surface' };
    return g.placeTurret([tx, surfaceY + 1, tz]);
  }, [c.cx, c.cz]);
  expect(placed.ok).toBe(true);
  // 等索敌周期（125ms）+ 目标重选（120ms）
  await page.waitForFunction((id) => {
    const g = window.__MC_GAME__;
    const cs = [...g.turrets.controllers().values()];
    return cs.length > 0 && cs[0].targetId === id;
  }, dragonId, { timeout: 10_000 });
  const t = await page.evaluate(() => {
    const cs = [...window.__MC_GAME__.turrets.controllers().values()];
    return { targetId: cs[0].targetId };
  });
  expect(t.targetId).toBe(dragonId);
});

test('Boss E2E: 玩家走远龙被回收，回来按 C 重新召唤（已知取舍）', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`/?vd=8&seed=${SEED}`);
  await waitWorldReady(page);
  const c = await altarCenter(page);
  await gotoCenter(page, c.cx, c.cz);
  await pressC(page);
  await waitDragonCount(page, 1);
  // 走远（2000 格外）→ 地带中心 column 出加载半径 → 卸载回收临时实体
  await page.evaluate(([cx, cz]) => {
    window.__MC_GAME__._teleportTo(cx + 2000, 40, cz + 2000);
  }, [c.cx, c.cz]);
  await page.waitForFunction(
    () => window.__MC_GAME__.dragons.activeEntities().length === 0, null, { timeout: 20_000 });
  // ⚠️ 用户 2026-11-03 接受的取舍：卸载也会清槽位，回来要重新按 C（不自动重生）
  await gotoCenter(page, c.cx, c.cz);
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => window.__MC_GAME__.dragons.activeEntities().length)).toBe(0);
  await pressC(page);
  await waitDragonCount(page, 1);
  const second = await page.evaluate(() => {
    const e = window.__MC_GAME__.dragons.activeEntities()[0];
    return { pos: [...e.state.position], health: e.state.health };
  });
  expect(second.health).toBe(await dragonValue(page, 'health'));
  const R = await dragonValue(page, 'orbitRadius');
  const r = Math.hypot(second.pos[0] - c.cx, second.pos[2] - c.cz);
  expect(Math.abs(r - R)).toBeLessThan(1e-6);
});

test('Boss E2E: reload 后龙不自动出现，按 C 重召且轨道参数逐位相同（persistent: false 的判据）', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`/?vd=8&seed=${SEED}`);
  await waitWorldReady(page);
  const c = await altarCenter(page);
  await gotoCenter(page, c.cx, c.cz);
  await pressC(page);
  await waitDragonCount(page, 1);
  const before = await page.evaluate(() => ({
    ...window.__MC_GAME__.dragons.activeEntities()[0].state.orbit,
  }));
  // ⚠️ 导航监听在 reload 之前武装
  const nav = page.waitForLoadState('load');
  await page.reload();
  await nav;
  await waitWorldReady(page);
  await gotoCenter(page, c.cx, c.cz);
  // ⚠️ **龙不进存档** ⇒ reload 后不会自动出现
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => window.__MC_GAME__.dragons.activeEntities().length)).toBe(0);
  await pressC(page);
  await waitDragonCount(page, 1);
  const after = await page.evaluate(() => ({
    ...window.__MC_GAME__.dragons.activeEntities()[0].state.orbit,
  }));
  // 轨道参数（cx/cz/y/radius/omega/phase）逐位相同 —— 位置是 seed 的纯函数，不依赖存档。
  // 若误传 persistent: true，reload 会读到存档里的旧位置（orbitT 不同 → 位置不同）。
  expect(after.cx).toBe(before.cx);
  expect(after.cz).toBe(before.cz);
  expect(after.y).toBe(before.y);
  expect(after.radius).toBe(before.radius);
  expect(after.phase).toBe(before.phase);
});

test('Boss E2E: 换 seed 后按 C 仍能召唤（无残留状态）', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`/?vd=8&seed=${SEED}`);
  await waitWorldReady(page);
  const c = await altarCenter(page);
  await gotoCenter(page, c.cx, c.cz);
  await pressC(page);
  await waitDragonCount(page, 1);
  // 打死
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    g.dragons.damage(g.dragons.activeEntities()[0].id, 99999, performance.now());
  });
  // ⚠️ 导航监听必须在 newWorld（触发 location.assign）之前武装
  const nav = page.waitForLoadState('load');
  await page.evaluate(() => window.__MC_GAME__.newWorld(null));   // 随机新 seed
  await nav;
  await waitWorldReady(page);
  const c2 = await altarCenter(page);
  expect(c2).not.toBeNull();
  await gotoCenter(page, c2.cx, c2.cz);
  await pressC(page);
  await waitDragonCount(page, 1);
  expect(await page.evaluate(() => window.__MC_GAME__.dragons.activeEntities().length)).toBe(1);
});
