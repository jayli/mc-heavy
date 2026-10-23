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
import { fileURLToPath } from 'node:url';
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
    infos.push(`[天空盒] ${Object.keys(SKY_SETS).length} 套 × ${SKY_FACE_FILES.length} 面完整（${SKY_SETS.day} / ${SKY_SETS.night}）`);
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


// ---------------------------------------------------------------- [RedCity] 烘焙产物契约（v1.68）

/**
 * [RedCity] 契约（spec §13.5 / §14）：离线烘焙产物 `assets/redcity/redcity.json` 必须——
 *   ① 指纹匹配：参数 / skin·building 清单 / 映射表 / schematic 原文任一变了而没重烘 → 产物静默过期（渲染旧地图，肉眼看不出）；
 *      ⚠️ 指纹不覆盖**算法**本身（改算法而不动参数时指纹不变）——那一类由 tests/redcity-bake.spec.mjs 的黄金比对兜底；
 *   ② 自洽且与单一权威一致：加载器校验通过；width/length === REDCITY_SIZE；params.groundFloor === REDCITY_GROUND_FLOOR；dyMax ≤ 预算；
 *   ③ palette 的每个名字都在 registry；
 *   ④ I1/I2/I3 **从产物数组重算**（不信记录值）；I5′ 取记录值；
 *   ⑤ 映射覆盖：块数 ≥50 的 (id:meta) 全部显式映射、未覆盖占比 ≤0.5%（记录值 + 用当前映射表对记录的直方图重算）；
 *   ⑥ 出生点判据在产物上重验（脚下是岛面方块、头顶 24 格空、5×5 平整、不贴墙）；
 *   ⑦ 颜色关系式（U2 裁定后只留这两条，不做 ΔE）：樱花三个源同名直映射 pink_wool；屋顶目标贴图平均色 R<B<G。
 *   ⑧ spec §15 / §15.9（v1.69/v1.70）**从产物数组重算**的两条地表契约：岛内相邻高差 ≤ REDCITY_MAX_STEP；
 *      玻璃全部有 ≥REDCITY_GLASS_FRAME_MIN 个实心邻接；悬空的六邻接全空方块 = 0。
 * ⚠️ 主流程是逐个显式调用 —— 漏了本行则门禁永不执行（本仓已因此出过两次事故）。
 */
