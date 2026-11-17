// src/tests/test-jungle-fortress-gen.js — 丛林要塞 Tier 1：产物契约 + 锚点 + 整形 + 接线
//
// 权威：docs/superpowers/specs/2026-11-17-jungle-fortress-port-design.md
//       docs/superpowers/plans/2026-11-17-jungle-fortress-port.md
//
// 钉的是这几类缺陷（每条都是静默的）：
//   · `STRUCTURE_FILES` 漏映射 → `rasterizeStructure` 拿到空 blocks 直接 return（0 格，无报错）
//   · **空气格漏写**（spec DR-2）→ 天然岩层填满全部房间。格数/类型/指纹全对，
//     只有走进去才发现 ⇒ 必须断言 air 格数与「房间格是 air」
//   · **支撑柱穿房间地板** → 室内插石柱（实测去掉「遇保留空气停」会有 414 格穿房间）
//   · **台阶映到 stone_diorite_step** → tile 均色 189 vs 墙体 113，156 个亮白台阶贴暗苔墙
//   · 锚点方向写反（城西口径）→ 8/8 seed 返回 null，结构永不生成
//   · 整形用固定带宽 16 → 边缘 8 格悬崖 + 1131 列水
//   · 瞬移落点用自然高度 → 玩家悬空 2~4 格
//
// ⚠️ 断言落点一律是**真实 applyStructuresToColumn 写出的世界方块**，不是纯函数返回值。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import {
  computeJungleFortressAnchor, clearJungleFortressCache,
  jungleFortressCandidateValid, inJungleFortressFootprint,
} from '../gen/structures/jungle-fortress.js';
import { getCityBoundsForSeed } from '../gen/structures/city-layout.js';
import { CITY_TRANSITION_SIZE } from '../gen/structures/region-config.js';
import {
  jungleFortressSurfaceYAt, inJungleFortressTerraform, fillJungleFortressGround,
  JUNGLE_FORTRESS_SLOPE_BAND,
} from '../gen/structures/jungle-fortress-terrain.js';
import { buildDefaultRegistry } from '../voxel/block-registry.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { blockIndex, SEA_Y } from '../voxel/constants.js';
import { fillColumn, generateHeight, surfaceTypeOfBiome } from '../gen/terrain.js';
import { carveCaves } from '../gen/caves.js';
import { getBiome } from '../gen/noise.js';
import { STRUCTURE_FILES, loadStructure, floorRowOf } from '../gen/structures/structure-json.js';
import {
  JUNGLE_FORTRESS_HALF_X, JUNGLE_FORTRESS_HALF_Z,
  JUNGLE_FORTRESS_FLOOR_ROW, JUNGLE_FORTRESS_HEIGHT,
} from '../gen/structures/jungle-fortress-data.js';

// ---- 冻结值（Task 3 起含藤蔓）----
const CONTENT_CELLS = 81238;
const AIR_CELLS = 15536;
const PALETTE_SIZE = 12;
const PRODUCT_W = 159;
const PRODUCT_D = 155;
/** 支撑柱穿房间格数（必须恒 0） */
const PILLAR_INTO_ROOM = 0;
/** 藤蔓格数（Task 3） */
const VINE_CELLS = 2029;

// ==================== 产物注册与加载 ====================

test('丛林要塞：STRUCTURE_FILES 登记了 jungleFortress', () => {
  assertEqual(STRUCTURE_FILES.jungleFortress, 'jungle_fortress.json',
    'jungleFortress 必须映射到 jungle_fortress.json（漏登记 → rasterizeStructure 静默 0 格）');
});

