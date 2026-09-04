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
  'procedural/sky_stone': { u0: 0.50, v0: 0.0, u1: 0.51, v1: 0.01 },
  'procedural/sky_grass': { u0: 0.52, v0: 0.0, u1: 0.53, v1: 0.01 },
  'procedural/cloud': { u0: 0.54, v0: 0.0, u1: 0.55, v1: 0.01 },
  'procedural/chimney': { u0: 0.56, v0: 0.0, u1: 0.57, v1: 0.01 },
  // 吊灯（uvRegion 分区断言需独立 64×64 tile 矩形才能反算局部坐标，否则 fallback stone）
  // 真实 atlas 该 tile 也是 64×64；v0<v1 口径与 build-atlas.mjs 一致（v0 = tile 底）
  'procedural/hanging_lamp': { u0: 0.70, v0: 0.0, u1: 0.70 + 64 / 2048, v1: 64 / 2048 },
  // 床（BED_UV 变换需独立 tile 矩形才能反算 uu/vv，否则 fallback stone）
  'bed/Bed_(top_side_texture)_JE2_BE2': { u0: 0.60, v0: 0.0, u1: 0.61, v1: 0.01 },
  'bed/Bed_(top_texture)_JE1_BE1':      { u0: 0.62, v0: 0.0, u1: 0.63, v1: 0.01 },
  'bed/Bed_(back_texture)_JE2_BE2':     { u0: 0.64, v0: 0.0, u1: 0.65, v1: 0.01 },
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

