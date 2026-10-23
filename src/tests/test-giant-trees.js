// src/tests/test-giant-trees.js — 巨树景观（Giant Trees Epic）Tier 1：加载 / 旋转 / 候选发现
//
// 本文件钉的是审阅期实测出来的三类真实缺陷（注入该缺陷后对应用例必须 FAIL，见实施计划 Task 4 的负向验证表）：
//   · 旋转必须真的发生（`& 3` 恒为 0 → 旋转永不生效；旧测试靠 forcedRot 绕过所以全绿）
//   · 间距必须跨 region 边界成立（原贪心在 region 边界违规 64 对）
//   · chance 必须是真正的密度旋钮（原 forestChance 0.10→0.01 只少 40%）
// 姊妹文件：test-giant-trees-column.js（column 层）/ test-giant-trees-gen.js（接线与真实 GEN）。
// ⚠️ 写断言前先在真实数据上跑一次、打印实际值（testing-policy §2.6 ⑤）：本文件的下界/区间都取自实测的 1/4 量级。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse, assertDeepEqual } from './assert.js';
import {
  GIANT_FAMILY_ORDER, GIANT_STRIDE, GIANT_TREE_PATHS, isNearWater, isBiomeEdge, giantTreeRotation,
  computeGiantTreeCandidates, loadGiantTrees, rotateCell, rotatedFootprint, treeBox,
} from '../gen/structures/giant-trees.js';
import { generateHeight } from '../gen/terrain.js';
import { getBiome } from '../gen/noise.js';
import { REGION_SIZE } from '../gen/structures/region-config.js';
import { SEA_Y } from '../voxel/constants.js';

const SEED = 12345;

/** 3×3 region 块内某路径的全部候选（带所属 region） */
function blockCandidates(pathKey, regions = [-1, 0, 1]) {
  const out = [];
  for (const rx of regions) for (const rz of regions) {
    const arr = computeGiantTreeCandidates(rx, rz, SEED)[pathKey];
    for (let i = 0; i < arr.length; i += GIANT_STRIDE) out.push({ wx: arr[i], wy: arr[i + 1], wz: arr[i + 2], fam: arr[i + 3], vh: arr[i + 4], rx, rz });
  }
  return out;
}

// ======================================================================== 加载与旋转

test('巨树加载：28 个变体、族数与烘焙元数据一致、palette[0] 是树干、锚点是 gy=0 的树干格、无重复坐标', async () => {
  const { families } = await loadGiantTrees();
  const meta = await (await fetch('/assets/giant-trees/trees.meta.json')).json();
  let total = 0;
  for (const f of GIANT_FAMILY_ORDER) assertTrue(f in families, `族序里的 ${f} 在 trees.json 里`);
  assertEqual(Object.keys(families).length, GIANT_FAMILY_ORDER.length, '族序与 trees.json 的族一一对应');
  for (const [fam, list] of Object.entries(families)) {
    assertEqual(list.length, meta.families[fam], `${fam} 变体数与 trees.meta.json 一致`);
    for (const v of list) {
      total++;
      assertTrue(v.palette[0].endsWith('_log'), `${fam} palette[0] 是树干`);
      assertTrue(v.anchor[0] >= 0 && v.anchor[0] < v.w && v.anchor[1] >= 0 && v.anchor[1] < v.d, `${fam} 锚点在 bbox 内`);
      const seen = new Set(); let anchorIsTrunk = false;
      for (let k = 0; k < v.cells.length; k += 4) {
        const x = v.cells[k], y = v.cells[k + 1], z = v.cells[k + 2], p = v.cells[k + 3];
        assertTrue(p < v.palette.length, `${fam} palIdx ${p} 有效`);
        assertTrue(x < v.w && y < v.h && z < v.d, `${fam} 坐标 ${x},${y},${z} 在 bbox 内`);
        const key = (y * v.d + z) * v.w + x;
        assertFalse(seen.has(key), `${fam} 坐标 ${x},${y},${z} 不重复`);
        seen.add(key);
        if (y === 0 && p === 0 && x === v.anchor[0] && z === v.anchor[1]) anchorIsTrunk = true;
      }
      assertTrue(anchorIsTrunk, `${fam} 锚点格是 gy=0 层的树干格`);
    }
  }
  assertEqual(total, 28, '28 个变体 = 40 − 12 个排除项');
  assertEqual(total, meta.variantCount, '总数与 trees.meta.json 一致');
});

test('旋转：非正方形 AABB 旋转后宽深互换', () => {
  const v = { w: 5, d: 3 };
  assertDeepEqual(rotatedFootprint(v, 0), { w: 5, d: 3 });
  assertDeepEqual(rotatedFootprint(v, 1), { w: 3, d: 5 });
  assertDeepEqual(rotatedFootprint(v, 2), { w: 5, d: 3 });
  assertDeepEqual(rotatedFootprint(v, 3), { w: 3, d: 5 });
});

