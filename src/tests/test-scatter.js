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
import { assertEqual, assertTrue, assertFalse, assertNotNull } from './assert.js';
import {
  CITY_SCATTER_CHANCE, OUTSIDE_SCATTER_CHANCE,
  safeForStructure, rollCityScatter, rollOutsideScatter, generateCodeHouse, SCATTER_TYPES,
} from '../gen/structures/scatter.js';
import { computeRegionLayout, neighborRegionKeys } from '../gen/structures/structure-layout.js';
import { applyStructuresToColumn } from '../gen/structures/apply.js';
import { fillColumn } from '../gen/terrain.js';
import { carveCaves } from '../gen/caves.js';
import { getCityInfo, isPointNearCityStructure } from '../gen/structures/city-layout.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { makeColumnSetter, getCityFinalSurfaceY } from '../gen/structures/landmarks.js';
import { rollCityTree } from '../gen/structures/vegetation.js';
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

test('城市撒布概率口径：pavilion = flowerBed×6，tallWell = flowerBed×3（mc-lite 派生关系）', () => {
  // mc-lite WorldWorker.js:92-93 —— 不是独立常量，是从 flowerBed 派生的倍数
  assertEqual(CITY_SCATTER_CHANCE.pavilion, CITY_SCATTER_CHANCE.flowerBed * 6, 'pavilion 是 flowerBed×6');
  assertEqual(CITY_SCATTER_CHANCE.tallWell, CITY_SCATTER_CHANCE.flowerBed * 3, 'tallWell 是 flowerBed×3');
  assertTrue(CITY_SCATTER_CHANCE.flowerBed > 0, 'flowerBed 概率为正');
});

test('城市外撒布概率口径：大 JSON 已减半（有意偏离 mc-lite，守 genP95 预算）', () => {
  // mc-lite WorldWorker.js:142-143 是 desertPyramid = desertVillage = 0.00016。
  // 本仓库**有意打破**该关系：desertVillage(1181 方块)/uglyHouse(719) 是 GEN 光栅化大头，
  // mc-lite 概率会让 structure-gen 的 p95 撞破 8ms 冻结预算，故两者减半、desertPyramid 不动
  // （它走 groundSupport，方块少，不是 p95 大头）。钉住「大 JSON 比 desertPyramid 更稀」这条
  // 新关系式（关系型断言，不硬编码数值 —— §2.5 陷阱②）。
  assertTrue(OUTSIDE_SCATTER_CHANCE.desertVillage < OUTSIDE_SCATTER_CHANCE.desertPyramid,
    'desertVillage 已减半 → 比 desertPyramid 更稀（有意偏离）');
  assertTrue(OUTSIDE_SCATTER_CHANCE.uglyHouse < OUTSIDE_SCATTER_CHANCE.desertVillage,
    'uglyHouse 比 desertVillage 更稀');
  // house 不降（代码生成、不吃预算）：仍是城市外撒布里最密的
  assertTrue(OUTSIDE_SCATTER_CHANCE.house > OUTSIDE_SCATTER_CHANCE.desertPyramid,
    'house 概率最高（不降，草地上的房子保持可见）');
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
async function genColumnFull(reg, cx, cz) {
  const col = new ChunkColumn(cx, cz);
  fillColumn(col, SEED, reg);
  carveCaves(col, SEED, reg);
  await applyStructuresToColumn(col, SEED, reg, layoutsFor(cx, cz));
  return col;
}

/** 城市布局（region [0,0]）+ 其 3×3 邻域布局，与 StructureIndex 下发的查询域一致 */
function layoutsFor(cx, cz) {
  const out = [];
  for (const key of neighborRegionKeys(cx, cz)) {
    const [rx, rz] = key.split(',').map(Number);
    out.push(computeRegionLayout(rx, rz, SEED));
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
  flowerBed: 3, pavilion: 6, tallWell: 51, desertPyramid: 16,
  desertVillage: 12, uglyHouse: 13, tank: 9, house: 6,
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
 * @returns {number} footprint 内 y 及以上的非空气方块数
 */
function countStructureBlocksAt(cand, type, get) {
  const fp = SCATTER_FOOTPRINT[type];
  const extent = SCATTER_Y_EXTENT[type] || 6;
  let n = 0;
  for (let dx = -fp.halfX; dx <= fp.halfX; dx++) {
    for (let dz = -fp.halfZ; dz <= fp.halfZ; dz++) {
      for (let y = cand.y; y <= cand.y + extent; y++) {
        if (get(cand.x + dx, y, cand.z + dz) !== 0) n++;
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
  // 收集城市外的全部 house 候选（region [1,0] 实测有 21 个）
  const outside = [];
  for (const [rx, rz] of [[1, 0], [0, 1], [-1, 0], [0, -1], [2, 0], [-2, 0]]) {
    const arr = computeRegionLayout(rx, rz, SEED).scatter.outsideScatter;
    for (let i = 0; i < arr.length; i += 4) {
      if (SCATTER_TYPES[arr[i + 3]] !== 'house') continue;
      const x = arr[i], z = arr[i + 2];
      if (x >= city.minX && x <= city.maxX && z >= city.minZ && z <= city.maxZ) continue;
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

test('城市外候选一律不在水下（有意偏离 mc-lite：mc-lite 无此门控）', () => {
  // mc-lite 的 resolveLargeStaticStructureType 不查水位，会把房子/坦克放进水里。
  // mc-heavy 地形水下面积大，照搬会产出大量水下结构 → 观感明显错误，故加 h<=SEA_Y 门控。
  // 断言落在实际产出的候选上（§2.5 陷阱①）。
  let checked = 0, underwater = 0;
  for (const [rx, rz] of [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1], [2, 0], [-2, 0]]) {
    const arr = computeRegionLayout(rx, rz, SEED).scatter.outsideScatter;
    for (let i = 0; i < arr.length; i += 4) {
      checked++;
      // 候选 y = h+1 → 水下等价于 y <= SEA_Y+1
      if (arr[i + 1] <= SEA_Y + 1) underwater++;
    }
  }
  assertTrue(checked > 0, `确有城市外候选（${checked} 个），否则断言恒真`);
  assertEqual(underwater, 0, `${checked} 个候选无一在水下`);
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
