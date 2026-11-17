// src/tests/test-inventory.js — M3.1 背包物品模型（设计文档 §4.5.4，v1.16 定稿）
// 覆盖：Slot/Inventory 数据模型（照搬 mc-lite Slots.js 语义）、BlockRegistry.all() 遍历接口、
// 物品集合构建（126 排除 4 个功能性方块 + chimney → 121 项；前 HOTBAR_SIZE 项顺序冻结 = HOTBAR_ITEMS）、
// 创造模式无限背包填充（count=1500 占位、不消耗）。
import { test } from './runner.js';
import {
  assertEqual, assertTrue, assertFalse, assertNull, assertIncludes, assertDeepEqual,
} from './assert.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { HOTBAR_ITEMS, HOTBAR_SIZE } from '../player/hotbar-items.js';
import {
  Slot, Inventory, DEFAULT_INVENTORY_COUNT, NON_PLACEABLE_ITEMS, HIDDEN_FROM_INVENTORY,
  buildItemNames, createCreativeInventory,
} from '../player/inventory.js';

/** 生产同源注册表（与 main.js/worker 一致：BLOCKS 全量注册后冻结） */
function makeRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}

// --- Slot：单槽位（mc-lite Slots.js 语义） ---

test('Slot: 默认构造为空槽（item=null / count=0 / isEmpty）', () => {
  const s = new Slot(3);
  assertEqual(s.id, 3);
  assertNull(s.item);
  assertEqual(s.count, 0);
  assertTrue(s.isEmpty());
  assertDeepEqual(s.meta, {});
});

test('Slot: set 写入后非空，clear 复位为空', () => {
  const s = new Slot(0);
  s.set('stone', 64, { durability: 1 });
  assertEqual(s.item, 'stone');
  assertEqual(s.count, 64);
  assertDeepEqual(s.meta, { durability: 1 });
  assertFalse(s.isEmpty());
  s.clear();
  assertNull(s.item);
  assertEqual(s.count, 0);
  assertDeepEqual(s.meta, {});
  assertTrue(s.isEmpty());
});

test('Slot: count<=0 视为空（isEmpty 双重判据 item===null || count<=0）', () => {
  const zero = new Slot(0, 'stone', 0);
  assertTrue(zero.isEmpty(), 'count=0 有物品名仍算空');
  const neg = new Slot(0, 'stone', -5);
  assertTrue(neg.isEmpty(), '负 count 算空');
  const ok = new Slot(0, 'stone', 1);
  assertFalse(ok.isEmpty());
});

// --- Inventory：背包容器 ---

test('Inventory: 默认 1000 槽（mc-lite 同）/ selectedSlot=0 / getSelected 返回首槽', () => {
  const inv = new Inventory();
  assertEqual(inv.slots.length, 1000);
  assertEqual(inv.selectedSlot, 0);
  assertEqual(inv.getSelected(), inv.slots[0]);
  assertTrue(inv.getSelected().isEmpty(), '新背包全空');
  // 槽位 id 与索引一致
  assertEqual(inv.slots[7].id, 7);
});

test('Inventory: selectSlot 改选中槽且 getSelected 跟随（可越出快捷栏 5 格）', () => {
  const inv = new Inventory();
  inv.slots[0].set('stone', 1);
  inv.slots[9].set('sand', 1);
  inv.selectSlot(0);
  assertEqual(inv.getSelected().item, 'stone');
  inv.selectSlot(9);
  assertEqual(inv.selectedSlot, 9, 'selectedSlot 允许 > 4');
  assertEqual(inv.getSelected().item, 'sand');
  assertEqual(inv.getSelected(), inv.slots[9]);
});

test('Inventory: add 堆叠优先——同类槽 count 累加、不占新槽', () => {
  const inv = new Inventory();
  inv.add('stone', 10);
  inv.add('stone', 5);
  assertEqual(inv.slots[0].item, 'stone');
  assertEqual(inv.slots[0].count, 15, '堆叠到同一槽');
  assertTrue(inv.slots[1].isEmpty(), '第二槽未被占用');
  assertEqual(inv.add('stone', 1), true);
});

