// src/tests/test-turrets.js — M8：炮塔装置层（蓝图 / 放置 / 失效 / hydrate）
// Tier 1 单测。覆盖「改坏了肉眼玩不出来」的部分：
// ① 预检顺序（bounds → occupied → player-overlap → limit）与**零写入**语义；
// ② 失效判据必须含 `newId !== critical.id` —— 否则炮塔自己的 `lastFireAt` 时钟写回
//    会把自己杀掉（M7 实测踩坑）；
// ③ 全局上限来自**索引（edits store 派生）**而非已加载 controller 数量 ——
//    否则玩家走远再回来就能无限放置。
// fixture 照 `test-zombie-nests.js` 的 `makeNestFixture` 同手法：记录调用但**仍委托真实 world**
// （fake 与真实接线口径不一致会让断言恒真，testing-policy §2.7）。
import { test } from './runner.js';
import * as THREE from 'three';
import { assertEqual, assertTrue, assertNotNull, assertNull, assertFalse } from './assert.js';
import { WORLD_MIN_Y, WORLD_MAX_Y, blockIndex } from '../voxel/constants.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';
import { Persistence } from '../save/persistence.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { createTurretBlueprint } from '../entities/turrets/turret-blueprint.js';
import {
  TURRET, TURRET_ALIAS_BLOCK, defaultTurretRotation,
  TURRET_PARTS, TURRET_PART_DEFS, TURRET_TOWER_COLOR,
} from '../entities/turrets/turret-config.js';
import { TurretRenderer } from '../render/turret-renderer.js';
import { resourceUrl } from '../core/resource-url.js';
import { TurretService } from '../entities/turrets/turret-service.js';
import { TurretController } from '../entities/turrets/turret-controller.js';
import {
  computeTurretUpdates, hasLineOfSight, isProjectileOccluding,
  shortestAngleDiff, normalizeAngle,
} from '../entities/turrets/turret-system.js';

function makeRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}

/**
 * 纯世界 fixture（索敌 / LOS 测试用）—— **新建**，只含 registry + WorldData + 一个 column。
 * ⚠️ 预加载 column (0,0) 只覆盖 x/z ∈ [0,15]，故 LOS 测试的坐标必须落在该范围内
 * （未加载位置 `getBlockId` 恒为 0 = air，会让遮挡断言变成无效盲区）。
 */
function makeWorldFixture() {
  const registry = makeRegistry();
  const world = new WorldData(registry);
  const col = new ChunkColumn(0, 0);
  col.state = 'ready';
  world.add(col);
  return { world, registry };
}

/** 玩家 AABB（脚底中心 + 0.6×1.8×0.6，与 physics.js 常数同源）。 */
function playerAabbAt(x, y, z) {
  return { minX: x - 0.3, maxX: x + 0.3, minY: y, maxY: y + 1.8, minZ: z - 0.3, maxZ: z + 0.3 };
}

/**
 * 放置 fixture。
 * @param {{maxCx?: number}} [opts] `maxCx` = 预加载的 cx 上界（加载 cx ∈ [−1, maxCx]）。
 *   ⚠️ **必须从 cx=−1 开始**：蓝图 x = origin.x − 1，origin [0,0,0] 的那格落在 cx=−1
 *   （M7 的 `makeNestFixture` 同口径，它也是 −1..9）。
 *   ⚠️ **默认 15**：20 个炮塔 origin x=0..228 → 蓝图 x=−1..229 → cx=−1..14；第 21 个
 *   origin [240,0,0] 的蓝图落在 cx=15。`place()` 预检顺序是 bounds（含 hasColumn）→
 *   occupied → player-overlap → limit，不预加载 cx=15 会先返回 'bounds'，
 *   后面的 'limit'/'player-overlap' 断言根本跑不到。
 */
function makeTurretFixture({ maxCx = 15 } = {}) {
  const registry = makeRegistry();
  const world = new WorldData(registry);
  // 蓝图 z∈[-1,1] → cz=-1..1（origin z=0）
  for (let cx = -1; cx <= maxCx; cx++) {
    for (let cz = -1; cz <= 1; cz++) {
      const col = new ChunkColumn(cx, cz);
      col.state = 'ready';
      world.add(col);
    }
  }
  const calls = [];
  const setBlocksCalls = [];
  const editor = {
    calls, setBlocksCalls,
    setBlocks(changes) {
      calls.push({ setBlocks: changes });
      setBlocksCalls.push(changes);
      return world.setBlocks(changes);
    },
    setBlock(c) {
      calls.push({ setBlock: c });
      return world.setBlock(c.x, c.y, c.z, c.id, c.meta ?? 0);
    },
    setBlockEntity(req) {
      calls.push({ setBlockEntity: req });
      // fake 仍委托真实 world：destroy 删锚点后断言 world.getBlockEntity===null 才是真断言
      const cx = Math.floor(req.x / 16), cz = Math.floor(req.z / 16);
      const col = world.getColumn(cx, cz);
      if (col) col.setBlockEntity(req.x - cx * 16, req.y, req.z - cz * 16, req.value);
      return { changes: [], affected: [], changedColumns: [], skipped: [] };
    },
    subscribe: () => () => {},
  };
  const blueprint = createTurretBlueprint(registry);
  const turrets = new TurretService({ world, editor, registry, blueprint });
  return { turrets, editor, world, registry, blueprint, setBlocksCalls };
}

/** controller fixture：真实放置一个炮塔，取其 anchor 建 controller */
function makeTurretControllerFixture() {
  const fx = makeTurretFixture({ maxCx: 2 });
  const r = fx.turrets.place({ origin: [4, 0, 4], playerAabb: null, rotation: 0 });
  assertTrue(r.ok, 'fixture 放置须成功');
  const anchor = fx.world.getBlockEntity(r.anchor[0], r.anchor[1], r.anchor[2]);
  const controller = new TurretController({
    world: fx.world, zombies: { spawn: () => 'z' }, editor: fx.editor, anchor,
    onInvalidated: (id) => fx.turrets.destroy(id),
  });
  fx.turrets.setController(r.id, controller);
  return { ...fx, controller, anchor, id: r.id };
}

// ---------- 蓝图 ----------

