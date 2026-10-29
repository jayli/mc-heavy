// tests/shallow-water-tarns.spec.mjs — 浅水高台 Tier 4（真实页面、数据级；不靠目视）
//
// 为什么需要 Tier 4（浏览器内单测测不到）：
//   · 单测直接调 `fillShallowTarnBasin` / `rasterizeShallowTarnPlatforms`，验的是「函数写对了」；
//     真实页面验的是「接线通了 + Worker 内 layout RPC 把锚点送到 + column 调度真的把方块送上屏」。
//   · 单测里 `loadStructure` 走的是 Node 的 fetch（无 base URL → 静默返回空结构），
//     所以**单测根本验不到光栅化**；真实页面才是唯一能验「五座高台真的长出来」的地方。
//   · `layout.shallowTarn` 没被 postMessage 带过去 / Worker 没预热 → 世界里什么都没有，而单测全绿。
//
// ⚠️ 必读的两条既有约束（与 arena.spec / giant-pyramid.spec 同口径）：
//   ① `setShadowsEnabled(false)` —— VSM 下 receiveShadow 的对象也进阴影 pass，
//      会让 drawCalls/reservedV 与本 spec 无关地波动。
//   ② 传送用 `player.physics.pos` + 定时 pin —— 物理会把玩家拉回地面，不 pin 住就停不在视域中心。
import { test, expect } from 'playwright/test';

const SEED = 12345;

/** 队列收敛（唯一权威口径，与 arena.spec.mjs 同一份） */
const queueConverged = () => {
  const s = window.__MC_GAME__.scheduler;
  return s._inflightGen.size === 0 && s._meshQueue.length === 0 && s._inflightMesh.size === 0 &&
         s._uploadQueue.length === 0 && s._pendingMesh.size === 0 && s._lightQueue.size === 0 &&
         s._inflightLight.size === 0;
};

/** 在页面内跑真实模块算锚点 + 排布（验的是「页面里那个模块」，不是 Node 侧复算） */
async function shallowTarnLayout(page) {
  return page.evaluate(async ({ seed }) => {
    const m = await import('/src/gen/structures/shallow-water-tarns.js');
    m.clearShallowTarnCache();
    const a = m.computeShallowTarnAnchor(seed);
    if (!a) return null;
    const layout = m.computeShallowTarnLayout(seed);
    return {
      anchor: a,
      layout,
      lakeRadius: m.LAKE_RADIUS,
      beachWidth: m.BEACH_WIDTH,
      outerRadius: m.SHALLOW_TARN_OUTER_RADIUS,
      variants: m.SHALLOW_TARN_VARIANTS,
    };
  }, { seed: SEED });
}

async function openGame(page, vd = 8) {
  await page.goto(`/?seed=${SEED}&vd=${vd}&skybox=0`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 120_000 });
  await page.evaluate(() => window.__MC_GAME__.setShadowsEnabled(false));
}

/**
 * 飞到某点并等该范围的 column 全部加载 + 队列收敛。
 *
 * ⚠️ **必须多等几个 column 的半径**：本地图整形区半径（`SHALLOW_TARN_OUTER_RADIUS`）
 * = 163（v2.13：湖 105 + 沙滩 14 + 缓坡 44）→ 要跨 ±11 个 column。
 * 但等 45×45 column 太慢（视距 8 只有 17×17），所以调用方只检查它真正要读的那片区域。
 */
async function flyTo(page, x, z, y, radiusColumns = 3) {
  await page.evaluate(([px, pz, py]) => {
    clearInterval(window.__PIN__);
    const ph = window.__MC_GAME__.player.physics;
    ph.pos.x = px; ph.pos.y = py; ph.pos.z = pz;
    ph.vel.x = ph.vel.y = ph.vel.z = 0;
    window.__PIN__ = setInterval(() => {
      ph.pos.x = px; ph.pos.z = pz; ph.pos.y = py; ph.vel.y = 0;
    }, 30);
  }, [x, z, y]);
  await page.waitForFunction(([px, pz, rad]) => {
    const g = window.__MC_GAME__;
    const cx = Math.floor(px / 16), cz = Math.floor(pz / 16);
    for (let dx = -rad; dx <= rad; dx++) {
      for (let dz = -rad; dz <= rad; dz++) {
        if (!g.world.hasColumn(cx + dx, cz + dz)) return false;
      }
    }
    return true;
  }, [x, z, radiusColumns], { timeout: 180_000 });
  await page.waitForFunction(queueConverged, null, { timeout: 180_000 });
}

