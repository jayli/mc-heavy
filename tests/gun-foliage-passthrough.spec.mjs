import { test, expect } from 'playwright/test';

// 2026-11-25 用户裁定：破坏开关**关闭**时 pistol / minigun / carbine 要**射穿**装饰性
// 非实心方块（藤蔓 / 枯草 / 蘑菇 / 花草 —— 玩家踩不住、撞不上的那些），命中它后面的
// 第一个实心方块；开关**开启**时逐位回到今天（击中即消除）。MAG7 逻辑不变。
//
// ⚠️ 判据落在**命中格坐标 / 曳光终点 / 世界内容**，不是「有没有效果事件」：
// 只改破坏判定的形态是「没写世界但子弹仍停在草上」，数值判据全绿而观感没变。
//
// ⚠️ 全部从**玩家真实入口**进：`setTestAim`（真实相机姿态 → 真实 DDA）+ `player.update()`
// （帧循环那条主射线）+ `fireWeaponOnce()`。**不手塞 player.target** —— 那会绕过本次改动的落点。
//
// 场景搭在高空（y≈60）并清空邻域：出生点在山地/森林，四周地形与既有植被会干扰射线。

const URL = '/?vd=2&seed=12345';

async function boot(page) {
  await page.goto(URL);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const s = g.scheduler.stats();
    const sections = g.renderStats().sections;
    const prev = window.__FOLIAGE_PREV__;
    window.__FOLIAGE_PREV__ = sections;
    return prev === sections &&
      s.genInflight === 0 && s.meshInflight === 0 && s.meshQueued === 0 &&
      s.pendingMesh === 0 && s.lightInflight === 0 && s.lightQueued === 0 && s.uploadQueue === 0;
  }, null, { timeout: 90_000, polling: 500 });
}

/**
 * 高空走廊：清空 ±6 邻域 → 玩家脚下铺实心地面 → 视线（+X）上放
 * 「一株植物（dx=2）+ 一堵石墙（dx=5）」。返回格坐标与眼高。
 *
 * ⚠️ 植物与石墙都放在**眼高格**（headY = feetY + 1），水平平视时射线必然先遇到植物。
 */
async function buildCorridor(page, plantName) {
  return page.evaluate(async (name) => {
    const g = window.__MC_GAME__;
    const pl = g.player;
    const R = g.registry;
    const px = Math.floor(pl.physics.pos.x);
    const pz = Math.floor(pl.physics.pos.z);
    const baseY = 60;
    for (let dx = -6; dx <= 8; dx++) {
      for (let dz = -4; dz <= 4; dz++) {
        for (let y = baseY - 2; y <= baseY + 4; y++) {
          g.editor.setBlock({ x: px + dx, y, z: pz + dz, id: 0 });
        }
      }
    }
    // 地面（脚底下一格）铺一条，玩家站得住
    for (let dx = -2; dx <= 6; dx++) {
      g.editor.setBlock({ x: px + dx, y: baseY - 1, z: pz, id: R.idOf('stone') });
    }
    pl.physics.pos.x = px + 0.5;
    pl.physics.pos.y = baseY;
    pl.physics.pos.z = pz + 0.5;
    pl.physics.vel.x = 0; pl.physics.vel.y = 0; pl.physics.vel.z = 0;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const feetY = Math.floor(pl.physics.pos.y);
    const headY = feetY + 1;
    g.editor.setBlock({ x: px + 2, y: headY, z: pz, id: R.idOf(name) });
    g.editor.setBlock({ x: px + 5, y: headY, z: pz, id: R.idOf('stone') });
    return { px, pz, headY, plantId: R.idOf(name), stoneId: R.idOf('stone') };
  }, plantName);
}

/** 选枪 → 真实朝向 +X 平视 → 让帧循环重算 target → 开一枪，回读命中与世界 */
async function shoot(page, weapon, blockDamage) {
  return page.evaluate(async ({ weapon, blockDamage }) => {
    const g = window.__MC_GAME__;
    const pl = g.player;
    await g.selectWeapon(weapon);
    g.setGunBlockDamage(blockDamage);
    pl.setTestAim([1, 0, 0]);
    // 让 player.update() 用新姿态重算射线（本次改动的落点就在那条射线上）
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const wc = pl.weaponController;
    wc.cooldown = 0;
    const effects = pl.fireWeaponOnce();
    const e = effects[0] ?? null;
    return {
      effectType: e?.type ?? null,
      impacts: (e?.impacts ?? []).map((i) => ({ pos: i.blockPos, blockId: i.blockId, destroyed: i.destroyed })),
      end: e?.end ?? null,
      // 准心高亮框读的仍是「交互射线」，不该被武器判据改写
      interactTarget: pl.target ? pl.target.blockPos : null,
    };
  }, { weapon, blockDamage });
}

