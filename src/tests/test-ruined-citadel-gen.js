// src/tests/test-ruined-citadel-gen.js — 废弃堡垒（Ruined Citadel）Tier 1：锚点纯函数 + 真实 column GEN
//
// 权威：docs/superpowers/specs/2026-11-10-ruined-citadel-port-design.md
//
// 钉的是这几类缺陷（每条都是静默的）：
//   · `STRUCTURE_FILES` 漏映射 → `rasterizeStructure` 拿到空 blocks 直接 return（0 格，无报错）
//   · **空气格漏写**（spec DR-2 核心失效路径）→ 天然岩层填满地牢，22.6 万格白搬。
//     格数/类型/指纹全对，只有挖下去才发现 ⇒ 必须断言「地牢房间格是 air」
//   · 锚点不唯一 / 不确定 → 同一 seed 两次算出不同落点（红线 2）
//   · **城市净距方向写反**（本结构在城西，判据是 `wx + HALF_X < city.minX - CLEARANCE`）
//     → 8/8 seed 全部返回 null（9ms 就退出），结构永不生成
//   · **水约束漏掉**（占地 + 外扩 4 格干燥）→ 海面平面（y=-1.5）切进甲板下方，
//     从地牢往上看是「水天花板」；体素水也可能灌进占地
//   · apply 阶段 2.94 漏了 / y 差一格 → 结构被地形覆盖或整体沉浮
//   · 空岛没让路 → 空岛在阶段 2.5 **后写胜**，反过来打穿塔楼
//
// ⚠️ 断言落点一律是**真实 applyStructuresToColumn 写出的世界方块**，不是纯函数返回值
// （M7 教训：只测纯函数会漏接线）。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import {
  computeRuinedCitadelAnchor, inRuinedCitadelFootprint, ruinedCitadelOverlapsRegion,
  ruinedCitadelSuppressedLandmarks, ruinedCitadelCandidateValid, ruinedCitadelTeleportPoint,
  RUINED_CITADEL_HEIGHT, RUINED_CITADEL_MAX_SPAN, RUINED_CITADEL_SPANS,
  RUINED_CITADEL_DRY_MARGIN, RUINED_CITADEL_TELEPORT_GAP,
  clearRuinedCitadelCache,
} from '../gen/structures/ruined-citadel.js';
import { RUINED_CITADEL_HALF_X, RUINED_CITADEL_HALF_Z } from '../gen/structures/ruined-citadel-data.js';
import { computeRegionLayout, neighborRegionKeys } from '../gen/structures/structure-layout.js';
import { applyStructuresToColumn } from '../gen/structures/apply.js';
import { STRUCTURE_FILES, loadStructure, floorRowOf } from '../gen/structures/structure-json.js';
import { buildDefaultRegistry } from '../voxel/block-registry.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { blockIndex, SEA_Y, WORLD_MIN_Y, WORLD_MAX_Y } from '../voxel/constants.js';
import { fillColumn, generateHeight } from '../gen/terrain.js';
import { carveCaves } from '../gen/caves.js';
import { getBiome } from '../gen/noise.js';
import { getCityBoundsForSeed } from '../gen/structures/city-layout.js';
import { computeShallowTarnAnchor, SHALLOW_TARN_OUTER_RADIUS } from '../gen/structures/shallow-water-tarns.js';
import { computeArenaAnchor, ARENA_HALF_X, ARENA_HALF_Z } from '../gen/structures/arena.js';
import { computeBurningArenaAnchor, BURNING_ARENA_HALF } from '../gen/structures/burning-arena.js';
import { isTarnZone, computeTarnZone, TARN_ZONE_RADIUS } from '../gen/structures/tarn-zone.js';
import { REGION_SIZE, CITY_TRANSITION_SIZE } from '../gen/structures/region-config.js';

const SEED = 12345;

/**
 * spec §2.5 的 8 seed 锚点表（**冻结实测值**，含全部避让项 + 水约束）。
 *
 * ⚠️ 这张表是「必须且唯一 + 城西最近 + 干燥」三条判据的联合冻结：任一判据写错
 * （方向反了、粗筛用 ceil、水约束漏掉、避让项少一个）都会让某个 seed 的锚点漂移或变 null。
 */
const ANCHORS = Object.freeze({
  12345: { wx: -469, wz: -71, floorY: -1, span: 5 },
  99999: { wx: -338, wz: 197, floorY: 4, span: 5 },
  1249026: { wx: -619, wz: 365, floorY: -1, span: 5 },
  20260101: { wx: -218, wz: 313, floorY: 4, span: 5 },
  777: { wx: -397, wz: 177, floorY: 4, span: 5 },
  4242: { wx: -85, wz: 445, floorY: 4, span: 5 },
  31337: { wx: -167, wz: 361, floorY: 4, span: 5 },
  8888: { wx: -154, wz: 201, floorY: -1, span: 5 },
});
/**
 * ⚠️ **必须用显式有序数组，不能用 `Object.keys(ANCHORS)`**：JS 对整数型对象键
 * 按**数值升序**遍历（插入顺序丢失），而本表要按 spec §2.5 的书写顺序逐行核对。
 * （探针实测：`Object.keys` 首个是 777 不是 12345。）
 */
const SEEDS = [12345, 99999, 1249026, 20260101, 777, 4242, 31337, 8888];

/** 产物冻结数字（与 `tools/ruined-citadel-fingerprint.mjs` 的 METRICS 同源，此处独立钉住） */
const FLOOR_ROW = 45;
const CONTENT_CELLS = 288744;
const AIR_CELLS = 27060;
/** 产物包围盒（含甲板下空气）：x ∈ [-53,53]、z ∈ [-55,54]、y ∈ [1,63] */
const PRODUCT_W = 107;
const PRODUCT_D = 110;

