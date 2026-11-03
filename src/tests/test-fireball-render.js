// src/tests/test-fireball-render.js — 火球渲染池（v2.44，v2.45 燃烧外观）
//
// 覆盖「单测能测到」的部分：池容量从 FIREBALL.poolSize 派生、零实例时 visible=false
// （draw call 归零，AGENTS.md「常驻实例池」约束）、差集驱动 slot 分配与归还、
// 几何/材质口径（亮核球体 + unlit 炽橙色 + additive 光晕 billboard）。像素级判据在
// `tests/fireball-render.spec.mjs`（Tier 4）。
//
// ⚠️ 用真实 `THREE.Scene`（只查对象图，不需要 renderer）—— 与 `test-dragon-render.js` 同手法。
import * as THREE from 'three';
import { test } from './runner.js';
import { assertEqual, assertFalse, assertTrue } from './assert.js';
import {
  FireballRenderer, FIREBALL_CORE_COLOR, FIREBALL_HALO_SCALE,
  FIREBALL_PULSE_AMP, FIREBALL_PULSE_HZ,
} from '../render/fireball-renderer.js';
import { FIREBALL, FIREBALL_TYPE } from '../entities/dragons/dragon-config.js';

/** 假光晕贴图（单测免 canvas；构造注入 haloTexture 走同一路径） */
function fakeHaloTexture() {
  return new THREE.Texture(new THREE.DataTexture(new Uint8Array(4), 1, 1));
}

function makeEntity(id, position = [0, 30, 0]) {
  return { id, type: FIREBALL_TYPE, state: { position, direction: [0, -1, 0] } };
}

test('火球渲染: 池容量从 FIREBALL.poolSize 派生（不硬编码）', () => {
  const scene = new THREE.Scene();
  const r = new FireballRenderer({ scene, haloTexture: fakeHaloTexture() });
  assertEqual(r.maxActive, FIREBALL.poolSize, '缺省容量必须 = FIREBALL.poolSize');
  assertEqual(r.mesh.count, FIREBALL.poolSize, '核心 InstancedMesh 容量必须 = poolSize');
  assertEqual(r.haloMesh.count, FIREBALL.poolSize, '光晕 InstancedMesh 容量必须 = poolSize');
  r.dispose();
});

test('火球渲染: 零实例时两个 mesh 都 visible = false（draw call 归零）', () => {
  const scene = new THREE.Scene();
  const r = new FireballRenderer({ scene, haloTexture: fakeHaloTexture() });
  assertFalse(r.mesh.visible, '核心：构造后应隐藏（初始无火球）');
  assertFalse(r.haloMesh.visible, '光晕：构造后应隐藏（否则恒增 1 个 draw call）');
  assertEqual(r.slotCount(), 0);
  r.sync([]);
  assertFalse(r.mesh.visible, 'sync 空集合后核心仍须隐藏');
  assertFalse(r.haloMesh.visible, 'sync 空集合后光晕仍须隐藏');
  r.dispose();
});

test('火球渲染: 有火球 → 两个 mesh 都 visible = true 且 slot 分配', () => {
  const scene = new THREE.Scene();
  const r = new FireballRenderer({ scene, haloTexture: fakeHaloTexture() });
  r.sync([makeEntity('fb-1')]);
  assertTrue(r.mesh.visible, '有火球核心必须提交渲染');
  assertTrue(r.haloMesh.visible, '有火球光晕必须提交渲染（否则只是橙球，不是燃烧）');
  assertEqual(r.slotCount(), 1);
  r.sync([makeEntity('fb-1'), makeEntity('fb-2', [10, 30, 0])]);
  assertEqual(r.slotCount(), 2, '第二个火球须分到另一个 slot');
  r.dispose();
});

test('火球渲染: 实体消失 → slot 归还且两个 mesh 的 visible 都回落 false', () => {
  const scene = new THREE.Scene();
  const r = new FireballRenderer({ scene, haloTexture: fakeHaloTexture() });
  r.sync([makeEntity('fb-1'), makeEntity('fb-2')]);
  assertEqual(r.slotCount(), 2);
  r.sync([makeEntity('fb-2')]);   // fb-1 消失
  assertEqual(r.slotCount(), 1, '消失实体的 slot 必须归还');
  r.sync([]);   // 全部消失
  assertEqual(r.slotCount(), 0);
  assertFalse(r.mesh.visible, '全部消失后核心必须隐藏（draw call 归零）');
  assertFalse(r.haloMesh.visible, '全部消失后光晕必须隐藏（draw call 归零）');
  r.dispose();
});

