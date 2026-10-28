// tests/azalea-trees.spec.mjs — 杜鹃树 Tier 4（真实页面、数据级；不靠目视）
//
// 判据一律走数据层（world 的方块数据），断言必须能区分「树真的落地」与「什么都没发生」。
//
// ⚠️ **视域必须用真实的 `azaleaAllowedAtFor` 筛候选，不能按距离猜** —— 巨树 Epic 踩过：
// 按「离出生点最近」选的候选全在城市边界外、被 `pointContext` 拒掉，用例假失败。
import { test, expect } from 'playwright/test';

/** 与 tests/giant-trees.spec.mjs 同口径：GEN/MESH/上传/挂起全空 */
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

/** 统计已加载 column 里的杜鹃树方块（树干 / 无花叶 / 带花叶），以及树高分布 */
const countAzalea = (page) => page.evaluate(() => {
  const g = window.__MC_GAME__;
  const logId = g.registry.idOf('azalea_log');
  const leafId = g.registry.idOf('azalea_leaves');
  const flowerId = g.registry.idOf('azalea_flowers');
  let logs = 0, leaves = 0, flowers = 0;
  const heights = new Map(); // `${cx},${cz},${lx},${lz}` → 该列杜鹃方块的最高 y
  let minY = Infinity, maxY = -Infinity;
  for (const c of g.world.columns.values()) {
    const b = c.blocks;
    for (let i = 0; i < b.length; i++) {
      const id = b[i];
      if (id !== logId && id !== leafId && id !== flowerId) continue;
      if (id === logId) logs++; else if (id === leafId) leaves++; else flowers++;
      const y = Math.floor(i / 256) - 32; // blockIndex 的逆（constants.js:27-30）
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { logs, leaves, flowers, minY: logs ? minY : null, maxY: logs ? maxY : null };
});

/** 从已加载 layout 里找**真能落地**的杜鹃树候选（用真实 allowedAt 过一道），按距出生点升序 */
const realSpots = (page) => page.evaluate(async () => {
  const g = window.__MC_GAME__;
  const applyMod = await import('/src/gen/structures/apply.js');
  const idx = g.scheduler.structureIndex;
  const seed = 12345;
  let cityLayout = null;
  for (const l of idx._layouts.values()) if (l.city) cityLayout = l.city;
  const out = [];
  for (const l of idx._layouts.values()) {
    const a = l.azaleaTrees; if (!a || a.length === 0) continue;
    for (let i = 0; i < a.length; i += 4) {
      const wx = a[i], wz = a[i + 2];
      const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
      const layouts = idx.layoutsForColumn(cx, cz);
      const allowed = applyMod.azaleaAllowedAtFor(layouts, cityLayout, seed);
      // 九点采样与 isAzaleaTreeAllowed 同判据（AABB 最大 13×13，半宽 6）
      let ok = allowed(wx, wz);
      for (const dx of [-6, 0, 6]) for (const dz of [-6, 0, 6]) if (!allowed(wx + dx, wz + dz)) ok = false;
      if (!ok) continue;
      out.push({ x: wx, z: wz, d: Math.hypot(wx - g.spawnX, wz - g.spawnZ) });
    }
  }
  return out.sort((p, q) => p.d - q.d).slice(0, 3);
});

/**
 * 找**杜鹃林最密**的视域中心（用于密度用例）。
 *
 * ⚠️ 不能用 `realSpots`（它取「离出生点最近」）—— 最近的候选往往在 AZALEA 地块**边缘**，
 * 树很少（实测该处只有 8~9 棵）。密度用例需要地块内部，故按「周边能落地的候选数」排序。
 */
const densestSpots = (page) => page.evaluate(async () => {
  const g = window.__MC_GAME__;
  const applyMod = await import('/src/gen/structures/apply.js');
  const idx = g.scheduler.structureIndex;
  const seed = 12345;
  let cityLayout = null;
  for (const l of idx._layouts.values()) if (l.city) cityLayout = l.city;
  const ok = [];
  for (const l of idx._layouts.values()) {
    const a = l.azaleaTrees; if (!a || a.length === 0) continue;
    for (let i = 0; i < a.length; i += 4) {
      const wx = a[i], wz = a[i + 2];
      const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
      const layouts = idx.layoutsForColumn(cx, cz);
      const allowed = applyMod.azaleaAllowedAtFor(layouts, cityLayout, seed);
      const crown = applyMod.azaleaCrownAllowedAtFor(layouts, cityLayout, seed);
      if (!allowed(wx, wz)) continue;
      let ok2 = true;
      for (const dx of [-6, 0, 6]) for (const dz of [-6, 0, 6]) if (!crown(wx + dx, wz + dz)) ok2 = false;
      if (ok2) ok.push([wx, wz]);
    }
  }
  // 对每个候选数「136×136 视域内还有多少候选」，取最多的
  let best = null;
  for (const [wx, wz] of ok) {
    let n = 0;
    for (const [px, pz] of ok) if (Math.abs(px - wx) <= 68 && Math.abs(pz - wz) <= 68) n++;
    if (!best || n > best.n) best = { wx, wz, n };
  }
  return best ? [best] : [];
});

test('杜鹃树落地：AZALEA 视域里出现树干 + 两种叶（花叶相间生效，数据级）', async ({ page }) => {
  test.setTimeout(600_000);
  await openGame(page);
  const spots = await realSpots(page);
  expect(spots.length, '已加载的 layout 里有**能真正落地**的杜鹃树候选').toBeGreaterThan(0);

  let best = { logs: 0, leaves: 0, flowers: 0 };
  for (const s of spots) {
    await flyTo(page, s.x, s.z);
    const r = await countAzalea(page);
    if (r.logs > best.logs) best = r;
    if (best.logs > 100) break;
  }
  // 单棵树最小档 15 格树干、最大档 62；视域内应有多棵 → 阈值取实测量级的下界
  expect(best.logs, 'azalea_log 树干格数').toBeGreaterThan(100);
  expect(best.leaves, 'azalea_leaves 无花叶格数').toBeGreaterThan(500);
  expect(best.flowers, 'azalea_flowers 带花叶格数（30% 相间规则）').toBeGreaterThan(100);

  // ⚠️ **「花叶比 ≈ 30%」这条判据只能在纯函数层钉（test-azalea-trees.js），不能在页面层钉**：
  // 既有 8 个 JSON 结构本身就用 `azalea_leaves`/`azalea_flowers` 作装饰 —— 实测
  //   desert_temple_tube 16+4 / flower_bed 9+16 / jungle_pyramid 61+27 / pavilion 14+6 /
  //   tall_well 7+17 / tree_house 2+6 / ugly_house 30+2 / wood_house 20+14
  // 合计 ≈ 200 格不经过 azaleaFlowerAt。实测页面口径 33.9% vs 纯函数 29.4%，
  // mism 282/2716 —— 全部来自这些结构方块（诊断时按世界坐标复算、逐格比对确认）。
  // 页面层只断言「两种叶都存在」，把比例留给纯函数用例。
});

test('杜鹃树体量：是高 12~29 的大造型，不是旧的 6~8 格小树（数据级）', async ({ page }) => {
  test.setTimeout(600_000);
  await openGame(page);
  const spots = await realSpots(page);
  expect(spots.length).toBeGreaterThan(0);

  // 逐列统计「杜鹃方块的最高 y」，取最大值 = 最高那棵树的顶
  let topmost = null;
  for (const s of spots) {
    await flyTo(page, s.x, s.z);
    const r = await countAzalea(page);
    if (!r.logs) continue;
    if (!topmost || r.maxY - r.minY > topmost.span) topmost = { span: r.maxY - r.minY, minY: r.minY, maxY: r.maxY };
    if (topmost && topmost.span >= 12) break;
  }
  expect(topmost, '视域里至少有一处杜鹃方块').not.toBeNull();
  // 旧小树高 6~8（最高 8）→ 新造型最小档 12。阈值取 10 落在两侧实测值之间（8 与 12+）。
  expect(topmost.span, `视域内杜鹃树的纵向跨度 ${topmost.span}（旧小树 ≤8，新造型 ≥12）`).toBeGreaterThan(10);
});

test('杜鹃树替代：旧代码生成小树不再出现（AZALEA 视域里没有孤立的 5×5 小圆冠）', async ({ page }) => {
  test.setTimeout(600_000);
  await openGame(page);
  const spots = await realSpots(page);
  expect(spots.length).toBeGreaterThan(0);
  await flyTo(page, spots[0].x, spots[0].z);

  // 旧小树的判据：`azalea_log` 只有 4~6 格**竖直一列**、且叶团半径 ≤2。
  // 新树最小档也有 15 格树干（多列，y=0 层 1~6 列）。故「孤立单列 4~6 格树干」= 旧树残留。
  const newTrees = await countAzalea(page);
  const legacy = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const logId = g.registry.idOf('azalea_log');
    let isolatedColumns = 0;
    for (const c of g.world.columns.values()) {
      for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
        let n = 0, contiguous = true, prev = -99;
        for (let y = 0; y < 96; y++) {
          const id = c.blocks[lx + lz * 16 + y * 256];
          if (id !== logId) continue;
          n++;
          if (y !== prev + 1) contiguous = false;
          prev = y;
        }
        // 旧树：竖直连续 4~6 格的单列树干
        if (n >= 4 && n <= 6 && contiguous) isolatedColumns++;
      }
    }
    return isolatedColumns;
  });
  // 新造型的 y=0 层树干是 1~6 列，但树高 12~29 → 任何一列的竖直连续段都 ≥ 12（含地基填充）。
  // 故「竖直连续 4~6 格」只可能是旧树残留。阈值给 0：这类缺陷零容忍。
  expect(legacy, '旧代码生成小树的残留列数').toBe(0);

  // ⚠️ **必须同时断言「这里真的有新树」**（判别力下限）：断开阶段 2.85 接线时，
  // 上面那条 `legacy === 0` 仍然通过（世界里没有 azalea_log 的任何一列 → 残留数天然为 0），
  // 实测注入「断开接线」后本用例全绿 = 无效盲区。加上这条后，接线缺失会让本用例真 FAIL。
  expect(newTrees.logs, '同一视域里必须有新树的树干（否则「无残留」是恒真）').toBeGreaterThan(100);
});

