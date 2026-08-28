# 第一阶段剩余执行计划与后续路线图（M2–M7）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成设计文档 §7 第一阶段的 M2（结构与世界完整性）和 M3（性能达标与收尾），达成 §1 目标表全部验收指标；并登记以 M3-6 冻结基线为门的 M4–M7 独立 Epic 依赖与执行顺序。

**前置文档:**
- 设计文档：`docs/phase-1-engine-design.md`（v1.14，架构/数据层/渲染/光照/调度全量设计）
- M0 计划：`docs/superpowers/plans/2026-08-19-m0-engine-skeleton.md`
- M1 计划：`docs/superpowers/plans/2026-08-19-m1-voxel-core-loop.md`
- M0 实测报告：`docs/m0-bench-report.md`
- M1 验收报告：`docs/m1-acceptance-report.md`

---

## 当前进度总结

### M0 骨架 ✅ 完成

| 项目 | 状态 | 备注 |
|---|---|---|
| 项目脚手架 + import map + ESM | ✅ | `"type": "module"`，无构建步骤 |
| Worker 池 + RPC（installRpcHandler） | ✅ | `src/core/worker-pool.js` |
| PerfMonitor + PerfHUD | ✅ | `src/core/perf.js` + `src/core/perf-hud.js` |
| BlockRegistry + atlas 构建 | ✅ | 124 种方块、122 张纹理 |
| WebGPU 发布路径实测（6 项冻结断言） | ✅ | `docs/m0-bench-report.md` |

### M1 体素核心闭环 ✅ 完成

| 项目 | 状态 | 备注 |
|---|---|---|
| WorldData / ChunkColumn / edits | ✅ | typed array 唯一权威 |
| 地形生成（无结构） | ✅ | heightmap + biome 5 种 + 地层 + 水面填充 |
| section meshing（快速+精修双路径） | ✅ | 逐面 + 面剔除 + AO + 三通道 flat 缓冲 |
| BatchedMesh 通道级合批发布 | ✅ | 3×BatchedMesh + reservedVertexCount + setGeometryAt |
| 玩家移动/物理/DDA 射线/放块挖块 | ✅ | 60Hz 定步长 + step-up + 相机缓动 |
| 最小存档（edits 持久化） | ✅ | IndexedDB + 重启恢复 |
| 发布层确认门（M1 决策门） | ✅ | BatchedMesh 维持，120fps 锁定 |
| 光照（skylight/AO/blocklight） | ✅ | 垂直+水平扩散 + 顶点阶段 float varying + 异步收敛 |
| 准心 | ✅ | 20×20 白色十字 SVG |

### M1 后修复（实玩 bug）✅ 完成

| 修复 | commit | 备注 |
|---|---|---|
| BatchedMesh 缓冲耗尽兜底 | `ad84b0f` | optimize + setGeometrySize |
| 自动上台阶（step-up） | `f506209` | mc-lite tryStepUp 移植 |
| 上台阶相机 ease-out 缓动 | `a9b7bbd` | StepLift 视觉层 |
| 挖块后新暴露面全黑 | `7ed0195` | setBlock 增量重算同列 skylight |
| AO 着色器映射倒置 + 准心 | `a9d4593` | mc-lite AONodeSystem 曲线 |
| AO 渐变缺失（flat 插值） | `9eb7779` | shade 移到顶点阶段 float varying |
| skylight 升级垂直+水平扩散 | `9115c60` | Minecraft 模型 + Worker 异步收敛 |
| 编辑后光照永不收敛 | `d8dc765` | remeshSections 补 enqueueLight |
| 放块瞬间黑闪 | `ee28053` | 同步重算只升不降 |
| 初始化阴影检测死代码 | `77e8550` | 判据修正 + halo 前置 |

### M2 结构与世界完整性 🔧 主体完成（M2-7 追加，收尾中）

| 项目 | 状态 | 备注 |
|---|---|---|
| M2-1 StructureIndex + 确定性结构布局 | ✅ | per-region 布局 + 跨 region 查询 + GEN 门控（`structure-index.js`） |
| M2-2 地标移植（城市/金字塔/冰封山/雪地/海岛） | ✅ | 类型/公式逐行核验与 mc-lite 一致；**同 seed 截图比对留人工验收（挂起）** |
| M2-3 树木 + 植被 | ✅ | 四型树 / 花草仙人掌 / cross 模板 + _addOptimized 包围剔除 |
| M2-4 洞穴 | ✅ | 3D 噪声挖空 + mc-lite rooms 保留 |
| M2-5 水面特效 | ✅ | TSL 海面 + 水纹理入 atlas |
| M2-6 日夜循环 | ✅ | morning/noon/night 三风格 |
| M2-7 空中结构（悬浮空岛 + 云层） | ⬜ | 追加任务：确定性空岛、单云层、连通云簇；不含宝箱/天空树，详见 `2026-08-23-m2-sky-structures.md` |

