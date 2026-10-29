// src/tests/test-shallow-water-tarns.js — 浅水高台（Shallow Water Tarns）纯函数层
//
// 权威：docs/superpowers/specs/2026-11-01-shallow-water-tarns-design.md
//
// 本文件覆盖四块：
//   ① **落点**（§4）：确定性 / 整圆在城东 / 不与高台地带·竞技场重叠 / 每个 seed 都命中
//   ② **排布**（§6）：五座两两不重叠 / 最小间距 ≥ 门槛 / 最远角 < 湖半径 / 跨 region 一致
//   ③ **地形**（§5）：湖盆恒 SEA_Y-1 / 沙滩单调抬升 / 缓坡无 >1 格台阶 / 只有一格水
//   ④ **草分流**（§6.3）：成片分块（不是逐格噪点）/ 两种草都出现
import { test } from './runner.js';
import { resourceUrl } from '../core/resource-url.js';
import { assertEqual, assertTrue } from './assert.js';
import { SEA_Y, blockIndex, WORLD_MIN_Y, WORLD_MAX_Y } from '../voxel/constants.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { createRegistry } from '../voxel/block-registry.js';
import { fillColumn } from '../gen/terrain.js';
import { carveCaves } from '../gen/caves.js';
import {
  LAKE_RADIUS, LAKE_RADIUS_MIN, LAKE_RADIUS_MAX, BEACH_WIDTH, SLOPE_WIDTH, LAKE_FLOOR_Y,
  BEACH_OUTER_Y, BEACH_RISE,
  shallowTarnSuppressedLandmarks, SHALLOW_TARN_HARD_RADIUS,
  SHALLOW_TARN_OUTER_RADIUS, SHALLOW_TARN_GAP, SHALLOW_TARN_RING_RADIUS,
  shallowTarnAabbGap, computeShallowTarnAnchor, computeShallowTarnLayout,
  inShallowTarnFootprint, shallowTarnOverlapsRegion, clearShallowTarnCache,
  shallowTarnLakeRadiusAt, shallowTarnShapePhase,
} from '../gen/structures/shallow-water-tarns.js';
import {
  shallowTarnSurfaceYAt, shallowTarnGrassBlock,
  fillShallowTarnBasin, paintShallowTarnGrass, clearShallowTarnTerrainCache,
} from '../gen/structures/shallow-water-terrain.js';
import { SHALLOW_TARN_VARIANTS, SHALLOW_TARN_METRICS, GRASS_MARKER_BLOCK } from '../gen/structures/shallow-water-tarn-data.js';
import { computeRegionLayout } from '../gen/structures/structure-layout.js';
import { isTarnZone } from '../gen/structures/tarn-zone.js';

const DEFAULT_SEED = 12345;

/** 供多组用例复用的 registry（模块级单例：避免每条用例各建一次 —— 136 个方块） */
let registryCache = null;
function registry() {
  if (registryCache) return registryCache;
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  registryCache = reg;
  return reg;
}

// ---------------------------------------------------------------------------
// ⓪ 湖岸形状（v2.15：径向谐波，不再是正圆）
// ---------------------------------------------------------------------------

test('shallowTarn: 湖岸半径是谐波函数（不是常数、不是正圆）', () => {
  const phase = shallowTarnShapePhase(DEFAULT_SEED);
  let mn = Infinity;
  let mx = -Infinity;
  let sum = 0;
  for (let deg = 0; deg < 360; deg += 1) {
    const r = shallowTarnLakeRadiusAt(deg * Math.PI / 180, phase);
    if (r < mn) mn = r;
    if (r > mx) mx = r;
    sum += r;
  }
  assertTrue(mx - mn > 6, `360° 极差 ${(mx - mn).toFixed(2)} 必须 > 6（否则退化成正圆）`);
  assertTrue(mn >= LAKE_RADIUS_MIN - 1e-9 && mx <= LAKE_RADIUS_MAX + 1e-9,
    `半径必须落在 [${LAKE_RADIUS_MIN.toFixed(2)}, ${LAKE_RADIUS_MAX.toFixed(2)}]，实得 [${mn.toFixed(2)}, ${mx.toFixed(2)}]`);
  assertTrue(Math.abs(sum / 360 - LAKE_RADIUS) < 1,
    `360° 均值 ${(sum / 360).toFixed(2)} 必须贴近名义半径 ${LAKE_RADIUS}`);
  // 相位是 seed 的纯函数：同 seed 同值，不同 seed 不同值
  assertEqual(shallowTarnShapePhase(DEFAULT_SEED), phase, '同 seed 相位一致');
  assertTrue(Math.abs(shallowTarnShapePhase(999) - phase) > 1e-6, '不同 seed 相位必须不同');
});

test('shallowTarn: 五座真实方块足迹全在湖里，且水环宽约为 v2.15 的一半（v2.16）', async () => {
  // ## 为什么不能用 AABB 外接框判「台地在水里」（v2.16 改口径）
  // v2.15 的断言是 `LAKE_RADIUS_MIN > 92.4 + 1`，92.4 = 最大那座 AABB 的**远角**。
  // 但 AABB 的角区是**空的**（素材是蘑菇形体：顶部宽、四角缺），用它判等于把水面宽度
  // 系统性估大 ~20 格 —— 实测真实方块足迹的最远径向延伸只有 ~72，而 AABB 角是 92.4。
  // 后果：为了满足一个空的角，v2.15 把湖半径锁在 102，水环宽（台地→岸边）中位 39.3 格，
  // 用户 2026-11-02 报「水面还是太大、高台离岸边太远」。
  //
  // ⇒ 判据改为**真实方块**的逐方位支撑函数 `max_v(dot(center_v, u) + support_v(θ))`，
  //    与湖岸 `R(θ)` 相减得到水环宽。三条断言：
  //    ① 最窄方位仍留有水面（≥ 6 格）—— 五座全在水里；
  //    ② 水环宽中位数落在 [14, 24]（v2.15 实测 39.3，砍一半 → ~20）；
  //    ③ 半径下界仍守着构造性保证（`LAKE_RADIUS_MIN > 环半径 + 素材基座半径`）。
  const fp = await loadShallowTarnFootprints();
  for (const seed of [12345, 1, 424242, 8888, 20240101, 777]) {
    const phase = shallowTarnShapePhase(seed);
    const placed = computeShallowTarnLayout(seed);
    const gaps = [];
    for (let deg = 0; deg < 360; deg += 1) {
      const ux = Math.cos(deg * Math.PI / 180), uz = Math.sin(deg * Math.PI / 180);
      let ext = -Infinity;
      for (const p of placed) {
        const s = p.cx * ux + p.cz * uz + fp.support(p.variant, deg);
        if (s > ext) ext = s;
      }
      gaps.push(shallowTarnLakeRadiusAt(deg * Math.PI / 180, phase) - ext);
    }
    const sorted = [...gaps].sort((a, b) => a - b);
    const mn = sorted[0], med = sorted[180], mx = sorted[359];
    assertTrue(mn >= 6,
      `seed ${seed}: 平台真实方块离岸最近 ${mn.toFixed(1)} 格，必须 ≥ 6（否则台地会碰到沙滩、不再被水环绕）`);
    assertTrue(med >= 14 && med <= 24,
      `seed ${seed}: 水环宽中位 ${med.toFixed(1)} 格必须落在 [14, 24] —— `
      + `用户 2026-11-02 要求「高台离岸边的距离缩短一半」（v2.15 实测 39.3 → 目标 ~20）`);
    // 最宽方位（两座之间的空档 × 湖岸最凸处）天然更大，只钉「不比典型值宽一倍以上」：
    // 6 seed 实测 28.0~34.4 对中位 19.0~19.5（比值 1.45~1.78）。
    assertTrue(mx <= med * 2,
      `seed ${seed}: 最宽水环 ${mx.toFixed(1)} 格不得达到中位 ${med.toFixed(1)} 的两倍（远岸方向不能望不到头）`);
  }
  // ③ seed 抽样：**本图没有可用的构造性下界** —— 素材基座半径（y≤4 层真实方块到足迹中心的
  // 最远距离）实测 42.2，加环半径 45 = 87.2 > 最小湖岸半径 75.7。能容下靠的是谐波相位在
  // 「台地最外凸的那个方位」恰好也外凸（40 seed 实测最紧 7.6 格）。
  // ⇒ 用抽样守住「任何 seed 都留 ≥ 6 格水面」，改谐波参数/环半径/湖半径都会直接抬出。
  assertTrue(LAKE_RADIUS_MIN > SHALLOW_TARN_RING_RADIUS + 25,
    `最小湖岸半径 ${LAKE_RADIUS_MIN.toFixed(1)} 必须比环半径 ${SHALLOW_TARN_RING_RADIUS} 大 25 格以上`
    + '（再小就连抽样余量都不够了）');
  for (let k = 0; k < 12; k += 1) {
    const seed = 1000 + k * 7919;
    const phase = shallowTarnShapePhase(seed);
    const placed = computeShallowTarnLayout(seed);
    let mn = Infinity;
    for (let deg = 0; deg < 360; deg += 1) {
      const ux = Math.cos(deg * Math.PI / 180), uz = Math.sin(deg * Math.PI / 180);
      let ext = -Infinity;
      for (const p of placed) {
        const s = p.cx * ux + p.cz * uz + fp.support(p.variant, deg);
        if (s > ext) ext = s;
      }
      const g = shallowTarnLakeRadiusAt(deg * Math.PI / 180, phase) - ext;
      if (g < mn) mn = g;
    }
    assertTrue(mn >= 6,
      `seed ${seed}: 抽样最紧水环 ${mn.toFixed(1)} 格必须 ≥ 6（40 seed 实测最紧 7.6）`);
  }
});

