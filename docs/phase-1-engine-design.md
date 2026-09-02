# mc-heavy 第一阶段实施设计文档：游戏引擎原型

> 版本：v1.15 ｜ 日期：2026-09-02 ｜ 状态：定稿（经十三轮逐条核验修订）
>
> 目标：在 mc-heavy 仓库从零重建一个功能对标 mc-lite、性能提升一个数量级的体素游戏引擎。
> 第一阶段只做"引擎底座"：渲染、体素数据、即时地图生成、玩家交互、种子地图、存档原型。
> 矿车、炮塔、丧尸、TNT、创造台等功能在引擎稳定后按阶段加入（本文档第 9 节给出扩展点设计）。
>
> v1.1 修订说明：依据对 mc-lite 实际代码的逐条核验，修正了渲染发布粒度（§4.4.2 改 column 级合批）、
> 跨 region 结构溢出（§4.2 邻区索引查询）、结构布局缓存（§4.2 布局单点计算广播）、
> section 边界依赖生命周期（§4.3）、skylight/blocklight 模型（§4.6），并补齐内存预算（§4.10）
> 与若干数字勘误（方块 124 种、纹理 122 张、Worker 8 个、blockData 现状结构）。
>
> v1.2 修订说明：修复合批机制的 draw call 陷阱（§4.4.2 明确 channel-major 3-group 布局与
> 变长 slot 打包策略，引入 BatchedMesh/sector 候选与 M1 决策门）、内存数字自相矛盾
> （§4.10/DR-8 统一为 128KB/column）、skylight 边界声明错误（§4.6 纯垂直模型不含水平依赖），
> 以及 halo 协议内外圈矛盾、normal 编码定死、布局计算移出主线程等收尾勘误。

> v1.3 修订说明：发布层选型反转——经 r185.1 源码核验，`BatchedMesh` 走 GPU multi-draw
> （一个 BatchedMesh 内 N 个 geometry 合成 1 次 GPU draw），且 `reservedVertexCount`/
> `setGeometryAt`/`setGeometrySize` 官方 API 原生覆盖了 v1.2 手工设计的 slot 打包机制，
> 故候选 B（BatchedMesh）升为默认实现、候选 A（column 3-group）降为 fallback（§4.4.2/DR-11/M1）。
> 补齐三个边界定义：transparent 通道静态排序策略（§4.4.1）、卸载滞回 + 重入 LRU 缓存
> （§4.9/§4.10/DR-16）、边界方块编辑的最坏重建范围（§4.5.3）。收尾勘误：`updateRanges` →
> `addUpdateRange()`（r185 实际 API）、顶点格式改 24B 对齐、blocklight 重算覆盖邻 column。

> v1.4 修订说明：权威数据源补齐**方块实体（block entity）通道**——宝箱库存、告示牌文字、
> 灯开关等富状态无法塞进 8bit meta，mc-lite 已有 `_saveChestStates()`（ChunkConsolidation.js:597）
> 证明该需求真实存在。§4.1 ChunkColumn 增加 `blockEntities` 稀疏 Map，§4.5.3 edits 条目扩为
> `{id, meta, blockEntity?}`，§4.8 持久化携带，§9 床/宝箱/门改指向 block entity 通道，
> 新增 DR-17。同时澄清 light 数组是**可从 blocks+emissive 重算的派生缓存**而非 gameplay 真相
> 来源（§4.1）。本阶段只预留通道，不实现任何消费者。

> v1.5 修订说明：对 v1.3 引入的 BatchedMesh 发布层做逐行源码核验，修正 4 处实现级
> API 语义错误——① 补齐 geometry+instance 两层结构（漏掉 instance 层会不渲染，
> §4.4.2）；② 纠正溢出处理：`setGeometrySize` 是整批重建/收缩且会 throw，非单 slot
> 扩容，正确路径为 deleteGeometry→addGeometry→addInstance（§4.4.2）；③ 补构造函数
> 容量预估口径（视距 8 = 2312 slot/通道）；④ transparent 排序默认路径改用 BatchedMesh
> 内置 `sortObjects` 运行时逐 section 排序，静态排序降级为 fallback 候选 A 专用（§4.4.1）。

> v1.6 修订说明：纠正 v1.3 的核心口径错误——经 WebGPUBackend.js:1806-1824 源码核验，
> r185.1 的 **WebGPU 后端对 BatchedMesh 不走 multi-draw**（JS 循环逐可见 instance 发
> drawIndexed；renderMultiDraw 只在 WebGL 后端），「3~9 次 GPU draw」口径删除，选型理由
> 重写为「draw 数量同量级、单命令成本低一个量级 + 剔除/排序/增量更新官方内置」（§4.4.2/DR-11）。
> 三处实现级修正：① 构造容量公式改为「预期活跃非空 section 数 × 平均顶点数 × 1.25」
> （v1.5 按全部 2312 slot 会数倍过度预留显存至 ~555MB/通道），运行时用 unusedVertexCount
> 监控；② 顶点格式由 interleaved 改 flat 三属性（避开 copyAttributeData 的 interleaved
> 慢拷贝路径），packed 必须 uint32（WebGPU arrayStride 须 4 字节倍数，uint16 会 validation
> error；flat 化收益是拷贝快路径而非省显存，每顶点仍 24B）（§4.3）；③ 删除「构造函数支持
> 多通道」误导（BatchedMesh 无 groups，传材质数组零 render item）。候选 A draw 数纠正为
> 固定 ~867（`_projectObject` 不看 group.count，v1.5 的 300~500 低估）。M0 新增两项
> BatchedMesh 120fps 风险点实测（逐 instance 剔除/排序 CPU 循环、setGeometryAt 端到端耗时）。

> v1.7 修订说明：两处依据实测的勘误。① atlas 贴图尺寸口径修正（§4.4.1）：mc-lite 的
> 122 张纹理实际分布为 113 张 16×16 + 2 张 32×32 + 7 张 250~362px 特殊几何/实体贴图
> （handrail/pillar/turret/zombie_nest 等，PIL 实测，不存在 64×64），大图打包时按
> 128×128 入图（2048² atlas 余量充足，缩到 64×64 会破坏 M2 结构轮廓/配色验收）；
> ② 无头 WebGPU 环境实测
> （§8）：本机（macOS ARM，Chromium 151，playwright 1.62.1）实测矩阵——完整 Chromium
> 新无头模式（`channel:'chromium'`）**零 flag 即走 Metal 拿到 adapter**，而 Playwright
> 默认的 headless shell 零 flag 拿不到 adapter；SwiftShader 组合（`--enable-unsafe-webgpu`
> + `--use-angle=swiftshader`）为 Linux CI 兜底；`--enable-features=Vulkan` 在 macOS 上
> 无作用，已从测试配置删除。

> v1.8 修订说明：skylight 模型与 light 任务写回协议勘误（§4.6/DR-14）。① 模型升级同步：
> 纯垂直模型在实玩中不可接受（任何高处实心方块把正下方整列截断为 0 → 悬挑/上凹角全黑），
> 已升级为 Minecraft 同款「垂直落下不衰减 + 水平 BFS 每格 -1」，区域 = 中心 column +
> 4 正交邻居，编辑快路径保留垂直单列做即时反馈（只升不降），水平扩散交异步 light 任务收敛。
> ② **写回协议改为中心 column 权威**：旧实现把区域结果写回全部 5 列（last-write-wins），
> 但每个 task 的 region 所含光源不同（如房屋东窗的光源在 D 列，A 中心 task 的 region 不含 D），
> 后到的「region 不完整」task 会先清零低/高 4 位再用不完整光源重算，覆盖邻列已收敛的好光
> → 实玩偶现大片全黑面 + 黑核周围一圈圈截断渐变（dispatch 顺序随计时变化 → 偶现）。
> 5-column region 对**中心列**充分（15 的光水平最远影响 14 格 < 16），故每列 light 只由
> 以它为中心的 task 写回；邻列只参与计算、不写回，仅置脏重 mesh 收敛边界脸。

> v1.9 修订说明：**第一阶段不实现阳光遮挡投影**（产品决策，实玩验收驱动）。
> v1.8 的 Minecraft 式遮挡阴影在实玩中不可接受：大悬空平台/洞穴下方超过扩散距离
> 就是大片全黑 + 截断渐变环，与 mc-lite 视觉基线（无体素阳光阴影、仅 AO 墙角阴影）
> 冲突，用户明确不要阳光投影效果。故第一阶段 skylight 恒 15（`computeSkylightColumn`
> 不遮挡），视觉明暗只来自 **AO 墙角阴影 + 日夜全局调制**；blocklight 数据管线与
> light 任务/中心权威写回机制**完整保留**（遮挡原实现保留为
> `computeSkylightColumnOccluded`），后续阶段启用阴影时切回（§4.6/DR-14）。

> v1.10 修订说明：登记第二阶段首个独立 Epic **M4 玩家第一人称武器**。M4 不改变
> 第一阶段 M2/M3 的编号、范围或冻结验收；它在 M3 性能报告验收后，以 `WorldEditor`、DDA
> hitscan、受控 GLB 视图模型为垂直切片落地（§4.5.3/§9）。详见
> `docs/superpowers/specs/2026-08-23-m4-player-weapons-design.md` 与
> `docs/superpowers/plans/2026-08-23-m4-player-weapons.md`。

> v1.11 修订说明：M4 后的实体路线拆为 M5 实体运行时、M6 丧尸、M7 玩家放置丧尸巢穴。
> 巢穴不是确定性地标：其蓝图最高 `gold_block`（而非只作放置触发的
> `zombie_nest_alias_block`）上的锚点 `blockEntity` 为持久真相，运行时控制器订阅 `WorldEditor`
> 的 `block-changed`，故徒手、武器和 TNT 均可使关键方块破坏立即失效。

> v1.12 修订说明：M5–M7 规格与计划按 mc-lite 逐项复核后收紧。M6 固定为“追逐、受武器
> 伤害、死亡回收”的临时敌人：默认上限 20，手枪/加特林/MAG7 的实体伤害与射程分别为
> `25/40`、`35/40`、`999/10`，无 `PlayerVitals`、近战、死亡/重生；AI 为 20Hz 单条批量 WorkerPool
> RPC，60 格外只冻结 AI。M7 的刷怪搜索明确为八个精确 offset、`dy=3..-2` 的六层；GEN 接管必须
> `restoreEdits()` 同时恢复 blockEntity 与内存 edits，防止后续 flush 覆盖旧存档。背包、完整 Hotbar
> 与玩家生存战斗均保持独立后续 Epic。

> v1.13 修订说明：M5 的持久实体卸载改为可取消的两阶段协议，以修正 Scheduler 同帧同步
> `world.remove()` 与 IndexedDB 异步写入不能排序的矛盾。column 超过卸载半径后仍保留 world/render，
> 先冻结持久实体并保存 snapshot；仅在保存成功后的下一帧、且仍超界时，才同步释放实体并删除 column。
> 保存失败或玩家重入均取消并解冻，禁止静默丢失；pending 状态只保存卸载生命周期，不复制体素数据。

> v1.14 修订说明：M2 增补 **M2-7 空中结构（悬浮空岛与云层）**，补齐此前从 mc-lite 漏列的
> `world/entities/Island.js` 与 `Cloud.js` 语义。它们是静态、seed 驱动的体素结构，归入
> StructureIndex + Worker GEN + column 裁剪管线；禁止复活 mc-lite 的 `structureCenters`、跨 chunk
> 补刷或运行期实体容器。保留空岛的 8% chunk 候选、Y=40..69、sky_stone/sky_grass 岛体，以及
> 单云/连通云簇的视觉语义；按产品范围删除空岛宝箱与天空树。云通过 BlockRegistry 的通用
> `supportsPlayer` 属性实现“可站立但非实心”，不在物理代码中按方块名特判。M2 关闭与 M3 冻结
> 基线均纳入空中结构场景。

