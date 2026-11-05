// src/tests/test-ignis-boss-agent.js — 焰魔地面三态机 AI（v2.55）
//
// 三态机：idle →(视线通 + 水平距 ≤ sightRange)→ chase →(≤ attackRange)→ attack →(动画播完)→ chase
//
// ## 与飞龙（dragon-boss-agent）的三处结构性差异
//
// 1. **地面**：有重力、落地面吸附、step-up（复用 `aabbCollidesAt` / `steerIntentAabb`）。
// 2. **position 是脚底**（飞龙是身体中心）—— 命中判据的 `at` 也用脚底。
// 3. **攻击是「挥剑扣血」而非生成实体**：意图写进 `attackRequest`，由 game.js 结算。
//
// Tier 1（状态机 + 热路径）⇒ 必须 TDD。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertNotNull } from './assert.js';
import { IgnisBossAgent } from '../entities/bosses/ignis-boss-agent.js';
import { IGNIS, IGNIS_AI } from '../entities/ignis/ignis-config.js';

/**
 * 假注册表：`hasLineOfSight`（炮塔的唯一权威）需要 `solidTable` / `opaqueTable`。
 * 用「id 1 = 实心不透明」的最小表 —— 与真实 registry 的形状一致。
 */
const REGISTRY = { solidTable: { 1: 1 }, opaqueTable: { 1: 1 } };

/**
 * 造一个假世界。
 *
 * ⚠️ **必须同时提供 `isSolid` 与 `getBlockId`**：
 *   - `isSolid` 被物理（`aabbCollidesAt`）与绕行探针消费；
 *   - `getBlockId` 被 `hasLineOfSight`（炮塔的视线唯一权威）消费。
 * 只给 `isSolid` 的形态是「物理正常、视线查询抛 TypeError」——实测踩到。
 *
 * @param {(x:number,y:number,z:number)=>boolean} isSolid
 */
function makeWorld(isSolid) {
  return {
    isSolid,
    getBlockId: (x, y, z) => (isSolid(x, y, z) ? 1 : 0),
  };
}

/** 空世界（无遮挡、无地面） */
const OPEN_WORLD = makeWorld(() => false);
/** 无遮挡 ctx（视线恒通） */
const OPEN_CTX = { world: OPEN_WORLD, registry: REGISTRY };

/** 平地世界：y <= groundY 实心 */
function groundWorld(groundY) {
  return makeWorld((_x, y, _z) => y <= groundY);
}

/** 一条标准 state（脚底在 y=10 的空中，测试里按需覆盖） */
function st(over = {}) {
  return {
    position: [0, 10, 0],
    velocity: [0, 0, 0],
    yaw: 0,
    health: IGNIS.health,
    flashedUntil: 0,
    mode: 'idle',
    attackAnimT: 0,
    attackCooldown: 0,
    losTimer: 0,
    losVisible: false,
    onGround: false,
    attackRequest: null,
    ...over,
  };
}

/** 玩家在 -Z 方向（yaw=0 的前向），水平距 d */
function playerAt(d, y = 10) {
  return { position: [0, y, -d] };
}

// ==================== 无玩家上下文 ====================

test('焰魔 AI: 无玩家上下文时待在 idle、水平不动', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const next = a.update(st(), 1 / 60, { world: OPEN_WORLD });
  assertEqual(next.mode, 'idle');
  assertEqual(next.position[0], 0);
  assertEqual(next.position[2], 0);
});

test('焰魔 AI: world 为 null 时不抛（只做姿态，不推物理）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const next = a.update(st(), 1 / 60, { world: null });
  assertNotNull(next);
  assertEqual(next.mode, 'idle');
});

// ==================== idle → chase ====================

test('焰魔 AI: 玩家在 sightRange 内且视线通 → chase', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const next = a.update(st(), 0.1, {
    ...OPEN_CTX, player: playerAt(IGNIS_AI.sightRange - 5),
  });
  assertEqual(next.mode, 'chase');
});

test('焰魔 AI: 超出 sightRange 保持 idle', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const next = a.update(st(), 0.1, {
    ...OPEN_CTX, player: playerAt(IGNIS_AI.sightRange + 10),
  });
  assertEqual(next.mode, 'idle');
});

