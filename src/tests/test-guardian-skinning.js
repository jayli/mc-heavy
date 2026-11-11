// src/tests/test-guardian-skinning.js — 末影守卫：**skinning 后的世界坐标**契约（Tier 1）
//
// ## 为什么必须有这一份（2026-11-11 用户实测缺陷）
//
// 用户反馈「腿没有分开 / 脑袋长到肚子上 / 手臂进入身体里」。实测根因：
//
//   skinning 公式 `skinned = bindMatrixInverse · (bone.matrixWorld · boneInverse) · bindMatrix · p`
//   **bind 姿态下 `bone.matrixWorld · boneInverse ≡ I`** ⇒ `skinned ≡ p`（顶点原样返回）。
//   skinning 只做「相对 bind 姿态的**形变**」，**不做「骨骼局部 → 模型空间」的摆放**。
//
//   · 焰魔顶点是**绝对模型坐标**（Bedrock 口径，已含骨骼位置）⇒ 原样返回正确；
//   · 守卫若用**骨骼局部坐标**（口径 A）⇒ 原样返回 = 24 个盒全堆在原点。
//
// 形态：骨骼数 / 盒数 / 顶点数 / 索引数 / UV / 指纹 / **离线轮廓**全部正确
//（离线轮廓是直接乘世界链算的，绕过了 skinning）—— 只有真实渲染才现形。
// ⇒ 判据必须落在 **three 自己的 `SkinnedMesh.applyBoneTransform`** 上，
//    不能手推公式（手推会与被测代码共享同一个错误假设）。
//
// ## 判据
//
// 对每个顶点：`applyBoneTransform` 的结果再乘 `mesh.matrixWorld`，
// 必须等于「口径 A 世界链 · 局部顶点 + feetOffsetY」——即解剖学上正确的位置。
// bind 姿态与三条攻击动画的关键帧都要验。
import * as THREE from 'three';
import { test } from './runner.js';
import { assertTrue } from './assert.js';
import { loadGuardianAsset } from '../render/guardian-model.js';
import { GuardianRenderer } from '../render/guardian-renderer.js';

/** 4×4 行主序矩阵工具（与烘焙器同口径，独立于 three 的列主序） */
const mul4 = (A, B) => {
  const o = new Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += A[r * 4 + k] * B[k * 4 + c];
    o[r * 4 + c] = s;
  }
  return o;
};
const trMat = (q, t) => {
  const [x, y, z, w] = q;
  const xx = x * x, yy = y * y, zz = z * z;
  const xy = x * y, xz = x * z, yz = y * z;
  const wx = w * x, wy = w * y, wz = w * z;
  return [
    1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy), t[0],
    2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx), t[1],
    2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy), t[2],
    0, 0, 0, 1,
  ];
};
const apply4 = (m, p) => [
  m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
  m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
  m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
];
const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

/** bind 姿态的世界链（口径 A：position = localPosition，pivot 恒零） */
function bindChain(asset) {
  const w = [];
  for (let i = 0; i < asset.bones.length; i++) {
    const b = asset.bones[i];
    const local = trMat(b.bindQuaternion, b.localPosition);
    w[i] = b.parentIndex === -1 ? local : mul4(w[b.parentIndex], local);
  }
  return w;
}

/** 某动画某帧的世界链 */
function animChain(asset, anim, frame) {
  const w = [];
  for (let i = 0; i < asset.bones.length; i++) {
    const b = asset.bones[i];
    let q = b.bindQuaternion;
    let lp = b.localPosition.slice();
    const slot = anim.boneIndices.indexOf(i);
    if (slot >= 0) {
      const o = (frame * anim.boneIndices.length + slot) * 7;
      q = qmul(q, anim.frames.slice(o, o + 4));
      const dp = anim.frames.slice(o + 4, o + 7);
      lp = [lp[0] + dp[0], lp[1] + dp[1], lp[2] + dp[2]];
    }
    const local = trMat(q, lp);
    w[i] = b.parentIndex === -1 ? local : mul4(w[b.parentIndex], local);
  }
  return w;
}

/**
 * 期望的顶点世界位置。
 *
 * ⚠️ **与产物顶点口径无关**：期望值一律由「**骨骼局部**顶点 × 世界链」给出。
 * 局部顶点从产物反解：若产物是口径 B（绝对模型坐标），需左乘 bindWorld⁻¹ 还原。
 * 这里用 `asset.metrics.vertexConvention` 判别，两种口径都能算出同一份期望。
 */
