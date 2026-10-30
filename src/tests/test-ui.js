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
import { resourceUrl } from '../core/resource-url.js';
import { DEFAULT_SETTINGS, resolveSettings, VIEW_DISTANCE_OPTIONS, VIEW_DISTANCE_MIN, VIEW_DISTANCE_MAX, VISUAL_STYLE_OPTIONS, CHUNK_PACE_MIN, CHUNK_PACE_MAX } from '../ui/settings.js';
import { loadIconManifest, iconCss } from '../ui/icons.js';
// M9：创造台面板的两态文案常量与错误映射是**导出的单一口径**（见下方用例说明）。
// settings-panel.js 只 import 纯函数模块（settings.js），无 three/无 DOM 顶层副作用 →
// 可在本单测文件里 import（与 icons.js 同口径）。
import {
  PLAYGROUND_OPEN_LABEL, PLAYGROUND_CLOSE_LABEL, PLAYGROUND_ERRORS,
  PLAYGROUND_ROW_TITLE, PROGRESS_ROW_TITLE, PROGRESS_EXPORT_LABEL, PROGRESS_IMPORT_LABEL, PROGRESS_ERRORS,
  TELEPORT_ROW_TITLE, TELEPORT_TARN_LABEL, TELEPORT_MARK_LABEL, TELEPORT_GO_LABEL,
  TELEPORT_HOME_LABEL, TELEPORT_ARENA_LABEL, TELEPORT_LAKE_LABEL,
} from '../ui/settings-panel.js';
import { Toast, TOAST_Z_INDEX } from '../ui/toast.js';
import { PANEL_CSS as INVENTORY_PANEL_CSS, TOOLTIP_Z_INDEX } from '../ui/inventory.js';

test('settings: 默认值（vd=8 / blur=off / volume=1 / 风格自动）', () => {
  assertEqual(DEFAULT_SETTINGS.viewDistance, 8);
  assertEqual(DEFAULT_SETTINGS.blur, false);
  assertEqual(DEFAULT_SETTINGS.volume, 1);
  assertEqual(DEFAULT_SETTINGS.visualStyle, null);
});