> v1.15 修订说明：M3 实施落地口径回填（2026-09-02，实现细节详见 roadmap M3 条目与
> `docs/m2-m3-performance-report.md`）。① §4.7 增补**雨效与天气状态机**（M3-3）：mc-lite
> 真实实现在 `src/world/effects/RainEffect.js`（LineSegments + TSL GPU 下落，非 Engine.js
> weather 段）；mc-heavy 保留其算法与视觉参数（267 滴/半径 18/速度 24/dropLength 0.5/
> isSolid 地面截停/30Hz 距离检查 + 64 滴每帧分批迁移削峰），并按 roadmap 验收口径新增
> mc-lite 没有的**自动天气状态机**（晴 60~180s → 雨 30~90s 随机周期、5s 淡入淡出、
> force 手动覆盖同语义；周期数值为本次新定，无上游来源）。mc-lite 无天空压暗/雾距联动，
> 未引入。② §4.8 **设置持久化落点改 localStorage**（M3-4）：画质/音量/视距等设置是
> 设备级而非世界级（新世界/换存档应保留），存 `mc_heavy_settings_v1` 独立 key，
> 合并优先级 URL > 存储 > 默认；player 记录（位置/朝向/背包）仍按原设计归第二阶段，
> 第一阶段 Persistence 维持 meta+edits 两 store 不变。③ §4.9 **帧预算双档标定**（M3-2）：
> 8.3ms 标定值即 high 档（120Hz：上传 3ms/帧、mesh 下发 64/帧）；60Hz 帧间隔翻倍，
> 预算等比放宽为 low 档（6ms/128），保证两档设备世界填充速度一致。判档：
> `matchMedia('(min-refresh-rate:120hz)')` 静态检测（Chromium 未实现恒 false，不可信时
> 返回 null）→ 运行时「快帧(<11ms)比例 ≥5%」判据兜底（60Hz 物理上产生不了 <11ms 帧间隔，
> 120Hz 重负载只是量化到 16.7/25ms 仍偶发快帧；中位数判据会被启动 burst 污染误判 low）。
> 判档一次锁定防震荡；设置面板/`?budget=` 可显式覆盖。④ 视距/blur 档切换为**持久化 +
> 带参重载**：BatchedMesh maxInstances 与 WebGPU 纹理 mip level 数均在构造期固定
> （运行时翻 generateMipmaps 不重建 mip 链），重载是无副作用路径。

---

## 1. 背景与目标

mc-lite 是一个基于 Three.js（r184 WebGPU）的纯前端体素游戏，995 次提交、约 5.5 万行 JS。
功能完整（124 种方块、城市/金字塔/海岛等地标、武器、矿车、炮塔、存档、天气、光影），
但架构是"功能驱动 + 补丁叠加"长出来的，性能天花板已经锁死：

- 可视距离只有 2~3 个 chunk（32~48 格），扩大一圈立即卡顿；
- 新档需要阻塞预生成 56×56 个 chunk 的大地图，启动极慢；
- 触碰 region 边界后台扩图时明显掉帧；
- 玩家奔跑过程中帧率不稳，高刷设备跑不满。

**第一阶段目标（验收口径）**：

| 指标 | mc-lite 现状 | mc-heavy 目标 |
|---|---|---|
| 冷启动到可玩 | 预生成数十秒~分钟级 | < 2 秒可操作（出生点邻域先就绪，视距内后台填充） |
| 默认可视距离 | 2~3 chunk（32~48 格） | 8 chunk（128 格），架构支持 16+ |
| 奔跑帧率（视距 8） | 扩大即卡顿 | 60 fps 稳定；120Hz 设备 ≥ 90 fps |
| 跨 region 边界 | 明显卡顿 | 无感知 |
| 放块/挖块响应 | 依赖 consolidation 异步收敛 | 单帧内视觉生效（< 16ms） |
| 存档体积 | 整块 blockData 序列化 | 仅存玩家修改（diff），KB 级 |

设计原则：

1. **数据只有一份权威**：主线程内存中的 typed array 体素数据。其余一切（网格、AO、可见面、碰撞）都是可随时重建的派生数据。mc-lite 的 WorldBlockDataStore / RegionCache / WorldChunkPayloadRegistry / WorldChunkRegistry / solidBlocks / visibleKeys / instanceIndexMap 等多层容器全部不再需要。
2. **重计算全部离开主线程**：地形生成、网格化、光照计算在 Worker 池完成；主线程每帧只做输入、物理、调度、上传、渲染。
3. **确定性生成**：地形 + 结构完全由 seed 决定，任何时候可以按需重算。这是"干掉预生成"的前提，也是存档只存 diff 的前提。
4. **同步响应、异步优化**：玩家操作必须当帧视觉生效（主线程快速路径），后台再做高质量重算（Worker 精修路径）。两条路径用统一的版本号协议收敛，从架构上消灭 mc-lite 里反复打补丁的竞态问题。

---

## 2. mc-lite 瓶颈诊断（重构依据）

对 5 个指定问题逐一给出根因分析。这些结论直接决定新引擎的设计取舍。

### 2.1 地图预生成慢、边界卡顿

**现状链路**：`WorldGenerationService.generateInitialWorld()` 新档阻塞生成 7×7 region = 56×56 chunk，
逐 chunk 发给单个 WorldWorker 生成（每 chunk 内部还要跑完整结构队列、AO、面剔除），结果按 region 写 IndexedDB；
接近边界时 `WorldBoundsController` 触发后台扩图，扩图期间与玩家操作争抢同一个 Worker 和主线程装配预算。

**根因**：
- 预生成本质是"把随时可以算出来的东西提前算完并存盘"。因为 mc-lite 的地形生成是确定性的（seed 驱动），预生成在信息论上是冗余的——唯一不可再生的是玩家修改。
- 单 Worker 串行生成 + 主线程逐 chunk 装配（`BlockScatterManager` 分发 + `ChunkAssemblyScheduler` 预算内装配），生成吞吐被主线程装配上限锁死。
- 结构（城市、金字塔）跨 chunk 溢出（overflowChunks / crossRegionOverflowMap）导致生成必须以 region 为单元批量做，进一步放大单次任务体积。

**新引擎对策**（详见 §4.2）：彻底删除预生成。chunk 进入加载半径才生成；结构布局由确定性索引按 region 计算、按 chunk 裁剪注入。
注意：跨 **chunk** 的溢出被生成期裁剪吸收（每个 chunk 只写自己范围内的块），但跨 **region** 的溢出是真实需求
（地标随机中心偏移 100~400 + 半尺寸 40~80 会越过 400 格 region 边界），由邻区索引查询解决（§4.2），
而非 mc-lite 的 `crossRegionOverflowMap` 运行期暂存。

### 2.2 奔跑帧率低、视距无法扩大

**根因（按影响排序）**：

1. **渲染几何模型低效**。mc-lite 的"面剔除"只决定**方块**是否可见（visibleKeys），但每个可见方块仍然渲染**完整立方体**（6 面 12 三角形）——一个只露出顶面的泥土块照样画 6 个面。且按方块类型分 InstancedMesh（`geomMap` + 每类型一个 mesh），124 种方块 × 每 chunk 若干类型 × 视距内几百 chunk = 数千 draw call，且无法用纹理图集合批。这是视距扩一大就崩的第一原因。
2. **交互走 THREE.Raycaster 与 InstancedMesh 求交**（`PlayerInteraction.js` 每帧 `intersectObjects(targets, true)`）。对 instanced mesh 求交要逐实例逆矩阵变换，视距内实例数以万计，奔跑时每帧射线检测是主线程大头。
3. **主线程装配/合并开销**。动态方块的"先独立 Mesh、后 consolidation 合并"双层渲染、AO 防抖覆写、跨 chunk 补丁分批刷入（`GLOBAL_INSTANCE_FLUSH_*` 一整组预算常量）都在帧内抢时间。
4. **数据结构低效**。blockData 经最近重构后是 `Map<chunkKey, Map<encodeCoord(number), entry>>`
   （`WorldBlockDataStore` 三层容器，数字键 Map，混合少量旧 string 档），`solidBlocks` 仍是字符串 Set。
   高频读写路径（物理碰撞每帧数十次查询）走双层哈希 + 对象分配，且 chunk 级 Map 无法做 O(1) 的
   坐标算术索引与连续内存遍历。结论（哈希 + 对象分配是热路径瓶颈）不变，但按现状表述。

**新引擎对策**：逐面网格化 + 纹理图集（§4.3/§4.4）、体素 DDA 射线（§4.5）、typed array 数据层（§4.1）、主线程零重计算（§4.9）。

### 2.3 大型建筑打散逻辑

**现状**：结构在 Worker 里整体生成后"打散"成 scatteredBlocks，由 `BlockScatterManager` 按坐标分发到各 chunk buffer，
再有 `pendingCrossChunkPatchBuffers` 延迟跨 chunk 补刷、`structureCenters` 合并、ready/flush 状态机等一系列补丁。
打散是为了"结构不整体出现、避免近距离闪现"，代价是结构实体消失、所有交互都对着散块，且分发/补刷/去重逻辑成为长期 bug 源。

**诊断**：打散解决的真问题是"跨 chunk 结构的生成结果如何落到各 chunk"。这是一个**生成期**问题，mc-lite 把它推到了**运行期**用 buffer 分发解决，才需要这么多层状态。

**新引擎对策**：生成期解决。每个 chunk 生成时，通过确定性结构索引查询"所有 AABB 覆盖本 chunk 的结构"，直接把结构方块裁剪写入本 chunk 数据。结构从来不是实体，也不需要 buffer 分发——每个 chunk 落地即完整，天然没有闪现，`BlockScatterManager` 整层删除。

### 2.4 face culling / consolidation / instanced mesh 归一化

**现状**：三套机制各自为政——
- FaceCullingSystem（主线程 + FaceCullingWorker）算可见性；
- Consolidation（脏块 ≥50 或 1000ms 防抖）把整 chunk blockData 发 Worker 重算重建 InstancedMesh；
- GlobalInstancedMeshManager 把各 chunk 的同类型实例归一到全局 TypeBuffer，带容量增长、脏区上传、chest 状态迁移等复杂簿记。

**诊断**：这三者本质是同一件事（"体素数据 → 可渲染几何"）被拆成三条互不信任的路径，于是需要 epoch、防抖、AO 旧值保留、脏集、竞态 guard 等补丁缝合。冗余确认属实。

**新引擎对策**：统一为单一 meshing 管线（§4.3）。面剔除是 meshing 的内部步骤；consolidation 不存在（没有"临时 mesh"中间态）；InstancedMesh 退出地形渲染（保留给矿车/丧尸等动态实体）。

### 2.5 可视距离扩展性

**现状**：渲染距离硬编码 2~3，扩大即帧率崩（原因见 2.2）。

**新引擎对策**：视距在新架构里只是一个配置项。关键支撑：
- 逐面网格化 + atlas 后，**单位面积**渲染成本大幅下降（全立方 12 tri/块 → 暴露面 2~8 tri/块，
  平均约 2~4×、理论上限 6×）。注意：视距 8 的可见**面积**约为视距 3 的 7 倍，总三角形数仍会高于 lite 视距 3，
  所以收益口径是"每方块/单位面积"而非"总量持平"——真正的瓶颈与解法在 draw call（§4.4.2）；
- 生成/网格化全在 Worker 池，视距扩大只增加后台任务量，不增加主线程帧内成本；
- 预留 LOD 接口（§4.4.5）：远圈 chunk 可降级为合并粗模，主线程 draw call 增长有上限。

---

## 3. 总体架构

```
┌────────────────────────────────────────────────────────────────┐
│                        主线程（帧循环）                          │
│                                                                │
│  Input → Player/Physics(定步长) → Systems → Scheduler → Render │
│                                        │                       │
│  WorldData（唯一权威）                   │ 帧预算控制器           │
│  ├─ ChunkColumn: Uint16Array 体素       │ (上传/重建 ≤ N ms)    │
│  ├─ Edits: 玩家修改稀疏层               ▼                       │
│  └─ LightData: 光照数组          Mesh 上传 / Section 快速重建    │
└───────────────────────────────┬────────────────────────────────┘
                                │ Transferable（零拷贝）
                                ▼
┌────────────────────────────────────────────────────────────────┐
│                     Worker 池（N = CPU-1）                       │
│                                                                │
│  任务类型（按优先级调度，可取消，版本校验）：                       │
│  ① GEN     地形+结构生成（seed 确定性）                          │
│  ② MESH    section 网格化（面剔除+AO+顶点缓冲构建）               │
│  ③ LIGHT   光照/AO 增量精修                                     │
│  ④ REMESH  批量修改（爆炸等）后的区域重建                         │
└────────────────────────────────────────────────────────────────┘
```

分层与依赖方向（单向，禁止反向依赖）：

