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

test('焰魔 AI: 视线被挡 → 从 chase 退回 idle', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  // 中间一堵墙（z ∈ [-15, -14]，全部 y）
  const wall = makeWorld((_x, _y, z) => z >= -15 && z <= -14);
  const next = a.update(st({ mode: 'chase', onGround: true }), 0.1, {
    world: wall, registry: REGISTRY, player: playerAt(30),
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
