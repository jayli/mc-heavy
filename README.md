# mc-heavy

从零重写的 Minecraft 风格体素游戏引擎。功能对标姊妹仓库 [mc-lite](../mc-lite)，
但架构完全重做：目标是**同样的玩法 + 更鲁棒、更可扩展、更高性能的引擎底座**。

- 纯 JavaScript（ES Modules + JSDoc），**无 TypeScript、无构建步骤**
- three.js **r185.1**（本地 `vendor/three/`），**WebGPU 唯一后端**
- 体素数据 typed array 为唯一权威，重计算全部在 Worker 池，确定性按需生成（无预生成）

## 快速开始

```bash
npm install          # playwright 固定 ^1.62.1
npm start            # 静态服务 http://localhost:8081
npm run check        # 日常最小门（约 2.6s）= check:arch + check:data + lint
npm test             # Playwright 全部验收（tests/*.spec.mjs）
npm run bench        # 性能基线跑图；加 -- --check 为回归门禁（回退 >10% 阻断）
npm run icons        # 烘焙全量背包图标（改背包内方块贴图/几何后需跑）
npm run atlas        # 重新生成 assets/atlas.png + atlas.json（世界渲染 atlas）
```

用最新版 Chrome / Edge / Safari 26 打开 `http://localhost:8081`（WebGPU 仅在安全上下文可用，
局域网 IP 的 http 地址不行）。浏览器内单测入口：`http://localhost:8081/src/tests/index.html`。

**门禁怎么选**：改贴图地址/文案跑 `npm run check`；改纯函数算法/协议加 `npm test`；
改热路径（mesher/materials/render/scheduler/physics）再加 `npm run bench -- --check`。
判据见 [`docs/testing-policy.md`](docs/testing-policy.md)。

## Git 远端（双 push）

`origin` 配置了**双 push**：`git push origin <分支>` 会同时推送到 GitHub 与内部 GitLab：

- fetch/pull：`git@github.com:jayli/mc-heavy.git`
- push ①：`git@github.com:jayli/mc-heavy.git`
- push ②：`git@gitlab.alibaba-inc.com:bachi/mc-heavy.git`

两个地址串行推送，任一失败则整体报错（另一个可能已推成功，重跑即可）。

## 当前进度

**项目进度的唯一总览是 [`docs/roadmap.md`](docs/roadmap.md)** —— 里程碑总表（M0~M7）、
第二阶段依赖链、后续扩展点接入点。本文档不复制进度信息（避免多副本漂移）。

一句话现状：第一阶段引擎底座（M0~M3）**全部完成并验收达标**，两个收尾补丁项
（M3.1 背包 / M3.2 方块朝向放置交互）也已落地；此后是一串独立 bugfix 与改造
（v1.19~v1.35）；第二阶段 **M4 玩家武器已完成并验收**（报告
`docs/m4-weapons-acceptance-report.md`），**M5 实体运行时已完成并验收**（报告
`docs/m5-entity-runtime-acceptance-report.md`），**M6 丧尸已完成并验收**（报告
`docs/m6-zombies-acceptance-report.md`；丧尸不攻击玩家，无 PlayerVitals），
**M7 玩家放置丧尸巢穴已完成并验收**（报告
`docs/m7-zombie-nests-acceptance-report.md`）—— 第二阶段 Epic 链（M4→M5→M6→M7）全部交付。

**M4 武器操作**：`KeyR` 循环切换徒手/手枪/MAG7/加特林；持枪时左键按住持续射击
（MAG7 单击单发），右键仍可放方块；武器方块破坏默认**关闭**（`game.setGunBlockDamage(true)`
开启，MAG7 不受此开关限制）。三件武器模型为仓库受控 GLB（`assets/models/weapons/`），
复制/替换后须跑 `npm run validate:weapon-assets`；M4 不支持用户导入模型。

**M6 丧尸**：`KeyX` 在玩家附近生成一只丧尸（**调试键**，对齐 mc-lite `Game.js:155`；随机角度
+ 距玩家 2~10 格，向下扫真实地面）。丧尸不攻击玩家（无 `PlayerVitals`），会追逐玩家
（1.2 格/秒），可被武器命中致死（手枪 4 发 / 加特林 3 发 / MAG7 1 发），默认活动上限 20 只。
正式的生成入口是 M7 巢穴，X 键仅用于实玩验证。

**M7 丧尸巢穴**：玩家放置的方块锚定刷怪器，全局最多 8 个，每 8 秒在八个偏移 × 六层里找首个
合法位置刷一只丧尸。放置入口是**背包面板**：`zombie_nest_alias_block` 图标在背包里（与 mc-lite
同口径），选中后右键 → `Player.placeBlock()` 按物品名路由到实体放置 → 一次性写入 **38 个方块**
的整个结构 + 建立锚点（**不是放一个单格方块**）。另有受控测试 API
`game.selectPlaceable('zombie_nest_alias_block')` 供 Playwright 编程驱动。五格 Hotbar 语义不变。
顶端唯一的 `gold_block` 是关键方块：被徒手、武器或 TNT 批量破坏即巢穴失效
（三者走同一编辑入口，故同义）。失效只删锚点，38 个结构方块保留（与 mc-lite 一致，
清除结构是未来 TNT Epic 的职责）。巢穴锚点经 `blockEntities` 随 edits 落盘，
重启与 column 卸载后自动恢复，刷怪节奏不重置。

