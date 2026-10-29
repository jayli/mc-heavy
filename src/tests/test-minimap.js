// src/tests/test-minimap.js — 迷你区域地图（v2.8）的纯函数契约（Tier 1）
//
// 被测对象是 `src/ui/minimap-regions.js`（无 DOM / 无 three，可直接驱动）；DOM 层
// （画布尺寸、左下角定位、玩家点在正中）由 `tests/minimap.spec.mjs` 的 Tier 4 用例兜住。
//
// ## 这些用例保护什么（每条都对应一种「静默画错」的形态）
//
// 1. **配色两两可分**：地图的全部价值在于「一眼看出这是什么区域」。两个种类颜色太近
//    （例如沼泽 vs 森林）时地图照常渲染、不报错，只是玩家分不出来 —— 静默。
// 2. **分类与既有权威一致**：城市 vs `getCityInfo`、雪原 vs `getSnowLandInfo`、
//    水面 vs `fillColumn` 的水体判据。不一致的形态是「地图上一片海，飞过去是陆地」。
// 3. **上北下南**：把采样公式的 z 符号写反，地图完全正常、只是南北颠倒 —— 只有断言能抓。
// 4. **玩家恒在中心**：中心样本必须恰好是玩家所在格（`MINIMAP_SAMPLES` 为奇数才有这个性质）。
// 5. **移动即滚动**：底图内容必须是「以玩家为中心的世界」，不是固定坐标的世界（后者
//    玩家走出地图范围后点就跑到框外 —— 但没有任何报错）。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse, assertNotEqual } from './assert.js';
import {
  AREA_KINDS, AREA_COLORS, MINIMAP_SAMPLES, MINIMAP_STEP, MINIMAP_SPAN,
  kindAt, ditherAt, fillColor, paintMinimap, minimapRegionContext, minimapAreaBounds,
  clearMinimapContextCache, minimapContextCacheSize,
} from '../ui/minimap-regions.js';
import { getBiome } from '../gen/noise.js';
import { generateHeight, generateHeightForBiome } from '../gen/terrain.js';
import { SEA_Y } from '../voxel/constants.js';
import { buildCityLayout, getCityInfo } from '../gen/structures/city-layout.js';
import { getSnowLandInfo } from '../gen/structures/landmarks.js';
import { getRegionSeededCenter } from '../gen/structures/region-center.js';
import { LANDMARK_OFFSET, REGION_SIZE } from '../gen/structures/region-config.js';
import {
  isTarnZone, computeTarnZone, tarnZoneCenter, TARN_ZONE_RADIUS,
  snowLandSuppressedByTarn,
} from '../gen/structures/tarn-zone.js';

const SEED = 12345;
const NO_CTX = { city: null, tarns: [], snows: [] };

/** 找一座地带（供 TARN 用例；`isTarnZone` 是纯函数，扫满几环即命中） */
function findTarn(seed, maxRing = 12) {
  for (let ring = 0; ring <= maxRing; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dz = -ring; dz <= ring; dz++) {
        if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dz) !== ring) continue;
        if (isTarnZone(dx, dz, seed)) return computeTarnZone(dx, dz, seed);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- 1. 常量与配色

test('minimap: 常量自洽（样本奇数 / 跨度 = 步长 × (N-1) / 画布尺寸整数倍）', () => {
  assertEqual(MINIMAP_SAMPLES % 2, 1, '样本边长必须奇数（中心样本 = 玩家所在格）');
  assertEqual(MINIMAP_SPAN, (MINIMAP_SAMPLES - 1) * MINIMAP_STEP);
  // 跨度覆盖 1 个多 region，否则地图上永远只有一种 biome（看不出「区域类型」）
  assertTrue(MINIMAP_SPAN > REGION_SIZE, `跨度 ${MINIMAP_SPAN} 应大于一个 region`);
});

test('minimap: 每个种类都有配色，且两两 RGB 距离 ≥ 55（小尺寸下可分）', () => {
  for (const kind of AREA_KINDS) {
    assertTrue(Array.isArray(AREA_COLORS[kind]), `${kind} 缺配色`);
  }
  let minDist = Infinity, minPair = '';
  for (let i = 0; i < AREA_KINDS.length; i++) {
    for (let j = i + 1; j < AREA_KINDS.length; j++) {
      const a = AREA_COLORS[AREA_KINDS[i]], b = AREA_COLORS[AREA_KINDS[j]];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      if (d < minDist) { minDist = d; minPair = `${AREA_KINDS[i]}/${AREA_KINDS[j]}`; }
    }
  }
  assertTrue(minDist >= 55, `最接近的一对 ${minPair} 只有 ${minDist.toFixed(1)} 距离`);
  // 抖动幅度不能把两种颜色糊到一起
  const dither = Math.abs(ditherAt(1, 0));
  assertTrue(minDist - 2 * dither >= 40, `抖动 ${dither} 之后可分辨度不足`);
});

