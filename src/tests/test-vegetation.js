import { test } from './runner.js';
import { assertEqual, assertTrue, assertNotNull } from './assert.js';
import { computeRegionLayout, neighborRegionKeys } from '../gen/structures/structure-layout.js';
import { applyStructuresToColumn } from '../gen/structures/apply.js';
import { getBiome } from '../gen/noise.js';
import { fillColumn, generateHeight } from '../gen/terrain.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { buildSectionMesh } from '../mesh/mesher.js';
import { computeSkylightColumn } from '../mesh/lighting.js';
import { blockIndex } from '../voxel/constants.js';

const SEED = 12345;

function makeRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}

/** 找一个不被城市吞没、中心点为指定 biome 的 column */
function findBiomeColumn(biome, city) {
  for (let wx = -800; wx < 800; wx += 16) {
    for (let wz = -800; wz < 800; wz += 16) {
      const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
      const px = wx + 8, pz = wz + 8;
      if (city && px >= city.minX && px <= city.maxX && pz >= city.minZ && pz <= city.maxZ) continue;
      if (getBiome(px, pz, SEED) === biome && generateHeight(px, pz, SEED) >= -2) return { cx, cz };
    }
  }
  return null;
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
  await applyStructuresToColumn(col, SEED, reg, layoutsFor(cx, cz));
  return col;
}

/** column 内统计指定方块名出现次数（地表以上） */
function countAboveSurface(col, reg, names) {
  const ids = new Set(names.map((n) => reg.idOf(n)));
  let n = 0;
  for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
    for (let y = 0; y < 96; y++) {
      if (ids.has(col.blocks[blockIndex(lx, y, lz)])) n++;
    }
  }
  return n;
}

test('FOREST：有树木（树干+树冠）', async () => {
  const reg = makeRegistry();
  const city = computeRegionLayout(0, 0, SEED).city;
  const pos = findBiomeColumn('FOREST', city);
  assertNotNull(pos, 'found forest column');
  const col = await genColumn(reg, pos.cx, pos.cz);
  const trees = countAboveSurface(col, reg, ['wood', 'birch_log', 'leaves', 'yellow_leaves']);
  assertTrue(trees > 20, `forest tree blocks: ${trees}`);
});

test('PLAINS：有草/花植被', async () => {
  const reg = makeRegistry();
  const city = computeRegionLayout(0, 0, SEED).city;
  const pos = findBiomeColumn('PLAINS', city);
  assertNotNull(pos, 'found plains column');
  const col = await genColumn(reg, pos.cx, pos.cz);
  const plants = countAboveSurface(col, reg, ['short_grass', 'flower', 'allium', 'azure_bluet', 'oxeye_daisy', 'red_mushroom', 'dead_bush']);
  assertTrue(plants > 3, `plains plants: ${plants}`);
});

test('DESERT：有仙人掌', async () => {
  const reg = makeRegistry();
  const city = computeRegionLayout(0, 0, SEED).city;
  // 沙漠稀疏（1%），多扫几个 column
  let cactus = 0;
  for (let wx = -800; wx < 800 && cactus === 0; wx += 16) {
    for (let wz = -800; wz < 800 && cactus === 0; wz += 16) {
      const px = wx + 8, pz = wz + 8;
      if (city && px >= city.minX && px <= city.maxX && pz >= city.minZ && pz <= city.maxZ) continue;
      if (getBiome(px, pz, SEED) !== 'DESERT' || generateHeight(px, pz, SEED) < -2) continue;
      const col = await genColumn(reg, Math.floor(wx / 16), Math.floor(wz / 16));
      cactus = countAboveSurface(col, reg, ['cactus']);
    }
  }
  assertTrue(cactus > 0, 'desert cactus found');
});

test('植被不产生 opaque 阴影：草格上方 skylight=15', async () => {
  const reg = makeRegistry();
  const city = computeRegionLayout(0, 0, SEED).city;
  const pos = findBiomeColumn('PLAINS', city);
  const col = await genColumn(reg, pos.cx, pos.cz);
  computeSkylightColumn(col, reg);
  // 找一株 short_grass/flower，验证其自身格与上方 skylight=15
  const grassId = reg.idOf('short_grass');
  let found = false;
  outer: for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
    for (let y = 0; y < 96; y++) {
      if (col.blocks[blockIndex(lx, y, lz)] === grassId) {
        assertEqual(col.light[blockIndex(lx, y, lz)] >> 4, 15, 'grass cell full bright');
        assertEqual(col.light[blockIndex(lx, y + 1, lz)] >> 4, 15, 'above grass full bright');
        found = true;
        break outer;
      }
    }
  }
  assertTrue(found, 'found short_grass to verify');
});

