# AGENTS.md

本文件为 mc-heavy 仓库（`~/jaylli/mc-heavy`）的协作规范。所有解释、说明、对话请使用中文，代码注释尽量使用中文。

## 项目定位

mc-heavy 是一个**从零重写**的 Minecraft 风格体素游戏引擎。功能对标姊妹仓库
[mc-lite](/Users/bachi/jaylli/mc-lite)（995 次提交、约 5.5 万行 JS、124 种方块），但架构完全不同：

- mc-lite 是「功能驱动 + 补丁叠加」长出来的，性能天花板已锁死（视距 2~3 chunk、预生成数十秒、
  扩图卡顿、奔跑掉帧）；
- mc-heavy 的目标是**保持同样的玩法功能**，用更鲁棒、更可扩展、更高性能的引擎底座重做一遍，
  第一阶段（M0，当前阶段）只做引擎骨架，矿车、炮塔、丧尸、TNT、创造台等功能按后续阶段加入。

**mc-lite 的地位是「功能与数据来源」，不是「实现蓝本」。** 读它的代码时只提取
「功能语义、算法、数据、视觉风格」，禁止照搬它的架构组织方式（详见下文「对标 mc-lite」）。

## 权威文档（动手前必读）

按顺序读完再写代码：

1. [`docs/phase-1-engine-design.md`](/Users/bachi/jaylli/mc-heavy/docs/phase-1-engine-design.md)
   —— 架构唯一权威，当前版本 v1.7（已定稿）。所有子系统边界、DR 决策、验收口径都在这里。
2. [`docs/superpowers/plans/2026-08-19-m0-engine-skeleton.md`](/Users/bachi/jaylli/mc-heavy/docs/superpowers/plans/2026-08-19-m0-engine-skeleton.md)
   —— M0 实施计划，任务级 TDD 步骤，按 checkbox 执行。
3. `docs/m0-bench-report.md` —— M0 Task 7 的实测报告（执行到该任务后产出）。

规则：

- 设计与实现冲突时，**以设计文档为准**，不要用「实现方便」推翻已核验的设计决策；
- 实施必须按计划的任务与步骤走（Red-Green-Refactor），禁止跳步或省略失败验证；
- 计划中标注「冻结」的断言数字（draw call 数、setGeometryAt 阈值等）实测不符时
  **停下来报告，不要擅自改断言或静默放宽**；
- 需要新增机制/改动设计时，先更新设计文档再动代码，不在代码里埋「计划外补丁」。

## 不可违反的重构红线

这些是 mc-heavy 与 mc-lite 的本质区别，任何实现都不得回退：

1. **数据只有一份权威**：主线程 typed array 体素数据（`blocks` + `meta` + `blockEntities`）。
   网格、AO、可见面、碰撞、光照缓存全是**可随时重建的派生数据**。禁止引入第二份逻辑副本、
   多层缓存、或「渲染态与逻辑态分离」的容器。
2. **删除预生成**：世界无边界、无 `safeBounds`。地形 + 结构由 seed 确定性生成，chunk 进加载半径
   才生成，何时何地重算结果一致。存档只存玩家修改（edits diff）。
3. **重计算全部离开主线程**：GEN/MESH/LIGHT/REMESH 在 Worker 池跑。主线程每帧只做
   输入、物理、调度、上传、渲染。禁止在主线程跑全量 meshing/AO/结构布局。
4. **单一 meshing 管线**：面剔除是 meshing 的内部步骤。禁止独立 FaceCullingSystem、
   consolidation 中间态、地形 InstancedMesh、动态 mesh↔合并 mesh 双状态。
5. **发布粒度**：section(16³) 是重建/脏标记单元；默认 BatchedMesh 通道级合批
   （opaque/cutout/transparent 各一个），fallback 为 column 级 channel-major 3-group。
   顶点格式为 flat 三属性 `position/uv/packed(uint32)`。
6. **体素 DDA 射线**：玩家对地形求交互用 Amanatides-Woo 遍历，禁止对地形 mesh 做
   `THREE.Raycaster.intersectObjects`。
7. **Worker 池 + 版本协议**：异步任务携带 `(columnKey, columnVersion)`，回传版本不符即丢弃。
   禁止为竞态打 epoch/防抖/staging 之类的补丁（这是 mc-lite 的病根）。
8. **主线程/Worker 同构纯函数**：gen/mesh 核心算法无 DOM、无 three 依赖，主线程快速路径与
   Worker 精修路径共用同一份代码、输出同构缓冲。
