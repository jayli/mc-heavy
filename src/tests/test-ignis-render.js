// src/tests/test-ignis-render.js — 焰魔渲染器（v2.55）
//
// 覆盖：实例池契约（容量/共享几何/独立材质与骨骼）、脚底补偿、动画选择（idle ↔ attack）、
// 红闪、无实体时隐藏、姿态衔接（v2.76：idle ↔ 攻击片段的淡入淡出，见文件末尾那一节）。
//
// 与飞龙渲染器（`test-dragon-render.js`）的差异只测三处：
//   ① 池容量 = IGNIS.maxAlive(2)；
//   ② mesh 的 y 偏移多一个「脚底补偿」（模型最低顶点在 −0.3042 格）；
//   ③ 动画由 `attackAnimT > 0` 选择（飞龙是内部状态机）。
import * as THREE from 'three';
import { test } from './runner.js';
import { assertEqual, assertTrue, assertNotNull } from './assert.js';
import { IgnisRenderer } from '../render/ignis-renderer.js';
import {
  sampleIgnisAnim, sampleIgnisAttack, loadIgnisAsset, blendIgnisPose, IgnisPoseTransition,
} from '../render/ignis-model.js';
import { IGNIS, IGNIS_POSE_BLEND } from '../entities/ignis/ignis-config.js';

let asset = null;
async function getAsset() {
  if (asset) return asset;
  asset = await loadIgnisAsset();
  return asset;
}

const FRAME_MS = 1000 / 60;

/**
 * 以 60fps 时间戳把**同一状态**连续 `sync` 若干帧，让姿态衔接（idle ↔ 攻击片段的淡入淡出，
 * v2.76）收敛到稳态。
 *
 * 为什么既有用例需要它：状态切换后，**单次** `sync(…, 0)`（dt=0 ⇒ 混合权重 0）只会得到衔接的
 * 起点姿态，而不是新状态的稳态姿态。想断言「这一状态画的是哪支动画」必须先走够
 * `IGNIS_POSE_BLEND.seconds`。断言本身不变，变的只是取值时机。
 *
 * @returns {number} 末帧时间戳（ms），供调用方接着往后走
 */
function settle(r, entity, fromMs = 0, frames = Math.ceil(IGNIS_POSE_BLEND.seconds * 60) + 3) {
  let ms = fromMs;
  for (let i = 0; i < frames; i++) {
    ms += FRAME_MS;
    r.sync([entity], ms);
  }
  return ms;
}

// ==================== 产物装载 ====================

test('焰魔渲染: loadIgnisAsset 能取到产物且形状正确', async () => {
  const d = await getAsset();
  assertNotNull(d.bones);
  assertNotNull(d.geometry);
  assertNotNull(d.animations);
  assertTrue(d.bones.length > 0);
  assertTrue(d.animations.idle.frameCount > 0);
  assertTrue(d.animations.attack.frameCount > 0);
});

// ==================== 动画采样 ====================

test('焰魔渲染: sampleIgnisAnim 循环取模（含负数时刻，不返回空 Map）', async () => {
  const d = await getAsset();
  const a = d.animations.idle;
  const duration = a.frameCount / a.fps;
  const m0 = sampleIgnisAnim(a, 0.001);
  const m1 = sampleIgnisAnim(a, duration + 0.001);
  assertEqual(m0.size, m1.size, '循环一个周期后骨骼集合应相同');
  // 非负取模：负时刻也要能采（JS 的 % 对负数返回负值）
  const neg = sampleIgnisAnim(a, -duration * 0.5);
  assertEqual(neg.size, m0.size);
  for (const [, delta] of neg) {
    assertTrue(delta.rot.every(Number.isFinite), '负时刻采样出 NaN');
  }
});

test('焰魔渲染: sampleIgnisAnim 对空/非法动画返回空 Map（不抛）', () => {
  assertEqual(sampleIgnisAnim(null, 0).size, 0);
  assertEqual(sampleIgnisAnim({ frameCount: 0, fps: 30, boneIndices: [], frames: [] }, 0).size, 0);
});

test('焰魔渲染: sampleIgnisAnim 返回的四元数归一化', async () => {
  const d = await getAsset();
  const a = d.animations.attack;
  for (const t of [0, 0.5, 1.2, 2.0]) {
    for (const [, delta] of sampleIgnisAnim(a, t)) {
      const len = Math.hypot(...delta.rot);
      assertTrue(Math.abs(len - 1) < 1e-5, `t=${t} 四元数长度 ${len}`);
    }
  }
});

// ==================== 实例池契约 ====================

test('焰魔渲染: 池容量 = IGNIS.maxAlive，几何共享而骨骼/材质逐实例独立', async () => {
  const d = await getAsset();
  const scene = new THREE.Scene();
  const r = new IgnisRenderer(scene, d);
  assertEqual(r.instances.length, IGNIS.maxAlive);
  const geos = new Set(r.instances.map((i) => i.mesh.geometry));
  assertEqual(geos.size, 1, '几何必须共享一份（N 份会白占显存）');
  const mats = new Set(r.instances.map((i) => i.material));
  assertEqual(mats.size, IGNIS.maxAlive, '材质必须逐实例独立（红闪是材质级 color）');
  const skels = new Set(r.instances.map((i) => i.mesh.skeleton));
  assertEqual(skels.size, IGNIS.maxAlive, '骨骼必须逐实例独立');
  r.dispose();
});

test('焰魔渲染: 几何属性齐全（含 skinWeight 刚性绑定）', async () => {
  const d = await getAsset();
  const scene = new THREE.Scene();
  const r = new IgnisRenderer(scene, d);
  const inst = r.instances[0];
  for (const attr of ['position', 'normal', 'uv', 'skinIndex', 'skinWeight']) {
    assertTrue(inst.mesh.geometry.getAttribute(attr) !== undefined, `缺 ${attr}`);
  }
  assertEqual(inst.mesh.geometry.getAttribute('position').count, d.metrics.vertexCount);
  assertEqual(inst.mesh.geometry.getIndex().count, d.metrics.indexCount);
  const w = inst.mesh.geometry.getAttribute('skinWeight');
  for (let i = 0; i < w.count; i++) {
    assertEqual(w.getX(i), 1);
    assertEqual(w.getY(i), 0);
  }
  r.dispose();
});

// ==================== 脚底补偿（本渲染器独有的关键点）====================

test('焰魔渲染(v2.56 缺陷A): mesh 抬高 = 产物 metrics.feetOffsetY（不是 IGNIS_MODEL_CENTER）', async () => {
  const d = await getAsset();
  const scene = new THREE.Scene();
  const r = new IgnisRenderer(scene, d);
  const inst = r.instances[0];
  // ⚠️ 曾经写成 `-IGNIS_MODEL_CENTER[1] + IGNIS.modelFeetOffsetY`（-1.43）⇒ 模型陷地 1.70 格
  assertTrue(Math.abs(inst.mesh.position.y - d.metrics.feetOffsetY) < 1e-9,
    `mesh.position.y = ${inst.mesh.position.y}，期望 metrics.feetOffsetY = ${d.metrics.feetOffsetY}`);
  // 水平方向不该有偏移（模型原点已是脚下中轴）
  assertTrue(Math.abs(inst.mesh.position.x) < 1e-9, `x 偏移 ${inst.mesh.position.x}`);
  assertTrue(Math.abs(inst.mesh.position.z) < 1e-9, `z 偏移 ${inst.mesh.position.z}`);
  // feetOffsetY 是**小负数**（v2.56 追加修正后）：身体（不含武器）最低点在原点上方约 0.3，
  // 要让脚落到 position.y 就得下移 0.2 格。
  assertTrue(d.metrics.feetOffsetY > -0.6 && d.metrics.feetOffsetY < 0.1,
    `feetOffsetY ${d.metrics.feetOffsetY} 量级异常（应是小负数 ≈-0.2）`);
  r.dispose();
});

