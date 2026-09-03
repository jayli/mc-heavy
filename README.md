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
npm test             # Playwright 全部验收（tests/*.spec.mjs）
npm run lint         # eslint src tools tests
npm run atlas        # 重新生成 assets/atlas.png + atlas.json
```

用最新版 Chrome / Edge / Safari 26 打开 `http://localhost:8081`（WebGPU 仅在安全上下文可用，
局域网 IP 的 http 地址不行）。浏览器内单测入口：`http://localhost:8081/src/tests/index.html`。

## 当前进度

第一阶段（引擎底座）分 M0~M3 四个里程碑，**M0~M3 全部完成**（M3 于 2026-09-02 提交 `82da106`）；第一阶段验收口径全部达标。
M3 后插入两个收尾补丁项：**M3.1 背包**（v1.16 定稿；2026-09-02 完成并提交 `b19029f`）与
**M3.2 方块朝向放置交互**（v1.17 定稿、v1.18 实施回填；2026-09-03 实施完成），随后进入第二阶段，
按 M4 玩家武器 → M5 实体运行时 → M6 丧尸 → M7 玩家放置丧尸巢穴的独立 Epic 链推进。

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 骨架 | 脚手架 / Worker 池 RPC / Registry / atlas / WebGPU 发布路径实测 | ✅ 完成 |
| M1 体素核心闭环 | 地形生成 / section meshing / BatchedMesh 合批 / 玩家物理交互 / 最小存档 / 光照 | ✅ 完成 |
| M2 结构与世界完整性 | StructureIndex / 地标 / 树木 / 洞穴 / 水面 / 日夜 / 悬浮空岛与云层 | ✅ 完成（2026-08-31 同 seed 人工比对通过 + 关闭回归全绿） |
| M3 性能达标与收尾 | 视距 8 全量调优 / 预算双档标定 / 雨效 / HUD+随机种子新世界 / 基线脚本+门禁 / 性能报告 | ✅ 完成（2026-09-02 提交 `82da106`；§1 目标表 6 项全达标，报告 `docs/m2-m3-performance-report.md`） |
| M3.1 背包（M3 收尾补丁项） | 物品模型 `Slot`/`Inventory`（1000 槽位、创造模式每格 count=1500 占位不消耗）/ Z 键背包面板（122 项）/ 快捷栏改读 slots / `uiModal` 模态栈 + keydown 守卫 | ✅ 完成（2026-09-02；设计文档 v1.16 定稿口径收口） |
| M3.2 方块朝向放置交互（M3 收尾补丁项） | mc-lite 三分支放置朝向（门控 / 原位挖放转 90° / 类型记忆）/ 挖块记朝向 / `world.getBlockMeta()` | ✅ 完成（2026-09-03；设计文档 v1.17 定稿 + v1.18 实施回填；门控复用 `orientationModesTable`，启用集合 40 项两侧零差异，不参与旋转 86 项） |
| M4 玩家第一人称武器（第二阶段） | `WorldEditor` / DDA hitscan / 受控 GLB 视图模型 / 曳光 / 音效 | ⬜ M3.2 已提交，可开始 |
| M5 实体运行时（第二阶段） | `EntityManager` / 实体 raycast / 受控实体渲染 / 临时与持久 snapshot；持久实体先冻结异步保存，可取消，成功后的下一帧才最终卸载 | ⬜ 等待 M4 验收 |
| M6 丧尸（第二阶段） | 默认 20 临时丧尸 / 20Hz 批量 AI / 25/35/999 武器命中 / 六部件固定 slot 渲染；无 PlayerVitals | ⬜ 等待 M5 验收 |
| M7 玩家放置丧尸巢穴（第二阶段） | `blockEntities` 锚点 / `block-changed` 失效 / 八 offset × 六层刷怪 / 全局 8 个上限 | ⬜ 等待 M6 验收 |

测试现状：**27 个 Playwright spec 文件（44 个测试用例）+ 238 个浏览器内单元测试全绿**；冻结断言达标
（120Hz 本机 fps ≥115、放/挖编辑 p95 <2ms、draw 受控）；性能基线门禁 `npm run bench -- --check`
（回退 >10% 阻断合入，结构类 2%）。

## 文档索引

