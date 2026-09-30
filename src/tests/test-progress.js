// src/tests/test-progress.js — 进度导入导出：codec 纯函数（Tier 1）
// 本文件覆盖「改坏了肉眼玩不出来」的部分：坐标编解码的互逆、未知/非法方块条目的分类、
// 包格式校验（format/version/seed）失败时**零输出**。
//
// ⚠️ 为什么断言落在 codec 而不是面板/E2E 上：面板只做文件 I/O 与 toast，真正的风险在
// 「index ↔ 坐标」的算术与「坏条目不得写 air」（M9 导入踩过同一个坑：未知方块名写成 0
// 会静默删掉玩家已有的方块）。这两条都能被纯函数单测直接钉住。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse, assertDeepEqual, assertStringIncludes } from './assert.js';
import {
  WORLD_MIN_Y, WORLD_MAX_Y, blockIndex, decodeBlockIndex,
} from '../voxel/constants.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import {
  PROGRESS_FORMAT, PROGRESS_VERSION, encodeProgress, decodeProgress,
} from '../save/progress-codec.js';

function makeRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}

const REGISTRY = makeRegistry();
const STONE = REGISTRY.idOf('stone');
const DIRT = REGISTRY.idOf('dirt');

/** 造一条 edits 记录（`Persistence.saveColumnEdits` 的同一形状） */
function edit(lx, y, lz, id, meta = 0, blockEntity) {
  const row = { index: blockIndex(lx, y, lz), id, meta };
  if (blockEntity !== undefined) row.blockEntity = blockEntity;
  return row;
}

const NEST_ANCHOR = {
  kind: 'zombie-nest', id: 'nest-1', origin: [2, -32, 2],
  critical: { x: 2, y: -27, z: 2, id: 7 }, lastSpawnAt: 1234,
};

// ---------- 坐标编解码互逆（导出/导入的唯一算术） ----------

test('进度包：decodeBlockIndex 是 blockIndex 的逆（全 y 范围抽样互逆）', () => {
  // 取样覆盖 y 下界/上界/lx 与 lz 边界：编码把 (lx, y, lz) 折进一维，用错移位会在
  // 高位（lz=15）或低位（lx=0）上偏一格 —— 只在中间取值会侥幸通过。
  for (let y = WORLD_MIN_Y; y < WORLD_MAX_Y; y += 7) {
    for (const lx of [0, 1, 7, 15]) {
      for (const lz of [0, 3, 15]) {
        const { lx: rlx, y: ry, lz: rlz } = decodeBlockIndex(blockIndex(lx, y, lz));
        if (rlx !== lx || ry !== y || rlz !== lz) {
          throw new Error(`互逆失败：(${lx},${y},${lz}) → (${rlx},${ry},${rlz})`);
        }
      }
    }
  }
  assertTrue(true);
});

// ---------- 导出：形状与坐标 ----------

test('进度包：encode 产出的 JSON 可被 JSON.parse，坐标用 columnKey + 列内局部坐标', () => {
  const json = encodeProgress({
    seed: 12345,
    spawn: [10, 6],
    columns: [{ columnKey: '3,-2', edits: [edit(1, WORLD_MIN_Y + 5, 2, STONE, 3)] }],
    entities: [],
  }, REGISTRY);
  const data = JSON.parse(json);
  assertEqual(data.format, PROGRESS_FORMAT);
  assertEqual(data.version, PROGRESS_VERSION);
  assertEqual(data.seed, 12345);
  assertDeepEqual(data.spawn, [10, 6]);
  assertEqual(data.columns.length, 1);
  assertEqual(data.columns[0].key, '3,-2');
  const cell = data.columns[0].cells[0];
  assertEqual(cell.x, 3 * 16 + 1, '世界 x = column.cx * 16 + lx');
  assertEqual(cell.z, -2 * 16 + 2, '世界 z = column.cz * 16 + lz（负坐标不得漂移）');
  assertEqual(cell.y, WORLD_MIN_Y + 5);
  assertEqual(cell.type, 'stone', '方块存**名字**而非数字 id（跨版本稳定）');
  assertEqual(cell.meta, 3);
});

