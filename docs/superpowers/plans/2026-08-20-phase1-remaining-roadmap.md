# 第一阶段剩余执行计划与后续路线图（M2–M7）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成设计文档 §7 第一阶段的 M2（结构与世界完整性）和 M3（性能达标与收尾），达成 §1 目标表全部验收指标；并登记以 M3-6 冻结基线为门的 M4–M7 独立 Epic 依赖与执行顺序。

**前置文档:**
- 设计文档：`docs/phase-1-engine-design.md`（当前 v1.31，架构/数据层/渲染/光照/调度全量设计；
  M3.1 之后历次 bugfix/改造的口径变更均记在其修订说明，本文档表格只记状态与要点）
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

### M2 结构与世界完整性 ✅ 完成（2026-08-31 关闭）

| 项目 | 状态 | 备注 |
|---|---|---|
| M2-1 StructureIndex + 确定性结构布局 | ✅ | per-region 布局 + 跨 region 查询 + GEN 门控（`structure-index.js`） |
| M2-2 地标移植（城市/金字塔/冰封山/雪地/海岛） | ✅ | 类型/公式逐行核验与 mc-lite 一致；**同 seed 人工比对 2026-08-31 通过（无异常）** |
| M2-3 树木 + 植被 | ✅ | 四型树 / 花草仙人掌 / cross 模板 + _addOptimized 包围剔除 |
| M2-4 洞穴 | ✅ | 3D 噪声挖空 + mc-lite rooms 保留 |
| M2-5 水面特效 | ✅ | TSL 海面 + 水纹理入 atlas |
| M2-6 日夜循环 | ✅ | morning/noon/night 三风格 |
| M2-7 空中结构（悬浮空岛 + 云层） | ✅ | 追加任务：确定性空岛、单云层、连通云簇；不含宝箱/天空树；紧凑候选 + 层序裁剪（`sky-structures.js`），详见 `2026-08-23-m2-sky-structures.md` |

### M2 后修复（实玩 bug）✅ 已收尾

| 修复 | commit | 备注 |
|---|---|---|
| 光照黑面根因 | `4c840cd` | 写回改中心 column 权威 + 移除阳光遮挡投影（v1.9 决策） |
| 世界数据看板 + 调试开关 + 控制台日志 | `3a02dbc` | §4.9 worldStats/statsLog，`?stats=0`/`?log=0` |
| 方块类型/贴图/几何全面对齐 mc-lite | `d11a8b0` | ±X 面 UV 90° 旋转修复（BoxGeometry 口径）；faces-data 124 方块六面全覆盖；`tools/bake-procedural-textures.mjs` 烘焙 21 张 mc-lite 程序化贴图（atlas 124→145）；12 种特殊几何顶点模板（台阶/栏杆/柱子/烟囱/床/吊灯/仙人掌，逐格复刻 geomMap）；树叶 FrontSide + alphaTest 0.3（冠内不过密）、植被双向绕线；cross 第二张图横躺回归修复 |
| 朝向渲染消费侧 + 台阶等 12 方块 blended 通道穿帮 | `584813b` | mesher 读 meta 低 2 位按 4 朝向旋转（模型面查 tile/床 UV 变换，世界面做剔除/光照/AO）；getSectionView 打包 meta + MESH transfer；渲染侧无条件消费（对齐 mc-lite 逐实例应用 b.orientation）；交互侧放置语义属第二阶段。另：M0 转换混同 isTransparent（剔除语义）与材质透明度 → 台阶/栏杆/柱子/宝箱等 12 个不透明材质方块 depthWrite=false，L 形凹角无深度互遮透视穿帮；cullMode 改 cutout 修复（设计文档 §4.1 勘误） |
| 城市覆写残留自然地形丘清除 + 树植根城市地表 | `7d09cf1` | fillColumn 预填整列自然地形，generateCity 仅覆写至城市地表 → 自然高度 > 城市地表的列（seed=12345 占 20.6%，最高差 11 格）残留接地自然地形丘，凸出地表包裹建筑；generateCity 清除 surfaceY+1..naturalH + 回退 pointContext 的 max 补丁（5b6c51e）使树植根城市地表；过渡带台阶不受影响 |
| 云渲染通道勘误 + blur 档方格线根因修复（M2-7 收尾，用户实机反馈） | `7e19924` | 远处云面黑纹/方格线三连根因：①cloud 误置 transparent 通道（mc-lite 材质 `mkMat('#FFFFFF',1)` opacity=1 不透明，§4.1 勘误类遗漏）→ depthWrite=false 侧面混叠，改 opaque 通道 + mesher `SAME_TYPE_CULL` 同类相邻剔除；②atlas gutter 原为不透明黑底，mip 下采样渗黑边 → build-atlas 每 tile 边缘 bleed 回填，gutter 2→16/bleed 8；③块面 UV 逐块 wrap 的导数尖峰使 mip 足迹跨 tile 采邻 tile 色（粉灰线）→ blur 档 anisotropy 8 + cloud 匀质白纹理 UV 收缩 tile 中央 1/4（足迹永不跨 tile）根除；云纹理烘纯白（噪点仅贡献莫尔纹）。单测：mesher cloud 通道/同类剔除/UV 收缩 + atlas 双档/gutter 断言 |

### M3 性能达标与收尾 ✅ 完成并提交（2026-09-02，`82da106`）

| 项目 | 状态 | 备注 |
|---|---|---|
| M3-1 视距 8 全量调优 | ✅ | 全量场景（城市+空岛+云层+洞穴+水面+日夜）稳态 120fps、队列归零、内存达标（体素 36~40MB / GPU 分配 136.6MB，§4.10 口径内）；BatchedMesh CAPACITY 按实测峰值重标定（消除 cutout 运行时 3× 扩容卡顿 + opaque 过度分配 63MB）；`game.memoryStats()`（§4.10 快照）；`tests/m3-fullscene.spec.mjs` |
| M3-2 预算参数标定（60Hz/120Hz 双档） | ✅ | `src/core/budget.js`：120Hz=3ms/64、60Hz=6ms/128 冻结档 + auto 判档（matchMedia 静态检测不可信 → 运行时「快帧(<11ms)比例」判据，中位数会被启动 burst 污染）；Scheduler 上传/下发预算接线；`?budget=` URL + 设置面板覆盖；单测 9 + `tests/m3-budget.spec.mjs`（本机判 high / fps 120；low 档显式注入 fps 118） |
| M3-3 雨效 | ✅ | `src/render/weather.js` 天气状态机（晴 60~180s → 雨 30~90s 随机周期 + 5s 淡入淡出 + force 手动覆盖）+ `src/render/rain.js`（mc-lite RainEffect.js 算法照搬：LineSegments + TSL GPU 下落、267 滴/radius 18/speed 24、isSolid 地面截停、30Hz 距离检查 + 64/帧分批迁移削峰）；`?weather=` 调试入口；雨天 fps 120 / 截图差分显著；单测 9 + `tests/m3-rain.spec.mjs`。注：roadmap 写的 mc-lite 参照 Engine.js 有误，真实实现在 `src/world/effects/RainEffect.js`（无天空压暗/雾距联动语义，未引入） |
| M3-4 HUD 完善 + 随机种子/新世界 | ✅ | `src/ui/`：坐标+biome HUD（CITY 布局边界判定 + getBiome）、快捷栏 5 格（atlas tile CSS background 裁剪 + 数字键高亮）、设置面板（视距/blur/音量/视觉风格/帧预算档/新世界，⚙ 按钮 + uiModal 门控）；设置持久化 localStorage（URL > 存储 > 默认）；**随机种子新世界**：main.js 固定 12345 改「有存档读存档、无存档随机生成」，`?seed=` 复现入口，`game.newWorld()`（清 edits + 防卸载回写竞态 + meta 落库 + 重载）；视距/blur 切换走带参重载（BatchedMesh maxInstances 与纹理 mip level 均构造期固定）；`tests/m3-hud.spec.mjs` 3 用例。性能/视觉冻结 spec 统一钉 `?seed=12345` 保可复现；clampVD 下限 4 误钳测试 vd=2 的回归已修（下限改 2）。**已知偏差（M3.1 收口）**：本任务把 mc-lite
  `Inventory.js` 列在参照里，但实施要点只含快捷栏展示层，物品数据模型（slots/selectedSlot/Z 键）
  缺位——依据是 v1.12「背包归独立后续 Epic」，与设计文档 §4.5.4 冲突。v1.16 已定稿背包归 M3.1 |
| M3-5 性能回归基线脚本 | ✅ | `src/bench/baseline.mjs`（`npm run bench`）：4 基线场景自动跑图（①平原冲刺 40s/255 格/跨 region 1 次——实证选定 z=-100 干燥无障碍走廊，曾误选深海/树冠点 ②城市环视 360° ③放挖 200 块 ④TNT 批删 500 块/affected 684 sections）；采集帧时 p50/p95/p99、四类队列深度、upload-ms/fast-remesh 打点、draw/sections/内存；输出 `docs/m3-baseline.{md,json}`；`--check` 门禁（结构类 2%/性能类 10%/fps 同 adapter，负向验证退出码 1）；两次连跑完全可复现 |
| M3-6 性能报告 + 第一阶段收尾 | ✅ | `docs/m2-m3-performance-report.md`：§1 目标表 6 项全达标（冷启动 0.5s / 视距 8 默认 + vd=12 冒烟 / 120fps / 跨 region 无感知 / 编辑 1.8ms / 存档 1.7KB）；mc-lite 对比（视距 ~4×、启动数十~百倍、存档 ~千倍）；遗留观察项 5 条（LOD/per-tile mip/音频消费方/60Hz 真机矩阵等） |

### M3.1 背包 ✅ 实施完成（2026-09-02，设计文档 v1.16 定稿）

设计文档 §4.5.4「第一阶段实现背包」与 v1.12「背包归独立后续 Epic」口径冲突的收口：M3-4 只落地了
快捷栏展示层，物品数据模型缺位（无 slots/selectedSlot、Z 键无响应、放块索引常量数组）。v1.16 定稿
背包归 M3.1，推迟范围收窄为仅生存战斗与物品消耗规则。任务详情见下方「## M3.1 背包」章节。

| 项目 | 状态 | 备注 |
|---|---|---|
| M3.1 背包（物品模型 + Z 键面板 + 快捷栏改读 slots + 输入门控修正） | ✅ | 照搬 mc-lite `Slots.js`/`Inventory.js`/`HUD.renderHotbar()`/`global.css`；122 项物品（126 排除 4 个功能性方块）；`count` 1500 占位不消耗不显示；`uiModal` keydown 守卫是 M4 Task 6 前置条件。落地 5 文件新增 + 6 文件改；单测 170→216（+46）、Playwright 32→38 用例（+6），全量回归 38 passed / 单测 216 全绿 / lint 0 error / `bench --check` 通过（9 problems 均为既有 camelcase warning） |

### M3.2 方块朝向放置交互 ✅ 实施完成（2026-09-03，设计文档 v1.17 定稿 / v1.18 实施回填）

设计文档 §4.3「交互侧放置语义仍属第二阶段」与本文件第 211 行「朝向交互侧暂不实现」的收口：
该项此前**没有排进任何已编号里程碑**（M4~M7 spec/plan 经 grep 核实均不含方块朝向）。渲染消费侧
M2 已全部打通（`584813b`），`edits` 早已带 meta，缺的只有放置算朝向 + 挖块记朝向两步。
v1.17 把它从床/宝箱/门 Epic 拆出独立实施，该 Epic 范围收窄为「多方块结构 + `blockEntities` 富状态」。
任务详情见下方「## M3.2 方块朝向放置交互」章节。

| 项目 | 状态 | 备注 |
|---|---|---|
| M3.2 方块朝向放置交互（三分支放置朝向 + 挖块记忆 + `getBlockMeta`） | ✅ | 照搬 mc-lite `PlayerInteraction.getPlacementOrientation` 三分支 + `OrientationUtils.nextOrientation`；门控复用 `orientationModesTable`（**启用集合 40 项两侧零差异**，不新增字段；不参与旋转的方块 mc-heavy **86** 项 vs mc-lite 84 项——差额是 M2-7 新增 `sky_stone`/`sky_grass`，见设计文档 v1.18 勘误）；**朝向不看玩家 yaw**——手感是原位挖放转 90°；不做放置消耗/音效/床多方块；`getBlockMeta` 提前交付 M4 plan Task 2。身份键用数字 `id`（mc-lite 用 name，语义等价）。落地 3 新增 + 3 改；单测 216→238（+22）、Playwright 38→44 用例（+6）；lint 0 error、`bench --check` 通过 |

### 异形方块渲染勘误 ✅ 完成（2026-09-03，M3.2 之后独立 bugfix，设计文档 v1.19）

起因是「vine 向上溢出半格、疑似与 mc-lite 不一致」的观感报告，连带排查 cactus / hanging_lamp /
bed_head / bed_tail。用 vendored three 精确复现 mc-lite `geomMap` 实测包围盒 + 真实 mesher 输出 UV
反算 PNG 行号后，**三个前提与实测相反**：

