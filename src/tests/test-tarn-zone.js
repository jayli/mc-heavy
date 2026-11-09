// src/tests/test-tarn-zone.js — 高台地带 Tier 1：判定 / 环形布局 / 间距 / 装饰落位
//
// 钉的是「改坏了会静默产出一个错误但看起来正常的地带」这几类缺陷：
//   · 地带跨 region 边界 → 相邻 region 不为它算候选 ⇒ 地带半边永久消失
//   · 抖动过大 → 相邻高台贴在一起（水池里两块台子糊成一坨）
//   · 装饰件叠在高台上 → 拱洞穿进台身
//   · CITY_REGION 掷到地带 → 全世界唯一的城市消失
import { computeShallowTarnAnchor, shallowTarnSuppressedLandmarks } from '../gen/structures/shallow-water-tarns.js';
import { computeBurningArenaAnchor, burningArenaSuppressedLandmarks } from '../gen/structures/burning-arena.js';
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse } from './assert.js';
import {
  isTarnZone, hasTarnEligibility, tarnZoneCenter, computeTarnZone, aabbGap, snowLandSuppressedByTarn,
  circleRectGap, findNearestTarnZone,
  TARN_ZONE_RADIUS, TARN_PLATFORM_RADIUS, TARN_SLOPE_WIDTH, TARN_ZONE_CHANCE, TARN_DESERT_CAP,
  TARN_HOST_BIOMES, TARN_GAP, TARN_KEPT_TARN_IDS, TARN_ARCH_RING_RADIUS, TARN_SPIRE_RING_RADIUS,
  TARN_PLATEAU_Y,
} from '../gen/structures/tarn-zone.js';
import { getBiome } from '../gen/noise.js';
import { getCityBoundsForSeed } from '../gen/structures/city-layout.js';
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
import {
  getPyramidCenterInRegion, getFrozenMountainCenterInRegion,
  getPlainLandCenterInRegion, getIslandCenterInRegion,
  isPlainLandValid, isIslandValid,
} from '../gen/structures/landmarks.js';
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

// ⚠️ **v1.90 删除了两条旧密度用例**（「密度落在 1/3 附近」与「±6 宽松带」）：
// 它们测的是 `isTarnZone` 在**全部 region** 上的通过率 ≈ 1/3，而那正是被本次改造换掉的语义 ——
// 现在 `isTarnZone` = 「合格集合 × 1/5」，全域密度还乘上「这块草地合不合格」（实测 ~1/3），
// 于是全域通过率大约是 0.05（实测 ±20 = 0.050、±6 = 0.036），两条旧用例**必然 FAIL**。
// 它们的结论已不成立 —— 保留旧判据只调容差，会把「抽签确实生效」测成噪声。
// 替代判据在下方「v1.90：稀有草地替换的出现口径」那组（合格集命中率 / 每 N region 一座 /
// 中心 biome / 不撞城 / 沙漠占比）。

test('地带中心 = region 中心', () => {
  for (const [rx, rz] of [[1, 0], [-2, 3]]) {
    const c = tarnZoneCenter(rx, rz);
    assertEqual(c.cx, rx * REGION_SIZE + REGION_SIZE / 2, 'cx');
    assertEqual(c.cz, rz * REGION_SIZE + REGION_SIZE / 2, 'cz');
  }
});

test('瞬移落点解析：findNearestTarnZone 返回真正最近的那座（v1.92）', () => {
  // 设置面板「瞬移 → 高台地带」的落点解析。判据不是「找到一个」，而是
  // **「返回的确实是最近的」** —— 只断言非 null 的话，把环扫写成「返回第一个命中」
  // （不比较同环内距）或「反向遍历」都会通过。
  let checked = 0;
  for (const seed of [12345, 4, 7, 999]) {
    for (const [wx, wz] of [[0, 0], [3000, -3000], [-8000, 5000]]) {
      const found = findNearestTarnZone(wx, wz, seed);
      assertTrue(found !== null, `seed ${seed} @(${wx},${wz}) 应在 maxRadius=16 内找到地带`);

      // 穷举参考：同一个 maxRadius 范围内的**全部**地带，取真实最近
      const baseX = Math.floor(wx / REGION_SIZE), baseZ = Math.floor(wz / REGION_SIZE);
      let bestDist = Infinity;
      for (let dx = -16; dx <= 16; dx++) {
        for (let dz = -16; dz <= 16; dz++) {
          if (!isTarnZone(baseX + dx, baseZ + dz, seed)) continue;
          const c = tarnZoneCenter(baseX + dx, baseZ + dz);
          bestDist = Math.min(bestDist, Math.hypot(c.cx - wx, c.cz - wz));
        }
      }
      // 环扫会**提前退出**（找到就停），所以它返回的距离必须等于穷举最小值 ——
      // 差一丁点都说明它没查到最近的那个环。
      assertTrue(Math.abs(found.dist - bestDist) < 1e-9,
        `seed ${seed} @(${wx},${wz})：环扫返回距离 ${found.dist.toFixed(1)}`
        + ` 但穷举最近是 ${bestDist.toFixed(1)}（提前退出时机不对）`);
      // 返回的 region 必须真的是地带
      assertTrue(isTarnZone(found.regionX, found.regionZ, seed), '返回的 region 必须是地带');
      // cx/cz 必须与 tarnZoneCenter 同源（不得自己算一份）
      const c = tarnZoneCenter(found.regionX, found.regionZ);
      assertEqual(found.cx, c.cx);
      assertEqual(found.cz, c.cz);
      checked++;
    }
  }
  assertEqual(checked, 12);
});

test('瞬移落点解析：maxRadius 不够时返回 null（不越界乱找）', () => {
  // 出生点附近一个环内未必有地带 —— 用 maxRadius=0 把搜索锁在「只查玩家所在 region」，
  // 那里绝大多数情况下不是地带。两个分支都必须能出现，否则本用例无判别力。
  let hit = 0, miss = 0;
  for (let i = 0; i < 40; i++) {
    const r = findNearestTarnZone(i * 400, i * 400, 12345, 0);
    if (r) { hit++; assertEqual(r.ring, 0, 'maxRadius=0 只允许 ring=0'); } else miss++;
  }
  assertTrue(miss > 30, `maxRadius=0 应绝大多数落空（实测落空 ${miss}/40）`);
  assertTrue(hit > 0, `maxRadius=0 也应有命中（实测 ${hit}/40）—— 否则两个分支只测到一个`);
});