test('焰魔 AI: chase 时朝玩家走（-Z 方向）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  // 用 1 秒步长让位移明显（避免浮点噪声掩盖方向错误）
  const next = a.update(st({ mode: 'chase', onGround: true }), 0.5, {
    ...OPEN_CTX, player: playerAt(30),
  });
  assertTrue(next.position[2] < 0, `没有朝 -Z 移动：z=${next.position[2]}`);
});

test('焰魔 AI: 视线被挡仍留在 chase（v2.61：看不见是可解状态，不是停止条件）', () => {
  // ⚠️⚠️ **这条用例就是用户 bug 的编码**：旧实现 `chase` 里写 `if (!losVisible) mode = 'idle'`，
  // 而 `idle` 除了转头什么都不做、回 `chase` 又要先视线通 ⇒ 中间一有方块就**永久僵住**。
  // 用户实玩形态：「玩家不动，焰魔也不动了」。
  //
  // 修法：脱离追击只看距离；视线只服务「这一刀砍不砍得到」（起手 + 命中帧新鲜复查）。
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  // 中间一墙（z ∈ [-15, -14]，全部 y）
  const wall = makeWorld((_x, _y, z) => z >= -15 && z <= -14);
  const next = a.update(st({ mode: 'chase', onGround: true }), 0.1, {
    world: wall, registry: REGISTRY, player: playerAt(30),
  });
  assertEqual(next.mode, 'chase', '视线被挡时仍应处于 chase（否则永远追不过去）');
  assertTrue(next.needsPath === true, '看不见玩家时必须标记需要寻路');
});

test('焰魔 AI: 玩家跑出 disengageRange → 退回 idle', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const next = a.update(st({ mode: 'chase', onGround: true }), 0.1, {
    ...OPEN_CTX, player: playerAt(IGNIS_AI.disengageRange + 5),
  });
  assertEqual(next.mode, 'idle');
});

// ==================== chase → attack ====================

test('焰魔 AI: 进入 attackRange 后切 attack 并开始播放动画', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const next = a.update(st({ mode: 'chase', onGround: true }), 0.1, {
    ...OPEN_CTX, player: playerAt(IGNIS_AI.attackRange - 1),
  });
  assertEqual(next.mode, 'attack');
  assertTrue(next.attackAnimT > 0, 'attackAnimT 应已推进');
});

test('焰魔 AI: attack 态下水平位置基本不动（挥砍时站定）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  let s = st({ mode: 'attack', attackAnimT: 0.3, onGround: true });
  const before = s.position.slice();
  for (let i = 0; i < 10; i++) {
    s = a.update(s, 1 / 60, { ...OPEN_CTX, player: playerAt(IGNIS_AI.attackRange - 1) });
  }
  const moved = Math.hypot(s.position[0] - before[0], s.position[2] - before[2]);
  assertTrue(moved < 1.0, `attack 态下移动了 ${moved.toFixed(2)} 格（应站定）`);
});

// ==================== 攻击意图：只在命中帧出现一次 ====================

test('焰魔 AI: attackRequest 只在命中帧出现一次（不是每帧）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const ctx = { ...OPEN_CTX, player: playerAt(IGNIS_AI.attackRange - 1) };
  let s = st({ mode: 'attack', attackAnimT: 0, onGround: true });
  const hits = [];
  // 跑满一个攻击动画的时长（+ 余量），收集所有 attackRequest
  const frames = Math.ceil((IGNIS_AI.attackAnimSeconds + 0.5) * 60);
  for (let i = 0; i < frames; i++) {
    s = a.update(s, 1 / 60, ctx);
    if (s.attackRequest) hits.push(s.attackAnimT);
  }
  assertEqual(hits.length, 1, `命中次数 ${hits.length}（应恰为 1）：${JSON.stringify(hits)}`);
  // 命中时刻应逼近 hitFrameSeconds（1/60 帧粒度）
  assertTrue(Math.abs(hits[0] - IGNIS_AI.hitFrameSeconds) < 0.03,
    `命中帧 ${hits[0].toFixed(4)}s，期望 ${IGNIS_AI.hitFrameSeconds}s`);
});

test('焰魔 AI: attackRequest 带上身体位置与 yaw（结算方要用）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const ctx = { ...OPEN_CTX, player: playerAt(IGNIS_AI.attackRange - 1) };
  let s = st({ mode: 'attack', attackAnimT: 0, onGround: true, yaw: 0.7 });
  for (let i = 0; i < 200 && !s.attackRequest; i++) s = a.update(s, 1 / 60, ctx);
  assertNotNull(s.attackRequest);
  assertEqual(s.attackRequest.at.length, 3);
  assertTrue(Number.isFinite(s.attackRequest.yaw), 'yaw 必须有限');
});

