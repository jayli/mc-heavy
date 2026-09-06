# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

本文件为 mc-heavy 仓库（`~/jaylli/mc-heavy`）的协作规范。所有解释、说明、对话请使用中文，代码注释尽量使用中文。

## 项目定位

mc-heavy 是一个**从零重写**的 Minecraft 风格体素游戏引擎。功能对标姊妹仓库
[mc-lite](/Users/bachi/jaylli/mc-lite)（995 次提交、约 5.5 万行 JS、124 种方块），但架构完全不同：

- mc-lite 是「功能驱动 + 补丁叠加」长出来的，性能天花板已锁死（视距 2~3 chunk、预生成数十秒、
  扩图卡顿、奔跑掉帧）；
- mc-heavy 的目标是**保持同样的玩法功能**，用更鲁棒、更可扩展、更高性能的引擎底座重做一遍；
  第一阶段做引擎底座（M0~M3）。M3 性能报告验收后，第二阶段先按 M4 玩家武器 → M5 实体运行时
  → M6 丧尸 → M7 玩家放置丧尸巢穴的独立 Epic 链推进；矿车、炮塔、TNT、创造台等继续按后续阶段加入。

**mc-lite 的地位是「功能与数据来源」，不是「实现蓝本」。** 读它的代码时只提取
「功能语义、算法、数据、视觉风格」，禁止照搬它的架构组织方式（详见下文「对标 mc-lite」）。

## 当前进度

**项目进度的唯一总览是 [`docs/roadmap.md`](docs/roadmap.md)**（里程碑总表 M0~M7 + 第二阶段
依赖链 + 后续扩展点）。本文件不复制进度表 —— 同一事实的多个副本会漂移。

一句话现状：第一阶段 **M0~M3 全部完成**并验收达标，两个收尾补丁项（M3.1 背包 / M3.2 方块朝向
放置交互）也已落地；此后是一串独立 bugfix 与改造（v1.19~v1.35）；第二阶段 **M4 玩家武器已完成
并验收**（含遗留 TODO「设置面板破坏方块开关」），**M5~M7 尚未开始**（规格与计划已备好，见
「权威文档」）。

**历次 bugfix / 改造的完整记录不在本文件。** 权威副本有两份：设计文档的修订说明
（v1.19~v1.35，每条含根因、实测数据、门禁对照）+
[`docs/superpowers/plans/2026-08-20-phase1-remaining-roadmap.md`](docs/superpowers/plans/2026-08-20-phase1-remaining-roadmap.md)
（v1.19~v1.21 独立章节、v1.22~v1.31 表格）。**v1.32 起的条目只在设计文档修订说明 +
[`docs/roadmap.md`](docs/roadmap.md) 表格里**（M4 交付后修正占用 v1.33/v1.34，编号体系见
roadmap「M4 之后的遗留 TODO」段）。本文件只保留**会影响后续实现决策的活跃约束**
（下节）—— 它们散落在历次改动中，读单个文件看不出来。

测试现状：Playwright spec 全量 + 浏览器内单元测试全绿。**用例计数以 `npm run check:data`
输出为准，不在文档硬编码**（同一事实的多个副本属「改动放大器」，违反红线 1 精神）。
`m1-acceptance` 计时断言在高负载下偶发贴线 flaky（16.7±1e-6 / 2.1ms），单独复跑通过。

### 活跃约束（历次改动沉淀，会影响后续实现决策）

这些不是历史记录，是**仍在生效的口径**。违反会引入回归或与设计文档冲突。

- **实例原点换算基准（极易误判几何差异）**：mc-lite 几何以**块中心**为原点，四条放置路径全部
  `position.set(x+0.5, y+0.5, z+0.5)`（`ChunkConsolidation.js:529` / `Chunk.js:2474` /
  `WorldWorker.js:181,416,457`）；mc-heavy 模板坐标以**块底角**为原点（0→1）。
  **比对 mc-lite 几何数字时必须 +0.5 换算。**