test('炮塔蓝图：11 格结构 + 唯一锚点在最高 obsidian', () => {
  const registry = makeRegistry();
  const bp = createTurretBlueprint(registry);
  const changes = bp.changesAt([10, 4, 10]);
  assertEqual(changes.length, 11);                       // 3×3 底座 + 2 柱
  const ironId = registry.idOf('iron_ore');
  const obsidianId = registry.idOf('obsidian');
  assertEqual(changes.filter((c) => c.id === ironId).length, 9);
  assertEqual(changes.filter((c) => c.id === obsidianId).length, 2);
  // 锚点 = 最高 obsidian 上格（origin.y + BASE_DY + 2 = +3，见 blueprint 的 BASE_DY 注释）
  const critical = bp.criticalAt([10, 4, 10]);
  assertEqual(critical.x, 10); assertEqual(critical.y, 7); assertEqual(critical.z, 10);
  assertEqual(critical.id, obsidianId);
  // 底座最低层落在 origin.y + 1（**坐在地面格之上**，不替换它）—— origin 是 solid 地面格，
  // 底座若在 origin.y 会与地面冲突（见 blueprint 的 BASE_DY 注释）。
  assertEqual(Math.min(...changes.map((c) => c.y)), 5);
  assertTrue(bp.inWorldBounds([10, 4, 10]));
  assertEqual(bp.inWorldBounds([10, WORLD_MAX_Y - 1, 10]), false);   // 顶部越界
  // 底部越界须用 `WORLD_MIN_Y - 2`：底座落在 `origin.y + BASE_DY`，故 origin = MIN_Y−1 时
  // 底座正好在 WORLD_MIN_Y（**合法**）；origin = MIN_Y−2 时底座落到 MIN_Y−1 → 越界。
  assertEqual(bp.inWorldBounds([10, WORLD_MIN_Y - 1, 10]), true);
  assertEqual(bp.inWorldBounds([10, WORLD_MIN_Y - 2, 10]), false);
});

// ---------- 放置 ----------

test('炮塔放置：第 21 个、重叠与玩家重叠均零写入', () => {
  const { turrets, editor } = makeTurretFixture();   // 默认 maxCx=15（第 21 个落在 cx=15）
  for (let i = 0; i < TURRET.maxTurrets; i++) {
    const r = turrets.place({ origin: [i * 12, 0, 0], playerAabb: null, rotation: 0 });
    assertTrue(r.ok, `第 ${i + 1} 个须成功（reason=${r.reason}）`);
  }
  const before = editor.calls.length;
  assertEqual(turrets.place({ origin: [240, 0, 0], playerAabb: null, rotation: 0 }).reason, 'limit');
  assertEqual(turrets.place({ origin: [0, 0, 0], playerAabb: null, rotation: 0 }).reason, 'occupied');
  assertEqual(
    turrets.place({ origin: [252, 0, 0], playerAabb: playerAabbAt(252.5, 1, 0), rotation: 0 }).reason,
    'player-overlap',
  );
  assertEqual(editor.calls.length, before, '三种失败路径零写入');
  // ⚠️ **上限判据落在索引而非 controller 数**：此刻没有任何 controller，第 21 个仍须被拒
  assertEqual(turrets.controllers().size, 0);
  assertEqual(turrets.count(), TURRET.maxTurrets);
});

test('炮塔放置：一次事务写 11 格且锚点带 blockEntity（alias 方块不在结构里）', () => {
  const { turrets, setBlocksCalls, registry } = makeTurretFixture();
  const r = turrets.place({ origin: [4, 0, 4], playerAabb: null, rotation: Math.PI / 2 });
  assertTrue(r.ok);
  assertEqual(setBlocksCalls.length, 1);                // **一次**事务
  const changes = setBlocksCalls[0];
  assertEqual(changes.length, 11);
  const withEntity = changes.filter((c) => c.blockEntity);
  assertEqual(withEntity.length, 1);                    // 只有锚点格带 entity
  assertEqual(withEntity[0].blockEntity.kind, 'turret');
  assertEqual(withEntity[0].blockEntity.rotation, Math.PI / 2);
  assertEqual(withEntity[0].blockEntity.lastFireAt, 0);
  assertEqual(withEntity[0].x, 4);
  assertEqual(withEntity[0].y, 3);                      // origin.y + BASE_DY + 2 = 锚点
  // alias 方块**不在** changes 里（炮塔结构不含 turret_alias_block）
  const aliasId = registry.idOf(TURRET_ALIAS_BLOCK);
  assertEqual(changes.some((c) => c.id === aliasId), false);
  // 锚点富状态真的落进了世界（不只进了事务参数）
  assertNotNull(turrets.world.getBlockEntity(4, 3, 4));
});

test('炮塔 destroy：删锚点与索引（结构方块保留 → 同 origin 仍 occupied）', () => {
  const { turrets, world, registry } = makeTurretFixture();
  const r = turrets.place({ origin: [4, 0, 4], playerAabb: null, rotation: 0 });
  assertTrue(turrets.destroy(r.id));
  assertEqual(turrets.count(), 0);
  assertNull(world.getBlockEntity(4, 3, 4), '锚点已删');
  assertEqual(turrets.destroy(r.id), false, '重复删除返回 false');
  // **结构方块仍在世界里**：destroy 只使炮塔失效（删锚点），不清除 11 个方块 ——
  // 清除是 TNT/爆炸的职责（规格 §3.2「不另开破坏路径」，M7 同口径）。故同 origin 仍 occupied。
  assertEqual(turrets.place({ origin: [4, 0, 4], playerAabb: null, rotation: 0 }).reason, 'occupied');
  assertEqual(world.getBlockId(4, 3, 4), registry.idOf('obsidian'), '关键方块本体保留');
});

// ---------- 失效 ----------

test('炮塔失效：关键格被破坏即注销，时钟写回不失效', () => {
  const { turrets, controller, anchor } = makeTurretControllerFixture();
  // ① 时钟写回（同格同 id）→ **不**失效（炮塔每次开火都写回 lastFireAt）
  controller.writeBackFireClock(1234);
  assertEqual(controller.isInvalidated(), false, '时钟写回不得失效');
  assertEqual(controller.lastFireAt, 1234);
  // 写回的是**新对象**（不原地改 anchor）—— column.blockEntities 与 edits 共享引用，
  // 原地改会让两处状态看似独立实则共享（红线 1 精神）
  assertEqual(anchor.lastFireAt, 0, '原 anchor 对象未被原地改写');
  // ② 关键格被挖掉（newId=0 ≠ critical.id）→ 失效 + 索引删除
  controller.onWorldChange({ type: 'block-changed', changes: [
    { x: anchor.critical.x, y: anchor.critical.y, z: anchor.critical.z, newId: 0 },
  ] });
  assertEqual(controller.isInvalidated(), true);
  assertEqual(turrets.count(), 0, '索引已删');
});

