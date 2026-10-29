// src/ui/minimap-regions.js — 迷你区域地图的**区域分类纯函数**（唯一权威）
//
// 本文件无 DOM、无 three、无 Worker、无 fetch：浏览器单测可直接驱动，
// `src/ui/**` 也不在 `check:arch` 的 LAYER_ORDER 里（可 import gen/ 的纯函数）。
//
// ## 为什么地图不读方块、不读 column
//
// 区域类型（城市 / 高台地带 / 雪原 / 水面 / 5 种 biome）在红线 2 下全是 **seed 的纯函数** ——
// 世界无边界、无预生成，地形只由 seed 决定。所以地图在玩家飞到任何**尚未加载**的地方时，
// 都能立刻画出正确的区域，不需要 GEN、不引入第二种「地图数据」缓存（红线 1 / 红线 2）。
//
// ## 判据全部复用既有权威（不写第二份）
//
// | 区域 | 权威 |
// |---|---|
// | CITY | `inCityBounds`（`gen/structures/scatter.js`；与 `getCityInfo` 同一不等式，单测交叉验证） |
// | TARN（高台地带） | `isTarnZone` / `tarnZoneCenter` / `TARN_ZONE_RADIUS`（`gen/structures/tarn-zone.js`） |
// | SNOW（雪原） | `getRegionSeededCenter` + `LANDMARK_OFFSET.SNOW_LAND_*`，半宽由 `SNOW_LAND_SIZE` + `TRANSITION_SIZE.SNOW_LAND` 派生（与 `landmarks.js` 的 `getSnowLandInfo` 包围盒同口径，单测交叉验证） |
// | WATER | `generateHeightForBiome(...) < SEA_Y`（与 `fillColumn` 的水体方块判据同源） |
// | 其余 | `getBiome`（`gen/noise.js`） |
//
// ## 方向（上北下南左西右东）由 `paintMinimap` 的采样公式唯一确定
//
// 样本 `(i, j)` → 世界格 `(floor(cx) + (i-mid)*STEP, floor(cz) + (j-mid)*STEP)`。
// `j` 从 0（画面上方）递增到 `S-1`（下方），即 **z 随 j 增大** ⇒ 上方 = z 小 = 北。
// `i` 随 x 增大 ⇒ 右方 = +x = 东。改这个循环的符号就是「地图上下翻转」，单测钉住。

import { getBiome } from '../gen/noise.js';
import { generateHeightForBiome } from '../gen/terrain.js';
import { SEA_Y } from '../voxel/constants.js';
import { inCityBounds } from '../gen/structures/scatter.js';
import {
  isTarnZone, tarnZoneCenter, TARN_ZONE_RADIUS, snowLandSuppressedByTarn,
} from '../gen/structures/tarn-zone.js';
import { getRegionSeededCenter } from '../gen/structures/region-center.js';
import {
  REGION_SIZE, LANDMARK_OFFSET, CENTER_OFFSET, SNOW_LAND_SIZE, TRANSITION_SIZE,
} from '../gen/structures/region-config.js';

/** 采样边长（**必须奇数**：中心样本 = 玩家所在格，玩家点才真的「在中心」） */
export const MINIMAP_SAMPLES = 51;
/** 相邻样本的世界格步长（跨度 = (51-1)*20 = 1000 格，2.5 个 region） */
export const MINIMAP_STEP = 20;
/** 每个样本的 CSS 像素边长（整数倍放大 → `image-rendering: pixelated` 下零模糊） */
export const MINIMAP_PIXEL_SCALE = 3;
/** 画布 CSS 尺寸（px）= 51 × 3 = 153 */
export const MINIMAP_MAP_SIZE = MINIMAP_SAMPLES * MINIMAP_PIXEL_SCALE;
/** 地图覆盖的世界跨度（格）= 50 × 20 = 1000（2.5 个 region） */
export const MINIMAP_SPAN = (MINIMAP_SAMPLES - 1) * MINIMAP_STEP;

