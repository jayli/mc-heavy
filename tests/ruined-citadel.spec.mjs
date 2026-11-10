import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

// 废弃堡垒（Ruined Citadel，v2.89）Tier 4 像素验收。
//
// 验三件浏览器单测（test-ruined-citadel-gen.js）验不到的事：
//   ① 真实 Worker 池 GEN 路径（不是本地 applyStructuresToColumn）真的写出了堡垒；
//   ② 锚点经 Worker 'layout' RPC（结构化克隆）往返后仍在，且落点就是城西沙漠那一处；
//   ③ **画面**上确实是一座末地石堡垒 + 地下地牢有光无水（数据层对、网格层旧 → 两者会分裂，
//      AGENTS.md「光照类缺陷的断言必须落在画面上」同理）。
//
// ⚠️ 像素断言**同时钉上下界**（只钉「够暗」抓不到「纯黑」，只钉「非黑」抓不到「过曝」）。
//
// ## 阈值来源（2026-11-10 实测，seed 12345，同状态重复截图噪声底 0.0000）
//   A（堡垒外东侧斜看）：nsMeanLum 81.8 / nsStdLum 62.4 / nonSky 0.994 / endStone 0.419 / water 0.00055
//   对照（同机位同角度纯沙漠，无堡垒）：endStone 0.023 / water 0.00008
//   B（地牢房间内平视）：nsMeanLum 60.9 / nsStdLum 75.3 / nonSky 1.000 / endStone 0.085 / water 0.0
// 下界取实测值的 ~1/4（留足余量防负载波动），上界取 240（过曝白屏判据）。
//
// ## ⚠️ 两个判据是实测校准出来的，不是拍脑袋（各有一个对照组）
//
// **「末地石主色」判据 = `g >= r && g > b*1.25 && lum > 60`**：
//   · end_stone 未光照 rgb(218,221,157)、end_stone_bricks rgb(220,226,164) 都是 g≥r、g 显著高于 b ⇒ 命中；
//   · **沙漠沙 sand_side rgb(193,183,144) 是 r>g ⇒ 被排除**（否则「只是沙漠没有堡垒」也会命中，
//     断言失去判别力）；天空 rgb(135,206,235) 的 g < b*1.25 ⇒ 也被排除。
//   · 判别力实测：堡垒外 0.419 vs 纯沙漠对照 0.023（**18×**）。
//
// **「水体」判据 = `b > r+25 && g > r+12 && lum ∈ [95,150]`**（带亮度门 + g>r）：
//   · 真水 rgb(70,115,155)（体素水贴图均值，lum 113）/ rgb(76,122,166)（海面平面受光，lum 121）在门内；
//   · **必须带 `g > r+12`**：否则**紫色方块**误报 —— void_stone rgb(120,31,225) 的 b 远大于
//     r/g，宽松的 `b>r && b>g` 会把它当水（实测第一版漏了这条，A/B 两视角各误报 ~4000 像素）。
//     ⚠️ v2.90 前 `amethyst` rgb(141,103,197) 也是误报源（4,210 格）；用户裁定紫珀族改映
//     `deepslate` rgb(120,120,145) 后它已不在堡垒里，但**本判据仍须保留 `g>r+12`** ——
//     void_stone 那 122 格依旧会误报，且将来任何蓝/紫方块进产物都靠这一条兜住。
//   · **必须带亮度门 [95,150]**：否则**雾化天空** rgb(168,208,216)（lum 197）与**暗 obsidian**
//     rgb(32,72,120)（lum 75）误报（skybox=0 的纯天蓝是 rgb(135,206,235)，±30 容差抓不到
//     雾化后的 168,208,216，|168−135|=33）。
//   · 已用单变量 A/B 证实地牢视角的蓝像素**不是海面平面**：`g.ocean.plane.visible = false`
//     前后命中数逐位相同，且该 column 的水方块数为 0。
//     （⚠️ 那个 mesh **没有 name**，用 scene.traverse 按名字找会一个都找不到 ⇒ 必须用 `g.ocean.plane`。）

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

