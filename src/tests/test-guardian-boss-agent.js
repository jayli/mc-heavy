// src/tests/test-guardian-boss-agent.js — 末影守卫地面三态机 AI（Tier 1，TDD）
//
// 三态机：idle →(距 ≤ sightRange 且 turnDelay 满)→ chase →(≤ attackRange)→ attack →(动画播完)→ chase
//
// ## 与焰魔 Agent 的四处差异（本文件的判别性用例都在这里）
//
// 1. **四档抽签**（不是两档），每档独立冷却；冷却未好时**降级**而不是白放。
// 2. **命中帧/时长/射程/锥角逐招取**（四档各不同），不得读派生最大值。
// 3. **不做跳跃劈砍**：`leapKind` 恒 `'escape'`，永不出现 `'attack'`。
// 4. **体形**：站定环 3.5（不是焰魔 5.0）、重叠阈 1.95（不是 1.15）。
//
// ⚠️ 脱困用例只钉「进入 leap 态」，**不钉「真跳出去」** —— 后者在开阔地形围栏里验（Task 11）。
// 上层房间净空 5 格、守卫高 3.8 ⇒ 脚底只能升 1.2 格，任何跳都撞天花板（spec §2.3.3）。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertNotNull, assertNull, assertFalse } from './assert.js';
import { GuardianBossAgent } from '../entities/bosses/guardian-boss-agent.js';
import {
  GUARDIAN, GUARDIAN_AI, GUARDIAN_ATTACKS, GUARDIAN_ATTACK_IDS,
} from '../entities/guardian/guardian-config.js';

/** 假注册表：`hasLineOfSight` 需要 solidTable / opaqueTable（id 1 = 实心不透明） */
const REGISTRY = { solidTable: { 1: 1 }, opaqueTable: { 1: 1 } };

/** 假世界：必须同时给 isSolid（物理/绕行）与 getBlockId（视线） */
function makeWorld(isSolid) {
  return { isSolid, getBlockId: (x, y, z) => (isSolid(x, y, z) ? 1 : 0) };
}
const OPEN_WORLD = makeWorld(() => false);
const OPEN_CTX = { world: OPEN_WORLD, registry: REGISTRY };

/** 平地世界：y <= groundY 实心 */
function groundWorld(groundY) {
  return makeWorld((_x, y, _z) => y <= groundY);
}

/** 一条标准 state（脚底 y=10） */
function st(over = {}) {
  return {
    position: [0, 10, 0],
    velocity: [0, 0, 0],
    yaw: 0,
    health: GUARDIAN.health,
    flashedUntil: 0,
    mode: 'idle',
    attackAnimT: 0,
    attackKind: null,
    attackCooldown: 0,
    attackCooldowns: {},
    losTimer: 0,
    losVisible: false,
    onGround: false,
    attackRequest: null,
    ...over,
  };
}

/** 玩家在 −Z 方向（yaw=0 的前向），水平距 d */
function playerAt(d, y = 10) {
  return { position: [0, y, -d] };
}

/** 推进 n 帧 */
function run(a, initial, ctx, n, dt = 1 / 60) {
  let s = initial;
  for (let i = 0; i < n; i++) s = a.update(s, dt, ctx);
  return s;
}

// ==================== 无玩家 / 降级 ====================

test('守卫 AI: 无玩家上下文时待在 idle、水平不动', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const next = a.update(st(), 1 / 60, { world: OPEN_WORLD });
  assertEqual(next.mode, 'idle');
  assertEqual(next.position[0], 0);
  assertEqual(next.position[2], 0);
});

test('守卫 AI: world 为 null 时不抛（只做姿态，不推物理）', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const next = a.update(st(), 1 / 60, { world: null });
  assertNotNull(next);
  assertEqual(next.mode, 'idle');
});

test('守卫 AI: 返回全新 state 与全新数组（M5 不变式）', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const s = st();
  const next = a.update(s, 1 / 60, { world: null });
  assertTrue(next !== s, '不得原地返回同一对象');
  assertTrue(next.position !== s.position, 'position 必须是新数组');
  assertTrue(next.velocity !== s.velocity, 'velocity 必须是新数组');
  assertEqual(JSON.stringify(s.position), JSON.stringify([0, 10, 0]), '输入 position 未被改写');
});

test('守卫 AI: dt 为 0 / 负数 / NaN 时安全（不产生 NaN 位置）', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  for (const dt of [0, -1, NaN]) {
    const next = a.update(st(), dt, { world: OPEN_WORLD });
    assertTrue(next.position.every((v) => Number.isFinite(v)), `dt=${dt} 位置有限`);
  }
});

// ==================== 三态迁移 ====================

test('守卫 AI: 玩家进 sightRange 且 turnDelay 满 → chase', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const ctx = { ...OPEN_CTX, player: playerAt(GUARDIAN_AI.sightRange - 5) };
  let s = st({ mode: 'idle' });
  s = run(a, s, ctx, Math.ceil(GUARDIAN_AI.turnDelay * 60) + 2);
  assertEqual(s.mode, 'chase');
});

test('守卫 AI: turnDelay 未满不转 chase（中途离开清零重来）', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const ctx = { ...OPEN_CTX, player: playerAt(20) };
  let s = st({ mode: 'idle' });
  // 固定 60 帧 = 1.0s < turnDelay 1.5（不从常量派生帧数，防注入 0 时假绿）
  s = run(a, s, ctx, 60);
  assertEqual(s.mode, 'idle', '1.0 秒不应转 chase');
  assertTrue(s.acquireT > 0.9, `acquireT 应 ≈1.0，实际 ${s.acquireT}`);
  s = a.update(s, 1 / 60, { ...OPEN_CTX, player: playerAt(GUARDIAN_AI.sightRange + 10) });
  assertEqual(s.acquireT, 0, '离开视野清零');
});

test('守卫 AI: idle 不追踪 yaw（玩家绕其移动，朝向逐位不变）', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  let s = st({ mode: 'idle', yaw: 0.7 });
  for (let i = 0; i < 30; i++) {
    const ang = i / 30 * Math.PI * 2;
    s = a.update(s, 1 / 60, {
      ...OPEN_CTX, player: { position: [Math.sin(ang) * 3, 10, Math.cos(ang) * 3] },
    });
  }
  assertEqual(s.yaw, 0.7, 'idle 保持最后朝向');
});

