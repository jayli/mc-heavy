// src/entities/bosses/boss-map.js — Boss 召唤框架：「玩家站在哪张地标级地图里」的唯一权威
//
// 同构层：**无 DOM、无 three、无 Worker**（`check:arch` 的 `ISOMORPHIC_DIRS` 静态门守）。
//
// ## 为什么只登记「有离散中心」的地标级地图
//
// 用户 2026-11-03 裁定：Boss「只能从玩家所在的地图**中心位置**召唤出来」。这要求每张地图
// 有一个**确定的中心点**。City / 高台地带 / 雪原 / 浅水高台四类都有现成的中心权威；
// 而 biome 类地图（沙漠 / 森林 / 草地 / 沼泽 / 杜鹃）是噪声生成的**连续区域**，
// 没有离散中心 —— 等真要给它们加 Boss 时再定中心口径（例如用沙漠金字塔的位置）。
//
// ## 判据全部转调既有权威（红线 1，与 `src/ui/minimap-regions.js` 同一张表）
//
// | 地图 | 权威 |
// |---|---|
// | CITY | `getCityBoundsForSeed` + `inCityBounds`（`gen/structures/city-layout.js` / `scatter.js`） |
// | TARN | `isTarnZone` + `tarnZoneCenter` + `inTarnRadius`（`gen/structures/tarn-zone.js`） |
// | SNOW | `getRegionSeededCenter` + `LANDMARK_OFFSET.SNOW_LAND_*` + `snowLandSuppressedByTarn` |
// | SHALLOW_TARN | `computeShallowTarnAnchor` + `inShallowTarnFootprint` |
//
// ⚠️ **不得自己写一份判据**：两份「玩家在哪张地图」漂移的形态是「迷你地图显示高台地带、
// 按 B 却说这里没有 Boss」（或反过来）。
//
// ## 优先级 = 迷你地图的同一套（先命中者胜）
//
// CITY > TARN > SNOW > SHALLOW_TARN。⚠️ 城市必须最前 —— 城市 bounds 内地形被压平、
// 可能低于海平面，且它与其它三类在落点判据上互斥（浅水高台的 `CITY_CLEARANCE` 保证
// 湖与城市 bounds 恒相距 40 格；雪原被 `snowLandSuppressedByTarn` 让路），
// 所以实际几乎不会同时命中，但保留同一顺序以免将来加地图时出现口径分裂。
import { REGION_SIZE, LANDMARK_OFFSET, SNOW_LAND_SIZE, TRANSITION_SIZE } from '../../gen/structures/region-config.js';
import {
  isTarnZone, tarnZoneCenter, inTarnRadius, snowLandSuppressedByTarn,
} from '../../gen/structures/tarn-zone.js';
import { inCityBounds } from '../../gen/structures/scatter.js';
import { getCityBoundsForSeed } from '../../gen/structures/city-layout.js';
import { getRegionSeededCenter } from '../../gen/structures/region-center.js';
import {
  computeShallowTarnAnchor, inShallowTarnFootprint,
} from '../../gen/structures/shallow-water-tarns.js';

/**
 * 可召唤 Boss 的地图种类（**唯一权威**：名册、单测、文档都从这里派生）。
 *
 * 顺序即判据优先级（见文件头）。
 */
export const BOSS_MAP_KINDS = Object.freeze(['CITY', 'TARN', 'SNOW', 'SHALLOW_TARN']);

/** 雪原包围盒半宽（与 `minimap-regions.js` 的 `SNOW_HALF_EXTENT` 同推导） */
const SNOW_HALF_EXTENT = Math.floor(SNOW_LAND_SIZE / 2) + TRANSITION_SIZE.SNOW_LAND;

/**
 * 玩家所在地图。
 * @typedef {{
 *   kind: string,      `BOSS_MAP_KINDS` 之一
 *   cx: number,        地图中心 x（Boss 的召唤点）
 *   cz: number,        地图中心 z
 *   key: string,       该地图实例的稳定标识（同一张地图恒同值，跨重启一致）
 * }} BossMap
 */

/**
 * 玩家所在的高台地带（圆内才算，不是整个 region）。
 *
 * ⚠️ **必须用 `inTarnRadius` 而不是只看 `isTarnZone(region)`**：地带圆半径 138 只覆盖
 * 400×400 region 的 **37.4%**（AGENTS.md「杜鹃树大片空地」条已记这个坑）。只看 region
 * 会让玩家在离地带中心 190 格的普通草地上按 B 也召出龙 —— 而那条龙会在 138 格外的
 * 地带中心盘旋，玩家根本看不见（形态是「按了 B 什么都没发生」）。
 *
 * @returns {BossMap|null}
 */
