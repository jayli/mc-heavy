import { test, expect } from 'playwright/test';

// M4：三把枪的无 pointer-lock 集成验证。经 window.__MC_GAME__ 公开 API 驱动切枪与开火，
// 不依赖 pointer lock。初始视线固定为 yaw/pitch=0（-Z），在相机前方 2 格眼高放石头，
// 把 player.target 固定为该格命中。
//   - 手枪开关关闭：只阻挡不写世界（blocked 有 1 个效果，方块不变）
//   - 手枪开关开启：删首个命中（destroyed，方块变 air）
//   - MAG7 开关关闭：仍破坏（mag7Destroyed，MAG7 无视开关）
//   - 加特林：两次 fireWeaponOnce 让 shotsFired 增长
//   - 第一人称模型已加载、tracer <=32、audio 播放请求增长
test('M4：三把枪经公开 API 驱动，开关豁免与视图/曳光/音效就位', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?vd=4');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 60_000 });
  const result = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    g.player.yaw = 0; g.player.pitch = 0;
    const x = Math.floor(g.camera.position.x);
    const y = Math.floor(g.camera.position.y);
    const z = Math.floor(g.camera.position.z) - 2;
    const stone = g.registry.idOf('stone');
    g.editor.setBlock({ x, y, z, id: stone });
    g.player.target = { hit: true, blockPos: [x, y, z], dist: 2 };
    await g.selectWeapon('pistol');
    g.setGunBlockDamage(false);
    const blocked = g.fireWeaponOnce();
    await new Promise((resolve) => setTimeout(resolve, 100)); // 等 0.09s 冷却结束
    const blockedStillStone = g.world.getBlockId(x, y, z) === stone;
    g.player.target = { hit: true, blockPos: [x, y, z], dist: 2 };
    g.setGunBlockDamage(true);
    const destroyed = g.fireWeaponOnce();
    const pistolDestroyed = g.world.getBlockId(x, y, z) === 0;

    await new Promise((resolve) => setTimeout(resolve, 1500)); // 等 MAG7 1.5s 冷却
    g.editor.setBlock({ x, y, z, id: stone });
    g.player.target = { hit: true, blockPos: [x, y, z], dist: 2 };
    await g.selectWeapon('mag7');
    g.setGunBlockDamage(false); // MAG7 必须仍然破坏
    const mag7 = g.fireWeaponOnce();
    const mag7Destroyed = g.world.getBlockId(x, y, z) === 0;

    await new Promise((resolve) => setTimeout(resolve, 1500));
    await g.selectWeapon('minigun');
    await new Promise((resolve) => setTimeout(resolve, 70)); // 等 0.07s 冷却
    const beforeMinigun = g.weaponDebugState().shotsFired;
    g.fireWeaponOnce();
    await new Promise((resolve) => setTimeout(resolve, 70));
    g.fireWeaponOnce();
    const state = g.weaponDebugState();
    return { blocked, blockedStillStone, destroyed, pistolDestroyed, mag7, mag7Destroyed, beforeMinigun, state };
  });
  expect(result.blocked.length).toBe(1);
  expect(result.blockedStillStone).toBe(true); // 开关关闭不写世界
  expect(result.destroyed.length).toBe(1);
  expect(result.pistolDestroyed).toBe(true);
  expect(result.mag7.length).toBe(1);
  expect(result.mag7Destroyed).toBe(true); // MAG7 无视开关
  expect(result.state.shotsFired).toBeGreaterThan(result.beforeMinigun);
  expect(result.state.activeTracers).toBeLessThanOrEqual(32);
  expect(result.state.viewLoaded).toBe(true);
  expect(result.state.audioPlayRequests).toBeGreaterThan(0);
});
