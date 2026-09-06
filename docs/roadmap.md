# mc-heavy 总路线图

> 本文档是**项目进度的唯一总览**。它只回答三个问题：做到哪了、下一步做什么、去哪找细节。
> **不重复内容** —— 架构决策见设计文档，历次改动记录见其修订说明，任务级执行清单见
> `docs/superpowers/plans/`。

最后更新：2026-09-07

## 一句话现状

第一阶段引擎底座（M0~M3）**全部完成并验收达标**，两个收尾补丁项（M3.1 背包 / M3.2 方块朝向）
也已落地。此后是一串独立 bugfix 与改造（v1.19~v1.31）。第二阶段 **M4 玩家武器已完成并验收**
（验收报告 `docs/m4-weapons-acceptance-report.md`），M4 阶段遗留 TODO——设置面板「破坏方块」
开关按钮——已落地（见下节）；M5~M7 规格与计划已备好，等待 M4 之后的实体运行时。

## 里程碑总表

| 里程碑 | 内容 | 状态 | 关键 commit |
|---|---|---|---|
| **M0 骨架** | 脚手架 / Worker 池 RPC / BlockRegistry / atlas / WebGPU 发布路径实测（6 项冻结断言） | ✅ 完成 | `7788751` 起 |
| **M1 体素核心闭环** | 地形生成 / section meshing 双路径 / BatchedMesh 通道级合批 / 玩家物理（step-up + 相机缓动）/ DDA 射线 / 放块挖块 / 最小存档 / 光照（skylight + AO + blocklight + 异步收敛） | ✅ 完成 | `40b73ff` 验收 |
| **M2 结构与世界完整性** | StructureIndex 确定性布局 / 5 地标（城市·金字塔·冰封山·雪地·海岛）/ 树木植被 / 洞穴 / 水面特效 / 日夜循环三风格 / 空中结构（悬浮空岛 + 云层） | ✅ 完成（2026-08-31 关闭） | `4794586` 关闭 |
| **M3 性能达标与收尾** | 全量场景稳态 120fps / 帧预算双档（`src/core/budget.js`）/ 雨效 / HUD + 设置面板 + 随机种子新世界 / 基线脚本 + 回归门禁 / 性能报告 | ✅ 完成（2026-09-02） | `82da106` |
| **M3.1 背包**（M3 收尾补丁项） | 创造模式无限背包 1000 槽（照搬 mc-lite `Slots.js` 语义）/ Z 键面板 / 快捷栏改读 `slots[0..4]` / `uiModal` 模态栈 + keydown 守卫 | ✅ 完成（2026-09-02） | `b19029f` |
| **M3.2 方块朝向放置交互**（M3 收尾补丁项） | mc-lite 三分支放置朝向（门控 / 原位挖放转 90° / 类型记忆）/ 挖块记朝向 / `world.getBlockMeta()` | ✅ 完成（2026-09-03） | `c512cd3` |
| **M4 玩家第一人称武器** | `WorldEditor` 批量编辑 / DDA hitscan / 受控 GLB 相机视图模型 / 曳光 / 音效 / 可选方块破坏 | ✅ 完成（2026-09-05，验收报告 `docs/m4-weapons-acceptance-report.md`） | `ed9a271` |
| **M5 实体运行时** | `EntityManager` / 实体 AABB raycast / 受控渲染层 / 临时与持久实体分离 + `entities` snapshot | ⬜ 等待 M4 | — |
| **M6 丧尸** | 默认 20 上限 / 20Hz 单条 WorkerPool `ai` RPC / 实体与体素最近命中比较 / 25·35·999 三把枪伤害 / 六部件固定 slot 渲染 | ⬜ 等待 M5 | — |
| **M7 玩家放置丧尸巢穴** | 最高 `gold_block` 的 `blockEntity` 为持久真相 / `block-changed` 失效 / 八 offset × 六层刷怪 / 全局最多 8 个 | ⬜ 等待 M6 | — |

