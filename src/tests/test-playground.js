// src/tests/test-playground.js — M9：创造台（选址 / 关闭判据 / 锚点持久层 / 导入导出）
// 本文件是 Tier 1 单测：覆盖「改坏了肉眼玩不出来」的部分 —— 选址的未加载判据、
// 硬失败回滚判据、导入的 invalid/skipped 分类、导出的 dimensions 键名形状。
// 断言落点须落在真实接线口径上（testing-policy §2.7）：fake editor 记录调用**同时**把变更
// 应用进真实 WorldData，使后续读取反映平台（只记录不应用会测到一堆恒真断言）。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse } from './assert.js';
import { WORLD_MAX_Y } from '../voxel/constants.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { PLAYGROUND, PLAYGROUND_KIND } from '../entities/playground/playground-config.js';
import { PlaygroundService } from '../entities/playground/playground-service.js';

function makeRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}

/**
 * fake editor：**记录调用 + 委托真实 `WorldData.setBlocks`**。
 * 记录是为了断言「一次事务」（mc-lite 逐块 setBlock 是我们要避开的写法）；
 * 委托是为了让世界读取反映平台 —— 否则 `_hasOverlap` / `exportModel` / `close` 的断言
 * 全落在空世界上，注入缺陷仍会全绿（testing-policy §2.7「恒真陷阱」）。
 */
function makeRecordingEditor(world) {
  return {
    setBlocksCalls: [],
    setBlocks(changes) {
      this.setBlocksCalls.push(changes);
      return world.setBlocks(changes);   // 与 WorldEditor.setBlocks 同一世界写入口径
    },
  };
}

/**
 * 创造台 fixture。
 * @param {{loadedColumns?: Array<[number,number]>, ground?: boolean}} [opts]
 *   `loadedColumns`：显式指定加载哪些 column（**选址的未加载判据是本任务的关键分支** ——
 *   桩件 world 若一律返回「已加载」就测不到它）。
 *   `ground`：在 y=0 铺一层 stone（使 `_findGroundLevelFromBelow` 有地面可找 → 选址确定性）。
 */
function makePlaygroundFixture({ loadedColumns = [], ground = true } = {}) {
  const registry = makeRegistry();
  const world = new WorldData(registry);
  for (const [cx, cz] of loadedColumns) world.add(new ChunkColumn(cx, cz));
  if (ground) {
    const stone = registry.idOf('stone');
    // 铺满 fixture 覆盖范围内的地面（-32..64 × -48..32，含东/西两个候选的全部 20 个 column）
    for (let x = -32; x <= 64; x++) {
      for (let z = -48; z <= 32; z++) world.setBlock(x, 0, z, stone);
    }
  }
  const editor = makeRecordingEditor(world);
  return { world, editor, registry, playground: new PlaygroundService({ world, editor, registry }) };
}

/** 平台覆盖的全部 column（东侧 origin=[20,-17] / 西侧 origin=[0,-17]，各 20 个）。
 *  ⚠️ 东侧含西侧没有的 `cx=4` → 只加载西侧 20 个时东侧必然未加载（B1 的判别性场景）。 */
function columnsFor(originX, originZ) {
  const size = PLAYGROUND.size;
  const cx0 = Math.floor(originX / 16), cx1 = Math.floor((originX + size - 1) / 16);
  const cz0 = Math.floor(originZ / 16), cz1 = Math.floor((originZ + size - 1) / 16);
  const out = [];
  for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) out.push([cx, cz]);
  return out;
}

const PLAYER = { x: 10, y: 4, z: 10 };
const EAST = { x: PLAYER.x + PLAYGROUND.distance, z: PLAYER.z - PLAYGROUND.size / 2 }; // [20,-17]
const WEST = { x: PLAYER.x - PLAYGROUND.distance, z: PLAYER.z - PLAYGROUND.size / 2 }; // [0,-17]
/** 东侧全部 column（含西侧没有的 cx=4） */
const ALL_COLUMNS = columnsFor(EAST.x, EAST.z);
/** 仅西侧 column（东侧因此未加载） */
const WEST_ONLY = columnsFor(WEST.x, WEST.z);

// ---------- 冻结数据 ----------