test('地带半径不越 region 边界（否则半边永久消失）', () => {
  assertTrue(TARN_ZONE_RADIUS + 2 <= REGION_SIZE / 2,
    `TARN_ZONE_RADIUS(${TARN_ZONE_RADIUS}) + 2 必须 <= ${REGION_SIZE / 2}`);
});

// ==================== v1.90：稀有草地替换的出现口径 ====================

/**
 * 合格集合（中心 PLAINS + 邻沙 + 不撞城 + 沙漠占比 ≤ cap），**直接调生产实现**。
 * ⚠️ 不得在测试里重写一份资格判据 —— 那会让「1/5 作用在合格集合上」这条断言恒真（红线 1）。
 */
function eligibilityOf(rx, rz, seed) {
  if (rx === CITY_REGION.X && rz === CITY_REGION.Z) return false;
  return hasTarnEligibility(rx, rz, seed);
}

test('出现口径：地带必然落在合格集合里（1/5 是「合格集里的五取一」）', () => {
  // ⚠️ 判别力：若 chance 被误作用在「全部 region」上（即去掉资格判据），
  //    必然出现「是地带但不合格」的样本，本用例真 FAIL。
  let bad = 0;
  for (const seed of [12345, 4, 7]) {
    for (let rx = -10; rx <= 10; rx++) for (let rz = -10; rz <= 10; rz++) {
      if (isTarnZone(rx, rz, seed) && !eligibilityOf(rx, rz, seed)) bad++;
    }
  }
  assertEqual(bad, 0, `出现 ${bad} 个「是地带但不合格」的 region（1/5 没作用在合格集合上）`);
});

test('出现口径：TARN_ZONE_CHANCE 必须真的是 1/5（用户需求：「五块草地才有一个」）', () => {
  // ⚠️ **必须用字面量 1/5，不能拿 `TARN_ZONE_CHANCE` 自比** —— 下面那条命中率用例若
  //    比较的是 `TARN_ZONE_CHANCE` 本体，改常量时断言跟着变、**恒真**（实测注入 1/3 后
  //    旧写法仍全绿）。用户说的是「五块草地才有一个」，那是个**绝对需求**，不是可调旋钮。
  assertEqual(TARN_ZONE_CHANCE, 1 / 5, '地带出现概率（用户 2026-10-28 裁定：合格草地五取一）');
});

test('出现口径：合格集合上的命中率 ≈ 1/5（62 seed 实测均值 0.1963）', () => {
  // ⚠️ **样本量必须够**：合格集实测 189~222 个/seed（±12 窗口），n≈208 时
  //    σ = √(0.2·0.8/208) = 0.0277 —— 所以容差取 0.10（3.6σ），单一 seed 才不会被噪声误报。
  //    ±12 窗口实测 62 个 seed 的区间是 [0.1298, 0.2796]、94% 落在 ±0.05 内。
  // ⚠️ **基准用字面量 1/5，不用 `TARN_ZONE_CHANCE`**（否则改常量时断言恒真，
  //    实测注入 1/3 → 实测率 0.333，|0.333 − 0.333| = 0 < 0.10 照样全绿）。
  const EXPECTED = 1 / 5;
  let elig = 0, hit = 0;
  for (let rx = -12; rx <= 12; rx++) for (let rz = -12; rz <= 12; rz++) {
    if (!eligibilityOf(rx, rz, SEED)) continue;
    elig++;
    if (isTarnZone(rx, rz, SEED)) hit++;
  }
  assertTrue(elig > 150, `合格 region 数 ${elig} 太少 —— 地带判据可能过严，本用例失去判别力`);
  const rate = hit / elig;
  assertTrue(Math.abs(rate - EXPECTED) < 0.10,
    `合格集命中率 ${rate.toFixed(3)} 偏离 1/5（${hit}/${elig}）—— 实测 chance=1/3 时是 0.333、1/10 时是 0.10`);
});

test('出现口径：地带是稀有图（每 6~14 个 region 才一座）', () => {
  // 实测 8 seed：**每 7.4~7.7 region 一座**（seed 12345 是 8.3）。
  //
  // ⚠️ **带宽演变**（每次都是用户观感裁定后的重标，不是放宽）：
  // | 版本 | 口径 | 实测密度 |
  // |---|---|---|
  // | v1.89 | 纯哈希 1/3 | 每 3.4 |
  // | v1.90 | 1/5 + 只有 PLAINS + 圆周挨沙漠 | 每 13.6~23.1 |
  // | **v1.92（现行）** | 1/5 + PLAINS+FOREST+AZALEA + 260 格内有沙漠 | **每 7.4~8.3** |
  //
  // 带宽 [6, 14]：下界防「变回每 3 个一座」（实测 3.0~3.2），
  // 上界防「退回只有 PLAINS」（实测 13.6~23.1 会被抓住）。
  for (const seed of [12345, 4, 7]) {
    let hits = 0, total = 0;
    for (let rx = -12; rx <= 12; rx++) for (let rz = -12; rz <= 12; rz++) {
      total++;
      if (isTarnZone(rx, rz, seed)) hits++;
    }
    const per = total / Math.max(1, hits);
    assertTrue(per >= 6 && per <= 14,
      `seed ${seed}: 每 ${per.toFixed(1)} region 一座地带（实测区间 7.4~8.3，允许 6~14）`);
  }
});

test('出现口径：地带中心 biome 必须是「草地」（PLAINS / FOREST / AZALEA）', () => {
  let total = 0;
  for (const seed of [12345, 4, 7]) {
    for (let rx = -10; rx <= 10; rx++) for (let rz = -10; rz <= 10; rz++) {
      if (!isTarnZone(rx, rz, seed)) continue;
      total++;
      const { cx, cz } = tarnZoneCenter(rx, rz);
      assertTrue(TARN_HOST_BIOMES.includes(getBiome(cx, cz, seed)),
        `region(${rx},${rz}) seed ${seed} 的中心 biome 不在 ${JSON.stringify(TARN_HOST_BIOMES)} 里`);
    }
  }
  assertTrue(total > 20, `样本只有 ${total} 个地带，本用例没有判别力`);
});