test('火球渲染: 非火球实体被忽略（按 type 过滤，不抢弹丸/丧尸的实体）', () => {
  const scene = new THREE.Scene();
  const r = new FireballRenderer({ scene, haloTexture: fakeHaloTexture() });
  r.sync([
    { id: 'p-1', type: 'projectile', state: { position: [0, 30, 0], direction: [1, 0, 0] } },
    { id: 'z-1', type: 'zombie', state: { position: [0, 30, 0] } },
    makeEntity('fb-1'),
  ]);
  assertEqual(r.slotCount(), 1, '只认 fireball type（共用 type 会让两个渲染器互抢实体）');
  r.dispose();
});

test('火球渲染: 核心几何是球体、半径 = FIREBALL.radius', () => {
  const scene = new THREE.Scene();
  const r = new FireballRenderer({ scene, haloTexture: fakeHaloTexture() });
  assertTrue(r.mesh.geometry.type === 'SphereGeometry', `几何类型=${r.mesh.geometry.type}`);
  assertEqual(r.mesh.geometry.parameters.radius, FIREBALL.radius, '球半径必须来自 FIREBALL.radius');
  r.dispose();
});

test('火球渲染: 核心材质是 unlit 炽橙色（MeshBasicMaterial，不吃 PBR 灯光）', () => {
  const scene = new THREE.Scene();
  const r = new FireballRenderer({ scene, haloTexture: fakeHaloTexture() });
  assertTrue(r.mesh.material.isMeshBasicMaterial, '必须 unlit（与矿车/丧尸同口径）');
  assertEqual(r.mesh.material.color.getHex(), FIREBALL_CORE_COLOR,
    '核心色必须来自 FIREBALL_CORE_COLOR（v2.45 调亮的炽橙）');
  const { r: cr, g: cg, b: cb } = r.mesh.material.color;
  assertTrue(cr > cg && cr > cb, `火焰色必须偏红/橙（实际 rgb=${cr.toFixed(2)},${cg.toFixed(2)},${cb.toFixed(2)}）`);
  r.dispose();
});

test('火球渲染: 光晕层口径（additive 混合 + 不写深度 + 平面几何尺寸 = 核心直径 × HALO_SCALE）', () => {
  const scene = new THREE.Scene();
  const r = new FireballRenderer({ scene, haloTexture: fakeHaloTexture() });
  assertEqual(r.haloMesh.material.blending, THREE.AdditiveBlending,
    '光晕必须 additive（发光感；NormalBlending 会读成不透明贴片）');
  assertFalse(r.haloMesh.material.depthWrite, '光晕不得写深度（会挡核心球与互相挡）');
  assertTrue(r.haloMesh.material.transparent === true, '光晕必须 transparent（边缘渐变靠 alpha）');
  assertTrue(r.haloMesh.material.map === r._haloTexture, '光晕必须挂径向渐变贴图');
  const w = r.haloMesh.geometry.parameters.width;
  assertEqual(w, FIREBALL.radius * FIREBALL_HALO_SCALE,
    `光晕边长必须 = 核心半径 × ${FIREBALL_HALO_SCALE}（太小看不出光晕，太大糊成一团）`);
  r.dispose();
});

test('火球渲染: 光晕是 billboard（实例矩阵旋转 = 传入的相机四元数）', () => {
  const scene = new THREE.Scene();
  const r = new FireballRenderer({ scene, haloTexture: fakeHaloTexture() });
  // 相机四元数 = 绕 Y 转 90°（非单位）：光晕矩阵必须带上它，核心不带
  const camQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  r.sync([makeEntity('fb-1')], camQuat, 0);
  const mHalo = new THREE.Matrix4();
  r.haloMesh.getMatrixAt(0, mHalo);
  const qHalo = new THREE.Quaternion().setFromRotationMatrix(mHalo);
  assertTrue(Math.abs(qHalo.w - camQuat.w) < 1e-6 && Math.abs(qHalo.y - camQuat.y) < 1e-6,
    `光晕朝向必须跟随相机四元数（实际 w=${qHalo.w.toFixed(3)} y=${qHalo.y.toFixed(3)}）`);
  const mCore = new THREE.Matrix4();
  r.mesh.getMatrixAt(0, mCore);
  const qCore = new THREE.Quaternion().setFromRotationMatrix(mCore);
  assertTrue(Math.abs(qCore.w - 1) < 1e-6, '核心球体各向同性，旋转必须保持单位四元数');
  r.dispose();
});