test('创造台冻结数值：54/10/10/20 与搜索上界 = WORLD_MAX_Y', () => {
  assertEqual(PLAYGROUND.size, 54);
  assertEqual(PLAYGROUND.clearance, 10);
  assertEqual(PLAYGROUND.distance, 10);
  assertEqual(PLAYGROUND.heightSpan, 20);
  // ⚠️ 搜索上界必须是本仓库的 WORLD_MAX_Y（96），不是 mc-lite 的 200 ——
  // 照搬 200 会让搜索恒超出世界顶（`getBlockId` 对上界返回 air）→ 平台写在越界高度上。
  assertEqual(PLAYGROUND.maxSearchY, WORLD_MAX_Y);
  assertFalse(PLAYGROUND.maxSearchY === 200, '不得照搬 mc-lite 的 maxY=200');
  assertEqual(PLAYGROUND_KIND, 'playground');
});

// ---------- 平台生成 ----------

test('创造台：54×54 平台 + 中心标记块，一次事务写入', () => {
  const { playground, editor, registry } = makePlaygroundFixture({ loadedColumns: ALL_COLUMNS });
  const r = playground.create(PLAYER);   // ⚠️ 入参是 {x,y,z}，不是数组
  assertTrue(r.ok);
  assertEqual(editor.setBlocksCalls.length, 1, '**一次**事务（不逐块 setBlock）');
  const changes = editor.setBlocksCalls[0];
  assertEqual(changes.length, PLAYGROUND.size * PLAYGROUND.size);   // 2916 格
  const centerId = registry.idOf('playground_center_block');
  const blockId = registry.idOf('playground_block');
  assertEqual(changes.filter((c) => c.id === centerId).length, 1, '恰一个中心块');
  assertEqual(changes.filter((c) => c.id === blockId).length, 2916 - 1);
  // 中心块带锚点 blockEntity（持久真相 = DR-17 通道）
  const withEntity = changes.filter((c) => c.blockEntity);
  assertEqual(withEntity.length, 1, '只有中心块携带锚点');
  assertEqual(withEntity[0].blockEntity.kind, PLAYGROUND_KIND);
  assertEqual(withEntity[0].blockEntity.size, PLAYGROUND.size);
  assertEqual(withEntity[0].blockEntity.origin[1], r.origin[1], '锚点 origin 与实际落点一致');
  // 世界侧真的写进去了（fake editor 委托真实 WorldData → 断言不落在空世界上）
  assertEqual(playground.world.getBlockId(r.origin[0], r.origin[1], r.origin[2]), blockId);
  assertEqual(playground.world.getBlockId(r.origin[0] + 27, r.origin[1], r.origin[2] + 27), centerId);
  assertEqual(playground.isActive(), true);
});

test('创造台：选址落在东侧（第一个候选优先），origin.y = 地面 + 1', () => {
  const { playground } = makePlaygroundFixture({ loadedColumns: ALL_COLUMNS });
  const r = playground.create(PLAYER);
  assertTrue(r.ok);
  assertEqual(r.origin[0], EAST.x, '东侧优先');
  assertEqual(r.origin[2], EAST.z);
  // 地面在 y=0 → `_findGroundLevelFromBelow` **向下**扫到它 → 返回 y+1 = 1
  assertEqual(r.origin[1], 1, '平台落在地面上方一格（mc-lite 向下扫语义）');
});

test('创造台：东侧 column 未加载时**继续尝试西侧**（不是立即放弃）', () => {
  // ⚠️ **断言必须能区分「试过西侧」与「第一个候选就 return」**：两侧都未加载时 reason 都是
  // not-loaded，区分不出 bug。故构造**东侧未加载、西侧已加载且有净空**的场景 ——
  // 正确实现应经西侧成功创建；若用 `return` 而非 `continue` 则报 not-loaded、零写入。
  const { playground, editor } = makePlaygroundFixture({ loadedColumns: WEST_ONLY });
  const r = playground.create(PLAYER);
  assertTrue(r.ok, '东侧未加载时须经西侧成功创建（若 return 而非 continue 则此处 FAIL）');
  assertEqual(r.origin[0], WEST.x, '平台落在西侧 → 证明西侧确实被尝试过');
  assertEqual(editor.setBlocksCalls.length, 1);
});

test('创造台：所有候选 column 都未加载 → not-loaded 且零写入', () => {
  const { playground, world, editor } = makePlaygroundFixture({ loadedColumns: [] });
  const r = playground.create(PLAYER);
  assertEqual(r.ok, false);
  assertEqual(r.reason, 'not-loaded');
  assertEqual(editor.setBlocksCalls.length, 0, '失败路径零世界写入');
  assertEqual(world.getBlockId(EAST.x, 1, EAST.z), 0);
  assertEqual(playground.isActive(), false);
});

