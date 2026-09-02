# AGENTS.md

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

## 当前进度（2026-09-02）

第一阶段分 M0~M3 四个里程碑（设计文档 §7）：

- **M0 骨架 ✅**：脚手架 / Worker 池 RPC / BlockRegistry / atlas / WebGPU 发布路径实测（6 项冻结断言）。
- **M1 体素核心闭环 ✅**：地形生成 / section meshing 双路径 / BatchedMesh 通道级合批 /
  玩家物理（step-up + 相机缓动）/ DDA 射线 / 放块挖块 / 最小存档 / 光照（skylight 垂直+水平扩散、
  AO 顶点阶段 float varying、blocklight flood fill、异步收敛管线）。
- **M2 结构与世界完整性 ✅**：M2-1~M2-7 全部完成，同 seed 人工比对 2026-08-31 通过（无异常），
  关闭回归全绿（25 用例 + 144 浏览器单测；清单 `docs/m2-seed12345-comparison.md`）
  （StructureIndex 确定性布局 / 城市·金字塔·冰封山·雪地·海岛 5 地标 / 树木植被 / 洞穴 /
  水面特效 / 日夜循环三风格 / 空中结构）。bug 修复阶段已落地：
  - 光照黑面根因（`4c840cd`：写回改中心 column 权威 + 移除阳光遮挡投影 v1.9）；
  - mc-lite 视觉全面对齐（`d11a8b0`：±X 面 UV 90° 旋转修复、faces-data 124 方块六面全覆盖、
    21 张 mc-lite 程序化贴图离线烘焙入 atlas、12 种特殊几何顶点模板（台阶/栏杆/柱子/烟囱/
    床/吊灯/仙人掌）、树叶 FrontSide + alphaTest 0.3 口径、cross 植被双面绕线）；
  - 朝向渲染消费侧 + 台阶等 12 方块 blended 通道透视穿帮（`584813b`：mesher 读 meta 低 2 位
    按 4 朝向旋转顶点/UV，模型面查 tile、世界面做剔除/AO；view 打包 meta + Worker transfer；
    台阶/栏杆/宝箱等不透明材质方块 cullMode 改 cutout 恢复深度写入；交互侧放置语义仍属第二阶段）。
  - 城市覆写残留自然地形丘清除 + 树植根城市地表（`7d09cf1`：fillColumn 预填整列自然地形，
    generateCity 仅覆写至城市地表 → 自然高度 > 城市地表的列残留接地自然地形丘凸出地表包裹建筑；
    generateCity 清除 surfaceY+1..naturalH + 回退 pointContext 的 max 补丁使树植根城市地表；
    过渡带台阶不受影响）。
  - M2-7 空中结构已落地：悬浮空岛与云层走 StructureIndex 紧凑候选 + Worker GEN + column 裁剪的
    确定性重写（层序先云后岛、岛体覆盖云；`supportsPlayer` 通用表令云可站立非实心）；不含宝箱/天空树；
    方块 126 / atlas 147（+sky_stone/sky_grass）；详见 `docs/superpowers/{specs,plans}/2026-08-23-m2-sky-structures*`；
  - §4.4.1 blur 档提前落地（M2 收尾期）：`?blur=1` 开 mipmap+aniso 8 消远处莫尔纹，默认像素风；
    伴随云通道勘误（opaque + 同类剔除 + gutter 16/bleed 8 + 匀质 UV 收缩）；面板接线归 M3-4；
  - M2 已关闭：同 seed 人工比对通过 + 关闭回归全绿，M3-4 随机种子/新世界的启动前提已满足。
