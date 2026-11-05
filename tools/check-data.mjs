// tools/check-data.mjs — 数据契约门（Tier 2，`npm run check:data`）
//
// 分级策略见 docs/testing-policy.md §3。
//
// **核心设计：关系型断言取代硬编码计数。**
//
// 硬编码计数（`expect(count).toBe(156)`）是「改动放大器」：新增一张贴图就要改 3 处
// （spec + CLAUDE.md + 设计文档），改的是**同一个事实的三个副本**（违反红线 1 精神：
// 数据只有一份权威）。本脚本校验的是**不变式**而非数值——新增贴图不用改任何断言，
// 悬空引用当场报错。
//
// 判据：这个数是「设计决策」还是「事实统计」？
//   - 设计决策（size=2048 / gutter=16）→ 保留硬编码（atlas.spec.mjs 里）
//   - 事实统计（tile 数 / 物品数 / 图标数）→ 用关系式（本脚本）
//
// 运行 ~1s、无需浏览器：node 直接 import 纯数据模块（faces-data / hotbar / inventory
// / mesher 都不 import three，可被 node 消费——这本身就是红线 8 同构性的体现）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PNG } from 'pngjs'; // 读 icons-atlas.png 校验尺寸（ESM：不能用 require）

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const failures = [];
const infos = [];

// ---------------------------------------------------------------- 加载数据源

const { FACES_DATA } = await import('../src/voxel/faces-data.js');
const { TEMPLATES } = await import('../src/mesh/mesher.js');
const {
  buildItemNames, NON_PLACEABLE_ITEMS, HIDDEN_FROM_INVENTORY,
} = await import('../src/player/inventory.js');
const { buildDefaultRegistry } = await import('../src/voxel/block-registry.js');
const { BLOCKS } = await import('../src/voxel/blocks-data.js');
// 丧尸皮肤（标准 64×64 版式）的版式参数与指纹走共享模块
// （红线 1：与烘焙脚本同一份逻辑，两处漂移会让指纹比对得出错误结论）
const {
  SKIN_PNG, SKIN_JSON, SKIN_SIZE, SKIN_LAYOUT_VERSION, SKIN_REGIONS,
  SKIN_REGION_MIN_DIST, skinInputFingerprint,
} = await import('./zombie-skin-fingerprint.mjs');
// 祭坛飞龙（v2.41）的烘焙参数/度量/指纹走共享模块（红线 1：与烘焙脚本同一份逻辑）
const {
  DRAGON_JSON, DRAGON_PNG, DRAGON_META, DRAGON_BAKE_PARAMS, DRAGON_METRICS,
  dragonInputFingerprint,
} = await import('./dragon-fingerprint.mjs');
// 焰魔（v2.55）的烘焙参数/度量/指纹同理（与 bake-ignis.mjs 同一份逻辑）
const {
  IGNIS_JSON, IGNIS_PNG, IGNIS_META, IGNIS_BAKE_PARAMS, IGNIS_METRICS, IGNIS_ANIM_PERIODS,
  ignisInputFingerprint,
} = await import('./ignis-fingerprint.mjs');
// v1.26：图标走独立 icons-atlas（不再有 INVENTORY_ICONS 表）。指纹/清单走共享模块
// （红线 1：与烘焙脚本同一份逻辑，两处漂移会让指纹比对得出错误结论）。
const { iconFingerprintFor, FLAT_BLOCKS, FLAT_ICON_TILE } = await import('./icon-fingerprint.mjs');
// 炮塔装甲纹理的参数与指纹走共享模块（红线 1：与烘焙脚本同一份逻辑）
const {
  ARMOR_PNG, ARMOR_JSON, ARMOR_WIDTH, ARMOR_HEIGHT, ARMOR_TEXTURE_CONFIG,
  armorInputFingerprint, readArmorPng,
} = await import('./turret-armor-fingerprint.mjs');
// 渲染侧的区序与部件定义（同为同构模块，无 three）—— 门禁据此断言两侧区序一致
const {
  ARMOR_ZONES, TURRET_PARTS, TURRET_PART_DEFS,
} = await import('../src/entities/turrets/turret-config.js');
// 创造台冻结数据与锚点 kind（M9）—— 门禁据此断言 service 侧与 config 单一权威一致（红线 1）
const {
  PLAYGROUND, PLAYGROUND_KIND, PLAYGROUND_BLOCK, PLAYGROUND_CENTER_BLOCK,
} = await import('../src/entities/playground/playground-config.js');
// v2.51：音效与启动图素材契约。清单从**运行时代码** import（红线 1：不在门禁里写第二份清单）
// —— `SOUND_IDS` / `BGM_TRACKS` 是唯一权威，这里只负责断言「列到的每个 id 都有对应 mp3」。
const { SOUND_IDS: SOUND_IDS_FOR_GATE, BGM_TRACKS } = await import('../src/render/audio-config.js');
// 矿车冻结数据 —— 门禁据此断言铁轨类型集合与 config 单一权威一致（红线 1）
const {
  MINECART_ITEM, TRACK_BLOCK_TYPES,
} = await import('../src/entities/minecarts/minecart-config.js');

const SKYBOX = await import('../src/render/sky-config.js');
// 浅水高台（v2.11）：产物基名/尺寸/映射表/白名单/指纹都走共享模块（红线 1）
const SHALLOW = await import('./shallow-tarns-fingerprint.mjs');
// 两个草方块的贴图烘焙参数与指纹（同上）
const GRASS_TEX = await import('./grass-textures-fingerprint.mjs');
// 跨湖拱桥的材质契约（v2.24）：六种必须都是已注册的 opaque 方块
const BRIDGE = await import('../src/gen/structures/shallow-water-bridge.js');
const atlasMeta = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'atlas.json'), 'utf8'));
const tiles = new Set(Object.keys(atlasMeta.tiles));

// 图标 manifest（icons.json 缺失 = 从没跑过 npm run icons）
const ICONS_JSON = path.join(ROOT, 'assets', 'icons.json');
const ICONS_PNG = path.join(ROOT, 'assets', 'icons-atlas.png');
const iconManifest = fs.existsSync(ICONS_JSON)
  ? JSON.parse(fs.readFileSync(ICONS_JSON, 'utf8')) : null;

// ---------------------------------------------------------------- [1] 引用完整性

/**
 * faces-data 引用的每个 tile 都必须存在于世界 atlas。
 *
 * 取代 `expect(count).toBe(156)`：新增贴图不用改断言，而**拼错 tile 名会当场报错**
 * （拼错不报错但渲染空槽 / 空图标，与真实 bug 同观感，肉眼难辨——v1.23 已踩过）。
 *
 * v1.26：图标不再走 faces-data 派生（改为独立烘焙产物），故此处只校验世界渲染贴图。
 * 图标侧的贴图引用完整性由 [8] 图标指纹检查间接覆盖（贴图缺失 → 指纹算不出 → 报错）。
 */
function checkReferenceIntegrity() {
  const referenced = new Map(); // tile → 引用它的来源
  for (const [block, v] of Object.entries(FACES_DATA)) {
    if (Array.isArray(v)) v.forEach((t) => t && referenced.set(t, `faces-data:${block}`));
    else if (v) referenced.set(v, `faces-data:${block}`);
  }
  // 平面图标的手工 tile（mine_cart → Invicon_Minecart）也必须在 atlas 里
  for (const [block, t] of Object.entries(FLAT_ICON_TILE)) referenced.set(t, `手工图标:${block}`);

  const dangling = [...referenced].filter(([t]) => !tiles.has(t));
  if (dangling.length) {
    for (const [t, src] of dangling) failures.push(`[引用完整性] ${src} → tile "${t}" 不存在于 atlas.json`);
  } else {
    infos.push(`[引用完整性] ${referenced.size} 个被引用 tile 全部存在于 atlas（atlas 共 ${tiles.size} tile）`);
  }
}

// ---------------------------------------------------------------- [2] 物品集合关系式

/**
 * 物品集合 ≡ registry.all() − 两个排除集合。
 *
 * 取代 `expect(items).toBe(118)`：改排除集合（如再加一个方块进 HIDDEN_FROM_INVENTORY）
 * **断言自动跟上**，不用改任何计数。原型已实测验证（v1.24 的 122→118 变更若用关系式就无需改断言）。
 */
function checkItemSetRelation() {
  const items = buildItemNames(REGISTRY);
  const expected = REGISTRY.all().map((e) => e.name)
    .filter((n) => !NON_PLACEABLE_ITEMS.includes(n) && !HIDDEN_FROM_INVENTORY.includes(n));

  const missing = expected.filter((n) => !items.includes(n));
  const extra = items.filter((n) => !expected.includes(n));
  if (missing.length || extra.length) {
    if (missing.length) failures.push(`[物品集合] 关系式算出但集合里没有：${missing.join(', ')}`);
    if (extra.length) failures.push(`[物品集合] 集合里有但关系式没算出：${extra.join(', ')}`);
  } else {
    infos.push(`[物品集合] ${items.length} 项 = registry ${REGISTRY.all().length} − 排除 ${NON_PLACEABLE_ITEMS.length + HIDDEN_FROM_INVENTORY.length}（改排除集合自动跟上）`);
  }

  // 排除集合本身必须是真实方块名（防拼错：拼错的排除项静默无效，方块会意外进背包）
  const allNames = new Set(REGISTRY.all().map((e) => e.name));
  for (const list of [NON_PLACEABLE_ITEMS, HIDDEN_FROM_INVENTORY]) {
    for (const n of list) {
      if (!allNames.has(n)) failures.push(`[物品集合] 排除集合含不存在的方块名 "${n}"（拼错则排除静默失效）`);
    }
  }
}

// ---------------------------------------------------------------- [3] 图标 manifest 覆盖

/**
 * 背包集合的每一项都必须有图标条目（快捷栏 + 背包两套尺寸档）。
 *
 * 取代旧的 [3] 图标同步 + [4] 图标表无幽灵（它们钉的是 `INVENTORY_ICONS` 表，v1.26 已删）。
 * 新架构下 manifest 是烘焙产物，覆盖范围由烘焙脚本按 `buildItemNames()` 决定 ——
 * 本检查钉「manifest 与背包集合**双向一致**」这个不变式：
 *   - 缺项 → 新增方块忘跑 `npm run icons`（该格渲染空图标）
 *   - 幽灵项 → 方块移出背包但 manifest 残留（语义失真，与旧 [4] 同因）
 *
 * 这是关系型断言：改背包集合（增删方块）后重跑烘焙即自动跟上，不用改任何计数。
 */
function checkIconManifestCoverage() {
  if (!iconManifest) {
    failures.push('[图标 manifest] assets/icons.json 不存在 —— 跑 npm run icons');
    return;
  }
  const items = new Set(buildItemNames(REGISTRY));
  for (const sizeKey of ['hotbar', 'inventory']) {
    const map = iconManifest[sizeKey] ?? {};
    const missing = [...items].filter((n) => map[n] === undefined);
    const ghosts = Object.keys(map).filter((n) => !items.has(n));
    if (missing.length) {
      failures.push(`[图标 manifest] ${sizeKey} 档缺项（背包里有但无图标，跑 npm run icons）：${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ` …共 ${missing.length}` : ''}`);
    }
    if (ghosts.length) {
      failures.push(`[图标 manifest] ${sizeKey} 档幽灵项（manifest 里有但不在背包集合）：${ghosts.slice(0, 8).join(', ')}`);
    }
    if (!missing.length && !ghosts.length) {
      infos.push(`[图标 manifest] ${sizeKey} 档 ${Object.keys(map).length} 项 = 背包集合（双向一致）`);
    }
  }
}

// ---------------------------------------------------------------- [4] 图标 atlas 产物存在性

/**
 * 图标 atlas 产物必须存在且与 manifest 一致。
 *
 * 取代旧的 [6] 烘焙产物存在性（钉的是 inventory-icons/ 目录下的 PNG，v1.26 改为单一 atlas）。
 * 防「icons.json 存在但 icons-atlas.png 被删」的半失效状态，以及 manifest.size 与真实
 * PNG 尺寸不符（烘焙到一半失败 / 手改了 atlas）。
 */
function checkIconAtlasArtifacts() {
  if (!iconManifest) return; // [3] 已报缺失
  if (!fs.existsSync(ICONS_PNG)) {
    failures.push('[图标 atlas] assets/icons-atlas.png 不存在 —— 跑 npm run icons');
    return;
  }
  const png = PNG.sync.read(fs.readFileSync(ICONS_PNG));
  if (png.width !== iconManifest.size || png.height !== iconManifest.size) {
    failures.push(`[图标 atlas] PNG ${png.width}×${png.height} 与 manifest.size ${iconManifest.size} 不符（烘焙到一半失败？）`);
  } else {
    infos.push(`[图标 atlas] icons-atlas.png ${png.width}² 与 manifest.size 一致`);
  }
}

// ---------------------------------------------------------------- [5] 图标指纹过期检查（核心）

/**
 * **图标过期检查**（v1.26 核心门禁）：用当前源码重算每个方块的输入指纹，与烘焙时写进
 * icons.json 的指纹比对 —— 不匹配即报「跑 npm run icons」。
 *
 * 图标是**派生产物**，权威输入是 mesher 的几何 + faces-data 的贴图。失效路径（v1.24 已记录
 * 一次，范围从 9 扩到物品集合全量后更容易踩）：
 *   - 改了 mesher 几何 / faces-data 贴图映射 → 忘跑 icons → 图标渲染旧形状/旧配色
 *   - **换了一张同名贴图 PNG**（内容变了、映射没变）→ 忘跑 icons → 图标配色过期
 * 这三条肉眼都看不出（图标照常显示，只是不对），只有指纹比对能当场拦住。
 *
 * 指纹含贴图**内容哈希**（不只贴图名）—— 实测确认过「只钉贴图名」会漏掉换同名 PNG 的情况。
 * 指纹逻辑走共享模块 `tools/icon-fingerprint.mjs`（红线 1：与烘焙脚本同一份，两处漂移会误判）。
 */
function checkIconFreshness() {
  if (!iconManifest) return; // [3] 已报缺失
  const baked = iconManifest.fingerprints ?? {};
  if (!Object.keys(baked).length) {
    failures.push('[图标过期] icons.json 无 fingerprints 字段 —— 产物是旧版烘焙的，重跑 npm run icons');
    return;
  }
  const items = buildItemNames(REGISTRY);
  const byName = new Map(BLOCKS.map((b) => [b.name, b]));
  const stale = [];
  const missingFp = [];
  for (const name of items) {
    const def = byName.get(name);
    if (!def) continue; // [1]/[3] 会报方块不存在
    const current = iconFingerprintFor(name, def);
    if (baked[name] === undefined) { missingFp.push(name); continue; }
    if (baked[name] !== current) stale.push(name);
  }
  if (missingFp.length) {
    failures.push(`[图标过期] 缺指纹（新增方块未烘焙，跑 npm run icons）：${missingFp.slice(0, 8).join(', ')}`);
  }
  if (stale.length) {
    failures.push(`[图标过期] 输入已变但图标未重烘（跑 npm run icons）：${stale.slice(0, 10).join(', ')}${stale.length > 10 ? ` …共 ${stale.length}` : ''}`);
  }
  if (!stale.length && !missingFp.length) {
    infos.push(`[图标过期] ${items.length} 项指纹全部匹配（图标与几何/贴图同步）`);
  }
}

// ---------------------------------------------------------------- [6] 几何模板存在性

/**
 * 图标几何路径正确性（红线 1 精神：形状权威只有一份）。
 *
 * 防「平面清单漏标了一个非实心方块 → 它被当实心走等轴测 → cubeQuads 渲成立方体（错的）」。
 * 实测口径：非实心方块必须在 FLAT_BLOCKS 里（否则等轴测立方体对植被/水是错的表达）。
 *
 * **`geometry === 'box'`（或 null）不是缺陷** —— 实测它是实心方块的正常标记（103 个方块用
 * 它），语义是「用单位立方体」，mesher 对它走默认路径（`FACE_VERTICES`），图标烘焙对应走
 * `cubeQuads()`。只有「非 box/null 且无 TEMPLATES 条目」才是缺陷：那说明 geometry 指向一个
 * 应该存在但缺失的模板（拼错模板名 / 新增异形方块忘加模板）。
 */
function checkGeometryAuthority() {
  const byName = new Map(BLOCKS.map((b) => [b.name, b]));
  const items = buildItemNames(REGISTRY);
  const wrongPath = [];
  for (const name of items) {
    const def = byName.get(name);
    if (!def) continue;
    const flat = FLAT_BLOCKS.includes(name);
    // 非实心却没进平面清单 → 会被当实心立方体渲染（错）
    if (!def.solid && !flat) wrongPath.push(`${name}（solid=false 但不在 FLAT_BLOCKS → 会渲成立方体）`);
    // 异形 geometry 指向缺失的模板 → 静默 fallback 立方体（错）。box/null 是正常的单位立方体标记。
    if (!flat && def.geometry && def.geometry !== 'box' && !TEMPLATES[def.geometry]) {
      wrongPath.push(`${name}（geometry "${def.geometry}" 无 TEMPLATES 条目 → 静默 fallback 立方体）`);
    }
  }
  if (wrongPath.length) {
    failures.push(`[形状权威] 图标几何路径有误：${wrongPath.slice(0, 6).join('; ')}`);
  } else {
    const isoCount = items.filter((n) => !FLAT_BLOCKS.includes(n)).length;
    infos.push(`[形状权威] ${isoCount} 项等轴测（几何有权威）+ ${items.length - isoCount} 项平面`);
  }
}

// ---------------------------------------------------------------- [7] 测试注册完整性

/**
 * src/tests/test-*.js 必须全部出现在 src/tests/index.html 的 import 里。
 *
 * 漏注册 = **测试静默不跑**，比测试失败更危险（失败了会报错，漏注册是全绿假象）。
 */
function checkTestRegistration() {
  const dir = path.join(ROOT, 'src', 'tests');
  const actual = fs.readdirSync(dir)
    .filter((f) => /^test-.*\.js$/.test(f)).sort();
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const registered = [...html.matchAll(/import\s+'\.\/(test-[^']+\.js)'/g)].map((m) => m[1]);

  const unregistered = actual.filter((f) => !registered.includes(f));
  const dangling = registered.filter((f) => !actual.includes(f));
  if (unregistered.length) failures.push(`[测试注册] 存在但未注册（= 静默不跑）：${unregistered.join(', ')}`);
  if (dangling.length) failures.push(`[测试注册] 已注册但文件不存在（死引用）：${dangling.join(', ')}`);
  if (!unregistered.length && !dangling.length) {
    infos.push(`[测试注册] ${actual.length} 个测试文件全部已注册`);
  }
}


// ---------------------------------------------------------------- [8] 撒布结构引用完整性

/**
 * 每个撒布结构类型必须三个环节齐全，否则结构**静默消失**（无任何报错）。
 *
 * 链路上任一环节缺失的后果都是「方块不出现」，而**方块层面看不出差别** —— 实测删掉
 * flowerBed 的 STRUCTURE_FILES 映射后，坐标判据的 footprint 框内仍数得到其它结构/树的方块，
 * 浏览器内单测全绿（无效负向验证）。故这条契约只能静态断言。
 *
 *   ① STRUCTURE_FILES 映射 → 缺则 `rasterizeStructure` 静默 return（structure-json.js:84）
 *   ② assets/structures/*.json 真存在 → 缺则 fetch 404 被 loadStructure 的 catch 吞成空结构
 *   ③ SCATTER_FOOTPRINT 占地 → 缺则 AABB 相交判定跳过（apply.js `if (!fp) continue`）
 *
 * ② 只有本脚本能验（浏览器里 fetch 失败被吞成空结构，不报错）。
 *
 * 注：预载环节**无需**单独断言 —— apply.js 从候选数组的 typeIndex 直接取出类型加入
 * `needTypes`（惰性预载），不存在「第二份预载清单」可与 SCATTER_TYPES 漂移（红线 1）。
 */
async function checkScatterStructureIntegrity() {
  const { STRUCTURE_FILES } = await import('../src/gen/structures/structure-json.js');
  const { SCATTER_TYPES, CODE_GENERATED_SCATTER_TYPES } = await import('../src/gen/structures/scatter.js');
  const { SCATTER_FOOTPRINT } = await import('../src/gen/structures/region-config.js');

  // JSON 撒布类型 = SCATTER_TYPES 去掉代码生成类型（house/ship 无 JSON，走 generateCodeXxx）。
  // ⚠️ 派生基准必须是 CODE_GENERATED_SCATTER_TYPES，不能写成 `t !== 'house'` 字面量 ——
  // 那样加第二个代码生成类型（ship）时本门禁会要求它有 STRUCTURE_FILES 映射 + 磁盘 JSON，
  // 于是**误报**；反过来若某代码生成类型没被识别 → 走 rasterizeStructure → cache 未命中 →
  // 结构静默消失（方块层面看不出差别）。
  const jsonTypes = SCATTER_TYPES.filter((t) => !CODE_GENERATED_SCATTER_TYPES.includes(t));
  const problems = [];

  for (const t of jsonTypes) {
    if (!STRUCTURE_FILES[t]) problems.push(`${t} 缺 STRUCTURE_FILES 映射（rasterize 会静默跳过）`);
    else {
      const file = path.join(ROOT, 'assets', 'structures', STRUCTURE_FILES[t]);
      if (!fs.existsSync(file)) {
        problems.push(`${t} → ${STRUCTURE_FILES[t]} 文件不存在（fetch 404 会被吞成空结构）`);
      }
    }
    if (!SCATTER_FOOTPRINT[t]) problems.push(`${t} 缺 SCATTER_FOOTPRINT 占地（AABB 裁剪会跳过）`);
  }

  // 代码生成类型（house/ship）虽无 JSON，但同样需要 SCATTER_FOOTPRINT ——
  // apply.js 的 `if (!fp) continue;` 对它们一样生效，缺占地 → 候选被静默跳过 → 结构消失。
  for (const t of CODE_GENERATED_SCATTER_TYPES) {
    if (!SCATTER_TYPES.includes(t)) problems.push(`${t} 不在 SCATTER_TYPES（候选层不会产出它）`);
    if (!SCATTER_FOOTPRINT[t]) problems.push(`${t}（代码生成）缺 SCATTER_FOOTPRINT 占地（AABB 裁剪会跳过）`);
  }

  if (problems.length) {
    for (const p of problems) failures.push(`[撒布结构] ${p}`);
  } else {
    infos.push(`[撒布结构] ${jsonTypes.length} 个 JSON 类型 + ${CODE_GENERATED_SCATTER_TYPES.length} 个代码生成类型，占地齐全`);
  }

  // ---- `SCATTER_FOOTPRINT[*].real` 必须与磁盘 JSON 实测包围盒一致（v2.2）----
  //
  // 为什么需要这条：`real`（真实占地）与 `halfX/halfZ`（抑制/裁剪范围）是**两套口径**，而
  // pavilion 的跨类型重叠判定只读 `real`。假设有人改了 pavilion.json 的几何却忘同步 `real`：
  // 重叠判定就会用错的框子 —— 后果是**静默的**（亭子要么多穿别的结构，要么白占一块地），
  // 方块层面完全看不出异常。
  //
  // ⚠️ 只校验 JSON 类型；代码生成类型（house/ship）的 `real` 由生成函数决定，无 JSON 可比。
  // ⚠️ `tallWell` 的 `real`（5/4）与 `halfX/halfZ`（24/20）**故意不一致**，本门禁不为此报错 ——
  // 它只校 real ↔ JSON，不校 real ↔ half。
  const realProblems = [];
  for (const t of jsonTypes) {
    const fp = SCATTER_FOOTPRINT[t];
    if (!fp || !fp.real) { realProblems.push(`${t} 缺 SCATTER_FOOTPRINT.real（重叠判定会退化成不相交）`); continue; }
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'structures', STRUCTURE_FILES[t]), 'utf8'));
    } catch { continue; }   // 文件缺失已由上面的环节报错，此处不重复
    // 只支持「旧格式 {blocks:[{x,y,z}]}」的实测包围盒 —— palette 格式（高台/金字塔）不参与撒布
    if (!Array.isArray(raw.blocks) || typeof raw.blocks[0] !== 'object') continue;
    let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
    for (const b of raw.blocks) {
      if (b.x < mnx) mnx = b.x; if (b.x > mxx) mxx = b.x;
      if (b.z < mnz) mnz = b.z; if (b.z > mxz) mxz = b.z;
    }
    const r = fp.real;
    if (r.minX !== mnx || r.maxX !== mxx || r.minZ !== mnz || r.maxZ !== mxz) {
      realProblems.push(`${t} 的 real 与 JSON 实测不符：声明 x[${r.minX},${r.maxX}] z[${r.minZ},${r.maxZ}]，`
        + `实测 x[${mnx},${mxx}] z[${mnz},${mxz}]`);
    }
  }
  if (realProblems.length) {
    for (const p of realProblems) failures.push(`[撒布占地] ${p}`);
  } else {
    infos.push(`[撒布占地] ${jsonTypes.length} 个 JSON 类型的 real 与磁盘实测包围盒一致`);
  }
}