/** 与 Worker 真实路径一致的完整 GEN（fillColumn + caves + applyStructures，不含 edits/light） */
async function genColumn(reg, cx, cz, seed = SEED) {
  const col = new ChunkColumn(cx, cz);
  fillColumn(col, seed, reg);
  carveCaves(col, seed);
  await applyStructuresToColumn(col, seed, reg, layoutsFor(cx, cz, seed));
  return col;
}

/**
 * 生成废弃堡垒占地跨的全部 column（**带缓存**，整个测试文件共用一份）。
 *
 * ⚠️ **必须缓存**：每个 column 的 `applyStructuresToColumn` 都会对 288,744 格结构做
 * 完整光栅化。占地 107×110 跨 9×9 = 81 个 column，不缓存而逐用例重生 = 上千万次
 * setBlock × 用例数，会拖垮 harness 的 150s 窗口（大竞技场 36 column × 115,381 格
 * 已把套件从 63.6s 推到 75.9s，本结构是它的 5.6 倍）。
 *
 * @returns {Promise<Map<string, ChunkColumn>>} 键 = `${cx},${cz}`
 */
let _footprintCols = null;
async function footprintColumns(reg) {
  if (_footprintCols) return _footprintCols;
  const a = computeRuinedCitadelAnchor(SEED);
  const ccx = Math.floor(a.wx / 16), ccz = Math.floor(a.wz / 16);
  const rColsX = Math.ceil((RUINED_CITADEL_HALF_X + 2) / 16);
  const rColsZ = Math.ceil((RUINED_CITADEL_HALF_Z + 2) / 16);
  const map = new Map();
  for (let dcx = -rColsX; dcx <= rColsX; dcx++) {
    for (let dcz = -rColsZ; dcz <= rColsZ; dcz++) {
      const cx = ccx + dcx, cz = ccz + dcz;
      map.set(`${cx},${cz}`, await genColumn(reg, cx, cz));
    }
  }
  _footprintCols = map;
  return map;
}

/** 从缓存的 footprint column 读世界格（越界返回 0） */
function readFootprint(cols, wx, wy, wz) {
  // ⚠️ y 越界（< WORLD_MIN_Y 或 >= WORLD_MAX_Y）必须返回 0，不能落到 typed array 的
  //    负索引/超界索引（那会读出 undefined，而不是「这一层不存在」的 0）。
  //    「底部越界格被裁掉」用例正是靠它读 floorY-44（< -32）那一层。
  if (wy < WORLD_MIN_Y || wy >= WORLD_MAX_Y) return 0;
  const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
  const col = cols.get(`${cx},${cz}`);
  if (!col) return 0;
  return col.blocks[blockIndex(wx - cx * 16, wy, wz - cz * 16)];
}

/** 查询域内的邻域布局（与 StructureIndex 下发的 3×3 邻域一致） */
function layoutsFor(cx, cz, seed = SEED) {
  const out = [];
  for (const key of neighborRegionKeys(cx, cz)) {
    const [rx, rz] = key.split(',').map(Number);
    out.push(computeRegionLayout(rx, rz, seed));
  }
  return out;
}

/**
 * 产物局部坐标 → 世界坐标（seed 12345 的锚点）。
 * 落位公式与 apply.js 阶段 2.94 同源：`wy = floorY + (ny - floorRow)`。
 */
function toWorld(a, px, ny, pz) {
  return { wx: a.wx + px, wy: a.floorY + (ny - FLOOR_ROW), wz: a.wz + pz };
}

// ==================== 产物注册与加载 ====================

test('废弃堡垒：STRUCTURE_FILES 登记了 ruinedCitadel', () => {
  assertEqual(STRUCTURE_FILES.ruinedCitadel, 'ruined_citadel.json',
    'ruinedCitadel 必须映射到 ruined_citadel.json（漏登记 → rasterizeStructure 静默 0 格）');
});

test('废弃堡垒：产物可加载且尺寸/格数/floorRow 与冻结值一致', async () => {
  const data = await loadStructure('ruinedCitadel');
  assertEqual(data.blocks.length, CONTENT_CELLS,
    `产物格数必须是 ${CONTENT_CELLS}（实际 ${data.blocks.length}；为 0 说明未登记或 fetch 失败）`);
  assertEqual(floorRowOf('ruinedCitadel'), FLOOR_ROW, `floorRow 必须是 ${FLOOR_ROW}`);

  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity, mnz = Infinity, mxz = -Infinity;
  for (const b of data.blocks) {
    if (b.x < mnx) mnx = b.x; if (b.x > mxx) mxx = b.x;
    if (b.y < mny) mny = b.y; if (b.y > mxy) mxy = b.y;
    if (b.z < mnz) mnz = b.z; if (b.z > mxz) mxz = b.z;
  }
  // ⚠️ 产物包围盒（含甲板下空气）比**非空气 footprint** 各撑出 1 格：
  //    空气伸到 x=-53 / z=-55，而非空气只到 x∈[-52,53] / z∈[-53,54]。两者是不同概念。
  assertEqual(mxx - mnx + 1, PRODUCT_W, `产物 X 跨度 ${PRODUCT_W}（含甲板下空气）`);
  assertEqual(mxz - mnz + 1, PRODUCT_D, `产物 Z 跨度 ${PRODUCT_D}（含甲板下空气）`);
  assertEqual(mxy - mny + 1, RUINED_CITADEL_HEIGHT, `Y 跨度 ${RUINED_CITADEL_HEIGHT}`);
  assertEqual(mny, 1, '归一化后最低层 y=1（rasterizeStructure 按 b.y 落位）');
  assertEqual(mxx, RUINED_CITADEL_HALF_X, `产物 x 上界 = HALF_X（${RUINED_CITADEL_HALF_X}）`);
  assertEqual(mxz, RUINED_CITADEL_HALF_Z, `产物 z 上界 = HALF_Z（${RUINED_CITADEL_HALF_Z}）`);
});

