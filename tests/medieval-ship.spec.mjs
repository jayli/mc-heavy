// tests/medieval-ship.spec.mjs — 中世纪船 Tier 4（真实页面、数据级；不靠目视）
//
// 为什么需要 Tier 4（浏览器内单测测不到）：
//   · 单测直接调 `computeMedievalShipPlacement`，验的是「函数写对了」；真实页面验的是
//     「接线通了 + Worker 内 layout RPC 把锚点送到 + column 调度真的把方块送上屏」。
//   · 单测里 `loadStructure` 走 Node 的 fetch（无 base URL → 静默返回空结构），
//     所以**单测根本验不到光栅化**；真实页面才是唯一能验「船真的长出来」的地方。
//   · `MEDIEVAL_SHIP_VARIANTS` 漏进 STRUCTURE_FILES / needTypes 漏预载 / apply.js 阶段漏调
//     → 世界里什么都没有，而单测全绿（M7 教训）。
//
// ⚠️ 必读的既有约束（与 shallow-water-tarns.spec / arena.spec 同口径）：
//   ① `setShadowsEnabled(false)` —— VSM 下 receiveShadow 的对象也进阴影 pass，
//      会让 drawCalls/reservedV 与本 spec 无关地波动。
//   ② 传送用 `player.physics.pos` + 定时 pin —— 物理会把玩家拉回地面，不 pin 住就停不在视域中心。
import { test, expect } from 'playwright/test';

const SEED = 12345;

/** 队列收敛（唯一权威口径，与 shallow-water-tarns.spec 逐字同一份） */
// ⚠️ **访问器必须按容器类型选**（实测踩到）：`_meshQueue` / `_uploadQueue` 是**数组**
// （`.length`），而 `_inflightGen` / `_inflightMesh` / `_pendingMesh` / `_lightQueue` /
// `_inflightLight` 是 **Map / Set**（`.size`，见 `scheduler.js:58-77`）。
// 把 `_lightQueue.length` 写错时它是 `undefined`，`undefined === 0` 恒假 ⇒
// **本函数永不返回 true**，而队列实际 4 秒就清空了 —— 形态是 `waitForFunction` 超时
// 而页面一切正常（HUD 显示玩家已到位、fps 120），极易误判成「世界加载不完」。
const queueConverged = () => {
  const s = window.__MC_GAME__.scheduler;
  return s._inflightGen.size === 0 && s._meshQueue.length === 0 && s._inflightMesh.size === 0 &&
         s._uploadQueue.length === 0 && s._pendingMesh.size === 0 && s._lightQueue.size === 0 &&
         s._inflightLight.size === 0;
};

/** 在页面内跑真实模块算船落点（验的是「页面里那个模块」，不是 Node 侧复算） */
async function shipPlacement(page) {
  return page.evaluate(async ({ seed }) => {
    const m = await import('/src/gen/structures/medieval-ship.js');
    m.clearMedievalShipCache();
    const p = m.computeMedievalShipPlacement(seed);
    if (!p) return null;
    const data = await import('/src/gen/structures/medieval-ship-data.js');
    return { placement: p, metrics: data.MEDIEVAL_SHIP_METRICS[p.variant] };
  }, { seed: SEED });
}

async function openGame(page, vd = 8) {
  await page.goto(`/?seed=${SEED}&vd=${vd}&skybox=0`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 120_000 });
  await page.evaluate(() => window.__MC_GAME__.setShadowsEnabled(false));
}

/** 飞到某点并等该范围的 column 全部加载 + 队列收敛 */
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
  }, [x, z, radiusColumns], { timeout: 60_000 });
  await page.waitForFunction(queueConverged, null, { timeout: 60_000 });
}

/** 读世界方块名（真实 column） */
async function blockNameAt(page, x, y, z) {
  return page.evaluate(([wx, wy, wz]) => {
    const g = window.__MC_GAME__;
    const id = g.world.getBlockId(wx, wy, wz);
    return id === 0 ? 'air' : g.registry.nameOf(id);
  }, [x, y, z]);
}