- **M3 性能达标与收尾 ✅（2026-09-02 完成并提交 `82da106`）**：M3-1~M3-6 全部落地：
  - M3-1 全量场景稳态 120fps / 队列归零 / 内存达标（体素 36~40MB、GPU 分配 136.6MB）；
    BatchedMesh CAPACITY 按实测峰值重标定（消除 cutout 运行时扩容卡顿）+ `game.memoryStats()`；
  - M3-2 帧预算双档（`src/core/budget.js`：120Hz=3ms/64、60Hz=6ms/128 冻结档；auto 判档用
    「快帧<11ms 比例」判据——中位数会被启动 burst 污染；`?budget=`/设置面板覆盖）；
  - M3-3 雨效（`render/weather.js` 晴 60~180s→雨 30~90s 随机周期状态机 + `render/rain.js`
    mc-lite RainEffect.js 算法照搬：LineSegments+TSL GPU 下落、267 滴、isSolid 截停、
    30Hz 分批迁移；`?weather=` 调试入口；雨天 fps 120）；
  - M3-4 HUD（`src/ui/`：坐标+biome、快捷栏 5 格 atlas 裁剪图标、设置面板：视距/blur/音量/
    视觉风格/预算档/新世界，localStorage 持久化 URL>存储>默认）+ **随机种子新世界**
    （main.js 固定 12345 改「有存档读存档、无存档随机」；`?seed=` 复现入口；`game.newWorld()`
    清 edits 防卸载回写竞态；视距/blur 切换走带参重载——BatchedMesh maxInstances 与纹理
    mip level 均构造期固定；性能/视觉冻结 spec 统一钉 `?seed=12345`）；
  - M3-5 基线脚本（`src/bench/baseline.mjs`，`npm run bench`：4 场景自动跑图出
    `docs/m3-baseline.{md,json}`；`--check` 门禁回退>10% 阻断（结构类 2%），负向验证退出码 1；
    跑图点位实证选定 z=-100 干燥走廊（城市东侧 x>566 是深海、x=520 有树冠挡路，勿凭印象改））；
  - M3-6 性能报告（`docs/m2-m3-performance-report.md`）：§1 目标表 6 项全达标（冷启动 0.5s /
    视距 8 默认 120fps + vd=12 冒烟 / 跨 region 无感知 / 编辑 p95 1.8ms / 存档 1.7KB）；
    mc-lite 对比：视距 ~4×、启动数十~百倍、存档 ~千倍。**第一阶段（M0~M3）验收口径全部达标**。
- **M3.1 背包 ✅（2026-09-02 实施完成，未提交，等用户验证）**：M3 收尾补丁项，插在 M3 与 M4 之间。
  设计文档 v1.16 定稿的口径收口——§4.5.4 原写「第一阶段实现创造模式无限背包」而 v1.12 写
  「背包归独立后续 Epic」，二者冲突；M3-4 只落地了快捷栏展示层（`src/ui/hotbar.js` +
  `HOTBAR_ITEMS` 常量数组），物品数据模型缺位（无 slots/selectedSlot、Z 键无响应、
  放块索引常量数组）。v1.16 把背包归 M3.1，v1.12 的推迟范围收窄为仅生存战斗与物品消耗规则
  （PlayerVitals / 掉落拾取 / count 递减）。落地：
  - `src/player/inventory.js`（`Slot`/`Inventory` 照搬 mc-lite `Slots.js` 语义：**1000 槽位**、
    创造模式填充每格 `count=1500` 占位不消耗、UI 不显示数量——**两个数字勿混**，
    原 §4.5.4 曾写「1500 格语义」已勘误）；
  - `BlockRegistry.all()`（§4.1 补记，按注册序返回 `{id,name}[]` 只读快照，冷路径专用禁入热路径）；
  - 物品集合 **122 项**（126 排除 `air`/`collider`/`calcite`/`realistic_trunk_collider`，
    mc-lite 同口径）；**顺序冻结**：前 5 项 = `stone/dirt/grass/sand/cobblestone`（快捷栏观感与
    既有断言不变），其余 117 按注册序——纯注册序会让快捷栏前 5 格变成 water/cloud 等非常用建材；
  - `src/ui/inventory.js`（Z toggle / Escape 关闭 / 数字键 1-5 / 点击选中可越出 5 格；DOM 照搬
    mc-lite `global.css`：600×400 灰底框 + 8 列网格 + 48×48 斜角浮雕槽位 + `.selected` 黄边；
    z-index 80 > 设置面板 70 保证后开的在上层）；
  - 快捷栏改读 `slots[0..4]`（视图，非独立容器）、`placeBlock()` 改读 `getSelected()`、
    `hotbarIndex` 收敛为 `inventory.selectedSlot` 的访问器别名（消除两份选中态）；
  - **`uiModal` 改模态栈**（`pushModal`/`popModal` + 只读 getter）：原可写布尔在两面板共存时
    互相踩（设置开着时关背包会误清门控）；`Player._bindInput()` 的 keydown 加模态守卫——
    **该守卫是 M4 Task 6 的前置条件**（M4 在同一段挂 KeyR 切武器）；关闭面板 lock 回
    `player.canvas`（mc-lite 锁 body，本仓库锁 body 会令视角与放挖全失效）。
  - 与 M4 数据层解耦（M4 spec 明确排除背包消耗、武器切换走独立 `WeaponController`），
    先做背包的唯一理由是共用 keydown 入口一次改到位。
