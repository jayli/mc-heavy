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
  PATCH_CELL, PATCH_SALT,
} from '../gen/structures/giant-trees.js';
import { generateHeight } from '../gen/terrain.js';
import { getBiome } from '../gen/noise.js';
import { REGION_SIZE } from '../gen/structures/region-config.js';
import { SEA_Y } from '../voxel/constants.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { FACES_DATA } from '../voxel/faces-data.js';
import { buildSectionMesh } from '../mesh/mesher.js';

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

test('候选密度下界（防谓词写崩变恒空）：A ≥ 91、B ≥ 134、C ≥ 34（均为实测的 2/3）', () => {
  // 实测（交付值：A spacing=32 / patchChance=1、B spacing=12 / patchChance=1/3、C spacing=17 / patchChance=1/2）：
  // 137 / 201 / 51
  // （3×3 region 块，含城区 region(0,0) 内部、apply 层尚未排除的点）。
  // 下界统一取实测的 **2/3**，不是更宽松的 1/4 —— 三条路径的密度都会被反复调
  // （A 14→20→32、B 8/6 → 12/8、C 8/6 → 12/8 → 17/11），若下界离实测太远，调稀后断言仍绿但已失去判别力。
  // ⚠️ 重新调任一条路径的 spacing/jitter **或 patchChance** 后，须按新实测值重算本处三个下界（保持 2/3 口径）。
  assertTrue(blockCandidates('forest').length >= 91, 'A 候选下界');
  assertTrue(blockCandidates('beach').length >= 134, 'B 候选下界');
  assertTrue(blockCandidates('banyan').length >= 34, 'C 候选下界');
});

// ---------------------------------------------------------------- 区域门控（2026-10-24）
//
// 用户要「平均 3 个海滩里有 1 个有巨树矩阵」「平均 2 个榕树带里有 1 个」，**且密度维持照旧**。
// 因为 beach 候选在几何上连成一条 1187×1187 的连续带（连通聚类实测：阈值 64 以上只剩 1 簇），
// 「一个海滩」没有客观边界 → 用粗格（PATCH_CELL）整格抽签实现「整段有树 / 整段没有」。
//
// 这四条用例钉住的是**区域门控本身**，不是密度：
//   ① 确定性（红线 2）  ② 通过率≈patchChance  ③ 同粗格同进退（成片，不是斑点）  ④ forest 不受影响

test('区域门控：确定性 —— 同 seed 两次调用逐元素相等（红线 2）', () => {
  for (const [rx, rz] of [[0, 0], [-1, 0], [1, 1]]) {
    for (const k of ['beach', 'banyan']) {
      const a = computeGiantTreeCandidates(rx, rz, SEED)[k];
      const b = computeGiantTreeCandidates(rx, rz, SEED)[k];
      assertEqual(a.length, b.length, `${k} (${rx},${rz}) 长度一致`);
      for (let i = 0; i < a.length; i++) assertEqual(a[i], b[i], `${k} (${rx},${rz}) [${i}]`);
    }
  }
});

test('区域门控：粗格覆盖率 ≈ patchChance（beach 1/3、banyan 1/2；防「门控恒开/恒关」）', () => {
  // 口径 = **粗格**覆盖率（不是树的覆盖率）：用户说的是「多少个海滩有树」，单位就是粗格。
  // 实测（seed 12345，cell=128）：beach 0.333（精确命中 1/3）、banyan 0.429。区间留足余量，不贴线。
  const CELL = PATCH_CELL;
  const cov = (key) => {
    const all = new Set(), hit = new Set();
    for (const [rx, rz] of [[-1, 0], [0, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1]]) {
      const arr = computeGiantTreeCandidates(rx, rz, SEED)[key];
      for (let i = 0; i < arr.length; i += GIANT_STRIDE) {
        const k = `${Math.floor(arr[i] / CELL)},${Math.floor(arr[i + 2] / CELL)}`;
        hit.add(k);
      }
    }
    // 分母 = 不加门控时**应当**有候选的粗格集（用 patchChance=1 的覆写路径算）
    const noGate = GIANT_TREE_PATHS.map((q) => ({ ...q, patchChance: 1 }));
    for (const [rx, rz] of [[-1, 0], [0, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1]]) {
      const arr = computeGiantTreeCandidates(rx, rz, SEED, noGate)[key];
      for (let i = 0; i < arr.length; i += GIANT_STRIDE) all.add(`${Math.floor(arr[i] / CELL)},${Math.floor(arr[i + 2] / CELL)}`);
    }
    return hit.size / all.size;
  };
  const beach = cov('beach');
  assertTrue(beach > 0.2 && beach < 0.5, `beach 粗格覆盖率 ${beach.toFixed(3)} 应在 (0.2, 0.5)（目标 1/3）`);
  const banyan = cov('banyan');
  assertTrue(banyan > 0.3 && banyan < 0.7, `banyan 粗格覆盖率 ${banyan.toFixed(3)} 应在 (0.3, 0.7)（目标 1/2）`);
  assertTrue(Math.abs(beach - 1 / 3) < 0.12, `beach 覆盖率应接近 1/3（实测差 ${Math.abs(beach - 1 / 3).toFixed(3)}）`);
});

