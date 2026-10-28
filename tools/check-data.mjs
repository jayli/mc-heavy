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
// 丧尸头部纹理的图案参数与指纹走共享模块（红线 1：与烘焙脚本同一份逻辑）
const {
  HEAD_PNG, HEAD_JSON, HEAD_WIDTH, HEAD_HEIGHT, EYE_CELLS, headInputFingerprint,
  HEAD_TEXTURE_CONFIG,
} = await import('./zombie-head-fingerprint.mjs');
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
// 矿车冻结数据 —— 门禁据此断言铁轨类型集合与 config 单一权威一致（红线 1）
const {
  MINECART_ITEM, TRACK_BLOCK_TYPES,
} = await import('../src/entities/minecarts/minecart-config.js');

const SKYBOX = await import('../src/render/sky-config.js');
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

// ---------------------------------------------------------------- [9] 丧尸头部纹理契约

/**
 * 丧尸头部马赛克纹理的三个环节必须齐全，否则头部图案**静默缺失**。
 *
 * 失效路径与图标过期同类（v1.24 记录过「改 mesher 几何忘跑 atlas」）：纹理是**派生产物**，
 * 权威输入是 `tools/zombie-head-fingerprint.mjs` 的图案参数。改了参数却忘跑 `npm run zombie`
 * → 渲染旧图案（肉眼看不出「图案过期」，只觉得「颜色怪怪的」）。
 *
 * 三条断言：
 *   ① PNG 存在 + 尺寸 = 128×64（双区并排）→ 缺文件时 `loadAsync` 抛错，game.js 的 catch
 *      会退回纯色头（**静默降级**，不阻断启动 → 只有门禁能抓）
 *   ② 黑像素数 = 眼睛格数 × mosaicSize²（**关系型**，不硬编码 128）→ 抓「眼睛画错位置/数量」
 *   ③ 输入指纹匹配 → 抓「改了参数忘重烘」。指纹逻辑走共享模块（红线 1：与烘焙脚本同一份，
 *      两处漂移会误判）
 */
