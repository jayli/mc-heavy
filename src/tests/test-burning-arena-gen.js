// src/tests/test-burning-arena-gen.js — 大竞技场（burning arena）Tier 1：锚点纯函数 + 真实 column GEN
//
// 术语：**大竞技场** = 本结构（Cataclysm burning_arena，85×85×80，城东沙漠）；
//       **小竞技场** = 既有城门竞技场（`arena.js`，41×79，城南门外）。两者互不重叠。
//
// 钉的是这几类缺陷（每条都是静默的）：
//   · `STRUCTURE_FILES` 漏映射 → `rasterizeStructure` 拿到空 blocks 直接 return（0 格，无报错）
//   · 锚点不唯一 / 不确定 → 同一 seed 两次算出不同落点（红线 2）
//   · 落点不在沙漠 / 不平坦 / 压到城市 → 碗身一半坐在草地上、或埋进城市
//   · 与地基级大结构（高台地带 / 浅水高台 / 小竞技场）重叠 → 两个大结构互相穿插
//   · apply 阶段 2.93 漏了 / y 差一格 → 结构被地形覆盖或整体沉浮
//   · 空岛没让路 → 空岛在阶段 2.5 **后写胜**，反过来打穿竞技场上半部
//
// ⚠️ 断言落点一律是**真实 applyStructuresToColumn 写出的世界方块**，不是纯函数返回值
// （M7 教训：只测纯函数会漏接线）。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import {
  computeBurningArenaAnchor, inBurningArenaFootprint, burningArenaOverlapsRegion,
  burningArenaSuppressedLandmarks, burningArenaCandidateValid,
  BURNING_ARENA_HALF, BURNING_ARENA_HEIGHT, BURNING_ARENA_SPANS, clearBurningArenaCache,
} from '../gen/structures/burning-arena.js';
import { computeRegionLayout, neighborRegionKeys } from '../gen/structures/structure-layout.js';
import { applyStructuresToColumn } from '../gen/structures/apply.js';
import { STRUCTURE_FILES, loadStructure, floorRowOf } from '../gen/structures/structure-json.js';
import { buildDefaultRegistry } from '../voxel/block-registry.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { blockIndex } from '../voxel/constants.js';
import { fillColumn, generateHeight } from '../gen/terrain.js';
import { carveCaves } from '../gen/caves.js';
import { getBiome } from '../gen/noise.js';
import { getCityBoundsForSeed } from '../gen/structures/city-layout.js';
import { computeShallowTarnAnchor, SHALLOW_TARN_OUTER_RADIUS } from '../gen/structures/shallow-water-tarns.js';
import { computeArenaAnchor, ARENA_HALF_X, ARENA_HALF_Z, railArmSet } from '../gen/structures/arena.js';
import { isTarnZone, computeTarnZone, TARN_ZONE_RADIUS } from '../gen/structures/tarn-zone.js';
import { REGION_SIZE, CITY_TRANSITION_SIZE } from '../gen/structures/region-config.js';

const SEED = 12345;
/** 多 seed 判别力集合（锚点存在性 / 唯一性 / 沙漠判据都要跨 seed 成立） */
const SEEDS = [12345, 1, 99999, 424242, 1249026, 7, 5150, 2024];

/** 产物冻结数字（与 `tools/burning-arena-fingerprint.mjs` 的 METRICS 同源，此处独立钉住） */
const FLOOR_ROW = 10;
const CONTENT_CELLS = 115381;

/** 与 Worker 真实路径一致的完整 GEN（fillColumn + caves + applyStructures，不含 edits/light） */
async function genColumn(reg, cx, cz, seed = SEED) {
  const col = new ChunkColumn(cx, cz);
  fillColumn(col, seed, reg);
  carveCaves(col, seed);
  await applyStructuresToColumn(col, seed, reg, layoutsFor(cx, cz, seed));
  return col;
}

/**
 * 生成大竞技场占地跨的全部 column（**带缓存**，整个测试文件共用一份）。
 *
 * ⚠️ **必须缓存**：每个 column 的 `applyStructuresToColumn` 都会对 115,381 格结构做
 * 完整光栅化（setBlock 越界静默丢）。不缓存而逐用例重生，~50 个 column × 多个用例
 * = 上千万次 setBlock，会拖垮 harness 的 90s 窗口。缓存后整个 footprint 只生成一次。
 *
 * @returns {Promise<Map<string, ChunkColumn>>} 键 = `${cx},${cz}`
 */