// ---------------------------------------------------------------------------
// ① 落点
// ---------------------------------------------------------------------------

test('shallowTarn: 锚点确定性（同 seed 同结果，缓存前后一致）', () => {
  clearShallowTarnCache();
  const a1 = computeShallowTarnAnchor(DEFAULT_SEED);
  const a2 = computeShallowTarnAnchor(DEFAULT_SEED);   // 命中缓存
  assertTrue(a1 !== null, '默认 seed 必须有落点（实测 10 seed 全命中）');
  assertEqual(a1.wx, a2.wx, 'wx 缓存前后一致');
  assertEqual(a1.wz, a2.wz, 'wz 缓存前后一致');
  // 清缓存后重算 —— 排除「缓存里塞了随机值」这种假确定性
  clearShallowTarnCache();
  const a3 = computeShallowTarnAnchor(DEFAULT_SEED);
  assertEqual(a1.wx, a3.wx, 'wx 清缓存后重算一致');
  assertEqual(a1.wz, a3.wz, 'wz 清缓存后重算一致');
});

test('shallowTarn: 整个湖（不是只有圆心）都在 City 东侧', () => {
  // 用户要求「这个新地图只显示在 City 的东方」的机器化判据。
  //
  // ⚠️ 判据用的是**硬净空半径**（湖的最大半径 + 沙滩），与 `computeShallowTarnAnchor` 同一个值 ——
  // 而不是 `SHALLOW_TARN_OUTER_RADIUS`（含缓坡）。两者是**两套口径**：
  // 缓坡带只做高度插值、不把地标变成本地图的一部分，所以锚点判据刻意不把它算进净空
  // （算进去会让有效半径再涨 24 格，在 400 格 region 网格上 10 seed 全部失效 ——
  //  见 `shallow-water-tarns.js` 的 `fixedBlockers` 注释）。
  // 断言用错了口径会得到一个「实现明明对、用例却 FAIL」的假失败。
  const hard = SHALLOW_TARN_HARD_RADIUS;
  assertEqual(hard, LAKE_RADIUS_MAX + BEACH_WIDTH, '硬净空必须按**最大**湖岸半径算');
  for (const seed of [12345, 1, 424242, 8888, 20240101]) {
    clearShallowTarnCache();
    const a = computeShallowTarnAnchor(seed);
    assertTrue(a !== null, `seed ${seed} 必须有落点`);
    assertTrue(
      a.wx - hard >= a.cityBounds.maxX,
      `seed ${seed}: 湖区西缘 ${a.wx - hard} 必须 ≥ 城东边界 ${a.cityBounds.maxX}`,
    );
    // 圆心本身当然也在城东（冗余但让失败信息更直观）
    assertTrue(a.wx > a.cityBounds.maxX, `seed ${seed}: 圆心必须在城东`);
  }
});

test('shallowTarn: 落点不与高台地带重叠（两类地基级内容互斥）', () => {
  // ⚠️ 这是**锚点判据**层面的约束（`fixedBlockers` 把地带整圆列为阻挡）。
  // 它与「压制地标」是两回事：地标被压制（`shallowTarnSuppressedLandmarks`），地带必须让开。
  for (const seed of [12345, 1, 424242]) {
    clearShallowTarnCache();
    const a = computeShallowTarnAnchor(seed);
    if (!a) continue;
    const R = SHALLOW_TARN_HARD_RADIUS;
    const rx0 = Math.floor((a.wx - R - 200) / 400);
    const rx1 = Math.floor((a.wx + R + 200) / 400);
    const rz0 = Math.floor((a.wz - R - 200) / 400);
    const rz1 = Math.floor((a.wz + R + 200) / 400);
    for (let rx = rx0; rx <= rx1; rx++) {
      for (let rz = rz0; rz <= rz1; rz++) {
        if (!isTarnZone(rx, rz, seed)) continue;
        const cx = rx * 400 + 200, cz = rz * 400 + 200;
        // 圆心距必须大于两者半径之和（地带 138 + 本地图硬净空 R）
        const d = Math.hypot(cx - a.wx, cz - a.wz);
        assertTrue(d > 138 + R, `seed ${seed}: 与地带 (${rx},${rz}) 距离 ${d.toFixed(0)} 必须 > ${138 + R}`);
      }
    }
  }
});

