// src/tests/test-rain-shelter-map.js — 逐列遮挡高度图（Tier 1）
//
// 钉的是 spec §4.2/§4.4/§4.4b 的**不可自行决定项**：
//   编码公式与哨兵、绝对 texel 索引、平移清零条带位置、8 column/帧预算、3×3 预热。
// ⚠️ 期望值全部**手工推导或用既有权威函数对照**，不用被测代码算期望（否则恒真）。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';
import { WORLD_MIN_Y, SEA_Y, WATER_SURFACE_SINK, blockIndex } from '../voxel/constants.js';
import { fillColumn } from '../gen/terrain.js';
import { RAIN_CEILING_Y, rainStopY } from '../render/rain-shelter.js';
import { WATER_SURFACE_Y, waterSurfaceYAt } from '../render/water-surface.js';
import {
  SHELTER_MAP_SIZE, SHELTER_EPS, SHELTER_Y_BASE, SHELTER_WINDOW_COLS,
  encodeStopY, decodeStopY, shelterTexelIndex,
} from '../voxel/rain-occlusion-data.js';
import { RainShelterMap } from '../render/rain-shelter-map.js';

const SEED = 12345;
const REG = createRegistry();
for (const def of BLOCKS) REG.register(def.name, def);
REG.freeze();
const id = (n) => REG.idOf(n);

/** 真实地形世界：cols×cols 个 column，从 (cx0,cz0) 起 */
function terrainWorld(cols = 4, cx0 = 0, cz0 = 0) {
  const world = new WorldData(REG);
  for (let a = 0; a < cols; a++) {
    for (let b = 0; b < cols; b++) {
      const col = new ChunkColumn(cx0 + a, cz0 + b);
      fillColumn(col, SEED, REG);
      col.state = 'ready';        // fillColumn 不置 state（照 test-terrain.js 口径）
      world.add(col);
    }
  }
  return world;
}

/** 手工造世界：cells = Map<'x,y,z', name>，只建覆盖到的 column */
function cellsWorld(cells) {
  const world = new WorldData(REG);
  const cols = new Map();
  for (const [key, name] of cells) {
    const [x, y, z] = key.split(',').map(Number);
    const cx = Math.floor(x / 16); const cz = Math.floor(z / 16);
    const ck = `${cx},${cz}`;
    if (!cols.has(ck)) {
      const col = new ChunkColumn(cx, cz);
      col.state = 'ready';
      cols.set(ck, col); world.add(col);
    }
    const col = cols.get(ck);
    col.blocks[blockIndex(x - cx * 16, y, z - cz * 16)] = id(name);
  }
  return world;
}
const key = (x, y, z) => `${x},${y},${z}`;

// ---------- 编码（spec §4.2）----------

test('shelter map: 编码往返（含半格水面与负 y），0 是哨兵不是世界底', () => {
  for (const y of [WORLD_MIN_Y + 1, WORLD_MIN_Y + 1.5, 0, 0.5, RAIN_CEILING_Y + 1]) {
    assertEqual(decodeStopY(encodeStopY(y)), y, `y=${y} 往返不符`);
  }
  assertEqual(encodeStopY(null), 0);
  assertEqual(decodeStopY(0), null);
  // 手工核对：Y_BASE = WORLD_MIN_Y - 1 = -33 ⇒ stopY=0 编码 = (0-(-33))*2 = 66（不是 0）
  assertEqual(SHELTER_Y_BASE, WORLD_MIN_Y - 1);
  assertEqual(encodeStopY(0), 66, 'stopY=0 不得编成哨兵 0');
});

test('shelter map: 编码值域上界远未溢出 255（关系式，不写死 136）', () => {
  const top = encodeStopY(RAIN_CEILING_Y + 1);
  assertTrue(top <= 255, `最高可扫值编码 ${top} 溢出`);
  assertTrue(top >= 4, `最低可扫值编码应 >= 4，实际 ${encodeStopY(WORLD_MIN_Y + 1)}`);
  assertEqual(encodeStopY(WORLD_MIN_Y + 1), 4);
});

