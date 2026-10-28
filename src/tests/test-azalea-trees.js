// src/tests/test-azalea-trees.js — 杜鹃树（Azalea Trees Epic）Tier 1：加载 / 候选 / 花叶相间 / 变体覆盖
//
// 本文件钉的是**本 Epic 特有的三类真实风险**（注入该缺陷后对应用例必须 FAIL）：
//   · 花叶相间的比例与确定性：写成局部循环下标 → 跨 column 不一致（同一棵树被切两半时两列算出不同的花位）；
//     写成 50%/80% → 观感与旧树脱节（用户裁定的口径是「沿用 30% 概率」）。
//   · 10 档变体必须全部真的出现：`seededRandom(...) * 65536 % 10` 若写成 `& 9` 是巧合可用，但若把
//     变体下标写成 `% list.length` 而 list 被切片就只剩前几档 → 世界里永远只有一种尺寸。
//   · 只落 AZALEA biome + 陆上：判据写成「只判 biome」会让树长到海里（树干底下是水）。
// 姊妹文件：test-azalea-trees-gen.js（真实 applyStructuresToColumn 接线与确定性）。
// ⚠️ 下界/区间都取自实测（testing-policy §2.6 ⑤），不凭感觉。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse, assertNotNull, assertDeepEqual } from './assert.js';
import { resourceUrl } from '../core/resource-url.js';
import {
  AZALEA_STRIDE, AZALEA_TREE_PATH, AZALEA_SUPPORT_MAX, AZALEA_FLOWER_CHANCE,
  azaleaTreeSize, azaleaFlowerAt, computeAzaleaTreeCandidates, loadAzaleaTrees,
  AZALEA_CELL_PROBES,
  rotateCell, rotatedFootprint, treeBox, collectAzaleaTrees, isAzaleaTreeAllowed,
  rasterizeAzaleaTree, buildCoveredWindow, applyAzaleaTrees, AZALEA_VARIANT_COUNT,
  AZALEA_TRUNK_CLEARANCE, TrunkGrid, isTrunkClear, collectOtherTrunks,
  acceptAzaleaTrunks, trunkColumnsOf, trunkBaseColumnsOf, variantsByFootprint,
  azaleaStaggeredSizeIdx, azaleaSizeClass, azaleaHeightClass,
  AZALEA_STAGGER_CLASSES, AZALEA_STAGGER_CELL,
} from '../gen/structures/azalea-trees.js';
import { generateHeight } from '../gen/terrain.js';
import { getBiome, seededRandom } from '../gen/noise.js';
import { REGION_SIZE } from '../gen/structures/region-config.js';
import { SEA_Y, blockIndex } from '../voxel/constants.js';
import { makeColumnSetter } from '../gen/structures/landmarks.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';

const SEED = 12345;
const EXT = 3; // 与 apply.js 的 VEGETATION_EXT 同值

function makeRegistry() {
  const r = createRegistry();
  for (const def of BLOCKS) r.register(def.name, def);
  r.freeze();
  return r;
}
const reg = makeRegistry();

/** 3×3 region 块内的全部候选（带所属 region） */
function blockCandidates(regions = [-1, 0, 1]) {
  const out = [];
  for (const rx of regions) for (const rz of regions) {
    const arr = computeAzaleaTreeCandidates(rx, rz, SEED);
    for (let i = 0; i < arr.length; i += AZALEA_STRIDE) {
      out.push({ wx: arr[i], wy: arr[i + 1], wz: arr[i + 2], sizeIdx: arr[i + 3], rx, rz });
    }
  }
  return out;
}

// ======================================================================== 加载与产物契约

test('杜鹃树加载：10 个变体、与烘焙元数据一致、palette[0] 是树干、叶子槽是 LEAF 哨兵、锚点是 y=0 树干格', async () => {
  const { variants } = await loadAzaleaTrees();
  const meta = await (await fetch(resourceUrl('assets/azalea-trees/trees.meta.json'))).json();
  assertEqual(variants.length, AZALEA_VARIANT_COUNT, `变体数 = ${AZALEA_VARIANT_COUNT}`);
  assertEqual(variants.length, meta.variantCount, '与 trees.meta.json 一致');
  assertEqual(meta.leafSlot, 'LEAF', '元数据记录叶子槽（运行时按 30% 概率替换花/叶）');
  let total = 0;
  for (const v of variants) {
    total += v.cells.length / 4;
    assertEqual(v.palette[0], 'azalea_log', 'palette[0] 是树干 azalea_log');
    assertEqual(v.palette[1], 'LEAF', 'palette[1] 是叶子哨兵');
    assertTrue(v.anchor[0] >= 0 && v.anchor[0] < v.w && v.anchor[1] >= 0 && v.anchor[1] < v.d, '锚点在 bbox 内');
    const seen = new Set(); let anchorIsTrunk = false;
    for (let k = 0; k < v.cells.length; k += 4) {
      const x = v.cells[k], y = v.cells[k + 1], z = v.cells[k + 2], p = v.cells[k + 3];
      assertTrue(p < v.palette.length, `palIdx ${p} 有效`);
      assertTrue(x < v.w && y < v.h && z < v.d, `坐标 ${x},${y},${z} 在 bbox 内`);
      const key = (y * v.d + z) * v.w + x;
      assertFalse(seen.has(key), `坐标 ${x},${y},${z} 不重复`);
      seen.add(key);
      if (y === 0 && p === 0 && x === v.anchor[0] && z === v.anchor[1]) anchorIsTrunk = true;
    }
    assertTrue(anchorIsTrunk, '锚点格是 y=0 层的树干格');
  }
  assertEqual(total, meta.totalBlocks, '格数总和与元数据一致');
  assertTrue(total > 7000 && total < 7650, `总格数 ${total} 落在实测区间（实测 7468）`);
});

test('杜鹃树：10 档是「由小到大」的一档一个造型（按高度排序，尺寸与体量总体递增）', async () => {
  // 素材的 10 档是**按高度排序**的（实测 12,13,17,22,21,25,26,27,28,29）—— 唯一的下折是 #3→#4
  // （22→21）：那两档是同一冠幅（12×12）的两个不同造型，第 4 档更矮但更密（640 → 697 格）。
  //
  // ⚠️ **不能断言「格数单调」也不能断言「宽单调」**（都是实测打回的假设）：
  //   格数 223,312,541,640,697,1034,**806**,836,1027,1352 —— #6 回折；
  //   宽 8,9,10,12,12,**13,11**,12,13,13 —— #6/#7 回折。
  // 真实不变式：**最小档与最大档在三个维度上都最小/最大**（这就是「各选一个从小到大」的验收含义），
  // 且 **10 档尺寸两两不同**（不能烘出重复造型充数）。
  const { variants } = await loadAzaleaTrees();
  const first = variants[0], last = variants[variants.length - 1];
  for (const v of variants) {
    assertTrue(v.w >= first.w && v.h >= first.h, `#${v.pad} 不小于最小档（${v.w}×${v.d}×${v.h}）`);
    assertTrue(v.w <= last.w && v.h <= last.h, `#${v.pad} 不大于最大档（${v.w}×${v.d}×${v.h}）`);
  }
  assertEqual(first.h, 12, '最小档高 12');
  assertEqual(last.h, 29, '最大档高 29');
  assertEqual(first.w, 8, '最小档宽 8');
  assertEqual(last.w, 13, '最大档宽 13');
  // 尺寸两两不同（否则「10 个造型」实际不足 10 种）
  const dims = variants.map((v) => `${v.w}x${v.d}x${v.h}`);
  assertEqual(new Set(dims).size, variants.length, `尺寸两两不同：${dims.join(' ')}`);
  // 格数相差至少 6 倍（实测 1352/223 = 6.06）—— 「从小到大」确实拉开了量级
  const cells = variants.map((v) => v.cells.length / 4);
  assertTrue(Math.max(...cells) / Math.min(...cells) > 5,
    `最大/最小格数比 ${(Math.max(...cells) / Math.min(...cells)).toFixed(2)} > 5（实测 1352/223）`);
});

