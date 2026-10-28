// src/gen/structures/arena.js — 城门竞技场（Arena）：锚点纯函数 + 栏杆臂方向派生
//
// 权威：docs/superpowers/specs/2026-10-29-arena-design.md
//
// 三块职责，刻意放在同一个文件里（都已与 three 无关，Worker 同构）：
//   ① `railArmSet` / `railPlacementFor` —— 栏杆「臂方向 ↔ (方块, 朝向)」反查。臂方向**从
//      `TEMPLATES` 派生**，并用 mesher 导出的 `rotateOffset` 旋转（红线 1：形状权威只有
//      `mesher.js` 一份，烘焙脚本与运行期共用）。
//   ② `computeArenaAnchor` —— 落点（每个 seed 一个，城南门外最近的可落位 footprint）。
//   ③ `inArenaFootprint` / `arenaOverlapsRegion` —— 占地判据（供 `pointContext` 与
//      `apply.js` 阶段 2.7 的撒布剔除消费；与 `giant-pyramid.js` 的同名函数同手法）。
//
// Worker 同构：本文件不得 import three、不得 fetch、不得自建 Worker。

import { TEMPLATES, rotateOffset } from '../../mesh/mesher.js';
import { getCityBoundsForSeed, buildCityLayout } from './city-layout.js';
import { generateHeight } from '../terrain.js';
import { SEA_Y } from '../../voxel/constants.js';
import { REGION_SIZE, LANDMARK_OFFSET, SNOW_LAND_SIZE } from './region-config.js';
import { getRegionSeededCenter } from './region-center.js';
import { regionLandmarkCenters } from './landmark-circles.js';
import { computeRegionLocalGiantPyramid, PYRAMID_HALF } from './giant-pyramid.js';
import { isTarnZone, computeTarnZone, TARN_ZONE_RADIUS } from './tarn-zone.js';

// ---------------------------------------------------------------------------
// 尺寸常量
//
// **含栏杆环的占地**：内容包围盒 39×77（烘焙产物实测），栏杆环在它外扩 1 格 →
// 41×79。落点判据与 `apply.js` 的裁剪都必须用这个「含环」的尺寸 —— 用 39×77 的话
// 栏杆会伸出落点判据之外，可能压到地标边缘。
// ---------------------------------------------------------------------------

/** 占地宽度（X 轴，含栏杆环） */
export const ARENA_WIDTH = 41;
/** 占地深度（Z 轴，含栏杆环）；长轴沿 Z（南北），与素材一致（不旋转，DR-7） */
export const ARENA_DEPTH = 79;
/** 占地半宽（AABB）：(41-1)/2 */
export const ARENA_HALF_X = (ARENA_WIDTH - 1) / 2;
/** 占地半深（AABB）：(79-1)/2 */
export const ARENA_HALF_Z = (ARENA_DEPTH - 1) / 2;

/**
 * 占地内允许的最大自然地形高差（格）。
 *
 * 地板铺在占地内**最低**点（`floorY`），所以高差直接等于「靠高一侧露出的土壁高度」
 * （下沉式竞技场）。实测 20 个 seed 的合法落点高差 ∈ [2, 10]；取 10 为上限 ——
 * 再高就不是「贴合地形」而是「嵌进山体」了。
 */
export const ARENA_MAX_SURFACE_SPAN = 10;

/**
 * 距城市南边界的最远搜索距离（格）。
 *
 * 实测：南门外紧邻的一条带在多数 seed 是浅海（`h < SEA_Y`）或压在地标上，落点常要
 * 往南退 1~85 格。240 是「退到仍在城市周边几百米内」的实用上限；超过它就不生成竞技场
 * （返回 null，不阻断 GEN）。
 */
export const ARENA_MAX_GAP = 240;

/** 粗筛采样步长（先按 6 格扫一遍判「整片干燥 + 高差粗估」，再逐格精修） */
const COARSE_STEP = 6;

/**
 * 地板下方补实的安全阀深度（格）。
 *
 * ⚠️ **为何需要补实**：`carveCaves` 在 `fillColumn` **之后**挖洞 —— 实测默认 seed 的竞技场
 * 占地内有 **236 列**在地板正下方就是空气（最深向下 21 格通到洞穴）。不补的话玩家挖开
 * 地板就掉进洞里（与城市补水体缺口同一条理由：清成 air 比看到水更糟）。
 *
 * ⚠️ **取值必须覆盖实测最坏值，不只看 default seed**：默认 seed 12345 最深 21；
 * seed 424242 有 **9 列深达 29 格**；而 20 个 seed 扫下来最坏是 seed 20240101 的
 * **33 格**（115 列）。取 **40** = 「实测最坏值 + 7 格余量」—— 上限太小会让那一小拨列
 * 静默地漏补（玩家掉进去才知道，方块层面看不出）。
 *
 * 但也不能取无穷大：极深的矿穴不应被一根几十格的实心柱堵死（会让地下矿洞突然断头）。
 * 32 已远超过「玩家站在竞技场上能感知到的深度」。
 *
 * 改地形 / 洞穴参数（`gen/caves.js` / `terrain.js`）后须重跑 `tests/arena.spec.mjs`
 * 与 `test-arena-gen.js` 的支撑用例 —— 它们查的是「地板下方必须有实心底」，会把阀门漏补
 * 的数量直接报出来。
 */