- **对齐上游须实测其运行时行为，不能读定义推断**：mc-lite 床材质的 `offset:[0,0.5]` /
  `rotation:-π/2` 全仓**零消费点**（死字段），照字段名实现会渲错。与「诊断 bug 不猜」同一原则。
- **五处已知的有意偏离 mc-lite**（视觉比对时勿按其原样判定，均在 §4.3/§4.5.4 标注）：
  ① `vine` 落格内 y∈[0,1]（mc-lite 溢出半格 y∈[0.5,1.5]）；② 吊灯 UV 按部件分区 + 绳呈单色
  深灰（mc-lite 两几何 UV 全幅、绳吃 emissive 呈亮色）；③ 背包图标用离线烘焙等轴测投影
  （mc-lite 是手工绘制贴图，其图标与游戏内方块颜色不一致）；④ `lilypad` 模板 y=-0.48 +
  生成格位 `SEA_Y+1`（mc-lite 是装饰实体、原点为块中心 → 叶面 -1.98 沉水 0.98）；
  ⑤ `getAO` 去掉对角门控（mc-lite/MC 原版 `(side1||side2)?corner:0`，两侧都开阔时对角逐格不计入
  → 凹角东南对角格无阴影、露出「阴影的边」；去门控后对角格 AO=2，阴影连成环）。副作用是**全局**的：
  所有「仅对角遮挡」顶点暗一档（悬浮方块斜对角、台阶斜接处），原版 MC 故意让这些不变暗。
- **lilypad 的几何与格位是耦合的，改一处必须同时改另一处**（§4.3 标注）：只改模板 y →
  叶面悬空半格；只改生成格位 → 叶面贴块底仍沉水。水面下沉 0.5 后暴露水面顶面只有**半格高**，
  与陆地整格顶面差半格 —— 同一份几何无法同时贴合，故 `big_house.json` 的 3 个草地 lilypad 已移除
  （「`assets/structures/*.json` 原样复用」的唯一有意例外）。
- **背包物品集合口径 118 项** = registry 126 − `NON_PLACEABLE_ITEMS`（4 项功能性方块）−
  `HIDDEN_FROM_INVENTORY`（4 项可放置但不进背包）。**两个集合语义互斥，勿混为一处**
  —— 把可放置方块塞进 `NON_PLACEABLE_ITEMS` 会让集合语义失真。
- **床渲染镂空问题未修**（床侧面一个面无贴面 → 透视穿帮）。当前靠「不入背包 → 玩家选不到 →
  实际不会被放置」**规避而非修复**；TODO 标注在 `src/mesh/mesher.js`，归属床/宝箱/门多方块 Epic。
- **背包图标是离线烘焙产物**（`assets/icons-atlas.png`）。改**背包内方块**的贴图地址或 mesher
  几何后须重跑 `npm run icons`，否则图标静默过期（渲染旧形状/旧配色，肉眼看不出）；忘跑会被
  `npm run check:data` 的指纹检查抓到。改**非背包方块**的贴图无需重跑。
- **形状与 UV 的唯一权威 = `src/mesh/mesher.js`**（`TEMPLATES` / `FACE_VERTICES` / `FACE_UVS`）。
  图标烘焙与等轴测投影只 import，**禁止手写第二份几何定义**（红线 1）。按方块单独 hack 图标
  做不到 —— 那会在 `TEMPLATES` 之外开第二份形状权威。
- **方块放置朝向不看玩家 yaw**：三分支为门控关闭→恒 0 / 原位重建同类型→`+1 % 4` / 有类型记忆→沿用 /
  无记忆→0。真实手感是「转身不改朝向，要转 90° 就在原位挖掉再放回去」。
  **M4 Task 6 改走 `editor.setBlock(...)` 时须保留朝向分支**（不得退化为只传 id）。