test('minimap: 抖动是世界坐标的纯函数（同格恒同值、相邻格会变）', () => {
  assertEqual(ditherAt(123, -45), ditherAt(123, -45));
  const kinds = new Set();
  for (let x = 0; x < 64; x++) kinds.add(ditherAt(x, 0));
  assertEqual(kinds.size, 2, '抖动应有两个级别');
  // 负坐标不得退化（`Math.min(wx%8, ...)` 那类取余陷阱的等价物）：
  // 抖动是**世界锚定的**，即 |wx| 相同、符号不同的两格落在同一奇偶 tile 时同值；
  // 但更关键的是一个**与正坐标同构**的性质 —— 负坐标的抖动不得恒为 0。
  const negKinds = new Set();
  for (let x = -64; x < 0; x++) negKinds.add(ditherAt(x, 0));
  assertEqual(negKinds.size, 2, '负坐标下抖动必须同样有两级（取余陷阱的回归门）');
  assertTrue(ditherAt(-1, 0) === 0 || ditherAt(-1, 0) === -6);
});

// ---------------------------------------------------------------- 2. 分类与权威一致

test('minimap: 水面判据与 fillColumn 同源（h < SEA_Y 才算水）', () => {
  // 找一个真实水点与真实陆点（不允许凭想象断言 —— testing-policy §2.6 第 ⑤ 条）
  let water = null, land = null;
  for (let r = 0; r < 2000 && (!water || !land); r += 11) {
    for (const [dx, dz] of [[r, 0], [0, r], [-r, 0], [0, -r], [r, r], [-r, -r]]) {
      const h = generateHeight(dx, dz, SEED);
      if (!water && h < SEA_Y) water = { x: dx, z: dz, h };
      if (!land && h > SEA_Y) land = { x: dx, z: dz, h };
    }
  }
  assertTrue(water !== null, '须找到真实水点');
  assertTrue(land !== null, '须找到真实陆点');
  assertEqual(kindAt(water.x, water.z, SEED, NO_CTX), 'WATER', `h=${water.h} 应为水`);
  assertNotEqual(kindAt(land.x, land.z, SEED, NO_CTX), 'WATER', `h=${land.h} 应为陆`);
});

test('minimap: 非水域样本的种类 = getBiome（与坐标 HUD 同一权威）', () => {
  // 注意：`kindAt` 内部用 `generateHeightForBiome(..., biome)` 省一半 getBiome 调用，
  // 必须与 `generateHeight` 逐位等价 —— 这条同时钉住那个等价性。
  let checked = 0;
  for (let x = -300; x <= 300; x += 37) {
    for (let z = -300; z <= 300; z += 41) {
      const biome = getBiome(x, z, SEED);
      const h = generateHeight(x, z, SEED);
      assertEqual(generateHeightForBiome(x, z, SEED, biome), h, `(${x},${z}) 高度须等价`);
      const kind = kindAt(x, z, SEED, NO_CTX);
      if (h < SEA_Y) assertEqual(kind, 'WATER');
      else assertEqual(kind, biome, `(${x},${z})`);
      checked++;
    }
  }
  assertTrue(checked > 100, `样本太少（${checked}）`);
});

test('minimap: 城市判据与 getCityInfo 逐点一致（含 bounds 边界外的点）', () => {
  const city = buildCityLayout(SEED);
  const ctx = { city, tarns: [], snows: [] };
  let inside = 0, outside = 0;
  for (let x = city.minX - 5; x <= city.maxX + 5; x += 13) {
    for (let z = city.minZ - 5; z <= city.maxZ + 5; z += 17) {
      const kind = kindAt(x, z, SEED, ctx);
      const inCity = getCityInfo(x, z, city) !== null;
      if (inCity) { assertEqual(kind, 'CITY', `(${x},${z})`); inside++; }
      else { assertNotEqual(kind, 'CITY', `(${x},${z})`); outside++; }
    }
  }
  assertTrue(inside > 50 && outside > 10, `样本不足 inside=${inside} outside=${outside}`);
});

