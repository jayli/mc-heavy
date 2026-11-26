# CLAUDE.md

本文件为 mc-heavy 仓库（`~/jaylli/mc-heavy`）的协作规范。所有解释、说明、对话用中文，代码注释尽量用中文。

**本文件只是索引 + 铁律。** 细节都在下面这几份文档里，冲突时以它们为准：

| 文档 | 内容 |
|---|---|
| `docs/testing-policy.md` | 测试分级判据（Tier 1~4）与门禁映射 —— **唯一权威** |
| `docs/pitfalls.md` | **静默失效坑目录**（198 条实测教训，按子系统分节）。动某子系统前先读它那节 |
| `docs/roadmap.md` | 进度、每版改了什么、实测数据与冻结常量 |
| `docs/phase-1-engine-design.md` | 架构细节 |
| `tools/test-tiers.mjs` | 测试分档清单 —— **唯一权威**，`check:data` 双向钉住 |

## 项目定位

从零重写的 Minecraft 风格体素引擎，功能对标姊妹仓库 [mc-lite](/Users/bachi/jaylli/mc-lite)，
但架构完全不同。**mc-lite 的地位是「功能与数据来源」，不是「实现蓝本」**：只提取功能语义、算法、
数据、视觉风格，禁止照搬它的架构组织方式（`FaceCullingSystem` / `ChunkConsolidation` /
`RegionCache` 等多层容器是它的病根，见 `tools/check-architecture.mjs` 的 `FORBIDDEN_NAMES`）。

现状与每版改动一律查 `docs/roadmap.md` 的版本表。**下阶段 TODO：丰富地图的多样性** ——
动地形生成前先读 `docs/tectonic-terrain-migration-survey.md`（与 `genP95` 冻结预算、红线 1 的
水面遮罩 TSL 同构、40 个 `generateHeight` 消费方的冲突实测）。

## 测试执行策略（先读这一节，再动手）

> ⚠️ **这一节是硬规则，不是建议。** 历史上反复犯的错是「改一个模块却跑全套」，
> 把 20 分钟花在根本不 import 被改模块的 spec 上。**默认最小充分集，全套要理由。**

### 默认：最小充分集（绝大多数改动走这条）

1. `npm run check` —— **每次改动都跑**（实测 **5.4s**：arch + data + lint）；
2. `npm run test:unit` —— 改了纯函数 / 协议 / 数据模型才跑（实测 **36.0s**，104 文件 2219 例，无浏览器）；
3. **只跑消费本改动的 spec**。选法：`grep` 出哪些 `tests/*.spec.mjs` import 了被改模块（或经
   `game.js` 装配段消费它），再加上与它共享装配段的邻居 spec。单跑：
   `npx playwright test tests/ignis-spike.spec.mjs tests/ignis-fx.spec.mjs`；
4. 只有**碰了热路径**（mesher / materials / render-world / scheduler / physics）才加
   `npm run bench -- --check`（~5min）。

改动只碰一个 Epic 时，第 3 步通常就是 **1~3 个 spec**。合并进主干后仍只跑这个集合，
但要**补上主干新增的、与本改动共享装配段的 spec**。

### 按区域选档（改动横跨一个区域时用，比逐个 grep 省事）

```bash
npm run test:core     # 25 spec：协议/竞态/物理/编辑/数据契约（含 harness 整页与慢档）
npm run test:ui       # 17 spec：面板/HUD/文案/存档交互
npm run test:entity   # 31 spec：实体玩法/AI/武器
npm run test:struct   # 14 spec：地形与结构落地
npm run test:pixel    # 18 spec：Tier 4 GPU 像素
npm run test:fast     # check + Node 轻档 + 浏览器轻档单测
```

⚠️ **`test:core` 含 `harness` + `harness-slow`**（整页 + 全量 GEN，慢档单条最长 37.5s、
自设 700s 窗口）—— 它**不是**「日常最小门」，别拿它当 check 的替代。

### 什么时候跑全套（`npm test`）

**只有这三种情形**，且要在报告里写明理由：

