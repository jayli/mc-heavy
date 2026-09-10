// src/tests/test-zombie-nests.js — M7：丧尸巢穴（蓝图 / 持久化 / 刷怪搜索 / 事件失效）
// 本文件是 Tier 1 单测：覆盖「改坏了肉眼玩不出来」的部分 —— GEN 接管后 edits 与 anchor
// 必须一起重建，否则下一次 flush 会以只含新编辑的 edits Map 覆盖该 column 的旧存档
// （锚点静默丢失 → 巢穴失效但玩家不知道）。真实 `_onGenResult` 接管路径直接覆盖，
// 不能只测 ChunkColumn 的孤立 Map（testing-policy §2.7：断言落点须落在真实接线上）。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertNull, assertNotNull, assertDeepEqual } from './assert.js';
import { WORLD_MIN_Y, BLOCKS_PER_COLUMN, blockIndex } from '../voxel/constants.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';
import { WorldEditor } from '../core/world-editor.js';
import { Scheduler } from '../core/scheduler.js';
import { Persistence } from '../save/persistence.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { parseNestBlueprint, loadNestBlueprint } from '../entities/zombie-nests/nest-blueprint.js';
import { ZombieNestService } from '../entities/zombie-nests/zombie-nest-service.js';
import { ZombieNestController } from '../entities/zombie-nests/zombie-nest-controller.js';
import { NEST } from '../entities/zombie-nests/nest-config.js';

function makeRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}

/** 构造与 Scheduler worker GEN 回包同形的结果（typed buffer，无对象 Map）。 */
function generatedColumnResult(cx, cz) {
  const blocks = new Uint16Array(BLOCKS_PER_COLUMN);
  const meta = new Uint8Array(BLOCKS_PER_COLUMN);
  const light = new Uint8Array(BLOCKS_PER_COLUMN);
  // 铺一层地面，使 world.setBlock 的后续编辑落在真实方块上（模拟玩家在该 column 新放一块）
  for (let i = 0; i < 256; i++) blocks[i] = 1;
  return { cx, cz, blocks: blocks.buffer, meta: meta.buffer, light: light.buffer };
}

/** 最小 Scheduler：无 renderWorld（GEN-only 模式），pool 用桩件（本测试不走 RPC）。 */
function makeScheduler({ world, registry, getEdits }) {
  return new Scheduler({
    world,
    pool: { call: () => ({ id: 0, promise: Promise.resolve(null) }) },
    registry,
    seed: 1,
    getEdits,
  });
}

test('GEN 接管后 restoreEdits 保留旧 edits 与 anchor，下一次 flush 不覆盖', async () => {
  const registry = makeRegistry();
  const world = new WorldData(registry);
  const persistence = new Persistence();
  await persistence.open();
  await persistence.clearAllEdits(); // 隔离其它用例残留

  const key = '0,0';
  const stoneId = registry.idOf('stone');
  const goldId = registry.idOf('gold_block');
  const dirtId = registry.idOf('dirt');
  const stoneIdx = blockIndex(1, WORLD_MIN_Y + 1, 1);
  const anchorIdx = blockIndex(2, WORLD_MIN_Y + 5, 2);
  const edits = [
    { index: stoneIdx, id: stoneId, meta: 0 },
    {
      index: anchorIdx, id: goldId, meta: 0,
      blockEntity: {
        kind: 'zombie-nest', id: 'nest-a', origin: [2, WORLD_MIN_Y, 2],
        critical: { x: 2, y: WORLD_MIN_Y + 5, z: 2, id: goldId }, lastSpawnAt: 0,
      },
    },
  ];
  persistence.editsCache.set(key, edits);

  const scheduler = makeScheduler({ world, registry, getEdits: (k) => persistence.getEditsSync(k) });
  scheduler._onGenResult(key, generatedColumnResult(0, 0));

  const col = world.getColumn(0, 0);
  assertTrue(!!col, '接管后 column 存在');
  assertEqual(col.edits.size, 2, '接管必须重建 edits Map（否则 flush 覆盖旧存档）');
  assertEqual(col.blockEntities.size, 1, '接管必须重建 blockEntities');
  assertEqual(world.getBlockEntity(2, WORLD_MIN_Y + 5, 2).id, 'nest-a');
  assertEqual(col.version, 0, '重放不 bump version');

  world.setBlock(3, WORLD_MIN_Y + 1, 3, dirtId); // 模拟后来编辑
  await persistence.flushNow(world);

  // 绕过缓存直读 IndexedDB —— 断言的是**落盘**结果，不是内存缓存
  const row = await persistence._get('edits', key);
  const saved = row.edits;
  assertEqual(saved.length, 3, '旧 2 项 + 新 1 项（flush 不得整库替换成只有新编辑）');
  const anchor = saved.find((e) => e.index === anchorIdx);
  assertTrue(!!anchor, 'anchor edit 仍在');
  assertEqual(anchor.blockEntity.kind, 'zombie-nest', 'blockEntity 未被序列化丢弃');
  assertEqual(anchor.blockEntity.id, 'nest-a');
  const stone = saved.find((e) => e.index === stoneIdx);
  assertEqual(stone.blockEntity, undefined, '无 entity 的 edit 不带该字段');
  await persistence.clearAllEdits();
});

