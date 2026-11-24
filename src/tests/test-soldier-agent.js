// src/tests/test-soldier-agent.js — 士兵 Agent 状态机（Tier 1，TDD）
//
// 覆盖 spec §5.3：awareness 门、方案 B 的距离环、蹲起、点射节奏、search 降级、留尸。
// ⚠️ **距离环那条是 Review Focus 2**：它是「士兵不是会开枪的丧尸」的唯一判据。
// ⚠️ rng 一律注入定值，否则点射发数/间隔随机不可断言。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse } from './assert.js';
import { createRegistry } from '../voxel/block-registry.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';
import { playerHitboxLocal } from '../player/physics.js';
import {
  SOLDIER, SOLDIER_AI, SOLDIER_SHOT,
} from '../entities/soldiers/soldier-config.js';
import { SoldierAgent, createSoldierState } from '../entities/soldiers/soldier-agent.js';

/** 全空气 + y=0 地面的开阔世界（cx/cz 0..3，够 60 格视线） */
function makeWorld() {
  const registry = createRegistry();
  registry.register('air', { solid: false, opaque: false, cullMode: 'none' });
  registry.register('stone', { solid: true, opaque: true, cullMode: 'opaque' });
  registry.register('bedrock', { solid: true, opaque: true, cullMode: 'opaque' });
  registry.freeze();
  const world = new WorldData(registry);
  for (let cx = 0; cx <= 3; cx++) {
    for (let cz = 0; cz <= 3; cz++) {
      const col = new ChunkColumn(cx, cz);
      for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) col.set(lx, 0, lz, registry.idOf('stone'));
      world.add(col);
    }
  }
  return { world, registry };
}

/**
 * Agent 夹具。
 * @param {object} o position=士兵脚底 / player=玩家脚底 / mode / rand=定值 rng
 */
function makeAgentFixture({
  position = [8.5, 1, 8.5], player = [8.5, 1, 20.5], mode = 'patrol', rand = () => 0.5, ...rest
} = {}) {
  const { world, registry } = makeWorld();
  const agent = new SoldierAgent({ rng: rand });
  const state = createSoldierState({
    position, yaw: 0, mode, health: SOLDIER.health, ...rest,
  });
  const ctx = {
    world, registry,
    player: { position: player, aabb: playerHitboxLocal(), speed: 0, grounded: true },
    nowMs: 1000, bursting: 0, lastKnown: null, lastSeenAny: -1e9, advancerId: null,
  };
  return { agent, state, ctx, world, registry };
}

/** 连跑 n 拍（每拍推进 nowMs，否则窗口铺不满 —— 丧尸行为层已记的教训） */
function run(agent, state, ctx, seconds, dt = SOLDIER_AI.aiPeriod) {
  let s = state;
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    ctx.nowMs += dt * 1000;
    s = agent.update(s, dt, ctx);
  }
  return s;
}

test('士兵 Agent: awareness 累积到 1 才进 combat（不是一看见就打）', () => {
  // 距 12 格 ⇒ 1.7/s ⇒ 约 0.59s 到 1。yaw=0 朝 +Z，玩家在 +Z ⇒ 在视锥内
  const f = makeAgentFixture({ position: [8.5, 1, 8.5], player: [8.5, 1, 20.5] });
  const early = run(f.agent, f.state, f.ctx, 0.3);
  assertEqual(early.mode, 'patrol', '0.3s 时不该已开打');
  assertTrue(early.awareness > 0 && early.awareness < 1, `awareness 须在累积中，实测 ${early.awareness}`);
  const late = run(f.agent, f.state, f.ctx, 1.0);
  assertEqual(late.mode, 'combat', '1s 后必须已进 combat');
});

test('士兵 Agent: 看不见玩家时 awareness 衰减而非累积', () => {
  const f = makeAgentFixture({ awareness: 0.8 });
  // 玩家挪到 100 格外（超出 sightRangePatrol 27）
  f.ctx.player.position = [8.5, 1, 120.5];
  const s = run(f.agent, f.state, f.ctx, 1.0);
  assertTrue(s.awareness < 0.8, `看不见须衰减，实测 ${s.awareness}`);
});

