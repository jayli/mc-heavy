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
import { resourceUrl, resourceUrlFrom } from '../core/resource-url.js';
import { DEFAULT_SETTINGS, resolveSettings, VIEW_DISTANCE_OPTIONS, VIEW_DISTANCE_MIN, VIEW_DISTANCE_MAX, VISUAL_STYLE_OPTIONS, CHUNK_PACE_MIN, CHUNK_PACE_MAX } from '../ui/settings.js';
import { loadIconManifest, iconCss } from '../ui/icons.js';
// M9：创造台面板的两态文案常量与错误映射是**导出的单一口径**（见下方用例说明）。
// settings-panel.js 只 import 纯函数模块（settings.js），无 three/无 DOM 顶层副作用 →
// 可在本单测文件里 import（与 icons.js 同口径）。
import {
  PLAYGROUND_OPEN_LABEL, PLAYGROUND_CLOSE_LABEL, PLAYGROUND_ERRORS,
  PLAYGROUND_ROW_TITLE, PROGRESS_ROW_TITLE, PROGRESS_EXPORT_LABEL, PROGRESS_IMPORT_LABEL, PROGRESS_ERRORS,
  TELEPORT_ROW_TITLE, TELEPORT_TARN_LABEL, TELEPORT_MARK_LABEL, TELEPORT_GO_LABEL,
  TELEPORT_HOME_LABEL, TELEPORT_ARENA_LABEL, TELEPORT_ENCLOSURE_LABEL, TELEPORT_LAKE_LABEL,
  TELEPORT_CITADEL_LABEL,
  TELEPORT_AUTO_CLOSE_MS,
  RESOLUTION_ROW_TITLE, RESOLUTION_LABELS,
  AMBIENT_ROW_TITLE, AMBIENT_LABELS,
  TAB_SETTINGS_LABEL, TAB_ABOUT_LABEL, ABOUT_PARAGRAPH, ABOUT_IMAGE_PATH,
} from '../ui/settings-panel.js';
import {
  PIXEL_RATIO_MODE_OPTIONS, DEFAULT_PIXEL_RATIO_MODE,
} from '../render/pixel-ratio.js';
import { Toast, TOAST_Z_INDEX } from '../ui/toast.js';
import { HEALTH_Z_INDEX } from '../ui/health-hud.js';
import { DAMAGE_NUMBER_Z_INDEX } from '../ui/damage-numbers.js';
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
 * v2.27：渲染分辨率档位（「清晰」/「性能」两按钮）。
 *
 * 钉的是**三道入口都通**（默认 / 存储 / URL）—— 漏任何一道的表现都是「点下去有效，
 * 但下次开游戏回到清晰」（玩家会以为自己设的性能档没被记住，而画面看起来只是好了一点）。
 * ⚠️ **不需要 `settingsVersion` 迁移**（与 `chunkPace` 同理，与 `fogColor` 反例）：
 * 旧存档根本没这个字段，缺字段自然回落默认 —— 本用例显式钉住这一点，
 * 防止将来有人照搬 `fogColor` 那套迁移把玩家的选择反复翻回。
 */
test('settings: pixelRatio 默认清晰，存储/URL 均可覆盖，且旧存档无需迁移', () => {
  assertEqual(DEFAULT_SETTINGS.pixelRatio, 'sharp', '默认 = 清晰（= 改动前的观感）');
  assertEqual(resolveSettings(null, new URLSearchParams('')).pixelRatio, 'sharp');
  // 旧存档（没有任何版本号、也没有 pixelRatio 字段）→ 自然回落默认，且不是靠迁移
  assertEqual(resolveSettings({ viewDistance: 4 }, new URLSearchParams('')).pixelRatio, 'sharp',
    '旧存档缺字段 → 回落默认（不靠迁移）');
  assertEqual(resolveSettings({ viewDistance: 4, fogColor: false }, new URLSearchParams('')).pixelRatio,
    'sharp', 'v1 旧存档（会被迁移的那一类）同样回落默认');
  // 存储
  assertEqual(resolveSettings({ pixelRatio: 'performance' }, new URLSearchParams('')).pixelRatio,
    'performance', '存储的性能档生效');
  // URL 优先于存储；`perf` 简写是 URL 侧的便利入口（存储/常量一律全名）
  assertEqual(resolveSettings({ pixelRatio: 'performance' }, new URLSearchParams('res=sharp')).pixelRatio,
    'sharp', 'URL 优先于存储');
  assertEqual(resolveSettings({ pixelRatio: 'sharp' }, new URLSearchParams('res=perf')).pixelRatio,
    'performance', '?res=perf 简写等价于 performance');
  assertEqual(resolveSettings({ pixelRatio: 'sharp' }, new URLSearchParams('res=performance')).pixelRatio,
    'performance', '全名形式同样可用');
  // 脏值（手改 URL / 旧存档）一律回落默认，不得让渲染停在非法档位
  for (const bad of ['', 'SHARP', 'low', '0']) {
    assertEqual(resolveSettings(null, new URLSearchParams(`res=${bad}`)).pixelRatio, 'sharp',
      `非法 URL 值 ${JSON.stringify(bad)} 回落默认`);
    assertEqual(resolveSettings({ pixelRatio: bad }, new URLSearchParams('')).pixelRatio, 'sharp',
      `非法存储值 ${JSON.stringify(bad)} 回落默认`);
  }
});

