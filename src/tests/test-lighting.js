import { test } from './runner.js';
import { assertEqual } from './assert.js';
import { computeSkylightColumn, computeSkylightRegion, computeBlocklightRegion, recomputeLight } from '../mesh/lighting.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';
import { WORLD_MIN_Y, WORLD_MAX_Y, blockIndex } from '../voxel/constants.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';

function makeRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}
const sky = (col, lx, y, lz) => col.light[blockIndex(lx, y, lz)] >> 4;
const blk = (col, lx, y, lz) => col.light[blockIndex(lx, y, lz)] & 0xF;

test('skylight: 露天列全程 15', () => {
  const reg = makeRegistry();
  const col = new ChunkColumn(0, 0);
  computeSkylightColumn(col, reg);
  assertEqual(sky(col, 8, 90, 8), 15);
  assertEqual(sky(col, 8, WORLD_MIN_Y + 1, 8), 15);
});

test('skylight: 第一阶段无阳光投影（opaque 下方仍 15，v1.9）', () => {
  const reg = makeRegistry();
  const col = new ChunkColumn(0, 0);
  const stoneId = reg.idOf('stone');
  col.blocks[blockIndex(8, 50, 8)] = stoneId;
  computeSkylightColumn(col, reg);
  assertEqual(sky(col, 8, 51, 8), 15);
  assertEqual(sky(col, 8, 49, 8), 15, 'below opaque is full bright (no sun shadow)');
  assertEqual(sky(col, 8, 20, 8), 15);
});

test('skylight: 透明方块不遮挡（玻璃下方仍 15）', () => {
  const reg = makeRegistry();
  const col = new ChunkColumn(0, 0);
  col.blocks[blockIndex(8, 50, 8)] = reg.idOf('glass_block');
  computeSkylightColumn(col, reg);
  assertEqual(sky(col, 8, 49, 8), 15);
});

test('blocklight: 光源 flood fill 衰减', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  world.add(col);
  col.blocks[blockIndex(8, 50, 8)] = reg.idOf('glowstone'); // emissive 15
  computeBlocklightRegion(world, 0, 0, reg);
  assertEqual(blk(col, 8, 50, 8), 15);
  assertEqual(blk(col, 8, 51, 8), 14);
  assertEqual(blk(col, 9, 50, 8), 14);
  assertEqual(blk(col, 8, 55, 8), 10);
  assertEqual(blk(col, 8, 66, 8), 0, 'beyond radius 15 is dark');
});

test('blocklight: opaque 阻挡传播', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  world.add(col);
  col.blocks[blockIndex(8, 50, 8)] = reg.idOf('glowstone');
  // 在光源上方盖一层石头
  for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
    col.blocks[blockIndex(lx, 52, lz)] = reg.idOf('stone');
  }
  computeBlocklightRegion(world, 0, 0, reg);
  assertEqual(blk(col, 8, 51, 8), 14, 'below lid still lit');
  assertEqual(blk(col, 8, 53, 8), 0, 'above lid dark');
});

test('blocklight: 跨 column 泄漏', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const a = new ChunkColumn(0, 0), b = new ChunkColumn(1, 0);
  world.add(a); world.add(b);
  a.blocks[blockIndex(15, 50, 8)] = reg.idOf('glowstone'); // 贴 +X 边
  computeBlocklightRegion(world, 0, 0, reg);
  assertEqual(blk(b, 0, 50, 8), 14, 'light leaks into neighbor column');
});

test('recomputeLight: 挖掉光源后降光（全 column 重算兜底，§4.6）', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  world.add(col);
  col.blocks[blockIndex(8, 50, 8)] = reg.idOf('glowstone');
  recomputeLight(world, 0, 0, reg);
  assertEqual(blk(col, 8, 51, 8), 14);
  col.blocks[blockIndex(8, 50, 8)] = 0; // 挖掉
  recomputeLight(world, 0, 0, reg);
  assertEqual(blk(col, 8, 51, 8), 0, 'light removed after recompute');
});

test('recomputeLight: 第一阶段无阳光投影（地下方恒 15，挖块前后不变，v1.9）', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  world.add(col);
  // 铺一层石头地面 y=50：第一阶段不产生阳光阴影，下方仍全亮
  for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
    col.blocks[blockIndex(lx, 50, lz)] = reg.idOf('stone');
  }
  recomputeLight(world, 0, 0, reg);
  assertEqual(sky(col, 8, 49, 8), 15, 'below ground is full bright (no sun shadow)');
  col.blocks[blockIndex(8, 50, 8)] = 0;
  recomputeLight(world, 0, 0, reg);
  assertEqual(sky(col, 8, 50, 8), 15, 'dug cell lit');
  assertEqual(sky(col, 8, 49, 8), 15, 'below dug cell lit');
  assertEqual(sky(col, 9, 49, 8), 15, 'sideways also full bright (no shadow model)');
});