- **等轴测图标的深度度量 = `x+y+z`**（由投影轴叉乘得法线 `(-1,-1,-1)` 推出），且遮挡判定必须
  **逐像素深度测试** —— 面平均深度只能用于排序，对被整片遮住的面无能为力。
- **丢弃玩家改动的唯一入口 = `Game._discardEdits()`**（取消在途 flush + 清各 column **内存**
  edits + 清 IndexedDB store 与 `editsCache`）。消费者 `newWorld`（换 seed）/ `clearSave`
  （保留 seed 与设置，设置面板「删除缓存」）。**禁止只清 IndexedDB 不清内存** —— 内存 edits
  是写盘源，残留会在任何来得及提交的时机把旧改动写回刚清空的 store。
- **时序不定的竞态只能用内存侧断言钉住，端到端断言会让缺陷静默逃逸**。实测：`beforeunload →
  flushNow` 的 IndexedDB 事务能否提交取决于卸载快慢（多一次 evaluate 往返则提交；紧跟
  `location.reload()` 则被中止），故重载后的 `savedColumns` **碰巧**可能读到正确值
  （负向验证实测：注释掉清内存那步，E2E 仍全绿）。写竞态防护的测试时，断言要落在
  **同步可观测的内存状态**上，不要只断言重载后的落库结果。
- **面板 UI 档位与钳制范围是两套口径，勿混为一处**：`VIEW_DISTANCE_OPTIONS`（面板按钮档位，
  当前 `[8,12,16]`）只是**快捷选择子集**，`clampVD` 的钳制范围 **2~16** 才是架构口径
  （M1 测试/调试依赖 `vd=2`、既有 spec 用 `vd=4`）。故面板必须容错「当前值不在档位内」
  （URL/旧存档带来 `vd=4` → 无按钮高亮）；**刻意不做「就近高亮」** —— 那会让按钮宣称一个
  非生效值。契约断言在 `src/tests/test-ui.js`（档位须落在钳制范围内 + 默认值在档位中）。
- **设置面板新配置往右列填**：面板是两列盒（`.mc-columns` + `.mc-combined` 合并盒，mc-lite 同款
  手法但分配按本仓库档位重排）。左列 = 画质+枪械破坏合并盒 / 环境风格；右列 = 视距 / 帧预算 /
  世界操作。M5~M7 的新配置项优先往右列填（纵向余量更大），两组两按钮档位优先用合并盒共用一行。
  **音量档当前不在面板**（默认 100%），但字段仍持久化 + `?volume=` URL 可达 —— 音频接线时
  加回档位即可，不必改数据模型。
- **破坏性按钮的常态文案只有一份**（`settings-panel.js` 的 `CLEAR_SAVE_LABEL`）：构造与
  `_resetDangerArmed()` 复位共用同一常量。实测踩坑：复位函数写死旧长文案会覆盖构造时的短文案
  → 面板打开后显示复位那份，构造代码形同虚设（肉眼看不出哪个是「真相」）。
- **面板列分隔线规则只作用于 `.mc-item`，不得通配所有子项**：写 `.mc-column > :first-child`
  会连带抹掉 `.mc-combined` 合并盒自己的装饰边框（特异性 1,2,0 压过 1,1,0 → 上边框 `none`，
  方框缺一边；用户实玩报告，观感上只是「少一条线」，肉眼看不出是特异性冲突）。往面板加新
  容器类型时须同步考虑这条选择器。**CSS 特异性 bug 须 `getComputedStyle` 读四边定位**
  （只有某一边缺 = 特异性覆盖的特征），不要凭观感猜。
- **`settings-panel.js` 的 `PANEL_CSS` 是 JS 模板字面量 —— 注释里禁用反引号包裹标识符**
  （会提前终止模板字符串 → 整个模块解析失败 → **游戏页白屏加载不出来**，不是面板样式错，
  是整个页面挂；实测一度误判为「服务端口有问题」）。改完 `src/**/*.js` 先跑 `npm run lint`
  （能抓解析错误）再做实测。
