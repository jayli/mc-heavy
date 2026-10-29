// src/tests/test-scatter.js — 结构撒布判定纯函数（M2 撒布欠账补齐）
//
// 三条路径的判定门控（mc-lite WorldWorker.js 算法语义）：
// ① 城市撒布：flowerBed(seed+823) / house(seed+812) / pavilion(seed+824) / tallWell(seed+826)
// ② 城市外 house：seed+4 千分之一 + safeForStructure 内圈门控
// ③ 城市外大型静态结构：desertPyramid(seed+25) / desertVillage(seed+26) / uglyHouse(seed+23) / tank(seed+5)
//
// ⚠️ 概率口径断言用**关系式**而非硬编码数值 —— 硬编码「被测代码写入的那个值」会让
// 回退后测试仍 PASS（testing-policy §2.5 陷阱②）。

import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse, assertNotNull, assertDeepEqual } from './assert.js';
import {
  CITY_SCATTER_CHANCE, OUTSIDE_SCATTER_CHANCE,
  safeForStructure, rollCityScatter, rollOutsideScatter, generateCodeHouse, SCATTER_TYPES,
  rollShipScatter, generateCodeShip, SHIP_DEEP_SEA_Y,
  CODE_GENERATED_SCATTER_TYPES, SCATTER_JSON_TYPES, SCATTER_STRIDE,
  HOUSE_MAX_SURFACE_SPAN, filterPavilionOverlaps, computeScatterCandidates,
} from '../gen/structures/scatter.js';
import { computeRegionLayout, neighborRegionKeys } from '../gen/structures/structure-layout.js';
import { computeShallowTarnAnchor, inShallowTarnFootprint } from '../gen/structures/shallow-water-tarns.js';
import { applyStructuresToColumn } from '../gen/structures/apply.js';
import { fillColumn, generateHeight } from '../gen/terrain.js';
import { carveCaves } from '../gen/caves.js';
import { getBiome } from '../gen/noise.js';
import { rollVegetation, rollCityTree } from '../gen/structures/vegetation.js';
import { getCityInfo, isPointNearCityStructure } from '../gen/structures/city-layout.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { makeColumnSetter, getCityFinalSurfaceY } from '../gen/structures/landmarks.js';
import { SCATTER_FOOTPRINT, REGION_SIZE } from '../gen/structures/region-config.js';
import { GROUND_SUPPORT_TYPES } from '../gen/structures/structure-json.js';
import { blockIndex, SEA_Y } from '../voxel/constants.js';

const SEED = 12345;

function makeRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}

/** 判定入口：把 point 拆成 rollCityScatter 的参数 */
function rollAt(p) {
  return rollCityScatter(p.wx, p.wz, p.info, p.surfaceY, SEED);
}

/**
 * 扫城市范围内的点，按 transitionFactor 分成「核心区」与「过渡带」两组。
 *
 * ⚠️ 两个上限必须**各自独立**判断，不能写进 for 循环条件：城市 bounds 约 566×566，
 * 从 minX 起扫时最外层一整条 x 边缘全是过渡带（CITY_TRANSITION_SIZE=32），
 * 若条件写成 `core.length < limit && transition.length < limit`，过渡带填满 260 后
 * 循环立即退出 → **核心区一个点都采不到**，后续门控断言全部恒真
 * （testing-policy §2.5 陷阱①：落点只按数据条件筛，实际不触发目标分支）。实测踩坑。
 *
 * 采样量：flowerBed 概率 0.0005 → 需要数千个核心区点才期望命中数次，step=3 取 ~35k 点。
 */
function collectCityPoints(city) {
  const core = [];
  const transition = [];
  const CORE_LIMIT = 24000, TRANSITION_LIMIT = 3000;
  const step = 3; // 采样步长（避免逐格全扫，概率判定与步长无关）
  for (let wx = city.minX; wx <= city.maxX; wx += step) {
    for (let wz = city.minZ; wz <= city.maxZ; wz += step) {
      const info = getCityInfo(wx, wz, city);
      if (!info) continue;
      // surfaceY 由调用方算（mc-lite 来自 CityMap.generate 返回值，mc-heavy 的 getCityInfo 不带）
      const surfaceY = getCityFinalSurfaceY(wx, wz, info, SEED);
      const point = { wx, wz, info, surfaceY };
      if (info.transitionFactor === 0) { if (core.length < CORE_LIMIT) core.push(point); }
      else if (transition.length < TRANSITION_LIMIT) transition.push(point);
    }
  }
  return { core, transition };
}

// ==================== safeForStructure：chunk 内圈门控 ====================

test('safeForStructure：chunk 内圈 [3,12]×[3,12] 为真，边缘为假', () => {
  // 判据独立于实现：mc-lite WorldWorker.js:775 `x >= 3 && x <= 12 && z >= 3 && z <= 12`
  assertEqual(safeForStructure(3, 3), true, 'corner (3,3) 内圈');
  assertEqual(safeForStructure(12, 12), true, 'corner (12,12) 内圈');
  assertEqual(safeForStructure(2, 5), false, 'x=2 越界');
  assertEqual(safeForStructure(13, 5), false, 'x=13 越界');
  assertEqual(safeForStructure(5, 2), false, 'z=2 越界');
  assertEqual(safeForStructure(5, 13), false, 'z=13 越界');
  // 负坐标与跨 chunk：局部坐标须按 mod 16 归一化
  assertEqual(safeForStructure(-13, 5), true, '负坐标局部 x=3 内圈');
  assertEqual(safeForStructure(-14, 5), false, '负坐标局部 x=2 越界');
  assertEqual(safeForStructure(19, 35), true, '跨 chunk 局部 (3,3) 内圈');
});

// ==================== 概率口径：关系式断言 ====================

test('城市撒布概率口径：pavilion = flowerBed×3，tallWell = flowerBed×3（v2.2 起同档）', () => {
  // mc-lite WorldWorker.js:92-93 是 pavilion=×6 / tallWell=×3。
  // ⚠️ **本仓 v2.2 把 pavilion 从 ×6 降到 ×3**（用户 2026-10-28：「pavilion 在 city 中出现的
  // 概率降低一倍」= 减半）。这里钉住的是**当前的关系式**，不是 mc-lite 原值 —— 若将来有人
  // 照上游“补齐”回 ×6，这条会红并指向 pavilion 注释里的理由（观感 + cutout 压力）。
  assertEqual(CITY_SCATTER_CHANCE.pavilion, CITY_SCATTER_CHANCE.flowerBed * 3, 'pavilion 是 flowerBed×3');
  assertEqual(CITY_SCATTER_CHANCE.tallWell, CITY_SCATTER_CHANCE.flowerBed * 3, 'tallWell 是 flowerBed×3');
  assertEqual(CITY_SCATTER_CHANCE.pavilion, CITY_SCATTER_CHANCE.tallWell,
    'v2.2 起 pavilion 与 tallWell 同档（刻意偏离 mc-lite 的 ×6）');
  assertTrue(CITY_SCATTER_CHANCE.flowerBed > 0, 'flowerBed 概率为正');
});

test('城市外撒布概率口径：大 JSON 已减半（有意偏离 mc-lite，守 genP95 预算）', () => {
  // mc-lite WorldWorker.js:142-143 是 desertPyramid = desertVillage = 0.00016。
  // 本仓库**有意打破**该等式：desertVillage(1181 方块)/uglyHouse(719) 是 GEN 光栅化大头，
  // mc-lite 概率会让 structure-gen 的 p95 撞破 8ms 冻结预算，故两者减半
  // （desertPyramid 当时不降 —— 它走 groundSupport，方块少，不是 p95 大头）。
  // 钉住「大 JSON 更稀」这条关系式（关系型断言，不硬编码数值 —— §2.5 陷阱②）。
  assertTrue(OUTSIDE_SCATTER_CHANCE.uglyHouse < OUTSIDE_SCATTER_CHANCE.desertVillage,
    'uglyHouse 比 desertVillage 更稀');

  // v1.77：desertPyramid 按用户要求降到原来的 1/3（「沙漠神殿出现概率有点太高了」）。
  // ⚠️ 这不是性能代偿：它本来就不降。断言用「×3 还原回 mc-lite 原值」的口径钉住
  // 「÷3」这个**关系**，而不是硬编码 0.0000533 —— 将来改阈值时这条继续成立。
  assertTrue(Math.abs(OUTSIDE_SCATTER_CHANCE.desertPyramid * 3 - 0.00016) < 1e-12,
    'desertPyramid = mc-lite 原值 ÷ 3（用户要求的观感标定）');

  // ⚠️ **旧关系在此刻意倒置**：原断言是「desertVillage < desertPyramid」（大 JSON 更稀）。
  // pyramid ÷3 后它反而比 village 更稀了 —— 这是用户明确选择的（只降神殿、村落不动）。
  // 这里把倒置后的实际关系钉住，防止有人「顺手改回」成旧口径而无人察觉。
  assertTrue(OUTSIDE_SCATTER_CHANCE.desertPyramid < OUTSIDE_SCATTER_CHANCE.desertVillage,
    'desertPyramid 已 ÷3 → 现在比 desertVillage 更稀（v1.77 的有意倒置）');

  // house/tank 不降（代码生成 / 占地小，不吃预算）
  assertTrue(OUTSIDE_SCATTER_CHANCE.house > OUTSIDE_SCATTER_CHANCE.tank,
    'house 比 tank 密');
  assertTrue(OUTSIDE_SCATTER_CHANCE.tank > OUTSIDE_SCATTER_CHANCE.desertVillage,
    'tank 比沙漠村落密');
  // house 仍是城市外撒布里最密的（草地上的房子保持可见）
  for (const [k, v] of Object.entries(OUTSIDE_SCATTER_CHANCE)) {
    if (k === 'house' || k === 'ship') continue; // ship 同为 0.001（深海限定，与陆地不争地）
    assertTrue(OUTSIDE_SCATTER_CHANCE.house >= v, `house 概率最高（至少不低于 ${k}）`);
  }
});

// ==================== 确定性（红线 2）====================

test('rollOutsideScatter：同 seed 两次判定一致（确定性，红线 2）', () => {
  let mismatch = 0;
  let hits = 0;
  for (let wx = -300; wx < 300; wx += 3) {
    for (let wz = -300; wz < 300; wz += 3) {
      const a = rollOutsideScatter(wx, wz, 'DESERT', 'sand', false, SEED);
      const b = rollOutsideScatter(wx, wz, 'DESERT', 'sand', false, SEED);
      if (a !== b) mismatch++;
      if (a) hits++;
    }
  }
  assertEqual(mismatch, 0, '判定完全确定');
  assertTrue(hits > 0, `沙漠撒布确有命中（hits=${hits}），否则断言恒真`);
});

