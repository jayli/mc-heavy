// src/tests/test-ignis-system.js — 焰魔实体定义与 service（v2.55）
//
// 覆盖：create 的 state 校验与缺省补全、实体 id 派生、service 的召唤幂等/上限/死亡即消失、
// 以及配置里的**实测度量**（防手改漂移）。
//
// 命中盒（v2.59）：`position` 是脚底，核心盒必须是**相对脚底**的盒子 —— 守卫分四层：
// 字面量高度的射线扫描（行为）、与产物七骨骼 bind pose 包围盒的独立复算（精确，容差 1e-4）、
// 与渲染器真实蒙皮的粗对账（0.3 格）、yaw 旋转等变性（center 的 z 偏移随 yaw 转）。
//
// Tier 1（数据模型 + 状态机地基）⇒ 必须 TDD。
import * as THREE from 'three';
import { test } from './runner.js';
import { assertEqual, assertTrue, assertNull, assertNotNull, assertFalse } from './assert.js';
// config 与 system 分开 import（system 只 re-export 它需要的东西，不是全部）
import {
  IGNIS_TYPE, IGNIS, IGNIS_AI, IGNIS_ATTACKS, IGNIS_CORE_OBB, IGNIS_MODEL_CENTER, ignisEntityIdFor,
} from '../entities/ignis/ignis-config.js';
import { ignisDefinition, IgnisService, ignisAabbFor } from '../entities/ignis/ignis-system.js';
import { EntityManager } from '../entities/entity-manager.js';
// 命中盒 ↔ 画面的交叉用例要用真实渲染器 + 烘焙产物（`test-ignis-render.js` 同款装配）
import { IgnisRenderer } from '../render/ignis-renderer.js';
import { loadIgnisAsset } from '../render/ignis-model.js';

/** 造一个只含空气的世界（落点扫描会一路向下找到兜底） */
function emptyWorld() {
  return {
    isSolid: () => false,
    getBlockId: () => 0,
  };
}

/** 造一个「地表在 y=groundY」的世界（y <= groundY 实心） */
function flatWorld(groundY) {
  return {
    isSolid: (_x, y, _z) => y <= groundY,
    getBlockId: (_x, y, _z) => (y <= groundY ? 1 : 0),
  };
}

// ==================== config 契约 ====================

test('焰魔: IGNIS_TYPE 是稳定的字符串常量', () => {
  assertEqual(IGNIS_TYPE, 'ignis');
});

test('焰魔: 玩法数值取自原作者（Ignis_Entity.java 的 ignis() 属性表）', () => {
  // 这些不是「可调参数」，是素材作者的真实值 —— 改成别的值需要明确理由
  // ⚠️ health 是唯一例外：用户 2026-11-07 裁定「Boss 的血量改为 1000」（作者原值 450）
  assertEqual(IGNIS.health, 1000);         // MAX_HEALTH → 用户裁定 1000
  assertEqual(IGNIS.attackDamage, 14);     // ATTACK_DAMAGE
  assertEqual(IGNIS_AI.sightRange, 50);    // FOLLOW_RANGE
  // ⚠️ v2.62/v2.63 用户两次裁定减速（作者原值 6.6 = MOVEMENT_SPEED 0.33 格/tick × 20）：
  // v2.62「降低三分之一」⇒ 4.4；v2.63「再减少三分之一」⇒ 4.4 × 2/3 = 2.93
  assertEqual(IGNIS_AI.chaseSpeed, 2.93);
});

test('焰魔: createState 保留全部行为新字段（同 _physAccum 的载荷性）', () => {
  // ⚠️ 这些字段是跨帧累积量，若 createState 重建时丢掉，行为会静默失效
  //（同 `_physAccum` 被清零 ⇒ onGround 恒假 的既有教训）。
  // v2.63 新增 `stuckAnchor` / `sensedPlayer` / `senseTimer`：丢掉它们 ⇒ 脱困永不触发 /
  // 感知间隔失效（退化成每帧跟随，用户报告的问题原样复活）。
  const s = ignisDefinition.create({
    position: [0, 10, 0], acquireT: 1.2, stuckT: 3.4, leapKind: 'attack',
    leapDir: [1, 2], leapT: 0.5, leapTargetY: 9, leapAttackCooldown: 7,
    stuckAnchor: [3, 4], sensedPlayer: [5, 6, 7], senseTimer: 1.8,
    escapeFailCount: 2,
    leapAttackKind: 'shieldSmash',
  });
  assertEqual(s.acquireT, 1.2);
  assertEqual(s.stuckT, 3.4);
  assertEqual(s.leapKind, 'attack');
  assertEqual(s.leapDir[0], 1);
  assertEqual(s.leapT, 0.5);
  assertEqual(s.leapTargetY, 9);
  assertEqual(s.leapAttackCooldown, 7);
  assertEqual(s.stuckAnchor[0], 3);
  assertEqual(s.stuckAnchor[1], 4);
  assertEqual(s.sensedPlayer[0], 5);
  assertEqual(s.sensedPlayer[2], 7);
  assertEqual(s.senseTimer, 1.8);
  // v2.84：丢掉它 ⇒ 每帧重新计数 ⇒ 强化跳永不升级（与 `_physAccum` / `senseTimer` 同一教训）
  assertEqual(s.escapeFailCount, 2);
  // ⚠️⚠️ 丢掉它 ⇒ 起跳时抽定的招式每帧被抹掉 ⇒ 落地恒回落 swing。
  // 真实踩到过：单测直接调 agent.update 所以绿，E2E 走真实 service 就红
  //（createState 是**白名单式**重建，新字段必须在这里登记）。
  assertEqual(s.leapAttackKind, 'shieldSmash',
    'leapAttackKind 必须被 createState 保留 —— 丢掉它跳跃落地就恒播横扫');
});

test('焰魔: createState 对非法/缺失的 leapAttackKind 回落 null', () => {
  for (const bad of [undefined, null, 'nonsense', 42, {}]) {
    const s = ignisDefinition.create({ position: [0, 10, 0], leapKind: 'attack', leapAttackKind: bad });
    assertNull(s.leapAttackKind, `非法值 ${JSON.stringify(bad)} 应回落 null`);
  }
  // 非 attack 飞跃不得携带招式
  const esc = ignisDefinition.create({ position: [0, 10, 0], leapKind: 'escape', leapAttackKind: 'shieldSmash' });
  assertNull(esc.leapAttackKind, 'escape 飞跃不携带招式');
});

test('焰魔(v2.84): 脱困强化跳的常量区间（顶点下限 > 普通跳、上限在滞空安全阀内）', () => {
  // 用户 2026-11-08：「相差多高，就通过跳跃多高来脱困，只有数次普通脱困跳跃没有成功脱困的
  // 时候才进行高跳」。两项裁定（`ask_user_question`）：顶点 = clamp(max(Δy+1, 4), 4, 8)；前 3 次普通跳。
  assertEqual(IGNIS_AI.escapeLeapEscalateAfter, 3);
  assertEqual(IGNIS_AI.escapeLeapApexMin, 4);
  assertEqual(IGNIS_AI.escapeLeapApexMax, 8);
  assertEqual(IGNIS_AI.escapeLeapApexMargin, 1);
  assertEqual(IGNIS_AI.escapeLevelTolerance, 2);
  // ⚠️ **下限必须严格高于普通跳的顶点**：否则强化跳等于白跳（「跳更高」这条需求静默失效）
  const normalApex = IGNIS_AI.leapJumpForce ** 2 / (2 * Math.abs(IGNIS_AI.gravity));
  assertTrue(IGNIS_AI.escapeLeapApexMin > normalApex,
    `强化跳下限 ${IGNIS_AI.escapeLeapApexMin} 必须 > 普通跳顶点 ${normalApex.toFixed(2)}`);
  assertTrue(IGNIS_AI.escapeLeapApexMax > IGNIS_AI.escapeLeapApexMin, '上下限必须区分');
  // ⚠️ **上限由安全阀推出**：`leapMaxSeconds` 超时会强制回 chase（那一跳直接白跳）。
  // 滞空 = 2√(2H/|g|) 必须 < 安全阀，否则深坑一跳就被超时打断。
  const airtime = 2 * Math.sqrt(2 * IGNIS_AI.escapeLeapApexMax / Math.abs(IGNIS_AI.gravity));
  assertTrue(airtime < IGNIS_AI.leapMaxSeconds,
    `顶点 ${IGNIS_AI.escapeLeapApexMax} 的滞空 ${airtime.toFixed(2)}s 必须 < leapMaxSeconds(${IGNIS_AI.leapMaxSeconds})`);
});

