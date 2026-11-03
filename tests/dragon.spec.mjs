import { test, expect } from 'playwright/test';

/**
 * 祭坛飞龙（v2.41）真游戏页 E2E。
 *
 * ⚠️ **必须从玩家真实入口验证**（AGENTS.md M7 教训：只测 API 会漏「面板/武器没接线」）。
 * 射击走 `setTestAim` + `fireWeaponOnce`（与右键同路径），不直接调 `dragons.damage()`。
 *
 * ⚠️ **reload 类用例的导航监听必须在触发 reload 之前武装**（clear-save.spec.mjs:97 实测竞态）：
 * `waitForLoadState('load')` 写在 reload 之后会看到「当前页已是 load 态」立即返回 → 读到旧页。
 *
 * ⚠️ **seed 用 12345**（默认）：实测它的祭坛地带在 region(2,0)，`findAltarTarnRegion` 非 null。
 * 龙在祭坛中心 (cx,cz) 半径 24 的轨道、y≈30 盘旋。
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
    return a ? { cx: a.cx, cz: a.cz } : null;
  });
}

/** 把玩家挪到祭坛中心上空并等该 column 加载（龙 spawn 的门控） */
async function gotoAltar(page) {
  const c = await altarCenter(page);
  expect(c).not.toBeNull();
  await page.evaluate(([cx, cz]) => {
    const g = window.__MC_GAME__;
    g._teleportTo(cx, 40, cz);   // 高空，避免埋进结构
  }, [c.cx, c.cz]);
  await page.waitForFunction(([cx, cz]) => {
    const g = window.__MC_GAME__;
    return g.world.hasColumn(Math.floor(cx / 16), Math.floor(cz / 16));
  }, [c.cx, c.cz], { timeout: 30_000 });
  return c;
}

/** 等龙 spawn（ensure 在帧循环里跑，column 就绪后下一帧出现） */
async function waitDragon(page, timeout = 15_000) {
  await page.waitForFunction(() => window.__MC_GAME__.dragons?.active() !== null, null, { timeout });
}

test('龙 E2E: 传送到祭坛地带后天上有一条龙（位置在轨道上）', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`/?vd=8&seed=${SEED}`);
  await waitWorldReady(page);
  const c = await gotoAltar(page);
  await waitDragon(page);
  const s = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const e = g.dragons.active();
    return {
      type: e.type, health: e.state.health, persistent: e.persistent,
      pos: [...e.state.position], orbit: { ...e.state.orbit },
    };
  });
  expect(s.type).toBe('dragon');
  // ⚠️ 血量从**运行时 config** 读，不硬编码（改 DRAGON.health 时本用例自动跟上）
  const hp = await page.evaluate(async () => {
    const { DRAGON } = await import('/src/entities/dragons/dragon-config.js');
    return DRAGON.health;
  });
  expect(s.health).toBe(hp);
  expect(s.persistent).toBe(false);   // 临时实体（位置不进存档，红线 2）
  // 轨道中心 = 祭坛地带中心（与「高台」按钮同源）
  expect(s.orbit.cx).toBe(c.cx);
  expect(s.orbit.cz).toBe(c.cz);
  // 位置在轨道上：水平距中心 = 24，y 在 30±1.5
  const r = Math.hypot(s.pos[0] - c.cx, s.pos[2] - c.cz);
  expect(Math.abs(r - 24)).toBeLessThan(1e-6);
  expect(s.pos[1]).toBeGreaterThan(26);
  expect(s.pos[1]).toBeLessThan(34);
});