test('minimap: 高台地带判据与 isTarnZone 的圆一致（圆内 TARN / 圆外不是）', () => {
  const tarn = findTarn(SEED);
  assertTrue(tarn !== null, '须找到一座地带');
  const ctx = { city: null, tarns: [{ cx: tarn.cx, cz: tarn.cz, r: TARN_ZONE_RADIUS }], snows: [] };
  // 圆心与三个半径处的采样
  assertEqual(kindAt(tarn.cx, tarn.cz, SEED, ctx), 'TARN', '圆心');
  assertEqual(kindAt(tarn.cx + TARN_ZONE_RADIUS - 2, tarn.cz, SEED, ctx), 'TARN', '圆内近缘');
  assertNotEqual(kindAt(tarn.cx + TARN_ZONE_RADIUS + 3, tarn.cz, SEED, ctx), 'TARN', '圆外');
  // 上下文收集器必须把这座地带收进来（否则地图上整片地带消失）
  clearMinimapContextCache();
  const built = minimapRegionContext(SEED, tarn.cx, tarn.cz, null);
  assertTrue(built.tarns.some((t) => t.cx === tarn.cx && t.cz === tarn.cz),
    '上下文须包含玩家脚下的地带');
});

test('minimap: 雪原判据与 getSnowLandInfo 的包围盒一致（含被地带让路的雪原不画）', () => {
  // 找一个雪原落地的 region：中心 + getSnowLandInfo 返回非 null
  let hit = null;
  for (let rx = -6; rx <= 6 && !hit; rx++) {
    for (let rz = -6; rz <= 6 && !hit; rz++) {
      const raw = getRegionSeededCenter(rx, rz, SEED);
      const snowLand = {
        cx: raw.centerX + LANDMARK_OFFSET.SNOW_LAND_X,
        cz: raw.centerZ + LANDMARK_OFFSET.SNOW_LAND_Z,
      };
      if (getSnowLandInfo(snowLand.cx, snowLand.cz, snowLand, SEED)) hit = { rx, rz, snowLand };
    }
  }
  assertTrue(hit !== null, '须找到一个雪原中心');
  clearMinimapContextCache();
  const ctx = minimapRegionContext(SEED, hit.snowLand.cx, hit.snowLand.cz, null);
  // 若这座雪原被高台地带让路掉，它不该出现在上下文里（世界里根本没有它）
  const inside = ctx.snows.some((s) => s.minX <= hit.snowLand.cx && hit.snowLand.cx <= s.maxX);
  if (inside) {
    assertEqual(kindAt(hit.snowLand.cx, hit.snowLand.cz, SEED, ctx), 'SNOW', '中心应为 SNOW');
    assertNotEqual(kindAt(hit.snowLand.cx + 200, hit.snowLand.cz, SEED, ctx), 'SNOW', '框外');
  }
  // 上下文里的每个方框都必须真的被 getSnowLandInfo 认可（不是凭空生成的雪原）
  for (const s of ctx.snows) {
    const sl = { cx: s.cx, cz: s.cz };
    assertTrue(getSnowLandInfo(s.cx, s.cz, sl, SEED) !== null, `(${s.cx},${s.cz}) 雪原不存在`);
  }
});

/**
 * 被高台地带让路掉的雪原**不得出现在上下文里**。
 *
 * ⚠️ **单独一条用例（不能并进上一条）**：上一条取的是「第一个存在的雪原」，它极可能
 * 不被让路 —— 那里的 `if (inside)` 分支一旦落空，「忽略 suppressed」的注入就拓不到
 * （实测：合并写法下这个注入全绿 = **无效盲区**）。`snowLandSuppressedByTarn` 在 seed
 * 12345 的 ±20 region 窗口里命中 77/1681，但必须**先搜出来再断言**，不能假定哪个 region 是。
 */
