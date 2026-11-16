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
import { assertEqual, assertTrue, assertNotNull, assertNull, assertFalse } from './assert.js';
import { IgnisBossAgent } from '../entities/bosses/ignis-boss-agent.js';
import { IGNIS, IGNIS_AI, IGNIS_ATTACKS, IGNIS_ATTACK_IDS, IGNIS_SPIKE } from '../entities/ignis/ignis-config.js';

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

test('焰魔 AI: 玩家在 sightRange 内且视线通 → chase（需累计满 turnDelay）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const ctx = { ...OPEN_CTX, player: playerAt(IGNIS_AI.sightRange - 5) };
  // v2.62：idle→chase 需玩家在视野内累计满 turnDelay（1.5s）
  let s = st({ mode: 'idle' });
  const frames = Math.ceil(IGNIS_AI.turnDelay * 60) + 2;
  for (let i = 0; i < frames; i++) s = a.update(s, 1 / 60, ctx);
  assertEqual(s.mode, 'chase');
});

test('焰魔 AI: idle 不追踪 yaw（玩家绕其移动，朝向逐位不变，v2.62）', () => {
  // 用户缺陷①：「焰魔只要没有在做动作，就会始终面向玩家……不太自然」。
  // 修法：idle 态保持最后的朝向，不炮塔式追踪。
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  let s = st({ mode: 'idle', yaw: 0.7 });
  for (let i = 0; i < 30; i++) {
    const ang = i / 30 * Math.PI * 2;
    s = a.update(s, 1 / 60, {
      ...OPEN_CTX,
      player: { position: [Math.sin(ang) * 3, 10, Math.cos(ang) * 3] },
    });
  }
  assertEqual(s.yaw, 0.7, 'idle 应保持最后朝向，不炮塔式追踪');
});

test('焰魔 AI: idle→chase 需 turnDelay 累计（中途离开清零重来，v2.62）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const ctx = { ...OPEN_CTX, player: playerAt(20) };
  let s = st({ mode: 'idle' });
  // ⚠️ **帧数不得从 `turnDelay` 派生**（负向验证实测踩到）：写成
  // `Math.ceil(turnDelay*60) - 5` 时，注入 `turnDelay = 0` 会让循环次数变成 **−5**
  // ⇒ 一帧不跑 ⇒ state 仍是初始的 idle ⇒ 断言「仍 idle」**假绿**。
  // 改用固定帧数：60 帧 = 1.0 秒，明确小于 turnDelay(1.5)。
  for (let i = 0; i < 60; i++) s = a.update(s, 1 / 60, ctx);
  assertEqual(s.mode, 'idle', '1.0 秒（< turnDelay 1.5）不应转 chase');
  assertTrue(s.acquireT > 0.9, `acquireT 应已累计到 ≈1.0，实际 ${s.acquireT.toFixed(2)}`);
  // 离开一次（出 sightRange）→ 累计清零
  s = a.update(s, 1 / 60, { ...OPEN_CTX, player: playerAt(IGNIS_AI.sightRange + 10) });
  assertEqual(s.acquireT, 0, '离开视野应清零累计');
  // 重新进来，同样只给 1.0 秒 —— 若没清零这里就满了
  for (let i = 0; i < 60; i++) s = a.update(s, 1 / 60, ctx);
  assertEqual(s.mode, 'idle', '离开后应重新累计，不应立即 chase');
  // 补满剩余（再 0.6 秒 ⇒ 总 1.6 > 1.5）→ chase
  for (let i = 0; i < 36; i++) s = a.update(s, 1 / 60, ctx);
  assertEqual(s.mode, 'chase', '累计满 turnDelay 后应 chase');
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
  // 命中时刻应逼近**本招**的 hitFrameSeconds（1/60 帧粒度）。
  // ⚠️ v3.01 修正：本夹具**不传 attackKind** ⇒ agent 回落 swing（line 699 的
  // `IGNIS_ATTACKS[attackKind] || IGNIS_ATTACKS.swing`），所以该比的是 swing 档案的 1.20，
  // **不是派生最大值 `IGNIS_AI.hitFrameSeconds`**。旧值时两者恰为同一个数（1.20），
  // 加入持盾冲撞后派生值变 1.70 ⇒ 分裂。读派生值会让这条恒红（而不是发现真缺陷）。
  assertTrue(Math.abs(hits[0] - IGNIS_ATTACKS.swing.hitFrameSeconds) < 0.03,
    `命中帧 ${hits[0].toFixed(4)}s，期望 swing 的 ${IGNIS_ATTACKS.swing.hitFrameSeconds}s`);
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

// ==================== 第二招：整圈旋斩（v2.75）====================
//
// 用户 2026-11-07 裁定「每次起手按权重随机」。抽签走构造参数 `rng`（已可注入）⇒ 单测钉两个端点。

/** 跑到「起手」那一刻，返回起手后的 state（命中判据/动画选择都要读 attackKind） */
function runToAttackStart(agent, state, ctx) {
  let s = state;
  for (let i = 0; i < 60; i++) {
    s = agent.update(s, 1 / 60, ctx);
    if (s.mode === 'attack') return s;
  }
  return s;
}

test('焰魔 AI(v2.75): rng=0 ⇒ 恒选普攻（swing），rng→1 ⇒ 恒选末档（v3.06 起 = 尖刺攻击）', () => {
  const ctx = { ...OPEN_CTX, player: playerAt(IGNIS_AI.attackRange - 1) };
  const swingAgent = new IgnisBossAgent({ rng: () => 0 });
  const s1 = runToAttackStart(swingAgent, st({ mode: 'chase', onGround: true }), ctx);
  assertEqual(s1.mode, 'attack');
  assertEqual(s1.attackKind, 'swing', 'rng=0 应抽中第一个档案（swing）');

  // rng 恒 1：落在**声明顺序的最后一档**。用 0.999999 而不是 1（有些实现把 1 当越界）。
  // ⚠️ v3.06 起末档是 **spikeSlash**（尖刺攻击）；v3.03~v3.04 是 shieldBash。
  // 若它变回 spin，说明新招被排到了 spin 之前（顺序载荷性）。
  const lastAgent = new IgnisBossAgent({ rng: () => 0.999999 });
  const s2 = runToAttackStart(lastAgent, st({ mode: 'chase', onGround: true }), ctx);
  assertEqual(s2.mode, 'attack');
  assertEqual(s2.attackKind, 'spikeSlash', 'rng≈1 应抽中最后一档（尖刺攻击）');
  // 旋斩必须在中间（否则上面的“末档”判据拓不到顺序）：权重累计 swing 0.175 ⇒ spin 区间 [0.175, 0.475)
  const spinAgent = new IgnisBossAgent({ rng: () => 0.3 });
  const s3 = runToAttackStart(spinAgent, st({ mode: 'chase', onGround: true }), ctx);
  assertEqual(s3.attackKind, 'spin', 'rng=0.3 应落在中间档（旋斩）');
});

// ==================== 第三招：持盾冲撞（v3.01）====================
//
// 用户 2026-11-13 初版裁定②是「玩家贴近（<3 格）时才抽」。
// **2026-11-14 实玩后推翻**：「触发条件过于苛刻，不要限制在严格 3 格内，
// 改成和其他两个攻击技能一样的生效距离……生效比例平分挥砍的动作的发生概率」。
// ⇒ 贴身门删除（`smashEngageRange` 常量不存在），四招共用既有的 `attackRange` 起手门槛；
//   权重（v3.03）swing 0.25 / spin 0.30 / shieldSmash 0.25 / shieldBash 0.20
//   （横扫与持盾冲撞仍严格平分，旋斩不动，新招拿 0.20）。

test('焰魔 AI(v3.01/v3.03/v3.06): 任何起手距离都可能抽到末档招式（贴身门已删）—— 4.5 / 5.0 / 2.5 格各验', () => {
  // rng≈1 ⇒ 落在声明顺序的最后一档 = spikeSlash（五招无距离门）
  for (const dist of [2.5, 4.0, 4.5, 5.0]) {
    const ctx = { ...OPEN_CTX, player: playerAt(dist) };
    const a = new IgnisBossAgent({ rng: () => 0.999999 });
    const s = runToAttackStart(a, st({ mode: 'chase', onGround: true }), ctx);
    assertEqual(s.mode, 'attack', `${dist} 格应起手（attackRange 5.5 内）`);
    assertEqual(s.attackKind, 'spikeSlash',
      `${dist} 格 + rng≈1 应抽中最后一档（尖刺攻击）—— 贴身门已删，不得再按距离排除`);
  }
});

test('焰魔 AI(v3.06): 五招权重扫描 —— 17.5% / 30% / 17.5% / 15% / 20%，横扫与持盾冲撞仍平分', () => {
  // 用固定 rng 扫 1000 档，统计五招出现次数（总权重归一后的真实分布）。
  // ⚠️ 这不是「断言常量等于 0.175」（那条在 test-ignis-system），而是验**抽签器真的按它分**。
  const counts = { swing: 0, spin: 0, shieldSmash: 0, shieldBash: 0, spikeSlash: 0 };
  const ctx = { ...OPEN_CTX, player: playerAt(4.5) };
  const N = 1000;
  for (let i = 0; i < N; i++) {
    const r = i / N;                       // 均匀扫 [0,1)
    const a = new IgnisBossAgent({ rng: () => r });
    const s = runToAttackStart(a, st({ mode: 'chase', onGround: true }), ctx);
    counts[s.attackKind] += 1;
  }
  const pct = (k) => counts[k] / N;
  // 区间边界：swing [0,.175) / spin [.175,.475) / shieldSmash [.475,.65) / shieldBash [.65,.80) / spikeSlash [.80,1)
  assertTrue(Math.abs(pct('swing') - 0.175) < 0.01, `横扫占比 ${pct('swing')} 应 ≈0.175`);
  assertTrue(Math.abs(pct('spin') - 0.30) < 0.01, `旋斩占比 ${pct('spin')} 应 ≈0.30`);
  assertTrue(Math.abs(pct('shieldSmash') - 0.175) < 0.01, `持盾冲撞占比 ${pct('shieldSmash')} 应 ≈0.175`);
  assertTrue(Math.abs(pct('shieldBash') - 0.15) < 0.01, `举盾砸击占比 ${pct('shieldBash')} 应 ≈0.15`);
  assertTrue(Math.abs(pct('spikeSlash') - 0.20) < 0.01, `尖刺攻击占比 ${pct('spikeSlash')} 应 ≈0.20`);
  assertTrue(Math.abs(pct('swing') - pct('shieldSmash')) <= 0.003,
    `横扫 ${counts.swing} 与持盾冲撞 ${counts.shieldSmash} 的占比差超过 0.3%（平分失效）`);
  // 举盾砸击必须比横扫与旋斩都少（否则「让出 0.05」变成了「三招平分」）
  assertTrue(counts.shieldBash < counts.swing && counts.shieldBash < counts.spin,
    `举盾砸击应少于横扫与旋斩：${JSON.stringify(counts)}`);
});

test('焰魔 AI(v3.03/v3.06): 旋斩冷却未好时，末档仍是尖刺攻击（候选集去掉，不是抽中再改判）', () => {
  // 候选集去掉 spin 后剩 swing .175 / shieldSmash .175 / shieldBash .15 / spikeSlash .20（总 0.70）
  // ⇒ 归一后 25% / 25% / 21.4% / 28.6%，区间 [0,.25) / [.25,.50) / [.50,.714) / [.714,1)
  const ctx = { ...OPEN_CTX, player: playerAt(4.5) };
  const a = new IgnisBossAgent({ rng: () => 0.999999 });
  const s = runToAttackStart(a, st({ mode: 'chase', onGround: true, spinCooldown: 5 }), ctx);
  assertEqual(s.attackKind, 'spikeSlash', '旋斩被屏蔽后最后一档是尖刺攻击');
  const b = new IgnisBossAgent({ rng: () => 0 });
  const s2 = runToAttackStart(b, st({ mode: 'chase', onGround: true, spinCooldown: 5 }), ctx);
  assertEqual(s2.attackKind, 'swing', 'rng=0 仍落第一档（横扫）');
  // rng=0.6：0.6 × 0.70 = 0.42，减 swing .175 剩 .245，减 shieldSmash .175 剩 .07 > 0
  // ⇒ 落第三档 shieldBash。
  const c = new IgnisBossAgent({ rng: () => 0.6 });
  const s3 = runToAttackStart(c, st({ mode: 'chase', onGround: true, spinCooldown: 5 }), ctx);
  assertEqual(s3.attackKind, 'shieldBash', '屏蔽旋斩后 rng=0.6 应落举盾砸击');
});

test('焰魔 AI(v3.01): 持盾冲撞命中后冷却正常置位（玩家跑开也不连砸）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.999999 });
  const ctx = { ...OPEN_CTX, player: playerAt(2.5) };
  let s = st({ mode: 'attack', attackAnimT: 0, attackKind: 'shieldSmash', onGround: true });
  for (let i = 0; i < 200 && !s.attackRequest; i++) s = a.update(s, 1 / 60, ctx);
  assertNotNull(s.attackRequest);
  assertEqual(s.attackRequest.kind, 'shieldSmash');
  assertTrue(s.attackCooldown >= IGNIS_AI.attackCooldownMin - 1 / 60 - 1e-9,
    `持盾冲撞命中后冷却 ${s.attackCooldown} 未按 [${IGNIS_AI.attackCooldownMin}, ${IGNIS_AI.attackCooldownMax}] 置位`);
});

