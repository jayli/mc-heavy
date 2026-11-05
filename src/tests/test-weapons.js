// src/tests/test-weapons.js — M4：武器纯逻辑层（catalog / policy / MAG7 扫描 / 控制器）
// 覆盖 M4 规格 §3/§4.2：冷却与 transform 目录冻结、不可破坏名单、
// MAG7「先过滤再计 40」扫描语义、单发/连射状态机、开关豁免。
import { test } from './runner.js';
import { assertEqual, assertFalse, assertTrue, assertDeepEqual } from './assert.js';
import { WEAPON_HITTABLE_TYPES } from '../entities/entity-types.js';
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
      // 不可破坏由 registry 单一权威提供，本 fixture 与 `blocks-data.js` 同口径：
      // M8 登记 bedrock，**M9 追加创造台两项**（登记 indestructible 与「移出背包」成对做）。
      // ⚠️ fixture 漏标会让下面几条断言「照抄计划的翻转」后假失败 —— 两侧必须同步。
      indestructible: name === 'bedrock' || name === 'playground_block'
        || name === 'playground_center_block',
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
  // ⚠️ **M9 翻转**：创造台两项已登记进 indestructibleTable → 枪械打不动平台本体
  // （M8 期间这两条曾是 assertTrue —— 同一事实在两个 Epic 的不同状态，不是矛盾）。
  assertFalse(isWeaponDestructible(ids.playground, registry));
  assertFalse(isWeaponDestructible(registry.idOf('playground_center_block'), registry));
  assertFalse(isWeaponDestructible(ids.air, registry));
  assertTrue(isWeaponDestructible(ids.stone, registry));
  assertTrue(isWeaponDestructible(ids.water, registry));
  assertTrue(isWeaponDestructible(registry.idOf('end_stone_bricks'), registry));
  // MAG7 候选与枪械破坏同一名单（创造台两项走 indestructibleTable → 不是候选）
  assertFalse(isMag7Candidate(ids.playground, registry));
  assertTrue(isMag7Candidate(ids.water, registry));
});

// ---------- MAG7 扫描 ----------

