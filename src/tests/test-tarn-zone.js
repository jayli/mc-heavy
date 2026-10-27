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
  isTarnZone, tarnZoneCenter, computeTarnZone, aabbGap, snowLandSuppressedByTarn,
  TARN_ZONE_RADIUS, TARN_POOL_RADIUS, TARN_ZONE_CHANCE, TARN_GAP, TARN_KEPT_TARN_IDS,
  TARN_PLATEAU_Y,
} from '../gen/structures/tarn-zone.js';
import { KIT_VARIANTS, KIT_METRICS } from '../gen/structures/cloudland-kit-data.js';
import {
  REGION_SIZE, CITY_REGION, SNOW_LAND_SIZE, TRANSITION_SIZE, LANDMARK_OFFSET,
} from '../gen/structures/region-config.js';
// ⚠️ 雪原中心必须与 `structure-layout.js` 同一推导（原始中心 + 偏移，未 clamp）。
// 交叉验证用例要「不同源」，指的是**几何算法**不同源；中心点的推导必须同源，
// 否则测的就不是同一个雪原。
import { getRegionSeededCenter } from '../gen/structures/region-center.js';
// ⚠️ `SEA_Y` 无 three / 无 DOM，浏览器可用（`giant-trees.js:18` 同先例）。
// 这是 `plateauY` 断言**具备判别力**的前提：断言必须拿一个与 `TARN_PLATEAU_Y` **不同源**的
// 参照值，否则两边一起改、用例恒真。
import { SEA_Y } from '../voxel/constants.js';
// 接线用例（Task 3b）：layout 压制与零回归。对照侧直接调用候选函数 —— 与 layout 内部
// **同一份实现**，所以那些断言钉的是「layout 有没有把它传下去 / 有没有多压一层」。
import { computeRegionLayout, neighborRegionKeys } from '../gen/structures/structure-layout.js';
import { computeMesaAnchor } from '../gen/structures/mesa.js';
import { computeGiantPyramidAnchor } from '../gen/structures/giant-pyramid.js';
import { computeSkyCandidates } from '../gen/structures/sky-structures.js';
// apply 阶段 1 跳过门的接线用例：真实 GEN 路径（与 Worker 同源）
import { applyStructuresToColumn } from '../gen/structures/apply.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';

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
  // 拱洞在**池外台地**（池半径之外、地带圆之内）。
  // ⚠️ **必须逐角算**（spec DR-8）：轴对齐矩形离池心的最近点是四角之一（不是边中点），
  //    只判 `a.ring > poolRadius` 是常数比较（125 > 90 恒真），拓不到「落台地区间外」这类缺陷。
  for (const a of arches) {
    const acx = a.ring * Math.cos(a.ang), acz = a.ring * Math.sin(a.ang);
    let nearCorner = Infinity, farCorner = 0;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const r = Math.hypot(acx + sx * a.halfX, acz + sz * a.halfZ);
      nearCorner = Math.min(nearCorner, r);
      farCorner = Math.max(farCorner, r);
    }
    assertTrue(nearCorner > lay.poolRadius,
      `拱洞 ${a.variant} 最近角 ${nearCorner.toFixed(2)} 压进水池（必须 > ${lay.poolRadius}）`);
    assertTrue(farCorner < TARN_ZONE_RADIUS,
      `拱洞 ${a.variant} 最远角 ${farCorner.toFixed(2)} 压出地带边缘（必须 < ${TARN_ZONE_RADIUS}）`);
  }
  // 紫晶柱在**池内**（同样逐角：最远角必须还在池半径内）
  for (const sp of spires) {
    const scx = sp.ring * Math.cos(sp.ang), scz = sp.ring * Math.sin(sp.ang);
    let farCorner = 0;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      farCorner = Math.max(farCorner, Math.hypot(scx + sx * sp.halfX, scz + sz * sp.halfZ));
    }
    assertTrue(farCorner < lay.poolRadius,
      `紫晶柱 ${sp.variant} 最远角 ${farCorner.toFixed(2)} 出池（必须 < ${lay.poolRadius}）`);
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
  // ⚠️ **必须拿 `SEA_Y + 4` 作参照，不能写 `assertEqual(lay.plateauY, TARN_PLATEAU_Y)`**：
  //    两边同源（`TARN_PLATEAU_Y` 是 `computeTarnZone` 的直接输入）→ 改常量时断言跟着变，
  //    恒真。而 Task 4/5/6 会读到一个错的高度，形态是「水漫过台地」或「台地浮在水面上」，
  //    **方块层面看不出那是高度常量错了**。
  assertEqual(TARN_PLATEAU_Y, SEA_Y + 4, 'TARN_PLATEAU_Y 必须 = SEA_Y + 4');
  assertEqual(lay.plateauY, SEA_Y + 4, 'layout.plateauY 必须 = SEA_Y + 4');
  assertEqual(lay.plateauRadius, TARN_ZONE_RADIUS, 'plateauRadius = 地带半径');
});

