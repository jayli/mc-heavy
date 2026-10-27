// src/tests/test-tarn-terrain.js — 高台地带台地整形 Tier 1
//
// 钉的是「台地看起来像台地」的四个不可让步的事实：高度恒定、池底在台地下一格、
// 池内恰有 1 层水、草石镶嵌两种方块都出现。
//
// ⚠️ **每个用例都必须先 `fillColumn` 再 `fillTarnPlateau`**（B5）：空 column 上
// 「削平原山」平凡通过，注入「忘了削山」的缺陷测不出来（既有手法见
// `test-giant-trees-gen.js:51`）。真实生成路径就是 `fillColumn` → `fillTarnPlateau` → 结构光栅化。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { computeTarnZone, isTarnZone } from '../gen/structures/tarn-zone.js';
import { fillTarnPlateau, tarnSurfaceBlock, TARN_TERRAIN_SALT } from '../gen/structures/tarn-terrain.js';
import { buildDefaultRegistry } from '../voxel/block-registry.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { blockIndex } from '../voxel/constants.js';
import { fillColumn } from '../gen/terrain.js';

const SEED = 12345;

function findTarnRegion() {
  for (let rx = -6; rx <= 6; rx++) for (let rz = -6; rz <= 6; rz++) {
    if (isTarnZone(rx, rz, SEED)) return { rx, rz };
  }
  throw new Error('没找到地带 region');
}

/** 建一个已整形到地带的 column（先 fillColumn 再 fillTarnPlateau） */
async function shapedColumn(lay, wx, wz, reg) {
  const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
  const col = new ChunkColumn(cx, cz);
  fillColumn(col, SEED, reg);
  fillTarnPlateau(col, lay, SEED, reg);
  return { col, lx: wx - cx * 16, lz: wz - cz * 16 };
}

test('台地：同一坐标两次调用表面方块相同（确定性）', () => {
  for (const [wx, wz] of [[100, 100], [-40, 77], [0, 0]]) {
    assertEqual(tarnSurfaceBlock(wx, wz, SEED), tarnSurfaceBlock(wx, wz, SEED), `(${wx},${wz}) 稳定`);
  }
});

test('台地：TARN_TERRAIN_SALT 已导出且在空闲带内', () => {
  // salt 占用是**区间**口径（带 `+ step` 的调用点），不能只 grep 字面量。
  // 已占用：1-58 / 100 / 113 / 200-201 / 301-303 / 311-314 / 800-805 /
  //         911-958 / 950 / 960-961 / 999 / 1020-1024（本设计的五个）。
  // 这条钉住 1022 确实被导出且落在本设计占用的连续段内 —— 改 salt 而忘了同步
  // 注释或与其它系统撞车时，至少这里能看见。
  assertEqual(TARN_TERRAIN_SALT, 1022, 'TARN_TERRAIN_SALT 必须与 tarn-zone.js 的分配一致');
});

test('台地：草石镶嵌两种方块都出现（不是清一色）', () => {
  const kinds = new Set();
  for (let wz = -150; wz <= 150; wz += 3) for (let wx = -150; wx <= 150; wx += 3) {
    kinds.add(tarnSurfaceBlock(wx, wz, SEED));
  }
  assertEqual(kinds.size, 2, `镶嵌必须产生 2 种方块，实际 ${[...kinds].join(',')}`);
});

test('台地：草石镶嵌是「成片」不是逐格斑点', () => {
  // 逐格随机会让相邻格 50% 概率翻转 ⇒ 同行横向变化率 ~50%。
  // 成片（低频噪声）应当显著低于这个值。实测门槛取 0.35（远离 0.5 也远离 0）。
  let flips = 0, total = 0;
  for (let wz = -150; wz <= 150; wz += 7) {
    let prev = null;
    for (let wx = -150; wx <= 150; wx++) {
      const k = tarnSurfaceBlock(wx, wz, SEED);
      if (prev !== null) { total++; if (k !== prev) flips++; }
      prev = k;
    }
  }
  const rate = flips / total;
  assertTrue(rate < 0.35,
    `横向变化率 ${(rate * 100).toFixed(1)}% 太高 —— 镶嵌退化成逐格花屏（应 <35%）`);
});

test('台地：高度恒定（台地范围内地表高差 = 0）', async () => {
  const { rx, rz } = findTarnRegion();
  const lay = computeTarnZone(rx, rz, SEED);
  const reg = await buildDefaultRegistry();
  const heights = new Set();
  for (let a = 0; a < 32; a++) {
    const ang = (a / 32) * Math.PI * 2;
    for (const r of [lay.poolRadius + 6, lay.poolRadius + 20, lay.plateauRadius - 6]) {
      const wx = Math.round(lay.cx + r * Math.cos(ang));
      const wz = Math.round(lay.cz + r * Math.sin(ang));
      const { col, lx, lz } = await shapedColumn(lay, wx, wz, reg);
      let top = null;
      for (let y = 90; y >= -30; y--) {
        if (col.blocks[blockIndex(lx, y, lz)] !== 0) { top = y; break; }
      }
      if (top !== null) heights.add(top);
    }
  }
  assertEqual([...heights].join(','), String(lay.plateauY),
    `台地各采样点地表必须全等于 plateauY(${lay.plateauY})，实际 ${[...heights].join(',')}`);
});