// ==================== 发布层 ====================

test('焰魔渲染: 无实体时全部实例隐藏（draw call 归零）', async () => {
  const d = await getAsset();
  const scene = new THREE.Scene();
  const r = new IgnisRenderer(scene, d);
  r.sync([], 0);
  for (const inst of r.instances) assertEqual(inst.pivot.visible, false);
  r.dispose();
});

test('焰魔渲染: 有实体时对应实例可见且位置对齐 state.position', async () => {
  const d = await getAsset();
  const scene = new THREE.Scene();
  const r = new IgnisRenderer(scene, d);
  const entity = {
    id: 'ignis:a:1',
    state: {
      position: [3, 11, -7], yaw: 0.5, health: 450, flashedUntil: 0,
      attackAnimT: 0, attackCooldown: 0,
    },
  };
  r.sync([entity], 0);
  assertEqual(r.instances[0].pivot.visible, true);
  assertTrue(Math.abs(r.instances[0].pivot.position.x - 3) < 1e-9);
  assertTrue(Math.abs(r.instances[0].pivot.position.y - 11) < 1e-9);
  assertTrue(Math.abs(r.instances[0].pivot.position.z - (-7)) < 1e-9);
  // 多余的实例必须隐藏
  for (let i = 1; i < r.instances.length; i++) assertEqual(r.instances[i].pivot.visible, false);
  r.dispose();
});

test('焰魔渲染: 红闪用材质 color（performance.now 基准，不是 Date.now）', async () => {
  const d = await getAsset();
  const scene = new THREE.Scene();
  const r = new IgnisRenderer(scene, d);
  const base = { position: [0, 0, 0], yaw: 0, health: 450, attackCooldown: 0 };
  // flashedUntil 在未来 → 红
  r.sync([{ id: 'a', state: { ...base, flashedUntil: 1000, attackAnimT: 0 } }], 500);
  assertTrue(r.instances[0].material.color.getHex() !== 0xffffff, '红闪时基色应改变');
  // 已过有效期 → 恢复白
  r.sync([{ id: 'a', state: { ...base, flashedUntil: 100, attackAnimT: 0 } }], 500);
  assertEqual(r.instances[0].material.color.getHex(), 0xffffff);
  r.dispose();
});

// ==================== 动画选择 ====================

test('焰魔渲染: attackAnimT > 0 时用 attack 动画，= 0 时用 idle', async () => {
  const d = await getAsset();
  const scene = new THREE.Scene();
  const r = new IgnisRenderer(scene, d);
  const base = { position: [0, 0, 0], yaw: 0, health: 450, flashedUntil: 0, attackCooldown: 0 };

  // 记录骨骼姿态：idle 与 attack 在同一时刻的姿态不同
  r.sync([{ id: 'a', state: { ...base, attackAnimT: 0 } }], 0);
  const idlePose = r.instances[0].bones.map((b) => b.quaternion.toArray());

  settle(r, { id: 'a', state: { ...base, attackAnimT: 0.5 } });
  const attackPose = r.instances[0].bones.map((b) => b.quaternion.toArray());

  let diff = 0;
  for (let i = 0; i < idlePose.length; i++) {
    for (let k = 0; k < 4; k++) diff += Math.abs(idlePose[i][k] - attackPose[i][k]);
  }
  assertTrue(diff > 0.05, `idle 与 attack 姿态差异 ${diff.toFixed(5)}（应明显不同）`);
  r.dispose();
});

test('焰魔渲染(v2.75): attackKind="spin" 时用 spin 动画（不是 attack）', async () => {
  const d = await getAsset();
  const scene = new THREE.Scene();
  const r = new IgnisRenderer(scene, d);
  const base = { position: [0, 0, 0], yaw: 0, health: 450, flashedUntil: 0, attackCooldown: 0 };
  let clock = 0;
  const poseOf = (state) => {
    clock = settle(r, { id: 'a', state: { ...base, ...state } }, clock);
    return r.instances[0].bones.map((b) => b.quaternion.toArray());
  };
  const dist = (p, q) => {
    let s = 0;
    for (let i = 0; i < p.length; i++) for (let k = 0; k < 4; k++) s += Math.abs(p[i][k] - q[i][k]);
    return s;
  };
  // 同一时刻（0.5s）下三者姿态必须互不相同：idle / swing / spin
  const idle = poseOf({ attackAnimT: 0 });
  const swing = poseOf({ attackAnimT: 0.5, attackKind: 'swing' });
  const spin = poseOf({ attackAnimT: 0.5, attackKind: 'spin' });
  assertTrue(dist(swing, spin) > 0.2,
    `attackKind=spin 与 swing 在 0.5s 的姿态差仅 ${dist(swing, spin).toFixed(4)}`
    + ' —— 渲染器没按 attackKind 选动画（形态是把旋斩播成横扫，而「有动画在播」的断言全绿）');
  assertTrue(dist(idle, spin) > 0.2, `spin 与 idle 姿态接近（差 ${dist(idle, spin).toFixed(4)}）`);
  // 反向：缺 attackKind（旧调用方）必须回落 swing，不得变成空姿态
  const legacy = poseOf({ attackAnimT: 0.5 });
  assertTrue(dist(legacy, swing) < 1e-9, '缺 attackKind 时应回落 attack（swing）动画');
  r.dispose();
});

test('焰魔渲染: attack 采样越过末尾时钳在末帧（不取模回绕）', async () => {
  const d = await getAsset();
  const a = d.animations.attack;
  const duration = a.frameCount / a.fps;
  // 直接测采样函数（比走渲染器更能定位问题）
  const atEnd = sampleIgnisAttack(a, a.frameCount / a.fps);   // 恰在末尾
  const wayPast = sampleIgnisAttack(a, 999);                  // 远超末尾
  const mid = sampleIgnisAttack(a, duration * 0.5);

  const totalDiff = (x, y) => {
    let s = 0;
    for (const [bi, dx] of x) {
      const dy = y.get(bi);
      if (!dy) { s += 1; continue; }
      for (let k = 0; k < 4; k++) s += Math.abs(dx.rot[k] - dy.rot[k]);
    }
    return s;
  };
  // ⚠️ **不能用「末帧 vs 首帧」作判据**：素材的 attack6a 收招时几乎回到起手姿态
  // （实测首末全骨骼总差仅 0.045），两者本就接近，无法区分「钳末帧」与「回绕到首帧」。
  // 正确的判据：**远超末尾** 必须等于**恰在末尾**（钳住），且与**中途**明显不同。
  assertTrue(totalDiff(wayPast, atEnd) < 1e-9,
    `t=999 的姿态应等于末尾姿态（钳住），实测差 ${totalDiff(wayPast, atEnd).toFixed(6)}`);
  assertTrue(totalDiff(wayPast, mid) > 0.5,
    '末尾姿态应与中途姿态明显不同（否则钳制没生效或动画是常量）');
});