test('地带布局：确定性 —— 同一 (region, seed) 两次调用逐值相同', () => {
  const { rx, rz } = findTarnRegion(SEED);
  const a = computeTarnZone(rx, rz, SEED);
  const b = computeTarnZone(rx, rz, SEED);
  assertEqual(JSON.stringify(a), JSON.stringify(b), '布局必须是纯函数');
});

test('地带布局：抖动真的在起作用（跨 seed / 跨 region 的角布置不同）', () => {
  // ❌ **旧版断言是空断言（已被评审拓出，勿恢复）**：
  //    旧版算 8 个相邻角差后断言 `new Set(...).size >= 7`。但 8 座的 `occ` 本来就全都不同
  //    （48.89/40.34/36.16/36.16/24.89/20.86/17.85/12.87°）+ 15.25° 缝角 ⇒ 无抖动时相邻角差
  //    就是 8 个互不相同的值（59.86/53.50/51.41/45.77/38.12/34.60/30.61/46.12°）。实测
  //    `uniq.size = 8` **恒成立** ⇒ 注入 `JITTER_SAFETY_RATIO=0`（全零抖动）时它仍然 pass。
  //
  // ✅ 现行判据：**跨 seed / 跨 region 的角布置必须不同** —— 零抖动时两次调用会逐位相同。
  //    实测：正常态跨 3 seed 最大偏差 **2.508e-2 rad**；注入 `RATIO=0` 时**精确为 0**。
  //
  // ⚠️ 取样坐标必须属于**三个 seed 的交集**（否则 `computeTarnZone` 返回 null）。
  //    实测 seed {12345, 424242, 777} 的地带交集里包含 region(4,4)。
  const SHARED_REGION = { rx: 4, rz: 4 };
  const SEED_LIST = [SEED, 424242, 777];
  for (const s of SEED_LIST) {
    assertTrue(isTarnZone(SHARED_REGION.rx, SHARED_REGION.rz, s),
      `region(${SHARED_REGION.rx},${SHARED_REGION.rz}) 在 seed ${s} 下不是地带 —— 取样坐标失效，须重新标定`);
  }

  const anglesFor = (rx, rz, seed) => computeTarnZone(rx, rz, seed).tarns.map((t) => t.ang);
  const base = anglesFor(SHARED_REGION.rx, SHARED_REGION.rz, SEED);

  let crossSeed = 0;
  for (const seed of SEED_LIST.slice(1)) {
    const other = anglesFor(SHARED_REGION.rx, SHARED_REGION.rz, seed);
    for (let i = 0; i < base.length; i++) {
      crossSeed = Math.max(crossSeed, Math.abs(base[i] - other[i]));
    }
  }
  assertTrue(crossSeed > 1e-9,
    `跨 3 个 seed 的角布置完全相同（最大偏差 ${crossSeed}）—— 抖动没在起作用`);

  // 同 seed 下的另一个地带 region（实测 seed 12345 的地带包含 (-6,-2)）
  const otherRegion = anglesFor(-6, -2, SEED);
  let crossRegion = 0;
  for (let i = 0; i < base.length; i++) {
    crossRegion = Math.max(crossRegion, Math.abs(base[i] - otherRegion[i]));
  }
  assertTrue(crossRegion > 1e-9,
    `跨 2 个 region 的角布置完全相同（最大偏差 ${crossRegion}）—— 抖动没在起作用`);
});

