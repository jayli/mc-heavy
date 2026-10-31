// src/tests/test-tarn-altar.js — 高台地带祭坛 Tier 1
//
// 用户 2026-10-31 在存档里手工修出了一座祭坛（进度包
// `/Users/bachi/ttt/bug/mc_祭坛/mc-heavy-progress-1249026-*.json`，seed 1249026 的
// region(0,5) 地带圆心），要求把造型内化进代码：放在**离 City 最近的高台地带**的
// 圆心广场（设置面板「高台」瞬移到达的那个地带）。
//
// 祭坛 = 两层（解码自用户存档，逐格核对过）：
//   · 地表层（y = plateauY，**替换**广场原有的 tuff_bricks/smooth_stone_1，不抬高地面）：
//     黄金十字（±28、1 格宽）+ 紫水晶对角线（半径 4~20）+ 中心 3×3
//     （四角 gold、四正 diamond、中心 debris）。
//   · 神龛（唯一突出地面的区域，7×7 中心）：
//     dy+1：四角与中心 iron、八位 emerald、四向 planks_step（高侧朝中心）；
//     dy+2：四角 emerald、中心 diamond。
//
// ⚠️ 紫晶柱**不受影响**：祭坛先写、紫晶柱后光栅化（后写胜），柱基自然压在祭坛
// 地表格上 —— 正好复现用户存档里「东臂缺 7 格、对角线缺 3 格」的形态（那 10 格
// 被柱基占了）。代码生成完整对称图案，柱基覆盖处由柱决定。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import {
  computeTarnZone, isTarnZone, findNearestTarnZone,
  findAltarTarnRegion, isAltarTarnZone,
} from '../gen/structures/tarn-zone.js';
import { altarSurfaceBlockAt, altarShrineBlocks, ALTAR_ARM_LENGTH, ALTAR_DIAG_MIN, ALTAR_DIAG_MAX } from '../gen/structures/tarn-altar.js';
import { computeRegionLayout } from '../gen/structures/structure-layout.js';
import { applyStructuresToColumn } from '../gen/structures/apply.js';
import { buildDefaultRegistry } from '../voxel/block-registry.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { blockIndex } from '../voxel/constants.js';
import { fillColumn } from '../gen/terrain.js';
import { getCityBoundsForSeed, buildCityLayout, getCitySpawnPoint } from '../gen/structures/city-layout.js';
import { resourceUrl } from '../core/resource-url.js';

const SEED = 12345;

/** 枚举 ±6 region 内全部地带 */
function allTarnRegions(seed) {
  const out = [];
  for (let rx = -6; rx <= 6; rx++) for (let rz = -6; rz <= 6; rz++) {
    if (isTarnZone(rx, rz, seed)) out.push({ rx, rz });
  }
  return out;
}

/** 建一个走完真实 GEN 的 column（fillColumn → applyStructuresToColumn） */
async function genColumn(rx, rz, cx, cz, reg) {
  const col = new ChunkColumn(cx, cz);
  fillColumn(col, SEED, reg);
  await applyStructuresToColumn(col, SEED, reg, [computeRegionLayout(rx, rz, SEED)]);
  return col;
}

// ==================== 纯函数：地表图案 ====================

test('祭坛纯函数：地表图案完全四向对称', () => {
  for (let dx = -30; dx <= 30; dx++) {
    for (let dz = -30; dz <= 30; dz++) {
      const a = altarSurfaceBlockAt(dx, dz);
      const b = altarSurfaceBlockAt(-dx, dz);
      const c = altarSurfaceBlockAt(dx, -dz);
      const d = altarSurfaceBlockAt(dz, dx); // 转置 = 镜像对称
      const key = `(${dx},${dz})`;
      assertEqual(JSON.stringify(b), JSON.stringify(a), `${key} 与 (-dx,dz)`);
      assertEqual(JSON.stringify(c), JSON.stringify(a), `${key} 与 (dx,-dz)`);
      assertEqual(JSON.stringify(d), JSON.stringify(a), `${key} 与 (dz,dx)`);
    }
  }
});

