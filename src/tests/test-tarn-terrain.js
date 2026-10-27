// src/tests/test-tarn-terrain.js — 高台地带台地整形 Tier 1
//
// 钉的是「台地看起来像台地」的四个不可让步的事实：平台高度恒定、**无水**
// （v1.89 用户裁定去掉中央水池）、草石镶嵌两种方块都出现、边缘缓坡接续自然地形。
//
// ⚠️ **每个用例都必须先 `fillColumn` 再 `fillTarnPlateau`**（B5）：空 column 上
// 「削平原山」平凡通过，注入「忘了削山」的缺陷测不出来（既有手法见
// `test-giant-trees-gen.js:51`）。真实生成路径就是 `fillColumn` → `fillTarnPlateau` → 结构光栅化。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { computeTarnZone, isTarnZone, TARN_SLOPE_WIDTH as TARN_ZONE_SLOPE_WIDTH, TARN_ICE_RADIUS, TARN_SNOW_RADIUS } from '../gen/structures/tarn-zone.js';
import { fillTarnPlateau, tarnSurfaceBlock, TARN_TERRAIN_SALT, TARN_SLOPE_WIDTH, TARN_BLEND_WIDTH, tarnIceBoundaryAt, blobNoise } from '../gen/structures/tarn-terrain.js';
import { buildDefaultRegistry } from '../voxel/block-registry.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { blockIndex } from '../voxel/constants.js';
import { fillColumn } from '../gen/terrain.js';

const SEED = 12345;

function findTarnRegion() {
  for (let rx = -6; rx <= 6; rx++) for (let rz = -6; rz <= 6; rz++) {
    if (isTarnZone(rx, rz, SEED)) return { rx, rz };
  }
  throw new Error('没找到地带 region');
}

/** 建一个已整形到地带的 column（先 fillColumn 再 fillTarnPlateau） */
async function shapedColumn(lay, wx, wz, reg) {
  const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
  const col = new ChunkColumn(cx, cz);
  fillColumn(col, SEED, reg);
  fillTarnPlateau(col, lay, SEED, reg);
  return { col, lx: wx - cx * 16, lz: wz - cz * 16 };
}

test('台地：同一坐标两次调用表面方块相同（确定性）', async () => {
  const { rx, rz } = findTarnRegion();
  const lay = computeTarnZone(rx, rz, SEED);
  for (const [dx, dz] of [[0, 0], [30, 20], [-40, 77], [60, 60], [100, 10]]) {
    const wx = lay.cx + dx, wz = lay.cz + dz;
    const a = tarnSurfaceBlock(wx, wz, SEED, lay.cx, lay.cz, lay.platformRadius, lay.plateauRadius);
    const b = tarnSurfaceBlock(wx, wz, SEED, lay.cx, lay.cz, lay.platformRadius, lay.plateauRadius);
    assertEqual(a, b, `(${wx},${wz}) 稳定`);
  }
});

test('台地：TARN_TERRAIN_SALT 已导出且在空闲带内', () => {
  assertEqual(TARN_TERRAIN_SALT, 1022, 'TARN_TERRAIN_SALT 必须与 tarn-zone.js 的分配一致');
});

/**
 * 按半径带统计地表材质占比（唯一取样口径 —— 各用例共用，不各写一份循环）。
 * @returns {{byBand: Record<string, Record<string, number>>, total: number}}
 */
function surfaceBandStats(lay) {
  const { cx, cz, platformRadius: flatR, plateauRadius: R } = lay;
  const bands = [
    ['ice', 0, TARN_ICE_RADIUS],
    ['snow', TARN_ICE_RADIUS, TARN_SNOW_RADIUS],
    ['plot', TARN_SNOW_RADIUS, flatR],
    ['slope', flatR, R],
  ];
  const byBand = {};
  let total = 0;
  for (const [name, lo, hi] of bands) {
    const cnt = {};
    let n = 0;
    const lim = Math.ceil(hi);
    for (let dx = -lim; dx <= lim; dx++) for (let dz = -lim; dz <= lim; dz++) {
      const d = Math.hypot(dx, dz);
      if (d < lo || d >= hi) continue;
      const m = tarnSurfaceBlock(cx + dx, cz + dz, SEED, cx, cz, flatR, R);
      cnt[m] = (cnt[m] ?? 0) + 1;
      n++;
    }
    // 转成占比
    const frac = {};
    for (const [k, v] of Object.entries(cnt)) frac[k] = v / n;
    byBand[name] = frac;
    total += n;
  }
  return { byBand, total };
}

