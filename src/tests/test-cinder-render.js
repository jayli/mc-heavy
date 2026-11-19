// src/tests/test-cinder-render.js — Cinder Fall 渲染池与观感契约（v3.21）
//
// 覆盖「单测能测到」的部分：池容量派生、零实例 visible=false（draw call 归零）、
// 差集驱动 slot 分配与归还、岩石/光晕的几何与材质口径、落点包络曲线。
// **像素级判据在 `tests/cinder-fall.spec.mjs`（Tier 4）** —— TSL 在 GPU 求值，
// 材质构造成功不代表画面上有东西（v3.14 的 `vec3(Color)` 纯黑零报错实测）。
//
// ⚠️ 用真实 `THREE.Scene`（只查对象图，不需要 renderer）—— 与 test-fireball-render 同手法。
import * as THREE from 'three';
import { test } from './runner.js';
import { assertEqual, assertFalse, assertTrue, assertNotNull } from './assert.js';
import { WEAPONS, WEAPON_IDS } from '../player/weapons/weapon-catalog.js';
import { FIREBALL_HALO_SCALE } from '../render/fireball-renderer.js';
import { CINDER_FX } from '../render/cinder-fall-config.js';
import { CinderFallRenderer, makeCinderHaloTexture } from '../render/cinder-fall-renderer.js';
import { CINDER_TYPE } from '../entities/cinder/cinder-system.js';

function assertClose(actual, expected, eps, msg) {
  assertTrue(Math.abs(actual - expected) <= eps,
    `${msg ?? 'assertClose'}: expected ${expected} ±${eps}, got ${actual}`);
}

const CFG = () => WEAPONS[WEAPON_IDS.SWORD].cinderFall;

/** 假光晕贴图（单测免 canvas；构造注入 haloTexture 走同一路径） */
function fakeHaloTexture() {
  return new THREE.DataTexture(new Uint8Array(4), 1, 1);
}

function makeRock(id, position = [0, 30, 0], over = {}) {
  return {
    id, type: CINDER_TYPE,
    state: {
      position,
      prevPosition: [position[0], position[1], position[2] + 0.3],
      traveled: 3,
      launch: { origin: [0, 30, 3], target: [0, 30, -17], distance: 20 },
      ...over,
    },
  };
}

function makeRenderer() {
  return new CinderFallRenderer({ scene: new THREE.Scene(), haloTexture: fakeHaloTexture() });
}

// ==================== 常量关系（three-free）====================

test('cinder fx: 玩法量派生自 catalog（红线 1，不写第二份）', () => {
  const c = CFG();
  assertEqual(CINDER_FX.radius, c.radius);
  assertEqual(CINDER_FX.spin, c.spin);
  assertEqual(CINDER_FX.poolSize, c.poolSize);
  assertEqual(CINDER_FX.debrisCount, c.debrisCount);
});

test('cinder fx: 光晕倍率直接等于火球的 FIREBALL_HALO_SCALE（用户裁定照火球手法）', () => {
  assertEqual(CINDER_FX.haloScale, FIREBALL_HALO_SCALE);
  assertTrue(CINDER_FX.haloScale > 1.5, '光晕必须明显大于岩石本体');
});

test('cinder fx: 电弧阈值必须硬（放宽会把壳填成实心球）', () => {
  assertTrue(CINDER_FX.burstArcLo >= 0.75,
    `下阈值 ${CINDER_FX.burstArcLo} 太松 ⇒ 实心球（上游注释：reads as a rock）`);
  assertTrue(CINDER_FX.burstArcHi - CINDER_FX.burstArcLo <= 0.25, '带宽必须窄');
});

test('cinder fx: 配色是暖橙（r > b），与 Storm Lance 的冷蓝相反', () => {
  for (const key of ['colorCrack', 'colorFlameMid', 'colorFlameEdge', 'colorBurstA']) {
    const c = new THREE.Color(CINDER_FX[key]);
    assertTrue(c.r > c.b, `${key} 必须是暖色（r=${c.r} b=${c.b}）`);
  }
});

// ==================== 池与可见性 ====================

test('cinder 渲染: 池容量从 catalog.poolSize 派生（不硬编码）', () => {
  const r = makeRenderer();
  assertEqual(r.maxActive, CFG().poolSize);
  assertEqual(r.rockMesh.count, CFG().poolSize);
  assertEqual(r.haloMesh.count, CFG().poolSize);
  r.dispose();
});

test('cinder 渲染: 零实例时全部 mesh visible=false（draw call 归零）', () => {
  const r = makeRenderer();
  for (const m of r.meshes) assertFalse(m.visible, `${m.name} 构造后必须隐藏`);
  assertEqual(r.slotCount(), 0);
  r.sync([], null, 0);
  for (const m of r.meshes) assertFalse(m.visible, `${m.name} sync 空集合后仍须隐藏`);
  r.dispose();
});