test('祭坛纯函数：地表图案计数与用户存档逐格一致（185 格）', () => {
  const counts = {};
  let total = 0;
  for (let dx = -30; dx <= 30; dx++) {
    for (let dz = -30; dz <= 30; dz++) {
      const b = altarSurfaceBlockAt(dx, dz);
      if (!b) continue;
      counts[b.type] = (counts[b.type] || 0) + 1;
      total++;
    }
  }
  // 用户存档 dy=0 层 185 格 = 105 gold + 65 amethyst + 4 diamond + 1 debris + 10 无效编辑；
  // 对称补全后 = 112 gold（+7 被 spire_01 挡的东臂）+ 68 amethyst（+3 被 spire_02 挡的对角线）。
  assertEqual(counts.gold_block, 112, 'gold 总数（十字 108 + 3×3 四角 4）');
  assertEqual(counts.amethyst, 68, 'amethyst 总数（4 条对角线 × 17）');
  assertEqual(counts.diamond, 4, 'diamond = 3×3 四正');
  assertEqual(counts.debris, 1, 'debris = 中心一格');
  assertEqual(total, 185, '地表图案总格数');
});

test('祭坛纯函数：臂长与对角线半径的边界', () => {
  // 十字臂：2..28 是 gold，1 格属于 3×3（diamond），29 起无图案
  assertEqual(altarSurfaceBlockAt(0, 2)?.type, 'gold_block', '(0,2) 是臂');
  assertEqual(altarSurfaceBlockAt(0, ALTAR_ARM_LENGTH)?.type, 'gold_block', '(0,28) 是臂的末端');
  assertEqual(altarSurfaceBlockAt(0, ALTAR_ARM_LENGTH + 1), null, '(0,29) 穿出广场无图案');
  assertEqual(altarSurfaceBlockAt(2, 0)?.type, 'gold_block', '(2,0) 是臂');
  // 对角线：4..20 是 amethyst，3 与 21 无图案
  assertEqual(altarSurfaceBlockAt(ALTAR_DIAG_MIN, ALTAR_DIAG_MIN)?.type, 'amethyst', '(4,4) 是对角线起点');
  assertEqual(altarSurfaceBlockAt(ALTAR_DIAG_MAX, ALTAR_DIAG_MAX)?.type, 'amethyst', '(20,20) 是对角线末端');
  assertEqual(altarSurfaceBlockAt(3, 3), null, '(3,3) 在对角线起点内侧无图案');
  assertEqual(altarSurfaceBlockAt(21, 21), null, '(21,21) 超出对角线末端');
  // 臂与对角线之间：(2,2) 之类是空（保持广场原材质）
  assertEqual(altarSurfaceBlockAt(2, 2), null, '(2,2) 无图案');
  assertEqual(altarSurfaceBlockAt(1, 10), null, '(1,10) 在臂侧一格无图案（用户存档该格未动）');
});

test('祭坛纯函数：中心 3×3 = debris 心 + diamond 边 + gold 角', () => {
  assertEqual(altarSurfaceBlockAt(0, 0)?.type, 'debris', '中心是 debris');
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    assertEqual(altarSurfaceBlockAt(dx, dz)?.type, 'diamond', `(${dx},${dz}) 是 diamond`);
  }
  for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    assertEqual(altarSurfaceBlockAt(dx, dz)?.type, 'gold_block', `(${dx},${dz}) 是 gold`);
  }
});

test('祭坛纯函数：神龛块表 = 用户存档的突出部分（22 格，台阶高侧朝中心）', () => {
  const blocks = altarShrineBlocks();
  assertEqual(blocks.length, 22, '神龛共 22 格（dy1 十七格 + dy2 五格）');
  const at = (dx, dy, dz) => blocks.find((b) => b.dx === dx && b.dy === dy && b.dz === dz);

  // dy=1：四角与中心 iron
  for (const [dx, dz] of [[3, 3], [3, -3], [-3, 3], [-3, -3], [0, 0]]) {
    assertEqual(at(dx, 1, dz)?.type, 'iron', `dy1 (${dx},${dz}) 是 iron`);
  }
  // dy=1：八位 emerald（7×7 环上贴角的边格）
  for (const [dx, dz] of [[3, 2], [2, 3], [3, -2], [2, -3], [-3, 2], [-2, 3], [-3, -2], [-2, -3]]) {
    assertEqual(at(dx, 1, dz)?.type, 'emerald', `dy1 (${dx},${dz}) 是 emerald`);
  }
  // dy=1：四向台阶，高侧朝中心（mesher 实测口径：orient 0/1/2/3 高侧 = -X/+Z/+X/-Z）
  assertEqual(at(1, 1, 0)?.type, 'planks_step', 'dy1 (1,0) 是台阶');
  assertEqual(at(1, 1, 0)?.meta, 0, '(1,0) 台阶高侧朝 -X（朝中心）');
  assertEqual(at(-1, 1, 0)?.meta, 2, '(-1,0) 台阶高侧朝 +X（朝中心）');
  assertEqual(at(0, 1, -1)?.meta, 1, '(0,-1) 台阶高侧朝 +Z（朝中心）');
  assertEqual(at(0, 1, 1)?.meta, 3, '(0,1) 台阶高侧朝 -Z（朝中心）');
  // dy=2：四角 emerald + 中心 diamond
  for (const [dx, dz] of [[3, 3], [3, -3], [-3, 3], [-3, -3]]) {
    assertEqual(at(dx, 2, dz)?.type, 'emerald', `dy2 (${dx},${dz}) 是 emerald`);
  }
  assertEqual(at(0, 2, 0)?.type, 'diamond', 'dy2 中心是 diamond');
  // 神龛水平范围不得超出 7×7（与紫晶柱的最小实测距离 13 格保持安全余量）
  for (const b of blocks) {
    assertTrue(Math.abs(b.dx) <= 3 && Math.abs(b.dz) <= 3, `神龛块 (${b.dx},${b.dz}) 在 7×7 内`);
    assertTrue(b.dy === 1 || b.dy === 2, `神龛块 dy=${b.dy} 只突出 1~2 层`);
  }
});