test('进度包：blockEntity 原样往返（巢穴锚点不得丢字段）', () => {
  const json = encodeProgress({
    seed: 7,
    spawn: [1, 1],
    columns: [{ columnKey: '0,0', edits: [edit(2, WORLD_MIN_Y + 8, 3, DIRT, 0, NEST_ANCHOR)] }],
    entities: [{ id: 'minecart-3', type: 'minecart', state: { position: [1, 2, 3] } }],
  }, REGISTRY);
  const decoded = decodeProgress(json, REGISTRY);
  assertTrue(decoded.ok, `解码失败：${decoded.reason}`);
  const out = decoded.edits[0].edits[0];
  assertEqual(out.id, DIRT);
  assertEqual(out.index, blockIndex(2, WORLD_MIN_Y + 8, 3), 'index 必须回到存储层口径');
  assertDeepEqual(out.blockEntity, NEST_ANCHOR, 'blockEntity 深比较（丢字段 = 重启后装置失效）');
  assertEqual(decoded.entities.length, 1);
  assertEqual(decoded.entities[0].id, 'minecart-3');
  assertDeepEqual(decoded.entities[0].state, { position: [1, 2, 3] });
});

test('进度包：无 blockEntity 的条目解码后不带该字段（不是 undefined 键）', () => {
  const json = encodeProgress({
    seed: 7, spawn: [1, 1],
    columns: [{ columnKey: '0,0', edits: [edit(1, WORLD_MIN_Y + 1, 1, STONE)] }],
    entities: [],
  }, REGISTRY);
  const decoded = decodeProgress(json, REGISTRY);
  assertTrue(decoded.ok);
  assertFalse('blockEntity' in decoded.edits[0].edits[0],
    '无 entity 的条目不得带空字段（structuredClone 下会存成 null，语义漂移）');
});

// ---------- 导入：分类与安全 ----------

test('进度包：未知方块名计 invalid 且**不写 air**（不产出该条目）', () => {
  const json = JSON.stringify({
    format: PROGRESS_FORMAT, version: PROGRESS_VERSION, seed: 5, spawn: [1, 1],
    columns: [{ key: '0,0', cells: [
      { x: 1, y: 0, z: 1, type: 'stone', meta: 0 },
      { x: 2, y: 0, z: 2, type: 'no_such_block', meta: 0 },
    ] }],
    entities: [],
  });
  const decoded = decodeProgress(json, REGISTRY);
  assertTrue(decoded.ok);
  assertEqual(decoded.invalid, 1);
  assertEqual(decoded.edits[0].edits.length, 1, '未知名字不产生条目（写 air 会删掉玩家已有方块）');
  assertEqual(decoded.edits[0].edits[0].id, STONE);
});

test('进度包：越界 y 与非整数坐标计 invalid，不产生条目', () => {
  const bad = [
    { x: 1, y: WORLD_MAX_Y, z: 1, type: 'stone', meta: 0 },      // 上界越界（MAX_Y exclusive）
    { x: 1, y: WORLD_MIN_Y - 1, z: 1, type: 'stone', meta: 0 },  // 下界越界
    { x: 1.5, y: 0, z: 1, type: 'stone', meta: 0 },              // 非整数 x
    { x: 1, y: 'abc', z: 1, type: 'stone', meta: 0 },           // 非数值 y
    { x: 1, y: 0, z: 1, type: 7, meta: 0 },                      // type 非字符串
    null,                                                         // 非对象
  ];
  const json = JSON.stringify({
    format: PROGRESS_FORMAT, version: PROGRESS_VERSION, seed: 5, spawn: [1, 1],
    columns: [{ key: '0,0', cells: bad }], entities: [],
  });
  const decoded = decodeProgress(json, REGISTRY);
  assertTrue(decoded.ok);
  assertEqual(decoded.invalid, bad.length);
  assertEqual(decoded.edits.length, 0, '全部无效 → 不产生空 column 行');
});

test('进度包：column key 与坐标不自洽的条目按 key 所属 column 读（key 是权威）', () => {
  // key 决定归属 column，cells 的 x/z 是**世界坐标**（不与 key 求一致性校验 —— 越界 x 只
  // 影响 index 落在哪一格）。本用例钉住「取 key 的 cx/cz 做换算」而不是「从 x 反推 column」。
  const json = JSON.stringify({
    format: PROGRESS_FORMAT, version: PROGRESS_VERSION, seed: 5, spawn: [1, 1],
    columns: [{ key: '2,3', cells: [{ x: 2 * 16 + 5, y: 1, z: 3 * 16 + 6, type: 'stone', meta: 2 }] }],
    entities: [],
  });
  const decoded = decodeProgress(json, REGISTRY);
  assertTrue(decoded.ok);
  assertEqual(decoded.edits[0].columnKey, '2,3');
  assertEqual(decoded.edits[0].edits[0].index, blockIndex(5, 1, 6));
  assertEqual(decoded.edits[0].edits[0].meta, 2);
});