test('士兵 Agent: 距离环 —— 远于 20 推进 / 8~20 侧向 / 近于 8 后退（Review Focus 2）', () => {
  // ⚠️ **必须钉住站姿**（实测）：蹲下时移动意图恒为 0（上游 `speed = crouching ? 0 : 4.0`），
  // 而 rng=0.5 时首个 peekT 到期恰好落在「蹲」⇒ 不钉站姿时三个初态都读到零速度，
  // 判据变成在测「蹲着不动」而不是距离环。
  const stance = { crouching: false, crouch: 0, peekT: 99 };
  // 三个初态：士兵在原点附近，玩家沿 +Z 放在 30 / 14 / 4 格处
  const radial = (s, playerPos) => {
    const dx = playerPos[0] - s.position[0];
    const dz = playerPos[2] - s.position[2];
    const d = Math.hypot(dx, dz) || 1;
    return (s.velocity[0] * dx + s.velocity[2] * dz) / d;
  };
  const far = makeAgentFixture({ position: [8.5, 1, 8.5], player: [8.5, 1, 38.5], mode: 'combat', awareness: 1, ...stance });
  const farS = run(far.agent, far.state, far.ctx, 0.2);
  assertTrue(radial(farS, far.ctx.player.position) > 0.5,
    `远于上界须推进（径向为正），实测 ${radial(farS, far.ctx.player.position)}`);

  const mid = makeAgentFixture({ position: [8.5, 1, 8.5], player: [8.5, 1, 22.5], mode: 'combat', awareness: 1, ...stance });
  const midS = run(mid.agent, mid.state, mid.ctx, 0.2);
  const midRad = radial(midS, mid.ctx.player.position);
  assertTrue(Math.abs(midRad) < 0.5, `环内径向分量须近 0（纯侧向），实测 ${midRad}`);
  assertTrue(Math.hypot(midS.velocity[0], midS.velocity[2]) > 0.5, '环内必须有侧向移动，不是站死');

  const near = makeAgentFixture({ position: [8.5, 1, 8.5], player: [8.5, 1, 12.5], mode: 'combat', awareness: 1, ...stance });
  const nearS = run(near.agent, near.state, near.ctx, 0.2);
  assertTrue(radial(nearS, near.ctx.player.position) < -0.5,
    `近于下界须后退（径向为负），实测 ${radial(nearS, near.ctx.player.position)}`);
});

test('士兵 Agent: 蹲下时移动意图为 0', () => {
  const f = makeAgentFixture({
    position: [8.5, 1, 8.5], player: [8.5, 1, 22.5], mode: 'combat', awareness: 1,
    crouching: true, crouch: 1, peekT: 99,
  });
  const s = run(f.agent, f.state, f.ctx, 0.2);
  assertEqual(s.velocity[0], 0, '蹲下不得水平移动');
  assertEqual(s.velocity[2], 0);
});

test('士兵 Agent: peekT 到期切换蹲/站（30s 内两态都出现）', () => {
  const f = makeAgentFixture({ position: [8.5, 1, 8.5], player: [8.5, 1, 22.5], mode: 'combat', awareness: 1 });
  let s = f.state;
  let sawCrouch = false, sawStand = false;
  for (let i = 0; i < 600; i++) {
    f.ctx.nowMs += SOLDIER_AI.aiPeriod * 1000;
    s = f.agent.update(s, SOLDIER_AI.aiPeriod, f.ctx);
    if (s.crouch > 0.9) sawCrouch = true;
    if (s.crouch < 0.1) sawStand = true;
  }
  assertTrue(sawCrouch, '30s 内必须蹲过');
  assertTrue(sawStand, '30s 内必须站过');
});

test('士兵 Agent: 点射发数 3~6、结束后 nextBurst 落在有视线区间', () => {
  // rand=0.5 ⇒ floor(3 + 0.5*3) = 4 发
  const f = makeAgentFixture({
    position: [8.5, 1, 8.5], player: [8.5, 1, 22.5], mode: 'combat', awareness: 1,
    nextBurst: 0, reaction: 0,
  });
  let s = f.state;
  let shots = 0;
  for (let i = 0; i < 120; i++) {
    f.ctx.nowMs += SOLDIER_AI.aiPeriod * 1000;
    s = f.agent.update(s, SOLDIER_AI.aiPeriod, f.ctx);
    if (s.shotRequest) shots++;
    if (shots > 0 && s.burst === 0) break;
  }
  assertTrue(shots >= SOLDIER_SHOT.burstMin && shots <= SOLDIER_SHOT.burstMax,
    `一轮点射须 3~6 发，实测 ${shots}`);
  assertTrue(s.nextBurst >= SOLDIER_SHOT.burstGapLosMin && s.nextBurst <= SOLDIER_SHOT.burstGapLosMax,
    `有视线时轮间隔须 ∈ [0.8,1.7]，实测 ${s.nextBurst}`);
});