- **文档同步**：新增产物或删除文件时，必须同步「目录结构清单」「开发命令清单」「现状声明」
  三类文档，历史记录段不动。文档里同一事实的多个副本会漂移（已发生三次版本号漂移）。
- **计时类断言 flaky 时须分开按 spec 连跑拿数值分布比均值与峰值**，仅凭「全量跑失败/单独跑通过」
  判定不够（实测有 HEAD 侧失败率反而更高的情况，只看全量跑会得出相反结论）。
  **并发跑测试会导致计时断言系统性失败**（争抢 CPU 与端口 8081）。
  更可靠的做法是**交替对照**（改动侧 N 次 → HEAD 侧 N 次 → 反复），消除机器负载累积带来的
  顺序效应 —— 单侧连跑会让后跑的一侧承担更高负载。
- **测试指纹口径须匹配改动范围**：`i += 997` 步长采样只适合「换 seed」类整片变化；
  **单格改动必须全量求和**（实测踩坑：基线与改动侧同为 50533，断言恒真）。
- **重载类断言的导航监听必须在触发动作之前武装**：`waitForLoadState('load')` 写在 click 之后
  会看到「当前页已是 load 态」立即返回，随后 `READY` 在**旧页**本就为真 → 读到动作前的世界。
  正确写法是 `const nav = page.waitForNavigation(...)` 先建 promise，再 click，再 `await nav`。
- **给「生成类」代码写测试有两个恒真陷阱**（实测踩坑 lilypad，两处都会让缺陷静默逃逸）：
  ① **落点只按数据条件筛** —— 「biome=SWAMP + h<SEA_Y + rand<0.08」筛出 **12 个候选点**，
  完整 GEN 后**落地 0 个**（`pointContext` 的 city/island/pyramid/plainLand/snow/fm 六个地标
  判定都在 water 分支**之前**，这些点全被 clay/sand 地标方块吞掉）→ 断言根本不触发的分支；
  ② **测试里硬编码「被测代码写入的那个值」** —— 用 `SEA_Y+1` 算叶面高度，而 `SEA_Y+1` 正是
  `apply.js` 写入的格位 → 回退格位后该测试**仍 PASS**（拿硬编码值算出关系式成立）。
  正确做法：落点先用廉价脚本复现优先级链扫出、再跑完整 GEN 验证方块真落地；派生量从**实际
  生成数据里读出**真实格位再算，并补前置断言钉住前提。详见
  [`docs/testing-policy.md`](docs/testing-policy.md) §2.5。

## 权威文档（动手前必读）

按顺序读完再写代码：

1. [`docs/roadmap.md`](docs/roadmap.md) —— **项目进度唯一总览**（里程碑总表 M0~M7 + 第二阶段
   依赖链 + 后续扩展点接入点 + 去哪找细节）。想知道「做到哪了、下一步做什么」先看它。
2. [`docs/phase-1-engine-design.md`](docs/phase-1-engine-design.md) —— **架构唯一权威**，
   当前 v1.35。所有子系统边界、DR 决策、验收口径都在这里；历次口径变更见其修订说明。
3. [`docs/testing-policy.md`](docs/testing-policy.md) —— **测试分级的唯一权威**（Tier 1~4 判据 +
   门禁分层 + 红线静态门规则 + 与 M4~M7 的关系）。动手前先按它的判据确定本次改动属哪一级。
4. [`docs/superpowers/plans/2026-08-20-phase1-remaining-roadmap.md`](docs/superpowers/plans/2026-08-20-phase1-remaining-roadmap.md)
   —— **任务级执行清单 + v1.19~v1.31 历次改造记录**（含各次 bugfix 的根因与实测数据）。
5. `docs/superpowers/plans/2026-08-19-m1-voxel-core-loop.md` —— M1 实施计划（已完成，架构细节参照）。
6. `docs/m0-bench-report.md` / `docs/m1-acceptance-report.md` / `docs/m2-m3-performance-report.md`
   （M3-6 第一阶段性能报告 = 冻结基线）—— 实测与验收报告。