// ==================== 落点：离 City 最近的地带 ====================

test('祭坛落点：findAltarTarnRegion = 距城市出生点最近的地带（seed 12345 = (2,0)）', () => {
  const region = findAltarTarnRegion(SEED);
  assertTrue(region !== null, 'seed 12345 必须有祭坛地带');
  // 独立复算：城市 bounds 中心 → findNearestTarnZone（与实现同源的两个既有权威交叉验证）
  const b = getCityBoundsForSeed(SEED);
  const found = findNearestTarnZone(Math.round((b.minX + b.maxX) / 2), Math.round((b.minZ + b.maxZ) / 2), SEED);
  assertEqual(region.regionX, found.regionX, 'regionX 与独立复算一致');
  assertEqual(region.regionZ, found.regionZ, 'regionZ 与独立复算一致');
  assertEqual(region.regionX, 2, 'seed 12345 的祭坛地带是 (2,0)（探针实测）');
  assertEqual(region.regionZ, 0, 'seed 12345 的祭坛地带是 (2,0)（探针实测）');
  // 纯函数：重复调用结果一致
  const again = findAltarTarnRegion(SEED);
  assertEqual(JSON.stringify(again), JSON.stringify(region), '重复调用一致');
});

test('祭坛落点：城市 bounds 中心 ≡ 城市出生点（复用缓存 bounds 的正确性前提）', () => {
  // findAltarTarnRegion 用已缓存的 getCityBoundsForSeed 的中心代替 getCitySpawnPoint
  // （后者要 buildCityLayout 15ms）。前提 = bounds 恒以出生点为中心对称。
  for (const seed of [12345, 424242, 1249026]) {
    const b = getCityBoundsForSeed(seed);
    const sp = getCitySpawnPoint(buildCityLayout(seed));
    assertEqual(Math.round((b.minX + b.maxX) / 2), sp.x, `seed ${seed} bounds 中心 x`);
    assertEqual(Math.round((b.minZ + b.maxZ) / 2), sp.z, `seed ${seed} bounds 中心 z`);
  }
});

test('祭坛落点：每个 seed 恰好一个地带 isAltarTarnZone 为 true', () => {
  const regions = allTarnRegions(SEED);
  assertTrue(regions.length >= 2, '判别力前提：seed 12345 至少有两个地带');
  const altars = regions.filter(({ rx, rz }) => isAltarTarnZone(rx, rz, SEED));
  assertEqual(altars.length, 1, '只有一个地带是祭坛地带');
  const expected = findAltarTarnRegion(SEED);
  assertEqual(altars[0].rx, expected.regionX, 'isAltarTarnZone 与 findAltarTarnRegion 同源');
  assertEqual(altars[0].rz, expected.regionZ, 'isAltarTarnZone 与 findAltarTarnRegion 同源');
  // 非地带 region 必须 false
  assertEqual(isAltarTarnZone(0, 0, SEED), false, 'CITY_REGION 恒 false');
});

// ==================== 接线：layout 标志与真实 GEN ====================

