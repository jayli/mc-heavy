// src/tests/test-medieval-ship.js — 中世纪船（Medieval Ship Epic）纯函数层
//
// 需求（用户 2026-11-01）：把 Ships & Boats Pack 里最大的船搬进浅水高台水域，
// 只用现有方块（唯一例外：新增一个倒置台阶），台阶/栏杆方向不能错，船不接触高台。
//
// 本文件覆盖四块：
//   ① **新方块声明**：倒置台阶 / 倒置半砖的几何、朝向语义、与正置台阶的高侧一致性
//   ② **落点**：确定性 / 全水下 / 不压高台 / 不压桥 / 每个 seed 都命中
//   ③ **朝向**：4 个旋转变体是同一艘船（旋转自洽）
//   ④ **光栅化 y 口径**：船底紧贴湖底方块顶面（不埋进沙里、不悬空）
//
// ⚠️ 断言落点一律是**真实世界方块**或**真实 mesher 发射的顶点**，不是纯函数返回值
// （M7 教训：只测 API 会漏掉「接线没接上」这类静默缺陷）。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse } from './assert.js';
import { SEA_Y, blockIndex } from '../voxel/constants.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { createRegistry } from '../voxel/block-registry.js';
import { TEMPLATES, rotateOffset, buildSectionMesh } from '../mesh/mesher.js';
import {
  computeMedievalShipPlacement, clearMedievalShipCache, MEDIEVAL_SHIP_SALT,
  medievalShipTouchesColumn,
} from '../gen/structures/medieval-ship.js';
import {
  MEDIEVAL_SHIP_VARIANTS, MEDIEVAL_SHIP_METRICS, medievalShipHalfWidth,
} from '../gen/structures/medieval-ship-data.js';
import {
  computeShallowTarnAnchor, computeShallowTarnLayout, shallowTarnHalfWidth,
  clearShallowTarnCache, LAKE_FLOOR_Y, LAKE_RADIUS,
} from '../gen/structures/shallow-water-tarns.js';
import { computeShallowTarnBridge, clearShallowTarnBridgeCache } from '../gen/structures/shallow-water-bridge.js';
import { shallowTarnSurfaceYAt } from '../gen/structures/shallow-water-terrain.js';
import { railArmSet, railPlacementFor } from '../gen/structures/arena.js';

const DEFAULT_SEED = 12345;
/** 多 seed 抽样（落点判据与 seed 强相关，单 seed 会漏掉「换个 seed 就压高台」这类缺陷） */
const SEEDS = [12345, 1, 88, 20240101, 424242, 7, 999, 31337];

/** 模块级 registry 单例（避免每条用例各建一次 140 个方块） */
let registryCache = null;
function registry() {
  if (registryCache) return registryCache;
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  registryCache = reg;
  return reg;
}

/** 清掉三个模块的缓存（落点依赖锚点与桥，三者必须一起清才是真冷启动） */
function clearAll() {
  clearMedievalShipCache();
  clearShallowTarnCache();
  clearShallowTarnBridgeCache();
}

// ---------------------------------------------------------------------------
// ① 新方块声明与几何
// ---------------------------------------------------------------------------

test('中世纪船: 倒置台阶 / 倒置半砖已注册，几何与朝向语义正确', () => {
  const reg = registry();
  for (const [name, geom, orientModes] of [
    ['planks_step_updown', 'planks_step_updown', 4],
    ['half_block_updown', 'half_block_updown', 0],
  ]) {
    const id = reg.idOf(name);
    assertTrue(id !== undefined, `${name} 必须已注册`);
    assertEqual(reg.geometryNameOf(id), geom, `${name} 的几何`);
    assertEqual(reg.orientationModesTable[id], orientModes, `${name} 的 orientationModes`);
    assertEqual(reg.solidTable[id], 1, `${name} 必须 solid（玩家能站上去）`);
    // ⚠️ 非 box 几何必须 opaque:false —— 否则 mesher 会剔掉邻居朝向它的面（船身出现洞）
    assertEqual(reg.opaqueTable[id], 0, `${name} 必须 opaqueTable=0（非 box 几何的既有约束）`);
  }
});

test('中世纪船: 倒置半砖贴顶、正置半砖贴底（互补，不重叠）', () => {
  const yRange = (quads) => {
    let lo = Infinity, hi = -Infinity;
    for (const q of quads) for (const v of q.v) { if (v[1] < lo) lo = v[1]; if (v[1] > hi) hi = v[1]; }
    return [lo, hi];
  };
  const up = yRange(TEMPLATES.half_block_updown);
  const dn = yRange(TEMPLATES.half_block);
  assertEqual(up[0], 0.5, '倒置半砖的底面必须在 y=0.5');
  assertEqual(up[1], 1, '倒置半砖的顶面必须在 y=1（贴块顶）');
  assertEqual(dn[0], 0, '正置半砖的底面必须在 y=0（贴块底）');
  assertEqual(dn[1], 0.5, '正置半砖的顶面必须在 y=0.5');
  // 两者叠起来恰好填满整格（船体曲线用它们做上下两半）
  assertEqual(up[0], dn[1], '两个半砖必须在 y=0.5 处严丝合缝相接');
});