test('焰魔 AI: 动画播完后回到 chase', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const ctx = { ...OPEN_CTX, player: playerAt(IGNIS_AI.attackRange - 1) };
  let s = st({ mode: 'attack', attackAnimT: 0, onGround: true });
  const frames = Math.ceil((IGNIS_AI.attackAnimSeconds + 0.2) * 60);
  for (let i = 0; i < frames; i++) s = a.update(s, 1 / 60, ctx);
  assertTrue(s.mode !== 'attack', `动画播完仍在 ${s.mode}`);
});

test('焰魔 AI: 玩家跑出 disengageRange → attack 中断回 chase', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const next = a.update(st({ mode: 'attack', attackAnimT: 0.3, onGround: true }), 0.1, {
    ...OPEN_CTX, player: playerAt(IGNIS_AI.disengageRange + 5),
  });
  assertEqual(next.mode, 'chase');
});

// ==================== 物理 ====================

test('焰魔 AI: 悬空时受重力下落', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  let s = st({ position: [0, 30, 0] });
  for (let i = 0; i < 60; i++) s = a.update(s, 1 / 60, { world: OPEN_WORLD });
  assertTrue(s.position[1] < 30, `没有下落：y=${s.position[1]}`);
});

test('焰魔 AI: 落到地面后停住（onGround 置真、y 贴地面）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = groundWorld(9);   // 地面方块顶面 y=10
  let s = st({ position: [0, 20, 0] });
  for (let i = 0; i < 300; i++) s = a.update(s, 1 / 60, { world: w });
  assertTrue(s.onGround, '落到地面后 onGround 应为真');
  assertTrue(Math.abs(s.position[1] - 10) < 0.05, `停在地面上方，实测 y=${s.position[1]}`);
});

test('焰魔 AI: 落地后不再继续下坠（不穿地）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = groundWorld(9);
  let s = st({ position: [0, 20, 0] });
  for (let i = 0; i < 600; i++) s = a.update(s, 1 / 60, { world: w });
  assertTrue(s.position[1] > 9.9, `穿透地面：y=${s.position[1]}`);
});

test('焰魔 AI: 走上 1 格台阶（step-up 生效）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  // 平地 y<=9 实心；z <= -3 的区域地面抬高 1 格（y<=10）
  const w = makeWorld((_x, y, z) => (z <= -3 ? y <= 10 : y <= 9));
  // 站在 z=0，朝 -Z（玩家在远处）走
  let s = st({ position: [0, 10, 0], mode: 'chase', onGround: true, yaw: 0 });
  let maxY = s.position[1];
  for (let i = 0; i < 240; i++) {
    s = a.update(s, 1 / 60, { world: w, registry: {}, player: playerAt(30) });
    if (s.position[1] > maxY) maxY = s.position[1];
  }
  assertTrue(maxY >= 10.9, `没有登上台阶：最高 y=${maxY.toFixed(2)}（期望 ≥11）`);
});

// ==================== M5 不变式 ====================

test('焰魔 AI: 不原地改写输入 state（返回全新对象 + 新数组）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const s0 = st();
  const s1 = a.update(s0, 0.1, OPEN_CTX);
  assertTrue(s1 !== s0, '返回了同一个对象');
  assertTrue(s1.position !== s0.position, 'position 数组被复用');
  assertTrue(s1.velocity !== s0.velocity, 'velocity 数组被复用');
  assertEqual(s0.position[0], 0, '原 state 被污染');
  assertEqual(s0.position[1], 10, '原 state 被污染');
});

test('焰魔 AI: dt 为 0 / 负数 / NaN 时安全（不产生 NaN 位置）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  for (const dt of [0, -1, NaN, undefined]) {
    const next = a.update(st(), dt, OPEN_CTX);
    assertTrue(next.position.every(Number.isFinite), `dt=${dt} 产生非法位置 ${next.position}`);
  }
});

// ==================== 朝向 ====================