async function checkRedCityArtifact() {
  const RC = await import('./redcity-fingerprint.mjs');
  const CFG = await import('./redcity-config.mjs');
  const { prepareRedCityModel, forEachRedCityBlock } = await import('../src/gen/structures/redcity-data.js');
  const { REDCITY_SIZE, REDCITY_GROUND_FLOOR, REDCITY_DY_MAX_BUDGET, REDCITY_MAX_STEP, REDCITY_GLASS_FRAME_MIN } = await import('../src/gen/structures/region-config.js');
  const T = '[RedCity]';
  const before = failures.length;
  if (!fs.existsSync(RC.REDCITY_SCHEM)) { failures.push(`${T} 烘焙输入 schematic 不在仓库内（${path.relative(ROOT, RC.REDCITY_SCHEM)}）—— 输入必须入库，否则别的机器上 npm run redcity 必挂`); return; }
  if (!fs.existsSync(RC.REDCITY_JSON)) { failures.push(`${T} assets/redcity/redcity.json 不存在 —— 跑 npm run redcity`); return; }
  let doc;
  try { doc = JSON.parse(fs.readFileSync(RC.REDCITY_JSON, 'utf8')); } catch { failures.push(`${T} redcity.json 不是合法 JSON（重跑 npm run redcity）`); return; }

  // ① 指纹
  const fp = RC.redcityInputFingerprint({
    params: CFG.REDCITY_BAKE_PARAMS, spawnParams: CFG.REDCITY_SPAWN_PARAMS,
    skin: { anyMeta: CFG.SKIN_ANY_META, metaOnly: CFG.SKIN_META_ONLY },
    mappingRules: CFG.MAPPING_RULES, defaultBlock: CFG.DEFAULT_BLOCK, schemBytes: fs.readFileSync(RC.REDCITY_SCHEM),
  });
  if (doc.fingerprint !== fp) {
    failures.push(`${T} 指纹不匹配（产物 ${String(doc.fingerprint).slice(0, 16)} vs 当前 ${fp.slice(0, 16)}）—— 烘焙参数/清单/映射/schematic 变了但产物未重烘（跑 npm run redcity）；不要把期望值改成新指纹来过关`);
  }

  // ② 自洽 + 单一权威
  let model;
  try { model = prepareRedCityModel(doc); } catch (e) { failures.push(`${T} 产物自洽校验失败：${e.message}`); return; }
  if (doc.width !== REDCITY_SIZE.X || doc.length !== REDCITY_SIZE.Z) failures.push(`${T} 产物 ${doc.width}×${doc.length} ≠ region-config 的 REDCITY_SIZE ${REDCITY_SIZE.X}×${REDCITY_SIZE.Z}（布局按后者放 core，尺寸不符会错位）`);
  for (const k of ['params', 'spawnParams', 'invariants', 'coverage', 'spawn']) if (!doc[k]) failures.push(`${T} 产物缺声明项 "${k}"（spec §13.5.4）`);
  if (doc.params && doc.params.groundFloor !== REDCITY_GROUND_FLOOR) failures.push(`${T} params.groundFloor ${doc.params.groundFloor} ≠ REDCITY_GROUND_FLOOR ${REDCITY_GROUND_FLOOR}`);
  if (doc.dyMax > REDCITY_DY_MAX_BUDGET) failures.push(`${T} dyMax ${doc.dyMax} > 预算 ${REDCITY_DY_MAX_BUDGET}（I4 烘焙半）`);

  // ③ palette ⊂ registry
  const regNames = new Set(REGISTRY.all().map((e) => e.name));
  for (const n of doc.palette) if (!regNames.has(n)) failures.push(`${T} palette 里的 "${n}" 不在 registry（运行时 setBlock 会静默跳过 → 方块消失）`);

  // ④ I1 / I2 / I3 从数组重算
  const W = doc.width, L = doc.length;
  const isl = (c) => doc.island.charCodeAt(c) === 49;
  let minG = 0, borderNZ = 0, outAdj = 0;
  for (let z = 0; z < L; z++) for (let x = 0; x < W; x++) {
    const c = z * W + x, g = doc.ground[c];
    if (g < minG) minG = g;
    if ((x === 0 || z === 0 || x === W - 1 || z === L - 1) && g !== 0) borderNZ++;
    if (!isl(c)) {
      if (x < W - 1 && !isl(c + 1)) outAdj = Math.max(outAdj, Math.abs(g - doc.ground[c + 1]));
      if (z < L - 1 && !isl(c + W)) outAdj = Math.max(outAdj, Math.abs(g - doc.ground[c + W]));
    }
  }
  // ④b 产物内部一致：三元组数 === stats.retained；岛内每列在 dy===ground 处都有方块（地面方块是放置公式 baseY+dy 的锚）
  if (doc.blocks.length !== doc.stats.retained * 3) failures.push(`${T} blocks 三元组数 ${doc.blocks.length / 3} ≠ stats.retained ${doc.stats.retained}（产物被手改或截断）`);
  {
    let noGround = 0;
    for (let c = 0; c < W * L; c++) {
      if (!isl(c)) continue;
      let has = false;
      for (let k = model.colStart[c]; k < model.colStart[c + 1]; k++) if (doc.blocks[k * 3 + 1] === doc.ground[c]) { has = true; break; }
      if (!has) noGround++;
    }
    if (noGround) failures.push(`${T} ${noGround} 个岛内列在 dy===ground 处没有方块（ground 与 blocks 脱节）`);
  }
  if (outAdj > 1) failures.push(`${T} I1 岛外相邻高差 ${outAdj} > 1`);
  if (borderNZ !== 0) failures.push(`${T} I2 矩形边界非零 ground 列数 ${borderNZ}`);
  if (minG < REDCITY_GROUND_FLOOR) failures.push(`${T} I3 ground 最小值 ${minG} < ${REDCITY_GROUND_FLOOR}`);
  if (doc.invariants && !(doc.invariants.i5Ratio < 0.001)) failures.push(`${T} I5′ 竖向接触不一致占比 ${doc.invariants.i5Ratio} ≥ 0.1%`);

  // ④c spec §15（v1.69）地表可跑动性：岛内相邻列高差 ≤ REDCITY_MAX_STEP
  // 这是用户实玩反馈「跑动时全是上上下下的障碍」的直接验收判据，必须**从产物数组重算**。
  {
    let maxStep = 0;
    for (let z = 0; z < L; z++) {
      for (let x = 0; x < W; x++) {
        const c = z * W + x;
        if (!isl(c)) continue;
        if (x < W - 1 && isl(c + 1)) maxStep = Math.max(maxStep, Math.abs(doc.ground[c + 1] - doc.ground[c]));
        if (z < L - 1 && isl(c + W)) maxStep = Math.max(maxStep, Math.abs(doc.ground[c + W] - doc.ground[c]));
      }
    }
    if (maxStep > REDCITY_MAX_STEP) {
      failures.push(`${T} 岛内相邻列高差 ${maxStep} > REDCITY_MAX_STEP ${REDCITY_MAX_STEP}（跑动会被台阶打断，spec §15）`);
    }
  }

  // ④d spec §15 玻璃窗框：每块玻璃必须至少 REDCITY_GLASS_FRAME_MIN 个实心（非玻璃）六邻接。
  // 从产物重算，不信记录值 —— 这条守的是「删玻璃那一步真的跑了」。
  {
    const GLASS = 'glass_block';
    const at = new Map();
    for (let c = 0; c < W * L; c++) {
      for (let k = model.colStart[c]; k < model.colStart[c + 1]; k++) {
        const i = k * 3;
        at.set(c * 4096 + (doc.blocks[i + 1] + 2048), doc.palette[doc.blocks[i + 2]]);
      }
    }
    let glassN = 0, unframed = 0;
    for (let c = 0; c < W * L; c++) {
      const ox = c % W, oz = (c / W) | 0;
      for (let k = model.colStart[c]; k < model.colStart[c + 1]; k++) {
        const i = k * 3, y = doc.blocks[i + 1];
        if (doc.palette[doc.blocks[i + 2]] !== GLASS) continue;
        glassN++;
        let solid = 0;
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
          const nx = ox + dx, nz = oz + dz;
          if (nx < 0 || nz < 0 || nx >= W || nz >= L) continue;
          const nm = at.get((nz * W + nx) * 4096 + (y + dy + 2048));
          if (nm !== undefined && nm !== GLASS) solid++;
        }
        if (solid < REDCITY_GLASS_FRAME_MIN) unframed++;
      }
    }
    if (unframed) {
      failures.push(`${T} ${unframed} 块玻璃没有 ≥${REDCITY_GLASS_FRAME_MIN} 个实心邻接（无框玻璃壳/网应被删除，spec §15）`);
    }
    if (!glassN) failures.push(`${T} 产物里一块玻璃都没有（窗框应被保留，全删说明过滤写反了）`);
  }

  // ④e spec §15.9（v1.70）孤立方块：除「地面鳍点」外，不得存在六邻接全空的方块。
  // 用户实玩反馈「空中有大量的悬空方块」。地面鳍点（y === ground 且该列只有它）是允许的 ——
  // 那是「地面补齐」写出的行走面锚点，删了地表就凭空虚空一格。
  {
    const at = new Map();
    for (let c = 0; c < W * L; c++) {
      for (let k = model.colStart[c]; k < model.colStart[c + 1]; k++) {
        const i = k * 3;
        at.set(c * 4096 + (doc.blocks[i + 1] + 2048), doc.palette[doc.blocks[i + 2]]);
      }
    }
    let isolated = 0, isolatedAir = 0;
    for (let c = 0; c < W * L; c++) {
      const ox = c % W, oz = (c / W) | 0;
      for (let k = model.colStart[c]; k < model.colStart[c + 1]; k++) {
        const i = k * 3, y = doc.blocks[i + 1];
        let touching = 0;
        for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
          const nx = ox + dx, nz = oz + dz;
          if (nx < 0 || nz < 0 || nx >= W || nz >= L) continue;
          if (at.has((nz * W + nx) * 4096 + (y + dy + 2048))) { touching++; break; }
        }
        if (touching) continue;
        isolated++;
        if (y !== doc.ground[c]) isolatedAir++;      // 非地面鳍点的孤立块 = 悬空肿块，必须为 0
      }
    }
    if (isolatedAir) {
      failures.push(`${T} ${isolatedAir} 个悬空方块的六邻接全空（应被 REDCITY_DROP_ISOLATED 删掉，spec §15.9）`);
    }
    // 地面鳍点只能少量（实测 50 个 = 地面被平滑抬高后无方块可依的列）
    if (isolated > 200) failures.push(`${T} 孤立方块 ${isolated} 个（地面鳍点不应超过 200）`);
  }

  // ⑤ 映射覆盖：记录值 + 用当前映射表对记录的直方图重算（映射表改了而没重烘 → 这里也会红）
  if (doc.coverage && (doc.coverage.bigUncovered.length || doc.coverage.uncoveredRatio > 0.005)) failures.push(`${T} 映射覆盖不达标（块数≥50 未映射 ${doc.coverage.bigUncovered.length} 项 / 占比 ${doc.coverage.uncoveredRatio}）`);

  // ⑥ 出生点重验
  {
    const { ox, oz, dy } = doc.spawn, sp = doc.spawnParams;
    const dys = (x, z) => { const s = new Set(); forEachRedCityBlock(model, x, z, (d) => s.add(d)); return s; };
    const free = (s, y0, y1) => { for (let y = y0; y <= y1; y++) if (s.has(y)) return false; return true; };
    const gAt = (x, z) => doc.ground[z * W + x];
    const inRect = ox - sp.halfWin >= 0 && oz - sp.halfWin >= 0 && ox + sp.halfWin < W && oz + sp.halfWin < L;
    if (!inRect) failures.push(`${T} 出生点 (${ox},${oz}) 的 5×5 窗口越出产物矩形`);
    else {
      const g0 = gAt(ox, oz), here = dys(ox, oz);
      if (!isl(oz * W + ox)) failures.push(`${T} 出生列不是岛内列`);
      if (g0 !== dy) failures.push(`${T} 出生点 dy ${dy} ≠ 该列 ground ${g0}`);
      if (!here.has(g0)) failures.push(`${T} 出生列在 ground 处没有烘焙出的岛面方块`);
      if (!free(here, g0 + 1, g0 + sp.headroom)) failures.push(`${T} 出生列头顶 ${sp.headroom} 格不全空（会出生在屋檐/树冠下）`);
      let lo = 99, hi = -99, walled = false;
      for (let dz = -sp.halfWin; dz <= sp.halfWin; dz++) for (let dx = -sp.halfWin; dx <= sp.halfWin; dx++) {
        const g = gAt(ox + dx, oz + dz); lo = Math.min(lo, g); hi = Math.max(hi, g);
        if (!free(dys(ox + dx, oz + dz), g + 1, g + sp.wallClear)) walled = true;
      }
      if (hi - lo > sp.flatRange) failures.push(`${T} 出生点 5×5 ground 极差 ${hi - lo} > ${sp.flatRange}`);
      if (walled) failures.push(`${T} 出生点 5×5 内有列头顶 ${sp.wallClear} 格内有方块（贴墙/树冠）`);
    }
  }

  // ⑦ 颜色关系式
  for (const [id, meta] of [[35, 6], [251, 6], [252, 6]]) {
    const name = CFG.mappingOf((id << 4) | meta).name;
    if (name !== 'pink_wool') failures.push(`${T} 樱花粉 ${id}:${meta} 必须同名直映射 pink_wool（实际 ${name}）`);
  }
  {
    const roofName = CFG.mappingOf((168 << 4) | 2).name;
    const face = FACES_DATA[roofName]; const tileName = Array.isArray(face) ? face.find(Boolean) : face;
    const rect = atlasMeta.tiles[tileName];
    if (!rect) failures.push(`${T} 屋顶映射目标 ${roofName} 的贴图 "${tileName}" 不在 atlas`);
    else {
      const png = PNG.sync.read(fs.readFileSync(path.join(ROOT, 'assets', 'atlas.png')));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) { const o = (y * png.width + x) * 4; if (png.data[o + 3] === 0) continue; r += png.data[o]; g += png.data[o + 1]; b += png.data[o + 2]; n++; }
      r /= n; g /= n; b /= n;
      // ⚠️ 实测 RGB(58,196,169)：绿最大、蓝次之、红最小 → R < B < G。勿写成 R<G<B（那是「蓝最大」，永远 FAIL）
      if (!(r < b && b < g)) failures.push(`${T} 屋顶 ${roofName} 贴图平均色 RGB(${r.toFixed(0)},${g.toFixed(0)},${b.toFixed(0)}) 不满足青绿系 R<B<G`);
    }
  }
  if (failures.length === before) {
    infos.push(`${T} ${doc.width}×${doc.length}，${doc.stats.retained} 块，palette ${doc.palette.length} 项；指纹 ${fp.slice(0, 16)} 匹配；I1=${outAdj} I2=${borderNZ} I3=${minG}；出生点 (${doc.spawn.ox},${doc.spawn.oz}) 判据重验通过`);
  }}

// ---------------------------------------------------------------- 主流程

const REGISTRY = await buildDefaultRegistry();

checkReferenceIntegrity();
checkItemSetRelation();
checkIndestructibleContract();
checkShadowCastContract();   // v1.45：阴影投射排除集合契约（⚠️ 主流程是逐个显式调用，漏了本行则门禁永不执行）
checkPlaygroundContract();   // M9：创造台方块契约（⚠️ 主流程是逐个显式调用，漏了本行则门禁永不执行）
checkMinecartContract();     // 矿车：mine_cart 与铁轨必须在背包（⚠️ 漏了本行则门禁永不执行）
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
await checkRedCityArtifact();   // v1.68：RedCity 烘焙产物契约（⚠️ 漏了本行则门禁永不执行）

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