/**
 * 区域种类清单（**唯一权威**：配色表、单测、文档都从这里派生）。
 *
 * 顺序即判据优先级（先命中者胜）：城市 > 高台地带 > 雪原 > 水面 > biome。
 * ⚠️ 城市必须最前 —— 城市 bounds 内地形被压平、可能低于海平面，判成水面
 * 就会在城里显示一片「海」（`ocean-mask.js` 的城市门控是同一个道理的渲染侧版本）。
 */
export const AREA_KINDS = Object.freeze([
  'CITY', 'TARN', 'SNOW', 'WATER', 'PLAINS', 'FOREST', 'AZALEA', 'SWAMP', 'DESERT',
]);

/**
 * 区域配色（sRGB，不含抖动）。选色口径：
 *  - 颜色两两之间保持足够的 RGB 距离（单测钉住 ≥ 55），否则「沼泽 vs 森林」这类
 *    相邻色相在小尺寸地图上分不出来 —— 那正是地图存在的意义；
 *  - 城市刻意取**中性灰**（石头色）：它是人造区域，不该与任何自然 biome 撞色；
 *  - 高台地带取赭石（黏土台地观感）、雪原近白、水面深蓝。
 * @type {Readonly<Record<string, readonly [number, number, number]>>}
 */
export const AREA_COLORS = Object.freeze({
  CITY: Object.freeze([150, 146, 140]),
  TARN: Object.freeze([176, 124, 62]),
  SNOW: Object.freeze([230, 238, 244]),
  WATER: Object.freeze([35, 78, 124]),
  PLAINS: Object.freeze([124, 176, 74]),
  FOREST: Object.freeze([47, 107, 58]),
  AZALEA: Object.freeze([196, 110, 190]),
  SWAMP: Object.freeze([107, 98, 56]),
  DESERT: Object.freeze([216, 192, 132]),
});

/**
 * 世界锚定的两级明度抖动（每通道 −`AREA_DITHER` / 0）。
 *
 * **为什么必须有**：城市 bounds 实测可达 566 格，而地图跨度 1000 格 —— 城市在图上是一大块
 * 纯色区域（全图同一个 biome 时更是整张纯色），观感像地图坏了。抖动给出极轻微的纹理，同时因为它是**世界坐标**的
 * 纯函数（`floor(wx/8) + floor(wz/8)` 的奇偶），玩家移动时纹理跟着世界走、不会爬行。
 */
const AREA_DITHER = 6;
/** 抖动单元边长（格）—— 8 格 = 半格样本步长，与采样步长互质 → 图案逐行错开 */
const AREA_DITHER_CELL_SHIFT = 3;

/** 雪原包围盒的半宽（与 `tarn-zone.js` 的 `SNOW_HALF_EXTENT` 同推导，单测交叉验证） */
const SNOW_HALF_EXTENT = Math.floor(SNOW_LAND_SIZE / 2) + TRANSITION_SIZE.SNOW_LAND;
/**
 * 雪原中心的偏移区间（相对 region 原点，未 clamp —— `getSnowLandInfo` 消费的就是未 clamp 的原始中心）。
 *
 * ⚠️ **X 与 Z 的偏移是两回事，不可复用同一对常量**：`LANDMARK_OFFSET` 里
 * `SNOW_LAND_X = 160` 而 `SNOW_LAND_Z = 0`（雪原在金字塔位的正东方向）。
 * 实测把 X 的区间套到 Z 上时，z 区间下界被抬高了 160 格 → 靠南的雪原会被漏收
 * （seed 12345 / 窗口 z∈[400,1400] 实测漏 1 座，测试报「漏了 2 座」）。
 */
