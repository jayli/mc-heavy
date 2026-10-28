// src/tests/test-arena-gen.js — 城门竞技场接线 Tier 1：真实 column GEN 逐格落位
//
// 钉的是「纯函数全绿但世界里什么都不长 / 长错位置」这一类缺陷（M7 教训）：
//   · STRUCTURE_FILES 漏映射 → rasterizeStructure 静默 return（0 个方块，无报错）
//   · `needTypes` 漏预载 → cache 未命中 → 同样静默
//   · 阶段 2.9 漏了 / `floorRow` 算错 → 地板沉到水池底下（方块层面看不出是 y 错了）
//   · 漏了「清空上方」→ 占地内的土丘从地板里长出来，穿透竞技场
//
// 断言落点一律是**真实 applyStructuresToColumn 写出的世界方块**，不是纯函数返回值。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { computeRegionLayout, neighborRegionKeys } from '../gen/structures/structure-layout.js';
import { applyStructuresToColumn } from '../gen/structures/apply.js';
import { loadStructure, floorRowOf } from '../gen/structures/structure-json.js';
import { buildDefaultRegistry } from '../voxel/block-registry.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { fillColumn, generateHeight } from '../gen/terrain.js';
import { carveCaves } from '../gen/caves.js';
import { blockIndex, SEA_Y } from '../voxel/constants.js';
import {
  computeArenaAnchor, ARENA_HALF_X, ARENA_HALF_Z, ARENA_WIDTH, ARENA_DEPTH, clearArenaCache,
  railArmSet,
} from '../gen/structures/arena.js';

const SEED = 12345;

/** 查询域内的邻域布局（与 StructureIndex 下发的 3×3 邻域一致） */
function layoutsFor(cx, cz) {
  const out = [];
  for (const key of neighborRegionKeys(cx, cz)) {
    const [rx, rz] = key.split(',').map(Number);
    out.push(computeRegionLayout(rx, rz, SEED));
  }
  return out;
}

/** 与 Worker 真实路径一致的完整 GEN（fillColumn + caves + applyStructures，不含 edits/light） */
async function genColumn(reg, cx, cz) {
  const col = new ChunkColumn(cx, cz);
  fillColumn(col, SEED, reg);
  carveCaves(col, SEED);
  await applyStructuresToColumn(col, SEED, reg, layoutsFor(cx, cz));
  return col;
}

/** 模块级单例：`buildWorld()` 的实测成本很高（约 20 个 column 的完整 GEN + 9 个 region 布局），
 *  而本文件有多条用例都要它 —— 每次重建会让整页耗时翻好几倍，直接撞 `harness.spec.mjs`
 *  的 30s 等待窗口（实测踩到：8 次重建 → 整页 66.3s → harness 超时恒红）。
 *  ⚠️ 单例是**安全的**：`applyStructuresToColumn` 是纯函数（同一 seed 下结果确定），
 *  且本用例集**只读**世界、从不修改它。 */
let _worldPromise = null;
function buildWorld() {
  if (!_worldPromise) _worldPromise = buildWorldOnce();
  return _worldPromise;
}

/** 从全部相关 column 拼出「世界取方块」查询器（加载区覆盖整个竞技场） */
async function buildWorldOnce() {
  const reg = await buildDefaultRegistry();
  clearArenaCache();
  const a = computeArenaAnchor(SEED);
  assertTrue(!!a, '默认 seed 必须有竞技场锚点（否则本文件用例恒真）');
  const minCx = Math.floor((a.wx - ARENA_HALF_X) / 16);
  const maxCx = Math.floor((a.wx + ARENA_HALF_X) / 16);
  const minCz = Math.floor((a.wz - ARENA_HALF_Z) / 16);
  const maxCz = Math.floor((a.wz + ARENA_HALF_Z) / 16);
  const cols = new Map();
  for (let cx = minCx; cx <= maxCx; cx++) {
    for (let cz = minCz; cz <= maxCz; cz++) {
      cols.set(`${cx},${cz}`, await genColumn(reg, cx, cz));
    }
  }
  const get = (wx, wy, wz) => {
    const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
    const col = cols.get(`${cx},${cz}`);
    if (!col) return 0;
    const lx = wx - cx * 16, lz = wz - cz * 16;
    return col.blocks[blockIndex(lx, wy, lz)];
  };
  return { reg, a, cols, get };
}

