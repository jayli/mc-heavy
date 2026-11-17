// src/gen/structures/jungle-fortress.js — 丛林要塞落点（City 西方第一个丛林地带）
//
// 权威：docs/superpowers/specs/2026-11-17-jungle-fortress-port-design.md
//
// 与废弃堡垒（ruined-citadel.js）同构：本文件只做**全局唯一锚点**的纯函数发现，
// 光栅化与地形整形在 apply.js 阶段 2.95 / jungle-fortress-terrain.js。
//
// ## 为什么是「城西第一个丛林」（用户裁定 2026-11-17）
// 用户原话：「丛林要塞生成在 City 西方第一个丛林地带中。只生成这一个地方。」
// ⇒ 与废弃堡垒同为城西口径（方向固定），**不是**「离 City 最近」的逐 seed 方位。
//
// ## 为什么必须地形整形（而不是只清结构占用列）
// FOREST 的地表起伏 span 14~16（DESERT 只有 5，因为 TERRAIN_HEIGHT_PARAMS 给沙漠
// 乘了 0.5 压平系数而 FOREST 没有）。实测三档处置：
//   · 整形压平 + 缓坡：挖 18.4~21.3 万格 / 填 0 / 房间被埋 0 / 墙脚露空 0  ← 选定
//   · 只清结构占用列：5,425 格地上城墙空气被埋、458 列墙脚露空
//   · 整体架高 + 支撑柱：6.6 万格柱、8,925 列露空
//
// Worker 同构：本文件不得 import three、不得自建 Worker、**不得 fetch**。
import { getBiome } from '../noise.js';
import { generateHeight } from '../terrain.js';
import { SEA_Y } from '../../voxel/constants.js';
import { getCityBoundsForSeed } from './city-layout.js';
import { REGION_SIZE, CITY_TRANSITION_SIZE } from './region-config.js';
import { isTarnZone, computeTarnZone, TARN_ZONE_RADIUS } from './tarn-zone.js';
import { computeShallowTarnAnchor, SHALLOW_TARN_OUTER_RADIUS } from './shallow-water-tarns.js';
import { computeArenaAnchor, ARENA_HALF_X, ARENA_HALF_Z } from './arena.js';
import { computeBurningArenaAnchor, BURNING_ARENA_HALF } from './burning-arena.js';
import { computeRuinedCitadelAnchor, RUINED_CITADEL_HALF_X, RUINED_CITADEL_HALF_Z } from './ruined-citadel.js';
import { JUNGLE_FORTRESS_HALF_X, JUNGLE_FORTRESS_HALF_Z } from './jungle-fortress-data.js';

export { JUNGLE_FORTRESS_HALF_X, JUNGLE_FORTRESS_HALF_Z } from './jungle-fortress-data.js';

/** 向西搜索的最远距离（格）。超过它就不生成（返回 null，不阻断 GEN） */
export const JUNGLE_FORTRESS_MAX_GAP = 2400;

/** 纬度搜索半宽（相对城市 z 中心） */
export const JUNGLE_FORTRESS_SEARCH_HALF_Z = 900;

/** 占地东缘到城市 bounds 的最小净距（复用 CITY_TRANSITION_SIZE，红线 1 不另写 32） */
const CITY_CLEARANCE = CITY_TRANSITION_SIZE;

/**
 * 粗筛网格步长（格）。
 *
 * ⚠️ 两级筛选是性能关键：161×155 = 24,955 格逐格全检，城西窗内有上千个森林点
 * ⇒ 全精检要几十秒（锚点在 GEN 计时路径上，不可接受）。
 * 实测粗筛后每 seed 只需 1~4 次精检，本结构自身耗时 ~20ms。
 */
const COARSE_STEP = 8;

const anchorMemo = new Map();
const ANCHOR_MEMO_MAX = 64;

/** 清空锚点 memo（单测隔离用；生产代码不需要调用） */
export function clearJungleFortressCache() {
  anchorMemo.clear();
}

