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
      // M8：bedrock 的「不可破坏」由 registry 单一权威提供（与 blocks-data.js 同口径）。
      // 本 fixture 只登记 bedrock 一项 —— playground 两项属 **M9**（登记 indestructible 与
      // 「移出背包」必须成对做），故此处不登记。
      indestructible: name === 'bedrock',
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

test('weapon policy: bedrock/end_stone 不可破坏；M8 期间创造台两项可破坏（M9 登记后翻转）', () => {
  const { registry, ids } = makeRegistryWithWeaponBlocks();
  assertFalse(isWeaponDestructible(ids.bedrock, registry));
  assertFalse(isWeaponDestructible(ids.endStone, registry));
  // ⚠️ M8 期间 playground 两项**不在** indestructibleTable → 枪械打得动
  // （M9 登记进表后这两条翻转回 assertFalse；M9 计划 Task 1 已认领该步骤）。
  assertTrue(isWeaponDestructible(ids.playground, registry));
  assertTrue(isWeaponDestructible(registry.idOf('playground_center_block'), registry));
  assertFalse(isWeaponDestructible(ids.air, registry));
  assertTrue(isWeaponDestructible(ids.stone, registry));
  assertTrue(isWeaponDestructible(ids.water, registry));
  assertTrue(isWeaponDestructible(registry.idOf('end_stone_bricks'), registry));
  // MAG7 候选与枪械破坏同一名单（M8 起创造台两项走 indestructibleTable → M9 才排除）
  assertTrue(isMag7Candidate(ids.playground, registry));
  assertTrue(isMag7Candidate(ids.water, registry));
});

// ---------- MAG7 扫描 ----------