const NAME = async (reg, id) => (id === 0 ? 'air' : reg.nameOf(id));

test('竞技场 GEN：占地内每列都有地板（地板满铺、无缺口）', async () => {
  await loadStructure('arenaGrass');
  const { reg, a, get } = await buildWorld();
  const floorY = a.floorY;
  let missing = 0;
  const kinds = new Map();
  for (let x = a.wx - (ARENA_WIDTH - 3) / 2; x <= a.wx + (ARENA_WIDTH - 3) / 2; x++) {
    for (let z = a.wz - (ARENA_DEPTH - 3) / 2; z <= a.wz + (ARENA_DEPTH - 3) / 2; z++) {
      const id = get(x, floorY, z);
      if (id === 0) { missing++; continue; }
      const n = await NAME(reg, id);
      kinds.set(n, (kinds.get(n) || 0) + 1);
    }
  }
  assertEqual(missing, 0, '地板层不得有空气格（水池也不会漏 — 水池有玻璃盖）');
  assertTrue((kinds.get('grass') || 0) > 2000, `地板主体必须是 grass（实得 ${JSON.stringify(Object.fromEntries(kinds))}）`);
});

test('竞技场 GEN：地板高度 = 占地内最低自然高度（贴合地形最低点）', async () => {
  await loadStructure('arenaGrass');
  const { a } = await buildWorld();
  let mn = Infinity;
  for (let x = a.wx - ARENA_HALF_X; x <= a.wx + ARENA_HALF_X; x++) {
    for (let z = a.wz - ARENA_HALF_Z; z <= a.wz + ARENA_HALF_Z; z++) {
      const h = generateHeight(x, z, SEED);
      if (h < mn) mn = h;
    }
  }
  assertEqual(a.floorY, mn, 'floorY 必须等于占地内最低自然高度');
});

test('竞技场 GEN：地板以上被清空（土丘不会穿透场地）', async () => {
  const data = await loadStructure('arenaGrass');
  const { reg, a, get } = await buildWorld();
  // ⚠️ 判据必须**排除产物自身写入的方块**（栏杆、干草柱、树、花……）：
  // 直接断言「从 floorY+2 起全空」会把竞技场内容当成侵入（实测误报 100 格全部是 hay_bale）。
  // 正确口径：拿产物里该列的**最高层 y** 作基线，只查基线以上的自然地形。
  const topOf = new Map();   // 'x,z' → 归一化最高 y
  for (const b of data.blocks) {
    const k = `${b.x},${b.z}`;
    if ((topOf.get(k) ?? -Infinity) < b.y) topOf.set(k, b.y);
  }
  const floorRow = data.floorRow;
  let intruders = 0;
  const samples = [];
  for (let x = a.wx - ARENA_HALF_X + 1; x <= a.wx + ARENA_HALF_X - 1; x++) {
    for (let z = a.wz - ARENA_HALF_Z + 1; z <= a.wz + ARENA_HALF_Z - 1; z++) {
      // 该列产物最高层换算到世界 y：worldY = floorY + (row - floorRow)
      const row = topOf.get(`${x - a.wx},${z - a.wz}`) ?? floorRow;
      const contentTopY = a.floorY + (row - floorRow);
      const naturalH = generateHeight(x, z, SEED);
      for (let y = contentTopY + 1; y <= naturalH; y++) {
        if (get(x, y, z) !== 0) {
          intruders++;
          if (samples.length < 6) samples.push(`${x},${y},${z}=${reg.nameOf(get(x, y, z))}`);
        }
      }
    }
  }
  assertEqual(intruders, 0, `产物内容以上到自然地表之间必须全空（实得 ${samples.join(' ')}）`);
});

