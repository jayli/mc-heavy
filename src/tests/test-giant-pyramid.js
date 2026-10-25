// src/tests/test-giant-pyramid.js — 巨型金字塔 Tier 1：落点判据 / 去重 / 不变量 / 密度
//
// 钉的是「判据被改坏后**静默产出一个看起来正常的错误金字塔**」这几类缺陷：
//   · 占地跨 biome / 跨海 → 一半坐在草地或海底
//   · 占地内地表高差 > 4 → 一侧悬空（塔基 49×49 满铺只能保证「不整体浮空」）
//   · 锚点太靠 region 边界 → 相邻 region 不会为它生成锚点 ⇒ 半边永久消失
//   · 落地进城市 → 城市地面已被 generateCity 整形，塔基悬空/埋死
//   · 两座挨太近 → 巨型金字塔互相穿插
//   · 塔顶穿云/撞空岛 → 只在改常量后某天世界穿帮
//
// ⚠️ 断言下界都取自**实测**（spec §2 / 计划 Review Focus），不是拍脑袋。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse } from './assert.js';
import {
  computeGiantPyramidAnchor, clearGiantPyramidCache,
  PYRAMID_HALF, PYRAMID_INSET, PYRAMID_HEIGHT, PYRAMID_MAX_SURFACE_SPAN, PYRAMID_MIN_SPACING,
  PYRAMID_CHANCE, PYRAMID_SALT_ORDER, PYRAMID_SALT_GATE,
} from '../gen/structures/giant-pyramid.js';
import { getBiome } from '../gen/noise.js';
import { generateHeight } from '../gen/terrain.js';
import { SEA_Y } from '../voxel/constants.js';

const SEED = 12345;

test('巨型金字塔落点：同一 seed 同一 region 两次调用逐字段相同（红线 2 确定性）', () => {
  for (const [rx, rz] of [[0, 1], [1, -1], [-2, -2]]) {
    const a = computeGiantPyramidAnchor(rx, rz, SEED);
    const b = computeGiantPyramidAnchor(rx, rz, SEED);
    if (a === null) { assertEqual(b, null, `region(${rx},${rz}) 两次都 null`); continue; }
    assertEqual(a.wx, b.wx, `region(${rx},${rz}) wx 稳定`);
    assertEqual(a.wz, b.wz, `region(${rx},${rz}) wz 稳定`);
    assertEqual(a.floorY, b.floorY, `region(${rx},${rz}) floorY 稳定`);
  }
});

test('巨型金字塔落点：占地 49×49 每列都是 DESERT（不跨 biome）', () => {
  // ⚠️ 扫 ±3（49 region）：逐格全检 + 高台/城市排除后筛得很严，实测 ±2 范围内只有 4 个锚点。
  // 每个锚点都逐格校验 2401 格占地，样本量 8 已足够判判别力。
  let checked = 0;
  for (let rx = -3; rx <= 3; rx++) for (let rz = -3; rz <= 3; rz++) {
    const a = computeGiantPyramidAnchor(rx, rz, SEED);
    if (!a) continue;
    checked++;
    for (let dz = -PYRAMID_HALF; dz <= PYRAMID_HALF; dz++) {
      for (let dx = -PYRAMID_HALF; dx <= PYRAMID_HALF; dx++) {
        const b = getBiome(a.wx + dx, a.wz + dz, SEED);
        if (b !== 'DESERT') assertEqual(b, 'DESERT', `region(${rx},${rz}) 占地 (${dx},${dz}) 实际 ${b}`);
      }
    }
  }
  assertTrue(checked >= 8, `至少 8 个 region 有锚点（实际 ${checked}）`);
});

test('巨型金字塔落点：占地每列地表高于海平面（不跨海）', () => {
  for (let rx = -2; rx <= 2; rx++) for (let rz = -2; rz <= 2; rz++) {
    const a = computeGiantPyramidAnchor(rx, rz, SEED);
    if (!a) continue;
    for (let dz = -PYRAMID_HALF; dz <= PYRAMID_HALF; dz++) {
      for (let dx = -PYRAMID_HALF; dx <= PYRAMID_HALF; dx++) {
        const h = generateHeight(a.wx + dx, a.wz + dz, SEED);
        if (h <= SEA_Y) assertTrue(false, `region(${rx},${rz}) 占地 (${dx},${dz}) h=${h} 必须 > SEA_Y=${SEA_Y}`);
      }
    }
  }
});

