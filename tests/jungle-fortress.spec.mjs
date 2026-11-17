import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

// 丛林要塞（jungle fortress，v3.13）Tier 4 像素 + 真实 Worker GEN 验收。
//
// 验浏览器单测（test-jungle-fortress-gen.js）验不到的事：
//   ① 真实 Worker 池 GEN 路径（不是本地 applyStructuresToColumn）真的写出了要塞；
//   ② 锚点经 Worker 'layout' RPC 往返后仍在，且落点就是**城西第一个丛林地带**；
//   ③ **画面**上确实是石砖族建筑（数据层对、网格层旧会分裂）；
//   ④ 从**真实按钮**进入（M7 教训：只测 Game API 会漏掉「面板根本没接线」）；
//   ⑤ 整形区内**零假水面**（遇湿即止的观感兑现）。
//
// ⚠️ 像素断言**同时钉上下界**，且带**对照组**校准（AGENTS.md 既有约束）。

const READY = () => window.__MC_GAME__?.worldReady === true;

/** 等世界稳定：sections 连续两次采样不变 + 三条队列归零 */
const STABLE = () => {
  const g = window.__MC_GAME__;
  const s = g.scheduler.stats();
  const sections = g.renderStats().sections;
  const prev = window.__MC_STABLE_PREV__;
  window.__MC_STABLE_PREV__ = sections;
  return prev === sections && s.inflight === 0 && s.meshInflight === 0 && s.uploadQueue === 0;
};

/**
 * 石砖族像素判据：本结构主材是 mossy_stone(104,110,93) / cobblestone(125,125,125) /
 * stone_bricks(122,122,122) / tuff_bricks(99,103,95)，四者都是**低饱和灰绿**。
 *
 * ⚠️ 判据必须排除天空与植被：
 *   · 天空蓝 0x87ceeb=(135,206,235)（skybox=0），容差 30；
 *   · 树叶/草是高饱和绿（g 明显大于 r 与 b），用 `g - max(r,b) > 25` 排除。
 * 剩下的「灰石」像素占比就是要塞的观感信号。
 */
function stoneStats(pngBuffer) {
  const png = PNG.sync.read(pngBuffer);
  const n = png.width * png.height;
  let sky = 0, green = 0, stone = 0, water = 0;
  let lumSum = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const r = png.data[o], g = png.data[o + 1], b = png.data[o + 2];
    const lum = (r + g + b) / 3;
    lumSum += lum;
    if (Math.abs(r - 135) <= 30 && Math.abs(g - 206) <= 30 && Math.abs(b - 235) <= 30) { sky++; continue; }
    // 水体判据（AGENTS.md 标定）：b>r+25 && g>r+12 && lum∈[95,150]
    if (b > r + 25 && g > r + 12 && lum >= 95 && lum <= 150) { water++; continue; }
    if (g - Math.max(r, b) > 25) { green++; continue; }
    // 灰石：低饱和（三通道极差 ≤ 30）且亮度在石砖族区间
    if (Math.max(r, g, b) - Math.min(r, g, b) <= 30 && lum >= 55 && lum <= 175) stone++;
  }
  return {
    total: n, sky, green, water, stone,
    stoneFrac: stone / n, waterFrac: water / n,
    meanLum: lumSum / n,
  };
}

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
  // ⚠️ 等**玩家所在** column 邻域（±3），不是锚点邻域（vd 只加载玩家周围）
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