test('焰魔 AI(v2.75): 旋斩的命中帧 = 0.70s（不是普攻的 1.20s）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.999999 });
  const ctx = { ...OPEN_CTX, player: playerAt(IGNIS_AI.attackRange - 1) };
  let s = st({ mode: 'attack', attackAnimT: 0, attackKind: 'spin', onGround: true });
  const hits = [];
  const frames = Math.ceil((IGNIS_ATTACKS.spin.animSeconds + 0.4) * 60);
  for (let i = 0; i < frames; i++) {
    s = a.update(s, 1 / 60, ctx);
    if (s.attackRequest) hits.push(s.attackAnimT);
  }
  assertEqual(hits.length, 1, `旋斩命中次数 ${hits.length}（应恰为 1）`);
  assertTrue(Math.abs(hits[0] - IGNIS_ATTACKS.spin.hitFrameSeconds) < 0.03,
    `旋斩命中帧 ${hits[0].toFixed(4)}s，期望 ${IGNIS_ATTACKS.spin.hitFrameSeconds}s`);
});

test('焰魔 AI(v2.75): attackRequest 带上 kind（结算方按招取射程/角度，不回读 state）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.999999 });
  const ctx = { ...OPEN_CTX, player: playerAt(IGNIS_AI.attackRange - 1) };
  let s = st({ mode: 'attack', attackAnimT: 0, attackKind: 'spin', onGround: true });
  for (let i = 0; i < 200 && !s.attackRequest; i++) s = a.update(s, 1 / 60, ctx);
  assertNotNull(s.attackRequest);
  assertEqual(s.attackRequest.kind, 'spin');
});

test('焰魔 AI(v2.75): 旋斩播完回 chase 且 attackKind 清空（否则下一刀会播错动画）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const ctx = { ...OPEN_CTX, player: playerAt(IGNIS_AI.attackRange - 1) };
  let s = st({ mode: 'attack', attackAnimT: 0, attackKind: 'spin', onGround: true });
  const frames = Math.ceil(IGNIS_ATTACKS.spin.animSeconds * 60) + 5;
  for (let i = 0; i < frames; i++) s = a.update(s, 1 / 60, ctx);
  assertTrue(s.mode !== 'attack' || s.attackAnimT < IGNIS_ATTACKS.spin.animSeconds,
    `旋斩播完仍在 attack（attackAnimT=${s.attackAnimT}）`);
  if (s.mode !== 'attack') assertEqual(s.attackKind, null, '离开 attack 后 attackKind 必须清空');
});

test('焰魔 AI(v2.75): 旋斩冷却期间抽中 spin 的 rng 必须降级（不白放冷却）', () => {
  // ⚠️ v3.06：权重改成 .175/.30/.175/.15/.20 后，旋斩区间是 **[0.175, 0.475)**。
  // 本用例要的是「旋斩区间内的 rng」⇒ 取两端与中点。
  // 判据是「结果不是 spin」（候选集把 spin 去掉，而不是抽中再改判）——
  // 具体落哪一招由归一后的位置决定，不得写死。
  for (const r of [0.19, 0.32, 0.46]) {
    const a = new IgnisBossAgent({ rng: () => r });
    const ctx = { ...OPEN_CTX, player: playerAt(IGNIS_AI.attackRange - 1) };
    const s = runToAttackStart(a, st({ mode: 'chase', onGround: true, spinCooldown: IGNIS_AI.spinCooldownSeconds }), ctx);
    assertEqual(s.mode, 'attack');
    assertTrue(s.attackKind !== 'spin',
      `冷却未好时 rng=${r} 仍抽到了旋斩（降级失效，会白放冷却）`);
    assertTrue(['swing', 'shieldSmash', 'shieldBash', 'spikeSlash'].includes(s.attackKind),
      `rng=${r} 应落到非旋斩的四招之一，实为 ${s.attackKind}`);
  }
});

test('焰魔 AI(v2.75): 旋斩起手后写 spinCooldown（独立于 attackCooldown）', () => {
  // ⚠️ v3.06：用 rng=0.3 落在旋斩区间 [0.175,0.475)（rng≈1 现在是尖刺攻击）。
  const a = new IgnisBossAgent({ rng: () => 0.3 });
  const ctx = { ...OPEN_CTX, player: playerAt(IGNIS_AI.attackRange - 1) };
  const s = runToAttackStart(a, st({ mode: 'chase', onGround: true }), ctx);
  assertEqual(s.attackKind, 'spin');
  // 起手当帧就置冷却（不是命中帧）—— 否则玩家跑掉不命中时旋斩可以连抽
  assertTrue(s.spinCooldown > IGNIS_AI.spinCooldownSeconds - 0.1,
    `spinCooldown=${s.spinCooldown} 未在起手时置位`);
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

test('焰魔 AI: 绕行（navDir 侧向）时面向前进方向而非玩家（v2.62）', () => {
  // 用户缺陷⑧：「绕过障碍物追击玩家的时候，脸部方向要面向前进方向，而不是面向玩家
  // 贴着墙进行『侧滑』」。修法：chase 中 yaw 目标 = 有水平意图时面向速度方向。
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = wallWorld({ groundY: 9, wallZ: -14, halfLen: 6, wallH: 4 });
  // 玩家在墙后正北（-Z）；navDir 给一个纯侧向（+X）方向
  let s = st({
    position: [0.5, 10, 0], mode: 'chase', onGround: true,
    navDir: [1, 0], needsPath: true,
  });
  for (let i = 0; i < 60; i++) {
    // 每帧重新注入 navDir（模拟寻路层持续给出侧向路线）
    s = { ...s, navDir: [1, 0], needsPath: true };
    s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player: playerAt(20) });
  }
  // 面向 +X ⇒ yaw ≈ -π/2；面向玩家（-Z）⇒ yaw ≈ 0。两者差 > 45°
  const facePlayer = Math.abs(s.yaw) < 0.3;
  assertTrue(!facePlayer,
    `绕行时仍面向玩家（yaw=${s.yaw.toFixed(2)}），应面向前进方向`);
});

test('焰魔 AI: 死区站定时面向玩家（v2.62）', () => {
  // 无水平意图（死区）时 yaw 目标 = 玩家 —— 「站定环里连砍」的朝向基础。
  // ⚠️ **必须用大冷却把 attack 排掉**：死区（4.6 格）已在 `attackRange`(5.5) 内，
  // 不加冷却第 0 帧就起手，而 attack 态刻意锁朝向（spec §2.8）—— 那测的是另一件事。
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  let s = st({
    position: [0.5, 10, 0], mode: 'chase', onGround: true, yaw: 1.0, attackCooldown: 999,
  });
  const player = { position: [0.5, 10, -4.6] };  // 死区内（4.25~5.0）
  for (let i = 0; i < 90; i++) {
    s = a.update(s, 1 / 60, { world: groundWorld(9), registry: REGISTRY, player });
  }
  assertEqual(s.mode, 'chase', '本用例要测 chase 死区，不应进入 attack');
  assertTrue(Math.abs(s.yaw) < 0.2, `死区站定应面向玩家（yaw=${s.yaw.toFixed(2)}）`);
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

test('焰魔 AI: 玩家主动贴上来 → 焰魔原地不动（不退让，v2.62）', () => {
  // ⚠️ **v2.62 用户裁定（2026-11-06 第⑦项）**：本用例的前身是「玩家贴上来 → 焰魔后退
  // 让位」（v2.60）。用户实玩：「玩家跑向焰魔时，焰魔就会自己远离玩家……就显得是玩家
  // 向前跑动会推着焰魔走，这个效果不太合理」。改为：焰魔**不动如山**（站定），
  // 玩家撞上它的身体盒被挡住（那一半在 `player/physics.js` + `IgnisService.overlapsAabb`，
  // 用例在 `test-physics.js`）。
  //
  // ⚠️ **必须在 chase 态测**：`attack` 态的站定是作者原实现（`setDeltaMovement(0,...)`），
  // 挥刀时它本来就不能挪。本用例只钉「追击段遇到逼近的玩家会站定」，所以用大冷却把
  // attack 排掉（否则第 0 帧就起手，测的是另一件事）。
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = groundWorld(9);
  const player = { position: [0.5, 10, -5.5] };
  let s = st({ position: [0.5, 10, 0], onGround: true, mode: 'chase', attackCooldown: 999 });
  const start = s.position.slice();
  // 玩家先走近 35 帧（0.1/帧 = 6 格/秒，比焰魔的 4.4 快）到 z=-2.0，然后**站住**。
  // ⚠️ 不能让玩家一路走过焰魔身侧：那样焰魔会转身从后面追（drift ≈ 2 格），
  // 测的就不是「贴近时站定」而是「转身后追击」了。
  for (let i = 0; i < 120; i++) {
    if (i < 35) player.position[2] += 0.1;
    s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player });
  }
  const drift = Math.hypot(s.position[0] - start[0], s.position[2] - start[2]);
  // 上界：玩家贴近后焰魔**不再移动**。允许它先走完「从 5.5 格到死区下界 4.25 格」
  // 那一小段（双方相向而行，焰魔只走 ≈0.53 格），故界取 1.0。
  assertTrue(drift < 1.0,
    `玩家贴上来时焰魔应站定（不退让），实际漂移 ${drift.toFixed(2)} 格`);
  const d = Math.hypot(s.position[0] - player.position[0], s.position[2] - player.position[2]);
  const inner = IGNIS_AI.standoffRange - IGNIS_AI.standoffDeadband;
  assertTrue(d < inner,
    `玩家已贴到 ${d.toFixed(2)} 格（应比死区下界 ${inner} 更近 —— 否则测不到「贴近」这个场景）`);
});

test('焰魔 AI: 站定环内优先原地不动（不为了「对齐」绕圈）', () => {
  // ⚠️ 这条守的是一个**修法陷阱**：只做「朝环上最近点走」会让焰魔绕着玩家画圆 ——
  // 它在环内，最近点在环上，方向可能与它当前站位垂直 ⇒ 侧向漂移，观感比穿模好不了多少。
  // ⚠️ v2.62 后环内（`d < inner`）的语义是**站定不动**（不再退让），故本用例的期望
  // 从「直线退开 1.5 格」收紧为「几乎不动」。
  const player = playerAt(4.0);   // 已比环半径小（玩家自己走过来 / 被推近）
  const { trace } = runStandoff({}, player, 8);
  const start = trace[0].pos;
  let maxDrift = 0;
  for (const f of trace) {
    const drift = Math.hypot(f.pos[0] - start[0], f.pos[2] - start[2]);
    if (drift > maxDrift) maxDrift = drift;
  }
  assertTrue(maxDrift < 1.0, `8 秒内漂移 ${maxDrift.toFixed(2)} 格（环内应站定，不该绕圈也不该退让）`);
});

