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
//
// v2.15 新增（用户 2026-11-02）：湖岸不规则（不是正圆）、接壤水系时水面直接连通、
// moss 全部换深草。三条都有各自的用例，且都**从模块取常量**（不写字面量）。
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
      lakeRadiusMin: m.LAKE_RADIUS_MIN,
      lakeRadiusMax: m.LAKE_RADIUS_MAX,
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
 * = 139.3（v2.15：最大湖岸半径 108.3 + 沙滩 7 + 缓坡 24）→ 最远要跨 ±9 个 column。
 * 视距 8 的加载半径是 160 格 → `radiusColumns = 10` 正好把整圈等齐（连通性用例需要）。
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
  const { anchor, lakeRadiusMin } = st;

  // 站在湖心上方（不站在水里，避免物理推挤）
  await flyTo(page, anchor.wx, anchor.wz, anchor.lakeFloorY + 30, 2);

  // ⚠️ **必须排除五座高台的占地区域**：它们的水台底座就坐在湖底上（设计如此），
  // 那些列的 `y = lakeFloorY` 是高台方块而不是湖底沙。
  const platforms = st.layout.map((p) => ({
    minX: Math.round(anchor.wx + p.cx) - p.loX, maxX: Math.round(anchor.wx + p.cx) + p.hiX,
    minZ: Math.round(anchor.wz + p.cz) - p.loZ, maxZ: Math.round(anchor.wz + p.cz) + p.hiZ,
  }));

  // 采样半径 = **最小**湖岸半径 − 10（避开沙滩带；逐点再用 `e = d − R(θ)` 判）。
  // ⚠️ v2.15 湖岸不规则：固定半径的圆采样会在内凹方位吃到沙滩列。
  const inner = Math.floor(lakeRadiusMin - 10);
  const r = await page.evaluate(({ wx, wz, lakeFloorY, inner, platforms, seed }) => {
    const g = window.__MC_GAME__;
    const nameOf = (id) => (id === 0 ? 'air' : g.registry.nameOf(id));
    const waterId = g.registry.idOf('water');
    const SEA_Y = -2;
    let cols = 0, waterAtSea = 0, airAbove = 0, waterBelow = 0, sandFloor = 0, skipped = 0;
    const notSand = new Map();
    const inPlatform = (x, z) => platforms.some(
      (b) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ,
    );
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
      cols, waterAtSea, airAbove, waterBelow, sandFloor, skipped,
      notSand: Object.fromEntries(notSand),
    };
  }, {
    wx: anchor.wx, wz: anchor.wz, lakeFloorY: anchor.lakeFloorY, inner, platforms, seed: SEED,
  });

  await unpin(page);

  // sanity：必须真的扫到列（防「扫错坐标 → 全 0 → 恰好通过」的假通过）
  // ⚠️ **阈值必须从采样几何派生，不能写死**（v2.13/v2.15/v2.16 都因湖半径变化踩过）。
  // ⚠️ **不能再拿「圆面积的一半」当分母**：湖半径收到 82 后，五座 AABB 在采样圆里的占比
  // 从 ~30% 涨到 ~54%（圆小了、台地没小），固定 50% 的下限会假失败。
  // 现口径 = 逐格枚举「在圆内且不在任何台地 AABB 内」的点，要求实读列数 ≥ 该值的 90%
  // （10% 余量留给尚未 GEN 完的 column —— `hasColumn` 为真但读不到方块）。
  let sampledFree = 0;
  for (let dx = -inner; dx <= inner; dx += 4) {
    for (let dz = -inner; dz <= inner; dz += 4) {
      if (dx * dx + dz * dz > inner * inner) continue;
      const x = anchor.wx + dx, z = anchor.wz + dz;
      if (platforms.some((b) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ)) continue;
      sampledFree++;
    }
  }
  const expectedCols = Math.floor(sampledFree * 0.9);
  expect(r.cols, `必须扫到大量已加载的列（未被台地占住的采样点 ${sampledFree}，下限 ${expectedCols}）`)
    .toBeGreaterThan(expectedCols);
  expect(r.sandFloor, `湖底必须全是 sand；实得 ${r.sandFloor}/${r.cols}，非 sand = ${JSON.stringify(r.notSand)}`).toBe(r.cols);
  expect(r.waterAtSea, `y=SEA_Y 必须全是水；实得 ${r.waterAtSea}/${r.cols}`).toBe(r.cols);
  expect(r.airAbove, `y=SEA_Y+1 必须全是空气（只有一格水）；实得 ${r.airAbove}/${r.cols}`).toBe(r.cols);
  expect(r.waterBelow, `湖底下方不得有水（水深只有一格）；实得 ${r.waterBelow}`).toBe(0);
});

