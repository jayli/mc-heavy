// src/tests/test-place-ray.js — 未命中时沿视线找「最近可贴格」（对齐 mc-lite `doSkyPlace`）
//
// 语义（mc-lite `PlayerInteraction.js:781-806`）：沿视线前进，
//   ① 沿途碰到**实心**格即停止（遮挡：它后面的格子相机看不到）；
//   ② 候选格本身须**非实心**；
//   ③ 至少一个**正交**邻居是实心（否则是凭空放空中方块）；
//   ④ 没有任何实心邻居位于视线前方（`dot(视线, 邻居方向) > 0.01` 即否决）——
//      正对着的那面墙交给常规 `prevPos` 路径，兜底只在「准心对着空白」时接管。
//
// ⚠️ **本文件全部期望值都是在真实实现上跑出来的实测值**（testing-policy §2.6 第 ⑤ 条：
// 写断言前先跑一次、打印实际值）。初版有两条是凭想象写的，实测当场驳回：
//   · 「俯视整层地面 → 落在地面上方一格」：实测 **false** —— 地面正处在视线前方，
//     被 ④ 否决（正是 `allInvisible` 的设计意图）。俯视地面时主射线本就命中地面、
//     不会走兜底，故此否定不影响任何真实路径。
//   · 「起点在实心格内 → 跳过该格继续」：实测 **false** —— ① 在起点格即生效。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { WorldData } from '../voxel/world-data.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { blockIndex } from '../voxel/constants.js';
import { PLACE_RAY_MAX_DIST, findPlaceCell } from '../player/place-ray.js';

/** 生产同源注册表 + 单 column 空地世界（坐标一律取 0..15 的非负局部坐标） */
function makeWorld() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  const world = new WorldData(reg);
  world.add(new ChunkColumn(0, 0));
  return { world, reg };
}

function put(world, reg, x, y, z, name = 'stone') {
  world.getColumn(0, 0).blocks[blockIndex(x, y, z)] = reg.idOf(name);
}

test('place-ray: 射程常量 = 15 格（mc-lite doSkyPlace maxDist）', () => {
  assertEqual(PLACE_RAY_MAX_DIST, 15, 'maxDist');
});

test('place-ray: 侧向邻居（-Z 侧一格石头）→ 贴它放', () => {
  const { world, reg } = makeWorld();
  put(world, reg, 10, 3, 7);
  // 从 (8.5,3.5,8.5) 朝 +X 平视：(8,3,8) 与 (9,3,8) 都没有实心邻居，
  // 到 (10,3,8) 时 -Z 邻居 (10,3,7) 是石头，且 dot((1,0,0),(0,0,-1)) = 0 → 不否决
  const r = findPlaceCell(world, [8.5, 3.5, 8.5], [1, 0, 0]);
  assertTrue(r.hit, '须找到可贴格');
  assertEqual(r.placeCell.join(','), '10,3,8', '贴 -Z 侧');
  assertEqual(r.neighbor.join(','), '10,3,7', '被贴住的邻居');
});

test('place-ray: 侧向邻居（+Z 侧一格石头）→ 贴它放', () => {
  const { world, reg } = makeWorld();
  put(world, reg, 10, 3, 9);
  const r = findPlaceCell(world, [8.5, 3.5, 8.5], [1, 0, 0]);
  assertTrue(r.hit, '须找到可贴格');
  assertEqual(r.placeCell.join(','), '10,3,8');
  assertEqual(r.neighbor.join(','), '10,3,9', '贴 +Z 侧');
});

test('place-ray: 上方邻居（天花板）→ 贴它放', () => {
  const { world, reg } = makeWorld();
  put(world, reg, 10, 4, 8);
  const r = findPlaceCell(world, [8.5, 3.5, 8.5], [1, 0, 0]);
  assertTrue(r.hit, '须找到可贴格');
  assertEqual(r.placeCell.join(','), '10,3,8');
  assertEqual(r.neighbor.join(','), '10,4,8', '贴上方');
});

