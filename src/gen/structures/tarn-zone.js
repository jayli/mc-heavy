// src/gen/structures/tarn-zone.js — 高台地带（Cloudland Tarn Zone）候选与布局
// 设计文档 docs/superpowers/specs/2026-10-26-cloudland-tarn-zone-design.md DR-1~DR-10
//
// 两段式的前一段（与 scatter / giant-trees / mesa / giant-pyramid 同构，红线 2）：
//   本文件               computeTarnZone()：region 级布局（纯函数、无状态、无 fetch）
//   apply.js 阶段 2.4    按布局光栅化到 column
//
// Worker 同构：不得 import three、不得自建 Worker、**不得 fetch**（候选在 layout 层算一次，DR-13）。
import { seededRandom } from '../noise.js';
import { REGION_SIZE, CITY_REGION } from './region-config.js';
import { KIT_METRICS, KIT_VARIANTS } from './cloudland-kit-data.js';

// ==================== 地带尺度 ====================

/** 地带半径（圆）：池半径 90 + 岸带 70。改它必须先看 DR-4 的不等式。 */
export const TARN_ZONE_RADIUS = 160;
/** 水池半径（直径 180）。spec DR-5f/DR-7：128 会超容量 151%，90 只占 ~78%（定稿组合）。 */
export const TARN_POOL_RADIUS = 90;

/**
 * 高台环半径（轴对齐摆放，spec DR-7 方案 1）。
 *
 * ⚠️ **这是实测标定值，不是公式**：58 是「定稿 8 座的四角全部落在池内」的上限
 * （59 起 L3 四角最远 90.73 > 池半径 90）。轴对齐下最远角与环上角度 θ 有关，没有闭式解，
 * **不要写成 `TARN_POOL_RADIUS − max(half) − 4` 这类公式**。改池半径 / 改保留组合 →
 * 必须重新穷举标定这个值。
 */
export const TARN_RING_RADIUS = 58;

/**
 * 相邻高台的 **AABB 真实最小间距**（格）。抖动必须钳制，使该值恒成立（DR-7）。
 *
 * ⚠️ **原值 10 是「长边切向朝心」旋转假设下的口径，轴对齐下几何上达不到**
 * （AABB 真实间距只有 ~5.05 格；缩 ringR / 重排顺序 / 加大抖动三条路都试过，都救不回 10）。
 * 用户第六轮裁定改为 4。改这个值前先读 spec DR-7「轴对齐的固有代价」。
 */
export const TARN_GAP = 4;

/** 地带出现概率（每 ~3 个 region 一处，用户裁定）。 */
export const TARN_ZONE_CHANCE = 1 / 3;

/**
 * 台地高度（= `SEA_Y + 4`）。
 *
 * ⚠️ **这是几何常量而不是地形常量**，所以放在本文件而不是 `tarn-terrain.js`
 * （后者依赖前者，放那边会成环）。Task 4 的整形、Task 5 的高台 y、Task 6 的水面平面
 * 全部读同一个值 —— 各写一份会漂移出「水漫过台地」或「台地浮在水面上」。
 */
export const TARN_PLATEAU_Y = 2;

/**
 * 巨型云的最低 y（Task 5 要 import）。
 *
 * 取 54 = 台地 y(2) + 高台最高高度(46) + 6 格间隙：定稿 8 座里最高的是 tarn_05/tarn_06
 * （高 46/39），顶面 y = 2 + 46 = 48，留 6 格净空。
 * 云最高 38 层 → 云顶 ≤ 54 + 38 = 92 ≤ `WORLD_MAX_Y = 96`。
 */
export const TARN_CLOUD_MIN_Y = 54;

// ==================== 高台组合 ====================