// ==================== 释放 ====================

test('焰魔渲染: 骨骼增量从 bind 快照起算（不逐帧累积）', async () => {
  const d = await getAsset();
  const scene = new THREE.Scene();
  const r = new IgnisRenderer(scene, d);
  const base = { position: [0, 0, 0], yaw: 0, health: 450, flashedUntil: 0, attackCooldown: 0 };
  // 同一状态重复 sync 5 次，姿态必须逐位相同（累积会越跑越散架）
  r.sync([{ id: 'a', state: { ...base, attackAnimT: 0.3 } }], 0);
  const first = r.instances[0].bones.map((b) => b.quaternion.toArray());
  for (let i = 0; i < 5; i++) r.sync([{ id: 'a', state: { ...base, attackAnimT: 0.3 } }], 0);
  const after = r.instances[0].bones.map((b) => b.quaternion.toArray());
  for (let i = 0; i < first.length; i++) {
    for (let k = 0; k < 4; k++) {
      assertTrue(Math.abs(first[i][k] - after[i][k]) < 1e-12,
        `骨骼 ${d.bones[i].name} 第 ${k} 分量漂移（增量在累积）`);
    }
  }
  r.dispose();
});

// ==================== v2.56 缺陷 C：骨骼原点必须随旋转变化 ====================
//
// 用户 2026-11-05：「挥舞兵刃的动作，有动作，但是身体的形状支离破碎了……特别是肩膀的
// 部位，似乎离开身体太远了」。
//
// 根因：`bone.position` 固定为**bind pose** 的 `localPosition`，只换 `quaternion`。
// 骨骼语义是「绕 pivot 旋转」，所以 position 必须按**当前**旋转重算：
//   `position = pivot − R_current · pivot`
// 不重算时，挥到一半的 right_arm 顶点实测落到 y ∈ [-3.2, -1.79]，躯干在 [1.75, 3.14]。
//
// ⚠️ **这条直接检查渲染器产出的 `bone.position`**（不是烘焙产物）——
// 烘焙产物 + 测试辅助函数都算对，也不能保证渲染器算对（它们各自实现同一公式）。

test('焰魔渲染(v2.56 缺陷C): 骨骼 position 随动画旋转重算（不是 bind 的 fixed 值）', async () => {
  const d = await getAsset();
  const scene = new THREE.Scene();
  const r = new IgnisRenderer(scene, d);
  const base = { position: [0, 0, 0], yaw: 0, health: 450, flashedUntil: 0, attackCooldown: 0 };

  // right_arm_joint 在攻击动画里转到 −147°，是位移最剧烈的一根
  const armIdx = d.bones.findIndex((b) => b.name === 'right_arm_joint');
  assertTrue(armIdx >= 0, '产物缺 right_arm_joint');

  // ① bind 帧（attackAnimT=0）的 position
  r.sync([{ id: 'a', state: { ...base, attackAnimT: 0 } }], 0);
  const bindPos = r.instances[0].bones[armIdx].position.toArray();

  // ② 挥到一半（约 1.0s，胳膊抬到最高）。先让 idle → attack 的淡入收敛（v2.76），否则取到的是起点
  settle(r, { id: 'a', state: { ...base, attackAnimT: 1.0 } });
  const animPos = r.instances[0].bones[armIdx].position.toArray();

  const moved = Math.hypot(animPos[0] - bindPos[0], animPos[1] - bindPos[1], animPos[2] - bindPos[2]);
  // 注入「固定 bind localPosition」时 moved 只来自动画的位移增量（接近 0）
  assertTrue(moved > 0.3,
    `right_arm_joint 的 position 只移动了 ${moved.toFixed(4)} 格 —— `
    + '说明用的是 bind 的固定值，没有按当前旋转重算（挥砍时胳膊会甩出去）');

  // ③ 用 pivot 公式反算校验（与烘焙同源的独立推导）
  const piv = d.bones[armIdx].pivot;
  assertTrue(Array.isArray(piv) && piv.length === 3, '产物缺 bones[].pivot');
  const q = r.instances[0].bones[armIdx].quaternion;
  const rp = new THREE.Vector3(piv[0], piv[1], piv[2]).applyQuaternion(q);
  const delta = r.instances[0].bones[armIdx].position;
  r.dispose();
  // 该帧动画的位移增量是 0（right_arm_joint 只有 rotation 关键帧）⇒ position ≈ pivot − R·pivot
  assertTrue(Math.abs(delta.x - (piv[0] - rp.x)) < 1e-4,
    `position.x=${delta.x.toFixed(4)} ≠ pivot−R·pivot=${(piv[0] - rp.x).toFixed(4)}`);
  assertTrue(Math.abs(delta.y - (piv[1] - rp.y)) < 1e-4,
    `position.y=${delta.y.toFixed(4)} ≠ pivot−R·pivot=${(piv[1] - rp.y).toFixed(4)}`);
});

// ==================== 上台阶视觉缓动（v2.62 用户缺陷③）====================
//
// 用户原文：「焰魔上台阶的动作没有缓动的动画，要像丧尸一样，上台阶也要有一个缓动的
// 动画效果，而不是闪现到台阶之上」。
//
// 分工与丧尸 v2.39 / 玩家相机完全一致：**物理瞬时**（AABB 状态要精确，否则碰撞/实体射线/
// 台阶净空全部错位），**只平滑渲染 y**。衰减参数不写第二份（复用 `player/step-lift.js`）。

/** 造一个最小可 sync 的焰魔实体（只改 y） */
function ignisAt(y, over = {}) {
  return {
    id: 'ignis-lift',
    state: {
      position: [0, y, 0], yaw: 0, health: 450, flashedUntil: 0,
      attackAnimT: 0, idleTime: 0, ...over,
    },
  };
}

test('焰魔渲染: 首帧对齐不触发缓动（出生不从 y=0 升上来）', async () => {
  const d = await getAsset();
  const r = new IgnisRenderer(new THREE.Scene(), d);
  r.sync([ignisAt(37)], 0);
  assertEqual(r.liftOffsetOf(0), 0, '首帧 prevY=null 应对齐而不触发');
  assertEqual(r.renderYOf(0), 37, '首帧渲染 y 应等于物理 y');
  r.dispose();
});