test('龙 E2E: 用枪打龙会掉血并红闪（走真实武器路径）', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`/?vd=8&seed=${SEED}`);
  await waitWorldReady(page);
  const c = await gotoAltar(page);
  await waitDragon(page);
  const result = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const e = g.dragons.active();
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
    // 从旧相机算方向 → setTestAim 把相机摆到新位置却用旧方向 → 射线打偏（实测 health 不掉）。
    const eye = [g.player.physics.pos.x, g.player.physics.pos.y + 1.62, g.player.physics.pos.z];
    const dp = g.dragons.active().state.position;
    g.player.setTestAim([dp[0] - eye[0], dp[1] - eye[1], dp[2] - eye[2]]);
    const effects = g.fireWeaponOnce();
    const after = g.dragons.active()?.state.health ?? null;
    return {
      before, after,
      effectType: effects[0]?.type ?? null,
      entityId: effects[0]?.entityId ?? null,
      entityDamage: effects[0]?.entityDamage ?? null,
      flashedUntil: g.dragons.active()?.state.flashedUntil ?? 0,
      now: performance.now(),
    };
  });
  // 命中：health 下降 25（手枪 entityDamage）
  expect(result.after).toBe(result.before - 25);
  expect(result.effectType).toBe('entity-hit');
  expect(result.entityId).toBe('dragon-altar');
  expect(result.entityDamage).toBe(25);
  // 红闪：flashedUntil 与 performance.now() 同量级（不是 Date.now() 的天文数字）
  expect(result.flashedUntil).toBeGreaterThan(result.now);
  expect(result.flashedUntil).toBeLessThan(result.now + 1000);
});

test('龙 E2E: 打到死后实体消失且 dragonDead 落库，刷新页面不复活（永久死亡）', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`/?vd=8&seed=${SEED}`);
  await waitWorldReady(page);
  await gotoAltar(page);
  await waitDragon(page);
  // 打死（用 service.damage 加速，不走 12 发手枪）
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    g.dragons.damage(g.dragons.active().id, 9999, performance.now());
  });
  const dead = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    await g.persistence.flushNow(g.world);   // 确保 dragonDead 落库
    const meta = await g.persistence.loadMeta();
    return {
      active: g.dragons.active(),
      isDead: g.dragons.isDead(),
      dragonDead: meta?.dragonDead ?? null,
    };
  });
  expect(dead.active).toBeNull();
  expect(dead.isDead).toBe(true);
  expect(dead.dragonDead).toBe(true);
  // 再 ensure 也不复活
  await page.evaluate(() => window.__MC_GAME__.dragons.ensure());
  expect(await page.evaluate(() => window.__MC_GAME__.dragons.active())).toBeNull();

  // ⚠️ 导航监听必须在 reload 之前武装（clear-save.spec.mjs:97 竞态）
  const nav = page.waitForLoadState('load');
  await page.reload();
  await nav;
  await waitWorldReady(page);
  await gotoAltar(page);
  // 等一会儿确认不 spawn（ensure 每帧跑，若会复活早就出现了）
  await page.waitForTimeout(2000);
  expect(await page.evaluate(() => window.__MC_GAME__.dragons.active())).toBeNull();
  expect(await page.evaluate(() => window.__MC_GAME__.dragons.isDead())).toBe(true);
});

test('龙 E2E: 炮塔能索敌到龙（targets 接线 + bodyOffsetY=0）', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`/?vd=8&seed=${SEED}`);
  await waitWorldReady(page);
  const c = await gotoAltar(page);
  await waitDragon(page);
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
    // 炮塔 origin = 地表方块之上那一格（脚底）
    return g.placeTurret([tx, surfaceY + 1, tz]);
  }, [c.cx, c.cz]);
  expect(placed.ok).toBe(true);
  // 等索敌周期（125ms）+ 目标重选（120ms）
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const cs = [...g.turrets.controllers().values()];
    return cs.length > 0 && cs[0].targetId === 'dragon-altar';
  }, null, { timeout: 10_000 });
  const t = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const cs = [...g.turrets.controllers().values()];
    return { targetId: cs[0].targetId, hasTarget: cs[0].targetId !== null };
  });
  expect(t.targetId).toBe('dragon-altar');
  expect(t.hasTarget).toBe(true);
});