test('区域门控：同粗格同进退 —— 整段有树/整段没有（防「按候选点哈希」的斑点式回归）', () => {
  // 这是「成片 vs 斑点」的唯一判据：粗格内要么全部候选都在，要么一个都不在。
  // 负向验证：把门控改成按 (wx, wz) 哈希 → 本用例必 FAIL。
  const CELL = PATCH_CELL;
  const noGate = GIANT_TREE_PATHS.map((q) => ({ ...q, patchChance: 1 }));
  const regions = [[-1, 0], [0, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1]];
  for (const key of ['beach', 'banyan']) {
    // 每个粗格：(无门控候选数, 有门控候选数)
    const cells = new Map();
    const add = (arr, isGated) => {
      for (let i = 0; i < arr.length; i += GIANT_STRIDE) {
        const k = `${Math.floor(arr[i] / CELL)},${Math.floor(arr[i + 2] / CELL)}`;
        if (!cells.has(k)) cells.set(k, { full: 0, kept: 0 });
        const c = cells.get(k);
        if (isGated) c.kept++; else c.full++;
      }
    };
    for (const [rx, rz] of regions) {
      add(computeGiantTreeCandidates(rx, rz, SEED, noGate)[key], false);
      add(computeGiantTreeCandidates(rx, rz, SEED)[key], true);
    }
    let partial = 0, covered = 0, empty = 0;
    for (const c of cells.values()) {
      if (c.kept === c.full) covered++; else if (c.kept === 0) empty++; else partial++;
    }
    assertEqual(partial, 0, `${key}：没有任何粗格是「部分保留」的（实得 ${partial} 个）—— 粗格只能整体通过或整体跳过`);
    assertTrue(covered > 0, `${key}：至少有一个粗格通过（否则门控恒关）`);
    assertTrue(empty > 0, `${key}：至少有一个粗格被跳过（否则门控恒开）`);
  }
});

test('区域门控：实现 == 「粗格哈希」的定义（手工用 PATCH_CELL/PATCH_SALT 复算，逐元素比对）', () => {
  // 不只断言「成片」，还钉住门控**具体是哪个哈希**：把候选按 patchChance=1 全量取出来，
  // 再用 seededRandom(floor(wx/CELL), floor(wz/CELL), seed+PATCH_SALT) < patchChance 手工筛，
  // 结果必须与实现逐元素相同。这一条防止「换成另一个碰巧也成片的实现」静默通过。
  const seededRandom = (x, z, s) => { const v = Math.sin(x * 12.9898 + z * 78.233 + s) * 43758.5453123; return v - Math.floor(v); };
  const noGate = GIANT_TREE_PATHS.map((q) => ({ ...q, patchChance: 1 }));
  const regions = [[-1, 0], [0, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1]];
  for (const key of ['beach', 'banyan']) {
    const p = GIANT_TREE_PATHS.find((q) => q.key === key).patchChance;
    assertTrue(p < 1, `${key} 的 patchChance 应 < 1（实测 ${p}）`);
    let expect = 0, actual = 0;
    for (const [rx, rz] of regions) {
      const all = computeGiantTreeCandidates(rx, rz, SEED, noGate)[key];
      const got = computeGiantTreeCandidates(rx, rz, SEED)[key];
      const hand = [];
      for (let i = 0; i < all.length; i += GIANT_STRIDE) {
        if (seededRandom(Math.floor(all[i] / PATCH_CELL), Math.floor(all[i + 2] / PATCH_CELL), SEED + PATCH_SALT) < p) {
          hand.push(all[i], all[i + 1], all[i + 2], all[i + 3], all[i + 4]);
        }
      }
      assertEqual(got.length, hand.length, `${key} (${rx},${rz}) 长度与手工复算一致`);
      for (let i = 0; i < hand.length; i++) assertEqual(got[i], hand[i], `${key} (${rx},${rz}) [${i}] 与手工复算一致`);
      expect += hand.length / GIANT_STRIDE;
      actual += got.length / GIANT_STRIDE;
    }
    assertEqual(actual, expect, `${key} 总数与手工复算一致`);
    assertTrue(actual > 0, `${key} 门控后仍有候选（防手工复算与实现双双恒空）`);
  }
});

