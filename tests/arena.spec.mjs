// tests/arena.spec.mjs — 城门竞技场 Tier 4（真实页面、数据级；不靠目视）
//
// 为什么需要 Tier 4（浏览器内单测测不到）：
//   · 单测直接调 `applyStructuresToColumn`，验的是「函数写对了」；
//     真实页面验的是「接线通了 + column 调度真的把方块送上屏」。
//   · 单测用的是同一份 `apply.js`，而真实页面还多一层 **Worker 内 layout RPC 下发**
//     —— `layout.arena` 字段没被 postMessage 带过去 / Worker 没预热锚点，
//     都会表现为「世界里什么都没有」，而单测全绿。
//
// ⚠️ 必读的两条既有约束（与 giant-pyramid.spec.mjs 同口径）：
//   ① `setShadowsEnabled(false)` —— VSM 下 receiveShadow 的对象也进阴影 pass，
//      会让 drawCalls/reservedV 与本 spec 无关地波动。
//   ② 传送用 `player.physics.pos` + 定时 pin —— 物理会把玩家拉回地面，
//      不 pin 住就停不在视域中心。
import { test, expect } from 'playwright/test';

const SEED = 12345;

/** 队列收敛（唯一权威口径，与 giant-pyramid.spec.mjs 同一份） */
const queueConverged = () => {
  const s = window.__MC_GAME__.scheduler;
  return s._inflightGen.size === 0 && s._meshQueue.length === 0 && s._inflightMesh.size === 0 &&
         s._uploadQueue.length === 0 && s._pendingMesh.size === 0 && s._lightQueue.size === 0 && s._inflightLight.size === 0;
};

/** 在页面内跑真实模块算锚点（不是 Node 侧复算 —— 验的是「页面里那个模块」） */
async function arenaAnchor(page) {
  return page.evaluate(async ({ seed }) => {
    const m = await import('/src/gen/structures/arena.js');
    m.clearArenaCache();
    const a = m.computeArenaAnchor(seed);
    return a ? {
      ...a,
      halfX: m.ARENA_HALF_X, halfZ: m.ARENA_HALF_Z,
      width: m.ARENA_WIDTH, depth: m.ARENA_DEPTH,
    } : null;
  }, { seed: SEED });
}

async function openGame(page, vd = 8) {
  await page.goto(`/?seed=${SEED}&vd=${vd}&skybox=0`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 120_000 });
  await page.evaluate(() => window.__MC_GAME__.setShadowsEnabled(false));
}

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
    // 41×79 占地要跨多 column（±3 圈覆盖 48 格半径 > 半深 39）
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
      if (!g.world.hasColumn(cx + dx, cz + dz)) return false;
    }
    return true;
  }, [x, z], { timeout: 180_000 });
  await page.waitForFunction(queueConverged, null, { timeout: 180_000 });
}

async function unpin(page) {
  await page.evaluate(() => clearInterval(window.__PIN__));
}