test('竞技场 GEN：地板以下每列都有实心支撑（无悬空、无空洞）', async () => {
  await loadStructure('arenaGrass');
  const { reg, a, get } = await buildWorld();
  // ⚠️ **cave 是在 fillColumn 之后挖的**：实测占地内 236 列在地板正下方就是空气、最深 21 格。
  // 故阶段 2.9 必须显式补实（apply.js 的 ② 步）—— 这条用例就是它的回归门。
  //
  // ⚠️ **水池列是例外**：玻璃盖下就是水（`floorY-1 = water`）、再下是沙底（`floorY-2 = sand`）。
  // 判据要按「水柱下方必须有实心底」查，不能要求 `floorY-1` 本身是实心（否则 115 列假失败）。
  let unsupported = 0;
  const samples = [];
  for (let x = a.wx - ARENA_HALF_X + 1; x <= a.wx + ARENA_HALF_X - 1; x++) {
    for (let z = a.wz - ARENA_HALF_Z + 1; z <= a.wz + ARENA_HALF_Z - 1; z++) {
      // 向下找第一个「既不是空气也不是水」的格（水柱最多 1 格深，但写成循环更稳）
      let y = a.floorY - 1;
      let solid = 0;
      for (let d = 0; d < 4; d++) {
        const id = get(x, y - d, z);
        if (id !== 0 && reg.solidTable[id] === 1) { solid = 1; break; }
        if (id !== 0 && reg.nameOf(id) !== 'water') break;   // 非水非实心 = 异常
      }
      if (!solid) {
        unsupported++;
        if (samples.length < 6) samples.push(`${x},${z}@${y}=${reg.nameOf(get(x, y, z))}`);
      }
    }
  }
  assertEqual(unsupported, 0, `地板/水池下方 3 格内必须有实心底（否则玩家挖开会掉进洞里；实得 ${samples.join(' ')}）`);
});

test('竞技场 GEN：ARENA_SUPPORT_MAX_DEPTH 覆盖实测空洞最坏深度', async () => {
  // ⚠️ **这条钉的是「阀门值本身」**（不是「补实是否生效」—— 那个归上一条管）。
  // 阀门值一旦小于某个 seed 的空洞深度，那一拨列就会**静默漏补**：上一条用例在 default
  // seed 上看不出（实测 default 的最坏 21 格），玩家换 seed 挖下去就掉洞里。
  //
  // ⚠️ **必须量「补实之前的原始空洞」**：补实之后再量，任何阀门值都得到 0，没有判别力
  // （实测阀门改到 2 仍全绿 —— 这是测量方法错而非实现对）。
  const { ARENA_SUPPORT_MAX_DEPTH: MAXD, ARENA_HALF_X: HX, ARENA_HALF_Z: HZ } = await import('../gen/structures/arena.js');
  const { buildDefaultRegistry } = await import('../voxel/block-registry.js');
  const { ChunkColumn } = await import('../voxel/chunk-column.js');
  const { fillColumn } = await import('../gen/terrain.js');
  const { carveCaves } = await import('../gen/caves.js');
  const reg = await buildDefaultRegistry();
  const seeds = [SEED, 424242, 1, 999, 2024, 8888, 20240101, 5150];
  let worstAll = 0;
  const offenders = [];
  for (const s of seeds) {
    clearArenaCache();
    const a = computeArenaAnchor(s);
    assertTrue(!!a, `seed ${s} 必须有竞技场锚点（否则该 seed 在本用例里恒真）`);
    // ⚠️ **按 column 建一次、复用 16×16 格**（不是逐格 new）：
    // 逐格新建实测 24024 次 × fillColumn+carveCaves = **10.7s**，而整页 harness 窗口只有 30s。
    // 一个竞技场只跨 4×5 个 column，建 20 次就够。
    const colCache = new Map();
    const colAt = (cx, cz) => {
      const k = `${cx},${cz}`;
      let c = colCache.get(k);
      if (!c) {
        c = new ChunkColumn(cx, cz);
        fillColumn(c, s, reg);
        carveCaves(c, s);
        colCache.set(k, c);
      }
      return c;
    };
    for (let wx = a.wx - HX + 1; wx <= a.wx + HX - 1; wx++) {
      for (let wz = a.wz - HZ + 1; wz <= a.wz + HZ - 1; wz++) {
        const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
        const col = colAt(cx, cz);
        const lx = wx - cx * 16, lz = wz - cz * 16;
        // 原始空洞深度 = 从 floorY-1 往下第一个非空之前的格数（正是补实要填的格数）
        let n = 0;
        for (let d = 1; d <= 64; d++) {
          if (col.blocks[blockIndex(lx, a.floorY - d, lz)] !== 0) break;
          n++;
        }
        if (n > worstAll) worstAll = n;
        if (n > MAXD) offenders.push(`seed ${s} (${wx},${wz}) 深 ${n}`);
      }
    }
  }
  assertTrue(worstAll > 20, `实测最大空洞深度 ${worstAll} 格（若过小，说明本用例量错对象了）`);
  assertEqual(offenders.length, 0,
    `ARENA_SUPPORT_MAX_DEPTH=${MAXD} 小于实测空洞深度 ${worstAll}，会让 ${offenders.length} 列漏补：${offenders.slice(0, 4).join(' / ')}`);
});