test('巨型金字塔落点：floorY === 占地各列 generateHeight 的最小值（取 min 绝不悬空）', () => {
  for (let rx = -2; rx <= 2; rx++) for (let rz = -2; rz <= 2; rz++) {
    const a = computeGiantPyramidAnchor(rx, rz, SEED);
    if (!a) continue;
    let mn = Infinity;
    for (let dz = -PYRAMID_HALF; dz <= PYRAMID_HALF; dz++) {
      for (let dx = -PYRAMID_HALF; dx <= PYRAMID_HALF; dx++) {
        mn = Math.min(mn, generateHeight(a.wx + dx, a.wz + dz, SEED));
      }
    }
    assertEqual(a.floorY, mn, `region(${rx},${rz}) floorY 必须是占地最低地表`);
  }
});

test('巨型金字塔落点：占地内地表高差 ≤ PYRAMID_MAX_SURFACE_SPAN', () => {
  for (let rx = -2; rx <= 2; rx++) for (let rz = -2; rz <= 2; rz++) {
    const a = computeGiantPyramidAnchor(rx, rz, SEED);
    if (!a) continue;
    let mn = Infinity, mx = -Infinity;
    for (let dz = -PYRAMID_HALF; dz <= PYRAMID_HALF; dz++) {
      for (let dx = -PYRAMID_HALF; dx <= PYRAMID_HALF; dx++) {
        const h = generateHeight(a.wx + dx, a.wz + dz, SEED);
        if (h < mn) mn = h;
        if (h > mx) mx = h;
      }
    }
    assertTrue(mx - mn <= PYRAMID_MAX_SURFACE_SPAN,
      `region(${rx},${rz}) 高差 ${mx - mn} 必须 ≤ ${PYRAMID_MAX_SURFACE_SPAN}`);
  }
});

test('巨型金字塔落点：整个占地落在本 region 内（不跨 region 边界）', () => {
  for (let rx = -2; rx <= 2; rx++) for (let rz = -2; rz <= 2; rz++) {
    const a = computeGiantPyramidAnchor(rx, rz, SEED);
    if (!a) continue;
    assertTrue(a.wx - PYRAMID_HALF >= rx * 400 && a.wx + PYRAMID_HALF < (rx + 1) * 400,
      `region(${rx},${rz}) x 占地 [${a.wx - PYRAMID_HALF},${a.wx + PYRAMID_HALF}] 越界`);
    assertTrue(a.wz - PYRAMID_HALF >= rz * 400 && a.wz + PYRAMID_HALF < (rz + 1) * 400,
      `region(${rx},${rz}) z 占地 [${a.wz - PYRAMID_HALF},${a.wz + PYRAMID_HALF}] 越界`);
  }
});

test('巨型金字塔落点：任意两座切比雪夫距 ≥ PYRAMID_MIN_SPACING（一块沙漠一座）', () => {
  const list = [];
  for (let rx = -6; rx <= 6; rx++) for (let rz = -6; rz <= 6; rz++) {
    const a = computeGiantPyramidAnchor(rx, rz, SEED);
    if (a) list.push(a);
  }
  assertTrue(list.length >= 10, `±6 范围内应有足够样本（实测更多，实际 ${list.length}）`);
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const d = Math.max(Math.abs(list[i].wx - list[j].wx), Math.abs(list[i].wz - list[j].wz));
      assertTrue(d >= PYRAMID_MIN_SPACING,
        `两个锚点相隔 ${d} < ${PYRAMID_MIN_SPACING}（${list[i].wx},${list[i].wz} vs ${list[j].wx},${list[j].wz}）`);
    }
  }
});

test('巨型金字塔落点：无合法落点时返回 null（不硬塞）', () => {
  let nullCount = 0;
  for (let rx = -6; rx <= 6; rx++) for (let rz = -6; rz <= 6; rz++) {
    if (computeGiantPyramidAnchor(rx, rz, SEED) === null) nullCount++;
  }
  assertTrue(nullCount > 0, `±6 范围内应存在无合法落点的 region（实际 ${nullCount}）`);
  assertTrue(nullCount < 169, `也不能全部为 null（实际 ${nullCount}/169）`);
});