test('焰魔渲染: 上台阶 → 欠下负偏移且逐帧 ease-out 归零', async () => {
  const d = await getAsset();
  const r = new IgnisRenderer(new THREE.Scene(), d);
  r.sync([ignisAt(10)], 0);          // 首帧对齐
  r.sync([ignisAt(11)], 16);         // 物理瞬时抬 1 格
  const off = r.liftOffsetOf(0);
  assertTrue(off < 0, `上台阶应欠下负偏移，实际 ${off}`);
  assertTrue(off >= -1.0, `偏移不得超 StepLift 的 MAX_LAG(1 格)，实际 ${off}`);
  // 渲染 y = 物理 y + 偏移（钉住「算对了且写进了矩阵」）
  assertTrue(Math.abs(r.renderYOf(0) - (11 + off)) < 1e-9,
    `renderYOf=${r.renderYOf(0)} 应等于 physY+offset=${11 + off}`);
  // 渲染 y 此时应仍接近**旧**高度（观感：从旧高度平滑追平，不是瞬移）
  assertTrue(r.renderYOf(0) < 10.95,
    `抬升当帧渲染 y=${r.renderYOf(0).toFixed(3)}，应仍贴近旧高度 10（否则就是瞬移）`);
  // 逐帧衰减：单调上升并收敛到 0
  let prev = off;
  for (let i = 0; i < 60; i++) {
    r.sync([ignisAt(11)], 16 + (i + 1) * 16);
    const cur = r.liftOffsetOf(0);
    assertTrue(cur >= prev - 1e-12, `偏移应单调上升（ease-out），${prev} → ${cur}`);
    prev = cur;
  }
  assertEqual(r.liftOffsetOf(0), 0, '约 1 秒后应收敛到 0');
  assertEqual(r.renderYOf(0), 11, '收敛后渲染 y 应等于物理 y');
  r.dispose();
});

test('焰魔渲染: 下落 → 偏移立即清零（不叠缓动）', async () => {
  const d = await getAsset();
  const r = new IgnisRenderer(new THREE.Scene(), d);
  r.sync([ignisAt(10)], 0);
  r.sync([ignisAt(11)], 16);
  assertTrue(r.liftOffsetOf(0) < 0, '前置：先欠下一段偏移');
  r.sync([ignisAt(10.5)], 32);       // 下落
  assertEqual(r.liftOffsetOf(0), 0, '下落应立即清零（下台阶的动画本来就来自重力）');
  assertEqual(r.renderYOf(0), 10.5);
  r.dispose();
});

test('焰魔渲染: 缓动偏移写进了 pivot 矩阵（不是只算不用）', async () => {
  // ⚠️ 这条守的是「算对了但没写进矩阵」的形态（v1.48 玩家晃动踩过：断言内部量时
  // 注入「算对但不写相机」仍全绿）。故直接读 three 节点的 position。
  const d = await getAsset();
  const r = new IgnisRenderer(new THREE.Scene(), d);
  r.sync([ignisAt(10)], 0);
  r.sync([ignisAt(11)], 16);
  const off = r.liftOffsetOf(0);
  assertTrue(off < 0, '前置：应有负偏移');
  const pivotY = r.instances[0].pivot.position.y;
  assertTrue(Math.abs(pivotY - (11 + off)) < 1e-9,
    `pivot.position.y=${pivotY.toFixed(4)} 应等于 physY+offset=${(11 + off).toFixed(4)}`);
  r.dispose();
});

test('焰魔渲染: 多实例的缓动互不干扰（逐实例独立 StepLift）', async () => {
  const d = await getAsset();
  const r = new IgnisRenderer(new THREE.Scene(), d);
  r.sync([ignisAt(10), { ...ignisAt(20), id: 'b' }], 0);
  r.sync([ignisAt(11), { ...ignisAt(20), id: 'b' }], 16);   // 只第 0 只上台阶
  assertTrue(r.liftOffsetOf(0) < 0, '第 0 只应有偏移');
  assertEqual(r.liftOffsetOf(1), 0, '第 1 只不应被干扰（共享一份 StepLift 会互相打断）');
  r.dispose();
});

test('焰魔渲染: 实例复用给新实体时重置缓动（不把出生当成上台阶，v2.62 修复 P1-2）', async () => {
  // ⚠️ **这条守的是 final review P1-2 的真缺陷**：`prevY` 只在 `_makeInstance()`（构造期）
  // 设一次，而 `sync` 按 list 下标分配实例、隐藏时不清 `prevY/lift.offset`。
  // 于是：焰魔 A 在 y=10 死亡 → 实例隐藏、`prevY=10` 留存 → 在高原重召（y=46）→
  // `_advanceLift` 走分支②，`dy=36 > epsilon` ⇒ `trigger(36)` ⇒ 新焰魔出生头 ~190ms
  // 渲染在 y=45（陷进地面 1 格）再 ease 上来。
  // 丧尸侧没有这个问题：`acquireSlot` 每次 spawn 都重建 pose（`prevY: null`）。
  const d = await getAsset();
  const r = new IgnisRenderer(new THREE.Scene(), d);
  // 第 1 只：id='a'，y=10，走几帧让 prevY 稳定在 10
  r.sync([{ id: 'a', state: ignisAt(10).state }], 0);
  r.sync([{ id: 'a', state: ignisAt(10).state }], 16);
  // 第 1 只死亡（list 变空）→ 实例 0 隐藏，但 prevY 残留
  r.sync([], 32);
  // 第 2 只：id='b'，y=46（高原重召）—— 若 prevY 没重置，会 trigger(36)
  r.sync([{ id: 'b', state: ignisAt(46).state }], 48);
  assertEqual(r.liftOffsetOf(0), 0,
    '新实体出生不应继承上一只的 prevY（否则陷进地面 1 格再 ease 上来）');
  assertEqual(r.renderYOf(0), 46, '新实体出生当帧渲染 y 应直接等于物理 y');
  r.dispose();
});

// ==================== 姿态衔接（v2.76，用户缺陷：旋斩起手一帧硬切）====================
//
// 用户 2026-11-07（录像「焰魔旋转.mov」1.13s）：「身体本来是站定的，突然就切换到身体旋转举刀的
// 形态了，中间没有补间过渡 …… 我要求有一个过渡动画，不要闪动切过去，导致的身体动作不连贯」。
//
// ## 根因（实测，不是目测）
//
// 逐帧抽录像：n=9（t=1.117s）站定，n=10（t=1.133s）已是旋斩起手姿态 —— **相邻两帧（16.7ms）整副
// 骨架跳变**。渲染器按 `attackAnimT > 0` 在 idle 与攻击片段之间硬切，没有任何混合状态。
// 旋斩的 t=0 姿态（root.y −75° / sword.x 180° / upperbody.y −37.5° …）本是原版 `SPIN_ATTACK` 的
// 衔接姿态：原版它的第一个关键帧是 `startKeyframe(0)`（瞬间到位），且**只会**由
// `HORIZONTAL_SMALL_SWING_ALT_ATTACK2` 在 `follow_through_tick` 且 `CanSpin >= 2` 时接上
//（`Ignis_Entity.java:2297`），从不从站立起手；本仓按用户裁定「每次起手按权重随机」让它从站立直接起手。
// 真实烘焙产物实测：idle → spin(t=1/60) 单帧最大骨骼角 **177.1°**（sword），而旋斩自身最快的合法
// 单帧只有 **24.5°**（root，快旋段）。挥砍首帧本就是静止姿态（5.0°），所以只有旋斩暴露。
//
// ## 判据口径
//
// 「没有跳变」= **发布出去的**骨骼四元数（`instances[i].bones[j].quaternion`，真正进矩阵的那份）
// 相邻帧的最大转角 ≤ **该片段自身合法的最快单帧**。阈值由片段数据现算（`clipMaxStepDeg`），不写死
// 魔数，重烘焙后不会悄悄失效。每条都配「硬切换确实 >100°」的判别力自检（只钉「变小」抓不到
// 「数据变了、根本没有跳变」的退化）。