test('minimap: 被高台地带让路的雪原不得画在地图上（世界真相优先）', () => {
  let victim = null;
  outer:
  for (let rx = -20; rx <= 20; rx++) {
    for (let rz = -20; rz <= 20; rz++) {
      if (!snowLandSuppressedByTarn(rx, rz, SEED)) continue;
      const raw = getRegionSeededCenter(rx, rz, SEED);
      const cx = raw.centerX + LANDMARK_OFFSET.SNOW_LAND_X;
      const cz = raw.centerZ + LANDMARK_OFFSET.SNOW_LAND_Z;
      // 只有真的与地图窗口相交的才有判别力（不相交的本来就不会被收进上下文）
      if (minimapAreaBounds(cx, cz).minX > cx + 28 || minimapAreaBounds(cx, cz).maxX < cx - 28) continue;
      if (getSnowLandInfo(cx, cz, { cx, cz }, SEED) === null) continue;
      victim = { cx, cz };
      break outer;
    }
  }
  assertTrue(victim !== null, '须找到一座被让路的雪原（否则本用例无判别力）');
  clearMinimapContextCache();
  const ctx = minimapRegionContext(SEED, victim.cx, victim.cz, null);
  const drawn = ctx.snows.some((s) => s.minX <= victim.cx && victim.cx <= s.maxX
    && s.minZ <= victim.cz && victim.cz <= s.maxZ);
  assertFalse(drawn, `(${victim.cx},${victim.cz}) 的雪原世界里不存在，不得进上下文`);
  assertNotEqual(kindAt(victim.cx, victim.cz, SEED, ctx), 'SNOW', '不得画成 SNOW');
});

test('minimap: 雪原的 X/Z 偏移各用各自的常量（LANDMARK_OFFSET 的两轴不同）', () => {
  // `LANDMARK_OFFSET.SNOW_LAND_X = 160` 而 `SNOW_LAND_Z = 0`（雪原在金字塔位正东）。
  // 把 X 的区间套到 Z 上时，Z 区间下界被抬高 160 格 → 靠南的雪原被漏收（**静默**：
  // 地图上少一片雪白，但没有任何报错）。这条用例直接钉住两轴的区间来源。
  assertNotEqual(LANDMARK_OFFSET.SNOW_LAND_X, LANDMARK_OFFSET.SNOW_LAND_Z,
    '本用例的前提：两轴偏移本来就不同');

  // 找一个 Z 偏移接近最小值的 region（即中心 z 比 region 原点只多 ~100 格，
  // 比 X 偏移 160 格小）—— 它的雪原只有「Z 用 Z 常量」时才会被收进上下文。
  let witness = null;
  for (let rx = -40; rx <= 40 && !witness; rx++) {
    for (let rz = -40; rz <= 40 && !witness; rz++) {
      const raw = getRegionSeededCenter(rx, rz, SEED);
      if (raw.centerZ - rz * REGION_SIZE >= 160) continue; // 只要 z 偏移 < 160 的
      const cx = raw.centerX + LANDMARK_OFFSET.SNOW_LAND_X;
      const cz = raw.centerZ + LANDMARK_OFFSET.SNOW_LAND_Z;
      if (getSnowLandInfo(cx, cz, { cx, cz }, SEED) === null) continue;
      if (snowLandSuppressedByTarn(rx, rz, SEED)) continue;
      witness = { rx, rz, cx, cz };
    }
  }
  assertTrue(witness !== null, '须找到一个 z 偏移 < 160 格的可行雪原（否则本用例无判别力）');

  // 把地图窗口的中心放在这座雪原上 —— 上下文必须收录它。
  // （如果实现错把 X 的 [100,400) 区间用在 Z 上，下界就変成 160 ⇒ 整座被漏掉。）
  clearMinimapContextCache();
  const ctx = minimapRegionContext(SEED, witness.cx, witness.cz, null);
  assertTrue(ctx.snows.some((s) => s.cx === witness.cx && s.cz === witness.cz),
    `z 偏移 < 160 的雪原 (${witness.cx},${witness.cz}) 被漏收了（X/Z 偏移混用？）`);
  assertEqual(kindAt(witness.cx, witness.cz, SEED, ctx), 'SNOW');
});

/**
 * 上下文必须收录**每一个与地图窗口相交**的雪原（不漏），且不收录无关的。
 *
 * ⚠️ **必须用暴力枚举作参照、且必然覆盖大量窗口**：region 区间公式只有两个边界用的
 * offset 写反才算错（下界用 `centerMax`、上界用 `centerMin`），而地带
 * （`centerMin === centerMax`）对这个错误完全不敏感 —— 只有雪原（偏移区间宽 300 格）
 * 能拓到。实测：写反后 seed 12345 / 窗口 [-500,0] 会漏掉 region −2 的那座雪原。
 */

