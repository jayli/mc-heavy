// src/tests/test-world-editor.js — M4-0：WorldEditor 批量世界编辑与事件协调器
// 覆盖设计文档 §4.5.3 / M4 规格 §4.1：
//   单块 fast path、批量「最后写入获胜」去重、基岩目标过滤、越界过滤、
//   每 column 只 bump 一次版本、逐格 edits 记录、affected section 合并、
//   block-changed 事件只携带同一份增量。
import { test } from './runner.js';
import { assertDeepEqual, assertEqual, assertTrue } from './assert.js';
import { WorldEditor } from '../core/world-editor.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';

function makeReadyWorldWithTwoColumns() {
  const registry = createRegistry();
  for (const def of BLOCKS) registry.register(def.name, def);
  registry.freeze();
  const world = new WorldData(registry);
  for (const cx of [0, 1]) {
    const column = new ChunkColumn(cx, 0);
    column.state = 'ready';
    world.add(column);
  }
  return { world, registry };
}

test('WorldEditor.setBlocks: 同 column 只 bump 一次，逐格记录 edits 并合并重建', () => {
  const { world, registry } = makeReadyWorldWithTwoColumns();
  const calls = [];
  const editor = new WorldEditor({ world, scheduler: {
    remeshSections: (affected, opts) => calls.push({ affected, opts }),
    enqueueLight: (cx, cz) => calls.push({ light: [cx, cz] }),
  } });
  const stone = registry.idOf('stone');
  const column = world.getColumn(0, 0);
  world.setBlock(1, 0, 1, registry.idOf('dirt'));
  const beforeVersion = column.version;
  const events = [];
  editor.subscribe((event) => events.push(event));

  const report = editor.setBlocks([
    { x: 1, y: 0, z: 1, id: stone },
    { x: 1, y: 0, z: 1, id: 0 },
    { x: 15, y: 0, z: 1, id: stone },
  ]);

  assertEqual(column.version, beforeVersion + 1);
  assertEqual(world.getBlockId(1, 0, 1), 0);
  assertEqual(world.getBlockId(15, 0, 1), stone);
  assertEqual(column.edits.size, 2);
  assertEqual(report.changes.length, 2);
  assertEqual(events.length, 1);
  assertEqual(calls.filter((x) => x.opts?.fastPath === false).length, 1);
  assertTrue(report.affected.some((s) => s.cx === 1 && s.cz === 0));
});

test('WorldEditor.setBlocks: 基岩目标和越界不变，单块保持 fast path', () => {
  const { world, registry } = makeReadyWorldWithTwoColumns();
  const calls = [];
  const editor = new WorldEditor({ world, scheduler: {
    remeshSections: (affected, opts) => calls.push({ affected, opts }),
    enqueueLight: () => {},
  } });
  const bedrock = registry.idOf('bedrock');
  world.setBlock(2, 0, 2, bedrock);
  const report = editor.setBlocks([
    { x: 2, y: 0, z: 2, id: 0 },
    { x: 1, y: 96, z: 1, id: registry.idOf('stone') },
  ]);
  assertEqual(world.getBlockId(2, 0, 2), bedrock);
  assertDeepEqual(report.skipped.map((x) => x.reason), ['bedrock', 'out-of-bounds']);
  editor.setBlock({ x: 1, y: 1, z: 1, id: registry.idOf('stone') });
  assertEqual(calls.at(-1).opts.fastPath, true);
});