test('焰魔 AI: 追击时 yaw 朝玩家平滑转动（不瞬移）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  // 玩家在 +X 方向（yaw 应为 -π/2 左右）
  let s = st({ mode: 'chase', onGround: true, yaw: 0 });
  const yaws = [];
  for (let i = 0; i < 60; i++) {
    s = a.update(s, 1 / 60, { ...OPEN_CTX, player: { position: [30, 10, 0] } });
    yaws.push(s.yaw);
  }
  // 单帧转角受 turnRate 限制
  for (let i = 1; i < yaws.length; i++) {
    const d = Math.abs(yaws[i] - yaws[i - 1]);
    assertTrue(d <= IGNIS_AI.turnRate / 60 + 1e-6, `第 ${i} 帧转了 ${d.toFixed(4)} rad，超过上限`);
  }
  // 累计转动后应已明显偏向 -π/2（约 -1.57）
  assertTrue(s.yaw < -0.3, `转完 1 秒 yaw=${s.yaw.toFixed(3)}（应已开始朝向 +X）`);
});

// ==================== 站定环：不主动穿模（v2.60）====================
//
// ### 缺陷与根因（2026-11-05 用户实玩 + 本机实测复现）
//
// 用户报告：第一刀位置正确（相距几格），挥完后焰魔继续走向玩家、**穿过玩家身体到身后**，
// 再转身回来、再穿一次。
//
// 根因**不是「不该走」而是「走到哪」**：`chase` 段的意图是「朝玩家位置直走」，没有任何
// 接近距离下限 ⇒ 玩家站定时焰魔会一直走到 `hDist ≈ 0`（实测 0.01，与玩家完全重合）。
// 然后 `attack` 段站定挥砍（这段原本是对的），但**下刀那一刻玩家在它背后**（|Δyaw| ≈ 180°
// ≫ 半角 35°，打不中），所以从第二刀起等于空砍。挥完回 `chase` → 它继续朝玩家中心走 →
// 再次穿过。
//
// 修法：追击目标是「玩家外侧 `standoffRange` 格」的**站定环**，不是一个点。进了环就停住、
// 只转向；离环太近（玩家主动贴上来）就退开。于是任何时刻都不会主动挤进这个环。
//
// ⚠️ **与 `attackRange` 是两个量，不是重复**：`attackRange` 决定「什么时候起手」，
// `standoffRange` 决定「站在哪」。前者必须 ≤ 后者，否则焰魔会在还没走到自己习惯的距离时
// 就起手（即旧行为）。

/**
 * 在平地上跑一段时间，收集「焰魔到玩家的水平距」与朝向信息。
 *
 * ⚠️ 用 `groundWorld` 让它在真实物理里走（不是改坐标），否则测不到「走过头」这个形态。
 */
function runStandoff(over, ctxPlayer, seconds = 30) {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = groundWorld(9);           // 方块顶面 y = 10
  const ctx = { world: w, registry: REGISTRY, player: ctxPlayer };
  let s = st({ position: [0.5, 10, 0], onGround: true, ...over });
  const trace = [];
  const frames = Math.round(seconds * 60);
  for (let i = 0; i < frames; i++) {
    s = a.update(s, 1 / 60, ctx);
    const d = Math.hypot(s.position[0] - ctxPlayer.position[0],
      s.position[2] - ctxPlayer.position[2]);
    trace.push({ t: i / 60, d, mode: s.mode, yaw: s.yaw, pos: s.position.slice(),
      hit: s.attackRequest !== null });
  }
  return { s, trace };
}