test('区域门控：forest 不受影响（patchChance=1，候选数与不加门控时逐位相同）', () => {
  // 用户只要求海滩/榕树带；森林里应当处处都长（既有行为不变）。
  const noGate = GIANT_TREE_PATHS.map((q) => ({ ...q, patchChance: 1 }));
  const regions = [[-1, 0], [0, 0], [1, 0], [0, -1], [0, 1]];
  let gated = 0, raw = 0;
  for (const [rx, rz] of regions) {
    gated += computeGiantTreeCandidates(rx, rz, SEED).forest.length / GIANT_STRIDE;
    raw += computeGiantTreeCandidates(rx, rz, SEED, noGate).forest.length / GIANT_STRIDE;
  }
  assertEqual(gated, raw, `forest 候选数不因区域门控变化：${gated} vs ${raw}`);
  assertTrue(gated > 0, `forest 确有候选（防恒空导致的恒真）`);
});

test('候选发现耗时：单 region 三路径 < 8ms（原逐点扫描法 14~20ms；网格抖动实测 ~1ms）', () => {
  computeGiantTreeCandidates(1, 1, SEED); // 预热
  let best = Infinity;
  for (let i = 0; i < 3; i++) { const t0 = performance.now(); computeGiantTreeCandidates(1, 1, SEED); best = Math.min(best, performance.now() - t0); }
  assertTrue(best < 8, `候选发现 ${best.toFixed(2)}ms < 8ms`);
});

// ---------------------------------------------------------------- 树叶渲染通道契约（2026-10-23）

/** 6 个巨树叶方块名（声明侧权威 = blocks-data.js） */
const LEAF_NAMES = BLOCKS.filter((b) => b.name.startsWith('giant_') && b.name.endsWith('_leaves')).map((b) => b.name);

/** 建一个只含「小片叶团 + 一根树干」的 18³ halo 视图（与 Worker 内 buildSectionMesh 同口径） */
function leafClusterView(leafId, logId) {
  const data = new Uint16Array(18 * 18 * 18);
  const light = new Uint8Array(18 * 18 * 18);
  const meta = new Uint8Array(18 * 18 * 18);
  const vi = (x, y, z) => x + z * 18 + y * 324;
  for (let y = 4; y < 12; y++) for (let x = 5; x < 13; x++) for (let z = 5; z < 13; z++) data[vi(x, y, z)] = leafId;
  for (let y = 1; y < 5; y++) data[vi(8, y, 8)] = logId;
  light.fill(0xff);
  return { data, light, meta, missing: false };
}

/** 真实 atlas 的 tiles（mesher 需要 tile 的 u0/v0/u1/v1）；在系统里只能从已有实例取，故从 atlas 文件读不可行 → 用派生假 atlas */
function fakeAtlas() {
  // mesher 只需要 tiles[name] 存在且带 u0/v0/u1/v1；同一组 UV 即可（本用例不验证 UV）
  const t = { u0: 0, v0: 0, u1: 1, v1: 1 };
  const tiles = {};
  for (const b of BLOCKS) {
    const v = FACES_DATA[b.name];
    if (!v) continue;
    for (const name of (Array.isArray(v) ? v : [v])) if (name) tiles[name] = t;
  }
  return { tiles };
}

