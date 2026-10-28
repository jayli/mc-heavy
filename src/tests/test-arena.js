// src/tests/test-arena.js — 城门竞技场（Arena）纯函数层
//
// 权威：docs/superpowers/specs/2026-10-29-arena-design.md
//
// 本文件覆盖两块：
//   ① **栏杆臂方向派生**（DR-3）：臂方向必须来自 `TEMPLATES` + mesher 的 `rotateOffset`，
//      不得手写第二份几何表（红线 1）。这里钉住的实测值是 spec §2.5 的表。
//   ② **锚点纯函数**（DR-4）：确定性 / 干燥 / 高差 / 不压城市与地标 / floorY 是最低点。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertNotEqual } from './assert.js';
import { SEA_Y } from '../voxel/constants.js';
import { generateHeight } from '../gen/terrain.js';
import { getCityBoundsForSeed } from '../gen/structures/city-layout.js';
import { regionLandmarkCenters } from '../gen/structures/landmark-circles.js';
import { computeRegionLayout } from '../gen/structures/structure-layout.js';
import {
  ARENA_HALF_X, ARENA_HALF_Z, ARENA_MAX_SURFACE_SPAN, ARENA_WIDTH, ARENA_DEPTH,
  railArmSet, railPlacementFor, computeArenaAnchor, inArenaFootprint,
  arenaOverlapsRegion, clearArenaCache,
} from '../gen/structures/arena.js';

const DEFAULT_SEED = 12345;

// ---------------------------------------------------------------------------
// ① 栏杆臂方向派生
// ---------------------------------------------------------------------------

// 臂集合的规范序（与 `armKey` 同序）：保证比较不受 `.sort()` 的字典序影响
// （'+Z' 字典序小于 '-X' —— 直接 sort 会让 '-X +Z' 变成 '+Z -X'）。
const norm = (arms) => ['+X', '-X', '+Z', '-Z'].filter((a) => arms.includes(a)).join(' ');

test('arena: 栏杆臂方向由 TEMPLATES 派生（handrail 是四向转角件）', () => {
  // 实测值见 spec §2.5 表（真 mesher 发射顶点的臂伸出方向）
  assertEqual(norm(railArmSet('handrail', 0)), '+X +Z', 'handrail orient=0 → +X+Z');
  assertEqual(norm(railArmSet('handrail', 1)), '+X -Z', 'handrail orient=1 → +X-Z');
  assertEqual(norm(railArmSet('handrail', 2)), '-X -Z', 'handrail orient=2 → -X-Z');
  assertEqual(norm(railArmSet('handrail', 3)), '-X +Z', 'handrail orient=3 → -X+Z');
});

test('arena: handrailA 是直段件（两个朝向覆盖 X 轴与 Z 轴）', () => {
  assertEqual(norm(railArmSet('handrailA', 0)), '+X -X', 'handrailA orient=0 贯穿 X');
  assertEqual(norm(railArmSet('handrailA', 1)), '+Z -Z', 'handrailA orient=1 贯穿 Z');
  assertEqual(norm(railArmSet('handrailA', 2)), '+X -X', 'orient=2 与 0 同（180° 对称）');
  assertEqual(norm(railArmSet('handrailA', 3)), '+Z -Z', 'orient=3 与 1 同');
});

test('arena: handrailB 臂只到格中心 → 不可作为栏杆件（环上必须被拒）', () => {
  // 实测：handrailB 的臂只伸到 ±0.25（格中心），与邻居的臂在格边界处断开。
  // 因此它在「可用臂集合 → 方块」的反查表里必须缺席。
  for (const o of [0, 1, 2, 3]) {
    const arms = railArmSet('handrailB', o);
    assertTrue(!railPlacementFor(arms), `handrailB orient=${o} 不得出现在反查表里（arms=${arms.join(' ')}）`);
  }
});

test('arena: 直边/转角反查 —— 4 种臂集合各命中唯一 (方块, 朝向)', () => {
  const cases = [
    [['+X', '+Z'], 'handrail', 0],
    [['+X', '-Z'], 'handrail', 1],
    [['-X', '-Z'], 'handrail', 2],
    [['-X', '+Z'], 'handrail', 3],
    [['+X', '-X'], 'handrailA', 0],
    [['+Z', '-Z'], 'handrailA', 1],
  ];
  for (const [arms, name, orient] of cases) {
    const hit = railPlacementFor(arms);
    assertTrue(!!hit, `臂集合 ${arms.join(' ')} 必须有解`);
    assertEqual(hit.name, name, `臂集合 ${arms.join(' ')} → 方块名`);
    assertEqual(hit.orient, orient, `臂集合 ${arms.join(' ')} → 朝向`);
  }
  // 0 臂 / 3 臂（环外/畸形）必须无解，让调用方暴露问题而不是产出静默断口
  assertTrue(!railPlacementFor([]), '空臂集合无解');
  assertTrue(!railPlacementFor(['+X', '-X', '+Z']), '三臂无解');
});