const IDENT_Q = [0, 0, 0, 1];
const IGNIS_BASE = { position: [0, 0, 0], yaw: 0, health: 450, flashedUntil: 0, attackCooldown: 0 };

/**
 * 两个四元数的转角（度）= 相对旋转 `conj(a) * b` 的转角。
 *
 * ⚠️ **不能写成 `2·acos(|dot|)`**：`acos` 在 1 附近病态 —— 两个**完全相同**、但长度为 `1−1e-16`
 * 的四元数会得到约 1.7e-6° 的「假差异」，把「逐位相同」类断言（阈值 1e-9°）判红（实测踩到：
 * 多实例用例在旧代码第 0 帧就红，而页面里读出的两份姿态 `|dot|=1`、逐位无差）。
 * `2·atan2(|r.xyz|, |r.w|)` 在近零角良态（相同输入 ⇒ `r.xyz` 精确为 0）。
 * ⚠️ 取 `|r.w|`：q 与 −q 是同一旋转，不取绝对值会把符号翻转当成 360° 跳变。
 */
function quatAngleDeg(a, b) {
  const rw = a[3] * b[3] + a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const rx = a[3] * b[0] - a[0] * b[3] - a[1] * b[2] + a[2] * b[1];
  const ry = a[3] * b[1] + a[0] * b[2] - a[1] * b[3] - a[2] * b[0];
  const rz = a[3] * b[2] - a[0] * b[1] + a[1] * b[0] - a[2] * b[3];
  return (2 * Math.atan2(Math.hypot(rx, ry, rz), Math.abs(rw)) * 180) / Math.PI;
}

/** 两个姿态（boneIndex → {rot,pos}）逐骨骼取最大转角（度）；骨骼集合取并集，缺失 = 单位增量 */
function poseStepDeg(p, q) {
  let max = 0;
  for (const k of new Set([...p.keys(), ...q.keys()])) {
    max = Math.max(max, quatAngleDeg(p.get(k)?.rot ?? IDENT_Q, q.get(k)?.rot ?? IDENT_Q));
  }
  return max;
}

/** 两份骨骼四元数快照（`bones.map(b => b.quaternion.toArray())`）逐骨骼取最大转角（度） */
function boneStepDeg(a, b) {
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, quatAngleDeg(a[i], b[i]));
  return max;
}

/** 绕 Y 轴转 `deg` 度的增量（合成数据，用来精确断言混合数学） */
function rotY(deg, pos = [0, 0, 0]) {
  const h = (deg * Math.PI) / 360;
  return { rot: [0, Math.sin(h), 0, Math.cos(h)], pos };
}

/** 一个动画片段自身最快的相邻帧（1/60s）骨骼转角 —— 「合法的快动作」上限（旋斩实测 24.5°） */
function clipMaxStepDeg(anim) {
  const dt = 1 / 60;
  const dur = anim.frameCount / anim.fps;
  let max = 0;
  for (let t = 0; t + dt <= dur; t += dt) {
    max = Math.max(max, poseStepDeg(sampleIgnisAttack(anim, t), sampleIgnisAttack(anim, t + dt)));
  }
  return max;
}

/** 「bind × 采样增量」= 渲染器发布的骨骼四元数应有的值（未被该采样驱动的骨骼 = bind） */
function expectedBones(d, sampled) {
  return d.bones.map((b, i) => {
    const q = new THREE.Quaternion(...b.bindQuaternion);
    const delta = sampled.get(i);
    if (delta) q.multiply(new THREE.Quaternion(...delta.rot));
    return q.toArray();
  });
}

/**
 * 与 `IgnisRenderer` 同一条路径（`IgnisPoseTransition`，key 约定同渲染器）模拟：
 * idle 站稳 1s → 起手播 `clipKey` 片段（60fps）。返回逐帧姿态，首项 = 起手前最后一帧 idle。
 */
function simulateEntry(d, clipKey, idlePhase, frames) {
  const tr = new IgnisPoseTransition(IGNIS_POSE_BLEND.seconds);
  const dt = 1 / 60;
  let t = idlePhase;
  let out = null;
  for (let i = 0; i < 60; i++) {
    t += dt;
    out = tr.step('idle', sampleIgnisAnim(d.animations.idle, t), dt);
  }
  const seq = [out];
  for (let k = 1; k <= frames; k++) {
    seq.push(tr.step(clipKey, sampleIgnisAttack(d.animations[clipKey], k * dt), dt));
  }
  return seq;
}

// ---------- 混合数学（合成数据，精确断言） ----------

test('焰魔姿态衔接(v2.76): blendIgnisPose 端点精确，骨骼集合取并集（缺失一侧 = 单位增量），不改入参', () => {
  const frozen = (m) => {
    for (const v of m.values()) { Object.freeze(v.rot); Object.freeze(v.pos); Object.freeze(v); }
    return m;
  };
  const a = frozen(new Map([[1, rotY(40, [0.2, 0, 0])], [2, rotY(90)]]));                 // 骨骼 2 只有 a 驱动
  const b = frozen(new Map([[1, rotY(-20, [0, 0.4, 0])], [3, rotY(60, [0, 0, 0.6])]]));   // 骨骼 3 只有 b 驱动
  const at0 = blendIgnisPose(a, b, 0);
  const at1 = blendIgnisPose(a, b, 1);
  assertEqual([...at0.keys()].sort().join(), '1,2,3', '骨骼集合应取并集');
  assertEqual([...at1.keys()].sort().join(), '1,2,3', '骨骼集合应取并集');
  // w=0 → a：公共骨骼 = a；a 独有 = a；b 独有 = 单位增量
  assertTrue(quatAngleDeg(at0.get(1).rot, a.get(1).rot) < 1e-6);
  assertEqual(at0.get(1).pos[0], 0.2);
  assertTrue(quatAngleDeg(at0.get(2).rot, a.get(2).rot) < 1e-6);
  assertTrue(quatAngleDeg(at0.get(3).rot, IDENT_Q) < 1e-6, 'b 独有的骨骼在 w=0 应是单位增量');
  // w=1 → b：公共骨骼 = b；b 独有 = b；a 独有 = 单位增量（回到 bind）
  assertTrue(quatAngleDeg(at1.get(1).rot, b.get(1).rot) < 1e-6);
  assertEqual(at1.get(1).pos[1], 0.4);
  assertTrue(quatAngleDeg(at1.get(3).rot, b.get(3).rot) < 1e-6);
  assertTrue(quatAngleDeg(at1.get(2).rot, IDENT_Q) < 1e-6,
    'a 独有的骨骼在 w=1 必须回到单位增量（否则它会卡在中途姿态）');
  // 越界 / NaN 权重不得产生 NaN
  for (const w of [-1, 2, NaN]) {
    for (const v of blendIgnisPose(a, b, w).values()) {
      assertTrue(v.rot.every(Number.isFinite) && v.pos.every(Number.isFinite), `w=${w} 产生了 NaN`);
    }
  }
  // 返回值不与入参共享数组（入参已冻结：实现若原地改写会直接抛）
  assertTrue(at0.get(1).rot !== a.get(1).rot && at1.get(1).rot !== b.get(1).rot, '返回值不应与入参共享数组');
});

