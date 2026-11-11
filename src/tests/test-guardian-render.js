// src/tests/test-guardian-render.js — 末影守卫渲染层（Tier 1 采样/衔接 + Tier 2 装配）
//
// 覆盖：产物装载、采样（循环 / 播完停末帧 / move 平移通道）、姿态衔接、
// **口径 A 的骨骼位置公式**（与焰魔不同，本文件最关键的判别用例）、脚底对齐、实例池。
import * as THREE from 'three';
import { test } from './runner.js';
import { assertEqual, assertTrue, assertNotNull } from './assert.js';
import {
  loadGuardianAsset, GUARDIAN_DEATH_COLOR, slerpQuat, multiplyQuat,
  sampleGuardianAnim, sampleGuardianAttack, blendGuardianPose, GuardianPoseTransition,
} from '../render/guardian-model.js';
import { GuardianRenderer } from '../render/guardian-renderer.js';
import {
  GUARDIAN, GUARDIAN_ATTACKS, GUARDIAN_ATTACK_IDS, GUARDIAN_POSE_BLEND, guardianBlendSeconds,
} from '../entities/guardian/guardian-config.js';

/** 造一条挂在守卫上的 entity（脚底 y=10） */
function ent(over = {}) {
  return {
    id: 'guardian:rc:0:0',
    type: 'guardian',
    state: {
      position: [0, 10, 0], velocity: [0, 0, 0], yaw: 0,
      health: GUARDIAN.health, flashedUntil: 0,
      mode: 'idle', attackAnimT: 0, attackKind: null, idleTime: 0,
      ...over,
    },
  };
}

// ==================== 产物装载 ====================

test('守卫渲染: loadGuardianAsset 能取到产物且形状正确', async () => {
  const d = await loadGuardianAsset();
  assertNotNull(d);
  assertEqual(d.bones.length, 20, '骨骼数');
  assertEqual(d.metrics.vertexCount, 576, '顶点数');
  assertEqual(d.metrics.indexCount, 864, '索引数');
  assertEqual(JSON.stringify(Object.keys(d.animations).sort()),
    JSON.stringify([...GUARDIAN_ATTACK_IDS].sort()), '四条攻击片段');
  for (const k of GUARDIAN_ATTACK_IDS) {
    assertEqual(d.animations[k].frameCount, Math.round(GUARDIAN_ATTACKS[k].animSeconds * 20),
      `${k} 帧数 = animSeconds × 20`);
    assertEqual(d.animations[k].fps, 20, `${k} fps`);
  }
});

test('守卫渲染: 死亡爆散基色是眼睛层主色归一化（守卫主题紫）', () => {
  // 眼睛层主色 (161,83,254) ⇒ 归一化 [0.63, 0.33, 1.0]
  assertEqual(GUARDIAN_DEATH_COLOR.length, 3);
  assertTrue(Math.abs(GUARDIAN_DEATH_COLOR[0] - 161 / 255) < 0.01, 'R ≈ 161/255');
  assertTrue(Math.abs(GUARDIAN_DEATH_COLOR[1] - 83 / 255) < 0.01, 'G ≈ 83/255');
  assertTrue(Math.abs(GUARDIAN_DEATH_COLOR[2] - 254 / 255) < 0.01, 'B ≈ 254/255');
  assertTrue(GUARDIAN_DEATH_COLOR[2] > GUARDIAN_DEATH_COLOR[0], '紫：B > R');
});

// ==================== 四元数工具 ====================

test('守卫渲染: slerpQuat 端点还原 + 中点归一化', () => {
  const a = [0, 0, 0, 1];
  const b = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0));
  const bb = [b.x, b.y, b.z, b.w];
  const at0 = slerpQuat(a, bb, 0);
  const at1 = slerpQuat(a, bb, 1);
  for (let i = 0; i < 4; i++) {
    assertTrue(Math.abs(at0[i] - a[i]) < 1e-9, `t=0 分量 ${i}`);
    assertTrue(Math.abs(at1[i] - bb[i]) < 1e-9, `t=1 分量 ${i}`);
  }
  const mid = slerpQuat(a, bb, 0.5);
  assertTrue(Math.abs(Math.hypot(...mid) - 1) < 1e-9, '中点归一化');
});