test('地带布局：不同 region 的抖动不同（逐 region 抽签，不是全局固定）', () => {
  const regions = [];
  // ⚠️ 必须用 **labeled break**：旧版 `break` 只跳出内层 `rz` 循环，实际会收集到 ~56 个 zone
  //    （而非 4 个）。虽然「至少 4 个」的下界断言仍能过，但用例实际扫的样本量与意图不符。
  outer:
  for (let rx = -6; rx <= 6; rx++) {
    for (let rz = -6; rz <= 6; rz++) {
      const lay = computeTarnZone(rx, rz, SEED);
      if (lay) regions.push(lay);
      if (regions.length >= 4) break outer;
    }
  }
  assertEqual(regions.length, 4, '恰好收集 4 个地带 region（labeled break 生效）');
  const sigs = new Set(regions.map((l) => l.tarns.map((t) => t.ang.toFixed(9)).join(',')));
  assertEqual(sigs.size, 4, `4 个地带的角布置只有 ${sigs.size} 种 —— 抖动没有按 region 变化`);
});

// ==================== 雪原让路判据（DR-6） ====================
//
// 钉的是「地带边上的雪原该消失却没消失」这类缺陷 —— 形态是**静默**的：地带附近照样
// 长出一座完整雪原，方块层面看不出异常，只能靠断言拓。
//
// ⚠️ 判据的唯一口径是 spec DR-6 原文「该 region 的雪原圆若与**任一**邻域地带的圆相交」。
// **没有**「本地是地带 region 就无条件让路」这一条 —— 实测 37 个地带 region 里只有
// 5 个的雪原真的压进自己的地带圆，其余 32 个距离 168~337 格（雪原中心 = 原始中心 +
// 偏移(160,0)，而地带中心 = region 中心 ⇒ X 分量恒差 `offsetX − 40` ≥ 60）。
// 加那条特判会白删 32 座雪原，且与 DR-6 不符 ⇒ 下面有一条**反向**用例专门钉住它。

/** 雪原在**占地上**的半宽（与 `getSnowLandInfo` 同一口径：核心 + 过渡带）。 */
const SNOW_HALF = Math.floor(SNOW_LAND_SIZE / 2) + TRANSITION_SIZE.SNOW_LAND;

/** 雪原中心（与 `structure-layout.js` 同一推导：原始中心 + 偏移，**未 clamp**）。 */
function snowCenterOf(rx, rz) {
  const raw = getRegionSeededCenter(rx, rz, SEED);
  return {
    cx: raw.centerX + LANDMARK_OFFSET.SNOW_LAND_X,
    cz: raw.centerZ + LANDMARK_OFFSET.SNOW_LAND_Z,
  };
}

/**
 * **交叉验证用的独立算法**：在雪原方形内逐格采样，任一点落进任一邻域地带圆即判「被波及」。
 *
 * ⚠️ **刻意与实现不同源**：实现是「方形到圆的解析最短距离」，这里是「枚举方形内的点」。
 * 两边同一个公式就是恒真断言 —— 实测「把方形当圆」的近似口径能被这条用例抓出 3 个 region
 * 分歧，而任何同源写法都抓不到。
 *
 * `step` 决定精度：半宽 28、地带圆心总在整点半坐标处 ⇒ 步长 4 整除 28 时采样网格必含
 * 最近点，实测 ±6 的 169 个 region 上与解析解**逐个一致**（0 分歧）。
 */
function snowSuppressedBySampling(rx, rz, step) {
  const s = snowCenterOf(rx, rz);
  const max = Math.floor(SNOW_HALF / step) * step;
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      if (!isTarnZone(rx + dx, rz + dz, SEED)) continue;
      const c = tarnZoneCenter(rx + dx, rz + dz);
      for (let px = -max; px <= max; px += step) {
        for (let pz = -max; pz <= max; pz += step) {
          if (Math.hypot(s.cx + px - c.cx, s.cz + pz - c.cz) < TARN_ZONE_RADIUS) return true;
        }
      }
    }
  }
  return false;
}

test('雪原让路：判定与「方形内逐格采样」在 ±6 的 169 个 region 上逐个一致', () => {
  let suppressed = 0;
  const diffs = [];
  for (let rx = -6; rx <= 6; rx++) {
    for (let rz = -6; rz <= 6; rz++) {
      const analytic = snowLandSuppressedByTarn(rx, rz, SEED);
      const sampled = snowSuppressedBySampling(rx, rz, 4);
      if (analytic) suppressed++;
      if (analytic !== sampled) diffs.push(`(${rx},${rz}) 解析=${analytic} 采样=${sampled}`);
    }
  }
  assertEqual(diffs.length, 0, `解析解与逐格采样不一致：${diffs.join(' / ')}`);
  // 实测精确口径 28/169；近似口径 25/169 —— 两者都在下界之上，故这条**挡不住**口径退化
  // （抓口径的是下面三条：分歧 region、自己压进自己、反向钉）。它只防「判据恒 false」。
  assertTrue(suppressed >= 20, `被让路的雪原只有 ${suppressed}/169，判据可能已退化`);
});