1. **用户明确要求**跑全套；
2. **里程碑收尾 / 发版前的最终门**（不是每个 Task、不是每次合并）；
3. **改动本身就是全局基础设施**：`tools/test-tiers.mjs` / runner / `playwright.config.mjs` /
   `check-*.mjs` / `src/tests/index.html` 注册 / 方块注册序 / `resource-url.js` ——
   这类改动的消费方是**全部** spec，最小集在结构上不成立。

`npm test` = `node tools/run-unit-node.mjs --all`（含 6 个重 GEN 文件，执行期实测 **217.7s**）
+ **全部 105 个 spec**（含慢档，`harness-slow` 自设 700s 窗口）。
**代价有实测出处**：v3.15 分档设计文档记的历史全量是常态 **3.2min**、高负载 **32.1min**；
2026-11-21 那次跑到 **20 分钟仍未结束、被用户打断**。⇒ **它是分钟级到十几分钟级的开销，
不是「顺手跑一下」**。

### 什么时候禁止跑全套

- ❌ 改文案 / 贴图地址 / alias / 单个参数 → 只 `npm run check`（Tier 3）；
- ❌ 改一个 Epic 的玩法或特效 → 该 Epic 的 spec + Node 轻档，**不跑 `npm test`**；
- ❌ **每个 Task 完成后**、**每次 commit 前**、**合并进 main 后** —— 都不是全套的时机；
- ❌ 为了「确认没弄坏别的」而跑全套 —— 用 grep 证明别的 spec 不 import 被改模块，比跑它们便宜得多；
- ❌ 排查 flaky 时靠反复跑全套 —— 用 **HEAD 副本 + 交替对照**定性一次即可（见下）。

### 长跑纪律

- 预计 > 1 分钟的命令用 `run_in_background`，**不要前台阻塞**；测试命令**不要接管道**
  （`| tail` 会把退出码换成管道末端工具的，测试没跑也显示 exit 0）。
- 已有 flaky（计时型：`m1-acceptance` 放挖 p95、`m3-rain` 截图差分、bench frameP95）
  **看交替对照的分布，不看单次红绿**，且**不改阈值**。
- 计划里标「冻结」的数字不符时**停下来报告**，不擅自改断言或放宽阈值。
- worktree 里跑浏览器验证必须 `MC_PORT=<自己的端口>` 两侧同源，并核对端口归属
  （`lsof -ti:<port>` → `lsof -p <pid>` 看 cwd），否则会对着主仓代码跑（详见 pitfalls）。

### 分级判据（细节见 `docs/testing-policy.md`）

| 级别 | 典型改动 | 要求 |
|---|---|---|
| Tier 1 | 纯函数算法 / 协议 / 数据模型 / 热路径 | **必须 TDD**（RED→GREEN→REFACTOR）+ 门禁 |
| Tier 2 | 物品集合 / 图标表 / 烘焙产物 / 数据契约 | 门禁断言，免 TDD |
| Tier 3 | 文案 / 贴图地址 / alias | 免测试，只跑 `npm run check` |
| Tier 4 | GPU 渲染结果（TSL 在 GPU 求值） | **像素级实测**，不得宣称目视 |

## 常用命令

全部在仓库根目录执行。前置：Node v26、`npm install`（只装 playwright / eslint / pngjs 三个 devDependency）。

```bash
npm start                       # 静态服务 http://localhost:8081（MC_PORT 可改，无构建步骤）
npm run check                   # 日常最小门 = check:arch + check:data + lint（5.4s）
npm run lint                    # eslint src tools tests
npm test                        # 全套：Node 全量单测 + 全部 spec —— 见上节，需理由
npx playwright test tests/dragon.spec.mjs          # 只跑一个 spec
npx playwright test tests/dragon.spec.mjs -g "血量" # 只跑一个用例
npm run bench                   # 4 场景性能基线 → docs/m3-baseline.{md,json}
npm run bench -- --check        # 回归门禁（回退 >10% 退出码 1）
```

