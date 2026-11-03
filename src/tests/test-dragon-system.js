// src/tests/test-dragon-system.js — 祭坛飞龙（v2.41）纯逻辑：轨道 / 动画状态机 / AABB / definition / service
//
// 覆盖（spec §5、§6）：轨道确定性与半径高度有界、yaw 是切线方向、salt 不撞车、
// AABB 随 yaw 旋转、命中判据在临界距离附近区分、动画状态机 fly/glide 交替与周期闭合、
// definition 返回全新 state（M5 不变式）、DragonService 的 spawn 编排 / damage / 死亡标记。
//
// 派生量一律从**冻结常量**算出而非硬编码字面量（testing-policy §2.5）。
import { test } from './runner.js';
import {
  assertEqual, assertFalse, assertNull, assertTrue, assertDeepEqual,
} from './assert.js';
import { EntityManager } from '../entities/entity-manager.js';
import { columnKeyAt } from '../voxel/constants.js';
import { findAltarTarnRegion, TARN_PLATEAU_Y } from '../gen/structures/tarn-zone.js';
import {
  DRAGON, DRAGON_TYPE, DRAGON_ORBIT_SALT, DRAGON_CORE_OBB, DRAGON_ANIM,
} from '../entities/dragons/dragon-config.js';
import {
  dragonPoseAt, dragonAnimStateAt, dragonAabbFor, dragonDefinition, DragonService,
} from '../entities/dragons/dragon-system.js';

/** 舍入到 1e-6：抵消 IEEE754 累加噪声 */
function round6(v) { return Math.round(v * 1e6) / 1e6; }

const ORBIT = Object.freeze({
  cx: 100, cz: -50, y: TARN_PLATEAU_Y + DRAGON.orbitYOffset,
  radius: DRAGON.orbitRadius, omega: DRAGON.orbitSpeed / DRAGON.orbitRadius, phase: 0.7,
});

// ==================== 轨道纯函数 ====================

test('龙轨道: 确定性（同参同果，逐位）', () => {
  assertDeepEqual(dragonPoseAt(ORBIT, 3.5), dragonPoseAt(ORBIT, 3.5));
});

test('龙轨道: 半径与高度有界', () => {
  for (let t = 0; t < 60; t += 0.37) {
    const p = dragonPoseAt(ORBIT, t).position;
    const r = Math.hypot(p[0] - ORBIT.cx, p[2] - ORBIT.cz);
    assertTrue(Math.abs(r - DRAGON.orbitRadius) < 1e-9, `t=${t} 半径 ${r}`);
    assertTrue(Math.abs(p[1] - ORBIT.y) <= DRAGON.bobAmplitude + 1e-9, `t=${t} y 越界 ${p[1]}`);
  }
});

test('龙轨道: bob 真的在动（不是恒等高度）', () => {
  const ys = new Set();
  for (let t = 0; t < DRAGON.bobPeriod; t += 0.11) ys.add(round6(dragonPoseAt(ORBIT, t).position[1]));
  assertTrue(ys.size > 20, `bob 只有 ${ys.size} 个不同 y 值（疑似恒等）`);
  // 峰值应达到振幅
  const arr = [...ys];
  assertTrue(Math.max(...arr) > ORBIT.y + DRAGON.bobAmplitude * 0.9, 'bob 峰值未达振幅');
  assertTrue(Math.min(...arr) < ORBIT.y - DRAGON.bobAmplitude * 0.9, 'bob 谷值未达振幅');
});

test('龙轨道: yaw 是切线方向（头朝 −Z 的模型沿轨道前进）', () => {
  // 判据：yaw 对应的「前向」(sin(−yaw), −cos(yaw)) 必须与轨道切线同向（点积 > 0.99）。
  // 前向公式取自 player.js 的 `camera.rotateY(yaw)` 口径（AGENTS.md「出生朝向与相机旋转的测量口径」表）。
  for (const t of [0, 1.3, 4.7, 12.9]) {
    const { yaw } = dragonPoseAt(ORBIT, t);
    const eps = 1e-5;
    const a = dragonPoseAt(ORBIT, t).position;
    const b = dragonPoseAt(ORBIT, t + eps).position;
    const tx = b[0] - a[0], tz = b[2] - a[2];
    const len = Math.hypot(tx, tz);
    const fx = Math.sin(-yaw), fz = -Math.cos(yaw);
    const dot = (fx * tx + fz * tz) / len;
    assertTrue(dot > 0.99, `t=${t} 前向与切线点积 ${dot}（yaw 符号或 π/2 偏移错）`);
  }
});

