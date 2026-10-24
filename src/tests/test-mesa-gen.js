// src/tests/test-mesa-gen.js — 高台接线 Tier 1：layout 携带 + 真实 column GEN 逐格落位
//
// 本文件钉的是「接线断了但单测全绿」这一类缺陷（M7 的教训：只测纯函数会漏掉接线）：
//   · layout 没把 mesa 传下去 → GEN 永远看不到锚点，世界里有参数但没高台
//   · apply 阶段 2.75 的让路门控漏了 → 高台落进城市，把城内地面顶穿
//   · rasterize 的 y 参数差一格 → 台体整体下沉，台面被地形覆盖（方块层面看不出是 y 错了）
//
// 断言落点：**真实 applyStructuresToColumn 写出的世界方块**，不是纯函数返回值。
//
// ⚠️ **为什么用 region(1,1) 而不是 region(0,0) 做「合法落位」对照组**（实测得出）：
// 城市固定在 region [0,0] 且 bounds x∈[0,566] z∈[-166,400]，几乎盖满该 region 的
// 沙漠侧（出生点也在城内）。region(0,0) 的锚点 (21,13) **整体落在城内** →
// 让路门控正确地把它丢弃（实测 10 个 region 里只有 (0,0) 命中城市）。
// 拿 (0,0) 测「合法落位」会得到 0 格并误判为接线断开。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { computeRegionLayout } from '../gen/structures/structure-layout.js';
import { computeMesaAnchor } from '../gen/structures/mesa.js';
import { applyStructuresToColumn } from '../gen/structures/apply.js';
import { loadStructure } from '../gen/structures/structure-json.js';
import { buildDefaultRegistry } from '../voxel/block-registry.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { blockIndex } from '../voxel/constants.js';

const SEED = 12345;
/** 合法落位的对照 region（避开城市；实测锚点距各地标中心 ≥100 格） */
const RX = 1, RZ = 1;

test('高台接线：computeRegionLayout 的 mesa 字段与 computeMesaAnchor 一致', () => {
  for (const [rx, rz] of [[0, 0], [1, 0], [1, 1]]) {
    const layout = computeRegionLayout(rx, rz, SEED);
    const direct = computeMesaAnchor(rx, rz, SEED);
    if (direct === null) { assertEqual(layout.mesa, null, `region(${rx},${rz}) 都 null`); continue; }
    assertEqual(layout.mesa.wx, direct.wx, `region(${rx},${rz}) wx`);
    assertEqual(layout.mesa.wz, direct.wz, `region(${rx},${rz}) wz`);
    assertEqual(layout.mesa.floorY, direct.floorY, `region(${rx},${rz}) floorY`);
  }
});

test('高台接线：对照 region 真的有锚点，且它不在城市 bounds 内', () => {
  const a = computeMesaAnchor(RX, RZ, SEED);
  assertTrue(a !== null, `region(${RX},${RZ}) 必须有锚点`);
  const layout = computeRegionLayout(RX, RZ, SEED);
  if (layout.city) {
    const inside = a.wx >= layout.city.minX && a.wx <= layout.city.maxX &&
      a.wz >= layout.city.minZ && a.wz <= layout.city.maxZ;
    assertTrue(!inside, `region(${RX},${RZ}) 的锚点不得在城市 bounds 内`);
  }
});

test('高台接线：真实 GEN 跨 column 汇总写出 ≥95% 的高台方块（类型与 y 都对）', async () => {
  const anchor = computeMesaAnchor(RX, RZ, SEED);
  const data = await loadStructure('cloudlandMesaSmall');
  assertTrue(data.blocks.length > 0, '产物必须能加载（浏览器内 fetch 可用）');
  const reg = await buildDefaultRegistry();

  const cols = new Map();
  for (const b of data.blocks) {
    const wx = anchor.wx + b.x, wz = anchor.wz + b.z;
    const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
    cols.set(`${cx},${cz}`, { cx, cz });
  }
  assertTrue(cols.size >= 4, `高台应跨 ≥4 个 column（实际 ${cols.size}）`);

  const layouts = [computeRegionLayout(RX, RZ, SEED)];
  let matched = 0;
  let air = 0;
  for (const { cx, cz } of cols.values()) {
    const column = new ChunkColumn(cx, cz);
    await applyStructuresToColumn(column, SEED, reg, layouts);
    for (const b of data.blocks) {
      const wx = anchor.wx + b.x, wz = anchor.wz + b.z;
      if (Math.floor(wx / 16) !== cx || Math.floor(wz / 16) !== cz) continue;
      const gotId = column.blocks[blockIndex(wx - cx * 16, anchor.floorY + b.y, wz - cz * 16)];
      if (gotId === reg.idOf(b.type)) matched++;
      else if (gotId === 0) air++;
    }
  }
  // 允许极少数被后写阶段（云/空岛/植被）覆盖，但必须几乎全中
  assertTrue(matched >= 10712 * 0.95,
    `跨 column 汇总应写出 ≥95% 的高台方块（实际 ${matched}/10712，其中空气 ${air} 格 —— 空气多说明 y 或光栅化错）`);
});

