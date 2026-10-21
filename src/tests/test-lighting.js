import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import {
  computeSkylightColumn, computeSkylightRegion, computeBlocklightRegion, recomputeLight, lightDirtyMasks,
} from '../mesh/lighting.js';
import { buildSectionMesh } from '../mesh/mesher.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';
import {
  WORLD_MIN_Y, WORLD_MAX_Y, BLOCKS_PER_COLUMN, SECTIONS_PER_COLUMN, blockIndex,
} from '../voxel/constants.js';
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

// ---------------------------------------------------------------------------
// 光照变化 → 脏 section 传播（2026-10-21 第二次修「灯光有边界」+「删灯后被照亮的面不变暗」）
//
// 根因：mesher 对 section S 的 light 依赖 = **S 自身 16³ + 六个面外各 1 格厚的 halo**
// （faceLight 读面外邻居格；模板方块读自身格；棱/角 halo 格只读 blocks 算 AO，不读 light）。
// 上一版 `_onLightResult` 只给「light 字节真变了」的**同 sy** section 置脏，漏了两类依赖者：
//   ① Y 方向：地表恰好在 section 最上层（如 y=-1）时，顶面读的是上一个 section 最底层那格 ——
//      那格 light 变了，地面所在的 section 却没人通知它重 mesh（实测 seed=6503358 的沙滩 sy=1）；
//   ② X/Z 方向：邻列只在边界层（lx/lz ∈ {0,15}）读本列的格，而旧实现对 3×3 的 8 个邻列
//      一律按「同 sy」置脏（含对角列 —— 它们根本不读本列的 light）。
// 用户可见症状：放灯后一部分地面不亮（边界 = column 边界）；删灯后被照亮的面不变暗。
//
// 本节四类用例各钉一侧：
//   A. 纯函数的精确掩码（边界层 / 世界上下界 / 棱角 / 无变化）；
//   B. **与 mesher 的交叉比对**（pocket 世界：预测集合必须与实测变化集合逐项相等）——
//      判据落在「mesher 真的读了哪些格」上，而不是落在函数自己的假设上；
//   C. 随机稀疏世界的安全方向（实测变化 ⊆ 预测），将来 mesher 若改成平滑光照（采对角格）会在这里立刻红。
// ---------------------------------------------------------------------------

const EMPTY_ATLAS = {}; // mesher 对缺失 tile 回退 DEFAULT_TILE；本节只关心 packed 里的光照位

/** 在 prev 的拷贝上把若干格的 blocklight 改成 9，返回 [prev, next] */
function lightPair(cells) {
  const prev = new Uint8Array(BLOCKS_PER_COLUMN);
  const next = prev.slice();
  for (const [lx, y, lz] of cells) next[blockIndex(lx, y, lz)] = 9;
  return [prev, next];
}
const lit = (arr) => [...arr].map((v, i) => (v ? i : -1)).filter((i) => i >= 0);

test('lightDirtyMasks: light 一字节没变 → 一个 section 也不置脏', () => {
  const prev = new Uint8Array(BLOCKS_PER_COLUMN);
  const m = lightDirtyMasks(prev, prev.slice());
  for (const k of ['self', 'xm', 'xp', 'zm', 'zp']) assertEqual(lit(m[k]).length, 0, `${k} 必须全零`);
});

test('lightDirtyMasks: section 内部的格（非边界层）→ 只有它自己所在的 section', () => {
  // sy=3 ⇒ y ∈ [16,31]；y=24 → ly=8
  const m = lightDirtyMasks(...lightPair([[8, 24, 8]]));
  assertEqual(lit(m.self).join(), '3', 'self');
  for (const k of ['xm', 'xp', 'zm', 'zp']) assertEqual(lit(m[k]).length, 0, `${k} 必须全零（格不在 x/z 边界层）`);
});

test('lightDirtyMasks: section 最底层（ly=0）→ 自己 + **下方** section（它的顶面读这一格）', () => {
  const m = lightDirtyMasks(...lightPair([[8, 16, 8]])); // y=16 → sy=3, ly=0
  assertEqual(lit(m.self).join(), '2,3', 'self 必须含 sy-1（地表在下方 section 最上层的场景）');
});

test('lightDirtyMasks: section 最上层（ly=15）→ 自己 + **上方** section（它的底面读这一格）', () => {
  const m = lightDirtyMasks(...lightPair([[8, 31, 8]])); // y=31 → sy=3, ly=15
  assertEqual(lit(m.self).join(), '3,4', 'self 必须含 sy+1（天花板在上方 section 最底层的场景）');
});