- **M3.2 方块朝向放置交互 ⬜ 进行中（M3 收尾补丁项，插在 M3.1 与 M4 之间）**：
  设计文档 v1.17 定稿的口径收口——§4.3 原写「交互侧放置语义仍属第二阶段」、roadmap 原记
  「朝向交互侧暂不实现：第二阶段随床/宝箱/门落地」，即该功能此前**没有排进任何已编号里程碑**
  （M4~M7 spec/plan 经 grep 核实均不含方块朝向；M6 唯一命中是 `setTestAim` 注释里的**相机** aim）。
  渲染消费侧 M2 已全部打通（`584813b`：mesher 读 `meta&3` 按 4 朝向旋转、`getSectionView`
  打包 meta、Worker transfer），`chunk-column.set()` 的 `edits` 条目也早已带 meta；
  缺的只有「放置时算朝向并写入」与「挖块时记住朝向」两步。v1.17 把它从床/宝箱/门 Epic 拆出
  独立实施，该 Epic 范围相应收窄为「多方块结构 + `blockEntities` 富状态」。范围：
  - **门控字段复用（不新增字段）**：mc-lite 用 `orientationEnabled`（`BlockData.js` 默认 true），
    M0 转换后在 mc-heavy 名为 `orientationModes`。实测两侧集合**完全一致（40 项 true / 84 项 false，
    零差异）**，故直接用 `registry.orientationModesTable[id]`（>0 即启用朝向）。
    附带勘误：M3.1 讨论时曾疑该表混入 `air`/`water`/`cloud`/`leaves` 像转换产物——实测 mc-lite
    那边这 4 项同样 `orientationEnabled: true`，属上游语义。
  - **mc-lite 语义更正（勿照印象实现）**：放置朝向**不看玩家 yaw**——mc-lite 的
    `getPlacementOrientation(x, y, z, type)` 签名里没有朝向参数。三分支为
    ① 门控关闭 → 恒 0；② **原位重建同类型**（x/y/z/type 四者全等）→ `nextOrientation` = `+1 % 4`
    并写入类型记忆；③ 有类型记忆 → 沿用；④ 无记忆 → 0（EAST）。真实手感是「转身不改朝向，
    要转 90° 就在原位挖掉再放回去」。
  - `src/player/orientation.js`（纯函数，无 DOM/three，Worker 同构）+ `world.getBlockMeta(x,y,z)`
    （越界/缺列返回 0；**提前交付 M4 plan Task 2 计划新增的同名方法**，口径一致）+
    `Player` 两个交互状态 `lastRemovedBlock` / `placementOrientationMemory`（UI 交互态，
    不入世界数据、不持久化——世界权威只有 meta 通道）+ `digBlock()` 挖前记朝向 /
    `placeBlock()` 算朝向传 meta 并清空记录（与 M3.1 的 `inventory.getSelected()` 正交叠加）。
  - **明确不照搬 mc-lite 的部分**：① `inventory.remove(type,1)` 放置消耗（撞 M3.1 定稿的
    创造模式无限背包）；② `audioManager.playSound('put', 0.3)`（第一阶段无音频消费方，
    M4 Task 4 才有 AudioManager）；③ `tryPlaceBed()` 床的多方块放置（属床/宝箱/门 Epic，
    且 `bed_head`/`bed_tail` 在 mc-lite 本就 `orientationEnabled: false`，不走三分支）。
  - **对 M4 的影响（已写入 M4 plan 两处标注）**：Task 2 的 `getBlockMeta` 改为「验证已交付 +
    补断言」；Task 6 将 `digBlock()`/`placeBlock()` 改走 `editor.setBlock(...)` 时**须保留朝向分支**
    （`WorldEditor.setBlock` 已支持 meta 参数，不得退化为只传 id）。非依赖关系，只是同一段代码的先后改动。
- **M4 玩家第一人称武器 ⬜（第二阶段，M3.2 验证提交后即可开始）**：独立 Epic；`WorldEditor` 批量编辑、
  DDA hitscan、手枪/MAG7/加特林的受控 GLB 相机视图模型、曳光、音效和可选方块破坏。
  规格：`docs/superpowers/specs/2026-08-23-m4-player-weapons-design.md`；计划：
  `docs/superpowers/plans/2026-08-23-m4-player-weapons.md`。不含炮塔飞行弹丸、实体伤害、
  用户模型导入、弹药或网络同步。
