// src/tests/test-weapons.js — M4：武器纯逻辑层（catalog / policy / MAG7 扫描 / 控制器）
// 覆盖 M4 规格 §3/§4.2：冷却与 transform 目录冻结、不可破坏名单、
// MAG7「先过滤再计 40」扫描语义、单发/连射状态机、开关豁免。
import { test } from './runner.js';
import { assertEqual, assertFalse, assertTrue } from './assert.js';
import { createRegistry } from '../voxel/block-registry.js';
import {
  WEAPON_IDS, WEAPONS, MAX_ACTIVE_TRACERS,
} from '../player/weapons/weapon-catalog.js';
import { isWeaponDestructible, isMag7Candidate } from '../player/weapons/weapon-target-policy.js';
import { collectMag7Changes } from '../player/weapons/mag7-pattern.js';
import { WeaponController } from '../player/weapons/weapon-controller.js';

const WEAPON_BLOCK_NAMES = ['air', 'stone', 'water', 'bedrock', 'end_stone',
  'end_stone_bricks', 'playground_block', 'playground_center_block'];

function makeRegistryWithWeaponBlocks() {
  const registry = createRegistry();
  for (const name of WEAPON_BLOCK_NAMES) {
    registry.register(name, {
      solid: name !== 'air' && name !== 'water',
      cullMode: name === 'water' ? 'transparent' : 'opaque',
    });
  }
  registry.freeze();
  return {
    registry,
    ids: Object.fromEntries(WEAPON_BLOCK_NAMES.map((name) => [
      name === 'end_stone' ? 'endStone' : name === 'playground_block' ? 'playground' : name,
      registry.idOf(name),
    ])),
  };
}

function makeControllerFixture() {
  const { registry, ids } = makeRegistryWithWeaponBlocks();
  const editor = {
    singleCalls: 0,
    batchCalls: 0,
    lastChange: null,
    setBlock(change) { this.singleCalls++; this.lastChange = change; return { changes: [{}] }; },
    setBlocks(changes) { this.batchCalls++; this.lastBatch = changes; return { changes: [{}] }; },
  };
  const effects = [];
  const aim = {
    origin: [0, 0, 0], forward: [1, 0, 0], right: [0, 0, 1], up: [0, 1, 0],
    target: { hit: true, blockPos: [2, 0, 0], dist: 2 },
  };
  return {
    registry,
    ids,
    editor,
    aim,
    controller: new WeaponController({
      registry,
      blockQuery: { getBlockId: () => ids.stone },
      editor,
      onEffect: (effect) => effects.push(effect),
    }),
    effects,
  };
}

// ---------- catalog ----------

test('weapon catalog: 冷却/扫描/曳光池上限与 minigun YXZ 固定', () => {
  assertEqual(WEAPONS[WEAPON_IDS.PISTOL].cooldown, 0.09);
  assertEqual(WEAPONS[WEAPON_IDS.MAG7].cooldown, 1.5);
  assertEqual(WEAPONS[WEAPON_IDS.MINIGUN].cooldown, 0.07);
  assertEqual(WEAPONS[WEAPON_IDS.MAG7].scan.maxBlocks, 40);
  assertEqual(WEAPONS[WEAPON_IDS.MINIGUN].transform.rotationOrder, 'YXZ');
  assertEqual(MAX_ACTIVE_TRACERS, 32);
  assertFalse(WEAPONS[WEAPON_IDS.PISTOL].automatic === false);
  assertFalse(WEAPONS[WEAPON_IDS.MAG7].automatic === true);
});

test('weapon catalog: 递归冻结，渲染层不得改写玩法目录', () => {
  assertTrue(Object.isFrozen(WEAPONS));
  assertTrue(Object.isFrozen(WEAPONS[WEAPON_IDS.PISTOL].transform));
  assertTrue(Object.isFrozen(WEAPONS[WEAPON_IDS.PISTOL].transform.scale));
  assertTrue(Object.isFrozen(WEAPONS[WEAPON_IDS.MAG7].scan));
});

// ---------- policy ----------

