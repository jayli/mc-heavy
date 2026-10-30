// src/gen/structures/shallow-water-bridge.js — 浅水高台跨湖拱桥：桥轴、剖面、材质、栅格化
//
// 设计文档：docs/superpowers/specs/2026-11-01-shallow-water-tarns-design.md §15
//
// Worker 同构：本文件不得 import three、不得 fetch、不得自建 Worker。
import { SEA_Y, WORLD_MIN_Y, WORLD_MAX_Y } from '../../voxel/constants.js';
import {
  computeShallowTarnAnchor,
  shallowTarnLakeRadiusAt, shallowTarnShapePhase,
  BEACH_WIDTH, SLOPE_WIDTH,
} from './shallow-water-tarns.js';
import { shallowTarnSurfaceYAt } from './shallow-water-terrain.js';

/** 弧顶高度（标定值，见 spec §15.3） */
export const BRIDGE_APEX_Y = 47;

/** 桥面与高台顶部的最小净空（格） */
export const BRIDGE_MIN_CLEARANCE = 3;

/**
 * 桥轴搜索 / 材质分片的 salt。
 *
 * 1038 经**程序化扫描**确认空闲（`src/**` 里的 `seededRandom` 与 SALT 常量：
 * 1~26 / 50~58 / 91 / 100 / 113 / 200~201 / 270~397 / 777 / 800~805 / 812~826 /
 * 941 / 956 / 960~961 / 1000 / 1020~1037 / 2000 / 3000 步进的整千 / 已占用）。
 * ⚠️ 带 `+ step` 的调用点占用的是**区间**，加新 salt 前必须重跑同一个扫描。
 */
export const BRIDGE_SALT = 1038;

/**
 * 桥宽（格）= 中线 + 法向各 1 格。
 *
 * ⚠️ **这是宽度的唯一权威**：栅格化的 off 范围从它派生（`half = (BRIDGE_WIDTH-1)/2`），
 * 不写字面量 `-1..1`。改成 5 会让桥变 5 格宽而无需动别处 —— 但那时要先重跑
 * 「3 格宽」用例与 spec §15.5 的斜向分析（5 格宽下斜向的漏格比例会变）。
 */
export const BRIDGE_WIDTH = 3;

/** 桥轴缓存（`seed → bridge | null`）。纯函数，`clearShallowTarnBridgeCache()` 供单测隔离。 */
const bridgeCache = new Map();
const BRIDGE_CACHE_MAX = 64;

/** 清空桥轴缓存（单测隔离用；生产代码不需要调用） */
export function clearShallowTarnBridgeCache() {
  bridgeCache.clear();
}

/**
 * 沿某条正轴找该侧的**干燥落点**（地表 ≥ `SEA_Y` 的第一个位置）。
 *
 * ⚠️ **必须从湖岸 `R(θ)` 往外扫，而不是从湖心往外扫**：湖盆内部恒 `LAKE_FLOOR_Y < SEA_Y`，
 * 从湖心扫会立刻命中湖底（永远是"湿"的）。
 *
 * ⚠️ **搜索上限是 `BEACH_WIDTH + SLOPE_WIDTH`**（31 格）：再往外就是自然地形，
 * 那里的地表高度与本地图无关（缓坡之外的接缝落差由外边那块地承担，spec §5.3）。
 *
 * @returns {{d:number, y:number}|null} `d` = 湖心到落点的水平距离（整数格）
 */
function findLanding(anchor, seed, sign, ux, uz, baseAngle) {
  const dirAngle = sign > 0 ? baseAngle : baseAngle + Math.PI;
  const shore = shallowTarnLakeRadiusAt(dirAngle, shallowTarnShapePhase(seed));
  for (let e = 0; e <= BEACH_WIDTH + SLOPE_WIDTH; e += 0.5) {
    const d = Math.max(1, Math.round(shore + e));
    const x = anchor.wx + ux * d * sign;
    const z = anchor.wz + uz * d * sign;
    const y = shallowTarnSurfaceYAt(x, z, seed, anchor);
    if (y >= SEA_Y) return { d, y };
  }
  return null;
}

