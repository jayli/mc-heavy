// src/gen/structures/ruined-citadel.js — 废弃堡垒（Ruined Citadel）落点候选发现
//
// 权威：docs/superpowers/specs/2026-11-10-ruined-citadel-port-design.md
//
// 两段式的前一段（与 burning-arena / giant-pyramid / shallow-water-tarns 同构，红线 2）：
//   本文件               computeRuinedCitadelAnchor()：全局唯一锚点（纯函数、无状态）
//   apply.js 阶段 2.94   按锚点光栅化 + 撒布/植被的让路判据
//
// Worker 同构：本文件不得 import three、不得自建 Worker、**不得 fetch**
// （产物 JSON 由 apply.js 的 `preloadStructures` 统一拉取）。
//
// ## 为什么是「城西最近的干燥沙漠」（用户裁定）
// 与大竞技场（城东）对称：City 两侧各一个 Cataclysm 大结构，互不相干。
// 用户要求「必须且唯一」⇒ 落点必须存在，故沿用大竞技场的**压制 vs 避让**裁定：
//   · **避让**只留「地基级大结构」：城市 / 高台地带 / 浅水高台 / 围场 / 大竞技场；
//   · **压制**其余内容：地标（金字塔/冰封山/岛/平地/雪原）、巨型金字塔、空岛、撒布、植被。
// 实测 8/8 seed 命中 span=5（见 `test-ruined-citadel-gen.js` 的冻结锚点表）。
//
// ## 为什么多了「干燥」判据（v2 用户裁定 ⑦，大竞技场没有这一条）
// 本结构有 **44 层地下地牢**（甲板以下 44 格），而大竞技场只有 9 层基座。地牢若泡在水里，
// 从房间往上看会看到「水天花板」。本引擎的水有两处来源（spec §2.10）：
//   ① 体素水：`fillColumn` 仅在 `generateHeight < SEA_Y` 的列填水；
//   ② 海面平面：`ocean.js` 在 y = SEA_Y+0.5 = -1.5 渲染，遮罩五点取样 ±3.5 格。
// ⇒ 判据 = 占地 **外扩 4 格**（ceil(3.5)）内每格 `generateHeight > SEA_Y`，同时堵住两者。
// ⚠️ 判据用 `generateHeight`（自然地形的唯一权威），与 `fillColumn`/`ocean-mask` 同源（红线 1）。
// 实测加此判据后 8/8 seed 锚点与不加时**逐位相同**（沙漠腹地干燥区远大于外扩 4 格的余量），
// 但搜索耗时从 49~131ms 涨到 ~1000ms ⇒ 必须预热（见 `world-worker.js` 的 layout 入口）。
import { getBiome } from '../noise.js';
import { generateHeight } from '../terrain.js';
import { SEA_Y } from '../../voxel/constants.js';
import { getCityBoundsForSeed } from './city-layout.js';
import { REGION_SIZE, CITY_TRANSITION_SIZE, LANDMARK_OFFSET } from './region-config.js';
import { isTarnZone, computeTarnZone, TARN_ZONE_RADIUS } from './tarn-zone.js';
import { computeShallowTarnAnchor, SHALLOW_TARN_OUTER_RADIUS } from './shallow-water-tarns.js';
import { computeArenaAnchor, ARENA_HALF_X, ARENA_HALF_Z } from './arena.js';
import { computeBurningArenaAnchor, BURNING_ARENA_HALF } from './burning-arena.js';
import {
  getPyramidCenterInRegion, getFrozenMountainCenterInRegion,
  getPlainLandCenterInRegion, getIslandCenterInRegion,
} from './landmarks.js';
import { computeRegionLocalGiantPyramid, PYRAMID_HALF } from './giant-pyramid.js';
import { computeSkyCandidates } from './sky-structures.js';
import { getRegionSeededCenter } from './region-center.js';
import { LANDMARK_CLEARANCE } from './landmark-circles.js';
// 纯数据（VARIANTS / HALF_X / HALF_Z）的唯一权威在 `ruined-citadel-data.js`（零 node 依赖）。
// ⚠️ **不得在本文件再定义一份半宽**（红线 1）：两份字面量会漂移出「AABB 裁剪判据与产物尺寸
// 两套口径」（形态：结构缺一整条边，方块层面看不出是裁剪差 1）。
// 本文件 re-export 它，使 apply.js / 单测仍可从本模块 import（与 `FACING_TO_ORIENT` 同手法）。
export { RUINED_CITADEL_HALF_X, RUINED_CITADEL_HALF_Z } from './ruined-citadel-data.js';
import { RUINED_CITADEL_HALF_X, RUINED_CITADEL_HALF_Z } from './ruined-citadel-data.js';