test('skylight region: 第一阶段无阳光投影（悬挑下方全亮、无渐变，v1.9）', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  world.add(col);
  // 悬挑：y=50 处 x=6..10, z=7..9 的石头平台（3×5 格）
  for (let lx = 6; lx <= 10; lx++) for (let lz = 7; lz <= 9; lz++) {
    col.blocks[blockIndex(lx, 50, lz)] = reg.idOf('stone');
  }
  computeSkylightRegion(world, 0, 0, reg);
  // 第一阶段不产生阳光阴影：悬挑正下方与露天同亮，且无边缘/中心渐变
  assertEqual(sky(col, 6, 49, 7), 15, 'edge under overhang full bright');
  assertEqual(sky(col, 8, 49, 8), 15, 'center under overhang full bright');
  assertEqual(sky(col, 2, 49, 2), 15, 'open area full bright');
  assertEqual(sky(col, 8, 51, 8), 15, 'above overhang full bright');
});

test('skylight region: 第一阶段无阳光投影（封闭洞穴也全亮，v1.9）', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  world.add(col);
  // 封闭盒子：y=48..52 全填石头（16×16×5）；第一阶段无阳光阴影，内部仍 15
  for (let y = 48; y <= 52; y++) for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
    col.blocks[blockIndex(lx, y, lz)] = reg.idOf('stone');
  }
  computeSkylightRegion(world, 0, 0, reg);
  assertEqual(sky(col, 8, 50, 8), 15, 'sealed cave full bright (no sun shadow)');
  assertEqual(sky(col, 8, 49, 8), 15, 'sealed cave floor full bright');
});

test('setBlock: 挖块走真实路径 skylight 恒亮（第一阶段无阳光投影，v1.9）', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  world.add(col);
  for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
    col.blocks[blockIndex(lx, 50, lz)] = reg.idOf('stone');
  }
  recomputeLight(world, 0, 0, reg);
  assertEqual(sky(col, 8, 49, 8), 15, 'below ground full bright (no sun shadow)');
  // 真实游玩路径：world.setBlock 挖块 → 快路径重算，仍全亮
  world.setBlock(8, 50, 8, 0);
  assertEqual(sky(col, 8, 50, 8), 15, 'dug cell lit after setBlock');
  assertEqual(sky(col, 8, 49, 8), 15, 'below dug cell lit after setBlock');
  assertEqual(sky(col, 9, 49, 8), 15, 'sideways full bright');
});

test('setBlock: 放块不压暗下方（第一阶段无阳光投影，恒 15，v1.9）', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  world.add(col);
  recomputeLight(world, 0, 0, reg); // 开阔列：全 15
  assertEqual(sky(col, 8, 59, 8), 15, 'open air full bright');
  // 放一个悬空方块：同步/异步均不产生阳光阴影
  world.setBlock(8, 60, 8, reg.idOf('stone'));
  assertEqual(sky(col, 8, 59, 8), 15, 'no darkening below placed block');
  assertEqual(sky(col, 8, 40, 8), 15, 'deep below also full bright');
  recomputeLight(world, 0, 0, reg);
  assertEqual(sky(col, 8, 59, 8), 15, 'async recompute keeps full bright (no shadow model)');
});

// ---------------------------------------------------------------------------
// blocklight 区域语义（2026-10-21，用户实玩报告「灯光有边界」根因回归）
//
// 根因：区域重算只取「中心 + 4 个正交邻居」共 5 列。而 blocklight 强度 15、每格 -1、
// 最远照 **14 格**；column 边长 16 →
//   · 正交邻居最近格距中心列边缘 1 格   → 必须参与
//   · 对角邻居最近格距中心列边缘 2 格   → **也必须参与（旧实现漏了）**
//   · 隔一列（offset 2）最近格距 17 格 > 14 → 永远贡献 0，不需要参与
// 即正确区域恰好是 3×3。plus-5 缺对角 → 光在 column 的角落/边界外被截断（实测最大差 10 级）。
//
// 三条用例各钉一侧，缺一条都会放过「假修」：
//   ① 对角邻居的光必须照进来（旧实现为 0）
//   ② 3×3 结果必须与"全量世界 BFS"逐格相同（参考实现在测试里，只差 region 这一个变量）
//   ③ 隔一列必须仍为 0（否则「把更大范围都点亮」这种过度修复也能通过）
// ---------------------------------------------------------------------------

/** 全量参考 BFS：扫**整个传入世界**、无任何区域截断 —— 真值口径，与 lighting.js 无共享代码 */
function referenceBlocklightAll(world, reg) {
  const emissive = reg.emissiveTable, opaque = reg.opaqueTable;
  for (const c of world.columns.values()) {
    for (let i = 0; i < c.light.length; i++) c.light[i] &= 0xF0;
  }
  const queue = [];
  for (const c of world.columns.values()) {
    for (let i = 0; i < c.blocks.length; i++) {
      const e = emissive[c.blocks[i]];
      if (e > 0) {
        c.light[i] = (c.light[i] & 0xF0) | e;
        queue.push([c.cx * 16 + (i & 15), WORLD_MIN_Y + (i >> 8), c.cz * 16 + ((i >> 4) & 15), e]);
      }
    }
  }
  const DELTAS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  let head = 0;
  while (head < queue.length) {
    const [x, y, z, level] = queue[head++];
    if (level <= 1) continue;
    const next = level - 1;
    for (const [dx, dy, dz] of DELTAS) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (ny < WORLD_MIN_Y || ny >= WORLD_MAX_Y) continue;
      const ncx = Math.floor(nx / 16), ncz = Math.floor(nz / 16);
      const ncol = world.getColumn(ncx, ncz);
      if (!ncol) continue;
      const nidx = blockIndex(nx - ncx * 16, ny, nz - ncz * 16);
      if (opaque[ncol.blocks[nidx]] === 1) continue;
      if ((ncol.light[nidx] & 15) >= next) continue;
      ncol.light[nidx] = (ncol.light[nidx] & 0xF0) | next;
      queue.push([nx, ny, nz, next]);
    }
  }
}

