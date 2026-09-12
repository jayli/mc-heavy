import { test } from './runner.js';
import { assertEqual, assertTrue, assertNotNull } from './assert.js';
import { computeRegionLayout } from '../gen/structures/structure-layout.js';
import { applyStructuresToColumn } from '../gen/structures/apply.js';
import { getCitySurfaceY } from '../gen/structures/city-layout.js';
import { getSnowLandInfo, getFrozenMountainInfo, getIslandInfo, getCityInfo, getCityFinalSurfaceY } from '../gen/structures/landmarks.js';
import { generateHeight, generateHeightForBiome, fillColumn } from '../gen/terrain.js';
import { carveCaves } from '../gen/caves.js';
import { noise } from '../gen/noise.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { SEA_Y } from '../voxel/constants.js';

const SEED = 12345;

function makeRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}

async function genColumn(reg, cx, cz, layouts) {
  const col = new ChunkColumn(cx, cz);
  await applyStructuresToColumn(col, SEED, reg, layouts);
  return col;
}

/** 完整生成管线（对齐 world-worker.js：fillColumn → carveCaves → 结构注入） */
async function genColumnWithTerrain(reg, cx, cz, layouts) {
  const col = new ChunkColumn(cx, cz);
  fillColumn(col, SEED, reg);
  carveCaves(col, SEED);
  await applyStructuresToColumn(col, SEED, reg, layouts);
  return col;
}

test('generateHeightForBiome: CITY 压平分支（mc-lite h*0.25+1）', () => {
  const x = 100, z = 100;
  // 基础噪声高度（未做 biome 调整），各分支在基础值上施加系数
  const base = Math.floor(noise(x, z, SEED, 0.08) + noise(x, z, SEED, 0.02) * 3);
  assertEqual(generateHeightForBiome(x, z, SEED, 'CITY'), Math.floor(base * 0.25 + 1));
  assertEqual(generateHeightForBiome(x, z, SEED, 'DESERT'), Math.floor(base * 0.5 + 2));
  assertEqual(generateHeightForBiome(x, z, SEED, 'SWAMP'), Math.floor(base * 0.3 - 2));
  assertEqual(generateHeightForBiome(x, z, SEED, 'PLAINS'), base);
});

test('getCityInfo/getSnowLandInfo/getFrozenMountainInfo/getIslandInfo/getPlainLandInfo: 中心点命中', () => {
  const layout = computeRegionLayout(0, 0, SEED);
  const city = layout.city;
  assertNotNull(city, 'city exists');
  const ci = getCityInfo(city.centerX, city.centerZ, city);
  assertNotNull(ci, 'city center inside');
  assertEqual(ci.transitionFactor, 0);
  // 城外必 null
  assertTrue(getCityInfo(city.maxX + 1, city.centerZ, city) === null, 'outside city null');

  const si = getSnowLandInfo(layout.snowLand.cx, layout.snowLand.cz, layout.snowLand, SEED);
  assertNotNull(si, 'snowLand center inside');
  assertEqual(si.zone, 'core');

  const fi = getFrozenMountainInfo(layout.frozenMountain.cx, layout.frozenMountain.cz, layout.frozenMountain, SEED);
  assertNotNull(fi, 'frozenMountain center inside');
  assertTrue(fi.layerHeight > 0, 'mountain has height');

  if (layout.island) {
    const ii = getIslandInfo(layout.island.cx, layout.island.cz, layout.island, SEED);
    assertNotNull(ii, 'island center inside');
  }
});