test('龙轨道: salt 1040 不与既有占用撞车', () => {
  // 既有占用（程序化扫描实测，spec §6.1）：1020~1027、1029~1039
  const taken = new Set([
    1020, 1021, 1022, 1023, 1024, 1025, 1026, 1027,
    1029, 1030, 1031, 1032, 1033, 1034, 1035, 1036, 1037, 1038, 1039,
  ]);
  assertTrue(!taken.has(DRAGON_ORBIT_SALT), `salt ${DRAGON_ORBIT_SALT} 已被占用`);
  assertEqual(DRAGON_ORBIT_SALT, 1040);
});

// ==================== AABB ====================

function sizeOf(box) { return [0, 1, 2].map((a) => round6(box.max[a] - box.min[a])); }

test('龙 AABB: yaw=0 时是「宽 2.25 × 高 3.75 × 长 9.5625」的盒', () => {
  const box = dragonAabbFor({ position: [10, 30, 20], yaw: 0 });
  const [sx, sy, sz] = sizeOf(box);
  const h = DRAGON_CORE_OBB.halfExtents;
  assertEqual(sx, round6(2 * h[0]));
  assertEqual(sy, round6(2 * h[1]));
  assertEqual(sz, round6(2 * h[2]));
});

test('龙 AABB: yaw=π/2 时长轴转到 x（旋转盒真的在转）', () => {
  const box = dragonAabbFor({ position: [10, 30, 20], yaw: Math.PI / 2 });
  const [sx, sy, sz] = sizeOf(box);
  const h = DRAGON_CORE_OBB.halfExtents;
  assertEqual(sx, round6(2 * h[2]), '长轴应在 x');
  assertEqual(sz, round6(2 * h[0]), '宽轴应在 z');
  assertEqual(sy, round6(2 * h[1]), '高不受 yaw 影响');
});

test('龙 AABB: 斜角 yaw 时包围盒变大（旋转的必然结果，不是缺陷）', () => {
  const h = DRAGON_CORE_OBB.halfExtents;
  const box = dragonAabbFor({ position: [0, 30, 0], yaw: Math.PI / 4 });
  const [sx, , sz] = sizeOf(box);
  // 45° 时 x/z 跨度 = (长+宽) × cos45 ≈ (9.5625+2.25)/√2
  const expect = (2 * h[2] + 2 * h[0]) / Math.SQRT2;
  assertTrue(Math.abs(sx - expect) < 1e-6, `x 跨度 ${sx} ≠ ${expect}`);
  assertTrue(Math.abs(sz - expect) < 1e-6, `z 跨度 ${sz} ≠ ${expect}`);
});

test('龙 AABB: 命中判据在临界距离附近区分（远离阈值的输入测不出旋转错误）', () => {
  const st = { position: [0, 30, 0], yaw: 0 };
  const origin = [0, 30, -20], dir = [0, 0, 1];
  // yaw=0 → 长轴在 z；盒的 −Z 端 = center.z − halfExtents.z = −2.53125 − 4.78125 = −7.3125
  const edge = DRAGON_CORE_OBB.center[2] - DRAGON_CORE_OBB.halfExtents[2];   // = −4.78125（center 为 0）
  const distToEdge = edge - origin[2];   // 从 origin(z=−20) 到盒近端的距离 = 12.6875
  const hitIn = dragonDefinition.raycastAabb(st, origin, dir, distToEdge + 0.01);
  const hitOut = dragonDefinition.raycastAabb(st, origin, dir, distToEdge - 0.01);
  assertTrue(hitIn !== null, `临界内侧（maxDist=${distToEdge + 0.01}）应命中`);
  assertNull(hitOut, `临界外侧（maxDist=${distToEdge - 0.01}）应脱靶`);
});