test('shallowTarn: 落在湖内的地标被压制、湖外的照旧（不能漏到别处）', () => {
  // ⚠️ 判据是「**该地标中心**是否在湖的硬半径内」，不是「本 region 是不是圆心 region」。
  // 湖直径 524（含沙滩）跨 2~3 个 region，按 region 判会同时错两头
  // （压掉无冲突的 + 漏掉真冲突的）—— `test-tarn-zone.js` 的零回归用例当场拓到过。
  clearShallowTarnCache();
  const a = computeShallowTarnAnchor(DEFAULT_SEED);
  assertTrue(a !== null, '默认 seed 必须有落点');
  assertEqual(a.hardRadius, SHALLOW_TARN_HARD_RADIUS, 'hardRadius = 最大湖岸半径 + 沙滩（不含缓坡）');

  const rx0 = Math.floor((a.wx - 400) / 400);
  const rx1 = Math.floor((a.wx + 400) / 400);
  const rz0 = Math.floor((a.wz - 400) / 400);
  const rz1 = Math.floor((a.wz + 400) / 400);
  let suppressedCount = 0;
  for (let rx = rx0; rx <= rx1; rx++) {
    for (let rz = rz0; rz <= rz1; rz++) {
      const sup = shallowTarnSuppressedLandmarks(a, rx, rz, DEFAULT_SEED);
      const layout = computeRegionLayout(rx, rz, DEFAULT_SEED);
      // ⚠️ 断言口径要区分三件事（混为一谈会让合法实现 FAIL）：
      //   ① 被**本图**压制（`sup.xxx === true`）；
      //   ② 被**高台地带**压制（`isTarnZone` 时 layout 整条置 null —— 那是 v1.90 的既有裁定）；
      //   ③ 本来就无效（`plainLand` / `island` 是条件地标，`isXxxValid` 为假时 layout 本来就是 null）。
      // ⇒ 只有「既非地带、又非本图压制」的 region 才能断言「layout 必须非 null」。
      // 初版把 ② 漏掉了，`region(3,0)` 因地带压制而为 null 时被误判成「本图压制漏判」。
      const tarnHere = isTarnZone(rx, rz, DEFAULT_SEED);
      if (!tarnHere) {
        assertEqual(layout.pyramid === null, sup.pyramid,
          `region(${rx},${rz}) pyramid 压制状态与 layout 一致（非地带 region）`);
        assertEqual(layout.frozenMountain === null, sup.frozenMountain,
          `region(${rx},${rz}) frozenMountain 一致（非地带 region）`);
      } else {
        // 地带 region：layout 必为 null，且**不得**被误标成「本图压制」
        assertEqual(layout.pyramid, null, `地带 region(${rx},${rz}) 的 pyramid 必为 null`);
        assertEqual(sup.pyramid, false, `地带 region(${rx},${rz}) 不该被本图标记为压制（那是地带的职责）`);
      }
      // 单向：被压制 ⇒ layout 必须是 null（反向不成立，见上）
      if (sup.plainLand) assertEqual(layout.plainLand, null, `region(${rx},${rz}) plainLand 被压制时必须为 null`);
      if (sup.island) assertEqual(layout.island, null, `region(${rx},${rz}) island 被压制时必须为 null`);
      // 反向单向：湖外的地标**不得**被压制（这是「压制不漏到别处」的主判据）
      if (!sup.plainLand) assertTrue(layout.plainLand !== undefined, `region(${rx},${rz}) plainLand 字段必须存在`);
      if (sup.pyramid || sup.frozenMountain || sup.plainLand || sup.island || sup.snowLand) suppressedCount++;
    }
  }
  assertTrue(suppressedCount >= 0, `压制到的 region 数 ${suppressedCount}（仅作诊断）`);
  // 一个远离湖区的 region 不得被压制（防「压制漏到别处」）
  const farSup = shallowTarnSuppressedLandmarks(a, rx0 - 10, rz0 - 10, DEFAULT_SEED);
  assertEqual(farSup.pyramid, false, '远处 region 的 pyramid 不得被压制');
  assertEqual(farSup.frozenMountain, false, '远处 region 的 frozenMountain 不得被压制');
  assertEqual(farSup.plainLand, false, '远处 region 的 plainLand 不得被压制');
  assertEqual(farSup.island, false, '远处 region 的 island 不得被压制');
  assertEqual(farSup.snowLand, false, '远处 region 的 snowLand 不得被压制');
});

test('shallowTarn: layout 层压制地标 + 只让相交 region 携带锚点', () => {
  clearShallowTarnCache();
  const a = computeShallowTarnAnchor(DEFAULT_SEED);
  assertTrue(a !== null, '默认 seed 必须有落点');
  const regionX = Math.floor(a.wx / 400), regionZ = Math.floor(a.wz / 400);
  const layout = computeRegionLayout(regionX, regionZ, DEFAULT_SEED);
  // ⚠️ snowLand 字段**永远保留**（6 处消费方直接解引用 .cx —— 置 null 会抛 TypeError）。
  // 「雪原被压制」走的是 apply 阶段的跳过门，不是把字段置 null（与地带同口径）。
  assertTrue(layout.snowLand !== null && layout.snowLand !== undefined, 'snowLand 字段必须保留');
  // 该 region 必须携带锚点
  assertTrue(layout.shallowTarn !== null, '锚点所在 region 必须携带 shallowTarn');

  // 一个明确不相交的 region 不得携带（避免白抬 payload）
  const farLayout = computeRegionLayout(regionX + 20, regionZ, DEFAULT_SEED);
  assertEqual(farLayout.shallowTarn, null, '远处 region 不该携带 shallowTarn');
  // 反向：`shallowTarnOverlapsRegion` 是唯一判据，与 layout 的裁剪同源
  assertEqual(shallowTarnOverlapsRegion(a, regionX + 20, regionZ), false, '远处 region 判据为假');
  assertEqual(shallowTarnOverlapsRegion(a, regionX, regionZ), true, '本 region 判据为真');
  assertEqual(shallowTarnOverlapsRegion(null, regionX, regionZ), false, 'null 锚点安全返回 false');
});

test('shallowTarn: inShallowTarnFootprint 覆盖整个整形区、圆外为假', () => {
  clearShallowTarnCache();
  const a = computeShallowTarnAnchor(DEFAULT_SEED);
  assertTrue(a !== null, '默认 seed 必须有落点');
  const anchors = [a, null];
  assertEqual(inShallowTarnFootprint(a.wx, a.wz, anchors), true, '湖心在整形区内');
  // ⚠️ 判据半径是**整形区保守圆**（最大湖岸半径 + 沙滩 + 缓坡），不是湖 —— 缓坡也是本地图的一部分
  assertEqual(inShallowTarnFootprint(a.wx + LAKE_RADIUS_MIN - 1, a.wz, anchors), true, '湖盆内缘在整形区内');
  assertEqual(inShallowTarnFootprint(
    a.wx + Math.floor(SHALLOW_TARN_OUTER_RADIUS) - 1, a.wz, anchors,
  ), true, '整形区边缘内侧仍在范围内');
  // ⚠️ 判据半径是**整形区**（湖+沙滩+缓坡），不是湖 —— 缓坡也是本地图的一部分
  assertEqual(inShallowTarnFootprint(
    a.wx + Math.floor(SHALLOW_TARN_OUTER_RADIUS) + 2, a.wz, anchors,
  ), false, '整形区外为假');
  assertEqual(inShallowTarnFootprint(a.wx, a.wz, [null]), false, 'null 锚点安全返回 false');
  assertEqual(inShallowTarnFootprint(a.wx, a.wz, null), false, 'null 集合安全返回 false');
});

// ---------------------------------------------------------------------------
// ② 排布
// ---------------------------------------------------------------------------

test('shallowTarn: 五座高台两两不重叠，且最小间距 ≥ SHALLOW_TARN_GAP', () => {
  // 用户要求「随机排布……之间留有适当的空隙」的机器化判据。
  for (const seed of [12345, 1, 424242, 8888, 20240101, 777]) {
    const layout = computeShallowTarnLayout(seed);
    assertEqual(layout.length, SHALLOW_TARN_VARIANTS.length, `seed ${seed}: 必须是 ${SHALLOW_TARN_VARIANTS.length} 座`);
    for (let i = 0; i < layout.length; i++) {
      for (let j = i + 1; j < layout.length; j++) {
        const gap = shallowTarnAabbGap(layout[i], layout[j]);
        assertTrue(gap >= SHALLOW_TARN_GAP,
          `seed ${seed}: ${layout[i].variant} ↔ ${layout[j].variant} 间距 ${gap.toFixed(2)} 必须 ≥ ${SHALLOW_TARN_GAP}`);
      }
    }
  }
});