test('焰魔姿态衔接(v2.76): blendIgnisPose 中点各取一半，且走最短弧（q 与 −q 是同一旋转）', () => {
  const half = blendIgnisPose(new Map([[2, rotY(90)]]), new Map([[3, rotY(60, [0, 0, 0.6])]]), 0.5);
  assertTrue(Math.abs(quatAngleDeg(half.get(2).rot, IDENT_Q) - 45) < 1e-6, 'a 独有骨骼 w=0.5 应转一半（45°）');
  assertTrue(Math.abs(quatAngleDeg(half.get(3).rot, IDENT_Q) - 30) < 1e-6, 'b 独有骨骼 w=0.5 应转一半（30°）');
  assertTrue(Math.abs(half.get(3).pos[2] - 0.3) < 1e-12, '位移按线性取一半');
  // 最短弧：−q 与 q 是同一旋转，混合结果必须仍是它（走长弧会绕远路 / 退化成零四元数）
  const q = rotY(80);
  const m = blendIgnisPose(new Map([[1, q]]), new Map([[1, { rot: q.rot.map((v) => -v), pos: [0, 0, 0] }]]), 0.5);
  assertTrue(quatAngleDeg(m.get(1).rot, q.rot) < 1e-6, 'q 与 −q 混合应仍是同一旋转');
  assertTrue(Math.abs(Math.hypot(...m.get(1).rot) - 1) < 1e-9, '混合结果必须是单位四元数');
});

// ---------- 过渡器语义（合成数据） ----------

test('焰魔姿态衔接(v2.76): 首帧直接发布目标；同源稳态逐帧等于目标（无残留）', () => {
  const tr = new IgnisPoseTransition(0.2);
  const o0 = tr.step('idle', new Map([[1, rotY(30)]]), 0);
  assertTrue(quatAngleDeg(o0.get(1).rot, rotY(30).rot) < 1e-9, '首帧没有「上一帧」可衔接，应直接发布目标');
  for (let i = 1; i <= 5; i++) {
    const o = tr.step('idle', new Map([[1, rotY(30 + i)]]), 1 / 60);
    assertTrue(quatAngleDeg(o.get(1).rot, rotY(30 + i).rot) < 1e-9, `同源稳态第 ${i} 帧应等于目标`);
  }
});

test('焰魔姿态衔接(v2.76): 切换当帧从「上一帧实际发布的姿态」起步（dt=0 ⇒ 权重 0，不闪到目标）', () => {
  const tr = new IgnisPoseTransition(0.2);
  tr.step('idle', new Map([[1, rotY(10)]]), 0);
  const o = tr.step('spin', new Map([[1, rotY(170)], [2, rotY(90)]]), 0);
  assertTrue(quatAngleDeg(o.get(1).rot, rotY(10).rot) < 1e-9,
    'dt=0 的切换帧应仍是起点（硬切换会在这里直接给出 170°）');
  assertTrue(quatAngleDeg(o.get(2).rot, IDENT_Q) < 1e-9, '目标独有的骨骼应从单位增量起步');
});

test('焰魔姿态衔接(v2.76): 淡入中点 = 50% 混合（smoothstep(0.5)=0.5），走满时长后精确等于目标', () => {
  const tr = new IgnisPoseTransition(0.2);
  tr.step('idle', new Map([[1, rotY(0)]]), 0);
  const target = () => new Map([[1, rotY(90)]]);
  let o;
  for (let i = 0; i < 6; i++) o = tr.step('spin', target(), 0.1 / 6);          // 走到 0.1s（一半）
  const mid = quatAngleDeg(o.get(1).rot, IDENT_Q);
  assertTrue(Math.abs(mid - 45) < 1e-6, `淡入中点转角应为 45°（smoothstep(0.5)=0.5），实为 ${mid.toFixed(4)}°`);
  for (let i = 0; i < 7; i++) o = tr.step('spin', target(), 0.1 / 6);          // 再走满（多 1 帧吸收浮点累加）
  assertTrue(quatAngleDeg(o.get(1).rot, rotY(90).rot) < 1e-9, '走满淡入时长后应精确等于目标');
});

test('焰魔姿态衔接(v2.76): 起步缓入、收尾缓出（两端权重斜率为 0，不是线性）', () => {
  // 线性权重在两端有速度突变：起步第 1 帧就走 1/12 全程，等于换了个形态的「闪一下」。
  // 总转角 90°、0.2s（12 帧@60fps）：smoothstep 第 1 帧 = 0.0197×90 ≈ 1.8°（线性 7.5°）；
  // 走满前最后一帧的剩余同理 ≈ 1.8°（线性 7.5°）。阈值 3° 夹在两者之间。
  const tr = new IgnisPoseTransition(0.2);
  tr.step('idle', new Map([[1, rotY(0)]]), 0);
  const dt = 1 / 60;
  const angles = [];
  for (let i = 0; i < 12; i++) {
    const o = tr.step('spin', new Map([[1, rotY(90)]]), dt);
    angles.push(quatAngleDeg(o.get(1).rot, IDENT_Q));
  }
  assertTrue(angles[0] < 3, `起步第 1 帧已走 ${angles[0].toFixed(2)}°（线性权重为 7.5°；应缓入 <3°）`);
  const remain = 90 - angles[10];
  assertTrue(remain < 3, `走满前最后一帧距目标还差 ${remain.toFixed(2)}°（线性为 7.5°；应缓出 <3°）`);
  assertTrue(Math.abs(angles[11] - 90) < 1e-6, '第 12 帧（elapsed = 0.2s）应精确到达目标');
});

test('焰魔姿态衔接(v2.76): 起点驱动而目标不驱动的骨骼，离开输出前必须先以单位增量发布一次', () => {
  // 渲染器只写「本帧输出里有的骨骼」。某骨骼（如旋斩独有的 sword）若在淡入结束时直接从输出里消失，
  // 它会永远停在淡入中途的姿态。不变式：骨骼离开输出的前一帧，其增量必须是单位增量。
  const tr = new IgnisPoseTransition(0.2);
  tr.step('spin', new Map([[1, rotY(40)], [9, rotY(112)]]), 0);                // 9 = sword，只被 spin 驱动
  let prev = null;
  let leftAt = -1;
  for (let i = 0; i < 12; i++) {
    // ⚠️ 0.03s 一帧，**不能用 1/60**：1/60 连加 12 次是 0.19999999999999998（<0.2），「走满」被推迟一帧，
    // 而上一帧权重已是 1−1e-16、残留仅 ~1e-14° —— 把「走满帧丢掉并集」的注入藏了起来（负向验证实测：
    // 注入后本用例仍绿）。0.03s 时第 6 帧（0.21s）越线，上一帧权重 0.972、残留约 3°。
    const o = tr.step('idle', new Map([[1, rotY(5)]]), 0.03);
    if (prev && prev.has(9) && !o.has(9)) {
      leftAt = i;
      const off = quatAngleDeg(prev.get(9).rot, IDENT_Q);
      assertTrue(off < 1e-9, `骨骼 9 在第 ${i} 帧离开输出，但上一帧仍带 ${off.toFixed(2)}° 偏转（会永远卡在这个姿态）`);
    }
    prev = o;
  }
  assertTrue(leftAt > 0, '淡入走满后骨骼 9 应已离开输出（目标不驱动它）');
});