test('旋转：逐步旋转 4 次回到原位（非正方形）', () => {
  for (const [w, d] of [[5, 3], [7, 4], [11, 12]]) {
    for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) {
      let cur = [x, z], cw = w, cd = d;
      for (let r = 0; r < 4; r++) { cur = rotateCell({ w: cw, d: cd }, 1, cur[0], cur[1]); [cw, cd] = [cd, cw]; }
      assertDeepEqual(cur, [x, z], `(${x},${z}) 在 ${w}×${d} 里转 4 次回到原位`);
    }
  }
});

test('旋转：4 个朝向都是双射且输出落在旋转后的 bbox 内', () => {
  const v = { w: 7, d: 4 };
  for (let rot = 0; rot < 4; rot++) {
    const fp = rotatedFootprint(v, rot); const seen = new Set();
    for (let x = 0; x < v.w; x++) for (let z = 0; z < v.d; z++) {
      const [rx, rz] = rotateCell(v, rot, x, z);
      assertTrue(rx >= 0 && rx < fp.w && rz >= 0 && rz < fp.d, `rot=${rot} (${rx},${rz}) 在 ${fp.w}×${fp.d} 内`);
      const k = `${rx},${rz}`; assertFalse(seen.has(k), `rot=${rot} ${k} 不重复（双射）`); seen.add(k);
    }
    assertEqual(seen.size, v.w * v.d, `rot=${rot} 覆盖全部格`);
  }
});

test('giantTreeRotation：四个朝向都会出现且大致均匀（防 `& 3` 恒为 0 的回归）', () => {
  const hist = [0, 0, 0, 0]; let n = 0;
  for (let x = -200; x < 200; x += 4) for (let z = -200; z < 200; z += 4) { hist[giantTreeRotation(x, z, SEED)]++; n++; }
  for (let r = 0; r < 4; r++) assertTrue(hist[r] > n * 0.15 && hist[r] < n * 0.35, `rot=${r} 占比 ${(hist[r] / n).toFixed(3)} 应接近 25%（实测 ~0.25）`);
});

test('treeBox：锚点对齐候选点；AABB 宽深 = 旋转后的 footprint（全部变体 × 4 个朝向）', async () => {
  const { families } = await loadGiantTrees();
  for (const list of Object.values(families)) for (const v of list) for (let rot = 0; rot < 4; rot++) {
    const wx = -37, wz = 91; const b = treeBox(v, rot, wx, wz); const fp = rotatedFootprint(v, rot);
    assertEqual(b.x1 - b.x0 + 1, fp.w); assertEqual(b.z1 - b.z0 + 1, fp.d);
    const a = rotateCell(v, rot, v.anchor[0], v.anchor[1]);
    assertEqual(b.x0 + a[0], wx, '锚点 x 对齐'); assertEqual(b.z0 + a[1], wz, '锚点 z 对齐');
  }
});

// ======================================================================== 候选发现

test('候选确定性：同 seed 两次调用逐元素相等', () => {
  for (const [rx, rz] of [[0, 0], [-1, 0], [1, 1]]) {
    const a = computeGiantTreeCandidates(rx, rz, SEED), b = computeGiantTreeCandidates(rx, rz, SEED);
    for (const k of ['forest', 'beach', 'banyan']) {
      assertEqual(a[k].length, b[k].length, `${k} 长度一致`);
      for (let i = 0; i < a[k].length; i++) assertEqual(a[k][i], b[k][i], `${k}[${i}]`);
    }
  }
});

test('候选结构：stride、族下标 ⊂ 该路径的两个族、变体 hash 范围、wy = 地表+1', () => {
  for (const p of GIANT_TREE_PATHS) {
    const list = blockCandidates(p.key);
    assertTrue(list.length > 0, `${p.key} 有候选`);
    for (const c of list) {
      assertTrue(p.families.includes(c.fam), `${p.key} 族下标 ${c.fam} 在 ${p.families}`);
      assertTrue(c.vh >= 0 && c.vh < 65536, `${p.key} 变体 hash ${c.vh} 在 [0,65536)`);
      assertEqual(c.wy, generateHeight(c.wx, c.wz, SEED) + 1, `${p.key} (${c.wx},${c.wz}) wy = h+1`);
    }
  }
  for (const k of ['forest', 'beach', 'banyan']) assertEqual(computeGiantTreeCandidates(0, 1, SEED)[k].length % GIANT_STRIDE, 0, `${k} 长度是 stride 的倍数`);
});