test('Inventory: add 无同类时落入首个空槽', () => {
  const inv = new Inventory();
  inv.add('stone', 1);
  inv.add('dirt', 2);
  inv.add('grass', 3);
  assertEqual(inv.slots[0].item, 'stone');
  assertEqual(inv.slots[1].item, 'dirt');
  assertEqual(inv.slots[1].count, 2);
  assertEqual(inv.slots[2].item, 'grass');
});

test('Inventory: has 跨槽累加判定', () => {
  const inv = new Inventory();
  inv.slots[0].set('stone', 3);
  inv.slots[5].set('stone', 4);
  assertTrue(inv.has('stone', 7), '两槽合计 7');
  assertFalse(inv.has('stone', 8), '不足 8');
  assertFalse(inv.has('dirt', 1), '完全没有的物品');
  assertTrue(inv.has('stone'), '默认 count=1');
});

test('Inventory: remove 扣减；扣到 0 清空该槽（count<=0 视为空）', () => {
  const inv = new Inventory();
  inv.add('stone', 5);
  assertEqual(inv.remove('stone', 2), true);
  assertEqual(inv.slots[0].count, 3);
  assertFalse(inv.slots[0].isEmpty());
  assertEqual(inv.remove('stone', 3), true);
  assertNull(inv.slots[0].item, '扣到 0 应 clear');
  assertEqual(inv.slots[0].count, 0);
  assertTrue(inv.slots[0].isEmpty());
  assertEqual(inv.remove('stone', 1), false, '数量不足返回 false');
  assertEqual(inv.remove('dirt', 1), false, '无该物品返回 false');
});

test('DEFAULT_INVENTORY_COUNT = 1500（对齐 mc-lite GameConfig）', () => {
  assertEqual(DEFAULT_INVENTORY_COUNT, 1500);
});

// --- BlockRegistry.all()：遍历接口（§4.1 v1.16 补记，冷路径专用） ---

test('registry.all(): 按注册顺序返回 155 条 {id,name}，与 idOf/nameOf 一致', () => {
  const reg = makeRegistry();
  const all = reg.all();
  assertEqual(all.length, 155);  // 126 + 巨树 8 + 金字塔 2 + 浅水高台 2（dark_grass/light_grass）− 已删 realistic_oak_leaves
                                  // + 中世纪船 2（planks_step_updown/half_block_updown）
                                  // + 废弃堡垒 15（9 整块/柱 + 4 台阶 + 2 半砖，2026-11-10）
                                  // + 矮草丛 1（bush_grass，2026-11-17）
  assertEqual(all[0].name, 'air', '注册序首项 = air（ID 0）');
  assertEqual(all[0].id, 0);
  for (const e of all) {
    assertEqual(reg.idOf(e.name), e.id, `${e.name} idOf 一致`);
    assertEqual(reg.nameOf(e.id), e.name, `${e.name} nameOf 一致`);
  }
  // 顺序 = 注册顺序（非字典序）
  assertDeepEqual(all.map((e) => e.name).slice(0, 5),
    ['air', 'collider', 'water', 'swamp_water', 'cloud']);
});

test('registry.all(): 冻结后结果稳定（两次调用逐项一致，可安全缓存）', () => {
  const reg = makeRegistry();
  assertDeepEqual(reg.all(), reg.all());
});

// --- 物品集合构建（§4.5.4：121 项 + 顺序冻结） ---

test('NON_PLACEABLE_ITEMS = 4 个功能性方块（mc-lite 背包同样排除）', () => {
  assertDeepEqual(NON_PLACEABLE_ITEMS,
    ['air', 'collider', 'calcite', 'realistic_trunk_collider']);
});

test('HIDDEN_FROM_INVENTORY = chimney + 三个床方块 + 创造台两项（6 项，可放置但不进背包）', () => {
  // 这些方块都可放置（能放能挖），故**不能**归入 NON_PLACEABLE_ITEMS
  // （该集合语义是「非玩家可放置的功能性方块」）。它们属独立概念：可放置、但不进背包。
  // bed_head/bed_tail/bed_alias_block：床渲染存在未修复的镂空透视问题，靠「不入背包 →
  // 玩家选不到 → 实际不会被放置」规避（详见 mesher.js 的 TODO），本质仍可放可挖。
  // playground 两项（M9）：平台方块登记 indestructible，留在背包会产出「放得出来但挖不掉」
  // 的撕裂状态（与登记必须成对做，见 inventory.js 的注释）。
  // 巨树 8 项（giant_*）：生成期地形装饰，放出来只是「没有下文的一块树干/树叶」。
  assertDeepEqual(HIDDEN_FROM_INVENTORY, [
    'chimney', 'bed_head', 'bed_tail', 'bed_alias_block',
    'playground_block', 'playground_center_block',
  ]);
  // 与 NON_PLACEABLE_ITEMS 不得重叠（语义互斥，避免两处排除混淆）
  for (const n of HIDDEN_FROM_INVENTORY) {
    assertFalse(NON_PLACEABLE_ITEMS.includes(n), `${n} 不应同时属于 NON_PLACEABLE_ITEMS`);
  }
});