test('祭坛接线：layout.altar 标志只在最近地带为 true', () => {
  for (const { rx, rz } of allTarnRegions(SEED)) {
    const lay = computeRegionLayout(rx, rz, SEED).tarn;
    assertTrue(lay !== null, `region(${rx},${rz}) 的 layout.tarn 有值`);
    const expected = isAltarTarnZone(rx, rz, SEED);
    assertEqual(lay.altar, expected, `region(${rx},${rz}) 的 layout.altar`);
  }
});

test('祭坛接线：真实 GEN 后地表图案逐格落地（柱基覆盖处柱赢）', async () => {
  const region = findAltarTarnRegion(SEED);
  const lay = computeTarnZone(region.regionX, region.regionZ, SEED);
  const reg = await buildDefaultRegistry();

  // 预计算紫晶柱基座占用的格（b.y===1 → 世界 y = plateauY，与祭坛地表同层）
  const spireBase = new Map(); // 'dx,dz' -> 柱基方块名
  for (const d of lay.decos.filter((x) => x.kind === 'spire')) {
    const wx = Math.round(lay.cx + d.ring * Math.cos(d.ang));
    const wz = Math.round(lay.cz + d.ring * Math.sin(d.ang));
    const resp = await fetch(resourceUrl(`assets/structures/${d.variant}.json`));
    const j = await resp.json();
    const stride = j.stride || 4;
    for (let i = 0; i < j.blocks.length; i += stride) {
      if (j.blocks[i + 1] !== 1) continue; // 只要贴地层
      spireBase.set(`${wx + j.blocks[i] - lay.cx},${wz + j.blocks[i + 2] - lay.cz}`, j.palette[j.blocks[i + 3]]);
    }
  }

  // 走真实 GEN 铺满广场区域
  const ccx = Math.floor(lay.cx / 16), ccz = Math.floor(lay.cz / 16);
  const columns = new Map();
  const rCols = Math.ceil((ALTAR_ARM_LENGTH + 2) / 16);
  for (let dcx = -rCols; dcx <= rCols; dcx++) {
    for (let dcz = -rCols; dcz <= rCols; dcz++) {
      columns.set(`${ccx + dcx},${ccz + dcz}`, await genColumn(region.regionX, region.regionZ, ccx + dcx, ccz + dcz, reg));
    }
  }
  const blockAt = (wx, y, wz) => {
    const col = columns.get(`${Math.floor(wx / 16)},${Math.floor(wz / 16)}`);
    if (!col) return -1;
    return col.blocks[blockIndex(wx - Math.floor(wx / 16) * 16, y, wz - Math.floor(wz / 16) * 16)];
  };
  const nameAt = (wx, y, wz) => reg.nameOf(blockAt(wx, y, wz));

  // 185 格地表图案：要么是祭坛方块，要么被柱基覆盖（柱赢）
  let placed = 0, overridden = 0;
  const wrong = [];
  for (let dx = -30; dx <= 30; dx++) {
    for (let dz = -30; dz <= 30; dz++) {
      const b = altarSurfaceBlockAt(dx, dz);
      if (!b) continue;
      const got = nameAt(lay.cx + dx, lay.plateauY, lay.cz + dz);
      const spire = spireBase.get(`${dx},${dz}`);
      if (spire !== undefined) {
        if (got === spire) overridden++;
        else wrong.push(`(${dx},${dz}) 柱基应为 ${spire}，实得 ${got}`);
      } else if (got === b.type) {
        placed++;
      } else {
        wrong.push(`(${dx},${dz}) 应为 ${b.type}，实得 ${got}`);
      }
    }
  }
  assertEqual(wrong.length, 0, `图案逐格落地：${wrong.slice(0, 5).join('；')}`);
  assertEqual(placed + overridden, 185, '185 格全部有着落');
  assertTrue(overridden > 0, `判别力：seed 12345 必有柱基覆盖祭坛格（实测 11 格），实得 ${overridden}`);
  assertTrue(placed > 150, `判别力：绝大多数图案格由祭坛自己落地，实得 ${placed}`);

  // 图案之外的广场格保持原材质（祭坛只替换、不扩散）
  //
  // ⚠️ **取样点必须先用 `altarSurfaceBlockAt` 验过是 null，且 d ≤ TARN_PLAZA_RADIUS(28)**：
  //    初版写了 `(5,5)`（实为紫水晶对角线）与 `(22,22)`（d=31.1 已出广场、属冰带）
  //    → 断言描述的是想象中的世界（同 AGENTS.md「写断言前先在真实数据上跑一次」）。
  //    下面 8 点均实测：图案为 null 且 d ∈ [2.8, 26.9]。
  for (const [dx, dz] of [[2, 2], [1, 10], [10, 1], [6, 3], [3, 6], [15, 8], [8, 15], [25, 10]]) {
    assertEqual(altarSurfaceBlockAt(dx, dz), null, `前提：(${dx},${dz}) 不属祭坛图案`);
    const got = nameAt(lay.cx + dx, lay.plateauY, lay.cz + dz);
    assertTrue(got === 'smooth_stone_1' || got === 'tuff_bricks' || spireBase.has(`${dx},${dz}`),
      `(${dx},${dz}) 图案外应保持广场材质，实得 ${got}`);
  }
});

