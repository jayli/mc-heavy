// src/tests/test-light-writeback.js — light 任务写回协议回归（v1.8 中心 column 权威）
// 根因回归：旧「写回全部 5 列 last-write-wins」下，region 不完整的后到 task 会清零并
// 覆盖邻列已收敛的好光（房屋内萤石/窗户光丢失 → 偶现全黑面 + 截断渐变环）。
// 断言：无论 task 到达顺序如何，每列 light 收敛到以它为中心的 region 计算结果。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { Scheduler } from '../core/scheduler.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';
import { computeSkylightColumn, computeSkylightRegion, computeBlocklightRegion } from '../mesh/lighting.js';
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

/** 仿 worker light handler：region 重算，返回 scheduler._onLightResult 协议形状 */
function runLightTask(world, cx, cz, reg) {
  const w2 = new WorldData(reg);
  const cols = [];
  for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const c = world.getColumn(cx + dx, cz + dz);
    if (!c) continue;
    const copy = new ChunkColumn(c.cx, c.cz);
    copy.blocks = new Uint16Array(c.blocks);
    copy.light = new Uint8Array(c.light);
    copy.version = c.version;
    w2.add(copy);
    cols.push(copy);
  }
  computeSkylightRegion(w2, cx, cz, reg);
  computeBlocklightRegion(w2, cx, cz, reg);
  return {
    cx, cz,
    results: cols.map((c) => ({ cx: c.cx, cz: c.cz, version: c.version, light: c.light.slice().buffer })),
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
});