test('守卫 AI: 超出 sightRange 保持 idle', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const ctx = { ...OPEN_CTX, player: playerAt(GUARDIAN_AI.sightRange + 5) };
  const s = run(a, st({ mode: 'idle' }), ctx, 200);
  assertEqual(s.mode, 'idle');
});

test('守卫 AI: chase 进入 attackRange 后起手（冷却好 + 视线通）', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const ctx = { ...OPEN_CTX, player: playerAt(GUARDIAN_AI.attackRange - 0.5) };
  const s = a.update(st({ mode: 'chase', losVisible: true, losTimer: 1 }), 1 / 60, ctx);
  assertEqual(s.mode, 'attack');
  // ⚠️ 起手与推进在**同一帧**完成（与焰魔同口径）⇒ attackAnimT 已走了一步，
  // 不是 0。钉「≤ 一步」而不是「== 0」：后者会在正确实现上红。
  assertTrue(s.attackAnimT <= 1 / 60 + 1e-9, `起手当帧动画应从头走，实际 ${s.attackAnimT}`);
  assertNotNull(s.attackKind, '起手必须选定一招');
});

test('守卫 AI: 冷却未到不起手（attackCooldown 真的参与判断，不是死字段）', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const ctx = { ...OPEN_CTX, player: playerAt(GUARDIAN_AI.attackRange - 0.5) };
  const s = a.update(st({ mode: 'chase', losVisible: true, losTimer: 1, attackCooldown: 3 }), 1 / 60, ctx);
  assertEqual(s.mode, 'chase', '冷却中不得起手');
});

test('守卫 AI: 视线被挡不起手，但仍在 chase（不是停止条件）', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const wall = makeWorld((x, y, z) => z === -2 && y >= 10 && y <= 14);
  const ctx = { world: wall, registry: REGISTRY, player: playerAt(3) };
  const s = a.update(st({ mode: 'chase', losVisible: false, losTimer: 1 }), 1 / 60, ctx);
  assertEqual(s.mode, 'chase', '看不见但距离近 ⇒ 留在 chase 忙绕路');
});

test('守卫 AI: 玩家跑出 disengageRange → 回 idle', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const ctx = { ...OPEN_CTX, player: playerAt(GUARDIAN_AI.disengageRange + 5) };
  const s = a.update(st({ mode: 'chase' }), 1 / 60, ctx);
  assertEqual(s.mode, 'idle');
});

test('守卫 AI: attack 期玩家跑远 → 中断回 chase 且 attackKind 清空', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const ctx = { ...OPEN_CTX, player: playerAt(GUARDIAN_AI.disengageRange + 5) };
  const s = a.update(st({
    mode: 'attack', attackAnimT: 0.5, attackKind: 'strong_right', losVisible: true, losTimer: 1,
  }), 1 / 60, ctx);
  assertEqual(s.mode, 'chase');
  assertNull(s.attackKind, '离开 attack 不得残留招式');
});

// ==================== 四档抽签与独立冷却 ====================

test('守卫 AI: rng=0 恒抽第一档，rng→1 恒抽最后一档', () => {
  const ctx = { ...OPEN_CTX, player: playerAt(3) };
  const lo = new GuardianBossAgent({ rng: () => 0 });
  const hi = new GuardianBossAgent({ rng: () => 0.999999 });
  const base = st({ mode: 'chase', losVisible: true, losTimer: 1 });
  assertEqual(lo.update(base, 1 / 60, ctx).attackKind, GUARDIAN_ATTACK_IDS[0]);
  assertEqual(hi.update(base, 1 / 60, ctx).attackKind, GUARDIAN_ATTACK_IDS[GUARDIAN_ATTACK_IDS.length - 1]);
});

test('守卫 AI: 起手当帧就置本招独立冷却（不是命中帧）', () => {
  const a = new GuardianBossAgent({ rng: () => 0.999999 });   // 抽 stomp
  const ctx = { ...OPEN_CTX, player: playerAt(3) };
  const s = a.update(st({ mode: 'chase', losVisible: true, losTimer: 1 }), 1 / 60, ctx);
  assertEqual(s.attackKind, 'stomp');
  assertTrue(s.attackCooldowns.stomp > GUARDIAN_ATTACKS.stomp.cooldownSeconds - 0.1,
    `起手当帧 stomp 冷却应已置位，实际 ${s.attackCooldowns.stomp}`);
  assertNull(s.attackRequest, '起手帧还没到命中帧');
});

test('守卫 AI: 独立冷却逐帧递减（attackCooldowns 必须跨帧传递）', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const ctx = { ...OPEN_CTX, player: playerAt(3) };
  let s = st({ mode: 'chase', attackCooldowns: { stomp: 10, uppercut: 10 } });
  s = run(a, s, ctx, 60);   // 1 秒
  assertTrue(s.attackCooldowns.stomp < 9.1 && s.attackCooldowns.stomp > 8.8,
    `1 秒后 stomp 冷却应 ≈9，实际 ${s.attackCooldowns.stomp}`);
});

test('守卫 AI: 冷却未好时降级 —— 200 次起手只出现两档普攻', () => {
  const ctx = { ...OPEN_CTX, player: playerAt(3) };
  const seen = new Set();
  // rng 遍历 [0,1)，覆盖全部四档的抽签区间
  for (let i = 0; i < 200; i++) {
    const a = new GuardianBossAgent({ rng: () => i / 200 });
    const s = a.update(st({
      mode: 'chase', losVisible: true, losTimer: 1,
      attackCooldowns: { uppercut: 5, stomp: 5 },
    }), 1 / 60, ctx);
    seen.add(s.attackKind);
  }
  assertEqual(seen.size, 2, `应只有两档普攻，实际 ${[...seen].join(',')}`);
  assertTrue(seen.has(GUARDIAN_ATTACK_IDS[0]) && seen.has(GUARDIAN_ATTACK_IDS[1]),
    '两档普攻都在候选里');
  assertFalse(seen.has(GUARDIAN_ATTACK_IDS[2]), '上勾拳冷却中不得被抽中');
  assertFalse(seen.has(GUARDIAN_ATTACK_IDS[3]), '踩踏冷却中不得被抽中');
});

