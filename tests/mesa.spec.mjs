// tests/mesa.spec.mjs — Cloudland 高台 Tier 4：真实页面里的落位与高度
//
// 为什么需要 Tier 4（浏览器内单测测不到）：
//   · 单测直接调 applyStructuresToColumn，验的是「函数写对了」；
//     真实页面验的是「接线通了 + column 调度真的把方块送上屏」。
//   · 单测用「台顶层 y=43 有方块」数数，但**没验台体的实际高度是否真的高出地形** ——
//     若 floorY 算错到地形以下，单测的「类型对得上」仍然会过（被地形覆盖处算作非 air）。
//
// ⚠️ 必须先 `setShadowsEnabled(false)`：VSM 下 receiveShadow 的对象也进阴影 pass
// （AGENTS.md 的阴影约束），会让 drawCalls 与本 spec 无关地波动。
// ⚠️ 传送玩家用 `player.physics.pos`（不是 `player.position`）+ 定时 pin，见 giant-tree-budget.spec.mjs。
import { test, expect } from 'playwright/test';

const SEED = 12345;
/**
 * 合法落位的对照 region。
 * ⚠️ 不能再用 region(0,0)/(1,1)：间距去重（MESA_MIN_SPACING=384）上线后它们的锚点都被邻居让位。
 * region(-1,-1) 实测 anchor=(-59,-59)，离出生点 385 格。
 */
const RX = -1, RZ = -1;

/** 队列收敛（唯一权威来自 giant-tree-budget.spec.mjs，同一份判据） */
const queueConverged = () => {
  const s = window.__MC_GAME__.scheduler;
  return s._inflightGen.size === 0 && s._meshQueue.length === 0 && s._inflightMesh.size === 0 &&
         s._uploadQueue.length === 0 && s._pendingMesh.size === 0 && s._lightQueue.size === 0 && s._inflightLight.size === 0;
};

/** 传送到 (x, z) 并钉住位置（物理会把人挪走），y 给 70 避免卡在地形里 */
async function teleport(page, x, z, y = 70) {
  await page.evaluate(([px, pz, py]) => {
    clearInterval(window.__PIN__);
    const p = window.__MC_GAME__.player.physics;
    p.pos.x = px; p.pos.y = py; p.pos.z = pz;
    p.vel.x = p.vel.y = p.vel.z = 0;
    window.__PIN__ = setInterval(() => { p.pos.x = px; p.pos.z = pz; p.pos.y = py; p.vel.y = 0; }, 30);
  }, [x, z, y]);
}

/** 等目标周围的 column 全部加载 + 队列收敛 */
async function settle(page, x, z) {
  await page.waitForFunction(([px, pz]) => {
    const g = window.__MC_GAME__; const cx = Math.floor(px / 16), cz = Math.floor(pz / 16);
    for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) if (!g.world.hasColumn(cx + dx, cz + dz)) return false;
    return true;
  }, [x, z], { timeout: 180_000 });
  await page.waitForFunction(queueConverged, null, { timeout: 180_000 });
}

/** 清理 pin（每个用例结束时调用，避免影响后续） */
async function unpin(page) {
  await page.evaluate(() => clearInterval(window.__PIN__));
}

test('高台：真实页面里沙漠锚点处真的长出了高台（台顶层命中 palette 方块）', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(`/?seed=${SEED}&vd=8`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 120_000 });
  await page.evaluate(() => window.__MC_GAME__.setShadowsEnabled(false));

  const anchor = await page.evaluate(async ({ rx, rz, seed }) => {
    const m = await import('/src/gen/structures/mesa.js');
    return m.computeMesaAnchor(rx, rz, seed);
  }, { rx: RX, rz: RZ, seed: SEED });
  expect(anchor).not.toBeNull();

  await teleport(page, anchor.wx + 32, anchor.wz + 32);
  await settle(page, anchor.wx, anchor.wz);

  // ⚠️ 判据**不能**用「台顶比周边地表高 N 格」：实测该处方圆 50 格内本来就有 35 格高的
  // 地形/建筑，`topY - groundMedian` 在**注掉光栅化后仍然 = 28**，判据恒真（负向验证抓不到）。
  // 正确判据 = 台顶层（y=floorY+43）上真的出现了高台 palette 的方块，且数量与产物一致。
  const r = await page.evaluate(async ({ wx, wz, floorY }) => {
    const g = window.__MC_GAME__;
    const reg = g.registry;
    const json = await (await fetch('/assets/structures/cloudland_mesa_small.json')).json();
    const palIds = new Set(json.palette.map((n) => reg.idOf(n)));
    // 产物在 y=43 层有多少格（全量），以及锚点占地内命中多少
    let producedTop = 0;
    for (let i = 1; i < json.blocks.length; i += 4) if (json.blocks[i] === 43) producedTop++;
    let hits = 0;
    for (let dz = -11; dz <= 11; dz++) {
      for (let dx = -11; dx <= 11; dx++) {
        if (palIds.has(g.world.getBlockId(wx + dx, floorY + 43, wz + dz))) hits++;
      }
    }
    return { producedTop, hits };
  }, { wx: anchor.wx, wz: anchor.wz, floorY: anchor.floorY });

  await unpin(page);

  // sanity：产物本身在 y=43 层有格（否则判据无意义）
  expect(r.producedTop).toBeGreaterThan(100);
  // 真实世界里的命中数应与产物同量级（实测 216 = 产物的全部顶层格）
  expect(r.hits).toBeGreaterThan(r.producedTop * 0.9);
});

test('高台：全世界的高台互不靠近（一块沙漠一个）+ 都落在沙漠采样点上', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(`/?seed=${SEED}&vd=4`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 120_000 });

  const r = await page.evaluate(async ({ seed }) => {
    const m = await import('/src/gen/structures/mesa.js');
    const n = await import('/src/gen/noise.js');
    m.clearMesaAnchorCache();
    const list = [];
    for (let rx = -6; rx <= 6; rx++) for (let rz = -6; rz <= 6; rz++) {
      const a = m.computeMesaAnchor(rx, rz, seed);
      if (a) list.push(a);
    }
    let minD = Infinity;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const d = Math.max(Math.abs(list[i].wx - list[j].wx), Math.abs(list[i].wz - list[j].wz));
      if (d < minD) minD = d;
    }
    // 每个锚点中心必须是沙漠
    let notDesert = 0;
    for (const a of list) if (n.getBiome(a.wx, a.wz, seed) !== 'DESERT') notDesert++;
    return { count: list.length, minD, notDesert, spacing: m.MESA_MIN_SPACING };
  }, { seed: SEED });

  // 真实页面里跑的是同一份模块（不是 Node 侧复算），所以这条钉的是「浏览器里的实现也遵守间距」
  expect(r.count).toBeGreaterThan(20);
  expect(r.minD).toBeGreaterThanOrEqual(r.spacing);
  expect(r.notDesert).toBe(0);
});