function checkZombieHeadTexture() {
  if (!fs.existsSync(HEAD_PNG)) {
    failures.push('[丧尸头部] assets/zombie/head.png 不存在 —— 跑 npm run zombie');
    return;
  }
  const png = PNG.sync.read(fs.readFileSync(HEAD_PNG));
  if (png.width !== HEAD_WIDTH || png.height !== HEAD_HEIGHT) {
    failures.push(`[丧尸头部] PNG ${png.width}×${png.height} 与期望 ${HEAD_WIDTH}×${HEAD_HEIGHT} 不符（烘焙到一半失败？）`);
    return;
  }

  // ② 黑像素数（关系型：眼睛格数 × 每格像素数）
  const expectBlack = EYE_CELLS * HEAD_TEXTURE_CONFIG.mosaicSize * HEAD_TEXTURE_CONFIG.mosaicSize;
  let black = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i] === 0 && png.data[i + 1] === 0 && png.data[i + 2] === 0) black++;
  }
  if (black !== expectBlack) {
    failures.push(`[丧尸头部] 黑像素 ${black} 个 ≠ 期望 ${expectBlack}（${EYE_CELLS} 个眼睛格 × `
      + `${HEAD_TEXTURE_CONFIG.mosaicSize}²）—— 眼睛画错位置/数量，重跑 npm run zombie`);
  }

  // ③ 输入指纹（manifest 缺失 = 从没跑过 npm run zombie）
  if (!fs.existsSync(HEAD_JSON)) {
    failures.push('[丧尸头部] assets/zombie/head.json 不存在 —— 跑 npm run zombie');
  } else {
    const manifest = JSON.parse(fs.readFileSync(HEAD_JSON, 'utf8'));
    const current = headInputFingerprint();
    if (manifest.fingerprint !== current) {
      failures.push('[丧尸头部] 图案参数已变但纹理未重烘（跑 npm run zombie）'
        + `\n      期望 ${current}\n      实际 ${manifest.fingerprint}`);
    }
  }

  if (!failures.some((f) => f.startsWith('[丧尸头部]'))) {
    infos.push(`[丧尸头部] head.png ${HEAD_WIDTH}×${HEAD_HEIGHT} + ${EYE_CELLS} 个眼睛格 + 指纹匹配`);
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
    // ② RGB 必须与源图逐字节相同（本脚本只应改 alpha；改颜色是另一个需求）
    for (let i = 0; i < png.data.length; i += 4) {
      if (png.data[i] !== src.data[i] || png.data[i + 1] !== src.data[i + 1] || png.data[i + 2] !== src.data[i + 2]) {
        fail(`procedural/${t.out}.png 的 RGB 与源图不一致（像素 ${i / 4}）—— 孔洞压缩只应改 alpha`);
        break;
      }
    }
  }

  // ③ 每个树叶族（除 sky_leaves）的 faces-data 都必须指向 procedural/leaf_*
  const LEAF_NAMES = ['leaves', 'azalea_leaves', 'yellow_leaves', 'realistic_oak_leaves',
    'realistic_yellow_leaves', 'swamp_leaves', 'snow_leaves'];
  // ⚠️ `azalea_flowers` 是**非叶名**的树叶族（名字里没有 leaves），旧版清单漏了它 →
  // 它一直指向未压缩的原图 `flowering_azalea_leaves`（19.9%），比同树的纯叶还稀。
  // 两份贴图稀疏度不同会让同一棵树看起来像两种材质。
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
    infos.push(`[树叶贴图] ${LEAF_TEXTURES.length} 张孔洞压缩产物 / 普通叶 ${(holes.LEAF_HOLE_RATIO * 100).toFixed(1)}%、杜鹃叶 ${(holes.LEAF_HOLE_RATIO_AZALEA * 100).toFixed(1)}% / RGB 与源图逐字节相同`);
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
  const EXPECT_LEAF_FAMILY_SIZE = 14; // 7 普通树叶（含 azalea_leaves）+ 6 巨树叶 + azalea_flowers
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
  // 树干间距判据（v2.0）：常量与判据本身都要在
  if (mod.AZALEA_TRUNK_CLEARANCE !== 6) {
    fail(`AZALEA_TRUNK_CLEARANCE=${mod.AZALEA_TRUNK_CLEARANCE} ≠ 6（用户 2026-10-28 裁定：树干间距 ≥6 格）`);
  }
  if (typeof mod.acceptAzaleaTrunks !== 'function' || typeof mod.collectOtherTrunks !== 'function') {
    fail('缺 acceptAzaleaTrunks / collectOtherTrunks（树干间距判据的接线入口）');
  }
  // 密度 C=13（spacing 8 + jitter 5）
  if (mod.AZALEA_TREE_PATH.spacing !== 8 || mod.AZALEA_TREE_PATH.jitter !== 5) {
    fail(`AZALEA_TREE_PATH spacing/jitter = ${mod.AZALEA_TREE_PATH.spacing}/${mod.AZALEA_TREE_PATH.jitter} ≠ 8/5（C=13）`);
  }
  // 高矮错落（v2.2）：类别表必须与产物实际高度对得上，且相邻同类率显著低于独立抽签
  {
    const byClass = [[], [], []];
    for (let i = 0; i < mod.AZALEA_VARIANT_COUNT; i++) byClass[mod.azaleaSizeClass(i)].push(i);
    const want = mod.AZALEA_STAGGER_CLASSES.map((a) => a.join(','));
    const got = byClass.map((a) => a.join(','));
    if (want.join('|') !== got.join('|')) {
      fail(`档位类别表 [${want.join(' | ')}] 与按 azaleaSizeClass 反查的结果 [${got.join(' | ')}] 不一致`);
    }
    const lens = mod.AZALEA_STAGGER_CLASSES.map((a) => a.length);
    if (lens.join(',') !== '3,3,4') fail(`三类档位数 ${lens.join(',')} ≠ 3,3,4（高类有 4 档）`);
    // 相邻同类率：独立抽签期望 Σp² = 0.34，错落实测 0.15。
    // ⚠️ 这条是**关系式**（低于独立抽签），不是硬编码统计值 —— 改系数/换成别的错落算法时不需要重标。
    const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    let same = 0, tot = 0;
    for (let i = 0; i < 30; i++) {
      for (let j = 0; j < 30; j++) {
        const c = mod.azaleaSizeClass(mod.azaleaStaggeredSizeIdx(i, j, 12345));
        for (const [di, dj] of DIRS) {
          tot++;
          if (c === mod.azaleaSizeClass(mod.azaleaStaggeredSizeIdx(i + di, j + dj, 12345))) same++;
        }
      }
    }
    const rate = same / tot;
    const independent = lens.reduce((a, n) => a + (n / 10) ** 2, 0);
    if (!(rate < independent - 0.1)) {
      fail(`相邻同类率 ${rate.toFixed(3)} 未显著低于独立抽签的 ${independent.toFixed(3)}` +
        `（高矮扎堆 —— 确认 azaleaStaggeredSizeIdx 还在用类别环；用户 2026-10-28 要求错落相间）`);
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
    infos.push(`[杜鹃树] ${trees.length} 档（${meta.sizes.join(' ')}）共 ${total} 格，树干 azalea_log、叶子 LEAF 哨兵按 30% 掷花、指纹匹配、旧小树已停用；间距 ≥${mod.AZALEA_TRUNK_CLEARANCE} 格、密度 C=${mod.AZALEA_TREE_PATH.spacing + mod.AZALEA_TREE_PATH.jitter}、AZALEA 面积 ${(azFrac * 100).toFixed(1)}%、高矮错落（相邻同类率 < 独立抽签）`);
  }
}

// ---------------------------------------------------------------- 主流程

const REGISTRY = await buildDefaultRegistry();

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
checkZombieHeadTexture();
checkTurretArmorTexture();
checkSkyboxAssets();         // v1.58：天空盒立方图完整性（⚠️ 漏了本行则门禁永不执行）
await checkNightSkyFreshness(); // v1.60：夜空烘焙产物指纹（⚠️ 漏了本行则门禁永不执行）
await checkGiantTrees();     // 巨树景观：方块/烘焙产物/贴图三方契约（⚠️ 漏了本行则门禁永不执行）
await checkAzaleaTrees();    // 杜鹃树：烘焙产物/方块声明/运行时常量三方契约（⚠️ 漏了本行则门禁永不执行）
await checkCloudlandTarnZone(); // 高台地带：35 产物/映射表/通道/台顶材质契约（⚠️ 漏了本行则门禁永不执行）
await checkGiantPyramid();   // 巨型金字塔：烘焙产物/映射表/通道契约（⚠️ 漏了本行则门禁永不执行）
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
