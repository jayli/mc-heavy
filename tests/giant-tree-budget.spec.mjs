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

/** 巨树景观后的初始容量（CAPACITY：opaque 1800×1900×1.25；cutout 550×3200×1.25；transparent 240×1000×1.25）
 * ⚠️ cutout 曾因巨树叶改走 cutout 通道抬到 600（2.40M）；同日用户又裁定「**普通树叶的 opaqueTable
 *  也设为 1**」→ 全部 14 个树叶族均 opaqueTable=1（叶-叶共享面互剔）→ cutout 占用大幅下降，
 *  **已回退为 550（2.20M）**：5 视域实测峰值 35.1% → 回退后 38.3%（绝对 842,400），零扩容。
 *
 * ⚠️ **transparent 从 100 改为 240（v2.11 浅水高台，2026-11-01）**：本图视距 8 全湖视域
 * （289 列）实测透明顶点峰值 **29.6 万**，旧上限 12.5 万会触发 1 档扩容仍不够。
 * 三通道静态 193.62 MiB（(4.275M+2.20M+0.30M)×30B，仍 < `m3-fullscene` 的 200 MiB 门）。
 *
 * ⚠️ **这个常量与 `src/render/render-world.js` 的 `CAPACITY` 是一对，必须同步**：
 * v2.11 改了 `CAPACITY.transparent.active` 100→240 却漏改这里 → 本 spec 从那天起**恒红**
 * （2026-11-03 发现：干净 HEAD 同样失败，与本轮改动无关）。`check` 不跑这个 spec，
 * 所以它静默躺了六天。**改 `CAPACITY` 的任何一项都必须同步这里。**
 */
const INIT = { opaque: 1800 * 1900 * 1.25, cutout: 550 * 3200 * 1.25, transparent: 240 * 1000 * 1.25 };

/**
 * 总顶点基线（2026-10-23 第二轮：全部 14 个树叶族均为 opaqueTable=1 之后的实测值）。
 *
 * 两轮口径变更（写清楚免得后人反推错）：
 *   · 第一轮（巨树叶改 cutout 通道）：总顶点**逐位守恒**，基线用当时 A/B 实测值
 *     （3,478,025 / 4,810,025 / 3,831,985 / 3,233,170 / 3,192,705）。
 *   · 第二轮（**普通树叶也 opaqueTable=1**）：总顶点大幅下降 −18%，故基线**重标**为新的实测值。
 *     ⚠️ 基线重标不是放宽门禁 —— 新值比旧值低，任何回升都会真红。
 *     实测下降幅度：−16.4% / −29.5% / −22.9% / −3.7% / −10.9%。
 *
 * 为什么主判据用「总顶点」而不是逐通道百分比：容量基数不同（opaque 4.275M vs cutout 2.2M），
 * 同一批顶点在两通道间移动时百分比会放大 1.94 倍，逐通道判据会误报（实测曾误判 (-25,-5)「超线 6.7 点」，
 * 实际该视域总量分毫未变）。总顶点与通道归属无关，是真正的「几何量」护栏。
 *
 * 第三轮重标（v1.70，2026-10-23 用户裁决）：镂空遮挡体（树叶）不再剔除「实心方块朝它」的那一面
 * —— 修「透过叶孔看穿背后方块」的视觉穿帮。代价 = 每条「实心↔树叶」接触面 +1 个面，
 * 真实页面实测增量 **+0.78% ~ +1.59%**（与合成场景 +0~23% 同源，视树冠密度而定）。
 * 交替对照（BASE/MOD 各 2 轮，同会话）实测：BASE 复测与冻结值相差 **0.008%**（测法可信），
 * MOD 两轮读数**逐位相同** → 增量是真实的，不是加载时序噪声。
 * ⚠️ **这次重标是「放宽」（新值比旧值高），与第二轮（收紧）性质相反** —— 已记入
 * `docs/phase-1-engine-design.md` v1.70 修订说明与 roadmap v1.70 条目。
 * 为什么不能只调容差：1% 容差对 2 个视域不够（(-20,10) +1.59% / (-25,-5) +1.35%），
 * 而要卡住它们得放到 2% —— 那会让门禁对「后续真实回退」的敏感度直接降一半。
 * ⚠️ **通道侧判据一字未动**：opaque ≤ 90% 且零扩容、cutout ≤ 100%、transparent 不比 HEAD 糟
 * —— 本次实测 opaque 峰值 73.4%、cutout 峰值 43.9%、transparent 与 HEAD 逐位相同。
 *
 * ⚠️ **v2.7（2026-10-29）竞技场**：视域 `(18,27)` 的中心 (296,440) **正好落在南门外竞技场的
 * 占地内**（AABB x[260,300] z[424,502]），其 transparent 36.8% → **38.3%**（竞技场自带的水
 * 池玻璃 + 水体）→ 该视域基线**重标为实测值**（不放大 `TOL`：放宽容差会把门禁对后续
 * 真实回退的敏感度直接降一半）。其余 4 个视域实测逐位未变。
 * 该视域总顶点反而**降到 2,889,650**（基线 2,930,915）—— 竞技场把原地形换成了整体更省面的结构。
 */