test('weapon policy: bedrock/end_stone/创造台不可破坏，水与 end_stone_bricks 可破坏', () => {
  const { registry, ids } = makeRegistryWithWeaponBlocks();
  assertFalse(isWeaponDestructible(ids.bedrock, registry));
  assertFalse(isWeaponDestructible(ids.endStone, registry));
  assertFalse(isWeaponDestructible(ids.playground, registry));
  assertFalse(isWeaponDestructible(registry.idOf('playground_center_block'), registry));
  assertFalse(isWeaponDestructible(ids.air, registry));
  assertTrue(isWeaponDestructible(ids.stone, registry));
  assertTrue(isWeaponDestructible(ids.water, registry));
  assertTrue(isWeaponDestructible(registry.idOf('end_stone_bricks'), registry));
  // MAG7 候选与枪械破坏同一名单（M4 有意收紧：创造台两类方块也排除在 MAG7 外）
  assertFalse(isMag7Candidate(ids.playground, registry));
  assertTrue(isMag7Candidate(ids.water, registry));
});

// ---------- MAG7 扫描 ----------

test('MAG7: 3×3 扫描先过滤再计 40，水可删且创造台/end_stone/基岩不可删', () => {
  const { registry, ids } = makeRegistryWithWeaponBlocks();
  const query = {
    getBlockId: (x, y, z) => x === 3 && y === 0 && z === 0 ? ids.water
      : x === 4 && y === 0 && z === 0 ? ids.endStone
      : x === 5 && y === 0 && z === 0 ? ids.playground : ids.stone,
  };
  const changes = collectMag7Changes({
    origin: [0, 0, 0], forward: [1, 0, 0], right: [0, 0, 1], up: [0, 1, 0],
  }, query, registry);
  assertTrue(changes.length <= 40);
  // 水格 (3,0,0) 作为候选并删除（mc-lite 语义）
  assertTrue(changes.some((c) => c.x === 3 && c.y === 0 && c.z === 0 && c.id === 0));
  // 免疫名单的格位不出现在变更中。注意断言必须落到具体格位而非整个 x 列：
  // 扫描截面覆盖各 x 值的 3×3 邻域，(4,-1,0) 等邻格是 stone、合法入选。
  assertFalse(changes.some((c) => c.x === 4 && c.y === 0 && c.z === 0));
  assertFalse(changes.some((c) => c.x === 5 && c.y === 0 && c.z === 0));
  // 输出形状与距离组稳定排序
  for (const c of changes) assertEqual(c.meta, 0);
  for (let i = 1; i < changes.length; i++) {
    assertTrue(changes[i].group >= changes[i - 1].group);
  }
});

test('MAG7: 世界坐标去重（0.5 步长相邻采样同格只留一次）', () => {
  const { registry, ids } = makeRegistryWithWeaponBlocks();
  const query = { getBlockId: () => ids.stone };
  const changes = collectMag7Changes({
    origin: [0, 0, 0], forward: [1, 0, 0], right: [0, 0, 1], up: [0, 1, 0],
  }, query, registry);
  const keys = new Set(changes.map((c) => `${c.x},${c.y},${c.z}`));
  assertEqual(keys.size, changes.length, '无重复坐标');
});

// ---------- controller ----------

test('WeaponController: MAG7 单发且无视开关，手枪按住依冷却重复', () => {
  const { controller, editor, aim } = makeControllerFixture();
  controller.select('mag7');
  controller.setBlockDamage(false);
  controller.pointerDown(aim);
  controller.update(1.5, aim);
  assertEqual(editor.batchCalls, 1);
  controller.pointerUp(); controller.select('pistol');
  controller.setBlockDamage(true);
  controller.pointerDown(aim); controller.update(0.09, aim);
  assertEqual(editor.singleCalls, 2);
});

test('WeaponController: R 键循环四次回到徒手', () => {
  const { controller } = makeControllerFixture();
  assertEqual(controller.debugState().selectedId, 'arm');
  controller.cycle(); assertEqual(controller.debugState().selectedId, 'pistol');
  controller.cycle(); assertEqual(controller.debugState().selectedId, 'mag7');
  controller.cycle(); assertEqual(controller.debugState().selectedId, 'minigun');
  controller.cycle(); assertEqual(controller.debugState().selectedId, 'arm');
});

