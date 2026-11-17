// src/tests/test-turret-plant-place.js — 炮塔放在长草的地面上不得悬空（Tier 1）
//
// 用户报告（2026-11-18，截图 `炮塔悬空.png`）：「放置炮塔的时候，如果地面有草方块的话，
// 炮塔是放置在草方块之上的……在草的位置放置一个方块，正常情况下会覆盖这个草方块，
// 炮塔应该也一样，不应该被草方块顶上去而悬空。」
//
// **实测根因（真实游戏页单变量对照，seed 12345，地面 (287,5,104)）**：
//   · 地面 y=5 是 stone、y=6 种一株 short_grass → 主射线命中 **草格**（判据是「非空气且非水
//     即命中」）→ `placeBlock()` 把 `target.blockPos`（草格 y=6）当炮塔 origin →
//     蓝图 `BASE_DY=1` ⇒ 底座落在 **y=7**，草格 y=6 原样保留 ⇒ 炮塔与地面之间空一格。
//   · 清掉那株草后同一姿态：命中 stone(y=5) → 底座 **y=6**，正好贴地。
//   两侧唯一变量就是那一格草，底座高度差恰 1。
//
// 判据分三层（缺一层都会留下静默盲区）：
//   ① 纯函数 `registry.isPlant`：花草/藤/睡莲算植物，**水与 alias 不算**（否则会把水当地面）；
//   ② `TurretService.place()`：origin 落在植物格时下沉到地面格；蓝图格里的植物**可被覆盖**
//      （旧 occupied 判据要求 11 格全空气 → 邻格有草就整座放不下去）；
//   ③ 玩家真实路径 `placeBlock()`：target 由**真实 DDA** 算出（不手塞），走背包分流。
import { test } from './runner.js';
import { assertTrue, assertFalse, assertEqual, assertNotNull } from './assert.js';
import { Player } from '../player/player.js';
import { WorldData } from '../voxel/world-data.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { raycastVoxel } from '../player/raycast.js';
import { TurretService } from '../entities/turrets/turret-service.js';
import { createTurretBlueprint, BASE_DY } from '../entities/turrets/turret-blueprint.js';

function makeRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}

/** 地表高度（本文件所有夹具共用；地面格 = GROUND_Y，草格 = GROUND_Y+1） */
const GROUND_Y = 4;

/**
 * 世界夹具：cx/cz ∈ [-1,1] 三×三列（炮塔 3×3 底座会跨列），
 * 在 `groundCells` 指定的 (x,z) 上铺一层实心地面，其余保持空气。
 */
function makeWorld(registry, { groundCells, groundName = 'stone' }) {
  const world = new WorldData(registry);
  for (let cx = -1; cx <= 1; cx++) {
    for (let cz = -1; cz <= 1; cz++) {
      const col = new ChunkColumn(cx, cz);
      col.state = 'ready';
      world.add(col);
    }
  }
  const groundId = registry.idOf(groundName);
  for (const [x, z] of groundCells) world.setBlock(x, GROUND_Y, z, groundId, 0);
  return world;
}

/** 记录调用但仍委托真实 world 的 editor（fake 与真实口径不一致会让断言恒真）。 */
function makeEditor(world) {
  return {
    calls: [],
    setBlocks(cs) { this.calls.push(...cs); return world.setBlocks(cs); },
    setBlock(c) {
      this.calls.push(c);
      return world.setBlock(c.x, c.y, c.z, c.id, c.meta ?? 0, c.blockEntity);
    },
    setBlockEntity(req) {
      this.calls.push(req);
      const col = world.getColumn(Math.floor(req.x / 16), Math.floor(req.z / 16));
      if (col) col.setBlockEntity(req.x - Math.floor(req.x / 16) * 16, req.y,
        req.z - Math.floor(req.z / 16) * 16, req.value);
      return { changes: [], affected: [], changedColumns: [], skipped: [] };
    },
    subscribe: () => () => {},
  };
}

/** 3×3 地面（中心 [ox,oz]）的格坐标 */
function pad3x3(ox, oz) {
  const out = [];
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) out.push([ox + dx, oz + dz]);
  return out;
}

function makeService(world, registry, editor) {
  return new TurretService({
    world, editor, registry, blueprint: createTurretBlueprint(registry),
  });
}

/** Player 夹具（真实 Player + 真实物理 + 真实 DDA；camera 用最小 stub，本文件不 import three） */
function makePlayer(world, registry, editor, turrets) {
  const player = new Player({
    world, registry, editor, turrets,
    canvas: { addEventListener: () => {}, removeEventListener: () => {}, requestPointerLock: () => {} },
    camera: {
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0 },
      getWorldDirection: () => ({ x: 0, y: 0, z: -1 }),
    },
    scheduler: null,
  });
  const idx = player.inventory.slots.findIndex((s) => s.item === 'turret_alias_block');
  assertTrue(idx >= 0, '前提：炮塔物品在背包里');
  player.inventory.selectSlot(idx);
  return player;
}

/**
 * 摆真实相机姿态 → 真实 DDA 算 target → 真实 `placeBlock()`（背包分流）。
 * ⚠️ **不手塞 `player.target`**：那会绕过 `placeBlock()` 的 origin 分流，正是本缺陷的落点。
 */
