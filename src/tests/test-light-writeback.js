// src/tests/test-light-writeback.js — light 任务写回协议回归（v1.8 中心 column 权威）
// 根因回归：旧「写回全部 5 列 last-write-wins」下，region 不完整的后到 task 会清零并
// 覆盖邻列已收敛的好光（房屋内萤石/窗户光丢失 → 偶现全黑面 + 截断渐变环）。
// 断言：无论 task 到达顺序如何，每列 light 收敛到以它为中心的 region 计算结果。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { Scheduler } from '../core/scheduler.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';
import { computeSkylightColumn, computeSkylightRegion, computeBlocklightRegion, LIGHT_REGION_OFFSETS } from '../mesh/lighting.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { blockIndex } from '../voxel/constants.js';

function makeRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}

/** 仿 GEN 初始光照：垂直 skylight + 单 column 截断 blocklight（world-worker gen 同口径） */
function genLight(world, cx, cz, reg) {
  const col = world.getColumn(cx, cz);
  computeSkylightColumn(col, reg);
  const w = new WorldData(reg);
  w.add(col);
  computeBlocklightRegion(w, cx, cz, reg);
}

/** 仿 worker light handler：3×3 region 重算，返回 scheduler._onLightResult 协议形状
 *  （2026-10-21 改：只回中心列 light + 各输入列 version，见 world-worker.js 的 light()） */
function runLightTask(world, cx, cz, reg) {
  const w2 = new WorldData(reg);
  let center = null;
  const inputs = [];
  for (const [dx, dz] of LIGHT_REGION_OFFSETS) {
    const c = world.getColumn(cx + dx, cz + dz);
    if (!c) continue;
    const copy = new ChunkColumn(c.cx, c.cz);
    copy.blocks = new Uint16Array(c.blocks);
    copy.light = new Uint8Array(c.light);
    copy.version = c.version;
    w2.add(copy);
    inputs.push({ cx: copy.cx, cz: copy.cz, version: copy.version });
    if (copy.cx === cx && copy.cz === cz) center = copy;
  }
  computeSkylightRegion(w2, cx, cz, reg);
  computeBlocklightRegion(w2, cx, cz, reg);
  return {
    cx, cz,
    light: center ? center.light.slice().buffer : null,
    version: center ? center.version : undefined,
    inputs,
  };
}

/** 房屋世界：A/B/C/D 四列；房跨 B/C（x16..47），东窗在 C 东墙，glowstone 在 C 近 B/C 边界 */
function buildHouseWorld(reg) {
  const world = new WorldData(reg);
  for (const [cx, cz] of [[0, 0], [1, 0], [2, 0], [3, 0]]) {
    world.add(new ChunkColumn(cx, cz));
  }
  const stone = reg.idOf('stone'), glass = reg.idOf('glass_block'), glow = reg.idOf('glowstone');
  const set = (x, y, z, id) => {
    const col = world.getColumn(Math.floor(x / 16), 0);
    col.blocks[blockIndex(x - Math.floor(x / 16) * 16, y, z)] = id;
  };
  for (let x = 16; x < 48; x++) for (let z = 0; z < 16; z++) {
    set(x, 63, z, stone);
    if (x === 16 || x === 47) for (let y = 64; y <= 70; y++) set(x, y, z, stone);
    if (z === 0 || z === 15) for (let y = 64; y <= 70; y++) set(x, y, z, stone);
    set(x, 70, z, stone);
  }
  for (let y = 66; y <= 68; y++) for (let z = 6; z <= 9; z++) set(47, y, z, glass);
  set(36, 65, 8, glow);
  for (const [cx, cz] of [[0, 0], [1, 0], [2, 0], [3, 0]]) {
    const col = world.getColumn(cx, cz);
    col.state = 'ready';
    genLight(world, cx, cz, reg);
  }
  return world;
}

function makeScheduler(world, reg) {
  const pool = { call: () => { throw new Error('stub: 不应触达'); }, cancel() {}, broadcast() {} };
  return new Scheduler({ world, pool, registry: reg, seed: 1 });
}