/**
 * 结构高度（归一化 y ∈ [1, 63]）。塔顶世界高度 = `floorY + (RUINED_CITADEL_HEIGHT - FLOOR_ROW)`
 * = floorY + 18。
 *
 * ⚠️ 甲板层（floorRow=45）不是最底层：甲板以下还有 44 层地牢。故「结构高度 63」里
 * 只有 18 格在甲板上方（塔楼），其余 45 格在地下。
 */
export const RUINED_CITADEL_HEIGHT = 63;

/**
 * 甲板层在归一化坐标里的 y（= 产物 JSON 的 `floorRow`）。
 *
 * ⚠️ **不能用 `floorRowOf()` 读**：它读主线程模块缓存，而产物只在 GEN Worker 里加载过
 * ⇒ 主线程恒返回兜底值 1（大竞技场 `BURNING_ARENA_SUMMON_FEET_DY` 踩过同源坑）。
 * 故这里是**派生冻结值**，与 `tools/ruined-citadel-fingerprint.mjs` 的 `FLOOR_ROW` 同源，
 * 由 `test-ruined-citadel-gen.js` 的产物断言钉住（产物是权威）。
 */
export const RUINED_CITADEL_FLOOR_ROW = 45;

/**
 * 占地内地表高差上限（格）—— **渐进放宽**的第一档。
 *
 * 实测（8 seed，城西 ±2400×±900 窗）：106×108 占地在 span≤4 下候选数 **0** ——
 * 本结构占地是大竞技场（85×85）的 1.26 倍，沙漠地形容不下那么平的一块。
 * span≤5 时 8/8 seed 全部命中，故 5 是「相对平坦」的最小可行档（与大竞技场同档）。
 */
export const RUINED_CITADEL_MAX_SPAN = 5;

/**
 * 渐进放宽档位。最后一档 8 是兜底（保证「必须生成」不因某 seed 的沙漠太起伏而失败）。
 *
 * ⚠️ 放宽顺序是载荷性的：先严后松，取第一个有解的档 ⇒ 既满足「相对平坦」，又保证「必须生成」。
 */
export const RUINED_CITADEL_SPANS = Object.freeze([4, 5, 6, 8]);

/** 占地东缘到城市 bounds 的最小净距（复用 `CITY_TRANSITION_SIZE`，红线 1 不另写 32） */
const CITY_CLEARANCE = CITY_TRANSITION_SIZE;

/**
 * 向西搜索的最远距离（格）。超过它就不生成（返回 null，不阻断 GEN）。
 *
 * 实测 8 个 seed 的锚点都落在城西起点以西 8~384 格内 ⇒ 2400 是极宽的兜底
 * （与 `SHALLOW_TARN_MAX_GAP` 同口径）。
 */
export const RUINED_CITADEL_MAX_GAP = 2400;

/** 纬度搜索半宽（相对城市 z 中心）。实测锚点 z 偏移最大 260 ⇒ 取 900 留余量 */
const SEARCH_HALF_Z = 900;

/**
 * 干燥判据的**外扩格数**（spec §2.10，v2 用户裁定 ⑦）。
 *
 * = `ceil(OCEAN_MASK_OFFSET)` = ceil(3.5) = 4：海面平面遮罩是五点取样（中心 + 四方向各
 * ±3.5 格），故占地外扩 4 格内全干燥 ⟺ 遮罩在占地上恒假 ⟺ 海面平面不会切进甲板下方。
 * 同时 `generateHeight > SEA_Y` ⟺ `fillColumn` 不填体素水 ⇒ 一条判据堵住两处水源。
 */
export const RUINED_CITADEL_DRY_MARGIN = 4;

/**
 * 瞬移落点与占地**东缘**的水平净距（格）。
 *
 * 设置面板「堡垒」按钮的落点 = 占地东缘再向东 `GAP` 格（见 `ruinedCitadelTeleportPoint`）。
 * ⚠️ **方向与大竞技场相反**：大竞技场在城东 ⇒ 落点在其**西**缘（City 那一侧）；
 * 本结构在城西 ⇒ 落点在其**东**缘。两者都是「靠 City 的那一侧」，玩家面朝结构就能看到它。
 * 取 6 的理由同大竞技场：离缘太近会被结构挡视线，太远（>10）失去「就在门口」的方位感。
 */
export const RUINED_CITADEL_TELEPORT_GAP = 6;

/**
 * 粗筛网格步长（格）。
 *
 * ⚠️ **两级筛选是性能关键**：106×108 = 11,448 格逐格全检，加上干燥判据外扩 4 格是
 * 114×116 = 13,224 格；城西窗内有上万个沙漠点 ⇒ 全精检要几十秒（锚点在 GEN 计时路径上，
 * 不可接受）。粗筛用 8 格网格先淘汰 99.99%，实测每 seed 只需个位数次精检。
 * ⚠️ 粗筛只是**必要条件**（网格点全沙漠 + 高差达标 + 干燥），命中后仍要逐格精检 ——
 * 网格点之间的格子可能不是沙漠（与巨型金字塔「step=2 采样漏判」同一教训）。
 */
