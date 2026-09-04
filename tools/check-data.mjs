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
// v1.26：图标走独立 icons-atlas（不再有 INVENTORY_ICONS 表）。指纹/清单走共享模块
// （红线 1：与烘焙脚本同一份逻辑，两处漂移会让指纹比对得出错误结论）。
const { iconFingerprintFor, FLAT_BLOCKS, FLAT_ICON_TILE } = await import('./icon-fingerprint.mjs');

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
 * 一次，范围从 9 扩到 118 项后更容易踩）：
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


// ---------------------------------------------------------------- 主流程

const REGISTRY = await buildDefaultRegistry();

checkReferenceIntegrity();
checkItemSetRelation();
checkIconManifestCoverage();
checkIconAtlasArtifacts();
checkIconFreshness();
checkTestRegistration();
checkGeometryAuthority();

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