test('buildItemNames: 145 项（155 - 4 功能性 - 6 可放置但不进背包）', () => {
  const names = buildItemNames(makeRegistry());
  // ⚠️ M9：HIDDEN_FROM_INVENTORY 4 → 6（追加创造台两项）→ 物品集合 118 → 116。
  // 巨树景观：registry 126 → 134、HIDDEN 6 → 14（8 个 giant_* 全部不进背包）→ 仍是 116。
  // 这是硬编码计数的冻结断言，改数字须连算式注释一起改（否则注释与断言漂移）。
  // ⚠️ 浅水高台（v2.11）：两个草方块进背包 → 126 → 128。
  // ⚠️ 中世纪船 Epic：两个新方块（倒置台阶 / 倒置半砖）进背包 → 128 → 130
  //    （用户明确要求「新烘焙出来的方块要加到背包里」）。
  // ⚠️ 废弃堡垒（2026-11-10）：15 个新方块全部进背包 → 129 → 144
  //    （用户同一裁定：「新制作的方块加入背包里」）。
  // ⚠️ 矮草丛（v3.12，2026-11-17）：bush_grass 进背包 → 144 → 145
  //    （用户同一裁定：新方块默认进背包）。
  // 改数字须连算式注释一起改（否则注释与断言漂移）。
  assertEqual(names.length, 145, '155 - 4 - 6 = 145');
  assertEqual(new Set(names).size, 145, '无重复');
  for (const bad of NON_PLACEABLE_ITEMS) {
    assertFalse(names.includes(bad), `${bad} 不应在物品集合内`);
  }
  for (const bad of HIDDEN_FROM_INVENTORY) {
    assertFalse(names.includes(bad), `${bad} 不应在物品集合内`);
  }
  // 常规建材应在内
  for (const good of ['stone', 'dirt', 'grass', 'sand', 'cobblestone', 'glass_block', 'wood']) {
    assertIncludes(names, good, `${good} 应在物品集合内`);
  }
});

test('buildItemNames: 前 HOTBAR_SIZE 项 = HOTBAR_ITEMS（快捷栏顺序冻结，§4.5.4）', () => {
  const names = buildItemNames(makeRegistry());
  assertEqual(HOTBAR_SIZE, 9, 'v2.96：快捷栏 5 → 9 格（对齐原版 1~9）');
  assertEqual(HOTBAR_ITEMS.length, HOTBAR_SIZE, '清单长度必须与格数一致（否则尾部格恒空）');
  assertDeepEqual(names.slice(0, HOTBAR_SIZE), HOTBAR_ITEMS, '与既有快捷栏常量同源');
  // 注册序前 5 项是 water/swamp_water/cloud/… —— 证明本函数不是纯注册序
  assertFalse(names[0] === 'water', '不应让 water 占据快捷栏首格');
});

test('buildItemNames: 第 HOTBAR_SIZE+1 项起按注册顺序补全且不再重复前置项', () => {
  const names = buildItemNames(makeRegistry());
  const rest = names.slice(HOTBAR_SIZE);
  assertEqual(rest.length, 136, '145 - 9');
  const reg = makeRegistry();
  const registered = reg.all().map((e) => e.name)
    .filter((n) => !NON_PLACEABLE_ITEMS.includes(n)
      && !HIDDEN_FROM_INVENTORY.includes(n) && !HOTBAR_ITEMS.includes(n));
  assertDeepEqual(rest, registered, '其余项 = 注册序（排除功能性方块、chimney 与前置项）');
});

