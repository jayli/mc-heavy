// src/tests/test-azalea-trees-gen.js — 杜鹃树 Tier 1：真实 applyStructuresToColumn 接线与确定性
//
// 本文件钉的是**接线层**的风险（纯逻辑单测覆盖不到的那一半）：
//   · 阶段 2.85 真的被调用了（`applyAzaleaTrees` 写了方块）—— 而不是「函数实现对了但没人调」
//     （M6 的「worker 没接线」是同型静默失效：树照常生成别的，肉眼看不出缺了什么）；
//   · 旧的代码生成小树真的停了（`rollVegetation` 的 AZALEA 分支返回空）；
//   · 确定性：两次生成逐格一致（红线 2 —— 世界由 seed 确定性重建，存档只存 edits diff）；
//   · 覆盖窗口真的抑制了旧树（不是「新旧叠在一起」）。
//
// ⚠️ 写断言前先在真实数据上跑一次（testing-policy §2.6 ⑤）：本文件的所有阈值都取自实测。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertNotNull } from './assert.js';
import { computeRegionLayout, neighborRegionKeys } from '../gen/structures/structure-layout.js';
import { applyStructuresToColumn, azaleaAllowedAtFor } from '../gen/structures/apply.js';
import { rollVegetation } from '../gen/structures/vegetation.js';
import { applyAzaleaTrees, loadAzaleaTrees } from '../gen/structures/azalea-trees.js';
import { getBiome } from '../gen/noise.js';
import { fillColumn, generateHeight } from '../gen/terrain.js';
import { carveCaves } from '../gen/caves.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { blockIndex } from '../voxel/constants.js';

const SEED = 12345;

function makeRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}

function layoutsFor(cx, cz) {
  const out = [];
  for (const key of neighborRegionKeys(cx, cz)) {
    const [rx, rz] = key.split(',').map(Number);
    out.push(computeRegionLayout(rx, rz, SEED));
  }
  return out;
}

async function genColumn(reg, cx, cz) {
  const col = new ChunkColumn(cx, cz);
  fillColumn(col, SEED, reg);
  carveCaves(col, SEED);
  await applyStructuresToColumn(col, SEED, reg, layoutsFor(cx, cz));
  return col;
}

/**
 * 找一个「有杜鹃树候选、且不被城市吞没」的 column。
 * ⚠️ 必须按**真实的 allowedAt 判据**筛，不能只按 biome + 距离猜 —— 巨树 Epic 的 E2E 就是
 * 按「离出生点最近」选的视域，结果候选全在城市边界外、被 pointContext 拒掉，用例假失败。
 */
function findAzaleaColumn() {
  const city = computeRegionLayout(0, 0, SEED).city;
  for (let rx = -2; rx <= 2; rx++) {
    for (let rz = -2; rz <= 2; rz++) {
      const layouts = layoutsFor(rx * 25, rz * 25);
      const arr = computeRegionLayout(rx, rz, SEED).azaleaTrees;
      if (!arr || arr.length === 0) continue;
      for (let i = 0; i < arr.length; i += 4) {
        const wx = arr[i], wz = arr[i + 2];
        const allowed = azaleaAllowedAtFor(layouts, city, SEED);
        if (!allowed(wx, wz)) continue;
        const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
        // 再确认整棵树（AABB 九点）都允许 —— 否则 applyAzaleaTrees 会整棵拒掉
        let allOk = true;
        for (const dx of [-6, 0, 6]) for (const dz of [-6, 0, 6]) if (!allowed(wx + dx, wz + dz)) allOk = false;
        if (!allOk) continue;
        return { cx, cz, wx, wz };
      }
    }
  }
  return null;
}

test('AZALEA 植被：旧的代码生成小树已停用（rollVegetation 不再返回 tree）', () => {
  // 扫一片真实的 AZALEA 区域，确认没有任何点会返回旧树
  let azaleaPoints = 0, oldTrees = 0;
  for (let wx = -1500; wx <= 1500; wx += 7) {
    for (let wz = -1500; wz <= 1500; wz += 7) {
      if (getBiome(wx, wz, SEED) !== 'AZALEA') continue;
      azaleaPoints++;
      if (rollVegetation(wx, wz, 'AZALEA', SEED).tree) oldTrees++;
    }
  }
  assertTrue(azaleaPoints > 1000, `采样到 ${azaleaPoints} 个 AZALEA 点（判据必须有量）`);
  assertEqual(oldTrees, 0, `旧小树命中 ${oldTrees} 次（必须为 0：新树由阶段 2.85 生成）`);
});