test('台地：四带材质分布（冰 / 雪环 / 草斑+黏土 / 黏土缓坡）', async () => {
  // ⚠️ 用户 2026-10-28 设计：中心冰、往外一圈松散的雪环、再往外黏土基底 + 成片草斑、
  //    最外缓坡整片 clay 接续外围地形。
  // 实测（seed 12345 第一座地带）：雪环 64.8% snow / 草斑带 47.1% grass + 18.3% stone
  //   + 27.7% clay / 缓坡 100% clay。
  const { rx, rz } = findTarnRegion();
  const lay = computeTarnZone(rx, rz, SEED);
  const { byBand } = surfaceBandStats(lay);

  // ① 冰带：主体必须是 ice（`d < ICE_R` 的采样里有 11% 被雪环的向内渗透带吃掉，属设计）
  // ⚠️ 下界 0.78（不是 0.9）：冰/雪边界的**齿**（`ICE_TOOTH`=20）会把雪推进冰区几格，
  //    实测冰带纯度 84.2%。这条数被齿深度直接决定，改齿前先看 `ICE_TOOTH` 的标定表。
  assertTrue((byBand.ice.ice ?? 0) >= 0.78,
    `冰带内 ice 只占 ${((byBand.ice.ice ?? 0) * 100).toFixed(1)}%（应 ≥78%）`);

  // ② 雪环：松散 —— 既要有雪，也不能是实心一环
  // ⚠️ **区间必须宽到覆盖「不同地带」的实际波动**：环内占空比由 `TARN_SNOW_FILL` 的
  //    噪声相位决定，而相位随地带中心坐标变 —— 实测 5 个 seed × 各自第一座地带：
  //    62.2%~83.2%（中位 63.6%）。拿单座地带标定的窄区间会在别的 seed 上假失败
  //    （实测就在 ±6 窗口的 seed 12345 地带（中心 -2200,-600）读到 83.2%）。
  //    判据只钉「不是 100% 实心环」与「不是几乎没有雪」这两条语义。
  const snowFrac = byBand.snow.snow ?? 0;
  assertTrue(snowFrac >= 0.45 && snowFrac <= 0.92,
    `雪环内 snow 占 ${(snowFrac * 100).toFixed(1)}%（应在 45%~92%，即「松散但认得出是环」）`);

  // ③ 草斑带：clay 是基底但 grass/stone 斑块必须出现（成片连通，不是零散点）
  const plot = byBand.plot;
  assertTrue((plot.grass ?? 0) >= 0.2, `草斑带 grass 只占 ${((plot.grass ?? 0) * 100).toFixed(1)}%（应 ≥20%）`);
  assertTrue((plot.stone ?? 0) >= 0.05, `草斑带 stone 只占 ${((plot.stone ?? 0) * 100).toFixed(1)}%（应 ≥5%）`);
  assertTrue((plot.clay ?? 0) >= 0.15, `草斑带 clay 只占 ${((plot.clay ?? 0) * 100).toFixed(1)}%（应 ≥15% —— 它是基底）`);

  // ④ 缓坡：整片 clay（接续外围地形）
  assertEqual(Math.round((byBand.slope.clay ?? 0) * 100), 100,
    `缓坡带必须 100% clay，实际 ${JSON.stringify(byBand.slope)}`);
});