test('巨型金字塔落点：锚点不在任何城市 bounds 内（5 seed）', async () => {
  const { getCityBoundsForSeed } = await import('../gen/structures/city-layout.js');
  for (const seed of [12345, 424242, 777, 20260819, 999983]) {
    clearGiantPyramidCache();
    const city = getCityBoundsForSeed(seed);
    for (let rx = -2; rx <= 2; rx++) for (let rz = -2; rz <= 2; rz++) {
      const a = computeGiantPyramidAnchor(rx, rz, seed);
      if (!a) continue;
      const inside = a.wx >= city.minX && a.wx <= city.maxX && a.wz >= city.minZ && a.wz <= city.maxZ;
      assertFalse(inside, `seed=${seed} region(${rx},${rz}) 锚点 (${a.wx},${a.wz}) 落在城市 bounds 内`);
    }
  }
});

test('巨型金字塔落点：与同 region 的高台占地不相交（实测 139/162 region 会被高台吞掉 → 排除必需）', async () => {
  const { computeRegionLocalAnchor, MESA_UNION_HALF } = await import('../gen/structures/mesa.js');

  // ⚠️ 鉴别力前置：**必须先证明高台排除真的在起作用** —— 否则下面的「不相交」可因
  // 「金字塔本来就不在高台附近」而恒真。
  // 可靠判据 = 「高台占地内存在**全沙漠且全高于海平面**的合法候选中心」：
  // 那类点若无排除就会被选中（其余判据都过）→ 实测 162 个有高台的 region 里 **139 个**如此。
  // （不可用「局部锚点与高台重叠」作前置：排除上线后它们已不再重叠，那会变成恒假。）
  const reach = PYRAMID_HALF + MESA_UNION_HALF;
  let withMesa = 0, mesaEatsCandidate = 0;
  for (let rx = -6; rx <= 6; rx++) for (let rz = -6; rz <= 6; rz++) {
    const m = computeRegionLocalAnchor(rx, rz, SEED);
    if (!m) continue;
    withMesa++;
    let found = false;
    for (let dz = -reach; dz <= reach && !found; dz += 12) {
      for (let dx = -reach; dx <= reach; dx += 12) {
        const wx = m.wx + dx, wz = m.wz + dz;
        if (wx < rx * 400 + PYRAMID_INSET || wx >= (rx + 1) * 400 - PYRAMID_INSET) continue;
        if (wz < rz * 400 + PYRAMID_INSET || wz >= (rz + 1) * 400 - PYRAMID_INSET) continue;
        if (getBiome(wx, wz, SEED) !== 'DESERT') continue;
        let ok = true;
        for (let z2 = -PYRAMID_HALF; z2 <= PYRAMID_HALF && ok; z2++) {
          for (let x2 = -PYRAMID_HALF; x2 <= PYRAMID_HALF; x2++) {
            if (getBiome(wx + x2, wz + z2, SEED) !== 'DESERT') { ok = false; break; }
            if (generateHeight(wx + x2, wz + z2, SEED) <= SEA_Y) { ok = false; break; }
          }
        }
        if (ok) found = true;
      }
    }
    if (found) mesaEatsCandidate++;
  }
  assertTrue(withMesa > 100, `应有足够多的高台样本（实测 162，实际 ${withMesa}）`);
  assertTrue(mesaEatsCandidate > 50,
    `高台占地内必须有合法金字塔候选（实测 139）—— 否则本用例失去判别力（实际 ${mesaEatsCandidate}）`);

  // 主断言：**最终**锚点（已经过高台排除）与同 region 高台必不相交
  let both = 0, checked = 0;
  for (let rx = -6; rx <= 6; rx++) for (let rz = -6; rz <= 6; rz++) {
    const a = computeGiantPyramidAnchor(rx, rz, SEED);
    const mesa = computeRegionLocalAnchor(rx, rz, SEED);
    if (a) checked++;
    if (!a || !mesa) continue;
    both++;
    const overlap = Math.abs(a.wx - mesa.wx) <= reach && Math.abs(a.wz - mesa.wz) <= reach;
    assertFalse(overlap, `region(${rx},${rz}) 金字塔 (${a.wx},${a.wz}) 与高台 (${mesa.wx},${mesa.wz}) 占地相交`);
  }
  assertTrue(checked > 20, `应有足够多的锚点（实测 34，实际 ${checked}）`);
  assertTrue(both > 20, `应有足够多「两者都有」的 region（实测 34，实际 ${both}）`);
});