test('炮塔失效：关键格被替换成别的方块也失效；无关方块不误触发', () => {
  const { turrets, controller, anchor } = makeTurretControllerFixture();
  const registry = turrets.registry;
  // 无关方块变更（不在关键格）→ 不失效
  controller.onWorldChange({ type: 'block-changed', changes: [
    { x: anchor.critical.x + 5, y: anchor.critical.y, z: anchor.critical.z, newId: 0 },
  ] });
  assertEqual(controller.isInvalidated(), false, '无关变更不误触发');
  // ⚠️ **同格同 id（纯 entity 更新）不误触发** —— 这条是 `newId !== critical.id` 判据的
  // 真实落点（照 M7 的「事件失效：同格写回同 id 不误触发」同口径）。删掉该判据后本条
  // 必 FAIL；只靠 `writeBackFireClock()` 测不到它 —— 真实 editor 的 `setBlockEntity`
  // **不发** block-changed 事件（`world-editor.js` 在 `_emit` 之前就 return），
  // 故必须喂合成事件才能覆盖（实测：两条注入都在这层被抓到）。
  controller.onWorldChange({ type: 'block-changed', changes: [
    { x: anchor.critical.x, y: anchor.critical.y, z: anchor.critical.z, newId: anchor.critical.id },
  ] });
  assertEqual(controller.isInvalidated(), false, '同格同 id（时钟写回语义）不误触发');
  // 同格换成 stone（newId !== critical.id）→ 失效
  controller.onWorldChange({ type: 'block-changed', changes: [
    { x: anchor.critical.x, y: anchor.critical.y, z: anchor.critical.z, newId: registry.idOf('stone') },
  ] });
  assertEqual(controller.isInvalidated(), true);
});

test('column 卸载：销毁 controller 但保留 anchor 与索引', () => {
  const { turrets, world } = makeTurretControllerFixture();
  assertEqual(turrets.controllers().size, 1);
  // column 卸载语义：只清 controller，anchor 与索引保留（再次加载后能恢复）
  for (const [cid, controller] of [...turrets.controllers()]) {
    controller.dispose();
    turrets.setController(cid, null);
  }
  assertEqual(turrets.controllers().size, 0, 'controller 销毁');
  assertEqual(turrets.count(), 1, '索引保留 → 上限仍计入');
  assertNotNull(world.getBlockEntity(4, 3, 4), 'anchor 保留');
});

// ---------- hydrate ----------

test('hydrate：从 edits store 恢复全局索引（未加载 column 的锚点仍计入上限）', async () => {
  const registry = makeRegistry();
  const world = new WorldData(registry);
  const editor = { setBlocks: () => ({ changes: [], skipped: [] }), setBlockEntity: () => ({}) };
  const turrets = new TurretService({
    world, editor, registry, blueprint: createTurretBlueprint(registry),
  });
  const persistence = new Persistence();
  await persistence.open();
  await persistence.clearAllEdits();
  const obsidianId = registry.idOf('obsidian');
  // 20 个锚点分布在**不同且未加载**的 column
  for (let i = 0; i < TURRET.maxTurrets; i++) {
    await persistence.saveColumnEdits(`${i + 50},0`, [{
      index: blockIndex(1, WORLD_MIN_Y + 8, 1), id: obsidianId, meta: 0,
      blockEntity: {
        kind: 'turret', id: `turret-${i + 1}`, origin: [(i + 50) * 16 + 1, WORLD_MIN_Y + 5, 1],
        critical: { x: (i + 50) * 16 + 1, y: WORLD_MIN_Y + 8, z: 1, id: obsidianId },
        rotation: 0, lastFireAt: 0,
      },
    }]);
  }
  await turrets.hydrate(persistence);
  assertEqual(turrets.count(), TURRET.maxTurrets, '20 个锚点全部计入（无一已加载）');
  assertEqual(turrets.controllers().size, 0, '没有任何 controller');
  assertEqual(turrets.anchorOf('turret-1')[1], WORLD_MIN_Y + 8);   // origin.y + BASE_DY + 2
  assertEqual(turrets.anchorColumnKey('turret-1'), '50,0');
  await persistence.clearAllEdits();
});

// ---------- 默认朝向 ----------

test('defaultTurretRotation：取最近四方向之一（mc-lite DIRECTIONS 语义）', () => {
  const blockPos = [10, 4, 10];
  // 玩家在 +X 侧（dx 绝对值更大）→ π/2
  assertEqual(defaultTurretRotation({ x: 14, z: 10.5 }, blockPos), Math.PI / 2);
  // 玩家在 −X 侧 → −π/2
  assertEqual(defaultTurretRotation({ x: 6, z: 10.5 }, blockPos), -Math.PI / 2);
  // 玩家在 +Z 侧（dz 绝对值更大）→ 0
  assertEqual(defaultTurretRotation({ x: 10.5, z: 14 }, blockPos), 0);
  // 玩家在 −Z 侧 → π
  assertEqual(defaultTurretRotation({ x: 10.5, z: 6 }, blockPos), Math.PI);
});

// ---------- M8 Task 4：索敌 / LOS / 朝向插值 ----------

test('computeTurretUpdates：最近的可见丧尸成为目标，算出 yaw/pitch', () => {
  const { world, registry } = makeWorldFixture();
  const turrets = [{ id: 'turret-1', pivot: [10.5, 7.3, 10.5], rotation: 0 }];
  // ⚠️ **两只丧尸必须在不同方向**（不能都在 +X 轴上）：否则 `atan2(dx, dz)` 算出的 yaw
  // 相同 → 注入「不做最近判定」仍然全绿（testing-policy §2.7 无效盲区）。
  // 近：+X 方向（yaw = atan2(3, 0) = π/2）；远：+Z 方向（yaw = atan2(0, 3) = 0）
  // ⚠️ **近的必须排在前面**（实测修正）：若把远的排在前，注入「不做最近判定」会让
  // 「最后遍历到的」丧尸成为目标 = 恰好就是近的那只 → 断言全绿（无效盲区）。
  // 近的在前 + 远的在后 → 注入版本会选中远的（yaw≈0）→ 断言必 FAIL（实测验证过）。
  const zombies = [
    { id: 'z-near', position: [13.5, 4, 10.5] },  // 距 pivot 约 3 格，yaw≈π/2（正确目标）
    { id: 'z-far', position: [10.5, 4, 14.5] },   // 距 pivot 约 4 格，yaw≈0（注入版本会选它）
  ];
  const r = computeTurretUpdates({ turrets, targets: zombies, world, registry });
  assertEqual(r.updates.length, 1);
  // 目标是近的（+X）→ yaw 指向 +X（atan2 口径，不是 Euler 反解 —— CLAUDE.md 活跃约束）
  assertTrue(Math.abs(r.updates[0].targetYaw - Math.PI / 2) < 0.01, `yaw=${r.updates[0].targetYaw}`);
  // 丧尸在 pivot 下方 → 俯视（pitch < 0）
  assertTrue(r.updates[0].targetPitch < 0);
  // pitch 被限制在 ±45° 内
  assertTrue(Math.abs(r.updates[0].targetPitch) <= TURRET.maxPitchAngle + 1e-9);
});