test('焰魔姿态衔接(v2.76): 淡入被打断时从「当前混合输出」重新起步（不跳回旧起点，也不跳到新目标）', () => {
  const tr = new IgnisPoseTransition(0.2);
  tr.step('idle', new Map([[1, rotY(0)]]), 0);
  let o;
  for (let i = 0; i < 6; i++) o = tr.step('spin', new Map([[1, rotY(90)]]), 0.1 / 6);   // 半程 ≈ 45°
  const mid = o.get(1).rot;
  const o2 = tr.step('idle', new Map([[1, rotY(0)]]), 0);                              // 此刻被打断
  assertTrue(quatAngleDeg(o2.get(1).rot, mid) < 1e-9,
    '被打断的切换帧应与上一帧输出连续（跳回 0° 或跳到 90° 都是新的硬切换）');
});

test('焰魔姿态衔接(v2.76): 超长帧（dt ≥ 淡入时长）直接发布目标；reset() 后首帧直接发布目标', () => {
  const tr = new IgnisPoseTransition(0.2);
  tr.step('idle', new Map([[1, rotY(0)]]), 0);
  const big = tr.step('spin', new Map([[1, rotY(90)]]), 10);                           // 切后台 10 秒回来
  assertTrue(quatAngleDeg(big.get(1).rot, rotY(90).rot) < 1e-9, '超长帧不应再从陈旧起点淡入');
  tr.reset();
  const first = tr.step('idle', new Map([[1, rotY(33)]]), 0);
  assertTrue(quatAngleDeg(first.get(1).rot, rotY(33).rot) < 1e-9, 'reset() 后首帧不得从上一实体的姿态淡入');
});

// ---------- 真实烘焙产物上的判据（用户缺陷本体 + 参数的两侧界限） ----------

test('焰魔姿态衔接(v2.76，用户缺陷): 站定 → 旋斩起手，补间期单帧骨骼角不超过旋斩自身合法上限（硬切换 177°）', async () => {
  const d = await getAsset();
  const limit = clipMaxStepDeg(d.animations.spin);                                 // 实测 24.5°
  const period = d.animations.idle.frameCount / d.animations.idle.fps;
  let worst = 0;
  let hardWorst = 0;
  for (let i = 0; i < 8; i++) {                                                    // 8 档 idle 相位取最坏
    const seq = simulateEntry(d, 'spin', (i / 8) * period, Math.ceil(IGNIS_POSE_BLEND.seconds * 60) + 6);
    for (let k = 1; k < seq.length; k++) worst = Math.max(worst, poseStepDeg(seq[k - 1], seq[k]));
    hardWorst = Math.max(hardWorst, poseStepDeg(seq[0], sampleIgnisAttack(d.animations.spin, 1 / 60)));
  }
  assertTrue(hardWorst > 100,
    `判别力自检：硬切换的单帧跳变应 >100°（实测 177°），实为 ${hardWorst.toFixed(1)}° —— 数据变了则本用例失去意义`);
  assertTrue(worst <= limit,
    `站定→旋斩补间期单帧最大骨骼角 ${worst.toFixed(1)}° 超过旋斩自身合法上限 ${limit.toFixed(1)}°（硬切换 ${hardWorst.toFixed(0)}°）`);
});

test('焰魔姿态衔接(v2.76): 站定 → 挥砍起手同样平滑（挥砍首帧本是静止姿态，补间不能把它变糟）', async () => {
  const d = await getAsset();
  const limit = clipMaxStepDeg(d.animations.attack);                               // 实测 12.6°
  const period = d.animations.idle.frameCount / d.animations.idle.fps;
  let worst = 0;
  for (let i = 0; i < 8; i++) {
    const seq = simulateEntry(d, 'attack', (i / 8) * period, Math.ceil(IGNIS_POSE_BLEND.seconds * 60) + 6);
    for (let k = 1; k < seq.length; k++) worst = Math.max(worst, poseStepDeg(seq[k - 1], seq[k]));
  }
  assertTrue(worst <= limit, `挥砍入场补间单帧最大骨骼角 ${worst.toFixed(1)}° 超过合法上限 ${limit.toFixed(1)}°`);
});

test('焰魔姿态衔接(v2.76): 攻击片段播完 → 回 idle 同样淡出（离场单帧角 <2°，而硬切换 >4°）', async () => {
  const d = await getAsset();
  const dt = 1 / 60;
  const period = d.animations.idle.frameCount / d.animations.idle.fps;
  for (const key of ['attack', 'spin']) {
    let worst = 0;
    let hardWorst = 0;
    for (let i = 0; i < 8; i++) {
      const phase = (i / 8) * period;
      const tr = new IgnisPoseTransition(IGNIS_POSE_BLEND.seconds);
      let out = tr.step(key, sampleIgnisAttack(d.animations[key], 99), 0);         // 播完停末帧
      const seq = [out];
      for (let k = 1; k <= 20; k++) {
        out = tr.step('idle', sampleIgnisAnim(d.animations.idle, phase + k * dt), dt);
        seq.push(out);
      }
      for (let k = 1; k < seq.length; k++) worst = Math.max(worst, poseStepDeg(seq[k - 1], seq[k]));
      hardWorst = Math.max(hardWorst, poseStepDeg(seq[0], sampleIgnisAnim(d.animations.idle, phase + dt)));
    }
    // 实测（2026-11-07）：硬切换 swing 5.28° / spin 5.98°；淡出后最坏单帧 0.64° / 0.73°
    assertTrue(hardWorst > 4, `判别力自检（${key}）：硬切换离场应 >4°，实为 ${hardWorst.toFixed(2)}°`);
    assertTrue(worst < 2, `${key} 离场淡出单帧最大骨骼角 ${worst.toFixed(2)}° 应 <2°`);
  }
});

test('焰魔姿态衔接(v2.76): 淡入时长上界 —— 淡入结束时旋斩的「举刀」仍抬着（不把蓄力吃掉）', async () => {
  // 下界（补间单帧角 ≤ 片段合法上限）由上面的入场用例钉；这里钉上界。
  // 旋斩起手 sword 绕 X 的角随 t 缓降：0.20s=112°、0.25s=90°、0.50s=0°。
  const d = await getAsset();
  const swordIdx = d.bones.findIndex((b) => b.name === 'sword');
  const atEnd = sampleIgnisAttack(d.animations.spin, IGNIS_POSE_BLEND.seconds).get(swordIdx);
  const deg = quatAngleDeg(atEnd.rot, IDENT_Q);
  assertTrue(deg >= 90,
    `淡入结束（t=${IGNIS_POSE_BLEND.seconds}s）时旋斩的 sword 已落到 ${deg.toFixed(0)}°（<90°）`
    + ' —— 观感是「还没举起来就开始转」');
});

// ---------- 真实渲染器：发布到骨骼上的结果 ----------