test('出现口径：地带圆永不与 City bounds 重叠（含 32 格过渡带余量）', () => {
  // ⚠️ 改造前实测：8 个 seed 里 **6 个有地带撞城市**，最深 112 格（seed 12345 的 region(1,-1)）。
  //    判据用 `circleRectGap`（圆到矩形真实距离），不能写「圆心到 bounds 中心」——
  //    城市 bounds 实测半宽 283，远超 CITY_SIZE_MAX/2，拿中心距判会漏掉贴着边角的情形。
  for (const seed of [12345, 4, 7, 2, 99, 424242]) {
    const city = getCityBoundsForSeed(seed);
    for (let rx = -12; rx <= 12; rx++) for (let rz = -12; rz <= 12; rz++) {
      if (!isTarnZone(rx, rz, seed)) continue;
      const { cx, cz } = tarnZoneCenter(rx, rz);
      const gap = circleRectGap(cx, cz, TARN_ZONE_RADIUS, city);
      assertTrue(gap > 0,
        `seed ${seed} region(${rx},${rz}) 的地带圆压进城市 ${(-gap).toFixed(0)} 格`);
    }
  }
});

test('出现口径：核心平台的沙漠占比不超过 TARN_DESERT_CAP', () => {
  // 这条门防的是「高台盖在沙漠上」：没有它，抽中的地点有 15% 的平台一半以上是沙漠
  // （实测分布 p50=0.083 / p90=0.28 / p95=0.37 / max=0.44）。
  let checked = 0;
  for (const seed of [12345, 4, 7]) {
    for (let rx = -10; rx <= 10; rx++) for (let rz = -10; rz <= 10; rz++) {
      if (!isTarnZone(rx, rz, seed)) continue;
      const { cx, cz } = tarnZoneCenter(rx, rz);
      let n = 0, desert = 0;
      // 采样口径与 `coreDesertFraction` 同构（圆心 + 6 圈 × 24 方位）
      for (let ring = 0; ring <= 6; ring++) {
        const r = TARN_PLATFORM_RADIUS * ring / 6;
        const count = ring === 0 ? 1 : 24;
        for (let i = 0; i < count; i++) {
          const ang = i * 2 * Math.PI / count + ring * 0.37;
          if (getBiome(Math.round(cx + r * Math.cos(ang)), Math.round(cz + r * Math.sin(ang)), seed) === 'DESERT') desert++;
          n++;
        }
      }
      checked++;
      assertTrue(desert / n <= TARN_DESERT_CAP + 1e-9,
        `region(${rx},${rz}) 核心沙漠占比 ${(desert / n).toFixed(3)} > cap ${TARN_DESERT_CAP}`);
    }
  }
  assertTrue(checked > 20, `样本只有 ${checked} 个地带，本用例没有判别力`);
});