test('创造台：已存在时第二次 create 被拒（全局最多 1 个）', () => {
  const { playground } = makePlaygroundFixture({ loadedColumns: ALL_COLUMNS });
  assertTrue(playground.create(PLAYER).ok);
  const second = playground.create({ x: PLAYER.x + 40, y: 4, z: PLAYER.z });
  assertEqual(second.ok, false);
  assertEqual(second.reason, 'exists');
});

test('创造台：地形挡住净空时向上搜到更高的安全高度', () => {
  const { playground, world, registry } = makePlaygroundFixture({ loadedColumns: ALL_COLUMNS });
  const stone = registry.idOf('stone');
  // 在东侧候选的平台层高度 y=1 上放一格方块 → y=1 判重叠 → 须向上搜到 y=2
  world.setBlock(EAST.x + 3, 1, EAST.z + 3, stone);
  const r = playground.create(PLAYER);
  assertTrue(r.ok);
  assertEqual(r.origin[1], 2, '向上搜到第一个无重叠高度');
  // 平台层写在了 y=2，那格挡路方块（y=1）仍在（平台没覆盖掉它）
  assertEqual(world.getBlockId(EAST.x + 3, 1, EAST.z + 3), stone);
});

// ---------- 关闭 ----------

test('创造台：玩家在平台区域内拒绝关闭；区域外关闭只删平台层、保留模型', () => {
  const { playground, world, registry } = makePlaygroundFixture({ loadedColumns: ALL_COLUMNS });
  assertTrue(playground.create(PLAYER).ok);
  const origin = playground.origin();
  // 在平台上方雕一格模型（关闭后须保留 —— mc-lite 同口径：只删平台格）
  const stone = registry.idOf('stone');
  const cx = origin[0] + 27, cz = origin[2] + 27;
  world.setBlock(cx, origin[1] + 1, cz, stone);
  // 玩家在平台内（XZ 在范围内 + Y 在 [origin.y, origin.y+20)）→ 拒绝关闭
  const inside = { x: origin[0] + 5, y: origin[1] + 1, z: origin[2] + 5 };
  assertEqual(playground.close(inside).reason, 'player-in-playground');
  assertEqual(playground.isActive(), true, '拒绝后仍激活');
  // 平台外 → 关闭成功
  const outside = { x: origin[0] - 20, y: origin[1] + 1, z: origin[2] };
  assertTrue(playground.close(outside).ok);
  assertEqual(playground.isActive(), false);
  assertEqual(playground.origin(), null);
  // 平台层变 air，模型保留
  assertEqual(world.getBlockId(origin[0], origin[1], origin[2]), 0, '平台层删除');
  assertEqual(world.getBlockId(cx, origin[1] + 1, cz), stone, '模型方块保留');
  // 中心块的锚点随方块改写为 air 自动清除（setBlocks 不带 blockEntity 即清除）
  assertEqual(world.getBlockEntity(cx, origin[1], cz), null);
});

test('创造台：未激活时 close 返回 not-active', () => {
  const { playground } = makePlaygroundFixture({ loadedColumns: ALL_COLUMNS });
  assertEqual(playground.close(PLAYER).reason, 'not-active');
});

test('创造台：isPlayerInPlayground 的 Y 跨度 = heightSpan(20)，不是 clearance(10)', () => {
  const { playground } = makePlaygroundFixture({ loadedColumns: ALL_COLUMNS });
  assertTrue(playground.create(PLAYER).ok);
  const [ox, oy, oz] = playground.origin();
  const at = (x, y, z) => playground.isPlayerInPlayground({ x, y, z });
  // 临界值附近断言：y=oy+19 在内、oy+20 在外（若误用 clearance=10 则 oy+11 就会判在外）
  assertTrue(at(ox + 5, oy + 19, oz + 5), 'heightSpan 内（玩家可站在自己雕的高处）');
  assertFalse(at(ox + 5, oy + 20, oz + 5), 'heightSpan 外');
  // ⚠️ 这条是「误用 clearance 会假通过」的判别点：oy+11 在 heightSpan 内 → 必须判**在内**。
  // 若实现误用 clearance(10) 作上界，此处会变成 false → 本断言真 FAIL。
  assertTrue(at(ox + 5, oy + 11, oz + 5), '若误用 clearance(10) 作上界则此处判在外 → FAIL');
  // XZ 边界
  assertFalse(at(ox - 1, oy + 1, oz + 5), 'XZ 出界');
  assertFalse(at(ox + 54, oy + 1, oz + 5), 'XZ 出界（size 是半开区间上界）');
  assertFalse(at(ox + 5, oy - 1, oz + 5), 'Y 低于平台层');
  // 未激活时恒 false（不得把「无平台」判成「在平台内」）
  playground.close({ x: ox - 20, y: oy + 1, z: oz });
  assertFalse(at(ox + 5, oy + 1, oz + 5));
});