/**
 * **缓存命中时上下文必须仍然完整**（同一 region 区间、不同窗口）。
 *
 * ⚠️ **不能只测「每个窗口都清空缓存」**：那样从来不会命中缓存，测不到「缓存内容是按
 * **某个具体窗口**过滤的」这个错。地图跨度 1000 格而一组 region 区间覆盖 400×N 格，
 * 两个相邻窗口很容易共享同一个区间 —— 那时后者会拿到缺结构的上下文（**静默**：地图
 * 上少一片雪白）。正确做法 = 缓存存「这组 region 能贡献的**全部**结构」，窗口过滤交给
 * `kindAt` 的 AABB 判据。
 */
test('minimap: 缓存命中时上下文仍完整（不能按某个具体窗口去过滤缓存内容）', () => {
  // ⚠️ **必须用「同一缓存键、不同窗口」的一对中心** —— 随便取一串位置时，实测命中率虽高但
  // 相交集合恰好相同的概率也高（注入「按窗口过滤」后仍全绿 = **无效盲区**）。
  // 这里的两点经验证：缓存键完全相同（`-8,-4|-7,-4|-8,-5|-7,-4`），而相交雪原集合差
  // **2 座** —— 前者缓存后，后者拿到缺结构的上下文。
  const centers = [[-2000, -1836], [-2000, -1754]];
  let checked = 0, missing = 0, hits = 0;
  let prev = null;
  clearMinimapContextCache();
  for (const [px, pz] of centers) {
    const b = minimapAreaBounds(px, pz);
    const ctx = minimapRegionContext(SEED, px, pz, null);
    if (ctx === prev) hits++;   // 同一份对象 = 真的命中缓存
    prev = ctx;
    for (let rx = -40; rx <= 40; rx++) {
      for (let rz = -40; rz <= 40; rz++) {
        const raw = getRegionSeededCenter(rx, rz, SEED);
        const cx = raw.centerX + LANDMARK_OFFSET.SNOW_LAND_X;
        const cz = raw.centerZ + LANDMARK_OFFSET.SNOW_LAND_Z;
        if (cx + 28 < b.minX || cx - 28 > b.maxX) continue;
        if (cz + 28 < b.minZ || cz - 28 > b.maxZ) continue;
        if (snowLandSuppressedByTarn(rx, rz, SEED)) continue;
        if (getSnowLandInfo(cx, cz, { cx, cz }, SEED) === null) continue;
        checked++;
        if (!ctx.snows.some((s) => s.cx === cx && s.cz === cz)) missing++;
      }
    }
  }
  assertTrue(checked > 3, `样本太少（${checked}）`);
  assertTrue(hits > 0, '本用例需要真的命中过缓存（否则拓不到缓存内容口径错）');
  assertEqual(missing, 0, `缓存命中时漏了 ${missing} 座雪原`);
});
/**
 * 上下文必须收录**每一个与地图窗口相交**的雪原（不漏）。
 */
test('minimap: 上下文不漏任何与窗口相交的雪原（暴力枚举对照）', () => {
  const SNOW_HALF = 28; // `getSnowLandInfo` 的 totalHalfSize（floor(40/2) + 8）
  const probes = [[0, 0], [-250, 0], [-750, 0], [1200, 900], [-2800, -2600], [-12000, 300]];
  let checked = 0, missing = 0;
  for (const [px, pz] of probes) {
    const b = minimapAreaBounds(px, pz);
    // 暴力：扫大范围 region，算出所有与窗口相交的雪原中心
    // ⚠️ **必须同时带着 `rx/rz`**：雪原中心 = region 原点 + 偏移（X 偏 +160、Z 偏 0），
    // 不能用 `floor(cx/400)` 反推它属于哪个 region —— 实测那样会拿错 region 去问
    // `snowLandSuppressedByTarn`，把「世界里不存在」的雪原算进期望值（假失败）。
    const expected = [];
    for (let rx = -40; rx <= 40; rx++) {
      for (let rz = -40; rz <= 40; rz++) {
        const raw = getRegionSeededCenter(rx, rz, SEED);
        const cx = raw.centerX + LANDMARK_OFFSET.SNOW_LAND_X;
        const cz = raw.centerZ + LANDMARK_OFFSET.SNOW_LAND_Z;
        if (cx + SNOW_HALF < b.minX || cx - SNOW_HALF > b.maxX) continue;
        if (cz + SNOW_HALF < b.minZ || cz - SNOW_HALF > b.maxZ) continue;
        expected.push({ rx, rz, cx, cz });
      }
    }
    clearMinimapContextCache();
    const ctx = minimapRegionContext(SEED, px, pz, null);
    for (const e of expected) {
      // 只有**真的存在**且**没被地带让路**的雪原才该出现（两者都用既有权威判）
      if (snowLandSuppressedByTarn(e.rx, e.rz, SEED)) continue;
      if (getSnowLandInfo(e.cx, e.cz, { cx: e.cx, cz: e.cz }, SEED) === null) continue;
      checked++;
      if (!ctx.snows.some((s) => s.cx === e.cx && s.cz === e.cz)) missing++;
    }
  }
  assertTrue(checked > 3, `样本太少（${checked}）—— 本用例需要有判别力的雪原`);
  assertEqual(missing, 0, `上下文漏了 ${missing} 座与窗口相交的雪原`);
});

