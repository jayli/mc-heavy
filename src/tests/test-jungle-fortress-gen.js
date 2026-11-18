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
  jungleFortressOverlapsRegion, jungleFortressSuppressedLandmarks,
  snowLandSuppressedByJungleFortress,
  jungleFortressTeleportPoint, JUNGLE_FORTRESS_TELEPORT_GAP,
} from '../gen/structures/jungle-fortress.js';
import { computeRegionLayout, neighborRegionKeys } from '../gen/structures/structure-layout.js';
import { applyStructuresToColumn } from '../gen/structures/apply.js';
import { LANDMARK_CLEARANCE } from '../gen/structures/landmark-circles.js';
import { getFrozenMountainCenterInRegion } from '../gen/structures/landmarks.js';
import { getRegionSeededCenter } from '../gen/structures/region-center.js';
import { getCityBoundsForSeed } from '../gen/structures/city-layout.js';
import { CITY_TRANSITION_SIZE, REGION_SIZE, LANDMARK_OFFSET } from '../gen/structures/region-config.js';
import {
  jungleFortressSurfaceYAt, inJungleFortressTerraform, fillJungleFortressGround,
  JUNGLE_FORTRESS_SLOPE_BAND,
} from '../gen/structures/jungle-fortress-terrain.js';
import { rollVegetation, generateTree } from '../gen/structures/vegetation.js';
import { buildDefaultRegistry } from '../voxel/block-registry.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { blockIndex, SEA_Y, WORLD_MIN_Y, WORLD_MAX_Y } from '../voxel/constants.js';
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
const PALETTE_SIZE = 13;
const PRODUCT_W = 159;
const PRODUCT_D = 155;
/** 支撑柱穿房间格数（必须恒 0，由烘焙期 --census 的 intoRoom 指标与本文件 air 总数双重守住） */
const PILLAR_INTO_ROOM = 0;
/** 栏杆总格数（v3.13b 手拉手：原 2682 格 vertical_pillar 拆成直段+转角） */
const RAIL_CELLS = 2682;
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
  // 栏杆：v3.13b 用户裁定「手拉手」⇒ 直段 handrailA + 转角 handrail（两者都是用户明确要的）
  assertTrue(types.has('handrailA'), '栏杆直段件必须是 handrailA（横杆贯通整格 ⇒ 首尾相连成排）');
  assertTrue(types.has('handrail'), '栏杆转角件必须是 handrail');
  assertTrue(!types.has('vertical_pillar'),
    '不得再留 vertical_pillar —— 用户要求相邻栏杆改成手拉手的样子');
  assertTrue(!types.has('handrailB'),
    '不得用 handrailB：其臂只伸到格中心（±0.25）、接不上邻居，排上会出现看不见的缺口');
  assertTrue(!types.has('iron'), '不得用 iron：整块不透明会把窗洞堵死，看不过去');
});

test('丛林要塞：栏杆手拉手 —— 总数守恒 + 朝向逐档命中冻结值', async () => {
  const data = await loadStructure('jungleFortress');
  const hist = {};
  let total = 0;
  for (const b of data.blocks) {
    if (b.type !== 'handrail' && b.type !== 'handrailA') continue;
    total++;
    const k = `${b.type}:${b.direction}`;
    hist[k] = (hist[k] || 0) + 1;
  }
  assertEqual(total, RAIL_CELLS,
    `栏杆总数必须是 ${RAIL_CELLS}（实际 ${total}）—— 朝向 pass 只拆分不增删格`);
  const want = {
    'handrail:0': 14, 'handrail:1': 15, 'handrail:2': 14, 'handrail:3': 13,
    'handrailA:0': 1589, 'handrailA:1': 1037,
  };
  const sortKeys = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort()));
  assertEqual(sortKeys(hist), sortKeys(want),
    `栏杆朝向分布必须是 ${sortKeys(want)}（实际 ${sortKeys(hist)}）`);
  // handrailA 只有 0/1 两档（其 0≡2、1≡3 几何等价，railPlacementFor 按升序返首个）
  assertTrue(!('handrailA:2' in hist) && !('handrailA:3' in hist),
    'handrailA 不得出现 2/3 档（与 0/1 几何等价，反查表恒返最小 orient）');
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
  const airAt = new Set(data.blocks.filter((b) => b.type === 'air').map((b) => `${b.x},${b.y},${b.z}`));
  // ⚠️ **内容级判据**：air 总数必须等于冻结值。支撑柱穿房间会把 air 换成石砖
  //    ⇒ 此数变少（实测去掉「遇保留空气即停」后 16358→16185，173 格）。
  assertEqual(airAt.size, AIR_CELLS,
    `房间空气格数 ${AIR_CELLS}（实际 ${airAt.size}）。支撑柱穿房间会把 air 换成石砖 ⇒ 此数变少`);
  // ⚠️ **不得写 `assertEqual(PILLAR_INTO_ROOM, 0)`**（review M1）：那是常量 0 比字面 0，恒真。
  //    真正的穿房间计数在烘焙器的 `intoRoom`（已改成真统计并由 bake 断言钉 0），
  //    浏览器侧只能读产物，故这里用上面的 air 总数作等价守卫。
  assertTrue(PILLAR_INTO_ROOM === 0, '冻结常量为 0（仅作注释，判别力来自上一条）');
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