test('废弃堡垒：非空气 footprint 半宽 = HALF_X/HALF_Z（锚点搜索与避让的口径）', async () => {
  const data = await loadStructure('ruinedCitadel');
  let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
  for (const b of data.blocks) {
    if (b.type === 'air') continue;   // 空气不参与 footprint（它只是清空格）
    if (b.x < mnx) mnx = b.x; if (b.x > mxx) mxx = b.x;
    if (b.z < mnz) mnz = b.z; if (b.z > mxz) mxz = b.z;
  }
  // ⚠️ 这两个值才是 `RUINED_CITADEL_HALF_X/Z` 的依据（106×108 非空气 bbox）。
  //    用产物 bbox（107×110）当 footprint 会让干燥判据/避让/压制各多算 1 格。
  assertEqual(Math.max(-mnx, mxx), RUINED_CITADEL_HALF_X,
    `非空气 x 半宽必须 = HALF_X ${RUINED_CITADEL_HALF_X}（实际 x∈[${mnx},${mxx}]）`);
  assertEqual(Math.max(-mnz, mxz), RUINED_CITADEL_HALF_Z,
    `非空气 z 半宽必须 = HALF_Z ${RUINED_CITADEL_HALF_Z}（实际 z∈[${mnz},${mxz}]）`);
});

// ==================== DR-2：空气格必须写进产物（本结构特有的核心守卫）====================

test('废弃堡垒：palette 含 air 且 air 格数 = 27,060（spec DR-2 唯一守卫）', async () => {
  const data = await loadStructure('ruinedCitadel');
  const air = data.blocks.filter((b) => b.type === 'air');
  assertEqual(air.length, AIR_CELLS,
    `甲板以下空气必须全部写进产物（实际 ${air.length}，冻结 ${AIR_CELLS}）。` +
    '为 0 = 空气被当天空丢弃 ⇒ fillColumn/carveCaves 会用天然岩层填满地牢，22.6 万格白搬');
  // 空气必须全在甲板层及以下（ny ≤ floorRow）：甲板以上是天空，刻意不写
  let aboveDeck = 0;
  for (const b of air) if (b.y > FLOOR_ROW) aboveDeck++;
  assertEqual(aboveDeck, 0,
    `甲板以上（ny>${FLOOR_ROW}）不得有空气格（实际 ${aboveDeck}）—— 那是天空，写了 JSON 会从 3.7MB 涨到 17MB+`);
});

test('废弃堡垒：地牢房间在产物里是 air，且被结构体包围（不是天空漏进来的）', async () => {
  const data = await loadStructure('ruinedCitadel');
  const at = new Map(data.blocks.map((b) => [`${b.x},${b.y},${b.z}`, b.type]));
  // 祭坛区已知坐标（产物局部）：虚空灯 (2,21,-2) 上方的房间空气
  const ROOM_SAMPLES = [[2, 24, -2], [2, 26, -2], [2, 32, -2], [0, 24, -2], [4, 24, -2]];
  for (const [x, y, z] of ROOM_SAMPLES) {
    assertEqual(at.get(`${x},${y},${z}`), 'air',
      `地牢房间格 (${x},${y},${z}) 必须是 air（实际 ${at.get(`${x},${y},${z}`) ?? '(产物无此格)'}）`);
  }
  // 房间空气的下方必须是结构体（否则它是从底部漏进来的天空，不是房间）
  assertEqual(at.get('2,18,-2'), 'end_stone', '祭坛区 ny=18 应是 end_stone 锥体（房间的地基）');
  assertEqual(at.get('2,21,-2'), 'ochre_froglight', '虚空灯位 (2,21,-2) 应是 ochre_froglight');
});

// ==================== 锚点：必须且唯一（用户裁定）====================

test('废弃堡垒锚点：8 个 seed 逐值命中 spec §2.5 冻结表', () => {
  for (const seed of SEEDS) {
    const a = computeRuinedCitadelAnchor(seed);
    assertTrue(a !== null, `seed ${seed} 必须有落点（用户裁定「城西最近的干燥沙漠必须且唯一生成」）`);
    const want = ANCHORS[seed];
    assertEqual(a.wx, want.wx, `seed ${seed} 锚点 wx（冻结 ${want.wx}）`);
    assertEqual(a.wz, want.wz, `seed ${seed} 锚点 wz（冻结 ${want.wz}）`);
    assertEqual(a.floorY, want.floorY, `seed ${seed} floorY（冻结 ${want.floorY}）`);
    assertEqual(a.span, want.span, `seed ${seed} span（冻结 ${want.span}）`);
  }
});

test('废弃堡垒锚点：确定性（同 seed 重复调用逐位相同，跨 memo 清空也相同）', () => {
  for (const seed of SEEDS) {
    const a = computeRuinedCitadelAnchor(seed);
    const b = computeRuinedCitadelAnchor(seed);
    assertEqual(JSON.stringify(a), JSON.stringify(b), `seed ${seed} memo 命中路径一致`);
    clearRuinedCitadelCache();
    const c = computeRuinedCitadelAnchor(seed);
    assertEqual(JSON.stringify(a), JSON.stringify(c),
      `seed ${seed} 清空 memo 后重算仍一致（红线 2：锚点必须是 seed 的纯函数）`);
  }
});

test('废弃堡垒锚点：在 City 西侧且与城市 bounds 有净距', () => {
  for (const seed of SEEDS) {
    const a = computeRuinedCitadelAnchor(seed);
    const city = getCityBoundsForSeed(seed);
    // ⚠️ **方向是城西**：整个占地要在城市西界之外。大竞技场在城东，判据是
    //    `wx - HALF > city.maxX`；照抄那行会让本结构 8/8 seed 全部返回 null（spec §2.5 的坑）。
    assertTrue(a.wx + RUINED_CITADEL_HALF_X < city.minX,
      `seed ${seed} 整个占地必须在城西（占地东缘 ${a.wx + RUINED_CITADEL_HALF_X} vs 城市西界 ${city.minX}）`);
    assertTrue(city.minX - (a.wx + RUINED_CITADEL_HALF_X) >= CITY_TRANSITION_SIZE,
      `seed ${seed} 与城市净距 ≥ ${CITY_TRANSITION_SIZE}（实际 ${city.minX - (a.wx + RUINED_CITADEL_HALF_X)}）`);
  }
});