test('computeTurretUpdates：无丧尸时回归默认朝向（placement rotation）', () => {
  const { world, registry } = makeWorldFixture();
  const turrets = [{ id: 'turret-1', pivot: [10.5, 7.3, 10.5], rotation: 1.2 }];
  const r = computeTurretUpdates({ turrets, targets: [], world, registry });
  assertEqual(r.updates[0].targetYaw, 1.2);   // 回归 placement rotation
  assertEqual(r.updates[0].targetPitch, 0);
});

test('computeTurretUpdates：检测范围外的丧尸不成目标（回归默认朝向）', () => {
  const { world, registry } = makeWorldFixture();
  const turrets = [{ id: 'turret-1', pivot: [10.5, 7.3, 10.5], rotation: 0.7 }];
  // 超出 detectionRange(50) —— 用 pivot 外的远坐标（LOS 采样不需要真实方块，只需超范围粗筛）
  const zombies = [{ id: 'z-far', position: [10.5 + TURRET.detectionRange + 5, 4, 10.5] }];
  const r = computeTurretUpdates({ turrets, targets: zombies, world, registry });
  assertEqual(r.updates[0].targetYaw, 0.7);   // 回归默认，不是指向那只远丧尸
});

test('hasLineOfSight：实心不透明方块阻挡，透明方块不阻挡', () => {
  const { world, registry } = makeWorldFixture();
  const from = [10.5, 7.3, 10.5], to = [10.5, 4, 13.5];
  // 无遮挡 → 可见
  assertTrue(hasLineOfSight({ world, registry, from, to }), '无遮挡可见');
  // 中间放一格 stone（实心不透明）→ 阻挡
  world.setBlock(10, 5, 12, registry.idOf('stone'));
  assertEqual(hasLineOfSight({ world, registry, from, to }), false, 'stone 阻挡');
  // 换成 glass_block（实心但透明）→ 不阻挡。⚠️ 方块名是 `glass_block`，本仓 registry **无
  // `glass`**（实测 blocks-data.js）—— 对照样本须用真实存在的方块名，否则 idOf 返回 undefined。
  world.setBlock(10, 5, 12, registry.idOf('glass_block'));
  assertTrue(hasLineOfSight({ world, registry, from, to }), 'glass_block 不阻挡');
  // 换成 leaves（2026-10-23 起 opaqueTable=1）→ **现在阻挡**（用户裁定：树叶挡炮塔与弹丸）
  world.setBlock(10, 5, 12, registry.idOf('leaves'));
  assertEqual(hasLineOfSight({ world, registry, from, to }), false, 'leaves 阻挡（opaqueTable=1）');
  // 换成 water（非实心）→ 不阻挡
  world.setBlock(10, 5, 12, registry.idOf('water'));
  assertTrue(hasLineOfSight({ world, registry, from, to }), 'water 不阻挡');
});

test('isProjectileOccluding：solid && opaque 才阻挡（LOS 与弹丸共用判据）', () => {
  const registry = makeRegistry();
  assertTrue(isProjectileOccluding(registry.idOf('stone'), registry));   // 实心不透明
  assertEqual(isProjectileOccluding(registry.idOf('glass_block'), registry), false);  // 实心但透明
  // 2026-10-23 口径变更：树叶 opaqueTable=1 → **现在阻挡**（用户裁定，与巨树叶一致）
  assertEqual(isProjectileOccluding(registry.idOf('leaves'), registry), true);        // 实心且不透明（opaqueTable=1）
  // v1.96：cloud 改 solid:true 后 solid && opaque 两项都成立 → **云开始阻挡视线与弹丸**。
  // 这是 solid 变更最容易被漏掉的玩法后果（LOS 与弹丸共用本函数，红线 1）—— 显式钉住。
  assertEqual(isProjectileOccluding(registry.idOf('cloud'), registry), true);         // v1.96：云阻挡 LOS 与弹丸
  assertEqual(isProjectileOccluding(registry.idOf('water'), registry), false);        // 非实心
  assertEqual(isProjectileOccluding(registry.idOf('air'), registry), false);
  assertEqual(isProjectileOccluding(registry.idOf('obsidian'), registry), true);
});

test('shortestAngleDiff / normalizeAngle：折叠区取值（|θ| > π/2）', () => {
  // ⚠️ 须至少一个落在折叠区（CLAUDE.md 活跃约束：只在 [-π/2, π/2] 内取值会侥幸通过）
  // ⚠️ π ↔ 0 是**平局**（最短路径长 π，符号任意）—— 断言须落在**幅度**上，
  // 不能钉符号：实现按 `[-π, π)` 口径会给 −π，钉 `Math.PI` 会假失败。
  assertEqual(Math.abs(shortestAngleDiff(0, Math.PI)), Math.PI);
  assertEqual(Math.abs(shortestAngleDiff(Math.PI, 0)), Math.PI);   // 反向同样长度
  assertTrue(Math.abs(shortestAngleDiff(0, -Math.PI / 2)) - Math.PI / 2 < 1e-9);
  // 跨 ±π 边界的最短路径（绕回而不是绕远）
  assertTrue(Math.abs(shortestAngleDiff(3.0, -3.0)) < 0.3, '跨边界走短路径');
  // 3π → 取余得 π → 按 [-π, π) 口径收进 −π（不是 π —— 右端开区间）
  assertEqual(normalizeAngle(Math.PI * 3), -Math.PI);
  assertEqual(normalizeAngle(Math.PI), -Math.PI);
  assertEqual(normalizeAngle(-Math.PI), -Math.PI);
  assertTrue(normalizeAngle(-Math.PI * 3) >= -Math.PI && normalizeAngle(-Math.PI * 3) < Math.PI);
  assertTrue(normalizeAngle(2.48) === 2.48);   // 折叠区内的值原样保留
});

test('controller.update：朝向按限角速度插值，未对准不开火；对准且冷却到期开火', () => {
  const { controller } = makeTurretControllerFixture();
  controller.targetId = 'zombie-1';   // ⚠️ 本用例测「瞄准 + 冷却」，须显式模拟「有目标」
                                      // （无目标门控见「炮塔无目标时不开火」用例）
  controller.targetRotation = Math.PI;   // 目标朝向与当前差 π
  // 第一帧：插值一小步（限角速度 π/2 × dt），yawDiff 仍 > 0.26 → 不开火
  assertEqual(controller.update(1000, 1 / 60), false);
  assertTrue(Math.abs(controller.currentRotation) < Math.PI, '只走了一步（限角速度）');
  // 限角速度定量核对：一帧最多走 rotationSpeed × dt = π/2 × 1/60
  assertTrue(Math.abs(controller.currentRotation) <= TURRET.rotationSpeed / 60 + 1e-9);
  // 推进到对准 + 冷却到期 → 开火
  controller.currentRotation = controller.targetRotation;
  controller.currentPitch = controller.targetPitch;
  assertEqual(controller.update(1000 + TURRET.fireCooldownMs, 1 / 60), true, '对准 + 冷却到期开火');
  // 冷却未到 → 不开火
  assertEqual(controller.update(1000 + TURRET.fireCooldownMs + 1, 1 / 60), false, '冷却未到不开火');
  // 再过一个冷却周期 → 又能开火（节流不是单次）
  assertEqual(controller.update(1000 + TURRET.fireCooldownMs * 2 + 2, 1 / 60), true);
});