// ---------------------------------------------------------------------------
// ② 锚点纯函数
// ---------------------------------------------------------------------------

test('arena: 尺寸常量自洽（AABB 半宽 = (边长-1)/2）', () => {
  assertEqual(ARENA_HALF_X * 2 + 1, ARENA_WIDTH, 'ARENA_WIDTH');
  assertEqual(ARENA_HALF_Z * 2 + 1, ARENA_DEPTH, 'ARENA_DEPTH');
});

test('arena: computeArenaAnchor 是 seed 的确定性纯函数', () => {
  clearArenaCache();
  const a = computeArenaAnchor(DEFAULT_SEED);
  const b = computeArenaAnchor(DEFAULT_SEED);
  assertTrue(!!a, '默认 seed 必须能找到落点');
  assertEqual(a.wx, b.wx, 'wx 确定性');
  assertEqual(a.wz, b.wz, 'wz 确定性');
  assertEqual(a.floorY, b.floorY, 'floorY 确定性');
  // 不同 seed 不共用缓存
  clearArenaCache();
  const c = computeArenaAnchor(424242);
  assertTrue(!!c, 'seed 424242 必须能找到落点');
  assertNotEqual(`${a.wx},${a.wz}`, `${c.wx},${c.wz}`, '不同 seed 的落点不应逐位相同');
});

test('arena: 落点在城南侧（城市 bounds 之外）', () => {
  const a = computeArenaAnchor(DEFAULT_SEED);
  const cb = getCityBoundsForSeed(DEFAULT_SEED);
  assertTrue(a.wz - ARENA_HALF_Z > cb.maxZ,
    `竞技场北缘 ${a.wz - ARENA_HALF_Z} 必须 > 城市南边界 ${cb.maxZ}（位于城外）`);
  // 与城市 bounds 的 AABB 不得相交
  assertTrue(a.wx + ARENA_HALF_X >= cb.minX && a.wx - ARENA_HALF_X <= cb.maxX
    ? a.wz - ARENA_HALF_Z > cb.maxZ : true, '与城市 AABB 不相交');
});

test('arena: 占地内 100% 干燥（每格 generateHeight >= SEA_Y）', () => {
  const a = computeArenaAnchor(DEFAULT_SEED);
  let wet = 0;
  for (let x = a.wx - ARENA_HALF_X; x <= a.wx + ARENA_HALF_X; x++) {
    for (let z = a.wz - ARENA_HALF_Z; z <= a.wz + ARENA_HALF_Z; z++) {
      if (generateHeight(x, z, DEFAULT_SEED) < SEA_Y) wet++;
    }
  }
  assertEqual(wet, 0, '占地内不得有水面格');
});

test('arena: floorY = 占地内最低自然高度，且高差 ≤ 上限', () => {
  const a = computeArenaAnchor(DEFAULT_SEED);
  let mn = Infinity, mx = -Infinity;
  for (let x = a.wx - ARENA_HALF_X; x <= a.wx + ARENA_HALF_X; x++) {
    for (let z = a.wz - ARENA_HALF_Z; z <= a.wz + ARENA_HALF_Z; z++) {
      const h = generateHeight(x, z, DEFAULT_SEED);
      if (h < mn) mn = h;
      if (h > mx) mx = h;
    }
  }
  assertEqual(a.floorY, mn, 'floorY 必须等于占地内最低自然高度（取 min，不取中心点）');
  assertEqual(a.maxH, mx, 'maxH 必须等于占地内最高自然高度');
  assertTrue(mx - mn <= ARENA_MAX_SURFACE_SPAN,
    `占地高差 ${mx - mn} 必须 ≤ ${ARENA_MAX_SURFACE_SPAN}`);
});