test('城市地形：核心地表 = getCitySurfaceY，sand/clay/moss 成片', async () => {
  const reg = makeRegistry();
  const layout = computeRegionLayout(0, 0, SEED);
  const city = layout.city;
  const cx = Math.floor(city.centerX / 16), cz = Math.floor(city.centerZ / 16);
  const col = await genColumn(reg, cx, cz, [layout]);
  const lx = city.centerX - cx * 16, lz = city.centerZ - cz * 16;
  const surfaceY = getCitySurfaceY(city.centerX, city.centerZ, city, SEED);
  const topId = col.get(lx, surfaceY, lz);
  const names = ['sand', 'clay', 'moss'];
  const topName = names.find((n) => reg.idOf(n) === topId);
  assertTrue(topName !== undefined, `city surface is sand/clay/moss, got id ${topId}`);
  // 地表下方 11 层为 subType（sand/clay），k=11 end_stone
  const subId = col.get(lx, surfaceY - 1, lz);
  assertTrue(subId === reg.idOf('sand') || subId === reg.idOf('clay'), 'sub layer sand/clay');
  assertEqual(col.get(lx, surfaceY - 11, lz), reg.idOf('end_stone'));
  // 城市中心被 castle 覆盖（底面 surfaceY+1），上方 air 断言改到无 placement 的点
  const all = [...city.placements, ...city.fillerPlacements];
  let clearPt = null;
  for (let tx = city.minX + 40; tx < city.maxX - 40 && !clearPt; tx += 7) {
    for (let tz = city.minZ + 40; tz < city.maxZ - 40 && !clearPt; tz += 7) {
      const nearPlacement = all.some((p) => Math.abs(p.x - tx) < 30 && Math.abs(p.z - tz) < 30);
      if (!nearPlacement) clearPt = { x: tx, z: tz };
    }
  }
  assertNotNull(clearPt, 'found placement-free city point');
  const ccx = Math.floor(clearPt.x / 16), ccz = Math.floor(clearPt.z / 16);
  const col2 = await genColumn(reg, ccx, ccz, [layout]);
  const sy2 = getCitySurfaceY(clearPt.x, clearPt.z, city, SEED);
  assertEqual(col2.get(clearPt.x - ccx * 16, sy2 + 1, clearPt.z - ccz * 16), 0, 'above surface air');
});

test('城市地形确定性：两次生成逐格一致', async () => {
  const reg = makeRegistry();
  const layout = computeRegionLayout(0, 0, SEED);
  const city = layout.city;
  const cx = Math.floor(city.centerX / 16), cz = Math.floor(city.centerZ / 16);
  const a = await genColumn(reg, cx, cz, [layout]);
  const b = await genColumn(reg, cx, cz, [layout]);
  for (let i = 0; i < a.blocks.length; i++) assertEqual(a.blocks[i], b.blocks[i], `block ${i}`);
});

test('雪地：核心地表 snow_grass（海底则 sand）', async () => {
  const reg = makeRegistry();
  // 找一个 snowLand 不被城市吞没的 region（城市优先级是 mc-lite 原语义）
  const city = computeRegionLayout(0, 0, SEED).city;
  let layout = null;
  for (let rx = -4; rx <= 4 && !layout; rx++) {
    for (let rz = -4; rz <= 4 && !layout; rz++) {
      if (rx === 0 && rz === 0) continue;
      const l = computeRegionLayout(rx, rz, SEED);
      const sl0 = l.snowLand;
      if (sl0.cx + 28 < city.minX || sl0.cx - 28 > city.maxX ||
          sl0.cz + 28 < city.minZ || sl0.cz - 28 > city.maxZ) layout = l;
    }
  }
  assertNotNull(layout, 'found snowLand region outside city');
  const sl = layout.snowLand;
  const cx = Math.floor(sl.cx / 16), cz = Math.floor(sl.cz / 16);
  const col = await genColumn(reg, cx, cz, [layout]);
  const lx = sl.cx - cx * 16, lz = sl.cz - cz * 16;
  const h = generateHeight(sl.cx, sl.cz, SEED);
  const info = getSnowLandInfo(sl.cx, sl.cz, sl, SEED);
  let finalY = h + info.heightOffset;
  if (Math.abs(finalY - h) > 2) finalY = h + Math.sign(finalY - h) * 2;
  const belowSea = finalY <= SEA_Y - 1;
  const expectId = reg.idOf(belowSea ? 'sand' : 'snow_grass');
  assertEqual(col.get(lx, finalY, lz), expectId, `snowLand surface at ${finalY}`);
});

test('冰封山：核心地表 snow_grass + 山体抬升', async () => {
  const reg = makeRegistry();
  const layout = computeRegionLayout(1, 0, SEED);
  const fm = layout.frozenMountain;
  const cx = Math.floor(fm.cx / 16), cz = Math.floor(fm.cz / 16);
  const col = await genColumn(reg, cx, cz, [layout]);
  const lx = fm.cx - cx * 16, lz = fm.cz - cz * 16;
  const h = generateHeight(fm.cx, fm.cz, SEED);
  const info = getFrozenMountainInfo(fm.cx, fm.cz, fm, SEED);
  const finalY = h + info.layerHeight;
  const belowSea = finalY <= SEA_Y - 1;
  const expectId = reg.idOf(belowSea ? 'sand' : 'snow_grass');
  assertEqual(col.get(lx, finalY, lz), expectId, 'mountain top snow_grass');
  assertTrue(finalY > h, 'mountain raises terrain');
});