test('台地：冰/雪之间有 5~7 格的融合带（冰比例随距离平滑下降）', async () => {
  // ⚠️ **用户 2026-10-28 第二轮要求**：「冰与雪之间要有一个 5~7 格的融合带，让雪过渡到冰」。
  //
  // ⚠️ **分桶按「相对带齿边界的距离」**（融合带就是贴着实际边界的那 6 格）。
  //    另一条用例（「互相侵入」）才用固定基准圆 44 当参照 —— 两者量的是不同的事：
  //    · 本条 = 「贴着边界的过渡带内部是否渐变」
  //    · 那条 = 「方块有没有越过基准圆侵入对方深处」
  const { rx, rz } = findTarnRegion();
  const lay = computeTarnZone(rx, rz, SEED);
  const { cx, cz, platformRadius: flatR, plateauRadius: R } = lay;
  const half = TARN_BLEND_WIDTH / 2;

  // 桶 0..5 覆盖 [44-half, 44+half)
  const buckets = Array.from({ length: 6 }, () => ({ ice: 0, n: 0 }));
  for (let dx = -80; dx <= 80; dx++) for (let dz = -80; dz <= 80; dz++) {
    const wx = cx + dx, wz = cz + dz;
    const d = Math.hypot(dx, dz);
    // ⚠️ **用带齿的实际边界分桶**（`tarnIceBoundaryAt`），不是固定基准圆。
    //    融合带是「贴着实际边界的那 6 格」—— 用固定圆分桶会把齿尖与齿根混进同一桶，
    //    实测首末差被压到 27 点（正确实现反被判 FAIL）。
    //    「互相侵入」由另一条用例单独钉（它才该用固定基准圆）。
    const b = tarnIceBoundaryAt(wx, wz, SEED);
    if (d < b - half || d >= b + half) continue;
    const t = (d - (b - half)) / TARN_BLEND_WIDTH;
    const bi = Math.min(5, Math.floor(t * 6));
    const m = tarnSurfaceBlock(wx, wz, SEED, cx, cz, flatR, R);
    buckets[bi].n++;
    if (m === 'ice') buckets[bi].ice++;
  }

  const total = buckets.reduce((s, b) => s + b.n, 0);
  assertTrue(total > 500, `融合带采样太少（${total}）—— 本用例无判别力`);
  for (const [i, b] of buckets.entries()) {
    assertTrue(b.n > 30, `融合带桶 ${i} 样本太少（${b.n}）`);
  }

  const ratio = buckets.map((b) => b.ice / b.n);
  const pct = ratio.map((r) => (r * 100).toFixed(0)).join('% → ') + '%';

  // ① 首末桶必须有显著差距（径向剖面确实在变）
  assertTrue(ratio[0] - ratio[5] > 0.3,
    `融合带首末桶差距 ${((ratio[0] - ratio[5]) * 100).toFixed(0)} 点（${pct}）—— 几乎没有渐变`);
  // ② 线性回归斜率必须为负（整体趋势下降）
  // ⚠️ **不要求逐桶单调**：齿会让相邻桶小幅反弹（实测 61→54→48→53→52→42 有两处 +5）。
  //    强行逐桶单调会把正确实现判 FAIL（实测过）。
  const xs = ratio.map((_, i) => i);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ratio.reduce((a, b) => a + b, 0) / ratio.length;
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ratio[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const slope = num / den;
  assertTrue(slope < -0.06,
    `融合带趋势斜率 ${slope.toFixed(3)} 不够负（${pct}）—— 冰比例没有随距离稳定下降`);
  // ③ 中段必须是混合态（不能是两条窄纯色带直接相接）
  const mid = (ratio[2] + ratio[3]) / 2;
  assertTrue(mid > 0.2 && mid < 0.8,
    `融合带中段冰比例 ${(mid * 100).toFixed(0)}% 不是混合态（${pct}）`);
});

test('台地：融合带宽度在 5~7 格（用户裁定）', () => {
  // ⚠️ 宽度本身也要钉住：融合带太窄就退回硬边界，太宽就把冰区吃光。
  assertTrue(TARN_BLEND_WIDTH >= 5 && TARN_BLEND_WIDTH <= 7,
    `融合带宽度 ${TARN_BLEND_WIDTH} 格不在用户裁定的 5~7 格范围内`);
});

test('台地：冰与雪**互相侵入对方地界**（不是一条夹在中间的中性带）', async () => {
  // ⚠️ **用户 2026-10-29 报告：「过渡带的意思是，他们之间的方块有一小部分侵入对方的地界」**。
  //
  // 上一版把融合带做成「一条夹在 b±3 之间的带，带内冰比例渐变」—— 这**不满足**要求：
  // 实测基准圆内侧 38 格内雪占 0.0%、外侧 50~72 格内冰占 0.0%（带外一刀切干净）。
  // 用户看到的就是「冰到雪直接跳、中间是一条干净的过渡线」。
  //
  // ✅ 正确判据 = **越过基准圆 44 去看两边深处有没有对方的方块**。
  // ⚠️ **不能用 `TARN_ICE_RADIUS + tarnIceWobbleAt()` 当参照**：边界本身带扰动后，
  //    「按扰动边界分纯区」会把侵入量恒算成 0（实测踩过）。必须用**固定的基准圆**。
  const { rx, rz } = findTarnRegion();
  const lay = computeTarnZone(rx, rz, SEED);
  const { cx, cz, platformRadius: flatR, plateauRadius: R } = lay;

  let iceZone = 0, iceZoneSnow = 0, snowZone = 0, snowZoneIce = 0;
  for (let dx = -80; dx <= 80; dx++) for (let dz = -80; dz <= 80; dz++) {
    const wx = cx + dx, wz = cz + dz;
    const d = Math.hypot(dx, dz);
    if (d > flatR) continue;
    const m = tarnSurfaceBlock(wx, wz, SEED, cx, cz, flatR, R);
    // 基准圆内侧 8 格以为「冰区深处」，外侧 8 格以外到雪环内为「雪区深处」
    // ⚠️ 参照带取 ±14（齿幅度 20 的一半 ≈ 10，再加 4 格余量）——
    //    取太近会落在齿的过渡区，取太远又会被雪环外缘的扰动影响。
    if (d < TARN_ICE_RADIUS - 14) { iceZone++; if (m === 'snow') iceZoneSnow++; }
    else if (d > TARN_ICE_RADIUS + 14 && d < TARN_SNOW_RADIUS) { snowZone++; if (m === 'ice') snowZoneIce++; }
  }
  assertTrue(iceZone > 1000 && snowZone > 1000, `采样太少（冰区 ${iceZone} / 雪区 ${snowZone}）`);
  const snowIntoIce = iceZoneSnow / iceZone;
  const iceIntoSnow = snowZoneIce / snowZone;

  // 两侧都要有侵入：各至少 2%（约 1/50 的格），且不能多到把对方吃掉（≤ 25%）
  assertTrue(snowIntoIce >= 0.02,
    `冰区深处的雪只占 ${(snowIntoIce * 100).toFixed(1)}% —— 雪没有侵入冰区（过渡带只夹在中间，没有双向渗透）`);
  assertTrue(iceIntoSnow >= 0.02,
    `雪区深处的冰只占 ${(iceIntoSnow * 100).toFixed(1)}% —— 冰没有侵入雪区`);
  assertTrue(snowIntoIce <= 0.25, `冰区深处的雪占 ${(snowIntoIce * 100).toFixed(1)}% —— 太多，冰区被吃掉了`);
  assertTrue(iceIntoSnow <= 0.25, `雪区深处的冰占 ${(iceIntoSnow * 100).toFixed(1)}% —— 太多，雪区被吃掉了`);
});

// ⚠️ **「草斑边界必须用 blobNoise（不可分离噪声）」这条在本文件里测不可靠，已移到
// `npm run check:data` 的 `[台地材质]` 静态门禁。**
//
// 原因（五版判据全部试过，都抓不住注入）：
//   ① 「最长水平/垂直同色段」—— 可分离噪声的等值线是**斜线**，垂直段只 2 格。
//   ② 「边界梯度是否轴向」—— 方向反了（blobNoise 反而更高）。
//   ③ 「逐行第一个边界的二阶差分（曲率）」—— 注入可分离噪声后曲率 **2.71**，
//      比正确实现 **1.23** 还高（斜线族的边界位置逐行跳变）⇒ 无判别力。
//   ④ 「梯度方向向量长度」—— 都被 0.12~0.16，区分不了。
//   ⑤ 「可分离性方差」—— 用**连续值**时差 31 个数量级（12.8 vs 1.6e-29），
//      但 `tarnSurfaceBlock` 只暴露**布尔**掩码，阈值化后两者变成 0.67 vs 0.24，
//      区分度不足以做可靠断言。
//
// ⇒ 可靠判据只能是「源码里用的是哪个函数」，那是静态门禁的职责（`check:data` 的 `[台地材质]`）。
//    该门禁已做负向验证：把 `blobNoise(` 换成 `noise(` 时真 FAIL。

test('台地：草斑带里浅色石 light_gray_cloth 成片出现（与 stone 弯曲相交）', async () => {
  // ⚠️ **用户 2026-10-29**：「地表的石头方块一部分替换成连成片的 light_stone，
  //    浅颜色的石头方块。他们之间的边界也不要是直线形状，也要是弯曲的相交」。
  //    「light_stone」= **`light_gray_cloth`**（用户后续指名）。
  //    实测贴图灰度均值 163（stone 125 / smooth_stone_1 156 / stone_diorite 188）。
  const { rx, rz } = findTarnRegion();
  const lay = computeTarnZone(rx, rz, SEED);
  const { cx, cz, platformRadius: flatR, plateauRadius: R } = lay;

  let light = 0, stone = 0;
  for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
    const d = Math.hypot(dx, dz);
    if (d < TARN_SNOW_RADIUS || d >= flatR) continue;
    const m = tarnSurfaceBlock(cx + dx, cz + dz, SEED, cx, cz, flatR, R);
    if (m === 'light_gray_cloth') light++;
    else if (m === 'stone') stone++;
  }
  assertTrue(light > 200, `草斑带里 light_gray_cloth 只有 ${light} 格（应成片出现）`);
  assertTrue(stone > 200, `草斑带里 stone 只有 ${stone} 格`);
  // 「连成片」：两种各自都要占石头总量的一定份额（不是零星点缀）
  const total = light + stone;
  assertTrue(light / total > 0.15,
    `light_gray_cloth 只占浅/深石头的 ${(light / total * 100).toFixed(0)}%（应 ≥15% 才是「成片」）`);
  assertTrue(stone / total > 0.15, `stone 只占 ${(stone / total * 100).toFixed(0)}%`);
});