const COARSE_STEP = 8;

/** 锚点 memo（键 = seed）。同 `computeBurningArenaAnchor` / `computeShallowTarnAnchor` 手法 */
const anchorMemo = new Map();
const ANCHOR_MEMO_MAX = 64;

/** 清空锚点 memo（单测隔离用；生产代码不需要调用） */
export function clearRuinedCitadelCache() {
  anchorMemo.clear();
}

/**
 * 占地内逐格全检：全 DESERT + 高差 ≤ span（**只扫占地本身**）。
 *
 * ⚠️ 干燥判据**不在这里**（它要外扩 4 格，范围不同），见 `exactDry`。
 * @returns {{minH:number, maxH:number, span:number}|null}
 */
function exactFootprint(wx, wz, span, seed) {
  let minH = Infinity, maxH = -Infinity;
  for (let dz = -RUINED_CITADEL_HALF_Z; dz <= RUINED_CITADEL_HALF_Z; dz++) {
    for (let dx = -RUINED_CITADEL_HALF_X; dx <= RUINED_CITADEL_HALF_X; dx++) {
      if (getBiome(wx + dx, wz + dz, seed) !== 'DESERT') return null;
      const h = generateHeight(wx + dx, wz + dz, seed);
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
      if (maxH - minH > span) return null;   // 早退：已超阈值就不必扫完
    }
  }
  return { minH, maxH, span: maxH - minH };
}

/**
 * 干燥判据（spec §2.10）：占地 **+ 外扩 `RUINED_CITADEL_DRY_MARGIN` 格**内每格
 * `generateHeight > SEA_Y`。
 *
 * ⚠️ **范围比 `exactFootprint` 大 4 格**，且**不要求外扩那圈是 DESERT**（外扩圈只判干燥：
 * 它不进占地，biome 是什么无关紧要；要求它也是沙漠会白白拒掉合法落点）。
 * @returns {boolean} true = 全干燥
 */
function exactDry(wx, wz, seed) {
  const M = RUINED_CITADEL_DRY_MARGIN;
  for (let dz = -(RUINED_CITADEL_HALF_Z + M); dz <= RUINED_CITADEL_HALF_Z + M; dz++) {
    for (let dx = -(RUINED_CITADEL_HALF_X + M); dx <= RUINED_CITADEL_HALF_X + M; dx++) {
      if (generateHeight(wx + dx, wz + dz, seed) <= SEA_Y) return false;
    }
  }
  return true;
}

/**
 * 地基级大结构的 AABB 冲突判定（**只这五类**，理由见文件头「压制 vs 避让」）。
 * @returns {string|null} 冲突原因（诊断用），无冲突返回 null
 */
function fixedBlockerAt(wx, wz, city, shallow, arena, burningArena, seed) {
  // ① 城市：整个占地都要出城（不是圆心出城）。
  //    ⚠️ **方向是城西**：判据用占地**东缘** `wx + HALF_X` 对城市**西界** `city.minX`。
  //    照抄大竞技场那行（`wx - HALF <= city.maxX + CLEAR`，城东）会让**每个**候选都被拒
  //    ⇒ 8/8 seed 返回 null，搜索 9ms 就退出（spec §2.5 记的实测坑）。
  if (wx + RUINED_CITADEL_HALF_X >= city.minX - CITY_CLEARANCE) return 'city';
  // ② 浅水高台：整形区（含缓坡）整圆让路
  if (shallow &&
      Math.hypot(shallow.wx - wx, shallow.wz - wz) <= SHALLOW_TARN_OUTER_RADIUS + RUINED_CITADEL_HALF_X) {
    return 'shallowTarn';
  }
  // ③ 围场（城南门外，全世界一个）—— x/z 半宽不同，分开比
  if (arena &&
      Math.abs(arena.wx - wx) <= ARENA_HALF_X + RUINED_CITADEL_HALF_X &&
      Math.abs(arena.wz - wz) <= ARENA_HALF_Z + RUINED_CITADEL_HALF_Z) {
    return 'arena';
  }
  // ④ 大竞技场（城东，v2.85）—— 与本结构分居 City 两侧，理论上不可能撞，
  //    但判据必须在跑：将来若改任一结构的落点方向，这条是唯一防线。
  if (burningArena &&
      Math.abs(burningArena.wx - wx) <= BURNING_ARENA_HALF + RUINED_CITADEL_HALF_X &&
      Math.abs(burningArena.wz - wz) <= BURNING_ARENA_HALF + RUINED_CITADEL_HALF_Z) {
    return 'burningArena';
  }
  // ⑤ 高台地带：整圆让路（地带是地基级内容，与本结构同级，两者不得重叠）。
  //    ⚠️ 必须扫占地触及的全部 region（106×108 可跨 2×2 个 region）。
  const rxLo = Math.floor((wx - RUINED_CITADEL_HALF_X) / REGION_SIZE);
  const rxHi = Math.floor((wx + RUINED_CITADEL_HALF_X) / REGION_SIZE);
  const rzLo = Math.floor((wz - RUINED_CITADEL_HALF_Z) / REGION_SIZE);
  const rzHi = Math.floor((wz + RUINED_CITADEL_HALF_Z) / REGION_SIZE);
  for (let rx = rxLo; rx <= rxHi; rx++) {
    for (let rz = rzLo; rz <= rzHi; rz++) {
      if (!isTarnZone(rx, rz, seed)) continue;
      const t = computeTarnZone(rx, rz, seed);
      if (!t) continue;
      if (Math.abs(t.cx - wx) <= TARN_ZONE_RADIUS + RUINED_CITADEL_HALF_X &&
          Math.abs(t.cz - wz) <= TARN_ZONE_RADIUS + RUINED_CITADEL_HALF_Z) return 'tarn';
    }
  }
  return null;
}