test('海岛：表面齐海平面，内 stone 边 sand，塔心除外', async () => {
  const reg = makeRegistry();
  // 找一个有海岛的 region
  let layout = null;
  for (let rx = -3; rx <= 3 && !layout; rx++) {
    for (let rz = -3; rz <= 3 && !layout; rz++) {
      const l = computeRegionLayout(rx, rz, SEED);
      if (l.island) layout = l;
    }
  }
  assertNotNull(layout, 'found island region');
  const island = layout.island;
  const cx = Math.floor(island.cx / 16), cz = Math.floor(island.cz / 16);
  const col = await genColumn(reg, cx, cz, [layout]);
  const lz = island.cz - cz * 16;
  // 中心点：tower JSON 会覆盖，跳过；取距中心 3 格的点（内部 stone 区）
  const px = island.cx + 3;
  if (Math.floor(px / 16) === cx) {
    const top = col.get(px - cx * 16, SEA_Y, lz);
    assertEqual(top, reg.idOf('stone'), 'island interior stone at sea level');
    assertEqual(col.get(px - cx * 16, SEA_Y - 1, lz), reg.idOf('dirt'), 'dirt under surface');
  }
});

test('JSON 结构光栅化：城市 tower/城堡方块注入 column（确定性）', async () => {
  const reg = makeRegistry();
  const layout = computeRegionLayout(0, 0, SEED);
  const city = layout.city;
  // castle 中心 column：castle JSON 底层 47×53 范围，中心点必有 castle 方块
  const cx = Math.floor(city.centerX / 16), cz = Math.floor(city.centerZ / 16);
  const a = await genColumn(reg, cx, cz, [layout]);
  const b = await genColumn(reg, cx, cz, [layout]);
  for (let i = 0; i < a.blocks.length; i++) assertEqual(a.blocks[i], b.blocks[i], `block ${i}`);
  // castle 覆盖中心 column（47×53 占地）：整列地表以上应有大量结构方块、且高度显著
  // （中心点正上方是中庭天井，不能用单点断言）
  const surfaceY = getCitySurfaceY(city.centerX, city.centerZ, city, SEED);
  let above = 0, topY = surfaceY;
  for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
    for (let y = surfaceY + 1; y < 96; y++) {
      if (a.get(lx, y, lz) !== 0) { above++; if (y > topY) topY = y; }
    }
  }
  assertTrue(above > 500, `castle blocks above surface: ${above}`);
  assertTrue(topY - surfaceY > 20, `castle height: ${topY - surfaceY}`);
});

test('JSON 结构跨 column 裁剪：castle 覆盖的相邻 column 也有结构方块', async () => {
  const reg = makeRegistry();
  const layout = computeRegionLayout(0, 0, SEED);
  const city = layout.city;
  // castle halfX=23 → 中心 ±23；取东侧 +20 所在 column（若跨界则是相邻 column）
  const px = city.centerX + 20, pz = city.centerZ;
  const cx = Math.floor(px / 16), cz = Math.floor(pz / 16);
  const col = await genColumn(reg, cx, cz, [layout]);
  const surfaceY = getCitySurfaceY(px, pz, city, SEED);
  const lx = px - cx * 16, lz = pz - cz * 16;
  assertTrue(col.get(lx, surfaceY + 1, lz) !== 0, 'castle block at footprint edge');
});

test('ground support：结构底面悬空 ≤5 格补支撑柱', async () => {
  const reg = makeRegistry();
  const layout = computeRegionLayout(0, 0, SEED);
  const city = layout.city;
  // 找一个 placement（非 castle）：其地表高度由 getCitySurfaceY 决定；
  // 支撑柱逻辑的普适验证：任取 placement，其底面正下方第一格应为结构方块或地形（无空气缝）
  const p = city.placements.find((pl) => pl.type === 'gate');
  assertNotNull(p, 'gate placed');
  const cx = Math.floor(p.x / 16), cz = Math.floor(p.z / 16);
  const col = await genColumn(reg, cx, cz, [layout]);
  const surfaceY = getCitySurfaceY(p.x, p.z, city, SEED);
  const lx = p.x - cx * 16, lz = p.z - cz * 16;
  // gate 底面在 surfaceY+1；surfaceY 处是城市地表（非 air）
  assertTrue(col.get(lx, surfaceY, lz) !== 0, 'ground under gate solid');
});