test('rollCityScatter：同 seed 两次判定一致（确定性，红线 2）', () => {
  const city = computeRegionLayout(0, 0, SEED).city;
  assertNotNull(city, 'city layout');
  const { core } = collectCityPoints(city);
  assertTrue(core.length > 0, '找到城市核心区候选点');
  let mismatch = 0;
  let hits = 0;
  for (const p of core) {
    const a = rollAt(p);
    const b = rollAt(p);
    if (JSON.stringify(a) !== JSON.stringify(b)) mismatch++;
    if (a) hits++;
  }
  assertEqual(mismatch, 0, '判定完全确定');
  assertTrue(hits > 0, `城市撒布确有命中（hits=${hits}），否则断言恒真`);
});

// ==================== 门控生效 ====================

test('城市撒布：过渡带（transitionFactor>0）不出 flowerBed/pavilion/tallWell', () => {
  const city = computeRegionLayout(0, 0, SEED).city;
  const { transition } = collectCityPoints(city);
  assertTrue(transition.length > 0, '找到城市过渡带候选点');
  let leaked = 0;
  for (const p of transition) {
    const r = rollAt(p);
    if (r && (r.type === 'flowerBed' || r.type === 'pavilion' || r.type === 'tallWell')) leaked++;
  }
  assertEqual(leaked, 0, '过渡带不得撒布装饰结构（mc-lite cityCoreCandidates 只收 transitionFactor===0）');
});

test('城市撒布：flowerBed 命中点必远离主建筑（isPointNearCityStructure 门控）', () => {
  // ⚠️ 不能用「castle 周边小范围采样」来测这条门控：flowerBed 概率 0.0005，
  // 小范围采样期望命中 <1 次 → leaked 恒 0、断言恒真（实测踩坑，注入去掉门控后仍全绿）。
  // 正确做法：扫**整个城市核心区**拿到足量真实命中点，再逐个验证它们都远离主建筑 ——
  // 断言落在实际命中的点上（testing-policy §2.5 陷阱①）。
  const city = computeRegionLayout(0, 0, SEED).city;
  const { core } = collectCityPoints(city);
  const hits = [];
  for (const p of core) {
    if (rollAt(p)?.type === 'flowerBed') hits.push(p);
  }
  assertTrue(hits.length > 0, `确有 flowerBed 命中（${hits.length} 个），否则断言恒真`);
  let leaked = 0;
  for (const p of hits) {
    if (isPointNearCityStructure(p.wx, p.wz, city, 1)) leaked++;
  }
  assertEqual(leaked, 0, `${hits.length} 个命中点无一靠近主建筑`);
});

test('城市撒布：判定是纯函数 —— 同一坐标在任何调用上下文下结论恒一致（跨 column 不变式）', () => {
  // 这是移除 occupied 参数后要钉住的核心不变式：撒布结构跨 column 光栅化时，
  // 多个 column 会对同一候选点各自判定；若结论依赖调用方传入的累积 Set，
  // 不同 column 的扫描范围会给出不同结论 → 结构接缝断裂（半个亭子）。
  // 实测：曾经加 occupied 参数时，同一坐标传空 Set 与传含该点的 Set 结论相反。
  const city = computeRegionLayout(0, 0, SEED).city;
  const { core } = collectCityPoints(city);
  const hits = [];
  for (const p of core) {
    const r = rollAt(p);
    if (r) hits.push({ p, r });
  }
  assertTrue(hits.length > 0, `确有城市撒布命中（${hits.length} 个），否则断言恒真`);

  // 对每个命中点，用「完全不同的调用上下文」重复判定 —— 结论必须一致。
  // 上下文差异体现在：重新独立算 cityInfo/surfaceY（不复用 point 里缓存的对象）。
  let inconsistent = 0;
  for (const { p, r } of hits) {
    const info2 = getCityInfo(p.wx, p.wz, city);
    const surfaceY2 = getCityFinalSurfaceY(p.wx, p.wz, info2, SEED);
    const r2 = rollCityScatter(p.wx, p.wz, info2, surfaceY2, SEED);
    if (JSON.stringify(r) !== JSON.stringify(r2)) inconsistent++;
  }
  assertEqual(inconsistent, 0, `${hits.length} 个命中点在独立上下文下结论全部一致`);
});

test('城市撒布：house/pavilion/tallWell 均避开树（扫邻域 rollCityTree，等价 mc-lite 运行期 Set）', () => {
  // mc-lite 用 cityTreeCenters/cityTallTreeCenters 运行期 Set；本仓库扫邻域调用
  // rollCityTree 确定性复现。断言落在实际命中的点上（§2.5 陷阱①）。
  // 半径用 scatter.js 的实际门控半径（TREE_GATE_RADIUS=2），勿硬编码 mc-lite 的 8/10/7/9
  // —— 本仓库有意偏离 mc-lite（树密度差 3 倍，大半径会把撒布结构全挡掉）。
  //
  // ⚠️ 三种类型都要测：pavilion/tallWell 的树门控一度缺失（mc-lite canPlaceCityPavilion
  // :669 / canPlaceCityTallWell :739 都有 nearTree，我初版只查了 flowerBed），
  // 只测 house 会让这个缺口静默逃逸。
  const GATE = 2;
  const city = computeRegionLayout(0, 0, SEED).city;
  const { core } = collectCityPoints(city);

  const byType = { house: [], pavilion: [], tallWell: [] };
  for (const p of core) {
    const r = rollAt(p);
    if (r && byType[r.type]) byType[r.type].push(p);
  }

  for (const type of ['house', 'pavilion', 'tallWell']) {
    const hits = byType[type].slice(0, 40); // 限量：每点要扫 25 格邻域
    assertTrue(hits.length > 0, `确有 ${type} 命中（${byType[type].length} 个），否则断言恒真`);
    let leaked = 0;
    for (const p of hits) {
      // 逐个命中点复算邻域：半径 GATE 内不得有树
      for (let dx = -GATE; dx <= GATE; dx++) {
        for (let dz = -GATE; dz <= GATE; dz++) {
          const roll = rollCityTree(p.wx + dx, p.wz + dz, SEED);
          if (roll.tree) leaked++;
        }
      }
    }
    assertEqual(leaked, 0, `${hits.length} 个 ${type} 命中点周边 ${GATE} 格内均无树`);
  }
});

test('城市撒布：tallWell/pavilion 命中点周边无 flowerBed（nearCityFlowerBed 门控）', () => {
  // ⚠️ 这条门控一度**无测试覆盖**：注入「nearCityFlowerBed 恒返回 false」后测试仍全绿
  // （无效负向验证）。实测门控确实在挡点（tallWell 挡 3 个 / pavilion 挡 26 个），
  // 故是测试盲区而非实现问题。断言落在实际命中点上，用 rollCityScatter 作权威判据
  // （不另写第二份 flowerBed 判据 —— 红线 1）。
  const city = computeRegionLayout(0, 0, SEED).city;
  const { core } = collectCityPoints(city);
  // 半径 = scatter.js 的实际门控口径（mc-lite：tallWell 查 flowerBed 半径 5 / pavilion 8）
  const RADIUS = { tallWell: 5, pavilion: 8 };
  const LIMIT = 40; // 限量：每个命中点要扫 (2r+1)² 邻域，40 个足够钉住门控且不拖慢测试

  for (const type of ['tallWell', 'pavilion']) {
    const radius = RADIUS[type];
    const hits = [];
    for (const p of core) {
      if (rollAt(p)?.type === type) {
        hits.push(p);
        if (hits.length >= LIMIT) break;
      }
    }
    assertTrue(hits.length > 0, `确有 ${type} 命中（${hits.length} 个），否则断言恒真`);
    let leaked = 0;
    for (const p of hits) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          const nx = p.wx + dx, nz = p.wz + dz;
          const info = getCityInfo(nx, nz, city);
          if (!info) continue;
          const sy = getCityFinalSurfaceY(nx, nz, info, SEED);
          if (rollCityScatter(nx, nz, info, sy, SEED)?.type === 'flowerBed') leaked++;
        }
      }
    }
    assertEqual(leaked, 0, `${hits.length} 个 ${type} 命中点周边 ${radius} 格内无 flowerBed`);
  }
});

// —— pavilion 重叠（v2.2，用户 2026-10-28：「渲染的时候注意不要跟其他实体有重叠」）——
//
// 根因（实测 seed 12345）：pavilion 没有跨类型互斥，同类互斥的扫描窗也只开了 `±half`
// （两个相距 ≤2×half 的候选本来就重叠）→ 实测重叠 12 对同类 + 23 对与其它类型。
test('pavilion 互斥：城市候选里 pavilion 两两不相交、且不与任何其它撒布结构相交', () => {
  const layout = computeRegionLayout(0, 0, SEED);
  const city = layout.city;
  assertNotNull(city, 'city layout');
  const cands = computeScatterCandidates(0, 0, SEED, city);
  const by = {};
  for (let i = 0; i < cands.cityScatter.length; i += SCATTER_STRIDE) {
    const t = SCATTER_TYPES[cands.cityScatter[i + 3]];
    (by[t] || (by[t] = [])).push({ x: cands.cityScatter[i], z: cands.cityScatter[i + 2] });
  }
  const pav = by.pavilion || [];
  // 判别力：必须有 pavilion，否则下面的「无重叠」恒真
  assertTrue(pav.length > 20, `须有足量 pavilion（v2.2 实测 76 个），否则断言无判别力：${pav.length}`);

  // 重叠判定用 **real 真实包围盒**（不是 halfX/halfZ —— 后者是抑制/裁剪范围，
  // tallWell 的 24/20 vs 真实 5/4 差很多，混用会把 20 格外的合法亭子也算成重叠）。
  const box = (t, c) => {
    const r = SCATTER_FOOTPRINT[t].real;
    return { x0: c.x + r.minX, x1: c.x + r.maxX, z0: c.z + r.minZ, z1: c.z + r.maxZ };
  };
  const hit = (a, b) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.z0 <= b.z1 && b.z0 <= a.z1;

  let selfOverlap = 0;
  for (let i = 0; i < pav.length; i++) {
    for (let j = i + 1; j < pav.length; j++) {
      if (hit(box('pavilion', pav[i]), box('pavilion', pav[j]))) selfOverlap++;
    }
  }
  assertEqual(selfOverlap, 0, 'pavilion 之间不得重叠（实测修复前 12 对）');

  let crossOverlap = 0;
  const kinds = {};
  for (const p of pav) {
    for (const [t, list] of Object.entries(by)) {
      if (t === 'pavilion') continue;
      for (const q of list) {
        if (hit(box('pavilion', p), box(t, q))) { crossOverlap++; kinds[t] = (kinds[t] || 0) + 1; }
      }
    }
  }
  assertEqual(crossOverlap, 0,
    `pavilion 不得与其它撒布结构重叠（实测修复前 23 对）：${JSON.stringify(kinds)}`);
});

