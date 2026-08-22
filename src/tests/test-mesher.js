import { test } from './runner.js';
import { assertEqual, assertTrue, assertNull } from './assert.js';
import { buildSectionMesh } from '../mesh/mesher.js';
import { computeSkylightColumn } from '../mesh/lighting.js';
import { WorldData } from '../voxel/world-data.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { getFaceTile } from '../voxel/faces-data.js';
import { WORLD_MIN_Y, blockIndex } from '../voxel/constants.js';
import { DEBUG_FLAGS, setDebugFlags } from '../core/debug-config.js';

function makeRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}

// 最小 atlasMeta（只需测试用到的 tile UV）
const atlasMeta = {
  stone: { u0: 0.0, v0: 0.0, u1: 0.01, v1: 0.01 },
  grass: { u0: 0.02, v0: 0.0, u1: 0.03, v1: 0.01 },
  dirt:  { u0: 0.04, v0: 0.0, u1: 0.05, v1: 0.01 },
  glass_block: { u0: 0.06, v0: 0.0, u1: 0.07, v1: 0.01 },
  leaves: { u0: 0.08, v0: 0.0, u1: 0.09, v1: 0.01 },
  water: { u0: 0.10, v0: 0.0, u1: 0.11, v1: 0.01 },
  'procedural/vine': { u0: 0.20, v0: 0.0, u1: 0.21, v1: 0.01 },
};

function makeWorldWithBlock(reg, lx, y, lz, id) {
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  col.blocks[blockIndex(lx, y, lz)] = id;
  world.add(col);
  return world;
}

test('mesher: 单个 opaque 方块 → 6 面 24 顶点', () => {
  const reg = makeRegistry();
  const world = makeWorldWithBlock(reg, 8, WORLD_MIN_Y + 5, 8, reg.idOf('stone'));
  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  assertEqual(result.opaque.vertexCount, 24, 'one cube = 24 vertices');
  assertEqual(result.opaque.indexCount, 36, 'one cube = 36 indices');
  assertEqual(result.cutout.vertexCount, 0);
  assertEqual(result.transparent.vertexCount, 0);
});

test('mesher: 两个相邻 opaque 方块 → 共享面剔除（10 面）', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  const stoneId = reg.idOf('stone');
  col.blocks[blockIndex(8, WORLD_MIN_Y + 5, 8)] = stoneId;
  col.blocks[blockIndex(9, WORLD_MIN_Y + 5, 8)] = stoneId;
  world.add(col);
  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  // 两个相邻 cube：各 6 面，共享 1 面剔除 → 10 面 = 40 顶点
  assertEqual(result.opaque.vertexCount, 40, 'two adjacent cubes = 10 faces');
});

test('mesher: cutout 方块（leaves）→ cutout 通道', () => {
  const reg = makeRegistry();
  const world = makeWorldWithBlock(reg, 8, WORLD_MIN_Y + 5, 8, reg.idOf('leaves'));
  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  assertEqual(result.cutout.vertexCount, 24);
  assertEqual(result.opaque.vertexCount, 0);
});

test('mesher: transparent 方块（glass）→ transparent 通道', () => {
  const reg = makeRegistry();
  const world = makeWorldWithBlock(reg, 8, WORLD_MIN_Y + 5, 8, reg.idOf('glass_block'));
  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  assertEqual(result.transparent.vertexCount, 24);
  assertEqual(result.opaque.vertexCount, 0);
});

test('mesher: 同类型 water 相邻不画面', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  const waterId = reg.idOf('water');
  col.blocks[blockIndex(8, WORLD_MIN_Y + 5, 8)] = waterId;
  col.blocks[blockIndex(9, WORLD_MIN_Y + 5, 8)] = waterId;
  world.add(col);
  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  // 两个相邻 water：共享面剔除 → 10 面
  assertEqual(result.transparent.vertexCount, 40);
});

test('mesher: packed 包含 light 和面索引', () => {
  const reg = makeRegistry();
  const world = makeWorldWithBlock(reg, 8, WORLD_MIN_Y + 5, 8, reg.idOf('stone'));
  // 先算 skylight，否则 col.light 全 0（light 是派生缓存，mesher 只透传）
  computeSkylightColumn(world.getColumn(0, 0), reg);
  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  const packed = result.opaque.packed;
  // 顶面（+Y，面索引 2）的 light 应为 15（skylight 全亮）
  // 找面索引为 2 的顶点
  let foundTop = false;
  for (let i = 0; i < result.opaque.vertexCount; i++) {
    const faceIdx = (packed[i] >> 10) & 0x7;
    const light = packed[i] & 0xFF;
    if (faceIdx === 2) {
      foundTop = true;
      assertTrue(light >= 0xF0, `top face skylight should be 15, got ${light >> 4}`);
    }
  }
  assertTrue(foundTop, 'top face exists');
});

