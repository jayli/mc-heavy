import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

// 大竞技场（burning arena，v2.85）Tier 4 像素验收。
//
// 术语（用户 2026-11-09 裁定）：**大竞技场 / 「竞技场」** = 本结构（Cataclysm burning_arena，85×85×80，城东沙漠）；
//       **围场 / 原「小竞技场」** = 既有城门竞技场（城南门外）。
//
// 验三件浏览器单测（test-burning-arena-gen.js）验不到的事：
//   ① 真实 Worker 池 GEN 路径（不是本地 applyStructuresToColumn）真的写出了大竞技场；
//   ② 锚点经 Worker 'layout' RPC（结构化克隆）往返后仍在，且落点就是城东沙漠那一处；
//   ③ **画面**上确实是一座暗红下界砖碗形建筑（数据层对、网格层旧 → 两者会分裂，
//      AGENTS.md「光照类缺陷的断言必须落在画面上」同理）。
//
// ⚠️ 像素断言**同时钉上下界**（只钉「够暗」抓不到「纯黑」，只钉「非黑」抓不到「过曝」）。

const READY = () => window.__MC_GAME__?.worldReady === true;

/** 等世界稳定：sections 连续两次采样不变 + 三条队列归零（勿只看队列瞬时归零） */
const STABLE = () => {
  const g = window.__MC_GAME__;
  const s = g.scheduler.stats();
  const sections = g.renderStats().sections;
  const prev = window.__MC_STABLE_PREV__;
  window.__MC_STABLE_PREV__ = sections;
  return prev === sections && s.inflight === 0 && s.meshInflight === 0 && s.uploadQueue === 0;
};

/** 截图统计：全帧均值 + **非天空像素**的均值/红蓝差。
 *
 * ⚠️ 亮度与红蓝差只对**非天空像素**统计：skybox=0 时天空是纯天蓝 0x87ceeb（亮度≈192、
 * 蓝通道 235），俯瞰视角天空占比大 —— 若把天空算进均值，「过曝上界」会被天空亮度顶破
 * （实测 meanLum 203 而阈值 200，但那是天空不是过曝），「红−蓝」也会被天空的蓝拉低。
 * 断言的本意是检测**场景内容**过曝/主色，故排除天空。 */
function stats(pngBuffer) {
  const png = PNG.sync.read(pngBuffer);
  const n = png.width * png.height;
  let sr = 0, sg = 0, sb = 0, s2 = 0, nonSky = 0;
  let nsR = 0, nsG = 0, nsB = 0, nsS2 = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const r = png.data[o], g = png.data[o + 1], b = png.data[o + 2];
    sr += r; sg += g; sb += b;
    const lum = (r + g + b) / 3;
    s2 += lum * lum;
    // 天空蓝 0x87ceeb=(135,206,235)，容差 30（与 city-visual.spec 同口径）
    if (Math.abs(r - 135) > 30 || Math.abs(g - 206) > 30 || Math.abs(b - 235) > 30) {
      nonSky++;
      nsR += r; nsG += g; nsB += b; nsS2 += lum * lum;
    }
  }
  const meanLum = (sr + sg + sb) / (3 * n);
  const nsMeanLum = nonSky > 0 ? (nsR + nsG + nsB) / (3 * nonSky) : 0;
  return {
    width: png.width, height: png.height,
    meanLum,
    stdLum: Math.sqrt(Math.max(0, s2 / n - meanLum * meanLum)),
    nonSkyRatio: nonSky / n,
    nsMeanLum,
    nsStdLum: nonSky > 0 ? Math.sqrt(Math.max(0, nsS2 / nonSky - nsMeanLum * nsMeanLum)) : 0,
    nsMeanR: nonSky > 0 ? nsR / nonSky : 0,
    nsMeanB: nonSky > 0 ? nsB / nonSky : 0,
  };
}

/** 把玩家放到 (x,y,z) 并设定朝向，等**玩家所在** column 邻域就绪 + 世界稳定 */
async function gotoAndView(page, pos, yaw, pitch) {
  await page.evaluate(({ pos, yaw, pitch }) => {
    const g = window.__MC_GAME__;
    g.player.physics.pos.x = pos.x;
    g.player.physics.pos.y = pos.y;
    g.player.physics.pos.z = pos.z;
    g.player.physics.vel.x = g.player.physics.vel.y = g.player.physics.vel.z = 0;
    g.player.yaw = yaw;
    g.player.pitch = pitch;
  }, { pos, yaw, pitch });
  // ⚠️ 等的是**玩家所在** column 邻域（±3），不是锚点邻域：玩家可能站在碗外 55 格，
  // 而 vd=8 只加载玩家周围的 column —— 等锚点邻域会恒超时（实测踩到）。
  await page.waitForFunction((p) => {
    const g = window.__MC_GAME__;
    const ccx = Math.floor(p.x / 16), ccz = Math.floor(p.z / 16);
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
      if (!g.world.hasColumn(ccx + dx, ccz + dz)) return false;
    }
    return true;
  }, pos, { timeout: 180_000 });
  await page.waitForFunction(STABLE, null, { timeout: 120_000, polling: 500 });
  await page.waitForTimeout(1200);
}