test('接线：真实 GEN 后 column 里有杜鹃树方块（新树真的长出来了）', async () => {
  const reg = makeRegistry();
  const spot = findAzaleaColumn();
  assertNotNull(spot, '找到有杜鹃树落位的 column');
  const col = await genColumn(reg, spot.cx, spot.cz);
  const logId = reg.idOf('azalea_log'), leafId = reg.idOf('azalea_leaves'), flowerId = reg.idOf('azalea_flowers');
  let logs = 0, leaves = 0, flowers = 0;
  for (let i = 0; i < col.blocks.length; i++) {
    const id = col.blocks[i];
    if (id === logId) logs++;
    else if (id === leafId) leaves++;
    else if (id === flowerId) flowers++;
  }
  assertTrue(logs > 0, `column(${spot.cx},${spot.cz}) 有 azalea_log ${logs} 格`);
  assertTrue(leaves + flowers > 0, `有杜鹃叶 ${leaves + flowers} 格（叶 ${leaves} / 花 ${flowers}）`);
  // 花叶相间：两者都要出现（单棵 660 格叶，30% 规则下极不可能全是一种）
  assertTrue(flowers > 0, `有带花叶 ${flowers} 格（30% 相间规则生效）`);
  assertTrue(leaves > 0, `有无花叶 ${leaves} 格`);
});

test('接线：杜鹃树方块全部落在地表之上（不埋进地下、不悬在半空）', async () => {
  const reg = makeRegistry();
  const spot = findAzaleaColumn();
  assertNotNull(spot, '找到有杜鹃树落位的 column');
  const col = await genColumn(reg, spot.cx, spot.cz);
  const ids = new Set([reg.idOf('azalea_log'), reg.idOf('azalea_leaves'), reg.idOf('azalea_flowers')]);
  let minY = Infinity, maxY = -Infinity, n = 0;
  for (let i = 0; i < col.blocks.length; i++) {
    if (!ids.has(col.blocks[i])) continue;
    // index → y（blockIndex 的逆，见 constants.js:27-30）
    const y = Math.floor(i / 256) + (-32);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y); n++;
  }
  assertTrue(n > 0, '有杜鹃树方块');
  const groundH = generateHeight(spot.wx, spot.wz, SEED);
  // 最低格必须在地表附近（±AZALEA_SUPPORT_MAX 内：地基填充会把树干补到地表）
  assertTrue(minY >= groundH - 1 && minY <= groundH + 2,
    `最低杜鹃方块 y=${minY} 应贴地表 ${groundH}（±2 容差）`);
  // 最高格 = 最低 + 树高（≤29，最大档）
  assertTrue(maxY - minY <= 30, `树高 ${maxY - minY + 1} ≤ 30（最大档 29）`);
  assertTrue(maxY - minY >= 11, `树高 ${maxY - minY + 1} ≥ 12（最小档 12）`);
});

test('确定性：同一 column 两次 GEN 逐格一致（红线 2）', async () => {
  const reg = makeRegistry();
  const spot = findAzaleaColumn();
  assertNotNull(spot, '找到有杜鹃树落位的 column');
  const a = await genColumn(reg, spot.cx, spot.cz);
  const b = await genColumn(reg, spot.cx, spot.cz);
  for (let i = 0; i < a.blocks.length; i++) {
    assertEqual(a.blocks[i], b.blocks[i], `block ${i}`);
  }
});

test('覆盖窗口：新树覆盖区内的旧植被树被抑制（旧树的 wood 不再出现）', async () => {
  await loadAzaleaTrees();
  const reg = makeRegistry();
  const spot = findAzaleaColumn();
  assertNotNull(spot, '找到有杜鹃树落位的 column');
  const layouts = layoutsFor(spot.cx, spot.cz);
  const city = computeRegionLayout(0, 0, SEED).city;

  // 手工调 applyAzaleaTrees 拿覆盖窗口（与 apply.js 阶段 2.85 同一份判据）
  const probe = new ChunkColumn(spot.cx, spot.cz);
  const cover = applyAzaleaTrees(probe, layouts, SEED, reg, {
    ext: 3, allowedAt: azaleaAllowedAtFor(layouts, city, SEED),
  });
  // 覆盖窗口必须真的标出了东西（否则下面的断言恒真）
  let covered = 0;
  for (let wx = spot.cx * 16 - 3; wx <= spot.cx * 16 + 18; wx++) {
    for (let wz = spot.cz * 16 - 3; wz <= spot.cz * 16 + 18; wz++) if (cover.covers(wx, wz)) covered++;
  }
  assertTrue(covered > 50, `覆盖窗口标出 ${covered} 个格（判据必须有量）`);

  // 真实 GEN 出来的 column 里，覆盖区内的普通树（wood 树干）必须为 0 ——
  // 因为 AZALEA biome 的旧杜鹃树已停用，而这里覆盖的正是杜鹃树的栖息地。
  const col = await genColumn(reg, spot.cx, spot.cz);
  const woodId = reg.idOf('wood');
  let woodInCover = 0;
  for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
    const wx = spot.cx * 16 + lx, wz = spot.cz * 16 + lz;
    if (!cover.covers(wx, wz)) continue;
    for (let y = 0; y < 96; y++) if (col.blocks[blockIndex(lx, y, lz)] === woodId) woodInCover++;
  }
  assertEqual(woodInCover, 0, `覆盖区内普通树干 ${woodInCover} 格（应为 0）`);
});
