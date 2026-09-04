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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const failures = [];
const infos = [];

// ---------------------------------------------------------------- 加载数据源

const { FACES_DATA } = await import('../src/voxel/faces-data.js');
const { INVENTORY_ICONS } = await import('../src/ui/hotbar.js');
const { TEMPLATES } = await import('../src/mesh/mesher.js');
const {
  buildItemNames, NON_PLACEABLE_ITEMS, HIDDEN_FROM_INVENTORY,
} = await import('../src/player/inventory.js');
const { buildDefaultRegistry } = await import('../src/voxel/block-registry.js');
const { BLOCKS } = await import('../src/voxel/blocks-data.js');

const atlasMeta = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'atlas.json'), 'utf8'));
const tiles = new Set(Object.keys(atlasMeta.tiles));

// ---------------------------------------------------------------- [1] 引用完整性

/**
 * faces-data + 图标表引用的每个 tile 都必须存在于 atlas。
 *
 * 取代 `expect(count).toBe(156)`：新增贴图不用改断言，而**拼错 tile 名会当场报错**
 * （拼错不报错但渲染空槽 / 空图标，与真实 bug 同观感，肉眼难辨——v1.23 已踩过）。
 */
function checkReferenceIntegrity() {
  const referenced = new Map(); // tile → 引用它的来源
  for (const [block, v] of Object.entries(FACES_DATA)) {
    if (Array.isArray(v)) v.forEach((t) => t && referenced.set(t, `faces-data:${block}`));
    else if (v) referenced.set(v, `faces-data:${block}`);
  }
  for (const [block, t] of Object.entries(INVENTORY_ICONS)) referenced.set(t, `图标表:${block}`);

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

// ---------------------------------------------------------------- [3] 图标同步

/**
 * 图标表的每个 inventory-icons/* 项指向的 tile 都必须已入 atlas。
 *
 * 防的是 v1.24 记录的失效路径：改了 mesher 几何只跑 `npm run icons` 忘跑 `npm run atlas`
 * → PNG 存在但 atlas 未更新 → **图标静默过期**（渲染出旧形状，肉眼看不出）。
 *
 * 检查用图标表的**实际值**而非按方块名拼路径——否则图标表写错 tile 名时本检查会误报通过
 * （实测已踩：`handrail → inventory-icons/NOT_EXIST` 时按名拼路径仍查到 handrail 存在）。
 * 与 [1] 引用完整性有重叠，但本检查额外给出「忘跑 atlas」的诊断语义。
 */
function checkIconSync() {
  const isoEntries = Object.entries(INVENTORY_ICONS)
    .filter(([, t]) => t.startsWith('inventory-icons/'));
  const stale = isoEntries.filter(([, t]) => !tiles.has(t)).map(([k, t]) => `${k}→${t}`);
  if (stale.length) {
    failures.push(`[图标同步] 图标表声明但未入 atlas（跑 npm run icons 后须跑 npm run atlas）：${stale.join(', ')}`);
  } else {
    infos.push(`[图标同步] ${isoEntries.length} 个等轴测图标全部已入 atlas`);
  }

  // 烘焙脚本的 TARGET_BLOCKS 与图标表必须一致（防两处清单漂移）
  const bakeSrc = fs.readFileSync(path.join(ROOT, 'tools', 'bake-isometric-icons.mjs'), 'utf8');
  const m = bakeSrc.match(/const TARGET_BLOCKS = \[([\s\S]*?)\]/);
  if (m) {
    const targets = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    const isoNames = isoEntries.map(([k]) => k);
    const notInIcons = targets.filter((t) => !INVENTORY_ICONS[t]);
    const notBaked = isoNames.filter((k) => !targets.includes(k));
    if (notInIcons.length) failures.push(`[图标同步] 烘焙 TARGET_BLOCKS 有但图标表没有：${notInIcons.join(', ')}`);
    if (notBaked.length) failures.push(`[图标同步] 图标表声明等轴测但 TARGET_BLOCKS 没烘焙：${notBaked.join(', ')}`);
  }
}

// ---------------------------------------------------------------- [4] 图标表无幽灵

/**
 * 图标表的每一项都必须是背包集合内的物品。
 *
 * 防「图标表里留着已从背包移除的方块」（如床三项移出背包后忘了清理图标表条目）——
 * 幽灵条目不报错但让集合语义失真，后来者读图标表会以为该方块在背包里。
 */
function checkIconTableNoGhost() {
  const items = new Set(buildItemNames(REGISTRY));
  const ghosts = Object.keys(INVENTORY_ICONS).filter((k) => !items.has(k));
  if (ghosts.length) {
    failures.push(`[图标表幽灵] 图标表含不在背包集合内的方块：${ghosts.join(', ')}`);
  } else {
    infos.push(`[图标表幽灵] 图标表 ${Object.keys(INVENTORY_ICONS).length} 项全部在背包集合内`);
  }
}

// ---------------------------------------------------------------- [5] 测试注册完整性

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

// ---------------------------------------------------------------- [6] 烘焙产物存在性

/**
 * 异形方块的等轴测图标必须有对应 PNG（不只是 atlas 条目）。
 * 防「atlas.json 有残留条目但 PNG 已被删」的半失效状态。
 */
function checkBakedPngs() {
  const iconDir = path.join(ROOT, 'assets', 'textures', 'inventory-icons');
  if (!fs.existsSync(iconDir)) {
    failures.push('[烘焙产物] assets/textures/inventory-icons/ 不存在（跑 npm run icons）');
    return;
  }
  const pngs = new Set(fs.readdirSync(iconDir).filter((f) => f.endsWith('.png')).map((f) => f.replace(/\.png$/, '')));
  const isoItems = Object.entries(INVENTORY_ICONS)
    .filter(([, t]) => t.startsWith('inventory-icons/'))
    .map(([k]) => k);
  const missing = isoItems.filter((k) => !pngs.has(k));
  if (missing.length) {
    failures.push(`[烘焙产物] 缺 PNG（跑 npm run icons）：${missing.join(', ')}`);
  } else {
    infos.push(`[烘焙产物] ${isoItems.length} 个图标 PNG 齐全（目录共 ${pngs.size} 张）`);
  }
}

// ---------------------------------------------------------------- [7] 几何模板存在性

/**
 * 图标表引用的异形方块必须在 mesher TEMPLATES 里有几何模板（红线 1 精神：
 * 形状权威只有一份）。防「图标表指向一个没有几何定义的方块」。
 */
function checkGeometryAuthority() {
  const isoItems = Object.entries(INVENTORY_ICONS)
    .filter(([, t]) => t.startsWith('inventory-icons/'))
    .map(([k]) => k);
  const noGeom = [];
  for (const name of isoItems) {
    const def = BLOCKS.find((b) => b.name === name);
    if (!def) { noGeom.push(`${name}（blocks-data 无此方块）`); continue; }
    if (!TEMPLATES[def.geometry]) noGeom.push(`${name}（geometry "${def.geometry}" 无 TEMPLATES 条目）`);
  }
  if (noGeom.length) {
    failures.push(`[形状权威] 等轴测图标指向无几何模板的方块：${noGeom.join(', ')}`);
  } else {
    infos.push(`[形状权威] ${isoItems.length} 个等轴测图标全部有 TEMPLATES 几何权威`);
  }
}

// ---------------------------------------------------------------- 主流程

const REGISTRY = await buildDefaultRegistry();

checkReferenceIntegrity();
checkItemSetRelation();
checkIconSync();
checkIconTableNoGhost();
checkTestRegistration();
checkBakedPngs();
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
