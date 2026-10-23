# 巨树景观 Implementation Plan（v1.1）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `40AssortedTreesPack.schem` 里 28 棵原版景观树按 1/2 比例引入 mc-heavy，按地形分三条路径落位（A 森林 / B 海边 / C 草地沙漠交界）；城市、地标、撒布结构与 JSON 结构占地让路；与旧森林树互斥。

**Architecture:** 离线工具把入库的 `.schem` 烘焙成扁平数组 JSON（一次，确定性）；运行时 `giant-trees.js` 在 region layout 层用「全局对齐网格 + 内缩抖动」算候选（无状态、跨 region 无缝、间距由构造保证），在 column 层合并 3×3 邻域候选 → 按 AABB 取交 → 排除 → 逐格光栅化 + 地基填充 → 返回覆盖窗口供阶段 3 抑制旧植被。与既有 `scatter.js` 的两段式同构（红线 2）。树叶走 opaque 通道（叶-叶共享面互剔）且**投影**；装饰件在烘焙时丢弃。

**Tech Stack:** 纯 JS ES2022 + JSDoc、Node 26、`pngjs`、Playwright 1.62.1、three r185.1 WebGPU。

**Spec:** [`docs/superpowers/specs/2026-10-23-giant-trees-design.md`](../specs/2026-10-23-giant-trees-design.md)（**v1.1**；与 v1.0 冲突处以 v1.1 为准）

---

## 本版（v1.1）说明：这份计划是怎么得来的

v1.0 计划在 `git archive HEAD`（`218f836`）的隔离副本里按原文逐任务真跑，暴露了 7 处阻断级缺陷（Task 2 末尾 `check:data` 即红、Task 6 得不到 GREEN、旋转恒为 0、候选不让路、预算口径不成立、genP95 撞门、素材外置导致其它机器 `check` 必红）和一批较小问题。用户于 2026-10-23 逐项裁决（spec §0.2：**opaque 容量 ×1.5 / 巨树叶投影 / `.schem` 入库 / 已有存档接受 / 粉叶先烘焙备用**），其余意见全部采纳。

v1.1 把这些修订落成可执行形态，并满足两条硬要求：

1. **每段代码、每条 Expected 输出都是真跑过的**：在同一个隔离副本里按本计划的任务顺序（含每个 TDD 阶段的 RED/GREEN 计数）执行，全量 Playwright **190 passed / 0 failed**，浏览器内单测 **810/810**（HEAD 基线 779 + 本 Epic 31），`npm run check` 全绿。文中代码块由脚本从该副本逐字生成，不是手写转录；已有文件的改动给统一 diff（对 HEAD）。
2. **每个新增门禁/断言都做过负向验证**：单测 15 条缺陷注入、`[巨树]` 门禁 9 条注入、烘焙脚本 4 条注入、Tier 4 spec 的注入，全部「注入后真红」（表在各任务的负向验证步骤里）。

⚠️ 代码块只代表「HEAD=`218f836` + 本计划」的结果。若实施时 HEAD 已前进（尤其是 `render-world.js` 的 `CAPACITY`、`apply.js`、`blocks-data.js` 被别的 Epic 改过），先 `git diff 218f836..HEAD --stat -- <本计划涉及的文件>` 核对，再决定如何三方合并，**不要整文件覆盖**。

> **与 `RedCity-done` 分支的关系**：`RedCity-done`（已被 `7376065` 整体回撤出 main）把 `CAPACITY.opaque` 也设为 `active: 1800`（同值），并占用了设计文档的 v1.68 与 `m3-fullscene` 的 `< 196 MiB` 断言。若将来重新落地 RedCity，两个 Epic 在 `CAPACITY` / 设计文档版本号 / `m3-fullscene` 上会有可预期的文本冲突（opaque 取值相同，实质只剩 transparent 行、注释与断言上限），按先后顺延版本号并取较大者即可。

---

## Global Constraints

- **素材（入库）**：`assets/giant-trees/src/40AssortedTreesPack.schem`（262,091 B，sha256 `217e215b0538262ba89dae354e33511eec2db9e3e264e45165956294c9293aa8`，WorldEdit Sponge Schematic v3，DataVersion 4440，400×206×254）。烘焙输入，**不是渲染资源**（与 `assets/sky/night-src/` 同口径），静态服务器不会也不应该 fetch 它。原件在作者机器的 `~/ttt/[BoutiqueBuilds] 40AssortedTreesPack/[SCHEMATIC] 40AssortedTreesPack.schem`；只入库 `.schem`（`.bp` / Java World 不入库）。
  > 来源是第三方素材包（BoutiqueBuilds）。入库按用户裁决执行；**素材的再分发授权由你自行确认**（仓库有 GitHub 双推送）。
- **降采样**：`SCALE = 2`；规则写死（spec §2.4）：空气 / 展示台 / 被丢弃的装饰件**不参与投票**，≥1 个可映射方块即保留该格，取最大票，同票下标小者胜（`palette[0]` = 树干，所以树干不会丢）。**不要改成「空气参与的多数投票」**（只剩 6k~10k 格的空壳树，且全部预算数字作废）。
- **地块索引** = 40 个 `netherite_block` 连通分量按 `(minZ, minX)` 升序的下标（`sortPads`）。改成 x 优先则 40 个位置全部错位；烘焙脚本末尾按源方块名做族标志反向校验兜底。
- **变体集合 28 个**：`tallOak` 8 · `snowSpruce` 4 · `cherry` 4 · `palm` 4 · `banyanLeafy` 4 · `banyanBare` 4。排除 12 个：无树干的 4 个（pad 12/18/28/38）、混交 5 个（4/9/15/25/35）、丛林 3 个（2/3/5）。
- **8 个方块**（前缀 `giant_`，全部 `geometry:"box"`、`orientationModes:0`、`solid:true`、`cullMode:"opaque"`）：`giant_oak_log` `giant_mangrove_log` `giant_oak_leaves` `giant_birch_leaves` `giant_spruce_leaves` `giant_cherry_leaves` `giant_palm_leaves` `giant_banyan_leaves`。**树叶 opaque 且投影**（用户裁决）：不写 `shadowCast:false`，不写 `opaque:false`；全部加入 `HIDDEN_FROM_INVENTORY`（不是 `NON_PLACEABLE_ITEMS`）。
- **三条路径参数**（单一权威 = `GIANT_TREE_PATHS`，spec §1.1）：

  | 路径 | salt | spacing / jitter | chance | 谓词 | 族（各 50%） |
  |---|---|---|---|---|---|
  | A 森林 | 911 | 14 / 8 | 1 | `FOREST` 且 `h > SEA_Y` | tallOak · snowSpruce |
  | B 海边 | 921 | 8 / 6 | 1 | 陆上且距水 ≤ 24（4 轴向、步长 4） | cherry · palm |
  | C 榕树带 | 931 | 8 / 6 | 1 | 陆上且 `PLAINS`/`DESERT` 交界（4 轴向 ±32 跨 biome） | banyanLeafy · banyanBare |

  旋转 salt = 941。`seededRandom` 返回 [0,1) 浮点：取整一律 `Math.floor(r * 4)`，**禁止 `& 3`**（恒为 0）。
- **锚点** = 变体 `gy=0` 层的树干格中离几何中心最近者（不是几何中心，实测偏移最大 2 格）；光栅化时锚点对齐候选点 `(wx, wz)`。
- **候选数组 stride = 5**：`[wx, wy, wz, familyIdx, variantHash]`；`palette[0]` 恒为树干。
- **不得修改** `mesher.js` / `materials.js` / `scheduler.js`；`render-world.js` **只改 `CAPACITY.opaque` 一行与其注释**（用户裁决，Task 3）。
- Worker 同构层（`src/gen/`）不得 import three、不得自建 Worker（`npm run check:arch` 守）。
- **验收口径**（spec §1.2）：真实页面 **reserved** 口径（= 1.25 × 已用顶点）相对**初始**容量；opaque ≤ 90% 且零扩容；cutout / transparent **相对 HEAD 不恶化**。Node 侧估算必须 ×1.25 才能与 100% 比较。
- **已知计时型 flaky**（单独复跑通过，**不改断言、不放宽阈值**）：`m1-acceptance`（p95）、`m3-rain`（截图差分）、`weapons-world-edit`（199≠200）、`bench` 场景 ④ `frameP95`（9↔10 的 vsync 量子）与场景 ③ `uploadMsP95/fastRemeshP95`（GC 抖动）。门禁阻断时**先做交替对照（两侧交错 2~3 轮比分布）**，不要看单次数值。`structure-gen` fixture 的含结构 `genP95` 门是 **10ms**（v1.42 起的用户裁决），不是 8ms。
- **提交纪律**：每个任务末尾有 Commit 步骤，**但未获用户明确指令不得提交**（CLAUDE.md）；提交信息用 Conventional Commits。
- 每个任务结束跑 `npm run lint`（0 error；仓库现有 15 条 warning 不算）+ 该任务对应的门禁。

## Review Focus

以下八类输入/条件最可能咬到玩家或让门禁失去判别力；每一条都在指定任务里配了断言，并做过负向验证：

1. **跨 column 边界的巨树**：最大 17×17 覆盖 2–4 个 column，两个 column 必须裁出同一棵树的两半，拼接后逐格等于完整树（Task 5 的「跨 column 光栅化」，4 朝向 × 含非正方形变体，逐格双向）。
2. **非正方形 AABB 的旋转**（17×16、13×12、11×13）：旋转 90° 后 `w/d` 互换，沿用未旋转的宽深做 AABB 会切掉一角（Task 4 的 `treeBox` 全变体×4 朝向）。
3. **邻域候选必须拼接，不能覆盖赋值**：`layouts` 是 3×3 邻域数组；`giantCandidates[k] = layout.giantTrees[k]` 会让区域内 99.7% 的 column 没有树（Task 5 `collectGiantTrees` + Task 6 真实 GEN 的 `⇔` 用例）。
4. **旋转必须真的发生**：`seededRandom(...) & 3` 恒为 0（4 万点直方图 `[40000,0,0,0]`）；旧测试靠 `forcedRot` 绕过所以全绿（Task 4 `giantTreeRotation` 直方图用例）。
5. **让路**：城市、地标（金字塔 / 平地岛 / 海岛 / 雪原 / 冰封山）、撒布结构、JSON 结构占地内零巨树（Task 5 排除函数 + Task 6 四条真实 GEN 用例，每条带「不排除时确有树会闯入」的对照）。⚠️ 只靠 `pointContext` 不够：平地沙台 ±15 < `pyramid_island.json` 占地 34×39。
6. **旧植被互斥是「可证明」的而非概率的**：覆盖区 = AABB ⊕ EXT，窗口 = column ⊕ EXT，EXT 与阶段 3 的植被扫描外扩是同一个常量（`VEGETATION_EXT = 3`）；单格植物不得顶掉树干底格；悬空的树干底格补地基。
7. **预算口径**：reserved 而非已用；相对 HEAD 不恶化；冲刺必须从森林/海岸起步（出生点在城市中心，三个方向冲 96 格都出不了城）。
8. **Worker 预热**：不预热则每个 Worker 的首个 GEN 付 fetch + 解析，`structure-gen` genP95 从 8.1~9.8 涨到 11.6~14.0（撞 10ms 门）。预热不能写成 top-level await（早到的 RPC 会被丢弃，首个 `layout` 死锁）。

---

## File Structure

**新建：**

| 路径 | 职责 | 任务 |
|---|---|---|
| `assets/giant-trees/src/40AssortedTreesPack.schem` | 烘焙输入（入库，262,091 B） | 1 |
| `tools/giant-trees-fingerprint.mjs` | 烘焙参数（SCALE / 族表 / 调色板 / 分类表 / 族标志）+ 输入指纹；烘焙脚本与 `check:data` 共用（红线 1） | 1 |
| `tools/bake-giant-trees.mjs` | 读 `.schem` → 剥离展示台 → 40 地块切分 → 28 变体 2×2×2 降采样 → 映射 → 锚点 → 写 JSON（`npm run gianttrees`） | 1 |
| `assets/giant-trees/trees.json` / `trees.meta.json` | 烘焙产物（156,440 B）+ 尺寸/指纹 | 1 |
| `tools/bake-giant-textures.mjs` | 6 张巨树贴图烘焙（`npm run gianttextures`）；**已在仓库里（未跟踪，只含粉叶一行）**，Task 2 补全 | 2 |
| `assets/textures/procedural/giant_*.png`（6 张） | 烘焙产物，进世界 atlas | 2 |
| `src/gen/structures/giant-trees.js` | 候选 / 变体加载 / 几何 / column 层 / 覆盖窗口（Worker 同构，无 three） | 4、5 |
| `src/tests/test-giant-trees.js` · `-column.js` · `-gen.js` | Tier 1 单测（15 + 7 + 9 = 31 条），每任务一个文件 | 4、5、6 |
| `tests/giant-trees.spec.mjs` · `tests/giant-tree-budget.spec.mjs` | Tier 4 真实页面实测（2 + 4 条） | 8 |
| `docs/giant-trees-acceptance-report.md` | 验收报告 | 10 |

> 粉叶预烘焙备用件（用户要求）曾以 `assets/giant-trees/staging/giant_cherry_leaves.png`（999 B，sha256 `8847b717…0f51`）形式存在，**已用 `cmp` 确认与终态产物逐字节相同并删除** —— 故本书项「Delete staging」在实施时若该目录已不存在，属正常（跳过即可，不要重建）。

**修改：**

| 路径 | 改动 | 任务 |
|---|---|---|
| `package.json` | 加 `gianttrees` / `gianttextures` 两个脚本 | 1、2 |
| `src/voxel/blocks-data.js` | 追加 8 个方块声明 | 2 |
| `src/voxel/faces-data.js` | 追加 8 条贴图映射 | 2 |
| `src/player/inventory.js` | 8 个方块加入 `HIDDEN_FROM_INVENTORY` | 2 |
| `assets/atlas.png` · `assets/atlas.json` | `npm run atlas` 重新生成（147 → 153 tile） | 2 |
| `src/tests/test-block-registry.js` · `test-inventory.js` · `test-orientation.js` | 4 条硬编码计数/清单断言有意同步（126→134、HIDDEN 6→14、94 项不旋转） | 2 |
| `docs/phase-1-engine-design.md` | **先于代码**：v1.68 修订说明 + §4.10 + §5 | 3 |
| `src/render/render-world.js` | `CAPACITY.opaque.active` 1200 → 1800 + 注释 | 3 |
| `tests/m3-fullscene.spec.mjs` | `gpuVertexBytes` 断言 150 → 200 MiB | 3 |
| `src/tests/index.html` | 注册三个测试文件 | 4、5、6 |
| `src/gen/structures/structure-layout.js` | `computeRegionLayout` 返回值加 `giantTrees` | 6 |
| `src/gen/structures/apply.js` | `giantAllowedAtFor` / `VEGETATION_EXT` / 阶段 2.8 / 阶段 3 三处 | 6 |
| `src/workers/world-worker.js` | Worker 加载期预热 `trees.json` | 6 |
| `tools/check-data.mjs` | 新增 `[巨树]` 环节 | 7 |
| `docs/roadmap.md` · `CLAUDE.md` · … | 文档同步 | 10 |

**明确不动**：`mesher.js` / `materials.js` / `scheduler.js` / `assets/icons-atlas.png` / `assets/icons.json`（8 个新方块全部隐藏，不在背包集合，**不需要**重跑 `npm run icons`）/ `docs/m3-baseline.*`（冻结基线）/ `tests/atlas.spec.mjs`（只数 `.` `procedural` `inventory-icons` `bed` 四个目录，新贴图落在 `procedural/` 内）。

---

## 约定与命令速查

**开发服务**：`npm start`（端口 8081，静态服务）。Playwright 自带 `webServer` 会复用/自启，跑 spec 不用先手动起；跑下面的单测脚本需要先起：

```bash
node server-script/start-server.js &    # 后台起；用完 kill。若 8081 已有本项目 server 则直接复用
```

**浏览器内单测的命令行跑法（`RUN_UNIT`，下文各任务引用）**：先建一个 git 忽略的临时脚本（`.gitignore` 已忽略 `tests/tmp-*`；它不匹配 `*.spec.mjs` 所以不会被 Playwright 当用例）：

```javascript
// tests/tmp-unit.mjs — 浏览器内单测 harness 的命令行跑法（git 忽略的临时脚本，不提交；.gitignore 已忽略 tests/tmp-*）
// 用法：node tests/tmp-unit.mjs [名字子串]        环境变量 UNIT_URL 覆盖地址（默认 http://localhost:8081/src/tests/index.html）
// 输出：`harness: passed=N failed=M total=T` + 每个失败用例的名字与错误；给了子串则改为列出名字含该子串的全部用例及状态。
// 整页失败（静态 import 缺导出 / 模块 404 / 语法错）时 window.__MC_TEST_RESULTS__ 不会出现 → 输出「整页失败」与 pageerror。
import { chromium } from 'playwright';

const url = process.env.UNIT_URL || 'http://localhost:8081/src/tests/index.html';
const filter = process.argv[2] || '';
const browser = await chromium.launch({ channel: 'chromium', headless: true });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('response', (r) => { if (r.status() >= 400) errs.push(`HTTP ${r.status()}: ${r.url()}`); });
await page.goto(url);

let res = null;
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  res = await page.evaluate(() => window.__MC_TEST_RESULTS__ ?? null);
  if (res) break;
  // 致命信号：未捕获异常，或 /src 下的 .js 模块 404（缺模块 → 整页不会跑）→ 再给 3s 确认结果确实不会出现
  if (errs.some((e) => e.startsWith('pageerror') || /^HTTP \d+: .*\/src\/.*\.js$/.test(e))) {
    await page.waitForTimeout(3000);
    res = await page.evaluate(() => window.__MC_TEST_RESULTS__ ?? null);
    break;
  }
  await page.waitForTimeout(250);
}

if (!res) {
  console.log('✗ 整页失败：window.__MC_TEST_RESULTS__ 未出现（静态 import 缺导出 / 模块 404 / 语法错 → 所有套件一起失去结果）');
  for (const e of [...new Set(errs)].slice(0, 8)) console.log(`    ${e}`);
} else {
  console.log(`harness: passed=${res.passed} failed=${res.failed} total=${res.total}`);
  for (const s of res.suites) {
    for (const t of s.tests) {
      const show = filter ? t.name.includes(filter) : t.status === 'failed';
      if (show) console.log(`  ${t.status === 'passed' ? '✓' : '✗'} ${t.name}${t.error ? `\n        ↳ ${String(t.error).slice(0, 260)}` : ''}`);
    }
  }
}
await browser.close();
process.exit(res && res.failed === 0 ? 0 : 1);
```

```bash
node tests/tmp-unit.mjs                 # 输出 harness: passed=N failed=M total=T，并列出失败用例
node tests/tmp-unit.mjs 巨树            # 列出名字含「巨树」的全部用例及状态
```

整页失败（静态 import 缺导出 / 模块 404 / 语法错）时 `window.__MC_TEST_RESULTS__` 不会出现，脚本输出 `✗ 整页失败` 并列出 `pageerror`——这是本仓新模块 TDD 的 **RED 形态**：新测试文件静态 import 了尚不存在的导出，浏览器拒绝加载整个测试页，**所有既有套件一并失去结果**。这不是「单个用例红」，但它是真的红（正是 RED 要验证的）。

**门禁分层**（testing-policy §6）：本 Epic 是 Tier 1（机制 + 生成协议）+ Tier 2（数据契约）+ Tier 4（真实页面），热路径文件 `render-world.js` 有改动 → 最终要跑 `npm test` 与 `npm run bench -- --check`。

---

## Task 1: 素材入库、烘焙工具与指纹模块

**Files:**
- Create: `assets/giant-trees/src/40AssortedTreesPack.schem`（拷贝，262,091 B）
- Create: `tools/giant-trees-fingerprint.mjs`
- Create: `tools/bake-giant-trees.mjs`
- Create: `assets/giant-trees/trees.json` · `assets/giant-trees/trees.meta.json`（烘焙产物）
- Modify: `package.json`

**Interfaces:**
- Consumes: 素材 `.schem`（gzip NBT，Sponge Schematic v3）。NBT 读取用 Node 内置 `node:zlib` 手写的最小 reader（tag 1~12），本仓无 NBT 依赖，不新增。
- Produces:
  - `giant-trees-fingerprint.mjs` 导出 `SCHEM_PATH` / `TREES_JSON` / `TREES_META`、`SCALE`、`PAD_COUNT`、`sortPads`、`TREE_FAMILIES`、`FAMILY_PALETTES`、`SOURCE_MAP`、`DISPLAY_BLOCKS`、`FAMILY_MARKERS`、`giantTreesInputFingerprint()`。
  - `trees.json` 形状：`{ version: 1, scale: 2, trees: { "<family>": [ { pad, w, d, h, anchor: [ax, az], palette: string[], blocks: number[] } ] } }`；`blocks` 是扁平四元组 `[gx, gy, gz, palIdx, …]`，坐标以「块底角」为原点、`gy ∈ [0, h)`；**`palette[0]` 恒为树干**。
  - `trees.meta.json` 形状：`{ scale, variantCount, families: {<族>: 变体数}, totalBlocks, fingerprints: { input, schemSha256, paramsSha256 } }`。

**设计要点**（都有实测依据，见 spec §2）：

1. **地块切分**：`netherite_block` 在 `y=1` 层的 4 连通分量恰好 40 个（8 连通结果相同），每个分量的 bbox 就是一个地块；树体取 `y ∈ [2, H)`。**地块索引 = 按 `(minZ, minX)` 升序排好后的下标**（`sortPads`）——这个约定是载荷性的：改成 x 优先则 40 个位置全部错位。
2. **降采样规则写死**：每个 2×2×2 立方块内，空气 / 展示台 / 被丢弃的装饰件**不参与投票**；只要有 ≥1 个可映射方块该格就保留，取出现次数最多的调色板下标，同票下标小者胜（`palette[0]` = 树干，所以树干不会在降采样里消失）。字面「多数投票」（空气算一票）只会得到 6.4k~10.2k 格的空壳树。
3. **分类表显式**：28 个变体里共出现 24 个源方块名，`SOURCE_MAP` 按族逐个归属（`-1` = 丢弃：装饰件 `*_slab` / `*_stairs` / `*_trapdoor` / `*_fence` 与展示台上的地被 `large_fern`）。**素材里出现、表里没有的名字烘焙时直接 throw**——不允许「悄悄丢掉」。樱花冠主体是 `pink_concrete(_powder)` / `pink_wool` / `sponge`（占樱花树体约 70%），全部并入樱花叶。
4. **族归属有两道防线**：① `SOURCE_MAP` 对未知名字 throw（实测先触发）；② `FAMILY_MARKERS` 用「源方块名集合」反向校验每个变体属于哪一族（兜底，防映射被放宽后排序约定仍错位）。
5. **锚点** = `gy=0` 层树干格中离几何中心最近者（不是几何中心，28 个变体实测最大偏移 2 格）。
6. **总格数区间断言** `[16000, 18000]`（实测 16,954）：规则 / 映射 / 排序任一被改动都会落在区间外。烘焙在**全部校验通过之后**才写文件，失败不产生半成品。

---

- [ ] **Step 1: 素材入库**

```bash
mkdir -p assets/giant-trees/src
cp "$HOME/ttt/[BoutiqueBuilds] 40AssortedTreesPack/[SCHEMATIC] 40AssortedTreesPack.schem" assets/giant-trees/src/40AssortedTreesPack.schem
stat -f%z assets/giant-trees/src/40AssortedTreesPack.schem      # Linux: stat -c%s
shasum -a 256 assets/giant-trees/src/40AssortedTreesPack.schem
```

Expected：大小 `262091`；sha256 `217e215b0538262ba89dae354e33511eec2db9e3e264e45165956294c9293aa8`。（路径含方括号与空格，**必须加引号**，否则 zsh 会把 `[...]` 当 glob。）

- [ ] **Step 2: 写 `tools/giant-trees-fingerprint.mjs`**

参数与指纹的单一权威。烘焙脚本与 `check:data` 共用（红线 1，沿用 `turret-armor-fingerprint.mjs` 的模式）；指纹 = 入库 `.schem` 的 sha256 + 全部烘焙参数的 sha256，**不依赖任何仓库外文件**。

```javascript
// tools/giant-trees-fingerprint.mjs — 巨树烘焙的参数与输入指纹
//
// **两个消费者共用同一份逻辑**（红线 1），沿用 `turret-armor-fingerprint.mjs` 的模式：
//   - `tools/bake-giant-trees.mjs` 烘焙时按本参数生成并写进 `assets/giant-trees/trees.meta.json`
//   - `tools/check-data.mjs` 用当前参数重算并比对 → 不匹配即报「跑 npm run gianttrees」
//
// trees.json 是**派生产物**，权威输入 = 入库的 `.schem` + 本文件的全部参数。改了源文件/映射表却忘跑烘焙，
// 产物会静默过期（渲染旧树形，肉眼只觉得「树形怪怪的」）。
//
// 素材**入库**（`assets/giant-trees/src/`，与 `assets/sky/night-src/` 同口径：烘焙输入，不是渲染资源）：
// 指纹因此不依赖任何仓库外文件，任何机器 `npm run check` 结果一致。
//
// node 侧模块（要读文件），不进 src/，浏览器不消费。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..');

/** 产物与输入路径（烘焙脚本与门禁共用，避免两处各写一份） */
export const SCHEM_PATH = path.join(ROOT, 'assets', 'giant-trees', 'src', '40AssortedTreesPack.schem');
export const TREES_JSON = path.join(ROOT, 'assets', 'giant-trees', 'trees.json');
export const TREES_META = path.join(ROOT, 'assets', 'giant-trees', 'trees.meta.json');

/** 降采样比例：每 SCALE³ 立方块合成 1 格（1/2 比例） */
export const SCALE = 2;

/** 素材里的地块总数（netherite_block 圈在 y=1 层的连通分量数） */
export const PAD_COUNT = 40;

/**
 * 地块（pad）索引 = 把 40 个连通分量按 `(minZ, minX)` 升序排好后的下标。
 * ⚠️ 这个排序约定是载荷性的：改成 x 优先则 40 个位置全部错位，整张族映射表作废。
 * 唯一实现 = `sortPads()`；烘焙脚本末尾还会按 FAMILY_MARKERS 用源方块名反向校验族归属。
 */
export function sortPads(pads) {
  return [...pads].sort((a, b) => a.minZ - b.minZ || a.minX - b.minX);
}

/**
 * 族 → 变体（pad 索引，按数组顺序即运行时变体顺序）。
 * 28 个变体 = 40 − 12 个排除项：
 *   - 12/18/28/38：云杉带园墙，实测**无树干**（只有叶团 + 砖墙/栅栏门）；
 *   - 4/9/15/25/35：混交巨树（jungle+oak 叶混生，偏热带，spec §2.2 决策：不用于森林）；
 *   - 2/3/5：丛林巨树（同上，且无任何落位路径使用它们 —— 不烘焙死数据）。
 */
export const TREE_FAMILIES = Object.freeze({
  tallOak: Object.freeze([8, 10, 14, 16, 24, 26, 34, 36]),       // 高橡 / 白桦
  snowSpruce: Object.freeze([11, 17, 27, 37]),                    // 雪松
  cherry: Object.freeze([0, 1, 6, 7]),                            // 樱花
  palm: Object.freeze([13, 19, 29, 39]),                          // 椰子树
  banyanLeafy: Object.freeze([20, 21, 30, 31]),                   // 榕树（有叶）
  banyanBare: Object.freeze([22, 23, 32, 33]),                    // 榕树（枯干）
});

/**
 * 族 → 调色板。**`palette[0]` 恒为树干**（运行时的地基填充按这个约定认树干，见 giant-trees.js）。
 * 全部 8 个名字 = Task 2 声明的 8 个 `giant_*` 方块，不多不少（check:data 双向断言）。
 */
export const FAMILY_PALETTES = Object.freeze({
  tallOak: Object.freeze(['giant_oak_log', 'giant_oak_leaves', 'giant_birch_leaves']),
  snowSpruce: Object.freeze(['giant_oak_log', 'giant_spruce_leaves']),
  cherry: Object.freeze(['giant_oak_log', 'giant_cherry_leaves']),
  palm: Object.freeze(['giant_oak_log', 'giant_palm_leaves']),
  banyanLeafy: Object.freeze(['giant_mangrove_log', 'giant_banyan_leaves']),
  banyanBare: Object.freeze(['giant_mangrove_log']),
});

/**
 * 族 → 源方块名 → 调色板下标（-1 = 丢弃）。这是**唯一**的分类表：
 * 素材里出现、但表里没有的方块名会让烘焙直接 throw（不允许「悄悄丢掉」或「悄悄归到某类」）。
 *
 * 丢弃的两类：① 装饰件（栅栏/台阶/半砖/活板门/雪层以外的几何，实测占 3.6%）——它们需要新几何模板，
 * 本 Epic 不做；② 地面植被（large_fern：展示台上的地被，不是树的一部分）。
 * 保留的「花色」：樱花树的粉色体积主要来自 pink_concrete(_powder)/pink_wool/sponge（占樱花树体 ~70%），
 * 全部并入樱花叶（漏掉 pink_concrete* 会把樱花冠掏空近三成）。
 * 雪块/雪层并入雪松的叶（8 个方块是上限，不新增雪方块）。
 */
export const SOURCE_MAP = Object.freeze({
  tallOak: Object.freeze({
    oak_wood: 0, birch_wood: 0, oak_leaves: 1, birch_leaves: 2,
    large_fern: -1, spruce_slab: -1, spruce_stairs: -1,
  }),
  snowSpruce: Object.freeze({
    stripped_dark_oak_wood: 0, spruce_leaves: 1, snow_block: 1, snow: 1,
    dark_oak_slab: -1, dark_oak_trapdoor: -1, dark_oak_fence: -1,
  }),
  cherry: Object.freeze({
    spruce_planks: 0, oak_wood: 0, stripped_spruce_wood: 0,
    cherry_leaves: 1, pink_concrete_powder: 1, pink_concrete: 1, pink_wool: 1, sponge: 1,
    spruce_slab: -1,
  }),
  palm: Object.freeze({ spruce_planks: 0, jungle_leaves: 1 }),
  banyanLeafy: Object.freeze({ mangrove_wood: 0, oak_leaves: 1, birch_leaves: 1 }),
  banyanBare: Object.freeze({ dark_oak_wood: 0, dark_oak_fence: -1 }),
});

/** 展示台材质（不是树）：连同 air 一起，在所有统计与降采样里一律跳过 */
export const DISPLAY_BLOCKS = Object.freeze(new Set([
  'air', 'cyan_terracotta', 'light_gray_concrete', 'white_stained_glass', 'netherite_block',
]));

/**
 * 族归属的反向校验（防「排序约定错了 → 整张映射表错位」静默发生）：
 * 每个变体的**源方块名集合**必须：包含 `has` 全部；对 `hasAnyOf` 的每一组至少含其中一个；不含 `lacks` 任一。
 */
export const FAMILY_MARKERS = Object.freeze({
  tallOak: { has: [], hasAnyOf: [['oak_wood', 'birch_wood'], ['oak_leaves', 'birch_leaves']], lacks: ['jungle_leaves', 'snow_block', 'cherry_leaves'] },
  snowSpruce: { has: ['snow_block', 'spruce_leaves'], lacks: ['birch_leaves', 'cherry_leaves'] },
  cherry: { has: ['cherry_leaves'], lacks: ['snow_block', 'jungle_leaves'] },
  palm: { has: ['jungle_leaves', 'spruce_planks'], lacks: ['dark_oak_wood', 'oak_leaves'] },
  banyanLeafy: { has: ['mangrove_wood'], lacks: ['dark_oak_wood', 'cherry_leaves'] },
  banyanBare: { has: ['dark_oak_wood'], lacks: ['mangrove_wood', 'oak_leaves', 'birch_leaves'] },
});

/** 输入指纹：入库 .schem 的内容哈希 + 全部烘焙参数。.schem 缺失即 throw（它是入库文件，缺了是仓库损坏）。 */
export function giantTreesInputFingerprint() {
  if (!fs.existsSync(SCHEM_PATH)) throw new Error(`[巨树] 烘焙输入缺失：${SCHEM_PATH}`);
  const schemSha = crypto.createHash('sha256').update(fs.readFileSync(SCHEM_PATH)).digest('hex');
  const params = JSON.stringify({
    scale: SCALE, padCount: PAD_COUNT, families: TREE_FAMILIES, palettes: FAMILY_PALETTES, map: SOURCE_MAP,
    markers: FAMILY_MARKERS,
  });
  const paramsSha = crypto.createHash('sha256').update(params).digest('hex');
  return { schemSha256: schemSha, paramsSha256: paramsSha, input: `${schemSha.slice(0, 16)}:${paramsSha.slice(0, 16)}` };
}
```

- [ ] **Step 3: 写 `tools/bake-giant-trees.mjs`**