test('火球渲染: 光晕脉动（nowMs 变化 → 尺度在 1±PULSE_AMP 内振荡）', () => {
  const scene = new THREE.Scene();
  const r = new FireballRenderer({ scene, haloTexture: fakeHaloTexture() });
  const scaleAt = (nowMs) => {
    r.sync([makeEntity('fb-1')], null, nowMs);
    const m = new THREE.Matrix4();
    r.haloMesh.getMatrixAt(0, m);
    return new THREE.Vector3().setFromMatrixScale(m).x;
  };
  const s0 = scaleAt(0);
  const s1 = scaleAt(1000 / (FIREBALL_PULSE_HZ * 4));   // 1/4 周期 → sin=±1 附近
  assertTrue(Math.abs(s0 - 1) <= FIREBALL_PULSE_AMP + 1e-9,
    `t=0 尺度 ${s0} 必须在 1±${FIREBALL_PULSE_AMP} 内`);
  assertTrue(Math.abs(s1 - s0) > 0.01, `脉动必须真的在动（s0=${s0.toFixed(3)} s1=${s1.toFixed(3)}）`);
  assertTrue(s1 <= 1 + FIREBALL_PULSE_AMP + 1e-9 && s1 >= 1 - FIREBALL_PULSE_AMP - 1e-9,
    `脉动幅度不得超出 ±${FIREBALL_PULSE_AMP}（实际 ${s1}）`);
  // 核心尺度恒 1（不脉动 —— 脉动只在光晕层）
  r.sync([makeEntity('fb-1')], null, 1000 / (FIREBALL_PULSE_HZ * 4));
  const mc = new THREE.Matrix4();
  r.mesh.getMatrixAt(0, mc);
  assertEqual(new THREE.Vector3().setFromMatrixScale(mc).x, 1, '核心球不得脉动');
  r.dispose();
});

test('火球渲染: pose 发布（实例矩阵的平移来自 state.position，核心与光晕同位）', () => {
  const scene = new THREE.Scene();
  const r = new FireballRenderer({ scene, haloTexture: fakeHaloTexture() });
  r.sync([makeEntity('fb-1', [12.5, 28.25, -7.5])]);
  const m = new THREE.Matrix4();
  r.mesh.getMatrixAt(0, m);
  const pos = new THREE.Vector3().setFromMatrixPosition(m);
  assertEqual(pos.x, 12.5);
  assertEqual(pos.y, 28.25);
  assertEqual(pos.z, -7.5);
  const mh = new THREE.Matrix4();
  r.haloMesh.getMatrixAt(0, mh);
  const posH = new THREE.Vector3().setFromMatrixPosition(mh);
  assertEqual(posH.x, 12.5, '光晕必须与核心同位（否则光环飘在球外）');
  assertEqual(posH.y, 28.25);
  assertEqual(posH.z, -7.5);
  r.dispose();
});

test('火球渲染: dispose 后两个 mesh 都从 scene 摘除且 slot 清空', () => {
  const scene = new THREE.Scene();
  const r = new FireballRenderer({ scene, haloTexture: fakeHaloTexture() });
  r.sync([makeEntity('fb-1')]);
  assertTrue(scene.children.includes(r.mesh), '构造后核心须在 scene 里');
  assertTrue(scene.children.includes(r.haloMesh), '构造后光晕须在 scene 里');
  r.dispose();
  assertFalse(scene.children.includes(r.mesh), 'dispose 后核心必须从 scene 摘除');
  assertFalse(scene.children.includes(r.haloMesh), 'dispose 后光晕必须从 scene 摘除');
  assertEqual(r.slotCount(), 0);
});

test('火球渲染: 脉动常量口径（幅度/频率是观感标定值，改前先看 Tier 4）', () => {
  assertEqual(FIREBALL_PULSE_AMP, 0.15, '脉动幅度 ±15%（v2.45 标定）');
  assertEqual(FIREBALL_PULSE_HZ, 6, '脉动频率 6Hz（火焰跳动节奏）');
  assertEqual(FIREBALL_HALO_SCALE, 3.4, '光晕相对核心 3.4 倍（v2.45 标定）');
});