test('杜鹃树干间距：与其他树的树干基部保持 ≥AZALEA_TRUNK_CLEARANCE 格（树叶不受限）', async ({ page }) => {
  test.setTimeout(600_000);
  await openGame(page);
  // ⚠️ 必须用**最密集**视域（`densestSpots`），不能用 `realSpots`：
  // 后者取的「最近候选」常在地块边缘，那里几乎没有其他树 → 判据注入 `clearance=0` 后
  // 仍然全绿（实测**无效盲区**）。最密集处才有其他树的树干可供对照。
  const spots = await densestSpots(page);
  expect(spots.length, '有能落地的杜鹃树').toBeGreaterThan(0);
  await flyTo(page, spots[0].wx, spots[0].wz);

  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    // ⚠️ **阈值必须从常量派生，不得写死**（v2.5 曾把 6 改成 3，写死的 6 立刻假失败）。
    const az = await import('/src/gen/structures/azalea-trees.js');
    const CLEAR = az.AZALEA_TRUNK_CLEARANCE;
    const AZ = g.registry.idOf('azalea_log');
    const OTHER = new Set(['wood', 'birch_log', 'dark_oak', 'sky_wood', 'giant_oak_log', 'giant_mangrove_log']
      .map((n) => g.registry.idOf(n)).filter((x) => x !== undefined));
    const A = [], B = [];
    // ⚠️ 扫描高度带也要与判据同源（`GIANT_TRUNK_SCAN_MAX_Y`）：判据只看 y≤24 的树干，
    // 这里用全高度会把巨树 y>24 的段算成「另一棵树长在这里」（实测误报 360 处）。
    const MAX_Y = az.GIANT_TRUNK_SCAN_MAX_Y;
    for (const c of g.world.columns.values()) {
      for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) for (let y = 0; y < 128; y++) {
        const id = c.blocks[lx + lz * 16 + y * 256]; if (!id) continue;
        const wy = y - 32;
        if (wy < 0 || wy > MAX_Y) continue;
        if (id === AZ) A.push([c.cx * 16 + lx, c.cz * 16 + lz]);
        else if (OTHER.has(id)) B.push([c.cx * 16 + lx, c.cz * 16 + lz]);
      }
    }
    const uA = [...new Map(A.map((p) => [p.join(','), p])).values()];
    const uB = [...new Map(B.map((p) => [p.join(','), p])).values()];
    let minD = Infinity, nLT = 0;
    for (const p of uA) {
      for (const q of uB) {
        const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
        if (d < minD) minD = d;
        if (d < CLEAR) nLT++;
      }
    }
    return { CLEAR, azCols: uA.length, otherCols: uB.length,
      minD: Number.isFinite(minD) ? +minD.toFixed(2) : null, nLT };
  });
  expect(r.azCols, '视域里有杜鹃树干（判据必须有量）').toBeGreaterThan(50);
  expect(r.otherCols, '视域里有其他树干（对照，防恒真）').toBeGreaterThan(50);
  // 判据：>= AZALEA_TRUNK_CLEARANCE（闭区间，恰好等距算通过）。
  expect(r.nLT, `${r.nLT} 对杜鹃树干与其他树干相距 <${r.CLEAR} 格（最小 ${r.minD}）`).toBe(0);
});