## M4 之后的遗留 TODO（M4 阶段 bugfix）

| 事项 | 状态 | 要点 |
|---|---|---|
| 设置面板添加「破坏方块」开关按钮（对齐 mc-lite 配置面板的「枪械破坏设置」，`UIManager.js:160` 开/关两按钮 → `canGunsDestroyBlocks` + HUD 提示） | ✅ 完成（`3fe8626`） | mc-heavy 当前只有 API 入口 `game.setGunBlockDamage(enabled)`（M4 规格 §4.4：「M3 HUD 若已实现设置面板，可直接绑定该 API」）。已落地：`src/ui/settings-panel.js` 照既有 `_makeRow`/按钮组模式加一行，点击调既有 API，不新增机制；默认 `false`（与 mc-lite 一致，破坏开关默认关闭） |

M4 交付后的实玩反馈修正（已落地，记录在验收报告偏离表）：相机入 scene（R 切武器可见）、
pointer-lock 拒绝捕获、曳光粗细对齐 mc-lite + 起点世界空间冻结（v1.33）、武器灯光（v1.34）、
MAG7 曳光终点回归准心轴（v1.36，原用扫描候选当终点导致斜射——移植偏差，非有意偏离）。

## M3.2 之后的独立 bugfix / 改造（v1.19 ~ v1.35）

这些不属于任何已编号里程碑，是实玩反馈驱动的独立改动。**完整记录在设计文档的修订说明**
（每条含根因、实测数据、门禁对照）与 `docs/superpowers/plans/2026-08-20-phase1-remaining-roadmap.md`
（v1.19~v1.21 独立章节、v1.22~v1.31 表格）。此处只列状态与一句话要点：

| 版本 | 事项 | 状态 | 要点 |
|---|---|---|---|
| v1.19 | 异形方块渲染勘误 | ✅ `c307885` | 补记实例原点换算基准（mc-lite 块中心 vs mc-heavy 块底角，比对须 +0.5）；vine 改落格内（有意偏离）；床 UV 取贴图下半修真实 bug |
| v1.20/v1.21 | 背包物品集合口径变更 | ✅ `c307885` | 122 → **118 项**；`chimney` + 床三项移出背包（独立 `HIDDEN_FROM_INVENTORY` 常量）。床渲染镂空问题**未修**，靠不入背包规避 |
| v1.21 | 吊灯材质自发光 | ✅ `c307885` | packed bit13 材质自发光标记 + cutout 通道 emissive 加项，对齐 mc-lite |
| v1.22 | 吊灯 UV 分区与 quad 级自发光 | ✅ `b9b8699` | **已知有意偏离 mc-lite**：绳单色深灰 + 灯体发光暖黄 + 灯面无绳图案 |
| v1.23 | 背包专用图标表 | ✅ `245fb4d` | 台阶类图标与母方块撞脸 → 用 atlas 里 5 张现成手工图标 tile |
| v1.24 | 异形方块等轴测图标 | ✅ `cd0d7d4` | 9 项异形方块改离线烘焙等轴测投影；**形状权威 = mesher `TEMPLATES`** |
| v1.25 | 测试分级策略与静态门禁 | ✅ `8e9f721` | Tier 1~4 判据 + `check:arch` / `check:data` 两个静态门；关系型断言取代硬编码计数 |
| v1.26 | 全量背包图标离线烘焙 | ✅ `176e419` + `c8e9dc9` | **运行时约 91 行 → 1 行**；独立 `icons-atlas.png`；覆盖全量 118 项；`check:data` 加图标过期指纹检查 |
| v1.27 | 背包槽位点选抖动修复 | ✅ `65254f9` | `box-sizing: border-box` 消除选中边框撑高 grid 行（实测位移 2px） |
| v1.28 | 等轴测图标遮挡修复 | ✅ `f76055b` | 深度度量 y 符号修正（`x+y+z`）+ 逐像素深度测试取代 painter 整面覆盖 |
| v1.29 | 设置面板「删除缓存」按钮 | ✅ `598f10b` | `Game.clearSave()` 清 edits **保留 seed 与设置**（与 `newWorld` 换 seed 语义不重叠）；竞态三步抽成共用 `_discardEdits()`；armed 二次确认 |
| v1.30 | 沼泽睡莲水洞与沉水修复 | ✅ `c491e8a` | `TEMPLATES.lilypad` y `0.02`→`-0.48` + 生成格位 `SEA_Y`→`SEA_Y+1`（**两处耦合，单独改任一处都错**）；叶面 -1.48 紧贴水面 -1.50；`big_house.json` 删 3 个草地 lilypad（几何无法同时贴合半格水面与整格草地）。Tier 1 TDD + 双向负向验证 + Tier 4 像素实测（中心 8.9 倍差异） |
| v1.31 | AO 去掉对角门控（凹角阴影连成环） | ✅ `2462e7f` | 用户报告：方块两面都是墙角时，两条阴影各沿凹角垂直延伸，而**东南对角地面格完全不参与** → 阴影在对角处断开露出「阴影的边」。根因实测定位：`mesher.js` `getAO` 对角门控 `(side1\|\|side2)?corner:0`（mc-lite/MC 原版语义）→ 两侧开阔、仅对角遮挡的顶点恒 AO=3。隔离场景实测：对角格 `(9,0,9)` 靠 B 角 AO=3（全亮）、东/南格同位置 AO=2（有阴影），且同一空间顶点 `(9,1,9)` 在不同 quad 里 AO 不一致（2 vs 3）。修复：去门控 → 对角格 AO=2，阴影连成环。**有意偏离 mc-lite 第 ⑤ 项**，副作用全局（所有「仅对角遮挡」顶点暗一档）。Tier 1 TDD（RED `Expected 2, got 3` → GREEN 278/278）+ Tier 4 像素实测（HEAD 1.067 vs 改动侧 0.851，约 19% 差异，双向有效）+ bench `--check` 通过 |