/** 建 (2R+1)² 个空 column 的世界 */
function gridWorld(reg, R) {
  const world = new WorldData(reg);
  for (let cx = -R; cx <= R; cx++) for (let cz = -R; cz <= R; cz++) world.add(new ChunkColumn(cx, cz));
  return world;
}

/** 把世界裁成 3×3（中心 + 对角邻居全在），供 computeBlocklightRegion 用 */
function crop3x3(reg, src) {
  const world = new WorldData(reg);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const s = src.getColumn(dx, dz);
    const c = new ChunkColumn(dx, dz);
    c.blocks.set(s.blocks);
    world.add(c);
  }
  return world;
}

test('blocklight region: 对角邻居列的光必须照进中心列（plus-5 根本不成立）', () => {
  const reg = makeRegistry();
  const world = gridWorld(reg, 1);
  const center = world.getColumn(0, 0);
  const diag = world.getColumn(1, 1);
  // 光源放在对角列的角落：世界 (16,50,16)，距中心列角落 (15,50,15) **仅 2 格**
  diag.blocks[blockIndex(0, 50, 0)] = reg.idOf('glowstone');
  computeBlocklightRegion(world, 0, 0, reg);
  // 期望值直接按曼哈顿距离算（全空气、无遮挡）
  assertEqual(blk(center, 15, 50, 15), 13, 'corner cell 2 blocks from diagonal source');
  assertEqual(blk(center, 14, 50, 15), 12);
  assertEqual(blk(center, 15, 50, 14), 12);
  assertEqual(blk(center, 10, 50, 10), 3, 'deep in center column still reachable');
});

test('blocklight region: 3×3 结果与全量世界 BFS 逐格相同（参考实现在测试内）', () => {
  const reg = makeRegistry();
  const src = gridWorld(reg, 3);
  // 确定性布置：**8 个邻居列各放一盏**（含 4 个对角列 —— 没有对角源的场景测不出 region 漏格），
  // 再用确定性 PRNG 撒障碍制造遮挡。不用 Math.random：失败要可复现。
  const glowY = 50;
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    if (dx === 0 && dz === 0) continue;
    const c = src.getColumn(dx, dz);
    // 朝中心一侧的角落：对角列即世界 (16·(1+dx), y, 16·(1+dz)) 一侧的那一格
    const lx = dx === 1 ? 0 : dx === -1 ? 15 : 8;
    const lz = dz === 1 ? 0 : dz === -1 ? 15 : 8;
    c.blocks[blockIndex(lx, glowY, lz)] = reg.idOf('glowstone');
  }
  let s = 20261021;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const cols = [...src.columns.values()];
  for (let i = 0; i < 60; i++) {
    const c = cols[Math.floor(rnd() * cols.length)];
    c.blocks[blockIndex(Math.floor(rnd() * 16), 44 + Math.floor(rnd() * 16), Math.floor(rnd() * 16))] = reg.idOf('stone');
  }
  // 真值：全量 BFS（7×7 世界，中心 3×3 离世界边缘 ≥2 列 = 32 格 > 14，无截断影响）
  referenceBlocklightAll(src, reg);
  // 被测：裁成 3×3 后用正式实现重算
  const cropped = crop3x3(reg, src);
  computeBlocklightRegion(cropped, 0, 0, reg);
  let mismatch = 0, worst = 0;
  const center = src.getColumn(0, 0), underTest = cropped.getColumn(0, 0);
  for (let i = 0; i < center.light.length; i++) {
    const want = center.light[i] & 15, got = underTest.light[i] & 15;
    if (want !== got) { mismatch++; worst = Math.max(worst, Math.abs(want - got)); }
  }
  assertEqual(mismatch, 0, `center column must match full-world BFS exactly (worst Δ=${worst})`);
});

test('blocklight region: 隔一列（offset 2）必须仍为 0（防过度修复）', () => {
  const reg = makeRegistry();
  const world = gridWorld(reg, 2);
  const center = world.getColumn(0, 0);
  const far = world.getColumn(2, 0); // 隔一列
  // 光源贴在该列的远侧（世界 x=47），距中心列最近的格 x=15 → 曼哈顿 32 格 > 14
  far.blocks[blockIndex(15, 50, 8)] = reg.idOf('glowstone');
  computeBlocklightRegion(world, 0, 0, reg);
  assertEqual(blk(center, 15, 50, 8), 0, 'a column 2 away is beyond the 14-block reach');
});