/**
 * 某条正轴上的**最小净空**（桥面 y − 该格平台顶 y）。
 *
 * 只查中线与法向 ±1 的三格 —— 桥只占这三格，旁边的平台再高也与它无关。
 *
 * @returns {number} `Infinity` 表示轴上没有任何平台顶
 */
function axisClearance(anchor, bridge, platformTop) {
  if (!platformTop || platformTop.size === 0) return Infinity;
  const { ux, uz } = bridge;
  const nx = -uz;
  const nz = ux;
  const halfWidth = (BRIDGE_WIDTH - 1) / 2;
  let worst = Infinity;
  for (let s = -bridge.halfN; s <= bridge.halfP; s++) {
    const deckY = shallowTarnBridgeDeckY(s, bridge);
    for (let off = -halfWidth; off <= halfWidth; off++) {
      const x = anchor.wx + ux * s + nx * off;
      const z = anchor.wz + uz * s + nz * off;
      const top = platformTop.get(`${x},${z}`);
      if (top === undefined) continue;
      const clear = deckY - top;
      if (clear < worst) worst = clear;
    }
  }
  return worst;
}

/**
 * 候选桥轴表 —— **只有两条正轴**。
 *
 * ## ⚠️ 为什么不能有斜向桥轴（实测否决，spec §15.5）
 * 「任意角度 + 法向偏移 −1/0/+1」实测**两个都坏**：
 *   · 22°/30°/60°/137° 有 **9%~18%** 的沿轴步只覆盖 **2 格** → 桥面漏格，玩家会掉下去；
 *   · 足迹法向投影宽度涨到 **3.8~4.1 格**（不是用户要的 3 格）。
 * 根因是格坐标取整在斜向不对齐：法向偏移 ±1 投影到整数格后既不恒定也不互相邻接。
 * 备选「中心细线 + 主轴邻居」也不成立（45° 时 114/114 个中心格成孤岛）。
 *
 * ⇒ **严格 3 格宽只能靠正轴**。代价是桥只沿 X 或 Z，而实测最优方位本来就几乎都是正轴附近。
 */
const CANDIDATE_AXES = [
  { axis: 'X', ux: 1, uz: 0, baseAngle: 0 },
  { axis: 'Z', ux: 0, uz: 1, baseAngle: Math.PI / 2 },
];

/**
 * 跨湖拱桥的桥轴与剖面参数（纯函数，带 seed 缓存）。
 *
 * 逐 seed 搜两条正轴，取「两端有干燥落点 + 过五座高台净空 ≥ `BRIDGE_MIN_CLEARANCE`」
 * 里净空最大的那条；相等时取 `+X`（候选表顺序，确定性）。
 *
 * @param {number} seed
 * @param {Map<string, number>|null} platformTop
 *   键 `"wx,wz"`、值 = 该列最顶层要避让的方块 y。`null` / 空 Map 跳过净空判据。
 * @returns {{axis:string, ux:number, uz:number, apex:number,
 *   halfP:number, halfN:number, endYP:number, endYN:number, span:number}|null}
 */
export function computeShallowTarnBridge(seed, platformTop) {
  const cacheable = !platformTop || platformTop.size === 0;
  if (cacheable) {
    const hit = bridgeCache.get(seed);
    if (hit !== undefined) return hit;
  }
  const anchor = computeShallowTarnAnchor(seed);
  if (!anchor) {
    if (cacheable) remember(seed, null);
    return null;
  }

  let best = null;
  let bestClearance = -Infinity;
  for (const cand of CANDIDATE_AXES) {
    const lp = findLanding(anchor, seed, 1, cand.ux, cand.uz, cand.baseAngle);
    if (!lp) continue;
    const ln = findLanding(anchor, seed, -1, cand.ux, cand.uz, cand.baseAngle);
    if (!ln) continue;
    const bridge = {
      axis: cand.axis,
      ux: cand.ux,
      uz: cand.uz,
      apex: BRIDGE_APEX_Y,
      halfP: lp.d,
      halfN: ln.d,
      endYP: lp.y,
      endYN: ln.y,
      span: lp.d + ln.d,
    };
    const clearance = axisClearance(anchor, bridge, platformTop);
    if (clearance < BRIDGE_MIN_CLEARANCE) continue;
    if (clearance > bestClearance) {
      bestClearance = clearance;
      best = bridge;
    }
  }

  if (cacheable) remember(seed, best);
  return best;
}