test('cinder 渲染: 有岩石 → 岩石与光晕都可见（光晕是「燃烧」的来源）', () => {
  const r = makeRenderer();
  r.sync([makeRock('c1')], null, 1000);
  assertTrue(r.rockMesh.visible, '岩石本体必须提交');
  assertTrue(r.haloMesh.visible, '光晕必须提交（否则只是灰石头，不是燃烧的岩石）');
  assertEqual(r.slotCount(), 1);
  r.dispose();
});

test('cinder 渲染: 差集驱动 slot 归还（三条回收路径自动覆盖）', () => {
  const r = makeRenderer();
  r.sync([makeRock('c1'), makeRock('c2', [5, 30, 0])], null, 1000);
  assertEqual(r.slotCount(), 2);
  r.sync([makeRock('c2', [5, 30, 0])], null, 1100);
  assertEqual(r.slotCount(), 1, '消失的实体必须归还 slot');
  r.sync([], null, 1200);
  assertEqual(r.slotCount(), 0);
  for (const m of r.meshes) assertFalse(m.visible);
  r.dispose();
});

test('cinder 渲染: 只认 cinder 类型（与火球/弹丸渲染器互不抢实体）', () => {
  const r = makeRenderer();
  r.sync([
    { id: 'fb', type: 'fireball', state: { position: [0, 30, 0] } },
    { id: 'pr', type: 'projectile', state: { position: [0, 30, 0] } },
  ], null, 1000);
  assertEqual(r.slotCount(), 0, '不得把火球/弹丸画成岩石');
  r.dispose();
});

test('cinder 渲染: 岩石矩阵含真实位置与半径缩放', () => {
  const r = makeRenderer();
  r.sync([makeRock('c1', [7, 20, -3])], null, 1000);
  const m = new THREE.Matrix4();
  r.rockMesh.getMatrixAt(0, m);
  const pos = new THREE.Vector3().setFromMatrixPosition(m);
  assertClose(pos.x, 7, 1e-6); assertClose(pos.y, 20, 1e-6); assertClose(pos.z, -3, 1e-6);
  const scale = new THREE.Vector3().setFromMatrixScale(m);
  assertClose(scale.x, CFG().radius, 1e-6, '岩石缩放必须 = radius');
  r.dispose();
});

test('cinder 渲染: 光晕是 billboard（写入相机四元数）', () => {
  const r = makeRenderer();
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 3);
  r.sync([makeRock('c1')], q, 1000);
  const m = new THREE.Matrix4();
  r.haloMesh.getMatrixAt(0, m);
  const got = new THREE.Quaternion();
  m.decompose(new THREE.Vector3(), got, new THREE.Vector3());
  assertClose(got.dot(q), 1, 1e-5, '光晕朝向必须 = 相机朝向（否则读作斜卡片）');
  r.dispose();
});

test('cinder 渲染: 非 cinder 状态缺字段时不抛异常（NaN 会污染整个实例矩阵）', () => {
  const r = makeRenderer();
  r.sync([{ id: 'bad', type: CINDER_TYPE, state: { position: [NaN, 0, 0] } }], null, 1000);
  const m = new THREE.Matrix4();
  r.rockMesh.getMatrixAt(0, m);
  assertTrue(m.elements.every(Number.isFinite), '非法位置不得写进矩阵');
  r.dispose();
});

// ==================== 落点特效 ====================

test('cinder 落点: burst 触发爆壳与冲击环，并写各自 age/fade', () => {
  const r = makeRenderer();
  r.burst([2, 10, -8], 1000, 'block');
  assertTrue(r.burstMesh.visible, '爆壳必须可见');
  assertTrue(r.shockMesh.visible, '冲击环必须可见');
  assertEqual(r.uniforms.uBurstFade.value, 1);
  assertEqual(r.uniforms.uShockFade.value, 1);
  r.dispose();
});

test('cinder 落点: 冲击环朝向按 impactKind 分流（命中实体朝玩家，否则贴地）', () => {
  const r = makeRenderer();
  // 命中地面 ⇒ 环面法线 +Y（贴地）
  r.burst([0, 10, 0], 1000, 'block');
  const nGround = new THREE.Vector3(0, 0, 1).applyQuaternion(r.shockMesh.quaternion);
  assertClose(nGround.y, 1, 1e-5, '命中地面时环必须贴地（法线 +Y）');
  // 命中实体 ⇒ 环面法线朝玩家（这里给 +Z 方向的相机）
  r.burst([0, 10, -8], 2000, 'entity', [0, 10, 4]);
  const nEntity = new THREE.Vector3(0, 0, 1).applyQuaternion(r.shockMesh.quaternion);
  assertTrue(nEntity.z > 0.5, `命中实体时环必须朝玩家（法线 z=${nEntity.z}）`);
  assertTrue(Math.abs(nEntity.y) < 0.9, '不得仍贴地');
  r.dispose();
});

test('cinder 落点: 爆壳扩张走 outQuint（前 20% 就冲掉 2/3，不是慢胀）', () => {
  const r = makeRenderer();
  r.burst([0, 10, 0], 0, 'block');
  const life = CINDER_FX.burstLifeSeconds * 1000;
  r.update(life * 0.2, 0.016);
  const s20 = r.burstMesh.scale.x / CINDER_FX.burstSize;
  assertTrue(s20 > 0.6, `20% 寿命时半径比 ${s20} 必须 >0.6（outQuint 0.672 vs outCubic 0.488）`);
  r.dispose();
});