test('守卫渲染: slerpQuat 走短弧（dot<0 时取反一端）', () => {
  const a = [0, 0, 0, 1];
  const b = [0, 0, 0, -1];   // 同一旋转、符号相反
  const mid = slerpQuat(a, b, 0.5);
  assertTrue(Math.abs(Math.hypot(...mid) - 1) < 1e-9, '不得数值爆炸');
  // 短弧：中点应仍接近单位四元数（而不是绕远路）
  assertTrue(Math.abs(mid[3]) > 0.9, `应走短弧，实际 w=${mid[3]}`);
});

test('守卫渲染: multiplyQuat 与 three 的 Quaternion.multiply 逐位一致', () => {
  const qa = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0.5, -0.2));
  const qb = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.4, 0.2, 0.7));
  const mine = multiplyQuat([qa.x, qa.y, qa.z, qa.w], [qb.x, qb.y, qb.z, qb.w]);
  const ref = qa.clone().multiply(qb);
  for (const [i, v] of [ref.x, ref.y, ref.z, ref.w].entries()) {
    assertTrue(Math.abs(mine[i] - v) < 1e-12, `分量 ${i}: ${mine[i]} vs ${v}`);
  }
});

// ==================== 采样 ====================

test('守卫渲染: sampleGuardianAnim 循环（t=duration 与 t=0 姿态相同）', async () => {
  const d = await loadGuardianAsset();
  const anim = d.animations.strong_right;
  const dur = anim.frameCount / anim.fps;
  const a = sampleGuardianAnim(anim, 0);
  const b = sampleGuardianAnim(anim, dur);
  assertEqual(a.size, b.size, '骨骼集合相同');
  for (const [bi, da] of a) {
    const db = b.get(bi);
    for (let i = 0; i < 4; i++) {
      assertTrue(Math.abs(da.rot[i] - db.rot[i]) < 1e-9, `骨 ${bi} rot[${i}] 循环闭合`);
    }
  }
});

test('守卫渲染: sampleGuardianAnim 负时刻与正时刻等价（非负取模）', async () => {
  const d = await loadGuardianAsset();
  const anim = d.animations.stomp;
  const dur = anim.frameCount / anim.fps;
  const a = sampleGuardianAnim(anim, -0.25);
  const b = sampleGuardianAnim(anim, dur - 0.25);
  for (const [bi, da] of a) {
    const db = b.get(bi);
    for (let i = 0; i < 4; i++) assertTrue(Math.abs(da.rot[i] - db.rot[i]) < 1e-9, '负时刻等价');
  }
});

test('守卫渲染: sampleGuardianAnim 对空/非法动画返回空 Map（不抛）', () => {
  assertEqual(sampleGuardianAnim(null, 0).size, 0);
  assertEqual(sampleGuardianAnim({ frameCount: 0, frames: [] }, 0).size, 0);
  assertEqual(sampleGuardianAnim({ frameCount: 2, frames: 'x' }, 0).size, 0);
});

test('守卫渲染: 采样返回的四元数全部归一化', async () => {
  const d = await loadGuardianAsset();
  for (const k of GUARDIAN_ATTACK_IDS) {
    const anim = d.animations[k];
    for (const t of [0, 0.37, 1.11, anim.frameCount / anim.fps - 0.01]) {
      for (const [, delta] of sampleGuardianAttack(anim, t)) {
        assertTrue(Math.abs(Math.hypot(...delta.rot) - 1) < 1e-9, `${k}@${t} 归一化`);
      }
    }
  }
});