// ---------------------------------------------------------------- 3. 方向与居中

test('minimap: 上北下南左西右东（采样公式的方向契约）', () => {
  // 找一个「南北两侧 biome 明显不同」的位置，才看得出方向。
  // ⚠️ **不能用 `probe.z ± SPAN/2` 去搜** —— 那是把「即将被验证的映射」当成搜索条件，
  // 搜索与断言同源时映射写反也会搜到（再写反一次就碰上）。故改成：先枚举候选，
  // 再对每个候选**用真实 paintMinimap 输出**比对上下两个半区，取差异最大的那个。
  const S = MINIMAP_SAMPLES;
  const data = new Uint8ClampedArray(S * S * 4);
  const px = (i, j) => { const o = (j * S + i) * 4; return [data[o], data[o + 1], data[o + 2]]; };
  // 期望值 = `fillColor`（含世界锚定抖动）—— 只对比基础色会漏掉抖动量 6/通道（距离 10.4）
  const expectAt = (wx, wz) => {
    const out = [0, 0, 0];
    fillColor(out, kindAt(wx, wz, SEED, NO_CTX), wx, wz);
    return out;
  };
  const exact = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

  let probe = null, bestDiff = -1;
  clearMinimapContextCache();
  for (let x = -1200; x <= 1200 && bestDiff < 120; x += 97) {
    for (let z = -1200; z <= 1200 && bestDiff < 120; z += 89) {
      paintMinimap(data, x, z, SEED, NO_CTX);
      const a = px(0, 0), b = px(0, S - 1);
      const diff = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      if (diff > bestDiff) { bestDiff = diff; probe = { x, z }; }
    }
  }
  assertTrue(probe !== null && bestDiff > 40, `须找到南北差异明显的位置（实测 ${bestDiff.toFixed(1)}）`);

  paintMinimap(data, probe.x, probe.z, SEED, NO_CTX);
  const bx = Math.floor(probe.x), bz = Math.floor(probe.z);
  const half = MINIMAP_SPAN / 2;
  // 顶行 = 北（z 小）；底行 = 南（z 大）；左列 = 西（x 小）；右列 = 东（x 大）
  assertTrue(exact(px(0, 0), expectAt(bx - half, bz - half)),
    `左上像素应是世界格 (${bx - half}, ${bz - half}) 的种类`);
  assertTrue(exact(px(0, S - 1), expectAt(bx - half, bz + half)),
    `左下像素应是世界格 (${bx - half}, ${bz + half}) 的种类`);
  assertTrue(exact(px(S - 1, 0), expectAt(bx + half, bz - half)),
    `右上像素应是世界格 (${bx + half}, ${bz - half}) 的种类`);
  // 北与南在真实世界上就不同（否则上面三条成立不了，用它们做前提断言）
  // ⚠️ 必须与上面比的是同一列（x = bx−half）：搜索时选用的就是 `px(0,0) vs px(0,S-1)`。
  assertNotEqual(
    kindAt(bx - half, bz - half, SEED, NO_CTX), kindAt(bx - half, bz + half, SEED, NO_CTX),
    '本用例的前提：所选位置的南北两半确实是不同区域',
  );
});