test('巨树叶渲染通道：cullMode=cutout（镂空 alpha 生效）且 opaqueTable=1（叶-叶共享面仍互剔）', () => {
  // 钉住两套口径的**成对**关系（缺一不可）：
  //   · cullMode=opaque → opaque 通道 alphaTest=0 → 镂空 alpha 被忽略，叶面变不透光的实心块；
  //   · 漏写 opaque:true → opaqueTable=0 → 叶-叶共享面不再互剔，实测顶点数 ×7.78。
  // 两者都是**静默**失败（不报错、不抛异常，只是观感/容量错），故必须靠断言钉。
  assertEqual(LEAF_NAMES.length, 6, `巨树叶方块数：${LEAF_NAMES.join(', ')}`);
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  for (const n of LEAF_NAMES) {
    const def = BLOCKS.find((b) => b.name === n);
    assertEqual(def.cullMode, 'cutout', `"${n}" 必须是 cutout（opaque 通道 alphaTest=0 → 镂空失效）`);
    assertFalse(def.opaque === false, `"${n}" 不得写 opaque:false`);
    const id = reg.idOf(n);
    assertEqual(reg.opaqueTable[id], 1, `"${n}" 的 opaqueTable 必须为 1（漏写 opaque:true 则叶-叶共享面不互剔，顶点 ×7.78）`);
    assertTrue(reg.castsShadow(id), `"${n}" 必须投影`);
  }
});

test('巨树叶顶点守卫：cutout + opaqueTable=1 的总顶点**接近纯 opaque 口径**（防「顺手」删 opaque:true）', () => {
  // 实测（真实 atlas + 8³ 叶团 + 一根树干）：
  //   纯 opaque + opaqueTable=1  → 总 1584
  //   现行（cutout + opaque:1）  → 总 1584（零增长，只是分布从 opaque 转到 cutout）
  //   cutout + opaqueTable=0     → 总 12316（×7.78）
  //
  // ⚠️ 断言设计踩过的坑（负向验证实测）：最初写「cutout 口径 == 临时拨回纯 opaque 口径」，
  // 但注入「删 opaque:true」后**两条路径都是 opaqueTable=0** → 总数仍相等 → 用例仍绿（盲区）。
  // 修法 = 对照侧显式写死 opaqueTable=1（不依赖被测声明），被测侧用真实声明值。
  // 这样声明写错时两侧不等，断言才真 FAIL。
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  const leafId = reg.idOf('giant_oak_leaves');
  const logId = reg.idOf('giant_oak_log');
  const atlas = fakeAtlas();

  const total = (r) => r.opaque.positions.length / 3 + r.cutout.positions.length / 3 + r.transparent.positions.length / 3;

  // 被测：真实声明（cutout 口径）
  const now = total(buildSectionMesh(leafClusterView(leafId, logId), reg, atlas, 0, 0, 0));

  // 对照：强制 cullTable=0 **且 opaqueTable=1**（不信任被测声明）
  const savedCull = reg.cullTable[leafId];
  const savedOpaque = reg.opaqueTable[leafId];
  reg.cullTable[leafId] = 0;
  reg.opaqueTable[leafId] = 1;
  const base = total(buildSectionMesh(leafClusterView(leafId, logId), reg, atlas, 0, 0, 0));
  reg.cullTable[leafId] = savedCull;
  reg.opaqueTable[leafId] = savedOpaque;

  assertTrue(base > 0, '对照组应产生顶点（防两侧都是 0 的恒真）');
  assertEqual(now, base, `cutout 口径总顶点 ${now} 应等于「强制 opaqueTable=1」口径 ${base}（差 ${now - base}）—— 不等即说明声明漏了 opaque:true`);
  // 防阦值：无论如何不得接近不剔除口径（×7.78 → ~12k）
  assertTrue(now < base * 1.5, `总顶点 ${now} 不得接近不剔除口径（×7.78 → ~12k）`);
});