test('焰魔: 感知间隔常量在用户裁定的 [1, 2] 秒区间内', () => {
  // 用户原文：「这个延迟做成一个 1 到 2 秒的时间间隔……间隔最快 1 秒检测玩家位置」
  assertEqual(IGNIS_AI.senseIntervalMin, 1.0);
  assertEqual(IGNIS_AI.senseIntervalMax, 2.0);
  assertTrue(IGNIS_AI.senseIntervalMin < IGNIS_AI.senseIntervalMax,
    '上下界相等会让 rng 失去意义（固定间隔）');
});

test('焰魔: 新常量数值不变式（改任一个都会静默失效）', () => {
  // ① 跳劈窗下界必须在原地起手距离外：否则两个起手机制在边界重叠抖动
  assertTrue(IGNIS_AI.leapAttackMin > IGNIS_AI.attackRange,
    `leapAttackMin(${IGNIS_AI.leapAttackMin}) 必须 > attackRange(${IGNIS_AI.attackRange})`);
  // ② 跳劈窗上界不得超出索敌范围（看不见的目标不跳）
  assertTrue(IGNIS_AI.leapAttackMax <= IGNIS_AI.sightRange,
    `leapAttackMax(${IGNIS_AI.leapAttackMax}) 必须 ≤ sightRange(${IGNIS_AI.sightRange})`);
  // ③ 跳劈落点（玩家外侧 standoff − deadband/2）必须落在挥砍能够到的范围内
  assertTrue(IGNIS_AI.standoffRange - IGNIS_AI.standoffDeadband / 2 < IGNIS_AI.hitRange,
    '跳劈落点必须在 hitRange 内，否则跳完砍不到');
});

test('焰魔: 近战判据取自 AreaAttack(6.5, 6, 70, ...)（arc 是总角度 ⇒ 半角 35）', () => {
  // ⚠️ v2.75 起 `IGNIS_AI` 的这两项是**两招的派生最大值**（旋斩的 155 比横扫的 35 大），
  // 单招判据的权威在 `IGNIS_ATTACKS`。扫描式的判据仍钉在这里，只是读的是本条档案。
  const swing = IGNIS_ATTACKS.swing;
  assertEqual(swing.hitRange, 6.5);
  assertEqual(swing.hitConeDeg, 35);
  // ⚠️ 若有人把 70 直接填进来（当成半角），扇面会翻倍到 140° —— 玩家绕到侧面也躲不掉
  assertTrue(swing.hitConeDeg < 70, 'swing.hitConeDeg 必须是半角，不是 arc 原值');
  // 派生值 = 两招最大者（旋斩的 155），这条不变式在 `旋斩档案` 用例里另有守卫
  assertEqual(IGNIS_AI.hitConeDeg, 155);
});

test('焰魔: 命中帧派生值 = 各招最大者（v3.01 持盾冲撞 tick 34 / 20 = 1.70 秒）', () => {
  // ⚠️ v3.01 从 1.20 重标：持盾冲撞的 tick 34 ÷ 20 = 1.70 是新的最大者。
  // **单招值没变**：横扫仍是 1.20（下面单独钉住）—— 变的只是「取最大」的结果。
  assertEqual(IGNIS_AI.hitFrameSeconds, 1.70);
  assertEqual(IGNIS_ATTACKS.swing.hitFrameSeconds, 1.20,
    '横扫自己的命中帧仍是 SWING_ATTACK 的 tick 24 / 20 = 1.20（派生值变了，单招值没变）');
  // 必须落在攻击动画时长之内，否则永远不会触发
  assertTrue(IGNIS_AI.hitFrameSeconds < IGNIS_AI.attackAnimSeconds,
    `命中帧 ${IGNIS_AI.hitFrameSeconds} 超出动画 ${IGNIS_AI.attackAnimSeconds}`);
});

// ==================== 第二招：整圈旋斩（v2.75）====================
//
// 数值全部取自 `Ignis_Entity.java` 的 `SPIN_ATTACK` 分支：
//   `AreaAttack(6.5f, 6, 310, 1.0f, ...)` + `getAnimationTick() == 14` + `Animation.create(38)`。
// 用户 2026-11-07 裁定：「照原版：同伤害 + 原版角度射程」。

test('焰魔(v2.75): 旋斩档案取自 AreaAttack(6.5, 6, 310, 1.0) —— arc 是总角 ⇒ 半角 155且必须 < 180', () => {
  const spin = IGNIS_ATTACKS.spin;
  assertEqual(spin.hitRange, 6.5);
  assertEqual(spin.hitConeDeg, 155);
  // ⚠️⚠️ **310° 不是 360°**：作者刻意留了 50° 的背向死角（唯一的安全位）。
  // 写成 180（或把 310 当半角填）会让「绕到背后」这个躲法直接消失，而在数据层看不出任何差别。
  assertTrue(spin.hitConeDeg < 180,
    `旋斩半角 ${spin.hitConeDeg}° 不得 ≥ 180° —— 那是全向，背向死角（作者刻意的 50°）会消失`);
  // 与横扫的守卫同口径：必须是半角，不是 arc 原值
  assertTrue(spin.hitConeDeg < 310, 'hitConeDeg 必须是半角 155，不是 arc 原值 310');
});

test('焰魔(v2.75): 旋斩命中帧 = SPIN_ATTACK 的 tick 14 / 20 = 0.70 秒，且落在动画内', () => {
  const spin = IGNIS_ATTACKS.spin;
  assertEqual(spin.hitFrameSeconds, 0.70);
  assertTrue(spin.hitFrameSeconds < spin.animSeconds,
    `命中帧 ${spin.hitFrameSeconds} 超出动画 ${spin.animSeconds}`);
  // 动画时长 = Java Animation.create(38) ⇒ 38/20
  assertEqual(spin.animSeconds, 1.9);
});

test('焰魔(v3.01): 三招档案的形状一致（缺字段的招式在命中帧会静默不触发）', () => {
  const KEYS = ['hitRange', 'hitConeDeg', 'hitFrameSeconds', 'animSeconds', 'weight'];
  assertEqual(Object.keys(IGNIS_ATTACKS).sort().join(','), 'shieldSmash,spin,swing');
  for (const [name, a] of Object.entries(IGNIS_ATTACKS)) {
    for (const k of KEYS) {
      assertTrue(Number.isFinite(a[k]), `${name}.${k} 不是有限数（缺字段 ⇒ 命中/时长判定会静默失效）`);
    }
    assertTrue(a.weight > 0 && a.weight < 1, `${name}.weight ${a.weight} 必须 ∈ (0,1)`);
  }
  // 权重和 = 1（抽签用 `<` 比较，不等于 1 会让剩下的概率落到哪个分支取决于实现细节）
  const sum = Object.values(IGNIS_ATTACKS).reduce((s, a) => s + a.weight, 0);
  assertTrue(Math.abs(sum - 1) < 1e-9, `权重和 ${sum} ≠ 1`);
  // 伤害只有一份权威（三招共用，用户裁定「同伤害」）
  assertEqual(IGNIS.attackDamage, 14);
});