test('minimap: 中心样本恰好是玩家所在格（玩家恒在中心）', () => {
  const S = MINIMAP_SAMPLES, mid = (S - 1) >> 1;
  const data = new Uint8ClampedArray(S * S * 4);
  const px = (i, j, d = data) => { const o = (j * S + i) * 4; return [d[o], d[o + 1], d[o + 2]]; };
  const expectAt = (wx, wz) => {
    const out = [0, 0, 0];
    fillColor(out, kindAt(wx, wz, SEED, NO_CTX), wx, wz);
    return out;
  };

  // ⚠️ **位置要挑「中心格与邻格颜色不同」的**：随便拿一个坐标时，中格与 ±1 样本恰好
  // 同 biome、同抖动（同一对 8 格 tile 的奇偶可能相同），注入「mid 偏一格」就拓不到
  // —— 实测在 (123.7, −45.2) 上注入 mid+1 全绿（**无效盲区**）。
  let spot = null;
  for (let x = -400; x <= 400 && !spot; x += 7) {
    for (let z = -400; z <= 400 && !spot; z += 5) {
      const center = expectAt(x, z).join(',');
      const right = expectAt(x + MINIMAP_STEP, z).join(',');
      const up = expectAt(x, z - MINIMAP_STEP).join(',');
      if (center !== right && center !== up) spot = { x, z, center };
    }
  }
  assertTrue(spot !== null, '须找到一个中心与邻格都不同的位置（否则本用例无判别力）');

  clearMinimapContextCache();
  paintMinimap(data, spot.x, spot.z, SEED, NO_CTX);
  assertEqual(px(mid, mid).join(','), spot.center, '中心像素 = 玩家所在格');
  // 上/右两个方向的样本也必须对得上（同时钉住 mid 对称性与方向）
  assertEqual(px(mid + 1, mid).join(','), expectAt(spot.x + MINIMAP_STEP, spot.z).join(','));
  assertEqual(px(mid, mid - 1).join(','), expectAt(spot.x, spot.z - MINIMAP_STEP).join(','));
});

test('minimap: 地图随玩家移动滚动（同一世界格在新位置上换了相对位置）', () => {
  const S = MINIMAP_SAMPLES, mid = (S - 1) >> 1;
  const at = (px, pz) => {
    const data = new Uint8ClampedArray(S * S * 4);
    clearMinimapContextCache();
    paintMinimap(data, px, pz, SEED, { city: null, tarns: [], snows: [] });
    return data;
  };
  // ① 移动一个步长：旧中心那一格应出现在「西侧一格」的位置（i = mid-1）
  //    玩家向东走 step 格 ⇒ 该世界格相对玩家从中间变成「西边」。
  const a = at(0, 0);
  const b = at(MINIMAP_STEP, 0);
  const pxAt = (d, i, j) => { const o = (j * S + i) * 4; return [d[o], d[o + 1], d[o + 2]]; };
  const oldCenterInNew = pxAt(b, mid - 1, mid);
  const oldCenter = pxAt(a, mid, mid);
  // 注意：抖动是世界锚定的，故这两处像素应**逐位相同**
  assertEqual(oldCenterInNew.join(','), oldCenter.join(','),
    `世界格 (0,0) 在两张图上应同色（都是 ${oldCenter}）`);
  // ② 移动足够远（> 半个跨度）后整张图必须换掉
  const far = at(MINIMAP_SPAN * 2, MINIMAP_SPAN * 2);
  assertNotEqual(pxAt(far, mid, mid).join(','), oldCenter.join(','),
    '走远之后中心像素必须变化（否则地图根本不是以玩家为中心的）');
});

// ---------------------------------------------------------------- 4. 上下文与缓存

