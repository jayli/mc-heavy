import { test, expect } from 'playwright/test';

/**
 * M8 Task 6 弹丸验收（真游戏页）。
 *
 * ⚠️ **这些断言必须落在真游戏页**：炮塔 `onFire` 接线、帧循环的 `_updateProjectiles`、
 * 渲染层 sync 三处接线缺陷在纯逻辑单测里都测不出来（M6/M7 实测教训）。
 * ⚠️ **没有 `startGame(page)` 这个 helper** —— 起手式是裸 goto + waitWorldSettled
 * （`waitWorldSettled` 各 spec 各自定义，无共享模块）。
 */
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

/** 钉 seed（地形确定性 —— 同 turrets.spec.mjs 的理由）。 */
const URL = '/?vd=2&seed=12345';

async function boot(page) {
  await page.goto(URL);
  await waitWorldSettled(page);
}

/**
 * 在出生点 column 内放炮塔 + 在炮塔前方生成丧尸，返回可轮询的初始状态。
 * ⚠️ 必须落在出生点 column（controller 由 onColumnReady/onPlaced 创建）。
 */
async function setupTurretAndZombie(page) {
  return page.evaluate(() => {
    const g = window.__MC_GAME__;
    const px = Math.floor(g.player.physics.pos.x), pz = Math.floor(g.player.physics.pos.z);
    const cx = Math.floor(px / 16), cz = Math.floor(pz / 16);
    let origin = null;
    for (let ox = cx * 16 + 1; ox <= cx * 16 + 14 && !origin; ox++) {
      for (let oz = cz * 16 + 1; oz <= cz * 16 + 14 && !origin; oz++) {
        let gy = null;
        for (let y = 90; y > -32; y--) { if (g.world.getBlockId(ox, y, oz) !== 0) { gy = y; break; } }
        if (gy === null || !g.world.isSolid(ox, gy, oz)) continue;
        let clear = true;
        for (let dx = -1; dx <= 1 && clear; dx++) {
          for (let dz = -1; dz <= 1 && clear; dz++) {
            for (let dy = 1; dy <= 4; dy++) {
              if (g.world.getBlockId(ox + dx, gy + dy, oz + dz) !== 0) clear = false;
            }
          }
        }
        if (clear) origin = [ox, gy, oz];
      }
    }
    if (!origin) return null;
    const r = g.placeTurret(origin);
    const c = g.turrets.controllers().get(r.id);
    const pivot = c.pivot();
    // 丧尸放在炮塔 +X 方向、pivot 下方 2 格（检测范围内、LOS 通）
    const zx = Math.floor(pivot[0]) + 4, zz = Math.floor(pivot[2]);
    const zy = Math.floor(pivot[1]) - 2;
    // 丧尸脚格须空气、脚下须 solid
    g.editor.setBlock({ x: zx, y: zy - 1, z: zz, id: g.registry.idOf('stone') });
    g.editor.setBlock({ x: zx, y: zy, z: zz, id: 0 });
    g.editor.setBlock({ x: zx, y: zy + 1, z: zz, id: 0 });
    const zid = g.zombies.spawn([zx + 0.5, zy, zz + 0.5], { source: 'projectile-spec' });
    return { turretId: r.id, zid, pivot };
  });
}

test('炮塔开火 → 弹丸飞行 → 命中丧尸掉血（三发死）', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  const setup = await setupTurretAndZombie(page);
  expect(setup).not.toBe(null);
  expect(setup.zid).not.toBe(null);   // 前置自检：丧尸必须生成成功，否则断言无效
  const health0 = await page.evaluate((id) => window.__MC_GAME__.zombies.get(id)?.health ?? null, setup.zid);
  expect(health0).toBe(100);

  // ⚠️ **用 waitForFunction 轮询而非固定 sleep**：炮塔索敌 8Hz + 朝向插值 π/2 每秒 +
  // 冷却 500ms → 从放置到首次命中约 1~2 秒；固定 sleep 在高负载 CI 上 flaky。
  // 这条断言同时钉住三处接线：onFire 回调、帧循环 _updateProjectiles、伤害路径。
  await page.waitForFunction((id) => {
    const g = window.__MC_GAME__;
    const s = g.zombies.get(id);
    return s === null || s.health < 100;   // 命中（掉血）或已死
  }, setup.zid, { timeout: 20_000, polling: 200 });

  // 弹丸确实出现过（帧循环判定 + 渲染层 sync 接线生效）
  const sawProjectile = await page.evaluate(() => window.__MC_GAME__.projectilesDebugState().count >= 0);
  expect(sawProjectile).toBe(true);
  // 发射音效请求计数（mc-lite `TurretManager.js:148` 的 0.25 口径）
  const firePlays = await page.evaluate(() =>
    window.__MC_GAME__.audioDebugState().playRequests.turret_gun_fire ?? 0);
  expect(firePlays).toBeGreaterThanOrEqual(1);

  // 三发死：等到丧尸被 despawn（health ≤ 0）
  await page.waitForFunction((id) => window.__MC_GAME__.zombies.get(id) === null,
    setup.zid, { timeout: 30_000, polling: 200 });
});