test('controller.update：pitch 未对准时不开火（yaw 对准不够）', () => {
  const { controller } = makeTurretControllerFixture();
  controller.targetId = 'zombie-1';   // ⚠️ 同上：须显式模拟「有目标」
  controller.targetRotation = controller.currentRotation;   // yaw 已对准
  controller.targetPitch = TURRET.maxPitchAngle;            // pitch 差 π/4 > 阈值 0.26
  assertEqual(controller.update(5000, 1 / 60), false, 'pitch 未对准不开火');
  // pitch 对准后开火
  controller.currentPitch = controller.targetPitch;
  assertEqual(controller.update(5000 + TURRET.fireCooldownMs, 1 / 60), true);
});

test('controller.update：失效后不开火', () => {
  const { controller, anchor } = makeTurretControllerFixture();
  controller.onWorldChange({ type: 'block-changed', changes: [
    { x: anchor.critical.x, y: anchor.critical.y, z: anchor.critical.z, newId: 0 },
  ] });
  assertEqual(controller.update(1000, 1 / 60), false);
});

test('controller.muzzle：方向与渲染矩阵**交叉比对**（pitch 符号同源）', async () => {
  // ⚠️ **这条是红线 1 漂移的真实判据**（实测踩坑）：上一版 `muzzle()` 的 pitch 符号写反，
  // 炮塔朝下瞄准时弹丸往天上飞（E2E 实测：丧尸恒 100 血、弹丸从未命中）。
  // 只读渲染矩阵的单测**测不到**它（渲染层的 `Rx(-pitch)` 是对的，错的是 muzzle 自己那套公式）。
  // 故断言落在「muzzle 方向 == 渲染矩阵变换出的炮口位置」这条交叉比对上。
  const scene = new THREE.Scene();
  const renderer = new TurretRenderer({ scene, topGeometry: await topGeoFixture() });
  const { controller } = makeTurretControllerFixture();
  const geo = await topGeoFixture();
  const bp = geo.parts.barrel.position;
  let zmax = -Infinity;
  for (let i = 2; i < bp.length; i += 3) zmax = Math.max(zmax, bp[i]);
  const muzzleLocal = new THREE.Vector3(0, 0, zmax);   // 轴上炮口
  // 覆盖正/负 pitch 与折叠区 yaw（只测 [-π/2, π/2] 会侥幸通过 —— CLAUDE.md 活跃约束）
  for (const [yaw, pitch] of [[0, 0], [0, -0.4], [0, 0.4], [2.48, -0.3], [-2.48, 0.3]]) {
    controller.currentRotation = yaw;
    controller.currentPitch = pitch;
    renderer.sync(new Map([[controller.id, {
      position: controller.pivot(), yaw, pitch,
    }]]));
    const m = new THREE.Matrix4();
    renderer.meshes.barrel.getMatrixAt(0, m);
    // ⚠️ 刚性一体下矩阵位置恒等于 pivot ⇒ 必须变换**炮口顶点**才测得到方向
    const barrelPos = muzzleLocal.clone().applyMatrix4(m);
    const pivot = controller.pivot();
    const muzzle = controller.muzzle();
    // 炮口方向（归一化）应与「渲染出的炮管末端 − pivot」方向一致
    const rendered = new THREE.Vector3(
      barrelPos.x - pivot[0], barrelPos.y - pivot[1], barrelPos.z - pivot[2],
    ).normalize();
    const dot = rendered.x * muzzle.direction[0] + rendered.y * muzzle.direction[1]
      + rendered.z * muzzle.direction[2];
    assertTrue(dot > 0.999, `yaw=${yaw} pitch=${pitch}：muzzle 与渲染方向不一致（dot=${dot.toFixed(4)}）`);
    // 符号方向断言：负 pitch（俯视）→ 炮口 y 向下；正 pitch → 向上
    if (pitch < 0) assertTrue(muzzle.direction[1] < 0, `俯视时炮口向下（y=${muzzle.direction[1]}）`);
    if (pitch > 0) assertTrue(muzzle.direction[1] > 0, `仰视时炮口向上（y=${muzzle.direction[1]}）`);
  }
  renderer.dispose();
});

test('controller.muzzle：方向随朝向变化（与视觉旋转同源）', () => {
  const { controller } = makeTurretControllerFixture();
  // yaw=0 → 炮口朝 +Z；yaw=π/2 → 朝 +X
  controller.currentRotation = 0; controller.currentPitch = 0;
  const a = controller.muzzle();
  assertTrue(Math.abs(a.direction[2] - 1) < 1e-9, `yaw=0 朝 +Z：${JSON.stringify(a.direction)}`);
  controller.currentRotation = Math.PI / 2;
  const b = controller.muzzle();
  assertTrue(Math.abs(b.direction[0] - 1) < 1e-9, `yaw=π/2 朝 +X：${JSON.stringify(b.direction)}`);
  // 方向已归一化
  const len = Math.hypot(...b.direction);
  assertTrue(Math.abs(len - 1) < 1e-9);
  // 炮口位置在 pivot 前方 muzzleOffsetZ 处（不是 pivot 本身）
  const pivot = controller.pivot();
  const dist = Math.hypot(a.position[0] - pivot[0], a.position[1] - pivot[1], a.position[2] - pivot[2]);
  assertTrue(Math.abs(dist - TURRET.muzzleOffsetZ) < 1e-9, `炮口距 pivot ${dist}`);
});

// ---------- M8 Task 5：炮塔渲染（8 部件实例池 + UV 分区） ----------

/**
 * 塔顶几何产物 fixture（渲染层用例共用）。
 * ⚠️ 几何是造型的唯一来源 ⇒ 渲染层用例**必须**传 topGeometry，否则不建 mesh。
 * 用 async 加载 + 模块级缓存（只 fetch 一次）。
 */
let _topGeoFixture = null;
async function topGeoFixture() {
  if (_topGeoFixture === null) {
    _topGeoFixture = await (await fetch(resourceUrl('assets/turret/turret-top.json'))).json();
  }
  return _topGeoFixture;
}

/** 假纹理（只需是 THREE.Texture 实例，让渲染层走贴图路径） */
function makeFakeTexture() {
  const tex = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  tex.needsUpdate = true;
  return tex;
}