test('minimap: 区域上下文缓存命中同值、换 region 重算（跨 tile 不漏结构）', () => {
  clearMinimapContextCache();
  const a = minimapRegionContext(SEED, 0, 0, null);
  const b = minimapRegionContext(SEED, 0, 0, null);
  assertTrue(a === b, '同一区域窗口应命中同一份上下文对象');
  const c = minimapRegionContext(SEED, 4000, 4000, null);
  assertTrue(a !== c, '不同 region 窗口不应命中同一份上下文');
  // ⚠️ **内容必须也不同** —— 只断言 `a !== c` 时，缓存键退化成常量（新算但结果不同）
  // 也能过，检测不到「本该命中/本该重算」的错。故另外拿一份能区分的结构：
  // 找一座地带，向它附近的窗口要上下文（键不同 → 重算 → 必须命中地带），
  // 再向远离它的窗口要一次（键不同 → 重算 → 必不命中）。
  const tarn = findTarn(SEED, 20);
  assertTrue(tarn !== null, '须找到一座地带');
  const near = minimapRegionContext(SEED, tarn.cx, tarn.cz, null);
  const far = minimapRegionContext(SEED, tarn.cx + 20000, tarn.cz + 20000, null);
  assertTrue(near.tarns.some((t) => t.cx === tarn.cx && t.cz === tarn.cz), '近处窗口须收录地带');
  assertFalse(far.tarns.some((t) => t.cx === tarn.cx && t.cz === tarn.cz), '远处窗口须不收录它');
  // 边界量：窗口须真的以玩家为中心
  const bounds = minimapAreaBounds(100.4, -50.6);
  assertEqual(bounds.minX, 100 - MINIMAP_SPAN / 2);
  assertEqual(bounds.maxX, 100 + MINIMAP_SPAN / 2);
  assertEqual(bounds.minZ, -51 - MINIMAP_SPAN / 2);
  assertEqual(bounds.maxZ, -51 + MINIMAP_SPAN / 2);

  // 缓存**容量**上限：超过 MAX 后必须淘汰旧项，而不是无限增长（否则瞬移/长时间游玩
  // 会持续累积上下文对象 —— 每个都含数组，是真实的泄漏）。
  clearMinimapContextCache();
  for (let k = 0; k < 20; k++) minimapRegionContext(SEED, k * 3000, 0, null);
  assertTrue(minimapContextCacheSize() <= 8, `缓存上限没生效（${minimapContextCacheSize()}）`);
});

test('minimap: 城市布局未就绪时不抛错（null 上下文 = 按 biome 画）', () => {
  const data = new Uint8ClampedArray(MINIMAP_SAMPLES * MINIMAP_SAMPLES * 4);
  clearMinimapContextCache();
  // 出生点在城市中心：没有布局时按 biome 画（不崩、不是 CITY）
  paintMinimap(data, 283, 117, SEED, minimapRegionContext(SEED, 283, 117, null));
  const S = MINIMAP_SAMPLES, mid = (S - 1) >> 1, o = (mid * S + mid) * 4;
  const kind = kindAt(283, 117, SEED, { city: null, tarns: [], snows: [] });
  const base = AREA_COLORS[kind];
  const d = ditherAt(283, 117);
  assertEqual(data[o], base[0] + d);
  assertFalse(kind === 'CITY', '没有城市布局时不得凭空判成 CITY');
});

test('minimap: 全部像素都被写入（无未初始化通道 / alpha 恒 255）', () => {
  const data = new Uint8ClampedArray(MINIMAP_SAMPLES * MINIMAP_SAMPLES * 4);
  clearMinimapContextCache();
  paintMinimap(data, -777, 888, SEED, minimapRegionContext(SEED, -777, 888, null));
  let zeros = 0;
  for (let i = 0; i < data.length; i += 4) {
    assertEqual(data[i + 3], 255, `像素 ${i / 4} 的 alpha 未写`);
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0) zeros++;
  }
  assertEqual(zeros, 0, '不应有纯黑（未初始化）像素');
});

test('minimap: kindAt 在 NaN/非整数坐标下不抛错（真实输入是浮点位置）', () => {
  // `Math.floor` 在 paintMinimap 里做，kindAt 期望整数 —— 这条钉住调用契约不会被违反
  assertTrue(typeof kindAt(0, 0, SEED, NO_CTX) === 'string');
  assertTrue(AREA_KINDS.includes(kindAt(0, 0, SEED, NO_CTX)));
  // 世界边界量级的大坐标（无边界世界，玩家可以走很远）
  assertTrue(AREA_KINDS.includes(kindAt(1_000_000, -1_000_000, SEED, NO_CTX)));
});

// ---------------------------------------------------------------- 5. 地带几何口径

test('minimap: tarnZoneCenter 与 isTarnZone 的半径口径一致（圆内才 TARN）', () => {
  const tarn = findTarn(SEED, 20);
  assertTrue(tarn !== null);
  const c = tarnZoneCenter(Math.round((tarn.cx - REGION_SIZE / 2) / REGION_SIZE),
    Math.round((tarn.cz - REGION_SIZE / 2) / REGION_SIZE));
  assertEqual(c.cx, tarn.cx, '地带中心应由 tarnZoneCenter 派生（不写字面量）');
  assertEqual(c.cz, tarn.cz);
});