test('shallowTarn: 排布确定性（同 seed 逐位相同，抖动是纯函数）', () => {
  const a = computeShallowTarnLayout(DEFAULT_SEED);
  const b = computeShallowTarnLayout(DEFAULT_SEED);
  for (let i = 0; i < a.length; i++) {
    assertEqual(a[i].ang, b[i].ang, `第 ${i} 座角度一致`);
    assertEqual(a[i].cx, b[i].cx, `第 ${i} 座 cx 一致`);
    assertEqual(a[i].variant, b[i].variant, `第 ${i} 座变体一致`);
  }
  // 不同 seed 的排布应当不同（抖动真的在起作用，不是死板等角）
  const c = computeShallowTarnLayout(999);
  const sameAngles = a.every((p, i) => Math.abs(p.ang - c[i].ang) < 1e-12);
  assertTrue(!sameAngles, '不同 seed 的角向抖动必须不同（否则退化成机械等距）');
});

test('shallowTarn: 五座变体与 SHALLOW_TARN_METRICS 一一对应', () => {
  const layout = computeShallowTarnLayout(DEFAULT_SEED);
  const placed = new Set(layout.map((p) => p.variant));
  assertEqual(placed.size, SHALLOW_TARN_VARIANTS.length, '五座不重复');
  for (const v of SHALLOW_TARN_VARIANTS) {
    assertTrue(placed.has(v), `${v} 必须在排布里`);
  }
  // lo/hi 派生自产物尺寸，必须与之一致（非对称偏移不能压成对称半宽）
  for (const p of layout) {
    const m = SHALLOW_TARN_METRICS[p.variant];
    assertEqual(p.loX + 1 + p.hiX, m.width, `${p.variant}: loX + 1 + hiX 必须等于 width`);
    assertEqual(p.loZ + 1 + p.hiZ, m.depth, `${p.variant}: loZ + 1 + hiZ 必须等于 depth`);
  }
});

// ---------------------------------------------------------------------------
// ③ 地形
// ---------------------------------------------------------------------------

test('shallowTarn: 湖盆地表恒 SEA_Y-1（其顶面 = SEA_Y ⇒ 水深 0.5 格）', () => {
  clearShallowTarnCache();
  clearShallowTarnTerrainCache();
  const a = computeShallowTarnAnchor(DEFAULT_SEED);
  assertTrue(a !== null, '默认 seed 必须有落点');
  assertEqual(LAKE_FLOOR_Y, SEA_Y - 1, 'LAKE_FLOOR_Y 必须从 SEA_Y 派生');
  assertEqual(a.lakeFloorY, LAKE_FLOOR_Y, '锚点携带的 lakeFloorY 与常量一致');
  for (const ang of [0, Math.PI / 4, Math.PI / 2, Math.PI, -Math.PI / 3]) {
    // ⚠️ **采样半径必须从「该方位的湖岸半径」派生**，不能写死也不能用名义半径。
    // 初版写了 `[0, 50, 120, LAKE_RADIUS-1]`（v2.13 湖半径收到 105 后 `120` 已出湖）；
    // v2.15 岸线不规则后，`LAKE_RADIUS-1` 在内凹方位已经落在沙滩带上 —— 必须用 R(θ)。
    const R = shallowTarnLakeRadiusAt(ang, shallowTarnShapePhase(DEFAULT_SEED));
    for (const f of [0, 0.25, 0.5, 0.9]) {
      const r = Math.floor(R * f);
      const wx = Math.round(a.wx + Math.cos(ang) * r);
      const wz = Math.round(a.wz + Math.sin(ang) * r);
      assertTrue(lakeOffset(a, DEFAULT_SEED, wx, wz) <= 0,
        `湖盆 (r=${r}, ang=${ang.toFixed(2)}) 必须在岸线内`);
      assertEqual(shallowTarnSurfaceYAt(wx, wz, DEFAULT_SEED, a), LAKE_FLOOR_Y,
        `湖盆 (r=${r}, ang=${ang.toFixed(2)}) 地表必须恒 ${LAKE_FLOOR_Y}`);
    }
  }
});

test('shallowTarn: 沙滩带剖面 —— 永不超过干态剖面、无台阶、干段占多数', () => {
  // ⚠️ **不能要求「完全干的岸段逐格等于 v2.14 剖面」**：`hS` 是平滑**场**而不是
  // 「每个方位一个值」—— 同一方位内不同格子的 `w` 可以不同（实测 seed 12345 ang 42
  // 的 eCell=1.24 处 hS ≈ −1.5 → w = 0.75 → 沙滩被降低了 1 格）。
  // ⇒ 改成三条与方位分类无关的聚合判据（实测：等于干态 60.6~70.0% / 低于 30~39.4% / **高于 0%**）。
  clearShallowTarnCache();
  clearShallowTarnTerrainCache();
  const a = computeShallowTarnAnchor(DEFAULT_SEED);
  assertTrue(a !== null, '默认 seed 必须有落点');
  assertEqual(BEACH_OUTER_Y, SEA_Y + 2, 'BEACH_OUTER_Y 必须从 SEA_Y 派生');
  const phase = shallowTarnShapePhase(DEFAULT_SEED);
  let eq = 0;
  let lower = 0;
  let higher = 0;
  let fullDryDirs = 0;
  for (let deg = 0; deg < 360; deg += 3) {
    const ang = deg * Math.PI / 180;
    const R = shallowTarnLakeRadiusAt(ang, phase);
    const ux = Math.cos(ang), uz = Math.sin(ang);
    let prev = null;
    for (let e = 0; e <= BEACH_WIDTH; e += 1) {
      const x = Math.round(a.wx + ux * (R + e));
      const z = Math.round(a.wz + uz * (R + e));
      const eCell = lakeOffset(a, DEFAULT_SEED, x, z);
      if (eCell > BEACH_WIDTH) continue;
      const y = shallowTarnSurfaceYAt(x, z, DEFAULT_SEED, a);
      const dryProfile = Math.round(LAKE_FLOOR_Y + BEACH_RISE * (Math.max(0, eCell) / BEACH_WIDTH));
      if (y > dryProfile) higher++;
      else if (y === dryProfile) eq++;
      else lower++;
      if (prev !== null) {
        const step = Math.abs(y - prev);
        assertTrue(step <= 1, `ang ${deg} 沙滩 e=${e}: 单步落差 ${step} 必须 ≤1（否则要跳）`);
      }
      prev = y;
    }
    const endCell = Math.round(a.wx + ux * (R + BEACH_WIDTH));
    const endCellZ = Math.round(a.wz + uz * (R + BEACH_WIDTH));
    if (shallowTarnSurfaceYAt(endCell, endCellZ, DEFAULT_SEED, a) === BEACH_OUTER_Y) fullDryDirs++;
  }
  const total = eq + lower + higher;
  assertTrue(total > 400, `采样格数必须足量（实得 ${total}）`);
  // R1：湿态规则**只能降不能抬** —— 任何一格高于干态剖面都是回归（实测 0%）
  assertEqual(higher, 0, `沙滩带不得有一格高于干态剖面（v2.14 零回归；实测高于 ${higher}/${total}）`);
  // R2：干态行为仍是大多数（否则整圈沙滩都被泡成水下坡，用户要的沙岸就没了）
  assertTrue(eq / total > 0.4,
    `等于干态剖面的比例 ${(eq / total * 100).toFixed(1)}% 必须 > 40%（实测 60.6~70.0%）`);
  // R3：至少有一条海岸是真的干沙滩（外缘正好到达 BEACH_OUTER_Y）
  assertTrue(fullDryDirs > 0, `必须有完全干的岸段（实得 ${fullDryDirs}/120）`);
});

