// tests/giant-pyramid.spec.mjs — 巨型金字塔 Tier 4（真实页面、数据级；不靠目视）
//
// 为什么需要 Tier 4（浏览器内单测测不到）：
//   · 单测直接调 `applyStructuresToColumn`，验的是「函数写对了」；
//     真实页面验的是「接线通了 + column 调度真的把方块送上屏 + 容量没被撑爆」。
//   · 单测的「迷宫连通」是在**原模型数据**上算的，本 spec 在**真实世界方块**上算 ——
//     后者才会暴露「塔被地形埋住一半」「撒布结构长进塔里」这类落地问题。
//
// ⚠️ 必读的两条既有约束：
//   ① `setShadowsEnabled(false)` —— VSM 下 receiveShadow 的对象也进阴影 pass
//      （AGENTS.md 阴影约束），会让 drawCalls/reservedV 与本 spec 无关地波动。
//   ② 传送用 `player.physics.pos` + 定时 pin（`clearInterval(window.__PIN__)` 打头）——
//      物理会把玩家拉回地面，不 pin 住就停不在视域中心。
//
// ⚠️ **可站立的判据必须用本仓物理口径**：本仓 `world.isSolid` 读 `solidTable`，
//    **台阶/半砖在碰撞上就是整格**。若按「脚下 1~2 格内实心」算（原版台阶=半口的惯性），
//    会把 36 个实际走不到的高层格算成可达 → 得到 100% 的**假通过**。
//    本仓口径实测：可站立 2400 / 从外圈可达 2364 = 98.5%。
import { test, expect } from 'playwright/test';

const SEED = 12345;
/** 初始容量（render-world.js CAPACITY：opaque 1800×1900×1.25 / cutout 550×3200×1.25 / transparent 100×1000×1.25）
 * ⚠️ 「容量 == 标定值」断言必须在**开局**做：扩容是黏性的，`2.85M × 1.5` 恰好等于 `4.275M`
 * （既有教训：改回容量后末尾断言照样通过），所以开局先钉住初始值。 */
const INIT = { opaque: 1800 * 1900 * 1.25, cutout: 550 * 3200 * 1.25, transparent: 100 * 1000 * 1.25 };

/** 队列收敛（唯一权威口径，与 giant-tree-budget.spec.mjs 同一份） */
const queueConverged = () => {
  const s = window.__MC_GAME__.scheduler;
  return s._inflightGen.size === 0 && s._meshQueue.length === 0 && s._inflightMesh.size === 0 &&
         s._uploadQueue.length === 0 && s._pendingMesh.size === 0 && s._lightQueue.size === 0 && s._inflightLight.size === 0;
};

/** 找离原点最近的金字塔锚点（在页面内跑真实模块，不是 Node 侧复算） */
async function nearestAnchor(page) {
  return page.evaluate(async ({ seed }) => {
    const m = await import('/src/gen/structures/giant-pyramid.js');
    let best = null, bestD = Infinity;
    for (let rx = -4; rx <= 4; rx++) for (let rz = -4; rz <= 4; rz++) {
      const a = m.computeGiantPyramidAnchor(rx, rz, seed);
      if (!a) continue;
      const d = Math.hypot(a.wx, a.wz);
      if (d < bestD) { bestD = d; best = a; }
    }
    return best ? { ...best, half: m.PYRAMID_HALF, height: m.PYRAMID_HEIGHT } : null;
  }, { seed: SEED });
}

/** 传送到 (x,z) 并 pin 住，等周围 column 就绪 + 队列收敛 */
async function flyTo(page, x, z, y) {
  await page.evaluate(([px, pz, py]) => {
    clearInterval(window.__PIN__);
    const ph = window.__MC_GAME__.player.physics;
    ph.pos.x = px; ph.pos.y = py; ph.pos.z = pz;
    ph.vel.x = ph.vel.y = ph.vel.z = 0;
    window.__PIN__ = setInterval(() => { ph.pos.x = px; ph.pos.z = pz; ph.pos.y = py; ph.vel.y = 0; }, 30);
  }, [x, z, y]);
  await page.waitForFunction(([px, pz]) => {
    const g = window.__MC_GAME__;
    const cx = Math.floor(px / 16), cz = Math.floor(pz / 16);
    // 49×49 占地要跨多 column，取 ±6 圈（覆盖 96 格半径，足够容纳整个塔）
    for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) {
      if (!g.world.hasColumn(cx + dx, cz + dz)) return false;
    }
    return true;
  }, [x, z], { timeout: 180_000 });
  await page.waitForFunction(queueConverged, null, { timeout: 180_000 });
}