test('祭坛接线：神龛真的突出地面（逐格 + 坐在广场地表上）', async () => {
  const region = findAltarTarnRegion(SEED);
  const lay = computeTarnZone(region.regionX, region.regionZ, SEED);
  const reg = await buildDefaultRegistry();
  const ccx = Math.floor(lay.cx / 16), ccz = Math.floor(lay.cz / 16);
  const col = await genColumn(region.regionX, region.regionZ, ccx, ccz, reg);
  const nameAt = (dx, dy, dz) => {
    const wx = lay.cx + dx, wz = lay.cz + dz;
    const lx = wx - ccx * 16, lz = wz - ccz * 16;
    if (lx < 0 || lx > 15 || lz < 0 || lz > 15) return '(跨 column)';
    return reg.nameOf(col.blocks[blockIndex(lx, lay.plateauY + dy, lz)]);
  };
  const metaAt = (dx, dy, dz) => {
    const wx = lay.cx + dx, wz = lay.cz + dz;
    return col.meta[blockIndex(wx - ccx * 16, lay.plateauY + dy, wz - ccz * 16)];
  };

  for (const b of altarShrineBlocks()) {
    assertEqual(nameAt(b.dx, b.dy, b.dz), b.type, `神龛 (${b.dx},${b.dy},${b.dz}) = ${b.type}`);
    if (b.type === 'planks_step') {
      assertEqual(metaAt(b.dx, b.dy, b.dz), b.meta, `台阶 (${b.dx},${b.dz}) 朝向 meta=${b.meta}`);
    }
  }
  // 神龛正下方 = 祭坛地表（debris 中心），不是空气 —— 神龛坐在祭坛上
  assertEqual(nameAt(0, 0, 0), 'debris', '神龛下方是祭坛中心 debris');
});

test('祭坛接线：非祭坛地带的广场中心没有祭坛方块', async () => {
  // seed 12345 的第一个地带 (-6,-2) 不是祭坛地带（祭坛在 (2,0)）
  const rx = -6, rz = -2;
  assertTrue(isTarnZone(rx, rz, SEED), '前提：(-6,-2) 是地带');
  assertEqual(isAltarTarnZone(rx, rz, SEED), false, '前提：(-6,-2) 不是祭坛地带');
  const lay = computeTarnZone(rx, rz, SEED);
  const reg = await buildDefaultRegistry();
  const altarIds = new Set(['gold_block', 'diamond', 'debris', 'emerald'].map((n) => reg.idOf(n)));
  const ccx = Math.floor(lay.cx / 16), ccz = Math.floor(lay.cz / 16);
  const col = await genColumn(rx, rz, ccx, ccz, reg);
  let hits = 0;
  for (let dx = -30; dx <= 30; dx++) {
    for (let dz = -30; dz <= 30; dz++) {
      const lx = lay.cx + dx - ccx * 16, lz = lay.cz + dz - ccz * 16;
      if (lx < 0 || lx > 15 || lz < 0 || lz > 15) continue;
      for (let dy = 0; dy <= 3; dy++) {
        if (altarIds.has(col.blocks[blockIndex(lx, lay.plateauY + dy, lz)])) hits++;
      }
    }
  }
  assertEqual(hits, 0, '非祭坛地带不得出现祭坛方块（gold/diamond/debris/emerald 均不在自然地形与套件 palette）');
});

test('祭坛接线：紫晶柱不受影响（祭坛地带仍是 12 个装饰件）', () => {
  const region = findAltarTarnRegion(SEED);
  const lay = computeTarnZone(region.regionX, region.regionZ, SEED);
  assertEqual(lay.decos.length, 12, '祭坛地带仍有 5 拱洞 + 7 紫晶柱');
  assertEqual(lay.decos.filter((d) => d.kind === 'spire').length, 7, '7 根紫晶柱全部保留');
});