// ---------- 锚点持久层 ----------

test('创造台：hydrate 从锚点恢复状态（不遍历已加载 column）', async () => {
  const { playground } = makePlaygroundFixture({ loadedColumns: [] });   // ⚠️ 零 column 也能恢复
  const origin = [20, 1, -17];
  const persistence = {
    listBlockEntities: async (kind) => {
      assertEqual(kind, PLAYGROUND_KIND, '扫库用的 kind 必须与写入侧同源');
      return [{ columnKey: '1,-2', index: 0, blockEntity: { kind, id: 'playground-1', origin, size: 54 } }];
    },
  };
  await playground.hydrate(persistence);
  assertEqual(playground.isActive(), true);
  assertEqual(playground.origin()[0], origin[0]);
  assertEqual(playground.origin()[1], origin[1]);
  assertEqual(playground.origin()[2], origin[2]);
  // 恢复后再 create → exists（上限判定不依赖已加载 controller/column）
  assertEqual(playground.create(PLAYER).reason, 'exists');
});

test('创造台：hydrate 无锚点 → 未激活；缺 origin 的坏锚点被跳过', async () => {
  const { playground } = makePlaygroundFixture({ loadedColumns: [] });
  await playground.hydrate({ listBlockEntities: async () => [] });
  assertEqual(playground.isActive(), false);
  // 坏锚点（无 origin）不得让服务进入激活态
  await playground.hydrate({
    listBlockEntities: async () => [{ columnKey: '1,-2', index: 0, blockEntity: { kind: PLAYGROUND_KIND } }],
  });
  assertEqual(playground.isActive(), false);
});

// ---------- 导入导出 ----------

test('创造台：导出 JSON 格式与 assets/structures/*.json 一致', () => {
  const { playground, world, registry } = makePlaygroundFixture({ loadedColumns: ALL_COLUMNS });
  assertTrue(playground.create(PLAYER).ok);
  const origin = playground.origin();
  // 在平台上雕两格 stone（平台上方一格）
  const stone = registry.idOf('stone');
  const cx = origin[0] + 27, cz = origin[2] + 27;
  world.setBlock(cx, origin[1] + 1, cz, stone);
  world.setBlock(cx + 1, origin[1] + 1, cz, stone);
  const r = playground.exportModel();
  assertTrue(r.ok);
  assertEqual(r.blocks, 2);
  const data = JSON.parse(r.json);
  assertTrue(Array.isArray(data.blocks), '与 structures JSON 同形状');
  assertEqual(data.blocks.length, 2);
  assertEqual(data.blocks[0].type, 'stone');
  assertTrue(Number.isFinite(data.blocks[0].x), '相对坐标');
  assertTrue(Number.isFinite(data.blocks[0].direction));
  // 平台本体不得被导进模型（否则导出即自包含 2916 格平台）
  assertFalse(data.blocks.some((b) => b.type === 'playground_block'));
  assertFalse(data.blocks.some((b) => b.type === 'playground_center_block'));
  // ⚠️ **钉住 dimensions 的键名形状**：只查真值抓不到 `{x,y,z}` vs `{width,height,depth}` 的漂移
  const dims = data.metadata.dimensions;
  assertEqual(dims.width, 2, '两格横向相邻 → width 2');
  assertEqual(dims.height, 1);
  assertEqual(dims.depth, 1);
  assertEqual(dims.x, undefined, '不得有 x 键（旧形状）');
});

test('创造台：空模型导出 dimensions 全 0（不是 NaN）', () => {
  const { playground } = makePlaygroundFixture({ loadedColumns: ALL_COLUMNS });
  assertTrue(playground.create(PLAYER).ok);
  const data = JSON.parse(playground.exportModel().json);
  assertEqual(data.blocks.length, 0);
  assertEqual(data.metadata.dimensions.width, 0);
  assertEqual(data.metadata.dimensions.height, 0);
  assertEqual(data.metadata.dimensions.depth, 0);
});

test('创造台：导出/导入未激活时返回 not-active', () => {
  const { playground } = makePlaygroundFixture({ loadedColumns: ALL_COLUMNS });
  assertEqual(playground.exportModel().reason, 'not-active');
  assertEqual(playground.importModel('{}').reason, 'not-active');
});