test('Persistence.listBlockEntities 从 edits store 枚举锚点（不依赖已加载 column）', async () => {
  const persistence = new Persistence();
  await persistence.open();
  await persistence.clearAllEdits();
  const goldId = 7;
  await persistence.saveColumnEdits('0,0', [
    { index: 10, id: 1, meta: 0 },
    { index: 20, id: goldId, meta: 0, blockEntity: { kind: 'zombie-nest', id: 'nest-a' } },
  ]);
  await persistence.saveColumnEdits('5,-3', [
    { index: 30, id: goldId, meta: 0, blockEntity: { kind: 'zombie-nest', id: 'nest-b' } },
    { index: 31, id: 1, meta: 0, blockEntity: { kind: 'other', id: 'x' } },
  ]);
  const anchors = await persistence.listBlockEntities('zombie-nest');
  assertEqual(anchors.length, 2, '只返回匹配 kind 的条目');
  const keys = anchors.map((a) => a.columnKey).sort();
  assertEqual(keys[0], '0,0');
  assertEqual(keys[1], '5,-3');
  assertEqual(anchors.find((a) => a.columnKey === '0,0').index, 20);
  assertEqual(anchors.find((a) => a.columnKey === '0,0').blockEntity.id, 'nest-a');
  await persistence.clearAllEdits();
});

test('WorldEditor.setBlockEntity 只写 entity：不 bump version、不 remesh/light', () => {
  const registry = makeRegistry();
  const world = new WorldData(registry);
  const col = new ChunkColumn(0, 0);
  col.state = 'ready';
  world.add(col);
  const calls = [];
  const editor = new WorldEditor({
    world,
    scheduler: {
      remeshSections: (affected, opts) => calls.push({ remesh: affected.length, opts }),
      enqueueLight: (cx, cz) => calls.push({ light: [cx, cz] }),
    },
    persistence: { scheduleFlush: () => calls.push({ flush: true }) },
  });
  const goldId = registry.idOf('gold_block');
  world.setBlock(2, WORLD_MIN_Y + 5, 2, goldId);
  const versionBefore = col.version;
  calls.length = 0;

  const report = editor.setBlockEntity({
    x: 2, y: WORLD_MIN_Y + 5, z: 2,
    value: { kind: 'zombie-nest', id: 'nest-a', lastSpawnAt: 8000 },
  });
  assertEqual(world.getBlockEntity(2, WORLD_MIN_Y + 5, 2).lastSpawnAt, 8000);
  assertEqual(col.version, versionBefore, '纯 entity 写不 bump version');
  assertEqual(calls.filter((c) => c.remesh !== undefined).length, 0, '不 remesh');
  assertEqual(calls.filter((c) => c.light !== undefined).length, 0, '不入 light 队列');
  assertEqual(calls.filter((c) => c.flush).length, 1, '仍记入 edits 并调度 flush');
  assertEqual(report.changes.length, 0, 'entity 写不产生方块 change');
  assertEqual(col.edits.get(blockIndex(2, WORLD_MIN_Y + 5, 2)).blockEntity.lastSpawnAt, 8000);
});

test('WorldEditor.setBlockEntity value=null 删除锚点', () => {
  const registry = makeRegistry();
  const world = new WorldData(registry);
  const col = new ChunkColumn(0, 0);
  col.state = 'ready';
  world.add(col);
  const editor = new WorldEditor({
    world,
    scheduler: { remeshSections: () => {}, enqueueLight: () => {} },
    persistence: { scheduleFlush: () => {} },
  });
  const goldId = registry.idOf('gold_block');
  world.setBlock(2, WORLD_MIN_Y + 5, 2, goldId, 0, { kind: 'zombie-nest', id: 'nest-a' });
  editor.setBlockEntity({ x: 2, y: WORLD_MIN_Y + 5, z: 2, value: null });
  assertNull(world.getBlockEntity(2, WORLD_MIN_Y + 5, 2), '锚点删除');
  assertEqual(col.blockEntities.size, 0);
  assertEqual(col.edits.get(blockIndex(2, WORLD_MIN_Y + 5, 2)).blockEntity, undefined);
  assertEqual(world.getBlockId(2, WORLD_MIN_Y + 5, 2), goldId, '方块本体保留');
});

test('WorldEditor.setBlocks 事件携带 old/newBlockEntity，破坏关键方块时清锚点', () => {
  const registry = makeRegistry();
  const world = new WorldData(registry);
  const col = new ChunkColumn(0, 0);
  col.state = 'ready';
  world.add(col);
  const editor = new WorldEditor({
    world,
    scheduler: { remeshSections: () => {}, enqueueLight: () => {} },
    persistence: { scheduleFlush: () => {} },
  });
  const goldId = registry.idOf('gold_block');
  world.setBlock(2, WORLD_MIN_Y + 5, 2, goldId, 0, { kind: 'zombie-nest', id: 'nest-a' });
  const events = [];
  editor.subscribe((e) => events.push(e));

  // TNT 等价批量破坏：同一编辑入口，事件须带 oldBlockEntity 供 controller 失效判定
  editor.setBlocks([{ x: 2, y: WORLD_MIN_Y + 5, z: 2, id: 0 }]);
  assertEqual(events.length, 1);
  assertEqual(events[0].changes.length, 1);
  assertEqual(events[0].changes[0].oldBlockEntity.id, 'nest-a', '事件带旧 entity');
  assertEqual(events[0].changes[0].newBlockEntity, undefined, '事件带新 entity（此处无）');
  assertNull(world.getBlockEntity(2, WORLD_MIN_Y + 5, 2), '徒手/武器/TNT 共用同一失效语义');
});