/**
 * 运行时实际使用的 8 座高台（产物基名，顺序 = `.schem` 分量序）。
 *
 * ⚠️ **烘焙产出 11 座，只用 8 座** —— 这不是「漏了 3 个」，是 spec DR-5f/DR-7 穷举后的定稿：
 * 约束「不扩容（reserved ≤ 125,000）且四角落池内」，取高台总格数尽量大的组合
 * （139,014 格 / reserved 98,235 = 78.6%）。
 *
 * ⚠️ 早期的「格数最大」组合（188,944 格）因含 L1（68×60）被否决：它在 ringR=58 上
 * 吃掉 71.6° 占角，8 座总占角超 360° → 环上排不下。
 *
 * 舍弃：cloudland_tarn_01(83,145) / cloudland_tarn_02(50,327) / cloudland_tarn_07(12,624)。
 * ⚠️ 保留 tarn_03（L3）—— 它是 44×48，是定稿组合里最大的一座（四角最远 88.88 ≤ 90）。
 * 改这个列表 = 改水池的容量占用与环半径标定 → **必须重跑 test-tarn-zone.js 的布局用例**。
 */
export const TARN_KEPT_TARN_IDS = Object.freeze([
  'cloudland_tarn_03', 'cloudland_tarn_04', 'cloudland_tarn_05', 'cloudland_tarn_06',
  'cloudland_tarn_09', 'cloudland_tarn_08', 'cloudland_tarn_10', 'cloudland_tarn_11',
]);

// ==================== salt 分配 ====================
//
// 程序化扫描确认 1016..1099 空闲（带 `+ offset` 的调用点占用的是区间，不能只 grep 字面量）。
// 本设计占用 1020..1024，逐项分配见 spec §8。

/** 地带判定的 salt。 */
export const TARN_ZONE_SALT = 1020;
/** 高台角度抖动的 salt（与判定用不同值，否则「顺序靠前的更容易过」产生偏斜）。 */
export const TARN_ANGLE_SALT = 1021;
/** 台地草石镶嵌的 salt（Task 4 消费）。 */
export const TARN_TERRAIN_SALT = 1022;
/** 拱洞/紫晶柱落位的 salt。 */
export const TARN_DECO_SALT = 1023;
/** 巨型云选择与角度的 salt。 */
export const TARN_CLOUD_SALT = 1024;

// ==================== 地带判定 ====================

/**
 * 该 region 是否为高台地带。
 *
 * ⚠️ **这是地带的唯一判定入口**（红线 1，spec DR-2）：候选层、`apply.js` 的让路、
 * 雪原让路、`pointContext`、巨树 `allowedAt`、海面遮罩全部调它，不得各写一份
 * `seededRandom(rx, rz, seed + 1020) < 1/3` —— 两份判据漂移会让「有的系统当地带、
 * 有的不当」，形态是台地上长树、水池里插空岛这类撕裂。
 *
 * 用**粗格哈希**而不是噪声 + 阈值（巨树 v1.71 实测沉淀）：`noise()` 把 seed 加进坐标，
 * 相位随 seed 漂移 → 固定阈值跨 seed 不稳；而整数 region 下标的哈希通过率恒等于
 * `TARN_ZONE_CHANCE` 且与 seed 无关。
 *
 * ⚠️ **CITY_REGION 恒 false**：城市固定 region [0,0] 且全世界唯一，被随机吃掉是不可接受的。
 *
 * @param {number} regionX @param {number} regionZ @param {number} seed
 * @returns {boolean}
 */
export function isTarnZone(regionX, regionZ, seed) {
  if (regionX === CITY_REGION.X && regionZ === CITY_REGION.Z) return false;
  return seededRandom(regionX, regionZ, seed + TARN_ZONE_SALT) < TARN_ZONE_CHANCE;
}

/**
 * 地带中心 = region 中心（spec DR-3：偏移搜索在多数 seed 下找不到半径 160 的位置）。
 *
 * @param {number} regionX @param {number} regionZ
 * @returns {{cx: number, cz: number}}
 */
export function tarnZoneCenter(regionX, regionZ) {
  return {
    cx: regionX * REGION_SIZE + REGION_SIZE / 2,
    cz: regionZ * REGION_SIZE + REGION_SIZE / 2,
  };
}

// ==================== 轴对齐几何工具 ====================

/**
 * 高台的**轴对齐世界半宽**（spec DR-7）：`halfX = width/2`、`halfZ = depth/2`。
 *
 * ⚠️ **与环上角度无关** —— 高台是轴对齐摆放，不旋转（spec DR-7 致命 1′）。
 * 不要返回 `{radial, tangential}`：那是「长边切向朝心」旋转假设下的概念，
 * 而 `rasterizeStructure` 是轴对齐写入（`b.direction` 只是逐格方块朝向元数据，
 * 旋转不了整个结构），轴对齐下这两个值无意义。
 *
 * @param {{width: number, height: number, depth: number}} variant
 * @returns {{halfX: number, halfZ: number}}
 */
