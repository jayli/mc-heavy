// src/tests/test-tarn-zone-gen.js — 高台地带接线 Tier 1：真实 column GEN
//
// 钉的是「接线断了但纯函数全绿」这类缺陷（M7 教训：只测 API 漏玩家主路径）：
//   · structure-json 漏一个变体的映射 → `rasterizeStructure` 拿到空 blocks 直接 return
//     → 那个变体静默不出现（35 个里漏一个，肉眼几乎看不出）
//   · 阶段 2.4 的层序错了 → 高台被台地整形覆盖掉，只剩一圈平地
//   · y 传成 `plateauY + 1` → 整座高台悬在水面上方一格（地上看不见，只是台子浮着）
//   · `pointContext` 没加 `kind:'tarn'` → 地带台地上长满树
//
// ⚠️ 每个用例都必须 **先 `fillColumn` 再 `applyStructuresToColumn`**（真实生成路径）：
// 空 column 上很多断言会平凡通过（B5）。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { computeRegionLayout } from '../gen/structures/structure-layout.js';
import { isTarnZone } from '../gen/structures/tarn-zone.js';
import { applyStructuresToColumn } from '../gen/structures/apply.js';
import { KIT_VARIANTS } from '../gen/structures/cloudland-kit-data.js';
import { STRUCTURE_FILES } from '../gen/structures/structure-json.js';
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

/** 把地带圆内所有 column 走一遍真实 GEN，回调每格 */
async function forEachTarnCell(lay, reg, fn) {
  const layouts = [computeRegionLayout(lay.regionX, lay.regionZ, SEED)];
  const ccx = Math.floor(lay.cx / 16), ccz = Math.floor(lay.cz / 16);
  const rCols = Math.ceil(lay.plateauRadius / 16) + 1;
  for (let dcx = -rCols; dcx <= rCols; dcx++) {
    for (let dcz = -rCols; dcz <= rCols; dcz++) {
      const col = new ChunkColumn(ccx + dcx, ccz + dcz);
      fillColumn(col, SEED, reg);
      await applyStructuresToColumn(col, SEED, reg, layouts);
      for (let lx = 0; lx < 16; lx++) {
        for (let lz = 0; lz < 16; lz++) {
          const wx = col.cx * 16 + lx, wz = col.cz * 16 + lz;
          if (Math.hypot(wx - lay.cx, wz - lay.cz) > lay.plateauRadius) continue;
          fn(col, lx, lz, wx, wz);
        }
      }
    }
  }
}

function tarnLayoutOf(rx, rz) {
  return { ...computeRegionLayout(rx, rz, SEED).tarn, regionX: rx, regionZ: rz };
}

test('地带接线：35 个变体全部登记进 STRUCTURE_FILES', () => {
  const all = [...KIT_VARIANTS.tarn, ...KIT_VARIANTS.arch, ...KIT_VARIANTS.spire, ...KIT_VARIANTS.giantCloud];
  assertEqual(all.length, 35, '四族合计 35 个变体');
  const missing = all.filter((b) => !STRUCTURE_FILES[b]);
  assertEqual(missing.length, 0, `未登记的变体：${missing.join(',')}`);
  // 文件名必须是 `<基名>.json`
  for (const b of all) {
    assertEqual(STRUCTURE_FILES[b], `${b}.json`, `${b} 的文件名映射`);
  }
});

test('地带接线：layout 的 tarn 与 computeTarnZone 一致', () => {
  const { rx, rz } = findTarnRegion();
  const l = computeRegionLayout(rx, rz, SEED);
  assertTrue(l.tarn !== null, 'layout.tarn 有值');
  assertEqual(l.tarn.tarns.length, 8, '8 座高台');
  assertEqual(l.tarn.decos.length, 12, '12 个装饰件（5 拱洞 + 7 紫晶柱）');
  assertEqual(l.tarn.clouds.length, 4, '4 朵巨型云');
});

test('地带接线：台地那一层同时出现 grass 与 stone（草石镶嵌真的落地）', async () => {
  const { rx, rz } = findTarnRegion();
  const lay = tarnLayoutOf(rx, rz);
  const reg = await buildDefaultRegistry();
  const grassId = reg.idOf('grass'), stoneId = reg.idOf('stone'), waterId = reg.idOf('water');
  let hasGrass = false, hasStone = false, hasWater = false;
  await forEachTarnCell(lay, reg, (col, lx, lz) => {
    const id = col.blocks[blockIndex(lx, lay.plateauY, lz)];
    if (id === grassId) hasGrass = true;
    else if (id === waterId) hasWater = true;
    else if (id === stoneId) hasStone = true;
  });
  assertTrue(hasGrass, '台地层必须有 grass');
  assertTrue(hasStone, '台地层必须有 stone（草石镶嵌两种都要出现）');
  // ⚠️ v1.89：中央水池已删除，地带内不得出现任何水（用户 2026-10-27 裁定）
  assertTrue(!hasWater, '台地层不得出现 water（v1.89 起地带完全无水）');
});

test('地带接线：地带上空不出现空岛方块', async () => {
  const { rx, rz } = findTarnRegion();
  const lay = tarnLayoutOf(rx, rz);
  const reg = await buildDefaultRegistry();
  const skyIds = new Set([reg.idOf('sky_stone'), reg.idOf('sky_grass')]);
  const layouts = [computeRegionLayout(rx, rz, SEED)];
  const ccx = Math.floor(lay.cx / 16), ccz = Math.floor(lay.cz / 16);
  const rCols = Math.ceil(lay.plateauRadius / 16) + 1;
  let hits = 0;
  for (let dcx = -rCols; dcx <= rCols; dcx++) {
    for (let dcz = -rCols; dcz <= rCols; dcz++) {
      const col = new ChunkColumn(ccx + dcx, ccz + dcz);
      fillColumn(col, SEED, reg);
      await applyStructuresToColumn(col, SEED, reg, layouts);
      for (let i = 0; i < col.blocks.length; i++) if (skyIds.has(col.blocks[i])) hits++;
    }
  }
  assertEqual(hits, 0, '地带上空不得有空岛方块');
});