test('龙 AABB: yaw=π/2 时同一射线的临界距离随之改变（旋转参与命中判定）', () => {
  const origin = [0, 30, -20], dir = [0, 0, 1];
  // yaw=π/2 → 长轴转到 x，z 方向只剩「宽」半轴 1.125 + center.z 旋转后的贡献
  const st = { position: [0, 30, 0], yaw: Math.PI / 2 };
  const box = dragonAabbFor(st);
  const distToEdge = box.min[2] - origin[2];   // 世界 z 近端 − 起点 z（box 是局部盒，position[2]=0）
  assertTrue(dragonDefinition.raycastAabb(st, origin, dir, distToEdge + 0.01) !== null);
  assertNull(dragonDefinition.raycastAabb(st, origin, dir, distToEdge - 0.01));
  // 且与 yaw=0 的临界距离不同（否则说明旋转没参与）
  const box0 = dragonAabbFor({ position: [0, 30, 0], yaw: 0 });
  assertTrue(Math.abs(box.min[2] - box0.min[2]) > 1, 'yaw 改变后 z 近端应明显不同');
});

// ==================== 动画状态机 ====================

test('龙动画状态机: fly/glide 交替且周期闭合', () => {
  const A = DRAGON_ANIM;
  assertEqual(dragonAnimStateAt(0).primary, 'fly');
  assertEqual(dragonAnimStateAt(0).blend, 0);
  assertNull(dragonAnimStateAt(0).secondary);
  // fly 段末尾进入淡入（primary=fly, secondary=glide）
  const s1 = dragonAnimStateAt(A.flySeconds + A.blendSeconds / 2);
  assertEqual(s1.primary, 'fly');
  assertEqual(s1.secondary, 'glide');
  assertTrue(s1.blend > 0 && s1.blend < 1, `淡入期 blend=${s1.blend}`);
  // glide 段中期：纯 glide
  const s2 = dragonAnimStateAt(A.flySeconds + A.blendSeconds + A.glideSeconds / 2);
  assertEqual(s2.primary, 'glide');
  assertEqual(s2.blend, 0);
  assertNull(s2.secondary);
  // 淡出期（primary=glide, secondary=fly）
  const s3 = dragonAnimStateAt(A.cycleSeconds - A.blendSeconds / 2);
  assertEqual(s3.primary, 'glide');
  assertEqual(s3.secondary, 'fly');
  assertTrue(s3.blend > 0 && s3.blend < 1, `淡出期 blend=${s3.blend}`);
  // 周期末回到起点（12s ≡ 0s）
  assertDeepEqual(dragonAnimStateAt(A.cycleSeconds), dragonAnimStateAt(0));
  assertDeepEqual(dragonAnimStateAt(A.cycleSeconds * 3 + 1.5), dragonAnimStateAt(1.5));
});

test('龙动画状态机: 段边界连续（blend 从 0 单调升到接近 1）', () => {
  const A = DRAGON_ANIM;
  const N = 20;
  let prev = -1;
  // ⚠️ 只遍历 [flySeconds, flySeconds+blendSeconds) —— 端点 t=4.4 已属 glide 段（blend 归 0），
  // 含端点会让「单调」断言假失败（那是段切换的正确行为，不是缺陷）。
  for (let i = 0; i < N; i++) {
    const t = A.flySeconds + (A.blendSeconds * i) / N;
    const s = dragonAnimStateAt(t);
    assertEqual(s.primary, 'fly');
    assertEqual(s.secondary, 'glide');
    assertTrue(s.blend >= prev - 1e-12, `blend 非单调：${prev} → ${s.blend}`);
    prev = s.blend;
  }
  assertTrue(prev > 0.9 && prev < 1, `淡入末 blend=${prev} 应接近 1（不含端点）`);
  // 端点属于下一段
  assertEqual(dragonAnimStateAt(A.flySeconds + A.blendSeconds).primary, 'glide');
  assertEqual(dragonAnimStateAt(A.flySeconds + A.blendSeconds).blend, 0);
});