test('中世纪船: 船真的生成在湖里（真实 GEN 后世界里有船体方块）', async ({ page }) => {
  await openGame(page);
  const sp = await shipPlacement(page);
  expect(sp).not.toBeNull();
  const { placement: p } = sp;

  // 飞到船中心（船顶约 37 格高，从高空俯视）
  await flyTo(page, p.wx, p.wz, 40, 3);

  // 船体材质集合（烘焙产物的 palette）。
  // ⚠️ 2026-11-04 用户改色：dark_planks→iron、birch_log→snow、light_gray_cloth→marble。
  // ⚠️ 2026-11-02（v2.35）用户再改：iron → oak_planks_1；2026-11-02（v2.36）又要求
  // 「船身的 oak_planks_1 换成 acacia_planks，甲板之上的保留」⇒ **两者共存**。
  // ⚠️ **扫描下界必须是 `SEA_Y`（= 船底那一层），不能更低**：湖底方块在
  // `LAKE_FLOOR_Y = SEA_Y-1` 且材质是 `sand`，而 `sand` 也在船的 palette 里
  // （素材的 double 半砖映射到它，实测 1 格、在世界 y=8 的上层建筑里）。
  // 扫到 y=-3 会把船 AABB 内全部 407 列湖底沙当成船体（实测读数 1680 = 1263 + 407 + 10）。
  const SEA_Y = -2;
  const shipMats = new Set([
    'oak_planks', 'oak_planks_1', 'acacia_planks', 'planks_step', 'planks_step_updown',
    'half_block_updown', 'sand_slab', 'vertical_pillar', 'handrail', 'handrailA',
    'marble', 'snow', 'giant_mangrove_log', 'sand',
  ]);

  // 扫船 AABB 内从船底到船顶，数船体方块
  const result = await page.evaluate(([p, mats, seaY, topY]) => {
    const g = window.__MC_GAME__;
    const matSet = new Set(mats);
    const minX = p.wx - p.loX, maxX = p.wx + p.hiX;
    const minZ = p.wz - p.loZ, maxZ = p.wz + p.hiZ;
    let shipBlocks = 0;
    let minY = Infinity, maxY = -Infinity;
    const kinds = {};
    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) {
        for (let y = seaY; y <= topY; y++) {
          const id = g.world.getBlockId(x, y, z);
          if (id === 0) continue;
          const n = g.registry.nameOf(id);
          if (matSet.has(n)) {
            shipBlocks++;
            kinds[n] = (kinds[n] || 0) + 1;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
    }
    return { shipBlocks, minY, maxY, kinds };
  }, [p, [...shipMats], SEA_Y, SEA_Y + sp.metrics.height]);

  // ⚠️ 判据：**恰好等于产物的格数**（不是区间）。船是阶段 ⑥ 的最后写入者，
  // 而湖盆内 y ≥ SEA_Y 除了船体就只有水（不在材质集合里）⇒ 没有合法的多余来源。
  // 写成区间（如 `>1000 && <1400`）会把「多扫了 407 格湖底沙」这类真实缺陷放过去。
  expect(result.shipBlocks, `船体方块数应恰好等于产物格数（实得 ${JSON.stringify(result.kinds)}）`)
    .toBe(sp.metrics.blocks);
  // 船体必须从湖底（y=SEA_Y）一直延伸到高处（桅杆/帆）
  expect(result.minY, '船底必须落在 SEA_Y（紧贴湖底方块顶面）').toBe(SEA_Y);
  expect(result.maxY, `船顶必须到 SEA_Y + height - 1`).toBe(SEA_Y + sp.metrics.height - 1);
  // 主要材质必须是木板（船壳主体）
  expect(result.kinds['oak_planks'] || 0).toBeGreaterThan(200);
  // ⚠️ **2026-11-04 用户改色的落地判据（v2.34）**：只看格数拓不到「BLOCK_MAP 改了但没重烘」
  // （旧产物格数/bbox 全一致）。这里逐项钉住新材质的**实测格数**（均来自产物契约），
  // 且旧材质必须一格不剩 —— 否则两种色系会混在船体上而格数总和仍然对。
  // ⚠️ 2026-11-02（v2.35）：`iron` → `oak_planks_1`，故它进「旧材质」那一组。
  // ⚠️ 2026-11-02（v2.36 → v2.37）：船身改色扩到 y≤9（桅杆豁免）
  // ⇒ `oak_planks_1` 只剩 86 格（桅杆 77 + 船尾板 9），`acacia_planks` 206 格。
  expect(result.kinds['acacia_planks'] || 0, '船身（y≤9 的非桅杆部分）应为 acacia_planks 206 格').toBe(206);
  expect(result.kinds['oak_planks_1'] || 0, '桅杆/柱子 + 船尾板应保留 oak_planks_1 86 格').toBe(86);
  expect(result.kinds['marble'] || 0, '主帆应为 marble 93 格').toBe(93);
  expect(result.kinds['snow'] || 0, '桅杆顶部浅色件应为 snow 26 格').toBe(26);
  for (const old of ['dark_planks', 'birch_log', 'light_gray_cloth', 'iron']) {
    expect(result.kinds[old] || 0, `旧材质 "${old}" 已全部换掉，世界里不应再有`).toBe(0);
  }

  // ⚠️ **分层判据（v2.36 立 / v2.37 扩到 y≤9 + 桅杆豁免）**。
  // 只数总数拓不到「按源方块改」（spruce_planks 跨 y 1..7、stripped_dark_oak_wood 跨 y 7..8
  // ⇒ 甲板围边会被一起染成勾棕而总数仍对），必须按世界层判。
  //
  // ⚠️ **产物局部 y 与世界 y 差一格**：`rasterizeStructure` 按 `y + b.y - 1` 落位，
  // 而产物最低层是 local y=1 ⇒ `worldY = SEA_Y + localY - 1`。
  // 改色层边界 local y=9 ⇒ **世界 SEA_Y+8**（初版 v2.36 按 +7 判，把甲板围边 67 格误报）。
  // ⚠️ **不能断言「改色层内没有 oak_planks_1」**（v2.36 可以，v2.37 不行）：桅杆穿在甲板之间，
  // 用户明确要保留它们 ⇒ 判据反而要钉「层内 oak_planks_1 必须恰好是那 16 格桅杆」。
  const layered = await page.evaluate(([p, seaY, cutLocalY, from, to]) => {
    const g = window.__MC_GAME__;
    const cutWorldY = seaY + cutLocalY - 1;
    let badHigh = 0;   // 改色层之外不该有 to
    let inRange = 0;   // 改色层内仍为 from 的格数（合法来源只有桅杆）
    const minX = p.wx - p.loX, maxX = p.wx + p.hiX;
    const minZ = p.wz - p.loZ, maxZ = p.wz + p.hiZ;
    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) {
        for (let wy = seaY; wy <= seaY + 46; wy++) {
          const id = g.world.getBlockId(x, wy, z);
          if (!id) continue;
          const n = g.registry.nameOf(id);
          const within = wy <= cutWorldY;
          if (!within && n === to) badHigh++;
          if (within && n === from) inRange++;
        }
      }
    }
    return { badHigh, inRange, cutWorldY };
  }, [p, SEA_Y, 9, 'oak_planks_1', 'acacia_planks']);
  expect(layered.badHigh, `改色层之外（worldY > ${layered.cutWorldY}）不应出现 acacia_planks`).toBe(0);
  expect(layered.inRange, `改色层内应恰好有 16 格 oak_planks_1（主/副桅杆各 8，用户要求保留柱子）`).toBe(16);

  // ⚠️ **上面两条还拓不到「位置错」**（实测踩到）：把 16 格桅杆染色、再把甲板上另外 16 格
  // 改回 `oak_planks_1` ⇒ 总数 206/86 与 `inRange` 16 **全部对得上**，而桅杆已经变橙。
  // 根因：那两条只数**数量**，不看**位置**。
  // 修法 = 按 y 层看桅杆位置：桅杆是**垂直连续**的，而甲板格不是。判据取
  // 「y=8 这一层是 `oak_planks_1` 的水平位置数」——实测正确产物恰好 **8**（4 个桅杆 × 各 2 格），
  // 桅杆被染色时变 **0**（真 FAIL，已负向验证），而它不依赖「哪几列连续」这类脆弱条件。
  const mastPositions = await page.evaluate(([p, seaY, cutLocalY, from, to]) => {
    const g = window.__MC_GAME__;
    const y8 = seaY + 8 - 1;   // 产物 local y=8 ⇒ 世界 SEA_Y+7（`y + b.y - 1`）
    const spots = [];
    for (let x = p.wx - p.loX; x <= p.wx + p.hiX; x++) {
      for (let z = p.wz - p.loZ; z <= p.wz + p.hiZ; z++) {
        const id = g.world.getBlockId(x, y8, z);
        if (id && g.registry.nameOf(id) === from) spots.push([x, z]);
      }
    }
    return spots;
  }, [p, SEA_Y, 9, 'oak_planks_1', 'acacia_planks']);
  expect(mastPositions.length,
    'y=8 这一层的 oak_planks_1 水平位置应恰好 8 个（4 根桅杆 × 各 2 格）'
    + ' —— 少了说明桅杆被染成 acacia（用户要求柱子保留）').toBe(8);
});