```javascript
// tools/bake-giant-trees.mjs — 把 40AssortedTreesPack.schem 烘焙成 1/2 比例的巨树变体 JSON
// 用法：npm run gianttrees → assets/giant-trees/trees.json + trees.meta.json
//
// 流程：gunzip → 最小 NBT 读取（Sponge Schematic v3）→ 剥离展示台 → 40 个地块切分（netherite 圈连通分量）
//   → 取 TREE_FAMILIES 里的 28 个变体 → 2×2×2 降采样 → 按族调色板映射 → 锚点 → 写 JSON。
//
// 降采样规则（**载荷性，勿改成「空气参与的多数投票」**）：
//   每个 2×2×2 立方块内，**空气/展示台/被丢弃的装饰件都不参与投票**；只要有 ≥1 个「可映射方块」，
//   该格就保留，取出现次数最多的调色板下标；同票时下标小者胜（palette[0] = 树干，所以树干不会在
//   降采样里消失）。这条规则对 40 棵全量的产出（~26k 格）与设计文档 §2.3 的 25,640 相符；字面
//   「多数投票」（空气算一票）只会得到 6k~10k 格，树变成稀疏空壳，且全部预算数字都不适用。
//
// 索引序：(y*Length + z)*Width + x（实测唯一能让 y=0 层是完整 400×254 平面的序）。
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import {
  SCHEM_PATH, TREES_JSON, TREES_META, SCALE, PAD_COUNT, TREE_FAMILIES, FAMILY_PALETTES, SOURCE_MAP,
  DISPLAY_BLOCKS, FAMILY_MARKERS, sortPads, giantTreesInputFingerprint,
} from './giant-trees-fingerprint.mjs';

/** 28 个变体降采样后的总格数验收区间（实测 16,954；落区间外 = 规则/映射/排序被改动，须人工复核） */
const TOTAL_BLOCKS_RANGE = [16000, 18000];

// ---------------------------------------------------------------- NBT 读取（只实现 tag 1~12）

class NbtReader {
  constructor(buf) { this.b = buf; this.o = 0; }
  u1() { return this.b[this.o++]; }
  i1() { const v = this.b.readInt8(this.o); this.o += 1; return v; }
  i2() { const v = this.b.readInt16BE(this.o); this.o += 2; return v; }
  i4() { const v = this.b.readInt32BE(this.o); this.o += 4; return v; }
  i8() { const v = this.b.readBigInt64BE(this.o); this.o += 8; return v; }
  f4() { const v = this.b.readFloatBE(this.o); this.o += 4; return v; }
  f8() { const v = this.b.readDoubleBE(this.o); this.o += 8; return v; }
  str() { const n = this.b.readUInt16BE(this.o); this.o += 2; const s = this.b.toString('utf8', this.o, this.o + n); this.o += n; return s; }
  payload(t) {
    switch (t) {
      case 1: return this.i1();
      case 2: return this.i2();
      case 3: return this.i4();
      case 4: return this.i8();
      case 5: return this.f4();
      case 6: return this.f8();
      case 7: { const n = this.i4(); const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
      case 8: return this.str();
      case 9: { const it = this.u1(); const n = this.i4(); const a = []; for (let i = 0; i < n; i++) a.push(this.payload(it)); return a; }
      case 10: { const o = {}; for (;;) { const tt = this.u1(); if (tt === 0) break; const k = this.str(); o[k] = this.payload(tt); } return o; }
      case 11: { const n = this.i4(); const a = new Int32Array(n); for (let i = 0; i < n; i++) a[i] = this.i4(); return a; }
      case 12: { const n = this.i4(); const a = []; for (let i = 0; i < n; i++) a.push(this.i8()); return a; }
      default: throw new Error(`NBT: 未知 tag ${t}`);
    }
  }
}

function loadSchematic() {
  const root = (() => { const r = new NbtReader(zlib.gunzipSync(fs.readFileSync(SCHEM_PATH))); const t = r.u1(); r.str(); return r.payload(t); })();
  const S = root.Schematic || root;
  const { Width: W, Height: H, Length: L } = S;
  const pal = []; for (const [name, id] of Object.entries(S.Blocks.Palette)) pal[id] = name.replace('minecraft:', '').split('[')[0];
  // Data = varint 数组
  const data = S.Blocks.Data; const blocks = new Uint16Array(W * H * L); let p = 0, n = 0;
  while (p < data.length) { let v = 0, sh = 0, b; do { b = data[p++]; v |= (b & 0x7f) << sh; sh += 7; } while (b & 0x80); blocks[n++] = v; }
  if (n !== W * H * L) throw new Error(`Data 长度 ${n} ≠ ${W}×${H}×${L}`);
  return { W, H, L, pal, blocks, at: (x, y, z) => pal[blocks[(y * L + z) * W + x]] };
}

// ---------------------------------------------------------------- 地块切分

/** netherite_block 在 y=1 层的 4 连通分量 → 每个分量一个地块 bbox；返回 (minZ,minX) 升序 */
function slicePads(s) {
  const { W, L } = s; const seen = new Uint8Array(W * L); const pads = [];
  for (let z = 0; z < L; z++) for (let x = 0; x < W; x++) {
    if (seen[z * W + x] || s.at(x, 1, z) !== 'netherite_block') continue;
    const st = [[x, z]]; seen[z * W + x] = 1; let minX = x, maxX = x, minZ = z, maxZ = z;
    while (st.length) {
      const [cx, cz] = st.pop(); minX = Math.min(minX, cx); maxX = Math.max(maxX, cx); minZ = Math.min(minZ, cz); maxZ = Math.max(maxZ, cz);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= W || nz >= L || seen[nz * W + nx] || s.at(nx, 1, nz) !== 'netherite_block') continue;
        seen[nz * W + nx] = 1; st.push([nx, nz]);
      }
    }
    pads.push({ minX, maxX, minZ, maxZ });
  }
  if (pads.length !== PAD_COUNT) throw new Error(`地块数 ${pads.length} ≠ ${PAD_COUNT}（展示台切分失败）`);
  return sortPads(pads);
}

// ---------------------------------------------------------------- 单个变体：降采样 + 映射

function bakeVariant(s, pad, family, padIndex) {
  const map = SOURCE_MAP[family]; const palette = FAMILY_PALETTES[family]; const P = palette.length;
  const width = pad.maxX - pad.minX + 1, depth = pad.maxZ - pad.minZ + 1, height = s.H - 2; // y 从 2 起（y=0 地板、y=1 展示台圈）
  const nx = Math.ceil(width / SCALE), nz = Math.ceil(depth / SCALE), ny = Math.ceil(height / SCALE);
  const votes = new Uint16Array(nx * ny * nz * P);
  const seenNames = new Set();
  for (let y = 2; y < s.H; y++) for (let z = pad.minZ; z <= pad.maxZ; z++) for (let x = pad.minX; x <= pad.maxX; x++) {
    const name = s.at(x, y, z);
    if (DISPLAY_BLOCKS.has(name)) continue;
    seenNames.add(name);
    if (!(name in map)) throw new Error(`[${family}#${padIndex}] 源方块 "${name}" 不在 SOURCE_MAP 里（须显式映射或显式丢弃 -1）`);
    const pi = map[name]; if (pi < 0) continue;
    const gx = Math.floor((x - pad.minX) / SCALE), gy = Math.floor((y - 2) / SCALE), gz = Math.floor((z - pad.minZ) / SCALE);
    votes[((gy * nz + gz) * nx + gx) * P + pi]++;
  }
  // 逐格取最大票（空气不参与；同票下标小者胜）
  const cells = []; let mnx = 1e9, mny = 1e9, mnz = 1e9, mxx = -1, mxy = -1, mxz = -1;
  for (let gy = 0; gy < ny; gy++) for (let gz = 0; gz < nz; gz++) for (let gx = 0; gx < nx; gx++) {
    const base = ((gy * nz + gz) * nx + gx) * P; let best = -1, bestN = 0;
    for (let pi = 0; pi < P; pi++) if (votes[base + pi] > bestN) { bestN = votes[base + pi]; best = pi; }
    if (best < 0) continue;
    cells.push([gx, gy, gz, best]);
    mnx = Math.min(mnx, gx); mny = Math.min(mny, gy); mnz = Math.min(mnz, gz); mxx = Math.max(mxx, gx); mxy = Math.max(mxy, gy); mxz = Math.max(mxz, gz);
  }
  if (cells.length === 0) throw new Error(`[${family}#${padIndex}] 降采样后为空`);
  const w = mxx - mnx + 1, h = mxy - mny + 1, d = mxz - mnz + 1;
  const blocks = []; const layer0 = [];
  for (const [gx, gy, gz, pi] of cells) {
    const x = gx - mnx, y = gy - mny, z = gz - mnz; blocks.push(x, y, z, pi);
    if (y === 0 && pi === 0) layer0.push([x, z]);
  }
  // 锚点 = gy=0 层树干格中离几何中心 (w/2, d/2) 最近者（平分取遍历序最先者）。
  // ⚠️ 不是几何中心（实测最大偏移 ±2 格）：光栅化时锚点对齐候选点，用几何中心会让树干偏出最多 2 格。
  if (layer0.length === 0) throw new Error(`[${family}#${padIndex}] gy=0 层没有树干格 → 无法定锚点`);
  let anchor = null, bd = Infinity;
  for (const [x, z] of layer0) { const dd = (x - w / 2) ** 2 + (z - d / 2) ** 2; if (dd < bd) { bd = dd; anchor = [x, z]; } }
  return { pad: padIndex, w, d, h, anchor, palette: [...palette], blocks, seenNames };
}

// ---------------------------------------------------------------- 校验（任一不满足即 throw，不产生半成品）

function validate(variants) {
  let total = 0;
  for (const [family, list] of Object.entries(variants)) {
    if (list.length !== TREE_FAMILIES[family].length) throw new Error(`${family} 变体数 ${list.length} ≠ ${TREE_FAMILIES[family].length}`);
    const mk = FAMILY_MARKERS[family];
    list.forEach((v, i) => {
      const tag = `${family}[${i}](pad ${v.pad})`;
      if (!v.anchor || v.anchor[0] < 0 || v.anchor[0] >= v.w || v.anchor[1] < 0 || v.anchor[1] >= v.d) throw new Error(`${tag} 锚点越界`);
      const seen = new Set(); let mx = [-1, -1, -1];
      for (let k = 0; k < v.blocks.length; k += 4) {
        const [x, y, z, pi] = [v.blocks[k], v.blocks[k + 1], v.blocks[k + 2], v.blocks[k + 3]];
        if (pi < 0 || pi >= v.palette.length) throw new Error(`${tag} palIdx ${pi} 越界`);
        if (x < 0 || x >= v.w || y < 0 || y >= v.h || z < 0 || z >= v.d) throw new Error(`${tag} 坐标越界 ${x},${y},${z}`);
        const key = (y * v.d + z) * v.w + x; if (seen.has(key)) throw new Error(`${tag} 坐标重复 ${x},${y},${z}`); seen.add(key);
        mx = [Math.max(mx[0], x), Math.max(mx[1], y), Math.max(mx[2], z)];
      }
      if (mx[0] !== v.w - 1 || mx[1] !== v.h - 1 || mx[2] !== v.d - 1) throw new Error(`${tag} w/h/d 与 blocks 极值不一致`);
      // 族归属反向校验：源方块名集合须符合该族的标志
      for (const n of mk.has) if (!v.seenNames.has(n)) throw new Error(`${tag} 缺少族标志源方块 "${n}"（pad 排序约定被破坏？）`);
      for (const grp of mk.hasAnyOf || []) if (!grp.some((n) => v.seenNames.has(n))) throw new Error(`${tag} 缺少族标志源方块之一 [${grp}]`);
      for (const n of mk.lacks) if (v.seenNames.has(n)) throw new Error(`${tag} 含有不属于该族的源方块 "${n}"（pad 排序约定被破坏？）`);
      total += v.blocks.length / 4;
    });
  }
  if (total < TOTAL_BLOCKS_RANGE[0] || total > TOTAL_BLOCKS_RANGE[1]) {
    throw new Error(`28 个变体共 ${total} 格，不在验收区间 [${TOTAL_BLOCKS_RANGE}]（降采样规则/映射表/排序被改动？）`);
  }
  return total;
}

function main() {
  const s = loadSchematic();
  const pads = slicePads(s);
  const variants = {};
  for (const [family, padIdxs] of Object.entries(TREE_FAMILIES)) {
    variants[family] = padIdxs.map((pi) => bakeVariant(s, pads[pi], family, pi));
  }
  const total = validate(variants);
  const out = { version: 1, scale: SCALE, trees: {} };
  for (const [family, list] of Object.entries(variants)) {
    out.trees[family] = list.map(({ pad, w, d, h, anchor, palette, blocks }) => ({ pad, w, d, h, anchor, palette, blocks }));
  }
  const json = JSON.stringify(out);
  fs.mkdirSync(path.dirname(TREES_JSON), { recursive: true });
  fs.writeFileSync(TREES_JSON, json);
  const fp = giantTreesInputFingerprint();
  const familyCounts = Object.fromEntries(Object.entries(variants).map(([f, l]) => [f, l.length]));
  fs.writeFileSync(TREES_META, JSON.stringify({
    scale: SCALE, variantCount: Object.values(familyCounts).reduce((a, b) => a + b, 0), families: familyCounts,
    totalBlocks: total, fingerprints: { input: fp.input, schemSha256: fp.schemSha256, paramsSha256: fp.paramsSha256 },
  }, null, 2) + '\n');

  console.log(`trees.json ${(json.length / 1024).toFixed(1)} KB，${Object.keys(variants).length} 族共 ${Object.values(familyCounts).reduce((a, b) => a + b, 0)} 个变体，${total} 格`);
  for (const [f, l] of Object.entries(variants)) {
    const ws = l.map((v) => `${v.w}×${v.d}×${v.h}`).join(' ');
    console.log(`  ${f.padEnd(12)} ${l.length} 个  尺寸 ${ws}  格数 ${l.map((v) => v.blocks.length / 4).join('/')}`);
  }
}

main();
```

- [ ] **Step 4: 加 npm 脚本**

在 `package.json` 的 `scripts` 里 `"turret": ...` 之后加一行（逗号别漏）：

```json
    "gianttrees": "node tools/bake-giant-trees.mjs",
```

- [ ] **Step 5: 运行烘焙并核对产物**

Run: `npm run gianttrees`

Expected（逐行一致；格数、尺寸都是确定性的）：

```text
trees.json 152.8 KB，6 族共 28 个变体，16954 格
  tallOak      8 个  尺寸 10×10×42 10×10×33 10×11×32 11×12×28 10×10×26 11×11×26 9×9×19 9×10×20  格数 874/915/671/744/366/631/249/399
  snowSpruce   4 个  尺寸 11×12×38 9×9×32 10×9×27 9×8×16  格数 932/467/353/232
  cherry       4 个  尺寸 17×17×27 17×17×20 17×17×21 15×15×13  格数 1698/1244/1155/546
  palm         4 个  尺寸 11×9×22 11×11×20 11×11×16 11×11×14  格数 225/205/190/214
  banyanLeafy  4 个  尺寸 17×17×12 17×15×16 17×17×18 17×17×21  格数 571/738/1057/1197
  banyanBare   4 个  尺寸 13×13×26 12×13×20 13×13×18 13×11×15  格数 383/259/242/197
