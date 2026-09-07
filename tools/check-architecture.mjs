// tools/check-architecture.mjs — 静态架构门（Tier 1，`npm run check:arch`）
//
// 对应 12 条重构红线中**可静态检查**的部分。任何一条失败即退出码 1。
// 分级策略见 docs/testing-policy.md §7。
//
// 为什么这层是硬门禁：红线回退**代码能跑但架构已死**（mc-lite 的补丁架构复活路径），
// 玩十局也看不出来，只有静态断言能在改动当场拦住。
//
// 已知例外一律写进白名单并注明理由——白名单条目本身就是设计决策的记录，
// 新增例外必须能说清「为什么这是算法依赖而不是渲染依赖」之类的理由。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

const failures = [];
const warns = [];

// ---------------------------------------------------------------- 工具

/** 递归收集 .js 文件（跳过 tests，那是测试代码不是架构约束对象） */
function collectJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'tests') continue;
      out.push(...collectJs(p));
    } else if (entry.name.endsWith('.js')) {
      out.push(p);
    }
  }
  return out;
}

/** 仓库相对路径（报告可读） */
const rel = (p) => path.relative(ROOT, p);

/**
 * 去掉一行的注释部分。
 * 用于红线类名检查：`mesher.js:51` 的 `ChunkConsolidation.js:530` 是**出处注释**，
 * 必须放行——只查真实代码引用。
 * 局限：不解析字符串字面量里的 `//`（本项目无此写法，够用）。
 */
function stripComment(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return '';
  const idx = line.indexOf('//');
  return idx >= 0 ? line.slice(0, idx) : line;
}

// ---------------------------------------------------------------- 红线 10 + 8：three 隔离

/**
 * 判定同构模块用**双层**，缺一不可：
 *
 * ① **目录默认**：`src/voxel/**`、`src/gen/**`、`src/mesh/**`、`src/workers/**`、
 *    `src/entities/**` 默认全部受检。按设计这五层是同构层（§3 分层图 + 红线 3/8/10；
 *    `src/entities/**` 是 M5 规格 §2「类型定义和 state 均没有 DOM/three 依赖」+
 *    docs/testing-policy.md §8「M5 的 src/entities/** 不得 import three / 不得新增 Worker」），
 *    例外须进白名单。
 *    —— 不能用精确文件列表：那样新增一个 `src/mesh/foo.js` 就绕过检查（实测已踩过）。
 * ② **自声明一致性**：任何文件（含 player/ui 等不在上述目录的）只要头部声明了
 *    「不得 import three」/「无 DOM、无 three」，就必须遵守。抓的是**自我矛盾**——
 *    声明了同构却 import three，比没声明更危险（会误导后来者以为它能在 Worker 里跑）。
 *
 * 例外 `src/mesh/atlas-loader.js`：它**不是**同构模块——只被 `core/game.js` 消费，
 * 负责运行时加载 atlas 纹理（必然依赖 three），且头部无同构声明。分层归属本应在 `render/`，
 * 但历史放在 `mesh/`。**不移动**（属架构改动，须设计文档先行），白名单注明理由。
 */
const ISOMORPHIC_DIRS = ['src/voxel', 'src/gen', 'src/mesh', 'src/workers', 'src/entities'];
const THREE_EXEMPT = new Set([
  // 主线程专用：运行时加载 atlas 纹理必然依赖 three，且不被任何 worker 引用
  'src/mesh/atlas-loader.js',
]);

/**
 * `new Worker(...)` 的唯一合法落点。红线 3 要求重计算离开主线程，但**入口只有一个**：
 * `worker-pool.js` 是 Worker 池的装配点（`installRpcHandler` 在 worker 侧共用本文件）。
 * 除此之外的 `new Worker` 就是「为竞态/玩法新开专属 Worker」—— 那是 mc-lite 的病根，
 * 也是 M5 规格 §3 明令禁止的（M6 AI 须经既有池的统一 RPC，不是专属 Worker）。
 */
const WORKER_EXEMPT = new Set(['src/core/worker-pool.js']);

/** 文件是否自带同构声明（头部注释） */
const ISOMORPHIC_DECLARED = /不得\s*import\s*three|无\s*DOM[、,].*无\s*three|同构.*无\s*three|无\s*three.*同构/;