async function openGame(page, vd = 8) {
  await page.goto(`/?seed=${SEED}&vd=${vd}`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 120_000 });
  await page.evaluate(() => window.__MC_GAME__.setShadowsEnabled(false));
}

async function unpin(page) {
  await page.evaluate(() => clearInterval(window.__PIN__));
}

test('金字塔：真实页面里锚点处确实长出了塔（特征方块 + 逐格位置）', async ({ page }) => {
  test.setTimeout(600_000);
  await openGame(page);
  const anchor = await nearestAnchor(page);
  expect(anchor, '必须找到至少一个金字塔锚点（否则本 spec 失去意义）').not.toBeNull();

  // 飞到塔边（不站在塔里，避免物理推挤）
  await flyTo(page, anchor.wx + 40, anchor.wz, anchor.floorY + 30);

  const r = await page.evaluate(async ({ wx, wz, floorY, half, height }) => {
    const g = window.__MC_GAME__;
    const idStep = g.registry.idOf('sand_step');
    const idSlab = g.registry.idOf('sand_slab');
    const idSand = g.registry.idOf('sand');
    let steps = 0, slabs = 0, sands = 0, nonAir = 0;
    // 逐格扫占地区域（y = floorY+1 .. floorY+height）
    for (let y = floorY + 1; y <= floorY + height; y++) {
      for (let dz = -half; dz <= half; dz++) {
        for (let dx = -half; dx <= half; dx++) {
          const id = g.world.getBlockId(wx + dx, y, wz + dz);
          if (id === 0) continue;
          nonAir++;
          if (id === idStep) steps++;
          else if (id === idSlab) slabs++;
          else if (id === idSand) sands++;
        }
      }
    }
    // 塔尖（最高点）应在 floorY+height 附近且是沙系
    const topId = g.world.getBlockId(wx, floorY + height, wz);
    return { steps, slabs, sands, nonAir, topId, height };
  }, { wx: anchor.wx, wz: anchor.wz, floorY: anchor.floorY, half: anchor.half, height: anchor.height });

  await unpin(page);

  // sanity：扫描区域必须有方块（防「扫错坐标 → 全 0 → 恰好 ≥ 阈值」的假通过）
  expect(r.nonAir, '扫描区域必须有非空气方块（否则坐标算错）').toBeGreaterThan(5000);
  // 产物契约实测：1219 台阶 / 1 半砖 / 14987 沙（允许少量被后写阶段覆盖）
  expect(r.steps, 'sand_step 计数（产物 1219）').toBeGreaterThan(1000);
  expect(r.sands, 'sand 计数（产物 14987）').toBeGreaterThan(12000);
  expect(r.slabs, 'sand_slab 计数（产物 1，塔尖）').toBeGreaterThanOrEqual(1);
});