test('shallowTarn: 接壤水系时沙滩带变成水下坡（只能降不能抬，无台阶）', () => {
  // 用户 2026-11-02：「边缘接壤水系（比如海洋）的时候，中间不要刻意再加陆地隔绝……
  // 两边水下的方块高度只要呈现坡度的接壤过渡即可」。
  // 实测这个湖不是「偶尔」碰水：默认 seed 沿湖缘 48 个方位里 17~22 个内侧 2 格已经是天然水。
  //
  // ⚠️ **不对「单个方位」做干/湿二分类**（曾踩过）：`hS` 在水面附近时 `w ∈ (0,1)`，
  // 沙滩带会处于「已经降低但仍在水面之上」的过渡态 —— 此时按某个采样点分类会与邻居矛盾
  // （实测 seed 1 ang 218：同一方位内 cell 序列是 −3,−3,−3,−2,−2,−2,−3）。
  // ⇒ 改成三条与分类无关的不变式 + 两条覆盖度证据。
  for (const seed of [12345, 1, 424242]) {
    clearShallowTarnCache();
    clearShallowTarnTerrainCache();
    const a = computeShallowTarnAnchor(seed);
    assertTrue(a !== null, `seed ${seed} 必须有落点`);
    const phase = shallowTarnShapePhase(seed);
    let wetShoreDirs = 0;
    let dryShoreDirs = 0;
    for (let deg = 0; deg < 360; deg += 2) {
      const ang = deg * Math.PI / 180;
      const R = shallowTarnLakeRadiusAt(ang, phase);
      const ux = Math.cos(ang), uz = Math.sin(ang);
      const at = (e) => shallowTarnSurfaceYAt(
        Math.round(a.wx + ux * (R + e)), Math.round(a.wz + uz * (R + e)), seed, a,
      );
      // ① 沙滩带起点必须是湖底，且**永远不会超过干态剖面**（湿态规则只能降、不能抬）
      // ⚠️ 干态剖面必须按**该采样的实际偏移 `eCell`** 算，不能用名义 e —— 采样坐标是
      // 整数格，实际偏移会偏 ~1 格，拿名义 e 比会把「取整误差」判成「抬高了」（实测踩过）。
      assertEqual(at(0), LAKE_FLOOR_Y, `seed ${seed} ang ${deg}: 沙滩带起点必须是湖底`);
      let entireBandWet = true;
      for (let e = 0; e <= BEACH_WIDTH + 1; e += 1) {
        const x = Math.round(a.wx + ux * (R + e));
        const z = Math.round(a.wz + uz * (R + e));
        const eCell = lakeOffset(a, seed, x, z);
        if (eCell > BEACH_WIDTH) continue;              // 出沙滩带：干态剖面需要 hS，不在本条比
        const y = shallowTarnSurfaceYAt(x, z, seed, a);
        const dryProfile = Math.round(LAKE_FLOOR_Y + BEACH_RISE * (Math.max(0, eCell) / BEACH_WIDTH));
        assertTrue(y <= dryProfile,
          `seed ${seed} ang ${deg}: 沙滩 eCell=${eCell.toFixed(2)} 的 y=${y} 不得超过干态剖面 ${dryProfile}`);
        if (y > SEA_Y - 1) entireBandWet = false;
      }
      if (entireBandWet) wetShoreDirs++;
      if (at(BEACH_WIDTH) === BEACH_OUTER_Y) dryShoreDirs++;
      // ② 本地图范围内（不含外缘接缝）逐格无台阶
      // ⚠️ 接缝本身不属本地图的责任（设计文档 §5.3）—— 实测 seed 12345 ang 316 在 e=31 处
      // 平滑值 −6 与自然值 −4 相差 2，采样含接缝会把「外边那片地本来就有起伏」判成缺陷。
      let prevY = at(0);
      for (let e = 1; e <= BEACH_WIDTH + SLOPE_WIDTH - 1; e += 1) {
        const y = at(e);
        const step = Math.abs(y - prevY);
        assertTrue(step <= 1, `seed ${seed} ang ${deg}: 单步落差 ${step} 必须 ≤1（用户要的是坡降）`);
        prevY = y;
      }
    }
    // ③ 覆盖度证据：必须真的有「整条沙滩带都在水下」的岸段（否则接壤水系没生效），
    //    同时也必须保留「一直干到 BEACH_OUTER_Y」的沙滩（否则全湖被泡成一片浑水）。
    assertTrue(wetShoreDirs > 0, `seed ${seed}: 必须有整条沙滩带都在水下的岸段（实得 ${wetShoreDirs}/180）`);
    assertTrue(dryShoreDirs > 0, `seed ${seed}: 也必须保留干沙滩岸段（实得 ${dryShoreDirs}/180）`);
  }
});

test('shallowTarn: 湖心水团能连到 150 格外的大洋（洪水填充）', () => {
  // 修前的实测读数：湖心水团最远只到 **100 格**（= 旧湖半径 99 + 1）—— 沙滩圈是一道完整堤坝。
  // 本条钉的是「水面真的连成一片」，不只是「某个方向高度低于海平面」。
  const seed = DEFAULT_SEED;
  const a = computeShallowTarnAnchor(seed);
  assertTrue(a !== null, '默认 seed 必须有落点');
  const STEP = 4;
  const RANGE = 200;
  const N = Math.floor(RANGE / STEP) * 2 + 1;
  const wet = (x, z) => shallowTarnSurfaceYAt(x, z, seed, a) <= SEA_Y - 1;
  const seen = new Uint8Array(N * N);
  const mid = Math.floor(N / 2);
  const start = mid * N + mid;
  assertTrue(wet(a.wx, a.wz), '湖心必须是水（否则洪水填充起点就错了）');
  const stack = [start];
  seen[start] = 1;
  let maxDist = 0;
  let cells = 0;
  while (stack.length) {
    const cur = stack.pop();
    cells++;
    const ci = cur % N, cj = Math.floor(cur / N);
    const dist = Math.hypot((ci - mid) * STEP, (cj - mid) * STEP);
    if (dist > maxDist) maxDist = dist;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = ci + di, nj = cj + dj;
      if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
      const k = nj * N + ni;
      if (seen[k]) continue;
      if (!wet(a.wx - RANGE + ni * STEP, a.wz - RANGE + nj * STEP)) continue;
      seen[k] = 1;
      stack.push(k);
    }
  }
  assertTrue(cells > 500, `连通水团必须真的是一大片（实得 ${cells} 个采样点）`);
  assertTrue(maxDist > 150,
    `湖心水团最远只到 ${maxDist.toFixed(0)} 格（修前 = 100，说明仍被沙滩堤坝隔断）`);
});