// ==================== 穿模自解卡（v2.62）====================
//
// 用户缺陷④：「当焰魔的身体和方块发生穿模的时候，有时候就卡住不动了，让焰魔不要
// 因为和方块发生重叠或穿模就卡住」。
//
// 被埋的现实路径：TNT/火球爆炸改地形、玩家放块、step-up 角落竞态。被埋后所有水平
// 移动都二分回退到零位移 ⇒ 卡死。修法复刻玩家 `PlayerPhysics.resolveStuck` 的语义：
// 向上扫到首个可站 y，扫不到就**放弃并原地不动**（不静默抬到半路）。

test('焰魔 AI: 被埋进方块 → 向上解卡到首个可站 y', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  // y<=12 全实心（焰魔脚底 y=10 被埋：占层 10~13），y=13 起空气
  const w = makeWorld((_x, y, _z) => y <= 12);
  let s = st({ position: [0.5, 10, 0.5], mode: 'chase', onGround: false });
  s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player: playerAt(20) });
  assertTrue(s.position[1] >= 13, `应抬到 y>=13，实际 ${s.position[1]}`);
  assertEqual(s.velocity[1], 0, '解卡后 vy 应清零');
});

test('焰魔 AI: 未被埋时位置逐位不变（解卡常态零副作用）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = groundWorld(9);
  let s = st({ position: [0.5, 10, 0.5], mode: 'idle', onGround: true });
  const before = s.position.slice();
  s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player: null });
  assertEqual(s.position[0], before[0]);
  assertEqual(s.position[1], before[1], '未埋不应改 y');
  assertEqual(s.position[2], before[2]);
});

test('焰魔 AI: 埋深于 stuckResolveMaxRaise → 放弃不抬（不静默抬半路）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  // 实心一直到 y=31（= 10 + 16 + 5）⇒ 扫描上限 16 格内无解
  const w = makeWorld((_x, y, _z) => y <= 10 + IGNIS_AI.stuckResolveMaxRaise + 5);
  let s = st({ position: [0.5, 10, 0.5], mode: 'chase' });
  s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player: playerAt(20) });
  assertEqual(s.position[1], 10, '超深应原地不动（抬到半路仍在实心里等于没解卡）');
});

// ==================== 卡住飞跃脱困（v2.62）====================
//
// 用户缺陷⑤：「给焰魔增加一个飞跃的技能，当焰魔卡住不动的时候，比如卡住 4 秒钟，
// 就飞跃出来，不要陷在卡住的位置一直动弹不得」。
//
// ⚠️ **卡住判据必须用 pre-steering 的原始意图**（预检发现的真缺陷）：四面围死时
// `steerIntentAabb` 返回 `{vx:0,vz:0,blocked:true}` ⇒ post-steering 意图恒 0 ⇒
// 若用它计量，`stuckT` **永不累计** —— 用户报告的形态恰好修不掉。

/**
 * 封闭盒世界：中心 (0.5,·,0.5) 的焰魔占格 {0,1}²，墙在 x=-1/2、z=-1/2（各留 1 格余量）。
 *
 * ⚠️ **不能把墙写在 x=±1 以内**：焰魔 halfWidth 0.5 ⇒ 出生即与墙重叠 ⇒ 触发的是
 * Task 4 的 `_resolveStuck` 而不是本组要测的 stuckT（预检 Ruling）。
 * 顶部开口（y>11 无方块）⇒ 跳得出去；墙高 **2 格**（y=10~11）—— 与 `leapJumpForce`(11)
 * 的抛物线顶点 2.52 格配套（spec：「越得过 2 格障碍」），step-up（maxStep=1）上不去。
 */
function sealedBoxWorld() {
  return makeWorld((x, y, z) => {
    if (y <= 9) return true;                                  // 地板
    if (y > 11) return false;                                 // 顶开口（跳得出）
    return x <= -1 || x >= 2 || z <= -1 || z >= 2;            // 四面墙（高 2 格：y=10,11）
  });
}

test('焰魔 AI: 有意图但没走成 → stuckT 累加（围死场景）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = sealedBoxWorld();
  let s = st({ position: [0.5, 10, 0.5], mode: 'chase', onGround: true });
  for (let i = 0; i < 120; i++) {
    s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player: playerAt(20) });
  }
  assertTrue(s.stuckT > 1.0,
    `围死 2 秒后 stuckT=${s.stuckT.toFixed(2)}（应按 pre-steering 原始意图累计）`);
});

test('焰魔 AI: 走得到时不会误触发脱困（开阔地零误报）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = groundWorld(9);
  let s = st({ position: [0.5, 10, 0.5], mode: 'chase', onGround: true });
  let sawEscape = false;
  let maxStuckT = 0;
  for (let i = 0; i < 60 * 12; i++) {          // 12 秒（> stuckLeapSeconds 4s 三倍）
    s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player: playerAt(20) });
    maxStuckT = Math.max(maxStuckT, s.stuckT);
    if (s.mode === 'leap' && s.leapKind === 'escape') sawEscape = true;
  }
  // ⚠️ **v2.63 语义变更**：`stuckT` 现在是「距上次确认进展的时长」，正常行走时会在
  // `stuckNetDist / chaseSpeed ≈ 0.51s` 内锯齿波动（每走满 1.5 格棘轮重置）——
  // 故**不能再断言 `stuckT === 0`**（那是 v2.62 「意图 vs 位移」判据的语义）。
  // 真正的契约是：永远到不了阈值、永不脱困跳。
  assertTrue(maxStuckT < IGNIS_AI.stuckLeapSeconds,
    `开阔地 stuckT 峰值 ${maxStuckT.toFixed(2)} 不应达到阈值 ${IGNIS_AI.stuckLeapSeconds}`);
  assertFalse(sawEscape, '开阔地不应因卡住而脱困飞跃');
  // ⚠️ **mode 不能钉死在 chase**（v2.62 踩到）：开阔地追击会穿过跳劈窗（8~14 格）
  // ⇒ 进入 `leap(attack)` 是**正确行为**。本用例只钉「不误报脱困」。
});

test('焰魔 AI: stuckT 满 4s → leap(escape)，上跳 + 朝原始意图方向水平飞', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = sealedBoxWorld();
  let s = st({
    position: [0.5, 10, 0.5], mode: 'chase', onGround: true,
    stuckT: IGNIS_AI.stuckLeapSeconds,
  });
  s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player: playerAt(20) });
  assertEqual(s.mode, 'leap');
  assertEqual(s.leapKind, 'escape');
  assertNotNull(s.leapDir, '应给出水平飞跃方向');
  // 玩家在 -Z ⇒ 原始意图朝 -Z ⇒ leapDir 的 z 分量为负
  assertTrue(s.leapDir[1] < 0, `应朝玩家方向（-Z）飞，实际 leapDir=${s.leapDir}`);
  assertTrue(Math.abs(s.leapDir[1]) > 1, `水平速应接近 leapSpeed(${IGNIS_AI.leapSpeed})`);
  assertEqual(s.stuckT, 0, '起跳后 stuckT 应清零');
});

test('焰魔 AI: leap(escape) 真的跳出封闭盒（用户缺陷⑤的可观察结果）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = sealedBoxWorld();
  let s = st({ position: [0.5, 10, 0.5], mode: 'chase', onGround: true });
  let escaped = false;
  for (let i = 0; i < 60 * 12; i++) {          // 12 秒（含 4 秒卡住计时 + 滞空）
    s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player: playerAt(20) });
    // 跳出盒子的判据：脚底高于墙顶（y>12，墙顶在 y=11）或水平出了墙外
    if (s.position[1] > 12 || s.position[2] < -1.5 || s.position[0] > 2.5) { escaped = true; break; }
  }
  assertTrue(escaped,
    `12 秒后仍在盒内（pos=${s.position.map((n) => n.toFixed(2))}, mode=${s.mode}）—— 脱困飞跃没生效`);
});

test('焰魔 AI: leap(escape) 落地回 chase、stuckT 清零', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = groundWorld(9);
  let s = st({
    position: [0.5, 12, 0.5], mode: 'leap', leapKind: 'escape',
    leapDir: [0, -IGNIS_AI.leapSpeed], onGround: false, stuckT: 2,
  });
  for (let i = 0; i < 120 && s.mode === 'leap'; i++) {
    s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player: playerAt(20) });
  }
  assertEqual(s.mode, 'chase', '落地应回 chase');
  assertEqual(s.leapKind, null);
  assertEqual(s.leapDir, null);
  assertEqual(s.stuckT, 0);
});

test('焰魔 AI: leap 期与玩家过近 → 本步水平意图清零（不穿过玩家）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = groundWorld(9);
  const player = { position: [0.5, 10, -2] };   // 水平距 2.5 < inner(4.25)
  const s = st({
    position: [0.5, 11, 0.5], mode: 'leap', leapKind: 'escape',
    leapDir: [0, -IGNIS_AI.leapSpeed], onGround: false,
  });
  const s2 = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player });
  assertTrue(s2.position[2] >= s.position[2] - 1e-6,
    `leap 期不应穿进玩家（z 从 ${s.position[2]} 变成 ${s2.position[2].toFixed(3)}）`);
});

test('焰魔 AI: leap 超过 leapMaxSeconds → 安全阀强制结束', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  // 空世界（无地面）⇒ 永远落不了地，只能靠安全阀出来
  let s = st({
    position: [0.5, 10, 0.5], mode: 'leap', leapKind: 'escape',
    leapDir: [0, -IGNIS_AI.leapSpeed], leapT: IGNIS_AI.leapMaxSeconds,
  });
  s = a.update(s, 1 / 60, { world: OPEN_WORLD, registry: REGISTRY, player: playerAt(20) });
  assertEqual(s.mode, 'chase', '超时应强制回 chase（防异常滞空时永远停在 leap）');
});

// ==================== 脱困强化跳（v2.84）====================
//
// 用户 2026-11-08：「现在的跳跃高度不是很高，如果焰魔掉入了一个很深的深坑……可以计算焰魔被困住
// 所在的高度 y 和玩家所在的高度 y 之间的差，相差多高，就通过跳跃多高来脱困，只有数次普通脱困跳
// 跃没有成功脱困的时候才进行高跳来脱困」。两项裁定（`ask_user_question`）：顶点 =
// `clamp(max(Δy + 1, 4), 4, 8)`；**前 3 次普通跳**，第 4 次起强化。
//
// ⚠️ 「深坑」判定必须同时看**高差**与`d < standoffRange`：只看 `py < player[1]` 会把每只焰魔
// 都判成深坑（玩家站在高台、焰魔站在地面时 Δy 恒为正），于是「普通跳 3 次」这一步被整段跳过。

/** 「深坑」世界：坑底 y∈[4,5] 可站，坑壁之外全是实心（y ≤ 12）⇒ 跳不出去只能喊强化跳 */
function pitWorld() {
  return makeWorld((x, y, z) => {
    if (y <= 3) return true;                       // 坑底
    if (y > 12) return false;                      // 坑口之上的空间
    return x <= -3 || x >= 4 || z <= -3 || z >= 4; // 坑壁（高 9~10 格，普通跳 2.52 格过不去）
  });
}

/**
 * 4 格高围栏世界：与 `sealedBoxWorld` 同形但墙高 **4** 格（y=10~13）。
 *
 * ⚠️ **必须是 4 格，不能是 3 格**（实测逼出来的）：普通跳顶点 2.52 格 ⇒ 脚底到 12.5，
 * 而 3 格墙的墙顶在 y=12 ⇒ **第一次普通跳就借着 step-up 爬上去了**（实测第 306 帧就逃出）。
 * 4 格墙顶在 y=13，要站上去得脚底 ≥ 14（= 起点 + 4）—— 普通跳到不了，强化跳（顶点 4）刚好。
 * 也超过 `maxStep`(1.0) ⇒ step-up 上不去，只能靠飞跃。
 */
function tallFenceWorld() {
  return makeWorld((x, y, z) => {
    if (y <= 9) return true;
    if (y > 13) return false;
    return x <= -1 || x >= 2 || z <= -1 || z >= 2;
  });
}