- **M5 实体运行时 ⬜（第二阶段，等待 M4）**：独立的动态实体底座；`EntityManager`、实体 AABB
  raycast、受控渲染层、临时/持久实体分离与 `entities` snapshot。持久实体卸载先冻结/异步保存，可因重入
  或失败取消，成功后的下一帧才同步最终移除。规格：
  `docs/superpowers/specs/2026-08-23-m5-entity-runtime-design.md`；计划：
  `docs/superpowers/plans/2026-08-23-m5-entity-runtime.md`。不含具体敌人、炮塔或矿车。
- **M6 丧尸 ⬜（第二阶段，等待 M5）**：临时敌人垂直切片；默认 20 上限、20Hz 单条 WorkerPool
  `ai` RPC、实体/体素最近命中比较、25/35/999 三把枪伤害与六部件固定 slot 渲染；不含玩家生命、
  近战或死亡/重生。规格：
  `docs/superpowers/specs/2026-08-23-m6-zombies-design.md`；计划：
  `docs/superpowers/plans/2026-08-23-m6-zombies.md`。不含巢穴、掉落与昼夜刷怪。
- **M7 玩家放置丧尸巢穴 ⬜（第二阶段，等待 M6）**：最高 `gold_block` 的 `blockEntity` 是持久真相；
  保留玩家放置、全局最多 8 个、关键方块被破坏即失效的 mc-lite 语义，不进入 StructureIndex。
  规格：`docs/superpowers/specs/2026-08-23-m7-zombie-nests-design.md`；计划：
  `docs/superpowers/plans/2026-08-23-m7-zombie-nests.md`。

测试现状：25 个 Playwright spec 文件（38 个测试用例）+ 216 个浏览器内单元测试全绿
（**含尚未提交的 M3.1**：`tests/m3-1-inventory.spec.mjs` 6 用例 + 单测 46 项；已提交基线
`82da106` 为 24 spec / 32 用例 / 170 单测。M3.1 提交后本行去掉该注）（m1-acceptance 计时断言
在高负载下偶发贴线 flaky——16.7±1e-6/2.1ms，单独复跑通过，属已记录的计时抖动类）；
冻结断言达标（120Hz 本机 fps ≥115、放/挖编辑 p95 <2ms、draw 受控）；
性能基线门禁 `npm run bench -- --check`（M3-5，回退 >10% 阻断合入）。

## 权威文档（动手前必读）

按顺序读完再写代码：

1. [`docs/phase-1-engine-design.md`](/Users/bachi/jaylli/mc-heavy/docs/phase-1-engine-design.md)
   —— 架构唯一权威，当前版本 v1.17（已定稿）。所有子系统边界、DR 决策、验收口径都在这里。
2. [`docs/superpowers/plans/2026-08-20-phase1-remaining-roadmap.md`](/Users/bachi/jaylli/mc-heavy/docs/superpowers/plans/2026-08-20-phase1-remaining-roadmap.md)
   —— **第一阶段剩余执行计划与后续路线图（M2–M7）**，任务级 TODO + 依赖关系，当前 roadmap。
3. [`docs/superpowers/plans/2026-08-19-m1-voxel-core-loop.md`](/Users/bachi/jaylli/mc-heavy/docs/superpowers/plans/2026-08-19-m1-voxel-core-loop.md)
   —— M1 实施计划（已完成，架构细节参照）。
4. `docs/m0-bench-report.md` / `docs/m1-acceptance-report.md` /
   `docs/m2-m3-performance-report.md`（M3-6 第一阶段性能报告 = 冻结基线）—— 实测与验收报告。
5. M4 开始前加读：[`docs/superpowers/specs/2026-08-23-m4-player-weapons-design.md`](/Users/bachi/jaylli/mc-heavy/docs/superpowers/specs/2026-08-23-m4-player-weapons-design.md)
   与 [`docs/superpowers/plans/2026-08-23-m4-player-weapons.md`](/Users/bachi/jaylli/mc-heavy/docs/superpowers/plans/2026-08-23-m4-player-weapons.md)。
6. M5 开始前加读：[`docs/superpowers/specs/2026-08-23-m5-entity-runtime-design.md`](/Users/bachi/jaylli/mc-heavy/docs/superpowers/specs/2026-08-23-m5-entity-runtime-design.md)
   与 [`docs/superpowers/plans/2026-08-23-m5-entity-runtime.md`](/Users/bachi/jaylli/mc-heavy/docs/superpowers/plans/2026-08-23-m5-entity-runtime.md)。