```

```bash
shasum -a 256 assets/giant-trees/trees.json assets/giant-trees/trees.meta.json
npm run gianttrees >/dev/null && shasum -a 256 assets/giant-trees/trees.json     # 第二次烘焙：必须逐字节相同
```

Expected：`trees.json` = 156,440 B，sha256 `d3dd1d2e3baa561b99a840251d3ad3febcd1b0009bf46dc5514db4076e35faf6`；`trees.meta.json` sha256 `bd58702a5fe87d7b80189d45880e352bc01605ca9badd39fbdefde178a8283c6`（含 `"input": "217e215b0538262b:223838c7cfec01d6"`）。第二次烘焙的 sha256 与第一次相同（确定性）。

- [ ] **Step 6: 负向验证 —— 烘焙脚本的断言必须真红**

逐条临时注入、跑 `node tools/bake-giant-trees.mjs`、确认**非零退出且 `trees.json` 未被改写**，然后复原。（实测全部成立。）

| # | 临时改动（`tools/giant-trees-fingerprint.mjs`） | 实测错误信息 |
|---|---|---|
| ① | `sortPads` 的比较改成 `a.minX - b.minX \|\| a.minZ - b.minZ`（x 优先） | `[tallOak#14] 源方块 "stripped_dark_oak_wood" 不在 SOURCE_MAP 里（须显式映射或显式丢弃 -1）` |
| ② | `cherry` 映射里删掉 `pink_concrete: 1` | `[cherry#0] 源方块 "pink_concrete" 不在 SOURCE_MAP 里（须显式映射或显式丢弃 -1）` |
| ③ | `export const SCALE = 3` | `28 个变体共 7849 格，不在验收区间 [16000,18000]（降采样规则/映射表/排序被改动？）` |
| ④ | `snowSpruce` 的地块下标 `37` 改成 `36` | `[snowSpruce#36] 源方块 "oak_wood" 不在 SOURCE_MAP 里（须显式映射或显式丢弃 -1）` |
| ⑤ | 把 `banyanBare` 的第一个地块改成 `20`（banyanLeafy 的地块）**并**放宽 `banyanBare` 映射（加 `mangrove_wood: 0, oak_leaves: -1, birch_leaves: -1`）——绕过 ①~④ 的未知名字检查 | `banyanBare[0](pad 20) 缺少族标志源方块 "dark_oak_wood"（pad 排序约定被破坏？）` |

> ①④ 都是 `SOURCE_MAP` 的「未知名字 throw」先触发；⑤ 才是只有 `FAMILY_MARKERS` 能抓到的情形——证明兜底防线确实活着。

- [ ] **Step 7: 静态门**

Run: `npm run lint && npm run check:arch`

Expected：lint `✖ 15 problems (0 errors, 15 warnings)`（HEAD 既有 warning，本任务不新增）；`check:arch` `✓ 架构红线全部守住`。此时 `npm run check:data` 仍全绿（`[巨树]` 环节在 Task 7 才加）。

- [ ] **Step 8: 提交**（仅在用户明确要求提交时）

```bash
git add assets/giant-trees/src assets/giant-trees/trees.json assets/giant-trees/trees.meta.json \
        tools/giant-trees-fingerprint.mjs tools/bake-giant-trees.mjs package.json
git commit -m "feat(giant-trees): 入库素材并烘焙 28 个景观树变体"
```

> `assets/giant-trees/staging/` 是预烘焙备用件的临时落脚点（已消费并删除），**不要 `git add`**。

---

## Task 2: 8 个方块、6 张贴图、atlas 重建与既有计数断言同步

**Files:**
- Modify: `tools/bake-giant-textures.mjs`（**已在仓库工作区里，未跟踪，只含粉叶一行**；本任务补全另外 5 行）
- Create: `assets/textures/procedural/giant_{birch_leaves,spruce_leaves,cherry_leaves,palm_leaves,banyan_leaves,mangrove_log}.png`（6 张，烘焙产物）
- Modify: `package.json`（加 `gianttextures`）
- Modify: `src/voxel/blocks-data.js`（尾部追加 8 个方块声明）· `src/voxel/faces-data.js`（8 条贴图映射）· `src/player/inventory.js`（`HIDDEN_FROM_INVENTORY` 追加 8 项）
- Modify: `assets/atlas.png` · `assets/atlas.json`（`npm run atlas` 重新生成）
- Modify: `src/tests/test-block-registry.js` · `test-inventory.js` · `test-orientation.js`（4 条硬编码计数/清单断言，**有意同步**）
- Delete: `assets/giant-trees/staging/`（粉叶预烘焙暂存，`cmp` 之后；**若已不存在则跳过** —— 本仓当前已删除）

**Interfaces:**
- Produces：registry 126 → **134** 个方块；世界 atlas 147 → **153** tile；`HIDDEN_FROM_INVENTORY` 6 → **14** 项（背包集合仍是 116 项 = 134 − 4 − 14）。
- 8 个方块的 palette 名字集合必须恰好等于 `FAMILY_PALETTES` 里出现的名字（多一个 = 死方块，少一个 = 烘焙产物指向不存在的方块 → `makeColumnSetter` 对未注册名**静默跳过**，树上出现空洞）。Task 7 的 `[巨树]` 门禁双向钉住。

**设计要点**（spec §3.6）：

1. **全部 `geometry:"box"`、`cullMode:"opaque"`、`orientationModes:0`**：mesher 零改动。树叶 `opaque` 让叶-叶共享面互剔（单棵树顶点远少于 cutout）。
2. **树叶投影（用户裁决）**：**不写** `shadowCast:false`（它与同为 opaque 叶的 `sky_leaves`、既有 `leaves` 口径不一致；`[阴影投射]` 门禁的 13 项清单也要求 `leaves` 必须投影——v1.0 的写法在本任务末尾 `check:data` 即红，见 Step 7 的注入）；**不写** `opaque:false`（叶-叶不再互剔）。
3. **全部加入 `HIDDEN_FROM_INVENTORY`，不是 `NON_PLACEABLE_ITEMS`**（两个集合语义互斥：前者 = 可放置但不进背包，与 `chimney` 同类；后者 = 非玩家可放置的功能性方块）。
4. **贴图 = 沿用现有镂空叶的图案，只换色**。源图 `assets/textures/leaves.png`（16×16；59 个不透明 / 13 个全透明 / 184 个半透明；`alpha < 77` 的 80 个像素是 cutout 材质 `alphaTest 0.3` 会丢弃的「镂空」）。
   - **alpha 通道逐字节保留**（孔洞形状不变）；RGB **全部重算，含 `alpha=0` 的像素**：巨树叶走 opaque 通道，材质无 `alphaTest`，**alpha 被忽略 → 孔洞处直接显示该像素的 RGB**。若把透明像素的 RGB 留成原来的绿色，粉叶上会渗出绿点；留成黑色则出黑点。`[巨树]` 门禁钉「无近黑像素」。
   - 重着色 = 亮度比乘法：`out = base × k`，`k = max(0.45, 1 + CONTRAST × (Y/Y_ref − 1))`，`Y` = Rec.709 亮度，`Y_ref` = 可见像素亮度的 p90（所以 `base` 是「受光最亮那档叶面」的颜色）。
   - **`CONTRAST = 0.6`** 是有意压缩明暗：源图是深绿叶，亮度比低到 0.55；原样乘到亮粉上（1.0）最暗处变成发闷的紫褐色（Y=93），对樱花叶偏脏；0.6 保留叶脉图案又不发闷（最暗 Y=123）；0.4 几乎变平。可按观感调这一个常量。
   - 基色是**艺术取色**（`.schem` 只存方块名，不含颜色），见下表。`giant_oak_log` / `giant_oak_leaves` **复用既有 tile**（`log_big_oak` / `leaves`），不烘焙。
5. **粉叶预烘焙备用**（用户要求，**已完成**）：备用件 sha256 `8847b71734c7b3baf83412e80fdb3f66142c6c09f4b5a66c11b683e4d7710f51`（999 B），已 `cmp` 确认与终态 `assets/textures/procedural/giant_cherry_leaves.png` **逐字节相同**并删除 staging 目录。它的意义是「烘焙确定性已实证」——若将来改 `CONTRAST` / `HOLE_ALPHA` 等参数，重跑 `npm run gianttextures` 后应再次 `cmp`，不等即说明改动改变了观感（此时要重新看过预览图）。

   ⚠️ 备用件为什么放在 `assets/giant-trees/staging/` 而不是直接进 `assets/textures/`：`build-atlas.mjs` 递归扫描整个 `assets/textures`，`atlas.spec` 断言「atlas tile 数 ≡ 目录 PNG 数」，提前放进去会在没重跑 `npm run atlas` 前把门禁变红。

---

- [ ] **Step 1: 补全烘焙脚本的贴图表**

烘焙脚本 `tools/bake-giant-textures.mjs` 的全部内容是：

```javascript
// tools/bake-giant-textures.mjs — 巨树景观贴图离线烘焙（docs/superpowers/plans/2026-10-23-giant-trees.md Task 2）
//
// 做法 = 「沿用现有镂空树叶的图案，只换色」：
//   - 源图 `assets/textures/leaves.png`（16×16，alpha 孔洞图案：59 个不透明 / 13 个全透明 / 其余半透明）。
//   - **alpha 通道逐字节保留**（镂空孔洞形状不变）；RGB 全部重算，**含 alpha=0 的像素**：
//     巨树叶走 opaque 通道（材质无 alphaTest，alpha 被忽略 → 孔洞处直接显示该像素的 RGB），
//     若把透明像素的 RGB 留成原来的绿色，粉叶上会渗出绿点；留成黑色则会出黑点。
//   - 重着色 = 亮度比乘法：out = base × k，k = max(MIN_K, 1 + CONTRAST × (Y_pixel / Y_ref − 1))，
//     三通道同乘一个标量，色相不变，保留源图的明暗斑驳；Y 取 Rec.709 在 sRGB 数值域上的值。
//     Y_ref = 可见像素（alpha ≥ HOLE_ALPHA）亮度的 p90，所以 `base` 是「受光最亮那档叶面」的颜色，
//     更亮的高光会在 R 通道饱和（偏淡粉）、更暗的变深 —— 整张的均值会比 base 略暗，
//     这是设计（烘焙时会打印实测均值）。
//   - CONTRAST < 1 是**有意压缩明暗**：源图是深绿叶，亮度比 Y/Y_ref 低到 0.55；
//     原样乘到亮粉上（CONTRAST=1）最暗处会变成发闷的紫褐色（Y=93），对樱花叶偏脏；
//     0.6 保留叶脉图案又不发闷（最暗 Y=123），0.4 几乎变平（丢图案）。可按观感调这一个常量。
//
// 输出目录：
//   默认        assets/textures/procedural/   —— 会被 `npm run atlas` 打进世界 atlas（Task 2 的终态位置）
//   --staging   assets/giant-trees/staging/   —— 暂存「备用」：**不在** assets/textures 下，
//                                                atlas 构建与 atlas.spec 的 PNG 计数都看不到它
//   ⚠️ 不能把暂存产物直接放进 assets/textures：build-atlas 会递归扫描整个目录，atlas.spec 断言
//      「atlas tile 数 ≡ 目录 PNG 数」，没重跑 `npm run atlas` 就会红。
//
// 确定性：同输入同参数 → 逐字节相同的 PNG（pngjs 的编码是确定性的）。
//
// 用法：node tools/bake-giant-textures.mjs [--staging] [--only name1,name2]
//   当前 TEXTURES 表只有 giant_cherry_leaves 一行（先烘焙备用）；Task 2 补全其余行后再跑全量，
//   并用 `cmp` 确认暂存的粉叶与终态产物逐字节相同。
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const TEX_DIR = path.join(ROOT, 'assets', 'textures');
const OUT_FINAL = path.join(TEX_DIR, 'procedural');
const OUT_STAGING = path.join(ROOT, 'assets', 'giant-trees', 'staging');

/**
 * cutout 材质的 alphaTest 阈值（materials.js：`alphaTest: 0.3`）。
 * alpha < 0.3×255 = 76.5 的像素在 cutout 通道会被丢弃 = 「镂空孔洞」。
 * 这里只用来统计与定义「可见像素」，不改任何像素。
 */
const HOLE_ALPHA = 77;

/** 明暗对比度增益（见头部说明）与亮度比下限（防止最暗像素过黑） */
const CONTRAST = 0.6;
const MIN_K = 0.45;

/**
 * 烘焙表。`src` 相对 assets/textures；`base` = 受光最亮那档叶面的目标 RGB。
 * 粉叶基色取 plan Task 2 的 (255,140,195)（樱粉）。
 */
export const TEXTURES = Object.freeze([
  { name: 'giant_birch_leaves', src: 'leaves.png', base: [160, 235, 150] },   // 白桦：亮黄绿
  { name: 'giant_spruce_leaves', src: 'leaves.png', base: [35, 95, 60] },     // 雪松：深蓝绿
  { name: 'giant_cherry_leaves', src: 'leaves.png', base: [255, 140, 195] },  // 樱花：樱粉
  { name: 'giant_palm_leaves', src: 'leaves.png', base: [45, 150, 55] },      // 椰子：亮绿
  { name: 'giant_banyan_leaves', src: 'leaves.png', base: [85, 185, 75] },    // 榕树：中绿
  { name: 'giant_mangrove_log', src: 'log_big_oak.png', base: [135, 65, 65] }, // 红树干：沿用 bark 明暗结构
]);

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** 重着色：保留 alpha，RGB = base × (Y / Y_ref)。返回新 PNG 与统计量。 */
export function recolor(src, base) {
  const n = src.width * src.height;
  const ys = new Float64Array(n);
  const visibleYs = [];
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    ys[i] = luma(src.data[o], src.data[o + 1], src.data[o + 2]);
    if (src.data[o + 3] >= HOLE_ALPHA) visibleYs.push(ys[i]);
  }
  visibleYs.sort((a, b) => a - b);
  // p90（最近秩法，确定性）：visibleYs 至少有几十个像素，不会越界
  const yRef = visibleYs[Math.min(visibleYs.length - 1, Math.floor(visibleYs.length * 0.9))];

  const out = new PNG({ width: src.width, height: src.height });
  let holes = 0, sr = 0, sg = 0, sb = 0, nv = 0, clippedR = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const k = Math.max(MIN_K, 1 + CONTRAST * (ys[i] / yRef - 1));
    for (let c = 0; c < 3; c++) {
      const v = Math.round(base[c] * k);
      if (c === 0 && v > 255) clippedR++;
      out.data[o + c] = Math.max(0, Math.min(255, v));
    }
    out.data[o + 3] = src.data[o + 3]; // alpha 逐字节保留
    if (src.data[o + 3] < HOLE_ALPHA) holes++;
    else { sr += out.data[o]; sg += out.data[o + 1]; sb += out.data[o + 2]; nv++; }
  }
  return {
    png: out,
    stats: { yRef, holes, visible: nv, clippedR, meanVisible: [sr / nv, sg / nv, sb / nv] },
  };
}

function main() {
  const args = process.argv.slice(2);
  const staging = args.includes('--staging');
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? new Set(args[onlyIdx + 1].split(',')) : null;
  const outDir = staging ? OUT_STAGING : OUT_FINAL;
  fs.mkdirSync(outDir, { recursive: true });

  for (const t of TEXTURES) {
    if (only && !only.has(t.name)) continue;
    const srcPath = path.join(TEX_DIR, t.src);
    const src = PNG.sync.read(fs.readFileSync(srcPath));
    const { png, stats } = recolor(src, t.base);

    // 自检：alpha 通道必须与源图逐字节相同（孔洞形状不变）
    for (let i = 3; i < src.data.length; i += 4) {
      if (png.data[i] !== src.data[i]) throw new Error(`${t.name}: alpha 与源图不一致（像素 ${(i - 3) / 4}）`);
    }
    // 自检：不得出现近黑像素（opaque 通道下孔洞处会直接露出 RGB → 黑点）
    for (let i = 0; i < png.data.length; i += 4) {
      if (luma(png.data[i], png.data[i + 1], png.data[i + 2]) < 40) {
        throw new Error(`${t.name}: 像素 ${i / 4} 亮度 < 40（opaque 下会成黑点）`);
      }
    }
    const dst = path.join(outDir, `${t.name}.png`);
    fs.writeFileSync(dst, PNG.sync.write(png));
    const m = stats.meanVisible.map((x) => x.toFixed(0)).join(',');
    console.log(`${t.name}: ${path.relative(ROOT, dst)}  ${src.width}×${src.height}  ` +
      `源=${t.src} base=(${t.base.join(',')})  Y_ref=${stats.yRef.toFixed(1)}  ` +
      `镂空像素(alpha<${HOLE_ALPHA})=${stats.holes}/${src.width * src.height}  ` +
      `可见像素均值RGB=(${m})  R 通道饱和=${stats.clippedR}`);
  }
}

// 仅在直接运行时执行（被 import 做单测/门禁时不烘焙）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
```

在 `package.json` 的 `scripts` 里 `"gianttrees": ...` 之后加一行：

```json
    "gianttextures": "node tools/bake-giant-textures.mjs",
```

- [ ] **Step 2: 烘焙 6 张贴图，并用 `cmp` 验证粉叶备用产物**

Run: `npm run gianttextures`

Expected（6 行，确定性）：

```text
giant_birch_leaves: assets/textures/procedural/giant_birch_leaves.png  16×16  源=leaves.png base=(160,235,150)  Y_ref=99.8  镂空像素(alpha<77)=80/256  可见像素均值RGB=(148,218,139)  R 通道饱和=0
giant_spruce_leaves: assets/textures/procedural/giant_spruce_leaves.png  16×16  源=leaves.png base=(35,95,60)  Y_ref=99.8  镂空像素(alpha<77)=80/256  可见像素均值RGB=(32,88,56)  R 通道饱和=0
giant_cherry_leaves: assets/textures/procedural/giant_cherry_leaves.png  16×16  源=leaves.png base=(255,140,195)  Y_ref=99.8  镂空像素(alpha<77)=80/256  可见像素均值RGB=(236,130,181)  R 通道饱和=22
giant_palm_leaves: assets/textures/procedural/giant_palm_leaves.png  16×16  源=leaves.png base=(45,150,55)  Y_ref=99.8  镂空像素(alpha<77)=80/256  可见像素均值RGB=(42,139,51)  R 通道饱和=0
giant_banyan_leaves: assets/textures/procedural/giant_banyan_leaves.png  16×16  源=leaves.png base=(85,185,75)  Y_ref=99.8  镂空像素(alpha<77)=80/256  可见像素均值RGB=(79,171,69)  R 通道饱和=0
giant_mangrove_log: assets/textures/procedural/giant_mangrove_log.png  16×16  源=log_big_oak.png base=(135,65,65)  Y_ref=80.7  镂空像素(alpha<77)=0/256  可见像素均值RGB=(126,61,61)  R 通道饱和=0
```

```bash
shasum -a 256 assets/textures/procedural/giant_*.png        # 应与下表一致；再跑一次 npm run gianttextures 后必须不变（确定性）
cmp assets/giant-trees/staging/giant_cherry_leaves.png assets/textures/procedural/giant_cherry_leaves.png && echo "粉叶备用产物 == 终态产物"
```

465fb9379cbffe99c184bef10b1f8f40d07e7de5ce40e4bf1cfad46e7418cf58     940 B  assets/textures/procedural/giant_banyan_leaves.png
59ed5bd2d22c17048b96503bac1b2b77e19d096b767834d92bb4614fe4a9a93b     992 B  assets/textures/procedural/giant_birch_leaves.png
8847b71734c7b3baf83412e80fdb3f66142c6c09f4b5a66c11b683e4d7710f51     999 B  assets/textures/procedural/giant_cherry_leaves.png
8248ac38707f6f0f4e50a10ad6d8a587faa0af82beb0bb101138bdc2eada6202     413 B  assets/textures/procedural/giant_mangrove_log.png
33bda7463531ed6d6b5e33aa8b4b77ac3e0d33ebc2584b8e123e3f136a270660     897 B  assets/textures/procedural/giant_palm_leaves.png
46d9c9d490130126d628b46d2309527d88f47fcc17d74142107f2a7068eab51b     874 B  assets/textures/procedural/giant_spruce_leaves.png

Expected：`cmp` 无输出（逐字节相同）并打印「粉叶备用产物 == 终态产物」。确认后删除暂存目录（若沙箱禁止 `rm`，用 `mv assets/giant-trees/staging /tmp/`）：

```bash
rm -r assets/giant-trees/staging
```

- [ ] **Step 3: 方块声明、贴图映射、背包隐藏**

`src/voxel/blocks-data.js`（尾部追加；注释里的 ⚠️ 是给后来人的，别删）：

```diff
diff --git a/src/voxel/blocks-data.js b/src/voxel/blocks-data.js
index 405bcba..42e787c 100644
--- a/src/voxel/blocks-data.js
+++ b/src/voxel/blocks-data.js
@@ -175,4 +175,20 @@ export const BLOCKS = [
   // M2-7 空岛岛体（mc-lite Island.js：sky_stone 岛身 + sky_grass 顶层）
   {"name":"sky_stone","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
   {"name":"sky_grass","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
+  // ---- 巨树景观（Giant Trees Epic）----
+  // 全部 geometry:"box"、orientationModes:0 —— 无新几何模板（mesher 零改动）。
+  // ⚠️ 树叶必须 cullMode:"opaque"（叶-叶共享面互剔，mesher.js 判据 opaqueTable[neighbor]===1：
+  //    实测单棵从 cutout 通道的 ~10k 顶点降到 opaque 通道的 ~5k）；走 cutout 会让密林视域 cutout
+  //    通道占用翻数倍。⚠️ 树叶**投影**（不写 shadowCast:false）：与同为 opaque 叶的 sky_leaves、
+  //    以及既有 leaves 同口径；`[阴影投射]` 门禁的 13 项清单也要求 leaves 仍须投影。
+  //    不要写 opaque:false（会让叶-叶共享面不再互剔）。
+  // ⚠️ palette[0] 恒为树干（tools/giant-trees-fingerprint.mjs 的 FAMILY_PALETTES）。
+  {"name":"giant_oak_log","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
+  {"name":"giant_mangrove_log","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
+  {"name":"giant_oak_leaves","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
+  {"name":"giant_birch_leaves","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
+  {"name":"giant_spruce_leaves","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
+  {"name":"giant_cherry_leaves","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
+  {"name":"giant_palm_leaves","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
+  {"name":"giant_banyan_leaves","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
 ];
```

`src/voxel/faces-data.js`：

```diff
diff --git a/src/voxel/faces-data.js b/src/voxel/faces-data.js
index bd011a6..ef9f2b0 100644
--- a/src/voxel/faces-data.js
+++ b/src/voxel/faces-data.js
@@ -144,6 +144,17 @@ export const FACES_DATA = {
   // ---- 床（half_block 模板；UV 变换见 mesher BED_UV；null 面不渲染）----
   bed_head: ['bed/Bed_(top_side_texture)_JE2_BE2', 'bed/Bed_(top_side_texture)_JE2_BE2', 'bed/Bed_(top_texture)_JE1_BE1', null, 'bed/Bed_(back_texture)_JE2_BE2', null],
   bed_tail: ['bed/Bed_(bottom_side_texture)_JE2_BE2', 'bed/Bed_(bottom_side_texture)_JE2_BE2', 'bed/Bed_(bottom_texture)_JE1_BE1', null, null, 'bed/Bed_(front_texture)_JE2_BE2'],
+  // ---- 巨树景观（Giant Trees Epic）----
+  // giant_oak_log / giant_oak_leaves 复用既有 tile（log_big_oak 与 leaves）；其余 6 张由
+  // tools/bake-giant-textures.mjs 烘焙到 assets/textures/procedural/。
+  giant_oak_log: ['log_big_oak', 'log_big_oak', 'log_big_oak_top', 'log_big_oak_top', 'log_big_oak', 'log_big_oak'],
+  giant_mangrove_log: 'procedural/giant_mangrove_log',
+  giant_oak_leaves: 'leaves',
+  giant_birch_leaves: 'procedural/giant_birch_leaves',
+  giant_spruce_leaves: 'procedural/giant_spruce_leaves',
+  giant_cherry_leaves: 'procedural/giant_cherry_leaves',
+  giant_palm_leaves: 'procedural/giant_palm_leaves',
+  giant_banyan_leaves: 'procedural/giant_banyan_leaves',
 };
 
 /**
```

`src/player/inventory.js`：

```diff
diff --git a/src/player/inventory.js b/src/player/inventory.js
index 48e4aa4..4fac70c 100644
--- a/src/player/inventory.js
+++ b/src/player/inventory.js
@@ -54,6 +54,10 @@ export const HIDDEN_FROM_INVENTORY = [
   // ⚠️ **与 `indestructible` 登记必须成对做**：配上不可破坏门控后，若留在背包会产出撕裂状态 ——
   // 玩家放得出来，但挖不掉、TNT 也炸不掉（只能靠「关闭创造台」批量删）。
   'playground_block', 'playground_center_block',
+  // 巨树景观：生成期地形装饰（8 个 giant_*）。**可放置但不进背包**（与 chimney 同类）——玩家放出来的
+  // 只会是「一块没有下文的树干/树叶」；挖掉倒是可以。不要塞进 NON_PLACEABLE_ITEMS（语义互斥）。
+  'giant_oak_log', 'giant_mangrove_log', 'giant_oak_leaves', 'giant_birch_leaves',
+  'giant_spruce_leaves', 'giant_cherry_leaves', 'giant_palm_leaves', 'giant_banyan_leaves',
 ];
 
 /**
```

- [ ] **Step 4: 重建世界 atlas**

Run: `npm run atlas`

Expected：

```text
atlas: 153 tiles → assets/atlas.png (2048x2048)
```

```bash
git status --short assets/icons-atlas.png assets/icons.json     # 必须无输出：图标产物逐字节不变
```

> 新增 `procedural/` 下的 tile 会让 shelf 装箱重排：**实测既有 147 个 tile 里 32 个坐标变化**（`atlas.png` 229,733 → 234,475 B，`atlas.json` 26,031 → 27,180 B）。这是预期的；`[图标过期]` 指纹不受影响（8 个新方块全部隐藏，不在背包集合，**不需要**重跑 `npm run icons`）。

- [ ] **Step 5: 同步 3 个既有单测文件里的 4 条硬编码断言**

这些是「冻结的计数/清单断言」，随方块数变化**有意同步**（不是放宽断言）。算式注释一起改，否则注释与断言漂移：

`src/tests/test-block-registry.js`（126 → 134）：

```diff
diff --git a/src/tests/test-block-registry.js b/src/tests/test-block-registry.js
index 2507565..07261df 100644
--- a/src/tests/test-block-registry.js
+++ b/src/tests/test-block-registry.js
@@ -14,13 +14,13 @@ test('BlockRegistry: air 恒为 ID 0', () => {
   assertEqual(reg.idOf('air'), 0);
 });
 
-test('BlockRegistry: 126 方块全部注册且 ID 唯一', () => {
+test('BlockRegistry: 134 方块全部注册且 ID 唯一', () => {
   const reg = createRegistry();
   for (const def of BLOCKS) reg.register(def.name, def);
-  assertEqual(reg.count, 126);
+  assertEqual(reg.count, 134);  // 126 + 巨树景观 8 个 giant_*
   const ids = new Set();
   for (const def of BLOCKS) ids.add(reg.idOf(def.name));
-  assertEqual(ids.size, 126);
+  assertEqual(ids.size, 134);
 });
 
 test('BlockRegistry: sky_stone/sky_grass 注册且 solid+opaque（M2-7 空岛）', () => {
```

`src/tests/test-inventory.js`（`registry.all()` 126 → 134；`HIDDEN_FROM_INVENTORY` 清单 6 → 14 项；`buildItemNames` 算式 `126−4−6` → `134−4−14`，结果仍是 116）：

```diff
diff --git a/src/tests/test-inventory.js b/src/tests/test-inventory.js
index db9bd50..97e6149 100644
--- a/src/tests/test-inventory.js
+++ b/src/tests/test-inventory.js
@@ -131,10 +131,10 @@ test('DEFAULT_INVENTORY_COUNT = 1500（对齐 mc-lite GameConfig）', () => {
 
 // --- BlockRegistry.all()：遍历接口（§4.1 v1.16 补记，冷路径专用） ---
 
-test('registry.all(): 按注册顺序返回 126 条 {id,name}，与 idOf/nameOf 一致', () => {
+test('registry.all(): 按注册顺序返回 134 条 {id,name}，与 idOf/nameOf 一致', () => {
   const reg = makeRegistry();
   const all = reg.all();
-  assertEqual(all.length, 126);
+  assertEqual(all.length, 134);  // 126 + 巨树景观 8 个 giant_*
   assertEqual(all[0].name, 'air', '注册序首项 = air（ID 0）');
   assertEqual(all[0].id, 0);
   for (const e of all) {
@@ -158,26 +158,30 @@ test('NON_PLACEABLE_ITEMS = 4 个功能性方块（mc-lite 背包同样排除）
     ['air', 'collider', 'calcite', 'realistic_trunk_collider']);
 });
 
-test('HIDDEN_FROM_INVENTORY = chimney + 三个床方块 + 创造台两项（可放置但不进背包）', () => {
+test('HIDDEN_FROM_INVENTORY = chimney + 三个床方块 + 创造台两项 + 巨树 8 项（可放置但不进背包）', () => {
   // 这些方块都可放置（能放能挖），故**不能**归入 NON_PLACEABLE_ITEMS
   // （该集合语义是「非玩家可放置的功能性方块」）。它们属独立概念：可放置、但不进背包。
   // bed_head/bed_tail/bed_alias_block：床渲染存在未修复的镂空透视问题，靠「不入背包 →
   // 玩家选不到 → 实际不会被放置」规避（详见 mesher.js 的 TODO），本质仍可放可挖。
   // playground 两项（M9）：平台方块登记 indestructible，留在背包会产出「放得出来但挖不掉」
   // 的撕裂状态（与登记必须成对做，见 inventory.js 的注释）。
+  // 巨树 8 项（giant_*）：生成期地形装饰，放出来只是「没有下文的一块树干/树叶」。
   assertDeepEqual(HIDDEN_FROM_INVENTORY, ['chimney', 'bed_head', 'bed_tail', 'bed_alias_block',
-    'playground_block', 'playground_center_block']);
+    'playground_block', 'playground_center_block',
+    'giant_oak_log', 'giant_mangrove_log', 'giant_oak_leaves', 'giant_birch_leaves',
+    'giant_spruce_leaves', 'giant_cherry_leaves', 'giant_palm_leaves', 'giant_banyan_leaves']);
   // 与 NON_PLACEABLE_ITEMS 不得重叠（语义互斥，避免两处排除混淆）
   for (const n of HIDDEN_FROM_INVENTORY) {
     assertFalse(NON_PLACEABLE_ITEMS.includes(n), `${n} 不应同时属于 NON_PLACEABLE_ITEMS`);
   }
 });
 
-test('buildItemNames: 116 项（126 - 4 功能性 - 6 可放置但不进背包）', () => {
+test('buildItemNames: 116 项（134 - 4 功能性 - 14 可放置但不进背包）', () => {
   const names = buildItemNames(makeRegistry());
   // ⚠️ M9：HIDDEN_FROM_INVENTORY 4 → 6（追加创造台两项）→ 物品集合 118 → 116。
+  // 巨树景观：registry 126 → 134、HIDDEN 6 → 14（8 个 giant_* 全部不进背包）→ 仍是 116。
   // 这是硬编码计数的冻结断言，改数字须连算式注释一起改（否则注释与断言漂移）。
-  assertEqual(names.length, 116, '126 - 4 - 6 = 116');
+  assertEqual(names.length, 116, '134 - 4 - 14 = 116');
   assertEqual(new Set(names).size, 116, '无重复');
   for (const bad of NON_PLACEABLE_ITEMS) {
     assertFalse(names.includes(bad), `${bad} 不应在物品集合内`);
```

`src/tests/test-orientation.js`（不参与旋转的方块 86 → 94）：

```diff
diff --git a/src/tests/test-orientation.js b/src/tests/test-orientation.js
index dece9e5..e36cb5e 100644
--- a/src/tests/test-orientation.js
+++ b/src/tests/test-orientation.js
@@ -42,14 +42,14 @@ test('orientation: nextOrientation 非法输入回落 EAST（mc-lite `(current||
 
 // --- 门控集合：复用 orientationModesTable，不新增字段 ---
 
-test('orientation: 门控集合 = mc-heavy 40 项启用 / 86 项不参与旋转', () => {
+test('orientation: 门控集合 = mc-heavy 40 项启用 / 94 项不参与旋转', () => {
   const reg = makeRegistry();
   const all = reg.all();
-  assertEqual(all.length, 126);
+  assertEqual(all.length, 134);
   const enabled = all.filter((b) => reg.orientationModesTable[b.id] > 0);
   const disabled = all.filter((b) => reg.orientationModesTable[b.id] === 0);
   assertEqual(enabled.length, 40, '启用朝向的方块数（与 mc-lite orientationEnabled=true 集合一致）');
-  assertEqual(disabled.length, 86, '恒 EAST 的方块数（124 方块的 mc-lite 是 84，此处多 sky_stone/sky_grass）');
+  assertEqual(disabled.length, 94, '恒 EAST 的方块数（124 方块的 mc-lite 是 84，此处多 sky_stone/sky_grass 与巨树 8 个 giant_*）');
   // 抽查：chest 启用、stone 不参与旋转、M2-7 新增的两个 sky 方块不参与旋转
   assertTrue(reg.orientationModesTable[reg.idOf('chest')] > 0, 'chest 启用朝向');
   assertEqual(reg.orientationModesTable[reg.idOf('stone')], 0, 'stone 不参与旋转');
```

- [ ] **Step 6: 验证**

Run: `npm run check`

Expected（关键行）：

```text
[check:arch] 扫描 103 个源文件
[check:arch] ✓ 架构红线全部守住
  ✓ [引用完整性] 141 个被引用 tile 全部存在于 atlas（atlas 共 153 tile）
  ✓ [物品集合] 116 项 = registry 134 − 排除 18（改排除集合自动跟上）
  ✓ [阴影投射] 13 项不投影（对齐 mc-lite isShadowEnabled:false 口径）…
  ✓ [图标过期] 116 项指纹全部匹配（图标与几何/贴图同步）
  ✓ [测试注册] 46 个测试文件全部已注册
[check:data] ✓ 数据契约全部一致
✖ 15 problems (0 errors, 15 warnings)
```

Run（先起服务：`node server-script/start-server.js &`，用完 kill）: `node tests/tmp-unit.mjs`
Expected: `harness: passed=779 failed=0 total=779`（本 Epic 的 31 条新单测还没加）。

Run: `npx playwright test tests/atlas.spec.mjs`
Expected: `3 passed`。

- [ ] **Step 7: 负向验证 —— v1.0 的 `shadowCast:false` 写法必须被既有门禁拦下**

临时给 `giant_oak_leaves` 的声明加 `,"shadowCast":false`，跑 `node tools/check-data.mjs`：

```
[check:data] ✗ 1 项契约违规：
  [阴影投射] 多标了 shadowCast:false（不在 mc-lite 排除清单，会导致地形不投影）：giant_oak_leaves
```

复原后重跑应全绿。（这条门禁是既有的 `[阴影投射]`，不是本 Epic 新增——它正是「巨树叶须投影」的第一道防线；Task 7 的 `[巨树]` 再加第二道。）

- [ ] **Step 8: 提交**（仅在用户明确要求提交时）

```bash
git add tools/bake-giant-textures.mjs package.json assets/textures/procedural/giant_*.png assets/atlas.png assets/atlas.json \
        src/voxel/blocks-data.js src/voxel/faces-data.js src/player/inventory.js \
        src/tests/test-block-registry.js src/tests/test-inventory.js src/tests/test-orientation.js
git commit -m "feat(giant-trees): 8 个巨树方块与 6 张贴图（树叶 opaque 且投影，不进背包）"
```

---

## Task 3: 容量上调（设计文档先行）

**Files:**
- Modify: `docs/phase-1-engine-design.md`（版本头 + v1.68 修订说明 + §4.10 + §5）——**先于代码**
- Modify: `src/render/render-world.js`（`CAPACITY.opaque.active` 1200 → 1800 + 注释）
- Modify: `tests/m3-fullscene.spec.mjs`（`gpuVertexBytes` 断言 150 → 200 MiB）

**为什么这是一个独立任务**：`CAPACITY` 是「冻结值」，本仓规则「设计先于代码」。这是用户裁决 (a)（2026-10-23）：opaque 通道 ×1.5，§4.10 的 150MiB 冻结预算有意上调。把它排在树的任何代码之前，是为了让后续每个任务的真实页面验证都在最终容量下进行。

**依据**（spec §2.5，真实页面 reserved 口径）：

| | 相对 2.85M（折算） | 相对 4.275M（实测） |
|---|---|---|
| (-20,10) 视域 opaque | 105.3% | 70.2% |
| 森林冲刺 opaque 峰值 | 123.2% | 82.1% |

2.85M 下必然触发 `_ensureCapacity` 的 ×1.5 整批扩容（重建 + 拷贝 = 帧卡顿）；4.275M 下零 opaque 扩容。三通道静态顶点缓冲 `(4.275M + 2.20M + 0.125M) × 30B = 198,000,000 B = 188.83 MiB`（原 148.06 MiB），`memoryStats().gpuVertexBytes` 实测同值。

> `docs/m3-baseline.json` 里的 `maxVertexCount: 2850000` 是**冻结基线的历史快照**，不改。`bench --check` 的 `STRUCTURAL` 判定分支恒为 false（`gpuVertexBytes` / `drawCalls` 永不报回退，注释写的 2% 不生效，已另立项）——**修它之前 GPU 预算只由 `m3-fullscene` 与 Task 8 的 `giant-tree-budget` 守**。

---

- [ ] **Step 1: 设计文档先行（`docs/phase-1-engine-design.md`，4 处）**

**(a) 版本头**（第 3 行）：把 `版本：v1.65 ｜ 日期：2026-10-21` 改为 `版本：v1.68 ｜ 日期：<实施当天>`（行内其余文字不动）。

> v1.66 / v1.67 是 roadmap 独立改动表里的条目（武器命中特效），按本仓规则不进设计文档修订说明、不 bump 设计文档版本号；本次改的是架构口径（§4.10 预算 + 新模块），故文档版本从 v1.65 直接到 v1.68，与 roadmap 的行号对齐。

**(b) 修订说明**：在版本头下方的空引用行 `>` 之后、`> v1.65 修订说明：…` 之前，插入下面整块（末尾保留一个空引用行 `>`）：

```markdown
> v1.68 修订说明：**巨树景观 Epic —— opaque 通道容量 ×1.5，§4.10 的 150MiB 冻结预算有意上调到 188.83 MiB**
> （用户裁决 2026-10-23；规格 `docs/superpowers/specs/2026-10-23-giant-trees-design.md` v1.1 §0.2 / DR-10 / DR-17）。
> 引入 28 个原版景观树变体（森林 / 海边 / 草地沙漠交界三条落位路径；树叶 `opaque` 且投影）。opaque 叶使 opaque 通道
> 在密林视域的 reserved 占用抬高：终版参数在原容量 2.85M 下折算 (-20,10) 视域 105%、森林冲刺 123%（→ 必然 ×1.5 扩容），
> 抬到 4.275M 后最高 82.1%（零 opaque 扩容）。
> ⚠️ **口径修正**：容量判据是 **reserved**（= 1.25 × 已用顶点，`render-world.js:204`）相对**初始**容量常量，不是已用占比
> （Node 侧「注入树 + 真 mesher」得到的已用占比比真实页面系统性低 1.20~1.24 倍）；HEAD 自己在密林视域就越线
> （cutout 128.1%、森林冲刺 cutout 145.4% / transparent 140.8%，会触发 ×1.5 扩容），所以验收口径写成「真实页面 reserved：
> opaque ≤ 90% 且零扩容；cutout / transparent 相对 HEAD 不恶化」，而不是「任何视域都不扩容」。
> 变更点：`CAPACITY.opaque.active` 1200→1800（maxVerts 2.85M→**4.275M**）；三通道静态顶点缓冲
> `(4.275M+2.20M+0.125M)×30B = 198,000,000 B = 188.83 MiB`（原 148.06 MiB；`memoryStats().gpuVertexBytes` 实测同值）；
> `tests/m3-fullscene.spec.mjs` 的 `gpuVertexBytes` 上限 150→200 MiB（188.83 + 一次 transparent 扩容的兜底余量）。
> cutout / transparent 容量不变（巨树只把旧森林树的 cutout 叶替换成 opaque 叶，cutout 只降不升）。
> 新增模块（Worker 同构）：`src/gen/structures/giant-trees.js`（region 层「全局对齐网格 + 内缩抖动」候选 +
> column 层合并邻域候选 / 排除 / 光栅化 / 地基 / 覆盖窗口）；离线烘焙 `npm run gianttrees` / `npm run gianttextures`；
> 新门禁 `check:data` 的 `[巨树]`。已有存档里的森林会长出巨树（用户接受，不 bump DB 版本）。
> `bench --check` 的 `STRUCTURAL` 分支恒为 false（GPU 预算不会被它拦下），故由 `m3-fullscene` 与 `giant-tree-budget` 守。
>
```

**(c) §4.10 内存预算**：在该节最后一条 `- edits 稀疏层常驻内存…` 之后追加一条：

```markdown
- **（v1.68）静态分配口径与验收口径**：三通道 `BatchedMesh` 顶点缓冲是**静态预分配**（`CAPACITY`，见 `render-world.js`
  注释），与上表「活跃 section」口径不同。巨树景观后静态分配 **188.83 MiB**（opaque 4.275M + cutout 2.20M +
  transparent 0.125M，×30B；原 148.06 MiB），实测活跃 `gpuActiveBytes` ≈ 127 MiB；M3-1 的「1.5× 余量红线」断言相应
  放宽到 200 MiB。**扩容是黏性的离散 ×1.5 跳增**（`_ensureCapacity`），验收一律读 reserved 相对**初始**容量，
  不读当前 `maxVertexCount`。
```

**(d) §5 目录结构**：在「**第二/三阶段新增的顶层产物**」清单里，`**v1.58 新增测试产物**…（Tier 4 像素实测）。` 之后、`与 mc-lite 的关键差异：` 之前，追加两条：

```markdown
- **巨树景观新增 `assets/giant-trees/`**：`src/40AssortedTreesPack.schem`（烘焙输入，入库，与 `assets/sky/night-src/` 同口径：
  **不是渲染资源**）+ 烘焙产物 `trees.json` / `trees.meta.json`（28 变体 + 尺寸与输入指纹）；`tools/bake-giant-trees.mjs`
  （`npm run gianttrees`）+ `tools/giant-trees-fingerprint.mjs`（参数与指纹单一权威，烘焙脚本与 `check:data` 共用）+
  `tools/bake-giant-textures.mjs`（`npm run gianttextures`，6 张贴图 → `assets/textures/procedural/giant_*.png`，
  沿用现有镂空叶图案只换色）；
- **巨树景观新增 `src/gen/structures/giant-trees.js`**（Worker 同构，无 three）：region 层候选 + column 层光栅化；
  测试产物 `src/tests/test-giant-trees{,-column,-gen}.js`（浏览器内单测 31 条）+ `tests/giant-trees.spec.mjs` /
  `tests/giant-tree-budget.spec.mjs`（Tier 4）。
```

- [ ] **Step 2: `render-world.js` 的 `CAPACITY`**

只改 opaque 一行与其上方的注释（cutout / transparent 与它们的注释不动）：

```diff
diff --git a/src/render/render-world.js b/src/render/render-world.js
index f272fee..86910b4 100644
--- a/src/render/render-world.js
+++ b/src/render/render-world.js
@@ -20,8 +20,14 @@ const CHANNELS = ['opaque', 'cutout', 'transparent'];
 // GPU 顶点缓冲 170MB，撞破 §4.10 的 150MB 冻结预算。故 active 450→550（maxVerts→2.20M），
 // 三通道合计 (2.85M+2.20M+0.125M)×30B = 148MB < 150MB。cutoutSlots 实测 498，active 550 覆盖。
 // 旧值 opaque 4M 过度分配、cutout 562K 偏小导致运行时 3× 扩容，M3-1 一并修正。
+//
+// ⚠️ 巨树景观（用户裁决 2026-10-23，接受 opaque ×1.5）：opaque active 1200→1800（maxVerts 2.85M→4.275M）。
+// 验收口径是 reserved（= 1.25 × 已用顶点）相对**初始**容量：终版参数实测 reserved 峰值 82.1%（森林冲刺，相对 4.275M，
+// 零 opaque 扩容）；折算到 2.85M 为 (-20,10) 视域 105%、冲刺 123% → 必然 ×1.5 扩容，故抬容量而非压树量。
+// 三通道合计 (4.275M+2.20M+0.125M)×30B = 188.83 MiB（§4.10 的 150MiB 冻结预算由此有意上调，见设计文档 §4.10）。
+// cutout / transparent 不变：HEAD 在密林视域本就越线（cutout 128%），巨树只把旧森林树（cutout）替换成 opaque 叶，cutout 只降不升。
 const CAPACITY = {
-  opaque:      { active: 1200, avgVerts: 1900 },
+  opaque:      { active: 1800, avgVerts: 1900 },  // 巨树景观 1200→1800（用户裁决：opaque ×1.5，2.85M→4.275M）
   cutout:      { active: 550, avgVerts: 3200 },  // 撒布补齐后 450→550（吸收 cutout 峰值，守 150MB）
   transparent: { active: 100, avgVerts: 1000 },
 };
```

- [ ] **Step 3: `m3-fullscene` 的内存断言**

```diff
diff --git a/tests/m3-fullscene.spec.mjs b/tests/m3-fullscene.spec.mjs
index f325c5c..34e6579 100644
--- a/tests/m3-fullscene.spec.mjs
+++ b/tests/m3-fullscene.spec.mjs
@@ -89,10 +89,13 @@ test('M3-1：全量场景稳态帧率 + 队列不积压 + 内存预算', async (
   expect(perf.frameMs.p95).toBeLessThan(process.env.CI ? 50 : 16.7);
 
   // 内存预算（§4.10）：体素 CPU ~37MB、GPU 顶点缓冲 ~100MB 级（1.5× 余量红线）
+  // ⚠️ 巨树景观（用户裁决 2026-10-23，接受 opaque ×1.5）：CAPACITY.opaque 2.85M→4.275M，
+  //    三通道静态 gpuVertexBytes 148.06MiB → 188.83MiB（= (4.275M+2.2M+0.125M)×30B，实测 198,000,000B）。
+  //    上限 150→200MiB = 188.83MiB + ~11MiB 的扩容兜底余量（一次 transparent 扩容 ≈ +1.8MiB）。
   const mem = await page.evaluate(() => window.__MC_GAME__.memoryStats());
   console.log('M3-1 MEM:', JSON.stringify(mem));
   expect(mem.voxelBytes).toBeLessThan(45 * 1024 * 1024);   // 289×128KB≈37MB + 滞回带余量
-  expect(mem.gpuVertexBytes).toBeLessThan(150 * 1024 * 1024); // ~100MB 级 + 扩容兜底余量
+  expect(mem.gpuVertexBytes).toBeLessThan(200 * 1024 * 1024); // 巨树景观后 188.83MiB 静态 + 扩容兜底余量
   if (!process.env.CI) {
     // jsHeapSizeLimit 仅 Chromium 暴露；CI 上 SwiftShader 内存形态不同，只在本机参考
     expect(mem.jsHeapUsedBytes ?? 0).toBeLessThan(1024 * 1024 * 1024);
```

- [ ] **Step 4: 验证**

Run: `npx playwright test tests/m3-fullscene.spec.mjs tests/render-world.spec.mjs tests/m3-budget.spec.mjs`

Expected（关键行；此时世界里还没有树，静态分配与内容无关）：

```text
M3-1 MEM: {"columns":323,"sections":1971,"voxelBytes":42336256,"gpuVertexBytes":198000000,"gpuActiveBytes":133144308,"jsHeapLimitBytes":4395630592}
  4 passed (45.8s)
```

**负向验证**：临时把 `m3-fullscene.spec.mjs` 的上限改回 `150 * 1024 * 1024` 再跑，必须红：

```text
    Expected: < 157286400
    Received:   198000000
    > 95 |   expect(mem.gpuVertexBytes).toBeLessThan(150 * 1024 * 1024); // ~100MB 级 + 扩容兜底余量
  1 failed
```

复原后重跑应绿。（这证明 200 MiB 的新上限不是摆设，也证明 `CAPACITY` 的改动确实生效。）

- [ ] **Step 5: 提交**（仅在用户明确要求提交时）

```bash
git add docs/phase-1-engine-design.md src/render/render-world.js tests/m3-fullscene.spec.mjs
git commit -m "perf(render): opaque 通道容量 ×1.5（2.85M→4.275M），§4.10 预算有意上调到 188.83 MiB"
```

---

## Task 4: `giant-trees.js` 第一部分 —— 加载 / 几何 / region 层候选（TDD）

**Files:**
- Create: `src/tests/test-giant-trees.js`（15 条）
- Create: `src/gen/structures/giant-trees.js`（第一部分；Task 5 在同一文件里追加 column 层）
- Modify: `src/tests/index.html`（注册）

**Interfaces:**
- Consumes：`assets/giant-trees/trees.json`（Task 1）；`seededRandom` / `getBiome`（`gen/noise.js`）、`generateHeight`（`gen/terrain.js`）、`REGION_SIZE`（`gen/structures/region-config.js`）。
- Produces（第一部分导出）：`GIANT_FAMILY_ORDER`、`GIANT_STRIDE`(=5)、`GIANT_SUPPORT_MAX`(=10)、`isNearWater`、`isBiomeEdge`、`GIANT_TREE_PATHS`、`giantTreeRotation`、`computeGiantTreeCandidates`、`loadGiantTrees`、`getGiantTreesSync`、`rotateCell`、`rotatedFootprint`、`treeBox`。

**设计要点**（spec §3.3 / §3.4 / §3.7）：

1. **候选 = 全局对齐网格 + 内缩抖动**（取代 v1.0 的「逐点扫 region 160,000 格 + region 内贪心排序」）：cell 边长 `C = spacing + jitter`；cell `(i, j)` 至多出 1 个点，落在 cell 内 `[0, jitter)²` 的内缩方块里 ⇒ **相邻 cell 的点切比雪夫距离 ≥ spacing + 1 由构造保证**（不需要贪心、排序、跨 region 协调）。cell 按全局网格对齐（下标 = `floor(世界坐标 / C)`），一个 cell 横跨 region 边界时两侧各算一次、各自只保留落在本 region 内的点 ⇒ 不重复、不遗漏，跨 region 无缝。谓词（biome / 近水 / 交界）只对每格 ≤1 个点求值。实测候选发现 ≈1.1 ms/region（v1.0：14~20 ms）。
2. **`chance` 是真正的密度旋钮**（线性）。v1.0 的 `forestChance = 0.10` 在 spacing 16 下几乎无效（0.10 → 0.01 只少 40%）：候选密度远超间距饱和密度，贪心结果由间距决定。
3. **`spacing` 是最小树距，不是树宽**：A 森林树 AABB ≤ 12，spacing 14 → 互不相交；B/C 的樱花/榕树 AABB 达 17、spacing 8 → 冠幅互相重叠成片（设计意图「成片樱花 + 椰林」），树干不重叠。
4. **共享谓词导出**（`isNearWater` / `isBiomeEdge`，红线 1）：候选层与测试用同一份函数；v1.0 的测试自己另写了一份判据且采样方式与实现不同。
5. **候选里存 `variantHash`（16 位原始 hash），不存变体下标**：候选层是纯函数、拿不到变体数（`loadGiantTrees` 是异步 fetch）；光栅化层再 `% 该族变体数`。
6. **旋转 `giantTreeRotation = Math.floor(seededRandom(wx, wz, seed + 941) * 4)`**，单一出处（光栅化、覆盖窗口、测试都用它）。`seededRandom` 返回 [0,1) 浮点，**`& 3` 恒为 0**。
7. **非正方形 AABB 旋转后宽深互换**：一律用 `rotatedFootprint`，沿用未旋转的 `w/d` 会切掉一角。
8. **`loadGiantTrees()` 失败不抛、不缓存**：返回空 families（本次 GEN 无巨树），下一次调用重试 —— 与 `structure-json.js` 的「失败即空」同口径，但不把失败永久缓存，避免某个 Worker 永远无树。
9. **盐值**：forest 911~915、beach 921~925、banyan 931~935、rotation 941，占 9xx 空闲带（Step 1 复核）。

---

- [ ] **Step 1: 盐值占用复核**

先确认 HEAD 上 900~999 段对 `seededRandom` 空闲（CLAUDE.md：salt 占用须程序化扫描，不能只 grep 字面量；roadmap 的 salt 表只扫了 1..500）：

```bash
node --input-type=commonjs <<'EOF'
const fs = require('fs'), path = require('path');
const walk = (d, o = []) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) { if (f !== 'tests') walk(p, o); } else if (p.endsWith('.js')) o.push(p); } return o; };
const lits = new Set(); let calls = 0;
for (const f of walk('src')) {
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/seededRandom\(([^;\n]*)\)/g)) { calls++; for (const x of m[1].matchAll(/\+\s*(\d+)/g)) lits.add(+x[1]); }
}
console.log(`seededRandom 调用点 ${calls} 个；字面盐值偏移最大 ${Math.max(...lits)}；落在 900~999 的：${[...lits].filter((n) => n >= 900 && n <= 999).join(',') || '无'}`);
EOF
```

Expected：`seededRandom 调用点 72 个；字面盐值偏移最大 805；落在 900~999 的：无`（带变量偏移的两处 `302+y` / `303+k` 实占 270..397，远低于 800）。

- [ ] **Step 2: 写测试（RED 的来源）**

```javascript
// src/tests/test-giant-trees.js — 巨树景观（Giant Trees Epic）Tier 1：加载 / 旋转 / 候选发现
//
// 本文件钉的是审阅期实测出来的三类真实缺陷（注入该缺陷后对应用例必须 FAIL，见实施计划 Task 4 的负向验证表）：
//   · 旋转必须真的发生（`& 3` 恒为 0 → 旋转永不生效；旧测试靠 forcedRot 绕过所以全绿）
//   · 间距必须跨 region 边界成立（原贪心在 region 边界违规 64 对）
//   · chance 必须是真正的密度旋钮（原 forestChance 0.10→0.01 只少 40%）
// 姊妹文件：test-giant-trees-column.js（column 层）/ test-giant-trees-gen.js（接线与真实 GEN）。
// ⚠️ 写断言前先在真实数据上跑一次、打印实际值（testing-policy §2.6 ⑤）：本文件的下界/区间都取自实测的 1/4 量级。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse, assertDeepEqual } from './assert.js';
import {
  GIANT_FAMILY_ORDER, GIANT_STRIDE, GIANT_TREE_PATHS, isNearWater, isBiomeEdge, giantTreeRotation,
  computeGiantTreeCandidates, loadGiantTrees, rotateCell, rotatedFootprint, treeBox,
} from '../gen/structures/giant-trees.js';
import { generateHeight } from '../gen/terrain.js';
import { getBiome } from '../gen/noise.js';
import { REGION_SIZE } from '../gen/structures/region-config.js';
import { SEA_Y } from '../voxel/constants.js';

const SEED = 12345;

/** 3×3 region 块内某路径的全部候选（带所属 region） */
function blockCandidates(pathKey, regions = [-1, 0, 1]) {
  const out = [];
  for (const rx of regions) for (const rz of regions) {
    const arr = computeGiantTreeCandidates(rx, rz, SEED)[pathKey];
    for (let i = 0; i < arr.length; i += GIANT_STRIDE) out.push({ wx: arr[i], wy: arr[i + 1], wz: arr[i + 2], fam: arr[i + 3], vh: arr[i + 4], rx, rz });
  }
  return out;
}

// ======================================================================== 加载与旋转

test('巨树加载：28 个变体、族数与烘焙元数据一致、palette[0] 是树干、锚点是 gy=0 的树干格、无重复坐标', async () => {
  const { families } = await loadGiantTrees();
  const meta = await (await fetch('/assets/giant-trees/trees.meta.json')).json();
  let total = 0;
  for (const f of GIANT_FAMILY_ORDER) assertTrue(f in families, `族序里的 ${f} 在 trees.json 里`);
  assertEqual(Object.keys(families).length, GIANT_FAMILY_ORDER.length, '族序与 trees.json 的族一一对应');
  for (const [fam, list] of Object.entries(families)) {
    assertEqual(list.length, meta.families[fam], `${fam} 变体数与 trees.meta.json 一致`);
    for (const v of list) {
      total++;
      assertTrue(v.palette[0].endsWith('_log'), `${fam} palette[0] 是树干`);
      assertTrue(v.anchor[0] >= 0 && v.anchor[0] < v.w && v.anchor[1] >= 0 && v.anchor[1] < v.d, `${fam} 锚点在 bbox 内`);
      const seen = new Set(); let anchorIsTrunk = false;
      for (let k = 0; k < v.cells.length; k += 4) {
        const x = v.cells[k], y = v.cells[k + 1], z = v.cells[k + 2], p = v.cells[k + 3];
        assertTrue(p < v.palette.length, `${fam} palIdx ${p} 有效`);
        assertTrue(x < v.w && y < v.h && z < v.d, `${fam} 坐标 ${x},${y},${z} 在 bbox 内`);
        const key = (y * v.d + z) * v.w + x;
        assertFalse(seen.has(key), `${fam} 坐标 ${x},${y},${z} 不重复`);
        seen.add(key);
        if (y === 0 && p === 0 && x === v.anchor[0] && z === v.anchor[1]) anchorIsTrunk = true;
      }
      assertTrue(anchorIsTrunk, `${fam} 锚点格是 gy=0 层的树干格`);
    }
  }
  assertEqual(total, 28, '28 个变体 = 40 − 12 个排除项');
  assertEqual(total, meta.variantCount, '总数与 trees.meta.json 一致');
});

test('旋转：非正方形 AABB 旋转后宽深互换', () => {
  const v = { w: 5, d: 3 };
  assertDeepEqual(rotatedFootprint(v, 0), { w: 5, d: 3 });
  assertDeepEqual(rotatedFootprint(v, 1), { w: 3, d: 5 });
  assertDeepEqual(rotatedFootprint(v, 2), { w: 5, d: 3 });
  assertDeepEqual(rotatedFootprint(v, 3), { w: 3, d: 5 });
});

test('旋转：逐步旋转 4 次回到原位（非正方形）', () => {
  for (const [w, d] of [[5, 3], [7, 4], [11, 12]]) {
    for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) {
      let cur = [x, z], cw = w, cd = d;
      for (let r = 0; r < 4; r++) { cur = rotateCell({ w: cw, d: cd }, 1, cur[0], cur[1]); [cw, cd] = [cd, cw]; }
      assertDeepEqual(cur, [x, z], `(${x},${z}) 在 ${w}×${d} 里转 4 次回到原位`);
    }
  }
});

test('旋转：4 个朝向都是双射且输出落在旋转后的 bbox 内', () => {
  const v = { w: 7, d: 4 };
  for (let rot = 0; rot < 4; rot++) {
    const fp = rotatedFootprint(v, rot); const seen = new Set();
    for (let x = 0; x < v.w; x++) for (let z = 0; z < v.d; z++) {
      const [rx, rz] = rotateCell(v, rot, x, z);
      assertTrue(rx >= 0 && rx < fp.w && rz >= 0 && rz < fp.d, `rot=${rot} (${rx},${rz}) 在 ${fp.w}×${fp.d} 内`);
      const k = `${rx},${rz}`; assertFalse(seen.has(k), `rot=${rot} ${k} 不重复（双射）`); seen.add(k);
    }
    assertEqual(seen.size, v.w * v.d, `rot=${rot} 覆盖全部格`);
  }
});

test('giantTreeRotation：四个朝向都会出现且大致均匀（防 `& 3` 恒为 0 的回归）', () => {
  const hist = [0, 0, 0, 0]; let n = 0;
  for (let x = -200; x < 200; x += 4) for (let z = -200; z < 200; z += 4) { hist[giantTreeRotation(x, z, SEED)]++; n++; }
  for (let r = 0; r < 4; r++) assertTrue(hist[r] > n * 0.15 && hist[r] < n * 0.35, `rot=${r} 占比 ${(hist[r] / n).toFixed(3)} 应接近 25%（实测 ~0.25）`);
});

test('treeBox：锚点对齐候选点；AABB 宽深 = 旋转后的 footprint（全部变体 × 4 个朝向）', async () => {
  const { families } = await loadGiantTrees();
  for (const list of Object.values(families)) for (const v of list) for (let rot = 0; rot < 4; rot++) {
    const wx = -37, wz = 91; const b = treeBox(v, rot, wx, wz); const fp = rotatedFootprint(v, rot);
    assertEqual(b.x1 - b.x0 + 1, fp.w); assertEqual(b.z1 - b.z0 + 1, fp.d);
    const a = rotateCell(v, rot, v.anchor[0], v.anchor[1]);
    assertEqual(b.x0 + a[0], wx, '锚点 x 对齐'); assertEqual(b.z0 + a[1], wz, '锚点 z 对齐');
  }
});

// ======================================================================== 候选发现

test('候选确定性：同 seed 两次调用逐元素相等', () => {
  for (const [rx, rz] of [[0, 0], [-1, 0], [1, 1]]) {
    const a = computeGiantTreeCandidates(rx, rz, SEED), b = computeGiantTreeCandidates(rx, rz, SEED);
    for (const k of ['forest', 'beach', 'banyan']) {
      assertEqual(a[k].length, b[k].length, `${k} 长度一致`);
      for (let i = 0; i < a[k].length; i++) assertEqual(a[k][i], b[k][i], `${k}[${i}]`);
    }
  }
});

test('候选结构：stride、族下标 ⊂ 该路径的两个族、变体 hash 范围、wy = 地表+1', () => {
  for (const p of GIANT_TREE_PATHS) {
    const list = blockCandidates(p.key);
    assertTrue(list.length > 0, `${p.key} 有候选`);
    for (const c of list) {
      assertTrue(p.families.includes(c.fam), `${p.key} 族下标 ${c.fam} 在 ${p.families}`);
      assertTrue(c.vh >= 0 && c.vh < 65536, `${p.key} 变体 hash ${c.vh} 在 [0,65536)`);
      assertEqual(c.wy, generateHeight(c.wx, c.wz, SEED) + 1, `${p.key} (${c.wx},${c.wz}) wy = h+1`);
    }
  }
  for (const k of ['forest', 'beach', 'banyan']) assertEqual(computeGiantTreeCandidates(0, 1, SEED)[k].length % GIANT_STRIDE, 0, `${k} 长度是 stride 的倍数`);
});

test('候选判据：A 只在 FOREST 且陆上；B 陆上且距水 ≤ band；C 在 PLAINS/DESERT 且 ±band 内跨 biome（与实现共用导出的谓词）', () => {
  const [A, B, C] = GIANT_TREE_PATHS;
  for (const c of blockCandidates('forest')) {
    assertEqual(getBiome(c.wx, c.wz, SEED), 'FOREST', `A (${c.wx},${c.wz}) 是 FOREST`);
    assertTrue(c.wy - 1 > SEA_Y, `A (${c.wx},${c.wz}) 在陆上`);
  }
  for (const c of blockCandidates('beach')) {
    assertTrue(c.wy - 1 > SEA_Y, `B (${c.wx},${c.wz}) 在陆上`);
    assertTrue(isNearWater(c.wx, c.wz, SEED, B.band), `B (${c.wx},${c.wz}) 距水 ≤ ${B.band}`);
  }
  for (const c of blockCandidates('banyan')) {
    const b = getBiome(c.wx, c.wz, SEED);
    assertTrue(b === 'PLAINS' || b === 'DESERT', `C (${c.wx},${c.wz}) biome=${b}`);
    assertTrue(c.wy - 1 > SEA_Y, `C (${c.wx},${c.wz}) 在陆上`);
    assertTrue(isBiomeEdge(c.wx, c.wz, SEED, C.band), `C (${c.wx},${c.wz}) 是草地/沙漠交界`);
  }
  assertTrue(A.key === 'forest', '路径序 A=forest');
});

test('isNearWater 单调：band 小者 ⊆ band 大者（采样点集合随 band 扩大）', () => {
  let near4 = 0;
  for (let x = -300; x < 300; x += 7) for (let z = -300; z < 300; z += 7) {
    if (isNearWater(x, z, SEED, 4)) { near4++; assertTrue(isNearWater(x, z, SEED, 24), `(${x},${z}) band4 近水则 band24 近水`); }
  }
  assertTrue(near4 > 0, '采样里确有近水点（否则本用例无判别力）');
});

test('候选间距（含 region 边界）：同路径任意两点切比雪夫距离 ≥ spacing + 1（构造性保证）', () => {
  for (const p of GIANT_TREE_PATHS) {
    const list = blockCandidates(p.key); let minD = Infinity;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      minD = Math.min(minD, Math.max(Math.abs(list[i].wx - list[j].wx), Math.abs(list[i].wz - list[j].wz)));
    }
    assertTrue(minD >= p.spacing + 1, `${p.key} 最小间距 ${minD} ≥ ${p.spacing + 1}`);
  }
});

test('候选 region 归属：每个点落在自己所属 region 内，且 3×3 块内无重复点', () => {
  for (const p of GIANT_TREE_PATHS) {
    const seen = new Set();
    for (const c of blockCandidates(p.key)) {
      assertEqual(Math.floor(c.wx / REGION_SIZE), c.rx, `${p.key} (${c.wx},${c.wz}) x 属于 region ${c.rx}`);
      assertEqual(Math.floor(c.wz / REGION_SIZE), c.rz, `${p.key} (${c.wx},${c.wz}) z 属于 region ${c.rz}`);
      const k = `${c.wx},${c.wz}`; assertFalse(seen.has(k), `${p.key} ${k} 不重复（跨 region 的 cell 只被一侧保留）`); seen.add(k);
    }
  }
});

test('chance 是有效的密度旋钮（原设计的 forestChance 在贪心下几乎无效）', () => {
  const regions = [[-1, 0], [0, -1], [1, 0]];
  const count = (chance) => {
    const paths = GIANT_TREE_PATHS.map((p) => ({ ...p, chance }));
    return regions.reduce((s, [rx, rz]) => s + computeGiantTreeCandidates(rx, rz, SEED, paths).forest.length / GIANT_STRIDE, 0);
  };
  const full = count(1), half = count(0.5);
  assertEqual(count(0), 0, 'chance=0 → 无候选');
  assertTrue(full >= 60, `chance=1 有足够多的森林候选（实测 ≥ 100，下界取 60）：${full}`);
  assertTrue(half > full * 0.35 && half < full * 0.65, `chance=0.5 → 约一半：${half} / ${full}`);
});

test('候选密度下界（防谓词写崩变恒空）：3×3 region 内 A ≥ 100、B ≥ 300、C ≥ 80', () => {
  // 实测 446 / 1158 / 399（含城区 region(0,0) 内未被 apply 层排除的点）；下界取 ~1/4
  assertTrue(blockCandidates('forest').length >= 100, 'A 候选下界');
  assertTrue(blockCandidates('beach').length >= 300, 'B 候选下界');
  assertTrue(blockCandidates('banyan').length >= 80, 'C 候选下界');
});

test('候选发现耗时：单 region 三路径 < 8ms（原逐点扫描法 14~20ms；网格抖动实测 ~1ms）', () => {
  computeGiantTreeCandidates(1, 1, SEED); // 预热
  let best = Infinity;
  for (let i = 0; i < 3; i++) { const t0 = performance.now(); computeGiantTreeCandidates(1, 1, SEED); best = Math.min(best, performance.now() - t0); }
  assertTrue(best < 8, `候选发现 ${best.toFixed(2)}ms < 8ms`);
});
```

在 `src/tests/index.html` 里，`import './test-scatter.js';` 之后加一行：

```html
    import './test-giant-trees.js';
```

- [ ] **Step 3: 验证 RED**

先起服务（`node server-script/start-server.js &`），再 Run: `node tests/tmp-unit.mjs`

Expected（整页失败 —— 本仓新模块 TDD 的 RED 形态，`giant-trees.js` 还不存在）：

```text
✗ 整页失败：window.__MC_TEST_RESULTS__ 未出现（静态 import 缺导出 / 模块 404 / 语法错 → 所有套件一起失去结果）
    HTTP 404: http://localhost:8081/src/gen/structures/giant-trees.js
```

- [ ] **Step 4: 写第一部分实现**

```javascript
// src/gen/structures/giant-trees.js — 巨树景观（设计文档 docs/superpowers/specs/2026-10-23-giant-trees-design.md）
//
// 两段式（与 scatter.js 同构，红线 2）：
//   region layout 层  computeGiantTreeCandidates()：候选点 = 全局对齐网格 + 内缩抖动（无状态、跨 region 无缝、
//                     间距由构造保证），谓词（biome/近水/交界）只对每格 ≤1 个点求值；
//   column 应用层     applyGiantTrees()：合并 3×3 邻域候选 → 按 AABB 取交 → 排除（地标/撒布/城市）→ 逐格光栅化
//                     → 地基填充 → 返回「旧植被抑制」覆盖窗口。
//
// Worker 同构：本文件不得 import three、不得自建 Worker。
//
// ⚠️ 与 mc-lite 无对应物（mc-lite 没有这些树）；树形数据来自 40AssortedTreesPack.schem（离线烘焙，见
//    tools/bake-giant-trees.mjs），**不是**对 mc-lite 的移植，所以不存在「偏离 mc-lite」问题。
import { seededRandom, getBiome } from '../noise.js';
import { generateHeight } from '../terrain.js';
import { REGION_SIZE } from './region-config.js';
import { SEA_Y } from '../../voxel/constants.js';

/** 族序（候选里存下标；绝不依赖对象 key 顺序）。与 tools/giant-trees-fingerprint.mjs 的 TREE_FAMILIES 同名同序。 */
export const GIANT_FAMILY_ORDER = Object.freeze(['tallOak', 'snowSpruce', 'cherry', 'palm', 'banyanLeafy', 'banyanBare']);

/** 候选数组的 stride：[wx, wy, wz, familyIdx, variantHash] */
export const GIANT_STRIDE = 5;

/** 旋转的 salt（单一权威；候选层不存旋转，光栅化与覆盖窗口都用 giantTreeRotation 现算） */
const SALT_ROT = 941;

/** 地基填充的最大深度：实测 3×3 region 里 gy=0 层方块下方空隙 p99=3、最大 9 */
export const GIANT_SUPPORT_MAX = 10;

// 无需 Y 裁剪判据：地表 h ≤ 16，树高 ≤ 42 → 树顶 ≤ 59 < WORLD_MAX_Y(96)。

// ---------------------------------------------------------------- 判据（候选层与测试共用，红线 1）

/** 地表高度；陆上（> SEA_Y）才可能落树。返回 null = 不满足。 */
function landHeight(wx, wz, seed) {
  const h = generateHeight(wx, wz, seed);
  return h > SEA_Y ? h : null;
}

/** 距水 ≤ band 格：4 轴向、步长 4 采样（r = 4, 8, …, band），任一采样点 h < SEA_Y 即视为近水 */
export function isNearWater(wx, wz, seed, band) {
  for (let r = 4; r <= band; r += 4) {
    if (generateHeight(wx + r, wz, seed) < SEA_Y || generateHeight(wx - r, wz, seed) < SEA_Y ||
        generateHeight(wx, wz + r, seed) < SEA_Y || generateHeight(wx, wz - r, seed) < SEA_Y) return true;
  }
  return false;
}

/** 草地/沙漠交界：本点是 PLAINS 或 DESERT，且 4 轴向 ±band 处的任一端点是「另一种」 */
export function isBiomeEdge(wx, wz, seed, band) {
  const b = getBiome(wx, wz, seed);
  if (b !== 'PLAINS' && b !== 'DESERT') return false;
  const other = b === 'PLAINS' ? 'DESERT' : 'PLAINS';
  return getBiome(wx + band, wz, seed) === other || getBiome(wx - band, wz, seed) === other ||
         getBiome(wx, wz + band, seed) === other || getBiome(wx, wz - band, seed) === other;
}

/**
 * 三条落位路径（单一权威；改数值须同步设计文档 §3.5 表）。
 *   cell 边长 C = spacing + jitter；每格至多 1 个点，落在格内 [0, jitter) × [0, jitter) 的内缩方块里
 *   ⇒ 相邻格的点切比雪夫距离 ≥ spacing + 1（构造性保证，不需要贪心/排序/跨 region 协调）。
 *   chance = 每格出点概率（密度旋钮；原设计的 forestChance 在贪心下几乎无效，这里真正线性控制密度）；
 *   families = 该路径可选的两个族（GIANT_FAMILY_ORDER 下标，各 50%）。
 *   **spacing 是最小树距，不是树宽**：A 森林树 AABB ≤ 12，spacing 14 → 互不相交；B/C 的樱花/榕树 AABB 达 17，
 *   spacing 8（C=14）→ 冠幅互相重叠成片（设计意图「成片樱花+椰林」），树干不重叠。
 *   实测密度（7 个 region，每个 eligible 格）：A 1/464、B 1/199、C 1/207 —— 约为原贪心设计的 80% / 88% / 108%。
 *   salt 占 9xx 空闲带（静态扫描确认 src 下无 900~999 的 salt）：+0 出点 / +1 x 抖动 / +2 z 抖动 / +3 族 / +4 变体。
 *   eligible(wx, wz, seed) → 地表高度 h（满足）| null（不满足）。
 */
export const GIANT_TREE_PATHS = Object.freeze([
  Object.freeze({
    key: 'forest', salt: 911, spacing: 14, jitter: 8, chance: 1, families: Object.freeze([0, 1]),
    // A 森林：FOREST biome + 陆上。
    eligible: (wx, wz, seed) => (getBiome(wx, wz, seed) === 'FOREST' ? landHeight(wx, wz, seed) : null),
  }),
  Object.freeze({
    key: 'beach', salt: 921, spacing: 8, jitter: 6, chance: 1, families: Object.freeze([2, 3]), band: 24,
    // B 海边：陆上 + 距水 ≤ band。
    eligible(wx, wz, seed) { const h = landHeight(wx, wz, seed); return h !== null && isNearWater(wx, wz, seed, this.band) ? h : null; },
  }),
  Object.freeze({
    key: 'banyan', salt: 931, spacing: 8, jitter: 6, chance: 1, families: Object.freeze([4, 5]), band: 32,
    // C 榕树带：PLAINS/DESERT 交界（±band 内跨 biome）+ 陆上。
    eligible(wx, wz, seed) { const h = landHeight(wx, wz, seed); return h !== null && isBiomeEdge(wx, wz, seed, this.band) ? h : null; },
  }),
]);

/** 树的朝向 0~3（90° 步进）。**必须 floor(r*4)**：seededRandom 返回 [0,1) 浮点，`& 3` 恒为 0。 */
export function giantTreeRotation(wx, wz, seed) {
  return Math.floor(seededRandom(wx, wz, seed + SALT_ROT) * 4);
}

// ---------------------------------------------------------------- 候选发现（region 层）

/**
 * 单条路径在 region 内的候选。cell 按全局网格对齐（cell 下标 = floor(世界坐标 / C)），
 * 一个点属于它所在的 region ⇒ 跨 region 的 cell 由两侧各算一次、各自只保留落在本 region 内的点，
 * 不重复、不遗漏。
 * @returns {Int32Array} stride = GIANT_STRIDE
 */
function discoverPath(path, regionX, regionZ, seed) {
  const C = path.spacing + path.jitter;
  const x0 = regionX * REGION_SIZE, z0 = regionZ * REGION_SIZE;
  const i0 = Math.floor(x0 / C), i1 = Math.floor((x0 + REGION_SIZE - 1) / C);
  const j0 = Math.floor(z0 / C), j1 = Math.floor((z0 + REGION_SIZE - 1) / C);
  const out = [];
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      if (seededRandom(i, j, seed + path.salt) >= path.chance) continue;
      const wx = i * C + Math.floor(seededRandom(i, j, seed + path.salt + 1) * path.jitter);
      const wz = j * C + Math.floor(seededRandom(i, j, seed + path.salt + 2) * path.jitter);
      if (wx < x0 || wx >= x0 + REGION_SIZE || wz < z0 || wz >= z0 + REGION_SIZE) continue;
      const h = path.eligible(wx, wz, seed);
      if (h === null) continue;
      const fam = path.families[seededRandom(i, j, seed + path.salt + 3) < 0.5 ? 0 : 1];
      // 变体下标存「原始 hash 整数」：候选层拿不到变体数（loadGiantTrees 异步），光栅化层再 % 该族变体数
      const variantHash = Math.floor(seededRandom(i, j, seed + path.salt + 4) * 65536);
      out.push(wx, h + 1, wz, fam, variantHash);
    }
  }
  return Int32Array.from(out);
}