/**
 * 用**真实 mesher** 量某方块某 orient 的「高侧方向」。
 *
 * 手法与 `tools/bake-medieval-ship.mjs --census-orient` 相同（同一份判据，红线 1 精神）：
 * 发射顶点后分别量上/下半的 bbox，**半幅的那一半**就是高侧所在。
 *
 * ⚠️ 判据必须用 **bbox 跨度**（哪一轴只有半格），不能用中心点比较 ——
 * 中心点在「高侧 x 半格 + z 满幅」时会被 z 的中位 0.5 抢走（巨型金字塔实测踩过）。
 */
function measureHighSide(reg, blockName, orient) {
  const VIEW = 18;   // 16 + 2 halo
  const atlasMeta = { tiles: new Proxy({}, { get: () => ({ u0: 0, v0: 0, u1: 1, v1: 1 }) }) };
  const idx = (x, y, z) => x + z * VIEW + y * VIEW * VIEW;
  const LX = 8, LY = 8, LZ = 8;
  const data = new Uint16Array(VIEW ** 3);
  const meta = new Uint8Array(VIEW ** 3);
  const light = new Uint8Array(VIEW ** 3).fill(0xFF);
  data[idx(LX + 1, LY + 1, LZ + 1)] = reg.idOf(blockName);
  meta[idx(LX + 1, LY + 1, LZ + 1)] = orient;
  const g = buildSectionMesh({ data, light, meta }, reg, atlasMeta, 0, 0, 0).cutout;

  const half = (wantUpper) => {
    let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity, n = 0;
    for (let i = 0; i < g.positions.length; i += 3) {
      const x = g.positions[i] - LX, y = g.positions[i + 1] - LY, z = g.positions[i + 2] - LZ;
      if (wantUpper ? !(y > 0.5 + 1e-6) : !(y < 0.5 - 1e-6)) continue;
      n++;
      if (x < mnx) mnx = x; if (x > mxx) mxx = x;
      if (z < mnz) mnz = z; if (z > mxz) mxz = z;
    }
    if (!n) return null;
    return { mnx, mxx, mnz, mxz, spanX: mxx - mnx, spanZ: mxz - mnz };
  };
  const side = (b) => {
    if (!b) return null;
    if (b.spanX < 0.75 && b.spanZ > 0.75) return ((b.mnx + b.mxx) / 2) < 0.5 ? 'west' : 'east';
    if (b.spanZ < 0.75 && b.spanX > 0.75) return ((b.mnz + b.mxz) / 2) < 0.5 ? 'north' : 'south';
    return 'full';
  };
  const su = side(half(true)), sl = side(half(false));
  return su !== 'full' && su !== null ? su : (sl !== 'full' && sl !== null ? sl : null);
}

test('中世纪船: 正置与倒置木台阶的高侧逐 orient 一致（可共用一张朝向表）', () => {
  const reg = registry();
  // 这张表是「facing = 高侧」的实测结论（与巨型金字塔的 FACING_TO_ORIENT 同源）
  const EXPECT = ['west', 'south', 'east', 'north'];
  for (const name of ['planks_step', 'planks_step_updown']) {
    for (let o = 0; o < 4; o++) {
      const got = measureHighSide(reg, name, o);
      assertEqual(got, EXPECT[o], `${name} orient=${o} 的高侧`);
    }
  }
});

test('中世纪船: cobblestone_step_updown 的高侧与正置台阶**相反**（故不可复用它做木色倒置台阶）', () => {
  // ⚠️ 这条钉的是「为什么必须新增 `planks_step_updown` 而不能复用既有的
  // `cobblestone_step_updown`」—— 后者是「上下颠倒 **+ 水平镜像**」（下半在 +X），
  // 实测高侧是 `east,north,west,south`，与正置台阶的 `west,south,east,north`
  // **逐 orient 差 2（= 180°）**。
  //
  // 若误用它做木色倒置台阶，`half=bottom` 与 `half=top` 两种台阶就需要**两张**
  // facing→orient 表 —— 正是用户明确要求避免的「方向搞错」高发源。
  const reg = registry();
  const NORMAL = ['west', 'south', 'east', 'north'];
  const cobble = [];
  for (let o = 0; o < 4; o++) cobble.push(measureHighSide(reg, 'cobblestone_step_updown', o));
  assertEqual(cobble.join(','), 'east,north,west,south',
    'cobblestone_step_updown 的高侧（实测：与正置台阶水平镜像）');
  // 逐 orient 差 180°（即 orient 差 2）—— 这是「不可共用一张表」的量化证据
  for (let o = 0; o < 4; o++) {
    assertTrue(cobble[o] !== NORMAL[o],
      `orient=${o} 下 cobblestone_step_updown 的高侧 ${cobble[o]} 与正置台阶 ${NORMAL[o]} 必须不同`);
  }
  // 而新增的 planks_step_updown 与正置台阶逐 orient 相同（上面那条用例已钉）
  for (let o = 0; o < 4; o++) {
    assertEqual(measureHighSide(reg, 'planks_step_updown', o), NORMAL[o],
      `planks_step_updown orient=${o} 必须与正置台阶同高侧`);
  }
});

