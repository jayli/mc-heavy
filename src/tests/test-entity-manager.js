// src/tests/test-entity-manager.js — M5：实体运行时纯逻辑层（manager / generation / column 索引 / AABB）
// 覆盖 M5 规格 §2/§3：唯一 id、最近 AABB 命中、临时实体随 column 卸载回收、
// generation 拒绝迟到异步回包、派生 column 索引跟随 position。
// 本文件与 entity-manager.js 同属同构层（无 DOM、无 three）——可在浏览器内直接跑。
import { test } from './runner.js';
import { assertEqual, assertFalse, assertNull, assertTrue, assertThrows, assertDeepEqual } from './assert.js';
import { EntityManager } from '../entities/entity-manager.js';
import { probeDefinition, PROBE_AABB } from '../entities/entity-types.js';

/** 舍入到 1e-6：抵消 IEEE754 累加噪声，让派生量可与字面量比对（testing-policy §2.5） */
function round6(v) { return Math.round(v * 1e6) / 1e6; }

function makeProbeManager() {
  const manager = new EntityManager();
  manager.registerType('probe', probeDefinition);
  return manager;
}

test('EntityManager: 唯一 id、最近 AABB 和 column 卸载', () => {
  const m = makeProbeManager();
  assertTrue(m.spawn({ id: 'near', type: 'probe', state: { position: [0, 0, -3] } }) !== null);
  assertEqual(m.spawn({ id: 'near', type: 'probe', state: { position: [0, 0, -4] } }), null);
  assertTrue(m.spawn({ id: 'far', type: 'probe', state: { position: [0, 0, -6] } }) !== null);
  assertEqual(m.raycast([0, 1, 0], [0, 0, -1], 40).id, 'near');
  assertEqual(m.despawnColumn('0,-1', 'column-unloaded'), 2);
  assertEqual(m.count('probe'), 0);
});

test('EntityManager: generation 拒绝已销毁 id 的迟到结果', () => {
  const m = makeProbeManager();
  const first = m.spawn({ id: 'same', type: 'probe', state: { position: [0, 0, 0] } });
  m.despawn('same', 'test');
  const second = m.spawn({ id: 'same', type: 'probe', state: { position: [1, 0, 0] } });
  assertTrue(second.generation > first.generation);
  assertFalse(m.applyAsyncPose({ id: 'same', generation: first.generation, position: [9, 0, 0] }));
  assertDeepEqual(m.get('same').state.position, [1, 0, 0]);
});

test('EntityManager: 未注册类型与非法 state 不产生实体', () => {
  const m = makeProbeManager();
  assertNull(m.spawn({ id: 'a', type: 'ghost', state: { position: [0, 0, 0] } }), '未注册类型');
  assertNull(m.spawn({ id: 'b', type: 'probe', state: { position: [0, 0] } }), '缺 z 分量');
  assertNull(m.spawn({ id: 'c', type: 'probe', state: { position: [0, NaN, 0] } }), '非有限数');
  assertNull(m.spawn({ id: 'd', type: 'probe', state: null }), '无 state');
  assertEqual(m.count('probe'), 0);
  assertEqual([...m.entities()].length, 0);
  assertEqual(m.raycast([0, 1, 0], [0, 0, -1], 40), null);
});

test('EntityManager: 重复注册同一 type 抛错', () => {
  const m = makeProbeManager();
  assertThrows(() => m.registerType('probe', probeDefinition), 'probe');
});

test('EntityManager: despawnColumn 只回收临时实体，持久实体保留', () => {
  const m = makeProbeManager();
  m.spawn({ id: 'temp', type: 'probe', state: { position: [0, 0, 0] } });
  m.spawn({ id: 'durable', type: 'probe', persistent: true, state: { position: [1, 0, 1] } });
  assertEqual(m.despawnColumn('0,0', 'column-unloaded'), 1);
  assertNull(m.get('temp'));
  assertTrue(m.get('durable') !== null);
  assertEqual(m.count('probe'), 1);
});

