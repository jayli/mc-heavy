// RedCity 预算门禁（Tier 4，真实页面）—— spec §13.7.7 的三条验收，在 U1′ 容量下必须零扩容。
//
// 为什么必须是真实页面：顶点预算由「真实 GEN → 光照 → mesher → BatchedMesh 预留（reservedV = ceil(vertexCount×1.25)）」
// 共同决定，Node 侧复现过三次都与真实页面不符（原型估算偏低 15~20%）。口径：
//   - 稳态 = 出生点、vd=8、289 列队列收敛后的 Σ slot.reservedV / 通道 maxVertexCount
//   - 冲刺 = 无碰撞飞越（悬停 y=70、以 8 格/秒直线推进 12s）的逐 100ms 采样峰值
//     （真实 W 键奔跑会被塔/树挡住：实测 +x/-x 方向 4 格就停了，峰值 = 稳态，测不到任何东西）
//   - 扩容 = `_capacity[ch].maxVertexCount` 与启动时不同（_ensureCapacity 的 ×1.5 跳增）
//
// 阈值口径：稳态与冲刺峰值都 ≤ 95%（= 零扩容的 100% 硬线 + 5% 标定余量。「容量须留足余量」是既有活跃约束：
// 贴着 100% 的容量一旦有任何新增几何就会跳增 ×1.5，撞破 GPU 预算）。95% 不是调出来的——它是标定规则
// 「最坏实测峰值 ≤ 95%」的直接判据。
//
// ⚠️ 先 setShadowsEnabled(false)：阴影刷新帧的 drawCalls 尖峰与顶点预算无关，但同窗口内会干扰采样节奏。
import { test, expect } from 'playwright/test';

/**
 * U1′ 容量（render-world.js CAPACITY）下的 GPU 顶点缓冲冻结预算 = (opaque 4,275,000 + cutout 2,200,000 + transparent 360,000) × 30 B
 * = 195.55 MiB（设计文档 §4.10）。这是「冻结预算」在测试侧的显式镜像——改 CAPACITY 必须同步改这里与设计文档，
 * 不从 `_capacity` 派生（派生出来的上限永远等于实测，断言恒真）。
 */
const GPU_BUDGET_MIB = (4_275_000 + 2_200_000 + 360_000) * 30 / 1048576;
/** 门限：零扩容的 100% 硬线 − 5% 标定余量 */
const LIMIT_PCT = 95;
/**
 * 无碰撞飞越路线（RedCity core 局部坐标 + 单位方向），按 seed 分组。
 * 〔实测 U1′ 容量〕 seed=12345 的 R5/R6 是 opaque / cutout 的最坏路线（92.3% / 92.6%）；
 * seed=777 的 R3 是 transparent 的最坏路线（299,135 = 旧 300K 容量的 99.7% → 这是把 transparent 标到 360K 的依据）。
 * 不同 seed 的差异来自 RedCity 周围的自然水域 / 森林（opaque 在各 seed 间几乎恒定 3.91~3.95M，因为它由 RedCity 本体决定）。
 */
const CASES = [
  { seed: 12345, routes: [
    { label: 'R5 西北角→对角', ox: 40, oz: 50, dx: 0.707, dz: 0.707 },
    { label: 'R6 东南角→西', ox: 210, oz: 250, dx: -1, dz: 0 },
  ] },
  { seed: 777, routes: [{ label: 'R3 东缘中点→西', ox: 210, oz: 144, dx: -1, dz: 0 }] },
];

const settle = (page) => page.waitForFunction(() => {
  const g = window.__MC_GAME__;
  const s = g.scheduler.stats();
  return s.inflight === 0 && s.meshInflight === 0 && s.uploadQueue === 0 && s.lightInflight === 0 && g.world.columns.size >= 289;
}, null, { timeout: 180_000 });

/** 三通道 Σreserved 与当前容量 */
const sample = (page) => page.evaluate(() => {
  const g = window.__MC_GAME__;
  const used = { opaque: 0, cutout: 0, transparent: 0 };
  for (const sl of g.renderWorld.slotMap.values()) used[sl.channel] += sl.reservedV;
  const cap = Object.fromEntries(Object.entries(g.renderWorld._capacity).map(([k, v]) => [k, v.maxVertexCount]));
  return { used, cap };
});

const pct = (used, cap) => Object.fromEntries(Object.keys(used).map((k) => [k, +(used[k] / cap[k] * 100).toFixed(1)]));

async function boot(page, seed = 12345) {
  await page.goto(`/?vd=8&seed=${seed}&style=noon&weather=clear`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 120_000 });
  await settle(page);
  await page.evaluate(() => window.__MC_GAME__.setShadowsEnabled(false));
  await page.waitForTimeout(4000);   // 阴影关闭后的残余刷新 / 上传收敛
  await settle(page);
}