// 实测（seed 12345、±6）：**5 个**地带 region 的雪原方形真的压进**自己**的地带圆。
// 全部落在 regionX = -6 那一列（该列 `offsetX` 最小 ⇒ 雪原离地带圆心最近）。
const SELF_OVERLAP_ZONE_REGIONS = [
  // [regionX, regionZ, 方形到圆的最短距离（实测，格）]
  [-6, 0, 136],
  [-6, 2, 135],
  [-6, 3, 135],
  [-6, 4, 141],
  [-6, -2, 150],
];

/** 本 region 自己的雪原方形与本 region 自己的地带圆是否相交（只算自己，不算邻域）。 */
function ownSnowOverlapsOwnZone(rx, rz) {
  const s = snowCenterOf(rx, rz);
  const c = tarnZoneCenter(rx, rz);
  const dx = Math.max(0, Math.abs(s.cx - c.cx) - SNOW_HALF);
  const dz = Math.max(0, Math.abs(s.cz - c.cz) - SNOW_HALF);
  return Math.hypot(dx, dz) < TARN_ZONE_RADIUS;
}

test('雪原让路：地带 region 自己的雪原压进自己的地带圆时必须让路', () => {
  for (const [rx, rz, gap] of SELF_OVERLAP_ZONE_REGIONS) {
    assertTrue(isTarnZone(rx, rz, SEED),
      `region(${rx},${rz}) 不是地带 —— 这条用例的取样已失效，须重新标定`);
    const s = snowCenterOf(rx, rz);
    const c = tarnZoneCenter(rx, rz);
    const dx = Math.max(0, Math.abs(s.cx - c.cx) - SNOW_HALF);
    const dz = Math.max(0, Math.abs(s.cz - c.cz) - SNOW_HALF);
    const actual = Math.hypot(dx, dz);
    assertTrue(Math.abs(actual - gap) < 2,
      `region(${rx},${rz}) 的方形到圆距离 ${actual.toFixed(1)} 与实测 ${gap} 不符 —— 几何或常量已变`);
    assertTrue(snowLandSuppressedByTarn(rx, rz, SEED),
      `region(${rx},${rz}) 自己的雪原压进地带圆 ${gap} 格，必须让路`);
  }
});

test('雪原让路：本地是地带 region 但雪原在圆外时**不**让路（防「无条件让路」复辟）', () => {
  // ⚠️ spec DR-6 的判据是「雪原圆与任一邻域地带圆**相交**」，不是「本地是地带就让路」。
  // 实测 37 个地带 region 里只有 11 个被让路，其中 5 个是与自己的地带圆相交，另外 6 个
  // 是被**邻域**地带波及（如 (0,-6) 被 (1,-6) 压到 156 格）。剩下的 26 个保留 ——
  // 最接近的那个 (-5,-1) 中心距最近地带圆心 **203.4** 格，远在 160 的圆外。
  // 若将来有人加了 `if (isTarnZone(...)) return true;` 特判，三条断言全都会红。
  let zoneCount = 0;
  let dropped = 0;
  let kept = 0;
  let ownOverlap = 0;
  for (let rx = -6; rx <= 6; rx++) {
    for (let rz = -6; rz <= 6; rz++) {
      if (!isTarnZone(rx, rz, SEED)) continue;
      zoneCount++;
      if (ownSnowOverlapsOwnZone(rx, rz)) ownOverlap++;
      if (snowLandSuppressedByTarn(rx, rz, SEED)) dropped++;
      else kept++;
    }
  }
  assertEqual(zoneCount, 37, '±6 窗口的地带 region 数变了 —— 须重新标定');
  assertEqual(ownOverlap, SELF_OVERLAP_ZONE_REGIONS.length,
    `与自己的地带圆相交的地带 region 数变了（${ownOverlap}）—— 须重新标定`);
  // ⚠️ 让路数 **大于** 自己相交数：多出来的是被邻域地带波及的（实测 11 = 5 + 6）
  assertEqual(dropped, 11, `让路的地带 region 数变了（${dropped}/37）—— 判据被改过，须重新标定`);
  assertEqual(kept, 26, `保留的地带 region 数变了（${kept}/37）—— 判据被改过，须重新标定`);
  // 圆外最近的那一个：(-5,-1) 中心距最近地带圆心 203.4 格。它必须保留。
  assertFalse(snowLandSuppressedByTarn(-5, -1, SEED),
    'region(-5,-1) 的雪原离最近地带圆心 203.4 格，不该让路 —— 判据被改成了「本地是地带就让路」？');
});