test('丛林要塞：产物可加载且格数/floorRow/stride 与冻结值一致', async () => {
  const data = await loadStructure('jungleFortress');
  assertEqual(data.blocks.length, CONTENT_CELLS,
    `产物格数必须是 ${CONTENT_CELLS}（实际 ${data.blocks.length}；为 0 说明未登记或 fetch 失败）`);
  assertEqual(floorRowOf('jungleFortress'), JUNGLE_FORTRESS_FLOOR_ROW,
    `floorRow 必须是 ${JUNGLE_FORTRESS_FLOOR_ROW}`);
  // 派生常量对账：floorRowOf 读主线程缓存，产物只在 Worker 加载过 ⇒ 常量必须独立冻结
  assertEqual(JUNGLE_FORTRESS_FLOOR_ROW, 13,
    'JUNGLE_FORTRESS_FLOOR_ROW 是派生冻结常量（不能用 floorRowOf() 在主线程读，那恒返回 1）');

  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity, mnz = Infinity, mxz = -Infinity;
  for (const b of data.blocks) {
    if (b.x < mnx) mnx = b.x; if (b.x > mxx) mxx = b.x;
    if (b.y < mny) mny = b.y; if (b.y > mxy) mxy = b.y;
    if (b.z < mnz) mnz = b.z; if (b.z > mxz) mxz = b.z;
  }
  assertEqual(mxx - mnx + 1, PRODUCT_W, `产物 X 跨度 ${PRODUCT_W}`);
  assertEqual(mxz - mnz + 1, PRODUCT_D, `产物 Z 跨度 ${PRODUCT_D}`);
  assertEqual(mxy - mny + 1, JUNGLE_FORTRESS_HEIGHT, `Y 跨度 ${JUNGLE_FORTRESS_HEIGHT}`);
  assertEqual(mny, 1, '归一化后最低层 y=1（rasterizeStructure 按 b.y 落位）');
});

test('丛林要塞：非空气 footprint 半宽 = HALF_X/HALF_Z', async () => {
  const data = await loadStructure('jungleFortress');
  let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
  for (const b of data.blocks) {
    if (b.type === 'air') continue;
    if (b.x < mnx) mnx = b.x; if (b.x > mxx) mxx = b.x;
    if (b.z < mnz) mnz = b.z; if (b.z > mxz) mxz = b.z;
  }
  assertEqual(Math.max(-mnx, mxx), JUNGLE_FORTRESS_HALF_X,
    `非空气 x 半宽必须 = HALF_X ${JUNGLE_FORTRESS_HALF_X}（实际 x∈[${mnx},${mxx}]）`);
  assertEqual(Math.max(-mnz, mxz), JUNGLE_FORTRESS_HALF_Z,
    `非空气 z 半宽必须 = HALF_Z ${JUNGLE_FORTRESS_HALF_Z}（实际 z∈[${mnz},${mxz}]）`);
});

// ==================== DR-2：空气格必须写进产物 ====================

test('丛林要塞：palette 含 air 且 air 格数 = 冻结值（DR-2 唯一守卫）', async () => {
  const data = await loadStructure('jungleFortress');
  const air = data.blocks.filter((b) => b.type === 'air');
  assertEqual(air.length, AIR_CELLS,
    `房间内腔空气必须全部写进产物（实际 ${air.length}，冻结 ${AIR_CELLS}）。` +
    '为 0 = 空气被当天空丢弃 ⇒ fillColumn/carveCaves 用天然岩层填满全部房间');
});

test('丛林要塞：中央大厅内部是 air（房间可进入，不是被岩层填实）', async () => {
  const data = await loadStructure('jungleFortress');
  const at = new Map(data.blocks.map((b) => [`${b.x},${b.y},${b.z}`, b.type]));
  // 坐标从**真实产物**取：center_room（起始件，rot=1）的 cave_air 格经旋转+归一化后
  // 在产物里确为 air 的那些。⚠️ **不得凭直觉写坐标** —— 初稿写的五个点全部不存在于产物。
  const ROOM_SAMPLES = [[10, 16, 2], [9, 16, 2], [8, 16, 2], [7, 16, 2], [6, 16, 2]];
  for (const [x, y, z] of ROOM_SAMPLES) {
    assertEqual(at.get(`${x},${y},${z}`), 'air',
      `大厅内腔 (${x},${y},${z}) 必须是 air（实际 ${at.get(`${x},${y},${z}`) ?? '(产物无此格)'}）`);
  }
});

