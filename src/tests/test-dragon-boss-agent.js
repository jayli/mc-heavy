// src/tests/test-dragon-boss-agent.js — 飞龙 Boss 智能体四态机（v2.44）
//
// 覆盖：状态转移（orbit→chase→attack→return→orbit 全环 + 阈值两侧 + 滞回）、
// 移动（chase 速度/yaw 平滑转向/attack 子态飞跃/return 追及轨道点）、
// orbit 委托注入的 poseAt（位置逐位相等）、LOS 缓存节奏（10Hz）。
//
// ⚠️ **开火条件不在本文件**（Task 3 补）：本文件构造的 state `fireCooldown` 恒 > 0，
// 任何 `fireRequest` 断言都应为 null。
//
// 派生量一律从**冻结常量**算出而非硬编码字面量（testing-policy §2.5）。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertDeepEqual } from './assert.js';
import { DragonBossAgent } from '../entities/bosses/dragon-boss-agent.js';
import { DRAGON_AI, DRAGON } from '../entities/dragons/dragon-config.js';
import { TARN_PLATEAU_Y } from '../gen/structures/tarn-zone.js';

/** 全空气 world（LOS 恒通）+ 空 registry */
function clearCtx(playerPos) {
  return {
    world: { getBlockId: () => 0 },
    registry: { solidTable: new Uint8Array(256), opaqueTable: new Uint8Array(256) },
    player: { position: playerPos },
  };
}

const ORBIT = Object.freeze({
  cx: 0, cz: 0, y: TARN_PLATEAU_Y + DRAGON.orbitYOffset,
  radius: DRAGON.orbitRadius, omega: DRAGON.orbitSpeed / DRAGON.orbitRadius, phase: 0,
});

/** 确定性 poseAt：位置 = 圆上 θ=orbitT 的点，yaw = π − θ（与真实 dragonPoseAt 同公式、无 bob） */
function fakePoseAt(orbit, t) {
  const theta = orbit.phase + orbit.omega * t;
  return {
    position: [orbit.cx + orbit.radius * Math.cos(theta), orbit.y, orbit.cz + orbit.radius * Math.sin(theta)],
    yaw: Math.PI - theta,
  };
}

/** 构造一个合法 state（缺省全字段，测试只覆盖关心的） */
function makeState(over = {}) {
  return {
    position: [24, ORBIT.y, 0],
    yaw: 0,
    orbit: ORBIT,
    orbitT: 0,
    health: DRAGON.health,
    flashedUntil: 0,
    mode: 'orbit',
    attackPhase: 'approach',
    fireCooldown: 999,   // 恒 > 0：本文件不测开火
    losTimer: 0,
    losVisible: false,
    turnDist: 0,
    fireRequest: null,
    ...over,
  };
}

// ==================== 状态转移 ====================

test('转移: orbit + 视线通 + 水平距 sightRange−1 → chase', () => {
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  const DRAGON_X = 24;
  // ⚠️ **玩家 x 必须从龙的位置派生**：首版把玩家放在 x=59 当作「距 59」，而龙在 x=24
  // ⇒ 实际水平距只有 35（断言描述的是想象中的世界，阈值根本没被测到）。
  const ctx = clearCtx([DRAGON_X + DRAGON_AI.sightRange - 1, 0, 0]);
  const next = agent.update(makeState({ position: [DRAGON_X, ORBIT.y, 0] }), 0.016, ctx);
  assertEqual(next.mode, 'chase', '距 sightRange−1 必须进入追击');
});

test('转移: orbit + 水平距 sightRange+1 → 仍 orbit（阈值外侧）', () => {
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  const DRAGON_X = 24;
  const ctx = clearCtx([DRAGON_X + DRAGON_AI.sightRange + 1, 0, 0]);
  const next = agent.update(makeState({ position: [DRAGON_X, ORBIT.y, 0] }), 0.016, ctx);
  assertEqual(next.mode, 'orbit', '距 sightRange+1 不得进入追击');
});