test('守卫渲染: sampleGuardianAttack 播完**停在末帧**（不循环回绕）', async () => {
  const d = await loadGuardianAsset();
  for (const k of GUARDIAN_ATTACK_IDS) {
    const anim = d.animations[k];
    const dur = anim.frameCount / anim.fps;
    const last = sampleGuardianAttack(anim, dur);        // 恰好末尾
    const beyond = sampleGuardianAttack(anim, dur + 5);  // 远超末尾
    let sameAsLast = true;
    for (const [bi, dl] of last) {
      const db = beyond.get(bi);
      for (let i = 0; i < 4; i++) {
        if (Math.abs(dl.rot[i] - db.rot[i]) > 1e-9) sameAsLast = false;
      }
      for (let i = 0; i < 3; i++) {
        if (Math.abs(dl.pos[i] - db.pos[i]) > 1e-9) sameAsLast = false;
      }
    }
    assertTrue(sameAsLast, `${k} 超末尾必须钳在末帧`);
    // ⚠️ **不得断言「末帧 ≠ 首帧」**：原版四条动画都以 `resetKeyframe` 收尾
    //（回到 bind）⇒ 首末帧增量**都是单位四元数**，那是正确行为。
    // 判别「是否回绕」改用**中段帧**：回绕实现会在 dur+5 时给出中段姿态而不是末帧。
    const mid = sampleGuardianAttack(anim, dur * 0.4);
    let differsFromMid = false;
    for (const [bi, dm] of mid) {
      const dl = last.get(bi);
      for (let i = 0; i < 4; i++) {
        if (Math.abs(dm.rot[i] - dl.rot[i]) > 1e-6) differsFromMid = true;
      }
    }
    assertTrue(differsFromMid, `${k} 中段帧应与末帧不同（否则动画根本没在动）`);
  }
});

test('守卫渲染: 采样在帧时刻精确等于产物帧（插值端点）', async () => {
  const d = await loadGuardianAsset();
  const anim = d.animations.uppercut;
  const f = 7;
  const pose = sampleGuardianAttack(anim, f / anim.fps);
  for (let slot = 0; slot < anim.boneIndices.length; slot++) {
    const o = (f * anim.boneIndices.length + slot) * 7;
    const got = pose.get(anim.boneIndices[slot]);
    for (let i = 0; i < 4; i++) {
      assertTrue(Math.abs(got.rot[i] - anim.frames[o + i]) < 1e-9, `帧 ${f} slot ${slot} rot[${i}]`);
    }
    for (let i = 0; i < 3; i++) {
      assertTrue(Math.abs(got.pos[i] - anim.frames[o + 4 + i]) < 1e-9, `帧 ${f} slot ${slot} pos[${i}]`);
    }
  }
});

test('守卫渲染: move 平移通道生效（踩踏抬腿 = +0.5625 格，y 符号锚点）', async () => {
  const d = await loadGuardianAsset();
  const anim = d.animations.stomp;
  const li = d.bones.findIndex((b) => b.name === 'left_leg');
  assertTrue(li >= 0, 'left_leg 应在产物里');
  // 抬腿峰值在 tick 15（startKeyframe(15) 的末帧）
  const pose = sampleGuardianAttack(anim, 15 / anim.fps);
  const delta = pose.get(li);
  assertNotNull(delta, 'left_leg 应被踩踏驱动');
  assertTrue(Math.abs(delta.pos[1] - 0.5625) < 1e-6,
    `抬腿 9px ⇒ pos.y = +0.5625，实际 ${delta.pos[1]}（负值 = y 符号转反）`);
});

test('守卫渲染: 有 move 的骨骼在不同帧的 pos 必须不同（平移真的在动）', async () => {
  const d = await loadGuardianAsset();
  const anim = d.animations.strong_right;
  const ui = d.bones.findIndex((b) => b.name === 'upperbody');
  const a = sampleGuardianAttack(anim, 0);
  const b = sampleGuardianAttack(anim, 1.0);
  const da = a.get(ui), db = b.get(ui);
  assertNotNull(da);
  assertNotNull(db);
  const diff = Math.hypot(da.pos[0] - db.pos[0], da.pos[1] - db.pos[1], da.pos[2] - db.pos[2]);
  assertTrue(diff > 1e-6, `upperbody 的平移应随帧变化，实际差 ${diff}`);
});