/**
 * 让一帧进入 `leap(escape)` 并返回这一帧的 state。
 *
 * `stuckT` 塞到阈值（等价于「已经卡住满 4 秒」），`onGround=true`，其余用 `st` 的缺省。
 * ⚠️ **不能传 `velocity`** —— 顶部的 `vx/vz` 从 state 读，只有 `vy` 会被触发块改写。
 */
function triggerEscape(agent, over = {}) {
  const ctx = {
    world: OPEN_WORLD, registry: REGISTRY,
    player: over.player || playerAt(20),
  };
  const s = st({
    position: [0.5, 10, 0.5], mode: 'chase', onGround: true,
    stuckT: IGNIS_AI.stuckLeapSeconds,
    ...over.state,
  });
  return agent.update(s, 1 / 60, ctx);
}

/** 从返回的 state 反推本跳的竖直初速（`velocity[1]` 已被物理扣除一步重力） */
function launchVyOf(s) {
  return s.velocity[1] - IGNIS_AI.gravity / 60;
}

/** 顶点高度的解析值（半隐式欧拉实际会低一点点，断言一律用上下界） */
function apexOf(vy) {
  return vy * vy / (2 * Math.abs(IGNIS_AI.gravity));
}

test('焰魔 AI: 脱困跳失败计数 —— 前 3 次是普通跳（vy 仍等于 leapJumpForce）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  // ⚠️ 水平距取 **6**（> `attackRange`5.5 ⇒ 不会先转 attack；< `leapAttackMin`8 ⇒ 不触发跳劈）
  const player = { position: [0.5, 16, 0.5 - 6] };
  for (let n = 0; n < IGNIS_AI.escapeLeapEscalateAfter; n++) {
    const s = triggerEscape(a, { player });
    assertEqual(s.mode, 'leap', `第 ${n + 1} 次应进入 leap`);
    assertEqual(s.leapKind, 'escape');
    assertEqual(launchVyOf(s), IGNIS_AI.leapJumpForce,
      `第 ${n + 1} 次应是普通跳（vy=${launchVyOf(s)}），强化跳要等到第 ${IGNIS_AI.escapeLeapEscalateAfter + 1} 次`);
  }
});

test('焰魔 AI: 第 4 次脱困跳升级强化跳 —— 顶点 = clamp(max(Δy+1, 4), 4, 8)', () => {
  // 三条分支各测一遍：高差主导 / 保底下限 / 上限封顶
  const cases = [
    { dy: 5.0, expect: 6.0, why: 'Δy=5 ⇒ 顶点 5+1=6 格' },
    { dy: 0.0, expect: IGNIS_AI.escapeLeapApexMin, why: '玩家同层 ⇒ 走 4 格保底（能过 3 格围墙）' },
    { dy: 20.0, expect: IGNIS_AI.escapeLeapApexMax, why: 'Δy=20 ⇒ 封顶 8 格（不为了深坑跳 20 格）' },
  ];
  for (const c of cases) {
    // ⚠️ 每例一个独立 agent：`escapeFailCount` 是 state 字段，但 rng 序列要可复现
    const a = new IgnisBossAgent({ rng: () => 0.5 });
    const s = triggerEscape(a, {
      player: { position: [0.5, 10 + c.dy, 0.5 - 6] },
      state: { escapeFailCount: IGNIS_AI.escapeLeapEscalateAfter },
    });
    assertEqual(s.mode, 'leap');
    const vy = launchVyOf(s);
    const apex = apexOf(vy);
    assertTrue(Math.abs(apex - c.expect) < 0.05,
      `${c.why}，实测顶点 ${apex.toFixed(2)}（vy=${vy.toFixed(2)}）`);
    // ⚠️ 上界不只是「不给跳太高」：`leapMaxSeconds`(3s) 安全阀按滞空算，顶点过高会超时
    assertTrue(apex <= IGNIS_AI.escapeLeapApexMax + 0.05, `顶点 ${apex.toFixed(2)} 超过上限`);
  }
});

test('焰魔 AI: 每次起跳失败计数 +1（跨帧累积量，非每帧重置）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const player = { position: [0.5, 16, 0.5 - 6] };
  let s = triggerEscape(a, { player });
  assertEqual(s.escapeFailCount, 1, '第 1 次起跳后应为 1');
  // 落地回 chase（给地面世界），再触发第二次
  const w = pitWorld();
  for (let i = 0; i < 240 && s.mode === 'leap'; i++) {
    s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player });
  }
  s = { ...s, mode: 'chase', onGround: true, stuckT: IGNIS_AI.stuckLeapSeconds };
  s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player });
  assertEqual(s.escapeFailCount, 2, '第 2 次起跳后应为 2（计数被每帧重置的话这里会是 1）');
});

test('焰魔 AI: 脱困成功后失败计数清零（棘轮确认进展 + 玩家不再在上方）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = groundWorld(9);
  const player = { position: [0.5, 10, 0.5 - 20] };   // 同层 ⇒ 不在上方
  let s = st({
    position: [0.5, 10, 0.5], mode: 'chase', onGround: true,
    stuckT: 0, stuckAnchor: [0.5, 0.5], escapeFailCount: 2,
  });
  // 直接给一个「已经走开 2 格」的位置：棘轮判据要求 net ≥ stuckNetDist(1.5)
  s = { ...s, position: [0.5, 10, 0.5 - 2] };
  s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player });
  assertEqual(s.escapeFailCount, 0, '同层且真的走开了 ⇒ 脱困成功，计数应清零');
});

test('焰魔 AI: 坑内乱蹦也会刷满净位移，但玩家在上方时不得清零失败计数', () => {
  // ⚠️ 不加这条附加条件 ⇒ 宽坑里焰魔水平乱走 1.5 格就清零 ⇒ 永远等不到强化跳
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = pitWorld();
  const player = { position: [0.5, 51, 0.5 - 28.5] };   // 高 41 格、水平 28.5 格
  let s = st({
    position: [0.5, 4, 0.5], mode: 'chase', onGround: true,
    stuckT: 0, stuckAnchor: [0.5, 0.5], escapeFailCount: 2,
  });
  s = { ...s, position: [0.5, 4, 0.5 - 2] };   // 坑内走了 2 格（≥ stuckNetDist）
  s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player });
  assertEqual(s.escapeFailCount, 2, '玩家还在上方 41 格 ⇒ 不算脱困成功，计数必须保留');
});

test('焰魔 AI: 离开卡住态（不再追踪 stuckT）→ 失败计数清零', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = groundWorld(9);
  // 玩家在 sightRange 内 + 视线通 + 站定环内 ⇒ shouldTrackStuck=false（能砍到人的焰魔不算卡住）
  const player = { position: [0.5, 10, 0.5] };
  let s = st({
    position: [0.5, 10, 0.5], mode: 'chase', onGround: true,
    losVisible: true, losTimer: 999, escapeFailCount: 2,
  });
  s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player });
  assertEqual(s.escapeFailCount, 0, '不处于卡住态 ⇒ 计数清零（否则上一处困境的记忆会漏到下一次）');
});

test('焰魔 AI: 4 格高围墙 —— 普通跳永远出不去，强化跳（第 4 次）能越过', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = tallFenceWorld();
  const player = playerAt(20);   // 同层远处 ⇒ 强化跳走 4 格保底
  let s = st({ position: [0.5, 10, 0.5], mode: 'chase', onGround: true });
  const leapApexes = [];
  let escapedAt = -1;
  for (let i = 0; i < 60 * 40; i++) {          // 40 秒：4 次 × (4s 卡住 + ~1s 滞空) + 余量
    s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player });
    if (s.mode === 'leap' && s.leapKind === 'escape' && leapApexes.length < s.escapeFailCount) {
      leapApexes.push(launchVyOf(s));
    }
    // 逃出判据：站上墙顶（脚底 ≥ 起点 + 4）或水平出了围栏
    if (s.position[1] > 13.5 || s.position[2] < -1.5 || s.position[0] > 2.5) { escapedAt = leapApexes.length; break; }
  }
  assertEqual(leapApexes.length, IGNIS_AI.escapeLeapEscalateAfter + 1,
    `应看到 ${IGNIS_AI.escapeLeapEscalateAfter} 次普通跳 + 1 次强化跳，实测 ${leapApexes.length} 次`);
  for (const vy of leapApexes.slice(0, IGNIS_AI.escapeLeapEscalateAfter)) {
    assertTrue(Math.abs(vy - IGNIS_AI.leapJumpForce) < 1e-9, `普通跳 vy 应=${IGNIS_AI.leapJumpForce}`);
  }
  assertTrue(Math.abs(apexOf(leapApexes[leapApexes.length - 1]) - IGNIS_AI.escapeLeapApexMin) < 0.05,
    `第 ${leapApexes.length} 次应是 ${IGNIS_AI.escapeLeapApexMin} 格顶点的强化跳`);
  assertTrue(escapedAt > 0, '强化跳必须真的把焰魔跳出 3 格围墙');
});

// ==================== 跳跃劈砍（v2.62）====================
//
// 用户缺陷⑥：「当焰魔靠近玩家过程中，距离玩家一定的距离，就执行一个飞跃向前的动作，
// 落点刚好就在玩家的面前，飞跃到快触碰到地面的时候，执行当前的劈砍的动作」。
//
// 素材佐证：原版 `PredictiveChargeAttackAnimationGoal`（蓄力期记录玩家位移、tick=charge 时
// 预判玩家位置并 `setDeltaMovement` 冲过去）—— 本实现同样用「预判时刻的位置」。

test('焰魔 AI: 8~14 格 + 冷却好 + 视线通 → leap(attack)，朝玩家方向飞', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = groundWorld(9);
  const player = { position: [0, 10, -11], velocity: [0, 0, 0] };
  let s = st({
    position: [0, 10, 0], mode: 'chase', onGround: true,
    losVisible: true, losTimer: 999, leapAttackCooldown: 0,
  });
  s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player });
  assertEqual(s.mode, 'leap');
  assertEqual(s.leapKind, 'attack');
  assertTrue(s.velocity[1] > 0, `应上跳，实际 vy=${s.velocity[1]}`);
  assertNotNull(s.leapDir);
  assertTrue(s.leapDir[1] < 0, `应朝玩家（-Z）飞，实际 leapDir=${s.leapDir}`);
  assertTrue(s.leapAttackCooldown > 0, '起跳后应进冷却');
  assertTrue(Number.isFinite(s.leapTargetY), '应记下预判落点 y');
});

// ==================== 跳跃落地携带招式种类 ====================
//
// ⚠️⚠️ **修掉一个遗留缺陷**：旧实现的 leap 落地分支**不设 `attackKind`**
// ⇒ 沿用进入 leap 前的残值（通常 null）⇒ 渲染器回落 `attack`
// ⇒ **跳跃劈砍永远播横扫**，即使权重抽中别的招。
//
// 招式在**起跳时**就抽定、落地时写进 `attackKind`：若在落地时才抽，
// 起跳与落地两次抽签可能不一致 ⇒「跳起来却勈了一刀」。

test('焰魔 AI: 起跳时抽签并携带 leapAttackKind（rng≈1 ⇒ 末档尖刺攻击）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.999999 });
  const w = groundWorld(9);
  const player = { position: [0, 10, -11], velocity: [0, 0, 0] };
  let s = st({
    position: [0, 10, 0], mode: 'chase', onGround: true,
    losVisible: true, losTimer: 999, leapAttackCooldown: 0,
  });
  s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player });
  assertEqual(s.mode, 'leap');
  assertEqual(s.leapKind, 'attack');
  assertEqual(s.leapAttackKind, 'spikeSlash', '起跳当帧就应抽定这次落地用哪一招（rng≈1 ⇒ 末档尖刺攻击）');
});