test('台地：缓坡宽度与 tarn-zone 同源（两边不得各写一份）', () => {
  // ⚠️ 这条钉的是**红线 1**：`tarn-terrain.js` 从 `tarn-zone.js` import 坡宽（而不是自己写），
  // 因为 `isTarnZone` 的「核心沙漠占比」判据要采到平台边缘（= `TARN_ZONE_RADIUS - 坡宽`），
  // 两份漂移后同一个 region 会「判定时按 24 采样、整形时按 40 削坡」，抽中的地方一半是沙漠。
  assertEqual(TARN_SLOPE_WIDTH, TARN_ZONE_SLOPE_WIDTH, '两个模块导出的坡宽必须一致');
  const { rx, rz } = findTarnRegion();
  const lay = computeTarnZone(rx, rz, SEED);
  assertEqual(lay.slopeWidth, TARN_SLOPE_WIDTH, 'layout.slopeWidth 必须等于坡宽常量');
  assertEqual(lay.platformRadius + lay.slopeWidth, lay.plateauRadius,
    '平台半径 + 坡宽 必须等于地带半径');
});

test('台地：高度恒定（台地范围内地表高差 = 0）', async () => {
  const { rx, rz } = findTarnRegion();
  const lay = computeTarnZone(rx, rz, SEED);
  const reg = await buildDefaultRegistry();
  const heights = new Set();
  // ⚠️ v1.89：地带现在 = 内圈平台 + 外圈缓坡（过渡到自然地形）。
  // 「高度恒定」只对**平台内**成立 ⇒ 采样半径必须收在 `lay.platformRadius` 之内。
  // ⚠️ s1.90：不再从 `plateauRadius - TARN_SLOPE_WIDTH` 推导 —— 那个式子要求两个常量
  //    与 layout 字段三方对齐，其中一个（`poolRadius`）已删；直接用 layout 字段（单一权威）。
  const flatR = lay.platformRadius;
  for (let a = 0; a < 32; a++) {
    const ang = (a / 32) * Math.PI * 2;
    for (const r of [0, flatR * 0.25, flatR * 0.5, flatR * 0.75, flatR - 2]) {
      const wx = Math.round(lay.cx + r * Math.cos(ang));
      const wz = Math.round(lay.cz + r * Math.sin(ang));
      const { col, lx, lz } = await shapedColumn(lay, wx, wz, reg);
      let top = null;
      for (let y = 90; y >= -30; y--) {
        if (col.blocks[blockIndex(lx, y, lz)] !== 0) { top = y; break; }
      }
      if (top !== null) heights.add(top);
    }
  }
  assertEqual([...heights].join(','), String(lay.plateauY),
    `台地各采样点地表必须全等于 plateauY(${lay.plateauY})，实际 ${[...heights].join(',')}`);
});