test('龙动画状态机: primaryTime/secondaryTime 非负且动画名合法', () => {
  const A = DRAGON_ANIM;
  const names = new Set(['fly', 'glide']);
  for (let t = 0; t < A.cycleSeconds; t += 0.13) {
    const s = dragonAnimStateAt(t);
    assertTrue(names.has(s.primary), `primary=${s.primary}`);
    assertTrue(s.primaryTime >= 0, `t=${t} primaryTime=${s.primaryTime} 为负`);
    assertTrue(s.primaryTime < A.cycleSeconds + 1e-9, `t=${t} primaryTime 越界`);
    if (s.secondary !== null) {
      assertTrue(names.has(s.secondary), `secondary=${s.secondary}`);
      assertTrue(s.secondaryTime >= 0, `t=${t} secondaryTime=${s.secondaryTime} 为负`);
    }
  }
});

// ==================== definition ====================

function makeState(over = {}) {
  return dragonDefinition.create({
    position: [0, 30, 0], yaw: 0, orbit: ORBIT, orbitT: 0,
    health: DRAGON.health, flashedUntil: 0, ...over,
  });
}

test('龙 definition: create 校验并归一化', () => {
  const st = makeState();
  assertEqual(st.health, DRAGON.health);
  assertEqual(st.orbitT, 0);
  assertEqual(st.flashedUntil, 0);
  assertDeepEqual(st.position, [0, 30, 0]);
  // 非法 position
  assertNull(dragonDefinition.create({ position: [NaN, 0, 0], orbit: ORBIT }));
  assertNull(dragonDefinition.create({ position: [0, 0], orbit: ORBIT }));
  assertNull(dragonDefinition.create({ position: [0, 0, 0] }));   // 缺 orbit
  // 非法 orbit
  assertNull(dragonDefinition.create({ position: [0, 0, 0], orbit: { ...ORBIT, cx: NaN } }));
});

test('龙 definition: update 返回全新 state（M5 不变式，不可原地改写）', () => {
  const st = makeState();
  const before = { pos: [...st.position], t: st.orbitT, yaw: st.yaw };
  const next = dragonDefinition.update({ state: st }, 1 / 60, {});
  assertTrue(next !== st, '必须返回新对象');
  assertTrue(next.position !== st.position, 'position 数组也必须是新的');
  assertEqual(st.orbitT, before.t, '原 state 不得被改写');
  assertDeepEqual(st.position, before.pos, '原 position 不得被改写');
  assertTrue(next.orbitT > before.t, 'orbitT 应推进');
  // 位置应等于纯函数在该 orbitT 的结果（definition 不另写一份轨道公式）
  const expect = dragonPoseAt(ORBIT, next.orbitT);
  assertDeepEqual(next.position.map(round6), expect.position.map(round6));
  assertEqual(round6(next.yaw), round6(expect.yaw));
});

test('龙 definition: update 不读 context（龙不与方块交互）', () => {
  const st = makeState();
  const a = dragonDefinition.update({ state: st }, 1 / 60, undefined);
  const b = dragonDefinition.update({ state: st }, 1 / 60, { world: null });
  assertDeepEqual(a, b);
});

test('龙 definition: serialize/deserialize 往返', () => {
  const st = makeState({ orbitT: 3.5, health: 123 });
  const raw = dragonDefinition.serialize(st);
  const back = dragonDefinition.deserialize(raw);
  assertEqual(back.orbitT, 3.5);
  assertEqual(back.health, 123);
  assertDeepEqual(back.position.map(round6), st.position.map(round6));
  assertNull(dragonDefinition.deserialize(null));
  assertNull(dragonDefinition.deserialize({ position: [NaN, 0, 0] }));
});

