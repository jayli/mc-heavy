// src/tests/test-tarn-altar.js — 高台地带祭坛 Tier 1
//
// 用户 2026-10-31 在存档里手工修出了一座祭坛并内化进代码；2026-11-06 用户在同一存档
// （进度包 `/Users/bachi/ttt/mc/mc-heavy-progress-1249026-2026-11-06T15-01-30.json`，
// seed 1249026 的 region(0,-3) 地带圆心 (200,-1000)）**重做了祭坛造型**（v2.82）。
// 本文件钉住重做后的造型：逐格解码自用户存档，重建比对 0 不符。
//
// 祭坛 = 两层（见 `tarn-altar.js` 头注释）：
//   · 地表层（y = plateauY，**替换**广场材质，不抬高地面，565 格）：
//     中心 7×7 美朵 + 十字轴 gold/amethyst 交替（±29）+ 对角线交替（4~20）
//     + 外圈 amethyst 环（28<r≤29，带 8 个对称缺口）+ 旧 tuff 十字臂抹平为 smooth_stone_1。
//   · 神龛（唯一突出地面的区域，v2.82 从 22 格简化为 6 格）：
//     dy+1：中心 gold_block + 四向 planks_step（高侧朝中心）；dy+2：中心 diamond。
//
// ⚠️ **v2.31 起祭坛地带不再生成紫晶柱**（用户 2026-10-31：「只删带有祭坛的高台地形里的
// 水晶柱，其他高台地带不要动」）⇒ 广场图案完整落地，不再有柱基遮挡的缺口。
// 其他地带的 7 根紫晶柱一根不动
// （`test-tarn-zone.js` / `test-tarn-zone-gen.js` 的 `decos.length === 12` 继续钉住）。
//
// ⚠️ **`TARN_PLAZA_RADIUS`(28) 不因此改小**：它的标定理由是「紫晶柱真实足迹最远 25.4」，
// 而其他地带仍有柱子 ⇒ 全局常量必须按最坏情况留。祭坛外环（r≤29）比广场半径大 1 格，
// 压在冰带内圈上 —— 用户存档原样，刻意保留。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import {
  computeTarnZone, isTarnZone, findNearestTarnZone,
  findAltarTarnRegion, isAltarTarnZone, TARN_PLAZA_RADIUS,
} from '../gen/structures/tarn-zone.js';
import { altarSurfaceBlockAt, altarShrineBlocks, ALTAR_ARM_LENGTH, ALTAR_DIAG_MIN, ALTAR_DIAG_MAX } from '../gen/structures/tarn-altar.js';
import { computeRegionLayout } from '../gen/structures/structure-layout.js';
import { applyStructuresToColumn } from '../gen/structures/apply.js';
import { buildDefaultRegistry } from '../voxel/block-registry.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { blockIndex } from '../voxel/constants.js';
import { fillColumn } from '../gen/terrain.js';
import { getCityBoundsForSeed, buildCityLayout, getCitySpawnPoint } from '../gen/structures/city-layout.js';

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
  for (let dx = -31; dx <= 31; dx++) {
    for (let dz = -31; dz <= 31; dz++) {
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

test('祭坛纯函数：地表图案计数与用户存档逐格一致（565 格）', () => {
  const counts = {};
  let total = 0;
  for (let dx = -31; dx <= 31; dx++) {
    for (let dz = -31; dz <= 31; dz++) {
      const b = altarSurfaceBlockAt(dx, dz);
      if (!b) continue;
      counts[b.type] = (counts[b.type] || 0) + 1;
      total++;
    }
  }
  // v2.82 重做后的计数（逐格解码自用户 2026-11-06 存档，重建比对 0 不符）。
  // 按分支拆（实测）：美朵 41 + 十字轴 104 + 对角线 68 + 外环 160 + 抹平臂 192 = 565。
  //   amethyst 260 = 美朵 16 + 轴奇数格 52 + 对角线奇数格 32 + 外环 160
  //   gold 108 = 美朵 20 + 轴偶数格 52 + 对角线偶数格 36
  //   smooth_stone_1 192 = 抹平旧 tuff 十字臂（|dx|=1 或 |dz|=1，另一轴 4..27，四向）
  assertEqual(counts.amethyst, 260, 'amethyst 总数');
  assertEqual(counts.gold_block, 108, 'gold 总数');
  assertEqual(counts.smooth_stone_1, 192, 'smooth_stone_1 = 抹平的旧 tuff 臂');
  assertEqual(counts.diamond, 4, 'diamond = 美朵四正');
  assertEqual(counts.debris, 1, 'debris = 中心一格');
  assertEqual(total, 565, '地表图案总格数');
});

test('祭坛纯函数：十字轴 / 对角线 / 外环的边界与交替规则', () => {
  // 十字轴：2..29，偶数格 gold / 奇数格 amethyst 交替
  assertEqual(altarSurfaceBlockAt(0, 2)?.type, 'gold_block', '(0,2) 轴偶数格是 gold');
  assertEqual(altarSurfaceBlockAt(0, 3)?.type, 'amethyst', '(0,3) 轴奇数格是 amethyst');
  assertEqual(altarSurfaceBlockAt(0, ALTAR_ARM_LENGTH - 1)?.type, 'gold_block', '(0,28) 轴偶数格是 gold');
  assertEqual(altarSurfaceBlockAt(0, ALTAR_ARM_LENGTH)?.type, 'amethyst', '(0,29) 是轴的末端（奇数 amethyst）');
  assertEqual(altarSurfaceBlockAt(0, ALTAR_ARM_LENGTH + 1), null, '(0,30) 穿出图案');
  assertEqual(altarSurfaceBlockAt(2, 0)?.type, 'gold_block', '(2,0) 轴偶数格是 gold');
  // 对角线：4..20，偶数格 gold / 奇数格 amethyst 交替（t=3 属美朵角，不是对角线）
  assertEqual(altarSurfaceBlockAt(ALTAR_DIAG_MIN, ALTAR_DIAG_MIN)?.type, 'gold_block', '(4,4) 对角线起点（偶 gold）');
  assertEqual(altarSurfaceBlockAt(5, 5)?.type, 'amethyst', '(5,5) 对角线奇数格是 amethyst');
  assertEqual(altarSurfaceBlockAt(ALTAR_DIAG_MAX, ALTAR_DIAG_MAX)?.type, 'gold_block', '(20,20) 是对角线末端（偶 gold）');
  assertEqual(altarSurfaceBlockAt(3, 3)?.type, 'amethyst', '(3,3) 是美朵角（amethyst，不是对角线）');
  assertEqual(altarSurfaceBlockAt(21, 21), null, '(21,21) 超出对角线末端');
  // 外环：28 < r <= 29 是 amethyst，带 8 个对称缺口
  assertEqual(altarSurfaceBlockAt(28, 1)?.type, 'amethyst', '(28,1) r=28.02 在环上');
  assertEqual(altarSurfaceBlockAt(1, 28)?.type, 'amethyst', '(1,28) 在环上');
  assertEqual(altarSurfaceBlockAt(29, 0)?.type, 'amethyst', '(29,0) 轴末端也在环上');
  for (const [dx, dz] of [[16, 24], [24, 16], [-16, 24], [16, -24], [24, -16], [-24, 16], [-16, -24], [-24, -16]]) {
    assertEqual(altarSurfaceBlockAt(dx, dz), null, `(${dx},${dz}) 是外环的对称缺口（用户刻意保留）`);
  }
  // 臂与对角线之间：图案外保持广场原材质
  assertEqual(altarSurfaceBlockAt(6, 3), null, '(6,3) 无图案');
  assertEqual(altarSurfaceBlockAt(15, 8), null, '(15,8) 无图案');
});

test('祭坛纯函数：中心 7×7 美朵（debris 心 + diamond 十字 + gold/amethyst 点缀）', () => {
  assertEqual(altarSurfaceBlockAt(0, 0)?.type, 'debris', '中心是 debris');
  // diamond 十字（±1,0),(0,±1)
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    assertEqual(altarSurfaceBlockAt(dx, dz)?.type, 'diamond', `(${dx},${dz}) 是 diamond`);
  }
  // gold：(±1,±1)、(±2,0),(0,±2)、(±3,±1),(±1,±3)、(±2,±2)
  for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1],
    [2, 0], [-2, 0], [0, 2], [0, -2],
    [3, 1], [3, -1], [-3, 1], [-3, -1], [1, 3], [1, -3], [-1, 3], [-1, -3],
    [2, 2], [2, -2], [-2, 2], [-2, -2]]) {
    assertEqual(altarSurfaceBlockAt(dx, dz)?.type, 'gold_block', `(${dx},${dz}) 是 gold`);
  }
  // amethyst：(±3,0),(0,±3)、(±2,±1),(±1,±2)、(±3,±3)
  for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3], [0, -3],
    [2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [1, -2], [-1, 2], [-1, -2],
    [3, 3], [3, -3], [-3, 3], [-3, -3]]) {
    assertEqual(altarSurfaceBlockAt(dx, dz)?.type, 'amethyst', `(${dx},${dz}) 是 amethyst`);
  }
  // 美朵的 8 个背景格 (±3,±2),(±2,±3)：不属祭坛，保持广场 smooth_stone_1
  for (const [dx, dz] of [[3, 2], [3, -2], [-3, 2], [-3, -2], [2, 3], [2, -3], [-2, 3], [-2, -3]]) {
    assertEqual(altarSurfaceBlockAt(dx, dz), null, `(${dx},${dz}) 是美朵背景格（不属祭坛）`);
  }
});