### M2 后修复（实玩 bug）🔧 进行中

| 修复 | commit | 备注 |
|---|---|---|
| 光照黑面根因 | `4c840cd` | 写回改中心 column 权威 + 移除阳光遮挡投影（v1.9 决策） |
| 世界数据看板 + 调试开关 + 控制台日志 | `3a02dbc` | §4.9 worldStats/statsLog，`?stats=0`/`?log=0` |
| 方块类型/贴图/几何全面对齐 mc-lite | `d11a8b0` | ±X 面 UV 90° 旋转修复（BoxGeometry 口径）；faces-data 124 方块六面全覆盖；`tools/bake-procedural-textures.mjs` 烘焙 21 张 mc-lite 程序化贴图（atlas 124→145）；12 种特殊几何顶点模板（台阶/栏杆/柱子/烟囱/床/吊灯/仙人掌，逐格复刻 geomMap）；树叶 FrontSide + alphaTest 0.3（冠内不过密）、植被双向绕线；cross 第二张图横躺回归修复 |
| 朝向渲染消费侧 + 台阶等 12 方块 blended 通道穿帮 | `584813b` | mesher 读 meta 低 2 位按 4 朝向旋转（模型面查 tile/床 UV 变换，世界面做剔除/光照/AO）；getSectionView 打包 meta + MESH transfer；渲染侧无条件消费（对齐 mc-lite 逐实例应用 b.orientation）；交互侧放置语义属第二阶段。另：M0 转换混同 isTransparent（剔除语义）与材质透明度 → 台阶/栏杆/柱子/宝箱等 12 个不透明材质方块 depthWrite=false，L 形凹角无深度互遮透视穿帮；cullMode 改 cutout 修复（设计文档 §4.1 勘误） |
| 城市覆写残留自然地形丘清除 + 树植根城市地表 | `7d09cf1` | fillColumn 预填整列自然地形，generateCity 仅覆写至城市地表 → 自然高度 > 城市地表的列（seed=12345 占 20.6%，最高差 11 格）残留接地自然地形丘，凸出地表包裹建筑；generateCity 清除 surfaceY+1..naturalH + 回退 pointContext 的 max 补丁（5b6c51e）使树植根城市地表；过渡带台阶不受影响 |

## 全局 TODO List（按执行次序）

