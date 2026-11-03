// src/tests/test-boss-map.js — Boss 召唤框架（v2.43）纯逻辑：地图判定 + 名册
//
// 覆盖：`bossMapAt()` 的四类地标级地图判定（CITY / TARN / SNOW / SHALLOW_TARN）与优先级、
// 「圆外不算高台地带」的门控、`bossSlotsFor()` 名册口径与「每图最多两个 Boss」的约束。
//
// ⚠️ **判据全部复用 gen 层权威**（红线 1）：不自己写一份「哪个地带 / 哪个城市」，
// 而是转调 `findAltarTarnRegion` / `getCityBoundsForSeed` / `computeShallowTarnAnchor`
// 等拿到真实坐标，再断言 `bossMapAt` 对同一坐标的分类与之吻合。
//
// 派生量一律从**冻结常量**算出而非硬编码字面量（testing-policy §2.5）。
import { test } from './runner.js';
import { assertEqual, assertNull, assertTrue } from './assert.js';
import { bossMapAt, BOSS_MAP_KINDS } from '../entities/bosses/boss-map.js';
import {
  BOSS_ROSTER, BOSS_SLOTS_PER_MAP, bossSlotsFor,
} from '../entities/bosses/boss-registry.js';
import { getCityBoundsForSeed } from '../gen/structures/city-layout.js';
import {
  findAltarTarnRegion, isTarnZone, tarnZoneCenter,
} from '../gen/structures/tarn-zone.js';
import { computeShallowTarnAnchor } from '../gen/structures/shallow-water-tarns.js';
import { getRegionSeededCenter } from '../gen/structures/region-center.js';
import {
  LANDMARK_OFFSET, SNOW_LAND_SIZE, TRANSITION_SIZE,
} from '../gen/structures/region-config.js';

const SEED = 12345;   // 默认 seed：实测四类地标级地图全部存在

// ==================== bossMapAt：四类地图 ====================

test('bossMapAt: 城市中心 → CITY，中心 = bounds 中心', () => {
  const b = getCityBoundsForSeed(SEED);
  const cx = Math.round((b.minX + b.maxX) / 2);
  const cz = Math.round((b.minZ + b.maxZ) / 2);
  const m = bossMapAt(cx, cz, SEED);
  assertEqual(m.kind, 'CITY');
  assertEqual(m.cx, cx);
  assertEqual(m.cz, cz);
  assertEqual(m.key, 'city:0:0');
});

test('bossMapAt: 高台地带中心 → TARN，中心 = 地带圆心', () => {
  const altar = findAltarTarnRegion(SEED);
  assertTrue(altar !== null, '前提：seed 12345 有祭坛地带');
  const m = bossMapAt(altar.cx, altar.cz, SEED);
  assertEqual(m.kind, 'TARN');
  assertEqual(m.cx, altar.cx);
  assertEqual(m.cz, altar.cz);
  assertEqual(m.key, `tarn:${altar.regionX}:${altar.regionZ}`);
});

test('bossMapAt: 非祭坛的高台地带也判 TARN（龙不再绑定祭坛地带）', () => {
  const altar = findAltarTarnRegion(SEED);
  let found = null;
  for (let rx = -8; rx <= 8 && !found; rx++) {
    for (let rz = -8; rz <= 8 && !found; rz++) {
      if (altar && rx === altar.regionX && rz === altar.regionZ) continue;
      if (!isTarnZone(rx, rz, SEED)) continue;
      const c = tarnZoneCenter(rx, rz);
      found = { rx, rz, ...c };
    }
  }
  assertTrue(found !== null, '前提：seed 12345 有非祭坛的高台地带');
  const m = bossMapAt(found.cx, found.cz, SEED);
  assertEqual(m.kind, 'TARN');
  assertEqual(m.key, `tarn:${found.rx}:${found.rz}`);
});

test('bossMapAt: 高台地带 region 内但圆外 → 不算（inTarnRadius 门控）', () => {
  const altar = findAltarTarnRegion(SEED);
  // ⚠️ 这条是「只看 isTarnZone(region) 不看圆」缺陷的判据：地带圆半径 138 只覆盖
  // region 的 37.4%。圆外的点必须返回 null（或别的地图），绝不能是 TARN。
  const out = bossMapAt(altar.cx + 160, altar.cz + 160, SEED);
  assertTrue(out === null || out.kind !== 'TARN',
    `圆外不得判 TARN（实测 ${JSON.stringify(out)}）`);
});