test('mesher: sky_stone/sky_grass 孤立 cube → opaque 六面 + 各自 procedural tile（M2-7）', () => {
  const reg = makeRegistry();
  const cases = [['sky_stone', 'procedural/sky_stone'], ['sky_grass', 'procedural/sky_grass']];
  for (const [name, tileKey] of cases) {
    const result = meshSingle(reg, name);
    assertEqual(result.opaque.vertexCount, 24, `${name} = 6 faces 24 verts`);
    assertEqual(result.cutout.vertexCount, 0, `${name} not in cutout`);
    assertEqual(result.transparent.vertexCount, 0, `${name} not in transparent`);
    const tile = atlasMeta[tileKey];
    for (let i = 0; i < result.opaque.vertexCount; i++) {
      const u = result.opaque.uvs[i * 2];
      assertTrue(u >= tile.u0 - 1e-6 && u <= tile.u1 + 1e-6,
        `${name} uv samples ${tileKey}, got u=${u}`);
    }
  }
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

test('mesher: cloud 走 opaque 通道 + 同类相邻剔除共享面（M2-7 通道勘误）', () => {
  // mc-lite 云材质 mkMat('#FFFFFF', 1) opacity=1 → 不透明材质（§4.1 勘误口径：
  // cullMode 跟材质透明度）。transparent 通道 depthWrite=false 会使云块侧面
  // 混叠成方格缝（blur 档 mipmap 平均后尤为明显）。
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  const cloudId = reg.idOf('cloud');
  col.blocks[blockIndex(8, WORLD_MIN_Y + 5, 8)] = cloudId;
  col.blocks[blockIndex(9, WORLD_MIN_Y + 5, 8)] = cloudId;
  world.add(col);
  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  assertEqual(result.transparent.vertexCount, 0, 'cloud not in transparent channel');
  assertEqual(result.opaque.vertexCount, 10 * 4, 'two adjacent clouds = 10 faces (shared culled)');
  // UV 收缩到 tile 中央 1/4（wrap 尖峰足迹不跨 tile，blur 档方格线根因解）
  const tile = atlasMeta['procedural/cloud'];
  const m = 0.375;
  const cu0 = tile.u0 + (tile.u1 - tile.u0) * m, cu1 = tile.u1 - (tile.u1 - tile.u0) * m;
  const cv0 = tile.v0 + (tile.v1 - tile.v0) * m, cv1 = tile.v1 - (tile.v1 - tile.v0) * m;
  for (let i = 0; i < result.opaque.vertexCount; i++) {
    const u = result.opaque.uvs[i * 2], v = result.opaque.uvs[i * 2 + 1];
    assertTrue(u >= cu0 - 1e-6 && u <= cu1 + 1e-6 && v >= cv0 - 1e-6 && v <= cv1 + 1e-6,
      `cloud uv in inner quarter, got (${u},${v})`);
  }
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

test('mesher: vine 走轴对齐 cross 模板（0.8 宽、y∈[0,1] 格内、vine tile）', () => {
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
  // 有意偏离 mc-lite：mc-lite geoVine 局部 y[0,1] + 实例原点 +0.5 → 世界 y[0.5,1.5]，
  // 向上溢出半格（其源码注释「使几何体从y=0到y=1」说的是局部坐标，误导）。
  // 本仓库改为落在格内。详见 §4.3。
  assertTrue(Math.abs(minY - 8) < 1e-6, `vine y0=0（格底）, got ${minY - 8}`);
  assertTrue(Math.abs(maxY - 9) < 1e-6, `vine y1=1（格顶）, got ${maxY - 8}`);
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
    if (Math.abs(y - 8) < 1e-6) {
      assertTrue(Math.abs(vNorm - 0) < 1e-4, `bottom vert samples image bottom, got v=${vNorm}`);
    } else if (Math.abs(y - 9) < 1e-6) {
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

// packed bit13 = 材质自发光标记（§4.3，v1.21）
const EMISSIVE_BIT = (1 << 13);

// 吊灯 UV 分区常量（§4.3 v1.22，有意偏离 mc-lite）：与 mesher.js 的 LAMP_*_REGION 同值。
// 区域边界按 texel 中心对齐；atlas v 轴翻转 → canvas row r 对应 tile 局部 v = 1 - r/64。
const LAMP_ROPE_REGION = [30.5 / 64, 1 - 19.5 / 64, 33.5 / 64, 1 - 0.5 / 64];
const LAMP_BODY_REGION = [18.5 / 64, 1 - 47.5 / 64, 45.5 / 64, 1 - 20.5 / 64];

/** 按「贴近轴线」把吊灯顶点分成绳（前 96）/灯体（后 24）两组索引。
 *  发射序 = 模板遍历序：prismQuads 绳在前、boxQuads 灯体在后。 */
function lampVertexGroups(result) {
  const pos = result.cutout.positions;
  const rope = [], body = [];
  for (let i = 0; i < result.cutout.vertexCount; i++) {
    const x = pos[i * 3] - 8, z = pos[i * 3 + 2] - 8;
    // 绳顶点贴块中心轴（r ≤ 0.015）；灯体盒顶点半径 ≥ 0.15
    (Math.hypot(x - 0.5, z - 0.5) > 0.05 ? body : rope).push(i);
  }
  return { rope, body };
}

/** 把 atlas UV 反算回 tile 内局部坐标（0~1），用于校验 uvRegion 分区 */
function tileLocalUV(result, vi) {
  const tile = atlasMeta['procedural/hanging_lamp'];
  const u = result.cutout.uvs[vi * 2], v = result.cutout.uvs[vi * 2 + 1];
  return [(u - tile.u0) / (tile.u1 - tile.u0), (v - tile.v0) / (tile.v1 - tile.v0)];
}

test('mesher: hanging_lamp bit13 按部件区分——绳不发光、灯体发光（quad 级自发光）', () => {
  const reg = makeRegistry();
  const result = meshSingle(reg, 'hanging_lamp');
  const packed = result.cutout.packed;
  assertTrue(result.cutout.vertexCount > 0, 'hanging_lamp 在 cutout 通道');
  const { rope, body } = lampVertexGroups(result);
  assertEqual(rope.length, 96, '绳 = 96 顶点');
  assertEqual(body.length, 24, '灯体 = 24 顶点');
  // 绳不吃 emissive → 保持单色深灰不被暖黄加项冲淡（§4.3 v1.22）
  for (const i of rope) assertEqual((packed[i] & EMISSIVE_BIT) ? 1 : 0, 0, `绳 vert${i} bit13 不置位`);
  // 灯体吃 emissive → 发光暖黄
  for (const i of body) assertEqual((packed[i] & EMISSIVE_BIT) ? 1 : 0, 1, `灯体 vert${i} bit13 置位`);
});

test('mesher: hanging_lamp 绳 UV 落在绳图案区（单色 #333333，不含灯体图案）', () => {
  const reg = makeRegistry();
  const result = meshSingle(reg, 'hanging_lamp');
  const { rope } = lampVertexGroups(result);
  const [ru0, rv0, ru1, rv1] = LAMP_ROPE_REGION;
  for (const i of rope) {
    const [lu, lv] = tileLocalUV(result, i);
    assertTrue(lu >= ru0 - 1e-6 && lu <= ru1 + 1e-6, `绳 vert${i} u=${lu.toFixed(4)} 应在绳区 [${ru0.toFixed(4)},${ru1.toFixed(4)}]`);
    assertTrue(lv >= rv0 - 1e-6 && lv <= rv1 + 1e-6, `绳 vert${i} v=${lv.toFixed(4)} 应在绳区 [${rv0.toFixed(4)},${rv1.toFixed(4)}]`);
  }
  // 反向防线：绳区域与灯体图案区不得重叠（v 轴上绳区在灯体区之上）。若有人把区域常量
  // 写成全幅 u/v∈[0,1]（那正是 mc-lite 的原样，本次已有意偏离）会立刻被抓到。
  assertTrue(rv0 > LAMP_BODY_REGION[3] - 1e-6,
    `绳区 v 下界 ${rv0.toFixed(4)} 应高于灯体区 v 上界 ${LAMP_BODY_REGION[3].toFixed(4)}`);
});

test('mesher: hanging_lamp 灯体 UV 落在灯体图案区（不含 row 0~19 的绳图案）', () => {
  const reg = makeRegistry();
  const result = meshSingle(reg, 'hanging_lamp');
  const { body } = lampVertexGroups(result);
  const [bu0, bv0, bu1, bv1] = LAMP_BODY_REGION;
  for (const i of body) {
    const [lu, lv] = tileLocalUV(result, i);
    assertTrue(lu >= bu0 - 1e-6 && lu <= bu1 + 1e-6, `灯体 vert${i} u=${lu.toFixed(4)} 应在灯体区 [${bu0.toFixed(4)},${bu1.toFixed(4)}]`);
    assertTrue(lv >= bv0 - 1e-6 && lv <= bv1 + 1e-6, `灯体 vert${i} v=${lv.toFixed(4)} 应在灯体区 [${bv0.toFixed(4)},${bv1.toFixed(4)}]`);
  }
  // 关键语义：atlas v 轴翻转（canvas row r → tile 局部 v = 1-r/64）→ 绳图案（row 0~19）在
  // **高 v 侧**、灯体图案（row 20~47）在**低 v 侧**。故判据是灯体区 v 上界必须低于绳区
  // v 下界 → 灯体四个面**采不到**绳图案行。
  assertTrue(bv1 < LAMP_ROPE_REGION[1] - 1e-6,
    `灯体区 v 上界 ${bv1.toFixed(4)} 应低于绳区 v 下界 ${LAMP_ROPE_REGION[1].toFixed(4)}`);
});

test('mesher: chimney 不受 uvRegion/quad 级 em 影响（可选字段默认走方块级）', () => {
  // 回归防线：uvRegion 与 em 是可选字段，未声明的模板必须保持既有行为——UV 全幅、
  // bit13 走方块级默认（EMISSIVE_MATERIALS 不含 chimney → 0）。chimney 用**同款
  // prismQuads**（与吊灯绳共用 helper），是「共用函数未被破坏」的理想防线。
  const reg = makeRegistry();
  const result = meshSingle(reg, 'chimney');
  const packed = result.opaque.packed; // chimney cullMode=opaque（blocks-data.js:53）
  assertTrue(result.opaque.vertexCount > 0, 'chimney 在 opaque 通道');
  for (let i = 0; i < result.opaque.vertexCount; i++) {
    assertEqual((packed[i] & EMISSIVE_BIT) ? 1 : 0, 0, `chimney vert${i} bit13 不置位`);
  }
  // UV 仍全幅（未被 uvRegion 重映射）：tile 内局部坐标覆盖 0~1
  const tile = atlasMeta['procedural/chimney'] || atlasMeta['box_face'];
  let minU = Infinity, maxU = -Infinity;
  for (let i = 0; i < result.opaque.vertexCount; i++) {
    const u = (result.opaque.uvs[i * 2] - tile.u0) / (tile.u1 - tile.u0);
    minU = Math.min(minU, u); maxU = Math.max(maxU, u);
  }
  assertEqual(Math.round(minU), 0, 'chimney UV 起点仍为 0（全幅）');
  assertEqual(Math.round(maxU), 1, 'chimney UV 终点仍为 1（全幅）');
});

test('mesher: glowstone 不置 bit13（有 blocklight 源但无材质自发光——两个集合不同）', () => {
  // 关键回归防线：blocks-data 的 `emissive:15` 是 blocklight 光照源（照亮周围方块），
  // 与材质自发光是**不同概念**。glowstone/lava/ochre_froglight 都有 blocklight 源，
  // 但 mc-lite 实测只有 hanging_lamp 有材质自发光 → 它们不得置 bit13。
  // 若有人图省事用 registry.emissiveTable 判断本位，这条会立刻抓到。
  const reg = makeRegistry();
  const result = meshSingle(reg, 'glowstone');
  const packed = result.opaque.packed;
  assertTrue(result.opaque.vertexCount > 0, 'glowstone 在 opaque 通道');
  for (let i = 0; i < result.opaque.vertexCount; i++) {
    assertEqual((packed[i] & EMISSIVE_BIT) ? 1 : 0, 0, `vert${i} bit13 不置位`);
  }
});

test('mesher: 普通方块（stone/vine）不置 bit13', () => {
  const reg = makeRegistry();
  for (const [name, channel] of [['stone', 'opaque'], ['vine', 'cutout']]) {
    const result = meshSingle(reg, name);
    const packed = result[channel].packed;
    assertTrue(result[channel].vertexCount > 0, `${name} 在 ${channel} 通道`);
    for (let i = 0; i < result[channel].vertexCount; i++) {
      assertEqual((packed[i] & EMISSIVE_BIT) ? 1 : 0, 0, `${name} vert${i} bit13 不置位`);
    }
  }
});

test('mesher: bit13 不污染既有位段（light bit0-7 / AO bit8-9 / face bit10-12）', () => {
  // bit13 是新增位，不得挤占 face 位（bit10-12 只能装 0-7，face 索引 0-5 够用；
  // 若误用 bit13 当 face 位的一部分会让着色器取法线错位）
  const reg = makeRegistry();
  const result = meshSingle(reg, 'hanging_lamp');
  const packed = result.cutout.packed;
  for (let i = 0; i < result.cutout.vertexCount; i++) {
    const faceIdx = (packed[i] >> 10) & 0x7;
    assertTrue(faceIdx <= 5, `face 索引 ${faceIdx} 应在 0-5`);
    assertTrue((packed[i] & 0xFF) > 0, 'light 位未被污染（测试 fixture light=0xF0）');
  }
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

test('mesher: hanging_lamp 绳走八段棱柱 + 灯体盒（对齐 CylinderGeometry(0.015,0.015,0.4,8)）', () => {
  const reg = makeRegistry();
  const result = meshSingle(reg, 'hanging_lamp');
  // 绳：prismQuads 8 段 × (1 侧面 + 上下盖) ×4 顶点 = 96；灯体 boxQuads 6 面 ×4 = 24
  assertEqual(result.cutout.vertexCount, 120, 'rope prism 96 + lamp body 24');
  // 绳 r=0.015 → 离块中心 (0.5,0.5) 的水平距离不得超出 0.015（cross 近似曾是 0.03 宽）。
  // 按「贴近轴线」筛绳顶点（灯体盒顶点半径 ≥0.15，天然被排除，无需单独判灯体）。
  let ropeMaxRadius = 0, ropeMinY = Infinity, ropeMaxY = -Infinity, ropeVerts = 0;
  const pos = result.cutout.positions;
  for (let i = 0; i < result.cutout.vertexCount; i++) {
    const x = pos[i * 3] - 8, y = pos[i * 3 + 1] - 8, z = pos[i * 3 + 2] - 8;
    const r = Math.hypot(x - 0.5, z - 0.5);
    if (r > 0.05) continue; // 灯体盒顶点
    ropeVerts++;
    ropeMaxRadius = Math.max(ropeMaxRadius, r);
    ropeMinY = Math.min(ropeMinY, y); ropeMaxY = Math.max(ropeMaxY, y);
  }
  assertEqual(ropeVerts, 96, '绳 = 8 段 ×（侧面+上下盖）×4 顶点');
  assertTrue(ropeMaxRadius <= 0.015 + 1e-6, `绳半径 ≤0.015, got ${ropeMaxRadius}`);
  assertTrue(Math.abs(ropeMinY - 0.6) < 1e-6, `绳底 y=0.6, got ${ropeMinY}`);
  assertTrue(Math.abs(ropeMaxY - 1.0) < 1e-6, `绳顶 y=1.0, got ${ropeMaxY}`);
});

test('mesher: bed_head 侧面采样贴图下半（vv∈[0,0.5]，对齐 mc-lite 实际行为）', () => {
  const reg = makeRegistry();
  const result = meshSingle(reg, 'bed_head');
  // 渲染面顺序 = 模板遍历序（跳过 null 面 3/5）：+X,-X,+Y,+Z → 顶点分组 [0-3],[4-7],[8-11],[12-15]
  const sideTile = atlasMeta['bed/Bed_(top_side_texture)_JE2_BE2'];
  const sides = [[0, '+X'], [1, '-X'], [3, '+Z']];
  for (const [group, label] of sides) {
    for (let k = 0; k < 4; k++) {
      const vi = group * 4 + k;
      const v = result.opaque.uvs[vi * 2 + 1];
      const vv = (v - sideTile.v0) / (sideTile.v1 - sideTile.v0);
      // mc-lite 实测：repeat[1,0.5] 生效、offset[0,0.5] 无消费点 → 采样下半 vv∈[0,0.5]
      // （下半 PNG 行 8-15 有 92 个不透明像素；上半仅 32，opaque 通道会渲成深色块）
      assertTrue(vv <= 0.5 + 1e-6, `${label} vert${k} vv=${vv.toFixed(2)} 应在下半 [0,0.5]`);
    }
  }
});

test('mesher: bed_head 顶面 UV 不旋转（mc-lite rotation 字段无消费点）', () => {
  const reg = makeRegistry();
  const result = meshSingle(reg, 'bed_head');
  const topTile = atlasMeta['bed/Bed_(top_texture)_JE1_BE1'];
  // +Y 面 FACE_UVS 口径：(0,0),(1,0),(1,1),(0,1)
  const expect = [[0, 0], [1, 0], [1, 1], [0, 1]];
  for (let k = 0; k < 4; k++) {
    const vi = 2 * 4 + k; // 第 3 组 = +Y
    const u = result.opaque.uvs[vi * 2], v = result.opaque.uvs[vi * 2 + 1];
    const uu = (u - topTile.u0) / (topTile.u1 - topTile.u0);
    const vv = (v - topTile.v0) / (topTile.v1 - topTile.v0);
    assertEqual(Math.round(uu), expect[k][0], `+Y vert${k} uu`);
    assertEqual(Math.round(vv), expect[k][1], `+Y vert${k} vv`);
  }
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

// ---- issue #2 遗留：暴露水面下沉 0.5（与海面平面 SEA_Y+0.5 共面，消除蓝色顶面模）----

function yExtent(geom) {
  let yMax = -Infinity, yMin = Infinity;
  for (let i = 0; i < geom.vertexCount; i++) {
    yMax = Math.max(yMax, geom.positions[i * 3 + 1]);
    yMin = Math.min(yMin, geom.positions[i * 3 + 1]);
  }
  return { yMin, yMax };
}

test('mesher: 暴露水面下沉——孤立水块顶面/侧面顶边下沉 0.5', () => {
  const reg = makeRegistry();
  const world = makeWorldWithBlock(reg, 8, WORLD_MIN_Y + 5, 8, reg.idOf('water'));
  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  const { yMin, yMax } = yExtent(result.transparent);
  assertEqual(yMin, 5, '底面保持块底不动');
  assertEqual(yMax, 5.5, '暴露水面下沉 0.5（原为 6）');
});

test('mesher: 暴露水面下沉——swamp_water 同口径', () => {
  const reg = makeRegistry();
  const world = makeWorldWithBlock(reg, 8, WORLD_MIN_Y + 5, 8, reg.idOf('swamp_water'));
  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  const { yMax } = yExtent(result.transparent);
  assertEqual(yMax, 5.5, 'swamp_water 暴露水面同样下沉 0.5');
});

test('mesher: lilypad 叶面在块底之下半格（模板偏移 -0.48）', () => {
  const reg = makeRegistry();
  const world = makeWorldWithBlock(reg, 8, WORLD_MIN_Y + 5, 8, reg.idOf('lilypad'));
  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  const { yMin, yMax } = yExtent(result.cutout);
  // 块底局部 y=5；模板偏移 -0.48 → 叶面 4.52（原为 +0.02 → 5.02，即贴块底）
  // **用容差而非 assertEqual**：positions 存进 Float32Array，4.52 不可精确表示
  // （实测 4.519999980926514）；5.5 可精确表示故旧的水面下沉测试没踩到这点。
  assertEqual(yMin, yMax, '单 quad 水平面，yMin===yMax');
  assertTrue(Math.abs(yMin - 4.52) < 1e-5, `叶面 ${yMin} ≈ 块底 5 − 0.48`);
});

test('mesher: lilypad 浮在水面之上——叶面紧贴暴露水面顶面（差 <0.1）', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  // 沼泽水面口径：SEA_Y 格是水（顶面下沉 0.5），lilypad 在其**上一格**
  col.blocks[blockIndex(8, WORLD_MIN_Y + 5, 8)] = reg.idOf('water');
  col.blocks[blockIndex(8, WORLD_MIN_Y + 6, 8)] = reg.idOf('lilypad');
  world.add(col);
  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  const waterTop = yExtent(result.transparent).yMax; // 5.5 = 块顶 6 下沉 0.5
  const lilyY = yExtent(result.cutout).yMax;         // 5.52 = 块底 6 − 0.48
  assertTrue(lilyY > waterTop, `叶面 ${lilyY} 须高于水面 ${waterTop}（不能沉在水下）`);
  assertTrue(lilyY - waterTop < 0.1, `叶面 ${lilyY} 须紧贴水面 ${waterTop}（不能悬空半格）`);
});

test('mesher: 水面下沉——深水块（上方仍是水）侧面保持整格高', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  const waterId = reg.idOf('water');
  col.blocks[blockIndex(8, WORLD_MIN_Y + 5, 8)] = waterId;
  col.blocks[blockIndex(8, WORLD_MIN_Y + 6, 8)] = waterId;
  world.add(col);
  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  const p = result.transparent.positions;
  const { yMax } = yExtent(result.transparent);
  assertEqual(yMax, 6.5, '表层水顶面下沉后在 6.5');
  let hasSix = false;
  for (let i = 0; i < result.transparent.vertexCount; i++) {
    if (Math.abs(p[i * 3 + 1] - 6) < 1e-6) { hasSix = true; break; }
  }
  assertTrue(hasSix, '下层深水侧面顶边仍在 6（整格高，不下沉）');
});

test('mesher: 水面下沉——水上有 opaque 时不下沉（非暴露水面）', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  col.blocks[blockIndex(8, WORLD_MIN_Y + 5, 8)] = reg.idOf('water');
  col.blocks[blockIndex(8, WORLD_MIN_Y + 6, 8)] = reg.idOf('stone');
  world.add(col);
  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  const { yMax } = yExtent(result.transparent);
  assertEqual(yMax, 6, '被 opaque 盖住的水侧面保持整格高');
});

test('mesher: 水面下沉——非水方块顶面不受影响', () => {
  const reg = makeRegistry();
  const world = makeWorldWithBlock(reg, 8, WORLD_MIN_Y + 5, 8, reg.idOf('stone'));
  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  const { yMax } = yExtent(result.opaque);
  assertEqual(yMax, 6, 'stone 顶面保持块顶不动');
});