| v1.35 | 设置面板两列布局 + 档位精简 | ✅ `49e7cce` | 用户反馈面板拥挤，且第二阶段（M5~M7）会持续加配置项。改 mc-lite 同款两列盒（`.mc-columns` / `.mc-combined` 合并盒），**行列分配按本仓库档位需要重排、不沿用 mc-lite 分配**（后续新配置优先往右列填）。档位精简三项：① 视距 UI 档位 5→3（`[8,12,16]`），但 `clampVD` 钳制范围 **2~16 不动**（架构口径，测试依赖 `vd=2`）→ 面板须容错「当前值不在档位内」，**刻意不做就近高亮**；② 音量档移出面板（默认 100%，字段仍持久化 + `?volume=` 可达）；③ 新世界 + 删除缓存共用一行。顺带修掉文案漂移：`_resetDangerArmed()` 写死旧长文案覆盖了构造时的短文案 → 抽 `CLEAR_SAVE_LABEL` 共用常量。**用户随后报告合并盒上边框缺失**（本次改动引入）：分隔线规则 `> :first-child` 通配所有子项、特异性 (1,2,0) 压过 `.mc-combined` 的 (1,1,0) → 列首合并盒上边框被置 none；改为只作用 `.mc-item` + 补四边 solid 断言 + 负向验证。单测 296 全绿 + 档位契约断言负向验证（改 `[8,12,20]` → FAIL `Expected 20, got 16`）+ DOM 几何实测（面板 818×398、两列等高 375×255、合并盒四边 solid、零文本溢出）。全量 E2E **55 passed / 1 failed** —— 失败的 `m1-acceptance` `digP95` 是已知 flaky 计时断言（2ms 贴线抖动），**交替对照**实测两侧分布重叠（HEAD 均值 1.833 vs 改动侧 1.933，各 9 样本），机制上不相关（放挖热路径零命中面板代码，spec 用 `vd=8` 在新旧档位都存在） |

## 第二阶段依赖链