export const ARENA_SUPPORT_MAX_DEPTH = 40;

/** 横向搜索偏移表：以城门 x 为基准向两侧展开（0 优先：正对城门） */
const DX_OFFSETS = (() => {
  const out = [];
  for (let d = 0; d <= 120; d += 3) { out.push(d); if (d) out.push(-d); }
  return out;
})();

// ---------------------------------------------------------------------------
// ① 栏杆臂方向 ↔ (方块, 朝向)
// ---------------------------------------------------------------------------

/** 可用作栏杆的几何（`handrail` 转角件 + `handrailA` 直段件）。
 *  ⚠️ **刻意不含 `handrailB`**：实测其臂只伸到 ±0.25（格中心），与邻居的臂在格边界处
 *  断开 → 环上会出现看不见的缺口（方块层面完全看不出来）。 */
const RAIL_GEOMS = ['handrail', 'handrailA'];

/** 臂方向的判定阈值：
 *  · 柱体半径（`handrail` 0.25 / `handrailA` 0.15）以内不算臂；
 *  · 臂必须伸到格边界（≥0.5）之外才算「接得上邻居」—— 这是 `handrailB`（0.25）被排除的判据。 */
const ARM_REACH_MIN = 0.5;

/** 几何 quad → 该几何在 orient=0 时的臂方向集合（相对块中心，±X / ±Z）。 */
function baseArmsOf(geom) {
  const quads = TEMPLATES[geom];
  if (!quads) return [];
  let kind = 0;
  const reach = { xp: 0, xn: 0, zp: 0, zn: 0 };
  for (const q of quads) {
    for (const v of q.v) {
      const dx = v[0] - 0.5, dy = v[1] - 0.5, dz = v[2] - 0.5;
      if (dy < 0) continue;      // 只看上半部（臂层在 y≈0.85；柱体上下贯通）
      if (dx > 0) reach.xp = Math.max(reach.xp, dx);
      if (dx < 0) reach.xn = Math.max(reach.xn, -dx);
      if (dz > 0) reach.zp = Math.max(reach.zp, dz);
      if (dz < 0) reach.zn = Math.max(reach.zn, -dz);
    }
  }
  const arms = [];
  if (reach.xp >= ARM_REACH_MIN) arms.push('+X');
  if (reach.xn >= ARM_REACH_MIN) arms.push('-X');
  if (reach.zp >= ARM_REACH_MIN) arms.push('+Z');
  if (reach.zn >= ARM_REACH_MIN) arms.push('-Z');
  return arms;
}

/** 臂方向按 orient 旋转（**用 mesher 导出的同一份 `rotateOffset`**，不另写公式）。 */
function rotateArm(arm, orient) {
  const dx = arm === '+X' ? 1 : arm === '-X' ? -1 : 0;
  const dz = arm === '+Z' ? 1 : arm === '-Z' ? -1 : 0;
  const [rx, , rz] = rotateOffset(dx, 0, dz, orient);
  if (rx > 0) return '+X';
  if (rx < 0) return '-X';
  if (rz > 0) return '+Z';
  return '-Z';
}

/** (方块名, 朝向) → 臂方向集合 */
export function railArmSet(blockName, orient) {
  const base = baseArmsOf(blockName);
  return base.map((a) => rotateArm(a, orient));
}

/**
 * 「需要的臂集合」→ (方块名, 朝向)。
 *
 * 反查表从 `RAIL_GEOMS × 4 朝向` 现算（不手写字面量 —— 形状权威改动后这里自动跟上）。
 * 键是臂集合的规范序字符串（按 +X -X +Z -Z 排序）。
 *
 * @param {string[]} arms 需要的臂方向（顺序无关）
 * @returns {{name: string, orient: number}|null}
 */
export function railPlacementFor(arms) {
  const key = armKey(arms);
  if (!key) return null;
  for (const name of RAIL_GEOMS) {
    for (const orient of [0, 1, 2, 3]) {
      if (armKey(railArmSet(name, orient)) === key) return { name, orient };
    }
  }
  return null;
}

