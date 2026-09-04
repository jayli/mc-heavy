// src/tests/test-ui.js — 设置合并逻辑 + 图标 manifest 契约（纯函数单测）
//
// **v1.26 说明（为什么这里少了 9 个用例）**：图标路径改为**预生成 CSS 串**
// （`npm run icons` → `assets/icons.json`，运行时只读 `icon.style.background = css`），
// `tileStyle()`（裁剪数学）/ `tileOfName()`（两级查表）/ `INVENTORY_ICONS`（例外表）
// 已删除 → 钉死它们的用例一并移除。这 9 个用例正是 `docs/testing-policy.md` 说的
// 「改动放大器」：钉的是 tile 名字符串与裁剪参数，改一次贴图地址就要改断言。
//
// 它们保护的失效路径（「异形方块图标回落到 faces-data 的世界渲染贴图 → 撞脸」）在
// 新架构下**结构上不存在**——图标不再从 faces-data 派生，而是独立烘焙产物。
// 等价保障改由两处承担：① `tools/bake-icon-atlas.mjs` 的逐面采样（Tier 1 单测
// `test-iso-icon.js` 钉「grass 顶面必须是草绿、不得采成土色」）；② `npm run check:data`
// 的图标契约检查（背包每项都有图标 + 图标未过期）。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse } from './assert.js';
import { DEFAULT_SETTINGS, resolveSettings } from '../ui/settings.js';
import { loadIconManifest, iconCss } from '../ui/icons.js';

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

// --- v1.26：图标 manifest 契约 ---
// 钉的是**契约与不变式**，不是具体坐标值（坐标由烘焙产物决定，改几何/贴图会漂移）。

test('icons: manifest 两套尺寸档覆盖同一集合（快捷栏/背包不遗漏）', async () => {
  const m = await loadIconManifest();
  const hotbar = Object.keys(m.hotbar).sort();
  const inventory = Object.keys(m.inventory).sort();
  assertEqual(hotbar.length, inventory.length, '两套尺寸档项数相同');
  // 逐项一致：任一档漏项都会让对应面板出现空图标槽
  for (let i = 0; i < hotbar.length; i++) {
    assertEqual(hotbar[i], inventory[i], `第 ${i} 项两档一致`);
  }
  // 背包集合每项都有图标（新增方块忘跑 npm run icons → 这条抓到）
  const { buildItemNames } = await import('../player/inventory.js');
  const { buildDefaultRegistry } = await import('../voxel/block-registry.js');
  const items = buildItemNames(await buildDefaultRegistry());
  for (const name of items) {
    assertTrue(iconCss(m, 'hotbar', name) !== undefined, `背包项 ${name} 有快捷栏图标`);
    assertTrue(iconCss(m, 'inventory', name) !== undefined, `背包项 ${name} 有背包图标`);
  }
});

test('icons: CSS 串是完整 background 简写（含 url/位置/尺寸/no-repeat）', async () => {
  const m = await loadIconManifest();
  const css = iconCss(m, 'hotbar', 'stone');
  assertTrue(css.startsWith('url('), '串以 url() 开头');
  // **url 必须是绝对路径**：manifest 写相对名，而 background 的 url() 相对文档基址解析——
  // 页面在 /src/tests/index.html 时相对名会去找 /src/tests/icons-atlas.png（404）。
  assertTrue(css.includes("/assets/icons-atlas.png"), `url 已修正为绝对路径，实得 ${css}`);
  assertTrue(/-?\d+px -?\d+px \/ \d+px \d+px/.test(css), '含 background-position / background-size');
  assertTrue(css.includes('no-repeat'), '含 no-repeat（防图标平铺）');
});

test('icons: 两套尺寸的 CSS 串必须不同（坐标不同 → 各自裁各自的图）', async () => {
  const m = await loadIconManifest();
  const a = iconCss(m, 'hotbar', 'grass');
  const b = iconCss(m, 'inventory', 'grass');
  assertFalse(a === b, `快捷栏(40px) 与背包(32px) 的串不同，实得 ${a} / ${b}`);
});

test('icons: 缺失方块返回 undefined（调用方降级为无图标，不抛错）', async () => {
  const m = await loadIconManifest();
  assertEqual(iconCss(m, 'hotbar', '不存在的方块'), undefined);
  assertEqual(iconCss(m, 'hotbar', 'bed_alias_block'), undefined, '不在背包内的方块无图标');
  assertEqual(iconCss(null, 'hotbar', 'stone'), undefined, 'manifest 缺失时不抛错');
});

test('icons: 图标 atlas 真实可加载且尺寸与 manifest 一致', async () => {
  const m = await loadIconManifest();
  const img = new Image();
  img.src = '/assets/icons-atlas.png';
  await img.decode(); // 解码失败会抛 → 证明文件存在且是合法 PNG
  assertEqual(img.width, m.size, `atlas 宽 = manifest.size (${m.size})`);
  assertEqual(img.height, m.size, 'atlas 是正方形');
});

/**
 * **回归防线**：异形方块的图标必须与母方块不同（防 v1.23/v1.24 那两个 bug 复发）。
 *
 * 旧用例钉的是 tile 名（`planks_step → inventory-icons/planks_step`），改贴图就要改断言；
 * 这里钉的是**不变式**：台阶图标 ≠ 母方块图标、竖柱 ≠ 横梁。等轴测方案下形状不同
 * → 裁剪坐标必然不同，故比 CSS 串即可。若有人把烘焙产物换回母方块贴图，这条会抓到。
 */
test('icons: 异形方块图标与其母方块不同（撞脸回归防线）', async () => {
  const m = await loadIconManifest();
  const pairs = [
    ['planks_step', 'planks', '正置台阶 vs 母方块 planks'],
    ['cobblestone_step', 'cobblestone', '台阶 vs 母方块 cobblestone'],
    ['vertical_pillar', 'horizontal_pillar', '竖柱 vs 横梁（几何相反）'],
    ['cobblestone_step', 'cobblestone_step_updown', '正置 vs 倒置台阶（几何相反）'],
    ['handrail', 'handrailA', '栏杆三型彼此不同'],
  ];
  for (const [a, b, desc] of pairs) {
    assertFalse(iconCss(m, 'inventory', a) === iconCss(m, 'inventory', b),
      `${desc} 的图标必须不同（撞脸 = 丢失辨识度）`);
  }
});
