// tests/giant-tree-budget.spec.mjs — 巨树景观的通道容量预算回归门（Tier 4，真实页面）
//
// 口径（⚠️ 与 spec §1.2 一致，勿改成别的）：
//   · 占用 = Σ slot.reservedV / **初始**容量常量（reserved = 1.25 × 已用顶点，render-world.js:204；
//     扩容判据看 reserved；相对初始常量算，因为扩容是黏性的，当前 maxVertexCount 会随历史漂移）。
//   · 固定 5 个视域（静态：队列收敛 + section 数稳定）+ 3 条冲刺路径（12s、8 格/秒、250ms 采样峰值）。
//     ⚠️ 冲刺必须从森林/海岸起步：出生点在城市中心，三个方向冲 96 格都出不了城，永远测不到树。
//   · opaque：≤ 90%（实测最高 82.1%）且**不得发生 opaque 扩容**（maxVertexCount 仍是 4.275M）。
//     ⚠️ 「容量 == 4.275M」单看末尾不够：2.85M × 1.5 恰好 = 4.275M —— 若 CAPACITY.opaque 被改回 1200，页面会在
//     (-20,10) 扩容到 4.275M，末尾断言照样通过（负向验证实测：注入后仍全绿）。所以**每个用例开局先断言初始容量**
//     （此时在出生点、一次扩容都还没发生），把「容量被改回」直接钉住。
//   · cutout / transparent：**不得比 HEAD 同视域/同路径更糟**（+1.0 容差）。HEAD 自己在密林视域就越线
//     （cutout 128% / 冲刺 145%，会触发 ×1.5 扩容），所以「任何视域都不扩容」对 HEAD 就不成立 ——
//     验收口径是「相对 HEAD 不恶化」，不是「绝对不扩容」。巨树只替换旧森林树（cutout 通道），不碰水。
// 计时型：冲刺峰值依赖加载时序，高负载下贴线 → 先交替对照比分布，不要看单次数值（CLAUDE.md 既有口径）。
import { test, expect } from 'playwright/test';

/** 巨树景观后的初始容量（CAPACITY：opaque 1800×1900×1.25；cutout 550×3200×1.25；transparent 100×1000×1.25） */
const INIT = { opaque: 1800 * 1900 * 1.25, cutout: 550 * 3200 * 1.25, transparent: 100 * 1000 * 1.25 };

/**
 * HEAD 基线（2026-10-23，seed 12345 / vd 8，HEAD=218f836 实测；相对 **HEAD 的初始容量** 2.85M/2.2M/0.125M，
 * 其中 cutout/transparent 的初始容量与本 Epic 后相同，故可直接比较）。
 */
const HEAD_BASE = {
  views: {
    '(18,27)': { cutout: 48.4, transparent: 36.8 },
    '(-20,10)': { cutout: 128.1, transparent: 100.3 },
    '(30,10)': { cutout: 70.8, transparent: 11.2 },
    '(-25,-5)': { cutout: 21.2, transparent: 49.0 },
    '(10,40)': { cutout: 30.1, transparent: 85.8 },
  },
  sprints: {
    '森林(-20,10)→西': { cutout: 129.3, transparent: 128.7 },
    '森林(-20,10)→南': { cutout: 145.4, transparent: 140.8 },
    '海岸(10,40)→东': { cutout: 57.1, transparent: 114.3 },
  },
};
/** 每个视域里巨树方块数的下界（实测的 ~1/3；防「没生成树 → 预算天然过」的恒真） */
const GIANT_FLOOR = { '(18,27)': 5000, '(-20,10)': 20000, '(30,10)': 1000, '(-25,-5)': 20000, '(10,40)': 10000 };
const OPAQUE_MAX = 90;
const TOL = 1.0;

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

async function teleport(page, x, z, y = 70) {
  await page.evaluate(([x, z, y]) => {
    const g = window.__MC_GAME__; clearInterval(window.__PIN__);
    const p = g.player.physics; p.pos.x = x; p.pos.y = y; p.pos.z = z; p.vel.x = p.vel.y = p.vel.z = 0;
    window.__PIN__ = setInterval(() => { p.pos.x = x; p.pos.z = z; p.pos.y = y; p.vel.y = 0; }, 30);
  }, [x, z, y]);
}

/** 等视域就绪 + 队列收敛 + section 数连续 2s 不变（队列归零是瞬时状态，须等 slots 停止变化） */
async function settle(page, x, z) {
  await page.waitForFunction(([x, z]) => {
    const g = window.__MC_GAME__; const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
    for (let dx = -8; dx <= 8; dx++) for (let dz = -8; dz <= 8; dz++) if (!g.world.hasColumn(cx + dx, cz + dz)) return false;
    return true;
  }, [x, z], { timeout: 180_000 });
  await page.waitForFunction(queueConverged, null, { timeout: 180_000 });
  let last = -1, stable = 0;
  for (let i = 0; i < 60 && stable < 4; i++) {
    await page.waitForTimeout(500);
    const n = await page.evaluate(() => window.__MC_GAME__.renderWorld.slotMap.size);
    if (n === last) stable++; else { stable = 0; last = n; }
  }
}

const snapshot = (page) => page.evaluate((INITc) => {
  const rw = window.__MC_GAME__.renderWorld; const r = { opaque: 0, cutout: 0, transparent: 0 };
  for (const s of rw.slotMap.values()) r[s.channel] += s.reservedV;
  return Object.fromEntries(Object.keys(r).map((k) => [k, +(r[k] / INITc[k] * 100).toFixed(1)]));
}, INIT);