test('MAG7: 3×3 扫描先过滤再计 40，水可删且 end_stone/基岩/创造台不可删', () => {
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
  // ⚠️ **M9 翻转**：playground 已登记进 indestructibleTable → (5,0,0) 不作为候选被删
  // （M8 期间本条曾是 assertTrue —— 平台本体可被 MAG7 打掉是撕裂状态）。
  assertFalse(changes.some((c) => c.x === 5 && c.y === 0 && c.z === 0));
  // 输出形状与**由命中点向外**的排序
  for (const c of changes) assertEqual(c.meta, 0);
  // ⚠️ v1.67 改：排序键从「距离组」改为**到命中点的真实几何距离**。
  // 距离组 `floor((d-1)/2)` 是沿**视线**的采样距离，同组内 3×3 截面的九格彼此距离差很大
  // （实测相邻两项 1.732 → 1.414，反而变近了）—— 白闪波浪直接沿用它时观感是
  // 「先向外扩散一小圈又收回来」。破坏行为不受影响（只依赖哪些格被删，不依赖次序）。
  // 无 target 时基准点退回相机原点。
  for (let i = 1; i < changes.length; i++) {
    assertTrue(changes[i].centerDist >= changes[i - 1].centerDist - 1e-9,
      `须按到命中点的距离非递减：第 ${i} 项 ${changes[i].centerDist} < 前一项 ${changes[i - 1].centerDist}`);
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

// ---------- 命中特效的 effect 契约（枪击方块消失特效 v1.64） ----------
//
// controller 只负责**报告发生了什么**（纯数据），渲染在 `render/block-hit-fx.js`。
// 这三条钉住「谁触发了效果、命中面从哪来、破坏关闭时怎么区分」。

test('impact: 手枪命中方块时事件带 impacts（命中面、方块 id、未破坏）', () => {
  const { registry, ids } = makeRegistryWithWeaponBlocks();
  const editor = { setBlock() { return { changes: [] }; }, setBlocks() { return { changes: [] }; } };
  const controller = new WeaponController({
    registry, blockQuery: { getBlockId: () => ids.stone }, editor, onEffect: () => {},
  });
  controller.select('pistol');
  controller.setBlockDamage(false);   // 默认档：方块不消失
  const aim = {
    origin: [0, 0, 0], forward: [1, 0, 0], right: [0, 0, 1], up: [0, 1, 0],
    // normal 是命中面法线：DDA 沿 +x 打到 (2,0,0) 的 -x 面 → 法线 [-1,0,0]
    target: { hit: true, blockPos: [2, 0, 0], normal: [-1, 0, 0], dist: 2 },
  };
  const effect = controller.fireOnce(aim)[0];
  assertEqual(effect.impacts.length, 1);
  const impact = effect.impacts[0];
  assertEqual(impact.blockPos.join(','), '2,0,0');
  assertEqual(impact.normal.join(','), '-1,0,0');
  assertEqual(impact.blockId, ids.stone);
  // 破坏关闭 → destroyed=false（渲染层据此只出白闪 + 少量粉尘，不出整簇碎块）
  assertFalse(impact.destroyed);
});

test('impact: 破坏开启时 destroyed=true，且 id 为被删方块（不是 air）', () => {
  const { controller, aim } = makeControllerFixture();
  controller.select('pistol');
  controller.setBlockDamage(true);
  const effect = controller.fireOnce(aim)[0];
  assertEqual(effect.impacts.length, 1);
  assertTrue(effect.impacts[0].destroyed, '真删了方块须报告 destroyed=true');
  // ⚠️ 必须是**删除前**读到的 id —— 写成删除后再读会恒为 air，碎块颜色会变成石头默认色
  // （静默：特效照常播，只是颜色与方块无关）。
  assertEqual(effect.impacts[0].blockId, controller.registry.idOf('stone'));
});

test('impact: 打不动的方块（end_stone）不报告 destroyed', () => {
  const { registry, ids } = makeRegistryWithWeaponBlocks();
  const editor = { setBlock() { return { changes: [] }; }, setBlocks() { return { changes: [] }; } };
  const controller = new WeaponController({
    registry, blockQuery: { getBlockId: () => ids.endStone }, editor, onEffect: () => {},
  });
  controller.select('pistol');
  controller.setBlockDamage(true);
  const effect = controller.fireOnce({
    origin: [0, 0, 0], forward: [1, 0, 0], right: [0, 0, 1], up: [0, 1, 0],
    target: { hit: true, blockPos: [4, 0, 0], normal: [-1, 0, 0], dist: 4 },
  })[0];
  assertEqual(effect.impacts.length, 1);
  assertFalse(effect.impacts[0].destroyed);
});

test('impact: 未命中任何方块时不产出 impacts（空气射击不得凭空出特效）', () => {
  const { controller, aim } = makeControllerFixture();
  controller.select('pistol');
  const effect = controller.fireOnce({ ...aim, target: { hit: false } })[0];
  assertEqual(effect.impacts.length, 0);
});

test('impact: 命中实体（未碰方块）时不产出 impacts', () => {
  const near = makeEntityControllerFixture({ entityDist: 2, blockDist: Infinity });
  near.controller.select('pistol');
  const effect = near.controller.fireOnce(near.aim)[0];
  assertEqual(effect.type, 'entity-hit');
  assertEqual(effect.impacts.length, 0, '打丧尸不出方块碎裂特效');
});

test('impact: MAG7 的白闪波浪覆盖**全部被毁格**，按命中点由近到远排序', () => {
  const { registry, ids } = makeRegistryWithWeaponBlocks();
  const editor = {
    setBlock() { return { changes: [] }; },
    setBlocks(changes) { this.lastBatch = changes; return { changes }; },
  };
  const controller = new WeaponController({
    registry, blockQuery: { getBlockId: () => ids.stone }, editor, onEffect: () => {},
  });
  controller.select('mag7');
  const effect = controller.fireOnce({
    origin: [0, 0, 0], forward: [1, 0, 0], right: [0, 0, 1], up: [0, 1, 0],
    target: { hit: true, blockPos: [2, 0, 0], normal: [-1, 0, 0], dist: 2 },
  })[0];
  // 一次 MAG7 仍是**一个** impact（一个命中点），但带上全部被毁格的波浪列表。
  // 用户 2026-10-23：「所有伴随着消失的方块都做白闪后消失」——只报一格就是旧行为。
  assertEqual(effect.impacts.length, 1);
  const impact = effect.impacts[0];
  assertTrue(impact.destroyed, 'MAG7 无视开关，必破坏');
  // 波浪必须覆盖**全量**被扫描到的格子，不是其中一格。
  // 负向锚点：写成 `stagger: [changes[0]]` → 下面第一条 FAIL（实得 1 格）。
  assertTrue(impact.stagger.length > 1,
    `白闪波浪须覆盖全部被毁格，实得 ${impact.stagger.length} 格`);
  assertEqual(impact.stagger.length, editor.lastBatch.length,
    '波浪格数须等于实际提交删除的格数');
  // 顺序 = 由命中点向外（`collectMag7Changes` 已按距离组排好，直接沿用）。
  // 判据落在**到准心命中格的距离**上：单调不减。
  const dists = impact.stagger.map((entry) => Math.hypot(
    entry.blockPos[0] - 2, entry.blockPos[1] - 0, entry.blockPos[2] - 0));
  for (let i = 1; i < dists.length; i++) {
    assertTrue(dists[i] >= dists[i - 1] - 1e-9,
      `白闪扩散须由近到远：第 ${i} 格 ${dists[i].toFixed(3)} < 前一个 ${dists[i - 1].toFixed(3)}`);
  }
  // 首格就是主命中点（`blockPos` 与波浪首项同源，不得各算一套）
  assertEqual(impact.stagger[0].blockPos.join(','), impact.blockPos.join(','));
});

test('impact: 徒手不产出 impacts（特效只接三种枪）', () => {
  const { controller, aim } = makeControllerFixture();
  assertEqual(controller.selectedId, 'arm');
  assertEqual(controller.fireOnce(aim).length, 0);
});

test('impact: MAG7 命中格的颜色源是删除前的方块 id（不是删除后的 air）', () => {
  const { registry, ids } = makeRegistryWithWeaponBlocks();
  // 删完再回查时这一格已经是 air —— 用可变查询模拟真实世界写入
  const world = new Map();
  const editor = {
    setBlock() { return { changes: [] }; },
    setBlocks(changes) {
      for (const c of changes) world.set(`${c.x},${c.y},${c.z}`, ids.air);
      return { changes };
    },
  };
  const controller = new WeaponController({
    registry,
    blockQuery: {
      getBlockId(x, y, z) {
        const key = `${x},${y},${z}`;
        return world.has(key) ? world.get(key) : ids.stone;
      },
    },
    editor,
    onEffect: () => {},
  });
  controller.select('mag7');
  const effect = controller.fireOnce({
    origin: [0, 0, 0], forward: [1, 0, 0], right: [0, 0, 1], up: [0, 1, 0],
    target: { hit: true, blockPos: [2, 0, 0], normal: [-1, 0, 0], dist: 2 },
  })[0];
  assertEqual(effect.impacts.length, 1);
  // 负向锚点：命中特效若回查（而非用扫描器记下的 sourceId），这里会是 0（air）
  assertEqual(effect.impacts[0].blockId, ids.stone, '须是删除前的方块 id');
  assertEqual(world.get('2,0,0'), ids.air, '世界确实已被删（前提校验）');
});

// ==================== v2.41 祭坛飞龙：命中 predicate 泛化 ====================
//
// `entityQuery` 契约新增可选字段 `isHittable`：缺省回落「只认 zombie」（M4 行为逐位不变），
// Game 注入 `WEAPON_HITTABLE_TYPES` 后龙也可被击中。
// ⚠️ controller 仍**不得** import entities/（自声明约束：注入而非 import，依赖方向 §3）。

test('武器命中: isHittable 缺省回落只认 zombie（M4 零回归）', () => {
  const { controller, aim } = makeControllerFixture();
  let gotPredicate = null;
  controller.setEntityQuery({
    raycast: (o, d, r, predicate) => { gotPredicate = predicate; return null; },
    damage: () => {},
  });
  // ⚠️ select 不可省：`_tryFire` 第一行就是 `if (selectedId === ARM) return []`，
  // fixture 不自带 select → 不选武器根本走不到实体射线。
  controller.select('pistol');
  controller.fireOnce(aim);
  assertTrue(gotPredicate !== null, '未发起实体射线（select/fireOnce 没走到 _queryEntityHit）');
  assertTrue(gotPredicate({ type: 'zombie' }), '缺省应放行 zombie');
  assertFalse(gotPredicate({ type: 'dragon' }), '缺省不得放行 dragon（M4 零回归）');
  assertFalse(gotPredicate({ type: 'projectile' }), '缺省不得放行弹丸');
});

test('武器命中: 注入 isHittable 后龙也可被击中', () => {
  const { controller, aim } = makeControllerFixture();
  let gotPredicate = null;
  controller.setEntityQuery({
    raycast: (o, d, r, predicate) => { gotPredicate = predicate; return null; },
    damage: () => {},
    isHittable: (e) => WEAPON_HITTABLE_TYPES.includes(e.type),
  });
  controller.select('pistol');
  controller.fireOnce(aim);
  assertTrue(gotPredicate({ type: 'dragon' }), '注入后应放行 dragon');
  assertTrue(gotPredicate({ type: 'zombie' }), '注入后仍放行 zombie');
  assertFalse(gotPredicate({ type: 'minecart' }), '非可击中类型仍拒绝');
  assertFalse(gotPredicate({ type: 'projectile' }), '弹丸不得被枪打（否则连锁误伤）');
});

test('武器命中: 打中龙时 damage 被调且伤害量取自武器目录', () => {
  const { controller, aim } = makeControllerFixture();
  const damaged = [];
  controller.setEntityQuery({
    // ⚠️ 实体 dist 必须**严格小于**方块 dist（fixture 的 aim.target.dist = 2）才算命中
    raycast: (o, d, r, predicate) => {
      const dragon = { id: 'dragon:tarn:2:0:0', type: 'dragon' };
      return predicate(dragon) ? { id: dragon.id, dist: 1 } : null;
    },
    damage: (id, amount) => damaged.push([id, amount]),
    isHittable: (e) => WEAPON_HITTABLE_TYPES.includes(e.type),
  });
  controller.select('pistol');
  controller.fireOnce(aim);
  assertDeepEqual(damaged, [['dragon:tarn:2:0:0', WEAPONS[WEAPON_IDS.PISTOL].entityDamage]]);
});

test('武器命中: 实体比方块远时不打实体（既有口径不因泛化而变）', () => {
  const { controller, aim } = makeControllerFixture();
  const damaged = [];
  controller.setEntityQuery({
    raycast: (o, d, r, predicate) => {
      const dragon = { id: 'dragon:tarn:2:0:0', type: 'dragon' };
      return predicate(dragon) ? { id: dragon.id, dist: 9 } : null;   // 远于方块 dist=2
    },
    damage: (id, amount) => damaged.push([id, amount]),
    isHittable: (e) => WEAPON_HITTABLE_TYPES.includes(e.type),
  });
  controller.select('pistol');
  controller.fireOnce(aim);
  assertEqual(damaged.length, 0, '实体更远时不得造成伤害');
});

test('武器命中: WEAPON_HITTABLE_TYPES 恰好是 zombie + dragon + ignis（加类型须显式改这里）', () => {
  // v2.55 加 ignis（焰魔）：它**应该**可被武器与炮塔击中（用户可建炮塔助战）。
  // ⚠️ 本用例是「新增可击中类型必须是有意识的改动」的闸门 —— 不要图方便改成
  // `includes(...)`，那会让「静默把一个类型加进去」失去拦截。
  assertDeepEqual([...WEAPON_HITTABLE_TYPES].sort(), ['dragon', 'ignis', 'zombie']);
  assertTrue(Object.isFrozen(WEAPON_HITTABLE_TYPES), '必须冻结（玩法数据唯一权威）');
});