// ==================== 第三招：持盾冲撞（v3.01）====================
//
// 数值全部取自 `Ignis_Entity.java` 的 `SHIELD_SMASH_ATTACK` 分支（第 884~897 行）：
//   `AreaAttack(4.85f, 2.5f, 45, 1.5f, 0.15f, …)` + `getAnimationTick() == 34` + `Animation.create(70)`。
// 用户 2026-11-13 五项裁定：只加这一招 / 贴身才抽 / 只扣血 / 冷却下限 4.0 / 起手音入库。
// ⚠️ **其中「贴身才抽」已被用户 2026-11-14 实玩后推翻**（「触发条件过于苛刻」）⇒
// 射程改成与另两招同值 6.5、贴身门删除、权重与横扫平分（各 0.35）。

test('焰魔(v3.01): 持盾冲撞档案 —— 射程与横扫同为 6.5（用户裁定：去掉贴身门），半角 22.5 且必须 < 45', () => {
  const a = IGNIS_ATTACKS.shieldSmash;
  // ⚠️ 用户 2026-11-14 实玩后裁定：「触发条件过于苛刻……改成和其他两个攻击技能一样的生效距离」
  // ⇒ 从原版 4.85 改成与横扫/旋斩同值 **6.5**（不再靠贴身门保证命中）。
  assertEqual(a.hitRange, 6.5);
  assertEqual(a.hitRange, IGNIS_ATTACKS.swing.hitRange,
    '持盾冲撞射程必须与横扫一致（用户裁定：砍的动作几格内生效，盾击就几格内生效）');
  assertEqual(a.hitConeDeg, 22.5);
  // ⚠️⚠️ **半角守卫**：写成 45 会让扇面变成 90°，而没有任何其他断言会红
  //（它只是「打得更宽」）。与横扫的 <70、旋斩的 <180 同口径。
  // ⚠️ 用户只要求改「生效距离」，**未要求改锥宽** ⇒ 22.5 半角保留。
  assertTrue(a.hitConeDeg < 45,
    `持盾冲撞半角 ${a.hitConeDeg}° 不得 ≥ 45° —— 那是把 arc 原值当半角填，扇面会静默变成 90°`);
});

test('焰魔(v3.01): 持盾冲撞命中帧 = tick 34 / 20 = 1.70 秒，时长 = 70 tick / 20 = 3.50 秒', () => {
  const a = IGNIS_ATTACKS.shieldSmash;
  assertEqual(a.hitFrameSeconds, 1.70);
  assertEqual(a.animSeconds, 3.5);
  assertTrue(a.hitFrameSeconds < a.animSeconds,
    `命中帧 ${a.hitFrameSeconds} 超出动画 ${a.animSeconds}`);
});

test('焰魔(v3.01): 贴身门已删除（用户裁定：不再限制 3 格）', () => {
  // 用户 2026-11-14：「不要限制在严格 3 格内，改成和其他两个攻击技能一样的生效距离」
  // ⇒ 常量本身必须不存在（留着就是第二份可能漂移的权威，红线 1）。
  assertEqual(IGNIS_AI.smashEngageRange, undefined,
    'smashEngageRange 必须删除 —— 贴身门已被用户裁定作废');
});

test('焰魔(v3.01): 持盾冲撞权重与横扫严格平分（用户裁定），旋斩不变，三档和 = 1', () => {
  const sw = IGNIS_ATTACKS.swing.weight;
  const sm = IGNIS_ATTACKS.shieldSmash.weight;
  const sp = IGNIS_ATTACKS.spin.weight;
  // 用户：「生效比例平分挥砍的动作的发生概率」⇒ swing 与持盾冲撞各拿原挥砍概率的一半
  assertEqual(sw, 0.35, '横扫权重 = 原 0.7 的一半');
  assertEqual(sm, 0.35, '持盾冲撞权重 = 原挥砍 0.7 的一半（与横扫平分）');
  assertEqual(sp, 0.30, '旋斩权重不动（用户未要求改它）');
  assertTrue(Math.abs(sw - sm) < 1e-12, `横扫 ${sw} 与持盾冲撞 ${sm} 必须严格相等（平分）`);
  const sum = sw + sm + sp;
  assertTrue(Math.abs(sum - 1) < 1e-9, `三档权重和 ${sum} ≠ 1`);
});

test('焰魔(v3.01): 持盾冲撞射程覆盖整个站定环（含外沿 5.0）—— 不再有盲区', () => {
  const r = IGNIS_ATTACKS.shieldSmash.hitRange;
  // 去掉贴身门后，持盾冲撞必须在玩家站环上任何位置都够得到（否则又会「抽中却落空」）。
  // 原版 4.85 < standoffRange 5.0 会在 [4.85, 5.0] 留一段盲区 ⇒ 改成 6.5 后盲区消失。
  assertTrue(r >= IGNIS_AI.standoffRange,
    `持盾冲撞射程 ${r} 必须 ≥ 站定环半径 ${IGNIS_AI.standoffRange}（否则环外沿仍是盲区）`);
  assertTrue(r >= IGNIS_AI.attackRange,
    `持盾冲撞射程 ${r} 必须 ≥ 起手距离 ${IGNIS_AI.attackRange}（否则起手了却够不到）`);
  assertEqual(r, IGNIS_ATTACKS.spin.hitRange, '三招射程同值');
});

test('焰魔(v2.75): IGNIS_AI 的四项是各招的派生最大值（既有断言/文档都引用它们）', () => {
  const max = (k) => Math.max(...Object.values(IGNIS_ATTACKS).map((a) => a[k]));
  assertEqual(IGNIS_AI.hitRange, max('hitRange'));
  assertEqual(IGNIS_AI.hitConeDeg, max('hitConeDeg'));
  // ⚠️ 命中帧与时长**取最大值**而不是取某一招的值：语义是「最迟那一刀落在何时」/「最长的一招多长」。
  // 冷却不变式 `attackCooldownMin > attackAnimSeconds` 就靠这个派生值保护。
  assertEqual(IGNIS_AI.hitFrameSeconds, max('hitFrameSeconds'));
  assertEqual(IGNIS_AI.attackAnimSeconds, max('animSeconds'));
});

test('焰魔(v2.75): 旋斩冷却独立于普攻冷却（否则权重会被普攻高频放大成「连着放」）', () => {
  assertTrue(Number.isFinite(IGNIS_AI.spinCooldownSeconds), '缺 spinCooldownSeconds');
  assertTrue(IGNIS_AI.spinCooldownSeconds > IGNIS_ATTACKS.spin.animSeconds,
    `spinCooldownSeconds(${IGNIS_AI.spinCooldownSeconds}) 必须 > 旋斩动画 ${IGNIS_ATTACKS.spin.animSeconds}`
    + '（同 attackCooldownMin 的教训：冷却短于动画会被动画吃掉，数值上不起作用）');
  // 与普攻命中间隔 [3.5, 6.0] 同量级：约两次普攻一次旋斩
  assertTrue(IGNIS_AI.spinCooldownSeconds >= IGNIS_AI.attackCooldownMin,
    '旋斩冷却不应短于普攻冷却下限（否则旋斩比普攻还频繁）');
});

test('焰魔: 碰撞盒取自 Bedrock collision_box（1.0 × 3.25）', () => {
  assertEqual(IGNIS.halfWidth, 0.5);
  assertEqual(IGNIS.height, 3.25);
});