// ---------------------------------------------------------------- [结构 JSON] 孤立块契约

/**
 * 结构 JSON 里不得有「孤立列块」：某 (x,z) 列只有一个块，且它比结构次高块高出 5 格以上。
 *
 * 背景（2026-09-30 修复）：tall_well.json 曾有一个孤立的 `chest@(24,51,20)`（mc-lite 上游
 * 数据异常，井体本身只到 y=16）—— 它在 y=51 完全悬空，每个 tallWell 候选都渲染一个
 * → 用户报告「天空中好多悬空宝箱」。光栅化是逐块无条件写入，不会校验支撑，
 * 只有本门禁能抓。
 *
 * 判据选「孤立列 + 远超次高」而非「逐块查支撑」：JSON 结构里大量块靠**结构自身**的
 * 横向连接支撑（树冠/挑台/桥梁，实测 27 个 JSON 里逐块查支撑会误报几百个），
 * 而「独占一列且孤零零高出次高 5 格以上」的块在任何结构语义下都是数据异常。
 * 负向验证：本规则在修复前的 tall_well.json 上命中 1 个（正是那个 chest），修复后 0。
 */
function checkStructureJsonOrphans() {
  const dir = path.join(ROOT, 'assets', 'structures');
  const problems = [];
  let files = 0;
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    files++;
    const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const blocks = data.blocks || [];
    if (!blocks.length) continue;
    const colCount = new Map();
    for (const b of blocks) {
      const key = `${b.x},${b.z}`;
      colCount.set(key, (colCount.get(key) || 0) + 1);
    }
    const ys = blocks.map((b) => b.y).sort((a, b) => a - b);
    const secondMaxY = ys.length > 1 ? ys[ys.length - 2] : ys[0];
    for (const b of blocks) {
      if (colCount.get(`${b.x},${b.z}`) === 1 && b.y > secondMaxY + 5) {
        problems.push(`${f}: 孤立块 ${b.type}@(${b.x},${b.y},${b.z}) 比次高块(y=${secondMaxY}) 高出 ${b.y - secondMaxY} 格，疑似悬空数据异常`);
      }
    }
  }
  if (problems.length) {
    for (const p of problems) failures.push(`[结构 JSON] ${p}`);
  } else {
    infos.push(`[结构 JSON] ${files} 个结构无孤立悬空块（tall_well 悬空宝箱回归防线）`);
  }
}

// ---------------------------------------------------------------- [9] 丧尸皮肤契约

/** 一组矩形的并集均值 RGB（sRGB 0..255）；门禁与烘焙摘要共用同一口径 */
function regionMean(png, rects) {
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (const r of rects) {
    for (let y = r.y0; y < r.y1; y++) {
      for (let x = r.x0; x < r.x1; x++) {
        const o = (y * png.width + x) * 4;
        sr += png.data[o]; sg += png.data[o + 1]; sb += png.data[o + 2]; n++;
      }
    }
  }
  return [sr / n, sg / n, sb / n];
}

/**
 * 丧尸皮肤（64×64 标准版式）的四个环节必须齐全，否则观感**静默错乱**。
 *
 * 失效路径与图标过期同类（v1.24 记录过「改 mesher 几何忘跑 atlas」）：皮肤是**派生产物**，
 * 权威输入是 `tools/zombie-skin-fingerprint.mjs` 的参数 + re-export 的
 * `src/render/zombie-model.js` 的 UV 表。改了参数却忘跑 `npm run zombieskin`
 * → 渲染旧图（肉眼看不出「过期」，只觉得「颜色怪怪的」）。
 *
 * 四条断言：
 *   ① PNG 存在 + 尺寸 = 64×64 → 缺文件时 `loadAsync` 抛错，game.js 的 catch 会退回纯色
 *      （**静默降级**，不阻断启动 → 只有门禁能抓）
 *   ② 版式版本与当前 UV 表匹配 → 抓「UV 表改成新布局但皮肤还是旧布局」
 *   ③ 三区均值色距 ≥ 阈值 → 抓「绿皮 / 上衣 / 裤子配色撞车」（远看是一个纯色人形）
 *   ④ 输入指纹匹配 → 抓「改了参数忘重烘」（指纹逻辑走共享模块，红线 1）
 */
function checkZombieSkinTexture() {
  if (!fs.existsSync(SKIN_PNG)) {
    failures.push('[丧尸皮肤] assets/zombie/skin.png 不存在 —— 跑 npm run zombieskin');
    return;
  }
  const png = PNG.sync.read(fs.readFileSync(SKIN_PNG));
  if (png.width !== SKIN_SIZE || png.height !== SKIN_SIZE) {
    failures.push(`[丧尸皮肤] PNG ${png.width}×${png.height} 与期望 ${SKIN_SIZE}×${SKIN_SIZE} 不符（烘焙到一半失败？）`);
    return;
  }

  // ② 版式版本 + ③ 三区色距 + ④ 指纹（都需要 manifest）
  if (!fs.existsSync(SKIN_JSON)) {
    failures.push('[丧尸皮肤] assets/zombie/skin.json 不存在 —— 跑 npm run zombieskin');
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(SKIN_JSON, 'utf8'));
  if (manifest.layout !== SKIN_LAYOUT_VERSION) {
    failures.push(`[丧尸皮肤] 版式版本 ${manifest.layout} ≠ 期望 ${SKIN_LAYOUT_VERSION}`
      + '（UV 表与皮肤布局不同步，重跑 npm run zombieskin）');
  }

  const means = {};
  for (const [name, rects] of Object.entries(SKIN_REGIONS)) means[name] = regionMean(png, rects);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const pairs = [['head', 'torso'], ['torso', 'leg'], ['head', 'leg']];
  for (const [a, b] of pairs) {
    const d = dist(means[a], means[b]);
    if (d < SKIN_REGION_MIN_DIST) {
      failures.push(`[丧尸皮肤] 「${a}」与「${b}」的均值色距 ${d.toFixed(1)} < ${SKIN_REGION_MIN_DIST}`
        + `（${means[a].map(Math.round)} vs ${means[b].map(Math.round)}）—— 三区分不开，远看是纯色人形`);
    }
  }

  const current = skinInputFingerprint();
  if (manifest.fingerprint !== current) {
    failures.push('[丧尸皮肤] 参数已变但皮肤未重烘（跑 npm run zombieskin）'
      + `\n      期望 ${current}\n      实际 ${manifest.fingerprint}`);
  }

  if (!failures.some((f) => f.startsWith('[丧尸皮肤]'))) {
    const d01 = dist(means.head, means.torso), d12 = dist(means.torso, means.leg), d02 = dist(means.head, means.leg);
    infos.push(`[丧尸皮肤] skin.png ${SKIN_SIZE}×${SKIN_SIZE} 版式 ${SKIN_LAYOUT_VERSION}`
      + ` + 三区色距 ${d01.toFixed(0)}/${d12.toFixed(0)}/${d02.toFixed(0)}（阈值 ${SKIN_REGION_MIN_DIST}）`
      + ' + 指纹匹配');
  }
}

// ---------------------------------------------------------------- [龙] 契约（v2.41 祭坛飞龙）

/**
 * [龙] 契约：① 产物存在；② PNG 尺寸 = `DRAGON_BAKE_PARAMS.textureSize`；③ 产物契约
 * （关系式，不硬编码计数）：scale/骨骼数/顶点数/索引数/动画清单与帧数全部与
 * `DRAGON_METRICS` 双向一致；④ 指纹匹配（静默过期防护，与丧尸皮肤/竞技场同口径）。
 *
 * ⚠️ **成功行必须涵盖全部判据**（AGENTS.md 已记该坑：新判据只加进 `failures` 而不并进
 * 成功行条件，会同时打印「✗」与「✓」，读者只看 ✓ 就误判通过）。
 *
 * ⚠️ **已知盲区**（同所有烘焙产物）：只改**烘焙算法**而不动参数时指纹不变 →
 * 靠 `src/tests/test-dragon-bake.js` 的产物契约与 Tier 4 兑住。
 */
function checkDragonAsset() {
  // ① 产物存在
  for (const [p, label] of [[DRAGON_JSON, 'dragon.json'], [DRAGON_PNG, 'dragon.png'], [DRAGON_META, 'dragon.meta.json']]) {
    if (!fs.existsSync(p)) {
      failures.push(`[龙] assets/dragon/${label} 不存在 —— 跑 npm run dragon`);
      return;
    }
  }
  // ② PNG 尺寸
  const png = PNG.sync.read(fs.readFileSync(DRAGON_PNG));
  if (png.width !== DRAGON_BAKE_PARAMS.textureSize || png.height !== DRAGON_BAKE_PARAMS.textureSize) {
    failures.push(`[龙] PNG ${png.width}×${png.height} ≠ 期望 ${DRAGON_BAKE_PARAMS.textureSize}²（烘焙到一半失败？）`);
  }
  // ③ 产物契约（关系式）
  const asset = JSON.parse(fs.readFileSync(DRAGON_JSON, 'utf8'));
  const meta = JSON.parse(fs.readFileSync(DRAGON_META, 'utf8'));
  const M = DRAGON_METRICS;
  if (asset.scale !== M.scale || asset.metrics.scale !== M.scale) {
    failures.push(`[龙] scale ${asset.scale}/${asset.metrics.scale} ≠ 期望 ${M.scale}（用户裁定 3 倍，产物已含、运行时不再乘）`);
  }
  if (asset.bones.length !== M.boneCount) {
    failures.push(`[龙] 骨骼数 ${asset.bones.length} ≠ 期望 ${M.boneCount}（烘焙漏了骨骼 → 静默缺肉）`);
  }
  if (asset.geometry.position.length !== M.vertexCount * 3) {
    failures.push(`[龙] 顶点数 ${asset.geometry.position.length / 3} ≠ 期望 ${M.vertexCount}（烘焙漏了元素）`);
  }
  if (asset.geometry.index.length !== M.indexCount) {
    failures.push(`[龙] 索引数 ${asset.geometry.index.length} ≠ 期望 ${M.indexCount}`);
  }
  const animNames = Object.keys(asset.animations).sort();
  if (animNames.join(',') !== 'fly,glide') {
    failures.push(`[龙] 动画清单 ${animNames.join(',')} ≠ 期望 fly,glide`);
  } else {
    // 帧数 = 素材 length × fps（fly 1.2×30=36、glide 3.0×30=90）
    const expectFrames = { fly: 36, glide: 90 };
    for (const name of animNames) {
      const a = asset.animations[name];
      if (a.frameCount !== expectFrames[name]) {
        failures.push(`[龙] ${name} 帧数 ${a.frameCount} ≠ 期望 ${expectFrames[name]}（length×fps）`);
      }
      if (a.fps !== 30) failures.push(`[龙] ${name} fps ${a.fps} ≠ 30`);
      if (a.frames.length !== a.frameCount * a.boneIndices.length * 7) {
        failures.push(`[龙] ${name} frames 扁平数组长度不符（${a.frames.length}）`);
      }
    }
  }
  // ④ 指纹
  const current = dragonInputFingerprint();
  if (meta.fingerprints?.input !== current.input) {
    failures.push(`[龙] 输入已变但产物未重烘（跑 npm run dragon）\n      期望 ${current.input}\n      实际 ${meta.fingerprints?.input}`);
  }
  // 成功行：全部判据都过才打印（⚠️ 涵盖全部判据，不是只判存在）
  if (!failures.some((f) => f.startsWith('[龙]'))) {
    infos.push(`[龙] 产物契约与指纹一致（${asset.bones.length} 骨骼 / ${asset.geometry.position.length / 3} 顶点 / fly ${asset.animations.fly.frameCount} 帧 + glide ${asset.animations.glide.frameCount} 帧 / scale ${asset.scale}）`);
  }
}

// ---------------------------------------------------------------- [焰魔] 契约（v2.55）

/**
 * [焰魔] 契约：① 三个产物存在；② PNG 尺寸 = `IGNIS_BAKE_PARAMS.textureSize`；
 * ③ 产物契约（骨骼数 / 烘焙立方体数 / 顶点数 / 索引数 / 动画清单与帧数）；
 * ④ 指纹匹配（静默过期防护）。
 *
 * ⚠️ **成功行必须涵盖全部判据**（AGENTS.md 已记该坑：新判据只加进 `failures` 而不并进
 * 成功行条件，会同时打印「✗」与「✓」，读者只看 ✓ 就误判通过）。
 *
 * ⚠️ **`animations.idle.fps` 不是整数**（`idleFrameCount / (2π/128)` ≈ 244.46）：
 * 刻意的，使产物 `duration` 与表达式周期**逐位相等**（循环接缝恒 0）。
 * 这里断言的是 **duration 关系式**，不是 fps 的具体值。
 */
function checkIgnisAsset() {
  // ① 产物存在
  for (const [p, label] of [[IGNIS_JSON, 'ignis.json'], [IGNIS_PNG, 'ignis.png'], [IGNIS_META, 'ignis.meta.json']]) {
    if (!fs.existsSync(p)) {
      failures.push(`[焰魔] assets/ignis/${label} 不存在 —— 跑 npm run ignis`);
      return;
    }
  }
  // ② PNG 尺寸
  const png = PNG.sync.read(fs.readFileSync(IGNIS_PNG));
  if (png.width !== IGNIS_BAKE_PARAMS.textureSize || png.height !== IGNIS_BAKE_PARAMS.textureSize) {
    failures.push(`[焰魔] PNG ${png.width}×${png.height} ≠ 期望 ${IGNIS_BAKE_PARAMS.textureSize}²（烘焙到一半失败？）`);
  }
  // ③ 产物契约
  const asset = JSON.parse(fs.readFileSync(IGNIS_JSON, 'utf8'));
  const meta = JSON.parse(fs.readFileSync(IGNIS_META, 'utf8'));
  const M = IGNIS_METRICS;
  if (asset.scale !== M.scale || asset.metrics.scale !== M.scale) {
    failures.push(`[焰魔] scale ${asset.scale}/${asset.metrics.scale} ≠ 期望 ${M.scale}（用户裁定原生 1 倍，产物已含、运行时不再乘）`);
  }
  if (asset.bones.length !== M.boneCount) {
    failures.push(`[焰魔] 骨骼数 ${asset.bones.length} ≠ 期望 ${M.boneCount}（烘焙漏了骨骼 → 静默缺肉）`);
  }
  if (asset.metrics.bakedCubes !== M.bakedCubes) {
    failures.push(`[焰魔] 烘焙立方体数 ${asset.metrics.bakedCubes} ≠ 期望 ${M.bakedCubes}`);
  }
  if (asset.metrics.skippedCubes !== M.skippedCubes) {
    failures.push(`[焰魔] 跳过的零尺寸立方体数 ${asset.metrics.skippedCubes} ≠ 期望 ${M.skippedCubes}`);
  }
  if (asset.geometry.position.length !== M.vertexCount * 3) {
    failures.push(`[焰魔] 顶点数 ${asset.geometry.position.length / 3} ≠ 期望 ${M.vertexCount}`);
  }
  if (asset.geometry.index.length !== M.indexCount) {
    failures.push(`[焰魔] 索引数 ${asset.geometry.index.length} ≠ 期望 ${M.indexCount}`);
  }
  const animNames = Object.keys(asset.animations).sort();
  if (animNames.join(',') !== 'attack,idle') {
    failures.push(`[焰魔] 动画清单 ${animNames.join(',')} ≠ 期望 attack,idle`);
  } else {
    const idle = asset.animations.idle;
    const attack = asset.animations.attack;
    // idle：帧数 = idleFrameCount，且 duration 逐位等于表达式周期（接缝恒 0）
    if (idle.frameCount !== IGNIS_BAKE_PARAMS.idleFrameCount) {
      failures.push(`[焰魔] idle 帧数 ${idle.frameCount} ≠ 期望 ${IGNIS_BAKE_PARAMS.idleFrameCount}`);
    }
    const idleDuration = idle.frameCount / idle.fps;
    if (Math.abs(idleDuration - IGNIS_ANIM_PERIODS.idle) > 1e-12) {
      failures.push(`[焰魔] idle duration ${idleDuration} ≠ 表达式周期 ${IGNIS_ANIM_PERIODS.idle}（接缝会跳变）`);
    }
    // attack：帧数 = round(period × fps)
    const expectAttackFrames = Math.round(IGNIS_ANIM_PERIODS.attack * IGNIS_BAKE_PARAMS.defaultFps);
    if (attack.frameCount !== expectAttackFrames) {
      failures.push(`[焰魔] attack 帧数 ${attack.frameCount} ≠ 期望 ${expectAttackFrames}（period×fps）`);
    }
    if (attack.fps !== IGNIS_BAKE_PARAMS.defaultFps) {
      failures.push(`[焰魔] attack fps ${attack.fps} ≠ ${IGNIS_BAKE_PARAMS.defaultFps}`);
    }
    for (const [name, a] of Object.entries(asset.animations)) {
      if (a.frames.length !== a.frameCount * a.boneIndices.length * 7) {
        failures.push(`[焰魔] ${name} frames 扁平数组长度不符（${a.frames.length}）`);
      }
    }
  }
  // ④ 指纹
  const current = ignisInputFingerprint();
  if (meta.fingerprints?.input !== current.input) {
    failures.push(`[焰魔] 输入已变但产物未重烘（跑 npm run ignis）\n      期望 ${current.input}\n      实际 ${meta.fingerprints?.input}`);
  }
  // 成功行：全部判据都过才打印
  if (!failures.some((f) => f.startsWith('[焰魔]'))) {
    infos.push(`[焰魔] 产物契约与指纹一致（${asset.bones.length} 骨骼 / ${asset.metrics.bakedCubes} 立方体（跳过 ${asset.metrics.skippedCubes} 零尺寸） / ${asset.geometry.position.length / 3} 顶点 / idle ${asset.animations.idle.frameCount} 帧 + attack ${asset.animations.attack.frameCount} 帧 / scale ${asset.scale}）`);
  }
}

// ---------------------------------------------------------------- [炮塔装甲] 契约（M8）

/**
 * [炮塔装甲] 契约：① 产物存在 + 尺寸正确 + 指纹匹配当前源图（静默过期防护，与丧尸头部
 * 同口径）；② **两侧区序一致** + **部件 zone ⊆ 区序**（关系型断言 —— 渲染层与烘焙脚本
 * 的区序漂移会让 UV 整体错位，渲染出错图案而肉眼只觉得「贴图怪怪的」）。
 *
 * ⚠️ **已知盲区**（照丧尸头部同口径）：改**烘焙算法**而不动源图/参数时指纹不变 →
 * 这类改动须靠 Tier 4 像素实测兜住。
 */
function checkTurretArmorTexture() {
  // ① 产物存在 + 尺寸
  const png = readArmorPng();
  if (!png) { failures.push('[炮塔装甲] assets/turret/armor.png 不存在 —— 跑 npm run turret'); return; }
  if (png.width !== ARMOR_WIDTH || png.height !== ARMOR_HEIGHT) {
    failures.push(`[炮塔装甲] PNG ${png.width}×${png.height} 与期望 ${ARMOR_WIDTH}×${ARMOR_HEIGHT} 不符`);
  }
  // ② 指纹（armor.json 缺失 = 从没跑过 npm run turret）
  if (!fs.existsSync(ARMOR_JSON)) {
    failures.push('[炮塔装甲] assets/turret/armor.json 不存在 —— 跑 npm run turret');
  } else {
    const meta = JSON.parse(fs.readFileSync(ARMOR_JSON, 'utf8'));
    const current = armorInputFingerprint();
    if (meta.fingerprint !== current) {
      failures.push('[炮塔装甲] 指纹不匹配 —— 源贴图或区参数变了但产物未重烘焙（跑 npm run turret）'
        + `\n      期望 ${current}\n      实际 ${meta.fingerprint}`);
    }
  }
  // ③ 区序两侧一致：渲染层的 ARMOR_ZONES 与烘焙侧的 ARMOR_TEXTURE_CONFIG.zones 须逐位相同。
  //    漂移 = 烘焙区序改了而渲染层没改（或反之）→ UV 整体错位（第二份副本的失效路径）。
  if (ARMOR_ZONES.length !== ARMOR_TEXTURE_CONFIG.zones.length ||
      ARMOR_ZONES.some((z, i) => z !== ARMOR_TEXTURE_CONFIG.zones[i])) {
    failures.push(`[炮塔装甲] 区序漂移：渲染层 ${ARMOR_ZONES.join('/')} ≠ 烘焙侧 `
      + `${ARMOR_TEXTURE_CONFIG.zones.join('/')}（改区序须两侧同步）`);
  }
  // ④ 部件 zone ⊆ 区序：每个装甲部件的 zone 必须是 ARMOR_ZONES 之一，否则
  //    `applyZoneUV(geometry, ARMOR_ZONES.indexOf(zone))` 会传 -1 → UV 映射到区外。
  for (const part of TURRET_PARTS) {
    const zone = TURRET_PART_DEFS[part].zone;
    if (zone !== null && !ARMOR_ZONES.includes(zone)) {
      failures.push(`[炮塔装甲] 部件 "${part}" 的 zone="${zone}" 不在 ARMOR_ZONES 内（UV 会映射到区外）`);
    }
  }
  if (!failures.some((f) => f.startsWith('[炮塔装甲]'))) {
    infos.push(`[炮塔装甲] ${png.width}×${png.height} 三区并排（${ARMOR_ZONES.join('/')}）+ 指纹匹配 + ${TURRET_PARTS.length} 部件`);
  }
}

// ---------------------------------------------------------------- [不可破坏] 契约（M8）

/**
 * [不可破坏] 契约：**声明侧（`blocks-data.js`）与派生侧（registry 表）双向一致**。
 * 任一侧漂移都会让三个消费者的门控静默失效（方块名对不上 → 表里恒 0 → 方块照常被炸）。
 *
 * ⚠️ **实测修正了计划里的断言落点**（testing-policy §2.7「恒真陷阱」）：计划写的
 * 「marked 的名字必须都在 registry 内」这条**在本仓架构下不可达** —— registry 是由
 * `BLOCKS` 逐条 `register()` 构建的（`buildDefaultRegistry()`），两侧名字必然同源。
 * 实测：把 `bedrock` 改名成 `bedrockx`，本门禁仍全绿（名字两侧同步改）→ 恒真断言。
 * 故改为**双向**：① 声明侧每一项在表里必须是 1（漏写表 → 抓到）；
 * ② 表里为 1 的每一项必须在声明侧（register 多标 → 抓到）。两条都实测注入过。
 */