/** 臂集合 → 规范序键（'+X -X +Z -Z' 的子序列）。空集合返回 ''（调用方按 null 处理）。 */
function armKey(arms) {
  if (!arms || arms.length === 0 || arms.length > 2) return '';
  const order = ['+X', '-X', '+Z', '-Z'];
  const set = new Set(arms);
  return order.filter((a) => set.has(a)).join(' ');
}

// ---------------------------------------------------------------------------
// ② 落点
// ---------------------------------------------------------------------------

/** 锚点缓存（`seed → anchor`）。纯函数，`clearArenaCache()` 供单测隔离。 */
const anchorCache = new Map();
const ANCHOR_CACHE_MAX = 64;

/** 清空锚点缓存（单测隔离用；生产代码不需要调用） */
export function clearArenaCache() {
  anchorCache.clear();
}

/**
 * 城南门外竞技场的落点（每个 seed 一个）。
 *
 * 判据（全部满足才算合法，DR-4）：
 *   ① 完全在城南侧、与城市 bounds 的 AABB 不相交；
 *   ② 不压固定地标：地标圆 / 局部巨型金字塔 / 高台地带 / 雪原；
 *   ③ 占地内 100% 干燥（每格 `generateHeight >= SEA_Y`）；
 *   ④ 占地内高差 ≤ `ARENA_MAX_SURFACE_SPAN`。
 *
 * ⚠️ **刻意不判「占地内有无撒布结构/树」** —— 那些是点状内容，由竞技场反向让路
 * （`pointContext` 的 `kind:'none'` + 阶段 2.7 的 `inArenaFootprint` 剔除）。实测：
 * 让它们让路 → 20/20 seed 命中；要求避让它们 → 只有 7/16 seed 在 160 格内找得到落点。
 *
 * 扫描顺序：以**南门**（`placements` 里 `type==='gate' && z>0`）的 x 为基准，
 * `dz` 从 1 逐格向南，`dx` 按 `DX_OFFSETS` 展开 → 取**第一个**合法位置（「最近且干燥」）。
 *
 * @param {number} seed
 * @returns {{wx:number, wz:number, floorY:number, maxH:number, span:number}|null}
 */
export function computeArenaAnchor(seed) {
  const cached = anchorCache.get(seed);
  if (cached !== undefined) return cached;

  const city = buildCityLayout(seed);
  const cityBounds = getCityBoundsForSeed(seed);
  const gate = city.placements.find((p) => p.type === 'gate' && p.z > 0)
    || city.placements.find((p) => p.type === 'gate');
  if (!gate) {
    anchorCache.set(seed, null);
    return null;
  }

  const blockers = fixedBlockers(seed, cityBounds);
  let best = null;
  let fallback = null;

  outer:
  for (let gap = 1; gap <= ARENA_MAX_GAP; gap++) {
    for (const dx of DX_OFFSETS) {
      const wx = gate.x + dx;
      const wz = cityBounds.maxZ + ARENA_HALF_Z + gap;
      const box = {
        minX: wx - ARENA_HALF_X, maxX: wx + ARENA_HALF_X,
        minZ: wz - ARENA_HALF_Z, maxZ: wz + ARENA_HALF_Z,
      };
      // ① 必须完全在城南侧（出城）
      if (box.minZ <= cityBounds.maxZ) continue;
      // ② 固定地标
      if (blockers.some((b) => aabbOverlap(box, b))) continue;
      // ③ 粗筛：整片干燥 + 高差粗估（6 格采样，省 36 倍的 generateHeight 调用）
      const coarse = probeFootprint(seed, box, COARSE_STEP);
      if (coarse.wet || coarse.span > ARENA_MAX_SURFACE_SPAN + COARSE_STEP) continue;
      // ④ 精修：逐格，拿精确 min / max
      const fine = probeFootprint(seed, box, 1);
      if (fine.wet) continue;
      const cand = { wx, wz, floorY: fine.min, maxH: fine.max, span: fine.span };
      if (fine.span <= ARENA_MAX_SURFACE_SPAN) { best = cand; break outer; }
      // 粗筛放过的「略超一点」的落点留作兜底（避免整张图一个都不生成）
      if (!fallback || fine.span < fallback.span) fallback = cand;
    }
  }

  const result = best || fallback;
  if (anchorCache.size >= ANCHOR_CACHE_MAX) {
    anchorCache.delete(anchorCache.keys().next().value);
  }
  anchorCache.set(seed, result);
  return result;
}