export function tarnHalfWidth(variant) {
  return { halfX: variant.width / 2, halfZ: variant.depth / 2 };
}

/**
 * 两个**轴对齐**矩形的真实最短距离（格）。
 *
 * 判据（spec DR-7 / DR-8 唯一口径）：两轴分离量都 > 0 时取 `hypot(dx, dz)`，
 * 否则取正的那个；**两者都 < 0 即重叠**（返回负值）。
 *
 * ⚠️ 不要用「弦长 − 半宽」或外接圆近似：前者是旋转假设下的旧口径（会高估间距），
 * 后者会把「实际不重叠」判成重叠（假失败）。
 * ⚠️ 这是间距判据的**唯一实现**（红线 1）：布局自检与单测共用同一份。
 *
 * @param {{cx: number, cz: number, halfX: number, halfZ: number}} a
 * @param {{cx: number, cz: number, halfX: number, halfZ: number}} b
 * @returns {number} 真实最短距离（重叠时为负）
 */
export function aabbGap(a, b) {
  const dx = Math.abs(a.cx - b.cx) - (a.halfX + b.halfX);
  const dz = Math.abs(a.cz - b.cz) - (a.halfZ + b.halfZ);
  if (dx > 0 && dz > 0) return Math.hypot(dx, dz);
  return Math.max(dx, dz);
}

// ==================== 角度抖动 ====================

/**
 * 高台角向抖动上限 = `jitterMax`（弧度）。**逐 seed 二分求出后缓存**，不得写死。
 *
 * ## 为什么必须二分而不是写 `缝角/2`
 * `缝角/2`（实测 7.62°）会让相邻高台**直接重叠**（AABB 距离实测 **−4.17**）。
 * 抖动预算的真实上界由「AABB 真实间距仍 ≥ `TARN_GAP`」决定，与环半径 / 保留组合全都耦合
 * ⇒ 只能二分，写死任何一个数都会在改池半径或改保留组合时**静默失效**。
 *
 * ## 采样约定是载荷性的（勿改）
 * 抽样序列 = `seededRandom(i, sampleIndex, seed + TARN_ANGLE_SALT)`，`i` 是环上序号、
 * `sampleIndex` 是抽样下标。实测（seed 12345、300 抽样、二分 30 次）：
 * `jmMax = 0.8557°` → `jitterMax = jmMax × 0.8 = 0.6846°` → 300 抽样最坏间距 **4.209 ≥ 4**。
 * ⚠️ 换一套采样约定会得到 0.81~0.95° 的区间 —— 数字对不上不是实现错，是约定变了。
 *
 * ## 抖动为什么是零和的
 * 每缝偏移取 `(rand − 0.5)·2·jitterMax` 后**减去均值**，保证 Σ缝角守恒
 * （否则 8 个缝整体偏一点，最后一座会绕回第一座撞上）。
 *
 * ## 安全性的真正保证（比 300 抽样更强；**这是设计论证，不是单测断言**）
 * 环上相邻角差 `d_i = occ_i/2 + gapAngle + occ_{i+1}/2 + jit_i` —— **只有 `jit_i` 影响
 * 第 i 对**。故「最坏情况」= 单个 `jit_i = −jitterMax` 且其余 +jitterMax/7（零和）。
 * 实施期实测该对抗上界在 jitterMax 处是 **4.357 ≥ 4** ⇒ 任何逐 region 采样器都安全，
 * 不依赖抽样序列碰巧落在 300 个样本里。
 * ⚠️ 单测钉不到它：`jitterMax` 是本模块私有量，为它加导出会为了测试而扩 API。
 * 单测实际覆盖的是「真实采样器在跨 region / 跨 seed 下都 ≥ TARN_GAP」
 * （`test-tarn-zone.js` 的「跨 region / 跨 seed 都满足间距」用例）。
 */