// ==================== 姿态衔接 ====================

test('守卫渲染: blendGuardianPose 端点精确、骨骼集合取并集、不改入参', async () => {
  const a = new Map([[0, { rot: [0, 0, 0, 1], pos: [1, 2, 3] }]]);
  const b = new Map([[1, { rot: [0, 0.7071, 0, 0.7071], pos: [4, 5, 6] }]]);
  const at0 = blendGuardianPose(a, b, 0);
  const at1 = blendGuardianPose(a, b, 1);
  assertEqual(at0.size, 2, '并集');
  assertEqual(at1.size, 2);
  assertEqual(JSON.stringify(at0.get(0).pos), JSON.stringify([1, 2, 3]), 'w=0 取 a');
  assertEqual(JSON.stringify(at1.get(1).pos), JSON.stringify([4, 5, 6]), 'w=1 取 b');
  // a 独有骨骼在 w=1 时回到单位增量（bind）
  assertEqual(JSON.stringify(at1.get(0).pos), JSON.stringify([0, 0, 0]), 'a 独有骨骼 w=1 回 bind');
  assertEqual(JSON.stringify(a.get(0).pos), JSON.stringify([1, 2, 3]), '入参未被改写');
});

test('守卫渲染: blendGuardianPose 中点各取一半', () => {
  const a = new Map([[0, { rot: [0, 0, 0, 1], pos: [0, 0, 0] }]]);
  const b = new Map([[0, { rot: [0, 0, 0, 1], pos: [2, 4, 6] }]]);
  const mid = blendGuardianPose(a, b, 0.5);
  assertEqual(JSON.stringify(mid.get(0).pos), JSON.stringify([1, 2, 3]));
});

test('守卫渲染: GuardianPoseTransition 首帧直接发布目标', async () => {
  const d = await loadGuardianAsset();
  const tr = new GuardianPoseTransition(GUARDIAN_POSE_BLEND.seconds);
  const target = sampleGuardianAttack(d.animations.strong_right, 0.5);
  const out = tr.step('strong_right', target, 1 / 60, guardianBlendSeconds('strong_right'));
  assertEqual(out.size, target.size);
  for (const [bi, dd] of target) {
    for (let i = 0; i < 4; i++) assertTrue(Math.abs(out.get(bi).rot[i] - dd.rot[i]) < 1e-9, '首帧=目标');
  }
});

test('守卫渲染: GuardianPoseTransition 走满时长后精确等于目标', async () => {
  const d = await loadGuardianAsset();
  const tr = new GuardianPoseTransition(GUARDIAN_POSE_BLEND.seconds);
  const idle = sampleGuardianAttack(d.animations.stomp, 0);
  tr.step('idle', idle, 1 / 60, 0.2);
  const target = sampleGuardianAttack(d.animations.uppercut, 0.1);
  let out = null;
  // 推进超过淡入时长
  for (let i = 0; i < 20; i++) out = tr.step('uppercut', target, 1 / 60, 0.2);
  for (const [bi, dd] of target) {
    for (let i = 0; i < 4; i++) {
      assertTrue(Math.abs(out.get(bi).rot[i] - dd.rot[i]) < 1e-9, `走满后骨 ${bi} = 目标`);
    }
  }
});

test('守卫渲染: 四招淡入时长都 < 最短命中帧（命中那刻画面已混完）', () => {
  const minHit = Math.min(...GUARDIAN_ATTACK_IDS.map((k) => GUARDIAN_ATTACKS[k].hitFrameSeconds));
  for (const k of ['idle', ...GUARDIAN_ATTACK_IDS]) {
    assertTrue(guardianBlendSeconds(k) < minHit, `${k} 淡入 < ${minHit}s`);
  }
});

// ==================== 渲染器装配 ====================