```
voxel(数据) ← gen(生成) ← mesh(网格化) ← render(渲染)
     ↑                        ↑
  player/物理/交互          save(持久化)
```

- `voxel` 不知道渲染存在；`mesh` 只读体素数组产出顶点缓冲；`render` 只消费缓冲。
- `gen` 与 `mesh` 的核心函数是**主线程/Worker 同构**代码（纯函数、无 DOM 依赖），
  这保证：单块修改可以在主线程 1~2ms 内同步重建一个 section（快速路径），
  同时 Worker 可以异步产出同质量的完整结果（精修路径），两者输出格式完全一致。

技术选型（延续 mc-lite 的开发体验）：
- **纯 JavaScript（ES2022+ ES Modules），不使用 TypeScript**，无编译/转译环节；
  类型信息用 JSDoc 注释表达（关键数据结构与公共 API 加 `@param/@returns/@typedef`），
  配合 ESLint 保证质量，延续 mc-lite 的工具链；
- Three.js **r185.1**（2026-07 最新稳定版，mc-lite 为 r184，API 兼容直接升级），
  **WebGPU 唯一后端**（详见 §4.4.6，不做 WebGL2 降级）；import map + ES Modules，**无构建步骤**；
- Module Worker（`new Worker(url, {type:'module'})`）；
  注意：module worker **不继承**页面的 import map（浏览器支持参差），因此 worker 内一律用
  相对路径 import 本项目模块；three.js 只在主线程使用，world-worker 不依赖 three，实际影响小，
  但作为约束写明，避免后续踩坑；
- 持久化 IndexedDB（延续 mc-lite 的 SaveConfig 命名，便于老存档迁移工具后续接入）。

---

## 4. 核心子系统设计

### 4.1 体素数据层（src/voxel/）

**坐标与尺寸**
- 世界高度固定 128：`WORLD_MIN_Y = -32, WORLD_MAX_Y = 96`。
  与 mc-lite 坐标兼容（海平面 y=-2、基岩 y=-13、地标结构原样移植无需平移）。
  下界取 -32 而非 -16 的原因：mc-lite 地形柱填充最低到 `h-12`，而噪声高度 h 理论下界约 -16，
  最低块可达 -28；`MIN_Y=-16` 会截断极端地形。-32..96 仍是 8 个 16 格 section 整除。
- ChunkColumn：16 × 16 × 128，世界数据与存档的基本单元（对应 mc-lite 的 "cx,cz" chunk）。
- Section：16 × 16 × 16，网格化与脏标记的基本单元。每 column 8 个 section（sy = 0..7）。

**存储**

```js
class ChunkColumn {
  cx; cz;                          // column 坐标
  blocks: Uint16Array(16*16*128);  // 方块 ID，索引 = x + z*16 + (y-MIN_Y)*256
  meta:   Uint8Array(16*16*128);   // orientation(3bit) + 保留位（发光强度等）
  edits:  Map<index, {id, meta, blockEntity?}>;  // 玩家修改稀疏层（生成时叠加，卸载时序列化）
  blockEntities: Map<index, object>;  // 方块实体富状态（宝箱库存/告示牌文字/灯开关等），
                                      // 稀疏，仅对有状态的方块存在；第一阶段只预留通道
  light:  Uint8Array(16*16*128);   // 高4位 skylight，低4位 blocklight（§4.6）
  sections: Section[8];            // 派生：网格状态（dirty/mesh/version）
  state: 'empty'|'generating'|'ready';
  version: number;                 // 每次 blocks/meta 数据变更 +1，所有异步结果校验用；纯 blockEntity 状态不进 Worker
}
```

- `blocks` 是"terrain + edits 叠加后"的最终数据（生成完毕即叠加），保证读路径零分支。
  `edits` 仅用于持久化与 column 重生成（卸载后内存释放，再进入视距时 terrain 重算 + edits 重放）。
- **权威边界澄清**：gameplay 的真相来源只有 `blocks` + `meta`（+ `blockEntities` 富状态）。
  `light` 数组是**可从 blocks + emissive 重算的派生缓存**（为渲染免重算而常驻），
  不是权威——任何光照不一致都可通过重算收敛，实现时不得把 light 当真相来源。
  mesh/AO/可见性/碰撞同理，全是派生数据（§1 设计原则 1）。
- **方块实体通道（v1.4 补齐，只预留不实现消费者）**：宝箱库存、告示牌文字、熔炉进度、
  可开关灯的亮灭等状态**无法塞进 8bit meta**，需要每位置任意结构化数据。
  mc-lite 已有该需求的证据：`ChunkConsolidation.js:597 _saveChestStates()` 在 mesh 重建时
  迁移 `instanceIndexMap['chest']` 的状态（用 InstancedMesh userData 暂存，是补丁式实现）。
  新引擎把它做成数据模型的一等公民：`blockEntities` 稀疏 Map，key 与 blocks 同索引，
  value 为任意可序列化对象。第一阶段不实现任何消费者（宝箱/告示牌属后续阶段），
  但 edits 条目、持久化 schema、重放逻辑现在就把形状定好，避免后续回填引发
  存档 schemaVersion + edits 重放的二次重构。
- 方块 ID 0 = air。`BlockRegistry`（src/voxel/block-registry.js）负责 string name ↔ ID 映射与属性表：

```js
registry.register('grass_block', {
  solid: true, opaque: true,
  faces: { top: 'grass_top', bottom: 'dirt', side: 'grass_side' }, // atlas tile 名
  cullMode: 'opaque',        // opaque | cutout | transparent | none
  emissive: 0,               // 发光强度 0-15（灯/萤石/岩浆）
  geometry: 'cube',          // cube | cross(花/草) | slab | 自定义模型
  orientationModes: 0,       // 支持朝向的数量（沿用 mc-lite OrientationUtils 语义）
});
```

- 属性全部预编译为按 ID 索引的 typed 查找表（`opaqueTable[id]`, `cullTable[id]`…），
  网格化热路径无对象属性访问、无字符串比较。mc-lite 的 BlockData.js（124 种方块）整体迁移为注册表数据。
- **cullMode 语义勘误（M2 bug 修复）**：cullMode 是**渲染通道**选择（opaque/cutout/transparent
  三材质之一），必须对齐 mc-lite 的**材质**透明度（MaterialManager 注册的 transparent/alphaTest），
  而不是 BlockData 的 `isTransparent`（那是面剔除语义：「不剔除邻居面」）。M0 转换曾把二者混同，
  导致台阶/栏杆/柱子/宝箱等 12 个不透明材质方块落入 blended 通道（depthWrite=false）——
  L 形台阶自身面片无深度互遮，凹角透视穿帮。已修正：上述方块改 cutout（alphaTest 0.3 对
  全不透明贴图无副作用、深度写入恢复）；剔除语义由 `opaqueTable` 独立承担，不受影响。
  真混合通道仅留 water/swamp_water/cloud/glass_block/glass_blink。

**读路径 API**（物理/射线/meshing 共用）

```js
world.getBlockId(x, y, z)      // O(1)，越界返回 0（air）或基岩（y < MIN_Y）
world.isSolid(x, y, z)         // opaqueTable 直查，无字符串
world.setBlock(x, y, z, id, meta)  // 见 §4.5.3 编辑管线
```

跨 column 读取由 WorldData 维护的 column 索引完成。meshing 的 halo 视图统一为 **section 级**：
`getSectionView(cx, sy, cz)` 返回 18×18×18 的连续体素视图（中心 section + 1 格 halo，
跨 column/跨 section 边界自动拼接）。column 级 18×144×18 视图不再作为接口暴露，
避免与 section meshing 粒度矛盾；GEN 任务内部如需整柱数据直接使用 `column.blocks`。

### 4.2 地形与结构生成（src/gen/，Worker 侧，完全按需）

**核心决策：删除预生成。** 世界没有边界（safeBounds/expandTargetBounds/WorldBoundsController 全部删除），
玩家走到哪里生成到哪里，seed 相同则世界相同。

**生成管线（每个 chunk column 一个任务）**：

```
GEN 任务(cx, cz, seed, edits)
  1. heightmap(16×16)     多层噪声 + biome（移植 mc-lite TerrainGen/MathUtils 噪声）
  2. 3D 填充              地层（bedrock/stone/dirt/表层）、洞穴（保留 rooms 逻辑）、水面填充
  3. 结构注入             StructureIndex.query(cx, cz) → 逐个结构 rasterize 并裁剪到本 column
  4. 叠加 edits           玩家修改覆盖生成结果（仅 blocks/meta，typed array 路径）
  5. 输出 Transferable    blocks/meta 的 ArrayBuffer + 结构元数据（光源点、实体挂点）
```

注：edits 重放在 Worker 侧只覆盖 `blocks`/`meta`（typed array，随 Transferable 回传）；
`blockEntities` 是对象 Map，不进 Worker，由主线程在 GEN 完成接管数据时从 edits 恢复
（§4.1），保持 typed array 传输路径干净。

**结构系统（对 mc-lite 的继承与改造）**：

- 布局确定性：`StructureIndex` 以 region（400×400，沿用 RegionMapConfig）为键，
  由 seed 确定性产出该 region 的地标清单与位置（金字塔/冰封山/雪地/海岛/城市/树木候选，
  以及 M2-7 的悬浮空岛与连通云簇候选）。单云层是逐 column 的纯噪声判定，无候选缓存。
  mc-lite 已有 `StructureCandidateIndex` + `RegionCenterUtils` + 各 maps（CityMap/Pyramid/…），
  这套"候选发现"逻辑**整体移植**，只改输出端：从"scatter 分发"改为"每 chunk 查询 + 裁剪"。
- **跨 region 溢出（真实需求，必须处理）**：mc-lite 地标随机中心偏移为 BASE 100 + SCALE 300
  （`RegionCenterUtils.CENTER_OFFSET`），叠加地标半尺寸 40~80，会越过 400 格 region 边界——
  `crossRegionOverflowMap` 不是冗余补丁而是真实需求。City 固定 [0,0] 且 224 宽不跨界，
  但金字塔/冰封山/海岛等会跨界。新引擎的解法：`StructureIndex.query(cx, cz)` 同时查询
  **本 region + 相邻 8 个 region**（邻区布局用同 seed 确定性重算，结果一致），把覆盖本 chunk
  的结构全部裁剪注入。不给地标加硬 margin（那会改变与 lite 的世界布局、破坏同 seed 对比）。
- **结构布局缓存（多 Worker 池的关键约束）**：N 个 Worker 各自持有 StructureIndex LRU 会导致
  同 region 的数百个 chunk 任务落在不同 Worker 上重复跑 City 布局（候选扫描很重），冷启动和
  进城时成为新卡点。解法：**布局在单个 Worker（或池内带布局锁的任务）里算一次，主线程
  只转发**——City 候选扫描较重，不能放主线程（会卡帧）；StructureIndex 的 region 布局
  结果体积小且确定性，布局 Worker 算好后由主线程随 GEN 任务参数下发给各 Worker，Worker 只做
  rasterize + 裁剪，不重复跑候选发现。**依赖规则**：某 region 的 GEN 任务必须等该 region
  及相邻 region（跨 region 查询最多涉及 9 份布局）的布局全部就绪后才下发。