测试与计数（用例数、图标项数、atlas tile 数）**以 `npm run check:data` 输出为准**，
不在文档硬编码 —— 同一事实的多个副本会漂移。

## 文档索引

| 文档 | 说明 |
|---|---|
| [docs/roadmap.md](docs/roadmap.md) | **项目进度唯一总览**（里程碑总表 + 依赖链 + 扩展点 + 去哪找细节） |
| [docs/phase-1-engine-design.md](docs/phase-1-engine-design.md) | **架构唯一权威**；历次口径变更见其修订说明（v1.1~v1.30） |
| [docs/testing-policy.md](docs/testing-policy.md) | **测试分级唯一权威**（Tier 1~4 判据 + 门禁分层） |
| [CLAUDE.md](CLAUDE.md) | 协作规范（重构红线 / 对标 mc-lite 取舍 / 技术约束 / 活跃约束） |
| [docs/superpowers/plans/2026-08-20-phase1-remaining-roadmap.md](docs/superpowers/plans/2026-08-20-phase1-remaining-roadmap.md) | 任务级执行清单 + v1.19~v1.30 历次改造记录 |
| docs/superpowers/{specs,plans}/2026-08-23-m4-* | M4 玩家第一人称武器（第二阶段首个 Epic） |
| docs/superpowers/{specs,plans}/2026-08-23-m5-* | M5 实体运行时 |
| docs/superpowers/{specs,plans}/2026-08-23-m6-* | M6 丧尸 |
| docs/superpowers/{specs,plans}/2026-08-23-m7-* | M7 玩家放置丧尸巢穴 |
| docs/superpowers/plans/2026-08-19-m0-engine-skeleton.md | M0 实施计划（已完成） |
| docs/superpowers/plans/2026-08-19-m1-voxel-core-loop.md | M1 实施计划（已完成） |
| docs/superpowers/{specs,plans}/2026-08-23-m2-sky-structures* | M2-7 悬浮空岛与云层（已完成） |
| docs/m0-bench-report.md / docs/m1-acceptance-report.md / docs/m2-m3-performance-report.md | 实测与验收报告（M3-6 性能报告 = 冻结基线） |
| docs/m4-weapons-acceptance-report.md / docs/m5-entity-runtime-acceptance-report.md / docs/m6-zombies-acceptance-report.md | 第二阶段 M4~M6 验收报告 |
| docs/m7-zombie-nests-acceptance-report.md | M7 丧尸巢穴验收报告（含 18 条负向验证实测与交替对照） |
| docs/m2-seed12345-comparison.md | M2 同 seed 人工比对清单 |

## 目录结构

```
mc-heavy/
├─ index.html              # import map（本地 vendor/three）+ WebGPU 启动 gate + 准心
├─ vendor/three/           # three.js r185.1（three.webgpu.js / three.tsl.js / three.core.js）
│                          #   + addons/（GLTFLoader 及 r185.1 依赖闭包，M4 武器模型加载）
├─ assets/                 # textures/（含 procedural/ 烘焙产物）+ atlas.png/.json
│                          #   + icons-atlas.png/.json（背包图标，独立于世界 atlas）+ structures/
│                          #   + models/weapons/（受控 GLB：pistol/mag7/minigun）+ sounds/（武器音效）
├─ tools/                  # build-atlas / bake-procedural-textures / bake-icon-atlas /
│                          #   icon-fingerprint / check-architecture / check-data /
│                          #   validate-weapon-assets（受控 GLB 安全与大小验证）
├─ server-script/          # 静态服务（端口 8081）
├─ docs/                   # 设计文档 + 实施计划 + 实测报告
├─ tests/                  # Playwright spec
└─ src/
   ├─ core/      # game / scheduler / worker-pool / budget / perf / perf-hud
   ├─ voxel/     # constants / block-registry / chunk-column / world-data / blocks-data / faces-data
   ├─ gen/       # noise / terrain / structure-index / structures/*（Worker 同构，不 import three）
   ├─ mesh/      # mesher / lighting / atlas-loader / iso-icon（Worker 同构）
   ├─ render/    # render-world（BatchedMesh 发布层）/ materials（TSL）/ weather / rain
   │             #   entity-render-layer（M5 受控实体发布层）/ zombie-renderer（M6 六部件实例渲染）
   ├─ entities/  # entity-manager（动态实体唯一权威 + AABB raycast）/ entity-types（M5，无 three）
   │             #   zombies/（M6：zombie-config 冻结数据 + zombie-system 玩法入口与 60Hz 物理）
   ├─ player/    # player / physics / raycast / step-lift / inventory / orientation / weapons
   ├─ ui/        # coords-hud / hotbar / inventory / settings-panel / settings / icons
   ├─ save/      # persistence（IndexedDB edits + M5 entities store）
   ├─ workers/   # world-worker（GEN/MESH/LIGHT 统一入口，池化）
   ├─ bench/     # 性能基准页
   └─ tests/     # 浏览器内单元测试 + fixture
```

依赖方向单向：`voxel ← gen ← mesh ← render`（`npm run check:arch` 静态门守）。
`src/workers/`、`src/gen/`、`src/mesh/`、`src/voxel/` 不得 import three（Worker 同构约束；
唯一例外 `mesh/atlas-loader.js` 见门禁白名单）。`core/` 是装配层，依赖任何层合法。