1. [ ] **M2 收尾（完成下列退出门后才可关闭 M2）**：
   - [x] **水面颜色随镜头转动突变**（[issue #2](https://github.com/jayli/mc-heavy/issues/2)）：
     根因：两层透明物体（体素水 `transparent` 通道 BatchedMesh + `ocean.js` 海面）均无 `renderOrder`，
     three 按排序锚点 NDC 深度定先后——海面锚点钉在相机正下方（恒定），体素锚点为合并几何包围球中心
     （世界原点附近），排序值随镜头转动在 -174~+283 摆动，跨过海面值时绘制顺序翻转、混合结果突变。
     修复：`ocean.js` 海面 `plane.renderOrder = 1` 恒后画，退出深度排序；新增 `tests/water-order.spec.mjs`
     全周扫描顺序稳定性断言（RED→GREEN）。详见 issue #2 根因评论。
   - [ ] **M2-7 空中结构**：按 `docs/superpowers/specs/2026-08-23-m2-sky-structures-design.md` 与
     `docs/superpowers/plans/2026-08-23-m2-sky-structures.md` 重写 mc-lite 的悬浮空岛和云层；必须走
     StructureIndex + Worker GEN + column 裁剪，不含宝箱/天空树、`structureCenters` 或运行期补刷；同 seed
     视觉验收与视距 8 性能门通过后才可关闭 M2。
   - [x] **城市覆写残留自然地形清除**（原"城市边缘残块"，措辞修正：残丘底部接地、非悬空）：
     `fillColumn` 按自然 biome 预填整列，`generateCity` 仅覆写至城市地表，自然高度高于城市地表的列
     （seed=12345 实测占城市列 20.6%，最高差 11 格）残留**接地的自然地形丘**（grass/dirt/stone），凸出于
     城市地表并包裹按城市地表放置的建筑；`5b6c51e` 曾以"树植根点取 max(城市地表, 自然地表面)"绕过。
     修复：`generateCity` 清除 `surfaceY+1..naturalH` 残留 + 回退 `pointContext` 的 max 补丁使树植根城市
     地表；过渡带台阶（`getCityFinalSurfaceY`）不受影响。已补固定 seed/column 复现 fixture + 完整
     Playwright 回归，不破坏城市建筑、地标或 edits 语义。
   - [ ] **同 seed 人工视觉验收**：在 mc-lite 与 mc-heavy 固定相同 seed、相同位置和相近相机朝向，
     对城市、金字塔、冰封山、雪地、海岛、悬浮空岛与云层逐项截图比对；按设计文档 §7/§8 仅确认结构轮廓和配色基调，
     不做像素级 diff；将结论及已知有意差异记录回本路线图的 M2-2 验收项。
   - [ ] **收尾回归与关闭记录**：在上述两项完成后运行完整 Playwright suite，复核出生城市天际线和跨
     region 行走口径，并将 M2 状态从“主体完成，bug 修复中”更新为“完成”。
2. [ ] **M3 第一阶段验收**：完成视距 8 调优、雨效、HUD、基线脚本和性能报告；M3-6 报告是冻结基线。
3. [ ] **M4 第二阶段首个 Epic**：只在 M3-6 验收后开始，交付玩家第一人称手枪/MAG7/加特林的
   `WorldEditor`、DDA hitscan、受控 GLB 视图模型、曳光和音效。规格：
   `docs/superpowers/specs/2026-08-23-m4-player-weapons-design.md`；计划：
   `docs/superpowers/plans/2026-08-23-m4-player-weapons.md`。
4. [ ] **M5 实体运行时**：M4 验收后交付 `EntityManager`、实体 AABB raycast、受控实体渲染层、
   临时/持久实体分离和 `entities` snapshot；持久实体卸载采用“冻结/异步保存、可取消、成功后下一帧同步
   最终移除”协议，不夹带具体敌人、炮塔或矿车。规格：
   `docs/superpowers/specs/2026-08-23-m5-entity-runtime-design.md`；计划：
   `docs/superpowers/plans/2026-08-23-m5-entity-runtime.md`。
5. [ ] **M6 丧尸**：M5 验收后交付默认上限 20 的临时丧尸、20Hz 单条 WorkerPool `ai` RPC、
   实体/体素最近命中比较、25/35/999 的三把枪实体伤害与六部件固定 slot 渲染；不含玩家生命、
   近战或死亡/重生，巢穴另列 M7。规格：
   `docs/superpowers/specs/2026-08-23-m6-zombies-design.md`；计划：
   `docs/superpowers/plans/2026-08-23-m6-zombies.md`。
6. [ ] **M7 玩家放置丧尸巢穴**：M6 验收后，以巢穴最高 `gold_block` 的 `blockEntity` 为持久真相，
   保留“玩家放置、全局最多 8 个、关键方块破坏即失效”的 mc-lite 语义；不是 StructureIndex 地标。
   规格：`docs/superpowers/specs/2026-08-23-m7-zombie-nests-design.md`；计划：
   `docs/superpowers/plans/2026-08-23-m7-zombie-nests.md`。

### M2 收尾 TODO（全局 TODO 第 1 项的执行清单）

#### M2 关闭前必须完成

- [x] **水面颜色随镜头转动突变**（[issue #2](https://github.com/jayli/mc-heavy/issues/2)，已修复 `71c0d90`，用户实机验证通过）：
  站在水边观察水面，镜头转到某个特定角度后水面颜色**瞬间变浅**，转回即恢复——颜色变化是离散跳变而非
  连续渐变。排查结论（包装 `renderer.render` 读 `_renderLists.transparent` 实测）：双层透明叠加
  （体素水 `transparent` 通道 + `ocean.js` 海面，均 `depthWrite=false` 无 `renderOrder`）的绘制顺序由
  排序锚点 NDC 深度决定——海面锚点 = 相机正下方平面中心（恒定 ≈ -0.6），体素锚点 = BatchedMesh 合并
  几何包围球中心（世界原点附近，含预留缓冲），随镜头转动在 -174~+283 摆动；两者交叉时
  `reversePainterSortStable` 顺序翻转（岸边实测每圈交叉两次），混合结果离散突变。ocean.js 着色器
  各分支均为距离连续函数，已排除。修复：海面 `plane.renderOrder = 1` 恒在体素水（默认 0）之后绘制；
  `tests/water-order.spec.mjs` 断言 yaw 全周扫描绘制顺序唯一且体素水先、海面后（修复前 RED：
  出现 `voxelWater,ocean` 与 `ocean,voxelWater` 两种顺序）。完整回归 23/23 通过。
- [x] **城市覆写残留自然地形清除**（原"城市边缘残块"）：`fillColumn` 按自然 biome 预填整列，
  `generateCity` 仅覆写至城市地表，自然高度高于城市地表的列（seed=12345 实测占城市列 20.6%，
  最高差 11 格）残留**接地的自然地形丘**（非悬空），凸出于城市地表并包裹按城市地表放置的建筑。
  mc-lite 稀疏存储不预填城内自然地形故无此问题。修复：`generateCity` 清除 `surfaceY+1..naturalH`
  （`naturalH` 另取 `generateHeight`，勿用传入的 CITY 压平 `h`）+ 回退 `pointContext` 的 max 补丁
  （`5b6c51e`）使树植根城市地表。已补固定 seed/column 复现 fixture + 完整 Playwright 回归。
- [ ] **M2-7 空中结构**：实施 `docs/superpowers/plans/2026-08-23-m2-sky-structures.md` 的三项任务；
  固定 seed 下验证空岛/云层确定性、跨 column 裁剪、云可站立但非实心，以及视距 8 性能门。空岛仅含
  `sky_stone`/`sky_grass`，不迁移宝箱和天空树；云保留单云层与 30..50 块连通云簇。
- [ ] **同 seed 截图与 mc-lite 比对**（M2-2/M2-7 挂起验收项）：人工固定相同 seed、地点、相机朝向，
  覆盖城市/金字塔/冰封山/雪地/海岛/悬浮空岛/云层；验证结构轮廓与配色基调，不做像素 diff。将比对结果和有意差异
  写回 M2-2 验收项，再关闭该挂起项。
- [ ] **M2 关闭回归**：城市修复和人工比对均完成后，完整 Playwright suite 必须全绿；复核出生点城市
  天际线与跨 region 行走无卡顿，更新本路线图、AGENTS.md、README.md 的 M2 状态。

#### 非阻断观察项（不阻塞 M2 关闭）

- [ ] （可选）**CITY 光晕**：chunk 中心在城内、列在城外时，mc-lite 给 sand/sand 地表，mc-heavy
  给自然 biome 地表（`WorldWorker.js:994`）。单独评估是否值得作为 M2 视觉一致性优化，未采纳时记录理由。
- [ ] **m1-acceptance 计时 flaky 观察**：放挖 p95 断言在高负载下偶发贴线（16.7±1e-6/2.1ms），
  非回归（不同断言轮流失败、单独复跑通过）；以实机帧率为准，冻结断言不擅改。若连续出现同一断言失败，
  再按实际数据启动诊断。
- [x] **朝向交互侧暂不实现**（原地重转 90°/类型记忆）：第二阶段随床/宝箱/门落地，第一阶段只预留
  meta 数据位。

### 测试现状

- 19 个 Playwright spec 文件（22 个测试用例，均全绿；m1-acceptance 计时断言高负载下偶发贴线 flaky）
- 120 个浏览器内单元测试（harness）
- 冻结断言：fps ≥90（120Hz 本机 ≥115）、编辑 p95 <2ms、draw 受控；atlas 145 tile（124 + 21 程序化烘焙）

---

## M2 结构与世界完整性（1~1.5 周）

**验收口径（设计文档 §7）：** 出生点可见城市天际线；地标（含悬浮空岛与云层）与 mc-lite 结构轮廓/配色基调一致（同 seed 同位置截图人工比对）；跨 region 行走无卡顿。

### Task M2-1: StructureIndex + 确定性结构布局

**目标：** 实现结构索引系统，支持确定性按需生成大型结构（城市/金字塔/冰封山/雪地/海岛），解决跨 region 溢出问题。

**mc-lite 参照：**
- `src/workers/structure-index/StructureCandidateIndex.js`（候选扫描）
- `src/workers/structure-index/LargeStaticCandidateCollector.js`（大型结构）
- `src/workers/structure-index/StaticTreeCandidateCollector.js`（树木）
- `src/utils/CityPlacementUtils.js`（城市布局）
- `src/utils/StructureUtils.js`（结构工具）

**设计文档参照：** §4.2（地形与结构生成）、§2.1（跨 region 溢出）、DR-13（布局主线程算一次广播）

**实现要点：**
- [x] StructureIndex：per-region 确定性布局（seed 驱动），查询时同时查本 region + 相邻 8 region（设计文档 §4.2 跨 region 溢出解法；跨界 column 取基 region 并集）
- [x] 布局在 Worker 内计算（'layout' RPC），主线程缓存转发（DR-13；每帧预算 4 + 就近优先级）
- [x] GEN 任务依赖：某 region 的 GEN 必须等该 region 及相邻 region 的布局就绪（scheduler 门控）
- [x] 结构类型：布局含 city / pyramid / frozenMountain / snowLand / plainLand / island（TREE 归 M2-3 植被）
- [x] 结构占位：在 fillColumn 之后、光照之前叠加结构方块（apply.js；M2-1 落地金字塔，其余地标 M2-2）

**测试：**
- [x] 同 seed 同 region 布局确定性（两次生成结果一致；城市布局与 mc-lite CityMap 同 seed 逐字段比对一致）
- [x] 跨 region 边界结构不截断（snowLand 无 clamp 跨界用例）
- [x] GEN p95 仍 <8ms（structure-gen fixture：含结构注入 16 column 并行实测）

### Task M2-2: 地标移植（城市/金字塔/冰封山/雪地/海岛）

**目标：** 将 mc-lite 的 5 种地标移植到新引擎的 GEN 管线。

**mc-lite 参照：**
- `src/workers/maps/CityMap.js`（城市）
- `src/workers/maps/Pyramid.js`（金字塔）
- `src/workers/maps/FrozenMountain.js`（冰封山）
- `src/workers/maps/SnowLand.js`（雪地）
- `src/workers/maps/IslandMap.js`（海岛）
- `src/workers/maps/PlainLand.js`（平原）
- `src/workers/maps/RegionCenterUtils.js`（region 中心）

**实现要点：**
- [x] 每种地标一个纯函数 `generate<Name>(wx, wz, h, info, setBlock, seed)`，Worker 同构（不 import three；Math.random 全部 seededRandom 化）
- [x] 城市：固定 region [0,0]（mc-lite 语义），建筑高度/密度由 seed 决定；出生点改 City 中心（mc-lite getCitySpawnPoint 语义，保证出生即见天际线）
- [x] 金字塔/冰封山/海岛：随机中心偏移 100-400（CENTER_OFFSET），半尺寸 40-80
- [x] 雪地：biome 叠加（snow_grass 表面 + 海底 sand 分支 + 3% short_grass）
- [x] 结构方块写入 column.blocks（不走 setBlock——不记 edits、不 bump version）
- [x] JSON 结构光栅化（城堡等 18 种城市建筑 + 海岛塔 + 平地金字塔岛，Worker 内 fetch 缓存 + AABB 裁剪 + ground support 补柱）

**测试：**
- [x] 出生点视距 8 内可见城市天际线（city-visual spec：nonSky 0.73、城堡在中心、高层方块 >20、稳态 120fps）
- [~] 同 seed 截图与 mc-lite 比对：算法级逐字段核验（城市布局与 mc-lite CityMap 同 seed 完全一致；地标公式逐行移植）；mc-lite 随机 seed 需人工 setSeed 截图比对，留人工验收
- [x] 跨 region 行走无卡顿（平原冲刺 fps 117、GEN p95 <8ms）

### Task M2-3: 树木 + 植被

**目标：** 移植树木/花/草/仙人掌等植被生成。

**mc-lite 参照：**
- `src/workers/structure-index/StaticTreeCandidateCollector.js`
- `src/world/entities/Tree.js`

**实现要点：**
- [x] 树木：确定性位置（seed 驱动），树干 + 树冠（Tree.js 四型移植，Math.random 确定性化；桦树/雪桦走 JSON）
- [x] 花/草/仙人掌：biome 相关密度（mc-lite 概率原样），cross/lilypad 顶点模板（mesher 实现，cutout DoubleSide）
- [x] 植被不遮挡光照（solid=false → opaque=0，skylight 穿透；草格上方实测 15）

**测试：**
- [x] FOREST biome 有树木
- [x] DESERT biome 有仙人掌
- [x] 植被不产生 opaque 阴影

### Task M2-4: 洞穴

**目标：** 实现洞穴生成（3D 噪声挖空）。

**mc-lite 参照：** mc-lite 无洞穴（新引擎新增功能，设计文档 §4.2 提及）

**实现要点：**
- [x] 3D 值噪声（`noise3D(x, y, z, seed)` 三线性插值），阈值 0.72 挖空
- [x] 洞穴深度范围：y ∈ [WORLD_MIN_Y+4, 地表-4]
- [x] 洞穴不穿透基岩层（范围钳制）
- [x] 洞穴内 skylight=0（垂直光照自动正确，§4.6/DR-14）
- [x] mc-lite rooms 空腔保留（LCG 逐 column 确定性，地层深度 k 语义原样）

**测试：**
- [x] 洞穴存在（随机采样 column 有空气格在地表以下）
- [x] 洞穴不穿透基岩
- [x] 洞穴内全黑（skylight=0）

### Task M2-5: 水面特效（海面 + 体素水）

**目标：** 实现动画海面（TSL 材质）+ 体素水渲染优化。

**mc-lite 参照：**
- `src/core/Engine.js:631-841`（800×800 PlaneGeometry 海面 + 跟随相机）
- `WATER_LEVEL_OFFSET`（海面高度）

**实现要点：**
- [x] 海面：800×800 平面 + TSL NodeMaterial（波浪/Blinn-Phong 高光/Fresnel/距离淡出/水域遮罩，移植 mc-lite Engine.js）
- [x] 海面跟随相机（无限水面）
- [x] 体素水：transparent 通道 + 新增水纹理入 atlas（替换 M1 占位 water_placeholder）
- [x] 水面高度 = SEA_Y + 0.5（WATER_LEVEL_OFFSET=-1.5，mc-lite 语义）

**测试：**
- [x] 海面可见（water-visual spec ratio 0.42）
- [x] 体素水与海面交界（同色族蓝，截图核验）
- [x] 水面动画流畅（fps 120）

### Task M2-6: 日夜循环 + 三种视觉风格

**目标：** 实现日夜循环 + 早晨/正午/黑夜三种视觉风格切换。

**mc-lite 参照：**
- `src/core/Engine.js:35-209`（VISUAL_STYLE_KEYS + visualStyles 配置）
- 三种风格：MORNING（暖色晨光）/ NOON（正午）/ NIGHT（低照度+星空）

**实现要点：**
- [x] 日夜循环：时间驱动（0-24h 关键帧线性插值，1200s 一天，正午起步）
- [x] 三种视觉风格：morning/noon/night 配置表（天空色/雾色/雾距/skyDim/blockBoost，移植 mc-lite visualStyles）
- [x] 风格切换：game.setVisualStyle(key)（M3 设置面板接入点已留）
- [x] 黑夜：uSkyDim 压暗 skylight + uBlockBoost 相对增强 blocklight（体素材质顶点阶段 uniform）

**测试：**
- [x] 三种风格切换后画面明显不同（luma noon 0.56 / morning 0.53 / night 0.20）
- [x] 日夜循环平滑过渡（分段线性连续，无跳变）
- [x] 黑夜 blocklight 相对增强（blockBoost 1.2 > 1）

### Task M2-7: 空中结构（悬浮空岛 + 云层）

**目标：** 重写 mc-lite 的静态悬浮空岛、单云层和连通云簇，使其成为确定性、按需生成的体素世界内容；不迁移宝箱与天空树。

**mc-lite 参照：**
- `src/world/entities/Island.js`（8% chunk 候选、Y=40..69、半径 5..9、高 5..7、sky_stone/sky_grass）
- `src/world/entities/Cloud.js`（单云与 30..50 块四邻接云簇）
- `src/workers/WorldWorker.js:1125-1127,2457-2471`（旧生成入口，仅取语义）

**设计与完整 TDD 步骤：** `docs/superpowers/specs/2026-08-23-m2-sky-structures-design.md` 与
`docs/superpowers/plans/2026-08-23-m2-sky-structures.md`。不得把 mc-lite 的 `structureCenters`、跨 chunk
缓存、`Math.random` 或运行期补刷移入本仓库。

**验收：**
- [ ] 固定 seed 的 layout 与任意加载顺序逐格一致；空岛跨 column 无截断，只含岛体，不含 chest/天空树。
- [ ] 单云层和 30..50 块连通云簇均完整生成；云可站立、非实心、透明且不遮光。
- [ ] 同 seed 截图确认空岛/云层轮廓与配色基调；视距 8、队列收敛后通过 M3 冻结 fps/draw 口径。

---

## M3 性能达标与收尾（1 周）

**验收口径（设计文档 §7）：** §1 目标表全部达标；输出性能报告。

### Task M3-1: 视距 8 全量调优

**目标：** 视距 8（289 column）全量加载 + 地表/空中结构 + 洞穴 + 水面 + 日夜，fps ≥90（120Hz 本机 ≥115）。

**实现要点：**
- [ ] 全量场景（城市 + 悬浮空岛 + 云层 + 洞穴 + 水面 + 日夜）下 fps ≥90
- [ ] GEN/MESH/LIGHT 队列不积压（inflight 稳定）
- [ ] 内存预算达标（§4.10：体素 ~37MB + GPU 顶点 ~100MB）

**测试：**
- [ ] m1-acceptance 全量场景版（视距 8 + 地表/空中结构 + 洞穴）
- [ ] 内存快照（performance.memory / GPU buffer 统计）

### Task M3-2: 预算参数标定（60Hz/120Hz 双档）

**目标：** 根据设备刷新率自动调整帧预算参数。

**实现要点：**
- [ ] 检测 `screen.refreshRate` 或 `matchMedia('(min-refresh-rate: 120hz)')`
- [ ] 120Hz：MESH_UPLOAD_BUDGET_MS=3、MESH_DISPATCH_PER_FRAME=64
- [ ] 60Hz：MESH_UPLOAD_BUDGET_MS=6、MESH_DISPATCH_PER_FRAME=128
- [ ] 设置面板可手动覆盖

**测试：**
- [ ] 60Hz 模拟（`--force-device-scale-factor=1 --disable-frame-rate-limit`）fps ≥55
- [ ] 120Hz 本机 fps ≥115

### Task M3-3: 雨效

**目标：** 实现粒子雨效（mc-lite 已有，移植）。

**mc-lite 参照：** `src/core/Engine.js`（weather/rain 相关）

**实现要点：**
- [ ] 粒子系统：InstancedMesh 或 Points + TSL 材质
- [ ] 雨滴跟随相机（视距内）
- [ ] 天气状态机：晴 → 雨 → 晴（随机周期）

**测试：**
- [ ] 雨效可见（截图有雨滴粒子）
- [ ] 雨效下 fps ≥90

### Task M3-4: HUD 完善

**目标：** 完善 HUD（帧率面板 + 坐标 + 设置面板 + 快捷栏）。

**mc-lite 参照：**
- `src/ui/HUD.js`
- `src/ui/UIManager.js`
- `src/ui/Inventory.js`

**实现要点：**
- [ ] 帧率面板（已有 PerfHUD，增加 draw/section/light 统计）
- [ ] 坐标显示（x, y, z + biome）
- [ ] 设置面板（视距/画质/音量/视觉风格）
- [ ] 快捷栏（5 格，数字键切换，已有 HOTBAR 逻辑）

**测试：**
- [ ] HUD 元素可见（截图）
- [ ] 设置面板切换视距后生效

### Task M3-5: 性能回归基线脚本

**目标：** Playwright 自动跑图采样帧时，输出性能报告。

**设计文档参照：** §8（性能验证方案）

**实现要点：**
- [ ] 自动跑图脚本：驱动玩家沿固定路线奔跑（含跨 region、进城市、贴墙转向）
- [ ] 采集帧时分布（p50/p95/p99）、GEN/MESH/LIGHT 队列、上传耗时
- [ ] 输出对比报告（markdown 表格）
- [ ] 基线场景 4 个：① 平原冲刺 ② 城市中心环视 ③ 连续放/挖 200 块 ④ 模拟 TNT 批量删除 500 块

**测试：**
- [ ] 跑图脚本可重复执行（无 flaky）
- [ ] 性能回退 >10% 即阻断合入（CI 门禁）

### Task M3-6: 性能报告 + 第一阶段收尾

**目标：** 输出第一阶段性能报告，确认 §1 目标表全部达标。

**实现要点：**
- [ ] 性能报告（`docs/m2-m3-performance-report.md`）
- [ ] §1 目标表逐项核对
- [ ] 与 mc-lite 对比数据（视距/帧率/启动时间/存档体积）

---

## 依赖关系

```
M2-1 (StructureIndex)
  ├── M2-2 (地标移植) ← 依赖 M2-1
  ├── M2-3 (树木/植被) ← 依赖 M2-1
  └── M2-4 (洞穴) ← 独立

M2-5 (水面特效) ← 独立
M2-6 (日夜循环) ← 独立
M2-7 (空中结构) ← 依赖 M2-1 的 StructureIndex；单云层复用 GEN 纯函数

M3-1 (视距 8 全量调优) ← 依赖 M2-1~M2-7 全部完成
M3-2 (预算参数标定) ← 依赖 M3-1
M3-3 (雨效) ← 独立
M3-4 (HUD 完善) ← 依赖 M2-6（视觉风格切换）
M3-5 (性能回归基线) ← 依赖 M3-1
M3-6 (性能报告) ← 依赖 M3-1~M3-5
M4 (第二阶段玩家武器) ← 依赖 M3-6 冻结验收
M5 (实体运行时) ← 依赖 M4
M6 (丧尸) ← 依赖 M5（并接入 M4 的实体命中比较）
M7 (玩家放置丧尸巢穴) ← 依赖 M6（并使用 M4 WorldEditor）
```

**建议执行顺序：**
1. M2-1 → M2-2 → M2-3（结构链）
2. M2-4（洞穴，独立）
3. M2-5（水面，独立）
4. M2-6（日夜，独立）
5. M2-7（空中结构，依赖 M2-1；M2 关闭门）
6. M3-1 → M3-2 → M3-5 → M3-6（性能链）
7. M3-3（雨效，独立）
8. M3-4（HUD，依赖 M2-6）
9. M4 → M5 → M6 → M7（第二阶段实体/敌人链；每一项以前项验收为门）

---

## Global Constraints（延续 M1）

- 纯 JavaScript + JSDoc，**禁止 TypeScript**，无构建步骤（设计文档 DR-9）。
- three.js 固定 r185.1，本地 `vendor/three/` 引入；**three 只在主线程**，`src/workers/`、`src/gen/`、`src/mesh/mesher.js`、`src/mesh/lighting.js`、`src/voxel/` 不得 import three（Worker 同构约束，设计文档 §3）。
- 世界高度：`WORLD_MIN_Y = -32, WORLD_MAX_Y = 96`（高 128，8 个 16³ section）；方块 ID 0 = air；海面 `SEA_Y = -2`（与 mc-lite 坐标兼容，DR-8）。
- 顶点格式（§4.3，M0 bench 已验证 flat 快路径）：`position` Float32×3 + `uv` Float32×2 + `packed` Uint32×1（bit0-7 light，bit8-9 AO，bit10-12 面索引）。
- 权威边界（DR-17）：gameplay 真相 = `blocks` + `meta`；`light` 是派生缓存可重算收敛。
- 版本协议（§4.9）：所有异步任务携带 `(columnKey, version)`，回传不匹配即丢弃。
- 冻结断言纪律：性能断言数字在实测不符时**停下报告**，不得擅自修改。
- 每个任务结束必须 commit（Conventional Commits）。

---

## 后续阶段预留（第二阶段+，本文档不展开）

设计文档 §9 已给出扩展点设计：

| 功能 | 引擎接入点 | 第一阶段预留 |
|---|---|---|
| M4 玩家武器 | `WorldEditor` + DDA hitscan + 相机视图模型 | 规格：`docs/superpowers/specs/2026-08-23-m4-player-weapons-design.md`；计划：`docs/superpowers/plans/2026-08-23-m4-player-weapons.md` |
| TNT/爆炸 | `world.setBlocks(batch)` + REMESH + 粒子 | 批量编辑 API、粒子接口 |
| M5 实体运行时 | EntityManager + 实体 raycast + 受控渲染层 + `entities` snapshot | 临时实体随 Scheduler “视距 +2”最终卸载回收；持久实体先冻结并异步保存最小 snapshot，玩家重入/保存失败则取消，成功后的下一帧才同步移除；规格：`docs/superpowers/specs/2026-08-23-m5-entity-runtime-design.md`；计划：`docs/superpowers/plans/2026-08-23-m5-entity-runtime.md` |
| M6 丧尸 | M5 临时 entity + 单 batch WorkerPool AI + M4 武器距离比较 + 6 部件实例渲染 | 默认 20；手枪/加特林/MAG7 为 25/35/999 与 40/40/10；不含 PlayerVitals/近战；规格：`docs/superpowers/specs/2026-08-23-m6-zombies-design.md`；计划：`docs/superpowers/plans/2026-08-23-m6-zombies.md` |
| M7 玩家放置丧尸巢穴 | `WorldEditor` + `blockEntities` + M6 `ZombieService` | 全局最多 8 个；最高 `gold_block` 破坏即失效；八 offset × 六层出生搜索，GEN 接管 `restoreEdits()` 保持 anchor；不是生成地标；规格/计划见 `docs/superpowers/{specs,plans}/2026-08-23-m7-zombie-nests*` |
| 炮塔/飞行弹丸 | M5 EntityManager + 实体 raycast + InstancedMesh 实体渲染 | M5 后独立 Epic；不属于 M4–M7 |
| 玩家生存战斗 | M5 EntityManager + 玩家状态/HUD + 事件 | 独立 PlayerVitals Epic；M6 明确不包含 |
| 矿车/轨道 | 方块属性（track 类型）+ 实体运动系统 | BlockRegistry 的 `interact`/`onStep` 钩子 |
| 创造台 | 模型编辑 → 注册自定义 geometry 模板 | mesher 顶点模板机制 |
| 灯/光源 | emissive 属性 + blocklight flood fill | 光照管线已含 |
| 床/宝箱/门 | 多方块结构 + 朝向 + 交互钩子 + 富状态 | meta/orientation 位、`blockEntities` 通道、交互事件 |
| 存档迁移 | save/codec 版本字段 | schemaVersion 机制 |
| 音频 | AudioManager + 事件订阅 | `block-changed`/交互事件总线 |
| 设置持久化 | save/player 记录扩展 | player 记录已含画质设置字段 |
| 出生点安全选择 | spawn 逻辑 | 已实现（findSpawnY） |