**烘焙命令**（离线产物，改了输入不重跑 = 静默渲染旧内容，`check:data` 用指纹抓）。
**烘焙 = 数据格式转换，不产生新美术资源** —— 用户对此敏感，提烘焙方案时第一句要说清它只换格式：

```bash
npm run atlas          # 世界图集 assets/atlas.{png,json}（新增 textures 子目录会重排 tile 坐标）
npm run icons          # 背包图标（改背包内方块贴图/几何后必跑）
npm run water          # 水体贴图（改 ocean.js 水面配色后必须重算并重跑）
npm run leaftextures | gianttextures | grasstextures   # 贴图压缩（之后要 atlas + icons）
npm run stonebricks    # 石砖三变体 + 紫珀（之后要 atlas + icons）
npm run tarn | pyramid | arena | burningarena | ruinedcitadel | junglefortress
npm run shallowtarns | ship | azaleatrees | gianttrees
npm run turretop | zombieskin | dragon | ignis | guardian | nightsky
npm run playerskin     # 第一人称手臂皮肤（改 view-arm-data.js 的 UV 或指纹参数后必跑）
npm run carbineaudio   # KV-9 / 雨声（改 src/render/carbine-audio-recipes.js 后必跑）
npm run validate:weapon-assets
```

`pyramid` / `ship` / `arena` / `shallowtarns` / `tarn` 支持 `-- --census`；`pyramid` / `ship`
另有 `-- --census-orient`（用真实 mesher 重测台阶朝向映射）。`npm run turret` 已随 v3.14 删除。

## 代码地图

依赖方向单向：`voxel ← gen ← mesh ← render`；`core/` 是装配层（可依赖任何层）；
`voxel/gen/mesh/workers/entities` 属 Worker 同构层（红线 8），**不得 import three、不得自建 Worker**
（唯一入口 `core/worker-pool.js`；唯一白名单是 `mesh/atlas-loader.js`）。

| 目录 | 职责（括号内是唯一权威所在） |
|---|---|
| `src/core/` | `game.js` 装配全部子系统（最大文件）/ `scheduler.js` 任务编排与版本协议 / `worker-pool.js` / `world-editor.js`（**所有方块写入**）/ `resource-url.js`（**资源 URL**）/ `perf*.js` |
| `src/voxel/` | `blocks-data.js` 方块声明（→ `block-registry.js` 派生各 table）/ `chunk-column.js` / `world-data.js`（**主线程体素**）/ `constants.js` / `explosion.js` |
| `src/gen/` | `terrain.js`（`generateHeight` / `fillColumn` / 洞穴）/ `noise.js`（biome、`seededRandom`）/ `structure-index.js` / `structures/*`（`apply.js` = **结构层序**，`scatter.js` = **撒布**） |
| `src/mesh/` | `mesher.js`（**形状与 UV**：`TEMPLATES`/`FACE_VERTICES`/`FACE_UVS`）/ `lighting.js` / `iso-icon.js` |
| `src/render/` | `render-world.js`（BatchedMesh 三通道发布）/ `materials.js`（TSL）/ `sun-shade.js` + `hemi-shade.js`（光照标定常数）/ `ocean*.js` / `shadow-manager.js` / 各实体渲染器 / `audio-config.js` |
| `src/entities/` | `entity-manager.js`（**动态实体** + AABB raycast）/ `zombies` `turrets` `minecarts` `zombie-nests` `dragons` `ignis` `guardian` `bosses` `cinder` `playground` |
| `src/player/` | `player.js` / `physics.js` / `raycast.js`（体素 DDA）/ `place-ray.js` / `view-bob.js` / `orientation.js`（放置期朝向） |
| `src/ui/` `src/save/` | HUD / 背包 / 设置面板 / 迷你地图；IndexedDB edits + entities + 进度包编解码 |
| `src/tests/` `tests/` | 浏览器内单测（`test-*.js`，入口 `index.html` 逐条 import）/ Playwright spec（`*.spec.mjs`） |
| `tools/` | 烘焙脚本 + 指纹共享模块（`*-fingerprint.mjs`）+ 两道静态门 + 分档 runner |