7. M4~M7 开始前分别加读 `docs/superpowers/specs/2026-08-23-m{4,5,6,7}-*.md` 与
   `docs/superpowers/plans/2026-08-23-m{4,5,6,7}-*.md`（规格与计划已成对备好）。

规则：

- 设计与实现冲突时，**以设计文档为准**，不要用「实现方便」推翻已核验的设计决策；
- **Tier 1 改动**必须按计划的任务与步骤走（Red-Green-Refactor），禁止跳步或省略失败验证；
  **Tier 2/3 改动**免 TDD 流程，改完跑 `npm run check` 即可 —— 不要为了改一个贴图地址而先写失败测试；
- 计划中标注「冻结」的断言数字（draw call 数、fps 阈值、p95 上限等）实测不符时
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
   BatchedMesh 缓冲耗尽走三级兜底：`unusedVertexCount` 检查 → `optimize()` 回收空洞 →
   `setGeometrySize()` 整批扩容（`render-world.js _ensureCapacity`）。
6. **体素 DDA 射线**：玩家对地形求交互用 Amanatides-Woo 遍历，禁止对地形 mesh 做
   `THREE.Raycaster.intersectObjects`。
7. **Worker 池 + 版本协议**：异步任务携带 `(columnKey, columnVersion)`，回传版本不符即丢弃。
   禁止为竞态打 epoch/防抖/staging 之类的补丁（这是 mc-lite 的病根）。
8. **主线程/Worker 同构纯函数**：gen/mesh 核心算法无 DOM、无 three 依赖，主线程快速路径与
   Worker 精修路径共用同一份代码、输出同构缓冲。
9. **WebGPU 唯一后端**：three **r185.1**，本地 `vendor/three/` 经 import map 引入；不做 WebGL2 降级；
   启动 `navigator.gpu` gate 不通过即明确提示中止。
10. **module worker 约束**：worker 不继承页面 import map，`src/workers/` 下任何文件
    **不得 import three**，一律相对路径 import 本项目模块。
11. **光照模型（M1 定稿）**：skylight = 垂直落下不衰减 + 水平扩散 BFS 每格 -1（Minecraft 模型）。
    编辑快路径同步重算垂直单列且**只升不降**（挖块立即提亮；放块不压暗，暗化交异步扩散收敛，
    防黑闪）；区域扩散走 Worker `light` 任务异步收敛（`scheduler.enqueueLight`，编辑/悬挑触发）。
    AO/light 的 shade 必须在**顶点阶段**算成 float 经 float varying 传片元（three.webgpu.js:65404
    对 int varying 强制 flat 插值，片元读 uint 属性无渐变）。
12. **玩家物理手感**：水平碰撞 + onGround 时自动上台阶（`_tryStepUp`，MAX_STEP=1.0，mc-lite 手感）；
    上台阶相机走 StepLift ease-out 缓动（物理瞬时、视觉平滑）。

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
- `src/world/structures/*.json` → `assets/structures/`（原样复用；**唯一例外**是 `big_house.json`
  删了 3 个草地 lilypad，理由见设计文档 §4.3 lilypad 段）；
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
- three.js **r185.1**，本地 `vendor/three/`（three.webgpu.js / three.tsl.js / three.core.js），
  import map 指向本地文件；
- 端口 **8081**（mc-lite 占 8080，避免并行开发冲突）；
- 纹理 atlas：2048×2048、gutter 16/bleed 8、半 texel UV 内缩；7 张 250~362px 大图按 128×128 入图；
- ESLint 9 flat config（以 mc-lite 配置为底，本仓库五处修改见计划 Task 1 Step 3）；
- Conventional Commits（`feat:`/`test:`/`chore:`/`perf:`）；
- 每个任务结束必须 commit；**未获明确指令不得自动提交**。

## 目录结构