test('龙 definition: raycastAabb 走 definition 自己的 AABB（不是 PROBE_AABB）', () => {
  const st = makeState({ position: [0, 30, 0], yaw: 0 });
  // 沿 +Z 从远处射来：核心盒长 9.5625，远大于 probe 的 0.6 → 命中距离应体现核心盒
  const t = dragonDefinition.raycastAabb(st, [0, 30, -20], [0, 0, 1], 40);
  const box = dragonAabbFor(st);
  // 射线从 z=−20 沿 +Z，命中盒近端 → t = 近端 z − 起点 z
  assertTrue(t !== null, '应命中');
  assertEqual(round6(t), round6(box.min[2] - -20));
  // 且远大于 probe 盒（0.6 宽）能给出的距离 → 证明用的是核心盒而不是 PROBE_AABB
  assertTrue(t > 10, `t=${t} 太小（疑似用了 PROBE_AABB 而不是核心盒）`);
});

// ==================== DragonService ====================

/** fake persistence：必须建模真实对象的副作用（AGENTS.md：形状对了副作用没建模照样是盲区） */
function fakePersistence(initialMeta = {}) {
  const store = { meta: { ...initialMeta }, calls: [] };
  return {
    store,
    saveMeta(obj) { store.meta = { ...obj, key: 'main' }; return Promise.resolve(); },
    // 真实 saveDragonDead 是 merge 写：这里照抄语义，才能拓到「整行覆盖抹掉 seed」的缺陷
    saveDragonDead(dead) {
      store.calls.push(dead);
      store.meta = { ...store.meta, dragonDead: dead, key: 'main' };
      return Promise.resolve();
    },
  };
}
function fakeWorld(readyKeys = []) {
  const keys = new Set(readyKeys);
  // hasColumn 收的是 column 坐标（与 WorldData.hasColumn 同口径）→ 还原成 column key 比对
  return { hasColumn: (cx, cz) => keys.has(columnKeyAt(cx * 16, cz * 16)) };
}
/** 祭坛地带中心所在的 column key（多处用例共用；columnKeyAt 是唯一权威） */
function altarColumnKey(seed) {
  const a = findAltarTarnRegion(seed);
  return a ? columnKeyAt(a.cx, a.cz) : null;
}
/** 找一个真有/没有祭坛地带的 seed（复用 gen 层权威，不自己写判据） */
function findSeedWithAltar(want) {
  for (let s = 1; s < 200; s++) if ((findAltarTarnRegion(s) !== null) === want) return s;
  return null;
}
function makeService({ seed, persistence = fakePersistence(), ready = null, findAltar } = {}) {
  const em = new EntityManager();
  em.registerType(DRAGON_TYPE, dragonDefinition);
  const world = ready === null ? { hasColumn: () => true } : fakeWorld(ready);
  const svc = new DragonService({ entities: em, persistence, seed, world, ...(findAltar ? { findAltar } : {}) });
  return { em, svc, persistence };
}

test('龙 service: 无祭坛地带时永不 spawn', () => {
  // ⚠️ **实测 seed 1..500 的 findAltarTarnRegion 全部非 null**（findNearestTarnZone 扫
  // 33×33 region × 1/5 概率 → 落空概率 ≈ (4/5)^1089 ≈ 0）⇒ 「无地带的 seed」现实中不存在。
  // 故注入 findAltar 返回 null 来测这条路径（生产不传，走默认权威）。
  const { em, svc } = makeService({ seed: 1, findAltar: () => null });
  // ⚠️ column 门控恒真，否则这条拓不到「地带缺失」而只拓到「column 未就绪」
  for (let i = 0; i < 5; i++) svc.ensure();
  assertEqual(svc.active(), null);
  assertEqual(em.count(DRAGON_TYPE), 0);
});