test('TurretRenderer：8 个部件 InstancedMesh，无炮塔时全部 visible=false', async () => {
  const scene = new THREE.Scene();
  const renderer = new TurretRenderer({ scene, maxActive: TURRET.maxTurrets, topGeometry: await topGeoFixture() });
  // 8 部件（5 装甲板 + 炮管 + 根部 + 瞄准器）—— 部件顺序的单一权威在 config
  assertEqual(Object.keys(renderer.meshes).length, TURRET_PARTS.length);
  assertEqual(TURRET_PARTS.length, 9);
  for (const part of TURRET_PARTS) {
    assertEqual(renderer.meshes[part].visible, false, `${part} 无炮塔时不可见`);
    assertEqual(renderer.meshes[part].count, TURRET.maxTurrets, `${part} 容量`);
  }
  // 几何来自烘焙产物 ⇒ 全部是 BufferGeometry（不再是参数化 Box/Cylinder）
  for (const part of TURRET_PARTS) {
    assertEqual(renderer.meshes[part].geometry.type, 'BufferGeometry', `${part} 几何来自产物`);
    assertTrue(renderer.meshes[part].geometry.getIndex() !== null, `${part} 索引化`);
  }
  renderer.dispose();
});

test('TurretRenderer：缺省容量从 TURRET.maxTurrets 派生（非硬编码字面量）', async () => {
  // ⚠️ 不传 maxActive —— fixture 显式传会覆盖默认参数 → 注入「默认写死 30」全绿
  // （M6 实测踩过同一坑，见 test-zombies.js 的同款断言）
  const renderer = new TurretRenderer({ scene: new THREE.Scene(), topGeometry: await topGeoFixture() });
  assertEqual(renderer.maxActive, TURRET.maxTurrets);
  for (const part of TURRET_PARTS) assertEqual(renderer.meshes[part].count, TURRET.maxTurrets);
  renderer.dispose();
});

test('TurretRenderer：UV 原样取自产物（烘焙侧已分区，渲染层不得改写）', async () => {
  const geo = await topGeoFixture();
  const renderer = new TurretRenderer({ scene: new THREE.Scene(), armorTexture: makeFakeTexture(), topGeometry: geo });
  // ⚠️ **权威在烘焙侧**：新几何逐面分区（同一部件内不同面属不同区），
  // 部件级 zone 恒 null ⇒ 旧「整块几何一个区」的断言失去意义。
  // 本用例只钉「渲染层不改写」；分区正确性由 test-turret-top-bake.js 在烘焙侧钉住。
  for (const part of TURRET_PARTS) {
    const uv = renderer.meshes[part].geometry.getAttribute('uv');
    const src = geo.parts[part].uv;
    assertEqual(uv.count * 2, src.length, `${part} uv 长度`);
    for (let i = 0; i < src.length; i++) {
      // ⚠️ 容差 1e-6：UV 存 Float32，1e-9 会因存储精度假失败
      assertTrue(Math.abs(uv.array[i] - src[i]) <= 1e-6,
        `${part} uv[${i}] 被改写了：${uv.array[i]} vs 产物 ${src[i]}`);
    }
  }
  renderer.dispose();
});

test('TurretRenderer：无纹理时退回纯色（材质不带 map）', async () => {
  const renderer = new TurretRenderer({ scene: new THREE.Scene(), armorTexture: null, topGeometry: await topGeoFixture() });
  const armor = TURRET_PARTS.filter((p) => TURRET_PART_DEFS[p].textured);
  const solid = TURRET_PARTS.filter((p) => !TURRET_PART_DEFS[p].textured);
  for (const part of armor) {
    assertEqual(renderer.meshes[part].material.map, null, `${part} 无纹理时不带 map`);
    // ⚠️ 新 8 部件没有「后板」语义 ⇒ 装甲统一退回 MAIN（DARK 已无消费点）
    assertEqual(renderer.meshes[part].material.color.getHex(), TURRET_TOWER_COLOR.MAIN, `${part} 退回 MAIN`);
  }
  // 纯色部件不受纹理缺失影响
  for (const part of solid) {
    assertEqual(renderer.meshes[part].material.color.getHex(), TURRET_PART_DEFS[part].color, `${part} 专属色`);
  }
  renderer.dispose();
});

test('TurretRenderer：sync 差集驱动 —— 新增分配 slot、消失归还', async () => {
  const renderer = new TurretRenderer({ scene: new THREE.Scene(), topGeometry: await topGeoFixture() });
  const poses = new Map([['turret-1', { position: [10.5, 7.3, 10.5], yaw: 0, pitch: 0 }]]);
  renderer.sync(poses);
  assertEqual(renderer.slotCount(), 1);
  for (const part of TURRET_PARTS) assertEqual(renderer.meshes[part].visible, true, `${part} 可见`);
  // 第二个炮塔 → 分配新 slot
  poses.set('turret-2', { position: [20.5, 7.3, 10.5], yaw: 1, pitch: 0 });
  renderer.sync(poses);
  assertEqual(renderer.slotCount(), 2);
  // 炮塔消失（column 卸载 / 失效）→ slot 归还 + 不可见
  renderer.sync(new Map());
  assertEqual(renderer.slotCount(), 0);
  for (const part of TURRET_PARTS) assertEqual(renderer.meshes[part].visible, false);
  renderer.dispose();
});

test('TurretRenderer：pose 矩阵反映 yaw/pitch（渲染真的消费朝向，非恒 0）', async () => {
  const renderer = new TurretRenderer({ scene: new THREE.Scene(), topGeometry: await topGeoFixture() });
  const pos = [10.5, 7.3, 10.5];
  renderer.sync(new Map([['t1', { position: pos, yaw: 0, pitch: 0 }]]));
  const m0 = new THREE.Matrix4();
  renderer.meshes.mantlet.getMatrixAt(0, m0);

  // ⚠️ **判据必须落在旋转部分，不能落在矩阵位置**：刚性一体下 8 部件共用 pivot 矩阵
  // ⇒ 矩阵位置恒等于 pivot，**不随 yaw 变化**（旧参数化几何里各部件有局部平移，
  // 位置才会随 yaw 转）。用「部件几何的一个顶点经矩阵变换后的世界位置」才有判别力。
  const geo = await topGeoFixture();
  const local = new THREE.Vector3(...geo.parts.mantlet.position.slice(0, 3));
  const p0 = local.clone().applyMatrix4(m0);

  // yaw = π/2 → 部件绕 Y 转 90°，顶点世界位置应随之变化
  renderer.sync(new Map([['t1', { position: pos, yaw: Math.PI / 2, pitch: 0 }]]));
  const m1 = new THREE.Matrix4();
  renderer.meshes.mantlet.getMatrixAt(0, m1);
  const p1 = local.clone().applyMatrix4(m1);
  assertTrue(p0.distanceTo(p1) > 0.1, 'yaw 改变 → 部件顶点世界位置改变');

  // ⚠️ **折叠区取值**（CLAUDE.md 活跃约束：只在 [-π/2, π/2] 内取值会侥幸通过）。
  // 从实例矩阵反解 yaw 必须用 atan2(elements[8], elements[0])，不能用 Euler。
  renderer.sync(new Map([['t1', { position: pos, yaw: 2.48, pitch: 0 }]]));
  const m2 = new THREE.Matrix4();
  // ⚠️ 新几何**所有部件的局部变换都是恒等**（刚性一体）⇒ 任一部件的旋转部分
  // 都恰好 = pivot 旋转，不再有「front 含 rotX 会失真」的问题。这里取 ring。
  renderer.meshes.ring.getMatrixAt(0, m2);
  const e = m2.elements;
  const yawFromMatrix = Math.atan2(e[8], e[0]);
  assertTrue(Math.abs(yawFromMatrix - 2.48) < 0.02, `反解 yaw=${yawFromMatrix}（须 ≈2.48）`);
  // 对照：Euler 反解会折叠（证明这条断言确实钉住了陷阱）
  const eulerYaw = new THREE.Euler().setFromRotationMatrix(m2, 'XYZ').y;
  assertFalse(Math.abs(eulerYaw - 2.48) < 0.02, 'Euler 反解确实折叠（故必须用 atan2）');
  renderer.dispose();
});

