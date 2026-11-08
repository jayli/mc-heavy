import { test, expect } from 'playwright/test';

// 高台地带祭坛（v2.30 首创，v2.82 用户重做造型）Tier 4 验收。
//
// 用户 2026-10-31：「把祭坛的造型内化到代码里，放到距离 City 最近的一个高台地带里，
// 因为在设置面板中，点击瞬移区域的『高台』，就会移动到距离 City 最近的一个高台」。
// 2026-11-06 用户在同一存档里重做了祭坛造型（进度包
// `mc-heavy-progress-1249026-2026-11-06T15-01-30.json`），造型权威见 `tarn-altar.js`。
//
// ⚠️ **必须走真实用户路径**（设置面板「高台」按钮），不能只调 `game.teleportToTarnZone()`
// —— M7 教训（验收报告 §3.7）：只测 Game API 时「面板没接线 / Worker RPC 丢字段」这类
// 缺陷全绿通过，玩家实玩立刻发现。本 spec 验三件浏览器单测（test-tarn-altar.js）验不到的事：
//   ① `layout.altar` 标志经 Worker 'layout' RPC（结构化克隆）往返后仍在；
//   ② 真实 Worker 池 GEN 路径（不是本地 applyStructuresToColumn）真的写出了祭坛；
//   ③ 玩家按「高台」按钮落到的那个地带，就是带祭坛的那个。
//
// 祭坛 = 两层：地表图案（y = plateauY，替换广场材质，565 格）+ 中心神龛（dy 1~2，6 格）。
// ⚠️ **v2.31 起祭坛地带不再生成紫晶柱**（用户 2026-10-31：「只删带有祭坛的高台地形里的
// 水晶柱，其他高台地带不要动」）⇒ 广场图案 **565 格完整落地**，不再有柱基遮挡的缺口。

const READY = () => window.__MC_GAME__?.worldReady === true;

/** 等世界稳定：sections 连续两次采样不变 + 三条队列归零（勿只看队列瞬时归零） */
const STABLE = () => {
  const g = window.__MC_GAME__;
  const s = g.scheduler.stats();
  const sections = g.renderStats().sections;
  const prev = window.__MC_STABLE_PREV__;
  window.__MC_STABLE_PREV__ = sections;
  return prev === sections && s.inflight === 0 && s.meshInflight === 0 && s.uploadQueue === 0;
};

async function openPanel(page) {
  await page.locator('#settings-btn').click();
  await expect(page.locator('#settings-modal')).toBeVisible();
}

