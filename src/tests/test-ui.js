// M3-4 HUD：hotbar 图标裁剪计算 + 背包图标表 + 设置合并逻辑（纯函数单测）
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse } from './assert.js';
import { tileStyle, tileOfName, INVENTORY_ICONS } from '../ui/hotbar.js';
import { DEFAULT_SETTINGS, resolveSettings } from '../ui/settings.js';

test('hotbar: tileStyle 按 atlas tile 像素坐标算 background 裁剪', () => {
  const tile = { x: 144, y: 352, w: 16, h: 16 };
  const s = tileStyle(tile, 40, 2048);
  // 放大倍率 = 40/16 = 2.5；background-size = 2048×2.5 = 5120
  assertEqual(s.backgroundSize, '5120px 5120px');
  // 偏移 = -(x×2.5), -(y×2.5)
  assertEqual(s.backgroundPosition, '-360px -880px');
});

test('hotbar: tileStyle 非方形 tile（128 大图）按 w/h 各自缩放', () => {
  const tile = { x: 0, y: 1024, w: 128, h: 128 };
  const s = tileStyle(tile, 40, 2048);
  assertEqual(s.backgroundSize, '640px 640px'); // 2048 × 40/128
  assertEqual(s.backgroundPosition, '0px -320px'); // -(1024 × 0.3125)；x=0 → "0px"
});

// --- 背包图标表（§4.5.4 v1.23 建、v1.24 改等轴测） ---
// v1.23 根因：台阶等异形方块在 faces-data 里映射的是普通方块 tile，图标与母方块
// （planks / Cobblestone 等）完全一样，无法区分。mc-lite 的专用图标机制在
// `src/utils/ItemIconUtils.js:11` 的 `getCustomIconPath()`（14 项「方块名 → PNG 路径」表，
// `createItemIcon()` 命中即用、否则回落 `HUD.generateIcon()` 取材质 map）——**不在 HUD.js**，
// v1.23 文档曾误写为「HUD.js 的 getStepMaterial() 走 switch(name) 换材质」，该函数
// mc-lite 全仓零命中，已在 §4.5.4 v1.24 勘误。

// v1.24：异形方块改用**离线烘焙的等轴测投影图标**（形状权威 = mesher 的 TEMPLATES），
// 取代 v1.23 的 mc-lite 手工图标 tile。理由见 §4.5.4 v1.24 修订说明：
// ① 形状信息量更足（立体轮廓 vs 平面横截面图案）；② 采样游戏内实际贴图 → 配色一致
// （mc-lite 手工图标是金黄色栏杆、游戏内却是木色栏杆，观感割裂）。
test('hotbar: INVENTORY_ICONS 覆盖 9 项异形方块 + mine_cart', () => {
  // 异形方块 → 等轴测图标（tools/bake-isometric-icons.mjs 烘焙入 atlas）
  assertEqual(INVENTORY_ICONS.handrail, 'inventory-icons/handrail');
  assertEqual(INVENTORY_ICONS.handrailA, 'inventory-icons/handrailA');
  assertEqual(INVENTORY_ICONS.handrailB, 'inventory-icons/handrailB');
  assertEqual(INVENTORY_ICONS.vertical_pillar, 'inventory-icons/vertical_pillar');
  assertEqual(INVENTORY_ICONS.horizontal_pillar, 'inventory-icons/horizontal_pillar');
  assertEqual(INVENTORY_ICONS.planks_step, 'inventory-icons/planks_step');
  assertEqual(INVENTORY_ICONS.cobblestone_step, 'inventory-icons/cobblestone_step');
  assertEqual(INVENTORY_ICONS.cobblestone_step_updown, 'inventory-icons/cobblestone_step_updown');
  assertEqual(INVENTORY_ICONS.stone_diorite_step, 'inventory-icons/stone_diorite_step');
  // 矿车保持 mc-lite 手工图标：它是**实体**不是方块，mesher 无其几何模板 → 等轴测不适用
  assertEqual(INVENTORY_ICONS.mine_cart, 'Invicon_Minecart');
  assertEqual(Object.keys(INVENTORY_ICONS).length, 10,
    '恰好 10 项（9 异形 + 矿车；勿混入非图标 tile）');
});