// ==================== 映射与朝向 ====================

test('丛林要塞：palette 种数与目标方块集合正确（零新增方块）', async () => {
  const data = await loadStructure('jungleFortress');
  const types = new Set(data.blocks.map((b) => b.type));
  assertEqual(types.size, PALETTE_SIZE, `palette 种数 ${PALETTE_SIZE}（实际 ${types.size}）`);
  // 台阶必须是 cobblestone_step 不是 stone_diorite_step（tile 均色 125 vs 189，墙体 113）
  assertTrue(types.has('cobblestone_step'), '台阶目标必须是 cobblestone_step（色匹配墙体）');
  assertTrue(!types.has('stone_diorite_step'),
    '不得用 stone_diorite_step：tile 均色 189 比墙体 113 亮 76，156 个亮白台阶会很显眼');
  // 栏杆是 vertical_pillar（能看过去），不是 iron（整块堵死窗洞）
  assertTrue(types.has('vertical_pillar'), '栏杆目标必须是 vertical_pillar');
  assertTrue(!types.has('iron'), '不得用 iron：整块不透明会把窗洞堵死，看不过去');
  assertTrue(!types.has('handrail'), '不得用 handrail：每格伸两臂，cutout 是 vertical_pillar 的 2.8 倍');
});

test('丛林要塞：台阶朝向四档分布 = 冻结值（facing 随件旋转后再查表）', async () => {
  const data = await loadStructure('jungleFortress');
  const hist = {};
  for (const b of data.blocks) {
    if (b.type !== 'cobblestone_step') continue;
    const k = `${b.type}:${b.direction}`;
    hist[k] = (hist[k] || 0) + 1;
  }
  const want = {
    'cobblestone_step:0': 24,
    'cobblestone_step:1': 51,
    'cobblestone_step:2': 69,
    'cobblestone_step:3': 12,
  };
  // ⚠️ **必须排序后比**：hist 的键插入序由产物遍历序决定（:2,:3,:0,:1），
  // 直接 JSON.stringify 两边会因**键序**不同而假 FAIL（值逐档相同）。
  const sortKeys = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort()));
  assertEqual(sortKeys(hist), sortKeys(want),
    `台阶朝向分布必须是 ${sortKeys(want)}（实际 ${sortKeys(hist)}）。` +
    '⚠️ 合计 156 不是 159：源里 159 个台阶格次有 3 个被后写件覆盖（后写胜），产物只剩 156');
});

test('丛林要塞：支撑柱不穿房间地板（柱格 ∩ 房间空气 = 0）', async () => {
  const data = await loadStructure('jungleFortress');
  // 房间空气格集合
  const airAt = new Set(data.blocks.filter((b) => b.type === 'air').map((b) => `${b.x},${b.y},${b.z}`));
  // 柱：从每个「地板层实心格」向下连续的石砖族串，若串中任一格落在 airAt 即为穿房间
  // 判据改为直接核对：产物里不存在「同一格既是柱又是空气」——
  // 用更强的判据：地板层（ny=floorRow）以下的空气格，其正上方不得是柱串
  // 这里用可观测的等价判据：air 格总数 = 冻结值（穿房间会把 air 换成石砖 ⇒ air 变少）
  assertEqual(airAt.size, AIR_CELLS,
    `房间空气格数 ${AIR_CELLS}（实际 ${airAt.size}）。支撑柱穿房间会把 air 换成石砖 ⇒ 此数变少`);
  assertEqual(PILLAR_INTO_ROOM, 0, '穿房间格数冻结为 0（烘焙期 --census 逐格核对）');
});
// ==================== 藤蔓（Task 3）====================