test('shelter map: f32 往返后格顶判据在共面/真下方边界不翻判', () => {
  const f = new Float32Array(1);
  const top = encodeStopY(RAIN_CEILING_Y + 1);
  let n = 0;
  for (let e = 4; e <= top; e++) {
    f[0] = e / 255;
    const stop = f[0] * 255 / 2 + SHELTER_Y_BASE;   // GPU 解码式
    // ① 探针在截停面**下方一格的内部**（屋内地板那种）⇒ 必判遮挡
    // ⚠️ 不得用 stop-0.5：那恰好是「截停面所在格的格顶」，cellTop == stop
            // ⇒ 精确算术下也判不遮挡（本轮实测：旧写法在 e=4 就红，与被测代码无关）。
    const below = stop - 1.5;
    assertTrue(stop > Math.floor(below) + 1 + SHELTER_EPS,
      `e=${e} 真下方应判遮挡，stop=${stop} probe=${below}`);
    // ② 探针恰在格顶（半砖露天顶面那种）⇒ 必须判**不**遮挡
    const coplanar = stop;
    assertTrue(!(stop > Math.floor(coplanar) + 1 + SHELTER_EPS),
      `e=${e} 探针共面应判不遮挡，stop=${stop}`);
    n++;
  }
  assertTrue(n >= 130, `合法编码应 >= 130 个，实际 ${n}`);
});

// ---------- 单遍扫描 ≡ 既有 rainStopY（spec §2.5）----------

test('shelter map: 单遍首命中 ≡ 既有 rainStopY（真实地形 ≥2000 格列）', () => {
  // ⚠️ 这条钉的是「单遍首命中 ≡ 两遍取 max」这个**合成关系**，
  // 两侧共用 blocksRain ⇒ 对挡雨判据本身零判别力（那是下一条的职责）。
  const world = terrainWorld(4);
  const map = new RainShelterMap({ world, registry: REG });
  map.setCenter(32, 32);
  while (map.tick(64) > 0) { /* 扫满 */ }
  let n = 0;
  for (let x = 0; x < 64; x++) {
    for (let z = 0; z < 64; z++) {
      const got = map.stopAt(x + 0.5, z + 0.5);
      const want = rainStopY(world, REG, x + 0.5, z + 0.5, RAIN_CEILING_Y, 128);
      assertEqual(got, want, `(${x},${z}) 单遍扫描与既有 rainStopY 不符`);
      n++;
    }
  }
  assertTrue(n >= 2000, `采样点应 >= 2000，实际 ${n}`);
});

test('shelter map: 屋顶下的格列 stop = 屋顶顶面（不是地板）', () => {
  // spec §2.2 缺陷的判别力锚点：从滴自己的 y 往下扫只会撞到地板。
  const cells = new Map([[key(4, 0, 4), 'stone'], [key(4, 9, 4), 'stone_bricks']]);
  const map = new RainShelterMap({ world: cellsWorld(cells), registry: REG });
  map.setCenter(4, 4); map.warmup(4, 4);
  assertEqual(map.stopAt(4.5, 4.5), 10, '必须停在屋顶顶面 10，而不是地板顶面 1');
});

test('shelter map: 台阶棚子同样挡雨（Task 1 判据的端到端消费）', () => {
  const cells = new Map([[key(4, 0, 4), 'stone'], [key(4, 9, 4), 'planks_step']]);
  const map = new RainShelterMap({ world: cellsWorld(cells), registry: REG });
  map.setCenter(4, 4); map.warmup(4, 4);
  assertEqual(map.stopAt(4.5, 4.5), 10, '木台阶棚子必须挡雨（旧口径漏判）');
});

test('shelter map: 水体列 waterAt 为真且 stop = 水面', () => {
  const cells = new Map();
  cells.set(key(4, -8, 4), 'sand');
  for (let y = -7; y <= SEA_Y; y++) cells.set(key(4, y, 4), 'water');
  const map = new RainShelterMap({ world: cellsWorld(cells), registry: REG });
  map.setCenter(4, 4); map.warmup(4, 4);
  assertTrue(map.waterAt(4.5, 4.5), '暴露水面列 waterAt 应为真');
  assertEqual(map.stopAt(4.5, 4.5), WATER_SURFACE_Y);
  assertEqual(WATER_SURFACE_Y, SEA_Y + 1 - WATER_SURFACE_SINK);
});

