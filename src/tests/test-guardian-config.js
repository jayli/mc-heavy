// src/tests/test-guardian-config.js — 末影守卫玩法数值冻结表（Tier 1，TDD）
//
// 覆盖：spec §5 的冻结数值逐条钉住 + 载荷性不变式（改任一个都会静默失效）。
// 数值来源：`Ender_Guardian_Entity.java` 的属性表 + `ModelEnder_Guardian.java` 的关键帧实测。
//
// ⚠️ 本文件只测**常量表**，不碰 service/渲染器（那些在 Task 5/6/8 各自的用例里）。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import {
  GUARDIAN_TYPE, GUARDIAN, GUARDIAN_AI, GUARDIAN_ATTACKS, GUARDIAN_ATTACK_IDS,
  GUARDIAN_STEERING, GUARDIAN_CORE_OBB, GUARDIAN_STEP_LIFT, GUARDIAN_POSE_BLEND,
  guardianEntityIdFor, guardianBlendSeconds,
} from '../entities/guardian/guardian-config.js';

test('守卫: GUARDIAN_TYPE 是稳定的字符串常量', () => {
  assertEqual(GUARDIAN_TYPE, 'guardian', 'type 常量');
});

test('守卫: 体形与伤害取自原版（血量按用户裁定 2000）', () => {
  assertEqual(GUARDIAN.health, 2000, '血量 = 用户裁定 2000');
  assertEqual(GUARDIAN.attackDamage, 16, '伤害 = 原版 ATTACK_DAMAGE');
  assertEqual(GUARDIAN.halfWidth, 1.25, '半宽 = 原版 sized(2.5)/2');
  assertEqual(GUARDIAN.height, 3.8, '高 = 原版 sized(3.8)');
  assertEqual(GUARDIAN.maxAlive, 1, '废弃堡垒只有一个');
  assertEqual(GUARDIAN.flashMs, 200, '红闪时长与焰魔/丧尸同口径');
});

test('守卫: 四档招式的锥角逐招钉住（踩踏刻意 180 全向）', () => {
  assertEqual(GUARDIAN_ATTACKS.strong_right.hitConeDeg, 35, '右重击半角 35 = 原版 arc 70 的一半');
  assertEqual(GUARDIAN_ATTACKS.strong_left.hitConeDeg, 35, '左重击半角 35');
  assertEqual(GUARDIAN_ATTACKS.uppercut.hitConeDeg, 30, '上勾拳半角 30 = 原版 arc 60 的一半');
  assertEqual(GUARDIAN_ATTACKS.stomp.hitConeDeg, 180, '踩踏刻意全向 180（原版是尖牙，改环形近战）');
});

test('守卫: 四档招式的射程与命中帧（原版 AreaAttack + tick 实测）', () => {
  assertEqual(GUARDIAN_ATTACKS.strong_right.hitRange, 5.15, '右重击射程 = 原版 AreaAttack range');
  assertEqual(GUARDIAN_ATTACKS.strong_left.hitRange, 5.15, '左重击射程');
  assertEqual(GUARDIAN_ATTACKS.uppercut.hitRange, 6.25, '上勾拳射程');
  assertEqual(GUARDIAN_ATTACKS.stomp.hitRange, 4.5, '踩踏射程 = 原版尖牙最外圈半径');
  assertEqual(GUARDIAN_ATTACKS.strong_right.hitFrameSeconds, 29 / 20, '右重击命中帧 tick29');
  assertEqual(GUARDIAN_ATTACKS.strong_left.hitFrameSeconds, 34 / 20, '左重击命中帧 tick34');
  assertEqual(GUARDIAN_ATTACKS.uppercut.hitFrameSeconds, 27 / 20, '上勾拳命中帧 tick27');
  assertEqual(GUARDIAN_ATTACKS.stomp.hitFrameSeconds, 32 / 20, '踩踏命中帧 tick32');
  assertEqual(GUARDIAN_ATTACKS.strong_right.animSeconds, 3.0, '右重击 60 tick');
  assertEqual(GUARDIAN_ATTACKS.strong_left.animSeconds, 3.0, '左重击 60 tick');
  assertEqual(GUARDIAN_ATTACKS.uppercut.animSeconds, 4.5, '上勾拳 90 tick（不是声明的 100）');
  assertEqual(GUARDIAN_ATTACKS.stomp.animSeconds, 2.4, '踩踏 48 tick');
});