test('守卫 AI: 两档普攻 cooldownSeconds=0 ⇒ 永不被排除（不会空抽）', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const ctx = { ...OPEN_CTX, player: playerAt(3) };
  // 把所有档的剩余冷却都置为 99（普攻的 cooldownSeconds=0 ⇒ 仍应在候选里）
  const allHot = {};
  for (const id of GUARDIAN_ATTACK_IDS) allHot[id] = 99;
  const s = a.update(st({
    mode: 'chase', losVisible: true, losTimer: 1, attackCooldowns: allHot,
  }), 1 / 60, ctx);
  assertNotNull(s.attackKind, '全档冷却时仍须抽到普攻（0 = 无额外冷却）');
  assertTrue(GUARDIAN_ATTACKS[s.attackKind].cooldownSeconds === 0, '只能是无额外冷却的普攻');
});

// ==================== 命中帧与逐招判据 ====================

test('守卫 AI: 每招的 attackRequest 只在本招命中帧出现一次', () => {
  const ctx = { ...OPEN_CTX, player: playerAt(3) };
  for (const kind of GUARDIAN_ATTACK_IDS) {
    const a = new GuardianBossAgent({ rng: () => 0.5 });
    const prof = GUARDIAN_ATTACKS[kind];
    // 从命中帧前一帧起步
    let s = st({
      mode: 'attack', attackKind: kind, attackAnimT: prof.hitFrameSeconds - 0.005,
      losVisible: true, losTimer: 1,
    });
    s = a.update(s, 1 / 60, ctx);
    assertNotNull(s.attackRequest, `${kind} 应在命中帧产生 request`);
    assertEqual(s.attackRequest.kind, kind, `${kind} 的 request.kind 必须是本招`);
    s = a.update(s, 1 / 60, ctx);
    assertNull(s.attackRequest, `${kind} 下一帧必须自动清空`);
  }
});

test('守卫 AI: attackRequest 带上身体位置与 yaw（结算方要用）', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const ctx = { ...OPEN_CTX, player: playerAt(3) };
  const s = a.update(st({
    mode: 'attack', attackKind: 'uppercut', attackAnimT: GUARDIAN_ATTACKS.uppercut.hitFrameSeconds - 0.005,
    yaw: 0.4, losVisible: true, losTimer: 1,
  }), 1 / 60, ctx);
  assertNotNull(s.attackRequest);
  assertEqual(s.attackRequest.at.length, 3, 'at 是三元位置');
  assertTrue(Number.isFinite(s.attackRequest.yaw), 'yaw 有限');
});

test('守卫 AI: 动画播完回 chase —— 时长按本招取（不是派生最大值）', () => {
  const ctx = { ...OPEN_CTX, player: playerAt(3) };
  for (const kind of GUARDIAN_ATTACK_IDS) {
    const a = new GuardianBossAgent({ rng: () => 0.5 });
    const prof = GUARDIAN_ATTACKS[kind];
    // 停在本招时长前 0.02s：应仍在 attack（若误用派生最大值 4.5 则短招会赖着不走）
    let s = st({
      mode: 'attack', attackKind: kind, attackAnimT: prof.animSeconds - 0.005,
      losVisible: true, losTimer: 1,
    });
    s = a.update(s, 1 / 60, ctx);
    assertEqual(s.mode, 'chase', `${kind} 播完 ${prof.animSeconds}s 应回 chase`);
    assertNull(s.attackKind, `${kind} 回 chase 后 kind 清空`);
  }
});

test('守卫 AI: 短招（踩踏 2.4s）不得被拖到派生最大值 4.5s', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const ctx = { ...OPEN_CTX, player: playerAt(3) };
  const s = a.update(st({
    mode: 'attack', attackKind: 'stomp', attackAnimT: 2.5,
    losVisible: true, losTimer: 1,
  }), 1 / 60, ctx);
  assertEqual(s.mode, 'chase', '踩踏 2.5s 早已播完（派生最大值口径会让它留在 attack）');
});

test('守卫 AI: 命中帧做新鲜视线复查（隔墙不打人）', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  // 玩家与守卫之间一堵实心墙；缓存说可见，但新鲜复查不通
  const wall = makeWorld((_x, y, z) => z === -2 && y >= 10 && y <= 14);
  const ctx = { world: wall, registry: REGISTRY, player: playerAt(3) };
  const s = a.update(st({
    mode: 'attack', attackKind: 'strong_right',
    attackAnimT: GUARDIAN_ATTACKS.strong_right.hitFrameSeconds - 0.005,
    losVisible: true, losTimer: 1,
  }), 1 / 60, ctx);
  assertNull(s.attackRequest, '新鲜视线不通 ⇒ 不产生命中');
});

// ==================== 攻击节奏：收势后空档（v3.10 用户缺陷）====================
//
// 用户 2026-11-17：「末影守卫移动到玩家身旁，应当立即展开攻击，而不是等几秒钟再开始攻击」。
//
// 根因（离线实测）：旧口径的冷却是**从命中帧起算** [5.0, 7.5]，而命中帧到动画结束还有
// 一段收势（四招 0.80~3.15s）⇒ 玩家看到的「两招之间站着不动」是 **3.45~6.70s 四种长度**；
// 上一招刚打完就走回玩家身旁时，到位后还要干等 **0~4.75s**（中位 2.52s）才起手。
// 焰魔 v3.07 已改成「收势后空档」口径，守卫照同一口径修（用户裁定取 [1.0, 1.5]）。

/** 本招在「命中帧那一帧」之后还剩多少收势（秒） */
function tailAtHit(kind, animTAfterStep) {
  return Math.max(0, GUARDIAN_ATTACKS[kind].animSeconds - animTAfterStep);
}

