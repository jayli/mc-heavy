import { test } from './runner.js';
import { assertEqual, assertThrows, assertTrue } from './assert.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';
import { Player } from '../player/player.js';
import { isWeaponDestructible } from '../player/weapons/weapon-target-policy.js';
import { buildItemNames } from '../player/inventory.js';

test('BlockRegistry: air 恒为 ID 0', () => {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  assertEqual(reg.idOf('air'), 0);
});

test('BlockRegistry: 126 方块全部注册且 ID 唯一', () => {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  assertEqual(reg.count, 126);
  const ids = new Set();
  for (const def of BLOCKS) ids.add(reg.idOf(def.name));
  assertEqual(ids.size, 126);
});

test('BlockRegistry: sky_stone/sky_grass 注册且 solid+opaque（M2-7 空岛）', () => {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  for (const name of ['sky_stone', 'sky_grass']) {
    const id = reg.idOf(name);
    assertTrue(id > 0, `${name} registered`);
    assertEqual(reg.solidTable[id], 1, `${name} solid`);
    assertEqual(reg.opaqueTable[id], 1, `${name} opaque`);
  }
});

test('BlockRegistry: supportsPlayer 表仅 cloud=1（M2-7 云可站立）', () => {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  assertEqual(reg.supportsPlayerTable[reg.idOf('cloud')], 1, 'cloud supports player');
  assertTrue(reg.supportsPlayer(reg.idOf('cloud')), 'supportsPlayer() helper');
  for (const name of ['air', 'stone', 'water', 'glass_block', 'sky_stone']) {
    assertEqual(reg.supportsPlayerTable[reg.idOf(name)], 0, `${name} not supports`);
  }
});

test('BlockRegistry: typed 表与声明一致', () => {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  const stone = reg.idOf('stone');
  assertEqual(reg.solidTable[stone], 1);
  assertEqual(reg.opaqueTable[stone], 1);
  const glass = reg.idOf('glass_block');
  assertEqual(reg.opaqueTable[glass], 0);       // 透明不遮光
  assertEqual(reg.cullTable[glass], 2);          // transparent 通道
  const leaves = reg.idOf('leaves');
  assertEqual(reg.cullTable[leaves], 1);         // cutout
  const lamp = reg.idOf('glowstone');
  assertEqual(reg.emissiveTable[lamp], 15);
  const air = reg.idOf('air');
  assertEqual(reg.solidTable[air], 0);
});

test('BlockRegistry: freeze 后 register 抛错', () => {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  assertThrows(() => reg.register('late_block', { solid: true }), 'frozen');
});

test('BlockRegistry: nameOf 反查', () => {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  assertEqual(reg.nameOf(reg.idOf('dirt')), 'dirt');
});

// ---------- M8：indestructible 单一权威（规格 §1） ----------

function makeRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}

/**
 * 记录调用的 fake editor（M8 Task 1）。断言必须落在 `calls` 上而非只看 world ——
 * 「零写入」的真实判据是编辑入口没被调用（world 里方块还在只是结果，不是原因）。
 */
function makeRecordingEditor() {
  return {
    calls: [],
    setBlock(c) { this.calls.push(c); },
    setBlocks(cs) { this.calls.push(...cs); return { changes: cs.length }; },
    setBlockEntity(r) { this.calls.push(r); },
  };
}

/** Player fixture：最小 world（一个 column）+ fake canvas（构造期会绑监听）。 */
function makePlayerFixture() {
  const registry = makeRegistry();
  const world = new WorldData(registry);
  world.add(new ChunkColumn(0, 0));
  const editor = makeRecordingEditor();
  const canvas = {
    addEventListener: () => {}, removeEventListener: () => {},
    requestPointerLock: () => {},
  };
  const player = new Player({
    world, registry, canvas, editor,
    camera: { position: { x: 0, y: 0, z: 0 }, rotation: { y: 0, x: 0 } },
    scheduler: null,
  });
  return { player, editor, world, registry };
}

