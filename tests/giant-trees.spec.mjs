// tests/giant-trees.spec.mjs — 巨树景观 Tier 4（真实页面、数据级；不靠目视）
// 判据一律走数据层（world 的方块数据），断言必须能区分「树真的落地」与「什么都没发生」。
import { test, expect } from 'playwright/test';

/** 与 tests/sky-structures.spec.mjs 同口径：GEN/MESH/上传/挂起全空 */
const queueConverged = () => {
  const s = window.__MC_GAME__.scheduler;
  return s._inflightGen.size === 0 && s._meshQueue.length === 0 && s._inflightMesh.size === 0 &&
         s._uploadQueue.length === 0 && s._pendingMesh.size === 0 && s._lightQueue.size === 0 && s._inflightLight.size === 0;
};

async function openGame(page) {
  await page.goto('/?vd=8&seed=12345');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 120_000 });
  await page.waitForFunction(() => window.__MC_GAME__.world.columns.size >= 289, null, { timeout: 180_000 });
  await page.waitForFunction(queueConverged, null, { timeout: 180_000 });
}

/** 传送并钉住（物理会把玩家拉回地面，钉住才能稳定停在视域中心），等周围 17×17 列就绪 + 队列收敛 */
async function flyTo(page, x, z, y = 70) {
  await page.evaluate(([x, z, y]) => {
    const g = window.__MC_GAME__; clearInterval(window.__PIN__);
    const p = g.player.physics; p.pos.x = x; p.pos.y = y; p.pos.z = z; p.vel.x = p.vel.y = p.vel.z = 0;
    window.__PIN__ = setInterval(() => { p.pos.x = x; p.pos.z = z; p.pos.y = y; p.vel.y = 0; }, 30);
  }, [x, z, y]);
  await page.waitForFunction(([x, z]) => {
    const g = window.__MC_GAME__; const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
    for (let dx = -8; dx <= 8; dx++) for (let dz = -8; dz <= 8; dz++) if (!g.world.hasColumn(cx + dx, cz + dz)) return false;
    return true;
  }, [x, z], { timeout: 180_000 });
  await page.waitForFunction(queueConverged, null, { timeout: 180_000 });
}

/** 统计已加载 column 里各 giant_* 方块的数量，以及落在城市 bounds 内的数量 */
const countGiants = (page) => page.evaluate(() => {
  const g = window.__MC_GAME__;
  const names = ['giant_oak_log', 'giant_mangrove_log', 'giant_oak_leaves', 'giant_birch_leaves', 'giant_spruce_leaves',
    'giant_cherry_leaves', 'giant_palm_leaves', 'giant_banyan_leaves'];
  const idToName = new Map(names.map((n) => [g.registry.idOf(n), n]));
  let city = null;
  for (const l of g.scheduler.structureIndex._layouts.values()) if (l.city) city = l.city;
  const per = Object.fromEntries(names.map((n) => [n, 0]));
  let total = 0, inCity = 0;
  for (const c of g.world.columns.values()) {
    const b = c.blocks;
    for (let i = 0; i < b.length; i++) {
      const n = idToName.get(b[i]); if (!n) continue;
      per[n]++; total++;
      if (city) {
        const lx = i & 15, lz = (i >> 4) & 15; const wx = c.cx * 16 + lx, wz = c.cz * 16 + lz;
        if (wx >= city.minX && wx <= city.maxX && wz >= city.minZ && wz <= city.maxZ) inCity++;
      }
    }
  }
  return { per, total, inCity, hasCity: !!city };
});