test('焰魔姿态衔接(v2.76，用户缺陷·渲染器级): 真实 sync 序列 站定 → 旋斩，发布的骨骼无单帧跳变且最终收敛到片段姿态', async () => {
  // ⚠️ 直接读 `bones[i].quaternion`（真正进蒙皮矩阵的那份），不读过渡器内部量：
  // 「算对了但没写进骨骼」是上台阶缓动踩过的形态（v1.48 玩家晃动同款）。
  const d = await getAsset();
  const r = new IgnisRenderer(new THREE.Scene(), d);
  const limit = clipMaxStepDeg(d.animations.spin);
  const frames = [];
  let ms = 0;
  for (let i = 0; i < 60; i++) {                                    // 站定 1s（idleTime 随时间累加，与 Agent 同口径）
    ms += FRAME_MS;
    r.sync([{ id: 'a', state: { ...IGNIS_BASE, attackAnimT: 0, idleTime: ms / 1000 } }], ms);
    frames.push(r.instances[0].bones.map((b) => b.quaternion.toArray()));
  }
  const N = 30;                                                     // 起手 0.5s（Agent 起手当帧 attackAnimT = step > 0）
  for (let k = 1; k <= N; k++) {
    ms += FRAME_MS;
    r.sync([{ id: 'a', state: { ...IGNIS_BASE, attackKind: 'spin', attackAnimT: k / 60, idleTime: ms / 1000 } }], ms);
    frames.push(r.instances[0].bones.map((b) => b.quaternion.toArray()));
  }
  // 判别力自检：硬切换 = 站定末帧 vs 纯旋斩首帧（真实 bind × 采样）
  const hard = boneStepDeg(frames[59], expectedBones(d, sampleIgnisAttack(d.animations.spin, 1 / 60)));
  assertTrue(hard > 100, `判别力自检：硬切换应 >100°（实测 177°），实为 ${hard.toFixed(1)}°`);
  let worst = 0;
  for (let i = 1; i < frames.length; i++) worst = Math.max(worst, boneStepDeg(frames[i - 1], frames[i]));
  assertTrue(worst <= limit,
    `发布到骨骼上的相邻帧最大转角 ${worst.toFixed(1)}° 超过旋斩自身合法上限 ${limit.toFixed(1)}°`
    + `（硬切换 ${hard.toFixed(0)}°）—— 站定 → 旋斩起手仍是一帧跳变`);
  // 收敛：淡入走满后发布的骨骼 = bind × 片段采样（没有残留的混合）
  const want = expectedBones(d, sampleIgnisAttack(d.animations.spin, N / 60));
  assertTrue(boneStepDeg(frames[frames.length - 1], want) < 1e-6, '淡入走满后骨骼应精确等于旋斩片段的姿态');
  r.dispose();
});

test('焰魔姿态衔接(v2.76): 攻击被中断（attackAnimT 清零）后，只被攻击片段驱动的骨骼回到 bind（不卡在中途姿态）', async () => {
  // 既有缺陷：渲染器只写「当前来源驱动的骨骼」，而 idle 只驱动 6 根。旋斩播到一半被打断
  //（LOS 丢失 / 玩家跑出 disengageRange ⇒ Agent 把 attackAnimT 清零）后，
  // sword / upperbody / … 会永远停在中途姿态，直到下一次攻击。
  const d = await getAsset();
  const r = new IgnisRenderer(new THREE.Scene(), d);
  const idleSet = new Set(d.animations.idle.boneIndices);
  const only = d.animations.spin.boneIndices.filter((b) => !idleSet.has(b));
  const swordIdx = d.bones.findIndex((b) => b.name === 'sword');
  assertTrue(only.includes(swordIdx) && only.length >= 4, '前提：旋斩驱动了 idle 不驱动的骨骼（含 sword）');

  let ms = 0;
  for (let k = 1; k <= 12; k++) {                                   // 旋斩播到 0.2s（sword=112°），然后被打断
    ms += FRAME_MS;
    r.sync([{ id: 'a', state: { ...IGNIS_BASE, attackKind: 'spin', attackAnimT: k / 60, idleTime: 0 } }], ms);
  }
  const midOff = quatAngleDeg(r.instances[0].bones[swordIdx].quaternion.toArray(), d.bones[swordIdx].bindQuaternion);
  assertTrue(midOff > 30, `前提：被打断前 sword 应已离开 bind（实为 ${midOff.toFixed(1)}°）`);

  for (let i = 0; i < Math.ceil(IGNIS_POSE_BLEND.seconds * 60) + 3; i++) {
    ms += FRAME_MS;
    r.sync([{ id: 'a', state: { ...IGNIS_BASE, attackAnimT: 0, idleTime: 0 } }], ms);
  }
  for (const bi of only) {
    const off = quatAngleDeg(r.instances[0].bones[bi].quaternion.toArray(), d.bones[bi].bindQuaternion);
    assertTrue(off < 1e-4, `${d.bones[bi].name} 打断后仍偏离 bind ${off.toFixed(2)}°（卡在中途姿态）`);
  }
  r.dispose();
});

test('焰魔姿态衔接(v2.76): 实例复用给新实体时整副骨架回到起点（不从上一只的姿态淡出，也不残留它的姿态）', async () => {
  // 与 v2.62 P1-2（`prevY/lift` 在复用时必须重置）同一类缺陷：实例按 list 下标复用、隐藏时不清状态。
  const d = await getAsset();
  const r = new IgnisRenderer(new THREE.Scene(), d);
  let ms = 0;
  for (let k = 1; k <= 12; k++) {
    ms += FRAME_MS;
    r.sync([{ id: 'a', state: { ...IGNIS_BASE, attackKind: 'spin', attackAnimT: k / 60, idleTime: 0 } }], ms);
  }
  // a 死于旋斩中途 → 实例 0 被新实体 b 复用：b 的第一帧必须是它自己的 idle 姿态
  ms += FRAME_MS;
  r.sync([{ id: 'b', state: { ...IGNIS_BASE, attackAnimT: 0, idleTime: 0.3 } }], ms);
  const got = r.instances[0].bones.map((b) => b.quaternion.toArray());
  const want = expectedBones(d, sampleIgnisAnim(d.animations.idle, 0.3));
  const off = boneStepDeg(got, want);
  assertTrue(off < 1e-6, `新实体首帧与它自己的 idle 姿态相差 ${off.toFixed(2)}°（残留了上一只的旋斩姿态）`);
  r.dispose();
});

test('焰魔姿态衔接(v2.76): 多实例的衔接互不干扰（逐实例独立，不共享过渡状态）', async () => {
  const d = await getAsset();
  const solo = new IgnisRenderer(new THREE.Scene(), d);            // 参照：只有 b，一直站着
  const pair = new IgnisRenderer(new THREE.Scene(), d);            // a 起手旋斩、b 一直站着
  let ms = 0;
  for (let k = 0; k < 90; k++) {
    ms += FRAME_MS;
    const b = { id: 'b', state: { ...IGNIS_BASE, attackAnimT: 0, idleTime: ms / 1000 } };
    const a = {
      id: 'a',
      state: {
        ...IGNIS_BASE, attackKind: 'spin', idleTime: ms / 1000,
        attackAnimT: k < 30 ? 0 : (k - 29) / 60,
      },
    };
    solo.sync([b], ms);
    pair.sync([a, b], ms);
    // b 在 pair 里是实例 1、在 solo 里是实例 0：逐位相同
    const x = solo.instances[0].bones.map((q) => q.quaternion.toArray());
    const y = pair.instances[1].bones.map((q) => q.quaternion.toArray());
    assertTrue(boneStepDeg(x, y) < 1e-9, `第 ${k} 帧 b 的姿态被 a 的衔接干扰了`);
  }
  solo.dispose();
  pair.dispose();
});