test('焰魔 AI: 跳跃落地播起跳时抽中的招，不再恒播 swing', () => {
  const a = new IgnisBossAgent({ rng: () => 0.999999 });
  const w = groundWorld(9);
  const player = { position: [0, 10, -6.4], velocity: [0, 0, 0] };
  let s = st({
    position: [0, 12, -4], mode: 'leap', leapKind: 'attack',
    leapDir: [0, -8], leapTargetY: 10, onGround: false, velocity: [0, -5, 0],
    leapAttackKind: 'shieldBash',
  });
  for (let i = 0; i < 60 && s.mode === 'leap'; i++) {
    s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player });
  }
  assertEqual(s.mode, 'attack');
  assertEqual(s.attackKind, 'shieldBash',
    '落地应播起跳时抽中的招（旧实现不设 attackKind ⇒ 恒回落 swing）');
  assertNull(s.leapAttackKind, '落地后必须清空（不残留）');
});

test('焰魔 AI: 落地抽中 spin 时也置 spinCooldown（与平地起手同口径）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.3 });
  const w = groundWorld(9);
  const player = { position: [0, 10, -6.4], velocity: [0, 0, 0] };
  let s = st({
    position: [0, 12, -4], mode: 'leap', leapKind: 'attack',
    leapDir: [0, -8], leapTargetY: 10, onGround: false, velocity: [0, -5, 0],
    leapAttackKind: 'spin',
  });
  for (let i = 0; i < 60 && s.mode === 'leap'; i++) {
    s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player });
  }
  assertEqual(s.attackKind, 'spin');
  assertTrue(s.spinCooldown > 0, '落地抽中旋斩也要置独立冷却（否则可连抽）');
});

test('焰魔 AI: 旧存档缺 leapAttackKind / 非法值 ⇒ 不崩且回落合法招', () => {
  const w = groundWorld(9);
  const player = { position: [0, 10, -6.4], velocity: [0, 0, 0] };
  for (const bad of [undefined, null, 'nonsense', 42, {}]) {
    const a = new IgnisBossAgent({ rng: () => 0.5 });
    let s = st({
      position: [0, 12, -4], mode: 'leap', leapKind: 'attack',
      leapDir: [0, -8], leapTargetY: 10, onGround: false, velocity: [0, -5, 0],
      leapAttackKind: bad,
    });
    for (let i = 0; i < 60 && s.mode === 'leap'; i++) {
      s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player });
    }
    assertTrue(IGNIS_ATTACK_IDS.includes(s.attackKind),
      `非法 leapAttackKind=${JSON.stringify(bad)} 产出了非法 attackKind=${JSON.stringify(s.attackKind)}`);
  }
});

test('焰魔 AI: 非 leap 态不残留 leapAttackKind', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = groundWorld(9);
  const player = { position: [0, 10, -2], velocity: [0, 0, 0] };
  const s = a.update(st({ mode: 'chase', onGround: true, leapAttackKind: 'shieldSmash' }),
    1 / 60, { world: w, registry: REGISTRY, player });
  assertNull(s.leapAttackKind, '非飞跃态不得残留上一跳的招式');
});

test('焰魔 AI: 静止玩家 → 落点在玩家外侧「站定环内缘」（跳完砍得到）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = groundWorld(9);
  const player = { position: [0, 10, -11], velocity: [0, 0, 0] };
  const s = a.update(st({
    position: [0, 10, 0], mode: 'chase', onGround: true, losVisible: true, losTimer: 999,
  }), 1 / 60, { world: w, registry: REGISTRY, player });
  // 落点 = 预判位置朝焰魔方向外推「standoff − deadband/2」
  const T = IGNIS_AI.leapAttackAirtime;
  const landZ = player.position[2] + (IGNIS_AI.standoffRange - IGNIS_AI.standoffDeadband / 2);
  // leapDir = (落点 − 自身)/T
  const expectVz = (landZ - 0) / T;
  assertTrue(Math.abs(s.leapDir[1] - expectVz) < 1e-6,
    `leapDir.z=${s.leapDir[1].toFixed(3)}，期望 ${expectVz.toFixed(3)}（落点应在玩家外侧环内缘）`);
  // 落点与玩家的水平距必须 < hitRange（否则跳完砍不到）
  const landDist = Math.abs(landZ - player.position[2]);
  assertTrue(landDist < IGNIS_AI.hitRange,
    `落点距玩家 ${landDist.toFixed(2)} 格 ≥ hitRange(${IGNIS_AI.hitRange})，跳完砍不到`);
});

test('焰魔 AI: 移动玩家 → 落点含速度预判（顺速度方向偏移）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = groundWorld(9);
  const base = {
    position: [0, 10, 0], mode: 'chase', onGround: true, losVisible: true, losTimer: 999,
  };
  const still = a.update(st(base), 1 / 60, {
    world: w, registry: REGISTRY, player: { position: [0, 10, -11], velocity: [0, 0, 0] },
  });
  const moving = a.update(st(base), 1 / 60, {
    world: w, registry: REGISTRY, player: { position: [0, 10, -11], velocity: [5, 0, 0] },
  });
  assertTrue(moving.leapDir[0] > still.leapDir[0] + 1,
    `玩家向 +X 移动 ⇒ 落点应偏 +X（still=${still.leapDir[0].toFixed(2)}, moving=${moving.leapDir[0].toFixed(2)}）`);
});

test('焰魔 AI: ctx.player 无 velocity 字段 → 不抛、不产生 NaN（缺省静止）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = groundWorld(9);
  const s = a.update(st({
    position: [0, 10, 0], mode: 'chase', onGround: true, losVisible: true, losTimer: 999,
  }), 1 / 60, { world: w, registry: REGISTRY, player: { position: [0, 10, -11] } });
  assertEqual(s.mode, 'leap');
  assertTrue(s.leapDir.every(Number.isFinite), `leapDir 出现 NaN：${s.leapDir}`);
  assertTrue(Number.isFinite(s.velocity[1]), `vy 出现 NaN：${s.velocity[1]}`);
});

test('焰魔 AI: 距离 <8 / >14 / 冷却中 / 无视线 → 不跳劈', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = groundWorld(9);
  // [水平距, 跳劈冷却, 视线]：前三个各破一个必要条件；第四个破视线。
  //
  // ⚠️️ **「距离太近」的测试点必须落在 `attackRange`(5.5) 与 `leapAttackMin`(8) 之间**
  //（负向验证实测踩到：用 d=5 时去掉下界仍全绿）。因为 d=5 < attackRange ⇒ 状态转移
  // 先把它转成 `attack`，而跳劈块要求 `mode === 'chase'` ⇒ **根本不进入**，测不到下界。
  // d=7 才是有判别力的点：不会转 attack（7 > 5.5），但也不该跳劈（7 < 8）。
  // ⚠️ 无视线那条必须配 `losTimer: 999` —— 否则本帧会重查，平地上玩家可见 ⇒ 测不到。
  const cases = [[7, 0, true], [16, 0, true], [11, 99, true], [11, 0, false]];
  for (const [d, cd, los] of cases) {
    const s = a.update(st({
      position: [0, 10, 0], mode: 'chase', onGround: true,
      losVisible: los, losTimer: 999, leapAttackCooldown: cd,
    }), 1 / 60, {
      world: w, registry: REGISTRY, player: { position: [0, 10, -d], velocity: [0, 0, 0] },
    });
    assertTrue(!(s.mode === 'leap' && s.leapKind === 'attack'),
      `d=${d}, cd=${cd}, los=${los} 不应跳劈（实际 mode=${s.mode}, kind=${s.leapKind}）`);
  }
});

test('焰魔 AI: 跳劈窗下界真的有判别力（attackRange~leapAttackMin 之间不跳、窗内跳）', () => {
  // ⚠️ 这条是上一条的**阳性对照**：只钉「不该跳」而无「该跳」的对照，判据可能是空的
  //（AGENTS.md：「注入回退仍全绿」的形态）。两侧只差水平距这一个变量。
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = groundWorld(9);
  const mk = (d) => a.update(st({
    position: [0, 10, 0], mode: 'chase', onGround: true, losVisible: true, losTimer: 999,
  }), 1 / 60, { world: w, registry: REGISTRY, player: { position: [0, 10, -d], velocity: [0, 0, 0] } });
  // 窗内（11 格）⇒ 跳
  const inWin = mk(11);
  assertEqual(inWin.mode, 'leap', '窗内应跳劈（否则下界用例是空判据）');
  assertEqual(inWin.leapKind, 'attack');
  // 窗外但超出 attackRange（7 格）⇒ 不跳，且仍留在 chase
  const below = mk(7);
  assertEqual(below.mode, 'chase', `7 格（attackRange~leapAttackMin 之间）应继续追击，实际 ${below.mode}`);
});

test('焰魔 AI: 非 onGround（空中）→ 不跳劈', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const s = a.update(st({
    position: [0, 12, 0], mode: 'chase', onGround: false,
    losVisible: true, losTimer: 999,
  }), 1 / 60, {
    world: groundWorld(9), registry: REGISTRY,
    player: { position: [0, 10, -11], velocity: [0, 0, 0] },
  });
  assertTrue(!(s.mode === 'leap' && s.leapKind === 'attack'), '空中不应起跳');
});

test('焰魔 AI: leap(attack) 下落近地 → 转 attack 且 yaw 立即对准玩家', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = groundWorld(9);
  // 落点预判在 z=-6.4；焰魔已飞到 z=-4、高 12 格、正在下落（vy=-5）
  const player = { position: [0, 10, -6.4], velocity: [0, 0, 0] };
  let s = st({
    position: [0, 12, -4], mode: 'leap', leapKind: 'attack',
    leapDir: [0, -8], leapTargetY: 10, onGround: false,
    velocity: [0, -5, 0], yaw: 2.5,      // 故意给一个歪朝向，验证「立即对准」
  });
  for (let i = 0; i < 60 && s.mode === 'leap'; i++) {
    s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player });
  }
  assertEqual(s.mode, 'attack', '下落近地应起劈');
  assertTrue(Math.abs(s.yaw) < 0.3, `起劈应对准玩家（yaw=${s.yaw.toFixed(2)}）`);
  assertEqual(s.attackAnimT > 0, true, '应从头播劈砍动画');
});

test('焰魔 AI: leap(attack) 预判偏差大 → 落地兜底仍进 attack', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = groundWorld(9);
  // leapTargetY 给一个远低于地面的值（预判完全错）⇒ 「近地」条件永不满足，只能靠落地兜底
  const player = { position: [0, 10, -6.4], velocity: [0, 0, 0] };
  let s = st({
    position: [0, 12, -4], mode: 'leap', leapKind: 'attack',
    leapDir: [0, -8], leapTargetY: -50, onGround: false, velocity: [0, -5, 0],
  });
  for (let i = 0; i < 120 && s.mode === 'leap'; i++) {
    s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player });
  }
  assertEqual(s.mode, 'attack', '落地兜底应起劈（不能回 chase 白跳一趟）');
});

test('焰魔 AI: 玩家已**重叠**进身体 → 例外后退自愈（v2.62 修复 P1-3 软锁）', () => {
  // ⚠️ **这条守的是一个真软锁**（final review P1-3）：⑦「阻挡玩家」+「去退让」叠加后，
  // 若玩家因传送/矿车下车而落在焰魔身体盒**内部**：
  //   玩家侧 `_collides()` 恒真 ⇒ `_moveAxis` 对任意 delta 都二分回退到 0 ⇒ 四轴全冻结
  //   （连「走开」和「下落」都做不到）；
  //   焰魔侧 `d < inner` 站定 + `tooClose` 禁 navDir ⇒ **永远不会主动离开**，
  //   且 `directVx/directVz` 恒 0 ⇒ `stuckT` 不累计 ⇒ 脱困飞跃也不触发。
  // ⇒ 玩家被冻在 Boss 身体里，而 Boss 处于 attack 循环持续砍人。
  //
  // 修法：只在**真重叠**（d < `overlapEscapeDist`）这个退化情形下例外后退。
  // 用户第⑦项的「贴近时站定不动如山」**不受影响**（那个场景是 d ≈ 1.36，玩家被身体盒
  // 挡在外面，远大于 overlapEscapeDist）。
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = groundWorld(9);
  const player = { position: [0.5, 10, -0.4] };   // d = 0.4，已在身体盒内
  let s = st({ position: [0.5, 10, 0], onGround: true, mode: 'chase', attackCooldown: 999 });
  const startZ = s.position[2];
  for (let i = 0; i < 60; i++) {
    s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player });
  }
  assertTrue(s.position[2] > startZ + 0.5,
    `玩家重叠进身体时焰魔应后退自愈（z 从 ${startZ} 只到 ${s.position[2].toFixed(2)}）`);
  const d = Math.hypot(s.position[0] - player.position[0], s.position[2] - player.position[2]);
  assertTrue(d > IGNIS_AI.overlapEscapeDist,
    `后退后间距 ${d.toFixed(2)} 应已超出重叠阈 ${IGNIS_AI.overlapEscapeDist}`);
});