test('焰魔: 脚底补偿量不在 config 里（唯一权威是烘焙产物的 metrics.feetOffsetY）', () => {
  // ⚠️ 这条是「红线 1」的守卫：脚底补偿量由烘焙器扫**全部动画帧**算出（v2.56 起），
  // 写在 config 里就是第二份权威 —— 素材/动画变了它不会跟着变，形态是模型重新陷进地里。
  assertEqual(IGNIS.modelFeetOffsetY, undefined, 'config 不该有 modelFeetOffsetY（权威在产物）');
});

// ==================== 命中盒度量：核心盒是「相对脚底」的盒子 ====================
//
// ⚠️ `state.position` 是**脚底**：`summon` 的落点是 `_findGroundY`（脚底 y），渲染器把「动画全程最低顶点」
// 摆在 `position.y`（`mesh.position.y = metrics.feetOffsetY`）。命中盒的 `center` 因此必须是**相对脚底**的
// 核心中心，不能是 `[0,0,0]` —— 那是 v2.56 之前「position = 身体核心中心」的旧语义。
// 用户 2026-11-05 实测的缺陷形态：射线只在脚底 −1.4 ~ +1.4 格内命中，**胸口以上（≥ 1.5 格）全打空**，
// 而模型有 3.83 格高、核心躯干在脚底 +0.05 ~ +2.97 格。

/** 「身体核心」七根骨骼（用户裁定只算躯干 + 头 + 上下身，不含剑 / 盾 / 手臂 / 角 / 护肩）。 */
const CORE_BONES = Object.freeze([
  'upperbody', 'head', 'lowerbody', 'lowerbody2', 'bodycore', 'right_chestplate', 'left_chestplate',
]);

/**
 * 从烘焙产物**独立复算**核心包围盒（模型空间，单位格；尚未扣 `feetOffsetY`）。
 *
 * 口径 = bind pose：骨骼层级逐级累乘 `T(localPosition)·R(bindQuaternion)` 得到世界矩阵，
 * 再变换该骨骼名下的顶点（与 `test-ignis-bake.js` 的 `bindPoseHeightBlocks` 同口径；那个未导出，
 * 故这里自带一份，且用 `Matrix4.compose` 而非手写 4×4 乘法 —— 两种独立实现得出同一组数才算复核过）。
 */
function coreBboxFromAsset(d) {
  const world = new Array(d.bones.length);
  d.bones.forEach((b, i) => {
    const local = new THREE.Matrix4().compose(
      new THREE.Vector3(...b.localPosition),
      new THREE.Quaternion(...b.bindQuaternion),
      new THREE.Vector3(1, 1, 1));
    world[i] = b.parentIndex === -1
      ? local
      : new THREE.Matrix4().multiplyMatrices(world[b.parentIndex], local);
  });
  const core = new Set(CORE_BONES.map((n) => d.bones.findIndex((b) => b.name === n)));
  assertTrue(!core.has(-1), '核心骨骼名在产物里找不到（骨骼改名了？）');
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  const P = d.geometry.position;
  for (let i = 0; i < P.length / 3; i++) {
    const bi = d.geometry.skinIndex[i * 4];
    if (!core.has(bi)) continue;
    box.expandByPoint(v.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]).applyMatrix4(world[bi]));
  }
  return box;
}

test('焰魔: 命中盒实测度量（改烘焙器/素材后必须同步这里）', () => {
  // v2.59 重标（**不是放宽**，容差仍是精确相等）。依据 = 产物七根核心骨骼 bind pose 的包围盒
  // （模型空间 px，由下方 `coreBboxFromAsset` 复算）：x[−13.222, 13.222] y[5, 51.84] z[−14.753, 8.048]
  //   → 半长 (0.8264, 1.4637, 0.7125) 格；模型空间中心 (0, 1.7762, −0.2095) 格；
  //   → 渲染器把 mesh 下移 |feetOffsetY|（v3.01 实测 0.2228601 格），故相对脚底的中心 = (0, 1.5534, −0.2095)。
  // ⚠️ v3.01 重标 center[1] 1.5106 → 1.5534：feetOffsetY 扫全部招式动画，加入持盾冲撞 attack1 后
  // 从 −0.265625 变成 −0.2228601（持盾冲撞下蹲幅度比另两招浅 ⇒ 最低点上移）。halfExtents 来自 bind pose，不变。
  // 旧值 halfExtents [0.8264, 1.421, 0.777] / MODEL_CENTER [0, 1.7335, 0.0895] 是 v2.58 之前
  // （错误旋转约定下的 bind pose）的实测，且 center 沿用「position = 核心中心」的旧语义。
  assertEqual(IGNIS_CORE_OBB.halfExtents[0], 0.8264);
  assertEqual(IGNIS_CORE_OBB.halfExtents[1], 1.4637);
  assertEqual(IGNIS_CORE_OBB.halfExtents[2], 0.7125);
  assertEqual(IGNIS_CORE_OBB.center[0], 0);
  assertEqual(IGNIS_CORE_OBB.center[1], 1.5534);
  assertEqual(IGNIS_CORE_OBB.center[2], -0.2095);
  assertEqual(IGNIS_MODEL_CENTER[0], 0);
  assertEqual(IGNIS_MODEL_CENTER[1], 1.7762);
  assertEqual(IGNIS_MODEL_CENTER[2], -0.2095);
});

test('焰魔: 命中盒是相对脚底的盒子（底面不入地、顶面不超出碰撞盒高）', () => {
  const bottom = IGNIS_CORE_OBB.center[1] - IGNIS_CORE_OBB.halfExtents[1];
  const top = IGNIS_CORE_OBB.center[1] + IGNIS_CORE_OBB.halfExtents[1];
  // 旧缺陷：center.y = 0 ⇒ bottom = −1.421（盒子的下半截在地下，上半截只到 +1.421）
  assertTrue(bottom >= 0, `命中盒底面 ${bottom.toFixed(4)} 在脚底之下（盒子仍以脚底为中心？）`);
  assertTrue(top <= IGNIS.height, `命中盒顶面 ${top.toFixed(4)} 超出碰撞盒高 ${IGNIS.height}`);
});

test('焰魔: 命中盒 = 产物核心骨骼 bind pose 包围盒（独立复算，容差 1e-4 = 4 位小数舍入）', async () => {
  const d = await loadIgnisAsset();
  const box = coreBboxFromAsset(d);
  const c = box.getCenter(new THREE.Vector3());
  const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  const feet = d.metrics.feetOffsetY;   // 渲染器 mesh.position.y：模型空间 → 相对脚底
  const near = (cfg, derived, what) => assertTrue(Math.abs(cfg - derived) <= 1e-4,
    `${what}: 配置 ${cfg} vs 产物复算 ${derived.toFixed(5)}（改了素材/烘焙器？重标 IGNIS_CORE_OBB 与 IGNIS_MODEL_CENTER）`);
  for (let a = 0; a < 3; a++) near(IGNIS_CORE_OBB.halfExtents[a], half.getComponent(a), `halfExtents[${a}]`);
  near(IGNIS_MODEL_CENTER[0], c.x, 'MODEL_CENTER[0]');
  near(IGNIS_MODEL_CENTER[1], c.y, 'MODEL_CENTER[1]');
  near(IGNIS_MODEL_CENTER[2], c.z, 'MODEL_CENTER[2]');
  // 相对脚底：只有 y 受 feetOffsetY 影响（渲染器没有 x/z 偏移）
  near(IGNIS_CORE_OBB.center[0], c.x, 'CORE_OBB.center[0]');
  near(IGNIS_CORE_OBB.center[1], c.y + feet, 'CORE_OBB.center[1]（= MODEL_CENTER.y + feetOffsetY）');
  near(IGNIS_CORE_OBB.center[2], c.z, 'CORE_OBB.center[2]');
});