test('几何：平台半径 + 缓坡宽度 === 地带半径（三者不许漂移）', () => {
  assertEqual(TARN_PLATFORM_RADIUS + TARN_SLOPE_WIDTH, TARN_ZONE_RADIUS,
    'platformRadius + slopeWidth 必须等于 zoneRadius');
  // 现行值（改它就要重测「缓坡走不上去的列占比」，实测表在代码注释里）
  assertEqual(TARN_SLOPE_WIDTH, 24, '缓坡宽度（用户 2026-10-28 裁定缩到 24）');
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

test('地带布局：每座高台的四角落在平台内（轴对齐，逐角算）', () => {
  const { rx, rz } = findTarnRegion(SEED);
  const lay = computeTarnZone(rx, rz, SEED);
  for (const t of lay.tarns) {
    // ⚠️ **必须逐角算**（spec DR-7）：轴对齐矩形的最远点是四个角之一，不是边中点。
    //    两个常见错误口径：
    //    · ring + halfX + halfZ —— 把两个半宽相加，每座多算 10~34 格；
    //    · ring + min(halfX, halfZ) —— 那是边中点，实测 L3 角比边中点远 8.9 格
    //      （88.88 vs 80.0），会让高台伸出平台而断言全绿。
    const cx = t.ring * Math.cos(t.ang), cz = t.ring * Math.sin(t.ang);
    let maxReach = 0;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      maxReach = Math.max(maxReach, Math.hypot(cx + sx * t.halfX, cz + sz * t.halfZ));
    }
    // ⚠️ **s1.89 起没有水池了，基准是 `platformRadius`（恒平的内圈）** ——
    // 高台底座必须在平地上；落到缓坡上会半边悬空（缓坡高低不平）。
    assertTrue(maxReach <= lay.platformRadius,
      `${t.variant} 四角最远 ${maxReach.toFixed(1)} > 平台半径 ${lay.platformRadius}`);
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

test('地带布局：12 个装饰件全在（5 拱洞 + 7 紫晶柱）且全落在平台内', () => {
  const { rx, rz } = findTarnRegion(SEED);
  const lay = computeTarnZone(rx, rz, SEED);
  const arches = lay.decos.filter((d) => d.kind === 'arch');
  const spires = lay.decos.filter((d) => d.kind === 'spire');
  assertEqual(arches.length, 5, '拱洞数');
  assertEqual(spires.length, 7, '紫晶柱数');
  // ⚠️ **s1.90 起拱洞与紫晶柱的判据统一为「四角最远 ≤ platformRadius」**：
  //    旧口径是「拱洞在池外（> poolRadius）、紫晶柱在池内（< poolRadius）」，
  //    但 s1.89 删了水池后 `poolRadius` 已经不存在，且两类结构真正的约束是
  //    「底座必须落在恒平的平台上」—— 落到缓坡上会半边悬空（缓坡高低不平）。
  // ⚠️ **必须逐角算**：轴对齐矩形离圆心的最远点是四角之一（不是边中点），
  //    只判 `a.ring <= platformRadius` 是常数比较，拓不到「结构伸出平台」这类缺陷。
  //    改环半径前先看实测表（`TARN_ARCH_RING_RADIUS` 的注释）：
  //    拱洞环 94 时四角 108 仍在平台内，但与高台的 AABB 间距掉到 3.69 < 4，会被下一条用例抓住。
  for (const d of [...arches, ...spires]) {
    const dcx = d.ring * Math.cos(d.ang), dcz = d.ring * Math.sin(d.ang);
    let farCorner = 0, nearCorner = Infinity;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const r = Math.hypot(dcx + sx * d.halfX, dcz + sz * d.halfZ);
      farCorner = Math.max(farCorner, r);
      nearCorner = Math.min(nearCorner, r);
    }
    assertTrue(farCorner <= lay.platformRadius,
      `${d.kind}/${d.variant} 四角最远 ${farCorner.toFixed(2)} 超出平台半径 ${lay.platformRadius}`);
    // 判别力兜底：如果结构完全包住了圆心（nearCorner === 0），它是不能被摆上环的
    assertTrue(nearCorner > 0, `${d.kind}/${d.variant} 盖住了地带中心`);
  }
  // ⚠️ 拱洞环半径是实测标定值（不是公式）：96 是「全在平台内」与「vs 高台 ≥ TARN_GAP」
  //    同时成立的最小值。只判 `TARN_ARCH_RING_RADIUS < TARN_ZONE_RADIUS` 是常数比较，没有判别力。
  assertTrue(TARN_ARCH_RING_RADIUS > TARN_SPIRE_RING_RADIUS,
    '拱洞在紫晶柱外侧（两者不要互换）');
  assertTrue(TARN_ARCH_RING_RADIUS < TARN_PLATFORM_RADIUS,
    `拱洞环 ${TARN_ARCH_RING_RADIUS} 必须在平台内（< ${TARN_PLATFORM_RADIUS}）`);
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
  // ⚠️ **s1.90：`poolRadius` 已删除**（s1.89 去掉水池后它就是死字段）。现在三个半径是
  //    `plateauRadius`（地带圆外缘）/ `platformRadius`（恒平内圈）/ `slopeWidth`（两者之间）。
  assertFalse('poolRadius' in lay, 'poolRadius 已在 v1.90 删除（水池不存在了）');
  assertEqual(lay.plateauRadius, TARN_ZONE_RADIUS, 'plateauRadius = 地带半径');
  assertEqual(lay.platformRadius, TARN_PLATFORM_RADIUS, 'platformRadius = 派生常量');
  assertEqual(lay.slopeWidth, TARN_SLOPE_WIDTH, 'slopeWidth = 派生常量');
  // 三者必须自洽（改任一个而忘了另两个会漂移出「缓坡宽度对不上」）
  assertEqual(lay.platformRadius + lay.slopeWidth, lay.plateauRadius,
    '平台半径 + 缓坡宽度 必须等于地带半径');
  // ⚠️ **必须拿 `SEA_Y + 4` 作参照，不能写 `assertEqual(lay.plateauY, TARN_PLATEAU_Y)`**：
  //    两边同源（`TARN_PLATEAU_Y` 是 `computeTarnZone` 的直接输入）→ 改常量时断言跟着变，
  //    恒真。而 Task 4/5/6 会读到一个错的高度，形态是「台地浮起／矮一格」，
  //    **方块层面看不出那是高度常量错了**。
  assertEqual(TARN_PLATEAU_Y, SEA_Y + 4, 'TARN_PLATEAU_Y 必须 = SEA_Y + 4');
  assertEqual(lay.plateauY, SEA_Y + 4, 'layout.plateauY 必须 = SEA_Y + 4');
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
  //    **v1.90 重新标定**：稀有化后三个 seed 的交集变稀，旧值 region(4,4) 已不再成立。
  //    实测 seed {12345, 4, 7} 的交集里有 region(-10,3) 与 (8,-1)；仍程序化找，
  //    避免下次改判定时又失效。
  const SEED_LIST = [SEED, 4, 7];
  let SHARED_REGION = null;
  for (let rx = -14; rx <= 14 && !SHARED_REGION; rx++) {
    for (let rz = -14; rz <= 14 && !SHARED_REGION; rz++) {
      if (rx === 0 && rz === 0) continue;
      if (SEED_LIST.every((s) => isTarnZone(rx, rz, s))) SHARED_REGION = { rx, rz };
    }
  }
  assertTrue(SHARED_REGION !== null,
    `±14 窗口找不到 ${JSON.stringify(SEED_LIST)} 共享的地带 region —— 判定可能过严，本用例无法进行`);

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

  // 同 seed 下的另一个地带 region（程序化找，不硬编码）
  let otherRegionAngles = null;
  for (let rx = -8; rx <= 8 && !otherRegionAngles; rx++) {
    for (let rz = -8; rz <= 8 && !otherRegionAngles; rz++) {
      if (rx === SHARED_REGION.rx && rz === SHARED_REGION.rz) continue;
      if (!isTarnZone(rx, rz, SEED)) continue;
      otherRegionAngles = anglesFor(rx, rz, SEED);
    }
  }
  assertTrue(otherRegionAngles !== null, '±8 窗口只有一个地带 region —— 跨 region 对比无法进行');
  let crossRegion = 0;
  for (let i = 0; i < base.length; i++) {
    crossRegion = Math.max(crossRegion, Math.abs(base[i] - otherRegionAngles[i]));
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

/**
 * 雪原让路用例的**取样 seed**。
 *
 * ⚠️ **为什么不用 `SEED`（12345）**：v1.90 把地带改为「稀有草地替换」后，seed 12345 的
 * ±6 窗口里只有 6 个地带，**没有任何一个**的雪原压进自己的圆 ⇒「自己压进自己」那类用例
 * 在它上面**零样本**，只能降级成无判别力的恒真断言。实测扫 seed 1..60：
 * seed 4 的 ±6 有 13 个地带、其中 **5 个**自己雪原压进自己圆（gap 81~137）—— 样本最充分。
 *
 * ⚠️ 改地带半径 / 雪原尺寸 / region 尺寸后这份标定全部失效，须用下面的程序化查重新标。
 */
const SNOW_SEED = 4;

/** 雪原中心（与 `structure-layout.js` 同一推导：原始中心 + 偏移，**未 clamp**）。 */
function snowCenterOf(rx, rz, seed = SEED) {
  const raw = getRegionSeededCenter(rx, rz, seed);
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
function snowSuppressedBySampling(rx, rz, step, seed = SEED) {
  const s = snowCenterOf(rx, rz, seed);
  const max = Math.floor(SNOW_HALF / step) * step;
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      if (!isTarnZone(rx + dx, rz + dz, seed)) continue;
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

test('雪原让路：判定与「方形内逐格采样」在 ±6 的 169 个 region 上逐个一致（两个 seed）', () => {
  // ⚠️ **两个 seed 都要跑**：单个 seed 的「被让路」样本可能为 0（seed 12345 现在就是 0），
  // 那样解析侧与采样侧都是 false，逐个一致是**恒真**的（空断言）。两个 seed 合并后
  // 实测有 5~10 个 true 样本，下界断言才有意义。
  let suppressed = 0;
  const diffs = [];
  for (const seed of [SEED, SNOW_SEED]) {
    for (let rx = -6; rx <= 6; rx++) {
      for (let rz = -6; rz <= 6; rz++) {
        const analytic = snowLandSuppressedByTarn(rx, rz, seed);
        const sampled = snowSuppressedBySampling(rx, rz, 4, seed);
        if (analytic) suppressed++;
        if (analytic !== sampled) diffs.push(`seed${seed}(${rx},${rz}) 解析=${analytic} 采样=${sampled}`);
      }
    }
  }
  assertEqual(diffs.length, 0, `解析解与逐格采样不一致：${diffs.join(' / ')}`);
  // 实测（seed 12345 + 4 合并）精确口径 5 个 true；下界 3 只防「判据恒 false」。
  // 抓口径退化的是下面三条（分歧 region、自己压进自己、反向钉）。
  assertTrue(suppressed >= 3, `被让路的雪原只有 ${suppressed}/338，判据可能已退化`);
});

// ⚠️ **v1.90 改为程序化查，不再硬编码坐标**：旧表是 5 个写死的 region（全在 regionX = -6 那一列），
// 而 v1.90 把地带改成「稀有草地替换」后那一列已不再是地带 —— 硬编码的取样必然失效。
// 现在的口径：在 `SNOW_SEED` 的 ±6 窗口里**实时**找出「地带 region 且自己的雪原压进自己圆」的那些。
// 实测 seed 4 有 5 个（gap 81~137）。
function selfOverlapZoneRegions(seed) {
  const out = [];
  for (let rx = -6; rx <= 6; rx++) {
    for (let rz = -6; rz <= 6; rz++) {
      if (!isTarnZone(rx, rz, seed)) continue;
      const gap = ownSnowOverlapsOwnZone(rx, rz, seed);
      if (gap < TARN_ZONE_RADIUS) out.push({ rx, rz, gap });
    }
  }
  return out;
}

/** 本 region 自己的雪原方形与本 region 自己的地带圆的最短距离（只算自己，不算邻域）。 */
function ownSnowOverlapsOwnZone(rx, rz, seed = SEED) {
  const s = snowCenterOf(rx, rz, seed);
  const c = tarnZoneCenter(rx, rz);
  const dx = Math.max(0, Math.abs(s.cx - c.cx) - SNOW_HALF);
  const dz = Math.max(0, Math.abs(s.cz - c.cz) - SNOW_HALF);
  return Math.hypot(dx, dz);
}

test('雪原让路：地带 region 自己的雪原压进自己的地带圆时必须让路', () => {
  const cases = selfOverlapZoneRegions(SNOW_SEED);
  // ⚠️ **样本数下界是必需的**：零样本时下面的 for 循环体不执行 ⇒ 整条用例恒绿。
  //    实测 seed 4 有 5 个；改地带半径 / 雪原尺寸后必须重测这个下界。
  assertTrue(cases.length >= 3, `「自己的雪原压进自己圆」只有 ${cases.length} 个样本（seed ${SNOW_SEED}）—— 须重新标定`);
  for (const { rx, rz, gap } of cases) {
    assertTrue(gap < TARN_ZONE_RADIUS,
      `region(${rx},${rz}) 的方形到圆距离 ${gap.toFixed(1)} 不低于 ${TARN_ZONE_RADIUS} —— 筛选逻辑错了`);
    assertTrue(snowLandSuppressedByTarn(rx, rz, SNOW_SEED),
      `region(${rx},${rz}) 自己的雪原压进地带圆 ${gap.toFixed(1)} 格，必须让路`);
  }
});

test('雪原让路：本地是地带 region 但雪原在圆外时**不**让路（防「无条件让路」复辟）', () => {
  // ⚠️ spec DR-6 的判据是「雪原圆与任一邻域地带圆**相交**」，不是「本地是地带就让路」。
  // 实测：地带 region 的雪原**大多数**都在自己圆外（雪原中心 = 原始中心 + 偏移(160,0)，
  // 而地带中心 = region 中心 ⇒ X 分量恒差 `offsetX − 40` ≥ 60）。
  // 若将来有人加了 `if (isTarnZone(...)) return true;` 特判，这条会红。
  //
  // ⚠️ **取样口径从「硬编码一个 region」改为实时筛**：旧版硬编码 region(-5,-1)
  //    并断言「它中心距 203.4 格」——v1.90 后那个 region 已不是地带，断言失效。
  let zoneCount = 0;
  let dropped = 0;
  let kept = 0;
  let keptAndOwnZone = 0;
  let farthestKept = { gap: -1 };
  for (let rx = -6; rx <= 6; rx++) {
    for (let rz = -6; rz <= 6; rz++) {
      if (!isTarnZone(rx, rz, SNOW_SEED)) continue;
      zoneCount++;
      if (snowLandSuppressedByTarn(rx, rz, SNOW_SEED)) {
        dropped++;
      } else {
        kept++;
        if (ownSnowOverlapsOwnZone(rx, rz, SNOW_SEED) >= TARN_ZONE_RADIUS) {
          keptAndOwnZone++;
          const gap = ownSnowOverlapsOwnZone(rx, rz, SNOW_SEED);
          if (gap > farthestKept.gap) farthestKept = { rx, rz, gap };
        }
      }
    }
  }
  assertTrue(zoneCount >= 8, `±6 窗口的地带 region 只有 ${zoneCount} 个（seed ${SNOW_SEED}）—— 取样口径变了，须重新标定`);
  // ⚠️ **关键断言**：「本地是地带、但与自己的圆不相交」的 region 必须全部保留。
  //    这是「无条件让路」特判的直接反例（有特判就会把它们删掉）。
  assertTrue(keptAndOwnZone >= 1,
    `没有一个「地带但自己的雪原在圆外」的样本（kept=${kept} dropped=${dropped}）—— 本用例没有判别力`);
  // 实测最远那个的方形到圆距离远超地带半径（圆外）
  assertTrue(farthestKept.gap > TARN_ZONE_RADIUS,
    `最远保留样本的 gap ${farthestKept.gap.toFixed(1)} 不大于 ${TARN_ZONE_RADIUS}`);
});

test('雪原让路：钉住「方形到圆」与「把方形当圆」分歧的 region（裁定 A 的判别力）', () => {
  // ⚠️ 这 3 个是两种口径**唯一**分歧的地方（实测 seed 12345、±6）。
  //    三个都是雪原**角部**擦进地带圆：中心距 188~194 已经超过 28 + 160 = 188。
  //    近似口径 `hypot(中心距) < SNOW_HALF + TARN_ZONE_RADIUS` 会把它们全判 false，其中
  //    (-6,-2) 与 (0,-6) **自己就是地带 region** ⇒ 地带里留下整座雪原。
  //
  // ⚠️ **v1.90 改为程序化找**：旧表是 seed 12345 上写死的 3 个 region，而这 3 个的
  //    「经过哪个地带圆」依赖旧判定（纯哈希 1/3）；新判定下它们已不再被波及。
  //    现在扫所有 seed 找「精确判 true 而近似判 false」的真分歧（实测 seed 1..80 有 39 个）。
  const CORNER_CASES = findCornerDivergenceCases();
  // ⚠️ **样本数下界必需**：零样本时下面循环体不执行 ⇒ 整条用例恒绿。
  assertTrue(CORNER_CASES.length >= 2,
    `「角部擦入」的分歧样本只有 ${CORNER_CASES.length} 个 —— 本用例没有判别力（须重新标定）`);
  for (const { rx, rz, via, gap, seed } of CORNER_CASES) {
    const s = snowCenterOf(rx, rz, seed);
    const c = tarnZoneCenter(via[0], via[1]);
    const dx = Math.max(0, Math.abs(s.cx - c.cx) - SNOW_HALF);
    const dz = Math.max(0, Math.abs(s.cz - c.cz) - SNOW_HALF);
    const actual = Math.hypot(dx, dz);
    assertTrue(Math.abs(actual - gap) < 2,
      `seed${seed} region(${rx},${rz}) → 地带(${via[0]},${via[1]}) 的距离 ${actual.toFixed(1)} 与实测 ${gap} 不符`);
    // 先钉「这确实是角部擦入」：中心距必须 ≥ SNOW_HALF + 地带半径，否则近似口径也能覆盖
    assertTrue(Math.hypot(s.cx - c.cx, s.cz - c.cz) >= SNOW_HALF + TARN_ZONE_RADIUS,
      `seed${seed} region(${rx},${rz}) 的中心距小于 ${SNOW_HALF + TARN_ZONE_RADIUS} —— 它就不是「角部擦入」了`);
    assertTrue(snowLandSuppressedByTarn(rx, rz, seed),
      `seed${seed} region(${rx},${rz}) 的雪原角部压进地带圆 ${gap.toFixed(0)} 格，必须让路`);
  }
});

/**
 * 找出「精确口径判 true、但『把方形当圆』的近似口径判 false」的真分歧样本。
 *
 * ⚠️ **这是那条负向验证的取材器**：没有它，用例只能硬编码坐标（v1.90 已让旧坐标失效）。
 * 实测 seed 1..80 有 39 个分歧（0.29%），取前 3 个即可。
 * @returns {Array<{rx:number, rz:number, via:[number,number], gap:number, seed:number}>}
 */
function findCornerDivergenceCases() {
  const out = [];
  for (let seed = 1; seed <= 80 && out.length < 3; seed++) {
    for (let rx = -6; rx <= 6; rx++) {
      for (let rz = -6; rz <= 6; rz++) {
        const exact = snowLandSuppressedByTarn(rx, rz, seed);
        if (!exact) continue;
        // 近似口径：把方形当成半径 SNOW_HALF 的圆，只看向心距
        const s = snowCenterOf(rx, rz, seed);
        let approx = false;
        let via = null;
        let gap = Infinity;
        for (let dx = -3; dx <= 3; dx++) {
          for (let dz = -3; dz <= 3; dz++) {
            if (!isTarnZone(rx + dx, rz + dz, seed)) continue;
            const c = tarnZoneCenter(rx + dx, rz + dz);
            if (Math.hypot(s.cx - c.cx, s.cz - c.cz) < SNOW_HALF + TARN_ZONE_RADIUS) approx = true;
            const gx = Math.max(0, Math.abs(s.cx - c.cx) - SNOW_HALF);
            const gz = Math.max(0, Math.abs(s.cz - c.cz) - SNOW_HALF);
            const g = Math.hypot(gx, gz);
            if (g < gap) { gap = g; via = [rx + dx, rz + dz]; }
          }
        }
        if (!approx && via) {
          out.push({ rx, rz, via, gap, seed });
          if (out.length >= 3) return out;
        }
      }
    }
  }
  return out;
}

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
 *
 * 需要压制的字段全集（文档性清单，不参与断言）：
 *   `pyramid` / `frozenMountain` / `plainLand` / `island` / `city` / `giantPyramid` / `mesa`
 * 实际断言在各字段的**压制前探测函数**上（见下方 `FIELD_PROBE`）—— 只对「压制前有值」的
 * 字段断言 null，否则断言没有判别力。`city` 刻意不在 `FIELD_PROBE` 里：它只存在于
 * region(0,0)，而那是 `CITY_REGION`，早已被排除出地带判定（`isTarnZone(0,0,*) ≡ false`），
 * 任何地带 region 的 `layout.city` 都是 null —— 把它写进断言就是恒真。
 */

test('地带接线：地带 region 的全部地标字段被压缩为 null（雪原例外）', () => {
  // ⚠️ **不能只在 findTarnRegion 那一个 region 上断言 7 个字段全 null**（那是个空断言形态）：
  // 实测 region(-6,-2) 在**压制前**就只有 pyramid / frozenMountain 有值，其余 5 个字段
  // （plainLand / island / giantPyramid / mesa / city）**本来就是 null** ⇒ 删掉压制代码
  // 那些断言也照样绿。`city` 更是恒真：它只存在于 region(0,0)，而那是 CITY_REGION，
  // 早已被排除出地带判定（`isTarnZone(0,0,*) ≡ false`）。
  //
  // 现在的口径：**全扫 ±6 的每个地带 region**，对每个字段先算「压制前本来有没有值」——
  // 有值的那些才断言 layout 里是 null。末尾再断言「至少命中 N 个有值→null 的对照」，
  // 否则取样口径被改窄后这条用例会静默失去判别力。
  const FIELD_PROBE = {
    pyramid: (rx, rz) => getPyramidCenterInRegion(rx, rz, SEED),
    frozenMountain: (rx, rz) => getFrozenMountainCenterInRegion(rx, rz, SEED),
    plainLand: (rx, rz) => {
      const p = getPlainLandCenterInRegion(rx, rz, SEED);
      return isPlainLandValid(p.cx, p.cz, SEED) ? p : null;
    },
    island: (rx, rz) => {
      const i = getIslandCenterInRegion(rx, rz, SEED);
      return isIslandValid(i.islandCx, i.islandCz, SEED) ? i : null;
    },
    giantPyramid: (rx, rz) => computeGiantPyramidAnchor(rx, rz, SEED),
  };

  let tarnRegions = 0;
  const proven = new Map();   // 字段 → 「压制前有值 → layout 为 null」的命中次数
  let checked = 0;
  // ⚠️ **扫 ±12 而不是 ±6**（v1.90）：稀有化后 ±6 只剩 6 个地带 region，
  //    而各字段的「压制前有值」命中率本身就不高（plainLand/island/giantPyramid 大部分 region
  //    本来就没值）⇒ ±6 下「有判别力的对照」只剩个位数，原来的 ≥40 下界必然 FAIL。
  //    ±12（625 region）实测地带 27 个，对照数抬到可用量。
  for (let rx = -12; rx <= 12; rx++) {
    for (let rz = -12; rz <= 12; rz++) {
      if (!isTarnZone(rx, rz, SEED)) continue;
      tarnRegions++;
      const lay = computeRegionLayout(rx, rz, SEED);
      assertTrue(lay.tarn !== null && lay.tarn !== undefined,
        `地带 region(${rx},${rz}) 的 layout 必须带 tarn 布局`);
      for (const [field, probe] of Object.entries(FIELD_PROBE)) {
        if (probe(rx, rz) === null) continue;          // 压制前就没有 ⇒ 这条测不出东西
        checked++;
        assertEqual(lay[field], null,
          `地带 region(${rx},${rz}) 的 ${field} 压制前有值，必须被压成 null`);
        proven.set(field, (proven.get(field) || 0) + 1);
      }
    }
  }
  assertTrue(tarnRegions >= 15, `±12 内地带 region 只有 ${tarnRegions} 个 —— 取样口径被改窄了`);
  // 判别力下界：实测 pyramid/frozenMountain 在多数地带 region 上有值；
  // 若将来某个字段的压制被删掉，`proven` 里该字段会缺项 ⇒ 下面的断言会红。
  // ⚠️ 下界随「地带变稀」同步下调（旧值 40/20/10 是 ±6 + 旧判定的口径，现在 ±12 下
  //    tarnRegions≈27，对照数按同比例下调）。
  assertTrue(checked >= 15,
    `「压制前有值→layout 为 null」的对照只有 ${checked} 条（应 ≥15）—— 断言可能退化成空壳`);
  assertTrue((proven.get('pyramid') || 0) >= 10,
    `pyramid 的有判别力对照只有 ${proven.get('pyramid') || 0} 条（应 ≥10）`);
  assertTrue((proven.get('frozenMountain') || 0) >= 5,
    `frozenMountain 的有判别力对照只有 ${proven.get('frozenMountain') || 0} 条（应 ≥5）`);

  // `snowLand` 与 `pyramidRaw` 必须保留：在任一个地带 region 上验一次即可
  // （它们的语义是「字段常驻」，不是「压制到 null」）。
  const first = findTarnRegion(SEED);
  const lay0 = computeRegionLayout(first.rx, first.rz, SEED);
  assertTrue(lay0.snowLand && typeof lay0.snowLand.cx === 'number',
    '地带 region 的 snowLand 字段必须保留（它有独立判据 snowLandSuppressedByTarn）');
  assertTrue(lay0.pyramidRaw && typeof lay0.pyramidRaw.cx === 'number',
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

test('地带接线：杜鹃候选**不**整块清空 —— 圆内剔除、圆外保留（v2.3）', () => {
  // ⚠️ **这是与撒布/巨树/空岛相反的语义，不要去「对齐」它们**：
  // 地带圆半径 138 只覆盖 400×400 region 的 37.4%，整块清空会把圆外 62.6% 的合法杜鹃树
  // 一并抹掉 —— 实测 seed 12345 的 region(2,0) 28 个候选**全部在圆外**，
  // 整块清空后那里留下 104×91 格纯草地（用户 2026-10-28：「大片空地没有渲染出树」）。
  // 而 `pointContext` 本来就只对**圆心内**返回 `kind:'tarn'`，圆外是普通地形。
  const tarnRegions = [];
  for (let rx = -6; rx <= 6 && tarnRegions.length < 4; rx++) {
    for (let rz = -6; rz <= 6 && tarnRegions.length < 4; rz++) {
      if (isTarnZone(rx, rz, SEED)) tarnRegions.push({ rx, rz });
    }
  }
  assertTrue(tarnRegions.length > 0, '找到地带 region');

  let totalCandidates = 0, insideCircle = 0, outsideCircle = 0;
  for (const { rx, rz } of tarnRegions) {
    const lay = computeRegionLayout(rx, rz, SEED);
    const arr = lay.azaleaTrees;
    assertTrue(arr instanceof Int32Array, `地带 region(${rx},${rz}) 的 azaleaTrees 必须是 Int32Array`);
    for (let i = 0; i < arr.length; i += 4) {
      totalCandidates++;
      const d = Math.hypot(arr[i] - lay.tarn.cx, arr[i + 2] - lay.tarn.cz);
      if (d < TARN_ZONE_RADIUS) insideCircle++; else outsideCircle++;
    }
  }
  // 主判据：圆内**必须**为 0（台地要干净），圆外**必须**有（不是整块清空）
  assertEqual(insideCircle, 0,
    `地带圆内不得有杜鹃候选（实测 ${insideCircle} 棵；台地上不能长树）`);
  assertTrue(outsideCircle > 0,
    `地带 region 的圆外**必须**保留杜鹃候选（实测 ${outsideCircle} 棵）—— ` +
    '整块清空会让圆外 62.6% 的合法地点变成大片空地（v2.3 修掉的缺陷）');
  // 下界：判别力（否则「圆外 > 0」可能被偶然一个点蒙过）
  assertTrue(totalCandidates >= 10,
    `四个地带 region 合计候选 ${totalCandidates} 棵（判据必须有量）`);
});

test('地带接线：非地带且雪原未让路的 region 逐字段零回归（压制不得漏到别处）', () => {
  // ⚠️ 口径必须**三方收窄**（每一个都会合法地压掉 `pyramid` / `frozenMountain`）：
  //    ① 跳过 `isTarnZone` 的 region（那些**应当**被压制）
  //    ② 跳过 `snowLandSuppressedByTarn` 的 region（那些的雪原在 apply 阶段被跳过，
  //       但 `layout.snowLand` 字段本身**照旧有值** —— 本条只钉字段级零回归，不看 apply）
  //    ③ **跳过被浅水高台压制的地标**（v2.11）：那是第二张「地基级内容压过地标」的地图，
  //       压制粒度是**逐地标**（`shallowTarnSuppressedLandmarks`）而不是逐 region ——
  //       湖跨 2~3 个 region，按 region 判会压错与漏压两头（见该函数注释）。
  //       不跳过的话，湖区那几个 region 的 `pyramid` 合法为 null 而断言要求非 null → 假 FAIL。
  //    ④ **跳过被大竞技场压制的字段**（v2.85）：第三张「地基级内容压过地标」的地图，
  //       同为逐地标粒度（`burningArenaSuppressedLandmarks`）。它比浅水高台多压两项 ——
  //       `giantPyramid` 与 `skyIslands`（塔高 80 格会撞空岛，用户裁定「空岛给大竞技场让路」），
  //       故跳过判据要把本用例断言的**全部四个字段**都算上，漏一项就是假 FAIL。
  //    若不收窄，断言「pyramid 非空」在那些 region 上必然 FAIL。
  const shallowAnchor = computeShallowTarnAnchor(SEED);
  const burningArenaAnchor = computeBurningArenaAnchor(SEED);
  let checked = 0;
  for (let rx = -4; rx <= 4; rx++) {
    for (let rz = -4; rz <= 4; rz++) {
      if (isTarnZone(rx, rz, SEED)) continue;
      if (snowLandSuppressedByTarn(rx, rz, SEED)) continue;
      if (shallowAnchor) {
        const sup = shallowTarnSuppressedLandmarks(shallowAnchor, rx, rz, SEED);
        if (sup.pyramid || sup.frozenMountain) continue;
      }
      if (burningArenaAnchor) {
        const sup = burningArenaSuppressedLandmarks(burningArenaAnchor, rx, rz, SEED);
        if (sup.pyramid || sup.frozenMountain || sup.giantPyramid || sup.skyIslands) continue;
      }
      const lay = computeRegionLayout(rx, rz, SEED);
      assertEqual(lay.tarn, null, `非地带 region(${rx},${rz}) 的 tarn 必须是 null`);
      // 对照侧：直接调用候选函数（与 layout 内部**同一份**实现，所以这条钉的是「layout
      // 有没有把它传下去 / 有没有多压一层」，不是候选函数本身算得对不对 —— 后者由各自的
      // test-mesa / test-giant-pyramid / test-scatter 等文件钉住）。
      const direct = {
        giantPyramid: computeGiantPyramidAnchor(rx, rz, SEED),
        // `pyramid` / `frozenMountain` 是**被 `tarn ? null : …` 直接改写的那两个字段**
        // （structure-layout.js:50-51），所以它们是零回归语料里判别力最强的 ——
        // 漏掉它们只比 mesa / giantPyramid 意义有限（那两项在本区大多是 null）。
        pyramid: getPyramidCenterInRegion(rx, rz, SEED),
        frozenMountain: getFrozenMountainCenterInRegion(rx, rz, SEED),
      };
      for (const field of ['giantPyramid', 'pyramid', 'frozenMountain']) {
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
  // ⚠️ **取样点改为程序化找**（v1.90）：旧版硬编码 (-6,0) 让路 / (-4,-1) 不让路，
  //    而新判定下 seed 12345 的 ±6 窗口**根本没有一个被让路的 region** —— 硬编码必然失效。
  //    现在在 `SNOW_SEED`（seed 4，实测 5 个被让路）上实时筛出一对对照。
  const reg = buildRegistry();
  const snowIds = new Set(['snow_grass', 'snow'].map((n) => reg.idOf(n)).filter((x) => x !== undefined));
  const countSnowAtSnowCenter = async (rx, rz, seed) => {
    const lay = computeRegionLayout(rx, rz, seed);
    const cx = Math.floor(lay.snowLand.cx / 16), cz = Math.floor(lay.snowLand.cz / 16);
    const col = new ChunkColumn(cx, cz);
    const layouts = [];
    for (const key of neighborRegionKeys(cx, cz)) {
      const [nrx, nrz] = key.split(',').map(Number);
      layouts.push(computeRegionLayout(nrx, nrz, seed));
    }
    await applyStructuresToColumn(col, seed, reg, layouts);
    let n = 0;
    for (let i = 0; i < col.blocks.length; i++) if (snowIds.has(col.blocks[i])) n++;
    return { n, cx, cz };
  };

  // 找一对：一个被让路、一个不被让路（两者都得是「雪原会真的生成」的位置）
  let suppressedCase = null;
  let keptCase = null;
  for (let rx = -6; rx <= 6 && (!suppressedCase || !keptCase); rx++) {
    for (let rz = -6; rz <= 6 && (!suppressedCase || !keptCase); rz++) {
      if (rx === SNOW_SEED - SNOW_SEED && rz === 0) continue;
      const isSup = snowLandSuppressedByTarn(rx, rz, SNOW_SEED);
      if (isSup && !suppressedCase) suppressedCase = { rx, rz };
      if (!isSup && !keptCase) keptCase = { rx, rz };
    }
  }
  assertTrue(suppressedCase !== null, `seed ${SNOW_SEED} 的 ±6 没有「雪原被让路」的样本 —— 须重新标定`);
  assertTrue(keptCase !== null, `seed ${SNOW_SEED} 的 ±6 没有「雪原保留」的样本 —— 须重新标定`);

  const suppressed = await countSnowAtSnowCenter(suppressedCase.rx, suppressedCase.rz, SNOW_SEED);
  assertEqual(suppressed.n, 0,
    `region(${suppressedCase.rx},${suppressedCase.rz}) 的雪原已被让路，雪原中心 column(${suppressed.cx},${suppressed.cz}) 不得有积雪方块（实测 0）`);

  const kept = await countSnowAtSnowCenter(keptCase.rx, keptCase.rz, SNOW_SEED);
  assertTrue(kept.n > 200,
    `region(${keptCase.rx},${keptCase.rz}) 的雪原照旧生成，雪原中心 column(${kept.cx},${kept.cz}) 应满 column（实测 256，得 ${kept.n}）`);
});