test('士兵 Agent: 并发名额已满时不开火（maxConcurrentBursts 闸门）', () => {
  const f = makeAgentFixture({
    position: [8.5, 1, 8.5], player: [8.5, 1, 22.5], mode: 'combat', awareness: 1,
    nextBurst: 0, reaction: 0,
  });
  f.ctx.bursting = SOLDIER_SHOT.maxConcurrentBursts;   // 名额满
  const s = run(f.agent, f.state, f.ctx, 0.5);
  assertEqual(s.burst, 0, '名额满时不得起新一轮');
});

test('士兵 Agent: 12s 无视线转 search、再 7s 回 patrol', () => {
  const f = makeAgentFixture({
    position: [8.5, 1, 8.5], player: [8.5, 1, 22.5], mode: 'combat', awareness: 1,
  });
  f.ctx.lastKnown = [8.5, 1, 22.5];
  f.ctx.lastSeenAny = f.ctx.nowMs;
  // 玩家消失到视野外
  f.ctx.player.position = [8.5, 1, 200.5];
  let s = f.state;
  for (let i = 0; i < 300; i++) {   // 15s
    f.ctx.nowMs += SOLDIER_AI.aiPeriod * 1000;
    s = f.agent.update(s, SOLDIER_AI.aiPeriod, f.ctx);
  }
  assertEqual(s.mode, 'search', '12s 没看见须转 search');
  for (let i = 0; i < 200; i++) {   // 再 10s
    f.ctx.nowMs += SOLDIER_AI.aiPeriod * 1000;
    s = f.agent.update(s, SOLDIER_AI.aiPeriod, f.ctx);
  }
  assertEqual(s.mode, 'patrol', 'search 7s 后须回 patrol');
});

test('士兵 Agent: 死亡后不移动不开火（deadT 由 Service 推，不在 Agent）', () => {
  const f = makeAgentFixture({
    position: [8.5, 1, 8.5], player: [8.5, 1, 22.5], mode: 'combat', awareness: 1,
    dead: true, deadT: 0, health: 0,
  });
  const s = run(f.agent, f.state, f.ctx, 0.5);
  assertEqual(s.shotRequest, null, '尸体不得开火');
  assertEqual(s.velocity[0], 0, '尸体不得水平移动');
  assertEqual(s.velocity[2], 0);
  // ⚠️ deadT 不在 Agent 累加：留尸计时归 Service.update（两处都推会双倍）。
  assertEqual(s.deadT, 0, 'Agent 不得推进 deadT');
});

test('士兵 Agent: 跨帧量不丢 —— awareness/burst/peekT 逐拍演进而非每帧重置', () => {
  // ⚠️ 这条专抓 createState 漏字段：漏了会让每个机制每帧重置而数值看着全对
  const f = makeAgentFixture({ position: [8.5, 1, 8.5], player: [8.5, 1, 20.5] });
  let s = f.state;
  const seen = [];
  for (let i = 0; i < 10; i++) {
    f.ctx.nowMs += SOLDIER_AI.aiPeriod * 1000;
    s = f.agent.update(s, SOLDIER_AI.aiPeriod, f.ctx);
    seen.push(s.awareness);
  }
  for (let i = 1; i < seen.length; i++) {
    assertTrue(seen[i] > seen[i - 1],
      `awareness 须逐拍累积（第 ${i} 拍 ${seen[i]} 应 > ${seen[i - 1]}）—— 相等即为每帧重置`);
  }
});

test('士兵 Agent: 返回全新对象与全新数组（M5 索引迁移不变式）', () => {
  const f = makeAgentFixture();
  const before = f.state;
  const after = f.agent.update(before, SOLDIER_AI.aiPeriod, f.ctx);
  assertFalse(after === before, '不得返回同一对象');
  assertFalse(after.position === before.position, 'position 必须是新数组');
  assertFalse(after.velocity === before.velocity, 'velocity 必须是新数组');
});

test('士兵 Agent: yaw 朝玩家转（combat 态瞄准，不是背对）', () => {
  // 玩家在 +X 侧 ⇒ 前向 (sin yaw, cos yaw) 要指向 +X ⇒ yaw → π/2
  const f = makeAgentFixture({
    position: [8.5, 1, 8.5], player: [22.5, 1, 8.5], mode: 'combat', awareness: 1, yaw: 0,
  });
  const s = run(f.agent, f.state, f.ctx, 1.5);
  assertTrue(s.yaw > 1.0, `yaw 须转向 +X（≈π/2），实测 ${s.yaw}`);
});