test('WorldEditor.setBlock 事件携带 oldBlockEntity（徒手破坏路径）', () => {
  const registry = makeRegistry();
  const world = new WorldData(registry);
  const col = new ChunkColumn(0, 0);
  col.state = 'ready';
  world.add(col);
  const editor = new WorldEditor({
    world,
    scheduler: { remeshSections: () => {}, enqueueLight: () => {} },
    persistence: { scheduleFlush: () => {} },
  });
  const goldId = registry.idOf('gold_block');
  world.setBlock(2, WORLD_MIN_Y + 5, 2, goldId, 0, { kind: 'zombie-nest', id: 'nest-a' });
  const events = [];
  editor.subscribe((e) => events.push(e));
  editor.setBlock({ x: 2, y: WORLD_MIN_Y + 5, z: 2, id: 0 });
  assertEqual(events.length, 1);
  assertEqual(events[0].changes[0].oldBlockEntity.id, 'nest-a');
  assertNull(world.getBlockEntity(2, WORLD_MIN_Y + 5, 2));
});

// ==================== Task 2：蓝图校验与原子放置 ====================

/** 玩家 AABB（脚底中心 + 0.6×1.8×0.6，与 physics.js 常数同源）。 */
function playerAabbAt(x, y, z) {
  return { minX: x - 0.3, maxX: x + 0.3, minY: y, maxY: y + 1.8, minZ: z - 0.3, maxZ: z + 0.3 };
}

/**
 * 放置 fixture：真实 WorldData（全空气、ready）+ **记录调用但仍委托真实 world** 的 fake editor。
 * fake editor 必须真改世界 —— 否则第二次在同 origin 放置不会被判 'occupied'
 * （testing-policy §2.7：fake 与真实接线口径不一致会让断言恒真）。
 */
function makeNestFixture(blueprint) {
  const registry = makeRegistry();
  const world = new WorldData(registry);
  // 覆盖 origin x∈[0..130] / z∈[-2..2] → cx -1..9、cz -1..1
  for (let cx = -1; cx <= 9; cx++) {
    for (let cz = -1; cz <= 1; cz++) {
      const col = new ChunkColumn(cx, cz);
      col.state = 'ready';
      world.add(col);
    }
  }
  const calls = [];
  const editor = {
    calls,
    setBlocks(changes) { calls.push({ setBlocks: changes }); return world.setBlocks(changes); },
    setBlock(c) {
      calls.push({ setBlock: c });
      return world.setBlock(c.x, c.y, c.z, c.id, c.meta ?? 0);
    },
    setBlockEntity(req) {
      calls.push({ setBlockEntity: req });
      // fake 仍委托真实 world：destroy 删锚点后断言 world.getBlockEntity===null 才是真断言
      const cx = Math.floor(req.x / 16), cz = Math.floor(req.z / 16);
      const col = world.getColumn(cx, cz);
      if (col) col.setBlockEntity(req.x - cx * 16, req.y, req.z - cz * 16, req.value);
      return { changes: [], affected: [], changedColumns: [], skipped: [] };
    },
    subscribe: () => () => {},
  };
  const nests = new ZombieNestService({ world, editor, registry, blueprint });
  return { nests, editor, world, registry };
}

test('蓝图：38 项展开、唯一最高格 [0,5,0] 为 gold_block', async () => {
  const registry = makeRegistry();
  const blueprint = await loadNestBlueprint(registry);
  const changes = blueprint.changesAt([0, 0, 0]);
  assertEqual(changes.length, 38, '蓝图恰 38 个方块');
  const critical = blueprint.criticalAt([0, 0, 0]);
  assertEqual(critical.x, 0);
  assertEqual(critical.y, 5, '最高格相对 y=5');
  assertEqual(critical.z, 0);
  assertEqual(critical.id, registry.idOf('gold_block'));
  // 只有 critical 一格是 gold_block（唯一性）
  assertEqual(changes.filter((c) => c.id === registry.idOf('gold_block')).length, 1);
  // origin 平移生效
  const shifted = blueprint.changesAt([10, 20, -5]);
  assertEqual(shifted.length, 38);
  const shiftedCritical = blueprint.criticalAt([10, 20, -5]);
  assertEqual(shiftedCritical.x, 10);
  assertEqual(shiftedCritical.y, 25);
  assertEqual(shiftedCritical.z, -5);
});

test('蓝图：boundsAt 覆盖结构占地（玩家重叠判定用）', async () => {
  const registry = makeRegistry();
  const blueprint = await loadNestBlueprint(registry);
  const b = blueprint.boundsAt([0, 0, 0]);
  // 方块 x∈[-2..2] 各占 [x,x+1) → x∈[-2,3)；y∈[1..5] → y∈[1,6)；z 同 x
  assertEqual(b.minX, -2);
  assertEqual(b.maxX, 3);
  assertEqual(b.minY, 1);
  assertEqual(b.maxY, 6);
  assertEqual(b.minZ, -2);
  assertEqual(b.maxZ, 3);
});