/**
 * 废弃堡垒的落点（**每个 seed 恰好一个**，用户裁定「必须且唯一」）。
 *
 * ## 判据
 *   ① 整个 106×108 占地都是 DESERT biome；
 *   ② **占地 + 外扩 4 格**每格 `generateHeight > SEA_Y`（干燥，spec §2.10）；
 *   ③ 占地内地表高差 ≤ `RUINED_CITADEL_SPANS` 的某一档（先严后松，取第一个有解的档）；
 *   ④ 在 City **西侧**，且与城市 bounds 净距 ≥ `CITY_TRANSITION_SIZE`；
 *   ⑤ 不与高台地带 / 浅水高台 / 围场 / **大竞技场**重叠；
 *   ⑥ 在所有满足 ①~⑤ 的点里取**距城市中心最近**的（「城西最近」的口径）。
 *
 * ⚠️ **确定性**：候选按「距城市中心距离 → x → z」排序，tie 用坐标字典序 ⇒ 跨机 / 跨 Worker
 * 结果恒一致（红线 2）。不用 `seededRandom` 乱序 —— 用户要的是「最近」，不是「随机一个」。
 *
 * @param {number} seed
 * @returns {{wx:number, wz:number, floorY:number, span:number}|null} 找不到返回 null（不阻断 GEN）
 */