test('mesher: AO 值在 packed bit8-9', () => {
  const reg = makeRegistry();
  const world = makeWorldWithBlock(reg, 8, WORLD_MIN_Y + 5, 8, reg.idOf('stone'));
  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  const packed = result.opaque.packed;
  for (let i = 0; i < result.opaque.vertexCount; i++) {
    const ao = (packed[i] >> 8) & 0x3;
    assertTrue(ao >= 0 && ao <= 3, `AO value ${ao} in range`);
  }
});

test('mesher: worldStats 开 → 返回面剔除统计', () => {
  setDebugFlags({ worldStats: true });
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  const stoneId = reg.idOf('stone');
  col.blocks[blockIndex(8, WORLD_MIN_Y + 5, 8)] = stoneId;
  col.blocks[blockIndex(9, WORLD_MIN_Y + 5, 8)] = stoneId;
  world.add(col);
  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  assertTrue(result.stats !== null, 'stats collected when flag on');
  assertEqual(result.stats.blocks, 2, 'two non-air blocks');
  assertEqual(result.stats.candidateFaces, 12, 'two cubes = 12 candidate faces');
  assertEqual(result.stats.faces, 10, 'shared face culled → 10 emitted');
  assertEqual(result.stats.culledFaces, 2, 'one shared face × 2 sides culled');
  assertEqual(result.stats.vertices, 40, '10 faces = 40 vertices');
});

test('mesher: worldStats 关 → stats 为 null、几何不变', () => {
  setDebugFlags({ worldStats: false });
  const reg = makeRegistry();
  const world = makeWorldWithBlock(reg, 8, WORLD_MIN_Y + 5, 8, reg.idOf('stone'));
  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  assertNull(result.stats, 'stats null when flag off');
  assertEqual(result.opaque.vertexCount, 24, 'geometry unaffected');
  setDebugFlags({ worldStats: true }); // 还原默认（开发调试期全开）
});

test('debug-config: 默认 worldStats 开', () => {
  assertTrue(DEBUG_FLAGS.worldStats === true, 'default on for dev/debug');
});

// ---- mc-lite 贴图方向/几何对齐（±X UV、顶点模板、双面）----

// 单方块 section 构建助手（全亮，无邻居）
function meshSingle(reg, name) {
  const data = new Uint16Array(18 * 18 * 18);
  const light = new Uint8Array(18 * 18 * 18);
  const vIdx = (dx, dy, dz) => dx + dz * 18 + dy * 324;
  data[vIdx(9, 9, 9)] = reg.idOf(name);
  for (let i = 0; i < light.length; i++) light[i] = 0xF0;
  return buildSectionMesh({ data, light, missing: false }, reg, atlasMeta, 0, 0, 0);
}

test('mesher: +X 面 UV 与 BoxGeometry 一致（u=1-z, v=y，历史 90° 旋转修复）', () => {
  const reg = makeRegistry();
  const result = meshSingle(reg, 'stone');
  const pos = result.opaque.positions, uv = result.opaque.uvs, packed = result.opaque.packed;
  // 块局部原点 (lx,ly,lz)=(8,8,8)；+X 面 fx=1 → x=9，fy/fz∈{0,1}
  const tile = atlasMeta.stone;
  const expect = { '0,0': [1, 0], '1,0': [1, 1], '1,1': [0, 1], '0,1': [0, 0] }; // fy,fz → u,v 系数
  let checked = 0;
  for (let i = 0; i < result.opaque.vertexCount; i++) {
    // 用 packed face 位（bit10-12）锁定 +X 面，避免邻面共顶点串扰
    if (((packed[i] >> 10) & 0x7) !== 0) continue;
    const fy = Math.round(pos[i * 3 + 1] - 8), fz = Math.round(pos[i * 3 + 2] - 8);
    const [fu, fv] = expect[`${fy},${fz}`];
    const u = (uv[i * 2] - tile.u0) / (tile.u1 - tile.u0);
    const v = (uv[i * 2 + 1] - tile.v0) / (tile.v1 - tile.v0);
    assertTrue(Math.abs(u - fu) < 1e-4 && Math.abs(v - fv) < 1e-4,
      `+X vert(fy=${fy},fz=${fz}) uv=(${u.toFixed(2)},${v.toFixed(2)}) want(${fu},${fv})`);
    checked++;
  }
  assertEqual(checked, 4, '+X face has 4 vertices');
});