test('蓝图：两个最高格 → 抛 invalid-blueprint', () => {
  const registry = makeRegistry();
  const gold = registry.idOf('gold_block');
  const sand = registry.idOf('sand');
  let threw = null;
  try {
    parseNestBlueprint(registry, {
      blocks: [
        { x: 0, y: 1, z: 0, type: 'sand' },
        { x: 0, y: 5, z: 0, type: 'gold_block' },
        { x: 1, y: 5, z: 0, type: 'gold_block' }, // 第二个最高格 → 无唯一关键方块
      ],
    });
  } catch (err) { threw = err; }
  assertTrue(threw !== null, '两个最高格必须抛错');
  assertEqual(threw.code, 'invalid-blueprint');
  assertEqual(gold !== sand, true, '前置：gold 与 sand 是不同方块');
});

test('蓝图：最高格不是 gold_block → 抛 invalid-blueprint', () => {
  const registry = makeRegistry();
  let threw = null;
  try {
    parseNestBlueprint(registry, {
      blocks: [
        { x: 0, y: 1, z: 0, type: 'sand' },
        { x: 0, y: 5, z: 0, type: 'sand' }, // 最高格是 sand，不是关键方块
      ],
    });
  } catch (err) { threw = err; }
  assertTrue(threw !== null);
  assertEqual(threw.code, 'invalid-blueprint');
});

test('蓝图：未知方块名 → 抛 invalid-blueprint', () => {
  const registry = makeRegistry();
  let threw = null;
  // ⚠️ 未知名字必须落在**非最高格** —— 否则下游的「最高格不是 gold」校验会兜住它，
  // 使本条断言恒真（实测无效盲区：把未知名校验去掉后测试仍全绿）。
  // 这里最高格是合法 gold_block，未知名字在 y=1 的支撑格。
  try {
    parseNestBlueprint(registry, {
      blocks: [
        { x: 0, y: 1, z: 0, type: 'no_such_block' }, // 未知名字在非最高格
        { x: 0, y: 5, z: 0, type: 'gold_block' },    // 最高格合法 → gold 校验不触发
      ],
    });
  } catch (err) { threw = err; }
  assertTrue(threw !== null, '未知方块名必须抛错（即使最高格合法）');
  assertEqual(threw.code, 'invalid-blueprint');
});

test('ZombieNestService: 第九个、碰撞和玩家重叠均零写入', async () => {
  const registry = makeRegistry();
  const blueprint = await loadNestBlueprint(registry);
  const { nests, editor } = makeNestFixture(blueprint);
  for (let i = 0; i < 8; i++) {
    const r = nests.place({ origin: [i * 12, 0, 0], playerAabb: null });
    assertTrue(r.ok, `第 ${i + 1} 个须成功（reason=${r.reason}）`);
  }
  const before = editor.calls.length;
  assertEqual(nests.place({ origin: [100, 0, 0], playerAabb: null }).reason, 'limit');
  assertEqual(nests.place({ origin: [0, 0, 0], playerAabb: null }).reason, 'occupied');
  // 玩家站在 origin 120 的结构占地内 → player-overlap
  assertEqual(
    nests.place({ origin: [120, 0, 0], playerAabb: playerAabbAt(120.5, 2, 0) }).reason,
    'player-overlap',
  );
  assertEqual(editor.calls.length, before, '失败路径不得写世界');
});

test('ZombieNestService: 蓝图缺失 → invalid-blueprint 且零写入', () => {
  const { nests, editor } = makeNestFixture(null); // 加载失败的退化路径
  const r = nests.place({ origin: [0, 0, 0], playerAabb: null });
  assertEqual(r.ok, false);
  assertEqual(r.reason, 'invalid-blueprint');
  assertEqual(editor.calls.length, 0);
});

test('ZombieNestService: 越界 origin → bounds 且零写入', async () => {
  const registry = makeRegistry();
  const blueprint = await loadNestBlueprint(registry);
  const { nests, editor } = makeNestFixture(blueprint);
  // y 高到结构顶端超出 WORLD_MAX_Y
  assertEqual(nests.place({ origin: [0, 95, 0], playerAabb: null }).reason, 'bounds');
  // column 未加载 → 同样按 bounds 处理（不得写世界）
  assertEqual(nests.place({ origin: [5000, 0, 0], playerAabb: null }).reason, 'bounds');
  assertEqual(editor.calls.length, 0);
});