| 项目 | 状态 | 备注 |
|---|---|---|
| 实例原点换算基准补记 | ✅ | mc-lite 几何以**块中心**为原点（四条放置路径全部 `position.set(x+0.5,…)`），mc-heavy 以**块底角**为原点（0→1）→ 比对须 +0.5 换算。此前文档与代码注释均未写明，极易误判几何差异。补记入 §4.3 |
| vine | ✅ | **双方共同溢出，非 mc-heavy 缺陷**：mc-lite `geoVine` 实测世界 y∈[0.5,1.5]，与原实现完全一致；其注释「使几何体从y=0到y=1」说的是**局部**坐标，误导。经确认改为 **y∈[0,1] 格内** —— 已知的有意偏离，§4.3 已标注 |
| cactus | ✅ 无需改 | 主干 + 四侧枝五个盒的世界包围盒逐项相等，**两侧完全一致** |
| hanging_lamp | ✅ | 绳从 0.03 宽 cross 近似 → `CylinderGeometry(0.015,…,8)` 等价八段棱柱（复用 chimney 同款 `prismQuads`；UV 方向与 three 实测核对：顶→v=1）。顶点 32→120/实例 |
| bed_head / bed_tail UV | ✅ **真实 bug** | 根因：**照上游「定义」实现而非「行为」**。mc-lite 定义了 `offset`/`rotation` 但**全仓无消费点**（死字段），实际只生效 `repeat:[1,0.5]` → 采样贴图**下半**（92 个不透明像素）；原实现照注释取**上半**（仅 32 个不透明像素、RGB rgb(40,25,25)），opaque 通道下渲成深色块。改 `vHalf`→`vLowerHalf` + 删 `rot`（顶面不旋转） |

**落地 2 改**（`src/mesh/mesher.js` 三处模板 + `src/tests/test-mesher.js`）；单测 238→**241**（+3）、
Playwright 44 用例不变、全量回归 **44/44 全绿**；lint 0 error、`bench --check` 通过
（fps 112.94~120.21、draw 489~545，无回退）。**教训写入 §4.3**：对齐上游须实测其运行时行为，
读定义推断会引入回归（与「诊断 bug 不猜」同一原则）。详情见下方「## 异形方块渲染勘误」章节。

## 全局 TODO List（按执行次序）