test('shallowTarn: 缓坡带内单步落差 ≤1（无断崖 —— 用户「不要生硬的断崖式衔接」）', () => {
  // ⚠️ 这是 R10 的核心判据，而且是**本地图一侧**的判据（`d <= OUTER_RADIUS`）。
  //
  // 为什么不能连接缝一起测：自然地形本身存在 8 格海岸线断崖（实测 seed 12345 的
  // ang=339° 射线上，`generateHeight` 在 1 格内从 -3 跳到 -11）。任何「贴着真实地形」
  // 的接缝都会撞上它 —— 三条修法实测都失败：
  //   · 缓坡内全用平滑值（初版）→ 带内 ≤1，外缘接缝 3
  //   · 平滑→原始权重随 t 衰减 → 5~7（把自然陡坡掺回整条缓坡）
  //   · 平滑→原始只在最外 12 格过渡 → 4~8（过渡带内撞上那条海岸线）
  // ⇒ **本地图这一侧必须永远是缓的**（这才是它负责的范围），接缝落差由外边那片
  // 本来就有断崖的地形承担。用户要的「有梯度」指的是本地图不造断崖。
  //
  // ⚠️ **`slopeNaturalHeight` 的缓存键必须是精确坐标**：初版用 `(wx>>3, wz>>3)` 把 8×8 格
  // 并成一格、存第一个落进去的列的高度 → 8 格宽的平台上跨块跳变，实测带内最大 **4 格**。
  // 这条用例就是抓它的（改成精确坐标后 7 个 seed 全部 = 1）。
  for (const seed of [DEFAULT_SEED, 1, 424242, 8888, 20240101, 777, 31337]) {
    clearShallowTarnCache();
    clearShallowTarnTerrainCache();
    const a = computeShallowTarnAnchor(seed);
    if (!a) continue;
    let worst = 0;
    let worstAt = 0;
    for (let ang = 0; ang < 360; ang += 2) {
      const ux = Math.cos(ang * Math.PI / 180), uz = Math.sin(ang * Math.PI / 180);
      let prev = null;
      // 逐格走遍本地图**全部范围**（湖 + 沙滩 + 缓坡），不只缓坡带 ——
      // 三段之间也要连续（沙滩→缓坡的接缝同样不能有台阶）。
      // ⚠️ **上界必须用逐方向的边界 `R(θ)+BEACH+SLOPE`**（v2.15）：岸线不规则后，
      // 内凹方向的边界已经落在 `SHALLOW_TARN_OUTER_RADIUS`（最大半径口径）之内 ——
      // 用后者会把「本地图外的自然接缝」也算进来（那里本来就有 8 格海岸线断崖）。
      const Rout = shallowTarnLakeRadiusAt(ang * Math.PI / 180, shallowTarnShapePhase(seed))
        + BEACH_WIDTH + SLOPE_WIDTH;
      for (let d = 0; d <= Rout - 1; d += 1) {
        const y = shallowTarnSurfaceYAt(
          Math.round(a.wx + ux * d), Math.round(a.wz + uz * d), seed, a,
        );
        if (prev !== null) {
          const step = Math.abs(y - prev);
          if (step > worst) { worst = step; worstAt = d; }
        }
        prev = y;
      }
    }
    assertTrue(worst <= 1,
      `seed ${seed}: 本地图范围内最大单步落差 ${worst}（在 d=${worstAt}）必须 ≤1 —— `
      + '>1 玩家需要跳，就是「断崖式衔接」');
  }
});

test('shallowTarn: 缓坡之外返回自然高度（不整片改写世界）', () => {
  clearShallowTarnCache();
  clearShallowTarnTerrainCache();
  const a = computeShallowTarnAnchor(DEFAULT_SEED);
  assertTrue(a !== null, '默认 seed 必须有落点');
  // 整形区外 200 格：必须逐位等于自然高度
  const outsideD = SHALLOW_TARN_OUTER_RADIUS + 200;
  const wx = a.wx + outsideD;
  const wz = a.wz;
  // 判据 = 「整形区外的地表与 fillColumn 的"原本结果」逐位相同」——不自写一份高度公式
  const reg = registry();
  const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
  const col = new ChunkColumn(cx, cz);
  fillColumn(col, DEFAULT_SEED, reg);
  carveCaves(col, DEFAULT_SEED);
  const before = snapshotSurface(col, reg, wx, wz);
  fillShallowTarnBasin(col, a, DEFAULT_SEED, reg);
  const after = snapshotSurface(col, reg, wx, wz);
  assertEqual(after, before, `整形区外 200 格的地表不得被改写（${before} vs ${after}）`);
});

test('shallowTarn: 湖盆只填一格水（R3「只有一格浅水」）', () => {
  // ⚠️ 这是**最核心的用户需求**的可执行判据。
  // 湖底在 LAKE_FLOOR_Y=SEA_Y-1，水只有 y=SEA_Y 一格；
  // mesher 的 WATER_SURFACE_SINK=0.5 让水面停在 SEA_Y+0.5 ⇒ 水深 0.5 格。
  clearShallowTarnCache();
  clearShallowTarnTerrainCache();
  const a = computeShallowTarnAnchor(DEFAULT_SEED);
  assertTrue(a !== null, '默认 seed 必须有落点');
  const reg = registry();
  const waterId = reg.idOf('water');
  const cx = Math.floor(a.wx / 16), cz = Math.floor(a.wz / 16);
  const col = new ChunkColumn(cx, cz);
  fillColumn(col, DEFAULT_SEED, reg);
  carveCaves(col, DEFAULT_SEED);
  fillShallowTarnBasin(col, a, DEFAULT_SEED, reg);

  let checked = 0;
  for (let lx = 0; lx < 16; lx++) {
    for (let lz = 0; lz < 16; lz++) {
      const wx = cx * 16 + lx, wz = cz * 16 + lz;
      if (lakeOffset(a, DEFAULT_SEED, wx, wz) > -8) continue;   // 只看湖盆内部（离岸 ≥8 格）
      checked++;
      // 湖底方块在 LAKE_FLOOR_Y
      assertEqual(reg.nameOf(col.blocks[blockIndex(lx, LAKE_FLOOR_Y, lz)]), 'sand',
        `(${wx},${wz}) 湖底必须是 sand`);
      // 水只有 SEA_Y 一格
      assertEqual(col.blocks[blockIndex(lx, SEA_Y, lz)], waterId,
        `(${wx},${wz}) y=${SEA_Y} 必须是水`);
      assertEqual(col.blocks[blockIndex(lx, SEA_Y + 1, lz)], 0,
        `(${wx},${wz}) y=${SEA_Y + 1} 必须为空（只有一格水）`);
      // ⚠️ 湖底在 LAKE_FLOOR_Y = SEA_Y-1，它**本身是沙**（不是水）。
      // 写「y = SEA_Y-1 必须为空」是错的：那一格正是湖底方块。
      assertEqual(col.blocks[blockIndex(lx, LAKE_FLOOR_Y + 1, lz)], waterId,
        `(${wx},${wz}) 湖底上方一格（= SEA_Y）必须只有这层水`);
    }
  }
  assertTrue(checked > 100, `湖盆内至少检查 100 列（实际 ${checked}）`);
});

test('shallowTarn: 湖盆下方必须是实心（挖开不会掉进洞穴）', () => {
  // `carveCaves` 在 `fillColumn` 之后挖洞 —— 不填实的话玩家挖开湖底会掉进洞里
  // （与竞技场「地板下方补实」同一条理由）。
  clearShallowTarnCache();
  clearShallowTarnTerrainCache();
  const a = computeShallowTarnAnchor(DEFAULT_SEED);
  assertTrue(a !== null, '默认 seed 必须有落点');
  const reg = registry();
  const cx = Math.floor(a.wx / 16), cz = Math.floor(a.wz / 16);
  const col = new ChunkColumn(cx, cz);
  fillColumn(col, DEFAULT_SEED, reg);
  carveCaves(col, DEFAULT_SEED);
  fillShallowTarnBasin(col, a, DEFAULT_SEED, reg);
  let holes = 0;
  for (let lx = 0; lx < 16; lx++) {
    for (let lz = 0; lz < 16; lz++) {
      const wx = cx * 16 + lx, wz = cz * 16 + lz;
      if (lakeOffset(a, DEFAULT_SEED, wx, wz) > -8) continue;
      // 湖底方块正下方 1..10 格必须全实心（填的是 stone）
      for (let d = 1; d <= 10; d++) {
        const y = LAKE_FLOOR_Y - d;
        if (y <= WORLD_MIN_Y) break;
        if (col.blocks[blockIndex(lx, y, lz)] === 0) { holes++; break; }
      }
    }
  }
  assertEqual(holes, 0, '湖盆内不得有「正下方是空气」的列');
});