test('地带接线：8 座高台真的写进了世界（不是只有 layout）', async () => {
  const { rx, rz } = findTarnRegion();
  const lay = tarnLayoutOf(rx, rz);
  const reg = await buildDefaultRegistry();
  // 每座高台的「中心柱」必须比台地地表高 —— 高台是 3D 结构，中心必然有方块
  let raised = 0;
  for (const t of lay.tarns) {
    const wx = Math.round(lay.cx + t.ring * Math.cos(t.ang));
    const wz = Math.round(lay.cz + t.ring * Math.sin(t.ang));
    const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
    const col = new ChunkColumn(cx, cz);
    fillColumn(col, SEED, reg);
    await applyStructuresToColumn(col, SEED, reg, [computeRegionLayout(rx, rz, SEED)]);
    let top = null;
    for (let y = 90; y >= -30; y--) {
      if (col.blocks[blockIndex(wx - cx * 16, y, wz - cz * 16)] !== 0) { top = y; break; }
    }
    assertTrue(top !== null && top > lay.plateauY,
      `高台 ${t.variant} 的中心柱顶 y=${top} 必须高于台地地表 ${lay.plateauY}（结构没写进世界？）`);
    raised++;
  }
  assertEqual(raised, 8, '8 座高台全部核对');
});

test('地带接线：高台基座贴地（不悬在水面上方）', async () => {
  const { rx, rz } = findTarnRegion();
  const lay = tarnLayoutOf(rx, rz);
  const reg = await buildDefaultRegistry();
  // 每座高台中心柱的「最低非空气格」必须 = plateauY（坐在台地地表上），
  // 否则整座悬空 —— 传 plateauY+1 的形态就是最低格 = plateauY+1。
  for (const t of lay.tarns) {
    const wx = Math.round(lay.cx + t.ring * Math.cos(t.ang));
    const wz = Math.round(lay.cz + t.ring * Math.sin(t.ang));
    const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
    const col = new ChunkColumn(cx, cz);
    fillColumn(col, SEED, reg);
    await applyStructuresToColumn(col, SEED, reg, [computeRegionLayout(rx, rz, SEED)]);
    let bottom = null;
    for (let y = -30; y <= 90; y++) {
      const id = col.blocks[blockIndex(wx - cx * 16, y, wz - cz * 16)];
      // 台地整形已经填了 plateauY 以下，所以只看 plateauY 及以上的第一格
      if (y >= lay.plateauY && id !== 0) { bottom = y; break; }
    }
    assertEqual(bottom, lay.plateauY,
      `高台 ${t.variant} 的最低格应在 plateauY(${lay.plateauY})，实际 ${bottom} —— 传成 plateauY+1 就会悬空一格`);
  }
});

test('地带接线：12 个装饰件真的写进了世界', async () => {
  const { rx, rz } = findTarnRegion();
  const lay = tarnLayoutOf(rx, rz);
  const reg = await buildDefaultRegistry();
  const layout = computeRegionLayout(rx, rz, SEED);
  for (const d of lay.decos) {
    const wx = Math.round(lay.cx + d.ring * Math.cos(d.ang));
    const wz = Math.round(lay.cz + d.ring * Math.sin(d.ang));
    const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
    const col = new ChunkColumn(cx, cz);
    fillColumn(col, SEED, reg);
    await applyStructuresToColumn(col, SEED, reg, [layout]);
    // 装饰件中心柱在它自己的 y 基准之上必须有方块
    const baseY = d.kind === 'arch' ? lay.plateauY + 1 : lay.plateauY;
    let found = false;
    for (let y = baseY; y <= 90; y++) {
      if (col.blocks[blockIndex(wx - cx * 16, y, wz - cz * 16)] !== 0) { found = true; break; }
    }
    assertTrue(found, `${d.kind}/${d.variant} 在中心柱 (${wx},${wz}) 的 y>=${baseY} 没有任何方块（没写进世界？）`);
  }
});

test('地带接线：地带台地上不长树（pointContext 的 kind:tarn 生效）', async () => {
  const { rx, rz } = findTarnRegion();
  const lay = tarnLayoutOf(rx, rz);
  const reg = await buildDefaultRegistry();
  // 只数「植被木头」：`wood` / `planks` 族。⚠️ **不能把 `mossy_stone` / `leaves` 算进来**
  // —— 高台自己的 palette 就含 `mossy_stone`（木族映射目标），会把结果污染成恒真。
  const woodIds = new Set();
  for (const n of ['wood', 'oak_planks', 'birch_planks', 'dark_oak_planks']) {
    const id = reg.idOf(n);
    if (id !== undefined) woodIds.add(id);
  }
  assertTrue(woodIds.size > 0, '至少要能取到一个木族方块 id，否则本用例无判别力');
  let woodHits = 0;
  await forEachTarnCell(lay, reg, (col, lx, lz) => {
    for (let y = lay.plateauY + 2; y <= 90; y++) {
      if (woodIds.has(col.blocks[blockIndex(lx, y, lz)])) woodHits++;
    }
  });
  assertEqual(woodHits, 0,
    `地带台地上方出现 ${woodHits} 格木族方块 —— pointContext 的 kind:'tarn' 分支可能没生效（台地上长树了）`);
});
