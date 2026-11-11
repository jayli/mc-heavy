// src/tests/test-boss-map.js — Boss 召唤框架（v2.43）纯逻辑：地图判定 + 名册
//
// 覆盖：`bossMapAt()` 的地标级地图判定（CITY / TARN / BURNING_ARENA / SNOW / SHALLOW_TARN）
// 与优先级、「圆外不算高台地带」的门控、「雪原盒伸进竞技场占地」的判定器顺序守卫、
// `bossSlotsFor()` 名册口径与「每图最多两个 Boss」的约束。
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
  findAltarTarnRegion, isTarnZone, tarnZoneCenter, snowLandSuppressedByTarn,
} from '../gen/structures/tarn-zone.js';
import { computeShallowTarnAnchor } from '../gen/structures/shallow-water-tarns.js';
import { getRegionSeededCenter } from '../gen/structures/region-center.js';
import {
  LANDMARK_OFFSET, SNOW_LAND_SIZE, TRANSITION_SIZE, REGION_SIZE,
} from '../gen/structures/region-config.js';
import {
  computeBurningArenaAnchor, BURNING_ARENA_HALF, BURNING_ARENA_SUMMON_FEET_DY,
} from '../gen/structures/burning-arena.js';
import {
  computeRuinedCitadelAnchor, inRuinedCitadelFootprint,
  RUINED_CITADEL_HALF_X, RUINED_CITADEL_HALF_Z,
  RUINED_CITADEL_SUMMON_FEET_DY, RUINED_CITADEL_SUMMON_DX, RUINED_CITADEL_SUMMON_DZ,
} from '../gen/structures/ruined-citadel.js';

const SEED = 12345;   // 默认 seed：实测五类地标级地图全部存在

// ==================== bossMapAt：五类地图 ====================

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
  assertTrue(BOSS_MAP_KINDS.includes('BURNING_ARENA'));
});

// ==================== bossSlotsFor：名册 ====================