test('巨型金字塔常量：塔顶必须落在云层与空岛之下（改常量即红）', async () => {
  const { CLOUD_CLUSTER_Y } = await import('../gen/structures/sky-structures.js');
  // 沙漠地表实测 max = 9（spec §2，±1200 采样）—— 这里现场重扫一遍，不写字面量
  let maxH = -Infinity;
  for (let wz = -1200; wz <= 1200; wz += 40) {
    for (let wx = -1200; wx <= 1200; wx += 40) {
      if (getBiome(wx, wz, SEED) !== 'DESERT') continue;
      const h = generateHeight(wx, wz, SEED);
      if (h > maxH) maxH = h;
    }
  }
  assertTrue(maxH > 0, `沙漠地表 max=${maxH} 应大于 0（否则本用例恒真）`);
  assertTrue(maxH + PYRAMID_HEIGHT < CLOUD_CLUSTER_Y,
    `塔顶 ${maxH + PYRAMID_HEIGHT} 必须低于云簇高度 ${CLOUD_CLUSTER_Y}（否则塔顶穿云）`);
  assertTrue(maxH + PYRAMID_HEIGHT < 40, `塔顶 ${maxH + PYRAMID_HEIGHT} 必须低于空岛底 y=40`);
});

test('巨型金字塔 salt：落在空闲带且不与既有 salt 冲突（程序化校验）', () => {
  for (const s of [PYRAMID_SALT_ORDER, PYRAMID_SALT_GATE]) {
    assertTrue(s >= 952 && s <= 999, `salt ${s} 在空闲带 952..999`);
    for (const used of [941, 950, 951, 956]) assertFalse(s === used, `salt ${s} 不与既有 ${used} 冲突`);
  }
  assertFalse(PYRAMID_SALT_ORDER === PYRAMID_SALT_GATE, '排序与门必须用两个不同 salt（否则相关）');
});

test('巨型金字塔常量：内缩量足以容纳占地（改常量即红）', () => {
  assertEqual(PYRAMID_INSET, PYRAMID_HALF + 1, 'PYRAMID_INSET = PYRAMID_HALF + 1（留 1 格余量）');
  assertTrue(PYRAMID_INSET >= PYRAMID_HALF, '内缩不得小于半宽（否则占地会越界）');
  assertTrue(PYRAMID_INSET + PYRAMID_HALF < 200, '占地不超过半个 region');
});

test('巨型金字塔常量：与高台的最近可能间距大于两者占地半径之和（相邻 region 不冲突）', async () => {
  const { MESA_UNION_HALF } = await import('../gen/structures/mesa.js');
  // 推导（spec DR-7）：相邻 region 下两边最近可能距离 = PYRAMID_INSET + MESA_INSET
  //   不冲突条件 = PYRAMID_INSET + MESA_INSET > PYRAMID_HALF + MESA_UNION_HALF
  // ⚠️ MESA_INSET 未导出，用 mesa.js 的定义 `MESA_UNION_HALF + 2` 当场算（不写第二份字面量）
  const mesaInset = MESA_UNION_HALF + 2;
  const minAdjacentGap = mesaInset + PYRAMID_INSET;
  const needed = PYRAMID_HALF + MESA_UNION_HALF;
  assertTrue(minAdjacentGap > needed,
    `相邻 region 的最小可能间距 ${minAdjacentGap} 必须 > 两者占地半径之和 ${needed}（实测 38 > 35）`);
});