export function computeRuinedCitadelAnchor(seed) {
  if (anchorMemo.has(seed)) return anchorMemo.get(seed);

  const city = getCityBoundsForSeed(seed);
  const cityCx = Math.round((city.minX + city.maxX) / 2);
  const cityCz = Math.round((city.minZ + city.maxZ) / 2);
  const shallow = computeShallowTarnAnchor(seed);
  const arena = computeArenaAnchor(seed);
  const burningArena = computeBurningArenaAnchor(seed);

  // 搜索窗：城西（起点 = 城市西界 − 半宽 − 净空，是**最东**的合法 x），向西最多 MAX_GAP
  const xHi = city.minX - RUINED_CITADEL_HALF_X - CITY_CLEARANCE;
  const xLo = xHi - RUINED_CITADEL_MAX_GAP;
  const z0 = cityCz - SEARCH_HALF_Z;
  const z1 = cityCz + SEARCH_HALF_Z;

  // ⚠️ **必须用 `floor` 而不是 `ceil`**（大竞技场实测踩到的真缺陷之一）：粗筛只能是精检的
  // **必要条件**（覆盖范围更小 = 更宽），绝不能更严。`ceil` 会让粗筛覆盖范围超出精检，
  // 于是「精检范围内全合法、但粗筛多出来的那圈上有非沙漠」的点被误杀 —— 实测大竞技场
  // seed 12345 因此跳过了**更近**的合法候选，违反「最近」口径。
  //
  // ⚠️ **两套半径分开算**（本结构特有）：biome/高差判据只扫占地（±HALF），干燥判据要扫
  // 占地 + 4 格（±(HALF+MARGIN)）。若共用一个半径：
  //   · 取 giDry（=7，覆盖 ±56）会让 biome 粗筛覆盖 ±56 ⊃ 精检的 ±53 ⇒ **biome 变严**，
  //     误杀「±53 内全沙漠但 ±56 环上有非沙漠」的合法点；
  //   · 取 giBio（=6，覆盖 ±48）则干燥粗筛只覆盖 ±48 ⊂ 精检的 ±57 ⇒ 干燥**变宽**，
  //     这是正确方向（精检会兜住），但粗筛就白跑了一部分淘汰能力。
  // 故分别取 `floor(HALF/STEP)` 与 `floor((HALF+MARGIN)/STEP)`，两者都 ≤ 各自的精检范围
  // ⇒ 都是合法的必要条件。
  //
  // ⚠️ **x/z 半宽不同（53/54）⇒ giX/giZ 分开算**（本结构不是正方形）。
  const giBioX = Math.floor(RUINED_CITADEL_HALF_X / COARSE_STEP);
  const giBioZ = Math.floor(RUINED_CITADEL_HALF_Z / COARSE_STEP);
  const giDryX = Math.floor((RUINED_CITADEL_HALF_X + RUINED_CITADEL_DRY_MARGIN) / COARSE_STEP);
  const giDryZ = Math.floor((RUINED_CITADEL_HALF_Z + RUINED_CITADEL_DRY_MARGIN) / COARSE_STEP);
  // 网格外扩取两者的最大值（邻域查得到真实数据，不越界）
  const giX = Math.max(giBioX, giDryX);
  const giZ = Math.max(giBioZ, giDryZ);

  // ⚠️ **网格必须向四周外扩 `gi` 格**（大竞技场实测踩到的真缺陷之二）：`coarseOk` 要查候选的
  // ±gi 邻域，若网格只覆盖搜索窗本身，**窗边缘的候选**其邻域会越出网格 → 越界返回 false
  // → 合法候选被静默误杀。
  const gx0 = xLo - giX * COARSE_STEP;
  const gz0 = z0 - giZ * COARSE_STEP;
  const nx = Math.ceil((xHi + giX * COARSE_STEP - gx0) / COARSE_STEP) + 1;
  const nz = Math.ceil((z1 + giZ * COARSE_STEP - gz0) / COARSE_STEP) + 1;

  // 粗筛网格：一次算好 biome + height（全部候选共用，不逐候选重算）
  const desert = new Uint8Array(nx * nz);
  const hgt = new Float32Array(nx * nz);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const wx = gx0 + i * COARSE_STEP, wz = gz0 + j * COARSE_STEP;
      desert[i + j * nx] = getBiome(wx, wz, seed) === 'DESERT' ? 1 : 0;
      hgt[i + j * nx] = generateHeight(wx, wz, seed);
    }
  }

  // 候选 = **搜索窗内**的沙漠点（外扩那圈只作邻域数据，不当候选），
  // 按「距城市中心 → x → z」排序（确定性）
  const iLo = giX, iHi = Math.ceil((xHi - gx0) / COARSE_STEP);
  const jLo = giZ, jHi = Math.ceil((z1 - gz0) / COARSE_STEP);
  const pts = [];
  for (let i = iLo; i <= iHi; i++) {
    for (let j = jLo; j <= jHi; j++) {
      if (!desert[i + j * nx]) continue;
      const wx = gx0 + i * COARSE_STEP, wz = gz0 + j * COARSE_STEP;
      pts.push([wx, wz, i, j, Math.hypot(wx - cityCx, wz - cityCz)]);
    }
  }
  pts.sort((a, b) => (a[4] - b[4]) || (a[0] - b[0]) || (a[1] - b[1]));

  /**
   * 粗筛：网格邻域内全沙漠 + 高差 ≤ span + 全干燥（必要条件，命中后仍要精检）。
   * ⚠️ biome/高差用 giBio*，干燥用 giDry*（理由见上方「两套半径」注释）。
   */
  const coarseOk = (i, j, span) => {
    let mn = Infinity, mx = -Infinity;
    for (let dj = -giBioZ; dj <= giBioZ; dj++) {
      const jj = j + dj;
      if (jj < 0 || jj >= nz) return false;
      for (let di = -giBioX; di <= giBioX; di++) {
        const ii = i + di;
        if (ii < 0 || ii >= nx) return false;
        const k = ii + jj * nx;
        if (!desert[k]) return false;
        const h = hgt[k];
        if (h < mn) mn = h;
        if (h > mx) mx = h;
        if (mx - mn > span) return false;
      }
    }
    // 干燥：外扩到 ±(HALF+MARGIN) 对应的网格半径
    for (let dj = -giDryZ; dj <= giDryZ; dj++) {
      const jj = j + dj;
      if (jj < 0 || jj >= nz) return false;
      for (let di = -giDryX; di <= giDryX; di++) {
        const ii = i + di;
        if (ii < 0 || ii >= nx) return false;
        if (hgt[ii + jj * nx] <= SEA_Y) return false;
      }
    }
    return true;
  };

  // 先严后松：取第一个有解的 span 档（保证「相对平坦」优先，同时「必须生成」兜底）
  let result = null;
  for (const span of RUINED_CITADEL_SPANS) {
    for (const [wx, wz, i, j] of pts) {
      if (!coarseOk(i, j, span)) continue;
      if (fixedBlockerAt(wx, wz, city, shallow, arena, burningArena, seed)) continue;
      if (!exactDry(wx, wz, seed)) continue;
      const f = exactFootprint(wx, wz, span, seed);
      if (!f) continue;
      result = Object.freeze({ wx, wz, floorY: f.minH, span: f.span });
      break;
    }
    if (result) break;
  }
  if (anchorMemo.size >= ANCHOR_MEMO_MAX) anchorMemo.delete(anchorMemo.keys().next().value);
  anchorMemo.set(seed, result);
  return result;
}

