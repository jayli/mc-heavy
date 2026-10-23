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

/** 巨树景观后的初始容量（CAPACITY：opaque 1800×1900×1.25；cutout **600**×3200×1.25；transparent 100×1000×1.25）
 *  ⚠️ cutout 550→600（2026-10-23）：巨树叶由 opaque 改走 cutout 通道（拿 alphaTest 镂空）。
 *  总顶点逐位守恒（纯通道搬运），但两通道容量基数不同（opaque 4.275M vs cutout 2.2M）→
 *  百分比被放大 1.94 倍：(-20,10) 的 cutout 从 91.2% 变 100.9%（2,220,795 > 2,200,000）会扩容一次；
 *  抬到 2.40M 后该视域 92.5%，零扩容。三通道合计 194.55 MiB < m3-fullscene 的 200 MiB 上限。 */
const INIT = { opaque: 1800 * 1900 * 1.25, cutout: 600 * 3200 * 1.25, transparent: 100 * 1000 * 1.25 };

/**
 * HEAD 基线（2026-10-23，seed 12345 / vd 8，HEAD=218f836 实测；相对 **HEAD 的初始容量** 2.85M/2.2M/0.125M）。
 *
 * ⚠️ 巨树叶改走 cutout 通道后（2026-10-23），**逐通道百分比判据的前提失效**：
 *   原判据「cutout 不比 HEAD 更糟」隐含「树叶走 cutout 通道」—— HEAD 的 cutout 占用里有很大一部分
 *   就是旧森林树叶。巨树替掉旧树后那部分消失，叶子改道后又搬回来一部分——
 *   拿「新结构的 cutout」比「旧结构的 cutout」在比两个不同的东西。实测：(-25,-5) 视域
 *   HEAD cutout 466,400 顶点、巨树替换后（叶仍 opaque）只剩 311,875、叶子改道后 636,840 ——
 *   **任意两者相减都得不出「回归」**，因为总量在改动前后**逐位守恒**（主判据 `total` 即是这个不变式）。
 *
 * 故新增主判据 **总顶点**（三通道 absolute 顶点之和 ≤ HEAD 同视域总顶点），它**与通道归属无关**，
 * 正是本次改动的不变式（A/B 实测 5 视域逐位相同：3,478,025 / 4,810,025 / 3,831,985 / 3,233,170 / 3,192,705）。
 * 逐通道百分比降为：cutout ≤ 100%（不扩容）+ transparent 不比 HEAD 更糟（水未动）+ opaque ≤ 90%。
 */
const HEAD_BASE = {
  views: {
    '(18,27)': { total: 3_478_025, transparent: 36.8 },
    '(-20,10)': { total: 4_810_025, transparent: 100.3 },
    '(30,10)': { total: 3_831_985, transparent: 11.2 },
    '(-25,-5)': { total: 3_233_170, transparent: 49.0 },
    '(10,40)': { total: 3_192_705, transparent: 85.8 },
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
/** 总顶点容差（比例）：实测 A/B 逐位相同，1% 容差足以吸收采样噪声又远小于任何真实回归 */
const TOL_PCT = 0.01;

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

/** 三通道绝对顶点之和（与通道归属无关 —— 本次改动的不变式） */
const totalVerts = (page) => page.evaluate(() => {
  const rw = window.__MC_GAME__.renderWorld;
  let n = 0; for (const s of rw.slotMap.values()) n += s.reservedV;
  return n;
});

test('预算门：5 个固定视域（静态）—— 总顶点不比 HEAD 更糟（主判据）+ opaque ≤ 90% 且不扩容', async ({ page }) => {
  test.setTimeout(900_000);
  await openGame(page);
  expect(await capacities(page), INIT_MSG).toEqual(INIT);
  const report = [];
  for (const [name, [cx, cz]] of Object.entries({ '(18,27)': [18, 27], '(-20,10)': [-20, 10], '(30,10)': [30, 10], '(-25,-5)': [-25, -5], '(10,40)': [10, 40] })) {
    const x = cx * 16 + 8, z = cz * 16 + 8;
    await teleport(page, x, z); await settle(page, x, z);
    const pct = await snapshot(page); const giants = await giantCount(page); const total = await totalVerts(page);
    report.push(`${name} opaque ${pct.opaque}% cutout ${pct.cutout}% transp ${pct.transparent}% 总顶点 ${total.toLocaleString()} 巨树方块 ${giants}`);
    expect(giants, `${name} 视域里有足够多的巨树方块（对照，防恒真）`).toBeGreaterThanOrEqual(GIANT_FLOOR[name]);
    // 【主判据】总顶点 ≤ HEAD 同视域总顶点（+1% 容差）。与通道归属无关，是本次改动的核心不变式。
    expect(total, `${name} 总顶点不比 HEAD 更糟`).toBeLessThanOrEqual(HEAD_BASE.views[name].total * (1 + TOL_PCT));
    expect(pct.opaque, `${name} opaque`).toBeLessThanOrEqual(OPAQUE_MAX);
    // 【辅判据 ①】cutout 不得超出自身容量（= 不得扩容，内存硬顶）。
    // 为什么不比 HEAD 的 cutout：HEAD 的 cutout 里**不含**巨树叶（那时巨树还不存在），
    // 而现在的 cutout = 原 cutout + 全部巨树叶 —— 两者结构不同，相减无意义（本就必超）。
    expect(pct.cutout, `${name} cutout 不得超出容量（不得扩容）`).toBeLessThanOrEqual(100);
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
