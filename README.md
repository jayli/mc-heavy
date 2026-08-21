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

第一阶段（引擎底座）分 M0~M3 四个里程碑，**当前处于 M2**（M0/M1 已完成，M2-1 StructureIndex + M2-2 地标/城市已落地）。

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 骨架 | 脚手架 / Worker 池 RPC / Registry / atlas / WebGPU 发布路径实测 | ✅ 完成 |
| M1 体素核心闭环 | 地形生成 / section meshing / BatchedMesh 合批 / 玩家物理交互 / 最小存档 / 光照 | ✅ 完成 |
| M2 结构与世界完整性 | StructureIndex / 地标 / 树木 / 洞穴 / 水面 / 日夜 | ✅ 完成（M2-1~M2-6） |
| M3 性能达标与收尾 | 视距 8 全量调优 / 预算标定 / 雨效 / HUD / 基线脚本 / 报告 | ⬜ 待开始 |

测试现状：**18 个 Playwright spec（21 用例）+ 95 个浏览器内单元测试全绿**；冻结断言达标
（120Hz 本机 fps ≥115、放/挖编辑 p95 <2ms、draw 受控）。

## 文档索引

| 文档 | 说明 |
|---|---|
| [docs/phase-1-engine-design.md](docs/phase-1-engine-design.md) | 架构唯一权威（v1.7 定稿） |
| [docs/superpowers/plans/2026-08-20-phase1-remaining-roadmap.md](docs/superpowers/plans/2026-08-20-phase1-remaining-roadmap.md) | **第一阶段剩余工作执行计划（M2+M3，当前 roadmap）** |
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