/** 末地石主色判据（见文件头校准说明） */
const isEndStone = (r, g, b) => g >= r && g > b * 1.25 && (r + g + b) / 3 > 60;
/** 水体判据（带亮度门 + g>r，见文件头校准说明） */
const WATER_LUMA_MIN = 95;
const WATER_LUMA_MAX = 150;
const isWater = (r, g, b) => {
  const lum = (r + g + b) / 3;
  return b > r + 25 && g > r + 12 && lum >= WATER_LUMA_MIN && lum <= WATER_LUMA_MAX;
};

/**
 * 截图统计：全帧均值 + **非天空像素**的均值/标准差 + 末地石占比 + 水体占比。
 *
 * ⚠️ 亮度与色偏只对**非天空像素**统计：`skybox=0` 时天空是纯天蓝 0x87ceeb（亮度≈192），
 * 俯瞰视角天空占比大 —— 若把天空算进均值，「过曝上界」会被天空亮度顶破（大竞技场同口径）。
 */
function stats(pngBuffer) {
  const png = PNG.sync.read(pngBuffer);
  const n = png.width * png.height;
  let sr = 0, sg = 0, sb = 0, s2 = 0, nonSky = 0;
  let nsR = 0, nsG = 0, nsB = 0, nsS2 = 0;
  let water = 0, endStone = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const r = png.data[o], g = png.data[o + 1], b = png.data[o + 2];
    sr += r; sg += g; sb += b;
    const lum = (r + g + b) / 3;
    s2 += lum * lum;

    if (isWater(r, g, b)) water++;
    if (isEndStone(r, g, b)) endStone++;

    // 天空蓝 0x87ceeb=(135,206,235)，容差 30（与 city-visual / burning-arena 同口径）
    if (Math.abs(r - 135) > 30 || Math.abs(g - 206) > 30 || Math.abs(b - 235) > 30) {
      nonSky++;
      nsR += r; nsG += g; nsB += b; nsS2 += lum * lum;
    }
  }
  const meanLum = (sr + sg + sb) / (3 * n);
  const nsMeanLum = nonSky > 0 ? (nsR + nsG + nsB) / (3 * nonSky) : 0;
  return {
    width: png.width, height: png.height, meanLum,
    stdLum: Math.sqrt(Math.max(0, s2 / n - meanLum * meanLum)),
    nonSkyRatio: nonSky / n,
    nsMeanLum,
    nsStdLum: nonSky > 0 ? Math.sqrt(Math.max(0, nsS2 / nonSky - nsMeanLum * nsMeanLum)) : 0,
    waterRatio: water / n,
    endStoneRatio: endStone / n,
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
  // ⚠️ 等的是**玩家所在** column 邻域（±3），不是锚点邻域：玩家可能站在堡垒外 90 格，
  // 而 vd=8 只加载玩家周围的 column —— 等锚点邻域会恒超时（大竞技场实测踩到）。
  await page.waitForFunction((p) => {
    const g = window.__MC_GAME__;
    const ccx = Math.floor(p.x / 16), ccz = Math.floor(p.z / 16);
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
      if (!g.world.hasColumn(ccx + dx, ccz + dz)) return false;
    }
    return true;
  }, pos, { timeout: 180_000 });
  await page.waitForFunction(STABLE, null, { timeout: 120_000, polling: 500 });
  await page.waitForTimeout(1500);
}