test('祭坛纯函数：神龛块表 = 用户存档的突出部分（6 格，台阶高侧朝中心）', () => {
  const blocks = altarShrineBlocks();
  assertEqual(blocks.length, 6, '神龛共 6 格（dy1 五格 + dy2 一格）');
  const at = (dx, dy, dz) => blocks.find((b) => b.dx === dx && b.dy === dy && b.dz === dz);

  // dy=1：中心 gold_block
  assertEqual(at(0, 1, 0)?.type, 'gold_block', 'dy1 中心是 gold_block');
  // dy=1：四向台阶，高侧朝中心（mesher 实测口径：orient 0/1/2/3 高侧 = -X/+Z/+X/-Z）
  assertEqual(at(1, 1, 0)?.type, 'planks_step', 'dy1 (1,0) 是台阶');
  assertEqual(at(1, 1, 0)?.meta, 0, '(1,0) 台阶高侧朝 -X（朝中心）');
  assertEqual(at(-1, 1, 0)?.meta, 2, '(-1,0) 台阶高侧朝 +X（朝中心）');
  assertEqual(at(0, 1, -1)?.meta, 1, '(0,-1) 台阶高侧朝 +Z（朝中心）');
  assertEqual(at(0, 1, 1)?.meta, 3, '(0,1) 台阶高侧朝 -Z（朝中心）');
  // dy=2：中心 diamond
  assertEqual(at(0, 2, 0)?.type, 'diamond', 'dy2 中心是 diamond');
  // 神龛水平范围不得超出 3×3（v2.82 简化后只占中心十字）
  for (const b of blocks) {
    assertTrue(Math.abs(b.dx) <= 1 && Math.abs(b.dz) <= 1, `神龛块 (${b.dx},${b.dz}) 在 3×3 内`);
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

test('祭坛接线：真实 GEN 后地表图案 565 格完整落地（v2.31 起无柱基遮挡）', async () => {
  const region = findAltarTarnRegion(SEED);
  const lay = computeTarnZone(region.regionX, region.regionZ, SEED);
  const reg = await buildDefaultRegistry();

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

  // 565 格地表图案：全部由祭坛自己落地（v2.31 起祭坛地带无紫晶柱，不再有柱基覆盖）
  let placed = 0;
  const wrong = [];
  for (let dx = -31; dx <= 31; dx++) {
    for (let dz = -31; dz <= 31; dz++) {
      const b = altarSurfaceBlockAt(dx, dz);
      if (!b) continue;
      const got = nameAt(lay.cx + dx, lay.plateauY, lay.cz + dz);
      if (got === b.type) placed++;
      else wrong.push(`(${dx},${dz}) 应为 ${b.type}，实得 ${got}`);
    }
  }
  assertEqual(wrong.length, 0, `图案逐格落地：${wrong.slice(0, 5).join('；')}`);
  // ⚠️ **必须是 565**（v2.82 重做后的图案总格数，与上面纯函数计数用例同源）：
  //    这条断言同时钉住「柱子真的没了」—— 柱子还在的话柱基会压掉外环与轴末端的格。
  assertEqual(placed, 565, '565 格图案全部由祭坛自己落地（无柱基遮挡）');

  // 广场圆内不得出现 tuff_bricks —— v2.82 的祭坛把广场那个 3 格宽 tuff 十字
  // 在自己范围内全部抹平成 smooth_stone_1（用户存档实测 tuff 残留 0）。
  // ⚠️ 这是「抹平臂」分支的唯一接线判据：漏写那个分支时图案计数仍对（smooth_stone_1
  //    与背景同材质，`placed` 不会变），只有这条能抓到。
  let tuff = 0;
  for (let dx = -TARN_PLAZA_RADIUS; dx <= TARN_PLAZA_RADIUS; dx++) {
    for (let dz = -TARN_PLAZA_RADIUS; dz <= TARN_PLAZA_RADIUS; dz++) {
      if (Math.hypot(dx, dz) > TARN_PLAZA_RADIUS) continue;
      if (nameAt(lay.cx + dx, lay.plateauY, lay.cz + dz) === 'tuff_bricks') tuff++;
    }
  }
  assertEqual(tuff, 0, '祭坛地带广场内不得残留 tuff_bricks 十字（v2.82 全部抹平）');

  // 广场圆内不得出现紫晶柱材质 —— `block_of_quartz` 是干净标记：
  // 实测祭坛地带 8 座高台最近格距圆心 34.5、5 个拱洞 83.2，都 > TARN_PLAZA_RADIUS(28)
  // ⇒ 广场内唯一可能的石英来源就是那 7 根紫晶柱（环半径 20）。
  // ⚠️ 不能用 `amethyst` 作标记 —— 祭坛自己的对角线就用它。
  const quartzId = reg.idOf('block_of_quartz');
  let quartz = 0;
  for (let dx = -TARN_PLAZA_RADIUS; dx <= TARN_PLAZA_RADIUS; dx++) {
    for (let dz = -TARN_PLAZA_RADIUS; dz <= TARN_PLAZA_RADIUS; dz++) {
      if (Math.hypot(dx, dz) > TARN_PLAZA_RADIUS) continue;
      // 柱高实测最高 17 格，扫 plateauY..+20 足够覆盖整根柱子
      for (let dy = 0; dy <= 20; dy++) {
        if (blockAt(lay.cx + dx, lay.plateauY + dy, lay.cz + dz) === quartzId) quartz++;
      }
    }
  }
  assertEqual(quartz, 0, '祭坛地带广场内不得出现紫晶柱（block_of_quartz 是干净标记）');

  // 图案之外的广场格保持原材质（祭坛只替换、不扩散）
  //
  // ⚠️ **取样点必须先用 `altarSurfaceBlockAt` 验过是 null，且 d ≤ TARN_PLAZA_RADIUS(28)**：
  //    v2.30 的取样点 `(2,2)`（现为美朵 gold）与 `(1,10)`/`(10,1)`（现为抹平臂）在 v2.82
  //    重做后已变成图案格 ⇒ 断言会描述想象中的世界（同 AGENTS.md「写断言前先在真实数据上
  //    跑一次」）。下面 8 点均实测：图案为 null 且 d ∈ [5.4, 27.5]。
  for (const [dx, dz] of [[5, 2], [7, 4], [9, 5], [12, 7], [14, 9], [17, 11], [20, 13], [23, 15]]) {
    assertEqual(altarSurfaceBlockAt(dx, dz), null, `前提：(${dx},${dz}) 不属祭坛图案`);
    const got = nameAt(lay.cx + dx, lay.plateauY, lay.cz + dz);
    // 这些点都不在广场十字上（|dx|>1 且 |dz|>1）⇒ 背景恒为 smooth_stone_1
    assertEqual(got, 'smooth_stone_1', `(${dx},${dz}) 图案外应保持广场材质`);
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
  const altarIds = new Set(['gold_block', 'diamond', 'debris'].map((n) => reg.idOf(n)));
  const ccx = Math.floor(lay.cx / 16), ccz = Math.floor(lay.cz / 16);
  const col = await genColumn(rx, rz, ccx, ccz, reg);
  let hits = 0;
  for (let dx = -31; dx <= 31; dx++) {
    for (let dz = -31; dz <= 31; dz++) {
      const lx = lay.cx + dx - ccx * 16, lz = lay.cz + dz - ccz * 16;
      if (lx < 0 || lx > 15 || lz < 0 || lz > 15) continue;
      for (let dy = 0; dy <= 3; dy++) {
        if (altarIds.has(col.blocks[blockIndex(lx, lay.plateauY + dy, lz)])) hits++;
      }
    }
  }
  // ⚠️ 标记集不含 `amethyst` —— 其他地带的 7 根紫晶柱就用它（v2.82 的祭坛外环也用）。
  //    `emerald`/`iron` 在 v2.82 已不属祭坛（神龛简化），故从标记集移除。
  assertEqual(hits, 0, '非祭坛地带不得出现祭坛方块（gold/diamond/debris 均不在自然地形与套件 palette）');
});

test('祭坛接线：祭坛地带只剩 5 个拱洞，其他地带 12 个装饰件不变', () => {
  const region = findAltarTarnRegion(SEED);
  const lay = computeTarnZone(region.regionX, region.regionZ, SEED);
  assertEqual(lay.decos.filter((d) => d.kind === 'spire').length, 0, '祭坛地带不生成紫晶柱（v2.31）');
  assertEqual(lay.decos.length, 5, '祭坛地带只剩 5 个拱洞');
  assertEqual(lay.decos.filter((d) => d.kind === 'arch').length, 5, '拱洞一根不少');
  // ⚠️ 拱洞角度不得因删掉紫晶柱而漂移：`tarnPlaceDecos` 按**本族变体数**等角分布
  //    （arch 5 个 ⇒ 2π/5），与 spire 数量无关。若有人把两族合成一次落位，这条会红。
  //
  // ⚠️ **容差 0.25 是标定值，不得收紧到 0.1**（初版就写了 0.1，是个贴线断言）：
  //    角距 = 基础等分 2π/5 + 两个零和抖动之差，而 `zeroSum()` 单值可达 ±1.75×jitterMax
  //    （jitterMax = `DECO_JITTER_RAD` ≈ 3° = 0.0524）⇒ **理论上界 = 2×1.75×0.0524 = 0.183**。
  //    实测（seed 12345）最大偏差已达 **0.0804** —— 0.1 只剩 0.02 余量，换 seed 或改抖动幅度
  //    就会**假失败**（同 AGENTS.md「阈值必须落在两侧实测值之间」）。
  //    而真实失效模式的偏差大得多：2π/7 → **0.359**、2π/12 → **0.733**。
  //    取 0.25 = 落在 [0.183, 0.359] 区间内，两侧都有余量。
  const archAngles = lay.decos.filter((d) => d.kind === 'arch').map((d) => d.ang);
  for (let i = 1; i < archAngles.length; i++) {
    const gap = archAngles[i] - archAngles[i - 1];
    assertTrue(Math.abs(gap - 2 * Math.PI / 5) < 0.25,
      `拱洞 ${i - 1}→${i} 角距 ${gap.toFixed(4)} 应接近 2π/5 = ${(2 * Math.PI / 5).toFixed(4)}`);
  }

  // 其他地带（用户明确「其他高台地带不要动」）：仍是 5 拱洞 + 7 紫晶柱
  for (const { rx, rz } of allTarnRegions(SEED)) {
    if (rx === region.regionX && rz === region.regionZ) continue;
    const other = computeTarnZone(rx, rz, SEED);
    assertEqual(other.decos.filter((d) => d.kind === 'spire').length, 7,
      `非祭坛地带 region(${rx},${rz}) 的 7 根紫晶柱一根不动`);
    assertEqual(other.decos.length, 12, `非祭坛地带 region(${rx},${rz}) 仍是 12 个装饰件`);
  }
});