test('台地：池内恰有 1 层水体，池底在台地下一格', async () => {
  const { rx, rz } = findTarnRegion();
  const lay = computeTarnZone(rx, rz, SEED);
  const reg = await buildDefaultRegistry();
  const waterId = reg.idOf('water');
  const stoneId = reg.idOf('stone');
  const { col, lx, lz } = await shapedColumn(lay, lay.cx, lay.cz, reg);

  let waterLayers = 0, lastWaterY = null;
  for (let y = -30; y <= 90; y++) {
    if (col.blocks[blockIndex(lx, y, lz)] === waterId) { waterLayers++; lastWaterY = y; }
  }
  assertEqual(waterLayers, 1, '池心必须恰有 1 层水');
  assertEqual(lastWaterY, lay.plateauY, '水面格必须落在 plateauY');
  assertEqual(col.blocks[blockIndex(lx, lastWaterY + 1, lz)], 0, '水面上方必须是空气');
  assertEqual(col.blocks[blockIndex(lx, lay.plateauY - 1, lz)], stoneId, '池底（plateauY-1）必须是 stone');
});

test('台地：台地外的格不被整形（圆外零影响）', async () => {
  // ⚠️ **必须取「部分在圆内、部分在圆外」的边缘 column**：
  // 若取「整列都在圆外」的 column，`fillTarnPlateau` 在外接方形求交时就已经
  // `x0 > x1` 提前 return，根本进不了循环 —— 那种用例即使删掉循环体里的
  // `d2 > platR2 continue` 也测不出差异（负向验证实测：删掉后该用例照样绿）。
  const { rx, rz } = findTarnRegion();
  const lay = computeTarnZone(rx, rz, SEED);
  const reg = await buildDefaultRegistry();
  // 地带圆边缘（半径附近）的 column：列内既有圆内格也有圆外格
  const wx = Math.round(lay.cx + lay.plateauRadius - 4);
  const wz = lay.cz;
  const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
  const before = new ChunkColumn(cx, cz);
  fillColumn(before, SEED, reg);
  const after = new ChunkColumn(cx, cz);
  fillColumn(after, SEED, reg);
  fillTarnPlateau(after, lay, SEED, reg);

  let insideCount = 0, outsideChanged = 0;
  for (let lx = 0; lx < 16; lx++) {
    for (let lz = 0; lz < 16; lz++) {
      const X = cx * 16 + lx, Z = cz * 16 + lz;
      const inside = Math.hypot(X - lay.cx, Z - lay.cz) <= lay.plateauRadius;
      if (inside) { insideCount++; continue; }
      // 圆外：逐格（逐 y）必须与整形前完全相同
      for (let y = -30; y <= 90; y++) {
        const idx = blockIndex(lx, y, lz);
        if (after.blocks[idx] !== before.blocks[idx]) outsideChanged++;
      }
    }
  }
  assertTrue(insideCount > 0 && insideCount < 256,
    `该边缘 column 必须部分在圆内部分在圆外（实测圆内 ${insideCount}/256），否则本用例无判别力`);
  assertEqual(outsideChanged, 0, `圆外格被整形了 ${outsideChanged} 处（应为 0）`);
});

test('台地：高于 plateauY 的原山体被削平（不是「台地长在山里」）', async () => {
  const { rx, rz } = findTarnRegion();
  const lay = computeTarnZone(rx, rz, SEED);
  const reg = await buildDefaultRegistry();
  // 找一个自然地形明显高于 plateauY 的采样点（这样「没削山」才有可观测差异）
  let found = null;
  for (let a = 0; a < 16 && !found; a++) {
    const ang = (a / 16) * Math.PI * 2;
    for (const r of [lay.poolRadius + 8, lay.poolRadius + 24]) {
      const wx = Math.round(lay.cx + r * Math.cos(ang));
      const wz = Math.round(lay.cz + r * Math.sin(ang));
      const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
      const probe = new ChunkColumn(cx, cz);
      fillColumn(probe, SEED, reg);
      let top = null;
      for (let y = 90; y >= -30; y--) {
        if (probe.blocks[blockIndex(wx - cx * 16, y, wz - cz * 16)] !== 0) { top = y; break; }
      }
      if (top !== null && top > lay.plateauY) { found = { wx, wz, top }; break; }
    }
  }
  assertTrue(found !== null,
    '必须存在「自然地形高于 plateauY」的台地采样点，否则本用例没有判别力');
  const { col, lx, lz } = await shapedColumn(lay, found.wx, found.wz, reg);
  // 整形后该列 plateauY 之上不得有方块
  for (let y = lay.plateauY + 1; y <= 90; y++) {
    assertEqual(col.blocks[blockIndex(lx, y, lz)], 0,
      `原山体（自然顶 y=${found.top}）在 plateauY+${y - lay.plateauY} 处未被削平`);
  }
});