test('ZombieNestService: 成功放置 = 单次事务、38 项、唯一 anchor、无 alias 方块', async () => {
  const registry = makeRegistry();
  const blueprint = await loadNestBlueprint(registry);
  const { nests, editor, world } = makeNestFixture(blueprint);
  const r = nests.place({ origin: [0, 0, 0], playerAabb: null });
  assertTrue(r.ok);
  assertTrue(typeof r.id === 'string' && r.id.length > 0, 'id 非空');
  assertEqual(r.anchor.length, 3);
  assertEqual(r.anchor[0], 0);
  assertEqual(r.anchor[1], 5);
  assertEqual(r.anchor[2], 0);

  const setBlocksCalls = editor.calls.filter((c) => c.setBlocks);
  assertEqual(setBlocksCalls.length, 1, '结构写入与 anchor 必须属于同一次事务');
  const changes = setBlocksCalls[0].setBlocks;
  assertEqual(changes.length, 38);
  const aliasId = registry.idOf('zombie_nest_alias_block');
  assertEqual(changes.filter((c) => c.id === aliasId).length, 0, 'alias 只是触发物品，不写入蓝图');
  const withEntity = changes.filter((c) => c.blockEntity);
  assertEqual(withEntity.length, 1, '只有 critical change 携带 blockEntity');
  const entity = withEntity[0].blockEntity;
  assertEqual(entity.kind, 'zombie-nest');
  assertEqual(entity.id, r.id);
  assertEqual(entity.origin[0], 0);
  assertEqual(entity.origin[1], 0);
  assertEqual(entity.origin[2], 0);
  assertEqual(entity.critical.x, 0);
  assertEqual(entity.critical.y, 5);
  assertEqual(entity.critical.z, 0);
  assertEqual(entity.critical.id, registry.idOf('gold_block'));
  assertEqual(entity.lastSpawnAt, 0);

  // anchor 真的写进了世界（不是只构造了 changes）
  assertEqual(world.getBlockEntity(0, 5, 0)?.id, r.id);
  assertEqual(world.getBlockId(0, 5, 0), registry.idOf('gold_block'));
});

test('ZombieNestService: destroy 删锚点与索引，之后可再放置', async () => {
  const registry = makeRegistry();
  const blueprint = await loadNestBlueprint(registry);
  const { nests, editor, world } = makeNestFixture(blueprint);
  const r = nests.place({ origin: [0, 0, 0], playerAabb: null });
  assertEqual(nests.count(), 1, '全局索引计数');
  assertTrue(nests.destroy(r.id), 'destroy 返回 true');
  assertNull(world.getBlockEntity(0, 5, 0), '锚点已删');
  assertEqual(nests.count(), 0, '索引移除');
  assertEqual(nests.destroy(r.id), false, '重复 destroy 返回 false');
  assertTrue(editor.calls.some((c) => c.setBlockEntity), '删锚点走 setBlockEntity');
  // **结构方块仍在世界里**：destroy 只使巢穴失效（删锚点），不清除 38 个方块 ——
  // 那是未来 TNT/爆炸 Epic 的职责（M7 规格 §1「不另开破坏路径」）。故同 origin 仍 occupied。
  assertEqual(nests.place({ origin: [0, 0, 0], playerAabb: null }).reason, 'occupied');
  assertEqual(world.getBlockId(0, 5, 0), registry.idOf('gold_block'), '关键方块本体保留');
  // 上限已释放：换个空 origin 可放置
  const r2 = nests.place({ origin: [24, 0, 0], playerAabb: null });
  assertTrue(r2.ok);
  assertEqual(nests.count(), 1);
});

// ==================== Task 3：事件失效、六层刷怪、column 生命周期 ====================

/**
 * 刷怪搜索 fixture：真实 WorldData（**全空气**）+ 记录调用的 fake zombies / editor。
 *
 * 为什么用「全空气 + 单点支撑」而不是随便铺地面：刷怪合法性判据是「脚空 + 头空 + 脚下 solid」。
 * 全空气世界里 `isSolid` 处处为 false → **48 个候选全部非法**；此后只在某一个候选的脚下
 * 铺一块 stone，就使该候选成为**唯一**合法位置。于是 spawn 收到的坐标直接暴露扫描顺序
 * —— 这是精确钉住「八个偏移 × 六层」的关键手法（笼统的「半径 3 / 五层」实现会挑出别的格）。
 */
function makeSpawnFixture({ origin = [8, 0, 8] } = {}) {
  const registry = makeRegistry();
  const world = new WorldData(registry);
  // 覆盖 origin ± 4 格 → cx/cz 各 -1..1
  for (let cx = -1; cx <= 1; cx++) {
    for (let cz = -1; cz <= 1; cz++) {
      const col = new ChunkColumn(cx, cz);
      col.state = 'ready';
      world.add(col);
    }
  }
  const goldId = registry.idOf('gold_block');
  const stoneId = registry.idOf('stone');
  const anchor = {
    kind: 'zombie-nest', id: 'nest-a', origin: [...origin],
    critical: { x: origin[0], y: origin[1] + 5, z: origin[2], id: goldId },
    lastSpawnAt: 0,
  };
  const spawnCalls = [];
  const entityWrites = [];
  const zombies = {
    spawn(position, opts) { spawnCalls.push({ position, source: opts?.source ?? null }); return 'z-1'; },
  };
  const editor = {
    setBlockEntity(req) { entityWrites.push(req); return { changes: [], affected: [], changedColumns: [], skipped: [] }; },
  };
  const controller = new ZombieNestController({ world, zombies, editor, anchor });
  /** 在某个候选的脚下铺支撑，使该候选成为唯一合法位置。 */
  const supportAt = (baseX, footY, baseZ) => world.setBlock(baseX, footY - 1, baseZ, stoneId);
  /** 阻塞某个候选的头格 footY+1（使其非法）—— 钉住「两格空腔」口径，不只是脚格空。 */
  const blockHeadAt = (baseX, footY, baseZ) => world.setBlock(baseX, footY + 1, baseZ, stoneId);
  /** 候选坐标（offset 序号 k、层 dy）。 */
  const candidateAt = (k, dy) => {
    const off = NEST.spawnOffsets[k];
    return { x: origin[0] + off.x, footY: origin[1] + 1 + dy, z: origin[2] + off.z };
  };
  return { world, registry, controller, zombies, editor, spawnCalls, entityWrites, supportAt, blockHeadAt, candidateAt, origin, goldId, anchor };
}