test('hotbar: tileOfName 异形方块返回等轴测图标 tile', () => {
  for (const [block, tile] of [
    ['handrail', 'inventory-icons/handrail'],
    ['handrailA', 'inventory-icons/handrailA'],
    ['handrailB', 'inventory-icons/handrailB'],
    ['vertical_pillar', 'inventory-icons/vertical_pillar'],
    ['horizontal_pillar', 'inventory-icons/horizontal_pillar'],
    ['planks_step', 'inventory-icons/planks_step'],
    ['cobblestone_step', 'inventory-icons/cobblestone_step'],
    ['cobblestone_step_updown', 'inventory-icons/cobblestone_step_updown'],
    ['stone_diorite_step', 'inventory-icons/stone_diorite_step'],
  ]) {
    assertEqual(tileOfName(block), tile);
  }
});

test('hotbar: tileOfName mine_cart 返回 Invicon_Minecart（原为 undefined 空槽）', () => {
  assertEqual(tileOfName('mine_cart'), 'Invicon_Minecart');
});

/**
 * 回归防线：异形方块图标**不得**回落到 faces-data 的世界渲染贴图。
 * 若有人删掉 INVENTORY_ICONS 查表（或把表清空），这些方块会静默退回 faces-data——
 * 台阶退回母方块贴图（与 planks/Cobblestone 撞脸）、栏杆柱子退回 `procedural/*`
 * 纯色贴图（彼此撞脸），正是本次要修的两个 bug。
 */
test('hotbar: tileOfName 异形方块不得回落世界渲染贴图（回归防线）', () => {
  // 台阶：不得回落母方块贴图
  assertFalse(tileOfName('planks_step') === 'planks_birch',
    'planks_step 图标不得是 planks_birch');
  assertFalse(tileOfName('cobblestone_step') === 'Cobblestone',
    'cobblestone_step 图标不得是 Cobblestone');
  assertFalse(tileOfName('cobblestone_step_updown') === 'Cobblestone',
    'cobblestone_step_updown 图标不得是 Cobblestone');
  assertFalse(tileOfName('stone_diorite_step') === 'stone_diorite',
    'stone_diorite_step 图标不得是 stone_diorite');
  // 栏杆/柱子：不得回落 procedural/* 纯色世界贴图（彼此几乎相同 → 撞脸）
  assertFalse(tileOfName('handrail') === 'procedural/handrail',
    'handrail 图标不得是纯色世界贴图');
  assertFalse(tileOfName('vertical_pillar') === 'procedural/pillar',
    'vertical_pillar 图标不得是纯色世界贴图');
  assertFalse(tileOfName('horizontal_pillar') === 'procedural/pillar_horizontal',
    'horizontal_pillar 图标不得是纯色世界贴图');
  // 倒置台阶与正置台阶必须不同图标（几何形状相反，撞脸等于丢失辨识度）
  assertFalse(tileOfName('cobblestone_step_updown') === tileOfName('cobblestone_step'),
    '正置/倒置台阶图标必须不同');
  // 竖柱与横梁必须不同图标（几何形状相反）
  assertFalse(tileOfName('vertical_pillar') === tileOfName('horizontal_pillar'),
    '竖柱/横梁图标必须不同');
});

test('hotbar: tileOfName 普通方块仍走 faces-data（图标表不误伤其余 108 项）', () => {
  assertEqual(tileOfName('stone'), 'stone');
  assertEqual(tileOfName('cobblestone'), 'Cobblestone'); // faces-data 里是大写 C
  assertEqual(tileOfName('planks'), 'planks_birch');
  // 母方块本身不在图标表里 → 保持原行为
  assertFalse('cobblestone' in INVENTORY_ICONS, 'cobblestone 不进图标表');
  assertFalse('planks_birch' in INVENTORY_ICONS, 'planks 不进图标表');
  // 本次范围外的异形方块保持平面贴图现状（勿擅自扩大覆盖范围）
  assertFalse('cactus' in INVENTORY_ICONS, 'cactus 不进图标表（保持平面贴图）');
  assertFalse('vine' in INVENTORY_ICONS, 'vine 不进图标表（保持平面贴图）');
  assertFalse('hanging_lamp' in INVENTORY_ICONS, 'hanging_lamp 不进图标表（保持平面贴图）');
  assertFalse('chimney' in INVENTORY_ICONS, 'chimney 不进图标表（不在背包内）');
});

