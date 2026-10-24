// src/tests/test-mesa.js — Cloudland 高台 Tier 1：落点候选发现 + 烘焙产物契约
//
// 本文件钉的是「落点判据被改坏后**静默产出一个错误但看起来正常的高台**」这几类缺陷：
//   · 基座跨到海里 → 高台一半扎在海底，露出水面的只有台顶
//   · 基座跨 biome → 高台一半长在草地上
//   · 落点穿空岛 → 台顶 y≈51 与空岛底 y∈[40,68] 有重叠区间
//   · 锚点太靠 region 边界 → 20×21 占地越界，相邻 region 不会为它生成锚点 ⇒ 半边永久消失
//   · floorY 取中心点而非基座最小值 → 低洼侧露出空隙（悬空）
// 姊妹文件：test-mesa-gen.js（layout 接线 + 真实 column GEN）。
//
// ⚠️ 写断言前先在真实数据上跑一次、打印实际值（testing-policy §2.6 ⑤）：本文件的下界都取自实测。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse } from './assert.js';
import {
  computeMesaAnchor, MESA_BASE_RECT_HALF, MESA_UNION_HALF, MESA_TOP_REL_Y, MESA_SALT,
} from '../gen/structures/mesa.js';
import { getBiome } from '../gen/noise.js';
import { generateHeight } from '../gen/terrain.js';
import { SEA_Y } from '../voxel/constants.js';

const SEED = 12345;

test('高台落点：同一 seed 同一 region 两次调用结果逐字段相同（红线 2 确定性）', () => {
  for (const [rx, rz] of [[0, 0], [1, 0], [2, -1]]) {
    const a = computeMesaAnchor(rx, rz, SEED);
    const b = computeMesaAnchor(rx, rz, SEED);
    if (a === null) { assertEqual(b, null, `region(${rx},${rz}) 两次都 null`); continue; }
    assertEqual(a.wx, b.wx, `region(${rx},${rz}) wx 稳定`);
    assertEqual(a.wz, b.wz, `region(${rx},${rz}) wz 稳定`);
    assertEqual(a.floorY, b.floorY, `region(${rx},${rz}) floorY 稳定`);
  }
});

test('高台落点：基座 15×15 每列都是 DESERT（不跨 biome）', () => {
  let checked = 0;
  for (let rx = -2; rx <= 2; rx++) for (let rz = -2; rz <= 2; rz++) {
    const a = computeMesaAnchor(rx, rz, SEED);
    if (!a) continue;
    checked++;
    const H = MESA_BASE_RECT_HALF;
    for (let dz = -H; dz <= H; dz++) for (let dx = -H; dx <= H; dx++) {
      const b = getBiome(a.wx + dx, a.wz + dz, SEED);
      assertEqual(b, 'DESERT', `region(${rx},${rz}) 基座 (${dx},${dz}) 是 DESERT，实际 ${b}`);
    }
  }
  assertTrue(checked >= 8, `至少 8 个 region 有锚点（实际 ${checked}）`);
});

test('高台落点：基座 15×15 每列地表都高于海平面（不跨海）', () => {
  for (let rx = -2; rx <= 2; rx++) for (let rz = -2; rz <= 2; rz++) {
    const a = computeMesaAnchor(rx, rz, SEED);
    if (!a) continue;
    const H = MESA_BASE_RECT_HALF;
    for (let dz = -H; dz <= H; dz++) for (let dx = -H; dx <= H; dx++) {
      const h = generateHeight(a.wx + dx, a.wz + dz, SEED);
      assertTrue(h > SEA_Y, `region(${rx},${rz}) 基座 (${dx},${dz}) 地表 h=${h} > SEA_Y=${SEA_Y}`);
    }
  }
});

test('高台落点：floorY === 基座各列 generateHeight 的最小值（取 min 保证绝不悬空）', () => {
  for (let rx = -2; rx <= 2; rx++) for (let rz = -2; rz <= 2; rz++) {
    const a = computeMesaAnchor(rx, rz, SEED);
    if (!a) continue;
    const H = MESA_BASE_RECT_HALF;
    let mn = Infinity;
    for (let dz = -H; dz <= H; dz++) for (let dx = -H; dx <= H; dx++) {
      mn = Math.min(mn, generateHeight(a.wx + dx, a.wz + dz, SEED));
    }
    assertEqual(a.floorY, mn, `region(${rx},${rz}) floorY 是基座最低地表`);
  }
});

