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
import { dragonForward, dragonMuzzleOffsetWorld } from '../entities/dragons/dragon-facing.js';
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
    aimTime: 0,
    pitch: 0,          // v2.48：俯仰（负=低头）
    diveOffset: 0,     // v2.48：俯冲位移（≤0）
    fireRequest: null,
    ...over,
  };
}

/**
 * 嘴部世界坐标（与 Agent 的 `_muzzlePosition` 同公式，供断言用）。
 *
 * ⚠️ **公式不在这里手写**（v2.48）：它住在 `dragons/dragon-facing.js`（唯一权威），
 * 渲染层/命中盒/Agent/本夹具四处共用。各自抄一份会漂移出「看到的龙低头 40°、
 * 火球却按低头 20° 飞」而全绿（M8 炮塔「弹丸往天上飞」同类）。
 */
function muzzleWorld(pos, yaw, pitch = 0) {
  const off = dragonMuzzleOffsetWorld(yaw, pitch, DRAGON.muzzleOffset);
  return [pos[0] + off[0], pos[1] + off[1], pos[2] + off[2]];
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

test('移动: chase 的 y 只在俯冲时离开 bob 带，否则恒在带内', () => {
  // ⚠️ **v2.48 改了本条语义**：v2.44~v2.46 是「chase 永不升降」，现在俯冲会真的压低。
  // 所以判据拆两半：① 玩家**不在射程窗口**时 y 仍严格在 bob 带内（真正的零回归那一半）；
  // ② 在射程窗口内可以下潜，但不得越过 maxDiveDepth。
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  // ① 玩家远在 fireRange(60) 外（追击但还够不着）→ 不俯冲
  let st = makeState({ mode: 'chase', position: [24, ORBIT.y, 0], yaw: -Math.PI / 2 });
  for (let i = 0; i < 60; i++) st = agent.update(st, 0.016, clearCtx([5000, 0, 0]));
  assertTrue(Math.abs(st.position[1] - ORBIT.y) <= DRAGON.bobAmplitude + 1e-9,
    `射程外追击时 y=${st.position[1]} 越出 ${ORBIT.y}±${DRAGON.bobAmplitude}（不得俯冲）`);
  assertEqual(st.diveOffset, 0, '射程外不得有俯冲位移');
  // ② 玩家在射程内 → 允许下潜，但不越过 maxDiveDepth
  let near = makeState({ mode: 'chase', position: [24, ORBIT.y, 0], yaw: -Math.PI / 2 });
  let lowest = 0;
  for (let i = 0; i < 60; i++) {
    near = agent.update(near, 0.016, clearCtx([24 + 40, 0, 0]));
    lowest = Math.min(lowest, near.diveOffset);
  }
  assertTrue(lowest >= -DRAGON_AI.maxDiveDepth - 1e-9,
    `下潜 ${lowest} 超过 maxDiveDepth=${DRAGON_AI.maxDiveDepth}`);
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

/** 构造「开火条件全满足」的 state（调用方逐项破坏其中一条）。
 *  ⚠️ `aimTime` 缺省已满足瞄准保持（v2.45）—— 否则「刚进锥那一帧」永不喷火，
 *  本文件其余开火用例全会假失败。瞄准保持本身由下面专门的用例测。
 *  ⚠️ **v2.48 新增 `pitch` 预置**：双轴锥要求竖直也进。龙在 y=30、玩家在 30 格外地面时
 *  `aimPitch ≈ atan2(−28, 30) ≈ −43°`。夹具必须把这个姿态预置进去（否则每一条开火用例都要
 *  先跑 ~0.5 秒的低头过程，断言描述的是「尚未对准」而假失败）。
 *  `pitchOf(dragonY, px)` 从几何推导，不写死字面量（调常量后自动跟。 */
function aimPitchFor(dragonY, px) {
  return Math.atan2(0 + DRAGON_AI.playerAimOffsetY - dragonY, Math.abs(px));
}
/**
 * @param {object} [over] state 覆盖
 * @param {number} [playerX] 玩家水平距（用于推导默认 `pitch`）；缺省 30 = 下文绝大多数用例的几何
 */
function fireState(over = {}, playerX = 30) {
  return makeState({
    mode: 'chase', position: FIRE_DRAGON, yaw: FIRE_YAW,
    fireCooldown: 0, losTimer: 999, losVisible: true,   // 缓存说「通」且不重查
    aimTime: DRAGON_AI.aimHoldSeconds,
    pitch: aimPitchFor(FIRE_DRAGON[1], playerX),   // ← 已低头对准
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

test('开火: 条件全满足 → fireRequest 从**嘴部**出生、方向 = **机头前向**且归一化', () => {
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  const px = FIRE_DRAGON[0] + 30;   // 距 30 < fireRange
  const ctx = { ...switchableWorld({ blocked: false }), player: { position: [px, 0, 0] } };
  const next = agent.update(fireState(), 0.016, ctx);
  assertTrue(next.fireRequest !== null, '条件全满足必须开火');
  const { position, direction } = next.fireRequest;
  // ⚠️ v2.45：出生点 = 嘴部（身体中心 + yaw/pitch 旋转的 muzzleOffset）
  const expectMuzzle = muzzleWorld(next.position, next.yaw, next.pitch);
  for (let i = 0; i < 3; i++) {
    assertTrue(Math.abs(position[i] - expectMuzzle[i]) < 1e-9,
      `出生点[${i}]=${position[i]} ≠ 嘴部 ${expectMuzzle[i]}（必须从嘴吐，不是脖子）`);
  }
  // ⚠️ **v2.48：方向 = 机头前向**（用户裁定「严格随机头」），不是「嘴部→玩家」的点对点瞄准。
  const fwd = dragonForward(next.yaw, next.pitch);
  for (let i = 0; i < 3; i++) {
    assertTrue(Math.abs(direction[i] - fwd[i]) < 1e-9,
      `direction[${i}]=${direction[i]} ≠ 机头前向 ${fwd[i]}（火球必须沿机头飞）`);
  }
  const len = Math.hypot(...direction);
  assertTrue(Math.abs(len - 1) < 1e-9, `direction 必须归一化，实际长度 ${len}`);
  // ⚠️ **判别性 sanity：机头方向与该方向 ≠ 「嘴部→玩家胸部的点对点方向」**
  // 否则「随机头」与「瞄玩家」两种实现都能过本条（锥内时两者本就很近，必须有量差才算测到）。
  // 30 格外、低头 ~43° 时两者差约 1.4°（11 里 ~0.02），足以区分。
  const aim = [px - position[0], 0 + DRAGON_AI.playerAimOffsetY - position[1], 0 - position[2]];
  const al = Math.hypot(...aim);
  const toPlayer = aim.map((v) => v / al);
  const dev = Math.hypot(direction[0] - toPlayer[0], direction[1] - toPlayer[1], direction[2] - toPlayer[2]);
  assertTrue(dev > 1e-3,
    `机头方向与「指向玩家」重合了（偏差仅 ${dev}）—— 本条就变成无效用例，需调夹具几何`);
});

test('开火: 瞄准保持 —— 刚进锥（aimTime 不足）不喷，累积到 aimHoldSeconds 才喷', () => {
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  const ctx = { ...switchableWorld({ blocked: false }), player: { position: [30, 0, 0] } };
  const dt = 0.016;
  // ① 刚进锥那一帧（aimTime=0）：不得喷火 —— 这正是用户报告的「刚转身就吐火球」
  const first = agent.update(fireState({ aimTime: 0 }), dt, ctx);
  assertEqual(first.fireRequest, null, '刚对准那一帧不得喷火（用户：脑袋还没对准就吐很奇怪）');
  assertTrue(first.aimTime > 0, 'sanity：锥内必须开始累积瞄准时间');
  // ② 累积到不足阈值：仍不喷
  const frames = Math.ceil(DRAGON_AI.aimHoldSeconds / dt);
  let st = first;
  for (let i = 1; i < frames - 1; i++) st = agent.update(st, dt, ctx);
  assertEqual(st.fireRequest, null, `瞄准 ${st.aimTime.toFixed(3)}s < ${DRAGON_AI.aimHoldSeconds}s 不得喷火`);
  // ③ 再推进到阈值：必须喷
  st = agent.update(st, dt, ctx);
  assertTrue(st.fireRequest !== null,
    `瞄准累积到 ${st.aimTime.toFixed(3)}s ≥ ${DRAGON_AI.aimHoldSeconds}s 必须喷火`);
});

test('开火: 出锥即清零瞄准时间（扫过锥内不算「对准」）', () => {
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  const cone = DRAGON_AI.fireConeDeg * Math.PI / 180;
  const dt = 0.016;
  // 已瞄准 0.19s（差一帧就到阈值），但本帧 yaw 在锥外 → 必须清零且不喷
  const out = agent.update(
    fireState({ aimTime: DRAGON_AI.aimHoldSeconds - dt, yaw: FIRE_YAW + cone + 10 * Math.PI / 180 }),
    dt,
    { ...switchableWorld({ blocked: false }), player: { position: [30, 0, 0] } },
  );
  assertEqual(out.aimTime, 0, '出锥必须清零瞄准时间（否则「扫过」会被当成「对准」）');
  assertEqual(out.fireRequest, null, '出锥不得喷火');
});

test('开火: 喷火锥收紧到 10° —— 15° 偏离不喷（v2.44 的 20° 会喷）', () => {
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  assertEqual(DRAGON_AI.fireConeDeg, 10, '喷火锥半角必须是 10°（v2.45 用户裁定收紧）');
  const ctx = { ...switchableWorld({ blocked: false }), player: { position: [30, 0, 0] } };
  // 偏离 15°：在旧的 20° 锥内（会喷），在新的 10° 锥外（不得喷）—— 这条是判别性用例
  const off15 = agent.update(fireState({ yaw: FIRE_YAW + 15 * Math.PI / 180 }), 0.016, ctx);
  assertEqual(off15.fireRequest, null, '偏离 15° 不得喷火（旧 20° 锥会喷 ⇒ 本条钉住收紧）');
  assertEqual(off15.aimTime, 0, '偏离 15° 在锥外 ⇒ 瞄准时间不得累积');
  // 偏离 5°：在新锥内 → 喷
  const off5 = agent.update(fireState({ yaw: FIRE_YAW + 5 * Math.PI / 180 }), 0.016, ctx);
  assertTrue(off5.fireRequest !== null, '偏离 5°（锥内）必须喷火');
});

test('开火: 喷火后瞄准时间清零（下一发须重新对准）', () => {
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  const ctx = { ...switchableWorld({ blocked: false }), player: { position: [30, 0, 0] } };
  const fired = agent.update(fireState({ aimTime: DRAGON_AI.aimHoldSeconds * 3 }), 0.016, ctx);
  assertTrue(fired.fireRequest !== null, 'sanity：本帧必须喷火');
  assertEqual(fired.aimTime, 0, '喷火后瞄准时间必须清零（不得攒着下一发立刻喷）');
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

test('开火: 无玩家 / orbit / return 模式下瞄准时间不累积（恒 0）', () => {
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  const dt = 0.016;
  // orbit：yaw 恰好对准玩家也不累积（模式门控在瞄准之前）
  const orbit = agent.update(
    makeState({ mode: 'orbit', position: FIRE_DRAGON, yaw: FIRE_YAW, fireCooldown: 0,
      losVisible: true, losTimer: 999, aimTime: 0 }),
    dt, { ...switchableWorld({ blocked: false }), player: { position: [30, 0, 0] } },
  );
  assertEqual(orbit.aimTime, 0, 'orbit（自由盘旋）不得累积瞄准时间');
  // 无玩家
  const noPlayer = agent.update(
    fireState({ aimTime: 0 }), dt, { ...switchableWorld({ blocked: false }), player: null },
  );
  assertEqual(noPlayer.aimTime, 0, '无玩家上下文不得累积瞄准时间');
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
  // ⚠️ v2.48：pitch 夹具必须跟随玩家距离（否则距 59 时低头不够，双轴锥不进）
  const far = { ...switchableWorld({ blocked: false }), player: { position: [R + 1, 0, 0] } };
  assertEqual(agent.update(fireState({}, R + 1), 0.016, far).fireRequest, null, '超出 fireRange 不得喷火');
  const near = { ...switchableWorld({ blocked: false }), player: { position: [R - 1, 0, 0] } };
  assertTrue(agent.update(fireState({}, R - 1), 0.016, near).fireRequest !== null, 'fireRange 内必须喷火');
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

// ==================== v2.48 俯冲喷火（pitch / diveOffset / 双轴锥）====================

/**
 * 俯冲帧循环夹具：龙在 `dragonX` 盘旋高度、玩家在 `playerX` 地面，推进 `frames` 帧。
 * @returns {{state: object, minY: number, minPitch: number}}
 */
function runDive(agent, { dragonX = 0, playerX = 30, frames = 120, dt = 1 / 60 } = {}) {
  const ctx = clearCtx([playerX, 0, 0]);
  let st = makeState({ mode: 'chase', position: [dragonX, ORBIT.y, 0], yaw: -Math.PI / 2 });
  let minY = st.position[1];
  let minPitch = 0;
  for (let i = 0; i < frames; i++) {
    st = agent.update(st, dt, ctx);
    // ⚠️ 每帧都跟一下 y（龙在移动，不能用起点 y 比）
    minY = Math.min(minY, st.position[1] - fakePoseAt(ORBIT, st.orbitT).position[1]);
    minPitch = Math.min(minPitch, st.pitch);
  }
  return { state: st, minY, minPitch };
}

test('俯冲: diveOffset=0 且 pitch=0 时 y 与旧实现逐位相同（零回归）', () => {
  // ⚠️ 这是「v2.48 没改坏 v2.44~v2.46 的基本飞行」的大门：旧约定是 y ≡ poseAt().y。
  // 取一个不可瞄准的几何（玩家在 sightRange 外）⇒ 龙不进 chase、pitch 保持 0。
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  const ctx = clearCtx([5000, 0, 0]);
  let st = makeState({ mode: 'orbit' });
  for (let i = 0; i < 30; i++) {
    st = agent.update(st, 1 / 60, ctx);
    assertEqual(st.position[1], fakePoseAt(ORBIT, st.orbitT).position[1],
      'orbit 模式下 y 必须逐位等于 poseAt 的 y（不含任何浮点偏移）');
    assertEqual(st.pitch, 0, 'orbit 模式必须是平飞（pitch 恒 0）');
    assertEqual(st.diveOffset, 0, 'orbit 模式不得有俯冲位移');
  }
});

test('俯冲: 追击中低头（pitch 追向 aimPitch，速率 ≤ pitchRate）', () => {
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  const dt = 1 / 60;
  const st0 = makeState({ mode: 'chase', position: [0, ORBIT.y, 0], yaw: -Math.PI / 2 });
  const next = agent.update(st0, dt, clearCtx([30, 0, 0]));
  const want = Math.atan2(0 + DRAGON_AI.playerAimOffsetY - ORBIT.y, 30);
  assertTrue(next.pitch < 0, `玩家在地面时必须低头（pitch=${next.pitch}）`);
  // ⚠️ 容差 1e-12：本帧恰好被 pitchRate 钳住（−43° 远大于单帧上限），所以是**贴边界**的
  // 相等而非「小于」。用 1e-9 会被 IEEE754 尾差咬（实测差一个 ULP）。
  assertTrue(Math.abs(next.pitch) <= DRAGON_AI.pitchRate * dt + 1e-12,
    `单帧俯仰变化 ${next.pitch} 超出 pitchRate×dt=${DRAGON_AI.pitchRate * dt}`);
  // 推 1 秒后应已收敛到**当前** aimPitch：⚠️ 不能用开头的 `want` —— 龙以 9 格/秒逼近，
  // 1 秒内水平距 30 → ~21，目标俯仰本身在变陡（实测 30 格 −44.0° → 21 格 −53.4°）。
  // 拿旧目标比是「断言描述想象中的世界」。
  //
  // ⚠️ **容差必须是一整步 `pitchRate×dt`**，不能取 `1e-3`：目标本身每帧都在向陡处移动
  // （水平距每帧缩短 0.15 格 + bob 带每帧抬 0.022 格）⇒ 追赶型追踪器**结构上会落后
  // 一帧的量**（实测残差 0.00235 rad = 0.092 步）。这不是实现缺陷，是离散追踪器的固有跟踪滞后。
  let st = next;
  for (let i = 0; i < 60; i++) st = agent.update(st, dt, clearCtx([30, 0, 0]));
  const h = Math.hypot(st.position[0] - 30, st.position[2]);
  const wantNow = Math.atan2(0 + DRAGON_AI.playerAimOffsetY - st.position[1], h);
  assertTrue(Math.abs(st.pitch - wantNow) <= DRAGON_AI.pitchRate * dt + 1e-12,
    `1 秒后 pitch=${st.pitch} 与当前 aimPitch=${wantNow} 的差距超出一步` +
    `（pitchRate×dt=${DRAGON_AI.pitchRate * dt}）；水平距 ${h.toFixed(2)}`);
  // 正向对照：确实已大幅低头（防「pitch 恒 0 也能过上面那条」的无效盲区）
  assertTrue(st.pitch < -0.8, `sanity：1 秒后应已深度低头，实测 ${st.pitch}`);
});

test('俯冲: 低头会真的压低高度，且不超 maxDiveDepth / 不低于 minDiveY', () => {
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  // ⚠️ 玩家在固定位置不动，龙沿 yaw 往 +X 飞会越来越近 —— 这里只验下潜量的双闸门
  const { minY } = runDive(agent, { playerX: 40, frames: 180 });
  assertTrue(minY < -0.5, `低头后必须真的下潜，实测最深 ${minY} 格`);
  assertTrue(minY >= -DRAGON_AI.maxDiveDepth - 1e-9,
    `下潜 ${minY} 格超过 maxDiveDepth=${DRAGON_AI.maxDiveDepth}`);
  // 世界高度底线：orbitY + diveOffset ≥ minDiveY
  assertTrue(ORBIT.y + minY >= Math.min(DRAGON_AI.minDiveY, ORBIT.y) - 1e-9,
    `龙身 ${ORBIT.y + minY} 低于 minDiveY=${DRAGON_AI.minDiveY}`);
});

test('俯冲: 喷完火拉平后 diveOffset 缓归 0（回原飞行轨迹）', () => {
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  const dt = 1 / 60;
  // ① 先压下去（玩家在射程窗口内 40 格）
  let st = makeState({ mode: 'chase', position: [0, ORBIT.y, 0], yaw: -Math.PI / 2 });
  for (let i = 0; i < 90; i++) st = agent.update(st, dt, clearCtx([40, 0, 0]));
  const dived = st.diveOffset;
  assertTrue(dived < -1, `sanity：应当已下潜（diveOffset=${dived}）`);
  // ② 玩家突然远离（> fireRange）⇒ 出射程窗口 ⇒ aimPitch 归 0 ⇒ 拉平并爬回
  //    ⚠️ 这是用户要的「喷完火球后又返回原来的飞行轨迹」的机制层面。
  //    ⚠️ **回归窗口不能设得太短**：pitch 先从 −55° 以 90°/秒 抬到 0（~0.6 秒），
  //    再以 climbRate(4 格/秒) 爬 8 格（~2 秒）⇒ 全程 ~2.6 秒。30 帧只够抬鼻。
  const up = clearCtx([5000, 0, 0]);
  const before = st.diveOffset;
  let climbed = false;
  for (let i = 0; i < 60; i++) {
    st = agent.update(st, dt, up);
    if (st.diveOffset > before) climbed = true;
  }
  assertTrue(st.pitch >= -1e-6, `拉平后 pitch 必须回升到 ≥ 0，实际 ${st.pitch}`);
  assertTrue(climbed, '拉平后 diveOffset 必须以 climbRate 回升');
  // ③ 继续推进：必须真的回到 0（不是只回升一点）
  for (let i = 0; i < 200; i++) st = agent.update(st, dt, up);
  assertEqual(st.diveOffset, 0, '足够时间后 diveOffset 必须归零（回到原飞行轨迹）');
});

test('俯冲: 飞过头顶（水平距 < minFireDistance）永不喷火 —— v2.46 会喷（判别性用例）', () => {
  // ⚠️⚠️ **本条是整个 v2.48 的核心判据**（用户报告的「下蛋」）。
  //
  // 旧实现（v2.46）：`_inFireCone` 只看水平角 ⇒ 越过玩家头顶那一刻 Δyaw≈0 无条件通过
  // ⇒ 从**平飞**的身体上垂直喷出一球。
  //
  // 新实现有两道独立的门：
  //   ① **双轴锥**：`pitch` 追不上头顶所需的 −89°（clamp 在 −55°）—— 但那道门单独不够（见下）；
  //   ② **`minFireDistance`**：水平距 < 18 格时根本不进入射程窗口（`aimPitch` 归 0、不喷）。
  // ⚠️ **①单独不足以拦住头顶**：如果龙已经在 −55° 俯冲中飞过头顶，那瞬间 `aimPitch` 被 clamp 到
  // 同一个 −55° ⇒ 竖直角差 ≈ 0 ⇒ 双轴锥**会**通过。真正拦住它的是 ②。
  // 所以本条用**飞行过程**而非单帧来验（单帧验不出这道区别，也是个真实盲区）。
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  const dt = 1 / 60;
  // 龙在 y=30 沿 yaw=0（−Z 方向）平飞，玩家在起点北侧 25 格 → 龙会飞过他头顶继续往北
  let st = makeState({
    mode: 'chase', position: [0, ORBIT.y, 25], yaw: 0,
    fireCooldown: 0, losVisible: true, losTimer: 999,
  });
  let firedWhileOverhead = 0;
  let firedWhileInRange = 0;
  let sawOverhead = false;
  for (let i = 0; i < 600; i++) {
    const pz = 0;
    const hDist = Math.hypot(st.position[0], st.position[2] - pz);
    st = agent.update(st, dt, clearCtx([0, 0, pz]));
    if (st.fireRequest) {
      if (hDist < DRAGON_AI.minFireDistance) firedWhileOverhead++;
      else firedWhileInRange++;
    }
    if (hDist < 3) sawOverhead = true;
  }
  assertTrue(sawOverhead, 'sanity：龙应当真的飞过玩家头顶（否则本用例测不到该场景）');
  assertEqual(firedWhileOverhead, 0,
    `飞过头顶（水平距 < ${DRAGON_AI.minFireDistance}）时不得喷火 —— 用户：「好像下蛋一样」`);
  // ⚠️ 正向对照（防无效盲区）：不喷 must not be because 整条开火路径都没接线
  assertTrue(firedWhileInRange > 0,
    'sanity：远离阶段必须至少开过火（否则「头顶不喷」是无效判据）');
});

test('俯冲: 双轴锥 —— 水平对准但俯仰差太大 → 不喷；两轴都对 → 喷', () => {
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  const ctx = { ...switchableWorld({ blocked: false }), player: { position: [30, 0, 0] } };
  const want = aimPitchFor(FIRE_DRAGON[1], 30);
  const elevCone = DRAGON_AI.fireElevationConeDeg * Math.PI / 180;
  // ① 水平完美（FIRE_YAW）、俯仰差 3×锥 → 不喷
  const pitchOff = agent.update(
    fireState({ pitch: want - elevCone * 3 }), 0.016, ctx);
  assertEqual(pitchOff.fireRequest, null, '俯仰没对准（差 36°）不得喷火');
  assertEqual(pitchOff.aimTime, 0, '双轴锥不满足时瞄准时间不得累积');
  // ② 俯仰完美、水平差 3×锥 → 不喷
  const cone = DRAGON_AI.fireConeDeg * Math.PI / 180;
  const yawOff = agent.update(
    fireState({ yaw: FIRE_YAW + cone * 3 }), 0.016, ctx);
  assertEqual(yawOff.fireRequest, null, '水平没对准（差 30°）不得喷火');
  // ③ 两轴都对 → 喷
  const ok = agent.update(fireState(), 0.016, ctx);
  assertTrue(ok.fireRequest !== null, '两轴都在锥内必须喷火');
});

test('俯冲: minFireDistance 内侧不喷（太近姿态追不上）', () => {
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  const D = DRAGON_AI.minFireDistance;
  const ctxIn = { ...switchableWorld({ blocked: false }), player: { position: [D - 1, 0, 0] } };
  const inside = agent.update(fireState({ yaw: FIRE_YAW, pitch: aimPitchFor(FIRE_DRAGON[1], D - 1) }, D - 1), 0.016, ctxIn);
  assertEqual(inside.fireRequest, null, `水平距 ${D - 1} < minFireDistance 不得喷火`);
  const ctxOut = { ...switchableWorld({ blocked: false }), player: { position: [D + 2, 0, 0] } };
  const outside = agent.update(fireState({ yaw: FIRE_YAW, pitch: aimPitchFor(FIRE_DRAGON[1], D + 2) }, D + 2), 0.016, ctxOut);
  assertTrue(outside.fireRequest !== null, `水平距 ${D + 2} ≥ minFireDistance 必须可以喷火`);
});

test('俯冲: 渲染交叉比对 —— Agent 的机头前向 == 渲染矩阵变换 local(0,0,−1)', () => {
  // ⚠️ 逻辑层用 `dragonForward`、渲染层用 `rotation.set(pitch, yaw, 0, 'YXZ')`。
  // 两套公式漂移的形态是「看到的龙低头 40°、火球按低头 20° 飞」—— 格数/单测全绿。
  // 本文件用同一套数学手算渲染矩阵作用在 (0,0,−1) 上的结果（与 `test-dragon-render.js`
  // 的 THREE 实装版互补：那边用真 three，这边不依赖 any lib）。
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  const ctx = { ...switchableWorld({ blocked: false }), player: { position: [30, 0, 0] } };
  const next = agent.update(fireState(), 0.016, ctx);
  assertTrue(next.fireRequest !== null, 'sanity：应当开火');
  const dir = next.fireRequest.direction;
  // three YXZ：R = Ry(yaw)·Rx(pitch)；作用在 (0,0,−1) ⇒ 与本仓前向同式
  const cp = Math.cos(next.pitch), sp = Math.sin(next.pitch);
  const cy = Math.cos(next.yaw), sy = Math.sin(next.yaw);
  const afterX = [0, -(-1) * sp, -1 * cp];   // Rx(pitch)·(0,0,−1)
  const rendered = [afterX[0] * cy + afterX[2] * sy, afterX[1], -afterX[0] * sy + afterX[2] * cy];
  for (let i = 0; i < 3; i++) {
    assertTrue(Math.abs(dir[i] - rendered[i]) < 1e-12,
      `方向[${i}]=${dir[i]} 与渲染矩阵结果 ${rendered[i]} 不一致（两套旋转公式漂移）`);
  }
});

test('俯冲: pitch 缺省（旧 state 无该字段）→ 行为与 v2.46 一致（不俯冲）', () => {
  // 零回归：v2.46 的 state 里没有 pitch/diveOffset。缺省必须等价于「平飞」。
  const agent = new DragonBossAgent({ poseAt: fakePoseAt });
  const st = makeState({ mode: 'chase', position: [0, ORBIT.y, 0], yaw: -Math.PI / 2 });
  delete st.pitch;
  delete st.diveOffset;
  // 玩家在 fireRange(60) 外 ⇒ 不在射程窗口 ⇒ 不俯冲
  const next = agent.update(st, 1 / 60, clearCtx([5000, 0, 0]));
  assertEqual(next.position[1], fakePoseAt(ORBIT, next.orbitT).position[1],
    '无 pitch/diveOffset 字段且射程外时 y 必须逐位等于 poseAt 的 y');
  assertEqual(next.pitch, 0, '缺 pitch 时必须平飞');
  assertEqual(next.diveOffset, 0, '缺 diveOffset 时俯冲位移必须为 0');
});
