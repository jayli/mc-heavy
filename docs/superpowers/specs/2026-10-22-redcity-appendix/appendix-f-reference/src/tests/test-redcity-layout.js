// RedCity 布局层（Tier 1）：落点 / baseY / 影响域 / 点位分区 / 出生点（region(0,0) 挂载归 RedCity 计划 Task 5 的 dispatch 测试）
import { test } from './runner.js';
import { assertEqual, assertTrue, assertDeepEqual, assertNull } from './assert.js';
import { buildCityLayout } from '../gen/structures/city-layout.js';
import {
  buildRedCityLayout, estimateBaseY, getRedCityInfo, getRedCitySpawnPoint, scanDownForSpawn,
} from '../gen/structures/redcity-layout.js';
import {
  REDCITY_SIZE, REDCITY_TRANSITION, REDCITY_GAP, REDCITY_GROUND_FLOOR, REDCITY_BASE_Y_MAX, REDCITY_DY_MAX_BUDGET,
} from '../gen/structures/region-config.js';
import { SEA_Y, WORLD_MAX_Y } from '../voxel/constants.js';

/** 599 / 1491 是实测 baseY=5 的 seed（1500 个 seed 里仅有的两个 > 4），其余为 4 —— 覆盖「下限不总是生效」的分支 */
const SEEDS = [1, 7, 599, 1491, 12345, 99999];

test('RedCity 落点：固定 City 东侧（core.minX === city.maxX + 1 + GAP），尺寸 === REDCITY_SIZE，Z 居中，确定性', () => {
  for (const seed of SEEDS) {
    const city = buildCityLayout(seed);
    const a = buildRedCityLayout(seed, city), b = buildRedCityLayout(seed, city);
    assertDeepEqual(a, b, `seed ${seed} 同输入两次结果相同`);
    assertEqual(a.core.minX, city.maxX + 1 + REDCITY_GAP, 'City bounds 是闭区间，故 +1');
    assertEqual(a.core.maxX - a.core.minX + 1, REDCITY_SIZE.X);
    assertEqual(a.core.maxZ - a.core.minZ + 1, REDCITY_SIZE.Z);
    assertEqual(a.core.minZ, Math.round(city.centerZ - REDCITY_SIZE.Z / 2), 'Z 向以 City 中心对齐');
    assertDeepEqual(a.size, { X: REDCITY_SIZE.X, Z: REDCITY_SIZE.Z });
  }
});

test('影响域 = core ⊕ TRANSITION，且与 City bounds 邻接不相交（influence.minX === city.maxX + 1）；无回退分支', () => {
  for (const seed of SEEDS) {
    const city = buildCityLayout(seed); const rc = buildRedCityLayout(seed, city);
    assertEqual(rc.influence.minX, rc.core.minX - REDCITY_TRANSITION);
    assertEqual(rc.influence.maxX, rc.core.maxX + REDCITY_TRANSITION);
    assertEqual(rc.influence.minZ, rc.core.minZ - REDCITY_TRANSITION);
    assertEqual(rc.influence.maxZ, rc.core.maxZ + REDCITY_TRANSITION);
    assertEqual(rc.influence.minX, city.maxX + 1, 'GAP === TRANSITION：过渡环恰好填满间隙，与 City 自己的内缘过渡首尾相接');
    assertTrue(rc.influence.minX > city.maxX, '与 City 闭区间 bounds 不相交');
    assertTrue(rc.core.minX > city.maxX, '永远在东侧（无冲突回退到西侧的分支）');
  }
});

test('baseY：≥ SEA_Y+1-GROUND_FLOOR（=4，岛最低处是干地）、≤ REDCITY_BASE_Y_MAX；常量自洽 BASE_Y_MAX + DY_MAX_BUDGET ≤ WORLD_MAX_Y-1', () => {
  assertTrue(REDCITY_BASE_Y_MAX + REDCITY_DY_MAX_BUDGET <= WORLD_MAX_Y - 1,
    'WORLD_MAX_Y 是独占上界（合法 y 最大 95）：8 + 87 = 95 才刚好，< 96 不算对');
  for (const seed of SEEDS) {
    const rc = buildRedCityLayout(seed, buildCityLayout(seed));
    assertTrue(rc.baseY >= SEA_Y + 1 - REDCITY_GROUND_FLOOR, `seed ${seed} baseY ${rc.baseY} >= 下限`);
    assertTrue(rc.baseY <= REDCITY_BASE_Y_MAX, `seed ${seed} baseY ${rc.baseY} <= 上限`);
  }
});