function tarnMapAt(wx, wz, seed) {
  const rx = Math.floor(wx / REGION_SIZE);
  const rz = Math.floor(wz / REGION_SIZE);
  if (!isTarnZone(rx, rz, seed)) return null;
  const c = tarnZoneCenter(rx, rz);
  if (!inTarnRadius(wx, wz, c)) return null;
  return { kind: 'TARN', cx: c.cx, cz: c.cz, key: `tarn:${rx}:${rz}` };
}

/** 玩家所在的城市（bounds 内）。@returns {BossMap|null} */
function cityMapAt(wx, wz, seed) {
  const b = getCityBoundsForSeed(seed);
  if (!b || !inCityBounds(wx, wz, b)) return null;
  return {
    kind: 'CITY',
    cx: Math.round((b.minX + b.maxX) / 2),
    cz: Math.round((b.minZ + b.maxZ) / 2),
    key: 'city:0:0',
  };
}

/**
 * 玩家所在的雪原（方框内）。
 *
 * ⚠️ **必须扫 3×3 邻域 region**：雪原中心 = `getRegionSeededCenter(rx,rz) + LANDMARK_OFFSET.SNOW_LAND_*`，
 * 而 X 偏移是 **160** 格 ⇒ 一座雪原可以探进相邻 region。只查玩家所在 region 会漏掉
 * 「中心在邻区、身体伸到本区」的那座（`minimap-regions.js` 的 `SNOW_CENTER_OFFSET_X_*`
 * 区间是同一个道理）。
 * ⚠️ **必须跳过被高台地带让路掉的雪原**（`snowLandSuppressedByTarn`）：那种雪原
 * **世界里根本不存在**（`apply.js` 阶段 1 的跳过门），召出的 Boss 会站在普通草地上。
 *
 * @returns {BossMap|null}
 */
function snowMapAt(wx, wz, seed) {
  const prx = Math.floor(wx / REGION_SIZE);
  const prz = Math.floor(wz / REGION_SIZE);
  for (let drx = -1; drx <= 1; drx++) {
    for (let drz = -1; drz <= 1; drz++) {
      const rx = prx + drx, rz = prz + drz;
      if (snowLandSuppressedByTarn(rx, rz, seed)) continue;
      const raw = getRegionSeededCenter(rx, rz, seed);
      const cx = raw.centerX + LANDMARK_OFFSET.SNOW_LAND_X;
      const cz = raw.centerZ + LANDMARK_OFFSET.SNOW_LAND_Z;
      if (wx < cx - SNOW_HALF_EXTENT || wx > cx + SNOW_HALF_EXTENT) continue;
      if (wz < cz - SNOW_HALF_EXTENT || wz > cz + SNOW_HALF_EXTENT) continue;
      return { kind: 'SNOW', cx, cz, key: `snow:${rx}:${rz}` };
    }
  }
  return null;
}

/**
 * 玩家所在的浅水高台（整形区内）。
 *
 * ⚠️ **迷你地图把浅水高台归成 `WATER`**（它的 9 种分类里没有这一类），而用户明确把
 * 浅水高台当作**一张独立地图**（「玩家在浅水高台地图，就召唤浅水高台地图的 Boss」）。
 * 故这里不复用 `kindAt`，而是直接转调浅水高台自己的占地权威 `inShallowTarnFootprint`。
 *
 * @returns {BossMap|null}
 */
function shallowTarnMapAt(wx, wz, seed) {
  const a = computeShallowTarnAnchor(seed);
  if (!a || !inShallowTarnFootprint(wx, wz, [a])) return null;
  return { kind: 'SHALLOW_TARN', cx: a.wx, cz: a.wz, key: 'shallowtarn:0' };
}

/** 判据表（顺序 = 优先级）。加新地图 = 在这里加一行 + 在 `BOSS_ROSTER` 加一行。 */
const DETECTORS = Object.freeze([
  cityMapAt, tarnMapAt, snowMapAt, shallowTarnMapAt,
]);

/**
 * 玩家站在哪张地标级地图里（Boss 召唤的定位入口）。
 *
 * 纯函数（`(wx, wz, seed)` 决定结果），且**只在按 B 时调用一次** —— 不进帧循环，
 * 故 `getCityBoundsForSeed` / `computeShallowTarnAnchor` 的冷调用成本无关紧要
 * （两者各自带 seed 级缓存，且都已在 `Game.start()` 里被预热过）。
 *
 * @param {number} wx @param {number} wz 玩家世界坐标
 * @param {number} seed
 * @returns {BossMap|null} 不在任何地标级地图内（例如站在沙漠/森林里）返回 null
 */
export function bossMapAt(wx, wz, seed) {
  if (!Number.isFinite(wx) || !Number.isFinite(wz) || !Number.isFinite(seed)) return null;
  for (const detect of DETECTORS) {
    const map = detect(wx, wz, seed);
    if (map) return map;
  }
  return null;
}