function checkIndestructibleContract() {
  const marked = BLOCKS.filter((b) => b.indestructible).map((b) => b.name);
  if (marked.length === 0) failures.push('[不可破坏] blocks-data.js 无任何 indestructible 条目（表失效）');

  // ① 声明 → 表：每项都必须在表里为 1
  const notInTable = marked.filter((n) => !REGISTRY.isIndestructible(REGISTRY.idOf(n)));
  if (notInTable.length) {
    failures.push(`[不可破坏] 声明了但表里为 0：${notInTable.join(', ')}（register 未写表？）`);
  }

  // ② 表 → 声明：表里为 1 的每一项都必须有声明（register 多标会让门控误伤不该拦的方块）
  const markedSet = new Set(marked);
  const extraInTable = REGISTRY.all()
    .filter((e) => REGISTRY.isIndestructible(e.id) && !markedSet.has(e.name))
    .map((e) => e.name);
  if (extraInTable.length) {
    failures.push(`[不可破坏] 表里为 1 但 blocks-data.js 未声明：${extraInTable.join(', ')}`);
  }

  if (!failures.some((f) => f.startsWith('[不可破坏]'))) {
    infos.push(`[不可破坏] ${marked.length} 项：${marked.join(', ')}（三消费者共用单一权威）`);
  }
}

// ---------------------------------------------------------------- [阴影投射] 契约（v1.45）

/**
 * [阴影投射] 契约：`shadowCast:false` 的排除集合必须**恰好等于** mc-lite
 * `BlockData.isShadowEnabled:false` 中落在 opaque/cutout 通道的 13 项。
 *
 * ⚠️ **不校验「声明 ↔ registry 表」双向一致**（同 [不可破坏] 的恒真陷阱：registry 由
 * BLOCKS 逐条 register 构建，两侧名字必然同源，那条断言不可达）。本环节钉的是**排除集合
 * 本身**必须对齐 mc-lite 上游口径：
 *   - 漏标（如 cloud）→ 该方块重新投影 → 地面大面积云影黑斑（v1.45 修的缺陷复发）；
 *   - 多标（如误标 stone）→ 地形主体不投影 → 阴影系统静默失效。
 * 13 项清单的推导见 CLAUDE.md「阴影混合模型沉淀的活跃约束」段（mc-lite 124 键实测解析
 * = 102 投影 / 20 不投影，其中 7 项在 mc-heavy 走 cullMode 'none'/'transparent' 或不是方块
 * → 通道级已排除，故只声明 13 项）。
 */
function checkShadowCastContract() {
  // mc-lite isShadowEnabled:false 中落在 opaque/cutout 通道的 13 项（唯一权威清单）
  const EXPECTED_NO_CAST = new Set([
    'cloud', 'flower', 'short_grass', 'allium', 'azure_bluet', 'dead_bush',
    'oxeye_daisy', 'red_mushroom', 'vine', 'lilypad',
    'playground_block', 'playground_center_block', 'hanging_lamp',
  ]);

  // ① 声明侧：shadowCast:false 的集合必须恰好等于期望清单
  const declared = BLOCKS.filter((b) => b.shadowCast === false).map((b) => b.name);
  const declaredSet = new Set(declared);
  const missing = [...EXPECTED_NO_CAST].filter((n) => !declaredSet.has(n));
  const extra = declared.filter((n) => !EXPECTED_NO_CAST.has(n));
  if (missing.length) {
    failures.push(`[阴影投射] 应标 shadowCast:false 但未声明（会重新投影）：${missing.join(', ')}`);
  }
  if (extra.length) {
    failures.push(`[阴影投射] 多标了 shadowCast:false（不在 mc-lite 排除清单，会导致地形不投影）：${extra.join(', ')}`);
  }

  // ② 派生侧：期望清单里每项在 registry 表里必须是 0（castsShadow=false）
  for (const n of EXPECTED_NO_CAST) {
    const id = REGISTRY.idOf(n);
    if (id === undefined) { failures.push(`[阴影投射] 期望清单里的方块不存在：${n}`); continue; }
    if (REGISTRY.castsShadow(id)) {
      failures.push(`[阴影投射] ${n} 声明了 shadowCast:false 但 registry.castsShadow 仍为 true（表未写入）`);
    }
  }

  // ③ 临界对照：地形主体必须仍投影（防止把整表当恒假判据）
  for (const n of ['stone', 'grass', 'dirt', 'wood', 'leaves']) {
    if (!REGISTRY.castsShadow(REGISTRY.idOf(n))) {
      failures.push(`[阴影投射] 地形主体 ${n} 不应投影（castsShadow 误为 false）`);
    }
  }

  if (!failures.some((f) => f.startsWith('[阴影投射]'))) {
    infos.push(`[阴影投射] ${declared.length} 项不投影（对齐 mc-lite isShadowEnabled:false 口径）：${declared.join(', ')}`);
  }
}

// ---------------------------------------------------------------- [11] 创造台契约

/**
 * [创造台] 契约（M9）：两个平台方块名在 registry 内 + 都标了 `indestructible` +
 * 都不在背包物品集合内。
 *
 * ⚠️ **三项必须同时成立**（规格 §1：登记与移出背包必须成对做）：
 *   - 漏标 `indestructible` → 「平台本体不可被玩家/枪械/TNT 破坏」门控静默失效；
 *   - 留在背包 → 玩家能选中并放置平台方块，而它挖不掉、TNT 也炸不掉（撕裂状态）；
 *   - 名字拼错 → 前两条门控都作用在不存在的方块上（与「拼错的排除项静默无效」同类）。
 * 与 [10] `[不可破坏]` 环节的关系：那边校验「声明 ↔ 表」双向一致（不关心是谁），
 * 本环节钉住**创造台这两项本身**必须登记且必须移出背包 —— 两者不重叠。
 */
function checkPlaygroundContract() {
  // ⚠️ 方块名取自 config 常量（不硬编码字面量）—— 两侧漂移会让门禁检查一个 service 不用的名字
  const names = [PLAYGROUND_BLOCK, PLAYGROUND_CENTER_BLOCK];
  const allNames = new Set(REGISTRY.all().map((e) => e.name));
  const items = buildItemNames(REGISTRY);
  for (const n of names) {
    if (!allNames.has(n)) failures.push(`[创造台] "${n}" 不在 registry 内（平台方块名拼错）`);
    if (!REGISTRY.isIndestructible(REGISTRY.idOf(n))) {
      failures.push(`[创造台] "${n}" 未标 indestructible（玩家/枪械/TNT 能破坏平台本体）`);
    }
    if (items.includes(n)) {
      failures.push(`[创造台] "${n}" 在背包物品集合内（玩家能放置不可破坏的平台方块 → 撕裂状态）`);
    }
  }
  // 平台尺寸契约：service 写入的格数与 config 单一权威一致（mc-lite `playgroundSize=54` 口径）
  if (PLAYGROUND.size !== 54) {
    failures.push(`[创造台] PLAYGROUND.size = ${PLAYGROUND.size} ≠ 54（mc-lite 口径）`);
  }
  // 锚点 kind 契约（与 service 的 hydrate 扫库同源）：拼错则重启后恢复不到创造台
  if (PLAYGROUND_KIND !== 'playground') {
    failures.push('[创造台] PLAYGROUND_KIND ≠ "playground"（hydrate 扫库会对不上 → 重启后创造台消失）');
  }
  // 净空与高度跨度：clearance(10) 必须小于 heightSpan(20) —— 否则玩家站在自己雕的高处
  // 就能关掉脚下平台（规格 §2.2 的 PLAYER_IN_PLAYGROUND 判据）
  if (!(PLAYGROUND.clearance < PLAYGROUND.heightSpan)) {
    failures.push(`[创造台] clearance(${PLAYGROUND.clearance}) ≥ heightSpan(${PLAYGROUND.heightSpan})`
      + '（玩家站在净空区高处时关闭判据会失效）');
  }
  if (!failures.some((f) => f.startsWith('[创造台]'))) {
    infos.push(`[创造台] 平台 ${PLAYGROUND.size}×${PLAYGROUND.size} = ${PLAYGROUND.size ** 2} 格`
      + ` + ${names.length} 项已登记 indestructible 并移出背包（锚点 kind="${PLAYGROUND_KIND}"）`);
  }
}

// ---------------------------------------------------------------- [12] 矿车契约

/**
 * [矿车] 契约：
 * ① `mine_cart` 在背包物品集合内（可放置玩法物品，不得被移出）；
 * ② `TRACK_BLOCK_TYPES` 两项都在 registry 内且在背包内（玩家要能铺轨）；
 * ③ 铁轨类型集合的单一权威 = config（本门禁 import config 比对，防两处漂移）。
 *
 * ⚠️ 与 [11] `[创造台]` 环节方向相反：创造台两项**必须不在**背包（放得出来挖不掉 →
 * 撕裂状态），矿车与铁轨**必须在**背包（拿不到就玩不了）—— 两者不重叠。
 * 名字拼错的后果是**静默的**：`isTrackBlock` 查不到 id → 移动系统的 `hasTrackAt`
 * 恒 false → 车放得出来但激活即拒（`alignToTrack` 返回 null），肉眼只见「车不动」。
 */
function checkMinecartContract() {
  const items = buildItemNames(REGISTRY);
  if (!items.includes(MINECART_ITEM)) {
    failures.push(`[矿车] "${MINECART_ITEM}" 不在背包物品集合内（玩家无法拿到矿车）`);
  }
  const allNames = new Set(REGISTRY.all().map((e) => e.name));
  for (const name of TRACK_BLOCK_TYPES) {
    if (!allNames.has(name)) failures.push(`[矿车] 铁轨 "${name}" 不在 registry 内（拼错）`);
    if (!items.includes(name)) failures.push(`[矿车] 铁轨 "${name}" 不在背包内（玩家无法铺轨）`);
  }
  if (!failures.some((f) => f.startsWith('[矿车]'))) {
    infos.push(`[矿车] ${MINECART_ITEM} 在背包 + 铁轨 ${TRACK_BLOCK_TYPES.join('/')} 可放置`);
  }
}

// ---------------------------------------------------------------- [14] 天空盒资源

/**
 * [天空盒] 契约：清单是唯一权威（`src/render/sky-config.js`），两套 × 六面必须都在磁盘上。
 *
 * 缺一张的后果是**静默的**：`CubeTextureLoader` 把缺失面的 onError 吞掉 → 用空白面填
 * → 天空出现一块纯黑/纯灰，不报错、不阻断启动（与结构 JSON 缺失被吞成空结构同类）。
 * 故只能静态断言 —— 浏览器里跑得起来不代表资源齐全。
 *
 * ⚠️ 主流程是逐个显式调用 —— 漏了本行则门禁永不执行（本仓已因此出过两次事故）。
 */
function checkSkyboxAssets() {
  const { SKY_FACE_FILES, SKY_SETS } = SKYBOX;
  let missing = 0;
  for (const [name, dir] of Object.entries(SKY_SETS)) {
    for (const face of SKY_FACE_FILES) {
      const rel = path.posix.join(dir, face);
      if (!fs.existsSync(path.join(ROOT, rel))) {
        failures.push(`[天空盒] ${name} 缺面：${rel}`);
        missing++;
      }
    }
  }
  if (!missing) {
    // 路径从清单派生（不写字面量）：v1.71 加第三套 dusk 时，这里曾只列两套 → 信息行与实际不符。
    infos.push(`[天空盒] ${Object.keys(SKY_SETS).length} 套 × ${SKY_FACE_FILES.length} 面完整（${Object.values(SKY_SETS).join(' / ')}）`);
  }
}

/**
 * [夜空] 契约（v1.60）：夜空贴图是**烘焙产物**，必须与当前烘焙参数一致。
 *
 * 为什么需要：夜空六面已不是 mc-lite 原图，而是由 `tools/bake-night-sky.mjs` 在**方向空间**
 * 加权重采样生成的结果（原图六面各自独立生成，12 条边平均 RMS 落差 **41.09** → 游戏里能看到
 * 笔直暗线；烘焙后 **1.89**，与白天基准同量级）。
 *
 * 与图标/丧尸头部同一条失效路径：改了 `tools/night-sky-fingerprint.mjs` 的参数却忘跑
 * `npm run nightsky` → 贴图**静默过期**（仍渲染旧图案，肉眼看不出）。指纹是精确判定。
 *
 * ⚠️ **不用颜色/接缝做门禁**：node 侧没有 JPEG 解码器（只有 pngjs），读不了 .jpg 像素。
 * 接缝本身由 `tests/night-sky-seam.spec.mjs` 在浏览器里实测（那里能解码）。
 * ⚠️ 主流程是逐个显式调用 —— 漏了本行则门禁永不执行（本仓已因此出过两次事故）。
 */
async function checkNightSkyFreshness() {
  const { NIGHT_SKY_FINGERPRINT_JSON, nightSkyFingerprint } = await import('./night-sky-fingerprint.mjs');
  const jsonPath = path.join(ROOT, NIGHT_SKY_FINGERPRINT_JSON);
  if (!fs.existsSync(jsonPath)) {
    failures.push(`[夜空] 缺指纹文件 ${NIGHT_SKY_FINGERPRINT_JSON}（跑 npm run nightsky）`);
    return;
  }
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch {
    failures.push(`[夜空] ${NIGHT_SKY_FINGERPRINT_JSON} 不是合法 JSON（重跑 npm run nightsky）`);
    return;
  }
  const expected = nightSkyFingerprint();
  if (meta.fingerprint !== expected) {
    failures.push(
      `[夜空] 贴图已过期：指纹不匹配（烘焙时 "${meta.fingerprint}" vs 当前 "${expected}"）→ 跑 npm run nightsky`,
    );
    return;
  }
  infos.push('[夜空] 烘焙指纹匹配（无缝立方图当前）');
}

// ---------------------------------------------------------------- [高台地带] 契约（Cloudland Tarn Zone）

/**
 * [高台地带] 契约：烘焙输入 / 35 个产物 / 映射表 / 渲染通道 / 台顶材质五者互相对得上。
 *
 * 为什么这些必须自动化（每一条都对应一种【肉眼看不出来】的失效）：
 *   ① 指纹不匹配 → 改了映射表却没重烘 → 世界渲染的是旧配色
 *   ② palette 含未注册方块 → `makeColumnSetter` 静默 return → 那格变 air（台身出现空洞）
 *   ③ palette 跑进 cutout/transparent → 每格顶点成本约 ×3 → 撞 §4.10 容量预算
 *   ④ 台顶不是 grass 而是 moss → 用户明确要的改动肉眼像没做
 *   ⑤ 少了一个变体 → 对应那座高台静默不出现（`rasterizeStructure` 拿到空 blocks 直接 return）
 */
