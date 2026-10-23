// RedCity 编辑耗时观测门（Tier 4，真实页面）—— R15（spec §14.9）用户裁定选项 A 的落地。
//
// 背景：RedCity 出生点周围 section 更密，单块放/挖编辑 p95 实测 2.4~2.5 ms（City 出生点 1.6~1.8）。
// 拆分计时：`world.setBlock` 0.1 ms 不变，`scheduler.remeshSections(..., { fastPath: true })` 的同步重建 1.7 → 2.4 ms。
//
// 口径分工（**两个门并存，互不替代**）：
//   - 冻结口径「单块放/挖 p95 < 2 ms」（§4.3 快速路径硬约束）仍由 `m1-acceptance` / `weapons-world-edit` 守，
//     它们已 pin `?spawn=city`（语义绑定 City 环境），**一个字没放宽**；
//   - 本 spec 是 **RedCity 口径**：默认出生点（RedCity）、同一套测量代码（与 m1-acceptance 逐行同构），
//     阈值 3.5 ms（用户裁定接受 RedCity 出生点更高的编辑耗时，阈值取实测 2.4~2.5 ms 上浮约 40%，留出计时抖动余量）。
//
// 它守的是：RedCity 出生点的编辑耗时不得比今天再退化（mesher 快速路径在密集 section 上的回退会先在这里红）。
//
// 判别力来自作者期的负向验证（不做永久的「耗时必须 ≥ 2 ms」下界断言——性能变好时让测试变红是反模式，会制造抖动）：
// 把阈值改回冻结的 2.0 必须 FAIL，证明本用例确实量到了 RedCity 出生点比 City 更高的编辑耗时。
// 哪天这条负向验证不再红（mesher 快速路径变快了），说明 R15 裁定与 m1-acceptance / weapons-world-edit 的 pin 可以重新评估。
//
// 测量代码与 m1-acceptance 逐行同构（唯一差别：不 pin 出生点；等待收敛用队列归零而非固定 sleep）。
// 若有人改 m1-acceptance 的测量口径，须同步改这里，否则两个门量的不是同一件事。
import { test, expect } from 'playwright/test';

/** RedCity 口径的单块放/挖编辑 p95 上限（ms）。用户裁定（R15 选项 A）；实测 2.4~2.5 ms */
const REDCITY_EDIT_P95_LIMIT_MS = 3.5;
/** 合理性下限（ms）：单次编辑 = setBlock 0.1 + 同步重建 ≥1.6（City 实测最低），低于它说明重建没真正执行（采样口径失效而恒真） */
const SANITY_FLOOR_MS = 0.5;

const settle = (page) => page.waitForFunction(() => {
  const g = window.__MC_GAME__;
  const s = g.scheduler.stats();
  return s.inflight === 0 && s.meshInflight === 0 && s.uploadQueue === 0 && s.lightInflight === 0 && g.world.columns.size >= 289;
}, null, { timeout: 180_000 });

test('RedCity 出生点：单块放/挖编辑 p95 < 3.5 ms（R15 选项 A，冻结 2 ms 口径 pin 在 City）', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/?vd=8&seed=12345');            // 不 pin 出生点 = RedCity
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 120_000 });
  await settle(page);
  await new Promise((r) => setTimeout(r, 5000));   // 与 m1-acceptance 同：289 列就绪 + 5 s 沉淀后再放挖

  // 前提：确实在 RedCity 的 core 内（否则这条门测的是 City，等于没测）
  const where = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const rc = g.scheduler.structureIndex.redCity();
    const p = g.player.physics.pos;
    return { inCore: !!rc && p.x >= rc.core.minX && p.x <= rc.core.maxX && p.z >= rc.core.minZ && p.z <= rc.core.maxZ };
  });
  expect(where.inCore, '默认出生点须在 RedCity core 内').toBe(true);

  // 连续放/挖 200 块（编程驱动，每块间隔 1 帧）—— 与 m1-acceptance 逐行同构
  const editStats = await page.evaluate(async () => {
    const game = window.__MC_GAME__;
    const { world, registry, scheduler, player } = game;
    const px = Math.floor(player.physics.pos.x), pz = Math.floor(player.physics.pos.z);
    let groundY = -1;
    for (let y = 60; y > -32; y--) { if (world.getBlockId(px + 3, y, pz) !== 0) { groundY = y; break; } }
    const stoneId = registry.idOf('stone');
    const placeTimes = [], digTimes = [];
    let placeChanged = 0, digChanged = 0;
    for (let i = 0; i < 200; i++) {
      const x = px + 3 + (i % 10), z = pz + Math.floor(i / 10) - 10, y = groundY + 1;
      // 「真实改动」判据放在计时之外：`world.setBlock` 不做 no-op 检测（同值写入也返回非空并触发重建），
      // 所以不能拿返回值当「改动了」——要对比写入前后的方块 id。
      const was1 = world.getBlockId(x, y, z);
      let t0 = performance.now();
      const r1 = world.setBlock(x, y, z, stoneId);
      if (r1) scheduler.remeshSections(r1.affected, { fastPath: true });
      placeTimes.push(performance.now() - t0);
      if (was1 !== stoneId && world.getBlockId(x, y, z) === stoneId) placeChanged++;
      await new Promise((r) => requestAnimationFrame(r));
      const was2 = world.getBlockId(x, y, z);
      t0 = performance.now();
      const r2 = world.setBlock(x, y, z, 0);
      if (r2) scheduler.remeshSections(r2.affected, { fastPath: true });
      digTimes.push(performance.now() - t0);
      if (was2 !== 0 && world.getBlockId(x, y, z) === 0) digChanged++;
      await new Promise((r) => requestAnimationFrame(r));
    }
    placeTimes.sort((a, b) => a - b);
    digTimes.sort((a, b) => a - b);
    return {
      groundY, placeChanged, digChanged,
      placeP95: placeTimes[Math.floor(placeTimes.length * 0.95)],
      digP95: digTimes[Math.floor(digTimes.length * 0.95)],
      placeMax: placeTimes[placeTimes.length - 1],
      digMax: digTimes[digTimes.length - 1],
    };
  });
  console.log('REDCITY EDIT:', JSON.stringify(editStats));

  // sanity：找到了地面，且绝大多数放/挖确实改了世界（对比写入前后的方块 id；采样口径失效会把 p95 测得虚低 → 判据恒真）
  expect(editStats.groundY, '须找到地面').toBeGreaterThan(-32);
  expect(editStats.placeChanged, '放置须真实改动世界').toBeGreaterThanOrEqual(180);
  expect(editStats.digChanged, '挖除须真实改动世界').toBeGreaterThanOrEqual(180);

  // 合理性下限：重建真的执行了（防止采样口径失效而恒真）
  expect(editStats.placeP95, '放置 p95 不应低于合理性下限').toBeGreaterThan(SANITY_FLOOR_MS);
  expect(editStats.digP95, '挖除 p95 不应低于合理性下限').toBeGreaterThan(SANITY_FLOOR_MS);

  // RedCity 口径门限（用户裁定 3.5 ms）
  expect(editStats.placeP95, '放置 p95').toBeLessThan(REDCITY_EDIT_P95_LIMIT_MS);
  expect(editStats.digP95, '挖除 p95').toBeLessThan(REDCITY_EDIT_P95_LIMIT_MS);
});
