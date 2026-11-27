import { test } from './runner.js';
import { assertEqual, assertTrue, assertNull, assertDeepEqual } from './assert.js';
import { resourceUrl } from '../core/resource-url.js';
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

// ---------------------------------------------------------------- 镂空遮挡体（v1.70）
//
// 「镂空遮挡体」= cutout 通道 + opaqueTable=1 的方块（当前 = 13 个树叶族）。
// 它的贴图有孔洞（alphaTest 0.3 逐片元 discard），所以它**不能**当作实心遮挡体去剔除
// 邻居方块朝向它的那一面 —— 否则玩家透过孔洞会看到背后的空气（用户报告「能看穿背后的方块」）。
// 代价 = 每条「实心方块 ↔ 镂空遮挡体」接触面 +1 个面；镂空体自身朝实心方块的那一面照旧不画
// （避免 z-fighting，且它本就不透明到能看见）。

test('mesher: 石头贴着树叶 → 石头朝树叶的那一面**必须出块**（否则透过叶孔看穿）', () => {
  const reg = makeRegistry();
  const stoneId = reg.idOf('stone'), leafId = reg.idOf('leaves');
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  const y = WORLD_MIN_Y + 5;
  // 左右各一块石头，中间是树叶：石头朝叶的 2 面必须保留
  col.blocks[blockIndex(7, y, 8)] = stoneId;
  col.blocks[blockIndex(8, y, 8)] = leafId;
  col.blocks[blockIndex(9, y, 8)] = stoneId;
  world.add(col);
  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  // 石(6) + 石(6) = 12 面全部保留（朝叶的那面不再被剔）；叶 6 面减去朝石头的 2 面 = 4 面。
  // 修前：石头朝叶的 2 面也被剔 → 10 面 = 40 顶点（用户可见的穿帮）
  assertEqual(result.opaque.vertexCount, 12 * 4, `石头贴树叶：两块石头各 6 面全保留（含朝叶的 1 面）`);
  assertEqual(result.cutout.vertexCount, 4 * 4, `树叶自身朝石头的 2 面仍须剔除（避免 z-fighting）`);
});

test('mesher: 树叶贴树叶 → 共享面照旧互剔（1×2×1 叶柱 = 10 面）', () => {
  // 防「把镂空遮挡体整类降成 opaqueTable=0」这种改法：那会让**叶-叶**共享面也不剔，
  // 实测同一片 8³ 叶团顶点 1584 → 12316（×7.78）。
  const reg = makeRegistry();
  const leafId = reg.idOf('leaves');
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  const y = WORLD_MIN_Y + 5;
  col.blocks[blockIndex(8, y, 8)] = leafId;
  col.blocks[blockIndex(9, y, 8)] = leafId;
  world.add(col);
  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  assertEqual(result.cutout.vertexCount, 10 * 4, '两片相邻树叶：10 面（共享面仍在剔除）');
  assertEqual(result.opaque.vertexCount, 0, '树叶不进 opaque 通道');
});

test('mesher: 石头贴石头 → 照旧剔除（镂空体判据不得波及普通实心方块）', () => {
  const reg = makeRegistry();
  const stoneId = reg.idOf('stone');
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  const y = WORLD_MIN_Y + 5;
  col.blocks[blockIndex(8, y, 8)] = stoneId;
  col.blocks[blockIndex(9, y, 8)] = stoneId;
  world.add(col);
  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  assertEqual(result.opaque.vertexCount, 10 * 4, '两块石头：10 面（既有行为不变）');
});