async function checkCloudlandTarnZone() {
  const fp = await import('./cloudland-kit-fingerprint.mjs');
  const fail = (m) => failures.push(`[高台地带] ${m}`);

  if (!fs.existsSync(fp.SCHEM_PATH)) {
    fail('缺烘焙输入 assets/cloudland/src/cloudlandassets_1.20.schem（应与仓库同存）');
    return;
  }

  // ① 指纹：烘焙时写进伴随 meta，门禁重算比对（防「改了映射表没重烘」）
  if (!fs.existsSync(fp.KIT_META)) {
    fail('缺 assets/structures/cloudland_kit.meta.json（跑 npm run tarn）');
    return;
  }
  const cur = fp.cloudlandKitInputFingerprint();
  let kitMeta;
  try { kitMeta = JSON.parse(fs.readFileSync(fp.KIT_META, 'utf8')); }
  catch { fail('cloudland_kit.meta.json 不是合法 JSON（重跑 npm run tarn）'); return; }
  if (kitMeta.fingerprints?.input !== cur.input) {
    fail(`产物已过期：指纹不匹配（烘焙时 "${kitMeta.fingerprints?.input}" vs 当前 "${cur.input}"）→ 跑 npm run tarn`);
  }

  // ② 变体数量契约（少一个 → 那座高台静默不出现）
  const FAMILY_EXPECT = { tarn: 11, arch: 5, spire: 7, giantCloud: 12 };
  for (const [fam, want] of Object.entries(FAMILY_EXPECT)) {
    const got = fp.KIT_VARIANTS[fam].length;
    if (got !== want) fail(`${fam} 变体 ${got} ≠ ${want}`);
  }

  const allVariants = [
    ...fp.KIT_VARIANTS.tarn.map((v) => ['tarn', v]),
    ...fp.KIT_VARIANTS.arch.map((v) => ['arch', v]),
    ...fp.KIT_VARIANTS.spire.map((v) => ['spire', v]),
    ...fp.KIT_VARIANTS.giantCloud.map((v) => ['giantCloud', v]),
  ];

  // ③ 35 个产物：存在 / 格数 / bbox / 最低点归一化 / palette 合法性与通道
  let checkedVariants = 0;
  const brickishAll = [];
  const woodyAll = [];
  const mossInTarn = [];
  // v1.94：高台族不许再出现 mossy_stone / iron_ore（用户 2026-10-29：
  // 「高台里的 mossy 方块和 iron_ore 方块都换成 light_gray_cloth」）。
  // ⚠️ 判据放在 **palette** 而不是 BLOCK_MAP：palette 是产物的实际内容 ——
  //    改 BLOCK_MAP 却忘跑 `npm run tarn` 时 palette 仍是旧的，这条会红（抓静默过期）。
  const forbiddenInTarn = [];
  // v1.94：巨型云的材料改写（用户 2026-10-29）—— deepslate 整朵换 clay、
  // 腰线以上裸露岩石换 cloud、snow/sky_stone 不变。判据落在**产物内容**上，
  // 改 bake 脚本却忘跑 `npm run tarn` 时会红。
  const cloudRestyleBad = [];
  for (const [family, base] of allVariants) {
    const p = path.join(fp.KIT_JSON_DIR, `${base}.json`);
    if (!fs.existsSync(p)) { fail(`缺产物 ${base}.json（跑 npm run tarn）`); continue; }
    let json;
    try { json = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { fail(`${base}.json 不是合法 JSON`); continue; }
    if (!Array.isArray(json.palette) || !Array.isArray(json.blocks) || json.blocks.length % 4 !== 0) {
      fail(`${base}.json 格式错（应为 {version, palette[], blocks[x,y,z,pi,...]}）`); continue;
    }
    const n = json.blocks.length / 4;
    const M = fp.KIT_METRICS[base];
    if (!M) { fail(`KIT_METRICS 缺 ${base} 的条目`); continue; }
    if (n !== M.blocks) fail(`${base} 格数 ${n} ≠ KIT_METRICS.blocks ${M.blocks}`);

    // bbox + 最低点归一化
    let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity, mnz = Infinity, mxz = -Infinity;
    for (let i = 0; i < json.blocks.length; i += 4) {
      const x = json.blocks[i], y = json.blocks[i + 1], z = json.blocks[i + 2];
      if (x < mnx) mnx = x; if (x > mxx) mxx = x;
      if (y < mny) mny = y; if (y > mxy) mxy = y;
      if (z < mnz) mnz = z; if (z > mxz) mxz = z;
    }
    if (mxx - mnx + 1 !== M.width) fail(`${base} 宽 ${mxx - mnx + 1} ≠ ${M.width}`);
    if (mxy - mny + 1 !== M.height) fail(`${base} 高 ${mxy - mny + 1} ≠ ${M.height}`);
    if (mxz - mnz + 1 !== M.depth) fail(`${base} 深 ${mxz - mnz + 1} ≠ ${M.depth}`);
    if (mny !== 1) fail(`${base} 最低点 y=${mny} ≠ 1（归一化失败）`);

    // palette：全部在 registry + 通道判据（glass_block 是唯一合法的 transparent 例外）
    for (const name of json.palette) {
      const id = REGISTRY.idOf(name);
      if (id === undefined) { fail(`${base} 含未注册方块 "${name}"（那格会变成 air）`); continue; }
      // ⚠️ **v1.89 起没有任何例外**：原本紫晶柱的 `purple_stained_glass_pane → glass_block`
      // （180 格 transparent）已按用户 2026-10-27 裁定改为 opaque 的 `amethyst` ——
      // 「把高台地图里所有方块中的玻璃透明方块都去掉，换成实心方块……全都是不透明的实心方块」。
      // 高台地带因此与 transparent 通道**完全无关**。
      if (REGISTRY.cullTable[id] !== 0) fail(`${base} 的 "${name}" 不在 opaque 通道（顶点成本约 ×3）`);
    }
    brickishAll.push(...json.palette.filter((x) => /brick/i.test(x)));
    woodyAll.push(...json.palette.filter((x) => /log|wood|plank|acacia|oak|birch/i.test(x)).map((x) => `${base}:${x}`));
    if (family === 'tarn' && json.palette.includes('moss')) mossInTarn.push(base);
     if (family === 'tarn') {
       for (const bad of ['mossy_stone', 'iron_ore']) {
         if (json.palette.includes(bad)) forbiddenInTarn.push(`${base}:${bad}`);
       }
     }
     if (family === 'giantCloud') {
       // deepslate 必须整朵消失（换成 clay）
       if (json.palette.includes('deepslate')) cloudRestyleBad.push(`${base}:deepslate`);
       // v1.95：debris 必须整朵消失（换成 sky_stone）
       if (json.palette.includes('debris')) cloudRestyleBad.push(`${base}:debris`);
       // snow / sky_stone 必须仍在（用户明说保持不变）—— 若被换成 cloud 说明规则写错了
       const st = json.stride ?? 4;
       const widthAt = new Map();
       const rows = [];
       for (let i = 0; i < json.blocks.length; i += st) {
         const y = json.blocks[i + 1];
         rows.push([y, json.blocks[i + st - 1]]);
         widthAt.set(y, (widthAt.get(y) ?? 0) + 1);
       }
       let waistY = 1, waistW = -1;
       for (const [y, n] of [...widthAt].sort((a, b) => a[0] - b[0])) if (n > waistW) { waistW = n; waistY = y; }
       const ROCK = new Set(['stone', 'marble', 'stone_diorite', 'smooth_stone', 'smooth_stone_1', 'calcite']);
       let above = 0;
       for (const [y, pi] of rows) {
         if (y <= waistY) continue;
         if (ROCK.has(json.palette[pi])) above++;
       }
       if (above > 0) cloudRestyleBad.push(`${base}:腰线上残留岩石 ${above} 格`);
     }
    checkedVariants++;
  }

  // ④ 无砖块族 / 无木族（v1.77 用户裁定的名字模式判据，不硬编码清单）
  const brickish = [...new Set(brickishAll)];
  if (brickish.length > 0) fail(`palette 含砖块族：${brickish.join(', ')}`);
  const woody = [...new Set(woodyAll)];
  if (woody.length > 0) fail(`palette 含木族：${woody.join(', ')}`);

  // ⑤ 台顶必须是 grass 不是 moss（用户裁定；漏改时 11 个产物的台顶仍是苔藓）
  if (mossInTarn.length > 0) {
    fail(`这些高台的 palette 里还有 moss（台顶必须是 grass）：${mossInTarn.join(', ')}`);
  }
  // v1.94：高台里不许有 mossy_stone / iron_ore（应已换成 light_gray_cloth）
  if (forbiddenInTarn.length > 0) {
    fail(`这些高台的 palette 里还有 mossy_stone/iron_ore（应换成 light_gray_cloth）：${forbiddenInTarn.join(', ')}`);
  }
  // v1.94：巨型云材料改写不成立
  if (cloudRestyleBad.length > 0) {
    fail(`巨型云材料改写不成立（deepslate→clay / debris→sky_stone / 腰线上岩石→cloud）：${cloudRestyleBad.join(', ')}`);
  }

  // ⑥ 出现口径与几何的自洽（v1.90）—— 这一组不依赖烘焙产物，钄的是**代码常量**之间的关系
  //    （改一个而忘改另一个时，产物指纹完全不变，上面 ①~⑤ 全部恒绿）。
  await checkTarnPlacementRules(fail);
  // ⑦ 斑块边界必须用不可分离噪声（v1.93）—— 缺陷在方块层面看不出来，只能静态钉
  checkTarnBlobNoise();

  // ⚠️ **成功行的条件必须涵盖本函数全部判据**，否则失败时仍会打印一条 ✓
  // （既有教训：`[高台]` 曾同时出现「✗ 含砖块族」与「✓ …无砖无木」，读者只看 ✓ 就误判）。
  const ok = failures.every((f) => !f.startsWith('[高台地带]'))
    && brickish.length === 0 && woody.length === 0 && mossInTarn.length === 0
     && forbiddenInTarn.length === 0 && cloudRestyleBad.length === 0
    && checkedVariants === allVariants.length;
  if (ok) {
    infos.push(`[高台地带] ${checkedVariants} 个产物（11 高台 + 5 拱洞 + 7 紫晶柱 + 12 巨型云）/ 台顶全 grass / 无砖无木 / 指纹匹配 / 出现口径与几何自洽`);
  }
}

/**
 * [台地材质] 斑块边界必须用**不可分离噪声**（v1.93）。
 *
 * **缺陷形态**：`gen/noise.js` 的 `noise()` 是 `sin((x+seed)·s)·2 + cos((z+seed)·s)·2`
 * —— x 项与 z 项**可分离相加**，等值线必然是直线族（斜线/十字）。
 * 用它做草斑/石斑的掩码时，边界是一条条直尺切出来的斜线，
 * 用户报告「草地方块的边界过于横平竖直」（2026-10-29）。
 *
 * **为什么必须静态门禁**：这个缺陷**在方块层面完全看不出来** ——
 * 草、石、黏土的种类与占比都对，只有「边界是直的」这一条观感不对。
 * 而且浏览器单测的曲率类度量**不可靠**（实测：注入可分离噪声后曲率反而更高，
 * 因为斜线族的边界位置逐行跳变）。可分离性是该缺陷的**充要特征**，但
 * 布尔掩码阈值化后会破坏它（实测方差 0.67 vs 0.24，区分度不够），
 * 只有**看源码用的是哪个函数**才能可靠判定。
 *
 * 判据 = `tarnSurfaceBlock` 函数体内出现 `blobNoise(` 调用，且草斑那一层
 * **不得**直接调用可分离的 `noise(` 做掩码。
 */
function checkTarnBlobNoise() {
  const p = path.join(ROOT, 'src/gen/structures/tarn-terrain.js');
  const src = fs.readFileSync(p, 'utf8');
  const start = src.indexOf('export function tarnSurfaceBlock');
  if (start < 0) {
    failures.push('[台地材质] 找不到 tarnSurfaceBlock（源码结构变了，本门禁失效）');
    return;
  }
  const end = src.indexOf('\n}', start);
  const body = src.slice(start, end);
  if (!body.includes('blobNoise(')) {
    failures.push('[台地材质] tarnSurfaceBlock 没有用 blobNoise —— 草斑/石斑边界会变成直线族');
  }
  // 草斑那一层若退回可分离的 `noise(`，边界立刻变直
  if (/TARN_PLOT_SALT,\s*TARN_PLOT_SCALE\s*\)/.test(body) && /noise\(wx, wz, seed \+ TARN_PLOT_SALT/.test(body)) {
    failures.push('[台地材质] 草斑掩码用了可分离的 noise()（边界会是直线，应用 blobNoise）');
  }
}

/**
 * [高台地带] 的出现口径与几何自洽（v1.90，不依赖烘焙产物）。
 *
 * 钉五件在**方块与产物层面都看不出来**的失效：
 *   ① 地带圆与 City bounds 重叠 —— 用户报告的现象。改造前实测 8 个 seed 里 6 个有重叠（最深 112 格）。
 *   ② 地带圆越 region 边界 —— 地带半边永久消失（相邻 region 不为它算候选）。
 *   ③ 缓坡宽度与平台半径漂移 —— 形态是「平台比地带还大」或「缓坡宽度对不上」。
 *   ④ 装饰件外延超出平台 —— 坐座落在缓坡上，缓坡地形被它的底座穿。
 *   ⑤ 地带密度跑飞 —— 变成「到处都是」或「走半天找不到」。（旧版：每 3.4 region 一座）
 *
 * @param {(msg: string) => void} fail
 */
async function checkTarnPlacementRules(fail) {
  const tz = await import('../src/gen/structures/tarn-zone.js');
  const { REGION_SIZE, CITY_REGION } = await import('../src/gen/structures/region-config.js');
  const { getCityBoundsForSeed } = await import('../src/gen/structures/city-layout.js');

  // ① 地带圆不越 region 边界（不靠数值巧合，靠不等式）
  if (tz.TARN_ZONE_RADIUS + 2 > REGION_SIZE / 2) {
    fail(`地带半径 ${tz.TARN_ZONE_RADIUS} + 2 > region 半宽 ${REGION_SIZE / 2} —— 地带半边会永久消失`);
  }
  // ② 三者自洽
  if (tz.TARN_PLATFORM_RADIUS + tz.TARN_SLOPE_WIDTH !== tz.TARN_ZONE_RADIUS) {
    fail(`平台半径 ${tz.TARN_PLATFORM_RADIUS} + 缓坡 ${tz.TARN_SLOPE_WIDTH} ≠ 地带半径 ${tz.TARN_ZONE_RADIUS}`);
  }

  // ③ 地带永不与 City 重叠。
  //
  // ⚠️ **seed 集合必须足够大**：去掉城市判据后，单个 seed 的 ±10 窗口里**平均只有 1.07 个**
  //    重叠（实测 seed 1..300：只有 **15%** 的 seed 会出现重叠）。拿 3~4 个 seed 做门禁时
  //    那条判据 **恒绿**（实测 12 个通用 seed 里只有 seed 888 命中 1 个）→ 门禁形同虚设。
  //    所以这里固定扫 **seed 1..40 × ±8**（实测 ~300ms，命中 150~200 个地带，
  //    “去掉判据”时会出现多个重叠）。
  let overlapped = 0;
  const firstOverlaps = [];
  for (let seed = 1; seed <= 40; seed++) {
    const city = getCityBoundsForSeed(seed);
    for (let rx = -8; rx <= 8; rx++) for (let rz = -8; rz <= 8; rz++) {
      if (!tz.isTarnZone(rx, rz, seed)) continue;
      const { cx, cz } = tz.tarnZoneCenter(rx, rz);
      if (tz.circleRectGap(cx, cz, tz.TARN_ZONE_RADIUS, city) <= 0) {
        overlapped++;
        if (firstOverlaps.length < 5) firstOverlaps.push(`seed${seed}(${rx},${rz})`);
      }
    }
  }
  if (overlapped > 0) {
    fail(`${overlapped} 个地带圆与 City bounds 重叠（用户明确要求：不得重叠）：${firstOverlaps.join(' ')}`);
  }
  // ④ CITY_REGION 恒不是地带（城市是全世界唯一）
  for (let seed = 1; seed <= 40; seed++) {
    if (tz.isTarnZone(CITY_REGION.X, CITY_REGION.Z, seed)) fail(`seed ${seed} 的 CITY_REGION 掷到了地带`);
  }
  // ⑤ 装饰件与高台的四角外延 ≤ 平台半径（否则坐座坐落在缓坡上）
  const reach = (v, ring, ang) => Math.max(...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => Math.hypot(
    ring * Math.cos(ang) + sx * v.halfX, ring * Math.sin(ang) + sz * v.halfZ))));
  const layout = findLayout(tz);
  if (layout) {
    for (const t of [...layout.tarns, ...layout.decos]) {
      const r = reach(t, t.ring, t.ang);
      if (r > layout.platformRadius) {
        fail(`${t.variant} 四角最远 ${r.toFixed(1)} 超出平台半径 ${layout.platformRadius}（坐座会落在缓坡上）`);
      }
    }
  } else {
    fail('扫不到任何一个地带 region —— 出现口径可能被改成了永不命中');
  }
  // ⑥ 密度不跑飞（v1.92 实测 8 seed：每 7.4~8.3 region 一座；带宽 6~14）
  //    ⚠️ 下界 6 抓住「变回每 3 个一座」（实测 3.0~3.2）；
  //       上界 14 抓住「退回只有 PLAINS」（实测 13.6~23.1）。
  for (const seed of [12345, 4, 7]) {
    let hits = 0, total = 0;
    for (let rx = -12; rx <= 12; rx++) for (let rz = -12; rz <= 12; rz++) {
      total++;
      if (tz.isTarnZone(rx, rz, seed)) hits++;
    }
    const per = total / Math.max(1, hits);
    if (!(per >= 6 && per <= 14)) {
      fail(`seed ${seed} 每 ${per.toFixed(1)} region 一座地带（实测区间 7.4~8.3，允许 6~14）`);
    }
  }

  // ⑦ 材质分区的骨架（v1.91，用户 2026-10-28 设计）
  //
  // ⚠️ **这一组钄的是「常量之间能自洽」**（改一个而忘改另一个时，方块与产物层面都看不出）：
  //    冰带 < 雪环 < 草斑区界 < 平台 < 地带，且四个方块名在 registry 里都真实存在。
  //    分区占比与渗透带的行为由浏览器单测（`test-tarn-terrain.js`）验，那里能真跑整形。
  const layout2 = findLayout(tz);
  if (layout2) {
    const { TARN_ICE_RADIUS, TARN_SNOW_RADIUS } = tz;
    if (!(TARN_ICE_RADIUS > 0 && TARN_ICE_RADIUS < TARN_SNOW_RADIUS)) {
      fail(`材质带半径顺序不对：冰 ${TARN_ICE_RADIUS} ≮ 雪环 ${TARN_SNOW_RADIUS}`);
    }
    if (!(TARN_SNOW_RADIUS < layout2.platformRadius)) {
      fail(`雪环外缘 ${TARN_SNOW_RADIUS} ≥ 平台半径 ${layout2.platformRadius} —— 草斑带被挤成负宽度`);
    }
    // 四个材质方块必须都在 registry 里（不在的话 `makeColumnSetter` 会静默 return → 那格变 air）
    for (const n of ['ice', 'snow', 'clay', 'grass', 'stone']) {
      if (REGISTRY.idOf(n) === undefined) fail(`材质分区的方块 "${n}" 未注册（会静默变 air）`);
    }
    // 材质方块必须全部走 opaque 通道（cutout/transparent 会让 1 万格方块顶点 ×3 → 撞预算）
    // ⚠️ `registry` 没暴露 `cullModeOf`，直接用 `cullTable`（0 = opaque，见 `CULL_MODES`）。
    for (const n of ['ice', 'snow', 'clay']) {
      const id = REGISTRY.idOf(n);
      if (id !== undefined && REGISTRY.cullTable[id] !== 0) {
        fail(`材质方块 "${n}" 不在 opaque 通道（cullTable=${REGISTRY.cullTable[id]}）—— 顶点预算会炸`);
      }
    }
  }
}

/** 扫一个确实存在的地带布局（供上面那条几何判据用） */
function findLayout(tz) {
  for (const seed of [12345, 4, 7]) {
    for (let rx = -8; rx <= 8; rx++) for (let rz = -8; rz <= 8; rz++) {
      // ⚠️ **必须先判 `isTarnZone`**：`computeTarnZone` 对**任何** region 都返回布局
      //    （它只做几何计算，不做「是不是地带」的判定）—— 直接用它会让下面的几何判据
      //    检到一个根本不存在的地带（观感上「门禁绿着但什么都没验」）。
      if (!tz.isTarnZone(rx, rz, seed)) continue;
      return tz.computeTarnZone(rx, rz, seed);
    }
  }
  return null;
}

// ---------------------------------------------------------------- [巨树] 契约（Giant Trees Epic）

/**
 * [巨树] 契约：8 个 `giant_*` 方块声明、烘焙产物（trees.json）、贴图三者必须互相对得上。
 *
 * 钉的失效路径（每条都实测注入过，见 plan Task 8 Step 3）：
 *   ① 树叶通道或剔除语义写错 → 两种错法各自静默：cullMode 改回 opaque 则 alphaTest=0、
 *      **镂空 alpha 被忽略**（叶面变成不透光的实心块，不报错）；漏写 opaque:true 则
 *      opaqueTable 变 0 → 叶-叶共享面不再互剔，实测同一片 8³ 叶团顶点 1584 → **12316（×7.78）**；
 *   ② 树叶误写 shadowCast:false → 与既有 leaves 口径不一致
 *      （用户裁决：巨树叶**投影**；`[阴影投射]` 的 13 项清单也不含任何树叶）；
 *   ③ palette 里出现未注册的名字 → makeColumnSetter 对未注册名**静默跳过** → 该方块变 air，肉眼只觉得「树有洞」；
 *   ④ 声明了却没人用的 giant_*（死方块）/ 在用却没声明（同 ③）；
 *   ⑤ 8 个方块没进 HIDDEN_FROM_INVENTORY → 玩家能在背包里选中并放出一块孤零零的树干；
 *   ⑥ 烘焙输入（.schem）或映射表改了却没重烘焙 → 产物静默过期；
 *   ⑦ 贴图缺失/尺寸错/出现近黑像素（opaque 通道忽略 alpha，孔洞处直接露出 RGB → 黑点）。
 * ⚠️ 主流程是逐个显式调用 —— 漏了本行则门禁永不执行（本仓已因此出过两次事故）。
 */
async function checkGiantTrees() {
  const fp = await import('./giant-trees-fingerprint.mjs');
  const before = failures.length;
  const fail = (m) => failures.push(`[巨树] ${m}`);

  // ① 烘焙输入（入库）与产物
  if (!fs.existsSync(fp.SCHEM_PATH)) fail(`烘焙输入缺失 ${path.relative(ROOT, fp.SCHEM_PATH)}（.schem 入库，缺失 = 仓库损坏）`);
  if (!fs.existsSync(fp.TREES_JSON) || !fs.existsSync(fp.TREES_META)) {
    fail('缺 assets/giant-trees/trees.json 或 trees.meta.json（跑 npm run gianttrees）');
    return;
  }
  let meta, trees;
  try {
    meta = JSON.parse(fs.readFileSync(fp.TREES_META, 'utf8'));
    trees = JSON.parse(fs.readFileSync(fp.TREES_JSON, 'utf8')).trees;
  } catch { fail('trees.json / trees.meta.json 不是合法 JSON（重跑 npm run gianttrees）'); return; }

  // ② 指纹（入库 .schem 内容 + 全部烘焙参数）
  const cur = fp.giantTreesInputFingerprint();
  if (meta.fingerprints?.input !== cur.input) {
    fail(`产物已过期：指纹不匹配（烘焙时 "${meta.fingerprints?.input}" vs 当前 "${cur.input}"）→ 跑 npm run gianttrees`);
  }

  // ③ 变体数与调色板
  let variantCount = 0;
  for (const [family, pads] of Object.entries(fp.TREE_FAMILIES)) {
    const list = trees[family] || [];
    if (list.length !== pads.length) fail(`族 ${family} 变体数 ${list.length} ≠ TREE_FAMILIES 的 ${pads.length}`);
    for (const v of list) {
      variantCount++;
      if (JSON.stringify(v.palette) !== JSON.stringify(fp.FAMILY_PALETTES[family])) fail(`族 ${family} 的 palette 与 FAMILY_PALETTES 不一致（trees.json 被手改？）`);
    }
  }
  for (const f of Object.keys(trees)) if (!(f in fp.TREE_FAMILIES)) fail(`trees.json 含未知族 "${f}"`);

  // ④ palette ↔ giant_* 声明双向闭包；palette 全部在 registry
  const used = new Set();
  for (const list of Object.values(trees)) for (const v of list) for (const n of v.palette) used.add(n);
  const declared = BLOCKS.filter((b) => b.name.startsWith('giant_')).map((b) => b.name);
  for (const n of used) {
    if (REGISTRY.idOf(n) === undefined) fail(`palette 含未注册方块 "${n}"（makeColumnSetter 静默跳过 → 该格变 air）`);
    else if (!declared.includes(n)) fail(`在用的 palette 名 "${n}" 不是 giant_* 声明`);
  }
  for (const n of declared) if (!used.has(n)) fail(`声明了 ${n} 但没有任何变体使用（死方块）`);

  // ⑤ 树叶：cutout 通道（镂空）+ opaqueTable=1（面剔除）+ 必须投影
  //    ⚠️ 两套口径缺一不可：cullMode 选渲染通道（决定 alphaTest → 镂空与否），
  //    opaque 决定 opaqueTable（面剔除 / AO / blocklight / 炮塔 LOS）。
  for (const n of declared.filter((x) => x.endsWith('_leaves'))) {
    const def = BLOCKS.find((b) => b.name === n);
    const id = REGISTRY.idOf(n);
    if (def.cullMode !== 'cutout') fail(`"${n}" 的 cullMode=${def.cullMode}，必须是 cutout（opaque 通道 alphaTest=0 → 镂空 alpha 被忽略，叶面变实心块）`);
    if (def.opaque === false) fail(`"${n}" 显式 opaque:false，叶-叶共享面不再互剔（实测顶点 ×7.78）`);
    if (def.shadowCast === false) fail(`"${n}" 写了 shadowCast:false，巨树叶须投影（与 leaves 同口径）`);
    if (id !== undefined && !REGISTRY.castsShadow(id)) fail(`"${n}" 的 registry.castsShadow 为 false`);
    if (id !== undefined && REGISTRY.opaqueTable[id] !== 1) fail(`"${n}" 的 opaqueTable 不是 1（漏写 opaque:true → 叶-叶共享面不再互剔，顶点 ×7.78）`);
  }

  // ⑥ **必须在背包里**（2026-10-25 用户裁定，口径已反转）
  //
  // 历史：这条原本是「全部不进背包」，理由是「玩家能放出孤零零的树干/树叶」。
  // 用户 2026-10-25 明确要求「巨树烘焙的几个新的树叶方块也放到背包里」——
  // 那本来就是代玩家做决定：巨树方块是 `solid:true` + 有 faces-data 的普通可放置方块，
  // 玩家完全可以把它们当深色大方块盖东西。
  // ⚠️ **方向已反转，勿按旧口径改回**：现在“不在背包”才是缺陷（会与 `buildItemNames` 派生的
  // 物品集合不一致，而图标 manifest 是双向一致校验，一旦不同步会同时红两个门）。
  for (const n of declared) {
    if (HIDDEN_FROM_INVENTORY.includes(n)) fail(`"${n}" 在 HIDDEN_FROM_INVENTORY 里 —— 用户 2026-10-25 要求巨树方块进背包`);
    if (!buildItemNames(REGISTRY).includes(n)) fail(`"${n}" 不在物品集合（buildItemNames 派生自 registry − 排除集合）`);
  }

  // ⑦ 贴图：faces-data 里 procedural/giant_* 的 tile 必须有 16×16 PNG、无近黑像素；且目录里没有无人引用的 giant_* 孤儿
  const giantTiles = new Set();
  for (const n of declared) {
    const v = FACES_DATA[n];
    if (!v) { fail(`"${n}" 没有 faces-data 映射`); continue; }
    for (const t of (Array.isArray(v) ? v : [v])) if (t && t.startsWith('procedural/giant_')) giantTiles.add(t);
  }
  // ⑦a 树叶**必须有自己的 procedural 贴图**，不得复用普通方块的 tile。
  // 理由：孔洞密度是巨树专属的观感旋钮（比普通树叶更密）；共用 `leaves` tile 就改不了它
  // （改了会把普通树叶一起改掉）。这是「巨树叶必须独立烘焙」的契约。
  for (const n of declared.filter((x) => x.endsWith('_leaves'))) {
    const v = FACES_DATA[n];
    const arr = Array.isArray(v) ? v : [v];
    for (const t of arr) {
      if (t && !t.startsWith('procedural/giant_')) {
        fail(`"${n}" 的贴图 tile "${t}" 不是 procedural/giant_*（复用普通方块贴图 → 无法单独调孔洞密度，且改它会连普通树叶一起变）`);
      }
    }
  }
  for (const t of giantTiles) {
    const file = path.join(ROOT, 'assets', 'textures', `${t}.png`);
    if (!fs.existsSync(file)) { fail(`贴图缺失 ${t}.png（跑 node tools/bake-giant-textures.mjs）`); continue; }
    const png = PNG.sync.read(fs.readFileSync(file));
    if (png.width !== 16 || png.height !== 16) fail(`${t}.png 尺寸 ${png.width}×${png.height} ≠ 16×16`);
    for (let i = 0; i < png.width * png.height; i++) {
      const o = i * 4;
      if (0.2126 * png.data[o] + 0.7152 * png.data[o + 1] + 0.0722 * png.data[o + 2] < 40) { fail(`${t}.png 像素 ${i} 近黑`); break; }
    }
  }

  // ⑦b 树叶（不是树干）的孔洞率必须落在巨树专属区间内。
  // 钉的失效路径：误把 `holeRatio` 删掉 / 烘成了源图的 31% → 观感倒退到「太稀」（本次需求的起因）。
  // 区间取 5%~25%：实测交付值 38/256 = 14.8%，源图未压缩为 31%、完全无孔洞为 0%。
  // ⚠️ 只有**树叶**受这个区间约束（树干无镂空概念，孔洞数恒 0）。
  let leafHoleNote = '';
  for (const t of [...giantTiles].filter((x) => x.endsWith('_leaves'))) {
    const file = path.join(ROOT, 'assets', 'textures', `${t}.png`);
    if (!fs.existsSync(file)) continue;
    const png = PNG.sync.read(fs.readFileSync(file));
    let holes = 0;
    const total = png.width * png.height;
    for (let i = 0; i < total; i++) if (png.data[i * 4 + 3] < 77) holes++;   // alphaTest 0.3 判据
    const ratio = holes / total;
    leafHoleNote = `${(ratio * 100).toFixed(1)}%`;
    if (ratio < 0.05 || ratio > 0.25) {
      fail(`${t}.png 孔洞率 ${(ratio * 100).toFixed(1)}%（应 5%~25%）—— 太小像实心色板、太接近源图 31% 就回到「叶冠太稀」`);
    }
  }
  const procDir = path.join(ROOT, 'assets', 'textures', 'procedural');
  for (const f of fs.readdirSync(procDir).filter((x) => x.startsWith('giant_') && x.endsWith('.png'))) {
    if (!giantTiles.has(`procedural/${f.replace(/\.png$/, '')}`)) fail(`孤儿贴图 procedural/${f}（没有任何 giant_* 方块引用）`);
  }

  if (failures.length === before) {
    infos.push(`[巨树] ${variantCount} 变体 / ${declared.length} 方块（叶子 cutout 镂空 + opaqueTable=1 保剔除 + 投影）/ 指纹匹配 / 贴图 ${giantTiles.size} 张 / 孔洞率 ${leafHoleNote}`);
  }
}


// ---------------------------------------------------------------- [水体贴图] 契约（v1.84）