test('高台落点：整个并集外接框落在本 region 内（不跨 region 边界）', () => {
  for (let rx = -2; rx <= 2; rx++) for (let rz = -2; rz <= 2; rz++) {
    const a = computeMesaAnchor(rx, rz, SEED);
    if (!a) continue;
    const U = MESA_UNION_HALF;
    assertTrue(a.wx - U >= rx * 400 && a.wx + U < (rx + 1) * 400,
      `region(${rx},${rz}) x 向占地 [${a.wx - U},${a.wx + U}] 在 [${rx * 400},${(rx + 1) * 400}) 内`);
    assertTrue(a.wz - U >= rz * 400 && a.wz + U < (rz + 1) * 400,
      `region(${rx},${rz}) z 向占地 [${a.wz - U},${a.wz + U}] 在 [${rz * 400},${(rz + 1) * 400}) 内`);
  }
});

test('高台落点：不与任何空岛 AABB 相交（台顶 y=floorY+42 不得穿岛）', async () => {
  const { computeSkyCandidates } = await import('../gen/structures/sky-structures.js');
  for (let rx = -2; rx <= 2; rx++) for (let rz = -2; rz <= 2; rz++) {
    const a = computeMesaAnchor(rx, rz, SEED);
    if (!a) continue;
    const islands = computeSkyCandidates(rx, rz, SEED).skyIslands;
    for (let i = 0; i < islands.length; i += 5) {
      const ox = islands[i] * 16 + 8, oz = islands[i + 1] * 16 + 8;
      const bottom = islands[i + 2], radius = islands[i + 3];
      const xOverlap = Math.abs(ox - a.wx) <= radius + MESA_UNION_HALF;
      const zOverlap = Math.abs(oz - a.wz) <= radius + MESA_UNION_HALF;
      if (!xOverlap || !zOverlap) continue;
      assertTrue(bottom > a.floorY + MESA_TOP_REL_Y,
        `region(${rx},${rz}) 空岛底 y=${bottom} 必须高于台顶 y=${a.floorY + MESA_TOP_REL_Y}`);
    }
  }
});

test('高台落点：无沙沙漠或无合法落点的 region 返回 null（不硬塞）', () => {
  // ⚠️ **不能断言「全森林 region 一定存在」**：实测 ±15 region（9000×9000 格）里
  // 每个 region 都有沙漠采样点 —— `noise` 尺度（0.01）让沙漠带横跨整个世界，
  // 「某个 region 完全无沙漠」在 seed 12345 下不成立。这条断言一度写成那样，被实测驳回过。
  // 真正可测的是「无合法落点时返回 null」：实测 ±6 范围 169 个 region 里有 6 个（3.6%），
  // 都是「有沙漠但所有候选点都被四条判据排掉」。
  let nullCount = 0;
  const sample = [];
  for (let rx = -6; rx <= 6; rx++) for (let rz = -6; rz <= 6; rz++) {
    if (computeMesaAnchor(rx, rz, SEED) === null) { nullCount++; if (sample.length < 3) sample.push(`(${rx},${rz})`); }
  }
  assertTrue(nullCount > 0, `±6 范围内应存在无合法落点的 region（实测 6/169，实际 ${nullCount}）`);
  assertTrue(nullCount < 169, `也不能全部为 null（实际 ${nullCount}/169）；样例 ${sample.join(' ')}`);
});

test('高台落点：salt 落在空闲带且不与既有 salt 区间重叠（程序化校验）', () => {
  assertTrue(MESA_SALT >= 932 && MESA_SALT <= 999, `MESA_SALT=${MESA_SALT} 在空闲带 932..999`);
  assertFalse(MESA_SALT >= 58 && MESA_SALT <= 107, 'MESA_SALT 不与云簇 frontier 区间（58..107）重叠');
  assertFalse(MESA_SALT >= 102 && MESA_SALT <= 112, 'MESA_SALT 不与 terrain +100+k 区间（102..112）重叠');
  assertFalse(MESA_SALT >= 270 && MESA_SALT <= 397, 'MESA_SALT 不与 landmarks +302+y 区间（270..397）重叠');
  for (const s of [911, 921, 931]) assertFalse(MESA_SALT === s, `MESA_SALT 不等于巨树路径 salt ${s}`);
});