test('转移: orbit + 视线被挡 + 距 30 → 仍 orbit（视线判据真的生效）', () => {
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  const DRAGON_X = 24;
  // x=40 处一堵实心不透明墙（龙 x=24 与玩家 x=54 之间），玩家距 30 < sightRange
  const solidTable = new Uint8Array(256); solidTable[1] = 1;
  const opaqueTable = new Uint8Array(256); opaqueTable[1] = 1;
  const ctx = {
    world: { getBlockId: (x) => (Math.floor(x) === 40 ? 1 : 0) },
    registry: { solidTable, opaqueTable },
    player: { position: [DRAGON_X + 30, 0, 0] },
  };
  const next = agent.update(makeState({ position: [DRAGON_X, ORBIT.y, 0] }), 0.016, ctx);
  assertEqual(next.mode, 'orbit', '视线被实心不透明方块挡住时不得追击（哪怕只有 30 格）');
});

test('转移: chase + 距 19 → attack；距 21 → 仍 chase（阈值两侧）', () => {
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  const near = agent.update(makeState({ mode: 'chase', position: [24, ORBIT.y, 0] }), 0.016, clearCtx([43, 0, 0]));
  assertEqual(near.mode, 'attack', '距 19（≤ attackRange）必须进入攻击');
  const far = agent.update(makeState({ mode: 'chase', position: [24, ORBIT.y, 0] }), 0.016, clearCtx([45, 0, 0]));
  assertEqual(far.mode, 'chase', '距 21（> attackRange）不得进入攻击');
});

test('转移: attack + 距 disengage+1 → return；距 disengage−1 → 仍 attack（滞回：60 进 / 78 出）', () => {
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  const DRAGON_X = 24;
  // ⚠️ **`orbitT` 必须让轨道点远离龙**：首版用 orbitT=0（轨道点 = (24,y,0) = 龙的位置）
  // ⇒ 进入 return 的同一帧就「已到达」切回 orbit，断言读到的是 orbit 而不是 return。
  // 实现行为是对的（已在轨道点上就该立即盘旋），错的是夹具。
  const ORBIT_T = 10;   // 轨道点 ≈ (−19.2, y, 14.4)，距龙 45 格
  const out = agent.update(
    makeState({ mode: 'attack', position: [DRAGON_X, ORBIT.y, 0], orbitT: ORBIT_T }),
    0.016, clearCtx([DRAGON_X + DRAGON_AI.disengageDistance + 1, 0, 0]),
  );
  assertEqual(out.mode, 'return', '距 disengageDistance+1 必须脱离');
  const inRange = agent.update(
    makeState({ mode: 'attack', position: [DRAGON_X, ORBIT.y, 0], orbitT: ORBIT_T }),
    0.016, clearCtx([DRAGON_X + DRAGON_AI.disengageDistance - 1, 0, 0]),
  );
  assertEqual(inRange.mode, 'attack', '距 disengageDistance−1 不得脱离（滞回防抖）');
});

test('转移: chase + 视线断 → return', () => {
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  const DRAGON_X = 24;
  const solidTable = new Uint8Array(256); solidTable[1] = 1;
  const opaqueTable = new Uint8Array(256); opaqueTable[1] = 1;
  const ctx = {
    world: { getBlockId: (x) => (Math.floor(x) === 40 ? 1 : 0) },
    registry: { solidTable, opaqueTable },
    player: { position: [DRAGON_X + 35, 0, 0] },   // 距 35 > attackRange ⇒ 不会先切 attack
  };
  // 同上：轨道点必须远离龙，否则 return 当帧就到达
  const next = agent.update(
    makeState({ mode: 'chase', position: [DRAGON_X, ORBIT.y, 0], orbitT: 10 }), 0.016, ctx,
  );
  assertEqual(next.mode, 'return', '追击中视线被挡必须脱离');
});