// ---- 城市覆写残留自然地形清除（M2 收尾：残丘非悬空，底部接地）----
// 复现点由固定 seed 搜索得出：自然高度 > 城市地表、无建筑 footprint、无邻树干扰。
// fillColumn 按自然 biome 预填整列，generateCity 仅覆写至城市地表；
// 自然高度高于城市地表的列会残留接地的自然地形丘（grass/dirt/stone），凸出于城市地表。
test('城市残丘清除：城内列地表上方无自然地形残留（grass/dirt/stone）', async () => {
  const reg = makeRegistry();
  const layout = computeRegionLayout(0, 0, SEED);
  const city = layout.city;
  // 固定复现点 (32,-107)：naturalH=6, citySurfaceY=4, gap=2, 无建筑/无树
  const wx = 32, wz = -107;
  const ci = getCityInfo(wx, wz, city);
  assertNotNull(ci, 'point inside city');
  const naturalH = generateHeight(wx, wz, SEED);
  const surfaceY = getCityFinalSurfaceY(wx, wz, ci, SEED);
  assertTrue(naturalH > surfaceY, `fixture precondition: naturalH(${naturalH}) > surfaceY(${surfaceY})`);

  const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
  const col = await genColumnWithTerrain(reg, cx, cz, [layout]);
  const lx = wx - cx * 16, lz = wz - cz * 16;

  // 城市地表本身存在
  assertTrue(col.get(lx, surfaceY, lz) !== 0, 'city surface present');
  // 地表上方直到自然高度：必须全为 air（残丘已清除）
  for (let y = surfaceY + 1; y <= naturalH; y++) {
    assertEqual(col.get(lx, y, lz), 0, `residue cleared at y=${y}`);
  }
});

test('城市残丘清除：城内树木植根于城市地表而非残留丘顶', async () => {
  const reg = makeRegistry();
  const layout = computeRegionLayout(0, 0, SEED);
  const city = layout.city;
  // 固定复现点 (52,222)：swamp 树，naturalH=7, citySurfaceY=5, gap=2, 无建筑/无邻树
  const wx = 52, wz = 222;
  const ci = getCityInfo(wx, wz, city);
  assertNotNull(ci, 'point inside city');
  const naturalH = generateHeight(wx, wz, SEED);
  const surfaceY = getCityFinalSurfaceY(wx, wz, ci, SEED);
  assertTrue(naturalH > surfaceY, `fixture precondition: naturalH(${naturalH}) > surfaceY(${surfaceY})`);

  const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
  const col = await genColumnWithTerrain(reg, cx, cz, [layout]);
  const lx = wx - cx * 16, lz = wz - cz * 16;

  // 树干（wood）应植根于城市地表上方第一格，而非残留丘顶（naturalH+1）
  assertEqual(col.get(lx, surfaceY + 1, lz), reg.idOf('wood'), 'trunk rooted at city surface');
  // 残留丘位置（naturalH 处）不再是 grass/dirt，而是树干或 air
  const atNaturalH = col.get(lx, naturalH, lz);
  assertTrue(atNaturalH === reg.idOf('wood') || atNaturalH === 0,
    `no grass/dirt mound at naturalH (got id ${atNaturalH})`);
});