const cellState = (page, s) => page.evaluate((s) => ({
  plant: window.__MC_GAME__.world.getBlockId(s.px + 2, s.headY, s.pz),
  wall: window.__MC_GAME__.world.getBlockId(s.px + 5, s.headY, s.pz),
}), s);

for (const weapon of ['pistol', 'minigun', 'carbine']) {
  test(`${weapon}：破坏开关关闭时射穿枯草，命中后方石墙且草仍在`, async ({ page }) => {
    test.setTimeout(180_000);
    await boot(page);
    const s = await buildCorridor(page, 'dead_bush');
    // 前置自检：植物真的无碰撞（否则本用例测的是想象世界）
    const sanity = await page.evaluate((id) => ({
      solid: window.__MC_GAME__.registry.solidTable[id],
      supports: window.__MC_GAME__.registry.supportsPlayerTable[id],
    }), s.plantId);
    expect(sanity.solid, 'sanity：枯草非实心').toBe(0);
    expect(sanity.supports, 'sanity：枯草玩家踩不住').toBe(0);

    const r = await shoot(page, weapon, false);
    const after = await cellState(page, s);
    console.log(`${weapon} PASS-THROUGH:`, JSON.stringify({ r, after }));
    expect(r.impacts.length, '应命中后方石墙（不是无命中）').toBe(1);
    expect(r.impacts[0].pos, '命中格必须是石墙，不是草格').toEqual([s.px + 5, s.headY, s.pz]);
    expect(r.impacts[0].blockId).toBe(s.stoneId);
    expect(r.impacts[0].destroyed, '开关关闭：不写世界').toBe(false);
    expect(after.plant, '枯草必须原样保留').toBe(s.plantId);
    expect(after.wall, '石墙仍在（开关关不破坏）').toBe(s.stoneId);
    // 曳光终点必须推到石墙那一侧（否则观感上子弹仍停在草上）
    expect(r.end[0]).toBeGreaterThanOrEqual(s.px + 5);
    // 交互射线（高亮框/挖块/放置）不受影响：仍指向草格
    expect(r.interactTarget, '准心交互 target 不得被武器判据改写').toEqual([s.px + 2, s.headY, s.pz]);
  });

  test(`${weapon}：破坏开关开启时击中枯草即消除（逐字回到今天）`, async ({ page }) => {
    test.setTimeout(180_000);
    await boot(page);
    const s = await buildCorridor(page, 'dead_bush');
    const r = await shoot(page, weapon, true);
    const after = await cellState(page, s);
    console.log(`${weapon} DESTROY-ON:`, JSON.stringify({ r, after }));
    expect(r.impacts.length).toBe(1);
    expect(r.impacts[0].pos, '开关开启：命中草格').toEqual([s.px + 2, s.headY, s.pz]);
    expect(r.impacts[0].destroyed).toBe(true);
    expect(after.plant, '枯草被消除').toBe(0);
    expect(after.wall, '后方石墙不受影响（一发只删一格）').toBe(s.stoneId);
  });
}

test('玻璃仍挡住三把枪（实心透明方块不在放行范围）', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  const s = await buildCorridor(page, 'glass_block');
  const r = await shoot(page, 'pistol', false);
  const after = await cellState(page, s);
  expect(r.impacts[0].pos, '玻璃必须挡住子弹（即使开关关闭）').toEqual([s.px + 2, s.headY, s.pz]);
  expect(after.plant, '玻璃仍在').toBe(s.plantId);
});

test('MAG7 逻辑不变：开关关闭时仍把枯草与石墙一起打掉', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  const s = await buildCorridor(page, 'dead_bush');
  const r = await shoot(page, 'mag7', false);
  const after = await cellState(page, s);
  console.log('MAG7 UNCHANGED:', JSON.stringify({ r, after }));
  expect(after.plant, 'MAG7 无视开关：枯草被消除').toBe(0);
  expect(after.wall, 'MAG7 体积扫描：石墙也被消除').toBe(0);
});