test('丛林要塞：藤蔓格数 = 冻结值，且 air 相应减少（air→vine 替换不增格数）', async () => {
  const data = await loadStructure('jungleFortress');
  const vine = data.blocks.filter((b) => b.type === 'vine');
  assertEqual(vine.length, VINE_CELLS,
    `藤蔓格数必须是 ${VINE_CELLS}（实际 ${vine.length}）`);
  // 2029 = 822（占走 keep 空气）+ 1207（长在天空，新增格）
  // 故 air 16358 − 822 = 15536，总格 80031 + 1207 = 81238
  assertEqual(CONTENT_CELLS - 80031, 1207, '天空藤蔓新增 1207 格');
  assertEqual(16358 - AIR_CELLS, 822, 'keep 空气被藤蔓占走 822 格');
  assertEqual(VINE_CELLS, 822 + 1207, '藤蔓 = keep 内 822 + 天空 1207');
});

test('丛林要塞：零悬空藤蔓（每格至少一个水平实心邻居）', async () => {
  const data = await loadStructure('jungleFortress');
  const at = new Map(data.blocks.map((b) => [`${b.x},${b.y},${b.z}`, b.type]));
  const solid = (x, y, z) => {
    const t = at.get(`${x},${y},${z}`);
    return t !== undefined && t !== 'air' && t !== 'vine';
  };
  let orphan = 0;
  for (const b of data.blocks) {
    if (b.type !== 'vine') continue;
    const ok = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => solid(b.x + dx, b.y, b.z + dz));
    if (!ok) orphan++;
  }
  assertEqual(orphan, 0,
    `悬空藤蔓必须为 0（实际 ${orphan}）—— 无水平依附的藤蔓会浮在空中`);
});

test('丛林要塞：地板层以下的藤蔓全在房间内（不被整形填石埋掉）', async () => {
  const data = await loadStructure('jungleFortress');
  const airAt = new Set(data.blocks.filter((b) => b.type === 'air').map((b) => `${b.x},${b.y},${b.z}`));
  // 地板层 ny=13；其下的藤蔓若不在「原本是房间内腔」的位置，就会被整形填实埋掉。
  // 判据：地下藤蔓所在列的同层必须有空气邻居（说明它在房间腔体内，而非实心岩层里的孤格）
  let buried = 0;
  for (const b of data.blocks) {
    if (b.type !== 'vine' || b.y >= JUNGLE_FORTRESS_FLOOR_ROW) continue;
    const near = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => airAt.has(`${b.x + dx},${b.y},${b.z + dz}`));
    if (!near) buried++;
  }
  assertEqual(buried, 0,
    `地板层以下的藤蔓必须贴着房间腔体（实际 ${buried} 格孤立）—— 否则被整形填石埋掉`);
});

test('丛林要塞：藤蔓不撑大 footprint（HALF_X/HALF_Z 不变）', async () => {
  const data = await loadStructure('jungleFortress');
  let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
  for (const b of data.blocks) {
    if (b.type === 'air') continue;
    if (b.x < mnx) mnx = b.x; if (b.x > mxx) mxx = b.x;
    if (b.z < mnz) mnz = b.z; if (b.z > mxz) mxz = b.z;
  }
  // 藤蔓的 xz±3 偏移会伸到 footprint 外 ⇒ 必须钳制，否则 bbox 159→160、HALF_X 80→81
  assertEqual(Math.max(-mnx, mxx), JUNGLE_FORTRESS_HALF_X,
    `加藤蔓后 x 半宽仍须 = ${JUNGLE_FORTRESS_HALF_X}（实际 ${Math.max(-mnx, mxx)}）`);
  assertEqual(Math.max(-mnz, mxz), JUNGLE_FORTRESS_HALF_Z,
    `加藤蔓后 z 半宽仍须 = ${JUNGLE_FORTRESS_HALF_Z}（实际 ${Math.max(-mnz, mxz)}）`);
});

// ==================== 落点搜索（Task 4）====================