/**
 * v1.59 交付时雾色默认关（「默认值 = 旧行为」），用户 2026-10-25 裁定改为**默认开**
 * （「游戏启动的时候默认就开启『雾色』按钮」）。
 * 钉三道入口都通：漏任何一道的表现都是「面板高亮对了，但进去远景还是固定色」。
 * ⚠️ **关闭**的路径必须仍然完整 —— 默认翻转不得把开关做成只能开不能关。
 */
test('settings: fogColor 恒开（v3.26 面板已无入口），?fog= 仍是隔离入口', () => {
  assertEqual(DEFAULT_SETTINGS.fogColor, true, '默认开（用户 2026-10-25 裁定）');
  assertEqual(resolveSettings(null, new URLSearchParams('')).fogColor, true);
  const v = DEFAULT_SETTINGS.settingsVersion;
  // ⚠️ v3.26：面板那一组已换成「萤火虫和落叶」，玩家侧再无雾色入口
  // ⇒ **存储里的 false 不再被采信**（旧值大多是默认值为关时顺带落盘的假值）。
  assertEqual(resolveSettings({ settingsVersion: v, fogColor: false }, new URLSearchParams('')).fogColor,
    true, '存储值不再被采信 ⇒ 恒开');
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

test('瞬移行的标题与八个按钮文案是导出的单一口径常量（v2.89 八按钮：新增堡垒，竞技场→竞技）', () => {
  // v2.10 用户 2026-10-29：「操作面板中的瞬移区，按钮调整一下：标记，跳转标记，回家，高台，竞技场」；
  // v2.19 用户 2026-10-30：「增加一个瞬移按钮：湖，点击瞬移到浅水高台地图」；
  // v2.87 用户 2026-11-09：原「竞技场」（小竞技场）改名「围场」，新增指向**大竞技场**的「竞技场」；
  // v2.89 用户 2026-11-10：末尾追加「堡垒」（城西废弃堡垒），同时「竞技场」缩为「竞技」
  // （8 个按钮后每只文字可用 31.4px，3 字 36px 会折行 —— 实测，见下方长度断言）。
  //
  // ⚠️ **文案随按钮数递减（六按钮 4 字 → 七按钮 3 字 → 八按钮 2 字）不是审美而是布局的必然**：
  // 左列实测 375px、`.mc-btn-group` 的 `gap` + 按钮 `padding:6px 4px` 下，按钮越多每只文字可用宽越窄。
  // ⚠️ v2.87 加到七个后本行 `gap` 收到 4px（`.mc-teleport .mc-btn-group`）：每只 50.1px、
  // 内容宽 38.1px，3 字单行放得下；文案上限当时是 **3 字**。
  // ⚠️ **v2.89 加到八个后上限降到 2 字**（实测）：每只 43.4px、文字可用 31.4px，
  // 3 字（36px）折行（按钮高 33→50px），即使 `gap` 收到 0px 也只有 34.9px ⇒ 无解。
  // 故「竞技场」缩为「竞技」（用户 2026-11-10 裁定）。
  // ⚠️ `scrollWidth <= clientWidth` **对折行没有判别力**（折行时两者依然相等），真正的信号是
  // 行盒数 —— 那条断言在 `tests/teleport.spec.mjs` 里（Tier 4，能量真实布局）。
  assertEqual(TELEPORT_ROW_TITLE, '瞬移');
  assertEqual(TELEPORT_MARK_LABEL, '标记');
  assertEqual(TELEPORT_GO_LABEL, '跳转');
  assertEqual(TELEPORT_HOME_LABEL, '回家');
  assertEqual(TELEPORT_TARN_LABEL, '高台');
  // ⚠️ 术语（用户 2026-11-09）：「竞技」= 城东沙漠的大竞技场（burning arena）；
  // 「围场」= 原小竞技场（城南门外草地竞技场）；「堡垒」= 城西废弃堡垒（v2.89）。
  // 三者文案不得互换。
  // ⚠️ 「竞技」是 2 字不是 3 字（v2.89 用户裁定）：8 按钮后每只文字可用 31.4px，
  // 3 字（36px）折行（实测按钮高 33→50px），即使 gap 收到 0px 也只有 34.9px。
  assertEqual(TELEPORT_ARENA_LABEL, '竞技');
  assertEqual(TELEPORT_ENCLOSURE_LABEL, '围场');
  assertEqual(TELEPORT_LAKE_LABEL, '湖');
  assertEqual(TELEPORT_CITADEL_LABEL, '堡垒');
  // 八个按钮必须互相可区分 —— 否则玩家分不出「标记」与「跳转」哪一个是记录
  const all = [TELEPORT_MARK_LABEL, TELEPORT_GO_LABEL, TELEPORT_HOME_LABEL,
    TELEPORT_TARN_LABEL, TELEPORT_ENCLOSURE_LABEL, TELEPORT_ARENA_LABEL, TELEPORT_LAKE_LABEL,
    TELEPORT_CITADEL_LABEL];
  assertEqual(new Set(all).size, 8, '八个瞬移按钮文案不得重复');
  // 文案长度约束（布局）：单行排下八个按钮的前提（实测 8 按钮每只文字可用 31.4px，
  // 2 字 = 24px ≤ 31.4px，3 字 = 36px > 31.4px ⇒ 上限 **2 字**）
  for (const label of all) {
    assertTrue(label.length <= 2, `「${label}」超过 2 个字，八个按钮一行摆不下（会折行）`);
  }
  assertFalse(TELEPORT_ROW_TITLE === PROGRESS_ROW_TITLE, '瞬移行不得与进度管理行撞名');
});

test('瞬移：跳转成功后自动关面板的延迟是导出的单一常量，且为 100ms', () => {
  // 用户 2026-10-30：「点击面板中的瞬移的时候，除了点击标记按钮外，点击其他的按钮完成跳转后，
  // 100ms 后把设置面板关掉，自动进入游戏」。
  //
  // ⚠️ 这个数值是用户点名的，**不是可调的性能参数** —— 改成 0 会让面板消失与这次点击的收尾
  // 挤在同一帧（toast 布局、按钮 :active 复位），改成几百毫秒则玩家会觉得「点了没反应」。
  // 断言从常量读（不写字面量）→ 常量一动这条就红，指向本注释。
  assertEqual(TELEPORT_AUTO_CLOSE_MS, 100);
  // 必须真的延迟（不能是 0/负数）——setTimeout 传 0 会退化成「下一轮宏任务」窗口，
  // 而 100ms 是给鼠标抬起与 toast 首帧留出的确定余量。
  assertTrue(TELEPORT_AUTO_CLOSE_MS > 0, '延迟必须为正 —— 0 会让面板与点击收尾挤在同一帧');
});

test('环境特效行：标题与两个按钮文案是导出的单一口径常量', () => {
  assertEqual(AMBIENT_ROW_TITLE, '萤火虫和落叶');
  assertEqual(AMBIENT_LABELS.length, 2);
  assertEqual(AMBIENT_LABELS[0], '关闭');
  assertEqual(AMBIENT_LABELS[1], '开启');
  // 与既有组标题不得撞名（面板按标题定位按钮组）
  assertFalse(AMBIENT_ROW_TITLE === RESOLUTION_ROW_TITLE, '不得与分辨率行撞名');
});

test('分辨率行：标题与两个档位文案是导出的单一口径常量，且与档位值逐项对齐', () => {
  // 用户 2026-11-03 点名要的两个按钮文案
  assertEqual(RESOLUTION_ROW_TITLE, '分辨率');
  assertEqual(RESOLUTION_LABELS.length, 2, '用户裁定只要两档');
  assertEqual(RESOLUTION_LABELS[0], '清晰');
  assertEqual(RESOLUTION_LABELS[1], '性能');
  // ⚠️ **数量必须与档位值集合一致**：`_makeGroup` 按**下标**取文案（`labels[i]`），
  // 少一个文案会让后一个按钮显示 `undefined`，多一个则白写。两者漂移是静默的
  // （按钮照常可点，只是文字不对/缺一个）。
  assertEqual(RESOLUTION_LABELS.length, PIXEL_RATIO_MODE_OPTIONS.length,
    '文案数量必须等于档位值数量（面板按下标取文案）');
  // 默认档必须排第一（面板第一个按钮就是当前生效值，玩家不必找）
  assertEqual(PIXEL_RATIO_MODE_OPTIONS[0], DEFAULT_PIXEL_RATIO_MODE,
    '默认档必须排首位 —— 否则面板一打开高亮的是第二个按钮');
  // 两字文案不得重复（否则分不出哪个是降分辨率）
  assertEqual(new Set(RESOLUTION_LABELS).size, 2, '两个按钮文案不得重复');
  // 布局：合并盒现在左半是视距三按钮（约 47px 宽实测）、右半是分辨率两按钮（约 77px）
  // ⇒ 两字文案（24px）绰绰有余。4 字以上会贴斜角边框（与 v1.98/v2.19 同一个约束）。
  for (const label of RESOLUTION_LABELS) {
    assertTrue(label.length <= 3, `「${label}」超过 3 个字，合并盒半栏摆不下（会折行）`);
  }
  // 不得与其他行的标题撞名（玩家靠标题分功能域）
  assertFalse(RESOLUTION_ROW_TITLE === PLAYGROUND_ROW_TITLE, '分辨率行不得与创造台行撞名');
  assertFalse(RESOLUTION_ROW_TITLE === PROGRESS_ROW_TITLE, '分辨率行不得与进度管理行撞名');
  assertFalse(RESOLUTION_ROW_TITLE === TELEPORT_ROW_TITLE, '分辨率行不得与瞬移行撞名');
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

/**
 * 生命系统显示层的两个新层级（用户 2026-11-05）必须嵌进既有不等式。
 *
 * AGENTS.md「UI 层级」那条不等式是载荷性的（改任一层必须重核）：
 *   hotbar 40 < 迷你地图 45 < 坐标/性能面板 50 = **血心 50** < **伤害数字 55**
 *   < 设置按钮 60 < 设置面板 70 < 背包 80 < 浮层 85 < toast 90 < loading 95 < 错误遮罩 100
 *
 * 两条判据各自防的缺陷形态：
 * ① 血心 = 面板同层（50）：它是常驻信息，与坐标/性能面板平级。低于面板会被面板底色盖住
 *    （形态：开局看不见血量）；高于设置按钮（60）会在面板打开时压在模态之上。
 * ② 伤害数字 = 55：高于看板（50）—— 数字可能飘到面板底色上方，被压住就看不见；
 *    低于设置按钮（60）与一切模态 —— 它是瞬时反馈，不该挡任何交互。
 * ③ 两者都**不得取 100+**（会盖掉 WebGPU 启动失败遮罩，那条是「游戏根本没起来」的唯一信号）。
 */
test('生命系统显示层的 z-index 必须嵌进既有层级不等式', () => {
  // 层级表快照（同 toast 那条：显式声明，E2E 交叉验证 computed z-index）
  const HOTBAR_Z = 40;           // hotbar.js
  const MINIMAP_Z = 45;          // minimap.js
  const PANEL_Z = 50;            // perf-hud.js / coords-hud.js
  const SETTINGS_BTN_Z = 60;     // settings-panel.js  #settings-btn
  const BOOT_ERROR_Z = 100;      // index.html         #webgpu-error（必须永远最上）

  // ① 血心与看板同层，且不低于 hotbar / 迷你地图
  assertEqual(HEALTH_Z_INDEX, PANEL_Z,
    `血心(${HEALTH_Z_INDEX}) 必须与坐标/性能面板同层(${PANEL_Z})`);
  assertTrue(HEALTH_Z_INDEX > HOTBAR_Z, `血心必须高于 hotbar(${HOTBAR_Z})`);
  assertTrue(HEALTH_Z_INDEX > MINIMAP_Z, `血心必须高于迷你地图(${MINIMAP_Z})`);

  // ② 伤害数字：高于看板（不被面板底色压住）、低于设置按钮（不挡交互）
  assertTrue(DAMAGE_NUMBER_Z_INDEX > PANEL_Z,
    `伤害数字(${DAMAGE_NUMBER_Z_INDEX}) 必须高于看板(${PANEL_Z})，否则飘到面板上时被压住`);
  assertTrue(DAMAGE_NUMBER_Z_INDEX < SETTINGS_BTN_Z,
    `伤害数字(${DAMAGE_NUMBER_Z_INDEX}) 必须低于设置按钮(${SETTINGS_BTN_Z})，不得挡交互`);

  // ③ 两者都不得压过启动错误遮罩
  assertTrue(HEALTH_Z_INDEX < BOOT_ERROR_Z,
    `血心(${HEALTH_Z_INDEX}) 不得压过启动错误遮罩(${BOOT_ERROR_Z})`);
  assertTrue(DAMAGE_NUMBER_Z_INDEX < BOOT_ERROR_Z,
    `伤害数字(${DAMAGE_NUMBER_Z_INDEX}) 不得压过启动错误遮罩(${BOOT_ERROR_Z})`);
});

/**
 * v3.25：设置弹窗的两个 Tab（用户 2026-11-20：「增加一个 Tab，第一个 Tab 就是现在的配置信息
 * 『游戏设置』，第二个 Tab 是『关于游戏』」）。
 *
 * 这里钉的是**常量当唯一权威**（文案、配图路径、正文），不是布局 ——
 * 「弹框尺寸切换不变」「确定按钮在内容之外」「确定按钮宽度翻倍」三条布局契约在
 * `tests/about-tab.spec.mjs` 里用真实浏览器量取（单测拿不到 computed style）。
 *
 * 三条判据各自防的缺陷形态：
 * ① 文案/顺序：Tab 栏是玩家找设置的第一入口，改一个字或换序都会改变惯性；
 * ② 配图路径：写成站点根绝对路径（`/assets/...`）在子路径部署时 404，而**只在切到关于页时
 *    表现为破图**，没有任何报错。`check:arch` 守住字面量形式，这里守住「经 resourceUrl 派生」
 *    这个事实 —— `resourceUrl()` 的结果以仓库根为基址，与运行位置无关；
 * ③ 正文完整性：它是用户给的私人文字，被摘要/改字都不属于技术改动。
 */
test('设置弹窗的两个 Tab：文案与顺序、配图路径走 resourceUrl、关于页正文不被改写', () => {
  assertEqual(TAB_SETTINGS_LABEL, '游戏设置');
  assertEqual(TAB_ABOUT_LABEL, '关于游戏');

  // 配图路径：仓库相对（禁前导斜杠），且经 resourceUrl 解析出的 URL 以它结尾
  assertFalse(ABOUT_IMAGE_PATH.startsWith('/'),
    `配图路径不得是站点根绝对路径（子路径部署下 404）：${ABOUT_IMAGE_PATH}`);
  assertEqual(ABOUT_IMAGE_PATH, 'assets/about/prompt.png');
  const url = resourceUrl(ABOUT_IMAGE_PATH);
  // ⚠️ 断言里**不得写 `'/assets/...'` 字面量** —— `check:arch` 的资源 URL 检查扫的是
  // 「非注释代码行里出现那个字串」（不管它是不是在一个传给 endsWith 的常量里）。
  assertTrue(url.endsWith(`/${ABOUT_IMAGE_PATH}`),
    `resourceUrl 结果必须以仓库相对路径结尾：${url}`);
  assertTrue(url.startsWith('http'), `必须是绝对 URL：${url}`);
  // 子路径部署下也必须正确（与 `test-resource-url` 同口径，这里只钉关于页这条具体引用）
  const nested = resourceUrlFrom('http://host/mc-heavy/src/core/resource-url.js', ABOUT_IMAGE_PATH);
  assertEqual(nested, 'http://host/mc-heavy/assets/about/prompt.png');

  // ③ 正文：用户原话的几个锚点必须在（钉住「没有被摘要/改写」）
  assertTrue(ABOUT_PARAGRAPH.includes('我上小学三年级'));
  assertTrue(ABOUT_PARAGRAPH.includes('爸爸给我做了一个“我的世界”让我偷偷玩'));
  assertTrue(ABOUT_PARAGRAPH.includes('只要我语文再考优'));
  // 用户指定的那段话**不含**旁白句（2026-11-20 裁定删掉）
  assertFalse(ABOUT_PARAGRAPH.includes('三年级小朋友写的一张提示词'));
});