9. **WebGPU 唯一后端**：three **r185.1**，仅经 CDN import map 引入；不做 WebGL2 降级；
   启动 `navigator.gpu` gate 不通过即明确提示中止。
10. **module worker 约束**：worker 不继承页面 import map，`src/workers/` 下任何文件
    **不得 import three**，一律相对路径 import 本项目模块。

### 重构评审四问（写代码前自检）

任何新改动若对下列任一问题回答「是」，先停下来对照设计文档找统一入口：

- 是否引入了第二份权威数据/新缓存层？
- 是否把生成期问题推到了运行期（buffer 分发、跨 chunk 补刷）？
- 是否在主线程做了可后台化的重计算？
- 是否绕过统一管线新开了一个专属 Worker/子系统？

## 对标 mc-lite：能搬什么、禁止搬什么

### 直接复用（数据 / 算法 / 视觉）

- `src/constants/BlockData.js` → `src/voxel/blocks-data.js`（124 方块声明，转换规则见计划 Task 5）；
- `src/assets/textures/` → `assets/textures/`（122 张：116 顶层 + `bed/` 6 张，文件名原样保留）；
- `src/world/structures/*.json` → `assets/structures/`（原样复用）；
- `src/workers/maps/*`（CityMap/Pyramid/FrozenMountain/SnowLand/IslandMap/RegionCenterUtils）
  → `src/gen/structures/*`（**算法照搬，接口改为 `Structure.rasterize(aabb)`，按 chunk 裁剪**）；
- `AOUtils`（四角 AO）、`OrientationUtils`（朝向 0-3）、`MathUtils`（seededRandom/noise/biome）算法；
- `Physics.js` 的碰撞语义、`Inventory/HUD/UIManager` 的 DOM 方案、`Engine.js` 的天空/雾/日夜/水面 shader；
- `SaveConfig` 的 DB 命名约定（老存档迁移工具后续接入）。

### 必须重写（只保留功能语义）

- 体素存储：`Map<chunkKey, Map<encodeCoord, entry>>` → `Uint16Array` column + 稀疏 edits；
- 玩家交互：`THREE.Raycaster` 对 InstancedMesh 求交 → 体素 DDA；
- 地形渲染：每类型 InstancedMesh 全立方体 → 逐面 meshing + BatchedMesh 合批；
- 持久化：整块 blockData 序列化 → edits diff + 确定性重生成。

### 禁止搬（mc-lite 的补丁架构，职责已被新管线吸收）

`FaceCullingSystem`、`FaceCullingWorker`、`ChunkConsolidation`、`BlockScatterManager`、
`GlobalInstancedMeshManager`、`WorldBoundsController`、`WorldGenerationService`（预生成）、
`AOBridge`、`AOWorker`、`WorldBlockDataStore`、`RegionCache`、`WorldChunkPayloadRegistry`
等多层容器与运行期分发状态机——**这些层次在新引擎中不存在，禁止以任何形式复活**。
设计文档附录 A 有完整模块映射表，移植前先查表。

## 技术约束

- **纯 JavaScript（ES2022+ ES Modules）+ JSDoc，禁止 TypeScript，无编译/转译、无 bundler**；
- three.js **r185.1**，import map 从 CDN 加载 `three.webgpu.js`/`three.tsl.js`；
- 端口 **8081**（mc-lite 占 8080，避免并行开发冲突）；
- 纹理 atlas：2048×2048、2px gutter、半 texel UV 内缩；7 张 250~362px 大图按 128×128 入图；
- ESLint 9 flat config（以 mc-lite 配置为底，本仓库五处修改见计划 Task 1 Step 3）；
- Conventional Commits（`feat:`/`test:`/`chore:`/`perf:`）；
- 每个任务结束必须 commit；**未获明确指令不得自动提交**。

## 目录结构（目标态）

```
mc-heavy/
├─ index.html                  # import map（three@0.185.1 webgpu）+ 启动 gate
├─ docs/
│  └─ phase-1-engine-design.md # 架构权威（v1.7）
├─ tools/build-atlas.mjs       # atlas 离线打包（npm run atlas）
├─ assets/
│  ├─ textures/                # 从 mc-lite 复制
│  ├─ atlas.png + atlas.json   # 生成产物，提交入库
│  └─ structures/              # 从 mc-lite 复制 JSON
└─ src/
   ├─ core/        # Game.js / Engine.js / scheduler.js / worker-pool.js / perf.js
   ├─ voxel/       # block-registry.js / chunk-column.js / world-data.js / edits.js
   ├─ gen/         # noise.js / biome.js / terrain.js / structure-index.js / structures/*
   ├─ mesh/        # mesher.js / lighting.js / section-mesh.js / atlas-loader.js（M0 落盘名；设计文档 §5 记为 atlas.js）
   ├─ render/      # render-world.js / sky.js / water.js / shadows.js / materials.js
   ├─ player/      # player.js / physics.js / raycast.js / interaction.js / inventory.js
   ├─ save/        # persistence.js / codec.js
   ├─ ui/          # hud.js / hotbar.js / inventory-ui.js
   └─ workers/     # world-worker.js（GEN/MESH/LIGHT 统一入口，池化）
```