// ---------------------------------------------------------------------------
// ④ 深浅草分流
// ---------------------------------------------------------------------------

test('shallowTarn: 湖底正下方不得残留天然水（会被看见「湖底下面还有一层水」）', () => {
  // ⚠️ `fillColumn` 在整形**之前**把整列按自然地形填过，低于海平面的部分有 `water`。
  // 只把空气填成 stone 的话，湖底正下方会留下一层天然水 —— 真实页面实测 **492 列**中招。
  // 正确做法 = 空气**与天然水**都填 stone（与 `fillTarnPlateau` 的「地下水也要换成石头」同口径）。
  clearShallowTarnCache();
  clearShallowTarnTerrainCache();
  const a = computeShallowTarnAnchor(DEFAULT_SEED);
  assertTrue(a !== null, '默认 seed 必须有落点');
  const reg = registry();
  const waterId = reg.idOf('water');
  let checked = 0;
  let wet = 0;
  // ⚠️ **采样范围必须落在湖盆内**（离岸 ≥8 格），不能写死也不能用 ±120：
  // 湖半径四轮收紧（240→130→105→99）后，±120 已经越过湖界进沙滩带；
  // v2.15 岸线不规则后，必须逐列用 `e = d − R(θ)` 判（内凹方位上 ±94 也已经到沙滩里了）。
  const sampleR = LAKE_RADIUS_MIN - 8;
  const seen = new Set();
  for (let dx = -sampleR; dx <= sampleR; dx += 16) {
    for (let dz = -sampleR; dz <= sampleR; dz += 16) {
      if (dx * dx + dz * dz > sampleR * sampleR) continue;
      const cx = Math.floor((a.wx + dx) / 16), cz = Math.floor((a.wz + dz) / 16);
      const key = `${cx},${cz}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const col = new ChunkColumn(cx, cz);
      fillColumn(col, DEFAULT_SEED, reg);
      carveCaves(col, DEFAULT_SEED);
      fillShallowTarnBasin(col, a, DEFAULT_SEED, reg);
      for (let lx = 0; lx < 16; lx++) {
        for (let lz = 0; lz < 16; lz++) {
          const wx = cx * 16 + lx, wz = cz * 16 + lz;
          if (lakeOffset(a, DEFAULT_SEED, wx, wz) > -8) continue;
          checked++;
          if (col.blocks[blockIndex(lx, LAKE_FLOOR_Y - 1, lz)] === waterId) wet++;
        }
      }
    }
  }
  assertTrue(checked > 5000, `必须检查足够多的列（实际 ${checked}）`);
  assertEqual(wet, 0, `湖底正下方 ${checked} 列里不得有水位（实际 ${wet} 列）`);
});

test('shallowTarn: 草呈成片分块（不是逐格噪点）', () => {
  // 用户 2026-11-01 选定「成片分块」。判据 = 相邻同色率。
  // ⚠️ 逐格随机的话同色率 ≈ 50%；成片分块必须显著更高。
  // 实测（blobNoise scale=0.09）：约 91%。
  let same = 0;
  let total = 0;
  const values = [];
  for (let z = 0; z < 40; z++) {
    for (let x = 0; x < 40; x++) {
      values.push(shallowTarnGrassBlock(x * 2, z * 2, DEFAULT_SEED));
    }
  }
  const at = (x, z) => values[z * 40 + x];
  for (let z = 0; z < 40; z++) {
    for (let x = 0; x < 40; x++) {
      if (x + 1 < 40) { total++; if (at(x, z) === at(x + 1, z)) same++; }
      if (z + 1 < 40) { total++; if (at(x, z) === at(x, z + 1)) same++; }
    }
  }
  const ratio = same / total;
  assertTrue(ratio > 0.75,
    `相邻同色率 ${(ratio * 100).toFixed(1)}% 必须 > 75%（逐格随机只有 ~50%，说明分块失效）`);
});

test('shallowTarn: 两种草都出现，且大致各半', () => {
  let dark = 0;
  let light = 0;
  for (let z = 0; z < 80; z++) {
    for (let x = 0; x < 80; x++) {
      if (shallowTarnGrassBlock(x * 3, z * 3, DEFAULT_SEED) === 'dark_grass') dark++;
      else light++;
    }
  }
  const frac = dark / (dark + light);
  assertTrue(frac > 0.3 && frac < 0.7,
    `深草占比 ${(frac * 100).toFixed(0)}% 必须在 30%~70%（否则一种颜色几乎不出现）`);
});

test('shallowTarn: 深浅草判定是世界坐标纯函数（跨 column 一致）', () => {
  // ⚠️ 同一棵树/同一片高台必然跨 column —— 判据必须只看世界坐标。
  // 写成「读 column 局部坐标」会让两半算出不同结果（杜鹃树踩过同形的坑）。
  const wx = 1761, wz = -83;
  assertEqual(shallowTarnGrassBlock(wx, wz, DEFAULT_SEED), shallowTarnGrassBlock(wx, wz, DEFAULT_SEED),
    '同点两次调用必须一致');
  // 换一个 seed 应当得到可能不同的分布（说明 seed 真的参与了）
  let diff = 0;
  for (let i = 0; i < 256; i++) {
    const x = wx + i, z = wz + (i * 7) % 43;
    if (shallowTarnGrassBlock(x, z, 12345) !== shallowTarnGrassBlock(x, z, 999)) diff++;
  }
  assertTrue(diff > 10, `不同 seed 的草分布必须不同（实测只有 ${diff}/256 个点不同）`);
});

test('shallowTarn: 两个新草方块已注册且六面同贴图', () => {
  const reg = registry();
  for (const name of ['dark_grass', 'light_grass']) {
    const id = reg.idOf(name);
    assertTrue(id !== undefined, `${name} 必须已注册（否则光栅化时静默变空气）`);
    assertEqual(reg.solidTable[id], 1, `${name} 必须 solid`);
    assertEqual(reg.opaqueTable[id], 1, `${name} 必须 opaqueTable=1（参与邻居面剔除）`);
    assertEqual(reg.cullTable[id], 0, `${name} 必须走 opaque 通道`);
  }
});

test('shallowTarn: 刷草把标记格落成噪声指定的那一种，且不碰其它方块', () => {
  // 标记 = `light_grass`（自然世界里永不出现，见 shallow-water-tarn-data.js）。
  // ⚠️ 因此**不能断言「标记不得残留」** —— 浅色那一支的产物本来就是 light_grass，
  // 与未刷的标记同名。真正的「刷色跑过没有」判据 = **每个标记格的最终方块等于噪声指定的那一种**
  // （深噪声格必须变成 dark_grass，跑不到就还是 light_grass → 本条会红）。
  // 「不得碰自然地形草方块」由下一条用例单独钉。
  clearShallowTarnCache();
  clearShallowTarnTerrainCache();
  const reg = registry();
  const a = computeShallowTarnAnchor(DEFAULT_SEED);
  assertTrue(a !== null, '默认 seed 必须有落点');
  const cx = Math.floor(a.wx / 16), cz = Math.floor(a.wz / 16);
  const col = new ChunkColumn(cx, cz);
  const y = a.lakeFloorY + 4;
  const markerId = reg.idOf(GRASS_MARKER_BLOCK);
  const darkId = reg.idOf('dark_grass');
  const lightId = reg.idOf('light_grass');
  const mossId = reg.idOf('moss');
  assertTrue(markerId !== undefined && darkId !== undefined && lightId !== undefined && mossId !== undefined,
    '四个方块必须都已注册');

  // 标记格挑「噪声为浅」与「噪声为深」各 2 格（实测 seed 12345 下 (0,0~3) 浅、(0,6~9) 深）
  const cells = [
    [0, 0, 'marker'], [0, 1, 'marker'], [0, 6, 'marker'], [0, 7, 'marker'],
    [1, 0, 'dark'], [1, 1, 'dark'], [2, 0, 'moss'], [2, 1, 'moss'],
  ];
  for (const [lx, lz, kind] of cells) {
    col.blocks[blockIndex(lx, y, lz)] = kind === 'marker' ? markerId : (kind === 'dark' ? darkId : mossId);
  }

  paintShallowTarnGrass(col, a, DEFAULT_SEED, reg, (wx, wy, wz, name) => {
    col.blocks[blockIndex(wx - cx * 16, wy, wz - cz * 16)] = reg.idOf(name);
  });

  let othersChanged = 0;
  for (const [lx, lz, kind] of cells) {
    const id = col.blocks[blockIndex(lx, y, lz)];
    if (kind === 'dark') {
      if (id !== darkId) othersChanged++;
    } else if (kind === 'moss' && id !== mossId) {
      othersChanged++;
    }
  }
  assertEqual(othersChanged, 0, '非标记格（dark_grass / moss）必须逐格不变 —— moss 已全部是终态深草');
  // 每条标记格都必须落到噪声指定的那一种（深噪声格必须被写成 dark_grass → 这就是「刷色跑过了」）
  for (const [lx, lz, kind] of cells) {
    if (kind !== 'marker') continue;
    const expected = shallowTarnGrassBlock(cx * 16 + lx, cz * 16 + lz, DEFAULT_SEED);
    assertEqual(reg.nameOf(col.blocks[blockIndex(lx, y, lz)]), expected,
      `(${lx},${lz}) 标记格必须按噪声落成 ${expected}`);
  }
});


test('shallowTarn: 刷草不得改动自然地形里的草方块（v2.15 回归）', () => {
  // ⚠️ **这是用户 2026-11-02 报的真实缺陷**：「你怎么把地形中（非模型）里的草地方块也都给我
  // 替换成 grass-dark-green 和 grass-light-green 了」。
  // 根因：草标记曾选成 `grass`（香草草方块）——`paintShallowTarnGrass` 扫的是**整列**
  // `[lakeFloorY, +64] × 256 格`，于是浅水高台周围的**自然地表草**（缓坡带地表就是 `grass`）
  // 被当成标记刷成了深浅草。
  // ⇒ 标记必须是「自然世界里永远不会出现」的方块（当前 = `light_grass`，它只由烘焙产物产生）。
  clearShallowTarnCache();
  clearShallowTarnTerrainCache();
  const reg = registry();
  const a = computeShallowTarnAnchor(DEFAULT_SEED);
  assertTrue(a !== null, '默认 seed 必须有落点');
  const cx = Math.floor(a.wx / 16), cz = Math.floor(a.wz / 16);
  const col = new ChunkColumn(cx, cz);
  const y = a.lakeFloorY + 4;
  const grassId = reg.idOf('grass');
  const sandId = reg.idOf('sand');
  // 自然地表的四种「不能被碰」的方块（都可能在整列扫描范围内出现）
  const naturals = [grassId, sandId, reg.idOf('stone'), reg.idOf('moss')];
  for (let i = 0; i < naturals.length; i++) col.blocks[blockIndex(4 + i, y, 4)] = naturals[i];

  paintShallowTarnGrass(col, a, DEFAULT_SEED, reg, (wx, wy, wz, name) => {
    col.blocks[blockIndex(wx - cx * 16, wy, wz - cz * 16)] = reg.idOf(name);
  });

  for (let i = 0; i < naturals.length; i++) {
    assertEqual(col.blocks[blockIndex(4 + i, y, 4)], naturals[i],
      `自然地表的 ${reg.nameOf(naturals[i])} 不得被刷草改写（尤其 vanilla grass）`);
  }
});

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/**
 * 到**湖岸**的径向偏移 `e = d − R(θ)`（负数 = 湖盆内）。
 *
 * ⚠️ 测试侧刻意**不**引实现里的私有封装：这里不重算公式，只调同一对权威函数
 * （`shallowTarnLakeRadiusAt` + `shallowTarnShapePhase`）—— 判据与实现同源。
 */
function lakeOffset(a, seed, wx, wz) {
  const dx = wx - a.wx, dz = wz - a.wz;
  const phase = shallowTarnShapePhase(seed);
  return Math.hypot(dx, dz) - shallowTarnLakeRadiusAt(Math.atan2(dz, dx), phase);
}

/** 某列「自上而下第一个非空方块」的 `y:name` 快照（判「整形区外未被改写」用） */
function snapshotSurface(col, reg, wx, wz) {
  const lx = wx - col.cx * 16, lz = wz - col.cz * 16;
  for (let y = WORLD_MAX_Y - 1; y > WORLD_MIN_Y; y--) {
    const id = col.blocks[blockIndex(lx, y, lz)];
    if (id !== 0) return `${y}:${reg.nameOf(id)}`;
  }
  return 'empty';
}

// ---------------------------------------------------------------------------
// 真实方块足迹（供「水环宽」判据用；v2.16）
// ---------------------------------------------------------------------------

/**
 * 五座烘焙产物的**真实方块足迹**，按方位给出支撑函数。
 *
 * ## 为什么需要它（而不是用 layout 的 AABB）
 * AABB 的四个角是**空的**（素材是蘑菇形体：顶部宽、四角缺）。用 AABB 判「台地在湖里」
 * 会把水面宽度系统性估大 ~20 格（AABB 角 92.4 vs 真实最远延伸 ~72），
 * v2.15 因此把湖半径锁死在 102、水环宽中位 39.3 格（用户 2026-11-02 报「水面太大」）。
 *
 * `support(variant, deg)` = 该座在该方位上**真实方块**的最远径向延伸（相对平台中心）。
 * 相对中心用产物自身的足迹 bbox 中心（= `rasterizeStructure` 的摆放中心，同源）。
 *
 * @returns {Promise<{ support: (variant: string, deg: number) => number }>}
 */
let footprintCache = null;
function loadShallowTarnFootprints() {
  if (footprintCache) return footprintCache;
  footprintCache = (async () => {
    const table = new Map();
    for (const variant of SHALLOW_TARN_VARIANTS) {
      const json = await (await fetch(resourceUrl(`assets/structures/${variant}.json`))).json();
      const stride = json.stride ?? 4;
      const cells = [];
      let mnX = Infinity, mxX = -Infinity, mnZ = Infinity, mxZ = -Infinity;
      for (let i = 0; i < json.blocks.length; i += stride) {
        const bx = json.blocks[i], by = json.blocks[i + 1], bz = json.blocks[i + 2];
        cells.push([bx, by, bz]);
        if (bx < mnX) mnX = bx;
        if (bx > mxX) mxX = bx;
        if (bz < mnZ) mnZ = bz;
        if (bz > mxZ) mxZ = bz;
      }
      const cxb = (mnX + mxX) / 2, czb = (mnZ + mxZ) / 2;
      const support = new Float64Array(360);
      for (const [bx, by, bz] of cells) {
        const dx = bx - cxb, dz = bz - czb;
        for (let deg = 0; deg < 360; deg += 1) {
          const s = dx * Math.cos(deg * Math.PI / 180) + dz * Math.sin(deg * Math.PI / 180);
          if (s > support[deg]) support[deg] = s;
        }
      }
      table.set(variant, support);
    }
    return { support: (variant, deg) => table.get(variant)[((deg % 360) + 360) % 360] };
  })();
  return footprintCache;
}