**一次列加载（GEN）**：`Scheduler` 派 `gen` RPC（带 `edits` + `layouts`）→ `world-worker` 里
`fillColumn → carveCaves → applyStructuresToColumn → applyEdits → computeSkylight/Blocklight` →
回传三份 typed array buffer → 主线程建 column → `mesh` RPC 逐 section（`buildSectionMesh`）→
三通道 packed 顶点入 `RenderWorld` 的 BatchedMesh。

**一次方块编辑**：`Player` → `WorldEditor.setBlock()`（唯一写入口，含 no-change / 基岩 / 边界过滤）
→ `WorldData.setBlock`（同步重算单列 skylight）→ `scheduler.remeshSections`（玩家挖放走主线程
快速路径，批量走 Worker）→ `enqueueLight` 异步收敛跨列光照 → `_emit` 发 `block-changed` 给装置 controller。

**`apply.js` 的阶段层序是载荷性的**：1 地形 → 2.45 浅水高台 → 2.4 高台地带 → 2 JSON 结构 →
2.7 撒布 → 2.75 高台 / 2.76 金字塔 / 2.8 巨树 / 2.85 杜鹃 / 2.9 竞技场 / 2.93 大竞技场 /
2.94 废弃堡垒 → 2.5 空中结构 → 3 植被。调换会让「树冠打穿屋顶」「祭坛被广场材质盖回」这类
**方块层面看不出因果**的缺陷复活。

## 不可违反的重构红线

1. **数据只有一份权威**：主线程 typed array 体素（`blocks`+`meta`+`blockEntities`）。网格/AO/光照缓存
   全是可重建的派生数据，禁止第二份逻辑副本或「渲染态与逻辑态分离」。
2. **删除预生成**：世界无边界，地形+结构由 seed 确定性生成，存档只存玩家 edits diff。
3. **重计算全部离开主线程**：GEN/MESH/LIGHT 在 Worker 池；主线程只做输入、物理、调度、上传、渲染。
4. **单一 meshing 管线**：面剔除是 meshing 的内部步骤；禁止独立 FaceCulling、consolidation 中间态、
   地形 InstancedMesh、动态↔合并双状态。
5. **发布粒度** section(16³)；BatchedMesh 通道级合批（opaque/cutout/transparent 各一个），
   缓冲耗尽走三级兜底（`unusedVertexCount` → `optimize()` → `setGeometrySize()`）。
6. **体素 DDA 射线**（Amanatides-Woo），禁止对地形 mesh 用 `THREE.Raycaster`。
7. **Worker 池 + 版本协议**：任务带 `(columnKey, version)`，版本不符即丢弃并重新派发；
   禁止为竞态打 epoch/防抖/staging 补丁。
8. **主线程/Worker 同构纯函数**：gen/mesh 核心算法无 DOM 无 three，两条路径共用同一份代码。
9. **WebGPU 唯一后端**：three r185.1 本地 `vendor/three/`（import map），不做 WebGL2 降级。
10. **module worker 不继承 import map**，一律相对路径 import，禁止 import three。
11. **光照**：skylight 垂直不衰减 + 水平 BFS 每格 −1；编辑快路径只升不降（防黑闪）；
    AO/light 的 shade 必须在**顶点阶段**算成 float 经 float varying 传片元（int varying 被强制 flat）。
12. **玩家物理手感**：onGround 自动上台阶（MAX_STEP=1.0，物理瞬时、相机 StepLift 缓动）。

自检四问（任一「是」就停下找统一入口）：引入了第二份权威或新缓存层？把生成期问题推到运行期？
在主线程做了可后台化的重计算？绕过统一管线新开了专属 Worker/子系统？

## 最高频的十几条坑（其余 198 条见 `docs/pitfalls.md`）

**静默失效的通用形态**：数值判据（格数/顶点数/指纹/draw call/帧时）全绿，而画面或玩法是错的。
所以**判据选型比断言数量重要**，每条坑都附了已被实测推翻的写法。