test('大竞技场：城东沙漠里生成了碗形建筑（真实 Worker GEN + 世界方块 + 画面）', async ({ page }) => {
  test.setTimeout(500_000);
  // ⚠️ `skybox=0`：本 spec 用「像素落在 0x87ceeb ±30 内 = 天空」数非天空占比，
  // 天空盒上线后天空是照片 → 天空像素被误判成地形，判据失效（city-visual.spec 同口径）。
  await page.goto('/?vd=8&seed=12345&skybox=0');
  await page.waitForFunction(READY, null, { timeout: 120_000 });
  await page.waitForFunction(STABLE, null, { timeout: 90_000, polling: 500 });

  // ──  锚点（经 Worker RPC 往返后的 layout 必须与纯函数同源）──
  const anchor = await page.evaluate(async () => {
    const m = await import('/src/gen/structures/burning-arena.js');
    const seed = window.__MC_GAME__.seed;
    const a = m.computeBurningArenaAnchor(seed);
    if (!a) return null;
    // layout 侧：锚点所在 region 必须携带它（`burningArenaOverlapsRegion` 裁剪）
    const { computeRegionLayout } = await import('/src/gen/structures/structure-layout.js');
    const { REGION_SIZE } = await import('/src/gen/structures/region-config.js');
    const rx = Math.floor(a.wx / REGION_SIZE), rz = Math.floor(a.wz / REGION_SIZE);
    const lay = computeRegionLayout(rx, rz, seed);
    return {
      wx: a.wx, wz: a.wz, floorY: a.floorY, span: a.span,
      layoutCarries: !!lay.burningArena,
      layoutWx: lay.burningArena?.wx ?? null,
      layoutWz: lay.burningArena?.wz ?? null,
    };
  });
  expect(anchor, '前提：seed 12345 必须有大竞技场锚点（用户裁定「必须且唯一」）').not.toBeNull();
  expect(anchor.layoutCarries, '锚点所在 region 的 layout 必须携带它（否则 GEN 永不光栅化）').toBe(true);
  expect(anchor.layoutWx, 'layout 携带的锚点与纯函数同源（红线 1：不另写一份落点）').toBe(anchor.wx);
  expect(anchor.layoutWz).toBe(anchor.wz);

  // ── ② 飞到碗内并等 column 就绪，**再**读真实世界方块 ──
  // ⚠️ 时序是载荷性的：不先飞过去就读，锚点 column 还没加载 → `getBlockId` 恒返回 0（air）。
  // 实测踩到过这个坑（结构其实完全正确，断言却报 air）。
  const center = { cx: anchor.wx, cz: anchor.wz };
  await gotoAndView(page, { x: anchor.wx, y: anchor.floorY + 40, z: anchor.wz }, 0, -Math.PI / 2);

  const blocks = await page.evaluate(async (a) => {
    const g = window.__MC_GAME__;
    const reg = g.registry;
    // ⚠️ **必须 `await loadStructure` 再读 floorRow**：`floorRowOf` 读的是**本线程的
    // 模块级缓存**，而结构只在 GEN Worker 里被加载 —— 主线程缓存恒空，不先 load 会拿到
    // 兜底值 1（实测踩到）。真实世界方块的断言不受此影响（那些读 `g.world`）。
    const { loadStructure } = await import('/src/gen/structures/structure-json.js');
    const data = await loadStructure('burningArena');
    const name = (dx, dy, dz) => reg.nameOf(g.world.getBlockId(a.wx + dx, a.floorY + dy, a.wz + dz));
    const counts = {};
    for (let dx = -42; dx <= 42; dx++) {
      for (let dz = -42; dz <= 42; dz++) {
        const n = name(dx, 0, dz);
        if (n) counts[n] = (counts[n] || 0) + 1;
      }
    }
    return {
      floorRow: data.floorRow,
      center: name(0, 0, 0),
      offset5: name(5, 0, 0),
      offset5up: name(5, 1, 0),
      counts,
    };
  }, anchor);

  expect(blocks.floorRow, '产物 floorRow 经 Worker 加载后仍是 10').toBe(10);
  // ⚠️ **中心列不是可站地板**：素材中心是 y=10..40 的熔岩柱（地板层那格映射为 netherrack，
  // y=11..40 仍是 solid lava），顶上 y=41..45 是 chest/obsidian/gold_block/glowstone 小塔。
  // ⇒ 「中心上方是空气」的断言恒红，可站性必须用偏移点验（实测 (5,0) 是 polished_deepslate）。
  expect(blocks.center, '圆心地板格 = netherrack（地板层熔岩已映射，可走）').toBe('netherrack');
  expect(blocks.offset5, '偏移点 (wx+5,wz) 地板格').toBe('polished_deepslate');
  expect(blocks.offset5up, '偏移点上方是空气（碗内可站）').toBe('air');
  expect(blocks.counts.nether_bricks || 0, '地板层下界砖 >1000（防「静默空结构」恒真）').toBeGreaterThan(1000);
  expect(blocks.counts.lava || 0, '地板层不得有 lava（本仓 lava 是 solid，碗内那部分地面会走不过去）').toBe(0);

  // ── ③ 画面 A：碗外斜看全景（碗形轮廓 + 暗红下界砖主体）──
  // 机位口径沿用祭坛地带版的实测结论（碗口世界 y = floorY - (floorRow-1) + 79）：
  //   · y = 碗口上方 4 格 —— 再高会拍进云/天空，把暗红主色冲掉；
  //   · 半径 55（碗半径 42.5 外 12.5 格）、pitch=-0.55 斜看碗内。
  const rimY = anchor.floorY - (blocks.floorRow - 1) + 79;
  const viewA = { x: anchor.wx + 55, y: rimY + 4, z: anchor.wz };
  await gotoAndView(page, viewA, Math.PI / 2, -0.55);
  const shotA = await page.screenshot();
  const sA = stats(shotA);
  console.log('ARENA VIEW A (碗外斜看):', JSON.stringify(sA));

  // ── ④ 画面 B：碗内地板层平视（可站 + 碗壁）──
  const viewB = { x: anchor.wx + 20, y: anchor.floorY + 2, z: anchor.wz };
  await gotoAndView(page, viewB, Math.PI / 2, 0);
  const shotB = await page.screenshot();
  const sB = stats(shotB);
  console.log('ARENA VIEW B (碗内):', JSON.stringify(sB));

  // ── ⑤ 噪声底：同状态重复截图（AGENTS.md：定阈值前先测噪声底）──
  const shotB2 = await page.screenshot();
  const sB2 = stats(shotB2);
  console.log('ARENA VIEW B repeat:', JSON.stringify(sB2));
  console.log('NOISE FLOOR nsMeanLum diff:', Math.abs(sB.nsMeanLum - sB2.nsMeanLum).toFixed(3));

  // ── ⑥ 像素断言（上下界双钉；亮度/红蓝差用非天空像素，理由见 stats 头）──
  // 阈值按**城东沙漠落点的实测值**定（2026-11-09，噪声底 0.000 完全确定）：
  //   A（碗外斜看）：nsMeanLum 118.2 / nsStdLum 62.6 / nsR−B 10.1 / nonSky 0.999
  //   B（碗内平视）：nsMeanLum 64.1  / nsStdLum 56.1 / nsR−B 12.9 / nonSky 0.999
  // 下界取实测值的 ~1/3（留足余量防负载波动），上界取 240（过曝白屏判据）。
  // A：碗外斜看必须看到大量非天空（碗体占据视野），且不是纯黑/过曝
  expect(sA.nonSkyRatio, '碗外非天空占比下界（碗体占据视野）').toBeGreaterThan(0.30);
  expect(sA.nsMeanLum, '碗外场景亮度下界（不得纯黑 = 网格没上传/光照全 0）').toBeGreaterThan(20);
  expect(sA.nsMeanLum, '碗外场景亮度上界（不得过曝白屏）').toBeLessThan(240);
  expect(sA.nsStdLum, '碗外场景对比度下界（不得全同色 = 空结构/纯色屏）').toBeGreaterThan(15);
  // 下界砖主体是暗红：红通道显著高于蓝通道
  expect(sA.nsMeanR - sA.nsMeanB, '碗外红−蓝下界（下界砖暗红主色）').toBeGreaterThan(2);

  // B：碗内平视同样不得纯黑/过曝，且要有结构对比
  expect(sB.nonSkyRatio, '碗内非天空占比下界（碗壁占据视野）').toBeGreaterThan(0.30);
  expect(sB.nsMeanLum, '碗内场景亮度下界（不得纯黑）').toBeGreaterThan(15);
  expect(sB.nsMeanLum, '碗内场景亮度上界（不得过曝）').toBeLessThan(240);
  expect(sB.nsStdLum, '碗内场景对比度下界（不得全同色）').toBeGreaterThan(15);
  expect(sB.nsMeanR - sB.nsMeanB, '碗内红−蓝下界（下界砖暗红主色）').toBeGreaterThan(3);
});