test('杜鹃树密度：C=8 下视域里成密集林（≥ 15 棵）', async ({ page }) => {
  test.setTimeout(600_000);
  await openGame(page);
  // 密度用例取「最密集处」的视域（见 densestSpots 的注释：最近候选常在地块边缘）
  const spots = await densestSpots(page);
  expect(spots.length).toBeGreaterThan(0);
  await flyTo(page, spots[0].wx, spots[0].wz);
  const r = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const AZ = g.registry.idOf('azalea_log');
    const cols = [];
    for (const c of g.world.columns.values())
      for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) for (let y = 0; y < 128; y++)
        if (c.blocks[lx + lz * 16 + y * 256] === AZ) { cols.push([c.cx * 16 + lx, c.cz * 16 + lz]); break; }
    // 按连通聚成「树」（同一棵树的树干列彼此相邻）
    const setA = new Set(cols.map((p) => p.join(',')));
    const seen = new Set(); let trees = 0;
    for (const p of cols) {
      const k = p.join(','); if (seen.has(k)) continue;
      trees++; seen.add(k);
      const st = [p];
      while (st.length) {
        const [x, z] = st.pop();
        for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
          const nk = (x + dx) + ',' + (z + dz);
          if (setA.has(nk) && !seen.has(nk)) { seen.add(nk); st.push([x + dx, z + dz]); }
        }
      }
    }
    return { trees, cols: cols.length };
  });
  // C=16 约 13 棵；C=13 约 20 棵；C=11（v2.4）密度 ×1.40 → 约 28 棵。
  // 阈值仍取 15（不贴线）—— 它钉的是「成林」这个量级，不是标定密度；
  // 真正的密度口径在 `test-azalea-trees` 的 C 常量断言与 `[杜鹃树]` 门禁里。
  expect(r.trees, `视域内杜鹃树 ${r.trees} 棵（C=13 时约 20 棵，C=11 应约 28 棵）`).toBeGreaterThan(15);
});