test('金字塔：迷宫按本仓物理口径连通（可站立格数 + 从外圈可达率）', async ({ page }) => {
  test.setTimeout(600_000);
  await openGame(page);
  const anchor = await nearestAnchor(page);
  await flyTo(page, anchor.wx + 40, anchor.wz, anchor.floorY + 30);

  const r = await page.evaluate(async ({ wx, wz, floorY, half, height }) => {
    const g = window.__MC_GAME__;
    const reg = g.registry;
    const solid = (x, y, z) => {
      const id = g.world.getBlockId(x, y, z);
      return id !== 0 && reg.solidTable[id] === 1;   // ⚠️ 整格口径（台阶/半砖也算实心）
    };
    // 可站立 = 脚格+头格空气 + **脚下 1 格**实心（不是 1~2 格！见文件头）
    const standable = (x, y, z) => !solid(x, y, z) && !solid(x, y + 1, z) && solid(x, y - 1, z);

    const cells = new Set();
    for (let rel = 1; rel <= height; rel++) {
      const y = floorY + rel;
      for (let dz = -half; dz <= half; dz++) {
        for (let dx = -half; dx <= half; dx++) {
          if (standable(wx + dx, y, wz + dz)) cells.add(`${wx + dx},${rel},${wz + dz}`);
        }
      }
    }
    if (cells.size === 0) return { cells: 0, reachable: 0, sandFamily: 0, perLevelMax: 0 };

    // 从外圈可站立的格出发 BFS（阶梯移动 dy ∈ {0,+1,-1,-2}）
    const q = [], seen = new Set();
    for (const k of cells) {
      const [x, , z] = k.split(',').map(Number);
      if (Math.abs(x - wx) >= half - 1 || Math.abs(z - wz) >= half - 1) { q.push(k); seen.add(k); }
    }
    while (q.length) {
      const [x, rel, z] = q.pop().split(',').map(Number);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        for (const dy of [0, 1, -1, -2]) {
          const k = `${x + dx},${rel + dy},${z + dz}`;
          if (cells.has(k) && !seen.has(k)) { seen.add(k); q.push(k); }
        }
      }
    }

    // 沙系方块数（证明「塔真的在」，而不是只有地形）
    const sandIds = new Set([reg.idOf('sand'), reg.idOf('sand_step'), reg.idOf('sand_slab')]);
    let sandFamily = 0;
    for (let rel = 1; rel <= height; rel++) {
      for (let dz = -half; dz <= half; dz++) {
        for (let dx = -half; dx <= half; dx++) {
          if (sandIds.has(g.world.getBlockId(wx + dx, floorY + rel, wz + dz))) sandFamily++;
        }
      }
    }
    // 各层可站立格数的峰值（= 最“宽”的那一层，能反映出塔的锥形轮廓是否在）
    const perLevel = new Map();
    for (const k of cells) {
      const rel = +k.split(',')[1];
      perLevel.set(rel, (perLevel.get(rel) || 0) + 1);
    }
    const perLevelMax = Math.max(...perLevel.values());

    return { cells: cells.size, reachable: seen.size, sandFamily, perLevelMax, levels: perLevel.size };
  }, { wx: anchor.wx, wz: anchor.wz, floorY: anchor.floorY, half: anchor.half, height: anchor.height });

  await unpin(page);

  // ⚠️⚠️ **判据的设计史（免得后人重复踩坑）**：
  //   ① 「可达率 95%」单独用**不是有效判据**：本仓塔是**每层向内收 2 格的阶梯锥形**，
  //      所以任何「填实某一层」的注入都堵不住通路（可以从外侧绕上去）。实测：
  //        · 填实相对层 5..14（含头部空间）→ cells 2400→2965、ratio 仍 0.985
  //        · 填实相对层 1..20 → cells 仍 2400、ratio 反而变 1.0
  //      ⇒ 可达率只证明「结构没把入口堵死」，它挡不住“塔根本不在”。
  //   ② 「可站立格数」单独用也不行：断开 STRUCTURE_FILES 后 cells 从 2400 → 2401
  //      （沙漠地表本身就能站人，数量几乎不变）。
  //   ③ **有效判据 = 沙系方块数**：断开映射后 sandFamily 从 **16524 → 4037**（只剩地形里的
  //      天然沙）。这才是「塔真的生成了」的量化证据。
  //   故本用例同时钉三件：塔在（sandFamily）、有可站立结构（cells）、且从外圈基本可达（ratio）。
  expect(r.sandFamily, `塔身沙系方块数（无塔时应 ~4037，有塔时应 ~16524）`).toBeGreaterThan(12000);
  expect(r.cells, '可站立格数（本仓口径）').toBeGreaterThan(1500);
  expect(r.perLevelMax, '单层可站立格数峰值（锥形轮廓）').toBeGreaterThan(200);
  expect(r.levels, '有可站立格的层数（应接近塔高）').toBeGreaterThan(15);

  const ratio = r.reachable / r.cells;
  expect(ratio, `可达率 ${(ratio * 100).toFixed(1)}%（可达 ${r.reachable}/${r.cells}）`).toBeGreaterThanOrEqual(0.95);
});

