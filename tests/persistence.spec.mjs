import { test, expect } from 'playwright/test';

test('最小存档：放块 → 重启 → 修改保留（§7 M1 验收）', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?vd=2');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 60_000 });

  // 1. 在玩家旁放一块石头并立即 flush（坐标相对出生点，出生点由城市布局决定）
  const placed = await page.evaluate(async () => {
    const game = window.__MC_GAME__;
    const px = Math.floor(game.player.physics.pos.x) + 2;
    const pz = Math.floor(game.player.physics.pos.z) + 2;
    let groundY = -1;
    for (let y = 90; y > -32; y--) { if (game.world.getBlockId(px, y, pz) !== 0) { groundY = y; break; } }
    const stoneId = game.registry.idOf('stone');
    const r = game.world.setBlock(px, groundY + 1, pz, stoneId);
    game.scheduler.remeshSections(r.affected, { fastPath: true });
    await game.persistence.flushNow(game.world);
    return { x: px, y: groundY + 1, z: pz, stoneId };
  });

  // 2. 整页刷新（模拟重启）
  await page.reload();
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 60_000 });
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    return g.world.hasColumn(Math.floor(g.spawnX / 16), Math.floor(g.spawnZ / 16));
  }, null, { timeout: 30_000 });

  // 3. 验证修改保留
  const restored = await page.evaluate(({ x, y, z, stoneId }) => {
    return window.__MC_GAME__.world.getBlockId(x, y, z) === stoneId;
  }, placed);
  expect(restored).toBe(true);
});

test('存档隔离：未修改的 column 不写 edits', async ({ page }) => {
  await page.goto('/?vd=2');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 60_000 });
  const count = await page.evaluate(async () => {
    const game = window.__MC_GAME__;
    await game.persistence.flushNow(game.world);
    return game.persistence.countSavedColumns();
  });
  // 首次进入无修改：edits store 应为 0（Playwright 每 test 新 context，IndexedDB 隔离）
  expect(count).toBe(0);
});

// ==================== 重启恢复玩家位置（v2.29，用户 2026-10-31） ====================
//
// 用户报告：「游戏重新进入后永远出生在 City 的中央」—— 要求「玩家位置也恢复到上次停留的
// 状态」。位置写进既有 meta 行（`playerPos` 字段），帧循环 5s + 移动 ≥1 格节流写盘，
// 传送时立即写一次（见 `_maybeSavePlayerPos` / `_savePlayerPos`）。

test('重启恢复：走远后重载，玩家回到上次停留处（不是 City 中央）且不被埋（v2.29）', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/?vd=2&seed=12345');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });

  // ① 传送到远处（City 加载半径之外）—— 这是「重启后不再出生在 City」的判据前提
  const tp = await page.evaluate(() => window.__MC_GAME__.teleportToShallowTarn());
  expect(tp.ok, '前提：seed 12345 须有浅水高台').toBe(true);
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    return g.world.hasColumn(Math.floor(p.x / 16), Math.floor(p.z / 16));
  }, null, { timeout: 120_000 });
  await page.waitForTimeout(500);

  // ② 显式写盘（生产路径靠帧循环 5s 节流；测试里不 sleep 5s，直接调唯一写入点）
  const before = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    g._savePlayerPos();
    const p = g.player.physics.pos;
    return { x: p.x, y: p.y, z: p.z, spawnX: g.spawnX, spawnZ: g.spawnZ };
  });
  expect(Math.hypot(before.x - before.spawnX, before.z - before.spawnZ),
    '前提：停留处须在 City 出生点之外（否则「不出生在 City」无判别力）').toBeGreaterThan(100);

  // ③ 重载 → 断言位置恢复
  await page.reload();
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  const after = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    return {
      x: p.x, y: p.y, z: p.z,
      spawnX: g.spawnX, spawnZ: g.spawnZ,
      stuck: g.player.physics.collidesAt(p.x, p.y, p.z),
      meta: g.persistence._metaCache,
    };
  });
  // 位置逐分量一致（写入与读回都是原值，无 round；容差 0.01 只防浮点噪声）
  expect(after.x, 'x 须恢复到上次停留处').toBeCloseTo(before.x, 2);
  expect(after.y, 'y 须恢复到上次停留处').toBeCloseTo(before.y, 2);
  expect(after.z, 'z 须恢复到上次停留处').toBeCloseTo(before.z, 2);
  // 不是 City 中央（用户报告的症状）
  expect(Math.hypot(after.x - after.spawnX, after.z - after.spawnZ),
    '重载后不得出生在 City 中央').toBeGreaterThan(100);
  // spawnX/spawnZ 语义不变（仍是 City 出生点，「回家」按钮的权威）
  expect(after.spawnX).toBe(before.spawnX);
  expect(after.spawnZ).toBe(before.spawnZ);
  // 不被埋（用户要求：「不要出生或瞬移结束后直接卡在方块里」）
  expect(after.stuck, '恢复的位置不得与方块重叠').toBe(false);
  // meta 行完整：playerPos 写入不得抹掉 seed/spawn（merge 写的正确性）
  expect(after.meta.seed, 'meta.seed 不得被 playerPos 写入抹掉').toBe(12345);
  expect(after.meta.spawn, 'meta.spawn 不得被 playerPos 写入抹掉').toEqual([before.spawnX, before.spawnZ]);
});

test('重启恢复：旧存档无 playerPos → 回落 City 出生点（兼容旧档）', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/?vd=2&seed=12345');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });

  // 模拟旧存档：meta 里只有 seed/spawn，没有 playerPos（写盘时机在启动节流之前被截断）
  await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const meta = g.persistence._metaCache;
    const { playerPos, ...rest } = meta;
    await g.persistence.saveMeta(rest);
  });

  await page.reload();
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  const after = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    return { x: p.x, y: p.y, z: p.z, spawnX: g.spawnX, spawnY: g.spawnY, spawnZ: g.spawnZ };
  });
  // 回落到 City 出生点（与 v2.29 之前的行为逐值一致）
  expect(after.x).toBe(after.spawnX);
  expect(after.y).toBe(after.spawnY);
  expect(after.z).toBe(after.spawnZ);
});