test('守卫: 每招命中帧都落在本招动画内（否则那一招永不结算）', () => {
  for (const id of GUARDIAN_ATTACK_IDS) {
    const a = GUARDIAN_ATTACKS[id];
    assertTrue(a.hitFrameSeconds > 0 && a.hitFrameSeconds < a.animSeconds,
      `${id} 的命中帧 ${a.hitFrameSeconds} 必须 ∈ (0, ${a.animSeconds})`);
  }
});

test('守卫: 四档权重之和 = 1 且逐档钉住', () => {
  const wSum = GUARDIAN_ATTACK_IDS.reduce((s, id) => s + GUARDIAN_ATTACKS[id].weight, 0);
  assertTrue(Math.abs(wSum - 1) < 1e-9, `四档权重之和 = 1，实际 ${wSum}`);
  assertEqual(GUARDIAN_ATTACKS.strong_right.weight, 0.30, '右重击权重');
  assertEqual(GUARDIAN_ATTACKS.strong_left.weight, 0.30, '左重击权重');
  assertEqual(GUARDIAN_ATTACKS.uppercut.weight, 0.25, '上勾拳权重');
  assertEqual(GUARDIAN_ATTACKS.stomp.weight, 0.15, '踩踏权重（全向惩罚招，取最低）');
  assertEqual(GUARDIAN_ATTACK_IDS.length, 4, '恰好四档');
  assertEqual(JSON.stringify(GUARDIAN_ATTACK_IDS),
    JSON.stringify(['strong_right', 'strong_left', 'uppercut', 'stomp']), '抽签顺序');
});

test('守卫: 每招独立冷却的两条约束（0 = 无额外冷却）', () => {
  for (const id of GUARDIAN_ATTACK_IDS) {
    const a = GUARDIAN_ATTACKS[id];
    if (a.cooldownSeconds === 0) continue;
    assertTrue(a.cooldownSeconds > a.animSeconds,
      `${id} 的独立冷却必须 > 本招动画时长，否则被动画吃掉（数值上不起作用）`);
    assertTrue(a.cooldownSeconds >= GUARDIAN_AI.attackCooldownMin,
      `${id} 的独立冷却必须 ≥ attackCooldownMin，否则比普攻还频繁`);
  }
  assertEqual(GUARDIAN_ATTACKS.strong_right.cooldownSeconds, 0, '右重击无额外冷却');
  assertEqual(GUARDIAN_ATTACKS.strong_left.cooldownSeconds, 0, '左重击无额外冷却');
  assertEqual(GUARDIAN_ATTACKS.uppercut.cooldownSeconds, 9.0, '上勾拳独立冷却');
  assertEqual(GUARDIAN_ATTACKS.stomp.cooldownSeconds, 12.0, '踩踏独立冷却');
});

test('守卫: GUARDIAN_AI 的三个派生值是各招最大者', () => {
  assertEqual(GUARDIAN_AI.attackAnimSeconds, 4.5, 'attackAnimSeconds = 最长的上勾拳');
  assertEqual(GUARDIAN_AI.hitRange, 6.25, 'hitRange = 最远的上勾拳');
  assertEqual(GUARDIAN_AI.hitConeDeg, 180, 'hitConeDeg = 最宽的踩踏');
  assertEqual(GUARDIAN_AI.hitFrameSeconds, 1.70, 'hitFrameSeconds = 最晚的左重击');
});

test('守卫: 冷却下限 > 最长动画（否则无间隔连招）', () => {
  assertTrue(GUARDIAN_AI.attackCooldownMin > GUARDIAN_AI.attackAnimSeconds,
    '冷却下限必须 > 最长动画，否则冷却被动画吃掉');
  assertEqual(GUARDIAN_AI.attackCooldownMin, 5.0, '冷却下限');
  assertEqual(GUARDIAN_AI.attackCooldownMax, 7.5, '冷却上限');
  assertTrue(GUARDIAN_AI.attackCooldownMax > GUARDIAN_AI.attackCooldownMin, '上限 > 下限');
});