test('废弃堡垒锚点：占地 106×108 全是 DESERT 且高于海平面', () => {
  for (const seed of SEEDS) {
    const a = computeRuinedCitadelAnchor(seed);
    let nonDesert = 0, belowSea = 0;
    for (let dz = -RUINED_CITADEL_HALF_Z; dz <= RUINED_CITADEL_HALF_Z; dz++) {
      for (let dx = -RUINED_CITADEL_HALF_X; dx <= RUINED_CITADEL_HALF_X; dx++) {
        if (getBiome(a.wx + dx, a.wz + dz, seed) !== 'DESERT') nonDesert++;
        if (generateHeight(a.wx + dx, a.wz + dz, seed) <= SEA_Y) belowSea++;
      }
    }
    assertEqual(nonDesert, 0, `seed ${seed} 占地内非沙漠格数（实际 ${nonDesert}）`);
    assertEqual(belowSea, 0, `seed ${seed} 占地内低于海平面格数（实际 ${belowSea}）`);
  }
});

// ==================== 水约束（v2 新增，用户裁定 ⑦）====================

test('废弃堡垒锚点：占地 + 外扩 4 格每格干燥（水约束，spec §2.10）', () => {
  // ⚠️ **逐格实测，不是只查锚点**：本引擎的水有两处来源 ——
  //   ① 体素水：`fillColumn` 仅在 `generateHeight < SEA_Y` 的列填水；
  //   ② 海面平面：`ocean.js` 在 y=-1.5 渲染，遮罩五点取样 ±3.5 格。
  // 外扩 4 格（= ceil(3.5)）同时堵住两者。漏掉这条 ⇒ 甲板（floorY=-1 时顶面 y=0）下方
  // 0.5 格处会切出一片假水面，从地牢往上看是「水天花板」。
  for (const seed of SEEDS) {
    const a = computeRuinedCitadelAnchor(seed);
    const M = RUINED_CITADEL_DRY_MARGIN;
    assertEqual(M, 4, `干燥外扩必须是 4 格（= ceil(OCEAN_MASK_OFFSET 3.5)，实际 ${M}）`);
    let wet = 0;
    let firstWet = null;
    for (let dz = -(RUINED_CITADEL_HALF_Z + M); dz <= RUINED_CITADEL_HALF_Z + M; dz++) {
      for (let dx = -(RUINED_CITADEL_HALF_X + M); dx <= RUINED_CITADEL_HALF_X + M; dx++) {
        if (generateHeight(a.wx + dx, a.wz + dz, seed) > SEA_Y) continue;
        wet++;
        if (!firstWet) firstWet = { dx, dz, h: generateHeight(a.wx + dx, a.wz + dz, seed) };
      }
    }
    assertEqual(wet, 0,
      `seed ${seed} 占地+${M} 格内不得有湿列（实际 ${wet} 格，首个 ${JSON.stringify(firstWet)}）`);
  }
});

