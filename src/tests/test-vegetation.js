import { test } from './runner.js';
import { assertEqual, assertTrue, assertNotNull } from './assert.js';
import { computeRegionLayout, neighborRegionKeys } from '../gen/structures/structure-layout.js';
import { applyStructuresToColumn } from '../gen/structures/apply.js';
import { getBiome } from '../gen/noise.js';
import { fillColumn, generateHeight } from '../gen/terrain.js';
import { carveCaves } from '../gen/caves.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { buildSectionMesh, TEMPLATES } from '../mesh/mesher.js';
import { computeSkylightColumn } from '../mesh/lighting.js';
import { blockIndex, SEA_Y } from '../voxel/constants.js';

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

// ---- 沼泽 lilypad 格位与高度（bug 修复：叶面须浮在水面上、不得覆盖水格）----
// 落点 (-600,-270)：SEED=12345 下 **过 pointContext 优先级链**后 kind==='water' 且
// biome===SWAMP 且 seededRandom(...,seed+12)<0.08。column (-38,-17)，局部 (8,2)。
//
// **为什么不能只按 biome+高度+随机数筛**（诊断实测，勿照直觉选落点）：pointContext 里
// city/island/pyramid/plainLand/snow/fm 六个地标判定都在 water 分支**之前**，被地标吞掉的点
// ctx.kind 不是 'water' → 根本不放 lilypad。实测只按三条件筛出 12 个「候选点」，完整 GEN 后
// **落地 0 个**（全被 clay/sand 地标方块覆盖）。必须复现优先级链才能找到真实落点。
const LILY_CX = -38, LILY_CZ = -17;
const LILY_LX = 8, LILY_LZ = 2;

test('沼泽 lilypad：生成在 SEA_Y+1（不覆盖水面格）', async () => {
  const reg = makeRegistry();
  const col = new ChunkColumn(LILY_CX, LILY_CZ);
  fillColumn(col, SEED, reg);          // 先填水面：(h, SEA_Y] → y=-2 是水
  carveCaves(col, SEED);               // 生产 GEN 顺序（world-worker.js:42-44）：fill→carve→apply
  await applyStructuresToColumn(col, SEED, reg, layoutsFor(LILY_CX, LILY_CZ));
  const lilyId = reg.idOf('lilypad'), waterId = reg.idOf('water');
  assertEqual(col.blocks[blockIndex(LILY_LX, SEA_Y, LILY_LZ)], waterId,
    'y=SEA_Y 格水必须保留（原被 lilypad 覆盖 → 视觉水洞）');
  assertEqual(col.blocks[blockIndex(LILY_LX, SEA_Y + 1, LILY_LZ)], lilyId,
    'lilypad 生成在水面格的**上一格**');
});

test('沼泽 lilypad：叶面世界 y 紧贴暴露水面顶面（浮在水上、不沉水）', async () => {
  const reg = makeRegistry();
  const col = new ChunkColumn(LILY_CX, LILY_CZ);
  fillColumn(col, SEED, reg);
  carveCaves(col, SEED);
  await applyStructuresToColumn(col, SEED, reg, layoutsFor(LILY_CX, LILY_CZ));

  // **从实际生成数据里读出 lilypad 的真实格位**，不硬编码 SEA_Y+1：
  // 硬编码会让测试与 apply.js 的生成格位**共用同一个假设** —— 若有人把格位改回 SEA_Y
  // （bug 状态），本测试仍会拿硬编码值算出「叶面 -1.48 > 水面 -1.50」而恒过（静默逃逸）。
  // 读真实格位后，格位与几何任一侧回归都会让本断言失败。
  const lilyId = reg.idOf('lilypad');
  let lilyGridY = null;
  for (let y = SEA_Y - 3; y <= SEA_Y + 3; y++) {
    if (col.blocks[blockIndex(LILY_LX, y, LILY_LZ)] === lilyId) { lilyGridY = y; break; }
  }
  assertNotNull(lilyGridY, '落点柱内须真的生成了 lilypad（否则本断言无意义）');

  // 叶面世界 y = 实例原点(块底角 = 生成格 y) + TEMPLATES.lilypad 模板偏移
  // 暴露水面顶面 = (SEA_Y+1) − WATER_SURFACE_SINK(0.5)；水面格必须是水（不是被 lilypad 顶掉）
  const lilyY = lilyGridY + TEMPLATES.lilypad[0].v[0][1];
  const waterTop = (SEA_Y + 1) - 0.5;
  assertEqual(col.blocks[blockIndex(LILY_LX, SEA_Y, LILY_LZ)], reg.idOf('water'),
    '水面格 y=SEA_Y 须仍是水（叶面高度只在有水面时才有意义）');
  assertTrue(lilyY > waterTop, `叶面 ${lilyY} 须高于水面 ${waterTop}（不能沉在水下）`);
  assertTrue(lilyY - waterTop < 0.1, `叶面 ${lilyY} 须紧贴水面 ${waterTop}（不能悬空半格）`);
});

test('植被确定性：两次生成逐格一致', async () => {
  const reg = makeRegistry();
  const city = computeRegionLayout(0, 0, SEED).city;
  const pos = findBiomeColumn('FOREST', city);
  const a = await genColumn(reg, pos.cx, pos.cz);
  const b = await genColumn(reg, pos.cx, pos.cz);
  for (let i = 0; i < a.blocks.length; i++) assertEqual(a.blocks[i], b.blocks[i], `block ${i}`);
});