const jitterMaxCache = new Map();
const JITTER_SAMPLE_COUNT = 300;
const JITTER_BISECT_STEPS = 30;
/** 抖动取二分上界的 0.8 倍（留 20% 余量，spec DR-7）。 */
const JITTER_SAFETY_RATIO = 0.8;

/** @param {number} seed @returns {number} jitterMax（弧度） */
function tarnJitterMax(seed) {
  const cached = jitterMaxCache.get(seed);
  if (cached !== undefined) return cached;

  const { gapAngle } = tarnRingMetrics();
  let lo = 0;
  let hi = gapAngle / 2;
  for (let step = 0; step < JITTER_BISECT_STEPS; step++) {
    const mid = (lo + hi) / 2;
    if (tarnWorstGapOverSamples(seed, mid) >= TARN_GAP) lo = mid;
    else hi = mid;
  }
  const jitterMax = lo * JITTER_SAFETY_RATIO;
  jitterMaxCache.set(seed, jitterMax);
  return jitterMax;
}

/**
 * 环上 8 座的占角与缝角（与 seed 无关，纯几何）。
 *
 * 占角 = `2·asin(max(halfX, halfZ) / ringR)`（spec DR-7 算法第 2 步）。
 * ⚠️ 这只是**排序用的保守角向度量**，不是真实 AABB 占地 —— 真实间距由 `aabbGap` 单独算。
 * 少了它，大小悬殊的 8 座会被均分到等角位上，大座互相插进去。
 *
 * 定稿实测：总占角 **238.02°**、缝隙角 **15.247°**、无抖动最坏 AABB 间距 **5.046**
 * （cloudland_tarn_03 ↔ cloudland_tarn_04）。
 */
function tarnRingMetrics() {
  const tarns = TARN_KEPT_TARN_IDS.map((id) => {
    const metric = KIT_METRICS[id];
    return { variant: id, ...tarnHalfWidth(metric) };
  });
  // 按保守角向半径降序：大座先入环，占角才与真实占地同序
  tarns.sort((a, b) => Math.max(b.halfX, b.halfZ) - Math.max(a.halfX, a.halfZ));
  const occ = tarns.map((t) => 2 * Math.asin(Math.max(t.halfX, t.halfZ) / TARN_RING_RADIUS));
  const gapAngle = (2 * Math.PI - occ.reduce((sum, v) => sum + v, 0)) / tarns.length;
  return { tarns, occ, gapAngle };
}

/**
 * 把一段「原始抖动」去均值（零和）。
 * @param {number[]} raw @returns {number[]}
 */
function zeroSum(raw) {
  const mean = raw.reduce((sum, v) => sum + v, 0) / raw.length;
  return raw.map((v) => v - mean);
}

/** 一组抖动下相邻高台的最坏 AABB 间距 */
function tarnWorstAdjacentGap(tarns, jitter, occ, gapAngle) {
  const n = tarns.length;
  const placed = tarnPlaceOnRing(tarns, occ, gapAngle, jitter);
  let worst = Infinity;
  for (let i = 0; i < n; i++) {
    const gap = aabbGap(placed[i], placed[(i + 1) % n]);
    if (gap < worst) worst = gap;
  }
  return worst;
}

/** 按占角 + 缝角 + 零和抖动把高台摆上环（返回带 cx/cz 的矩形） */
function tarnPlaceOnRing(tarns, occ, gapAngle, jitter) {
  const placed = [];
  let cursor = 0;
  for (let i = 0; i < tarns.length; i++) {
    cursor += occ[i];
    const ang = cursor - occ[i] / 2;
    cursor += gapAngle + jitter[i];
    placed.push({
      variant: tarns[i].variant,
      ang,
      ring: TARN_RING_RADIUS,
      halfX: tarns[i].halfX,
      halfZ: tarns[i].halfZ,
      cx: TARN_RING_RADIUS * Math.cos(ang),
      cz: TARN_RING_RADIUS * Math.sin(ang),
    });
  }
  return placed;
}