test('中世纪船: 倒置台阶与正置台阶同高（只是半幅层上下对调）', () => {
  const yRange = (quads) => {
    let lo = Infinity, hi = -Infinity;
    for (const q of quads) for (const v of q.v) { if (v[1] < lo) lo = v[1]; if (v[1] > hi) hi = v[1]; }
    return [lo, hi];
  };
  const a = yRange(TEMPLATES.planks_step);
  const b = yRange(TEMPLATES.planks_step_updown);
  assertEqual(a[0], b[0], '两者底面同高');
  assertEqual(a[1], b[1], '两者顶面同高');
  // 正置：下半全幅、上半半幅；倒置：上半全幅、下半半幅
  const halfAt = (quads, wantUpper) => {
    let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
    for (const q of quads) {
      const cy = (q.v[0][1] + q.v[1][1] + q.v[2][1] + q.v[3][1]) / 4;
      if (wantUpper ? !(cy > 0.6) : !(cy < 0.4)) continue;
      for (const v of q.v) {
        if (v[0] < mnx) mnx = v[0]; if (v[0] > mxx) mxx = v[0];
        if (v[2] < mnz) mnz = v[2]; if (v[2] > mxz) mxz = v[2];
      }
    }
    return { spanX: mxx - mnx, spanZ: mxz - mnz };
  };
  const upNormal = halfAt(TEMPLATES.planks_step, true);
  const upDown = halfAt(TEMPLATES.planks_step_updown, true);
  assertTrue(upNormal.spanX < 0.6 || upNormal.spanZ < 0.6,
    `正置台阶的上半必须是半幅（实得 spanX=${upNormal.spanX} spanZ=${upNormal.spanZ}）`);
  assertTrue(upDown.spanX > 0.9 && upDown.spanZ > 0.9,
    `倒置台阶的上半必须是全幅（实得 spanX=${upDown.spanX} spanZ=${upDown.spanZ}）`);
});

// ---------------------------------------------------------------------------
// ② 落点
// ---------------------------------------------------------------------------

test('中世纪船: 落点是 seed 的纯函数（重复调用逐位相同、与调用顺序无关）', () => {
  clearAll();
  const first = SEEDS.map((s) => computeMedievalShipPlacement(s));
  // 反序再算一遍（缓存命中路径与冷路径必须同结果）
  const second = [...SEEDS].reverse().map((s) => computeMedievalShipPlacement(s)).reverse();
  for (let i = 0; i < SEEDS.length; i++) {
    assertEqual(JSON.stringify(first[i]), JSON.stringify(second[i]),
      `seed ${SEEDS[i]} 两次调用结果必须逐位相同`);
  }
  // 清缓存后冷算也必须相同（防「缓存里存了别的东西」）
  clearAll();
  for (let i = 0; i < SEEDS.length; i++) {
    assertEqual(JSON.stringify(computeMedievalShipPlacement(SEEDS[i])), JSON.stringify(first[i]),
      `seed ${SEEDS[i]} 冷算结果必须与热算相同`);
  }
});

test('中世纪船: 每个 seed 都有落点，且朝向覆盖多个变体', () => {
  clearAll();
  const variantsSeen = new Set();
  for (const seed of SEEDS) {
    const p = computeMedievalShipPlacement(seed);
    assertTrue(!!p, `seed ${seed} 必须有落点（否则本文件其余用例恒真）`);
    assertTrue(MEDIEVAL_SHIP_VARIANTS.includes(p.variant),
      `seed ${seed} 的变体 "${p.variant}" 必须在 MEDIEVAL_SHIP_VARIANTS 里`);
    variantsSeen.add(p.variant);
  }
  // 朝向抽签必须真的在动（全落同一个变体 = 抽签失效，静默）
  assertTrue(variantsSeen.size >= 2,
    `${SEEDS.length} 个 seed 只出现 ${variantsSeen.size} 种朝向（${[...variantsSeen].join(',')}）—— 抽签可能失效`);
});

test('中世纪船: 落点 AABB 内每一列都在水下（船完整落在水域里）', () => {
  clearAll();
  for (const seed of SEEDS) {
    const p = computeMedievalShipPlacement(seed);
    const a = computeShallowTarnAnchor(seed);
    assertTrue(!!p && !!a, `seed ${seed} 必须有船与湖`);
    let dry = 0;
    const drySamples = [];
    for (let x = p.wx - p.loX; x <= p.wx + p.hiX; x++) {
      for (let z = p.wz - p.loZ; z <= p.wz + p.hiZ; z++) {
        // 判据与 `fillColumn` 的水体判据同源：地表 ≤ SEA_Y-1 ⟺ 那一列有水
        if (shallowTarnSurfaceYAt(x, z, seed, a) > SEA_Y - 1) {
          dry++;
          if (drySamples.length < 5) drySamples.push(`(${x},${z})`);
        }
      }
    }
    assertEqual(dry, 0,
      `seed ${seed} 的船 AABB 内有 ${dry} 列不在水下（${drySamples.join(' ')}）—— 船会搁在陆地上`);
  }
});

