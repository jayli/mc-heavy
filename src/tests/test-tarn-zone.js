// src/tests/test-tarn-zone.js — 高台地带 Tier 1：判定 / 环形布局 / 间距 / 装饰落位
//
// 钉的是「改坏了会静默产出一个错误但看起来正常的地带」这几类缺陷：
//   · 地带跨 region 边界 → 相邻 region 不为它算候选 ⇒ 地带半边永久消失
//   · 抖动过大 → 相邻高台贴在一起（水池里两块台子糊成一坨）
//   · 装饰件叠在高台上 → 拱洞穿进台身
//   · CITY_REGION 掷到地带 → 全世界唯一的城市消失
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse } from './assert.js';
import {
  isTarnZone, tarnZoneCenter, computeTarnZone, aabbGap,
  TARN_ZONE_RADIUS, TARN_POOL_RADIUS, TARN_ZONE_CHANCE, TARN_GAP, TARN_KEPT_TARN_IDS,
  TARN_PLATEAU_Y,
} from '../gen/structures/tarn-zone.js';
import { KIT_VARIANTS, KIT_METRICS } from '../gen/structures/cloudland-kit-data.js';
import { REGION_SIZE, CITY_REGION } from '../gen/structures/region-config.js';

const SEED = 12345;

test('地带判定：同一 seed 同一 region 两次调用结果相同', () => {
  for (const [rx, rz] of [[0, 0], [1, 0], [3, -2], [-4, 5]]) {
    assertEqual(isTarnZone(rx, rz, SEED), isTarnZone(rx, rz, SEED), `region(${rx},${rz}) 稳定`);
  }
});

test('地带判定：CITY_REGION 永远不是地带（城市是全世界唯一地标）', () => {
  for (const seed of [12345, 424242, 777, 2024, 1, 2, 3]) {
    assertFalse(isTarnZone(CITY_REGION.X, CITY_REGION.Z, seed),
      `seed ${seed} 的 CITY_REGION 不得是地带`);
  }
});

// ⚠️ **为什么用 ±20 窗口而不是 ±6**（实测裁定，2026-10-26）：
//    密度判据是「粗格哈希通过率 ≈ 1/3」。n 个独立样本下 ratio 的标准差 σ = √(p(1−p)/n)：
//      ±6 窗口 → n = 169 → σ = 0.0363 ⇒ 0.05 容差只等于 **1.38σ**，**理论误报率 16.2%**；
//      ±20 窗口 → n = 1681 → σ = 0.0115 ⇒ 0.05 容差 = **4.35σ**，误报率 ≈ 0。
//    实测佐证：±6 下 204 个 seed 里有若干超出 0.05（seed 12345 实测 **0.2189**，偏差 0.1144
//    = 3.15σ），而 ±20 下 **204/204 全部 < 0.05**（最大偏差 0.0347）。
//    ⇒ ±6 的 0.05 容差是个**统计上无效的判据**（正确实现也有 16% 概率误报），精确判据用 ±20。
//    ⚠️ 判别力没有损失（实测）：chance 误写成 0.25 → ±20 偏差 0.1025；0.3 → 0.0525；0.5 → 0.1467，
//       三档都远超 0.05；±6 同口径分别是 0.1499 / 0.1262 / 0.0631（0.5 那一档反而更弱）。
//    ±6 另留一条**宽松带**只防「密度完全跑飞」（chance 写成 0 或 1 这类），不做精确判据。
test('地带判定：密度落在 1/3 附近（±20 窗口，4.35σ）', () => {
  let hits = 0, total = 0;
  for (let rx = -20; rx <= 20; rx++) for (let rz = -20; rz <= 20; rz++) {
    total++;
    if (isTarnZone(rx, rz, SEED)) hits++;
  }
  const ratio = hits / total;
  assertTrue(Math.abs(ratio - TARN_ZONE_CHANCE) < 0.05,
    `密度 ${ratio.toFixed(3)} 应接近 ${TARN_ZONE_CHANCE.toFixed(3)}（${hits}/${total}）`);
});