test('丛林要塞：真实按钮瞬移 → 城西丛林里有石砖要塞（Worker GEN + 世界方块 + 画面）', async ({ page }) => {
  test.setTimeout(500_000);
  await page.goto('/?vd=8&seed=12345&skybox=0');
  await page.waitForFunction(READY, null, { timeout: 120_000 });
  await page.waitForFunction(STABLE, null, { timeout: 90_000, polling: 500 });

  // ── ① 锚点经 Worker layout RPC 往返后仍在，且是城西 ──
  const anchor = await page.evaluate(async () => {
    const m = await import('/src/gen/structures/jungle-fortress.js');
    const { computeRegionLayout } = await import('/src/gen/structures/structure-layout.js');
    const { REGION_SIZE, CITY_TRANSITION_SIZE } = await import('/src/gen/structures/region-config.js');
    const { getCityBoundsForSeed } = await import('/src/gen/structures/city-layout.js');
    const seed = window.__MC_GAME__.seed;
    const a = m.computeJungleFortressAnchor(seed);
    if (!a) return null;
    const rx = Math.floor(a.wx / REGION_SIZE), rz = Math.floor(a.wz / REGION_SIZE);
    const lay = computeRegionLayout(rx, rz, seed);
    const city = getCityBoundsForSeed(seed);
    return {
      wx: a.wx, wz: a.wz, floorY: a.floorY,
      layoutCarries: !!lay.jungleFortress,
      layoutWx: lay.jungleFortress?.wx ?? null,
      halfX: m.JUNGLE_FORTRESS_HALF_X,
      cityMinX: city.minX, clearance: CITY_TRANSITION_SIZE,
    };
  });
  expect(anchor, '前提：seed 12345 必须有丛林要塞锚点').not.toBeNull();
  expect(anchor.layoutCarries, '锚点所在 region 的 layout 必须携带它（否则 GEN 永不光栅化）').toBe(true);
  expect(anchor.layoutWx, 'layout 携带的锚点与纯函数同源（红线 1）').toBe(anchor.wx);
  // ⚠️ 城西口径：占地东缘必须出城西界 − 净空（写成城东会让 8/8 seed 返回 null）
  expect(anchor.wx + anchor.halfX,
    '整个占地必须在 City 西方且净距 ≥ CITY_TRANSITION_SIZE')
    .toBeLessThan(anchor.cityMinX - anchor.clearance);

  // ── ② 对照组：先看「无要塞的森林」（同一 seed，玩家出生点附近的林地）──
  // 判据必须带对照组，否则「灰石占比高」可能只是森林本身的石头地表。
  await gotoAndView(page, { x: 40, y: 30, z: 40 }, 0, -0.35);
  const control = stoneStats(await page.screenshot());

  // ── ③ 从**真实按钮**瞬移（不是只调 Game API）──
  await page.locator('#settings-btn').click();
  await expect(page.locator('#settings-modal')).toBeVisible();
  await page.locator('#btn-teleport-jungle-fortress').click();
  await expect(page.locator('#mc-toast')).toContainText('丛林要塞', { timeout: 20_000 });

  const landed = await page.evaluate(() => {
    const p = window.__MC_GAME__.player.physics.pos;
    return { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
  });
  // 冻结落点（seed 12345）：(-218, 3, 217)
  expect(landed.x, '落点 x 必须是冻结值').toBe(-218);
  expect(landed.z, '落点 z 必须是冻结值').toBe(217);
  expect(landed.y, '落点 y 必须是整形后地表+1（用自然高度会悬空 3 格）').toBe(3);

  // ── ④ 飞到要塞上方俯瞰，读**真实世界方块** ──
  await gotoAndView(page, { x: anchor.wx, y: anchor.floorY + 45, z: anchor.wz }, 0, -Math.PI / 2);
  const blocks = await page.evaluate(async (a) => {
    const g = window.__MC_GAME__;
    const reg = g.registry;
    const { loadStructure } = await import('/src/gen/structures/structure-json.js');
    const data = await loadStructure('jungleFortress');
    const counts = {};
    // 产物逐格核对：均匀抽 2000 格比对世界方块
    // ⚠️ **不能用 `checked % step` 做抽样**：checked 每轮只 +1，step>1 时永远命不中
    //    ⇒ roomSamples=0，断言退化成「0>0」恒 FAIL（初稿实测踩到）。
    let mismatch = 0, checked = 0;
    const step = Math.max(1, Math.floor(data.blocks.length / 2000));
    for (let i = 0; i < data.blocks.length; i += step) {
      const b = data.blocks[i];
      checked++;
      const wy = a.floorY + (b.y - data.floorRow);
      const id = g.world.getBlockId(a.wx + b.x, wy, a.wz + b.z);
      if (reg.nameOf(id) !== b.type) mismatch++;
    }
    // 房间空气：**直接筛 air 格**再均匀抽 200 个（与上面的均匀抽样独立）
    const airs = data.blocks.filter((b) => b.type === 'air');
    let airInRoom = 0, roomSamples = 0;
    const airStep = Math.max(1, Math.floor(airs.length / 200));
    for (let i = 0; i < airs.length; i += airStep) {
      const b = airs[i];
      roomSamples++;
      const wy = a.floorY + (b.y - data.floorRow);
      if (g.world.getBlockId(a.wx + b.x, wy, a.wz + b.z) === 0) airInRoom++;
    }
    // 占地内地表层的方块分布
    for (let dx = -80; dx <= 80; dx += 4) {
      for (let dz = -77; dz <= 77; dz += 4) {
        const n = reg.nameOf(g.world.getBlockId(a.wx + dx, a.floorY, a.wz + dz));
        if (n) counts[n] = (counts[n] || 0) + 1;
      }
    }
    return { counts, mismatch, checked, airInRoom, roomSamples, productCells: data.blocks.length };
  }, anchor);

  expect(blocks.productCells, '产物必须是 81238 格（含藤蔓）').toBe(81238);
  // ⚠️ 后写胜 + 跨 column 裁剪 ⇒ 不假设 100% 吻合，但绝大多数必须一致
  expect(blocks.mismatch / blocks.checked,
    `世界方块与产物声明的不吻合率必须 <5%（实测 ${blocks.mismatch}/${blocks.checked}）`)
    .toBeLessThan(0.05);
  expect(blocks.airInRoom,
    `房间空气格在世界里必须真的是 air（实测 ${blocks.airInRoom}/${blocks.roomSamples}）—— ` +
    '为 0 说明空气漏写、被天然岩层填满（DR-2 核心失效）')
    .toBeGreaterThan(0);
  expect(blocks.roomSamples, '空气抽样必须有量（否则上一条断言无判别力）').toBeGreaterThan(50);
  const stoneCells = (blocks.counts.mossy_stone || 0) + (blocks.counts.cobblestone || 0)
    + (blocks.counts.stone_bricks || 0) + (blocks.counts.tuff_bricks || 0);
  expect(stoneCells, `占地地表层必须有大量石砖族方块（实测 ${stoneCells}）`).toBeGreaterThan(200);

  // ── ⑤ 画面：灰石占比显著高于对照组，且不过曝、无假水面 ──
  const shot = stoneStats(await page.screenshot());
  expect(shot.stoneFrac,
    `要塞画面灰石占比必须显著高于无要塞森林对照组（要塞 ${shot.stoneFrac.toFixed(3)} vs 对照 ${control.stoneFrac.toFixed(3)}）`)
    .toBeGreaterThan(control.stoneFrac + 0.05);
  // 上界：不得过曝（纯白/纯灰满屏说明材质或光照坏了）
  expect(shot.meanLum, `画面均值亮度不得过曝（实测 ${shot.meanLum.toFixed(1)}）`).toBeLessThan(200);
  expect(shot.meanLum, `画面不得纯黑（实测 ${shot.meanLum.toFixed(1)}）`).toBeGreaterThan(20);
  // 零假水面：整形区恒干燥 ⇒ 俯瞰不该出现成片水体像素
  expect(shot.waterFrac,
    `整形区内不得有假水面（水体像素占比 ${shot.waterFrac.toFixed(4)}）—— 遇湿即止保证零水格`)
    .toBeLessThan(0.01);
});