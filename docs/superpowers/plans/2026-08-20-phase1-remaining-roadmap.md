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

### M3.2 方块朝向放置交互 ⬜ 进行中（M3 收尾补丁项，设计文档 v1.17 定稿）

设计文档 §4.3「交互侧放置语义仍属第二阶段」与本文件第 211 行「朝向交互侧暂不实现」的收口：
该项此前**没有排进任何已编号里程碑**（M4~M7 spec/plan 经 grep 核实均不含方块朝向）。渲染消费侧
M2 已全部打通（`584813b`），`edits` 早已带 meta，缺的只有放置算朝向 + 挖块记朝向两步。
v1.17 把它从床/宝箱/门 Epic 拆出独立实施，该 Epic 范围收窄为「多方块结构 + `blockEntities` 富状态」。
任务详情见下方「## M3.2 方块朝向放置交互」章节。

| 项目 | 状态 | 备注 |
|---|---|---|
| M3.2 方块朝向放置交互（三分支放置朝向 + 挖块记忆 + `getBlockMeta`） | ⬜ | 照搬 mc-lite `PlayerInteraction.getPlacementOrientation` 三分支 + `OrientationUtils.nextOrientation`；门控复用 `orientationModesTable`（实测与 mc-lite `orientationEnabled` 集合 40 项零差异，不新增字段）；**朝向不看玩家 yaw**——手感是原位挖放转 90°；不做放置消耗/音效/床多方块；`getBlockMeta` 提前交付 M4 plan Task 2 |

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
3. [x] **M3.1 背包（2026-09-02 实施完成，未提交，等用户验证）**：交付创造模式无限背包的物品数据模型
   （`Slot`/`Inventory`，1000 槽位、每格 `count` 1500 占位不消耗）、Z 键背包面板（122 项物品、
   点击选中可越出快捷栏 5 格）、快捷栏改读 `slots[0..4]`、`Player.placeBlock()` 改读 `getSelected()`，
   并修正 `uiModal` keydown 门控漏洞 + 改模态栈（该守卫是 M4 Task 6 的前置条件）。
   回归：Playwright 38 用例 + 单测 216 全绿、lint 0 error、`bench --check` 通过。
   与 M4 数据层解耦（M4 排除背包消耗、武器切换走独立 `WeaponController`），排序依据是共用
   `keydown` 入口。规格见设计文档 §4.5.4；任务详情与门禁诊断记录见本文件「## M3.1 背包」章节。
4. [ ] **M3.2 方块朝向放置交互（M3 收尾补丁项，v1.17 定稿）**：交付 mc-lite 三分支放置朝向
   （门控 `orientationModesTable` → 原位重建 `+1 %4` → 类型记忆 → 默认 EAST）、挖块记朝向
   （`lastRemovedBlock`）、`world.getBlockMeta()`（提前交付 M4 plan Task 2）。**朝向不看玩家 yaw**
   ——mc-lite 的手感是「转身不改朝向，原位挖掉再放回去转 90°」，照搬。此前该功能没有排进任何
   已编号里程碑（M4~M7 spec/plan 经核实均不含方块朝向），从床/宝箱/门 Epic 拆出独立实施，
   该 Epic 范围收窄为「多方块结构 + `blockEntities` 富状态」。不做放置消耗/音效/床多方块。
   规格见设计文档 §4.3「朝向放置交互」；任务详情见本文件「## M3.2 方块朝向放置交互」章节。
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

#### 接下来（2026-09-02 更新：M3 已提交，M3.1 实施完成待验证，M3.2 文档已就绪待实施）

1. ~~**M3 全部六任务**~~ ✅ 已实施完成并提交（2026-09-02，M3-1→M3-6 顺序 TDD；用户验证后
   经 `/commit` 提交为 `82da106`，含设置面板 mc-lite 风格照搬与 ⚙ 按钮下移 10px 两处实机反馈修改）。
2. blur 档面板接线/持久化已随 M3-4 落地（重载生效口径）；剩余可选项（per-tile mip 链打磨、
   默认值翻转决策）见 M3-4 条目与性能报告遗留观察项。
3. ~~**M3.1 背包**~~ ✅ 已实施完成（2026-09-02，TDD 全程；**未提交，等用户验证**）：
   文档对齐（设计文档 v1.16：§4.5.4 完整规格 + §4.1 `registry.all()` + 消除与 v1.12 的冲突）→
   物品模型（`Slot`/`Inventory` + `registry.all()` + `Player` 接入 + `hotbarIndex` 收敛为别名）→
   背包 UI（`src/ui/inventory.js` + 快捷栏改读 slots + `uiModal` 模态栈 + keydown 守卫）→
   全量回归（38 用例 + 216 单测 + lint 0 error + `bench --check` 通过）。
   门禁诊断记录（每帧分配致 `fastRemeshP95` 回退的真缺陷 + `frameP95` 抖动离群值的 HEAD 对照）
   见「## M3.1 背包」章节末尾。