/**
 * 占地内逐格全检：全 FOREST + 全干燥（`generateHeight > SEA_Y`）。
 *
 * ⚠️ 干燥判据与 `fillColumn` 的水体判据同源（红线 1）：`h > SEA_Y` ⟺ 不填体素水；
 * 同时海面平面遮罩（`ocean-mask.js`）也读 `generateHeight` ⇒ 一条判据堵住两处水源。
 * 这是「遇湿即止」缓坡带能做到零水格、零门控改动的前提。
 *
 * @returns {{minH:number, maxH:number, span:number}|null}
 */
function exactFootprint(wx, wz, seed) {
  let minH = Infinity, maxH = -Infinity;
  for (let dz = -JUNGLE_FORTRESS_HALF_Z; dz <= JUNGLE_FORTRESS_HALF_Z; dz++) {
    for (let dx = -JUNGLE_FORTRESS_HALF_X; dx <= JUNGLE_FORTRESS_HALF_X; dx++) {
      const x = wx + dx, z = wz + dz;
      if (getBiome(x, z, seed) !== 'FOREST') return null;
      const h = generateHeight(x, z, seed);
      if (h <= SEA_Y) return null;
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
  }
  return { minH, maxH, span: maxH - minH };
}

/**
 * 地基级大结构的 AABB 冲突判定（**只这六类**：城市 + 五个既有大结构）。
 *
 * ⚠️ **方向是城西**：判据用占地**东缘** `wx + HALF_X` 对城市**西界** `city.minX`。
 * 照抄大竞技场那行（`wx - HALF <= city.maxX + CLEAR`，城东）会让**每个**候选都被拒
 * ⇒ 8/8 seed 返回 null，搜索几毫秒就退出（结构永不生成，且没有任何报错）。
 *
 * ⚠️ x/z 半宽不同（80/77）⇒ 两个方向分开比，不得共用一个半径。
 *
 * @returns {string|null} 冲突原因（诊断用），无冲突返回 null
 */
function fixedBlockerAt(wx, wz, city, shallow, arena, burningArena, citadel, seed) {
  if (wx + JUNGLE_FORTRESS_HALF_X >= city.minX - CITY_CLEARANCE) return 'city';
  if (shallow &&
      Math.hypot(shallow.wx - wx, shallow.wz - wz) <= SHALLOW_TARN_OUTER_RADIUS + JUNGLE_FORTRESS_HALF_X) {
    return 'shallowTarn';
  }
  if (arena &&
      Math.abs(arena.wx - wx) <= ARENA_HALF_X + JUNGLE_FORTRESS_HALF_X &&
      Math.abs(arena.wz - wz) <= ARENA_HALF_Z + JUNGLE_FORTRESS_HALF_Z) {
    return 'arena';
  }
  if (burningArena &&
      Math.abs(burningArena.wx - wx) <= BURNING_ARENA_HALF + JUNGLE_FORTRESS_HALF_X &&
      Math.abs(burningArena.wz - wz) <= BURNING_ARENA_HALF + JUNGLE_FORTRESS_HALF_Z) {
    return 'burningArena';
  }
  if (citadel &&
      Math.abs(citadel.wx - wx) <= RUINED_CITADEL_HALF_X + JUNGLE_FORTRESS_HALF_X &&
      Math.abs(citadel.wz - wz) <= RUINED_CITADEL_HALF_Z + JUNGLE_FORTRESS_HALF_Z) {
    return 'ruinedCitadel';
  }
  // 高台地带：整圆让路。必须扫占地触及的全部 region（161×155 可跨 2×2 个 region）
  const rxLo = Math.floor((wx - JUNGLE_FORTRESS_HALF_X) / REGION_SIZE);
  const rxHi = Math.floor((wx + JUNGLE_FORTRESS_HALF_X) / REGION_SIZE);
  const rzLo = Math.floor((wz - JUNGLE_FORTRESS_HALF_Z) / REGION_SIZE);
  const rzHi = Math.floor((wz + JUNGLE_FORTRESS_HALF_Z) / REGION_SIZE);
  for (let rx = rxLo; rx <= rxHi; rx++) {
    for (let rz = rzLo; rz <= rzHi; rz++) {
      if (!isTarnZone(rx, rz, seed)) continue;
      const t = computeTarnZone(rx, rz, seed);
      if (!t) continue;
      if (Math.abs(t.cx - wx) <= TARN_ZONE_RADIUS + JUNGLE_FORTRESS_HALF_X &&
          Math.abs(t.cz - wz) <= TARN_ZONE_RADIUS + JUNGLE_FORTRESS_HALF_Z) return 'tarn';
    }
  }
  return null;
}

/**
 * 一个候选点是否**完全合法**（导出供单测复用同一份判据 —— 红线 1）。
 *
 * ⚠️ 必须导出：单测要钉「锚点是西方第一个」，就得能判「另一个更东的点合不合法」。
 * 若测试自己写一份判据会与搜索侧漂移（大竞技场踩过：测试漏了城市净距判据，
 * 把被城市挡掉的点当成「更近的合法候选」报假 FAIL）。
 *
 * @returns {{ok:true, minH:number, maxH:number, span:number}|{ok:false, why:string}}
 */
export function jungleFortressCandidateValid(wx, wz, seed) {
  const city = getCityBoundsForSeed(seed);
  const blocker = fixedBlockerAt(wx, wz, city,
    computeShallowTarnAnchor(seed), computeArenaAnchor(seed),
    computeBurningArenaAnchor(seed), computeRuinedCitadelAnchor(seed), seed);
  if (blocker) return { ok: false, why: blocker };
  const f = exactFootprint(wx, wz, seed);
  if (!f) return { ok: false, why: 'footprint' };
  return { ok: true, minH: f.minH, maxH: f.maxH, span: f.span };
}

/**
 * 丛林要塞的落点（**每个 seed 恰好一个**，用户裁定「只生成这一个地方」）。
 *
 * ## 判据
 *   ① 整个 161×155 占地都是 FOREST biome；
 *   ② 占地逐格 `generateHeight > SEA_Y`（干燥，堵体素水与海面平面两处）；
 *   ③ 在 City **西侧**，整个占地出城且净距 ≥ `CITY_TRANSITION_SIZE`；
 *   ④ 不与高台地带 / 浅水高台 / 围场 / 大竞技场 / 废弃堡垒重叠；
 *   ⑤ 取「**西方第一个**」= 候选按 `x 降序 → |z−cityCz| 升序 → z 升序` 后第一个合法的。
 *
 * ⚠️ **确定性**：tie 用坐标字典序 ⇒ 跨机 / 跨 Worker 结果恒一致（红线 2）。
 *
 * @param {number} seed
 * @returns {{wx:number, wz:number, floorY:number, span:number}|null} 找不到返回 null
 */
export function computeJungleFortressAnchor(seed) {
  if (anchorMemo.has(seed)) return anchorMemo.get(seed);

  const city = getCityBoundsForSeed(seed);
  const cityCz = Math.round((city.minZ + city.maxZ) / 2);
  const shallow = computeShallowTarnAnchor(seed);
  const arena = computeArenaAnchor(seed);
  const burningArena = computeBurningArenaAnchor(seed);
  const citadel = computeRuinedCitadelAnchor(seed);

  // 搜索窗：城西起点 = 城市西界 − 半宽 − 净空（是**最东**的合法 x），向西最多 MAX_GAP
  const xHi = city.minX - JUNGLE_FORTRESS_HALF_X - CITY_CLEARANCE;
  const xLo = xHi - JUNGLE_FORTRESS_MAX_GAP;
  const z0 = cityCz - JUNGLE_FORTRESS_SEARCH_HALF_Z;
  const z1 = cityCz + JUNGLE_FORTRESS_SEARCH_HALF_Z;

  // ⚠️ **必须用 floor 而不是 ceil**：粗筛只能是精检的**必要条件**（覆盖范围更小 = 更宽）。
  // ceil 会让粗筛覆盖超出精检，于是「精检范围内全合法、但粗筛多出来那圈有非森林」的点
  // 被误杀 ⇒ 跳过更东的合法候选，违反「西方第一个」口径。
  // ⚠️ x/z 半宽不同（80/77）⇒ giX/giZ 分开算。
  const giX = Math.floor(JUNGLE_FORTRESS_HALF_X / COARSE_STEP);
  const giZ = Math.floor(JUNGLE_FORTRESS_HALF_Z / COARSE_STEP);

  // ⚠️ 网格必须向四周外扩 gi 格：coarseOk 要查候选的 ±gi 邻域，
  // 若网格只覆盖搜索窗本身，窗边缘候选的邻域会越界 → 返回 false → 合法候选被静默误杀。
  const gx0 = xLo - giX * COARSE_STEP;
  const gz0 = z0 - giZ * COARSE_STEP;
  const nx = Math.ceil((xHi + giX * COARSE_STEP - gx0) / COARSE_STEP) + 1;
  const nz = Math.ceil((z1 + giZ * COARSE_STEP - gz0) / COARSE_STEP) + 1;

  const forest = new Uint8Array(nx * nz);
  const hgt = new Float32Array(nx * nz);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const wx = gx0 + i * COARSE_STEP, wz = gz0 + j * COARSE_STEP;
      forest[i + j * nx] = getBiome(wx, wz, seed) === 'FOREST' ? 1 : 0;
      hgt[i + j * nx] = generateHeight(wx, wz, seed);
    }
  }

  // 候选 = 搜索窗内的森林点（外扩那圈只作邻域数据，不当候选）
  const iLo = giX, iHi = Math.ceil((xHi - gx0) / COARSE_STEP);
  const jLo = giZ, jHi = Math.ceil((z1 - gz0) / COARSE_STEP);
  const pts = [];
  for (let i = iLo; i <= iHi; i++) {
    for (let j = jLo; j <= jHi; j++) {
      if (!forest[i + j * nx]) continue;
      pts.push([gx0 + i * COARSE_STEP, gz0 + j * COARSE_STEP, i, j]);
    }
  }
  // 「西方第一个」：x 降序（越东越优先）→ |z−cityCz| 升序 → z 升序
  pts.sort((a, b) =>
    (b[0] - a[0]) ||
    (Math.abs(a[1] - cityCz) - Math.abs(b[1] - cityCz)) ||
    (a[1] - b[1]));

  /** 粗筛：网格邻域内全森林 + 全干燥（必要条件，命中后仍要精检） */
  const coarseOk = (i, j) => {
    for (let dj = -giZ; dj <= giZ; dj++) {
      const jj = j + dj;
      if (jj < 0 || jj >= nz) return false;
      for (let di = -giX; di <= giX; di++) {
        const ii = i + di;
        if (ii < 0 || ii >= nx) return false;
        const k = ii + jj * nx;
        if (!forest[k]) return false;
        if (hgt[k] <= SEA_Y) return false;
      }
    }
    return true;
  };

  let result = null;
  for (const [wx, wz, i, j] of pts) {
    if (!coarseOk(i, j)) continue;
    if (fixedBlockerAt(wx, wz, city, shallow, arena, burningArena, citadel, seed)) continue;
    const f = exactFootprint(wx, wz, seed);
    if (!f) continue;
    result = Object.freeze({ wx, wz, floorY: f.minH, span: f.span });
    break;
  }
  if (anchorMemo.size >= ANCHOR_MEMO_MAX) anchorMemo.delete(anchorMemo.keys().next().value);
  anchorMemo.set(seed, result);
  return result;
}

/**
 * 点是否落在丛林要塞占地内（161×155 矩形）。
 *
 * 唯一权威（红线 1）：apply.js 阶段 2.7 的撒布剔除、pointContext 的植被让路都用这一份。
 * ⚠️ x/z 半宽不同（80/77），两个方向分开比。
 *
 * @param {Array<{wx:number, wz:number}|null>} anchors 邻域 layouts 的 jungleFortress
 */
export function inJungleFortressFootprint(wx, wz, anchors) {
  if (!anchors) return false;
  for (const a of anchors) {
    if (!a) continue;
    if (Math.abs(wx - a.wx) <= JUNGLE_FORTRESS_HALF_X &&
        Math.abs(wz - a.wz) <= JUNGLE_FORTRESS_HALF_Z) return true;
  }
  return false;
}