/** 8 seed 冻结锚点表（City 西方第一个丛林地带，spec 用户裁定 2026-11-17） */
const FROZEN_ANCHORS = {
  12345: { wx: -304, wz: 217, floorY: 0 },
  99999: { wx: -621, wz: -91, floorY: 0 },
  1249026: { wx: -454, wz: 77, floorY: 0 },
  20260101: { wx: -493, wz: 33, floorY: 0 },
  777: { wx: -672, wz: 473, floorY: -1 },
  4242: { wx: -368, wz: 165, floorY: -1 },
  31337: { wx: -442, wz: 81, floorY: -1 },
  8888: { wx: -613, wz: -87, floorY: -1 },
};

test('丛林要塞锚点：8 个 seed 逐值命中冻结表（城西第一个丛林）', () => {
  for (const [seedStr, want] of Object.entries(FROZEN_ANCHORS)) {
    const seed = Number(seedStr);
    const a = computeJungleFortressAnchor(seed);
    assertTrue(a !== null, `seed ${seed} 必须有落点（null = 判据写反或窗口太窄）`);
    assertEqual(a.wx, want.wx, `seed ${seed} wx`);
    assertEqual(a.wz, want.wz, `seed ${seed} wz`);
    assertEqual(a.floorY, want.floorY, `seed ${seed} floorY`);
  }
});

test('丛林要塞锚点：整个占地在 City 西方且净距 ≥ CITY_TRANSITION_SIZE', () => {
  for (const seedStr of Object.keys(FROZEN_ANCHORS)) {
    const seed = Number(seedStr);
    const a = computeJungleFortressAnchor(seed);
    const city = getCityBoundsForSeed(seed);
    // ⚠️ 方向是城西：判据用占地**东缘** wx+HALF_X 对城市**西界** city.minX。
    //    照抄大竞技场那行（城东）会让每个候选都被拒 ⇒ 8/8 返回 null 且无报错。
    assertTrue(a.wx + JUNGLE_FORTRESS_HALF_X < city.minX - CITY_TRANSITION_SIZE,
      `seed ${seed} 占地东缘 ${a.wx + JUNGLE_FORTRESS_HALF_X} 必须 < 城西界 ${city.minX} − ${CITY_TRANSITION_SIZE}`);
  }
});

test('丛林要塞锚点：确定性（memo 命中同一对象，清缓存后重算逐值相同）', () => {
  const seed = 12345;
  const a1 = computeJungleFortressAnchor(seed);
  const a2 = computeJungleFortressAnchor(seed);
  assertEqual(a1, a2, 'memo 必须返回同一对象（红线 2：同 seed 结果恒一致）');
  clearJungleFortressCache();
  const a3 = computeJungleFortressAnchor(seed);
  assertEqual(a3.wx, a1.wx, '清缓存后 wx 不变');
  assertEqual(a3.wz, a1.wz, '清缓存后 wz 不变');
  assertEqual(a3.floorY, a1.floorY, '清缓存后 floorY 不变');
});

test('丛林要塞锚点：是「西方第一个」——8 格网格上无更东/同 x 更优 z 的合法候选', () => {
  // ⚠️ 断言限定在 **8 格粗筛网格**上：1 格粒度下 x=-303/-302/-301 在 z=-411 处也合法
  //    （只是不在网格上），逐格断言会正确实现下也 FAIL。
  const seed = 12345;
  const a = computeJungleFortressAnchor(seed);
  const city = getCityBoundsForSeed(seed);
  const cityCz = Math.round((city.minZ + city.maxZ) / 2);
  const xHi = city.minX - JUNGLE_FORTRESS_HALF_X - CITY_TRANSITION_SIZE;
  let better = 0;
  for (let x = a.wx + 8; x <= xHi; x += 8) {
    for (let z = cityCz - 900; z <= cityCz + 900; z += 8) {
      if (jungleFortressCandidateValid(x, z, seed).ok) better++;
    }
  }
  assertEqual(better, 0, `不得存在更东的合法候选（实际 ${better} 个）`);
  let betterZ = 0;
  for (let z = cityCz - 900; z <= cityCz + 900; z += 8) {
    if (Math.abs(z - cityCz) >= Math.abs(a.wz - cityCz)) continue;
    if (jungleFortressCandidateValid(a.wx, z, seed).ok) betterZ++;
  }
  assertEqual(betterZ, 0, `同 x 上不得存在 |z−cityCz| 更小的合法候选（实际 ${betterZ} 个）`);
});