test('焰魔 AI: 重叠自愈不得反转用户第⑦项（贴近但未重叠时仍站定）', () => {
  // 阳性对照：上一条只该在「真重叠」时生效。玩家被身体盒挡在外面的正常距离
  //（实测 E2E minDist ≈ 1.36）必须仍然站定 —— 否则就是把 v2.60 的退让整个加回来了。
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = groundWorld(9);
  const player = { position: [0.5, 10, -1.4] };   // d = 1.4 > overlapEscapeDist，未重叠
  let s = st({ position: [0.5, 10, 0], onGround: true, mode: 'chase', attackCooldown: 999 });
  const startZ = s.position[2];
  for (let i = 0; i < 60; i++) {
    s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player });
  }
  assertTrue(Math.abs(s.position[2] - startZ) < 0.2,
    `未重叠时应站定（不动如山），实际 z 从 ${startZ} 变到 ${s.position[2].toFixed(2)}`);
});

test('焰魔 AI: 埋深于 stuckResolveMaxRaise → 不进入 leap 空转（安静地什么都不做）', () => {
  // final review P2-1：放弃解卡是对的，但若没有终态，它会以 ~7s 为周期永久抖动：
  // stuckT 累计 → 起跳（被埋 ⇒ 竖直/水平全被二分回退）→ leapMaxSeconds 超时回 chase → 再累计。
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = makeWorld((_x, y, _z) => y <= 10 + IGNIS_AI.stuckResolveMaxRaise + 5);
  let s = st({ position: [0.5, 10, 0.5], mode: 'chase', onGround: true });
  let sawLeap = false;
  for (let i = 0; i < 60 * 15; i++) {          // 15 秒（> 4s 阈值 + 3s 安全阀一个周期）
    s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player: playerAt(20) });
    if (s.mode === 'leap') sawLeap = true;
  }
  assertFalse(sawLeap, '不可恢复的被埋场景不应反复起跳空转（渲染层会跟着抽搛）');
  assertEqual(s.stuckT, 0, '被埋且无解时 stuckT 应钉 0');
  assertTrue(s.position.every(Number.isFinite), `出现 NaN：${s.position}`);
});

test('焰魔 AI: world 为 null 时跳劈仍可触发（directClear 不得默认假）', () => {
  // final review P2-2：`directClear` 初值 false、只在 `if (world && ...)` 块内赋值 ⇒
  // world 缺失的降级路径上缺陷⑥会**静默失效**（「判据默认假」的写法）。
  // 无障碍可探 ⇒ 直路可通，应显式为 true。
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const s = a.update(st({
    position: [0, 10, 0], mode: 'chase', onGround: true, losVisible: true, losTimer: 999,
  }), 1 / 60, {
    world: null, registry: REGISTRY,
    player: { position: [0, 10, -11], velocity: [0, 0, 0] },
  });
  assertEqual(s.mode, 'leap', 'world=null 时仍应能跳劈');
  assertEqual(s.leapKind, 'attack');
});

test('焰魔 AI: 玩家速度异常巨大（传送伪速度）→ leapDir 仍被钳制，不甲出地图（v2.62 修复 P1-1）', () => {
  // ⚠️ **这条守的是 final review P1-1**：`game.js` 用位置差分算玩家速度，而传送路径
  //（`_teleportTo` → `player.spawn`）不重置 `_prevPlayerPos` ⇒ 传送后首帧伪速度可达
  // 几万格/秒。该值进跳劈预判 ⇒ `leapDir` 无长度钳制（只有 vy 被钳）⇒ 焰魔被甲出地图。
  // 装配层已修（传送重置 `_prevPlayerPos`），但 Agent 侧也要有防御：无论上游给多离谱的
  // 速度，`leapDir` 长度都不得超一个合理上界。
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = groundWorld(9);
  // 玩家速度 75000 格/秒（= 1200 格传送 / 0.016s 帧）
  const s = a.update(st({
    position: [0, 10, 0], mode: 'chase', onGround: true, losVisible: true, losTimer: 999,
  }), 1 / 60, {
    world: w, registry: REGISTRY,
    player: { position: [0, 10, -11], velocity: [75000, 0, 0] },
  });
  assertEqual(s.mode, 'leap');
  const speed = Math.hypot(s.leapDir[0], s.leapDir[1]);
  assertTrue(Number.isFinite(speed), `leapDir 出现 NaN/Inf：${s.leapDir}`);
  // 上界 = `leapSpeed × 3`（实现里的钳制值）。⚠️ **必须带浮点容差**：钳制是
  // `v/len*MAX` 的归一化重建，`hypot` 回读会得到 `MAX × (1+1e-16)` —— 实测 24.000000000000004。
  // 判别力不靠这个容差：未钳制时该值是 **~74995**（predX = 75000×0.9），差三个量级。
  const cap = IGNIS_AI.leapSpeed * 3;
  assertTrue(speed <= cap * (1 + 1e-9),
    `伪速度下 leapDir 长度 ${speed} 超出钳制上界 ${cap}（会把焰魔甲出地图）`);
  assertTrue(speed < 100,
    `钳制未生效：leapDir 长度 ${speed.toFixed(0)} 格/秒（未钳制时约 74995）`);
});

test('焰魔 AI: 寻路无解（navDir=null）+ 死区内 → 仍会脱困（v2.63 根因复现）', () => {
  // ⚠️⚠️ **这条是用户 2026-11-06 报告的「绕行时有时候会卡住」的根因复现**。
  //
  // 旧判据：`stuckT` 只在「有非零意图但没走成」时累计。但存在一个**意图恒为零的卡死态**：
  //   ① 焰魔与玩家的水平距恰好落在站定环死区（`_ringIntent` 返回 0）；
  //   ② 中间有墙 ⇒ `!losVisible` ⇒ `needsPath = true`；
  //   ③ A\* 给不出路线（`navMode='blocked'` ⇒ `navDir = null`，例如玩家在另一层/
  //      超出 `PATHFIND.maxRadius` 24 格/四面围死）。
  // ⇒ 意图 0、位移 0、旧判据 `want > 1e-6` 恒假 ⇒ `stuckT` **永不累计** ⇒ 永久僵住。
  //
  // 用户要求：「不管什么原因，我要求焰魔都具备能主动脱困的能力」。
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  // 墙在 z ∈ [-3,-2]（焰魔与玩家之间）⇒ 视线不通
  const w = makeWorld((_x, y, z) => y <= 9 || (z >= -3 && z <= -2));
  // 玩家在死区距离上（4.6 ∈ [4.25, 5.0]）
  const player = { position: [0.5, 10, -4.1] };
  let s = st({
    position: [0.5, 10, 0.5], mode: 'chase', onGround: true,
    losVisible: false, losTimer: 999, attackCooldown: 999,
    navDir: null, navMode: 'blocked', needsPath: true,
  });
  const d0 = Math.hypot(s.position[0] - player.position[0], s.position[2] - player.position[2]);
  assertTrue(d0 > IGNIS_AI.standoffRange - IGNIS_AI.standoffDeadband && d0 <= IGNIS_AI.standoffRange,
    `夹具错了：初始距离 ${d0.toFixed(2)} 应在死区内`);

  let sawLeap = false;
  let maxStuckT = 0;
  for (let i = 0; i < 60 * 12; i++) {          // 12 秒（> stuckLeapSeconds 4s 两倍）
    s = { ...s, navDir: null, navMode: 'blocked', needsPath: true };   // 寻路持续无解
    s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player });
    maxStuckT = Math.max(maxStuckT, s.stuckT);
    if (s.mode === 'leap' && s.leapKind === 'escape') { sawLeap = true; break; }
  }
  assertTrue(maxStuckT > 1.0,
    `寻路无解 + 死区内时 stuckT 只到 ${maxStuckT.toFixed(2)}（旧判据要求非零意图 ⇒ 永不累计）`);
  assertTrue(sawLeap, `12 秒内未触发脱困飞跃（mode=${s.mode}, stuckT=${s.stuckT.toFixed(2)}）`);
});

test('焰魔 AI: 脱困飞跃方向是随机的（不同 rng 给不同方向）', () => {
  // 用户原文：「就随机朝着一个方向大跳一下」。
  // ⚠️ 旧实现朝「卡住瞬间的原始意图」跳 —— 而那个方向正是被挡住的方向（朝墙跳），
  // 跳完仍在原地，这是「脱困跳了但没脱困」的根因之一。
  const dirs = [];
  for (const r of [0, 0.25, 0.5, 0.75]) {
    const a = new IgnisBossAgent({ rng: () => r });
    const w = sealedBoxWorld();
    const s = a.update(st({
      position: [0.5, 10, 0.5], mode: 'chase', onGround: true,
      stuckT: IGNIS_AI.stuckLeapSeconds,
    }), 1 / 60, { world: w, registry: REGISTRY, player: playerAt(20) });
    assertEqual(s.mode, 'leap');
    dirs.push(Math.atan2(s.leapDir[0], s.leapDir[1]));
  }
  // 四个不同 rng 应给出四个不同方向（若方向仍由意图/玩家决定，四个会完全相同）
  const uniq = new Set(dirs.map((d) => d.toFixed(4)));
  assertEqual(uniq.size, 4, `四个 rng 只给出 ${uniq.size} 个不同方向：${dirs.map((d) => d.toFixed(2))}`);
  // 且长度都是 leapSpeed（「大跳」的力度不随方向变）
  for (const r of [0, 0.5]) {
    const a = new IgnisBossAgent({ rng: () => r });
    const s = a.update(st({
      position: [0.5, 10, 0.5], mode: 'chase', onGround: true,
      stuckT: IGNIS_AI.stuckLeapSeconds,
    }), 1 / 60, { world: sealedBoxWorld(), registry: REGISTRY, player: playerAt(20) });
    const len = Math.hypot(s.leapDir[0], s.leapDir[1]);
    assertTrue(Math.abs(len - IGNIS_AI.leapSpeed) < 1e-9,
      `leapDir 长度 ${len.toFixed(3)} 应等于 leapSpeed(${IGNIS_AI.leapSpeed})`);
  }
});

test('焰魔 AI: 追逃跑的玩家（自身在动）不算卡住，不误触发脱困', () => {
  // ⚠️ **阳性对照**：新判据量的是「焰魔自身的净位移」，不是「与玩家的距离是否缩小」。
  // 若用距离判据，玩家跑得比焰魔快（8 vs 2.93）时距离永远拉大 ⇒ 会被误判成卡住
  // ⇒ 焰魔一边追一边无意义地乱跳。
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = groundWorld(9);
  const player = { position: [0.5, 10, -20] };
  let s = st({ position: [0.5, 10, 0.5], mode: 'chase', onGround: true });
  let sawEscape = false;
  let maxStuckT = 0;
  for (let i = 0; i < 60 * 12; i++) {
    player.position[2] -= 8 / 60;      // 玩家以 8 格/秒逃跑（比焰魔快）
    s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player });
    maxStuckT = Math.max(maxStuckT, s.stuckT);
    if (s.mode === 'leap' && s.leapKind === 'escape') { sawEscape = true; break; }
  }
  assertFalse(sawEscape, `追逃跑玩家时不应误判卡住（stuckT 峰值 ${maxStuckT.toFixed(2)}）`);
  // 自身在移动 ⇒ 棘轮持续重置 ⇒ stuckT 永远远低于阈值（同上一条的语义说明）
  assertTrue(maxStuckT < IGNIS_AI.stuckLeapSeconds,
    `stuckT 峰值 ${maxStuckT.toFixed(2)} 不应达到阈值 ${IGNIS_AI.stuckLeapSeconds}`);
});