test('TurretRenderer：pitch 取反（mc-lite pitchObject.rotation.x = -pitch）', async () => {
  const renderer = new TurretRenderer({ scene: new THREE.Scene(), topGeometry: await topGeoFixture() });
  const pos = [10.5, 7.3, 10.5];
  // 俯视（pitch < 0，瞄准下方丧尸）→ 炮管应向下倾斜
  renderer.sync(new Map([['t1', { position: pos, yaw: 0, pitch: -0.4 }]]));
  const m = new THREE.Matrix4();
  renderer.meshes.barrel.getMatrixAt(0, m);
  // ⚠️ 同上：矩阵位置恒等于 pivot ⇒ 必须变换**炮口顶点**（z 最大处）才测得到俯仰
  const geo = await topGeoFixture();
  const bp = geo.parts.barrel.position;
  let zi = 2;
  for (let i = 2; i < bp.length; i += 3) if (bp[i] > bp[zi]) zi = i;
  const muzzleLocal = new THREE.Vector3(0, 0, bp[zi]);   // 轴上炮口（x/y 轴心为 0）
  const barrelPos = muzzleLocal.clone().applyMatrix4(m);
  const pivotY = pos[1];
  // pitch = -0.4（俯视）→ 炮管末端 y 低于 pivot
  assertTrue(barrelPos.y < pivotY, `俯视时炮管向下：barrelY=${barrelPos.y} pivotY=${pivotY}`);
  // 仰视（pitch > 0）→ 炮管向上
  renderer.sync(new Map([['t1', { position: pos, yaw: 0, pitch: 0.4 }]]));
  renderer.meshes.barrel.getMatrixAt(0, m);
  const upPos = muzzleLocal.clone().applyMatrix4(m);
  assertTrue(upPos.y > pivotY, `仰视时炮管向上：barrelY=${upPos.y}`);
  renderer.dispose();
});

test('TurretRenderer：几何规模与产物一致（防产物过期/部件错配）', async () => {
  const geo = await topGeoFixture();
  const renderer = new TurretRenderer({ scene: new THREE.Scene(), topGeometry: geo });
  // 旧「逐项钉住 mc-lite 盒尺寸」的断言随参数化几何一同删除 —— 几何不再参数化。
  // 改为钉「渲染层建出的几何与产物逐位一致」，这才是新架构下的漂移防线。
  for (const part of TURRET_PARTS) {
    const g = renderer.meshes[part].geometry;
    assertEqual(g.getAttribute('position').count, geo.parts[part].position.length / 3, `${part} 顶点数`);
    assertEqual(g.getIndex().count, geo.parts[part].index.length, `${part} 索引数`);
  }
  renderer.dispose();
});

// ---------- 开火门控：无目标不得射击（实玩反馈缺陷） ----------

test('炮塔无目标时**不开火**（刚放置 / 丧尸清空后均须静默）', () => {
  const { controller } = makeTurretControllerFixture();
  // 无索敌写回（targetId 为 null）→ 即便角度完全对准、冷却早已到期，也**不得**开火
  controller.currentRotation = controller.targetRotation;   // 角度差 0
  controller.currentPitch = controller.targetPitch;         // pitch 差 0
  assertEqual(controller.targetId, null, '初值无目标');
  assertEqual(controller.update(1000, 1 / 60), false, '刚放置时不得开火');
  // 持续多帧仍不开火（不是只挡第一帧）
  for (let i = 0; i < 120; i++) {
    assertEqual(controller.update(1000 + i * TURRET.fireCooldownMs, 1 / 60), false,
      `第 ${i} 帧仍不得开火（无目标）`);
  }
  // ⚠️ 无目标时连发射回调都不该触发（弹丸不该被创建）
  let fired = 0;
  controller._onFire = () => { fired++; };
  controller.update(5000, 1 / 60);
  assertEqual(fired, 0, '无目标时不得调用 onFire');
});

test('炮塔索敌写回目标后才开火；目标消失即停火', () => {
  const { controller } = makeTurretControllerFixture();
  // 索敌写回：有目标（targetId 非 null）+ 朝向对准
  controller.targetId = 'zombie-1';
  controller.targetRotation = controller.currentRotation;
  controller.targetPitch = controller.currentPitch;
  // 冷却到期 → 开火
  assertEqual(controller.update(1000, 1 / 60), true, '有目标 + 对准 + 冷却到期 → 开火');
  // 目标消失（丧尸被消灭 / 走出范围）→ 立刻停火
  controller.targetId = null;
  assertEqual(controller.update(1000 + TURRET.fireCooldownMs, 1 / 60), false,
    '目标消失后不得开火');
});

test('computeTurretUpdates：返回目标标识，无目标时为空', () => {
  const { world, registry } = makeWorldFixture();
  const turrets = [{ id: 'turret-1', pivot: [10.5, 7.3, 10.5], rotation: 0 }];
  // 无丧尸 → hasTarget false
  const none = computeTurretUpdates({ turrets, targets: [], world, registry });
  assertEqual(none.updates[0].hasTarget, false, '无丧尸 → hasTarget=false');
  // 有可见丧尸 → hasTarget true 且带 targetId
  const zombies = [{ id: 'z-near', position: [13.5, 4, 10.5] }];
  const found = computeTurretUpdates({ turrets, targets: zombies, world, registry });
  assertEqual(found.updates[0].hasTarget, true, '有丧尸 → hasTarget=true');
  assertEqual(found.updates[0].targetId, 'z-near');
  // ⚠️ **目标恰好在默认朝向上时，仍须 hasTarget=true**（不能只靠「朝向是否变化」推断有无目标）
  const onDefault = [{ id: 'z-on-default', position: [10.5, 4, 14.5] }];   // +Z 方向 = rotation 0
  const r = computeTurretUpdates({ turrets, targets: onDefault, world, registry });
  assertEqual(r.updates[0].targetYaw, 0, '该丧尸在默认朝向上');
  assertEqual(r.updates[0].hasTarget, true, '朝向不变也须报有目标');
});