/** 二分用：在 `JITTER_SAMPLE_COUNT` 组抽样上取最坏相邻间距 */
function tarnWorstGapOverSamples(seed, jitterAmplitude) {
  const { tarns, occ, gapAngle } = tarnRingMetrics();
  const n = tarns.length;
  let worst = Infinity;
  for (let sample = 0; sample < JITTER_SAMPLE_COUNT; sample++) {
    const raw = [];
    for (let i = 0; i < n; i++) {
      raw.push((seededRandom(i, sample, seed + TARN_ANGLE_SALT) - 0.5) * 2 * jitterAmplitude);
    }
    const gap = tarnWorstAdjacentGap(tarns, zeroSum(raw), occ, gapAngle);
    if (gap < worst) worst = gap;
  }
  return worst;
}

/**
 * 某个 region 的高台角向抖动（零和，逐 region 抽签）。
 *
 * ⚠️ 抖动**必须逐 region 变化**：全局固定会退化成机械等距（观感是「用尺子摆的」）。
 * 安全性不依赖这个采样器选得巧 —— `tarnJitterMax` 的对抗上界保证任何零和向量都安全
 * （见该常量的注释）。
 */
function tarnRegionJitter(regionX, regionZ, seed, count) {
  const jitterMax = tarnJitterMax(seed);
  // regionKey 把 (regionX, regionZ) 折成一维，喂给 seededRandom 的 x 槽。
  // ⚠️ 这会碰撞：`(rx, rz)` 与 `(rx + 17, rz − 31)` 得到同一个 key。
  // **碰撞无害**：碰撞只意味着两个 region 共享同一组抖动，而抖动正确性由
  // `tarnJitterMax` 的对抗上界保证（任何零和向量都 ≥ TARN_GAP），不依赖各 region 互不相同。
  const regionKey = regionX * 31 + regionZ * 17;
  const raw = [];
  for (let i = 0; i < count; i++) {
    raw.push((seededRandom(i, regionKey, seed + TARN_ANGLE_SALT) - 0.5) * 2 * jitterMax);
  }
  return zeroSum(raw);
}

// ==================== 装饰件落位（spec DR-8） ====================

/**
 * 拱洞所在的**池外台地**中线半径（spec DR-8）。
 *
 * 台地环带是 90~160（宽 70 格），中线 125 让最宽拱洞（19×36）两侧各留 ~30 格。
 * ⚠️ **不要把拱洞塞进高台之间的缝里**：定稿组合的相邻高台真实间距只有 5.05 格，
 * 而最宽拱洞 19 格 —— 差 14 格，塞不进去。这是 spec 的一条修正（原设计那么写，几何不成立）。
 *
 * 实测（5 等角位、无抖动）：最近角 **111.66** > 池半径 90、最远角 **138.94** < 地带半径 160。
 */
export const TARN_ARCH_RING_RADIUS = 125;

/**
 * 紫晶柱所在的**池内**内环半径（spec DR-8）。
 *
 * ⚠️ **不要用原公式 `max(12, ringR − max(half) − 30)`** —— 它在 ringR=58 下算出 12，
 * 而实测内环 12 时 7 个紫晶柱**互相重叠 3 对**（最小距 **−1.86**）。
 * 20 是穷举实测的安全值（互距 3.57、vs 高台 +4.8）。
 * ⚠️ **上界是 24**（26 起 vs 高台 −1.20 撞上），调大前必须重跑 spec DR-8 那张表。
 */
export const TARN_SPIRE_RING_RADIUS = 20;

/** 装饰件角向抖动的幅度上限（弧度 ≈ 3°）：比高台松得多 —— 它们体积小、彼此间距充裕。 */
const DECO_JITTER_RAD = 3 * Math.PI / 180;

/** 巨型云的环半径 = 地带半径 × 0.6（spec DR-10） */
const CLOUD_RING_RATIO = 0.6;
/** 云环与高台环的角度错开量（spec DR-10） */
const CLOUD_ANGLE_OFFSET = Math.PI / 11;
/** 巨型云只从「格数最大的前 6 个」里抽（spec DR-10：60/121/436 格云无视觉意义） */
const CLOUD_POOL_SIZE = 6;
/** 地带里的云数 */
const CLOUD_COUNT = 4;