test('焰魔: 命中盒与画面里的核心躯干六个面的偏差都在 0.3 格内（真实渲染器蒙皮：待机多相位 + 挥砍起手）', async () => {
  const d = await loadIgnisAsset();
  const r = new IgnisRenderer(new THREE.Scene(), d);
  try {
    const inst = r.instances[0];
    const core = new Set(CORE_BONES.map((n) => d.bones.findIndex((b) => b.name === n)));
    const skin = inst.mesh.geometry.getAttribute('skinIndex');
    const hit = ignisAabbFor({ position: [0, 0, 0], yaw: 0 });
    const v = new THREE.Vector3();
    // ⚠️ 容差 0.3 是刻意的**粗**判据：它守的是「盒子整体偏离画面」这类大错（旧缺陷偏了 1.4 格），
    // 不是亚 0.25 格的差异。实测（2026-11-05）配置盒（bind pose 链式矩阵口径）与渲染所见在 z 前缘
    // 相差约 0.235 格：渲染器的逆绑定矩阵含 bind 旋转，rest 帧显示的是未摆 bind 姿态的原始几何
    // （见 roadmap v2.59 的「遗留」）。该差异收敛后可把容差收紧。
    const TOL = 0.3;
    const poses = [
      ['待机 t=0', { attackAnimT: 0, idleTime: 0 }],
      ['待机 t=0.7', { attackAnimT: 0, idleTime: 0.7 }],
      ['待机 t=1.4', { attackAnimT: 0, idleTime: 1.4 }],
      ['待机 t=2.1', { attackAnimT: 0, idleTime: 2.1 }],
      ['挥砍起手 t=0.05', { attackAnimT: 0.05, idleTime: 0 }],
    ];
    for (const [label, pose] of poses) {
      r.sync([{
        id: 'ignis:test:1',
        state: { position: [0, 0, 0], yaw: 0, flashedUntil: 0, ...pose },
      }], 0);
      inst.pivot.updateMatrixWorld(true);
      const rendered = new THREE.Box3();
      for (let i = 0; i < skin.count; i++) {
        if (!core.has(skin.getX(i))) continue;
        inst.mesh.getVertexPosition(i, v);          // CPU 蒙皮（与 GPU 蒙皮同公式）
        rendered.expandByPoint(v.applyMatrix4(inst.mesh.matrixWorld));
      }
      const axes = ['x', 'y', 'z'];
      for (let a = 0; a < 3; a++) {
        const dMin = rendered.min.getComponent(a) - hit.min[a];
        const dMax = rendered.max.getComponent(a) - hit.max[a];
        assertTrue(Math.abs(dMin) <= TOL && Math.abs(dMax) <= TOL,
          `${label} ${axes[a]} 向：画面核心 [${rendered.min.getComponent(a).toFixed(3)}, ${rendered.max.getComponent(a).toFixed(3)}]`
          + ` vs 命中盒 [${hit.min[a].toFixed(3)}, ${hit.max[a].toFixed(3)}]（偏差 ${dMin.toFixed(3)} / ${dMax.toFixed(3)}，容差 ${TOL}）`);
      }
    }
  } finally {
    r.dispose();
  }
});

// ==================== definition.create ====================

test('焰魔: create 拒绝非法 position', () => {
  assertNull(ignisDefinition.create({ position: [NaN, 0, 0] }));
  assertNull(ignisDefinition.create({ position: [0, 0] }));
  assertNull(ignisDefinition.create({ position: null }));
  assertNull(ignisDefinition.create(null));
});

test('焰魔: create 补全缺省字段', () => {
  const st = ignisDefinition.create({ position: [1, 2, 3] });
  assertNotNull(st);
  assertEqual(st.health, IGNIS.health);
  assertEqual(st.mode, 'idle');
  assertEqual(st.attackAnimT, 0);
  assertEqual(st.attackCooldown, 0);
  assertEqual(st.attackRequest, null);
  assertEqual(st.yaw, 0);
  assertEqual(st.onGround, false);
  // velocity 必须是长度为 3 的数组（物理推进要写它）
  assertEqual(st.velocity.length, 3);
});

test('焰魔: create 保留传入的合法字段', () => {
  const st = ignisDefinition.create({
    position: [5, 6, 7], yaw: 1.5, health: 100, mode: 'chase', attackAnimT: 0.5,
  });
  assertEqual(st.position[0], 5);
  assertEqual(st.yaw, 1.5);
  assertEqual(st.health, 100);
  assertEqual(st.mode, 'chase');
  assertEqual(st.attackAnimT, 0.5);
});

test('焰魔: create 拒绝非法 mode（回落 idle）', () => {
  assertEqual(ignisDefinition.create({ position: [0, 0, 0], mode: 'flying' }).mode, 'idle');
});

test('焰魔: create 返回全新数组（不共享输入的 position）', () => {
  const pos = [1, 2, 3];
  const st = ignisDefinition.create({ position: pos });
  assertTrue(st.position !== pos, 'position 数组被复用（M5 索引迁移不变式会破）');
});

// ==================== 实体 id 派生 ====================

test('焰魔: 实体 id 由 (mapKey, slot) 派生，同参恒同 id', () => {
  assertEqual(ignisEntityIdFor('tarn:2:0', 1), ignisEntityIdFor('tarn:2:0', 1));
});

test('焰魔: 不同地图/槽位的 id 不同', () => {
  assertTrue(ignisEntityIdFor('tarn:2:0', 1) !== ignisEntityIdFor('tarn:3:0', 1));
  assertTrue(ignisEntityIdFor('tarn:2:0', 1) !== ignisEntityIdFor('tarn:2:0', 0));
});

test('焰魔: 与飞龙的 id 前缀不同（两种 Boss 不会撞 id）', () => {
  assertTrue(ignisEntityIdFor('tarn:2:0', 1).startsWith(IGNIS_TYPE),
    `id 应以 ${IGNIS_TYPE} 开头：${ignisEntityIdFor('tarn:2:0', 1)}`);
  assertTrue(!ignisEntityIdFor('tarn:2:0', 1).includes('dragon'));
});

// ==================== overlapsAabb（v2.62 玩家阻挡）====================
//
// 用户缺陷⑦：「焰魔作为一个巨大的存在，如果焰魔不动，焰魔是可以挡住玩家前进的」。
// 玩家物理把焰魔身体盒当实心（`player/physics.js` 注入本 service，同 minecarts 手法）。
// 本方法回答「给定一个世界 AABB，是否与任一存活焰魔的身体盒相交」。

test('焰魔: overlapsAabb 相交真 / 远离假 / 无焰魔假', () => {
  const em = new EntityManager();
  em.registerType(IGNIS_TYPE, ignisDefinition);
  const svc = new IgnisService({ entities: em, world: flatWorld(10), seed: 1 });
  assertTrue(svc.summon('tarn:t:0', 5, 5, 1, 11).ok);
  const e = svc.activeEntities()[0];
  const [ex, ey, ez] = e.state.position;
  // 包住焰魔身体的盒 → 相交
  assertTrue(svc.overlapsAabb({
    minX: ex - 1, maxX: ex + 1, minY: ey, maxY: ey + 3, minZ: ez - 1, maxZ: ez + 1,
  }), '包住身体的盒应相交');
  // 远离 10 格的盒 → 不相交
  assertFalse(svc.overlapsAabb({
    minX: ex + 10, maxX: ex + 11, minY: ey, maxY: ey + 1, minZ: ez + 10, maxZ: ez + 11,
  }), '远离的盒不应相交');
  // 贴面（恰好碰到身体盒边界）→ 严格不等式，不算重叠
  const local = ignisAabbFor(e.state);
  const wMaxX = ex + local.max[0];
  assertFalse(svc.overlapsAabb({
    minX: wMaxX, maxX: wMaxX + 1, minY: ey, maxY: ey + 3, minZ: ez - 1, maxZ: ez + 1,
  }), '贴面不应算重叠（同 overlapsBlock 口径）');
  // 无焰魔的 service → 恒假
  const em2 = new EntityManager();
  em2.registerType(IGNIS_TYPE, ignisDefinition);
  const svc2 = new IgnisService({ entities: em2, world: flatWorld(10), seed: 1 });
  assertFalse(svc2.overlapsAabb({
    minX: -1, maxX: 1, minY: 0, maxY: 2, minZ: -1, maxZ: 1,
  }), '无焰魔应恒假');
});