test('候选判据：A 只在 FOREST 且陆上；B 陆上且距水 ≤ band；C 在 PLAINS/DESERT 且 ±band 内跨 biome（与实现共用导出的谓词）', () => {
  const [A, B, C] = GIANT_TREE_PATHS;
  for (const c of blockCandidates('forest')) {
    assertEqual(getBiome(c.wx, c.wz, SEED), 'FOREST', `A (${c.wx},${c.wz}) 是 FOREST`);
    assertTrue(c.wy - 1 > SEA_Y, `A (${c.wx},${c.wz}) 在陆上`);
  }
  for (const c of blockCandidates('beach')) {
    assertTrue(c.wy - 1 > SEA_Y, `B (${c.wx},${c.wz}) 在陆上`);
    assertTrue(isNearWater(c.wx, c.wz, SEED, B.band), `B (${c.wx},${c.wz}) 距水 ≤ ${B.band}`);
  }
  for (const c of blockCandidates('banyan')) {
    const b = getBiome(c.wx, c.wz, SEED);
    assertTrue(b === 'PLAINS' || b === 'DESERT', `C (${c.wx},${c.wz}) biome=${b}`);
    assertTrue(c.wy - 1 > SEA_Y, `C (${c.wx},${c.wz}) 在陆上`);
    assertTrue(isBiomeEdge(c.wx, c.wz, SEED, C.band), `C (${c.wx},${c.wz}) 是草地/沙漠交界`);
  }
  assertTrue(A.key === 'forest', '路径序 A=forest');
});

test('isNearWater 单调：band 小者 ⊆ band 大者（采样点集合随 band 扩大）', () => {
  let near4 = 0;
  for (let x = -300; x < 300; x += 7) for (let z = -300; z < 300; z += 7) {
    if (isNearWater(x, z, SEED, 4)) { near4++; assertTrue(isNearWater(x, z, SEED, 24), `(${x},${z}) band4 近水则 band24 近水`); }
  }
  assertTrue(near4 > 0, '采样里确有近水点（否则本用例无判别力）');
});

test('候选间距（含 region 边界）：同路径任意两点切比雪夫距离 ≥ spacing + 1（构造性保证）', () => {
  for (const p of GIANT_TREE_PATHS) {
    const list = blockCandidates(p.key); let minD = Infinity;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      minD = Math.min(minD, Math.max(Math.abs(list[i].wx - list[j].wx), Math.abs(list[i].wz - list[j].wz)));
    }
    assertTrue(minD >= p.spacing + 1, `${p.key} 最小间距 ${minD} ≥ ${p.spacing + 1}`);
  }
});

test('候选 region 归属：每个点落在自己所属 region 内，且 3×3 块内无重复点', () => {
  for (const p of GIANT_TREE_PATHS) {
    const seen = new Set();
    for (const c of blockCandidates(p.key)) {
      assertEqual(Math.floor(c.wx / REGION_SIZE), c.rx, `${p.key} (${c.wx},${c.wz}) x 属于 region ${c.rx}`);
      assertEqual(Math.floor(c.wz / REGION_SIZE), c.rz, `${p.key} (${c.wx},${c.wz}) z 属于 region ${c.rz}`);
      const k = `${c.wx},${c.wz}`; assertFalse(seen.has(k), `${p.key} ${k} 不重复（跨 region 的 cell 只被一侧保留）`); seen.add(k);
    }
  }
});

test('chance 是有效的密度旋钮（原设计的 forestChance 在贪心下几乎无效）', () => {
  const regions = [[-1, 0], [0, -1], [1, 0]];
  const count = (chance) => {
    const paths = GIANT_TREE_PATHS.map((p) => ({ ...p, chance }));
    return regions.reduce((s, [rx, rz]) => s + computeGiantTreeCandidates(rx, rz, SEED, paths).forest.length / GIANT_STRIDE, 0);
  };
  const full = count(1), half = count(0.5);
  assertEqual(count(0), 0, 'chance=0 → 无候选');
  assertTrue(full >= 60, `chance=1 有足够多的森林候选（实测 ≥ 100，下界取 60）：${full}`);
  assertTrue(half > full * 0.35 && half < full * 0.65, `chance=0.5 → 约一半：${half} / ${full}`);
});

test('候选密度下界（防谓词写崩变恒空）：A ≥ 91、B ≥ 385、C ≥ 266（均为实测的 2/3）', () => {
  // 实测（交付值：A spacing=32、B spacing=12、C spacing=8）：137 / 578 / 399
  // （3×3 region 块，含城区 region(0,0) 内部、apply 层尚未排除的点）。
  // 下界统一取实测的 **2/3**，不是更宽松的 1/4 —— 两条路径的密度都会被反复调
  // （A 14→20→32、B 8→6 → 12→8），若下界离实测太远，调稀后断言仍绿但已失去判别力。
  // ⚠️ 重新调任一条路径的 spacing/jitter 后，须按新实测值重算本处三个下界（保持 2/3 口径）。
  assertTrue(blockCandidates('forest').length >= 91, 'A 候选下界');
  assertTrue(blockCandidates('beach').length >= 385, 'B 候选下界');
  assertTrue(blockCandidates('banyan').length >= 266, 'C 候选下界');
});

test('候选发现耗时：单 region 三路径 < 8ms（原逐点扫描法 14~20ms；网格抖动实测 ~1ms）', () => {
  computeGiantTreeCandidates(1, 1, SEED); // 预热
  let best = Infinity;
  for (let i = 0; i < 3; i++) { const t0 = performance.now(); computeGiantTreeCandidates(1, 1, SEED); best = Math.min(best, performance.now() - t0); }
  assertTrue(best < 8, `候选发现 ${best.toFixed(2)}ms < 8ms`);
});