// ⚠️ 宽松带 **实测标定**，不是拍脑袋：±6 窗口（n=169）在 204 个 seed 上的 ratio 实测区间是
//    **[0.2189, 0.4260]**（均值 0.3307）。带宽取 [0.15, 0.52] ⇒ 两端各留 ~0.07/0.09 余量，
//    能包住实测全域，同时 chance 一旦被写成 0.25（实测 ratio 0.1834）或 0.5（0.3964）时
//    **这一条可能放过** —— 那是刻意的：精确判据在 ±20 那条，这一条只防「完全跑飞」。
test('地带判定：±6 窗口的密度落在宽松带内（防「完全跑飞」）', () => {
  let hits = 0, total = 0;
  for (let rx = -6; rx <= 6; rx++) for (let rz = -6; rz <= 6; rz++) {
    total++;
    if (isTarnZone(rx, rz, SEED)) hits++;
  }
  const ratio = hits / total;
  assertTrue(ratio >= 0.15 && ratio <= 0.52,
    `±6 密度 ${ratio.toFixed(3)} 超出宽松带 [0.15, 0.52]（${hits}/${total}）—— 判定可能完全跑飞`);
});

test('地带中心 = region 中心', () => {
  for (const [rx, rz] of [[1, 0], [-2, 3]]) {
    const c = tarnZoneCenter(rx, rz);
    assertEqual(c.cx, rx * REGION_SIZE + REGION_SIZE / 2, 'cx');
    assertEqual(c.cz, rz * REGION_SIZE + REGION_SIZE / 2, 'cz');
  }
});

test('地带半径不越 region 边界（否则半边永久消失）', () => {
  assertTrue(TARN_ZONE_RADIUS + 2 <= REGION_SIZE / 2,
    `TARN_ZONE_RADIUS(${TARN_ZONE_RADIUS}) + 2 必须 <= ${REGION_SIZE / 2}`);
  assertTrue(TARN_POOL_RADIUS < TARN_ZONE_RADIUS, '水池必须在地带圆内');
});

test('保留的高台组合是 8 个不同的产物基名', () => {
  assertEqual(TARN_KEPT_TARN_IDS.length, 8, '保留座数');
  assertEqual(new Set(TARN_KEPT_TARN_IDS).size, 8, '不得重复');
});

// ==================== 环形布局 ====================
//
// ⚠️ KIT_* 从 src/ 的**纯数据**模块 import，不从 tools/ —— 后者依赖 node:fs，浏览器里解析失败。

/** 找一个确实发生在地带上的 region（按 seed 确定性搜） */
function findTarnRegion(seed) {
  for (let rx = -6; rx <= 6; rx++) for (let rz = -6; rz <= 6; rz++) {
    if (isTarnZone(rx, rz, seed)) return { rx, rz };
  }
  throw new Error('没找到地带 region —— 判定实现有问题');
}

test('地带布局：保留的 8 座高台全都在（不重不漏）', () => {
  const { rx, rz } = findTarnRegion(SEED);
  const lay = computeTarnZone(rx, rz, SEED);
  assertTrue(lay !== null, '地带 region 必须有布局');
  assertEqual(lay.tarns.length, 8, '高台数（spec DR-5f：8 座）');
  const variants = new Set(lay.tarns.map((t) => t.variant));
  assertEqual(variants.size, 8, '8 座必须是 8 个不同变体（不重复）');
  for (const id of TARN_KEPT_TARN_IDS) {
    assertTrue(variants.has(id), `${id} 必须在布局里`);
  }
});

test('地带布局：非地带 region 返回 null', () => {
  let found = null;
  for (let rx = -6; rx <= 6 && !found; rx++) for (let rz = -6; rz <= 6 && !found; rz++) {
    if (!isTarnZone(rx, rz, SEED)) found = { rx, rz };
  }
  assertTrue(found !== null, '必然存在非地带 region');
  assertEqual(computeTarnZone(found.rx, found.rz, SEED), null, '非地带必须返回 null');
});