```
M4 玩家武器 ──▶ M5 实体运行时 ──▶ M6 丧尸 ──▶ M7 玩家放置丧尸巢穴
（WorldEditor      （EntityManager     （M5 临时实体     （blockEntities 锚点
  + DDA hitscan）    + 实体 raycast）    + M4 武器伤害）   + M6 刷怪）
```

四者**严格串行**（每个 Epic 依赖前一个的运行时底座）。每个 Epic 有成对的规格与计划：
`docs/superpowers/specs/2026-08-23-m{4,5,6,7}-*-design.md` +
`docs/superpowers/plans/2026-08-23-m{4,5,6,7}-*.md`。

**跨 Epic 的已知前置条件**（实施时勿遗漏）：

- M4 Task 6 将 `digBlock()`/`placeBlock()` 改走 `editor.setBlock(...)` 时**须保留朝向分支**
  （M3.2 交付的语义，不得退化为只传 id）；
- M4 Task 6 挂 KeyR 切武器依赖 M3.1 交付的 `uiModal` keydown 守卫；
- M4 plan Task 2 的 `getBlockMeta` 已由 M3.2 **提前交付**，改为「验证已交付 + 补断言」。

## 后续扩展点（M7 之后，按阶段加入）

| 功能 | 引擎接入点 |
|---|---|
| TNT / 爆炸 | `WorldEditor.setBlocks(batch)` + REMESH + 粒子 |
| 炮塔 / 飞行弹丸 | M5 `EntityManager` + 实体 raycast（M5 后独立 Epic） |
| 矿车 / 轨道 | BlockRegistry 的 `interact` / `onStep` 钩子 |
| 创造台 | mesher 顶点模板机制 |
| 灯 / 光源 | emissive 属性 + blocklight flood fill（光照管线已含） |
| 床 / 宝箱 / 门 | 多方块结构 + meta/orientation 位 + `blockEntities` 通道 + 交互事件 |
| 音频 | AudioManager + `block-changed` / 交互事件总线 |
| 存档迁移 | save/codec 的 `schemaVersion` 机制 |
| 玩家生存战斗 | M5 `EntityManager` + 玩家状态/HUD（独立 PlayerVitals Epic） |

**新功能必须通过上述接入点实现，不得绕过 meshing/数据/事件管线另开路径。**

## 验收口径

第一阶段目标表（冷启动 <2s / 视距 8 chunk / 120Hz ≥90fps / 跨 region 无感知 / 放挖 <2ms /
存档 KB 级）见设计文档 §1，**6 项全达标**（实测报告 `docs/m2-m3-performance-report.md`，
= 冻结基线）。mc-lite 对比：视距 ~4×、启动数十~百倍、存档 ~千倍。

每个里程碑结束跑基线，**性能回退 >10% 即阻断合入**（结构类 2%）。

## 去哪找细节

| 想知道 | 看 |
|---|---|
| 架构决策、子系统边界、DR 决策、历次口径变更 | `docs/phase-1-engine-design.md`（**架构唯一权威**，v1.31；修订说明记 v1.1~v1.31） |
| 某次改动为什么这么改、实测数据、门禁对照 | 设计文档对应版本的修订说明 + `docs/superpowers/plans/2026-08-20-phase1-remaining-roadmap.md` |
| 任务级执行清单、依赖关系、验收步骤 | `docs/superpowers/plans/`（各里程碑计划） |
| 该不该写测试、跑哪个门禁 | `docs/testing-policy.md`（**测试分级唯一权威**） |
| 重构红线、对标 mc-lite 的取舍、活跃约束 | `CLAUDE.md`（协作规范） |
| 实测报告 | `docs/m0-bench-report.md` / `docs/m1-acceptance-report.md` / `docs/m2-m3-performance-report.md` / `docs/m2-seed12345-comparison.md` |
| 性能基线当前值 | `docs/m3-baseline.md`（`npm run bench` 自动生成，勿手改） |
| 测试用例数、图标项数等计数 | **以 `npm run check:data` 输出为准**，不在文档硬编码 |