test('废弃堡垒锚点：占地内地表高差在放宽档位内（「相对平坦」）', () => {
  const maxSpan = RUINED_CITADEL_SPANS[RUINED_CITADEL_SPANS.length - 1];
  for (const seed of SEEDS) {
    const a = computeRuinedCitadelAnchor(seed);
    let minH = Infinity, maxH = -Infinity;
    for (let dz = -RUINED_CITADEL_HALF_Z; dz <= RUINED_CITADEL_HALF_Z; dz++) {
      for (let dx = -RUINED_CITADEL_HALF_X; dx <= RUINED_CITADEL_HALF_X; dx++) {
        const h = generateHeight(a.wx + dx, a.wz + dz, seed);
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
    }
    assertTrue(maxH - minH <= maxSpan,
      `seed ${seed} 地表高差 ${maxH - minH} 必须 ≤ ${maxSpan}（实测 span=${a.span}）`);
    assertTrue(a.span <= RUINED_CITADEL_MAX_SPAN,
      `seed ${seed} span ${a.span} 必须 ≤ 最严可行档 ${RUINED_CITADEL_MAX_SPAN}`);
    assertEqual(a.floorY, minH, `seed ${seed} floorY 必须是占地内最低地表（落位基准）`);
  }
});

test('废弃堡垒锚点：是「最近」的那个（不存在更近的合法候选）', () => {
  // 判别力判据：在锚点与城市之间（更近处）逐点扫，不得存在另一个合法落点。
  // 若排序写错（例如按 x 而不是按距离）、或粗筛用 ceil 误杀了更近的合法点，这条会拓到。
  //
  // ⚠️ **合法性判据必须转调 `ruinedCitadelCandidateValid`**（搜索侧同一份，红线 1），
  // 不得在测试里自己写一份「沙漠+平坦+干燥」：大竞技场实测踩过 —— 自写判据漏了城市净空，
  // 把被城市挡掉的点当成「更近的合法候选」报假 FAIL。
  for (const seed of SEEDS) {
    const a = computeRuinedCitadelAnchor(seed);
    const city = getCityBoundsForSeed(seed);
    const cityCx = Math.round((city.minX + city.maxX) / 2);
    const cityCz = Math.round((city.minZ + city.maxZ) / 2);
    const dAnchor = Math.hypot(a.wx - cityCx, a.wz - cityCz);
    let closer = null;
    // 与搜索同一个窗（城西起点 + ±900 纬度）、同一个步长（8 格）
    const x1 = city.minX - RUINED_CITADEL_HALF_X - CITY_TRANSITION_SIZE;
    for (let x = x1; x >= a.wx; x -= 8) {
      for (let z = cityCz - 900; z <= cityCz + 900; z += 8) {
        const d = Math.hypot(x - cityCx, z - cityCz);
        if (d >= dAnchor) continue;
        // 用锚点自己的 span 档（更严）：若更近处有同档合法点，说明排序/粗筛错了
        if (!ruinedCitadelCandidateValid(x, z, a.span, seed).ok) continue;
        closer = { x, z, d: +d.toFixed(1), dAnchor: +dAnchor.toFixed(1) };
        break;
      }
      if (closer) break;
    }
    assertEqual(closer, null,
      `seed ${seed} 不得存在比锚点更近的合法候选（找到 ${JSON.stringify(closer)}）`);
  }
});

test('废弃堡垒锚点：不与地基级大结构重叠（含大竞技场 / 围场 / 浅水高台 / 高台地带）', () => {
  for (const seed of SEEDS) {
    const a = computeRuinedCitadelAnchor(seed);
    // 大竞技场（城东，v2.85）—— 本结构在城西，理论上不可能撞，但判据必须真的在跑
    const ba = computeBurningArenaAnchor(seed);
    if (ba) {
      assertTrue(Math.abs(ba.wx - a.wx) > BURNING_ARENA_HALF + RUINED_CITADEL_HALF_X ||
                 Math.abs(ba.wz - a.wz) > BURNING_ARENA_HALF + RUINED_CITADEL_HALF_Z,
        `seed ${seed} 与大竞技场 AABB 不得相交`);
    }
    // 浅水高台
    const st = computeShallowTarnAnchor(seed);
    if (st) {
      const gap = Math.hypot(st.wx - a.wx, st.wz - a.wz);
      assertTrue(gap > SHALLOW_TARN_OUTER_RADIUS + RUINED_CITADEL_HALF_X,
        `seed ${seed} 与浅水高台净距 ${gap.toFixed(1)} 必须 > ${SHALLOW_TARN_OUTER_RADIUS + RUINED_CITADEL_HALF_X}`);
    }
    // 围场（原小竞技场，城南门外）
    const ar = computeArenaAnchor(seed);
    if (ar) {
      assertTrue(Math.abs(ar.wx - a.wx) > ARENA_HALF_X + RUINED_CITADEL_HALF_X ||
                 Math.abs(ar.wz - a.wz) > ARENA_HALF_Z + RUINED_CITADEL_HALF_Z,
        `seed ${seed} 与围场 AABB 不得相交`);
    }
    // 高台地带（扫占地触及的全部 region）
    const rxLo = Math.floor((a.wx - RUINED_CITADEL_HALF_X) / REGION_SIZE);
    const rxHi = Math.floor((a.wx + RUINED_CITADEL_HALF_X) / REGION_SIZE);
    const rzLo = Math.floor((a.wz - RUINED_CITADEL_HALF_Z) / REGION_SIZE);
    const rzHi = Math.floor((a.wz + RUINED_CITADEL_HALF_Z) / REGION_SIZE);
    for (let rx = rxLo; rx <= rxHi; rx++) {
      for (let rz = rzLo; rz <= rzHi; rz++) {
        if (!isTarnZone(rx, rz, seed)) continue;
        const t = computeTarnZone(rx, rz, seed);
        if (!t) continue;
        const overlap = Math.abs(t.cx - a.wx) <= TARN_ZONE_RADIUS + RUINED_CITADEL_HALF_X &&
                        Math.abs(t.cz - a.wz) <= TARN_ZONE_RADIUS + RUINED_CITADEL_HALF_Z;
        assertEqual(overlap, false, `seed ${seed} 不得与地带 region(${rx},${rz}) 的圆重叠`);
      }
    }
  }
});

// ==================== 占地判据与 region 裁剪 ====================

test('废弃堡垒：inRuinedCitadelFootprint 边界精确（±HALF 内、外一格 false）', () => {
  const a = { wx: 100, wz: 200 };
  assertEqual(inRuinedCitadelFootprint(100, 200, [a]), true, '中心');
  // ⚠️ x/z 半宽不同（53/54），必须分别钉
  assertEqual(inRuinedCitadelFootprint(100 + RUINED_CITADEL_HALF_X, 200, [a]), true, '东缘 +HALF_X');
  assertEqual(inRuinedCitadelFootprint(100 + RUINED_CITADEL_HALF_X + 1, 200, [a]), false, '东缘外 +1');
  assertEqual(inRuinedCitadelFootprint(100 - RUINED_CITADEL_HALF_X, 200, [a]), true, '西缘 -HALF_X');
  assertEqual(inRuinedCitadelFootprint(100 - RUINED_CITADEL_HALF_X - 1, 200, [a]), false, '西缘外 -1');
  assertEqual(inRuinedCitadelFootprint(100, 200 + RUINED_CITADEL_HALF_Z, [a]), true, '南缘 +HALF_Z');
  assertEqual(inRuinedCitadelFootprint(100, 200 + RUINED_CITADEL_HALF_Z + 1, [a]), false, '南缘外 +1');
  assertEqual(inRuinedCitadelFootprint(100, 200 - RUINED_CITADEL_HALF_Z, [a]), true, '北缘 -HALF_Z');
  assertEqual(inRuinedCitadelFootprint(100, 200 - RUINED_CITADEL_HALF_Z - 1, [a]), false, '北缘外 -1');
  assertEqual(inRuinedCitadelFootprint(0, 0, null), false, 'null anchors 不抛');
  assertEqual(inRuinedCitadelFootprint(0, 0, [null, a]), false, '数组含 null 项要跳过');
});

test('废弃堡垒：ruinedCitadelOverlapsRegion 让跨 region 的占地被邻区携带', () => {
  const a = computeRuinedCitadelAnchor(SEED);
  const rx = Math.floor(a.wx / REGION_SIZE), rz = Math.floor(a.wz / REGION_SIZE);
  assertEqual(ruinedCitadelOverlapsRegion(a, rx, rz), true, '锚点所在 region 必须携带');
  assertEqual(ruinedCitadelOverlapsRegion(a, 99, 99), false, '远处 region 不携带（省 payload）');
  assertEqual(ruinedCitadelOverlapsRegion(null, rx, rz), false, 'null 锚点不抛');
  // 107×110 可跨 2×2 region：至少一个邻居 region 也要携带（否则占地缺半边）
  let carried = 0;
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    if (ruinedCitadelOverlapsRegion(a, rx + dx, rz + dz)) carried++;
  }
  assertTrue(carried >= 1, `3×3 邻域内携带锚点的 region 数 ${carried} ≥ 1`);
});