test('杜鹃叶贴图：叶面覆盖高于普通树叶（8% 孔洞率，不是 15%），且带花叶与纯叶同档', async ({ page }) => {
  // 用户 2026-10-28：「杜鹃花树的树叶方块镂空感太强烈，参照普通树的树叶，减少镂空感」。
  // 判据必须落在**真实 atlas 像素**上，不能只读常量 —— 常量对了但忘了跑烘焙/atlas，
  // 画面上仍是旧贴图（`check:data` 抓产物过期，这条抓「atlas 里装的是哪张」）。
  await page.goto('/');
  await page.waitForFunction(() => window.__MC_GAME__?._atlasTexture, null, { timeout: 60000 });
  const r = await page.evaluate(async () => {
    const t = window.__MC_GAME__._atlasTexture;
    const src = t.image?.bitmap || t.image?.source?.data || t.image;
    const W = src.width, H = src.height;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const cx = cv.getContext('2d');
    cx.drawImage(src, 0, 0);
    const at = await (await fetch('/assets/atlas.json')).json();
    // 在 atlas 里按 tile 的 uv 取 16×16，数「会被 alphaTest(0.3) 剔除」的像素
    const holeRatio = (name) => {
      const tile = at.tiles[name];
      if (!tile) return null;
      const x = Math.round(tile.x), y = Math.round(tile.y);
      const d = cx.getImageData(x, y, 16, 16).data;
      let holes = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] / 255 < 0.3) holes++;
      return holes / 256;
    };
    return {
      azalea: holeRatio('procedural/leaf_azalea_leaves'),
      azaleaFlowers: holeRatio('procedural/leaf_azalea_flowers'),
      common: holeRatio('procedural/leaf_leaves'),
    };
  });
  expect(r.azalea, 'atlas 里有杜鹃叶 tile').not.toBeNull();
  expect(r.azaleaFlowers, 'atlas 里有杜鹃带花叶 tile').not.toBeNull();
  expect(r.common, 'atlas 里有普通树叶 tile').not.toBeNull();

  // 主判据：杜鹃叶面覆盖**必须高于**普通树叶（8% < 15% 孔洞）
  expect(r.azalea, `杜鹃叶孔洞 ${(r.azalea * 100).toFixed(1)}% 应明显低于普通树叶 ${(r.common * 100).toFixed(1)}%`)
    .toBeLessThan(r.common - 0.03);
  // 带花叶必须与纯叶同档（旧实现它指向未压缩原图，比纯叶还稀）
  expect(Math.abs(r.azaleaFlowers - r.azalea),
    `带花叶孔洞 ${(r.azaleaFlowers * 100).toFixed(1)}% 应与纯叶 ${(r.azalea * 100).toFixed(1)}% 同档`)
    .toBeLessThanOrEqual(0.01);
  // 下界：不能压成实心色板（用户要的是「减少镂空」，不是「没有镂空」）
  expect(r.azalea, '杜鹃叶仍须保留孔洞纹理').toBeGreaterThan(0.03);
});

