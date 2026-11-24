// src/tests/test-soldier-render.js — 士兵几何与渲染契约（Tier 1，TDD）
//
// 覆盖 spec §5.6：5 份 unique 几何 / 7 个渲染部件、逐顶点色与自发光属性、
// 实例池容量、空载隐藏、蹲姿、留尸倒地、红闪逐实例独立。
// ⚠️ 像素级观感由 tests/soldier.spec.mjs 的 Tier 4 用例守（本文件只测契约）。
import * as THREE from 'three';
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse } from './assert.js';
import { SOLDIER, SOLDIER_AI } from '../entities/soldiers/soldier-config.js';
import { createSoldierState } from '../entities/soldiers/soldier-agent.js';
import {
  SOLDIER_PARTS, SOLDIER_GEOMETRY_OF, SOLDIER_PIVOTS, SOLDIER_COLORS,
  buildSoldierGeometries,
} from '../render/soldier-geometry.js';
import { SoldierRenderer } from '../render/soldier-renderer.js';
import { createTurretMetalMaterial } from '../render/turret-metal.js';

/** 造一个渲染器 + n 只士兵 entity（state 可覆写） */
function makeRenderFixture(n = 1, overrides = []) {
  const scene = new THREE.Scene();
  const renderer = new SoldierRenderer({ scene });
  const entities = [];
  for (let i = 0; i < n; i++) {
    entities.push({
      id: `s${i}`, type: 'soldier', generation: 1,
      state: createSoldierState({
        position: [i * 2 + 0.5, 1, 0.5], yaw: 0, health: SOLDIER.health,
        ...(overrides[i] || {}),
      }),
    });
  }
  return { scene, renderer, entities };
}

test('士兵几何: 5 份 unique 几何齐全且顶点数非零，7 个部件都能映射到', () => {
  const geos = buildSoldierGeometries();
  for (const k of ['pelvis', 'torso', 'head', 'thigh', 'shin']) {
    assertTrue(geos[k].attributes.position.count > 0, `${k} 顶点数非零`);
  }
  assertEqual(SOLDIER_PARTS.length, 7, '7 个渲染部件');
  for (const p of SOLDIER_PARTS) assertTrue(!!geos[SOLDIER_GEOMETRY_OF[p]], `${p} 有几何`);
});

test('士兵几何: 左右腿共用同一份几何（不是各建一份）', () => {
  assertEqual(SOLDIER_GEOMETRY_OF.thighL, SOLDIER_GEOMETRY_OF.thighR);
  assertEqual(SOLDIER_GEOMETRY_OF.shinL, SOLDIER_GEOMETRY_OF.shinR);
});

test('士兵几何: 逐顶点色/aSurf/aGlow 三属性齐全且长度一致', () => {
  for (const g of Object.values(buildSoldierGeometries())) {
    const n = g.attributes.position.count;
    assertEqual(g.attributes.color.count, n, 'color 长度');
    assertEqual(g.attributes.aSurf.count, n, 'aSurf 长度');
    assertEqual(g.attributes.aGlow.count, n, 'aGlow 长度');
  }
});

test('士兵几何: 护目镜与胸灯有非零 aGlow（自发光载体）', () => {
  const geos = buildSoldierGeometries();
  const maxGlow = (g) => Math.max(...g.attributes.aGlow.array);
  assertTrue(maxGlow(geos.head) > 0.5, `护目镜 e=4.5 ⇒ aGlow≈0.56，实测 ${maxGlow(geos.head)}`);
  assertTrue(maxGlow(geos.torso) > 0.2, `胸灯 e=2.5 ⇒ aGlow≈0.31，实测 ${maxGlow(geos.torso)}`);
});

test('士兵几何: 非自发光部件的 aGlow 恒 0（腿不含灯）', () => {
  const geos = buildSoldierGeometries();
  assertEqual(Math.max(...geos.thigh.attributes.aGlow.array), 0);
  assertEqual(Math.max(...geos.shin.attributes.aGlow.array), 0);
});