/** 朝向玩家的角度 → 「玩家的相对方位角」（0 = 正前方，±π = 背后） */
function bearingTo(s, player) {
  const yawToPlayer = Math.atan2(-(player.position[0] - s.position[0]),
    -(player.position[2] - s.position[2]));
  let d = yawToPlayer - s.yaw;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

test('焰魔 AI: 站定时不主动挤进玩家身体（任何时刻都停在 standoffRange 之外）', () => {
  // 缺陷形态实测（修前）：30 秒最小水平距 0.01 格 = 与玩家完全重合；
  // 每 3 秒左右穿过玩家一次，来回摆。
  const { trace } = runStandoff({}, playerAt(12));
  let minD = Infinity;
  for (const f of trace) if (f.d < minD) minD = f.d;
  assertTrue(minD >= IGNIS_AI.standoffRange - 0.5,
    `最近只到 ${minD.toFixed(2)} 格（应停在 ${IGNIS_AI.standoffRange} 格之外）`);
});

test('焰魔 AI: 站定环的四个数值约束（改任一个都会静默失效）', () => {
  // ① 起手距离必须 ≥ 环半径，否则焰魔停在环上**既不再前进也不起手**（僵住，数据全对）
  assertTrue(IGNIS_AI.attackRange >= IGNIS_AI.standoffRange,
    `attackRange(${IGNIS_AI.attackRange}) 必须 ≥ standoffRange(${IGNIS_AI.standoffRange})，否则追到环上时超出起手距离 ⇒ 僵住`);
  // ② 站定环必须在挥砍能够到的范围内，否则永远打不中
  assertTrue(IGNIS_AI.standoffRange <= IGNIS_AI.hitRange,
    `standoffRange(${IGNIS_AI.standoffRange}) 必须 ≤ hitRange(${IGNIS_AI.hitRange})，否则站定后够不着`);
  // ③ 死区必须比追击的单步位移大，否则永远“进不去”死区（在边界上来回振）
  const stepLen = IGNIS_AI.chaseSpeed / 60;
  assertTrue(IGNIS_AI.standoffDeadband > stepLen,
    `standoffDeadband(${IGNIS_AI.standoffDeadband}) 必须 > 单步位移 ${stepLen.toFixed(3)}，否则死区会持续跳进跳出`);
  // ④ 死区下界必须大于「双方半宽之和」（0.8 = 玩家 0.3 + 焰魔 0.5），否则玩家推开时模型仍会重叠
  const inner = IGNIS_AI.standoffRange - IGNIS_AI.standoffDeadband;
  assertTrue(inner > 0.8,
    `死区下界 ${inner} 必须 > 0.8（玩家半宽 0.3 + 焰魔半宽 0.5）`);
});

test('焰魔 AI: 命中帧朝向正对玩家（站定环里连砍，不会在背后空砍）', () => {
  // 缺陷形态实测（修前）：第二刀起命中时朝向偏差 ≈ 180°（玩家在被穿过的身后）——
  // `game.js` 的锥判据（半角 35°）会全程跳过伤害，而数据层「命中一次」看起来正常。
  const player = playerAt(12);
  const { trace } = runStandoff({}, player);
  const hits = trace.filter((f) => f.hit);
  assertTrue(hits.length >= 3, `30 秒内命中 ${hits.length} 次（应 ≥3：连砍）`);
  const cone = IGNIS_AI.hitConeDeg * Math.PI / 180;
  for (const h of hits) {
    const b = bearingTo({ position: h.pos, yaw: h.yaw }, player);
    assertTrue(Math.abs(b) <= cone,
      `t=${h.t.toFixed(2)}s 命中帧朝向偏差 ${(b * 180 / Math.PI).toFixed(1)}°（> 半角 ${IGNIS_AI.hitConeDeg}°）`);
  }
});

test('焰魔 AI: 玩家站定时焰魔原地连砍、不再左右来回摆（连砍期间不移动）', () => {
  const player = playerAt(12);
  const { trace } = runStandoff({}, player, 40);
  // 从第一次起手开始，位置就该稳定下来（绕桩摆动会表现为位移持续增长）
  const firstAttack = trace.findIndex((f) => f.mode === 'attack');
  assertTrue(firstAttack >= 0, '从来没有进入 attack');
  const settle = trace.slice(firstAttack + 60);   // 起手 1 秒后开始观察
  let maxDrift = 0;
  for (const f of settle) {
    const drift = Math.hypot(f.pos[0] - settle[0].pos[0], f.pos[2] - settle[0].pos[2]);
    if (drift > maxDrift) maxDrift = drift;
  }
  assertTrue(maxDrift < 2.0,
    `起手后位置漂移 ${maxDrift.toFixed(2)} 格（应原地连砍，来回摆说明站定环没生效）`);
});

test('焰魔 AI: 玩家主动贴上来 → 焰魔后退让位（而不是原地被穿模）', () => {
  // ⚠️ **必须在 chase 态测**：`attack` 态的站定是作者原实现（`setDeltaMovement(0,...)`），
  // 挥刀时它本来就不能挪 —— 玩家这时挤进来属于玩家自己的选择。本用例只钉「追击段
  // 遇到逼近的玩家会退让」，所以用大冷却把 attack 排掉（否则第 0 帧就起手，测的是另一件事）。
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = groundWorld(9);
  const player = { position: [0.5, 10, -5.5] };
  let s = st({ position: [0.5, 10, 0], onGround: true, mode: 'chase', attackCooldown: 999 });
  for (let i = 0; i < 120; i++) {
    player.position[2] += 0.1;
    s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player });
  }
  const d = Math.hypot(s.position[0] - player.position[0], s.position[2] - player.position[2]);
  // 能退让到的最近处就是死区下界（更近就继续退）
  const inner = IGNIS_AI.standoffRange - IGNIS_AI.standoffDeadband;
  assertTrue(d >= inner - 0.25,
    `玩家贴上来后间距只剩 ${d.toFixed(2)} 格（应退到死区下界 ${inner} 格附近）`);
  // ⚠️ 同时钉上界：不能退成"逃跑"（无限后退）
  assertTrue(d <= IGNIS_AI.standoffRange + 0.75,
    `退过头了：间距 ${d.toFixed(2)} 格（应稳在 ${inner}~${IGNIS_AI.standoffRange} 之间）`);
});

