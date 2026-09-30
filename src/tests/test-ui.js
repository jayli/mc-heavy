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
import { DEFAULT_SETTINGS, resolveSettings, VIEW_DISTANCE_OPTIONS, VIEW_DISTANCE_MIN, VIEW_DISTANCE_MAX } from '../ui/settings.js';
import { loadIconManifest, iconCss } from '../ui/icons.js';
// M9：创造台面板的两态文案常量与错误映射是**导出的单一口径**（见下方用例说明）。
// settings-panel.js 只 import 纯函数模块（settings.js），无 three/无 DOM 顶层副作用 →
// 可在本单测文件里 import（与 icons.js 同口径）。
import {
  PLAYGROUND_OPEN_LABEL, PLAYGROUND_CLOSE_LABEL, PLAYGROUND_ERRORS,
  PLAYGROUND_ROW_TITLE, PROGRESS_ROW_TITLE, PROGRESS_EXPORT_LABEL, PROGRESS_IMPORT_LABEL, PROGRESS_ERRORS,
} from '../ui/settings-panel.js';
import { Toast } from '../ui/toast.js';

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

/**
 * 面板档位与架构钳制范围是**两套口径**（面板只留 3 档省版面，clampVD 仍 2~16 可达）。
 * 钉的是关系而非具体档位数字 —— 有人把面板档位写成架构范围外的值（如 20），
 * 点下去会被 clampVD 钳回来 → 按钮宣称了一个非生效值，而肉眼看不出来。
 */
test('settings: 视距 UI 档位全部落在钳制范围内，且默认值在档位中', () => {
  for (const vd of VIEW_DISTANCE_OPTIONS) {
    assertEqual(resolveSettings(null, new URLSearchParams(`vd=${vd}`)).viewDistance, vd,
      `档位 ${vd} 不被钳制改写`);
    assertTrue(vd >= VIEW_DISTANCE_MIN && vd <= VIEW_DISTANCE_MAX, `档位 ${vd} 在钳制范围内`);
  }
  assertTrue(VIEW_DISTANCE_OPTIONS.includes(DEFAULT_SETTINGS.viewDistance),
    `默认视距 ${DEFAULT_SETTINGS.viewDistance} 是面板档位之一（否则面板无高亮）`);
});