test('名册: 高台地带登记了两个 Boss（slot 0 = 飞龙，slot 1 = 焰魔）', () => {
  const slots = bossSlotsFor('TARN');
  // 用户 2026-11-05：给高台地带加第二个 Boss「焰魔」
  assertEqual(slots.length, 2, '高台地带应有 Boss1(飞龙) + Boss2(焰魔)');
  // slot 0 = 飞龙（用户裁定「飞龙先，焰魔后」——召唤按 slot 升序找第一个空槽）
  assertEqual(slots[0].slot, 0);
  assertEqual(slots[0].type, 'dragon');
  assertEqual(slots[0].service, 'dragons');
  // slot 1 = 焰魔
  assertEqual(slots[1].slot, 1);
  assertEqual(slots[1].type, 'ignis');
  assertEqual(slots[1].service, 'ignises');
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

// ==================== bossMapAt：大竞技场（BURNING_ARENA）====================

test('bossMapAt: 大竞技场锚点 → BURNING_ARENA，中心 = 锚点，带强制召唤高度 summonY', () => {
  const a = computeBurningArenaAnchor(SEED);
  assertTrue(a !== null, '前提：seed 12345 必须有大竞技场（用户裁定「必须且唯一」）');
  const m = bossMapAt(a.wx, a.wz, SEED);
  assertTrue(m !== null, '锚点必须判出一张地图');
  assertEqual(m.kind, 'BURNING_ARENA');
  assertEqual(m.cx, a.wx);
  assertEqual(m.cz, a.wz);
  assertEqual(m.key, 'burningarena:0');
  // 召唤点恒在「房顶下面这一层」的中心（用户 2026-11-09 裁定：不要召到房顶上）。
  // ⚠️ 本用例只钉**接线**（boss-map 用结构层的权威常量，不自己写字面量）；
  // 常量本身对不对由 `test-burning-arena-gen.js` 从产物重算钉住（红线 1，两边不重复）。
  assertEqual(m.summonY, a.floorY + BURNING_ARENA_SUMMON_FEET_DY,
    `summonY 必须是室内顶层中心脚底（floorY=${a.floorY}）`);
});

test('bossMapAt: 大竞技场占地边缘也判 BURNING_ARENA（任意层任意位置都可召唤）', () => {
  const a = computeBurningArenaAnchor(SEED);
  assertTrue(a !== null, '前提');
  const m = bossMapAt(a.wx + BURNING_ARENA_HALF, a.wz + BURNING_ARENA_HALF, SEED);
  assertTrue(m !== null && m.kind === 'BURNING_ARENA',
    `占地边缘应判 BURNING_ARENA（实测 ${JSON.stringify(m)}）`);
});

test('bossMapAt: 大竞技场占地外一格 → 不判 BURNING_ARENA', () => {
  const a = computeBurningArenaAnchor(SEED);
  assertTrue(a !== null, '前提');
  const m = bossMapAt(a.wx + BURNING_ARENA_HALF + 1, a.wz, SEED);
  assertTrue(m === null || m.kind !== 'BURNING_ARENA',
    `占地外不得判 BURNING_ARENA（实测 ${JSON.stringify(m)}）`);
});

test('bossMapAt: 雪原盒伸进竞技场占地的重叠处 → 判 BURNING_ARENA 而非 SNOW', () => {
  // ⚠️ 这条钉住**判定器顺序**（BURNING_ARENA 必须在 SNOW 之前）。
  //
  // 雪原盒是 region 级包围盒（±28），可伸进竞技场占地（±42）—— 实测 8 seed 中
  // 1249026 / 8888 各命中一处。那座雪原已被竞技场**压制**（`burningArenaSuppressedLandmarks`
  // ⇒ 世界里根本不存在），但 `snowMapAt` 只跳 **tarn** 压制的雪原、不跳竞技场压制的
  // ⇒ 实测修复前重叠点返回 `{kind:'SNOW', cx:676, cz:347}`（一个不存在的雪原中心）。
  // 后果：玩家站在竞技场内按 B 会召到 58 格外的虚空，而不是竞技场顶层。
  //
  // ⚠️ **必须扫多个 seed**：只测 seed 12345 会因「无重叠」而空跑（假绿）。
  // ⚠️ **不得把竞技场压制的雪原过滤掉**：那正是本用例要钉的那一类（过滤了就空跑）。
  const HALF = Math.floor(SNOW_LAND_SIZE / 2) + TRANSITION_SIZE.SNOW_LAND;
  let checked = 0;
  for (const seed of [12345, 99999, 1249026, 20260101, 777, 4242, 31337, 8888]) {
    const a = computeBurningArenaAnchor(seed);
    if (!a) continue;
    const rx0 = Math.floor((a.wx - BURNING_ARENA_HALF) / REGION_SIZE) - 1;
    const rx1 = Math.floor((a.wx + BURNING_ARENA_HALF) / REGION_SIZE) + 1;
    const rz0 = Math.floor((a.wz - BURNING_ARENA_HALF) / REGION_SIZE) - 1;
    const rz1 = Math.floor((a.wz + BURNING_ARENA_HALF) / REGION_SIZE) + 1;
    for (let rx = rx0; rx <= rx1; rx++) {
      for (let rz = rz0; rz <= rz1; rz++) {
        if (snowLandSuppressedByTarn(rx, rz, seed)) continue;
        const raw = getRegionSeededCenter(rx, rz, seed);
        const cx = raw.centerX + LANDMARK_OFFSET.SNOW_LAND_X;
        const cz = raw.centerZ + LANDMARK_OFFSET.SNOW_LAND_Z;
        const x0 = Math.max(a.wx - BURNING_ARENA_HALF, cx - HALF);
        const x1 = Math.min(a.wx + BURNING_ARENA_HALF, cx + HALF);
        const z0 = Math.max(a.wz - BURNING_ARENA_HALF, cz - HALF);
        const z1 = Math.min(a.wz + BURNING_ARENA_HALF, cz + HALF);
        if (x0 > x1 || z0 > z1) continue;
        checked++;
        const m = bossMapAt(x0, z0, seed);
        assertTrue(m !== null && m.kind === 'BURNING_ARENA',
          `seed ${seed} 重叠点 (${x0},${z0}) 应判 BURNING_ARENA 而非 ${JSON.stringify(m)}`);
      }
    }
  }
  assertTrue(checked > 0, '前提：8 个 seed 里至少有一个「雪原盒 ∩ 竞技场占地」的重叠点');
});

test('名册: 大竞技场登记了唯一 Boss（slot 0 = 焰魔）', () => {
  const slots = bossSlotsFor('BURNING_ARENA');
  assertEqual(slots.length, 1, '大竞技场只有焰魔一个 Boss');
  assertEqual(slots[0].slot, 0);
  assertEqual(slots[0].type, 'ignis');
  assertEqual(slots[0].service, 'ignises');
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

// ==================== 废弃堡垒（末影守卫，本次新增）====================

test('bossMapAt: 堡垒锚点内 → RUINED_CITADEL，落点 = 上层房间', () => {
  const a = computeRuinedCitadelAnchor(SEED);
  assertTrue(a !== null, `seed ${SEED} 应有堡垒锚点`);
  const m = bossMapAt(a.wx, a.wz, SEED);
  assertTrue(m !== null && m.kind === 'RUINED_CITADEL',
    `锚点应判 RUINED_CITADEL，实际 ${JSON.stringify(m)}`);
  assertEqual(m.key, 'ruinedcitadel:0');
  // ⚠️ cx/cz 是**落点**而不是锚点中心（summon 直接拿它当落点列）
  assertEqual(m.cx, a.wx + RUINED_CITADEL_SUMMON_DX, 'cx = 锚点 + DX');
  assertEqual(m.cz, a.wz + RUINED_CITADEL_SUMMON_DZ, 'cz = 锚点 + DZ');
  assertEqual(m.summonY, a.floorY + RUINED_CITADEL_SUMMON_FEET_DY, 'summonY = floorY − 6（上层房间）');
});

test('bossMapAt: 堡垒占地四缘也判 RUINED_CITADEL（任意层任意位置都可召唤）', () => {
  const a = computeRuinedCitadelAnchor(SEED);
  for (const [dx, dz] of [
    [RUINED_CITADEL_HALF_X, 0], [-RUINED_CITADEL_HALF_X, 0],
    [0, RUINED_CITADEL_HALF_Z], [0, -RUINED_CITADEL_HALF_Z],
  ]) {
    const m = bossMapAt(a.wx + dx, a.wz + dz, SEED);
    assertTrue(m !== null && m.kind === 'RUINED_CITADEL',
      `缘 (${dx},${dz}) 应命中，实际 ${JSON.stringify(m)}`);
  }
});

test('bossMapAt: 堡垒占地外一格 → 不判 RUINED_CITADEL', () => {
  const a = computeRuinedCitadelAnchor(SEED);
  for (const [dx, dz] of [
    [RUINED_CITADEL_HALF_X + 1, 0], [-RUINED_CITADEL_HALF_X - 1, 0],
    [0, RUINED_CITADEL_HALF_Z + 1], [0, -RUINED_CITADEL_HALF_Z - 1],
  ]) {
    const m = bossMapAt(a.wx + dx, a.wz + dz, SEED);
    assertTrue(m === null || m.kind !== 'RUINED_CITADEL',
      `外一格 (${dx},${dz}) 不得判 RUINED_CITADEL，实际 ${JSON.stringify(m)}`);
  }
});

test('bossMapAt: 雪原盒伸进堡垒占地的重叠处 → 判 RUINED_CITADEL 而非 SNOW', () => {
  // ⚠️ 这条钉住**判定器顺序**（RUINED_CITADEL 必须在 SNOW 之前）。
  //
  // 雪原盒是 region 级包围盒（±28），可伸进堡垒占地（±53/54）；那座雪原已被堡垒**压制**
  // （世界里根本不存在），但 `snowMapAt` 只跳 **tarn** 压制的雪原 ⇒ 顺序反了会把堡垒内的点
  // 误判成 SNOW，按 B 召到几十格外的虚空。
  //
  // ⚠️⚠️ **seed 清单不得照搬大竞技场那八个**（实测：12345/99999/1249026/20260101/
  // 777/4242/31337/8888 在堡垒上**零重叠** —— 最近雪原中心到占地净距 64~98 格，远超盒半宽 28）
  // ⇒ 照搬会让下面的 `checked > 0` 直接 FAIL（真红，不是假绿）。
  // 下面五个 seed 已实测有重叠，其中 2096/4151 那座雪原**世界里根本不存在**（正是要钉的那一类）。
  const HALF = Math.floor(SNOW_LAND_SIZE / 2) + TRANSITION_SIZE.SNOW_LAND;
  let checked = 0;
  for (const seed of [2096, 2644, 3740, 4151, 4973]) {
    const a = computeRuinedCitadelAnchor(seed);
    if (!a) continue;
    const rx0 = Math.floor((a.wx - RUINED_CITADEL_HALF_X) / REGION_SIZE) - 1;
    const rx1 = Math.floor((a.wx + RUINED_CITADEL_HALF_X) / REGION_SIZE) + 1;
    const rz0 = Math.floor((a.wz - RUINED_CITADEL_HALF_Z) / REGION_SIZE) - 1;
    const rz1 = Math.floor((a.wz + RUINED_CITADEL_HALF_Z) / REGION_SIZE) + 1;
    for (let rx = rx0; rx <= rx1; rx++) {
      for (let rz = rz0; rz <= rz1; rz++) {
        // ⚠️ 不得过滤「被堡垒压制的雪原」：那正是本用例要钉的那一类
        if (snowLandSuppressedByTarn(rx, rz, seed)) continue;
        const raw = getRegionSeededCenter(rx, rz, seed);
        const cx = raw.centerX + LANDMARK_OFFSET.SNOW_LAND_X;
        const cz = raw.centerZ + LANDMARK_OFFSET.SNOW_LAND_Z;
        const x0 = Math.max(a.wx - RUINED_CITADEL_HALF_X, cx - HALF);
        const x1 = Math.min(a.wx + RUINED_CITADEL_HALF_X, cx + HALF);
        const z0 = Math.max(a.wz - RUINED_CITADEL_HALF_Z, cz - HALF);
        const z1 = Math.min(a.wz + RUINED_CITADEL_HALF_Z, cz + HALF);
        if (x0 > x1 || z0 > z1) continue;
        checked++;
        const m = bossMapAt(x0, z0, seed);
        assertTrue(m !== null && m.kind === 'RUINED_CITADEL',
          `seed ${seed} 重叠点 (${x0},${z0}) 应判 RUINED_CITADEL 而非 ${JSON.stringify(m)}`);
      }
    }
  }
  assertTrue(checked > 0, '前提：五个 seed 里至少有一个「雪原盒 ∩ 堡垒占地」的重叠点');
});

test('bossMapAt: RUINED_CITADEL 在 BOSS_MAP_KINDS 里且优先级在 SNOW 之前', () => {
  assertTrue(BOSS_MAP_KINDS.includes('RUINED_CITADEL'), ' kinds 应含 RUINED_CITADEL');
  assertTrue(BOSS_MAP_KINDS.indexOf('RUINED_CITADEL') < BOSS_MAP_KINDS.indexOf('SNOW'),
    '顺序即优先级：必须在 SNOW 之前');
  assertTrue(BOSS_MAP_KINDS.indexOf('BURNING_ARENA') < BOSS_MAP_KINDS.indexOf('RUINED_CITADEL'),
    '大竞技场在堡垒之前（城东/城西不重叠，但顺序表要与判据表一致）');
});

test('名册: 废弃堡垒登记了唯一 Boss（slot 0 = 末影守卫）', () => {
  const slots = bossSlotsFor('RUINED_CITADEL');
  assertEqual(slots.length, 1, '堡垒只有守卫一个 Boss');
  assertEqual(slots[0].slot, 0, 'slot 0（toast「已召唤 Boss1」）');
  assertEqual(slots[0].type, 'guardian');
  assertEqual(slots[0].service, 'guardians');
});

test('bossMapAt: 堡垒落点与占地判据同源（inRuinedCitadelFootprint 一致性）', () => {
  const a = computeRuinedCitadelAnchor(SEED);
  // 判定器必须复用 gen 层的占地权威，不自己写一份 AABB
  for (const [dx, dz] of [[0, 0], [RUINED_CITADEL_HALF_X, RUINED_CITADEL_HALF_Z]]) {
    const wx = a.wx + dx, wz = a.wz + dz;
    const inFoot = inRuinedCitadelFootprint(wx, wz, [a]);
    const m = bossMapAt(wx, wz, SEED);
    assertEqual(m !== null && m.kind === 'RUINED_CITADEL', inFoot,
      `(${dx},${dz}) 判定器与 inRuinedCitadelFootprint 必须一致`);
  }
});
