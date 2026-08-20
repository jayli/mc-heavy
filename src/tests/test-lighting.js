import { test } from './runner.js';
import { assertEqual } from './assert.js';
import { computeSkylightColumn, computeSkylightRegion, computeBlocklightRegion, recomputeLight } from '../mesh/lighting.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';
import { WORLD_MIN_Y, blockIndex } from '../voxel/constants.js';
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

test('skylight: opaque 方块遮挡（下方为 0，封闭洞穴正确）', () => {
  const reg = makeRegistry();
  const col = new ChunkColumn(0, 0);
  const stoneId = reg.idOf('stone');
  col.blocks[blockIndex(8, 50, 8)] = stoneId;
  computeSkylightColumn(col, reg);
  assertEqual(sky(col, 8, 51, 8), 15);
  assertEqual(sky(col, 8, 50, 8), 0, 'opaque block itself is dark');
  assertEqual(sky(col, 8, 49, 8), 0, 'below opaque is dark');
  assertEqual(sky(col, 8, 20, 8), 0);
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

test('recomputeLight: 挖掉 opaque 后 skylight 恢复（挖块黑面 bug 回归）', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  world.add(col);
  // 铺一层石头地面 y=50：下方全黑
  for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
    col.blocks[blockIndex(lx, 50, lz)] = reg.idOf('stone');
  }
  recomputeLight(world, 0, 0, reg);
  assertEqual(sky(col, 8, 49, 8), 0, 'below ground is dark');
  // 挖掉 (8,50,8)：下方应恢复 skylight 15
  col.blocks[blockIndex(8, 50, 8)] = 0;
  recomputeLight(world, 0, 0, reg);
  assertEqual(sky(col, 8, 50, 8), 15, 'dug cell lit');
  assertEqual(sky(col, 8, 49, 8), 15, 'below dug cell lit');
  assertEqual(sky(col, 8, 30, 8), 15, 'deep below dug cell lit');
  // 水平扩散模型：挖洞后光向侧向扩散，相邻列下方被照亮（15-1=14）——
  // Minecraft 正确行为（旧垂直模型此处为 0，断言随模型升级更新）。
  assertEqual(sky(col, 9, 49, 8), 14, 'light spreads sideways below dug hole');
});

test('skylight region: 悬挑下方不全黑（水平扩散渗入）', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  world.add(col);
  // 悬挑：y=50 处 x=6..10, z=7..9 的石头平台（3×5 格）
  for (let lx = 6; lx <= 10; lx++) for (let lz = 7; lz <= 9; lz++) {
    col.blocks[blockIndex(lx, 50, lz)] = reg.idOf('stone');
  }
  computeSkylightRegion(world, 0, 0, reg);
  // 悬挑正下方紧邻（y=49）：从侧面 15 扩散进来，应 >0（不是全黑）
  // 边缘格（x=6, z=7）距露天最近 → 最亮；中心格（x=8, z=8）距露天最远 → 较暗但 >0
  const edge = sky(col, 6, 49, 7);
  const center = sky(col, 8, 49, 8);
  assertEqual(edge > 0, true, `edge under overhang lit, got ${edge}`);
  assertEqual(center > 0, true, `center under overhang lit, got ${center}`);
  assertEqual(edge > center, true, `edge brighter than center (${edge} > ${center})`);
  // 远离悬挑的露天格仍然 15
  assertEqual(sky(col, 2, 49, 2), 15, 'open area still full bright');
  // 悬挑上方（y=51）露天 15
  assertEqual(sky(col, 8, 51, 8), 15, 'above overhang full bright');
});

test('skylight region: 封闭洞穴仍全黑（水平扩散不穿透 opaque）', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  world.add(col);
  // 封闭盒子：y=48..52 全填石头（16×16×5），内部 y=49..51 无光
  for (let y = 48; y <= 52; y++) for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
    col.blocks[blockIndex(lx, y, lz)] = reg.idOf('stone');
  }
  computeSkylightRegion(world, 0, 0, reg);
  assertEqual(sky(col, 8, 50, 8), 0, 'sealed cave is dark');
  assertEqual(sky(col, 8, 49, 8), 0, 'sealed cave floor dark');
});

test('setBlock: 挖块走真实路径后 skylight 增量恢复（黑面 bug 端到端）', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  world.add(col);
  for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
    col.blocks[blockIndex(lx, 50, lz)] = reg.idOf('stone');
  }
  recomputeLight(world, 0, 0, reg);
  assertEqual(sky(col, 8, 49, 8), 0, 'below ground is dark');
  // 真实游玩路径：world.setBlock 挖块 → 内部增量重算同列 skylight
  world.setBlock(8, 50, 8, 0);
  assertEqual(sky(col, 8, 50, 8), 15, 'dug cell lit after setBlock');
  assertEqual(sky(col, 8, 49, 8), 15, 'below dug cell lit after setBlock');
  // setBlock 快路径只做垂直单列（守 2ms 编辑预算）：侧向扩散由 scheduler 的
  // 异步 light 任务收敛，故此处相邻列仍为旧值 0（不是 bug，是快路径口径）。
  assertEqual(sky(col, 9, 49, 8), 0, 'sideways spread deferred to async light task');
});

test('setBlock: 放块不立即压暗下方（防黑闪；暗化由区域扩散异步收敛）', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  world.add(col);
  recomputeLight(world, 0, 0, reg); // 开阔列：全 15
  assertEqual(sky(col, 8, 59, 8), 15, 'open air full bright');
  // 放一个悬空方块：同步路径【不得】把下方压成 0——
  // 同步压暗只能到 0（纯垂直模型），当帧渲染就是黑闪（实玩 bug）。
  world.setBlock(8, 60, 8, reg.idOf('stone'));
  assertEqual(sky(col, 8, 59, 8), 15, 'no synchronous darkening below placed block');
  assertEqual(sky(col, 8, 40, 8), 15, 'deep below also not darkened synchronously');
  // 异步收敛口径（recomputeLight = worker 区域重算等价）：正确压暗到 14
  recomputeLight(world, 0, 0, reg);
  assertEqual(sky(col, 8, 59, 8), 14, 'async diffusion converges to correct shadow');
});