/** 缓存写入（FIFO 淘汰） */
function remember(seed, value) {
  if (bridgeCache.size >= BRIDGE_CACHE_MAX) {
    bridgeCache.delete(bridgeCache.keys().next().value);
  }
  bridgeCache.set(seed, value);
}

/**
 * 桥面高度（余弦拱）。`s` = 沿桥轴到湖心的整数偏移。
 *
 * ```
 * y(s) = round( endY + (apex − endY) · (cos(π·|s|/half) + 1) / 2 )
 * ```
 *
 * ## ⚠️ 为什么是余弦，不是 smoothstep / 抛物（spec §15.3 三条实测）
 * | 剖面 | 端部斜率 | 最大相邻高差 |
 * |---|---|---|
 * | **余弦** | 0 | **1**（玩家走得上去）|
 * | smoothstep | 0 | 1 |
 * | 抛物 `1−t²` | 2 | **2** → 突破 `MAX_STEP = 1.0`，玩家走不上去 |
 *
 * 两侧 `half` / `endY` 各自独立：湖岸不规则 ⇒ 两侧跨度常不相等。
 */
export function shallowTarnBridgeDeckY(s, bridge) {
  const half = s >= 0 ? bridge.halfP : bridge.halfN;
  const endY = s >= 0 ? bridge.endYP : bridge.endYN;
  const t = Math.min(1, Math.abs(s) / half);
  return Math.round(endY + (bridge.apex - endY) * ((Math.cos(Math.PI * t) + 1) / 2));
}

// ==================== 材质分片（§15.6） ====================

/**
 * 六种桥材质（用户 2026-11-03 点名）。
 *
 * ⚠️ **全部必须是 `cullMode: 'opaque'`**：桥身实测 489~606 格，
 * 走 cutout/transparent 会把每格顶点成本放大约 ×3 并撞容量预算。
 * ⚠️ **不得含叶子族**（用户明确「用非叶子方块」）。
 */
export const BRIDGE_MATERIALS = Object.freeze([
  'cloud', 'ice', 'dark_grass', 'light_grass', 'marble', 'sky_stone',
]);

/** 最小片长（格）—— 短于此的片段并入相邻片 */
export const BRIDGE_SEG_MIN_LEN = 8;

/**
 * 1D 分段场的尺度。
 *
 * 0.03 是 **20 seed 实测值**（共 149 片）：片长 min 8 / p25 12 / 中位 14 / p75 19，
 * 低于 8 格的片段 **0 个**，六种材质全部出现。
 */
export const BRIDGE_SEG_SCALE = 0.03;

/**
 * 1D **不可分离**场：与 `tarn-terrain.js` 的 `blobNoise` 同构
 * （`sin·cos` 交叉耦合 + `hypot` 项），但只吃沿桥轴的 `s`。
 *
 * ⚠️ **不能用 `noise()`**：它是 `sin(x·s) + cos(z·s)` 可分离相加 ⇒ 等值线是十字/菱形，
 * 分界会出现几十格长的直线段（与 `tarn-terrain.js` 的既有教训同源）。
 *
 * ⚠️ **桥宽只有 3 格，横向分片没有意义**：横向分段会让三格不同色，
 * 观感是"三根并排的细线"而不是"一片桥面"。故 `nz` 只吃 seed（每个 seed 一条固定相位）。
 */
function bridgeField(s, seed) {
  const nx = s * BRIDGE_SEG_SCALE;
  const nz = seed * 0.37;
  const sc = seed + BRIDGE_SALT;
  const a = Math.sin(nx + sc * 0.013) * Math.cos(nz * 0.9 + sc * 0.021) * 2;
  const b = Math.sin(nx * 0.7 + nz * 1.3 + sc * 0.017) * 1.4;
  const c = Math.cos(Math.hypot(nx * 0.82, nz) * 1.1 + sc * 0.011) * 0.6;
  return a + b + c;
}