function probe(world) {
  const b = world.getColumn(1, 0);
  const c = world.getColumn(2, 0);
  return {
    bBl: b.light[blockIndex(14, 65, 8)] & 15,   // 世界 (30,65,8)，距 glowstone 6 格
    cBl: c.light[blockIndex(8, 65, 8)] & 15,    // 世界 (40,65,8)，距 glowstone 4 格
    cSky: c.light[blockIndex(8, 65, 8)] >> 4,   // 东窗渗光
  };
}

test('light 写回：中心 column 权威，邻列 task 不覆盖好光（全黑根因回归）', () => {
  const reg = makeRegistry();
  const world = buildHouseWorld(reg);
  const scheduler = makeScheduler(world, reg);
  // GEN 初始：B 列无 emissive，单 column blocklight 截断 → glowstone 光过不了界
  assertEqual(probe(world).bBl, 0, 'GEN 单 column blocklight 截断（前置事实）');
  // 坏顺序：B → C → A（A 的 region 不含 glowstone 所在 C 列；旧实现会把 B 覆盖回 0）
  scheduler._onLightResult('1,0', runLightTask(world, 1, 0, reg));
  scheduler._onLightResult('2,0', runLightTask(world, 2, 0, reg));
  scheduler._onLightResult('0,0', runLightTask(world, 0, 0, reg));
  const p = probe(world);
  assertTrue(p.bBl >= 5, `B 列 glowstone 光不得被邻列 task 覆盖（实际 ${p.bBl}，期望 ≥5）`);
  assertTrue(p.cBl >= 5, `C 列 blocklight 收敛（实际 ${p.cBl}）`);
  assertEqual(p.cSky, 15, '第一阶段无阳光投影：skylight 恒 15');
});

test('light 写回：收敛结果与 task 到达顺序无关（偶现性根因回归）', () => {
  const reg = makeRegistry();
  const orders = [[[1, 0], [2, 0], [0, 0]], [[0, 0], [2, 0], [1, 0]], [[2, 0], [0, 0], [1, 0]]];
  const snapshots = orders.map((order) => {
    const world = buildHouseWorld(reg);
    const scheduler = makeScheduler(world, reg);
    for (const [cx, cz] of order) scheduler._onLightResult(`${cx},${cz}`, runLightTask(world, cx, cz, reg));
    return probe(world);
  });
  for (let i = 1; i < snapshots.length; i++) {
    assertEqual(snapshots[i].bBl, snapshots[0].bBl, `顺序${i} 与顺序0 的 B 列 blocklight 一致`);
    assertEqual(snapshots[i].cBl, snapshots[0].cBl, `顺序${i} 与顺序0 的 C 列 blocklight 一致`);
    assertEqual(snapshots[i].cSky, snapshots[0].cSky, `顺序${i} 与顺序0 的 C 列 skylight 一致`);
  }
  assertTrue(snapshots[0].bBl >= 5, '所有顺序下 B 列均收敛');
});// ---------------------------------------------------------------------------
// 2026-10-21 新增（「灯光有边界」修复的协议侧）：入队范围 + region 输入版本校验 + 精确脏 section
//
// 为什么必须走 `_processLightQueue` 真实下发路径、而不是直接调 `_onLightResult`：
// inputs 快照是在**下发时**记录的。在测试里手工构造回包就等于自己伪造了快照，
// 「校验是否真的生效」会被测试自己的假设兜住（负向验证盲区，testing-policy §2.7）。
// ---------------------------------------------------------------------------

/** 假 WorkerPool：`light` 立即返回可控 promise，并**记录请求**，由测试决定何时投递回包。
 *  ⚠️ 形状必须与真实 WorkerPool 一致：`{id, promise}`（M6 踩坑：裸 promise 会让
 *  `typeof result.then === 'function'` 判错，回包静默丢失）。 */
function makeCapturingPool() {
  const calls = [];
  return {
    calls,
    pool: {
      call(method, payload) {
        let resolve;
        const promise = new Promise((r) => { resolve = r; });
        calls.push({ method, payload, resolve });
        return { id: calls.length, promise };
      },
      cancel() {},
      broadcast() {},
    },
  };
}