test('刷怪搜索：全合法时取第一个偏移 {0,3} 的最高层 dy=3', () => {
  const f = makeSpawnFixture();
  const c0 = f.candidateAt(0, 3);
  f.supportAt(c0.x, c0.footY, c0.z);
  f.controller.update(8_000);
  assertEqual(f.spawnCalls.length, 1);
  // 首个合法位置以 [baseX+.5, footY, baseZ+.5] 调用 spawn（mc-lite 同口径）
  assertEqual(f.spawnCalls[0].position[0], f.origin[0] + 0 + 0.5);
  assertEqual(f.spawnCalls[0].position[1], f.origin[1] + 4, 'footY = origin.y+1+3');
  assertEqual(f.spawnCalls[0].position[2], f.origin[2] + 3 + 0.5);
  assertEqual(f.spawnCalls[0].source, 'nest-a', 'spawn 须带 source=nestId');
});

test('刷怪搜索：dy=3 无支撑时退化到同偏移的 dy=2（六层降序，不是笼统的五层）', () => {
  const f = makeSpawnFixture();
  // ⚠️ 只铺 dy=2 的支撑，**不要**额外铺 dy=3 的支撑再阻塞它 —— 相邻层的支撑格
  // (footY-1) 正是下一层的脚格，给 dy=3 铺支撑会把 dy=2 的脚格填掉 → 两层互相污染
  // （实测踩坑：spawn 数为 0，两条都判非法）。
  // 只铺 dy=2 支撑时，dy=3 自动因「脚下无支撑」非法 —— 这正好是要测的降级路径。
  const c2 = f.candidateAt(0, 2);
  f.supportAt(c2.x, c2.footY, c2.z);
  f.controller.update(8_000);
  assertEqual(f.spawnCalls.length, 1);
  assertEqual(f.spawnCalls[0].position[1], f.origin[1] + 3, '退化到 dy=2');
  assertEqual(f.spawnCalls[0].position[2], f.origin[2] + 3 + 0.5, '仍是第一个偏移 {0,3}');
});

test('刷怪搜索：第一个偏移全非法时跳到第二个偏移 {3,0}（偏移顺序固定）', () => {
  const f = makeSpawnFixture();
  // 全空气世界 → 偏移 {0,3} 的六层全部因「脚下无支撑」自动非法，无需手动阻塞。
  // 只给偏移 {3,0} 的 dy=3 铺支撑，它就成了唯一合法位置。
  const c1 = f.candidateAt(1, 3);
  f.supportAt(c1.x, c1.footY, c1.z);
  f.controller.update(8_000);
  assertEqual(f.spawnCalls.length, 1);
  assertEqual(f.spawnCalls[0].position[0], f.origin[0] + 3 + 0.5, '跳到第二个偏移 {3,0}');
  assertEqual(f.spawnCalls[0].position[2], f.origin[2] + 0 + 0.5);
  assertEqual(f.spawnCalls[0].position[1], f.origin[1] + 4);
});

test('刷怪搜索：最深一层 dy=-2 可达（六层不是五层）', () => {
  const f = makeSpawnFixture();
  // 只铺 dy=-2 的支撑：上层（dy=3..-1）全部因「脚下无支撑」自动非法，无需手动阻塞。
  // （勿给上层铺支撑 —— 那会填掉下层脚格，见上一条注释）
  const cBottom = f.candidateAt(0, -2);
  f.supportAt(cBottom.x, cBottom.footY, cBottom.z);
  f.controller.update(8_000);
  assertEqual(f.spawnCalls.length, 1);
  assertEqual(f.spawnCalls[0].position[1], f.origin[1] - 1, 'footY = origin.y+1-2');
});

test('刷怪搜索：八个偏移的最后一个 {-2,-2} 可达', () => {
  const f = makeSpawnFixture();
  // 只给最后一个偏移 {-2,-2} 铺支撑 → 前七个偏移全部因「脚下无支撑」自动非法。
  // （勿给前七个偏移铺支撑：那会把偏移 {-2,-2} 各层的脚格填掉，实测 spawn=0）
  const cLast = f.candidateAt(7, 3);
  f.supportAt(cLast.x, cLast.footY, cLast.z);
  f.controller.update(8_000);
  assertEqual(f.spawnCalls.length, 1);
  assertEqual(f.spawnCalls[0].position[0], f.origin[0] - 2 + 0.5);
  assertEqual(f.spawnCalls[0].position[2], f.origin[2] - 2 + 0.5);
});

test('刷怪搜索：头格被占也判非法（两格空腔口径，不只查脚格）', () => {
  const f = makeSpawnFixture();
  // 手法：**同 dy、不同偏移**，让「头格被占」成为唯一变量。
  // 不能用同列的 dy=3/dy=2 对照 —— dy=3 的支撑格正是 dy=2 的脚格，两层无法同时合法。
  const c0 = f.candidateAt(0, 3); // 偏移 {0,3}
  const c1 = f.candidateAt(1, 3); // 偏移 {3,0}
  f.supportAt(c0.x, c0.footY, c0.z); // 两个偏移的 dy=3 都具备支撑 → 本来都合法
  f.supportAt(c1.x, c1.footY, c1.z);
  f.blockHeadAt(c0.x, c0.footY, c0.z); // 只阻塞偏移 {0,3} 的头格
  f.controller.update(8_000);
  assertEqual(f.spawnCalls.length, 1);
  // 若头格检查缺失，会选中偏移 {0,3}（它排在前）；有检查则跳到偏移 {3,0}
  assertEqual(f.spawnCalls[0].position[0], f.origin[0] + 3 + 0.5, '头格被占 → 跳到下一个偏移');
  assertEqual(f.spawnCalls[0].position[1], f.origin[1] + 4, 'dy 仍是 3（证明是头格而非层数问题）');
});