test('台地：平台内无水，缓坡洼地会回填水（v1.91 修正口径）', async () => {
  // ⚠️ **口径在 v1.91 改了**（用户 2026-10-28 报告水 bug 后）：
  //
  // - **平台内**（d ≤ `platformRadius`）：地表恒为 `plateauY`（= SEA_Y+4 > SEA_Y）
  //   ⇒ 本就不可能有水，断言「全部无水」仍然成立且有意义（砦 v1.89 去掉中央水池）。
  // - **缓坡带**（`platformRadius < d ≤ plateauRadius`）：地表要线性过渡到自然地形，
  //   而周边地形有相当比例的洼地在海平面以下（实测 36.7% 的缓坡采样点自然高度 < SEA_Y）
  //   ⇒ **那里回填水是正确的**（与外围地图的水体连续），不能断言「整个圆无水」。
  //   旧断言把采样点放到 `plateauRadius - 4`（= 134，已在缓坡带上），
  //   回填后它会真 FAIL —— 那是旧断言错了，不是实现错了。
  const { rx, rz } = findTarnRegion();
  const lay = computeTarnZone(rx, rz, SEED);
  const reg = await buildDefaultRegistry();
  const waterId = reg.idOf('water');
  const waterLike = new Set([waterId, reg.idOf('swamp_water')].filter((x) => x !== undefined));
  let waterCells = 0, checked = 0;
  for (let a = 0; a < 24; a++) {
    const ang = (a / 24) * Math.PI * 2;
    // 只采平台内（半径全部 < platformRadius）
    for (const r of [0, 20, 45, 70, 100, lay.platformRadius - 4]) {
      const wx = Math.round(lay.cx + r * Math.cos(ang));
      const wz = Math.round(lay.cz + r * Math.sin(ang));
      const { col, lx, lz } = await shapedColumn(lay, wx, wz, reg);
      checked++;
      for (let y = -30; y <= 90; y++) {
        if (waterLike.has(col.blocks[blockIndex(lx, y, lz)])) waterCells++;
      }
    }
  }
  assertTrue(checked > 100, `采样点太少（${checked}）—— 本用例无判别力`);
  assertEqual(waterCells, 0, `平台内出现 ${waterCells} 格水（v1.89 起平台必须完全无水）`);
});

