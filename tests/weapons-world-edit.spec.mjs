import { test, expect } from 'playwright/test';

// M4 验收：200 次普通枪（开启破坏）与 20 次 MAG7 的真实世界编辑压力。
// 这不是 weapons.spec「开关关闭」的替代品——它真正写世界：
//   - 普通枪连续 200 次删首个命中，计时只包围 fireWeaponOnce 的删除路径 → world-edit p95（<2ms 冻结口径）
//   - MAG7 按 1.5s 冷却连续 20 次批量提交（无视开关仍破坏），记录批量提交 p95（不新增未冻结阈值）
//   - 收敛后目标 section 发布版本 == 权威 column 版本（覆盖过期 mesh 丢弃协议）
//   - 无悬挂曳光、scene/camera child 不增长（WebGPU renderer.info 非稳定对象计数口径，故用 child 数）

async function waitForStableVD8(page) {
  // RedCity 起默认出生在 RedCity；本用例语义绑定 City 环境，pin spawn=city（RedCity spec §14.8）
  await page.goto('/?vd=8&spawn=city');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => window.__MC_GAME__.world.columns.size >= 289, null, { timeout: 90_000 });
  await page.waitForFunction(() => {
    const s = window.__MC_GAME__.scheduler.stats();
    return s.genInflight === 0 && s.meshInflight === 0 && s.meshQueued === 0 &&
      s.pendingMesh === 0 && s.lightInflight === 0 && s.lightQueued === 0 && s.uploadQueue === 0;
  }, null, { timeout: 60_000 });
  await page.waitForTimeout(5_000);
}

test('M4：200 次普通枪和 20 次 MAG7 破坏后版本与队列收敛', async ({ page }) => {
  test.setTimeout(180_000);
  await waitForStableVD8(page);
  const run = await page.evaluate(async () => {
    const p95 = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.95)];
    const g = window.__MC_GAME__;
    const stone = g.registry.idOf('stone');
    g.player.yaw = 0; g.player.pitch = 0;
    const x = Math.floor(g.camera.position.x);
    const y = Math.floor(g.camera.position.y);
    const z = Math.floor(g.camera.position.z) - 2;
    await g.selectWeapon('pistol');
    g.setGunBlockDamage(true);
    const objectCountBefore = { scene: g.scene.children.length, camera: g.camera.children.length };
    const pistolTimes = [];
    let pistolEffects = 0;
    let pistolAir = true;
    for (let i = 0; i < 200; i++) {
      g.editor.setBlock({ x, y, z, id: stone });
      g.player.target = { hit: true, blockPos: [x, y, z], dist: 2 };
      const t0 = performance.now();
      const effects = g.fireWeaponOnce();
      pistolTimes.push(performance.now() - t0);
      pistolEffects += effects.length;
      pistolAir &&= g.world.getBlockId(x, y, z) === 0;
      if (i < 199) await new Promise((resolve) => setTimeout(resolve, 95));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    await g.selectWeapon('mag7');
    g.setGunBlockDamage(false); // MAG7 必须仍然破坏。
    const mag7Times = [];
    let mag7Effects = 0;
    let mag7Air = true;
    const cells = [];
    for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) {
      cells.push({ x: x + dx, y: y + dy, z: Math.floor(g.camera.position.z) - 1 });
    }
    for (let i = 0; i < 20; i++) {
      for (const cell of cells) g.editor.setBlock({ ...cell, id: stone });
      const t0 = performance.now();
      const effects = g.fireWeaponOnce();
      mag7Times.push(performance.now() - t0);
      mag7Effects += effects.length;
      mag7Air &&= cells.every((cell) => g.world.getBlockId(cell.x, cell.y, cell.z) === 0);
      if (i < 19) await new Promise((resolve) => setTimeout(resolve, 1_510));
    }
    const { WORLD_MIN_Y } = await import('/src/voxel/constants.js');
    return {
      pistolP95: p95(pistolTimes),
      mag7P95: p95(mag7Times),
      pistolEffects,
      mag7Effects,
      pistolAir,
      mag7Air,
      objectCountBefore,
      section: {
        cx: Math.floor(x / 16),
        sy: Math.floor((y - WORLD_MIN_Y) / 16),
        cz: Math.floor(z / 16),
      },
    };
  });
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const s = g.scheduler.stats();
    return s.genInflight === 0 && s.meshInflight === 0 && s.meshQueued === 0 &&
      s.pendingMesh === 0 && s.lightInflight === 0 && s.lightQueued === 0 &&
      s.uploadQueue === 0 && g.weaponDebugState().activeTracers === 0;
  }, null, { timeout: 60_000 });
  const settled = await page.evaluate(({ cx, sy, cz, objectCountBefore }) => {
    const g = window.__MC_GAME__;
    return {
      scheduler: g.scheduler.stats(),
      columnVersion: g.world.getColumn(cx, cz).version,
      publishedVersion: g.renderWorld.getSectionVersion(cx, sy, cz),
      objectCountAfter: { scene: g.scene.children.length, camera: g.camera.children.length },
      objectCountBefore,
      activeTracers: g.weaponDebugState().activeTracers,
    };
  }, { ...run.section, objectCountBefore: run.objectCountBefore });
  expect(run.pistolEffects).toBe(200);
  expect(run.mag7Effects).toBe(20);
  expect(run.pistolAir).toBe(true);
  expect(run.mag7Air).toBe(true);
  expect(run.pistolP95).toBeLessThan(2); // 既有单块编辑冻结口径。
  expect(run.mag7P95).toBeGreaterThanOrEqual(0);
  expect(settled.scheduler.genInflight).toBe(0);
  expect(settled.scheduler.meshInflight).toBe(0);
  expect(settled.scheduler.meshQueued).toBe(0);
  expect(settled.scheduler.pendingMesh).toBe(0);
  expect(settled.scheduler.lightInflight).toBe(0);
  expect(settled.scheduler.lightQueued).toBe(0);
  expect(settled.scheduler.uploadQueue).toBe(0);
  expect(settled.publishedVersion).toBe(settled.columnVersion);
  expect(settled.activeTracers).toBe(0);
  expect(settled.objectCountAfter).toEqual(settled.objectCountBefore);
});