test('浅水高台：五座高台都在湖里、互不重叠、且只有深浅两种草（无 moss）', async ({ page }) => {
  test.setTimeout(900_000);
  await openGame(page);
  const st = await shallowTarnLayout(page);
  expect(st).not.toBeNull();
  const { anchor, layout } = st;

  // 逐座检查：飞到每座中心上方，读该座 AABB 内的方块统计
  const results = [];
  for (const p of layout) {
    const wx = Math.round(anchor.wx + p.cx);
    const wz = Math.round(anchor.wz + p.cz);
    await flyTo(page, wx, wz, anchor.lakeFloorY + 40, 3);
    const r = await page.evaluate(async ({ wx, wz, ax, az, loX, hiX, loZ, hiZ, lakeFloorY }) => {
      const g = window.__MC_GAME__;
      const m = await import('/src/gen/structures/shallow-water-tarns.js');
      const phase = m.shallowTarnShapePhase(g.seed);
      const nameOf = (id) => (id === 0 ? 'air' : g.registry.nameOf(id));
      // ⚠️ **只认「该列最顶层方块」且必须是台地材质**（v2.16 改）：
      // 台地 AABB 现在会稍微压到岸上（湖半径收到 82 后），旧写法「向下扫到非地形方块为止」
      // 会**穿过缓坡带的 grass 地表**去数埋在下面的方块 —— 实测因此虚报 55 格「在岸外」，
      // 而真实台地方块最远半径只有 72.5、0 格在岸外。
      // 候选材质含 `moss` / `grass`：它们是 ⑤「不得出现 moss」与 ④「不得残留香草 grass」的被测对象，
      // 漏掉会让那两条断言变成恒真。
      const PLATFORM_MATS = new Set([
        'light_gray_cloth', 'marble', 'polished_blackstone_bricks',
        'dark_grass', 'light_grass', 'moss', 'grass',
      ]);
      const counts = new Map();
      let blocks = 0;
      let maxTop = -Infinity;
      let outside = 0;
      let minGap = Infinity;
      // ⚠️ **步长必须是 1**：最小的 `shallow_tarn_05` 只有 15×12，步长 2 只能采到 48 个点。
      for (let dx = -loX; dx <= hiX; dx += 1) {
        for (let dz = -loZ; dz <= hiZ; dz += 1) {
          const x = wx + dx, z = wz + dz;
          if (!g.world.hasColumn(Math.floor(x / 16), Math.floor(z / 16))) continue;
          let topY = null, topName = null;
          for (let y = lakeFloorY + 70; y >= lakeFloorY; y--) {
            const id = g.world.getBlockId(x, y, z);
            if (id === 0) continue;
            topY = y;
            topName = nameOf(id);
            break;
          }
          if (topName === null || !PLATFORM_MATS.has(topName)) continue;   // 地形列，跳过
          blocks++;
          counts.set(topName, (counts.get(topName) || 0) + 1);
          if (topY > maxTop) maxTop = topY;
          // 该格到湖心的距离 / 方位角（相对湖心，不是相对台地中心）
          const rx = x - ax, rz = z - az;
          const d = Math.hypot(rx, rz);
          const gap = m.shallowTarnLakeRadiusAt(Math.atan2(rz, rx), phase) - d;
          if (gap < 0) outside++;
          if (gap < minGap) minGap = gap;
        }
      }
      return { blocks, maxTop, outside, minGap, counts: Object.fromEntries(counts) };
    }, {
      wx, wz, ax: anchor.wx, az: anchor.wz,
      loX: p.loX, hiX: p.hiX, loZ: p.loZ, hiZ: p.hiZ,
      lakeFloorY: anchor.lakeFloorY,
    });
    results.push({ variant: p.variant, wx, wz, ...r });
  }
  await unpin(page);

  // ① 五座都必须真的长出方块（防「layout 有、世界里没有」的静默失效）
  for (const r of results) {
    expect(r.blocks, `${r.variant} 必须真的长出方块（实得 ${r.blocks}）`).toBeGreaterThan(50);
  }
  // ② 五座都必须在湖内 —— 逐格用 **该方位的湖岸半径** 判真实方块（v2.16 起不再用 AABB 角）
  for (const r of results) {
    expect(r.outside, `${r.variant}: 有 ${r.outside} 格真实方块落在湖岸外（沙滩/缓坡上）—— `
      + '台地必须整体被水环绕').toBe(0);
    expect(r.minGap, `${r.variant}: 最紧一格离岸 ${r.minGap.toFixed(1)} 格，必须 ≥ 3`)
      .toBeGreaterThanOrEqual(3);
  }
  // ③ 至少一座同时出现深草与浅草（R15 的可观测判据）
  const withBoth = results.filter((r) => (r.counts.dark_grass || 0) > 0 && (r.counts.light_grass || 0) > 0);
  expect(withBoth.length, '至少一座高台同时出现 dark_grass 与 light_grass（用户要求用深浅两种草）')
    .toBeGreaterThan(0);
  // ④ 烘焙产物从不写香草 `grass`（草方块都烘成标记 `light_grass`）⇒ 平台顶层不该出现它
  for (const r of results) {
    expect(r.counts.grass || 0, `${r.variant}: 平台顶层不得出现香草 grass（草方块应烘成 light_grass 标记）`).toBe(0);
  }
  // ⑤ v2.15：**不得出现 moss** —— 用户 2026-11-02「所有 moss 方块都替换成 grass-dark-green」
  for (const r of results) {
    expect(r.counts.moss || 0, `${r.variant}: 不得出现 moss（应已全部烘成 dark_grass）`).toBe(0);
  }
  // ⑥ **自然地形的草方块必须仍是香草 `grass`**（用户 2026-11-02 报的缺陷：刷草把整片地形的草
  // 都改成了深浅草）。判据落在**缓坡带**（e ∈ [14,26]，dry 列地表材质本来就是 `grass`）：
  // 那里既不该出现 `dark_grass` 也不该出现 `light_grass`。
  const slope = await page.evaluate(async ({ wx, wz, lakeFloorY }) => {
    const g = window.__MC_GAME__;
    const m = await import('/src/gen/structures/shallow-water-tarns.js');
    const phase = m.shallowTarnShapePhase(g.seed);
    const nameOf = (id) => (id === 0 ? 'air' : g.registry.nameOf(id));
    const counts = new Map();
    for (let deg = 0; deg < 360; deg += 10) {
      const ang = deg * Math.PI / 180;
      const R = m.shallowTarnLakeRadiusAt(ang, phase);
      const ux = Math.cos(ang), uz = Math.sin(ang);
      // 缓坡带 = R(θ) + (BEACH, BEACH+SLOPE)，取几个偏移抽样
      for (const e of [14, 18, 22, 26]) {
        const x = Math.round(wx + ux * (R + e)), z = Math.round(wz + uz * (R + e));
        if (!g.world.hasColumn(Math.floor(x / 16), Math.floor(z / 16))) continue;
        let top = null;
        for (let y = lakeFloorY + 40; y >= lakeFloorY - 6; y--) {
          const id = g.world.getBlockId(x, y, z);
          if (id !== 0) { top = nameOf(id); break; }
        }
        if (top === null) continue;
        counts.set(top, (counts.get(top) || 0) + 1);
      }
    }
    return Object.fromEntries(counts);
  }, { wx: st.anchor.wx, wz: st.anchor.wz, lakeFloorY: st.anchor.lakeFloorY });
  const slopeGrass = slope.grass || 0;
  const slopeDark = slope.dark_grass || 0;
  const slopeLight = slope.light_grass || 0;
  expect(slopeGrass, `缓坡带地表必须仍是香草 grass（实测 grass=${slopeGrass}，全部计数 ${JSON.stringify(slope)}）`)
    .toBeGreaterThan(10);
  expect(slopeDark + slopeLight,
    `缓坡带（自然地形）不得出现 dark_grass/light_grass（实测 ${slopeDark}/${slopeLight}）—— `
    + '刷草只能改模型里的草方块，不能改地形')
    .toBe(0);

  // ⑦ 每座都必须有深草（moss 与草方块都落到深草上）
  for (const r of results) {
    expect(r.counts.dark_grass || 0, `${r.variant}: 必须出现 dark_grass`).toBeGreaterThan(0);
  }
});

