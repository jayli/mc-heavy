// src/tests/test-tarn-terrain.js — 高台地带台地整形 Tier 1
//
// 钉的是「台地看起来像台地」的四个不可让步的事实：平台高度恒定、**无水**
// （v1.89 用户裁定去掉中央水池）、草石镶嵌两种方块都出现、边缘缓坡接续自然地形。
//
// ⚠️ **每个用例都必须先 `fillColumn` 再 `fillTarnPlateau`**（B5）：空 column 上
// 「削平原山」平凡通过，注入「忘了削山」的缺陷测不出来（既有手法见
// `test-giant-trees-gen.js:51`）。真实生成路径就是 `fillColumn` → `fillTarnPlateau` → 结构光栅化。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { computeTarnZone, isTarnZone, TARN_SLOPE_WIDTH as TARN_ZONE_SLOPE_WIDTH } from '../gen/structures/tarn-zone.js';
import { fillTarnPlateau, tarnSurfaceBlock, TARN_TERRAIN_SALT, TARN_SLOPE_WIDTH } from '../gen/structures/tarn-terrain.js';
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

test('台地：缓坡宽度与 tarn-zone 同源（两边不得各写一份）', () => {
  // ⚠️ 这条钉的是**红线 1**：`tarn-terrain.js` 从 `tarn-zone.js` import 坡宽（而不是自己写），
  // 因为 `isTarnZone` 的「核心沙漠占比」判据要采到平台边缘（= `TARN_ZONE_RADIUS - 坡宽`），
  // 两份漂移后同一个 region 会「判定时按 24 采样、整形时按 40 削坡」，抽中的地方一半是沙漠。
  assertEqual(TARN_SLOPE_WIDTH, TARN_ZONE_SLOPE_WIDTH, '两个模块导出的坡宽必须一致');
  const { rx, rz } = findTarnRegion();
  const lay = computeTarnZone(rx, rz, SEED);
  assertEqual(lay.slopeWidth, TARN_SLOPE_WIDTH, 'layout.slopeWidth 必须等于坡宽常量');
  assertEqual(lay.platformRadius + lay.slopeWidth, lay.plateauRadius,
    '平台半径 + 坡宽 必须等于地带半径');
});