test('刷怪节流：7_999ms 不刷、8_000ms 才刷', () => {
  const f = makeSpawnFixture();
  const c0 = f.candidateAt(0, 3);
  f.supportAt(c0.x, c0.footY, c0.z);
  f.controller.update(7_999);
  assertEqual(f.spawnCalls.length, 0, '未到 8 秒不刷怪');
  assertEqual(f.entityWrites.length, 0, '未到点也不写回 lastSpawnAt');
  f.controller.update(8_000);
  assertEqual(f.spawnCalls.length, 1);
});

test('刷怪：无合法位置仍写回 lastSpawnAt（避免每帧重试）', () => {
  const f = makeSpawnFixture(); // 全空气 → 全部非法
  f.controller.update(8_000);
  assertEqual(f.spawnCalls.length, 0);
  assertEqual(f.entityWrites.length, 1, '失败也写回时钟');
  assertEqual(f.entityWrites[0].value.lastSpawnAt, 8_000);
  assertEqual(f.entityWrites[0].value.id, 'nest-a', '写回的是同一个锚点');
  // 再调一次同一时刻不重复刷（节流生效）
  f.controller.update(8_000);
  assertEqual(f.entityWrites.length, 1);
});

test('刷怪：zombies.spawn 返回 null（满额）仍写回 lastSpawnAt', () => {
  const f = makeSpawnFixture();
  const c0 = f.candidateAt(0, 3);
  f.supportAt(c0.x, c0.footY, c0.z);
  // 全局丧尸满额：spawn 返回 null（M6 口径 string|null，不是 false）
  f.zombies.spawn = () => null;
  f.controller.update(8_000);
  assertEqual(f.entityWrites.length, 1);
  assertEqual(f.entityWrites[0].value.lastSpawnAt, 8_000, '满额仍更新时钟');
});

test('刷怪：成功刷怪后写回 lastSpawnAt 且保留 critical/origin', () => {
  const f = makeSpawnFixture();
  const c0 = f.candidateAt(0, 3);
  f.supportAt(c0.x, c0.footY, c0.z);
  f.controller.update(8_000);
  const written = f.entityWrites[0].value;
  assertEqual(written.kind, 'zombie-nest');
  assertEqual(written.lastSpawnAt, 8_000);
  assertEqual(written.critical.x, f.origin[0]);
  assertEqual(written.critical.id, f.goldId, 'critical 不得在写回时丢失');
  assertDeepEqual(written.origin, f.origin, 'origin 不得在写回时丢失');
});

test('事件失效：徒手破坏关键方块 → controller 通知失效', () => {
  const f = makeSpawnFixture();
  let invalidated = null;
  const controller = new ZombieNestController({
    world: f.world, zombies: f.zombies, editor: f.editor, anchor: f.anchor,
    onInvalidated: (id) => { invalidated = id; },
  });
  // 徒手等价：editor.setBlock(id:0) 产生的 change 带 oldBlockEntity
  controller.onWorldChange({
    type: 'block-changed',
    changes: [{
      x: f.anchor.critical.x, y: f.anchor.critical.y, z: f.anchor.critical.z,
      oldId: f.goldId, oldMeta: 0, newId: 0, newMeta: 0, oldBlockEntity: f.anchor,
    }],
  });
  assertEqual(invalidated, 'nest-a', '破坏关键方块须通知失效');
});

test('事件失效：TNT 等价批量变更同样触发失效', () => {
  const f = makeSpawnFixture();
  let invalidated = null;
  const controller = new ZombieNestController({
    world: f.world, zombies: f.zombies, editor: f.editor, anchor: f.anchor,
    onInvalidated: (id) => { invalidated = id; },
  });
  controller.onWorldChange({
    type: 'block-changed',
    changes: [
      { x: 1, y: 1, z: 1, oldId: 1, oldMeta: 0, newId: 0, newMeta: 0 }, // 无关变更
      {
        x: f.anchor.critical.x, y: f.anchor.critical.y, z: f.anchor.critical.z,
        oldId: f.goldId, oldMeta: 0, newId: 0, newMeta: 0, oldBlockEntity: f.anchor,
      },
    ],
  });
  assertEqual(invalidated, 'nest-a');
});

test('事件失效：关键格被替换成别的方块也失效（newId !== critical.id）', () => {
  const f = makeSpawnFixture();
  let invalidated = null;
  const controller = new ZombieNestController({
    world: f.world, zombies: f.zombies, editor: f.editor, anchor: f.anchor,
    onInvalidated: (id) => { invalidated = id; },
  });
  controller.onWorldChange({
    type: 'block-changed',
    changes: [{
      x: f.anchor.critical.x, y: f.anchor.critical.y, z: f.anchor.critical.z,
      oldId: f.goldId, oldMeta: 0, newId: f.registry.idOf('stone'), newMeta: 0, oldBlockEntity: f.anchor,
    }],
  });
  assertEqual(invalidated, 'nest-a', '换成别的方块同样失效');
});