test('雪原让路：钉住「方形到圆」与「把方形当圆」分歧的 region（裁定 A 的判别力）', () => {
  // ⚠️ 这 3 个是两种口径**唯一**分歧的地方（实测 seed 12345、±6）。
  //    三个都是雪原**角部**擦进地带圆：中心距 188~194 已经超过 28 + 160 = 188。
  //    近似口径 `hypot(中心距) < SNOW_HALF + TARN_ZONE_RADIUS` 会把它们全判 false，其中
  //    (-6,-2) 与 (0,-6) **自己就是地带 region** ⇒ 地带里留下整座雪原。
  const CORNER_CASES = [
    { rx: -6, rz: -2, via: [-6, -2], gap: 150 }, // 与自己的地带圆相交
    { rx: -4, rz: 0, via: [-3, 0], gap: 156 }, // 被西侧邻 region 的地带波及
    { rx: 0, rz: -6, via: [1, -6], gap: 156 }, // 被东侧邻 region 的地带波及
  ];
  for (const { rx, rz, via, gap } of CORNER_CASES) {
    assertTrue(isTarnZone(via[0], via[1], SEED),
      `region(${via[0]},${via[1]}) 不是地带 —— 这条用例的取样已失效，须重新标定`);
    const s = snowCenterOf(rx, rz);
    const c = tarnZoneCenter(via[0], via[1]);
    const dx = Math.max(0, Math.abs(s.cx - c.cx) - SNOW_HALF);
    const dz = Math.max(0, Math.abs(s.cz - c.cz) - SNOW_HALF);
    const actual = Math.hypot(dx, dz);
    assertTrue(Math.abs(actual - gap) < 2,
      `region(${rx},${rz}) → 地带(${via[0]},${via[1]}) 的距离 ${actual.toFixed(1)} 与实测 ${gap} 不符`);
    // 先钉「这确实是角部擦入」：中心距必须 ≥ 188，否则近似口径也能覆盖，用例失去意义
    assertTrue(Math.hypot(s.cx - c.cx, s.cz - c.cz) >= SNOW_HALF + TARN_ZONE_RADIUS,
      `region(${rx},${rz}) 的中心距小于 ${SNOW_HALF + TARN_ZONE_RADIUS} —— 它就不是「角部擦入」了`);
    assertTrue(snowLandSuppressedByTarn(rx, rz, SEED),
      `region(${rx},${rz}) 的雪原角部压进地带圆 ${gap} 格，必须让路`);
  }
});

test('雪原让路：同一 seed 同一 region 两次调用结果相同', () => {
  for (let rx = -6; rx <= 6; rx += 3) {
    for (let rz = -6; rz <= 6; rz += 3) {
      assertEqual(snowLandSuppressedByTarn(rx, rz, SEED), snowLandSuppressedByTarn(rx, rz, SEED),
        `region(${rx},${rz}) 判定必须确定`);
    }
  }
});

// ==================== 接线（Task 3b）：layout 压制 / 空岛清空 / 撒布与巨树 / 零回归 ====================
//
// 钉的是「纯函数全绿但世界里两套内容叠在一起」这一类缺陷（M7 的教训：只测纯函数会漏接线）：
//   · `computeRegionLayout` 不把 `tarn` 传下去 → 地带与金字塔/高台/撒布同时长在同一片地上
//   · 空岛没清空 → 浮岛插进水池；云簇被误清空 → 巨型云之间的原有云消失（两片云差异要能区分）
//   · 非地带 region 的字段被顺手改坏 → 零回归失效（全世界地标漂移，静默）

/**
 * `computeRegionLayout` 里被地带整条压制的字段（雪原**不在其列**，它有独立的分析式让路判据）。
 *
 * ⚠️ 这张清单就是判据本身：把 `snowLand` 加进来会让 6 处既有消费方（直接解引用
 * `.snowLand.cx`）在**运行时**抛 TypeError —— 负向验证实测（见 task-3b 报告）。
 */