test('城市过渡带树根贴地', async () => {
  const reg = makeRegistry();
  // 固定种子下 (1,42) 是城市过渡带的默认树候选，城市地表会向自然地形混合。
  const col = new ChunkColumn(0, 2);
  fillColumn(col, SEED, reg);
  await applyStructuresToColumn(col, SEED, reg, layoutsFor(0, 2));

  const root = blockIndex(1, 3, 10);
  const ground = blockIndex(1, 2, 10);
  assertEqual(col.blocks[root], reg.idOf('wood'), 'fixture tree root');
  assertTrue(col.blocks[ground] !== reg.idOf('air'), 'tree root must rest on generated ground');
});

test('城市残丘清除后：树植根城市地表，残留自然草地被清除', async () => {
  const reg = makeRegistry();
  // 固定种子下 (311,-88) 的城市地表为 y=4，fillColumn 的自然草地表原残留在 y=15。
  // 残丘修复后：y=15 的 grass 被清除为 air，树植根城市地表上方（surfaceY+1 = y=5）。
  const col = new ChunkColumn(19, -6);
  fillColumn(col, SEED, reg);
  await applyStructuresToColumn(col, SEED, reg, layoutsFor(19, -6));

  const mound = blockIndex(7, 15, 8);
  const root = blockIndex(7, 5, 8);
  assertEqual(col.blocks[mound], reg.idOf('air'), 'residual natural mound cleared');
  assertEqual(col.blocks[root], reg.idOf('wood'), 'tree root at city surface');
});

test('mesher：flower 走 cross 模板（cutout 通道 8 顶点，非 box 24 顶点）', async () => {
  const reg = makeRegistry();
  // 手工 section：中心放一株 flower
  const data = new Uint16Array(18 * 18 * 18);
  const light = new Uint8Array(18 * 18 * 18);
  const vIdx = (dx, dy, dz) => dx + dz * 18 + dy * 324;
  const flowerId = reg.idOf('short_grass');
  data[vIdx(9, 2, 9)] = flowerId;
  for (let i = 0; i < light.length; i++) light[i] = 0xF0; // 全亮
  const result = buildSectionMesh({ data, light, missing: false }, reg, {}, 0, 0, 0);
  assertEqual(result.cutout.vertexCount, 8, 'cross = 2 quads × 4 verts');
  // 双面绕线（mc-lite DoubleSide 口径）：每 quad 正反两组三角形
  assertEqual(result.cutout.indexCount, 24, 'cross = 2 quads × 12 idx (double-side)');
  assertEqual(result.opaque.vertexCount, 0, 'no opaque faces');
});

test('mesher：lilypad 走水平单 quad 模板', () => {
  const reg = makeRegistry();
  const data = new Uint16Array(18 * 18 * 18);
  const light = new Uint8Array(18 * 18 * 18);
  const vIdx = (dx, dy, dz) => dx + dz * 18 + dy * 324;
  data[vIdx(9, 2, 9)] = reg.idOf('lilypad');
  for (let i = 0; i < light.length; i++) light[i] = 0xF0;
  const result = buildSectionMesh({ data, light, missing: false }, reg, {}, 0, 0, 0);
  assertEqual(result.cutout.vertexCount, 4, 'lilypad = 1 quad');
});

test('植被确定性：两次生成逐格一致', async () => {
  const reg = makeRegistry();
  const city = computeRegionLayout(0, 0, SEED).city;
  const pos = findBiomeColumn('FOREST', city);
  const a = await genColumn(reg, pos.cx, pos.cz);
  const b = await genColumn(reg, pos.cx, pos.cz);
  for (let i = 0; i < a.blocks.length; i++) assertEqual(a.blocks[i], b.blocks[i], `block ${i}`);
});