test('进度包：cell 的 x/z 落在 key 之外 → invalid（错位写入会在别的 column 造出幽灵方块）', () => {
  // key '0,0' 的 cell 却给了 cx=1 的 x（16..31）→ 该 index 会写进 0,0 的 column 但语义是
  // 「cx=1 的方块」→ 玩家看到方块出现在 (16,..) 而实际存在 (0,..) 的偏移位置。
  const json = JSON.stringify({
    format: PROGRESS_FORMAT, version: PROGRESS_VERSION, seed: 5, spawn: [1, 1],
    columns: [{ key: '0,0', cells: [{ x: 20, y: 1, z: 3, type: 'stone', meta: 0 }] }],
    entities: [],
  });
  const decoded = decodeProgress(json, REGISTRY);
  assertTrue(decoded.ok);
  assertEqual(decoded.invalid, 1);
  assertEqual(decoded.edits.length, 0);
});

// ---------- 包格式校验：失败时零输出 ----------

test('进度包：非法 JSON / 错误 format / 高 version / 坏 seed 各有 reason 且零输出', () => {
  const cases = [
    ['not json', 'invalid-json'],
    [JSON.stringify({ nope: 1 }), 'invalid-format'],
    [JSON.stringify({ format: 'other-game', version: 1, seed: 1 }), 'invalid-format'],
    [JSON.stringify({ format: PROGRESS_FORMAT, version: PROGRESS_VERSION + 1, seed: 1 }), 'unsupported-version'],
    [JSON.stringify({ format: PROGRESS_FORMAT, version: PROGRESS_VERSION, seed: 'abc' }), 'invalid-seed'],
    [JSON.stringify({ format: PROGRESS_FORMAT, version: PROGRESS_VERSION, seed: Number.NaN }), 'invalid-seed'],
    [JSON.stringify({ format: PROGRESS_FORMAT, version: PROGRESS_VERSION, seed: -5 }), 'invalid-seed'],
    [JSON.stringify({ format: PROGRESS_FORMAT, version: PROGRESS_VERSION }), 'invalid-seed'],
  ];
  for (const [text, reason] of cases) {
    const r = decodeProgress(text, REGISTRY);
    assertEqual(r.ok, false, `${reason}：应失败`);
    assertEqual(r.reason, reason, `输入 ${text.slice(0, 48)}`);
    assertEqual(r.edits, undefined, '失败时不得给出半成品 edits');
    assertEqual(r.entities, undefined, '失败时不得给出半成品 entities');
  }
});

test('进度包：columns/entities 缺失或非数组按空处理（不报错，等价于只有 seed 的包）', () => {
  const json = JSON.stringify({
    format: PROGRESS_FORMAT, version: PROGRESS_VERSION, seed: 42, spawn: [3, 4],
  });
  const r = decodeProgress(json, REGISTRY);
  assertTrue(r.ok, `仅含 seed 的包应可用，实际 ${r.reason}`);
  assertEqual(r.seed, 42);
  assertDeepEqual(r.spawn, [3, 4]);
  assertEqual(r.edits.length, 0);
  assertEqual(r.entities.length, 0);
});

test('进度包：spawn 非法时回落 null（不是 NaN 数组，调用方据此保留既有 meta）', () => {
  const json = JSON.stringify({
    format: PROGRESS_FORMAT, version: PROGRESS_VERSION, seed: 42, spawn: ['a', 'b'],
  });
  const r = decodeProgress(json, REGISTRY);
  assertTrue(r.ok);
  assertEqual(r.spawn, null);
});

test('进度包：negative / 0 seed 与真实 seed 一样被接受（0 除外）', () => {
  // randomSeed() 产 1..0xFFFFFF，但导入的包必须能读回**任何**合法整数 seed（含大值），
  // 否则「导出 → 导入」在极端 seed 上往返失败。
  for (const seed of [1, 12345, 0xFFFFFF]) {
    const r = decodeProgress(JSON.stringify({
      format: PROGRESS_FORMAT, version: PROGRESS_VERSION, seed, spawn: null,
    }), REGISTRY);
    assertTrue(r.ok, `seed=${seed} 应可读`);
    assertEqual(r.seed, seed);
  }
});

// ---------- 空世界往返 ----------

test('进度包：空世界往返（零 column / 零实体）不产出空行', () => {
  const json = encodeProgress({ seed: 9, spawn: [8, 8], columns: [], entities: [] }, REGISTRY);
  const r = decodeProgress(json, REGISTRY);
  assertTrue(r.ok);
  assertEqual(r.edits.length, 0);
  assertEqual(r.entities.length, 0);
  assertEqual(r.invalid, 0);
  assertStringIncludes(json, '"columns"');
});