test('中世纪船: 船完整落在水下（船 AABB 内每列地表 ≤ SEA_Y-1）', async ({ page }) => {
  await openGame(page);
  const sp = await shipPlacement(page);
  expect(sp).not.toBeNull();
  const { placement: p } = sp;
  await flyTo(page, p.wx, p.wz, 40, 3);

  // 用页面里的真实模块算「船 AABB 内每列的地表高度」，确认全在水下
  const result = await page.evaluate(async ({ p, seed }) => {
    const m = await import('/src/gen/structures/shallow-water-tarns.js');
    const t = await import('/src/gen/structures/shallow-water-terrain.js');
    const a = m.computeShallowTarnAnchor(seed);
    let dry = 0;
    const SEA_Y = -2;
    for (let x = p.wx - p.loX; x <= p.wx + p.hiX; x++) {
      for (let z = p.wz - p.loZ; z <= p.wz + p.hiZ; z++) {
        if (t.shallowTarnSurfaceYAt(x, z, seed, a) > SEA_Y - 1) dry++;
      }
    }
    return { dry };
  }, { p, seed: SEED });

  expect(result.dry).toBe(0);
});

test('中世纪船: 不与五座高台重叠（真实世界方块级验证）', async ({ page }) => {
  await openGame(page);
  const sp = await shipPlacement(page);
  expect(sp).not.toBeNull();
  const { placement: p } = sp;
  await flyTo(page, p.wx, p.wz, 40, 4);

  // 用页面里的真实模块算五座高台的 AABB，确认与船 AABB 不相交
  const result = await page.evaluate(async ({ p, seed }) => {
    const m = await import('/src/gen/structures/shallow-water-tarns.js');
    const a = m.computeShallowTarnAnchor(seed);
    const layout = m.computeShallowTarnLayout(seed);
    const shipBox = {
      minX: p.wx - p.loX, maxX: p.wx + p.hiX,
      minZ: p.wz - p.loZ, maxZ: p.wz + p.hiZ,
    };
    let overlap = 0;
    for (const pl of layout) {
      const hw = m.shallowTarnHalfWidth(pl.variant);
      const cx = Math.round(a.wx + pl.cx), cz = Math.round(a.wz + pl.cz);
      const box = { minX: cx - hw.loX, maxX: cx + hw.hiX, minZ: cz - hw.loZ, maxZ: cz + hw.hiZ };
      if (shipBox.minX <= box.maxX && shipBox.maxX >= box.minX &&
          shipBox.minZ <= box.maxZ && shipBox.maxZ >= box.minZ) {
        overlap++;
      }
    }
    return { overlap };
  }, { p, seed: SEED });

  expect(result.overlap).toBe(0);
});