test('祭坛：按「高台」按钮到达的地带带祭坛（真实按钮 + 真实世界方块）', async ({ page }) => {
  test.setTimeout(400_000);
  await page.goto('/?vd=2&seed=12345');
  await page.waitForFunction(READY, null, { timeout: 120_000 });
  await page.waitForFunction(STABLE, null, { timeout: 90_000, polling: 500 });

  // ── ① 真实按钮点击（不是 game.teleportToTarnZone()）──
  await openPanel(page);
  await page.locator('#btn-teleport-tarn').click();
  await expect(page.locator('#mc-toast')).toContainText(/已瞬移到高台地带/, { timeout: 20_000 });
  // v2.28：跳转成功后自动关面板
  await expect(page.locator('#settings-modal')).toBeHidden({ timeout: 8000 });

  const landed = await page.evaluate(() => {
    const p = window.__MC_GAME__.player.physics.pos;
    return { x: Math.round(p.x), z: Math.round(p.z) };
  });

  // ── ② 落点所在的地带必须是祭坛地带（layout.altar 经 Worker RPC 后仍为 true）──
  const zone = await page.evaluate(async (p) => {
    const m = await import('/src/gen/structures/tarn-zone.js');
    const seed = window.__MC_GAME__.seed;
    const found = m.findNearestTarnZone(p.x, p.z, seed);
    if (!found) return null;
    const lay = m.computeTarnZone(found.regionX, found.regionZ, seed);
    const altarRegion = m.findAltarTarnRegion(seed);
    return {
      regionX: found.regionX, regionZ: found.regionZ,
      cx: lay.cx, cz: lay.cz, plateauY: lay.plateauY,
      altarFlag: lay.altar,
      altarRegionX: altarRegion ? altarRegion.regionX : null,
      altarRegionZ: altarRegion ? altarRegion.regionZ : null,
    };
  }, landed);
  expect(zone, '前提：seed 12345 须能到达高台地带').not.toBeNull();
  expect(zone.altarFlag, '按「高台」到达的地带必须带祭坛（layout.altar === true）').toBe(true);
  expect(zone.regionX, '落点地带必须就是 findAltarTarnRegion 选中的那个').toBe(zone.altarRegionX);
  expect(zone.regionZ).toBe(zone.altarRegionZ);

  // ── ③ 飞到圆心上方，等 column 加载，读真实世界方块 ──
  await page.evaluate((z) => {
    const g = window.__MC_GAME__;
    g.player.physics.pos.x = z.cx;
    g.player.physics.pos.z = z.cz;
    g.player.physics.pos.y = z.plateauY + 30;
    g.player.physics.vel.x = g.player.physics.vel.y = g.player.physics.vel.z = 0;
  }, zone);
  await page.waitForFunction((z) => {
    const g = window.__MC_GAME__;
    const ccx = Math.floor(z.cx / 16), ccz = Math.floor(z.cz / 16);
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      if (!g.world.hasColumn(ccx + dx, ccz + dz)) return false;
    }
    return true;
  }, zone, { timeout: 180_000 });
  await page.waitForFunction(STABLE, null, { timeout: 120_000, polling: 500 });
  await page.waitForTimeout(800);

  // ── ④ 神龛（唯一突出地面的部分）逐格核对 —— v2.31 起祭坛地带无紫晶柱，零覆盖干扰 ──
  const shrine = await page.evaluate(async (z) => {
    const g = window.__MC_GAME__;
    const reg = g.registry;
    const { altarShrineBlocks } = await import('/src/gen/structures/tarn-altar.js');
    const mism = [];
    for (const b of altarShrineBlocks()) {
      const got = reg.nameOf(g.world.getBlockId(z.cx + b.dx, z.plateauY + b.dy, z.cz + b.dz));
      if (got !== b.type) mism.push(`(${b.dx},${b.dy},${b.dz}) 应 ${b.type} 实 ${got}`);
      if (b.type === 'planks_step') {
        const meta = g.world.getBlockMeta(z.cx + b.dx, z.plateauY + b.dy, z.cz + b.dz);
        if (meta !== b.meta) mism.push(`台阶 (${b.dx},${b.dz}) meta 应 ${b.meta} 实 ${meta}`);
      }
    }
    return { total: altarShrineBlocks().length, mism };
  }, zone);
  expect(shrine.mism, `神龛 ${shrine.total} 格须逐格落地：${shrine.mism.slice(0, 5).join('；')}`).toEqual([]);

  // ── ⑤ 中心 7×7 美朵（v2.82：debris 心 + diamond 十字 + gold/amethyst 点缀）──
  const center = await page.evaluate((z) => {
    const g = window.__MC_GAME__;
    const reg = g.registry;
    const at = (dx, dz) => reg.nameOf(g.world.getBlockId(z.cx + dx, z.plateauY, z.cz + dz));
    return {
      mid: at(0, 0),
      edges: [at(1, 0), at(-1, 0), at(0, 1), at(0, -1)],
      diag1: [at(1, 1), at(1, -1), at(-1, 1), at(-1, -1)],
      ring3: [at(3, 0), at(-3, 0), at(0, 3), at(0, -3)],
      corner3: [at(3, 3), at(3, -3), at(-3, 3), at(-3, -3)],
      // 美朵的 8 个背景格 (±3,±2),(±2,±3)：不属祭坛，应保持广场材质
      bgCells: [at(3, 2), at(2, 3), at(-3, 2), at(2, -3)],
    };
  }, zone);
  expect(center.mid, '中心是 debris').toBe('debris');
  expect(center.edges, '四正是 diamond').toEqual(['diamond', 'diamond', 'diamond', 'diamond']);
  expect(center.diag1, '(±1,±1) 是 gold_block').toEqual(['gold_block', 'gold_block', 'gold_block', 'gold_block']);
  expect(center.ring3, '(±3,0),(0,±3) 是 amethyst').toEqual(['amethyst', 'amethyst', 'amethyst', 'amethyst']);
  expect(center.corner3, '(±3,±3) 是 amethyst').toEqual(['amethyst', 'amethyst', 'amethyst', 'amethyst']);
  expect(center.bgCells, '美朵背景格保持广场材质').toEqual(
    ['smooth_stone_1', 'smooth_stone_1', 'smooth_stone_1', 'smooth_stone_1']);

  // ── ⑥ 地表图案整体：565 格全部由祭坛自己落地（v2.31 起无柱基遮挡）──
  //    与 test-tarn-altar.js 的「真实 GEN 逐格落地」同判据，但跑在真实游戏页 + Worker 池上。
  const surface = await page.evaluate(async (z) => {
    const g = window.__MC_GAME__;
    const reg = g.registry;
    const { altarSurfaceBlockAt, ALTAR_ARM_LENGTH } = await import('/src/gen/structures/tarn-altar.js');
    let placed = 0;
    const wrong = [];
    for (let dx = -ALTAR_ARM_LENGTH; dx <= ALTAR_ARM_LENGTH; dx++) {
      for (let dz = -ALTAR_ARM_LENGTH; dz <= ALTAR_ARM_LENGTH; dz++) {
        const b = altarSurfaceBlockAt(dx, dz);
        if (!b) continue;
        const got = reg.nameOf(g.world.getBlockId(z.cx + dx, z.plateauY, z.cz + dz));
        if (got === b.type) placed++;
        else wrong.push(`(${dx},${dz}) 应 ${b.type} 实 ${got}`);
      }
    }
    // 广场内不得残留 tuff_bricks：v2.82 把广场那个 3 格宽 tuff 十字在祭坛范围内
    // 全部抹平成 smooth_stone_1（用户存档实测 tuff 残留 0）。
    let tuff = 0;
    for (let dx = -28; dx <= 28; dx++) {
      for (let dz = -28; dz <= 28; dz++) {
        if (Math.hypot(dx, dz) > 28) continue;
        if (reg.nameOf(g.world.getBlockId(z.cx + dx, z.plateauY, z.cz + dz)) === 'tuff_bricks') tuff++;
      }
    }
    return { placed, wrong, tuff };
  }, zone);
  expect(surface.wrong, `地表图案逐格落地：${surface.wrong.slice(0, 5).join('；')}`).toEqual([]);
  // ⚠️ **565 = v2.82 重做后的图案总格数**（与 test-tarn-altar.js 的计数用例同源）。
  //    这条同时钉住「柱子真的没了」—— 柱子还在的话柱基会压掉外环与轴末端的格。
  expect(surface.placed, '565 格图案全部由祭坛自己落地（无柱基遮挡）').toBe(565);
  // ⚠️ **抹平臂分支的唯一接线判据**：smooth_stone_1 与广场背景同材质，`placed` 对漏写
  //    那个分支不敏感（图案计数仍对），只有「tuff 残留 = 0」能抓到。
  expect(surface.tuff, '广场内不得残留 tuff_bricks 十字（v2.82 全部抹平）').toBe(0);

  // ── ⑦ 祭坛地带只剩 5 个拱洞（v2.31：紫晶柱已删）──
  //    ⚠️ 读的是 **Worker RPC 往返后的 layout**（`scheduler.structureIndex._layouts`），
  //    不是本地 `computeTarnZone` —— 后者验不到 RPC 丢字段这类缺陷（M7 教训）。
  const decos = await page.evaluate((z) => {
    const m = window.__MC_GAME__.scheduler.structureIndex._layouts.get(`${z.regionX},${z.regionZ}`);
    if (!m || !m.tarn) return null;
    return {
      total: m.tarn.decos.length,
      spires: m.tarn.decos.filter((d) => d.kind === 'spire').length,
      arches: m.tarn.decos.filter((d) => d.kind === 'arch').length,
    };
  }, zone);
  expect(decos, '前提：落点地带的 layout 须经 Worker RPC 拿到').not.toBeNull();
  expect(decos.spires, '祭坛地带不再生成紫晶柱（v2.31）').toBe(0);
  expect(decos.arches, '拱洞一根不少').toBe(5);
  expect(decos.total, '祭坛地带只剩 5 个装饰件').toBe(5);

  // ── ⑧ 广场内不得出现紫晶柱材质（判别力：真实世界里柱子确实消失了）──
  //    `block_of_quartz` 是干净标记：实测祭坛地带 8 座高台最近格距圆心 34.5、
  //    5 个拱洞 83.2，都 > TARN_PLAZA_RADIUS(28) ⇒ 广场内唯一可能的石英来源就是
  //    那 7 根紫晶柱（环半径 20）。⚠️ 不能用 `amethyst` —— v2.82 的祭坛外环与对角线自己就用它。
  const quartz = await page.evaluate(async (z) => {
    const g = window.__MC_GAME__;
    const reg = g.registry;
    const { TARN_PLAZA_RADIUS } = await import('/src/gen/structures/tarn-zone.js');
    const quartzId = reg.idOf('block_of_quartz');
    let hits = 0;
    for (let dx = -TARN_PLAZA_RADIUS; dx <= TARN_PLAZA_RADIUS; dx++) {
      for (let dz = -TARN_PLAZA_RADIUS; dz <= TARN_PLAZA_RADIUS; dz++) {
        if (Math.hypot(dx, dz) > TARN_PLAZA_RADIUS) continue;
        // 柱高实测最高 17 格，扫 plateauY..+20 足够覆盖整根柱子
        for (let dy = 0; dy <= 20; dy++) {
          if (g.world.getBlockId(z.cx + dx, z.plateauY + dy, z.cz + dz) === quartzId) hits++;
        }
      }
    }
    return hits;
  }, zone);
  expect(quartz, '祭坛地带广场内不得出现紫晶柱（block_of_quartz）').toBe(0);
});