test('巨树落地（三条路径）：森林/海边/榕树带视域里出现各族的方块（数据级）', async ({ page }) => {
  test.setTimeout(600_000);
  await openGame(page);
  // 视域取 spec 勘查用的 column 坐标：(-20,10) 森林为主；(10,40) 海边；榕树带用「最近的 banyan 候选」
  await flyTo(page, -20 * 16 + 8, 10 * 16 + 8);
  const forest = await countGiants(page);
  expect(forest.per.giant_oak_leaves + forest.per.giant_birch_leaves + forest.per.giant_spruce_leaves,
    'A 森林：高橡/白桦/雪松的叶').toBeGreaterThan(2000);
  expect(forest.per.giant_oak_log, 'A 森林：树干').toBeGreaterThan(50);

  // B 海边：同理，**不能钉死一个固定坐标**。区域门控（`patchChance=1/3`）让「(10,40) 这个视域」
  // 恰好落在被跳过的粗格里时一棵椰树都没有（实测该坐标从 11,208 方块降到 4,910，但仍过阈值；
  // 真正的风险是换 seed/换视域后归零）。改为取一个**真的产出了 beach 候选**的粗格中心飞过去。
  await flyTo(page, 10 * 16 + 8, 40 * 16 + 8);
  let coast = await countGiants(page);
  let coastOk = coast.per.giant_cherry_leaves + coast.per.giant_palm_leaves > 1000;
  if (!coastOk) {
    // 兵底：从已加载 layout 里找一个 beach 候选真的存在的点（候选已含区域门控）
    const spot = await page.evaluate(() => {
      const g = window.__MC_GAME__;
      for (const l of g.scheduler.structureIndex._layouts.values()) {
        const a = l.giantTrees && l.giantTrees.beach;
        if (a && a.length) return { x: a[0], z: a[2] };
      }
      return null;
    });
    expect(spot, '已加载 layout 里有 beach 候选（区域门控后仍有海滩长树）').not.toBeNull();
    await flyTo(page, spot.x, spot.z);
    coast = await countGiants(page);
    coastOk = coast.per.giant_cherry_leaves + coast.per.giant_palm_leaves > 1000;
  }
  expect(coastOk, `B 海边：樱花/椰子叶（首选址实测 ${coast.per.giant_cherry_leaves + coast.per.giant_palm_leaves}）`).toBe(true);

  // 榕树带：取离出生点最近的若干 banyan 候选，传送过去，该视域里必须出现榕树的叶或红树干。
  //
  // ⚠️ **必须用真实落位判据筛候选，不能只看「最近」**（2026-10-23 密度减半时踩到）：出生点在城市中心，
  // 离它最近的 banyan 候选全在城**南边界外侧几格**（z ≈ -160~-180），而这些树的 AABB 直径 13~17
  // → 九点中有落在城市 bounds（z ≥ -166）内的 → 被 `pointContext` 拒绝、根本不落地。
  // BASE 口径（8/6）下视域里恰好还有一棵更远的能过判据的树（(243,-179)）撑着断言，密度减半后那棵也没了
  // → 实测 0，断言真 FAIL。故这里改为：先把候选按 **真实的 `giantAllowedAtFor` + 排除盒** 过一道，
  // 只保留真能落地的点再飞过去 —— 判据描述真实世界，不描述想象中的世界（testing-policy §2.6 ⑤）。
  const spots = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const applyMod = await import('/src/gen/structures/apply.js');
    const gi = await import('/src/gen/structures/giant-trees.js');
    const idx = g.scheduler.structureIndex;
    const seed = 12345;
    const treeData = await (await fetch('/assets/giant-trees/trees.json')).json();
    const families = {};
    for (const [fam, list] of Object.entries(treeData.trees)) {
      families[fam] = list.map((v) => ({ ...v, cells: Uint8Array.from(v.blocks) }));
    }
    let cityLayout = null;
    for (const l of idx._layouts.values()) if (l.city) cityLayout = l.city;

    const out = [];
    for (const l of idx._layouts.values()) {
      const a = l.giantTrees && l.giantTrees.banyan; if (!a) continue;
      for (let i = 0; i < a.length; i += 5) {
        const wx = a[i], wz = a[i + 2];
        const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
        const layouts = idx.layoutsForColumn(cx, cz);
        const win = { minX: cx * 16, maxX: cx * 16 + 15, minZ: cz * 16, maxZ: cz * 16 + 15 };
        const boxes = gi.collectExclusionBoxes(layouts, win, 3);
        const allowed = applyMod.giantAllowedAtFor(layouts, cityLayout, seed);
        const trees = gi.collectGiantTrees(layouts, seed, families, win, 3).filter((t) => t.wx === wx && t.wz === wz);
        if (trees.length === 0) continue;
        if (!gi.isGiantTreeAllowed(trees[0], allowed, boxes)) continue;
        out.push({ x: wx, z: wz, d: Math.hypot(wx - g.spawnX, wz - g.spawnZ) });
      }
    }
    return out.sort((p, q) => p.d - q.d).slice(0, 3);
  });
  expect(spots.length, '已加载的 layout 里有**能真正落地**的榕树候选').toBeGreaterThan(0);
  let banyanBlocks = 0;
  for (const s of spots) {
    await flyTo(page, s.x, s.z);
    const r = await countGiants(page);
    banyanBlocks = Math.max(banyanBlocks, r.per.giant_banyan_leaves + r.per.giant_mangrove_log);
    if (banyanBlocks > 200) break;
  }
  expect(banyanBlocks, 'C 榕树带：榕树叶/红树干').toBeGreaterThan(200);
});

test('巨树让路：城市 bounds 内零巨树方块，城外有（数据级，真实世界）', async ({ page }) => {
  test.setTimeout(600_000);
  await openGame(page);
  // 城市西缘：视域里既有城内也有城外
  await flyTo(page, 0, 117);
  const r = await countGiants(page);
  expect(r.hasCity, '已加载的 layout 里有城市布局').toBe(true);
  expect(r.total, '视域里城外确有巨树（对照，防恒真）').toBeGreaterThan(0);
  expect(r.inCity, '城市 bounds 内不得有巨树方块').toBe(0);
});