const SNOW_CENTER_OFFSET_X_MIN = CENTER_OFFSET.BASE_X + LANDMARK_OFFSET.SNOW_LAND_X;
const SNOW_CENTER_OFFSET_X_MAX = CENTER_OFFSET.BASE_X + CENTER_OFFSET.SCALE_X + LANDMARK_OFFSET.SNOW_LAND_X;
const SNOW_CENTER_OFFSET_Z_MIN = CENTER_OFFSET.BASE_Z + LANDMARK_OFFSET.SNOW_LAND_Z;
const SNOW_CENTER_OFFSET_Z_MAX = CENTER_OFFSET.BASE_Z + CENTER_OFFSET.SCALE_Z + LANDMARK_OFFSET.SNOW_LAND_Z;
/** 地带圆心的偏移（`tarnZoneCenter` = region 中心，无随机偏移） */
const TARN_CENTER_OFFSET = REGION_SIZE / 2;

/** 上下文缓存的容量（跨 region 边界时才换 key，1 个够用；留 8 个给瞬移/多窗口场景） */
const CONTEXT_CACHE_MAX = 8;

/**
 * 区域上下文（地图窗口内可能命中的地带圆与雪原方框）。
 * @typedef {{
 *   city: Object|null,
 *   tarns: Array<{cx:number, cz:number, r:number}>,
 *   snows: Array<{minX:number, maxX:number, minZ:number, maxZ:number}>,
 * }} MinimapRegionContext
 */

/** 地图覆盖的世界格范围（含中心格取整的余量） */
export function minimapAreaBounds(cx, cz) {
  const half = MINIMAP_SPAN / 2;
  const bx = Math.floor(cx), bz = Math.floor(cz);
  return { minX: bx - half, maxX: bx + half, minZ: bz - half, maxZ: bz + half };
}

/**
 * 可能的 region 下标区间，保证不漏掉与窗口相交的结构。
 *
 * 结构中心 = `rx*R + offset`，`offset ∈ [centerMin, centerMax]`，包围半径 `radius`。
 * 与 `[lo, hi]` 相交:
 *   `rx*R + centerMax + radius >= lo` 且 `rx*R + centerMin - radius <= hi`
 * ⇒ `rx ∈ [ (lo - centerMax - radius)/R , (hi - centerMin + radius)/R ]`
 *
 * ⚠️ **两个边界用的 offset 是反的**（下界用 `centerMax`、上界用 `centerMin`）——
 * 写反后当地带（`centerMin === centerMax`）完全看不出差别，只有雪原（偏移区间宽 300 格）
 * 会变成「靠东的那座雪原不画」。已用暴力全枚举对照单测钉住。
 *
 * @param {number} lo 世界坐标下界 @param {number} hi 世界坐标上界
 * @param {number} centerMin 中心相对 region 原点的最小偏移
 * @param {number} centerMax 中心相对 region 原点的最大偏移
 * @param {number} radius 包围半径
 * @returns {[number, number]}
 */
function regionRange(lo, hi, centerMin, centerMax, radius) {
  return [
    Math.floor((lo - centerMax - radius) / REGION_SIZE),
    Math.floor((hi - centerMin + radius) / REGION_SIZE),
  ];
}

/**
 * 构建（并缓存）地图窗口的区域上下文。
 *
 * 缓存键 = 「region 下标区间 + city 是否就绪 + seed」——这些量只在**跨 region** 或
 * 城市布局到达时变化，玩家在 400 格内移动时命中同一个键（实测一次上下文构造成本
 * 含 3~4 个 `isTarnZone`（各 ~1µs），不缓存也不贵；缓存只是为了不给每 100ms 的重绘
 * 加一份无谓开销）。
 *
 * @param {number} seed
 * @param {number} cx @param {number} cz 玩家所在世界坐标
 * @param {Object|null} [city] 城市布局（`buildCityLayout` 结果；未就绪传 null）
 * @returns {MinimapRegionContext}
 */