test('转移: return 追及轨道点（≤ returnArriveDistance）→ orbit', () => {
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  const R = DRAGON_AI.returnArriveDistance;
  // orbitT=0 的轨道点 = (24, y, 0)。龙在轨道点内侧 R/2 → 切 orbit
  const arrived = agent.update(
    makeState({ mode: 'return', position: [24 + R / 2, ORBIT.y, 0], orbitT: 0 }),
    0.016, clearCtx([500, 0, 500]),
  );
  assertEqual(arrived.mode, 'orbit', '到达轨道点必须切回盘旋');
  // 距 5×R > R → 仍 return
  const still = agent.update(
    makeState({ mode: 'return', position: [24 + R * 5, ORBIT.y, 0], orbitT: 0 }),
    0.016, clearCtx([500, 0, 500]),
  );
  assertEqual(still.mode, 'return', '未到轨道点不得提前切回');
});

// ==================== 移动 ====================

test('移动: chase 一帧水平位移 = chaseSpeed × dt，方向指向玩家', () => {
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  const dt = 0.016;
  const next = agent.update(
    makeState({ mode: 'chase', position: [24, ORBIT.y, 0], yaw: -Math.PI / 2 }),  // yaw 朝 +X
    dt, clearCtx([59, 0, 0]),
  );
  const dx = next.position[0] - 24;
  const expect = DRAGON_AI.chaseSpeed * dt;
  assertTrue(Math.abs(dx - expect) < 1e-9, `x 位移 ${dx} ≠ ${expect}`);
  assertTrue(Math.abs(next.position[2]) < 1e-9, '玩家在 +X 轴上，z 不得漂移');
});

test('移动: chase 的 y 恒在 bob 带内（复用 poseAt 的 y，不俯冲不爬升）', () => {
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  let st = makeState({ mode: 'chase', position: [24, ORBIT.y, 0], yaw: -Math.PI / 2 });
  for (let i = 0; i < 60; i++) st = agent.update(st, 0.016, clearCtx([59, 0, 0]));
  assertTrue(Math.abs(st.position[1] - ORBIT.y) <= DRAGON.bobAmplitude + 1e-9,
    `chase 60 帧后 y=${st.position[1]} 越出 ${ORBIT.y}±${DRAGON.bobAmplitude}`);
});

test('移动: chase 的 yaw 朝玩家平滑转向（速率 ≤ turnRate，方向正确）', () => {
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  const dt = 0.016;
  // 龙 yaw=0（朝北 −Z），玩家在正东 (+X) → 目标 yaw=−π/2，差 −π/2
  const next = agent.update(makeState({ mode: 'chase', position: [24, ORBIT.y, 0], yaw: 0 }), dt, clearCtx([59, 0, 0]));
  const diff = next.yaw - 0;
  assertTrue(diff < 0, '玩家在东侧，yaw 应朝负方向转');
  assertTrue(Math.abs(diff) <= DRAGON_AI.turnRate * dt + 1e-9,
    `单帧转角 ${Math.abs(diff)} 超过 turnRate×dt=${DRAGON_AI.turnRate * dt}`);
  assertTrue(Math.abs(diff) > DRAGON_AI.turnRate * dt * 0.9, '转角应接近上限（差 −π/2 远大于单帧上限）');
});

test('移动: attack 的 approach 递近到 flyoverDistance → 切 turn', () => {
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  // 龙 (24,y,0) 朝 +X，玩家 (29,0,0)：距 5 ≤ flyoverDistance 6 → 当帧切 turn
  const next = agent.update(
    makeState({ mode: 'attack', attackPhase: 'approach', position: [24, ORBIT.y, 0], yaw: -Math.PI / 2 }),
    0.016, clearCtx([29, 0, 0]),
  );
  assertEqual(next.attackPhase, 'turn', '递近到 flyoverDistance 必须切飞跃子态');
});