test('台地：边缘缓坡接续自然地形（缓坡带内逐格高差 ≤ 1）', async () => {
  // 平台半径 = `lay.platformRadius`；往外 `lay.slopeWidth` 格内线性过渡到自然地形。
  // 判据落在「缓坡带**内部**相邻列的高度差 ≤ 1」（玩家 MAX_STEP = 1.0）。
  //
  // ⚠️⚠️ **采样必须止于 `plateauRadius`，不能跨出去**（v1.90 实测踩坑）：
  //    地带圆外一律不整形，而自然地形本身在圆边缘可能有任意落差（实测 seed 12345 的一个
  //    地带圆边缘从 y=−13 直接跳到 y=−2，跳 11 格）。跨边界采样会把那一下算进「坡面」，
  //    得到的数字对「缓坡是否可走」毫无意义 —— 那是自然地形，不是缓坡。
  // ⚠️ 采样窗口按 `lay.platformRadius` / `lay.slopeWidth` 定长（旧版写死 60 格，
  //    缓坡缩到 24 后起点已钻进平台内，会把平坦平台的 0 高差也算进统计）。
  const { rx, rz } = findTarnRegion();
  const lay = computeTarnZone(rx, rz, SEED);
  const reg = await buildDefaultRegistry();
  let maxJump = 0, samples = 0;
  const from = lay.platformRadius - 4;              // 平台内 4 格起步（确保起点是平的）
  for (let a = 0; a < 24; a++) {
    const ang = (a / 24) * Math.PI * 2;
    const cos = Math.cos(ang), sin = Math.sin(ang);
    let prevY = null;
    for (let r = from; r <= lay.plateauRadius; r += 1) {
      const wx = Math.round(lay.cx + r * cos);
      const wz = Math.round(lay.cz + r * sin);
      // ⚠️ 逐格判半径：`Math.round` 会把点推到圆外，那一格不是缓坡。
      if (Math.hypot(wx - lay.cx, wz - lay.cz) > lay.plateauRadius) break;
      const { col, lx, lz } = await shapedColumn(lay, wx, wz, reg);
      let top = null;
      for (let y = 90; y >= -30; y--) {
        if (col.blocks[blockIndex(lx, y, lz)] !== 0) { top = y; break; }
      }
      if (top !== null && prevY !== null) {
        maxJump = Math.max(maxJump, Math.abs(top - prevY));
        samples++;
      }
      if (top !== null) prevY = top;
    }
  }
  assertTrue(samples > 200, `坡面采样点太少（${samples}）`);
  // 实测（seed 12345 在 ±6 的第一个地带）：缓坡带内逐格最大高差 = 1（完全可走）。
  // ⚠️ 上界不能用 2 或更大：`MAX_STEP = 1.0`，差 2 就是走不上去。
  assertTrue(maxJump <= 1, `缓坡带内逐格最大高差 ${maxJump} > 1 —— 玩家会被挡住（MAX_STEP=1）`);
});