test('高台接线：城市 bounds 内的锚点被整片丢弃（region(0,0) 实测命中城市）', async () => {
  const anchor = computeMesaAnchor(0, 0, SEED);
  assertTrue(anchor !== null, '前提：region(0,0) 有锚点（它的锚点整体落在城内）');
  const layout = computeRegionLayout(0, 0, SEED);
  assertTrue(layout.city !== null, 'region(0,0) 有城市');
  // 实测确认这个锚点确实在城内（否则本条测的不是让路逻辑）
  assertTrue(anchor.wx >= layout.city.minX && anchor.wx <= layout.city.maxX &&
             anchor.wz >= layout.city.minZ && anchor.wz <= layout.city.maxZ,
    'region(0,0) 的锚点必须落在城市 bounds 内（实测如此；若变了须重选对照 region）');

  const reg = await buildDefaultRegistry();
  const data = await loadStructure('cloudlandMesaSmall');
  const paletteIds = new Set(data.blocks.map((b) => reg.idOf(b.type)));

  const cx = Math.floor(anchor.wx / 16), cz = Math.floor(anchor.wz / 16);
  const column = new ChunkColumn(cx, cz);
  await applyStructuresToColumn(column, SEED, reg, [layout]);

  // 判据落在「台顶层」：y = floorY + 43 是高台独有的高度，城市建筑不会恰好铺满这一层。
  let topLayer = 0;
  for (const b of data.blocks) {
    if (b.y !== 43) continue;
    const wx = anchor.wx + b.x, wz = anchor.wz + b.z;
    if (Math.floor(wx / 16) !== cx || Math.floor(wz / 16) !== cz) continue;
    const id = column.blocks[blockIndex(wx - cx * 16, anchor.floorY + 43, wz - cz * 16)];
    if (paletteIds.has(id)) topLayer++;
  }
  assertEqual(topLayer, 0, `城内锚点被丢弃 ⇒ 台顶层不得出现高台方块（实际 ${topLayer}）`);
});

test('高台接线对照：同一判据在合法沙漠锚点上必须命中（证明上一条不是恒真）', async () => {
  const anchor = computeMesaAnchor(RX, RZ, SEED);
  const layout = computeRegionLayout(RX, RZ, SEED);
  const reg = await buildDefaultRegistry();
  const data = await loadStructure('cloudlandMesaSmall');
  const paletteIds = new Set(data.blocks.map((b) => reg.idOf(b.type)));

  const cx = Math.floor(anchor.wx / 16), cz = Math.floor(anchor.wz / 16);
  const column = new ChunkColumn(cx, cz);
  await applyStructuresToColumn(column, SEED, reg, [layout]);

  let topLayer = 0;
  for (const b of data.blocks) {
    if (b.y !== 43) continue;
    const wx = anchor.wx + b.x, wz = anchor.wz + b.z;
    if (Math.floor(wx / 16) !== cx || Math.floor(wz / 16) !== cz) continue;
    const id = column.blocks[blockIndex(wx - cx * 16, anchor.floorY + 43, wz - cz * 16)];
    if (paletteIds.has(id)) topLayer++;
  }
  assertTrue(topLayer > 0, `合法锚点的台顶层必须命中（实际 ${topLayer}）`);
});

test('高台接线：巨树给高台让路（占用框内 allowedAt 返回 false）', async () => {
  const { giantAllowedAtFor } = await import('../gen/structures/apply.js');
  const anchor = computeMesaAnchor(RX, RZ, SEED);
  const layout = computeRegionLayout(RX, RZ, SEED);
  const allowed = giantAllowedAtFor([layout], layout.city, SEED);
  assertTrue(allowed(anchor.wx, anchor.wz) === false,
    '高台锚点正上方不得长巨树（否则树干插进台面）');
  assertTrue(allowed(anchor.wx + 40, anchor.wz + 40) === true || allowed(anchor.wx + 40, anchor.wz + 40) === false,
    '调用不抛错（占用框外按 pointContext 正常判定）');
});