test('WeaponController: 开关关闭时手枪只阻挡不写世界，冷却期内不重复', () => {
  const { controller, editor, aim, effects } = makeControllerFixture();
  controller.select('pistol');
  controller.setBlockDamage(false);
  const fired = controller.fireOnce(aim);
  assertEqual(fired.length, 1);
  assertEqual(editor.singleCalls, 0);
  assertEqual(fired[0].end[0], 2); assertEqual(fired[0].end[1], 0); assertEqual(fired[0].end[2], 0);
  assertEqual(effects.length, 1);
  // 同一冷却期内再次 fireOnce → 空数组
  assertEqual(controller.fireOnce(aim).length, 0);
});

test('WeaponController: 开关开启且冷却结束后手枪删首个命中', () => {
  const { controller, editor, aim } = makeControllerFixture();
  controller.select('pistol');
  controller.setBlockDamage(true);
  controller.fireOnce(aim);
  controller.update(0.09, aim);
  const fired = controller.fireOnce(aim);
  assertEqual(fired.length, 1);
  assertEqual(editor.singleCalls, 2);
  assertEqual(editor.lastChange.x, 2);
  assertEqual(editor.lastChange.y, 0);
  assertEqual(editor.lastChange.z, 0);
  assertEqual(editor.lastChange.id, 0);
});

test('WeaponController: end_stone 命中曳光停在 target.dist 但不写世界', () => {
  const { registry, ids } = makeRegistryWithWeaponBlocks();
  const editor = {
    singleCalls: 0,
    setBlock() { this.singleCalls++; return { changes: [] }; },
    setBlocks() { return { changes: [] }; },
  };
  const controller = new WeaponController({
    registry,
    blockQuery: { getBlockId: () => ids.endStone },
    editor,
    onEffect: () => {},
  });
  controller.select('pistol');
  controller.setBlockDamage(true);
  const aim = {
    origin: [0, 0, 0], forward: [1, 0, 0], right: [0, 0, 1], up: [0, 1, 0],
    target: { hit: true, blockPos: [4, 0, 0], dist: 4 },
  };
  const fired = controller.fireOnce(aim);
  assertEqual(fired.length, 1);
  assertEqual(fired[0].end[0], 4);
  assertEqual(editor.singleCalls, 0);
});

test('WeaponController: 加特林按住连射，每个冷却周期一次', () => {
  const { controller, aim } = makeControllerFixture();
  controller.select('minigun');
  controller.pointerDown(aim);
  const afterDown = controller.debugState().shotsFired;
  assertEqual(afterDown, 1);
  controller.update(0.07, aim);
  assertEqual(controller.debugState().shotsFired, afterDown + 1);
  controller.update(0.07, aim);
  assertEqual(controller.debugState().shotsFired, afterDown + 2);
});

test('WeaponController: 无 DDA 命中时曳光终点为前方 40 格', () => {
  const { controller, aim } = makeControllerFixture();
  controller.select('pistol');
  const missed = { ...aim, target: { hit: false } };
  const fired = controller.fireOnce(missed);
  assertEqual(fired.length, 1);
  assertEqual(fired[0].end[0], 40);
});

test('WeaponController: 效果事件为纯对象且经 onEffect 送达', () => {
  const { controller, aim, effects } = makeControllerFixture();
  controller.select('pistol');
  const fired = controller.fireOnce(aim);
  assertEqual(effects.length, 1);
  const effect = fired[0];
  assertEqual(effect.type, 'shot');
  assertEqual(effect.weaponId, 'pistol');
  assertEqual(effect.sound, 'gun_fire');
  assertEqual(effect.tracer.color, 0xffff00);
  // start = origin + right*localStart[0] + up*localStart[1] - forward*localStart[2]
  // pistol localStart = [0.3, -0.33, -0.98]；fixture 基底 right=[0,0,1] up=[0,1,0] forward=[1,0,0]
  assertEqual(effect.start[0], 0.98);
  assertEqual(effect.start[1], -0.33);
  assertEqual(effect.start[2], 0.3);
});