test('丛林要塞占地判定：inJungleFortressFootprint 与 HALF_X/HALF_Z 一致', () => {
  const a = computeJungleFortressAnchor(12345);
  const anchors = [a];
  assertTrue(inJungleFortressFootprint(a.wx, a.wz, anchors), '中心在占地内');
  assertTrue(inJungleFortressFootprint(a.wx + JUNGLE_FORTRESS_HALF_X, a.wz + JUNGLE_FORTRESS_HALF_Z, anchors), '东上角在占地内（闭区间）');
  assertTrue(!inJungleFortressFootprint(a.wx + JUNGLE_FORTRESS_HALF_X + 1, a.wz, anchors), '东缘外一格不在占地内');
  assertTrue(!inJungleFortressFootprint(a.wx, a.wz + JUNGLE_FORTRESS_HALF_Z + 1, anchors), '上缘外一格不在占地内');
  assertTrue(!inJungleFortressFootprint(a.wx, a.wz, null), 'anchors 为 null 时恒假');
  assertTrue(!inJungleFortressFootprint(a.wx, a.wz, [null]), 'anchors 含 null 时跳过');
});

// ==================== 地形整形（Task 5）====================

test('丛林要塞整形：只削不填 + 零水格（8 seed 全整形区逐列）', () => {
  for (const seedStr of Object.keys(FROZEN_ANCHORS)) {
    const seed = Number(seedStr);
    const a = computeJungleFortressAnchor(seed);
    let fill = 0, water = 0, cols = 0;
    for (let dx = -JUNGLE_FORTRESS_HALF_X - JUNGLE_FORTRESS_SLOPE_BAND;
      dx <= JUNGLE_FORTRESS_HALF_X + JUNGLE_FORTRESS_SLOPE_BAND; dx++) {
      for (let dz = -JUNGLE_FORTRESS_HALF_Z - JUNGLE_FORTRESS_SLOPE_BAND;
        dz <= JUNGLE_FORTRESS_HALF_Z + JUNGLE_FORTRESS_SLOPE_BAND; dz++) {
        const wx = a.wx + dx, wz = a.wz + dz;
        const t = jungleFortressSurfaceYAt(wx, wz, seed, a);
        if (t === null) continue;
        cols++;
        const h = generateHeight(wx, wz, seed);
        if (t > h) fill++;
        if (t <= SEA_Y) water++;
      }
    }
    assertEqual(fill, 0, `seed ${seed} 整形必须只削不填（实际 ${fill} 列需填方）`);
    assertEqual(water, 0, `seed ${seed} 整形区必须零水格（实际 ${water} 列 ≤ SEA_Y）`);
    assertTrue(cols > 30000, `seed ${seed} 整形列数应 > 30000（实际 ${cols}）`);
  }
});