test('移动: attack 的 turn 外飞累计 turnAroundDistance → 回 approach', () => {
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  const dt = 0.016;
  let st = makeState({ mode: 'attack', attackPhase: 'turn', position: [24, ORBIT.y, 0], yaw: -Math.PI / 2, turnDist: 0 });
  const ctx = clearCtx([29, 0, 0]);
  let frames = 0;
  while (st.attackPhase === 'turn' && frames < 400) { st = agent.update(st, dt, ctx); frames++; }
  assertEqual(st.attackPhase, 'approach', 'turn 累计到 turnAroundDistance 必须掉头回 approach');
  const expectFrames = Math.ceil(DRAGON_AI.turnAroundDistance / (DRAGON_AI.chaseSpeed * dt));
  assertTrue(Math.abs(frames - expectFrames) <= 2,
    `掉头帧数 ${frames} 应 ≈ ${expectFrames}（22 格 / 每帧 ${DRAGON_AI.chaseSpeed * dt} 格）`);
});

test('移动: orbit 模式位置逐位等于注入 poseAt 的输出（委托关系）', () => {
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  const st = makeState({ mode: 'orbit', orbitT: 3.5 });
  const next = agent.update(st, 0.016, clearCtx([500, 0, 500]));   // 玩家很远，不触发
  const expect = fakePoseAt(ORBIT, next.orbitT);
  assertDeepEqual(next.position, expect.position, 'orbit 位置必须逐位来自 poseAt');
  assertEqual(next.yaw, expect.yaw, 'orbit yaw 必须逐位来自 poseAt');
});

test('移动: 返回全新 state 与全新 position 数组（M5 不变式）', () => {
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  const st = makeState({ mode: 'chase', position: [24, ORBIT.y, 0], yaw: -Math.PI / 2 });
  const next = agent.update(st, 0.016, clearCtx([59, 0, 0]));
  assertTrue(next !== st, '必须返回全新对象');
  assertTrue(next.position !== st.position, 'position 数组必须是新引用（原地改写会让 column 索引永不迁移）');
});

// ==================== 开火条件（Task 3）====================

/** 龙在 (0,y,0)、玩家在正东 +X 远处：yaw=−π/2 即对准玩家 */
const FIRE_DRAGON = [0, ORBIT.y, 0];
const FIRE_YAW = -Math.PI / 2;   // 前向 = (+1, 0) = 正东

/** 构造「四条开火条件全满足」的 state（调用方逐项破坏其中一条） */
function fireState(over = {}) {
  return makeState({
    mode: 'chase', position: FIRE_DRAGON, yaw: FIRE_YAW,
    fireCooldown: 0, losTimer: 999, losVisible: true,   // 缓存说「通」且不重查
    orbitT: 10, ...over,
  });
}

/** 可切换遮挡的 world（测「开火瞬间新鲜复查」用） */
function switchableWorld(state) {
  const solidTable = new Uint8Array(256); solidTable[1] = 1;
  const opaqueTable = new Uint8Array(256); opaqueTable[1] = 1;
  return {
    world: { getBlockId: (x) => (state.blocked && Math.floor(x) === 40 ? 1 : 0) },
    registry: { solidTable, opaqueTable },
  };
}

test('开火: 四条全满足 → fireRequest 指向玩家胸部且归一化', () => {
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  const px = FIRE_DRAGON[0] + 30;   // 距 30 < fireRange
  const ctx = { ...switchableWorld({ blocked: false }), player: { position: [px, 0, 0] } };
  const next = agent.update(fireState(), 0.016, ctx);
  assertTrue(next.fireRequest !== null, '四条全满足必须开火');
  const { position, direction } = next.fireRequest;
  assertDeepEqual(position, next.position, '火球出生点 = 龙的身体中心');
  const len = Math.hypot(...direction);
  assertTrue(Math.abs(len - 1) < 1e-9, `direction 必须归一化，实际长度 ${len}`);
  // 指向玩家胸部（y + playerAimOffsetY）：从龙 (0,30,0) 到 (30,1,0)
  const expect = [px - next.position[0], 0 + DRAGON_AI.playerAimOffsetY - next.position[1], 0];
  const el = Math.hypot(...expect);
  for (let i = 0; i < 3; i++) {
    assertTrue(Math.abs(direction[i] - expect[i] / el) < 1e-9,
      `direction[${i}]=${direction[i]} ≠ ${expect[i] / el}（必须瞄准玩家胸部）`);
  }
});