let _footprintCols = null;
async function footprintColumns(reg) {
  if (_footprintCols) return _footprintCols;
  const a = computeBurningArenaAnchor(SEED);
  const ccx = Math.floor(a.wx / 16), ccz = Math.floor(a.wz / 16);
  const rCols = Math.ceil((BURNING_ARENA_HALF + 2) / 16);
  const map = new Map();
  for (let dcx = -rCols; dcx <= rCols; dcx++) {
    for (let dcz = -rCols; dcz <= rCols; dcz++) {
      const cx = ccx + dcx, cz = ccz + dcz;
      map.set(`${cx},${cz}`, await genColumn(reg, cx, cz));
    }
  }
  _footprintCols = map;
  return map;
}

/** 从缓存的 footprint column 读世界格（越界返回 0） */
function readFootprint(cols, wx, wy, wz) {
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

// ==================== 产物注册与加载 ====================

test('大竞技场：STRUCTURE_FILES 登记了 burningArena', () => {
  assertEqual(STRUCTURE_FILES.burningArena, 'burning_arena.json',
    'burningArena 必须映射到 burning_arena.json（漏登记 → rasterizeStructure 静默 0 格）');
});

// ==================== 栏杆朝向（v2.85 初版 3,311 格全 meta=0 的回归防线）====================
//
// 背景：素材的栏杆来自 fence/wall/chain 五种源方块，初版烘焙直查 BLOCK_MAP 全映成
// `handrail` 且 meta=0 ⇒ 3,311 格栏杆**全部渲染成 +X+Z 转角件**，直排栏杆互相拧着。
// 修复 = 烘焙脚本的栏杆朝向 pass（`computeRailOrientations`）：按邻居连接关系拆成
// `handrail`（转角件，带 orient）+ `handrailA`（直段件，带 orient）。
//
// 用户要求（2026-11-09）：「调整好方向后，绝大多数场景里，栏杆会是首尾相连的；
// 边缘位置连不上时，尽量让抓手的位置靠内」。
//
// ⚠️ 断言里的臂方向一律用 `railArmSet`（mesher 的 TEMPLATES 派生，红线 1），
// 不手写「orient=1 是 +X-Z」这类朝向表 —— 形状权威改动后这里自动跟上。

/** 产物里的栏杆格（归一化局部坐标，与 `loadStructure` 的 blocks 同口径） */
async function railBlocks() {
  const data = await loadStructure('burningArena');
  return data.blocks.filter((b) => b.type === 'handrail' || b.type === 'handrailA');
}

test('大竞技场栏杆：总格数不变、无 handrailB、直段件真的存在', async () => {
  const data = await loadStructure('burningArena');
  const rails = data.blocks.filter((b) => b.type === 'handrail' || b.type === 'handrailA');
  const straight = data.blocks.filter((b) => b.type === 'handrailA');
  const corner = data.blocks.filter((b) => b.type === 'handrail');
  const pillarB = data.blocks.filter((b) => b.type === 'handrailB');

  assertEqual(rails.length, 3311,
    '栏杆总格数必须仍是 3311（朝向 pass 只拆分不增删；变了 = pass 增删了格）');
  assertEqual(pillarB.length, 0,
    '产物不得含 handrailB —— 它的臂只伸到格中心、接不上邻居（test-arena.js 已钉住这条约束）');
  assertTrue(straight.length > 0,
    '必须有 handrailA（直段件）—— 全映回 handrail = 朝向 pass 整条被删，3,311 格会全渲染成 +X+Z 转角');
  assertTrue(corner.length > 0, '必须有 handrail（转角件）—— 全映成直段件同样不对');
});

test('大竞技场栏杆：转角件四向俱全，直段件只有 X/Z 两轴', async () => {
  const rails = await railBlocks();
  const cornerOrient = new Set(rails.filter((b) => b.type === 'handrail').map((b) => b.direction));
  const straightOrient = new Set(rails.filter((b) => b.type === 'handrailA').map((b) => b.direction));

  // handrail 是转角件，orient 0~3 四向互不等价，必须俱全
  for (let o = 0; o < 4; o++) {
    assertTrue(cornerOrient.has(o), `handrail orient=${o} 必须存在（四向转角件缺一不可）`);
  }
  // handrailA 是直段件：0≡2、1≡3（180° 对称，实测顶点多重集合逐位相同），
  // railPlacementFor 按 orient 升序返回首个命中 ⇒ 恒为 0（X 轴）或 1（Z 轴）
  assertTrue(straightOrient.has(0) && straightOrient.has(1),
    `handrailA 必须 X/Z 两轴俱全（实得 ${[...straightOrient].sort().join(',')}）`);
  for (const o of straightOrient) {
    assertTrue(o === 0 || o === 1,
      `handrailA 出现 orient=${o} —— 它与 orient=${o - 2} 几何逐位相同，必须走 railPlacementFor，不得手写朝向`);
  }
});

test('大竞技场栏杆：共线邻居用直段件、垂直邻居用转角件（首尾相连的主意图）', async () => {
  const rails = await railBlocks();
  const at = new Map(rails.map((b) => [`${b.x},${b.y},${b.z}`, b]));
  const isRail = (x, y, z) => at.has(`${x},${y},${z}`);
  const DIRS = [['+X', 1, 0], ['-X', -1, 0], ['+Z', 0, 1], ['-Z', 0, -1]];

  let collinear = 0, collinearStraight = 0, perp = 0, perpCorner = 0;
  for (const b of rails) {
    const nb = DIRS.filter(([, dx, dz]) => isRail(b.x + dx, b.y, b.z + dz)).map(([n]) => n);
    if (nb.length !== 2) continue;
    const isCollinear = (nb.includes('+X') && nb.includes('-X')) || (nb.includes('+Z') && nb.includes('-Z'));
    if (isCollinear) {
      collinear++;
      if (b.type === 'handrailA') collinearStraight++;
    } else {
      perp++;
      if (b.type === 'handrail') perpCorner++;
    }
  }

  // 实测（2026-11-09）：共线对 562 全部用直段件；垂直对 252 里 236 用转角件（93.7%）。
  // 共线取 100%（算法保证），垂直取 ≥90%（少数被支撑信号带偏，属边缘兜底）。
  assertTrue(collinear > 400, `共线邻居对应有 ${collinear} 个（实测 562；太少 = 判据失效）`);
  assertEqual(collinearStraight, collinear,
    `共线邻居对必须全部用直段件 handrailA（实得 ${collinearStraight}/${collinear}）—— 否则直排栏杆会拧成转角`);
  assertTrue(perp > 200, `垂直邻居对应有 ${perp} 个（实测 252；太少 = 判据失效）`);
  assertTrue(perpCorner / perp >= 0.9,
    `垂直邻居对应用转角件 handrail 的比例 ${(100 * perpCorner / perp).toFixed(1)}% ≥ 90%（实测 93.7%）`);
});

test('大竞技场栏杆：2 臂格的臂集合覆盖两侧邻居（首尾相连率）', async () => {
  const rails = await railBlocks();
  const at = new Map(rails.map((b) => [`${b.x},${b.y},${b.z}`, b]));
  const isRail = (x, y, z) => at.has(`${x},${y},${z}`);
  const DIRS = [['+X', 1, 0], ['-X', -1, 0], ['+Z', 0, 1], ['-Z', 0, -1]];

  let two = 0, covered = 0;
  for (const b of rails) {
    const nb = DIRS.filter(([, dx, dz]) => isRail(b.x + dx, b.y, b.z + dz)).map(([n]) => n);
    if (nb.length !== 2) continue;
    two++;
    const arms = railArmSet(b.type, b.direction);
    if (nb.every((a) => arms.includes(a))) covered++;
  }

  // 实测（2026-11-09）：814 个 2 臂格里 790 个（97.1%）臂集合覆盖两侧邻居。
  assertTrue(two > 600, `2 臂格应有 ${two} 个（实测 814；太少 = 判据失效）`);
  assertTrue(covered / two >= 0.95,
    `2 臂格的臂覆盖两侧邻居比例 ${(100 * covered / two).toFixed(1)}% ≥ 95%（实测 97.1%）—— 这是「首尾相连」的直接口径`);
});

test('大竞技场栏杆：同一柱段内朝向一致（垂直堆叠的栏杆柱不左右摇摆）', async () => {
  const rails = await railBlocks();
  // 按 (x,z) 分柱，柱内按 y 连续切段
  const columns = new Map();
  for (const b of rails) {
    const k = `${b.x},${b.z}`;
    if (!columns.has(k)) columns.set(k, []);
    columns.get(k).push(b);
  }
  let segs = 0, pure = 0;
  for (const arr of columns.values()) {
    arr.sort((a, b) => a.y - b.y);
    let seg = [arr[0]];
    const flush = () => {
      segs++;
      const s = new Set(seg.map((c) => `${c.type}:${c.direction}`));
      if (s.size === 1) pure++;
    };
    for (let i = 1; i < arr.length; i++) {
      if (arr[i].y === arr[i - 1].y + 1) seg.push(arr[i]);
      else { flush(); seg = [arr[i]]; }
    }
    flush();
  }

  // 实测（2026-11-09）：1295 段全部段内朝向一致（100%）。
  assertTrue(segs > 1000, `柱段应有 ${segs} 个（实测 1295；太少 = 判据失效）`);
  assertEqual(pure, segs,
    `同一柱段内朝向必须一致（实得 ${pure}/${segs}）—— 逐格独立算会在柱内左右摇摆，栏杆看起来会拧`);
});

test('大竞技场栏杆：臂指向栏杆的比例显著高于「全 meta=0」基线', async () => {
  const rails = await railBlocks();
  const at = new Map(rails.map((b) => [`${b.x},${b.y},${b.z}`, b]));
  const isRail = (x, y, z) => at.has(`${x},${y},${z}`);
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  let total = 0, toRail = 0;
  for (const b of rails) {
    for (const arm of railArmSet(b.type, b.direction)) {
      total++;
      const d = arm === '+X' ? DIRS[0] : arm === '-X' ? DIRS[1] : arm === '+Z' ? DIRS[2] : DIRS[3];
      if (isRail(b.x + d[0], b.y, b.z + d[1])) toRail++;
    }
  }

  // 实测（2026-11-09）：修复后 33.6%，旧「全 handrail meta=0」基线 18.1%。
  // 取 ≥30% 为下界：既显著高于旧基线，又给算法微调留了余量。
  assertTrue(toRail / total >= 0.30,
    `臂指向栏杆的比例 ${(100 * toRail / total).toFixed(1)}% ≥ 30%（实测 33.6%；旧全 meta=0 基线仅 18.1%）`);
});

test('大竞技场：产物可加载且尺寸/格数/floorRow 与冻结值一致', async () => {
  const data = await loadStructure('burningArena');
  assertEqual(data.blocks.length, CONTENT_CELLS,
    `产物格数必须是 ${CONTENT_CELLS}（实际 ${data.blocks.length}；为 0 说明未登记或 fetch 失败）`);
  assertEqual(floorRowOf('burningArena'), FLOOR_ROW, `floorRow 必须是 ${FLOOR_ROW}`);

  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity, mnz = Infinity, mxz = -Infinity;
  for (const b of data.blocks) {
    if (b.x < mnx) mnx = b.x; if (b.x > mxx) mxx = b.x;
    if (b.y < mny) mny = b.y; if (b.y > mxy) mxy = b.y;
    if (b.z < mnz) mnz = b.z; if (b.z > mxz) mxz = b.z;
  }
  assertEqual(mxx - mnx + 1, BURNING_ARENA_HALF * 2 + 1, 'X 跨度 85');
  assertEqual(mxz - mnz + 1, BURNING_ARENA_HALF * 2 + 1, 'Z 跨度 85');
  assertEqual(mxy - mny + 1, BURNING_ARENA_HEIGHT, 'Y 跨度 80');
  assertEqual(mny, 1, '归一化后最低层 y=1（rasterizeStructure 按 b.y 落位）');
  assertEqual(mnx, -BURNING_ARENA_HALF, 'x 相对中心对称');
  assertEqual(mnz, -BURNING_ARENA_HALF, 'z 相对中心对称');
});

// ==================== 锚点：必须且唯一（用户裁定）====================

test('大竞技场锚点：每个 seed 都找得到落点（「必须生成」）', () => {
  for (const seed of SEEDS) {
    const a = computeBurningArenaAnchor(seed);
    assertTrue(a !== null, `seed ${seed} 必须有落点（用户裁定「城东最近的沙漠必须且唯一生成」）`);
    assertTrue(Number.isInteger(a.wx) && Number.isInteger(a.wz),
      `seed ${seed} 锚点必须是整数格（实际 ${a.wx},${a.wz}）—— 落位/读世界/裁剪都按整数格断言`);
  }
});

test('大竞技场锚点：确定性（同 seed 重复调用逐位相同，跨 memo 清空也相同）', () => {
  for (const seed of SEEDS) {
    const a = computeBurningArenaAnchor(seed);
    const b = computeBurningArenaAnchor(seed);
    assertEqual(JSON.stringify(a), JSON.stringify(b), `seed ${seed} memo 命中路径一致`);
    clearBurningArenaCache();
    const c = computeBurningArenaAnchor(seed);
    assertEqual(JSON.stringify(a), JSON.stringify(c),
      `seed ${seed} 清空 memo 后重算仍一致（红线 2：锚点必须是 seed 的纯函数）`);
  }
});

test('大竞技场锚点：在 City 东侧且与城市 bounds 有净距', () => {
  for (const seed of SEEDS) {
    const a = computeBurningArenaAnchor(seed);
    const city = getCityBoundsForSeed(seed);
    assertTrue(a.wx - BURNING_ARENA_HALF > city.maxX,
      `seed ${seed} 整个占地必须在城东（占地西缘 ${a.wx - BURNING_ARENA_HALF} vs 城市东界 ${city.maxX}）`);
    assertTrue(a.wx - BURNING_ARENA_HALF - city.maxX >= CITY_TRANSITION_SIZE,
      `seed ${seed} 与城市净距 ≥ ${CITY_TRANSITION_SIZE}（实际 ${a.wx - BURNING_ARENA_HALF - city.maxX}）`);
  }
});

test('大竞技场锚点：占地 85×85 全是 DESERT 且高于海平面', () => {
  for (const seed of SEEDS) {
    const a = computeBurningArenaAnchor(seed);
    let nonDesert = 0, belowSea = 0;
    for (let dz = -BURNING_ARENA_HALF; dz <= BURNING_ARENA_HALF; dz++) {
      for (let dx = -BURNING_ARENA_HALF; dx <= BURNING_ARENA_HALF; dx++) {
        if (getBiome(a.wx + dx, a.wz + dz, seed) !== 'DESERT') nonDesert++;
        if (generateHeight(a.wx + dx, a.wz + dz, seed) <= -2) belowSea++;
      }
    }
    assertEqual(nonDesert, 0, `seed ${seed} 占地内非沙漠格数（实际 ${nonDesert}）`);
    assertEqual(belowSea, 0, `seed ${seed} 占地内低于海平面格数（实际 ${belowSea}）`);
  }
});

test('大竞技场锚点：占地内地表高差在放宽档位内（「相对平坦」）', () => {
  const maxSpan = BURNING_ARENA_SPANS[BURNING_ARENA_SPANS.length - 1];
  for (const seed of SEEDS) {
    const a = computeBurningArenaAnchor(seed);
    let minH = Infinity, maxH = -Infinity;
    for (let dz = -BURNING_ARENA_HALF; dz <= BURNING_ARENA_HALF; dz++) {
      for (let dx = -BURNING_ARENA_HALF; dx <= BURNING_ARENA_HALF; dx++) {
        const h = generateHeight(a.wx + dx, a.wz + dz, seed);
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
    }
    assertTrue(maxH - minH <= maxSpan,
      `seed ${seed} 地表高差 ${maxH - minH} 必须 ≤ ${maxSpan}（实测 span=${a.span}）`);
    assertEqual(a.floorY, minH, `seed ${seed} floorY 必须是占地内最低地表（落位基准）`);
  }
});

test('大竞技场锚点：是「最近」的那个（不存在更近的合法候选）', () => {
  // 判别力判据：在锚点与城市之间（更近处）逐点扫，不得存在另一个合法落点。
  // 若排序写错（例如按 x 而不是按距离），这条会拓到。
  //
  // ⚠️ **合法性判据必须转调 `burningArenaCandidateValid`**（搜索侧同一份，红线 1），
  // 不得在测试里自己写一份「沙漠+平坦」：实测踩过 —— 自写判据漏了城市净空，
  // 把被城市挡掉的 (449,-443)（seed 99999）当成「更近的合法候选」报假 FAIL。
  for (const seed of SEEDS) {
    const a = computeBurningArenaAnchor(seed);
    const city = getCityBoundsForSeed(seed);
    const cityCx = Math.round((city.minX + city.maxX) / 2);
    const cityCz = Math.round((city.minZ + city.maxZ) / 2);
    const dAnchor = Math.hypot(a.wx - cityCx, a.wz - cityCz);
    let closer = null;
    // 与搜索同一个窗（城东起点 + ±900 纬度）、同一个步长（8 格）
    const x0 = city.maxX + BURNING_ARENA_HALF + CITY_TRANSITION_SIZE;
    for (let x = x0; x <= a.wx; x += 8) {
      for (let z = cityCz - 900; z <= cityCz + 900; z += 8) {
        const d = Math.hypot(x - cityCx, z - cityCz);
        if (d >= dAnchor) continue;
        // 用锚点自己的 span 档（更严）：若更近处有同档合法点，说明排序/粗筛错了
        if (!burningArenaCandidateValid(x, z, a.span, seed).ok) continue;
        closer = { x, z, d: +d.toFixed(1), dAnchor: +dAnchor.toFixed(1) };
        break;
      }
      if (closer) break;
    }
    assertEqual(closer, null,
      `seed ${seed} 不得存在比锚点更近的合法候选（找到 ${JSON.stringify(closer)}）`);
  }
});

test('大竞技场锚点：不与地基级大结构重叠（高台地带 / 浅水高台 / 小竞技场）', () => {
  for (const seed of SEEDS) {
    const a = computeBurningArenaAnchor(seed);
    // 浅水高台
    const st = computeShallowTarnAnchor(seed);
    if (st) {
      const gap = Math.hypot(st.wx - a.wx, st.wz - a.wz);
      assertTrue(gap > SHALLOW_TARN_OUTER_RADIUS + BURNING_ARENA_HALF,
        `seed ${seed} 与浅水高台净距 ${gap.toFixed(1)} 必须 > ${SHALLOW_TARN_OUTER_RADIUS + BURNING_ARENA_HALF}`);
    }
    // 小竞技场
    const ar = computeArenaAnchor(seed);
    if (ar) {
      assertTrue(Math.abs(ar.wx - a.wx) > ARENA_HALF_X + BURNING_ARENA_HALF ||
                 Math.abs(ar.wz - a.wz) > ARENA_HALF_Z + BURNING_ARENA_HALF,
        `seed ${seed} 与小竞技场 AABB 不得相交`);
    }
    // 高台地带（扫占地触及的全部 region）
    const rxLo = Math.floor((a.wx - BURNING_ARENA_HALF) / REGION_SIZE);
    const rxHi = Math.floor((a.wx + BURNING_ARENA_HALF) / REGION_SIZE);
    const rzLo = Math.floor((a.wz - BURNING_ARENA_HALF) / REGION_SIZE);
    const rzHi = Math.floor((a.wz + BURNING_ARENA_HALF) / REGION_SIZE);
    for (let rx = rxLo; rx <= rxHi; rx++) {
      for (let rz = rzLo; rz <= rzHi; rz++) {
        if (!isTarnZone(rx, rz, seed)) continue;
        const t = computeTarnZone(rx, rz, seed);
        if (!t) continue;
        const overlap = Math.abs(t.cx - a.wx) <= TARN_ZONE_RADIUS + BURNING_ARENA_HALF &&
                        Math.abs(t.cz - a.wz) <= TARN_ZONE_RADIUS + BURNING_ARENA_HALF;
        assertEqual(overlap, false, `seed ${seed} 不得与地带 region(${rx},${rz}) 的圆重叠`);
      }
    }
  }
});

// ==================== 占地判据与 region 裁剪 ====================

test('大竞技场：inBurningArenaFootprint 边界精确（±42 内、±43 外）', () => {
  const a = { wx: 100, wz: 200 };
  assertEqual(inBurningArenaFootprint(100, 200, [a]), true, '中心');
  assertEqual(inBurningArenaFootprint(142, 200, [a]), true, '东缘 +42');
  assertEqual(inBurningArenaFootprint(143, 200, [a]), false, '东缘外 +43');
  assertEqual(inBurningArenaFootprint(58, 200, [a]), true, '西缘 -42');
  assertEqual(inBurningArenaFootprint(57, 200, [a]), false, '西缘外 -43');
  assertEqual(inBurningArenaFootprint(100, 242, [a]), true, '南缘 +42');
  assertEqual(inBurningArenaFootprint(100, 243, [a]), false, '南缘外 +43');
  assertEqual(inBurningArenaFootprint(0, 0, null), false, 'null anchors 不抛');
  assertEqual(inBurningArenaFootprint(0, 0, [null, a]), false, '数组含 null 项要跳过');
});

test('大竞技场：burningArenaOverlapsRegion 让跨 region 的占地被邻区携带', () => {
  const a = computeBurningArenaAnchor(SEED);
  const rx = Math.floor(a.wx / REGION_SIZE), rz = Math.floor(a.wz / REGION_SIZE);
  assertEqual(burningArenaOverlapsRegion(a, rx, rz), true, '锚点所在 region 必须携带');
  assertEqual(burningArenaOverlapsRegion(a, 99, 99), false, '远处 region 不携带（省 payload）');
  assertEqual(burningArenaOverlapsRegion(null, rx, rz), false, 'null 锚点不抛');
  // 85×85 可跨 2×2 region：至少一个邻居 region 也要携带（否则占地缺半边）
  let carried = 0;
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    if (burningArenaOverlapsRegion(a, rx + dx, rz + dz)) carried++;
  }
  assertTrue(carried >= 1, `3×3 邻域内携带锚点的 region 数 ${carried} ≥ 1`);
});

test('大竞技场：layout.burningArena 只在相交 region 出现，且与锚点同源', () => {
  const a = computeBurningArenaAnchor(SEED);
  let seen = 0;
  for (let rx = -3; rx <= 5; rx++) {
    for (let rz = -3; rz <= 3; rz++) {
      const l = computeRegionLayout(rx, rz, SEED).burningArena;
      if (l) {
        seen++;
        assertEqual(l.wx, a.wx, `region(${rx},${rz}) 携带的锚点 wx 与全局锚点一致`);
        assertEqual(l.wz, a.wz, `region(${rx},${rz}) 携带的锚点 wz 与全局锚点一致`);
        assertEqual(burningArenaOverlapsRegion(a, rx, rz), true,
          `region(${rx},${rz}) 携带锚点 ⇒ 必须真的相交`);
      } else {
        assertEqual(burningArenaOverlapsRegion(a, rx, rz), false,
          `region(${rx},${rz}) 不携带锚点 ⇒ 必须真的不相交`);
      }
    }
  }
  assertTrue(seen >= 1, '至少一个 region 携带锚点（否则结构永不生成）');
});

// ==================== 压制：空岛 / 地标 / 巨型金字塔 ====================

test('大竞技场压制：空岛让路（用户 2026-11-09 裁定）', () => {
  // 判据：锚点所在 region 的 skyIslands 必须为空（塔顶 y≈79~84 会撞空岛底 y≥40，
  // 且空岛在阶段 2.5 后写胜 → 不压制会反过来打穿竞技场上半部）。
  for (const seed of SEEDS) {
    const a = computeBurningArenaAnchor(seed);
    const rxLo = Math.floor((a.wx - BURNING_ARENA_HALF) / REGION_SIZE);
    const rxHi = Math.floor((a.wx + BURNING_ARENA_HALF) / REGION_SIZE);
    const rzLo = Math.floor((a.wz - BURNING_ARENA_HALF) / REGION_SIZE);
    const rzHi = Math.floor((a.wz + BURNING_ARENA_HALF) / REGION_SIZE);
    for (let rx = rxLo; rx <= rxHi; rx++) {
      for (let rz = rzLo; rz <= rzHi; rz++) {
        const sup = burningArenaSuppressedLandmarks(a, rx, rz, seed);
        if (!sup.skyIslands) continue;   // 本 region 没有需要压的空岛
        const l = computeRegionLayout(rx, rz, seed);
        assertEqual(l.sky.skyIslands.length, 0,
          `seed ${seed} region(${rx},${rz}) 压制空岛后 skyIslands 必须为空`);
        // ⚠️ 云簇必须保留（与空岛是两套内容，一并清掉会让上空云消失）
        assertTrue(l.sky.cloudClusters.length > 0,
          `seed ${seed} region(${rx},${rz}) cloudClusters 必须保留（只压空岛）`);
      }
    }
  }
});

test('大竞技场压制：null 锚点返回全 false（不抛、不误压）', () => {
  const sup = burningArenaSuppressedLandmarks(null, 0, 0, SEED);
  for (const [k, v] of Object.entries(sup)) assertEqual(v, false, `${k} 必须 false`);
});

test('大竞技场压制：零回归 —— 非锚点 region 的 layout 与压制前逐位相同', () => {
  // 判据：离锚点足够远的 region，全部字段必须与「没有大竞技场」时一致。
  // 这条钉的是「压制误伤」—— 若把压制写成无条件（不看 anchor），所有 region 都会被压。
  const a = computeBurningArenaAnchor(SEED);
  const farRx = Math.floor(a.wx / REGION_SIZE) + 6;
  const farRz = Math.floor(a.wz / REGION_SIZE) + 6;
  const l = computeRegionLayout(farRx, farRz, SEED);
  const sup = burningArenaSuppressedLandmarks(a, farRx, farRz, SEED);
  for (const [k, v] of Object.entries(sup)) assertEqual(v, false, `远处 region 的 ${k} 不得被压`);
  assertTrue(l.sky.skyIslands.length > 0 || l.tarn !== null,
    '远处 region 的空岛应保留（除非它本身是地带 region）');
});

// ==================== 真实 GEN 落位 ====================

test('大竞技场 GEN：碗内地板落在 floorY，中心与偏移点方块正确', async () => {
  const a = computeBurningArenaAnchor(SEED);
  const reg = await buildDefaultRegistry();
  const cols = await footprintColumns(reg);
  const nameAt = (dx, dy, dz) => reg.nameOf(readFootprint(cols, a.wx + dx, a.floorY + dy, a.wz + dz));
  const idAt = (dx, dy, dz) => readFootprint(cols, a.wx + dx, a.floorY + dy, a.wz + dz);

  // ⚠️ **中心列不是可站地板**：素材中心是 y=10..40 的熔岩柱（地板层那格映射为 netherrack，
  // y=11..40 仍是 solid lava），顶上 y=41..45 是 chest/obsidian/gold_block/glowstone 小塔。
  // ⇒ 「中心上方是空气」的断言恒红，可站性必须用偏移点验（实测 (5,0) 是 polished_deepslate）。
  assertEqual(nameAt(0, 0, 0), 'netherrack',
    '圆心地板格必须是 netherrack（地板层熔岩映射结果；若为 lava 说明分层规则没生效）');
  assertEqual(nameAt(5, 0, 0), 'polished_deepslate', '偏移点 (wx+5, wz) 地板格（实测值）');
  assertEqual(idAt(5, 1, 0), 0, '偏移点上方必须是空气（碗内可站）');
  assertEqual(idAt(5, 2, 0), 0, '偏移点上两格也必须是空气（玩家 2 格净空）');
});

test('大竞技场 GEN：占地内地板层铺满下界砖，且地板层无 lava', async () => {
  const a = computeBurningArenaAnchor(SEED);
  const reg = await buildDefaultRegistry();
  const cols = await footprintColumns(reg);
  const netherId = reg.idOf('nether_bricks');
  const lavaId = reg.idOf('lava');

  let bricks = 0, lava = 0, checked = 0;
  for (let dx = -BURNING_ARENA_HALF; dx <= BURNING_ARENA_HALF; dx++) {
    for (let dz = -BURNING_ARENA_HALF; dz <= BURNING_ARENA_HALF; dz++) {
      checked++;
      const id = readFootprint(cols, a.wx + dx, a.floorY, a.wz + dz);
      if (id === netherId) bricks++;
      else if (id === lavaId) lava++;
    }
  }

  assertEqual(checked, 85 * 85, '占地内逐格检查 85×85');
  // 地板层实测 3180 格 nether_bricks（占地板 4825 格的 66%）；取 1000 为下界防「静默空结构」恒真
  assertTrue(bricks > 1000, `地板层 nether_bricks 必须 >1000（实际 ${bricks}；为 0 说明结构没光栅化进来）`);
  // 地板层不得有 lava（本仓 lava 是 solid:true，碗内那部分地面会走不过去）
  assertEqual(lava, 0, `地板层不得有 lava（实际 ${lava}）—— 熔岩分层规则未生效`);
});

test('大竞技场 GEN：碗身上空不得有空岛方块（空岛已让路）', async () => {
  const reg = await buildDefaultRegistry();
  const cols = await footprintColumns(reg);
  // ⚠️ 判据用「空岛**专属**方块」`sky_grass`（同 test-tarn-zone-gen.js 的口径）：
  // 巨型云用 `sky_stone`，按 sky_stone 一刀切会把云误判成空岛。
  const skyGrassId = reg.idOf('sky_grass');
  let hits = 0;
  for (const col of cols.values()) {
    for (let i = 0; i < col.blocks.length; i++) if (col.blocks[i] === skyGrassId) hits++;
  }
  assertEqual(hits, 0, `占地 column 内不得有空岛方块（实测 ${hits} 格 sky_grass）`);
});

test('大竞技场 GEN：占地内不得长出树/植被（pointContext 让路生效）', async () => {
  const a = computeBurningArenaAnchor(SEED);
  const reg = await buildDefaultRegistry();
  const cols = await footprintColumns(reg);
  // 沙漠植被 = cactus / dead_bush；树 = 各类 log/leaves。占地内都不该有（除了结构自己的方块）
  const vegIds = new Set(['cactus', 'dead_bush', 'wood', 'dark_oak', 'birch_log', 'leaves',
    'short_grass', 'flower', 'allium', 'azure_bluet', 'oxeye_daisy'].map((n) => reg.idOf(n)));
  const found = [];
  for (let dx = -BURNING_ARENA_HALF; dx <= BURNING_ARENA_HALF; dx++) {
    for (let dz = -BURNING_ARENA_HALF; dz <= BURNING_ARENA_HALF; dz++) {
      for (let y = a.floorY + 1; y <= a.floorY + BURNING_ARENA_HEIGHT + 4; y++) {
        const id = readFootprint(cols, a.wx + dx, y, a.wz + dz);
        if (vegIds.has(id)) found.push(`${a.wx + dx},${y},${a.wz + dz}:${reg.nameOf(id)}`);
      }
    }
  }
  assertEqual(found.length, 0, `占地内不得有植被（实测前 5 个：${found.slice(0, 5).join(' | ')}）`);
});

test('大竞技场 GEN：基座下方有实心底（玩家挖穿地板不会掉进洞穴）', async () => {
  const a = computeBurningArenaAnchor(SEED);
  const reg = await buildDefaultRegistry();
  const cols = await footprintColumns(reg);
  const baseBottom = a.floorY - (FLOOR_ROW - 1);   // 基座最底层的 y
  let checked = 0, voids = 0;
  // 抽样：占地内每 4 格取一列
  for (let dx = -BURNING_ARENA_HALF; dx <= BURNING_ARENA_HALF; dx += 4) {
    for (let dz = -BURNING_ARENA_HALF; dz <= BURNING_ARENA_HALF; dz += 4) {
      checked++;
      let solid = false;
      for (let k = 1; k <= 6; k++) {
        const id = readFootprint(cols, a.wx + dx, baseBottom - k, a.wz + dz);
        if (id !== 0 && reg.solidTable[id] === 1) { solid = true; break; }
      }
      if (!solid) voids++;
    }
  }
  assertTrue(checked > 300, `应检查 >300 列（实际 ${checked}）`);
  assertTrue(voids / checked <= 0.01,
    `基座下方 6 格内必须有实心（空洞率 ${(voids / checked * 100).toFixed(2)}% > 1%）`);
});