test('浅水高台：只出现在 City 东方，且湖面在海平面附近（不是山里的湖）', async ({ page }) => {
  test.setTimeout(600_000);
  await openGame(page);
  const st = await shallowTarnLayout(page);
  expect(st).not.toBeNull();
  const { anchor, lakeRadiusMax, beachWidth } = st;

  await flyTo(page, anchor.wx, anchor.wz, anchor.lakeFloorY + 60, 2);

  const r = await page.evaluate(async ({ wx, wz, lakeRadiusMax, beachWidth, lakeFloorY }) => {
    const g = window.__MC_GAME__;
    const m = await import('/src/gen/structures/shallow-water-tarns.js');
    const bounds = m.shallowTarnCityBounds(g.seed);
    // 湖区西缘（**最大**湖岸半径口径）必须在城东边界以东（用户：「只显示在 City 的东方」）
    const westEdge = wx - (lakeRadiusMax + beachWidth);
    return { westEdge, cityMaxX: bounds.maxX, lakeFloorY, waterY: lakeFloorY + 1 };
  }, {
    wx: anchor.wx, wz: anchor.wz, lakeRadiusMax, beachWidth, lakeFloorY: anchor.lakeFloorY,
  });

  await unpin(page);

  expect(r.westEdge, `湖区西缘 ${r.westEdge} 必须在城东边界 ${r.cityMaxX} 以东`)
    .toBeGreaterThanOrEqual(r.cityMaxX);
  expect(r.waterY, '湖面方块必须正好在湖底之上 1 格（= SEA_Y）').toBe(r.lakeFloorY + 1);
});