test('竞技场：真实页面里南门外确实长出了竞技场（地板 + 水池 + 栏杆）', async ({ page }) => {
  test.setTimeout(600_000);
  await openGame(page);
  const a = await arenaAnchor(page);
  expect(a, '必须能找到竞技场锚点（否则本 spec 失去意义）').not.toBeNull();

  // 飞到竞技场一侧的高空（不站在场地里，避免物理推挤）
  await flyTo(page, a.wx + a.halfX + 12, a.wz, a.floorY + 25);

  const r = await page.evaluate(async ({ wx, wz, floorY, halfX, halfZ }) => {
    const g = window.__MC_GAME__;
    const idOf = (n) => g.registry.idOf(n);
    const nameOf = (id) => (id === 0 ? 'air' : g.registry.nameOf(id));
    const counts = new Map();
    let air = 0, floorCells = 0;
    // 地板层（栏杆环内一圈起算：内容 39×77）
    for (let dz = -halfZ + 1; dz <= halfZ - 1; dz++) {
      for (let dx = -halfX + 1; dx <= halfX - 1; dx++) {
        floorCells++;
        const id = g.world.getBlockId(wx + dx, floorY, wz + dz);
        if (id === 0) { air++; continue; }
        const n = nameOf(id);
        counts.set(n, (counts.get(n) || 0) + 1);
      }
    }
    // 栏杆环（外圈）
    let rail = 0, notRail = 0;
    const ringCell = (dx, dz) => {
      const id = g.world.getBlockId(wx + dx, floorY + 1, wz + dz);
      const n = nameOf(id);
      if (n === 'handrail' || n === 'handrailA') rail++; else notRail++;
    };
    for (let dx = -halfX; dx <= halfX; dx++) { ringCell(dx, -halfZ); ringCell(dx, halfZ); }
    for (let dz = -halfZ + 1; dz <= halfZ - 1; dz++) { ringCell(-halfX, dz); ringCell(halfX, dz); }
    // 四角必须是转角件
    const corners = [[-halfX, -halfZ], [halfX, -halfZ], [halfX, halfZ], [-halfX, halfZ]]
      .map(([dx, dz]) => nameOf(g.world.getBlockId(wx + dx, floorY + 1, wz + dz)));
    // 地板下一格：要么实心（支撑），要么是水（水池）
    let unsupported = 0;
    for (let dz = -halfZ + 1; dz <= halfZ - 1; dz++) {
      for (let dx = -halfX + 1; dx <= halfX - 1; dx++) {
        const id = g.world.getBlockId(wx + dx, floorY - 1, wz + dz);
        if (id === 0) unsupported++;
        else if (g.registry.nameOf(id) !== 'water' && g.registry.solidTable[id] !== 1) unsupported++;
      }
    }
    return {
      floorCells, air, unsupported, rail, notRail, corners,
      counts: Object.fromEntries(counts),
      waterBelow: g.registry.nameOf(g.world.getBlockId(wx, floorY - 1, wz)),
      glassOnFloor: [...counts.entries()].filter(([n]) => n === 'glass_block').map(([, v]) => v)[0] || 0,
    };
  }, { wx: a.wx, wz: a.wz, floorY: a.floorY, halfX: a.halfX, halfZ: a.halfZ });

  await unpin(page);

  // sanity：扫描区必须有方块（防「扫错坐标 → 全 0 → 恰好 ≥ 阈值」的假通过）
  const floorSolid = r.floorCells - r.air;
  expect(floorSolid, '地板层必须有大量方块（否则坐标算错或竞技场没生成）').toBeGreaterThan(2500);
  expect(r.air, `地板层不得有空气格（会漏下去）；实得 ${r.air}`).toBe(0);
  expect(r.counts.grass || 0, '地板主体必须是 grass').toBeGreaterThan(2000);
  expect(r.glassOnFloor, '水池玻璃水面盖').toBeGreaterThan(50);
  expect(r.unsupported, `地板下方必须是实心支撑或水（否则玩家挖开掉进洞里）；实得 ${r.unsupported}`).toBe(0);
  expect(r.notRail, `栏杆环上不得有缺口（实际 ${r.rail} 格是栏杆）`).toBe(0);
  expect(r.corners, '四角必须是转角件 handrail').toEqual(['handrail', 'handrail', 'handrail', 'handrail']);
});

test('竞技场：地板高度 = 占地内最低自然地形（贴合地形最低点）', async ({ page }) => {
  test.setTimeout(600_000);
  await openGame(page);
  const a = await arenaAnchor(page);
  await flyTo(page, a.wx + a.halfX + 12, a.wz, a.floorY + 25);

  const r = await page.evaluate(async ({ wx, wz, floorY, halfX, halfZ, seed }) => {
    const g = window.__MC_GAME__;
    const { generateHeight } = await import('/src/gen/terrain.js');
    let mn = Infinity;
    for (let dz = -halfZ; dz <= halfZ; dz++) {
      for (let dx = -halfX; dx <= halfX; dx++) {
        const h = generateHeight(wx + dx, wz + dz, seed);
        if (h < mn) mn = h;
      }
    }
    // 地板层在 y = floorY；检查它**确实是**方块、且 floorY-1 不是「还有自然地形的空列」
    const floorId = g.world.getBlockId(wx, floorY, wz);
    return { mn, floorY, floorName: floorId === 0 ? 'air' : g.registry.nameOf(floorId) };
  }, { wx: a.wx, wz: a.wz, floorY: a.floorY, halfX: a.halfX, halfZ: a.halfZ, seed: SEED });

  await unpin(page);
  expect(r.mn, '占地内最低自然高度必须等于 floorY（用户要求「贴合周围地形的最低点」）').toBe(r.floorY);
  expect(r.floorName, '锚点地板格必须是方块（不是 air）').not.toBe('air');
});