test('lightDirtyMasks: 世界最底层/最顶层不越界（sy=0 的 ly=0、sy=7 的 ly=15）', () => {
  const bottom = lightDirtyMasks(...lightPair([[8, WORLD_MIN_Y, 8]]));
  assertEqual(lit(bottom.self).join(), '0', '世界最底格只影响 sy=0（没有 sy=-1）');
  const top = lightDirtyMasks(...lightPair([[8, WORLD_MAX_Y - 1, 8]]));
  assertEqual(lit(top.self).join(), String(SECTIONS_PER_COLUMN - 1), '世界最顶格只影响最后一个 section');
  assertEqual(bottom.self.length, SECTIONS_PER_COLUMN, '掩码长度恒为 SECTIONS_PER_COLUMN');
});

test('lightDirtyMasks: x/z 边界层 → 对应**正交**邻列的同 sy（四个方向各钉一个）', () => {
  const cases = [['xm', [0, 24, 8]], ['xp', [15, 24, 8]], ['zm', [8, 24, 0]], ['zp', [8, 24, 15]]];
  for (const [key, cell] of cases) {
    const m = lightDirtyMasks(...lightPair([cell]));
    assertEqual(lit(m[key]).join(), '3', `${key} 必须含 sy=3（cell ${cell}）`);
    assertEqual(lit(m.self).join(), '3', `self 仍然只有 sy=3（${key}）`);
    for (const other of ['xm', 'xp', 'zm', 'zp'].filter((k) => k !== key)) {
      assertEqual(lit(m[other]).length, 0, `${other} 不得被 ${key} 方向的边界格带上`);
    }
  }
});

test('lightDirtyMasks: 棱角格（lx=0,lz=15,ly=15）→ self{sy,sy+1} + xm + zp，**没有对角列**', () => {
  const m = lightDirtyMasks(...lightPair([[0, 31, 15]])); // sy=3, ly=15
  assertEqual(lit(m.self).join(), '3,4');
  assertEqual(lit(m.xm).join(), '3');
  assertEqual(lit(m.zp).join(), '3');
  assertEqual(lit(m.xp).length, 0);
  assertEqual(lit(m.zm).length, 0);
  // API 本身就没有「对角列」这一概念：对角列的 mesh 不读本列的 light（faceLight 只读面外**正交**邻格）
  assertEqual(Object.keys(m).sort().join(), 'self,xm,xp,zm,zp');
});

/** 把掩码换成「相对 (dcx,dcz,sy)」键集合，便于与 mesher 实测变化集合逐项比较 */
function maskKeys(m) {
  const out = new Set();
  const add = (arr, dcx, dcz) => arr.forEach((v, sy) => { if (v) out.add(`${dcx},${dcz},${sy}`); });
  add(m.self, 0, 0); add(m.xm, -1, 0); add(m.xp, 1, 0); add(m.zm, 0, -1); add(m.zp, 0, 1);
  return out;
}

/** 3×3 列 × sy ∈ [sy0, sy1] 各 section 现算一遍 mesh → 三通道 packed 拷贝（精确比较，不用哈希） */
function meshSigs(world, sy0, sy1) {
  const sigs = new Map();
  for (let dcx = -1; dcx <= 1; dcx++) for (let dcz = -1; dcz <= 1; dcz++) {
    for (let sy = sy0; sy <= sy1; sy++) {
      const r = buildSectionMesh(world.getSectionView(dcx, sy, dcz), world.registry, EMPTY_ATLAS, dcx, sy, dcz);
      sigs.set(`${dcx},${dcz},${sy}`, [r.opaque.packed.slice(), r.cutout.packed.slice(), r.transparent.packed.slice()]);
    }
  }
  return sigs;
}
function sigChanged(a, b) {
  for (let ch = 0; ch < 3; ch++) {
    if (a[ch].length !== b[ch].length) return true;
    for (let i = 0; i < a[ch].length; i++) if (a[ch][i] !== b[ch][i]) return true;
  }
  return false;
}
function changedKeys(base, now) {
  const out = new Set();
  for (const [k, sig] of now) if (sigChanged(base.get(k), sig)) out.add(k);
  return out;
}
const setAt = (world, wx, y, wz, id) => {
  const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
  world.getColumn(cx, cz).blocks[blockIndex(wx - cx * 16, y, wz - cz * 16)] = id;
};
const NEIGHBOR6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