test('龙 service: 祭坛地带 column 就绪后 spawn 一条，位置在轨道上', () => {
  const seed = findSeedWithAltar(true);
  const altar = findAltarTarnRegion(seed);
  const { em, svc } = makeService({ seed, ready: [altarColumnKey(seed)] });
  svc.ensure();
  const e = svc.active();
  assertTrue(e !== null, '应 spawn 一条龙');
  assertEqual(e.type, DRAGON_TYPE);
  assertEqual(em.count(DRAGON_TYPE), 1);
  assertEqual(e.persistent, false, '龙必须是临时实体（位置不进存档，红线 2）');
  // 位置在轨道上：水平距祭坛中心 = orbitRadius，y 在 bob 带内
  const r = Math.hypot(e.state.position[0] - altar.cx, e.state.position[2] - altar.cz);
  assertTrue(Math.abs(r - DRAGON.orbitRadius) < 1e-6, `轨道半径 ${r}`);
  const y = e.state.position[1];
  const yMid = TARN_PLATEAU_Y + DRAGON.orbitYOffset;
  assertTrue(Math.abs(y - yMid) <= DRAGON.bobAmplitude + 1e-9, `y=${y} 不在 ${yMid}±${DRAGON.bobAmplitude}`);
  assertEqual(e.state.health, DRAGON.health);
  // 幂等：再 ensure 不会多 spawn
  svc.ensure(); svc.ensure();
  assertEqual(em.count(DRAGON_TYPE), 1);
});

test('龙 service: 轨道中心 = 祭坛地带中心（与「高台」按钮同源）', () => {
  const seed = findSeedWithAltar(true);
  const altar = findAltarTarnRegion(seed);
  const { svc } = makeService({ seed });
  svc.ensure();
  const orbit = svc.active().state.orbit;
  assertEqual(orbit.cx, altar.cx);
  assertEqual(orbit.cz, altar.cz);
  assertEqual(orbit.y, TARN_PLATEAU_Y + DRAGON.orbitYOffset);
  assertEqual(orbit.radius, DRAGON.orbitRadius);
  assertEqual(round6(orbit.omega), round6(DRAGON.orbitSpeed / DRAGON.orbitRadius));
  // phase ∈ [0, 2π)
  assertTrue(orbit.phase >= 0 && orbit.phase < Math.PI * 2, `phase=${orbit.phase}`);
});

test('龙 service: phase 是 seed 的纯函数（同 seed 同 phase，不同 seed 一般不同）', () => {
  const seed = findSeedWithAltar(true);
  const a = makeService({ seed }); a.svc.ensure();
  const b = makeService({ seed }); b.svc.ensure();
  assertEqual(a.svc.active().state.orbit.phase, b.svc.active().state.orbit.phase);
  // 不同 seed 的 phase 应有差异（否则说明 salt 没进随机流）
  const others = [];
  for (let s = seed + 1; s < seed + 40 && others.length < 5; s++) {
    if (findAltarTarnRegion(s) !== null) {
      const m = makeService({ seed: s }); m.svc.ensure();
      if (m.svc.active()) others.push(m.svc.active().state.orbit.phase);
    }
  }
  assertTrue(others.length >= 3, `只找到 ${others.length} 个有祭坛地带的 seed`);
  assertTrue(new Set(others.map(round6)).size === others.length, 'phase 在不同 seed 下重复（salt 未生效）');
});

test('龙 service: column 未就绪时不 spawn（就绪后才 spawn）', () => {
  const seed = findSeedWithAltar(true);
  const em = new EntityManager();
  em.registerType(DRAGON_TYPE, dragonDefinition);
  const w = fakeWorld([]);
  const svc = new DragonService({ entities: em, persistence: fakePersistence(), seed, world: w });
  svc.ensure();
  assertEqual(svc.active(), null, '未就绪不得 spawn');
  assertEqual(em.count(DRAGON_TYPE), 0);
  // 就绪后 spawn
  w.hasColumn = () => true;
  svc.ensure();
  assertTrue(svc.active() !== null, '就绪后应 spawn');
});