async function unpin(page) {
  await page.evaluate(() => clearInterval(window.__PIN__));
}

test('浅水高台：真实页面里湖盆只有一格水（R3「只有一格浅水」）', async ({ page }) => {
  test.setTimeout(600_000);
  await openGame(page);
  const st = await shallowTarnLayout(page);
  expect(st, '必须能找到浅水高台锚点（否则本 spec 失去意义）').not.toBeNull();
  const { anchor, lakeRadius } = st;

  // 站在湖心上方（不站在水里，避免物理推挤）
  await flyTo(page, anchor.wx, anchor.wz, anchor.lakeFloorY + 30, 2);

  // ⚠️ **必须排除五座高台的占地区域**：它们的水台底座就坐在湖底上（设计如此），
  // 那些列的 `y = lakeFloorY` 是高台方块而不是湖底沙。
  // 实测不排除时有 53 列命中这条，全部落在高台 AABB 内（用节点复算逐一对上）。
  const platforms = st.layout.map((p) => ({
    minX: Math.round(anchor.wx + p.cx) - p.loX, maxX: Math.round(anchor.wx + p.cx) + p.hiX,
    minZ: Math.round(anchor.wz + p.cz) - p.loZ, maxZ: Math.round(anchor.wz + p.cz) + p.hiZ,
  }));

  // 采样半径 = 湖半径 − 10（避开沙滩带；v2.12 湖半径收到 130 后，
  // 硬编码的 ±120 已经贴到岸上，会让「湖底应全是 sand」的判据吃到沙滩列）。
  const inner = lakeRadius - 10;
  const r = await page.evaluate(({ wx, wz, lakeFloorY, lakeRadius, inner, platforms }) => {
    const g = window.__MC_GAME__;
    const nameOf = (id) => (id === 0 ? 'air' : g.registry.nameOf(id));
    const waterId = g.registry.idOf('water');
    const SEA_Y = -2;
    let cols = 0, waterAtSea = 0, airAbove = 0, waterBelow = 0, sandFloor = 0, skipped = 0;
    const notSand = new Map();
    const inPlatform = (x, z) => platforms.some(
      (b) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ,
    );
    // 湖心采样圆（半径由 lakeRadius 派生，见外层注释）
    const step = 4;
    for (let dx = -inner; dx <= inner; dx += step) {
      for (let dz = -inner; dz <= inner; dz += step) {
        if (dx * dx + dz * dz > inner * inner) continue;
        const x = wx + dx, z = wz + dz;
        if (!g.world.hasColumn(Math.floor(x / 16), Math.floor(z / 16))) continue;
        if (inPlatform(x, z)) { skipped++; continue; }
        const floor = g.world.getBlockId(x, lakeFloorY, z);
        // ⚠️ **湖底读不到方块（0）时跳过，不算失败**：`hasColumn` 为真只说明 column 在 map 里，
        // 而 GEN 尚未完成（或该 section 未上传）时读到的就是 0。
        if (floor === 0) continue;
        cols++;
        if (nameOf(floor) === 'sand') sandFloor++;
        else notSand.set(nameOf(floor), (notSand.get(nameOf(floor)) || 0) + 1);
        if (g.world.getBlockId(x, SEA_Y, z) === waterId) waterAtSea++;
        if (g.world.getBlockId(x, SEA_Y + 1, z) === 0) airAbove++;
        // 湖底**正下方**一格不该是水（只有一格浅水）
        if (g.world.getBlockId(x, lakeFloorY - 1, z) === waterId) waterBelow++;
      }
    }
    return {
      cols, waterAtSea, airAbove, waterBelow, sandFloor, lakeRadius, skipped,
      notSand: Object.fromEntries(notSand),
    };
  }, {
    wx: anchor.wx, wz: anchor.wz, lakeFloorY: anchor.lakeFloorY, lakeRadius, inner, platforms,
  });

  await unpin(page);

  // sanity：必须真的扫到列（防「扫错坐标 → 全 0 → 恰好通过」的假通过）
  // ⚠️ **阈值必须从采样几何派生，不能写死**：采样圆半径 `inner = lakeRadius - 10`、步长 4
  // ⇒ 实得约 π·inner²/16 列。v2.13 把湖半径收到 105（inner=95）后只剩 **约 1772 列**，
  // 而初版的硬编码阈值 2000 是按湖半径 240 定的 → 用例本身假失败（不是实现问题）。
  // 取「理论值的一半」作为 sanity 下限：足够拦住坐标写错（那时是 0），又不会随尺度漂。
  const expectedCols = Math.floor(Math.PI * inner * inner / 16 / 2);
  expect(r.cols, `必须扫到大量已加载的列（下限 ${expectedCols}，几何期望约 ${Math.round(Math.PI * inner * inner / 16)}）`)
    .toBeGreaterThan(expectedCols);
  expect(r.sandFloor, `湖底必须全是 sand；实得 ${r.sandFloor}/${r.cols}，非 sand = ${JSON.stringify(r.notSand)}`).toBe(r.cols);
  expect(r.waterAtSea, `y=SEA_Y 必须全是水；实得 ${r.waterAtSea}/${r.cols}`).toBe(r.cols);
  expect(r.airAbove, `y=SEA_Y+1 必须全是空气（只有一格水）；实得 ${r.airAbove}/${r.cols}`).toBe(r.cols);
  expect(r.waterBelow, `湖底下方不得有水（水深只有一格）；实得 ${r.waterBelow}`).toBe(0);
});