test('废弃堡垒：layout.ruinedCitadel 只在相交 region 出现，且与锚点同源', () => {
  const a = computeRuinedCitadelAnchor(SEED);
  let seen = 0;
  const rx0 = Math.floor(a.wx / REGION_SIZE), rz0 = Math.floor(a.wz / REGION_SIZE);
  for (let rx = rx0 - 3; rx <= rx0 + 3; rx++) {
    for (let rz = rz0 - 3; rz <= rz0 + 3; rz++) {
      const l = computeRegionLayout(rx, rz, SEED).ruinedCitadel;
      if (l) {
        seen++;
        assertEqual(l.wx, a.wx, `region(${rx},${rz}) 携带的锚点 wx 与全局锚点一致`);
        assertEqual(l.wz, a.wz, `region(${rx},${rz}) 携带的锚点 wz 与全局锚点一致`);
        assertEqual(ruinedCitadelOverlapsRegion(a, rx, rz), true,
          `region(${rx},${rz}) 携带锚点 ⇒ 必须真的相交`);
      } else {
        assertEqual(ruinedCitadelOverlapsRegion(a, rx, rz), false,
          `region(${rx},${rz}) 不携带锚点 ⇒ 必须真的不相交`);
      }
    }
  }
  assertTrue(seen >= 1, '至少一个 region 携带锚点（否则结构永不生成）');
});

// ==================== 压制：空岛 / 地标 / 巨型金字塔 ====================

test('废弃堡垒压制：占地内地标被压掉（圆↔矩形相交判据）', () => {
  // 判据：对锚点所在及其邻居 region，若 `ruinedCitadelSuppressedLandmarks` 说某项要压，
  // 则 layout 里那一项必须真的是 null（压制生效），且**非锚点 region 不得被误压**。
  let suppressedAny = 0;
  for (const seed of SEEDS) {
    const a = computeRuinedCitadelAnchor(seed);
    const rxLo = Math.floor((a.wx - RUINED_CITADEL_HALF_X) / REGION_SIZE);
    const rxHi = Math.floor((a.wx + RUINED_CITADEL_HALF_X) / REGION_SIZE);
    const rzLo = Math.floor((a.wz - RUINED_CITADEL_HALF_Z) / REGION_SIZE);
    const rzHi = Math.floor((a.wz + RUINED_CITADEL_HALF_Z) / REGION_SIZE);
    for (let rx = rxLo; rx <= rxHi; rx++) {
      for (let rz = rzLo; rz <= rzHi; rz++) {
        const sup = ruinedCitadelSuppressedLandmarks(a, rx, rz, seed);
        const l = computeRegionLayout(rx, rz, seed);
        if (sup.giantPyramid) {
          assertEqual(l.giantPyramid, null, `seed ${seed} region(${rx},${rz}) 压制巨型金字塔后必须为 null`);
          suppressedAny++;
        }
        if (sup.skyIslands) {
          assertEqual(l.sky.skyIslands.length, 0,
            `seed ${seed} region(${rx},${rz}) 压制空岛后 skyIslands 必须为空`);
          // ️ 云簇必须保留（与空岛是两套内容，一并清掉会让上空云消失）
          assertTrue(l.sky.cloudClusters.length > 0,
            `seed ${seed} region(${rx},${rz}) cloudClusters 必须保留（只压空岛）`);
          suppressedAny++;
        }
        if (sup.pyramid) { assertEqual(l.pyramid, null, `seed ${seed} region(${rx},${rz}) pyramid 必须被压`); suppressedAny++; }
        if (sup.plainLand) { assertEqual(l.plainLand, null, `seed ${seed} region(${rx},${rz}) plainLand 必须被压`); suppressedAny++; }
        if (sup.island) { assertEqual(l.island, null, `seed ${seed} region(${rx},${rz}) island 必须被压`); suppressedAny++; }
        if (sup.frozenMountain) { assertEqual(l.frozenMountain, null, `seed ${seed} region(${rx},${rz}) frozenMountain 必须被压`); suppressedAny++; }
      }
    }
  }
  assertTrue(suppressedAny > 0,
    `8 seed × 占地 region 里至少要压掉一些内容（实际 ${suppressedAny}）—— 全 0 说明压制判据从未命中，等于没接线`);
});

test('废弃堡垒压制：null 锚点返回全 false（不抛、不误压）', () => {
  const sup = ruinedCitadelSuppressedLandmarks(null, 0, 0, SEED);
  for (const [k, v] of Object.entries(sup)) assertEqual(v, false, `${k} 必须 false`);
});

test('废弃堡垒压制：零回归 —— 远处 region 不被压', () => {
  // 这条钉的是「压制误伤」—— 若把压制写成无条件（不看 anchor 距离），所有 region 都会被压。
  const a = computeRuinedCitadelAnchor(SEED);
  const farRx = Math.floor(a.wx / REGION_SIZE) + 6;
  const farRz = Math.floor(a.wz / REGION_SIZE) + 6;
  const sup = ruinedCitadelSuppressedLandmarks(a, farRx, farRz, SEED);
  for (const [k, v] of Object.entries(sup)) assertEqual(v, false, `远处 region 的 ${k} 不得被压`);
  const l = computeRegionLayout(farRx, farRz, SEED);
  assertTrue(l.sky.skyIslands.length > 0 || l.tarn !== null,
    '远处 region 的空岛应保留（除非它本身是地带 region）');
});