test('金字塔：塔基不悬空（塔基格必须是沙系 + 正下方 1 格有实心）', async ({ page }) => {
  test.setTimeout(600_000);
  await openGame(page);
  const anchor = await nearestAnchor(page);
  await flyTo(page, anchor.wx + 40, anchor.wz, anchor.floorY + 30);

  const r = await page.evaluate(async ({ wx, wz, floorY, half }) => {
    const g = window.__MC_GAME__;
    const reg = g.registry;
    const solid = (x, y, z) => {
      const id = g.world.getBlockId(x, y, z);
      return id !== 0 && reg.solidTable[id] === 1;
    };
    const sandFamily = new Set([reg.idOf('sand'), reg.idOf('sand_step'), reg.idOf('sand_slab')]);

    let checked = 0;
    let baseNotSand = 0;    // 塔基格（floorY+1）不是沙系 → y 换算错/塔被埋
    let baseFloating = 0;   // 塔基正下方 1 格（floorY）无实心 → 浮空
    const samples = [];
    for (let dz = -half; dz <= half; dz++) {
      for (let dx = -half; dx <= half; dx++) {
        checked++;
        const x = wx + dx, z = wz + dz;
        const baseId = g.world.getBlockId(x, floorY + 1, z);
        if (!sandFamily.has(baseId)) {
          baseNotSand++;
          if (samples.length < 5) samples.push(`${x},${floorY + 1},${z}:${reg.nameOf(baseId) || baseId}`);
        }
        if (!solid(x, floorY, z)) baseFloating++;
      }
    }
    return { checked, baseNotSand, baseFloating, samples };
  }, { wx: anchor.wx, wz: anchor.wz, floorY: anchor.floorY, half: anchor.half });

  await unpin(page);

  expect(r.checked).toBe(49 * 49);

  // ⚠️⚠️ **主判据 = 塔基格必须是沙系**。这是实测出来的**唯一有判别力**的判据：
  //   负向验证（把 apply 的 `floorY + 1` 改成 `floorY + 6`，塔整座上移 5 格）：
  //     · 「向下 6 格内有实心」→ 0/2401（**完全无判别力**：塔仍在地表附近，下方总有地形）
  //     · 「正下方 1 格实心」  → 0/2401（同上，floorY 是地表格，上移 5 格后它仍是地形）
  //     · 「塔基格是沙系」    → **459/2401 命中** ← 只有它能拓到 y 换算错
  //   所以判据必须看“塔基格本身是什么方块”，不是“塔底下有没有东西”。
  const ratioBase = r.baseNotSand / r.checked;
  expect(ratioBase,
    `塔基格非沙系 ${r.baseNotSand}/${r.checked} = ${(ratioBase * 100).toFixed(2)}%（样例 ${r.samples.join(' ')}）`,
  ).toBeLessThanOrEqual(0.01);

  // 次判据：正下方 1 格应有实心（洞穴挖空的列例外）。实测（含洞穴）4 座 × 2401 = 0.104%。
  const ratioFloat = r.baseFloating / r.checked;
  expect(ratioFloat, `塔基下方悬空 ${r.baseFloating}/${r.checked} = ${(ratioFloat * 100).toFixed(3)}%`).toBeLessThanOrEqual(0.02);
});

test('金字塔：顶点预算（开局容量未改 + 三通道零扩容）', async ({ page }) => {
  test.setTimeout(600_000);
  await openGame(page);

  // ⚠️ 开局先断言初始容量（此时一次扩容都还没发生）
  const initCap = await page.evaluate(() => {
    const c = window.__MC_GAME__.renderWorld._capacity;
    return { opaque: c.opaque.maxVertexCount, cutout: c.cutout.maxVertexCount, transparent: c.transparent.maxVertexCount };
  });
  expect(initCap.opaque).toBe(INIT.opaque);
  expect(initCap.cutout).toBe(INIT.cutout);
  expect(initCap.transparent).toBe(INIT.transparent);

  const anchor = await nearestAnchor(page);
  await flyTo(page, anchor.wx + 40, anchor.wz, anchor.floorY + 30);

  const r = await page.evaluate(async ({ wx, wz, half }) => {
    const g = window.__MC_GAME__;
    const rw = g.renderWorld;
    // 只统计「金字塔占地覆盖到的 column」的 section reservedV，避免把整个视域加载算进来
    const cxSet = new Set();
    for (let dz = -half; dz <= half; dz++) for (let dx = -half; dx <= half; dx++) {
      cxSet.add(`${Math.floor((wx + dx) / 16)},${Math.floor((wz + dz) / 16)}`);
    }
    const inFootprint = { opaque: 0, cutout: 0, transparent: 0 };
    const total = { opaque: 0, cutout: 0, transparent: 0 };
    for (const [key, slot] of rw.slotMap) {
      total[slot.channel] += slot.reservedV;
      const [cx, , cz] = key.split(',').map(Number);
      if (cxSet.has(`${cx},${cz}`)) inFootprint[slot.channel] += slot.reservedV;
    }
    const c = rw._capacity;
    return {
      inFootprint, total,
      caps: { opaque: c.opaque.maxVertexCount, cutout: c.cutout.maxVertexCount, transparent: c.transparent.maxVertexCount },
    };
  }, { wx: anchor.wx, wz: anchor.wz, half: anchor.half });

  await unpin(page);

  // 主判据：三通道**零扩容**（玩家能感知到卡顿的就是这个）
  expect(r.caps.opaque, 'opaque 通道不得扩容').toBe(INIT.opaque);
  expect(r.caps.cutout, 'cutout 通道不得扩容').toBe(INIT.cutout);
  expect(r.caps.transparent, 'transparent 通道不得扩容').toBe(INIT.transparent);

  // 辅助信号：金字塔占地内 occupied 不得超过阈值的比例（实测 opaque 2.89% / cutout 3.48%）
  // 门取 15%：远高于实测，但仍能抓住「金字塔变成几倍体量」这种真回归（贴线会 flaky）。
  expect(r.inFootprint.opaque / INIT.opaque, 'opaque 占地占用').toBeLessThan(0.15);
  expect(r.inFootprint.cutout / INIT.cutout, 'cutout 占地占用').toBeLessThan(0.15);
  // sanity：确实有东西被统计（防「slotMap 空了 → 占比 0 → 恒过」）
  expect(r.total.opaque, '全视域必须有 opaque 顶点（否则统计口径失效）').toBeGreaterThan(100_000);
});