/**
 * [水体贴图] 契约：`water` / `swamp_water` 的 faces-data tile 必须指向烘焙产物
 * （`procedural/*`），且产物的 RGB 均值必须落在 `WATER_TARGET_MEAN` 附近。
 *
 * 背景（2026-10-26 用户第三轮反馈）：「水方块的颜色（水面波纹区覆盖不到的地方）和这个
 * 水面的颜色差异稍微有点大，尽量让二者接近一些」。根因是**两套独立颜色源**：
 *   ① 海面平面 = `ocean.js` 的 `WATER_COLOR`（着色器）；
 *   ② 水方块 = `assets/textures/water.png`（源图是高饱和紫蓝 `47/102/211`）。
 * 源图渲染后实测 `59/100/190`，而平面是 `92/133/164` → 逐通道差 **85**，海岸线上表现为
 * 「亮紫蓝水带浮在浅蓝水面上」。烘焙产物把均值拉到 `95/140/168` → 差距降到 **17**。
 *
 * 钉的失效路径：
 *   ① `faces-data` 改回源 tile（`water`）→ 观感倒退（本次需求起因）；
 *   ② 忘了跑 `npm run water` / 改了目标均值没重烘 → 指纹不符；
 *   ③ 产物均值偏离目标（手改 PNG 或烘错偏移）→ 与海面平面又分家；
 *   ④ **alpha 掉回源图的 175**（v1.85 用户：「远看几乎呈透明色，能清楚看到海底」）→
 *      体素水只有 68.6% 不透明，水下地形透上来 31%。这个失效是**静默的**：颜色全对、
 *      门禁全绿，只是远看能看见海底 —— 所以必须单独钉 alpha。
 * ⚠️ 本门禁**不**检查与 `ocean.js` 的运行时一致性（那需要渲染），但两者是靠
 * `WATER_TARGET_MEAN` 的注释绑定在一起的 —— **改水面配色时必须重算那组数**。
 */
async function checkWaterTextures() {
  const params = await import('./water-texture-fingerprint.mjs');
  const before = failures.length;
  const fail = (m) => failures.push(`[水体贴图] ${m}`);
  const facesSrc = fs.readFileSync(path.join(ROOT, 'src', 'voxel', 'faces-data.js'), 'utf8');

  for (const [name, tile] of Object.entries(params.WATER_TEX_OUT)) {
    if (!facesSrc.includes(`${name}: '${tile}'`)) {
      fail(`faces-data 的 ${name} 必须指向 '${tile}'（当前不是烘焙产物 → 与海面平面色差 85）`);
      continue;
    }
    const dst = path.join(ROOT, 'assets', 'textures', 'procedural', `${name}.png`);
    if (!fs.existsSync(dst)) { fail(`产物缺失 procedural/${name}.png（跑 npm run water）`); continue; }
    const png = PNG.sync.read(fs.readFileSync(dst));
    const sum = [0, 0, 0];
    const n = png.width * png.height;
    for (let i = 0; i < n; i++) {
      const o = i << 2;
      sum[0] += png.data[o]; sum[1] += png.data[o + 1]; sum[2] += png.data[o + 2];
    }
    const mean = sum.map((v) => v / n);
    const target = params.WATER_TARGET_MEAN[name];
    const dev = mean.map((v, i) => Math.abs(v - target[i]));
    // 通道平移是逐像素同偏移，均值必然精确落点；容差 2 只吸收取整
    if (Math.max(...dev) > 2) {
      fail(`${name} 产物均值 ${mean.map((v) => v.toFixed(0)).join('/')} 偏离目标 `
        + `${target.join('/')}（差 ${dev.map((v) => v.toFixed(1)).join('/')}，跑 npm run water）`);
    }
    // ④ alpha：盖住海底（见上方失效路径 ④）。原先算 alpha 是为了「与海面平面对齐」，
    // 该缺口 2026-10-26 用户第四轮反馈「远看几乎呈透明色、能清楚看到海底」时补齐。
    const wantAlpha = params.WATER_TARGET_ALPHA[name];
    if (wantAlpha != null) {
      const a = png.data[3]; // 产物是均匀 alpha（通道平移不改 alpha）
      if (Math.abs(a - wantAlpha) > 1) {
        fail(`${name} 产物 alpha=${a}，应为 ${wantAlpha}（太低会让海底透上来 → 远看发虚，跑 npm run water）`);
      }
    }
  }

  if (failures.length === before) {
    infos.push(`[水体贴图] ${Object.keys(params.WATER_TEX_OUT).length} 张烘焙产物 / `
      + `均值对齐 ${Object.entries(params.WATER_TARGET_MEAN).map(([k, v]) => `${k} ${v.join('/')}`).join(', ')} / `
      + `alpha ${Object.entries(params.WATER_TARGET_ALPHA).map(([k, v]) => `${k} ${v ?? '源图'}`).join(', ')} / `
      + `指纹 ${params.waterTextureFingerprint().slice(0, 8)}`);
  }
}

// ---------------------------------------------------------------- [树叶贴图] 契约（2026-10-23）

/**
 * [树叶贴图] 契约：**全部树叶族**的贴图必须是 `procedural/leaf_*`（除 `sky_leaves`）
 * 且孔洞率落在与巨树一致的区间内。
 *
 * 背景（2026-10-23 用户裁定）：普通树叶的口径对齐巨树 —— `cutout` + `opaqueTable=1`，
 * 且「贴图的镂空密度改得跟巨树一样，让树叶看起来密一些」。
 * 源图孔洞率 23%~**77.6%**（`oak_leaves_branch_medium` 叶面只剩 22.4%）→ 压到 14.8%~15.0%。
 *
 * 钉的失效路径：
 *   ① 把 faces-data 改回源 tile（`leaves` / `leaves_yellow` …）→ 孔洞率倒退，观感变稀（本次需求起因）；
 *   ② 删掉/漏跑 `npm run leaftextures` → 产物静默过期或缺失；
 *   ③ 孔洞率烘错（改成 0.31 → 白做；改成 0.01 → 像实心色板）。
 *
 * ⚠️ `sky_leaves` **例外**：它走 opaque 通道（mc-lite 材质无 alphaTest），本就无镂空 → 不在本契约内。
 */
async function checkLeafTextures() {
  const holes = await import('./leaf-holes.mjs');
  const { LEAF_TEXTURES } = await import('./bake-leaf-textures.mjs');
  const before = failures.length;
  const fail = (m) => failures.push(`[树叶贴图] ${m}`);

  // ① 烘焙表里的每一项：产物必须存在、尺寸与源图一致、孔洞率在区间内
  for (const t of LEAF_TEXTURES) {
    const srcPath = path.join(ROOT, 'assets', 'textures', `${t.src}.png`);
    const dstPath = path.join(ROOT, 'assets', 'textures', 'procedural', `${t.out}.png`);
    if (!fs.existsSync(srcPath)) { fail(`源图缺失 ${t.src}.png（入库素材丢失 = 仓库损坏）`); continue; }
    if (!fs.existsSync(dstPath)) { fail(`产物缺失 procedural/${t.out}.png（跑 npm run leaftextures）`); continue; }
    const src = PNG.sync.read(fs.readFileSync(srcPath));
    const png = PNG.sync.read(fs.readFileSync(dstPath));
    if (png.width !== src.width || png.height !== src.height) {
      fail(`procedural/${t.out}.png 尺寸 ${png.width}×${png.height} ≠ 源图 ${src.width}×${src.height}`);
    }
    const st = holes.leafHoleStats(png);
    if (st.ratio < holes.LEAF_HOLE_RATIO_MIN || st.ratio > holes.LEAF_HOLE_RATIO_MAX) {
      fail(`procedural/${t.out}.png 孔洞率 ${(st.ratio * 100).toFixed(1)}%（应 ${holes.LEAF_HOLE_RATIO_MIN * 100}%~${holes.LEAF_HOLE_RATIO_MAX * 100}%）—— 太小像实心色板、太接近源图就回到「叶冠太稀」`);
    }
    // ② 带独立 ratio 的项（当前只有杜鹃两项）必须**精确**落在自己的档位上，
    //    不能只是「落在通用区间内」—— 通用区间 3%~25% 放得过 14.8%，那正是本次要修的值。
    if (t.ratio != null) {
      const want = Math.round(256 * t.ratio); // 16×16 贴图的孔洞像素数
      if (st.holes !== want) {
        fail(`procedural/${t.out}.png 孔洞 ${st.holes} 像素 ≠ 期望 ${want}（ratio ${t.ratio}）—— 跑 npm run leaftextures；` +
          `杜鹃叶必须比普通树叶更密（孔洞块最大 2px），否则大冠幅下会透出天空`);
      }
    }
    // ② RGB 口径：**只允许对“源图透明 → 产物不透明”的像素补色**（否则它们的源 RGB
    //    往往是 (0,0,0) 填充值，抬成不透明就是黑噪点），其余像素的 RGB 逐字节不得变。
    //
    //    ⚠️ 旧断言是“全部 RGB 逐字节相同”—— 它与补色直接矛盾：孔洞率从 77.6% 压到 15%
    //    必然要把一批源孔洞像素抬成不透明，而源孔洞的 RGB 无意义。实测污染：
    //    azalea_leaves 39 个 / azalea_flowers 31 个 / oak_leaves_branch_medium 641 个（占叶面 73.7%）。
    let recolored = 0, badOpaque = 0;
    for (let i = 0; i < png.data.length; i += 4) {
      const wasHole = src.data[i + 3] < holes.HOLE_ALPHA;
      const nowOpaque = png.data[i + 3] !== 0;
      if (wasHole && nowOpaque) { recolored++; continue; } // 允许（且必须）补色
      if (png.data[i] !== src.data[i] || png.data[i + 1] !== src.data[i + 1] || png.data[i + 2] !== src.data[i + 2]) {
        fail(`procedural/${t.out}.png 的叶面 RGB 与源图不一致（像素 ${i / 4}）—— 孔洞压缩只应改 alpha 与“被抬升像素”的颜色`);
        break;
      }
    }
    // ③ 不透明像素不得是纯黑（源图透明处的 RGB 填充值就是 0,0,0）。这条是黑噪点的直接判据，
    //    比上面的 RGB 比对更有判别力：注掉补色后实测 leaf_leaves 报 0 但 azalea 两项报 39/31。
    for (let i = 0; i < png.data.length; i += 4) {
      if (png.data[i + 3] !== 0 && png.data[i] < 8 && png.data[i + 1] < 8 && png.data[i + 2] < 8) badOpaque++;
    }
    if (badOpaque > 0) {
      fail(`procedural/${t.out}.png 有 ${badOpaque} 个不透明纯黑像素（叶面上会看到黑噪点）—— 跑 npm run leaftextures`);
    }
  }

  // ③ 每个树叶族（除 sky_leaves）的 faces-data 都必须指向 procedural/leaf_*
  //    ⚠️ `realistic_oak_leaves` 已于 2026-11-04 从方块声明中删除（用户裁定「我不需要了」），
  //    其产物 `leaf_oak_leaves_branch_medium` 随之从烘焙表移除 —— 若有人把它加回清单，
  //    上方 ④ 的孤儿检查与下方 faces-data 检查会交叉拓到。
  const LEAF_NAMES = ['leaves', 'azalea_leaves', 'yellow_leaves',
    'realistic_yellow_leaves', 'swamp_leaves', 'snow_leaves'];
  // ⚠️ `azalea_flowers` 是**非叶名**的树叶族（名字里没有 leaves），旧版清单漏了它 →
  // 它一直指向未压缩的原图 `flowering_azalea_leaves`（19.9%），比同树的纯叶还稀。
  // 两份贴图稀疏度不同会让同一棵树看起来像两种材质。
  // 巨树叶与 sky_leaves 不在此列：它们的产物由 `npm run gianttextures` 烘，另有 [巨树] 环节守。
  for (const n of [...LEAF_NAMES, 'azalea_flowers']) {
    const v = FACES_DATA[n];
    if (!v) { fail(`"${n}" 没有 faces-data 映射`); continue; }
    for (const tile of (Array.isArray(v) ? v : [v])) {
      // 排除非树叶 tile（雪块顶面 Snow_top 是雪，不是叶）
      if (tile === 'Snow_top') continue;
      if (!tile || !tile.startsWith('procedural/leaf_')) {
        fail(`"${n}" 的 tile "${tile}" 不是 procedural/leaf_*（未做孔洞压缩 → 叶冠太稀）`);
      }
    }
  }

  // ④ procedural/leaf_* 不得有孤儿（烘焙表里没列、却被文件系统里有）
  const want = new Set(LEAF_TEXTURES.map((t) => `procedural/${t.out}`));
  const procDir = path.join(ROOT, 'assets', 'textures', 'procedural');
  for (const f of fs.readdirSync(procDir).filter((x) => x.startsWith('leaf_') && x.endsWith('.png'))) {
    const tile = `procedural/${f.replace(/\.png$/, '')}`;
    if (!want.has(tile)) fail(`孤儿贴图 ${tile}（不在 LEAF_TEXTURES 烘焙表里）`);
  }

  if (failures.length === before) {
    infos.push(`[树叶贴图] ${LEAF_TEXTURES.length} 张孔洞压缩产物 / 普通叶 ${(holes.LEAF_HOLE_RATIO * 100).toFixed(1)}%、杜鹃叶 ${(holes.LEAF_HOLE_RATIO_AZALEA * 100).toFixed(1)}% / 叶面 RGB 与源图逐字节相同 + 无黑噪点`);
  }
}

// ---------------------------------------------------------------- [巨型金字塔] 契约（Giant Pyramid Epic）

/**
 * [巨型金字塔] 契约：烘焙输入 / 产物 metrics / 方块映射 / 渲染通道五者互相对得上。
 *
 * 钉的失效路径（**每条都是静默的**）：
 *   ① 指纹不匹配 → 改了 BLOCK_MAP / FACING_TO_ORIENT / PYRAMID_METRICS / .litematic 却没重烘
 *      → 世界里是旧塔形，方块层面看不出差别
 *   ② palette 含未注册方块 → `makeColumnSetter` 对未注册名字**静默 return**（landmarks.js:274）
 *      → 那一格变 air → 塔身上出现洞
 *   ③ 峰值降到全整格 → 台阶被退化成 sand，迷宫变实心塔（观感完全不同）
 *   ④ 底层不满铺 → 塔基悬空（2401 列少一列就露缝）
 *   ⑤ palette 跑进 transparent 通道 → 每格顶点成本翻倍
 *   ⑥ 含砖/木族 → 与人造建筑混淆（与高台同口径的名字模式判据）
 * ⚠️ 主流程是逐个显式调用 —— 漏了本行则门禁永不执行（本仓已因此出过两次事故）。
 */
async function checkGiantPyramid() {
  const fp = await import('./giant-pyramid-fingerprint.mjs');
  const before = failures.length;
  const fail = (m) => failures.push(`[巨型金字塔] ${m}`);

  // ① 烘焙输入（入库）与产物存在性
  if (!fs.existsSync(fp.LITEMATIC_PATH)) {
    fail(`烘焙输入缺失 ${path.relative(ROOT, fp.LITEMATIC_PATH)}（.litematic 入库，缺失 = 仓库损坏）`);
    return;
  }
  if (!fs.existsSync(fp.PYRAMID_JSON) || !fs.existsSync(fp.PYRAMID_META)) {
    fail('缺 assets/structures/giant_pyramid.json 或 .meta.json（跑 npm run pyramid）');
    return;
  }
  let meta, json;
  try {
    meta = JSON.parse(fs.readFileSync(fp.PYRAMID_META, 'utf8'));
    json = JSON.parse(fs.readFileSync(fp.PYRAMID_JSON, 'utf8'));
  } catch { fail('产物不是合法 JSON（重跑 npm run pyramid）'); return; }

  // ② 指纹：改了参数或素材却没重烘
  const cur = fp.giantPyramidInputFingerprint();
  if (meta.fingerprints?.input !== cur.input) {
    fail(`产物已过期：指纹不匹配（烘焙时 "${meta.fingerprints?.input}" vs 当前 "${cur.input}"）→ 跑 npm run pyramid`);
  }

  // ③ metrics：格数 / 三个目标方块的格数 / bbox
  const M = fp.PYRAMID_METRICS;
  // ⚠️ **stride 必验**：只写 4 项（丢 direction）会让 1219 个台阶静默全朝东 ——
  // 而错的是「朝向」不是「格数」，格数判据完全拓不到。故这里先钉 stride，再按它遍历。
  const STRIDE = Number.isInteger(json.stride) ? json.stride : 4;
  if (STRIDE !== 5) {
    fail(`产物 stride=${STRIDE} ≠ 5 —— 台阶朝向（direction）没写进产物 → 世界上所有台阶会全朝 orient=0`);
  }
  const n = json.blocks.length / STRIDE;
  if (n !== M.blocks) fail(`方块数 ${n} ≠ PYRAMID_METRICS.blocks ${M.blocks}`);
  const byType = new Map();
  const orientationHist = new Map();   // sand_step 的 orient 分布（四向均匀 = 方向对了）
  for (let i = 3; i < json.blocks.length; i += STRIDE) {
    const t = json.palette[json.blocks[i]];
    byType.set(t, (byType.get(t) || 0) + 1);
    if (t === 'sand_step') {
      const d = json.blocks[i + 1];
      orientationHist.set(d, (orientationHist.get(d) || 0) + 1);
    }
  }
  for (const [name, want] of [['sand', M.sandCells], ['sand_step', M.stepCells], ['sand_slab', M.slabCells]]) {
    const got = byType.get(name) || 0;
    if (got !== want) fail(`"${name}" 格数 ${got} ≠ PYRAMID_METRICS ${want}`);
  }
  // 台阶朝向必须四向都有（否则说明映射退化成单一朝向 —— 砖一块全朝东的塔）
  if (orientationHist.size !== 4) {
    fail(`sand_step 的 orient 只出现 ${orientationHist.size} 种（${[...orientationHist.keys()].sort().join(',')}）—— 四个朝向都要有（坡面方向不同）`);
  } else {
    const counts = [...orientationHist.values()].sort((a, b) => a - b);
    // 实测四向 305/303/305/306（几乎均匀）；门取「最多不超过最少 1.5 倍」
    if (counts[3] > counts[0] * 1.5) {
      fail(`sand_step 朝向分布偏差过大（${JSON.stringify(Object.fromEntries([...orientationHist].sort()))}）—— 四坡面对称应接近均匀`);
    }
  }

  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity, mnz = Infinity, mxz = -Infinity;
  const baseCols = new Set();
  for (let i = 0; i < json.blocks.length; i += STRIDE) {
    const x = json.blocks[i], y = json.blocks[i + 1], z = json.blocks[i + 2];
    if (x < mnx) mnx = x; if (x > mxx) mxx = x;
    if (y < mny) mny = y; if (y > mxy) mxy = y;
    if (z < mnz) mnz = z; if (z > mxz) mxz = z;
    if (y === 1) baseCols.add(`${x},${z}`);
  }
  if (mxx - mnx + 1 !== M.width) fail(`宽 ${mxx - mnx + 1} ≠ ${M.width}`);
  if (mxy - mny + 1 !== M.height) fail(`高 ${mxy - mny + 1} ≠ ${M.height}`);
  if (mxz - mnz + 1 !== M.depth) fail(`深 ${mxz - mnz + 1} ≠ ${M.depth}`);
  if (mny !== 1) fail(`最低点 y=${mny} ≠ 1（归一化约定：rasterizeStructure 按 b.y 落位）`);
  // 底层满铺：少一列就有悬空缝
  if (baseCols.size !== M.baseCells) fail(`基座列数 ${baseCols.size} ≠ ${M.baseCells}（底层被改动？）`);
  // 台阶不得退化成全整格（守住“迷宫”这个设计意图）
  const stepCells = byType.get('sand_step') || 0;
  if (stepCells < 1000) fail(`sand_step 只有 ${stepCells} 格（必须 ≥1000，实测 1219）—— 台阶被退化成整格会让迷宫变成实心塔`);

  // ④ palette：全部注册 + 通道限制 + 无砖无木
  const palette = Array.isArray(json.palette) ? json.palette : [];
  if (palette.length === 0) fail('产物缺 palette（重跑 npm run pyramid）');
  for (const name of palette) {
    const id = REGISTRY.idOf(name);
    if (id === undefined) {
      fail(`palette 含未注册方块 "${name}"（makeColumnSetter 静默跳过 → 塔身出现洞）`);
      continue;
    }
    if (REGISTRY.cullTable[id] === 2) {
      fail(`palette 方块 "${name}" 跑进 transparent 通道（每格顶点成本翻倍）`);
    }
  }
  const brickish = palette.filter((name) => /brick/i.test(name));
  if (brickish.length > 0) fail(`palette 含砖块族（${brickish.join(', ')}）—— 用户要求沙子系`);
  const woody = palette.filter((name) => /log|wood|plank|acacia|oak|birch/i.test(name));
  if (woody.length > 0) fail(`palette 含木族（${woody.join(', ')}）—— 用户要求沙子系`);

  // ⚠️ 成功行的条件必须涵盖**本函数全部判据**，否则失败时仍会打印一条 ✓
  // （实测踩到：`[高台]` 曾同时出现「✗ 含砖块族」与「✓ …无砖无木」两条，读者只看 ✓ 就会误判）。
  if (failures.length === before) {
    // 成功行报告 stride 与四向分布（从产物本身算，不读 meta —— meta 与产物可能不一致）
    const dist = [0, 1, 2, 3].map((o) => orientationHist.get(o) || 0);
    infos.push(`[巨型金字塔] ${n} 格 / ${mxx - mnx + 1}×${mxy - mny + 1}×${mxz - mnz + 1} / 基座 ${baseCols.size} 列 / ` +
      `${palette.length} 种（sand ${byType.get('sand')} + step ${stepCells} + slab ${byType.get('sand_slab')}）/ ` +
      `stride ${STRIDE} + 台阶四向 ${dist.join('/')} / 无砖无木 / 指纹匹配`);
  }
}

// ---------------------------------------------------------------- [竞技场] 契约（Arena，2026-10-29）

/**
 * [竞技场] 契约：烘焙输入 / 产物 / 方块映射 / 栏杆朝向 / 尺寸常量五者互相对得上。
 *
 * 钉的失效路径（**每条都是静默的**）：
 *   ① 指纹不匹配 → 改了 BLOCK_MAP / SUPERSEDED_BLOCKS / RAIL_RING_INSET / ARENA_METRICS /
 *      .schematic 却未重烘 → 世界里是旧竞技场，方块层面看不出差别
 *   ② palette 含未注册方块 → `makeColumnSetter` 对未注册名字**静默 return**
 *      → 那格变 air → 地板出现洞（玩家会掉下去）
 *   ③ `stride !== 5` → 栏杆朝向（direction）没写进产物 → **整圈栏杆全朝 orient=0**
 *      （直段会变成一半伸 X、一半伸 Z 的错乱，方块层面数得对、就是接不上）
 *   ④ **栏杆环不闭合 / 臂与邻居不匹配** → 环上出现看不见的缺口（用户核心需求）
 *   ⑤ `floorRow` 与产物实际不符 → 地板沉到水池底下（整个竞技场低 2 格）
 *   ⑥ 地板层不满铺 → 玩家从水池/缺口漏到地板以下
 *   ⑦ 占地尺寸与 `src/gen/structures/arena.js` 的 ARENA_WIDTH/ARENA_DEPTH 不一致
 *      → 落点判据与光栅化裁剪用的是两套尺寸
 *   ⑧ `ARENA_VARIANTS` 两侧不一致（src 侧 vs tools 侧）→ 新变体静默不出现
 *
 * ⚠️ 主流程是逐个显式调用 —— 漏了本行则门禁永不执行（本仓已因此出过两次事故）。
 */
