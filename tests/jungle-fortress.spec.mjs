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
 * ⚠️⚠️ **天空色必须用实测值 (169,208,219)**（v3.18 标定）：
 *    `?skybox=0` 下背景是**难化色**，不是纯天蓝 (135,206,235)。
 *    实测顶部像素众数 169,208,219 占 212/240；用旧值会把天空计入 stone/green，
 *    造成「要塞 0.065 vs 对照 0.082」这类假红。
 * ⚠️ 树叶/草是高饱和绿（g 明显大于 r 与 b），用 `g - max(r,b) > 25` 排除。
 * ⚠️ 水体判据（AGENTS.md 标定）：b>r+25 && g>r+12 && lum∈[95,150]。
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
    if (Math.abs(r - 169) <= 24 && Math.abs(g - 208) <= 24 && Math.abs(b - 219) <= 24) { sky++; continue; }
    if (b > r + 25 && g > r + 12 && lum >= 95 && lum <= 150) { water++; continue; }
    if (g - Math.max(r, b) > 25) { green++; continue; }
    // 灰石：低饱和（三通道极差 ≤ 30）且亮度在石砖族区间
    if (Math.max(r, g, b) - Math.min(r, g, b) <= 30 && lum >= 55 && lum <= 175) stone++;
  }
  return {
    total: n, sky, green, water, stone,
    stoneFrac: stone / n, waterFrac: water / n, greenFrac: green / n, skyFrac: sky / n,
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
  // ⚠️⚠️ **稳定后必须重新钉一次位置**（final review 实测）：等 column 加载期间物理已在跑，
  //    玩家会从未加载的空中坠落（实测 y 从 4 掉到 −23）⇒ 截图机位与请求机位不符，
  //    像素判据随机漂（同一机位两次跑 0.3736 / 0.0397）。重钉后再等一帧渲染。
  await page.evaluate(({ pos, yaw, pitch }) => {
    const g = window.__MC_GAME__;
    g.player.physics.pos.x = pos.x;
    g.player.physics.pos.y = pos.y;
    g.player.physics.pos.z = pos.z;
    g.player.physics.vel.x = g.player.physics.vel.y = g.player.physics.vel.z = 0;
    g.player.yaw = yaw;
    g.player.pitch = pitch;
  }, { pos, yaw, pitch });
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

  // ── ② 对照组口径说明（v3.18）──
  // ⚠️ 旧对照组是「远处森林 (40,30,40)」—— 不同机位、不同地形，
  //    与本结构机位的灰石占比不可比（实测造成假红）。
  //    现改为钉**三方对照实测出的区间**（base 0.2488 / 埋回 0.0304），
  //    并在第二个 test 里用 page.route 做**同机位单变量**对照。

  // ── ③ 从**真实按钮**瞬移（不是只调 Game API）──
  await page.locator('#settings-btn').click();
  await expect(page.locator('#settings-modal')).toBeVisible();
  await page.locator('#btn-teleport-jungle-fortress').click();
  await expect(page.locator('#mc-toast')).toContainText('丛林要塞', { timeout: 20_000 });

  const landed = await page.evaluate(() => {
    const p = window.__MC_GAME__.player.physics.pos;
    return { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
  });
  // 冻结落点（seed 12345）：(-218, 6, 217) —— v3.18 地形不再削平，y = 自然地表+1
  expect(landed.x, '落点 x 必须是冻结值').toBe(-218);
  expect(landed.z, '落点 z 必须是冻结值').toBe(217);
  expect(landed.y, '落点 y 必须是自然地表+1（用 baseY+1=10 会悬空 4 格）').toBe(6);

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
  expect(blocks.airInRoom / blocks.roomSamples,
    `房间空气格在世界里必须几乎全是 air（实测 ${blocks.airInRoom}/${blocks.roomSamples}）—— ` +
    '接近 0 说明空气漏写、被天然岩层填满（DR-2 核心失效）')
    .toBeGreaterThan(0.95);
  expect(blocks.roomSamples, '空气抽样必须有量（否则上一条断言无判别力）').toBeGreaterThan(50);
  const stoneCells = (blocks.counts.mossy_stone || 0) + (blocks.counts.cobblestone || 0)
    + (blocks.counts.stone_bricks || 0) + (blocks.counts.tuff_bricks || 0);
  expect(stoneCells, `占地地表层必须有大量石砖族方块（实测 ${stoneCells}）`).toBeGreaterThan(200);

  // ── ⑤ 画面：俯瞰机位的灰石占比 / 植被占比 / 零假水面 ──
  //
  // ⚠️⚠️ **阈值取自三方对照实测**（t8-calib3，同机位只差 baseY）：
  //    base（baseY=9） stoneFrac **0.2488** / greenFrac **0.278**
  //    minH（baseY=0，埋回） stoneFrac **0.0304** / greenFrac **0.775**
  //    ⇒ 抬升让建筑露出（8.2× 灰石），埋回则被树冠盖住。
  //    区间取两侧之间（下界 0.12 / 上界 0.45），同时钉植被上界。
  const shot = stoneStats(await page.screenshot());
  expect(shot.stoneFrac,
    `俯瞰灰石占比必须在抬升态区间（实测 ${shot.stoneFrac.toFixed(4)}；base 0.2488 / 埋回对照 0.0304）`)
    .toBeGreaterThan(0.12);
  expect(shot.stoneFrac, `灰石占比不得过曝满屏（实测 ${shot.stoneFrac.toFixed(4)}）`).toBeLessThan(0.45);
  expect(shot.greenFrac,
    `俯瞰植被占比不得像埋回态那样盖满（实测 ${shot.greenFrac.toFixed(4)}；base 0.278 / 埋回 0.775）`)
    .toBeLessThan(0.55);
  expect(shot.meanLum, `画面均值亮度不得过曝（实测 ${shot.meanLum.toFixed(1)}）`).toBeLessThan(200);
  expect(shot.meanLum, `画面不得纯黑（实测 ${shot.meanLum.toFixed(1)}）`).toBeGreaterThan(20);
  // 零假水面：占地恒干燥 + 裙边湿列零抬升 ⇒ 俯瞰不该出现成片水体像素
  expect(shot.waterFrac,
    `占地内不得有假水面（水体像素占比 ${shot.waterFrac.toFixed(4)}）`)
    .toBeLessThan(0.01);

  // ── ⑥ **室内机位**（plan Task 8 / spec §5 Tier 4 要求，review I2）──
  // 要塞有大量封闭内腔（air 15536）且无光源方块，「走进去全黑」是合理玩家会立即抱怨的形态。
  // 取产物里已验证的 air 格 [10,16,2] 换算世界坐标，站进去平视。
  const indoor = await page.evaluate(async (a) => {
    const { loadStructure } = await import('/src/gen/structures/structure-json.js');
    const d = await loadStructure('jungleFortress');
    // 产物局部 (10,16,2) 已验为 air；世界 y = floorY + (ny - floorRow)
    return { x: a.wx + 10, y: a.floorY + (16 - d.floorRow), z: a.wz + 2 };
  }, anchor);
  await gotoAndView(page, { x: indoor.x + 0.5, y: indoor.y, z: indoor.z + 0.5 }, 0, 0);
  const indoorId = await page.evaluate((p) => {
    const g = window.__MC_GAME__;
    return g.world.getBlockId(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
  }, indoor);
  expect(indoorId, '室内站位必须是空气（否则玩家卡在方块里）').toBe(0);
  // 先测**同状态重复截图的噪声底**（spec §5 要求），再钉上下界
  const s1 = stoneStats(await page.screenshot());
  const s2 = stoneStats(await page.screenshot());
  const noise = Math.abs(s1.meanLum - s2.meanLum);
  expect(noise, `同状态重复截图噪声底应极小（实测 ${noise.toFixed(3)}）`).toBeLessThan(1.0);
  expect(s1.meanLum,
    `室内不得纯黑（实测均值亮度 ${s1.meanLum.toFixed(1)}）—— 封闭内腔无光源时玩家会抱怨`)
    .toBeGreaterThan(8);
  expect(s1.meanLum, `室内不得过曝（实测 ${s1.meanLum.toFixed(1)}）`).toBeLessThan(210);
});

/**
 * 接壤阶梯过渡的**数据驱动机位搜索**（v3.18 DR-10，用户追加裁定）。
 *
 * ⚠️⚠️ **机位必须按数据选**（v3.13c 教训，本轮又踩两次）：
 *    spec 原写的 z=53 机位落在**湿列**（nat=−1 ≤ SEA_Y），裙边在那里零抬升
 *    （湿屏障正确生效）⇒ 画面 20% 是水，对「阶梯过渡」零判别力。
 *    故选位要求：墙脚高 ≥5 格 + 相机到墙脚之间**全干燥且无建筑遮挡** + 抬升列 ≥4。
 *
 * @returns {Promise<{camX:number,camY:number,camZ:number,z:number,wallTop:number,lift:number}|null>}
 */
async function pickSkirtCamera(page, anchor) {
  return await page.evaluate(async (a) => {
    const M = await import('/src/gen/structures/jungle-fortress-terrain.js');
    const { loadStructure } = await import('/src/gen/structures/structure-json.js');
    const { JUNGLE_FORTRESS_HALF_X: HX, JUNGLE_FORTRESS_HALF_Z: HZ } =
      await import('/src/gen/structures/jungle-fortress-data.js');
    const data = await loadStructure('jungleFortress');
    M.noteJungleFortressData(data);
    const f = M.jungleFortressSkirtField({ wx: a.wx, wz: a.wz, floorY: a.floorY }, window.__MC_GAME__.seed, data);
    const { T, nat, baseTop, isWet } = f;
    const cands = [];
    for (let z = -HZ; z <= HZ; z++) {
      const bt = baseTop.get(`${HX},${z}`);
      if (bt === undefined) continue;
      const wallH = bt - 1 - nat(HX, z);
      if (wallH < 5) continue;
      for (let cam = HX + 10; cam <= HX + 20; cam++) {
        if (isWet(cam, z)) continue;
        let clear = true, wetBetween = 0, lift = 0, maxStep = 0, prevT = T(cam, z);
        for (let x = cam - 1; x > HX; x--) {
          if (baseTop.has(`${x},${z}`)) { clear = false; break; }
          if (isWet(x, z)) wetBetween++;
          const t = T(x, z);
          if (t > nat(x, z)) lift++;
          maxStep = Math.max(maxStep, Math.abs(t - prevT));
          prevT = t;
        }
        if (!clear || wetBetween > 0 || lift < 4 || maxStep > 1) continue;
        cands.push({ camX: a.wx + cam, camY: T(cam, z) + 2, camZ: a.wz + z, z, wallTop: bt, lift, wallH });
      }
    }
    cands.sort((p, q) => (q.wallH - p.wallH) || (q.lift - p.lift));
    return cands[0] || null;
  }, anchor);
}

test('丛林要塞：接壤阶梯过渡裙边 —— 逐级抬升的台地真的写进世界，且无悬崖', async ({ page }) => {
  test.setTimeout(500_000);
  await page.goto('/?vd=8&seed=12345&skybox=0');
  await page.waitForFunction(READY, null, { timeout: 120_000 });
  await page.waitForFunction(STABLE, null, { timeout: 90_000, polling: 500 });
  const anchor = await page.evaluate(async () => {
    const m = await import('/src/gen/structures/jungle-fortress.js');
    const a = m.computeJungleFortressAnchor(window.__MC_GAME__.seed);
    return { wx: a.wx, wz: a.wz, floorY: a.floorY };
  });
  const cam = await pickSkirtCamera(page, anchor);
  expect(cam, '必须能按数据找到干燥无遮挡的裙边视廊（否则本用例无判别力）').not.toBeNull();
  expect(cam.lift, '视廊上至少 4 列被裙边抬升').toBeGreaterThanOrEqual(4);

  // ── ① **几何判据（主）**：读真实世界方块，验证「逐级抬升 + 无悬崖」──
  //
  // ⚠️⚠️ **对照组不能用 page.route 换 GEN 模块**（final review 实测）：
  //    **Worker 脚本不走 page.route** ⇒ noskirt 注入对 GEN 完全无效，
  //    base 与 noskirt 的像素读数**逐位相同**（0.0399 vs 0.0401，五个机位全同）。
  //    真正有判别力的对照是**同一列的 nat（自然高度）**：它是「没有裙边时的地面」，
  //    由 generateHeight 独立给出，不依赖任何注入。
  await gotoAndView(page, { x: cam.camX, y: cam.camY, z: cam.camZ }, -Math.PI / 2, 0.06);
  const geo = await page.evaluate(async ({ a, cam }) => {
    const g = window.__MC_GAME__;
    const M = await import('/src/gen/structures/jungle-fortress-terrain.js');
    const { loadStructure } = await import('/src/gen/structures/structure-json.js');
    const { generateHeight } = await import('/src/gen/terrain.js');
    const { JUNGLE_FORTRESS_HALF_X: HX } = await import('/src/gen/structures/jungle-fortress-data.js');
    const data = await loadStructure('jungleFortress');
    M.noteJungleFortressData(data);
    const f = M.jungleFortressSkirtField({ wx: a.wx, wz: a.wz, floorY: a.floorY }, g.seed, data);
    const { T, nat, isBuilding } = f;
    const z = cam.z;
    const prof = [];
    const camPx = cam.camX - a.wx;
    for (let x = camPx; x > HX; x--) {
      const wx = a.wx + x, wz = a.wz + z;
      const t = T(x, z), h = nat(x, z);
      // 世界实际地面 = **包络场 T 那一格是否实心**（裙边写入的顶面）。
      // ⚠️ 不用「从高处向下扫第一个非空气」：那会命中树冠/树干（实测把 T=2 读成 4）。
      //    判据要落在「T 那格是地表材质」+「T+1 不是地形实心」两条上。
      const atT = g.registry.nameOf(g.world.getBlockId(wx, t, wz)) || 'air';
      const atT1 = g.registry.nameOf(g.world.getBlockId(wx, t + 1, wz)) || 'air';
      const ground = atT !== 'air' ? t : null;
      prof.push({ x, nat: h, T: t, ground, lift: t - h,
        topName: g.registry.nameOf(g.world.getBlockId(wx, t, wz)) || 'air',
        natBlock: g.registry.nameOf(g.world.getBlockId(wx, h, wz)) || 'air', aboveT: atT1,
        build: isBuilding(x, z), realNat: generateHeight(wx, wz, g.seed) });
    }
    return { prof, wallTop: cam.wallTop };
  }, { a: anchor, cam });

  expect(geo.prof.length, '视廊剖面必须有量').toBeGreaterThanOrEqual(5);
  // ①a 每一列的世界地面 == 包络场 T（裙边真的写进了世界）
  for (const p of geo.prof) {
    expect(p.nat, `(${p.x},${cam.z}) nat 必须与 generateHeight 同源`).toBe(p.realNat);
    expect(p.ground, `(${p.x},${cam.z}) 世界地面必须 = 包络场 T=${p.T}（实测 ${p.ground}）`).toBe(p.T);
  }
  // ①b **确有抬升**（对照 = 同列 nat）：至少 4 列被抬，且最大抬升 ≥3 格
  const lifted = geo.prof.filter((p) => p.lift > 0);
  expect(lifted.length, `视廊上必须有 ≥4 列被裙边抬升（实测 ${lifted.length}）`).toBeGreaterThanOrEqual(4);
  expect(Math.max(...geo.prof.map((p) => p.lift)),
    '最大抬升必须 ≥3 格（否则「阶梯台地」观感不成立）').toBeGreaterThanOrEqual(3);
  // ①c **无悬崖**：视廊上相邻列地面高差恒 ≤1（这就是用户要的「阶梯过渡」）
  let maxStep = 0;
  for (let i = 1; i < geo.prof.length; i++) {
    maxStep = Math.max(maxStep, Math.abs(geo.prof[i].ground - geo.prof[i - 1].ground));
  }
  expect(maxStep, `裙边视廊相邻列地面高差必须 ≤1（实测 ${maxStep}）—— 否则就是悬崖突变`).toBeLessThanOrEqual(1);
  // ①d **对照判别力**：无裙边时（= nat）墙脚落差必须 ≥5 格 ⇒ 证明裙边真的消除了悬崖
  const nearWall = geo.prof[geo.prof.length - 1];
  const cliffWithoutSkirt = geo.wallTop - 1 - nearWall.nat;
  expect(cliffWithoutSkirt,
    `无裙边时墙脚落差必须 ≥5 格（实测 ${cliffWithoutSkirt}）—— 否则本用例对「消除悬崖」无判别力`)
    .toBeGreaterThanOrEqual(5);
  const cliffWithSkirt = geo.wallTop - 1 - nearWall.ground;
  expect(cliffWithSkirt,
    `有裙边时墙脚落差必须 ≤2 格（实测 ${cliffWithSkirt}；无裙边 ${cliffWithoutSkirt}）`)
    .toBeLessThanOrEqual(2);
  // ①e 材质：抬升列顶面是 biome 地表（grass），下方 dirt —— 不是 mossy_stone
  for (const p of lifted) {
    expect(p.topName, `(${p.x},${cam.z}) 裙边顶面必须是草/地表材质，实测 ${p.topName}`)
      .toMatch(/grass|sand|snow|podzol|dirt/);
  }

  // ── ② 像素辅助（只钉存在性与曝光，不做对照组差分）──
  // ⚠️ 阈值在 **Playwright 默认 1280×720** 下实测（不是 960×600 —— 视野不同会稀释占比）：
  //    该机位 stoneFrac 0.0399 / greenFrac 0.355 / meanLum 57.7。
  const b1 = stoneStats(await page.screenshot());
  const b2 = stoneStats(await page.screenshot());
  expect(Math.abs(b1.meanLum - b2.meanLum), '同状态重复截图噪声底应极小').toBeLessThan(1.0);
  expect(b1.meanLum, `画面不得纯黑（实测 ${b1.meanLum.toFixed(1)}）`).toBeGreaterThan(20);
  expect(b1.meanLum, `画面不得过曝（实测 ${b1.meanLum.toFixed(1)}）`).toBeLessThan(200);
  expect(b1.waterFrac,
    `裙边视廊必须干燥（水体占比 ${b1.waterFrac.toFixed(4)}）—— 湿列零抬升是红线 1`)
    .toBeLessThan(0.10);
  expect(b1.stoneFrac + b1.greenFrac,
    '画面必须有地物（不是纯天空）').toBeGreaterThan(0.15);
});