function expectedWorld(asset, chain, feetY) {
  const g = asset.geometry;
  const bw = bindChain(asset);
  const isLocal = asset.metrics.vertexConvention !== 'java-model-absolute';
  const out = [];
  for (let v = 0; v < g.position.length / 3; v++) {
    const bi = g.skinIndex[v * 4];
    const p = [g.position[v * 3], g.position[v * 3 + 1], g.position[v * 3 + 2]];
    let local = p;
    if (!isLocal) {
      // 绝对 → 局部：左乘 bindWorld⁻¹
      const M = new THREE.Matrix4().fromArray([
        bw[bi][0], bw[bi][4], bw[bi][8], bw[bi][12],
        bw[bi][1], bw[bi][5], bw[bi][9], bw[bi][13],
        bw[bi][2], bw[bi][6], bw[bi][10], bw[bi][14],
        bw[bi][3], bw[bi][7], bw[bi][11], bw[bi][15],
      ]).invert();
      const e = M.elements;
      const row = [
        e[0], e[4], e[8], e[12],
        e[1], e[5], e[9], e[13],
        e[2], e[6], e[10], e[14],
        e[3], e[7], e[11], e[15],
      ];
      local = apply4(row, p);
    }
    const w = apply4(chain[bi], local);
    out.push([w[0], w[1] + feetY, w[2]]);
  }
  return out;
}

/** 造一个渲染器实例并把骨架摆到指定帧 */
function makeRenderer(asset, animKey, frame) {
  const scene = new THREE.Scene();
  const r = new GuardianRenderer(scene, asset, new THREE.Texture());
  const inst = r.instances[0];
  inst.pivot.visible = true;
  if (animKey) {
    const anim = asset.animations[animKey];
    for (let i = 0; i < asset.bones.length; i++) {
      const b = asset.bones[i];
      const slot = anim.boneIndices.indexOf(i);
      if (slot < 0) {
        inst.bones[i].position.set(...b.localPosition);
        inst.bones[i].quaternion.set(...b.bindQuaternion);
        continue;
      }
      const o = (frame * anim.boneIndices.length + slot) * 7;
      const q = qmul(b.bindQuaternion, anim.frames.slice(o, o + 4));
      const dp = anim.frames.slice(o + 4, o + 7);
      inst.bones[i].quaternion.set(...q);
      inst.bones[i].position.set(
        b.localPosition[0] + dp[0], b.localPosition[1] + dp[1], b.localPosition[2] + dp[2]);
    }
  }
  scene.updateMatrixWorld(true);
  return { r, inst, scene };
}

/** 用 three 权威 API 算实际世界位置，与期望比 */
function maxWorldError(asset, inst, expect) {
  const g = asset.geometry;
  const v = new THREE.Vector3();
  let maxErr = 0;
  let worst = null;
  for (let vi = 0; vi < g.position.length / 3; vi++) {
    v.set(g.position[vi * 3], g.position[vi * 3 + 1], g.position[vi * 3 + 2]);
    inst.mesh.applyBoneTransform(vi, v);
    v.applyMatrix4(inst.mesh.matrixWorld);
    const e = expect[vi];
    const d = Math.hypot(v.x - e[0], v.y - e[1], v.z - e[2]);
    if (d > maxErr) { maxErr = d; worst = { vi, got: [v.x, v.y, v.z], want: e }; }
  }
  return { maxErr, worst };
}

test('守卫 skinning: bind 姿态的世界坐标必须解剖学正确（腿分开/头在上/臂在外）', async () => {
  const asset = await loadGuardianAsset();
  const { r, inst } = makeRenderer(asset, null, 0);
  const expect = expectedWorld(asset, bindChain(asset), asset.metrics.feetOffsetY);
  const { maxErr, worst } = maxWorldError(asset, inst, expect);
  assertTrue(maxErr < 1e-4,
    `skinning 后世界坐标最大误差 ${maxErr.toFixed(6)} 格（应 < 1e-4）。`
    + `最差顶点 #${worst?.vi} 实得 [${worst?.got.map((x) => x.toFixed(3))}] `
    + `应为 [${worst?.want.map((x) => x.toFixed(3))}]`);
  r.dispose();
});