async function checkArena() {
  const fp = await import('./arena-fingerprint.mjs');
  const arenaMod = await import('../src/gen/structures/arena.js');
  const variantsMod = await import('../src/gen/structures/arena-variants.js');
  const before = failures.length;
  const fail = (m) => failures.push(`[竞技场] ${m}`);

  // ① 烘焙输入与产物存在性
  if (!fs.existsSync(fp.ARENA_SOURCE_PATH)) {
    fail(`烘焙输入缺失 ${path.relative(ROOT, fp.ARENA_SOURCE_PATH)}（.schematic 入库，缺失 = 仓库损坏）`);
    return;
  }
  if (!fs.existsSync(fp.ARENA_JSON) || !fs.existsSync(fp.ARENA_META)) {
    fail('缺 assets/structures/arena_grass.json 或 arena.meta.json（跑 npm run arena）');
    return;
  }
  let meta, json;
  try {
    meta = JSON.parse(fs.readFileSync(fp.ARENA_META, 'utf8'));
    json = JSON.parse(fs.readFileSync(fp.ARENA_JSON, 'utf8'));
  } catch { fail('产物不是合法 JSON（重跑 npm run arena）'); return; }

  // ② 指纹
  const cur = fp.arenaInputFingerprint();
  if (meta.fingerprints?.input !== cur.input) {
    fail(`产物已过期：指纹不匹配（烘焙时 "${meta.fingerprints?.input}" vs 当前 "${cur.input}"）→ 跑 npm run arena`);
  }

  // ⑧ 两侧变体清单必须一致
  const toolsVariants = [...fp.ARENA_VARIANTS].sort().join(',');
  const srcVariants = [...variantsMod.ARENA_VARIANTS].sort().join(',');
  if (toolsVariants !== srcVariants) {
    fail(`ARENA_VARIANTS 两侧不一致（tools: [${toolsVariants}] vs src: [${srcVariants}]）—— 新变体会静默不出现`);
  }

  const M = fp.ARENA_METRICS.arenaGrass;

  // ③ stride 必验（与巨型金字塔同理由：错的是「朝向」不是「格数」）
  const STRIDE = Number.isInteger(json.stride) ? json.stride : 4;
  if (STRIDE !== 5) {
    fail(`产物 stride=${STRIDE} ≠ 5 —— 栏杆朝向（direction）没写进产物 → 整圈栏杆会全朝 orient=0`);
  }

  // ⑤ floorRow
  if (json.floorRow !== M.floorRow) {
    fail(`产物 floorRow=${json.floorRow} ≠ ARENA_METRICS.floorRow ${M.floorRow}（地板会沉到水池底下）`);
  }

  // ④/⑥ 逐格统计
  const blocks = Array.isArray(json.blocks) ? json.blocks : [];
  const n = blocks.length / STRIDE;
  const byType = new Map();
  const railCells = [];   // {x, z, name, orient}
  const floorCols = new Set();
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity, mnz = Infinity, mxz = -Infinity;
  for (let i = 0; i < blocks.length; i += STRIDE) {
    const x = blocks[i], y = blocks[i + 1], z = blocks[i + 2];
    const name = json.palette[blocks[i + 3]];
    const orient = blocks[i + 4] || 0;
    byType.set(name, (byType.get(name) || 0) + 1);
    if (x < mnx) mnx = x; if (x > mxx) mxx = x;
    if (y < mny) mny = y; if (y > mxy) mxy = y;
    if (z < mnz) mnz = z; if (z > mxz) mxz = z;
    if (y === M.floorRow) floorCols.add(`${x},${z}`);
    if (name === 'handrail' || name === 'handrailA') railCells.push({ x, y, z, name, orient });
  }
  if (railCells.length !== M.railCells) {
    fail(`栏杆格数 ${railCells.length} ≠ ARENA_METRICS.railCells ${M.railCells}`);
  }
  if (floorCols.size !== M.floorCells) {
    fail(`地板层（y=${M.floorRow}）${floorCols.size} 列 ≠ ${M.floorCells}（地板不完整 → 玩家会漏到地板以下）`);
  }

  // ⑦ 占地尺寸：**产物 bbox 已含栏杆环**（环就写在 blocks 里），故直接与 footprint 比；
  //    内容本身（去掉环）应该是 `footprint − 2×RAIL_RING_INSET` —— 两边都钉，
  //    只钉一侧会让「环搬到内圈」这类改动静默通过。
  const bboxW = mxx - mnx + 1, bboxD = mxz - mnz + 1;
  const footprintW = M.footprintWidth, footprintD = M.footprintDepth;
  if (bboxW !== footprintW) fail(`产物宽 ${bboxW} ≠ ARENA_METRICS.footprintWidth ${footprintW}`);
  if (bboxD !== footprintD) fail(`产物深 ${bboxD} ≠ ARENA_METRICS.footprintDepth ${footprintD}`);
  if (bboxW - fp.RAIL_RING_INSET * 2 !== M.width) {
    fail(`去掉栏杆环后的宽 ${bboxW - fp.RAIL_RING_INSET * 2} ≠ ARENA_METRICS.width ${M.width}`);
  }
  if (bboxD - fp.RAIL_RING_INSET * 2 !== M.depth) {
    fail(`去掉栏杆环后的深 ${bboxD - fp.RAIL_RING_INSET * 2} ≠ ARENA_METRICS.depth ${M.depth}`);
  }
  if (footprintW !== arenaMod.ARENA_WIDTH) {
    fail(`产物宽 ${footprintW} ≠ src/gen/structures/arena.js 的 ARENA_WIDTH ${arenaMod.ARENA_WIDTH}（两套尺寸会错开）`);
  }
  if (footprintD !== arenaMod.ARENA_DEPTH) {
    fail(`产物深 ${footprintD} ≠ src/gen/structures/arena.js 的 ARENA_DEPTH ${arenaMod.ARENA_DEPTH}`);
  }
  if (mny !== 1) fail(`最低点 y=${mny} ≠ 1（归一化约定：rasterizeStructure 按 b.y 落位）`);

  // ④ **栏杆环闭合 + 臂与邻居匹配**（本设计的核心判据）
  const railSet = new Set(railCells.map((c) => `${c.x},${c.z}`));
  const norm = (arms) => ['+X', '-X', '+Z', '-Z'].filter((a) => arms.includes(a)).join(' ');
  let openCells = 0, mismatch = 0;
  for (const c of railCells) {
    const need = [];
    if (railSet.has(`${c.x + 1},${c.z}`)) need.push('+X');
    if (railSet.has(`${c.x - 1},${c.z}`)) need.push('-X');
    if (railSet.has(`${c.x},${c.z + 1}`)) need.push('+Z');
    if (railSet.has(`${c.x},${c.z - 1}`)) need.push('-Z');
    if (need.length !== 2) { openCells++; continue; }
    const got = arenaMod.railArmSet(c.name, c.orient);
    if (norm(got) !== norm(need)) mismatch++;
  }
  if (openCells > 0) {
    fail(`栏杆环有 ${openCells} 格不是「恰好 2 个环邻居」（环不闭合或有分支）—— 会有缺口`);
  }
  if (mismatch > 0) {
    fail(`栏杆环有 ${mismatch} 格的臂方向与邻居不匹配（转角件朝向或直段件选错）—— 玩家会看到断开的栏杆`);
  }
  // 直段必须用 handrailA、转角必须用 handrail（互换会让半边缺失 / 多出断头）
  const cornerCells = railCells.filter((c) => {
    const xs = railSet.has(`${c.x + 1},${c.z}`) || railSet.has(`${c.x - 1},${c.z}`);
    const zs = railSet.has(`${c.x},${c.z + 1}`) || railSet.has(`${c.x},${c.z - 1}`);
    return xs && zs;
  });
  for (const c of cornerCells) {
    if (c.name !== 'handrail') {
      fail(`转角格 (${c.x},${c.z}) 用了 ${c.name}（必须是 handrail，否则缺一条臂）`);
      break;
    }
  }

  // ② palette：全部已注册 + 不含容器方块 / 源图栅栏 / 未映射残留
  const palette = Array.isArray(json.palette) ? json.palette : [];
  if (palette.length === 0) fail('产物缺 palette（重跑 npm run arena）');
  for (const name of palette) {
    if (REGISTRY.idOf(name) === undefined) {
      fail(`palette 含未注册方块 "${name}"（makeColumnSetter 静默跳过 → 地板出现洞）`);
    }
    if (fp.CONTAINER_BLOCKS.includes(name)) {
      fail(`palette 含容器方块 "${name}"（barrier/bedrock/air 必须烘焙时丢弃）`);
    }
    if (fp.SUPERSEDED_BLOCKS.includes(name)) {
      fail(`palette 含被取代的源方块 "${name}"（原图斜向栅栏应由外圈栏杆环取代）`);
    }
  }
  // 双向：palette → BLOCK_MAP 严格；BLOCK_MAP → palette 只要求「素材实际用到的源方块都能命中」。
  // ⚠️ 不能要求「每个映射目标都出现在本变体 palette 里」：BLOCK_MAP 刻意留了 Arena2~6
  // 将来要用的条目（stone / cobblestone / clay …），那样会错杀那张前瞻表。
  const mapped = new Set(Object.values(fp.BLOCK_MAP).filter(Boolean));
  const inPalette = new Set(palette.filter((n) => !n.startsWith('handrail')));
  for (const name of inPalette) {
    if (!mapped.has(name)) fail(`产物 palette 含 BLOCK_MAP 未映射到的方块 "${name}"（映射表与实际内容不符）`);
  }
  // 素材侧普查（meta.sourceBlockCounts）必须能全量映射 —— 这是「没有未知源方块被静默丢弃」的正面证据
  for (const srcName of Object.keys(meta.sourceBlockCounts || {})) {
    if (fp.CONTAINER_BLOCKS.includes(srcName) || fp.SUPERSEDED_BLOCKS.includes(srcName)) continue;
    if (!(srcName in fp.BLOCK_MAP)) {
      fail(`素材里出现源方块 "${srcName}" 但 BLOCK_MAP 没有它`);
    } else if (!inPalette.has(fp.BLOCK_MAP[srcName])) {
      fail(`源方块 "${srcName}" 映射到 "${fp.BLOCK_MAP[srcName]}" 但产物里没有该方块`);
    }
  }

  // 内容格数（区分「素材里有多少」与「产物里有多少」）
  const contentCells = n - railCells.length;
  if (contentCells !== M.contentCells) {
    fail(`内容格数 ${contentCells} ≠ ARENA_METRICS.contentCells ${M.contentCells}（源改动？先跑 npm run arena -- --census）`);
  }
  if (M.sourceCells - M.supersededCells !== M.contentCells) {
    fail(`ARENA_METRICS 自相矛盾：sourceCells ${M.sourceCells} − supersededCells ${M.supersededCells} ≠ contentCells ${M.contentCells}`);
  }

  // ⚠️ 成功行的条件必须涵盖**本函数全部判据**
  if (failures.length === before) {
    const orientDist = [0, 1, 2, 3].map((o) => (meta.railOrientationCounts?.[`handrail:${o}`] || 0));
    const straight = (meta.railOrientationCounts?.['handrailA:0'] || 0) + (meta.railOrientationCounts?.['handrailA:1'] || 0);
    infos.push(`[竞技场] ${n} 格（内容 ${contentCells} + 栏杆 ${railCells.length}）/ ` +
      `${mxx - mnx + 1}×${mxy - mny + 1}×${mxz - mnz + 1} / floorRow ${json.floorRow} 满铺 ${floorCols.size} 格 / ` +
      `stride ${STRIDE} + 栏杆环闭合（转角四向 ${orientDist.join('/')}、直段 ${straight}）/ ` +
      `${palette.length} 种全已注册 / 指纹匹配`);
  }
}

// ---------------------------------------------------------------- [浅水高台] 契约（v2.11，2026-11-01）

/**
 * [浅水高台] 契约：5 个烘焙产物 / palette 白名单 / 源方块全量映射 / 草基准色 / 方块已登记。
 *
 * 钉的失效路径（均为**静默**失败）：
 *   ① 素材换了但没重烘 → 产物过期（指纹抓）；
 *   ② 新增源方块没补 `BLOCK_MAP` → 烘焙会 throw，但若有人只改了产物则这里抓；
 *   ③ `golden` 白名单漂移 → 地图里混进不属于它的材质（观感错但方块层面看不出）；
 *   ④ 两个新草方块未注册 → `makeColumnSetter` 静默 return → 高台里的草变空气洞；
 *   ⑤ 产物 bbox 与 `SHALLOW_TARN_METRICS` 不符 → 环上占角与 AABB 裁剪全错（两座重叠）。
 */
async function checkShallowTarns() {
  const before = failures.length;
  const fail = (m) => failures.push(`[浅水高台] ${m}`);

  const metaPath = SHALLOW.SHALLOW_TARN_META;
  if (!fs.existsSync(metaPath)) {
    fail('缺 meta（跑 npm run shallowtarns）');
    return;
  }
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

  // ① 指纹：产物必须对得上当前的素材 + 映射表 + 分量序
  const fp = SHALLOW.shallowTarnInputFingerprint();
  if (meta.fingerprints?.input !== fp.input) {
    fail(`烘焙指纹不匹配（跑 npm run shallowtarns）：meta ${String(meta.fingerprints?.input).slice(0, 12)}… ≠ 当前 ${fp.input.slice(0, 12)}…`);
  }

  // ② 产物完整性 + palette 白名单 + 尺寸契约 + 草基准色
  const legal = new Set(SHALLOW.SHALLOW_TARN_PALETTE);
  let totalBlocks = 0;
  const sizes = [];
  for (const base of SHALLOW.SHALLOW_TARN_VARIANTS) {
    const file = SHALLOW.variantPath(base);
    if (!fs.existsSync(file)) { fail(`缺产物 ${base}.json（跑 npm run shallowtarns）`); continue; }
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(json.palette) || json.palette.length === 0) { fail(`${base}: palette 缺失或为空`); continue; }
    if (!Array.isArray(json.blocks) || json.blocks.length % 4 !== 0) {
      fail(`${base}: blocks 长度 ${json.blocks?.length} 不是 4 的整数倍`); continue;
    }
    const n = json.blocks.length / 4;
    totalBlocks += n;
    // palette 白名单：**不用名字模式**（`polished_blackstone_bricks` 会命中 /brick/）
    const outside = json.palette.filter((name) => !legal.has(name));
    if (outside.length) fail(`${base}: palette 含白名单外的方块 ${outside.join(', ')}（同步 SHALLOW_TARN_PALETTE）`);
    // 每个 palette 名必须是已注册方块（否则光栅化时静默变空气）
    const unregistered = json.palette.filter((name) => !BLOCKS.some((b) => b.name === name));
    if (unregistered.length) fail(`${base}: palette 含未注册方块 ${unregistered.join(', ')}（同步 blocks-data.js）`);
    // 尺寸契约（环上占角与 AABB 裁剪都吃它）
    let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity, mnz = Infinity, mxz = -Infinity;
    for (let i = 0; i < json.blocks.length; i += 4) {
      const x = json.blocks[i], y = json.blocks[i + 1], z = json.blocks[i + 2];
      if (x < mnx) mnx = x; if (x > mxx) mxx = x;
      if (y < mny) mny = y; if (y > mxy) mxy = y;
      if (z < mnz) mnz = z; if (z > mxz) mxz = z;
    }
    const W = mxx - mnx + 1, H = mxy - mny + 1, D = mxz - mnz + 1;
    const m = SHALLOW.SHALLOW_TARN_METRICS[base];
    if (m.width !== W || m.height !== H || m.depth !== D) {
      fail(`${base}: 产物 bbox ${W}×${H}×${D} ≠ SHALLOW_TARN_METRICS ${m.width}×${m.height}×${m.depth}`);
    }
    if (m.blocks !== n) fail(`${base}: 格数 ${n} ≠ SHALLOW_TARN_METRICS ${m.blocks}`);
    // 最低点必须归一化为 y=1（`rasterizeStructure` 的 `y + b.y - 1` 依赖它）
    if (mny !== 1) fail(`${base}: 最低点 y=${mny} ≠ 1（归一化失败）`);
    sizes.push(`${W}×${H}×${D}`);

    // ⑤ moss 必须已全部迁出（用户 2026-11-02：「所有 moss 方块都替换为 grass-dark-green」）
    if (json.palette.includes('moss')) {
      fail(`${base}: palette 仍含 moss（moss 应全部换成 dark_grass）`);
    }
    // ⑥ 两条**格数关系式**（v2.15）：不硬编码格数，改选型/改素材自动跟随。
    //    `green_wool → dark_grass` 是终态；`grass_block → grass`（标记，光栅化后才分深浅）。
    //    ⇒ 产物里 dark_grass == green_wool、grass == grass_block，两个方向都要钉。
    const blockCounts = new Map();
    for (let i = 3; i < json.blocks.length; i += 4) {
      const name = json.palette[json.blocks[i]];
      blockCounts.set(name, (blockCounts.get(name) || 0) + 1);
    }
    const srcCounts = meta.variantMetrics?.[base]?.sourceCounts || {};
    const markerName = SHALLOW.GRASS_MARKER_BLOCK;   // 'grass'，不写字面量
    const gotDark = blockCounts.get('dark_grass') || 0;
    const gotMarker = blockCounts.get(markerName) || 0;
    const wantDark = srcCounts.green_wool || 0;
    const wantMarker = srcCounts.grass_block || 0;
    if (gotDark !== wantDark) {
      fail(`${base}: dark_grass ${gotDark} 格 ≠ 素材 green_wool ${wantDark} 格（moss 是否全量换成了深草？）`);
    }
    if (gotMarker !== wantMarker) {
      fail(`${base}: ${markerName} ${gotMarker} 格 ≠ 素材 grass_block ${wantMarker} 格（标记方块是否漏了映射？）`);
    }
  }

  // ③ 源方块全量映射（没有未知源方块被静默丢弃）
  // `air` 排除：它不写进产物（实际就是"没方块"），不需要映射目标。
  for (const srcName of Object.keys(meta.sourceBlockCounts || {})) {
    if (srcName === 'air') continue;
    if (!(srcName in SHALLOW.BLOCK_MAP)) fail(`素材里出现源方块 "${srcName}" 但 BLOCK_MAP 没有它`);
  }
  // ④ 草标记方块必须在白名单内且已注册（光栅化后由 `paintShallowTarnGrass` 刷成两种草）
  if (!legal.has(SHALLOW.GRASS_MARKER_BLOCK)) {
    fail(`GRASS_MARKER_BLOCK "${SHALLOW.GRASS_MARKER_BLOCK}" 不在 palette 白名单内（烘焙会写出未授权的方块）`);
  }
  if (!BLOCKS.some((b) => b.name === SHALLOW.GRASS_MARKER_BLOCK)) {
    fail(`草标记方块 ${SHALLOW.GRASS_MARKER_BLOCK} 未在 blocks-data.js 注册（makeColumnSetter 会静默 return → 那格变 air）`);
  }
  // 两个新草方块必须都已注册且六面同贴图（用户 2026-11-01：「六个面贴图用 …」）
  for (const name of Object.keys(GRASS_TEX.GRASS_TEXTURES)) {
    const def = BLOCKS.find((b) => b.name === name);
    if (!def) { fail(`方块 ${name} 未在 blocks-data.js 注册（光栅化时会静默变空气）`); continue; }
    if (def.geometry !== 'box') fail(`${name}: geometry 应为 box，实际 "${def.geometry}"`);
    const faces = FACES_DATA[name];
    if (typeof faces !== 'string') {
      fail(`${name}: FACES_DATA 应写成单字符串（六面同一 tile），实际是 ${Array.isArray(faces) ? '数组' : typeof faces}`);
    }
  }

  // ⑦ 跨湖拱桥的材质契约（v2.24）：六种必须都已注册 + 全部 opaque 通道 + 无叶子族。
  //
  // 钉的失效路径（全部**静默**）：
  //   · 材质名拼错 → `makeColumnSetter` 静默 return → 那几格变空气（桥出现空洞，玩家掉下去）
  //   · 材质改到 cutout/transparent 通道 → 撞容量预算（且只表现为掉帧）
  //   · 有人「顺手」把叶子加进材质表 → 违反用户「用非叶子方块」的明确要求
  if (BRIDGE.BRIDGE_MATERIALS.length !== 6) {
    fail(`BRIDGE_MATERIALS 应为 6 种，实际 ${BRIDGE.BRIDGE_MATERIALS.length}`);
  }
  for (const name of BRIDGE.BRIDGE_MATERIALS) {
    const def = BLOCKS.find((b) => b.name === name);
    if (!def) { fail(`桥材质 ${name} 未在 blocks-data.js 注册（栅格化会静默变空气）`); continue; }
    if (def.cullMode !== 'opaque') fail(`桥材质 ${name} 的 cullMode 是 "${def.cullMode}"，应为 opaque`);
  }
  const leafLike = BRIDGE.BRIDGE_MATERIALS.filter((n) => /leaves|flower|azalea/.test(n));
  if (leafLike.length) fail(`桥材质含叶子族 ${leafLike.join(', ')}（用户明确要求用非叶子方块）`);

  if (failures.length === before) {
    infos.push(`[浅水高台] ${SHALLOW.SHALLOW_TARN_VARIANTS.length} 个产物 `
      + `（${sizes.join(' / ')}）共 ${totalBlocks} 格 / palette 全在白名单 / 源方块全映射 / `
      + `草标记 ${SHALLOW.GRASS_MARKER_BLOCK} / 指纹匹配 / `
      + `跨湖拱桥六种材质均为注册的 opaque 方块`);
  }
}

// ---------------------------------------------------------------- [中世纪船] 契约（Medieval Ship Epic）

/**
 * [中世纪船] 契约：烘焙输入 / 4 个旋转变体产物 / 映射表 / 两个新方块声明 / 朝向表共用。
 *
 * 钉的失效路径（**每条都是静默的**）：
 *   ① 指纹不匹配 → 改了 BLOCK_MAP / FACING_TO_ORIENT / SHIP_METRICS / .litematic 却没重烘
 *      → 世界里是旧船形，方块层面看不出差别；
 *   ② palette 含未注册方块 → `makeColumnSetter` 对未注册名字**静默 return** → 船身出现洞；
 *   ③ stride ≠ 5 → 台阶/栏杆的 direction 丢失 → 全部按 orient=0 渲染（巨型金字塔踩过）；
 *   ④ **旋转变体之间不自洽** → 某个朝向的船是坏的（船身转了但台阶朝向没转），
 *      而格数/尺寸判据完全拓不到 —— 故用「o1/o2/o3 == o0 旋转后逐格重合」直接钉；
 *   ⑤ 两个新方块（`planks_step_updown` / `half_block_updown`）未注册或几何写错
 *      → 倒置台阶/倒置半砖渲染成整格或空气；
 *   ⑥ **`FACING_TO_ORIENT` 与巨型金字塔分家** → 两张表漂移会让「同一朝向的台阶在
 *      两个结构里高侧不同」（红线 1：朝向语义只有一份权威）；
 *   ⑦ 新方块漏进背包排除清单 → 玩家挖下来拿不到（用户明确要求加进背包）。
 *
 * ⚠️ 主流程是逐个显式调用 —— 漏了本行则门禁永不执行（本仓已因此出过两次事故）。
 */