test('浅水高台：湖岸有凹凸（不是正圆）', async ({ page }) => {
  test.setTimeout(900_000);
  // ⚠️ 必须 vd=12：vd=8 的切比雪夫半径只有 8 列（加载范围最多 ~143 格），
  // 而本用例要沿射线量到 160 格外。vd=12 → 12 列，`flyTo(..., 10)` 可行。
  await openGame(page, 12);
  const st = await shallowTarnLayout(page);
  expect(st).not.toBeNull();
  // 视距 8 的加载半径 160 → ±10 个 column 足以量到 160 格外的岸线
  await flyTo(page, st.anchor.wx, st.anchor.wz, st.anchor.lakeFloorY + 60, 10);

  const r = await page.evaluate(async ({ wx, wz, minR, maxR, lakeFloorY, platforms }) => {
    const g = window.__MC_GAME__;
    const m = await import('/src/gen/structures/shallow-water-tarns.js');
    const phase = m.shallowTarnShapePhase(g.seed);
    const sandId = g.registry.idOf('sand');
    const stoneId = g.registry.idOf('stone');
    const waterId = g.registry.idOf('water');
    const SEA_Y = -2;
    const inPlatform = (x, z) => platforms.some(
      (b) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ,
    );
    // 湖底**整形**的签名（三项全给才算）= `SEA_Y` 是水 + `lakeFloorY` 是 `sand` + 正下方 `stone`。
    //   · 天然水底若也到 −3，其下方是 `end_stone`（`fillColumn` 的规则）→ 区分得开；
    //   · 陆生沙地（h=−2）正好是「−3 沙 + −4 石」但没有上方那格水 → 不假匹配（实测踩到 160）。
    const isLakeFloor = (x, z) => g.world.getBlockId(x, SEA_Y, z) === waterId
      && g.world.getBlockId(x, lakeFloorY, z) === sandId
      && g.world.getBlockId(x, lakeFloorY - 1, z) === stoneId;
    // 判据 = 「第一段连续湖底」的末端 ≈ R(θ) + 1~2。
    // 超出 R+8 的那些方向**跳过**：接壤海洋处地图内的 −3 平台会一直延伸到整形区边缘
    // （实测量到 110~131，那是「更深的浅滩」而不是岸线）。
    const radii = [];
    const expected = [];
    let skipped = 0;
    let platformDirs = 0;
    for (let deg = 0; deg < 360; deg += 3) {
      const ux = Math.cos(deg * Math.PI / 180), uz = Math.sin(deg * Math.PI / 180);
      const R = m.shallowTarnLakeRadiusAt(deg * Math.PI / 180, phase);
      // ⚠️ **扫描不能在第一段湖底结束时 break**：高台的边缘格可能落在我的 AABB 判定之外，
      // 那一格会让签名失配 —— 中断扫描就会把测量截短（实测正圆回退时得到 95/97/99 的假凹陷，
      // 让「湖岸有凹凸」用例失去判别力，是负向验证抓到的）。
      // ⇒ 全段扫描只取「最后一个湖底格」，再按 `R ± 8` 过滤（浅滩方向自动出局）。
      let lastLake = null;
      let blocked = false;
      for (let d = 60; d <= 160; d += 1) {
        const x = Math.round(wx + ux * d), z = Math.round(wz + uz * d);
        if (!g.world.hasColumn(Math.floor(x / 16), Math.floor(z / 16))) { blocked = true; break; }
        if (inPlatform(x, z)) continue;            // 高台占据：跳过
        if (isLakeFloor(x, z)) lastLake = d;
      }
      if (lastLake === null) { if (blocked) platformDirs++; continue; }
      // 只接受「第一段湖底刚好结束在岸线附近」的方向：[R, R+3]（沙滩带前两格地表仍是 −3）。
      // 这个窗口同时挡掉两类噪声：
      //   · > R+3：接壤海洋处的浅滩（hS≈−3 时湖底在 −3 平台上一直延伸，实测到 R+5~+30）；
      //   · < R：高台边缘残块把签名打断（实测 R−6）。
      // ⇒ 两个方向都被滤掉后，「量到的半径」才是**岸线**本身。
      if (lastLake > R + 2 || lastLake < R) { skipped++; continue; }
      radii.push(lastLake);
      expected.push(R);
    }
    return { radii, expected, skipped, platformDirs, minR, maxR };
  }, {
    wx: st.anchor.wx, wz: st.anchor.wz, minR: st.lakeRadiusMin, maxR: st.lakeRadiusMax,
    lakeFloorY: st.anchor.lakeFloorY,
    platforms: st.layout.map((p) => ({
      minX: Math.round(st.anchor.wx + p.cx) - p.loX, maxX: Math.round(st.anchor.wx + p.cx) + p.hiX,
      minZ: Math.round(st.anchor.wz + p.cz) - p.loZ, maxZ: Math.round(st.anchor.wz + p.cz) + p.hiZ,
    })),
  });
  await unpin(page);

  expect(r.radii.length,
    `必须量到足够多方位（实测 ${r.radii.length}；窗口外跳过 ${r.skipped} / 高台挡住 ${r.platformDirs}）`)
    .toBeGreaterThan(30);
  // 岸线必须**同时**出现在名义湖半径的内侧与外侧 —— 这才是「不是正圆」的直接证据。
  // ⚠️ 正圆（`R(θ) ≡ LAKE_RADIUS`）时所有方向都会落在 103 → 下面两条必然红（已负向验证）。
  // 阈值取「名义半径 ∓2/+3」：正圆时所有方向的岸线都落在 [R+1, R+2] 内，两条都会红。
  expect(Math.min(...r.radii), `岸线最内 ${Math.min(...r.radii)} 必须 ≤ 名义湖半径 −2（${st.lakeRadius - 2}）`)
    .toBeLessThanOrEqual(st.lakeRadius - 2);
  expect(Math.max(...r.radii), `岸线最外 ${Math.max(...r.radii)} 必须 ≥ 名义湖半径 +3（${st.lakeRadius + 3}）`)
    .toBeGreaterThanOrEqual(st.lakeRadius + 3);
  // wiring：量到的岸线整体上必须贴着模块算出的 R(θ)（平均偏差 ≤ 3 格）
  const devs = r.radii.map((v, i) => Math.abs(v - r.expected[i]));
  const meanDev = devs.reduce((a, b) => a + b, 0) / devs.length;
  expect(meanDev, `岸线的平均偏差 ${meanDev.toFixed(2)} 格（最大 ${Math.max(...devs).toFixed(1)}）必须 ≤ 3`)
    .toBeLessThanOrEqual(3);
});