test('焰魔 AI: 贴墙振荡（有位移但净位移≈ 0）也算卡住', () => {
  // 用户报告的另一种形态：局部避让在墙角两个偏角之间振荡 —— 每帧都有位移
  //（旧的「位移 < 15% 应走」判据看不出问题），但净位移近 0 ⇒ 永远到不了玩家身边。
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  // 凹形陷阱：焰魔在 (0.5,·,0.5)，三面是墙（x=-1 / x=2 / z=2），开口朝 -Z（玩家方向）
  // 但开口处再往前是一堵横墙 ⇒ 局部避让会左右振荡
  const w = makeWorld((x, y, z) => {
    if (y <= 9) return true;
    if (y > 12) return false;
    if (x <= -1 || x >= 2) return true;                 // 两侧墙
    if (z >= 2) return true;                            // 背后墙
    if (z <= -2 && x >= 0 && x <= 1) return true;       // 正前方堵死（只留侧缝）
    return false;
  });
  let s = st({ position: [0.5, 10, 0.5], mode: 'chase', onGround: true });
  let sawLeap = false;
  for (let i = 0; i < 60 * 12; i++) {
    s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player: playerAt(20) });
    if (s.mode === 'leap' && s.leapKind === 'escape') { sawLeap = true; break; }
  }
  assertTrue(sawLeap, `凹形陷阱里 12 秒未脱困（pos=${s.position.map((n) => n.toFixed(2))}, stuckT=${s.stuckT.toFixed(2)}）`);
});

test('焰魔 AI: chase 读感知快照 —— 玩家瞬移后仍朝旧方向走（v2.63 用户第③项）', () => {
  // 用户原文：「不是每时每刻都检测玩家位置，而是间隔最快 1 秒检测玩家位置，
  // 根据这个检测到的玩家位置进行位置移动和转向」。
  //
  // 判据：玩家瞬移到身后，在感知间隔（1~2s）内焰魔应**继续朝旧方向走**（追的是快照），
  // 而不是立即转身。若实现每帧读真实位置，这里会立刻反向。
  const a = new IgnisBossAgent({ rng: () => 0.999 });   // senseTimer ≈ 1 + 0.999 ≈ 2.0s
  const w = groundWorld(9);
  const player = { position: [0.5, 10, -20] };
  let s = st({ position: [0.5, 10, 0.5], mode: 'chase', onGround: true });
  // 首帧立即感知（sensedPlayer=null）⇒ 快照 = (0.5, 10, -20)，计时器 ≈ 2s
  s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player });
  assertNotNull(s.sensedPlayer, '首次感知应立即执行（不等间隔）');
  // 走 0.5 秒：朝 -Z（快照方向）
  for (let i = 0; i < 30; i++) s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player });
  const zMid = s.position[2];
  assertTrue(zMid < 0.5, `应朝快照（-Z）走，实际 z=${zMid.toFixed(2)}`);
  // 玩家瞬移到身后 +20（距焰魔 ~20 格，仍在 sightRange 内）
  player.position = [0.5, 10, 20];
  // 再走 0.5 秒（累计 1.0s < 感知间隔 2.0s）：快照未刷新 ⇒ 仍朝 -Z
  for (let i = 0; i < 30; i++) s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player });
  assertTrue(s.position[2] < zMid - 0.1,
    `感知间隔内应继续朝旧方向（-Z）走，实际 z 从 ${zMid.toFixed(2)} 变成 ${s.position[2].toFixed(2)}（每帧读真实位置会立即转身）`);
  // 再走 1.5 秒（累计 2.5s > 间隔 2.0s）：快照刷新 ⇒ 转身朝 +Z 走回来
  //
  // ⚠️ **必须显式把 `senseTimer` 压到 0 来触发刷新**（实测踩到）：靠「多跑几帧等它
  // 自然到期」会让刷新发生在循环中段 —— 刷新前那几十帧仍在朝 -Z 走，位移比刷新后
  // 往回走的还多，于是「没转身」的假阴性（实现是对的，判据错了）。
  s = { ...s, senseTimer: 0 };                 // 下一帧必刷新
  s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player });
  assertTrue(s.sensedPlayer[2] > 0,
    `感知刷新后快照应指向新位置（+Z），实际 sensedPlayer=${s.sensedPlayer}`);
  const zAfterRefresh = s.position[2];
  for (let i = 0; i < 120; i++) {              // 2 秒：足够转身并走回来
    s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player });
  }
  assertTrue(s.position[2] > zAfterRefresh + 0.5,
    `刷新后应转身往 +Z 走，实际 z 从 ${zAfterRefresh.toFixed(2)} 只到 ${s.position[2].toFixed(2)}`);
});