function checkThreeIsolation(files) {
  for (const file of files) {
    const r = rel(file);
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split('\n');

    const inIsoDir = ISOMORPHIC_DIRS.some((d) => r.startsWith(d));
    const declared = ISOMORPHIC_DECLARED.test(raw);
    if ((!inIsoDir && !declared) || THREE_EXEMPT.has(r)) continue;

    for (let i = 0; i < lines.length; i++) {
      const code = stripComment(lines[i]);
      if (!code) continue;
      if (/from\s+['"]three['"]|import\(\s*['"]three['"]\)/.test(code)) {
        const why = declared ? '（且头部声明了同构 → 自我矛盾）' : '';
        failures.push(`[红线 8/10] ${r}:${i + 1} Worker 同构模块 import three${why} —— ${code.trim()}`);
      }
      if (/\b(document|window|createImageBitmap)\b/.test(code)) {
        const why = declared ? '（且头部声明了同构 → 自我矛盾）' : '';
        failures.push(`[红线 8] ${r}:${i + 1} Worker 同构模块引用 DOM API${why} —— ${code.trim()}`);
      }
    }
  }
}

// ---------------------------------------------------------------- 红线 3：Worker 创建入口唯一

/**
 * `new Worker(...)` 只允许出现在 WorkerPool 装配点。
 *
 * 为什么单独一层而不是塞进 checkThreeIsolation：同构判定是「目录默认 + 自声明」门控，
 * 而这条规则与同构性无关 —— `src/render/**`、`src/ui/**` 里自建 Worker 同样是红线回退
 * （绕过统一池 = 为玩法/竞态新开专属子系统，mc-lite 的病根，也是 M5 规格 §3 明令禁止的：
 * M6 的 AI 须经既有池的统一 RPC）。故扫全部源文件。
 */
function checkWorkerCreation(files) {
  for (const file of files) {
    const r = rel(file);
    if (WORKER_EXEMPT.has(r)) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const code = stripComment(lines[i]);
      if (!code) continue;
      if (/new\s+Worker\s*\(/.test(code)) {
        failures.push(`[红线 3] ${r}:${i + 1} 自建 Worker（须经既有 WorkerPool 的统一 RPC）—— ${code.trim()}`);
      }
    }
  }
}

// ---------------------------------------------------------------- 红线 2/4/6：禁止的补丁类名

/**
 * mc-lite 的补丁架构类名（CLAUDE.md「禁止搬」清单）。
 * 这些层次在新引擎中不存在，**禁止以任何形式复活**。
 *
 * 只查非注释行：`mesher.js:51`/`render-world.js:198` 引用 `ChunkConsolidation.js:530` 作
 * **算法出处注释**（逐格复刻其几何构造），是正当的对标记录，必须放行。
 */
const FORBIDDEN_NAMES = [
  'FaceCullingSystem', 'FaceCullingWorker', 'ChunkConsolidation', 'BlockScatterManager',
  'GlobalInstancedMeshManager', 'WorldBoundsController', 'WorldGenerationService',
  'AOBridge', 'AOWorker', 'WorldBlockDataStore', 'RegionCache',
  'WorldChunkPayloadRegistry', 'safeBounds',
];

/** 红线 6：地形交互走体素 DDA，禁止对地形 mesh 求交 */
const FORBIDDEN_RAYCAST = ['Raycaster', 'intersectObjects'];

function checkForbiddenNames(files) {
  for (const file of files) {
    const r = rel(file);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const code = stripComment(lines[i]);
      if (!code) continue;
      for (const name of FORBIDDEN_NAMES) {
        if (code.includes(name)) {
          failures.push(`[红线 2/4] ${r}:${i + 1} 出现 mc-lite 补丁类名 ${name} —— ${code.trim()}`);
        }
      }
      for (const name of FORBIDDEN_RAYCAST) {
        if (code.includes(name)) {
          failures.push(`[红线 6] ${r}:${i + 1} 出现 ${name}（地形交互必须走体素 DDA）—— ${code.trim()}`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------- §3 分层：依赖方向单向

/**
 * 允许的反向/跨层依赖白名单（每条都注明理由）。
 *
 * 新增例外时必须说清理由——白名单是设计决策的记录，不是「绕过检查」的后门。
 */
const DEP_WHITELIST = [
  {
    from: 'src/voxel/world-data.js',
    to: 'src/mesh/lighting.js',
    // 红线 11 要求「编辑快路径同步重算垂直单列且只升不降」，WorldData.set() 必须在
    // 主线程同步调光照算法。lighting.js 是 Worker 同构纯函数（不 import three、无 DOM），
    // 故这是**算法依赖不是渲染依赖**，voxel 仍「不知道渲染存在」。
    // 若要把 recomputeSkylightAt 挪进 voxel 层属架构改动，须先改设计文档 §3 分层图。
    reason: '红线 11 编辑快路径同步重算垂直单列；lighting.js 是同构纯函数（算法依赖非渲染依赖）',
  },
];

/**
 * 依赖方向（设计文档 §3）：`voxel ← gen ← mesh ← render`，禁止反向。
 *
 * `core/` 是**装配层**（game.js 组装全部子系统、scheduler.js 编排任务），必然依赖所有层，
 * 不参与方向检查。CLAUDE.md 原写「core/ 不依赖 voxel/」是错的，已随本次 harness 升级修正。
 * `player/`/`ui/`/`save/` 在分层图里指向上层，也不参与方向检查。
 */
const LAYER_ORDER = ['voxel', 'gen', 'mesh', 'render'];

function checkDependencyDirection(files) {
  for (const file of files) {
    const r = rel(file);
    const fromLayer = LAYER_ORDER.find((l) => r.startsWith(`src/${l}/`));
    if (!fromLayer) continue; // core/player/ui/save/workers 不参与方向检查

    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const code = stripComment(lines[i]);
      if (!code) continue;
      const m = code.match(/from\s+['"]\.\.\/([a-z-]+)\//);
      if (!m) continue;
      const toLayer = m[1];
      if (!LAYER_ORDER.includes(toLayer)) continue; // 跨到 core/player/ui/save 不受此规则约束

      const fromIdx = LAYER_ORDER.indexOf(fromLayer);
      const toIdx = LAYER_ORDER.indexOf(toLayer);
      if (toIdx <= fromIdx) continue; // 同层或向下（voxel→voxel、mesh→voxel）合法

      const whitelisted = DEP_WHITELIST.find(
        (w) => w.from === r && `${w.to}` === `src/${toLayer}/${code.match(/from\s+['"]\.\.\/[a-z-]+\/([a-z-]+\.js)/)?.[1] ?? ''}`,
      );
      if (whitelisted) {
        warns.push(`[分层例外] ${r}:${i + 1} → ${toLayer} —— ${whitelisted.reason}`);
        continue;
      }
      failures.push(`[§3 分层] ${r}:${i + 1} 反向依赖 src/${toLayer}/ —— ${code.trim()}`);
    }
  }
}

// ---------------------------------------------------------------- 红线 5：发布层三级兜底

/**
 * BatchedMesh 缓冲耗尽的三级兜底必须存在（红线 5）：
 * `unusedVertexCount` 检查 → `optimize()` 回收空洞 → `setGeometrySize()` 整批扩容。
 * 缺任一级都会在大场景下静默丢几何（缓冲耗尽时不报错，只是不画）。
 */
function checkPublishFallback() {
  const file = path.join(SRC, 'render', 'render-world.js');
  if (!fs.existsSync(file)) {
    failures.push('[红线 5] src/render/render-world.js 不存在');
    return;
  }
  const src = fs.readFileSync(file, 'utf8');
  const need = ['unusedVertexCount', 'optimize(', 'setGeometrySize('];
  for (const n of need) {
    if (!src.includes(n)) failures.push(`[红线 5] render-world.js 缺三级兜底的 ${n}`);
  }
  if (!src.includes('_ensureCapacity')) {
    failures.push('[红线 5] render-world.js 缺 _ensureCapacity（三级兜底的统一入口）');
  }
}

// ---------------------------------------------------------------- 报告

function main() {
  const files = collectJs(SRC);
  checkThreeIsolation(files);
  checkWorkerCreation(files);
  checkForbiddenNames(files);
  checkDependencyDirection(files);
  checkPublishFallback();

  console.log(`[check:arch] 扫描 ${files.length} 个源文件`);
  if (warns.length) {
    console.log(`[check:arch] ${warns.length} 项白名单例外（已记录理由）：`);
    for (const w of warns) console.log(`  ${w}`);
  }
  if (failures.length) {
    console.error(`\n[check:arch] ✗ ${failures.length} 项架构红线违规：`);
    for (const f of failures) console.error(`  ${f}`);
    console.error('\n处置：红线回退不得合入。若属正当例外，须在 DEP_WHITELIST / THREE_EXEMPT');
    console.error('      加白名单条目并注明理由（理由须能说清「为什么这不是红线回退」）。');
    process.exit(1);
  }
  console.log('[check:arch] ✓ 架构红线全部守住');
}

main();