test('settings: volume 钳制 [0,1]（无面板档位，默认 100%）', () => {
  assertEqual(resolveSettings({ volume: 5 }, new URLSearchParams('')).volume, 1);
  assertEqual(resolveSettings({ volume: -1 }, new URLSearchParams('')).volume, 0);
  assertEqual(DEFAULT_SETTINGS.volume, 1, '音量默认开启 100%');
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

// ---------------------------------------------------------------- M9：创造台面板文案与 toast

/**
 * 创造台按钮文案是**导出的单一口径常量**（两态 + 错误映射）。
 *
 * ⚠️ v1.35 踩坑：`_resetDangerArmed()` 写死旧长文案覆盖了构造时的短文案 → 面板打开后
 * 显示复位那份，构造代码形同虚设。钉法 = 断言常量**已导出**且值固定 —— 实现里的构造与
 * 状态切换都必须 import 这两个常量，不得在别处写字面量（写死字面量则本断言与实现脱钩）。
 *
 * ⚠️ 这里**不断言面板 DOM**（`playgroundLabel()` 这类方法不存在 —— 断言不存在的方法会让
 * RED 永远不 GREEN）。面板的 DOM 状态（busy 锁 / 按钮可见性）由 E2E 兜住。
 */
test('创造台按钮文案是导出的单一口径常量（两态 + 错误映射）', () => {
  assertEqual(PLAYGROUND_OPEN_LABEL, '打开创造台');
  assertEqual(PLAYGROUND_CLOSE_LABEL, '关闭创造台');
  assertFalse(PLAYGROUND_OPEN_LABEL === PLAYGROUND_CLOSE_LABEL, '两态文案必须可区分');
  // 错误文案映射同样是单一口径（不散落字面量）：每个 reason 都有文案，且不重复
  for (const reason of ['exists', 'no-safe-location', 'not-loaded', 'not-active',
    'player-in-playground']) {
    assertTrue(typeof PLAYGROUND_ERRORS[reason] === 'string' && PLAYGROUND_ERRORS[reason].length > 0,
      `${reason} 必须有提示文案（否则玩家只看到裸 reason）`);
  }
  assertEqual(PLAYGROUND_ERRORS['player-in-playground'], '请离开创造台区域后再关闭');
  assertEqual(PLAYGROUND_ERRORS.exists, '创造台已存在');
});

/**
 * v1.43：创造台行与进度管理行的标题、进度按钮文案。
 *
 * **两行是分开的**（用户要求，2026-09-30）：创造台管平台与模型，进度管整个世界的存档 ——
 * 标题各自覆盖自己的功能域，两个标题必须可区分（否则玩家看不出进度按钮属于哪个域）。
 * 进度两个文案同样是导出的单一口径常量，构造与断言共用一份 —— 与 `PLAYGROUND_OPEN_LABEL`
 * 同一手法（写死字面量则本断言与实现脱钩）。
 *
 * ⚠️ 与上一条一样**不断言面板 DOM** —— 面板的布局与可见性由 E2E 兜住。
 */
test('创造台行/进度管理行标题与进度按钮文案是导出的单一口径常量', () => {
  assertEqual(PLAYGROUND_ROW_TITLE, '创造台');
  assertEqual(PROGRESS_ROW_TITLE, '进度管理');
  assertFalse(PLAYGROUND_ROW_TITLE === PROGRESS_ROW_TITLE, '两行标题必须可区分');
  // 标题不得再出现合并写法（v1.43 前的「创造台和进度管理」已按用户要求拆开）
  assertFalse(PLAYGROUND_ROW_TITLE.includes('进度'), '创造台行标题不得再混入进度');
  assertEqual(PROGRESS_IMPORT_LABEL, '导入进度');
  assertEqual(PROGRESS_EXPORT_LABEL, '导出进度');
  assertFalse(PROGRESS_IMPORT_LABEL === PROGRESS_EXPORT_LABEL, '两个按钮文案必须可区分');
  // 进度错误文案映射：`save/progress-codec.js` 的每个失败 reason 都要有玩家可读文案
  // （否则导入坏文件时玩家只看到裸 reason）。reason 清单与 codec 的失败分支同源。
  for (const reason of ['invalid-json', 'invalid-format', 'unsupported-version', 'invalid-seed']) {
    assertTrue(typeof PROGRESS_ERRORS[reason] === 'string' && PROGRESS_ERRORS[reason].length > 0,
      `进度导入的 ${reason} 必须有提示文案`);
  }
  assertEqual(PROGRESS_ERRORS['invalid-format'], '这不是 mc-heavy 的进度文件');
});

/**
 * toast **不进模态栈**（提示期间玩家仍能操作世界）。
 *
 * 断言落在 toast 自己的接口上（不需要面板 fixture，也不需要 game 实例）。
 * ⚠️ 「没进 game.uiModal 栈」这条不在单测里断言 —— uiModal 是 Game 的状态，单测没有 game
 * 实例。它由 toast 的实现保证（show() 不调 game.pushModal），并在 playground E2E 里兜住。
 */
test('toast 不进模态栈且提示期间可见（非模态契约）', () => {
  const toast = new Toast({ container: { appendChild() {} } });   // 最小桩件容器
  toast.show('创造台已创建');
  assertEqual(toast.isModal(), false, 'toast 不是模态');
  assertTrue(toast.isVisible());
  assertEqual(toast.message(), '创造台已创建', '文案来自调用方（面板用单一口径映射）');
  toast.dispose();
});

test('toast 自动淡出（durationMs 后 hide）且重复调用后一条胜出', async () => {
  const toast = new Toast({ container: { appendChild() {} } });
  toast.show('提示', 10);       // 极短时长便于单测
  assertTrue(toast.isVisible());
  // 重复调用：覆盖文案 + **重置定时器**（后一条胜出，不排队）。
  // ⚠️ 第二次也必须传短时长 —— 缺省是 2200ms，不传则 40ms 后仍可见（不是实现缺陷，是断言写错）。
  toast.show('第二条', 10);
  assertEqual(toast.message(), '第二条');
  await new Promise((r) => setTimeout(r, 40));
  assertEqual(toast.isVisible(), false, '定时器触发 hide');
  toast.dispose();
});