- 结构光栅化：JSON 结构（src/world/structures/*.json 整体复用）与代码结构
  （城市排布、金字塔、tank 等，移植 WorldWorker 内各 generate* 函数）统一实现
  `Structure.rasterize(aabb) → blocks` 接口，输入任意 AABB 输出裁剪后的方块列表。
- **闪现问题的新解法**：结构块随 chunk 一起生成、一起进视距，远圈 chunk 未就绪时
  该区域就是"未加载"（雾遮挡），不存在"玩家跑到跟前结构突然蹦出来"——
  因为加载半径 ≥ 视距 + 生成提前量（§4.9 调度保证），结构永远在玩家看见之前就绪。
- **空中结构（M2-7）**：悬浮空岛和连通云簇的候选按其来源 chunk 的 `(cx, cz, seed)`
  纯 hash 在 region layout 中一次计算；`StructureIndex.query(cx, cz)` 仍查询本 region 与相邻 8 个
  region，再按候选 AABB 与当前 column 相交性过滤。岛体/云簇只把落入当前 column 的体素写入
  `blocks`，不存结构中心、不创建 entity、不发跨 column 补刷。原 mc-lite 的 `Math.random` 连通云
  游走改为同一 hash 序列，确保任意加载顺序结果一致。Y=55 的单云层直接由 `(wx,wz,seed)`
  噪声生成；Y=35 的连通云簇由 region layout 候选驱动；`cloud` 的“可站立”由 BlockRegistry `supportsPlayer` 表驱动，仍为 non-solid、
  transparent、非遮光方块。

**生成性能预算**：
- 单 column GEN（无大结构）目标 < 8ms（Worker 时间）；含城市结构切片 < 25ms。
- Worker 池并行（默认 `hardwareConcurrency - 1`，下限 3），按"距玩家切比雪夫距离 + 视线方向加权"排序。
- 任务可取消：玩家移动导致 chunk 出圈时，队列中未开始的任务直接丢弃。
- 冷启动：**出生点邻域（3×3 column）先就绪即可玩**，视距内其余 (2×8+1)²=289 个 column
  后台填充。注意"看到 128 格"需要 289 个 column 全部 GEN，所以"冷启动 < 2s"的口径是
  "可操作、可移动"，而非"视距内全部渲染完成"——后者在后台数秒内补齐。
- **出生点安全**：复刻 mc-lite 的"spawn on dry ground"逻辑——出生点向下搜索首个非 air 方块，
  在其上方生成，避免出生落水或悬空（上一版 TS 实现已验证此逻辑必要）。

### 4.3 网格化管线（src/mesh/，唯一的面剔除/合并实现）

**输入**：一个 section 的体素 + 1 格 halo + 光照数据。
**输出**：三个顶点缓冲（opaque / cutout / transparent），直接可上传。

**面剔除规则（meshing 内部步骤，不再有独立 FaceCullingSystem）**：

```
对每个非 air 方块的每个面：
  neighbor = 邻居方块
  emitFace = neighborCullMask[neighbor.id] < faceOpacity[face]
  特例：water/glass 同类型相邻不画面；cutout（树叶/花）按配置决定是否自剔除
```

**顶点格式（flat 三属性，v1.6 由 interleaved 改为 flat）**：

```
position: Float32BufferAttribute ×3  （section 局部坐标，mesh.position 挂 chunk 世界偏移）
uv:       Float32BufferAttribute ×2  （atlas 坐标，构建时写入）
packed:   Uint32BufferAttribute ×1   （bit0-7: light = skylight<<4 | blocklight，§4.6；
                                      bit8-9: AO 值 0-3，经典四角 AO，移植 mc-lite AOUtils 算法；
                                      bit10-12: 面索引 0-5，供着色器取法线——不依赖导数技巧，M1 前定死）
```

**为什么 flat 而非 interleaved（v1.6 源码核验）**：`setGeometryAt` 的 `copyAttributeData`
（BatchedMesh.js:97-110，已核验）对 `isInterleavedBufferAttribute` 走逐分量
`getComponent/setComponent` 慢路径（重 section 十多万次带边界检查的调用），会吃掉
<2ms 快速路径预算；flat 属性走 `dst.array.set()` 快路径。BatchedMesh 内部本来就是 flat 属性。
**packed 必须是 uint32 而非 uint16**：WebGPU 规范要求顶点 `arrayStride` 是 4 字节倍数
（规范原文已核验），flat 的 uint16（itemSize=1）stride=2 字节会在 pipeline 创建时
validation error；uint32 stride=4 合法，且 13bit 实际用量余余充足。**不要为了"省 2 字节"
改回 uint16**。每顶点 12+8+4 = 24B，与 interleaved 版总量持平（flat 化的收益是拷贝快路径，
不是省显存）。
每面 4 顶点 6 索引（uint32 index buffer）。一个典型地形 section 约 1~4k 面 → 缓冲 100~400KB 级别，
上传走 `BufferAttribute.addUpdateRange(start, count)` 只传变化段（r185 正式 API，
配合 `clearUpdateRanges()`；不要直接改 `updateRanges` 数组）。

**两条重建路径（统一输出格式，版本号收敛）**：

| 路径 | 触发 | 执行位置 | 延迟 |
|---|---|---|---|
| 快速路径 | 单块放置/挖掘 | 主线程同步重建该 section（±邻居面） | < 2ms，当帧生效 |
| 精修路径 | chunk 首次就绪、光照变化、批量修改 | Worker MESH 任务 | 1 帧~数十帧，结果按 column.version 校验后原子替换 |

快速路径保证手感；精修路径保证最终质量（完整 AO/光照）。两者产出同构缓冲，
替换时按 slot 写回 + updateRange 增量上传（§4.4.2），无 mc-lite 式"动态 Mesh ↔ 合并 Mesh"双状态。
**consolidation 机制由此整体删除。**

**section 边界依赖的生命周期（halo 邻居协议）**：

面剔除与 AO 需要 1 格 halo，邻居 column 晚生成会导致边界面错误/接缝闪烁，必须显式管理：

1. **GEN 顺序**：调度按切比雪夫距离排序，保证内圈 column 先就绪；
2. **MESH 前置条件**：section 的 MESH 任务仅在其 4 个水平邻居 column **在加载半径内但尚未生成**
   时保持 pending，不产出半成品网格；半径外的缺失方向不 pending，直接走第 4 条的保守出块。
   （对角邻居只影响 AO，用"未加载=实心"近似，见第 5 条）；
3. **邻居到达触发重 mesh**：column B 就绪时，调度器把与 B 相邻的已 mesh column 的
   **边界 section**（贴 B 的那一排）置脏并重新入队 MESH。触发方是调度器（不是 column 自己），
   收敛依据是 column.version——重 mesh 结果携带触发时的邻居版本号，过期即丢弃；
4. **视距最外圈兜底**：最外圈 column 的 halo 之外是未加载区，面剔除按"未加载=不剔除"
   （保守出块）处理，玩家永远看不到未加载区的内部面；雾距覆盖该圈，视觉上无接缝。
5. **对角 AO 近似是永久性的**：对角 column 到达**不触发**重 mesh（只触发正交邻居），
   接受 column 角上 AO 的轻微偏差。若后续视觉验收不接受，再加"对角到达 → 角 section 重 mesh"触发。

**非立方体方块**：花/草（cross）、台阶、栏杆、烟囱、床、活塞头等 mc-lite geomMap 的特殊几何，
在 mesher 内按 `geometry` 类型展开预定义顶点模板（每种模板 = 一组面 + UV 映射），
仍然合入同一 atlas 材质——不再为每种形状维护独立 geometry/material。

**顶点模板已落地清单（M2 对齐 mc-lite，坐标逐格复刻 ChunkConsolidation.js geomMap）**：
flower/short_grass 等（0.7 cross，y∈[-0.1,0.6]）、vine（0.8 cross，y∈[0.5,1.5]）、
lilypad（0.8×0.8 水平 quad，y=0.02）、cactus（主干+4 侧枝盒）、chimney（8 段棱柱高 2）、
handrail/A/B、vertical/horizontal_pillar、planks/cobblestone(_updown)/stone_diorite_step（L 形）、
half_block（床，1×0.5×1）、hanging_lamp（绳 cross+灯体盒）。
- **面 UV 口径 = three.js BoxGeometry buildPlane**（vendor/three r185.1 源码核验）：
  +X: u=1-z,v=y；-X: u=z,v=y；+Y: u=x,v=1-z；-Y: u=x,v=z；+Z: u=x,v=y；-Z: u=1-x,v=y。
  与 mc-lite InstancedMesh 一致（历史 bug：±X 用统一 UV → 东西面贴图旋转 90°，已修）。
- **双面口径**：mc-lite 植被/藤蔓/睡莲与 realistic_oak_leaves 为 DoubleSide，其余 FrontSide。
  单材质通道内用「双向绕线」复刻双面（不拆通道、不加材质）。cutout 材质 alphaTest=0.3
  （mc-lite 树叶族口径，树冠内表面背向剔除 → 堆积不过密）。
- **床 UV 变换**：repeat/offset/rotation 等价角点变换（vHalf/uFlip/rot，three setUvTransform 核验）。
- **模板不做面剔除**（mc-lite 实例级渲染同口径）；光照读自身格；AO 按顶点推导（子格取最近格角）。

**朝向渲染消费（M2 bug 修复阶段提前落地；交互侧放置语义仍属第二阶段）**：
- meta 低 2 位 = orientation 0-3（mc-lite OrientationUtils 语义：yaw = orientation × 90°，
  俯视为逆时针；EAST=0/SOUTH=1/WEST=2/NORTH=3）。渲染侧**无条件消费**（meta&3 非零即旋转，
  与 mc-lite ChunkConsolidation.js:530 逐实例应用 b.orientation 一致——结构 JSON 会给
  bed/planks 等 orientationEnabled=false 的方块写非零 direction）；`orientationModes`
  只管放置交互（第二阶段），不参与渲染门控。
- mesher 按「模型面迭代」实现：tile/床 UV 变换查**模型面**（贴图随方块转）；顶点绕块中心
  (0.5,0.5,0.5) 按 yaw 旋转（o=1: (dx,dy,dz)→(dz,dy,-dx)；o=2/3 类推）；面剔除/光照/AO/
  packed face 位用**世界面**（模型面经同一旋转映射，双射）。BoxGeometry UV 约定旋转自洽，
  侧面无需额外 UV 变换，顶底面随顶点旋转自动正确。绕线在旋转下保持，FrontSide 语义不变。
- 数据流：`getSectionView` 增打 meta（Uint8Array 18³）；MESH 任务随 data/light transfer；
  主线程快速路径与 Worker 精修同构消费。orientation=0（绝大多数）走零开销原路径。
- 结构 JSON 的 direction 经 structure-json.js 写入 meta（既有），本机制是其首个渲染消费者。

### 4.4 渲染管线（src/render/）

**4.4.1 纹理图集**
- 启动时把 mc-lite 现有散纹理（src/assets/textures/*.png，122 张：113 张 16×16 +
  2 张 32×32 + 7 张 250~362px 特殊几何/实体贴图按 128×128 入图）
  打包进一张 2048×2048 atlas（离线脚本生成 atlas.json：tile 名 → UV 矩形；运行时也保留 Canvas 合成 fallback）。
- **程序化贴图烘焙（M2 对齐 mc-lite）**：mc-lite MaterialManager 约 21 种材质是运行时
  canvas 程序化绘制（mkMat/mkProceduralMat/mkDetailMat，无 PNG）。`tools/bake-procedural-textures.mjs`
  逐行复刻其绘制参数离线烘焙到 `assets/textures/procedural/`（vine/flower/lilypad/cactus/marble/
  handrail/pillar/chimney/hanging_lamp/cloud/playground 等），随机源固定种子（确定性红线）。
  atlas 合计 147 tile（126 + 23 程序化，M2-7 空岛 sky_stone/sky_grass +2）。faces-data.js 全量 126 方块六面映射对齐 MaterialManager。
- **atlas 渗色防护**：2048 atlas + mipmap 会跨 tile 渗色。tile 之间留 16px gutter，打包时每 tile
  边缘像素向外 bleed 8px 回填（build-atlas.mjs），UV 内缩半 texel；默认 blur=0 时用 NearestFilter +
  关闭 mipmap（mc-lite 默认即像素风），模糊档位（`?blur=1`，M3-4 设置面板接线）开启时才启用
  三线性 mipmap + anisotropy 8（此时 gutter/bleed 生效，覆盖接缝导数尖峰的 mip 足迹）；
  匀质 tile（cloud）UV 收缩到 tile 中央 1/4，使 wrap 尖峰足迹永不跨 tile。
- 全部不透明方块 = 1 个材质。cutout 用 alphaTest 同 atlas 第二材质（FrontSide + alphaTest 0.3，
  mc-lite 树叶族口径；双面需求由 mesher 双向绕线解决，见 §4.3）；
  玻璃/水单独透明材质。
- **transparent 通道排序策略（必须显式定义）**：
  - **默认 BatchedMesh 路径**：`BatchedMesh.sortObjects` 默认 `true`，内置**逐 section
    运行时距离排序**（源码核验 BatchedMesh.js:221/1578），比静态排序更强——粒度更细、
    随相机自适应。直接用内置能力，无需自实现。
  - **fallback 候选 A 路径**：three.js 只做 object 级排序，不排一个缓冲内部的面。
    此时 meshing 把 transparent 通道的面按「到 column 中心距离」做静态排序（零运行时成本），
    column 间交界处的少量混合次序 artifact 接受（Minecraft 通行口径）。
  - 两条路径都不做逐**面**运行时排序（成本不可接受）。
- mc-lite 的纹理模糊档位（NearestFilter ↔ mipmap）在 atlas 级别保留实现。

**4.4.2 渲染发布粒度：section 重建、合批发布（BatchedMesh 默认 + 可插拔发布层）**

**决策**：section 继续作为重建与脏标记的最小粒度（快速路径 <2ms 不变），
但**发布层合批**。发布层做成可插拔接口（`PublishStrategy`），M1 用微基准做最终确认，
但默认实现已由 r185.1 源码核验定型为 **BatchedMesh**（v1.3 反转 v1.2 的默认值）。

**默认实现：BatchedMesh 通道级合批（v1.3 源码核验后升级）**

- **draw 提交模型（v1.6 纠正 v1.3 的核心错误）**：r185.1 的 **WebGPU 后端对 BatchedMesh
  不走 multi-draw**——`WebGPUBackend.js:1806-1824`（已核验）对 `isBatchedMesh` 是 JS 循环，
  每个可见 instance 各发一次 `passEncoderGPU.drawIndexed(counts[i], 1, starts[i]/bytesPerElement, 0, i)`。
  `_indirectTexture` 的真实用途是着色器侧按 instance 读矩阵（batch() 节点），不是 draw 提交；
  单次 `renderMultiDraw` 只存在于 WebGL 后端（WebGLRenderer.js:1321，依赖 `WEBGL_multi_draw`
  扩展），我们是 WebGPU 唯一后端，享受不到。
- **因此「3 个 BatchedMesh ≈ 3~9 次 GPU draw」不成立（v1.6 删除该口径）**。真实情况：
  3 个 render item、每通道 1 个 pipeline，但 **GPU 命令数 = 可见 section 数**（视距 8
  预计数百次，具体看视锥与地形）。选型理由相应改写（见 DR-11）：BatchedMesh 与候选 A
  的 draw 数量**同量级**，但 BatchedMesh 循环内所有 drawIndexed **共享同一 pipeline、
  同一 bind group、同一顶点缓冲，命令间零状态切换**；空 section 无 instance、零命令；
  per-instance 视锥剔除与透明逐 section 排序官方内置。
- **构造函数只接受单个 Material（v1.6 纠正）**：BatchedMesh 从不创建 geometry groups
  （全文件无 addGroup/groups 赋值，已核验），传 material 数组会在 `_projectObject` 里
  遍历空 groups → **一个 render item 都不产生**。多通道只能靠「每通道一个 BatchedMesh」，
  不存在"一个 BatchedMesh 挂多材质"的用法。
- **两层结构（geometry + instance，v1.5 源码核验补齐，必须写死）**：`BatchedMesh` 是
  geometry slot + instance 两层。`addGeometry()` 只注册 geometry slot，**不会渲染**；
  必须再 `addInstance(geometryId)` 创建 instance 并 `setMatrixAt(instanceId, matrix)`
  定位后才进入渲染（源码示例 BatchedMesh.js:164-175 明确）。本设计每个 section 恰好
  一个 geometry + 一个 instance（1:1），instance 矩阵 = section 世界偏移的平移矩阵。
  首次实现若漏掉 instance 层会"加了 geometry 但画面什么都没有"。
- 布局：**每通道一个 BatchedMesh**（opaque/cutout/transparent 各一），每个 section 占一个
  geometry slot + 一个 instance。视距 8 全场景 = **3 个 render item**，GPU drawIndexed
  命令数 = 可见非空 section 数（数百量级，命令间零状态切换）。
- **构造容量预估（v1.6 纠正过度预留）**：`new BatchedMesh(maxInstanceCount, maxVertexCount,
  maxIndexCount, material)`。
  - `maxInstanceCount`：视距 8 = 289 column × 8 section = 2312 slot/通道，取 2312 × 1.2
    （instance 元数据是矩阵纹理，便宜）。
  - `maxVertexCount`/`maxIndexCount`：**按"预期活跃非空 section 数/通道 × 平均 section
    顶点数 × 1.25"预估，不是按全部 2312 slot**（v1.5 公式会数倍过度预留显存：按 P95 8k
    顶点算，2312×8000×1.25×24B ≈ 555MB/通道，与 §4.10 的 ~100MB 总口径矛盾）。
    视距 8 典型活跃非空 section：opaque ~800、cutout ~300、transparent ~100；
    opaque 通道约 800×4000×1.25×24B ≈ 96MB，与 §4.10 吻合。
  - 运行时用 `unusedVertexCount`/`unusedIndexCount` getter（BatchedMesh.js:316/328，已核验）
    监控余量；满了走 `setGeometrySize` 整批扩容重建兜底（低频）。
- 视锥剔除：`perObjectFrustumCulled = true`（默认值，per-instance 包围盒剔除，r185.1 内置），
  剔除粒度 = section（16³ AABB），比 column 级更细。
- 增量替换：`setGeometryAt(geometryId, geom)` 原地替换 slot 内容（**超出预留会 throw**，
  见下方溢出处理）；`setVisibleAt(instanceId, visible)` 控制可见性（卸载/LOD 切换）。

**fallback：column 级 3-group 合批（候选 A，仅当 BatchedMesh 实测不达标时启用）**

- 每 column 一个 Mesh，缓冲区 **channel-major 布局**：opaque/cutout/transparent 各一段，
  **恰好 3 个 geometry group**（section 在各通道内是连续子区间）。
- **draw call 陷阱（3-group 语义必须写死）**：three.js `Renderer._projectObject`
  （r185.1 Renderer.js:3149-3158，已核验）在 material 为数组时**每个 group 各 push 一个
  renderList 条目**，即每 group 一次 draw。若按 8 section × 3 通道切成 24 个 group，
  每 column 是 24 次 draw（289 × 24 ≈ 7000 次），比每 section 一个 Mesh 还差。
  只有 channel-major 3-group 才能拿到每 column ≤3 draw（视距 8 上限 289×3≈867，
  **固定 ~867**——`_projectObject` 不看 group.count，空通道也照样入 render list，
  v1.5 写的「实际 300~500」低估了，v1.6 纠正为固定 867 上限）。
- 注意：three.js 对透明 object 排序、不透明按深度排序，column 级 object 数 289 本身不是
  问题，问题只在 group draw 数——实现时不要误判。

**M1 决策门（确认而非选型）**：默认 BatchedMesh；仅当实测出现以下情况才退回候选 A——
① BatchedMesh 的逐 instance JS 循环 draw 提交在目标硬件 p95 反而比候选 A 的固定
   867 条 group draw 更差；
② `setGeometryAt` 增量替换有正确性坑（版本/可见性竞态）；
③ `onBeforeRender` 的逐 instance 剔除/排序 CPU 循环（~2312 instance，sortObjects 默认
   true 不透明通道也每帧排序）吃掉 120fps 帧预算。
对比口径不变：120fps 基线下放挖压力场景的 p95 帧时。
**选型理由（v1.6 重写）**：BatchedMesh 与候选 A 的 draw 数量同量级（数百 vs 固定 867），
但 BatchedMesh 循环内所有 drawIndexed 共享同一 pipeline/bind group/顶点缓冲、命令间零
状态切换，空 section 零命令，剔除/排序/增量更新官方内置——综合单命令成本与工程复杂度占优。

**变长 section 的打包策略（优先用官方 API，不再手工造轮子）**：

单块编辑重建后该 section 顶点数会变。v1.2 手工设计的「slot 预留 + offset 表 + repack」
恰好就是 BatchedMesh 官方 API 的语义，直接用官方实现：

- **预留**：`addGeometry(geom, reservedVertexCount = 实际顶点数 × 1.25, reservedIndexCount 同理)`。
- **增量写回**：重建后若未溢出预留区间，`setGeometryAt(geometryId, newGeom)` 原地替换
  （内部走 `addUpdateRange` 增量上传）。**注意**：`setGeometryAt` 在新 geometry 超出
  该 slot 预留区间时**直接 throw**（"Reserved space not large enough"，源码核验），
  故调用前必须先比对顶点/索引数与 reserved。
- **溢出处理（v1.5 纠正 setGeometrySize 语义错误）**：单 slot 溢出**不能**用
  `setGeometrySize`——它是**整批缓冲重建/收缩**，且当现有用量超过目标容量时直接 throw，
  不是单 slot 扩容。正确的单 slot 溢出路径（源码核验 BatchedMesh.js:825 deleteGeometry
  会级联删除关联 instance）：
  1. `deleteGeometry(geometryId)`（自动级联删该 section 的 instance）；
  2. `addGeometry(newGeom, reservedVertexCount = 新顶点数 × 1.25)` 拿新 slot；
  3. `addInstance(newGeometryId)` + `setMatrixAt` 重建 instance。
  单块编辑极少连续溢出，此路径摊销成本可忽略。整批容量不足（addGeometry throw）时才
  重建整个 BatchedMesh（低频）。所有重建结果携带 column.version，回传时版本校验，
  原子切换，无视觉空洞。
- 候选 A（若启用）保留 v1.2 的手工 offset 表 + 整列 Worker repack 方案作为对照实现。

**其他约束**：

- **纠正一个前提**："WebGPU 每 draw 的 CPU 成本远低于 WebGL"不成立——three.js 的
  WebGPURenderer 在 pipeline/bind group 哈希与 render list 排序上的每 draw CPU 开销
  通常不低于 WebGL。draw call 数量必须作为一级约束控制，不能指望后端红利。
- **历史参照的适用边界**：本仓库上一版 TS 实现（a7feb44^，已清空）验证过 120fps，
  但它当时只流式加载约 3 个垂直 section；新设计是 8 个 section，工作量约 2.67 倍，
  其结论只能作为量级参照，M1 必须重新跑基线确认。
- `RenderSectionPool`（缓冲/geometry 复用）只省 CPU 分配与 GC，**不省显存**；
  显存控制靠滞回卸载 + 重入 LRU（§4.9/§4.10）。

**4.4.3 天空/雾/日夜**
- 移植 mc-lite Engine 的三套视觉风格（morning/overcast/night）、TSL 天空盒、色调映射与色相偏移。
- 雾距与视距联动配置（mc-lite 硬编码 FOG_NEAR=30/FAR=70，新引擎按 `renderDistance × 16` 推导）。

**4.4.4 阴影**
- 主方向光 + 跟随玩家的阴影相机（沿用 mc-lite 的 requestShadowMapUpdate 按需刷新思路），
  shadow camera 覆盖半径 = 视距的 60%，贴图 2048。
- 投射/接收由 BlockRegistry 属性驱动（实心不透明投射，玻璃/花草不投射），白名单逻辑与 mc-lite 对齐。

**4.4.5 LOD 预留（第一阶段只留接口，不实现）**
- `MeshingRequest` 带 `lod` 字段；RenderTree 按 `(cx,cz)` 聚合，
  未来视距 > 12 时外圈可切换为 4×4 column 合并的粗网格（只保留高度表层 + 结构轮廓）。
  默认 BatchedMesh 路径下 LOD 切换 = 外圈 section slot `setVisibleAt(false)` +
  粗网格 geometry `setGeometryAt` 换入（或独立 LOD BatchedMesh），接口天然兼容。
- 第一阶段视距 8~10 不需要 LOD，但数据/调度接口按此预留，避免二次重构。

**4.4.6 WebGPU 唯一后端（渲染基线）**

新引擎以 `WebGPURenderer` 为**唯一**渲染后端（three/webgpu 构建，TSL 可用），
**第一阶段不做 WebGL2 降级**。理由：

- WebGPU 覆盖面已足够：Chrome/Edge（2023+）、Safari 26（2025）均原生支持；
  Firefox 141 仅 Windows 默认开启，macOS ARM 要到 147，Intel Mac 需手动 flag——
  但目标用户（自己玩 + 小范围分享）以 Chrome/Edge/Safari 为主，实际影响可忽略；
- mc-lite 已在 r184 验证 WebGPU 主路径可行，无需再背兼容包袱；
- 核心架构（逐面网格化、section mesh、TSL NodeMaterial）在 WebGPU 上是原生最优路径，
  砍掉 fallback 不动摇任何架构决策；
- 双后端的渲染正确性/性能/材质行为双重验证成本是实打实的负担，砍掉即减负。

启动时做 WebGPU 能力检测（`navigator.gpu` gate），不支持则显示明确提示
（"请用支持 WebGPU 的浏览器打开"），不做静默降级。该 gate 不锁死架构，
未来如需 WebGL2 兜底仍可后补（NodeMaterial 双后端通用）。

mc-lite 已在 r184 完成 WebGPU 迁移（含 renderAsync），mc-heavy 直接站在 r185.1 上，
并显式利用以下能力：

- **显式管理 draw call（不是指望后端红利）**：纠正一个常见误解——three.js 的
  WebGPURenderer 在 pipeline/bind group 哈希与 render list 排序上的每 draw CPU 开销
  通常**不低于** WebGL。WebGPU 的真正优势在于命令缓冲的批量提交与更少的驱动状态切换，
  但 draw call 数量仍必须作为一级约束：这正是 §4.4.2 采用 BatchedMesh 通道级合批发布
  （而非每 section/column 一个 Mesh）的原因。
- **renderAsync 异步渲染循环**：帧循环用 `renderer.setAnimationLoop` + async 语义，
  渲染提交与主线程调度解耦，配合 §4.9 帧预算控制器。
- **BufferAttribute.addUpdateRange(start, count)**：section 网格重建后只上传变化段，
  避免整缓冲重传（r185 正式 API；BatchedMesh 的 `setGeometryAt` 内部即走此路径）。
- **TSL NodeMaterial**：天空、水面、雾、色调映射全部用节点材质实现
  （mc-lite 的 TSL 水面/天空盒方案整体移植，r185 节点库更完整）。
- **frustumCulled + 预计算包围盒**：section 包围盒在 meshing 时算好随缓冲回传。
  默认 BatchedMesh 路径用内置 `perObjectFrustumCulled`（per-section 剔除，零运行时计算）；
  fallback 候选 A 逐 column（16×16×128 AABB）。
- **预留（第二阶段+）**：compute shader 做 GPU 驱动剔除/LOD 选择、indirect draw 进一步
  压缩 draw 提交。注意 r185.1 的 WebGPU 后端对 BatchedMesh **不是** multi-draw/indirect
  提交（v1.6 核验，§4.4.2），这条路真要压缩命令数得自己做，第一阶段不引入。

兼容性基线：仅支持原生 WebGPU 的浏览器（Chrome/Edge/Safari 26；Firefox 视平台而定，不作承诺）。
HUD 显示当前后端为 WebGPU；不支持时启动 gate 拦截并提示。

### 4.5 玩家与交互（src/player/）

**4.5.1 物理**
- 移植 mc-lite Physics 的 AABB 碰撞语义（0.6×1.8×0.6 玩家盒、台阶/云块特判等），
  但碰撞查询全部走 `world.isSolid()` typed 读路径。定步长 60Hz 累加器，渲染帧率与物理解耦
  （120Hz 屏幕不会让移动速度翻倍——mc-lite 已有帧率无关动画修正，延续）。

**4.5.2 体素射线（替换 THREE.Raycaster）**
- Amanatides-Woo DDA 体素遍历：`world.raycast(origin, dir, maxDist)`，
  O(距离) 次 `getBlockId`，40 格射线约 60 次查表（mc-lite 的 mesh 求交是数万次矩阵运算）。
- 返回 `{ hit, blockPos, normal, prevPos }`：挖掘用 blockPos，放置用 prevPos。
- 每帧最多 1 次主射线 + 少量实体射线（子弹，第二阶段）。枪的 40 格 far 语义保留。

**4.5.3 方块编辑管线（唯一写入口）**

```
world.setBlock(x, y, z, id, meta)
  1. column.blocks[idx] = id；meta 写入；column.version++
  2. column.edits.set(idx, {id, meta, blockEntity?})  ← 持久化层（blockEntity 见 §4.1）
  3. 标记受影响 section dirty（见下方最坏范围定义）
  4. 快速路径：同步重建几何实际变化的 section（单块 < 2ms）
  5. 光照增量更新（§4.6，异步）
  6. 事件广播：'block-changed'（物理/实体/音效/粒子订阅）
```

**边界方块编辑的最坏重建范围（必须写死）**：位于 section 角上的方块最多影响 8 个 section
（AO 是对角 1 格依赖）。若快速路径全量同步重建 8 个 section，最坏 8×2ms=16ms，
直接爆 120fps 帧预算。规则：
- **快速路径只同步重建几何实际变化的 section**（面增删只发生在正交相邻 section，
  通常 1~2 个，<2ms）；
- **仅受 AO 影响的对角 section 置脏走精修路径**（Worker MESH，1 帧内收敛——
  AO 延迟一帧肉眼不可见），与 §4.3 halo 协议「对角 AO 是永久近似」的口径一致。

批量编辑由 `WorldEditor.setBlocks(batch)` 协调 `WorldData.setBlocks(batch)`：每个有效格仍写入
`column.edits`，每个变更 column 仅递增一次版本，合并脏 section，并对变更 column 与边界邻居
入 `scheduler.enqueueLight()`；批量路径跳过快速路径、统一走 Worker REMESH，主线程只做调度与
缓冲替换。mc-lite 的 batchFaceCullingTimeout / isBatch 补丁语义被原生吸收。该能力由第二阶段
M4 玩家武器先行实现，也同时是 TNT/爆炸的共享入口；M4 的范围、DDA 与受控资产约束见
`docs/superpowers/specs/2026-08-23-m4-player-weapons-design.md`。

**4.5.4 背包/快捷栏**：第一阶段实现创造模式无限背包（mc-lite 默认 1500 格语义），
物品 = BlockRegistry 条目 + 少量工具项。UI 移植 mc-lite Inventory 的 DOM 方案。

### 4.6 光照与 AO（src/mesh/lighting.js，Worker 侧）

第一阶段模型（对齐 mc-lite 的视觉效果，补齐其缺失的体素光照）：

- **AO**：经典四角 AO（移植 AOUtils 的 side/corner 判定），meshing 时计算，无独立 AO Worker/脏集——
  mc-lite 的 AOWorker/AOBridge/AONodeSystem/dirtyAOPositions 整套删除，
  因为 AO 在新管线里是 meshing 的免费副产品。
- **skylight（v1.9：第一阶段不启用阳光遮挡投影）**：`computeSkylightColumn` 恒写 15，
  悬挑/洞穴下不产生阴影；视觉明暗只来自 **AO 墙角阴影 + 日夜全局调制**（对齐 mc-lite
  视觉基线；实玩验收驱动的产品决策——遮挡阴影在大悬空平台下产生大片全黑 + 截断渐变，
  用户明确不要）。**机制完整保留**供后续阶段启用：遮挡模型 = ① 垂直 pass 15 遇 opaque 停
  ② 水平 BFS 每格 -1（原实现 `computeSkylightColumnOccluded`）；区域重算（light 任务）=
  中心 column + 4 正交邻居，5-column region 对中心列充分（15 的光水平最远影响 14 格）。
  **写回协议（中心权威，v1.8）**：每列 light 只由以它为中心的 task 写回；邻列只参与计算
  不写回（只置脏重 mesh）——旧「写回全部 5 列 last-write-wins」会让 region 不完整的后到
  task 覆盖邻列已收敛的好光（blocklight 黑核根因）。第一阶段 skylight 恒 15 时该检测
  （空气格 skylight=0）恒不触发，light 任务仅由编辑触发。
  **编辑快路径**：`recomputeSkylightAt` 单列 O(128) 置 15（守 2ms 预算）。
- **blocklight**：emissive 方块（灯/萤石/岩浆，移植 LightSourceManager 的方块清单）
  做 flood fill（强度 15 逐级 -1 衰减）。**放置**光源用增量 BFS 即可；
  **删除**光源时的降光是全流程最难的一步（需撤销传播路径），第一阶段不追求增量删除，
  采用**全 column 重算**（或小半径局部重算）兜底，增量删除 BFS 明确放到后续阶段。
  注意重算范围必须覆盖**该 column + 4 个邻 column**（光会泄漏过界），
  否则挖掉贴边光源后邻柱残留亮度。重算触发相关 section 精修重建。
- 视觉效果上保留 mc-lite 的 PointLight 挂灯方案作为**可选增强**（镜面高光），
  但基础照度不再依赖它，避免光源数量增长拖垮渲染。

### 4.7 水面与特效

- **全局海面**：移植 mc-lite 的 800×800 水面平面 + TSL 波纹/边缘淡出 shader，
  跟随玩家平移（海面是平面不是体素，成本 O(1)，这是 mc-lite 做对的地方，保留）。
- **体素水**（swamp_water/河流湖泊）：transparent 材质组，meshing 时只生成与水/空气交界的面，
  顶面按邻居水位降低高度（简单水面高度图，避免 Z-fighting）。
- **雨效与天气状态机（M3-3，v1.15 增补）**：`render/weather.js` 晴 → 雨 → 晴随机周期状态机
  （晴 60~180s / 雨 30~90s / 过渡 5s 线性淡入淡出，intensity∈[0,1] 为唯一消费口径；
  force 手动覆盖与自动周期共用过渡语义，判档一次锁定）。`render/rain.js` 移植 mc-lite
  `src/world/effects/RainEffect.js`：LineSegments 每滴 2 顶点，下落/循环全在 TSL 顶点阶段
  （`(uTime×speed×speedScale+phase) mod cycleHeight`），主线程只做 30Hz 距离检查 +
  64 滴/帧分批雨幕迁移（削峰）；`world.isSolid` 向下搜索 56 格做地面截停（雨滴不穿地）。
  视觉参数冻结：267 滴 / 半径 18 / 速度 24 / dropLength 0.5 / opacity 0.6。
  intensity=0 时 LineSegments 隐藏（省 draw）。不引入 mc-lite 没有的天空压暗/雾距联动。
### 4.8 持久化（src/save/）

```
IndexedDB（沿用 mc-lite DB 名/版本约定）
  ├─ meta:    { seed, spawn, schemaVersion, savedAt }
  ├─ edits:   chunkKey → 压缩的修改列表（仅玩家改过的方块，条目 {id, meta, blockEntity?}，
  │           典型 KB 级/column；blockEntity 为可序列化对象，第一阶段恒为 undefined）
  ├─ player:  位置/朝向/背包（第二阶段；设置持久化已改落 localStorage，见 v1.15 ②）
  └─ entities:（M5 起：炮塔/矿车等持久运行时实体 snapshot；丧尸为临时实体，
                丧尸巢穴的锚点/冷却归对应 blockEntity）
```

- 写盘完全异步：edits 在内存中按 column 聚合，防抖 5s + 页面隐藏/退出时 flush（Worker 内序列化）。
- 加载 = 读 meta + 按需读 edits（column 生成时叠加），无"整图恢复"阶段。
- mc-lite 老存档迁移：提供一次性迁移脚本（第二阶段），读旧 region 记录提取 blockData diff。
- **M5 持久实体与流式卸载**：column 首次超出“加载半径 + 2”时，Scheduler 创建可取消的 pending
  unload；`EntityManager` 冻结该 column 的持久实体并把最小 snapshot 写入 `entities`。这段时间 world、
  render column 与临时实体仍保留。写入成功后的下一帧若仍超界，才同步通知 controller、失效实体 generation、
  回收实体并删除 column；写入失败或玩家重入则取消、解冻并保留一切运行时 state。pending 只记录 key/handle，
  不缓存 blocks/meta/light 或产生第二份世界数据。

### 4.9 调度与帧预算（src/core/scheduler.js）

**主线程每帧固定流程**：

```
1. input → player.step(定步长物理)
2. 世界调度：按玩家位置计算目标 column 集合（视距 + 2 生成提前量）
   - 新 column → 发 GEN 任务（Worker 池，按距离优先级）
   - GEN 完成 → 主线程接管数据（Transferable 零拷贝）→ 发 MESH 任务
   - MESH 完成 → 进入上传队列
   - 卸载走滞回带（见下方"卸载与重入"）
3. 帧预算消费（硬上限，超支顺延下帧）：
   - mesh 上传：≤ 3ms/帧（约 2~4 个 section 的增量段，默认 BatchedMesh 路径走
     `setGeometryAt` 增量替换；fallback 候选 A 按 section 区间写回）
   - 快速路径重建：≤ 2ms/帧（玩家操作优先，可透支单帧）
   - 光照增量：≤ 1ms/帧
4. 实体/特效 update（第一期为空/轻量）
5. render
```

- **版本协议**：所有异步任务携带 `(columnKey, columnVersion)`，结果回传时版本不匹配即丢弃。
  这是 mc-lite 用十几个补丁（assemblyEpoch/sourceEpoch/staging buffer/原子切换）才逼近的机制，
  新引擎作为基础设施一次做对。

- **卸载与重入（滞回 + LRU，v1.3 补齐）**：玩家在加载半径边界来回走（很常见）会造成
  GEN/MESH/上传全链路 thrashing。两条便宜规则：
  - **卸载半径 = 加载半径 + 2（滞回带）**：进圈立即加载、出圈延迟卸载；
  - **持久实体卸载门（M5 起）**：超出半径的含持久实体 column 先进入可取消的异步保存准备；在 snapshot
    成功的下一帧、且仍超界时才同步最终移除。准备时重入或写盘失败均取消/解冻并保留 column，不能把
    IndexedDB Promise 塞进最终移除通知或让失败后仍删除。
  - **重入 LRU**：刚卸载的 column 保留体素数据与 GPU 缓冲在短 TTL 缓存
    （5~10s 或 1~2 圈内存配额，先到先踢），重入时零成本恢复，跳过 GEN+MESH+上传。
    edits 本来就常驻，这条只多占一点显存，换来回头跑不卡。
  - 卸载的邻接副作用：column 卸载后，邻居边界 section 里「因它存在而被剔除的面」不会
    立即重 mesh——最外圈被雾遮住，可接受；玩家回移时由 GEN 就绪触发重 mesh 收敛
    （与 §4.3 第 3 条呼应）。
- **高刷适配**：渲染循环用 rAF 原生节奏（120Hz 设备自然 120 帧），
  物理/调度按 dt 归一；预算常量按 8.3ms（120fps）帧间隔标定，保证高刷下仍有帧内余量。
- **HUD 性能面板**：移植 mc-lite 的打点体系（ChunkPerfMonitor 思路），
  输出 GEN/MESH 队列深度、上传耗时、section 数、draw call、帧时分布——性能验收靠它说话。
- **世界数据看板 + 调试开关（`src/core/debug-config.js`）**：HUD 追加体素/面剔除/合批统计区
  （方块数、候选面、出块面、剔除面与剔除率、3 通道 BatchedMesh 的 slot/顶点、draw call、
  锥内三角/总三角），2s 异步刷新（非实时，守帧预算）。统计采集由 `DEBUG_FLAGS.worldStats`
  统一门控：开发调试期默认开；URL `?stats=0` 关闭（对照基线用）。关闭时 mesher 热循环跳过计数、
  scheduler/renderWorld 不存统计、HUD 不显示世界数据区。开关经 `debug-flags` broadcast 同步 Worker，
  与主线程快速路径同构生效。`DEBUG_FLAGS.statsLog`（URL `?log=0` 可关）随 HUD 同节奏
  console.log 精确数值行 + 原始统计对象（无鼠标选取环境读数据用）。
  draw call/三角读 `_lastRenderInfo`（render 后快照），
  避免异步读撞上 three `info.autoReset` 每帧清零。

### 4.10 内存预算（视距 8 基线）

| 项 | 估算 | 说明 |
|---|---|---|
| 体素数据（CPU） | ~37 MB | 289 column × 128KB（blocks Uint16Array 64KB + meta/light 各 32KB；保留 Uint16 为 >255 方块留余量） |
| GPU 顶点缓冲 | **~100 MB 级（大头）** | 活跃 section 平均几十~几百 KB，城市区更重；视距 16 会到数百 MB |
| atlas 纹理 | ~22 MB | 2048² RGBA + mipmap 链 |

- GPU 顶点缓冲是内存大头，且随视距近似平方增长。**显存控制靠滞回卸载 + LRU 兜底**
  （§4.9：出圈 +2 滞回带延迟卸载，重入 LRU 短 TTL 保留缓冲，LRU 满则真正释放），
  不靠池化——`RenderSectionPool` 只省 CPU 分配与 GC，**不省显存**。
- 视距 16 前必须先做 §4.4.5 的 LOD（外圈粗模），否则显存与 draw call 双双失控。
- edits 稀疏层常驻内存（卸载 column 时序列化进 IndexedDB 后可释放），典型 KB 级/column。

---

## 5. 目录结构

```
mc-heavy/
├─ index.html                  # import map（three@0.185.1 webgpu）+ 启动
├─ docs/
│  └─ phase-1-engine-design.md # 本文档
├─ tools/
│  └─ build-atlas.mjs          # 纹理 atlas 离线打包脚本
├─ assets/
│  ├─ textures/                # 从 mc-lite 复制（保持文件名）
│  ├─ atlas.png + atlas.json   # 生成产物
│  └─ structures/              # 从 mc-lite 复制 JSON 结构
└─ src/
   ├─ core/        # Game.js(主循环) Engine.js(渲染器/相机/天空) scheduler.js worker-pool.js perf.js
   ├─ voxel/       # block-registry.js chunk-column.js world-data.js edits.js
   ├─ gen/         # noise.js biome.js terrain.js structure-index.js structures/*.js（Worker 同构）
   ├─ mesh/        # mesher.js（Worker/主线程同构） lighting.js section-mesh.js atlas.js
   ├─ render/      # render-world.js sky.js water.js shadows.js materials.js
   ├─ player/      # player.js physics.js raycast.js interaction.js inventory.js
   ├─ save/        # persistence.js codec.js
   ├─ ui/          # hud.js hotbar.js inventory-ui.js
   └─ workers/     # world-worker.js（GEN/MESH/LIGHT 统一入口，池化）
```

与 mc-lite 的关键差异：没有 FaceCullingSystem / ChunkConsolidation / BlockScatterManager /
GlobalInstancedMeshManager / WorldBoundsController / WorldGenerationService(预生成) /
AOBridge / AOWorker / 八个 Worker 文件——它们的职责被 §4 的四个子系统吸收。

---

## 6. 关键设计决策记录（DR）

| # | 决策 | 备选 | 理由 |
|---|---|---|---|
| DR-1 | 删除预生成，纯按需生成 | 预生成提速/分区懒加载 | 生成是确定性的，预生成是冗余计算；按需生成 + 提前量调度后边界问题不存在 |
| DR-2 | 逐面网格化 + 纹理 atlas | 沿用 InstancedMesh 优化 | 单位面积三角形数平均降 2~4×、理论上限 6×（全立方 12 tri/块 → 暴露面 2~8 tri/块），配合合批发布（DR-11）把 draw call 压到数百级，是视距扩展的根本前提 |
| DR-3 | section(16³) 为网格单元 | 整 column 网格 | 单块修改重建成本 < 2ms，当帧生效；column 级重建需 5~15ms 且上传体积大 |
| DR-4 | 体素 DDA 射线 | 优化 Raycaster（BVH 等） | 体素世界射线有解析解，O(距离)；任何 mesh 求交方案都是数量级劣势 |
| DR-5 | 单 Worker 池多任务类型 | 每类专属 Worker（mc-lite 8 个） | 池化消除"AO Worker 空闲而生成排队"的负载不均；任务同构代码复用 |
| DR-6 | edits 稀疏层 + terrain 可再生 | 存全量 chunk 数据 | 存档 KB 级；加载无恢复阶段；天然支持"重生 chunk 不丢修改" |
| DR-7 | 无构建步骤 + 本地 vendor import map | Vite 构建 / CDN import map | 延续 mc-lite 开发体验；three.js r185.1 本地化（vendor/three/）避免 CDN 网络依赖，离线可用 |
| DR-8 | 世界高度 128（-32..96） | -16..112 / 64 / 256 | 兼容 mc-lite 坐标（结构零改造移植）；128 对齐 8 个 section 整除；内存 128KB/column 可控；下界 -32 给地形填充（最低 h-12，h 下界约 -16 → 最低块 -28）留足余量，避免截断 |
| DR-9 | 纯 JavaScript + JSDoc，不用 TypeScript | TS + 构建工具链 | 与 mc-lite 技术栈一致，零迁移成本；无编译环节，Worker/主线程同构代码直接共享；类型表达靠 JSDoc + ESLint 足够 |
| DR-10 | WebGPU 唯一后端（three r185.1），不做 WebGL2 降级 | WebGPU 优先 + WebGL2 兜底 | 目标用户全在现代浏览器，fallback 收益趋近于零；mc-lite 已验证 WebGPU 主路径；砍掉双后端的正确性/性能双重验证负担；架构不被锁死，未来可后补 |
| DR-11 | 渲染发布粒度：section 重建、BatchedMesh 通道级合批（默认，M1 实测确认；fallback 为 column 3-group） | 每 section 独立 Mesh / column 3-group 为默认 | v1.6 纠正 v1.3 的核心口径：r185.1 **WebGPU 后端对 BatchedMesh 不走 multi-draw**（WebGPUBackend.js:1806-1824 JS 循环逐可见 instance 发 drawIndexed；renderMultiDraw 只在 WebGL 后端），故 draw 数量与候选 A 同量级（数百 vs 固定 867），选型理由是**单命令成本低一个量级**（循环内共享同一 pipeline/bind group/顶点缓冲、命令间零状态切换、空 section 零命令）+ 剔除/排序/增量更新官方内置。geometry+instance 两层结构（漏 instance 层不渲染）；构造函数只接受单 Material（BatchedMesh 无 groups，传材质数组零 render item）；`reservedVertexCount`/`setGeometryAt` 覆盖 slot 打包，单 slot 溢出走 deleteGeometry→addGeometry→addInstance（`setGeometrySize` 是整批重建/收缩会 throw，非单 slot 扩容）；per-instance 视锥剔除与 `sortObjects` 运行时排序内置。section 独立 Mesh 视距 8 上限约 3600 draw 不可接受；column 3-group（固定 ~867，`_projectObject` 不看 group.count）仅作实测不达标时的 fallback。three.js WebGPU 每 draw CPU 开销不低于 WebGL，draw call 必须一级管控；material 数组逐 group 发 draw（Renderer.js:3149-3158 已核验），fallback 必须 channel-major 3-group 布局 |
| DR-12 | 跨 region 结构：邻区索引查询（本 region + 8 邻区） | 地标加硬 margin 禁止跨界 | 地标中心偏移 100~400 + 半尺寸 40~80 必然跨 400 格 region 边界；硬 margin 会改变与 lite 的世界布局、破坏同 seed 对比；邻区布局同 seed 确定性重算，成本由布局广播（DR-13）兜住 |
| DR-13 | 结构布局单 Worker 算一次、主线程转发广播 | 每 Worker 各持 LRU 缓存 / 主线程直接计算 | City 候选扫描很重：N Worker 重复跑会成为冷启动/进城新卡点，放主线程会卡帧；布局体积小且确定性，单点计算 + 广播成本可忽略；GEN 任务依赖布局就绪（最多 9 份邻区布局） |
| DR-14 | 第一阶段**不启用阳光遮挡投影**：skylight 恒 15，视觉明暗 = AO 墙角阴影 + 日夜全局调制（v1.9 产品决策）；遮挡模型（垂直 pass + 水平 BFS）与 light 任务中心权威写回机制保留，后续阶段启用 | 高度图以下衰减近似 / Minecraft 式遮挡阴影（v1.8） | 高度图衰减在洞穴/悬挑下错误；Minecraft 式遮挡阴影实玩不可接受——大悬空平台/洞穴下方超扩散距离即大片全黑 + 截断渐变环，与 mc-lite 视觉基线冲突，用户明确不要阳光投影。机制保留：5-column region 对中心列充分（15 水平最远 14 格）；写回 5 列 last-write-wins 会覆盖邻列好光（v1.8 已修，中心权威） |
| DR-15 | 逐面网格化，不用 greedy meshing | greedy meshing | 上一版 mc-heavy（已清空）用过 greedy；逐面在 AO/编辑增量更新/UV 映射上显著更简单，三角形多 2~3× 但当前瓶颈是 draw call 而非三角形（WebGPU 下三角形吞吐充裕）；视距 16+ 若三角形成为瓶颈再评估 greedy 或 LOD |
| DR-16 | 卸载滞回（加载半径 +2）+ 重入 LRU（短 TTL 保留体素与 GPU 缓冲） | 出圈即释放 | 玩家在加载半径边界来回走会造成 GEN/MESH/上传全链路 thrashing；滞回带 + LRU 重入零成本恢复，只多占一点显存，回头跑不卡；显存上限由 LRU 配额兜底（§4.9/§4.10） |
| DR-17 | 权威数据源含方块实体通道：`blocks`+`meta`+`blockEntities` 稀疏 Map；light 为派生缓存非权威 | 富状态塞 meta / 用 InstancedMesh userData 暂存（mc-lite 补丁） | 宝箱库存/告示牌文字/灯开关等富状态塞不进 8bit meta；mc-lite 已有 `_saveChestStates()`（ChunkConsolidation.js:597）证明需求真实，但用 userData 暂存是补丁式实现。做成数据模型一等公民：edits 条目、持久化 schema、重放逻辑现在定形状，第一阶段只预留不实现消费者，避免后续回填引发 schemaVersion + edits 重放二次重构。light 可从 blocks+emissive 重算收敛，不得当真相来源（§4.1） |

---

## 7. 第一阶段里程碑

每个里程碑独立可玩、可验收，全部 TDD（延续 mc-lite 的 Playwright 测试工作流）。

**M0 骨架（0.5 周）**
- 项目脚手架、import map、Worker 池与 RPC、perf 打点、BlockRegistry + atlas 构建。
- **WebGPU 发布路径实测**：① 构造 3-group 单 Mesh 与 24-group 单 Mesh 对比，确认
  WebGPURenderer 逐 group 发 draw 的行为与 CPU 开销（为 fallback 候选 A 的 3-group 写死
  提供实测依据）；② 构造单 BatchedMesh 挂 ~2312 instance，确认 WebGPU 后端逐 instance
  drawIndexed 的真实命令数与 CPU 开销（v1.6 已确认非 multi-draw，此项验证量级）；
  ③ **BatchedMesh 两项 120fps 风险点实测（v1.6 新增）**：~2312 instance 时
  `onBeforeRender` 的逐 instance 剔除/排序 CPU 循环耗时（sortObjects 默认 true，
  不透明通道也每帧排序），以及 `setGeometryAt` 单块编辑的端到端耗时（flat 属性
  array.set 快路径是否真达到 <2ms）。
- 验收：空白场景渲染 + HUD 帧率面板；atlas 覆盖 mc-lite 全部纹理。

**M1 体素核心闭环（1~1.5 周）**
- WorldData/ChunkColumn/edits；地形生成（无结构）；section meshing（快速+精修双路径）；
  玩家移动/物理/DDA 射线/放块挖块；最小存档（edits 读写）。
- **发布层确认门（硬）**：默认实现 §4.4.2 BatchedMesh 通道级合批（含 `reservedVertexCount`
  预留 + `setGeometryAt` 增量替换落地）；在同一放挖压力场景下对比 120fps 基线的 p95 帧时，
  仅当逐 instance draw 提交 p95 更差、增量替换有正确性坑、或剔除/排序 CPU 循环吃帧预算时，
  才退回候选 A（column 3-group）。
- 验收：平原地形无限行走不掉帧；放块挖块当帧生效；重启后修改保留。

**M2 结构与世界完整性（1~1.5 周）**
- StructureIndex + 城市/金字塔/冰封山/雪地/海岛/树木移植；悬浮空岛与云层；biome 全量；洞穴；
  光照（skylight/AO/blocklight）；水面（海面+体素水）；日夜与三种视觉风格。
- 验收：出生点可见城市天际线；地标（含悬浮空岛与云层）与 mc-lite 结构轮廓/配色基调一致（同 seed 同位置截图人工比对，
  不做像素级 diff，因高度与光照模型不同）；
  跨 region 行走无卡顿。

**M3 性能达标与收尾（1 周）**
- 视距 8 全量调优（包含 M2-7 空中结构）；预算参数标定（60Hz/120Hz 双档）；雨效；HUD 完善；
  性能回归基线脚本（Playwright 自动跑图采样帧时）。
- 验收：§1 目标表全部达标；输出性能报告。

> **M4 不属于第一阶段里程碑。** M3 的性能报告与冻结基线验收后，第二阶段按
> **M4 玩家第一人称武器 → M5 实体运行时 → M6 丧尸 → M7 玩家放置丧尸巢穴** 的依赖链推进。
> M4 交付三把受控 GLB 武器、DDA hitscan、视图模型、曳光、音效与可选方块破坏；M5–M7 依次把
> 动态实体、临时敌人与方块锚定刷怪器接入既有数据/事件管线；M5 持久实体先以可取消 snapshot 保存完成
> 卸载准备，才会同步删除 column。M6 默认最多 20 只丧尸，保留
> 25/35/999 的三把枪实体伤害和六部件实例渲染，不新增玩家生命或近战；M7 保留玩家放置/全局 8 个/
> 关键方块失效语义。炮塔飞行弹丸、玩家生存战斗和用户模型导入继续后置。
> 各 Epic 的规格与实施计划见 `docs/superpowers/{specs,plans}/2026-08-23-m4-player-weapons-*`、
> `2026-08-23-m5-entity-runtime*`、`2026-08-23-m6-zombies*`、
> `2026-08-23-m7-zombie-nests*`。

---

## 8. 性能验证方案

- **自动跑图**：Playwright 脚本驱动玩家沿固定路线奔跑（含跨 region、进城市、贴墙转向），
  采集帧时分布（p50/p95/p99）、GEN/MESH 队列、上传耗时，输出对比报告。
  注意：本机（macOS ARM，Chromium 151）实测 Playwright 默认的 headless shell 零 flag
  **拿不到 adapter**，必须用完整 Chromium 新无头模式（`channel: 'chromium'`）才能零 flag
  走 Metal（本地跑图用真 GPU）；Linux CI 无 Metal，用 SwiftShader 组合（`--enable-unsafe-webgpu`
  + `--use-angle=swiftshader`）。CI 上帧率采样不稳定——**CI 自动跑图只作为门禁参考
  （趋势监控），本机设备矩阵才是硬验收**。
- **基线场景**：① 平原冲刺（视距 8）② 城市中心环视（最坏 draw call）③ 连续放/挖 200 块
  ④ 模拟 TNT 批量删除 500 块（M3 用 REMESH 路径验证）。
- **设备矩阵**：本机高刷屏（120Hz 目标 ≥90fps）+ 中端设备 profile（60fps 目标）。
- **视觉对比口径**：与 mc-lite 做**结构轮廓、配色基调**的视觉对比（同 seed 同位置截图人工比对），
  不做像素级 diff——新引擎的高度模型与光照模型与 lite 不同，像素级一致既不现实也不必要。
- 每个里程碑结束跑一次基线，性能回退 >10% 即阻断合入。

---

## 9. 后续功能扩展点（第一阶段只留接口）

| 功能（mc-lite 已有） | 引擎接入点 | 第一阶段预留 |
|---|---|---|
| M4 玩家第一人称武器 | `WorldEditor` + DDA hitscan + 相机视图模型 + 受控 GLB/Audio | 第二阶段首个 Epic；规格/计划见 `docs/superpowers/{specs,plans}/2026-08-23-m4-player-weapons-*` |
| TNT/爆炸 | `WorldEditor.setBlocks(batch)` + REMESH + 粒子 | M4-0 批量编辑 API、事件接口 |
| M5 实体运行时 | EntityManager + 实体 raycast + 受控渲染层 + entities snapshot | 第二阶段实体底座；临时 entity 随 column 的“视距 +2”最终卸载回收，持久 entity 先可取消地冻结/保存最小 snapshot，成功后的下一帧才最终移除；规格/计划见 `docs/superpowers/{specs,plans}/2026-08-23-m5-entity-runtime*` |
| M6 丧尸 | M5 临时 entity + WorkerPool AI + 武器距离比较 + 6 部件 InstancedMesh | 默认 20；20Hz 单 batch AI、60 格外冻结、手枪/加特林/MAG7 为 25/35/999 伤害与 40/40/10 格；不含 PlayerVitals/近战；规格/计划见 `docs/superpowers/{specs,plans}/2026-08-23-m6-zombies*` |
| M7 玩家放置丧尸巢穴 | `WorldEditor` + blockEntities + M6 ZombieService | 最多 8 个，蓝图最高 `gold_block` 破坏即失效（alias 只作最小创造模式放置触发）；8 offset × 六层搜索，`restoreEdits()` 保持 anchor 存档；规格/计划见 `docs/superpowers/{specs,plans}/2026-08-23-m7-zombie-nests*` |
| 炮塔/飞行弹丸 | M5 EntityManager + 实体射线 + InstancedMesh 实体渲染 | M5 后独立 Epic；不属于 M4–M7 |
| 玩家生存战斗 | M5 EntityManager + 玩家状态/HUD + 事件 | 独立 PlayerVitals Epic；定义近战、伤害、无敌、死亡与重生后才实施，不夹带入 M6 |
| 矿车/轨道 | 方块属性（track 类型）+ 实体运动系统 | BlockRegistry 的 `interact`/`onStep` 钩子 |
| 创造台 | 模型编辑 → 注册自定义 geometry 模板 | mesher 顶点模板机制 |
| 灯/光源 | emissive 属性 + blocklight flood fill | 光照管线已含 |
| 床/宝箱/门 | 多方块结构 + 朝向 + 交互钩子 + 富状态（库存/文字） | meta/orientation 位、`blockEntities` 通道（§4.1）、交互事件 |
| 存档迁移 | save/codec 版本字段 | schemaVersion 机制 |
| 音频（挖掘/爆炸/环境音） | AudioManager + 事件订阅 | `block-changed`/交互事件总线（音频挂事件即可） |
| 输入/指针锁定/相机 | InputManager + PointerLock + 第一人称相机 | 第一阶段已实现基础版，后续武器/载具复用 |
| 设置持久化（画质/音量/视距） | save/player 记录扩展 | player 记录已含画质设置字段 |
| 出生点安全选择 | spawn 逻辑（§4.2 已含 dry ground 搜索） | 已实现，后续存档复活点复用 |

---

## 10. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 城市结构移植量大（WorldWorker 3296 行） | M2 延期 | 结构按"候选索引先行、光栅化逐个移植"推进，每移植一个结构跑一次同 seed 结构轮廓/配色视觉对比 |
| WebGPU 在目标设备不可用 | 无法启动 | 启动 gate 检测 `navigator.gpu`，不支持则显示明确提示引导换浏览器；目标用户均在现代浏览器，实际影响面极小；架构保留未来后补 WebGL2 的可能 |
| 120Hz 下主线程余量不足 | 高刷目标落空 | 预算按 8.3ms 标定；上传/光照严格让帧；必要时 section 上传降为隔帧 |
| 老存档不兼容 | 玩家资产丢失 | 第二阶段提供迁移工具；本阶段 meta 保留 worldId/seed 字段对齐 |

---

## 附录 A：与 mc-lite 模块映射表（移植清单）

| mc-lite 模块 | mc-heavy 去向 |
|---|---|
| TerrainGen / MathUtils(noise,biome) | src/gen/noise.js, biome.js（算法照搬，接口重写） |
| workers/maps/*（CityMap/Pyramid/…） | src/gen/structures/*（光栅化接口改造） |
| world/entities/Island.js / Cloud.js | M2-7 `src/gen/structures/sky-structures.js`（确定性 rasterize，非 entity） |
| structure-index/* | src/gen/structure-index.js（整体移植） |
| structures/*.json | assets/structures/（原样复用） |
| BlockData.js | src/voxel/block-registry.js（数据化重写） |
| AOUtils.js | src/mesh/mesher.js 内联（算法照搬） |
| OrientationUtils.js | src/voxel/meta.js + mesher 旋转模板 |
| Engine.js（天空/雾/视觉风格/水面 shader） | src/render/*（移植，参数随视距推导） |
| Physics.js | src/player/physics.js（语义照搬，读路径换 typed） |
| PlayerInteraction.js | src/player/interaction.js（Raycaster → DDA 重写） |
| RainEffect / ParticleSystem | src/render/effects/*（M3 移植） |
| Inventory/HUD/UIManager | src/ui/*（DOM 方案移植） |
| PersistenceService/WorldStore | src/save/*（edits 模型重写） |
| FaceCullingSystem/ChunkConsolidation/BlockScatterManager/GlobalInstancedMeshManager/AO* 全家桶 | **删除**，职责并入 meshing 管线 |