test('守卫 AI: 冷却 = 本招收势剩余 + [min,max]（rng 两端 × 四招）', () => {
  const ctx = { ...OPEN_CTX, player: playerAt(3) };
  for (const kind of GUARDIAN_ATTACK_IDS) {
    const prof = GUARDIAN_ATTACKS[kind];
    for (const [r, expect] of [[0, GUARDIAN_AI.attackCooldownMin], [1, GUARDIAN_AI.attackCooldownMax]]) {
      const a = new GuardianBossAgent({ rng: () => r });
      const s = a.update(st({
        mode: 'attack', attackKind: kind,
        attackAnimT: prof.hitFrameSeconds - 0.005,
        losVisible: true, losTimer: 1,
      }), 1 / 60, ctx);
      const tail = tailAtHit(kind, s.attackAnimT);
      assertTrue(Math.abs(s.attackCooldown - (tail + expect - 1 / 60)) < 1e-6,
        `${kind} rng=${r} 冷却应 ≈收势${tail.toFixed(3)}+${expect}−dt，实际 ${s.attackCooldown}`);
    }
  }
});

/**
 * 量「本招收势播完 → 下一次起手」的空档（秒）。
 *
 * ⚠️ **判据必须落在「收势之后」而不是「命中之后」**：命中帧到动画结束还有一段收势
 *（四招 0.80~3.15s），玩家看到的「两招之间站着不动」只是收势之后那一截。
 *
 * ⚠️⚠️ **必须直接钉 `attackKind`，不能靠 rng 锁定招式**（实测踩到）：
 * 上勾拳/踩踏有独立冷却（9/12s），跑几十秒后它们会被排除出候选集 ⇒ 同一个 rng
 * 在不同时刻抽到不同招 ⇒ 「kinds 恒等于某招」的断言在**正确实现**上也红。
 * 而空档只取决于**上一招**的收势，钉住它就已足够（焰魔 `measureIdleGap` 同手法）。
 *
 * 夹具：玩家钉在 3.2 格（`attackRange` 4.25 内、站定环死区 [2.75,3.5] 内 ⇒ 守卫站定），
 * `losTimer:999` + `losVisible:true` ⇒ 缓存永不过期、动画不被中断。
 */
function measureIdleGap(kind, rngValue = 0.5) {
  const a = new GuardianBossAgent({ rng: () => rngValue });
  const ctx = { world: groundWorld(9), registry: REGISTRY, player: playerAt(3.2) };
  let s = st({
    mode: 'attack', attackKind: kind, attackAnimT: 0,
    onGround: true, losTimer: 999, losVisible: true, attackCooldown: 0,
  });
  let endT = -1;
  for (let i = 0; i < 2000; i++) {
    s = a.update(s, 1 / 60, ctx);
    const t = (i + 1) / 60;
    if (endT < 0 && s.mode !== 'attack') endT = t;
    else if (endT > 0 && s.mode === 'attack') return t - endT;
  }
  return Infinity;
}

test('守卫 AI: 收势后的空档取用户裁定的 [1.0, 1.5] 秒（四招 × rng 两端）', () => {
  // ⚠️ 断言用**字面量**而不是从被测常量派生（否则改常量时判据跟着漂）。
  // ⚠️ 容差 0.04s（≈2.4 帧）：帧量子化使实测值比常量短 1~2 帧（同焰魔 v3.07）。
  // 旧实现的 **3.45~6.70s** 远在容差外 ⇒ 判别力充足。
  const TOL = 0.04;
  for (const kind of GUARDIAN_ATTACK_IDS) {
    for (const [r, want] of [[0, 1.0], [0.999999, 1.5]]) {
      const gap = measureIdleGap(kind, r);
      assertTrue(Math.abs(gap - want) <= TOL,
        `${kind} rng=${r} 的收势后空档 ${gap.toFixed(3)}s，应 ≈${want}s（±0.04s；旧口径 3.45~6.70）`);
    }
  }
});

test('守卫 AI: 四招的观感节奏一致 —— 空档不再随招式长短漂移', () => {
  // 旧实现的缺陷形态：同一份冷却常量在四招上是 3.45 / 4.57 / 3.58 / 6.68s。
  // ⚠️ **四招必须用同一个 rng**：不同 rng 比的是「随机区间宽度」而不是「招式漂移」（实测踩到）。
  // ⚠️ 极差容差取 1 帧：帧量子化对四招是同一个常量偏移，不会拉开极差。
  const gaps = GUARDIAN_ATTACK_IDS.map((k) => measureIdleGap(k, 0.5));
  const spread = Math.max(...gaps) - Math.min(...gaps);
  assertTrue(spread <= 1 / 60 + 1e-9,
    `四招空档极差 ${spread.toFixed(3)}s（应 ≤1 帧）：${gaps.map((g) => g.toFixed(3)).join(' / ')}`);
});

test('守卫 AI: 空档真的参与起手判断（不是算出来不用）', () => {
  // 负向锚点：把冷却门去掉时「收势一播完就立即起手」⇒ 空档 ≈0。
  // 与上一条的数值判据成对，防「常量对了但没人读」。
  for (const kind of GUARDIAN_ATTACK_IDS) {
    const gap = measureIdleGap(kind, 0);
    assertTrue(gap >= 1.0 - 1 / 60 - 1e-9,
      `${kind} 收势后只隔 ${gap.toFixed(3)}s 就起手（< 1s ⇒ 冷却门没生效）`);
  }
});