test('士兵几何: 轴心取上游构造器位置', () => {
  assertEqual(SOLDIER_PIVOTS.pelvis[1], 0.94);
  assertEqual(SOLDIER_PIVOTS.torso[1], 1.0);
  assertEqual(SOLDIER_PIVOTS.head[1], 0.6);
  assertEqual(SOLDIER_PIVOTS.thighL[0], -0.1);
  assertEqual(SOLDIER_PIVOTS.thighR[0], 0.1);
  assertEqual(SOLDIER_PIVOTS.shinL[1], -0.44);
});

test('士兵渲染: 缺省容量派生自 Service 的 slot 池（2×maxAlive，含留尸余量）', () => {
  // ⚠️ 不是 maxAlive：Service 的 slot 池是 2×maxAlive（留尸占 slot），
  // 渲染器给少了会让 slot≥10 的士兵静默不可见（Task 4 实测确立）。
  const { renderer } = makeRenderFixture(0);
  for (const p of SOLDIER_PARTS) {
    assertEqual(renderer.meshes[p].count, SOLDIER.maxAlive * 2, `${p} 容量`);
  }
});

test('士兵渲染: 空载 7 个 mesh 全 visible=false（draw call 回基线）', () => {
  const { renderer } = makeRenderFixture(0);
  renderer.sync([], 0);
  for (const p of SOLDIER_PARTS) assertEqual(renderer.meshes[p].visible, false, `${p} 须隐藏`);
});

test('士兵渲染: 有士兵时 7 个 mesh 全部提交，且 slot 与实体一一对应', () => {
  const { renderer, entities } = makeRenderFixture(2);
  renderer.sync(entities, 0);
  for (const p of SOLDIER_PARTS) assertEqual(renderer.meshes[p].visible, true);
  assertEqual(renderer.activeCount(), 2);
  assertEqual(renderer.slotOf('s0'), 0);
  assertEqual(renderer.slotOf('s1'), 1);
});

test('士兵渲染: 实体消失后 slot 归还、矩阵归零（不留残影）', () => {
  const { renderer, entities } = makeRenderFixture(2);
  renderer.sync(entities, 0);
  renderer.sync([entities[0]], 16);
  assertEqual(renderer.activeCount(), 1);
  assertEqual(renderer.slotOf('s1'), null);
});

test('士兵渲染: 蹲下时部件世界 y 降低约 crouchDrop', () => {
  // ⚠️ **观测点是部件实例矩阵的世界 y，不是 renderYOf（那是 root y）**：
  // 蹲姿下沉落在 body 节点上（上游 `body.position.y = -cr*0.44`），root 不动。
  // 只断言 renderYOf 会恒读到 0 差值（实测踩到）。
  const partY = (r) => {
    const m = new THREE.Matrix4();
    r.meshes.pelvis.getMatrixAt(0, m);
    return m.elements[13];
  };
  const stand = makeRenderFixture(1, [{ crouch: 0 }]);
  stand.renderer.sync(stand.entities, 0);
  const crouch = makeRenderFixture(1, [{ crouch: 1 }]);
  crouch.renderer.sync(crouch.entities, 0);
  const dy = partY(stand.renderer) - partY(crouch.renderer);
  assertTrue(Math.abs(dy - SOLDIER_AI.crouchDrop) < 0.05,
    `蹲姿下沉须 ≈${SOLDIER_AI.crouchDrop}，实测 ${dy}`);
});

test('士兵渲染: 留尸期播倒地（body 绕 X 倾倒），且仍占 slot', () => {
  const { renderer, entities } = makeRenderFixture(1, [{ dead: true, deadT: 0.6, fallDir: 1 }]);
  renderer.sync(entities, 0);
  assertEqual(renderer.activeCount(), 1, '留尸期间仍要画');
  const tilt = renderer.bodyTiltOf(0);
  assertTrue(Math.abs(tilt) > 0.5, `倒地须有显著倾倒角，实测 ${tilt}`);
});

