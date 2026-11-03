// src/tests/test-boss-agent.js — Boss 智能体抽象基类（v2.44）
//
// 覆盖：① update 是抽象方法（直接实例化调用必抛错）② _angleTo 与本仓 yaw→前向口径一致
// （AGENTS.md「出生朝向与相机旋转的测量口径」实测表：yaw 0=北(−Z)、π=南(+Z)、−π/2=东(+X)、
// π/2=西(−X)）③ _hDist 忽略 y ④ _hasLos 真的转调炮塔 LOS 唯一权威（hasLineOfSight）。
//
// 派生量一律从冻结常量算出而非硬编码字面量（testing-policy §2.5）。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { BossAgent } from '../entities/bosses/boss-agent.js';
import { DRAGON_AI } from '../entities/dragons/dragon-config.js';

/** 浮点近似断言（既有模式：assertTrue + Math.abs） */
function assertApprox(actual, expected, eps, msg) {
  assertTrue(Math.abs(actual - expected) < eps, `${msg}（实际 ${actual} ≠ 期望 ${expected}）`);
}

test('BossAgent: update 是抽象方法，直接调用必抛错', () => {
  const agent = new BossAgent();
  let threw = false;
  try {
    agent.update({}, 0.016, {});
  } catch (err) {
    threw = true;
    assertTrue(/抽象|abstract/i.test(err.message), `抛错信息须说明是抽象方法，实际=${err.message}`);
  }
  assertTrue(threw, 'BossAgent.update 未实现时必须抛错（子类契约）');
});

test('BossAgent: _angleTo 与本仓 yaw→前向口径一致（四基本方向）', () => {
  const agent = new BossAgent();
  const from = [0, 0, 0];
  // 本仓口径（AGENTS.md 实测表）：yaw 0 = 北(−Z)、π = 南(+Z)、−π/2 = 东(+X)、π/2 = 西(−X)
  //
  // ⚠️ **判据落在「前向向量」而不是「角度数值」**：`atan2(−0, −10)` 在 IEEE754 下返回
  // **−π** 而不是 π，两者是**同一朝向**（前向都是 (0,+1)）。直接断言角度数值会在南向
  // 假失败 —— 与 AGENTS.md 记的「Euler 等价表示」同类陷阱。
  // 前向向量口径还**更有判别力**：它能抓到「角度差 180° 但前后恰好对调」。
  const cases = [
    { to: [0, 0, -10], fwd: [0, -1], name: '北(−Z)' },
    { to: [0, 0, 10], fwd: [0, 1], name: '南(+Z)' },
    { to: [10, 0, 0], fwd: [1, 0], name: '东(+X)' },
    { to: [-10, 0, 0], fwd: [-1, 0], name: '西(−X)' },
    // 斜向：确保不是只对了四个轴
    { to: [10, 0, -10], fwd: [Math.SQRT1_2, -Math.SQRT1_2], name: '东北' },
  ];
  for (const c of cases) {
    const yaw = agent._angleTo(from, c.to);
    // yaw → 前向 = (−sin yaw, −cos yaw)
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    assertApprox(fx, c.fwd[0], 1e-9, `${c.name} 前向 x`);
    assertApprox(fz, c.fwd[1], 1e-9, `${c.name} 前向 z`);
  }
  // 数值层也钉一道（用最短角差判等价，避开 ±π 的表示差异）
  assertApprox(agent._angleDiff(agent._angleTo(from, [0, 0, -10]), 0), 0, 1e-12, '北 = yaw 0');
  assertApprox(agent._angleDiff(agent._angleTo(from, [0, 0, 10]), Math.PI), 0, 1e-12, '南 = yaw ±π');
});

test('BossAgent: _angleTo 忽略 y（水平指向角）', () => {
  const agent = new BossAgent();
  // 同一水平方向、不同高度 → 指向角相同
  assertApprox(agent._angleTo([0, 0, 0], [10, 0, 0]), agent._angleTo([0, 0, 0], [10, 50, 0]), 1e-12,
    'y 差 50 格不得改变水平指向角');
});

test('BossAgent: _hDist 是水平距离（忽略 y）', () => {
  const agent = new BossAgent();
  assertApprox(agent._hDist([0, 0, 0], [3, 999, 4]), 5, 1e-12, '3-4-5：y=999 不得计入');
  assertApprox(agent._hDist([1, 2, 3], [1, 50, 3]), 0, 1e-12, '同一水平位置 → 0');
});

test('BossAgent: _hasLos 转调炮塔 LOS 唯一权威（hasLineOfSight）', () => {
  const agent = new BossAgent();
  // 假 world：记录 getBlockId 被调用（证明真的走了 LOS 采样，而不是恒真）
  const calls = [];
  const world = { getBlockId: (x, y, z) => { calls.push([x, y, z]); return 0; } };
  const registry = { solidTable: new Uint8Array(256), opaqueTable: new Uint8Array(256) };
  const visible = agent._hasLos({ world, registry }, [0, 30, 0], [20, 2, 0]);
  assertTrue(visible, '全空气路径必须视线通');
  assertTrue(calls.length > 0, '_hasLos 必须真的采样方块（转调 hasLineOfSight），不能恒真');
});

test('BossAgent: _hasLos 被实心不透明方块遮挡时返回 false', () => {
  const agent = new BossAgent();
  // id=1 设为 solid && opaque（isProjectileOccluding 口径）
  const solidTable = new Uint8Array(256); solidTable[1] = 1;
  const opaqueTable = new Uint8Array(256); opaqueTable[1] = 1;
  const registry = { solidTable, opaqueTable };
  const world = {
    getBlockId: (x, y, z) => (Math.floor(x) === 10 && Math.floor(z) === 0 ? 1 : 0),
  };
  const visible = agent._hasLos({ world, registry }, [0, 30, 0], [20, 30, 0]);
  assertEqual(visible, false, '路径中点的实心不透明方块必须挡住视线');
});

test('DRAGON_AI: 常量齐全且冻结（数值权威单一出处）', () => {
  // 只钉「键存在 + 合理区间」，具体数值以 dragon-config.js 为权威（不复制字面量）
  const keys = [
    'sightRange', 'chaseSpeed', 'attackRange', 'flyoverDistance', 'turnAroundDistance',
    'disengageDistance', 'fireConeDeg', 'fireCooldownMin', 'fireCooldownMax', 'fireRange',
    'turnRate', 'wobbleAmp', 'wobbleFreq', 'losInterval', 'playerAimOffsetY',
  ];
  for (const k of keys) {
    assertTrue(Number.isFinite(DRAGON_AI[k]), `DRAGON_AI.${k} 必须是有限数`);
  }
  assertTrue(DRAGON_AI.fireCooldownMin >= 5 && DRAGON_AI.fireCooldownMax <= 10,
    '开火间隔必须在用户要求的 5~10 秒区间内');
  assertTrue(DRAGON_AI.disengageDistance > DRAGON_AI.sightRange,
    '脱离距离必须大于发现距离（滞回，防边界抖动）');
  assertTrue(Object.isFrozen(DRAGON_AI), 'DRAGON_AI 必须冻结');
});