/**
 * region 层候选（纯函数、确定性、与 region 邻居无关）。
 * @returns {{forest: Int32Array, beach: Int32Array, banyan: Int32Array}}
 */
export function computeGiantTreeCandidates(regionX, regionZ, seed, paths = GIANT_TREE_PATHS) {
  const out = {};
  for (const p of paths) out[p.key] = discoverPath(p, regionX, regionZ, seed);
  return out;
}

// ---------------------------------------------------------------- 变体加载与几何

let cache = null;
let loading = null;

/**
 * 加载烘焙产物（每个 Worker / 页面线程各一份，模块级缓存）。
 * `cells` 是扁平 Uint8Array 四元组 [gx, gy, gz, palIdx, …]（取值 ≤ 42，装得下 Uint8）。
 * 失败不抛、不缓存：返回空 families（本次 GEN 无巨树），下一次调用会重试 —— 与 structure-json.js 的
 * 「失败即空」同口径，但不把失败永久缓存，避免某个 Worker 永远无树。
 */
export function loadGiantTrees() {
  if (cache) return Promise.resolve(cache);
  if (!loading) {
    loading = fetch('/assets/giant-trees/trees.json').then((r) => r.json()).then((data) => {
      const families = {};
      for (const [fam, list] of Object.entries(data.trees)) {
        families[fam] = list.map((v) => ({
          pad: v.pad, w: v.w, d: v.d, h: v.h, anchor: v.anchor, palette: v.palette, cells: Uint8Array.from(v.blocks),
        }));
      }
      cache = { families };
      return cache;
    }).catch(() => { loading = null; return { families: {} }; });
  }
  return loading;
}

/** 同步读模块缓存；未加载完成返回 null（GEN 入口会先 await loadGiantTrees()） */
export function getGiantTreesSync() { return cache; }

/**
 * 绕 AABB 顺时针旋转 90° × rot 后的局部坐标：rot=1 时 (x,z) → (d-1-z, x)。
 * 非正方形 AABB 旋转后宽深互换，调用方必须用 rotatedFootprint 取旋转后的 w/d。
 */
export function rotateCell(v, rot, x, z) {
  switch (rot & 3) {
    case 0: return [x, z];
    case 1: return [v.d - 1 - z, x];
    case 2: return [v.w - 1 - x, v.d - 1 - z];
    default: return [z, v.w - 1 - x];
  }
}

/** 旋转后的 AABB 宽深（rot 为奇数时互换） */
export function rotatedFootprint(v, rot) {
  return (rot & 1) === 1 ? { w: v.d, d: v.w } : { w: v.w, d: v.d };
}

/** 树的世界 AABB（闭区间）与原点：锚点对齐候选点 (wx, wz) */
export function treeBox(v, rot, wx, wz) {
  const fp = rotatedFootprint(v, rot);
  const a = rotateCell(v, rot, v.anchor[0], v.anchor[1]);
  const x0 = wx - a[0], z0 = wz - a[1];
  return { x0, z0, x1: x0 + fp.w - 1, z1: z0 + fp.d - 1 };
}
```

- [ ] **Step 5: 验证 GREEN**

Run: `node tests/tmp-unit.mjs`

Expected：`harness: passed=794 failed=0 total=794`（779 + 15）。`node tests/tmp-unit.mjs 巨树` 可只看本 Epic 的用例。

- [ ] **Step 6: 负向验证 —— 5 类缺陷注入后必须真红**

临时改动 `src/gen/structures/giant-trees.js`，跑 `node tests/tmp-unit.mjs`，确认**恰好**列出的用例变红（实测），然后复原：

| # | 临时改动 | 变红的用例（实测） |
|---|---|---|
| ② | `giantTreeRotation` 改回 `seededRandom(wx, wz, seed + SALT_ROT) & 3` | `giantTreeRotation：四个朝向都会出现且大致均匀（防 \`& 3\` 恒为 0 的回归）` |
| ③ | `discoverPath` 的 x 抖动 `* path.jitter` 改成 `* C`（抖动满格，间距不再有保证） | `候选间距（含 region 边界）：…切比雪夫距离 ≥ spacing + 1（构造性保证）` |
| ④ | 删掉 region 归属过滤（`if (wx < x0 \|\| wx >= x0 + REGION_SIZE …) continue;`） | `候选间距（含 region 边界）…` + `候选 region 归属：每个点落在自己所属 region 内，且 3×3 块内无重复点` |
| ⑤ | 删掉 `if (seededRandom(i, j, seed + path.salt) >= path.chance) continue;` | `chance 是有效的密度旋钮（原设计的 forestChance 在贪心下几乎无效）` |
| ⑥ | `treeBox` 里 `const fp = rotatedFootprint(v, rot);` 改成 `{ w: v.w, d: v.d }` | `treeBox：锚点对齐候选点；AABB 宽深 = 旋转后的 footprint（全部变体 × 4 个朝向）` |

（编号与 Task 6 Step 6 的 15 条总表一致；①⑦~⑪ 在 Task 5 验证，⑫~⑮ 在 Task 6 验证。）

- [ ] **Step 7: 静态门**

Run: `npm run check`

Expected：`[check:arch] 扫描 104 个源文件` + `✓ 架构红线全部守住`；`[测试注册] 47 个测试文件全部已注册`；`[check:data] ✓ 数据契约全部一致`；lint `✖ 15 problems (0 errors, 15 warnings)`（新文件 0 条）。

**负向验证**：临时在 `giant-trees.js` 第 2 行加 `import * as THREE from 'three';`，`npm run check:arch` 必须红：

```text
[check:arch] 扫描 104 个源文件
[check:arch] 1 项白名单例外（已记录理由）：
  [分层例外] src/voxel/world-data.js:6 → mesh —— 红线 11 编辑快路径同步重算垂直单列；lighting.js 是同构纯函数（算法依赖非渲染依赖）
[check:arch] ✗ 1 项架构红线违规：
  [红线 8/10] src/gen/structures/giant-trees.js:2 Worker 同构模块 import three（且头部声明了同构 → 自我矛盾） —— import * as THREE from 'three';
处置：红线回退不得合入。若属正当例外，须在 DEP_WHITELIST / THREE_EXEMPT
      加白名单条目并注明理由（理由须能说清「为什么这不是红线回退」）。
```

复原后重跑应绿。

盐值占用复核（实现后）：`grep -rnE "seed *\+ *9[0-9]{2}\b|salt *: *9[0-9]{2}\b|SALT_ROT *= *9[0-9]{2}" src --include='*.js' | grep -v src/tests/` 只应命中 `giant-trees.js` 的 4 行（`SALT_ROT = 941` 与三条路径的 `salt: 911 / 921 / 931`）。

- [ ] **Step 8: 提交**（仅在用户明确要求提交时）

```bash
git add src/gen/structures/giant-trees.js src/tests/test-giant-trees.js src/tests/index.html
git commit -m "feat(giant-trees): region 层候选（网格抖动）与变体加载/旋转/几何"
```

---

## Task 5: `giant-trees.js` 第二部分 —— column 层（TDD）

**Files:**
- Create: `src/tests/test-giant-trees-column.js`（7 条）
- Modify: `src/gen/structures/giant-trees.js`（替换 import 块 + 文件末尾追加 column 层）
- Modify: `src/tests/index.html`（注册）

**Interfaces:**
- Consumes：Task 4 的几何与加载；`makeColumnSetter`（`landmarks.js`，自带 column 裁剪、未注册名静默跳过）；`SCATTER_FOOTPRINT` / `CITY_STRUCTURE_FOOTPRINT`（`region-config.js`）；`SCATTER_TYPES` / `SCATTER_STRIDE`（`scatter.js`）。
- Produces（本任务新增导出）：`collectGiantTrees`、`collectExclusionBoxes`、`isGiantTreeAllowed`、`rasterizeGiantTree`、`buildCoveredWindow`、`applyGiantTrees`。
  - `applyGiantTrees(column, layouts, seed, registry, { allowedAt, ext }) → { covers(wx, wz) }`：`allowedAt(wx, wz) → boolean` 由 `apply.js` 用 `pointContext` 构造（Task 6）；`ext` 是植被扫描外扩（Task 6 的 `VEGETATION_EXT = 3`）。

**设计要点**（spec §3.5）：

流水线：`合并邻域候选(拼接) → 解析（变体 = list[hash % n]，朝向 = giantTreeRotation）→ 与窗口 AABB 外扩 ext 取交 → 规范排序（路径序, wx, wz）→ 排除（isGiantTreeAllowed）→ 光栅化 + 地基（只对 AABB 与本 column 相交者）→ buildCoveredWindow（供阶段 3 抑制旧植被）`。

1. **合并必须「拼接」不能「覆盖赋值」**：`layouts` 是查询域内最多 9（跨 region 边界的 column 最多 16）个 region 布局。v1.0 的 `giantCandidates[k] = layout.giantTrees[k]` 会让区域内 99.7% 的 column 没有树（区域(-1,0) 内 625 个 column 只会光栅化 1 棵，应 359 棵）。并按 `(路径序, wx, wz)` 排成**规范顺序**，使逐格「后写胜」的结果与 `layouts` 的下发顺序无关。
2. **排除（让路）= apply 层，不是候选层**：候选层拿不到邻居 region 的地标。判据两项：① AABB 九点（四角 + 四边中点 + 中心）与锚点的 `allowedAt` 必须全真（`pointContext` 只允许 `normal` / `water`；`water` = 树冠悬在水面上）；② 不与任何既有结构外包盒相交（城外撒布结构 `SCATTER_FOOTPRINT` 外扩 1；**平地金字塔岛 JSON 占地**（halfX 17 / halfZ 20）与**海岛塔**外扩 2 = `apply.js` 的 `INTERSECT_MARGIN`）。⚠️ 只靠 `pointContext` 不够：平地沙台 `getPlainLandInfo` 只有 ±15，而 `pyramid_island.json` 占地 34×39，比沙台大 2~5 格——实测只用 `pointContext` 时既有的 `pyramidIsland` 用例被树干覆盖。
3. **排除结论对覆盖该树的任一 column 恒一致**（否则同一棵树在两个 column 里一个生成一个不生成 = 半棵树）：判定只依赖树本身与邻域 layouts；与树 AABB 相交的 column 的 3×3 查询域都含该树所在 region 及朝向该 column 一侧的邻居；能影响树 AABB 的地标/撒布只来自树所在 region 及其相邻 region（地标外延 < 60 格 ≪ region 边长 400），背向一侧的邻居（≥300 格外）够不到。
4. **地基**：`gy=0` 层的树干格（`palette[0]`）若下方悬空（地表 `h < wy-1`），用同种树干向下补到 `h+1`（深度 1~10；>10 不补）。实测 22% 的树基部悬空 ≥1 格，最高 9。直接用 `generateHeight`（纯函数、跨 column 一致）而不探测 column 内容——探测在 column 边缘取不到邻列数据。对应既有 `GROUND_SUPPORT_TYPES` 的同一语义。
5. **覆盖窗口**：窗口 = column 外扩 `ext` 的 `(16+2ext)²` 位图；每棵树的**覆盖区 = AABB ⊕ ext**。为什么两个都要外扩：旧树冠半径 ≤ ext，树干落在 AABB ⊕ ext 内的旧树其树冠才可能碰到巨树 AABB，于是「AABB 内不存在任何旧树方块」是**可证明**的而不只是概率上成立；阶段 3 会扫描 column 外 ext 格带，带内旧树的树冠会写进本 column——v1.0 的 `covered` 只标本 column，实测每 256 个 column 游离出 5,332 格没有树干的旧树冠。
6. `applyGiantTrees` 在变体数据未加载时返回「恒不覆盖」（GEN 入口会先 `await loadGiantTrees()`，Worker 里更早已预热）。

---

- [ ] **Step 1: 写测试（RED 的来源）**