// ==================== 真实 GEN 落位 ====================

test('废弃堡垒 GEN：甲板层落在 floorY 且是 end_stone 系，上方可站', async () => {
  const a = computeRuinedCitadelAnchor(SEED);
  const reg = await buildDefaultRegistry();
  const cols = await footprintColumns(reg);
  // 产物已知样本：局部 (-52, 45, -3) 是 end_stone，ny=46 无块（开放）
  const deck = toWorld(a, -52, FLOOR_ROW, -3);
  const deckId = readFootprint(cols, deck.wx, deck.wy, deck.wz);
  assertEqual(reg.nameOf(deckId), 'end_stone',
    `甲板格 (${deck.wx},${deck.wy},${deck.wz}) 必须是 end_stone（实际 ${reg.nameOf(deckId)}）—— ` +
    'y 差一格会让甲板沉进沙里或浮空');
  assertEqual(readFootprint(cols, deck.wx, deck.wy + 1, deck.wz), 0,
    '甲板上方一格必须是空气（玩家能站上去）');
  assertEqual(readFootprint(cols, deck.wx, deck.wy + 2, deck.wz), 0,
    '甲板上两格也必须是空气（玩家 2 格净空）');
});

test('废弃堡垒 GEN：地牢房间在世界里是 air（DR-2 的 GEN 级守卫）', async () => {
  const a = computeRuinedCitadelAnchor(SEED);
  const reg = await buildDefaultRegistry();
  const cols = await footprintColumns(reg);
  // ⚠️ 这条是 DR-2 的**唯一 GEN 级证据**：产物里 air 格数对（上一条钉住）不代表世界里
  //    真的被清空 —— 若 apply 阶段漏了、或 `makeColumnSetter` 对 'air' 走了静默 return，
  //    天然岩层会留在房间里。必须读真实世界方块。
  const ROOM_SAMPLES = [[2, 24, -2], [2, 26, -2], [2, 32, -2], [0, 24, -2], [4, 24, -2]];
  for (const [px, ny, pz] of ROOM_SAMPLES) {
    const w = toWorld(a, px, ny, pz);
    assertEqual(readFootprint(cols, w.wx, w.wy, w.wz), 0,
      `地牢房间格 (${px},${ny},${pz}) → 世界 (${w.wx},${w.wy},${w.wz}) 必须是 air` +
      `（实际 ${reg.nameOf(readFootprint(cols, w.wx, w.wy, w.wz))}）—— 天然岩层填满了地牢`);
  }
  // 房间下方的 end_stone 锥体必须还在（否则整个地牢被挖穿了）
  const base = toWorld(a, 2, 18, -2);
  assertEqual(reg.nameOf(readFootprint(cols, base.wx, base.wy, base.wz)), 'end_stone',
    '祭坛区 ny=18 的 end_stone 锥体必须保留（房间的地基）');
});

test('废弃堡垒 GEN：虚空灯位是 ochre_froglight（地牢唯一光源）', async () => {
  const a = computeRuinedCitadelAnchor(SEED);
  const reg = await buildDefaultRegistry();
  const cols = await footprintColumns(reg);
  // 产物已知：(2,21,-2) 是 ochre_froglight（原 cataclysm:void_lantern_block，134 格之一）
  const w = toWorld(a, 2, 21, -2);
  assertEqual(reg.nameOf(readFootprint(cols, w.wx, w.wy, w.wz)), 'ochre_froglight',
    `虚空灯位 (${w.wx},${w.wy},${w.wz}) 必须是 ochre_froglight`);
  // 地牢在地下（skylight=0），灯必须真的发光（emissive > 0），否则 44 层全黑
  const id = reg.idOf('ochre_froglight');
  assertTrue(reg.emissiveTable[id] > 0,
    `ochre_froglight 必须发光（emissive=${reg.emissiveTable[id]}）—— 地牢 skylight=0，靠它照明`);
});

test('废弃堡垒 GEN：占地内不得长出树/植被（pointContext 让路生效）', async () => {
  const a = computeRuinedCitadelAnchor(SEED);
  const reg = await buildDefaultRegistry();
  const cols = await footprintColumns(reg);
  // 沙漠植被 = cactus / dead_bush；树 = 各类 log/leaves；花草 = short_grass / flower 等。
  // ⚠️ **刻意不含 `vine` 与 `allium`**：本结构的产物自己就有这两种（`chorus_plant`→vine 85 格、
  //    `chorus_flower`→allium 9 格，全在甲板以上 ny=47..51），它们是**结构内容**不是自然撒布。
  //    把它们列进来会让本条恒红（大竞技场的产物没有这两种，所以那边可以列）。
  //    本条钉的是「自然撒布/树没长进占地」，判据是撒布会产生的那些方块。
  const vegIds = new Set(['cactus', 'dead_bush', 'wood', 'dark_oak', 'birch_log', 'leaves',
    'short_grass', 'flower', 'azure_bluet', 'oxeye_daisy'].map((n) => reg.idOf(n)));
  const found = [];
  // 抽样：每 3 格取一列，从甲板上方向上扫（结构本体在甲板下方，上方只可能有植被）
  for (let dx = -RUINED_CITADEL_HALF_X; dx <= RUINED_CITADEL_HALF_X; dx += 3) {
    for (let dz = -RUINED_CITADEL_HALF_Z; dz <= RUINED_CITADEL_HALF_Z; dz += 3) {
      for (let y = a.floorY + 1; y <= a.floorY + 24; y++) {
        const id = readFootprint(cols, a.wx + dx, y, a.wz + dz);
        if (vegIds.has(id)) found.push(`${a.wx + dx},${y},${a.wz + dz}:${reg.nameOf(id)}`);
      }
    }
  }
  assertEqual(found.length, 0, `占地内不得有植被（实测前 5 个：${found.slice(0, 5).join(' | ')}）`);
});