test('地带布局：每座高台的四角落在水池内（轴对齐，逐角算）', () => {
  const { rx, rz } = findTarnRegion(SEED);
  const lay = computeTarnZone(rx, rz, SEED);
  for (const t of lay.tarns) {
    // ⚠️ **必须逐角算**（spec DR-7）：轴对齐矩形的最远点是四个角之一，不是边中点。
    //    两个常见错误口径：
    //    · ring + halfX + halfZ —— 把两个半宽相加，每座多算 10~34 格；
    //    · ring + min(halfX, halfZ) —— 那是边中点，实测 L3 角比边中点远 8.9 格
    //      （88.88 vs 80.0），会让高台伸出池外而断言全绿。
    const cx = t.ring * Math.cos(t.ang), cz = t.ring * Math.sin(t.ang);
    let maxReach = 0;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      maxReach = Math.max(maxReach, Math.hypot(cx + sx * t.halfX, cz + sz * t.halfZ));
    }
    assertTrue(maxReach <= lay.poolRadius,
      `${t.variant} 四角最远 ${maxReach.toFixed(1)} > 池半径 ${lay.poolRadius}`);
  }
});

test('地带布局：halfX/halfZ 是世界轴半宽（= width/2 / depth/2，与环上角度无关）', () => {
  const { rx, rz } = findTarnRegion(SEED);
  const lay = computeTarnZone(rx, rz, SEED);
  for (const t of lay.tarns) {
    const m = KIT_METRICS[t.variant];
    assertEqual(t.halfX, m.width / 2, `${t.variant} halfX 必须是 width/2`);
    assertEqual(t.halfZ, m.depth / 2, `${t.variant} halfZ 必须是 depth/2`);
    // ⚠️ 旋转假设的残留字段必须不存在（spec DR-7 致命 1′）
    assertFalse('radialHalf' in t, `${t.variant} 不得有 radialHalf（旋转假设已否决）`);
    assertFalse('tangentialHalf' in t, `${t.variant} 不得有 tangentialHalf`);
    assertFalse('orientation' in t, `${t.variant} 不得有 orientation（轴对齐不旋转）`);
  }
});

test('地带布局：相邻高台 AABB 真实间距 >= TARN_GAP（含抖动）', () => {
  const { rx, rz } = findTarnRegion(SEED);
  const lay = computeTarnZone(rx, rz, SEED);
  const n = lay.tarns.length;
  for (let i = 0; i < n; i++) {
    const a = lay.tarns[i], b = lay.tarns[(i + 1) % n];
    // ⚠️ 间距口径唯一：`aabbGap`（轴对齐 AABB 真实最短距离）。
    //    不要用 chord − halfX − halfZ 这类「弦长减半宽」的旧口径 —— 那是旋转假设下的近似，
    //    轴对齐下会高估间距（历史文档里的 10.87 / 16.08 / 18.40 全部作废）。
    const gap = aabbGap(
      { cx: a.ring * Math.cos(a.ang), cz: a.ring * Math.sin(a.ang), halfX: a.halfX, halfZ: a.halfZ },
      { cx: b.ring * Math.cos(b.ang), cz: b.ring * Math.sin(b.ang), halfX: b.halfX, halfZ: b.halfZ },
    );
    assertTrue(gap >= TARN_GAP,
      `${a.variant}↔${b.variant} AABB 间距 ${gap.toFixed(2)} < ${TARN_GAP}`);
  }
});

test('地带布局：任意两座高台都不重叠（不只相邻）', () => {
  const { rx, rz } = findTarnRegion(SEED);
  const lay = computeTarnZone(rx, rz, SEED);
  const n = lay.tarns.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = lay.tarns[i], b = lay.tarns[j];
      const gap = aabbGap(
        { cx: a.ring * Math.cos(a.ang), cz: a.ring * Math.sin(a.ang), halfX: a.halfX, halfZ: a.halfZ },
        { cx: b.ring * Math.cos(b.ang), cz: b.ring * Math.sin(b.ang), halfX: b.halfX, halfZ: b.halfZ },
      );
      assertTrue(gap > 0, `${a.variant} 与 ${b.variant} 重叠（gap ${gap.toFixed(2)}）`);
    }
  }
});