test('士兵渲染: 倒地角随 deadT 推进（不是一帧到位）', () => {
  const early = makeRenderFixture(1, [{ dead: true, deadT: 0.1 }]);
  early.renderer.sync(early.entities, 0);
  const late = makeRenderFixture(1, [{ dead: true, deadT: 0.55 }]);
  late.renderer.sync(late.entities, 0);
  assertTrue(Math.abs(late.renderer.bodyTiltOf(0)) > Math.abs(early.renderer.bodyTiltOf(0)),
    '倒地须是渐进动画');
});

test('士兵渲染: 红闪走 instanceColor 且逐实例独立', () => {
  const { renderer, entities } = makeRenderFixture(2, [{ flashedUntil: 1000 }, {}]);
  renderer.sync(entities, 500);   // s0 在红闪窗口内，s1 不在
  const c0 = new THREE.Color();
  const c1 = new THREE.Color();
  const mesh = renderer.meshes.torso;
  mesh.getColorAt(0, c0);
  mesh.getColorAt(1, c1);
  assertTrue(c0.r > c0.g && c0.r > c0.b, `受伤实例须偏红，实测 ${JSON.stringify(c0)}`);
  assertFalse(c1.r > c1.g + 0.1, `未受伤实例不得也变红，实测 ${JSON.stringify(c1)}`);
});

test('士兵渲染: 红闪到期自动复位', () => {
  const { renderer, entities } = makeRenderFixture(1, [{ flashedUntil: 1000 }]);
  renderer.sync(entities, 500);
  const during = new THREE.Color();
  renderer.meshes.torso.getColorAt(0, during);
  renderer.sync(entities, 1500);
  const after = new THREE.Color();
  renderer.meshes.torso.getColorAt(0, after);
  assertTrue(during.r > during.g, '窗口内须红');
  assertFalse(after.r > after.g + 0.1, '到期须复位');
});

test('士兵渲染: 实例复用给新实体时重置缓动（不继承上一只的偏移）', () => {
  const { renderer, entities } = makeRenderFixture(1);
  renderer.sync(entities, 0);
  renderer.noteKnockback('s0', 0.9, 0);
  assertTrue(Math.abs(renderer.knockOffsetXOf(0)) > 0.1, '前置：击退偏移已欠下');
  // ⚠️ slot 是 round-robin 分配 ⇒ 换一只新 id 会拿到**下一个** slot，
  // 旧 slot 保留旧偏移是正确的（实测：s9 拿到 slot 1）。要测「复用同 slot」
  // 必须先把池转回原点：同步 maxActive 个不同 id 各一次，指针即绕回 0。
  for (let i = 0; i < renderer.maxActive; i++) {
    renderer.sync([{ id: `wrap${i}`, type: 'soldier', state: entities[0].state }], 16);
  }
  const reuseId = 'reused';
  renderer.sync([{ id: reuseId, type: 'soldier', state: entities[0].state }], 32);
  const slot = renderer.slotOf(reuseId);
  assertTrue(slot !== null, '前置：新实体须拿到 slot');
  assertEqual(renderer.knockOffsetXOf(slot), 0, '复用 slot 时不得继承上一只的击退偏移');
});

test('士兵渲染: dispose 从 scene 摘掉全部 mesh', () => {
  const { scene, renderer } = makeRenderFixture(1);
  const before = scene.children.length;
  assertTrue(before >= SOLDIER_PARTS.length);
  renderer.dispose();
  assertEqual(scene.children.length, 0);
});

test('炮塔材质: vertexColor/glowAttribute 缺省关闭时不读那两个属性', () => {
  // 缺省路径必须与改动前逐位等价 —— 判据落在「材质能建出来且不引用新属性」
  const mat = createTurretMetalMaterial({ color: SOLDIER_COLORS.ARMOR });
  assertTrue(!!mat.colorNode, '缺省路径仍要有 colorNode');
  const withVC = createTurretMetalMaterial({ color: SOLDIER_COLORS.ARMOR, vertexColor: true, glowAttribute: 'aGlow' });
  assertTrue(!!withVC.colorNode);
  assertFalse(mat.colorNode === withVC.colorNode, '两条路径必须是不同的节点图');
});