test('守卫 AI: 上一招刚打完 → 走回玩家身旁时到位即起手（不干等几秒）', () => {
  // ⚠️ 起始距取 14 格：走到 attackRange(4.25) 需 (14−4.25)/5.4 ≈ 1.81s > 空档上限 1.5s
  // ⇒ 到位时冷却**必已到期**，「到位即起手」是被测语义而不是夹具巧合。
  // 旧口径冷却余 4.7s ⇒ 到位后干等 ≈2.9s，本用例红。
  const START = 14;
  for (const rng of [0, 0.35, 0.7, 0.999999]) {
    const a = new GuardianBossAgent({ rng: () => rng });
    const ctx = { world: groundWorld(9), registry: REGISTRY, player: playerAt(START) };
    let s = st({ mode: 'chase', onGround: true, losVisible: true, losTimer: 1 });
    // ① 先让它打完第一招（动画结束那一帧）
    let prevMode = s.mode;
    let firstDone = false;
    for (let i = 0; i < 900 && !firstDone; i++) {
      s = a.update(s, 1 / 60, ctx);
      if (prevMode === 'attack' && s.mode !== 'attack') firstDone = true;
      prevMode = s.mode;
    }
    assertTrue(firstDone, `rng=${rng} 应先打完一招`);
    // ② 玩家跑到 14 格外（仍在 disengageRange 内 ⇒ 守卫继续 chase）
    const [gx, gy, gz] = s.position;
    const runCtx = { world: groundWorld(9), registry: REGISTRY,
      player: { position: [gx, gy, gz - START] } };
    let arriveT = null;
    let attackT = null;
    for (let i = 0; i < 900; i++) {
      const t = i / 60;
      const d = Math.hypot(s.position[0] - gx, s.position[2] - (gz - START));
      if (arriveT === null && d <= GUARDIAN_AI.attackRange) arriveT = t;
      s = a.update(s, 1 / 60, runCtx);
      if (arriveT !== null && attackT === null && s.mode === 'attack') { attackT = t; break; }
    }
    assertNotNull(arriveT, `rng=${rng} 应走到玩家身旁`);
    assertNotNull(attackT, `rng=${rng} 到位后应起手`);
    assertTrue(attackT - arriveT <= 3 / 60,
      `rng=${rng} 到位后干等 ${(attackT - arriveT).toFixed(3)}s，必须 ≤3 帧（旧口径实测 2.9s）`);
  }
});

// ==================== 站定环（体形相关，判别性） ====================

test('守卫 AI: 追到站定环即停 —— 最近间距同时钉上下界', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const world = groundWorld(9);
  const ctx = { world, registry: REGISTRY, player: { position: [0, 10, -20] } };
  let s = st({ mode: 'chase', position: [0, 10, 0], onGround: true, losVisible: true, losTimer: 1 });
  let minDist = Infinity;
  for (let i = 0; i < 400; i++) {
    s = a.update(s, 1 / 60, ctx);
    minDist = Math.min(minDist, Math.hypot(s.position[0] - 0, s.position[2] + 20));
  }
  // 下界：身体盒半宽 + 玩家半宽（只钉「变远」抓不到穿模）
  assertTrue(minDist > GUARDIAN.halfWidth + 0.3,
    `最近间距 ${minDist.toFixed(3)} 必须 > 1.55（不穿模）`);
  // 上界：防「根本没靠近」的假绿
  assertTrue(minDist <= GUARDIAN_AI.standoffRange + 0.2,
    `最近间距 ${minDist.toFixed(3)} 必须 ≤ 环半径 + 0.2（真的靠近了）`);
});

test('守卫 AI: 站在 standoffRange 上出踩踏（最短的招）仍能命中', () => {
  // spec §5 的真缺陷回归守卫：照抄焰魔 standoffRange 5.0 时这条会红
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const ctx = { ...OPEN_CTX, player: playerAt(GUARDIAN_AI.standoffRange) };
  const s = a.update(st({
    mode: 'attack', attackKind: 'stomp',
    attackAnimT: GUARDIAN_ATTACKS.stomp.hitFrameSeconds - 0.005,
    losVisible: true, losTimer: 1,
  }), 1 / 60, ctx);
  assertNotNull(s.attackRequest, '环上出踩踏必须能产生命中意图');
  assertTrue(GUARDIAN_AI.standoffRange < GUARDIAN_ATTACKS.stomp.hitRange,
    '环半径必须 < 踩踏射程（否则永远打不中）');
});

test('守卫 AI: 死区内不移动（不做比例微调、不绕圈）', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const d = GUARDIAN_AI.standoffRange - GUARDIAN_AI.standoffDeadband / 2;
  const ctx = { ...OPEN_CTX, player: playerAt(d) };
  const s0 = st({ mode: 'chase', losVisible: true, losTimer: 1 });
  const s = run(a, s0, ctx, 60);
  assertTrue(Math.hypot(s.position[0] - s0.position[0], s.position[2] - s0.position[2]) < 1e-6,
    '死区内应逐位不动');
});

test('守卫 AI: 玩家主动贴上来 → 站定不动（不退让）', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  // 贴近但未重叠：2.0 > overlapEscapeDist 1.95；冷却挡住以免进 attack 站定（那测不到走位策略）
  const ctx = { ...OPEN_CTX, player: playerAt(2.0) };
  const s0 = st({ mode: 'chase', losVisible: true, losTimer: 1, attackCooldown: 999 });
  const s = run(a, s0, ctx, 30);
  assertTrue(Math.hypot(s.position[0], s.position[2]) < 1e-6, '贴近但未重叠时站定');
});

test('守卫 AI: 玩家已重叠进身体 → 例外后退自愈', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const ctx = { ...OPEN_CTX, player: playerAt(0.5) };   // < overlapEscapeDist 1.95
  // ⚠️ **必须把全局冷却挡住**（照焰魔同条用例）：否则守卫当帧就进 attack 站定，
  // 自愈根本没机会跑 —— 那是 fixture 错而不是实现错。
  const s = run(a, st({ mode: 'chase', losVisible: true, losTimer: 1, attackCooldown: 999 }), ctx, 30);
  assertTrue(s.position[2] > 0.5, `应背离玩家（+Z）退开，实际 z=${s.position[2]}`);
  assertTrue(Math.hypot(s.position[0], s.position[2] + 0.5) > GUARDIAN_AI.overlapEscapeDist,
    '退开后间距应已超出重叠阈');
});

test('守卫 AI: attack 态水平不动（出招时站定）', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const ctx = { ...OPEN_CTX, player: playerAt(3) };
  const s0 = st({ mode: 'attack', attackKind: 'strong_right', attackAnimT: 0.1, losVisible: true, losTimer: 1 });
  const s = run(a, s0, ctx, 20);
  assertTrue(Math.hypot(s.position[0] - s0.position[0], s.position[2] - s0.position[2]) < 1e-6,
    '出招期水平逐位不动');
});