test('settings: chunkPace 默认 8、URL 可调、钳制到 0~16', () => {
  // 观感旋钮（每帧最多发布几个 section），不是性能旋钮 —— 帧时与 fps 与取值无关。
  // 默认 8（用户 2026-10-27 裁定）：既铺开又不追不上加载速度。
  assertEqual(DEFAULT_SETTINGS.chunkPace, 8);
  assertEqual(resolveSettings(null, new URLSearchParams('')).chunkPace, 8);
  // 旧存档里**没有**这个字段（v1.90 才新增）→ 自然回落新默认，不需要 settingsVersion 迁移
  assertEqual(resolveSettings({ viewDistance: 4, fogColor: false }, new URLSearchParams('')).chunkPace, 8);
  // 显式 0 仍然有效（= 不限，一波全出）
  assertEqual(resolveSettings(null, new URLSearchParams('chunkpace=0')).chunkPace, 0);
  assertEqual(resolveSettings(null, new URLSearchParams('chunkpace=2')).chunkPace, 2);
  assertEqual(resolveSettings({ chunkPace: 4 }, new URLSearchParams('')).chunkPace, 4);
  // URL 覆盖存储
  assertEqual(resolveSettings({ chunkPace: 4 }, new URLSearchParams('chunkpace=8')).chunkPace, 8);
  // 钳制：负数/超大/非法 一律回落到边界或默认
  assertEqual(resolveSettings(null, new URLSearchParams('chunkpace=-5')).chunkPace, CHUNK_PACE_MIN);
  assertEqual(resolveSettings(null, new URLSearchParams('chunkpace=999')).chunkPace, CHUNK_PACE_MAX);
  assertEqual(resolveSettings(null, new URLSearchParams('chunkpace=abc')).chunkPace, DEFAULT_SETTINGS.chunkPace);
  // 小数取整
  assertEqual(resolveSettings(null, new URLSearchParams('chunkpace=3.7')).chunkPace, 4);
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

/**
 * v1.63：背景音乐开关（两按钮档位，默认开）。
 * 钉的是三道入口（默认 / 存储 / URL）都通 —— 漏任何一道的表现都是「开关看起来能点，
 * 但下次开游戏回到默认」（静默回到开，玩家会以为自己的关闭没被记住）。
 */
test('settings: bgm 默认开，存储与 ?bgm= 均可覆盖', () => {
  assertEqual(DEFAULT_SETTINGS.bgm, true, '默认开（mc-lite 进游戏即播）');
  assertEqual(resolveSettings(null, new URLSearchParams('')).bgm, true);
  assertEqual(resolveSettings({ bgm: false }, new URLSearchParams('')).bgm, false, '存储关生效');
  assertEqual(resolveSettings({ bgm: false }, new URLSearchParams('bgm=1')).bgm, true, 'URL 优先于存储');
  assertEqual(resolveSettings({ bgm: true }, new URLSearchParams('bgm=0')).bgm, false);
  // 非布尔脏值不得把开关带成真/假（undefined 被 `if` 挡掉，字符串被类型判断挡掉）
  assertEqual(resolveSettings({ bgm: 'yes' }, new URLSearchParams('')).bgm, true, '脏值回落默认');
});

/**
 * v1.59 交付时雾色默认关（「默认值 = 旧行为」），用户 2026-10-25 裁定改为**默认开**
 * （「游戏启动的时候默认就开启『雾色』按钮」）。
 * 钉三道入口都通：漏任何一道的表现都是「面板高亮对了，但进去远景还是固定色」。
 * ⚠️ **关闭**的路径必须仍然完整 —— 默认翻转不得把开关做成只能开不能关。
 */
test('settings: fogColor 默认开，存储与 ?fog= 均可覆盖', () => {
  assertEqual(DEFAULT_SETTINGS.fogColor, true, '默认开（用户 2026-10-25 裁定）');
  assertEqual(resolveSettings(null, new URLSearchParams('')).fogColor, true);
  // ⚠️ 存储里必须带当前版本号才被采信 —— 旧存档的 false 会被迁移掉（见下方用例）。
  const v = DEFAULT_SETTINGS.settingsVersion;
  assertEqual(resolveSettings({ settingsVersion: v, fogColor: false }, new URLSearchParams('')).fogColor,
    false, '当前版本的存储关生效（玩家真的选了关）');
  assertEqual(resolveSettings({ settingsVersion: v, fogColor: false }, new URLSearchParams('fog=1')).fogColor,
    true, 'URL 优先于存储');
  assertEqual(resolveSettings({ settingsVersion: v, fogColor: true }, new URLSearchParams('fog=0')).fogColor, false);
  assertEqual(resolveSettings({ settingsVersion: v, fogColor: 'yes' }, new URLSearchParams('')).fogColor,
    true, '脏值回落默认');
});

/**
 * 旧存档迁移（用户 2026-10-25 裁定：旧存档也迁移成开）。
 *
 * 为什么必须有这层：面板**任何一次**点击都会把整个设置对象落盘，所以旧存档里的
 * `fogColor: false` 绝大多数不是「玩家特意关的」，而是「默认值是关时顺带写下的假值」。
 * 不迁移的话，本次默认值翻转对**所有用过面板的人**都不生效 —— 偏偏那正是需求的对象。
 *
 * 钉三件事：① 无版本号 / 旧版本号的 false 被丢弃 → 回落到开；② 迁移后写上新版本号
 * （否则每次启动都重跑一次迁移，玩家真点「关闭」后会被反复翻回开）；③ 迁移只针对
 * `fogColor`，**其它字段不得被触碰**（泛化迁移会静默改掉玩家别的设置）。
 */
test('settings: 旧存档的 fogColor=false 被迁移成默认开（其它字段不动）', () => {
  // 无版本号的老存档（v1.59 ~ v1.77 期间落盘的）
  const legacy = { viewDistance: 4, blur: true, fogColor: false, bgm: false };
  const s = resolveSettings(legacy, new URLSearchParams(''));
  assertEqual(s.fogColor, true, '旧存档的 false 不可信 → 迁移成开');
  assertEqual(s.viewDistance, 4, '其它字段不得被迁移触碰（视距）');
  assertEqual(s.blur, true, '其它字段不得被迁移触碰（画质）');
  assertEqual(s.bgm, false, '其它字段不得被迁移触碰（背景音乐）');
  assertEqual(legacy.settingsVersion, DEFAULT_SETTINGS.settingsVersion,
    '迁移后必须写上新版本号（否则玩家真点「关闭」会被反复翻回开）');
  assertTrue(!('fogColor' in legacy), '被丢弃的旧值不得残留在存储对象里');

  // 已迁移过（当前版本号）+ 玩家真的点了「关闭」→ 必须尊重
  const current = { settingsVersion: DEFAULT_SETTINGS.settingsVersion, fogColor: false };
  assertEqual(resolveSettings(current, new URLSearchParams('')).fogColor, false,
    '当前版本里玩家确实选的关必须被尊重');

  // 旧存档里 fogColor 是 true（玩家曾经手动开过）—— 迁移不必动它，结果本就是开
  const legacyOn = { fogColor: true };
  assertEqual(resolveSettings(legacyOn, new URLSearchParams('')).fogColor, true);

  // URL 仍然优先于一切（含迁移后的值）
  assertEqual(resolveSettings({ fogColor: false }, new URLSearchParams('fog=0')).fogColor, false);
  assertEqual(resolveSettings({ fogColor: false }, new URLSearchParams('fog=1')).fogColor, true);
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

test('settings: dusk 是合法风格键，且档位顺序里紧挨在正午右边（v1.71）', () => {
  assertEqual(resolveSettings({ visualStyle: 'dusk' }, new URLSearchParams('')).visualStyle, 'dusk');
  assertEqual(resolveSettings(null, new URLSearchParams('style=dusk')).visualStyle, 'dusk');
  // 落位：正午右边 —— 断言的是**顺序关系**（不是下标），加档位时不必改这条
  const idxNoon = VISUAL_STYLE_OPTIONS.indexOf('noon');
  assertTrue(idxNoon >= 0, '档位里必须有「正午」');
  assertEqual(VISUAL_STYLE_OPTIONS[idxNoon + 1], 'dusk', '「傍晚」必须紧挨在「正午」右边');
  assertEqual(VISUAL_STYLE_OPTIONS[0], null, '「自动」仍在首位（日夜循环的唯一 UI 入口）');
});

test('settings: 每个风格档位都在 VISUAL_STYLES 里有对应数据（档位与引擎数据不得漂移）', async () => {
  const { VISUAL_STYLES } = await import('../render/daynight.js');
  for (const v of VISUAL_STYLE_OPTIONS) {
    if (v === null) continue;
    assertTrue(Object.prototype.hasOwnProperty.call(VISUAL_STYLES, v),
      `档位 "${v}" 在 VISUAL_STYLES 里没有对应数据（点了会抛 undefined 解引用）`);
  }
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
  // **url 必须是部署路径无关的绝对地址**：manifest 写相对名，而 background 的 url()
  // 相对文档基址解析 —— fixture 页在 /src/tests/ 下时相对名会去找
  // /src/tests/icons-atlas.png（404）。v1.87 起换成 resourceUrl() 的产物：
  // 断言比原来的字面量 `${'/assets/icons-atlas.png'}` 强一级 —— 它验的是「解析到了
  // 当前部署路径下的地址」，子路径部署时会期望带前缀的值（旧断言在那种部署下永远 FAIL）。
  assertTrue(css.includes(resourceUrl('assets/icons-atlas.png')), `url 已修正为部署路径无关的绝对地址，实得 ${css}`);
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
  img.src = resourceUrl('assets/icons-atlas.png');
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
test('背包 hover 浮层：显示方块 id 原样，且不拦截鼠标事件', () => {
  // 用户 2026-10-29：「按 z 换出的背包面板里，鼠标移动到某个方块上的时候，hover 住的时候
  // 要在鼠标旁边显示 hover 的方块的名字全称」，并裁定「就原样显示方块本来叫什么名字，
  // 比如 polished_blackstone_bricks」—— 不做下划线转空格、不翻译、不加显示名映射表。
  //
  // ⚠️ 这里只能测**样式契约**。交互行为（浮层出现/跟随/消失）由 E2E 兜住 —— 单测没有真实鼠标。
  const css = INVENTORY_PANEL_CSS;
  const i = css.indexOf('#inventory-tooltip');
  assertTrue(i >= 0, 'CSS 里必须有 #inventory-tooltip');
  const rule = css.slice(i, css.indexOf('}', i));
  // ⚠️ pointer-events:none 是**载荷性的**：浮层挡在光标下面会拦截 mousemove →
  // 触发 mouseleave → 隐藏 → 再 mouseenter 的循环闪烁。
  assertTrue(/pointer-events:\s*none/.test(rule),
    '#inventory-tooltip 必须 pointer-events:none（否则浮层会闪烁）');
  // 默认隐藏，靠 .mc-visible 类切换（不是 display 常开）
  assertTrue(rule.includes('display: none') || rule.includes('display:none'),
    '浮层默认必须隐藏');
  assertTrue(css.includes('#inventory-tooltip.mc-visible'), '浮层须用 .mc-visible 类控制显示');
});

/**
 * 浮层的 z-index 必须高于**背包自己的 80**与**设置面板的 70**（v2.17 修，用户报告
 * 「设置面板中 hover 到方块图上时，浮层显示到了设置面板之下」）。
 *
 * 根因：浮层挂在 `body` 下、两个模态挂在 `#hud-root` 下，而 `#hud-root` 没有 CSS
 * （不建层叠上下文）⇒ 三方在同一个根层叠上下文里比 z-index。浮层原值 60 < 70/80。
 *
 * ⚠️ 这类缺陷 **E2E 的 `toBeVisible()` 结构上拓不到**：它只看 CSS display，不看画没画在
 * 最上层（实测 v1.93 的用例在缺陷态全绿）。判据必须落在**像素**上（见 E2E 的同名用例：
 * 「浮层可见 vs 隐藏」两张同位置裁剪图，缺陷态 Δ=0），而本单测负责拓「有人把常量改回去」。
 */
test('浮层的 z-index 必须高于背包与设置面板（否则被面板盖住）', () => {
  // 层级表快照（同 toast 那条：不从 CSS 解析，组件私有模板串在单测里拿不到；E2E 交叉验证）
  const SETTINGS_MODAL_Z = 70;   // settings-panel.js  #settings-modal
  const INVENTORY_Z = 80;        // inventory.js       #inventory-modal（浮层的宿主面板）
  const TOAST_Z = 90;            // toast.js           TOAST_Z_INDEX
  assertTrue(TOOLTIP_Z_INDEX > INVENTORY_Z,
    `浮层(${TOOLTIP_Z_INDEX}) 必须高于背包(${INVENTORY_Z})，否则被内容框盖住`);
  assertTrue(TOOLTIP_Z_INDEX > SETTINGS_MODAL_Z,
    `浮层(${TOOLTIP_Z_INDEX}) 必须高于设置面板(${SETTINGS_MODAL_Z})，否则被遵罩压暗`);
  // toast 是面板动作按钮的唯一反馈通道（v1.98）—— 提示永远压在浮层之上
  assertTrue(TOOLTIP_Z_INDEX < TOAST_Z,
    `浮层(${TOOLTIP_Z_INDEX}) 不得压过 toast(${TOAST_Z})`);
  // 红线 1：CSS 里不得再写一份字面量，必须吃同一个常量
  const css = INVENTORY_PANEL_CSS;
  const i = css.indexOf('#inventory-tooltip');
  const rule = css.slice(i, css.indexOf('}', i));
  assertTrue(new RegExp(`z-index:\\s*${TOOLTIP_Z_INDEX}\\s*;`).test(rule),
    '浮层 CSS 的 z-index 必须引用 TOOLTIP_Z_INDEX 常量（不得另写一份字面量）');
});

test('瞬移行的标题与六个按钮文案是导出的单一口径常量（v2.19 六按钮）', () => {
  // v2.10 用户 2026-10-29：「操作面板中的瞬移区，按钮调整一下：标记，跳转标记，回家，高台，竞技场」；
  // v2.19 用户 2026-10-30：「增加一个瞬移按钮：湖，点击瞬移到浅水高台地图」。
  //
  // ⚠️ **文案全部缩短到 ≤ 3 字不是审美而是布局的必然**：左列实测 375px、`.mc-btn-group` 的
  // `gap:8px` + 按钮 `padding:6px 4px` 下，**六个按钮平分只剩 56px 每个**（`clientWidth` 52、
  // 内容宽 44px）⇒ 12px 字号下 3 字（36px）刚好、**4 字（48px）就会折行**。
  // 实测（真游戏页注入第 6 个按钮）：四字的「跳转标记」变成 2 行、按钮高 33 → 50px。
  // 故 v2.19 把「跳转标记」缩成「跳转」（用户裁定）。
  // ⚠️ `scrollWidth <= clientWidth` **对折行没有判别力**（折行时两者依然相等），真正的信号是
  // 行盒数 —— 那条断言在 `tests/teleport.spec.mjs` 里（Tier 4，能量真实布局）。
  assertEqual(TELEPORT_ROW_TITLE, '瞬移');
  assertEqual(TELEPORT_MARK_LABEL, '标记');
  assertEqual(TELEPORT_GO_LABEL, '跳转');
  assertEqual(TELEPORT_HOME_LABEL, '回家');
  assertEqual(TELEPORT_TARN_LABEL, '高台');
  assertEqual(TELEPORT_ARENA_LABEL, '竞技场');
  assertEqual(TELEPORT_LAKE_LABEL, '湖');
  // 六个按钮必须互相可区分 —— 否则玩家分不出「标记」与「跳转」哪一个是记录
  const all = [TELEPORT_MARK_LABEL, TELEPORT_GO_LABEL, TELEPORT_HOME_LABEL,
    TELEPORT_TARN_LABEL, TELEPORT_ARENA_LABEL, TELEPORT_LAKE_LABEL];
  assertEqual(new Set(all).size, 6, '六个瞬移按钮文案不得重复');
  // 文案长度约束（布局）：单行排下六个按钮的前提（实测 3 字 = 36px ≤ 44px 可用宽）
  for (const label of all) {
    assertTrue(label.length <= 3, `「${label}」超过 3 个字，六个按钮一行摆不下（会折行）`);
  }
  assertFalse(TELEPORT_ROW_TITLE === PROGRESS_ROW_TITLE, '瞬移行不得与进度管理行撞名');
});

test('创造台行/进度管理行标题与进度按钮文案是导出的单一口径常量', () => {
  assertEqual(PLAYGROUND_ROW_TITLE, '创造台');
  assertEqual(PROGRESS_ROW_TITLE, '进度管理');
  assertFalse(PLAYGROUND_ROW_TITLE === PROGRESS_ROW_TITLE, '两行标题必须可区分');
  // 标题不得再出现合并写法（v1.43 前的「创造台和进度管理」已按用户要求拆开）
  assertFalse(PLAYGROUND_ROW_TITLE.includes('进度'), '创造台行标题不得再混入进度');
  assertEqual(PROGRESS_IMPORT_LABEL, '导入');
  assertEqual(PROGRESS_EXPORT_LABEL, '导出');
  assertFalse(PROGRESS_IMPORT_LABEL === PROGRESS_EXPORT_LABEL, '两个按钮文案必须可区分');
  // v1.98：进度按钮与创造台的模型按钮**不是同一粒度**（整世界存档 vs 平台模型），
  // 改名后两组文案在全局面板里确实重名（都是「导入/导出」）—— 归属靠各自的组标题
  // 「进度管理」/「创造台」表达。这条断言钉住「标题仍在」，否则重名就真的分不清了。
  assertEqual(PROGRESS_ROW_TITLE, '进度管理');
  assertFalse(PROGRESS_ROW_TITLE === PLAYGROUND_ROW_TITLE, '重名按钮的归属只能靠标题区分');
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

/**
 * toast 的层级必须高于**全部模态面板**（v1.98 修，用户 2026-10-31 报告「导出按钮点击没反应」）。
 *
 * **toast 是面板里那些动作按钮（创造台 / 进度导入导出 / 瞬移）唯一的反馈通道**，而它自身的
 * z-index 当时是 40 —— 低于设置面板遮罩的 70、更低于背包的 80。后果：在面板里点「导出」
 * 其实已经成功（文件下载了），但提示被盖在遮罩下面、完全看不见 → 玩家看到的就是
 * 「点了没反应」（实测像素：修前 toast 显示/隐藏两张图 luma **逐位相同** 186.06，
 * 修后 71.64 vs 186.06）。
 *
 * 这条钉的是**层叠顺序的不等式**（纯数值，无需 DOM fixture），配合 E2E 的像素判据双保险：
 * 单测拓得到「有人把常量改回去」，E2E 拓得到「CSS 真生效且真的画在最上层」。
 */
test('toast 的 z-index 必须高于全部模态面板（否则面板里的按钮点击看起来没反应）', () => {
  // 层级表快照（来自各组件 CSS 模板；改任一处时须同步核对这条不等式）。
  // 这些值不从 CSS 解析 —— 单测拿不到组件私有模板串，故显式声明并在 E2E 里交叉验证。
  const SETTINGS_MODAL_Z = 70;   // settings-panel.js  #settings-modal
  const INVENTORY_Z = 80;        // inventory.js       #inventory-modal
  const BOOT_ERROR_Z = 100;      // index.html         #webgpu-error（必须永远最上）
  assertTrue(TOAST_Z_INDEX > SETTINGS_MODAL_Z,
    `toast(${TOAST_Z_INDEX}) 必须高于设置面板(${SETTINGS_MODAL_Z})`);
  assertTrue(TOAST_Z_INDEX > INVENTORY_Z,
    `toast(${TOAST_Z_INDEX}) 必须高于背包(${INVENTORY_Z})`);
  // 启动错误遮罩必须仍高于 toast —— 它代表「游戏根本没起来」，被提示盖住等于看不见错误
  assertTrue(TOAST_Z_INDEX < BOOT_ERROR_Z,
    `toast(${TOAST_Z_INDEX}) 不得压过启动错误遮罩(${BOOT_ERROR_Z})`);
});