test('mesher: azalea_flowers 与 azalea_leaves 面剔除口径一致（都必须是镂空遮挡体）', () => {
  // v1.70 一并修掉的历史漏网：azalea_flowers 是唯一漏写 opaque:true 的树叶族
  // （gen 里与 azalea_leaves 混生成花），opaqueTable=0 → 它自己的叶-叶共享面不剔，
  // 实测同一片叶团 11292 顶点 vs 树叶 3352（贵 3.4 倍）。
  const reg = makeRegistry();
  const flowerId = reg.idOf('azalea_flowers'), leafId = reg.idOf('azalea_leaves');
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  const y = WORLD_MIN_Y + 5;
  col.blocks[blockIndex(8, y, 8)] = flowerId;
  col.blocks[blockIndex(9, y, 8)] = leafId;
  world.add(col);
  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  assertEqual(result.cutout.vertexCount, 10 * 4, 'azalea_flowers 与 azalea_leaves 相邻：10 面（共享面剔除）');
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

// 「仅对角遮挡」AO 断言（§4.3 有意偏离 mc-lite 第 ⑤ 项）：
// 场景 = y=0 整片石头地面 + (8,1,8) 单个墙角块 B。地面格 (9,0,9) 顶面靠 B 的角
// 顶点 (9,1,9)：两侧邻居 (8,1,9)/(9,1,8) 都开阔，只有对角 B 遮挡。
// mc-lite 原版 AOUtils 的对角门控 `(side1||side2)?corner:0` 会让该顶点 AO=3（最亮）
// → 东南对角格无阴影，与东/南两格（AO=2 有阴影）之间出现一条阴影断层。
// 本仓库去掉门控 → 该顶点 AO=2，阴影连成环。
//
// 断言落点刻意避开两个恒真陷阱（CLAUDE.md 活跃约束 / testing-policy §2.5）：
// ① 不硬编码被测代码写入的值——期望值 2 由「3 - (0+0+对角遮挡1)」手算得出，
//    现行门控代码会算成 3 → 本测试在未改源码时**真实失败**（RED 可验证）；
// ② 按「位置 + 顶面 face 位」定位顶点，不依赖顶点序；并断言该空间顶点在
//    **所有共享它的顶面 quad 里 AO 一致**（跨 quad 不一致正是「阴影断层」的成因）。
test('mesher: AO 仅对角遮挡顶点 AO=2（去门控，阴影连成环）', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  const stoneId = reg.idOf('stone');
  const y0 = WORLD_MIN_Y + 5; // 地面层
  // 前置断言钉住前提：地面与墙角块都真实存在（避免断言到不存在的分支）
  for (let lx = 0; lx < 16; lx++) {
    for (let lz = 0; lz < 16; lz++) col.blocks[blockIndex(lx, y0, lz)] = stoneId;
  }
  col.blocks[blockIndex(8, y0 + 1, 8)] = stoneId; // 墙角块 B
  world.add(col);
  computeSkylightColumn(col, reg); // 全露天 sky=15 → brightness=1，隔离 AO 变量

  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  const { positions, packed } = result.opaque;
  assertTrue(col.blocks[blockIndex(8, y0 + 1, 8)] === stoneId, '墙角块 B 存在');

  // **positions 是 section 局部坐标**（mesher.js 推 lx/ly/lz，非世界坐标）。
  // section 0 覆盖 y∈[WORLD_MIN_Y, WORLD_MIN_Y+16)，故局部 ly = 世界 y - WORLD_MIN_Y；
  // cx/cz=0 → 局部 lx/lz 即世界 x/z。地面层 y0 → ly=5，其顶面 ly=6。
  const lxTarget = 9, lzTarget = 9, lyTop = y0 - WORLD_MIN_Y + 1;
  let count = 0;
  const aos = [];
  for (let i = 0; i < result.opaque.vertexCount; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const face = (packed[i] >> 10) & 0x7;
    if (face !== 2) continue; // 只看顶面，排除墙角块自身侧面的 AO=1
    if (Math.abs(x - lxTarget) > 1e-6 || Math.abs(y - lyTop) > 1e-6 || Math.abs(z - lzTarget) > 1e-6) continue;
    count++;
    aos.push((packed[i] >> 8) & 0x3);
  }
  assertTrue(count >= 3, `空间顶点 (9,1,9) 被 ≥3 个地面格顶面共享，实测 ${count}`);
  // 期望：去门控后全部 AO=2（仅对角遮挡）。现行门控代码下会出现 3 → RED。
  for (const ao of aos) {
    assertEqual(ao, 2, '仅对角遮挡顶点 AO=2（跨 quad 一致，无阴影断层）');
  }
});

// ---- 台阶亚体素 AO（八分区占用模型）----
//
// 背景：台阶是 `cullMode:"cutout"` 且未声明 `opaque` → `opaqueTable=0`。而 AO 的遮挡判据
// 只读 `opaqueTable`，于是台阶**既拿不到自己的凹角阴影**（旧口径只采整格邻居，
// 台阶的 0.5 高度面不在采样范围内），**也投不出阴影给邻居**（邻居同样只认 `opaqueTable`）。
// 实测 HEAD 下孤立台阶 48 个顶点几乎全是 AO=3。
//
// 修法 = 把「这个采样点被遮挡吗」的判据从「整格是否 opaque」换成「采样点所在的 1/2 子格
// 是否被该方块占据」。采样点 = 顶点 + 0.25×(法线 + 切向1 + 切向2)：0.25 令采样点的每个
// 分量恒落在 0.25/0.75/1.25（子格中心），永不落在八分区边界 → 无取整歧义。
//
// **纳入范围只有台阶族**（planks_step / planks_step_updown / cobblestone_step /
// cobblestone_step_updown 四种几何，共 6 个方块）。半砖（half_block /
// half_block_updown）与装饰几何（仙人掌/栏杆/花）**不纳入**，逐位保持原样 ——
// 它们的「暗部」没有明确物理意义，纳入只会产生无意义暗块。

// 世界坐标助手：把「台阶在 (8,y0,8) + 若干邻居」搭成一个 section
function meshStepWorld(reg, cells) {
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  for (const [x, y, z, name, meta = 0] of cells) {
    const idx = blockIndex(x, y, z);
    col.blocks[idx] = reg.idOf(name);
    col.meta[idx] = meta;
  }
  world.add(col);
  computeSkylightColumn(col, reg);
  return buildSectionMesh(world.getSectionView(0, 0, 0), reg, atlasMeta, 0, 0, 0);
}

/** 收集某个世界面的全部 AO（按顶点位置索引，便于按坐标断言） */
function aosOfFace(channelData, face) {
  const out = [];
  const { positions, packed } = channelData;
  for (let i = 0; i < channelData.vertexCount; i++) {
    if (((packed[i] >> 10) & 0x7) !== face) continue;
    out.push({
      x: positions[i * 3], y: positions[i * 3 + 1], z: positions[i * 3 + 2],
      ao: (packed[i] >> 8) & 0x3,
    });
  }
  return out;
}

/** 按 quad 分组（pushQuad 每个 quad 恰好发射 4 个连续顶点），只留指定世界面的 quad。
 *  相邻方块的同名面在空间上共享边，纯按坐标过滤会串到隔壁 quad —— 故必须按 quad 分组。 */
function quadsOfFace(channelData, face) {
  const out = [];
  const { positions, packed, vertexCount } = channelData;
  for (let base = 0; base + 4 <= vertexCount; base += 4) {
    if (((packed[base] >> 10) & 0x7) !== face) continue;
    const verts = [];
    for (let k = 0; k < 4; k++) {
      const i = base + k;
      verts.push({
        x: positions[i * 3], y: positions[i * 3 + 1], z: positions[i * 3 + 2],
        ao: (packed[i] >> 8) & 0x3,
      });
    }
    out.push(verts);
  }
  return out;
}

test('mesher: 台阶自身的凹角出 AO 梯度（踏面/竖面，跨 orient 一致）', () => {
  const reg = makeRegistry();
  const y0 = WORLD_MIN_Y + 5;
  const ly = y0 - WORLD_MIN_Y; // section 局部 y
  // ⚠️ **倒置台阶（cobblestone_step_updown）不在本用例里**：它的几何是「上半全幅 +
  // 下半 +X 半幅」，两块体在 x=1.0 处**同高相接**、外侧是空的 —— 没有凹角，孤立时
  // 本来就不该有梯度（实测四角全 AO=3）。它的「衔接」行为由下面两条用例覆盖。
  for (const [name, geom] of [
    ['planks_step', 'planks_step'],
    ['cobblestone_step', 'cobblestone_step'],
    ['sand_step', 'planks_step'],
    ['stone_diorite_step', 'cobblestone_step'],
  ]) {
    assertTrue(reg.geometryNameOf(reg.idOf(name)) === geom, `${name} 走 ${geom} 几何`);
    const result = meshStepWorld(reg, [[8, y0, 8, name]]);
    const quads = result.cutout;
    // 前置：台阶走 cutout 通道且 48 顶点（12 quad）
    assertEqual(quads.vertexCount, 48, `${name} = 12 quad`);
    // 孤立台阶的凹角在**竖面底边**（竖面与踏面交界），不在踏面上 ——
    // 踏面是水平面，四个顶点都是「开阔」（上方空气），本来就该全是 AO=3。
    // 竖面：正置台阶是 x=0.5 处高 0.5 的竖面；倒置台阶是 x=1.0 处下半段的竖面。
    const riserX = name === 'cobblestone_step_updown' ? 1 : 0.5;
    const riser = quadsOfFace(quads, 0).filter((q) =>
      q.every((v) => Math.abs(v.x - (8 + riserX)) < 1e-6))[0];
    assertTrue(!!riser, `${name} 有竖面 quad`);
    // 竖面底边（y 最小那侧）被本格下半层遮挡 → 比顶边暗；顶边上方是空气 → AO=3
    const yMin = Math.min(...riser.map((v) => v.y));
    const yMax = Math.max(...riser.map((v) => v.y));
    const bottom = riser.filter((v) => Math.abs(v.y - yMin) < 1e-6).map((v) => v.ao);
    const top = riser.filter((v) => Math.abs(v.y - yMax) < 1e-6).map((v) => v.ao);
    assertEqual(bottom.length, 2, `${name} 竖面底边 2 顶点`);
    assertEqual(top.length, 2, `${name} 竖面顶边 2 顶点`);
    assertTrue(Math.max(...bottom) < Math.min(...top),
      `${name} 竖面底边（凹角）应比顶边暗：bottom=${JSON.stringify(bottom)} top=${JSON.stringify(top)}`);
  }
});

test('mesher: 台阶给紧邻的实心方块投 AO（衔接）', () => {
  const reg = makeRegistry();
  const y0 = WORLD_MIN_Y + 5;
  // 台阶在 (8,y0,8)，实心地板在 (7,y0-1,8) 与 (8,y0-1,8)；(7,y0-1,8) 的 +Y 面靠台阶那两角
  // 应当比另外两角暗 —— 这正是「台阶与实心方块 AO 衔接」的载荷性判据。
  const result = meshStepWorld(reg, [
    [8, y0, 8, 'planks_step'],
    [7, y0 - 1, 8, 'stone'],
    [8, y0 - 1, 8, 'stone'],
  ], y0);
  const lyFloorTop = y0 - 1 - WORLD_MIN_Y + 1; // 地板顶面局部 y
  // 地板 (7,y0-1,8) 的 +Y quad：顶点 x∈{7,8}、z∈{8,9}、y=lyFloorTop
  const quads = quadsOfFace(result.opaque, 2).filter((q) =>
    q.every((v) => Math.abs(v.y - lyFloorTop) < 1e-6)
    && Math.abs(Math.min(...q.map((v) => v.x)) - 7) < 1e-6
    && Math.abs(Math.max(...q.map((v) => v.x)) - 8) < 1e-6
    && Math.abs(Math.min(...q.map((v) => v.z)) - 8) < 1e-6);
  assertEqual(quads.length, 1, '地板 (7,y0-1,8) 顶面恰好 1 个 quad');
  const faceVerts = quads[0];
  // x=1 侧（x≈8）紧贴台阶 → 应暗；x=0 侧（x≈7）开阔 → 应亮
  const nearStep = faceVerts.filter((v) => v.x > 7.5).map((v) => v.ao);
  const awayStep = faceVerts.filter((v) => v.x < 7.5).map((v) => v.ao);
  assertEqual(nearStep.length, 2, '两个顶点紧贴台阶');
  assertEqual(awayStep.length, 2, '两个顶点远离台阶');
  assertTrue(Math.max(...nearStep) < Math.min(...awayStep),
    `紧贴台阶的顶点应比开阔顶点暗：near=${JSON.stringify(nearStep)} away=${JSON.stringify(awayStep)}`);
});

test('mesher: 台阶 AO 随 orientation 旋转（四向对称）', () => {
  const reg = makeRegistry();
  const y0 = WORLD_MIN_Y + 5;
  const ly = y0 - WORLD_MIN_Y;
  // 凹角 = 竖面底边。竖面的世界朝向随 orient 转：orient 0 竖面朝 +X、o=1 朝 -Z、
  // o=2 朝 -X、o=3 朝 +Z（与 FACE_ROT 同一映射）。四向的「底边比顶边暗」都该成立。
  const FACE_ROT = [[0, 1, 2, 3, 4, 5], [5, 4, 2, 3, 0, 1], [1, 0, 2, 3, 5, 4], [4, 5, 2, 3, 1, 0]];
  const riserFace = FACE_ROT[0][0]; // 模型 +X 面的世界朝向（o=0 时即 +X）
  for (const orient of [0, 1, 2, 3]) {
    const worldFace = FACE_ROT[orient][0]; // 模型 +X 面（正置台阶的竖面）旋转后的世界面
    const r = meshStepWorld(reg, [[8, y0, 8, 'planks_step', orient]]);
    const quads = quadsOfFace(r.cutout, worldFace);
    assertTrue(quads.length > 0, `orient=${orient} 有朝 ${worldFace} 的 quad`);
    // 体积高侧（上半柱）在模型 -X；其竖面是朝「模型 +X」那一面，x 恒 0.5 的那个 quad
    const riser = quads.find((q) => q.every((v) => Math.abs(v.x - (8 + 0.5)) < 1e-6))
      || quads.find((q) => q.every((v) => Math.abs(v.y - (ly + 0.5)) < 1e-6 || Math.abs(v.y - (ly + 1)) < 1e-6));
    assertTrue(!!riser, `orient=${orient} 找到竖面 quad`);
    const yMin = Math.min(...riser.map((v) => v.y));
    const yMax = Math.max(...riser.map((v) => v.y));
    if (Math.abs(yMax - yMin) < 1e-6) continue; // 非竖面（水平面）跳过
    const bottom = riser.filter((v) => Math.abs(v.y - yMin) < 1e-6).map((v) => v.ao);
    const top = riser.filter((v) => Math.abs(v.y - yMax) < 1e-6).map((v) => v.ao);
    assertTrue(Math.max(...bottom) < Math.min(...top),
      `orient=${orient} 竖面底边应比顶边暗：bottom=${JSON.stringify(bottom)} top=${JSON.stringify(top)}`);
  }
  assertTrue(riserFace === 0, '模型 +X 面在 orient=0 时就是世界 +X');
});

test('mesher: 倒置台阶参与遮挡（它没有凹角，但仍是亚体素实体）', () => {
  const reg = makeRegistry();
  const y0 = WORLD_MIN_Y + 5;
  // 倒置台阶 = 上半全幅 + 下半 +X 半幅。它自身没有凹角（上面那条用例已说明），
  // 但它**占据了下半格的一部分** → 与它相邻的整格方块的 AO 必须能看见它。
  // 场景：(8,y0,8) 倒置台阶，其 +X 侧 (9,y0,8) 是石墙；石墙 -X 面的下半段应当变暗。
  // 倒置台阶的下半 +X 半幅在 x∈[0.5,1]、y∈[0,0.5]。
  const wallAOs = (neighbor) => {
    const cells = [[9, y0, 8, 'stone']];
    if (neighbor) cells.push([8, y0, 8, neighbor]);
    const r = meshStepWorld(reg, cells);
    const q = quadsOfFace(r.opaque, 1).find((qq) => qq.every((v) => Math.abs(v.x - 9) < 1e-6));
    assertTrue(!!q, `石墙朝 -X 的面存在（neighbor=${neighbor}）`);
    return q.map((v) => v.ao);
  };
  const withStep = wallAOs('cobblestone_step_updown');
  const noStep = wallAOs(null);
  // 对照：无台阶时整面全 3；有倒置台阶时至少一个顶点变暗。
  assertTrue(noStep.every((a) => a === 3), `无台阶时石墙 -X 面全 AO=3，实测 ${JSON.stringify(noStep)}`);
  assertTrue(Math.min(...withStep) < 3,
    `倒置台阶的实心部分应给石墙投 AO，实测 ${JSON.stringify(withStep)}`);
});

test('mesher: 台阶 AO 不波及整格世界与未纳入的形状（零回归）', () => {
  const reg = makeRegistry();
  const y0 = WORLD_MIN_Y + 5;
  // ① 整格世界：一片地板 + 凸起 + 一层树叶（镂空遮挡体）→ 全部顶点 AO 必须等于
  //    「整格口径」手算值。这里用对照法：把这些方块换成同形状的「整格」邻居组合不现实，
  //    故改钉「已知的墙角/开阔取值」：开阔面恒 3、单侧遮挡恒 2、双墙恒 0。
  const cells = [];
  for (let x = 2; x < 12; x++) for (let z = 2; z < 12; z++) cells.push([x, y0, z, 'stone']);
  cells.push([5, y0 + 1, 5, 'stone']);
  const r = meshStepWorld(reg, cells);
  // 平坦地板（远离 (5,y0+1,5) 墙角块）的顶面恒 AO=3。墙角块那一圈会因遮挡变暗，
  // 那是既有口径（含「去对角门控」的副作用），不属于本次改动范围 —— 故只取远离它的格子。
  const lyTop = y0 - WORLD_MIN_Y + 1;
  const tops = aosOfFace(r.opaque, 2).filter((v) =>
    Math.abs(v.y - lyTop) < 1e-6
    && (v.x < 4 - 1e-6 || v.x > 6 + 1e-6 || v.z < 4 - 1e-6 || v.z > 6 + 1e-6));
  assertTrue(tops.length > 0, '平坦地板顶面存在');
  for (const v of tops) assertEqual(v.ao, 3, `平坦地板顶面 AO=3，实测 (${v.x},${v.y},${v.z})`);

  // ② 未纳入的形状（半砖/装饰几何）**自身不产生亚体素遮挡**。
  //    注意区分两件事：它们仍然会被邻居（含台阶）遮挡 —— 那是「衔接」的正确行为，
  //    与「自己被纳入亚体素 AO」是两回事。故判据落在「孤立半砖的角没有梯度」上：
  //    孤立半砖没有邻居，四个踏面顶点必须全为 3（与 HEAD 逐位相同）。
  const slab = meshStepWorld(reg, [[8, y0, 8, 'sand_slab']]);
  const slabTop = aosOfFace(slab.cutout, 2);
  assertEqual(slabTop.length, 4, 'sand_slab 踏面 4 顶点');
  for (const v of slabTop) assertEqual(v.ao, 3, '孤立半砖不纳入亚体素 AO（踏面保持 AO=3）');
  // ③ **纳入集合的边界**：石墙旁放什么，决定石墙 -X 面是否变暗。
  //    这是最有判别力的一条 —— 台阶族（含倒置）→ 墙变暗；半砖 → 墙保持全亮。
  //    （漏了它就抓不到「误把 half_block 加进 STEP_BOXES」这类回归：实测注入后
  //      孤立半砖用例仍全绿，因为半砖踏面本来就没有梯度。）
  const wallAOs = (neighbor) => {
    const cells = [[9, y0, 8, 'stone']];
    if (neighbor) cells.push([8, y0, 8, neighbor]);
    const r = meshStepWorld(reg, cells);
    const q = quadsOfFace(r.opaque, 1).find((qq) => qq.every((v) => Math.abs(v.x - 9) < 1e-6));
    assertTrue(!!q, `石墙 -X 面存在（neighbor=${neighbor}）`);
    return q.map((v) => v.ao);
  };
  const expectDarker = (n) => {
    const ao = wallAOs(n);
    assertTrue(ao.every((a) => a < 3), `${n} 是亚体素实体 → 石墙应变暗，实测 ${JSON.stringify(ao)}`);
  };
  const expectBright = (n) => {
    const ao = wallAOs(n);
    assertTrue(ao.every((a) => a === 3), `${n} 不在纳入集合 → 石墙应保持全亮，实测 ${JSON.stringify(ao)}`);
  };
  expectBright('sand_slab');
  expectBright('cactus'); // 装饰几何同理不纳入
  expectDarker('planks_step');
  expectDarker('cobblestone_step_updown');
  // ⚠️ **`planks_step_updown` 刻意不列在这里**（实测否决，勿「补齐」）：
  // 本 helper 把石墙固定在台阶的 **+X** 侧、且 meta 恒 0。而它的几何是
  // 「上半全幅 + 下半 **-X** 半幅」⇒ orient 0 时 +X 侧只有上半是实心的，
  // 实测石墙 -X 面四个顶点**全为 AO=3**（不变暗）—— 写 `expectDarker` 会假失败。
  // 它在 orient 2（旋转 180°，下半换到 +X）时才变暗（实测全 2）。
  // 它的亚体素 AO 参与由下面那条**专门的镜像用例**覆盖（按实测值写，不靠推断）。

  // 反向确认：把它换成台阶，同样的孤立场景必须出现梯度（证明 ② 的判据有判别力）
  const step = meshStepWorld(reg, [[8, y0, 8, 'planks_step']]);
  const stepRiser = quadsOfFace(step.cutout, 0).find((q) => q.every((v) => Math.abs(v.x - (8 + 0.5)) < 1e-6));
  assertTrue(!!stepRiser, '孤立台阶有竖面');
  const stepAos = stepRiser.map((v) => v.ao);
  assertTrue(new Set(stepAos).size > 1, `孤立台阶竖面应有梯度，实测 ${JSON.stringify(stepAos)}`);
});

test('mesher: 倒置木台阶的 AO 梯度是正置台阶的**竖直镜像**（中世纪船 Epic）', () => {
  const reg = makeRegistry();
  const y0 = WORLD_MIN_Y + 5;
  // ⚠️ **本用例不能并进上面「台阶自身的凹角出 AO 梯度」那张枚举表**：那条断言的是
  // 「竖面**底边**比顶边暗」（正置台阶的凹角在下半柱与踏面交界），而
  // `planks_step_updown` 是**上下颠倒**的 —— 它的凹角在竖面**顶边**，方向恰好相反。
  // 混进那张表会让正确实现 FAIL（同 AGENTS.md「写断言前先在真实数据上跑一次」）。
  //
  // 实测（孤立方块，x=8.5 处的竖面）：
  //   planks_step         y[5.50,6.00] → 底 2 / 顶 3（底暗）
  //   planks_step_updown  y[5.00,5.50] → 底 3 / 顶 2（顶暗）
  const riserAOs = (name) => {
    const r = meshStepWorld(reg, [[8, y0, 8, name]]);
    assertEqual(r.cutout.vertexCount, 48, `${name} = 12 quad / 48 顶点（与正置台阶同）`);
    const riser = quadsOfFace(r.cutout, 0)
      .find((q) => q.every((v) => Math.abs(v.x - (8 + 0.5)) < 1e-6));
    assertTrue(!!riser, `${name} 有 x=8.5 的竖面`);
    const yMin = Math.min(...riser.map((v) => v.y));
    const yMax = Math.max(...riser.map((v) => v.y));
    const bottom = riser.filter((v) => Math.abs(v.y - yMin) < 1e-6).map((v) => v.ao);
    const top = riser.filter((v) => Math.abs(v.y - yMax) < 1e-6).map((v) => v.ao);
    return { bottom, top };
  };
  const normal = riserAOs('planks_step');
  const updown = riserAOs('planks_step_updown');
  // 正置：底暗顶亮
  assertTrue(Math.max(...normal.bottom) < Math.min(...normal.top),
    `正置台阶竖面底边应比顶边暗：bottom=${JSON.stringify(normal.bottom)} top=${JSON.stringify(normal.top)}`);
  // 倒置：**顶暗底亮**（镜像）—— 这条是本用例的载荷性判据
  assertTrue(Math.max(...updown.top) < Math.min(...updown.bottom),
    `倒置木台阶竖面**顶边**应比底边暗（凹角在上）：bottom=${JSON.stringify(updown.bottom)} top=${JSON.stringify(updown.top)}`);
  // 两者的取值集合必须互为镜像（同一组 AO 值，上下对调）
  assertDeepEqual([...updown.bottom].sort(), [...normal.top].sort(),
    '倒置台阶的底边 AO == 正置台阶的顶边 AO（竖直镜像）');
  assertDeepEqual([...updown.top].sort(), [...normal.bottom].sort(),
    '倒置台阶的顶边 AO == 正置台阶的底边 AO（竖直镜像）');
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
  const packed = result.opaque.packed; // chimney cullMode=opaque（仍在 opaque 通道）
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

test('mesher: chimney 不剔除邻居面——下方屋顶顶面保持可见（2026-09-30 修复）', () => {
  // 用户报告：小房子烟囱底部接触的方块面是透明的（屋顶顶面出现洞）。
  // 根因：registry 按 `cullMode === 'opaque'` 推 opaqueTable，而 cullMode 是**渲染通道**
  // 语义、opaqueTable 是**面剔除**语义（两套口径）→ chimney 因材质不透明进了 opaque 通道，
  // 连带被误判成「占满整格、可剔除邻居面」。实测本仓库全部非 box 几何方块的 opaqueTable
  // 都是 0（cutout 通道），chimney 与 bed_head/bed_tail 是唯二漏网。
  // mc-lite 侧是实例级渲染（CylinderGeometry，ChunkConsolidation.js:98），根本没有面剔除。
  // 修法 = cloud 同款手法：cullMode:"opaque"（留在 opaque 通道）+ 显式 "opaque":false。
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  const y = WORLD_MIN_Y + 5;
  col.blocks[blockIndex(8, y, 8)] = reg.idOf('stone');       // 屋顶块
  col.blocks[blockIndex(8, y + 1, 8)] = reg.idOf('chimney'); // 烟囱在其上
  world.add(col);
  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  // stone 6 面全保留（chimney 不剔除邻居面）+ chimney 模板 24 quad → (6+24)×4 顶点
  assertEqual(result.opaque.vertexCount, 30 * 4,
    'stone 六面全保留（顶面不被 chimney 剔除）+ chimney 24 quad');
  // 对照组：上方换成实心 opaque 块（stone）时共享面应正常剔除 → 10 面
  // （钉住「修复没有把面剔除整体关掉」）
  const world2 = new WorldData(reg);
  const col2 = new ChunkColumn(0, 0);
  col2.blocks[blockIndex(8, y, 8)] = reg.idOf('stone');
  col2.blocks[blockIndex(8, y + 1, 8)] = reg.idOf('stone');
  world2.add(col2);
  const r2 = buildSectionMesh(world2.getSectionView(0, 0, 0), reg, atlasMeta, 0, 0, 0);
  assertEqual(r2.opaque.vertexCount, 10 * 4, '对照：两个实心 opaque 块共享面正常剔除');
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

// packed bit14 = 太阳阴影不投射标记（§4.4.4，对齐 mc-lite isShadowEnabled:false）
const NO_SHADOW_CAST_BIT = (1 << 14);

test('mesher: cloud 置 bit14（不投影），stone 不置（投影）', () => {
  const reg = makeRegistry();
  const cloud = meshSingle(reg, 'cloud');
  assertTrue(cloud.opaque.vertexCount > 0, 'cloud 在 opaque 通道');
  for (let i = 0; i < cloud.opaque.vertexCount; i++) {
    assertEqual((cloud.opaque.packed[i] & NO_SHADOW_CAST_BIT) ? 1 : 0, 1, `cloud vert${i} bit14 置位`);
  }
  const stone = meshSingle(reg, 'stone');
  for (let i = 0; i < stone.opaque.vertexCount; i++) {
    assertEqual((stone.opaque.packed[i] & NO_SHADOW_CAST_BIT) ? 1 : 0, 0, `stone vert${i} bit14 不置位`);
  }
});

test('mesher: 全部 shadowCast:false 方块置 bit14，其余方块不置（与 registry 表双向一致）', () => {
  const reg = makeRegistry();
  // 逐方块验证：声明侧（blocks-data 的 shadowCast:false）↔ 派生侧（mesher 写的 bit14）一致。
  // 只验在渲染通道内的方块（cullMode none 无顶点可验）。
  for (const def of BLOCKS) {
    if (def.cullMode === 'none') continue;
    const result = meshSingle(reg, def.name);
    const ch = result[def.cullMode];
    assertTrue(ch.vertexCount > 0, `${def.name} 在 ${def.cullMode} 通道有顶点`);
    const expectBit = def.shadowCast === false ? 1 : 0;
    for (let i = 0; i < ch.vertexCount; i++) {
      assertEqual((ch.packed[i] & NO_SHADOW_CAST_BIT) ? 1 : 0, expectBit,
        `${def.name} vert${i} bit14 应为 ${expectBit}`);
    }
  }
});

test('mesher: bit14 不污染既有位段（light/AO/face/emissive 各位段独立）', () => {
  const reg = makeRegistry();
  const result = meshSingle(reg, 'hanging_lamp'); // 同时有 bit13（灯体）与 bit14（不投影）
  const packed = result.cutout.packed;
  for (let i = 0; i < result.cutout.vertexCount; i++) {
    const faceIdx = (packed[i] >> 10) & 0x7;
    assertTrue(faceIdx <= 5, `face 索引 ${faceIdx} 应在 0-5`);
    assertTrue((packed[i] & 0xFF) > 0, 'light 位未被污染');
    // bit13（emissive）与 bit14（noShadowCast）独立：灯体顶点两位都置，绳顶点只置 bit14
    const em = (packed[i] >> 13) & 1;
    const ns = (packed[i] >> 14) & 1;
    assertEqual(ns, 1, `hanging_lamp vert${i} bit14 置位`);
    assertTrue(em === 0 || em === 1, `bit13 独立可读（vert${i} em=${em}）`);
  }
});

// packed bit19 = 云专属着色标记（v3.50）。消费方 = materials.js 的三个着色地板
// （太阳项 / 半球环境 / AO），令云的暗面不再死暗而亮面逐位不动。
const CLOUD_SOFT_BIT = (1 << 19);

test('mesher: cloud 置 bit19（云专属着色），stone/snow/marble/leaves 不置', () => {
  const reg = makeRegistry();
  // ⚠️ **判别性用例**：实现若写成「整个 opaque 通道都置位」，
  // stone/snow/marble 三条真红 —— 而那正是「全世界的背光面都被抬亮」的缺陷形态。
  const cases = [
    ['cloud', 'opaque', 1],
    ['stone', 'opaque', 0],
    ['snow', 'opaque', 0],
    ['marble', 'opaque', 0],
    ['leaves', 'cutout', 0],
  ];
  for (const [name, channel, expectBit] of cases) {
    const ch = meshSingle(reg, name)[channel];
    // 前提断言：防「零顶点时循环不跑」的恒真
    assertTrue(ch.vertexCount > 0, `${name} 在 ${channel} 通道有顶点`);
    for (let i = 0; i < ch.vertexCount; i++) {
      assertEqual((ch.packed[i] & CLOUD_SOFT_BIT) ? 1 : 0, expectBit,
        `${name} vert${i} bit19 应为 ${expectBit}`);
    }
  }
});

test('mesher: cloud 的 bit19 不污染 bit0-18（位段隔离）', () => {
  const reg = makeRegistry();
  const ch = meshSingle(reg, 'cloud').opaque;
  assertTrue(ch.vertexCount > 0, 'cloud 在 opaque 通道');
  for (let i = 0; i < ch.vertexCount; i++) {
    const p = ch.packed[i];
    assertEqual(p & 0xFF, 0xF0, `cloud vert${i} light 位未变`);
    assertTrue(((p >>> 8) & 3) <= 3, `cloud vert${i} AO 位合法`);
    assertTrue(((p >>> 10) & 7) <= 5, `cloud vert${i} face 位在 0-5`);
    assertEqual((p >>> 13) & 1, 0, `cloud vert${i} 非自发光`);
    // ⚠️ 这两条是本轮最易被挤占的：bit14 挤了会让云**开始投影**（用户明确阴影不动），
    // bit15-18 挤了会翻转湿表面分类（云吃满强度湿分支 ⇒ 高空光晕，v3.31 用户报告过）。
    assertEqual((p >>> 14) & 1, 1, `cloud vert${i} bit14 不投影（语义未动）`);
    assertEqual((p >>> 15) & 0xF, 0, `cloud vert${i} wetClass = NONE`);
  }
});

test('mesher: bit19 只对 cloud 置位 —— 与方块名双向一致（全 registry 扫描）', () => {
  const reg = makeRegistry();
  let checked = 0;
  for (const def of BLOCKS) {
    if (def.cullMode === 'none') continue;   // 无渲染通道 ⇒ 无顶点可验
    const ch = meshSingle(reg, def.name)[def.cullMode];
    if (ch.vertexCount === 0) continue;
    const expectBit = def.name === 'cloud' ? 1 : 0;
    for (let i = 0; i < ch.vertexCount; i++) {
      assertEqual((ch.packed[i] & CLOUD_SOFT_BIT) ? 1 : 0, expectBit,
        `${def.name} vert${i} bit19 应为 ${expectBit}`);
    }
    checked++;
  }
  // 防「全部跳过」的恒真
  assertTrue(checked > 100, `实际验了 ${checked} 个方块（需 > 100）`);
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
  const meta = await fetch(resourceUrl('assets/atlas.json')).then((r) => r.json());
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