async function checkMedievalShip() {
  const fp = await import('./medieval-ship-fingerprint.mjs');
  const shipData = await import('../src/gen/structures/medieval-ship-data.js');
  const before = failures.length;
  const fail = (m) => failures.push(`[中世纪船] ${m}`);

  // ① 烘焙输入（入库）与产物存在性
  if (!fs.existsSync(fp.LITEMATIC_PATH)) {
    fail(`烘焙输入缺失 ${path.relative(ROOT, fp.LITEMATIC_PATH)}（.litematic 入库，缺失 = 仓库损坏）`);
    return;
  }
  // 用户修复叠加层也是烘焙输入（与 .litematic 同地位）—— 缺了它烘出的就是未修复的船
  if (!fs.existsSync(fp.USER_FIX_PATH)) {
    fail(`用户修复叠加层缺失 ${path.relative(ROOT, fp.USER_FIX_PATH)}（入库，缺失 = 烘出未修复的船）`);
    return;
  }
  {
    const ov = fp.readUserFixOverlay();
    const M = fp.SHIP_METRICS;
    if (ov.set.length !== M.userFixSetCells) {
      fail(`叠加层 set ${ov.set.length} 条 ≠ SHIP_METRICS.userFixSetCells ${M.userFixSetCells}`);
    }
    if (ov.remove.length !== M.userFixRemoveCells) {
      fail(`叠加层 remove ${ov.remove.length} 条 ≠ SHIP_METRICS.userFixRemoveCells ${M.userFixRemoveCells}`);
    }
    // 叠加层不得含 air（删格走 remove）—— 含 air 会让「写入一格空气」静默变成 no-op
    const airOps = ov.set.filter((op) => op[3] === 'air');
    if (airOps.length) {
      fail(`叠加层 set 里含 ${airOps.length} 条 air（删格必须走 remove，否则静默失效）`);
    }
    // 叠加层的目标方块必须全部已注册（否则 makeColumnSetter 静默 return → 船身出现洞）
    const unreg = [...new Set(ov.set.map((op) => op[3]))].filter((n) => REGISTRY.idOf(n) === undefined);
    if (unreg.length) {
      fail(`叠加层含未注册方块 ${unreg.join(', ')}（makeColumnSetter 静默跳过 → 船身出现洞）`);
    }
  }
  if (!fs.existsSync(fp.SHIP_META)) {
    fail('缺 assets/structures/medieval_ship.meta.json（跑 npm run ship）');
    return;
  }
  let meta;
  try { meta = JSON.parse(fs.readFileSync(fp.SHIP_META, 'utf8')); }
  catch { fail('meta 不是合法 JSON（重跑 npm run ship）'); return; }

  // ② 指纹：改了参数或素材却没重烘
  const cur = fp.medievalShipInputFingerprint();
  if (meta.fingerprints?.input !== cur.input) {
    fail(`产物已过期：指纹不匹配（烘焙时 "${meta.fingerprints?.input}" vs 当前 "${cur.input}"）→ 跑 npm run ship`);
  }

  // ⑥ 朝向表必须与巨型金字塔**同一份**（红线 1：台阶朝向语义只有一个权威）
  const pyr = await import('./giant-pyramid-fingerprint.mjs');
  if (JSON.stringify(fp.FACING_TO_ORIENT) !== JSON.stringify(pyr.FACING_TO_ORIENT)) {
    fail(`FACING_TO_ORIENT 与巨型金字塔分家（船 ${JSON.stringify(fp.FACING_TO_ORIENT)} vs 金字塔 ${JSON.stringify(pyr.FACING_TO_ORIENT)}）`
      + ' —— 两张表漂移会让同一朝向的台阶在两个结构里高侧不同');
  }

  // ②b 船身改色（v2.36）：`HULL_RECOLOR` 是「按产物 y 分层」的规则，不在 BLOCK_MAP 里，
  // 所以指纹只证明参数变过、证明不了产物内容 ⇒ 这里直读产物逐层核验。
  // ⚠️ 两侧都钉：只钉 acacia 时 maxY 改成 7 也报错，但报错信息会指向错的一侧。
  {
    const R = fp.HULL_RECOLOR;
    const want = fp.SHIP_METRICS.hullRecolor;
    if (BLOCKS.find((b) => b.name === R.to)?.name !== R.to) {
      fail(`船身改色目标 "${R.to}" 未在 blocks-data.js 注册（光栅化会静默变空气）`);
    }
    if (!FACES_DATA[R.to]) fail(`船身改色目标 "${R.to}" 缺 FACES_DATA 贴图映射（会兜底成 stone）`);
    // 分界必须落在甲板面之下（甲板面 = 产物 y 7，围边算甲板 —— 用户 2026-11-02 裁定）
    if (R.maxY !== 9) fail(`HULL_RECOLOR.maxY = ${R.maxY} ≠ 9（用户裁定：改到 y≤9，桅杆/柱子保留）`);
  }

  // ③④ 逐个变体：stride / palette 注册 / bbox / 格数 / 归一化 / 朝向多样性
  const variants = shipData.MEDIEVAL_SHIP_VARIANTS;
  const loaded = new Map();
  for (const base of variants) {
    const file = path.join(ROOT, 'assets', 'structures', `${base}.json`);
    if (!fs.existsSync(file)) { fail(`缺产物 ${base}.json（跑 npm run ship）`); continue; }
    let json;
    try { json = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { fail(`${base}: 不是合法 JSON（重跑 npm run ship）`); continue; }
    loaded.set(base, json);

    const STRIDE = Number.isInteger(json.stride) ? json.stride : 4;
    if (STRIDE !== 5) {
      fail(`${base}: stride=${STRIDE} ≠ 5 —— 台阶/栏杆朝向（direction）没写进产物 → 全部按 orient=0 渲染`);
    }
    if (!Array.isArray(json.palette) || json.palette.length === 0) { fail(`${base}: palette 缺失或为空`); continue; }
    if (!Array.isArray(json.blocks) || json.blocks.length % STRIDE !== 0) {
      fail(`${base}: blocks 长度 ${json.blocks?.length} 不是 stride ${STRIDE} 的整数倍`); continue;
    }

    // palette 全部注册（否则光栅化时静默变空气）
    for (const name of json.palette) {
      if (REGISTRY.idOf(name) === undefined) {
        fail(`${base}: palette 含未注册方块 "${name}"（makeColumnSetter 静默跳过 → 船身出现洞）`);
      }
    }

    const n = json.blocks.length / STRIDE;
    const m = shipData.MEDIEVAL_SHIP_METRICS[base];
    if (!m) { fail(`${base}: MEDIEVAL_SHIP_METRICS 里没有它（产物与数据模块分家）`); continue; }
    if (n !== m.blocks) fail(`${base}: 格数 ${n} ≠ MEDIEVAL_SHIP_METRICS ${m.blocks}`);

    // ②b 船身改色落地 + **按 y 分层**（v2.36）
    // ⚠️ 只数总数拓不到「按源方块改」与「按 y 分层改」的区别（两者总数相同）：
    // `spruce_planks` 在 y 0..6、`stripped_dark_oak_wood` 在 y 6..7 都跨了分界线，
    // 只改 BLOCK_MAP 会把甲板围边一起染成勾棕而总数仍对。故这里直接按 y 逐格判。
    {
      const R = fp.HULL_RECOLOR;
      const want = fp.SHIP_METRICS.hullRecolor;
      let acacia = 0;
      let kept = 0;
      let above = 0;
      for (let i = 0; i < json.blocks.length; i += STRIDE) {
        const y = json.blocks[i + 1];
        const name = json.palette[json.blocks[i + 3]];
        if (name === R.to) { acacia++; if (y > R.maxY) above++; }
        else if (name === R.from) kept++;
      }
      if (acacia !== want.acacia) fail(`${base}: 船身改色 ${R.to} ${acacia} 格 ≠ ${want.acacia}（HULL_RECOLOR.maxY = ${R.maxY}？）`);
      if (kept !== want.keptOakPlanks1) fail(`${base}: 保留的 ${R.from} ${kept} 格 ≠ ${want.keptOakPlanks1}（桅杆/柱子应保留）`);
      if (above > 0) fail(`${base}: 有 ${above} 格 ${R.to} 落在 y > ${R.maxY}（改色层之外不该被染色）`);
    }

    // ②c 桅杆豁免落地（v2.37）：改色层（y ≤ maxY）内的 from 必须恰好是那 8 格桅杆。
    //
    // ⚠️ 为什么需要这项：`kept` 总数（86）只能证明「保留了多少」，区分不了
    // 「保留了桅杆」与「保留了其他格、同时把桅杆染了」—— 两者总数能凑对。
    // 而「改色层内仍为 from 的格数」是桅杆在层内的**唯一合法来源**（否则就是漏染），
    // 故它恰好等于 8（主/副桅杆各 4 格，全在 y=8）时两侧都卡死：多了 = 漏染、少了 = 桅杆被染。
    if (base === variants[0]) {
      const R = fp.HULL_RECOLOR;
      const wantMast = fp.SHIP_METRICS.hullRecolor.mastCellsInRange;
      let inRange = 0;
      for (let i = 0; i < json.blocks.length; i += STRIDE) {
        if (json.blocks[i + 1] <= R.maxY && json.palette[json.blocks[i + 3]] === R.from) inRange++;
      }
      if (inRange !== wantMast) {
        fail(`${base}: 改色层（y≤${R.maxY}）内仍有 ${inRange} 格 ${R.from}，应为 ${wantMast}`
          + '（主/副桅杆）—— 多了 = 漏染、少了 = 桅杆被染色');
      }
    }

    let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity, mnz = Infinity, mxz = -Infinity;
    const updownOrients = new Set();
    const railCounts = new Map();
    for (let i = 0; i < json.blocks.length; i += STRIDE) {
      const x = json.blocks[i], y = json.blocks[i + 1], z = json.blocks[i + 2];
      if (x < mnx) mnx = x; if (x > mxx) mxx = x;
      if (y < mny) mny = y; if (y > mxy) mxy = y;
      if (z < mnz) mnz = z; if (z > mxz) mxz = z;
      const name = json.palette[json.blocks[i + 3]];
      if (name === 'planks_step_updown') updownOrients.add(json.blocks[i + 4]);
      if (name === 'handrail' || name === 'handrailA' || name === 'vertical_pillar') {
        railCounts.set(name, (railCounts.get(name) || 0) + 1);
      }
    }
    const W = mxx - mnx + 1, H = mxy - mny + 1, D = mxz - mnz + 1;
    if (W !== m.width || H !== m.height || D !== m.depth) {
      fail(`${base}: 产物 bbox ${W}×${H}×${D} ≠ MEDIEVAL_SHIP_METRICS ${m.width}×${m.height}×${m.depth}`);
    }
    if (mny !== 1) fail(`${base}: 最低点 y=${mny} ≠ 1（归一化约定：rasterizeStructure 按 y + b.y - 1 落位）`);
    // 倒置台阶四向俱全（只钉格数抓不到「朝向全丢」）
    if (updownOrients.size !== 4) {
      fail(`${base}: 倒置台阶只出现 ${updownOrients.size} 种朝向（${[...updownOrients].sort().join(',')}）—— 四向都要有`);
    }

    // ⚠️⚠️ **栏杆类目标计数 = 「用户修复叠加层有没有被施加」的唯一判据**。
    //
    // 用户修复（把大量「孤立竖柱 / 转角件」换成有朝向的直段栏杆）的净效果是：
    // **格数 1263 不变 / bbox 37×37×11 不变 / 源栅栏 163 与源梯子 31 不变 /
    // palette 13 种不变 / 台阶 148 与半砖 146 不变** —— 上面每一条既有断言都逐位相同。
    // 所以「叠加层被漏掉」时它们**全绿**（典型的无效盲区）。唯一变化的是栏杆三兄弟的
    // 目标分布：handrail 21→6 / handrailA 15→120 / vertical_pillar 158→68。
    //
    // ⚠️ 这三个数是**旋转不变量**（旋转只改 meta、不改方块名），故可逐变体断言。
    const RAIL = fp.SHIP_METRICS.railCells;
    for (const [name, want] of Object.entries(RAIL)) {
      const got = railCounts.get(name) || 0;
      if (got !== want) {
        fail(`${base}: 栏杆类 "${name}" ${got} 格 ≠ SHIP_METRICS.railCells ${want}`
          + '（用户修复叠加层没施加？跑 npm run ship）');
      }
    }
  }

  // ④ 旋转变体自洽：o1/o2/o3 必须是 o0 旋转后的**同一艘船**（逐格重合）。
  //    这条是「船身转了但台阶朝向没跟着转」的唯一防线 —— 格数与 bbox 判据都拓不到它。
  if (loaded.size === variants.length) {
    const cellSet = (json) => {
      const s = new Set();
      for (let i = 0; i < json.blocks.length; i += json.stride) {
        s.add(`${json.blocks[i]},${json.blocks[i + 1]},${json.blocks[i + 2]}`);
      }
      return s;
    };
    const base0 = cellSet(loaded.get(variants[0]));
    // 与烘焙脚本同一份旋转公式（mesher 的 rotateOffset 是「朝向 → 几何」的唯一权威）
    const { rotateOffset } = await import('../src/mesh/mesher.js');
    for (let o = 1; o < 4; o++) {
      const target = cellSet(loaded.get(variants[o]));
      let best = 0;
      // 旋转后重新居中会产生 ±1 的平移差，故允许 3×3 平移搜索取最大重合
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          let hit = 0;
          for (const key of base0) {
            const [x, y, z] = key.split(',').map(Number);
            const [rx, , rz] = rotateOffset(x, 0, z, o);
            if (target.has(`${rx + dx},${y},${rz + dz}`)) hit++;
          }
          if (hit > best) best = hit;
        }
      }
      if (best !== base0.size) {
        fail(`${variants[o]} 与 ${variants[0]} 旋转后只重合 ${best}/${base0.size} 格 —— 旋转变体不自洽（朝向或坐标转错了）`);
      }
    }
  }

  // ⑤⑦ 两个新方块的声明契约
  const NEW_BLOCKS = [
    ['planks_step_updown', 'planks_step_updown', 4],
    ['half_block_updown', 'half_block_updown', 0],
  ];
  for (const [name, geom, orientModes] of NEW_BLOCKS) {
    const def = BLOCKS.find((b) => b.name === name);
    if (!def) { fail(`${name} 未在 blocks-data.js 注册（光栅化会静默变空气）`); continue; }
    if (def.geometry !== geom) fail(`${name}: geometry 应为 "${geom}"，实际 "${def.geometry}"`);
    // ⚠️ 非 box 几何必须显式 opaque:false（AGENTS.md 既有约束）：否则将来 cullMode 被改成
    // opaque 会静默误推 opaqueTable=1 → mesher 剔邻居面 → 船身出现洞。
    if (def.opaque !== false) fail(`${name}: 必须显式声明 "opaque":false（非 box 几何的既有约束）`);
    if (def.cullMode !== 'cutout') fail(`${name}: cullMode 应为 cutout，实际 "${def.cullMode}"`);
    if (def.orientationModes !== orientModes) {
      fail(`${name}: orientationModes 应为 ${orientModes}，实际 ${def.orientationModes}`);
    }
    if (!FACES_DATA[name]) fail(`${name}: FACES_DATA 缺贴图映射（会兜底成 stone）`);
    // ⑦ 必须进背包（用户明确要求）：不在任何一个排除清单里
    if (NON_PLACEABLE_ITEMS.includes(name)) fail(`${name} 被塞进 NON_PLACEABLE_ITEMS（用户要求进背包）`);
    if (HIDDEN_FROM_INVENTORY.includes(name)) fail(`${name} 被塞进 HIDDEN_FROM_INVENTORY（用户要求进背包）`);
  }
  // 倒置半砖的几何必须是「贴顶」（与 half_block 的贴底互补）—— 形状权威在 mesher.js
  const { TEMPLATES } = await import('../src/mesh/mesher.js');
  const yRange = (quads) => {
    let lo = Infinity, hi = -Infinity;
    for (const q of quads) for (const v of q.v) { if (v[1] < lo) lo = v[1]; if (v[1] > hi) hi = v[1]; }
    return [lo, hi];
  };
  const [upLo, upHi] = yRange(TEMPLATES.half_block_updown);
  const [dnLo, dnHi] = yRange(TEMPLATES.half_block);
  if (Math.abs(upLo - 0.5) > 1e-9 || Math.abs(upHi - 1) > 1e-9) {
    fail(`half_block_updown 的 y 范围是 [${upLo},${upHi}]，应为 [0.5,1]（贴顶半砖）`);
  }
  if (Math.abs(dnLo - 0) > 1e-9 || Math.abs(dnHi - 0.5) > 1e-9) {
    fail(`half_block 的 y 范围变成 [${dnLo},${dnHi}]，应为 [0,0.5]（贴底半砖，既有几何被改坏了）`);
  }
  // 倒置台阶必须是 planks_step 的**精确上下颠倒**（高侧方向逐 orient 相同）
  const [sLo, sHi] = yRange(TEMPLATES.planks_step);
  const [uLo, uHi] = yRange(TEMPLATES.planks_step_updown);
  if (Math.abs(sLo - uLo) > 1e-9 || Math.abs(sHi - uHi) > 1e-9) {
    fail(`planks_step 与 planks_step_updown 的 y 范围不同（[${sLo},${sHi}] vs [${uLo},${uHi}]）—— 两者应同高，只是半幅层上下对调`);
  }

  // ⚠️ 成功行的条件必须涵盖**本函数全部判据**（同 [巨型金字塔] 的教训）
  if (failures.length === before) {
    const RAIL = fp.SHIP_METRICS.railCells;
    const HULL = fp.SHIP_METRICS.hullRecolor;
    const R = fp.HULL_RECOLOR;
    const sizes = variants.map((v) => {
      const m = shipData.MEDIEVAL_SHIP_METRICS[v];
      return `${m.width}×${m.height}×${m.depth}`;
    });
    infos.push(`[中世纪船] ${variants.length} 个旋转变体（${sizes.join(' / ')}）各 ${meta.blocks} 格 / `
      + `stride 5 + 倒置台阶四向俱全 / 变体间逐格自洽 / palette ${meta.paletteSize} 种全注册 / `
      + `台阶 ${meta.stepCells}（正置 ${meta.counts?.planks_step} + 倒置 ${meta.counts?.planks_step_updown}）`
      + ` 半砖 ${meta.slabCells} / `
      + `船身改色 y≤${R.maxY} ${R.from}→${R.to} ${HULL.acacia} 格（保留 ${R.from} ${HULL.keptOakPlanks1} 格） / `
      + `用户修复叠加层已施加（set ${meta.userFix?.set} 含新增 ${meta.userFix?.added} / remove ${meta.userFix?.removed}）`
      + ` → 栏杆 handrail ${RAIL.handrail} + handrailA ${RAIL.handrailA} + 竖柱 ${RAIL.vertical_pillar} / `
      + `FACING_TO_ORIENT 与金字塔同源 / 2 个新方块已注册且进背包 / 指纹匹配`);
  }
}

// ---------------------------------------------------------------- [草贴图] 契约（v2.11）

/**
 * [草贴图] 契约：两个产物 PNG 存在、均值与源图差 ≤2/通道、源图未改。
 *
 * 钉的失效路径：改源图不重烘（产物过期）、烘焙算法退化（nearest 缩图会让均值偏移且丢失色阶）。
 * ⚠️ **判据是「均值偏差 ≤2/通道」而不是「文件存在」**：nearest 降采样的均值也会接近源图，
 * 所以这条拦不住它 —— 真正的防线是「源图 736 必须被 46 整除」（烘焙脚本 throw）
 * 与输出尺寸 16×16。两者都在烘焙脚本里硬断言。
 */
function checkGrassTextures() {
  const before = failures.length;
  const fail = (m) => failures.push(`[草贴图] ${m}`);

  const metaPath = GRASS_TEX.GRASS_META;
  if (!fs.existsSync(metaPath)) { fail('缺 meta（跑 npm run grasstextures）'); return; }
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const fp = GRASS_TEX.grassTextureInputFingerprint();
  if (meta.fingerprints?.input !== fp.input) {
    fail(`烘焙指纹不匹配（跑 npm run grasstextures）：当前 ${fp.input.slice(0, 12)}…`);
  }
  const sizes = [];
  for (const name of Object.keys(GRASS_TEX.GRASS_TEXTURES)) {
    const out = GRASS_TEX.outputPath(name);
    if (!fs.existsSync(out)) { fail(`缺产物 ${GRASS_TEX.GRASS_TEXTURES[name].out}（跑 npm run grasstextures）`); continue; }
    const png = PNG.sync.read(fs.readFileSync(out));
    if (png.width !== GRASS_TEX.GRASS_TILE_SIZE || png.height !== GRASS_TEX.GRASS_TILE_SIZE) {
      fail(`${name}: 产物尺寸 ${png.width}×${png.height} ≠ ${GRASS_TEX.GRASS_TILE_SIZE}×${GRASS_TEX.GRASS_TILE_SIZE}`);
    }
    const rec = meta.textures?.[name];
    if (!rec) { fail(`${name}: meta 里没有该贴图的记录`); continue; }
    let r = 0, g = 0, b = 0;
    const np = png.width * png.height;
    for (let i = 0; i < png.data.length; i += 4) { r += png.data[i]; g += png.data[i + 1]; b += png.data[i + 2]; }
    const got = [r / np, g / np, b / np];
    const delta = got.map((v, i) => Math.abs(v - rec.sourceMean[i]));
    if (delta.some((d) => d > 2)) {
      fail(`${name}: 产物均值偏离源图 ${delta.map((d) => d.toFixed(2)).join('/')} > 2/通道`);
    }
    if (rec.sourceSha256 !== GRASS_TEX.fileSha256(GRASS_TEX.sourcePath(name))) {
      fail(`${name}: 源图字节变了但未重烘（跑 npm run grasstextures）`);
    }
    sizes.push(`${name} ${got.map((v) => v.toFixed(0)).join('/')}`);
  }

  if (failures.length === before) {
    infos.push(`[草贴图] ${sizes.join(' · ')}（16×16，源图 46×46 盒式平均，均值偏差 ≤2）`);
  }
}

// ---------------------------------------------------------------- [树叶剔除] 契约（v1.70）

/**
 * [树叶剔除] 契约：**每个带镂空的方块都必须是镂空遮挡体**，不是镂空的不得混进来。
 *
 * 背景（2026-10-23 用户报告）：普通树叶改成透明后，
 * 「方块紧挨着的背后的不透明实心方块的面是看不到的」→ 透过叶孔可以看穿背后的内容。
 * 根因 = mesher 的面剔除只看 `opaqueTable[neighbor] === 1`，而树叶的 `opaqueTable` 是 1
 * （它是叶-叶共享面互剔的收益来源）→ 实心方块朝叶的那一面被剔掉。
 * 修法 = `hollowOccluderTable`（由 cullMode=cutout + opaqueTable=1 **派生**），
 * 命中时**不剔**邻居方块朝向它的那一面。
 *
 * 钉的失效路径（均为**静默**失败 —— 不报错，只是画面穿帮或顶点暴涨）：
 *   ① 新增镂空方块却漏写 `opaque:true` → 它不是镂空遮挡体 → 自己叶-叶共享面不剔，顶点 ×3.4
 *      （`azalea_flowers` 的历史漏网，v1.70 一并修掉）；
 *   ② 把 `hollowOccluderTable` 改成字面量名单 → 新方块不在名单里 → 又看穿背后（红线 1）；
 *   ③ `hollowOccluderTable` 退化成「所有 opaque 方块」→ 全世界不再互剔，顶点灾难。
 */
