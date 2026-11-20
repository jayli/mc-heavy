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
import { cinderArcPoint } from '../player/weapons/cinder-fall.js';

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
  // ⚠️ **岩石与光晕必须立即隐**；尾巴/粒子是故意留着自然衰亡的（见下一条用例）
  assertFalse(r.rockMesh.visible, '岩石本体必须立即隐');
  assertFalse(r.haloMesh.visible, '光晕必须立即隐');
  r.dispose();
});

test('cinder 尾巴: 有岩石时火焰尾巴上屏，两端跟着弹道（不是直线）', () => {
  const r = makeRenderer();
  // 真实抛物线：拱起使中段高于两端连线
  const launch = {
    origin: [0, 30, 3], target: [0, 30, -17], distance: 20,
    arc: 1.5, arcCurve: 0.85, degenerate: false,
  };
  const mid = cinderArcPoint(launch, 0.5);
  r.sync([makeRock('c1', mid, { traveled: 10, launch })], null, 1000);
  assertTrue(r.flameMesh.visible, '飞行中必须有火焰尾巴（用户：有拖拽的火焰尾巴）');
  const head = r.uniforms.uHead.value;
  const tail = r.uniforms.uTail.value;
  assertClose(head.x, mid[0], 1e-5, '尾巴头部必须贴着岩石');
  assertClose(head.y, mid[1], 1e-5);
  assertClose(head.z, mid[2], 1e-5);
  const len = head.distanceTo(tail);
  assertTrue(len > 1, `尾巴必须有长度（实测 ${len}）`);
  // ⚠️ trailSpan 是**弹道参数路程**，两端直线距离在弯曲弧上会略大一点
  // （弦长 vs 弧长）⇒ 上限取 span × 1.15，而不是死钉 span。
  assertTrue(len <= CINDER_FX.trailSpan * 1.15,
    `尾巴量级必须受 trailSpan 约束（实测 ${len}）`);
  // 尾端在岩石**后方**（z 更大 = 靠近手点）
  assertTrue(tail.z > head.z, '尾端必须在岩石后方而不是前方');
  r.dispose();
});

test('cinder 尾巴: 岩石消失后**烧回头**而不是硬切（上游 trailBurnout）', () => {
  const r = makeRenderer();
  r.sync([makeRock('c1')], null, 1000);
  assertTrue(r.flameMesh.visible);
  r.sync([], null, 1100);
  assertTrue(r.flameMesh.visible, '刚消失那一帧不得硬切（尾巴要烧回去）');
  const burnMs = CINDER_FX.trailBurnout * 1000;
  r.update(1100 + burnMs * 0.5, 0.016);
  assertTrue(r.uniforms.uTrailBurn.value > 0.3, '烧回进度必须推进');
  assertTrue(r.flameMesh.visible, '烧到一半时仍可见');
  r.update(1100 + burnMs + 100, 0.016);
  assertFalse(r.flameMesh.visible, '烧完必须隐藏（draw call 回基线）');
  r.dispose();
});