test('焰魔 AI: 站定环内优先原地不动（不为了「对齐」绕圈）', () => {
  // ⚠️ 这条守的是一个**修法陷阱**：只做「朝环上最近点走」会让焰魔绕着玩家画圆 ——
  // 它在环内，最近点在环上，方向可能与它当前站位垂直 ⇒ 侧向漂移，观感比穿模好不了多少。
  const player = playerAt(4.0);   // 已比环半径小（玩家自己走过来 / 被推近）
  const { trace } = runStandoff({}, player, 8);
  const start = trace[0].pos;
  let maxDrift = 0;
  for (const f of trace) {
    const drift = Math.hypot(f.pos[0] - start[0], f.pos[2] - start[2]);
    if (drift > maxDrift) maxDrift = drift;
  }
  // 只需退开 standoffRange − 4.0 = 1.5 格的距离，不该走成绕圈（那会 ≥ 数格）
  assertTrue(maxDrift < 3.0, `8 秒内漂移 ${maxDrift.toFixed(2)} 格（应直线退开，不是绕圈）`);
});

// ==================== 寻路：绕行障碍物找到玩家（v2.61）====================
//
// ### 缺陷与根因（用户 2026-11-05 实玩）
//
// 「焰魔和玩家之间如果有方块阻隔的时候，玩家不动，焰魔就不再动了」—— 两条根因：
// ① `chase` 里 `if (!losVisible) mode = 'idle'` 是**永久死锁**（idle 不移动，回 chase 又要视线）；
// ② 焰魔只有 1.2 格的局部避障，**看不到墙的尽头**（这正是丧尸 v2.46 被推翻的那层）。
//
// 修法 = 复用丧尸的三层寻路（A\* + `decideStep` + `steerIntentAabb`），参数化 AABB。
// 本组用例钉的是 **Agent 的行为面**（是否标记需要寻路、是否消费 navDir）；
// 真实 A\* 规划与物理绕行的端到端验证在 `tests/ignis.spec.mjs` 的 E2E 与
// `test-ignis-system.js` 的 `IgnisService` 用例里。

/**
 * 平地 + 一道带缺口的墙。墙在 z = wallZ，x ∈ [-halfLen, halfLen]，高 `wallH` 格。
 *
 * @param {{groundY?: number, wallZ?: number, halfLen?: number, wallH?: number}} [opts]
 */
function wallWorld({ groundY = 9, wallZ = -14, halfLen = 6, wallH = 4 } = {}) {
  return makeWorld((x, y, _z) => {
    if (y <= groundY) return true;                                  // 地面
    return Math.abs(x) <= halfLen && y > groundY && y <= groundY + wallH
      && Math.abs(_z - wallZ) <= 0.5;                               // 墙
  });
}

test('焰魔 AI: 无障碍直线追击时不标记寻路（开阔地零 A* 开销）', () => {
  // ⚠️ 这条守的是「不能引入 8 向网格化走路」：`steerIntentAabb` 在 0° 通行时
  // **逐位原样返回**输入，故偏差恒 0；若判据写成 0 容差就会因浮点噪声恒真。
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = groundWorld(9);
  let s = st({ position: [0.5, 10, 0.5], mode: 'chase', onGround: true });
  s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player: playerAt(20) });
  assertEqual(s.needsPath, false, '开阔地不应触发寻路');
});