function checkLeafCullingContract() {
  const before = failures.length;
  const fail = (m) => failures.push(`[树叶剔除] ${m}`);

  // ① 带镂空的方块（geometry=box + 有孔洞贴图的那一族）必须全部是镂空遮挡体。
  //    用「已登记的树叶族」作判据：它们按名字约定集中（`*_leaves` + azalea_flowers）——
  const LEAF_FAMILY = BLOCKS.filter((b) => b.name.endsWith('_leaves') || b.name === 'azalea_flowers').map((b) => b.name);
  // 6 普通树叶 + 6 巨树叶 + azalea_flowers + sky_leaves。
  // ⚠️ **2026-11-04：`realistic_oak_leaves` 已按用户裁定删除**（14 → 13）。
  const EXPECT_LEAF_FAMILY_SIZE = 13;
  if (LEAF_FAMILY.length !== EXPECT_LEAF_FAMILY_SIZE) {
    fail(`树叶族方块数 ${LEAF_FAMILY.length} ≠ ${EXPECT_LEAF_FAMILY_SIZE}（新增/删除树叶族时须同步本门禁与 blocks-data 注释）：${LEAF_FAMILY.join(', ')}`);
  }
  for (const n of LEAF_FAMILY) {
    const def = BLOCKS.find((b) => b.name === n);
    const id = REGISTRY.idOf(n);
    if (id === undefined) { fail(`"${n}" 不在 registry 内`); continue; }
    // sky_leaves 例外：它走 opaque 通道（材质无 alphaTest）→ 无孔洞，不是镂空遮挡体
    if (n === 'sky_leaves') {
      if (REGISTRY.hollowOccluderTable[id] !== 0) fail('sky_leaves 走 opaque 通道，不应是镂空遮挡体');
      continue;
    }
    if (def.cullMode !== 'cutout') { fail(`"${n}" 的 cullMode=${def.cullMode}（必须是 cutout 才有镂空）`); continue; }
    if (REGISTRY.opaqueTable[id] !== 1) { fail(`"${n}" 的 opaqueTable=0（漏写 opaque:true → 自己叶-叶共享面不剔，顶点 ×3.4）`); continue; }
    if (REGISTRY.hollowOccluderTable[id] !== 1) {
      fail(`"${n}" 的 hollowOccluderTable=0（表未写入 —— 邻居方块朝它的面会被剔除 → 透过叶孔看穿背后）`);
    }
  }

  // ② 临界对照：普通实心方块**不得**是镂空遮挡体（否则全世界不再互剔，顶点灾难）
  for (const n of ['stone', 'wood', 'dirt', 'grass', 'glass_block', 'water', 'cloud']) {
    const id = REGISTRY.idOf(n);
    if (id !== undefined && REGISTRY.hollowOccluderTable[id] !== 0) {
      fail(`"${n}" 不是镂空方块，被误判为镂空遮挡体（会让它与邻居的面全部保留，顶点暴涨）`);
    }
  }

  if (failures.length === before) {
    const n = LEAF_FAMILY.filter((x) => x !== 'sky_leaves').length;
    infos.push(`[树叶剔除] ${n} 个镂空遮挡体（实心方块朝树叶的面不再剔）+ sky_leaves 例外（opaque 通道，无镂空）`);
  }
}


// ---------------------------------------------------------------- [杜鹃树] 契约（Azalea Trees Epic）

/**
 * [杜鹃树] 契约：烘焙产物（trees.json）+ 方块声明 + 运行时常量三方必须对得上。
 *
 * 钉的失效路径（每条都实测注入过，见本 Epic 的负向验证记录）：
 *   ① 烘焙输入（.schem）或映射表改了却没重烘焙 → 产物静默过期（渲染旧树形，方块层面完全看不出）；
 *   ② palette 里出现未注册方块名 → `makeColumnSetter` 对未注册名**静默跳过** → 该格变 air
 *      （树上有洞，肉眼只觉得「形状怪怪的」）；
 *   ③ 叶子槽从 `LEAF` 哨兵变成具体方块 → 花的位置被素材作死，与用户裁定的「30% 概率相间」冲突；
 *   ④ 树干槽不是 `azalea_log` → 用户裁定的替换目标被改（观感与旧杜鹃树脱节）；
 *   ⑤ 10 档尺寸/格数与实测不符 → 切分或映射被改动（相邻地台的叶子被算进 bbox 是最常见的一种）；
 *   ⑥ 运行时 `AZALEA_VARIANT_COUNT` 与产物档数不一致 → 候选里的档位下标越界、
 *      永远只能落前几档（世界里只有一种尺寸的树）。
 *
 * ⚠️ **成功行的条件必须涵盖本函数全部判据**，否则失败时仍会打印一条 ✓
 *    （本仓已发生过：`[高台]` 判据只看 palette.length，注入砖块时同时打印「✗ 含砖块」与「✓」）。
 */
async function checkAzaleaTrees() {
  const fp = await import('./azalea-trees-fingerprint.mjs');
  const before = failures.length;
  const fail = (m) => failures.push(`[杜鹃树] ${m}`);

  // ① 烘焙输入（入库）与产物
  if (!fs.existsSync(fp.SCHEM_PATH)) {
    fail(`烘焙输入缺失 ${path.relative(ROOT, fp.SCHEM_PATH)}（.schem 入库，缺失 = 仓库损坏）`);
    return;
  }
  if (!fs.existsSync(fp.TREES_JSON) || !fs.existsSync(fp.TREES_META)) {
    fail('缺 assets/azalea-trees/trees.json 或 trees.meta.json（跑 npm run azaleatrees）');
    return;
  }
  let meta, trees;
  try {
    meta = JSON.parse(fs.readFileSync(fp.TREES_META, 'utf8'));
    trees = JSON.parse(fs.readFileSync(fp.TREES_JSON, 'utf8')).trees;
  } catch { fail('trees.json / trees.meta.json 不是合法 JSON（重跑 npm run azaleatrees）'); return; }

  // ② 指纹（入库 .schem 内容 + 全部烘焙参数）
  const cur = fp.azaleaTreesInputFingerprint();
  if (meta.fingerprints?.input !== cur.input) {
    fail(`产物已过期：指纹不匹配（烘焙时 "${meta.fingerprints?.input}" vs 当前 "${cur.input}"）→ 跑 npm run azaleatrees`);
  }

  // ③ 档数 / 叶子槽 / 每档尺寸与格数
  if (!Array.isArray(trees)) { fail('trees.json 的 trees 不是数组'); return; }
  if (trees.length !== fp.VARIANT_COUNT) fail(`档数 ${trees.length} ≠ VARIANT_COUNT ${fp.VARIANT_COUNT}（跑 npm run azaleatrees）`);
  if (meta.variantCount !== trees.length) fail(`meta.variantCount ${meta.variantCount} ≠ 产物档数 ${trees.length}`);
  if (meta.leafSlot !== fp.LEAF_SLOT) fail(`meta.leafSlot "${meta.leafSlot}" ≠ "${fp.LEAF_SLOT}"（叶子须走哨兵槽，运行时才按 30% 掷花）`);

  let total = 0;
  trees.forEach((v, i) => {
    const exp = fp.SIZE_EXPECTATIONS[i];
    if (!exp) { fail(`第 ${i} 档没有对应的 SIZE_EXPECTATIONS（档数被改动？）`); return; }
    if (v.w !== exp.w || v.d !== exp.d || v.h !== exp.h) {
      fail(`第 ${i} 档尺寸 ${v.w}×${v.d}×${v.h} ≠ 实测 ${exp.w}×${exp.d}×${exp.h}（切分/映射被改动，或按整行而非按地台裁剪）`);
    }
    const n = v.blocks.length / 4;
    if (n !== exp.cells) fail(`第 ${i} 档格数 ${n} ≠ 实测 ${exp.cells}`);
    total += n;

    // ④ palette 契约：树干 = azalea_log、叶子槽 = LEAF 哨兵、二者都在 registry
    if (JSON.stringify(v.palette) !== JSON.stringify(fp.PALETTE)) {
      fail(`第 ${i} 档 palette ${JSON.stringify(v.palette)} ≠ ${JSON.stringify(fp.PALETTE)}（trees.json 被手改？）`);
    }
    if (v.palette[0] !== 'azalea_log') fail(`第 ${i} 档 palette[0] "${v.palette[0]}" ≠ azalea_log（用户裁定的树干替换目标）`);
    if (v.palette[1] !== fp.LEAF_SLOT) fail(`第 ${i} 档 palette[1] "${v.palette[1]}" ≠ "${fp.LEAF_SLOT}"（叶子必须走哨兵槽，否则花位被素材作死）`);
    if (REGISTRY.idOf('azalea_log') === undefined) fail('azalea_log 不在 registry（makeColumnSetter 会静默跳过 → 树干变 air）');

    // ⑤ 锚点必须在 bbox 内且落在某个 y=0 树干格上（光栅化按它对齐候选点）
    if (!Array.isArray(v.anchor) || v.anchor[0] < 0 || v.anchor[0] >= v.w || v.anchor[1] < 0 || v.anchor[1] >= v.d) {
      fail(`第 ${i} 档锚点 ${JSON.stringify(v.anchor)} 越界（w=${v.w} d=${v.d}）`);
    }
  });
  if (total < fp.TOTAL_BLOCKS_RANGE[0] || total > fp.TOTAL_BLOCKS_RANGE[1]) {
    fail(`10 档共 ${total} 格，不在实测区间 [${fp.TOTAL_BLOCKS_RANGE}]（映射表/切分被改动？）`);
  }

  // ⑥ 运行时常量与产物一致（src 侧不能自己写死一个不同的档数）
  const mod = await import(pathToFileURL(path.join(ROOT, 'src/gen/structures/azalea-trees.js')).href);
  if (mod.AZALEA_VARIANT_COUNT !== trees.length) {
    fail(`src 的 AZALEA_VARIANT_COUNT=${mod.AZALEA_VARIANT_COUNT} ≠ 产物档数 ${trees.length}（候选档位下标会越界）`);
  }
  if (mod.AZALEA_FLOWER_CHANCE !== 0.3) {
    fail(`AZALEA_FLOWER_CHANCE=${mod.AZALEA_FLOWER_CHANCE} ≠ 0.3（用户 2026-10-28 裁定：沿用旧杜鹃树的 30%）`);
  }
  // 树干间距判据：常量与判据入口都要在
  // ⚠️ 阈值 v2.5 从 6 降到 3（用户 2026-10-29 裁定「别留空」）—— 这**有意推翻** v2.0 的
  // 「树干要隔开」，两条需求直接对立。改回疏林只需把这个数改回 6（门禁与 E2E 都从它派生）。
  if (mod.AZALEA_TRUNK_CLEARANCE !== 3) {
    fail(`AZALEA_TRUNK_CLEARANCE=${mod.AZALEA_TRUNK_CLEARANCE} ≠ 3（用户 2026-10-29 裁定：填满空地，树干间距 ≥3 格）`);
  }
  if (typeof mod.acceptAzaleaTrunks !== 'function' || typeof mod.collectOtherTrunks !== 'function') {
    fail('缺 acceptAzaleaTrunks / collectOtherTrunks（树干间距判据的接线入口）');
  }
  // 密度：**C=8**（v2.5；v2.4 是 11）。C 才是密度的真正旋钮 —— 不是 jitter。
  if (mod.AZALEA_TREE_PATH.spacing !== 2 || mod.AZALEA_TREE_PATH.jitter !== 6) {
    fail(`AZALEA_TREE_PATH spacing/jitter = ${mod.AZALEA_TREE_PATH.spacing}/${mod.AZALEA_TREE_PATH.jitter} ≠ 2/6` +
      '（用户 2026-10-29「别留空、都给我种上」：C=8 时叶面覆盖 87.7%、空地仅 3.5%）');
  }
  // ⭐ C 与「构造性最小锚距」都是派生量，必须自洽：
  //   ① C = spacing + jitter = 8
  //   ② 构造性最小锚距 = C − (jitter − 1) = 3 —— 不得小于树干间距阈值
  //     （v2.5 有意让二者相等：网格不再保证间距，全交给 acceptAzaleaTrunks 贪心）
  if (mod.AZALEA_TREE_PATH.spacing + mod.AZALEA_TREE_PATH.jitter !== 8) {
    fail(`C = ${mod.AZALEA_TREE_PATH.spacing + mod.AZALEA_TREE_PATH.jitter} ≠ 8`);
  }
  {
    const minAnchor = mod.AZALEA_TREE_PATH.spacing + 1;
    if (minAnchor < mod.AZALEA_TRUNK_CLEARANCE) {
      fail(`构造性最小锚距 ${minAnchor} < AZALEA_TRUNK_CLEARANCE ${mod.AZALEA_TRUNK_CLEARANCE}` +
        ' —— 网格会允许比树干间距阈值更近的锚点，成片双拒');
    }
  }
  // 高矮错落（v2.3：两类棋盘）：类别表必须与产物实际高度对得上，且正交相邻必然异类
  {
    const byClass = [[], []];
    for (let i = 0; i < mod.AZALEA_VARIANT_COUNT; i++) byClass[mod.azaleaSizeClass(i)].push(i);
    const want = mod.AZALEA_STAGGER_CLASSES.map((a) => a.join(','));
    const got = byClass.map((a) => a.join(','));
    if (want.join('|') !== got.join('|')) {
      fail(`档位类别表 [${want.join(' | ')}] 与按 azaleaSizeClass 反查的结果 [${got.join(' | ')}] 不一致`);
    }
    const lens = mod.AZALEA_STAGGER_CLASSES.map((a) => a.length);
    if (lens.join(',') !== '3,7') fail(`两类档位数 ${lens.join(',')} ≠ 3,7`);
    // ⭐ 主判据：**粗格内的正交相邻必然异类**（棋盘不变式，「一个高树挨着它的应该是矮树」）
    //
    // ⚠️ **不能写「全国范围正交同类 === 0」**（实测踩过，会把正确实现判 FAIL）：
    // 低频扰动的相位**逐粗格**取，跨粗格的那一层相邻对两侧相位可能翻转 ⇒ 必然同类。
    // 实测：粗格内 0/22720（必为 0）、跨粗格 1170/2880 = 40.6%、全国口径 0.0457。
    //
    // ⚠️ **v2.2 的「8 邻域同类率 < 独立抽签」口径对两类方案结构性失效**：
    // 棋盘结构下**对角相邻必然同类** ⇒ 8 邻域同类率恒 ≈ 50%，不可能低于独立抽签。
    const SC = mod.AZALEA_STAGGER_CELL;
    const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let sameIn = 0, sameAll = 0, totAll = 0;
    for (let i = -20; i < 20; i++) {
      for (let j = -20; j < 20; j++) {
        const c = mod.azaleaSizeClass(mod.azaleaStaggeredSizeIdx(i, j, 12345));
        for (const [di, dj] of ORTH) {
          const eq = c === mod.azaleaSizeClass(mod.azaleaStaggeredSizeIdx(i + di, j + dj, 12345));
          totAll++;
          if (!eq) continue;
          sameAll++;
          if (Math.floor(i / SC) === Math.floor((i + di) / SC)
            && Math.floor(j / SC) === Math.floor((j + dj) / SC)) sameIn++;
        }
      }
    }
    if (sameIn !== 0) {
      fail(`粗格内的正交相邻同类 ${sameIn} 对（**必须为 0**）—— ` +
        '棋盘不变式被破坏（用户 2026-10-28 要求「一个高树挨着它的应该是矮树」）');
    }
    // 全国口径的同类型率必须远低于两类独立抽签的 Σp² = 0.09 + 0.49 = 0.58（实测 0.046）
    if (!(sameAll / totAll < 0.2)) {
      fail(`全国正交同类率 ${(sameAll / totAll).toFixed(3)} 应远低于两类独立抽签的 0.58`);
    }
    // 两类的最小可辨差必须 ≥ 4 格（v2.2 的中→高只差 1 格，那就是「错落看不出来」的根因）
    const heights = (trees || []).map((t) => t.h);
    if (heights.length === mod.AZALEA_VARIANT_COUNT) {
      const lowMax = Math.max(...mod.AZALEA_STAGGER_CLASSES[0].map((i) => heights[i]));
      const highMin = Math.min(...mod.AZALEA_STAGGER_CLASSES[1].map((i) => heights[i]));
      if (highMin - lowMax < 4) {
        fail(`两类最小可辨差 ${highMin - lowMax} 格（矮最高 ${lowMax} / 高最低 ${highMin}）应 ≥ 4`);
      }
    }
  }
  // AZALEA biome 面积（v2.0 用户要求扩大 50%：4.6% → ≈6.7%）
  const noiseMod = await import(pathToFileURL(path.join(ROOT, 'src/gen/noise.js')).href);
  let azN = 0, tot = 0;
  for (let x = -600; x <= 600; x += 4) {
    for (let z = -600; z <= 600; z += 4) { tot++; if (noiseMod.getBiome(x, z, 12345) === 'AZALEA') azN++; }
  }
  const azFrac = azN / tot;
  if (azFrac < 0.06 || azFrac > 0.075) {
    fail(`AZALEA 面积占比 ${(azFrac * 100).toFixed(1)}% 不在 [6.0%, 7.5%]（v2.0 定标 6.66%；改 AZALEA_TEMP_MIN 后须重测）`);
  }
  // 旧树必须已停用（否则新大树与旧小树叠在一起）
  const veg = await import(pathToFileURL(path.join(ROOT, 'src/gen/structures/vegetation.js')).href);
  let oldTreeHits = 0;
  for (let wx = -400; wx <= 400; wx += 11) {
    for (let wz = -400; wz <= 400; wz += 11) {
      if (veg.rollVegetation(wx, wz, 'AZALEA', 12345).tree) oldTreeHits++;
    }
  }
  if (oldTreeHits > 0) fail(`rollVegetation 的 AZALEA 分支仍在返回旧小树（${oldTreeHits} 次命中）—— 会与新树叠在一起`);

  if (failures.length === before) {
    infos.push(`[杜鹃树] ${trees.length} 档（${meta.sizes.join(' ')}）共 ${total} 格，树干 azalea_log、叶子 LEAF 哨兵按 30% 掷花、指纹匹配、旧小树已停用；间距 ≥${mod.AZALEA_TRUNK_CLEARANCE} 格、密度 C=${mod.AZALEA_TREE_PATH.spacing + mod.AZALEA_TREE_PATH.jitter}、AZALEA 面积 ${(azFrac * 100).toFixed(1)}%、高矮错落（两类棋盘：正交相邻异类、最小可辨差 ≥4 格）`);
  }
}

// ---------------------------------------------------------------- 主流程

/**
 * 音效与启动图素材契约（v2.51）。
 *
 * 钉三件事：
 *   ① `SOUND_IDS` 里每个 id 都有 `assets/sounds/<id>.mp3` —— 漏一个的形态是**静默无声**
 *     （`preload()` 的 catch 只 console.warn，页面照常能玩）；
 *   ② `BGM_TRACKS` 同理（三首随机选，缺一首就有一半开局时间没音乐）；
 *   ③ loading 占位图与 favicon 素材存在（缺了就是破图 + 空白图标）。
 *
 * ⚠️ **清单必须从运行时代码 import**：在门禁里再写一份 id 列表就是红线 1 的第二份权威，
 * 改了 `SOUND_IDS` 而忘改门禁时它仍然全绿。
 */
function checkAudioAssets() {
  const missing = [];
  for (const id of SOUND_IDS_FOR_GATE) {
    if (!fs.existsSync(path.join(ROOT, 'assets', 'sounds', `${id}.mp3`))) missing.push(`音效 ${id}.mp3`);
  }
  for (const id of BGM_TRACKS) {
    if (!fs.existsSync(path.join(ROOT, 'assets', 'sounds', `${id}.mp3`))) missing.push(`背景音乐 ${id}.mp3`);
  }
  for (const f of ['Minecraft-Logo.png', 'icon.png']) {
    if (!fs.existsSync(path.join(ROOT, 'assets', 'ui', f))) missing.push(`启动图 assets/ui/${f}`);
  }
  if (missing.length > 0) {
    failures.push(`[音效] 缺素材或清单与磁盘不一致：${missing.join(', ')}`);
    return;
  }
  infos.push(`[音效] ${SOUND_IDS_FOR_GATE.length} 个效果音 + ${BGM_TRACKS.length} 首背景音乐（${BGM_TRACKS.join('/')}）均有对应 mp3；启动图 assets/ui/ 两件齐备`);
}

const REGISTRY = await buildDefaultRegistry();

checkAudioAssets();         // v2.51：音效/音乐/启动图素材与清单一致性（⚠️ 漏了本行则门禁永不执行）

checkReferenceIntegrity();
checkItemSetRelation();
checkIndestructibleContract();
checkShadowCastContract();   // v1.45：阴影投射排除集合契约（⚠️ 主流程是逐个显式调用，漏了本行则门禁永不执行）
checkPlaygroundContract();   // M9：创造台方块契约（⚠️ 主流程是逐个显式调用，漏了本行则门禁永不执行）
checkMinecartContract();     // 矿车：mine_cart 与铁轨必须在背包（⚠️ 漏了本行则门禁永不执行）
await checkLeafTextures();   // 2026-10-23：全部树叶的孔洞压缩产物（⚠️ 漏了本行则门禁永不执行）
await checkWaterTextures();  // v1.84：水体贴图与海面平面的配色对齐（⚠️ 漏了本行则门禁永不执行）
checkIconManifestCoverage();
checkIconAtlasArtifacts();
checkIconFreshness();
checkTestRegistration();
checkGeometryAuthority();
await checkScatterStructureIntegrity();
checkStructureJsonOrphans();   // 2026-09-30：tall_well 悬空宝箱回归防线（⚠️ 漏了本行则门禁永不执行）
checkZombieSkinTexture();
checkDragonAsset();          // v2.41：祭坛飞龙烘焙产物契约与指纹（⚠️ 漏了本行则门禁永不执行）
checkIgnisAsset();           // v2.55：焰魔烘焙产物契约与指纹（⚠️ 同上）
checkTurretArmorTexture();
checkSkyboxAssets();         // v1.58：天空盒立方图完整性（⚠️ 漏了本行则门禁永不执行）
await checkNightSkyFreshness(); // v1.60：夜空烘焙产物指纹（⚠️ 漏了本行则门禁永不执行）
await checkGiantTrees();     // 巨树景观：方块/烘焙产物/贴图三方契约（⚠️ 漏了本行则门禁永不执行）
await checkAzaleaTrees();    // 杜鹃树：烘焙产物/方块声明/运行时常量三方契约（⚠️ 漏了本行则门禁永不执行）
await checkCloudlandTarnZone(); // 高台地带：35 产物/映射表/通道/台顶材质契约（⚠️ 漏了本行则门禁永不执行）
await checkGiantPyramid();   // 巨型金字塔：烘焙产物/映射表/通道契约（⚠️ 漏了本行则门禁永不执行）
await checkArena();          // 竞技场：烘焙产物/栏杆朝向/floorRow/占地尺寸契约（⚠️ 漏了本行则门禁永不执行）
await checkShallowTarns();   // 浅水高台：5 产物/palette 白名单/源方块映射/草基准色/尺寸契约
await checkMedievalShip();   // 中世纪船：4 旋转变体/朝向自洽/新方块声明/朝向表同源（⚠️ 漏了本行则门禁永不执行）
checkGrassTextures();        // 草贴图：两个 16×16 产物 + 均值偏差 + 源图未改
checkLeafCullingContract();  // v1.70：镂空遮挡体派生表与树叶族声明的一致性（⚠️ 漏了本行则门禁永不执行）

console.log('[check:data] 数据契约检查');
for (const i of infos) console.log(`  ✓ ${i}`);

if (failures.length) {
  console.error(`\n[check:data] ✗ ${failures.length} 项契约违规：`);
  for (const f of failures) console.error(`  ${f}`);
  console.error('\n处置：这类错误**免 TDD 流程**（Tier 2），改完重跑本脚本即可。');
  console.error('      若是资源引用/贴图地址改动导致，直接改数据源，不需要先写失败测试。');
  process.exit(1);
}
console.log('[check:data] ✓ 数据契约全部一致');