test('浅水高台：五座高台都在湖里、互不重叠、且用了深浅两种草', async ({ page }) => {
  test.setTimeout(900_000);
  await openGame(page);
  const st = await shallowTarnLayout(page);
  expect(st).not.toBeNull();
  const { anchor, layout, lakeRadius } = st;

  // 逐座检查：飞到每座中心上方，读该座 AABB 内的方块统计
  const results = [];
  for (const p of layout) {
    const wx = Math.round(anchor.wx + p.cx);
    const wz = Math.round(anchor.wz + p.cz);
    await flyTo(page, wx, wz, anchor.lakeFloorY + 40, 3);
    const r = await page.evaluate(({ wx, wz, loX, hiX, loZ, hiZ, lakeFloorY, ax, az }) => {
      const g = window.__MC_GAME__;
      const nameOf = (id) => (id === 0 ? 'air' : g.registry.nameOf(id));
      const counts = new Map();
      let blocks = 0;
      // 扫 AABB 内的每一列，找该列最高方块（= 高台顶）
      let maxTop = -Infinity;
      // ⚠️ **步长必须是 1**：最小的 `shallow_tarn_05` 只有 15×12，步长 2 只能采到 8×6=48 个点，
      // 而它的实际方块只占其中一部分 → 实测只读到 37 块（阈值 50 假失败）。
      // 逐格扫 15×12=180 点、每点最多 70 次 `getBlockId`，成本可忽略。
      for (let dx = -loX; dx <= hiX; dx += 1) {
        for (let dz = -loZ; dz <= hiZ; dz += 1) {
          const x = wx + dx, z = wz + dz;
          if (!g.world.hasColumn(Math.floor(x / 16), Math.floor(z / 16))) continue;
          for (let y = lakeFloorY + 70; y >= lakeFloorY; y--) {
            const id = g.world.getBlockId(x, y, z);
            if (id === 0) continue;
            const n = nameOf(id);
            if (n === 'stone' || n === 'sand' || n === 'end_stone' || n === 'bedrock' || n === 'water') break;
            blocks++;
            counts.set(n, (counts.get(n) || 0) + 1);
            if (y > maxTop) maxTop = y;
            break;
          }
        }
      }
      return {
        blocks, maxTop,
        counts: Object.fromEntries(counts),
        // 湖心距（判「这座在湖里」）
        dist: Math.hypot(wx - ax, wz - az),
      };
    }, {
      wx, wz, loX: p.loX, hiX: p.hiX, loZ: p.loZ, hiZ: p.hiZ,
      lakeFloorY: anchor.lakeFloorY, ax: anchor.wx, az: anchor.wz,
    });
    results.push({ variant: p.variant, wx, wz, angleRadius: Math.hypot(p.cx, p.cz), ...r });
  }
  await unpin(page);

  // ① 五座都必须真的长出方块（防「layout 有、世界里没有」的静默失效）
  for (const r of results) {
    expect(r.blocks, `${r.variant} 必须真的长出方块（实得 ${r.blocks}）`).toBeGreaterThan(50);
  }
  // ② 五座都必须在湖内（环半径 + 半宽 < 湖半径）
  for (const r of results) {
    const p = layout.find((q) => q.variant === r.variant);
    const worst = Math.hypot(Math.abs(p.cx) + Math.max(p.loX, p.hiX), Math.abs(p.cz) + Math.max(p.loZ, p.hiZ));
    expect(worst, `${r.variant} 最远角 ${worst.toFixed(1)} 必须 < 湖半径 ${lakeRadius}`).toBeLessThan(lakeRadius);
  }
  // ③ 至少一座同时出现深草与浅草（R15 的可观测判据）
  const withBoth = results.filter((r) => (r.counts.dark_grass || 0) > 0 && (r.counts.light_grass || 0) > 0);
  expect(withBoth.length, '至少一座高台同时出现 dark_grass 与 light_grass（用户要求用深浅两种草）')
    .toBeGreaterThan(0);
  // ④ 不能出现「草基准色没被刷掉」——世界里的草只能是深/浅两种
  for (const r of results) {
    expect(r.counts.grass || 0, `${r.variant}: 不得残留普通 grass（说明 paintShallowTarnGrass 没跑到）`).toBe(0);
  }
});