const TARN_SUPPRESSED_FIELDS = [
  'pyramid', 'frozenMountain', 'plainLand', 'island', 'city', 'giantPyramid', 'mesa',
];

test('地带接线：地带 region 的全部地标字段被压缩为 null（雪原例外）', () => {
  const { rx, rz } = findTarnRegion(SEED);
  const lay = computeRegionLayout(rx, rz, SEED);
  assertTrue(lay.tarn !== null && lay.tarn !== undefined,
    `地带 region(${rx},${rz}) 的 layout 必须带 tarn 布局`);
  for (const field of TARN_SUPPRESSED_FIELDS) {
    assertEqual(lay[field], null, `地带 region(${rx},${rz}) 的 ${field} 必须被压制为 null`);
  }
  // 雪原字段**必须保留**：压制粒度是「这座雪原是否压进某个地带圆」，不是「本 region 是不是地带」。
  // 置 null 会让 test-structure-layout / test-landmarks / test-giant-trees-gen 直接解引用崩溃。
  assertTrue(lay.snowLand && typeof lay.snowLand.cx === 'number' && typeof lay.snowLand.cz === 'number',
    '地带 region 的 snowLand 字段必须保留（它有独立判据 snowLandSuppressedByTarn）');
  // `pyramidRaw` 保留：它是「未压制的地标偏移基准」，既有用例（test-structure-layout）拿它验证
  // 「雪原中心 = 原始中心 + 偏移」的配置关系。
  assertTrue(lay.pyramidRaw && typeof lay.pyramidRaw.cx === 'number',
    'pyramidRaw 必须保留（未压制，供地标偏移关系用例对比）');
});

test('地带接线：地带里空岛清空（225→0）但云簇保留（710>0）', () => {
  // ⚠️ 两个断言缺一不可，且下界有判别力：
  //    · 只钉「skyIslands 为空」会被「整份 sky 被清掉」蒙过（写错成 tarn ? null : …）
  //    · 只钉「cloudClusters 非空」会被「忘了清空岛」蒙过
  //    实测 region(-6,-2)：未压制时 skyIslands 225 / cloudClusters 710，压制后 0 / 710。
  const { rx, rz } = findTarnRegion(SEED);
  const lay = computeRegionLayout(rx, rz, SEED);
  assertTrue(lay.sky && lay.sky.skyIslands instanceof Int32Array, 'layout.sky.skyIslands 必须是 Int32Array');
  assertEqual(lay.sky.skyIslands.length, 0, `地带 region(${rx},${rz}) 的 skyIslands 必须清空`);
  assertTrue(lay.sky.cloudClusters.length > 0,
    `地带 region(${rx},${rz}) 的 cloudClusters 必须保留（实测 710，巨型云要避开它们）`);
});

test('地带接线：地带里撒布候选与巨树候选全空', () => {
  const { rx, rz } = findTarnRegion(SEED);
  const lay = computeRegionLayout(rx, rz, SEED);
  // 撒布：两条路径都要空（只清 outsideScatter 会让城市撒布仍插进台地）
  assertEqual(lay.scatter.cityScatter.length, 0, `地带 region(${rx},${rz}) 的 cityScatter 必须清空`);
  assertEqual(lay.scatter.outsideScatter.length, 0,
    `地带 region(${rx},${rz}) 的 outsideScatter 必须清空（未压制时实测 128）`);
  // 巨树：三条路径都要空
  for (const path of ['forest', 'beach', 'banyan']) {
    assertEqual(lay.giantTrees[path].length, 0, `地带 region(${rx},${rz}) 的 giantTrees.${path} 必须清空`);
  }
});