test('中世纪船: 船底紧贴湖底方块顶面（不埋进沙里、不悬空）', async ({ page }) => {
  await openGame(page);
  const sp = await shipPlacement(page);
  expect(sp).not.toBeNull();
  const { placement: p } = sp;
  await flyTo(page, p.wx, p.wz, 40, 3);

  // 船底世界 y = SEA_Y = -2（湖底方块在 -3，顶面 -2）
  const SEA_Y = -2;
  // 船心列的船底那一格必须是船体方块（不是水、不是沙）
  const bottomName = await blockNameAt(page, p.wx, SEA_Y, p.wz);
  const shipMats = new Set([
    'oak_planks', 'oak_planks_1', 'acacia_planks', 'planks_step', 'planks_step_updown',
    'half_block_updown', 'sand_slab', 'vertical_pillar', 'handrail', 'handrailA',
    'marble', 'snow', 'giant_mangrove_log', 'sand',
  ]);
  expect(shipMats.has(bottomName)).toBe(true);

  // 船底正下方一格（y=-3）必须是湖底沙（不是空气 = 船悬空；不是船体 = 船埋进沙里）
  const belowName = await blockNameAt(page, p.wx, SEA_Y - 1, p.wz);
  expect(belowName).toBe('sand');
});

test('中世纪船: 朝向抽签在多个 seed 间变化（不是恒朝一个方向）', async ({ page }) => {
  await openGame(page);
  // 用页面里的真实模块对多个 seed 算落点，确认朝向多样
  const variants = await page.evaluate(async () => {
    const m = await import('/src/gen/structures/medieval-ship.js');
    const seen = new Set();
    for (let seed = 1; seed <= 40; seed++) {
      m.clearMedievalShipCache();
      const p = m.computeMedievalShipPlacement(seed);
      if (p) seen.add(p.variant);
    }
    return [...seen];
  });
  // 40 个 seed 应覆盖全部 4 个朝向（抽签必须真的在动）
  expect(variants.length).toBe(4);
});