test('焰魔: overlapsAabb 随 yaw 旋转（横过来时身体盒变宽）', () => {
  const em = new EntityManager();
  em.registerType(IGNIS_TYPE, ignisDefinition);
  const svc = new IgnisService({ entities: em, world: flatWorld(10), seed: 1 });
  assertTrue(svc.summon('tarn:t:0', 5, 5, 1, 11).ok);
  const e = svc.activeEntities()[0];
  const [ex, ey, ez] = e.state.position;
  // yaw=0 时身体盒 z 向较窄；把焰魔转 90°，x 向变宽
  e.state = ignisDefinition.create({ ...e.state, yaw: Math.PI / 2 });
  const local = ignisAabbFor(e.state);
  // 在旋转后的 x 边界外一点点放一个盒 → 不应相交
  assertFalse(svc.overlapsAabb({
    minX: ex + local.max[0] + 0.5, maxX: ex + local.max[0] + 1.5,
    minY: ey, maxY: ey + 3, minZ: ez - 0.2, maxZ: ez + 0.2,
  }), '旋转后边界外的盒不应相交');
});

test('焰魔: overlapsAabb 死亡后不再相交（id 留在短路 Set 里但实体已 despawn）', () => {
  // ⚠️ 这条钉的是 `_ignisIds` 热路径短路的**边界**：id 由 `ignisEntityIdFor` 确定性派生，
  // 死了又召复用同 id ⇒ Set 不清理；但已 despawn 的 id 必须不再参与相交判定
  //（`entities.get(id)` 返回 null ⇒ 跳过）。若实现漏了 null 检查会在这里抛 TypeError。
  const em = new EntityManager();
  em.registerType(IGNIS_TYPE, ignisDefinition);
  const svc = new IgnisService({ entities: em, world: flatWorld(10), seed: 1 });
  assertTrue(svc.summon('tarn:t:0', 5, 5, 1, 11).ok);
  const e = svc.activeEntities()[0];
  const [ex, ey, ez] = e.state.position;
  const hitBox = {
    minX: ex - 1, maxX: ex + 1, minY: ey, maxY: ey + 3, minZ: ez - 1, maxZ: ez + 1,
  };
  assertTrue(svc.overlapsAabb(hitBox), '前置：活着时应相交');
  svc.damage(e.id, IGNIS.health + 1, 0);   // 打死 ⇒ despawn
  assertEqual(svc.activeEntities().length, 0, '前置：应已 despawn');
  assertFalse(svc.overlapsAabb(hitBox), '死亡后不应再相交（id 留在 Set 里但实体没了）');
});

// ==================== service.summon ====================

test('焰魔: summon 在地表落点生成实体（position.y 在地面之上）', () => {
  const em = new EntityManager();
  em.registerType(IGNIS_TYPE, ignisDefinition);
  const svc = new IgnisService({ entities: em, world: flatWorld(10), seed: 1 });
  const r = svc.summon('tarn:2:0', 100, 200, 1);
  assertTrue(r.ok, JSON.stringify(r));
  const e = em.get(r.id);
  assertNotNull(e);
  assertEqual(e.type, IGNIS_TYPE);
  // 脚底应落在地表方块之上（y = 11），不是悬空也不是埋在地下
  assertEqual(e.state.position[1], 11);
});

test('焰魔: summon 幂等（同槽位二次召唤返回 exists，不产生第二条）', () => {
  const em = new EntityManager();
  em.registerType(IGNIS_TYPE, ignisDefinition);
  const svc = new IgnisService({ entities: em, world: flatWorld(10), seed: 1 });
  const a = svc.summon('tarn:2:0', 100, 200, 1);
  assertTrue(a.ok);
  const b = svc.summon('tarn:2:0', 100, 200, 1);
  assertEqual(b.reason, 'exists');
  assertEqual([...em.entities()].filter((x) => x.type === IGNIS_TYPE).length, 1);
});

test('焰魔: 不同地图可以各召唤一条（共存）', () => {
  const em = new EntityManager();
  em.registerType(IGNIS_TYPE, ignisDefinition);
  const svc = new IgnisService({ entities: em, world: flatWorld(10), seed: 1 });
  assertTrue(svc.summon('tarn:2:0', 0, 0, 1).ok);
  assertTrue(svc.summon('tarn:3:0', 0, 0, 1).ok);
  assertEqual(svc.activeEntities().length, 2);
});

test('焰魔: 超出 maxAlive 返回 limit', () => {
  const em = new EntityManager();
  em.registerType(IGNIS_TYPE, ignisDefinition);
  const svc = new IgnisService({ entities: em, world: flatWorld(10), seed: 1 });
  for (let i = 0; i < IGNIS.maxAlive; i++) {
    assertTrue(svc.summon(`tarn:${i}:0`, 0, 0, 1).ok, `第 ${i} 条应成功`);
  }
  const over = svc.summon('tarn:99:0', 0, 0, 1);
  assertEqual(over.reason, 'limit');
});

test('焰魔: 空世界（isSolid 恒 false）也能召唤（兜底落点，不抛）', () => {
  const em = new EntityManager();
  em.registerType(IGNIS_TYPE, ignisDefinition);
  const svc = new IgnisService({ entities: em, world: emptyWorld(), seed: 1 });
  const r = svc.summon('tarn:2:0', 0, 0, 1);
  assertTrue(r.ok, JSON.stringify(r));
  assertTrue(Number.isFinite(em.get(r.id).state.position[1]), 'y 必须是有限数');
});

// ==================== service.damage ====================

test('焰魔: damage 扣血并设置红闪', () => {
  const em = new EntityManager();
  em.registerType(IGNIS_TYPE, ignisDefinition);
  const svc = new IgnisService({ entities: em, world: flatWorld(10), seed: 1 });
  const { id } = svc.summon('tarn:2:0', 0, 0, 1);
  const r = svc.damage(id, 100, 5000);
  assertEqual(r.dead, false);
  assertEqual(r.health, IGNIS.health - 100);
  assertEqual(em.get(id).state.health, IGNIS.health - 100);
});

test('焰魔: damage 到 0 即 despawn（死后槽位可重召）', () => {
  const em = new EntityManager();
  em.registerType(IGNIS_TYPE, ignisDefinition);
  const svc = new IgnisService({ entities: em, world: flatWorld(10), seed: 1 });
  const { id } = svc.summon('tarn:2:0', 0, 0, 1);
  const r = svc.damage(id, IGNIS.health, 5000);
  assertEqual(r.dead, true);
  assertNull(em.get(id));
  // 死后可重召（槽位清空）
  assertTrue(svc.summon('tarn:2:0', 0, 0, 1).ok, '死亡后应能重新召唤');
});