test('台地：高度恒定（台地范围内地表高差 = 0）', async () => {
  const { rx, rz } = findTarnRegion();
  const lay = computeTarnZone(rx, rz, SEED);
  const reg = await buildDefaultRegistry();
  const heights = new Set();
  // ⚠️ v1.89：地带现在 = 内圈平台 + 外圈缓坡（过渡到自然地形）。
  // 「高度恒定」只对**平台内**成立 ⇒ 采样半径必须收在 `lay.platformRadius` 之内。
  // ⚠️ s1.90：不再从 `plateauRadius - TARN_SLOPE_WIDTH` 推导 —— 那个式子要求两个常量
  //    与 layout 字段三方对齐，其中一个（`poolRadius`）已删；直接用 layout 字段（单一权威）。
  const flatR = lay.platformRadius;
  for (let a = 0; a < 32; a++) {
    const ang = (a / 32) * Math.PI * 2;
    for (const r of [0, flatR * 0.25, flatR * 0.5, flatR * 0.75, flatR - 2]) {
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

test('台地：地带上完全没有水（v1.89 去掉中央水池）', async () => {
  // ⚠️ **用户 2026-10-27 裁定**：「把高台所在的中央水面去掉，完全就用普通的平缓的地形来接续
  // 高台地形旁边的地图」。这不只是观感 —— 体素水占 transparent 通道，去掉它让高台地带与
  // transparent **完全无关**（池面平面、`setTarnPool`、`tarnPoolAt` 一并删除）。
  const { rx, rz } = findTarnRegion();
  const lay = computeTarnZone(rx, rz, SEED);
  const reg = await buildDefaultRegistry();
  const waterId = reg.idOf('water');
  const waterLike = new Set([waterId, reg.idOf('swamp_water')].filter((x) => x !== undefined));
  let waterCells = 0, checked = 0;
  // 扫地带圆内的多个采样点，逐 y 数水格。
  // ⚠️ 半径序列必须全部 < `lay.plateauRadius`（s1.90 = 138）：写 130 已在缓坡带上，
  //    而缓坡带也在整形的范围内，所以仍然是合法采样点；旧序列里的 130 保留。
  for (let a = 0; a < 24; a++) {
    const ang = (a / 24) * Math.PI * 2;
    for (const r of [0, 20, 45, 70, 100, lay.platformRadius - 4, lay.plateauRadius - 4]) {
      const wx = Math.round(lay.cx + r * Math.cos(ang));
      const wz = Math.round(lay.cz + r * Math.sin(ang));
      const { col, lx, lz } = await shapedColumn(lay, wx, wz, reg);
      checked++;
      for (let y = -30; y <= 90; y++) {
        if (waterLike.has(col.blocks[blockIndex(lx, y, lz)])) waterCells++;
      }
    }
  }
  assertTrue(checked > 100, `采样点太少（${checked}）—— 本用例无判别力`);
  assertEqual(waterCells, 0, `地带圆内出现 ${waterCells} 格水（v1.89 起地带必须完全无水）`);
});

test('台地：边缘缓坡接续自然地形（缓坡带内逐格高差 ≤ 1）', async () => {
  // 平台半径 = `lay.platformRadius`；往外 `lay.slopeWidth` 格内线性过渡到自然地形。
  // 判据落在「缓坡带**内部**相邻列的高度差 ≤ 1」（玩家 MAX_STEP = 1.0）。
  //
  // ⚠️⚠️ **采样必须止于 `plateauRadius`，不能跨出去**（v1.90 实测踩坑）：
  //    地带圆外一律不整形，而自然地形本身在圆边缘可能有任意落差（实测 seed 12345 的一个
  //    地带圆边缘从 y=−13 直接跳到 y=−2，跳 11 格）。跨边界采样会把那一下算进「坡面」，
  //    得到的数字对「缓坡是否可走」毫无意义 —— 那是自然地形，不是缓坡。
  // ⚠️ 采样窗口按 `lay.platformRadius` / `lay.slopeWidth` 定长（旧版写死 60 格，
  //    缓坡缩到 24 后起点已钻进平台内，会把平坦平台的 0 高差也算进统计）。
  const { rx, rz } = findTarnRegion();
  const lay = computeTarnZone(rx, rz, SEED);
  const reg = await buildDefaultRegistry();
  let maxJump = 0, samples = 0;
  const from = lay.platformRadius - 4;              // 平台内 4 格起步（确保起点是平的）
  for (let a = 0; a < 24; a++) {
    const ang = (a / 24) * Math.PI * 2;
    const cos = Math.cos(ang), sin = Math.sin(ang);
    let prevY = null;
    for (let r = from; r <= lay.plateauRadius; r += 1) {
      const wx = Math.round(lay.cx + r * cos);
      const wz = Math.round(lay.cz + r * sin);
      // ⚠️ 逐格判半径：`Math.round` 会把点推到圆外，那一格不是缓坡。
      if (Math.hypot(wx - lay.cx, wz - lay.cz) > lay.plateauRadius) break;
      const { col, lx, lz } = await shapedColumn(lay, wx, wz, reg);
      let top = null;
      for (let y = 90; y >= -30; y--) {
        if (col.blocks[blockIndex(lx, y, lz)] !== 0) { top = y; break; }
      }
      if (top !== null && prevY !== null) {
        maxJump = Math.max(maxJump, Math.abs(top - prevY));
        samples++;
      }
      if (top !== null) prevY = top;
    }
  }
  assertTrue(samples > 200, `坡面采样点太少（${samples}）`);
  // 实测（seed 12345 在 ±6 的第一个地带）：缓坡带内逐格最大高差 = 1（完全可走）。
  // ⚠️ 上界不能用 2 或更大：`MAX_STEP = 1.0`，差 2 就是走不上去。
  assertTrue(maxJump <= 1, `缓坡带内逐格最大高差 ${maxJump} > 1 —— 玩家会被挡住（MAX_STEP=1）`);
});


test('台地：台地外的格不被整形（圆外零影响）', async () => {
  // ⚠️ **必须取「部分在圆内、部分在圆外」的边缘 column**：
  // 若取「整列都在圆外」的 column，`fillTarnPlateau` 在外接方形求交时就已经
  // `x0 > x1` 提前 return，根本进不了循环 —— 那种用例即使删掉循环体里的
  // `d2 > platR2 continue` 也测不出差异（负向验证实测：删掉后该用例照样绿）。
  const { rx, rz } = findTarnRegion();
  const lay = computeTarnZone(rx, rz, SEED);
  const reg = await buildDefaultRegistry();
  // 地带圆边缘（半径附近）的 column：列内既有圆内格也有圆外格。
  // ⚠️ **v1.90 从「半径 − 4 的单个点」改为实时筛**：旧写法假设那个点所在的 column
  //    恰好被圆切开 —— 而那依赖地带半径与圆心的具体字节，实测新半径（138）下它整列都在圆内。
  //    现在扫圆心周围的 column，取第一个「0 < 圆内格 < 256」的（实测有 66 个可选）。
  let edge = null;
  for (let dcx = -12; dcx <= 12 && !edge; dcx++) {
    for (let dcz = -12; dcz <= 12 && !edge; dcz++) {
      const tcx = Math.floor(lay.cx / 16) + dcx, tcz = Math.floor(lay.cz / 16) + dcz;
      let inside = 0;
      for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
        const px = tcx * 16 + lx, pz = tcz * 16 + lz;
        if (Math.hypot(px - lay.cx, pz - lay.cz) <= lay.plateauRadius) inside++;
      }
      if (inside > 0 && inside < 256) edge = { cx: tcx, cz: tcz };
    }
  }
  assertTrue(edge !== null, '找不到「部分在圆内、部分在圆外」的 column —— 木地半径或列尺寸变了，须重新标定');
  const cx = edge.cx, cz = edge.cz;
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
  // ⚠️ s1.90：基准从 `poolRadius`（已删）改为 `platformRadius`。采样点必须落在**缓坡带上**
  //    （平台内是恒平的，看不到「原山体」）—— 缓坡带 = `(platformRadius, plateauRadius]`，
  //    取带内两个位置，且都在圆内（圆外不动，本用例就无判别力）。
  let found = null;
  for (let a = 0; a < 16 && !found; a++) {
    const ang = (a / 16) * Math.PI * 2;
    for (const r of [lay.platformRadius + 6, lay.platformRadius + 14]) {
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
  // 整形后该列的目标高度之上不得有方块。
  // ⚠️ **s1.90：采样点在缓坡带上，目标高度不再是 `plateauY`**（那里是插值到自然高度的过渡值），
  //    所以判据用「该列整形后的地表 = 什么」，而不是硬拿 `plateauY` 比 ——
  //    否则缓坡带上的正确定形反而会被判 FAIL。真正要钉的是「原山体被削掉」。
  let shapedTop = null;
  for (let y = 90; y >= -30; y--) {
    if (col.blocks[blockIndex(lx, y, lz)] !== 0) { shapedTop = y; break; }
  }
  assertTrue(shapedTop !== null, '整形后该列必须有地表');
  assertTrue(shapedTop < found.top,
    `原山体（自然顶 y=${found.top}）没有被削平（整形后顶仍是 y=${shapedTop}）`);
  for (let y = shapedTop + 1; y <= 90; y++) {
    assertEqual(col.blocks[blockIndex(lx, y, lz)], 0, `整形后顶面之上还有方块（y=${y}）`);
  }
});