test('cinder 落点: 爆壳与冲击环各有独立 fade（不共用，否则末尾硬 pop）', () => {
  const r = makeRenderer();
  r.burst([0, 10, 0], 0, 'block');
  const shockLife = CINDER_FX.shockLifeSeconds * 1000;
  // 冲击环寿命更短 ⇒ 它先淡完，而爆壳仍在
  r.update(shockLife * 0.99, 0.016);
  assertTrue(r.uniforms.uShockFade.value < 0.2, '冲击环末段必须已淡下去');
  assertTrue(r.uniforms.uBurstFade.value > 0.2, '爆壳此时不该跟着淡完（各自寿命）');
  r.dispose();
});

test('cinder 落点: 寿命结束后全部隐藏（draw call 回基线）', () => {
  const r = makeRenderer();
  r.burst([0, 10, 0], 0, 'block');
  r.update(CINDER_FX.burstLifeSeconds * 1000 + 200, 0.016);
  assertFalse(r.burstMesh.visible, '爆壳寿命到必须隐藏');
  assertFalse(r.shockMesh.visible, '冲击环寿命到必须隐藏');
  assertFalse(r.active, '全部结束 ⇒ active=false');
  r.dispose();
});

test('cinder 落点: 非法坐标不抛异常也不污染矩阵', () => {
  const r = makeRenderer();
  r.burst([NaN, 0, 0], 1000, 'block');
  assertFalse(r.burstMesh.visible, '非法坐标必须被拒（不得画出 NaN 几何）');
  r.dispose();
});

test('cinder 渲染: 常态零分配早退门（无岩石时不遍历实体集合）', () => {
  const r = makeRenderer();
  // ⚠️ 未告知数量时**不得早退**（否则单测/其它调用方传了岩石却什么都不画）
  let iterated0 = false;
  r.sync({ [Symbol.iterator]() { iterated0 = true; return [][Symbol.iterator](); } }, null, 900);
  assertTrue(iterated0, '未告知数量时必须照常遍历（早退门不得静默吃掉工作）');
  // 装配层告知 0 只 ⇒ sync 必须早退，**不调迭代器**
  r.setRockCount(0);
  let iterated = false;
  const spy = { [Symbol.iterator]() { iterated = true; return [][Symbol.iterator](); } };
  r.sync(spy, null, 1000);
  assertFalse(iterated, '无岩石时不得遍历全量实体（AGENTS.md：每帧新建是分配）');
  // 告知有岩石 ⇒ 必须真的遍历
  r.setRockCount(1);
  r.sync([makeRock('c1')], null, 1100);
  assertEqual(r.slotCount(), 1);
  // 回收路径：岩石消失后告知 0，但 slot 还在 ⇒ 仍须跑一次把 slot 归还
  r.setRockCount(0);
  r.sync([], null, 1200);
  assertEqual(r.slotCount(), 0, 'slot 必须被归还（早退门不得吃掉回收）');
  r.dispose();
});

test('cinder 渲染: dispose 后场景清空（无泄漏）', () => {
  const scene = new THREE.Scene();
  const r = new CinderFallRenderer({ scene, haloTexture: fakeHaloTexture() });
  const before = scene.children.length;
  assertTrue(before >= 4, '至少四个 mesh 入场景');
  r.dispose();
  assertEqual(scene.children.length, 0, 'dispose 必须把全部 mesh 移出场景');
  assertEqual(r.meshes.length, 0);
});

test('cinder 光晕贴图: 可注入（单测免 canvas），缺省内部生成', () => {
  const injected = fakeHaloTexture();
  const r = new CinderFallRenderer({ scene: new THREE.Scene(), haloTexture: injected });
  assertEqual(r.haloMesh.material.map, injected, '注入的贴图必须被真的消费');
  r.dispose();
  // makeCinderHaloTexture 需要 canvas ⇒ 只验证它被导出（浏览器侧 Tier 4 验像素）
  assertEqual(typeof makeCinderHaloTexture, 'function');
});

test('cinder 渲染: mesh 全部 frustumCulled=false + fog=false（远处不被雾洗白）', () => {
  const r = makeRenderer();
  for (const m of r.meshes) {
    assertFalse(m.frustumCulled, `${m.name} 必须无条件提交（实例池包围球按零 scale 算）`);
    assertFalse(m.material.fog, `${m.name} 必须关雾`);
    assertEqual(m.renderOrder, CINDER_FX.renderOrder);
  }
  r.dispose();
});

test('cinder 渲染: meshes 数组含全部 pass（水面倒影 hidden 列表靠它展开）', () => {
  const r = makeRenderer();
  assertEqual(r.meshes.length, 4, '岩石 + 光晕 + 爆壳 + 冲击环');
  for (const m of r.meshes) assertNotNull(m.name);
  r.dispose();
});