test('守卫 skinning: 三条攻击动画关键帧的世界坐标也正确', async () => {
  const asset = await loadGuardianAsset();
  for (const [key, frame] of [['strong_right', 29], ['strong_left', 34], ['stomp', 32], ['uppercut', 27]]) {
    const anim = asset.animations[key];
    const { r, inst } = makeRenderer(asset, key, frame);
    const expect = expectedWorld(asset, animChain(asset, anim, frame), asset.metrics.feetOffsetY);
    const { maxErr, worst } = maxWorldError(asset, inst, expect);
    assertTrue(maxErr < 1e-4,
      `${key}@${frame} 世界坐标最大误差 ${maxErr.toFixed(6)} 格。`
      + `最差顶点 #${worst?.vi} 实得 [${worst?.got.map((x) => x.toFixed(3))}] `
      + `应为 [${worst?.want.map((x) => x.toFixed(3))}]`);
    r.dispose();
  }
});

test('守卫 skinning: 两腿必须分开、头在躯干上方、手臂在躯干外侧（解剖学判据）', async () => {
  const asset = await loadGuardianAsset();
  const { r, inst } = makeRenderer(asset, null, 0);
  const expect = expectedWorld(asset, bindChain(asset), asset.metrics.feetOffsetY);
  // 用**实际 skinning 结果**算各骨骼 AABB（不是期望值 —— 那会绕过缺陷）
  const g = asset.geometry;
  const v = new THREE.Vector3();
  const per = asset.bones.map(() => ({
    lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity],
  }));
  for (let vi = 0; vi < g.position.length / 3; vi++) {
    v.set(g.position[vi * 3], g.position[vi * 3 + 1], g.position[vi * 3 + 2]);
    inst.mesh.applyBoneTransform(vi, v);
    v.applyMatrix4(inst.mesh.matrixWorld);
    const bi = g.skinIndex[vi * 4];
    const p = [v.x, v.y, v.z];
    for (let k = 0; k < 3; k++) {
      if (p[k] < per[bi].lo[k]) per[bi].lo[k] = p[k];
      if (p[k] > per[bi].hi[k]) per[bi].hi[k] = p[k];
    }
  }
  const idx = (n) => asset.bones.findIndex((b) => b.name === n);
  const rl = per[idx('right_leg')], ll = per[idx('left_leg')];
  const hd = per[idx('head')], ub = per[idx('upperbody')];
  const ra = per[idx('right_arm')];
  void expect;

  const gap = ll.lo[0] - rl.hi[0];
  assertTrue(gap > 0.5, `两腿应有 > 0.5 格间隙，实测 ${gap.toFixed(3)}（腿没分开 = skinning 塌了）`);
  assertTrue(hd.lo[1] > ub.lo[1] + 1.0,
    `头底 ${hd.lo[1].toFixed(3)} 应显著高于躯干底 ${ub.lo[1].toFixed(3)}（头长肚子上 = skinning 塌了）`);
  assertTrue(ra.hi[0] <= ub.lo[0] + 1e-6,
    `右臂右缘 ${ra.hi[0].toFixed(3)} 应 ≤ 躯干左缘 ${ub.lo[0].toFixed(3)}（手臂进身体 = skinning 塌了）`);
  r.dispose();
});

test('守卫 skinning: 整体 bbox 尺寸与原版比例一致（宽高比 ≈ 1.26）', async () => {
  const asset = await loadGuardianAsset();
  const { r, inst } = makeRenderer(asset, null, 0);
  const g = asset.geometry;
  const v = new THREE.Vector3();
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let vi = 0; vi < g.position.length / 3; vi++) {
    v.set(g.position[vi * 3], g.position[vi * 3 + 1], g.position[vi * 3 + 2]);
    inst.mesh.applyBoneTransform(vi, v);
    v.applyMatrix4(inst.mesh.matrixWorld);
    const p = [v.x, v.y, v.z];
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
  }
  const w = hi[0] - lo[0], h = hi[1] - lo[1];
  const ratio = w / h;
  // 原版参考图实测宽高比 1.2596；产物几何 1.2645。skinning 塌了会变成 ~1.0 或更小
  assertTrue(ratio > 1.15 && ratio < 1.40,
    `正面宽高比应 ≈ 1.26（原版 1.2596），实测 ${ratio.toFixed(4)}（宽 ${w.toFixed(3)} 高 ${h.toFixed(3)}）`);
  assertTrue(h > 4.0 && h < 4.6, `身高应 ≈ 4.28 格，实测 ${h.toFixed(3)}`);
  r.dispose();
});