test('焰魔: damage 对未知 id / 非焰魔实体返回 null', () => {
  const em = new EntityManager();
  em.registerType(IGNIS_TYPE, ignisDefinition);
  const svc = new IgnisService({ entities: em, world: flatWorld(10), seed: 1 });
  assertNull(svc.damage('nope', 10, 0));
});

test('焰魔: activeEntities 返回快照数组（可安全在遍历中 damage）', () => {
  const em = new EntityManager();
  em.registerType(IGNIS_TYPE, ignisDefinition);
  const svc = new IgnisService({ entities: em, world: flatWorld(10), seed: 1 });
  svc.summon('tarn:2:0', 0, 0, 1);
  const list = svc.activeEntities();
  assertTrue(Array.isArray(list), '必须是数组而不是迭代器');
  // 遍历中 despawn 不该炸
  for (const e of list) svc.damage(e.id, IGNIS.health, 0);
  assertEqual(svc.activeEntities().length, 0);
});

test('焰魔: dispose 清空全部', () => {
  const em = new EntityManager();
  em.registerType(IGNIS_TYPE, ignisDefinition);
  const svc = new IgnisService({ entities: em, world: flatWorld(10), seed: 1 });
  svc.summon('tarn:2:0', 0, 0, 1);
  svc.dispose();
  assertEqual(svc.activeEntities().length, 0);
});

// ==================== 射线命中 ====================

/** 经真实 `summon` 召一只焰魔（`flatWorld(10)` ⇒ 脚底 y = 11），返回它的 state */
function summonedState() {
  const em = new EntityManager();
  em.registerType(IGNIS_TYPE, ignisDefinition);
  const svc = new IgnisService({ entities: em, world: flatWorld(10), seed: 1 });
  const { id } = svc.summon('tarn:2:0', 0, 0, 1);
  return em.get(id).state;
}

/**
 * 水平射线（沿 +Z，从 10 格外射向实体），高度 = 脚底 + `dyFromFeet`。x 取实体脚底轴线（核心足迹的中线）。
 *
 * ⚠️ **`dyFromFeet` 一律传相对脚底的字面量**，不要从 `IGNIS_CORE_OBB` 派生：旧用例把射线放在
 * `position.y + halfExtents[1]`（恰是旧盒的盒顶），于是「盒子究竟相对 position 摆在哪」这件事被
 * 用例自己的写法藏掉了 —— 盒子错位 1.4 格，该用例照样绿。
 */
function horizontalRayT(st, dyFromFeet) {
  const origin = [st.position[0], st.position[1] + dyFromFeet, st.position[2] - 10];
  return ignisDefinition.raycastAabb(st, origin, [0, 0, 1], 20);
}

test('焰魔(命中盒相对脚底): 脚底 +0.1 … +2.9 格的水平射线都命中核心躯干', () => {
  const st = summonedState();
  // 核心躯干在脚底 +0.047 ~ +2.974 格（见上方「实测度量」）；这些高度都严格落在其内。
  // 旧缺陷：盒子以脚底为中心（−1.421 ~ +1.421），≥ 1.5 的高度全部打空 —— 玩家打胸口 / 头部毫无反应。
  for (const dy of [0.1, 0.5, 1.0, 1.5, 2.0, 2.5, 2.9]) {
    assertNotNull(horizontalRayT(st, dy), `脚底 +${dy} 格的水平射线应命中核心躯干`);
  }
});

test('焰魔(命中盒相对脚底): 脚底之下与头顶之上的水平射线不命中（地下 / 半空没有幻影命中）', () => {
  const st = summonedState();
  // 旧缺陷的另一半：盒子下半截在地下，脚底以下 1.4 格内的射线也会「命中」。
  for (const dy of [-1.0, -0.2, 3.2, 3.5, 5.0]) {
    assertNull(horizontalRayT(st, dy), `脚底 ${dy >= 0 ? '+' : ''}${dy} 格的水平射线不应命中`);
  }
});

test('焰魔(命中盒相对脚底): 朝远离方向射不命中', () => {
  const st = summonedState();
  const origin = [st.position[0], st.position[1] + 1.5, st.position[2] - 10];
  assertNull(ignisDefinition.raycastAabb(st, origin, [0, 0, -1], 20), '朝远离方向射不该命中');
});