依赖方向单向：`voxel ← gen ← mesh ← render`，反向依赖禁止。`core/` 不依赖 `voxel/`；
`voxel/` 不依赖 three。M0 阶段还会新增 `src/tests/`、`src/bench/`、`tests/`（Playwright spec）
与 `server-script/`，以 M0 计划为准。

## 开发命令（M0 Task 1 落地 package.json 后生效）

```bash
npm install                    # playwright 固定 ^1.62.1（复用本机 chromium-1234 缓存）
npm start                      # 静态服务 http://localhost:8081
npm test                       # Playwright 全部验收（tests/*.spec.mjs）
npm run lint                   # eslint src tools tests
npm run atlas                  # 重新生成 assets/atlas.png + atlas.json
```

- 浏览器内单测入口：`http://localhost:8081/src/tests/index.html`；
- 测试 runner 暴露 `window.__MC_TEST_RESULTS__`，Playwright 从页面读取断言；
- 性能基准页：`http://localhost:8081/src/bench/webgpu-publish.html`（暴露 `window.__BENCH__`）。

## 测试工作流（TDD，沿用 mc-lite）

1. **RED**：先写失败测试；2. **验证 RED**：运行确认按预期失败；3. **GREEN**：最小实现；
4. **验证 GREEN**：全部通过；5. **REFACTOR**：重构保持绿；6. 重复。

测试一开始就通过，说明测试写错了或在测已有行为。修改 `src/**/*.js` 后任务结束前跑
`npm run lint`，保持新增代码 0 error（warning 可接受）。

## 性能验收口径（第一阶段）

| 指标 | 目标 |
|---|---|
| 冷启动到可玩 | < 2s（出生点邻域先就绪，视距内后台填充） |
| 默认可视距离 | 8 chunk（128 格），架构支持 16+ |
| 奔跑帧率 | 60fps 稳定；120Hz 设备 ≥ 90fps |
| 跨 region 行走 | 无感知卡顿 |
| 放块/挖块 | 单帧内视觉生效（快速路径 < 2ms） |
| 存档体积 | 仅存 edits diff，KB 级 |

- 主线程帧预算按 8.3ms（120fps）标定：mesh 上传 ≤ 3ms、快速路径 ≤ 2ms、光照 ≤ 1ms/帧；
- 每个里程碑结束跑基线，**性能回退 >10% 即阻断合入**；
- CI 帧率采样只做趋势参考，**本机设备矩阵才是硬验收**。

## 实测环境事实（2026-08-19，勿凭印象改）

- Playwright **1.62.1** 对应 chromium-1234（本机缓存已存在），不要降级到 1.59.1；
- headless WebGPU 矩阵：Playwright 默认 headless shell 零 flag **拿不到 adapter**；
  必须 `channel: 'chromium'` 才能零 flag 走 Metal（本机真 GPU）；
  Linux CI 用 `--enable-unsafe-webgpu --use-angle=swiftshader --enable-dawn-features=allow_unsafe_apis`；
  `--enable-features=Vulkan` 在 macOS 无作用，勿加。

## 后续功能扩展点（引擎稳定后按阶段加入）

TNT/爆炸（`world.setBlocks(batch)` + REMESH）、炮塔/子弹/丧尸（EntityManager + 实体射线）、
矿车/轨道（BlockRegistry `interact`/`onStep` 钩子）、创造台（mesher 顶点模板）、
灯/光源（emissive + blocklight flood fill）、床/宝箱/门（多方块结构 + `blockEntities` 富状态通道）、
音频（`block-changed` 事件总线）、设置持久化。**新功能必须通过上述接入点实现，
不得绕过 meshing/数据/事件管线另开路径。**

## 沟通与提交纪律

- 全部使用中文；解释设计取舍时引用设计文档章节号；
- 改动前说清楚「为什么」，改动后附验证证据（命令输出、帧时、draw call 数），不凭感觉宣称通过；
- 提交必须等用户明确指令，提交信息用 Conventional Commits。
