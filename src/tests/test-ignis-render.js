// src/tests/test-ignis-render.js — 焰魔渲染器（v2.55）
//
// 覆盖：实例池契约（容量/共享几何/独立材质与骨骼）、脚底补偿、动画选择（idle ↔ attack）、
// 红闪、无实体时隐藏。
//
// 与飞龙渲染器（`test-dragon-render.js`）的差异只测三处：
//   ① 池容量 = IGNIS.maxAlive(2)；
//   ② mesh 的 y 偏移多一个「脚底补偿」（模型最低顶点在 −0.3042 格）；
//   ③ 动画由 `attackAnimT > 0` 选择（飞龙是内部状态机）。
import * as THREE from 'three';
import { test } from './runner.js';
import { assertEqual, assertTrue, assertNotNull } from './assert.js';
import { IgnisRenderer } from '../render/ignis-renderer.js';
import { sampleIgnisAnim, sampleIgnisAttack, loadIgnisAsset } from '../render/ignis-model.js';
import { IGNIS } from '../entities/ignis/ignis-config.js';

let asset = null;
async function getAsset() {
  if (asset) return asset;
  asset = await loadIgnisAsset();
  return asset;
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

  r.sync([{ id: 'a', state: { ...base, attackAnimT: 0.5 } }], 0);
  const attackPose = r.instances[0].bones.map((b) => b.quaternion.toArray());

  let diff = 0;
  for (let i = 0; i < idlePose.length; i++) {
    for (let k = 0; k < 4; k++) diff += Math.abs(idlePose[i][k] - attackPose[i][k]);
  }
  assertTrue(diff > 0.05, `idle 与 attack 姿态差异 ${diff.toFixed(5)}（应明显不同）`);
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

  // ② 挥到一半（约 1.0s，胳膊抬到最高）
  r.sync([{ id: 'a', state: { ...base, attackAnimT: 1.0 } }], 0);
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