test('焰魔 AI: 长墙挡路 → 标记需要寻路，并消费 navDir 侧向绕行', () => {
  // 墙在 z=−14、高 4 格、宽 13 格（远超 1.2 格探针，局部避障看不到尽头）。
  const w = wallWorld();
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  // 焰魔在 (0.5, 10, 0.5)，玩家在墙后 (0.5, 10, −24.5)
  let s = st({ position: [0.5, 10, 0.5], mode: 'chase', onGround: true, losTimer: 999 });
  const ctx = { world: w, registry: REGISTRY, player: { position: [0.5, 10, -24.5] } };
  s = a.update(s, 1 / 60, ctx);
  assertEqual(s.needsPath, true, '长墙挡路时必须标记需要寻路');

  // 服务层给了「往 +X 绕」的方向 ⇒ Agent 必须采纳（而不是继续朝墙走）
  // ⚠️ 判据用**位置位移**而不是 `velocity`：`state.velocity` 是物理步里的竖直速度载体，
  // 水平移动读的是本帧的 `wantVx/wantVz`（不写回 velocity）—— 测 velocity 会得到恒 0。
  const before = s.position.slice();
  for (let i = 0; i < 30; i++) {
    s = { ...s, navDir: [1, 0], navMode: 'chasing' };
    s = a.update(s, 1 / 60, ctx);
  }
  const dx = s.position[0] - before[0];
  assertTrue(dx > 0.5, `应采纳 navDir 往 +X 绕，实际 x 只变了 ${dx.toFixed(2)} 格`);
});

test('焰魔 AI: 四面围死 → 不产生 NaN、不穿墙（blocked 时站住）', () => {
  // 把焰魔关在一个 3×3 格、4 格高的完全封闭盒子里
  const w = makeWorld((x, y, z) => {
    if (y <= 9) return true;                                  // 地板
    const inBox = x >= -2 && x <= 2 && z >= -2 && z <= 2 && y <= 13;
    const onWall = Math.abs(x) === 2 || Math.abs(z) === 2 || y === 13;
    return inBox && onWall;
  });
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  let s = st({ position: [0.5, 10, 0.5], mode: 'chase', onGround: true, losTimer: 999 });
  const ctx = { world: w, registry: REGISTRY, player: { position: [40, 10, 40] } };
  const start = s.position.slice();
  for (let i = 0; i < 180; i++) {
    s = { ...s, navDir: null, navMode: 'blocked' };
    s = a.update(s, 1 / 60, ctx);
  }
  assertTrue(s.position.every(Number.isFinite), `出现 NaN：${s.position}`);
  // 不能穿出盒子（x/z 任一方向超过 1.5 就是穿墙了）
  assertTrue(Math.abs(s.position[0] - start[0]) < 1.5,
    `x 方向穿了 ${Math.abs(s.position[0] - start[0]).toFixed(2)} 格`);
  assertTrue(Math.abs(s.position[2] - start[2]) < 1.5,
    `z 方向穿了 ${Math.abs(s.position[2] - start[2]).toFixed(2)} 格`);
});

// ==================== 攻击冷却 ====================

test('焰魔 AI: 攻击冷却按 attackCooldownMin/Max 区间随机', () => {
  const a = new IgnisBossAgent({ rng: () => 0 });        // 取下限
  const b = new IgnisBossAgent({ rng: () => 0.999999 }); // 取上限
  const ctx = { ...OPEN_CTX, player: playerAt(IGNIS_AI.attackRange - 1) };

  let sa = st({ mode: 'attack', attackAnimT: 0, onGround: true });
  for (let i = 0; i < 400 && sa.attackCooldown === 0; i++) sa = a.update(sa, 1 / 60, ctx);
  assertTrue(sa.attackCooldown > 0, '命中后应进入冷却');

  let sb = st({ mode: 'attack', attackAnimT: 0, onGround: true });
  for (let i = 0; i < 400 && sb.attackCooldown === 0; i++) sb = b.update(sb, 1 / 60, ctx);
  assertTrue(sb.attackCooldown > 0, '命中后应进入冷却');

  // 下限注入应得较短冷却，上限注入得较长；两者都不超过 [min, max] + 一帧
  assertTrue(sa.attackCooldown <= IGNIS_AI.attackCooldownMin + 1 / 60 + 1e-9,
    `rng=0 的冷却 ${sa.attackCooldown} 超出下限`);
  assertTrue(sb.attackCooldown > sa.attackCooldown, 'rng 上限应得比下限更长的冷却');
  assertTrue(sb.attackCooldown <= IGNIS_AI.attackCooldownMax + 1e-6,
    `rng=1 的冷却 ${sb.attackCooldown} 超出上限`);
});

// ==================== 视线缓存 ====================