test('filterPavilionOverlaps：结果与输入顺序无关（跨 column 确定性，红线 2）', () => {
  // 这条不变式是该函数能放在 region 层一次算的前提：多个 column 会对同一批候选各算一遍，
  // 若结果依赖候选的遍历/下标顺序 → 同一坐标在不同 column 得不同结论 → 结构接缝断裂。
  const cands = [
    { x: 100, z: 100, y: 0, type: 'pavilion' },
    { x: 106, z: 102, y: 0, type: 'pavilion' },   // 与上一个真实框相交（x 距 6 ≤ 9）
    { x: 200, z: 200, y: 0, type: 'pavilion' },   // 孤立
    { x: 103, z: 101, y: 0, type: 'tallWell' },   // 与两个 pavilion 都相交
    { x: 300, z: 300, y: 0, type: 'flowerBed' },  // 孤立
  ];
  const keyOf = (list) => list.map((c) => `${c.type}@${c.x},${c.z}`).sort().join('|');
  const a = filterPavilionOverlaps(cands);
  const b = filterPavilionOverlaps([...cands].reverse());
  const c = filterPavilionOverlaps([cands[2], cands[0], cands[4], cands[3], cands[1]]);
  assertEqual(keyOf(a), keyOf(b), '倒序输入得到同一保留集合');
  assertEqual(keyOf(a), keyOf(c), '任意重排输入得到同一保留集合');
  // 判别力：非 pavilion 必须全部保留，且被 tallWell 夹住的 pavilion 必须被剔除
  assertTrue(a.some((x) => x.type === 'tallWell'), '非 pavilion 全量保留');
  assertTrue(a.some((x) => x.type === 'pavilion' && x.x === 200), '孤立的 pavilion 保留');
  assertEqual(a.filter((x) => x.type === 'pavilion').length, 1, '被邻接结构夹住的 pavilion 全部剔除');
});

test('城市外撒布：occupied=true 时不出任何大型结构', () => {
  let leaked = 0, checked = 0;
  for (let wx = -300; wx < 300; wx += 3) {
    for (let wz = -300; wz < 300; wz += 3) {
      checked++;
      if (rollOutsideScatter(wx, wz, 'DESERT', 'sand', true, SEED)) leaked++;
    }
  }
  assertTrue(checked > 0, '确有采样点');
  assertEqual(leaked, 0, 'occupied 点不得撒大型结构');
});

test('城市外撒布：safeForStructure=false 时不出 house 与大型结构', () => {
  let leaked = 0;
  for (let wx = 0; wx < 64; wx++) {
    for (let wz = 0; wz < 64; wz++) {
      if (safeForStructure(wx, wz)) continue; // 只查内圈之外的点
      if (rollOutsideScatter(wx, wz, 'DESERT', 'sand', false, SEED)) leaked++;
      if (rollOutsideScatter(wx, wz, 'PLAINS', 'grass', false, SEED)) leaked++;
    }
  }
  assertEqual(leaked, 0, 'chunk 边缘不得撒布（防跨 chunk 切割）');
});

test('城市外撒布：每点最多一个类型（互斥，mc-lite resolveLargeStaticStructureType 单一返回）', () => {
  for (let wx = -300; wx < 300; wx += 3) {
    for (let wz = -300; wz < 300; wz += 3) {
      const r = rollOutsideScatter(wx, wz, 'DESERT', 'sand', false, SEED);
      assertTrue(r === null || typeof r === 'string', '返回单个类型字符串或 null');
    }
  }
});

test('城市外撒布：非 DESERT biome 不出沙漠结构；非 grass 地表不出 tank/house', () => {
  // ⚠️ tank 门控不能用 `DESERT+sand` 来测：DESERT 分支在 tank 判定之前就 `return null`，
  // 那条路径根本没被触达 → tankLeak 恒 0、断言恒真（实测踩坑，注入去掉 grass 门控后仍全绿）。
  // 正确做法：用「非 DESERT biome + 非 grass 地表」的点，tank/house 门控才真正参与判定。
  let desertLeak = 0, tankLeak = 0, houseLeak = 0, checked = 0;
  for (let wx = -300; wx < 300; wx += 3) {
    for (let wz = -300; wz < 300; wz += 3) {
      // 沙漠结构：PLAINS biome 不得出沙漠结构
      const r = rollOutsideScatter(wx, wz, 'PLAINS', 'grass', false, SEED);
      if (r === 'desertPyramid' || r === 'desertVillage' || r === 'uglyHouse') desertLeak++;
      // tank/house：非 grass 地表（PLAINS + sand）不得出
      checked++;
      const r2 = rollOutsideScatter(wx, wz, 'PLAINS', 'sand', false, SEED);
      if (r2 === 'tank') tankLeak++;
      if (r2 === 'house') houseLeak++;
    }
  }
  assertTrue(checked > 0, '确有采样点');
  assertEqual(desertLeak, 0, '沙漠结构只在 DESERT biome');
  assertEqual(tankLeak, 0, 'tank 只在 grass 地表');
  assertEqual(houseLeak, 0, 'house 只在 grass 地表');
});

test('城市外撒布：DESERT 区确有沙漠结构命中（防恒真）', () => {
  let hits = {};
  for (let wx = -1200; wx < 1200; wx += 2) {
    for (let wz = -1200; wz < 1200; wz += 2) {
      const r = rollOutsideScatter(wx, wz, 'DESERT', 'sand', false, SEED);
      if (r) hits[r] = (hits[r] || 0) + 1;
    }
  }
  assertTrue((hits.desertPyramid || 0) > 0, `desertPyramid 命中 ${hits.desertPyramid || 0} 次`);
});

test('城市外撒布：grass 地表确有 tank 命中（防恒真）', () => {
  let tanks = 0;
  for (let wx = -1200; wx < 1200; wx += 2) {
    for (let wz = -1200; wz < 1200; wz += 2) {
      if (rollOutsideScatter(wx, wz, 'PLAINS', 'grass', false, SEED) === 'tank') tanks++;
    }
  }
  assertTrue(tanks > 0, `tank 命中 ${tanks} 次`);
});

// ==================== generateCodeHouse 几何（Task 2）====================

test('generateCodeHouse：地基 25 格 stone + 屋顶脊 + bookbox/chest', () => {
  const reg = makeRegistry();
  const col = new ChunkColumn(0, 0);
  const setBlock = makeColumnSetter(col, reg);
  generateCodeHouse(8, 10, 8, setBlock, SEED);

  const stoneId = reg.idOf('stone');
  // 地基：y-1 层 5×5 = 25 格 stone（mc-lite WorldWorker.js:2948）
  let foundation = 0;
  for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
    if (col.blocks[blockIndex(lx, 9, lz)] === stoneId) foundation++;
  }
  assertEqual(foundation, 25, '地基 5×5 stone');

  // bookbox (x-1,y,z-1) 与 chest (x+1,y,z-1) —— mc-lite WorldWorker.js:2990-2991
  assertEqual(col.blocks[blockIndex(7, 10, 7)], reg.idOf('bookbox'), 'bookbox 在 (x-1,y,z-1)');
  assertEqual(col.blocks[blockIndex(9, 10, 7)], reg.idOf('chest'), 'chest 在 (x+1,y,z-1)');

  // 屋顶脊 y+5：mc-lite WorldWorker.js:2974 沿 z 方向 3 格（j=-1..1），x 恒为中心
  // 派生量从实际数据读出，不硬编码材质名（roofMat 随 seed 变）
  const ridgePositions = [];
  for (let lz = 0; lz < 16; lz++) {
    const id = col.blocks[blockIndex(8, 15, lz)]; // lx=8 = x=8 中心
    if (id !== 0 && id !== stoneId) ridgePositions.push(lz);
  }
  assertEqual(ridgePositions.length, 3, `屋顶脊 3 格（实测 ${ridgePositions.join('/')}）`);
  assertEqual(ridgePositions[1] - ridgePositions[0], 1, '脊格连续');
});

test('generateCodeHouse：确定性 —— 同 seed 两次生成完全一致（Math.random 改 seededRandom）', () => {
  const reg = makeRegistry();
  const a = new ChunkColumn(0, 0);
  const b = new ChunkColumn(0, 0);
  generateCodeHouse(8, 10, 8, makeColumnSetter(a, reg), SEED);
  generateCodeHouse(8, 10, 8, makeColumnSetter(b, reg), SEED);
  let diff = 0;
  for (let i = 0; i < a.blocks.length; i++) if (a.blocks[i] !== b.blocks[i]) diff++;
  assertEqual(diff, 0, '两次生成逐格一致（mc-lite 用 Math.random 会不一致，本仓库须 seededRandom）');
});

test('generateCodeHouse：含玻璃窗（glass_block 在墙体中段）', () => {
  const reg = makeRegistry();
  const col = new ChunkColumn(0, 0);
  generateCodeHouse(8, 10, 8, makeColumnSetter(col, reg), SEED);
  const glassId = reg.idOf('glass_block');
  let glass = 0;
  for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
    for (let y = 8; y < 14; y++) if (col.blocks[blockIndex(lx, y, lz)] === glassId) glass++;
  }
  assertTrue(glass > 0, `墙体含 glass_block 窗（实测 ${glass}）`);
});

test('generateCodeHouse：材质随 seed 变化（wallMat/roofMat 不是常量）', () => {
  const reg = makeRegistry();
  // 两个不同 seed 生成的 house，墙体材质应可能不同（mc-lite 1/3 概率 bricks）
  const signatures = new Set();
  for (const seed of [12345, 999, 4242, 77777, 31337]) {
    const col = new ChunkColumn(0, 0);
    generateCodeHouse(8, 10, 8, makeColumnSetter(col, reg), seed);
    // 取 y+1 层墙体材质签名
    let sig = '';
    for (let lx = 3; lx < 14; lx++) for (let lz = 3; lz < 14; lz++) {
      const id = col.blocks[blockIndex(lx, 11, lz)];
      if (id) sig += reg.nameOf(id) + ',';
    }
    signatures.add(sig);
  }
  assertTrue(signatures.size > 1, `材质随 seed 变化（${signatures.size} 种签名）`);
});

// ==================== 端到端：完整 GEN 后撒布结构真的落地（Task 3）====================
//
// ⚠️ 这一组是**唯一能证明功能真的生效**的测试。上面的判定函数测试只证明「判定说会撒」，
// 不证明「方块真的写进了 column」。两者之间的链路有 4 个可能的静默失败点：
//   STRUCTURE_FILES 漏映射 → rasterize 静默 return / needTypes 漏预载 → cache 未命中
//   / footprint 漏配 → AABB 裁剪跳过 / 层序错 → 被后续阶段覆盖。
// 断言一律从**实际生成的方块数据**读出，不硬编码「被测代码写入的那个值」（§2.5 陷阱②）。

/** 跑完整 GEN（fillColumn + caves + applyStructures），与 Worker 的真实路径一致 */
async function genColumnFull(reg, cx, cz, seed = SEED) {
  const col = new ChunkColumn(cx, cz);
  fillColumn(col, seed, reg);
  carveCaves(col, seed, reg);
  await applyStructuresToColumn(col, seed, reg, layoutsFor(cx, cz, seed));
  return col;
}

/** 城市布局（region [0,0]）+ 其 3×3 邻域布局，与 StructureIndex 下发的查询域一致 */
function layoutsFor(cx, cz, seed = SEED) {
  const out = [];
  for (const key of neighborRegionKeys(cx, cz)) {
    const [rx, rz] = key.split(',').map(Number);
    out.push(computeRegionLayout(rx, rz, seed));
  }
  return out;
}