test('shelter map: 屋顶盖住的水面 ⇒ waterAt 假，且 stop 严格高于该列水面（不可达论证）', () => {
  // spec §4.7：单遍遇屋顶即停 ⇒ hasWater=0。必须证明这不会漏「水下且可见」的雨丝。
  const cells = new Map();
  cells.set(key(4, -8, 4), 'sand');
  for (let y = -7; y <= SEA_Y; y++) cells.set(key(4, y, 4), 'water');
  cells.set(key(4, 12, 4), 'stone_bricks');
  const world = cellsWorld(cells);
  const map = new RainShelterMap({ world, registry: REG });
  map.setCenter(4, 4); map.warmup(4, 4);
  assertEqual(map.waterAt(4.5, 4.5), false, '屋顶盖住水 ⇒ 语义有意收窄');
  assertEqual(map.stopAt(4.5, 4.5), 13);
  // ⚠️ 必须用**该列自己的**水面，不得用全局 WATER_SURFACE_Y（spec §4.7 的测量错误）
  const colWater = waterSurfaceYAt(world, REG, 4.5, 4.5, RAIN_CEILING_Y, 128);
  assertTrue(map.stopAt(4.5, 4.5) > colWater,
    'stop 必须高于该列水面 ⇒ 不存在「水下且 aShelter=0」的区间');
});

// ---------- 失效与预算（spec §4.4）----------

test('shelter map: version 变化 ⇒ 该列重扫（改屋顶高度后 stop 跟着变）', () => {
  const cells = new Map([[key(4, 9, 4), 'stone_bricks']]);
  const world = cellsWorld(cells);
  const map = new RainShelterMap({ world, registry: REG });
  map.setCenter(4, 4); map.warmup(4, 4);
  assertEqual(map.stopAt(4.5, 4.5), 10);
  const col = world.getColumn(0, 0);
  col.blocks[blockIndex(4, 9, 4)] = 0;
  col.blocks[blockIndex(4, 15, 4)] = id('stone_bricks');
  col.version++;
  assertTrue(map.tick(8) > 0, 'version 变了必须重扫');
  assertEqual(map.stopAt(4.5, 4.5), 16, '重扫后应停在新的屋顶顶面');
});

test('shelter map: invalidateColumn 插队首（编辑当帧跟随，不等轮到）', () => {
  const world = terrainWorld(4);
  const map = new RainShelterMap({ world, registry: REG });
  map.setCenter(32, 32);
  // 先把近处 column 扫掉，让队列里只剩远处
  map.warmup(32, 32);
  map.invalidateColumn(2, 2);
  map.tick(1);
  assertTrue(map.debugState().scanned.has('2,2'), 'invalidate 的列必须被下一次 tick(1) 扫到');
});

test('shelter map: 每帧预算 8 column；tick(0) 不扫', () => {
  const world = terrainWorld(8);       // 64 column，远超预算
  const map = new RainShelterMap({ world, registry: REG });
  map.setCenter(64, 64);
  assertEqual(map.tick(), 8, '默认预算必须是 8 个 column');
  assertEqual(map.tick(0), 0, 'tick(0) 不得扫');
});

test('shelter map: 未知/窗外一律安全失败（null / false）', () => {
  const world = terrainWorld(2);
  const map = new RainShelterMap({ world, registry: REG });
  map.setCenter(8, 8);
  assertEqual(map.stopAt(8.5, 8.5), null, '从未扫过 ⇒ null');
  assertEqual(map.waterAt(8.5, 8.5), false);
  // 窗外（>256 格）即使纹理里有别列的数据也必须返回未知
  map.warmup(8, 8);
  assertEqual(map.stopAt(8.5 + 512, 8.5), null, '窗外坐标不得 wrap 读到别列');
});

// ---------- 绝对索引与窗口平移（spec §4.4，P0-4）----------