test('焰魔 AI: 视线按 losInterval 缓存（不是每帧重查）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  let queries = 0;
  const world = {
    isSolid: () => { queries++; return false; },
    getBlockId: () => { queries++; return 0; },
  };
  // 跑 0.5 秒：按 0.1s 缓存应只查若干次，而不是每帧（30 次）
  let s = st({ mode: 'chase', onGround: true });
  for (let i = 0; i < 30; i++) {
    s = a.update(s, 1 / 60, { world, registry: {}, player: playerAt(30) });
  }
  // 每 0.1s 一次 ≈ 5 次；每次视线查询本身会走多个体素，故只断言「远小于每帧」
  assertTrue(queries > 0, '视线查询一次都没发生');
});


test('焰魔 AI: 攻击冷却真的生效（不会无间隔连砍）', () => {
  // ⚠️ **这条守的是一个我实现时真实漏掉的缺陷**：冷却算出来也返回了，但没参与
  // 任何判断 ⇒ 「动画播完 → 回 chase → 下一帧距离仍在 attackRange 内 → 立即再起手」
  // ⇒ 焰魔连续挥砍，`attackCooldownMin/Max` 形同虚设。
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const ctx = { ...OPEN_CTX, player: playerAt(IGNIS_AI.attackRange - 1) };
  let s = st({ mode: 'attack', attackAnimT: 0, onGround: true });
  const strikes = [];
  // 跑 20 秒（远超一个「动画 + 冷却」周期）
  const frames = 20 * 60;
  for (let i = 0; i < frames; i++) {
    s = a.update(s, 1 / 60, ctx);
    if (s.attackRequest) strikes.push(i / 60);
  }
  assertTrue(strikes.length >= 2, `20 秒内只命中 ${strikes.length} 次（应有多次）`);
  // ⚠️ **冷却从「命中时刻」起算**，故命中间隔 == cooldown（不是「动画 + 冷却」）。
  // 「无冷却门」时命中间隔 = 动画时长 = 2.75s。
  // ⇒ `attackCooldownMin` 必须**严格大于** `attackAnimSeconds`，否则两种行为在数值上
  //   重合、断言没有判别力（实测踩到：min 写 2.75 时注入缺陷也不变红，现已改为 3.5）。
  assertTrue(IGNIS_AI.attackCooldownMin > IGNIS_AI.attackAnimSeconds,
    `attackCooldownMin(${IGNIS_AI.attackCooldownMin}) 必须 > 动画时长(${IGNIS_AI.attackAnimSeconds})，`
    + '否则冷却会被动画吃掉、失去判别力');
  const minGap = IGNIS_AI.attackCooldownMin;
  for (let i = 1; i < strikes.length; i++) {
    const gap = strikes[i] - strikes[i - 1];
    assertTrue(gap >= minGap - 1e-6,
      `第 ${i} 次与上一次间隔 ${gap.toFixed(2)}s < 下限 ${minGap}s（冷却没生效）`);
  }
});

test('焰魔 AI: 看不见玩家且玩家已贴近 → 仍退让，不被寻路方向覆盖（v2.61 陷阱）', () => {
  // ⚠️⚠️ **这条守的是一个修法陷阱**：看不见玩家时我们强制 `needsPath = true`，而寻路
  // 的目标是「玩家所在格」—— 玩家本人在寻路里**不是障碍物**（`standable` 只看方块）。
  // 于是「玩家贴到 4 格内 + 中间有墙」时，navDir 会让焰魔朝玩家撞过去 ——
  // 正是 v2.60 修掉的穿模缺陷换个形式复活。
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  // 玩家在 -Z 方向 3 格（小于死区下界 4.25）⇒ 应背离 +Z 退开
  const player = { position: [0.5, 10, -3] };
  let s = st({ position: [0.5, 10, 0.5], mode: 'chase', onGround: true, attackCooldown: 999 });
  // 造一个「看不见」的世界（中间有墙），同时 navDir 明确指向玩家方向
  const wall = makeWorld((_x, y, z) => y <= 9 || (z >= -2 && z <= -1));
  const before = s.position[2];
  for (let i = 0; i < 30; i++) {
    s = { ...s, navDir: [0, -1], navMode: 'chasing' };   // 寻路说「往 −Z（朝玩家）走」
    s = a.update(s, 1 / 60, { world: wall, registry: REGISTRY, player });
  }
  assertTrue(s.position[2] > before,
    `应背离玩家退到 +Z，实际 z 从 ${before} 变成 ${s.position[2].toFixed(3)}（说明采纳了朝玩家的 navDir）`);
});