test('indestructibleTable：bedrock 登记且可破坏方块判 false（M8 只登记一项）', () => {
  const registry = makeRegistry();
  // ① 表的单一权威：登记 bedrock
  assertTrue(registry.isIndestructible(registry.idOf('bedrock')), 'bedrock 不可破坏');
  // ② 临界值附近断言：可破坏方块必须判 false（不能把整表当恒真判据）
  assertEqual(registry.isIndestructible(registry.idOf('stone')), false);
  assertEqual(registry.isIndestructible(registry.idOf('tnt')), false);
  // ③ collider 系**不**登记（「不进背包」与「不可破坏」是两个互斥集合）
  assertEqual(registry.isIndestructible(registry.idOf('collider')), false);
  assertEqual(registry.isIndestructible(registry.idOf('realistic_trunk_collider')), false);
  // ④ 未知 id 防御（不存在的方块不该被当成不可破坏）
  assertEqual(registry.isIndestructible(999), false);
  assertEqual(registry.isIndestructible(undefined), false);
  // ⑤ M9 登记创造台两项（M8 期间这两条曾是 false —— 范围边界随 Epic 推进翻转）
  assertTrue(registry.isIndestructible(registry.idOf('playground_block')));
  assertTrue(registry.isIndestructible(registry.idOf('playground_center_block')));
  // ⑥ typed 表与查询方法同源（红线 1：两处漂移会让门禁误判）
  assertEqual(registry.indestructibleTable[registry.idOf('bedrock')], 1);
  assertEqual(registry.indestructibleTable[registry.idOf('stone')], 0);
});

test('digBlock 对 indestructible 方块零写入（编辑入口未被调用）', () => {
  const { player, editor, world, registry } = makePlayerFixture();
  const id = registry.idOf('bedrock');
  world.setBlock(4, 1, 4, id);
  player.target = { blockPos: [4, 1, 4], prevPos: [4, 2, 4], normal: [0, 1, 0], dist: 2 };
  const before = editor.calls.length;
  player.digBlock();
  assertEqual(editor.calls.length, before, '零写入');
  assertEqual(world.getBlockId(4, 1, 4), id, '方块还在');
  player.dispose();
});

test('digBlock 仍可挖掉普通方块（门控不是恒真）', () => {
  const { player, editor, world, registry } = makePlayerFixture();
  const stone = registry.idOf('stone');
  world.setBlock(4, 1, 4, stone);
  player.target = { blockPos: [4, 1, 4], prevPos: [4, 2, 4], normal: [0, 1, 0], dist: 2 };
  player.digBlock();
  assertEqual(editor.calls.length, 1, '一次写入');
  assertEqual(editor.calls[0].id, 0, '写成 air');
  player.dispose();
});

test('isWeaponDestructible 读表而非字面量（end_stone 是武器专属收紧）', () => {
  const registry = makeRegistry();
  assertEqual(isWeaponDestructible(registry.idOf('bedrock'), registry), false);
  assertEqual(isWeaponDestructible(registry.idOf('stone'), registry), true);
  assertEqual(isWeaponDestructible(registry.idOf('air'), registry), false);
  // end_stone 不在 indestructibleTable 里（武器专属），须保留排除
  assertEqual(registry.isIndestructible(registry.idOf('end_stone')), false);
  assertEqual(isWeaponDestructible(registry.idOf('end_stone'), registry), false);
});

/**
 * M9：创造台两项「登记 indestructible」与「移出背包」必须**成对**。
 *
 * 只做一半的两种撕裂状态（两条配对断言缺一不可 —— testing-policy §2.7「恒真陷阱」）：
 *   - 只登记不移出 → 玩家能从背包选中并放置平台方块，但挖不掉、TNT 也炸不掉；
 *   - 只移出不登记 → 平台本体可被玩家/枪械/TNT 破坏（平台随时被打穿）。
 * ③ 是临界值附近的对照断言：证明门控不是把整张表当恒真判据。
 */
test('创造台两项登记 indestructible 且移出背包（成对）', () => {
  const registry = makeRegistry();
  // ① 登记 indestructible（复用 M8 交付的表，不新建机制）
  assertTrue(registry.isIndestructible(registry.idOf('playground_block')));
  assertTrue(registry.isIndestructible(registry.idOf('playground_center_block')));
  // ② 移出背包物品集合（派生集合自动跟随排除集合）
  const items = buildItemNames(registry);
  assertEqual(items.includes('playground_block'), false);
  assertEqual(items.includes('playground_center_block'), false);
  // ③ 临界值附近断言：其他方块不受影响（防止把整表/整集合当恒真判据）
  assertEqual(items.includes('tnt'), true);
  assertEqual(items.includes('turret_alias_block'), true);
  assertEqual(registry.isIndestructible(registry.idOf('tnt')), false);
});

// ---------- 天空树（方案 C）：sky_leaves 通道归属契约 ----------

test('BlockRegistry: sky_leaves 走 opaque 通道（方案 C，spec §2.6）', () => {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  const id = reg.idOf('sky_leaves');
  assertTrue(id > 0, 'sky_leaves registered');
  // cullTable: 0=opaque 1=cutout 2=transparent 3=none（block-registry.js CULL_MODES）
  assertEqual(reg.cullTable[id], 0, 'sky_leaves → opaque 通道');
  // opaqueTable=1 是叶-叶面剔除（mesher.js:464）与 AO/光照/炮塔 LOS 连带效应的来源
  assertEqual(reg.opaqueTable[id], 1, 'sky_leaves opaqueTable=1');
  assertEqual(reg.solidTable[id], 1, 'sky_leaves solid（未改动）');
});

