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

test('BlockRegistry: 159 方块全部注册且 ID 唯一', () => {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  // 126 + 巨树景观 8 个 giant_* + 巨型金字塔 2 个 sand_step/sand_slab
  // + 浅水高台 2 个 dark_grass/light_grass
  // + 中世纪船 2 个 planks_step_updown/half_block_updown
  // + 废弃堡垒 15 个（9 整块/柱 + 4 台阶 + 2 半砖，2026-11-10）= 154
  // + 矮草丛 bush_grass（v3.12，2026-11-17）= 155
  // + 原版石砖三变体 + 紫珀方块（v3.19，2026-11-19）= 159
  assertEqual(reg.count, 159);
  const ids = new Set();
  for (const def of BLOCKS) ids.add(reg.idOf(def.name));
  assertEqual(ids.size, 159);
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

test('BlockRegistry: cloud 是实心（v1.96：云不可穿越）', () => {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  const cloud = reg.idOf('cloud');
  // 本改动的**唯一直接落点**。所有消费方（玩家/丧尸物理、炮塔 LOS 与弹丸、矿车、雨滴截停、
  // 放置兜底、结构探地）读的都是这张表 —— 改这里就是全都要改，不需要逐个追加判据。
  assertEqual(reg.solidTable[cloud], 1, 'cloud solidTable == 1（不可穿越）');
  // `supportsPlayer` 与之**叠加**而非替代：M2-7 的可站立语义原样保留（删它会改动向下碰撞的
  // 分支组合，属无收益的行为变更）。上面那条 `supportsPlayer 表仅 cloud=1` 门禁仍在守它。
  assertEqual(reg.supportsPlayerTable[cloud], 1, 'cloud 仍可站立（supportsPlayer 保留）');
  // 镂空/遮挡口径不受本改动影响：云仍不投影、且 opaqueTable 仍 1（同材质不透明）。
  assertEqual(reg.shadowCastTable[cloud], 0, 'cloud 仍不投影（shadowCast:false 未动）');
  assertEqual(reg.opaqueTable[cloud], 1, 'cloud opaqueTable 仍 1（M2-7 通道勘误未回退）');
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

test('isWeaponDestructible 读表而非字面量（不可破坏走 indestructibleTable 单一权威）', () => {
  const registry = makeRegistry();
  assertEqual(isWeaponDestructible(registry.idOf('bedrock'), registry), false);
  assertEqual(isWeaponDestructible(registry.idOf('stone'), registry), true);
  assertEqual(isWeaponDestructible(registry.idOf('air'), registry), false);
  // ⚠️ **v2.90 翻转**：end_stone 的武器专属免疫已按用户要求关闭
  // （「end_stone 原来的设定是不可被枪械消灭，把这个设定去掉」）。
  // 它本来就不在 indestructibleTable 里（那是全局语义），以前靠 `WEAPON_ONLY_IMMUNE`
  // 名单收紧；名单清空后它回到「普通可破坏方块」。
  // ⚠️ 副作用面比堡垒大：end_stone 同时是 `fillColumn` 的水底层与地标岩石基础层底
  // ⇒ 现在枪械/MAG7 能打穿湖海底（用户要的「也可以被消除」）。
  assertEqual(registry.isIndestructible(registry.idOf('end_stone')), false);
  assertEqual(isWeaponDestructible(registry.idOf('end_stone'), registry), true);
  assertEqual(isWeaponDestructible(registry.idOf('end_stone_bricks'), registry), true);
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

test('BlockRegistry: 全部 8 个树叶族都是 cutout 通道 + opaqueTable=1（2026-10-23 用户裁定）', () => {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  // 口径变更历史（写清楚免得后人反推错）：
  //   · v1.42 方案 C 只把 sky_leaves 改成 opaque（因为 mc-lite 的材质是无 alphaTest 的纯粉）
  //   · 2026-10-23 用户裁定：**所有树叶**都要镂空（cutout）+ 叶-叶共享面互剔（opaqueTable=1）
  //     → 普通树叶也不再是 opaqueTable=0。实测单棵普通树（树干 + 5³ 叶团）顶点 3068 → 664（−78.4%）。
  //     ⚠️ 连带后果是用户明确接受的：AO 遮挡 / blocklight 阻断 / **炮塔 LOS 与弹丸阻挡**。
  // 这条现在钉的是「两套口径同时成立」：通道必须是 cutout（镂空不能丢），
  // 剔除语义必须是 1（否则顶点 ×8，同巨树叶的教训）。
  const ALL_LEAVES = [
    'leaves', 'azalea_leaves', 'yellow_leaves',
    'realistic_yellow_leaves', 'swamp_leaves', 'snow_leaves', 'sky_leaves',
  ];
  assertEqual(ALL_LEAVES.length, 7, '7 个树叶族（realistic_oak_leaves 已于 2026-11-04 删除）');
  for (const name of ALL_LEAVES) {
    const id = reg.idOf(name);
    assertTrue(id > 0, `${name} registered`);
    // sky_leaves 的材质是 mc-lite 的无 alphaTest 纯粉 → 仍走 opaque 通道（方案 C，勿改）
    const expectedChannel = name === 'sky_leaves' ? 0 : 1;
    assertEqual(reg.cullTable[id], expectedChannel, `${name} 通道=${expectedChannel === 0 ? 'opaque' : 'cutout'}`);
    assertEqual(reg.opaqueTable[id], 1, `${name} opaqueTable=1（叶-叶共享面互剔）`);
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
  // + 矮草丛 bush_grass（v3.12，与 short_grass 同口径）
  const NO_CAST = [
    'cloud', 'flower', 'short_grass', 'bush_grass', 'allium', 'azure_bluet', 'dead_bush',
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

// ==================== 巨型金字塔（Giant Pyramid Epic）的两个新方块 ====================
//
// 钉的是「非 box 几何方块被误判成占满整格」这一类缺陷：`cullMode` 选渲染通道（决定
// alphaTest → 镂空与否），`opaque` 决定 `opaqueTable`（面剔除 / AO / blocklight / 炮塔 LOS）。
// 两者不是一个东西 —— 写成 `cullMode:"opaque"` 会让台阶的 alpha 被忽略、且 mesher 会剔掉
// 邻居方块朝向台阶的那一面（塔身上出现洞）。

test('巨型金字塔方块：sand_step / sand_slab 走 cutout + 显式 opaque:false（非 box 几何必须声明）', () => {
  const reg = makeRegistry();
  const byName = new Map(BLOCKS.map((b) => [b.name, b]));
  const cases = [['sand_step', 'planks_step', 4], ['sand_slab', 'half_block', 0]];
  for (const [name, geom, orientModes] of cases) {
    const def = byName.get(name);
    assertTrue(def !== undefined, `${name} 必须在 blocks-data.js 里声明`);
    assertEqual(def.cullMode, 'cutout', `${name} 走 cutout 通道`);
    assertEqual(def.opaque, false, `${name} 必须**显式** opaque:false（AGENTS.md：非 box 几何须显式声明）`);
    assertEqual(def.geometry, geom, `${name} 复用既有几何模板 ${geom}（禁止第二份几何定义）`);
    assertEqual(def.orientationModes, orientModes, `${name} 的 orientationModes`);
    const id = reg.idOf(name);
    assertEqual(reg.cullTable[id], 1, `${name} cullTable == 1 (cutout)`);
    assertEqual(reg.opaqueTable[id], 0, `${name} opaqueTable == 0（否则 mesher 剔邻居面 → 塔身出现洞）`);
    assertEqual(reg.solidTable[id], 1, `${name} 必须是实心（玩家要能站上去）`);
  }
});

test('巨型金字塔方块：几何模板真实存在（防几何名拼错 → 静默 fallback 立方体）', async () => {
  const { TEMPLATES } = await import('../mesh/mesher.js');
  for (const geom of ['planks_step', 'half_block']) {
    assertTrue(Array.isArray(TEMPLATES[geom]) && TEMPLATES[geom].length > 0,
      `TEMPLATES["${geom}"] 必须存在（拼错会让方块静默渲成立方体）`);
  }
  // 临界对照：台阶模板是 L 形（12 quad = 2 个 box），半砖是 6 quad（1 个 box）
  assertEqual(TEMPLATES.planks_step.length, 12, 'planks_step = 2 个箱体的 12 个 quad');
  assertEqual(TEMPLATES.half_block.length, 6, 'half_block = 1 个箱体的 6 个 quad');
});

test('巨型金字塔方块：faces-data 六面齐全且指向既有 sand tile（零新增贴图）', async () => {
  const { FACES_DATA, getFaceTile } = await import('../voxel/faces-data.js');
  for (const name of ['sand_step', 'sand_slab']) {
    const entry = FACES_DATA[name];
    assertTrue(Array.isArray(entry), `${name} 的 faces-data 必须是六面数组`);
    assertEqual(entry.length, 6, `${name} 必须有 6 个面`);
    for (let f = 0; f < 6; f++) {
      const tile = getFaceTile(name, f);
      assertTrue(typeof tile === 'string' && tile.length > 0, `${name} 面 ${f} 有 tile 名（实际 ${tile}）`);
      // 复用既有 sand / sand_side，不得引入新贴图文件
      assertTrue(tile === 'sand' || tile === 'sand_side', `${name} 面 ${f} 用既有 sand tile（实际 ${tile}）`);
    }
  }
  // 顶/底面用 sand（正面纹理），四侧用 sand_side —— 与 sand 方块同口径
  assertEqual(getFaceTile('sand_step', 2), 'sand', 'top = sand');
  assertEqual(getFaceTile('sand_step', 3), 'sand', 'bottom = sand');
  assertEqual(getFaceTile('sand_step', 0), 'sand_side', 'side = sand_side');
});

// --- v1.29：方块清单指纹（存档兼容性判定） ---

/**
 * 为什么需要指纹：`Persistence` 的 edits 行存**数字 ID**，而 ID = 注册顺序。
 * 从 `blocks-data.js` 删/插一行声明会让后面所有 ID 前移 → 旧存档的玩家改动**静默错位**。
 *
 * 这三条用例对应三种失效：① 指纹不稳定（每次启动不同 → 每次都清档）；
 * ② 指纹对顺序不敏感（ID 前移反而算作"兼容" → 静默错位）；
 * ③ 指纹把属性也混进去（改个 cullMode 就清掉玩家的世界 —— 过度清档）。
 */
test('BlockRegistry: fingerprint 稳定且区分注册顺序（存档兼容性判定的地基）', () => {
  const mk = (names) => {
    const r = createRegistry();
    for (const n of names) r.register(n, { solid: true });
    r.freeze();
    return r;
  };
  const a = mk(['air', 'stone', 'dirt', 'grass']);
  const b = mk(['air', 'stone', 'dirt', 'grass']);
  assertEqual(a.fingerprint(), b.fingerprint(), '同名同序 → 指纹相同（确定性）');

  // 删中间一项 → 后面全部前移 → 必须判为不兼容
  const removed = mk(['air', 'dirt', 'grass']);
  assertTrue(a.fingerprint() !== removed.fingerprint(),
    `删除中间一项后指纹必须变（${a.fingerprint()} ≠ ${removed.fingerprint()}）`);

  // 插入一项 → 同样前移
  const inserted = mk(['air', 'stone', 'cobblestone', 'dirt', 'grass']);
  assertTrue(a.fingerprint() !== inserted.fingerprint(), '插入一项后指纹必须变');

  // **顺序不同但集合相同**也必须不同（这才是 ID 前移的真实形态）
  const swapped = mk(['air', 'dirt', 'stone', 'grass']);
  assertTrue(a.fingerprint() !== swapped.fingerprint(),
    '交换两项顺序 → 指纹必须变（ID 语义变了，集合相同不够）');
});

test('BlockRegistry: fingerprint 不把方块属性算进去（改属性不该清档）', () => {
  const mk = (extra) => {
    const r = createRegistry();
    r.register('air', { solid: false });
    r.register('stone', { solid: true, ...extra });
    r.freeze();
    return r;
  };
  // 只改渲染/物理属性（cullMode / opaque / emissive）→ 已存 edits 的解释不变 → 不得清档
  assertEqual(mk({ cullMode: 'opaque' }).fingerprint(), mk({ cullMode: 'cutout', opaque: true, emissive: 15 }).fingerprint(),
    '属性变化不影响指纹（只有「名字的有序清单」进指纹）');
});

// --- v3.19：前缀指纹（末尾追加方块不得清档）---

/**
 * 为什么需要它：本期在 `BLOCKS` **末尾追加** 4 个方块（石砖三变体 + 紫珀）。
 * 既有 155 个 id **逐位未变**（实测），但全量指纹从 fc6212f5 变成 16d99151
 * ⇒ 原判据（全等）会把玩家手工建造全清掉，而它们本来完全可读。
 *
 * 判据 = 「旧清单是当前清单的**前缀**」：前 n 项的指纹相等 ⇒ 前 n 个 id 语义未变。
 * ⚠️ **中间插入 / 删除 / 换序仍必须判不兼容** —— 否则放宽成了「什么都不清」。
 */
test('BlockRegistry: fingerprintOfPrefix(count) ≡ fingerprint()（同一份哈希，不得两份实现）', () => {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  assertEqual(reg.fingerprintOfPrefix(reg.count), reg.fingerprint(), 'n=count 时逐位相等');
  assertTrue(/^[0-9a-f]{8}$/.test(reg.fingerprintOfPrefix(1)), '前缀指纹也是 8 位十六进制');
});

test('BlockRegistry: 末尾追加后方块的前缀指纹 == 追加前的全量指纹（旧存档可读）', () => {
  const mk = (names) => {
    const r = createRegistry();
    for (const n of names) r.register(n, { solid: true });
    r.freeze();
    return r;
  };
  const names = BLOCKS.map((b) => b.name);
  const old = mk(names.slice(0, 155));       // 本期之前的 155 项
  const now = mk(names);                     // 追加 4 项后
  assertTrue(old.fingerprint() !== now.fingerprint(), '全量指纹必须变（否则本用例无判别力）');
  assertEqual(now.fingerprintOfPrefix(155), old.fingerprint(),
    '前 155 项的指纹必须与旧全量指纹相等 ⇒ 既有 id 语义未变，不得清档');
});

test('BlockRegistry: 中间插入/删除/换序后前缀指纹必须不等（真位移仍清档）', () => {
  const mk = (names) => {
    const r = createRegistry();
    for (const n of names) r.register(n, { solid: true });
    r.freeze();
    return r;
  };
  const names = BLOCKS.map((b) => b.name);
  const oldFp = mk(names.slice(0, 155)).fingerprint();
  // ① 中间插入一项（在下标 20）⇒ 后面全部 +1
  const inserted = names.slice(0, 155);
  inserted.splice(20, 0, 'probe_block');
  assertTrue(mk(inserted).fingerprintOfPrefix(155) !== oldFp, '中间插入后前缀指纹必须变');
  // ② 删中间一项
  const removed = names.slice(0, 155);
  removed.splice(20, 1);
  removed.push('probe_block');
  assertTrue(mk(removed).fingerprintOfPrefix(155) !== oldFp, '删中间项后前缀指纹必须变');
  // ③ 换序（集合相同）
  const swapped = names.slice(0, 155);
  [swapped[20], swapped[21]] = [swapped[21], swapped[20]];
  assertTrue(mk(swapped).fingerprintOfPrefix(155) !== oldFp, '换序后前缀指纹必须变');
});

test('BlockRegistry: fingerprintOfPrefix 对非法 n 抛错（越界/负数/非整数）', () => {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  assertThrows(() => reg.fingerprintOfPrefix(reg.count + 1), '越界');
  assertThrows(() => reg.fingerprintOfPrefix(-1), '负数');
  assertThrows(() => reg.fingerprintOfPrefix(1.5), '非整数');
});

test('BlockRegistry: 生产 registry 的 fingerprint 是 8 位十六进制串', () => {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  const fp = reg.fingerprint();
  assertTrue(/^[0-9a-f]{8}$/.test(fp), `fingerprint 格式 ${fp}（8 位十六进制）`);
  // 稳定性：同一份 BLOCKS 再建一次必须相同（模块级缓存/随机数都不许混进来）
  const reg2 = createRegistry();
  for (const def of BLOCKS) reg2.register(def.name, def);
  reg2.freeze();
  assertEqual(reg2.fingerprint(), fp, '两次构建的指纹相同');
});