test('MAG7: 3×3 扫描先过滤再计 40，水可删且 end_stone/基岩不可删（M8 期间创造台可删）', () => {
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
  // ⚠️ M8 期间 playground 不在 indestructibleTable → (5,0,0) 作为候选被删。
  // M9 登记两项后本条翻转回 assertFalse（M9 计划 Task 1 已认领）。
  assertTrue(changes.some((c) => c.x === 5 && c.y === 0 && c.z === 0));
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

// ---------- MAG7 曳光终点不变式（恒在准心轴上） ----------

/**
 * 把曳光终点相对 origin 分解到准心基底，得到 forward/right/up 三个分量。
 * 不变式：right 与 up 分量必须恒为 0 —— 终点一旦有横向/纵向分量，曳光就斜向偏转、
 * 与枪管方向不对齐（用户实玩报告的观感来源）。
 */
function decomposeEndOnAimAxis(aim, end) {
  const d = [end[0] - aim.origin[0], end[1] - aim.origin[1], end[2] - aim.origin[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return { forward: dot(d, aim.forward), right: dot(d, aim.right), up: dot(d, aim.up) };
}

test('MAG7: 准心无命中但邻格有方块时，曳光终点仍在准心轴上（不得斜向偏转）', () => {
  const { registry, ids } = makeRegistryWithWeaponBlocks();
  const editor = {
    batchCalls: 0,
    lastBatch: null,
    setBlock() { return { changes: [] }; },
    setBlocks(changes) { this.batchCalls++; this.lastBatch = changes; return { changes: [] }; },
  };
  const controller = new WeaponController({
    registry,
    // 正前方（forward=+X）整条射线全是空气；右邻格（right=+Z，z=1）是一片石墙。
    // MAG7 是 right/up 基底上 i,j∈{-1,0,1} 的 3×3 体积扫描，必然扫到右邻格 ——
    // 这正是用户报告的场景：准心没瞄到任何方块，射界内却击中了旁边的方块。
    blockQuery: {
      getBlockId: (x, y, z) => (z === 1 && x >= 1 && x <= 6 && y === 0 ? ids.stone : ids.air),
    },
    editor,
    onEffect: () => {},
  });
  controller.select('mag7');
  const aim = {
    origin: [0.5, 0.5, 0.5], forward: [1, 0, 0], right: [0, 0, 1], up: [0, 1, 0],
    target: null, // 准心射线无命中（正前方全空气）
  };
  const fired = controller.fireOnce(aim);
  assertEqual(fired.length, 1);
  // 前置断言：复现条件确实成立（候选存在、且首个候选偏离准心轴）——
  // 否则下面的不变式断言根本不触发被测分支，会恒真。
  assertTrue(editor.lastBatch.length > 0, '右邻格石墙必须产生候选');
  const first = editor.lastBatch[0];
  assertTrue(first.y !== 0 || first.z !== 0, '首个候选必须偏离准心轴');
  const axis = decomposeEndOnAimAxis(aim, fired[0].end);
  assertEqual(axis.right, 0, '终点横向分量必须为 0');
  assertEqual(axis.up, 0, '终点纵向分量必须为 0');
  assertEqual(axis.forward, 10, '准心无命中 → 终点为前方 10 格（mc-lite raycaster.far=10）');
});

test('MAG7: 准心命中时曳光终点停在 target.dist 且仍在准心轴上', () => {
  const { registry, ids } = makeRegistryWithWeaponBlocks();
  const controller = new WeaponController({
    registry,
    blockQuery: { getBlockId: () => ids.stone },
    editor: { setBlock() {}, setBlocks() { return { changes: [] }; } },
    onEffect: () => {},
  });
  controller.select('mag7');
  const aim = {
    origin: [0, 0, 0], forward: [1, 0, 0], right: [0, 0, 1], up: [0, 1, 0],
    target: { hit: true, blockPos: [3, 0, 0], dist: 3 },
  };
  const fired = controller.fireOnce(aim);
  const axis = decomposeEndOnAimAxis(aim, fired[0].end);
  assertEqual(axis.forward, 3, '终点距离 = 准心命中距离');
  assertEqual(axis.right, 0);
  assertEqual(axis.up, 0);
});

test('MAG7: 准心命中超出扫描范围时曳光终点钳到 10 格', () => {
  const { registry, ids } = makeRegistryWithWeaponBlocks();
  const controller = new WeaponController({
    registry,
    blockQuery: { getBlockId: () => ids.stone },
    editor: { setBlock() {}, setBlocks() { return { changes: [] }; } },
    onEffect: () => {},
  });
  controller.select('mag7');
  // 主 DDA 的 REACH 是 40 格，远大于 MAG7 的 1~10 格扫描范围
  const aim = {
    origin: [0, 0, 0], forward: [1, 0, 0], right: [0, 0, 1], up: [0, 1, 0],
    target: { hit: true, blockPos: [25, 0, 0], dist: 25 },
  };
  const fired = controller.fireOnce(aim);
  const axis = decomposeEndOnAimAxis(aim, fired[0].end);
  assertEqual(axis.forward, 10, '终点钳到 MAG7 扫描范围上限');
  assertEqual(axis.right, 0);
  assertEqual(axis.up, 0);
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

// ---------- M6：实体伤害、最近命中与遮挡 ----------

test('weapon catalog: M6 实体伤害与射程六个冻结数值', () => {
  // M6 规格 §1 表格逐项对齐 mc-lite。这些数值是**玩法契约**（手枪四发死、加特林三发死、
  // MAG7 一击死），改错了玩家立刻能感觉出来，但没人会主动发现 —— 故用门禁断言钉住。
  assertEqual(WEAPONS[WEAPON_IDS.PISTOL].entityDamage, 25);
  assertEqual(WEAPONS[WEAPON_IDS.PISTOL].entityRange, 40);
  assertEqual(WEAPONS[WEAPON_IDS.MINIGUN].entityDamage, 35);
  assertEqual(WEAPONS[WEAPON_IDS.MINIGUN].entityRange, 40);
  assertEqual(WEAPONS[WEAPON_IDS.MAG7].entityDamage, 999);
  assertEqual(WEAPONS[WEAPON_IDS.MAG7].entityRange, 10);
  // 生命 100 口径的推论：手枪 4 发、加特林 3 发、MAG7 1 发致死
  assertEqual(Math.ceil(100 / WEAPONS[WEAPON_IDS.PISTOL].entityDamage), 4);
  assertEqual(Math.ceil(100 / WEAPONS[WEAPON_IDS.MINIGUN].entityDamage), 3);
  assertEqual(Math.ceil(100 / WEAPONS[WEAPON_IDS.MAG7].entityDamage), 1);
  // MAG7 实体射程必须等于其方块扫描上限（同一把枪的两个射程口径不得漂移）
  assertEqual(WEAPONS[WEAPON_IDS.MAG7].entityRange, WEAPONS[WEAPON_IDS.MAG7].scan.max);
  // 新增字段同样递归冻结（渲染层不得改写玩法目录）
  assertTrue(Object.isFrozen(WEAPONS[WEAPON_IDS.PISTOL]));
});

/**
 * 实体命中 fixture：可控的实体命中距离 + DDA 方块距离，记录 raycast 查询与 damage 调用。
 *
 * fake `raycast` **模拟 `EntityManager.raycast` 的 maxDist 裁剪语义**（dist > maxDist 返回
 * null）—— 若 fake 不裁剪，「MAG7 10.1 格不伤害」这条断言会因 fake 总是返回命中而恒过，
 * 测不出 controller 是否真的把 entityRange 传给了查询（testing-policy §2.5）。
 *
 * @param {{entityDist?: number|null, blockDist?: number, entityId?: string}} [opts]
 */
function makeEntityControllerFixture({ entityDist = null, blockDist = 4, entityId = 'z0' } = {}) {
  const { registry, ids } = makeRegistryWithWeaponBlocks();
  const editor = {
    singleCalls: 0,
    batchCalls: 0,
    setBlock(change) { this.singleCalls++; this.lastChange = change; return { changes: [{}] }; },
    setBlocks(changes) { this.batchCalls++; this.lastBatch = changes; return { changes: [{}] }; },
  };
  /** @type {Array<{origin:number[], dir:number[], maxDist:number, predicate:Function}>} */
  const raycastCalls = [];
  /** @type {Array<{id:string, amount:number, nowMs:number}>} */
  const damageCalls = [];
  const entityQuery = {
    raycast(origin, dir, maxDist, predicate) {
      raycastCalls.push({ origin, dir, maxDist, predicate });
      if (entityDist === null) return null;
      if (entityDist > maxDist) return null; // 模拟真实 raycast 的 maxDist 裁剪
      return {
        id: entityId, type: 'zombie', dist: entityDist,
        point: [origin[0] + dir[0] * entityDist, origin[1] + dir[1] * entityDist, origin[2] + dir[2] * entityDist],
      };
    },
    damage(id, amount, nowMs) {
      damageCalls.push({ id, amount, nowMs });
      return { dead: amount >= 100, health: Math.max(0, 100 - amount) };
    },
  };
  const effects = [];
  const aim = {
    origin: [0, 0, 0], forward: [1, 0, 0], right: [0, 0, 1], up: [0, 1, 0],
    target: blockDist === Infinity
      ? { hit: false }
      : { hit: true, blockPos: [Math.round(blockDist), 0, 0], dist: blockDist },
  };
  const controller = new WeaponController({
    registry,
    blockQuery: { getBlockId: () => ids.stone },
    editor,
    onEffect: (effect) => effects.push(effect),
  });
  controller.setEntityQuery(entityQuery);
  controller.select('pistol');
  return { registry, ids, controller, aim, effects, editor, raycastCalls, damageCalls };
}

test('WeaponController: 近实体优先 —— 实体比方块近时扣血并发 entity-hit', () => {
  // 实体 dist=2 < DDA dist=4 → 实体受伤
  const { controller, aim, raycastCalls, damageCalls, editor } =
    makeEntityControllerFixture({ entityDist: 2, blockDist: 4 });
  controller.setBlockDamage(true); // 开关开启：方块也可破坏（用来证明方块没被写）
  const fired = controller.fireOnce(aim);
  assertEqual(damageCalls.length, 1, '近实体必须扣血');
  assertEqual(damageCalls[0].id, 'z0');
  assertEqual(damageCalls[0].amount, WEAPONS[WEAPON_IDS.PISTOL].entityDamage);
  assertTrue(Number.isFinite(damageCalls[0].nowMs), 'nowMs 必须是有限数（红闪判定依据）');
  // 更近的实体挡在前面 → 方块不被写世界（实体遮挡方块）
  assertEqual(editor.singleCalls, 0, '实体更近时不得写方块');
  // 效果事件口径
  assertEqual(fired.length, 1);
  assertEqual(fired[0].type, 'entity-hit');
  assertEqual(fired[0].entityId, 'z0');
  assertEqual(fired[0].entityDamage, 25);
  // 曳光终点落在实体命中点（不是方块、不是 MISS_RANGE）
  assertEqual(fired[0].end[0], 2);
  // 查询用该枪的 entityRange 作 maxDist，且 predicate 过滤 zombie 类型
  assertEqual(raycastCalls.length, 1);
  assertEqual(raycastCalls[0].maxDist, WEAPONS[WEAPON_IDS.PISTOL].entityRange);
  assertTrue(raycastCalls[0].predicate({ type: 'zombie' }) === true);
  assertTrue(raycastCalls[0].predicate({ type: 'probe' }) === false, 'predicate 须只放行 zombie');
});

test('WeaponController: 近方块阻挡 —— 方块比实体近时不扣血', () => {
  // 实体 dist=5 > DDA dist=4 → 方块挡住，实体不受伤（实体不得穿墙）
  const { controller, aim, damageCalls, editor } =
    makeEntityControllerFixture({ entityDist: 5, blockDist: 4 });
  controller.setBlockDamage(true);
  controller.fireOnce(aim);
  assertEqual(damageCalls.length, 0, '方块更近时不得扣血');
  assertEqual(editor.singleCalls, 1, '方块命中照常写世界');
});

test('WeaponController: 距离相等按方块优先（保证实体不穿墙）', () => {
  const { controller, aim, damageCalls, editor } =
    makeEntityControllerFixture({ entityDist: 4, blockDist: 4 });
  controller.setBlockDamage(true);
  const fired = controller.fireOnce(aim);
  assertEqual(damageCalls.length, 0, '相等距离按方块优先');
  assertEqual(editor.singleCalls, 1);
  assertEqual(fired[0].type, 'shot', '相等距离不发 entity-hit');
});

test('WeaponController: 无方块命中时实体仍可受伤（DDA 距离为 Infinity）', () => {
  const { controller, aim, damageCalls } =
    makeEntityControllerFixture({ entityDist: 3, blockDist: Infinity });
  controller.fireOnce(aim);
  assertEqual(damageCalls.length, 1, '无方块阻挡 → 实体受伤');
});

test('WeaponController: setEntityQuery 校验函数签名，残缺查询降级为 null', () => {
  // **必须钉住校验分支**（自查发现的盲区）：注入「缺函数校验仍赋值」时，残缺的 query 会被
  // 存下来，后续开火调到不存在的 `.raycast` 才崩 —— 崩点离缺陷很远，难定位。
  // 校验让残缺注入**当场降级为 null**（等同未接线），开火照常，错误不扩散。
  const { registry, ids } = makeRegistryWithWeaponBlocks();
  const editor = { singleCalls: 0, setBlock() { this.singleCalls++; return { changes: [{}] }; }, setBlocks() {} };
  const controller = new WeaponController({
    registry, blockQuery: { getBlockId: () => ids.stone }, editor, onEffect: () => {},
  });
  // 残缺注入：只有 raycast 没有 damage
  assertEqual(controller.setEntityQuery({ raycast: () => null }), null);
  assertEqual(controller.entityQuery, null, '残缺查询须降级为 null');
  // 只有 damage 没有 raycast
  assertEqual(controller.setEntityQuery({ damage: () => null }), null);
  // null / 非对象
  assertEqual(controller.setEntityQuery(null), null);
  assertEqual(controller.setEntityQuery('not an object'), null);
  // 完整注入才生效
  const full = { raycast: () => null, damage: () => null };
  assertEqual(controller.setEntityQuery(full), full);
  assertEqual(controller.entityQuery, full);
});

test('WeaponController: 未注入 entityQuery 时不查实体（向后兼容徒手/无丧尸场景）', () => {
  const { registry, ids } = makeRegistryWithWeaponBlocks();
  const editor = { singleCalls: 0, setBlock() { this.singleCalls++; return { changes: [{}] }; }, setBlocks() {} };
  const controller = new WeaponController({
    registry, blockQuery: { getBlockId: () => ids.stone }, editor, onEffect: () => {},
  });
  controller.select('pistol');
  const aim = { origin: [0, 0, 0], forward: [1, 0, 0], right: [0, 0, 1], up: [0, 1, 0], target: { hit: false } };
  const fired = controller.fireOnce(aim);
  assertEqual(fired.length, 1, '未接线实体查询时仍可正常开火');
  assertEqual(fired[0].type, 'shot');
});

test('WeaponController: MAG7 实体射程 10 —— 9.9 格一击致死，10.1 格不查询不伤害', () => {
  // 9.9 格：命中 → 999 伤害一击致死，且仍执行其原有的一次方块批量扫描
  const near = makeEntityControllerFixture({ entityDist: 9.9, blockDist: Infinity });
  near.controller.select('mag7');
  near.controller.fireOnce(near.aim);
  assertEqual(near.damageCalls.length, 1);
  assertEqual(near.damageCalls[0].amount, WEAPONS[WEAPON_IDS.MAG7].entityDamage);
  assertEqual(near.editor.batchCalls, 1, 'MAG7 仍执行一次 setBlocks（不是 projectile）');
  assertEqual(near.raycastCalls[0].maxDist, 10, 'MAG7 实体查询 maxDist 固定 10');
  assertEqual(near.effects[0].type, 'entity-hit');

  // 10.1 格：超出 entityRange → 查询裁剪掉，不伤害；方块扫描照常
  const far = makeEntityControllerFixture({ entityDist: 10.1, blockDist: Infinity });
  far.controller.select('mag7');
  far.controller.fireOnce(far.aim);
  assertEqual(far.damageCalls.length, 0, '10.1 格不得伤害');
  assertEqual(far.editor.batchCalls, 1, '方块扫描不受实体射程影响');
  assertEqual(far.effects[0].type, 'shot');
});

test('WeaponController: 加特林实体伤害 35，三发致死', () => {
  const { controller, aim, damageCalls } = makeEntityControllerFixture({ entityDist: 2, blockDist: Infinity });
  controller.select('minigun');
  controller.fireOnce(aim);
  assertEqual(damageCalls.length, 1);
  assertEqual(damageCalls[0].amount, WEAPONS[WEAPON_IDS.MINIGUN].entityDamage);
});