/**
 * ⚠️ **不能用「特征方块类型」判定撒布结构是否落地** —— 实测这些 JSON **共享方块类型**：
 * flowerBed 的 `azalea_flowers`/`azalea_leaves` 与 pavilion 重叠，`light_gray_cloth` 与
 * tallWell 重叠。故「column 里有多少个 azalea_flowers」这种断言在删掉 flowerBed 映射后
 * 仍会 PASS（pavilion 继续提供该方块）→ 断言恒真（实测踩坑，注入后全绿）。
 *
 * 正确判据 = **按候选点坐标**断言：结构写在 `y` 及以上（地形只到 `y-1`，城市残丘已被
 * `generateCity` 清除），故「候选点 footprint 范围内、y 及以上有非空气方块」是结构落地的
 * 充分证据，且每个候选点的断言互相独立。
 */
const SCATTER_Y_EXTENT = {
  // tallWell 曾是 51（2026-09-30 前）：JSON 里那个孤立 chest@(24,51,20) 把扫描范围撑到 y+51。
  // chest 已删（悬空数据异常），井体最高 normalized y=16 → 写入最高格 = cand.y+15，extent 取 16。
  flowerBed: 3, pavilion: 6, tallWell: 16, desertPyramid: 16,
  desertVillage: 12, uglyHouse: 13, tank: 9, house: 6, ship: 4,
};

/** 统计 column 内指定方块名的数量 */
function countBlocks(col, reg, names) {
  const ids = new Set(names.map((n) => reg.idOf(n)));
  let n = 0;
  for (let i = 0; i < col.blocks.length; i++) if (ids.has(col.blocks[i])) n++;
  return n;
}

/**
 * 撒布结构是否在候选点落地（坐标判据，见上文「不能用特征方块类型」）。
 *
 * 判据：候选点 footprint 范围内、`y` 及以上有非空气方块。地形只写到 `y-1`
 * （城市候选的 y = surfaceY+1，城市外候选的 y = h+1），且城市残丘已被 generateCity
 * 清除 → y 及以上出现方块只能是撒布结构写的。
 *
 * @param {Object} cand 候选 {x, y, z}
 * @param {string} type 撒布类型（查 SCATTER_FOOTPRINT + SCATTER_Y_EXTENT）
 * @param {(wx:number, y:number, wz:number) => number} get 取方块 id
 * @param {Set<number>} [ignoreIds] 不计入的方块 id —— **ship 必须传 water**：深海区落点上方
 *   全是水（id≠0），不排除的话判据恒 >0（实测踩坑：注入「CODE_GENERATORS 漏 ship」后仍全绿，
 *   无效负向验证）。水下区没有树（树只在陆地上），故排除 water 后剩下的 wood/planks/chest
 *   只能是 ship 写的 —— 判据可靠。
 * @returns {number} footprint 内 y 及以上的非空气方块数
 */
function countStructureBlocksAt(cand, type, get, ignoreIds) {
  const fp = SCATTER_FOOTPRINT[type];
  const extent = SCATTER_Y_EXTENT[type] || 6;
  let n = 0;
  for (let dx = -fp.halfX; dx <= fp.halfX; dx++) {
    for (let dz = -fp.halfZ; dz <= fp.halfZ; dz++) {
      for (let y = cand.y; y <= cand.y + extent; y++) {
        const id = get(cand.x + dx, y, cand.z + dz);
        if (id === 0) continue;
        if (ignoreIds && ignoreIds.has(id)) continue;
        n++;
      }
    }
  }
  return n;
}

/** column 局部取方块（越界返回 0） */
function makeGetter(col, cx, cz) {
  return (wx, y, wz) => {
    const lx = wx - cx * 16, lz = wz - cz * 16;
    if (lx < 0 || lx > 15 || lz < 0 || lz > 15 || y < -32 || y >= 96) return 0;
    return col.blocks[blockIndex(lx, y, lz)];
  };
}

test('端到端：城市里有 flowerBed/pavilion/tallWell 落地（真实 GEN 数据）', async () => {
  const reg = makeRegistry();
  const city = computeRegionLayout(0, 0, SEED).city;
  assertNotNull(city, 'city layout');
  // 从 region layout 的撒布候选里读出真实落点（不靠判定函数另算一遍 —— 那是同一份代码）
  const layout = computeRegionLayout(0, 0, SEED);
  const arr = layout.scatter.cityScatter;
  assertTrue(arr.length > 0, 'region layout 产出了城市撒布候选');

  // 按类型收集候选，挑落点密集处跑 GEN（撒布结构占地小，须扫多 column 才凑够）
  const byType = {};
  for (let i = 0; i < arr.length; i += 4) {
    const t = SCATTER_TYPES[arr[i + 3]];
    (byType[t] ||= []).push({ x: arr[i], y: arr[i + 1], z: arr[i + 2] });
  }
  for (const type of ['flowerBed', 'pavilion', 'tallWell']) {
    assertTrue((byType[type]?.length || 0) > 0, `${type} 候选存在（${byType[type]?.length || 0} 个）`);
  }

  // 逐候选验证落地（坐标判据）。column 缓存复用 —— 去重 column 会丢掉同 column 的其它候选，
  // 那些候选正是判定「该类型是否落地」的证据，丢了会让断言恒真（实测踩坑）。
  const colCache = new Map();
  const genAt = async (wx, wz) => {
    const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
    const key = `${cx},${cz}`;
    if (!colCache.has(key)) colCache.set(key, await genColumnFull(reg, cx, cz));
    return { col: colCache.get(key), cx, cz };
  };

  for (const type of ['flowerBed', 'pavilion', 'tallWell']) {
    let landed = 0, checked = 0;
    for (const c of byType[type].slice(0, 10)) {
      const { col, cx, cz } = await genAt(c.x, c.z);
      checked++;
      if (countStructureBlocksAt(c, type, makeGetter(col, cx, cz)) > 0) landed++;
    }
    assertTrue(landed > 0, `${type} 落地 ${landed}/${checked} 个候选点（${colCache.size} 个 column）`);
    // 落地率须高：撒布结构 AABB 相交判定与 footprint 一致，不该大面积落空
    assertTrue(landed / checked > 0.5, `${type} 落地率 ${(landed / checked * 100).toFixed(0)}% > 50%`);
  }
});

// —— pavilion 占地内不长城市树（v2.2，用户 2026-10-28：「不要跟其他实体有重叠」）——
//
// 根因：阶段 3 城市树在阶段 2.7 撒布**之后**跑，而 `makeColumnSetter` 对未注册名字是后写胜、
// **无占用格守卫** → 树冠直接把亭子屋顶打穿。
//
// ⚠️ **判据必须用差分/白名单，不能按方块名数**：`pavilion.json` 自身就含
// `leaves`(10) / `azalea_leaves`(6) / `azalea_flowers`(14) —— 拿这几个名字数会把 pavilion
// 自己的装饰叶当成「树穿进来了」（实测踩坑，错误读数 32 格）。这里用「pavilion.json 里
// 没出现过的树方块名」作判据。
test('端到端：pavilion 真实占地内没有任何「外来的」树方块', async () => {
  const reg = makeRegistry();
  const layout = computeRegionLayout(0, 0, SEED);
  const arr = layout.scatter.cityScatter;
  const pav = [];
  for (let i = 0; i < arr.length; i += 4) {
    if (SCATTER_TYPES[arr[i + 3]] === 'pavilion') pav.push({ x: arr[i], y: arr[i + 1], z: arr[i + 2] });
  }
  assertTrue(pav.length > 5, `须有足量 pavilion，否则断言无判别力：${pav.length}`);

  // pavilion 自己的 JSON 里出现的方块名 → 不能当作「树」的证据
  const { loadStructure } = await import('../gen/structures/structure-json.js');
  const ownData = await loadStructure('pavilion');
  const ownNames = new Set(ownData.blocks.map((b) => b.type));
  assertTrue(ownNames.has('leaves'),
    'pavilion.json 确实自带 leaves（否则下面的白名单是空集，断言失去意义）');
  const TREE_NAMES = ['wood', 'leaves', 'birch_wood', 'birch_leaves', 'jungle_wood',
    'azalea_leaves', 'azalea_flowers'];
  const foreignTreeNames = TREE_NAMES.filter((n) => !ownNames.has(n));
  assertTrue(foreignTreeNames.length > 0, `须有「外来的」树方块名可判：${foreignTreeNames.join(',')}`);
  const foreignIds = new Set(foreignTreeNames.map((n) => reg.idOf(n)).filter((id) => id > 0));

  const real = SCATTER_FOOTPRINT.pavilion.real;
  assertNotNull(real, 'pavilion 须有 real 真实包围盒');
  const colCache = new Map();
  let total = 0, pavWithTrees = 0, checked = 0;
  for (const p of pav.slice(0, 8)) {
    const cx = Math.floor(p.x / 16), cz = Math.floor(p.z / 16);
    const key = `${cx},${cz}`;
    if (!colCache.has(key)) colCache.set(key, await genColumnFull(reg, cx, cz));
    const col = colCache.get(key);
    const get = makeGetter(col, cx, cz);
    checked++;
    let inside = 0;
    for (let dx = real.minX; dx <= real.maxX; dx++) {
      for (let dz = real.minZ; dz <= real.maxZ; dz++) {
        for (let y = 0; y < 96; y++) {
          const id = get(p.x + dx, y, p.z + dz);
          if (id !== 0 && foreignIds.has(id)) inside++;
        }
      }
    }
    total += inside;
    if (inside) pavWithTrees++;
  }
  assertEqual(total, 0,
    `${checked} 个 pavilion 真实占地内不得有外来的树方块（实测修复前 297 格 / 39 个 pavilion）`);
  assertEqual(pavWithTrees, 0, '不得有任何 pavilion 被树打穿');
});