test('守卫渲染: 池容量 = GUARDIAN.maxAlive，几何共享而骨骼/材质逐实例独立', async () => {
  const d = await loadGuardianAsset();
  const scene = new THREE.Scene();
  const r = new GuardianRenderer(scene, d);
  try {
    assertEqual(r.capacity, GUARDIAN.maxAlive, '池容量');
    const i0 = r.instances[0];
    assertNotNull(i0.mesh.geometry.getAttribute('skinIndex'), 'skinIndex');
    assertNotNull(i0.mesh.geometry.getAttribute('skinWeight'), 'skinWeight');
    assertEqual(i0.bones.length, 20, '骨骼数');
    // 刚性绑定：每顶点 weight = [1,0,0,0]
    const w = i0.mesh.geometry.getAttribute('skinWeight');
    for (let v = 0; v < 10; v++) {
      assertEqual(w.getX(v), 1, 'weight.x = 1');
      assertEqual(w.getY(v), 0, 'weight.y = 0');
    }
  } finally { r.dispose(); }
});

test('守卫渲染: 材质口径（unlit / DoubleSide / alphaTest / 白基色）', async () => {
  const d = await loadGuardianAsset();
  const r = new GuardianRenderer(new THREE.Scene(), d);
  try {
    const m = r.instances[0].material;
    assertTrue(m.isMeshBasicMaterial === true, 'unlit（本仓灯光只为 PBR 武器）');
    assertEqual(m.side, THREE.DoubleSide, 'y 翻转让绕序反向 ⇒ 必须双面');
    assertTrue(m.alphaTest > 0, 'cutout 语义');
    assertEqual(m.color.getHex(), 0xffffff, '有贴图时基色必须白');
  } finally { r.dispose(); }
});

test('守卫渲染: 脚底对齐 —— mesh.position.y === metrics.feetOffsetY（+1.6243）', async () => {
  const d = await loadGuardianAsset();
  const r = new GuardianRenderer(new THREE.Scene(), d);
  try {
    assertEqual(r.instances[0].mesh.position.y, d.metrics.feetOffsetY,
      '必须用产物 feetOffsetY，不得用核心盒中心');
    assertTrue(d.metrics.feetOffsetY > 0, '守卫的补偿量是正的（口径 A）');
  } finally { r.dispose(); }
});

test('守卫渲染: 无实体时全部实例 visible=false（draw call 归零）', async () => {
  const d = await loadGuardianAsset();
  const r = new GuardianRenderer(new THREE.Scene(), d);
  try {
    r.sync([], 0);
    for (const inst of r.instances) assertFalseVisible(inst);
  } finally { r.dispose(); }
});

/** 局部小工具（避免为一条断言 import assertFalse） */
function assertFalseVisible(inst) {
  assertTrue(inst.pivot.visible === false, '零实例必须隐藏');
}

test('守卫渲染: 有实体时对应实例可见且位置对齐 state.position', async () => {
  const d = await loadGuardianAsset();
  const r = new GuardianRenderer(new THREE.Scene(), d);
  try {
    r.sync([ent({ position: [3, 10, -4], yaw: 0.7 })], 1000);
    const inst = r.instances[0];
    assertTrue(inst.pivot.visible, '应可见');
    assertEqual(inst.pivot.position.x, 3);
    assertEqual(inst.pivot.position.y, 10);
    assertEqual(inst.pivot.position.z, -4);
    assertEqual(inst.pivot.rotation.y, 0.7);
  } finally { r.dispose(); }
});

test('守卫渲染: 红闪用材质 color（performance.now 基准）', async () => {
  const d = await loadGuardianAsset();
  const r = new GuardianRenderer(new THREE.Scene(), d);
  try {
    r.sync([ent({ flashedUntil: 2000 })], 1000);
    assertEqual(r.instances[0].material.color.getHex(), 0xff0000, '闪期内纯红');
    r.sync([ent({ flashedUntil: 2000 })], 3000);
    assertEqual(r.instances[0].material.color.getHex(), 0xffffff, '到期复位白');
  } finally { r.dispose(); }
});