const HEAD_BASE = {
  views: {
    // ⚠️ **transparent 36.8 → 38.3（v2.7 竞技场，2026-10-29）**：该视域中心 (296,440)
    // **正好落在南门外竞技场的占地内**（AABB x[260,300] z[424,502]）—— 竞技场自带的
    // 水池玻璃面（`glass_block` 115 格）+ 水体必然抬高该视域的 transparent 占用。
    // 这是「预期代价」→ 按既定口径**重标基线实测值**，不放大 `TOL` 容差
    // （放宽容差会把门禁对后续真实回退的敏感度直接降一半）。其余 4 个视域实测未变。
    //
    // ⚠️ **(-25,-5) 重标（v2.89 废弃堡垒，2026-11-10，用户裁定）**：该视域中心 (-392,-72)
    // 距堡垒 footprint（x∈[-522,-416] z∈[-125,-17]，锚点 (-469,-71)）仅 24 格 ⇒ **堡垒 100%
    // 落在 vd=8 渲染窗内**（261,683 格非空气）。同 (18,27) 遇 v2.7 竞技场的口径：重标实测值，
    // **`TOL_PCT` 保持 1% 不动**（放宽容差会永久降低门禁对后续真实回退的敏感度）。
    //
    // 方向与归因（同会话 A/B：禁/启 apply.js 阶段 2.94 光栅化，其余不变；
    // 4 个非堡垒视域两侧**逐位相同** ⇒ 零噪声，增量全部来自堡垒）：
    //   · 真 HEAD（无堡垒）      total 3,154,815 / transparent 49.0 / 巨树 8,846
    //   · BASE（压制 ON、光栅化 OFF）total 2,769,790 / transparent 20.4 / 巨树 7,881
    //   · MOD（两者 ON）         total **3,203,080**（3 轮逐位相同）/ transparent **20.5** / 巨树 7,881
    //   ⇒ total **放宽 +48,265（+1.53%）**：压制移除 965 巨树格（−385,025 顶点），
    //     光栅化加回堡垒结构（+433,290 顶点）。
    //   ⇒ transparent **收紧 49.0 → 20.5**：堡垒压制了 region(-2,-1) 的 `plainLand`（平地地标，
    //     自带水体/玻璃 = 该视域 transparent 的主要来源），换成 opaque 的堡垒结构体。
    //     这是 DR-6 压制的预期结果（Tier 1「压制：占地内地标被压掉」已钉住），不是回退。
    '(18,27)': { total: 2_930_915, transparent: 38.3 },
    '(-20,10)': { total: 3_445_740, transparent: 100.3 },
    '(30,10)': { total: 2_977_480, transparent: 11.2 },
    '(-25,-5)': { total: 3_203_080, transparent: 20.5 },
    '(10,40)': { total: 2_871_955, transparent: 85.8 },
  },
  sprints: {
    '森林(-20,10)→西': { cutout: 129.3, transparent: 128.7 },
    '森林(-20,10)→南': { cutout: 145.4, transparent: 140.8 },
    '海岸(10,40)→东': { cutout: 57.1, transparent: 114.3 },
  },
};
/**
 * 巨树方块的**总量**下界（防「没生成树 → 预算天然过」的恒真）。
 *
 * ⚠️ 口径从「每个视域各自下界」改成「5 个视域合计下界」（2026-10-24 区域门控）。
 * 原因：`patchChance` 让 beach/banyan 只有 1/3 / 1/2 的粗格长树，于是某些视域会**合理地一棵巨树都没有**
 * —— 实测 seed 12345：(18,27) 与 (30,10) 的巨树方块从 7235 / 1741 直接变成 **0**（落在被跳过的粗格里）。
 * 那不是缺陷，正是用户要的「不是每个海滩旁都有」。若还按视域各自下界，要么恒不成立（用旧值），
 * 要么必须写 0（等于没有对照）—— 两者都错。改成合计口径后仍能抓住「树根本没生成」这种真回归。
 * 实测（seed 12345）：(18,27) 0 / (-20,10) 23,089 / (30,10) 0 / (-25,-5) 8,846 / (10,40) 4,910
 * → 合计 **36,845**，下界取 ~2/3 = 20,000。
 */
const GIANT_TOTAL_FLOOR = 20000;
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
  let giantTotal = 0;
  for (const [name, [cx, cz]] of Object.entries({ '(18,27)': [18, 27], '(-20,10)': [-20, 10], '(30,10)': [30, 10], '(-25,-5)': [-25, -5], '(10,40)': [10, 40] })) {
    const x = cx * 16 + 8, z = cz * 16 + 8;
    await teleport(page, x, z); await settle(page, x, z);
    const pct = await snapshot(page); const giants = await giantCount(page); const total = await totalVerts(page);
    giantTotal += giants;
    report.push(`${name} opaque ${pct.opaque}% cutout ${pct.cutout}% transp ${pct.transparent}% 总顶点 ${total.toLocaleString()} 巨树方块 ${giants}`);
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
  // 对照（防恒真）：单视域已不再要求有树（`patchChance` 会让某些视域合理地零巨树），
  // 改成 5 个视域**合计**必须够多 —— 「树根本没生成」这种真回归仍会被抓到。
  expect(giantTotal, '5 个视域的巨树方块合计下界（对照，防「没生成树 → 预算天然过」的恒真）')
    .toBeGreaterThanOrEqual(GIANT_TOTAL_FLOOR);
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