test('台地：台地外的格不被整形（圆外零影响）', async () => {
  // ⚠️ **必须取「部分在圆内、部分在圆外」的边缘 column**：
  // 若取「整列都在圆外」的 column，`fillTarnPlateau` 在外接方形求交时就已经
  // `x0 > x1` 提前 return，根本进不了循环 —— 那种用例即使删掉循环体里的
  // `d2 > platR2 continue` 也测不出差异（负向验证实测：删掉后该用例照样绿）。
  const { rx, rz } = findTarnRegion();
  const lay = computeTarnZone(rx, rz, SEED);
  const reg = await buildDefaultRegistry();
  // 地带圆边缘（半径附近）的 column：列内既有圆内格也有圆外格。
  // ⚠️ **v1.90 从「半径 − 4 的单个点」改为实时筛**：旧写法假设那个点所在的 column
  //    恰好被圆切开 —— 而那依赖地带半径与圆心的具体字节，实测新半径（138）下它整列都在圆内。
  //    现在扫圆心周围的 column，取第一个「0 < 圆内格 < 256」的（实测有 66 个可选）。
  let edge = null;
  for (let dcx = -12; dcx <= 12 && !edge; dcx++) {
    for (let dcz = -12; dcz <= 12 && !edge; dcz++) {
      const tcx = Math.floor(lay.cx / 16) + dcx, tcz = Math.floor(lay.cz / 16) + dcz;
      let inside = 0;
      for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
        const px = tcx * 16 + lx, pz = tcz * 16 + lz;
        if (Math.hypot(px - lay.cx, pz - lay.cz) <= lay.plateauRadius) inside++;
      }
      if (inside > 0 && inside < 256) edge = { cx: tcx, cz: tcz };
    }
  }
  assertTrue(edge !== null, '找不到「部分在圆内、部分在圆外」的 column —— 木地半径或列尺寸变了，须重新标定');
  const cx = edge.cx, cz = edge.cz;
  const before = new ChunkColumn(cx, cz);
  fillColumn(before, SEED, reg);
  const after = new ChunkColumn(cx, cz);
  fillColumn(after, SEED, reg);
  fillTarnPlateau(after, lay, SEED, reg);

  let insideCount = 0, outsideChanged = 0;
  for (let lx = 0; lx < 16; lx++) {
    for (let lz = 0; lz < 16; lz++) {
      const X = cx * 16 + lx, Z = cz * 16 + lz;
      const inside = Math.hypot(X - lay.cx, Z - lay.cz) <= lay.plateauRadius;
      if (inside) { insideCount++; continue; }
      // 圆外：逐格（逐 y）必须与整形前完全相同
      for (let y = -30; y <= 90; y++) {
        const idx = blockIndex(lx, y, lz);
        if (after.blocks[idx] !== before.blocks[idx]) outsideChanged++;
      }
    }
  }
  assertTrue(insideCount > 0 && insideCount < 256,
    `该边缘 column 必须部分在圆内部分在圆外（实测圆内 ${insideCount}/256），否则本用例无判别力`);
  assertEqual(outsideChanged, 0, `圆外格被整形了 ${outsideChanged} 处（应为 0）`);
});

test('台地：整形后地表低于海平面的列必须回填水（v1.91 修 bug）', async () => {
  // ⚠️ **这是用户 2026-10-28 报告的缺陷**：「高台地带和外围地图接壤的部分，如果有共享的水池，
  //    则原有的水方块并未在高台地带延伸过来的水下区域填充水方块」。
  //
  // 根因：`fillTarnPlateau` 的削平循环把 `targetY` 以上全写成 0（含原有水体），
  // 而随后的「向下填实」**只写 stone、从不写 water** —— 于是缓坡带里 `targetY < SEA_Y`
  // 的列就变成了「低于海平面的干坑」（周边原有的水被清掉且没补回来）。
  // 实测 seed 12345 的一座地带：圆内 **3251 列**成干坑、原有的 **148012** 格水全被清掉。
  //
  // 判据 = 「地表低于海平面的列，从地表之上到 SEA_Y 必须全是水」（与 `fillColumn`
  // 的水面填充同口径：`(h, SEA_Y]`）。
  const { rx, rz } = findTarnRegion();
  const lay = computeTarnZone(rx, rz, SEED);
  const reg = await buildDefaultRegistry();
  const waterId = reg.idOf('water');
  const { SEA_Y } = await import('../voxel/constants.js');

  let pitCols = 0, filledOk = 0, failed = 0;
  const examples = [];
  const R = lay.plateauRadius;
  const minCx = Math.floor((lay.cx - R) / 16), maxCx = Math.floor((lay.cx + R) / 16);
  const minCz = Math.floor((lay.cz - R) / 16), maxCz = Math.floor((lay.cz + R) / 16);
  for (let cx = minCx; cx <= maxCx; cx++) for (let cz = minCz; cz <= maxCz; cz++) {
    const col = new ChunkColumn(cx, cz);
    fillColumn(col, SEED, reg);
    fillTarnPlateau(col, lay, SEED, reg);
    for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
      const wx = cx * 16 + lx, wz = cz * 16 + lz;
      if (Math.hypot(wx - lay.cx, wz - lay.cz) > R) continue;
      let top = null;
      for (let y = 95; y >= -31; y--) {
        if (col.blocks[blockIndex(lx, y, lz)] !== 0) { top = y; break; }
      }
      if (top === null) continue;
      // ⚠️ **修后「地表低于海平面」的列会是 0**：水已经被填到 SEA_Y，
      //    所以 `top`（顶层非空方块的 y）就是 SEA_Y 的水面。
      //    判据因此要改成「地表（去掉水后的陆地顶）低于 SEA_Y 的列，水上那一段必须是水」——
      //    否则修好了反而测不出东西（旧写法在修后变成恒真空断言，实测报了 0 个洼地）。
      // 先找陆地顶（跳过水）
      let landTop = null;
      for (let y = top; y >= -31; y--) {
        const b = col.blocks[blockIndex(lx, y, lz)];
        if (b !== 0 && b !== waterId) { landTop = y; break; }
      }
      if (landTop === null || landTop >= SEA_Y) continue;   // 只看陆地顶低于海平面的洼地
      pitCols++;
      let ok = true;
      for (let y = landTop + 1; y <= SEA_Y; y++) {
        if (col.blocks[blockIndex(lx, y, lz)] !== waterId) { ok = false; break; }
      }
      if (ok) filledOk++;
      else {
        failed++;
        if (examples.length < 5) examples.push(`(${wx},${wz}) landTop=${landTop} top=${top}`);
      }
    }
  }
  // 先确认用例真的有判别力：地带里必须存在低于海平面的洼地
  assertTrue(pitCols > 100,
    `地带内低于海平面的列只有 ${pitCols} 个 —— 本用例无判别力（地形变了？）`);
  assertEqual(failed, 0,
    `${pitCols} 个洼地列里有 ${failed} 列没回填水（应为 0）：${examples.join(' ')}`);
  assertEqual(filledOk, pitCols, '所有低于海平面的列都必须填满水');
});