7. M6 开始前加读：[`docs/superpowers/specs/2026-08-23-m6-zombies-design.md`](/Users/bachi/jaylli/mc-heavy/docs/superpowers/specs/2026-08-23-m6-zombies-design.md)
   与 [`docs/superpowers/plans/2026-08-23-m6-zombies.md`](/Users/bachi/jaylli/mc-heavy/docs/superpowers/plans/2026-08-23-m6-zombies.md)。
8. M7 开始前加读：[`docs/superpowers/specs/2026-08-23-m7-zombie-nests-design.md`](/Users/bachi/jaylli/mc-heavy/docs/superpowers/specs/2026-08-23-m7-zombie-nests-design.md)
   与 [`docs/superpowers/plans/2026-08-23-m7-zombie-nests.md`](/Users/bachi/jaylli/mc-heavy/docs/superpowers/plans/2026-08-23-m7-zombie-nests.md)。

规则：

- 设计与实现冲突时，**以设计文档为准**，不要用「实现方便」推翻已核验的设计决策；
- 实施必须按计划的任务与步骤走（Red-Green-Refactor），禁止跳步或省略失败验证；
- 计划中标注「冻结」的断言数字（draw call 数、setGeometryAt 阈值等）实测不符时
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
- `src/world/structures/*.json` → `assets/structures/`（原样复用）；
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
- 纹理 atlas：2048×2048、2px gutter、半 texel UV 内缩；7 张 250~362px 大图按 128×128 入图；
- ESLint 9 flat config（以 mc-lite 配置为底，本仓库五处修改见计划 Task 1 Step 3）；
- Conventional Commits（`feat:`/`test:`/`chore:`/`perf:`）；
- 每个任务结束必须 commit；**未获明确指令不得自动提交**。

## 目录结构（目标态）

```
mc-heavy/
├─ index.html                  # import map（本地 vendor/three）+ WebGPU 启动 gate + 准心
├─ vendor/three/               # three.js r185.1（three.webgpu.js / three.tsl.js / three.core.js）
├─ docs/
│  └─ phase-1-engine-design.md # 架构权威（v1.17）
├─ tools/build-atlas.mjs       # atlas 离线打包（npm run atlas）
├─ assets/
│  ├─ textures/                # 从 mc-lite 复制
│  ├─ atlas.png + atlas.json   # 生成产物，提交入库
│  └─ structures/              # 从 mc-lite 复制 JSON
└─ src/
   ├─ core/        # game.js / scheduler.js / worker-pool.js / perf.js / perf-hud.js
   ├─ voxel/       # constants / block-registry / chunk-column / world-data / blocks-data / faces-data
   ├─ gen/         # noise.js / terrain.js（M2 加 structure-index / structures/*）
   ├─ mesh/        # mesher.js / lighting.js / atlas-loader.js（Worker 同构）
   ├─ render/      # render-world.js（BatchedMesh 发布层）/ materials.js（TSL）
   ├─ player/      # player.js / physics.js / raycast.js / step-lift.js
   │               #（M3-4 加 hotbar-items.js；M3.1 加 inventory.js 物品模型）
   ├─ ui/          # coords-hud.js / hotbar.js / settings-panel.js / settings.js（M3-4）
   │               #（M3.1 加 inventory.js 背包面板：DOM 方案照搬 mc-lite）
   ├─ save/        # persistence.js（IndexedDB edits）
   └─ workers/     # world-worker.js（GEN/MESH/LIGHT 统一入口，池化）
```

依赖方向单向：`voxel ← gen ← mesh ← render`，反向依赖禁止。`core/` 不依赖 `voxel/`；
`voxel/` 不依赖 three。另有 `src/tests/`（浏览器内单测 + fixture）、`src/bench/`（基准页）、
`tests/`（Playwright spec）、`server-script/`（静态服务）。

## 开发命令（M0 Task 1 落地 package.json 后生效）

```bash
npm install                    # playwright 固定 ^1.62.1（复用本机 chromium-1234 缓存）
npm start                      # 静态服务 http://localhost:8081
npm test                       # Playwright 全部验收（tests/*.spec.mjs）
npm run bench                  # M3-5 性能基线跑图（4 场景 → docs/m3-baseline.{md,json}）
                               #   加 -- --check 为回归门禁（回退 >10% 阻断，退出码 1）
npm run lint                   # eslint src tools tests
npm run atlas                  # 重新生成 assets/atlas.png + atlas.json
```