/**
 * 一个候选点是否**完全合法**（导出供单测复用同一份判据 —— 红线 1）。
 *
 * ⚠️ **为什么必须导出**：单测要钉「锚点是最近的那个」，就得能判「另一个更近的点合不合法」。
 * 若测试自己写一份判据（只算沙漠+平坦），会与搜索侧漂移 —— 大竞技场实测踩过：测试漏了
 * 城市净空判据，把被城市挡掉的点当成「更近的合法候选」报假 FAIL。
 * 搜索与测试共用本函数 ⇒ 两边不可能不一致。
 *
 * @param {number} wx @param {number} wz 候选中心
 * @param {number} span 地表高差上限
 * @param {number} seed
 * @returns {{ok:true, minH:number, maxH:number, span:number}|{ok:false, why:string}}
 */
export function ruinedCitadelCandidateValid(wx, wz, span, seed) {
  const city = getCityBoundsForSeed(seed);
  const blocker = fixedBlockerAt(wx, wz, city, computeShallowTarnAnchor(seed),
    computeArenaAnchor(seed), computeBurningArenaAnchor(seed), seed);
  if (blocker) return { ok: false, why: blocker };
  if (!exactDry(wx, wz, seed)) return { ok: false, why: 'wet' };
  const f = exactFootprint(wx, wz, span, seed);
  if (!f) return { ok: false, why: 'footprint' };
  return { ok: true, minH: f.minH, maxH: f.maxH, span: f.span };
}

/**
 * 点是否落在废弃堡垒占地内（106×108 矩形）。
 *
 * 唯一权威（红线 1）：`apply.js` 阶段 2.7 的撒布剔除、`pointContext` 的植被让路、
 * 将来的消费者都用这一份，不得各自写一遍 `Math.abs(dx) <= 53`。
 * 与 `inBurningArenaFootprint` / `inGiantPyramidFootprint` 同签名同语义。
 *
 * ⚠️ **x/z 半宽不同**（53/54），两个方向分开比。
 *
 * @param {number} wx @param {number} wz
 * @param {Array<{wx:number, wz:number}|null>} anchors 邻域 layouts 的 `ruinedCitadel`
 * @returns {boolean}
 */
export function inRuinedCitadelFootprint(wx, wz, anchors) {
  if (!anchors) return false;
  for (const a of anchors) {
    if (!a) continue;
    if (Math.abs(wx - a.wx) <= RUINED_CITADEL_HALF_X &&
        Math.abs(wz - a.wz) <= RUINED_CITADEL_HALF_Z) return true;
  }
  return false;
}

/**
 * 本 region 的**哪些地标**被废弃堡垒压掉（与 `burningArenaSuppressedLandmarks` 同构）。
 *
 * 判据是「该地标圆是否与占地矩形相交」，**不是**「本 region 是不是锚点所在 region」。
 * ⚠️ 两种写法实测差别很大（浅水高台踩过）：106×108 占地可跨 2×2 个 region，而锚点所在的
 * 那个 region 里可能一个地标都没有、地标全在邻居 region。按「锚点 region」压制会
 * ① 压掉一个本来没冲突的地标（零回归失败），② 又不压真正冲突的那些。
 *
 * @param {{wx:number, wz:number, floorY:number}} anchor
 * @param {number} regionX @param {number} regionZ @param {number} seed
 * @returns {{pyramid:boolean, frozenMountain:boolean, plainLand:boolean, island:boolean,
 *           snowLand:boolean, giantPyramid:boolean, skyIslands:boolean}}
 */