test('中世纪船: 不与五座高台重叠（含余量）', () => {
  clearAll();
  for (const seed of SEEDS) {
    const p = computeMedievalShipPlacement(seed);
    const a = computeShallowTarnAnchor(seed);
    const layout = computeShallowTarnLayout(seed);
    const shipBox = {
      minX: p.wx - p.loX, maxX: p.wx + p.hiX,
      minZ: p.wz - p.loZ, maxZ: p.wz + p.hiZ,
    };
    for (const pl of layout) {
      const hw = shallowTarnHalfWidth(pl.variant);
      const cx = Math.round(a.wx + pl.cx), cz = Math.round(a.wz + pl.cz);
      const box = { minX: cx - hw.loX, maxX: cx + hw.hiX, minZ: cz - hw.loZ, maxZ: cz + hw.hiZ };
      const overlap = shipBox.minX <= box.maxX && shipBox.maxX >= box.minX &&
                      shipBox.minZ <= box.maxZ && shipBox.maxZ >= box.minZ;
      assertFalse(overlap,
        `seed ${seed} 的船与高台 ${pl.variant} 重叠（用户明确要求「船不接触高台」）`);
      // 余量：两者之间至少留 1 格水缝（贴边也算「接触」）
      const gapX = Math.max(box.minX - shipBox.maxX, shipBox.minX - box.maxX);
      const gapZ = Math.max(box.minZ - shipBox.maxZ, shipBox.minZ - box.maxZ);
      const gap = (gapX > 0 && gapZ > 0) ? Math.hypot(gapX, gapZ) : Math.max(gapX, gapZ);
      assertTrue(gap >= 1,
        `seed ${seed} 的船与高台 ${pl.variant} 只隔 ${gap.toFixed(2)} 格（应 ≥1，贴边即接触）`);
    }
  }
});

test('中世纪船: 不与跨湖拱桥重叠（水平占地从严判）', () => {
  clearAll();
  for (const seed of SEEDS) {
    const p = computeMedievalShipPlacement(seed);
    const a = computeShallowTarnAnchor(seed);
    const bridge = computeShallowTarnBridge(seed, null);
    if (!bridge) continue;   // 该 seed 没有桥（合法：两条轴都撞高台时不生成）
    // 桥格集合（与 rasterizeShallowTarnBridge 同口径）
    let hit = 0;
    const samples = [];
    for (let s = -bridge.halfN; s <= bridge.halfP; s++) {
      for (let off = -1; off <= 1; off++) {
        const wx = a.wx + bridge.ux * s + (-bridge.uz) * off;
        const wz = a.wz + bridge.uz * s + bridge.ux * off;
        if (wx >= p.wx - p.loX && wx <= p.wx + p.hiX &&
            wz >= p.wz - p.loZ && wz <= p.wz + p.hiZ) {
          hit++;
          if (samples.length < 5) samples.push(`(${wx},${wz})`);
        }
      }
    }
    assertEqual(hit, 0,
      `seed ${seed} 的船压到 ${hit} 个桥格（${samples.join(' ')}）`);
  }
});

test('中世纪船: 落点在湖里（中心到湖心的距离 < 湖半径）', () => {
  clearAll();
  for (const seed of SEEDS) {
    const p = computeMedievalShipPlacement(seed);
    const a = computeShallowTarnAnchor(seed);
    const d = Math.hypot(p.wx - a.wx, p.wz - a.wz);
    // 中心须在名义湖半径内（船体可略探入接壤水域，但中心不该跑到岸上）
    assertTrue(d < 82, `seed ${seed} 的船中心离湖心 ${d.toFixed(1)} 格（应 < 湖半径 82）`);
  }
});

test('中世纪船: salt 1039 未被其它系统占用（确定性污染防线）', () => {
  // ⚠️ 这条钉的是「常量值」而不是「扫描结果」：若有人把别的系统的 salt 改成 1039，
  // 两个系统会共用随机流（相关），而单测全绿 —— 用错 salt 是静默的确定性污染。
  assertEqual(MEDIEVAL_SHIP_SALT, 1039, 'MEDIEVAL_SHIP_SALT 必须是 1039（程序化扫描确认空闲）');
  // 抽签必须真的产生 4 个不同朝向（若 salt 撞上别的系统，分布会偏）
  clearAll();
  const seen = new Set();
  for (let seed = 1; seed <= 40; seed++) {
    const p = computeMedievalShipPlacement(seed);
    if (p) seen.add(p.variant);
  }
  assertEqual(seen.size, 4, `40 个 seed 应覆盖全部 4 个朝向，实得 ${[...seen].join(',')}`);
});

// ---------------------------------------------------------------------------
// ③ 旋转变体自洽
// ---------------------------------------------------------------------------

test('中世纪船: 4 个变体的尺寸两两对应（旋转 90° 宽深对调）', () => {
  const m = MEDIEVAL_SHIP_METRICS;
  // o0/o2 同尺寸，o1/o3 同尺寸，且 (w,d) 互换
  assertEqual(m.medieval_ship_o0.width, m.medieval_ship_o2.width, 'o0 与 o2 同宽');
  assertEqual(m.medieval_ship_o0.depth, m.medieval_ship_o2.depth, 'o0 与 o2 同深');
  assertEqual(m.medieval_ship_o1.width, m.medieval_ship_o3.width, 'o1 与 o3 同宽');
  assertEqual(m.medieval_ship_o1.depth, m.medieval_ship_o3.depth, 'o1 与 o3 同深');
  assertEqual(m.medieval_ship_o0.width, m.medieval_ship_o1.depth, 'o0 的宽 == o1 的深（旋转 90°）');
  assertEqual(m.medieval_ship_o0.depth, m.medieval_ship_o1.width, 'o0 的深 == o1 的宽（旋转 90°）');
  // 高度不受旋转影响
  for (const v of MEDIEVAL_SHIP_VARIANTS) {
    assertEqual(m[v].height, m.medieval_ship_o0.height, `${v} 的高度必须与 o0 相同（旋转不改 y）`);
    assertEqual(m[v].blocks, m.medieval_ship_o0.blocks, `${v} 的格数必须与 o0 相同（旋转不增删方块）`);
  }
});