```javascript
// src/tests/test-giant-trees-column.js — 巨树景观 Tier 1：column 层（合并 / 排除 / 跨 column 光栅化 / 地基 / 覆盖窗口）
//
// 钉的缺陷：
//   · 邻域候选必须「拼接」而非「覆盖」（覆盖赋值 → 区域内只生成 0.3% 的树）
//   · 跨 column 光栅化逐格无缺漏（非正方形变体 × 4 朝向；Review Focus ①②）
//   · 悬空的树干底格要补地基（22% 的树基部悬空 ≥1 格）
//   · 旧植被覆盖窗口必须外扩 EXT（只覆盖本 column → 每 256 个 column 游离 5,332 格没有树干的旧树冠）
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse, assertNotNull, assertDeepEqual } from './assert.js';
import {
  GIANT_SUPPORT_MAX, loadGiantTrees, rotateCell, treeBox, collectGiantTrees, collectExclusionBoxes,
  isGiantTreeAllowed, rasterizeGiantTree, buildCoveredWindow, applyGiantTrees,
} from '../gen/structures/giant-trees.js';
import { generateHeight } from '../gen/terrain.js';
import { makeColumnSetter } from '../gen/structures/landmarks.js';
import { SCATTER_TYPES } from '../gen/structures/scatter.js';
import { SCATTER_FOOTPRINT, CITY_STRUCTURE_FOOTPRINT } from '../gen/structures/region-config.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { blockIndex, WORLD_MIN_Y } from '../voxel/constants.js';

const SEED = 12345;
const EXT = 3; // 与 apply.js 的 VEGETATION_EXT 同值（植被树冠半径 ≤ 3）

function makeRegistry() {
  const r = createRegistry();
  for (const def of BLOCKS) r.register(def.name, def);
  r.freeze();
  return r;
}
const reg = makeRegistry();
const GIANT_IDS = new Set(BLOCKS.filter((b) => b.name.startsWith('giant_')).map((b) => reg.idOf(b.name)));
function countIds(col, ids) { let n = 0; for (let i = 0; i < col.blocks.length; i++) if (ids.has(col.blocks[i])) n++; return n; }

/** 造一棵指定变体、朝向、锚点位置的树对象（与 resolveTree 的产出同形） */
function makeTree(variant, rot, wx, wy, wz) {
  return { path: 'forest', wx, wy, wz, variant, rot, ...treeBox(variant, rot, wx, wz) };
}

test('collectGiantTrees：合并全部邻域 layouts（拼接而非覆盖）+ 规范顺序（与 layouts 下发顺序无关）', async () => {
  const { families } = await loadGiantTrees();
  const mk = (wx, wz) => ({ giantTrees: { forest: Int32Array.from([wx, 30, wz, 0, 0]), beach: new Int32Array(0), banyan: new Int32Array(0) } });
  const layouts = [mk(0, 0), mk(100, 0), mk(200, 0)];
  const win = { minX: -50, maxX: 300, minZ: -50, maxZ: 50 };
  const a = collectGiantTrees(layouts, SEED, families, win, EXT);
  assertEqual(a.length, 3, '3 个 layout 各 1 棵 → 共 3 棵（覆盖赋值只会剩 1 棵）');
  const b = collectGiantTrees([...layouts].reverse(), SEED, families, win, EXT);
  assertDeepEqual(a.map((t) => [t.wx, t.wz]), b.map((t) => [t.wx, t.wz]), '顺序与 layouts 顺序无关');
});

test('isGiantTreeAllowed：九点/锚点任一不允许即拒；撒布外包盒相交即拒', async () => {
  const { families } = await loadGiantTrees();
  const v = families.cherry[0];
  const t = makeTree(v, 0, 100, 30, 100);
  assertTrue(isGiantTreeAllowed(t, () => true, []), '全允许、无撒布 → 通过');
  for (const [x, z] of [[t.x0, t.z0], [t.x1, t.z1], [(t.x0 + t.x1) >> 1, (t.z0 + t.z1) >> 1], [t.wx, t.wz]]) {
    assertFalse(isGiantTreeAllowed(t, (px, pz) => !(px === x && pz === z), []), `(${x},${z}) 不允许 → 拒`);
  }
  assertFalse(isGiantTreeAllowed(t, () => true, [{ x0: t.x1, x1: t.x1 + 5, z0: t.z0, z1: t.z1 }]), '撒布盒与 AABB 相交（共享一列）→ 拒');
  assertTrue(isGiantTreeAllowed(t, () => true, [{ x0: t.x1 + 1, x1: t.x1 + 5, z0: t.z0, z1: t.z1 }]), '撒布盒紧贴但不相交 → 通过');
});

test('collectExclusionBoxes：撒布 +1、平地金字塔岛 JSON 占地（halfX17/halfZ20）+2、海岛塔 +2；窗口外的不收', () => {
  const house = SCATTER_TYPES.indexOf('house');
  const layouts = [{
    plainLand: { cx: 100, cz: 100 }, island: { cx: 300, cz: 100 },
    scatter: { outsideScatter: Int32Array.from([50, 20, 60, house, 102, 20, 100, house]) },
  }];
  assertEqual(collectExclusionBoxes(layouts, { minX: -400, maxX: -385, minZ: 0, maxZ: 15 }, EXT).length, 0, '全都在窗口 24+ext 格之外 → 一个都不收');
  const boxes = collectExclusionBoxes(layouts, { minX: 90, maxX: 105, minZ: 90, maxZ: 105 }, EXT);
  const pi = CITY_STRUCTURE_FOOTPRINT.pyramidIsland, hs = SCATTER_FOOTPRINT.house;
  assertTrue(boxes.some((b) => b.x0 === 100 - pi.halfX - 2 && b.x1 === 100 + pi.halfX + 2 && b.z0 === 100 - pi.halfZ - 2 && b.z1 === 100 + pi.halfZ + 2),
    '平地金字塔岛占地盒 = footprint + 2（比 getPlainLandInfo 的 ±15 沙台大）');
  assertTrue(boxes.some((b) => b.x0 === 102 - hs.halfX - 1 && b.x1 === 102 + hs.halfX + 1 && b.z0 === 100 - hs.halfZ - 1), 'house 撒布盒 = footprint + 1');
  assertEqual(boxes.length, 2, '海岛塔(300,100)与远处 house(50,60) 都不在窗口附近');
});

test('跨 column 光栅化：4 个朝向 × 含非正方形变体，2×2 个 column 逐格 == 期望（双向：无缺格、无多格）', async () => {
  const { families } = await loadGiantTrees();
  const nonSquare = families.tallOak.find((v) => v.w !== v.d);
  assertNotNull(nonSquare, '存在非正方形变体（Review Focus ②）');
  for (const v of [families.cherry[0], nonSquare]) {
    for (let rot = 0; rot < 4; rot++) {
      // 锚点放在 4 个 column 的交点（世界坐标 (16,16)）；WY=56：树顶 ≤ 56+42 < WORLD_MAX_Y，不被世界高度裁剪；
      // 地表 h ≤ 16 → 地基深度 ≥ 38 > GIANT_SUPPORT_MAX，不产生额外方块
      const WY = 56;
      const t = makeTree(v, rot, 16, WY, 16);
      const cols = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([cx, cz]) => new ChunkColumn(cx, cz));
      for (const c of cols) rasterizeGiantTree(makeColumnSetter(c, reg), t, SEED);
      // 期望：独立展开变体全部格
      const want = new Map();
      for (let k = 0; k < v.cells.length; k += 4) {
        const [rx, rz] = rotateCell(v, rot, v.cells[k], v.cells[k + 2]);
        want.set(`${t.x0 + rx},${WY + v.cells[k + 1]},${t.z0 + rz}`, reg.idOf(v.palette[v.cells[k + 3]]));
      }
      let written = 0, mismatched = 0;
      for (const c of cols) for (let ly = 0; ly < 128; ly++) for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
        const id = c.blocks[blockIndex(lx, ly + WORLD_MIN_Y, lz)];
        if (id === 0) continue;
        written++;
        if (want.get(`${c.cx * 16 + lx},${ly + WORLD_MIN_Y},${c.cz * 16 + lz}`) !== id) mismatched++;
      }
      // 期望格都落在这 4 个 column 的范围内（锚点在交点附近，树宽 ≤ 17）
      let expectedInRange = 0;
      for (const k of want.keys()) { const [x, , z] = k.split(',').map(Number); if (x >= 0 && x < 32 && z >= 0 && z < 32) expectedInRange++; }
      assertEqual(expectedInRange, want.size, `rot=${rot} 树的全部格都在 4 个 column 内（否则本用例无判别力）`);
      assertEqual(mismatched, 0, `rot=${rot} ${v.w}×${v.d}：写入的方块都等于期望`);
      assertEqual(written, want.size, `rot=${rot} ${v.w}×${v.d}：写入格数 == 变体格数（AABB 裁剪未丢格）`);
    }
  }
});

test('地基：gy=0 树干格下方悬空 1~MAX 格时补同种树干；悬空 > MAX 不补', async () => {
  const { families } = await loadGiantTrees();
  const v = families.tallOak[0]; // gy=0 层只有 1 个树干格
  const [wx, wz] = [40, 40]; const h = generateHeight(wx, wz, SEED);
  const trunkName = v.palette[0];
  for (const [hang, expectFill] of [[3, true], [GIANT_SUPPORT_MAX, true], [GIANT_SUPPORT_MAX + 1, false]]) {
    const c = new ChunkColumn(2, 2); // 世界 x,z ∈ [32,48)
    const t = makeTree(v, 0, wx, h + 1 + hang, wz);
    rasterizeGiantTree(makeColumnSetter(c, reg), t, SEED);
    const id = reg.idOf(trunkName);
    for (let y = h + 1; y < h + 1 + hang; y++) {
      assertEqual(c.blocks[blockIndex(wx - 32, y, wz - 32)] === id, expectFill, `悬空 ${hang} 格：y=${y} ${expectFill ? '应补' : '不应补'}树干`);
    }
    assertEqual(c.blocks[blockIndex(wx - 32, h + 1 + hang, wz - 32)], id, '锚点树干格本身在');
  }
});

test('覆盖窗口：AABB 外扩 EXT；column 外 EXT 格带内也覆盖；窗口外恒 false', async () => {
  const { families } = await loadGiantTrees();
  const v = families.palm[1]; // 11×11
  const col = new ChunkColumn(0, 0);
  const t0 = makeTree(v, 0, 8, 40, 8);
  const t = makeTree(v, 0, 8 + (15 - t0.x1), 40, 8); // AABB 东边界贴着 column 的 x=15
  assertEqual(t.x1, 15);
  const cw = buildCoveredWindow(col, [t], EXT);
  assertTrue(cw.covers(t.x0, t.z0), 'AABB 角落被覆盖');
  assertTrue(cw.covers(t.x0 - EXT, t.z0), 'AABB 外扩 EXT 仍覆盖');
  assertFalse(cw.covers(t.x0 - EXT - 1, t.z0), '再外一格不覆盖');
  assertTrue(cw.covers(15 + EXT, t.z0), 'column 外 EXT 格带内也覆盖（旧树树干在带内时其树冠会写进本 column）');
  assertFalse(cw.covers(15 + EXT + 1, t.z0), '窗口外恒 false（东）');
  assertFalse(cw.covers(-EXT - 1, 0), '窗口外恒 false（西）');
  assertFalse(buildCoveredWindow(col, [], EXT).covers(8, 8), '无树 → 不覆盖');
});

test('applyGiantTrees（合成场景）：允许 → 写入方块并返回覆盖；不允许 → 零方块、不覆盖', async () => {
  await loadGiantTrees(); // applyGiantTrees 读模块缓存（getGiantTreesSync），须先加载
  const mkLayouts = () => [{ giantTrees: { forest: Int32Array.from([8, 56, 8, 0, 0]), beach: new Int32Array(0), banyan: new Int32Array(0) } }];
  const a = new ChunkColumn(0, 0);
  const ca = applyGiantTrees(a, mkLayouts(), SEED, reg, { allowedAt: () => true, ext: EXT });
  assertTrue(countIds(a, GIANT_IDS) > 0, '允许 → 有巨树方块');
  assertTrue(ca.covers(8, 8), '允许 → 锚点被覆盖');
  const b = new ChunkColumn(0, 0);
  const cb = applyGiantTrees(b, mkLayouts(), SEED, reg, { allowedAt: () => false, ext: EXT });
  assertEqual(countIds(b, GIANT_IDS), 0, '不允许 → 零巨树方块');
  assertFalse(cb.covers(8, 8), '不允许 → 不覆盖（旧树照常生成）');
});
```

在 `src/tests/index.html` 里，`import './test-giant-trees.js';` 之后加一行：

```html
    import './test-giant-trees-column.js';
```

- [ ] **Step 2: 验证 RED**

Run: `node tests/tmp-unit.mjs`

Expected（整页失败：第一部分还没有 column 层的导出）：

```text
✗ 整页失败：window.__MC_TEST_RESULTS__ 未出现（静态 import 缺导出 / 模块 404 / 语法错 → 所有套件一起失去结果）
    pageerror: The requested module '../gen/structures/giant-trees.js' does not provide an export named 'applyGiantTrees'
```

- [ ] **Step 3: 写 column 层实现**

**(a)** 把 `src/gen/structures/giant-trees.js` 顶部的 import 块（第一部分只有这 4 行）：

```javascript
import { seededRandom, getBiome } from '../noise.js';
import { generateHeight } from '../terrain.js';
import { REGION_SIZE } from './region-config.js';
import { SEA_Y } from '../../voxel/constants.js';
```

替换为终态 import 块（新增 `makeColumnSetter`、`SCATTER_FOOTPRINT` / `CITY_STRUCTURE_FOOTPRINT`、`SCATTER_TYPES` / `SCATTER_STRIDE`）：

```javascript
import { seededRandom, getBiome } from '../noise.js';
import { generateHeight } from '../terrain.js';
import { makeColumnSetter } from './landmarks.js';
import { REGION_SIZE, SCATTER_FOOTPRINT, CITY_STRUCTURE_FOOTPRINT } from './region-config.js';
import { SCATTER_TYPES, SCATTER_STRIDE } from './scatter.js';
import { SEA_Y } from '../../voxel/constants.js';
```

**(b)** 在文件**末尾**（`treeBox` 之后）追加 column 层：

```javascript
// ---------------------------------------------------------------- column 层

/** 候选 → 树对象（含变体、朝向、世界 AABB）。族缺失（加载失败/族名未知）则跳过。 */
function resolveTree(path, arr, i, seed, families) {
  const list = families[GIANT_FAMILY_ORDER[arr[i + 3]]];
  if (!list || list.length === 0) return null;
  const variant = list[arr[i + 4] % list.length];
  const wx = arr[i], wy = arr[i + 1], wz = arr[i + 2];
  const rot = giantTreeRotation(wx, wz, seed);
  return { path, wx, wy, wz, variant, rot, ...treeBox(variant, rot, wx, wz) };
}

/**
 * 收集与窗口 [wx0-ext, wx1+ext]×[wz0-ext, wz1+ext] 相交的树（AABB 外扩 ext 后相交即收），
 * 合并**全部**邻域 layouts（拼接而非覆盖），并按 (路径序, wx, wz) 排成**规范顺序** ——
 * 逐格「后写胜」的结果因此与 layouts 的下发顺序无关。
 * @param {Array<Object>} layouts 查询域内 region 布局（每项可带 giantTrees）
 * @param {{minX:number,maxX:number,minZ:number,maxZ:number}} win
 */
export function collectGiantTrees(layouts, seed, families, win, ext, paths = GIANT_TREE_PATHS) {
  const trees = [];
  paths.forEach((p, pathIdx) => {
    for (const layout of layouts) {
      const arr = layout.giantTrees && layout.giantTrees[p.key];
      if (!arr || arr.length === 0) continue;
      for (let i = 0; i < arr.length; i += GIANT_STRIDE) {
        // 廉价预筛：最大树宽 17、锚点偏移 ≤ 2 → 候选点离窗口超过 24 格的不可能相交
        if (arr[i] < win.minX - 24 || arr[i] > win.maxX + 24 || arr[i + 2] < win.minZ - 24 || arr[i + 2] > win.maxZ + 24) continue;
        const t = resolveTree(p.key, arr, i, seed, families);
        if (!t) continue;
        if (t.x1 + ext < win.minX || t.x0 - ext > win.maxX || t.z1 + ext < win.minZ || t.z0 - ext > win.maxZ) continue;
        t.pathIdx = pathIdx;
        trees.push(t);
      }
    }
  });
  trees.sort((a, b) => a.pathIdx - b.pathIdx || a.wx - b.wx || a.wz - b.wz);
  return trees;
}

/**
 * 「树要让路」的既有结构外包盒（排除用）：
 *   ① 城外撒布结构（house / flowerBed / tallWell / 沙漠结构 / 沉船…）：SCATTER_FOOTPRINT 的 halfX/halfZ，外扩 1；
 *      城内撒布不用算（城市 bounds 已由 allowedAt 的 pointContext 挡掉）。
 *   ② 平地金字塔岛（layout.plainLand）与海岛塔（layout.island）的 **JSON 结构占地**，外扩 2（= apply.js 的 INTERSECT_MARGIN）。
 *      ⚠️ 不能只靠 pointContext：平地沙台的 getPlainLandInfo 只有 ±15，而 pyramid_island.json 占地 34×39
 *      （halfX 17 / halfZ 20）比沙台大 2~5 格 —— 只用 pointContext 时，既有的 pyramidIsland 用例会被树干覆盖（实测）。
 * 只留与窗口内的树可能相交的（树最大外延 24 + ext）。
 */
export function collectExclusionBoxes(layouts, win, ext) {
  const boxes = [];
  const push = (cx, cz, halfX, halfZ, margin) => {
    const b = { x0: cx - halfX - margin, x1: cx + halfX + margin, z0: cz - halfZ - margin, z1: cz + halfZ + margin };
    if (b.x1 < win.minX - 24 - ext || b.x0 > win.maxX + 24 + ext || b.z1 < win.minZ - 24 - ext || b.z0 > win.maxZ + 24 + ext) return;
    boxes.push(b);
  };
  for (const layout of layouts) {
    const arr = layout.scatter && layout.scatter.outsideScatter;
    if (arr) {
      for (let i = 0; i < arr.length; i += SCATTER_STRIDE) {
        const fp = SCATTER_FOOTPRINT[SCATTER_TYPES[arr[i + 3]]];
        if (fp) push(arr[i], arr[i + 2], fp.halfX, fp.halfZ, 1);
      }
    }
    if (layout.plainLand) push(layout.plainLand.cx, layout.plainLand.cz, CITY_STRUCTURE_FOOTPRINT.pyramidIsland.halfX, CITY_STRUCTURE_FOOTPRINT.pyramidIsland.halfZ, 2);
    if (layout.island) push(layout.island.cx, layout.island.cz, CITY_STRUCTURE_FOOTPRINT.tower.halfX, CITY_STRUCTURE_FOOTPRINT.tower.halfZ, 2);
  }
  return boxes;
}

/**
 * 排除判定（纯函数，对「覆盖这棵树的任一 column」结论恒一致 —— 它只依赖树本身与邻域 layouts，
 * 而任何与树 AABB 相交的 column 的 3×3 查询域都含该树所在 region 及其朝向该 column 一侧的邻居）：
 *   ① AABB 九点（四角 + 四边中点 + 中心）与锚点：allowedAt 必须全真
 *      （allowedAt 由 apply.js 用 pointContext 构造：只允许 'normal' / 'water'，
 *       即排除城市、金字塔、平地岛、海岛、雪原、冰封山）；
 *   ② 不与任何既有结构外包盒相交（撒布结构 / 平地金字塔岛 / 海岛塔：是既有内容，树让路；见 collectExclusionBoxes）。
 */
export function isGiantTreeAllowed(t, allowedAt, exclusionBoxes) {
  const mx = (t.x0 + t.x1) >> 1, mz = (t.z0 + t.z1) >> 1;
  const xs = [t.x0, mx, t.x1], zs = [t.z0, mz, t.z1];
  for (const x of xs) for (const z of zs) if (!allowedAt(x, z)) return false;
  if (!allowedAt(t.wx, t.wz)) return false;
  for (const b of exclusionBoxes) {
    if (!(t.x1 < b.x0 || t.x0 > b.x1 || t.z1 < b.z0 || t.z0 > b.z1)) return false;
  }
  return true;
}

/**
 * 把一棵树写进 column（setBlock 自带 column 裁剪）+ 地基填充。
 * 地基：gy=0 层的树干格（palette[0]）下方若悬空（地表 h < wy-1），用同种树干向下补到 h+1（≤ GIANT_SUPPORT_MAX 格）。
 * 对应既有 GROUND_SUPPORT_TYPES 机制（structure-json.js）的同一语义；这里直接用 generateHeight
 * （纯函数、跨 column 一致），不探 column 内容 —— 探测在 column 边缘取不到邻列数据。
 */
export function rasterizeGiantTree(setBlock, t, seed) {
  const v = t.variant, cells = v.cells, pal = v.palette;
  for (let k = 0; k < cells.length; k += 4) {
    const [rx, rz] = rotateCell(v, t.rot, cells[k], cells[k + 2]);
    const name = pal[cells[k + 3]];
    setBlock(t.x0 + rx, t.wy + cells[k + 1], t.z0 + rz, name);
    if (cells[k + 1] === 0 && cells[k + 3] === 0) {
      const wx = t.x0 + rx, wz = t.z0 + rz;
      const depth = (t.wy - 1) - generateHeight(wx, wz, seed);
      if (depth >= 1 && depth <= GIANT_SUPPORT_MAX) {
        for (let y = t.wy - 1; y > t.wy - 1 - depth; y--) setBlock(wx, y, wz, name);
      }
    }
  }
}

/**
 * 覆盖窗口：column 外扩 ext 的 (16+2ext)² 位图。树的**覆盖区 = AABB 外扩 ext**（旧植被树冠半径 ≤ ext，
 * 树干落在覆盖区内的旧树，其树冠才可能碰到巨树 AABB）。`covers(wx,wz)` 对窗口外恒 false。
 * ⚠️ 只在本 column 内标记不够：阶段 3 的植被扫描会外扩 ext 格，column 外 3 格带里的旧树树干
 * 会把树冠写进本 column（实测每 256 个 column 游离出 5,332 格没有树干的旧树冠）。
 */
export function buildCoveredWindow(column, trees, ext) {
  const W = 16 + 2 * ext;
  const minX = column.cx * 16 - ext, minZ = column.cz * 16 - ext;
  const cov = new Uint8Array(W * W);
  for (const t of trees) {
    const xa = Math.max(t.x0 - ext, minX), xb = Math.min(t.x1 + ext, minX + W - 1);
    const za = Math.max(t.z0 - ext, minZ), zb = Math.min(t.z1 + ext, minZ + W - 1);
    for (let x = xa; x <= xb; x++) for (let z = za; z <= zb; z++) cov[(x - minX) + (z - minZ) * W] = 1;
  }
  return { covers: (wx, wz) => { const lx = wx - minX, lz = wz - minZ; return lx >= 0 && lz >= 0 && lx < W && lz < W && cov[lx + lz * W] === 1; } };
}

const NO_COVER = Object.freeze({ covers: () => false });

/**
 * column 层入口。
 * @param {import('../../voxel/chunk-column.js').ChunkColumn} column
 * @param {Array<Object>} layouts 查询域内 region 布局
 * @param {number} seed
 * @param {*} registry
 * @param {{allowedAt: (wx:number, wz:number) => boolean, ext: number}} ctx
 *   allowedAt：由 apply.js 用 pointContext 构造；ext：植被扫描外扩（apply.js 的 VEGETATION_EXT）
 * @returns {{covers: (wx:number, wz:number) => boolean}} 旧植被抑制覆盖窗口
 */
export function applyGiantTrees(column, layouts, seed, registry, ctx) {
  const data = getGiantTreesSync();
  if (!data) return NO_COVER;
  const win = { minX: column.cx * 16, maxX: column.cx * 16 + 15, minZ: column.cz * 16, maxZ: column.cz * 16 + 15 };
  const candidates = collectGiantTrees(layouts, seed, data.families, win, ctx.ext);
  if (candidates.length === 0) return NO_COVER;
  const exclusionBoxes = collectExclusionBoxes(layouts, win, ctx.ext);
  const accepted = candidates.filter((t) => isGiantTreeAllowed(t, ctx.allowedAt, exclusionBoxes));
  if (accepted.length === 0) return NO_COVER;
  const setBlock = makeColumnSetter(column, registry);
  for (const t of accepted) {
    if (t.x1 < win.minX || t.x0 > win.maxX || t.z1 < win.minZ || t.z0 > win.maxZ) continue; // 只覆盖区相交、本列无方块
    rasterizeGiantTree(setBlock, t, seed);
  }
  return buildCoveredWindow(column, accepted, ctx.ext);
}
```

- [ ] **Step 4: 验证 GREEN**

Run: `node tests/tmp-unit.mjs`

Expected：`harness: passed=801 failed=0 total=801`（794 + 7）。

- [ ] **Step 5: 负向验证 —— 6 类缺陷注入后必须真红**

| # | 临时改动（`src/gen/structures/giant-trees.js`） | 变红的用例（实测，恰好 1 条） |
|---|---|---|
| ① | `collectGiantTrees` 里 `for (const layout of layouts)` 改成 `for (const layout of layouts.slice(-1))`（只用最后一个 layout = 覆盖赋值的效果） | `collectGiantTrees：合并全部邻域 layouts（拼接而非覆盖）+ 规范顺序（与 layouts 下发顺序无关）` |
| ⑦ | 删掉 `trees.sort((a, b) => a.pathIdx - b.pathIdx \|\| a.wx - b.wx \|\| a.wz - b.wz);` | 同上（该用例同时钉「拼接」与「规范顺序」） |
| ⑧ | `rasterizeGiantTree` 里 `if (depth >= 1 && depth <= GIANT_SUPPORT_MAX) {` 改成 `if (false && …) {`（去掉地基填充） | `地基：gy=0 树干格下方悬空 1~MAX 格时补同种树干；悬空 > MAX 不补` |
| ⑨ | `buildCoveredWindow` 里 `t.x0 - ext` / `t.x1 + ext` / `t.z0 - ext` / `t.z1 + ext` 去掉 `- ext` / `+ ext`（只覆盖 AABB） | `覆盖窗口：AABB 外扩 EXT；column 外 EXT 格带内也覆盖；窗口外恒 false` |
| ⑩ | `isGiantTreeAllowed` 里 `for (const b of exclusionBoxes) {` 改成 `for (const b of []) {` | `isGiantTreeAllowed：九点/锚点任一不允许即拒；撒布外包盒相交即拒` |
| ⑪ | `collectExclusionBoxes` 里 `if (layout.plainLand) push(` 改成 `if (false && layout.plainLand) push(` | `collectExclusionBoxes：撒布 +1、平地金字塔岛 JSON 占地（halfX17/halfZ20）+2、海岛塔 +2；窗口外的不收` |

> Review Focus ①②（跨 column 接缝 / 非正方形旋转）由用例「跨 column 光栅化：4 个朝向 × 含非正方形变体，2×2 个 column 逐格 == 期望（双向：无缺格、无多格）」钉住：锚点放在 4 个 column 的交点，把期望格独立展开后与写入结果逐格双向比对，并断言「树的全部格都在这 4 个 column 内」防恒真。Task 4 的注入 ⑥（`treeBox` 用未旋转 footprint）在 Task 6 之后还会让两条真实 GEN 用例同时变红。

- [ ] **Step 6: 静态门**

Run: `npm run check`

Expected：`[check:arch] 扫描 104 个源文件` + `✓ 架构红线全部守住`；`[测试注册] 48 个测试文件全部已注册`；`✓ 数据契约全部一致`；lint `0 errors, 15 warnings`。

- [ ] **Step 7: 提交**（仅在用户明确要求提交时）

```bash
git add src/gen/structures/giant-trees.js src/tests/test-giant-trees-column.js src/tests/index.html
git commit -m "feat(giant-trees): column 层（邻域拼接/排除/跨 column 光栅化/地基/覆盖窗口）"
```

---

## Task 6: 接线 —— layout 字段 / apply 阶段 2.8 + 阶段 3 / Worker 预热（TDD）

**Files:**
- Create: `src/tests/test-giant-trees-gen.js`（9 条，**真实 layout + 真实 GEN 路径**）
- Modify: `src/gen/structures/structure-layout.js`（`computeRegionLayout` 返回 `giantTrees`）
- Modify: `src/gen/structures/apply.js`（`giantAllowedAtFor` / `VEGETATION_EXT` / 阶段 2.8 / 阶段 3 三处）
- Modify: `src/workers/world-worker.js`（模块加载期预热 `trees.json`）
- Modify: `src/tests/index.html`（注册）

**Interfaces:**
- Consumes：Task 4 / 5 的全部导出。
- Produces：`computeRegionLayout()` 的返回值多一个 `giantTrees: { forest, beach, banyan }`（三个 `Int32Array`，stride 5）；`apply.js` 新导出 `giantAllowedAtFor(layouts, cityLayout, seed) → (wx, wz) => boolean`（测试复用同一份判据，红线 1）。

**设计要点**（spec §3.5 / §3.8）：

1. **候选不需要 `city`**：城市让路在 apply 层做。v1.0 的 `computeGiantTreeCandidates(…, city)` 在非 (0,0) region 里 `city` 恒为 null，等于没有城市门控（实测 3×3 region 里 325/2013 = 16% 的树进城）。
2. **阶段 2.8 的位置**：在阶段 2.5（空中结构）之前、阶段 3（植被）之前；它返回的覆盖窗口只给阶段 3 用。`allowedAt` 由 `pointContext` 构造：只允许 `normal` / `water`，排除 `city` / `none`（金字塔、平地岛）/ `island` / `snow` / `fm`。
3. **`VEGETATION_EXT = 3` 是阶段 3 植被扫描外扩与阶段 2.8 覆盖窗口的同一个常量**（替换阶段 3 里原来的局部 `const EXT = 3`）：各写一份会漂移出「旧树冠游离在巨树边缘」。
4. **阶段 3 的三处改动**：① `const inGiant = giant.covers(wx, wz)`；② 单格植物写在 `h+1`，正是巨树 `gy=0` 层——覆盖区内**目标格已非空气**（树干底格 / 贴地叶）则不写（实测 31 格/256 个 column 被顶掉，含 23 格树干，单树干的树因此悬空）；目标格是空气（树冠下方的空地）照常生成。⚠️ **不能**写成「覆盖区内一律不生成植物」——会让既有 PLAINS 植被用例（固定坐标采样）变红，也无必要。③ `if (tree && !inGiant)`：覆盖区内旧森林树不再生成（替换语义）。
5. **`await loadGiantTrees()`** 加在 `applyStructuresToColumn` 的 `preloadStructures` 之后：缓存命中 ≈ 0ms；主线程单测环境也靠它。
6. **Worker 预热**（`giantPreloadPromise`）：不预热则每个 Worker 的首个 GEN 付 fetch + 解析，`structure-gen` fixture 的含结构 genP95 实测 8.1~9.8 → 11.6~14.0（负载下；安静系统交替对照 7.6~8.2 → 9.4~10.0，一次撞 10ms 门）。手法照抄该文件已有的 `scatterPreloadPromise`：模块加载期发起、**不 await**；`layout` 与 `gen` 入口 `await` 同一个 promise。⚠️ **不能写成 top-level await**（早到的 RPC 会被丢弃，首个 `layout` 死锁，见该文件头注释）。
7. **浏览器内单测测不到 Worker 接线**（单测直接调纯函数）。Worker 里「真的消费了 layout 里的 `giantTrees`」由 Task 8 的 Tier 4 spec 在真游戏页（Worker GEN）兜住——Task 8 负向验证里的注入 D（layout 不带 `giantTrees`）就是这条。

---

- [ ] **Step 1: 写测试（RED 的来源）**