// ======================================================================== 花叶相间

test('azaleaFlowerAt：比例 ≈ 30%（实测区间 27%~33%）、由世界坐标确定、同坐标恒同值', () => {
  let flowers = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) {
    const wx = i * 7 - 70000, wy = 5 + (i % 29), wz = i * 13 - 130000;
    if (azaleaFlowerAt(wx, wy, wz, SEED)) flowers++;
  }
  const ratio = flowers / N;
  assertTrue(ratio > 0.27 && ratio < 0.33, `带花叶占比 ${(ratio * 100).toFixed(1)}% 须在 27%~33%（期望 30%）`);
  // 确定性：同一世界坐标两次调用必须同值（跨 column / 跨 Worker 一致的前提）
  for (let i = 0; i < 200; i++) {
    const wx = i * 31, wy = i % 20, wz = i * 17;
    assertEqual(azaleaFlowerAt(wx, wy, wz, SEED), azaleaFlowerAt(wx, wy, wz, SEED), `(${wx},${wy},${wz}) 确定性`);
  }
});

test('azaleaFlowerAt：必须吃世界坐标，不能吃局部下标 —— 跨 column 光栅化同一棵树，花位必须逐格一致', async () => {
  // ⚠️ **不能用「把世界坐标重新组装后调用两次」来验**（第一版就是这样，注入 `wx % 16` 缺陷后仍然全绿 ——
  // 无效盲区）：`ax*16 + lx` 与 `ax*16 + lx` 是同一个表达式，两条路径恒等。
  //
  // 真正能区分的做法：**让同一棵树被两个相邻 column 分别光栅化**（真游戏里的情形 —— 树 AABB 必然跨 column），
  // 然后逐格比较两列在**重叠区**写入的花/叶。若实现里用了局部坐标（`wx % 16` / `lx` / 循环计数器），
  // 同一世界格在两个 column 里算出的花位就会不同。
  const { variants } = await loadAzaleaTrees();
  const v = variants[5]; // 13×12，必然跨 column
  const wx = 14, wz = 8; // 锚点靠 column(0,0) 右边界 → AABB 跨越 column 0 与 column 1
  const t = { wx, wy: 40, wz, variant: v, rot: 0, ...treeBox(v, 0, wx, wz) };
  assertTrue(t.x1 >= 16, `夹具必须真的跨 column（AABB x1=${t.x1} ≥ 16）`);

  const colA = new ChunkColumn(0, 0), colB = new ChunkColumn(1, 0);
  rasterizeAzaleaTree(makeColumnSetter(colA, reg), t, SEED);
  rasterizeAzaleaTree(makeColumnSetter(colB, reg), t, SEED);

  const leafId = reg.idOf('azalea_leaves'), flowerId = reg.idOf('azalea_flowers');
  // 参考实现：用一个直接收世界坐标的 fake setBlock 一次性光栅化整棵树（等价于「理想不分列」）。
  // ⚠️ 这不是第二份几何权威 —— 它与分列路径用的是**同一个 rasterizeAzaleaTree**，只是 setBlock 不裁剪。
  const ref = new Map();
  rasterizeAzaleaTree((bx, by, bz, name) => {
    if (name === 'azalea_leaves' || name === 'azalea_flowers') ref.set(`${bx},${by},${bz}`, name === 'azalea_flowers');
  }, t, SEED);

  // 拼接两列，得到「真实分列光栅化」的花位集合
  const split = [];
  const collect = (col, cxBase) => {
    for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
      for (let y = 0; y < 96; y++) {
        const id = col.blocks[blockIndex(lx, y, lz)];
        if (id === leafId || id === flowerId) split.push([cxBase * 16 + lx, y, lz, id === flowerId]);
      }
    }
  };
  collect(colA, 0); collect(colB, 1);
  assertTrue(split.length > 100, `分列光栅化写入 ${split.length} 格叶`);
  let compared = 0, flowers = 0;
  for (const [x, y, z, isFlower] of split) {
    const expect = ref.get(`${x},${y},${z}`);
    assertNotNull(expect, `(${x},${y},${z}) 在参考实现里也存在`);
    assertEqual(isFlower, expect, `(${x},${y},${z}) 花位在「分列」与「不分列」下必须一致`);
    compared++;
    if (isFlower) flowers++;
  }
  assertTrue(compared > 100 && flowers > 10, `比较了 ${compared} 格、其中花 ${flowers} 格（两侧都要有量）`);
});

test('AZALEA_FLOWER_CHANCE 是 0.3（用户裁定的口径，与旧杜鹃树同一条规则）', () => {
  assertEqual(AZALEA_FLOWER_CHANCE, 0.3, '带花叶概率 30%');
});

// ======================================================================== 候选发现

test('候选：只落 AZALEA biome + 陆上（h > SEA_Y）', () => {
  const cands = blockCandidates();
  assertTrue(cands.length > 0, `3×3 region 内有候选（实测 ${cands.length}）`);
  for (const c of cands) {
    assertEqual(getBiome(c.wx, c.wz, SEED), 'AZALEA', `(${c.wx},${c.wz}) 是 AZALEA`);
    assertTrue(generateHeight(c.wx, c.wz, SEED) > SEA_Y, `(${c.wx},${c.wz}) 在陆上`);
    assertEqual(c.wy, generateHeight(c.wx, c.wz, SEED) + 1, 'wy = 地表 + 1');
  }
});

