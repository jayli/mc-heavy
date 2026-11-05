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
import { assertEqual, assertTrue, assertNull, assertNotNull } from './assert.js';
// config 与 system 分开 import（system 只 re-export 它需要的东西，不是全部）
import {
  IGNIS_TYPE, IGNIS, IGNIS_AI, IGNIS_CORE_OBB, IGNIS_MODEL_CENTER, ignisEntityIdFor,
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
  assertEqual(IGNIS.health, 450);          // MAX_HEALTH
  assertEqual(IGNIS.attackDamage, 14);     // ATTACK_DAMAGE
  assertEqual(IGNIS_AI.sightRange, 50);    // FOLLOW_RANGE
  assertEqual(IGNIS_AI.chaseSpeed, 6.6);   // MOVEMENT_SPEED 0.33 格/tick × 20
});

test('焰魔: 近战判据取自 AreaAttack(6.5, 6, 70, ...)（arc 是总角度 ⇒ 半角 35）', () => {
  assertEqual(IGNIS_AI.hitRange, 6.5);
  assertEqual(IGNIS_AI.hitConeDeg, 35);
  // ⚠️ 若有人把 70 直接填进来（当成半角），扇面会翻倍到 140° —— 玩家绕到侧面也躲不掉
  assertTrue(IGNIS_AI.hitConeDeg < 70, 'hitConeDeg 必须是半角，不是 arc 原值');
});

test('焰魔: 命中帧 = SWING_ATTACK 的 tick 24 / 20 = 1.20 秒', () => {
  assertEqual(IGNIS_AI.hitFrameSeconds, 1.20);
  // 必须落在攻击动画时长之内，否则永远不会触发
  assertTrue(IGNIS_AI.hitFrameSeconds < IGNIS_AI.attackAnimSeconds,
    `命中帧 ${IGNIS_AI.hitFrameSeconds} 超出动画 ${IGNIS_AI.attackAnimSeconds}`);
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
  //   → 渲染器把 mesh 下移 |feetOffsetY| = 0.265625 格，故相对脚底的中心 = (0, 1.5106, −0.2095)。
  // 旧值 halfExtents [0.8264, 1.421, 0.777] / MODEL_CENTER [0, 1.7335, 0.0895] 是 v2.58 之前
  // （错误旋转约定下的 bind pose）的实测，且 center 沿用「position = 核心中心」的旧语义。
  assertEqual(IGNIS_CORE_OBB.halfExtents[0], 0.8264);
  assertEqual(IGNIS_CORE_OBB.halfExtents[1], 1.4637);
  assertEqual(IGNIS_CORE_OBB.halfExtents[2], 0.7125);
  assertEqual(IGNIS_CORE_OBB.center[0], 0);
  assertEqual(IGNIS_CORE_OBB.center[1], 1.5106);
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