test('地带接线：非地带且雪原未让路的 region 逐字段零回归（压制不得漏到别处）', () => {
  // ⚠️ 口径必须**双向收窄**：
  //    ① 跳过 `isTarnZone` 的 region（那些**应当**被压制）
  //    ② 跳过 `snowLandSuppressedByTarn` 的 region（那些的雪原在 apply 阶段被跳过，
  //       但 `layout.snowLand` 字段本身**照旧有值** —— 本条只钉字段级零回归，不看 apply）
  //    若不收窄，断言「pyramid 非空」在地带 region 上必然 FAIL。
  let checked = 0;
  for (let rx = -4; rx <= 4; rx++) {
    for (let rz = -4; rz <= 4; rz++) {
      if (isTarnZone(rx, rz, SEED)) continue;
      if (snowLandSuppressedByTarn(rx, rz, SEED)) continue;
      const lay = computeRegionLayout(rx, rz, SEED);
      assertEqual(lay.tarn, null, `非地带 region(${rx},${rz}) 的 tarn 必须是 null`);
      // 对照侧：直接调用候选函数（与 layout 内部**同一份**实现，所以这条钉的是「layout
      // 有没有把它传下去 / 有没有多压一层」，不是候选函数本身算得对不对 —— 后者由各自的
      // test-mesa / test-giant-pyramid / test-scatter 等文件钉住）。
      const direct = {
        mesa: computeMesaAnchor(rx, rz, SEED),
        giantPyramid: computeGiantPyramidAnchor(rx, rz, SEED),
      };
      for (const field of ['mesa', 'giantPyramid']) {
        assertEqual(JSON.stringify(lay[field]), JSON.stringify(direct[field]),
          `region(${rx},${rz}) 的 ${field} 必须与候选函数逐字段相同（零回归）`);
      }
      const sky = computeSkyCandidates(rx, rz, SEED);
      assertEqual(lay.sky.skyIslands.length, sky.skyIslands.length,
        `region(${rx},${rz}) 的 skyIslands 不得被删减（零回归）`);
      assertEqual(lay.sky.cloudClusters.length, sky.cloudClusters.length,
        `region(${rx},${rz}) 的 cloudClusters 不得被删减（零回归）`);
      checked++;
    }
  }
  // 判别力下界：±4 的 81 个 region 里地带 ~1/3、雪原让路少数 ⇒ 实际样本数应远大于 0
  assertTrue(checked >= 30, `零回归的样本数 ${checked} 太少（±4 网眼里应 ≥30）—— 取样口径被改窄了`);
});

// ==================== 接线（Task 3b）：apply 阶段 1 的雪原跳过门 ====================
//
// 钉的是「layout 压制全绿但世界里雪原照旧长在地带圆里」这一类缺陷（M7 教训：只测纯函数漏接线）。
// 判据落在**真实 applyStructuresToColumn 写出的世界方块**上，不是纯函数返回值。

/** 建一个只有 BLOCKS 的 registry（与 test-vegetation / test-structure-json 同手法） */
function buildRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}

test('地带接线：被让路的雪原真的不落地（apply 阶段 1 跳过门），未被让路的照旧长', async () => {
  // 取样点（seed 12345 实测）：
  //   (-6,0) 让路 → 雪原中心 column 内 snow_grass 实测 0
  //   (-4,-1) 不让路 → 同一判据实测 256（满 column）
  const reg = buildRegistry();
  const snowIds = new Set(['snow_grass', 'snow'].map((n) => reg.idOf(n)));
  const countSnowAtSnowCenter = async (rx, rz) => {
    const lay = computeRegionLayout(rx, rz, SEED);
    const cx = Math.floor(lay.snowLand.cx / 16), cz = Math.floor(lay.snowLand.cz / 16);
    const col = new ChunkColumn(cx, cz);
    const layouts = [];
    for (const key of neighborRegionKeys(cx, cz)) {
      const [nrx, nrz] = key.split(',').map(Number);
      layouts.push(computeRegionLayout(nrx, nrz, SEED));
    }
    await applyStructuresToColumn(col, SEED, reg, layouts);
    let n = 0;
    for (let i = 0; i < col.blocks.length; i++) if (snowIds.has(col.blocks[i])) n++;
    return { n, cx, cz };
  };

  const suppressed = await countSnowAtSnowCenter(-6, 0);
  assertTrue(snowLandSuppressedByTarn(-6, 0, SEED),
    'region(-6,0) 的雪原必须被让路（实测 TRUE）—— 取样点失效须重新标定');
  assertEqual(suppressed.n, 0,
    `region(-6,0) 的雪原已被让路，雪原中心 column(${suppressed.cx},${suppressed.cz}) 不得有积雪方块（实测 0）`);

  const kept = await countSnowAtSnowCenter(-4, -1);
  assertFalse(snowLandSuppressedByTarn(-4, -1, SEED),
    'region(-4,-1) 的雪原不该被让路（实测 FALSE）—— 取样点失效须重新标定');
  assertTrue(kept.n > 200,
    `region(-4,-1) 的雪原照旧生成，雪原中心 column(${kept.cx},${kept.cz}) 应满 column（实测 256，得 ${kept.n}）`);
});