test('废弃堡垒：城西沙漠里生成了末地石堡垒 + 地牢有光无水（真实 Worker GEN + 世界方块 + 画面）', async ({ page }) => {
  test.setTimeout(500_000);
  // ⚠️ `skybox=0`：本 spec 用「像素落在 0x87ceeb ±30 内 = 天空」数非天空占比，
  // 天空盒上线后天空是照片 → 天空像素被误判成地形，判据失效（city-visual.spec 同口径）。
  await page.goto('/?vd=8&seed=12345&skybox=0');
  await page.waitForFunction(READY, null, { timeout: 120_000 });
  await page.waitForFunction(STABLE, null, { timeout: 90_000, polling: 500 });

  // ── ① 锚点（经 Worker RPC 往返后的 layout 必须与纯函数同源）──
  const anchor = await page.evaluate(async () => {
    const m = await import('/src/gen/structures/ruined-citadel.js');
    const seed = window.__MC_GAME__.seed;
    const a = m.computeRuinedCitadelAnchor(seed);
    if (!a) return null;
    // layout 侧：锚点所在 region 必须携带它（`ruinedCitadelOverlapsRegion` 裁剪）
    const { computeRegionLayout } = await import('/src/gen/structures/structure-layout.js');
    const { REGION_SIZE } = await import('/src/gen/structures/region-config.js');
    const rx = Math.floor(a.wx / REGION_SIZE), rz = Math.floor(a.wz / REGION_SIZE);
    const lay = computeRegionLayout(rx, rz, seed);
    // ⚠️ **必须 `await loadStructure` 再读 floorRow**：`floorRowOf` 读的是**本线程的
    // 模块级缓存**，而结构只在 GEN Worker 里被加载 —— 主线程缓存恒空，不先 load 会拿到
    // 兜底值 1（大竞技场实测踩到）。
    const { loadStructure } = await import('/src/gen/structures/structure-json.js');
    const data = await loadStructure('ruinedCitadel');
    return {
      wx: a.wx, wz: a.wz, floorY: a.floorY, span: a.span,
      halfX: m.RUINED_CITADEL_HALF_X, halfZ: m.RUINED_CITADEL_HALF_Z,
      floorRow: data.floorRow,
      layoutCarries: !!lay.ruinedCitadel,
      layoutWx: lay.ruinedCitadel?.wx ?? null,
      layoutWz: lay.ruinedCitadel?.wz ?? null,
    };
  });
  expect(anchor, '前提：seed 12345 必须有废弃堡垒锚点（用户裁定「必须且唯一」）').not.toBeNull();
  expect(anchor.layoutCarries, '锚点所在 region 的 layout 必须携带它（否则 GEN 永不光栅化）').toBe(true);
  expect(anchor.layoutWx, 'layout 携带的锚点与纯函数同源（红线 1：不另写一份落点）').toBe(anchor.wx);
  expect(anchor.layoutWz).toBe(anchor.wz);
  expect(anchor.floorRow, '产物 floorRow 经 Worker 加载后仍是 45').toBe(45);

  /** 产物局部坐标 → 世界坐标（与 apply.js 阶段 2.94 的落位公式同源） */
  const toWorld = (px, ny, pz) => ({
    x: anchor.wx + px, y: anchor.floorY + (ny - anchor.floorRow), z: anchor.wz + pz,
  });

  // ── ② 飞到堡垒上空并等 column 就绪，**再**读真实世界方块 ──
  // ⚠️ 时序是载荷性的：不先飞过去就读，锚点 column 还没加载 → `getBlockId` 恒返回 0（air）。
  await gotoAndView(page, { x: anchor.wx, y: anchor.floorY + 40, z: anchor.wz }, 0, -Math.PI / 2);

  const blocks = await page.evaluate(async (a) => {
    const g = window.__MC_GAME__;
    const reg = g.registry;
    const { loadStructure } = await import('/src/gen/structures/structure-json.js');
    const data = await loadStructure('ruinedCitadel');
    const name = (wx, wy, wz) => {
      const id = g.world.getBlockId(wx, wy, wz);
      return id ? reg.nameOf(id) : 'air';
    };
    const W = (px, ny, pz) => [a.wx + px, a.floorY + (ny - data.floorRow), a.wz + pz];
    // 甲板层已知样本：产物 (-52,45,-3) 是 end_stone，ny=46 无块（开放可站）
    const deck = W(-52, 45, -3);
    // 地牢房间已知样本：产物 (2,24,-2) 是 air；(2,21,-2) 是 ochre_froglight；(2,18,-2) 是 end_stone 锥体
    const room = W(2, 24, -2);
    const lamp = W(2, 21, -2);
    const base = W(2, 18, -2);
    // 甲板层 end_stone 计数（占地内逐格，抽样步长 2 控成本）
    let deckEndStone = 0, deckChecked = 0;
    for (let dx = -a.halfX; dx <= a.halfX; dx += 2) {
      for (let dz = -a.halfZ; dz <= a.halfZ; dz += 2) {
        deckChecked++;
        if (name(a.wx + dx, a.floorY, a.wz + dz) === 'end_stone') deckEndStone++;
      }
    }
    return {
      deckBlock: name(...deck),
      deckAbove: name(deck[0], deck[1] + 1, deck[2]),
      roomBlock: name(...room),
      lampBlock: name(...lamp),
      baseBlock: name(...base),
      deckEndStone, deckChecked,
      lampEmissive: reg.emissiveTable[reg.idOf('ochre_froglight')],
    };
  }, anchor);

  // 甲板落在 floorY 且是末地石系，上方可站
  expect(blocks.deckBlock, '甲板格必须是 end_stone（y 差一格会沉进沙里或浮空）').toBe('end_stone');
  expect(blocks.deckAbove, '甲板上方必须是空气（玩家能站上去）').toBe('air');
  expect(blocks.deckEndStone, `甲板层 end_stone 抽样计数（${blocks.deckEndStone}/${blocks.deckChecked}）必须 >1000，防「静默空结构」恒真`)
    .toBeGreaterThan(1000);
  // ⚠️ DR-2 的 GEN 级证据：地牢房间在**真实世界**里是 air（产物里对不代表世界里对 ——
  //    若 apply 阶段漏了、或 makeColumnSetter 对 'air' 静默 return，天然岩层会留在房间里）
  expect(blocks.roomBlock, '地牢房间格必须是 air（否则 44 层地牢被天然岩层填满，spec DR-2 失效）').toBe('air');
  expect(blocks.baseBlock, '地牢底部的 end_stone 锥体必须保留（房间的地基）').toBe('end_stone');
  // 虚空灯位是 ochre_froglight 且真的发光（地牢 skylight=0，靠它照明）
  expect(blocks.lampBlock, '虚空灯位必须是 ochre_froglight').toBe('ochre_froglight');
  expect(blocks.lampEmissive, 'ochre_froglight 必须发光（emissive>0），否则 44 层地牢全黑').toBeGreaterThan(0);

  // ──  画面 A：堡垒外东侧斜看全景（末地石主体 + 塔楼轮廓）──
  // 机位：占地东缘外 40 格、甲板上方 25 格，面朝西（yaw=π/2 ⇒ forward=(-1,0,0)）斜看。
  // ⚠️ **方向与大竞技场相反**：大竞技场在城东 ⇒ 从西侧看；本结构在城西 ⇒ 从东侧看。
  const viewA = toWorld(anchor.halfX + 40, anchor.floorRow + 25, 0);
  await gotoAndView(page, viewA, Math.PI / 2, -0.35);
  const sA = stats(await page.screenshot());
  console.log('CITADEL VIEW A (外东侧斜看):', JSON.stringify(sA));

  // ── ④ 画面 B：地牢房间内平视（ochre_froglight 照明 + 末地石/黑曜石墙体）──
  // 房间：产物 ny=30 是地板（嵌 4 盏灯）、ny=31..36 是空气、ny=38 是天花板。
  // 相机放 ny=33（房间中层），面朝 -Z（yaw=0）看向灯所在的 z=-5 方向。
  const viewB = toWorld(0, 33, -2);
  await gotoAndView(page, viewB, 0, 0);
  const shotB = await page.screenshot();
  const sB = stats(shotB);
  console.log('CITADEL VIEW B (地牢房间):', JSON.stringify(sB));

  // ── ⑤ 噪声底：同状态重复截图（AGENTS.md：定阈值前先测噪声底）──
  const sB2 = stats(await page.screenshot());
  console.log('CITADEL VIEW B repeat:', JSON.stringify(sB2));
  const noise = Math.abs(sB.nsMeanLum - sB2.nsMeanLum);
  console.log('NOISE FLOOR nsMeanLum diff:', noise.toFixed(4));
  expect(noise, '同状态重复截图的噪声底必须 <1（否则阈值无意义，先查帧循环是否需要冻结）').toBeLessThan(1);

  // ── ⑥ 像素断言（上下界双钉；亮度用非天空像素，理由见 stats 头）──
  // A：堡垒外斜看必须看到大量非天空（堡垒占据视野），且不是纯黑/过曝
  expect(sA.nonSkyRatio, '堡垒外非天空占比下界（堡垒+沙漠占据视野）').toBeGreaterThan(0.30);
  expect(sA.nsMeanLum, '堡垒外场景亮度下界（不得纯黑 = 网格没上传/光照全 0）').toBeGreaterThan(20);
  expect(sA.nsMeanLum, '堡垒外场景亮度上界（不得过曝白屏）').toBeLessThan(240);
  expect(sA.nsStdLum, '堡垒外场景对比度下界（不得全同色 = 空结构/纯色屏）').toBeGreaterThan(15);
  // 「堡垒在画面里」的判别性判据：末地石主色（判据已用 g≥r 排除沙漠沙、g>b*1.25 排除天空）。
  // 实测堡垒外 0.419 vs 纯沙漠对照 0.023（18×）—— 若堡垒没渲染出来，这里会掉到对照水平。
  expect(sA.endStoneRatio, '堡垒外末地石主色占比下界（实测 0.419，纯沙漠对照 0.023；为 ~0 说明堡垒没渲染出来）')
    .toBeGreaterThan(0.10);
  // 水约束的像素级证据（A）：堡垒外不得出现真水色。
  // ⚠️ 用 < 0.01 而非 == 0：判据对个别抗锯齿/亮边像素有 ~0.0005 的残余误报，真水漏进来会是 0.05+。
  expect(sA.waterRatio, '堡垒外不得出现真水色（水约束：占地+4 格全干燥；实测 0.00055）').toBeLessThan(0.01);

  // B：地牢内不得纯黑（ochre_froglight 照明生效 —— 这是「地牢可玩」的像素级证据）
  expect(sB.nsMeanLum, '地牢内亮度下界（不得纯黑 = 134 盏虚空灯没生效，44 层地牢不可玩；实测 60.9）')
    .toBeGreaterThan(15);
  expect(sB.nsMeanLum, '地牢内亮度上界（不得过曝）').toBeLessThan(240);
  expect(sB.nsStdLum, '地牢内对比度下界（不得全同色 = 房间没挖出来/被岩层填满）').toBeGreaterThan(15);
  expect(sB.nonSkyRatio, '地牢内必须全是非天空（在地下看不到天）').toBeGreaterThan(0.95);
  // 水约束的像素级证据（B）：地牢里不得出现真水色（实测 0.0）
  expect(sB.waterRatio, '地牢内不得出现真水色（水约束的像素级证据；实测 0.0）').toBeLessThan(0.01);
  // 地牢墙体是末地石系（房间挖出来了，不是实心岩层）
  expect(sB.endStoneRatio, '地牢内末地石主色占比下界（实测 0.085；为 ~0 说明房间没挖出来）')
    .toBeGreaterThan(0.02);
});