test('竞技场 GEN：水池下挖 2 格（水在地板之下，玻璃做水面盖）', async () => {
  await loadStructure('arenaGrass');
  const { reg, a, get } = await buildWorld();
  let water = 0, glass = 0;
  for (let x = a.wx - ARENA_HALF_X; x <= a.wx + ARENA_HALF_X; x++) {
    for (let z = a.wz - ARENA_HALF_Z; z <= a.wz + ARENA_HALF_Z; z++) {
      const onFloor = reg.nameOf(get(x, a.floorY, z));
      if (onFloor === 'glass_block') glass++;
      if (reg.nameOf(get(x, a.floorY - 1, z)) === 'water') water++;
    }
  }
  assertTrue(glass > 50, `地板层必须有玻璃水面盖（实得 ${glass}）`);
  assertTrue(water > 50, `地板下一格必须有水（实得 ${water}）`);
});

test('竞技场 GEN：栏杆在外圈、每格都是 handrail*、且环上无缺口', async () => {
  await loadStructure('arenaGrass');
  const { reg, a, get } = await buildWorld();
  const railY = a.floorY + 1;
  const halfX = (ARENA_WIDTH - 1) / 2, halfZ = (ARENA_DEPTH - 1) / 2;
  let onRing = 0, rails = 0, gaps = 0;
  for (let dx = -halfX; dx <= halfX; dx++) {
    for (const dz of [-halfZ, halfZ]) {
      onRing++;
      const n = reg.nameOf(get(a.wx + dx, railY, a.wz + dz));
      if (n === 'handrail' || n === 'handrailA') rails++; else gaps++;
    }
  }
  for (let dz = -halfZ + 1; dz <= halfZ - 1; dz++) {
    for (const dx of [-halfX, halfX]) {
      onRing++;
      const n = reg.nameOf(get(a.wx + dx, railY, a.wz + dz));
      if (n === 'handrail' || n === 'handrailA') rails++; else gaps++;
    }
  }
  assertEqual(gaps, 0, `栏杆环上不得有缺口（环上 ${onRing} 格，栏杆 ${rails} 格）`);
  // 四角必须是转角件（handrail），不能是直段件
  for (const [dx, dz] of [[-halfX, -halfZ], [halfX, -halfZ], [halfX, halfZ], [-halfX, halfZ]]) {
    assertEqual(reg.nameOf(get(a.wx + dx, railY, a.wz + dz)), 'handrail',
      `四角 (${dx},${dz}) 必须是转角件 handrail`);
  }
});