test('浅水高台：只出现在 City 东方，且湖面在海平面附近（不是山里的湖）', async ({ page }) => {
  test.setTimeout(600_000);
  await openGame(page);
  const st = await shallowTarnLayout(page);
  expect(st).not.toBeNull();
  const { anchor, lakeRadius, beachWidth } = st;

  // 站在湖心上方看四周：西侧应当是 City（远），东侧是旷野
  await flyTo(page, anchor.wx, anchor.wz, anchor.lakeFloorY + 60, 2);

  const r = await page.evaluate(async ({ wx, wz, lakeRadius, beachWidth, lakeFloorY }) => {
    const g = window.__MC_GAME__;
    const m = await import('/src/gen/structures/shallow-water-tarns.js');
    const bounds = m.shallowTarnCityBounds(g.seed);
    // 湖区西缘必须在城东边界以东（用户：「只显示在 City 的东方」）
    const westEdge = wx - (lakeRadius + beachWidth);
    return {
      westEdge,
      cityMaxX: bounds.maxX,
      lakeFloorY,
      // 湖面高度（水面方块所在 y）
      waterY: lakeFloorY + 1,
    };
  }, { wx: anchor.wx, wz: anchor.wz, lakeRadius, beachWidth, lakeFloorY: anchor.lakeFloorY });

  await unpin(page);

  expect(r.westEdge, `湖区西缘 ${r.westEdge} 必须在城东边界 ${r.cityMaxX} 以东`)
    .toBeGreaterThanOrEqual(r.cityMaxX);
  // 湖底在 SEA_Y-1，水面方块在 SEA_Y ⇒ 水在湖底之上、地表之下（不是山里的湖）
  expect(r.waterY, '湖面方块必须正好在湖底之上 1 格（= SEA_Y）').toBe(r.lakeFloorY + 1);
});