test('竞技场：栏杆朝向与邻居匹配（读真实世界方块的 meta）', async ({ page }) => {
  // ⚠️ **这条与上一条是两件事**：上一条只查方块名（handrail / handrailA），
  // 把所有直段都写成 `handrail orient=0` 也能通过（实测负向验证确认）。
  // 用户的核心需求是「转角件旋转到与两边匹配、栏杆连续」——必须查 meta。
  test.setTimeout(600_000);
  await openGame(page);
  const a = await arenaAnchor(page);
  await flyTo(page, a.wx + a.halfX + 12, a.wz, a.floorY + 25);

  const r = await page.evaluate(async ({ wx, wz, floorY, halfX, halfZ }) => {
    const g = window.__MC_GAME__;
    const m = await import('/src/gen/structures/arena.js');
    const onRing = (dx, dz) => Math.abs(dx) <= halfX && Math.abs(dz) <= halfZ
      && (Math.abs(dx) === halfX || Math.abs(dz) === halfZ);
    const norm = (arms) => ['+X', '-X', '+Z', '-Z'].filter((x) => arms.includes(x)).join(' ');
    let mismatch = 0;
    const samples = [];
    for (let dz = -halfZ; dz <= halfZ; dz++) {
      for (let dx = -halfX; dx <= halfX; dx++) {
        if (!onRing(dx, dz)) continue;
        const id = g.world.getBlockId(wx + dx, floorY + 1, wz + dz);
        const name = id === 0 ? 'air' : g.registry.nameOf(id);
        const orient = g.world.getBlockMeta(wx + dx, floorY + 1, wz + dz) & 3;
        const need = [];
        if (onRing(dx + 1, dz)) need.push('+X');
        if (onRing(dx - 1, dz)) need.push('-X');
        if (onRing(dx, dz + 1)) need.push('+Z');
        if (onRing(dx, dz - 1)) need.push('-Z');
        const got = m.railArmSet(name, orient);
        if (norm(got) !== norm(need)) {
          mismatch++;
          if (samples.length < 6) samples.push(`(${dx},${dz}) ${name}:${orient} 实得[${norm(got)}] 需要[${norm(need)}]`);
        }
      }
    }
    return { mismatch, samples };
  }, { wx: a.wx, wz: a.wz, floorY: a.floorY, halfX: a.halfX, halfZ: a.halfZ });

  await unpin(page);
  expect(r.mismatch, `环上每格的臂方向必须与邻居匹配：${r.samples.join(' | ')}`).toBe(0);
});

test('竞技场：占地内没有树（巨树 / 杜鹃 / 普通树已让路）', async ({ page }) => {
  test.setTimeout(600_000);
  await openGame(page);
  const a = await arenaAnchor(page);
  await flyTo(page, a.wx + a.halfX + 12, a.wz, a.floorY + 25);

  const r = await page.evaluate(async ({ wx, wz, floorY, halfX, halfZ }) => {
    const g = window.__MC_GAME__;
    // 素材自带的两棵树是竞技场内容（wood 树干 + leaves 树冠），必须排除；
    // 其它任何树种出现在占地内 = 让路失效。
    const ALLOWED = new Set(['wood', 'leaves']);
    const TREE = new Set([
      'birch_log', 'sky_wood', 'sky_leaves', 'azalea_log', 'azalea_leaves', 'azalea_flowers',
      'giant_oak_log', 'giant_mangrove_log', 'giant_oak_leaves', 'giant_birch_leaves',
      'giant_spruce_leaves', 'giant_cherry_leaves', 'giant_palm_leaves', 'giant_banyan_leaves',
    ]);
    const hits = new Map();
    for (let dy = 1; dy <= 30; dy++) {
      for (let dz = -halfZ; dz <= halfZ; dz++) {
        for (let dx = -halfX; dx <= halfX; dx++) {
          const id = g.world.getBlockId(wx + dx, floorY + dy, wz + dz);
          if (id === 0) continue;
          const n = g.registry.nameOf(id);
          if (!TREE.has(n) || ALLOWED.has(n)) continue;
          hits.set(n, (hits.get(n) || 0) + 1);
        }
      }
    }
    return { hits: Object.fromEntries(hits) };
  }, { wx: a.wx, wz: a.wz, floorY: a.floorY, halfX: a.halfX, halfZ: a.halfZ });

  await unpin(page);
  expect(r.hits, `占地内不得有外来的树种（会让路失效）：${JSON.stringify(r.hits)}`).toEqual({});
});