// ==================== 物理 ====================

test('守卫 AI: 悬空时受重力下落，落到地面后停住', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const world = groundWorld(9);
  let s = st({ position: [0, 20, 0] });
  s = run(a, s, { world, registry: REGISTRY }, 200);
  assertTrue(s.onGround, '应已落地');
  assertTrue(Math.abs(s.position[1] - 10) < 0.05, `脚底应贴 y=10，实际 ${s.position[1]}`);
});

test('守卫 AI: 走上 1 格台阶（step-up 生效）', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  // y<=9 地面；z<=-3 处多一层（y=10 实心）⇒ 一格台阶
  const world = makeWorld((_x, y, z) => y <= 9 || (z <= -3 && y <= 10));
  const ctx = { world, registry: REGISTRY, player: { position: [0, 11, -12] } };
  let s = st({ mode: 'chase', position: [0, 10, 0], onGround: true, losVisible: true, losTimer: 1 });
  s = run(a, s, ctx, 200);
  assertTrue(s.position[1] > 10.9, `应已登上台阶（y≈11），实际 ${s.position[1]}`);
});

test('守卫 AI: 2 格高台阶上不去（maxStep=1.0 的真实上限）', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const world = makeWorld((_x, y, z) => y <= 9 || (z <= -3 && y <= 11));
  const ctx = { world, registry: REGISTRY, player: { position: [0, 12, -12] } };
  let s = st({ mode: 'chase', position: [0, 10, 0], onGround: true, losVisible: true, losTimer: 1 });
  s = run(a, s, ctx, 200);
  assertTrue(s.position[1] < 10.9, `2 格台阶不该上去，实际 y=${s.position[1]}`);
});

test('守卫 AI: 被埋进方块 → 向上解卡到首个可站 y', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  // y<=12 全实心 ⇒ 脚底 10 被埋；首个可站是 13
  const world = makeWorld((_x, y, _z) => y <= 12);
  const s = a.update(st({ position: [0, 10, 0] }), 1 / 60, { world, registry: REGISTRY });
  assertTrue(s.position[1] >= 13, `应解卡到 y≥13，实际 ${s.position[1]}`);
});

test('守卫 AI: 未被埋时位置逐位不变（解卡常态零副作用）', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const world = groundWorld(9);
  const s = a.update(st({ position: [0, 10, 0], onGround: true }), 0, { world, registry: REGISTRY });
  assertEqual(s.position[1], 10, 'dt=0 且未埋 ⇒ y 逐位不变');
});

// ==================== 脱困（Review Focus #2） ====================

test('守卫 AI: 意图恒为零的三重零意图态也会累计卡住并起跳', () => {
  // 死区内 + 看不见玩家 + A* 无解（navDir=null）—— 焰魔 v2.63 的真缺陷形态
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const d = GUARDIAN_AI.standoffRange - GUARDIAN_AI.standoffDeadband / 2;
  const wall = makeWorld((_x, y, z) => y <= 9 || (z === -2 && y >= 10 && y <= 14));
  const ctx = { world: wall, registry: REGISTRY, player: playerAt(d) };
  let s = st({ mode: 'chase', onGround: true, navDir: null });
  let sawLeap = false;
  for (let i = 0; i < Math.ceil((GUARDIAN_AI.stuckLeapSeconds + 1) * 60); i++) {
    s = a.update(s, 1 / 60, ctx);
    if (s.mode === 'leap') { sawLeap = true; break; }
  }
  assertTrue(sawLeap, '零意图态必须也能触发脱困跳（否则永久僵住）');
  assertEqual(s.leapKind, 'escape', '守卫的 leap 只服务脱困');
});

test('守卫 AI: 开阔地追击不误触发脱困', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const world = groundWorld(9);
  const ctx = { world, registry: REGISTRY, player: { position: [0, 10, -30] } };
  let s = st({ mode: 'chase', onGround: true, losVisible: true, losTimer: 1 });
  for (let i = 0; i < 300; i++) {
    s = a.update(s, 1 / 60, ctx);
    assertFalse(s.mode === 'leap', '开阔地不该起跳');
  }
});

test('守卫 AI: 死区站定 + 看得见玩家 → 不算卡住（正确行为不误判）', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const d = GUARDIAN_AI.standoffRange - GUARDIAN_AI.standoffDeadband / 2;
  const ctx = { ...OPEN_CTX, player: playerAt(d) };
  let s = st({ mode: 'chase', losVisible: true, losTimer: 1 });
  s = run(a, s, ctx, Math.ceil((GUARDIAN_AI.stuckLeapSeconds + 1) * 60));
  assertFalse(s.mode === 'leap', '站定连砍是正确行为，不得起跳');
  assertEqual(s.stuckT, 0, 'stuckT 应钉 0');
});

test('守卫 AI: leap 落地回 chase 且 stuckT 清零', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const world = groundWorld(9);
  // ⚠️ 冷却挡住：否则落地回 chase 后**当帧就因距玩家在 attackRange 内而起手**
  //（那是正确行为）⇒ 跑固定 200 帧后看到的是 attack，不是落地那一帧的 chase。
  const ctx = { world, registry: REGISTRY, player: playerAt(3) };
  let s = st({
    mode: 'leap', leapKind: 'escape', leapDir: [0, -GUARDIAN_AI.leapSpeed],
    leapT: 0, position: [0, 10, 0], onGround: true, velocity: [0, GUARDIAN_AI.leapJumpForce, 0],
    attackCooldown: 999,
  });
  let landedFrame = -1;
  for (let i = 0; i < 200; i++) {
    s = a.update(s, 1 / 60, ctx);
    if (s.mode !== 'leap') { landedFrame = i; break; }
  }
  assertTrue(landedFrame >= 0, '应在有限帧内离开 leap');
  assertEqual(s.mode, 'chase', '落地应回 chase');
  assertNull(s.leapKind);
  assertEqual(s.stuckT, 0);
});