test('龙 E2E: 玩家走远再回来，龙重生（column 卸载回收后 ensure 复活）', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`/?vd=8&seed=${SEED}`);
  await waitWorldReady(page);
  const c = await gotoAltar(page);
  await waitDragon(page);
  const firstPos = await page.evaluate(() => [...window.__MC_GAME__.dragons.active().state.position]);
  // 走远（2000 格外）→ 祭坛 column 出加载半径 → 卸载回收临时实体
  await page.evaluate(([cx, cz]) => {
    const g = window.__MC_GAME__;
    g._teleportTo(cx + 2000, 40, cz + 2000);
  }, [c.cx, c.cz]);
  await page.waitForFunction(() => window.__MC_GAME__.dragons.active() === null, null, { timeout: 20_000 });
  expect(await page.evaluate(() => window.__MC_GAME__.dragons.isDead())).toBe(false);   // 回收 ≠ 死亡
  // 回来 → 重生
  await gotoAltar(page);
  await waitDragon(page);
  const second = await page.evaluate(() => {
    const e = window.__MC_GAME__.dragons.active();
    return { pos: [...e.state.position], health: e.state.health };
  });
  // 重生后满血（已知取舍，spec §5.2）
  const hp2 = await page.evaluate(async () => {
    const { DRAGON } = await import('/src/entities/dragons/dragon-config.js');
    return DRAGON.health;
  });
  expect(second.health).toBe(hp2);
  // 位置仍在轨道上（纯函数重算）
  const r = Math.hypot(second.pos[0] - c.cx, second.pos[2] - c.cz);
  expect(Math.abs(r - 24)).toBeLessThan(1e-6);
});

test('龙 E2E: 换 seed 后龙恢复（死亡标记随世界作废）', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`/?vd=8&seed=${SEED}`);
  await waitWorldReady(page);
  await gotoAltar(page);
  await waitDragon(page);
  // 打死
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    g.dragons.damage(g.dragons.active().id, 9999, performance.now());
  });
  expect(await page.evaluate(() => window.__MC_GAME__.dragons.isDead())).toBe(true);
  // ⚠️ 导航监听必须在 newWorld（触发 location.assign）之前武装
  const nav = page.waitForLoadState('load');
  await page.evaluate(() => window.__MC_GAME__.newWorld(null));   // 随机新 seed
  await nav;
  await waitWorldReady(page);
  // 新 seed 的祭坛地带重新生成 → 龙恢复（saveMeta 整行 put 不含 dragonDead → 自然作废）
  await gotoAltar(page);
  await waitDragon(page);
  expect(await page.evaluate(() => window.__MC_GAME__.dragons.isDead())).toBe(false);
  expect(await page.evaluate(() => window.__MC_GAME__.dragons.active() !== null)).toBe(true);
});

test('龙 E2E: reload 后龙的位置仍是纯函数派生（persistent: false 的判据）', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`/?vd=8&seed=${SEED}`);
  await waitWorldReady(page);
  await gotoAltar(page);
  await waitDragon(page);
  const before = await page.evaluate(() => {
    const e = window.__MC_GAME__.dragons.active();
    return { orbit: { ...e.state.orbit } };
  });
  // ⚠️ 导航监听在 reload 之前武装
  const nav = page.waitForLoadState('load');
  await page.reload();
  await nav;
  await waitWorldReady(page);
  await gotoAltar(page);
  await waitDragon(page);
  const after = await page.evaluate(() => {
    const e = window.__MC_GAME__.dragons.active();
    return { orbit: { ...e.state.orbit } };
  });
  // 轨道参数（cx/cz/y/radius/omega/phase）逐位相同 —— 位置是 seed 的纯函数，
  // 不依赖存档。若误传 persistent: true，reload 会读到存档里的旧位置（orbitT 不同 → 位置不同）。
  expect(after.orbit.cx).toBe(before.orbit.cx);
  expect(after.orbit.cz).toBe(before.orbit.cz);
  expect(after.orbit.y).toBe(before.orbit.y);
  expect(after.orbit.radius).toBe(before.orbit.radius);
  expect(after.orbit.phase).toBe(before.orbit.phase);
});