test('守卫渲染: 四条攻击片段各按 attackKind 选（播错支的形态是「踩踏演成重击」）', async () => {
  const d = await loadGuardianAsset();
  const r = new GuardianRenderer(new THREE.Scene(), d);
  try {
    // ⚠️ **不能只取第一根驱动骨**：四招的第一根都是 lowerbody，而它在某些时刻
    // 恰好都是单位增量（实测 t=0.5 时两招相同）⇒ 会误报「选片段写错」。
    // 正确做法：取**整副骨架**的四元数指纹，并选一个四招姿态已分开的时刻。
    const T = 1.2;   // 实测：此时四招的整副姿态两两不同
    const seen = [];
    for (const k of GUARDIAN_ATTACK_IDS) {
      // 每招用一个新渲染器，避开姿态淡入把上一招混进来
      const rr = new GuardianRenderer(new THREE.Scene(), d);
      rr.sync([ent({ attackAnimT: T, attackKind: k })], 1000);
      seen.push(rr.instances[0].bones.map(
        (b) => `${b.quaternion.x.toFixed(4)},${b.quaternion.y.toFixed(4)},${b.quaternion.z.toFixed(4)},${b.quaternion.w.toFixed(4)}`,
      ).join('|'));
      rr.dispose();
    }
    assertEqual(new Set(seen).size, GUARDIAN_ATTACK_IDS.length,
      '四招在同一时刻应给出不同姿态（否则是选片段写错了）');
  } finally { r.dispose(); }
});

test('守卫渲染: attackAnimT=0 时走程序化 idle（按移动相位摆臂）', async () => {
  const d = await loadGuardianAsset();
  const r = new GuardianRenderer(new THREE.Scene(), d);
  try {
    // ⚠️ 程序化 idle 由**速度**驱动（原版 `limbSwingAmount` 是移动包络，静止时为 0），
    // 与丧尸渲染器同口径；不是焰魔那种「idleTime 相位」（焰魔有 idle 片段，守卫没有）。
    const moving = { velocity: [0, 0, -5.4], attackAnimT: 0, attackKind: null };
    r.sync([ent(moving)], 1000);
    const q0 = r.instances[0].bones.map((b) => b.quaternion.clone());
    r.sync([ent(moving)], 1400);   // dt=0.4s ⇒ 相位推进
    let moved = false;
    for (let i = 0; i < q0.length; i++) {
      if (Math.abs(q0[i].x - r.instances[0].bones[i].quaternion.x) > 1e-6) moved = true;
    }
    assertTrue(moved, '移动中相位推进应改变姿态（程序化摆臂）');
    // 静止时回到 bind（幅度归零）—— ⚠️ **必须等淡入走完**：从「摆臂」切到「空姿态」
    // 也走姿态衔接（0.2s），当帧还在混合中 ⇒ 直接断言会红。
    for (let i = 0; i < 30; i++) {
      r.sync([ent({ velocity: [0, 0, 0], attackAnimT: 0, attackKind: null })], 1800 + i * 16);
    }
    const li = d.bones.findIndex((b) => b.name === 'left_leg');
    const bq = d.bones[li].bindQuaternion;
    const q = r.instances[0].bones[li].quaternion;
    assertTrue(Math.abs(q.x - bq[0]) < 1e-6 && Math.abs(q.w - bq[3]) < 1e-6,
      '静止且淡入走完后四肢应回到 bind（摆幅归零）');
  } finally { r.dispose(); }
});

test('守卫渲染: 骨骼增量从 bind 快照起算（不逐帧累积）', async () => {
  const d = await loadGuardianAsset();
  const r = new GuardianRenderer(new THREE.Scene(), d);
  try {
    const e = ent({ attackAnimT: 0.5, attackKind: 'strong_right' });
    r.sync([e], 1000);
    const first = r.instances[0].bones.map((b) => b.quaternion.clone());
    // 同一 attackAnimT 再发布 20 帧：姿态必须逐位不变（累积会让它越挥越散架）
    for (let i = 0; i < 20; i++) r.sync([e], 1000 + i * 16);
    for (let i = 0; i < first.length; i++) {
      const q = r.instances[0].bones[i].quaternion;
      assertTrue(Math.abs(q.x - first[i].x) < 1e-6, `骨 ${i} 不得逐帧累积`);
      assertTrue(Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) < 1e-6, `骨 ${i} 模长恒 1`);
    }
  } finally { r.dispose(); }
});

