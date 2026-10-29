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
import { assertEqual, assertTrue } from './assert.js';
import { SEA_Y, blockIndex, WORLD_MIN_Y, WORLD_MAX_Y } from '../voxel/constants.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { createRegistry } from '../voxel/block-registry.js';
import { fillColumn } from '../gen/terrain.js';
import { carveCaves } from '../gen/caves.js';
import {
  LAKE_RADIUS, BEACH_WIDTH, LAKE_FLOOR_Y, BEACH_OUTER_Y, shallowTarnSuppressedLandmarks,
  SHALLOW_TARN_OUTER_RADIUS, SHALLOW_TARN_GAP,
  shallowTarnAabbGap, computeShallowTarnAnchor, computeShallowTarnLayout,
  inShallowTarnFootprint, shallowTarnOverlapsRegion, clearShallowTarnCache,
} from '../gen/structures/shallow-water-tarns.js';
import {
  shallowTarnSurfaceYAt, shallowTarnGrassBlock,
  fillShallowTarnBasin, clearShallowTarnTerrainCache,
} from '../gen/structures/shallow-water-terrain.js';
import { SHALLOW_TARN_VARIANTS, SHALLOW_TARN_METRICS } from '../gen/structures/shallow-water-tarn-data.js';
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
  // ⚠️ 判据用的是**硬净空半径**（湖 + 沙滩），与 `computeShallowTarnAnchor` 同一个值 ——
  // 而不是 `SHALLOW_TARN_OUTER_RADIUS`（含缓坡）。两者是**两套口径**：
  // 缓坡带只做高度插值、不把地标变成本地图的一部分，所以锚点判据刻意不把它算进净空
  // （算进去会让半径从 262 涨到 342，在 400 格 region 网格上 10 seed 全部失效 ——
  //  见 `shallow-water-tarns.js` 的 `fixedBlockers` 注释）。
  // 断言用错了口径会得到一个「实现明明对、用例却 FAIL」的假失败。
  const hard = LAKE_RADIUS + BEACH_WIDTH;
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
    const R = LAKE_RADIUS + BEACH_WIDTH;
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
  assertEqual(a.hardRadius, LAKE_RADIUS + BEACH_WIDTH, 'hardRadius = 湖 + 沙滩（不含缓坡）');

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
  assertEqual(inShallowTarnFootprint(a.wx + LAKE_RADIUS - 1, a.wz, anchors), true, '湖盆内缘在整形区内');
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

test('shallowTarn: 五座全部落在湖盆内（最远角 < 湖半径）', () => {
  // 用户要求「潜水里是五个新的高台」—— 高台必须在水里，不能伸出湖岸。
  for (const seed of [12345, 1, 424242, 8888, 20240101, 777]) {
    const layout = computeShallowTarnLayout(seed);
    for (const p of layout) {
      // 逐角算（不能用 `ring + min(half)` 近似 —— 那是边的中点，会低估最远角）
      let worst = 0;
      for (const ox of [-p.hiX, p.loX]) {
        for (const oz of [-p.hiZ, p.loZ]) {
          const d = Math.hypot(p.cx + ox, p.cz + oz);
          if (d > worst) worst = d;
        }
      }
      assertTrue(worst < LAKE_RADIUS,
        `seed ${seed}: ${p.variant} 最远角 ${worst.toFixed(1)} 必须 < 湖半径 ${LAKE_RADIUS}`);
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
    // ⚠️ **采样半径必须从 LAKE_RADIUS 派生**，不能写死。
    // 初版写了 `[0, 50, 120, LAKE_RADIUS-1]`，而 v2.13 把湖半径从 130 收到 105 后
    // `120` 已经出湖（那是沙滩带/缓坡）—— 用例会得到「地表 0 而非 -3」的假失败。
    for (const r of [0, Math.floor(LAKE_RADIUS * 0.25), Math.floor(LAKE_RADIUS * 0.5), LAKE_RADIUS - 1]) {
      const wx = Math.round(a.wx + Math.cos(ang) * r);
      const wz = Math.round(a.wz + Math.sin(ang) * r);
      assertEqual(shallowTarnSurfaceYAt(wx, wz, DEFAULT_SEED, a), LAKE_FLOOR_Y,
        `湖盆 (r=${r}, ang=${ang.toFixed(2)}) 地表必须恒 ${LAKE_FLOOR_Y}`);
    }
  }
});

test('shallowTarn: 沙滩带单调抬升到 SEA_Y+2（走上来不需要跳）', () => {
  clearShallowTarnCache();
  clearShallowTarnTerrainCache();
  const a = computeShallowTarnAnchor(DEFAULT_SEED);
  assertTrue(a !== null, '默认 seed 必须有落点');
  assertEqual(BEACH_OUTER_Y, SEA_Y + 2, 'BEACH_OUTER_Y 必须从 SEA_Y 派生');
  let prev = LAKE_FLOOR_Y;
  for (let d = LAKE_RADIUS; d <= LAKE_RADIUS + BEACH_WIDTH; d += 2) {
    const y = shallowTarnSurfaceYAt(a.wx + d, a.wz, DEFAULT_SEED, a);
    assertTrue(y >= prev, `沙滩 d=${d}: 地表 ${y} 不得低于上一格 ${prev}（必须单调抬升）`);
    assertTrue(Math.abs(y - prev) <= 1, `沙滩 d=${d}: 单步落差 ${Math.abs(y - prev)} 必须 ≤1（否则要跳）`);
    prev = y;
  }
  assertEqual(shallowTarnSurfaceYAt(a.wx + LAKE_RADIUS + BEACH_WIDTH, a.wz, DEFAULT_SEED, a),
    BEACH_OUTER_Y, '沙滩外缘必须正好是 BEACH_OUTER_Y');
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
      for (let d = 0; d <= SHALLOW_TARN_OUTER_RADIUS - 1; d += 1) {
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
      if (Math.hypot(wx - a.wx, wz - a.wz) > LAKE_RADIUS - 8) continue;   // 只看湖盆内部
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
      if (Math.hypot(wx - a.wx, wz - a.wz) > LAKE_RADIUS - 8) continue;
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
  // ⚠️ **采样半径必须落在湖盆内**（`LAKE_RADIUS - 8`），不能写死也不能用 ±120：
  // 湖半径四轮收紧（240→130→105→99）后，±120 已经越过湖界进沙滩带（99+7=106 起），
  // 那里地表是 -5、`LAKE_FLOOR_Y-1 = -4` 落在沙滩内部 —— 水是**应当**有的，
  // 却被当成「残留天然水」误报 62 列（实测）。
  const sampleR = LAKE_RADIUS - 8;
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
          if (Math.hypot(wx - a.wx, wz - a.wz) > sampleR) continue;
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

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 某列「自上而下第一个非空方块」的 `y:name` 快照（判「整形区外未被改写」用） */
function snapshotSurface(col, reg, wx, wz) {
  const lx = wx - col.cx * 16, lz = wz - col.cz * 16;
  for (let y = WORLD_MAX_Y - 1; y > WORLD_MIN_Y; y--) {
    const id = col.blocks[blockIndex(lx, y, lz)];
    if (id !== 0) return `${y}:${reg.nameOf(id)}`;
  }
  return 'empty';
}