test('守卫 AI: leap 超过 leapMaxSeconds → 安全阀强制结束', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  // 无地面 ⇒ 永远落不了地，只能靠安全阀
  const ctx = { ...OPEN_CTX, player: playerAt(3) };
  let s = st({
    mode: 'leap', leapKind: 'escape', leapDir: [0, -GUARDIAN_AI.leapSpeed],
    leapT: GUARDIAN_AI.leapMaxSeconds - 0.01, position: [0, 100, 0],
  });
  s = run(a, s, ctx, 5);
  assertFalse(s.mode === 'leap', '安全阀必须生效（低净空房间靠它回 chase）');
});

test('守卫 AI: 前 3 次脱困是普通跳，第 4 次升级强化跳', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const d = GUARDIAN_AI.standoffRange - GUARDIAN_AI.standoffDeadband / 2;
  const wall = makeWorld((_x, y, z) => y <= 9 || (z === -2 && y >= 10 && y <= 14));
  const ctx = { world: wall, registry: REGISTRY, player: playerAt(d) };
  const g = Math.abs(GUARDIAN_AI.gravity);
  const apexes = [];
  let s = st({ mode: 'chase', onGround: true, navDir: null, attackCooldown: 999 });
  for (let k = 0; k < 4; k++) {
    for (let i = 0; i < 600; i++) {
      s = a.update(s, 1 / 60, ctx);
      if (s.mode === 'leap') break;
    }
    assertEqual(s.mode, 'leap', `第 ${k + 1} 次应起跳`);
    // ⚠️ **起跳当帧已跑了一个物理步**，读到的 vy 已减 g·dt（实测 11 → 10.6）。
    // 拿它当初速算顶点会恒偏低（2.34 vs 2.52）⇒ 必须加回一步重力反推初速。
    const v0 = s.velocity[1] + g / 60;
    apexes.push(v0 ** 2 / (2 * g));
    s = {
      ...s, mode: 'chase', leapKind: null, leapDir: null, leapT: 0,
      onGround: true, velocity: [0, 0, 0],
    };
  }
  for (let k = 0; k < 3; k++) {
    assertTrue(Math.abs(apexes[k] - GUARDIAN_AI.leapJumpForce ** 2 / (2 * g)) < 1e-6,
      `第 ${k + 1} 次应是普通跳，顶点 ${apexes[k]}`);
  }
  assertTrue(apexes[3] >= GUARDIAN_AI.escapeLeapApexMin - 1e-6,
    `第 4 次应升级强化跳，顶点 ${apexes[3]}`);
});

test('守卫 AI: 脱困方向随机（不同 rng 给不同方向）', () => {
  const d = GUARDIAN_AI.standoffRange - GUARDIAN_AI.standoffDeadband / 2;
  const wall = makeWorld((_x, y, z) => y <= 9 || (z === -2 && y >= 10 && y <= 14));
  const dirs = [];
  for (const r of [0.1, 0.6]) {
    const a = new GuardianBossAgent({ rng: () => r });
    let s = st({ mode: 'chase', onGround: true, navDir: null });
    for (let i = 0; i < 600; i++) {
      s = a.update(s, 1 / 60, { world: wall, registry: REGISTRY, player: playerAt(d) });
      if (s.mode === 'leap') break;
    }
    dirs.push(s.leapDir);
  }
  assertTrue(Math.hypot(dirs[0][0] - dirs[1][0], dirs[0][1] - dirs[1][1]) > 0.1,
    '不同 rng 应给不同飞跃方向');
});

test('守卫 AI: 永不出现跳跃劈砍（leapKind 恒 escape）', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const world = groundWorld(9);
  // 扫遍「够不着」的距离窗（焰魔在 8~14 格会跳劈）
  for (const d of [8, 10, 12, 14]) {
    let s = st({ mode: 'chase', onGround: true, losVisible: true, losTimer: 1 });
    for (let i = 0; i < 120; i++) {
      s = a.update(s, 1 / 60, { world, registry: REGISTRY, player: { position: [0, 10, -d] } });
      assertFalse(s.leapKind === 'attack', `距 ${d} 格不得跳劈（原版守卫无此招）`);
    }
  }
});

// ==================== 感知间隔 ====================

test('守卫 AI: 首次感知立即执行（召唤后不呆立 1~2 秒）', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const world = groundWorld(9);
  const ctx = { world, registry: REGISTRY, player: { position: [0, 10, -20] } };
  const s = a.update(st({ mode: 'chase', onGround: true, losVisible: true, losTimer: 1 }), 1 / 60, ctx);
  assertNotNull(s.sensedPlayer, '首帧必须已采样');
  assertTrue(Math.abs(s.position[2]) > 1e-6, '首帧就该开始移动');
});

test('守卫 AI: chase 读感知快照 —— 玩家瞬移后仍朝旧方向走', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const world = groundWorld(9);
  let s = st({ mode: 'chase', onGround: true, losVisible: true, losTimer: 1 });
  const ctx = { world, registry: REGISTRY, player: { position: [0, 10, -20] } };
  s = a.update(s, 1 / 60, ctx);
  const z0 = s.position[2];
  // 玩家瞬移到反方向，但感知间隔未到 ⇒ 仍朝旧方向
  const ctx2 = { world, registry: REGISTRY, player: { position: [0, 10, 20] } };
  s = a.update(s, 1 / 60, ctx2);
  assertTrue(s.position[2] < z0, '应仍朝旧快照方向（−Z）走');
});

test('守卫 AI: 玩家离开 disengageRange 时清空快照', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const ctx = { ...OPEN_CTX, player: playerAt(GUARDIAN_AI.disengageRange + 5) };
  const s = a.update(st({ mode: 'chase', sensedPlayer: [0, 10, -20], senseTimer: 1 }), 1 / 60, ctx);
  assertNull(s.sensedPlayer, '脱离后应清空快照');
});

test('守卫 AI: 视线按 losInterval 缓存（不每帧重查）', () => {
  let calls = 0;
  const world = {
    isSolid: () => false,
    getBlockId: () => { calls++; return 0; },
  };
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  let s = st({ mode: 'chase' });
  const ctx = { world, registry: REGISTRY, player: playerAt(10) };
  s = a.update(s, 1 / 60, ctx);
  const first = calls;
  assertTrue(first > 0, '首帧应查过视线');
  for (let i = 0; i < 5; i++) s = a.update(s, 1 / 60, ctx);
  assertEqual(calls, first, '缓存期内不得重查');
});