export function minimapRegionContext(seed, cx, cz, city = null) {
  const b = minimapAreaBounds(cx, cz);
  const [trx0, trx1] = regionRange(b.minX, b.maxX, TARN_CENTER_OFFSET, TARN_CENTER_OFFSET, TARN_ZONE_RADIUS);
  const [trz0, trz1] = regionRange(b.minZ, b.maxZ, TARN_CENTER_OFFSET, TARN_CENTER_OFFSET, TARN_ZONE_RADIUS);
  const [srx0, srx1] = regionRange(b.minX, b.maxX, SNOW_CENTER_OFFSET_X_MIN, SNOW_CENTER_OFFSET_X_MAX, SNOW_HALF_EXTENT);
  const [srz0, srz1] = regionRange(b.minZ, b.maxZ, SNOW_CENTER_OFFSET_Z_MIN, SNOW_CENTER_OFFSET_Z_MAX, SNOW_HALF_EXTENT);

  const key = `${seed}|${trx0},${trx1},${trz0},${trz1}|${srx0},${srx1},${srz0},${srz1}|${city ? 1 : 0}`;
  const hit = contextCache.get(key);
  if (hit) return hit;

  const tarns = [];
  for (let rx = trx0; rx <= trx1; rx++) {
    for (let rz = trz0; rz <= trz1; rz++) {
      if (!isTarnZone(rx, rz, seed)) continue;
      const c = tarnZoneCenter(rx, rz);
      tarns.push({ cx: c.cx, cz: c.cz, r: TARN_ZONE_RADIUS });
    }
  }

  const snows = [];
  for (let rx = srx0; rx <= srx1; rx++) {
    for (let rz = srz0; rz <= srz1; rz++) {
      const raw = getRegionSeededCenter(rx, rz, seed);
      const scx = raw.centerX + LANDMARK_OFFSET.SNOW_LAND_X;
      const scz = raw.centerZ + LANDMARK_OFFSET.SNOW_LAND_Z;
      // ⚠️ **这里不能用地图窗口做过滤**：缓存键是「region 下标区间」，而同一组区间
      // 覆盖的是 400 格宽的一大片世界 —— 两个不同的地图窗口常常落在同一组区间里。
      // 按窗口过滤后缓存命中时，另一个窗口会拿到**缺了结构**的上下文（实测：跨度收到
      // 1000 格后，同一组 region 区间覆盖 2000 格宽，暴力枚举对照报「漏了 2 座相交雪原」）。
      // ⇒ 缓存内容必须是「这组 region 可能贡献的全部雪原」，窗口过滤交给 `kindAt` 的 AABB 判据。
      // ⚠️ **被高台地带让路掉（压进某个地带圆）的雪原整座不生成** —— 判据必须复用
      // `snowLandSuppressedByTarn`（`apply.js` 阶段 1 的跳过门用的就是它）。不判会把
      // 「世界里根本没有的雪原」画在地图上：形态是地图上有一片雪白色块、飞过去却是普通草地。
      if (snowLandSuppressedByTarn(rx, rz, seed)) continue;
      snows.push({
        cx: scx, cz: scz, half: SNOW_HALF_EXTENT,
        minX: scx - SNOW_HALF_EXTENT, maxX: scx + SNOW_HALF_EXTENT,
        minZ: scz - SNOW_HALF_EXTENT, maxZ: scz + SNOW_HALF_EXTENT,
      });
    }
  }

  const ctx = { city: city || null, tarns, snows };
  if (contextCache.size >= CONTEXT_CACHE_MAX) {
    contextCache.delete(contextCache.keys().next().value);
  }
  contextCache.set(key, ctx);
  return ctx;
}

/** @type {Map<string, MinimapRegionContext>} */
const contextCache = new Map();

/** 清空上下文缓存（单测隔离用；生产代码不需要调用） */
export function clearMinimapContextCache() {
  contextCache.clear();
}

/** 当前缓存条目数（单测常升上限用；不暴露缓存本体，避免测试乱写） */
export function minimapContextCacheSize() {
  return contextCache.size;
}