test('事件失效：无关方块变更不误触发', () => {
  const f = makeSpawnFixture();
  let invalidated = null;
  const controller = new ZombieNestController({
    world: f.world, zombies: f.zombies, editor: f.editor, anchor: f.anchor,
    onInvalidated: (id) => { invalidated = id; },
  });
  controller.onWorldChange({
    type: 'block-changed',
    changes: [{ x: 1, y: 1, z: 1, oldId: 1, oldMeta: 0, newId: 0, newMeta: 0 }],
  });
  assertNull(invalidated, '无关变更不得失效巢穴');
});

test('事件失效：同格写回同 id（纯 entity 更新）不误触发', () => {
  const f = makeSpawnFixture();
  let invalidated = null;
  const controller = new ZombieNestController({
    world: f.world, zombies: f.zombies, editor: f.editor, anchor: f.anchor,
    onInvalidated: (id) => { invalidated = id; },
  });
  controller.onWorldChange({
    type: 'block-changed',
    changes: [{
      x: f.anchor.critical.x, y: f.anchor.critical.y, z: f.anchor.critical.z,
      oldId: f.goldId, oldMeta: 0, newId: f.goldId, newMeta: 0,
      oldBlockEntity: f.anchor, newBlockEntity: { ...f.anchor, lastSpawnAt: 8000 },
    }],
  });
  assertNull(invalidated, 'newId === critical.id → 不失效（刷怪写回时钟不该杀掉巢穴）');
});

test('column 卸载：销毁 controller 但保留 anchor 与索引', () => {
  const registry = makeRegistry();
  const world = new WorldData(registry);
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) {
    const col = new ChunkColumn(cx, cz);
    col.state = 'ready';
    world.add(col);
  }
  const blueprint = null; // 本条只测生命周期，不经 place
  const calls = [];
  const editor = {
    calls,
    setBlocks(changes) { calls.push({ setBlocks: changes }); return world.setBlocks(changes); },
    setBlock(c) { calls.push({ setBlock: c }); return world.setBlock(c.x, c.y, c.z, c.id, c.meta ?? 0); },
    setBlockEntity(req) {
      calls.push({ setBlockEntity: req });
      const cx = Math.floor(req.x / 16), cz = Math.floor(req.z / 16);
      const col = world.getColumn(cx, cz);
      if (col) col.setBlockEntity(req.x - cx * 16, req.y, req.z - cz * 16, req.value);
      return { changes: [], affected: [], changedColumns: [], skipped: [] };
    },
    subscribe: () => () => {},
  };
  const nests = new ZombieNestService({ world, editor, registry, blueprint });
  const goldId = registry.idOf('gold_block');
  world.setBlock(8, 5, 8, goldId, 0, {
    kind: 'zombie-nest', id: 'nest-a', origin: [8, 0, 8],
    critical: { x: 8, y: 5, z: 8, id: goldId }, lastSpawnAt: 0,
  });
  // 手工登记索引（模拟 hydrate / place 的结果）
  nests._index.set('nest-a', { anchor: [8, 5, 8] });
  const controller = new ZombieNestController({ world, zombies: { spawn: () => 'z' }, editor, anchor: world.getBlockEntity(8, 5, 8) });
  nests.setController('nest-a', controller);
  assertEqual(nests.controllers().size, 1);

  // column 卸载：只销毁 controller，anchor 与索引保留（再次加载后能恢复，lastSpawnAt 不重置）
  nests.setController('nest-a', null);
  assertEqual(nests.controllers().size, 0, 'controller 销毁');
  assertEqual(nests.count(), 1, '索引保留 → 上限仍计入');
  assertNotNull(world.getBlockEntity(8, 5, 8), 'anchor 保留');
});

test('hydrate：未加载 column 的锚点仍计入上限（第九个返回 limit）', async () => {
  const registry = makeRegistry();
  const world = new WorldData(registry);
  const blueprint = null;
  const editor = { setBlocks: () => ({ changes: [], skipped: [] }), setBlockEntity: () => ({}) };
  const nests = new ZombieNestService({ world, editor, registry, blueprint });
  const persistence = new Persistence();
  await persistence.open();
  await persistence.clearAllEdits();
  const goldId = registry.idOf('gold_block');
  // 八个锚点分布在**不同且未加载**的 column
  for (let i = 0; i < 8; i++) {
    await persistence.saveColumnEdits(`${i + 50},0`, [{
      index: blockIndex(1, WORLD_MIN_Y + 5, 1), id: goldId, meta: 0,
      blockEntity: {
        kind: 'zombie-nest', id: `nest-${i + 1}`, origin: [(i + 50) * 16 + 1, WORLD_MIN_Y, 1],
        critical: { x: (i + 50) * 16 + 1, y: WORLD_MIN_Y + 5, z: 1, id: goldId }, lastSpawnAt: 0,
      },
    }]);
  }
  await nests.hydrate(persistence);
  assertEqual(nests.count(), 8, '八个锚点全部计入（无一已加载）');
  assertEqual(nests.controllers().size, 0, '没有任何 controller');
  await persistence.clearAllEdits();
});