```
mc-heavy/
├─ index.html                  # import map（本地 vendor/three）+ WebGPU 启动 gate + 准心
├─ vendor/three/               # three.js r185.1（three.webgpu.js / three.tsl.js / three.core.js）
├─ docs/
│  ├─ roadmap.md              # 项目进度唯一总览（里程碑总表 + 依赖链 + 扩展点）
│  ├─ phase-1-engine-design.md # 架构唯一权威（v1.35）
│  └─ testing-policy.md        # 测试分级唯一权威（Tier 1~4 判据 + 门禁分层）
├─ tools/build-atlas.mjs       # atlas 离线打包（npm run atlas）
├─ tools/bake-procedural-textures.mjs # 程序化贴图烘焙（mc-lite canvas 材质 → PNG）
├─ tools/bake-icon-atlas.mjs   # 全量背包图标离线烘焙（npm run icons）：118 项×两套尺寸
│                              #   → assets/icons-atlas.png + icons.json（预生成 CSS 串+指纹）
├─ tools/icon-fingerprint.mjs  # 图标输入指纹共享模块：烘焙脚本与 check:data 同一份逻辑（红线 1）
├─ tools/check-architecture.mjs # 静态架构门（npm run check:arch）：红线可静态检查的部分
├─ tools/check-data.mjs        # 数据契约门（npm run check:data）：关系型断言取代硬编码计数
│                              #   （含图标过期指纹检查）
├─ assets/
│  ├─ textures/                # 从 mc-lite 复制
│  │  └─ procedural/           # 程序化贴图烘焙产物
│  ├─ atlas.png + atlas.json   # 世界渲染 atlas 生成产物，提交入库
│  ├─ icons-atlas.png          # 背包图标 atlas（独立于世界 atlas，1024²）
│  ├─ icons.json               # 图标 manifest：预生成 CSS 串 + 输入指纹
│  └─ structures/              # 从 mc-lite 复制 JSON
└─ src/
   ├─ core/        # game.js / scheduler.js / worker-pool.js / budget.js / perf.js / perf-hud.js
   ├─ voxel/       # constants / block-registry / chunk-column / world-data / blocks-data / faces-data
   ├─ gen/         # noise.js / terrain.js / structure-index.js / structures/*（M2 地标与空中结构）
   ├─ mesh/        # mesher.js / lighting.js / atlas-loader.js（Worker 同构）
   │               #  iso-icon.js 等轴测投影纯函数；mesher.js 导出 TEMPLATES / FACE_VERTICES /
   │               #  FACE_UVS 供图标烘焙复用——形状与 UV 的唯一权威，图标不得有第二份几何定义
   ├─ render/      # render-world.js（BatchedMesh 发布层）/ materials.js（TSL）
   │               #  weather.js（天气状态机）/ rain.js（雨效）
   ├─ player/      # player.js / physics.js / raycast.js / step-lift.js
   │               #  inventory.js（物品模型）/ orientation.js（朝向三分支纯函数）
   ├─ ui/          # coords-hud.js / hotbar.js / settings-panel.js / settings.js
   │               #  inventory.js（背包面板：DOM 方案照搬 mc-lite）/ icons.js（图标 manifest 加载）
   ├─ save/        # persistence.js（IndexedDB edits）
   └─ workers/     # world-worker.js（GEN/MESH/LIGHT 统一入口，池化）
```

依赖方向单向：`voxel ← gen ← mesh ← render`，反向依赖禁止（`npm run check:arch` 静态门守）。
`core/` 是**装配层**（`game.js` 组装全部子系统、`scheduler.js` 编排任务），依赖任何层合法。
`voxel/`/`gen/`/`mesh/`/`workers/` 是 Worker 同构层，不得 import three；例外
`mesh/atlas-loader.js`（主线程专用，运行时加载 atlas 纹理必然依赖 three）见
`tools/check-architecture.mjs` 白名单。另有 `src/tests/`（浏览器内单测 + fixture）、
`src/bench/`（基准页）、`tests/`（Playwright spec）、`server-script/`（静态服务）。