test('城市内无水体残留：地表下挖不遇到悬空水格（mc-lite 分支链语义）', async () => {
  // mc-lite 的列循环是 elif 链 `if (inCity) → … → else if (h < wLvl)` 填水 —— 城市与填水体
  // **互斥**，城内永不填水。mc-heavy 是两阶段：`fillColumn` 无条件填整列（含水体
  // `(naturalH, SEA_Y]`）+ `generateCity` 覆写。覆写范围 = 地表填充 `[fillStartY, surfaceY]`
  // + 岩石层 `[surfaceY-12, surfaceY-1]`；当 `surfaceY-12 > naturalH` 时（城市地表被压高、
  // 自然地形是深海床）水体会落在覆写范围之外 → 残留。
  //
  // 实测后果：城市地表下挖 2 格露出悬空水格，顶面 -1.5 恰与水面平面同高 →
  // 肉眼就是「在陆地上挖出一汪水」（用户报告的 bug 之一）。
  const reg = makeRegistry();
  const layout = computeRegionLayout(0, 0, SEED);
  const city = layout.city;
  // 固定复现点 (125,334)：naturalH=-14（深海床），surfaceY=5，CITY 压平 flatH=-3
  // → 覆写下沿 coverBottomY=-7，缺口区间 [-13,-8]（6 格水体无人覆写）；无建筑干扰
  const wx = 125, wz = 334;
  const ci = getCityInfo(wx, wz, city);
  assertNotNull(ci, 'point inside city');
  const naturalH = generateHeight(wx, wz, SEED);
  const surfaceY = getCityFinalSurfaceY(wx, wz, ci, SEED);
  const flatH = generateHeightForBiome(wx, wz, SEED, 'CITY');
  const fillStartY = Math.min(flatH, surfaceY);
  const coverBottomY = Math.min(fillStartY, Math.max(surfaceY - 12, -32));
  const gapTopY = Math.min(coverBottomY - 1, SEA_Y);
  // fixture 前置条件：缺口确实存在（否则断言恒真 —— 测不到修复）
  assertTrue(naturalH < SEA_Y, `fixture precondition: naturalH(${naturalH}) < SEA_Y(${SEA_Y})`);
  assertTrue(gapTopY >= naturalH + 1,
    `fixture precondition: 缺口区间 [${naturalH + 1},${gapTopY}] 非空（覆写下沿 ${coverBottomY}）`);

  const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
  const col = await genColumnWithTerrain(reg, cx, cz, [layout]);
  const lx = wx - cx * 16, lz = wz - cz * 16;
  const waterId = reg.idOf('water');

  // 缺口区间不得有水体残留
  let waterLeft = 0;
  for (let y = naturalH + 1; y <= gapTopY; y++) {
    if (col.get(lx, y, lz) === waterId) waterLeft++;
  }
  assertEqual(waterLeft, 0,
    `缺口区间 [${naturalH + 1},${gapTopY}] 不得有水体残留（mc-lite 城内不填水）`);

  // 且不得清成 air 造出地下空洞（玩家挖下去会掉进洞里，比看到水更糟）
  let airGap = 0;
  for (let y = naturalH + 1; y <= gapTopY; y++) {
    if (col.get(lx, y, lz) === 0) airGap++;
  }
  assertEqual(airGap, 0, '补实区间不得是 air（须是实心岩石，不留空洞）');

  // 补实材料 = 城市地表材料（sand/clay），不是别的方块
  const subNames = ['sand', 'clay'];
  assertTrue(subNames.some((n) => reg.idOf(n) === col.get(lx, naturalH + 1, lz)),
    `补实材料须是城市地表材料（got id ${col.get(lx, naturalH + 1, lz)}）`);
});

test('城市内无暴露水体：全城 bounds 抽样零残留（bounds 门控零误伤的前提）', async () => {
  // 水面遮罩的城市门控（render/ocean-mask.js）在 bounds 内一律关掉水面平面。
  // 这要求 bounds 内**确实没有水体** —— 否则门控会让真实水面消失（误伤）。
  // 实测修复前：bounds 内残留水格 16600、暴露 56；修复后须为 0。
  const reg = makeRegistry();
  const layout = computeRegionLayout(0, 0, SEED);
  const city = layout.city;
  const waterId = reg.idOf('water');

  let residual = 0, sampled = 0;
  // bounds 半宽可达 294 → 稀疏抽样（每 5 个 column 取 1 个），覆盖核心 + 边缘
  for (let cx = Math.floor(city.minX / 16); cx <= Math.ceil(city.maxX / 16); cx += 5) {
    for (let cz = Math.floor(city.minZ / 16); cz <= Math.ceil(city.maxZ / 16); cz += 7) {
      const wx0 = cx * 16, wz0 = cz * 16;
      // 只取完全落在 bounds 内的 column（边缘 column 混入城外点会污染统计）
      if (wx0 < city.minX || wx0 + 15 > city.maxX || wz0 < city.minZ || wz0 + 15 > city.maxZ) continue;
      const col = await genColumnWithTerrain(reg, cx, cz, [layout]);
      sampled++;
      for (let lx = 0; lx < 16; lx++) {
        for (let lz = 0; lz < 16; lz++) {
          for (let y = SEA_Y; y >= SEA_Y - 6; y--) {
            if (col.get(lx, y, lz) === waterId) residual++;
          }
        }
      }
    }
  }
  assertTrue(sampled > 0, '须有 column 被抽样（否则断言恒真）');
  assertEqual(residual, 0, `${sampled} 个城内 column 在水面平面附近不得有水体残留`);
});