/** 3×3 全就绪的空世界（`_processLightQueue` 的 halo 前置要求 3×3 邻居齐全） */
function buildGrid3World(reg) {
  const world = new WorldData(reg);
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) {
    const col = new ChunkColumn(cx, cz);
    col.state = 'ready';
    world.add(col);
    genLight(world, cx, cz, reg);
  }
  for (const [, col] of world.columns) col.takeDirty();
  return world;
}

test('light 下发：enqueueLight 覆盖 3×3（不是只有编辑所在列）', () => {
  const reg = makeRegistry();
  const world = buildGrid3World(reg);
  const { pool } = makeCapturingPool();
  const scheduler = new Scheduler({ world, pool, registry: reg, seed: 1, viewDistance: 8 });
  scheduler.enqueueLight(0, 0);
  const queued = [...scheduler._lightQueue].sort();
  for (const k of ['-1,-1', '-1,0', '-1,1', '0,-1', '0,0', '0,1', '1,-1', '1,0', '1,1']) {
    assertTrue(queued.includes(k), `3×3 内的 ${k} 必须入队（实际 ${queued.join('|')}）`);
  }
});

test('light 下发：**邻列**在途期间变了 → 回包丢弃（中心列版本校验抓不到这一层）', async () => {
  const reg = makeRegistry();
  const world = buildGrid3World(reg);
  const { pool, calls } = makeCapturingPool();
  const scheduler = new Scheduler({ world, pool, registry: reg, seed: 1, viewDistance: 8 });
  scheduler._lightQueue.add('0,0');
  scheduler._processLightQueue();
  const req = calls[0];
  assertEqual(req.payload.cx, 0, 'request targets center column');
  // ⚠️ 只改**邻列**：中心列的 version 一动不动 —— 所以中心列版本校验（层 ①）**抓不到**，
  // 只有「region 全部输入列版本」（层 ②）能拦住。这正是「灯光有边界」的协议侧根因：
  // 灯放在邻列，邻列 version 变了，而中心列 task 手里那份邻列 blocks 是旧的。
  const neighbor = world.getColumn(1, 0);
  neighbor.blocks[blockIndex(0, 65, 8)] = reg.idOf('glowstone');
  neighbor.version++;
  const center = world.getColumn(0, 0);
  const before = center.light[blockIndex(8, 65, 8)];
  // 投递「用旧 blocks 算出」的回包（light 全 0 —— 一旦被写回，中心列会被压成黑）
  const stale = new Uint8Array(32768);
  req.resolve({
    cx: 0, cz: 0, light: stale.buffer,
    version: req.payload.columns.find((c) => c.cx === 0).version, // 中心列版本仍然对得上
    inputs: req.payload.columns.map((c) => ({ cx: c.cx, cz: c.cz, version: c.version })),
  });
  await new Promise((r) => setTimeout(r, 0));
  assertEqual(world.getColumn(0, 0).light[blockIndex(8, 65, 8)], before, 'stale light must NOT be written back');
  const queued = [...scheduler._lightQueue];
  assertTrue(queued.includes('0,0'), `stale result must re-enqueue（实际队列 ${queued.join('|')}）`);
});

test('light 写回：只把真正变了的 section 置脏（不是 8 个全脏）', () => {
  const reg = makeRegistry();
  const world = buildHouseWorld(reg);
  const scheduler = makeScheduler(world, reg);
  // 先收敛一次
  scheduler._onLightResult('2,0', runLightTask(world, 2, 0, reg));
  for (const [, col] of world.columns) col.takeDirty();
  // 同一份世界再算一次 → light 完全不变 → 不得产生任何脏 section
  scheduler._onLightResult('2,0', runLightTask(world, 2, 0, reg));
  const totalDirty = [...world.columns.values()].reduce((n, col) => n + col.takeDirty().length, 0);
  assertEqual(totalDirty, 0, 'identical light result must not dirty any section');
});