test('中世纪船: halfWidth 与 METRICS 自洽（非对称 AABB 判据）', () => {
  for (const v of MEDIEVAL_SHIP_VARIANTS) {
    const hw = medievalShipHalfWidth(v);
    const m = MEDIEVAL_SHIP_METRICS[v];
    // lo + hi + 1 == 跨度（这是「非对称半宽」的定义，压成 width/2 会漏判）
    assertEqual(hw.loX + hw.hiX + 1, m.width, `${v} 的 X 半宽必须还原出宽度`);
    assertEqual(hw.loZ + hw.hiZ + 1, m.depth, `${v} 的 Z 半宽必须还原出深度`);
    // 奇偶跨度都要正确（37 → 18/18；11 → 5/5）
    assertTrue(Math.abs(hw.loX - hw.hiX) <= 1, `${v} 的 loX/hiX 差不得超过 1（${hw.loX}/${hw.hiX}）`);
  }
});

test('中世纪船: touchesColumn 判据与 AABB 相交一致（含 marginal）', () => {
  clearAll();
  const p = computeMedievalShipPlacement(DEFAULT_SEED);
  assertTrue(!!p, '默认 seed 必须有落点');
  const minX = p.wx - p.loX, maxX = p.wx + p.hiX;
  const minZ = p.wz - p.loZ, maxZ = p.wz + p.hiZ;
  // 船内的 column 必须命中
  const inCx = Math.floor(p.wx / 16) * 16, inCz = Math.floor(p.wz / 16) * 16;
  assertTrue(medievalShipTouchesColumn(p, inCx, inCz), '船心所在 column 必须命中');
  // 远处的 column 必须不命中（两个轴各验一次）
  assertFalse(medievalShipTouchesColumn(p, minX - 1000, minZ - 1000), 'X 轴远处 column 不得命中');
  assertFalse(medievalShipTouchesColumn(p, p.wx, maxZ + 1000), 'Z 轴远处 column 不得命中');
  // 边界：刚好在船 AABB 外 1 格（marginal=2 时仍应命中，因为余量）
  const edgeCx = Math.floor((maxX + 1) / 16) * 16;
  const edgeHit = medievalShipTouchesColumn(p, edgeCx, Math.floor(p.wz / 16) * 16);
  // 只断言「判据是确定的」：同一输入两次调用结果相同（防内部状态污染）
  assertEqual(edgeHit, medievalShipTouchesColumn(p, edgeCx, Math.floor(p.wz / 16) * 16),
    'touchesColumn 必须是纯函数');
});

// ---------------------------------------------------------------------------
// ④ 栏杆方向（用户明确要求「栏杆方块有方向，别错了」）
// ---------------------------------------------------------------------------

test('中世纪船: 栏杆臂方向由 TEMPLATES 派生（不是手写字面量）', () => {
  // handrailA 是「贯穿格」直段件：o0 沿 X、o1 沿 Z（能接上邻居）
  // ⚠️ 用 Set 比较而不是字符串：`railArmSet` 的返回顺序由 `baseArmsOf` 的探测顺序决定
  // （先 +X 后 -X），`.sort()` 会按 ASCII 排成 `+X,-X`（'+' 43 < '-' 45）——
  // 写 `'-X,+X'` 是把「排序后的样子」想象错了（同「写断言前先跑真实数据」的教训）。
  assertEqual(new Set(railArmSet('handrailA', 0)).size, 2, 'handrailA orient=0 必须两臂');
  assertTrue(railArmSet('handrailA', 0).every((a) => a.includes('X')),
    `handrailA orient=0 的臂必须沿 ±X（实得 ${railArmSet('handrailA', 0).join(',')}）`);
  assertTrue(railArmSet('handrailA', 1).every((a) => a.includes('Z')),
    `handrailA orient=1 的臂必须沿 ±Z（实得 ${railArmSet('handrailA', 1).join(',')}）`);
  // handrail 是转角件：两臂垂直
  for (let o = 0; o < 4; o++) {
    const arms = railArmSet('handrail', o);
    assertEqual(arms.length, 2, `handrail orient=${o} 必须恰好两臂`);
    const hasX = arms.some((a) => a.includes('X'));
    const hasZ = arms.some((a) => a.includes('Z'));
    assertTrue(hasX && hasZ, `handrail orient=${o} 的两臂必须一横一纵（实得 ${arms.join(',')}）`);
  }
});