/** 固定阻挡物（城市本身在调用方单独判，这里只收集地标类）。 */
function fixedBlockers(seed, cityBounds) {
  const out = [];
  const rxLo = Math.floor((cityBounds.minX - ARENA_HALF_X - 80) / REGION_SIZE);
  const rxHi = Math.floor((cityBounds.maxX + ARENA_HALF_X + 80) / REGION_SIZE);
  const rzLo = Math.floor(cityBounds.minZ / REGION_SIZE);
  const rzHi = Math.floor((cityBounds.maxZ + ARENA_MAX_GAP + ARENA_HALF_Z * 2 + 80) / REGION_SIZE);
  const snowR = SNOW_LAND_SIZE / 2 + 8;
  for (let rx = rxLo; rx <= rxHi; rx++) {
    for (let rz = rzLo; rz <= rzHi; rz++) {
      for (const c of regionLandmarkCenters(rx, rz, seed)) {
        out.push({ minX: c.cx - c.r, maxX: c.cx + c.r, minZ: c.cz - c.r, maxZ: c.cz + c.r });
      }
      // 巨型金字塔：用**局部**锚点（不触发它的 384 间距去重）—— 比最终锚点更保守，
      // 方向安全（与 `giant-pyramid.js` 自己排除高台时同手法）。
      const gp = computeRegionLocalGiantPyramid(rx, rz, seed);
      if (gp) {
        out.push({
          minX: gp.wx - PYRAMID_HALF, maxX: gp.wx + PYRAMID_HALF,
          minZ: gp.wz - PYRAMID_HALF, maxZ: gp.wz + PYRAMID_HALF,
        });
      }
      // 高台地带：整圆让路（地带是地基级内容）。
      if (isTarnZone(rx, rz, seed)) {
        const t = computeTarnZone(rx, rz, seed);
        out.push({
          minX: t.cx - TARN_ZONE_RADIUS, maxX: t.cx + TARN_ZONE_RADIUS,
          minZ: t.cz - TARN_ZONE_RADIUS, maxZ: t.cz + TARN_ZONE_RADIUS,
        });
      }
      // 雪原：中心由 region 播种中心 + 固定偏移派生（与 `computeRegionLayout` 同源常量）。
      const raw = getRegionSeededCenter(rx, rz, seed);
      const sx = raw.centerX + LANDMARK_OFFSET.SNOW_LAND_X;
      const sz = raw.centerZ + LANDMARK_OFFSET.SNOW_LAND_Z;
      out.push({ minX: sx - snowR, maxX: sx + snowR, minZ: sz - snowR, maxZ: sz + snowR });
    }
  }
  return out;
}

/** 占地内地形探测：返回 { wet, min, max, span }。`wet` 一旦命中立即返回（省遍历）。 */
function probeFootprint(seed, box, step) {
  let min = Infinity, max = -Infinity;
  for (let x = box.minX; x <= box.maxX; x += step) {
    for (let z = box.minZ; z <= box.maxZ; z += step) {
      const h = generateHeight(x, z, seed);
      if (h < SEA_Y) return { wet: true, min: 0, max: 0, span: 0 };
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }
  return { wet: false, min, max, span: max - min };
}

function aabbOverlap(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
}

// ---------------------------------------------------------------------------
// ③ 占地判据（供 pointContext 与 apply.js 消费）
// ---------------------------------------------------------------------------

/**
 * 点是否落在任一竞技场占地内（含栏杆环）。
 *
 * 与 `inGiantPyramidFootprint` 同签名同语义：传 `layouts.map(l => l.arena)` 即可，
 * `null` 元素安全跳过。
 *
 * @param {number} wx @param {number} wz
 * @param {Array<{wx:number, wz:number}|null>} anchors
 */
export function inArenaFootprint(wx, wz, anchors) {
  if (!anchors) return false;
  for (const a of anchors) {
    if (!a) continue;
    if (Math.abs(wx - a.wx) <= ARENA_HALF_X && Math.abs(wz - a.wz) <= ARENA_HALF_Z) return true;
  }
  return false;
}

/**
 * 竞技场占地 AABB 是否与本 region 相交（layout 层裁剪用：不相交则不携带锚点，
 * 省掉跨 region 的无谓下发）。
 */
export function arenaOverlapsRegion(anchor, regionX, regionZ) {
  if (!anchor) return false;
  const minX = anchor.wx - ARENA_HALF_X, maxX = anchor.wx + ARENA_HALF_X;
  const minZ = anchor.wz - ARENA_HALF_Z, maxZ = anchor.wz + ARENA_HALF_Z;
  const rMinX = regionX * REGION_SIZE, rMaxX = rMinX + REGION_SIZE - 1;
  const rMinZ = regionZ * REGION_SIZE, rMaxZ = rMinZ + REGION_SIZE - 1;
  return minX <= rMaxX && maxX >= rMinX && minZ <= rMaxZ && maxZ >= rMinZ;
}