/**
 * 桥的分片视图（**唯一实现**，`shallowTarnBridgeBlockAt` 与测试共用）。
 *
 * ## 三段（每段都有实测理由，见 spec §15.6）
 * ① **等值线分片**：把场值归一化到 `[0,1)` 后分 N 段，段界即等值线交点（边界弯折）。
 * ② **游程合并**：任何 `< BRIDGE_SEG_MIN_LEN` 的片段并入相邻片 —— 保证最小片长。
 * ③ **强制相邻异色**：若与上一片同色，换到下一个材质。
 *
 * ⚠️ **为什么不是「逐格分桶」**（实测否决）：逐格 `floor(blobNoise/8·6)` 得到的材质占比是
 * **4/15/28/32/14/3%** —— 云与 `sky_stone` 几乎不出现（桶边界落在场值域的疏密区），
 * 而且片长会碎到 1 格（`in[8,15]` 只占 44%）。①② 同时解决这两个问题。
 *
 * @returns {Array<{start:number, len:number, material:string}>}
 */
export function bridgeRawSegments(bridge, seed) {
  const s0 = -bridge.halfN;
  const n = bridge.halfP - s0 + 1;
  const values = new Array(n);
  let vmin = Infinity;
  let vmax = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = bridgeField(s0 + i, seed);
    values[i] = v;
    if (v < vmin) vmin = v;
    if (v > vmax) vmax = v;
  }
  const span = (vmax - vmin) || 1;
  const count = BRIDGE_MATERIALS.length;

  // ① 等值线切段
  const raw = [];
  let start = 0;
  let prevBucket = Math.min(count - 1, Math.floor(((values[0] - vmin) / span) * count));
  for (let i = 1; i < n; i++) {
    const bucket = Math.min(count - 1, Math.floor(((values[i] - vmin) / span) * count));
    if (bucket !== prevBucket) {
      raw.push({ start, len: i - start, bucket: prevBucket });
      start = i;
      prevBucket = bucket;
    }
  }
  raw.push({ start, len: n - start, bucket: prevBucket });

  return raw.map((r) => ({ start: s0 + r.start, len: r.len, bucket: r.bucket }));
}

/**
 * 原始片段长度（**不做游程合并**）—— 供单测证明「合并确实在起作用」。
 *
 * ⚠️ 存在的唯一理由：只断言「合并后片长 ≥ 8」时，把 `BRIDGE_SEG_MIN_LEN` 改成 1 也全绿
 * （实测：原始场只有 9.3% 的片段 <8，且它们大多与相邻短片段合并后自然超过 8）。
 * 本函数让测试能直接看到合并前的分布。
 *
 * @returns {number[]}
 */
export function bridgeRawSegmentLengths(bridge, seed) {
  return bridgeRawSegments(bridge, seed).map((r) => r.len);
}

/** 桥面分片（原始切段 → 游程合并 → 强制相邻异色） */
export function bridgeSegments(bridge, seed) {
  const s0 = -bridge.halfN;
  const raw = bridgeRawSegments(bridge, seed).map((r) => ({ start: r.start - s0, len: r.len, bucket: r.bucket }));
  const count = BRIDGE_MATERIALS.length;

  // ② 游程合并（保证最小片长）
  const merged = [];
  for (const seg of raw) {
    const last = merged[merged.length - 1];
    if (last && seg.len < BRIDGE_SEG_MIN_LEN) {
      last.len += seg.len;
      continue;
    }
    if (last && last.len < BRIDGE_SEG_MIN_LEN) {
      last.len += seg.len;
      last.bucket = seg.bucket;
      continue;
    }
    merged.push({ ...seg });
  }

  // ③ 强制相邻异色
  //
  // ⚠️ **在当前参数下这一段是冗余防御，永远不会触发**（实测 10 seed 共 79 对相邻片段，
  // 天然同色 **0 对**）：游程合并会把同一 bucket 的相邻片段并成一片，而原始切段的相邻两片
  // 必然是不同 bucket（切段判据就是 bucket 变化）。保留它的理由是 `BRIDGE_SEG_MIN_LEN`
  // 或 `BRIDGE_SEG_SCALE` 调大/调小时，"合并后跨过一整片、露出同色邻居" 才可能发生。
  // ⇒ **不要因为这个分支看起来没用就删掉**，也不要为它写一个必然通过的断言（那是无效盲区）。
  const out = [];
  for (const seg of merged) {
    let bucket = seg.bucket;
    if (out.length && BRIDGE_MATERIALS[bucket] === out[out.length - 1].material) {
      bucket = (bucket + 1) % count;
    }
    out.push({ start: s0 + seg.start, len: seg.len, material: BRIDGE_MATERIALS[bucket] });
  }
  return out;
}