test('守卫: 站定环必须按**最小** hitRange 定（照抄焰魔会让踩踏永远打不中）', () => {
  assertEqual(GUARDIAN_AI.standoffRange, 3.5, '站定环半径');
  assertEqual(GUARDIAN_AI.standoffDeadband, 0.75, '死区半宽');
  assertEqual(GUARDIAN_AI.attackRange, 4.25, '起手距离');
  assertTrue(GUARDIAN_AI.attackRange >= GUARDIAN_AI.standoffRange,
    'attackRange ≥ standoffRange，否则追到环上既不走也不起手（僵住）');
  assertTrue(GUARDIAN_AI.standoffRange <= GUARDIAN_AI.hitRange, '站定环落在能够到的范围内');
  // ⚠️ 上面那条读的是派生**最大值**（6.25），抓不到「停在 5.0 格出踩踏(4.5) 打不中」。
  const minHit = Math.min(...GUARDIAN_ATTACK_IDS.map((id) => GUARDIAN_ATTACKS[id].hitRange));
  assertEqual(minHit, 4.5, '最短的一招是踩踏 4.5');
  assertTrue(GUARDIAN_AI.attackRange < minHit,
    `attackRange 必须 < 最小 hitRange（滞回）；实际 ${GUARDIAN_AI.attackRange} vs ${minHit}`);
  assertTrue(GUARDIAN_AI.standoffRange + GUARDIAN_AI.chaseSpeed / 60 <= GUARDIAN_AI.attackRange,
    '追到环上的落点（最多多一步）必须仍在起手距离内，否则僵住');
});

test('守卫: 死区下界 > 身体盒半宽 + 玩家半宽（玩家碰得到它）', () => {
  assertTrue(GUARDIAN_AI.standoffRange - GUARDIAN_AI.standoffDeadband > GUARDIAN.halfWidth + 0.3,
    '死区下界必须 > 身体盒半宽 + 玩家半宽');
  assertTrue(GUARDIAN_AI.standoffDeadband > GUARDIAN_AI.chaseSpeed / 60,
    '死区 > 单帧位移，否则环边界振荡');
});

test('守卫: 发现/脱离距离滞回', () => {
  assertEqual(GUARDIAN_AI.sightRange, 50, '发现距离 = 原版 FOLLOW_RANGE');
  assertEqual(GUARDIAN_AI.disengageRange, 60, '脱离距离');
  assertTrue(GUARDIAN_AI.disengageRange > GUARDIAN_AI.sightRange, '脱离 > 发现（滞回）');
});

test('守卫: 追击速度取原版 0.27×20（实玩后可调的唯一常量）', () => {
  assertEqual(GUARDIAN_AI.chaseSpeed, 5.4, 'chaseSpeed = 原版 MOVEMENT_SPEED 0.27 × 20');
});

test('守卫: maxStep 取 1.0（1.75 在现有实现下是死值）', () => {
  assertEqual(GUARDIAN_AI.maxStep, 1.0,
    'maxStep 取 1.0：现有 zombieStepUpY 只能抬 1 格，写 1.75 是看着生效实际无效的死值');
});

test('守卫: 脱困强化跳的两条不变式', () => {
  assertTrue(GUARDIAN_AI.escapeLeapApexMin > GUARDIAN_AI.leapJumpForce ** 2 / (2 * 24),
    '强化跳顶点必须严格 > 普通跳顶点，否则「跳更高」静默失效');
  assertTrue(2 * Math.sqrt(2 * GUARDIAN_AI.escapeLeapApexMax / 24) < GUARDIAN_AI.leapMaxSeconds,
    '强化跳滞空必须显著 < 安全阀，否则那一跳白跳');
  assertEqual(GUARDIAN_AI.escapeLeapEscalateAfter, 3, '前 3 次普通跳，第 4 次升级');
  assertEqual(GUARDIAN_AI.escapeLeapApexMin, 4, '强化跳顶点下限');
  assertEqual(GUARDIAN_AI.escapeLeapApexMax, 8, '强化跳顶点上限');
});

test('守卫: 重叠自愈阈按**旋转后**核心盒最大半宽算（不是碰撞盒半宽）', () => {
  // 实测：halfExtents [1.25, ·, 1.0313] 绕 yaw 扫全圈的最大轴对齐半宽 = 1.6205
  assertTrue(GUARDIAN_AI.overlapEscapeDist >= 1.6205 + 0.3,
    '重叠阈 ≥ 旋转后身体盒最大水平半宽 + 玩家半宽');
  assertEqual(GUARDIAN_AI.overlapEscapeDist, 1.95, '重叠自愈距离');
});