test('place-ray: 视线前方就是实心方块 → 否决（那面墙由常规 prevPos 路径处理）', () => {
  const { world, reg } = makeWorld();
  // x=12 一列实心（y=0..7），其余全空。射线走到 x=11 时 +X 邻居就是这面墙 →
  // 按 ④ 否决；再前进到 x=12 被 ① 中断 → false。
  // ⚠️ 若无 ①（只在实心格「跳过」而不中断），实测会在**墙后** x=13 凭空放出一块
  //（13 的 -X 邻居是那面墙，dot = -1 不被否决）。
  for (let y = 0; y < 8; y++) put(world, reg, 12, y, 8);
  assertEqual(findPlaceCell(world, [8.5, 1.5, 8.5], [1, 0, 0]).hit, false);
});

test('place-ray: 无实心邻居（孤立空中）→ 不命中', () => {
  const { world } = makeWorld();
  assertEqual(findPlaceCell(world, [8.5, 40.5, 8.5], [1, 0, 0]).hit, false);
});

test('place-ray: 起点位于实心格内 → 遮挡判据在起点即生效（不命中）', () => {
  const { world, reg } = makeWorld();
  put(world, reg, 9, 3, 8);
  assertEqual(findPlaceCell(world, [9.5, 3.5, 8.5], [1, 0, 0]).hit, false,
    'mc-lite 同口径：`if (!isSolid) {...} else break;` 在起点格就 break');
});

test('place-ray: 水面邻居不算实心（isSolid 口径，与 mc-lite 的 physics.isSolid 同源）', () => {
  const { world, reg } = makeWorld();
  put(world, reg, 10, 3, 7, 'water');
  assertEqual(findPlaceCell(world, [8.5, 3.5, 8.5], [1, 0, 0]).hit, false,
    'water 的 solid 为 false → 不构成本 ② 的邻居');
});

test('place-ray: 射程截断（地面从 x=11 才开始，实测 trio）', () => {
  const { world, reg } = makeWorld();
  for (let x = 11; x < 16; x++) for (let z = 0; z < 16; z++) put(world, reg, x, 0, z);
  // 射线从 x=8.5 出发朝 +X 平视（y=3.5，比地面高一格以上）：只有走到地面柱上方才有邻居
  assertEqual(findPlaceCell(world, [8.5, 1.5, 8.5], [1, 0, 0], 2).hit, false, '射程 2 不够');
  const ok = findPlaceCell(world, [8.5, 1.5, 8.5], [1, 0, 0], 3);
  assertTrue(ok.hit, '射程 3 够（实测恰在此处放开）');
  assertEqual(ok.placeCell.join(','), '11,1,8');
  assertTrue(findPlaceCell(world, [8.5, 1.5, 8.5], [1, 0, 0]).hit, '默认射程够');
});

test('place-ray: 用户场景 —— 站在 1×1 方块上朝东偏下看，贴到东侧那格', () => {
  const { world, reg } = makeWorld();
  // 玩家站在 (7,0,7) 的单块顶面：脚底 y=1，眼睛 y=2.62（EYE_HEIGHT 1.62）。
  // 朝东下方对准「东侧那格的中心」(8.5, 0.5, 7.5) —— 玩家只能看到脚底方块的顶面，
  // 看不到水平侧面，故主射线打空（实测 target=null），只能靠本兜底。
  put(world, reg, 7, 0, 7);
  const eye = [7.5, 2.62, 7.5];
  const aim = [8.5, 0.5, 7.5];
  const dir = [aim[0] - eye[0], aim[1] - eye[1], aim[2] - eye[2]];
  const r = findPlaceCell(world, eye, dir);
  assertTrue(r.hit, '须找到可贴格');
  assertEqual(r.placeCell.join(','), '8,0,7', '脚底方块（7,0,7）的东侧那一格');
  assertEqual(r.neighbor.join(','), '7,0,7', '被贴住的正是脚底方块');
});

test('place-ray: 确定性（同输入两次结果相同）', () => {
  const { world, reg } = makeWorld();
  put(world, reg, 10, 3, 7);
  const a = findPlaceCell(world, [8.5, 3.5, 8.5], [1, 0, 0]);
  const b = findPlaceCell(world, [8.5, 3.5, 8.5], [1, 0, 0]);
  assertEqual(JSON.stringify(a), JSON.stringify(b));
});