test('中世纪船: handrailB 的臂接不上邻居（故它不得进入反查表）', () => {
  // ⚠️ 这条是竞技场 Epic 沉淀的既有约束的回归防线：`handrailB` 的臂只伸到 0.25
  // （格中心），与邻居的臂在格边界处断开 → 船上会出现看不见的缺口。
  // 判据 = 「臂伸到格边界（≥0.5）之外」，不是「有臂就行」。
  //
  // ⚠️ 不能写成 `railArmSet('handrailB', 0).length === 0`：`baseArmsOf` 的阈值
  // `ARM_REACH_MIN = 0.5` 确实会把它筛成空集，但那是**实现细节**；真正要钉的是
  // 「它伸不到格边界」这个几何事实 —— 直接量 TEMPLATES 的顶点。
  let maxReach = 0;
  for (const q of TEMPLATES.handrailB) {
    for (const v of q.v) {
      const dy = v[1] - 0.5;
      if (dy < 0) continue;   // 只看上半部（臂层在 y≈0.85；柱体上下贯通）
      maxReach = Math.max(maxReach, Math.abs(v[0] - 0.5), Math.abs(v[2] - 0.5));
    }
  }
  assertTrue(maxReach < 0.5,
    `handrailB 的臂伸到 ${maxReach.toFixed(3)}（应 < 0.5 = 格边界）—— 它接不上邻居，不得用作船的栏杆`);
  // 对照：handrailA 的臂必须伸到格边界之外（否则船栏杆会断口）
  let reachA = 0;
  for (const q of TEMPLATES.handrailA) {
    for (const v of q.v) {
      if (v[1] - 0.5 < 0) continue;
      reachA = Math.max(reachA, Math.abs(v[0] - 0.5), Math.abs(v[2] - 0.5));
    }
  }
  assertTrue(reachA >= 0.5,
    `handrailA 的臂只伸到 ${reachA.toFixed(3)}（应 ≥ 0.5）—— 否则船栏杆接不上`);
  // 反查表里不得出现 handrailB
  for (const arms of [['+X', '-X'], ['+Z', '-Z'], ['+X', '+Z'], ['-X', '-Z']]) {
    const hit = railPlacementFor(arms);
    assertFalse(hit && hit.name === 'handrailB',
      `railPlacementFor(${arms.join(',')}) 返回了 handrailB（它接不上邻居）`);
  }
});