- **断言前先在真实数据上跑一次打印实际值** —— 多数踩坑都是「断言描述想象中的世界」。
- **对照脚本与被测代码只差一个变量**：两侧共用同一个错误假设会得出「两者一致」的假结论。
- **负向验证是必需环节**：注入缺陷后断言必须真 FAIL。注入后要**读回源码确认注入落地**
  （用 `edit` 而非 `sed`，后者静默不匹配）；还原用 `cp` 副本，**不用 `git checkout`**。
- 时间基准统一 `performance.now()`，**禁止 `Date.now()`**（到期判定会恒真/恒假）。
- `WorkerPool.call()` 返回 **`{id, promise}`** 而不是 promise，fake pool 必须同形状。
- **TSL 节点构造类缺陷只能靠真实 GPU 像素探针抓**：`vec3(new THREE.Color())` 输出纯黑、
  `Fn` 返回多键对象全 undefined、`Loop(5, …)` 拿不到 `i`、`maxVertexBuffers=8` ⇒
  逐实例属性最多 7 个。这些在 Node 单测与全部数值判据下**全绿**。
- **像素对照的基线必须冻住五个动态源**（玩家下落 / 海面 / 第一人称手臂 / 昼夜 / viewBob+stepLift），
  只钉 `physics.pos` 远远不够；且要**先藏掉自带同色的宿主实体**。
- **「粒子往上飘」「朝向对不对」这类观感判据，屏幕像素往往零判别力** ——
  改读真实 GPU 属性算相对位移、或读 `getMatrixAt` 算几何投影面积。
- `opaqueTable=1` 有**四项**后果（面剔除 / AO / blocklight / 炮塔 LOS 与弹丸阻挡，最后一项改玩法）。
  只要面剔除就用 `cloud` 手法；非 box 几何必须显式 `"opaque":false`。
- 台阶/栏杆的 facing→orient **只能用真实 mesher 实测定**，不能从 `orientation.js` 或 MC 定义推。
- **资源路径只能走 `resourceUrl()`**，禁止 `'/assets/` 这类站点根绝对路径（子路径部署全 404，
  而本机 dev server 恒为根路径所以测不出来）。`assets/textures/` 被递归扫描，源图别放进去。
- **末尾追加方块不得清档**（用 `fingerprintOfPrefix`）；改方块数后要跑一次 `tests/unit-fast.spec.mjs`
  （`test-inventory-ui.js` 需 DOM，不在 Node 白名单）。
- **短命特效（曳光 0.02s / 火光 0.045s / hitstop 0.022s）的断言必须开火后同步立刻取样**：
  任何 `await`（含 dynamic import）都会让它们自然过期 ⇒ 断言变成在测「过期后不可见」。
  同理：`mount()` 要当场写一次姿态、`onShot()` 要当场点亮火光、切枪**两个分支**都要清特效池。
- **雨的挡雨判据不是 `isSolid`**：云（v1.96 起 solid=true）与树叶族（solid=true）都会拦雨。
  唯一权威在 `render/rain-shelter.js`：实心 ∧ 非 cutout ∧ 非 cloud，上界 = 云簇高度−1（派生）。
- **`AGENTS.md` 是 `CLAUDE.md` 的符号链接** ⇒ 改规范一律 `git add CLAUDE.md`，
  并用 `git show --stat` 核对它真的在提交里。
- **UI 层级不等式**（改任一层必须重核）：hotbar 40 < 迷你地图 45 < 坐标/性能面板 50 = 血心 50 <
  **屏外敌人方位箭头 52** < 伤害数字 55 < **受伤红闪 56** < 设置按钮 60 < 设置面板 70 < 背包 80 <
  背包 hover 浮层 85 < toast 90 < 启动 loading 95 < 启动错误遮罩 100。**不得取 100+**。toast 与浮层 `pointer-events:none`
  ⇒ 判「在最上层」只能走像素。「点了没反应」先查这条。

## 子系统路由表 —— 动手前先读