test(`稳态：出生点 vd=8 三通道 reservedV 占 maxVerts ≤ ${LIMIT_PCT}%`, async ({ page }) => {
  test.setTimeout(240_000);
  await boot(page);
  const { used, cap } = await sample(page);
  const p = pct(used, cap);
  console.log('REDCITY BUDGET steady:', JSON.stringify({ used, cap, pct: p }));
  // 〔实测 U1′〕opaque 78.2% / cutout 25.2% / transparent 70.1%
  for (const ch of ['opaque', 'cutout', 'transparent']) {
    expect(p[ch], `${ch} 稳态占比`).toBeLessThanOrEqual(LIMIT_PCT);
    expect(p[ch], `${ch} 占比不应为 0（防止采样口径失效而恒真）`).toBeGreaterThan(5);
  }
});

for (const c of CASES) {
  test(`12s 无碰撞飞越 seed=${c.seed}（${c.routes.map((r) => r.label).join(' / ')}）：峰值 ≤ ${LIMIT_PCT}% 且零扩容`, async ({ page }) => {
    test.setTimeout(300_000);
    await boot(page, c.seed);
    const core = await page.evaluate(() => window.__MC_GAME__.scheduler.structureIndex.redCity().core);
    const cap0 = (await sample(page)).cap;
    const peak = { opaque: 0, cutout: 0, transparent: 0 };
    let capChanged = false;
    for (const r of c.routes) {
      const sx = core.minX + r.ox + 0.5, sz = core.minZ + r.oz + 0.5;
      // 悬停起点等稳态（不用 pushModal 冻物理：它阻断玩家更新、相机不跟随）
      await page.evaluate(([sx, sz]) => {
        const g = window.__MC_GAME__; clearInterval(g._fly); clearInterval(g._hover);
        g.player.spawn(sx, 70, sz); g._hover = setInterval(() => g.player.spawn(sx, 70, sz), 50);
      }, [sx, sz]);
      await page.waitForFunction(([cx, cz]) => window.__MC_GAME__.world.hasColumn(cx, cz), [Math.floor(sx / 16), Math.floor(sz / 16)], { timeout: 60_000 });
      await settle(page);
      await page.waitForTimeout(3000);
      await settle(page);
      await page.evaluate(([sx, sz, dx, dz]) => {
        const g = window.__MC_GAME__; clearInterval(g._hover);
        let x = sx, z = sz;
        g._fly = setInterval(() => { x += dx * 0.128; z += dz * 0.128; g.player.spawn(x, 70, z); }, 16);   // 8 格/秒
      }, [sx, sz, r.dx, r.dz]);
      const t0 = Date.now();
      while (Date.now() - t0 < 12_000) {
        const s = await sample(page);
        for (const k of Object.keys(peak)) peak[k] = Math.max(peak[k], s.used[k]);
        if (JSON.stringify(s.cap) !== JSON.stringify(cap0)) capChanged = true;
        await page.waitForTimeout(100);
      }
      await page.evaluate(() => { clearInterval(window.__MC_GAME__._fly); });
    }
    const p = pct(peak, cap0);
    console.log(`REDCITY BUDGET sprint peak seed=${c.seed}:`, JSON.stringify({ peak, cap: cap0, pct: p, capChanged }));
    for (const ch of ['opaque', 'cutout', 'transparent']) expect(p[ch], `${ch} 冲刺峰值占比`).toBeLessThanOrEqual(LIMIT_PCT);
    expect(capChanged, '任何通道容量变化 = 触发了 _ensureCapacity 的 ×1.5 扩容（撞破 GPU 预算）').toBe(false);
  });
}

test(`GPU 顶点缓冲 ≤ ${GPU_BUDGET_MIB.toFixed(2)} MiB，且与三通道容量之和一致`, async ({ page }) => {
  test.setTimeout(240_000);
  await boot(page);
  const r = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const caps = Object.values(g.renderWorld._capacity).map((v) => v.maxVertexCount);
    return { gpuMiB: g.memoryStats().gpuVertexBytes / 1048576, capSumMiB: caps.reduce((a, b) => a + b, 0) * 30 / 1048576 };
  });
  console.log('REDCITY BUDGET gpu:', JSON.stringify(r));
  expect(r.gpuMiB).toBeLessThanOrEqual(GPU_BUDGET_MIB);
  // 30 B/顶点（position 12 + uv 8 + packed 4 + 对齐…，render-world.js 的口径）：预分配即占满，故实测应与容量之和相等
  expect(Math.abs(r.gpuMiB - r.capSumMiB)).toBeLessThan(0.01);
});