test('巨型金字塔密度：跨 8 seed 平均「每 2 块沙漠 1 座」（关系式，实测 0.50）', async () => {
  // 口径（勿改）：分母 = 世界**沙漠连通块数**（8 格粒度、8 连通、质心落在测量窗内），
  // 分子 = 测量窗内的最终锚点数。窗取 ±1600（3.2 km²，实测沙漠块 25~46 个/seed，样本足够）。
  // ⚠️ 为什么分母不能是 region 数：region 是 400×400 矩形网格，沙漠是不规则块 ——
  // 一个 region 可能只有 5% 是沙漠，也可能 90%。用 region 做分母会让密度随 seed 乱跳 3 倍。
  // ⚠️ 窗必须 ≥ ±3200：窗越小边界效应越强（锚点在窗内、去重邻居在窗外 → 看起来"该让位却没让"）。
  // 实测同一 gate：±1600 得 0.363、±3200 得 0.501 —— 标定与断言一律用 ±3200。
  const WIN = 3200, G = 8;
  const SEEDS = [12345, 424242, 777, 20260819, 999983, 3, 42, 65535];
  let totalPyramids = 0, totalDeserts = 0;
  const perSeed = [];
  const nr = Math.ceil(WIN / 400);
  const N = Math.floor(2 * WIN / G) + 1;

  for (const seed of SEEDS) {
    clearGiantPyramidCache();
    let pyramids = 0;
    for (let rx = -nr; rx <= nr; rx++) for (let rz = -nr; rz <= nr; rz++) {
      const a = computeGiantPyramidAnchor(rx, rz, seed);
      if (!a) continue;
      if (Math.abs(a.wx) >= WIN || Math.abs(a.wz) >= WIN) continue;
      pyramids++;
    }
    // 沙漠连通块（8 格粒度、8 连通；只统计质心落在窗内的）
    const map = new Uint8Array(N * N);
    for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) {
      const wx = -WIN + ix * G, wz = -WIN + iz * G;
      map[iz * N + ix] = (getBiome(wx, wz, seed) === 'DESERT' && generateHeight(wx, wz, seed) > SEA_Y) ? 1 : 0;
    }
    const seen = new Uint8Array(N * N);
    let comps = 0;
    for (let i = 0; i < N * N; i++) {
      if (!map[i] || seen[i]) continue;
      seen[i] = 1;
      const st = [i];
      let n = 0, sx = 0, sz = 0;
      while (st.length) {
        const c = st.pop(); n++;
        const iz = Math.floor(c / N), ix = c - iz * N;
        sx += ix; sz += iz;
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          const nx = ix + dx, nz = iz + dz;
          if (nx < 0 || nx >= N || nz < 0 || nz >= N) continue;
          const j = nz * N + nx;
          if (map[j] && !seen[j]) { seen[j] = 1; st.push(j); }
        }
      }
      const ccx = -WIN + (sx / n) * G, ccz = -WIN + (sz / n) * G;
      if (Math.abs(ccx) < WIN && Math.abs(ccz) < WIN) comps++;
    }
    perSeed.push({ seed, pyramids, comps, ratio: pyramids / comps });
    totalPyramids += pyramids;
    totalDeserts += comps;
  }

  const ratio = totalPyramids / totalDeserts;
  assertTrue(totalDeserts > 500, `分母样本量足够（实际 ${totalDeserts} 块沙漠）—— 否则本用例不可信`);
  assertTrue(ratio >= 0.45 && ratio <= 0.60,
    `跨 seed 平均密度 ${ratio.toFixed(3)} 必须落在 [0.45, 0.60]（目标 0.5 = 每 2 块沙漠 1 座）；各 seed：${perSeed.map((r) => `${r.seed}:${r.ratio.toFixed(2)}`).join(' ')}`);
  // 单 seed 也不得离谱（防「平均对了但某个 seed 一个都没有」）
  for (const r of perSeed) {
    assertTrue(r.pyramids > 0, `seed=${r.seed} 必须至少有一座（否则该世界沙漠全是空的）`);
    assertTrue(r.ratio >= 0.20 && r.ratio <= 0.85,
      `seed=${r.seed} 密度 ${r.ratio.toFixed(3)} 越界 [0.20, 0.85]`);
  }
  // 概率门的语义不变式：门必须真的在起作用（=1.0 时密度会明显更高）
  assertTrue(PYRAMID_CHANCE > 0.2 && PYRAMID_CHANCE < 1.0,
    `PYRAMID_CHANCE=${PYRAMID_CHANCE} 必须是个真正的概率门（0.2~1.0）`);
});