test('龙 service: 被 column 卸载回收后自动重生（位置由纯函数重算）', () => {
  const seed = findSeedWithAltar(true);
  const altar = findAltarTarnRegion(seed);
  const { em, svc } = makeService({ seed, ready: [altarColumnKey(seed)] });
  svc.ensure();
  const first = svc.active().state.position.slice();
  // 模拟玩家走远 → column 卸载回收临时实体
  em.despawnColumn(columnKeyAt(first[0], first[2]), 'column-unloaded');
  assertEqual(svc.active(), null, '回收后应无实体');
  assertEqual(svc.isDead(), false, '回收不等于死亡');
  svc.ensure();
  const second = svc.active();
  assertTrue(second !== null, '应重生（Review Focus 第 4 条）');
  const r = Math.hypot(second.state.position[0] - altar.cx, second.state.position[2] - altar.cz);
  assertTrue(Math.abs(r - DRAGON.orbitRadius) < 1e-6, `重生后轨道半径 ${r}`);
  assertEqual(second.state.health, DRAGON.health, '重生后满血（已知取舍，spec §5.2）');
});

test('龙 service: damage 精确扣血 + 红闪时间戳（performance.now 口径）', () => {
  const seed = findSeedWithAltar(true);
  const { svc } = makeService({ seed, ready: [altarColumnKey(seed)] });
  svc.ensure();
  const id = svc.active().id;
  const now = 12345.6;   // performance.now() 量级（不是 Date.now() 的 1.7e12）
  const r = svc.damage(id, 100, now);
  assertEqual(r.dead, false);
  assertEqual(r.health, DRAGON.health - 100);
  assertEqual(svc.active().state.flashedUntil, now + DRAGON.flashMs);
  assertEqual(svc.active().state.health, DRAGON.health - 100);
});

test('龙 service: 临界伤害序列（恰好打满血量致死，少一发不死）', () => {
  const seed = findSeedWithAltar(true);
  const { em, svc } = makeService({ seed, ready: [altarColumnKey(seed)] });
  svc.ensure();
  const id = svc.active().id;
  const now = 1000;
  // ⚠️ 发数从**冻结常量派生**（testing-policy §2.5），不硬编码 —— 血量改了自动跟上。
  // 每发 100 伤害 → 致死发数 = ceil(health/100)。临界断言 = 少一发不死、最后一发恰好越界。
  const dmg = 100;
  const shotsToKill = Math.ceil(DRAGON.health / dmg);
  for (let i = 0; i < shotsToKill - 1; i++) {
    const r = svc.damage(id, dmg, now + i);
    assertEqual(r.dead, false, `第 ${i + 1} 发不得判死`);
  }
  assertEqual(svc.active().state.health, DRAGON.health - dmg * (shotsToKill - 1));
  assertFalse(svc.isDead(), '少一发不得判死');
  const dead = svc.damage(id, dmg, now + shotsToKill);
  assertEqual(dead.dead, true);
  assertTrue(dead.health <= 0, `最后一发须越界（health=${dead.health}）`);
  assertEqual(svc.active(), null, '死亡后实体应消失');
  assertEqual(em.count(DRAGON_TYPE), 0);
  assertEqual(svc.isDead(), true);
});

test('龙 service: 死亡后 ensure 不再 spawn（永久死亡）', () => {
  const seed = findSeedWithAltar(true);
  const { em, svc } = makeService({ seed, ready: [altarColumnKey(seed)] });
  svc.ensure();
  svc.damage(svc.active().id, 9999, 500);
  assertEqual(svc.isDead(), true);
  for (let i = 0; i < 5; i++) svc.ensure();
  assertEqual(svc.active(), null);
  assertEqual(em.count(DRAGON_TYPE), 0);
});

test('龙 service: hydrate 从 meta 恢复死亡标记', () => {
  const seed = findSeedWithAltar(true);
  const { em, svc } = makeService({ seed, ready: [altarColumnKey(seed)] });
  svc.hydrate({ dragonDead: true, seed: 999, spawn: [1, 2, 3] });
  assertEqual(svc.isDead(), true);
  svc.ensure();
  assertEqual(svc.active(), null, '已死不得 spawn');
  // hydrate 空对象 → 复活（换 seed / 删存档路径）
  svc.hydrate({});
  assertEqual(svc.isDead(), false);
  svc.ensure();
  assertTrue(svc.active() !== null, 'hydrate({}) 后应恢复');
  assertEqual(em.count(DRAGON_TYPE), 1);
});

