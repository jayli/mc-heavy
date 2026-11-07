// src/tests/test-dragon-system.js — 祭坛飞龙（v2.41）纯逻辑：轨道 / 动画状态机 / AABB / definition / service
//
// 覆盖（spec §5、§6）：轨道确定性与半径高度有界、yaw 是切线方向、salt 不撞车、
// AABB 随 yaw 旋转、命中判据在临界距离附近区分、动画状态机 fly/glide 交替与周期闭合、
// definition 返回全新 state（M5 不变式）、DragonService 的按需召唤（v2.43）/ damage / 死后可重召。
//
// 派生量一律从**冻结常量**算出而非硬编码字面量（testing-policy §2.5）。
import { test } from './runner.js';
import {
  assertEqual, assertFalse, assertNull, assertTrue, assertDeepEqual,
} from './assert.js';
import { EntityManager } from '../entities/entity-manager.js';
import { columnKeyAt } from '../voxel/constants.js';
import { TARN_PLATEAU_Y } from '../gen/structures/tarn-zone.js';
import {
  DRAGON, DRAGON_TYPE, DRAGON_MAX_ALIVE, DRAGON_ORBIT_SALT, DRAGON_CORE_OBB, DRAGON_ANIM,
  DRAGON_AI, dragonEntityIdFor,
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

test('龙轨道: wobbleAmp=0 时 yaw 逐位退回 π−θ（既有口径零回归）', () => {
  // ⚠️ **必须逐位相等，不是近似**：实测（20000 采样）解析切线 atan2(−dx/dθ, −dz/dθ) 在 A=0 时
  // 与 π−θ 有 15244 个采样不逐位相等（最大偏差 2π = 角度表示差异）⇒ 实现必须显式分支。
  for (const t of [0, 0.37, 1.3, 4.7, 12.9, 25.1]) {
    const theta = ORBIT.phase + ORBIT.omega * t;
    const { yaw } = dragonPoseAt(ORBIT, t);
    assertTrue(Object.is(yaw, Math.PI - theta) || yaw === Math.PI - theta,
      `t=${t} yaw=${yaw} 与 π−θ=${Math.PI - theta} 不逐位相等`);
  }
});

test('龙轨道: wobble 生效时半径按 θ 调制（左右拐弯，不再死板画圆）', () => {
  const A = DRAGON_AI.wobbleAmp, F = DRAGON_AI.wobbleFreq;
  const wob = Object.freeze({ ...ORBIT, wobbleAmp: A, wobbleFreq: F, wobblePhase: 0 });
  // 一圈（2π/omega 秒）采 720 点：半径必须在 [R−A, R+A] 内起伏，且**不是常数**
  const period = (Math.PI * 2) / ORBIT.omega;
  const N = 720;
  const radii = new Set();
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < N; i++) {
    const t = (i / N) * period;
    const p = dragonPoseAt(wob, t).position;
    const r = Math.hypot(p[0] - wob.cx, p[2] - wob.cz);
    radii.add(round6(r));
    if (r < min) min = r;
    if (r > max) max = r;
  }
  assertTrue(radii.size > 100, `半径只有 ${radii.size} 个不同值（疑似没调制）`);
  // ⚠️ **容差从采样分辨率派生，不写死贴线值**：720 个采样点不可能恰好落在 sin 极值点上，
  // 采样到的极值必然比真极值偏 amp/2·(freq·Δθ)² 量级（Δθ = period/N）。首版写 1e-6 是
  // 「断言描述想象中的世界」—— 它要求采样点精确命中极值，换 N 或换 phase 就假失败。
  const dTheta = period / N;
  const tol = A * Math.pow(F * dTheta, 2);   // 保守上界（真实误差再小 8 倍）
  assertTrue(Math.abs(min - (DRAGON.orbitRadius - A)) < tol, `最小半径 ${min} ≠ ${DRAGON.orbitRadius - A}（容差 ${tol}）`);
  assertTrue(Math.abs(max - (DRAGON.orbitRadius + A)) < tol, `最大半径 ${max} ≠ ${DRAGON.orbitRadius + A}（容差 ${tol}）`);
  // y 仍在 bob 带内（调制只动水平半径）
  const p0 = dragonPoseAt(wob, 1.1).position;
  assertTrue(Math.abs(p0[1] - wob.y) <= DRAGON.bobAmplitude + 1e-9, `y=${p0[1]} 越出 bob 带`);
});