test('buildItemNames: 含 mine_cart（mc-lite 背包包含，保留玩法可用性）；不含床方块', () => {
  const names = buildItemNames(makeRegistry());
  assertIncludes(names, 'mine_cart');
  // 床方块三项已从背包移除（规避渲染问题，见 HIDDEN_FROM_INVENTORY 注释）
  for (const bed of ['bed_head', 'bed_tail', 'bed_alias_block']) {
    assertFalse(names.includes(bed), `${bed} 不应在物品集合内`);
  }
});

test('buildItemNames: 确定性——两次构建逐项一致（红线 2：无随机/无迭代顺序依赖）', () => {
  const a = buildItemNames(makeRegistry());
  const b = buildItemNames(makeRegistry());
  assertDeepEqual(a, b);
});

// --- 创造模式无限背包填充 ---

test('createCreativeInventory: 145 槽全部非空且 count=DEFAULT_INVENTORY_COUNT', () => {
  const inv = createCreativeInventory(makeRegistry());
  const filled = inv.slots.filter((s) => !s.isEmpty());
  // ⚠️ M9：物品集合 118 → 116（创造台两项移出）→ 填充槽数随之变，首个空槽 = 下标 116
  // ⚠️ 中世纪船 Epic：128 → 130（两个新方块进背包），首个空槽 = 下标 130
  // ⚠️ 废弃堡垒（2026-11-10）：129 → 144（15 个新方块进背包），首个空槽 = 下标 144
  // ⚠️ 矮草丛（v3.12，2026-11-17）：144 → 145（bush_grass），首个空槽 = 下标 145
  assertEqual(filled.length, 145, '物品集合全量入包');
  for (const s of filled) assertEqual(s.count, DEFAULT_INVENTORY_COUNT, `${s.item} count=1500`);
  // 剩余槽位保持空（未来生存 Epic 的掉落/拾取可用）；首个空槽 = 下标 145
  assertTrue(inv.slots[145].isEmpty());
  assertEqual(inv.slots.length, 1000);
  // 不入包的 6 项（= HIDDEN_FROM_INVENTORY 全量）
  for (const n of HIDDEN_FROM_INVENTORY) {
    assertFalse(inv.slots.some((s) => s.item === n), `${n} 不入包`);
  }
});

test('createCreativeInventory: 槽序 = buildItemNames，selectedSlot=0 选中 stone', () => {
  const inv = createCreativeInventory(makeRegistry());
  const names = buildItemNames(makeRegistry());
  for (let i = 0; i < names.length; i++) {
    assertEqual(inv.slots[i].item, names[i], `slots[${i}] = ${names[i]}`);
    assertEqual(inv.slots[i].id, i);
  }
  assertEqual(inv.selectedSlot, 0);
  assertEqual(inv.getSelected().item, 'stone', '放块默认取 stone（与 M3-4 行为一致）');
});

test('createCreativeInventory: 快捷栏视图 = slots[0..HOTBAR_SIZE-1]（单一权威，无第二份物品状态）', () => {
  const inv = createCreativeInventory(makeRegistry());
  assertDeepEqual(inv.slots.slice(0, HOTBAR_SIZE).map((s) => s.item), HOTBAR_ITEMS);
  // v2.96：后 4 项是用户指定的常用物品，不是注册序的自然延伸（water/cloud 不得占位）
  // 2026-11-14：第 9 项按用户裁定 `mine_cart` → `leaves`（矿车仍在背包，只是不在快捷栏）
  assertDeepEqual(HOTBAR_ITEMS.slice(5), ['wood', 'glass_block', 'tnt', 'leaves']);
  // 反向：leaves 必须在物品集合内（否则快捷栏第 9 格图标会缺失）
  assertIncludes(HOTBAR_ITEMS, 'leaves', '快捷栏第 9 格是 leaves');
});

test('createCreativeInventory: 创造模式不消耗——模拟放块 200 次后 count 不变', () => {
  const inv = createCreativeInventory(makeRegistry());
  const before = inv.getSelected().count;
  for (let i = 0; i < 200; i++) {
    inv.getSelected(); // 放块只读取，不递减（§4.5.4 创造模式语义）
  }
  assertEqual(inv.getSelected().count, before, 'count 是占位字段，不参与消耗');
  assertEqual(before, DEFAULT_INVENTORY_COUNT);
});