test('端到端：城市里有代码生成 house 落地（地基 stone + 窗 glass_block + chest）', async () => {
  const reg = makeRegistry();
  const layout = computeRegionLayout(0, 0, SEED);
  const arr = layout.scatter.cityScatter;
  const houses = [];
  for (let i = 0; i < arr.length; i += 4) {
    if (SCATTER_TYPES[arr[i + 3]] === 'house') houses.push({ x: arr[i], y: arr[i + 1], z: arr[i + 2] });
  }
  assertTrue(houses.length > 0, `城市 house 候选存在（${houses.length} 个）`);

  // 找一个落点：其 column 里应有 chest（house 的室内家具，自然地形不会出现）
  let chestFound = 0, glassFound = 0;
  const seen = new Set();
  for (const h of houses.slice(0, 12)) {
    const cx = Math.floor(h.x / 16), cz = Math.floor(h.z / 16);
    const key = `${cx},${cz}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const col = await genColumnFull(reg, cx, cz);
    chestFound += countBlocks(col, reg, ['chest']);
    glassFound += countBlocks(col, reg, ['glass_block']);
  }
  assertTrue(chestFound > 0, `house 落地证据：chest ${chestFound} 个（扫了 ${seen.size} 个 column）`);
  assertTrue(glassFound > 0, `house 落地证据：glass_block 窗 ${glassFound} 个`);
});

test('端到端：城市外草地有 house 落地（用户反馈的「草地上的房子」）', async () => {
  const reg = makeRegistry();
  const city = computeRegionLayout(0, 0, SEED).city;
  // 浅水高台（v2.11）的整形区内**不会**长散布结构（`apply.js` 阶段 2.7 的
  // `inShallowTarnFootprint` 剔除）—— 这些候选本身合法，只是被新地图占了位。
  //
  // ⚠️ **本用例必须把那些候选排除在取样外**（与 `apply.js` 同一判据 `inShallowTarnFootprint`，红线 1）：
  // v2.13 把湖收到 x≈718 后，城市外 house 候选带（x=597~707）正好落在整形区（半径 163）里 ——
  // 前 10 个里 **8 个**被剔除，剩下的 2 个早已被植被覆写 → 断言稳定 FAIL（实测 4/4 轮 2/10）。
  // 这不是地图的 bug，而是「取样口径没跟上新地图的占地」。
  const shallowAnchors = [computeShallowTarnAnchor(SEED)];
  // 收集城市外的全部 house 候选（region [1,0] 实测有 21 个）
  const outside = [];
  for (const [rx, rz] of [[1, 0], [0, 1], [-1, 0], [0, -1], [2, 0], [-2, 0]]) {
    const arr = computeRegionLayout(rx, rz, SEED).scatter.outsideScatter;
    for (let i = 0; i < arr.length; i += 4) {
      if (SCATTER_TYPES[arr[i + 3]] !== 'house') continue;
      const x = arr[i], z = arr[i + 2];
      if (x >= city.minX && x <= city.maxX && z >= city.minZ && z <= city.maxZ) continue;
      if (inShallowTarnFootprint(x, z, shallowAnchors)) continue;
      outside.push({ x, y: arr[i + 1], z, region: `${rx},${rz}` });
    }
  }
  assertTrue(outside.length > 0, `找到城市外草地 house 候选（${outside.length} 个）`);

  // ⚠️ 断言必须落在**可靠存活**的部件上：实测 house 的 chest/bookbox 有 16% 被植被覆写
  // （阶段 3 植被在阶段 2.7 之后跑、setBlock 无条件覆写）。这与 mc-lite 净结果一致 ——
  // mc-lite 的 fakeChunk.add 是「先写者胜」（WorldWorker.js:534-539），植被在列循环里先写、
  // 结构任务后执行，故家具同样会被植被吃掉。故只断言地基/屋顶/墙体（实测 100% 存活），
  // 家具跨多候选统计（不因单个候选撞上 16% 覆写而误判）。
  let foundationOk = 0, roofOk = 0, wallOk = 0, chestTotal = 0;
  const seen = new Set();
  for (const h of outside.slice(0, 10)) {
    const cx = Math.floor(h.x / 16), cz = Math.floor(h.z / 16);
    const key = `${cx},${cz}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const col = await genColumnFull(reg, cx, cz);
    const get = (wx, y, wz) => {
      const lx = wx - cx * 16, lz = wz - cz * 16;
      if (lx < 0 || lx > 15 || lz < 0 || lz > 15 || y < -32 || y >= 96) return 0;
      return col.blocks[blockIndex(lx, y, lz)];
    };
    // 地基：y-1 层 5×5 stone（mc-lite WorldWorker.js:2948）
    let stone = 0;
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
      if (get(h.x + i, h.y - 1, h.z + j) === reg.idOf('stone')) stone++;
    }
    if (stone === 25) foundationOk++;
    // 屋顶脊：y+5 三格非空
    let ridge = 0;
    for (let j = -1; j <= 1; j++) if (get(h.x, h.y + 5, h.z + j) !== 0) ridge++;
    if (ridge === 3) roofOk++;
    // 墙体：perimeter 任一格非空
    if (get(h.x + 2, h.y, h.z) !== 0 || get(h.x - 2, h.y, h.z) !== 0 ||
        get(h.x, h.y, h.z + 2) !== 0 || get(h.x, h.y, h.z - 2) !== 0) wallOk++;
    if (get(h.x + 1, h.y, h.z - 1) === reg.idOf('chest')) chestTotal++;
  }
  assertTrue(foundationOk > 0, `地基 5×5 stone 完整存活 ${foundationOk}/${seen.size} 个`);
  assertTrue(roofOk > 0, `屋顶脊 3 格完整存活 ${roofOk}/${seen.size} 个`);
  assertTrue(wallOk > 0, `墙体存活 ${wallOk}/${seen.size} 个`);
  // 家具跨多候选统计：实测单候选有 16% 被植被覆写（阶段 3 植被后写、setBlock 无条件覆写，
  // 与 mc-lite 净结果一致 —— mc-lite 的 fakeChunk.add 是「先写者胜」，植被在列循环里先写）。
  // 故只断言「多数存活」，不断言每个都存活。
  assertTrue(chestTotal > seen.size / 2, `chest 存活 ${chestTotal}/${seen.size}（多数未被植被覆写）`);
});

test('端到端：沙漠里有 desertPyramid 落地（groundSupport 支撑柱）', async () => {
  const reg = makeRegistry();
  let candidate = null;
  for (const [rx, rz] of [[1, 0], [0, 1], [-1, 0], [0, -1], [2, 0], [-2, 0], [1, 1], [-1, -1]]) {
    const layout = computeRegionLayout(rx, rz, SEED);
    const arr = layout.scatter.outsideScatter;
    for (let i = 0; i < arr.length; i += 4) {
      if (SCATTER_TYPES[arr[i + 3]] === 'desertPyramid') {
        candidate = { x: arr[i], y: arr[i + 1], z: arr[i + 2], region: `${rx},${rz}` };
        break;
      }
    }
    if (candidate) break;
  }
  assertNotNull(candidate, '找到 desertPyramid 候选（否则本测试恒真）');

  const cx = Math.floor(candidate.x / 16), cz = Math.floor(candidate.z / 16);
  const col = await genColumnFull(reg, cx, cz);
  // desert_pyramid.json 只有 sand + stone_bricks 两种类型；stone_bricks 是其特征
  const bricks = countBlocks(col, reg, ['stone_bricks']);
  assertTrue(bricks > 0, `desertPyramid 落地：stone_bricks ${bricks} 个 @ ${candidate.region}`);
});

test('端到端：撒布结构跨 column 无重复光栅化（同一候选在多 column 只写自己那部分）', async () => {
  const reg = makeRegistry();
  const layout = computeRegionLayout(0, 0, SEED);
  const arr = layout.scatter.cityScatter;
  // 找一个跨 column 的 pavilion（halfX=5 → 中心靠近 column 边界时会跨）
  let target = null;
  for (let i = 0; i < arr.length; i += 4) {
    if (SCATTER_TYPES[arr[i + 3]] !== 'pavilion') continue;
    const lx = ((arr[i] % 16) + 16) % 16;
    if (lx <= 5 || lx >= 10) { // 靠近边界 → 必跨 column
      target = { x: arr[i], y: arr[i + 1], z: arr[i + 2], lx };
      break;
    }
  }
  assertNotNull(target, '找到跨 column 的 pavilion（否则本测试恒真）');

  // 光栅化相邻两个 column，用**同一候选点**分别经两个 getter 计数：
  // 各 getter 只数得到本 column 内的方块（越界返回 0）→ 两边都非零即证明接缝已填充。
  //
  // ⚠️ **不断言「合计 ≤ 结构方块数」**：footprint 框内会数到**其它**结构的方块
  // （树 / 邻近撒布结构都可能在同一框内），实测 pavilion 框内数出 171 > 其 JSON 的 128。
  // 那是判据污染，不是重复光栅化 —— 「重复」结构上不可能：`makeColumnSetter` 对
  // lx/lz 越界直接 return（landmarks.js:271），每个 column 只能写自己那 16×16。
  const cx = Math.floor(target.x / 16), cz = Math.floor(target.z / 16);
  const neighborCx = target.lx <= 5 ? cx - 1 : cx + 1;
  const colA = await genColumnFull(reg, cx, cz);
  const colB = await genColumnFull(reg, neighborCx, cz);
  const a = countStructureBlocksAt(target, 'pavilion', makeGetter(colA, cx, cz));
  const b = countStructureBlocksAt(target, 'pavilion', makeGetter(colB, neighborCx, cz));
  assertTrue(a > 0 && b > 0, `两个 column 各有部分方块（A=${a} B=${b}），接缝无缺失`);
});

test('groundSupport 契约：只有 desertPyramid/desertVillage/uglyHouse 补支撑柱（mc-lite 口径）', () => {
  // ⚠️ 这条门控一度**无测试覆盖**：注入「误加 flowerBed」与「漏 desertPyramid」后测试仍全绿
  // （无效负向验证）。支撑柱效果在平地常常是 no-op（底层面块贴着地表 → 探到地表即停），
  // 故不能靠「数支撑柱方块」断言，必须直接钉**集合成员**契约。
  // mc-lite 实测：desertPyramid/desertVillage/uglyHouse 走 generateStructureWithGroundSupport
  // （WorldWorker.js:3085/3097/3283），flowerBed/pavilion/tallWell/tank 走 loader.generate（不补柱）。
  const withSupport = ['desertPyramid', 'desertVillage', 'uglyHouse'];
  const withoutSupport = ['flowerBed', 'pavilion', 'tallWell', 'tank'];
  for (const t of withSupport) {
    assertTrue(GROUND_SUPPORT_TYPES.has(t), `${t} 须补支撑柱（mc-lite 走 groundSupport）`);
  }
  for (const t of withoutSupport) {
    assertFalse(GROUND_SUPPORT_TYPES.has(t), `${t} 不得补支撑柱（mc-lite 走 loader.generate）`);
  }
});

test('城市外候选：陆地类型不在水下，ship 必须在水下（两类门控相反）', () => {
  // mc-lite 的 resolveLargeStaticStructureType 不查水位，会把房子/坦克放进水里。
  // mc-heavy 地形水下面积大，照搬会产出大量水下结构 → 观感明显错误，故陆地撒布加
  // h<=SEA_Y 门控。**但 ship 是有意的水下结构**（门控 h < -6，桅杆顶在水下 1~5 格）——
  // 两类门控方向相反，必须分别断言（§2.5 陷阱①：断言落在实际产出的候选上）。
  let landChecked = 0, landUnderwater = 0;
  let shipChecked = 0, shipUnderwater = 0;
  for (const [rx, rz] of [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1], [2, 0], [-2, 0]]) {
    const arr = computeRegionLayout(rx, rz, SEED).scatter.outsideScatter;
    for (let i = 0; i < arr.length; i += SCATTER_STRIDE) {
      // 候选 y = h+1 → 水下等价于 y <= SEA_Y+1
      const underwater = arr[i + 1] <= SEA_Y + 1;
      if (SCATTER_TYPES[arr[i + 3]] === 'ship') {
        shipChecked++;
        if (underwater) shipUnderwater++;
      } else {
        landChecked++;
        if (underwater) landUnderwater++;
      }
    }
  }
  assertTrue(landChecked > 0, `确有陆地候选（${landChecked} 个），否则断言恒真`);
  assertEqual(landUnderwater, 0, `${landChecked} 个陆地候选无一在水下`);
  assertTrue(shipChecked > 0, `确有 ship 候选（${shipChecked} 个），否则断言恒真`);
  assertEqual(shipUnderwater, shipChecked, `${shipChecked} 个 ship 候选全部在水下（沉船语义）`);
});