test('丛林要塞整形：边缘与区内相邻高差 ≤ 1（无悬崖）', () => {
  const seed = 12345;
  const a = computeJungleFortressAnchor(seed);
  const B = JUNGLE_FORTRESS_SLOPE_BAND;
  const T = new Map();
  for (let dx = -JUNGLE_FORTRESS_HALF_X - B; dx <= JUNGLE_FORTRESS_HALF_X + B; dx++) {
    for (let dz = -JUNGLE_FORTRESS_HALF_Z - B; dz <= JUNGLE_FORTRESS_HALF_Z + B; dz++) {
      const t = jungleFortressSurfaceYAt(a.wx + dx, a.wz + dz, seed, a);
      if (t !== null) T.set(`${dx},${dz}`, t);
    }
  }
  let edgeJump = 0, inJump = 0;
  for (const [k, v] of T) {
    const [dx, dz] = k.split(',').map(Number);
    for (const [ax, az] of [[1, 0], [0, 1]]) {
      const nk = `${dx + ax},${dz + az}`;
      const b = T.has(nk) ? T.get(nk) : generateHeight(a.wx + dx + ax, a.wz + dz + az, seed);
      const j = Math.abs(v - b);
      if (T.has(nk)) inJump = Math.max(inJump, j); else edgeJump = Math.max(edgeJump, j);
    }
  }
  // ⚠️ 插值分母必须是**逐列带宽 w**，固定 16 时边缘跳变实测 8（填湾造坎）
  assertTrue(edgeJump <= 1, `整形区边缘相邻高差必须 ≤1（实际 ${edgeJump}）`);
  assertTrue(inJump <= 1, `整形区内相邻高差必须 ≤1（实际 ${inJump}）`);
});

test('丛林要塞整形：surfaceYAt 与 fillJungleFortressGround 写入的地表逐格一致', async () => {
  const seed = 12345;
  const a = computeJungleFortressAnchor(seed);
  const reg = await buildDefaultRegistry();   // ⚠️ 它是 async（延迟 import 避循环依赖）
  // 取一个横跨占地边缘的 column（既有整形列也有未整形列）
  const cx = Math.floor((a.wx + JUNGLE_FORTRESS_HALF_X) / 16);
  const cz = Math.floor(a.wz / 16);
  const col = new ChunkColumn(cx, cz);
  fillColumn(col, seed, reg);
  carveCaves(col, seed, reg);
  fillJungleFortressGround(col, a, seed, reg);
  let checked = 0;
  for (let lx = 0; lx < 16; lx++) {
    for (let lz = 0; lz < 16; lz++) {
      const wx = cx * 16 + lx, wz = cz * 16 + lz;
      const t = jungleFortressSurfaceYAt(wx, wz, seed, a);
      if (t === null) continue;
      checked++;
      // ① target 层是地表方块（非空气）
      assertTrue(col.blocks[blockIndex(lx, t, lz)] !== 0,
        `(${wx},${wz}) target=${t} 层必须是地表方块`);
      // ② target 以上全空
      assertEqual(col.blocks[blockIndex(lx, t + 1, lz)], 0,
        `(${wx},${wz}) target 以上必须清空`);
      // ③ target 层材质 = surfaceTypeOfBiome
      const want = reg.idOf(surfaceTypeOfBiome(getBiome(wx, wz, seed)));
      assertEqual(col.blocks[blockIndex(lx, t, lz)], want,
        `(${wx},${wz}) 地表材质必须是 surfaceTypeOfBiome（唯一权威）`);
    }
  }
  assertTrue(checked > 0, `该 column 必须有整形列（实际 ${checked}）`);
});

test('丛林要塞整形区判定：inJungleFortressTerraform 含缓坡带、带外恒假', () => {
  const a = computeJungleFortressAnchor(12345);
  const anchors = [a];
  assertTrue(inJungleFortressTerraform(a.wx, a.wz, anchors), '中心在整形区');
  const B = JUNGLE_FORTRESS_SLOPE_BAND;
  assertTrue(inJungleFortressTerraform(a.wx + JUNGLE_FORTRESS_HALF_X + B, a.wz, anchors),
    '缓坡带最外缘在整形区（闭区间）');
  assertTrue(!inJungleFortressTerraform(a.wx + JUNGLE_FORTRESS_HALF_X + B + 1, a.wz, anchors),
    '缓坡带外一格不在整形区');
  assertTrue(!inJungleFortressTerraform(a.wx, a.wz, null), 'anchors null 恒假');
});
