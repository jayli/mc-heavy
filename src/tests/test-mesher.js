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
  grass_carried: { u0: 0.30, v0: 0.0, u1: 0.31, v1: 0.01 },
  grass_side_carried: { u0: 0.32, v0: 0.0, u1: 0.33, v1: 0.01 },
  box_face: { u0: 0.40, v0: 0.0, u1: 0.41, v1: 0.01 },
  box_side: { u0: 0.42, v0: 0.0, u1: 0.43, v1: 0.01 },
  box_top: { u0: 0.44, v0: 0.0, u1: 0.45, v1: 0.01 },
  Cobblestone: { u0: 0.46, v0: 0.0, u1: 0.47, v1: 0.01 },
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
  // cutout 通道（深度写入——mc-lite 台阶材质不透明；原 transparent 通道
  // depthWrite=false 致 L 形凹角透视穿帮，M2 勘误改道）；2 个子盒 ×6 面 ×4 顶点
  assertEqual(result.cutout.vertexCount, 48, 'step = 12 quads');
  assertEqual(result.transparent.vertexCount, 0, 'step no longer in blended channel');
  let maxY = -Infinity;
  for (let i = 0; i < result.cutout.vertexCount; i++) {
    maxY = Math.max(maxY, result.cutout.positions[i * 3 + 1]);
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

// ---- 朝向渲染消费（meta 低 2 位 = orientation 0-3，yaw = orientation × 90°）----

// 单方块 section 构建助手（带 meta）
function meshSingleMeta(reg, name, metaByte) {
  const data = new Uint16Array(18 * 18 * 18);
  const light = new Uint8Array(18 * 18 * 18);
  const meta = new Uint8Array(18 * 18 * 18);
  const vIdx = (dx, dy, dz) => dx + dz * 18 + dy * 324;
  data[vIdx(9, 9, 9)] = reg.idOf(name);
  meta[vIdx(9, 9, 9)] = metaByte;
  for (let i = 0; i < light.length; i++) light[i] = 0xF0;
  return buildSectionMesh({ data, light, meta, missing: false }, reg, atlasMeta, 0, 0, 0);
}

// 按世界面（packed face 位）收集顶点 UV 的 tile u 起点
function faceTileU(result, channel, faceIdx) {
  const { packed, uvs } = result[channel];
  const us = [];
  for (let i = 0; i < result[channel].vertexCount; i++) {
    if (((packed[i] >> 10) & 0x7) === faceIdx) us.push(uvs[i * 2]);
  }
  return us;
}

test('朝向: chest orientation=1 → 正面(box_face)转到世界 +X 面', () => {
  const reg = makeRegistry();
  const r0 = meshSingleMeta(reg, 'chest', 0);
  const r1 = meshSingleMeta(reg, 'chest', 1);
  const inBoxFace = (u) => Math.abs(u - 0.40) < 1e-6;
  // orientation=0：正面在模型 +Z = 世界 +Z（face4）
  assertTrue(faceTileU(r0, 'cutout', 4).some(inBoxFace), 'o=0 front on +Z');
  assertTrue(!faceTileU(r0, 'cutout', 0).some(inBoxFace), 'o=0 +X is side');
  // orientation=1（yaw +90°）：模型 +Z → 世界 +X（face0）
  assertTrue(faceTileU(r1, 'cutout', 0).some(inBoxFace), 'o=1 front rotated to +X');
  assertTrue(!faceTileU(r1, 'cutout', 4).some(inBoxFace), 'o=1 +Z no longer front');
});

test('朝向: orientation=3 为反向旋转（正面转到世界 -X）', () => {
  const reg = makeRegistry();
  const r3 = meshSingleMeta(reg, 'chest', 3);
  const inBoxFace = (u) => Math.abs(u - 0.40) < 1e-6;
  assertTrue(faceTileU(r3, 'cutout', 1).some(inBoxFace), 'o=3 front rotated to -X');
});

test('朝向: meta 低 2 位掩码（meta=4 ≡ meta=0，均不旋转）', () => {
  const reg = makeRegistry();
  const r0 = meshSingleMeta(reg, 'stone', 0);
  const r4 = meshSingleMeta(reg, 'stone', 4); // 4 & 3 = 0
  assertEqual(r4.opaque.vertexCount, r0.opaque.vertexCount, 'same vertex count');
  for (let i = 0; i < r0.opaque.positions.length; i++) {
    assertTrue(Math.abs(r4.opaque.positions[i] - r0.opaque.positions[i]) < 1e-6, 'positions identical');
  }
  for (let i = 0; i < r0.opaque.uvs.length; i++) {
    assertTrue(Math.abs(r4.opaque.uvs[i] - r0.opaque.uvs[i]) < 1e-6, 'uvs identical');
  }
});

test('朝向: 顶面 UV 随 orientation 旋转（grass o=1）', () => {
  const reg = makeRegistry();
  const r0 = meshSingleMeta(reg, 'grass', 0);
  const r1 = meshSingleMeta(reg, 'grass', 1);
  const tile = atlasMeta.grass_carried;
  // 顶面（face2）某世界顶点 (x=1,z=1)：o=0 → u=1；o=1 → u=0（u=1-world_z）
  const topU = (r, wx, wz) => {
    const { positions, uvs, packed } = r.opaque;
    for (let i = 0; i < r.opaque.vertexCount; i++) {
      if (((packed[i] >> 10) & 0x7) !== 2) continue;
      if (Math.abs(positions[i * 3] - (8 + wx)) < 1e-6 && Math.abs(positions[i * 3 + 2] - (8 + wz)) < 1e-6) {
        return (uvs[i * 2] - tile.u0) / (tile.u1 - tile.u0);
      }
    }
    return null;
  };
  assertTrue(Math.abs(topU(r0, 1, 1) - 1) < 1e-4, `o=0 top(x=1,z=1) u=1, got ${topU(r0, 1, 1)}`);
  assertTrue(Math.abs(topU(r1, 1, 1) - 0) < 1e-4, `o=1 top(x=1,z=1) u=0, got ${topU(r1, 1, 1)}`);
});

test('朝向: 模板几何随 orientation 旋转（cobblestone_step o=1 高柱移向 +Z 侧）', () => {
  const reg = makeRegistry();
  const r0 = meshSingleMeta(reg, 'cobblestone_step', 0);
  const r1 = meshSingleMeta(reg, 'cobblestone_step', 1);
  // o=0：高柱在 x∈[0,0.5]，顶面顶点含 (8,9,8)；o=1（+90°）高柱转到 z∈[0.5,1]，(8,9,8) 不再是高柱顶
  const hasTopVert = (r, x, y, z) => {
    for (let i = 0; i < r.cutout.vertexCount; i++) {
      const p = r.cutout.positions;
      if (Math.abs(p[i * 3] - x) < 1e-6 && Math.abs(p[i * 3 + 1] - y) < 1e-6 && Math.abs(p[i * 3 + 2] - z) < 1e-6) return true;
    }
    return false;
  };
  assertTrue(hasTopVert(r0, 8, 9, 8), 'o=0 tall-quarter top corner at (0,1,0)');
  assertTrue(hasTopVert(r1, 8, 9, 9), 'o=1 tall-quarter rotated to (0,1,1)');
});

test('朝向: getSectionView 打包 meta（halo 视图含朝向）', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  // y=WORLD_MIN_Y+8 → halo dy=9（baseY=WORLD_MIN_Y-1），与 vIdx(9,9,9) 约定一致
  col.blocks[blockIndex(8, WORLD_MIN_Y + 8, 8)] = reg.idOf('chest');
  col.meta[blockIndex(8, WORLD_MIN_Y + 8, 8)] = 2;
  world.add(col);
  const view = world.getSectionView(0, 0, 0);
  assertTrue(view.meta instanceof Uint8Array, 'view has meta array');
  assertEqual(view.meta[9 + 9 * 18 + 9 * 324], 2, 'meta carried into halo view');
});