test('城市候选不按 region 裁剪 —— 跨区那部分城市装饰物仍产出', () => {
  // computeScatterCandidates 的口径差异①：城市 bounds 可跨 region（实测 seed=12345 时
  // bounds=[0,566]×[-166,400]，横跨 region [0,0] 与 [1,0]），若按 region 裁剪，
  // 跨区那部分城市装饰物会永久丢失。断言：候选必须存在 x 超出 region [0,0] 上界的点。
  const city = computeRegionLayout(0, 0, SEED).city;
  assertTrue(city.maxX > REGION_SIZE, `城市 maxX=${city.maxX} 确实超出 region [0,0] 的 ${REGION_SIZE}`);
  const arr = computeRegionLayout(0, 0, SEED).scatter.cityScatter;
  let beyond = 0, checked = 0;
  for (let i = 0; i < arr.length; i += 4) {
    checked++;
    if (arr[i] >= REGION_SIZE) beyond++;
  }
  assertTrue(checked > 0, `确有城市候选（${checked} 个）`);
  assertTrue(beyond > 0, `${beyond} 个候选落在 region [0,0] 之外（跨区装饰物未丢失）`);
});

// ==================== ship 沉船（M2 欠账补齐，mc-lite WorldWorker.js:988/:2987）====================

/** 扫 ship 候选：复现 computeScatterCandidates 的城市外循环门控（h<-6 + 概率 + 内圈） */
function collectShipCandidates(seed, range = 800) {
  const out = [];
  for (let wx = -range; wx < range; wx++) {
    for (let wz = -range; wz < range; wz++) {
      if (!safeForStructure(wx, wz)) continue;
      const h = generateHeight(wx, wz, seed);
      if (!rollShipScatter(wx, wz, h, seed)) continue;
      out.push({ x: wx, y: h + 1, z: wz, h });
    }
  }
  return out;
}

test('ship 概率口径：与 house 同为 0.001（mc-lite 口径，不降密度）', () => {
  // 关系型断言（不硬编码数值 —— §2.5 陷阱②）。ship 不降密度的理由：opaque+cutout 方块、
  // 数量少（109 个/全图、每 column ≤1），不吃 cutout 预算、不是 genP95 大头。
  assertEqual(OUTSIDE_SCATTER_CHANCE.ship, OUTSIDE_SCATTER_CHANCE.house,
    'ship 与 house 同概率（mc-lite 两者都是 0.001）');
  assertTrue(OUTSIDE_SCATTER_CHANCE.ship > OUTSIDE_SCATTER_CHANCE.desertPyramid,
    'ship 比沙漠结构更密');
});

test('ship 只在深海出现（h < SHIP_DEEP_SEA_Y，门控实测有效）', () => {
  // ⚠️ 断言落在**实际命中点**上（§2.5 陷阱①）。若改成按判定函数的参数筛点，
  // 注入「放宽门控」的缺陷不会 FAIL。
  const hits = collectShipCandidates(SEED);
  assertTrue(hits.length > 0, `确有 ship 命中（${hits.length} 个），否则断言恒真`);
  let leaked = 0;
  for (const c of hits) if (c.h >= SHIP_DEEP_SEA_Y) leaked++;
  assertEqual(leaked, 0, `${hits.length} 个命中点全部在深海（h < ${SHIP_DEEP_SEA_Y}）`);
  // 深海门控须严于海平面 —— 否则 ship 会出现在浅水/岸上，不是「沉船」
  assertTrue(SHIP_DEEP_SEA_Y < SEA_Y, `SHIP_DEEP_SEA_Y(${SHIP_DEEP_SEA_Y}) 低于海平面(${SEA_Y})`);
});

test('ship 不看 biome/occupied —— 与陆地撒布不同（mc-lite 口径，勿「补齐」门控）', () => {
  // mc-lite 的 ship 门控只有 h + 概率 + safeForStructure（WorldWorker.js:988），
  // **不看 biome、不看 occupied**。实测 109 个命中里有 11 个（10%）带植被、分布在 4 个 biome，
  // 所以这条断言不是恒真：若给 ship 补上 occupied/biome 门控，命中数会掉。
  const hits = collectShipCandidates(SEED);
  assertTrue(hits.length > 0, `确有 ship 命中（${hits.length} 个）`);

  // 带植被的命中点必须保留（不看 occupied）
  let withPlant = 0;
  const biomes = new Set();
  for (const c of hits) {
    const biome = getBiome(c.x, c.z, SEED);
    biomes.add(biome);
    if (rollVegetation(c.x, c.z, biome, SEED).plant) withPlant++;
  }
  assertTrue(withPlant > 0, `${withPlant} 个 ship 命中点带植被 —— 证明不看 occupied（否则会掉到 ${hits.length - withPlant}）`);
  assertTrue(biomes.size > 1, `ship 出现在 ${biomes.size} 个 biome（${[...biomes].join('/')}）—— 证明不看 biome`);

  // 同一坐标换 biome 判定不变（biome 不是判据）
  const probe = hits[0];
  const sameH = probe.h;
  const r1 = rollShipScatter(probe.x, probe.z, sameH, SEED);
  const r2 = rollShipScatter(probe.x, probe.z, sameH, SEED + 0); // 同 seed 同 h
  assertEqual(r1, r2, '判定只依赖 (x,z,h,seed)，不依赖 biome');
});

test('ship 判定确定性 —— 同 seed 两次一致（红线 2）', () => {
  let mismatch = 0;
  for (let wx = -400; wx < 400; wx += 3) {
    for (let wz = -400; wz < 400; wz += 3) {
      const h = generateHeight(wx, wz, SEED);
      const a = rollShipScatter(wx, wz, h, SEED);
      const b = rollShipScatter(wx, wz, h, SEED);
      if (a !== b) mismatch++;
    }
  }
  assertEqual(mismatch, 0, '判定完全确定');
});

test('ship 判定：浅水与陆地一律不撒（h >= SHIP_DEEP_SEA_Y）', () => {
  let leaked = 0, checked = 0;
  for (let wx = -300; wx < 300; wx += 2) {
    for (let wz = -300; wz < 300; wz += 2) {
      // 用固定高度扫，不依赖真实地形（覆盖全部高度区间）
      for (const h of [SHIP_DEEP_SEA_Y, SHIP_DEEP_SEA_Y + 1, SEA_Y, 0, 10]) {
        checked++;
        if (rollShipScatter(wx, wz, h, SEED)) leaked++;
      }
    }
  }
  assertTrue(checked > 0, '确有采样点');
  assertEqual(leaked, 0, `h >= ${SHIP_DEEP_SEA_Y} 的点一律不撒`);
});

test('generateCodeShip：桅杆 5 格 wood（y..y+4）+ chest 在 (x, y+1, z+2)', () => {
  const reg = makeRegistry();
  const col = new ChunkColumn(0, 0);
  const setBlock = makeColumnSetter(col, reg);
  const y = 5;
  generateCodeShip(8, y, 8, setBlock);
  const woodId = reg.idOf('wood');

  // 桅杆：mc-lite WorldWorker.js:2995 `for (let i = 0; i < 5; i++) chunk.add(x, y+i, z, 'wood')`
  for (let i = 0; i < 5; i++) {
    assertEqual(col.blocks[blockIndex(8, y + i, 8)], woodId, `桅杆 y+${i} = wood`);
  }
  assertEqual(col.blocks[blockIndex(8, y + 5, 8)], 0, '桅杆只有 5 格（y+5 是空气）');

  // chest：mc-lite WorldWorker.js:2996 `chunk.add(x, y + 1, z + 2, 'chest')`
  assertEqual(col.blocks[blockIndex(8, y + 1, 10)], reg.idOf('chest'), 'chest 在 (x, y+1, z+2)');
});

test('generateCodeShip：船体外围 wood/planks 双层 + 甲板 planks', () => {
  const reg = makeRegistry();
  const col = new ChunkColumn(0, 0);
  const setBlock = makeColumnSetter(col, reg);
  const y = 5;
  generateCodeShip(8, y, 8, setBlock);
  const woodId = reg.idOf('wood'), planksId = reg.idOf('planks');

  // 外围（|dx|===2 || |dz|===3）：y+1 = wood，y+2 = planks（mc-lite :2989-2991）
  // 取 (dx=-2, dz=0) 与 (dx=0, dz=-3) 两个外围点验证
  for (const [dx, dz] of [[-2, 0], [0, -3], [2, 3], [-2, -3]]) {
    assertEqual(col.blocks[blockIndex(8 + dx, y + 1, 8 + dz)], woodId, `外围 (${dx},${dz}) y+1 = wood`);
    assertEqual(col.blocks[blockIndex(8 + dx, y + 2, 8 + dz)], planksId, `外围 (${dx},${dz}) y+2 = planks`);
  }

  // 内部（非外围）：y = planks（甲板，mc-lite :2993）
  // 取 (dx=-1, dz=0) —— 内部点
  assertEqual(col.blocks[blockIndex(7, y, 8)], planksId, '甲板 y = planks');

  // 占地边界：dx±2 / dz±3 之外无方块
  assertEqual(col.blocks[blockIndex(8 + 3, y + 1, 8)], 0, 'dx=+3 越界无方块');
  assertEqual(col.blocks[blockIndex(8, y + 1, 8 + 4)], 0, 'dz=+4 越界无方块');
});

test('generateCodeShip：确定性 —— 无 Math.random（与 generateCodeHouse 的偏离不同）', () => {
  // mc-lite 的 ship 几何**不含 Math.random**（对比 house 的材质/烟囱随机），
  // 故 ship 无需 seededRandom 替代 —— 但这条断言钉住「不引入随机材质」。
  const reg = makeRegistry();
  const a = new ChunkColumn(0, 0);
  const b = new ChunkColumn(0, 0);
  generateCodeShip(8, 5, 8, makeColumnSetter(a, reg));
  generateCodeShip(8, 5, 8, makeColumnSetter(b, reg));
  let diff = 0;
  for (let i = 0; i < a.blocks.length; i++) if (a.blocks[i] !== b.blocks[i]) diff++;
  assertEqual(diff, 0, '两次生成逐格一致');
});