test('开火: 锥外（yaw 偏离 > fireConeDeg）→ 不喷火；锥内 → 喷', () => {
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  const ctx = { ...switchableWorld({ blocked: false }), player: { position: [30, 0, 0] } };
  const cone = DRAGON_AI.fireConeDeg * Math.PI / 180;
  // ⚠️ 初始偏离取 cone + 10°：chase 每帧只转 turnRate×dt ≈ 2.75°，一帧后仍 > cone
  const out = agent.update(fireState({ yaw: FIRE_YAW + cone + 10 * Math.PI / 180 }), 0.016, ctx);
  assertEqual(out.fireRequest, null, '脑袋没对准玩家不得喷火');
  assertTrue(Math.abs(agent._angleDiff(out.yaw, agent._angleTo(out.position, [30, 0, 0]))) > cone,
    'sanity：该帧结束时 yaw 确实在锥外（否则本用例测不到锥角）');
  const inCone = agent.update(fireState(), 0.016, ctx);
  assertTrue(inCone.fireRequest !== null, 'yaw 对准玩家必须喷火');
});

test('开火: 冷却未到 → 不喷火；到点 → 喷', () => {
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  const ctx = { ...switchableWorld({ blocked: false }), player: { position: [30, 0, 0] } };
  const cooling = agent.update(fireState({ fireCooldown: 1 }), 0.016, ctx);
  assertEqual(cooling.fireRequest, null, '冷却中不得喷火（用户：不能像机关枪）');
  const ready = agent.update(fireState({ fireCooldown: 0 }), 0.016, ctx);
  assertTrue(ready.fireRequest !== null, '冷却到点必须喷火');
});

test('开火: 缓存说视线通但新鲜复查不通 → 不喷火（不得用缓存）', () => {
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  const w = switchableWorld({ blocked: false });
  const ctx = { ...w, player: { position: [60, 0, 0] } };
  // 帧 1：无墙 → losVisible=true、losTimer 重置为 losInterval
  let st = agent.update(fireState({ fireCooldown: 999 }), 0.016, ctx);
  assertEqual(st.losVisible, true, 'sanity：帧 1 视线应通');
  // 帧 2：突然加墙，但 losTimer 未到期（缓存仍 true）→ 开火必须用新鲜复查
  w.world.getBlockId = (x) => (Math.floor(x) === 40 ? 1 : 0);
  st = agent.update({ ...st, fireCooldown: 0 }, 0.016, ctx);
  assertEqual(st.losVisible, true, 'sanity：缓存确实还没到期（仍为 true）');
  assertEqual(st.fireRequest, null, '隔着墙不得喷火（开火瞬间必须新鲜复查 LOS）');
});

test('开火: 水平距 > fireRange → 不喷火；≤ fireRange → 喷', () => {
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  const R = DRAGON_AI.fireRange;
  const far = { ...switchableWorld({ blocked: false }), player: { position: [R + 1, 0, 0] } };
  assertEqual(agent.update(fireState(), 0.016, far).fireRequest, null, '超出 fireRange 不得喷火');
  const near = { ...switchableWorld({ blocked: false }), player: { position: [R - 1, 0, 0] } };
  assertTrue(agent.update(fireState(), 0.016, near).fireRequest !== null, 'fireRange 内必须喷火');
});