function aimAndPlace(player, feet, aimPoint) {
  player.physics.pos = { x: feet[0], y: feet[1], z: feet[2] };
  player.physics.vel = { x: 0, y: 0, z: 0 };
  const eye = [feet[0], feet[1] + 1.62, feet[2]];
  const raw = [aimPoint[0] - eye[0], aimPoint[1] - eye[1], aimPoint[2] - eye[2]];
  const len = Math.hypot(...raw);
  const d = raw.map((v) => v / len);
  player.camera.position = { x: eye[0], y: eye[1], z: eye[2] };
  player.camera.getWorldDirection = (t) => { t.x = d[0]; t.y = d[1]; t.z = d[2]; return t; };
  const r = raycastVoxel(player.world, eye, d, 40);
  player.target = r.hit ? r : null;
  player.placeBlock();
  return player.target;
}

// ---------------------------------------------------------------------------
// ① 纯函数：什么算「可被覆盖的植物」
// ---------------------------------------------------------------------------

test('registry.isPlant：花草/藤/睡莲为真，水/空气/alias/实心方块为假', () => {
  const reg = makeRegistry();
  for (const name of ['short_grass', 'bush_grass', 'flower', 'allium', 'azure_bluet',
    'oxeye_daisy', 'red_mushroom', 'dead_bush', 'vine', 'lilypad']) {
    assertTrue(reg.isPlant(reg.idOf(name)), `${name} 应算植物`);
  }
  // ⚠️ 水必须为假：把水当「可覆盖的地表」会让炮塔沉到水底（用户没要求的语义变更）
  for (const name of ['air', 'water', 'swamp_water', 'stone', 'grass', 'cloud',
    'glass_block', 'leaves', 'mine_cart', 'bed_alias_block']) {
    assertFalse(reg.isPlant(reg.idOf(name)), `${name} 不应算植物`);
  }
  // 未知 id 防御性返回 false
  assertFalse(reg.isPlant(undefined), '未知 id 不算植物');
  assertFalse(reg.isPlant(9999), '越界 id 不算植物');
});

// ---------------------------------------------------------------------------
// ② 服务层：origin 归一 + 蓝图格植物可覆盖
// ---------------------------------------------------------------------------

test('炮塔放置：origin 落在草格 → 下沉到地面格，底座贴地且草被覆盖', () => {
  const reg = makeRegistry();
  const world = makeWorld(reg, { groundCells: pad3x3(4, 4) });
  const editor = makeEditor(world);
  const turrets = makeService(world, reg, editor);
  const plantY = GROUND_Y + 1;
  world.setBlock(4, plantY, 4, reg.idOf('short_grass'), 0);

  // origin 传的是**草格**（真实主射线命中草时 placeBlock 传的就是它）
  const r = turrets.place({ origin: [4, plantY, 4], playerAabb: null, rotation: 0 });
  assertTrue(r.ok, `放置须成功（reason=${r.reason}）`);
  // 底座层 = 地面格 + 1 = 草格所在层（不是草格 + 1）
  assertEqual(r.anchor[1], GROUND_Y + BASE_DY + 2, '锚点高度须与裸地放置逐位相同');
  assertEqual(world.getBlockId(4, plantY, 4), reg.idOf('iron_ore'), '草格被底座覆盖');
  assertEqual(world.getBlockId(4, GROUND_Y, 4), reg.idOf('stone'), '地面格本身不被替换');
  assertEqual(world.getBlockId(4, plantY + 1, 4), reg.idOf('obsidian'), '柱子紧接底座');
  // 锚点富状态里的 origin 也必须是归一后的地面格（pivot 由它派生，否则炮塔整体高一格）
  const anchorEntity = world.getBlockEntity(r.anchor[0], r.anchor[1], r.anchor[2]);
  assertNotNull(anchorEntity, '锚点 blockEntity 须写入');
  assertEqual(anchorEntity.origin[1], GROUND_Y, 'blockEntity.origin 须是地面格');
});

test('炮塔放置：3×3 底座里另有一株草 → 仍放下且那株草被覆盖（旧 occupied 会整座拒放）', () => {
  const reg = makeRegistry();
  const world = makeWorld(reg, { groundCells: pad3x3(4, 4) });
  const editor = makeEditor(world);
  const turrets = makeService(world, reg, editor);
  const plantY = GROUND_Y + 1;
  // 中心是裸地（origin 合法），但底座另一格长着 bush_grass
  world.setBlock(5, plantY, 5, reg.idOf('bush_grass'), 0);
  const r = turrets.place({ origin: [4, GROUND_Y, 4], playerAabb: null, rotation: 0 });
  assertTrue(r.ok, `邻格有草不得拒放（reason=${r.reason}）`);
  assertEqual(world.getBlockId(5, plantY, 5), reg.idOf('iron_ore'), '邻格草被覆盖');
  const iron = pad3x3(4, 4).filter(([x, z]) => world.getBlockId(x, plantY, z) === reg.idOf('iron_ore'));
  assertEqual(iron.length, 9, '9 格底座齐全');
});