test('bossMapAt: 浅水高台湖心 → SHALLOW_TARN，中心 = 锚点', () => {
  const a = computeShallowTarnAnchor(SEED);
  assertTrue(a !== null, '前提：seed 12345 有浅水高台');
  const m = bossMapAt(a.wx, a.wz, SEED);
  assertEqual(m.kind, 'SHALLOW_TARN');
  assertEqual(m.cx, a.wx);
  assertEqual(m.cz, a.wz);
  assertEqual(m.key, 'shallowtarn:0');
});

test('bossMapAt: 雪原中心 → SNOW（扫 3×3 邻域 region 找到一座）', () => {
  let snow = null;
  for (let rx = -6; rx <= 6 && !snow; rx++) {
    for (let rz = -6; rz <= 6 && !snow; rz++) {
      const raw = getRegionSeededCenter(rx, rz, SEED);
      const cx = raw.centerX + LANDMARK_OFFSET.SNOW_LAND_X;
      const cz = raw.centerZ + LANDMARK_OFFSET.SNOW_LAND_Z;
      const m = bossMapAt(cx, cz, SEED);
      if (m && m.kind === 'SNOW') snow = { rx, rz, cx, cz, m };
    }
  }
  assertTrue(snow !== null, '前提：seed 12345 扫得到一座雪原');
  assertEqual(snow.m.cx, snow.cx);
  assertEqual(snow.m.cz, snow.cz);
  assertEqual(snow.m.key, `snow:${snow.rx}:${snow.rz}`);
});

test('bossMapAt: 不在任何地标级地图 → null', () => {
  assertNull(bossMapAt(9999, 9999, SEED));
});

test('bossMapAt: 非法输入返回 null（不抛）', () => {
  assertNull(bossMapAt(NaN, 0, SEED));
  assertNull(bossMapAt(0, Infinity, SEED));
  assertNull(bossMapAt(0, 0, NaN));
});

test('bossMapAt: 优先级 CITY > TARN（城市中心即使碰巧在别处也判 CITY）', () => {
  // 城市 bounds 与高台地带在落点判据上互斥，实际不会同时命中；这里只验证
  // BOSS_MAP_KINDS 的顺序契约（城市必须最前）没被改动。
  assertEqual(BOSS_MAP_KINDS[0], 'CITY');
  assertTrue(BOSS_MAP_KINDS.includes('TARN'));
  assertTrue(BOSS_MAP_KINDS.includes('SNOW'));
  assertTrue(BOSS_MAP_KINDS.includes('SHALLOW_TARN'));
});

// ==================== bossSlotsFor：名册 ====================

test('名册: 高台地带登记了 Boss1 = dragon（service=dragons）', () => {
  const slots = bossSlotsFor('TARN');
  assertEqual(slots.length, 1, '用户：目前高台地带只有 Boss1，没有 Boss2');
  assertEqual(slots[0].slot, 0);
  assertEqual(slots[0].type, 'dragon');
  assertEqual(slots[0].service, 'dragons');
});

test('名册: 未登记的地图返回空数组（不是 undefined / 不抛）', () => {
  assertEqual(bossSlotsFor('CITY').length, 0);
  assertEqual(bossSlotsFor('SNOW').length, 0);
  assertEqual(bossSlotsFor('SHALLOW_TARN').length, 0);
  assertEqual(bossSlotsFor('不存在的地图').length, 0);
});

test('名册: 每张地图最多 BOSS_SLOTS_PER_MAP 个 Boss（用户裁定「最多两个」）', () => {
  for (const kind of Object.keys(BOSS_ROSTER)) {
    assertTrue(BOSS_ROSTER[kind].length <= BOSS_SLOTS_PER_MAP,
      `${kind} 登记了 ${BOSS_ROSTER[kind].length} 个 Boss（超过上限 ${BOSS_SLOTS_PER_MAP}）`);
  }
  assertEqual(BOSS_SLOTS_PER_MAP, 2);
});

test('名册: 槽位 slot 下标从 0 起且互不重复（召唤按升序找第一个空槽）', () => {
  for (const kind of Object.keys(BOSS_ROSTER)) {
    const seen = new Set();
    for (const s of BOSS_ROSTER[kind]) {
      assertTrue(Number.isInteger(s.slot) && s.slot >= 0, `slot 须为非负整数（${s.slot}）`);
      assertTrue(!seen.has(s.slot), `${kind} 的 slot ${s.slot} 重复`);
      seen.add(s.slot);
    }
  }
});