```javascript
// src/tests/test-giant-trees-gen.js — 巨树景观 Tier 1：接线与真实 GEN（layout 字段 / 让路 / 旧植被互斥 / 植物规则 / 确定性）
//
// 全部走真实 layout + 真实 GEN 路径（fillColumn → applyStructuresToColumn），不靠合成捷径。
// 钉的缺陷：城市 / 地标 / 撒布结构让路（原设计 16% 的树进城、12.4% 压地标、9.4% 压撒布结构）；
//   单格植物不得顶掉树干底格；GEN 侧「拼接合并」没接线时森林 column 里几乎没有巨树。
// 每条「零闯入」断言都带「不排除时确有树会闯入」的对照（防恒真）。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertNotNull } from './assert.js';
import {
  GIANT_STRIDE, loadGiantTrees, rotateCell, collectGiantTrees, collectExclusionBoxes, isGiantTreeAllowed,
} from '../gen/structures/giant-trees.js';
import { computeRegionLayout, neighborRegionKeys } from '../gen/structures/structure-layout.js';
import { applyStructuresToColumn, giantAllowedAtFor } from '../gen/structures/apply.js';
import { fillColumn, generateHeight } from '../gen/terrain.js';
import { getBiome } from '../gen/noise.js';
import { rollVegetation } from '../gen/structures/vegetation.js';
import { getCityInfo } from '../gen/structures/city-layout.js';
import {
  getPyramidInfo, getIslandInfo, getPlainLandInfo, getSnowLandInfo, getFrozenMountainInfo,
} from '../gen/structures/landmarks.js';
import { SCATTER_TYPES, SCATTER_STRIDE } from '../gen/structures/scatter.js';
import { SCATTER_FOOTPRINT, CITY_STRUCTURE_FOOTPRINT, REGION_SIZE } from '../gen/structures/region-config.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { blockIndex, SEA_Y, WORLD_MIN_Y, WORLD_MAX_Y } from '../voxel/constants.js';

const SEED = 12345;
const EXT = 3; // 与 apply.js 的 VEGETATION_EXT 同值（植被树冠半径 ≤ 3）

function makeRegistry() {
  const r = createRegistry();
  for (const def of BLOCKS) r.register(def.name, def);
  r.freeze();
  return r;
}
const reg = makeRegistry();
const GIANT_IDS = new Set(BLOCKS.filter((b) => b.name.startsWith('giant_')).map((b) => reg.idOf(b.name)));
const OLD_TREE_IDS = new Set(['wood', 'birch_log', 'leaves', 'yellow_leaves'].map((n) => reg.idOf(n)));

const layoutCache = new Map();
function layoutOf(rx, rz) {
  const k = `${rx},${rz}`;
  if (!layoutCache.has(k)) layoutCache.set(k, computeRegionLayout(rx, rz, SEED));
  return layoutCache.get(k);
}
const layoutsForColumn = (cx, cz) => neighborRegionKeys(cx, cz).map((k) => layoutOf(...k.split(',').map(Number)));
const cityLayout = layoutOf(0, 0).city;

/** 真实 GEN 路径（与 world-worker 的 gen 一致：fillColumn → applyStructuresToColumn） */
async function genColumn(cx, cz, layouts = layoutsForColumn(cx, cz)) {
  const c = new ChunkColumn(cx, cz);
  fillColumn(c, SEED, reg);
  await applyStructuresToColumn(c, SEED, reg, layouts);
  return c;
}
const stripGiants = (layouts) => layouts.map((l) => ({ ...l, giantTrees: null }));
function countIds(col, ids) { let n = 0; for (let i = 0; i < col.blocks.length; i++) if (ids.has(col.blocks[i])) n++; return n; }

test('layout 带 giantTrees 字段：三个 Int32Array，长度是 stride 的倍数', () => {
  for (const [rx, rz] of [[0, 0], [1, 1], [-1, 0]]) {
    const g = layoutOf(rx, rz).giantTrees;
    assertNotNull(g, `region(${rx},${rz}) 有 giantTrees`);
    for (const k of ['forest', 'beach', 'banyan']) {
      assertTrue(g[k] instanceof Int32Array, `${k} 是 Int32Array`);
      assertEqual(g[k].length % GIANT_STRIDE, 0, `${k} 长度是 stride 的倍数`);
    }
  }
});

/** region(-1,0) 内 column 的扫描域：cx ∈ [-25,-1]、cz ∈ [0,24]（森林为主，实测每 column 含巨树的比例很高） */
function forestScanColumns(limit) {
  const out = [];
  for (let cx = -25; cx <= -1 && out.length < limit; cx += 2) for (let cz = 0; cz <= 24 && out.length < limit; cz += 2) out.push([cx, cz]);
  return out;
}

/** accepted 里的树落在本 column 内的格数（与 rasterizeGiantTree 的写入同一展开；地基填充的格都在 gy=0 底格同 column，不另算） */
function expectedCellsInColumn(accepted, cx, cz) {
  let n = 0;
  for (const t of accepted) {
    const v = t.variant;
    for (let k = 0; k < v.cells.length; k += 4) {
      const [rx, rz] = rotateCell(v, t.rot, v.cells[k], v.cells[k + 2]);
      const x = t.x0 + rx, z = t.z0 + rz, y = t.wy + v.cells[k + 1];
      if (x >= cx * 16 && x < cx * 16 + 16 && z >= cz * 16 && z < cz * 16 + 16 && y >= WORLD_MIN_Y && y < WORLD_MAX_Y) n++;
    }
  }
  return n;
}

test('真实 GEN：column 里有无巨树方块 ⇔ 生产判据下期望有无（拼接合并 + 排除接线回归）', async () => {
  const families = (await loadGiantTrees()).families;
  let expectedWith = 0, disagree = 0;
  for (const [cx, cz] of forestScanColumns(150)) {
    const layouts = layoutsForColumn(cx, cz);
    const win = { minX: cx * 16, maxX: cx * 16 + 15, minZ: cz * 16, maxZ: cz * 16 + 15 };
    const allowedAt = giantAllowedAtFor(layouts, cityLayout, SEED);
    const boxes = collectExclusionBoxes(layouts, win, EXT);
    const accepted = collectGiantTrees(layouts, SEED, families, win, EXT).filter((t) => isGiantTreeAllowed(t, allowedAt, boxes));
    const expected = expectedCellsInColumn(accepted, cx, cz) > 0;
    const has = countIds(await genColumn(cx, cz, layouts), GIANT_IDS) > 0;
    if (expected) expectedWith++;
    if (expected !== has) disagree++;
  }
  assertTrue(expectedWith >= 20, `扫描域内期望含巨树的 column ≥ 20（对照，防恒真；实测 ~60）：${expectedWith}`);
  assertEqual(disagree, 0, '期望与实际逐 column 一致');
});

test('真实 GEN：森林 column 里确有巨树方块（覆盖赋值的回归：原写法 625 个 column 只会出 1 棵）', async () => {
  let found = 0, tested = 0;
  for (const [cx, cz] of forestScanColumns(200)) {
    const col = await genColumn(cx, cz); tested++;
    if (countIds(col, GIANT_IDS) > 0) found++;
  }
  assertTrue(found >= 20, `测得 ${tested} 个森林 column，含巨树的 ${found} 个（≥ 20；实测 ~60）`);
});

test('真实 GEN：城市 bounds 内零巨树方块（Review Focus ⑤；原设计 16% 的树进城）', async () => {
  const { minX, maxX, minZ, maxZ } = cityLayout; let total = 0, inside = 0;
  // 城市外环带：与「城市 bounds 外扩 24」相交、且靠近边界线的 column
  for (let cx = Math.floor((minX - 24) / 16); cx <= Math.floor((maxX + 24) / 16); cx++) {
    for (let cz = Math.floor((minZ - 24) / 16); cz <= Math.floor((maxZ + 24) / 16); cz++) {
      const x0 = cx * 16, z0 = cz * 16;
      const deep = x0 > minX + 24 && x0 + 15 < maxX - 24 && z0 > minZ + 24 && z0 + 15 < maxZ - 24; // 城内深处：整列都在城里，跳过
      if (deep) continue;
      const col = await genColumn(cx, cz);
      for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
        let g = 0;
        for (let y = WORLD_MIN_Y; y < WORLD_MAX_Y; y++) if (GIANT_IDS.has(col.blocks[blockIndex(lx, y, lz)])) g++;
        if (g === 0) continue;
        total += g;
        if (getCityInfo(x0 + lx, z0 + lz, cityLayout)) inside += g;
      }
    }
  }
  assertTrue(total > 0, `城外环带里有巨树方块（对照，防恒真）：${total}`);
  assertEqual(inside, 0, '城市 bounds 内不得有巨树方块');
});

test('真实 GEN：撒布结构 footprint 内零巨树方块（树让路；原设计 9.4% 的树压撒布结构）', async () => {
  const colCache = new Map();
  const colOf = async (cx, cz) => { const k = `${cx},${cz}`; if (!colCache.has(k)) colCache.set(k, await genColumn(cx, cz)); return colCache.get(k); };
  let structures = 0, violations = 0;
  const arr = layoutOf(-1, 0).scatter.outsideScatter;
  for (let i = 0; i < arr.length; i += SCATTER_STRIDE) {
    const fp = SCATTER_FOOTPRINT[SCATTER_TYPES[arr[i + 3]]]; if (!fp) continue;
    const [sx, sz] = [arr[i], arr[i + 2]];
    if (sx < -380 || sx > -20 || sz < 20 || sz > 380) continue; // 远离 region 边界，邻域 layout 齐全
    structures++;
    for (let x = sx - fp.halfX; x <= sx + fp.halfX; x++) for (let z = sz - fp.halfZ; z <= sz + fp.halfZ; z++) {
      const col = await colOf(Math.floor(x / 16), Math.floor(z / 16));
      const lx = x - col.cx * 16, lz = z - col.cz * 16;
      for (let y = WORLD_MIN_Y; y < WORLD_MAX_Y; y++) if (GIANT_IDS.has(col.blocks[blockIndex(lx, y, lz)])) violations++;
    }
  }
  assertTrue(structures >= 5, `region(-1,0) 内有足够多的撒布结构可测（对照）：${structures}`);
  assertEqual(violations, 0, '撒布结构 footprint 内不得有巨树方块');
});

test('真实 GEN：金字塔 / 平地岛 / 海岛 / 雪原 / 冰封山的地标范围内零巨树方块（对照：不排除时确有树会闯入）', async () => {
  // 在 region [-6,6]² 里取地标实例（独立于 pointContext：直接用 landmarks.js 的 getXxxInfo 判范围）。
  // 小地标（平地岛 / 海岛）取全部实例 —— 只取第一个会因种子巧合漏掉「树恰好只擦到 JSON 占地」的情形；
  // 大地标（金字塔 / 雪原 / 冰封山）各取第一个（冰封山单个就要扫 ~80 个 column）。
  const inst = { pyramid: [], island: [], plainLand: [], snowLand: [], frozenMountain: [] };
  for (let rx = -6; rx <= 6; rx++) for (let rz = -6; rz <= 6; rz++) {
    const l = layoutOf(rx, rz);
    if (!inst.pyramid.length) inst.pyramid.push({ l, c: [l.pyramid.cx, l.pyramid.cz], r: 60 });
    if (l.island) inst.island.push({ l, c: [l.island.cx, l.island.cz], r: 60 });
    if (l.plainLand) inst.plainLand.push({ l, c: [l.plainLand.cx, l.plainLand.cz], r: 30 });
    if (!inst.snowLand.length) inst.snowLand.push({ l, c: [l.snowLand.cx, l.snowLand.cz], r: 60 });
    if (!inst.frozenMountain.length) inst.frozenMountain.push({ l, c: [l.frozenMountain.cx, l.frozenMountain.cz], r: 110 });
  }
  const kinds = ['pyramid', 'island', 'plainLand', 'snowLand', 'frozenMountain'];
  const families = (await loadGiantTrees()).families;
  for (const k of kinds) assertTrue(inst[k].length > 0, `找到 ${k} 实例`);
  const inLandmark = (k, l, x, z) => ({
    pyramid: () => getPyramidInfo(x, z, l.pyramid), island: () => getIslandInfo(x, z, l.island, SEED),
    // 平地岛：沙台（±15）∪ pyramid_island.json 的占地（halfX17/halfZ20，比沙台大）—— 后者 pointContext 覆盖不到
    plainLand: () => getPlainLandInfo(x, z, l.plainLand) ||
      (Math.abs(x - l.plainLand.cx) <= CITY_STRUCTURE_FOOTPRINT.pyramidIsland.halfX && Math.abs(z - l.plainLand.cz) <= CITY_STRUCTURE_FOOTPRINT.pyramidIsland.halfZ),
    snowLand: () => getSnowLandInfo(x, z, l.snowLand, SEED),
    frozenMountain: () => getFrozenMountainInfo(x, z, l.frozenMountain, SEED),
  })[k]();
  let intruders = 0, violations = 0, scannedCells = 0;
  for (const k of kinds) for (const { l, c, r } of inst[k]) {
    for (let cx = Math.floor((c[0] - r) / 16); cx <= Math.floor((c[0] + r) / 16); cx++) {
      for (let cz = Math.floor((c[1] - r) / 16); cz <= Math.floor((c[1] + r) / 16); cz++) {
        const layouts = layoutsForColumn(cx, cz);
        const col = await genColumn(cx, cz, layouts);
        // 对照：不做任何排除时，会闯入该地标范围的树（用 allowedAt 全真 + 无外包盒收集，再按地标范围判）
        const win = { minX: cx * 16, maxX: cx * 16 + 15, minZ: cz * 16, maxZ: cz * 16 + 15 };
        for (const t of collectGiantTrees(layouts, SEED, families, win, 0)) {
          const mx = (t.x0 + t.x1) >> 1, mz = (t.z0 + t.z1) >> 1;
          if ([[t.x0, t.z0], [t.x1, t.z1], [mx, mz], [t.wx, t.wz]].some(([x, z]) => inLandmark(k, l, x, z))) intruders++;
        }
        for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
          if (!inLandmark(k, l, cx * 16 + lx, cz * 16 + lz)) continue;
          scannedCells++;
          for (let y = WORLD_MIN_Y; y < WORLD_MAX_Y; y++) if (GIANT_IDS.has(col.blocks[blockIndex(lx, y, lz)])) violations++;
        }
      }
    }
  }
  assertTrue(scannedCells > 5000, `扫描到足够多的地标格（对照）：${scannedCells}`);
  assertTrue(intruders > 0, `对照：不排除时确有树会闯入地标范围（${intruders}）—— 否则本用例无判别力`);
  assertEqual(violations, 0, '地标范围内不得有巨树方块');
});

test('真实 GEN：巨树覆盖区内零旧植被树方块，且基线（无巨树）里同位置确有旧树（互斥生效，带对照）', async () => {
  let baselineOld = 0, giantOld = 0, colsChecked = 0;
  for (const [cx, cz] of forestScanColumns(120)) {
    const layouts = layoutsForColumn(cx, cz);
    const col = await genColumn(cx, cz, layouts);
    if (countIds(col, GIANT_IDS) === 0) continue;
    colsChecked++;
    const base = await genColumn(cx, cz, stripGiants(layouts));
    for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
      let hasGiant = false;
      for (let y = WORLD_MIN_Y; y < WORLD_MAX_Y && !hasGiant; y++) hasGiant = GIANT_IDS.has(col.blocks[blockIndex(lx, y, lz)]);
      if (!hasGiant) continue;
      for (let y = WORLD_MIN_Y; y < WORLD_MAX_Y; y++) {
        if (OLD_TREE_IDS.has(base.blocks[blockIndex(lx, y, lz)])) baselineOld++;
        if (OLD_TREE_IDS.has(col.blocks[blockIndex(lx, y, lz)])) giantOld++;
      }
    }
  }
  assertTrue(colsChecked >= 10, `含巨树的 column ≥ 10：${colsChecked}`);
  assertTrue(baselineOld > 0, `对照：基线里巨树占地内有旧树方块（${baselineOld}），否则本用例无判别力`);
  assertEqual(giantOld, 0, '有巨树的列格上不得出现旧植被树方块');
});

test('真实 GEN：单格植物不顶掉巨树树干底格（植物判定命中的位置，底格仍是树干）', async () => {
  const families = (await loadGiantTrees()).families;
  const v = families.tallOak[0];
  const trunkId = reg.idOf(v.palette[0]);
  let tried = 0, checked = 0;
  // 在 region(-1,0) 森林里找一个「rollVegetation 会出植物」且在 column 内圈的点，放一棵合成树（锚点 = 该点）
  for (let wx = -300; wx < -100 && checked < 3; wx++) for (let wz = 100; wz < 300 && checked < 3; wz++) {
    const lx = ((wx % 16) + 16) % 16, lz = ((wz % 16) + 16) % 16;
    if (lx < 4 || lx > 11 || lz < 4 || lz > 11) continue;
    if (getBiome(wx, wz, SEED) !== 'FOREST') continue;
    const h = generateHeight(wx, wz, SEED); if (h <= SEA_Y) continue;
    if (!rollVegetation(wx, wz, 'FOREST', SEED).plant) continue;
    const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
    const base = layoutsForColumn(cx, cz);
    const synth = base.map((l) => ({ ...l, giantTrees: { forest: new Int32Array(0), beach: new Int32Array(0), banyan: new Int32Array(0) } }));
    const own = synth.findIndex((l) => l.regionX === Math.floor(wx / REGION_SIZE) && l.regionZ === Math.floor(wz / REGION_SIZE));
    synth[own].giantTrees.forest = Int32Array.from([wx, h + 1, wz, 0, 0]); // 族 0 = tallOak，hash 0 → 变体 0
    // 该合成树必须被 apply 层接受（否则无从断言）
    const win = { minX: cx * 16, maxX: cx * 16 + 15, minZ: cz * 16, maxZ: cz * 16 + 15 };
    const t = collectGiantTrees(synth, SEED, families, win, EXT)[0];
    if (!t || !isGiantTreeAllowed(t, giantAllowedAtFor(synth, cityLayout, SEED), collectExclusionBoxes(synth, win, EXT))) continue;
    tried++;
    const col = await genColumn(cx, cz, synth);
    assertEqual(col.blocks[blockIndex(wx - cx * 16, h + 1, wz - cz * 16)], trunkId, `(${wx},${wz}) 植物判定命中，但锚点底格必须仍是树干`);
    checked++;
  }
  assertTrue(checked >= 1, `至少核对 1 个「植物命中 + 合成树被接受」的位置（试了 ${tried}）`);
});

test('真实 GEN：确定性——同一 column 两次生成逐格一致', async () => {
  for (const [cx, cz] of [[-13, 12], [-20, 5]]) {
    const a = await genColumn(cx, cz), b = await genColumn(cx, cz);
    for (let i = 0; i < a.blocks.length; i++) { if (a.blocks[i] !== b.blocks[i]) { assertEqual(a.blocks[i], b.blocks[i], `column(${cx},${cz}) block ${i}`); break; } }
  }
});
```

在 `src/tests/index.html` 里，`import './test-giant-trees-column.js';` 之后加一行：

```html
    import './test-giant-trees-gen.js';
```

- [ ] **Step 2: 验证 RED**

Run: `node tests/tmp-unit.mjs`

Expected（整页失败：`apply.js` 还没有 `giantAllowedAtFor`）：

```text
✗ 整页失败：window.__MC_TEST_RESULTS__ 未出现（静态 import 缺导出 / 模块 404 / 语法错 → 所有套件一起失去结果）
    pageerror: The requested module '../gen/structures/apply.js' does not provide an export named 'giantAllowedAtFor'
```

- [ ] **Step 3: 接线 —— `structure-layout.js`**

```diff
diff --git a/src/gen/structures/structure-layout.js b/src/gen/structures/structure-layout.js
index bfd5bbd..ab2b46a 100644
--- a/src/gen/structures/structure-layout.js
+++ b/src/gen/structures/structure-layout.js
@@ -12,6 +12,7 @@ import {
 import { buildCityLayout } from './city-layout.js';
 import { computeSkyCandidates } from './sky-structures.js';
 import { computeScatterCandidates } from './scatter.js';
+import { computeGiantTreeCandidates } from './giant-trees.js';
 
 /**
  * 计算单个 region 的确定性布局（纯函数，无缓存——缓存由调用方 StructureIndex 管）。
@@ -24,7 +25,9 @@ import { computeScatterCandidates } from './scatter.js';
  *   plainLand: ({cx:number, cz:number, baseHeight:number}|null),
  *   island: ({cx:number, cz:number}|null),
  *   city: (Object|null),
- *   sky: {skyIslands: Int32Array, cloudClusters: Int32Array}
+ *   sky: {skyIslands: Int32Array, cloudClusters: Int32Array},
+ *   scatter: {cityScatter: Int32Array, outsideScatter: Int32Array},
+ *   giantTrees: {forest: Int32Array, beach: Int32Array, banyan: Int32Array}
  * }}
  */
 export function computeRegionLayout(regionX, regionZ, seed) {
@@ -57,9 +60,13 @@ export function computeRegionLayout(regionX, regionZ, seed) {
   // 城市候选只在持有 city 布局的 region 算（见 computeScatterCandidates 的口径差异①）。
   const scatter = computeScatterCandidates(regionX, regionZ, seed, city);
 
+  // 巨树候选（Giant Trees Epic）：全局对齐网格抖动，与 region 邻居无关（不需要 city）；
+  // 城市/地标/撒布的排除在 GEN 侧（apply.js 阶段 2.8）用邻域 layouts 判定。
+  const giantTrees = computeGiantTreeCandidates(regionX, regionZ, seed);
+
   return {
     regionX, regionZ, pyramidRaw, pyramid, frozenMountain, snowLand, plainLand,
-    island, city, sky, scatter,
+    island, city, sky, scatter, giantTrees,
   };
 }
```

- [ ] **Step 4: 接线 —— `apply.js`**

```diff
diff --git a/src/gen/structures/apply.js b/src/gen/structures/apply.js
index d302593..59c5a09 100644
--- a/src/gen/structures/apply.js
+++ b/src/gen/structures/apply.js
@@ -21,7 +21,8 @@ import {
   SCATTER_TYPES, SCATTER_STRIDE, CODE_GENERATED_SCATTER_TYPES,
   generateCodeHouse, generateCodeShip,
 } from './scatter.js';
-import { SEA_Y } from '../../voxel/constants.js';
+import { SEA_Y, blockIndex } from '../../voxel/constants.js';
+import { applyGiantTrees, loadGiantTrees } from './giant-trees.js';
 
 /** 城市 placement 用到的 JSON 结构（GEN 携带城市布局时预载）+ 植被树 JSON */
 const CITY_STRUCTURE_TYPES = [
@@ -42,6 +43,12 @@ const CODE_GENERATORS = Object.freeze({
   ship: generateCodeShip,
 });
 
+/**
+ * 植被扫描外扩（树冠半径 ≤ 3）。阶段 3 的扫描窗口与阶段 2.8 巨树的「旧植被覆盖窗口」共用这一个值
+ * （单一权威：两处各写一份会漂移出「旧树冠游离在巨树边缘」的缺陷）。
+ */
+const VEGETATION_EXT = 3;
+
 /** AABB 相交判定余量（JSON 实测占地与 footprint 表最大偏差 1 格） */
 const INTERSECT_MARGIN = 2;
 
@@ -90,6 +97,19 @@ function pointContext(wx, wz, layouts, cityLayout, seed) {
   return { kind: 'normal', biome, h };
 }
 
+/**
+ * 巨树的「允许落位」判定（阶段 2.8 用；导出供单测复用同一份判据 —— 红线 1）：
+ * 只允许 pointContext 为 normal / water 的点（water = 树冠悬在水面上）。其余 = 城市 / 金字塔 / 平地岛 /
+ * 海岛 / 雪原 / 冰封山（kind 为 city/none/island/snow/fm），树让路。
+ * @returns {(wx:number, wz:number) => boolean}
+ */
+export function giantAllowedAtFor(layouts, cityLayout, seed) {
+  return (wx, wz) => {
+    const kind = pointContext(wx, wz, layouts, cityLayout, seed).kind;
+    return kind === 'normal' || kind === 'water';
+  };
+}
+
 /**
  * 将布局覆盖本 column 的结构方块裁剪写入 column（生成路径：不记 edits、不 bump version）。
  * 异步：城市布局需预载建筑 JSON（Worker 内 fetch + 模块缓存）。
@@ -134,6 +154,10 @@ export async function applyStructuresToColumn(column, seed, registry, layouts) {
     }
   }
   await preloadStructures([...needTypes]);
+  // 巨树变体加载。Worker 里已在模块加载期预热（world-worker.js 的 giantPreloadPromise，layout 入口 await），
+  // 这里命中缓存 ≈ 0ms；⚠️ 不预热的话每个 Worker 的首个 GEN 要付 fetch+解析（实测使 structure-gen 的
+  // genP95 从 ~9ms 涨到 ~12ms，撞破 10ms 门）。fetch 失败不阻断 GEN（空 families → 本列无巨树）。
+  await loadGiantTrees();
 
   // ---- 阶段 1：地形整形（mc-lite 列循环 elif 链）----
   for (let lx = 0; lx < 16; lx++) {
@@ -252,6 +276,14 @@ export async function applyStructuresToColumn(column, seed, registry, layouts) {
     }
   }
 
+  // ---- 阶段 2.8：巨树景观（Giant Trees Epic）----
+  // 候选在 region 层算好（computeGiantTreeCandidates），这里：合并邻域候选 → 排除（地标/撒布/城市）→ 光栅化 →
+  // 返回覆盖窗口供阶段 3 抑制旧植被。排除只允许 pointContext 为 normal/water 的点（water = 树冠悬在水面上）。
+  const giant = applyGiantTrees(column, layouts, seed, registry, {
+    ext: VEGETATION_EXT,
+    allowedAt: giantAllowedAtFor(layouts, cityLayout, seed),
+  });
+
   // ---- 阶段 2.5：空中结构（M2-7：Y=55 单云 + 空岛，层序先云后岛；mc-lite 空中内容后写）----
   const skyCandidates = layouts.map((l) => l.sky).filter(Boolean);
   if (skyCandidates.length > 0) {
@@ -261,13 +293,15 @@ export async function applyStructuresToColumn(column, seed, registry, layouts) {
   // ---- 阶段 3：植被（M2-3，mc-lite 各分支植被规则）----
   // 树冠半径 ≤3：扫描扩展 3 格，树在基点光栅化（setBlock 自动裁剪到本 column）；
   // 单格植物只在本 column 内的点写入。
-  const EXT = 3;
+  const EXT = VEGETATION_EXT;
   const minX = column.cx * 16, maxX = column.cx * 16 + 15;
   const minZ = column.cz * 16, maxZ = column.cz * 16 + 15;
   for (let wx = minX - EXT; wx <= maxX + EXT; wx++) {
     for (let wz = minZ - EXT; wz <= maxZ + EXT; wz++) {
       const inColumn = wx >= minX && wx <= maxX && wz >= minZ && wz <= maxZ;
       const ctx = pointContext(wx, wz, layouts, cityLayout, seed);
+      // 巨树覆盖区内的旧植被树不再生成（替换语义）。覆盖窗口含 column 外 EXT 格带：带内旧树的树冠会写进本 column。
+      const inGiant = giant.covers(wx, wz);
 
       if (inColumn && ctx.kind === 'water' && ctx.biome === 'SWAMP' && seededRandom(wx, wz, seed + 12) < 0.08) {
         // 睡莲放在水面格的**上一格**（SEA_Y+1，原本是空气），不是 SEA_Y：
@@ -284,7 +318,12 @@ export async function applyStructuresToColumn(column, seed, registry, layouts) {
       let baseY = null;
       if (ctx.kind === 'normal') {
         const roll = rollVegetation(wx, wz, ctx.biome, seed);
-        if (inColumn && roll.plant) setBlock(wx, ctx.h + 1, wz, roll.plant);
+        // 单格植物：覆盖区内若目标格已被巨树方块占用（树干底格/贴地叶）则不覆盖 —— 否则单树干的树
+        // 会被一朵花顶掉唯一的底格而悬空。目标格是空气则照常生成（树下长草合理）。
+        if (inColumn && roll.plant &&
+            !(inGiant && column.blocks[blockIndex(wx - minX, ctx.h + 1, wz - minZ)] !== 0)) {
+          setBlock(wx, ctx.h + 1, wz, roll.plant);
+        }
         if (roll.tree) { tree = roll.tree; baseY = ctx.h + 1; }
       } else if (ctx.kind === 'city') {
         if (!isPointNearCityStructure(wx, wz, cityLayout, 2)) {
@@ -315,7 +354,7 @@ export async function applyStructuresToColumn(column, seed, registry, layouts) {
         }
       }
 
-      if (tree) {
+      if (tree && !inGiant) {
         if (tree.type === 'birchTree') {
           rasterizeStructure('birchTree', wx, baseY, wz, setBlock, column, registry, seed, false);
         } else if (tree.type === 'birchTreeWithSnow') {
```

- [ ] **Step 5: 接线 —— `world-worker.js`**

```diff
diff --git a/src/workers/world-worker.js b/src/workers/world-worker.js
index 3f89cba..81bd989 100644
--- a/src/workers/world-worker.js
+++ b/src/workers/world-worker.js
@@ -12,6 +12,7 @@ import { computeRegionLayout } from '../gen/structures/structure-layout.js';
 import { applyStructuresToColumn } from '../gen/structures/apply.js';
 import { preloadStructures } from '../gen/structures/structure-json.js';
 import { SCATTER_JSON_TYPES } from '../gen/structures/scatter.js';
+import { loadGiantTrees } from '../gen/structures/giant-trees.js';
 // M6 ai 分支：全部逻辑走 `computeAiUpdates`（同构纯函数，红线 8）。
 // 它内部 import `zombie-config.js` 的冻结玩法数据，故本文件不再直接 import ZOMBIE。
 import { computeAiUpdates } from '../entities/zombies/zombie-system.js';
@@ -46,6 +47,12 @@ registry.freeze();
  */
 const scatterPreloadPromise = preloadStructures(SCATTER_JSON_TYPES);
 
+/**
+ * 巨树变体预热（同手法：发起但不 await；layout 与 gen 入口 await 同一个 promise）。
+ * 实测不预热时每个 Worker 首个 GEN 要付 fetch+解析，`structure-gen` fixture 的 genP95 从 ~9ms 涨到 ~12ms。
+ */
+const giantPreloadPromise = loadGiantTrees();
+
 // atlasMeta 由主线程启动时 broadcast（'atlas-meta' handler 赋值）
 let _atlasMeta = null;
 
@@ -69,6 +76,7 @@ installRpcHandler({
     // （pool 按轮转分发，layout 覆盖不保证逐 worker）。此处 await 同一个预热 promise ——
     // 已 resolve 时是微任务（≈0 成本），未完成时才等剩余 fetch，确保 rasterize 不静默跳过。
     await scatterPreloadPromise.catch(() => {});
+    await giantPreloadPromise.catch(() => {});
     const column = new ChunkColumn(p.cx, p.cz);
     fillColumn(column, p.seed, registry);
     carveCaves(column, p.seed);
@@ -157,6 +165,7 @@ installRpcHandler({
     // GEN 计时路径不含冷 fetch 成本（确定性，不依赖时间差竞态；详见文件头预热注释）。
     // 预热失败不阻断 layout（结构 JSON 缺失会让 rasterize 静默跳过，但布局本身仍可用）。
     await scatterPreloadPromise.catch(() => {});
+    await giantPreloadPromise.catch(() => {});
     return computeRegionLayout(p.regionX, p.regionZ, p.seed);
   },
```

- [ ] **Step 6: 验证 GREEN**

Run: `node tests/tmp-unit.mjs`

Expected：`harness: passed=810 failed=0 total=810`（801 + 9；HEAD 基线 779 + 本 Epic 31）。`node tests/tmp-unit.mjs "真实 GEN"` 应列出 8 条以「真实 GEN：」开头的用例（外加既有的两条端到端）全部 ✓。

Run: `npx playwright test tests/structure-gen.spec.mjs tests/worker-gen.spec.mjs`

Expected：`2 passed`（`structure-gen` fixture 内含「含结构 16 column 并行 genP95 < 10ms」门；`worker-gen` 是纯地形门 8ms，不受影响）。

- [ ] **Step 7: 负向验证 —— 15 条缺陷注入，全部真红**

临时注入 → `node tests/tmp-unit.mjs` → 复原。**第 ⑩⑪⑫ 三条还会让既有用例变红**（`pyramidIsland：跨 column 完整光栅化（不被 chunk 切割）`、`城市过渡带树根贴地`）——它们是「让路」的回归门，**既有用例不得改动**。

| # | 临时改动 | 变红的用例（实测；总数 / 全部 810） |
|---|---|---|
| ① | `collectGiantTrees`：`for (const layout of layouts)` → `layouts.slice(-1)` | 7：`collectGiantTrees…` + `真实 GEN：⇔` + `森林 column 里确有巨树方块` + `城市 bounds 内零…` + `地标范围内零…` + `覆盖区内零旧植被树…` + `单格植物不顶掉树干底格` |
| ② | `giantTreeRotation` → `… & 3` | 1：`giantTreeRotation：四个朝向都会出现…` |
| ③ | 抖动 `* path.jitter` → `* C` | 1：`候选间距（含 region 边界）…` |
| ④ | 去掉 region 归属过滤 | 2：`候选间距…` + `候选 region 归属…` |
| ⑤ | 去掉 `chance` 判定行 | 1：`chance 是有效的密度旋钮…` |
| ⑥ | `treeBox` 用未旋转 footprint | 3：`treeBox：…` + `真实 GEN：⇔` + `地标范围内零…` |
| ⑦ | 去掉规范排序 | 1：`collectGiantTrees…` |
| ⑧ | 去掉地基填充 | 1：`地基：…` |
| ⑨ | `buildCoveredWindow` 不外扩 | 3：`覆盖窗口：…` + `真实 GEN：⇔` + `覆盖区内零旧植被树…` |
| ⑩ | `isGiantTreeAllowed`：`for (const b of exclusionBoxes)` → `for (const b of [])` | 4：`pyramidIsland：跨 column 完整光栅化…`(既有) + `isGiantTreeAllowed：…` + `撒布结构 footprint 内零…` + `地标范围内零…` |
| ⑪ | `collectExclusionBoxes` 去掉平地岛 / 海岛塔盒 | 3：`pyramidIsland：…`(既有) + `collectExclusionBoxes：…` + `地标范围内零…` |
| ⑫ | `giantAllowedAtFor` 恒返回 `true` | 3：`城市过渡带树根贴地`(既有) + `城市 bounds 内零…` + `地标范围内零…` |
| ⑬ | `apply.js` 传给 `applyGiantTrees` 的 `ext: VEGETATION_EXT` → `ext: 0` | 2：`真实 GEN：⇔` + `覆盖区内零旧植被树…` |
| ⑭ | 去掉阶段 3 的「目标格非空则不写」植物规则 | 1：`单格植物不顶掉树干底格…` |
| ⑮ | `if (tree && !inGiant)` → `if (tree)` | 2：`真实 GEN：⇔` + `覆盖区内零旧植被树…` |

> **几条「零闯入」断言各自带「不排除时确有树会闯入」的对照**（城外有树 / 地标对照 `intruders > 0` / 旧树基线 `baselineOld > 0`）：这是 testing-policy §2.7 的恒真陷阱——只断言「零」而不证明「本来会有」，注入后仍全绿。写这类断言前必须先在真实数据上跑一次、打印实际值。

- [ ] **Step 8: 静态门**

Run: `npm run check`

Expected：`[check:arch] 扫描 104 个源文件` + `✓ 架构红线全部守住`；`[测试注册] 49 个测试文件全部已注册`；`✓ 数据契约全部一致`；lint `0 errors, 15 warnings`。

- [ ] **Step 9: 提交**（仅在用户明确要求提交时）

```bash
git add src/gen/structures/structure-layout.js src/gen/structures/apply.js src/workers/world-worker.js \
        src/tests/test-giant-trees-gen.js src/tests/index.html
git commit -m "feat(giant-trees): 接线 layout/apply/Worker 预热，让路与旧植被互斥"
```

---

## Task 7: `check:data` 的 `[巨树]` 门禁

**Files:**
- Modify: `tools/check-data.mjs`（新增 `checkGiantTrees()` + 主流程里一行显式调用）

**Interfaces:**
- Consumes：`tools/giant-trees-fingerprint.mjs`（Task 1）、`BLOCKS` / `REGISTRY` / `HIDDEN_FROM_INVENTORY` / `FACES_DATA`（`check-data.mjs` 既有的导入）、`pngjs`。
- Produces：`npm run check:data` 多一行 `[巨树] …`；任一契约不满足即退出码 1。

**钉的 7 类失效路径**（每条都做过注入，见 Step 3）：

1. 树叶误改回 cutout / 误写 `opaque:false` → 叶-叶共享面不再互剔，密林视域通道占用翻数倍；
2. 树叶误写 `shadowCast:false` → 与同为 opaque 叶的 `sky_leaves` / 既有 `leaves` 口径不一致（用户裁决：巨树叶**投影**）；
3. `trees.json` 的 palette 里出现未注册的名字 → `makeColumnSetter` 对未注册名**静默跳过** → 该方块变 air，肉眼只觉得「树有洞」；
4. 声明了却没人用的 `giant_*`（死方块）/ 在用却没声明（同 3）；
5. 8 个方块没进 `HIDDEN_FROM_INVENTORY` → 玩家能在背包里选中并放出一块孤零零的树干；
6. 烘焙输入（`.schem`）或映射表改了却没重烘焙 → 产物静默过期（渲染旧树形，肉眼只觉得「树形怪怪的」）；
7. 贴图缺失 / 尺寸错 / 出现近黑像素（opaque 通道忽略 alpha，孔洞处直接露出 RGB → 黑点）/ 目录里有无人引用的 `giant_*` 孤儿贴图。

> ⚠️ **本仓主流程是逐个显式调用各门禁**（`check-data.mjs` 末尾），漏了调用行则门禁**永不执行**（已因此出过两次事故）。验收时务必确认 `npm run check:data` 的输出里真的有 `[巨树]` 这一行。

---

- [ ] **Step 1: 写门禁**