test('台地：高于 plateauY 的原山体被削平（不是「台地长在山里」）', async () => {
  const { rx, rz } = findTarnRegion();
  const lay = computeTarnZone(rx, rz, SEED);
  const reg = await buildDefaultRegistry();
  // 找一个自然地形明显高于 plateauY 的采样点（这样「没削山」才有可观测差异）
  // ⚠️ s1.90：基准从 `poolRadius`（已删）改为 `platformRadius`。采样点必须落在**缓坡带上**
  //    （平台内是恒平的，看不到「原山体」）—— 缓坡带 = `(platformRadius, plateauRadius]`，
  //    取带内两个位置，且都在圆内（圆外不动，本用例就无判别力）。
  let found = null;
  for (let a = 0; a < 16 && !found; a++) {
    const ang = (a / 16) * Math.PI * 2;
    for (const r of [lay.platformRadius + 6, lay.platformRadius + 14]) {
      const wx = Math.round(lay.cx + r * Math.cos(ang));
      const wz = Math.round(lay.cz + r * Math.sin(ang));
      const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
      const probe = new ChunkColumn(cx, cz);
      fillColumn(probe, SEED, reg);
      let top = null;
      for (let y = 90; y >= -30; y--) {
        if (probe.blocks[blockIndex(wx - cx * 16, y, wz - cz * 16)] !== 0) { top = y; break; }
      }
      if (top !== null && top > lay.plateauY) { found = { wx, wz, top }; break; }
    }
  }
  assertTrue(found !== null,
    '必须存在「自然地形高于 plateauY」的台地采样点，否则本用例没有判别力');
  const { col, lx, lz } = await shapedColumn(lay, found.wx, found.wz, reg);
  // 整形后该列的目标高度之上不得有方块。
  // ⚠️ **s1.90：采样点在缓坡带上，目标高度不再是 `plateauY`**（那里是插值到自然高度的过渡值），
  //    所以判据用「该列整形后的地表 = 什么」，而不是硬拿 `plateauY` 比 ——
  //    否则缓坡带上的正确定形反而会被判 FAIL。真正要钉的是「原山体被削掉」。
  let shapedTop = null;
  for (let y = 90; y >= -30; y--) {
    if (col.blocks[blockIndex(lx, y, lz)] !== 0) { shapedTop = y; break; }
  }
  assertTrue(shapedTop !== null, '整形后该列必须有地表');
  assertTrue(shapedTop < found.top,
    `原山体（自然顶 y=${found.top}）没有被削平（整形后顶仍是 y=${shapedTop}）`);
  for (let y = shapedTop + 1; y <= 90; y++) {
    assertEqual(col.blocks[blockIndex(lx, y, lz)], 0, `整形后顶面之上还有方块（y=${y}）`);
  }
});
