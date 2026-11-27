# mc-heavy

Minecraft 风格体素游戏引擎。功能对标姊妹仓库 [mc-lite](../mc-lite)，
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

- 打开 `http://localhost:8081`。
- 浏览器内单测入口：`http://localhost:8081/src/tests/index.html`。

## 文档索引

| 文档 | 说明 |
|---|---|
| [docs/roadmap.md](docs/roadmap.md) | **项目进度唯一总览**（里程碑总表 + 依赖链 + 扩展点 + 去哪找细节） |
| [docs/tectonic-terrain-migration-survey.md](docs/tectonic-terrain-migration-survey.md) | **下阶段 TODO「丰富地图多样性」的选型依据** —— Tectonic 地形模块可抽离部分的调研报告（三档分级 + 与 `genP95`/红线 1 的冲突实测） |
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