```diff
diff --git a/tools/check-data.mjs b/tools/check-data.mjs
index b3b9e2f..0266b77 100644
--- a/tools/check-data.mjs
+++ b/tools/check-data.mjs
@@ -730,6 +730,108 @@ async function checkNightSkyFreshness() {
   infos.push('[夜空] 烘焙指纹匹配（无缝立方图当前）');
 }
 
+// ---------------------------------------------------------------- [巨树] 契约（Giant Trees Epic）
+
+/**
+ * [巨树] 契约：8 个 `giant_*` 方块声明、烘焙产物（trees.json）、贴图三者必须互相对得上。
+ *
+ * 钉的失效路径（每条都实测注入过，见 plan Task 8 Step 3）：
+ *   ① 树叶误改回 cutout / 误写 opaque:false → 叶-叶共享面不再互剔，密林视域通道占用翻数倍；
+ *   ② 树叶误写 shadowCast:false → 与同为 opaque 叶的 sky_leaves / 既有 leaves 口径不一致
+ *      （用户裁决：巨树叶**投影**；`[阴影投射]` 的 13 项清单也不含任何树叶）；
+ *   ③ palette 里出现未注册的名字 → makeColumnSetter 对未注册名**静默跳过** → 该方块变 air，肉眼只觉得「树有洞」；
+ *   ④ 声明了却没人用的 giant_*（死方块）/ 在用却没声明（同 ③）；
+ *   ⑤ 8 个方块没进 HIDDEN_FROM_INVENTORY → 玩家能在背包里选中并放出一块孤零零的树干；
+ *   ⑥ 烘焙输入（.schem）或映射表改了却没重烘焙 → 产物静默过期；
+ *   ⑦ 贴图缺失/尺寸错/出现近黑像素（opaque 通道忽略 alpha，孔洞处直接露出 RGB → 黑点）。
+ * ⚠️ 主流程是逐个显式调用 —— 漏了本行则门禁永不执行（本仓已因此出过两次事故）。
+ */
+async function checkGiantTrees() {
+  const fp = await import('./giant-trees-fingerprint.mjs');
+  const before = failures.length;
+  const fail = (m) => failures.push(`[巨树] ${m}`);
+
+  // ① 烘焙输入（入库）与产物
+  if (!fs.existsSync(fp.SCHEM_PATH)) fail(`烘焙输入缺失 ${path.relative(ROOT, fp.SCHEM_PATH)}（.schem 入库，缺失 = 仓库损坏）`);
+  if (!fs.existsSync(fp.TREES_JSON) || !fs.existsSync(fp.TREES_META)) {
+    fail('缺 assets/giant-trees/trees.json 或 trees.meta.json（跑 npm run gianttrees）');
+    return;
+  }
+  let meta, trees;
+  try {
+    meta = JSON.parse(fs.readFileSync(fp.TREES_META, 'utf8'));
+    trees = JSON.parse(fs.readFileSync(fp.TREES_JSON, 'utf8')).trees;
+  } catch { fail('trees.json / trees.meta.json 不是合法 JSON（重跑 npm run gianttrees）'); return; }
+
+  // ② 指纹（入库 .schem 内容 + 全部烘焙参数）
+  const cur = fp.giantTreesInputFingerprint();
+  if (meta.fingerprints?.input !== cur.input) {
+    fail(`产物已过期：指纹不匹配（烘焙时 "${meta.fingerprints?.input}" vs 当前 "${cur.input}"）→ 跑 npm run gianttrees`);
+  }
+
+  // ③ 变体数与调色板
+  let variantCount = 0;
+  for (const [family, pads] of Object.entries(fp.TREE_FAMILIES)) {
+    const list = trees[family] || [];
+    if (list.length !== pads.length) fail(`族 ${family} 变体数 ${list.length} ≠ TREE_FAMILIES 的 ${pads.length}`);
+    for (const v of list) {
+      variantCount++;
+      if (JSON.stringify(v.palette) !== JSON.stringify(fp.FAMILY_PALETTES[family])) fail(`族 ${family} 的 palette 与 FAMILY_PALETTES 不一致（trees.json 被手改？）`);
+    }
+  }
+  for (const f of Object.keys(trees)) if (!(f in fp.TREE_FAMILIES)) fail(`trees.json 含未知族 "${f}"`);
+
+  // ④ palette ↔ giant_* 声明双向闭包；palette 全部在 registry
+  const used = new Set();
+  for (const list of Object.values(trees)) for (const v of list) for (const n of v.palette) used.add(n);
+  const declared = BLOCKS.filter((b) => b.name.startsWith('giant_')).map((b) => b.name);
+  for (const n of used) {
+    if (REGISTRY.idOf(n) === undefined) fail(`palette 含未注册方块 "${n}"（makeColumnSetter 静默跳过 → 该格变 air）`);
+    else if (!declared.includes(n)) fail(`在用的 palette 名 "${n}" 不是 giant_* 声明`);
+  }
+  for (const n of declared) if (!used.has(n)) fail(`声明了 ${n} 但没有任何变体使用（死方块）`);
+
+  // ⑤ 树叶：opaque + 不得 opaque:false + 必须投影（不写 shadowCast:false）
+  for (const n of declared.filter((x) => x.endsWith('_leaves'))) {
+    const def = BLOCKS.find((b) => b.name === n);
+    const id = REGISTRY.idOf(n);
+    if (def.cullMode !== 'opaque') fail(`"${n}" 的 cullMode=${def.cullMode}，必须是 opaque（cutout 会让密林视域通道占用翻数倍）`);
+    if (def.opaque === false) fail(`"${n}" 显式 opaque:false，叶-叶共享面不再互剔`);
+    if (def.shadowCast === false) fail(`"${n}" 写了 shadowCast:false，巨树叶须投影（与 sky_leaves / leaves 同口径）`);
+    if (id !== undefined && !REGISTRY.castsShadow(id)) fail(`"${n}" 的 registry.castsShadow 为 false`);
+    if (id !== undefined && REGISTRY.opaqueTable[id] !== 1) fail(`"${n}" 的 opaqueTable 不是 1`);
+  }
+
+  // ⑥ 全部不进背包
+  for (const n of declared) if (!HIDDEN_FROM_INVENTORY.includes(n)) fail(`"${n}" 不在 HIDDEN_FROM_INVENTORY（玩家能放出孤零零的树干/树叶）`);
+
+  // ⑦ 贴图：faces-data 里 procedural/giant_* 的 tile 必须有 16×16 PNG、无近黑像素；且目录里没有无人引用的 giant_* 孤儿
+  const giantTiles = new Set();
+  for (const n of declared) {
+    const v = FACES_DATA[n];
+    if (!v) { fail(`"${n}" 没有 faces-data 映射`); continue; }
+    for (const t of (Array.isArray(v) ? v : [v])) if (t && t.startsWith('procedural/giant_')) giantTiles.add(t);
+  }
+  for (const t of giantTiles) {
+    const file = path.join(ROOT, 'assets', 'textures', `${t}.png`);
+    if (!fs.existsSync(file)) { fail(`贴图缺失 ${t}.png（跑 node tools/bake-giant-textures.mjs）`); continue; }
+    const png = PNG.sync.read(fs.readFileSync(file));
+    if (png.width !== 16 || png.height !== 16) fail(`${t}.png 尺寸 ${png.width}×${png.height} ≠ 16×16`);
+    for (let i = 0; i < png.width * png.height; i++) {
+      const o = i * 4;
+      if (0.2126 * png.data[o] + 0.7152 * png.data[o + 1] + 0.0722 * png.data[o + 2] < 40) { fail(`${t}.png 像素 ${i} 近黑（opaque 通道忽略 alpha，孔洞处会露出黑点）`); break; }
+    }
+  }
+  const procDir = path.join(ROOT, 'assets', 'textures', 'procedural');
+  for (const f of fs.readdirSync(procDir).filter((x) => x.startsWith('giant_') && x.endsWith('.png'))) {
+    if (!giantTiles.has(`procedural/${f.replace(/\.png$/, '')}`)) fail(`孤儿贴图 procedural/${f}（没有任何 giant_* 方块引用）`);
+  }
+
+  if (failures.length === before) {
+    infos.push(`[巨树] ${variantCount} 变体 / ${declared.length} 方块（叶子 opaque 且投影）/ 指纹匹配 / 贴图 ${giantTiles.size} 张`);
+  }
+}
+
 // ---------------------------------------------------------------- 主流程
 
 const REGISTRY = await buildDefaultRegistry();
@@ -751,6 +853,7 @@ checkZombieHeadTexture();
 checkTurretArmorTexture();
 checkSkyboxAssets();         // v1.58：天空盒立方图完整性（⚠️ 漏了本行则门禁永不执行）
 await checkNightSkyFreshness(); // v1.60：夜空烘焙产物指纹（⚠️ 漏了本行则门禁永不执行）
+await checkGiantTrees();     // 巨树景观：方块/烘焙产物/贴图三方契约（⚠️ 漏了本行则门禁永不执行）
 
 console.log('[check:data] 数据契约检查');
 for (const i of infos) console.log(`  ✓ ${i}`);
```

- [ ] **Step 2: 验证绿**

Run: `npm run check:data`

Expected（关键行；注意 `[巨树]` 行存在）：

```text
[check:data] 数据契约检查
  ✓ [引用完整性] 141 个被引用 tile 全部存在于 atlas（atlas 共 153 tile）
  ✓ [物品集合] 116 项 = registry 134 − 排除 18（改排除集合自动跟上）
  ✓ [阴影投射] 13 项不投影（对齐 mc-lite isShadowEnabled:false 口径）…
  ✓ [图标过期] 116 项指纹全部匹配（图标与几何/贴图同步）
  ✓ [测试注册] 49 个测试文件全部已注册
  ✓ [巨树] 28 变体 / 8 方块（叶子 opaque 且投影）/ 指纹匹配 / 贴图 6 张
[check:data] ✓ 数据契约全部一致
```

- [ ] **Step 3: 负向验证 —— 10 条注入，逐条真红、复原后全绿**

临时改动 → `node tools/check-data.mjs`（退出码必须是 1）→ 复原（退出码回 0）。实测全部成立：

| # | 临时改动 | 实测的失败信息（节选） |
|---|---|---|
| 1 | `giant_cherry_leaves` 的 `cullMode` 改 `cutout` | `[巨树] "giant_cherry_leaves" 的 cullMode=cutout，必须是 opaque（cutout 会让密林视域通道占用翻数倍）` + `… 的 opaqueTable 不是 1` |
| 2 | `giant_oak_leaves` 加 `"opaque":false` | `[巨树] "giant_oak_leaves" 显式 opaque:false，叶-叶共享面不再互剔` + `… 的 opaqueTable 不是 1` |
| 3 | `giant_palm_leaves` 加 `"shadowCast":false` | `[阴影投射] 多标了 shadowCast:false（…）：giant_palm_leaves`（既有门禁）+ `[巨树] "giant_palm_leaves" 写了 shadowCast:false，巨树叶须投影（与 sky_leaves / leaves 同口径）` + `… registry.castsShadow 为 false` |
| 4 | `trees.json` 里把 `giant_palm_leaves` 全部替换成 `giant_palm_leavez` | `[巨树] 族 palm 的 palette 与 FAMILY_PALETTES 不一致（trees.json 被手改？）`（每个变体一条）+ 未注册名 |
| 5 | `inventory.js` 的 `HIDDEN_FROM_INVENTORY` 漏掉 `giant_banyan_leaves` | `[巨树] "giant_banyan_leaves" 不在 HIDDEN_FROM_INVENTORY（玩家能放出孤零零的树干/树叶）` |
| 6 | `.schem` 翻一个字节（偏移 1000 `^= 0xff`） | `[巨树] 产物已过期：指纹不匹配（烘焙时 "217e215b0538262b:223838c7cfec01d6" vs 当前 "54df1e2f79d25e7a:223838c7cfec01d6"）→ 跑 npm run gianttrees` |
| 7 | `giant-trees-fingerprint.mjs` 里 `oak_leaves: 1, birch_leaves: 2` 对调（映射表改了没重烘焙） | `… vs 当前 "217e215b0538262b:9dca5f10c6c6a29f"）→ 跑 npm run gianttrees` |
| 8 | 删 `procedural/giant_birch_leaves.png` | `[巨树] 贴图缺失 procedural/giant_birch_leaves.png（跑 node tools/bake-giant-textures.mjs）` |
| 9 | `giant_spruce_leaves.png` 的像素 0 改成 (0,0,0) | `[巨树] procedural/giant_spruce_leaves.png 像素 0 近黑（opaque 通道忽略 alpha，孔洞处会露出黑点）` |
| 10 | `procedural/` 里多放一张 `giant_extra_orphan.png` | `[巨树] 孤儿贴图 procedural/giant_extra_orphan.png（没有任何 giant_* 方块引用）` |

- [ ] **Step 4: 静态门**

Run: `npm run check`

Expected：全绿（`[巨树]` 行在内）；lint `0 errors, 15 warnings`。

- [ ] **Step 5: 提交**（仅在用户明确要求提交时）

```bash
git add tools/check-data.mjs
git commit -m "test(giant-trees): check:data 新增 [巨树] 契约门禁（方块/烘焙产物/贴图三方对账）"
```

---

## Task 8: Tier 4 实测 —— 三条路径落地 / 让路 / 通道预算门

**Files:**
- Create: `tests/giant-trees.spec.mjs`（2 条）
- Create: `tests/giant-tree-budget.spec.mjs`（4 条）

**Interfaces:**
- Consumes：`window.__MC_GAME__`（`world.columns` / `world.hasColumn` / `registry.idOf` / `scheduler.structureIndex._layouts` / `scheduler` 的队列字段 / `renderWorld.slotMap` / `renderWorld._capacity`）。
- Produces：两个 Playwright spec。判定一律走**数据层**（world 的方块数据 / slot 的 `reservedV`），不截图——断言必须能区分「树真的落地」与「什么都没发生」。

**设计要点**（spec §1.2 / §2.5）：

1. **预算门的口径**：占用 = Σ `slot.reservedV` / **初始**容量常量（reserved = 1.25 × 已用顶点，`render-world.js:204`；扩容是黏性的，当前 `maxVertexCount` 会随历史漂移，所以相对初始常量算）。固定 5 个视域（静态：队列收敛 + section 数连续 2 秒不变）+ 3 条冲刺（12 秒、8 格/秒、250ms 采样取峰值）。
   - opaque：≤ 90%（实测最高 82.1%）且**零扩容**；
   - cutout / transparent：**不得比 HEAD 同视域/同路径更糟**（+1.0 容差；冲刺峰值 +2.0）。HEAD 自己在密林视域就越线（cutout 128.1% / 森林冲刺 145.4%，会触发 ×1.5 扩容），所以验收口径是「相对 HEAD 不恶化」，不是「绝对不扩容」。
   - HEAD 基线（`HEAD_BASE`）冻结在 spec 里，来源：`218f836`、seed 12345、vd 8、同一脚本在 HEAD 实测（cutout / transparent 的初始容量与本 Epic 后相同，可直接比较）。
2. **开局先断言初始容量**（⚠️ 实测补出的盲区）：`2.85M × 1.5` 恰好等于 `4.275M`。若 `CAPACITY.opaque` 被改回 1200，页面会在 `(-20,10)` 扩容到 4.275M，末尾的「容量 == 标定值」断言**照样通过**（负向验证 A 的第一次实测：注入后全绿）。所以每个用例开局（出生点在城里，一次扩容都还没发生）就断言三通道初始容量 == `CAPACITY` 标定值。
3. **冲刺必须从森林 / 海岸起步**：出生点 `(283,117)` 在城市中心（城市 bounds x∈[0,566] z∈[-166,400]），三个方向冲 96 格都出不了城，永远测不到树。
4. **每个视域带「巨树方块数下界」**（`GIANT_FLOOR`，取实测的 ~1/3）防恒真：否则「没生成树 → 预算天然过」。
5. **计时型**：冲刺峰值依赖加载时序，高负载下贴线 → 先交替对照比分布，不要看单次数值。静态视域的 reserved 读数是确定性的（同一视点两次测量逐位相同）。
6. **「落地」用例**证明 Worker GEN → 主线程 → 世界数据整条真路径：三条路径各自的方块真的出现；榕树带从已加载 layout 里取最近的 `banyan` 候选传送过去。**「让路」用例**：城市 bounds 内巨树方块数 `== 0`，且城外 `> 0`（对照）。

---

- [ ] **Step 1: 写 `tests/giant-trees.spec.mjs`**

```javascript
// tests/giant-trees.spec.mjs — 巨树景观 Tier 4（真实页面、数据级；不靠目视）
// 判据一律走数据层（world 的方块数据），断言必须能区分「树真的落地」与「什么都没发生」。
import { test, expect } from 'playwright/test';

/** 与 tests/sky-structures.spec.mjs 同口径：GEN/MESH/上传/挂起全空 */
const queueConverged = () => {
  const s = window.__MC_GAME__.scheduler;
  return s._inflightGen.size === 0 && s._meshQueue.length === 0 && s._inflightMesh.size === 0 &&
         s._uploadQueue.length === 0 && s._pendingMesh.size === 0 && s._lightQueue.size === 0 && s._inflightLight.size === 0;
};

async function openGame(page) {
  await page.goto('/?vd=8&seed=12345');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 120_000 });
  await page.waitForFunction(() => window.__MC_GAME__.world.columns.size >= 289, null, { timeout: 180_000 });
  await page.waitForFunction(queueConverged, null, { timeout: 180_000 });
}

/** 传送并钉住（物理会把玩家拉回地面，钉住才能稳定停在视域中心），等周围 17×17 列就绪 + 队列收敛 */
async function flyTo(page, x, z, y = 70) {
  await page.evaluate(([x, z, y]) => {
    const g = window.__MC_GAME__; clearInterval(window.__PIN__);
    const p = g.player.physics; p.pos.x = x; p.pos.y = y; p.pos.z = z; p.vel.x = p.vel.y = p.vel.z = 0;
    window.__PIN__ = setInterval(() => { p.pos.x = x; p.pos.z = z; p.pos.y = y; p.vel.y = 0; }, 30);
  }, [x, z, y]);
  await page.waitForFunction(([x, z]) => {
    const g = window.__MC_GAME__; const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
    for (let dx = -8; dx <= 8; dx++) for (let dz = -8; dz <= 8; dz++) if (!g.world.hasColumn(cx + dx, cz + dz)) return false;
    return true;
  }, [x, z], { timeout: 180_000 });
  await page.waitForFunction(queueConverged, null, { timeout: 180_000 });
}

/** 统计已加载 column 里各 giant_* 方块的数量，以及落在城市 bounds 内的数量 */
const countGiants = (page) => page.evaluate(() => {
  const g = window.__MC_GAME__;
  const names = ['giant_oak_log', 'giant_mangrove_log', 'giant_oak_leaves', 'giant_birch_leaves', 'giant_spruce_leaves',
    'giant_cherry_leaves', 'giant_palm_leaves', 'giant_banyan_leaves'];
  const idToName = new Map(names.map((n) => [g.registry.idOf(n), n]));
  let city = null;
  for (const l of g.scheduler.structureIndex._layouts.values()) if (l.city) city = l.city;
  const per = Object.fromEntries(names.map((n) => [n, 0]));
  let total = 0, inCity = 0;
  for (const c of g.world.columns.values()) {
    const b = c.blocks;
    for (let i = 0; i < b.length; i++) {
      const n = idToName.get(b[i]); if (!n) continue;
      per[n]++; total++;
      if (city) {
        const lx = i & 15, lz = (i >> 4) & 15; const wx = c.cx * 16 + lx, wz = c.cz * 16 + lz;
        if (wx >= city.minX && wx <= city.maxX && wz >= city.minZ && wz <= city.maxZ) inCity++;
      }
    }
  }
  return { per, total, inCity, hasCity: !!city };
});

test('巨树落地（三条路径）：森林/海边/榕树带视域里出现各族的方块（数据级）', async ({ page }) => {
  test.setTimeout(600_000);
  await openGame(page);
  // 视域取 spec 勘查用的 column 坐标：(-20,10) 森林为主；(10,40) 海边；榕树带用「最近的 banyan 候选」
  await flyTo(page, -20 * 16 + 8, 10 * 16 + 8);
  const forest = await countGiants(page);
  expect(forest.per.giant_oak_leaves + forest.per.giant_birch_leaves + forest.per.giant_spruce_leaves,
    'A 森林：高橡/白桦/雪松的叶').toBeGreaterThan(2000);
  expect(forest.per.giant_oak_log, 'A 森林：树干').toBeGreaterThan(50);

  await flyTo(page, 10 * 16 + 8, 40 * 16 + 8);
  const coast = await countGiants(page);
  expect(coast.per.giant_cherry_leaves + coast.per.giant_palm_leaves, 'B 海边：樱花/椰子叶').toBeGreaterThan(1000);

  // 榕树带：取离出生点最近的若干 banyan 候选，传送过去，该视域里必须出现榕树的叶或红树干
  const spots = await page.evaluate(() => {
    const g = window.__MC_GAME__; const out = [];
    for (const l of g.scheduler.structureIndex._layouts.values()) {
      const a = l.giantTrees && l.giantTrees.banyan; if (!a) continue;
      for (let i = 0; i < a.length; i += 5) out.push({ x: a[i], z: a[i + 2], d: Math.hypot(a[i] - g.spawnX, a[i + 2] - g.spawnZ) });
    }
    return out.sort((p, q) => p.d - q.d).slice(0, 3);
  });
  expect(spots.length, '已加载的 layout 里有榕树候选').toBeGreaterThan(0);
  let banyanBlocks = 0;
  for (const s of spots) {
    await flyTo(page, s.x, s.z);
    const r = await countGiants(page);
    banyanBlocks = Math.max(banyanBlocks, r.per.giant_banyan_leaves + r.per.giant_mangrove_log);
    if (banyanBlocks > 200) break;
  }
  expect(banyanBlocks, 'C 榕树带：榕树叶/红树干').toBeGreaterThan(200);
});

test('巨树让路：城市 bounds 内零巨树方块，城外有（数据级，真实世界）', async ({ page }) => {
  test.setTimeout(600_000);
  await openGame(page);
  // 城市西缘：视域里既有城内也有城外
  await flyTo(page, 0, 117);
  const r = await countGiants(page);
  expect(r.hasCity, '已加载的 layout 里有城市布局').toBe(true);
  expect(r.total, '视域里城外确有巨树（对照，防恒真）').toBeGreaterThan(0);
  expect(r.inCity, '城市 bounds 内不得有巨树方块').toBe(0);
});
```

- [ ] **Step 2: 写 `tests/giant-tree-budget.spec.mjs`**

```javascript
// tests/giant-tree-budget.spec.mjs — 巨树景观的通道容量预算回归门（Tier 4，真实页面）
//
// 口径（⚠️ 与 spec §1.2 一致，勿改成别的）：
//   · 占用 = Σ slot.reservedV / **初始**容量常量（reserved = 1.25 × 已用顶点，render-world.js:204；
//     扩容判据看 reserved；相对初始常量算，因为扩容是黏性的，当前 maxVertexCount 会随历史漂移）。
//   · 固定 5 个视域（静态：队列收敛 + section 数稳定）+ 3 条冲刺路径（12s、8 格/秒、250ms 采样峰值）。
//     ⚠️ 冲刺必须从森林/海岸起步：出生点在城市中心，三个方向冲 96 格都出不了城，永远测不到树。
//   · opaque：≤ 90%（实测最高 82.1%）且**不得发生 opaque 扩容**（maxVertexCount 仍是 4.275M）。
//     ⚠️ 「容量 == 4.275M」单看末尾不够：2.85M × 1.5 恰好 = 4.275M —— 若 CAPACITY.opaque 被改回 1200，页面会在
//     (-20,10) 扩容到 4.275M，末尾断言照样通过（负向验证实测：注入后仍全绿）。所以**每个用例开局先断言初始容量**
//     （此时在出生点、一次扩容都还没发生），把「容量被改回」直接钉住。
//   · cutout / transparent：**不得比 HEAD 同视域/同路径更糟**（+1.0 容差）。HEAD 自己在密林视域就越线
//     （cutout 128% / 冲刺 145%，会触发 ×1.5 扩容），所以「任何视域都不扩容」对 HEAD 就不成立 ——
//     验收口径是「相对 HEAD 不恶化」，不是「绝对不扩容」。巨树只替换旧森林树（cutout 通道），不碰水。
// 计时型：冲刺峰值依赖加载时序，高负载下贴线 → 先交替对照比分布，不要看单次数值（CLAUDE.md 既有口径）。
import { test, expect } from 'playwright/test';

/** 巨树景观后的初始容量（CAPACITY：opaque 1800×1900×1.25；cutout 550×3200×1.25；transparent 100×1000×1.25） */
const INIT = { opaque: 1800 * 1900 * 1.25, cutout: 550 * 3200 * 1.25, transparent: 100 * 1000 * 1.25 };

/**
 * HEAD 基线（2026-10-23，seed 12345 / vd 8，HEAD=218f836 实测；相对 **HEAD 的初始容量** 2.85M/2.2M/0.125M，
 * 其中 cutout/transparent 的初始容量与本 Epic 后相同，故可直接比较）。
 */
const HEAD_BASE = {
  views: {
    '(18,27)': { cutout: 48.4, transparent: 36.8 },
    '(-20,10)': { cutout: 128.1, transparent: 100.3 },
    '(30,10)': { cutout: 70.8, transparent: 11.2 },
    '(-25,-5)': { cutout: 21.2, transparent: 49.0 },
    '(10,40)': { cutout: 30.1, transparent: 85.8 },
  },
  sprints: {
    '森林(-20,10)→西': { cutout: 129.3, transparent: 128.7 },
    '森林(-20,10)→南': { cutout: 145.4, transparent: 140.8 },
    '海岸(10,40)→东': { cutout: 57.1, transparent: 114.3 },
  },
};
/** 每个视域里巨树方块数的下界（实测的 ~1/3；防「没生成树 → 预算天然过」的恒真） */
const GIANT_FLOOR = { '(18,27)': 5000, '(-20,10)': 20000, '(30,10)': 1000, '(-25,-5)': 20000, '(10,40)': 10000 };
const OPAQUE_MAX = 90;
const TOL = 1.0;

const queueConverged = () => {
  const s = window.__MC_GAME__.scheduler;
  return s._inflightGen.size === 0 && s._meshQueue.length === 0 && s._inflightMesh.size === 0 &&
         s._uploadQueue.length === 0 && s._pendingMesh.size === 0 && s._lightQueue.size === 0 && s._inflightLight.size === 0;
};

async function openGame(page) {
  await page.goto('/?vd=8&seed=12345');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 120_000 });
  await page.waitForFunction(() => window.__MC_GAME__.world.columns.size >= 289, null, { timeout: 180_000 });
  await page.waitForFunction(queueConverged, null, { timeout: 180_000 });
}

async function teleport(page, x, z, y = 70) {
  await page.evaluate(([x, z, y]) => {
    const g = window.__MC_GAME__; clearInterval(window.__PIN__);
    const p = g.player.physics; p.pos.x = x; p.pos.y = y; p.pos.z = z; p.vel.x = p.vel.y = p.vel.z = 0;
    window.__PIN__ = setInterval(() => { p.pos.x = x; p.pos.z = z; p.pos.y = y; p.vel.y = 0; }, 30);
  }, [x, z, y]);
}

/** 等视域就绪 + 队列收敛 + section 数连续 2s 不变（队列归零是瞬时状态，须等 slots 停止变化） */
async function settle(page, x, z) {
  await page.waitForFunction(([x, z]) => {
    const g = window.__MC_GAME__; const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
    for (let dx = -8; dx <= 8; dx++) for (let dz = -8; dz <= 8; dz++) if (!g.world.hasColumn(cx + dx, cz + dz)) return false;
    return true;
  }, [x, z], { timeout: 180_000 });
  await page.waitForFunction(queueConverged, null, { timeout: 180_000 });
  let last = -1, stable = 0;
  for (let i = 0; i < 60 && stable < 4; i++) {
    await page.waitForTimeout(500);
    const n = await page.evaluate(() => window.__MC_GAME__.renderWorld.slotMap.size);
    if (n === last) stable++; else { stable = 0; last = n; }
  }
}

const snapshot = (page) => page.evaluate((INITc) => {
  const rw = window.__MC_GAME__.renderWorld; const r = { opaque: 0, cutout: 0, transparent: 0 };
  for (const s of rw.slotMap.values()) r[s.channel] += s.reservedV;
  return Object.fromEntries(Object.keys(r).map((k) => [k, +(r[k] / INITc[k] * 100).toFixed(1)]));
}, INIT);

const giantCount = (page) => page.evaluate(() => {
  const g = window.__MC_GAME__;
  const ids = new Set(['giant_oak_log', 'giant_mangrove_log', 'giant_oak_leaves', 'giant_birch_leaves', 'giant_spruce_leaves',
    'giant_cherry_leaves', 'giant_palm_leaves', 'giant_banyan_leaves'].map((n) => g.registry.idOf(n)));
  let n = 0;
  for (const c of g.world.columns.values()) { const b = c.blocks; for (let i = 0; i < b.length; i++) if (ids.has(b[i])) n++; }
  return n;
});

const opaqueCapacity = (page) => page.evaluate(() => window.__MC_GAME__.renderWorld._capacity.opaque.maxVertexCount);
const capacities = (page) => page.evaluate(() => {
  const c = window.__MC_GAME__.renderWorld._capacity;
  return { opaque: c.opaque.maxVertexCount, cutout: c.cutout.maxVertexCount, transparent: c.transparent.maxVertexCount };
});
const INIT_MSG = '开局初始容量 == CAPACITY 标定值（出生点在城里，此时还没发生过任何扩容；防「容量被改回 1200 → 页面扩容到恰好相同的 4.275M」的掩盖）';

test('预算门：5 个固定视域（静态）—— opaque ≤ 90% 且不扩容；cutout/transparent 不比 HEAD 更糟', async ({ page }) => {
  test.setTimeout(900_000);
  await openGame(page);
  expect(await capacities(page), INIT_MSG).toEqual(INIT);
  const report = [];
  for (const [name, [cx, cz]] of Object.entries({ '(18,27)': [18, 27], '(-20,10)': [-20, 10], '(30,10)': [30, 10], '(-25,-5)': [-25, -5], '(10,40)': [10, 40] })) {
    const x = cx * 16 + 8, z = cz * 16 + 8;
    await teleport(page, x, z); await settle(page, x, z);
    const pct = await snapshot(page); const giants = await giantCount(page);
    report.push(`${name} opaque ${pct.opaque}% cutout ${pct.cutout}% transp ${pct.transparent}% 巨树方块 ${giants}`);
    expect(giants, `${name} 视域里有足够多的巨树方块（对照，防恒真）`).toBeGreaterThanOrEqual(GIANT_FLOOR[name]);
    expect(pct.opaque, `${name} opaque`).toBeLessThanOrEqual(OPAQUE_MAX);
    expect(pct.cutout, `${name} cutout 不比 HEAD 更糟`).toBeLessThanOrEqual(HEAD_BASE.views[name].cutout + TOL);
    expect(pct.transparent, `${name} transparent 不比 HEAD 更糟`).toBeLessThanOrEqual(HEAD_BASE.views[name].transparent + TOL);
  }
  console.log('BUDGET VIEWS:\n  ' + report.join('\n  '));
  expect(await opaqueCapacity(page), 'opaque 通道未发生扩容').toBe(INIT.opaque);
});

for (const [name, [cx, cz, dx, dz]] of Object.entries({ '森林(-20,10)→西': [-20, 10, -1, 0], '森林(-20,10)→南': [-20, 10, 0, 1], '海岸(10,40)→东': [10, 40, 1, 0] })) {
  test(`预算门：冲刺 ${name}（12s、8 格/秒、250ms 采样峰值）`, async ({ page }) => {
    test.setTimeout(600_000);
    await openGame(page);
    expect(await capacities(page), INIT_MSG).toEqual(INIT);
    const sx = cx * 16 + 8, sz = cz * 16 + 8;
    await teleport(page, sx, sz); await settle(page, sx, sz);
    await page.evaluate(() => clearInterval(window.__PIN__));
    const peak = await page.evaluate(async ([sx, sz, dx, dz, INITc]) => {
      const g = window.__MC_GAME__; const y = 70; let x = sx, z = sz; const t0 = performance.now(); let last = t0;
      const peak = { opaque: 0, cutout: 0, transparent: 0 };
      const mover = setInterval(() => {
        const now = performance.now(); const dt = (now - last) / 1000; last = now; x += dx * 8 * dt; z += dz * 8 * dt;
        const p = g.player.physics; p.pos.x = x; p.pos.z = z; p.pos.y = y; p.vel.x = p.vel.y = p.vel.z = 0;
      }, 8);
      await new Promise((resolve) => {
        const t = setInterval(() => {
          const r = { opaque: 0, cutout: 0, transparent: 0 };
          for (const s of g.renderWorld.slotMap.values()) r[s.channel] += s.reservedV;
          for (const k of Object.keys(r)) peak[k] = Math.max(peak[k], r[k] / INITc[k] * 100);
          if (performance.now() - t0 > 12000) { clearInterval(t); clearInterval(mover); resolve(); }
        }, 250);
      });
      return peak;
    }, [sx, sz, dx, dz, INIT]);
    console.log(`BUDGET SPRINT ${name}: opaque ${peak.opaque.toFixed(1)}% cutout ${peak.cutout.toFixed(1)}% transp ${peak.transparent.toFixed(1)}%`);
    expect(peak.opaque, `${name} opaque 峰值`).toBeLessThanOrEqual(OPAQUE_MAX);
    expect(peak.cutout, `${name} cutout 峰值不比 HEAD 更糟`).toBeLessThanOrEqual(HEAD_BASE.sprints[name].cutout + TOL + 1);
    expect(peak.transparent, `${name} transparent 峰值不比 HEAD 更糟`).toBeLessThanOrEqual(HEAD_BASE.sprints[name].transparent + TOL + 1);
    expect(await opaqueCapacity(page), `${name} opaque 通道未发生扩容`).toBe(INIT.opaque);
  });
}
```

- [ ] **Step 3: 运行两个 spec**

Run: `npx playwright test tests/giant-trees.spec.mjs tests/giant-tree-budget.spec.mjs`

Expected：`6 passed (1.5m)`，并打印（读数是确定性的，静态视域逐位相同）：

```text
BUDGET VIEWS:
  (18,27) opaque 58% cutout 45.9% transp 36.8% 巨树方块 15316
  (-20,10) opaque 70.2% cutout 53.9% transp 100.3% 巨树方块 61967
  (30,10) opaque 53.8% cutout 69.9% transp 11.2% 巨树方块 4850
  (-25,-5) opaque 69.6% cutout 12.2% transp 49% 巨树方块 59916
  (10,40) opaque 61.6% cutout 17.2% transp 85.8% 巨树方块 29960
BUDGET SPRINT 森林(-20,10)→西: opaque 79.6% cutout 54.9% transp 128.7%
BUDGET SPRINT 森林(-20,10)→南: opaque 82.1% cutout 60.3% transp 140.8%
BUDGET SPRINT 海岸(10,40)→东: opaque 72.6% cutout 25.9% transp 114.3%
```

> 若预算门红：先读实际值判断是哪个通道、哪个视域，再回看 spec §2.5 —— **不要自行调大 `CAPACITY`，也不要放宽阈值**。冲刺用例贴线时先交替对照（见「已知计时型 flaky」）。

- [ ] **Step 4: 负向验证 —— 4 条注入，逐条真红、复原后全绿**

| # | 临时改动 | 受测用例 | 实测的失败信息 |
|---|---|---|---|
| A | `render-world.js`：`opaque: { active: 1800, … }` 改回 `1200` | 预算门·5 个固定视域 | `开局初始容量 == CAPACITY 标定值（…）`（`Expected/Received` 的 opaque 为 4,275,000 vs 2,850,000） |
| B | `blocks-data.js`：六种 `giant_*_leaves` 的 `cullMode` 全部改 `cutout` | 预算门·5 个固定视域 | `(18,27) cutout 不比 HEAD 更糟`：`Expected: <= 49.4  Received: 61.8` |
| C | `apply.js`：`giantAllowedAtFor` 恒返回 `true`（不让路） | 巨树让路 | `城市 bounds 内不得有巨树方块`：`Expected: 0  Received: 30404` |
| D | `structure-layout.js`：`giantTrees` 换成三个空 `Int32Array`（layout 接线断了） | 巨树落地 | `A 森林：高橡/白桦/雪松的叶`：`Expected: > 2000  Received: 0` |

> **A 的盲区是实测发现的**：第一版预算门只在末尾断言容量，注入 A 后全绿；补上开局断言后才真红。B 也要改**全部**六种树叶——只改一种时 cutout 占用仍在 HEAD 基线以内，Tier 4 抓不到（静态的 `[巨树]` 门禁才是树叶 `cullMode` 的第一道防线，Tier 4 是第二道）。
> **D 是 Worker 接线的负向验证**：浏览器内单测直接调纯函数，测不到 Worker 里的真实接线；这条在真游戏页（Worker GEN）上兜住。

- [ ] **Step 5: 提交**（仅在用户明确要求提交时）

```bash
git add tests/giant-trees.spec.mjs tests/giant-tree-budget.spec.mjs
git commit -m "test(giant-trees): 三条路径落地/让路实测与通道预算门（reserved 口径，相对 HEAD）"
```

---

## Task 9: 全量回归与性能验收

**Files:** 无新增产物；只跑门禁。需要两个 git 忽略的临时脚本（`tests/tmp-unit.mjs` 已在「约定」里建好；`tests/tmp-gen-p95.mjs` 见 Step 5）。

> 本任务的数字是**这份计划在隔离副本里真跑出来的**。你的机器上绝对值会不同，但「分布相同 / 门不破 / 零扩容」的结论应当成立；结论不成立时按 CLAUDE.md 的纪律处理：**冻结断言（draw call 数、p95 上限等）实测不符时停下来报告，不要擅自改断言或静默放宽**。

- [ ] **Step 1: 静态门 + 浏览器内单测**

Run: `npm run check`

Expected：`[check:arch] 扫描 104 个源文件` + `✓ 架构红线全部守住`；

```text
[check:data] 数据契约检查
  ✓ [引用完整性] 141 个被引用 tile 全部存在于 atlas（atlas 共 153 tile）
  ✓ [物品集合] 116 项 = registry 134 − 排除 18（改排除集合自动跟上）
  ✓ [阴影投射] 13 项不投影（对齐 mc-lite isShadowEnabled:false 口径）…
  ✓ [图标过期] 116 项指纹全部匹配（图标与几何/贴图同步）
  ✓ [测试注册] 49 个测试文件全部已注册
  ✓ [巨树] 28 变体 / 8 方块（叶子 opaque 且投影）/ 指纹匹配 / 贴图 6 张
[check:data] ✓ 数据契约全部一致
```