test('丛林要塞整形：边缘与区内相邻高差 ≤ 1（无悬崖，8 seed）', () => {
  // ⚠️ **必须跑满 8 seed**（review M2）：「逐列带宽 w」这条的判别力恰在 777/4242/8888
  //    （实测固定 16 时它们分别有 123/100/140 列 target 不同），而 12345/99999 无差异。
  //    只跑 12345 等于没守。
  for (const seedStr of Object.keys(FROZEN_ANCHORS)) {
    const seed = Number(seedStr);
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
    assertTrue(edgeJump <= 1, `seed ${seed} 整形区边缘相邻高差必须 ≤1（实际 ${edgeJump}）`);
    assertTrue(inJump <= 1, `seed ${seed} 整形区内相邻高差必须 ≤1（实际 ${inJump}）`);
  }
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

// ==================== 生成层接线（Task 6）====================

test('丛林要塞接线：layout 携带 jungleFortress 字段，且四个邻区都携带（AABB 裁剪）', () => {
  // ⚠️ **必须用占地真正跨 region 的 seed**：12345/99999/8888 的四角全在同一 region，
  //    在那些 seed 上「只让锚点 region 携带」的错误实现与本用例结果相同（无判别力）。
  //    实测 1249026 / 20260101 / 777 / 4242 / 31337 跨 2 个 region，取 1249026。
  const seed = 1249026;
  const a = computeJungleFortressAnchor(seed);
  const rxOf = (x) => Math.floor(x / REGION_SIZE);
  const rzOf = (z) => Math.floor(z / REGION_SIZE);
  // 占地四角所在的全部 region（去重）都必须携带锚点，否则结构缺半边
  const keys = new Set();
  for (const [dx, dz] of [
    [-JUNGLE_FORTRESS_HALF_X, -JUNGLE_FORTRESS_HALF_Z],
    [JUNGLE_FORTRESS_HALF_X, JUNGLE_FORTRESS_HALF_Z],
    [-JUNGLE_FORTRESS_HALF_X, JUNGLE_FORTRESS_HALF_Z],
    [JUNGLE_FORTRESS_HALF_X, -JUNGLE_FORTRESS_HALF_Z],
  ]) {
    keys.add(`${rxOf(a.wx + dx)},${rzOf(a.wz + dz)}`);
  }
  assertTrue(keys.size >= 2,
    `本用例必须选跨 region 的 seed（实际只跨 ${keys.size} 个 region ⇒ 无判别力）`);
  for (const key of keys) {
    const [rx, rz] = key.split(',').map(Number);
    assertTrue(jungleFortressOverlapsRegion(a, rx, rz), `region(${rx},${rz}) 必须与占地相交`);
    const layout = computeRegionLayout(rx, rz, seed);
    assertTrue(layout.jungleFortress !== null && layout.jungleFortress !== undefined,
      `region(${rx},${rz}) 的 layout 必须携带 jungleFortress（只让锚点 region 携带 ⇒ 结构缺半边）`);
    assertEqual(layout.jungleFortress.wx, a.wx, 'layout 携带的锚点 wx 一致');
  }
  assertTrue(!jungleFortressOverlapsRegion(null, 0, 0), 'anchor 为 null 时恒假');
});

test('丛林要塞接线：真实 GEN 后锚点 column 含要塞方块，房间内是空气', async () => {
  const seed = 12345;
  const a = computeJungleFortressAnchor(seed);
  const reg = await buildDefaultRegistry();
  const cx = Math.floor(a.wx / 16), cz = Math.floor(a.wz / 16);
  const col = new ChunkColumn(cx, cz);
  fillColumn(col, seed, reg);
  carveCaves(col, seed, reg);
  const layouts = neighborRegionKeys(cx, cz).map((key) => { const [rx, rz] = key.split(',').map(Number); return computeRegionLayout(rx, rz, seed); });
  await applyStructuresToColumn(col, seed, reg, layouts);

  // ① 该 column 必须含要塞主材（不是纯自然地形）
  const mossyId = reg.idOf('mossy_stone');
  const cobbleId = reg.idOf('cobblestone');
  let structureCells = 0;
  for (let i = 0; i < col.blocks.length; i++) {
    if (col.blocks[i] === mossyId || col.blocks[i] === cobbleId) structureCells++;
  }
  assertTrue(structureCells > 100,
    `锚点 column 必须含要塞方块（实际 ${structureCells} 格 mossy_stone/cobblestone）`);

  // ② 世界 y 范围不越界
  const worldBottom = a.floorY + (1 - JUNGLE_FORTRESS_FLOOR_ROW);
  assertTrue(worldBottom >= WORLD_MIN_Y,
    `产物底部世界 y=${worldBottom} 必须 ≥ WORLD_MIN_Y=${WORLD_MIN_Y}`);
});

test('丛林要塞接线：整形区内地表 = surfaceYAt（真实 GEN 写入）', async () => {
  const seed = 12345;
  const a = computeJungleFortressAnchor(seed);
  const reg = await buildDefaultRegistry();
  // 取缓坡带内的 column（只有整形、没有结构方块，判据最干净）
  const cx = Math.floor((a.wx + JUNGLE_FORTRESS_HALF_X + 8) / 16);
  const cz = Math.floor(a.wz / 16);
  const col = new ChunkColumn(cx, cz);
  fillColumn(col, seed, reg);
  carveCaves(col, seed, reg);
  const layouts = neighborRegionKeys(cx, cz).map((key) => { const [rx, rz] = key.split(',').map(Number); return computeRegionLayout(rx, rz, seed); });
  await applyStructuresToColumn(col, seed, reg, layouts);
  let checked = 0;
  for (let lx = 0; lx < 16; lx++) {
    for (let lz = 0; lz < 16; lz++) {
      const wx = cx * 16 + lx, wz = cz * 16 + lz;
      const t = jungleFortressSurfaceYAt(wx, wz, seed, a);
      if (t === null) continue;
      checked++;
      const want = reg.idOf(surfaceTypeOfBiome(getBiome(wx, wz, seed)));
      assertEqual(col.blocks[blockIndex(lx, t, lz)], want,
        `(${wx},${wz}) 整形地表必须是 surfaceYAt=${t} 处的 biome 材质`);
      // ⚠️ **v3.13b 语义变更**：用户要求空地植树植草 ⇒ target+1 可能是草/花/树干，
      //    不再恒为空气。旧断言「上方必须清空」与新需求相反。
      //    改钉「上方不得是 **地形实心方块**（stone/dirt/sand/grass 类）」——
      //    那才是「原山体未被削平」的形态；植被与结构方块不算。
      const above = col.blocks[blockIndex(lx, t + 1, lz)];
      const terrainIds = new Set(['stone', 'dirt', 'sand', 'grass', 'end_stone',
        'snow_grass', 'swamp_grass', 'moss'].map((n) => reg.idOf(n)));
      assertTrue(!terrainIds.has(above),
        `(${wx},${wz}) 整形地表以上不得残留原山体地形方块（实际 id=${above}）`);
    }
  }
  assertTrue(checked > 0, `该 column 必须有整形列（实际 ${checked}）`);
});

// ==================== 树叶让位语义（v3.13c，用户实玩：「树叶被切割」）====================
//
// 用户裁定：**只有当要塞方块真的占位那一格时才让位**，那一格渲染成要塞方块；
// 其余位置树叶照常长 ⇒ 不得把树冠「垂直切一刀」。
// ⚠️ 判据必须是**逐格**（产物在该 (x,y,z) 是否非空气），不是**逐列**（该列任何一格有实心）。
//    列级判据的失效形态：矮墙/台阶列的**高处本是空气**，却因列内有实心而整列禁写
//    ⇒ 树冠贴墙那侧出现平直切口。
//
// ⚠️⚠️ **判据必须拿「树生成器本来要写哪些格」当基准，不能拿「紧邻有树叶的空格」当基准**：
//    generateTree 自己会稀疏化（default 树 rand>0.3 才写）且 _addOptimized 会跳过
//    「六面全被树块包围」的叶 ⇒ 树冠内部本来就有合法空洞。第一版用「紧邻有叶」判据
//    在**修好之后反而从 297 涨到 414**（补上的叶让更多空格变成"紧邻有叶"）⇒ 零判别力。
//    正确做法：用同一个 generateTree 收集意图格，逐格比对世界里的实际结果。

test('丛林要塞：树叶只在要塞真占位的格让位（逐格，不是逐列垂直切割）', async () => {
  const seed = 12345;
  const a = computeJungleFortressAnchor(seed);
  const reg = await buildDefaultRegistry();
  const data = await loadStructure('jungleFortress');
  const cellType = new Map();
  const colSolid = new Set();
  const roofTop = new Map();
  for (const b of data.blocks) {
    if (b.type !== 'air') {
      cellType.set(`${b.x},${b.y},${b.z}`, b.type);
      colSolid.add(`${b.x},${b.z}`);
      const ck = `${b.x},${b.z}`;
      const prev = roofTop.get(ck);
      if (prev === undefined || b.y > prev) roofTop.set(ck, b.y);
    }
  }
  // 「室外可长」与生产代码 jfCellFreeAt 同口径：非实心 且 不在屋顶下方。
  // ⚠️ **屋顶下方的 air 是室内房间**，那里本就不应长树 ⇒ 不得计入「误杀」。
  const isOutdoor = (px, ny, pz) => {
    if (cellType.has(`${px},${ny},${pz}`)) return false;
    const top = roofTop.get(`${px},${pz}`);
    return top === undefined || ny >= top;
  };
  const floorRow = floorRowOf('jungleFortress');
  const B = JUNGLE_FORTRESS_SLOPE_BAND;
  // 树冠意图：把整形区所有空地列的树按真实 generateTree 收集一遍（含稀疏化与包围剔除）
  const intent = new Map();   // "wx,y,wz" -> 方块名
  for (let dx = -JUNGLE_FORTRESS_HALF_X - B; dx <= JUNGLE_FORTRESS_HALF_X + B; dx++) {
    for (let dz = -JUNGLE_FORTRESS_HALF_Z - B; dz <= JUNGLE_FORTRESS_HALF_Z + B; dz++) {
      const wx = a.wx + dx, wz = a.wz + dz;
      const s = jungleFortressSurfaceYAt(wx, wz, seed, a);
      if (s === null || colSolid.has(`${dx},${dz}`)) continue;
      const roll = rollVegetation(wx, wz, 'FOREST', seed);
      if (!roll.tree || roll.tree.type === 'birchTree' || roll.tree.type === 'birchTreeWithSnow') continue;
      generateTree(wx, s + 1, wz, (x, y, z, name) => intent.set(`${x},${y},${z}`, name),
        seed, roll.tree.type, roll.tree.customLog || null, roll.tree.customLeaf || null, roll.tree.leafMix || null);
    }
  }
  assertTrue(intent.size > 10000, `树冠意图格必须有量（实际 ${intent.size}）`);
  // 只看「意图格落在含实心的列里」那批 —— 那正是列级守卫会误杀的范围
  const probe = [];
  for (const [k, name] of intent) {
    const [wx, y, wz] = k.split(',').map(Number);
    const px = wx - a.wx, pz = wz - a.wz;
    if (!colSolid.has(`${px},${pz}`)) continue;
    const ny = y - a.floorY + floorRow;
    const occupied = cellType.has(`${px},${ny},${pz}`);
    // 屋顶下方的室内格本就不应长树 ⇒ 排除，否则把「正确拒写」误报成切割
    if (!occupied && !isOutdoor(px, ny, pz)) continue;
    probe.push({ wx, y, wz, name, occupied });
  }
  const freeProbes = probe.filter((p) => !p.occupied);
  assertTrue(freeProbes.length > 100,
    `必须有足量「列内有实心但该格室外可长」的树冠意图格（实际 ${freeProbes.length}）—— ` +
    '否则本用例对列级/逐格之差无判别力');
  // 逐格读真实 GEN 结果（按 column 分组，避免重复构建）
  const byCol = new Map();
  for (const p of probe) {
    const cx = Math.floor(p.wx / 16), cz = Math.floor(p.wz / 16);
    const ck = `${cx},${cz}`;
    if (!byCol.has(ck)) byCol.set(ck, []);
    byCol.get(ck).push(p);
  }
  let wrongDrop = 0, keptFree = 0, yielded = 0;
  // 树叶种类集合：两棵树的树冠重叠时**后写胜**（与结构写入同口径）⇒
  // 判「该格有没有树叶/树干」而不是「是不是同一品种的叶」。
  // ⚠️ **叶种名单必须从权威源派生，不得手写**：手写漏了 giant_palm/banyan（id 138 等）
  //    会把 20 格合法树叶误报成切割（实测）。
  // ⚠️ **树干也算「未被切割」**：新种的贴墙树树干会穿过邻居树冠（后写胜），
  //    那是用户要的「只在占位格让位」的自然交叠，不是空洞。
  //    判据的真正目标：**该格不得是空气**（airCount 才是切割）。
  const leafNames = new Set(['leaves', 'yellow_leaves', 'realistic_yellow_leaves',
    'azalea_leaves', 'azalea_flowers', 'swamp_leaves', 'snow_leaves', 'sky_leaves',
    'giant_oak_leaves', 'giant_spruce_leaves', 'giant_palm_leaves', 'giant_banyan_leaves',
    'giant_birch_leaves']);
  const trunkNames = new Set(['wood', 'birch_log', 'giant_oak_log']);
  const solidVegIds = new Set([...leafNames, ...trunkNames]
    .map((n) => reg.idOf(n)).filter((v) => v !== undefined && v !== null));
  for (const [ck, list] of byCol) {
    const [cx, cz] = ck.split(',').map(Number);
    const col = new ChunkColumn(cx, cz);
    fillColumn(col, seed, reg);
    carveCaves(col, seed);
    const layouts = neighborRegionKeys(cx, cz)
      .map((k) => { const [rx, rz] = k.split(',').map(Number); return computeRegionLayout(rx, rz, seed); });
    await applyStructuresToColumn(col, seed, reg, layouts);
    for (const p of list) {
      const lx = ((p.wx % 16) + 16) % 16, lz = ((p.wz % 16) + 16) % 16;
      const id = col.blocks[blockIndex(lx, p.y, lz)];
      if (p.occupied) { if (id !== reg.idOf(p.name)) yielded++; continue; }
      // 意图格未被要塞占位 ⇒ 那里必须是**植被实体**（叶或树干），不得是空气
      if (solidVegIds.has(id)) keptFree++;
      else wrongDrop++;
    }
  }
  assertTrue(yielded > 0, `真占位的格必须让位给要塞方块（实际让位 ${yielded}）`);
  assertEqual(wrongDrop, 0,
    `产物在该格是空气时树叶必须照常写入：实测 ${wrongDrop} 格被误杀` +
    `（正常写入 ${keptFree}）—— 列级守卫把矮墙列的高处空气也禁写了，树冠被垂直切割`);
});

test('丛林要塞：树干落点也逐格判 —— 贴墙但树干格是空气时必须种树（v3.13d）', async () => {
  const seed = 12345;
  const a = computeJungleFortressAnchor(seed);
  const reg = await buildDefaultRegistry();
  const data = await loadStructure('jungleFortress');
  const cellSolid = new Set();
  const colSolid = new Set();
  const roofTop = new Map();
  for (const b of data.blocks) {
    if (b.type === 'air') continue;
    cellSolid.add(`${b.x},${b.y},${b.z}`);
    colSolid.add(`${b.x},${b.z}`);
    const ck = `${b.x},${b.z}`;
    const prev = roofTop.get(ck);
    if (prev === undefined || b.y > prev) roofTop.set(ck, b.y);
  }
  // 「室外可长」= 该格非实心 且 不在屋顶下方（与生产代码 jfCellFreeAt 同口径）
  const isOutdoor = (px, ny, pz) => {
    if (cellSolid.has(`${px},${ny},${pz}`)) return false;
    const top = roofTop.get(`${px},${pz}`);
    return top === undefined || ny >= top;
  };
  const floorRow = floorRowOf('jungleFortress');
  const B = JUNGLE_FORTRESS_SLOPE_BAND;
  const trunkIds = new Set(['wood', 'birch_log', 'giant_oak_log'].map((n) => reg.idOf(n)));
  // 收集「抽签命中树 + 列内有实心 + 但树干那一格是空气」的列
  // —— 列级落点判据会把这些树整棵挡掉，而用户要的是「只在真占位那一格让位」。
  const probe = [];
  for (let dx = -JUNGLE_FORTRESS_HALF_X - B; dx <= JUNGLE_FORTRESS_HALF_X + B; dx++) {
    for (let dz = -JUNGLE_FORTRESS_HALF_Z - B; dz <= JUNGLE_FORTRESS_HALF_Z + B; dz++) {
      const wx = a.wx + dx, wz = a.wz + dz;
      const s = jungleFortressSurfaceYAt(wx, wz, seed, a);
      if (s === null) continue;
      const roll = rollVegetation(wx, wz, 'FOREST', seed);
      if (!roll.tree) continue;
      if (!colSolid.has(`${dx},${dz}`)) continue;               // 只看贴墙列
      if (!isOutdoor(dx, s + 1 - a.floorY + floorRow, dz)) continue;  // 树干格必须室外可长
      probe.push({ wx, wz, y: s + 1 });
    }
  }
  assertTrue(probe.length > 50,
    `必须有足量「贴墙但树干格是空气」的候选列（实际 ${probe.length}）—— 否则无判别力`);
  const byCol = new Map();
  for (const q of probe) {
    const ck = `${Math.floor(q.wx / 16)},${Math.floor(q.wz / 16)}`;
    if (!byCol.has(ck)) byCol.set(ck, []);
    byCol.get(ck).push(q);
  }
  let missingTrunk = 0, hasTrunk = 0;
  for (const [ck, list] of byCol) {
    const [cx, cz] = ck.split(',').map(Number);
    const col = new ChunkColumn(cx, cz);
    fillColumn(col, seed, reg);
    carveCaves(col, seed);
    const layouts = neighborRegionKeys(cx, cz)
      .map((k) => { const [rx, rz] = k.split(',').map(Number); return computeRegionLayout(rx, rz, seed); });
    await applyStructuresToColumn(col, seed, reg, layouts);
    for (const q of list) {
      const lx = ((q.wx % 16) + 16) % 16, lz = ((q.wz % 16) + 16) % 16;
      const id = col.blocks[blockIndex(lx, q.y, lz)];
      if (trunkIds.has(id)) hasTrunk++; else missingTrunk++;
    }
  }
  assertEqual(missingTrunk, 0,
    `树干格未被要塞占位时必须种树：实测 ${missingTrunk} 列没树干（已种 ${hasTrunk}）—— ` +
    '落点判据仍是列级，贴墙的树整棵不生成 ⇒ 邻居树冠伸过来时被「缺一棵树」的空洞切平');
});

test('丛林要塞接线：占地内零撒布，植被只在空地上（v3.13b 用户要求空地植树植草）', async () => {
  const seed = 12345;
  const a = computeJungleFortressAnchor(seed);
  const reg = await buildDefaultRegistry();
  const cx = Math.floor(a.wx / 16), cz = Math.floor(a.wz / 16);
  const col = new ChunkColumn(cx, cz);
  fillColumn(col, seed, reg);
  carveCaves(col, seed, reg);
  const layouts = neighborRegionKeys(cx, cz).map((key) => { const [rx, rz] = key.split(',').map(Number); return computeRegionLayout(rx, rz, seed); });
  await applyStructuresToColumn(col, seed, reg, layouts);

  // ⚠️ **v3.13b 语义变更**：用户要求「空地植树 + 高矮两种草 + 过渡带也有树」
  //    ⇒ 旧断言「占地内零植被」**与新需求直接矛盾**，已改成：
  //      ① 植被**不得占要塞真占位的格**；② 真的有树与两种草。
  // ⚠️⚠️ **v3.13c 再改：判据从「逐列」改成「逐格」**。用户裁定「只在被城堡方块
  //    占位那一格让位」⇒ 矮墙列的**高处空气**里长树叶是**合法**的。
  //    旧的逐列判据会把这 15 格合法树叶误报成穿模（它正是用户要的「不被切割」）。
  const { loadStructure: load } = await import('../gen/structures/structure-json.js');
  const data = await load('jungleFortress');
  const floorRow = floorRowOf('jungleFortress');
  const solidCell = new Set();
  for (const b of data.blocks) if (b.type !== 'air') solidCell.add(`${b.x},${b.y},${b.z}`);
  const vegIds = new Set(['leaves', 'wood', 'birch_log', 'short_grass', 'bush_grass', 'flower',
    'allium', 'azure_bluet', 'oxeye_daisy', 'dead_bush', 'yellow_leaves', 'red_mushroom',
    'giant_oak_leaves', 'giant_oak_log', 'giant_spruce_leaves'].map((n) => reg.idOf(n)));
  const trunkIds = new Set(['wood', 'birch_log'].map((n) => reg.idOf(n)));
  const shortId = reg.idOf('short_grass'), bushId = reg.idOf('bush_grass');
  let inStructure = 0, veg = 0, trunk = 0, shortG = 0, bushG = 0;
  for (let lx = 0; lx < 16; lx++) {
    for (let lz = 0; lz < 16; lz++) {
      const wx = cx * 16 + lx, wz = cz * 16 + lz;
      if (!inJungleFortressFootprint(wx, wz, [a])) continue;
      for (let y = WORLD_MIN_Y; y < WORLD_MAX_Y; y++) {
        const id = col.blocks[blockIndex(lx, y, lz)];
        if (!vegIds.has(id)) continue;
        veg++;
        if (trunkIds.has(id)) trunk++;
        if (id === shortId) shortG++;
        if (id === bushId) bushG++;
        // 逐格：产物在**这一格**有实心才是穿模
        if (solidCell.has(`${wx - a.wx},${y - a.floorY + floorRow},${wz - a.wz}`)) inStructure++;
      }
    }
  }
  assertEqual(inStructure, 0,
    `植被不得占要塞真占位的格（实际 ${inStructure} 格）—— 那才是穿模`);
  assertTrue(veg > 0, `空地必须有植被（实际 ${veg} 格）—— 用户要求不能光秃秃`);
  assertTrue(trunk > 0, `必须有树干（实际 ${trunk} 格）`);
  assertTrue(shortG > 0, `必须有矮草 short_grass（实际 ${shortG}）`);
  assertTrue(bushG > 0, `必须有高草 bush_grass（实际 ${bushG}）`);
});

test('丛林要塞接线：地标压制用圆↔矩形相交（中心在占地外但半径伸进来也要压）', () => {
  const seed = 12345;
  const a = computeJungleFortressAnchor(seed);
  // 构造判据核对：取一个「中心在占地 x 外 1 格、半径足以伸进占地」的点
  const HX = JUNGLE_FORTRESS_HALF_X;
  const r = LANDMARK_CLEARANCE.frozenMountain;      // 48
  // ⚠️ **合成锚点法（review I1）**：拿**真实地标中心**反推一个锚点，使地标中心
  //    恰好落在占地 x 外 1 格（圆伸进来、中心在外），直接钉函数输出。
  //    旧写法只断言自己构造的几何 + `typeof … === 'boolean'`，**恒真、零判别力**。
  //    「中心在占地内」的错误实现在本用例下必返 false ⇒ 真 FAIL。
  const rx = Math.floor(a.wx / REGION_SIZE), rz = Math.floor(a.wz / REGION_SIZE);
  const fm = getFrozenMountainCenterInRegion(rx, rz, seed);
  assertTrue(fm !== null && fm !== undefined, `region(${rx},${rz}) 必须有冰封山中心供构造`);
  const fake = { wx: fm.cx - HX - 1, wz: fm.cz, floorY: 0, span: 0 };
  // 前提自检：中心确实在占地外，但圆（半径 48）伸得进来
  assertTrue(Math.abs(fm.cx - fake.wx) > HX, '地标中心必须在占地 x 范围外');
  assertTrue(Math.abs(fm.cx - fake.wx) - HX <= r, '地标圆必须伸进占地（否则本用例无判别力）');
  const sup = jungleFortressSuppressedLandmarks(fake, rx, rz, seed);
  assertEqual(sup.frozenMountain, true,
    '圆↔矩形相交：地标中心在占地外 1 格但半径伸进来 ⇒ 必须被压（中心判据会漏压）');
  // 对照：把锚点再往西移到一个圆碰不到的位置 ⇒ 必须不压
  const far = { wx: fm.cx - HX - r - 10, wz: fm.cz, floorY: 0, span: 0 };
  assertEqual(jungleFortressSuppressedLandmarks(far, rx, rz, seed).frozenMountain, false,
    '圆碰不到占地时不得压（否则上条断言可能是「恒返 true」蒙过）');
  const shape = jungleFortressSuppressedLandmarks(a, 0, 0, seed);
  for (const k of ['pyramid', 'frozenMountain', 'plainLand', 'island', 'snowLand', 'giantPyramid', 'skyIslands']) {
    assertEqual(typeof shape[k], 'boolean', `压制结果必须含布尔字段 ${k}`);
  }
});

test('丛林要塞接线：雪原整座让路（合成锚点 ⇒ 相交 region 的 layout.snowLand === null）', () => {
  const seed = 12345;
  // ⚠️ **合成锚点法（review I1）**：旧写法扫真实锚点周围、末了断言 `typeof found === 'boolean'`
  //    是恒真式；若该 seed 恰好无相交雪原，整条用例零判别力。
  //    改为：拿**真实雪原中心**反推锚点，使它必定相交，再钉函数与 layout 两侧。
  let checked = 0;
  for (let rx = -2; rx <= 0; rx++) {
    for (let rz = -1; rz <= 1; rz++) {
      const raw = getRegionSeededCenter(rx, rz, seed);
      const snowCx = raw.centerX + LANDMARK_OFFSET.SNOW_LAND_X;
      const snowCz = raw.centerZ + LANDMARK_OFFSET.SNOW_LAND_Z;
      // 合成一个「雪原中心恰在占地内」的锚点（它不必是合法落点，
      // 本用例只验「压制判据 + layout 接线」，不验锚点搜索）
      const fake = { wx: snowCx, wz: snowCz, floorY: 0, span: 0 };
      const dx = Math.max(0, Math.abs(snowCx - fake.wx) - JUNGLE_FORTRESS_HALF_X);
      const dz = Math.max(0, Math.abs(snowCz - fake.wz) - JUNGLE_FORTRESS_HALF_Z);
      assertTrue(Math.hypot(dx, dz) <= LANDMARK_CLEARANCE.snowLand,
        '构造前提：雪原圆必须与占地相交');
      const sup = jungleFortressSuppressedLandmarks(fake, rx, rz, seed);
      assertEqual(sup.snowLand, true,
        `雪原中心在占地内 ⇒ 必须被压（region ${rx},${rz}）`);
      checked++;
    }
  }
  assertTrue(checked >= 6, `必须真的验了多个 region（实际 ${checked}）`);
  // 真实锚点侧：凡被压的 region，layout.snowLand 必须是 null（接线守卫）
  const a = computeJungleFortressAnchor(seed);
  let hits = 0;
  for (let rx = Math.floor((a.wx - JUNGLE_FORTRESS_HALF_X) / REGION_SIZE) - 1;
    rx <= Math.floor((a.wx + JUNGLE_FORTRESS_HALF_X) / REGION_SIZE) + 1; rx++) {
    for (let rz = Math.floor((a.wz - JUNGLE_FORTRESS_HALF_Z) / REGION_SIZE) - 1;
      rz <= Math.floor((a.wz + JUNGLE_FORTRESS_HALF_Z) / REGION_SIZE) + 1; rz++) {
      if (!snowLandSuppressedByJungleFortress(rx, rz, seed)) continue;
      hits++;
      assertEqual(computeRegionLayout(rx, rz, seed).snowLand, null,
        `被要塞压掉的雪原在 layout 里必须是 null（region ${rx},${rz}）`);
    }
  }
  // 不断言 hits>0（该 seed 可能无相交雪原）；判别力由上面的合成锚点部分提供。
  assertTrue(hits >= 0, '真实锚点侧扫描可执行');
});

// ==================== 瞬移入口（Task 7）====================

/** 8 seed 冻结落点（占地东缘外 6 格，y = 整形后地表 + 1） */
const FROZEN_TELEPORT = {
  12345: [-218, 3, 217],
  99999: [-535, 3, -91],
  1249026: [-368, 3, 77],
  20260101: [-407, 3, 33],
  777: [-586, 2, 473],
  4242: [-282, 2, 165],
  31337: [-356, 2, 81],
  8888: [-527, 2, -87],
};

test('丛林要塞瞬移：8 个 seed 落点逐值命中冻结表（y 用整形后地表）', () => {
  for (const [seedStr, [x, y, z]] of Object.entries(FROZEN_TELEPORT)) {
    const seed = Number(seedStr);
    const p = jungleFortressTeleportPoint(seed);
    assertTrue(p !== null, `seed ${seed} 必须有落点`);
    assertEqual(p.x, x, `seed ${seed} 落点 x`);
    assertEqual(p.y, y, `seed ${seed} 落点 y（必须是整形后地表+1，不是自然高度+1）`);
    assertEqual(p.z, z, `seed ${seed} 落点 z`);
  }
});

test('丛林要塞瞬移：落点在占地东缘外 GAP 格（靠 City 那一侧）', () => {
  for (const seedStr of Object.keys(FROZEN_TELEPORT)) {
    const seed = Number(seedStr);
    const a = computeJungleFortressAnchor(seed);
    const p = jungleFortressTeleportPoint(seed);
    assertEqual(p.x, a.wx + JUNGLE_FORTRESS_HALF_X + JUNGLE_FORTRESS_TELEPORT_GAP,
      `seed ${seed} 落点必须在东缘外 ${JUNGLE_FORTRESS_TELEPORT_GAP} 格（结构在城西 ⇒ 东侧靠 City）`);
    assertEqual(p.z, a.wz, `seed ${seed} 落点 z 取锚点中线`);
    assertTrue(!inJungleFortressFootprint(p.x, p.z, [a]), '落点不得在占地内');
  }
});

test('丛林要塞瞬移：落点用自然高度会悬空（判据必须有判别力）', () => {
  // 实测 8 seed 自然 h 4~5、整形后 1~2 ⇒ 用自然高度会让玩家悬空 2~3 格。
  // 本用例钉「两者确实不同」，否则「y 用整形后地表」这条断言失去判别力。
  let differ = 0;
  for (const seedStr of Object.keys(FROZEN_TELEPORT)) {
    const seed = Number(seedStr);
    const p = jungleFortressTeleportPoint(seed);
    const natural = generateHeight(p.x, p.z, seed) + 1;
    if (natural !== p.y) differ++;
  }
  assertEqual(differ, 8,
    `8/8 seed 的整形后落点高度必须与自然高度不同（实际 ${differ} 个不同）—— ` +
    '否则「用整形后地表」这条要求无法被判据守住');
});