## 开发命令

```bash
npm install                    # playwright 固定 ^1.62.1（复用本机 chromium-1234 缓存）
npm start                      # 静态服务 http://localhost:8081
npm run check                  # 日常最小门（2.6s 实测）= check:arch + check:data + lint
npm run check:arch             # 静态架构门（Tier 1，285ms）：12 条重构红线可静态检查的部分
                               #   three 隔离/禁止类名/依赖方向/发布层三级兜底，违规退出码 1
npm run check:data             # 数据契约门（Tier 2，277ms）：关系型断言取代硬编码计数
                               #   引用完整性/物品集合关系式/图标同步/测试注册完整性
npm test                       # Playwright 全部验收（tests/*.spec.mjs）
npx playwright test tests/<name>.spec.mjs   # 跑单个 spec（计时断言 flaky 时须单独连跑）
npm run bench                  # M3-5 性能基线跑图（4 场景 → docs/m3-baseline.{md,json}）
                               #   加 -- --check 为回归门禁（回退 >10% 阻断，退出码 1）
npm run lint                   # eslint src tools tests
npm run icons                  # 烘焙全量背包图标 → assets/icons-atlas.png + icons.json
                               #   改背包内方块的贴图地址或 mesher 几何后需跑，否则图标静默过期
npm run atlas                  # 重新生成 assets/atlas.png + atlas.json（世界渲染 atlas）
                               #   注：新增 textures 子目录会重排已有 tile 坐标（shelf 装箱按字母序）
```

**门禁分层**（何时跑什么，详见 [`docs/testing-policy.md`](docs/testing-policy.md) §6）：
改贴图地址/alias/文案（Tier 3）跑 `npm run check`；改物品集合/图标表/atlas（Tier 2）同左；
改纯函数算法/协议/数据模型（Tier 1）加 `npm test`；改热路径（mesher/materials/render/
scheduler/physics）再加 `npm run bench -- --check`。**不要**为改一个贴图地址跑全量 E2E 或 bench，
**也不要**改了 mesher 几何却只跑 `check`。

调试与测试入口：

- 浏览器内单测：`http://localhost:8081/src/tests/index.html`，runner 暴露
  `window.__MC_TEST_RESULTS__`（结构 `{suites:[{tests:[...]}], passed, failed, total}`，
  用例在 `suites[].tests[]` 里，须 `flatMap` 展开）；
- 性能基准页：`http://localhost:8081/src/bench/webgpu-publish.html`（暴露 `window.__BENCH__`）；
- 游戏入口暴露 `window.__MC_GAME__`（world/player/scheduler/registry + perfSnapshot/renderStats），
  Playwright 交互测试经此编程驱动（无头环境无真实键鼠/pointer lock）。

## 测试工作流（分级 TDD）

**分级策略的唯一权威是 [`docs/testing-policy.md`](docs/testing-policy.md)**，本节只给最小口径。
判据不是「改动大小」也不是「文件位置」，而是**改坏了会怎样、多久能被发现**：

| 级别 | 改坏了 | 发现方式 | 测试要求 |
|---|---|---|---|
| **Tier 1** 机制/架构/性能/API | 静默数据错误、性能回退、红线回退 | 肉眼玩不出来，只能靠断言 | **必须 TDD** + 门禁 |
| **Tier 2** 数据契约/集合口径 | 约定值不一致（图标空槽、方块消失） | 立刻可见 | **门禁断言，免 TDD 流程** |
| **Tier 3** 文案/资源引用/观感 | 观感不对 | 立刻可见 | **免测试**，只需 lint |
| **Tier 4** GPU 渲染结果 | 渲染不对 | 单测测不到（TSL 在 GPU 求值） | **像素级实测**，不宣称目视 |