test('lightDirtyMasks 与 mesher 交叉比对：pocket 世界里「预测集合 == 实测变化集合」（逐格逐项）', () => {
  const reg = makeRegistry();
  const world = gridWorld(reg, 1);
  const stone = reg.idOf('stone');
  const center = world.getColumn(0, 0);
  const SY = 3, y0 = WORLD_MIN_Y + SY * 16; // y ∈ [16, 31]
  // pocket = 一格空气 + 六个面邻格全是 stone：六块 stone 各有一个面朝向这格空气，
  // 于是「这格 light 变了」恰好让**六块 stone 各自所在的 section** 的 mesh 变化 —— 实测依赖集合
  // 就是这六个邻格各自属于哪个 section/列，不依赖任何关于 mesher 的先验假设。
  const cells = [];
  for (const lx of [0, 8, 15]) for (const ly of [0, 8, 15]) for (const lz of [0, 8, 15]) cells.push([lx, y0 + ly, lz]);
  for (const [lx, y, lz] of cells) for (const [dx, dy, dz] of NEIGHBOR6) setAt(world, lx + dx, y + dy, lz + dz, stone);
  const base = meshSigs(world, SY - 1, SY + 1);
  let boundarySections = 0;
  for (const [lx, y, lz] of cells) {
    const idx = blockIndex(lx, y, lz);
    const prev = center.light.slice();
    center.light[idx] = 9;
    const actual = changedKeys(base, meshSigs(world, SY - 1, SY + 1));
    const predicted = maskKeys(lightDirtyMasks(prev, center.light));
    center.light[idx] = 0;
    const tag = `cell(${lx},${y},${lz})`;
    assertEqual([...actual].sort().join('|'), [...predicted].sort().join('|'),
      `${tag}：mesher 实测变化的 section 集合必须与 lightDirtyMasks 预测完全一致`);
    if (actual.size > 1) boundarySections++;
  }
  // sanity floor：pocket 世界确实让边界格触发了跨 section/跨列的变化（否则上面的逐项相等是空转）
  assertTrue(boundarySections >= 18, `边界 pocket 必须引起跨 section 变化（实际 ${boundarySections}/27）`);
  // 具体物理含义钉死：棱角格 (0, y0+15, 15) 的六块邻 stone 分属 self{3,4} + xm{3} + zp{3}
  const corner = [0, y0 + 15, 15];
  const idx = blockIndex(...corner);
  const prev = center.light.slice();
  center.light[idx] = 9;
  const actual = [...changedKeys(base, meshSigs(world, SY - 1, SY + 1))].sort().join('|');
  center.light[idx] = 0;
  void prev;
  assertEqual(actual, ['-1,0,3', '0,0,3', '0,0,4', '0,1,3'].join('|'), '棱角格的实测依赖集合');
});

test('lightDirtyMasks 覆盖 mesher 对 light 的全部依赖（随机稀疏世界：实测变化 ⊆ 预测）', () => {
  const reg = makeRegistry();
  const world = gridWorld(reg, 1);
  const stone = reg.idOf('stone');
  const center = world.getColumn(0, 0);
  const SY = 3, y0 = WORLD_MIN_Y + SY * 16;
  // 确定性 PRNG（失败要可复现）：y ∈ [8, 56] 内约 25% 的格是 stone，覆盖 sy=2..4 且边界层上大量面暴露
  let s = 20261021;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let wx = -16; wx < 32; wx++) for (let wz = -16; wz < 32; wz++) {
    for (let y = 8; y <= 56; y++) if (rnd() < 0.25) setAt(world, wx, y, wz, stone);
  }
  const base = meshSigs(world, SY - 1, SY + 1);
  let anyChange = 0;
  for (const lx of [0, 8, 15]) for (const ly of [0, 8, 15]) for (const lz of [0, 8, 15]) {
    const y = y0 + ly, idx = blockIndex(lx, y, lz);
    const prev = center.light.slice();
    center.light[idx] = 9;
    const actual = changedKeys(base, meshSigs(world, SY - 1, SY + 1));
    const predicted = maskKeys(lightDirtyMasks(prev, center.light));
    center.light[idx] = 0;
    for (const k of actual) {
      assertTrue(predicted.has(k), `cell(${lx},${y},${lz})：mesher 里 section ${k} 的网格变了，但 lightDirtyMasks 没有预测到它`);
    }
    anyChange += actual.size;
  }
  assertTrue(anyChange > 0, `随机世界里 light 变化必须引起一些 mesh 变化（实际 ${anyChange}，0 = 测试空转）`);
});
