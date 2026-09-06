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
（v1.19~v1.31）；第二阶段 **M4 玩家武器已完成并验收**（报告
`docs/m4-weapons-acceptance-report.md`），M5~M7 规格与计划已备好。

**M4 武器操作**：`KeyR` 循环切换徒手/手枪/MAG7/加特林；持枪时左键按住持续射击
（MAG7 单击单发），右键仍可放方块；武器方块破坏默认**关闭**（`game.setGunBlockDamage(true)`
开启，MAG7 不受此开关限制）。三件武器模型为仓库受控 GLB（`assets/models/weapons/`），
复制/替换后须跑 `npm run validate:weapon-assets`；M4 不支持用户导入模型。

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
   ├─ player/    # player / physics / raycast / step-lift / inventory / orientation
   ├─ ui/        # coords-hud / hotbar / inventory / settings-panel / settings / icons
   ├─ save/      # persistence（IndexedDB edits）
   ├─ workers/   # world-worker（GEN/MESH/LIGHT 统一入口，池化）
   ├─ bench/     # 性能基准页
   └─ tests/     # 浏览器内单元测试 + fixture
```

依赖方向单向：`voxel ← gen ← mesh ← render`（`npm run check:arch` 静态门守）。
`src/workers/`、`src/gen/`、`src/mesh/`、`src/voxel/` 不得 import three（Worker 同构约束；
唯一例外 `mesh/atlas-loader.js` 见门禁白名单）。`core/` 是装配层，依赖任何层合法。