test('地带布局：跨 region / 跨 seed 都满足间距（抖动是逐 region 抽签的）', () => {
  for (const seed of [SEED, 424242, 777, 2024, 1]) {
    for (let rx = -4; rx <= 4; rx++) for (let rz = -4; rz <= 4; rz++) {
      const lay = computeTarnZone(rx, rz, seed);
      if (!lay) continue;
      const n = lay.tarns.length;
      for (let i = 0; i < n; i++) {
        const a = lay.tarns[i], b = lay.tarns[(i + 1) % n];
        const gap = aabbGap(
          { cx: a.ring * Math.cos(a.ang), cz: a.ring * Math.sin(a.ang), halfX: a.halfX, halfZ: a.halfZ },
          { cx: b.ring * Math.cos(b.ang), cz: b.ring * Math.sin(b.ang), halfX: b.halfX, halfZ: b.halfZ },
        );
        assertTrue(gap >= TARN_GAP,
          `seed ${seed} region(${rx},${rz}) ${a.variant}↔${b.variant} 间距 ${gap.toFixed(2)} < ${TARN_GAP}`);
      }
    }
  }
});

test('地带布局：12 个装饰件全在（5 拱洞 + 7 紫晶柱）且在正确区域', () => {
  const { rx, rz } = findTarnRegion(SEED);
  const lay = computeTarnZone(rx, rz, SEED);
  const arches = lay.decos.filter((d) => d.kind === 'arch');
  const spires = lay.decos.filter((d) => d.kind === 'spire');
  assertEqual(arches.length, 5, '拱洞数');
  assertEqual(spires.length, 7, '紫晶柱数');
  // 拱洞在**池外台地**（池半径之外、地带圆之内）
  for (const a of arches) {
    assertTrue(a.ring > lay.poolRadius, `拱洞 ${a.variant} 必须在池外（ring ${a.ring} <= ${lay.poolRadius}）`);
    const maxHalf = Math.max(a.halfX, a.halfZ);
    assertTrue(a.ring + maxHalf <= TARN_ZONE_RADIUS,
      `拱洞 ${a.variant} 压出地带边缘（${(a.ring + maxHalf).toFixed(1)} > ${TARN_ZONE_RADIUS}）`);
  }
  // 紫晶柱在**池内**
  for (const sp of spires) {
    assertTrue(sp.ring < lay.poolRadius, `紫晶柱 ${sp.variant} 必须在池内（ring ${sp.ring} >= ${lay.poolRadius}）`);
  }
});

test('地带布局：装饰件不与任何高台/彼此重叠（轴对齐 AABB）', () => {
  const { rx, rz } = findTarnRegion(SEED);
  const lay = computeTarnZone(rx, rz, SEED);
  // ⚠️ **轴对齐下就是逐轴比较，不需要 SAT**（原稿的 rotatedRectsOverlap 是旋转假设的残留）。
  //    ⚠️ 也不要用外接圆近似：它会把「实际不重叠」判成重叠（假失败）。
  const rects = [
    ...lay.tarns.map((t) => ({
      kind: 'tarn', id: t.variant, cx: t.ring * Math.cos(t.ang), cz: t.ring * Math.sin(t.ang),
      halfX: t.halfX, halfZ: t.halfZ,
    })),
    ...lay.decos.map((d) => ({
      kind: d.kind, id: d.variant, cx: d.ring * Math.cos(d.ang), cz: d.ring * Math.sin(d.ang),
      halfX: d.halfX, halfZ: d.halfZ,
    })),
  ];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      assertTrue(aabbGap(rects[i], rects[j]) > 0,
        `${rects[i].kind}/${rects[i].id} 与 ${rects[j].kind}/${rects[j].id} 重叠`);
    }
  }
});

test('地带布局：4 朵巨型云，且全在地带圆内', () => {
  const { rx, rz } = findTarnRegion(SEED);
  const lay = computeTarnZone(rx, rz, SEED);
  assertEqual(lay.clouds.length, 4, '云数');
  for (const c of lay.clouds) {
    assertTrue(c.ring <= TARN_ZONE_RADIUS, `云环半径 ${c.ring} 超出地带半径`);
    assertTrue(KIT_VARIANTS.giantCloud.includes(c.variant), `${c.variant} 必须是巨型云变体`);
  }
});