每个 Epic 都有几十条「实测标定的常量 + 反向验证教训」只存在文档里。**不要凭直觉改它们，
也不要凭直觉「补齐」看起来缺失的分支**（多数「缺失」是刻意的）。
路径前缀：`specs/` = `docs/superpowers/specs/`，`plans/` = `docs/superpowers/plans/`。

| 要动的东西 | 先读 |
|---|---|
| **地形高度公式 / biome / 地图多样性（含 Tectonic 迁移）** | `docs/tectonic-terrain-migration-survey.md` + `src/gen/terrain.js` 的 `TERRAIN_HEIGHT_PARAMS` 注释 + `src/render/ocean.js` 的 `getTerrainHeight` TSL 同构实现 |
| 地形/高台/浅水高台/祭坛/竞技场/大竞技场/废弃堡垒/金字塔/中世纪船/丛林要塞 | 各自 `specs/<日期>-*design.md` + roadmap 同版本行 + `pitfalls.md` 的丛林要塞三节 |
| 光照 / 阴影 / 天空 / 雾 / 水面 / 色温 | `specs/2026-10-13-sun-shadow-map-design.md`、`specs/2026-10-20-sun-shading-and-skybox-design.md`、`specs/2026-10-24-lighting-realism-design.md` + roadmap「光影真实感 / 渲染与容量」 |
| 结构撒布 / 巨树 / 杜鹃 / 植被 | roadmap「结构撒布」「巨树」「树叶与镂空遮挡体」段 + `specs/2026-10-23-giant-trees-design.md` |
| 龙 / Boss / 火球 / 实体伤害 | `specs/2026-11-03-altar-dragon-design.md` + `specs/2026-11-03-dragon-boss-ai-design.md` + roadmap v2.41~v2.48 |
| 末影守卫（废弃堡垒 Boss） | `specs/2026-11-11-ender-guardian-boss-design.md` + `plans/2026-11-11-ender-guardian-boss.md` + roadmap v2.91 + `pitfalls.md` 坐标与旋转节 |
| 焰魔 / 尖刺剑阵 / 武器特效 | roadmap v3.20~v3.27 + `pitfalls.md` 渲染与 GPU 节；原版 Java 源码在 `~/jaylli/cataclysm1.19.2modding` |
| 丧尸 AI / 寻路 | `plans/2026-11-04-zombie-pathfinding.md`、`specs/2026-11-02-zombie-obstacle-avoidance-design.md`、`specs/2026-11-04-zombie-model-rebuild-design.md` |
| **丧尸行为层（犹豫/后退/徘徊/包络/限速）** | `specs/2026-11-16-zombie-behavior-realism-design.md` + roadmap v3.11 + `pitfalls.md` 丧尸行为层节 |
| 矿车 / 装置（巢穴、炮塔、创造台） | `specs/2026-09-30-minecart-design.md`、M7/M8/M9 spec + roadmap「方块锚定装置」段 |
| 放置 / 交互 / 玩家物理 | `specs/2026-10-30-place-nearest-first-design.md`、`specs/2026-10-25-player-flight-design.md` |
| **KV-9 卡宾枪 / 曳光 / 换弹 / 弹壳** | `specs/2026-11-22-kv9-carbine-and-storm-lighting-design.md` + `pitfalls.md` 短命特效节 + 上游 `~/jaylli/bj-shooting-game/night-heron-src/src/game/weapon.js` |
| **第一人称手臂 / 挖块碎片 / 奔跑晃动** | `specs/2026-11-27-opuscraft-dig-fx-and-view-arm-design.md` + `pitfalls.md`「第一人称视图模型」节 + 上游 `~/jaylli/OpusCraft`（`render/handRenderer.ts` / `textures/skin.ts`）。⚠️ 三个视图模型的步态幅度唯一权威在 `render/view-bob-config.js`；手臂几何/UV 在 three-free 的 `render/view-arm-data.js` |
| **地形多样性（OpusCraft 候选）** | `docs/opuscraft-terrain-migration-survey.md`（2026-11-27，含成本/形态/选址/可走性实测）—— 与 Tectonic 那份是同一 Epic 的两个候选上游 |
| **雨天光影档 / 持续雨 / 湿地面 / 后处理** | 同上设计稿 §10~§11 + `pitfalls.md`「雨雾光栅扫描与湿地面地下透射」「屏幕竖纹粗糙与关档后雨声残留」两节 + `src/render/rain-shelter.js`（遮挡权威）+ `src/render/ground-reflect-config.js`（**湿地面必须独立 pass**：海平面镜面在几何上不可能正确）。⚠️ **远景雨幕已整层移除**（MSAA 不能替代 FXAA，柱面细丝必走样）—— 不要凭直觉补齐 |
| 面板 / HUD / 小地图 / 音效 | roadmap「面板与 UI」「渲染分辨率档位」段 + `plans/2026-10-29-minimap.md` |
| **屏外敌人方位箭头 / 敌人计数行** | `specs/2026-11-26-enemy-arrow-intuitive-bearing-design.md`（v3.43，**现行**）+ `src/ui/enemy-arrows.js` 文件头。☠️ v3.42 的 `|cz|` 相机空间方案**已被用户实玩推翻**（抬头时身后丧尸跑到上边）—— 方位只吃 yaw，可见性才用含 pitch 的相机空间 |