test('cinder 火星: 飞行中沿弧撒出火星与余烬（分批，不是定点星爆）', () => {
  const r = makeRenderer();
  const launch = {
    origin: [0, 30, 3], target: [0, 30, -17], distance: 20,
    arc: 1.5, arcCurve: 0.85, degenerate: false,
  };
  // 连续多帧推进（速率累加器需要 dt）
  for (let i = 0; i < 20; i++) {
    const t = 0.2 + i * 0.02;
    const p = cinderArcPoint(launch, t);
    r.sync([makeRock('c1', p, { traveled: t * 20, launch })], null, 1000 + i * 50);
  }
  assertTrue(r.sparkMesh.visible, '火星必须上屏');
  assertTrue(r.emberMesh.visible, '余烬必须上屏');
  const spawn = r._sparkGeo.getAttribute('aSpawn');
  const vel = r._sparkGeo.getAttribute('aVel');
  let live = 0;
  let moving = 0;
  for (let i = 0; i < spawn.count; i++) {
    if (spawn.getX(i) > 0) live++;
    if (Math.hypot(vel.getX(i), vel.getY(i), vel.getZ(i)) > 0.1) moving++;
  }
  assertTrue(live > 20, `必须真的写了很多火星（实测 ${live}）`);
  // ⚠️ **aVel 必须非零** —— 它是 STREAK 拉伸的输入，零速度 ⇒ 全部退回圆点（爆米花）
  assertTrue(moving > 20, `火星必须带速度（实测 ${moving}），否则退化成圆点`);
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

test('cinder 落点: 寿命结束后爆壳/环隐藏，粒子**自然衰亡**后也隐藏（draw call 回基线）', () => {
  const r = makeRenderer();
  r.burst([0, 10, 0], 0, 'block');
  // 落点必须真的喷出大量火星（用户：火星粒子很多，是爆炸的样子）
  assertTrue(r.sparkMesh.visible, '落点必须喷火星');
  assertTrue(r.emberMesh.visible, '落点必须喷余烬');
  assertTrue(r.smokeMesh.visible, '落点必须喷烟（遮挡 = 层次）');
  const spawn = r._sparkGeo.getAttribute('aSpawn');
  let live = 0;
  for (let i = 0; i < spawn.count; i++) if (spawn.getX(i) >= 0) live++;
  assertTrue(live >= CINDER_FX.burstSparks,
    `落点火星数必须 ≥ burstSparks（实测 ${live}）`);
  r.update(CINDER_FX.burstLifeSeconds * 1000 + 200, 0.016);
  assertFalse(r.burstMesh.visible, '爆壳寿命到必须隐藏');
  assertFalse(r.shockMesh.visible, '冲击环寿命到必须隐藏');
  // 粒子此时仍在飞（不得硬切）
  assertTrue(r.sparkMesh.visible, '火星必须自然衰亡而不是随爆壳硬切');
  // 过了空闲窗口 ⇒ 全部隐藏
  r.update((CINDER_FX.particleIdleSeconds + 0.5) * 1000, 0.016);
  assertFalse(r.sparkMesh.visible);
  assertFalse(r.emberMesh.visible);
  assertFalse(r.smokeMesh.visible);
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
  // 岩石 + 光晕 + 火焰尾巴 + 火星 + 余烬 + 烟 + 爆壳 + 冲击环
  assertEqual(r.meshes.length, 8);
  for (const m of r.meshes) assertNotNull(m.name);
  r.dispose();
});

test('cinder fx: 尾巴与火星的开关量齐备（用户点名的两件）', () => {
  assertTrue(CINDER_FX.trailSpan > 3, '尾巴要够长才读得出「拖拽」');
  assertTrue(CINDER_FX.trailHeadSize > 1.3, '头部必须比尾端粗（火球拖尾的形状）');
  assertTrue(CINDER_FX.burstSparks >= 150, '落点火星要够多（上游 180）');
  assertTrue(CINDER_FX.burstEmbers >= 200, '落点余烬要够多（上游 260）');
  assertTrue(CINDER_FX.sparkStretch > 0, '火星必须沿速度拉伸（否则是圆点 = 爆米花）');
  assertTrue(CINDER_FX.trailBatches >= 2, '沿弧必须分批撒（否则读作 beads）');
});

/**
 * ⚠️⚠️ 用户 2026-11-19：「火焰球的前进方向侧，前面是平的，而不是尖的，
 * 平的不好看，希望从平头改成椭圆头或者尖头」。
 *
 * 两个成因各自可定位，下面两条用例分别钉住：
 * ① ribbon 只铺到**岩石中心** ⇒ 条带在球心处被一条垂直于运动方向的直边截断；
 * ② 鼻锥段**采样太稀** ⇒ 椭圆收拢被画成多边形斜切面。
 */
test('cinder 鼻锥: 鼻锥长度必须足够包住岩石（否则仍露平边）', () => {
  assertTrue(CINDER_FX.trailNoseLength > CINDER_FX.radius,
    `鼻锥 ${CINDER_FX.trailNoseLength} 必须 > 岩石半径 ${CINDER_FX.radius}`);
  // 接缝处必须同宽（<1 会在接缝出台阶，读作另一条平边）
  assertEqual(CINDER_FX.trailNoseJoin, 1, '鼻锥起始宽度必须与头部无缝衔接');
});

test('cinder 鼻锥: 采样必须向头部加密（幂指数 <1）且鼻锥内≥8 环', async () => {
  const { createFlameRibbonGeometry } = await import('../render/cinder-fall-geometry.js');
  const geo = createFlameRibbonGeometry(CINDER_FX.trailNodes);
  const pos = geo.getAttribute('position');
  // 真实飞行下的 noseStart（实测 axisLen≈7.0、noseLen 1.15 ⇒ 0.859）
  const axisLen = 7.0;
  const noseStart = axisLen / (axisLen + CINDER_FX.trailNoseLength);
  const ts = [];
  for (let i = 0; i < pos.count; i += 2) ts.push(pos.getX(i));
  const noseRings = ts.filter((t) => t >= noseStart).length;
  // ⚠️⚠️ **幂指数弄反会静默退化**：`t=u^b` 在 u<1 时 b 越大 t 越小，
  // 采样反而**远离**头部。实测 b=1.6 只有 **4 环**（比均匀的 6 还少），b=0.5 有 **11 环**。
  assertTrue(noseRings >= 8,
    `鼻锥内环数实测 ${noseRings}（<8 会把椭圆画成多边形斜切平头）`);
  // 两端必须精确落在 0 与 1（否则尾巴不贴尾端 / 尖端收不到零）
  assertClose(ts[0], 0, 1e-6, '首环 t');
  assertClose(ts[ts.length - 1], 1, 1e-6, '末环 t（尖端）');
  // 单调递增且无重复
  for (let i = 1; i < ts.length; i++) {
    assertTrue(ts[i] > ts[i - 1], `t 必须严格递增（i=${i}）`);
  }
  geo.dispose();
});

test('cinder fx: 岩石基色是**黑色**（用户：黑色的燃烧的火球）', () => {
  const c = new THREE.Color(CINDER_FX.colorRock);
  const luma = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  assertTrue(luma < 0.05, `岩石基色必须近炭黑（实测 luma=${luma}）`);
  const crack = new THREE.Color(CINDER_FX.colorCrack);
  assertTrue(crack.r > c.r * 4, '熔岩缝必须明显亮于岩石本体（对比 = 燃烧感）');
});