test('龙轨道: wobble 生效时 yaw 仍是路径切线（不侧着身子飞）', () => {
  const wob = Object.freeze({
    ...ORBIT, wobbleAmp: DRAGON_AI.wobbleAmp, wobbleFreq: DRAGON_AI.wobbleFreq, wobblePhase: 0.9,
  });
  for (const t of [0, 1.3, 4.7, 12.9]) {
    const { yaw } = dragonPoseAt(wob, t);
    const eps = 1e-5;
    const a = dragonPoseAt(wob, t).position;
    const b = dragonPoseAt(wob, t + eps).position;
    const tx = b[0] - a[0], tz = b[2] - a[2];
    const len = Math.hypot(tx, tz);
    const fx = Math.sin(-yaw), fz = -Math.cos(yaw);
    const dot = (fx * tx + fz * tz) / len;
    assertTrue(dot > 0.99, `t=${t} 调制轨道上 yaw 前向与切线点积 ${dot}`);
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

test('龙 definition: update 无玩家上下文时仍走轨道（ctx 缺失不崩）', () => {
  const st = makeState();
  const a = dragonDefinition.update({ state: st }, 1 / 60, undefined);
  const b = dragonDefinition.update({ state: st }, 1 / 60, { world: null });
  assertDeepEqual(a, b);
});

test('龙 definition: update 委托给 DragonBossAgent（有玩家时行为分叉）', () => {
  // 玩家就在龙旁边（视线通）→ orbit 当帧切 chase；无玩家时保持 orbit。
  // 这是「definition 不再自己算轨道、而是委托 Agent」的判别性断言：
  // 若 update 没接 Agent，两种 ctx 的结果会逐位相同。
  const st = makeState({ position: [ORBIT.cx + DRAGON.orbitRadius, ORBIT.y, ORBIT.cz], orbitT: 0 });
  const idle = dragonDefinition.update({ state: st }, 1 / 60, { world: null });
  assertEqual(idle.mode, 'orbit', '无玩家上下文 → 保持盘旋');
  const chasing = dragonDefinition.update({ state: st }, 1 / 60, {
    world: { getBlockId: () => 0 },
    registry: { solidTable: new Uint8Array(256), opaqueTable: new Uint8Array(256) },
    player: { position: [ORBIT.cx + DRAGON.orbitRadius + 10, ORBIT.y, ORBIT.cz] },
  });
  assertEqual(chasing.mode, 'chase', '玩家进入 sightRange 且视线通 → 必须委托给 Agent 进追击');
});

test('龙 definition: serialize 不含 fireRequest（瞬态字段不进快照）', () => {
  const st = makeState({ fireRequest: { position: [1, 2, 3], direction: [1, 0, 0] } });
  const raw = dragonDefinition.serialize(st);
  assertTrue(!('fireRequest' in raw), 'serialize 输出不得含 fireRequest 键（瞬态，防陈旧请求复活）');
  // 往返后 fireRequest 恒 null
  const back = dragonDefinition.deserialize(raw);
  assertEqual(back.fireRequest, null, 'deserialize 后 fireRequest 必须为 null');
});

test('龙 definition: create 补全 AI 字段缺省值（mode=orbit 等）', () => {
  const st = makeState();
  assertEqual(st.mode, 'orbit', '缺省 mode 必须是 orbit');
  assertEqual(st.attackPhase, 'approach');
  assertEqual(st.fireCooldown, 0);
  assertEqual(st.losVisible, false);
  assertEqual(st.turnDist, 0);
  assertEqual(st.aimTime, 0, 'v2.45 瞄准保持字段必须有缺省 0（旧调用不破）');
  assertEqual(st.fireRequest, null);
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

// ==================== DragonService（v2.43：按需召唤，多实例）====================

/** 一个假地图实例（`bossMapAt()` 的返回形状） */
const MAP_A = Object.freeze({ kind: 'TARN', cx: 100, cz: -50, key: 'tarn:0:0' });
const MAP_B = Object.freeze({ kind: 'TARN', cx: 900, cz: 700, key: 'tarn:2:1' });

function makeService({ seed = 12345 } = {}) {
  const em = new EntityManager();
  em.registerType(DRAGON_TYPE, dragonDefinition);
  const svc = new DragonService({ entities: em, seed });
  return { em, svc };
}

test('龙 service: summon 在指定地图中心召出一条，位置在轨道上', () => {
  const { em, svc } = makeService();
  const r = svc.summon(MAP_A.key, MAP_A.cx, MAP_A.cz, 0);
  assertEqual(r.ok, true);
  assertEqual(r.id, dragonEntityIdFor(MAP_A.key, 0));
  const e = em.get(r.id);
  assertTrue(e !== null, '应 spawn 一条龙');
  assertEqual(e.type, DRAGON_TYPE);
  assertEqual(em.count(DRAGON_TYPE), 1);
  assertEqual(e.persistent, false, '龙必须是临时实体（位置不进存档，红线 2）');
  // 位置在轨道上：水平距地图中心在 [radius−wobbleAmp, radius+wobbleAmp] 带内
  // （v2.44 起半径按 θ 调制；旧断言「恒等于 orbitRadius」会把调制误判成缺陷）
  const dist = Math.hypot(e.state.position[0] - MAP_A.cx, e.state.position[2] - MAP_A.cz);
  assertTrue(Math.abs(dist - DRAGON.orbitRadius) <= DRAGON_AI.wobbleAmp + 1e-6, `轨道半径 ${dist}`);
  const yMid = TARN_PLATEAU_Y + DRAGON.orbitYOffset;
  assertTrue(Math.abs(e.state.position[1] - yMid) <= DRAGON.bobAmplitude + 1e-9,
    `y=${e.state.position[1]} 不在 ${yMid}±${DRAGON.bobAmplitude}`);
  assertEqual(e.state.health, DRAGON.health);
});

test('龙 service: 轨道中心 = 召唤时传入的地图中心（不再绑定祭坛地带）', () => {
  const { svc } = makeService();
  svc.summon(MAP_B.key, MAP_B.cx, MAP_B.cz, 0);
  const orbit = svc.activeEntities()[0].state.orbit;
  assertEqual(orbit.cx, MAP_B.cx, '轨道中心必须是玩家所在地图的中心');
  assertEqual(orbit.cz, MAP_B.cz);
  assertEqual(orbit.y, TARN_PLATEAU_Y + DRAGON.orbitYOffset);
  assertEqual(orbit.radius, DRAGON.orbitRadius);
  assertEqual(round6(orbit.omega), round6(DRAGON.orbitSpeed / DRAGON.orbitRadius));
  assertTrue(orbit.phase >= 0 && orbit.phase < Math.PI * 2, `phase=${orbit.phase}`);
});

test('龙 service: 同一槽位重复 summon 返回 exists（幂等，不产生第二条）', () => {
  const { em, svc } = makeService();
  assertEqual(svc.summon(MAP_A.key, MAP_A.cx, MAP_A.cz, 0).ok, true);
  const again = svc.summon(MAP_A.key, MAP_A.cx, MAP_A.cz, 0);
  assertEqual(again.ok, false);
  assertEqual(again.reason, 'exists');
  assertEqual(em.count(DRAGON_TYPE), 1, '重复召唤不得产生第二条');
});

test('龙 service: 不同地图可同时各有一条（按地图分别记槽位）', () => {
  const { em, svc } = makeService();
  assertEqual(svc.summon(MAP_A.key, MAP_A.cx, MAP_A.cz, 0).ok, true);
  assertEqual(svc.summon(MAP_B.key, MAP_B.cx, MAP_B.cz, 0).ok, true);
  assertEqual(em.count(DRAGON_TYPE), 2, '两张地图各自的 Boss1 应共存');
  const ids = svc.activeEntities().map((e) => e.id).sort();
  assertDeepEqual(ids, [dragonEntityIdFor(MAP_A.key, 0), dragonEntityIdFor(MAP_B.key, 0)].sort());
  // 两条龙的轨道中心必须各自独立（共享会让第二条飞到第一张地图去）
  const orbits = svc.activeEntities().map((e) => e.state.orbit);
  const centers = new Set(orbits.map((o) => `${o.cx},${o.cz}`));
  assertEqual(centers.size, 2, '两条龙的轨道中心必须不同');
});

test('龙 service: 同一地图的 Boss1/Boss2 槽位可共存', () => {
  const { em, svc } = makeService();
  assertEqual(svc.summon(MAP_A.key, MAP_A.cx, MAP_A.cz, 0).ok, true);
  assertEqual(svc.summon(MAP_A.key, MAP_A.cx, MAP_A.cz, 1).ok, true);
  assertEqual(em.count(DRAGON_TYPE), 2);
  const ids = svc.activeEntities().map((e) => e.id).sort();
  assertDeepEqual(ids, [dragonEntityIdFor(MAP_A.key, 0), dragonEntityIdFor(MAP_A.key, 1)].sort());
});

test('龙 service: 超过 DRAGON_MAX_ALIVE 返回 limit（不静默丢弃）', () => {
  const { em, svc } = makeService();
  for (let i = 0; i < DRAGON_MAX_ALIVE; i++) {
    const r = svc.summon(`tarn:9:${i}`, 1000 + i * 500, 0, 0);
    assertEqual(r.ok, true, `第 ${i + 1} 条应成功`);
  }
  assertEqual(em.count(DRAGON_TYPE), DRAGON_MAX_ALIVE);
  const over = svc.summon('tarn:9:99', 5000, 5000, 0);
  assertEqual(over.ok, false);
  assertEqual(over.reason, 'limit');
  assertEqual(em.count(DRAGON_TYPE), DRAGON_MAX_ALIVE, '超限不得 spawn');
});

test('龙 service: phase 按地图中心派生（同地图重召同 phase，不同地图一般不同）', () => {
  const a = makeService(); a.svc.summon(MAP_A.key, MAP_A.cx, MAP_A.cz, 0);
  const b = makeService(); b.svc.summon(MAP_A.key, MAP_A.cx, MAP_A.cz, 0);
  assertEqual(a.svc.activeEntities()[0].state.orbit.phase,
    b.svc.activeEntities()[0].state.orbit.phase, '同一张地图重召必须同 phase（确定性）');
  const { svc } = makeService();
  svc.summon(MAP_A.key, MAP_A.cx, MAP_A.cz, 0);
  svc.summon(MAP_B.key, MAP_B.cx, MAP_B.cz, 0);
  const phases = svc.activeEntities().map((e) => e.state.orbit.phase);
  assertTrue(Math.abs(phases[0] - phases[1]) > 1e-9,
    '不同地图的 phase 应有差异（否则多条龙会同步扇翅，观感是复制粘贴）');
});

test('龙 service: damage 精确扣血 + 红闪时间戳（performance.now 口径）', () => {
  const { svc } = makeService();
  svc.summon(MAP_A.key, MAP_A.cx, MAP_A.cz, 0);
  const id = svc.activeEntities()[0].id;
  const now = 12345.6;   // performance.now() 量级（不是 Date.now() 的 1.7e12）
  const r = svc.damage(id, 100, now);
  assertEqual(r.dead, false);
  assertEqual(r.health, DRAGON.health - 100);
  assertEqual(svc.activeEntities()[0].state.flashedUntil, now + DRAGON.flashMs);
  assertEqual(svc.activeEntities()[0].state.health, DRAGON.health - 100);
});

test('龙 service: 临界伤害序列（恰好打满血量致死，少一发不死）', () => {
  const { em, svc } = makeService();
  svc.summon(MAP_A.key, MAP_A.cx, MAP_A.cz, 0);
  const id = svc.activeEntities()[0].id;
  const now = 1000;
  // ⚠️ 发数从**冻结常量派生**（testing-policy §2.5），不硬编码 —— 血量改了自动跟上。
  const dmg = 100;
  const shotsToKill = Math.ceil(DRAGON.health / dmg);
  for (let i = 0; i < shotsToKill - 1; i++) {
    const r = svc.damage(id, dmg, now + i);
    assertEqual(r.dead, false, `第 ${i + 1} 发不得判死`);
  }
  assertEqual(svc.activeEntities()[0].state.health, DRAGON.health - dmg * (shotsToKill - 1));
  const dead = svc.damage(id, dmg, now + shotsToKill);
  assertEqual(dead.dead, true);
  assertTrue(dead.health <= 0, `最后一发须越界（health=${dead.health}）`);
  assertEqual(svc.activeEntities().length, 0, '死亡后实体应消失');
  assertEqual(em.count(DRAGON_TYPE), 0);
});

test('龙 service: 死后可重新召唤（v2.43 取代 v2.41 的永久死亡）', () => {
  const { em, svc } = makeService();
  svc.summon(MAP_A.key, MAP_A.cx, MAP_A.cz, 0);
  const id = svc.activeEntities()[0].id;
  svc.damage(id, DRAGON.health + 1, 500);
  assertEqual(em.count(DRAGON_TYPE), 0, '死亡后应 despawn');
  // ⚠️ 这条是 v2.43 的核心语义变更：用户裁定「只有 Boss 死掉后，再按 B 才会召唤出 Boss」
  const again = svc.summon(MAP_A.key, MAP_A.cx, MAP_A.cz, 0);
  assertEqual(again.ok, true, '死后同一槽位必须可重召（永久死亡已移除）');
  assertEqual(again.id, id, '重召复用同一个派生 id（幂等，不攒第二条）');
  assertEqual(em.count(DRAGON_TYPE), 1);
  assertEqual(svc.activeEntities()[0].state.health, DRAGON.health, '重召满血');
});

test('龙 service: 死亡不写任何存档（dragonDead 已随永久死亡移除）', () => {
  // ⚠️ 判据落在「service 不持有任何 persistence 引用」上：v2.41 的 saveDragonDead 已删，
  // 若有人把它加回来，这条会红（构造签名里没有 persistence 这个参数）。
  const { svc } = makeService();
  assertEqual(svc.persistence, undefined, 'DragonService 不得再持有 persistence');
  svc.summon(MAP_A.key, MAP_A.cx, MAP_A.cz, 0);
  svc.damage(svc.activeEntities()[0].id, DRAGON.health + 1, 500);
  assertEqual(svc.isDead, undefined, 'isDead() 已随永久死亡移除');
});

test('龙 service: damage 未知 id / 非龙实体返回 null', () => {
  const { svc } = makeService();
  assertNull(svc.damage('nope', 10, 0));
  svc.summon(MAP_A.key, MAP_A.cx, MAP_A.cz, 0);
  assertNull(svc.damage('zombie-1', 10, 0));
});

test('龙 service: activeEntities 返回快照（遍历中 despawn 不失效）', () => {
  const { svc } = makeService();
  svc.summon(MAP_A.key, MAP_A.cx, MAP_A.cz, 0);
  svc.summon(MAP_B.key, MAP_B.cx, MAP_B.cz, 0);
  const snapshot = svc.activeEntities();
  assertEqual(snapshot.length, 2);
  // 遍历中打死第一条（despawn 改变底层集合）→ 快照仍可安全遍历
  let visited = 0;
  for (const e of snapshot) {
    svc.damage(e.id, DRAGON.health + 1, 1000 + visited);
    visited++;
  }
  assertEqual(visited, 2, '快照遍历必须完整（迭代器会因 despawn 失效）');
  assertEqual(svc.activeEntities().length, 0);
});

test('龙 service: dispose 回收全部存活的龙', () => {
  const { em, svc } = makeService();
  svc.summon(MAP_A.key, MAP_A.cx, MAP_A.cz, 0);
  svc.summon(MAP_B.key, MAP_B.cx, MAP_B.cz, 0);
  assertEqual(em.count(DRAGON_TYPE), 2);
  svc.dispose();
  assertEqual(em.count(DRAGON_TYPE), 0);
  assertEqual(svc.activeEntities().length, 0);
});

test('龙 service: 推进 dt 后位置沿轨道前进（definition 真的被驱动）', () => {
  const { em, svc } = makeService();
  svc.summon(MAP_A.key, MAP_A.cx, MAP_A.cz, 0);
  const p0 = svc.activeEntities()[0].state.position.slice();
  em.update(0.5, {});
  const p1 = svc.activeEntities()[0].state.position;
  const moved = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]);
  // 0.5 秒 × 6 格/秒 = 3 格弧长 → 弦长略小于 3
  assertTrue(moved > 2.5 && moved < 3.05, `0.5 秒移动 ${moved} 格（期望 ≈3 的弦长）`);
});

test('龙 service: 被 column 卸载回收后槽位清空，可重新召唤（已知取舍）', () => {
  const { em, svc } = makeService();
  svc.summon(MAP_A.key, MAP_A.cx, MAP_A.cz, 0);
  const first = svc.activeEntities()[0].state.position.slice();
  // 模拟玩家走远 → column 卸载回收临时实体
  em.despawnColumn(columnKeyAt(first[0], first[2]), 'column-unloaded');
  assertEqual(svc.activeEntities().length, 0, '回收后应无实体');
  // ⚠️ 用户 2026-11-03 接受的取舍：卸载也会清槽位，回来要重新按 B
  const again = svc.summon(MAP_A.key, MAP_A.cx, MAP_A.cz, 0);
  assertEqual(again.ok, true, '卸载后必须可重召');
  assertEqual(svc.activeEntities()[0].state.health, DRAGON.health, '重召满血');
});