// ==================== v2.41 祭坛飞龙：索敌目标集合泛化 ====================
//
// `computeTurretUpdates` 的参数从 `zombies` 改名为 `targets`，每项可带 `bodyOffsetY`
// （缺省 = `TURRET.enemyBodyOffsetY` 的丧尸胸部偏移；龙传 0，因为它的 position 就是身体中心）。
//
// ⚠️ **丧尸零回归是硬门**：既有用例只改参数名、断言一字不动（AGENTS.md：改名后若某条断言
// 因此变红，说明实现改了行为而不是改名）。

test('炮塔索敌: targets 改名后丧尸行为不变（yaw/pitch/hasTarget/targetId 与既有用例同值）', () => {
  const { world, registry } = makeWorldFixture();
  const turrets = [{ id: 'turret-1', pivot: [10.5, 7.3, 10.5], rotation: 0 }];
  // 与上面「最近的可见丧尸成为目标」用例同一组输入，只把参数名换成 targets
  const targets = [
    { id: 'z-near', position: [13.5, 4, 10.5] },
    { id: 'z-far', position: [10.5, 4, 14.5] },
  ];
  const r = computeTurretUpdates({ turrets, targets, world, registry });
  assertEqual(r.updates.length, 1);
  assertTrue(Math.abs(r.updates[0].targetYaw - Math.PI / 2) < 0.01, `yaw=${r.updates[0].targetYaw}`);
  assertTrue(r.updates[0].targetPitch < 0, '丧尸在 pivot 下方 → 俯视');
  assertTrue(Math.abs(r.updates[0].targetPitch) <= TURRET.maxPitchAngle + 1e-9);
  assertEqual(r.updates[0].hasTarget, true);
  assertEqual(r.updates[0].targetId, 'z-near');
});

test('炮塔索敌: 缺省 bodyOffsetY = 丧尸胸部偏移（不传时行为与改名前逐位相同）', () => {
  const { world, registry } = makeWorldFixture();
  const turrets = [{ id: 'turret-1', pivot: [10.5, 7.3, 10.5], rotation: 0 }];
  const target = { id: 'z1', position: [13.5, 4, 10.5] };
  const withDefault = computeTurretUpdates({ turrets, targets: [target], world, registry });
  const withExplicit = computeTurretUpdates({
    turrets, targets: [{ ...target, bodyOffsetY: TURRET.enemyBodyOffsetY }], world, registry,
  });
  assertEqual(withDefault.updates[0].targetPitch, withExplicit.updates[0].targetPitch);
  assertEqual(withDefault.updates[0].targetYaw, withExplicit.updates[0].targetYaw);
  // 且确实是「+1.2」而不是 0：pitch = atan2(4 + 1.2 − 7.3, 3)
  const expect = Math.atan2(4 + TURRET.enemyBodyOffsetY - 7.3, 3);
  assertTrue(Math.abs(withDefault.updates[0].targetPitch - expect) < 1e-9,
    `pitch=${withDefault.updates[0].targetPitch} 期望 ${expect}`);
});

test('炮塔索敌: 龙目标用 bodyOffsetY = 0（position 就是身体中心）', () => {
  const { world, registry } = makeWorldFixture();
  // 炮塔 pivot 在 y=6.3（地表 2 + 底座 1 + pivotHeightOffset 3.3），龙在 y=30、水平 24 格
  // → 垂直差 23.7，pitch = atan2(23.7, 24) ≈ 0.78 rad < maxPitchAngle(π/4≈0.785) → 不被钳制。
  // ⚠️ 若误用 +1.2 偏移，pitch 会超过 π/4 被钳到 0.785 → 本断言抓到（判别力来自钳制边界）。
  const turrets = [{ id: 'turret-1', pivot: [0, 6.3, 0], rotation: 0 }];
  const targets = [{ id: 'dragon:tarn:2:0:0', position: [24, 30, 0], bodyOffsetY: 0 }];
  const r = computeTurretUpdates({ turrets, targets, world, registry });
  assertEqual(r.updates[0].hasTarget, true);
  assertEqual(r.updates[0].targetId, 'dragon:tarn:2:0:0');
  const expected = Math.atan2(30 - 6.3, 24);
  assertTrue(Math.abs(r.updates[0].targetPitch - expected) < 1e-9,
    `pitch=${r.updates[0].targetPitch} 期望 ${expected}（bodyOffsetY 未生效）`);
  // 前置校验：这个 pitch 确实没被钳制（否则判据失去判别力）
  assertTrue(expected < TURRET.maxPitchAngle, `测试前提：${expected} 应 < maxPitchAngle`);
  // yaw 指向 +X
  assertTrue(Math.abs(r.updates[0].targetYaw - Math.PI / 2) < 0.01, `yaw=${r.updates[0].targetYaw}`);
});

test('炮塔索敌: 丧尸与龙同时在候选里，取最近', () => {
  const { world, registry } = makeWorldFixture();
  const turrets = [{ id: 'turret-1', pivot: [10.5, 7.3, 10.5], rotation: 0 }];
  const targets = [
    { id: 'dragon:tarn:2:0:0', position: [13.5, 8.5, 10.5], bodyOffsetY: 0 },   // 距 3 格（更近）
    { id: 'z1', position: [10.5, 4, 14.5] },                                // 距 4 格
  ];
  const r = computeTurretUpdates({ turrets, targets, world, registry });
  assertEqual(r.updates[0].targetId, 'dragon:tarn:2:0:0');
  // 反序输入也必须选同一个（不得依赖遍历顺序）
  const r2 = computeTurretUpdates({ turrets, targets: [...targets].reverse(), world, registry });
  assertEqual(r2.updates[0].targetId, 'dragon:tarn:2:0:0');
});

test('炮塔索敌: targets 缺省/为空时回归默认朝向（与 zombies: [] 同语义）', () => {
  const { world, registry } = makeWorldFixture();
  const turrets = [{ id: 'turret-1', pivot: [10.5, 7.3, 10.5], rotation: 1.2 }];
  const empty = computeTurretUpdates({ turrets, targets: [], world, registry });
  assertEqual(empty.updates[0].targetYaw, 1.2);
  assertEqual(empty.updates[0].targetPitch, 0);
  assertEqual(empty.updates[0].hasTarget, false);
  const missing = computeTurretUpdates({ turrets, world, registry });
  assertEqual(missing.updates[0].targetYaw, 1.2);
  assertEqual(missing.updates[0].hasTarget, false);
});
