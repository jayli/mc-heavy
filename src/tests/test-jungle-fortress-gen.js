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
  percentile75,
} from '../gen/structures/jungle-fortress.js';
import { computeRegionLayout, neighborRegionKeys } from '../gen/structures/structure-layout.js';
import { applyStructuresToColumn, jfTreeKept } from '../gen/structures/apply.js';
import { LANDMARK_CLEARANCE } from '../gen/structures/landmark-circles.js';
import { getFrozenMountainCenterInRegion } from '../gen/structures/landmarks.js';
import { getRegionSeededCenter } from '../gen/structures/region-center.js';
import { getCityBoundsForSeed } from '../gen/structures/city-layout.js';
import { CITY_TRANSITION_SIZE, REGION_SIZE, LANDMARK_OFFSET } from '../gen/structures/region-config.js';
import {
  jungleFortressSurfaceYAt, inJungleFortressTerraform,
  jungleFortressGeometry, jungleFortressSkirtField, noteJungleFortressData,
  JUNGLE_FORTRESS_SLOPE_BAND,
  JUNGLE_FORTRESS_SKIRT_INNER, JUNGLE_FORTRESS_SKIRT_OUTER,
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

/**
 * 8 seed 冻结锚点表（City 西方第一个丛林地带，spec 用户裁定 2026-11-17）
 *
 * ⚠️ v3.16（地形耦合）：`floorY` 语义从「占地最低自然高度」改为 **baseY（占地自然高度
 *    的 75 分位数）**，8 seed 实测恒 9；`minH` 保留旧语义（0 或 −1）供判据用。
 */
const FROZEN_ANCHORS = {
  12345: { wx: -304, wz: 217, floorY: 9, minH: 0 },
  99999: { wx: -621, wz: -91, floorY: 9, minH: 0 },
  1249026: { wx: -454, wz: 77, floorY: 9, minH: 0 },
  20260101: { wx: -493, wz: 33, floorY: 9, minH: 0 },
  777: { wx: -672, wz: 473, floorY: 9, minH: -1 },
  4242: { wx: -368, wz: 165, floorY: 9, minH: -1 },
  31337: { wx: -442, wz: 81, floorY: 9, minH: -1 },
  8888: { wx: -613, wz: -87, floorY: 9, minH: -1 },
};

test('丛林要塞 percentile75：合成数组逐值（不依赖 generateHeight，钉「是分位数不是硬编码 9」）', () => {
  // ⚠️ 期望值先实测算过：floor(0.75*(n−1)) 取下标，不做线性插值。
  assertEqual(percentile75([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), 6, 'n=10 ⇒ idx 6');
  assertEqual(percentile75([5]), 5, '单元素');
  assertEqual(percentile75([]), 0, '空数组不得返回 undefined');
  assertEqual(percentile75([1, 1, 1, 9]), 1, 'n=4 ⇒ idx 2（低位众数）');
  assertEqual(percentile75([0, 0, 0, 0, 9, 9, 9, 9]), 9, 'n=8 ⇒ idx 5（高位众数）');
  assertEqual(percentile75([-9, -1, 0, 3, 9]), 3, '含负数');
});

test('丛林要塞锚点：8 个 seed 逐值命中冻结表（城西第一个丛林，floorY=baseY 75 分位）', () => {
  for (const [seedStr, want] of Object.entries(FROZEN_ANCHORS)) {
    const seed = Number(seedStr);
    const a = computeJungleFortressAnchor(seed);
    assertTrue(a !== null, `seed ${seed} 必须有落点（null = 判据写反或窗口太窄）`);
    assertEqual(a.wx, want.wx, `seed ${seed} wx`);
    assertEqual(a.wz, want.wz, `seed ${seed} wz`);
    assertEqual(a.floorY, want.floorY, `seed ${seed} floorY（v3.16 = baseY 75 分位，不是 minH）`);
    assertEqual(a.minH, want.minH, `seed ${seed} minH（占地最低自然高度，旧 floorY 语义保留）`);
  }
});

test('丛林要塞锚点：baseY 由占地逐格自然高度的 75 分位派生（不是硬编码 9）', () => {
  // ⚠️ 判据真值独立于被测代码：这里自己扫 161×155 逐格 generateHeight 排序，
  //    再按 floor(0.75*(n−1)) 取下标，与 anchor.floorY 比对。
  //    若生产代码写死 9，本用例在换地形公式后会红（且 n=24955 的 idx 也钉住）。
  for (const seedStr of Object.keys(FROZEN_ANCHORS)) {
    const seed = Number(seedStr);
    const a = computeJungleFortressAnchor(seed);
    const hs = [];
    for (let dz = -JUNGLE_FORTRESS_HALF_Z; dz <= JUNGLE_FORTRESS_HALF_Z; dz++) {
      for (let dx = -JUNGLE_FORTRESS_HALF_X; dx <= JUNGLE_FORTRESS_HALF_X; dx++) {
        hs.push(generateHeight(a.wx + dx, a.wz + dz, seed));
      }
    }
    hs.sort((p, q) => p - q);
    assertEqual(hs.length, (2 * JUNGLE_FORTRESS_HALF_X + 1) * (2 * JUNGLE_FORTRESS_HALF_Z + 1),
      `seed ${seed} 占地格数`);
    assertEqual(a.floorY, hs[Math.floor(0.75 * (hs.length - 1))],
      `seed ${seed} floorY 必须等于占地自然高度的 75 分位`);
    assertEqual(a.minH, hs[0], `seed ${seed} minH 必须等于占地最低自然高度`);
    assertTrue(a.floorY > a.minH, `seed ${seed} baseY 必须高于 minH（抬升才有地下裸露）`);
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

// ==================== 地形：自然起伏保留（v3.16 DR-2）====================

test('丛林要塞地形：surfaceYAt 内部非带列恒等自然高度 + 占地零水格（8 seed）', async () => {
  const data = await loadStructure('jungleFortress');
  noteJungleFortressData(data);
  for (const seedStr of Object.keys(FROZEN_ANCHORS)) {
    const seed = Number(seedStr);
    const a = computeJungleFortressAnchor(seed);
    // ⚠️⚠️ **必须先登记产物**（v3.16 Task 8 实测踩过的假绿）：
    //    不登记时 `surfaceYAt` 退回 nat，于是「全区恒等 nat」恒真 ——
    //    即使裙边真的在抬土也拓不到（单文件跑绿、全量跑红就是这么来的）。
    const field = jungleFortressSkirtField(a, seed, data);
    let mismatch = 0, water = 0, cols = 0, lifted = 0;
    for (let dx = -JUNGLE_FORTRESS_HALF_X - JUNGLE_FORTRESS_SLOPE_BAND;
      dx <= JUNGLE_FORTRESS_HALF_X + JUNGLE_FORTRESS_SLOPE_BAND; dx++) {
      for (let dz = -JUNGLE_FORTRESS_HALF_Z - JUNGLE_FORTRESS_SLOPE_BAND;
        dz <= JUNGLE_FORTRESS_HALF_Z + JUNGLE_FORTRESS_SLOPE_BAND; dz++) {
        const wx = a.wx + dx, wz = a.wz + dz;
        const t = jungleFortressSurfaceYAt(wx, wz, seed, a);
        assertTrue(t !== null, `(${wx},${wz}) surfaceYAt 不得返回 null（v3.16 恒有值）`);
        cols++;
        const h = generateHeight(wx, wz, seed);
        // ① **内部非过渡带且非建筑列**：恒 = 自然高度（基座可见率不降的前提）
        if (!field.inBand(dx, dz) && !field.isBuilding(dx, dz)) {
          if (t !== h) mismatch++;
        }
        // ② 过渡带只抬不削（裙边语义）
        assertTrue(t >= h, `(${wx},${wz}) 裙边只抬不削：T=${t} < nat=${h}`);
        if (t > h) lifted++;
        // ③ 零水格只对**占地内**成立（落点干燥判据保证）；16 格外延里本就有自然水域。
        if (Math.abs(dx) <= JUNGLE_FORTRESS_HALF_X && Math.abs(dz) <= JUNGLE_FORTRESS_HALF_Z
            && t <= SEA_Y) water++;
      }
    }
    assertEqual(mismatch, 0, `seed ${seed} 内部非带列地形必须零改动（实际 ${mismatch} 列 ≠ generateHeight）`);
    assertEqual(water, 0, `seed ${seed} 占地内必须零水格（实际 ${water} 列 ≤ SEA_Y）`);
    assertTrue(lifted > 100, `seed ${seed} 过渡带必须真的抬了土（实际 ${lifted} 列）—— 否则本用例对裙边无判别力`);
    assertTrue(cols > 30000, `seed ${seed} 管理区列数应 > 30000（实际 ${cols}）`);
  }
});

test('丛林要塞地形：自然起伏保留 —— 内部非带区相邻高差 ≤1 且确存起伏（8 seed）', async () => {
  // ⚠️ 旧用例钉「削平后高差≤1」，削平后恒 0 ⇒ 无判别力。
  // ⚠️⚠️ **v3.16 Task 8 修正口径**：裙边过渡带内本来就可能有「建筑列 T=nat
  //    紧邻抬升列」的跳变（那是建筑立面，不是地形悬崖）⇒ 相邻高差判据
  //    必须限定在**内部非带区**（那里恒 = nat，相邻高差就是自然地形的）。
  //    过渡带自身的平滑度由裙边专题用例（带内/带缝/外侧 ≤1）钉。
  const data = await loadStructure('jungleFortress');
  noteJungleFortressData(data);
  for (const seedStr of Object.keys(FROZEN_ANCHORS)) {
    const seed = Number(seedStr);
    const a = computeJungleFortressAnchor(seed);
    const field = jungleFortressSkirtField(a, seed, data);
    const HX = JUNGLE_FORTRESS_HALF_X, HZ = JUNGLE_FORTRESS_HALF_Z;
    const R = JUNGLE_FORTRESS_SKIRT_INNER;
    let maxJump = 0, nonFlat = 0, checked = 0;
    // 内部非带区 = 占地内缩 R 格
    for (let dx = -HX + R; dx <= HX - R; dx++) {
      for (let dz = -HZ + R; dz <= HZ - R; dz++) {
        const v = jungleFortressSurfaceYAt(a.wx + dx, a.wz + dz, seed, a);
        checked++;
        assertEqual(v, generateHeight(a.wx + dx, a.wz + dz, seed),
          `(${dx},${dz}) 内部非带区必须恒等自然高度`);
        for (const [ax, az] of [[1, 0], [0, 1]]) {
          const b = jungleFortressSurfaceYAt(a.wx + dx + ax, a.wz + dz + az, seed, a);
          const j = Math.abs(v - b);
          if (j > maxJump) maxJump = j;
          if (j !== 0) nonFlat++;
        }
      }
    }
    assertTrue(checked > 10000, `seed ${seed} 内部非带区样本量（实际 ${checked}）`);
    assertTrue(maxJump <= 1, `seed ${seed} 内部相邻高差必须 ≤1（实际 ${maxJump}）`);
    assertTrue(nonFlat > 1000, `seed ${seed} 必须保留自然起伏（实际非平相邻对 ${nonFlat}）`);
    assertTrue(field.inBand(HX, 0), '边缘列必须在过渡带内（口径自检）');
  }
});

test('丛林要塞地形：真实 GEN 后非建筑列地表逐格 == generateHeight（零削平）', async () => {
  const seed = 12345;
  const a = computeJungleFortressAnchor(seed);
  const reg = await buildDefaultRegistry();
  const data = await loadStructure('jungleFortress');
  // 产物含实心的列（这些列的地表会被建筑抬高，不属于「地形」口径）
  const builtCols = new Set();
  for (const b of data.blocks) {
    if (b.type !== 'air') builtCols.add(`${b.x},${b.z}`);
  }
  // 取横跨占地东缘的 column：既有建筑列也有纯自然列
  const cx = Math.floor((a.wx + JUNGLE_FORTRESS_HALF_X) / 16);
  const cz = Math.floor(a.wz / 16);
  const col = new ChunkColumn(cx, cz);
  fillColumn(col, seed, reg);
  carveCaves(col, seed, reg);
  const layouts = neighborRegionKeys(cx, cz)
    .map((k) => { const [rx, rz] = k.split(',').map(Number); return computeRegionLayout(rx, rz, seed); });
  await applyStructuresToColumn(col, seed, reg, layouts);
  const terrainIds = new Set(['stone', 'dirt', 'sand', 'grass', 'end_stone',
    'snow_grass', 'swamp_grass', 'moss'].map((n) => reg.idOf(n)));
  let checked = 0;
  for (let lx = 0; lx < 16; lx++) {
    for (let lz = 0; lz < 16; lz++) {
      const wx = cx * 16 + lx, wz = cz * 16 + lz;
      if (builtCols.has(`${wx - a.wx},${wz - a.wz}`)) continue;
      checked++;
      const h = generateHeight(wx, wz, seed);
      // ① 自然地表那格仍是 biome 材质（未被削掉、未被铺成其他材质）
      assertEqual(col.blocks[blockIndex(lx, h, lz)],
        reg.idOf(surfaceTypeOfBiome(getBiome(wx, wz, seed))),
        `(${wx},${wz}) 自然地表 h=${h} 处必须是 biome 材质`);
      // ② 地表以上不得有地形实心方块（削平不完全 / 填土都会在这里现形）
      for (let y = h + 1; y < WORLD_MAX_Y; y++) {
        const id = col.blocks[blockIndex(lx, y, lz)];
        assertTrue(!terrainIds.has(id),
          `(${wx},${wz}) y=${y} 不得有地形实心方块（实际 id=${id}）`);
      }
    }
  }
  assertTrue(checked > 0, `该 column 必须有非建筑列（实际 ${checked}）`);
});

test('丛林要塞植被管理区判定：inJungleFortressTerraform 含 16 格外延、区外恒假', () => {
  const a = computeJungleFortressAnchor(12345);
  const anchors = [a];
  assertTrue(inJungleFortressTerraform(a.wx, a.wz, anchors), '中心在管理区');
  const B = JUNGLE_FORTRESS_SLOPE_BAND;
  assertTrue(inJungleFortressTerraform(a.wx + JUNGLE_FORTRESS_HALF_X + B, a.wz, anchors),
    '16 格外延最外缘在管理区（闭区间）');
  assertTrue(!inJungleFortressTerraform(a.wx + JUNGLE_FORTRESS_HALF_X + B + 1, a.wz, anchors),
    '外延外一格不在管理区');
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

test('丛林要塞接线：管理区内地表 = surfaceYAt（真实 GEN 写入）', async () => {
  const seed = 12345;
  const a = computeJungleFortressAnchor(seed);
  const reg = await buildDefaultRegistry();
  // 取 16 格外延内的 column（只有自然地表 + 植被，没有结构方块，判据最干净）
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
      assertTrue(t !== null, `(${wx},${wz}) surfaceYAt 恒有值`);
      checked++;
      const want = reg.idOf(surfaceTypeOfBiome(getBiome(wx, wz, seed)));
      assertEqual(col.blocks[blockIndex(lx, t, lz)], want,
        `(${wx},${wz}) 地表必须是 surfaceYAt=${t} 处的 biome 材质`);
      // ⚠️ **v3.13b 语义**：用户要求空地植树植草 ⇒ target+1 可能是草/花/树干，
      //    不再恒为空气。钉「上方不得是 **地形实心方块**」——
      //    那才是「原山体未被削平 / 多填了土」的形态；植被与结构方块不算。
      const above = col.blocks[blockIndex(lx, t + 1, lz)];
      const terrainIds = new Set(['stone', 'dirt', 'sand', 'grass', 'end_stone',
        'snow_grass', 'swamp_grass', 'moss'].map((n) => reg.idOf(n)));
      assertTrue(!terrainIds.has(above),
        `(${wx},${wz}) 地表以上不得有地形实心方块（实际 id=${above}）`);
    }
  }
  assertTrue(checked > 0, `该 column 必须有管理区列（实际 ${checked}）`);
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
  // 「室外可长」与生产代码 jfCellFreeAt 同口径：非实心 且 不在屋顶下方 且 非地下房间/竖井 air。
  // ⚠️ **屋顶下方的 air 是室内房间**，那里本就不应长树 ⇒ 不得计入「误杀」。
  // ⚠️ v3.16：抬升后**露天竖井**会高出自然地表，它同属建筑内部（坑里不长草）。
  const jfRoomAir = new Set();
  for (const b of data.blocks) {
    if (b.type === 'air' && b.y < floorRowOf('jungleFortress')) jfRoomAir.add(`${b.x},${b.y},${b.z}`);
  }
  const isOutdoor = (px, ny, pz) => {
    const k = `${px},${ny},${pz}`;
    if (cellType.has(k) || jfRoomAir.has(k)) return false;
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
      // ⚠️ **意图集必须同步稀疏抽签**（v3.13e 密度减半）：否则把「被稀疏掉的树」
      //    的叶当成「被切割」（实测假红 1739 格）。转调生产代码的同一权威函数。
      if (!jfTreeKept(wx, wz, seed)) continue;
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

// ==================== 树密度减半（v3.13e，用户：「密度过于高了，密度减半」）====================
//
// ⚠️ **只降树，不降草**：用户只说树密度高。草/花仍照旧档。
// ⚠️ **不得改 `rollVegetation` 的 FOREST 概率**：那是全地图森林的共享权威，
//    改它会把世界各处森林一起砍半（超出请求范围）。只能在本结构分支加一道稀疏抽签。
// ⚠️ **判据要钉「大致减半」而不是「精确 50%」**：稀疏是逐列独立伯努利抽样，
//    有限样本下会在 50% 附近波动；钉精确值会 flaky。取 [0.40, 0.60] 区间。

test('丛林要塞：树密度减半（只降树、不降草，不改全地图 FOREST 概率）', async () => {
  const seed = 12345;
  const a = computeJungleFortressAnchor(seed);
  const reg = await buildDefaultRegistry();
  const data = await loadStructure('jungleFortress');
  const cellSolid = new Set();
  const roofTop = new Map();
  for (const b of data.blocks) {
    if (b.type === 'air') continue;
    cellSolid.add(`${b.x},${b.y},${b.z}`);
    const ck = `${b.x},${b.z}`;
    const prev = roofTop.get(ck);
    if (prev === undefined || b.y > prev) roofTop.set(ck, b.y);
  }
  const floorRow = floorRowOf('jungleFortress');
  const B = JUNGLE_FORTRESS_SLOPE_BAND;
  // v3.16：地下房间/竖井 air 属建筑内部（与生产代码 jfCellFreeAt 同口径）
  const jfRoomAir = new Set();
  for (const b of data.blocks) {
    if (b.type === 'air' && b.y < floorRow) jfRoomAir.add(`${b.x},${b.y},${b.z}`);
  }
  const outdoor = (px, ny, pz) => {
    const k = `${px},${ny},${pz}`;
    if (cellSolid.has(k) || jfRoomAir.has(k)) return false;
    const top = roofTop.get(`${px},${pz}`);
    return top === undefined || ny >= top;
  };
  // 基准：不加稀疏时应该有多少棵（直接问 rollVegetation）
  let plantable = 0, wouldTree = 0;
  const spots = [];
  for (let dx = -JUNGLE_FORTRESS_HALF_X - B; dx <= JUNGLE_FORTRESS_HALF_X + B; dx++) {
    for (let dz = -JUNGLE_FORTRESS_HALF_Z - B; dz <= JUNGLE_FORTRESS_HALF_Z + B; dz++) {
      const wx = a.wx + dx, wz = a.wz + dz;
      const s = jungleFortressSurfaceYAt(wx, wz, seed, a);
      if (s === null) continue;
      const ny = s + 1 - a.floorY + floorRow;
      if (!outdoor(dx, ny, dz)) continue;
      plantable++;
      if (rollVegetation(wx, wz, 'FOREST', seed).tree) { wouldTree++; spots.push({ wx, wz, y: s + 1 }); }
    }
  }
  assertTrue(plantable > 10000 && wouldTree > 400,
    `取样必须有量（可种 ${plantable} 列 / 基准树 ${wouldTree} 棵）`);
  // 真实 GEN：数树干列（只数「本来会种树」的那些列，口径与基准一致）
  const trunkIds = new Set(['wood', 'birch_log', 'giant_oak_log'].map((n) => reg.idOf(n)));
  const byCol = new Map();
  for (const q of spots) {
    const ck = `${Math.floor(q.wx / 16)},${Math.floor(q.wz / 16)}`;
    if (!byCol.has(ck)) byCol.set(ck, []);
    byCol.get(ck).push(q);
  }
  // ⚡ **有原理抽样**（v3.15）：本条是伯努利比值判据，没有「几何上不可能」的 column 可筛
  // （每个候选列都可能长树）⇒ 只能抽样，全量版另存一条 `tier:'slow'`。
  //
  // **抽样口径（无偏）**：按 column key 字典序排序后**等步长取**，而不是按 spot 数降序。
  // ⚠️ 按 spot 数降序会**系统性偏向密列** ⇒ ratio 有偏，那是「选了一个好看的样本」。
  // 等步长 + 字典序与树的空间分布无关（key 是坐标，与抽签独立）⇒ 无偏。
  //
  // **N 的统计依据**：判据半宽 0.10（ratio ∈ [0.40,0.60]），p≈0.5 时 σ=√(0.25/n)。
  // 实测全量：可种列 29277 / 基准树 1128 棵 / 跨 **146 个 column**（每列 1~17 个 spot，中位 8）。
  // 取步长 2 ⇒ 约 73 列 / 约 **560 个 spot** ⇒ σ≈0.021、4σ≈0.084 < 0.10 ⇒ 不会因抽样噪声 flaky。
  // **判据区间一字不改**（不是放宽阈值）；抽样后实测 ratio 见下方断言的报错文案。
  const SAMPLE_STRIDE = 2;
  const sampledKeys = [...byCol.keys()].sort().filter((_, i) => i % SAMPLE_STRIDE === 0);
  let actualTree = 0, sampledWould = 0;
  for (const ck of sampledKeys) {
    const list = byCol.get(ck);
    sampledWould += list.length;
    const [cx, cz] = ck.split(',').map(Number);
    const col = new ChunkColumn(cx, cz);
    fillColumn(col, seed, reg);
    carveCaves(col, seed);
    const layouts = neighborRegionKeys(cx, cz)
      .map((k) => { const [rx, rz] = k.split(',').map(Number); return computeRegionLayout(rx, rz, seed); });
    await applyStructuresToColumn(col, seed, reg, layouts);
    for (const q of list) {
      const lx = ((q.wx % 16) + 16) % 16, lz = ((q.wz % 16) + 16) % 16;
      if (trunkIds.has(col.blocks[blockIndex(lx, q.y, lz)])) actualTree++;
    }
  }
  // 样本量下界：低于它时 σ 太大，判据会 flaky ⇒ 宁可硬失败也不静默放宽
  assertTrue(sampledWould >= 400,
    `抽样样本量太小（${sampledWould} 个 spot）—— σ 会超出判据半宽，请减小 SAMPLE_STRIDE`);
  const ratio = actualTree / sampledWould;
  assertTrue(ratio >= 0.40 && ratio <= 0.60,
    `树密度必须大致减半：抽样基准 ${sampledWould} 棵 → 实际 ${actualTree} 棵（比值 ${ratio.toFixed(3)}，应在 0.40~0.60）`);
});

/**
 * 全量版（慢档，v3.15）：与上面抽样版**判据完全相同**，只是跑全部 146 个 column。
 *
 * 为什么要保留：抽样版的置信区间靠统计论证，而全量版是**确定性**的 ——
 * 「零判别力损失」要求它在提交前门（`npm test` → harness-slow.spec）仍然跑。
 * 实测全量约 11.3s。
 */
test('丛林要塞：树密度减半（全量 146 column，慢档）', async () => {
  const seed = 12345;
  const a = computeJungleFortressAnchor(seed);
  const reg = await buildDefaultRegistry();
  const data = await loadStructure('jungleFortress');
  const cellSolid = new Set();
  const roofTop = new Map();
  for (const b of data.blocks) {
    if (b.type === 'air') continue;
    cellSolid.add(`${b.x},${b.y},${b.z}`);
    const ck = `${b.x},${b.z}`;
    const prev = roofTop.get(ck);
    if (prev === undefined || b.y > prev) roofTop.set(ck, b.y);
  }
  const floorRow = floorRowOf('jungleFortress');
  const B = JUNGLE_FORTRESS_SLOPE_BAND;
  // v3.16：地下房间/竖井 air 属建筑内部（与生产代码 jfCellFreeAt 同口径）
  const jfRoomAir = new Set();
  for (const b of data.blocks) {
    if (b.type === 'air' && b.y < floorRow) jfRoomAir.add(`${b.x},${b.y},${b.z}`);
  }
  const outdoor = (px, ny, pz) => {
    const k = `${px},${ny},${pz}`;
    if (cellSolid.has(k) || jfRoomAir.has(k)) return false;
    const top = roofTop.get(`${px},${pz}`);
    return top === undefined || ny >= top;
  };
  let plantable = 0, wouldTree = 0;
  const spots = [];
  for (let dx = -JUNGLE_FORTRESS_HALF_X - B; dx <= JUNGLE_FORTRESS_HALF_X + B; dx++) {
    for (let dz = -JUNGLE_FORTRESS_HALF_Z - B; dz <= JUNGLE_FORTRESS_HALF_Z + B; dz++) {
      const wx = a.wx + dx, wz = a.wz + dz;
      const s = jungleFortressSurfaceYAt(wx, wz, seed, a);
      if (s === null) continue;
      const ny = s + 1 - a.floorY + floorRow;
      if (!outdoor(dx, ny, dz)) continue;
      plantable++;
      if (rollVegetation(wx, wz, 'FOREST', seed).tree) { wouldTree++; spots.push({ wx, wz, y: s + 1 }); }
    }
  }
  assertTrue(plantable > 10000 && wouldTree > 400,
    `取样必须有量（可种 ${plantable} 列 / 基准树 ${wouldTree} 棵）`);
  const trunkIds = new Set(['wood', 'birch_log', 'giant_oak_log'].map((n) => reg.idOf(n)));
  const byCol = new Map();
  for (const q of spots) {
    const ck = `${Math.floor(q.wx / 16)},${Math.floor(q.wz / 16)}`;
    if (!byCol.has(ck)) byCol.set(ck, []);
    byCol.get(ck).push(q);
  }
  let actualTree = 0;
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
      if (trunkIds.has(col.blocks[blockIndex(lx, q.y, lz)])) actualTree++;
    }
  }
  const ratio = actualTree / wouldTree;
  assertTrue(ratio >= 0.40 && ratio <= 0.60,
    `树密度必须大致减半：基准 ${wouldTree} 棵 → 实际 ${actualTree} 棵（比值 ${ratio.toFixed(3)}，应在 0.40~0.60）`);
}, { tier: 'slow' });

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
  // 「室外可长」= 该格非实心 且 不在屋顶下方 且 不是地下房间/竖井 air
  // （与生产代码 jfCellFreeAt 同口径；v3.16 补上最后一项 —— 抬升后露天竖井
  //   会高出自然地表，它属建筑内部而不是可长树的空地）
  const roomAir = new Set();
  for (const b of data.blocks) {
    if (b.type === 'air' && b.y < floorRowOf('jungleFortress')) roomAir.add(`${b.x},${b.y},${b.z}`);
  }
  const isOutdoor = (px, ny, pz) => {
    const k = `${px},${ny},${pz}`;
    if (cellSolid.has(k) || roomAir.has(k)) return false;
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
  // ⚠️⚠️ **v3.16 阀值重标**：地表从「削平到 floorY」改为自然高度后，贴墙候选列
  //    从数百缩到 **78**（实测 seed 12345），其中 `jfTreeKept`（密度减半）命中 **43**。
  //    旧阀值 `>100` 在新语义下**正确实现也恒红**（它钉的是旧候选池规模）。
  //    真意图仍是「贴墙树不被**整类**禁写」（列级缺陷下 hasTrunk === 0），
  //    故改钉「命中稀疏抽签的候选全部种下了」+ 「种下数量 >30」。
  const keptCount = probe.filter((q) => jfTreeKept(q.wx, q.wz, seed)).length;
  const byCol = new Map();
  for (const q of probe) {
    const ck = `${Math.floor(q.wx / 16)},${Math.floor(q.wz / 16)}`;
    if (!byCol.has(ck)) byCol.set(ck, []);
    byCol.get(ck).push(q);
  }
  let missingTrunk = 0, hasTrunk = 0, missingKept = 0;
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
      if (trunkIds.has(id)) hasTrunk++;
      else { missingTrunk++; if (jfTreeKept(q.wx, q.wz, seed)) missingKept++; }
    }
  }
  // ⚠️ **v3.13e 语义**：用户要求树密度减半 ⇒ 不能钉「每个候选列都有树」。
  //    本用例的真意图是「贴墙的树不被**整类**禁写」（列级判据的缺陷形态是 **hasTrunk === 0**）。
  //    「减半比例」由上两条独立用例钉，三条分工不重叠。
  assertEqual(missingKept, 0,
    `命中稀疏抽签的贴墙候选必须全部种下（实际漏种 ${missingKept} 棵）—— ` +
    '非零说明落点/让位判据把贴墙树挡掉了（与密度抽签无关）');
  assertTrue(hasTrunk > 30,
    `贴墙的树必须真的种下（实际 ${hasTrunk} 棵 / 抽签命中 ${keptCount}，未种 ${missingTrunk}）—— ` +
    '接近 0 说明落点判据退回列级，贴墙树整棵不生成 ⇒ 邻居树冠被空洞切平');
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

/**
 * 8 seed 冻结落点（占地东缘外 6 格，y = **自然地表 + 1**）。
 *
 * ⚠️ v3.16：地形不再削平，落点在裙边带外缘（T=nat）⇒ y 从 2~3 变为 5~6。
 *    要塞地板（baseY=9）比玩家高 3~4 格 ⇒ 抬头看要塞，正是「宏伟」的观感。
 */
const FROZEN_TELEPORT = {
  12345: [-218, 6, 217],
  99999: [-535, 6, -91],
  1249026: [-368, 6, 77],
  20260101: [-407, 5, 33],
  777: [-586, 5, 473],
  4242: [-282, 5, 165],
  31337: [-356, 5, 81],
  8888: [-527, 5, -87],
};

test('丛林要塞瞬移：8 个 seed 落点逐值命中冻结表（y 用自然地表+1）', () => {
  for (const [seedStr, [x, y, z]] of Object.entries(FROZEN_TELEPORT)) {
    const seed = Number(seedStr);
    const p = jungleFortressTeleportPoint(seed);
    assertTrue(p !== null, `seed ${seed} 必须有落点`);
    assertEqual(p.x, x, `seed ${seed} 落点 x`);
    assertEqual(p.y, y, `seed ${seed} 落点 y（v3.16 = 自然地表+1，不是 baseY+1）`);
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

test('丛林要塞瞬移：落点用 baseY+1 会悬空（判据必须有判别力）', () => {
  // ⚠️ v3.16 语义反转：旧用例钉「整形后 ≠ 自然」（那时地形被削平）；
  //    现在地形保留自然 ⇒ 落点 y **就是** 自然地表+1，而 baseY+1 会悬空。
  //    实测 8 seed：nat+1 = 5~6、baseY+1 = 10 ⇒ 悬空 4~5 格。
  let differ = 0, minGap = Infinity;
  for (const seedStr of Object.keys(FROZEN_TELEPORT)) {
    const seed = Number(seedStr);
    const a = computeJungleFortressAnchor(seed);
    const p = jungleFortressTeleportPoint(seed);
    const wrong = a.floorY + 1;
    if (wrong !== p.y) differ++;
    minGap = Math.min(minGap, wrong - p.y);
    assertEqual(p.y, generateHeight(p.x, p.z, seed) + 1,
      `seed ${seed} 落点 y 必须等于自然地表+1（落点在裙边带外缘，T=nat）`);
  }
  assertEqual(differ, 8,
    `8/8 seed 的 baseY+1 必须与正确落点不同（实际 ${differ} 个不同）—— ` +
    '否则「不得用 baseY+1」这条要求无法被判据守住');
  assertTrue(minGap >= 4,
    `用 baseY+1 至少悬空 4 格（实测最小差 ${minGap}）—— 低于它说明判据余量不够`);
});

// ==================== 石墩与漏底修补（v3.16 DR-3 / DR-4）====================

/**
 * 8 seed 墩冻结表：[墩格数, 墩列数, 单列最大墩高, 最密 column 墩格]
 * （spec §9，先用 t3-calib 在真实数据上逐值核对过）
 */
const FROZEN_PIERS = {
  12345: [12332, 3145, 21, 1069],
  99999: [13554, 3471, 21, 1433],
  777: [12748, 3208, 21, 1019],
  4242: [14339, 3686, 21, 1483],
  31337: [14220, 3614, 22, 1115],
  20260101: [13663, 3495, 22, 1234],
  1249026: [13462, 3439, 21, 861],
  8888: [14491, 3708, 22, 1005],
};

/**
 * 墩/漏底判据的共用夹具：真实 GEN 跑完占地全部 column，收集墩格与补格。
 *
 * ⚠️ 墩格认定用**位置**而不是材质：从产物逐列最低实心 ny 推出理论墩区间，
 *    再读世界方块确认。只用「mossy_stone 且不在产物格」会把建筑自身的 mossy_stone
 *    误计入（建筑主材就是它，46%）。
 */
async function jfPierFixture(seed) {
  const a = computeJungleFortressAnchor(seed);
  const reg = await buildDefaultRegistry();
  const data = await loadStructure('jungleFortress');
  const FR = floorRowOf('jungleFortress');
  const prodSolid = new Set(), prodAir = new Set();
  const colMinNy = new Map();
  for (const b of data.blocks) {
    const k3 = `${b.x},${b.y},${b.z}`;
    if (b.type === 'air') { prodAir.add(k3); continue; }
    prodSolid.add(k3);
    const ck = `${b.x},${b.z}`;
    const prev = colMinNy.get(ck);
    if (prev === undefined || b.y < prev) colMinNy.set(ck, b.y);
  }
  const roomAir = new Set();
  for (const k of prodAir) { const ny = Number(k.split(',')[1]); if (ny < FR) roomAir.add(k); }
  const roomFloor = new Set();
  for (const k of prodSolid) {
    const [x, ny, z] = k.split(',').map(Number);
    if (roomAir.has(`${x},${ny + 1},${z}`)) roomFloor.add(k);
  }
  // 真实 GEN：占地 + 1 圈的全部 column
  const cx0 = Math.floor((a.wx - JUNGLE_FORTRESS_HALF_X) / 16);
  const cx1 = Math.floor((a.wx + JUNGLE_FORTRESS_HALF_X) / 16);
  const cz0 = Math.floor((a.wz - JUNGLE_FORTRESS_HALF_Z) / 16);
  const cz1 = Math.floor((a.wz + JUNGLE_FORTRESS_HALF_Z) / 16);
  const world = new Map();   // "cx,cz" → ChunkColumn
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cz = cz0; cz <= cz1; cz++) {
      const col = new ChunkColumn(cx, cz);
      fillColumn(col, seed, reg);
      carveCaves(col, seed, reg);
      const layouts = neighborRegionKeys(cx, cz)
        .map((k) => { const [rx, rz] = k.split(',').map(Number); return computeRegionLayout(rx, rz, seed); });
      await applyStructuresToColumn(col, seed, reg, layouts);
      world.set(`${cx},${cz}`, col);
    }
  }
  const readWorld = (wx, wy, wz) => {
    const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
    const col = world.get(`${cx},${cz}`);
    if (!col) return undefined;
    return col.blocks[blockIndex(((wx % 16) + 16) % 16, wy, ((wz % 16) + 16) % 16)];
  };
  return { a, reg, data, FR, prodSolid, prodAir, roomAir, roomFloor, colMinNy, world, readWorld };
}

test('丛林要塞墩：8 seed 墩格数/列数/max/最密col 逐值命中冻结表', async () => {
  for (const [seedStr, want] of Object.entries(FROZEN_PIERS)) {
    const seed = Number(seedStr);
    const fx = await jfPierFixture(seed);
    const { a, reg, FR, colMinNy, readWorld } = fx;
    const mossy = reg.idOf('mossy_stone');
    let cells = 0, cols = 0, maxH = 0;
    const perColumn = new Map();
    for (const [ck, minNy] of colMinNy) {
      const [px, pz] = ck.split(',').map(Number);
      const wx = a.wx + px, wz = a.wz + pz;
      const baseWy = a.floorY + (minNy - FR);
      const h = generateHeight(wx, wz, seed);
      let n = 0;
      for (let wy = baseWy - 1; wy > h; wy--) {
        assertEqual(readWorld(wx, wy, wz), mossy,
          `seed ${seed} (${wx},${wy},${wz}) 墩格必须是 mossy_stone`);
        n++;
        const colKey = `${Math.floor(wx / 16)},${Math.floor(wz / 16)}`;
        perColumn.set(colKey, (perColumn.get(colKey) || 0) + 1);
      }
      if (n > 0) { cells += n; cols++; maxH = Math.max(maxH, n); }
    }
    const topCol = Math.max(...perColumn.values());
    assertEqual(cells, want[0], `seed ${seed} 墩格数`);
    assertEqual(cols, want[1], `seed ${seed} 墩列数`);
    assertEqual(maxH, want[2], `seed ${seed} 单列最大墩高`);
    assertEqual(topCol, want[3], `seed ${seed} 最密 column 墩格数`);
  }
}, { tier: 'slow' });

test('丛林要塞墩：不覆盖产物（含 air）、不穿地下房间、顶被建筑盖住、底坐实地表', async () => {
  const seed = 12345;
  const fx = await jfPierFixture(seed);
  const { a, reg, FR, prodSolid, prodAir, roomAir, colMinNy, readWorld } = fx;
  const mossy = reg.idOf('mossy_stone');
  let checked = 0, topCovered = 0, botOnGround = 0, pierCols = 0;
  for (const [ck, minNy] of colMinNy) {
    const [px, pz] = ck.split(',').map(Number);
    const wx = a.wx + px, wz = a.wz + pz;
    const baseWy = a.floorY + (minNy - FR);
    const h = generateHeight(wx, wz, seed);
    if (baseWy - 1 <= h) continue;
    pierCols++;
    for (let wy = baseWy - 1; wy > h; wy--) {
      const ny = wy - a.floorY + FR;
      const k3 = `${px},${ny},${pz}`;
      checked++;
      assertTrue(!prodSolid.has(k3) && !prodAir.has(k3),
        `墩格 (${px},${ny},${pz}) 不得与产物任何格重叠（含 air）`);
      assertTrue(!roomAir.has(k3), `墩格 (${px},${ny},${pz}) 不得穿地下房间`);
    }
    // 顶：墩顶正上方必须是产物实心（从上方看不到墩顶）
    if (prodSolid.has(`${px},${minNy},${pz}`)) topCovered++;
    // 底：墩底正下方 = 自然地表那格，且它是实心（carveCaves top=h−4 ⇒ 地表恒实心）
    assertEqual(readWorld(wx, h, wz) !== 0, true,
      `(${wx},${wz}) 墩底下方地表 h=${h} 必须是实心`);
    botOnGround++;
    // 墩底下一格不得是墩（不多补）
    assertTrue(readWorld(wx, h, wz) !== mossy || prodSolid.has(`${px},${h - a.floorY + FR},${pz}`),
      `(${wx},${h},${wz}) 地表那格不得是多补的墩`);
  }
  assertTrue(checked > 10000, `墩格样本量（实际 ${checked}）`);
  assertEqual(topCovered, pierCols, `全部墩列顶面必须被建筑盖住（${topCovered}/${pierCols}）`);
  assertEqual(botOnGround, pierCols, '全部墩列必须坐在自然地表上');
});

test('丛林要塞漏底：修补后地下房间 air / 房间地板下方第一格恒实心（8 seed）', async () => {
  for (const seedStr of Object.keys(FROZEN_PIERS)) {
    const seed = Number(seedStr);
    const fx = await jfPierFixture(seed);
    const { a, FR, prodSolid, prodAir, roomAir, roomFloor, readWorld } = fx;
    let leak = 0, checked = 0;
    for (const k of [...roomAir, ...roomFloor]) {
      const [px, ny, pz] = k.split(',').map(Number);
      const belowKey = `${px},${ny - 1},${pz}`;
      // 下方是产物格（实心或 air）⇒ 不属于漏底口径（air 是房间竖井，正常）
      if (prodSolid.has(belowKey) || prodAir.has(belowKey)) continue;
      checked++;
      const wy = a.floorY + (ny - 1 - FR);
      assertTrue(readWorld(a.wx + px, wy, a.wz + pz) !== 0,
        `seed ${seed} 房间格 (${px},${ny},${pz}) 下方 wy=${wy} 必须被补实（否则地板漏空）`);
      if (readWorld(a.wx + px, wy, a.wz + pz) === 0) leak++;
    }
    assertEqual(leak, 0, `seed ${seed} 零漏底`);
    assertTrue(checked > 0, `seed ${seed} 必须有非产物下方的房间格样本（实际 ${checked}）`);
  }
}, { tier: 'slow' });

test('丛林要塞漏底：修补格不得填死产物 air（房间竖井），且补的那一格材质是 stone', async () => {
  // seed 4242 是漏底最深的 seed（实测迭代 9 轮 / 49 格）⇒ 判别力最强
  const seed = 4242;
  const fx = await jfPierFixture(seed);
  const { a, reg, FR, prodSolid, prodAir, roomAir, roomFloor, readWorld } = fx;
  const stone = reg.idOf('stone');
  let patched = 0, shaftSeen = 0, shaftFilled = 0;
  for (const k of [...roomAir, ...roomFloor]) {
    const [px, ny, pz] = k.split(',').map(Number);
    const bk = `${px},${ny - 1},${pz}`;
    if (prodSolid.has(bk)) continue;
    const wy = a.floorY + (ny - 1 - FR);
    const id = readWorld(a.wx + px, wy, a.wz + pz);
    if (prodAir.has(bk)) {
      // 竖井：正常。判据是「它仍是空气（没被填死）」，
      // ⚠️ **不是「没遇到竖井」**：产物里本就有 1101 处「房间格下方是产物 air」
      //    的相邻关系（实测），钉「零遇到」在正确实现下也恒红。
      shaftSeen++;
      if (id !== 0) shaftFilled++;
      continue;
    }
    // ⚠️ **只钉「房间正下方第一格」**，不往下逐层遍历：
    //    往下走会穿过整个天然岩层（fillColumn 的 stone/end_stone 交替），
    //    把那些本来就在的地层方块误当成「补格」⇒ 材质断言假红（实测 id=37 end_stone）。
    if (id === stone) patched++;
  }
  assertTrue(shaftSeen > 100, `必须真的遇到足量竖井相邻关系（实际 ${shaftSeen}）—— 否则无判别力`);
  assertEqual(shaftFilled, 0, `产物 air（房间竖井）不得被填死（实际被填 ${shaftFilled} 格）`);
  assertTrue(patched > 0, `seed 4242 必须真的有补格（实际 ${patched}）—— 否则本用例无判别力`);
});

// ==================== 观感验收：地下可见率 / 地上被埋率（v3.16 DR-5）====================
//
// 用户诉求：「地下部分可以一部分裸露，让地上部分因高低差更真实宏伟」。
// 这组用例是**诉求本身的验收**：若 baseY 退回 minH（不抬升），可见率全归 0。
//
// ⚠️ 钉**区间**不钉精确值（逐列几何判定换 seed 会漂）；区间取自 8 seed 实测极值外扩。
// ⚠️ 可见判据必须含**水平四邻至少一侧地表低于它**：只判「高于地表」会把被邻列
//    地形挡住的格也算成可见（本仓地形相邻高差恒 ≤1 时两者相等，换公式后失效）。

/** 产物分类冻结格数（spec §2.4，红坡无关 —— 只依赖产物） */
const JF_CAT = { base: 30227, shell: 1321, roomAir: 1017, shaft: 577, above: 29165 };

/**
 * 把产物逐格分为五类（纯产物几何，不依赖 seed）：
 *   base    地下实心且不邻地下房间 air（纯基座/柱）
 *   shell   地下实心且六邻有地下房间 air（房间外壳）
 *   roomAir 地下 air 且上方有顶盖（封闭房间内腔）
 *   shaft   地下 air 且上方无顶盖（露天竖井）
 *   above   地上实心 dy>0（真埋墙口径，dy0 地板层不算）
 */
function jfCategories(data, G) {
  const cat = new Map();
  const counts = { base: 0, shell: 0, roomAir: 0, shaft: 0, above: 0 };
  for (const b of data.blocks) {
    const k = `${b.x},${b.y},${b.z}`;
    if (b.type === 'air') {
      if (b.y >= G.floorRow) continue;
      const hasRoof = G.colMaxNy.get(`${b.x},${b.z}`) > b.y;
      const c = hasRoof ? 'roomAir' : 'shaft';
      cat.set(k, c); counts[c]++;
      continue;
    }
    if (b.y >= G.floorRow) {
      if (b.y > G.floorRow) { cat.set(k, 'above'); counts.above++; }
      continue;
    }
    let adj = false;
    for (const d of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) {
      if (G.roomAir.has(`${b.x + d[0]},${b.y + d[1]},${b.z + d[2]}`)) { adj = true; break; }
    }
    const c = adj ? 'shell' : 'base';
    cat.set(k, c); counts[c]++;
  }
  return { cat, counts };
}

test('丛林要塞观感：产物五类格数命中冻结值（分类口径自身的守卫）', async () => {
  const data = await loadStructure('jungleFortress');
  const G = jungleFortressGeometry(data);
  const { counts } = jfCategories(data, G);
  for (const [k, want] of Object.entries(JF_CAT)) {
    assertEqual(counts[k], want, `分类 ${k} 格数`);
  }
});

test('丛林要塞观感：地下基座/外壳可见率、房间/竖井露出率、地上墙被埋率均在冻结区间（8 seed）', async () => {
  const data = await loadStructure('jungleFortress');
  const G = jungleFortressGeometry(data);
  const { cat, counts } = jfCategories(data, G);
  for (const seedStr of Object.keys(FROZEN_PIERS)) {
    const seed = Number(seedStr);
    const fx = await jfPierFixture(seed);
    const { a, FR, readWorld } = fx;
    const hC = new Map();
    const nat = (px, pz) => {
      const k = `${px},${pz}`;
      let v = hC.get(k);
      if (v === undefined) { v = generateHeight(a.wx + px, a.wz + pz, seed); hC.set(k, v); }
      return v;
    };
    const isVis = (px, wy, pz) => wy > nat(px, pz) &&
      (nat(px + 1, pz) < wy || nat(px - 1, pz) < wy || nat(px, pz + 1) < wy || nat(px, pz - 1) < wy);
    let visBase = 0, visShell = 0, expRoom = 0, expShaft = 0, burAbove = 0;
    for (const [k, c] of cat) {
      const [px, ny, pz] = k.split(',').map(Number);
      const wy = a.floorY + (ny - FR);
      const h = nat(px, pz);
      if (c === 'above') { if (wy <= h) burAbove++; continue; }
      if (c === 'roomAir' || c === 'shaft') {
        if (wy > h) { if (c === 'roomAir') expRoom++; else expShaft++; }
        continue;
      }
      if (wy <= h) continue;
      // 世界里那一格必须真的非空（未被墩/植被改写）
      const id = readWorld(a.wx + px, wy, a.wz + pz);
      if (!id) continue;
      if (!isVis(px, wy, pz)) continue;
      if (c === 'base') visBase++; else visShell++;
    }
    const pct = (n, d) => n / d * 100;
    const inRange = (v, lo, hi, label) => assertTrue(v >= lo && v <= hi,
      `seed ${seed} ${label} = ${v.toFixed(1)}% 应在 [${lo},${hi}]`);
    // 区间取自 8 seed 实测极值外扩（基座 41.7~48.7 / 外壳 31.3~37.2 /
    // 房间 20.3~29.8 / 竖井 47.3~71.6 / 埋墙 8.1~15.7）
    inRange(pct(visBase, counts.base), 40, 50, '地下基座可见率');
    inRange(pct(visShell, counts.shell), 30, 39, '地下房间外壳可见率');
    inRange(pct(expRoom, counts.roomAir), 19, 31, '封闭房间 air 露出率');
    inRange(pct(expShaft, counts.shaft), 45, 75, '露天竖井 air 露出率');
    // ⚠️ 埋墙分母是 **dy>0 的 29165 格**（spec DR-5 的 9.7% 用的是含 dy0 的 34154，
    //    两个口径不同）；本用例用前者，实测 8.1~15.7% ⇒ 区间 [7,17]。
    inRange(pct(burAbove, counts.above), 7, 17, '地上墙真被埋率(dy>0)');
    // 下界守卫：抬升真的发生了（baseY=minH 时这五项全 0）
    assertTrue(visBase > 10000, `seed ${seed} 可见基座格数必须 >10000（实际 ${visBase}）`);
  }
}, { tier: 'slow' });

// ==================== 接壤阶梯过渡裙边（v3.16 DR-10，用户追加裁定）====================
//
// 用户：「最终丛林要塞的地界和旁边的地图接壤的地方，都要有一个接壤区域的阶梯过渡，
// 不要出现陡峭的悬崖突变。」
//
// ⚠️ 三屏障（建筑列/保护列/湿列）缺一即静默退化：
//    只外侧 ⇒ 内侧自然列与外侧裙边间留 9~11 格沟槽；
//    只内部 ⇒ 基座被埋回去（可见率 45.8%→22.2%）；
//    抬保护列 ⇒ 露出地下 air 被埋；抬湿列 ⇒ 假水面（红线 1）。

/** 8 seed 裙边填方冻结：[填内格, 填内列, 填外格, 填外列, 总格]（spec §9） */
const FROZEN_SKIRT = {
  12345: [546, 151, 1950, 504, 2496],
  99999: [648, 167, 2450, 595, 3098],
  777: [605, 161, 1988, 498, 2593],
  4242: [723, 183, 2554, 551, 3277],
  31337: [695, 176, 2306, 554, 3001],
  20260101: [654, 169, 2361, 576, 3015],
  1249026: [645, 166, 2440, 596, 3085],
  8888: [725, 183, 2489, 579, 3214],
};

/** 裙边判据夹具：取包络场 + 三类屏障集合（与生产代码共用同一份派生） */
async function jfSkirtFixture(seed) {
  const a = computeJungleFortressAnchor(seed);
  const data = await loadStructure('jungleFortress');
  noteJungleFortressData(data);      // 纯查询路径也要能拿到 T（不依赖 GEN 跑过）
  const field = jungleFortressSkirtField(a, seed, data);
  return { a, data, field };
}

test('丛林要塞裙边：常量冻结 R=12 / BW=22（换地形公式后需重标，不得静默改）', () => {
  assertEqual(JUNGLE_FORTRESS_SKIRT_INNER, 12, '内侧宽度 R');
  assertEqual(JUNGLE_FORTRESS_SKIRT_OUTER, 22, '外侧宽度 BW');
});

test('丛林要塞裙边：带内/带缝/外侧地面相邻高差 ≤1（8 seed）', async () => {
  const HX = JUNGLE_FORTRESS_HALF_X, HZ = JUNGLE_FORTRESS_HALF_Z;
  const BW = JUNGLE_FORTRESS_SKIRT_OUTER;
  for (const seedStr of Object.keys(FROZEN_SKIRT)) {
    const seed = Number(seedStr);
    const { field } = await jfSkirtFixture(seed);
    const { T, nat, inBand, inFootprint, isBuilding, isProtected, isWet } = field;
    let bandMax = 0, seamMax = 0, outMax = 0;
    // ① 带内：非建筑非保护非湿列相邻
    for (let x = -HX - BW; x <= HX + BW; x++) {
      for (let z = -HZ - BW; z <= HZ + BW; z++) {
        if (!inBand(x, z)) continue;
        for (const [dx, dz] of [[1, 0], [0, 1]]) {
          const nx = x + dx, nz = z + dz;
          if (!inBand(nx, nz)) continue;
          if (isBuilding(x, z) || isBuilding(nx, nz)) continue;
          if (isProtected(x, z) || isProtected(nx, nz) || isWet(x, z) || isWet(nx, nz)) continue;
          bandMax = Math.max(bandMax, Math.abs(T(x, z) - T(nx, nz)));
        }
      }
    }
    // ② 带缝：带内缘 ↔ 内部自然列
    for (let x = -HX; x <= HX; x++) {
      for (let z = -HZ; z <= HZ; z++) {
        if (!inBand(x, z)) continue;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, nz = z + dz;
          if (!inFootprint(nx, nz) || inBand(nx, nz)) continue;
          if (isBuilding(x, z) || isBuilding(nx, nz)) continue;
          if (isProtected(x, z) || isProtected(nx, nz) || isWet(x, z) || isWet(nx, nz)) continue;
          seamMax = Math.max(seamMax, Math.abs(T(x, z) - nat(nx, nz)));
        }
      }
    }
    // ③ 外侧：占地外非湿列相邻
    for (let x = -HX - BW; x <= HX + BW; x++) {
      for (let z = -HZ - BW; z <= HZ + BW; z++) {
        if (inFootprint(x, z)) continue;
        for (const [dx, dz] of [[1, 0], [0, 1]]) {
          const nx = x + dx, nz = z + dz;
          if (nx > HX + BW || nz > HZ + BW || inFootprint(nx, nz)) continue;
          if (isWet(x, z) || isWet(nx, nz)) continue;
          outMax = Math.max(outMax, Math.abs(T(x, z) - T(nx, nz)));
        }
      }
    }
    assertTrue(bandMax <= 1, `seed ${seed} 带内相邻高差必须 ≤1（实际 ${bandMax}）`);
    assertTrue(seamMax <= 1, `seed ${seed} 带缝相邻高差必须 ≤1（实际 ${seamMax}）`);
    assertTrue(outMax <= 1, `seed ${seed} 外侧相邻高差必须 ≤1（实际 ${outMax}）`);
  }
}, { tier: 'slow' });

test('丛林要塞裙边：不盖建筑、保护列零抬升、湿列零抬升（8 seed）', async () => {
  for (const seedStr of Object.keys(FROZEN_SKIRT)) {
    const seed = Number(seedStr);
    const { field } = await jfSkirtFixture(seed);
    const { T, nat, isBuilding, isProtected, isWet, bounds } = field;
    let buildLift = 0, protLift = 0, wetLift = 0, checked = 0;
    for (let x = bounds.x0; x <= bounds.x1; x++) {
      for (let z = bounds.z0; z <= bounds.z1; z++) {
        checked++;
        const d = T(x, z) - nat(x, z);
        if (isBuilding(x, z) && d > 0) buildLift++;
        if (isProtected(x, z) && d > 0) protLift++;
        if (isWet(x, z) && d > 0) wetLift++;
      }
    }
    assertTrue(checked > 30000, `样本量（实际 ${checked}）`);
    assertEqual(buildLift, 0, `seed ${seed} 建筑列零抬升（裙边不盖建筑）`);
    assertEqual(protLift, 0, `seed ${seed} 保护列零抬升（不埋露出地下 air）`);
    assertEqual(wetLift, 0, `seed ${seed} 湿列零抬升（防假水面，红线 1）`);
  }
}, { tier: 'slow' });

test('丛林要塞裙边：露出地下 air 零被埋（8 seed，均 602 格仍露）', async () => {
  for (const seedStr of Object.keys(FROZEN_SKIRT)) {
    const seed = Number(seedStr);
    const { a, data, field } = await jfSkirtFixture(seed);
    const G = jungleFortressGeometry(data);
    const { T, nat } = field;
    let stillExp = 0, buried = 0;
    for (const k of G.roomAir) {
      const [x, ny, z] = k.split(',').map(Number);
      const wy = a.floorY + (ny - G.floorRow);
      if (wy <= nat(x, z)) continue;                 // 本来就埋着，不算裙边埋的
      if (T(x, z) < wy) stillExp++; else buried++;
    }
    assertEqual(buried, 0, `seed ${seed} 裙边不得埋掉任何本来露出的地下 air`);
    assertTrue(stillExp > 500, `seed ${seed} 仍露出的地下 air 应 >500 格（实际 ${stillExp}）`);
  }
}, { tier: 'slow' });

test('丛林要塞裙边：填方格数/列数逐值命中冻结表（8 seed）', async () => {
  for (const [seedStr, want] of Object.entries(FROZEN_SKIRT)) {
    const seed = Number(seedStr);
    const { field } = await jfSkirtFixture(seed);
    const { T, nat, inFootprint, bounds } = field;
    let fi = 0, fic = 0, fo = 0, foc = 0;
    for (let x = bounds.x0; x <= bounds.x1; x++) {
      for (let z = bounds.z0; z <= bounds.z1; z++) {
        const d = T(x, z) - nat(x, z);
        if (d <= 0) continue;
        if (inFootprint(x, z)) { fi += d; fic++; } else { fo += d; foc++; }
      }
    }
    assertEqual(fi, want[0], `seed ${seed} 填内格数`);
    assertEqual(fic, want[1], `seed ${seed} 填内列数`);
    assertEqual(fo, want[2], `seed ${seed} 填外格数`);
    assertEqual(foc, want[3], `seed ${seed} 填外列数`);
    assertEqual(fi + fo, want[4], `seed ${seed} 裙边总格数`);
  }
}, { tier: 'slow' });

test('丛林要塞裙边：真实 GEN 写入 —— 顶面 biome 材质 / 下方 dirt（FOREST）', async () => {
  const seed = 12345;
  const { a, field } = await jfSkirtFixture(seed);
  const reg = await buildDefaultRegistry();
  const { T, nat, inFootprint, isBuilding } = field;
  const dirt = reg.idOf('dirt');
  // 取一个含外侧裙边抬升列的 column（东缘外）
  const HX = JUNGLE_FORTRESS_HALF_X;
  let target = null;
  for (let x = HX + 1; x <= HX + JUNGLE_FORTRESS_SKIRT_OUTER && !target; x++) {
    for (let z = -20; z <= 20; z++) {
      if (T(x, z) > nat(x, z) && !isBuilding(x, z)) { target = { x, z }; break; }
    }
  }
  assertTrue(target !== null, '必须找到外侧裙边抬升列（否则无判别力）');
  const wx = a.wx + target.x, wz = a.wz + target.z;
  const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
  const col = new ChunkColumn(cx, cz);
  fillColumn(col, seed, reg);
  carveCaves(col, seed, reg);
  const layouts = neighborRegionKeys(cx, cz)
    .map((k) => { const [rx, rz] = k.split(',').map(Number); return computeRegionLayout(rx, rz, seed); });
  await applyStructuresToColumn(col, seed, reg, layouts);
  const lx = ((wx % 16) + 16) % 16, lz = ((wz % 16) + 16) % 16;
  const top = T(target.x, target.z), h = nat(target.x, target.z);
  assertTrue(top > h, '该列必须真的被抬升');
  assertEqual(col.blocks[blockIndex(lx, top, lz)],
    reg.idOf(surfaceTypeOfBiome(getBiome(wx, wz, seed))),
    `裙边顶面必须是 biome 地表材质（不是 mossy_stone）`);
  for (let y = h + 1; y < top; y++) {
    assertEqual(col.blocks[blockIndex(lx, y, lz)], dirt, `裙边下方 y=${y} 必须是 dirt`);
  }
  assertTrue(!inFootprint(target.x, target.z), '本用例取的是外侧列');
});

test('丛林要塞裙边：surfaceYAt 就是包络场 T（唯一权威，内部非带列仍 = nat）', async () => {
  const seed = 12345;
  const { a, field } = await jfSkirtFixture(seed);
  const { T, nat, inBand, isBuilding } = field;
  let checkedLift = 0, checkedInner = 0;
  for (let x = -JUNGLE_FORTRESS_HALF_X; x <= JUNGLE_FORTRESS_HALF_X; x += 7) {
    for (let z = -JUNGLE_FORTRESS_HALF_Z; z <= JUNGLE_FORTRESS_HALF_Z; z += 7) {
      const s = jungleFortressSurfaceYAt(a.wx + x, a.wz + z, seed, a);
      assertEqual(s, T(x, z), `(${x},${z}) surfaceYAt 必须等于包络场 T`);
      if (T(x, z) > nat(x, z)) checkedLift++;
      if (!inBand(x, z) && !isBuilding(x, z)) {
        assertEqual(s, nat(x, z), `(${x},${z}) 内部非带列必须仍是自然高度`);
        checkedInner++;
      }
    }
  }
  assertTrue(checkedLift > 0, `抽样必须含抬升列（实际 ${checkedLift}）`);
  assertTrue(checkedInner > 100, `抽样必须含内部非带列（实际 ${checkedInner}）`);
});

// ==================== 植被让位含墩+裙边（v3.16 DR-3 / DR-10）====================

/**
 * 墩格 / 裙边格集合（判据用，从产物 + 包络场派生）。
 *
 * ⚠️ 这是**判据侧的独立派生**，不读生产代码的让位索引 ——
 *    两边共用同一份索引会让「索引漏含墩/裙边」恒真（同口径陷阱）。
 */
async function jfVegObstacleCells(seed) {
  const a = computeJungleFortressAnchor(seed);
  const data = await loadStructure('jungleFortress');
  noteJungleFortressData(data);
  const G = jungleFortressGeometry(data);
  const field = jungleFortressSkirtField(a, seed, data);
  const { T, nat, isBuilding } = field;
  // ⚠️ 裙边扫描范围必须用 **BW=22**，不是植被管理区的 16：
  //    用 16 会漏掉外圈 6 格的裙边（实测样本从 123 掉到 11）。
  const B = JUNGLE_FORTRESS_SKIRT_OUTER;
  const pier = new Set(), skirt = new Set();
  for (const [ck, minNy] of G.colMinNy) {
    const [px, pz] = ck.split(',').map(Number);
    const baseWy = a.floorY + (minNy - G.floorRow);
    const h = nat(px, pz);
    for (let wy = baseWy - 1; wy > h; wy--) pier.add(`${px},${wy - a.floorY + G.floorRow},${pz}`);
  }
  for (let x = -JUNGLE_FORTRESS_HALF_X - B; x <= JUNGLE_FORTRESS_HALF_X + B; x++) {
    for (let z = -JUNGLE_FORTRESS_HALF_Z - B; z <= JUNGLE_FORTRESS_HALF_Z + B; z++) {
      if (isBuilding(x, z)) continue;
      const top = T(x, z), h = nat(x, z);
      for (let wy = h + 1; wy <= top; wy++) skirt.add(`${x},${wy - a.floorY + G.floorRow},${z}`);
    }
  }
  return { a, data, G, field, pier, skirt };
}

test('丛林要塞植被：树冠意图格落在墩/裙边上时，真实 GEN 不得写入植被', async () => {
  const seed = 12345;
  const { a, G, pier, skirt } = await jfVegObstacleCells(seed);
  const reg = await buildDefaultRegistry();
  const B = JUNGLE_FORTRESS_SLOPE_BAND;
  // 用**真实 generateTree** 收集意图格（v3.13c 口径），并同步稀疏抽签（v3.13e）
  const intent = new Map();
  for (let dx = -JUNGLE_FORTRESS_HALF_X - B; dx <= JUNGLE_FORTRESS_HALF_X + B; dx++) {
    for (let dz = -JUNGLE_FORTRESS_HALF_Z - B; dz <= JUNGLE_FORTRESS_HALF_Z + B; dz++) {
      const wx = a.wx + dx, wz = a.wz + dz;
      const s = jungleFortressSurfaceYAt(wx, wz, seed, a);
      const roll = rollVegetation(wx, wz, 'FOREST', seed);
      if (!roll.tree || roll.tree.type === 'birchTree' || roll.tree.type === 'birchTreeWithSnow') continue;
      if (!jfTreeKept(wx, wz, seed)) continue;
      generateTree(wx, s + 1, wz, (x, y, z, name) => intent.set(`${x},${y},${z}`, name),
        seed, roll.tree.type, roll.tree.customLog || null, roll.tree.customLeaf || null, roll.tree.leafMix || null);
    }
  }
  assertTrue(intent.size > 10000, `树冠意图格必须有量（实际 ${intent.size}）`);
  const probe = [];
  for (const k of intent.keys()) {
    const [wx, y, wz] = k.split(',').map(Number);
    const ck = `${wx - a.wx},${y - a.floorY + G.floorRow},${wz - a.wz}`;
    if (pier.has(ck)) probe.push({ wx, y, wz, isPier: true });
    else if (skirt.has(ck)) probe.push({ wx, y, wz, isPier: false });
  }
  // 样本量下界（修复 surfaceYAt 后的**正确态**实测，seed 12345）：
  //   意图∩墩 = 763（树冠从旁边伸进墩身）、意图∩裙边 = 11。
  // ⚠️ 裙边交集小是**正确行为**：树已种在裙边顶面之上（surfaceYAt=T），
  //    只有邻列树冠横伸过来才会落在裙边格上。
  //    （缺陷态下 surfaceYAt 返 nat ⇒ 树种在填土里 ⇒ 交集虚高到 123。）
  assertTrue(probe.filter((p) => p.isPier).length > 300,
    `必须有足量「意图格落在墩上」样本（实际 ${probe.filter((p) => p.isPier).length}）`);
  assertTrue(probe.filter((p) => !p.isPier).length > 5,
    `必须有「意图格落在裙边上」样本（实际 ${probe.filter((p) => !p.isPier).length}）`);
  const vegIds = new Set(['leaves', 'yellow_leaves', 'realistic_yellow_leaves',
    'azalea_leaves', 'azalea_flowers', 'swamp_leaves', 'snow_leaves', 'sky_leaves',
    'giant_oak_leaves', 'giant_spruce_leaves', 'giant_palm_leaves', 'giant_banyan_leaves',
    'giant_birch_leaves', 'wood', 'birch_log', 'giant_oak_log']
    .map((n) => reg.idOf(n)).filter((v) => v != null));
  const byCol = new Map();
  for (const p of probe) {
    const ck = `${Math.floor(p.wx / 16)},${Math.floor(p.wz / 16)}`;
    if (!byCol.has(ck)) byCol.set(ck, []);
    byCol.get(ck).push(p);
  }
  let vegInPier = 0, vegInSkirt = 0;
  for (const [ck, list] of byCol) {
    const [cx, cz] = ck.split(',').map(Number);
    const col = new ChunkColumn(cx, cz);
    fillColumn(col, seed, reg);
    carveCaves(col, seed, reg);
    const layouts = neighborRegionKeys(cx, cz)
      .map((k) => { const [rx, rz] = k.split(',').map(Number); return computeRegionLayout(rx, rz, seed); });
    await applyStructuresToColumn(col, seed, reg, layouts);
    for (const p of list) {
      const lx = ((p.wx % 16) + 16) % 16, lz = ((p.wz % 16) + 16) % 16;
      const id = col.blocks[blockIndex(lx, p.y, lz)];
      if (!vegIds.has(id)) continue;
      if (p.isPier) vegInPier++; else vegInSkirt++;
    }
  }
  assertEqual(vegInPier, 0, `树冠/树干不得穿墩（实测 ${vegInPier} 格）`);
  assertEqual(vegInSkirt, 0, `树冠/树干不得穿裙边填土（实测 ${vegInSkirt} 格）`);
}, { tier: 'slow' });

test('丛林要塞植被：草/树干落点 y = surfaceYAt + 1（裙边后地面，不是 nat）', async () => {
  const seed = 12345;
  const { a, field } = await jfVegObstacleCells(seed);
  const { T, nat, isBuilding } = field;
  const reg = await buildDefaultRegistry();
  const B = JUNGLE_FORTRESS_SLOPE_BAND;
  // 取「裙边抬升且抽签命中草」的列：用 nat+1 会把草埋在填土里
  const spots = [];
  for (let dx = -JUNGLE_FORTRESS_HALF_X - B; dx <= JUNGLE_FORTRESS_HALF_X + B; dx++) {
    for (let dz = -JUNGLE_FORTRESS_HALF_Z - B; dz <= JUNGLE_FORTRESS_HALF_Z + B; dz++) {
      if (isBuilding(dx, dz)) continue;
      if (T(dx, dz) <= nat(dx, dz)) continue;
      const wx = a.wx + dx, wz = a.wz + dz;
      const roll = rollVegetation(wx, wz, 'FOREST', seed);
      if (!roll.plant) continue;
      spots.push({ wx, wz, top: T(dx, dz), h: nat(dx, dz), name: roll.plant });
    }
  }
  assertTrue(spots.length > 20, `必须有足量「裙边抬升列 + 抽签命中植物」样本（实际 ${spots.length}）`);
  const byCol = new Map();
  for (const p of spots) {
    const ck = `${Math.floor(p.wx / 16)},${Math.floor(p.wz / 16)}`;
    if (!byCol.has(ck)) byCol.set(ck, []);
    byCol.get(ck).push(p);
  }
  let onTop = 0, buried = 0;
  for (const [ck, list] of byCol) {
    const [cx, cz] = ck.split(',').map(Number);
    const col = new ChunkColumn(cx, cz);
    fillColumn(col, seed, reg);
    carveCaves(col, seed, reg);
    const layouts = neighborRegionKeys(cx, cz)
      .map((k) => { const [rx, rz] = k.split(',').map(Number); return computeRegionLayout(rx, rz, seed); });
    await applyStructuresToColumn(col, seed, reg, layouts);
    for (const p of list) {
      const lx = ((p.wx % 16) + 16) % 16, lz = ((p.wz % 16) + 16) % 16;
      const want = reg.idOf(p.name);
      if (col.blocks[blockIndex(lx, p.top + 1, lz)] === want) onTop++;
      // 用 nat+1 的错误口径：那一格已被裙边填土占掉 ⇒ 植物不得在那里
      if (p.h + 1 <= p.top && col.blocks[blockIndex(lx, p.h + 1, lz)] === want) buried++;
    }
  }
  assertTrue(onTop > 0, `裙边顶面之上必须真的种了植物（实际 ${onTop}）`);
  assertEqual(buried, 0, `植物不得被埋在裙边填土里（实测 ${buried} 格用了 nat+1 口径）`);
}, { tier: 'slow' });
