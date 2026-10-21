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

// ---------------------------------------------------------------------------
// 2026-10-21 第二次修「灯光有边界」/「删灯后被照亮的面不变暗」：写回后的脏 section 传播
//
// 根因（用户实玩 + 真游戏页数据/网格对照实测）：light **数据**写回是对的（对照整图参考 BFS 0 个格子不一致），
// 但 mesh 是旧的 —— `_onLightResult` 只给「light 字节真变了」的**同 sy** section 置脏。
// 而 mesher 的 faceLight 读的是面外邻格：地表恰好在 section 最上层（y=15、y=-1 …）时，顶面读的是
// 上一个 section 最底层那格 → 那格 light 变了，地面所在的 section 没人通知重 mesh（放灯后不亮 / 删灯后不暗）。
// 这里用「y=15 的整片石头地面 + 地面上方的灯」把这个几何固定下来，断言走真实的 `_onLightResult`。
// ---------------------------------------------------------------------------

/** 3×3 全就绪世界 + y=15 整片石头地面（section sy=2 的最上层）。返回 {world, reg, floorSy, lampAt} */
function buildFloorWorld(reg) {
  const world = buildGrid3World(reg);
  const stone = reg.idOf('stone');
  for (const [, col] of world.columns) {
    for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) col.blocks[blockIndex(lx, 15, lz)] = stone;
  }
  return { world, floorSy: 2 };
}
const dirtyOf = (col) => [...col.dirtySections].map((v, sy) => (v ? sy : -1)).filter((sy) => sy >= 0).join(',');
function clearDirty(world) { for (const [, col] of world.columns) col.takeDirty(); }

test('light 写回：地表在 section 最上层时，放灯必须把**地面所在的下方 section** 置脏（沙滩不亮根因）', () => {
  const reg = makeRegistry();
  const { world, floorSy } = buildFloorWorld(reg);
  const scheduler = makeScheduler(world, reg);
  clearDirty(world);
  // 灯在地面上方 2 格（y=17 → sy=3）。光只能出现在 y>=16（地面是 opaque），即 sy=3 的下半段 + 更上层
  world.getColumn(0, 0).blocks[blockIndex(8, 17, 8)] = reg.idOf('glowstone');
  scheduler._onLightResult('0,0', runLightTask(world, 0, 0, reg));
  const center = world.getColumn(0, 0);
  const dirty = dirtyOf(center).split(',').map(Number);
  assertTrue(dirty.includes(3), `灯所在的 sy=3 必须置脏（实际 ${dirty}）`);
  assertTrue(dirty.includes(floorSy),
    `y=15 的地面在 sy=${floorSy}，它的顶面读 y=16（sy=3 最底层）的 light ——必须置脏（实际 ${dirty}）`);
  for (const sy of [0, 1, 5, 6, 7]) assertTrue(!dirty.includes(sy), `与光无关的 sy=${sy} 不得置脏（实际 ${dirty}）`);
});

test('light 写回：删灯后同样要把地面所在的 section 置脏（被照亮的面必须变暗）', () => {
  const reg = makeRegistry();
  const { world, floorSy } = buildFloorWorld(reg);
  const scheduler = makeScheduler(world, reg);
  const center = world.getColumn(0, 0);
  center.blocks[blockIndex(8, 17, 8)] = reg.idOf('glowstone');
  scheduler._onLightResult('0,0', runLightTask(world, 0, 0, reg)); // 先点亮并写回
  assertTrue((center.light[blockIndex(8, 16, 8)] & 15) > 0, '前置：灯下方一格已被点亮');
  clearDirty(world);
  center.blocks[blockIndex(8, 17, 8)] = 0; // 删灯
  scheduler._onLightResult('0,0', runLightTask(world, 0, 0, reg));
  assertEqual(center.light[blockIndex(8, 16, 8)] & 15, 0, '数据层：删灯后 light 归零');
  const dirty = dirtyOf(center).split(',').map(Number);
  assertTrue(dirty.includes(floorSy), `删灯后地面所在 sy=${floorSy} 必须重 mesh 才会变暗（实际 ${dirty}）`);
});