1. [x] **M2 收尾（2026-08-31 全部完成，M2 关闭）**：
   - [x] **水面颜色随镜头转动突变**（[issue #2](https://github.com/jayli/mc-heavy/issues/2)）：
     根因：两层透明物体（体素水 `transparent` 通道 BatchedMesh + `ocean.js` 海面）均无 `renderOrder`，
     three 按排序锚点 NDC 深度定先后——海面锚点钉在相机正下方（恒定），体素锚点为合并几何包围球中心
     （世界原点附近），排序值随镜头转动在 -174~+283 摆动，跨过海面值时绘制顺序翻转、混合结果突变。
     修复：`ocean.js` 海面 `plane.renderOrder = 1` 恒后画，退出深度排序；新增 `tests/water-order.spec.mjs`
     全周扫描顺序稳定性断言（RED→GREEN）。详见 issue #2 根因评论。
   - [x] **M2-7 空中结构**：按 `docs/superpowers/specs/2026-08-23-m2-sky-structures-design.md` 与
     `docs/superpowers/plans/2026-08-23-m2-sky-structures.md` 重写 mc-lite 的悬浮空岛和云层；必须走
     StructureIndex + Worker GEN + column 裁剪，不含宝箱/天空树、`structureCenters` 或运行期补刷；
     已落地并通过数据级验收与视距 8 性能门（证据见下方 M2 收尾 TODO）；同 seed 视觉比对 2026-08-31 人工通过。
   - [x] **城市覆写残留自然地形清除**（原"城市边缘残块"，措辞修正：残丘底部接地、非悬空）：
     `fillColumn` 按自然 biome 预填整列，`generateCity` 仅覆写至城市地表，自然高度高于城市地表的列
     （seed=12345 实测占城市列 20.6%，最高差 11 格）残留**接地的自然地形丘**（grass/dirt/stone），凸出于
     城市地表并包裹按城市地表放置的建筑；`5b6c51e` 曾以"树植根点取 max(城市地表, 自然地表面)"绕过。
     修复：`generateCity` 清除 `surfaceY+1..naturalH` 残留 + 回退 `pointContext` 的 max 补丁使树植根城市
     地表；过渡带台阶（`getCityFinalSurfaceY`）不受影响。已补固定 seed/column 复现 fixture + 完整
     Playwright 回归，不破坏城市建筑、地标或 edits 语义。
   - [x] **同 seed 人工视觉验收**（2026-08-31 通过）：按 `docs/m2-seed12345-comparison.md` 清单
     （布局纯函数直算坐标）在两边同 seed 12345 下逐项比对城市/金字塔/冰封山/雪地/海岛/
     悬浮空岛/云层 + blur 档远处观感；用户实机比对**未发现异常**；已知有意差异（空岛无宝箱/
     天空树、海面实现、CITY 光晕）见清单第五节。结论已回写本文件挂起项。
   - [x] **收尾回归与关闭记录**（2026-08-31）：完整 Playwright suite 全绿（21 文件 / 25 用例
     + 144 浏览器单测；出生城市天际线 = city-visual、跨 region = structure-gen 均在套件内），
     roadmap / CLAUDE.md / README.md 的 M2 状态已更新为「完成」。
2. [x] **M3 第一阶段验收（2026-09-02 完成并提交 `82da106`）**：视距 8 调优、预算双档、
   雨效、HUD/随机种子新世界、基线脚本 + 门禁、性能报告全部落地；冻结基线 =
   `docs/m2-m3-performance-report.md` + `docs/m3-baseline.{md,json}`；收尾回归 32 用例全绿
   （m1-acceptance 贴线项单跑复验通过）+ 170 浏览器单测 + lint 0 error。
3. [x] **M3.1 背包（2026-09-02 实施完成并提交）**：交付创造模式无限背包的物品数据模型
   （`Slot`/`Inventory`，1000 槽位、每格 `count` 1500 占位不消耗）、Z 键背包面板（122 项物品、
   点击选中可越出快捷栏 5 格）、快捷栏改读 `slots[0..4]`、`Player.placeBlock()` 改读 `getSelected()`，
   并修正 `uiModal` keydown 门控漏洞 + 改模态栈（该守卫是 M4 Task 6 的前置条件）。
   回归：Playwright 38 用例 + 单测 216 全绿、lint 0 error、`bench --check` 通过。
   与 M4 数据层解耦（M4 排除背包消耗、武器切换走独立 `WeaponController`），排序依据是共用
   `keydown` 入口。规格见设计文档 §4.5.4；任务详情与门禁诊断记录见本文件「## M3.1 背包」章节。
4. [x] **M3.2 方块朝向放置交互（2026-09-03 实施完成并提交）**：交付 mc-lite 三分支放置朝向
   （门控 `orientationModesTable` → 原位重建 `+1 %4` → 类型记忆 → 默认 EAST）、挖块记朝向
   （`lastRemovedBlock`）、`world.getBlockMeta()`（提前交付 M4 plan Task 2）。**朝向不看玩家 yaw**
   ——mc-lite 的手感是「转身不改朝向，原位挖掉再放回去转 90°」，照搬。此前该功能没有排进任何
   已编号里程碑（M4~M7 spec/plan 经核实均不含方块朝向），从床/宝箱/门 Epic 拆出独立实施，
   该 Epic 范围收窄为「多方块结构 + `blockEntities` 富状态」。不做放置消耗/音效/床多方块。
   规格见设计文档 §4.3「朝向放置交互」；实施记录见本文件「## M3.2 方块朝向放置交互」章节末尾。
   实施期两处口径校正已回填设计文档 v1.18（门控 false 计数 84→86、身份键 name→id）。
5. [ ] **M4 第二阶段首个 Epic**：只在 M3.2 完成后开始，交付玩家第一人称手枪/MAG7/加特林的
   `WorldEditor`、DDA hitscan、受控 GLB 视图模型、曳光和音效。**注意**：Task 2 的 `getBlockMeta`
   已由 M3.2 交付（改为验证 + 补断言）；Task 6 将 `digBlock()`/`placeBlock()` 改走
   `editor.setBlock(...)` 时须保留 M3.2 的朝向分支（`WorldEditor.setBlock` 已支持 meta 参数）。规格：
   `docs/superpowers/specs/2026-08-23-m4-player-weapons-design.md`；计划：
   `docs/superpowers/plans/2026-08-23-m4-player-weapons.md`。
6. [ ] **M5 实体运行时**：M4 验收后交付 `EntityManager`、实体 AABB raycast、受控实体渲染层、
   临时/持久实体分离和 `entities` snapshot；持久实体卸载采用“冻结/异步保存、可取消、成功后下一帧同步
   最终移除”协议，不夹带具体敌人、炮塔或矿车。规格：
   `docs/superpowers/specs/2026-08-23-m5-entity-runtime-design.md`；计划：
   `docs/superpowers/plans/2026-08-23-m5-entity-runtime.md`。
7. [ ] **M6 丧尸**：M5 验收后交付默认上限 20 的临时丧尸、20Hz 单条 WorkerPool `ai` RPC、
   实体/体素最近命中比较、25/35/999 的三把枪实体伤害与六部件固定 slot 渲染；不含玩家生命、
   近战或死亡/重生，巢穴另列 M7。规格：
   `docs/superpowers/specs/2026-08-23-m6-zombies-design.md`；计划：
   `docs/superpowers/plans/2026-08-23-m6-zombies.md`。
8. [ ] **M7 玩家放置丧尸巢穴**：M6 验收后，以巢穴最高 `gold_block` 的 `blockEntity` 为持久真相，
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
  遗留跟进（用户实机反馈，6a01781 修复）：俯视时地面方块顶面高度处可见一层蓝色平模——mc-heavy 地形生成有
  水面填充（体素水顶面在 SEA_Y+1），而 mc-lite 的海没有体素水（纯海面平面），故 mc-lite 无此模。
  修复：mesher 对暴露水面（water/swamp_water 上方无 opaque/同类水）顶面与侧面顶边下沉 0.5，与海面
  平面共面（Minecraft 经典水面下沉口径），方块逻辑/物理仍占整格；`test-mesher.js` 5 个单测覆盖
  （暴露下沉/深水整格/opaque 覆盖不下沉/非水不变）。
- [x] **城市覆写残留自然地形清除**（原"城市边缘残块"）：`fillColumn` 按自然 biome 预填整列，
  `generateCity` 仅覆写至城市地表，自然高度高于城市地表的列（seed=12345 实测占城市列 20.6%，
  最高差 11 格）残留**接地的自然地形丘**（非悬空），凸出于城市地表并包裹按城市地表放置的建筑。
  mc-lite 稀疏存储不预填城内自然地形故无此问题。修复：`generateCity` 清除 `surfaceY+1..naturalH`
  （`naturalH` 另取 `generateHeight`，勿用传入的 CITY 压平 `h`）+ 回退 `pointContext` 的 max 补丁
  （`5b6c51e`）使树植根城市地表。已补固定 seed/column 复现 fixture + 完整 Playwright 回归。
- [x] **M2-7 空中结构**（实施计划 `2026-08-23-m2-sky-structures.md` 四任务 TDD 全部落地）：
  `sky_stone`/`sky_grass` 入 registry/atlas（126 方块/147 tile，烘焙 #DDDDDD/#88CCFF）；
  `sky-structures.js` 紧凑候选（stride 5 Int32Array，salt +50..+55 对齐 mc-lite chunkRandom、
  +56/+57/+58+step 替代原未 seed 化随机量）+ Y=55 单云层（固定公式 `noise(wx,wz,seed,0.03)>1.2`）+
  Y=35 连通云簇（30..50 四邻接）+ 空岛逐层圆（`floor(radius*(y/height)^0.7)`，顶 sky_grass
  身 sky_stone），层序先云后岛、岛体覆盖 Y=55 相交云；`supportsPlayer` 通用表 + 物理仅
  Y 向下支撑（云可站立、侧/下可穿、不遮光），DDA 仍命中 cloud。浏览器单测 +18 全绿；
  `tests/sky-structures.spec.mjs` 真实世界验收（岛体逐格、无 chest/天空树、云层存在、可视）；
  视距 8 队列收敛稳态实测 **fps≈105（≥90 ✓）/ draw=790**；p95 为 120Hz 量化值 16.7000007
  （~105fps 下约 14% 双倍帧，字面 `p95<16.7` 数学不可满足，同帧时口径注记），
  二级门取 16.75（阈值 + 一个量化 epsilon）并已在 spec 内注释。
  同 seed 截图与 mc-lite 轮廓比对归入下方人工验收项。
- [x] **同 seed 截图与 mc-lite 比对**（2026-08-31 用户实机比对通过，无异常）：按
  `docs/m2-seed12345-comparison.md` 清单逐项比对城市/金字塔/冰封山/雪地/海岛/空岛/云层/
  blur 档；清单坐标由布局纯函数直算。已知有意差异确认不阻断。
- [x] **M2 关闭回归**（2026-08-31）：完整 Playwright suite 全绿（21 文件 / 25 用例，含
  city-visual 出生点城市天际线与 structure-gen 跨 region 口径；m1-acceptance 套件内一次
  120Hz 量化贴线为已登记负载抖动，单跑全绿）+ 144 浏览器单测。三文档状态已回填。

#### 非阻断观察项（不阻塞 M2 关闭）

- [ ] （可选）**CITY 光晕**：chunk 中心在城内、列在城外时，mc-lite 给 sand/sand 地表，mc-heavy
  给自然 biome 地表（`WorldWorker.js:994`）。单独评估是否值得作为 M2 视觉一致性优化，未采纳时记录理由。
- [ ] **m1-acceptance 计时 flaky 观察**：放挖 p95 断言在高负载下偶发贴线（16.7±1e-6/2.1ms），
  非回归（不同断言轮流失败、单独复跑通过）；以实机帧率为准，冻结断言不擅改。若连续出现同一断言失败，
  再按实际数据启动诊断。
- [x] ~~**朝向交互侧暂不实现**（原地重转 90°/类型记忆）：第二阶段随床/宝箱/门落地，第一阶段只预留
  meta 数据位。~~ → **已由 M3.2 独立落地**（2026-09-02，设计文档 v1.17 定稿）：从床/宝箱/门
  Epic 中拆出，该 Epic 范围相应收窄为「多方块结构 + `blockEntities` 富状态」。
  详见「## M3.2 方块朝向放置交互」章节。

#### 接下来（2026-09-02 更新：M3 与 M3.1 已提交，M3.2 文档已就绪待实施）

1. ~~**M3 全部六任务**~~ ✅ 已实施完成并提交（2026-09-02，M3-1→M3-6 顺序 TDD；用户验证后
   经 `/commit` 提交为 `82da106`，含设置面板 mc-lite 风格照搬与 ⚙ 按钮下移 10px 两处实机反馈修改）。
2. blur 档面板接线/持久化已随 M3-4 落地（重载生效口径）；剩余可选项（per-tile mip 链打磨、
   默认值翻转决策）见 M3-4 条目与性能报告遗留观察项。
3. ~~**M3.1 背包**~~ ✅ 已实施完成并提交（2026-09-02，TDD 全程；文档规格先于代码提交为
   `5f96a9b`，代码随本次提交入库）：
   文档对齐（设计文档 v1.16：§4.5.4 完整规格 + §4.1 `registry.all()` + 消除与 v1.12 的冲突）→
   物品模型（`Slot`/`Inventory` + `registry.all()` + `Player` 接入 + `hotbarIndex` 收敛为别名）→
   背包 UI（`src/ui/inventory.js` + 快捷栏改读 slots + `uiModal` 模态栈 + keydown 守卫）→
   全量回归（38 用例 + 216 单测 + lint 0 error + `bench --check` 通过）。
   门禁诊断记录（每帧分配致 `fastRemeshP95` 回退的真缺陷 + `frameP95` 抖动离群值的 HEAD 对照）
   见「## M3.1 背包」章节末尾。
4. ~~**M3.2 方块朝向放置交互**~~ ✅ 已实施完成并提交（2026-09-03，TDD 全程）：
   `src/player/orientation.js` 纯函数（`nextOrientation` + 三分支 `getPlacementOrientation`）→
   `world.getBlockMeta()`（`src/voxel/world-data.js`，O(1) 直查 column.meta，越界/缺列返回 0）→
   `Player` 两个交互状态（`lastRemovedBlock` / `placementOrientationMemory`）+ `digBlock()` 挖前
   记朝向 / `placeBlock()` 算朝向传 meta 并清空记录 → 全量回归（44 用例 + 238 单测 + lint 0 error +
   `bench --check` 通过）。
   实施期实测发现两处 v1.17 口径偏差并回填设计文档 v1.18：① 门控 false 计数 mc-heavy 是 **86**
   而非文档沿用的 mc-lite 侧 84（差额 = M2-7 新增 `sky_stone`/`sky_grass`，门控均 0；启用集合 40 项
   零差异的结论不变）；② 三分支身份键与记忆键统一用数字 `id`（mc-lite 用 name，语义等价）。
   门禁诊断：`m1-acceptance` 放挖压力用例的 `frameMs.p95` 贴线失败经 **HEAD 对照连跑证实为既有
   vsync 抖动**（HEAD 侧 4 次中 1 次同样失败于 `16.700000762939453 vs <16.7`；两侧 placeP95/digP95
   分布 1.6~1.9 完全重叠，无系统性回退），非本次改动引入。详见「## M3.2」章节末尾。
5. ~~**用户验证 M3.1（与 M3.2）后提交**~~ → M3.1、M3.2 均已提交。**下一步 M4 玩家武器**
   （第二阶段首个 Epic，加读规格与计划文档后开工；M3.1 交付的 `uiModal` keydown 守卫 +
   M3.2 交付的 `getBlockMeta` 均是 M4 的前置条件）。

### 测试现状

- 27 个 Playwright spec 文件（44 个测试用例；m1-acceptance 计时断言高负载下偶发贴线 flaky，单跑全绿）
- 浏览器内单元测试全绿（harness；用例数以 `npm run check:data` 输出为准，文档不硬编码计数）
- 冻结断言：fps ≥90（120Hz 本机 ≥115）、编辑 p95 <2ms、draw 受控；atlas tile 数以 `npm run check:data` 为准（构成：方块纹理 + 程序化烘焙。**v1.26 起背包图标独立于世界 atlas**，在 `assets/icons-atlas.png`）
- 性能基线门禁：`npm run bench` 采集 / `npm run bench -- --check` 回退 >10% 阻断（结构类 2%）
- **测试分级门禁**（v1.25）：`npm run check` = `check:arch`（红线静态门）+ `check:data`（数据契约，
  含图标过期指纹检查）+ lint，2.6s，日常改动的最小门。分级判据见 `docs/testing-policy.md`

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
- [x] 同 seed 截图与 mc-lite 比对：算法级逐字段核验（城市布局与 mc-lite CityMap 同 seed 完全一致；地标公式逐行移植）；人工比对 2026-08-31 通过（清单 `docs/m2-seed12345-comparison.md`，无异常）
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
- [x] 固定 seed 的 layout 与任意加载顺序逐格一致；空岛跨 column 无截断，只含岛体，不含 chest/天空树。（单测 + `tests/sky-structures.spec.mjs` 数据级断言）
- [x] 单云层和 30..50 块连通云簇均完整生成；云可站立、非实心、透明且不遮光。（单测：连通性/跨列一致/物理四断言/光照不回归）
- [x] 同 seed 截图确认空岛/云层轮廓与配色基调（2026-08-31 人工比对通过，无异常）；视距 8、队列收敛后通过
  M3 冻结 fps/draw 口径（**已过**：稳态实测见上方 M2 收尾 TODO 的 M2-7 证据）。

---

## M3 性能达标与收尾 ✅ 完成并提交（2026-09-02，`82da106`）

**验收口径（设计文档 §7）：** §1 目标表全部达标；输出性能报告。
实测证据汇总：`docs/m2-m3-performance-report.md` + `docs/m3-baseline.{md,json}`。

### Task M3-1: 视距 8 全量调优

**目标：** 视距 8（289 column）全量加载 + 地表/空中结构 + 洞穴 + 水面 + 日夜，fps ≥90（120Hz 本机 ≥115）。

**实现要点：**
- [x] 全量场景（城市 + 悬浮空岛 + 云层 + 洞穴 + 水面 + 日夜）下 fps ≥90（实测稳态 120，冲刺/收敛全窗口 ≥107）
- [x] GEN/MESH/LIGHT 队列不积压（稳态/停跑收敛全归零；冲刺中 inflight p95=0）
- [x] 内存预算达标（体素 36~40MB ✅；GPU 顶点分配 136.6MB / 占用 106~119MB——§4.10「~100MB 级」口径内；
  CAPACITY 按实测峰值重标定，消除 cutout 运行时 3× setGeometrySize 扩容卡顿）

**测试：**
- [x] m1-acceptance 全量场景版（`tests/m3-fullscene.spec.mjs`：数据级确认云层/洞穴在加载列 + 稳态/奔跑/收敛三段队列断言 + fps 门）
- [x] 内存快照（`game.memoryStats()`：体素字节和 + 3 通道 GPU 分配/占用 + performance.memory）

### Task M3-2: 预算参数标定（60Hz/120Hz 双档）

**目标：** 根据设备刷新率自动调整帧预算参数。

**实现要点：**
- [x] 检测 `matchMedia('(min-refresh-rate: 120hz)')`（Chromium 未实现该 feature 恒 false 不可信 → 返回 null 交由运行时测量兜底；`src/core/budget.js detectRefreshHint`）
- [x] 120Hz：MESH_UPLOAD_BUDGET_MS=3、MESH_DISPATCH_PER_FRAME=64（BUDGET_PROFILES.high 冻结）
- [x] 60Hz：MESH_UPLOAD_BUDGET_MS=6、MESH_DISPATCH_PER_FRAME=128（BUDGET_PROFILES.low 冻结）
- [x] 设置面板可手动覆盖（M3-4 面板「帧预算」行 + `?budget=` URL；auto 判档一次锁定防震荡）
- 实现注记：auto 判档用「快帧(<11ms)比例 ≥5%」判据而非中位数——60Hz 物理上产生不了快帧，
  120Hz 重负载帧间隔只是量化到 16.7/25ms 仍偶发快帧；中位数会被启动 burst 整窗污染误判 low（实测教训）。

**测试：**
- [x] 60Hz 判定：单测喂 16.7ms 帧间隔 ×120 → 判 low（浏览器内 test-budget 覆盖）；roadmap 原拟
  `--disable-frame-rate-limit` 实测为「解除限帧」而非产生 60Hz vsync，无法真实模拟（口径记录在 m3-budget.spec 注释）；
  端到端 `?budget=low` 显式档注入 → Scheduler 消费 6/128，fps ≥55（实测 118）
- [x] 120Hz 本机 auto 判 high + fps ≥115（实测 120；`tests/m3-budget.spec.mjs` + 单测 9 用例）

### Task M3-3: 雨效

**目标：** 实现粒子雨效（mc-lite 已有，移植）。

**mc-lite 参照：** `src/core/Engine.js`（weather/rain 相关）

**实现要点：**
- [x] 粒子系统：LineSegments + TSL 顶点位移（mc-lite RainEffect.js 同款——roadmap 写的参照 Engine.js 有误，
  真实实现在 `src/world/effects/RainEffect.js`；267 滴/半径 18/速度 24/dropLength 0.5，GPU 下落零主线程逐滴更新）
- [x] 雨滴跟随相机（30Hz 距离检查 + 64 滴/帧分批迁移削峰；isSolid 地面截停）
- [x] 天气状态机：晴 → 雨 → 晴（晴 60~180s / 雨 30~90s 随机周期 + 5s 淡入淡出；force 手动覆盖同语义；
  `src/render/weather.js` 与 three 解耦供单测）

**测试：**
- [x] 雨效可见（`tests/m3-rain.spec.mjs`：同 seed 同机位雨/晴截图差分 448px vs 晴天基线 0px；
  数据级断言 intensity/opacity/draw+1/267 滴 534 顶点）
- [x] 雨效下 fps ≥90（实测 120）；单测 9 用例（状态机周期/过渡连续性/force/大步长）

### Task M3-4: HUD 完善

**目标：** 完善 HUD（帧率面板 + 坐标 + 设置面板 + 快捷栏）。

**mc-lite 参照：**
- `src/ui/HUD.js`
- `src/ui/UIManager.js`
- `src/ui/Inventory.js`

**实现要点：**
- [x] 帧率面板（PerfHUD 已有 fps/frame/gen·mesh·upload·light inflight marks + 世界数据看板 draw/section/三角；
  M3-5 追加 upload-ms/fast-remesh 耗时打点）
- [x] 坐标显示（`src/ui/coords-hud.js`：x/y/z + biome + seed，250ms 节流；CITY 布局边界判定优先，否则 getBiome）
- [x] 设置面板（视距/画质 blur/音量/视觉风格/帧预算档/新世界，`src/ui/settings-panel.js` ⚙ 按钮 +
  uiModal 门控 + localStorage 持久化，URL > 存储 > 默认三级合并 `src/ui/settings.js`）。
  其中**画质 blur 档位（§4.4.1）实现已提前到 M2 落地**
  （M2-7 收尾期用户实机反馈远处云面莫尔纹/方格线触发，2026-08-28 用户实机确认修复）：
  `?blur=1` 开 atlas 三线性 mipmap + anisotropy 8 消远处走样，默认仍像素风；完整修复栈含
  cloud 通道勘误（opaque + `SAME_TYPE_CULL`）、gutter 16/bleed 8、cloud 匀质 UV 收缩中央 1/4、
  云纹理烘纯白（详见 M2 后修复表「云渲染通道勘误」行）。**本任务落地情况**：① `?blur` 开关已接入设置面板
  （「画质(远处)」行：像素风/平滑(blur)）并持久化（localStorage；切换走带参重载——WebGPU 纹理
  mip level 数创建期由 generateMipmaps 固定，运行时翻转不重建 mip 链，实测口径记录在
  game.setBlurQuality 注释）；② （可选打磨，未做）高对比纹理掠射角块缝的彻底解 =
  per-tile 自定义 mip 链（bleed/aniso 为尽力缓解）——列性能报告遗留观察项；③ 默认值翻转
  用户已定暂不翻转（保留参数、默认 0），若后续翻转需先改 §4.4.1 定稿口径。
- [x] 快捷栏（5 格 UI，`src/ui/hotbar.js`：atlas tile CSS background 裁剪图标 + 数字键选中高亮
  同步 Player.hotbarIndex；方块数据单一来源 `src/player/hotbar-items.js`）
- [x] 随机种子 / 新世界：设置面板「新世界（随机种子）」入口（`game.newWorld()`：随机/指定 seed
  写 meta + 清 IndexedDB edits 与内存 edits（防 beforeunload flush 回写竞态）+ 带新 `?seed=` 重载）；
  `main.js` 固定 seed 12345 已改「有存档读存档、无存档随机生成（24bit）」；`?seed=` URL 复现入口
  保留（M3 起全部性能/视觉冻结 spec 统一钉 `?seed=12345` 保持可复现基线）。
  启动前提已满足（M2 同 seed 人工比对 2026-08-31 通过）。

**测试：**
- [x] HUD 元素可见（`tests/m3-hud.spec.mjs`：坐标/biome/seed 行 + 快捷栏 5 格图标裁剪 + ⚙ 按钮 +
  perf 面板截图；biome=CITY 数据级一致性）
- [x] 设置面板：打开 uiModal 门控玩家输入暂停（按 W 不动）；视觉风格 night 运行时即时生效；
  音量/风格持久化 localStorage 并重载读回；视距切换 = 持久化 + 带参重载（applyViewDistance）
- [x] 新世界生效：newWorld 后 seed 变化 + 地形指纹不同 + edits store 清零；重启读回同一新 seed；
  `?seed=777` 固定参数全新上下文两次启动逐格一致（确定性红线 2 回归）；单测 7 用例
  （tileStyle 裁剪数学 + resolveSettings 三级合并/钳制）

### Task M3-5: 性能回归基线脚本

**目标：** Playwright 自动跑图采样帧时，输出性能报告。

**设计文档参照：** §8（性能验证方案）

**实现要点：**
- [x] 自动跑图脚本（`src/bench/baseline.mjs`，`npm run bench`）：钉 seed=12345 + 每场景独立
  browser context（IndexedDB 隔离）；冲刺路线含跨 region（实证选定 z=-100 干燥无障碍走廊，
  x=620 起 40s/255 格跨 x=800 边界；两处实证教训记录在脚本注释：城市东侧深海/树冠悬叶挡路）
- [x] 采集帧时分布（p50/p95/p99）、GEN/MESH/LIGHT/upload 队列 p95、上传耗时（scheduler
  新增 upload-ms 逐帧打点）+ fast-remesh/draw/sections/内存预算
- [x] 输出对比报告（`docs/m3-baseline.md` markdown 表格 + `.json` 机器可读基线）
- [x] 基线场景 4 个：① 平原冲刺（跨 region）② 城市中心环视（360° 最坏 draw）③ 连续放/挖 200 块
  ④ 模拟 TNT 批量删除 500 块（逐列扫地表真删 500、affected 684 sections、REMESH 异步收敛）

**测试：**
- [x] 跑图脚本可重复执行（两次连跑 fps/draw/sections 完全一致，无 flaky）
- [x] 性能回退 >10% 阻断（`npm run bench -- --check`：结构类 2%/性能类 10%/fps 仅同 adapter 对比；
  负向验证：人为虚高基线 16.7% → 报 4 场景回退 + 退出码 1）

### Task M3-6: 性能报告 + 第一阶段收尾

**目标：** 输出第一阶段性能报告，确认 §1 目标表全部达标。

**实现要点：**
- [x] 性能报告（`docs/m2-m3-performance-report.md`）
- [x] §1 目标表逐项核对（6 项全 ✅：冷启动 worldReady 0.48~0.55s <2s；视距 8 默认 120fps +
  vd=12 冒烟通过佐证「架构支持 16+」；跨 region 无感知；编辑 p95 1.8ms；存档 50 块 1.7KB）
- [x] 与 mc-lite 对比数据（视距 ~4×、冷启动数十~百倍、存档 ~千倍、跨 region/放挖响应质变；
  引 §2 瓶颈诊断逐项回应）

---

## M3.1 背包 ✅ 完成并提交（2026-09-02，TDD 全程）

**背景（口径收口）：** 设计文档 §4.5.4 原写「第一阶段实现创造模式无限背包」，而 v1.12 修订说明
同期写「背包、完整 Hotbar 与玩家生存战斗均保持独立后续 Epic」——二者冲突。M3-4 实施时按 v1.12
口径只落地了快捷栏 5 格展示层（`src/ui/hotbar.js` + `HOTBAR_ITEMS` 常量数组），**物品数据模型缺位**：
无 `slots`、无 `selectedSlot`、Z 键无响应、放块直接索引常量数组。
v1.16 修订说明已定稿：**背包归 M3.1**，v1.12 的推迟范围收窄为仅玩家生存战斗与物品消耗规则
（`PlayerVitals`、掉落/拾取、`count` 递减）。完整规格见设计文档 §4.5.4。

**排序依据（非依赖）：** M4 与背包在数据层解耦——M4 spec 第 13 行明确排除「弹药/装填/背包消耗」，
武器切换走独立 `WeaponController.selectWeapon/cycleWeapon`（KeyR），不经过快捷栏。先做背包的唯一
理由是 M4 Task 6 要重写 `player.js` 的 `keydown` 入口，背包也在同一段挂 Z/Escape，一次改到位；
同时 M3.1 修正的 `uiModal` 门控漏洞是 M4 的前置条件（见下）。

**目标：** 补齐创造模式无限背包 —— 物品数据模型 + Z 键背包面板 + 快捷栏改读 slots + 输入门控修正。

**mc-lite 参照：**
- `src/actors/player/Slots.js`（`Slot` / `Inventory` 数据模型，107 行）
- `src/ui/Inventory.js`（Z/Escape/数字键 + 点击选中 + DOM 网格渲染，130 行）
- `src/ui/HUD.js:158-253`（`renderHotbar()`：快捷栏 = `inventory.slots[0..4]` 视图）
- `src/core/Game.js:206-323`（物品填充，`DEFAULT_INVENTORY_COUNT` 1500）
- `src/style/global.css:22-63`（`#inventory-modal` / `#inventory-content` / `#inventory-grid` / `.slot` / `.item-name`）
- `index.html:185-190`（背包 DOM 骨架）

**实现要点：**
- [x] 物品数据模型（`src/player/inventory.js`）：`Slot{id,item,count,meta}` + `set/clear/isEmpty`、
  `Inventory(size)` + `slots/selectedSlot/add/remove/has/getSelected/selectSlot`（照搬 mc-lite
  `Slots.js` 语义：`isEmpty()` = `item===null||count<=0`，`add()` 先堆叠同类再找空位）；
  **两个数字勿混**：`Inventory(size = 1000)` 是槽位数（mc-lite `Slots.js:57`），
  `DEFAULT_INVENTORY_COUNT = 1500` 是创造模式填充时每格的 count（mc-lite `GameConfig.js:9`）——
  原设计文档 §4.5.4 曾写「1500 格语义」混淆二者，v1.16 已勘误。M3.1 填充 122 槽（物品集合大小），
  其余 878 槽留空供后续生存 Epic 的掉落/拾取
- [x] 创造模式不消耗：`count` 仅占位，放块/挖掘不递减，`remove()` 保留供后续生存 Epic；
  **UI 不渲染数量**（产品决策，mc-lite 渲染，无限背包下显示 1500 是噪声）
- [x] `BlockRegistry.all()`（§4.1 补记）：按注册顺序返回 `{id,name}[]` 只读快照，冷路径专用，
  禁入 meshing/物理热路径
- [x] 物品集合：BlockRegistry 全部 126 条目排除 `air`/`collider`/`calcite`/
  `realistic_trunk_collider`（功能性方块，mc-lite 背包同样排除这 4 项）→ **122 项**；
  **2026-09-03 起口径变更为 121 项**（再排除 `chimney`，见下方「## 背包物品集合口径变更」章节）；
  `bed_alias_block`/`mine_cart` 无 faces-data 因而无图标 tile，渲染空槽（mc-lite 背包包含二者）。
  **顺序冻结**：`slots[0..4]` = `stone`/`dirt`/`grass`/`sand`/`cobblestone`（即既有
  `HOTBAR_ITEMS`，保持快捷栏默认观感与 `tests/m3-hud.spec.mjs` 断言不变），其余 117 项按
  `registry.all()` 注册顺序追加。理由：`blocks-data.js` 注册序前几位是 `water`/`swamp_water`/
  `cloud`/`glass_block`/`glass_blink`，纯注册序会让快捷栏前 5 格变成这些非常用建材
  （mc-lite 用 `Game.js:206+` 手工列举 107 条、`stone` 居首达到同样效果）
- [x] `Player` 接入：`placeBlock()` 改读 `inventory.getSelected().item` 解析 ID，不再索引
  `HOTBAR_ITEMS` 常量；`hotbarIndex` 收敛为 `inventory.selectedSlot` 的别名（单一权威，
  避免两份选中态）
- [x] 背包面板（`src/ui/inventory.js`）：Z toggle / Escape 关闭 / 数字键 1-5 / 点击槽位选中；
  DOM 样式照搬 mc-lite `global.css`（600×400 灰底内容框 + 8 列网格 `overflow-y:auto` +
  48×48 斜角浮雕槽位 + `.selected` 3px 黄边 + 32×32 pixelated 图标 + `.item-name` 10px 白字）；
  只列非空槽；样式表按 `settings-panel.js` 同法注入（`mc-` 前缀、幂等）
- [x] 快捷栏改读 slots（`src/ui/hotbar.js`）：5 格内容来自 `inventory.slots[0..4]`、高亮读
  `selectedSlot`；`selectedSlot > 4` 时 5 格**无高亮**（mc-lite 同行为）
- [x] **输入门控修正（既有漏洞）**：`game.uiModal` 原先只在主循环
  `if (!this.uiModal) this.player.update(dt)` 生效，而 `Player._bindInput()` 的
  `window.keydown` 不受拦截 → 模态打开期间新按的键仍写入 `keys`、改选中格。M3.1 在 keydown
  入口加 `uiModal` 守卫（数字键选中一并拦截）。**该守卫是 M4 Task 6 的前置条件**
  （M4 在同一段 keydown 挂 `KeyR` 切武器，无守卫则面板开着按 R 会切武器并播音效）
- [x] **模态栈（收口单一布尔的多面板竞争）**：`uiModal` 原为可写布尔，只有设置面板一个消费者时
  够用；背包加入后二者互相踩——设置面板开着时按 Z 开背包、再关背包会把 `uiModal` 置 false，
  令仍在显示的设置面板失去门控（WASD 恢复移动）。改为 `game.pushModal(owner)` /
  `popModal(owner)`（只移除自己的 owner）+ `uiModal` getter（栈非空即 true，读取侧不变、
  不可写）。mc-lite 无面板互斥（`UIManager.js` 里背包与设置各自独立 toggle），但它也没有
  共享门控标志——本仓库的 `uiModal` 是 M3-4 引入的，互斥责任落在这里
- [x] **pointer lock 恢复（口径与 mc-lite 不同，有意）**：mc-lite `Inventory.toggle()` 关闭时
  `document.body.requestPointerLock()`；本仓库 lock 目标是 **canvas**
  （`canvas.click` 入口 + `document.pointerLockElement !== this._canvas` 守卫），
  锁 body 会让视角与放挖全部失效。故关闭面板时 lock 回 `player.canvas`，两个面板统一；
  程序化 `requestPointerLock()` 可能因 `SecurityError` 失败（需用户手势、无头环境尤甚），
  调用处 try/catch 吞掉，失败回落到既有「点击画面重新锁定」。设置面板原 `close()`
  未做 lock 恢复，M3.1 一并补齐

**测试：**
- [x] 单测（`src/tests/test-inventory.js`）：`Slot` set/clear/isEmpty（含 `count<=0` 视为空）、
  `Inventory` size=1000 槽位/selectedSlot/getSelected/selectSlot、`add()` 堆叠优先再找空位、
  `has()` 跨槽累加、`remove()` 扣减到 0 清空、物品集合 122 项且排除项不在内、`registry.all()`
  顺序与数量、前 5 项 = HOTBAR_ITEMS（顺序冻结）、创造模式填充不消耗
- [x] 单测（`src/tests/test-inventory-ui.js`）：Z toggle 显隐、Escape 仅打开态关闭（关态按
  Escape 不误清设置面板门控）、点击槽位改 `selectedSlot`（含越出 5 格）、数字键 1-5、
  模态栈 push/pop 不误清他人、样式表幂等注入、600×400/8 列/投影等 mc-lite 样式口径、
  图标 tile 裁剪、count 不渲染、空槽不列出（data-index 仍是真实槽索引）、无 tile 物品降级、
  dispose 摘除监听与 DOM
- [x] Playwright（`tests/m3-1-inventory.spec.mjs`）：物品模型（122 项/快捷栏 = slots[0..4] 视图/
  排除项/registry.all 同源）+ Z 键 toggle + 模态栈 + keydown 守卫（背包开着按 W 不进 keys）+
  点击第 8 格后放块用该方块（世界实际写入 ID 校验、非 stone）+ 创造模式放块后 count 不变 +
  模态栈不误清设置面板门控（设置开着按 Z 开背包、关背包后 settings 门控保持）+
  `uiModal` 只读 + z-index 背包高于设置面板 + count 不渲染（120 个图标 / 2 个降级空槽）
- [x] 回归：既有 32 Playwright 用例 + 浏览器内单测全绿、lint 0 error、
  `npm run bench -- --check` 性能无回退（背包为纯 UI + 冷路径构建，不应触碰帧预算）

**实测与门禁诊断记录（2026-09-02）：**

- 单测 170 → **216**（+46：`test-inventory.js` 22 项物品模型 / `test-inventory-ui.js` 24 项面板 UI）；
  Playwright 32 → **38** 用例（`tests/m3-1-inventory.spec.mjs` 6 项真实游戏集成）。
  全量回归 **38 passed / EXIT=0**，单测 **216/216**，lint **0 error**（9 个既有 camelcase warning 不变）。
- **门禁第一次阻断：`fastRemeshP95: 1.1 → 1.3`（回退 18.2%）——本次改动引入的真缺陷。**
  根因：`hotbar.js` 的 `update()` 里写了 `slots.slice(0,5).map(...)`，**每帧产生 2 个临时数组**；
  120fps × 6s 编辑场景 ≈ 1440 个待回收数组，GC 压力正好落在 fast-remesh 的计时窗口内。
  改为逐格 `itemAt(i)` 取值（零分配）后，该指标与 HEAD 分布完全一致（HEAD 1.1/1.2、改动后 1.1/1.2）。
  **教训：每帧调用的 UI 同步路径禁止 `slice`/`map`/解构展开等隐式分配**——成本不在计算而在 GC 停顿，
  且只会体现在编辑类场景的 p95 上（稳态渲染场景看不出）。
- **门禁第二次阻断：场景④ `frameP95: 9 → 10`（11.1%）——抖动离群值，非回退。**
  按「诊断不猜」纪律做 HEAD 对照（`git stash -u` 后跑 `bench --out /tmp/...` 不覆盖基线）：
  HEAD 3 次 = 9 / 9.2 / 9.2；改动后 6 次 = 9.1 / **10** / 9.2 / 9.3 / 9.1 / 9.2。
  仅一个离群值，其余与 HEAD 同分布；同场景 fps 反而更高（改动后 119.36~120.03 vs HEAD 118.64~119.4），
  且 `draw=526`/`sections` 等结构类指标逐次完全一致。
  `frameP95` 在 120Hz vsync 锁帧下被量化到 8.33ms 台阶（9.1 vs 10 是抖动跨台阶，非负载差 1ms），
  10% 阈值对这个指标过于敏感。**未改任何阈值、未重录基线**（冻结断言纪律），复跑门禁通过（EXIT=0）。
- 基线文件 `docs/m3-baseline.{md,json}` **未被覆盖**（全程用 `--out /tmp/...` 或 `--check` 只读模式），
  冻结基线仍是 M3-5 提交的那份。
- **提交前全量回归遇到 `m1-acceptance` 放挖压力项失败（HEAD 对照实证非本次回归）**：
  失败值 `frameMs.p95 = 16.700000762939453`（float32 的 16.7，断言 `< 16.7`）。
  因该测试测的正是**放挖压力帧时**、而 M3.1 恰好改了 `placeBlock()`，不能凭「已记录 flaky」放过，
  故 `git stash -u` 后在 HEAD（含文档、不含 M3.1 代码）上连跑 5 次对照：
  | 运行 | HEAD（无 M3.1 代码） | 改动后（有 M3.1） |
  |---|---|---|
  | 1~5 | ✅✅❌✅❌ = **3/5 通过** | ❌❌✅❌✅ = **2/5 通过** |
  三条决定性证据：① 失败值在两侧**逐位相同**（16.700000762939453），是 120Hz vsync 把帧间隔
  量化到 8.33ms 台阶的产物，断言数学上就是在赌量化落点；② HEAD 上同样失败 2/5，与 M3.1 代码无关；
  ③ 真正的编辑冻结门两侧都达标（`placeP95` 1.6~1.9ms、`digP95` 1.7~1.8ms，阈值 <2ms）——
  M3.1 改的是物品查找路径（`registry.idOf(slot.item)` 查 Map vs 原数组索引），均 O(1)，不涉帧时。
  40% vs 60% 在 n=5 下不显著（二项检验 p≈0.5），与已记录口径一致（「不同断言轮流失败、单独复跑通过」）。
  **未改阈值、未改断言**（冻结断言纪律）。
- 附带修复（非计划内，实施中发现）：① `eslint.config.mjs` 的 globals 漏了
  `KeyboardEvent`/`MouseEvent`/`getComputedStyle`（UI 单测需派发事件与读计算样式）；
  ② `Game.dispose()` 未清理面板——背包在 window 挂 keydown 监听，fixture 页多次构造 Game 会串扰，
  已补 `inventoryPanel?.dispose()`（设置面板无 window 监听，不需 dispose）；
  ③ 背包 z-index 设 80 > 设置面板 70——两个模态可共存于栈，后开的必须在视觉上层，
  否则设置面板开着按 Z 打开的是被完全盖住的背包。

---

## M3.2 方块朝向放置交互（M3 收尾补丁项，插在 M3.1 与 M4 之间）

**背景（口径收口）：** 设计文档 §4.3 原写「交互侧放置语义仍属第二阶段」，本文件第 211 行亦记
「朝向交互侧暂不实现：第二阶段随床/宝箱/门落地」——即它此前**没有排进任何已编号里程碑**。
逐项核实 M4~M7 的 spec 与 plan（grep `orientation`/`朝向`/`OrientationUtils`/
`getPlacementOrientation`）：M4 零命中（M4-1 GLB+音频 / M4-2 状态机+DDA+输入 /
M4-3 视图模型+曳光+联调，均不涉及方块朝向）、M5 零命中、M7 零命中；M6 唯一命中是
`setTestAim` 注释里的「设置朝向」，指**相机 aim** 而非方块朝向。

渲染消费侧 M2 已全部打通（`584813b`：mesher 读 `meta&3` 按 4 朝向旋转、`getSectionView`
打包 meta、Worker transfer），`chunk-column.set()` 的 `edits` 条目也早已带 meta；
缺的只有「玩家放置时算出朝向值并写入」与「挖块时记住朝向」两步。

v1.17 修订说明已定稿：从床/宝箱/门 Epic 中拆出独立实施为 **M3.2**，该 Epic 范围相应收窄为
「多方块结构 + `blockEntities` 富状态」。完整规格见设计文档 §4.3「朝向放置交互」。

**门控字段复用（实测证据）：** mc-lite 用 `orientationEnabled`（`BlockData.js` 默认值 true），
M0 转换后在 mc-heavy 名为 `orientationModes`。逐项核对两侧集合：

```
mc-lite orientationEnabled=true : 40
mc-heavy orientationModes>0     : 40
仅 mc-lite 有: (无)    仅 mc-heavy 有: (无)    集合完全一致: true
```

故直接复用 `registry.orientationModesTable[id]`（>0 即启用朝向），**不新增字段、不改 blocks-data.js**。
（附带勘误：M3.1 讨论时曾疑该表混入 `air`/`water`/`cloud`/`leaves` 像转换产物——实测 mc-lite
那边这 4 项同样是 `orientationEnabled: true`，属上游语义，非转换错误。）

> **实施期勘误（2026-09-03）**：上文「集合完全一致」指的是**启用集合（true）零差异**，结论成立。
> 但**不参与旋转的方块数两侧不同**——mc-lite 124 方块中 84 项、mc-heavy 126 方块中 **86** 项；
> 差额是 M2-7 新增的 `sky_stone`/`sky_grass`（门控均为 0，mc-lite 无此二方块）。本文件与设计文档
> §4.3 此前沿用了 mc-lite 的 84 未换算，实施时实测校正为 86（设计文档 v1.18）。单测已钉死这两个数字。

**mc-lite 语义更正（勿照印象实现）：** 放置朝向**不看玩家 yaw**——mc-lite 的
`getPlacementOrientation(x, y, z, type)` 签名里没有朝向参数。真实手感是「转身不改朝向；
要转 90° 就在原位挖掉再放回去」。

**目标：** 补齐玩家放置/挖掘侧的方块朝向语义（照搬 mc-lite 三分支 + 挖块记忆）。

**mc-lite 参照：**
- `src/actors/player/PlayerInteraction.js:413-445`（`getPlacementOrientation` 三分支）
- `src/actors/player/PlayerInteraction.js:399-407`（`recordRemovedBlock` / `clearRemovedBlock`）
- `src/utils/OrientationUtils.js`（`BlockOrientation` 枚举、`nextOrientation` = `+1 % 4`）
- `src/actors/player/Player.js:164,168`（`lastRemovedBlock` / `placementOrientationMemory` 两个状态）
- `src/constants/BlockData.js:12`（`DEFAULT_PROPERTIES.orientationEnabled = true`）

**实现要点（✅ 全部落地）：**
- [x] 纯函数模块（`src/player/orientation.js`，无 DOM/three，Worker 同构）：
  `nextOrientation(o) = (o + 1) % 4`；`getPlacementOrientation(...)` 三分支——
  ① `orientationModes[id] === 0` → 恒 0（mc-heavy **86** 个方块不参与旋转，见 v1.18 勘误）；
  ② `lastRemovedBlock` 且 **x/y/z/id 四者全等** → `nextOrientation(旧朝向)` 并写入类型记忆；
  ③ 类型记忆存在 → 沿用；④ 否则 → 0（EAST）
- [x] `world.getBlockMeta(x, y, z)`（`src/voxel/world-data.js`）：O(1) 直查 `column.meta`，
  越界/缺列返回 0。**与 M4 plan Task 2 口径一致**（该方法 M4 亦计划新增，M3.2 提前交付）
- [x] `Player` 两个交互状态：`lastRemovedBlock = {x,y,z,id,orientation}`（挖前读 meta 记下）、
  `placementOrientationMemory = Map<id, orientation>`（按类型记忆，跨位置、会话内持久）。
  二者是 UI 交互态，**不入世界数据、不持久化**（世界权威只有 meta 通道）
- [x] `digBlock()`：挖前 `getBlockMeta()` 读旧朝向 → `recordRemovedBlock()`；基岩拦截不变
- [x] `placeBlock()`：`getPlacementOrientation()` 算朝向 → 传入 `setBlock(..., meta)` →
  成功后清空 `lastRemovedBlock`。与 M3.1 的 `inventory.getSelected()` 取物品逻辑正交叠加
- [x] **明确不照搬**（各撞已定决策或属他 Epic）：① `inventory.remove(type,1)` 放置消耗
  ——M3.1 定稿创造模式无限背包不消耗；② `audioManager.playSound('put', 0.3)`
  ——第一阶段无音频消费方（M4 Task 4 才有 AudioManager）；③ `tryPlaceBed()` 床的多方块放置
  ——属床/宝箱/门 Epic，且 bed_head/bed_tail 在 mc-lite 本就 orientationEnabled=false
- [x] **M4 plan 注意事项**（v1.17 已写入 M4 plan 两处标注）：① Task 2 新增 `getBlockMeta` 的步骤
  改为「验证已由 M3.2 交付 + 补断言」；② Task 6 将 `digBlock()`/`placeBlock()` 改走
  `editor.setBlock(...)` 时**须保留 M3.2 的朝向分支**（`WorldEditor.setBlock` 已支持 meta 参数，
  M4 plan:332 `const meta = change.meta ?? 0`）

**测试（✅ 全绿）：**
- [x] 单测（`src/tests/test-orientation.js`，22 用例）：`nextOrientation` 循环（0→1→2→3→0）、
  门控集合（40 项 true / **86** 项 false）、三分支各路径、原位判定要求 x/y/z/id
  四者全等（改任一即不触发重转）、跨位置放置沿用类型记忆、`world.getBlockMeta` 越界/缺列返回 0、
  挖块记录含从 meta 读出的旧朝向、放置成功清空 `lastRemovedBlock`
- [x] Playwright（`tests/m3-2-orientation.spec.mjs`，6 用例）：放 `chest` 首次 meta=0；原位挖放四次
  meta 依次 1→2→3→0；跨位置放同类型沿用记忆；`stone`（orientationModes=0）恒 meta=0；
  带朝向方块存档后重启 meta 保留（edits 通路）；旋转后 section 重建无报错、draw 受控
- [x] 回归：既有 Playwright 用例（M3.1 后 38 → **44**）+ 浏览器内单测（216 → **238**）全绿、
  lint 0 error、`npm run bench -- --check` 通过（朝向只加 O(1) 计算与一次 meta 读，
  未触碰帧预算；m1-acceptance 贴线失败经 HEAD 对照证实为既有 vsync 抖动，见下方实施记录）

### 实施记录（2026-09-03，TDD 全程）

**落地文件**：3 新增 + 3 改
- 新增 `src/player/orientation.js`（`BlockOrientation` 枚举 + `nextOrientation` + `recordRemovedBlock`
  + `getPlacementOrientation` 三分支；纯函数，无 DOM/three，Worker 同构）
- 新增 `src/tests/test-orientation.js`（22 用例）、`tests/m3-2-orientation.spec.mjs`（6 用例）
- 改 `src/voxel/world-data.js`（加 `getBlockMeta`）、`src/player/player.js`（两个交互状态 +
  `digBlock`/`placeBlock` 接入）、`src/tests/index.html`（注册新单测）

**身份键口径**：mc-lite 用方块 name 作身份键，mc-heavy 世界权威是数字 id，故 `lastRemovedBlock`
记 `id`、记忆键为 `Map<id, orientation>`（id↔name 一一对应，「按方块类型记忆」语义等价）。
设计文档伪代码原写 `type`，实施统一改 `id` 并回填 v1.18。

**门禁诊断（m1-acceptance 放挖压力用例）**：全量回归时该用例失败于 `frameMs.p95 =
16.700000762939453` vs 阈值 `< 16.7`——超出门槛 7.6e-7，正是 CLAUDE.md 记录的「16.7±1e-6 贴线」。
因本次给 `digBlock()` 新增了一次 `getBlockMeta()` 读与一次 `recordRemovedBlock()` 对象分配
（M3.1 曾被门禁抓到「每帧分配致 fastRemeshP95 回退」的真缺陷），**未凭文档结论直接归为 flaky**，
做了 HEAD 对照：
- `git stash` 后在 HEAD 连跑 4 次：第 4 次出现**完全相同**的失败（`16.700000762939453 vs <16.7`），
  其余 3 次通过；
- 恢复改动后连跑 6 次采 `placeP95`/`digP95`：全部落在 **1.6~1.9**，无一超过 2ms 阈值；
  两侧分布完全重叠，无系统性回退。
- 结论：**既有 vsync 量化抖动**，非本次引入（失败的是 vsync 帧间隔抖动而非编辑负载）。
- 另：该用例偶发 `digP95 = 2` 贴线（HEAD 侧亦出现一次），单独复跑即通过。

**本项 draw 用例的稳定判据修正（测试设计缺陷，非抖动）**：`m3-2-orientation.spec.mjs` 第 6 用例
在完整回归负载下曾概率性失败（单独跑与部分 spec 组合跑均通过）。根因是自己写的稳定判据不足——
用「队列归零」（`inflight/meshInflight/uploadQueue` 全 0）当「世界稳定」的依据，但它只是**瞬时状态**：
高负载下后台仍在填充 sections 时队列可能短暂归零，此时采到的 `before.sections` 偏低，旋转期间世界
继续加载会让 draw/sections 增长，断言测的就成了「加载」而非「旋转」。
- 修正：改等 **sections 连续两次采样不变 + 队列归零**（跨帧比较，真正稳定后再采 `before`）；
  循环以 `dig` 结尾使末尾状态与 `before` 对等（否则多一个方块会让 before/after 比两块不同世界）；
  断言 message 带上实际值便于后续诊断。
- 修正后完整回归连跑 3 次，本项 6 用例全部通过（其中 1 次 44 用例全绿）。
- **教训**：`worldReady === true` 只表示出生点邻域就绪，后台仍在填充；「队列归零」不等于「加载完成」。
  需要「世界稳定」语义的用例应判 sections 停止增长，而非只看队列瞬时为空。

**性能门禁**：`npm run bench -- --check` 通过（4 场景 fps 112~120、p95 ≤16.6、draw 489~545，
与 `docs/m3-baseline.json` 基线无显著回退）。朝向只加 O(1) 计算与一次 meta 读，未触碰帧预算。

---

## 异形方块渲染勘误 ✅ 完成（2026-09-03，M3.2 之后独立 bugfix，设计文档 v1.19）

起因是「vine 高度向上溢出半格、疑似与 mc-lite 不一致」的观感报告，连带排查 cactus /
hanging_lamp / bed_head / bed_tail 四个异形方块。

**方法**：不靠手算推断。用 vendored three（r185.1，与 mc-lite 用的 three 同为标准几何类）精确复现
mc-lite `ChunkConsolidation.js` 的 `geomMap` 几何构造，实测包围盒；用真实 mesher 输出 UV 再反算回
PNG 行号，与 mc-lite 侧实测比对。

**实测推翻的三个前提**：

| 方块 | mc-lite 实测世界包围盒 | mc-heavy 原实现 | 判定 |
|---|---|---|---|
| vine | y∈[0.5, 1.5] | y∈[0.5, 1.5] | **一致**（双方共同溢出，非 mc-heavy 缺陷） |
| cactus | 主干 + 四侧枝五盒逐项相等 | 逐格相同 | **完全一致**，未改 |
| hanging_lamp | 绳 y[0.6,1.0] 八段棱柱、灯体 [0.35,0.65]³ | 绳 0.03 宽 cross 近似、灯体同 | 几何近似，改棱柱 |
| bed_head/tail | y[0, 0.5] | y[0, 0.5] | 几何一致，**UV 有真实 bug** |

1. **实例原点换算基准**（此前文档与代码注释均未写明）：mc-lite 几何以**块中心**为原点，四条放置
   路径全部 `position.set(x+0.5, y+0.5, z+0.5)`（`ChunkConsolidation.js:529` / `Chunk.js:2474` /
   `WorldWorker.js:181,416,457`）；mc-heavy 模板坐标以**块底角**为原点（0→1）。比对时须 +0.5 换算。
   已补记入 §4.3。

2. **vine 的溢出是双方共同的**：mc-lite `geoVine` = `PlaneGeometry(0.8, 1.0)` + `translate(0,0.5,0)`，
   局部 y[0,1]，加实例原点 +0.5 → 世界 y[0.5,1.5]。其源码注释「向上偏移0.5，使几何体从y=0到y=1」
   说的是**局部**坐标，误导。§4.3:544 原记录的 y∈[0.5,1.5] 是准确的。经确认后改为 y∈[0,1] 落在
   格内 —— **已知的有意偏离**，§4.3 已标注理由，视觉比对时勿按旧值判定。

3. **床 UV 是真实 bug，根因是「照上游定义实现而非行为」**：mc-lite 床材质定义 `repeat:[1,0.5]` +
   `offset:[0,0.5]`、顶面 `rotation:-π/2`，注释写「只使用纹理下半部分」「顺时针旋转90度」——
   **但 `offset` 与 `rotation` 全仓无任何消费点**（`grep -rn "\.offset\.set\|texture\.rotation" src/`
   零命中；`_createMaterial` 只消费 `repeat`，`preloadTextures` 只调 `_applyTextureSampling`），
   是死字段。实测生效的 uvTransform 是 `v' = 0.5*v` → 采样贴图**下半**（PNG 行 8~15，实测 92 个
   不透明像素）；顶面**不旋转**。原实现照字段名与注释实现了「取上半 + 顶面旋转」，而上半实测仅
   **32** 个不透明像素、RGB 均 rgb(40,25,25)，床走 opaque 通道 alpha 不参与混合 →
   **床侧面渲成一块深色而非床侧纹理**。
   - 修：`BED_UV` 的 `vHalf` → `vLowerHalf`（vv = 0.5*vv）+ 删 `rot`。
   - `uFlip` 保留：对应 mc-lite `repeat:[-1,0.5]`，实测 RepeatWrapping 下与纯镜像 uu=1-uu 等价
     （边界 u=0/u=1 采样同一 texel）。
   - **教训写入 §4.3**：对齐上游须实测其运行时行为，读定义推断会引入回归（与「诊断 bug 不猜」同一原则）。
     §4.3 原文「repeat/offset/rotation 等价角点变换（vHalf/uFlip/rot，three setUvTransform 核验）」
     正是此 bug 的根源 —— 它把**定义**当成了**行为**。

**附带改动**：hanging_lamp 绳从 0.03 宽 cross 近似改为 `CylinderGeometry(0.015,0.015,0.4,8)` 等价的
八段棱柱，复用 chimney 同款 `prismQuads`。UV 方向已与 three 实测核对（CylinderGeometry 侧面
`v = 1 - y/heightSegments`：顶 y=0.5→v=1、底 y=0.1→v=0，与 prismQuads 同向），贴图不上下颠倒。
顶点 32→120/实例。

**TDD 全程**：先写 RED（4 个新断言），实测确认失败原因正确（`vine y0 got 0.5` /
`hanging_lamp 顶点 32≠120` / `bed +X vv=1.00` / `bed +Y uu Expected 0 got 1`，页面错误 0），
再 GREEN。RED 探针脚本用完即 `mv` 到 `/tmp`（沙箱禁 `rm`）。

**验证证据**：
- 单测 238 → **241**（+3：hanging_lamp 棱柱、bed 侧面下半、bed 顶面不旋转）；vine 是改既有断言
- 全量 Playwright 回归首次 **44/44 全绿**（那次 m1-acceptance 亦通过）
- `npm run lint`：0 error、9 个既有 camelcase warning（模板键名必须用方块名，非本次引入）
- `npm run bench -- --check`：通过（fps 112.94~120.21、p95 ≤16.6、draw 489~545，无回退）

**落地文件**：2 改 —— `src/mesh/mesher.js`（vine 模板 / hanging_lamp 模板 / BED_UV 三处）
+ `src/tests/test-mesher.js`（vine 断言改 + 3 个新用例 + atlasMeta 补 bed tile）。

> **后续复跑的补充说明（如实记录）**：首轮 44/44 之后，后续复跑 m1-acceptance 出现概率性失败
> （`digP95=2` 贴线、或 `frameMs.p95=16.700000762939453` vs `< 16.7`）。经 HEAD 对照连跑 4 次
> 证实为**既有抖动**（HEAD 侧同样出现 `digP95=2`，两侧分布完全重叠），详见下方
> 「## 背包物品集合口径变更」的门禁对照小节。首轮全绿不代表此后每次都全绿。

---

## 背包物品集合口径变更 ✅ 完成（2026-09-03，设计文档 v1.20 → v1.21 回填床三项）

`chimney`（烟囱）与床三项移出背包物品集合，**122 项 → 118 项**（填充 118 槽、其余 882 槽留空）。
分两次落地：先 chimney（v1.20），后床三项（v1.21）。

**为什么不并入 `NON_PLACEABLE_ITEMS`**：该集合语义是「**非玩家可放置**的功能性方块」
（`air`/`collider`/`calcite`/`realistic_trunk_collider`），而这些方块都能放能挖，是正常
**可放置**方块。把它们塞进去会让集合语义失真 —— 后续若有人读该集合判断「能否放置」会得出
错误结论。故新增独立常量 `HIDDEN_FROM_INVENTORY`（语义：**可放置但不进背包**），
与 `NON_PLACEABLE_ITEMS` **语义互斥**（测试里加了互斥断言，防两个集合被混为一处）。

**对齐依据实测核对（非推测）**：mc-lite 背包清单是 `Game.js:206+` **手工列举 107 项**
（`grep -n "inventory.add(" src/core/Game.js` 提取 107 条），实测 `chimney`/`bed_head`/`bed_tail`
**不在其中**；`bed_alias_block` **在**（本仓库一并移除是因为它 `cullMode:'none'` 不渲染、
无法出图标，放进背包只会渲染一个空槽）。

**床三项是规避而非修复（2026-09-03）**：床渲染有**未修复的镂空透视问题**（床侧面有一个面
没有贴面 → 出现透视穿帮）。按指令**搁置修复**，只在 `src/mesh/mesher.js` 的 null 面跳过处写
TODO 标注（含待验证假设：mc-lite 那几面是 `transparent:true + opacity:0`（面仍在、只是透明，
可能仍写深度缓冲），本仓库是**直接不发射面**（真镂空），二者语义可能不等价——需实际验证
mc-lite 材质的 depthWrite 实际值 + 截图对比后再修）。规避手段 = 不入背包 → 玩家选不到 →
实际不会被放置。**这是绕过，不是修复**；床渲染本身归属床/宝箱/门多方块 Epic。

**顺带实测记录两侧集合差异（本次未处理）**：

| 方向 | 内容 |
|---|---|
| mc-heavy 有、mc-lite 清单没有 | `chimney` + `bed_head`/`bed_tail`/`bed_alias_block`（**本次已排除**）；以及 `swamp_water`、`sky_wood`/`sky_stone`/`sky_grass`/`sky_leaves`（M2-7 空岛新增，mc-lite 清单成文时尚不存在）、`azalea_log`、`vine`、`lilypad`、`realistic_oak_leaves`/`realistic_yellow_leaves`/`swamp_leaves`、`playground_block`/`playground_center_block`（**未处理**） |
| mc-lite 清单有、mc-heavy 没有 | `gold`（mc-heavy 无此方块） |

**本次只按指令排除 chimney + 床三项**，其余差异项未动 —— 全面对齐 mc-lite 的 107 项需单独决策
（`sky_*` 是本仓库独有的 M2-7 内容，不宜简单删除）。

**附带修正一处测试实现缺陷**（`tests/m3-2-orientation.spec.mjs` 末尾队列断言）：
- 现象：全量回归负载下概率性失败于 `expect(settled.meshInflight).toBe(0)`，读到 `meshInflight=32`；
  单独跑 6/6 通过。
- 根因：用例在 241-244 行已 `waitForFunction` 等过队列归零，但**之后立刻采样**（中间隔了几个
  同步断言）。那几帧里世界可能又开始加载（光照异步收敛触发 remesh、或视距内 column 到达），
  于是直接采样读到非零。
- 修法：改为**再次等待收敛后断言**。「无永久积压」语义与检查强度不变 —— 若真有永久积压，
  等待会超时失败。**不是削弱断言**，是消除采样时机竞态。
- 注：本次 hanging_lamp 顶点数 32→120 会让含吊灯的 section mesh 变慢，**拉长这个窗口**（故本次
  更容易触发），但根本原因是断言实现方式，与 hanging_lamp 改动无因果关系。

**门禁对照（m1-acceptance，未凭文档结论免责）**：改动侧首次全量回归 m1-acceptance 失败于
`digP95 = 2` vs `< 2`（贴线），而 HEAD 侧那次失败在**不同行**（`frameMs.p95`）。因 hanging_lamp
顶点数增加确实提高了 mesh 负载，**做了 HEAD 对照连跑**（`git stash` 全部改动，两侧各跑 4 次）：

| 侧 | placeP95 | digP95 | 结果 |
|---|---|---|---|
| HEAD | 2.0 / 1.9 / 1.9 / 1.9 | **2.0** / 1.9 / 1.9 / 1.8 | 3 失败 / 1 通过 |
| 改动侧 | 1.8 / 1.9 / 1.9 / 1.8 | 1.9 / **2.1** / 1.7 / 1.8 | 4 失败 / 0 通过 |

- **HEAD 侧同样出现 `digP95=2`**（run 1），证明贴线非本次引入；
- 两侧均值几乎相同（改动侧 placeP95 均值 **1.85** < HEAD **1.925**、digP95 **1.875** vs **1.9**），
  分布完全重叠 → **无系统性回退**；
- 两侧 `placeMax` 都在 4~8.5ms 区间，证明该测量本身抖动很大（量化步长 0.1ms）；
- 多数失败落在 `frameMs.p95` 的 vsync 量化抖动（CLAUDE.md 已记录类）。
- **如实记录**：改动侧出现过一次 `digP95=2.1`（真正超过阈值），HEAD 最大是 2.0（`< 2` 严格比较下
  同样失败）。4 次样本偏少，但结合 `bench --check` 通过（fps 112.94~120.21、draw 489~545 无回退），
  证据支持「无系统性回退」而非「本次引入的回退」。

**TDD 全程**：先写 RED（含 `HIDDEN_FROM_INVENTORY` 互斥断言 + 计数），实测确认失败原因正确
（chimney 轮页面错误 `does not provide an export named 'HIDDEN_FROM_INVENTORY'`；床轮 7 个断言
失败于计数 121→118 与集合内容，页面错误 0），再 GREEN。RED 探针脚本用完即 `mv` 到 `/tmp`（沙箱禁 `rm`）。

**验证证据**：单测 chimney 轮 241 → 242（+1），床轮随集合缩到 118 项计数变化（用例数不变，
仍 242）；`npm run lint` 0 error、9 个既有 camelcase warning；全量回归除 m1-acceptance 既有抖动外全绿。

**落地文件**：
- chimney 轮 5 改 —— `src/player/inventory.js`（新常量 + `buildItemNames` 过滤 + JSDoc 计数）
  + `src/tests/test-inventory.js`（互斥断言 + 计数 122→121、117→116）
  + `src/tests/test-inventory-ui.js`（DOM 槽数 + 末槽下标 121→120）
  + `tests/m3-1-inventory.spec.mjs`（计数 + 排除清单加 chimney + `withIcon` 120→119）
  + `tests/m3-2-orientation.spec.mjs`（末尾队列断言改再次等待）。
- 床轮再改同一批文件（计数 121→118、`HIDDEN_FROM_INVENTORY` 扩到 4 项、`withIcon` 119→117、
  `noIcon` 2→1）+ `src/mesh/mesher.js`（null 面跳过处加 TODO 标注床渲染镂空问题）。

---

## 吊灯材质自发光 ✅ 完成（2026-09-03，设计文档 v1.21）

起因是「吊灯贴图图案看起来像背包图标贴在方块上」的观感报告。**实测核对后确认根因不是贴图错误**：

- mc-lite 的 `hanging_lamp` 材质（`MaterialManager.js:1197-1220`）确实有 `textureGenerator`
  （画绳/灯体/发光区/高光），**世界渲染用了这张程序化贴图**；背包图标（`HUD.js:117-152` 的
  `generateIcon()`）取的正是**同一个材质**的 `mat.map` —— 即 mc-lite 的背包图标与世界贴图
  **同源同一张**。`geoHangingLamp`（`ChunkConsolidation.js:216-227`）用 `mergeGeometries` 合成
  单 geometry + 单材质 → 所有面共享那张贴图，这也是 mc-lite 行为。
- **「背包图案贴在方块上」在 mc-lite 里同样成立**，不是 mc-heavy 的缺陷。
- **真实差异是材质自发光缺失**：mc-lite 材质有 `emissive:'#FFE4B5'` × `emissiveIntensity:0.8`
  （灯体呈发光暖黄），mc-heavy 三通道是 `MeshBasicNodeMaterial`（贴图色 × shade，无自发光）
  → 图案静态呈现。**`blocks-data.js:142` 的 `emissive:15` 是 blocklight 光照源**（照亮周围方块），
  **不是材质自发光**，两个概念不可复用。

**实现（新增 packed bit13 顶点位）**：

- 实测 mc-lite **只有 hanging_lamp 一处**有材质自发光（其余材质 emissive 均默认 0），故**不能给
  整个 cutout 通道加**（会让 vine/flower/leaves 全部发光）→ 按方块区分，用顶点 **bit13** 传递。
  packed 布局：bit0-7 light / bit8-9 AO / bit10-12 面索引 / **bit13 材质自发光（新增）**。
- `mesher.js`：hardcoded Set `EMISSIVE_MATERIALS = ['hanging_lamp']`（与 `DOUBLE_SIDE_CUBES`/
  `SAME_TYPE_CULL` 同模式，表达 mc-lite **材质层属性**，不入 blocks-data）。逐方块算一次
  `emissiveBit = 1<<13`，两处 packed 写入点（模板路径 + 立方体路径）都 OR 上它。
- `materials.js`：片元解包 `vEmissive = vertexStage(packed>>13 & 1)`，emissive 是
  `MeshStandardMaterial` 语义的**独立加项**（不乘贴图色、不受光照/AO 影响 → 黑夜中灯依然发亮），
  故加在 `× vShade` 之后：`add(mul(texColor.rgb, vShade), mul(EMISSIVE_COLOR, 0.8).mul(vEmissive))`。
  **只挂 cutout 通道**（opaque 是最大通道，加恒 0 项会白付逐像素 mul+add）。发布粒度不变（红线 5）。

**TDD 全程 + 回归防线**：先写 RED（实现先 stash 撤下，实测确认 `hanging_lamp bit13 置位:
Expected 1, got 0`，再 GREEN）。新增 4 用例，其中一条是**回归防线**：钉死「`glowstone`
（有 blocklight 源）不得置 bit13」—— 若有人图省事用 `registry.emissiveTable` 判断本位会立刻抓到。

**视觉验证**（单测测不到 TSL 节点的 GPU 效果，必须截图确认）：改动侧 vs HEAD 截图像素级 diff ——
**2006 个像素有差异**（0.22%）、最大单像素差异 420（`rgb(200,219,208)` vs `rgb(53,94,60)`）、
**整体亮度均值不变（150 = 150）** → 只有吊灯局部变亮，其余方块不受影响，符合预期。截图证明
HEAD 侧灯体暗（贴图色），改动侧灯体明亮暖黄。

**门禁对照**（未凭文档结论免责）：`bench --check` 通过（fps 110.25~120.41、draw 489~545，无回退）。
m1-acceptance 的 `digP95` 曾疑似上移，经 HEAD 对照各连跑 4 次证实为抖动：

| 侧 | placeP95（4 次） | digP95（4 次） | 均值 |
|---|---|---|---|
| HEAD | 1.8 / 1.8 / 1.9 / **2.3** | 1.9 / 1.8 / 1.8 / **2.1** | 1.95 / 1.90 |
| 改动侧 | **2.3** / 1.8 / 1.7 / 1.9 | **2.4** / 1.6 / 1.7 / 1.9 | 1.93 / 1.90 |

**HEAD 侧峰值（placeP95 2.3、digP95 2.1）与改动侧相当**，两侧均值几乎相同 → 分布完全重叠、
无系统性回退。另：`structure-gen` 的 GEN p95 断言在全量负载下概率性失败一次，单独跑 3 次全通过，
且 `test-structure-gen.html` **不 import mesher.js/materials.js** → 机制上不可能影响 GEN 计时。

**验证证据**：单测 242 → **246**（+4）；`npm run lint` 0 error、9 个既有 camelcase warning；
全量回归除 m1-acceptance 既有抖动外全绿。

**落地文件**：3 改 —— `src/mesh/mesher.js`（`EMISSIVE_MATERIALS` Set + 两处 packed 写入 OR bit13）
+ `src/render/materials.js`（bit13 解包 + cutout 通道 emissive 加项）
+ `src/tests/test-mesher.js`（+4 用例，含 glowstone 回归防线）。

---

## M3.2 之后的独立 bugfix / 改造记录（v1.22 ~ v1.31）

按时间序。详细实施记录见 CLAUDE.md 的进度条目与设计文档对应版本的修订说明，此处只记
「做了什么 + 状态 + 对后续的影响」。

| 版本 | 事项 | 状态 | 要点 |
|---|---|---|---|
| v1.22 | 吊灯 UV 分区与 quad 级自发光 | ✅ `b9b8699` | **已知有意偏离 mc-lite**（实测 mc-lite 两几何 UV 均为全幅、绳吃 emissive 呈亮色）。目标外观：绳单色深灰 + 灯体发光暖黄 + 灯面不含绳图案。模板 quad 加可选字段 `uvRegion`/`em`；chimney 等同款 prismQuads 行为零变化 |
| v1.23 | 背包专用图标表 | ✅ `245fb4d` | 台阶类图标与母方块撞脸 → 用 atlas 里 13 个 orphan tile 中的 5 张专用图标。follow mc-lite 的做法（其机制在 `ItemIconUtils.js`，v1.24 勘误了 v1.23 文档对此的两处错误论断） |
| v1.24 | 异形方块等轴测图标 | ✅ `cd0d7d4` | 9 项异形方块（栏杆×3 + 柱子×2 + 台阶×4）改离线烘焙等轴测投影图标。**形状权威 = mesher `TEMPLATES`**（加 export）；采样走 faces-data 的游戏内实际贴图 → 配色与世界渲染一致。v1.23 的 4 张手工台阶图标 tile 变 orphan |
| v1.25 | 测试分级策略与静态门禁 | ✅ `8e9f721` | 分级判据 = 「改坏了会怎样、多久能被发现」，非改动大小。Tier 1 必须 TDD / Tier 2 门禁断言免 TDD / Tier 3 免测试 / Tier 4 像素实测。新增 `check:arch`（红线静态门）+ `check:data`（关系型断言取代硬编码计数）。权威：`docs/testing-policy.md` |
| v1.26 | 全量背包图标离线烘焙 | ✅ `176e419` + `c8e9dc9` | **运行时约 91 行 → 1 行**（预生成 CSS 串取代查表+裁剪数学）。独立 `icons-atlas.png`（与世界 atlas 解耦 → v1.24 的 tile 重排副作用消失）；按显示尺寸烘焙两套（40/32px）；覆盖全量 118 项（等轴测 104 + 平面 14）。`check:data` 加**图标过期指纹检查**（含贴图内容哈希）。删旧脚本 + 9 张死 PNG → 世界 atlas 156 → 147 tile |
| v1.27 | 背包槽位点选抖动修复 | ✅ `65254f9` | 根因实测定位（非推测）：`.mc-slot` 未声明 `box-sizing` → `content-box`，选中边框 2px→3px 把总盒撑到 54×54 → grid 该行变高 2px → 下一行整体下移（**实测位移 2px**）。修法 `border-box` + 尺寸显式写 52（等价总盒，未选中态像素级不变）。`transition: border-color` 只过渡颜色 → 印证增粗是无意引入的副作用。Tier 3，免 TDD |
| v1.28 | 等轴测图标遮挡修复 | ✅ `f76055b` | **几何本身没问题**（与 mc-lite `ChunkConsolidation.js:188` 逐格核对一致），问题在投影算法两个 bug：① 深度度量 y 符号反了（正确 = `x+y+z`，由投影轴叉乘得法线 `(-1,-1,-1)` 推出；曾写 `x+z-y`，对只在 y 上不同的两点判定相反）；② painter 用面平均深度排序，对被整片遮住的面无能为力。**只改度量不够**（实测 88px → 仍 88px → 加逐像素深度测试才降到 4px）。blast radius：异形 10 项内部面归属修正、轮廓 alpha 差异全为 0；实心 94 项最大色差异 5px。Tier 1，TDD + 两条互为镜像的回归防线 |
| v1.29 | 设置面板「删除缓存」按钮 | ✅ `598f10b` | `Game.clearSave()` = 清 edits **保留 seed 与设置**（与 `newWorld` 换 seed 语义不重叠，二者区别见设计文档 §4.8 表格）。竞态三步抽成共用 `_discardEdits()`（写两份会漂移，红线 1 精神）。**竞态防护实测口径修正**：原注释「不清内存 edits 就会被 unload 写回」强度被证伪 —— 对照实测显示卸载事务能否提交时序不定（多一次 evaluate 往返则写回 savedColumns 0→1；紧跟 location.reload() 则被中止读回 0），故端到端断言会让缺陷静默逃逸（负向验证：注释掉该步 E2E 仍全绿）→ 正确门禁 = 内存侧断言（memEdits===0）。Tier 1（竞态），TDD + 负向验证 |
| v1.30 | 沼泽睡莲（lilypad）水洞与沉水修复 | ✅ `c491e8a` | 用户报两个视觉缺陷：① 睡莲「镶嵌」在沼泽水中像水洞（自身无水、周围一圈水）；② 叶面与水方块**底面**对齐 → 沉在水面下。用户提的修复思路（生成高度+1 且叶面下移半格贴合水面）**可行且数值经实测验证正确**。**根因两个独立问题**：① `apply.js:206` `setBlock(wx, SEA_Y, ...)` —— `fillColumn` 水面填充区间 `(h, SEA_Y]` 使 `y=SEA_Y` 正是最高一层水格，被覆盖 → 水消失（且 `lilypad.solid=false` → 踩上去掉进洞）；② `TEMPLATES.lilypad` y=0.02 → 叶面 -1.98 vs 暴露水面顶面 -1.50，低 0.48。**mc-lite 自身沉水更严重**（叶面 -1.98 vs 整格水面 -1.0，低 0.98）却没人发现：其实例原点是块**中心**（+0.5 换算口径），且 lilypad 是**装饰实体**（`EntityManager.js:412`）不占体素格 → 天然无水洞，是 mc-heavy 搬成体素方块才引入的。**修复两处耦合**：模板 y `0.02`→`-0.48` + 格位 `SEA_Y`→`SEA_Y+1`（单独改任一处都错）。**落点判定的方法论坑**：`pointContext` 六个地标判定都在 water 分支之前 → 只按「biome+高度+随机数」筛出 12 个候选点，完整 GEN 后**落地 0 个**（全被 clay/sand 覆盖）；须复现优先级链，首个真实落点 `(-600,-270)`。**`big_house.json` 删 3 个草地 lilypad**：草地顶面是整格高、水面/台阶顶面是半格高，差半格 → 同一份几何无法同时贴合（保留会沉进草地 0.48），是「JSON 原样复用」的唯一有意例外。Tier 1（纯函数算法）TDD：4 测试 RED→GREEN 277/277 + **双向负向验证**（回退格位→2 个生成侧测试 FAIL 而 mesher 几何测试 PASS；回退模板 y→3 个几何测试 FAIL 而位置测试 PASS）+ **自查修掉测试自身的恒真弱点**（初版「叶面高度」测试把 `SEA_Y+1` 硬编码来算派生量，而那正是 `apply.js` 写入的格位 → 回退格位后该测试**仍 PASS**；改为从实际生成数据扫出真实格位再算，重做负向验证后转 FAIL）+ **Tier 4 像素实测**（贴图主色 rgb(34,139,34) 为基准，验证不被 `ocean.js` 无限海面 y=-1.5/renderOrder=1 盖住：中心睡莲绿 HEAD 30 → 改动侧 266，**8.9 倍**） |
| v1.31 | AO 去掉对角门控（凹角阴影连成环） | ✅ `2462e7f` | 用户报观感缺陷：方块两面（如东+南）都是墙角时，两条阴影各沿凹角向外**垂直延伸**，而**东南对角地面格完全不参与** → 阴影在对角处断开、露出「阴影的边」。用户明确要求消除。**根因实测定位（未猜）**：`mesher.js` `getAO` 的对角门控 `const c = (side1 \|\| side2) ? (corner ? 1 : 0) : 0`（mc-lite `AOUtils.getAOValue` 逐行一致、Minecraft 原版语义 —— 对角方块物理上不太遮挡该顶点，故两侧都开阔时对角遮挡不计入）。隔离场景实测（y=0 整片地面 + `(8,1,8)` 单个墙角块 B）：东格 `(9,0,8)`/南格 `(8,0,9)` 靠 B 两角 AO=**2**（有阴影），东南对角格 `(9,0,9)` 同位置 AO=**3**（全亮）；且**同一空间顶点 `(9,1,9)` 在不同 quad 里 AO 不一致**（块 `(9,0,8)` 顶面算 2、块 `(9,0,9)` 顶面算 3）—— AO 逐顶点写入、共享顶点各块各算一份，这是断层的直接机制证据。**修复**：去门控 → `3 - (side1 + side2 + (corner ? 1 : 0))`，对角格该顶点 AO 3→**2**，同一空间顶点跨 quad 统一为 2、阴影连成环。**已知有意偏离 mc-lite（第 ⑤ 项）**：副作用是**全局**的不只墙角 —— 所有「两侧开阔、仅对角遮挡」顶点都暗一档（悬浮方块斜对角、台阶斜接处），原版 MC 故意让这些不变暗；实测副作用范围有限（多数对角遮挡都伴随至少一侧遮挡）。**Tier 1 TDD**（AO 属 testing-policy §2.1「纯函数算法」，改坏了是静默视觉错误）：RED → 验证 RED（`Expected 2, got 3`，用例数 277→278 确认已注册在跑）→ GREEN **278/278**。断言刻意避开两个恒真陷阱（§2.5）：① 期望值 2 由「3 − (0+0+对角遮挡1)」**手算**得出，非硬编码被测代码写入的值；② 按「位置 + 顶面 face 位」定位顶点而非依赖顶点序，并断言**跨 quad 一致**。**测试自身的踩坑**：首版误用世界坐标定位顶点，而 `positions` 是 **section 局部坐标**（mesher 推 `lx/ly/lz`）→ 前置断言 `count>=3` 拿到 0，得到的是「定位失败」而非「AO 失败」= 不是有效 RED；改为显式推导 `lyTop = y0 - WORLD_MIN_Y + 1` 后才拿到真实 RED。**Tier 4 像素实测**（新增 `tests/ao-corner-visual.spec.mjs` + fixture `src/tests/test-ao-corner.html`）：取样点由 fixture **投影世界坐标**暴露（`window.__AO_PROJ__`），spec 不硬编码像素位置。**取样必须紧邻角顶点** —— AO 逐顶点插值，顶面**中心**是四角平均（≈2.75），信号被稀释（首版取顶面中心 → `ratio=0.994` 恒真、无区分度）。断言用「**同相对位置的开阔对照**」（`(5,5)` 角同样位置但四周无遮挡 → 恒 AO=3）排除「靠近格角本身就暗」的混淆变量：HEAD（门控）`nearCorner` 69.23 / control 64.87 = **1.067**（无阴影、比对照更亮），改动侧 55.22 / 64.87 = **0.851**（有阴影）→ 约 **19%** 差异、双向有效。**被否决的一条断言（记录以免重犯）**：曾试图断言「穿过 `z=9` 块边界的扫描线亮度连续」，实测 `maxJump=0.1399` FAIL —— 但这**不是 bug**：块 `(9,0,8)` 沿 `x=9` 边有**两个**暗角（`(9,1,8)` 被 side 遮挡 + `(9,1,9)` 对角），块 `(9,0,9)` 只有**一个**对角暗角 → 跨界亮度回升是**正确行为**、不是断层伪影；改为断言「阴影梯度延伸进对角格内部」（`farCorner` AO=3 vs `nearCorner` AO=2，比值 1.098）。**门禁**：`npm run check` 全绿（0 error / 9 个既有 camelcase warning；图标指纹检查通过 → **无需重跑 `npm run icons`**，图标烘焙不吃 AO）。`npm test` **46 passed / 1 failed**（新增 ao-corner-visual spec 后用例数 45→46），失败的仍是 `m1-acceptance` 的 `frameMs.p95`（`16.700000762939453` vs 门限 16.7，超出 **7.6e-7** = float32 表示 16.7 的下一个可表示值）。**交替对照**：HEAD 侧连跑 3 次**同样失败、数值完全一致** → 与本次改动无关（v1.30 已记录同一现象：HEAD 侧失败率 100%）。改动侧 bench **`--check` 通过**（fps=120、draw call 489~545 与基线一致）—— mesher 属热路径故按门禁分层加跑 |

**对 M4~M7 的影响**：

- **v1.25 分级策略适用于后续所有 Epic**：M4~M7 的 plan 文档按「全部任务 RED-GREEN」写成，
  生效后 Tier 1 部分不变（`WorldEditor` 批量语义、DDA hitscan、`EntityManager` 版本协议、
  实体 AABB raycast、持久实体可取消保存、`ZombieService` 20Hz AI 批次语义），Tier 3 部分放宽
  （`WEAPON_ASSET_URLS` 路径常量、HUD 武器名文案）。判据不变：**问「改坏了能不能玩出来」**。
- **v1.25 已把 M5 的静态门要求纳入 `check:arch` 白名单式检查**：`src/entities/**` 不得
  import three / 不得新增 Worker（M5 plan Task 1 原写 `rg -n "from 'three'|new Worker" src/entities`）。
- **v1.26 的维护约束**：改**背包内方块**的贴图地址或 mesher 几何后须重跑 `npm run icons`，
  否则图标静默过期（忘跑会被 `check:data` 抓到）。M4 新增武器图标若走同一烘焙路径，须遵守此约束。
- **M4 plan Task 6 的前置条件不变**：`uiModal` keydown 守卫（M3.1 交付）仍是 M4 挂 KeyR 切武器的
  前置；v1.26 只改了图标的取图方式，未碰模态门控。

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
M3.1 (背包) ← 依赖 M3-4（快捷栏/设置面板 DOM 基础）；与 M4 数据层解耦，排序仅因共用 keydown 入口
M3.2 (方块朝向放置交互) ← 依赖 M2 的渲染消费侧（584813b）+ M3.1 的 placeBlock 改造；
                          渲染/持久化通路 M2 已通，本项只补放置算朝向 + 挖块记朝向两步
M4 (第二阶段玩家武器) ← 依赖 M3-6 冻结验收 + M3.1（uiModal keydown 守卫是 Task 6 前置条件）
                       + M3.2（Task 6 重写 digBlock/placeBlock 时须保留朝向分支；
                         Task 2 的 getBlockMeta 已由 M3.2 交付）
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
9. M3.1（背包，M3 收尾补丁项；M4 开工前完成，共用 keydown 入口一次改到位）
10. M3.2（方块朝向放置交互，M3 收尾补丁项；M4 开工前完成，Task 6 重写 placeBlock 前须就位）
11. M4 → M5 → M6 → M7（第二阶段实体/敌人链；每一项以前项验收为门）

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