export function ruinedCitadelSuppressedLandmarks(anchor, regionX, regionZ, seed) {
  const out = {
    pyramid: false, frozenMountain: false, plainLand: false, island: false,
    snowLand: false, giantPyramid: false, skyIslands: false,
  };
  if (!anchor) return out;
  const HX = RUINED_CITADEL_HALF_X, HZ = RUINED_CITADEL_HALF_Z;

  // ⚠️ **廉价距离门（性能关键，大竞技场 v2.85 实测 +9.7% 的教训）**：本函数对**每个** region
  // 都会被 `computeRegionLayout` 调用，而它内部要调 `computeRegionLocalGiantPyramid`（扫全区
  // 沙漠）与 `computeSkyCandidates`（两个都是重函数）。不加门时 `computeRegionLayout` 从
  // 7.81ms/region 涨到 8.57ms/region，而 layout 在 GEN 计时路径上被 9 个邻域 region 各调一次
  // ⇒ 会让 `lake-ripple.spec` 的波纹测量窗口被 layout 占满（两帧截图逐位相同）。
  //
  // 门判据：地标中心被 clamp 在本 region AABB 内，故「本 region 任一地标圆能碰到堡垒」
  // 的必要条件是「region AABB 到堡垒矩形的最近距离 ≤ 最大地标半径」。
  // ⚠️ **x/z 半宽不同 ⇒ gapX/gapZ 分别用 HX/HZ 算**。
  const MAX_REACH = Math.max(...Object.values(LANDMARK_CLEARANCE)) + PYRAMID_HALF;
  const regionMinX = regionX * REGION_SIZE, regionMaxX = regionMinX + REGION_SIZE - 1;
  const regionMinZ = regionZ * REGION_SIZE, regionMaxZ = regionMinZ + REGION_SIZE - 1;
  const gapX = Math.max(0, (anchor.wx - HX) - regionMaxX, regionMinX - (anchor.wx + HX));
  const gapZ = Math.max(0, (anchor.wz - HZ) - regionMaxZ, regionMinZ - (anchor.wz + HZ));
  if (Math.hypot(gapX, gapZ) > MAX_REACH) return out;

  // ⚠️ **必须用「圆↔矩形相交」而不是「地标中心在占地内」**（大竞技场实测踩到的真缺陷）：
  // 地标是「中心 + 半径」的圆，占地是 HX×HZ 的矩形。大竞技场 seed 12345 的 plainLand 中心
  // 在占地 z 范围**外 1 格**，但半径 15 伸进了占地 ⇒ 中心判据漏压，平地的沙柱+仙人掌
  // 长进了碗身（实测 16 格植被穿模）。
  const hits = (cx, cz, r) => {
    const dx = Math.max(0, Math.abs(cx - anchor.wx) - HX);
    const dz = Math.max(0, Math.abs(cz - anchor.wz) - HZ);
    return Math.hypot(dx, dz) <= r;
  };

  const py = getPyramidCenterInRegion(regionX, regionZ, seed);
  if (py && hits(py.cx, py.cz, LANDMARK_CLEARANCE.pyramid)) out.pyramid = true;
  const fm = getFrozenMountainCenterInRegion(regionX, regionZ, seed);
  if (fm && hits(fm.cx, fm.cz, LANDMARK_CLEARANCE.frozenMountain)) out.frozenMountain = true;
  const plain = getPlainLandCenterInRegion(regionX, regionZ, seed);
  if (plain && hits(plain.cx, plain.cz, LANDMARK_CLEARANCE.plainLand)) out.plainLand = true;
  const isl = getIslandCenterInRegion(regionX, regionZ, seed);
  if (isl && hits(isl.islandCx, isl.islandCz, LANDMARK_CLEARANCE.island)) out.island = true;
  // 雪原：中心由 region 播种中心 + 固定偏移派生（与 `computeRegionLayout` 同源常量）
  const raw = getRegionSeededCenter(regionX, regionZ, seed);
  if (hits(raw.centerX + LANDMARK_OFFSET.SNOW_LAND_X, raw.centerZ + LANDMARK_OFFSET.SNOW_LAND_Z,
    LANDMARK_CLEARANCE.snowLand)) {
    out.snowLand = true;
  }
  // 巨型金字塔：用**未过间距去重与概率门**的局部锚点（更保守，排除得更多 —— 方向安全）。
  // 它是方形占地（±PYRAMID_HALF），用方↔方相交（与 `inGiantPyramidFootprint` 同口径）。
  const gp = computeRegionLocalGiantPyramid(regionX, regionZ, seed);
  if (gp && Math.abs(gp.wx - anchor.wx) <= PYRAMID_HALF + HX &&
      Math.abs(gp.wz - anchor.wz) <= PYRAMID_HALF + HZ) out.giantPyramid = true;
  // 空岛：本结构塔顶 = floorY + (63 − 45) = floorY + 18（实测世界 y=17~22），
  // 而空岛底 y≥40 ⇒ **当前恒不相撞**，`bottomY <= topY` 判据恒假（零成本）。
  // ⚠️ **仍保留这一项**（spec DR-6）：将来加高塔楼时它会静默失效 —— 保留判据使
  //    「塔长高了要压空岛」这件事自动生效，不需要有人记得回来补。
  const topY = anchor.floorY + (RUINED_CITADEL_HEIGHT - RUINED_CITADEL_FLOOR_ROW);
  const sky = computeSkyCandidates(regionX, regionZ, seed).skyIslands;
  for (let i = 0; i < sky.length; i += 5) {
    const ox = sky[i] * 16 + 8, oz = sky[i + 1] * 16 + 8;
    const bottomY = sky[i + 2], radius = sky[i + 3];
    if (Math.abs(ox - anchor.wx) > radius + HX) continue;
    if (Math.abs(oz - anchor.wz) > radius + HZ) continue;
    if (bottomY <= topY) { out.skyIslands = true; break; }
  }
  return out;
}