const giantCount = (page) => page.evaluate(() => {
  const g = window.__MC_GAME__;
  const ids = new Set(['giant_oak_log', 'giant_mangrove_log', 'giant_oak_leaves', 'giant_birch_leaves', 'giant_spruce_leaves',
    'giant_cherry_leaves', 'giant_palm_leaves', 'giant_banyan_leaves'].map((n) => g.registry.idOf(n)));
  let n = 0;
  for (const c of g.world.columns.values()) { const b = c.blocks; for (let i = 0; i < b.length; i++) if (ids.has(b[i])) n++; }
  return n;
});

const opaqueCapacity = (page) => page.evaluate(() => window.__MC_GAME__.renderWorld._capacity.opaque.maxVertexCount);
const capacities = (page) => page.evaluate(() => {
  const c = window.__MC_GAME__.renderWorld._capacity;
  return { opaque: c.opaque.maxVertexCount, cutout: c.cutout.maxVertexCount, transparent: c.transparent.maxVertexCount };
});
const INIT_MSG = '开局初始容量 == CAPACITY 标定值（出生点在城里，此时还没发生过任何扩容；防「容量被改回 1200 → 页面扩容到恰好相同的 4.275M」的掩盖）';

test('预算门：5 个固定视域（静态）—— opaque ≤ 90% 且不扩容；cutout/transparent 不比 HEAD 更糟', async ({ page }) => {
  test.setTimeout(900_000);
  await openGame(page);
  expect(await capacities(page), INIT_MSG).toEqual(INIT);
  const report = [];
  for (const [name, [cx, cz]] of Object.entries({ '(18,27)': [18, 27], '(-20,10)': [-20, 10], '(30,10)': [30, 10], '(-25,-5)': [-25, -5], '(10,40)': [10, 40] })) {
    const x = cx * 16 + 8, z = cz * 16 + 8;
    await teleport(page, x, z); await settle(page, x, z);
    const pct = await snapshot(page); const giants = await giantCount(page);
    report.push(`${name} opaque ${pct.opaque}% cutout ${pct.cutout}% transp ${pct.transparent}% 巨树方块 ${giants}`);
    expect(giants, `${name} 视域里有足够多的巨树方块（对照，防恒真）`).toBeGreaterThanOrEqual(GIANT_FLOOR[name]);
    expect(pct.opaque, `${name} opaque`).toBeLessThanOrEqual(OPAQUE_MAX);
    expect(pct.cutout, `${name} cutout 不比 HEAD 更糟`).toBeLessThanOrEqual(HEAD_BASE.views[name].cutout + TOL);
    expect(pct.transparent, `${name} transparent 不比 HEAD 更糟`).toBeLessThanOrEqual(HEAD_BASE.views[name].transparent + TOL);
  }
  console.log('BUDGET VIEWS:\n  ' + report.join('\n  '));
  expect(await opaqueCapacity(page), 'opaque 通道未发生扩容').toBe(INIT.opaque);
});

for (const [name, [cx, cz, dx, dz]] of Object.entries({ '森林(-20,10)→西': [-20, 10, -1, 0], '森林(-20,10)→南': [-20, 10, 0, 1], '海岸(10,40)→东': [10, 40, 1, 0] })) {
  test(`预算门：冲刺 ${name}（12s、8 格/秒、250ms 采样峰值）`, async ({ page }) => {
    test.setTimeout(600_000);
    await openGame(page);
    expect(await capacities(page), INIT_MSG).toEqual(INIT);
    const sx = cx * 16 + 8, sz = cz * 16 + 8;
    await teleport(page, sx, sz); await settle(page, sx, sz);
    await page.evaluate(() => clearInterval(window.__PIN__));
    const peak = await page.evaluate(async ([sx, sz, dx, dz, INITc]) => {
      const g = window.__MC_GAME__; const y = 70; let x = sx, z = sz; const t0 = performance.now(); let last = t0;
      const peak = { opaque: 0, cutout: 0, transparent: 0 };
      const mover = setInterval(() => {
        const now = performance.now(); const dt = (now - last) / 1000; last = now; x += dx * 8 * dt; z += dz * 8 * dt;
        const p = g.player.physics; p.pos.x = x; p.pos.z = z; p.pos.y = y; p.vel.x = p.vel.y = p.vel.z = 0;
      }, 8);
      await new Promise((resolve) => {
        const t = setInterval(() => {
          const r = { opaque: 0, cutout: 0, transparent: 0 };
          for (const s of g.renderWorld.slotMap.values()) r[s.channel] += s.reservedV;
          for (const k of Object.keys(r)) peak[k] = Math.max(peak[k], r[k] / INITc[k] * 100);
          if (performance.now() - t0 > 12000) { clearInterval(t); clearInterval(mover); resolve(); }
        }, 250);
      });
      return peak;
    }, [sx, sz, dx, dz, INIT]);
    console.log(`BUDGET SPRINT ${name}: opaque ${peak.opaque.toFixed(1)}% cutout ${peak.cutout.toFixed(1)}% transp ${peak.transparent.toFixed(1)}%`);
    expect(peak.opaque, `${name} opaque 峰值`).toBeLessThanOrEqual(OPAQUE_MAX);
    expect(peak.cutout, `${name} cutout 峰值不比 HEAD 更糟`).toBeLessThanOrEqual(HEAD_BASE.sprints[name].cutout + TOL + 1);
    expect(peak.transparent, `${name} transparent 峰值不比 HEAD 更糟`).toBeLessThanOrEqual(HEAD_BASE.sprints[name].transparent + TOL + 1);
    expect(await opaqueCapacity(page), `${name} opaque 通道未发生扩容`).toBe(INIT.opaque);
  });
}