test('契约：CODE_GENERATED_SCATTER_TYPES 是预载清单与门禁的唯一派生基准', () => {
  // ⚠️ 这条契约防止一个真实的静默失败：ship/house 是代码生成（无 JSON），
  // 若派生基准写成「排除 house」而不是「排除全部代码生成类型」，门禁会要求 ship 有
  // JSON 映射 + 磁盘文件 → 误报；反之若 ship 没被识别为代码生成 → 走 rasterizeStructure
  // → cache 未命中 → **沉船静默消失**（方块层面看不出差别，实测踩过同类坑）。
  assertTrue(CODE_GENERATED_SCATTER_TYPES.includes('house'), 'house 是代码生成类型');
  assertTrue(CODE_GENERATED_SCATTER_TYPES.includes('ship'), 'ship 是代码生成类型');
  assertTrue(SCATTER_TYPES.includes('ship'), 'ship 在 SCATTER_TYPES 里');
  assertFalse(SCATTER_JSON_TYPES.includes('ship'), 'ship 不在预载清单（无 JSON）');
  assertFalse(SCATTER_JSON_TYPES.includes('house'), 'house 不在预载清单（无 JSON）');
  // 派生关系：JSON 清单 = SCATTER_TYPES − 代码生成类型
  const expected = SCATTER_TYPES.filter((t) => !CODE_GENERATED_SCATTER_TYPES.includes(t));
  assertDeepEqual([...SCATTER_JSON_TYPES], expected, '预载清单从 SCATTER_TYPES 派生（红线 1）');
});

test('端到端：ship 真落地（真实 GEN 数据，桅杆判据）', async () => {
  const reg = makeRegistry();
  // 从 region layout 的候选数组里读实际 ship 落点（不靠判定函数另算 —— 那是同一份代码）
  const ships = [];
  for (const [rx, rz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0]]) {
    const arr = computeRegionLayout(rx, rz, SEED).scatter.outsideScatter;
    for (let i = 0; i < arr.length; i += SCATTER_STRIDE) {
      if (SCATTER_TYPES[arr[i + 3]] === 'ship') ships.push({ x: arr[i], y: arr[i + 1], z: arr[i + 2] });
    }
  }
  assertTrue(ships.length > 0, `region layout 产出了 ship 候选（${ships.length} 个），否则断言恒真`);

  // ⚠️ **取样必须按生产口径过滤城市 bounds 内的船**：城市外撒布在城市内一律不落地
  // （上游 `if (inCity)/else` 互斥，见阶段 2.7 的注释）。实测 seed 12345 的 60 个 ship
  // 候选中有 7 个落在城内 —— 那些**本来就不会、也不应该**落地（下面验证的是「船真的
  // 建成」，不是「船没落地」）；不过滤会让落地率被拉低 50%+ → 假失败（实测踩坑）。
  const city = computeRegionLayout(0, 0, SEED).city;
  const shipsOutsideCity = ships.filter((s) => !inCityBounds(s.x, s.z, city));
  assertTrue(shipsOutsideCity.length >= 10,
    `城外 ship 候选 ${shipsOutsideCity.length} 个（共 ${ships.length}，城内的由②的口径排除）`);

  // ⚠️ **不能用 footprint 范围的坐标判据**：ship footprint 5×7 覆盖多格，每格地形高度不同
  // （有些高到 y+3），海底的 clay/sand/end_stone 会落进扫描范围 → 判据恒 >0（实测踩坑：
  // 注入「CODE_GENERATORS 漏 ship」后仍全绿，无效负向验证）。排除 water 也不够。
  //
  // 正确判据 = **桅杆中心列** `(x, y..y+4, z)` 的 5 格 wood：门控 h<-6 保证中心列地形顶
  // ≤ y-1，桅杆必在地形之上；水下无树（树只在陆地），故这 5 格只能是 ship 写的。
  // 若 CODE_GENERATORS 漏 ship → 走 rasterizeStructure('ship') → cache 未命中 → 桅杆 wood
  // 缺失 → 判据正确 FAIL。chest 在 (x,y+1,z+2) 同样干净（地形不写 chest、水下无 house）。
  const woodId = reg.idOf('wood'), chestId = reg.idOf('chest');
  const colCache = new Map();
  let mastOk = 0, chestOk = 0, checked = 0;
  for (const s of shipsOutsideCity.slice(0, 10)) {
    const cx = Math.floor(s.x / 16), cz = Math.floor(s.z / 16);
    const key = `${cx},${cz}`;
    if (!colCache.has(key)) colCache.set(key, await genColumnFull(reg, cx, cz));
    const col = colCache.get(key);
    const get = makeGetter(col, cx, cz);
    checked++;
    // 桅杆：中心列 y..y+4 全 wood
    let mast = 0;
    for (let i = 0; i < 5; i++) if (get(s.x, s.y + i, s.z) === woodId) mast++;
    if (mast === 5) mastOk++;
    if (get(s.x, s.y + 1, s.z + 2) === chestId) chestOk++;
  }
  assertTrue(mastOk > 0, `ship 桅杆落地 ${mastOk}/${checked} 个候选点（${colCache.size} 个 column）`);
  assertTrue(chestOk > 0, `ship 货箱落地 ${chestOk}/${checked} 个候选点`);
  assertTrue(mastOk / checked > 0.5, `桅杆落地率 ${(mastOk / checked * 100).toFixed(0)}% > 50%`);
});

test('端到端：撒布结构确定性 —— 同 seed 两次 GEN 结果逐格一致（红线 2）', async () => {
  const reg = makeRegistry();
  const layout = computeRegionLayout(0, 0, SEED);
  const arr = layout.scatter.cityScatter;
  assertTrue(arr.length > 0, '有撒布候选');
  const cx = Math.floor(arr[0] / 16), cz = Math.floor(arr[2] / 16);
  const colA = await genColumnFull(reg, cx, cz);
  const colB = await genColumnFull(reg, cx, cz);
  let diff = 0;
  for (let i = 0; i < colA.blocks.length; i++) if (colA.blocks[i] !== colB.blocks[i]) diff++;
  assertEqual(diff, 0, '两次 GEN 逐格一致');
});

// ==================== 城市 house 落位：底部必须着地（用户报告「房子飘在空中」）====================
//
// 两个独立成因（实测 5 seed，均为「撒布结构」层落地起就有、非近期引入）：
//   ① 城市外撒布（seed+4 house 等）**从不排除城市 bounds** —— scatter.js 的注释承诺
//      「由 apply.js 在城市 bounds 过滤」，但 apply.js 阶段 2.7 从未实现 → 落点 y 用自然
//      地形高度、落点却在小地表被压平/抬高的城市里 → 悬空（实测悬空率 37%~90%，最高 15 格）。
//      mc-lite 是 `if (inCity) { ... } else { 城市外撒布 }` **互斥**（WorldWorker.js:793
//      / :1084-1086），本仓库移植时两路都跑了 —— 偏离根因。
//   ② 城市 filler house 只在**中心点**取城市地表高度，而城市地表在 5×5 占地内有 1~2 格起伏
//      → 四周低一格的地基悬空（实测悬空率 0~3%，最高 5 格）。
//
// 修法（均在候选层，单点权威）：
//   ① `computeScatterCandidates` 的城市外循环先剔除「候选点在城市 bounds 内」的点。
//   ② house 落位改为 5×5 占地**最低**城市地表 + 1，并加两个门控：占地必须全在城内、
//      占地内地表高差 ≤ HOUSE_MAX_SURFACE_SPAN（否则落哪都一半悬空一半埋没）。

/** 城市外循环应排除的城市 bounds 判据（与 scatter.js 的实现同源，测试侧不另写一份） */
function inCityBounds(wx, wz, city) {
  return wx >= city.minX && wx <= city.maxX && wz >= city.minZ && wz <= city.maxZ;
}

test('城市外撒布：城市 bounds 内的候选一律不落地（① 的根因，5 seed）', async () => {
  // 断言落在**真实 GEN 结果**上而非候选数组：城市 bounds 可跨 region
  // （seed=12345 bounds=[0,566]×[-166,400]，与 region [1,0] 相交），只有 apply.js 拿得到
  // cityLayout —— 那里是过滤的唯一权威（拿不到 city 的 region 候选在那里被判）。
  //
  // 判据 = **差分**：把「城市 bounds 内的城市外候选」从 layout 里剔掉再跑一遍 GEN，
  // 两边方块必须**逐格相同** —— 即「过滤生效」等价于「这些候选根本没被生成」。
  //
  // 为什么不用「特征方块」判据：实测 uglyHouse 的方块**全部与其它城市结构共享**
  // （dark_planks 是城市 house 的屋顶材质，82/152 个 house 用它；vertical_pillar /
  // handrailA / cobble*_step 也被 big_house/pavilion/white_tower 等用）→ 「数到该方块」
  // 会把别的结构的方块算进来，判据失真（实测踩坑：uglyHouse 注入后仍全绿）。
  // 差分判据不依赖任何方块类型，也不可能被污染。
  const reg = makeRegistry();

  for (const seed of [SEED, 424242, 777, 20260820, 31337]) {
    const city = computeRegionLayout(0, 0, seed).city;
    assertNotNull(city, `seed ${seed} 有城市布局`);

    // 收集本 column 查询域会用到的 layouts；同时造一份「城内城市外候选已剔除」的副本
    const layouts = layoutsFor(0, 0, seed);
    let dropped = 0;
    const filtered = layouts.map((l) => {
      if (!l.scatter) return l;
      const keep = [];
      const arr = l.scatter.outsideScatter;
      for (let i = 0; i < arr.length; i += SCATTER_STRIDE) {
        if (inCityBounds(arr[i], arr[i + 2], city)) { dropped++; continue; }
        keep.push(arr[i], arr[i + 1], arr[i + 2], arr[i + 3]);
      }
      return { ...l, scatter: { ...l.scatter, outsideScatter: Int32Array.from(keep) } };
    });
    assertTrue(dropped > 0,
      `seed ${seed} 确有无过滤时会落地的城内候选（${dropped} 个），否则差分判据恒真`);

    // 差分需要覆盖这些候选所在的 column（它们可能不止一个 column）
    const colsToCheck = new Set(['0,0']);
    for (const l of layouts) {
      const arr = l.scatter && l.scatter.outsideScatter;
      if (!arr) continue;
      for (let i = 0; i < arr.length; i += SCATTER_STRIDE) {
        if (!inCityBounds(arr[i], arr[i + 2], city)) continue;
        const cx = Math.floor(arr[i] / 16), cz = Math.floor(arr[i + 2] / 16);
        const key = `${cx},${cz}`;
        if (colsToCheck.size < 12) colsToCheck.add(key);
      }
    }

    for (const key of colsToCheck) {
      const [cx, cz] = key.split(',').map(Number);
      const colReal = new ChunkColumn(cx, cz);
      fillColumn(colReal, seed, reg);
      carveCaves(colReal, seed, reg);
      await applyStructuresToColumn(colReal, seed, reg, layouts);

      const colRef = new ChunkColumn(cx, cz);
      fillColumn(colRef, seed, reg);
      carveCaves(colRef, seed, reg);
      await applyStructuresToColumn(colRef, seed, reg, filtered);

      let diff = 0, firstDiff = null;
      for (let i = 0; i < colReal.blocks.length; i++) {
        if (colReal.blocks[i] === colRef.blocks[i]) continue;
        diff++;
        if (!firstDiff) {
          const y = (i % 1024) + (-32); // blockIndex(x,y,z) = (y+32)*256 + z*16 + x → 先取余再拆
          firstDiff = `idx=${i} 实际=${reg.nameOf(colReal.blocks[i])} 期望=${reg.nameOf(colRef.blocks[i])} (idx%1024=${i % 1024} → y≈${y})`;
        }
      }
      assertEqual(diff, 0,
        `seed ${seed} column(${cx},${cz}): 应用层的城市 bounds 过滤没有生效 —— `
        + `与「城内候选不存在」的参考世界差 ${diff} 格（${firstDiff}）。`
        + `差异来自城内城市外结构：它们用自然地形高度定 y，而城内地面已被 generateCity 整形 → 悬空或埋入。`);
    }
  }
});