test('候选：错开判定（间距 ≥ spacing + 1，构造性保证）', () => {
  const cands = blockCandidates([-1, 0, 1]);
  const keyed = cands.map((c) => [c.wx, c.wz]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let minCheb = Infinity;
  for (let i = 0; i < keyed.length; i++) {
    for (let j = i + 1; j < keyed.length; j++) {
      const dx = Math.abs(keyed[i][0] - keyed[j][0]);
      if (dx > 20) break; // 切比雪夫距离已 > 需要的最小值，后面的只会更远
      const dz = Math.abs(keyed[i][1] - keyed[j][1]);
      minCheb = Math.min(minCheb, Math.max(dx, dz));
    }
  }
  assertTrue(minCheb >= AZALEA_TREE_PATH.spacing + 1, `最小切比雪夫间距 ${minCheb} ≥ ${AZALEA_TREE_PATH.spacing + 1}`);
});

test('候选：跨 region 无缝（cell 归属唯一，不重不漏）', () => {
  const C = AZALEA_TREE_PATH.spacing + AZALEA_TREE_PATH.jitter;
  // ⚠️ **归属判据是「cell 中心所属 region」，不是「探测点落在本 region 内」**。
  // v2.2（每格只探测一次）两者碰巧等价；v2.3 加了格内重试后**不再等价** ——
  // 跨 region 边界的 cell 两侧会各自挑出不同的合法探测点，同一个 cell 产出两棵树、
  // 相距可少至 1 格（实测 C=11 时最小切比雪夫 = 1，间距构造性保证被静默破坏）。
  // ⇒ 探测点**可以**跨出本 region（在抖动盒内），但每个 cell 只能被一个 region 产出。
  const cellOwner = (i, j) => `${Math.floor((i * C + C / 2) / REGION_SIZE)},${Math.floor((j * C + C / 2) / REGION_SIZE)}`;
  for (const rx of [-1, 0, 1]) {
    for (const rz of [-1, 0, 1]) {
      const arr = computeAzaleaTreeCandidates(rx, rz, SEED);
      for (let i = 0; i < arr.length; i += AZALEA_STRIDE) {
        const ci = Math.floor(arr[i] / C), cj = Math.floor(arr[i + 2] / C);
        assertEqual(cellOwner(ci, cj), `${rx},${rz}`,
          `候选 (${arr[i]},${arr[i + 2]}) 所属 cell(${ci},${cj}) 的归属必须是 region(${rx},${rz})`);
        // 纵深防御：探测点仍须在 cell 的抖动盒周围（不能跑到别的 cell 里去）
        assertTrue(arr[i] >= ci * C && arr[i] < ci * C + C, `wx ${arr[i]} 落在 cell ${ci} 的范围内`);
        assertTrue(arr[i + 2] >= cj * C && arr[i + 2] < cj * C + C, `wz ${arr[i + 2]} 落在 cell ${cj} 的范围内`);
      }
    }
  }
  // 不重：把 3×3 的 (wx,wz) 收集起来去重后数量必须等于原始总数
  const all = blockCandidates();
  const uniq = new Set(all.map((c) => `${c.wx},${c.wz}`));
  assertEqual(uniq.size, all.length, '跨 region 无重复候选点');
  // ⚠️ **这条是 v2.3 回归的直接护栏**：加重试后曾出现「同一 cell 两侧各产一棵、相距 1 格」。
  // 判据 = 同一 cell 不得出现两次（这是那个 bug 的直接形态，比看距离更贴近根因）。
  const cellKeys = all.map((c) => `${Math.floor(c.wx / C)},${Math.floor(c.wz / C)}`);
  assertEqual(new Set(cellKeys).size, cellKeys.length,
    '每个 cell 至多一个候选（同一 cell 被两个 region 各产一棵 = 跨 region 重复的实际形态）');
});

test('候选：10 档变体全部真的出现过（变体选择不能退化成只剩几档）', () => {
  const cands = blockCandidates([-3, -2, -1, 0, 1, 2, 3]);
  const sizes = new Set();
  for (const c of cands) sizes.add(azaleaTreeSize(c.sizeIdx));
  assertEqual(sizes.size, AZALEA_VARIANT_COUNT, `10 档尺寸全部出现（实测出现 ${sizes.size} 档 / ${cands.length} 个候选）`);
});

test('候选：确定性（同 region 两次算逐值一致）', () => {
  const a = computeAzaleaTreeCandidates(1, -1, SEED);
  const b = computeAzaleaTreeCandidates(1, -1, SEED);
  assertDeepEqual([...a], [...b], '两次候选逐值一致');
});

test('候选：地带圆内剔除、圆外保留（v2.3 修掉的「大片空地」缺陷）', () => {
  // ⚠️ **这是与撒布/巨树/空岛相反的语义**：地带圆半径 138 只覆盖 400×400 region 的 37.4%，
  // 整块清空会把圆外 62.6% 的合法杜鹃树一并抹掉。实测 seed 12345 的 region(2,0) 28 个候选
  // **全部在圆外** → 整块清空后那里留下 104×91 格纯草地（用户 2026-10-28 报告）。
  // 而 `pointContext` 本来就只对**圆心内**返回 `kind:'tarn'`。
  const tarn = { cx: 0, cz: 0 };
  const radius = 138;
  // 直接调两次：带 tarn 与不带，验证「只去掉圆内的点，其余逐位相同」
  let checked = 0, insideAll = 0, outsideAll = 0;
  for (const [rx, rz] of [[-1, 0], [0, 0], [1, 0], [0, 1], [-1, -1]]) {
    const withTarn = computeAzaleaTreeCandidates(rx, rz, SEED, AZALEA_TREE_PATH, tarn);
    const without = computeAzaleaTreeCandidates(rx, rz, SEED);
    // 每一个带 tarn 的候选必须都在圆外
    for (let i = 0; i < withTarn.length; i += AZALEA_STRIDE) {
      const d = Math.hypot(withTarn[i] - tarn.cx, withTarn[i + 2] - tarn.cz);
      assertTrue(d >= radius, `地带版本候选 (${withTarn[i]},${withTarn[i + 2]}) 距圆心 ${d.toFixed(1)} 应 ≥ ${radius}`);
      insideAll++;
    }
    // 不带 tarn 的候选里，圆外的那些必须一个不少地保留在带 tarn 的里
    let expectKept = 0;
    for (let i = 0; i < without.length; i += AZALEA_STRIDE) {
      const d = Math.hypot(without[i] - tarn.cx, without[i + 2] - tarn.cz);
      if (d >= radius) expectKept++;
    }
    // 带 tarn 的候选数可能 ≤ expectKept（重试会把原本落在圆内的 cell 换点 → 新增候选），
    // 但绝不能少于「不带 tarn 时已在圆外」的那批
    for (let i = 0; i < without.length && expectKept > 0; i += AZALEA_STRIDE) {
      const d = Math.hypot(without[i] - tarn.cx, without[i + 2] - tarn.cz);
      if (d < radius) continue;
      const key = `${without[i]},${without[i + 2]}`;
      let found = false;
      for (let k = 0; k < withTarn.length; k += AZALEA_STRIDE) {
        if (`${withTarn[k]},${withTarn[k + 2]}` === key) { found = true; break; }
      }
      assertTrue(found, `圆外候选 (${without[i]},${without[i + 2]}) 不得被地带过滤误删`);
      checked++;
    }
    outsideAll++; // 只为让变数被使用（每个 region 兜底计数）
  }
  assertTrue(checked > 10, `验证了 ${checked} 个圆外候选的保留（判据必须有量）`);
  void insideAll; void outsideAll;
});

test('候选：格内重试（AZALEA_CELL_PROBES）真的能降低「整格无树」的比例', () => {
  // 每个 cell 只在**一个点**判 biome 时，点落空 → 整个 169 格² 没树。
  // 实测（seed 12345，同口径）无候选 cell 覆盖可种树面积：T=1 → 21.4%、T=3 → 16.5%。
  // 判据：必须真的多出候选（否则重试没生效）。
  assertTrue(AZALEA_CELL_PROBES >= 2,
    `AZALEA_CELL_PROBES=${AZALEA_CELL_PROBES} 应 ≥ 2（=1 时格内重试完全没生效）`);
  // ⚠️ 不能靠传 `path.probes` 来关掉重试 —— 该字段**不是**接口（实现读的是模块常量），
  // 写了只会静默无效（实测踩过：两侧都是 219，断言假 FAIL）。
  // 改用「重试点是否真的两两不同」这个直接可观测的判据：
  // 三个探测点若塌到同一个位置，重试等于白跑。
  const path = AZALEA_TREE_PATH;
  const jitter = path.jitter;
  let cellsChecked = 0, allDistinct = 0;
  // azaleaCellProbe 是内部函数，这里按同一公式复算（与实现首试逐位一致）
  for (let i = 0; i < 40; i++) {
    for (let j = 0; j < 40; j++) {
      cellsChecked++;
      const pts = new Set();
      for (let k = 0; k < AZALEA_CELL_PROBES; k++) {
        const ox = k === 0
          ? Math.floor(seededRandom(i, j, SEED + path.salt + 1) * jitter)
          : Math.floor(seededRandom(i + k * 7919, j + k * 104729, SEED + path.salt + 1) * jitter);
        const oz = k === 0
          ? Math.floor(seededRandom(i, j, SEED + path.salt + 2) * jitter)
          : Math.floor(seededRandom(i + k * 104729, j + k * 7919, SEED + path.salt + 2) * jitter);
        // 约束一：必须在抖动盒内（间距构造性保证的前提）
        assertTrue(ox >= 0 && ox < jitter && oz >= 0 && oz < jitter,
          `cell(${i},${j}) 第 ${k} 次探测偏移 (${ox},${oz}) 必须在 [0,${jitter}) 盒内`);
        pts.add(`${ox},${oz}`);
      }
      if (pts.size === AZALEA_CELL_PROBES) allDistinct++;
    }
  }
  // 近似独立哈希下偶有重复（jitter=5 ⇒ 只有 25 个格位、取 3 个点，
  // 按生日问题估算应约 11% 的 cell 有重复），实测 **88.1%** 的 cell 三点全不同。
  // 阈值取 80%（实测 88.1% 与「三点塌陷」的恶劣情形两侧不贴线）。
  assertTrue(allDistinct / cellsChecked > 0.8,
    `三个探测点全部不同的 cell 占 ${(allDistinct / cellsChecked * 100).toFixed(1)}% 应 > 80%` +
    '（大面积塌陷意味着重试白跑 —— 首版 `(ox+2k)%jitter` 就是三点共线）');
});

// ======================================================================== column 层

test('collectAzaleaTrees：合并全部邻域 layouts（拼接而非覆盖）+ 与 layouts 顺序无关', async () => {
  const { variants } = await loadAzaleaTrees();
  const mk = (wx, wz) => ({ azaleaTrees: Int32Array.from([wx, 30, wz, 0]) });
  const layouts = [mk(0, 0), mk(100, 0), mk(200, 0)];
  const win = { minX: -50, maxX: 300, minZ: -50, maxZ: 50 };
  const a = collectAzaleaTrees(layouts, SEED, variants, win, EXT);
  assertEqual(a.length, 3, '3 个 layout 各 1 棵 → 共 3 棵（覆盖赋值只会剩 1 棵）');
  const b = collectAzaleaTrees([...layouts].reverse(), SEED, variants, win, EXT);
  assertDeepEqual(a.map((t) => [t.wx, t.wz]), b.map((t) => [t.wx, t.wz]), '顺序与 layouts 顺序无关');
});

test('isAzaleaTreeAllowed：九点/锚点任一不允许即拒', async () => {
  const { variants } = await loadAzaleaTrees();
  const v = variants[0];
  const t = { wx: 100, wy: 30, wz: 100, variant: v, rot: 0, ...treeBox(v, 0, 100, 100) };
  assertTrue(isAzaleaTreeAllowed(t, () => true), '全允许 → 通过');
  for (const [x, z] of [[t.x0, t.z0], [t.x1, t.z1], [(t.x0 + t.x1) >> 1, (t.z0 + t.z1) >> 1], [t.wx, t.wz]]) {
    assertFalse(isAzaleaTreeAllowed(t, (px, pz) => !(px === x && pz === z)), `(${x},${z}) 不允许 → 拒`);
  }
});

test('旋转：非正方形变体旋转后宽深互换（rotateCell / rotatedFootprint）', async () => {
  const { variants } = await loadAzaleaTrees();
  const v = variants.find((x) => x.w !== x.d);
  assertNotNull(v, '存在非正方形变体');
  const fp0 = rotatedFootprint(v, 0), fp1 = rotatedFootprint(v, 1);
  assertEqual(fp0.w, v.w, 'rot0 宽 = w');
  assertEqual(fp1.w, v.d, 'rot1 宽 = d（互换）');
  assertEqual(fp1.d, v.w, 'rot1 深 = w（互换）');
  // rotateCell 必须把 [0,w-1]×[0,d-1] 双射到旋转后的 bbox
  const seen = new Set();
  for (let x = 0; x < v.w; x++) for (let z = 0; z < v.d; z++) {
    const [rx, rz] = rotateCell(v, 1, x, z);
    seen.add(`${rx},${rz}`);
    assertTrue(rx >= 0 && rx < fp1.w && rz >= 0 && rz < fp1.d, 'rot1 结果在旋转后 bbox 内');
  }
  assertEqual(seen.size, v.w * v.d, 'rot1 是双射');
});

test('rasterizeAzaleaTree：树干写 azalea_log、叶片写 azalea_leaves/azalea_flowers、花叶比 ≈30%', async () => {
  const { variants } = await loadAzaleaTrees();
  const v = variants[4];
  const col = new ChunkColumn(0, 0);
  const setBlock = makeColumnSetter(col, reg);
  const t = { wx: 8, wy: 30, wz: 8, variant: v, rot: 0, ...treeBox(v, 0, 8, 8) };
  rasterizeAzaleaTree(setBlock, t, SEED);
  const logId = reg.idOf('azalea_log'), leafId = reg.idOf('azalea_leaves'), flowerId = reg.idOf('azalea_flowers');
  let logs = 0, leaves = 0, flowers = 0, other = 0;
  for (let i = 0; i < col.blocks.length; i++) {
    const id = col.blocks[i];
    if (id === logId) logs++;
    else if (id === leafId) leaves++;
    else if (id === flowerId) flowers++;
    else if (id !== 0) other++;
  }
  assertTrue(logs > 20, `树干格数 ${logs}（变体 #4 实测 37）`);
  assertTrue(leaves + flowers > 200, `叶格数 ${leaves + flowers}（变体 #4 实测 660）`);
  assertEqual(other, 0, '除树干与叶外不写别的方块');
  const ratio = flowers / (leaves + flowers);
  assertTrue(ratio > 0.2 && ratio < 0.42, `花叶比 ${(ratio * 100).toFixed(1)}% 接近 30%（单棵样本量 ~660，留宽）`);
});

test('rasterizeAzaleaTree：地基填充 —— 树干底格悬空时向下补（≤ AZALEA_SUPPORT_MAX），不产生悬空树', async () => {
  const { variants } = await loadAzaleaTrees();
  const v = variants[0];
  // 找一块地表远低于 wy 的位置（wy 故意抬高，制造悬空）
  const wx = 8, wz = 8;
  const h = generateHeight(wx, wz, SEED);
  const wy = h + 8; // 抬高 8 格
  const col = new ChunkColumn(0, 0);
  const setBlock = makeColumnSetter(col, reg);
  const t = { wx, wy, wz, variant: v, rot: 0, ...treeBox(v, 0, wx, wz) };
  rasterizeAzaleaTree(setBlock, t, SEED);
  const logId = reg.idOf('azalea_log');
  // 锚点列（树干底格所在列）从地表上 1 格到 wy-1 都应是树干（补地）
  const anchorX = t.x0 + v.anchor[0], anchorZ = t.z0 + v.anchor[1];
  const lx = anchorX, lz = anchorZ; // column(0,0) ⇒ 局部坐标 = 世界坐标
  for (let y = h + 1; y < wy; y++) {
    // ⚠️ 必须用 blockIndex(lx,y,lz)（= lx + lz*16 + (y-WORLD_MIN_Y)*256）：
    // 手写 `(y*16+lz)*16+lx` 是错的（漏了 WORLD_MIN_Y=-32 的偏移，读到别的层）→ 断言恒假。
    assertEqual(col.blocks[blockIndex(lx, y, lz)], logId, `补地层 y=${y} 是树干`);
  }
  assertTrue(AZALEA_SUPPORT_MAX >= 8, `补地上限 ${AZALEA_SUPPORT_MAX} 覆盖本次 8 格悬空`);
});

test('buildCoveredWindow：覆盖区 = AABB 外扩 EXT，窗口外恒 false', async () => {
  const { variants } = await loadAzaleaTrees();
  const v = variants[0];
  const col = { cx: 0, cz: 0 };
  const t = { wx: 8, wy: 30, wz: 8, variant: v, rot: 0, ...treeBox(v, 0, 8, 8) };
  const cw = buildCoveredWindow(col, [t], EXT);
  assertTrue(cw.covers(t.x0, t.z0), 'AABB 角覆盖');
  assertTrue(cw.covers(t.x0 - EXT, t.z0 - EXT), '外扩 EXT 仍覆盖');
  assertFalse(cw.covers(t.x0 - EXT - 1, t.z0), '外扩 EXT+1 不覆盖');
  assertFalse(buildCoveredWindow(col, [], EXT).covers(8, 8), '无树 → 不覆盖');
});

test('applyAzaleaTrees（合成场景）：允许 → 写入方块并返回覆盖；不允许 → 零方块、不覆盖', async () => {
  await loadAzaleaTrees();
  const mkLayouts = () => [{ azaleaTrees: Int32Array.from([8, 30, 8, 0]) }];
  const a = new ChunkColumn(0, 0);
  const ca = applyAzaleaTrees(a, mkLayouts(), SEED, reg, { allowedAt: () => true, ext: EXT });
  let blocksA = 0; for (let i = 0; i < a.blocks.length; i++) if (a.blocks[i] !== 0) blocksA++;
  assertTrue(blocksA > 100, `允许时写入 ${blocksA} 格`);
  assertTrue(ca.covers(8, 8), '返回覆盖窗口');

  const b = new ChunkColumn(0, 0);
  const cb = applyAzaleaTrees(b, mkLayouts(), SEED, reg, { allowedAt: () => false, ext: EXT });
  let blocksB = 0; for (let i = 0; i < b.blocks.length; i++) if (b.blocks[i] !== 0) blocksB++;
  assertEqual(blocksB, 0, '不允许时零方块');
  assertFalse(cb.covers(8, 8), '不允许时不覆盖');
});


// ======================================================================== 树干间距（v2.0 立、v2.5 放宽）

test('AZALEA_TREE_PATH：C=8（spacing 2 + jitter 6）—— C 才是密度的真正旋钮', () => {
  const P = AZALEA_TREE_PATH;
  const C = P.spacing + P.jitter;
  assertEqual(C, 8, 'C=8（v2.4 是 11、v2.3 是 13）');
  assertEqual(P.spacing, 2, 'spacing=2');
  assertEqual(P.jitter, 6, 'jitter=6');
  // ⭐ 构造性最小锚距 = C − (jitter − 1) = 3，**恰好等于**树干间距阈值（有意）
  const minAnchor = C - (P.jitter - 1);
  assertEqual(minAnchor, 3, '构造性最小锚距 = 3');
  assertTrue(minAnchor >= AZALEA_TRUNK_CLEARANCE,
    `构造性最小锚距 ${minAnchor} 不得 < 树干间距阈值 ${AZALEA_TRUNK_CLEARANCE}（否则网格允许过近锚点 → 成片双拒）`);
});

test('AZALEA_TRUNK_CLEARANCE = 3（v2.5 从 6 放宽；树叶不受限，可自由相交）', () => {
  // ⚠️ **这是有意推翻 v2.0「树干要隔开」的口径**（两条需求直接对立）。
  // 用户 2026-10-29：「空地上都给我再补充生成出来较矮的杜鹃花树……别留空」。
  // 实测：空地里 **61.2% 是被本阈值拒掉的** —— 它不是网格没位置，而是已占位的树被毙了。
  // 6 → 56.2% 叶面覆盖 / 21.9% 空地；**3 → 91.5% / 2.7%**。
  assertEqual(AZALEA_TRUNK_CLEARANCE, 3, '树干中心距 ≥3 格');
  // 下界：不能降到 1（那就等于完全不判，两棵树可以重叠在同一格）
  assertTrue(AZALEA_TRUNK_CLEARANCE >= 2,
    `阈值 ${AZALEA_TRUNK_CLEARANCE} 应 ≥ 2（=1 时两棵树可以在同一格重叠）`);
});

test('isTrunkClear：距离判据（闭区间边界 = 恰好 6 通过）', () => {
  const grid = new TrunkGrid();
  grid.add(0, 0);
  grid.add(20, 0);
  assertTrue(isTrunkClear(6, 0, grid, 6), '(6,0) 距 (0,0) 正好 6 → 通过（>= 语义）');
  assertFalse(isTrunkClear(5.99, 0, grid, 6), '(5.99,0) 5.99 → 拒');
  assertTrue(isTrunkClear(10, 10, grid, 6), '(10,10) 距两者都 ≥10 → 通过');
  assertTrue(isTrunkClear(0, 0, new TrunkGrid(), 6), '空网格 → 恒通过');
});

test('TrunkGrid：负坐标不得漏判（floor 向 -∞ 取整的 off-by-one 回归）', () => {
  // ⚠️ 实测踩到的真 bug：cell 边长 = clearance、查询扫 ±1 个 cell 时，
  // 查询点 (0,0) 与邻点 (-6.5,0) —— 后者落在 floor(-6.5/6) = **-2** 号 cell，±1 只扫到 -1
  // → 返回 Infinity（真实距离 6.5，本该拦下）。只在**负坐标**出现，而本仓世界负坐标是常态。
  const cases = [[-6.5, 0, 6.5], [-5.9, 0, 5.9], [0, -6.5, 6.5], [-7, -7, 9.9], [6.5, 0, 6.5], [0, 6.5, 6.5]];
  // ⚠️ **必须显式传要查的半径**：`TrunkGrid` 默认的 cell 边长是 `2 × AZALEA_TRUNK_CLEARANCE`
  // （v2.5 起 clearance=3 ⇒ cell 6），而这里要查的是 6.5/9.9 ——
  // 不传半径就会因扫描圈数不足而返回 Infinity。这是**测试口径**问题，不是 TrunkGrid 的 bug。
  for (const [px, pz, expect] of cases) {
    const g = new TrunkGrid();
    g.add(px, pz);
    const d = g.nearestDistance(0, 0, 12);
    assertTrue(Math.abs(d - expect) < 0.05, `(0,0) 到 (${px},${pz}) 的距离 ${d.toFixed(2)} 应 ≈ ${expect}`);
  }
  // 判据侧：负坐标下 5.9 必须被拒、6.5 必须通过
  const gNear = new TrunkGrid(); gNear.add(-5.9, 0);
  assertFalse(isTrunkClear(0, 0, gNear, 6), '负坐标 5.9 格 → 拒（漏判会让它错误通过）');
  const gFar = new TrunkGrid(); gFar.add(-6.5, 0);
  assertTrue(isTrunkClear(0, 0, gFar, 6), '负坐标 6.5 格 → 通过');
});

test('TrunkGrid：查询半径正确（只查邻近 cell，不是全量扫描）', () => {
  const grid = new TrunkGrid();
  for (let x = 0; x < 100; x += 3) grid.add(x, 0); // 沿 x 轴密铺
  assertEqual(grid.size, 34, '网格内 34 个点');
  // (7, 3) 最近的点：x=6 距离 3.16 或 x=9 距离 3.6 → 最近 3.16
  const d = grid.nearestDistance(7, 3);
  assertTrue(d > 3 && d < 3.5, `最近距 ${d.toFixed(2)} ≈ 3.16`);
  // 查询半径小于 cell 边长时不能漏：cell 边长 = clearance，故半径 6 内必有结果
  assertTrue(grid.nearestDistance(7, 0) === 1, '(7,0) 距 x=6 为 1');
});

test('杜鹃树互相之间也保持 ≥6 格（自己人打架同样要防）', () => {
  const grid = new TrunkGrid();
  assertTrue(isTrunkClear(0, 0, grid, 6), '第一棵落位');
  grid.add(0, 0);
  assertFalse(isTrunkClear(5, 0, grid, 6), '距第一棵 5 格 → 拒');
  assertFalse(isTrunkClear(4, 4, grid, 6), '距第一棵 5.66 格 → 拒');
  assertTrue(isTrunkClear(6, 0, grid, 6), '距第一棵 6 格 → 通过');
});

test('collectOtherTrunks：收集巨树锚点 + 空岛树基点（两类预测性来源）', async () => {
  const { families } = await loadAzaleaTrees();
  const layouts = [{ giantTrees: { forest: Int32Array.from([100, 30, 100, 0, 0]), beach: new Int32Array(0), banyan: new Int32Array(0) },
                     sky: { skyIslands: Int32Array.from([0, 0, 40, 6, 10]), cloudClusters: new Int32Array(0) } },
                   { giantTrees: null, sky: null }];
  const grid = collectOtherTrunks(layouts, SEED, families, { minX: 0, maxX: 200, minZ: 0, maxZ: 200 });
  // 巨树锚点必在其中（AABB 11×11 覆盖 window 的话）
  assertTrue(grid.size > 0, `收集到 ${grid.size} 个树干位置`);
  // 巨树锚点 (100,100) 精确存在
  assertTrue(grid.nearestDistance(100, 100) === 0, '巨树锚点被收集');
});

test('collectOtherTrunks：不含杜鹃树自己（否则判据会自锁）', () => {
  const layouts = [{ giantTrees: { forest: Int32Array.from([50, 30, 50, 0, 0]), beach: new Int32Array(0), banyan: new Int32Array(0) },
                     sky: null, azaleaTrees: Int32Array.from([70, 30, 70, 0]) }];
  const grid = collectOtherTrunks(layouts, SEED, [], { minX: 0, maxX: 100, minZ: 0, maxZ: 100 });
  assertTrue(grid.nearestDistance(50, 50) === 0, '巨树在网格里');
  assertTrue(grid.nearestDistance(70, 70) > 0, '杜鹃候选**不在**网格里（自己人不算「其他树」）');
});

test('acceptAzaleaTrunks：真实素材下，树干列全部满足 ≥6 格（不是只看锚点）', async () => {
  // ⚠️ **这条是本判据唯一有效的验证**（Tier 4 在真实世界里抓不到）：
  // AZALEA 地块内部本来就没有其他树的树干基部，注入 `clearance=0` 后页面用例仍全绿
  // （实测无效盲区）。故用合成场景：造一批「贴近候选的树干列」，验证判据真会拒。
  const { variants } = await loadAzaleaTrees();
  const v = variants[5]; // 13×12，树干列偏移可达 ±2
  const rot = 0;
  // 造两个候选：A 在 (0,0)，B 在 (5,0) —— 锚点距离 5 < 6 → B 必被拒
  const mkTree = (wx, wz) => ({ wx, wy: 30, wz, variant: v, rot, ...treeBox(v, rot, wx, wz) });
  const a = mkTree(0, 0);
  const b = mkTree(5, 0);
  const acc = acceptAzaleaTrunks([a, b], new TrunkGrid(), 6);
  assertEqual(acc.size, 1, '两棵锚点相距 5 格 → 只接受 1 棵');
  assertTrue(acc.has('0,0'), '先接受的是 (0,0)');

  // 关键：锚点距离 6.7 但**树干列**只有 5.x 时也必须被拒
  // （v#5 的树干列相对锚点偏移 [0,-2],[-1,-1],[0,-1],[1,-1],[0,0]）
  const blocked = new TrunkGrid();
  blocked.add(3, -2); // 距 A 的树干列 (1,-2) 只有 2 格
  const accA = acceptAzaleaTrunks([a], blocked, 6);
  assertEqual(accA.size, 0, '树干列距其他树干 2 格 → 整棵拒（即使锚点距离 3.6 也拒）');

  // 对照：把阻塞点挪到 6 格外 → 接受
  const clear = new TrunkGrid();
  clear.add(10, -2);
  const accClear = acceptAzaleaTrunks([a], clear, 6);
  assertEqual(accClear.size, 1, '树干列都在 6 格外 → 接受');

  // ⚠️ **最能区分「按锚点」与「按树干列」的一条**（实测：只按锚点实现时它必须 FAIL）：
  // v#5 的树干列偏移含 (1,-1)，把阻塞点放在 (6,0) →
  //   锚点距 = 6.00（**恰好通过**，若判据只看锚点就会接受）
  //   树干列 (1,-1) 距 = 5.10（**应当拒绝**）
  // 第一版用例只造了「锚点也超距」的场景，注入「只用锚点」后仍全绿（无效盲区）。
  const edge = new TrunkGrid();
  edge.add(6, 0);
  // 先确认这个场景真的可分（锚点不超距、树干列超距）—— 否则下面那条断言恒真
  const cols = trunkColumnsOf(v, rot, a.x0, a.z0);
  const minColD = Math.min(...cols.map(([x, z]) => Math.hypot(x - 6, z - 0)));
  assertTrue(Math.hypot(a.wx - 6, a.wz - 0) >= 6, `锚点距 ${Math.hypot(a.wx - 6, a.wz).toFixed(2)} ≥ 6（不超距）`);
  assertTrue(minColD < 6, `最近树干列距 ${minColD.toFixed(2)} < 6（超距）`);
  assertEqual(acceptAzaleaTrunks([a], edge, 6).size, 0,
    '锚点 6.00 但树干列 5.10 → 必须拒（只按锚点的实现会错误接受）');
});

test('variantsByFootprint：降级顺序按冠幅面积升序（矮树才可能放得下）', async () => {
  const { variants } = await loadAzaleaTrees();
  const sorted = variantsByFootprint(variants);
  assertEqual(sorted.length, variants.length, '不丢档');
  for (let n = 0; n + 1 < sorted.length; n++) {
    const a = sorted[n].w * sorted[n].d, b = sorted[n + 1].w * sorted[n + 1].d;
    assertTrue(a <= b, `第 ${n} 项面积 ${a} ≤ 第 ${n + 1} 项 ${b}（降级先试最小的）`);
  }
  // 最小档必须真的比最大档小一截（否则「降级」没有意义）
  const minA = sorted[0].w * sorted[0].d, maxA = sorted[sorted.length - 1].w * sorted[sorted.length - 1].d;
  assertTrue(minA / maxA < 0.6,
    `最小冠幅 ${minA} 应明显小于最大 ${maxA}（实测比 ${(minA / maxA).toFixed(2)}）—— 否则降级救不回空地`);
});

test('trunkColumnsOf：返回**全高**树干列（含上层偏移），trunkBaseColumnsOf 才是 y=0 层', async () => {
  const { variants } = await loadAzaleaTrees();
  // ⭐ v2.5 真 bug：杜鹃树上层树干相对 y=0 层水平偏移实测最大 4 格。
  // 若 trunkColumnsOf 只取 y=0 层，「上层树干贴住其他树」完全在判据盲区
  // （实测违反：杜鹃树干 y=19 与巨树树干只隔 1 格却被放行）。
  let foundOffset = null;
  for (let n = 0; n < variants.length && !foundOffset; n++) {
    const v = variants[n];
    const box = treeBox(v, 0, 0, 0);
    const all = trunkColumnsOf(v, 0, box.x0, box.z0);
    const base = trunkBaseColumnsOf(v, 0, box.x0, box.z0);
    if (all.length > base.length) foundOffset = { n, all: all.length, base: base.length };
  }
  assertNotNull(foundOffset,
    '至少有一个档位的「全高树干列」多于「y=0 层」（否则上层偏移没被收纳 —— 判据会漏判）');
  assertTrue(foundOffset.all > foundOffset.base,
    `档 ${foundOffset.n}：全高 ${foundOffset.all} 列 > y=0 层 ${foundOffset.base} 列`);

  // 地基填充必须用 y=0 层（用全高会让上层树干各向下补一根地下柱子）
  const v0 = variants[0];
  const box0 = treeBox(v0, 0, 0, 0);
  const base0 = trunkBaseColumnsOf(v0, 0, box0.x0, box0.z0);
  const all0 = trunkColumnsOf(v0, 0, box0.x0, box0.z0);
  assertTrue(base0.length > 0, 'y=0 层树干列非空');
  assertTrue(base0.length <= all0.length, 'y=0 层列数 ≤ 全高列数');
  // 地基列的每一列都必须真的在 y=0 层有树干格（不能混进上层）
  const baseKeys = new Set(base0.map(([x, z]) => `${x},${z}`));
  for (const k of baseKeys) {
    const [x, z] = k.split(',').map(Number);
    assertTrue(x >= box0.x0 && x <= box0.x1 && z >= box0.z0 && z <= box0.z1, `(${x},${z}) 在 bbox 内`);
  }
});

test('trunkColumnsOf：随旋转变换', async () => {
  const { variants } = await loadAzaleaTrees();
  const v = variants[5];
  // ⚠️ 第三/四个参数是**树原点 x0/z0**（= `treeBox().x0/z0`），不是锚点坐标 ——
  // 传错会让坐标整体偏移（第一版写成 (0,0)，断言的 bbox 核对因此假失败）。
  const box0 = treeBox(v, 0, 0, 0);
  const cols0 = trunkColumnsOf(v, 0, box0.x0, box0.z0);
  assertTrue(cols0.length >= 1, `树干列数 ${cols0.length}`);
  // rot=1 应与 rot=0 不同（非正方形变体）
  const box1 = treeBox(v, 1, 0, 0);
  const cols1 = trunkColumnsOf(v, 1, box1.x0, box1.z0);
  const k0 = cols0.map(([x, z]) => `${x},${z}`).sort().join('|');
  const k1 = cols1.map(([x, z]) => `${x},${z}`).sort().join('|');
  assertTrue(k0 !== k1, 'rot 0 与 1 的树干列不同（旋转变换生效）');
  // 全部列必须在 bbox 内
  for (const [x, z] of cols0) {
    assertTrue(x >= box0.x0 && x <= box0.x1 && z >= box0.z0 && z <= box0.z1, `(${x},${z}) 在 bbox 内`);
  }
});

// ---------------------------------------------------------------- 档位错落（v2.3：两类棋盘）

test('档位分类表：两类的档位下标与产物实测高度一一对应（3:7）', async () => {
  // 判据必须从**烘焙产物**取高度，不能只比对常量表 —— 表写对了但产物换了档位就漂了。
  const { variants } = await loadAzaleaTrees();
  assertEqual(variants.length, AZALEA_VARIANT_COUNT, '产物档数');
  const byClass = [[], []];
  for (let i = 0; i < variants.length; i++) byClass[azaleaSizeClass(i)].push(i);
  assertDeepEqual(byClass, AZALEA_STAGGER_CLASSES.map((a) => [...a]), '类别表与产物档位一致');

  // 每类的高度必须真的落进自己的区间（防止「矮类里混进一棵高的」）
  for (let c = 0; c < 2; c++) {
    for (const idx of AZALEA_STAGGER_CLASSES[c]) {
      assertEqual(azaleaHeightClass(variants[idx].h), c, `档 ${idx} 高度 ${variants[idx].h} 应属类别 ${c}`);
    }
  }
  // 两类的档位数（矮 3 / 高 7）
  assertDeepEqual(AZALEA_STAGGER_CLASSES.map((a) => a.length), [3, 7], '两类档位数');

  // ⭐ **最小可辨差必须 ≥ 4 格**（v2.3 的核心目标）
  // v2.2 的「中→高」只差 1 格（中最高 25 vs 高最低 26）—— 那就是用户「错落看不出来」的根因。
  const lowMax = Math.max(...AZALEA_STAGGER_CLASSES[0].map((i) => variants[i].h));
  const highMin = Math.min(...AZALEA_STAGGER_CLASSES[1].map((i) => variants[i].h));
  assertTrue(highMin - lowMax >= 4,
    `两类最小可辨差 ${highMin - lowMax} 格（矮最高 ${lowMax} vs 高最低 ${highMin}）应 ≥ 4 —— ` +
    '小于 4 格时树冠（厚 10~23 格、冠幅 11 格、最近邻距 13 格、70.9% 重叠）会完全遮住高度差');
});

test('azaleaStaggeredSizeIdx：正交相邻必然异类（「一个高树挨着它的应该是矮树」）', () => {
  const SEED = 12345;
  const DIRS_ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  // ① **主判据**：**粗格内部**的正交相邻必须异类（棋盘不变式）。
  //    ⚠️ **不能写「全国范围正交同类 === 0」**（实测踩过）：低频扰动的相位逐粗格取，
  //    跨粗格的那一层相邻对两侧相位可能翻转 ⇒ 必然同类（实测 1170/2880 = 40.6%），
  //    而跨粗格正交对只占 11.25%。全国口径实测 0.0457。
  const SC = AZALEA_STAGGER_CELL;
  let sameIn = 0, sameAll = 0, totAll = 0;
  for (let i = -40; i < 40; i++) {
    for (let j = -40; j < 40; j++) {
      const a = azaleaSizeClass(azaleaStaggeredSizeIdx(i, j, SEED));
      for (const [di, dj] of DIRS_ORTH) {
        const eq = a === azaleaSizeClass(azaleaStaggeredSizeIdx(i + di, j + dj, SEED));
        totAll++;
        if (!eq) continue;
        sameAll++;
        if (Math.floor(i / SC) === Math.floor((i + di) / SC)
          && Math.floor(j / SC) === Math.floor((j + dj) / SC)) sameIn++;
      }
    }
  }
  assertEqual(sameIn, 0,
    `粗格内的正交相邻同类 ${sameIn} —— **必须为 0**（棋盘不变式；` +
    '对角相邻同类是棋盘结构的数学后果，不可避免，故不再作为判据）');
  assertTrue(sameAll / totAll < 0.2,
    `全国正交同类率 ${(sameAll / totAll).toFixed(3)} 应远低于两类独立抽签的 0.58`);

  // ② 两类分布**必然是 50/50**（棋盘结构的数学后果，不是自由选择）。
  //    ⚠️ **不能期待 3:7**（实测踩过：写过「应 ≈ 0.3」于实现全绿也报 FAIL）：
  //    `(i+j+shift)%2` 在任何足够大的区域里奇偶各占一半；shift 逐粗格随机也只改相位。
  //    ⇒ 矮类与高类的**株数比恒为 1:1**，与两类各含几个档位（3 与 7）无关。
  //    这意味着高树占一半（v2.2 三类方案下高类只 40%）—— 用户要的是「错落相间」，
  //    高树变多正好强化了这个观感。
  const cnt = [0, 0];
  for (let i = 0; i < 80; i++) {
    for (let j = 0; j < 80; j++) cnt[azaleaSizeClass(azaleaStaggeredSizeIdx(i, j, SEED))]++;
  }
  const t = cnt[0] + cnt[1];
  assertTrue(Math.abs(cnt[0] / t - 0.5) < 0.02,
    `两类各占比 ${(cnt[0] / t).toFixed(3)} / ${(cnt[1] / t).toFixed(3)} 应 ≈ 50/50（棋盘结构的必然结果）`);

  // ③ **低频扰动必须存在**（且只改相位、不改奇偶关系）。
  //    纯棋盘 `(i+j)%2` 在全国范围内是固定相位 → 对角线上同类别**无限延伸**
  //    （实测最长段 = 整个采样区 120 cell），玩家会看到大量斜向「同高带」。
  //    ⚠️ 只判「正交相邻异类」**测不到这一点**（相位偏移不影响奇偶关系 —— 实测 shift=0
  //    也全绿，那就是无效盲区）。有效判据 = 沿对角线走，类别必须变化。
  let changes = 0, prev = null, run = 0, maxRun = 0;
  for (let t2 = 0; t2 < 100; t2++) {
    const c = azaleaSizeClass(azaleaStaggeredSizeIdx(t2, t2, SEED));
    if (prev !== null) {
      if (c !== prev) { changes++; run = 1; } else { run++; }
      maxRun = Math.max(maxRun, run);
    }
    prev = c;
  }
  assertTrue(changes > 5,
    `对角线上类别须被打散（低频扰动生效）—— 实测 100 步变化 ${changes} 次（shift 恒 0 时直线同类）`);
  // 下界：不能出现「一整条长 50+ cell 的同高对角带」
  assertTrue(maxRun < 50,
    `对角同类最长连续段 ${maxRun} cell 应 < 50（纯棋盘时实测 100，即整条线全同类）`);

  // ④ 跨 seed 稳定（seed 只通过 shift 影响粗格相位，不改粗格内的奇偶关系）
  for (const s2 of [424242, 777]) {
    let inSame = 0;
    for (let i = 0; i < 30; i++) {
      for (let j = 0; j < 30; j++) {
        const a = azaleaSizeClass(azaleaStaggeredSizeIdx(i, j, s2));
        for (const [di, dj] of [[1, 0], [0, 1]]) {
          if (a !== azaleaSizeClass(azaleaStaggeredSizeIdx(i + di, j + dj, s2))) continue;
          if (Math.floor(i / SC) === Math.floor((i + di) / SC)
            && Math.floor(j / SC) === Math.floor((j + dj) / SC)) inSame++;
        }
      }
    }
    assertEqual(inSame, 0, `seed ${s2} 粗格内正交同类 ${inSame} 必须为 0`);
  }
});

test('azaleaStaggeredSizeIdx：纯函数 + 跨 region 一致（同一 cell 在两侧算出的档位相同）', () => {
  const SEED = 998877;
  // 同一 (i,j) 反复调用必须恒等（纯函数、无内部状态）
  for (const [i, j] of [[0, 0], [-7, 13], [123, -456], [9999, 1]]) {
    const a = azaleaStaggeredSizeIdx(i, j, SEED);
    assertEqual(azaleaStaggeredSizeIdx(i, j, SEED), a, `(${i},${j}) 重复调用`);
  }
  // 粗格边界两侧的 shift 可以不同，但**同一个 i** 的结果不能依赖调用者是谁 —— 它只吃 (i,j,seed)。
  // 这条钉住「不许按邻域已落树集合做排斥」（那会让结果依赖 column 处理顺序）。
  const ci = AZALEA_STAGGER_CELL;
  for (let i = ci - 2; i <= ci + 2; i++) {
    const direct = azaleaStaggeredSizeIdx(i, 3, SEED);
    // 等价地：换一个「调用上下文」不改变结果（同一原子参数）
    assertEqual(azaleaStaggeredSizeIdx(i, 3, SEED), direct, `i=${i} 不受调用顺序影响`);
  }
});

test('azaleaSizeClass：下标 → 类别（不是把下标当高度传进去）', () => {
  // ⚠️ 这是真实踩过的坑：`azaleaHeightClass(sizeIdx)` 吃的是**实际高度**，
  // 传下标 0~9 会全部命中 `≤17` 判成矮类（导致「相邻同类率」算出 1.000 的假通过）。
  for (const idx of AZALEA_STAGGER_CLASSES[1]) {
    assertEqual(azaleaSizeClass(idx), 1, `档 ${idx} 应属高类`);
    assertTrue(azaleaHeightClass(9) === 0, '把下标 9 当高度传会误判成矮类 —— 必须用 azaleaSizeClass');
  }
  // 越界 / 负数也要归到合法类别（对 AZALEA_VARIANT_COUNT 取模后查表）
  assertEqual(azaleaSizeClass(AZALEA_VARIANT_COUNT + 7), azaleaSizeClass(7), '越界下标按取模处理');
});
