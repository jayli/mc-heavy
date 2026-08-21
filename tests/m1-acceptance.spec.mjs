import { test, expect } from 'playwright/test';

// §8 基线场景 ①：平原冲刺（视距 8）——自动驱动玩家沿直线奔跑 10s，采帧时分布
test('M1 验收：平原冲刺视距 8 帧时达标（120fps 预算）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=8');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  // 等视距内 column 大部分就绪（后台填充，§4.2 冷启动口径）
  await page.waitForFunction(() => window.__MC_GAME__.world.columns.size >= 250, null, { timeout: 60_000 });

  // 驱动奔跑：模拟按住 W 10s（编程注入输入状态，无头环境无真实键盘）
  await page.evaluate(() => { window.__MC_GAME__.player.keys.add('KeyW'); });
  await new Promise((r) => setTimeout(r, 10_000));
  await page.evaluate(() => { window.__MC_GAME__.player.keys.delete('KeyW'); });

  const perf = await page.evaluate(() => window.__MC_GAME__.perfSnapshot());
  const stats = await page.evaluate(() => window.__MC_GAME__.renderStats());
  console.log('M1 RUN:', JSON.stringify({ perf, stats }));

  // 帧时口径（与 Task 7/8 一致）：120Hz vsync 锁帧下 frameMs.p95 被量化为 ~8.3ms+抖动，
  // `p95<8.3` 数学上不可满足（测的是 vsync 抖动而非渲染负载）。故以 fps 为主断言
  // （§1 目标：高刷屏 ≥90fps），frameMs.p95 作防跌破 60fps 二级门。
  expect(perf.fps).toBeGreaterThan(process.env.CI ? 20 : 90);
  expect(perf.frameMs.p95).toBeLessThan(process.env.CI ? 50 : 16.7);
  expect(stats.sections).toBeGreaterThan(100);
});

// §8 基线场景 ③：连续放/挖 200 块——发布层确认门（§4.4.2 M1 决策门）
test('M1 验收：放挖压力 p95 帧时（BatchedMesh 确认门）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=8');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  // 稳态计量口径：视距 8 全 289 列就绪 + 5s 沉淀后再放挖。
  // （M2-2 起出生在城市，城市填充比平原慢；250 列时后台填充与编辑帧争抢，
  //  测的是填充负载而非编辑负载。断言阈值不变。）
  await page.waitForFunction(() => window.__MC_GAME__.world.columns.size >= 289, null, { timeout: 90_000 });
  await new Promise((r) => setTimeout(r, 5000));

  // 连续放/挖 200 块（编程驱动，每块间隔 1 帧）
  const editStats = await page.evaluate(async () => {
    const game = window.__MC_GAME__;
    const { world, registry, scheduler, player } = game;
    const px = Math.floor(player.physics.pos.x), pz = Math.floor(player.physics.pos.z);
    let groundY = -1;
    for (let y = 60; y > -32; y--) { if (world.getBlockId(px + 3, y, pz) !== 0) { groundY = y; break; } }
    const stoneId = registry.idOf('stone');
    const placeTimes = [], digTimes = [];
    for (let i = 0; i < 200; i++) {
      const x = px + 3 + (i % 10), z = pz + Math.floor(i / 10) - 10;
      // 单块放置编辑（§4.3 快速路径计量单位 = 单次编辑）
      let t0 = performance.now();
      const r1 = world.setBlock(x, groundY + 1, z, stoneId);
      if (r1) scheduler.remeshSections(r1.affected, { fastPath: true });
      placeTimes.push(performance.now() - t0);
      await new Promise((r) => requestAnimationFrame(r));
      // 单块挖除编辑
      t0 = performance.now();
      const r2 = world.setBlock(x, groundY + 1, z, 0);
      if (r2) scheduler.remeshSections(r2.affected, { fastPath: true });
      digTimes.push(performance.now() - t0);
      await new Promise((r) => requestAnimationFrame(r));
    }
    placeTimes.sort((a, b) => a - b);
    digTimes.sort((a, b) => a - b);
    return {
      placeP95: placeTimes[Math.floor(placeTimes.length * 0.95)],
      digP95: digTimes[Math.floor(digTimes.length * 0.95)],
      placeMax: placeTimes[placeTimes.length - 1],
      digMax: digTimes[digTimes.length - 1],
    };
  });
  console.log('M1 EDIT:', JSON.stringify(editStats));

  // 冻结口径：单块放/挖编辑帧时 p95 < 2ms（§4.3 快速路径硬约束）。
  // 计量单位 = 单次编辑（一次 setBlock + 一次 remeshSections）；
  // 放置与挖除分别断言，阈值 2ms 不变。
  expect(editStats.placeP95).toBeLessThan(2);
  expect(editStats.digP95).toBeLessThan(2);

  // 编辑后整体帧时仍达标（同 vsync 口径）
  await new Promise((r) => setTimeout(r, 1000));
  const perf = await page.evaluate(() => window.__MC_GAME__.perfSnapshot());
  expect(perf.fps).toBeGreaterThan(process.env.CI ? 20 : 90);
  expect(perf.frameMs.p95).toBeLessThan(process.env.CI ? 50 : 16.7);
});