test('守卫: 核心 OBB 是烘焙产物 bind pose 的实测值', () => {
  assertEqual(JSON.stringify(GUARDIAN_CORE_OBB.halfExtents),
    JSON.stringify([1.25, 1.2188, 1.0313]), '核心盒半长（x/y/z）');
  assertEqual(JSON.stringify(GUARDIAN_CORE_OBB.center),
    JSON.stringify([0, 2.7181, -0.4062]), '核心盒中心（相对脚底）');
  const lo = GUARDIAN_CORE_OBB.center[1] - GUARDIAN_CORE_OBB.halfExtents[1];
  const hi = GUARDIAN_CORE_OBB.center[1] + GUARDIAN_CORE_OBB.halfExtents[1];
  assertTrue(lo >= 0, `核心盒底 ${lo} 不得入地`);
  // ⚠️ 盒顶实测 **3.9368 > 碰撞盒高 3.8**：头盔 + 动画下沉共同造成，属素材真实几何。
  // 上界取 4.0（= height + 0.2）：容得下真实值，又能拦住「盒高翻倍/中心写错一个量级」。
  assertTrue(hi <= GUARDIAN.height + 0.2,
    `核心盒顶 ${hi} 不得明显超出碰撞盒高 ${GUARDIAN.height}`);
  // 盒高与半长自洽（防 center 与 halfExtents 不同源）
  assertEqual(Math.round((hi - lo) * 1e4) / 1e4,
    Math.round(GUARDIAN_CORE_OBB.halfExtents[1] * 2 * 1e4) / 1e4, '盒高 = 2 × halfY');
});

test('守卫: 姿态淡入必须在**最短**命中帧之前走完', () => {
  const minHitFrame = Math.min(...GUARDIAN_ATTACK_IDS.map((id) => GUARDIAN_ATTACKS[id].hitFrameSeconds));
  assertEqual(minHitFrame, 1.35, '最短命中帧 = 上勾拳 27 tick');
  for (const key of ['idle', ...GUARDIAN_ATTACK_IDS]) {
    assertTrue(guardianBlendSeconds(key) < minHitFrame,
      `${key} 的淡入时长必须 < 最短命中帧 ${minHitFrame}s`);
  }
  assertEqual(GUARDIAN_POSE_BLEND.seconds, 0.2, '默认淡入 0.2s（四招均用，无特例）');
});

test('守卫: 台阶缓动噪声门与丧尸/焰魔同值', () => {
  assertEqual(GUARDIAN_STEP_LIFT.epsilon, 1e-4, '台阶缓动噪声门');
});

test('守卫: 偏角档位必须与丧尸同值（否则两个地面实体绕同一堵墙走出不同路径）', () => {
  assertEqual(GUARDIAN_STEERING.probeDistance, 1.2, '探针距离');
  assertEqual(JSON.stringify(GUARDIAN_STEERING.anglesDeg),
    JSON.stringify([22.5, 45, 67.5, 90]), '偏角档位');
});

test('守卫: 实体 id 由 (mapKey, slot) 派生且幂等', () => {
  assertEqual(guardianEntityIdFor('ruinedcitadel:0', 0), guardianEntityIdFor('ruinedcitadel:0', 0),
    '同图同槽恒同 id（走远卸载→回来重召不攒第二条）');
  assertTrue(guardianEntityIdFor('ruinedcitadel:0', 0) !== guardianEntityIdFor('ruinedcitadel:1', 0),
    '不同图 id 不同');
  assertTrue(guardianEntityIdFor('ruinedcitadel:0', 0) !== guardianEntityIdFor('ruinedcitadel:0', 1),
    '不同槽 id 不同');
  assertTrue(guardianEntityIdFor('ruinedcitadel:0', 0).startsWith('guardian:'), 'id 带 type 前缀');
});

test('守卫: 感知间隔落在用户裁定的 [1, 2] 秒区间', () => {
  assertTrue(GUARDIAN_AI.senseIntervalMin >= 1 && GUARDIAN_AI.senseIntervalMax <= 2,
    '感知间隔 ∈ [1, 2] 秒');
  assertTrue(GUARDIAN_AI.senseIntervalMax > GUARDIAN_AI.senseIntervalMin, '上限 > 下限');
});

test('守卫: 常量表递归冻结（防运行期被改写）', () => {
  assertTrue(Object.isFrozen(GUARDIAN), 'GUARDIAN 冻结');
  assertTrue(Object.isFrozen(GUARDIAN_AI), 'GUARDIAN_AI 冻结');
  assertTrue(Object.isFrozen(GUARDIAN_ATTACKS), 'GUARDIAN_ATTACKS 冻结');
  assertTrue(Object.isFrozen(GUARDIAN_ATTACKS.stomp), '逐招也冻结');
  assertTrue(Object.isFrozen(GUARDIAN_CORE_OBB.halfExtents), 'OBB 数组冻结');
  assertTrue(Object.isFrozen(GUARDIAN_ATTACK_IDS), '招式清单冻结');
});