test('baseY 上界是钳制不是抛错：小 core 放在高地上（未钳制中位 11）→ 返回 REDCITY_BASE_Y_MAX', () => {
  // 夹具：seed 12345，8×8 的小 core 在 (-1968,-1672)——其外圈有效自然高度的中位数是 11（评审期扫描所得）。
  // 真实 250×289 的 core 外圈中位数永远到不了这么高（1500 个 seed 最大 5），所以只能用小 core 逼出钳制分支。
  const core = { minX: -1968, maxX: -1961, minZ: -1672, maxZ: -1665 };
  assertEqual(estimateBaseY(core, 12345), REDCITY_BASE_Y_MAX);
});

test('I4 布局期半：真实产物 dyMax 下，所有抽样 seed 的 baseY + dyMax < WORLD_MAX_Y（内容不被世界顶截断）', async () => {
  const doc = await (await fetch('/assets/redcity/redcity.json')).json();
  assertTrue(doc.dyMax <= REDCITY_DY_MAX_BUDGET, '烘焙期半：dyMax <= 预算');
  for (const seed of SEEDS) {
    const rc = buildRedCityLayout(seed, buildCityLayout(seed));
    assertTrue(rc.baseY + doc.dyMax < WORLD_MAX_Y, `seed ${seed}: ${rc.baseY} + ${doc.dyMax} < ${WORLD_MAX_Y}`);
  }
});

test('getRedCityInfo：core / ring / null 三分支；ring 的 edgeDistance = 到 core 的切比雪夫距离，沿直线外推逐格 +1，第 25 格为 null', () => {
  const rc = buildRedCityLayout(12345, buildCityLayout(12345)); const c = rc.core;
  const at = (x, z) => getRedCityInfo(x, z, rc);
  assertDeepEqual(at(c.minX, c.minZ), { zone: 'core', edgeDistance: 0, ox: 0, oz: 0 });
  assertDeepEqual(at(c.maxX, c.maxZ), { zone: 'core', edgeDistance: 0, ox: REDCITY_SIZE.X - 1, oz: REDCITY_SIZE.Z - 1 });
  for (let d = 1; d <= REDCITY_TRANSITION; d++) {
    assertDeepEqual(at(c.maxX + d, c.minZ + 50), { zone: 'ring', edgeDistance: d }, `东侧 d=${d}`);
    assertDeepEqual(at(c.minX - d, c.minZ + 50), { zone: 'ring', edgeDistance: d }, `西侧 d=${d}`);
  }
  assertNull(at(c.maxX + REDCITY_TRANSITION + 1, c.minZ + 50), '第 25 格已在影响域外');
  assertEqual(at(c.minX - 5, c.minZ - 3).edgeDistance, 5, '角落取切比雪夫距离 max(5,3)');
  assertNull(at(c.minX - 25, c.minZ - 25));
});

test('getRedCitySpawnPoint：x/z = 烘焙列的方块中心，y = baseY + dy + 1（dy 是行号，不是相对该列地面的偏移）', () => {
  const redCity = { core: { minX: 600, minZ: -20 }, baseY: 4 };
  const model = { spawn: { ox: 138, oz: 141, dy: -3 } };
  assertDeepEqual(getRedCitySpawnPoint(redCity, model), { x: 738.5, y: 2, z: 121.5 });
});

test('scanDownForSpawn：从 yTop 向下扫首个「脚下 solid 且其上两格空气」；上方被玩家盖了东西也落在合法位置；全空返回 null', () => {
  const solid = new Set(['5,10,5']);                                    // 原地面：y=10
  const getId = (x, y, z) => (solid.has(`${x},${y},${z}`) ? 1 : 0);
  assertEqual(scanDownForSpawn(getId, 5.5, 34, 5.5), 11, '站在地面方块顶面');
  solid.add('5,20,5');                                                  // 玩家日后在出生点上方盖了一块
  assertEqual(scanDownForSpawn(getId, 5.5, 34, 5.5), 21, '落在新方块顶面（有 2 格净空即合法）');
  assertEqual(scanDownForSpawn(() => 0, 5.5, 34, 5.5), null, '整列全空 → null（调用方退回提示 y）');
  // 1 格高的缝：脚下 y=10 solid、y=11 空气，但 y=12 又是实心 → 头顶第二格不空，不是合法站立位（注入「只查脚所在格」后这里会错返 11）
  const slot = new Set(['5,10,5', '5,12,5']);
  assertEqual(scanDownForSpawn((x, y, z) => (slot.has(`${x},${y},${z}`) ? 1 : 0), 5.5, 12, 5.5), null, '1 格高的缝不算合法站立位');
});