test('创造台：导入时未知方块名计 invalid 且**不写 air**', () => {
  const { playground, world, registry } = makePlaygroundFixture({ loadedColumns: ALL_COLUMNS });
  assertTrue(playground.create(PLAYER).ok);
  const origin = playground.origin();
  const stone = registry.idOf('stone');
  const cx = origin[0] + 27, cz = origin[2] + 27;
  // 先在目标位置放一格 stone（若导入误写 air 会把它删掉）
  world.setBlock(cx, origin[1] + 1, cz, stone);
  const r = playground.importModel(JSON.stringify({ blocks: [
    { x: 0, y: 1, z: 0, type: 'no_such_block', direction: 0 },   // 未知方块名
  ] }));   // **同步**返回（规格 §2.4）
  assertTrue(r.ok);
  assertEqual(r.invalid, 1);
  assertEqual(r.placed, 0);
  assertEqual(world.getBlockId(cx, origin[1] + 1, cz), stone, '已有方块未被删');
});

test('创造台：导入分类 —— 不可渲染计 skipped / 重复坐标只留首次 / 非法项计 invalid', () => {
  const { playground, registry } = makePlaygroundFixture({ loadedColumns: ALL_COLUMNS });
  assertTrue(playground.create(PLAYER).ok);
  const r = playground.importModel(JSON.stringify({ blocks: [
    { x: 0, y: 1, z: 0, type: 'stone', direction: 0 },
    { x: 0, y: 1, z: 0, type: 'stone', direction: 0 },        // 重复坐标 → skipped
    { x: 1, y: 1, z: 0, type: 'collider', direction: 0 },     // cullMode:'none' → skipped
    { x: 2, y: 1, z: 0, direction: 0 },                       // 缺 type → invalid
    { x: 'abc', y: 1, z: 0, type: 'stone', direction: 0 },    // 非数值坐标 → invalid
    null,                                                     // 非对象 → invalid
  ] }));
  assertTrue(r.ok);
  assertEqual(r.placed, 1);
  assertEqual(r.skipped, 2);
  assertEqual(r.invalid, 3);
  // collider 确实不可渲染（断言落在真实 registry 表上，不是凭名字猜）
  assertEqual(registry.cullTable[registry.idOf('collider')], 3);
});

test('创造台：导入的 direction → orientation 换算取水平四方向（含负数）', () => {
  const { playground, world, registry } = makePlaygroundFixture({ loadedColumns: ALL_COLUMNS });
  assertTrue(playground.create(PLAYER).ok);
  const origin = playground.origin();
  const cx = origin[0] + 27, cz = origin[2] + 27;
  playground.importModel(JSON.stringify({ blocks: [
    { x: 0, y: 1, z: 0, type: 'stone', direction: -1 },   // ((-1 % 4) + 4) % 4 = 3
    { x: 1, y: 1, z: 0, type: 'stone', direction: 6 },    // 6 % 4 = 2
    { x: 2, y: 1, z: 0, type: 'stone', direction: 'x' },  // 非数值 → 0
  ] }));
  const stone = registry.idOf('stone');
  assertEqual(world.getBlockId(cx, origin[1] + 1, cz), stone);
  assertEqual(world.getBlockMeta(cx, origin[1] + 1, cz), 3);
  assertEqual(world.getBlockMeta(cx + 1, origin[1] + 1, cz), 2);
  assertEqual(world.getBlockMeta(cx + 2, origin[1] + 1, cz), 0);
});

test('创造台：导入 JSON 非法 → invalid-json / invalid-format（不写世界）', () => {
  const { playground, editor } = makePlaygroundFixture({ loadedColumns: ALL_COLUMNS });
  assertTrue(playground.create(PLAYER).ok);
  const before = editor.setBlocksCalls.length;
  assertEqual(playground.importModel('not json').reason, 'invalid-json');
  assertEqual(playground.importModel(JSON.stringify({ nope: 1 })).reason, 'invalid-format');
  assertEqual(editor.setBlocksCalls.length, before, '非法输入零世界写入');
});

test('创造台：导入 Y 越界按本仓库世界边界判 invalid（不是 mc-lite 的 0~255）', () => {
  const { playground } = makePlaygroundFixture({ loadedColumns: ALL_COLUMNS });
  assertTrue(playground.create(PLAYER).ok);
  const origin = playground.origin();
  // origin.y=1 → 相对 y 使绝对 y 超出 [-32, 96) 上界
  const r = playground.importModel(JSON.stringify({ blocks: [
    { x: 0, y: 200, z: 0, type: 'stone', direction: 0 },
  ] }));
  assertTrue(r.ok);
  assertEqual(r.invalid, 1);
  assertEqual(r.placed, 0);
  assertEqual(playground.world.getBlockId(origin[0] + 27, origin[1] + 200, origin[2] + 27), 0);
});