/**
 * 装饰件落位：`count` 个变体按等角位摆上环，带零和抖动。
 *
 * @param {string[]} variantIds 变体基名（顺序 = 环上顺序）
 * @param {number} ring 环半径
 * @param {'arch'|'spire'} kind 装饰件类型
 * @param {number} regionX @param {number} regionZ @param {number} seed
 * @returns {Array<{variant: string, kind: string, ang: number, ring: number, halfX: number, halfZ: number}>}
 */
function tarnPlaceDecos(variantIds, ring, kind, regionX, regionZ, seed) {
  const count = variantIds.length;
  const regionKey = regionX * 31 + regionZ * 17;
  const raw = [];
  for (let i = 0; i < count; i++) {
    raw.push((seededRandom(regionKey + i * 7, i, seed + TARN_DECO_SALT) - 0.5) * 2 * DECO_JITTER_RAD);
  }
  const jitter = zeroSum(raw);
  return variantIds.map((variant, i) => {
    const ang = i * 2 * Math.PI / count + jitter[i];
    const { halfX, halfZ } = tarnHalfWidth(KIT_METRICS[variant]);
    return { variant, kind, ang, ring, halfX, halfZ };
  });
}

/**
 * 巨型云落位：从格数最大的前 6 个里，按 seed 定起点顺序取 4 个，摆在地带圆内的错开角度上。
 *
 * @param {number} regionX @param {number} regionZ @param {number} seed
 * @returns {Array<{variant: string, ang: number, ring: number}>}
 */
function tarnPlaceClouds(regionX, regionZ, seed) {
  const pool = KIT_VARIANTS.giantCloud
    .map((id) => ({ id, blocks: KIT_METRICS[id].blocks }))
    .sort((a, b) => b.blocks - a.blocks)
    .slice(0, CLOUD_POOL_SIZE)
    .map((v) => v.id);

  // 起点由 seed/region 决定：不同 seed 看到不同的云组合
  const start = Math.floor(
    seededRandom(regionX, regionZ, seed + TARN_CLOUD_SALT) * pool.length,
  );
  const clouds = [];
  for (let i = 0; i < CLOUD_COUNT; i++) {
    const variant = pool[(start + i) % pool.length];
    const ang = CLOUD_ANGLE_OFFSET + i * 2 * Math.PI / CLOUD_COUNT;
    clouds.push({ variant, ang, ring: TARN_ZONE_RADIUS * CLOUD_RING_RATIO });
  }
  return clouds;
}

// ==================== 地带布局 ====================

/**
 * @typedef {{
 *   cx: number, cz: number,
 *   poolRadius: number, plateauRadius: number, plateauY: number,
 *   tarns: Array<{variant: string, ang: number, ring: number, halfX: number, halfZ: number}>,
 *   decos: Array<{variant: string, kind: 'arch'|'spire', ang: number, ring: number,
 *                 halfX: number, halfZ: number}>,
 *   clouds: Array<{variant: string, ang: number, ring: number}>
 * }} TarnLayout
 */

/**
 * 高台地带的完整布局。
 *
 * @param {number} regionX @param {number} regionZ @param {number} seed
 * @returns {TarnLayout | null} 非地带 region 返回 null
 */
export function computeTarnZone(regionX, regionZ, seed) {
  if (!isTarnZone(regionX, regionZ, seed)) return null;

  const { tarns, occ, gapAngle } = tarnRingMetrics();
  const jitter = tarnRegionJitter(regionX, regionZ, seed, tarns.length);
  const placed = tarnPlaceOnRing(tarns, occ, gapAngle, jitter);

  const decos = [
    ...tarnPlaceDecos(KIT_VARIANTS.arch, TARN_ARCH_RING_RADIUS, 'arch', regionX, regionZ, seed),
    ...tarnPlaceDecos(KIT_VARIANTS.spire, TARN_SPIRE_RING_RADIUS, 'spire', regionX, regionZ, seed),
  ];

  const { cx, cz } = tarnZoneCenter(regionX, regionZ);
  return {
    cx,
    cz,
    poolRadius: TARN_POOL_RADIUS,
    plateauRadius: TARN_ZONE_RADIUS,
    plateauY: TARN_PLATEAU_Y,
    tarns: placed,
    decos,
    clouds: tarnPlaceClouds(regionX, regionZ, seed),
  };
}