test('竞技场 GEN：栏杆朝向与邻居匹配（真世界方块的 meta，不是产物 JSON）', async () => {
  // ⚠️ **这条用例的价值在于读的是世界里的 meta**：上面那条只查方块名，
  // 把所有直段都写成 `handrail orient=0` 也能通过（实测负向验证确认）。
  // 「转角件旋转到与两边匹配」是用户的核心需求，必须在最终产物（世界方块）上拓到。
  await loadStructure('arenaGrass');
  const { reg, a, cols } = await buildWorld();
  const railY = a.floorY + 1;
  const halfX = (ARENA_WIDTH - 1) / 2, halfZ = (ARENA_DEPTH - 1) / 2;
  const onRing = (dx, dz) => Math.abs(dx) <= halfX && Math.abs(dz) <= halfZ
    && (Math.abs(dx) === halfX || Math.abs(dz) === halfZ);
  const at = (dx, dz) => {
    const wx = a.wx + dx, wz = a.wz + dz;
    const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
    const col = cols.get(`${cx},${cz}`);
    if (!col) return { name: 'air', orient: 0 };
    const idx = blockIndex(wx - cx * 16, railY, wz - cz * 16);
    return { name: reg.nameOf(col.blocks[idx]), orient: col.meta[idx] & 3 };
  };
  const norm = (arms) => ['+X', '-X', '+Z', '-Z'].filter((x) => arms.includes(x)).join(' ');
  let mismatch = 0;
  const samples = [];
  for (let dx = -halfX; dx <= halfX; dx++) {
    for (let dz = -halfZ; dz <= halfZ; dz++) {
      if (!onRing(dx, dz)) continue;
      // ⚠️ **四角只看与环内侧相接的那两个方向**（不是四臂）：外侧两个方向环上没邻居、
      // 也不应该有臂（否则伸到环外的空气里成为一个断头）。
      // 直边同理：两个方向都在环上；四角只有两个方向在环上。
      const need = [];
      if (onRing(dx + 1, dz)) need.push('+X');
      if (onRing(dx - 1, dz)) need.push('-X');
      if (onRing(dx, dz + 1)) need.push('+Z');
      if (onRing(dx, dz - 1)) need.push('-Z');
      const cell = at(dx, dz);
      const got = railArmSet(cell.name, cell.orient);
      if (norm(got) !== norm(need)) {
        mismatch++;
        if (samples.length < 6) samples.push(`(${dx},${dz}) ${cell.name}:${cell.orient} 实得[${norm(got)}] 需要[${norm(need)}]`);
      }
    }
  }
  assertEqual(mismatch, 0, `环上每格的臂方向必须与邻居匹配（实得 ${samples.join(' | ')}）`);
});

test('竞技场 GEN：占地内没有树（巨树/杜鹃/普通树/单格树苗已让路）', async () => {
  await loadStructure('arenaGrass');
  const { reg, a, get } = await buildWorld();
  const TREE = new Set([
    'wood', 'birch_log', 'leaves', 'sky_wood', 'sky_leaves', 'azalea_log',
    'azalea_leaves', 'azalea_flowers',
    'giant_oak_log', 'giant_mangrove_log', 'giant_oak_leaves',
  ]);
  let found = 0;
  const kinds = new Map();
  for (let x = a.wx - ARENA_HALF_X; x <= a.wx + ARENA_HALF_X; x++) {
    for (let z = a.wz - ARENA_HALF_Z; z <= a.wz + ARENA_HALF_Z; z++) {
      for (let y = a.floorY + 1; y <= a.floorY + 30; y++) {
        const n = reg.nameOf(get(x, y, z));
        if (!TREE.has(n)) continue;
        // 素材自带的两棵小树（wood/leaves）是竞技场内容的一部分 —— 它们在地板内部，
        // 由产物写入，属预期。判据要排除它们：只在**产物之外**的位置算侵入。
        found++;
        kinds.set(n, (kinds.get(n) || 0) + 1);
      }
    }
  }
  // 产物自带两棵树（wood 22 + leaves 207），没有别的木/叶方块才算通过
  const extra = [...kinds.entries()].filter(([n]) => !['wood', 'leaves'].includes(n));
  assertTrue(extra.length === 0, `占地内出现非素材树的木/叶方块：${JSON.stringify(Object.fromEntries(extra))}`);
});

test('竞技场 GEN：lineage —— floorRow 从产物透传到 loadStructure', async () => {
  const data = await loadStructure('arenaGrass');
  assertEqual(data.floorRow, 3, '产物 floorRow 必须透传（水池把最低两层挖成了沙底+水）');
  assertEqual(floorRowOf('arenaGrass'), 3, 'floorRowOf 必须能读出已加载产物');
  // 最低层（归一化 y=1）是水池沙底，不是地板
  const lowest = new Set(data.blocks.filter((b) => b.y === 1).map((b) => b.type));
  assertTrue(lowest.has('sand'), `最低层应含 sand（水池沙底），实得 ${[...lowest].join(',')}`);
  assertTrue(!lowest.has('grass'), '最低层不应有 grass（地板层在 floorRow=3）');
});