test('城市 filler house 落位：y = 5×5 占地最低城市地表 + 1（② 的根因）', () => {
  // 断言落在**真实候选数组**上：对每个 house 候选，重新算它的占地面最低城市地表，
  // 比较候选 y。修复前 y = 中心点地表 + 1，占地面起伏时比最低值高 1~4 格 → 真 FAIL。
  for (const seed of [SEED, 424242, 777, 20260820, 31337]) {
    const city = computeRegionLayout(0, 0, seed).city;
    const arr = computeRegionLayout(0, 0, seed).scatter.cityScatter;
    const fp = SCATTER_FOOTPRINT.house;
    let checked = 0, mismatch = 0;
    const samples = [];
    for (let i = 0; i < arr.length; i += SCATTER_STRIDE) {
      if (SCATTER_TYPES[arr[i + 3]] !== 'house') continue;
      const x = arr[i], y = arr[i + 1], z = arr[i + 2];
      let lowest = Infinity;
      for (let dx = -fp.halfX; dx <= fp.halfX; dx++) {
        for (let dz = -fp.halfZ; dz <= fp.halfZ; dz++) {
          const info = getCityInfo(x + dx, z + dz, city);
          if (!info) continue;   // 出界格由下一个用例负责（本该已被剔除）
          lowest = Math.min(lowest, getCityFinalSurfaceY(x + dx, z + dz, info, seed));
        }
      }
      if (lowest === Infinity) continue;
      checked++;
      if (y !== lowest + 1) {
        mismatch++;
        if (samples.length < 4) samples.push(`(${x},${z}) y=${y} 应为 ${lowest + 1}`);
      }
    }
    assertTrue(checked > 0, `seed ${seed} 确有城市 house 候选（${checked} 个）`);
    assertEqual(mismatch, 0,
      `seed ${seed}: ${checked} 个 house 候选中 ${mismatch} 个落位不是「占地最低地表 + 1」—— ${samples.join(' ')}`);
  }
});

test('城市 filler house 门控：占地必须全在城内、且占地内地表高差 ≤ 阈值', () => {
  // 两个门控是「取最低地表」的必要条件（实测缺一不可）：
  //  · 占地出界 → 出界那格地面是自然地形（可高 15 格）→ 按最低城市地表落位会把房子埋掉
  //  · 高差过大 → 过渡带陡台阶，落哪都一半悬空一半埋没
  // 修复前两个门控都不存在 → 真 FAIL（5 seed 共 12~16 个违规候选）。
  let outOfBounds = 0, tooSteep = 0, checked = 0;
  const samples = [];
  for (const seed of [SEED, 424242, 777, 20260820, 31337]) {
    const city = computeRegionLayout(0, 0, seed).city;
    const arr = computeRegionLayout(0, 0, seed).scatter.cityScatter;
    const fp = SCATTER_FOOTPRINT.house;
    for (let i = 0; i < arr.length; i += SCATTER_STRIDE) {
      if (SCATTER_TYPES[arr[i + 3]] !== 'house') continue;
      const x = arr[i], z = arr[i + 2];
      checked++;
      let minY = Infinity, maxY = -Infinity, outside = 0;
      for (let dx = -fp.halfX; dx <= fp.halfX; dx++) {
        for (let dz = -fp.halfZ; dz <= fp.halfZ; dz++) {
          const info = getCityInfo(x + dx, z + dz, city);
          if (!info) { outside++; continue; }
          const f = getCityFinalSurfaceY(x + dx, z + dz, info, seed);
          minY = Math.min(minY, f); maxY = Math.max(maxY, f);
        }
      }
      if (outside > 0) {
        outOfBounds++;
        if (samples.length < 6) samples.push(`出界 seed=${seed} (${x},${z}) outside=${outside}`);
        continue;
      }
      const span = maxY - minY;
      if (span > HOUSE_MAX_SURFACE_SPAN) {
        tooSteep++;
        if (samples.length < 6) samples.push(`陡 seed=${seed} (${x},${z}) span=${span}`);
      }
    }
  }
  assertTrue(checked > 0, `确有城市 house 候选（${checked} 个）`);
  assertEqual(outOfBounds, 0, `${checked} 个候选中 ${outOfBounds} 个占地伸出城市 bounds —— ${samples.join(' ')}`);
  assertEqual(tooSteep, 0, `${checked} 个候选中 ${tooSteep} 个占地内地表高差 > ${HOUSE_MAX_SURFACE_SPAN} —— ${samples.join(' ')}`);
});

test('端到端：城市 bounds 内的 house 地基正下方必须实心（用户报告的症状）', async () => {
  // ⚠️ 这是**唯一能证明用户症状消失**的断言，且它是唯一覆盖两个成因交点的用例：
  // 只断言候选数组的形状（上面三条）无法证明方块真的落在地面上 —— 中间还有
  // footprint 裁剪 / 层序 / 覆盖等链路。
  //
  // 判据：位于城市 bounds 内的 house，其 5×5 地基格（y-1 层 stone）的**正下方一格必须非空气**。
  // 修复前实测 12345 有 12 个 house 悬空（最大 9 格）→ 真 FAIL。
  //
  // ⚠️ **必须抽样**（不是懒）：全量扫描 5 seed 需 ~800 个 column 的完整 GEN，
  // 实测单条用例 **42.8s** → 把 `harness.spec.mjs` 的 30s 窗口整体撑破（自己把门禁变成恒红）。
  // 抽样也**不能拍脑袋取前 N** —— 那可能一个高风险位置都没采到。这里按
  // 「旧口径（中心点地表）会造成多大悬空」**降序**取前 `E2E_SAMPLE` 个：
  // 差值 > 0 的位置正是修复前真悬空的地方，所以**修复前这批样本必然全 FAIL**，
  // 判别力由抽样口径保证、不靠运气。全量覆盖由上面「落位 = 占地最低地表 + 1」那条用例
  // 负责（5 seed 全部 house，纯函数、0.4s）。
  const E2E_SAMPLE = 12;
  const SEEDS_E2E = [SEED, 20260820];   // 12345 = 默认 seed；20260820 = 修复前悬空最深的（15 格）
  const reg = makeRegistry();
  const stoneId = reg.idOf('stone');

  for (const seed of SEEDS_E2E) {
    const layout = computeRegionLayout(0, 0, seed);
    const city = layout.city;
    const fp = SCATTER_FOOTPRINT.house;
    const houses = [];
    // ⚠️ **只取城市自己的撒布（cityScatter）**：城市外撒布（outsideScatter）落在城内的
    // 候选**本就不应该落地**（上游互斥，本次修复的正是这个）—— 把它们算进「应当落地」
    // 会把修复本身判成缺陷（实测踩坑：house@363,0,56 就是被正确过滤掉的一条，
    // 但它跑进了抽样 → 「地基 stone 一格都没落到本 column」假 FAIL）。
    const arr = layout.scatter.cityScatter;
    for (let i = 0; i < arr.length; i += SCATTER_STRIDE) {
      if (SCATTER_TYPES[arr[i + 3]] !== 'house') continue;
      const x = arr[i], y = arr[i + 1], z = arr[i + 2];
      if (!inCityBounds(x, z, city)) continue;
      // 旧口径（中心点地表）相对新落位（占地最低 + 1）会多悬空几格 = 该位置的悬空风险
      const centerInfo = getCityInfo(x, z, city);
      let lowest = Infinity;
      for (let dx = -fp.halfX; dx <= fp.halfX; dx++) {
        for (let dz = -fp.halfZ; dz <= fp.halfZ; dz++) {
          const info = getCityInfo(x + dx, z + dz, city);
          if (info) lowest = Math.min(lowest, getCityFinalSurfaceY(x + dx, z + dz, info, seed));
        }
      }
      const risk = (!centerInfo || lowest === Infinity)
        ? 0
        : (getCityFinalSurfaceY(x, z, centerInfo, seed) + 1) - (lowest + 1);
      houses.push({ src: 'city', x, y, z, risk });
    }
    assertTrue(houses.length > 0, `seed ${seed} 城市内确有 house（${houses.length} 个），否则断言恒真`);

    houses.sort((a, b) => b.risk - a.risk);
    const sample = houses.slice(0, E2E_SAMPLE);
    const riskyInSample = sample.filter((h) => h.risk > 0).length;
    assertTrue(riskyInSample > 0,
      `seed ${seed} 抽样 ${sample.length} 个里有 ${riskyInSample} 个是旧口径会悬空的位置`
      + `（否则抽样口径失效，本用例会变成恒绿）`);

    const colCache = new Map();
    const floating = [];
    for (const h of sample) {
      const cx = Math.floor(h.x / 16), cz = Math.floor(h.z / 16);
      const key = `${cx},${cz}`;
      if (!colCache.has(key)) colCache.set(key, await genColumnFull(reg, cx, cz, seed));
      const col = colCache.get(key);
      const get = makeGetter(col, cx, cz);
      let worst = 0, worstCell = null, baseCells = 0;
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          const wx = h.x + dx, wz = h.z + dz;
          if (get(wx, h.y - 1, wz) !== stoneId) continue;   // 只判本 column 写的地基格
          baseCells++;
          if (get(wx, h.y - 2, wz) !== 0) continue;         // 地基下方是实心 → 没问题
          // 悬空：向下数空气格，直到遇到实心或出世界
          let gap = 0;
          for (let y = h.y - 2; y > -32 && get(wx, y, wz) === 0; y--) gap++;
          if (gap > worst) { worst = gap; worstCell = `(${wx},${wz}) 下方 ${gap} 格空气`; }
        }
      }
      assertTrue(baseCells > 0,
        `seed ${seed} house@${h.x},${h.y},${h.z} 的地基 stone 一格都没落到本 column（结构未落地）`);
      if (worst > 0) floating.push(`${h.src}@${h.x},${h.y},${h.z} ${worstCell}（risk=${h.risk}）`);
    }
    assertEqual(floating.length, 0,
      `seed ${seed}: 抽样 ${sample.length} 个城内 house 中 ${floating.length} 个底部悬空 ——${floating.slice(0, 6).join(' / ')}`);
  }
});