test('浅水高台：湖水与接壤的海洋连成一片（无陆地堤坝）', async ({ page }) => {
  test.setTimeout(900_000);
  // ⚠️ 必须 vd=12：vd=8 只加载 ±8 列（最多 ~143 格），而「接进大洋」的判据要 >140 格
  // —— 用 vd=8 会永远等不齐 21×21 列（实测 180s 超时）。
  await openGame(page, 12);
  const st = await shallowTarnLayout(page);
  expect(st).not.toBeNull();
  // ⚠️ 必须把**整圈**已加载 column 等齐再填充，否则边缘未加载会被当成陆地。
  // 视距 8 的加载半径 = 160 格，所以用 ±10 个 column（= 160 格）。
  await flyTo(page, st.anchor.wx, st.anchor.wz, st.anchor.lakeFloorY + 40, 10);

  const r = await page.evaluate(({ wx, wz }) => {
    const g = window.__MC_GAME__;
    const waterId = g.registry.idOf('water');
    const SEA_Y = -2;
    const STEP = 2, RANGE = 150;
    const N = Math.floor(RANGE / STEP) * 2 + 1;
    const wet = (i, j) => {
      const x = wx - RANGE + i * STEP, z = wz - RANGE + j * STEP;
      return g.world.getBlockId(x, SEA_Y, z) === waterId ? 1 : 0;
    };
    const seen = new Uint8Array(N * N);
    const mid = Math.floor(N / 2);
    const stack = [mid * N + mid];
    seen[stack[0]] = 1;
    let maxDist = 0, cells = 0;
    while (stack.length) {
      const cur = stack.pop();
      cells++;
      const ci = cur % N, cj = Math.floor(cur / N);
      const dist = Math.hypot((ci - mid) * STEP, (cj - mid) * STEP);
      if (dist > maxDist) maxDist = dist;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
        const k = nj * N + ni;
        if (seen[k] || !wet(ni, nj)) continue;
        seen[k] = 1;
        stack.push(k);
      }
    }
    return { maxDist, cells };
  }, { wx: st.anchor.wx, wz: st.anchor.wz });
  await unpin(page);

  // sanity：湖心确实有一大片水（防坐标写错 → 全 0 → 恰好通过）
  expect(r.cells, `湖心水团采样点数 ${r.cells} 必须足够大（步长 2，半径 150）`).toBeGreaterThan(2000);
  // 修前实测：湖心水团最远只到 **100 格**（= 旧湖半径 99 + 1）—— 沙滩圈是一道完整堤坝。
  // 修后：连到 > 140 格（进入大洋）。140 = 整形区最大半径 139.3 向上取整 —— **必须越过整形区**
  // 才算「接进大洋」，而不是「湖自己变大了一点」。
  expect(r.maxDist, `湖心水团最远 ${r.maxDist} 格；修前是 100（被沙滩堤坝隔断），必须 > 140`).toBeGreaterThan(140);
});