lint `✖ 15 problems (0 errors, 15 warnings)`（HEAD 既有，本 Epic 新增 0 条）。

Run: `node tests/tmp-unit.mjs`
Expected：`harness: passed=810 failed=0 total=810`（HEAD 基线 779 + 31）。

- [ ] **Step 2: 全量 Playwright**

Run: `npm test`（自带 `webServer`，`workers:1` 串行；**跑的时候不要并行跑别的 CPU 任务**，否则计时型断言贴线 flaky）

Expected：`190 passed`（HEAD 基线 184 条 / 62 个文件 → 本 Epic 新增 6 条 / 2 个文件），约 13~14 分钟。三条已知计时型 flaky（`m1-acceptance` / `m3-rain` / `weapons-world-edit`）若失败，**单独连跑 3 次判定**，不要改断言。

> 隔离副本里实测：全量 `190 passed (13.4m)`（当时预算门还没有「开局初始容量」断言；补上后单独重跑两个新 spec：`6 passed (1.5m)`），`m3-fullscene` 打印 `gpuVertexBytes: 198000000`。

- [ ] **Step 3: 性能门 `bench --check` 与交替对照**

Run: `npm run bench -- --check`

**预期会被场景 ④ 的 `frameP95` 阻断**（`[回退 11.1%] ④ 模拟 TNT 批量删 500 块 · frameP95: 9 → 10`）——这是已知的 vsync 量子化噪声：120Hz 锁帧下 frameP95 按 8.33ms 一档量子化，基线 9 而实测在 9.6~10.1 随机浮动，9→10 只差一个量子；**HEAD 本身也会被阻断**。不要看单次数值，做**交替对照**（HEAD 与改动交错各 3 轮，比较分布）：

```bash
git worktree add ../mc-heavy-head 218f836            # HEAD 基线副本（用完 git worktree remove ../mc-heavy-head）
ln -s "$PWD/node_modules" ../mc-heavy-head/node_modules
sed -i '' 's/8081/18096/g' ../mc-heavy-head/src/bench/baseline.mjs ../mc-heavy-head/server-script/start-server.js   # 换端口，避免与主仓 server 冲突（macOS sed；Linux 去掉 ''）
for round in 1 2 3; do
  for side in ../mc-heavy-head .; do
    echo "== round $round  $side"
    (cd "$side" && npm run bench -- --check 2>&1 | grep -E "^\[bench\] [①②③④]|回退|通过")
  done
done
```

实测（3 轮，HEAD 为 `218f836`）：

| 场景 | HEAD p95（3 轮） | 改动 p95（3 轮） | HEAD draw | 改动 draw |
|---|---|---|---|---|
| ① 平原冲刺 | 10 / 9.9 / 10.1 | 10 / 9.9 / 9.9 | 500 | 516（+16） |
| ② 城市中心环视 | 9.9 / 9.9 / 10 | 9.9 / 9.9 / 10 | 559 | 559（0） |
| ③ 连续放/挖 200 块 | 10 / 9.9 / 9.8 | 10 / 9.9 / 9.8 | 559 | 559（0） |
| ④ 模拟 TNT 批量删 500 块 | 9.9 / 10 / 10 | 10.1 / 10 / 10 | 545 | 586（+41） |
| 被 `--check` 阻断的轮数 | 2 / 3 | 3 / 3 | | |

判读：四个场景的 frameP95 分布**逐场景相同**（差异 ≤ 0.2ms，低于一个 vsync 量子 8.33ms），两侧都在 ④ 上贴着 9→10 的阈值被阻断 → **无帧时回退**。`fps` 全部 120±0.1。**draw call 有增量**：场景 ① +16、④ +41（+7.5%）——three r185.1 的 WebGPU 后端对 BatchedMesh 的**每个可见 geometry slot 各发一次 draw**，巨树新增可见 section 即新增 draw；120Hz 下无可见影响，但要记入验收报告（`bench --check` 的 `STRUCTURAL` 分支恒为 false，不会替你拦它）。

冻结基线不得被改写：

```bash
git status --short docs/m3-baseline.md docs/m3-baseline.json     # 必须无输出
```

> ⚠️ **不带 `--check` 跑 `npm run bench` 会自动重写 `docs/m3-baseline.*`**——那是冻结基线，提交它会静默放宽门禁（p95 基准 9→9.9）。误跑了就 `git checkout -- docs/m3-baseline.md docs/m3-baseline.json`。

- [ ] **Step 4: 帧循环之外的两项旁证（可选，已在 Task 2/3/8 覆盖）**

`m3-fullscene` 的 `gpuVertexBytes: 198000000`（= 188.83 MiB，< 200 MiB）；`giant-tree-budget` 的 8 条读数（见 Task 8）。

- [ ] **Step 5: `structure-gen` 的 genP95 —— Worker 预热的交替对照**

`structure-gen` fixture 的含结构 genP95 门是 **10ms**（不是 8ms）。临时脚本（git 忽略；放在项目内，`/tmp` 下的脚本解析不到 `playwright`）：

```bash
cat > tests/tmp-gen-p95.mjs <<'EOF'
// 打开 structure-gen fixture，读 genP95 与失败项（重复 N 次）；git 忽略的临时脚本
import { chromium } from 'playwright';
const [, , BASE, LABEL, N = '5'] = process.argv;
const browser = await chromium.launch({ channel: 'chromium', headless: true });
const out = [];
for (let i = 0; i < Number(N); i++) {
  const page = await browser.newPage();
  await page.goto(`${BASE}/src/tests/test-structure-gen.html`);
  await page.waitForFunction(() => window.__STRUCTURE_GEN_RESULTS__ !== undefined, null, { timeout: 90_000 });
  const r = await page.evaluate(() => window.__STRUCTURE_GEN_RESULTS__);
  out.push({ p95: r.genP95, errors: r.errors }); await page.close();
}
await browser.close();
const ps = out.map((o) => o.p95).filter((x) => x !== undefined);
console.log(`[${LABEL}] genP95(ms) = ${ps.map((x) => x.toFixed(2)).join(' / ')}  中位 ${ps.slice().sort((a, b) => a - b)[Math.floor(ps.length / 2)]?.toFixed(2)}   失败项: ${JSON.stringify([...new Set(out.flatMap((o) => o.errors || []))])}`);
EOF
```

起两个 server（主仓 8081、HEAD 副本 18096），交替 3 轮 × 每轮 5 次：

```bash
(node server-script/start-server.js & echo $! > /tmp/gp-mod.pid)
(cd ../mc-heavy-head && node server-script/start-server.js & echo $! > /tmp/gp-head.pid)
sleep 2
for round in 1 2 3; do
  node tests/tmp-gen-p95.mjs http://localhost:18096 "HEAD r$round" 5
  node tests/tmp-gen-p95.mjs http://localhost:8081  "MOD  r$round" 5
done
kill $(cat /tmp/gp-head.pid) $(cat /tmp/gp-mod.pid); rm -f /tmp/gp-*.pid
```

实测（安静系统）：

| 侧 | 3 轮 × 5 次 genP95（ms） | 中位 |
|---|---|---|
| HEAD | 7.6 ~ 8.2 | 8.0 / 8.0 / 7.9 |
| 改动（有预热） | 7.5 ~ 8.1 | 8.0 / 8.0 / 7.8 |
| **无预热**（注入） | **9.4 ~ 10.0**（15 次里 1 次 `gen with structures p95 < 10ms` 红） | 9.7 / 9.7 / 9.6 |

> 负载下的更大差距（Task 6 设计要点 6）：HEAD 8.1~9.8 / 无预热 11.6~14.0 / 预热 8.4~10.0。无预热的注入做法：把 `world-worker.js` 里的 `const giantPreloadPromise = loadGiantTrees();` 临时改成 `Promise.resolve();`，跑完复原。**门禁阻断但交替对照两侧分布相同时，不要为「过门」改 `10ms`**。

- [ ] **Step 6: 收尾检查**

```bash
git worktree remove ../mc-heavy-head                       # 清理 HEAD 副本
git status --short                                         # 只应有本 Epic 的文件；tests/tmp-* 被忽略
git diff --stat 218f836 -- docs/m3-baseline.md docs/m3-baseline.json   # 无输出
```

`git status --short` 里应出现（新增 / 修改，不含文档同步）：`assets/giant-trees/`（src 素材 + 2 个产物）、`assets/textures/procedural/giant_*.png`（6）、`assets/atlas.{png,json}`、`tools/{giant-trees-fingerprint,bake-giant-trees,bake-giant-textures,check-data}.mjs`、`package.json`、`src/gen/structures/{giant-trees,apply,structure-layout}.js`、`src/workers/world-worker.js`、`src/render/render-world.js`、`src/voxel/{blocks-data,faces-data}.js`、`src/player/inventory.js`、`src/tests/{index.html,test-giant-trees*.js(3),test-block-registry,test-inventory,test-orientation}`、`tests/{giant-trees,giant-tree-budget}.spec.mjs`、`tests/m3-fullscene.spec.mjs`、`docs/phase-1-engine-design.md`。

---

## Task 10: 文档同步与验收报告

**Files:**
- Modify: `docs/roadmap.md` · `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-10-23-giant-trees-design.md`（状态行）
- Create: `docs/giant-trees-acceptance-report.md`
- （设计文档 `docs/phase-1-engine-design.md` 已在 Task 3 先行修改，此处不再动。）

**为什么要同步这些**：CLAUDE.md「文档同步」规则——新增产物时必须同步「目录结构清单」「开发命令清单」「现状声明」三类文档，历史记录段不动；同一事实的多个副本会漂移（已发生三次版本号漂移），所以**能指向别处就不复制**：进度与实测一律在 roadmap / 验收报告，CLAUDE.md 只留「会影响后续实现决策的活跃约束」。

---

- [ ] **Step 1: `docs/roadmap.md`（4 处）**

**(a)** 「最后更新」日期改为实施当天。

**(b)** 「一句话现状」章节末尾（下一个 `##` 标题之前）追加一段：

```markdown
**v1.68 巨树景观**（用户裁决：opaque 通道容量 ×1.5 / 巨树叶投影 / `.schem` 入库 / 已有存档接受）：素材包 `40AssortedTreesPack.schem`
入库并离线烘焙成 28 个原版景观树变体（1/2 比例，16,954 格），按森林 / 海边 / 草地沙漠交界三条路径落位，城市·地标·撒布结构·JSON
结构占地让路，与旧森林树互斥。region 层候选 = 全局对齐网格 + 内缩抖动（间距由构造保证，≈1.1 ms/region）。**opaque 通道容量
2.85M → 4.275M，§4.10 的 150MiB 冻结预算有意上调到 188.83 MiB**；真实页面 reserved 口径最高 82.1%（零 opaque 扩容），
cutout / transparent 相对 HEAD 不恶化；bench draw call 场景 ① +16 / ④ +41。浏览器内单测 779→810，Playwright 184→190。
规格 `docs/superpowers/specs/2026-10-23-giant-trees-design.md`（v1.1），验收报告 `docs/giant-trees-acceptance-report.md`。
```

**(c)** 「M3.2 之后的独立 bugfix / 改造（v1.19 ~ v1.63）」：标题里的范围改成 `v1.19 ~ v1.68`；在 `v1.67` 行之后追加一行：

```markdown
| v1.68 | 巨树景观（28 变体 × 三条落位路径） | ✅ 已完成 | 素材 `40AssortedTreesPack.schem`（入库）→ 离线烘焙（2×2×2 降采样规则写死 / 24 个源方块名显式分类 / 地块索引 (minZ,minX) / 族标志反向校验）→ 28 个变体；`giant-trees.js`：region 层候选 = 全局对齐网格 + 内缩抖动，column 层合并 3×3 邻域候选（拼接 + 规范排序）→ 排除（城市 / 地标 / 撒布 / JSON 占地）→ 光栅化 + 地基 → 覆盖窗口抑制旧森林树。8 个 `giant_*` 方块（树叶 opaque 且投影、不进背包），6 张贴图沿用 `leaves.png` 图案只换色。**opaque 容量 ×1.5（用户裁决）**：2.85M→4.275M，GPU 静态 148.06→188.83 MiB。真实页面 reserved：5 视域 + 3 冲刺最高 opaque 82.1%、零 opaque 扩容；cutout 只降不升（(-20,10) 128.1→53.9）；draw call ①+16 / ④+41。规格 `docs/superpowers/specs/2026-10-23-giant-trees-design.md`，计划 `docs/superpowers/plans/2026-10-23-giant-trees.md`，验收报告 `docs/giant-trees-acceptance-report.md`。 |
```

**(d)** 「活跃约束详情」章节末尾追加一小节（细节放这里，CLAUDE.md 只留结论）：

```markdown
### 巨树景观（v1.68）

- **容量口径**：reserved = 1.25 × 已用顶点（`render-world.js:204`），相对**初始**容量常量；Node 侧「注入树 + 真 mesher」的已用占比比真实页面低 1.20~1.24 倍。HEAD 基线（初始容量 2.85M / 2.2M / 0.125M，reserved%）：出生点 81.6 / 72.3 / 10.6；(18,27) 82.3 / 48.4 / 36.8；(-20,10) 87.6 / **128.1** / **100.3**；(30,10) 79.1 / 70.8 / 11.2；(-25,-5) 84.6 / 21.2 / 49.0；(10,40) 83.0 / 30.1 / 85.8；森林冲刺→西 99.9 / 129.3 / 128.7、→南 103.1 / **145.4** / 140.8；海岸冲刺→东 98.4 / 57.1 / 114.3。
- **终版读数**（4.275M）：(18,27) 58.0 / 45.9 / 36.8；(-20,10) 70.2 / 53.9 / 100.3；(30,10) 53.8 / 69.9 / 11.2；(-25,-5) 69.6 / 12.2 / 49.0；(10,40) 61.6 / 17.2 / 85.8；冲刺 79.6 / 82.1 / 72.6（opaque）。transparent 与 HEAD **逐位相同**（巨树不碰水）。
- **候选算法对比**（7 个 region）：原贪心 14~20 ms/region、跨 region 边界间距违规 64 对；网格抖动 ≈1.1 ms/region、违规 0。密度（每 eligible 格）A 1/464 · B 1/199 · C 1/207。
- **覆盖损失**：含巨树的 109 个 column 样本里，巨树期望格 43,672 个、98.40% 落地，1.60%（700 格）被后写者覆盖——绝大多数是相邻巨树（B/C 冠幅重叠成片是设计意图），云仅 5 格；树干格 0.89% 被邻树叶覆盖。`makeColumnSetter` 无占用格守卫（后写胜）是全局既有行为，规范排序保证确定性。
- **预热数据**：安静系统 genP95 HEAD 7.6~8.2 / 有预热 7.5~8.1 / 无预热 9.4~10.0（一次撞 10ms 门）；负载下 8.1~9.8 / 8.4~10.0 / 11.6~14.0。
- **atlas**：147 → 153 tile，既有 32 个 tile 坐标被重排；图标产物逐字节不变（8 个新方块全部隐藏）。
```

- [ ] **Step 2: `CLAUDE.md`（5 处）**

**(a)「当前进度」**：在 `另有一项未按版本号登记的改动：**准心按背景亮度自适应配色**…` 这一行之前插入：

```markdown
**v1.68** 引入**巨树景观**（素材 `40AssortedTreesPack.schem` 入库 → 28 个原版景观树变体按 1/2 比例，
森林 / 海边 / 草地沙漠交界三条落位路径，城市·地标·撒布结构让路，与旧森林树互斥；**opaque 通道容量 ×1.5**，
§4.10 预算 148.06 → 188.83 MiB；验收报告 `docs/giant-trees-acceptance-report.md`）。
```

**(b)「背包物品集合口径」那条（现状快照，可带数字）**：把

```
- **背包物品集合口径 116 项** = registry 126 − `NON_PLACEABLE_ITEMS`（4 项功能性方块）−
  `HIDDEN_FROM_INVENTORY`（6 项可放置但不进背包：chimney + 床三项 + **M9 创造台两项**）。
  ⚠️ 门禁 `[物品集合]` 打印的「排除 N」是**两个集合之和**（当前 `排除 10`），与
  「`HIDDEN_FROM_INVENTORY` 6 项」不是一个口径，勿混写。
```

改为：

```
- **背包物品集合口径 116 项** = registry 134 − `NON_PLACEABLE_ITEMS`（4 项功能性方块）−
  `HIDDEN_FROM_INVENTORY`（14 项可放置但不进背包：chimney + 床三项 + **M9 创造台两项** + **巨树景观 8 项 `giant_*`**）。
  ⚠️ 门禁 `[物品集合]` 打印的「排除 N」是**两个集合之和**（当前 `排除 18`），与
  「`HIDDEN_FROM_INVENTORY` 14 项」不是一个口径，勿混写。
```

（其后「两个集合语义互斥…」等行不动。）

**(c) 新增活跃约束小节**：在 `### 背景音乐沉淀的活跃约束` 之前（或任何一个「沉淀的活跃约束」小节之后）追加：

```markdown
### 巨树景观沉淀的活跃约束（v1.68，后续地形装饰 / 结构撒布 / 通道容量类改动必读）

细节与实测数据见 roadmap「活跃约束详情 · 巨树景观」与验收报告。

- **通道容量的判据是 reserved（= 1.25 × 已用顶点，`render-world.js:204`）相对初始容量常量，不是已用占比**：
  Node 侧「注入树 + 真 mesher」的已用占比比真实页面系统性低 1.20~1.24 倍（巨树 v1.0 规格就因此把「最坏 93%」
  当成了 ≤100%，×1.25 实为 116%）。任何 Node 侧估算先 ×1.25；最终数字一律在真实页面读 `renderWorld.slotMap`
  的 `reservedV`。**HEAD 本身在密林视域已越线**（cutout 128.1% / 森林冲刺 145.4%），所以「任何视域都不扩容」
  对 HEAD 就不成立，验收写成「相对 HEAD 不恶化」。**出生点 (283,117) 在城市中心，三个方向冲 96 格都出不了城**
  ——冲刺测试要从森林 / 海岸起步。
- **`CAPACITY.opaque.active = 1800`（4.275M）是用户裁决的有意上调**（§4.10 的冻结预算 148.06 → 188.83 MiB，
  `m3-fullscene` 上限 200 MiB）。⚠️ **「容量 == 标定值」断言单看末尾会被掩盖**：`2.85M × 1.5` 恰好 = `4.275M`，
  容量被改回 1200 时页面会扩容到同一个数 → 预算门**开局**就断言初始容量（负向验证实测：只在末尾断言时注入后全绿）。
- **候选 = 全局对齐网格 + 内缩抖动，不是「逐点扫描 + 贪心」**：cell 边长 `spacing + jitter`，点落在 cell 内
  `[0, jitter)²` ⇒ 相邻点切比雪夫距离 ≥ spacing + 1 由构造保证，跨 region 无缝。`chance` 是线性密度旋钮。
  改 `spacing/jitter` 须同步 `GIANT_TREE_PATHS`、设计文档与单测的间距断言。
- **`layouts` 是 3×3 邻域数组：合并候选必须拼接 + 规范排序，禁止覆盖赋值**（覆盖赋值 → 区域内 99.7% 的 column
  没有树，而用合成场景的集成测试会全绿）。排序键 `(路径序, wx, wz)` 使「后写胜」与 layouts 下发顺序无关。
- **让路在 apply 层，不在候选层**：`pointContext` 只允许 `normal` / `water`，外加撒布结构 / 平地金字塔岛 /
  海岛塔的外包盒。⚠️ 只靠 `pointContext` 不够：平地沙台 ±15 < `pyramid_island.json` 占地 34×39（既有
  `pyramidIsland` 用例是它的回归门，**不得改动**）。排除判定只依赖树本身与邻域 layouts，对覆盖该树的任一 column 一致。
- **旧植被互斥是「可证明」的**：覆盖区 = AABB ⊕ `VEGETATION_EXT`，窗口 = column ⊕ `VEGETATION_EXT`；
  `VEGETATION_EXT = 3` 与阶段 3 植被扫描外扩是**同一个常量**。单格植物只在「目标格已非空气」时不写（不是一律
  不生成）；悬空的树干底格补地基（≤10 格）。
- **Worker 预热不能省，也不能写成 top-level await**：`giantPreloadPromise` 模块加载期发起、不 await，
  `layout` / `gen` 入口 await 同一个 promise。不预热则 `structure-gen` 的含结构 genP95 7.6~8.2 → 9.4~10.0
  （负载下 11.6~14.0，撞 10ms 门）。
- **`seededRandom` 返回 [0,1) 浮点：取整用 `Math.floor(r * 4)`，禁止 `& 3`**（恒为 0）。巨树占 salt
  911~935 / 941（9xx 段此前空闲；用程序化扫描复核，不能只 grep 字面量）。
- **烘焙的三个写死约定**：降采样规则（空气 / 展示台 / 被丢弃的装饰件不参与投票，≥1 个可映射方块即保留，同票
  下标小者胜）、地块索引 = `(minZ, minX)` 升序、分类表显式（未知源方块名 throw）。改任一条会让总格数落到
  [16000, 18000] 区间外或族标志校验 throw。`.schem` **入库**（烘焙输入，不是渲染资源）；改分类表 / 参数 /
  `.schem` 后必须 `npm run gianttrees`，`check:data` 的 `[巨树]` 指纹会抓。
- **贴图：opaque 通道忽略 alpha → 孔洞处直接露出 RGB**。重着色必须重算**全部**像素的 RGB（含 `alpha=0`），
  `[巨树]` 门禁钉「无近黑像素」。暂存 / 备用贴图不能放进 `assets/textures/`（`build-atlas` 递归扫描 +
  `atlas.spec` 断言 tile 数 ≡ PNG 数）。
- **巨树叶与 `sky_leaves` 同属 `opaqueTable=1` 的实例**（邻居面互剔 + AO 遮挡 + blocklight 阻断 + 炮塔 LOS 阻挡）。
  **树叶投影**（用户裁决）：不写 `shadowCast:false`（`[阴影投射]` 的 13 项清单要求 `leaves` 必须投影，v1.0 的
  写法会让 `check:data` 即红）、不写 `opaque:false`。
- **draw call 有增量**：three r185.1 WebGPU 对 BatchedMesh 每个可见 geometry slot 各发一次 draw；实测 bench
  场景 ① +16 / ④ +41（545 → 586）。往通道里加大量新几何前别假设 draw 不变。
- **已有存档里的森林会长出巨树**（用户接受，未 bump DB 版本）；玩家的 edits 照常覆盖在生成结果之上。
```

**(d)「目录结构」**（3 处插入）：

在 `├─ tools/turret-armor-fingerprint.mjs …` 之后：

```
├─ tools/bake-giant-trees.mjs  # 巨树烘焙（npm run gianttrees）：入库 .schem → 28 变体 2×2×2 降采样
│                              #   → assets/giant-trees/trees.json + trees.meta.json（尺寸+输入指纹）
├─ tools/giant-trees-fingerprint.mjs # 巨树烘焙参数（族表/调色板/分类表/族标志）与指纹共享模块（同上，红线 1）
├─ tools/bake-giant-textures.mjs # 6 张巨树贴图烘焙（npm run gianttextures）：沿用 leaves.png / log_big_oak.png
│                              #   图案只换色 → assets/textures/procedural/giant_*.png
```

在 `│  ├─ turret/ …（烘焙输入，勿当渲染资源）` 之后：

```
│  ├─ giant-trees/             # 巨树景观（v1.68）：src/40AssortedTreesPack.schem（烘焙输入，入库，**非渲染资源**）
│  │                           #   + trees.json / trees.meta.json（烘焙产物）
```

在 `│               #  scatter.js 结构撒布判定 + 代码生成 house/ship（唯一权威；Worker 同构）` 之后：

```
   │               #  giant-trees.js 巨树景观：region 层候选（全局对齐网格 + 内缩抖动）+ column 层光栅化
   │               #    （合并邻域候选 / 排除 / 地基 / 覆盖窗口；Worker 同构）
```

**(e)「开发命令」**：在 `npm run turret …`（三行）之后追加：

```
npm run gianttrees             # 烘焙巨树变体 → assets/giant-trees/trees.json + trees.meta.json（28 个变体）
                               #   改 .schem / tools/giant-trees-fingerprint.mjs（分类表、族表、调色板、降采样参数）后需跑，
                               #   否则产物静默过期（check:data 的 [巨树] 指纹检查会抓）
npm run gianttextures          # 烘焙 6 张巨树贴图 → assets/textures/procedural/giant_*.png（沿用 leaves.png 图案只换色）
                               #   改 tools/bake-giant-textures.mjs 的基色 / CONTRAST 后需跑，再跑 npm run atlas
```

- [ ] **Step 3: 规格状态行**

`docs/superpowers/specs/2026-10-23-giant-trees-design.md` 开头的「**状态**」行：把「设计已评审，用户已逐项裁决（§0.2）；**待实施**」改为「**已交付**（验收报告 `docs/giant-trees-acceptance-report.md`）」。

- [ ] **Step 4: 写验收报告 `docs/giant-trees-acceptance-report.md`**

与 M4~M9 / 矿车报告同结构，**数据一律取 Task 8 / 9 在你机器上的实测输出**（确定性读数——烘焙产物、reserved 占用、单测/用例计数——应与本计划一致；计时类读数以你的为准）。必含小节：

1. **交付范围与验收口径**：对照 spec §1.2 五条逐条打勾（预算 / 确定性与接缝 / 让路 / 不破坏既有玩法 / 观感）。
2. **实测数据**：烘焙产物（28 变体 / 16,954 格 / `trees.json` 152.8 KB）；候选发现耗时与密度；真实页面 reserved 表（5 视域 + 3 冲刺 + `gpuVertexBytes`）；bench 交替对照表（含 draw call 增量）；genP95 交替对照表；单测 779→810、Playwright 184→190。
3. **偏离表**（vs spec v1.1）：写实施中发生的任何偏离；没有就写「无」。
4. **负向验证清单**：烘焙 5 条、单测 15 条、`[巨树]` 门禁 10 条、Tier 4 注入 4 条（A~D）、既有门禁拦下 `shadowCast:false` 与「Worker 同构层 import three」各 1 条，各自的变红用例名。
5. **与 mc-lite 的关系**：mc-lite 没有这些树，无「偏离 mc-lite」问题；`opaqueTable=1` 四项后果与 `sky_leaves` 同族。
6. **遗留 TODO / 已知限制**：装饰件（栅栏 / 台阶 / 半砖 / 活板门 / 楼梯，占素材 3.60%）未实现；树冠重叠的覆盖损失 1.60%（设计意图）；`bench --check` 的 `STRUCTURAL` 分支恒为 false（已另立项）；与 `RedCity-done` 的 `CAPACITY` / 设计文档版本号合并冲突；素材再分发授权由用户确认。
7. **操作失误**：执行中踩过的坑（如在 `/tmp` 下跑脚本解析不到 `playwright`、不带 `--check` 误跑 bench 重写冻结基线等），没有就写「无」。

- [ ] **Step 5: 校验文档没有留下漂移副本**

```bash
npm run check          # 文档同步不影响门禁，但 check:data 的 [物品集合] 数字应与 CLAUDE.md 快照一致（116 = 134 − 18）
grep -n "排除 10\|126 − \|HIDDEN_FROM_INVENTORY.*6 项" CLAUDE.md || echo "CLAUDE.md 里没有残留的旧计数"
```

- [ ] **Step 6: 提交**（仅在用户明确要求提交时）

```bash
git add docs/roadmap.md CLAUDE.md docs/giant-trees-acceptance-report.md docs/superpowers/specs/2026-10-23-giant-trees-design.md
git commit -m "docs: 记录巨树景观 Epic 的活跃约束、交付状态与验收报告"
```

---

## Self-Review

**1. Spec 覆盖检查**

| Spec 章节 | 对应任务 |
|---|---|
| §1.1 三条路径 | Task 4（候选谓词）· Task 5/6（光栅化与接线） |
| §1.2 验收口径 | Task 8（预算门，reserved / 相对 HEAD）· Task 9（全量回归 / bench / genP95） |
| §2.1~2.4 素材结构 / 族群 / 分类 / 降采样 | Task 1（`giant-trees-fingerprint.mjs` + `bake-giant-trees.mjs`） |
| §2.5 预算实测 | Task 3（容量依据）· Task 8（预算门）· Task 10（roadmap 活跃约束详情） |
| §2.6 候选算法校准 | Task 4（网格抖动 + 间距 / 归属 / chance / 耗时用例） |
| §3.1~3.2 数据格式 / 入库 / 体积 | Task 1 |
| §3.3 两段式 | Task 4（region 层）+ Task 5（column 层）+ Task 6（接线） |
| §3.5 column 层（合并 / 排除 / 地基 / 覆盖窗口 / 植物规则） | Task 5 · Task 6 |
| §3.6 方块与贴图（含粉叶预烘焙） | Task 2 · Task 7（门禁） |
| §3.7 旋转 | Task 4 |
| §3.8 性能 / Worker 预热 | Task 6 · Task 9 Step 5 |
| §3.9 容量与显存 / 既有断言同步 | Task 2（4 条计数）· Task 3（容量 + `m3-fullscene`） |
| §3.10 存档兼容 | 无代码；记入 Task 10 的 CLAUDE.md 约束与验收报告 |
| DR-1~DR-17 | DR-1/2/4/6 → Task 4/6；DR-3/11 → Task 2/7；DR-5/14/15 → Task 5/6；DR-7/8/12 → Task 1；DR-9 → Global Constraints；DR-10/17 → Task 3/8/9；DR-13 → Task 10；DR-16 → Task 6/9 |
| §5 测试策略 | Tier 1 → Task 4/5/6；Tier 2 → Task 7；Tier 4 → Task 8 |
| §7 风险与回退 | Task 9（门禁实测）；整体回退见下 |

**2. Review Focus 八条各自的对应用例**

| Review Focus | 落在哪个任务的哪条测试 |
|---|---|
| ① 跨 column 边界 | Task 5「跨 column 光栅化：4 个朝向 × 含非正方形变体，2×2 个 column 逐格 == 期望」 |
| ② 非正方形旋转 | Task 4「treeBox：…全部变体 × 4 个朝向」+ 「旋转：非正方形 AABB 旋转后宽深互换」 |
| ③ 邻域候选拼接 | Task 5「collectGiantTrees：合并全部邻域 layouts…」+ Task 6「真实 GEN：⇔」「森林 column 里确有巨树方块」 |
| ④ 旋转真的发生 | Task 4「giantTreeRotation：四个朝向都会出现且大致均匀」 |
| ⑤ 让路 | Task 5「isGiantTreeAllowed」「collectExclusionBoxes」+ Task 6 的城市 / 撒布 / 地标三条「零闯入」（各带对照） |
| ⑥ 旧植被互斥 | Task 5「覆盖窗口」+ Task 6「覆盖区内零旧植被树」「单格植物不顶掉树干底格」 |
| ⑦ 预算口径 | Task 8（开局初始容量 + reserved 相对 HEAD）+ Task 3 的 `m3-fullscene` 新上限 |
| ⑧ Worker 预热 | Task 6（设计要点 6）+ Task 9 Step 5（交替对照与无预热注入） |

**3. 类型 / 约定一致性**

- `GIANT_STRIDE = 5`：Task 4 定义；Task 5 的 `collectGiantTrees`、Task 6 的 layout 字段测试、Task 8 `giant-trees.spec.mjs` 取 banyan 候选（`a[i]` / `a[i + 2]`，步长 5）都按 5 消费。
- 族序：`GIANT_FAMILY_ORDER`（运行时）与 `TREE_FAMILIES`（烘焙）同名；Task 4 的加载用例断言「族序与 `trees.json` 的族一一对应、变体数与 `trees.meta.json` 一致」。
- `palette[0]` 恒为树干：Task 1 `FAMILY_PALETTES` 定义；Task 4 用例断言 `endsWith('_log')`；Task 5 的地基填充按这个约定认树干。
- 8 个方块名：Task 2 声明 ↔ Task 1 `FAMILY_PALETTES` ↔ Task 7 双向闭包 ↔ Task 8 spec 里的 id 列表，四处同源于 `giant_*` 前缀。
- `applyGiantTrees(…, { allowedAt, ext })`：Task 5 定义；Task 6 的 `apply.js` 调用时 `ext: VEGETATION_EXT`，且 `VEGETATION_EXT` 同时是阶段 3 的扫描外扩（单一常量）。
- 候选 `variantHash ∈ [0, 65536)`：Task 4 用例断言范围；Task 5 `resolveTree` 做 `% list.length`。

**4. 比例检查**

计划里的全部代码块由脚本从隔离副本逐字生成（不是手写转录），已有文件的改动给统一 diff。篇幅大头是三个测试文件与 `giant-trees.js`——这几处「签名 + 一句话」确实不足以让实施者唯一确定（跨 column 光栅化、覆盖窗口、让路判据三件耦合），属允许的例外。

**5. 落地时需要你确认的几处**

- **素材授权**：`40AssortedTreesPack.schem` 是第三方素材包，入库按你的裁决执行；仓库有 GitHub 双推送，再分发是否允许请自行确认。
- **HEAD 前进**：本计划基线是 `218f836`。若 `CAPACITY` / `apply.js` / `blocks-data.js` 已被别的 Epic 改过，先三方合并再套 diff；`RedCity-done` 分支同样把 `CAPACITY.opaque` 设为 `active: 1800`（同值），并占用了设计文档 v1.68 与 `m3-fullscene` 的 `< 196 MiB`，重新落地时按先后顺延版本号。
- **观感（Tier 3）无法由测试证明**：三个旋钮留在你手里——每条路径的 `chance` / `spacing` / `jitter`（`GIANT_TREE_PATHS`，密度）、`bake-giant-textures.mjs` 的基色与 `CONTRAST`（叶色）、B/C 路径 spacing（冠幅重叠程度；提到 10~12 约降 1/3~1/2）。改前两者要重烘焙 / 重跑 `npm run atlas`；`spacing/jitter` 不需要。
- **bench 的 ④ 帧时阻断是已知噪声**，按 Task 9 Step 3 的交替对照判读；`draw call` 增量（①+16 / ④+41）是真实存在的成本，已记入验收口径。

## 整体回退

删 `src/gen/structures/giant-trees.js`、三个 `test-giant-trees*.js`、两个 Tier 4 spec 与 `check-data.mjs` 里的 `[巨树]` 环节；去掉 `apply.js` 的阶段 2.8 与阶段 3 的三处改动（`giant.covers` / 植物规则 / `tree && !inGiant`）及 `giantAllowedAtFor` / `VEGETATION_EXT`（把 `const EXT = VEGETATION_EXT` 还原成 `const EXT = 3`）；还原 `structure-layout.js` 的 `giantTrees` 字段；去掉 `world-worker.js` 的预热两处；删 8 个方块声明 + `faces-data.js` 映射 + `HIDDEN_FROM_INVENTORY` 8 项 + 6 张贴图 + `assets/giant-trees/` + 两个 npm 脚本；重跑 `npm run atlas`；**还原 `CAPACITY.opaque` 与 `m3-fullscene` 的 150 MiB**；同步还原 4 条单测的计数与清单（134→126、HIDDEN 14→6、94→86）；回退设计文档 v1.68 与文档同步（roadmap / CLAUDE.md）。