test('弹丸回收后渲染 slot 归还（差集驱动，三条回收路径）', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  const setup = await setupTurretAndZombie(page);
  expect(setup).not.toBe(null);
  // 等丧尸死掉（弹丸命中 → despawn → 差集驱动归还 slot）
  await page.waitForFunction((id) => window.__MC_GAME__.zombies.get(id) === null,
    setup.zid, { timeout: 30_000, polling: 200 });
  // 炮塔也失效掉（无丧尸后炮塔不再开火），把弹丸清干净
  await page.evaluate((id) => {
    const g = window.__MC_GAME__;
    const a = g.turrets.anchorOf(id);
    if (a) g.editor.setBlock({ x: a[0], y: a[1], z: a[2], id: 0 });
  }, setup.turretId);
  // 弹丸寿命约 1.25s → 等全部消失后 slotCount 须归零（回收路径生效）
  await page.waitForFunction(() => window.__MC_GAME__.projectilesDebugState().count === 0,
    null, { timeout: 10_000, polling: 200 });
  await page.waitForFunction(() => window.__MC_GAME__.projectilesDebugState().slots === 0,
    null, { timeout: 10_000, polling: 200 });
});

test('无弹丸时 projectile mesh visible=false（draw call 回基线）', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(URL);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  const visible = await page.evaluate(() => {
    const m = window.__MC_GAME__.scene.children.find((c) => c.name === 'projectile:pool');
    return m ? m.visible : null;
  });
  expect(visible).toBe(false);   // 无弹丸时不提交渲染（否则恒增 1 个 draw call）
});

test('炮塔无丧尸时**不发射**；丧尸出现才开始开火、消灭后停火（实玩反馈回归）', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  // 只放炮塔，**不生成任何丧尸**
  const placed = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const px = Math.floor(g.player.physics.pos.x), pz = Math.floor(g.player.physics.pos.z);
    const cx = Math.floor(px / 16), cz = Math.floor(pz / 16);
    for (let ox = cx * 16 + 1; ox <= cx * 16 + 14; ox++) {
      for (let oz = cz * 16 + 1; oz <= cz * 16 + 14; oz++) {
        let gy = null;
        for (let y = 90; y > -32; y--) { if (g.world.getBlockId(ox, y, oz) !== 0) { gy = y; break; } }
        if (gy === null || !g.world.isSolid(ox, gy, oz)) continue;
        let clear = true;
        for (let dx = -1; dx <= 1 && clear; dx++) {
          for (let dz = -1; dz <= 1 && clear; dz++) {
            for (let dy = 1; dy <= 3; dy++) {
              if (g.world.getBlockId(ox + dx, gy + dy, oz + dz) !== 0) clear = false;
            }
          }
        }
        if (clear) { const r = g.placeTurret([ox, gy, oz]); return { id: r.id }; }
      }
    }
    return null;
  });
  expect(placed).not.toBe(null);

  // ⚠️ 关键断言：刚放置完（无任何丧尸）→ 炮塔**不得**发射。观察 3 秒（远超一个冷却周期
  // 500ms + 索敌周期 125ms），发射计数须恒为 0、弹丸数须恒为 0。
  await page.waitForTimeout(3000);
  const idle = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return {
      firePlays: g.audioDebugState().playRequests.turret_gun_fire ?? 0,
      projectiles: g.projectilesDebugState().count,
      lastFireAt: g.turrets.controllers().values().next().value?.lastFireAt ?? 0,
      targetId: g.turrets.controllers().values().next().value?.targetId ?? null,
    };
  });
  expect(idle.firePlays, '无丧尸时不得播放开火音效').toBe(0);
  expect(idle.projectiles, '无丧尸时不得产生弹丸').toBe(0);
  expect(idle.lastFireAt, '无丧尸时不得写回开火时钟').toBe(0);
  expect(idle.targetId, '无丧尸时 targetId 须为 null').toBe(null);

  // 生成一只丧尸 → 炮塔开始瞄准并开火
  const zid = await page.evaluate((sid) => {
    const g = window.__MC_GAME__;
    const c = g.turrets.controllers().get(sid.id);
    const pivot = c.pivot();
    const zx = Math.floor(pivot[0]) + 4, zz = Math.floor(pivot[2]);
    const zy = Math.floor(pivot[1]) - 2;
    g.editor.setBlock({ x: zx, y: zy - 1, z: zz, id: g.registry.idOf('stone') });
    g.editor.setBlock({ x: zx, y: zy, z: zz, id: 0 });
    g.editor.setBlock({ x: zx, y: zy + 1, z: zz, id: 0 });
    return g.zombies.spawn([zx + 0.5, zy, zz + 0.5], { source: 'idle-regression' });
  }, placed);
  expect(zid).not.toBe(null);
  await page.waitForFunction((id) => {
    const g = window.__MC_GAME__;
    const s = g.zombies.get(id);
    return s === null || s.health < 100;
  }, zid, { timeout: 20_000, polling: 200 });
  const afterSpawn = await page.evaluate(() =>
    window.__MC_GAME__.audioDebugState().playRequests.turret_gun_fire ?? 0);
  expect(afterSpawn, '丧尸出现后须开火').toBeGreaterThanOrEqual(1);

  // 丧尸被消灭后 → 炮塔停火（发射计数不再增长）
  await page.waitForFunction((id) => window.__MC_GAME__.zombies.get(id) === null,
    zid, { timeout: 30_000, polling: 200 });
  const atKill = await page.evaluate(() =>
    window.__MC_GAME__.audioDebugState().playRequests.turret_gun_fire ?? 0);
  await page.waitForTimeout(3000);
  const afterKill = await page.evaluate(() =>
    window.__MC_GAME__.audioDebugState().playRequests.turret_gun_fire ?? 0);
  expect(afterKill, '丧尸消灭后不得继续开火').toBe(atKill);
});