test('EntityManager: AABB 未命中、超距与 predicate 过滤', () => {
  const m = makeProbeManager();
  const pos = [0, 0, -3];
  m.spawn({ id: 'p', type: 'probe', state: { position: pos } });
  // 射线沿 +X，永远不进 z=-3 的盒
  assertNull(m.raycast([0, 1, 0], [1, 0, 0], 40));
  // predicate 排除该类型 → 无命中
  assertNull(m.raycast([0, 1, 0], [0, 0, -1], 40, (e) => e.type !== 'probe'));

  // 命中距离 = 盒正面（position + aabb.max）到起点的距离。**从 PROBE_AABB 派生**而非硬编码
  // 2.7：硬编码被测代码写入的那个值会让「AABB 改错但关系式仍成立」的缺陷恒过
  // （docs/testing-policy.md §2.5）。舍入到 1e-6 抵消 IEEE754 累加噪声（-3+0.3 ≠ 字面量 2.7）。
  const origin = [0, 1, 0];
  const dir = [0, 0, -1];
  const expectedDist = round6(-(pos[2] + PROBE_AABB.max[2] - origin[2]));
  const hit = m.raycast(origin, dir, 40);
  assertEqual(hit.type, 'probe');
  assertEqual(round6(hit.dist), expectedDist);
  // 不变式：命中点必须落在射线上（point = origin + dir*dist）—— 这是 raycast 契约本身
  assertDeepEqual(hit.point.map(round6), origin.map((o, i) => round6(o + dir[i] * hit.dist)));
  // 距离上限小于命中距离 → 不命中（maxDist 真的参与了裁剪，不是摆设）
  assertNull(m.raycast(origin, dir, expectedDist - 0.01));
});

test('EntityManager: 派生 column 索引跟随 position 迁移', () => {
  const m = makeProbeManager();
  const e = m.spawn({ id: 'walker', type: 'probe', state: { position: [0, 0, 0] } });
  assertEqual([...m.entitiesInColumn('0,0')].length, 1);
  assertTrue(m.applyAsyncPose({ id: 'walker', generation: e.generation, position: [40, 0, 0] }));
  assertEqual([...m.entitiesInColumn('0,0')].length, 0, '旧 column 索引必须清空');
  assertEqual([...m.entitiesInColumn('2,0')].length, 1, '新 column 索引必须收录');
  assertDeepEqual(m.get('walker').state.position, [40, 0, 0]);
});

test('EntityManager: despawn 返回值与不存在 id 的查询口径', () => {
  const m = makeProbeManager();
  m.spawn({ id: 'x', type: 'probe', state: { position: [0, 0, 0] } });
  assertTrue(m.despawn('x', 'test'));
  assertFalse(m.despawn('x', 'test'), '重复 despawn 同一 id');
  assertFalse(m.despawn('never', 'test'));
  assertNull(m.get('never'));
  assertFalse(m.applyAsyncPose({ id: 'never', generation: 1, position: [0, 0, 0] }));
});

// ---------- M5 Task 2：持久 snapshot 与两阶段卸载（manager 侧） ----------

test('EntityManager: serializePersistent 只含持久实体', () => {
  const m = makeProbeManager();
  m.spawn({ id: 'durable', type: 'probe', persistent: true, state: { position: [0.5, 1, 0.5] } });
  m.spawn({ id: 'temp', type: 'probe', state: { position: [1.5, 1, 0.5] } });
  const snaps = m.serializePersistent();
  assertEqual(snaps.length, 1);
  assertEqual(snaps[0].id, 'durable');
  assertEqual(snaps[0].type, 'probe');
  assertDeepEqual(snaps[0].state.position, [0.5, 1, 0.5]);
  // snapshot 形状严格为 {id,type,state}（M5 规格 §3）—— 多余字段会进 IndexedDB
  assertDeepEqual(Object.keys(snaps[0]).sort(), ['id', 'state', 'type']);
});