**Tier 1 的 TDD 流程不变**（RED → 验证 RED → GREEN → 验证 GREEN → REFACTOR）。
测试一开始就通过，说明测试写错了或在测已有行为。RED 阶段不得把新测试从
`src/tests/index.html` 临时移除来「通过」。

修改 `src/**/*.js` 后任务结束前跑 `npm run lint`，保持新增代码 0 error（warning 可接受）。

## 性能验收口径（第一阶段）

目标表见设计文档 §1（冷启动 <2s / 视距 8 chunk / 120Hz ≥90fps / 跨 region 无感知 /
放挖 <2ms / 存档 KB 级）。主线程帧预算按 8.3ms（120fps）标定：mesh 上传 ≤3ms、
快速路径 ≤2ms、光照 ≤1ms/帧。性能回退 >10% 即阻断合入；CI 帧率采样只做趋势参考，
**本机设备矩阵才是硬验收**。

- **帧时口径**：120Hz vsync 锁帧下帧间隔被量化为 8.33ms，`frameMs.p95 < 8.3` 数学上不可满足
  （测的是 vsync 抖动而非渲染负载）。故以 **fps 为主断言**，`frameMs.p95 < 16.7` 作防跌破
  60fps 二级门。该口径在全部性能 spec 一致采用。

## 实测环境事实（2026-08-19，勿凭印象改）

- Playwright **1.62.1** 对应 chromium-1234（本机缓存已存在），不要降级到 1.59.1；
- headless WebGPU 矩阵：Playwright 默认 headless shell 零 flag **拿不到 adapter**；
  必须 `channel: 'chromium'` 才能零 flag 走 Metal（本机真 GPU）；
  Linux CI 用 `--enable-unsafe-webgpu --use-angle=swiftshader --enable-dawn-features=allow_unsafe_apis`；
  `--enable-features=Vulkan` 在 macOS 无作用，勿加。
- exec_command 会话之间后台进程会被杀：dev server 必须「启动 + 使用 + 关闭」在**同一条命令**内
  （`node server-script/start-server.js & SERVER_PID=$!; ...; kill $SERVER_PID`）。
  若 8081 已有本项目 server 在跑，直接复用不重启。
- 沙箱禁止 `rm`；临时脚本放 `/tmp` 或项目内 `.tmp.mjs` 后用 `mv` 清理。
- Node v26.4.0；`/tmp` 下的脚本无法解析项目 node_modules，需在项目目录内运行。
- **截图的 `Read` 只返回 URL、不渲染成图像** → 不能宣称目视验证，须改用像素级 / DOM 几何实测。

## 后续功能扩展点

第二阶段 M4~M7 的规格与计划已成对备好（见「权威文档」清单末条的 `m{4,5,6,7}` 规格/计划）；
后续扩展点的引擎接入点（TNT/爆炸、炮塔弹丸、矿车轨道、创造台、灯/光源、床/宝箱/门、音频、
存档迁移、玩家生存战斗）见 [`docs/roadmap.md`](docs/roadmap.md) 的「后续扩展点」表格。
**新功能必须通过上述接入点实现，不得绕过 meshing/数据/事件管线另开路径。**

## 沟通与提交纪律

- 全部使用中文；解释设计取舍时引用设计文档章节号；
- 改动前说清楚「为什么」，改动后附验证证据（命令输出、帧时、draw call 数），不凭感觉宣称通过；
- 提交必须等用户明确指令，提交信息用 Conventional Commits。
- 诊断 bug 不猜：先在真实游戏/隔离环境复现、读实际数据（light 值/扫描线/队列状态）定位根因，
  再动手修。光照类 bug 尤其如此（垂直/扩散/快慢路径多，凭印象改会引入回归）。
- **写对照脚本做诊断时，对照侧与被测代码必须只差那一个要考察的变量** —— 两侧共用同一个错误假设
  会让对照恒等（得出「两者一致」的假结论），像素集合/统计口径不一致会得出机制上不可能的数值。
  出现机制上不可能的数值时先怀疑脚本本身。