test('炮塔放置：实心方块仍判 occupied 且零写入（放宽只针对植物）', () => {
  const reg = makeRegistry();
  const world = makeWorld(reg, { groundCells: pad3x3(4, 4) });
  const editor = makeEditor(world);
  const turrets = makeService(world, reg, editor);
  world.setBlock(5, GROUND_Y + 1, 5, reg.idOf('stone'), 0);
  const before = editor.calls.length;
  const r = turrets.place({ origin: [4, GROUND_Y, 4], playerAabb: null, rotation: 0 });
  assertEqual(r.reason, 'occupied');
  assertEqual(editor.calls.length, before, '失败路径零写入');
  assertEqual(turrets.count(), 0);
});

test('炮塔放置：水面不算地面 —— origin 在水格上不下沉、水格不被覆盖', () => {
  const reg = makeRegistry();
  const world = makeWorld(reg, { groundCells: pad3x3(4, 4) });
  const editor = makeEditor(world);
  const turrets = makeService(world, reg, editor);
  // 地面上方一格水，水上再一格空气：origin 取水格 → 水不是植物 ⇒ 原样当地面用
  world.setBlock(4, GROUND_Y + 1, 4, reg.idOf('water'), 0);
  const r = turrets.place({ origin: [4, GROUND_Y + 1, 4], playerAabb: null, rotation: 0 });
  assertTrue(r.ok, `水上放置须成功（reason=${r.reason}）`);
  assertEqual(r.anchor[1], GROUND_Y + 1 + BASE_DY + 2, '水格当 origin，不下沉');
  assertEqual(world.getBlockId(4, GROUND_Y + 1, 4), reg.idOf('water'), '水格保留');
});

test('炮塔放置：连着两株植物只下沉一格（不是一路挖到地面）', () => {
  const reg = makeRegistry();
  const world = makeWorld(reg, { groundCells: pad3x3(4, 4) });
  const editor = makeEditor(world);
  const turrets = makeService(world, reg, editor);
  world.setBlock(4, GROUND_Y + 1, 4, reg.idOf('short_grass'), 0);
  world.setBlock(4, GROUND_Y + 2, 4, reg.idOf('short_grass'), 0);
  const r = turrets.place({ origin: [4, GROUND_Y + 2, 4], playerAabb: null, rotation: 0 });
  assertTrue(r.ok, `放置须成功（reason=${r.reason}）`);
  assertEqual(r.anchor[1], GROUND_Y + 1 + BASE_DY + 2, '只下沉一格 → origin = GROUND_Y+1');
  assertEqual(world.getBlockId(4, GROUND_Y + 1, 4), reg.idOf('short_grass'), '下面那株草保留');
});

// ---------------------------------------------------------------------------
// ③ 玩家真实路径：真实 DDA 命中草 → placeBlock()
// ---------------------------------------------------------------------------

test('玩家路径：准心命中地面草格 → 炮塔底座贴地（与无草对照逐位同高）', () => {
  const reg = makeRegistry();
  // 玩家站在 (1.5, GROUND_Y+1, 4.5)，朝 +X 偏下看 (4.5, 草格中心, 4.5)
  const feet = [1.5, GROUND_Y + 1, 4.5];
  const results = [];
  for (const withPlant of [true, false]) {
    const world = makeWorld(reg, { groundCells: pad3x3(4, 4).concat([[1, 4]]) });
    const editor = makeEditor(world);
    const turrets = makeService(world, reg, editor);
    if (withPlant) world.setBlock(4, GROUND_Y + 1, 4, reg.idOf('short_grass'), 0);
    const player = makePlayer(world, reg, editor, turrets);
    const target = aimAndPlace(player, feet, [4.5, GROUND_Y + (withPlant ? 1 : 0) + 0.5, 4.5]);
    assertNotNull(target, '前提：主射线须命中');
    assertEqual(turrets.count(), 1, `放置须成功（withPlant=${withPlant}）`);
    const anchor = turrets.anchorOf('turret-1');
    results.push({
      hitName: reg.nameOf(world.getBlockId(target.blockPos[0], target.blockPos[1], target.blockPos[2])),
      baseY: anchor[1] - 2, anchorY: anchor[1],
      baseId: world.getBlockId(anchor[0], anchor[1] - 2, anchor[2]),
    });
    player.dispose();
  }
  // 有草时命中的确实是草（否则本用例测不到缺陷）
  assertEqual(results[0].hitName, 'iron_ore', '有草侧：草格已被底座覆盖');
  assertEqual(results[1].hitName, 'stone', '无草侧：命中的是地面');
  // ⚠️ 判据是**两侧底座同高**（绝对值），不是「有草侧比某数大」——
  // 只看单侧数字时「整体上移一格」在内部是一致的，断言会全绿（本缺陷正是这个形态）。
  assertEqual(results[0].baseY, results[1].baseY, '有草/无草底座必须同高');
  assertEqual(results[0].baseY, GROUND_Y + 1, '底座落在地面之上第一格');
  assertEqual(results[0].baseId, reg.idOf('iron_ore'));
});