// ---------------------------------------------------------------------------
// 用户手工修复的固化（2026-11-01）
// ---------------------------------------------------------------------------

/**
 * 用户修复时用的那个 seed。
 *
 * ⚠️ **本用例必须用这个 seed，不能用文件顶部的 `SEED`（12345）**：用户是在
 * seed 14330926 的世界里逐格改的船（船心 (603,214)，抽到 o0 变体），叠加层的
 * 坐标空间就是那艘船的局部坐标。换个 seed 会抽到别的朝向、落到别的位置，
 * 叠加层的坐标就对不上了（而产物本身是四个变体都带修复的，所以其它 seed 也正确，
 * 只是无法用这份存档做逐格比对）。
 */
const USER_FIX_SEED = 14330926;

test('中世纪船: 用户的修复已固化 —— 用他自己的 seed 开新世界（零 edits），船已是他改好的样子', async ({ page }) => {
  test.setTimeout(600_000);
  // ⚠️ 全新的浏览器上下文 ⇒ IndexedDB 为空 ⇒ **没有任何玩家 edits**。
  // 这正是本用例的载荷性前提：世界里读到的每一格都只能来自 GEN（= 烘焙产物），
  // 不可能是「用户存档里的编辑被重放了一遍」。若固化失败（叠加层没进产物），
  // 这里读到的就是修复前的旧船形。
  await page.goto(`/?seed=${USER_FIX_SEED}&vd=8&skybox=0`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 120_000 });
  await page.evaluate(() => window.__MC_GAME__.setShadowsEnabled(false));

  // 落点必须与用户当时那艘船一致（否则坐标换算无从谈起）
  const p = await page.evaluate(async (seed) => {
    const m = await import('/src/gen/structures/medieval-ship.js');
    m.clearMedievalShipCache();
    return m.computeMedievalShipPlacement(seed);
  }, USER_FIX_SEED);
  expect(p, '用户的 seed 必须有船落点').not.toBeNull();
  expect(p.variant, '必须抽到 o0 变体（叠加层的坐标空间就是它）').toBe('medieval_ship_o0');
  expect([p.wx, p.wz], '船心必须与用户存档里那艘一致').toEqual([603, 214]);

  await flyTo(page, p.wx, p.wz, 40, 3);

  const overlay = await page.evaluate(async () => {
    const r = await fetch('/assets/medieval-ship/src/user-fix-o0.json');
    return r.json();
  });

  // 逐格比对：叠加层的每一条 set / remove 都必须在**真实世界**里成立
  const result = await page.evaluate(([p, overlay]) => {
    const g = window.__MC_GAME__;
    const SEA_Y = -2;                 // 船底世界 y（= lakeFloorY + 1）
    const worldOf = (lx, ly, lz) => [p.wx + lx, SEA_Y + ly - 1, p.wz + lz];

    const setBad = [];
    for (const [lx, ly, lz, name, meta] of overlay.set) {
      const [x, y, z] = worldOf(lx, ly, lz);
      const id = g.world.getBlockId(x, y, z);
      const gotName = id === 0 ? 'air' : g.registry.nameOf(id);
      const gotMeta = g.world.getBlockMeta(x, y, z) & 3;
      if (gotName !== name || gotMeta !== meta) {
        setBad.push({ at: `${x},${y},${z}`, want: `${name}(m${meta})`, got: `${gotName}(m${gotMeta})` });
      }
    }

    const removeBad = [];
    for (const [lx, ly, lz] of overlay.remove) {
      const [x, y, z] = worldOf(lx, ly, lz);
      const id = g.world.getBlockId(x, y, z);
      if (id !== 0) {
        removeBad.push({ at: `${x},${y},${z}`, got: g.registry.nameOf(id) });
      }
    }

    // 栏杆三兄弟的世界计数（整个船 AABB 内）—— 与产物契约同口径的第三层防线
    const counts = { handrail: 0, handrailA: 0, vertical_pillar: 0 };
    for (let x = p.wx - p.loX; x <= p.wx + p.hiX; x++) {
      for (let z = p.wz - p.loZ; z <= p.wz + p.hiZ; z++) {
        for (let y = SEA_Y; y <= SEA_Y + 36; y++) {
          const id = g.world.getBlockId(x, y, z);
          if (id === 0) continue;
          const n = g.registry.nameOf(id);
          if (counts[n] !== undefined) counts[n]++;
        }
      }
    }
    return { setBad: setBad.slice(0, 8), setBadCount: setBad.length,
             removeBad: removeBad.slice(0, 8), removeBadCount: removeBad.length, counts };
  }, [p, overlay]);

  await page.evaluate(() => clearInterval(window.__PIN__));

  // ① 106 条写入逐格成立（含朝向）—— 这是「完全按照我修复的样子」的直接判据
  expect(result.setBadCount,
    `叠加层 ${overlay.set.length} 条写入里有 ${result.setBadCount} 条在真实世界里不成立：`
    + JSON.stringify(result.setBad)).toBe(0);
  // ② 6 条删除逐格成立（那些格必须是空气）
  expect(result.removeBadCount,
    `叠加层要删的 ${overlay.remove.length} 格里有 ${result.removeBadCount} 格还在世界里：`
    + JSON.stringify(result.removeBad)).toBe(0);
  // ③ 栏杆分布 = 修复后的目标值（未固化时是 21/15/158）
  expect(result.counts, '船 AABB 内的栏杆类方块计数（用户修复后的目标值）')
    .toEqual({ handrail: 6, handrailA: 120, vertical_pillar: 68 });
});