test('arena: 不压地标圆（3×3 邻域逐个断言）', () => {
  const a = computeArenaAnchor(DEFAULT_SEED);
  const box = {
    minX: a.wx - ARENA_HALF_X, maxX: a.wx + ARENA_HALF_X,
    minZ: a.wz - ARENA_HALF_Z, maxZ: a.wz + ARENA_HALF_Z,
  };
  const rx0 = Math.floor(box.minX / 400), rx1 = Math.floor(box.maxX / 400);
  const rz0 = Math.floor(box.minZ / 400), rz1 = Math.floor(box.maxZ / 400);
  for (let rx = rx0; rx <= rx1; rx++) {
    for (let rz = rz0; rz <= rz1; rz++) {
      for (const c of regionLandmarkCenters(rx, rz, DEFAULT_SEED)) {
        const hit = box.minX <= c.cx + c.r && box.maxX >= c.cx - c.r &&
                    box.minZ <= c.cz + c.r && box.maxZ >= c.cz - c.r;
        assertTrue(!hit, `竞技场不得压在地标(${c.cx},${c.cz},r=${c.r})上`);
      }
    }
  }
});

test('arena: inArenaFootprint 判据与占地 AABB 一致', () => {
  const a = computeArenaAnchor(DEFAULT_SEED);
  assertTrue(inArenaFootprint(a.wx, a.wz, [a]), '锚点自身在占地内');
  assertTrue(inArenaFootprint(a.wx - ARENA_HALF_X, a.wz - ARENA_HALF_Z, [a]), '西南角在占地内');
  assertTrue(inArenaFootprint(a.wx + ARENA_HALF_X, a.wz + ARENA_HALF_Z, [a]), '东北角在占地内');
  assertTrue(!inArenaFootprint(a.wx + ARENA_HALF_X + 1, a.wz, [a]), '东侧一格之外不在占地内');
  assertTrue(!inArenaFootprint(a.wx, a.wz + ARENA_HALF_Z + 1, [a]), '南侧一格之外不在占地内');
  assertTrue(!inArenaFootprint(a.wx, a.wz, [null]), 'null 锚点安全（不抛）');
});

test('arena: arenaOverlapsRegion 只在与 region 相交时为真', () => {
  const a = computeArenaAnchor(DEFAULT_SEED);
  const rx = Math.floor(a.wx / 400), rz = Math.floor(a.wz / 400);
  assertTrue(arenaOverlapsRegion(a, rx, rz), '锚点所在 region 必须相交');
  assertTrue(!arenaOverlapsRegion(a, rx + 5, rz + 5), '远处的 region 不相交');
  assertTrue(!arenaOverlapsRegion(null, rx, rz), 'null 锚点恒 false');
});

test('arena: 占地 AABB 相交的**每一个** region 都必须携带 layout.arena（含地带 region）', () => {
  // ⚠️ **这是一条真实的回归门**（实测踩到）：
  // 占地 41×79 可跨 region，而 `computeRegionLayout` 曾把 `arena` 写成 `tarn ? null : …`
  // （照抄其它地标的压制口径）—— 地带 region 那条支路会把 arena 整条丢掉
  // → **该 region 负责的那半个竞技场直接不生成**（方块层面看不出是 layout 缺字段）。
  // 实测 20 个 seed 里有 2 个（seed 1 / 5150）的占地 AABB 确实跨进了地带 region。
  let checkedRegions = 0;
  for (const seed of [DEFAULT_SEED, 1, 5150, 424242, 999]) {
    clearArenaCache();
    const a = computeArenaAnchor(seed);
    assertTrue(!!a, `seed ${seed} 必须有竞技场锚点`);
    const rx0 = Math.floor((a.wx - ARENA_HALF_X) / 400);
    const rx1 = Math.floor((a.wx + ARENA_HALF_X) / 400);
    const rz0 = Math.floor((a.wz - ARENA_HALF_Z) / 400);
    const rz1 = Math.floor((a.wz + ARENA_HALF_Z) / 400);
    for (let rx = rx0; rx <= rx1; rx++) {
      for (let rz = rz0; rz <= rz1; rz++) {
        if (!arenaOverlapsRegion(a, rx, rz)) continue;
        checkedRegions++;
        const l = computeRegionLayout(rx, rz, seed);
        assertTrue(!!l.arena, `seed ${seed} 的 region(${rx},${rz}) 与占地相交但 layout.arena 为 null`);
        assertEqual(l.arena.wx, a.wx, `seed ${seed} region(${rx},${rz}) 的 arena 锚点必须一致`);
      }
    }
  }
  assertTrue(checkedRegions > 5, `必须真的检查到多个 region（实际 ${checkedRegions} 个）`);
});