test('light 写回：邻列只在**边界层**变化时置脏，且只有 4 个正交邻列（对角列不读本列 light）', () => {
  const reg = makeRegistry();
  const { world } = buildFloorWorld(reg);
  const scheduler = makeScheduler(world, reg);
  clearDirty(world);
  // 灯在中心列正中 (8,17,8)：四个方向的光都会越过边界层（lx/lz ∈ {0,15}），角落格 (15,17,15) 距灯 14 → 亮度 1
  world.getColumn(0, 0).blocks[blockIndex(8, 17, 8)] = reg.idOf('glowstone');
  scheduler._onLightResult('0,0', runLightTask(world, 0, 0, reg));
  for (const [cx, cz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    assertTrue(dirtyOf(world.getColumn(cx, cz)).split(',').map(Number).includes(3),
      `正交邻列 (${cx},${cz}) 的 sy=3 必须置脏（它的边界面读中心列的 light）`);
  }
  for (const [cx, cz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    assertEqual(dirtyOf(world.getColumn(cx, cz)), '', `对角列 (${cx},${cz}) 不读中心列的 light，不得置脏`);
  }
});

test('light 写回：中心列内部变化（未触及边界层）不得波及任何邻列', () => {
  const reg = makeRegistry();
  const world = buildGrid3World(reg);
  const scheduler = makeScheduler(world, reg);
  clearDirty(world);
  // 用一个被石头围死的小空腔（只有 3×3×3 的空气）装灯：光出不了腔，也到不了任何边界层
  const stone = reg.idOf('stone');
  const center = world.getColumn(0, 0);
  for (let x = 6; x <= 10; x++) for (let y = 38; y <= 42; y++) for (let z = 6; z <= 10; z++) {
    center.blocks[blockIndex(x, y, z)] = stone;
  }
  for (let x = 7; x <= 9; x++) for (let y = 39; y <= 41; y++) for (let z = 7; z <= 9; z++) {
    center.blocks[blockIndex(x, y, z)] = 0;
  }
  center.blocks[blockIndex(8, 40, 8)] = reg.idOf('glowstone');
  scheduler._onLightResult('0,0', runLightTask(world, 0, 0, reg));
  assertTrue(dirtyOf(center) !== '', '中心列自己必须置脏（腔内 light 变了）');
  for (const [cx, cz] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    assertEqual(dirtyOf(world.getColumn(cx, cz)), '', `邻列 (${cx},${cz}) 与这次 light 变化无关，不得置脏`);
  }
});

// ---------------------------------------------------------------------------
// 2026-10-21 第二次修的第二半：**在途 mesh 回包因版本过期被丢弃时，必须把该 section 重新置脏**
//
// 现象（真游戏页确定性构造，3/3 复现）：放灯 → light 写回把地面 section 置脏 → 该 section 的 mesh 任务
// 在途期间，同一 column 的**任何**编辑（哪怕与光无关）都会 `version++` → `_onMeshResult` 版本不符把结果丢掉。
// 可是这个 section 的脏标记在派发前就被 `takeDirty` 消费了，没有任何东西会再次要求它重 mesh ——
// light 数据是对的，这一块地面却永久停在旧亮度（「偶现的一片地面不亮 / 删灯后不变暗」）。
// 版本协议（红线 7）说的是「回传版本不符即丢弃**结果**」，并不是放弃这份工作 —— 与 `_onLightResult`
// 的「丢弃并重新入队」同一语义。注意这不是 epoch/防抖补丁：重发只在被丢弃时发生，且只重发被丢的 section。
// ---------------------------------------------------------------------------

function emptyGeom() {
  return {
    positions: new Float32Array(0).buffer, uvs: new Float32Array(0).buffer,
    packed: new Uint32Array(0).buffer, indices: new Uint32Array(0).buffer,
    vertexCount: 0, indexCount: 0,
  };
}
function meshResult(cx, sy, cz, version) {
  return { cx, sy, cz, version, channels: { opaque: emptyGeom(), cutout: emptyGeom(), transparent: emptyGeom() }, stats: null };
}

test('mesh 回包：版本过期被丢弃 → 该 section 重新置脏（否则旧网格永久残留）', () => {
  const reg = makeRegistry();
  const world = buildGrid3World(reg);
  const scheduler = makeScheduler(world, reg);
  const col = world.getColumn(0, 0);
  clearDirty(world);
  col.version = 7; // 任务派发时是 6，在途期间同 column 被编辑
  scheduler._onMeshResult('0,2,0', meshResult(0, 2, 0, 6));
  assertEqual(scheduler._uploadQueue.length, 0, '过期结果不得进上传队列');
  assertEqual(dirtyOf(col), '2', '被丢弃的 section 必须重新置脏，等下一帧 takeDirty 重新派发');
  assertEqual(dirtyOf(world.getColumn(1, 0)), '', '不相关的邻列不受影响');
});

test('mesh 回包：版本一致 → 进上传队列，不置脏（重发只针对被丢弃的结果，不制造多余 mesh）', () => {
  const reg = makeRegistry();
  const world = buildGrid3World(reg);
  const scheduler = makeScheduler(world, reg);
  const col = world.getColumn(0, 0);
  clearDirty(world);
  col.version = 7;
  scheduler._onMeshResult('0,2,0', meshResult(0, 2, 0, 7));
  assertEqual(scheduler._uploadQueue.length, 1, '有效结果进上传队列');
  assertEqual(dirtyOf(col), '', '有效结果不得再置脏');
});

test('mesh 上传：排队等预算期间版本变了 → 丢弃并重新置脏（第二个丢弃点同样要重发）', () => {
  const reg = makeRegistry();
  const world = buildGrid3World(reg);
  const scheduler = makeScheduler(world, reg);
  const uploads = [];
  scheduler.renderWorld = { uploadSection: (...args) => uploads.push(args) };
  const col = world.getColumn(0, 0);
  col.version = 6;
  clearDirty(world);
  scheduler._onMeshResult('0,2,0', meshResult(0, 2, 0, 6)); // 入队时版本一致
  col.version = 7; // 排队期间被编辑
  scheduler._processUploadQueue();
  assertEqual(uploads.length, 0, '过期结果不得上传到 GPU');
  assertEqual(dirtyOf(col), '2', '上传前才发现过期 → 同样重新置脏');
});

test('mesh 回包：column 已卸载 → 静默丢弃（不抛错、不复活 column）', () => {
  const reg = makeRegistry();
  const world = buildGrid3World(reg);
  const scheduler = makeScheduler(world, reg);
  world.remove('0,0');
  scheduler._onMeshResult('0,2,0', meshResult(0, 2, 0, 1));
  assertEqual(scheduler._uploadQueue.length, 0);
  assertTrue(!world.getColumn(0, 0), '不得因为置脏而复活已卸载的 column');
});

// ---------------------------------------------------------------------------
// 回包校验的第三层：**输入集合**也要一致（不只是输入列的版本）
//
// 缺口：`enqueueLight` 对「在途」的 column 直接跳过（理由是「回包后由版本校验再触发」），而版本校验只比对
// **派发时已有的输入列**。若 task 在途期间它 3×3 里**新到达**了一个就绪的列（可能带灯），这一列不在
// `inputs` 里 → 版本校验看不见 → 回包被照单接收，而新列的 `enqueueLight` 又因「在途」跳过了它 →
// 这个 column 永远缺一盏灯的光（表现 = column 边界处的光截断）。
// 这与版本不符是同一类问题（task 手里的输入已不是当前输入），应走同一条「丢弃并重新入队」路径。
// ---------------------------------------------------------------------------
test('light 回包：在途期间 3×3 里新到达了一个就绪列 → 丢弃并重新入队（输入集合变了）', async () => {
  const reg = makeRegistry();
  const world = buildGrid3World(reg);
  world.remove('1,0'); // 东邻列「还没到达」
  const { pool, calls } = makeCapturingPool();
  // viewDistance=0：`neighborsReady` 门控只要求玩家所在列就绪 —— 与「邻列在视距外、尚未加载」同语义
  const scheduler = new Scheduler({ world, pool, registry: reg, seed: 1, viewDistance: 0 });
  scheduler._lightQueue.add('0,0');
  scheduler._processLightQueue();
  assertEqual(calls.length, 1, '中心列 task 已下发');
  assertTrue(!calls[0].payload.columns.some((c) => c.cx === 1 && c.cz === 0), '前置：下发时输入里没有东邻列 (1,0)');

  // 在途期间东邻列到达，且里面有一盏灯（紧贴与中心列的交界）。它的 GEN 收尾会 enqueueLight(1,0)，
  // 但中心列「在途」→ 被跳过（这正是缺口）。
  const east = new ChunkColumn(1, 0);
  east.blocks[blockIndex(0, 50, 8)] = reg.idOf('glowstone');
  east.state = 'ready';
  world.add(east);
  genLight(world, 1, 0, reg);
  scheduler.enqueueLight(1, 0);

  // 中心列的回包：用**旧输入**（不含东邻列）算出的 light —— 缺东邻列那盏灯的光
  const req = calls[0];
  req.resolve({
    cx: 0, cz: 0, light: new Uint8Array(32768).buffer,
    version: req.payload.columns.find((c) => c.cx === 0).version,
    inputs: req.payload.columns.map((c) => ({ cx: c.cx, cz: c.cz, version: c.version })),
  });
  await new Promise((r) => setTimeout(r, 0));
  assertTrue([...scheduler._lightQueue].includes('0,0'),
    `回包的输入集合已过期（少了新到达的东邻列）→ 必须重新入队（实际队列 ${[...scheduler._lightQueue].join('|')}）`);
});

test('light 回包：输入集合一致（3×3 没有新到达的列）→ 照常写回，不多余重算', async () => {
  const reg = makeRegistry();
  const world = buildGrid3World(reg);
  const { pool, calls } = makeCapturingPool();
  const scheduler = new Scheduler({ world, pool, registry: reg, seed: 1, viewDistance: 8 });
  world.getColumn(0, 0).blocks[blockIndex(8, 50, 8)] = reg.idOf('glowstone');
  scheduler._lightQueue.add('0,0');
  scheduler._processLightQueue();
  const req = calls[0];
  const center = new Uint8Array(32768);
  center[blockIndex(8, 50, 8)] = 15;
  req.resolve({
    cx: 0, cz: 0, light: center.buffer,
    version: req.payload.columns.find((c) => c.cx === 0).version,
    inputs: req.payload.columns.map((c) => ({ cx: c.cx, cz: c.cz, version: c.version })),
  });
  await new Promise((r) => setTimeout(r, 0));
  assertEqual(world.getColumn(0, 0).light[blockIndex(8, 50, 8)] & 15, 15, '一致的回包必须写回');
  assertTrue(![...scheduler._lightQueue].includes('0,0'), '一致的回包不得再次入队');
});
