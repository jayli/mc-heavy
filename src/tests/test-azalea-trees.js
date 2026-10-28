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
  rotateCell, rotatedFootprint, treeBox, collectAzaleaTrees, isAzaleaTreeAllowed,
  rasterizeAzaleaTree, buildCoveredWindow, applyAzaleaTrees, AZALEA_VARIANT_COUNT,
  AZALEA_TRUNK_CLEARANCE, TrunkGrid, isTrunkClear, collectOtherTrunks,
  acceptAzaleaTrunks, trunkColumnsOf,
} from '../gen/structures/azalea-trees.js';
import { generateHeight } from '../gen/terrain.js';
import { getBiome } from '../gen/noise.js';
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

test('候选：跨 region 无缝（相邻 region 各算一次，不重不漏）', () => {
  const C = AZALEA_TREE_PATH.spacing + AZALEA_TREE_PATH.jitter;
  for (const rx of [-1, 0, 1]) {
    for (const rz of [-1, 0, 1]) {
      const arr = computeAzaleaTreeCandidates(rx, rz, SEED);
      for (let i = 0; i < arr.length; i += AZALEA_STRIDE) {
        assertTrue(arr[i] >= rx * REGION_SIZE && arr[i] < (rx + 1) * REGION_SIZE, `wx ${arr[i]} 落在 region ${rx} 内`);
        assertTrue(arr[i + 2] >= rz * REGION_SIZE && arr[i + 2] < (rz + 1) * REGION_SIZE, `wz ${arr[i + 2]} 落在 region ${rz} 内`);
        // ⚠️ **不能断言「cell 的格原点所属 region == 本 region」**：cell 边长 C 与 REGION_SIZE(400)
        // 不是整除关系（C=13 时 400/13 = 30.77），跨 region 边界的 cell 其格原点可能在隔壁 region，
        // 而**点**落在本 region —— 这正是「跨 region cell 由两侧各算一次、各自只保留落在本 region 内的点」
        // 的设计意图（C=16 时恰好整除，才让旧断言侥幸成立）。
        // 真正的不变式是：**点**归属唯一 —— 它落在哪个 region 就只由那个 region 产出。
        void C;
      }
    }
  }
  // 不重：把 3×3 的 (wx,wz) 收集起来去重后数量必须等于原始总数
  const all = blockCandidates();
  const uniq = new Set(all.map((c) => `${c.wx},${c.wz}`));
  assertEqual(uniq.size, all.length, '跨 region 无重复候选点');
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


// ======================================================================== 树干间距（v2.0：杜鹃树不与别的树打架）

test('AZALEA_TREE_PATH：密度 C=13（spacing 8 + jitter 5，用户 2026-10-28 裁定「稍微增加密度」）', () => {
  assertEqual(AZALEA_TREE_PATH.spacing, 8, 'spacing=8');
  assertEqual(AZALEA_TREE_PATH.jitter, 5, 'jitter=5');
  assertEqual(AZALEA_TREE_PATH.spacing + AZALEA_TREE_PATH.jitter, 13, 'C=13（每 100×100 约 59 棵）');
});

test('AZALEA_TRUNK_CLEARANCE = 6（树干最小间距；树叶不受限，可自由相交）', () => {
  assertEqual(AZALEA_TRUNK_CLEARANCE, 6, '树干中心距 ≥6 格');
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
  for (const [px, pz, expect] of cases) {
    const g = new TrunkGrid();
    g.add(px, pz);
    const d = g.nearestDistance(0, 0);
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

test('trunkColumnsOf：返回 y=0 层树干列，且随旋转变换', async () => {
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