test('EntityManager: restorePersistent 忽略未注册类型与非法 state，已存在 id 不重复恢复', () => {
  const m = makeProbeManager();
  const result = m.restorePersistent([
    { id: 'ok', type: 'probe', state: { position: [0, 0, 0] } },
    { id: 'bad-type', type: 'ghost', state: { position: [1, 0, 0] } },
    { id: 'bad-state', type: 'probe', state: { position: [2, 0] } },
    { id: 'no-state', type: 'probe' },
    null,
    { id: 'ok', type: 'probe', state: { position: [9, 9, 9] } }, // 重复 id
  ]);
  assertEqual(result.restored, 1);
  assertEqual(result.skipped, 5);
  assertTrue(m.get('ok') !== null);
  assertNull(m.get('bad-type'));
  assertNull(m.get('bad-state'));
  assertNull(m.get('no-state'));
  // 重复 id 的那条不得覆盖已恢复的位置（「恰好恢复一次」）
  assertDeepEqual(m.get('ok').state.position, [0, 0, 0]);
  // 恢复的实体必须是持久实体 —— 否则下次卸载不写盘，永久丢失
  assertTrue(m.get('ok').persistent);
  assertEqual(m.count('probe'), 1);
});

test('EntityManager: beginColumnUnload 冻结持久实体并给出 snapshot，cancel 解冻不复制 state', () => {
  const m = makeProbeManager();
  const durable = m.spawn({ id: 'durable', type: 'probe', persistent: true, state: { position: [0.5, 1, 0.5] } });
  m.spawn({ id: 'temp', type: 'probe', state: { position: [1.5, 1, 0.5] } });
  const unload = m.beginColumnUnload('0,0');
  assertDeepEqual(unload.snapshots.map((s) => s.id), ['durable']);
  assertTrue(durable.frozen, '持久实体在准备期间冻结');
  assertTrue(m.get('temp') !== null, '临时实体在准备期间仍保留');
  unload.cancel();
  assertFalse(m.get('durable').frozen, 'cancel 解冻');
  assertTrue(m.get('durable') !== null, 'cancel 保留运行时实体');
  assertTrue(m.get('temp') !== null);
});

test('EntityManager: beginColumnUnload 的 commit 先失效 generation，再回收持久与临时实体', () => {
  const m = makeProbeManager();
  const durable = m.spawn({ id: 'durable', type: 'probe', persistent: true, state: { position: [0.5, 1, 0.5] } });
  m.spawn({ id: 'temp', type: 'probe', state: { position: [1.5, 1, 0.5] } });
  const unload = m.beginColumnUnload('0,0');
  assertEqual(unload.commit(), 2, '持久 + 临时都回收');
  assertNull(m.get('durable'));
  assertNull(m.get('temp'));
  assertEqual(m.count('probe'), 0);
  // 迟到回包不得命中已回收的实体（generation 已失效）
  assertFalse(m.applyAsyncPose({ id: 'durable', generation: durable.generation, position: [1, 1, 1] }));
  // 同 id 重新 spawn 的代数必须高于旧实例 —— 旧回包即使 id 又存在也匹配不上
  const reborn = m.spawn({ id: 'durable', type: 'probe', persistent: true, state: { position: [0, 0, 0] } });
  assertTrue(reborn.generation > durable.generation);
  assertFalse(m.applyAsyncPose({ id: 'durable', generation: durable.generation, position: [1, 1, 1] }));
  assertDeepEqual(m.get('durable').state.position, [0, 0, 0]);
});

test('EntityManager: 冻结的持久实体在 update 期间不被推进（state 冻结）', () => {
  const m = makeProbeManager();
  // 用一个会移动的 definition 才能证明「冻结真的生效」；probe 的 update 是 no-op，
  // 拿它测冻结会恒真（testing-policy §2.5：断言必须触发被测分支）
  let ticks = 0;
  m.registerType('mover', {
    ...probeDefinition,
    update: (entity) => { ticks++; return { position: [entity.state.position[0] + 1, 0, 0] }; },
  });
  const mover = m.spawn({ id: 'mover', type: 'mover', persistent: true, state: { position: [0, 0, 0] } });
  const unload = m.beginColumnUnload('0,0');
  const before = ticks;
  m.update(1 / 60, {});
  assertEqual(ticks, before, '冻结期间 definition.update 不得被调用');
  assertDeepEqual(m.get('mover').state.position, [0, 0, 0]);
  unload.cancel();
  m.update(1 / 60, {});
  assertEqual(ticks, before + 1, '解冻后恢复推进');
  assertTrue(mover.frozen === false);
});