test('巨型金字塔间距：阈值必然大于沙漠连通块最大跨度（否则一块沙漠会出现两座）', () => {
  // 依据与高台同源（spec DR-2）：8 格粒度下沙漠连通块最大 bbox 跨度实测 368 格，
  // 故阈值取 384（> 368，上取整到 32 的倍数）。这里**现场重测**且跨 seed 取最大。
  const WIN = 1200, G = 8;
  const N = Math.floor(2 * WIN / G) + 1;
  let globalMaxSpan = 0;
  for (const seed of [12345, 424242, 777, 20260819, 999983]) {
    const map = new Uint8Array(N * N);
    for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) {
      const wx = -WIN + ix * G, wz = -WIN + iz * G;
      map[iz * N + ix] = (getBiome(wx, wz, seed) === 'DESERT' && generateHeight(wx, wz, seed) > SEA_Y) ? 1 : 0;
    }
    const seen = new Uint8Array(N * N);
    for (let i = 0; i < N * N; i++) {
      if (!map[i] || seen[i]) continue;
      seen[i] = 1;
      const st = [i];
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      while (st.length) {
        const c = st.pop();
        const iz = Math.floor(c / N), ix = c - iz * N;
        if (ix < x0) x0 = ix; if (ix > x1) x1 = ix;
        if (iz < z0) z0 = iz; if (iz > z1) z1 = iz;
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          const nx = ix + dx, nz = iz + dz;
          if (nx < 0 || nx >= N || nz < 0 || nz >= N) continue;
          const j = nz * N + nx;
          if (map[j] && !seen[j]) { seen[j] = 1; st.push(j); }
        }
      }
      globalMaxSpan = Math.max(globalMaxSpan, (x1 - x0 + 1) * G, (z1 - z0 + 1) * G);
    }
  }
  assertTrue(globalMaxSpan > 0, '必须扫到沙漠块（否则本用例恒真）');
  assertTrue(globalMaxSpan < PYRAMID_MIN_SPACING,
    `跨 5 seed 的沙漠连通块最大跨度 ${globalMaxSpan} 必须 < PYRAMID_MIN_SPACING ${PYRAMID_MIN_SPACING}（实测 368 < 384）`);
});

// ==================== 接线（Task 6）：layout 字段 + pointContext 分支 ====================
//
// 钉的是「纯函数全绿但接线断了」这一类缺陷（M7 的教训）：`computeGiantPyramidAnchor`
// 算得再对，若 `computeRegionLayout` 不把它传给 GEN，或 `pointContext` 不认它的占地，
// 世界里就是「有参数没金字塔」/「植被不长了但塔也没长」。

test('巨型金字塔接线：computeRegionLayout 的 giantPyramid 字段与直接调用一致', async () => {
  const { computeRegionLayout } = await import('../gen/structures/structure-layout.js');
  for (const [rx, rz] of [[0, 1], [1, -1], [-2, -2], [3, 3]]) {
    const layout = computeRegionLayout(rx, rz, SEED);
    const direct = computeGiantPyramidAnchor(rx, rz, SEED);
    assertTrue('giantPyramid' in layout, `region(${rx},${rz}) layout 必须有 giantPyramid 字段`);
    if (direct === null) { assertEqual(layout.giantPyramid, null, `region(${rx},${rz})`); continue; }
    assertEqual(layout.giantPyramid.wx, direct.wx, `region(${rx},${rz}) wx`);
    assertEqual(layout.giantPyramid.wz, direct.wz, `region(${rx},${rz}) wz`);
    assertEqual(layout.giantPyramid.floorY, direct.floorY, `region(${rx},${rz}) floorY`);
  }
});

test('巨型金字塔接线：pointContext 在锚点占地内返回 kind=none（抑制植被/巨树）', async () => {
  const { computeRegionLayout } = await import('../gen/structures/structure-layout.js');
  const { giantAllowedAtFor } = await import('../gen/structures/apply.js');
  // 找一个有锚点的 region
  let layout = null;
  for (let rx = -3; rx <= 3 && !layout; rx++) {
    for (let rz = -3; rz <= 3 && !layout; rz++) {
      const l = computeRegionLayout(rx, rz, SEED);
      if (l.giantPyramid) layout = l;
    }
  }
  assertTrue(layout !== null, '必须找到有锚点的 region（否则本用例恒真）');
  const gp = layout.giantPyramid;
  const allowed = giantAllowedAtFor([layout], layout.city, SEED);
  assertFalse(allowed(gp.wx, gp.wz), '锚点正上方不得长巨树');
  assertFalse(allowed(gp.wx + 20, gp.wz + 20), '占地内不得长巨树');
  assertFalse(allowed(gp.wx - 24, gp.wz), '占地边界（±24）内不得长巨树');
  // 临界对照：占地外 1 格不受影响（防「整片都判 none」的过度抑制）
  assertTrue(allowed(gp.wx + PYRAMID_HALF + 2, gp.wz + PYRAMID_HALF + 2),
    '占地外（+26）不应被金字塔抑制');
});