test('焰魔(命中盒相对脚底): 盒子随 yaw 旋转（中心的 z 偏移跟着转，不是只转半长）', () => {
  // 核心盒中心在脚底轴线前方 0.21 格（z = −0.2095）。若实现只旋转半长、不旋转 center，
  // 偏移会固定在世界 z 轴上 —— yaw = π/2 时盒子应沿世界 x 偏 0.21，却仍沿 z 偏。
  // 判据 = **旋转等变性**：把「实体局部系里的射线」整体绕脚底轴转 yaw（用 three 自己的 Ry 约定，
  // 与渲染器 `pivot.rotation.set(0, yaw, 0)` 同源），命中距离必须与 yaw = 0 时相同（容差 1e-9，只吃浮点误差）。
  // 只测 π/2 的整数倍：非 90° 时轴对齐包围盒比旋转盒大，距离本就不等。
  const base = summonedState();
  const Y = new THREE.Vector3(0, 1, 0);
  const rot = (a, yaw) => new THREE.Vector3(...a).applyAxisAngle(Y, yaw).toArray();
  const probes = [
    { o: [0, 1.5, -10], d: [0, 0, 1] },    // 前 → 后
    { o: [0, 1.5, 10], d: [0, 0, -1] },    // 后 → 前
    { o: [-10, 1.5, 0], d: [1, 0, 0] },    // 左 → 右
    { o: [10, 1.5, 0], d: [-1, 0, 0] },    // 右 → 左
  ];
  const at = (p, off) => [p[0] + off[0], p[1] + off[1], p[2] + off[2]];
  for (const { o, d } of probes) {
    const t0 = ignisDefinition.raycastAabb({ ...base, yaw: 0 }, at(base.position, o), d, 40);
    assertNotNull(t0, `yaw=0 的探测射线 ${JSON.stringify(d)} 应命中`);
    for (const yaw of [Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const t = ignisDefinition.raycastAabb(
        { ...base, yaw }, at(base.position, rot(o, yaw)), rot(d, yaw), 40);
      assertNotNull(t, `yaw=${yaw.toFixed(3)} 的探测射线 ${JSON.stringify(d)} 应命中`);
      assertTrue(Math.abs(t - t0) < 1e-9,
        `yaw=${yaw.toFixed(3)} 方向 ${JSON.stringify(d)}：命中距离 ${t} ≠ yaw=0 的 ${t0}（盒子中心没随 yaw 旋转？）`);
    }
  }
});

// ==================== 寻路接线（v2.61）====================
//
// 为什么放在 service 层而不是 Agent：A\* 需要 `PathCache`（跨帧时效 + 路径前缀匹配）
// 与 20Hz 节流，而 `BossAgent` 的契约是「无跨帧成员」。丧尸的 `_stepNavigator` 也在服务层
// —— 两条寻路路径因此长得一样（红线 1 的统一入口）。

/**
 * 平地 + 一道带缺口的墙（与 `test-ignis-boss-agent.js` 的 `wallWorld` 同形）。
 * 墙在 z = wallZ，x ∈ [-halfLen, halfLen]。
 */
function wallWorldForService({ groundY = 9, wallZ = -14, halfLen = 6, wallH = 4 } = {}) {
  const solid = (x, y, z) => {
    if (y <= groundY) return true;
    return Math.abs(x) <= halfLen && y <= groundY + wallH && Math.abs(z - wallZ) <= 0.5;
  };
  return { isSolid: solid, getBlockId: (x, y, z) => (solid(x, y, z) ? 1 : 0) };
}

test('IgnisService 寻路: needsPath 为真时写入 navDir，为假时保持 null', () => {
  const em = new EntityManager();
  em.registerType(IGNIS_TYPE, ignisDefinition);
  const w = wallWorldForService();
  const svc = new IgnisService({ entities: em, world: w, seed: 1 });
  const { id } = svc.summon('tarn:2:0', 0, 0, 1);
  const e = em.get(id);
  // 主动摆到墙南侧，玩家在墙北侧（中间隔墙 ⇒ 需要绕行）
  e.state = ignisDefinition.create({ ...e.state, position: [0.5, 10, 0.5], needsPath: true });
  svc.update(IGNIS_AI.navPeriod, { playerPosition: [0.5, 10, -24.5], nowMs: 0 });
  const after = em.get(id).state;
  assertNotNull(after.navDir, '需要绕行的焰魔应拿到寻路方向');
  assertTrue(Math.hypot(after.navDir[0], after.navDir[1]) > 0.9,
    `navDir 应是单位方向，实测 ${after.navDir}`);
  // ⚠️ **不能要求「第一步就横向移动」**：墙只有 13 格宽，A\* 的正确路径是先直走到
  // 墙前、再沿墙横移、最后绕端过去（实测 _path：z 到 −8 才开始横向）。
  // 断言应当落在**整条路径真的绕开了墙**上 —— 路径里每一点的脚底格都不得落在墙体上。
  const path = svc.cachedPathOf(id);
  assertNotNull(path, '应留有缓存路径供核查');
  let crossedAtX = null;
  for (const [px, pz] of path) {
    // 这一格能不能站（用被测实现之外的独立判据：直接问世界）
    assertTrue(!w.isSolid(px, 10, pz),
      `路径点 (${px},10,${pz}) 落在实体方块上（规划出了穿墙路线）`);
    if (crossedAtX === null && pz <= -14) crossedAtX = px;
  }
  assertNotNull(crossedAtX, '路径应真的越过墙所在的 z 列');
  assertTrue(Math.abs(crossedAtX) > 6,
    `越过墙时 x=${crossedAtX}，应绕到墙端之外（|x| > 6）`);

  // needsPath=false ⇒ 不规划（navDir 保持 null）
  const em2 = new EntityManager();
  em2.registerType(IGNIS_TYPE, ignisDefinition);
  const svc2 = new IgnisService({ entities: em2, world: flatWorld(9), seed: 1 });
  const r2 = svc2.summon('tarn:2:0', 0, 0, 1);
  svc2.update(IGNIS_AI.navPeriod, { playerPosition: [0.5, 10, -24.5], nowMs: 0 });
  assertNull(em2.get(r2.id).state.navDir, 'needsPath=false 时不应规划（零 A* 开销）');
  assertEqual(svc2.navDebugState().decisions, 0, '不该有任何寻路决策');
});

test('IgnisService 寻路: 节流到 navPeriod（每帧 update 不会每帧跑 A*）', () => {
  const em = new EntityManager();
  em.registerType(IGNIS_TYPE, ignisDefinition);
  const svc = new IgnisService({ entities: em, world: wallWorldForService(), seed: 1 });
  const { id } = svc.summon('tarn:2:0', 0, 0, 1);
  em.get(id).state = ignisDefinition.create({ ...em.get(id).state, position: [0.5, 10, 0.5], needsPath: true });
  // 跑 1 秒的帧循环（60 帧）：20Hz ⇒ 约 20 次决策，远小于 60
  for (let i = 0; i < 60; i++) {
    em.get(id).state = ignisDefinition.create({ ...em.get(id).state, needsPath: true });
    svc.update(1 / 60, { playerPosition: [0.5, 10, -24.5], nowMs: i * (1000 / 60) });
  }
  const d = svc.navDebugState().decisions;
  assertTrue(d >= 15 && d <= 25, `1 秒内决策 ${d} 次（应约 20 次 = 20Hz，不是 60 次）`);
});

test('IgnisService 寻路: 死亡后缓存与导航记忆都被回收', () => {
  const em = new EntityManager();
  em.registerType(IGNIS_TYPE, ignisDefinition);
  const svc = new IgnisService({ entities: em, world: wallWorldForService(), seed: 1 });
  const { id } = svc.summon('tarn:2:0', 0, 0, 1);
  em.get(id).state = ignisDefinition.create({ ...em.get(id).state, needsPath: true });
  svc.update(IGNIS_AI.navPeriod, { playerPosition: [0.5, 10, -24.5], nowMs: 0 });
  assertNotNull(svc.cachedPathOf(id), '规划后应留有缓存路径');

  svc.damage(id, IGNIS.health + 1, 0);
  assertNull(svc.cachedPathOf(id), '死亡后缓存条目必须被回收（否则重召会带上一条命的状态）');
});

test('IgnisService + 焰魔 Agent 闭环：长墙挡路时真的绕过去走到玩家身边（v2.61 核心用例）', () => {
  // ⚠️ 这是**唯一一条端到端**的单测：`svc.update`（寻路）+ `ignisDefinition.update`（Agent
  // 物理）按真实帧序交替推进。上面几条只钉各层自己的契约，这一条钉「合起来真的能到」。
  //
  // 墙：z = −14，x ∈ [−6, 6]，高 4 格（远超 1.2 格探针 ⇒ 局部避障看不到尽头）。
  const em = new EntityManager();
  em.registerType(IGNIS_TYPE, ignisDefinition);
  const w = wallWorldForService();
  const svc = new IgnisService({ entities: em, world: w, seed: 1 });
  const { id } = svc.summon('tarn:2:0', 0, 0, 1);
  em.get(id).state = ignisDefinition.create({
    ...em.get(id).state,
    // 焰魔在墙南侧 13 格、玩家在墙北侧 10 格
    position: [0.5, 10, 0.5], mode: 'chase', onGround: true, yaw: 0,
  });
  const playerPos = [0.5, 10, -24.5];
  const ctx = {
    world: w,
    registry: { solidTable: { 1: 1 }, opaqueTable: { 1: 1 } },
    player: { position: playerPos },
  };
  const DT = 1 / 60;
  let minD = Infinity;
  let pathUsed = 0;
  // 60 秒 —— 足够绕完 13 格宽的墙（追击速度 6.6 格/秒）
  for (let i = 0; i < 60 * 60; i++) {
    svc.update(DT, { playerPosition: playerPos, nowMs: i * (1000 / 60) });
    const ent = em.get(id);
    const next = ignisDefinition.update(ent, DT, ctx);
    if (next) em.get(id).state = next;
    if (em.get(id).state.navDir) pathUsed++;
    const p = em.get(id).state.position;
    minD = Math.min(minD, Math.hypot(p[0] - playerPos[0], p[2] - playerPos[2]));
    if (minD <= IGNIS_AI.standoffRange + 1) break;
  }
  const p = em.get(id).state.position;
  const d = Math.hypot(p[0] - playerPos[0], p[2] - playerPos[2]);
  // ① 真的走到了玩家身边（站定环附近）
  assertTrue(d <= IGNIS_AI.standoffRange + 1.5,
    `60 秒后仍在 ${d.toFixed(2)} 格外（应绕到 ${IGNIS_AI.standoffRange} 格附近）`);
  // ② 整个过程中真的用了寻路（否则这条用例只是「区域无障碍」的假通过）
  assertTrue(pathUsed > 0, '一次寻路结果都没拿到 —— 这条用例没测到绕行');
  // ③ 从没落进墙体（穿墙的形态是「直线到玩家」）
  assertTrue(!w.isSolid(Math.floor(p[0]), Math.floor(p[1]), Math.floor(p[2])),
    `最终位置 (${p.map((n) => n.toFixed(2))}) 在方块内部`);
});