// ==================== 口径 A 的骨骼位置公式（本文件最关键的判别用例）====================

test('守卫渲染: 骨骼位置 = localPosition + delta.pos（口径 A，**不是** pivot − R·pivot）', async () => {
  const d = await loadGuardianAsset();
  const r = new GuardianRenderer(new THREE.Scene(), d);
  try {
    // ⚠️ 判别力靠的是 **localPosition 非零**：口径 A 是 `lp + delta`，
    // 而焰魔公式在 pivot 恒零时退化成 `0 − 0 + delta` = **丢掉 lp**。
    // 故选一根「被某招驱动 **且** lp 非零」的骨骼（实测：非零 bind 旋转的三根
    // spike/voidstone **不被任何招驱动**，不能拿它们做本用例）。
    let pick = null;
    for (const k of GUARDIAN_ATTACK_IDS) {
      for (const bi of d.animations[k].boneIndices) {
        const lp = d.bones[bi].localPosition;
        if (Math.hypot(lp[0], lp[1], lp[2]) > 0.1) { pick = { k, bi }; break; }
      }
      if (pick) break;
    }
    assertNotNull(pick, '应有一根被驱动且 localPosition 非零的骨骼');
    const { k, bi } = pick;
    const T = 1.2;
    r.sync([ent({ attackAnimT: T, attackKind: k })], 1000);
    const bone = r.instances[0].bones[bi];
    const lp = d.bones[bi].localPosition;
    const dp = sampleGuardianAttack(d.animations[k], T).get(bi).pos;
    assertTrue(Math.abs(bone.position.x - (lp[0] + dp[0])) < 1e-5,
      `x 应为 lp+delta（${lp[0] + dp[0]}），实际 ${bone.position.x}`);
    assertTrue(Math.abs(bone.position.y - (lp[1] + dp[1])) < 1e-5,
      `y 应为 lp+delta（${lp[1] + dp[1]}），实际 ${bone.position.y}`);
    assertTrue(Math.abs(bone.position.z - (lp[2] + dp[2])) < 1e-5,
      `z 应为 lp+delta（${lp[2] + dp[2]}），实际 ${bone.position.z}`);
    // 反向判别：照搬焰魔公式会丢掉 lp ⇒ 位置应明显不同
    assertTrue(Math.hypot(bone.position.x - dp[0], bone.position.y - dp[1], bone.position.z - dp[2]) > 0.1,
      '与「只用 delta」必须明显不同（否则本用例无判别力）');
  } finally { r.dispose(); }
});

test('守卫渲染: delta.pos 为零时 bone.position 逐位等于产物 localPosition', async () => {
  const d = await loadGuardianAsset();
  const r = new GuardianRenderer(new THREE.Scene(), d);
  try {
    // 静止（velocity 全零）⇒ 程序化 idle 幅度 0 ⇒ 全部骨骼应在 bind 位置
    r.sync([ent({ attackAnimT: 0, velocity: [0, 0, 0] })], 1000);
    let checked = 0;
    for (let i = 0; i < d.bones.length; i++) {
      const lp = d.bones[i].localPosition;
      const p = r.instances[0].bones[i].position;
      if (Math.abs(p.x - lp[0]) < 1e-9 && Math.abs(p.y - lp[1]) < 1e-9 && Math.abs(p.z - lp[2]) < 1e-9) {
        checked++;
      }
    }
    assertEqual(checked, d.bones.length, '静止时全部骨骼必在 bind 位置');
  } finally { r.dispose(); }
});

// ==================== 缓动 / 击退 / 实例复用 ====================

test('守卫渲染: 首帧对齐不触发上台阶缓动（出生不从 y=0 升上来）', async () => {
  const d = await loadGuardianAsset();
  const r = new GuardianRenderer(new THREE.Scene(), d);
  try {
    r.sync([ent({ position: [0, 40, 0] })], 1000);
    assertEqual(r.liftOffsetOf(0), 0, '首帧偏移必须 0');
    assertEqual(r.renderYOf(0), 40, '首帧渲染 y = 物理 y');
  } finally { r.dispose(); }
});