/**
 * 某格桥面的材质（纯函数）。
 *
 * @param {number} s 沿桥轴到湖心的整数偏移
 * @param {object} bridge `computeShallowTarnBridge` 的返回值
 * @param {number} seed
 * @returns {string} `BRIDGE_MATERIALS` 之一
 */
export function shallowTarnBridgeBlockAt(s, bridge, seed) {
  const segs = bridgeSegments(bridge, seed);
  for (let i = segs.length - 1; i >= 0; i--) {
    if (s >= segs[i].start) return segs[i].material;
  }
  return segs[0].material;
}

// ==================== 栅格化（§15.4） ====================

/**
 * 在 column 里光栅化跨湖拱桥（**单层 + 3 格宽**）。
 *
 * ## 每格只写 1 格
 * 用户 2026-11-03：「单层方块」。不写桥墩、不写栏杆、不写桥体加厚。
 *
 * ## 横截面 = 中线 + 法向 ±1
 * 轴吸附正轴后 `(ux, uz) ∈ {(±1,0), (0,±1)}`，法向 `(-uz, ux)` 也是正轴
 * ⇒ 三格的整数格坐标无歧义（斜向会漏格，见 `CANDIDATE_AXES` 注释）。
 *
 * ## 目标格已有方块时照写（后写胜）
 * 桥面必须**连续** —— 被高台残留或缓坡植被挡住的格子会让桥断掉，玩家会掉下去。
 * 净空判据（`computeShallowTarnBridge`）已保证桥面在台顶之上 `BRIDGE_MIN_CLEARANCE` 格。
 *
 * ## 裁剪
 * 只处理落在本 column 的格。`s` 的范围直接遍历全程（±~100），不做额外求交：
 * 单列只会命中约 10~15 格，遍历 200 次 `s` 的成本远低于求交的复杂度。
 *
 * @param {import('../../voxel/chunk-column.js').ChunkColumn} column
 * @param {{wx:number, wz:number}} anchor
 * @param {number} seed
 * @param {import('../../voxel/block-registry.js').BlockRegistry} registry
 * @param {(wx:number, y:number, wz:number, name:string, meta?:number) => void} setBlock
 * @param {Map<string, number>|null} platformTop 见 `computeShallowTarnBridge`
 */
export function rasterizeShallowTarnBridge(column, anchor, seed, registry, setBlock, platformTop) {
  void registry;   // 判据全在纯函数里（材质名直接交给 setBlock）；保留形参与同目录其它函数一致
  const bridge = computeShallowTarnBridge(seed, platformTop);
  if (!bridge) return;

  const colMinX = column.cx * 16;
  const colMinZ = column.cz * 16;
  const halfWidth = (BRIDGE_WIDTH - 1) / 2;
  for (let s = -bridge.halfN; s <= bridge.halfP; s++) {
    const y = shallowTarnBridgeDeckY(s, bridge);
    if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) continue;
    const material = shallowTarnBridgeBlockAt(s, bridge, seed);
    for (let off = -halfWidth; off <= halfWidth; off++) {
      const wx = anchor.wx + bridge.ux * s + (-bridge.uz) * off;
      const wz = anchor.wz + bridge.uz * s + bridge.ux * off;
      if (wx < colMinX || wx > colMinX + 15) continue;
      if (wz < colMinZ || wz > colMinZ + 15) continue;
      setBlock(wx, y, wz, material);
    }
  }
}
