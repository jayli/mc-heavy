import { test, expect } from 'playwright/test';

// 高台地带祭坛（v2.30）Tier 4 验收。
//
// 用户 2026-10-31：「把祭坛的造型内化到代码里，放到距离 City 最近的一个高台地带里，
// 因为在设置面板中，点击瞬移区域的『高台』，就会移动到距离 City 最近的一个高台」。
//
// ⚠️ **必须走真实用户路径**（设置面板「高台」按钮），不能只调 `game.teleportToTarnZone()`
// —— M7 教训（验收报告 §3.7）：只测 Game API 时「面板没接线 / Worker RPC 丢字段」这类
// 缺陷全绿通过，玩家实玩立刻发现。本 spec 验三件浏览器单测（test-tarn-altar.js）验不到的事：
//   ① `layout.altar` 标志经 Worker 'layout' RPC（结构化克隆）往返后仍在；
//   ② 真实 Worker 池 GEN 路径（不是本地 applyStructuresToColumn）真的写出了祭坛；
//   ③ 玩家按「高台」按钮落到的那个地带，就是带祭坛的那个。
//
// 祭坛 = 两层：地表图案（y = plateauY，替换广场材质）+ 中心神龛（dy 1~2，唯一突出地面）。
// 紫晶柱不受影响：柱基（后写胜）压在祭坛地表格上 —— 正好复现用户存档里「东臂缺 7 格、
// 对角线缺 3 格」的形态（那 10 格被柱基占了）。

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

  // ── ④ 神龛（唯一突出地面的部分）逐格核对 —— 紫晶柱到不了 dy≥1，无覆盖干扰 ──
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

  // ── ⑤ 中心 3×3（debris 心 + diamond 边 + gold 角）—— 半径 ≤1.4，紫晶柱（环 20）到不了 ──
  const center = await page.evaluate((z) => {
    const g = window.__MC_GAME__;
    const reg = g.registry;
    const at = (dx, dz) => reg.nameOf(g.world.getBlockId(z.cx + dx, z.plateauY, z.cz + dz));
    return {
      mid: at(0, 0),
      edges: [at(1, 0), at(-1, 0), at(0, 1), at(0, -1)],
      corners: [at(1, 1), at(1, -1), at(-1, 1), at(-1, -1)],
    };
  }, zone);
  expect(center.mid, '中心是 debris').toBe('debris');
  expect(center.edges, '四正是 diamond').toEqual(['diamond', 'diamond', 'diamond', 'diamond']);
  expect(center.corners, '四角是 gold_block').toEqual(['gold_block', 'gold_block', 'gold_block', 'gold_block']);

  // ── ⑥ 地表图案整体：图案格要么是祭坛方块、要么被紫晶柱基座覆盖（柱赢）──
  //    与 test-tarn-altar.js 的「真实 GEN 逐格落地」同判据，但跑在真实游戏页 + Worker 池上。
  const surface = await page.evaluate(async (z) => {
    const g = window.__MC_GAME__;
    const reg = g.registry;
    const { altarSurfaceBlockAt, ALTAR_ARM_LENGTH } = await import('/src/gen/structures/tarn-altar.js');
    const { resourceUrl } = await import('/src/core/resource-url.js');
    const m = await import('/src/gen/structures/tarn-zone.js');
    const lay = m.computeTarnZone(z.regionX, z.regionZ, g.seed);

    // 预计算紫晶柱基座占用的格（b.y===1 → 世界 y = plateauY，与祭坛地表同层）
    const spireBase = new Map();
    for (const d of lay.decos.filter((x) => x.kind === 'spire')) {
      const wx = Math.round(lay.cx + d.ring * Math.cos(d.ang));
      const wz = Math.round(lay.cz + d.ring * Math.sin(d.ang));
      const j = await (await fetch(resourceUrl(`assets/structures/${d.variant}.json`))).json();
      const stride = j.stride || 4;
      for (let i = 0; i < j.blocks.length; i += stride) {
        if (j.blocks[i + 1] !== 1) continue;
        spireBase.set(`${wx + j.blocks[i] - lay.cx},${wz + j.blocks[i + 2] - lay.cz}`, j.palette[j.blocks[i + 3]]);
      }
    }

    let placed = 0, overridden = 0;
    const wrong = [];
    for (let dx = -ALTAR_ARM_LENGTH; dx <= ALTAR_ARM_LENGTH; dx++) {
      for (let dz = -ALTAR_ARM_LENGTH; dz <= ALTAR_ARM_LENGTH; dz++) {
        const b = altarSurfaceBlockAt(dx, dz);
        if (!b) continue;
        const got = reg.nameOf(g.world.getBlockId(z.cx + dx, z.plateauY, z.cz + dz));
        const spire = spireBase.get(`${dx},${dz}`);
        if (spire !== undefined) {
          if (got === spire) overridden++;
          else wrong.push(`(${dx},${dz}) 柱基应 ${spire} 实 ${got}`);
        } else if (got === b.type) {
          placed++;
        } else {
          wrong.push(`(${dx},${dz}) 应 ${b.type} 实 ${got}`);
        }
      }
    }
    return { placed, overridden, wrong };
  }, zone);
  expect(surface.wrong, `地表图案逐格落地：${surface.wrong.slice(0, 5).join('；')}`).toEqual([]);
  expect(surface.placed + surface.overridden, '185 格图案全部有着落').toBe(185);
  expect(surface.overridden, '判别力：真实世界里必有柱基覆盖祭坛格（复现用户存档的缺口形态）').toBeGreaterThan(0);
  expect(surface.placed, '判别力：绝大多数图案格由祭坛自己落地').toBeGreaterThan(150);

  // ── ⑦ 紫晶柱不受影响：祭坛地带仍是 12 个装饰件（5 拱洞 + 7 紫晶柱）──
  const decos = await page.evaluate((z) => {
    const m = window.__MC_GAME__.scheduler.structureIndex._layouts.get(`${z.regionX},${z.regionZ}`);
    return m && m.tarn ? m.tarn.decos.length : null;
  }, zone);
  expect(decos, '祭坛地带的装饰件数量不变（紫晶柱全保留）').toBe(12);
});