- 浏览器内单测入口：`http://localhost:8081/src/tests/index.html`；
- 测试 runner 暴露 `window.__MC_TEST_RESULTS__`，Playwright 从页面读取断言；
- 性能基准页：`http://localhost:8081/src/bench/webgpu-publish.html`（暴露 `window.__BENCH__`）。
- 游戏入口暴露 `window.__MC_GAME__`（world/player/scheduler/registry + perfSnapshot/renderStats），
  Playwright 交互测试经此编程驱动（无头环境无真实键鼠/pointer lock）。

## 测试工作流（TDD，沿用 mc-lite）

1. **RED**：先写失败测试；2. **验证 RED**：运行确认按预期失败；3. **GREEN**：最小实现；
4. **验证 GREEN**：全部通过；5. **REFACTOR**：重构保持绿；6. 重复。

测试一开始就通过，说明测试写错了或在测已有行为。修改 `src/**/*.js` 后任务结束前跑
`npm run lint`，保持新增代码 0 error（warning 可接受）。

## 性能验收口径（第一阶段）

| 指标 | 目标 |
|---|---|
| 冷启动到可玩 | < 2s（出生点邻域先就绪，视距内后台填充） |
| 默认可视距离 | 8 chunk（128 格），架构支持 16+ |
| 奔跑帧率 | 60fps 稳定；120Hz 设备 ≥ 90fps |
| 跨 region 行走 | 无感知卡顿 |
| 放块/挖块 | 单帧内视觉生效（快速路径 < 2ms） |
| 存档体积 | 仅存 edits diff，KB 级 |

- 主线程帧预算按 8.3ms（120fps）标定：mesh 上传 ≤ 3ms、快速路径 ≤ 2ms、光照 ≤ 1ms/帧；
- 每个里程碑结束跑基线，**性能回退 >10% 即阻断合入**；
- CI 帧率采样只做趋势参考，**本机设备矩阵才是硬验收**。
- 帧时口径：120Hz vsync 锁帧下帧间隔被量化为 8.33ms，`frameMs.p95 < 8.3` 数学上不可满足
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
- 沙箱禁止 `rm`；临时脚本放 `/tmp` 或项目内 `.tmp.mjs` 后用 `mv` 清理。
- Node v26.4.0；`/tmp` 下的脚本无法解析项目 node_modules，需在项目目录内运行。

## 后续功能扩展点（引擎稳定后按阶段加入）

M4 玩家武器（`WorldEditor` + DDA hitscan + 受控 GLB/Audio，M3 验收后优先）、
M5 实体运行时（EntityManager + 实体 raycast + 受控渲染 + 临时/持久 snapshot；持久实体先可取消地冻结/保存，
成功后的下一帧才随 column 最终移除；临时实体随最终卸载回收）、
M6 丧尸（M5 临时实体 + 20Hz 单 batch WorkerPool AI + M4 武器距离比较；默认 20、无 PlayerVitals）、
M7 玩家放置丧尸巢穴（最高关键 `gold_block` 的 `blockEntity` + `block-changed` 失效 + M6 刷怪；
八 offset × 六层、GEN 接管 restoreEdits；不是地标）、
TNT/爆炸（`WorldEditor.setBlocks(batch)` + REMESH）、炮塔/飞行弹丸（M5 后独立 Epic）、
矿车/轨道（BlockRegistry `interact`/`onStep` 钩子）、创造台（mesher 顶点模板）、灯/光源
（emissive + blocklight flood fill）、床/宝箱/门（多方块结构 + `blockEntities` 富状态通道）、
音频（`block-changed` 事件总线）、设置持久化、玩家生存战斗（PlayerVitals 独立 Epic）。**新功能必须通过上述接入点实现，
不得绕过 meshing/数据/事件管线另开路径。**

## 沟通与提交纪律

- 全部使用中文；解释设计取舍时引用设计文档章节号；
- 改动前说清楚「为什么」，改动后附验证证据（命令输出、帧时、draw call 数），不凭感觉宣称通过；
- 提交必须等用户明确指令，提交信息用 Conventional Commits。
- 诊断 bug 不猜：先在真实游戏/隔离环境复现、读实际数据（light 值/扫描线/队列状态）定位根因，
  再动手修。光照类 bug 尤其如此（垂直/扩散/快慢路径多，凭印象改会引入回归）。