test('高台落点：常量之间自洽（基座矩形 ⊂ 并集外接框 ⊂ region 内缩量）', () => {
  assertTrue(MESA_BASE_RECT_HALF < MESA_UNION_HALF,
    `基座半宽 ${MESA_BASE_RECT_HALF} 必须小于并集半宽 ${MESA_UNION_HALF}`);
  assertEqual(MESA_TOP_REL_Y, 42, '台顶最高位是产物实测的 rel-y 42（改产物须同步）');
});

// ======================================================================== 烘焙产物契约

test('高台产物：加载后 10712 格、bbox 20×43×21、每格 type 都在 registry 里', async () => {
  const { loadStructure } = await import('../gen/structures/structure-json.js');
  const { buildDefaultRegistry } = await import('../voxel/block-registry.js');
  const reg = await buildDefaultRegistry();
  const data = await loadStructure('cloudlandMesaSmall');
  assertEqual(data.blocks.length, 10712, '方块数');
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity, mnz = Infinity, mxz = -Infinity;
  for (const b of data.blocks) {
    mnx = Math.min(mnx, b.x); mxx = Math.max(mxx, b.x);
    mny = Math.min(mny, b.y); mxy = Math.max(mxy, b.y);
    mnz = Math.min(mnz, b.z); mxz = Math.max(mxz, b.z);
    assertTrue(reg.idOf(b.type) !== undefined,
      `type "${b.type}" 必须在 registry 里（否则 makeColumnSetter 静默跳过 → 高台内部空洞）`);
  }
  assertEqual(mxx - mnx + 1, 20, '宽');
  assertEqual(mxy - mny + 1, 43, '高');
  assertEqual(mxz - mnz + 1, 21, '深');
  assertEqual(mny, 1, '最低点归一化为 y=1（rasterizeStructure 按此约定减 1）');
});

test('高台产物：基座 164 列全部从 y=1 起（floorY 处无悬空），悬挑列是素材形态而非缺口', async () => {
  const { loadStructure } = await import('../gen/structures/structure-json.js');
  const data = await loadStructure('cloudlandMesaSmall');

  // 真实形态（实测）：335 列里 **164 列从 y=1 起**（基座），另 171 列的最低 y 在 2..41 之间
  // —— 那是桌山/蘑菇形的**上宽下窄**（工作台面外伸），素材本身如此，不是烘焙缺口。
  // 所以「不悬空」的正确判据是：**基座那 164 列**必须从 y=1 起（即落在 floorY 上），
  // 不是「全部 335 列都从 y=1 起」（那会把正确产物判成错）。
  const lowest = new Map();
  for (const b of data.blocks) {
    const k = `${b.x},${b.z}`;
    const prev = lowest.get(k);
    if (prev === undefined || b.y < prev) lowest.set(k, b.y);
  }
  const baseCols = [...lowest].filter(([, y]) => y === 1).map(([k]) => k);
  assertEqual(baseCols.length, 164, '从 y=1 起的列数（= 基座 164 列）');
  assertEqual(lowest.size, 335, '总列数（并集占地，实测 335）');
  // 悬挑列的存在是素材形态的证据：若变成 0，说明产物被裁平了（那会丢掉工作台面）
  const overhang = [...lowest].filter(([, y]) => y > 1);
  assertEqual(overhang.length, 171, '悬挑列数（上宽下窄形态，实测 171）');
  for (const [k, y] of lowest) {
    assertTrue(y >= 1, `列 ${k} 的最低 y=${y} 必须 ≥1（y=0 会落到 rasterize 的 floorY−1 之下）`);
  }
});

test('高台产物：全部方块走 opaque 通道且 opaqueTable=1（cutout 会撞容量预算）', async () => {
  const { loadStructure } = await import('../gen/structures/structure-json.js');
  const { buildDefaultRegistry } = await import('../voxel/block-registry.js');
  const reg = await buildDefaultRegistry();
  const data = await loadStructure('cloudlandMesaSmall');
  const types = new Set(data.blocks.map((b) => b.type));
  assertTrue(types.size >= 10, `目标方块种类应 ≥10（实际 ${types.size}）`);
  for (const t of types) {
    const id = reg.idOf(t);
    assertEqual(reg.cullTable[id], 0, `"${t}" 必须是 opaque 通道（cutout=1/transparent=2 会撞容量预算）`);
    assertEqual(reg.opaqueTable[id], 1, `"${t}" 的 opaqueTable 必须是 1（否则面剔除失效 → 顶点暴涨）`);
  }
});