test('开火: 冷却重置落在 [fireCooldownMin, fireCooldownMax]（rng 两端 + 中点）', () => {
  const { fireCooldownMin: lo, fireCooldownMax: hi } = DRAGON_AI;
  for (const [r, expect] of [[0, lo], [0.5, (lo + hi) / 2], [1, hi]]) {
    const agent = new DragonBossAgent({ poseAt: fakePoseAt, rng: () => r });
    const ctx = { ...switchableWorld({ blocked: false }), player: { position: [30, 0, 0] } };
    const next = agent.update(fireState(), 0.016, ctx);
    assertTrue(next.fireRequest !== null, `rng=${r} 应开火`);
    // 本帧已扣 dt，故期望值要减去这一帧的 dt
    const want = expect - 0.016;
    assertTrue(Math.abs(next.fireCooldown - want) < 1e-9,
      `rng=${r} 冷却 ${next.fireCooldown} ≠ ${want}（区间 [${lo}, ${hi}]）`);
  }
});

test('开火: orbit 与 return 模式永不喷火（模式门控）', () => {
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  // orbit：玩家在 sightRange 外（盘旋常态）→ 不喷火
  const orbitCtx = { ...switchableWorld({ blocked: false }), player: { position: [500, 0, 0] } };
  assertEqual(agent.update(makeState({ mode: 'orbit', fireCooldown: 0, losVisible: true, losTimer: 999 }), 0.016, orbitCtx).fireRequest,
    null, 'orbit（自由盘旋）不得喷火');
  // return：玩家在 fireRange 内、视线通、yaw 对准（轨道点也在 +X 方向）→ 仍不喷火
  const retCtx = { ...switchableWorld({ blocked: false }), player: { position: [30, 0, 0] } };
  const ret = agent.update(
    makeState({ mode: 'return', position: [0, ORBIT.y, 0], yaw: FIRE_YAW, fireCooldown: 0,
      losVisible: true, losTimer: 999, orbitT: 0 }),
    0.016, retCtx,
  );
  assertEqual(ret.mode, 'return', 'sanity：该帧仍在 return（没被转移走）');
  assertEqual(ret.fireRequest, null, 'return（回家途中）不得喷火');
});

test('开火: attack 模式也能喷火（chase 与 attack 共用判据）', () => {
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  const ctx = { ...switchableWorld({ blocked: false }), player: { position: [30, 0, 0] } };
  const next = agent.update(fireState({ mode: 'attack', attackPhase: 'approach' }), 0.016, ctx);
  assertEqual(next.mode, 'attack', 'sanity：距 30 > flyoverDistance，仍在 attack');
  assertTrue(next.fireRequest !== null, 'attack 模式必须能喷火');
});

test('开火: 无玩家上下文（player=null）→ 不喷火且不追击', () => {
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  const ctx = { ...switchableWorld({ blocked: false }), player: null };
  const next = agent.update(makeState({ mode: 'orbit', fireCooldown: 0, losVisible: true, losTimer: 999 }), 0.016, ctx);
  assertEqual(next.mode, 'orbit', '无玩家时保持盘旋');
  assertEqual(next.fireRequest, null, '无玩家时不得喷火');
});

// ==================== LOS 缓存节奏 ====================

test('LOS 缓存: 第 1 帧查 1 次，随后 6 帧不查，第 8 帧再查（10Hz）', () => {
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  let calls = 0;
  const ctx = {
    world: { getBlockId: () => { calls++; return 0; } },
    registry: { solidTable: new Uint8Array(256), opaqueTable: new Uint8Array(256) },
    player: { position: [59, 0, 0] },
  };
  const dt = 0.016;
  let st = makeState({ position: [24, ORBIT.y, 0] });
  st = agent.update(st, dt, ctx);
  const after1 = calls;
  assertTrue(after1 > 0, '第 1 帧必须查一次 LOS（缓存初值）');
  for (let i = 0; i < 6; i++) st = agent.update(st, dt, ctx);
  assertEqual(calls, after1, '第 2~7 帧不得重查 LOS（10Hz 缓存）');
  st = agent.update(st, dt, ctx);   // 第 8 帧：0.128s > 0.1s → 重查
  assertTrue(calls > after1, '第 8 帧必须重查 LOS（缓存到期）');
});