/**
 * 单个世界格的区域种类（判据优先级见 `AREA_KINDS` 注释）。
 *
 * ⚠️ 这里用 `generateHeightForBiome(wx, wz, seed, biome)` 而**不是** `generateHeight`：
 * 后者的实现正是 `generateHeightForBiome(..., getBiome(...))`，先算 biome 再传进去
 * 等于把每个样本的 `getBiome` 从 1 次降到 1 次（而不是 2 次）—— 51×51 个样本省一半。
 * 两者逐位等价（单测钉住），且 `getBiome` 永不返回 'CITY'，故不会误触城市压平分支。
 *
 * @param {number} wx @param {number} wz
 * @param {number} seed
 * @param {MinimapRegionContext|null} ctx
 * @returns {string} `AREA_KINDS` 之一
 */
export function kindAt(wx, wz, seed, ctx) {
  if (ctx) {
    if (ctx.city && inCityBounds(wx, wz, ctx.city)) return 'CITY';
    for (let i = 0; i < ctx.tarns.length; i++) {
      const t = ctx.tarns[i];
      const dx = wx - t.cx, dz = wz - t.cz;
      if (dx * dx + dz * dz < t.r * t.r) return 'TARN';
    }
    for (let i = 0; i < ctx.snows.length; i++) {
      const s = ctx.snows[i];
      if (wx >= s.minX && wx <= s.maxX && wz >= s.minZ && wz <= s.maxZ) return 'SNOW';
    }
  }
  const biome = getBiome(wx, wz, seed);
  if (generateHeightForBiome(wx, wz, seed, biome) < SEA_Y) return 'WATER';
  return biome;
}

/** 抖动量（世界锚定：同一格永远同值，跨 column/重启一致） */
export function ditherAt(wx, wz) {
  return (((wx >> AREA_DITHER_CELL_SHIFT) + (wz >> AREA_DITHER_CELL_SHIFT)) & 1) ? -AREA_DITHER : 0;
}

/**
 * 区域种类 → 最终像素色（基础色 + 世界锚定抖动）。
 * ⚠️ 写入调用方给的 `out`（长度 ≥ 3），不返回新数组 —— 本函数在 51×51 热循环里，
 * 每样本分配一个数组 = 每次重绘 2601 个垃圾对象（同 `mesher.js` 的 `AO_OUT` 手法）。
 * @param {string} kind
 * @param {number} wx @param {number} wz
 * @param {number[]} out
 */
export function fillColor(out, kind, wx, wz) {
  const base = AREA_COLORS[kind] || AREA_COLORS.PLAINS;
  const d = ditherAt(wx, wz);
  out[0] = base[0] + d;
  out[1] = base[1] + d;
  out[2] = base[2] + d;
}

/**
 * 把整张地图画进 ImageData 的 RGBA 缓冲（唯一渲染实现）。
 *
 * 方向契约见文件头；`j` 随 z 增大 ⇒ 上北下南。
 *
 * @param {Uint8ClampedArray} data RGBA 缓冲（长度 = SAMPLES*SAMPLES*4）
 * @param {number} cx @param {number} cz 玩家世界坐标（地图中心）
 * @param {number} seed
 * @param {MinimapRegionContext|null} ctx
 */
export function paintMinimap(data, cx, cz, seed, ctx) {
  const S = MINIMAP_SAMPLES;
  const mid = (S - 1) >> 1;
  const step = MINIMAP_STEP;
  const baseX = Math.floor(cx), baseZ = Math.floor(cz);
  const rgb = [0, 0, 0];
  let o = 0;
  for (let j = 0; j < S; j++) {
    const wz = baseZ + (j - mid) * step;
    for (let i = 0; i < S; i++) {
      const wx = baseX + (i - mid) * step;
      fillColor(rgb, kindAt(wx, wz, seed, ctx), wx, wz);
      data[o] = rgb[0];
      data[o + 1] = rgb[1];
      data[o + 2] = rgb[2];
      data[o + 3] = 255;
      o += 4;
    }
  }
}
