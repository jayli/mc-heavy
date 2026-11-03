// src/tests/test-fireball-render.js — 火球渲染池（v2.44）
//
// 覆盖「单测能测到」的部分：池容量从 FIREBALL.poolSize 派生、零实例时 visible=false
// （draw call 归零，AGENTS.md「常驻实例池」约束）、差集驱动 slot 分配与归还、
// 几何/材质口径（球体 + unlit 火焰色）。像素级判据在 `tests/fireball-render.spec.mjs`（Tier 4）。
//
// ⚠️ 用真实 `THREE.Scene`（只查对象图，不需要 renderer）—— 与 `test-dragon-render.js` 同手法。
import * as THREE from 'three';
import { test } from './runner.js';
import { assertEqual, assertFalse, assertTrue } from './assert.js';
import { FireballRenderer } from '../render/fireball-renderer.js';
import { FIREBALL, FIREBALL_TYPE } from '../entities/dragons/dragon-config.js';

function makeEntity(id, position = [0, 30, 0]) {
  return { id, type: FIREBALL_TYPE, state: { position, direction: [0, -1, 0] } };
}

test('火球渲染: 池容量从 FIREBALL.poolSize 派生（不硬编码）', () => {
  const scene = new THREE.Scene();
  const r = new FireballRenderer({ scene });
  assertEqual(r.maxActive, FIREBALL.poolSize, '缺省容量必须 = FIREBALL.poolSize');
  assertEqual(r.mesh.count, FIREBALL.poolSize, 'InstancedMesh 容量必须 = poolSize');
  r.dispose();
});

test('火球渲染: 零实例时 visible = false（draw call 归零）', () => {
  const scene = new THREE.Scene();
  const r = new FireballRenderer({ scene });
  assertFalse(r.mesh.visible, '构造后应隐藏（初始无火球）');
  assertEqual(r.slotCount(), 0);
  r.sync([]);
  assertFalse(r.mesh.visible, 'sync 空集合后仍须隐藏');
  r.dispose();
});

test('火球渲染: 有火球 → visible = true 且 slot 分配', () => {
  const scene = new THREE.Scene();
  const r = new FireballRenderer({ scene });
  r.sync([makeEntity('fb-1')]);
  assertTrue(r.mesh.visible, '有火球必须提交渲染');
  assertEqual(r.slotCount(), 1);
  r.sync([makeEntity('fb-1'), makeEntity('fb-2', [10, 30, 0])]);
  assertEqual(r.slotCount(), 2, '第二个火球须分到另一个 slot');
  r.dispose();
});

test('火球渲染: 实体消失 → slot 归还且 visible 回落 false', () => {
  const scene = new THREE.Scene();
  const r = new FireballRenderer({ scene });
  r.sync([makeEntity('fb-1'), makeEntity('fb-2')]);
  assertEqual(r.slotCount(), 2);
  r.sync([makeEntity('fb-2')]);   // fb-1 消失
  assertEqual(r.slotCount(), 1, '消失实体的 slot 必须归还');
  r.sync([]);   // 全部消失
  assertEqual(r.slotCount(), 0);
  assertFalse(r.mesh.visible, '全部消失后必须隐藏（draw call 归零）');
  r.dispose();
});

test('火球渲染: 非火球实体被忽略（按 type 过滤，不抢弹丸/丧尸的实体）', () => {
  const scene = new THREE.Scene();
  const r = new FireballRenderer({ scene });
  r.sync([
    { id: 'p-1', type: 'projectile', state: { position: [0, 30, 0], direction: [1, 0, 0] } },
    { id: 'z-1', type: 'zombie', state: { position: [0, 30, 0] } },
    makeEntity('fb-1'),
  ]);
  assertEqual(r.slotCount(), 1, '只认 fireball type（共用 type 会让两个渲染器互抢实体）');
  r.dispose();
});

test('火球渲染: 几何是球体、半径 = FIREBALL.radius', () => {
  const scene = new THREE.Scene();
  const r = new FireballRenderer({ scene });
  assertTrue(r.mesh.geometry.type === 'SphereGeometry', `几何类型=${r.mesh.geometry.type}`);
  assertEqual(r.mesh.geometry.parameters.radius, FIREBALL.radius, '球半径必须来自 FIREBALL.radius');
  r.dispose();
});

test('火球渲染: 材质是 unlit 火焰色（MeshBasicMaterial，不吃 PBR 灯光）', () => {
  const scene = new THREE.Scene();
  const r = new FireballRenderer({ scene });
  assertTrue(r.mesh.material.isMeshBasicMaterial, '必须 unlit（与矿车/丧尸同口径）');
  const { r: cr, g: cg, b: cb } = r.mesh.material.color;
  assertTrue(cr > cg && cr > cb, `火焰色必须偏红/橙（实际 rgb=${cr.toFixed(2)},${cg.toFixed(2)},${cb.toFixed(2)}）`);
  r.dispose();
});

test('火球渲染: pose 发布（实例矩阵的平移来自 state.position）', () => {
  const scene = new THREE.Scene();
  const r = new FireballRenderer({ scene });
  r.sync([makeEntity('fb-1', [12.5, 28.25, -7.5])]);
  const m = new THREE.Matrix4();
  r.mesh.getMatrixAt(0, m);
  const pos = new THREE.Vector3().setFromMatrixPosition(m);
  assertEqual(pos.x, 12.5);
  assertEqual(pos.y, 28.25);
  assertEqual(pos.z, -7.5);
  r.dispose();
});

test('火球渲染: dispose 后从 scene 摘除且 slot 清空', () => {
  const scene = new THREE.Scene();
  const r = new FireballRenderer({ scene });
  r.sync([makeEntity('fb-1')]);
  assertTrue(scene.children.includes(r.mesh), '构造后须在 scene 里');
  r.dispose();
  assertFalse(scene.children.includes(r.mesh), 'dispose 后必须从 scene 摘除');
  assertEqual(r.slotCount(), 0);
});