test('BlockRegistry: 其余 7 个树叶族仍走 cutout（防过度修正）', () => {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  // ⚠️ 反向断言：方案 C 只改 sky_leaves 一项。若有人顺手把全部树叶改成 opaque，
  // 这条会 FAIL —— mc-lite 那 7 项的材质确实是 alphaTest（真镂空，atlas 实测
  // leaves 中心 alpha=0.231 < 0.3 → discard），走 cutout 是正确的。
  const CUTOUT_LEAVES = [
    'leaves', 'azalea_leaves', 'yellow_leaves', 'realistic_oak_leaves',
    'realistic_yellow_leaves', 'swamp_leaves', 'snow_leaves',
  ];
  assertEqual(CUTOUT_LEAVES.length, 7, '计数：8 个树叶族 − sky_leaves');
  for (const name of CUTOUT_LEAVES) {
    const id = reg.idOf(name);
    assertTrue(id > 0, `${name} registered`);
    assertEqual(reg.cullTable[id], 1, `${name} 仍 cutout`);
    assertEqual(reg.opaqueTable[id], 0, `${name} opaqueTable=0`);
  }
});

// ---------- 太阳阴影投射表（§4.4.4）：对齐 mc-lite isShadowEnabled:false ----------

/**
 * mc-lite `BlockData.isShadowEnabled:false` 的 20 项（实测解析上游数据得出）。
 * 其中在 mc-heavy 走 cullMode 'none'/'transparent' 或不是方块的，通道级已排除投影，
 * 无需声明 shadowCast；**落在 opaque/cutout 通道的 13 项才需显式声明**。
 * 本测试钉住「声明侧 ↔ 派生表」双向一致（同 indestructible 的手法）。
 */
/**
 * 钉住 `register()` 真的写了 shadowCastTable 且**默认值是 1（投影）**。
 * ⚠️ 本用例不是「声明 ↔ 表双向一致」（那是恒真陷阱：registry 由 BLOCKS 逐条 register 构建，
 * 两侧名字必然同源 —— 同 check-data 的 [不可破坏] 环节已记录的教训）。它钉的是真实失效面：
 * 若 `register()` 漏写 `shadowCastTable[id] = ...`，Uint8Array 默认全 0 → **每个方块都被标成
 * 不投影** → 阴影系统静默失效（而声明侧看不出任何异常）。故必须验证「未声明者 = 1」。
 */
test('BlockRegistry: shadowCastTable 默认 1（漏写 register 会让全部方块不投影）', () => {
  const reg = makeRegistry();
  for (const def of BLOCKS) {
    const id = reg.idOf(def.name);
    const expect = def.shadowCast === false ? 0 : 1; // 默认 1（投影）
    assertEqual(reg.shadowCastTable[id], expect, `${def.name} shadowCastTable=${expect}`);
    assertEqual(reg.castsShadow(id), expect === 1, `${def.name} castsShadow()`);
  }
  // 临界对照：未声明 shadowCast 的方块必须是 1（不是 Uint8Array 默认的 0）
  assertEqual(reg.shadowCastTable[reg.idOf('stone')], 1, 'stone 未声明 → 默认投影');
});

test('BlockRegistry: cloud/花草/藤/灯/创造台不投影（mc-lite isShadowEnabled:false 口径）', () => {
  const reg = makeRegistry();
  // 落在 opaque/cutout 通道、mc-lite 不投影、故 mc-heavy 须声明 shadowCast:false 的 13 项
  const NO_CAST = [
    'cloud', 'flower', 'short_grass', 'allium', 'azure_bluet', 'dead_bush',
    'oxeye_daisy', 'red_mushroom', 'vine', 'lilypad',
    'playground_block', 'playground_center_block', 'hanging_lamp',
  ];
  for (const name of NO_CAST) {
    assertEqual(reg.castsShadow(reg.idOf(name)), false, `${name} 不投影`);
  }
  // 临界对照：地形/树/建筑主体仍投影（防止把整表当恒假判据）
  for (const name of ['stone', 'grass', 'dirt', 'wood', 'leaves', 'sky_leaves', 'bricks']) {
    assertEqual(reg.castsShadow(reg.idOf(name)), true, `${name} 仍投影`);
  }
});

test('BlockRegistry: castsShadow 对未知 id 返回 false（防御）', () => {
  const reg = makeRegistry();
  assertEqual(reg.castsShadow(-1), false);
  assertEqual(reg.castsShadow(9999), false);
  assertEqual(reg.castsShadow(1.5), false);
});