test('hotbar: tileOfName 无 faces-data 且无图标表的方块仍返回 undefined', () => {
  assertEqual(tileOfName('bed_alias_block'), undefined);
  assertEqual(tileOfName('不存在的方块'), undefined);
});

/**
 * 图标表指向的 tile 必须真实存在于 atlas —— 否则渲染出空槽（与 bug 同观感，
 * 但根因不同：拼错 tile 名时不会有任何报错）。用真实 atlas.json 校验。
 */
test('hotbar: INVENTORY_ICONS 指向的 tile 全部存在于 atlas.json', async () => {
  const atlas = await (await fetch('/assets/atlas.json')).json();
  for (const [block, tileName] of Object.entries(INVENTORY_ICONS)) {
    assertTrue(!!atlas.tiles[tileName], `${block} 的图标 tile "${tileName}" 存在于 atlas`);
  }
});

test('settings: 默认值（vd=8 / blur=off / volume=1 / 风格自动）', () => {
  assertEqual(DEFAULT_SETTINGS.viewDistance, 8);
  assertEqual(DEFAULT_SETTINGS.blur, false);
  assertEqual(DEFAULT_SETTINGS.volume, 1);
  assertEqual(DEFAULT_SETTINGS.visualStyle, null);
});

test('settings: resolveSettings 优先级 URL > 存储 > 默认', () => {
  // 无存储无 URL → 默认
  const d = resolveSettings(null, new URLSearchParams(''));
  assertEqual(d.viewDistance, 8);
  // 存储覆盖默认
  const s1 = resolveSettings({ viewDistance: 4, volume: 0.5 }, new URLSearchParams(''));
  assertEqual(s1.viewDistance, 4);
  assertEqual(s1.volume, 0.5);
  assertEqual(s1.blur, false); // 未存字段回落默认
  // URL 覆盖存储
  const s2 = resolveSettings({ viewDistance: 4 }, new URLSearchParams('vd=12&blur=1'));
  assertEqual(s2.viewDistance, 12);
  assertEqual(s2.blur, true);
});

test('settings: resolveSettings 视距钳制到合法档位（2~16）', () => {
  const s = resolveSettings({ viewDistance: 999 }, new URLSearchParams(''));
  assertEqual(s.viewDistance, 16);
  const s2 = resolveSettings(null, new URLSearchParams('vd=0'));
  assertEqual(s2.viewDistance, 2); // 钳制下限 = 架构最小值（M1 测试/调试用 vd=2）
  const s3 = resolveSettings(null, new URLSearchParams('vd=abc'));
  assertEqual(s3.viewDistance, 8); // 非法值回落默认
  // vd=2 保持 2（UI 预设从 4 起，但 URL/测试可达架构下限）
  assertEqual(resolveSettings(null, new URLSearchParams('vd=2')).viewDistance, 2);
});

test('settings: volume 钳制 [0,1]', () => {
  assertEqual(resolveSettings({ volume: 5 }, new URLSearchParams('')).volume, 1);
  assertEqual(resolveSettings({ volume: -1 }, new URLSearchParams('')).volume, 0);
});

test('settings: visualStyle 只接受合法键', () => {
  assertEqual(resolveSettings({ visualStyle: 'night' }, new URLSearchParams('')).visualStyle, 'night');
  assertEqual(resolveSettings({ visualStyle: 'bogus' }, new URLSearchParams('')).visualStyle, null);
  assertEqual(resolveSettings(null, new URLSearchParams('style=morning')).visualStyle, 'morning');
});