| 文档 | 说明 |
|---|---|
| [docs/phase-1-engine-design.md](docs/phase-1-engine-design.md) | 架构唯一权威（v1.18 定稿 + M3.2 实施回填校正） |
| [docs/superpowers/plans/2026-08-20-phase1-remaining-roadmap.md](docs/superpowers/plans/2026-08-20-phase1-remaining-roadmap.md) | **第一阶段剩余执行计划与后续路线图（M2–M7，当前 roadmap）** |
| [docs/superpowers/specs/2026-08-23-m2-sky-structures-design.md](docs/superpowers/specs/2026-08-23-m2-sky-structures-design.md) | M2-7 悬浮空岛与云层设计规格 |
| [docs/superpowers/plans/2026-08-23-m2-sky-structures.md](docs/superpowers/plans/2026-08-23-m2-sky-structures.md) | M2-7 TDD 实施计划 |
| [docs/superpowers/specs/2026-08-23-m4-player-weapons-design.md](docs/superpowers/specs/2026-08-23-m4-player-weapons-design.md) | M4 玩家第一人称武器设计规格（第二阶段首个 Epic） |
| [docs/superpowers/plans/2026-08-23-m4-player-weapons.md](docs/superpowers/plans/2026-08-23-m4-player-weapons.md) | M4 TDD 实施计划（M3 验收后执行） |
| [docs/superpowers/specs/2026-08-23-m5-entity-runtime-design.md](docs/superpowers/specs/2026-08-23-m5-entity-runtime-design.md) | M5 实体运行时设计规格（M4 验收后） |
| [docs/superpowers/plans/2026-08-23-m5-entity-runtime.md](docs/superpowers/plans/2026-08-23-m5-entity-runtime.md) | M5 TDD 实施计划 |
| [docs/superpowers/specs/2026-08-23-m6-zombies-design.md](docs/superpowers/specs/2026-08-23-m6-zombies-design.md) | M6 丧尸设计规格（M5 验收后） |
| [docs/superpowers/plans/2026-08-23-m6-zombies.md](docs/superpowers/plans/2026-08-23-m6-zombies.md) | M6 TDD 实施计划 |
| [docs/superpowers/specs/2026-08-23-m7-zombie-nests-design.md](docs/superpowers/specs/2026-08-23-m7-zombie-nests-design.md) | M7 玩家放置丧尸巢穴设计规格（M6 验收后） |
| [docs/superpowers/plans/2026-08-23-m7-zombie-nests.md](docs/superpowers/plans/2026-08-23-m7-zombie-nests.md) | M7 TDD 实施计划 |
| [docs/superpowers/plans/2026-08-19-m0-engine-skeleton.md](docs/superpowers/plans/2026-08-19-m0-engine-skeleton.md) | M0 实施计划（已完成） |
| [docs/superpowers/plans/2026-08-19-m1-voxel-core-loop.md](docs/superpowers/plans/2026-08-19-m1-voxel-core-loop.md) | M1 实施计划（已完成） |
| [docs/m0-bench-report.md](docs/m0-bench-report.md) | M0 WebGPU 发布路径实测报告 |
| [docs/m1-acceptance-report.md](docs/m1-acceptance-report.md) | M1 验收报告 |
| [AGENTS.md](AGENTS.md) | 协作规范（重构红线 / 对标 mc-lite / 技术约束） |

## 目录结构

```
mc-heavy/
├─ index.html              # import map（本地 vendor/three）+ WebGPU 启动 gate + 准心
├─ vendor/three/           # three.js r185.1（three.webgpu.js / three.tsl.js / three.core.js）
├─ assets/                 # textures / atlas.png / atlas.json / structures
├─ tools/build-atlas.mjs   # atlas 离线打包
├─ server-script/          # 静态服务（端口 8081）
├─ docs/                   # 设计文档 + 实施计划 + 报告
├─ tests/                  # Playwright spec（14 个）
└─ src/
   ├─ core/      # game / scheduler / worker-pool / perf / perf-hud
   ├─ voxel/     # constants / block-registry / chunk-column / world-data / blocks-data / faces-data
   ├─ gen/       # noise / terrain（Worker 同构，不 import three）
   ├─ mesh/      # mesher / lighting / atlas-loader（Worker 同构）
   ├─ render/    # render-world（BatchedMesh 发布层）/ materials（TSL）
   ├─ player/    # player / physics / raycast / step-lift
   ├─ save/      # persistence（IndexedDB edits）
   ├─ workers/   # world-worker（GEN/MESH/LIGHT 统一入口）
   ├─ bench/     # WebGPU 发布路径基准页
   └─ tests/     # 浏览器内单元测试 + fixture
```

依赖方向单向：`voxel ← gen ← mesh ← render`。`src/workers/`、`src/gen/`、`src/mesh/`、
`src/voxel/` 不得 import three（Worker 同构约束）。