test('mesher: vine 走轴对齐 cross 模板（0.8 宽、y∈[0.5,1.5]、vine tile）', () => {
  const reg = makeRegistry();
  const result = meshSingle(reg, 'vine');
  assertEqual(result.cutout.vertexCount, 8, 'vine = 2 quads');
  let minY = Infinity, maxY = -Infinity, hasVineUV = false;
  for (let i = 0; i < result.cutout.vertexCount; i++) {
    const y = result.cutout.positions[i * 3 + 1];
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    const u = result.cutout.uvs[i * 2];
    if (u >= 0.20 && u <= 0.21) hasVineUV = true;
  }
  assertTrue(Math.abs(minY - 8.5) < 1e-6, `vine y0=0.5 offset, got ${minY - 8}`);
  assertTrue(Math.abs(maxY - 9.5) < 1e-6, `vine y1=1.5, got ${maxY - 8}`);
  assertTrue(hasVineUV, 'vine uses vine tile (not stone fallback)');
});

test('mesher: cross 模板两个正交面贴图均竖直（底→v0 顶→v1，防横躺回归）', () => {
  const reg = makeRegistry();
  const result = meshSingle(reg, 'vine');
  const pos = result.cutout.positions, uv = result.cutout.uvs;
  const tile = atlasMeta['procedural/vine'];
  for (let i = 0; i < result.cutout.vertexCount; i++) {
    const y = pos[i * 3 + 1];
    const vNorm = (uv[i * 2 + 1] - tile.v0) / (tile.v1 - tile.v0);
    if (Math.abs(y - 8.5) < 1e-6) {
      assertTrue(Math.abs(vNorm - 0) < 1e-4, `bottom vert samples image bottom, got v=${vNorm}`);
    } else if (Math.abs(y - 9.5) < 1e-6) {
      assertTrue(Math.abs(vNorm - 1) < 1e-4, `top vert samples image top, got v=${vNorm}`);
    }
  }
});

test('mesher: cobblestone_step 走 L 形台阶模板（2 box = 12 quad）', () => {
  const reg = makeRegistry();
  const result = meshSingle(reg, 'cobblestone_step');
  // transparent 通道（blocks-data cullMode），2 个子盒 ×6 面 ×4 顶点
  assertEqual(result.transparent.vertexCount, 48, 'step = 12 quads');
  let maxY = -Infinity;
  for (let i = 0; i < result.transparent.vertexCount; i++) {
    maxY = Math.max(maxY, result.transparent.positions[i * 3 + 1]);
  }
  assertTrue(Math.abs(maxY - 9) < 1e-6, 'step full height at left quarter');
});

test('mesher: bed_head 半高块 + null 面剔除（4 面渲染）', () => {
  const reg = makeRegistry();
  const result = meshSingle(reg, 'bed_head');
  // 6 面中 -Y/-Z 为 null（床连接面）→ 4 面 ×4 顶点
  assertEqual(result.opaque.vertexCount, 16, 'bed_head = 4 rendered faces');
  let maxY = -Infinity;
  for (let i = 0; i < result.opaque.vertexCount; i++) {
    maxY = Math.max(maxY, result.opaque.positions[i * 3 + 1]);
  }
  assertTrue(Math.abs(maxY - 8.5) < 1e-6, 'half block top at y=0.5');
});

test('faces-data: 全部可渲染方块的 tile 均存在于 atlas', async () => {
  const meta = await fetch('/assets/atlas.json').then((r) => r.json());
  for (const def of BLOCKS) {
    if (def.cullMode === 'none') continue; // 不渲染方块无贴图需求
    for (let f = 0; f < 6; f++) {
      const tile = getFaceTile(def.name, f);
      if (!tile) continue; // null = 该面不渲染（床）
      assertTrue(!!meta.tiles[tile], `${def.name} face${f} → tile '${tile}' missing in atlas`);
    }
  }
});