test('金字塔：台阶朝向与坡面一致（凹口朝塔外，四向分布）', async ({ page }) => {
  test.setTimeout(600_000);
  await openGame(page);
  const anchor = await nearestAnchor(page);
  await flyTo(page, anchor.wx + 40, anchor.wz, anchor.floorY + 30);

  const r = await page.evaluate(async ({ wx, wz, floorY, half, height }) => {
    const g = window.__MC_GAME__;
    const stepId = g.registry.idOf('sand_step');
    const steps = [];
    for (let dy = 1; dy <= height; dy++) {
      for (let dz = -half; dz <= half; dz++) {
        for (let dx = -half; dx <= half; dx++) {
          const x = wx + dx, y = floorY + dy, z = wz + dz;
          if (g.world.getBlockId(x, y, z) !== stepId) continue;
          steps.push({ dx, dz, meta: g.world.getBlockMeta(x, y, z) & 3 });
        }
      }
    }
    // orient → 凹口方向（实测：0=东 1=北 2=西 3=南，见 src/tests/test-giant-pyramid-gen.js）
    const NOTCH = ['east', 'north', 'west', 'south'];
    const FACE = ['east', 'west', 'south', 'north'];
    const groups = { east: [], west: [], south: [], north: [] };
    for (const s of steps) {
      // 按格位相对锚点归到最近的一面坡（对角格归主导轴）
      const face = Math.abs(s.dx) >= Math.abs(s.dz) ? (s.dx > 0 ? 'east' : 'west') : (s.dz > 0 ? 'south' : 'north');
      groups[face].push(NOTCH[s.meta]);
    }
    const out = {};
    const hist = [0, 0, 0, 0];
    for (const f of FACE) {
      const arr = groups[f];
      if (arr.length === 0) { out[f] = { n: 0, pct: 0 }; continue; }
      const match = arr.filter((d) => d === f).length;
      out[f] = { n: arr.length, match, pct: match / arr.length };
    }
    for (const s of steps) hist[s.meta]++;
    return { total: steps.length, out, hist };
  }, { wx: anchor.wx, wz: anchor.wz, floorY: anchor.floorY, half: anchor.half, height: anchor.height });

  await unpin(page);

  expect(r.total, '台阶总数（产物 1219）').toBeGreaterThan(1200);
  // 四向都要有（单一朝向 = 映射退化，塔的四面会全错）
  for (let o = 0; o < 4; o++) {
    expect(r.hist[o], `orient=${o} 的台阶数（四向应接近均匀，实测 305/303/305/306）`).toBeGreaterThan(200);
  }
  // 每面坡至少 90% 的台阶凹口朝塔外
  // 实测：北/南 100%、东/西 97%（余下是转角台阶归到相邻坡面的分类边界，属正常）
  for (const [face, v] of Object.entries(r.out)) {
    if (v.n < 50) continue;
    expect(v.pct, `${face} 坡凹口朝外的比例 ${(v.pct * 100).toFixed(0)}%（${v.match}/${v.n}）`).toBeGreaterThanOrEqual(0.9);
  }
});