/**
 * 废弃堡垒占地 AABB 是否与本 region 相交（layout 层裁剪用：不相交则不携带锚点）。
 *
 * ⚠️ 与 `burningArenaOverlapsRegion` 同手法同理由：锚点是**全局唯一**的，可能落在任何 region，
 * 而每个 column 的查询域只拿 3×3 region 布局 —— 不相交的 region 携带它只会白抬 payload。
 * ⚠️ **不能写成「只在锚点所在 region 携带」**：106×108 占地可跨 2×2 个 region，
 * 只让一个 region 携带会让邻区负责的那部分**缺半边**（与围场 v2.7 踩过的坑同形）。
 * ⚠️ **x/z 半宽不同**，两个方向分开比。
 */
export function ruinedCitadelOverlapsRegion(anchor, regionX, regionZ) {
  if (!anchor) return false;
  const minX = anchor.wx - RUINED_CITADEL_HALF_X, maxX = anchor.wx + RUINED_CITADEL_HALF_X;
  const minZ = anchor.wz - RUINED_CITADEL_HALF_Z, maxZ = anchor.wz + RUINED_CITADEL_HALF_Z;
  const rMinX = regionX * REGION_SIZE, rMaxX = rMinX + REGION_SIZE - 1;
  const rMinZ = regionZ * REGION_SIZE, rMaxZ = rMinZ + REGION_SIZE - 1;
  return minX <= rMaxX && maxX >= rMinX && minZ <= rMaxZ && maxZ >= rMinZ;
}

/**
 * 瞬移到废弃堡垒的落点（设置面板「堡垒」按钮）。
 *
 * 落点 = 占地**东缘**（City 那一侧，因为本结构在城西）再向东 `RUINED_CITADEL_TELEPORT_GAP` 格、
 * z 取锚点中线：玩家面朝西（-X）就能看到整个堡垒。y 用该格**自然地表**（`generateHeight`）+ 1
 * —— **不用 `anchor.floorY`**，那是甲板高度，缘外沙漠的自然高度与之可能差几格。
 *
 * ⚠️ **缘外那一点不在锚点判据的保证范围内**（判据只逐格校占地 + 4 格干燥）：
 * **8 seed 普查实测（2026-11-10，spec DR-9）** —— 该点均为 DESERT、高于海平面、
 * 周围 5×5 自然高差 ≤ 1 格、不在城市 bounds 内、不在浅水高台整形区内、不在占地内：
 *
 * | seed | 落点 | h | 5×5 高差 |
 * |---|---|---|---|
 * | 12345 | (-410,5,-71) | 4 | 1 |
 * | 99999 | (-279,6,197) | 5 | 1 |
 * | 1249026 | (-560,5,365) | 4 | 1 |
 * | 20260101 | (-159,5,313) | 4 | 1 |
 * | 777 | (-338,7,177) | 6 | 1 |
 * | 4242 | (-26,5,445) | 4 | 1 |
 * | 31337 | (-108,5,361) | 4 | 0 |
 * | 8888 | (-95,5,201) | 4 | 1 |
 *
 * 若将来改 `RUINED_CITADEL_TELEPORT_GAP` 或锚点判据，**必须重跑这份普查** ——
 * 最坑的形态是落点泡进浅水高台的整形区（`fixedBlockerAt` 只保证锚点到湖心
 * > `SHALLOW_TARN_OUTER_RADIUS + HALF_X`，减去外扩后理论上可伸进整形区几格）。
 * `test-ruined-citadel-gen.js` 的瞬移用例逐 seed 钉住这些性质。
 *
 * ⚠️ **唯一权威（红线 1）**：`Game.teleportToRuinedCitadel` 与 `tests/teleport.spec.mjs`
 * 都消费本函数，不得各自复算一份落点。
 *
 * @param {number} seed
 * @returns {{x:number, y:number, z:number}|null} 该 seed 没有废弃堡垒时返回 null
 */
export function ruinedCitadelTeleportPoint(seed) {
  const a = computeRuinedCitadelAnchor(seed);
  if (!a) return null;
  const x = a.wx + RUINED_CITADEL_HALF_X + RUINED_CITADEL_TELEPORT_GAP;
  const z = a.wz;
  const y = generateHeight(x, z, seed) + 1;   // +1 = 地表方块之上那一格（脚底）
  if (![x, y, z].every((v) => Number.isFinite(v))) return null;
  return { x, y, z };
}