// ==================== 寻路接线 ====================

test('守卫 AI: 长墙挡路 → 标记 needsPath', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  // 一堵横墙挡住直路（z=-3，x 方向很长）
  const world = makeWorld((x, y, z) => y <= 9 || (z === -3 && x >= -20 && x <= 20 && y <= 13));
  const ctx = { world, registry: REGISTRY, player: { position: [0, 10, -12] } };
  let s = st({ mode: 'chase', position: [0, 10, 0], onGround: true, losVisible: false, losTimer: 1 });
  let saw = false;
  for (let i = 0; i < 60; i++) {
    s = a.update(s, 1 / 60, ctx);
    if (s.needsPath) { saw = true; break; }
  }
  assertTrue(saw, '被墙挡住应标记需要寻路');
});

test('守卫 AI: 无障碍直线追击时不标记寻路（开阔地零 A* 开销）', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const world = groundWorld(9);
  const ctx = { world, registry: REGISTRY, player: { position: [0, 10, -20] } };
  let s = st({ mode: 'chase', onGround: true, losVisible: true, losTimer: 1 });
  for (let i = 0; i < 60; i++) {
    s = a.update(s, 1 / 60, ctx);
    assertFalse(s.needsPath, '开阔地不该每拍跑 A*');
  }
});

test('守卫 AI: navDir 原样透传（Agent 不改寻路层的结果）', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const ctx = { ...OPEN_CTX, player: playerAt(10) };
  const s = a.update(st({ mode: 'chase', navDir: [1, 0], navMode: 'astar' }), 1 / 60, ctx);
  assertEqual(JSON.stringify(s.navDir), JSON.stringify([1, 0]));
  assertEqual(s.navMode, 'astar');
});

// ==================== 水平意图写回 velocity（v3.09 步态接线）====================
//
// **为什么需要**：渲染器的程序化步态判「在移动」读的是 `state.velocity[0]/[2]`，
// 而旧实现恒返回 `[0, vy, 0]` ⇒ 那套原版 walk() 摆腿代码**从未执行过**
// （用户 2026-11-16 实玩报告「移动时双腿没有踱步的动作」）。
// 与丧尸/焰魔同口径：AI 意图写进 `state.velocity`，**不另设 intent 容器**。

test('守卫 AI: chase 追击时把水平意图写回 velocity（渲染步态据此判「在移动」）', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const ctx = { world: groundWorld(9), registry: REGISTRY, player: playerAt(12) };
  const s = a.update(st({ mode: 'chase', onGround: true, losVisible: true, losTimer: 1 }), 1 / 60, ctx);
  assertEqual(s.mode, 'chase', '前提：12 格外不该起手');
  assertTrue(Math.hypot(s.velocity[0], s.velocity[2]) > 1,
    `水平意图须写回 velocity，实际 ${JSON.stringify(s.velocity)}`);
  assertTrue(s.velocity[2] < 0, '玩家在 −Z ⇒ vz 须为负');
});

test('守卫 AI: attack / idle / 死区站定时水平 velocity 恒 0（静止不摆腿）', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const world = groundWorld(9);
  const cases = [
    { mode: 'idle', player: playerAt(12) },
    { mode: 'attack', player: playerAt(3), over: { attackKind: 'stomp', attackAnimT: 0.1 } },
    { mode: 'chase', player: playerAt(3.2) },      // 站定环 3.5 死区 0.75 ⇒ 站定
  ];
  for (const c of cases) {
    const s = a.update(st({ onGround: true, losVisible: true, losTimer: 1, mode: c.mode, ...(c.over || {}) }),
      1 / 60, { world, registry: REGISTRY, player: c.player });
    assertEqual(s.velocity[0], 0, `${c.mode} 水平 vx 须 0`);
    assertEqual(s.velocity[2], 0, `${c.mode} 水平 vz 须 0`);
  }
});

test('守卫 AI: 飞跃期贴近玩家时意图非零而净位移为 0（渲染层据此判「不滑步」）', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  // 这是「意图非零但走不动」的**真实可构造路径**：物理步里的「防穿玩家」门
  //（水平距 < standoffRange − deadband = 2.75）把本步 stepVx/stepVz 清零，
  // 而 `wantVx/wantVz`（= leapDir）保留 ⇒ 写回的 velocity 非零、位置不动。
  // ⚠️ 不得改用「四面墙围住」夹具：实测那样 `steerIntentAabb` 会把意图**归零**
  //（或沿墙侧滑仍有位移），两侧都测不到「意图非零 + 位移 0」。
  const ctx = { world: groundWorld(9), registry: REGISTRY, player: { position: [0, 10, -1.0] } };
  let s = st({
    mode: 'leap', leapKind: 'escape', leapDir: [0, -GUARDIAN_AI.leapSpeed], leapT: 0,
    onGround: true, losVisible: false, losTimer: 999, attackCooldown: 999,
  });
  const p0 = s.position.slice();
  let minIntent = Infinity;
  let maxDisp = 0;
  let prev = s.position.slice();
  for (let i = 0; i < 40; i++) {
    s = a.update(s, 1 / 60, ctx);
    minIntent = Math.min(minIntent, Math.hypot(s.velocity[0], s.velocity[2]));
    maxDisp = Math.max(maxDisp, Math.hypot(s.position[0] - prev[0], s.position[2] - prev[2]));
    prev = s.position.slice();
  }
  assertEqual(s.mode, 'leap', '夹具前提：40 帧内不得离开 leap（否则测的不是这件事）');
  assertTrue(minIntent > 1, `意图不得被清零，实测最小 ${minIntent}`);
  assertTrue(maxDisp < 1e-6, `贴近玩家时逐帧位移须为 0，实测最大 ${maxDisp}`);
  assertTrue(Math.hypot(s.position[0] - p0[0], s.position[2] - p0[2]) < 1e-6, '净位移须为 0');
});