test('中世纪船: rotateOffset 是加法群（整船旋转 = 每格 orient 加 o）', () => {
  // 这条是「烘焙期旋转 4 个变体」这个做法的数学前提：
  // 若 rotateOffset 不是群，`(meta + o) % 4` 就会与「先转坐标再转几何」不一致
  // → 船身转了但台阶朝向没转（静默缺陷，方块层面看不出）。
  const VECTORS = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0.3, 0, -0.2], [1, 0, 1]];
  for (const v of VECTORS) {
    for (let a = 0; a < 4; a++) {
      for (let b = 0; b < 4; b++) {
        const once = rotateOffset(...rotateOffset(v[0], v[1], v[2], a), b);
        const twice = rotateOffset(v[0], v[1], v[2], (a + b) % 4);
        for (let i = 0; i < 3; i++) {
          assertTrue(Math.abs(once[i] - twice[i]) < 1e-9,
            `rotateOffset 不是加法群：v=${JSON.stringify(v)} a=${a} b=${b} → ${once} vs ${twice}`);
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// ⑤ 光栅化 y 口径
// ---------------------------------------------------------------------------

test('中世纪船: 船底落在湖底方块顶面（不埋进沙里、不悬空）', async () => {
  clearAll();
  const p = computeMedievalShipPlacement(DEFAULT_SEED);
  assertTrue(!!p, '默认 seed 必须有落点');
  // 产物最低层归一化为 y=1，`rasterizeStructure` 按 `y + b.y - 1` 落位，
  // 而 apply.js 传的是 `anchor.lakeFloorY + 1` ⇒ 船底世界 y = lakeFloorY + 1 = SEA_Y。
  const expectedBottomY = LAKE_FLOOR_Y + 1;
  assertEqual(expectedBottomY, SEA_Y,
    '船底必须落在 SEA_Y（= 湖底方块的顶面）—— 这是「船坐湖底」的口径');
  // 湖底方块在 LAKE_FLOOR_Y，其顶面 = LAKE_FLOOR_Y + 1 = SEA_Y
  assertEqual(LAKE_FLOOR_Y, SEA_Y - 1, '湖底方块层必须是 SEA_Y-1（既有口径，改了船就错位）');
  // 水面（mesher 下沉 0.5 后）在 SEA_Y + 0.5 ⇒ 船底比水面低 0.5 格（船坐在浅水里）
  assertTrue(expectedBottomY < SEA_Y + 0.5, '船底必须在水面之下（否则船浮在半空）');
});

test('中世纪船: 产物最低层归一化为 y=1（rasterizeStructure 的落位前提）', async () => {
  // ⚠️ 这条在浏览器里跑（能 fetch 产物）；Node 侧 loadStructure 会静默返回空结构。
  const { loadStructure } = await import('../gen/structures/structure-json.js');
  for (const v of MEDIEVAL_SHIP_VARIANTS) {
    const data = await loadStructure(v);
    assertTrue(data.blocks.length > 0, `${v} 必须加载到方块（0 = STRUCTURE_FILES 漏映射或 fetch 失败）`);
    let minY = Infinity, maxY = -Infinity;
    for (const b of data.blocks) { if (b.y < minY) minY = b.y; if (b.y > maxY) maxY = b.y; }
    assertEqual(minY, 1, `${v} 的最低层必须归一化为 y=1（实得 ${minY}）`);
    assertEqual(maxY - minY + 1, MEDIEVAL_SHIP_METRICS[v].height,
      `${v} 的高度必须与 METRICS 一致`);
    // 朝向必须真的写进了产物（stride=5）：全部 direction=0 说明朝向丢了
    const dirs = new Set(data.blocks.map((b) => b.direction));
    assertTrue(dirs.size >= 2,
      `${v} 的 direction 只有 ${[...dirs].join(',')} —— 台阶/栏杆朝向可能丢了（stride 写错？）`);
  }
});

test('中世纪船: 船体材料已按用户要求换成 iron / snow / marble（v2.34）', async () => {
  // ⚠️ 这条钉的是「用户 2026-11-04 的改色真的进了产物」。
  //
  // 为什么必须单独钉：改色只动 `BLOCK_MAP` 的目标名，**格数 / bbox / 台阶 / 半砖 /
  // 栏杆计数 / palette 种类（13）全部不变** ⇒ 只看那些指标的断言在「改了映射却没重烘」
  // 时全绿（旧的 dark_planks / birch_log / light_gray_cloth 还在产物里）。
  // 指纹会变（设计如此），但指纹只能证明「参数变过」，证明不了产物里的方块名。
  const OLD = ['dark_planks', 'birch_log', 'light_gray_cloth'];
  const NEW = { iron: 292, marble: 93, snow: 26 };
  const { loadStructure } = await import('../gen/structures/structure-json.js');
  for (const v of MEDIEVAL_SHIP_VARIANTS) {
    const data = await loadStructure(v);
    const counts = new Map();
    for (const b of data.blocks) counts.set(b.type, (counts.get(b.type) || 0) + 1);
    for (const [name, want] of Object.entries(NEW)) {
      assertEqual(counts.get(name) || 0, want, `${v}: "${name}" 必须恰好 ${want} 格（用户 2026-11-04 改色）`);
    }
    for (const name of OLD) {
      assertEqual(counts.get(name) || 0, 0, `${v}: 旧材质 "${name}" 已全部换掉，不应再出现`);
    }
    // palette 种类仍是 13（3 出 3 进）—— 防止「只改了一半映射」时种类数偷偷变化
    const kinds = new Set(data.blocks.map((b) => b.type));
    assertEqual(kinds.size, 13, `${v}: palette 种类应仍为 13（3 出 3 进）`);
  }
});

test('中世纪船: 用户修复叠加层已固化进产物（逐格逐朝向）', async () => {
  // ⚠️ 这条钉的是「用户 2026-11-01 的手工修复真的进了产物」。
  //
  // 为什么不能只靠格数/bbox：修复的净效果是 **格数 1263 不变 / bbox 37×37×11 不变 /
  // palette 13 种不变**（106 写入含 6 新增 − 6 删除 = 净 0）⇒ 那些判据在「叠加层被漏掉」
  // 时全绿。实测还发现：**指纹也拓不到**（叠加层文件不变、只是烘焙代码没消费它时，
  // 指纹逐位相同）⇒ 必须直接比对产物内容。
  //
  // 判据（两侧都有判别力）：
  //   ① 每一条 `set` 在产物里必须是那个方块名 + 那个 meta（未施加时会读到旧值，如
  //      `vertical_pillar` 而不是 `handrailA`；新增的 6 格则根本不存在）；
  //   ② 每一条 `remove` 在产物里必须**不存在**（未施加时它们还在）。
  const { resourceUrl } = await import('../core/resource-url.js');
  const { loadStructure } = await import('../gen/structures/structure-json.js');
  const overlay = await fetch(resourceUrl('assets/medieval-ship/src/user-fix-o0.json'))
    .then((r) => r.json());
  assertTrue(Array.isArray(overlay.set) && overlay.set.length > 0, '叠加层必须有 set 项');
  assertTrue(Array.isArray(overlay.remove) && overlay.remove.length > 0, '叠加层必须有 remove 项');

  // 叠加层的坐标空间 = o0 产物的局部坐标（烘焙脚本已断言 o0 的居中偏移是 (0,0)）
  const data = await loadStructure('medieval_ship_o0');
  assertTrue(data.blocks.length > 0, 'o0 产物必须加载到方块');
  const product = new Map();
  for (const b of data.blocks) product.set(`${b.x},${b.y},${b.z}`, { name: b.type, meta: b.direction });

  let setBad = 0;
  const setSamples = [];
  for (const [x, y, z, name, meta] of overlay.set) {
    const got = product.get(`${x},${y},${z}`);
    if (!got || got.name !== name || got.meta !== meta) {
      setBad++;
      if (setSamples.length < 5) {
        setSamples.push(`(${x},${y},${z}) 期望 ${name}(m${meta}) 实得 ${got ? `${got.name}(m${got.meta})` : '不存在'}`);
      }
    }
  }
  assertEqual(setBad, 0,
    `叠加层的 ${overlay.set.length} 条写入里有 ${setBad} 条没固化进产物：${setSamples.join('; ')}`);

  let removeBad = 0;
  const removeSamples = [];
  for (const [x, y, z] of overlay.remove) {
    const got = product.get(`${x},${y},${z}`);
    if (got) {
      removeBad++;
      if (removeSamples.length < 5) removeSamples.push(`(${x},${y},${z}) 仍是 ${got.name}`);
    }
  }
  assertEqual(removeBad, 0,
    `叠加层要删的 ${overlay.remove.length} 格里有 ${removeBad} 格还在产物里：${removeSamples.join('; ')}`);
});

test('中世纪船: 修复后的栏杆分布符合用户意图（直段为主、转角与竖柱大幅减少）', async () => {
  // 用户把大量「孤立竖柱 / 转角件」换成了**有朝向的直段栏杆**（船帆之间的连接件）。
  // 实测：handrail 21→6 / handrailA 15→120 / vertical_pillar 158→68。
  // ⚠️ 这三个数是**旋转不变量**（旋转只改 meta、不改方块名），故四个变体逐个断言。
  const { loadStructure } = await import('../gen/structures/structure-json.js');
  const RAIL = { handrail: 6, handrailA: 120, vertical_pillar: 68 };
  for (const v of MEDIEVAL_SHIP_VARIANTS) {
    const data = await loadStructure(v);
    const counts = { handrail: 0, handrailA: 0, vertical_pillar: 0 };
    for (const b of data.blocks) if (counts[b.type] !== undefined) counts[b.type]++;
    for (const [name, want] of Object.entries(RAIL)) {
      assertEqual(counts[name], want, `${v}: ${name} 格数（用户修复后的目标值）`);
    }
    // 修复的核心意图：直段栏杆必须成为主体（修复前只有 15 格，远少于竖柱 158）
    assertTrue(counts.handrailA > counts.handrail,
      `${v}: 直段栏杆（${counts.handrailA}）应多于转角件（${counts.handrail}）`);
    assertTrue(counts.handrailA > counts.vertical_pillar,
      `${v}: 直段栏杆（${counts.handrailA}）应多于竖柱（${counts.vertical_pillar}）—— 这是修复的主意图`);
    // 直段栏杆的四个朝向都要有（用户逐格调过方向，不能退化成单一朝向）
    const dirs = new Set(data.blocks.filter((b) => b.type === 'handrailA').map((b) => b.direction));
    assertEqual(dirs.size, 4, `${v}: handrailA 的朝向应四向俱全（实得 ${[...dirs].sort().join(',')}）`);
  }
});

test('中世纪船: 真实 GEN 后船方块出现在世界里（接线防线）', async () => {
  // ⚠️ 这条钉的是「apply.js 真的接了线」—— 纯函数全绿但世界里一个方块都没有，
  // 是 M7 教训里最典型的静默缺陷（STRUCTURE_FILES 漏映射 / needTypes 漏预载 / 阶段漏调）。
  clearAll();
  const { computeRegionLayout, neighborRegionKeys } = await import('../gen/structures/structure-layout.js');
  const { applyStructuresToColumn } = await import('../gen/structures/apply.js');
  const { loadStructure } = await import('../gen/structures/structure-json.js');
  const { buildDefaultRegistry } = await import('../voxel/block-registry.js');
  const { fillColumn } = await import('../gen/terrain.js');
  const { carveCaves } = await import('../gen/caves.js');

  const seed = DEFAULT_SEED;
  const reg = await buildDefaultRegistry();
  const p = computeMedievalShipPlacement(seed);
  assertTrue(!!p, '默认 seed 必须有落点');
  const a = computeShallowTarnAnchor(seed);
  assertTrue(!!a, '默认 seed 必须有浅水高台锚点');
  // 船必须锚在湖里（落点由湖心派生，不是随便找个地方）
  assertTrue(Math.hypot(p.wx - a.wx, p.wz - a.wz) < LAKE_RADIUS,
    '船中心必须在湖半径内（落点由湖心锚点派生）');

  // 只 GEN 船心所在的那一个 column（省时间；船跨多列，中心列必然有船体）
  const cx = Math.floor(p.wx / 16), cz = Math.floor(p.wz / 16);
  const layouts = neighborRegionKeys(cx, cz).map((key) => {
    const [rx, rz] = key.split(',').map(Number);
    return computeRegionLayout(rx, rz, seed);
  });
  const col = new ChunkColumn(cx, cz);
  fillColumn(col, seed, reg);
  carveCaves(col, seed);
  for (const v of MEDIEVAL_SHIP_VARIANTS) await loadStructure(v);
  await applyStructuresToColumn(col, seed, reg, layouts);

  // 数船心列上的船体方块（船是实心的，中心列从船底到甲板都该有方块）
  const shipIds = new Set(
    ['oak_planks', 'iron', 'planks_step', 'planks_step_updown',
     'half_block_updown', 'sand_slab', 'vertical_pillar', 'handrail', 'handrailA',
     'marble', 'snow', 'giant_mangrove_log']
      .map((n) => reg.idOf(n)).filter((id) => id !== undefined),
  );
  const lx = p.wx - cx * 16, lz = p.wz - cz * 16;
  let shipBlocks = 0;
  const found = new Map();
  for (let y = SEA_Y; y <= SEA_Y + 12; y++) {
    const id = col.blocks[blockIndex(lx, y, lz)];
    if (shipIds.has(id)) {
      shipBlocks++;
      const n = reg.nameOf(id);
      found.set(n, (found.get(n) || 0) + 1);
    }
  }
  assertTrue(shipBlocks > 0,
    `船心列 (${p.wx},${p.wz}) 在 y=${SEA_Y}..${SEA_Y + 12} 没有任何船体方块 —— apply.js 接线断了`);
  // 船底那一格必须是船体（不是水、不是沙）
  const bottomId = col.blocks[blockIndex(lx, SEA_Y, lz)];
  assertTrue(shipIds.has(bottomId),
    `船底 (${p.wx},${SEA_Y},${p.wz}) 是 "${reg.nameOf(bottomId) || 'air'}"，应是船体方块`);
});