test('地带布局：4 朵云是 4 个不同变体，且取自最大的 6 个', () => {
  const { rx, rz } = findTarnRegion(SEED);
  const lay = computeTarnZone(rx, rz, SEED);
  assertEqual(new Set(lay.clouds.map((c) => c.variant)).size, 4, '云不得重复');
  // spec DR-10：12 个云按格数降序取**前 6 大**再抽 4 个（太小的 60/121/436 格云无视觉意义）
  const biggest6 = new Set(
    KIT_VARIANTS.giantCloud
      .map((id) => ({ id, blocks: KIT_METRICS[id].blocks }))
      .sort((a, b) => b.blocks - a.blocks)
      .slice(0, 6)
      .map((v) => v.id),
  );
  for (const c of lay.clouds) {
    assertTrue(biggest6.has(c.variant), `${c.variant} 不在前 6 大里（spec DR-10）`);
  }
});

test('地带布局：plateauY / 半径 / 中心与常量一致', () => {
  const { rx, rz } = findTarnRegion(SEED);
  const lay = computeTarnZone(rx, rz, SEED);
  const c = tarnZoneCenter(rx, rz);
  assertEqual(lay.cx, c.cx, 'cx');
  assertEqual(lay.cz, c.cz, 'cz');
  assertEqual(lay.poolRadius, TARN_POOL_RADIUS, 'poolRadius');
  // ⚠️ plateauY 由本函数定义（几何常量，Task 4/5/6 全读它）
  assertEqual(lay.plateauY, TARN_PLATEAU_Y, 'plateauY = SEA_Y + 4 = 2');
  assertEqual(lay.plateauRadius, TARN_ZONE_RADIUS, 'plateauRadius = 地带半径');
});

test('地带布局：确定性 —— 同一 (region, seed) 两次调用逐值相同', () => {
  const { rx, rz } = findTarnRegion(SEED);
  const a = computeTarnZone(rx, rz, SEED);
  const b = computeTarnZone(rx, rz, SEED);
  assertEqual(JSON.stringify(a), JSON.stringify(b), '布局必须是纯函数');
});

test('地带布局：抖动真的在起作用（不是全零，否则退化成机械等距）', () => {
  const { rx, rz } = findTarnRegion(SEED);
  const lay = computeTarnZone(rx, rz, SEED);
  // 相邻角差（含缝角）应当**不完全相同** —— 无抖动时它们会逐位相等
  const deltas = [];
  for (let i = 0; i < lay.tarns.length; i++) {
    const a = lay.tarns[i].ang, b = lay.tarns[(i + 1) % lay.tarns.length].ang;
    deltas.push(((b - a) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI));
  }
  // 8 座的高台半宽不同，占角不同 ⇒ 角差不该全等；抖动再拉开一点。
  // 严格的「抖动非零」判据落在 jitterMax > 0 与 computeTarnZone 的跨 region 差异上。
  const uniq = new Set(deltas.map((d) => d.toFixed(9)));
  assertTrue(uniq.size >= 7, `相邻角差只有 ${uniq.size} 种取值 —— 布局可能退化成机械等距`);
});

test('地带布局：不同 region 的抖动不同（逐 region 抽签，不是全局固定）', () => {
  const regions = [];
  for (let rx = -6; rx <= 6; rx++) for (let rz = -6; rz <= 6; rz++) {
    const lay = computeTarnZone(rx, rz, SEED);
    if (lay) regions.push(lay);
    if (regions.length >= 4) break;
  }
  assertTrue(regions.length >= 4, '至少要找到 4 个地带 region');
  const sigs = new Set(regions.map((l) => l.tarns.map((t) => t.ang.toFixed(9)).join(',')));
  assertTrue(sigs.size >= 3, `4 个地带的角布置只有 ${sigs.size} 种 —— 抖动没有按 region 变化`);
});