test('shelter map: 绝对 texel 索引（负坐标补码，且原点平移后不变）', () => {
  // 手工推导：-1 & 511 = 511 ⇒ idx = 511 + (511<<9) = 262143
  assertEqual(shelterTexelIndex(-1, -1), 511 + (511 << 9));
  assertEqual(shelterTexelIndex(-1, -1), 262143);
  assertEqual(shelterTexelIndex(0, 0), 0);
  assertEqual(shelterTexelIndex(512, 512), 0, '模 512 环形');
  // 相对索引会在这里 FAIL：原点一动同一绝对坐标的 texel 就变了
  const before = shelterTexelIndex(100.5, 200.5);
  const world = terrainWorld(4);
  const map = new RainShelterMap({ world, registry: REG });
  map.setCenter(0, 0); map.setCenter(16, 16);
  assertEqual(shelterTexelIndex(100.5, 200.5), before,
    '绝对索引不得依赖窗口原点');
  assertEqual(SHELTER_WINDOW_COLS, SHELTER_MAP_SIZE / 16);
});

test('shelter map: 平移清零条带 = (originOLD & 511)..+15（不是固定[0,15]、也不是+16）', () => {
  for (const ox of [0, 16, 496, 1008, -32]) {
    const world = terrainWorld(4);
    const map = new RainShelterMap({ world, registry: REG });
    const oxAligned = ox - (((ox % 16) + 16) % 16);
    map.setCenter(oxAligned + 8, 8);
    while (map.tick(64) > 0) { /* 扫满，让 data 非零 */ }
    // 记录平移前每个 texel 的 R
    const before = Uint8Array.from(map.data);
    map.setCenter(oxAligned + 8 + 16, 8);      // 原点 +16
    const start = ((map.originX - 16) & (SHELTER_MAP_SIZE - 1));
    let clearedOther = 0; let missed = 0;
    for (let tz = 0; tz < SHELTER_MAP_SIZE; tz++) {
      for (let tx = 0; tx < SHELTER_MAP_SIZE; tx++) {
        const inBand = ((tx - start) & (SHELTER_MAP_SIZE - 1)) < 16;
        const i = (tx + (tz << 9)) * 4;
        if (inBand) {
          if (map.data[i] !== 0) missed++;
        } else if (map.data[i] !== before[i]) clearedOther++;
      }
    }
    assertEqual(missed, 0, `originX_OLD=${oxAligned}: 条带内有未清零的 texel`);
    assertEqual(clearedOther, 0, `originX_OLD=${oxAligned}: 条带外的 texel 被误清`);
  }
});

test('shelter map: 窗口平移后离开窗口的格列必变未知（不得读到旧高度）', () => {
  // 造一条沿 x 足够长的地形（column x ∈ [15,19) ⇒ 格 x ∈ [240,304)）
  const world = terrainWorld(4, 15, 0);
  const map = new RainShelterMap({ world, registry: REG });
  map.setCenter(8, 8);                       // 窗口 [-256, 256) ⇒ 含 x=240..255
  while (map.tick(64) > 0) { /* 扫满 */ }
  assertTrue(map.stopAt(250.5, 8.5) !== null, '平移前该列应已扫到');
  map.setCenter(8 + 16, 8);                  // 窗口右移 16 ⇒ [-240,272)，x=250 仍在窗内
  assertTrue(map.stopAt(250.5, 8.5) !== null, '仍在窗内的列不得被误清');
  map.setCenter(8 - 512, 8);                 // 窗口左移 512 ⇒ x=250 离开窗口
  assertEqual(map.stopAt(250.5, 8.5), null, '离开窗口的列必须变未知');
  assertEqual(map.waterAt(250.5, 8.5), false);
});

test('shelter map: 预热扫玩家周围 3×3 = 9 column（不是 8）', () => {
  const world = terrainWorld(6);
  const map = new RainShelterMap({ world, registry: REG });
  map.setCenter(40, 40);
  assertEqual(map.warmup(40, 40), 9, '预热必须覆盖 3×3 column');
  const st = map.debugState();
  for (let a = -1; a <= 1; a++) {
    for (let b = -1; b <= 1; b++) {
      assertTrue(st.scanned.has(`${2 + a},${2 + b}`), `column(${2 + a},${2 + b}) 未预热`);
    }
  }
});

test('shelter map: 静止世界零成本（扫满后 tick 返回 0）', () => {
  const world = terrainWorld(3);
  const map = new RainShelterMap({ world, registry: REG });
  map.setCenter(24, 24);
  while (map.tick(64) > 0) { /* 扫满 */ }
  assertEqual(map.tick(), 0, '静止世界不得重复扫描/上传');
  assertEqual(map.tick(), 0);
});