## 调试入口

- 浏览器内单测 `/src/tests/index.html`，结果在 `window.__MC_TEST_RESULTS__`
  （`{suites:[{tests:[]}], passed, failed, total}`，用例要 `suites.flatMap(s => s.tests)`）；
  分档参数 `?only=light` / `?tier=slow`；
- 基准页 `/src/bench/webgpu-publish.html`（`window.__BENCH__`）；
- 游戏页暴露 `window.__MC_GAME__` 与 `window.__MC_BOOT__`，Playwright 经此编程驱动（无头无键鼠）；
- 一次性探针 spec 放 `tests/tmp-*.spec.mjs`（已 gitignore + `testIgnore`，勿提交；
  显式单跑要 `MC_ALLOW_TMP=1`）；
- URL 开关：`?vd= ?seed= ?style= ?fog=0 ?skybox=0 ?shadows=0 ?reflect=0 ?res=perf ?chunkpace=
  ?weather= ?stats=0 ?log=1`（完整清单见 `src/ui/settings.js` 的 `resolveSettings` 与 `src/main.js`）。
  ⚠️ `?shadows=0` **只关阴影 pass，不关太阳方向推进**。

## 生成物（不要手改）

`assets/atlas.{png,json}`、`assets/icons-atlas.png` + `icons.json`、`assets/structures/*`、
`assets/{zombie,dragon,turret,ignis,guardian,giant-trees,azalea-trees,sky/night}/` 里的产物、
`assets/textures/procedural/*`、石砖四张 PNG + `stone_bricks.meta.json`、
`docs/m3-baseline.*`（冻结基线，`npm run bench` 不带 `--check` 会自动重写它 ——
诊断后要 `git checkout` 恢复，提交它等于静默放宽门禁）。

每个烘焙产物都有伴随 JSON 指纹 + `check:data` 守住过期。**已知盲区：只改烘焙算法而不动参数时
指纹不变** → 靠产物契约测试与 Tier 4 兜住。

## 沟通与提交

- 设计取舍引用设计文档章节号；改动后附验证证据（命令输出、帧时、draw call），不凭感觉宣称通过。
- **提交必须等明确指令**，Conventional Commits（`feat:`/`test:`/`chore:`/`perf:`/`docs:`）。
- `origin` 配了**双 push**（GitHub + 内部 GitLab），串行推送，任一失败整体报错而另一个可能已推成功
  → 重跑即可，不要改 remote 配置绕开；fetch/pull 只走 GitHub。
- 诊断 bug 不猜：先复现、读实际数据定位根因再改。出现机制上不可能的数值时**先怀疑测量方法**。
- 沙箱禁止 `rm` 时用 `mv` 清理；临时脚本放 `/tmp` 或项目内并即时删除，不要用通配符批量删。