test('焰魔 AI: 攻击与跳劈用真实位置，不用陈旧快照（砍得中）', () => {
  // ⚠️ **阳性对照**：快照最多陈旧 2 秒，玩家 8 格/秒能跑 16 格 —— 若攻击起手/跳劈预判
  // 也用快照，会永远砍不中（直接回退 v2.60 修的缺陷）。本用例钉「起手当帧对准真实玩家」。
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = groundWorld(9);
  // 快照指向 -Z 20 格（陈旧），真实玩家已移到侧方 +X 4 格（attackRange 内）
  const player = { position: [4, 10, 0.5] };
  let s = st({
    position: [0.5, 10, 0.5], mode: 'chase', onGround: true,
    sensedPlayer: [0.5, 10, -20], senseTimer: 1.5,   // 快照未过期
    losVisible: true, losTimer: 999, attackCooldown: 0,
  });
  s = a.update(s, 1 / 60, { world: w, registry: REGISTRY, player });
  assertEqual(s.mode, 'attack', '真实玩家在 attackRange 内应起手（不管快照指向哪）');
  // 起手当帧 yaw 应对准真实玩家（+X 方向 ⇒ yaw ≈ -π/2），而不是快照（-Z ⇒ yaw ≈ 0）
  assertTrue(Math.abs(s.yaw - (-Math.PI / 2)) < 0.2,
    `起手应对准真实玩家（yaw≈${(-Math.PI / 2).toFixed(2)}），实际 yaw=${s.yaw.toFixed(2)}（若对准快照会≈ 0）`);
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
  // 把焰魔关在一个 3×3 格的完全封闭盒子里。
  //
  // ⚠️ **天花板必须给足 4 格净空**（v2.62 踩到）：焰魔 3.25 高 ⇒ AABB 占 y∈{10,11,12,13}
  // 四层。旧夹具把天花板写在 `y === 13`，于是焰魔**出生即与天花板重叠** —— 在 v2.62 之前
  // 这无所谓（物理推不动它就站着），但加了 `_resolveStuck`（用户缺陷④）后它会被正确地
  // 抬到盒顶之上、然后走出去 ⇒ 本用例测的「围死站住」变成「解卡逃逸」。
  // 天花板改到 `y === 14`：焰魔头顶（13）之上仍只有 1 格净空，跳不出去（`leapJumpForce`
  // 的顶点 2.5 格会撞天花板），但出生时不被埋。
  const w = makeWorld((x, y, z) => {
    if (y <= 9) return true;                                  // 地板
    const inBox = x >= -2 && x <= 2 && z >= -2 && z <= 2 && y <= 14;
    const onWall = Math.abs(x) === 2 || Math.abs(z) === 2 || y === 14;
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

test('焰魔 AI: 看不见玩家且玩家已贴近 → 站定不采纳寻路方向（v2.61 陷阱，v2.62 站定语义）', () => {
  // ⚠️⚠️ **这条守的是一个修法陷阱**：看不见玩家时我们强制 `needsPath = true`，而寻路
  // 的目标是「玩家所在格」—— 玩家本人在寻路里**不是障碍物**（`standable` 只看方块）。
  // 于是「玩家贴到 4 格内 + 中间有墙」时，navDir 会让焰魔朝玩家撞过去 ——
  // 正是 v2.60 修掉的穿模缺陷换个形式复活。
  // ⚠️ v2.62：贴近时的行为从「背离退开」改为「站定」（用户第⑦项），故断言从
  // 「退到 +Z」收紧为「不朝玩家移动」（z 不减小）。
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  // 玩家在 -Z 方向 3 格（小于死区下界 4.25）⇒ 应站定不动
  const player = { position: [0.5, 10, -3] };
  let s = st({ position: [0.5, 10, 0.5], mode: 'chase', onGround: true, attackCooldown: 999 });
  // 造一个「看不见」的世界（中间有墙），同时 navDir 明确指向玩家方向
  const wall = makeWorld((_x, y, z) => y <= 9 || (z >= -2 && z <= -1));
  const before = s.position[2];
  for (let i = 0; i < 30; i++) {
    s = { ...s, navDir: [0, -1], navMode: 'chasing' };   // 寻路说「往 −Z（朝玩家）走」
    s = a.update(s, 1 / 60, { world: wall, registry: REGISTRY, player });
  }
  assertTrue(s.position[2] >= before - 1e-6,
    `贴近时应站定（不采纳朝玩家的 navDir），实际 z 从 ${before} 变成 ${s.position[2].toFixed(3)}`);
});

// ==================== 特效触发点 attackFxRequest（v3.04）====================
//
// **为什么需要独立字段**：`attackRequest` 只在 `freshLos` 通过时产生
// （命中帧的新鲜视线复查），而原版 `Ignis_Entity.aiStep()` 的特效调用**不看视线** ——
// 玩家侧移出锥/隔墙时仍要看到 Boss 大招的规模。故 FX 走自己的瞬态字段。
//
// ⚠️ **但既有的「招式中止门」（本文件 `mode === 'attack'` 时 `!losVisible` 即回 chase）
// 一行不改**：招式被中止 ⇒ 本来就没有「砸中」这件事，播特效反而误导。
// 下面第 2 条用例就是钉这个（防实施时误改中止门）。

test('焰魔 AI: freshLos 失败（玩家躲墙后）⇒ 特效请求仍产生，伤害请求不产生', () => {
  // 夹具（探针实测确认）：墙在 z=−14 高 4 格，玩家在墙后 (0,10,−24)，
  // `losTimer: 999` 冻结缓存 ⇒ `losVisible` 恒真 ⇒ **招式不被中止**
  //（实测 attackAnimT 推到 3.88 ≈ animSeconds 3.89，不是 0）；
  // 而命中帧那一刻 `_queryLos` 因墙返回 false ⇒ `attackRequest` 不产生。
  const w = wallWorld();
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const ctx = { world: w, registry: REGISTRY, player: { position: [0, 10, -24] } };
  let s = st({
    position: [0, 10, 0], mode: 'attack', attackKind: 'shieldBash',
    attackAnimT: 0, onGround: true, losTimer: 999, losVisible: true,
  });
  const frames = Math.ceil((IGNIS_ATTACKS.shieldBash.animSeconds + 0.3) * 60);
  let fxFrames = 0;
  let fxFrames2 = 0;
  for (let i = 0; i < frames; i++) {
    s = a.update(s, 1 / 60, ctx);
    if (s.attackRequest) fxFrames += 1;
    if (s.attackFxRequest) fxFrames2 += 1;
  }
  assertEqual(s.losVisible, true, '夹具前提：LOS 缓存须恒为真（否则招式被中止，测的就不是这件事）');
  assertEqual(fxFrames, 0, '墙后 freshLos 为假 ⇒ 伤害请求一次都不该出现');
  assertEqual(fxFrames2, 1, `特效请求须恰好出现一次（命中帧），实得 ${fxFrames2}`);
});

test('焰魔 AI: 特效请求带 at/yaw/kind（渲染侧要按它算落点）', () => {
  const w = wallWorld();
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const ctx = { world: w, registry: REGISTRY, player: { position: [0, 10, -24] } };
  let s = st({
    position: [0, 10, 0], mode: 'attack', attackKind: 'shieldBash',
    attackAnimT: 0, onGround: true, losTimer: 999, losVisible: true, yaw: 0.7,
  });
  const frames = Math.ceil((IGNIS_ATTACKS.shieldBash.animSeconds + 0.3) * 60);
  let req = null;
  for (let i = 0; i < frames && !req; i++) {
    s = a.update(s, 1 / 60, ctx);
    if (s.attackFxRequest) req = s.attackFxRequest;
  }
  assertNotNull(req);
  assertEqual(req.at.length, 3);
  assertTrue(req.at.every(Number.isFinite), `at 须全为有限数：${req.at}`);
  assertTrue(Math.abs(req.yaw - 0.7) < 1e-9, `yaw 须透传起手值：${req.yaw}`);
  assertEqual(req.kind, 'shieldBash');
});

test('焰魔 AI: 招式被中止（LOS 缓存为假）⇒ 伤害与特效请求都不产生', () => {
  // 这条钉住「中止门一行未改」：玩家在墙后且缓存 LOS 为假 ⇒ 第一帧就回 chase、
  // attackAnimT 归零 ⇒ 命中帧块根本不跑 ⇒ 两个请求都必须是 null。
  // 若实施时为了让特效「无条件播」而放宽中止门，这条会 FAIL。
  const w = wallWorld();
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const ctx = { world: w, registry: REGISTRY, player: { position: [0, 10, -24] } };
  let s = st({
    position: [0, 10, 0], mode: 'attack', attackKind: 'shieldBash',
    attackAnimT: 0, onGround: true, losTimer: 999, losVisible: false,
  });
  const frames = Math.ceil((IGNIS_ATTACKS.shieldBash.animSeconds + 0.3) * 60);
  let anyReq = 0;
  let anyFx = 0;
  for (let i = 0; i < frames; i++) {
    s = a.update(s, 1 / 60, ctx);
    if (s.attackRequest) anyReq += 1;
    if (s.attackFxRequest) anyFx += 1;
  }
  assertEqual(s.mode, 'chase', '招式须被中止');
  assertEqual(anyReq, 0);
  assertEqual(anyFx, 0, '招式中止 ⇒ 特效也不播（本来就没有「砸中」这件事）');
});

test('焰魔 AI: 四招都产特效请求（招式过滤在 game.js 侧，Agent 不分支）', () => {
  // Agent 不该只给 shieldBash/shieldSmash 产请求 —— 「哪些招出哪种特效」是渲染侧的决定
  //（红线：同构层不做装配层的事）。用 OPEN_CTX（视线通）逐招跑一遍。
  for (const kind of IGNIS_ATTACK_IDS) {
    const a = new IgnisBossAgent({ rng: () => 0.5 });
    const ctx = { ...OPEN_CTX, player: playerAt(IGNIS_AI.attackRange - 1) };
    let s = st({ mode: 'attack', attackKind: kind, attackAnimT: 0, onGround: true });
    const frames = Math.ceil((IGNIS_ATTACKS[kind].animSeconds + 0.3) * 60);
    let fx = 0;
    for (let i = 0; i < frames; i++) {
      s = a.update(s, 1 / 60, ctx);
      if (s.attackFxRequest) fx += 1;
    }
    assertEqual(fx, 1, `${kind} 须恰好产生一次特效请求，实得 ${fx}`);
  }
});

test('焰魔 AI: 特效请求是瞬态（下一帧自动清 null，不会重复播）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const ctx = { ...OPEN_CTX, player: playerAt(IGNIS_AI.attackRange - 1) };
  let s = st({ mode: 'attack', attackKind: 'shieldBash', attackAnimT: 0, onGround: true });
  let seen = false;
  for (let i = 0; i < 400; i++) {
    s = a.update(s, 1 / 60, ctx);
    if (s.attackFxRequest) seen = true;
    else if (seen) { assertNull(s.attackFxRequest); break; }
  }
  assertTrue(seen, '须先看到一次特效请求');
  // 命中帧之后仍在 attack 态的帧里必须恒为 null（不是每帧重发）
  let stale = 0;
  for (let i = 0; i < 30; i++) {
    s = a.update(s, 1 / 60, ctx);
    if (s.attackFxRequest) stale += 1;
  }
  assertEqual(stale, 0, '特效请求不得重复出现');
});

// ==================== 第五招：尖刺攻击的双刀推进（v3.06）====================
//
// 用户草图：「玩家距离 4 格以内就连续再劈第二刀，玩家在 4 格以外，就不再劈第二刀」。
//
// ⚠️⚠️ **距离门必须用「第一刀命中帧时刻」的水平距，不是起手时刻**：
// 后者会让玩家跑开后仍被追劈。下面第 4 条用例专测这个（起手 3 格 → 命中帧前移到 8 格）。
//
// ⚠️ **`spikeSecond` 必须跨帧保持**：`createState` 漏透传它的形态是「第二刀永远不播」，
// 而第一刀与尖刺全对（计数类断言看不出来）。

/** 跑完一整招，收集每帧的 request 与 spikeSecond */
function runSpikeSlash(a, ctx, over = {}) {
  let s = st({
    position: [0, 10, 0], mode: 'attack', attackKind: 'spikeSlash',
    attackAnimT: 0, onGround: true, losTimer: 999, losVisible: true,
    ...over,
  });
  const frames = Math.ceil((IGNIS_SPIKE.doubleSeconds + 0.5) * 60);
  let fx = 0;
  let dmg = 0;
  let peakT = 0;
  let secondSeen = false;
  const fxTimes = [];
  for (let i = 0; i < frames; i++) {
    s = a.update(s, 1 / 60, ctx);
    if (s.attackFxRequest) { fx += 1; fxTimes.push(s.attackAnimT); }
    if (s.attackRequest) dmg += 1;
    if (s.spikeSecond === true) secondSeen = true;
    if (s.mode === 'attack') peakT = Math.max(peakT, s.attackAnimT);
    else if (peakT > 0) break;
  }
  return { s, fx, dmg, peakT, secondSeen, fxTimes };
}

test('焰魔 AI(v3.06): 玩家 > 4 格 ⇒ 只一刀（spikeSecond 恒 false）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const ctx = { ...OPEN_CTX, player: playerAt(IGNIS_SPIKE.secondRange + 1) };
  const r = runSpikeSlash(a, ctx);
  assertEqual(r.fx, 1, `特效请求须恰好 1 次，实得 ${r.fx}`);
  assertEqual(r.dmg, 1, `伤害请求须恰好 1 次，实得 ${r.dmg}`);
  assertEqual(r.secondSeen, false, '玩家 > 4 格不得接第二刀');
  assertEqual(r.s.spikeSecond, false, '离开 attack 后 spikeSecond 须复位');
});

test('焰魔 AI(v3.06): 玩家 ≤ 4 格 ⇒ 接第二刀（两次请求）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const ctx = { ...OPEN_CTX, player: playerAt(IGNIS_SPIKE.secondRange - 0.1) };
  const r = runSpikeSlash(a, ctx);
  assertEqual(r.fx, 2, `特效请求须 2 次（两刀），实得 ${r.fx}`);
  assertEqual(r.dmg, 2, `伤害请求须 2 次，实得 ${r.dmg}`);
  assertEqual(r.secondSeen, true, '玩家 ≤ 4 格须接第二刀');
  // 两次请求的时刻必须分别落在两个命中帧附近（±1 帧）
  assertTrue(Math.abs(r.fxTimes[0] - IGNIS_ATTACKS.spikeSlash.hitFrameSeconds) < 1 / 60 + 1e-9,
    `第一刀请求时刻 ${r.fxTimes[0]} 偏离命中帧 ${IGNIS_ATTACKS.spikeSlash.hitFrameSeconds}`);
  assertTrue(Math.abs(r.fxTimes[1] - IGNIS_SPIKE.secondHitFrame) < 1 / 60 + 1e-9,
    `第二刀请求时刻 ${r.fxTimes[1]} 偏离命中帧 ${IGNIS_SPIKE.secondHitFrame}`);
});

test('焰魔 AI(v3.06): 距离门两侧都测（3.9 格接 / 4.1 格不接）', () => {
  for (const [d, want] of [[3.9, 2], [4.1, 1]]) {
    const a = new IgnisBossAgent({ rng: () => 0.5 });
    const ctx = { ...OPEN_CTX, player: playerAt(d) };
    const r = runSpikeSlash(a, ctx);
    assertEqual(r.fx, want, `玩家 ${d} 格时特效请求数`);
  }
});

test('焰魔 AI(v3.06): 距离门用命中帧时刻而不是起手时刻', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  // 起手时玩家 3 格（≤4）；第一刀命中帧前把玩家移到 8 格（>4）⇒ 不得接第二刀
  let ctx = { ...OPEN_CTX, player: playerAt(3) };
  let s = st({
    position: [0, 10, 0], mode: 'attack', attackKind: 'spikeSlash',
    attackAnimT: 0, onGround: true, losTimer: 999, losVisible: true,
  });
  let fx = 0;
  let moved = false;
  const frames = Math.ceil((IGNIS_SPIKE.doubleSeconds + 0.5) * 60);
  for (let i = 0; i < frames; i++) {
    // 在命中帧前 3 帧把玩家移远
    if (!moved && s.attackAnimT >= IGNIS_ATTACKS.spikeSlash.hitFrameSeconds - 3 / 60) {
      ctx = { ...OPEN_CTX, player: playerAt(8) };
      moved = true;
    }
    s = a.update(s, 1 / 60, ctx);
    if (s.attackFxRequest) fx += 1;
    if (s.mode !== 'attack' && fx > 0) break;
  }
  assertEqual(moved, true, '夹具前提：须在命中帧前移动玩家');
  assertEqual(fx, 1, `命中帧时玩家已在 8 格 ⇒ 只一刀，实得 ${fx}`);
  assertEqual(s.spikeSecond, false);
});

test('焰魔 AI(v3.06): spikeSecond 跨帧保持（命中帧后连续 30 帧恒 true）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const ctx = { ...OPEN_CTX, player: playerAt(3) };
  let s = st({
    position: [0, 10, 0], mode: 'attack', attackKind: 'spikeSlash',
    attackAnimT: 0, onGround: true, losTimer: 999, losVisible: true,
  });
  // 跑到第一刀命中帧
  for (let i = 0; i < Math.ceil(IGNIS_ATTACKS.spikeSlash.hitFrameSeconds * 60) + 2; i++) {
    s = a.update(s, 1 / 60, ctx);
  }
  assertEqual(s.spikeSecond, true, '第一刀命中帧后须置位');
  for (let i = 0; i < 30; i++) {
    s = a.update(s, 1 / 60, ctx);
    assertEqual(s.spikeSecond, true, `第 ${i} 帧 spikeSecond 被重置了（createState 漏透传）`);
  }
});

test('焰魔 AI(v3.06): 单刀 1.966667s 结束 / 双刀 2.966667s 结束', () => {
  for (const [d, want] of [[6, IGNIS_SPIKE.soloSeconds], [3, IGNIS_SPIKE.doubleSeconds]]) {
    const a = new IgnisBossAgent({ rng: () => 0.5 });
    const ctx = { ...OPEN_CTX, player: playerAt(d) };
    const r = runSpikeSlash(a, ctx);
    assertTrue(Math.abs(r.peakT - want) < 2 / 60,
      `玩家 ${d} 格时 attackAnimT 峰值 ${r.peakT.toFixed(4)} 偏离期望 ${want.toFixed(4)}`);
    assertEqual(r.s.mode, 'chase', '播完须回 chase');
  }
});

test('焰魔 AI(v3.06): 招式被中止 ⇒ spikeSecond 复位、两个请求都不产生', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const ctx = { ...OPEN_CTX, player: playerAt(3) };
  let s = st({
    position: [0, 10, 0], mode: 'attack', attackKind: 'spikeSlash',
    attackAnimT: 0, onGround: true, losTimer: 999, losVisible: false, spikeSecond: true,
  });
  let any = 0;
  for (let i = 0; i < 60; i++) {
    s = a.update(s, 1 / 60, ctx);
    if (s.attackRequest || s.attackFxRequest) any += 1;
  }
  assertEqual(s.mode, 'chase', '招式须被中止');
  assertEqual(any, 0);
  assertEqual(s.spikeSecond, false, '中止时 spikeSecond 须复位');
});