4. **M3.2 方块朝向放置交互（文档已就绪，代码实施待用户指令）**：设计文档 v1.17 已定稿
   （§4.3 新增「朝向放置交互」小节 + §4.1 补记 `getBlockMeta` + v1.17 修订说明），本文件
   「## M3.2」章节 + 里程碑总表 + 全局 TODO 第 4 项 + 依赖链 + 第 232 行收口全部就绪；
   M4 plan 已加两处标注（Task 2 的 `getBlockMeta` 改为验证已交付、Task 6 重写
   `digBlock()`/`placeBlock()` 时须保留朝向分支）；CLAUDE.md / README.md 同步完成。
   **待实施**（RED→GREEN 顺序见 M3.2 章节的测试 checklist）：`src/player/orientation.js`
   纯函数 + `world.getBlockMeta()` + `Player` 两个交互状态 + `digBlock()`/`placeBlock()` 接入。
5. **用户验证 M3.1（与 M3.2）后提交** → **M4 玩家武器**（第二阶段首个 Epic，加读规格与计划文档
   后开工；M3.1 交付的 `uiModal` keydown 守卫 + M3.2 交付的 `getBlockMeta` 均是 M4 的前置条件）。

### 测试现状

- 25 个 Playwright spec 文件（38 个测试用例；m1-acceptance 计时断言高负载下偶发贴线 flaky，单跑全绿）
- 216 个浏览器内单元测试（harness）
- 冻结断言：fps ≥90（120Hz 本机 ≥115）、编辑 p95 <2ms、draw 受控；atlas 147 tile（126 + 23 程序化烘焙）
- 性能基线门禁：`npm run bench` 采集 / `npm run bench -- --check` 回退 >10% 阻断（结构类 2%）

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

## M3.1 背包 ✅ 实施完成（2026-09-02，TDD 全程；未提交，等用户验证）

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

**实现要点：**
- [ ] 纯函数模块（`src/player/orientation.js`，无 DOM/three，Worker 同构）：
  `nextOrientation(o) = (o + 1) % 4`；`getPlacementOrientation(...)` 三分支——
  ① `orientationModes[id] === 0` → 恒 0（84 个方块不参与旋转）；
  ② `lastRemovedBlock` 且 **x/y/z/type 四者全等** → `nextOrientation(旧朝向)` 并写入类型记忆；
  ③ 类型记忆存在 → 沿用；④ 否则 → 0（EAST）
- [ ] `world.getBlockMeta(x, y, z)`（`src/voxel/world-data.js`）：O(1) 直查 `column.meta`，
  越界/缺列返回 0。**与 M4 plan Task 2 口径一致**（该方法 M4 亦计划新增，M3.2 提前交付）
- [ ] `Player` 两个交互状态：`lastRemovedBlock = {x,y,z,type,orientation}`（挖前读 meta 记下）、
  `placementOrientationMemory = Map<type, orientation>`（按类型记忆，跨位置、会话内持久）。
  二者是 UI 交互态，**不入世界数据、不持久化**（世界权威只有 meta 通道）
- [ ] `digBlock()`：挖前 `getBlockMeta()` 读旧朝向 → `recordRemovedBlock()`；基岩拦截不变
- [ ] `placeBlock()`：`getPlacementOrientation()` 算朝向 → 传入 `setBlock(..., meta)` →
  成功后 `clearRemovedBlock()`。与 M3.1 的 `inventory.getSelected()` 取物品逻辑正交叠加
- [ ] **明确不照搬**（各撞已定决策或属他 Epic）：① `inventory.remove(type,1)` 放置消耗
  ——M3.1 定稿创造模式无限背包不消耗；② `audioManager.playSound('put', 0.3)`
  ——第一阶段无音频消费方（M4 Task 4 才有 AudioManager）；③ `tryPlaceBed()` 床的多方块放置
  ——属床/宝箱/门 Epic，且 bed_head/bed_tail 在 mc-lite 本就 orientationEnabled=false
- [ ] **M4 plan 注意事项**（本任务落地时写入 M4 plan）：① Task 2 新增 `getBlockMeta` 的步骤
  改为「验证已由 M3.2 交付 + 补断言」；② Task 6 将 `digBlock()`/`placeBlock()` 改走
  `editor.setBlock(...)` 时**须保留 M3.2 的朝向分支**（`WorldEditor.setBlock` 已支持 meta 参数，
  M4 plan:332 `const meta = change.meta ?? 0`）

**测试：**
- [ ] 单测（`src/tests/test-orientation.js`）：`nextOrientation` 循环（0→1→2→3→0）、
  门控集合与 mc-lite 一致（40 项 true / 84 项 false）、三分支各路径、原位判定要求 x/y/z/type
  四者全等（改任一即不触发重转）、跨位置放置沿用类型记忆、`world.getBlockMeta` 越界/缺列返回 0、
  挖块记录含从 meta 读出的旧朝向、放置成功清空 `lastRemovedBlock`
- [ ] Playwright（`tests/m3-2-orientation.spec.mjs`）：放 `chest` 首次 meta=0；原位挖放四次
  meta 依次 1→2→3→0；跨位置放同类型沿用记忆；`stone`（orientationModes=0）恒 meta=0；
  带朝向方块存档后重启 meta 保留（edits 通路）；旋转后 section 重建无报错、draw 受控
- [ ] 回归：既有 Playwright 用例（M3.1 后为 38）+ 浏览器内单测（M3.1 后为 216）全绿、
  lint 0 error、`npm run bench -- --check` 无回退（朝向只加 O(1) 计算与一次 meta 读，
  不应触碰帧预算；若 `fastRemeshP95` 波动按 M3.1 的 HEAD 对照法诊断）

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