test('杜鹃树高矮错落：相邻树的档位类别不扎堆（真实世界，正交相邻率远低于独立抽签）', async ({ page }) => {
  // 用户 2026-10-28：「高树和矮树错略相间一些，别一下子高树扎堆，或者矮树扎堆」。
  // 后来（v2.3）用户又选了两类棋盘方案，要求「一个高树挨着它的应该是矮树」。
  //
  // ⚠️ **判据口径在 v2.3 变了，不能继续用「8 邻域同类率」**：
  // 棋盘结构下**对角相邻必然同类**（数学后果）⇒ 8 邻域同类率恒 ≈ 50%，
  // 不可能低于两类独立抽签的 Σp² = 0.58。继续用旧口径会把正确实现判 FAIL。
  // 现判据：**正交相邻**（玩家真正“挨着”的方向）同类型率。
  // 实测（三 seed，真实 accepted 树）：棋盘 SC=9 → 全国 0.046，v2.2 三类 → 0.21。
  test.setTimeout(300000);
  await openGame(page);
  const r = await page.evaluate(async () => {
    const az = await import('/src/gen/structures/azalea-trees.js');
    const data = await az.loadAzaleaTrees();
    const g = window.__MC_GAME__;
    const idx = g.scheduler.structureIndex;
    const layouts = [...idx._layouts.values()].filter(Boolean);
    let lx0 = Infinity, lx1 = -Infinity, lz0 = Infinity, lz1 = -Infinity;
    for (const l of layouts) {
      const x0 = l.regionX * 400, z0 = l.regionZ * 400;
      lx0 = Math.min(lx0, x0); lx1 = Math.max(lx1, x0 + 399);
      lz0 = Math.min(lz0, z0); lz1 = Math.max(lz1, z0 + 399);
    }
    const trees = az.collectAzaleaTrees(layouts, 12345, data.variants,
      { minX: lx0, maxX: lx1, minZ: lz0, maxZ: lz1 }, 3)
      .map((t) => ({ wx: t.wx, wz: t.wz, cls: az.azaleaHeightClass(t.variant.h), h: t.variant.h }));
    // cell 下标（与候选层同一个 C）
    const C = az.AZALEA_TREE_PATH.spacing + az.AZALEA_TREE_PATH.jitter;
    const byCell = new Map();
    for (const t of trees) byCell.set(`${Math.floor(t.wx / C)},${Math.floor(t.wz / C)}`, t);
    // ① 正交相邻同类率（主指标）
    let same = 0, tot = 0;
    let dLe4 = 0, dTot = 0;
    for (const [key, t] of byCell) {
      const [i, j] = key.split(',').map(Number);
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const o = byCell.get(`${i + di},${j + dj}`);
        if (!o) continue;
        tot++;
        if (o.cls === t.cls) same++;
        dTot++;
        if (Math.abs(o.h - t.h) <= 4) dLe4++;
      }
    }
    // ② 两类分布（棋盘 ⇒ 必然 50/50）
    const cnt = [0, 0];
    for (const t of trees) cnt[t.cls]++;
    return { n: trees.length, rate: same / Math.max(1, tot), tot,
      dhLe4: dLe4 / Math.max(1, dTot), cnt, frac: cnt.map((v) => v / trees.length) };
  });
  expect(r.n, '有杜鹃树').toBeGreaterThan(50);
  expect(r.tot, '有正交相邻对（判据必须有量）').toBeGreaterThan(50);
  // 主判据：正交相邻同类率必须远低于两类独立抽签的 Σp² = 0.58
  // 实测 0.046（SC=9）；v2.2 三类方案是 0.21。阈值 0.20 两侧不贴线。
  expect(r.rate, `正交相邻同类率 ${r.rate.toFixed(3)} 应远低于两类独立抽签的 0.58（实测 0.046）`)
    .toBeLessThan(0.20);
  // 相邻 |Δh| ≤ 4（肉眼基本一样高）的占比：实测 0.074，v2.2 是 0.367
  expect(r.dhLe4, `正交相邻 |Δh|≤4 占 ${(r.dhLe4 * 100).toFixed(1)}% 应低于 20%（实测 7.4%，v2.2 三类 36.7%）`)
    .toBeLessThan(0.20);
  // 两类分布 50/50（棋盘结构的数学后果，与各类档位数无关）
  expect(Math.abs(r.frac[0] - 0.5), `矮类占比 ${r.frac[0].toFixed(3)} 应 ≈ 0.5`).toBeLessThan(0.08);
});