test('守卫渲染: 上台阶 → 欠下负偏移并写进 pivot 矩阵', async () => {
  const d = await loadGuardianAsset();
  const r = new GuardianRenderer(new THREE.Scene(), d);
  try {
    r.sync([ent({ position: [0, 10, 0] })], 1000);
    r.sync([ent({ position: [0, 11, 0] })], 1016);
    assertTrue(r.liftOffsetOf(0) < 0, '上台阶应欠下负偏移');
    assertTrue(r.renderYOf(0) < 11, '缓动必须真的写进矩阵（不是只算不用）');
  } finally { r.dispose(); }
});

test('守卫渲染: 下落 → 偏移立即清零（不叠缓动）', async () => {
  const d = await loadGuardianAsset();
  const r = new GuardianRenderer(new THREE.Scene(), d);
  try {
    r.sync([ent({ position: [0, 10, 0] })], 1000);
    r.sync([ent({ position: [0, 11, 0] })], 1016);
    r.sync([ent({ position: [0, 9, 0] })], 1032);
    assertEqual(r.liftOffsetOf(0), 0, '下落立即清零');
    assertEqual(r.renderYOf(0), 9);
  } finally { r.dispose(); }
});

test('守卫渲染: noteKnockback → 渲染位置滞后，不写回 state.position', async () => {
  const d = await loadGuardianAsset();
  const r = new GuardianRenderer(new THREE.Scene(), d);
  try {
    const e = ent({ position: [0, 10, 0] });
    r.sync([e], 1000);
    assertTrue(r.noteKnockback(e.id, 0, 0.4), '在池里应登记成功');
    assertTrue(r.knockOffsetZOf(0) > 0, '应欠下 z 偏移');
    assertEqual(e.state.position[2], 0, '权威位置不得被渲染层改写');
    assertTrue(r.renderYOf(0) === 10, 'y 不受水平击退影响');
  } finally { r.dispose(); }
});

test('守卫渲染: noteKnockback 对不在池里的 id 返回 false', async () => {
  const d = await loadGuardianAsset();
  const r = new GuardianRenderer(new THREE.Scene(), d);
  try {
    r.sync([], 0);
    assertTrue(r.noteKnockback('nope', 1, 0) === false);
  } finally { r.dispose(); }
});

test('守卫渲染: 实例复用给新实体时重置缓动/击退/骨架（不继承上一只）', async () => {
  const d = await loadGuardianAsset();
  const r = new GuardianRenderer(new THREE.Scene(), d);
  try {
    // 第一只在 y=10、攻击中途、被击退
    const a = ent({ position: [0, 10, 0], attackAnimT: 1.0, attackKind: 'stomp' });
    r.sync([a], 1000);
    r.noteKnockback(a.id, 0.3, 0.3);
    // 换成新 id、新高度（死了又召）
    const b = { ...ent({ position: [0, 46, 0] }), id: 'guardian:rc:1:0' };
    r.sync([b], 1016);
    assertEqual(r.liftOffsetOf(0), 0, '不得把高度差当成一次上台阶');
    assertEqual(r.knockOffsetXOf(0), 0, '不得继承上一只的击退偏移');
    assertEqual(r.knockOffsetZOf(0), 0);
    assertEqual(r.renderYOf(0), 46, '新实体首帧就在正确高度');
  } finally { r.dispose(); }
});

test('守卫渲染: dispose 后全部实例从 scene 摘除且几何/材质已释放', async () => {
  const d = await loadGuardianAsset();
  const scene = new THREE.Scene();
  const r = new GuardianRenderer(scene, d);
  r.sync([ent()], 1000);
  const before = scene.children.length;
  assertTrue(before > 0, '应有节点');
  r.dispose();
  assertEqual(scene.children.length, 0, '全部摘除');
  assertEqual(r.instances.length, 0);
});