test('龙 service: 死亡标记是 merge 写，不抹掉 meta 其它字段', async () => {
  const seed = findSeedWithAltar(true);
  const p = fakePersistence({ seed: 999, spawn: [1, 2, 3], playerPos: { x: 5, y: 6, z: 7 } });
  const { svc } = makeService({ seed, persistence: p, ready: [altarColumnKey(seed)] });
  svc.hydrate(p.store.meta);
  svc.ensure();
  svc.damage(svc.active().id, 9999, 1000);
  await Promise.resolve();
  assertEqual(p.store.meta.seed, 999, 'seed 被抹掉了（整行覆盖而非 merge）');
  assertDeepEqual(p.store.meta.spawn, [1, 2, 3]);
  assertDeepEqual(p.store.meta.playerPos, { x: 5, y: 6, z: 7 });
  assertEqual(p.store.meta.dragonDead, true);
  assertEqual(p.store.calls.length, 1, 'saveDragonDead 应恰好调一次');
});

test('龙 service: damage 未知 id / 非龙实体返回 null', () => {
  const seed = findSeedWithAltar(true);
  const { svc } = makeService({ seed, ready: [altarColumnKey(seed)] });
  assertNull(svc.damage('nope', 10, 0));
  svc.ensure();
  // 非龙类型的实体不得被 DragonService 伤害
  assertNull(svc.damage('zombie-1', 10, 0));
});

test('龙 service: warm() 预热轨道 memo 且幂等（不把 12.6ms 冷调用留给首个玩法帧）', () => {
  const seed = findSeedWithAltar(true);
  const { svc } = makeService({ seed });
  // warm 之前 memo 为空
  assertEqual(svc._orbitMemo, null);
  svc.warm();
  assertTrue(svc._orbitMemo !== null, 'warm 后 memo 应已填充');
  assertEqual(svc._orbitMemo.seed, seed);
  const first = svc._orbitMemo.orbit;
  // 幂等：重复 warm 不重算（同一对象引用）
  svc.warm();
  svc.warm();
  assertTrue(svc._orbitMemo.orbit === first, 'warm 应幂等（复用同一 memo，不重算）');
  // warm 不 spawn（它只预热轨道，spawn 仍由 ensure 的 column 门控决定）
  assertEqual(svc.active(), null, 'warm 不得 spawn 实体');
});

test('龙 service: warm() 在无祭坛地带时不抛（memo 存 null）', () => {
  const { svc } = makeService({ seed: 1, findAltar: () => null });
  svc.warm();
  assertTrue(svc._orbitMemo !== null, 'memo 应已填充（值为 null 轨道）');
  assertEqual(svc._orbitMemo.orbit, null);
  svc.ensure();
  assertEqual(svc.active(), null);
});

test('龙 service: dispose 回收活着的龙', () => {
  const seed = findSeedWithAltar(true);
  const { em, svc } = makeService({ seed, ready: [altarColumnKey(seed)] });
  svc.ensure();
  assertEqual(em.count(DRAGON_TYPE), 1);
  svc.dispose();
  assertEqual(em.count(DRAGON_TYPE), 0);
  assertEqual(svc.active(), null);
});

test('龙 service: 推进 dt 后位置沿轨道前进（definition 真的被驱动）', () => {
  const seed = findSeedWithAltar(true);
  const { em, svc } = makeService({ seed, ready: [altarColumnKey(seed)] });
  svc.ensure();
  const p0 = svc.active().state.position.slice();
  em.update(0.5, {});
  const p1 = svc.active().state.position;
  const moved = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]);
  // 0.5 秒 × 6 格/秒 = 3 格弧长 → 弦长略小于 3
  assertTrue(moved > 2.5 && moved < 3.05, `0.5 秒移动 ${moved} 格（期望 ≈3 的弦长）`);
});