test('废弃堡垒 GEN：干燥区内不得有 water 方块（水约束的 GEN 级守卫）', async () => {
  const a = computeRuinedCitadelAnchor(SEED);
  const reg = await buildDefaultRegistry();
  const cols = await footprintColumns(reg);
  // ⚠️ 这条与锚点的「干燥判据」是两层守卫：锚点判据用 `generateHeight`（自然地形的
  //    唯一权威），本条读**真实世界方块**。若 `fillColumn` 的水位口径与判据漂移，
  //    锚点判据全绿而世界里仍有水 —— 只有这条能拓到。
  //
  // ⚠️ **扫描范围 = 占地 + DRY_MARGIN，不是整个 column**：footprintColumns 缓存的是
  //    覆盖占地的 16×16 column 网格，而 column 边缘会伸出干燥保证区之外（实测 z=-1 处
  //    有天然沙漠水，而占地 z∈[-125,-17]、干燥区只到 z=-13）。那些水在堡垒之外、
  //    与本约束无关。只扫干燥判据真正覆盖的 footprint+MARGIN 才是这条守卫的语义。
  const waterIds = new Set(['water', 'swamp_water'].map((n) => reg.idOf(n)));
  const M = RUINED_CITADEL_DRY_MARGIN;
  let hits = 0;
  const first = [];
  for (let dz = -(RUINED_CITADEL_HALF_Z + M); dz <= RUINED_CITADEL_HALF_Z + M; dz++) {
    for (let dx = -(RUINED_CITADEL_HALF_X + M); dx <= RUINED_CITADEL_HALF_X + M; dx++) {
      // 水体只可能出现在自然地表到 SEA_Y 之间（fillColumn 的填水区间），扫这一段即可
      const wx = a.wx + dx, wz = a.wz + dz;
      const hTop = Math.max(generateHeight(wx, wz, SEED), a.floorY) + 2;
      for (let y = WORLD_MIN_Y; y <= hTop; y++) {
        const id = readFootprint(cols, wx, y, wz);
        if (!waterIds.has(id)) continue;
        hits++;
        if (first.length < 5) first.push(`${wx},${y},${wz}`);
      }
    }
  }
  assertEqual(hits, 0, `干燥区（占地+${M}）内不得有水方块（实测 ${hits} 格，前 5 个：${first.join(' | ')}）`);
});

test('废弃堡垒 GEN：底部越界格被裁掉（世界 y < WORLD_MIN_Y 不存在）', async () => {
  const a = computeRuinedCitadelAnchor(SEED);
  const reg = await buildDefaultRegistry();
  const cols = await footprintColumns(reg);
  // 产物 ny=1（最底层）落在世界 y = floorY - 44：seed 12345 的 floorY=-1 ⇒ y=-45 < -32。
  // 结构总高 63 格而世界只有 128 层，底部必然越界 ⇒ 由 `makeColumnSetter` 的 y 下界守卫自然丢弃。
  const bottom = toWorld(a, 0, 1, 0);
  assertTrue(bottom.wy < WORLD_MIN_Y,
    `产物最底层应落在世界下界之外（实际 y=${bottom.wy}，WORLD_MIN_Y=${WORLD_MIN_Y}）—— 前提变了要重核这条`);
  // 越界格不得写进任何 column（读它应该拿到 0，因为 column 里根本没有那一层）
  assertEqual(readFootprint(cols, bottom.wx, bottom.wy, bottom.wz), 0,
    '越界格不得出现在世界里');
  // 但世界下界之上的结构格必须还在（不是「整个底部都没写」）
  const inRange = toWorld(a, 2, 18, -2);   // ny=18 → 世界 y = floorY-27
  assertTrue(inRange.wy >= WORLD_MIN_Y, `取样点必须在世界内（y=${inRange.wy}）`);
  assertTrue(readFootprint(cols, inRange.wx, inRange.wy, inRange.wz) !== 0,
    '世界下界之上的结构格必须写入（否则是整体没光栅化，不是越界裁剪）');
});

// ==================== 瞬移落点 ====================

test('废弃堡垒：瞬移落点在占地东缘外、y = 自然地表 + 1', () => {
  for (const seed of SEEDS) {
    const a = computeRuinedCitadelAnchor(seed);
    const p = ruinedCitadelTeleportPoint(seed);
    assertTrue(p !== null, `seed ${seed} 必须有瞬移落点`);
    // 本结构在城西 ⇒ 落点在占地**东缘**（City 那一侧）外，玩家面朝西就能看到堡垒
    assertEqual(p.x, a.wx + RUINED_CITADEL_HALF_X + RUINED_CITADEL_TELEPORT_GAP,
      `seed ${seed} 落点 x 必须是占地东缘外 ${RUINED_CITADEL_TELEPORT_GAP} 格`);
    assertEqual(p.z, a.wz, `seed ${seed} 落点 z 取锚点中线`);
    // ⚠️ y 用该格**自然地表** + 1，不用 `anchor.floorY`（那是甲板高度，缘外沙漠可能差几格）
    assertEqual(p.y, generateHeight(p.x, p.z, seed) + 1,
      `seed ${seed} 落点 y 必须是自然地表 + 1（实际 ${p.y}）`);
    // 落点必须站在干地上（不在水里、不在结构体内）
    assertTrue(generateHeight(p.x, p.z, seed) > SEA_Y,
      `seed ${seed} 落点必须高于海平面（实际 ${generateHeight(p.x, p.z, seed)}）`);
    assertEqual(inRuinedCitadelFootprint(p.x, p.z, [a]), false,
      `seed ${seed} 落点必须在占地外（否则玩家瞬移进墙里）`);
    assertEqual(getBiome(p.x, p.z, seed), 'DESERT', `seed ${seed} 落点应在沙漠里`);
  }
});
