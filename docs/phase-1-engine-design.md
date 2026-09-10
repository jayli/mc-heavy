# mc-heavy 第一阶段实施设计文档：游戏引擎原型

> 版本：v1.35 ｜ 日期：2026-09-07 ｜ 状态：定稿（经十五轮逐条核验修订 + M3.2 实施回填 + 异形方块渲染勘误 + 背包物品集合口径 + 吊灯材质自发光 + 吊灯 UV 分区 + 背包图标表 + 等轴测图标 + 测试分级策略与静态门禁 + 全量背包图标离线烘焙 + 背包槽位点选抖动修复 + 等轴测图标遮挡修复 + 删除缓存按钮 + 沼泽睡莲水洞与沉水修复 + AO 去掉对角门控 + 设置面板两列布局与档位精简）
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
> `restoreEdits()` 同时恢复 blockEntity 与内存 edits，防止后续 flush 覆盖旧存档。玩家生存战斗
> 保持独立后续 Epic（**v1.16 勘误**：本句原写「背包、完整 Hotbar 与玩家生存战斗均保持独立
> 后续 Epic」，与 §4.5.4 冲突；背包与完整 Hotbar 已定稿归 M3.1，推迟范围收窄为生存战斗与
> 物品消耗规则，详见 v1.16 修订说明）。

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

> v1.16 修订说明：**消除背包归属的口径矛盾并定稿 M3.1**（2026-09-02）。v1.12 曾写「背包、
> 完整 Hotbar 与玩家生存战斗均保持独立后续 Epic」，而 §4.5.4 同期写「第一阶段实现创造模式
> 无限背包」——二者冲突，且 M3-4 实施时按 v1.12 口径只落地了快捷栏 5 格（展示层 +
> `HOTBAR_ITEMS` 常量数组），物品数据模型缺位。本次定稿：① **背包归 M3.1**，插在 M3（已验收）
> 与 M4 之间，§4.5.4 由一句话扩写为完整规格（物品模型、槽位语义、物品集合、DOM 样式表、
> 输入门控）；② v1.12 那句中「背包、完整 Hotbar」的推迟范围**收窄为仅玩家生存战斗与物品
> 消耗规则**（`PlayerVitals`、掉落/拾取、count 递减仍是独立后续 Epic）；③ §4.1 补记
> `BlockRegistry.all()` 遍历接口（背包物品集合构建的唯一消费方，禁入热路径）；④ 修正
> `uiModal` 门控漏洞：模态打开期间 `Player._bindInput()` 的 keydown 不受拦截，M3.1 加守卫，
> 该守卫同时是 M4 Task 6（`KeyR` 切武器挂同一段 keydown）的前置条件。M4 与背包在数据层解耦
> （M4 spec 明确排除「弹药/装填/背包消耗」，武器切换走独立 `WeaponController`），排序依据是
> 共用 keydown 入口的工程效率，非依赖关系。

> v1.17 修订说明：**方块朝向放置交互定稿归 M3.2**（2026-09-02）。v1.16 前 §4.3 写「交互侧放置
> 语义仍属第二阶段」，roadmap 亦记「朝向交互侧暂不实现：第二阶段随床/宝箱/门落地」——即它此前
> **没有排进任何已编号里程碑**（M4~M7 spec/plan 经 grep 核实均不含方块朝向）。本次把它从
> 床/宝箱/门 Epic 中拆出独立实施：① §4.3 新增「朝向放置交互」小节，写完整规格（三分支算法、
> 门控字段复用、Player 两个交互状态、明确不照搬项、对 M4 的影响）；② 实测证据：mc-lite
> `orientationEnabled=true` 与 mc-heavy `orientationModes>0` 的方块集合**完全一致（40 项，零差异）**，
> 故直接复用 `orientationModesTable` 作门控，不新增字段；③ 更正一处此前误述——mc-lite 的放置朝向
> **不按玩家 yaw 计算**（`getPlacementOrientation(x,y,z,type)` 无朝向参数），手感是「原位挖掉再放
> 回去转 90°」，本次照搬；④ §4.1 读路径 API 补 `world.getBlockMeta(x,y,z)`（M4 plan Task 2 亦
> 计划新增，M3.2 提前交付）；⑤ roadmap 第 211 行「朝向交互侧暂不实现」改为已由 M3.2 落地，
> 床/宝箱/门 Epic 范围相应收窄为多方块结构 + `blockEntities` 富状态（朝向已独立交付）。

> v1.18 修订说明：**M3.2 实施回填的两处口径校正**（2026-09-03）。本次为实施期实测发现，
> 不改变 v1.17 的任何设计决策：① §4.3 门控集合的 false 计数勘误——v1.17 写「40 项 true，
> **84 项 false**，零差异」，实测 mc-heavy 侧是 **86 项**（126 方块 vs mc-lite 124；差额为
> M2-7 新增的 `sky_stone`/`sky_grass`，门控均为 0）。**true 集合零差异的结论不变**（各 40 项），
> 门控字段复用决策不受影响；84 是 mc-lite 侧计数，v1.17 误将其当作 mc-heavy 侧数字沿用。
> ② 三分支签名与记忆键的表示口径补记：mc-lite 用方块 **name** 作身份键，mc-heavy 世界权威是
> 数字 **id**，故签名统一为 `getPlacementOrientation(x,y,z,id,...)`、记忆键为 `Map<id, orientation>`
> （id↔name 一一对应，「按方块类型记忆」的语义等价；`registry.idOf(name)` 在 `placeBlock()` 内
> 已取到，无需额外转换）。单测 `src/tests/test-orientation.js` 已钉死 40/86 这两个数字。

> v1.19 修订说明：**异形方块渲染勘误**（2026-09-03，M3.2 收尾后的独立 bugfix）。
> 起因是「vine 向上溢出半格、疑似与 mc-lite 不一致」的观感报告；用 vendored three 精确复现
> mc-lite `geomMap` 几何构造实测包围盒后，发现**三个前提与实测相反**，据此改了 §4.3 三处：
> ① **实例原点换算基准**补记——mc-lite 以块中心为原点（四条放置路径全部 +0.5），mc-heavy 以
> 块底角为原点（0→1），比对时必须 +0.5 换算。此前文档与代码注释均未写明，容易误判几何差异。
> ② **vine 属「双方共同的溢出」而非 mc-heavy 缺陷**：mc-lite `geoVine` 世界 y∈[0.5,1.5]，
> 与 mc-heavy 原实现完全一致；其源码注释「使几何体从y=0到y=1」说的是局部坐标，误导。
> 经确认改为 y∈[0,1] 落在格内——**已知的有意偏离**，§4.3 已标注。
> ③ **床 UV 是真实 bug**：mc-lite 床材质的 `offset`/`rotation` 字段**全仓无消费点**（死字段），
> 实际只生效 `repeat:[1,0.5]` → 采样贴图下半；原实现照字段名与注释实现了「取上半 + 顶面旋转」，
> 而上半实测仅 32 个不透明像素（下半 92），opaque 通道下渲成深色块。已改为 `vLowerHalf` +
> 顶面不旋转。**教训写入 §4.3**：对齐上游须实测其运行时行为，读定义推断会引入回归。
> 附带：hanging_lamp 绳从 0.03 宽 cross 近似改为 `CylinderGeometry(0.015,…,8)` 等价的八段棱柱
> （复用 chimney 同款 `prismQuads`，UV 方向已与 three 实测核对：顶→v=1）。cactus 五盒逐格比对
> 两侧完全一致，未改。

> v1.20 修订说明：**背包物品集合口径变更**（2026-09-03，§4.5.4）。`chimney`（烟囱）移出背包
> 物品集合，**122 项 → 121 项**（填充 121 槽、其余 879 槽留空）。
> ① **不并入 `NON_PLACEABLE_ITEMS`**：该集合语义是「非玩家可放置的功能性方块」，而烟囱
> `solid:true` + 有 `faces-data` + 能放能挖，是正常可放置方块；放进去会让集合语义失真。
> 故新增独立常量 `HIDDEN_FROM_INVENTORY`（语义：可放置但不进背包），二者互斥。
> ② 对齐依据实测核对：mc-lite 背包清单是 `Game.js:206+` **手工列举 107 项**，chimney 不在其中。
> ③ **顺带实测记录两侧集合差异（本次未处理）**：mc-heavy 121 项 vs mc-lite 107 项，差集 16 项
> （含 `sky_*` 等 M2-7 本仓库独有内容、`bed_head`/`bed_tail` 等尚未实施的床 Epic 方块）+
> 反向差集 1 项 `gold`（mc-heavy 无此方块）。详见 §4.5.4 引用块——全面对齐需单独决策，
> 不宜简单删除。
> 附：本次还修了 `tests/m3-2-orientation.spec.mjs` 末尾队列断言的实现缺陷（等待归零后未再次
> 等待就采样，中间同步断言期间世界可能又开始加载 → 概率性读到 `meshInflight=32`；
> 改为再次等待收敛后断言，「无永久积压」语义与检查强度不变）。

> v1.21 修订说明：**吊灯（hanging_lamp）材质自发光**（2026-09-03，§4.3）。新增 packed
> **bit13 = 材质自发光标记**，对齐 mc-lite `MeshStandardNodeMaterial` 的 `emissive` +
> `emissiveIntensity`。
>
> 起因是「吊灯的贴图图案看起来像背包图标贴在方块上」的观感报告。实测核对后确认**根因不是贴图
> 错误**：mc-lite 的 `hanging_lamp` 材质（`MaterialManager.js:1197-1220`）确实有
> `textureGenerator`（画绳/灯体/发光区/高光），世界渲染用了这张程序化贴图；而背包图标
> （`HUD.js:117-152` 的 `generateIcon()`）取的正是**同一个材质**的 `mat.map` —— 即 mc-lite
> 的背包图标与世界贴图**同源同一张**。mc-heavy 的 `bake-procedural-textures.mjs:204-212`
> 逐行复刻了同样的绘制参数，贴图内容一致。
>
> **真实差异是材质自发光缺失**：mc-lite 材质有 `emissive:'#FFE4B5'` + `emissiveIntensity:0.8`
> （灯体看起来发光的暖黄色），而 mc-heavy 三通道材质是 `MeshBasicNodeMaterial`（贴图色 × shade，
> 无自发光）→ 贴图图案静态呈现，观感像「图标贴在方块上」。注意 `blocks-data.js:142` 的
> `emissive:15` 是 **blocklight 光照源**（照亮周围），**不是材质自发光**，两个概念不可复用。
>
> 实测 mc-lite **只有 hanging_lamp 一处**有材质自发光（其余材质 emissive 均为默认 0），故
> **不能给整个 cutout 通道加自发光**（会让 vine/flower/leaves/cactus 全部发光），必须按方块
> 区分 → 用顶点 bit13 传递（详见 §4.3 顶点格式段）。发布粒度不变（红线 5，仍是三通道）。
>
> v1.22 修订说明：**吊灯 UV 分区与 quad 级自发光**（2026-09-03，§4.3）——**已知的有意偏离
> mc-lite**（照 vine 先例）。起因是「绳应为单色深灰、灯体发光、灯面不应有绳图案」的观感要求。
> **实测确认 mc-lite 并非如此**（用 vendored three 实跑几何 UV + Playwright 真实渲染 + 像素级
> 分析定论）：
>
> | 实测项 | mc-lite 实际值 | 出处 |
> |---|---|---|
> | 绳几何 UV | u∈[0,1] v∈[0,1]，**采样整张贴图** | `ChunkConsolidation.js:216-227`（`CylinderGeometry(0.015,0.015,0.4,8)` 实跑） |
> | 灯体几何 UV | u∈[0,1] v∈[0,1]，**采样整张贴图** | 同上（`BoxGeometry(0.3,0.3,0.3)` 实跑） |
> | 贴图布局 | 64×64 canvas：背景 `#aaa49a` 填满全图 + 绳 `#333333`(col30~33,row0~19) + 灯体 `#FFE4B5`(col18~45,row20~47) + 发光区 `#FFF5E6` + 高光 `#FFFFFF` | `MaterialManager.js:1197-1220` |
> | 按部件拆分 UV | **无** —— 四条放置路径只设 position/rotation，不改 UV | `ChunkConsolidation.js:529` / `Chunk.js:2464` / `ChunkGenerator.js:175,224` |
> | 真实渲染的绳色 | rgb(231,224,209) —— emissive 加项淹没贴图图案，绳**不呈深色** | 三样本像素分析（mc-lite 原样 ≡ 纯背景色贴图，证明图案被冲淡） |
>
> 即 mc-lite 的绳采样整张图（含灯体图案）、灯体四个面也采样整张图（含绳图案），且
> `emissive:'#FFE4B5' × 0.8` 的加项把深色冲淡到与灯体同亮。**mc-heavy 此前已逐格忠实复刻
> mc-lite**（几何/UV/贴图/emissive 五项全等，包围盒实测相同），故本次改动即为**偏离**。
>
> 目标外观：绳单色深灰、灯体发光暖黄、灯体四个面不含绳图案。实现见 §4.3「吊灯 UV 分区」。
> **视觉比对 mc-lite 时勿按其原样判定**（与 vine 的 y∈[0,1] 同类：已知的有意偏离）。

> v1.23 修订说明：**背包专用图标表**（2026-09-03，§4.5.4）。起因是「台阶类方块（`planks_step`/
> `cobblestone_step`/`stone_diorite_step`/`cobblestone_step_updown`）的背包图标与其表面贴图完全
> 一样，是一张铺满正方形的贴图，无法从图标上看出横截面阶梯形状，与母方块（`planks`/`cobblestone`
> 等）撞脸」的观感报告。
>
> **根因（实测定位，非推测）**：`tileOfName()` 只查 `faces-data`，而台阶方块在 `faces-data` 里映射的
> 是**母方块贴图**：
>
> | 方块 | `faces-data` 映射 | 后果 |
> |---|---|---|
> | `planks_step` | `planks_birch` | 图标与 `planks` 撞脸 |
> | `cobblestone_step` | `Cobblestone` | 图标与 `cobblestone` 撞脸 |
> | `cobblestone_step_updown` | `Cobblestone` | 同上（且与正置台阶撞脸） |
> | `stone_diorite_step` | `stone_diorite` | 图标与 `stone_diorite` 撞脸 |
>
> **mc-lite 的做法（v1.24 勘误：v1.23 原文有误，勿再引用）**：v1.23 曾写「`HUD.js:117-152` 的
> `generateIcon()` 是『显式图标表 + `switch(name)` 分支』结构，台阶走 `getStepMaterial(name)`
> 换材质（`if (name.endsWith('_step')) return this.getStepMaterial(name)`）」——**这两处论断
> 均不成立**。实测核实（v1.24）：`generateIcon()` **无 `switch`、无任何按 name 的分支**，
> 是统一流程（取 `materials.getMaterial(item)` 的 `map` → `drawImage` 进 32×32 canvas →
> 描边 → `toDataURL` + `iconCache`）；`getStepMaterial` 与 `endsWith('_step')` 在 mc-lite
> **全仓零命中**（`grep -rn` 核实）。
>
> **mc-lite 真正的专用图标机制在 `src/utils/ItemIconUtils.js:11` 的 `getCustomIconPath()`**
> （v1.23 漏查了此文件），是一张 14 项的「方块名 → PNG 路径」表，`createItemIcon()` 命中即
> 直接 `img.src = customIconPath`、否则回落 `HUD.generateIcon()`。台阶 4 项与矿车在该表内，
> **故 v1.23 采纳的 tile 名是对的**，只是机制描述错了——它们来自这张图标表而非
> `generateIcon()` 的分支。mc-lite 贴图目录里确实没有名字带 step/stair/slab 的 PNG，
> 台阶图标是手工绘制的专用图标贴图（这一点 v1.23 无误）。
>
> **关键发现：这些图标早已在 atlas 里躺着，只是没人引用。** 实测 atlas 有 **13 个 orphan tile**
> （`faces-data` 从未引用），其中 5 个正是背包图标：
>
> | orphan tile | 尺寸 | 对应方块 |
> |---|---|---|
> | `Oak_Planks_step` | 16×16 | `planks_step` |
> | `Cobblestone_step` | 16×16 | `cobblestone_step` |
> | `Cobblestone_step_updown` | 16×16 | `cobblestone_step_updown` |
> | `stone_diorite_step` | 16×16 | `stone_diorite_step` |
> | `Invicon_Minecart` | 32×32 | `mine_cart`（此前渲染空槽） |
>
> 像素差异率证实这些确实是台阶图案贴图而非重复的普通贴图（图标 vs 母方块贴图）：
> `Oak_Planks_step` **256/256（100%）**、`Cobblestone_step` 64/256（25%，**后 8 行完全相同、
> 前 8 行重绘**）、`stone_diorite_step` 59/256（23%，同样后 8 行相同）、
> `Cobblestone_step_updown` 218/256（85%，全幅重绘）。
> 「后 8 行保留原贴图、前 8 行重绘」正是台阶横截面的表达方式——下半部是完整方块面、
> 上半部画出阶梯。
>
> 其余 8 个 orphan tile 中，`handrail`/`handrailA`/`handrailB`/`pillar`/`pillar_horizontal`/`turret`
> 是 **128×128 世界渲染贴图**（非图标），`gold`/`leaves_original` 是 16×16 备用贴图。
> mc-lite 只为台阶与矿车做了专用图标，`handrail`/`pillar`/`cactus` 等异形方块**两边都没有图标**。
> 故本次图标表的覆盖范围 = mc-lite 的全部专用图标范围（5 项），不是「所有异形方块」。
>
> **⚠️ v1.24 勘误（上述两条论断均错，勿再引用）**：实测核实 mc-lite
> `src/utils/ItemIconUtils.js:11` 的 `getCustomIconPath()` 是 14 项专用图标表，
> `handrail`/`handrailA`/`handrailB`/`vertical_pillar`/`horizontal_pillar`/`turret_alias_block`
> **都在表内**——即那 6 个 128×128 orphan tile 正是 **mc-lite 的专用背包图标**
> （326×326 PNG 按 128×128 入图、透明背景占 48.5%~69.3%），不是世界渲染贴图；
> 「异形方块两边都没有图标」也不成立。故「覆盖范围 = mc-lite 全部专用图标范围（5 项）」
> 这个推理的**前提有误**，mc-lite 的实际图标范围是 14 项。v1.23 落地的 5 项仍是对的
> （当时只修台阶 + 矿车，属用户指定的范围），但**理由需更正**。这 6 个 orphan tile 在
> v1.24 起由等轴测图标取代（见 v1.24 修订说明）。
>
> 方案取舍（三方案对照页 `src/tests/test-step-icon-methods.html` 实测渲染比对）：
> - **A 用 atlas 现成 tile（采纳）**：资产已就位、零新增文件、走既有 CSS background 裁剪路径、
>   观感对齐 mc-lite。代价是手工贴图需随方块贴图同步维护。
> - B canvas 合成遮罩：自动跟随贴图变化、可扩展到所有异形方块，但假明暗非真实几何光照、
>   观感偏离 mc-lite，且引入运行期合成逻辑。
> - C CSS `clip-path` 裁剪：纯 CSS 零资产，但只有轮廓没有明暗，辨识度最弱。
>
> 实现见 §4.5.4「背包专用图标表」。

> v1.24 修订说明：**异形方块等轴测投影图标**（2026-09-03，§4.5.4）。起因是「`handrail`/
> `handrailA`/`handrailB`/`vertical_pillar`/`horizontal_pillar` 这 5 个非立方体方块在背包里
> 显示为一个铺满正方形的平面贴图，看不出几何形状」的观感报告，并附带要求给出比 mc-lite
> 手工贴图**更优的表达方式**（用户评价 v1.23 的手工图标「虽然可以辨识，但确实有点丑陋」）。
>
> **根因（实测定位，比观感报告更严重）**：这 5 个方块在 `faces-data` 里映射的是
> `procedural/*` 程序化贴图，实测贴图内容**几乎全是纯色底**：
>
> | 方块 | `faces-data` 贴图 | 实测不同色数 | 主色占比 |
> |---|---|---|---|
> | `handrail` | `procedural/handrail` | **2** | rgb(185,142,91) 占 3734/4096 px |
> | `handrailA` | `procedural/handrailA` | **2** | 3429/4096 px |
> | `handrailB` | `procedural/handrailB` | **2** | 3269/4096 px |
> | `vertical_pillar` | `procedural/pillar` | 38 | 3730/4096 px（其余为木纹噪点） |
> | `horizontal_pillar` | `procedural/pillar_horizontal` | 40 | 3724/4096 px |
>
> 故这 5 个图标**不仅看不出形状，彼此之间也几乎无法区分**（三张栏杆贴图只差深色噪点
> 数量、两张柱子贴图只差噪点分布）。观感报告说的「看不出形状区别」成立，实际问题还包含
> 「5 个图标互相撞脸」。
>
> **顺带定位了 v1.23 手工图标「丑陋」的真正根因（用户评价，实测确认）**：mc-lite 的手工
> 图标 PNG 与游戏内方块**颜色不一致**——实测 mc-lite 图标 `handrail.png` 平均色
> **rgb(195,163,5)（金黄色，B 分量几乎为 0）**，而游戏内世界贴图 `procedural/handrail.png`
> 平均色 **rgb(181,138,89)（木色）**；柱子同理（图标 rgb(193,160,9) vs 世界贴图
> rgb(184,141,90)）。即背包里是金黄色栏杆、游戏里放出来是木色栏杆 —— **观感割裂**。
> 台阶 4 项的手工图标（v1.23 采纳的那批 16×16）同样是人手绘制的图案，配色与母方块贴图
> 未必一致。等轴测方案**采样游戏内实际贴图**（`faces-data` 指向的那张），从机制上不可能
> 出现这个割裂——这是采纳等轴测而非沿用手工贴图的第二条理由（第一条是形状信息量）。
>
> **mc-lite 的做法（实测核实）**：mc-lite 的专用图标逻辑在 `src/utils/ItemIconUtils.js:11`
> 的 `getCustomIconPath()`（**不在 `HUD.js`**），是一张 14 项的「方块名 → PNG 路径」表，
> `createItemIcon()` 命中即直接用该 PNG、否则回落 `HUD.generateIcon()`（取材质 `map` 画进
> 32×32 canvas）。**这 5 个方块 mc-lite 确实有专用图标**：`handrail`/`handrailA`/`handrailB`
> → `handrail{,A,B}.png`、`vertical_pillar` → `pillar.png`、`horizontal_pillar` →
> `pillar_horizontal.png`。实测这些 PNG 是 **326×326 透明背景手工图标**（透明像素占
> 48.5%~69.3%、2192~4859 种颜色），与 `faces-data` 引用的 `procedural/handrail`（64×64、
> **仅 2 种颜色**、世界渲染贴图）是**两套同名但完全不同**的 PNG。
> mc-lite **没有**等轴测/离屏渲染缩略图机制。**故本次仍是 mc-heavy 的独立改进**
> （用户明确要求比 mc-lite 手工贴图更优的表达），但理由不是「mc-lite 无图标」而是
> 「mc-lite 的手工贴图观感不佳」——**已知的有意偏离**（与 v1.22 吊灯 UV 分区、§4.3 vine
> 同类），视觉比对 mc-lite 时勿按其原样判定。
>
> **关键论据：形状的唯一权威已存在，图标不得有第二份几何定义。** 这 5 个方块的几何
> 已完整定义在 `src/mesh/mesher.js` 的 `TEMPLATES`（§4.3，逐格复刻 mc-lite `geomMap`）：
> `handrail` = 中柱 0.5² + 东/北把手（3 个 `boxQuads`）、`handrailA` = 柱 0.3² + 全长 X 横杆、
> `handrailB` = 柱 0.3² + Z 横杆 0.5 长、`vertical_pillar` = `boxQuads(0.35,0,0.35,0.65,1,0.65)`、
> `horizontal_pillar` = `boxQuads(0,0.35,0.35,1,0.65,0.65)`。**图标烘焙脚本必须 import
> `TEMPLATES`，禁止手写第二份几何定义**（红线 1 精神：数据只有一份权威）——几何改了图标
> 自动跟着改，不会出现「图标与真实形状不符」的静默偏差。
>
> **渲染算法（原型实测验证）**：2:1 等轴测投影 + 逐像素深度测试 + 三面明暗 + 按局部 UV
> 采样贴图 + 透明背景：
>
> ```
> 投影:  sx = x - z,  sy = (x+z)/2 - y      （2:1 等轴测，图标惯例）
> 深度:  x + y + z                          （视线方向 = 投影平面法线 (-1,-1,-1)）
> 可见面: 只取 +X(0) / +Y(2) / +Z(4) 三个朝向观察者的面
> 遮挡:  逐像素深度测试（重心插值真深度，z-buffer 语义）；排序仅决定深度并列时的胜负
> 明暗:  +Y 顶面 ×1.0、+X 侧面 ×0.75、+Z 侧面 ×0.55
> 贴图:  重心坐标插值 quad 的 UV → 采样源 PNG（nearest）
> 背景:  alpha=0 透明（形状轮廓可见，不铺满正方形）
> span:  包围盒归一化系数 1.12（形状占约 89% 画布）
> ```
>
> **深度与遮挡口径（v1.28 修，勿照旧文档口径实现）**：曾写 `x+z-y`（y 符号反了）+ painter
> 整面覆盖 → 异形方块（台阶/栏杆/柱子）的面重叠时遮挡判定反了，被遮住的面反而覆盖可见面。
> 详见 v1.28 修订说明。**面平均深度只能用于排序，不能用于遮挡判定**。
>
> **明暗系数是「UI 图标惯例」，不是世界渲染的 shade 口径**：世界渲染的 shade 是
> `light × AO`（§4.3 顶点阶段 float varying），背包图标不参与光照系统，用固定三面系数
> 表达立体感。二者不可复用（与 §4.3 吊灯 `emissive:15` blocklight 源 vs 材质自发光的
> 区分同理）。
>
> **原型实测结果**（32/64px 双档均验证）：
>
> | 方块 | 不透明占比 | 不同色数 | 形状辨识度 |
> |---|---|---|---|
> | `vertical_pillar` | 37.8% | **53**（保留木纹噪点） | 竖长柱体 |
> | `horizontal_pillar` | 34.1% | — | **横扁横梁**，与竖柱一眼可分 |
> | `handrail` | 52.4% | 7 | 中柱 + **两侧把手突出** |
> | `handrailB` | 37.9% | — | 中柱 + 短横杆 |
> | `handrailA` | — | — | 中柱 + 全长横杆 |
> | `planks_step` | 56.5% | 25 | **L 形阶梯轮廓清晰** |
>
> 等轴测投影能一眼区分这 5 个形状（竖长/横扁/双侧把手/全长横杆/短横杆），且台阶的 L 形
> 立体轮廓比 v1.23 的平面横截面图案信息量更足。
>
> **端到端视觉验证**（截图在本环境无法目视——Read 只返回 URL 不渲染成图像，故改用
> 像素级实测代替，与 v1.22/v1.23 同口径）：逐槽位图标元素截图 → canvas 读像素 →
> 轮廓包围盒 + 行分布剖面。**判据是「图标形状必须与 mesher `TEMPLATES` 几何定义对应」**：
>
> | 方块 | 包围盒 | 填充% | 上部宽/下部宽 | 对应几何定义 | 判定 |
> |---|---|---|---|---|---|
> | `vertical_pillar` | 13×29 | 32.1 | 9.6/9.6 | `boxQuads(0.35,0,0.35,0.65,1,0.65)` 全高 0.3 宽 | ✓ 竖长 |
> | `horizontal_pillar` | 29×21 | 33.5 | 9.6/9.6 | `boxQuads(0,0.35,0.35,1,0.65,0.65)` 全长 X 0.3 高 | ✓ 横扁 |
> | `handrail` | 27×29 | 47.9 | 11.9/11.9 | 中柱 0.5² + 东/北把手 | ✓ 把手额外覆盖 |
> | `handrailA` | 25×29 | 37.4 | **12.7/9.6** | 柱 + 全长 X 横杆（上部更宽） | ✓ 上下不对称 |
> | `handrailB` | 15×29 | 33.0 | **10.3/9.6** | 柱 + Z 横杆 0.5 长（比 A 窄） | ✓ 上下不对称 |
> | `planks_step` | 29×29 | 55.5 | **11.7/13** | `STEP_QUADS` 下半全幅 + 左上 1/4 柱 | ✓ 底宽顶窄 |
> | `cobblestone_step_updown` | 29×29 | 55.5 | **13/11.7** | `STEP_UPDOWN_QUADS` 上半全幅 + 右下 1/4 柱 | ✓ 顶宽底窄 |
> | `stone`/`planks`（对照） | 32×32 | **100** | 32/32 | 无模板 = 单位立方体 | ✓ 铺满正方形 |
>
> 最强一条：`planks_step` 与 `cobblestone_step_updown` 的行剖面**完全相反**（11.7/13 vs
> 13/11.7）→ 正置/倒置台阶图标形状与几何定义严格对应，不是「恰好看起来不同」。
> `handrailA`（全长横杆 12.7）比 `handrailB`（0.5 长横杆 10.3）上部更宽 → 横杆长度差异
> 在图标上可辨。对照组 `stone`/`planks` 填充 100% 而异形方块 32~48% → 透明背景生效、
> 轮廓可见。
>
> **方案取舍（离线烘焙 vs 运行时合成）**：
> - **A 离线烘焙入 atlas（采纳）**：运行时**零开销**（复用既有 CSS background 裁剪路径）、
>   与其余 109 项图标**完全同一条渲染路径**（不引入第二套）、确定性（固定算法无随机）、
>   符合红线 3（重计算离开运行时）。代价：几何变更需重跑脚本 + `npm run atlas`。
> - B 运行时 canvas 合成：几何变更自动生效，但背包打开时要为每个图标合成（118 项）、
>   引入第二套图标渲染路径、违反红线 3（主线程做可后台化的重计算）。
>
> 采纳 A。`mesher.js` 可在 Node 下 import（无 three/DOM 依赖，符合红线 8 同构纯函数），
> 只需给 `TEMPLATES` 加 `export`。透明像素可直接入 atlas——实测 `PNG.bitblt` 保留
> `alpha=0`，`build-atlas.mjs` **无需改动**。
>
> **覆盖范围（9 项）**：`handrail`×3 + `vertical_pillar`/`horizontal_pillar` + 台阶 4 项
> （`planks_step`/`cobblestone_step`/`cobblestone_step_updown`/`stone_diorite_step`）。
> 台阶一并换成等轴测以统一表达口径（避免同一背包里「平面横截面图案」与「立体等轴测」
> 两套风格并存）。保持平面贴图现状：`cactus`/`vine`/`lilypad`/`hanging_lamp`/`flower` 系
> 7 个方块；跳过 `chimney`/床三项（不在背包 118 项内，见 §4.5.4 `HIDDEN_FROM_INVENTORY`）。
>
> **`stone_diorite_step` 的 geometry 是 `cobblestone_step`**（mc-lite 同口径，
> `BlockData.js:283` 的 `geometryType: 'cobblestone_step'`，实测核实**非 bug**），但贴图是
> `stone_diorite` → 图标烘焙必须**按方块名组织**：几何查 `BLOCKS[].geometry` 字段、
> 贴图查 `faces-data`，二者不必同名。
>
> **两处既有断言口径变更（随事实更新，非擅自放宽）**：
> 1. `tests/atlas.spec.mjs` 钉死 tile 数 **147 → 156**（新增 9 张图标 PNG）。断言语义是
>    「atlas 覆盖全部纹理」，新增图标 PNG 属覆盖范围的正当扩展；`procCount`（`procedural/`
>    前缀 23）不受影响——新图标放独立目录 `assets/textures/inventory-icons/`，前缀不同。
> 2. v1.23 的 4 个台阶手工图标 tile（`Oak_Planks_step`/`Cobblestone_step`/
>    `Cobblestone_step_updown`/`stone_diorite_step`）改为等轴测后**变成 orphan**（PNG 与
>    tile 都保留、atlas 总数只增不减，只是没有消费方）。`Invicon_Minecart` 仍被引用
>    （`mine_cart` 不在本次 9 项内）。保留理由：删除会让 atlas 计数与 mc-lite 纹理清单
>    口径脱钩，且这些是 mc-lite 的手工图标资产（有对照价值）。
>
> **门禁对照（未凭文档结论免责）**：
> - `npm run lint`：0 error（16 warnings，新增 2 个 camelcase 来自 `vertical_pillar`/
>   `horizontal_pillar` 作对象键，与既有方块名 warning 同性质——`eslint.config.mjs`
>   豁免清单未含 `hotbar.js`，项目接受此类 warning，未擅自改配置）；
>   顺带补配 `createImageBitmap` 全局（标准浏览器 API，图标单测解码 PNG 需它，
>   配置里已有同性质的 `Blob`/`FileReader`/`fetch` → 属漏配而非规则问题）；
> - 浏览器单测 **270 全绿**（257 + 13 新增）；
> - Playwright **44/44**（`atlas.spec.mjs` 计数更新后全绿）；
> - `bench --check` 通过（fps 111.64~120.02、draw 489~545，无回退）；
> - `m1-acceptance` 放挖 p95 首次全量跑失败（`placeP95=2.0` 撞 `< 2` 断言）——
>   **经 HEAD stash 对照各连跑 4 次证实为既有抖动，非本次引入**：
>   HEAD 侧 `2.1/1.9/1.9/1.8`（均值 **1.925**，**3 failed / 1 passed**）、
>   改动侧 `1.7/1.8/1.9/2.0`（均值 **1.85**，**2 failed / 2 passed**）——
>   **HEAD 侧失败率更高、峰值更高（2.1 vs 2.0）、均值也更高**。
>   机制上不可能影响：本次未碰 `mesher.js` 几何（只加 `export`）与 `materials.js`，
>   `atlas.png` 是离线资产不参与编辑快路径（放/挖走 typed array + REMESH）。
>   **教训**：仅凭「全量跑失败 / 单独跑通过」判定不够——全量跑时 `sky-structures` 与
>   `m1-acceptance` 轮换失败，容易误读成「改动侧统计显著」。必须**分开按 spec 连跑
>   拿数值分布比均值与峰值**才能定论。
> - `sky-structures` p95 首次全量跑 23.5（断言 < 16.75）：单独跑 3 次均 16.6/16.7/16.7
>   全通过，HEAD 侧全量同样 16.7 通过 → 全量负载抖动（与 CLAUDE.md 既有记录一致）。
>
> **已知取舍：新增 atlas 目录会重排已有 tile 坐标**。`build-atlas.mjs` 的 `collectPngs`
> 按字母序排序、shelf 装箱，`inventory-icons/` 插入序列 → 实测 `procedural/handrail`
> 坐标 x=672 → x=1280、`procedural/pillar` x=1152 → x=1760（`handrail`/`Oak_Planks_step`
> 所在 shelf 未受影响）。**不影响正确性**（`atlas.json` 同步更新，mesher 读 json 的 UV
> 而非硬编码坐标），但 `atlas.png` 像素内容确实重排、体积 +28KB（229733 → 258628）。
> 若未来有人依赖 tile 坐标做断言，需注意这一副作用。
>
> 实现见 §4.5.4「等轴测投影图标」。
>
> v1.25 修订说明：**测试分级策略与静态门禁**（2026-09-03，M3 收尾后、M4 开始前）。起因是
> 「任何小改动全都用 TDD 驱动，连改一个贴图地址、修正一个 alias 映射都要先写失败测试」——
> 这类改动的正确性肉眼即可判定，TDD 只增加成本不增加保障。分级判据不是「改动大小」也不是
> 「文件位置」，而是**改坏了会怎样、多久能被发现**：
> - **Tier 1**（机制/架构/性能/API/稳定性）改坏了是**静默的数据错误**（AO 算错、面剔除漏面、
>   版本协议竞态、性能回退），肉眼玩不出来、只能靠断言 → **必须 TDD**；
> - **Tier 2**（数据契约/集合口径）改坏了立刻可见（图标空槽、方块消失）、修复成本 = 改回去
>   → **门禁断言，免 TDD 流程**；
> - **Tier 3**（文案/资源引用/观感）→ **免测试**，只需 lint；
> - **Tier 4**（GPU 渲染结果，TSL 节点在 GPU 求值主线程读不到）→ **像素级实测**，不宣称目视。
>
> **核心改造：关系型断言取代硬编码计数**。硬编码计数（`expect(count).toBe(156)`）是
> 「改动放大器」——新增一张贴图就要改 spec + CLAUDE.md + 设计文档**三处**（同一个事实的三个
> 副本，违反红线 1 精神）。改为校验不变式：`atlas.spec.mjs` 的 tile 数改为与
> `assets/textures` 的实际 PNG 数比对（build-atlas 的契约：每张 PNG 打成一个 tile）；
> `m3-1-inventory.spec.mjs` 的物品集合改为 **Node 侧 `buildItemNames()` 与浏览器侧真实
> 背包装配两侧独立计算比对**。实测验证：把 `gold_block` 加进 `HIDDEN_FROM_INVENTORY`
> （118 → 117），**spec 未做任何改动即通过**——旧设计下同一变更要同步改三处文档。
> 保留硬编码的例外是 `size=2048`/`gutter=16` 这类**设计常量**（§4.4.1 定稿）：判据是
> 「这个数是设计决策还是事实统计」，前者钉死、后者用关系式。
>
> **新增两个静态门**（`tools/check-*.mjs`，均经正负向验证）：`check:arch` 守 12 条重构红线中
> 可静态检查的部分（three 隔离用**双层判定**——目录默认 + 自声明一致性，实测精确文件列表会让
> 新增的 `src/mesh/*.js` 绕过检查；禁止类名**只查非注释行**——`mesher.js:51` 引用
> `ChunkConsolidation.js:530` 是算法出处注释必须放行；依赖方向含白名单）；`check:data` 守数据
> 契约（引用完整性 / 物品集合关系式 / 图标同步 / 测试注册完整性）。
>
> **两处文档漂移勘误**（本次 review 发现）：§4.4.1 曾写「atlas 合计 147 tile」而实测 156
> （v1.24 加图标时改了 spec 断言却漏了这句）；roadmap「测试现状」曾写「246 个浏览器内单元
> 测试」而实测 270。两处均改为**指向门禁输出**，文档不再携带硬编码计数。
> 另勘误 CLAUDE.md 的分层声明「`core/` 不依赖 `voxel/`」——与实测不符
> （`game.js`/`scheduler.js` 都 import voxel），`core/` 是**装配层**，依赖任何层合法。
>
> **已知例外（白名单，均注明理由）**：① `mesh/atlas-loader.js` import three——它不是同构模块
> （只被 `core/game.js` 消费，运行时加载 atlas 纹理必然依赖 three），分层归属本应在 `render/`
> 但历史放在 `mesh/`，**不移动**（属架构改动，须设计文档先行）；② `voxel/world-data.js`
> 依赖 `mesh/lighting.js`——红线 11 要求编辑快路径同步重算垂直单列，而 `lighting.js` 是
> Worker 同构纯函数（不 import three、无 DOM），故是**算法依赖不是渲染依赖**，voxel 仍
> 「不知道渲染存在」。把 `recomputeSkylightAt` 挪进 voxel 层属架构改动，须先改本节分层图。
>
> 分级策略的唯一权威是 [`docs/testing-policy.md`](testing-policy.md)，本文档不自述分级细节。
>
> v1.26 修订说明：**全量背包图标离线烘焙**（2026-09-03，§4.5.4）。起因是用户要求「预生成每个
> 方块的立体缩略图，运行时直接引用，简化渲染逻辑」。实测确认思路成立且**运行时确实简化**
> ——我第一轮判断错了（漏了「预生成可以连裁剪数学一起预生成掉」这层）：
> - 旧路径「`tileOfName()` 两级查表 + `tileStyle()` 裁剪数学 + 写 4 个样式属性 +
>   `INVENTORY_ICONS` 例外表」→ 新路径 1 行 `icon.style.background = css`
>   （实测约 91 行 → 1 行，预生成串与旧路径 computed style **逐项相等**，已实测验证）；
> - **按显示尺寸烘焙**（快捷栏 40px / 背包 32px 两套）→ 运行时零缩放、像素风锐利；
> - **独立 `icons-atlas.png`**（1024²，占 29.5%）而非入世界 atlas → v1.24 记录的「新增
>   textures 子目录重排世界 tile 坐标」副作用消失，UI 不必加载 2048² 只为裁图标；
> - 覆盖全量 **118 项**（等轴测 104 + 平面 14）。平面清单 = 非实心方块（用户指定：等轴测
>   立方体对植被/水/云不合适），`mine_cart` 保留 mc-lite 手工图标（实体不是方块）。
>
> **Tier 1 改造（TDD）**：① 采样回调加第三参数 `face` 做**逐面采样**——实测实心 104 项里
> 17 项是多面不同贴图（`grass` 顶绿侧土），旧单面采样会让 `grass` 顶面渲成土色（负向验证：
> 注入「只采 face 0」→ 顶面变土色被抓）；② `cubeQuads()` 复用 mesher 的
> `FACE_VERTICES`/`FACE_UVS`（97 个实心方块无模板 → fallback 单位立方体；红线 1：形状与 UV
> 只有一份权威）；③ 消除 `ISO_FACE_UVS` 第二份副本（实测与 mesher `FACE_UVS` 的 face 0/2/4
> 完全相同）→ 改 import。`mesher.js` 为此导出 `FACE_VERTICES`/`FACE_UVS`（不改几何定义）。
>
> **一个测试弱点（实测发现，已写进注释）**：`cubeQuads` 顶点比对断言钉的是**值**，「手写一份
> 数值完全相同的第二份定义」会通过——它抓的是漂移不是「存在第二份定义」。真正保证来自
> `iso-icon.js` 走 import（结构上不可能漂移：实测改 mesher 的 +X 顶点，`cubeQuads()` 自动跟上）。
>
> **图标过期门禁**：指纹 = 几何顶点序列 + 三个可见面贴图名 + **贴图内容哈希**。实测发现并修掉
> 一个真实缺陷：只钉贴图名会**漏报**「换同名 PNG 内容」（最危险方向）+ **误报**无关方块
> （改 `stone.png` 误报 `mine_cart`，因 faces-data 里 `mine_cart` 的 face0 是 `stone`）。
> 修正后三种失效路径负向验证全过。指纹逻辑放共享模块（烘焙脚本与门禁同一份，红线 1）。
>
> **顺带清掉死资产**：删 `tools/bake-isometric-icons.mjs` + `assets/textures/inventory-icons/`
> 9 张 PNG（零运行时消费方），世界 atlas 156 → **147** tile。`atlas.spec.mjs` 的关系型断言
> 自动跟上（无需改断言）。
>
> **门禁对照（HEAD stash 分开按 spec 连跑拿分布）**：`placeP95` HEAD 侧均值 1.94 / 改动侧 1.92；
> `fastRemeshP95` HEAD 侧 1.14 / 改动侧 1.16——分布重叠、无回退，**未擅改断言**。全量 E2E 两侧
> 均偶发 1 failed 且失败 spec 轮换不同（HEAD: `m3-rain` / 改动侧: `m1-acceptance`），单独跑全绿。
>
> 实现见 §4.5.4「背包图标」。
>
> v1.27 修订说明：**背包槽位点选抖动修复**（2026-09-03，§4.5.4）。起因是用户观感报告
> 「点选一个方块后，下一行方块会下移一两个像素」。根因实测定位（非推测）：`.mc-slot` 是
> `width:48px; height:48px` 且未声明 `box-sizing` → 默认 `content-box`，边框加在尺寸之外，
> 故总盒 = 未选中 52×52、选中 54×54（`.selected` 边框 2px→3px）。`#inventory-grid` 是 grid，
> 行高由内容决定 → 选中格撑高 2px → **该行变高 2px → 下一行整体下移 2px**。
> 修法：`box-sizing:border-box` + 尺寸显式写 **52**（= 改前的等价总盒，故未选中态像素级不变），
> 选中时边框往内吃 1px 而不撑大盒子。`transition: border-color 0.1s` 只过渡**颜色** → 印证
> 边框增粗是无意引入的副作用，不是设计意图。快捷栏无此问题（`hotbar.js` 高亮只改 `borderColor`）。
> **实测验证**（DOM 几何，非截图目视）：HEAD 侧第二行 top 262 → 260（**位移 2px，抖动确认存在**）；
> 改动侧第二行 top 260 恒定、选中第三行后仍未变、第二行 8 个槽位 top 逐项相等 → **零抖动**。
> 顺带实测两条并据此改了代码注释（原注释有一句凭推理写的断言，实测证伪后已删除）：
> 32px 图标在内容区 48/46 两种情况下都放得下；**图标中心始终不偏移**（偏移实测 0/0）——
> 原因是边框四边等宽 → flex 居中的内容区始终居中于外框，故「content-box 下图标中心会随边框
> 增粗偏移」这一推测**不成立**，两侧都不偏移。
>
> v1.28 修订说明：**等轴测图标遮挡修复**（2026-09-03，§4.5.4）。起因是用户观感报告
> 「背包里 `cobblestone_step_updown` 渲染出来的几何形状跟真实方块有出入，看着奇怪」。
> **先核实几何本身没问题**（勿凭观感直接改几何）：与 mc-lite `ChunkConsolidation.js:188`
> `geoCobblestoneStepUpdown` 逐格核对 —— 上半块 `BoxGeometry(1,0.5,1)` translate(0,0.25,0)
> → y∈[0.5,1] 全幅、下半柱 `BoxGeometry(0.5,0.5,1)` translate(0.25,-0.25,0) →
> x∈[0.5,1] y∈[0,0.5]，+0.5 换算后与 `mesher.js` 的 `STEP_UPDOWN_QUADS` **完全相同**。
> 故问题在**图标投影算法**，不在几何。两个 bug：
>
> **① 深度度量的 y 符号反了。** 投影轴 u=(1,0,-1)、v=(0.5,-1,0.5) 叉乘得投影平面法线
> `(-1,-1,-1)` → 视线从 (+,+,+) 看向原点 → **正确深度 = x+y+z**。代码用的是 `x+z-y`，
> 与正确度量差 `2y`，对只在 y 上不同的两点判定**完全相反**（`(0,1,0)` vs `(0,0,0)`：
> 判成 -1 < 0 = 高处更远）。**实心方块长期不暴露**：三个可见面互不重叠，排序不影响结果；
> 异形方块的面会重叠 → 错度量直接导致遮挡判定反了。
>
> **② painter 用「面平均深度」排序，对被整片遮住的面无能为力。** 决定性对照（实测）：
> 真顶面（y=1）现度量 depth=0.00、下半柱顶面（y=0.5）depth=0.75 → **判定被遮住的面更近**。
> 该柱顶面被上半块**完全遮住**（x/z 范围完整覆盖它）→ 现实中根本看不见，但
> `VISIBLE_FACES` 只按面索引过滤、不知道它被遮挡，照样发射，且平均深度更大 → painter
> 把它画在柱侧面之后、覆盖掉本该可见的柱侧面，渲成一片亮楔形（顶面 shade 1.0 最亮，
> 柱侧面 0.75/0.55）。这就是「形状看着奇怪」的来源。
>
> **只改度量不够**（实测，三方案逐面占据像素对照）：
>
> | 方案 | 柱顶面占据像素（32px） |
> |---|---|
> | ① 现状：错度量 + painter | **88px**（幻影） |
> | ② 仅改度量 + painter | **仍 88px**（幻影未消失） |
> | ③ 正确度量 + 逐像素深度测试 | **4px**（仅深度并列的边界残留） |
>
> 故两处一起改：`isoDepth(x,y,z)=x+y+z` + `scanFill` 加逐像素深度测试（重心插值每个像素的
> 真深度，与 GPU z-buffer 同语义）。排序仍保留（`>` 而非 `>=` → 深度并列时后画的不覆盖先画的，
> 保持 painter 既有语义）。
>
> **blast radius 实测**（未凭推测）：异形方块 10 项内部面归属修正、**轮廓 alpha 差异全为 0**
> （`cobblestone_step_updown` 179px / `cactus` 149px / 台阶×3 各 76px / `handrailA` 30px /
> `handrailB` 27px / `handrail` 23px / `horizontal_pillar` 13px / `vertical_pillar` 1px）；
> 实心方块 94 项最大色差异 **5px**、轮廓零变化（三面不重叠，排序本就无关）。
> 按方块单独 hack 做不到 —— 那会在 `TEMPLATES` 之外开第二份形状权威（违反红线 1）。
>
> **TDD（Tier 1：纯函数算法）+ 两条互为镜像的回归防线**。RED 阶段 3 个新用例全部失败
> （实测数值与断言一致：88px 幻影、depth 0.75 > 0.00）。判据用恒色贴图下的三面亮度反推
> 像素归属（顶面 100 / +X 75 / +Z 55），无需暴露面占据统计。两条断言合起来才精确表达正确语义
> —— 单独任一条都能被「全砍顶面」或「全留顶面」的粗暴修法骗过：
> - 「倒置台阶下半部不得出现顶面」（幻影消失：88px → 4px）；
> - 「正置台阶阶梯踏面必须保留」（`planks_step` 的柱顶面在 y=1，是**外部面** = 阶梯踏面，
>   修正后反而露出更多：84px → 109px）；
> - 「屏幕位置最高的顶面 depth 最大」（钉深度度量方向，防写回 `x+z-y`）。
>
> **像素级验证**（截图在本环境无法目视）：烘焙产物行剖面 `planks_step` 上部 18.2 / 下部 21.0
> （底宽顶窄）、`cobblestone_step_updown` 上部 21.0 / 下部 18.2（顶宽底窄）→ 与
> `STEP_QUADS` / `STEP_UPDOWN_QUADS` 几何定义严格对应，且二者互为镜像。
>
> **门禁对照**（未凭文档结论免责）：`npm run check` 通过（arch 全绿 + data 7 项契约一致，
> 含**图标过期指纹**确认已重烘同步 + lint 0 error、9 个既有 camelcase warning）；单测
> 270→**273**（+3）全绿；`bench --check` 通过（fps 111.02~120、draw 489~545，基线文件未被覆写）。
> Playwright 全量 43 passed / 1 failed（`m1-acceptance` 的 `placeP95`），经 **HEAD stash 对照
> 各连跑 8 次**：HEAD 侧 `1.8,1.7,1.7,1.9,1.9,1.8,1.8,1.8`（均值 **1.80**）、改动侧
> `2.0,2.3,2.2,1.6,1.8,1.9,1.8,1.9`（均值 **1.94**）—— **后 4 次两侧分布完全重叠**，
> 改动侧偏高集中在前 4 次，峰值 2.3 仅 run2 出现一次；`digP95` 两侧几乎相同。机制上不可能影响：
> `grep -rn "iso-icon" src/ui src/core src/render` **零命中** → 运行时不加载该模块
> （只被离线烘焙脚本 `tools/bake-icon-atlas.mjs`、单测、指纹门禁引用）。
>
> v1.29 修订说明：**设置面板「删除缓存」按钮**（2026-09-04，§4.8）。起因是用户要求在配置面板
> 增加一个「删除缓存」按钮。先澄清语义再动手（用户提问「点随机种子是不是就等于缓存全清了」）：
> 不是 —— `newWorld` 只清 edits，**保留 meta**（seed/spawn）且**完全不动 localStorage**。
> 项目里真正存在的本地持久化只有两处（grep 确认无 service worker / Cache Storage）：
> IndexedDB `mc_heavy_saves` 的 `edits` + `meta` 两个 store，与 localStorage
> `mc_heavy_settings_v1`。故「删除缓存」与「新世界」**语义不重叠**，二者区别如下：
>
> | | seed | edits | localStorage 设置 |
> |---|---|---|---|
> | 新世界（`newWorld`） | **换新** + 写回 meta | 清空 | 不动 |
> | 删除缓存（`clearSave`） | **保留** | 清空 | 不动 |
>
> 用户选定「只清存档改动（保留 seed）」→ 重载后地形回到该世界的**未修改原始版本**
> （红线 2：地形只由 seed 决定，edits 是叠加层）。实现上把 `newWorld` 原有的三步竞态防护
> 抽成 `Game._discardEdits()`，与 `clearSave` **共用一份** —— 写两份会漂移（红线 1 精神）。
> UI 侧为破坏性操作加 **armed 二次确认**（第一次点击只切到「确认删除？」，第二次才执行；
> 打开面板时复位，防 armed 态跨会话残留）。
>
> **竞态防护的实测口径修正（勿照推理实现）**。原注释写「不清内存 edits 就会被
> `beforeunload → flushNow` 写回」，**实测证伪了它的强度**：对照脚本只差一个变量
> （reload 前是否 await flushNow）—— 给卸载事务一点时间（多一次 evaluate 往返）确实写回
> （`savedColumns` 0→1）；紧跟 `location.reload()` 立即卸载则事务来不及提交就被中止、读回 0。
> 故该缺陷在生产路径上**时序不定**，端到端断言会碰巧读到 0 而让缺陷静默逃逸
> （负向验证实测：注释掉 `col.edits.clear()` 后 E2E 仍全绿）。
> **正确门禁 = 内存侧断言**：`tests/clear-save.spec.mjs` 直接断言 `_discardEdits()` 后
> `memEdits===0 && savedColumns===0 && editsCache.size===0`。负向验证实测：移除该步后
> 内存断言 FAIL（Received 1）、端到端断言仍 PASS → **印证两条断言的职责分工**。
>
> **另两处测试缺陷（RED 阶段实测暴露，均非产品 bug）**：
> ① 地形指纹不能用 `i += 997` 步长采样（`m3-hud`/`persistence` spec 的口径）—— 那边是
> 「换 seed」场景（整片地形全变）。本场景只改**一格**，采样和不变（实测基线与改动侧同为
> 50533）→ 改全量求和；② 导航监听必须在 click **之前**武装：`waitForLoadState('load')`
> 写在 click 之后会踩竞态（导航未开始 → 看到「当前页已是 load 态」立即返回 → `READY` 在
> **旧页**本就为真 → 读到 clear 之前的世界），表现为四项断言通过、只有 fp 多出一个
> stoneId（实测差值恰为 **48** = `stoneId`）。
>
> **门禁对照**（未凭文档结论免责）：`npm run check` 通过（arch 全绿 + data 7 项契约一致
> + lint 0 error、9 个既有 camelcase warning）；核心回归 7 passed
> （`clear-save` 2 + `m3-hud` 3 + `persistence` 2，`newWorld` 重构未破坏）。全量 44 passed /
> 2 failed（`m1-acceptance` 的 `placeP95`、`structure-gen` 的 `gen p95`），**交替对照实测
> 两侧分布重合**：改动侧 `1.7/2.0/1.9/1.8`（2 轮 4 次：3 通过 1 失败）、HEAD 侧
> `2.0/1.7/1.8/1.9`（1 通过 3 失败 —— **HEAD 侧失败率反而更高**）；`structure-gen` 两侧
> 各 3/3 全通过。机制上不可能影响：`clearSave`/`_discardEdits` 只在点击时执行一次，
> **不进主循环**（无热路径改动 → 不需 `bench --check`）。
>
> v1.30 修订说明：**沼泽睡莲（lilypad）水洞与沉水修复**（2026-09-05，§4.3）。用户报告两个
> 视觉缺陷：① 睡莲「镶嵌在沼泽水中」—— 自身无水、周围一圈水包围，像水洞而非浮在水面；
> ② 睡莲叶面与沼泽水方块**底面**对齐 → 沉在水面之下。用户同时提出修复思路（生成高度 +1
> 且叶面下移半格贴合水面）—— **思路可行，数值经实测验证正确**。
>
> **根因是两个独立问题，实测确认**（诊断脚本，落点 `(-600,-270)`，SEED=12345）：
>
> | 问题 | 位置 | 实测数据 |
> |---|---|---|
> | ① 水洞 | `apply.js:206` `setBlock(wx, SEA_Y, wz, 'lilypad')` | `fillColumn` 水面填充区间 `(h, SEA_Y]` → 沼泽落点 h=-3 时 **`y=-2` 就是最高一层水格**，被 lilypad 覆盖 → 该格水消失、四周水还在。附带：`lilypad.solid=false` → 玩家踩上去掉进洞里 |
> | ② 沉水 | `mesher.js` `TEMPLATES.lilypad` y=0.02 | 叶面 = 实例原点(块底角 -2) + 0.02 = **-1.98**；暴露水面顶面 = `(SEA_Y+1)` − `WATER_SURFACE_SINK`(0.5) = **-1.50** → 低 **0.48** |
>
> **为什么 mc-lite 沉水更严重却没被发现**：其实例原点 = `Math.floor(y)+0.5` = 块**中心**
> （`Chunk.js:2474`，对照 CLAUDE.md「+0.5 换算」口径），几何 `translate(0,-0.48)` →
> 叶面世界 y = **-1.98**，沉在整格水面顶面 -1.0 之下 **0.98**（mc-lite 自身即有此缺陷）。
> mc-heavy 的水面下沉 0.5 把差距缩到 0.48，反而更扎眼。且 mc-lite 的 lilypad 是**装饰实体**
> （`EntityManager.js:412`）**不占体素格** → 天然无水洞；是 mc-heavy 搬成体素方块才引入的。
>
> **修复须两处耦合改，单独改任一处都错**（只改几何 → 悬空半格；只改格位 → 贴块底仍沉水）：
> 模板 y `0.02` → `-0.48`，生成格位 `SEA_Y` → `SEA_Y+1`。详见 §4.3 lilypad 段。
>
> **落点判定的方法论坑（诊断实测，勿照直觉选测试落点）**：`pointContext` 里 city/island/
> pyramid/plainLand/snow/fm **六个地标判定都在 water 分支之前**，被地标吞掉的点 `ctx.kind`
> 不是 `'water'` → 根本不放 lilypad。实测只按「biome=SWAMP + h<SEA_Y + rand<0.08」三条件筛出
> **12 个候选点**，完整 GEN 后 **落地 0 个**（全被 clay/sand 地标方块覆盖）。必须复现优先级链
> 才能找到真实落点 —— 首个真实落点是 `(-600,-270)`。
>
> **Tier 1 门禁（`mesher.js`/`apply.js` 均在 testing-policy §2.1「纯函数算法」明确列举）**：
> 4 个新测试 RED → 验证 RED → GREEN（**277/277 全绿**）→ **双向负向验证**：
> 回退生成格位（`SEA_Y+1`→`SEA_Y`）→ 2 个生成侧测试 FAIL（均 `Expected 2(water), got
> 27(lilypad)`）而 mesher 几何测试 PASS；回退模板 y（`-0.48`→`0.02`）→ 3 个几何/高度测试
> FAIL 而「生成位置」测试 PASS。两侧各自独立钉住自己的不变式，职责分工清晰。
>
> **自查发现自己测试的恒真弱点并修掉（负向验证的第二轮）**：初版「叶面高度」测试把生成格位
> **硬编码**为 `SEA_Y + 1` 来算 `lilyY`，而这正是 `apply.js` 里写入的值 → 测试与被测代码
> **共用同一个假设**。实测证实弱点：回退格位到 `SEA_Y` 后该测试**仍 PASS**（拿硬编码值算出
> 「叶面 -1.48 > 水面 -1.50」）→ 缺陷静默逃逸。改为**从实际生成数据里扫描出 lilypad 的真实
> 格位**再算高度，并加「水面格 y=SEA_Y 须仍是水」前置断言。重做负向验证：回退格位后
> **两个**生成侧测试都 FAIL（强化前只有 1 个）。这是 CLAUDE.md「对照脚本与被测代码必须只差
> 一个变量」同一原理在**测试内部**的体现，判据见 testing-policy §2.5。
>
> **Tier 4 像素级实测（用户报的是视觉 bug，单测数值对不等于渲染呈现对）**：睡莲贴图主色
> `rgb(34,139,34)`（51% 不透明）作像素基准，传送到落点上方 6 格垂直俯视截图。**担心的风险**：
> `ocean.js` 无限海面平面在 y=-1.5、`renderOrder=1`（体素透明通道之后绘制）、
> `depthWrite=false`，而叶面在 -1.48 只高出 0.02 → 若海面盖住 cutout 通道的 lilypad，
> 单测全绿但玩家仍看不到睡莲。实测**未盖住**（lilypad 在 cutout 通道写深度）：
>
> | | 格位 | 画面中心睡莲绿 | 全画面 |
> |---|---|---|---|
> | HEAD（旧） | `atSea=lilypad / atSeaPlus1=air` | **30**/14641（0.20%）| 1752 |
> | 改动侧 | `atSea=water / atSeaPlus1=lilypad` | **266**/14641（1.82%）| 5243 |
>
> 中心区域 **8.9 倍**差异：HEAD 侧睡莲沉在水下（y=-1.98）被水体遮挡只剩残影。断言 `>100`
> 在 HEAD 侧 FAIL(30)、改动侧 PASS(266) → **像素断言有真实区分度，非恒真**。
>
> **文档同步**：§4.3 新增 lilypad 有意偏离段（第 ④ 项）+ 顶点模板清单 y 值勘误；
> CLAUDE.md「三处已知有意偏离」→ **四处**、新增「lilypad 几何与格位耦合」活跃约束；
> 两处「`structures/*.json` 原样复用」约定（CLAUDE.md + 附录 A 映射表）标注 `big_house.json`
> **唯一例外**。
>
> **全量门禁**：`npm run check` 全绿（check:arch + check:data 8 项契约 + lint 0 error /
> 9 个既有 camelcase warning）。`npm test` **45 passed / 1 failed**，失败的是 `m1-acceptance`
> 的 `placeP95`（CLAUDE.md 点名的已知贴线 flaky）。**交替对照实测**（各连跑 3 次，阈值是
> 冻结断言故未放宽）：改动侧 `placeP95 1.9/1.6/1.7`（**全部 <2ms 通过**，1 次全绿、2 次失败
> 均为 `frameMs.p95` 贴 16.7±1e-6）、HEAD 侧 `placeP95 1.8/1.9/2.0` + `digP95 2.0/2.1/1.9`
> （**3/3 全部失败**）。**HEAD 侧失败率 100% > 改动侧 33%**，且失败断言位置在轮换
> （placeP95/digP95/frameMs.p95 都出现过）→ 非本次改动引入。机制上不可能：改动只碰 GEN 期
> 格位与几何 y 值，**都不进主线程每帧热路径**（无热路径改动 → 不需 `bench --check`）。

> v1.31 修订说明：**AO 去掉对角门控**（2026-09-05，§4.3）。用户报告实玩观感缺陷：方块两个
> 面（如东+南）都是墙角时，两条阴影各沿凹角向外**垂直延伸**，而**东南对角的地面格完全不
> 参与** → 阴影在对角处断开，露出一条「阴影的边」。用户明确希望消除该断层。
>
> **根因实测定位（未猜）**：`mesher.js` `getAO` 的对角门控 `const c = (side1 || side2) ?
> (corner ? 1 : 0) : 0`（mc-lite `AOUtils.getAOValue` 逐行一致，Minecraft 原版语义——对角
> 方块物理上不太遮挡该顶点，故两侧都开阔时对角遮挡不计入）。隔离场景实测（y=0 整片地面 +
> `(8,1,8)` 单个墙角块 B）：
>
> | 地面格 | 相对 B 方位 | 靠 B 那两角 AO |
> |---|---|---|
> | `(9,0,8)` | 东 | **2**（有阴影）|
> | `(8,0,9)` | 南 | **2**（有阴影）|
> | `(9,0,9)` | **东南对角** | **3**（全亮，断层成因）|
>
> **同一空间顶点 `(9,1,9)` 在不同 quad 里 AO 不一致**（块 `(9,0,8)` 顶面算 2、块 `(9,0,9)`
> 顶面算 3）—— 这是断层的直接机制证据（AO 逐顶点写入，共享顶点各块各算一份）。
>
> **修复**：去掉门控 → `return 3 - (side1 + side2 + (corner ? 1 : 0))`。实测对角格该顶点
> AO 由 3 → **2**，同一空间顶点在所有 quad 统一为 2，阴影连成环。
>
> **已知的有意偏离 mc-lite（第 ⑤ 项）**：副作用是**全局**的，不只墙角 —— 所有「两侧开阔、
> 仅对角遮挡」的顶点都会暗一档（悬浮方块斜对角、台阶斜接处等），原版 Minecraft 故意让这些
> 不变暗。实测副作用范围有限（多数对角遮挡都伴随至少一侧遮挡）。**视觉比对 mc-lite 时勿按
> 其原样判定**。
>
> **Tier 1 TDD**（AO 属 testing-policy §2.1「纯函数算法」，改坏了是静默视觉错误）：
> 新测试「AO 仅对角遮挡顶点 AO=2」RED → 验证 RED（`Expected 2, got 3`，用例数 277→278
> 确认已注册在跑）→ GREEN（**278/278 全绿**）。断言刻意避开两个恒真陷阱（§2.5）：
> ① 期望值 2 由「3 − (0+0+对角遮挡1)」手算得出，**非**硬编码被测代码写入的值；
> ② 按「位置 + 顶面 face 位」定位顶点而非依赖顶点序，并断言**跨 quad 一致**。
> **踩坑记录**：首版断言误用世界坐标定位顶点，而 `positions` 是 **section 局部坐标**
> （mesher 推 `lx/ly/lz`）→ 前置断言 `count>=3` 拿到 0，得到的是「定位失败」而非「AO 失败」
> —— 这不是有效 RED。改为显式推导 `lyTop = y0 - WORLD_MIN_Y + 1` 后才拿到真实 RED。
>
> **Tier 4 像素实测**（`tests/ao-corner-visual.spec.mjs` + fixture `src/tests/test-ao-corner.html`）：
> 取样点由 fixture **投影世界坐标**暴露（`window.__AO_PROJ__`），spec 不硬编码像素位置。
> **取样必须紧邻角顶点** —— AO 逐顶点插值，顶面**中心**是四角平均（≈2.75），信号被稀释
> （首版取顶面中心 → `ratio=0.994` 恒真，无区分度）。断言用「同相对位置的开阔对照」
> （`(5,5)` 角同样位置但四周无遮挡 → 恒 AO=3）排除「靠近格角本身就暗」的混淆变量：
>
> | | `nearCorner` | `controlCorner` | 比值 |
> |---|---|---|---|
> | HEAD（门控）| 69.23 | 64.87 | **1.067**（无阴影，比对照更亮）|
> | 改动侧 | 55.22 | 64.87 | **0.851**（有阴影）|
>
> 约 **19%** 差异，HEAD 侧 FAIL、改动侧 PASS → 像素断言有真实区分度、非恒真。
> **被否决的一条断言（记录以免重犯）**：曾试图断言「穿过 `z=9` 块边界的扫描线亮度连续」，
> 实测 `maxJump=0.1399` FAIL —— 但这**不是 bug**：块 `(9,0,8)` 沿 `x=9` 边有**两个**暗角
> （`(9,1,8)` 被 side 遮挡 + `(9,1,9)` 对角），块 `(9,0,9)` 只有**一个**对角暗角 → 跨界亮度
> 回升是**正确行为**，不是断层伪影。改为断言「阴影梯度延伸进对角格内部」。
>
> **门禁**：`npm run check` 全绿（0 error / 9 个既有 camelcase warning；图标指纹检查通过 →
> **无需重跑 `npm run icons`**，图标烘焙不吃 AO）。`npm test` **46 passed / 1 failed**（新增 ao-corner-visual spec 后用例数 45→46），
> 失败的仍是 `m1-acceptance` 的 `frameMs.p95`（`16.700000762939453` vs 门限 16.7，超出
> **7.6e-7**，即 float32 表示 16.7 的下一个可表示值）。**交替对照**：HEAD 侧连跑 3 次
> **同样失败、数值完全一致** → 与本次改动无关（v1.30 修订说明已记录同一现象：HEAD 侧失败率
> 100%）。改动侧 bench **`--check` 通过**（fps=120、draw call 489~545 与基线一致）—— mesher
> 属热路径故按门禁分层加跑。

> v1.35 修订说明：**设置面板改两列布局 + 精简档位**（2026-09-07，§4.8）。起因是用户反馈
> 面板「按钮过于拥挤」——后续第二阶段（M5~M7 实体/丧尸/巢穴）会持续加入新配置项，
> 单列布局每加一组就增高一行，版面撑不住。
>
> **布局**：改为 mc-lite 同款两列盒（`.settings-columns` + `.setting-combined-item` →
> 本仓库 `.mc-columns` / `.mc-combined`），但行列分配按 mc-heavy 当前档位需要重排，
> **不沿用 mc-lite 的分配**（mc-lite 左列塞了画质/贴图模糊/色调偏移/丧尸数量/TNT 破坏等
> 本仓库尚无的功能）。最终分配：左列 = 画质+枪械破坏合并盒 / 环境风格；
> 右列 = 视距 / 帧预算 / 世界操作。**后续新配置优先往右列填**（纵向余量更大）。
>
> **档位精简**（三项，均不改变生效语义）：
> ① **视距 UI 档位 5 档 → 3 档**（`[4,6,8,12,16]` → `[8,12,16]`）。注意 `clampVD` 的钳制
> 范围 **2~16 不动** —— 那是架构口径（M1 测试/调试依赖 `vd=2`、既有 spec 用 `vd=4`），
> 面板档位只是「快捷选择」子集，两套口径不可混为一处。故面板须容错「当前值不在档位内」
> （URL 或旧存档带来 `vd=4` → 无按钮高亮）；**刻意不做「就近高亮」**，那会让按钮宣称
> 一个非生效值。② **音量档移出面板**（默认 100% 开启）。`settings.js` 仍持久化该字段、
> `?volume=` URL 仍可达 —— 音频消费方接线（§9 扩展点）时不必改数据模型。
> ③ **新世界 + 删除缓存共用一行**，语义区别落在下方一行小字（原各占一行 + 各带一行说明）。
>
> **顺带修掉一处文案漂移**：`_resetDangerArmed()` 把「删除缓存」按钮文案**写死成旧长文案**，
> 覆盖了构造时写入的短文案 → 面板打开后按钮显示的是复位那份，构造代码里的短文案形同虚设。
> 抽成共用常量 `CLEAR_SAVE_LABEL`（写两处会漂移，红线 1 精神），并在
> `tests/clear-save.spec.mjs` 补常态文案断言钉住。
>
> **测试代理档位替换**：两个 spec 原用「音量 50%」按钮作「改设置」的代理，档位移除后须换。
> `m3-hud` 换帧预算 60Hz 档（同为「运行时即时 + 持久化」，验证路径等价）；
> `clear-save` 换环境风格 night —— **不用帧预算档**，因为 `low` 档会降低 scheduler 每帧
> 预算、拖慢该 spec 的 `STABLE` 收敛（地形指纹断言依赖世界稳定）。
>
> **合并盒上边框缺失（用户报告，本次改动引入）**。两列布局的分隔线规则写成
> `#settings-modal .mc-column > :first-child { border-top: none }` —— 意图只是「去掉列首项
> 的分隔线」，但它**通配了所有子项**：合并盒恰是左列首项，且其装饰边框规则
> `#settings-modal .mc-combined`（特异性 **1,1,0**）被 `:first-child` 那条（**1,2,0**）压过
> → 上边框被置 `none`，方框缺一边。**根因实测定位（未猜）**：`getComputedStyle` 读四边得
> `Top: 0px/none`、其余三边 `1px/solid` —— 只有上边缺，正是特异性覆盖的特征。
> 修复：分隔线规则只作用于 `.mc-item`（行型，`.mc-column > .mc-item` +
> `> .mc-item:first-child`），合并盒的四边框不再被波及。
> **CSS 特异性 bug 肉眼看不出根因**（观感上只是「少一条线」），改 CSS 时极易再踩，
> 故补断言钉住「合并盒四边都是 solid」+ **负向验证**（回退通配写法 → 该断言 FAIL，
> 其余用例不受影响）。
>
> **一处自己的失误（记录以免重犯）**：修上面这条时，在 CSS 注释里用**反引号**包裹标识符
> （`` `.mc-item` ``），而 `PANEL_CSS` 是 **JS 模板字面量** → 反引号提前终止模板字符串，
> 整个模块解析失败（`node --check` 报 `Unexpected token :`）。**后果是游戏页直接白屏
> 加载不出来**（不是面板样式错，是整个页面挂），一度误判为「服务端口有问题」。
> 教训：模板字面量内的注释禁用反引号包裹；改完 `src/**/*.js` 先跑 `npm run lint`
> （lint 能抓解析错误，比 `node --check` 更贴近门禁口径）再做实测。
>
> **门禁对照**（未凭文档结论免责）：`npm run check` 全绿（arch + data 7 项契约 + lint
> 0 error / 9 个既有 camelcase warning）；单测 **296 全绿**（新增「视距 UI 档位落在钳制
> 范围内 + 默认值在档位中」契约断言）。**负向验证**：把档位临时改为 `[8,12,20]` → 该断言
> FAIL（`档位 20 不被钳制改写: Expected 20, got 16`，其余 295 条不受影响）→ 印证它钉的
> 正是「按钮宣称非生效值」这条失效路径。合并盒四边框断言同样做了负向验证（回退通配写法
> → 该断言 FAIL，其余用例不受影响）。**布局经 DOM 几何实测确认**（截图无法目视）：
> 面板 818×398、两列各 375×255（等高）、合并盒四边 `1px/solid` + 两组按钮同 y（共用一行）、
> 世界两按钮同 y、音量档已消失、视距档位 `[8,12,16]`、删除缓存常态文案 `删除缓存`、
> **零文本溢出**（逐元素 `scrollWidth > clientWidth` 检查全空）。
>
> **全量 E2E 55 passed / 1 failed**，失败的 `m1-acceptance` 的 `digP95 < 2` 是**已知 flaky
> 计时断言**（2ms 贴线，v1.30/v1.31 修订说明已记录同类现象）。**未凭「机制上不相关」免责**，
> 按 testing-policy 做了**交替对照**（每轮 HEAD 一次 → 改动侧一次，消除单侧连跑的负载累积
> 顺序效应；注意首次单侧连跑的数据因顺序效应不可比）。`digP95` 各 9 样本：HEAD
> `2.4,1.7,1.8,1.8,1.7,1.6,1.8,1.7,2.0`（均值 **1.833**，失败 3/9）、改动侧
> `2.1,2.1,1.9,1.7,1.7,1.9,2.0,2.3,1.7`（均值 **1.933**，失败 5/9）—— **两侧都会失败、
> 分布重叠**。改动侧略高约 0.1ms，方向一致但样本量小；**未宣称「已排除」**，只能说无机制
> 相关性（`grep` 确认放挖热路径 `world.setBlock`/`scheduler.remeshSections` 零命中面板代码，
> spec 用 `vd=8` 在新旧档位列表中都存在 → 无钳制差异，且两列布局 DOM 节点比原来更少）。

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
- **查询接口**（v1.16 补记）：`idOf(name)` / `nameOf(id)` / `geometryNameOf(id)` /
  `supportsPlayer(id)`，以及 `all()` —— 按注册顺序返回 `{id, name}[]` 只读快照。
  `all()` 由 §4.5.4 背包物品集合构建消费（冷路径，一次性），**禁止**进入 meshing/物理热路径
  （热路径仍走 typed 表 + 数字 ID）。冻结后 `all()` 结果不变，可安全缓存。
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
world.getBlockMeta(x, y, z)    // O(1)，越界/缺列返回 0（M3.2 补记：挖块存朝向记忆需读旧 meta；
                               // M4 plan Task 2 亦计划新增，M3.2 提前交付，口径一致）
world.isSolid(x, y, z)         // opaqueTable 直查，无字符串
world.setBlock(x, y, z, id, meta)  // 见 §4.5.3 编辑管线；meta 低 2 位 = orientation（§4.3）
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
                                      bit8-9: AO 值 0-3，经典四角 AO，移植 mc-lite AOUtils 算法
                                              （v1.31 去掉对角门控，有意偏离 mc-lite，见下）；
                                      bit10-12: 面索引 0-5，供着色器取法线——不依赖导数技巧，M1 前定死；
                                      bit13: 材质自发光标记（v1.21 新增，见下））
```

**bit13 = 材质自发光标记（v1.21 新增）**：对齐 mc-lite `MeshStandardNodeMaterial` 的
`emissive` + `emissiveIntensity`（材质层属性）。实测 mc-lite **只有 `hanging_lamp` 一处**有
材质自发光（`MaterialManager.js:1199`，`emissive:'#FFE4B5'` × 0.8），其余材质的 `emissive`
都是默认 `0x000000`，故**不能给整个 cutout 通道加自发光**（会让 vine/flower/leaves/cactus
等全部发光），必须按方块区分 → 用顶点位传递。

- **与 `blocks-data.js` 的 `emissive:15` 是不同概念，不可复用**：后者是 **blocklight 光照源**
  （照亮周围方块，`mesh/lighting.js:127` 消费 `registry.emissiveTable` 做 flood fill）；
  本位是**材质自发光**（材质本身发亮，与周围光照无关）。四个发光方块
  （glowstone/ochre_froglight/lava/hanging_lamp）都有 blocklight 源，但只有 hanging_lamp
  有材质自发光——所以两个集合不同，不能用 emissiveTable 判断本位。
- **为什么用 hardcoded Set 而非 blocks-data 字段**：这是 **mc-lite 材质层属性**的移植
  （`MaterialManager.js` 的材质定义），与 `DOUBLE_SIDE_CUBES`（mc-lite 材质 `side` 属性）、
  `SAME_TYPE_CULL`（mc-lite 材质语义）同一性质——mesher 用 hardcoded Set 表达，不入
  `blocks-data.js`（后者是 BlockData.js 的方块属性转换产物）。
- **发布粒度不变**（红线 5）：不新增材质、不新增通道，仍是 opaque/cutout/transparent 三通道
  BatchedMesh；自发光在片元阶段按顶点位分支，代价是一次位运算 + 一次混合。
- **粒度：quad 级可覆盖（v1.22）**：默认按方块判定（`EMISSIVE_MATERIALS`），但模板 quad 可用
  可选字段 `em` 覆盖（`true`/`false`），未声明时走方块级默认 → 既有模板行为零变化。吊灯用它
  令「绳不发光、灯体发光」（见下）。`materials.js` 的 `vEmissive` 本就是逐顶点 float varying，
  bit13 降到 quad 级后自动生效，无需改材质。

**吊灯 UV 分区（v1.22 新增，有意偏离 mc-lite）**：模板 quad 的可选字段 `uvRegion: [u0,v0,u1,v1]`
把该 quad 的 UV 线性重映射到 tile 内子区域（`remapRegion(u,v,r) = [r[0]+(r[2]-r[0])*u,
r[1]+(r[3]-r[1])*v]` 纯函数），令同一方块的不同部件采样贴图的不同区域：

```js
// 区域边界按 texel 中心对齐（不是像素边界）：fillRect(30,0,4,20) 填 col 30~33 / row 0~19，
// texel 中心在 30.5~33.5 / 0.5~19.5 → NearestFilter 下采样点落在纯色区内，不会采到相邻背景。
// atlas 的 v 轴翻转（build-atlas.mjs:103 `v0 = 1-(shelfY+h)/SIZE`）→ canvas row r 对应
// tile 局部 v = 1 - r/64。
const LAMP_ROPE_REGION = [30.5/64, 1-19.5/64, 33.5/64, 1-0.5/64];   // 绳图案 → 单色 #333333
const LAMP_BODY_REGION = [18.5/64, 1-47.5/64, 45.5/64, 1-20.5/64]; // 灯体图案 → 不含绳图案
```

- 绳（`prismQuads` 8 段棱柱）→ `uvRegion: LAMP_ROPE_REGION` + `em: false`：整段绳只采样
  4 texel 宽的绳图案区 → 呈单色深灰；不吃 emissive → 不被暖黄加项冲淡。
  `prismQuads` 的侧面/顶盖/底盖共用同一 `uv` 数组，故三者统一落到绳区域。
- 灯体（`boxQuads` 6 面）→ `uvRegion: LAMP_BODY_REGION` + `em: true`：v 只覆盖 row 20~47，
  **不含 row 0~19 的绳图案** → 灯体四个面无绳图案；吃 emissive → 发光暖黄。
- **几何坐标不变**（120 顶点、绳 r=0.015/y∈[0.6,1.0]、灯体 0.3³ 块中心），只改 UV 与 bit13。
- 回归防线：单测钉死「绳 quad UV 全落在绳区域、灯体 quad UV 全落在灯体区域」，并反向钉死
  「绳区域不含灯体图案区」——若有人把区域常量写成全幅会立刻被抓到。

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
flower/short_grass 等（0.7 cross，y∈[-0.1,0.6]）、vine（0.8 cross，y∈[0,1] 格内）、
lilypad（0.8×0.8 水平 quad，y=-0.48，**有意溢出格下半格**，见下）、cactus（主干+4 侧枝盒）、chimney（8 段棱柱高 2）、
handrail/A/B、vertical/horizontal_pillar、planks/cobblestone(_updown)/stone_diorite_step（L 形）、
half_block（床，1×0.5×1）、hanging_lamp（绳 8 段棱柱 r=0.015 + 灯体盒 0.3³）。

  **实例原点口径（换算基准，勿凭印象改）**：mc-lite 几何以**块中心**为原点，四条放置路径
  全部 `position.set(x+0.5, y+0.5, z+0.5)`（`ChunkConsolidation.js:529` / `Chunk.js:2474` /
  `WorldWorker.js:181,416,457`）；mc-heavy 模板坐标以**块底角**为原点（0→1）。故 mc-lite
  局部坐标须 **+0.5** 才可与 mc-heavy 模板值比对。上表数字均已换算为格内坐标。

  **vine 有意偏离 mc-lite（2026-09-03 勘误）**：mc-lite `geoVine` 为 `PlaneGeometry(0.8,1.0)`
  + `translate(0,0.5,0)`，局部 y∈[0,1]，加实例原点 +0.5 → **世界 y∈[0.5,1.5]**，向上溢出半格。
  其源码注释「向上偏移0.5，使几何体从y=0到y=1」说的是**局部**坐标，是误导——藤蔓挂在方块
  上方半格，不贴合方块边界。mc-heavy 改为 y∈[0,1] 落在格内。这是**已知的有意偏离**，
  比对 mc-lite 视觉时勿按 y∈[0.5,1.5] 判定。

  **lilypad 有意偏离 mc-lite（2026-09-05，bug 修复）**：模板 y 从 `0.02` 改为 `-0.48`
  （叶面落在块底之下半格），生成侧同时从 `SEA_Y` 改放 `SEA_Y+1`。**两处必须一起改，
  单独改任一处都错**（只改几何 → 叶面悬空半格；只改格位 → 叶面贴块底仍沉水）。
  换算与实测（诊断脚本，落点 `(-600,-270)`）：

  | | 世界 y |
  |---|---|
  | 叶面 = 实例原点(块底角 `SEA_Y+1` = -1) + 模板偏移(-0.48) | **-1.48** |
  | 暴露水面顶面 = `(SEA_Y+1)` − `WATER_SURFACE_SINK`(0.5) | **-1.50** |
  | 差 | **+0.02**（紧贴水面之上，不沉水）|

  - **为什么 mc-lite 沉水更严重却没人发现**：其 lilypad 是**装饰实体**（`EntityManager.js:412`），
    实例原点 = `Math.floor(y)+0.5` = 块**中心**，几何 `translate(0,-0.48)` → 叶面世界 y = **-1.98**，
    沉在整格水面顶面 -1.0 之下 **0.98**（mc-lite 自身即有此缺陷）。mc-heavy 的水面下沉 0.5
    把差距缩到 0.48，反而更扎眼。
  - **为什么不能放 `SEA_Y`**：`fillColumn` 水面填充区间是 `(h, SEA_Y]` → `y=SEA_Y` 是**水格**，
    覆盖它会挖出「水洞」（四周水还在、该格没水），且 `lilypad.solid=false` → 玩家踩上去掉进洞里。
    实测负向数据：改前该格 `atSea=lilypad / atSeaPlus1=air`，改后 `atSea=water / atSeaPlus1=lilypad`。
  - **陆地 lilypad 同口径贴合**：`jungle_pyramid.json` 的 4 个 lilypad 下方是 `cobblestone_step`
    （顶面 y=1.50）→ 叶面 1.52，贴合（原 y=0.02 时叶面 2.02，反而悬空半格 → 本次一并修正）。
  - **`big_house.json` 的 3 个草地 lilypad 已移除**（`x=-16/-14/-12, y=2, z=-13`）：其下方是 `grass`，
    顶面 y=2.00 是**整格高**，而水面/台阶顶面是**半格高**，两者差半格 → 同一份几何无法同时贴合，
    保留会让睡莲沉进草地 0.48。睡莲是水生植物，长在草地上本身是 mc-lite 数据怪异。
    这是**对「`assets/structures/*.json` 原样复用」约定的有意例外**（仅此一处，理由如上）。
- **面 UV 口径 = three.js BoxGeometry buildPlane**（vendor/three r185.1 源码核验）：
  +X: u=1-z,v=y；-X: u=z,v=y；+Y: u=x,v=1-z；-Y: u=x,v=z；+Z: u=x,v=y；-Z: u=1-x,v=y。
  与 mc-lite InstancedMesh 一致（历史 bug：±X 用统一 UV → 东西面贴图旋转 90°，已修）。
- **双面口径**：mc-lite 植被/藤蔓/睡莲与 realistic_oak_leaves 为 DoubleSide，其余 FrontSide。
  单材质通道内用「双向绕线」复刻双面（不拆通道、不加材质）。cutout 材质 alphaTest=0.3
  （mc-lite 树叶族口径，树冠内表面背向剔除 → 堆积不过密）。
- **床 UV 变换（2026-09-03 勘误：原口径把 mc-lite 的「定义」误当作「行为」）**：
  mc-lite 床侧面材质定义 `repeat:[1,0.5]` + `offset:[0,0.5]`、顶面定义 `rotation:-π/2`，
  注释写「只使用纹理下半部分」「顺时针旋转90度」。**但 `offset` 与 `rotation` 全仓无任何
  消费点**（`grep -rn "\.offset\.set\|texture\.rotation" src/` 零命中；`_createMaterial`
  只消费 `repeat`，`preloadTextures` 只调 `_applyTextureSampling`）——它们是死字段。
  实测生效的 uvTransform 是 `v' = 0.5*v`（顶点 v∈[0,1] → 采样 v'∈[0,0.5]）= 贴图**下半**
  （PNG 行 8~15，实测 92 个不透明像素）；顶面**不旋转**、整图采样。
  本仓库据此实现 `vLowerHalf`（vv = 0.5*vv）与 `uFlip`（对应 `repeat:[-1,0.5]`，
  RepeatWrapping 下与纯镜像 uu=1-uu 等价，边界 u=0/u=1 采样同一 texel，已实测核对），
  顶面不加变换。
  **教训**：原实现照 mc-lite 的字段名与注释实现了「取上半 + 顶面旋转」，而上半（行 0~8）
  实测仅 32 个不透明像素、RGB 均 rgb(40,25,25)，床走 opaque 通道 alpha 不参与混合
  → 床侧面渲成一块深色而非床侧纹理。**对齐上游时必须实测其运行时行为，不能读定义推断**
  （与「诊断 bug 不猜」同一原则）。
- **模板不做面剔除**（mc-lite 实例级渲染同口径）；光照读自身格；AO 按顶点推导（子格取最近格角）。

**朝向渲染消费（M2 bug 修复阶段提前落地）**：
- meta 低 2 位 = orientation 0-3（mc-lite OrientationUtils 语义：yaw = orientation × 90°，
  俯视为逆时针；EAST=0/SOUTH=1/WEST=2/NORTH=3）。渲染侧**无条件消费**（meta&3 非零即旋转，
  与 mc-lite ChunkConsolidation.js:530 逐实例应用 b.orientation 一致——结构 JSON 会给
  bed/planks 等 orientationEnabled=false 的方块写非零 direction）；`orientationModes`
  只管放置交互（见下「朝向放置交互」），不参与渲染门控。
- mesher 按「模型面迭代」实现：tile/床 UV 变换查**模型面**（贴图随方块转）；顶点绕块中心
  (0.5,0.5,0.5) 按 yaw 旋转（o=1: (dx,dy,dz)→(dz,dy,-dx)；o=2/3 类推）；面剔除/光照/AO/
  packed face 位用**世界面**（模型面经同一旋转映射，双射）。BoxGeometry UV 约定旋转自洽，
  侧面无需额外 UV 变换，顶底面随顶点旋转自动正确。绕线在旋转下保持，FrontSide 语义不变。
- 数据流：`getSectionView` 增打 meta（Uint8Array 18³）；MESH 任务随 data/light transfer；
  主线程快速路径与 Worker 精修同构消费。orientation=0（绝大多数）走零开销原路径。
- 结构 JSON 的 direction 经 structure-json.js 写入 meta（既有），本机制是其首个渲染消费者。

**朝向放置交互（M3.2，v1.17 定稿）**：渲染消费侧 M2 已通，本节补齐玩家放置/挖掘侧的朝向语义，
照搬 mc-lite `PlayerInteraction.js:413 getPlacementOrientation` + `OrientationUtils.js`。

- **门控字段复用**：mc-lite 用 `orientationEnabled`（`BlockData.js` 默认 true），M0 转换后
  在 mc-heavy 名为 `orientationModes`。**启用集合两侧零差异（各 40 项）**，故直接复用
  `registry.orientationModesTable[id]`（>0 即启用朝向），不新增字段、不改 blocks-data。
  （**v1.18 勘误**：本句原写「完全一致（40 项 true，84 项 false，零差异）」——true 集合确实零差异，
  但 false 计数两侧不同：mc-lite 124 方块中 84 项不参与旋转，mc-heavy 126 方块中 **86** 项。
  差额是 M2-7 新增的 `sky_stone`/`sky_grass`（门控均为 0），mc-lite 无此二方块。原文沿用了
  mc-lite 的 84 未换算，实施时实测校正。）
- **放置朝向三分支**（`src/player/orientation.js` 纯函数，无 DOM/three）：
  ```
  getPlacementOrientation(x, y, z, id, orientationModesTable, lastRemovedBlock, memory):
    ① orientationModes[id] === 0           → 0（86 个方块恒 EAST，不参与旋转）
    ② lastRemovedBlock 且 x/y/z/id 全等     → nextOrientation(lastRemovedBlock.orientation)，并 memory.set(id, 该值)
    ③ memory.has(id)                        → memory.get(id)（沿用该类型的上次朝向）
    ④ 否则                                  → 0（EAST）
  nextOrientation(o) = (o + 1) % 4          // 顺时针 90°
  ```
  **关键语义**：放置朝向**不看玩家 yaw**（mc-lite 签名 `getPlacementOrientation(x,y,z,type)` 无朝向参数）。
  转身不改朝向；玩家要转 90° 的手感是「原位挖掉再放回去」——这正是分支 ②。
  （**v1.18 补记**：mc-lite 用方块 name 作身份键，mc-heavy 世界权威是数字 id，故上述签名与记忆键
  统一改用 `id`（`registry.idOf(name)` 已在 `placeBlock()` 内取到，无需再转换）。语义与 mc-lite
  「按方块类型记忆」一致——id 与 name 一一对应，等价。）
- **Player 两个交互状态**（对齐 mc-lite `Player.js:164,168`）：
  - `lastRemovedBlock = {x,y,z,id,orientation}`：`digBlock()` 挖前读 `world.getBlockMeta()` 记下；
    `placeBlock()` 成功后清空；
  - `placementOrientationMemory = Map<id, orientation>`：按**方块类型**记忆，跨位置、本次会话内持久。
  二者都是 UI 交互态，**不入世界数据、不持久化**（世界权威只有 meta 通道；player 记录归第二阶段，v1.15 ②）。
- **读接口补记**：`world.getBlockMeta(x,y,z)`（越界/缺列返回 0）——挖块存记忆需读旧朝向。
  该方法 M4 plan Task 2 亦计划新增，M3.2 提前交付（见 M4 plan 注意事项）。
- **持久化免费**：`chunk-column.set()` 的 `edits.set(idx,{id,meta})` 早已带 meta，带朝向方块存档/重载
  自动正确，无 schema 变更。
- **明确不照搬 mc-lite 的部分**（各撞已定决策或属他 Epic）：
  ① `inventory.remove(type,1)` 放置消耗——M3.1 定稿创造模式无限背包不消耗；
  ② `audioManager.playSound('put')`——第一阶段无音频消费方（M4 Task 4 才有 AudioManager）；
  ③ `tryPlaceBed()` 床的多方块放置（按玩家位置算床尾）——属床/宝箱/门 Epic，且 bed_head/bed_tail
     在 mc-lite 本就 orientationEnabled=false，不走本节三分支。
- **对 M4 的影响**：M4 Task 6 将 `digBlock()`/`placeBlock()` 改走 `editor.setBlock(...)`
  （`WorldEditor.setBlock` 已支持 meta 参数，M4 plan:332），重写时须保留本节朝向分支；
  非依赖关系，M4 spec 全程不含方块朝向（已核实 M5/M6/M7 spec 亦不含）。

### 4.4 渲染管线（src/render/）

**4.4.1 纹理图集**
- 启动时把 mc-lite 现有散纹理（src/assets/textures/*.png，122 张：113 张 16×16 +
  2 张 32×32 + 7 张 250~362px 特殊几何/实体贴图按 128×128 入图）
  打包进一张 2048×2048 atlas（离线脚本生成 atlas.json：tile 名 → UV 矩形；运行时也保留 Canvas 合成 fallback）。
- **程序化贴图烘焙（M2 对齐 mc-lite）**：mc-lite MaterialManager 约 21 种材质是运行时
  canvas 程序化绘制（mkMat/mkProceduralMat/mkDetailMat，无 PNG）。`tools/bake-procedural-textures.mjs`
  逐行复刻其绘制参数离线烘焙到 `assets/textures/procedural/`（vine/flower/lilypad/cactus/marble/
  handrail/pillar/chimney/hanging_lamp/cloud/playground 等），随机源固定种子（确定性红线）。
  atlas 合计 147 tile（126 方块 + 23 程序化，M2-7 空岛 sky_stone/sky_grass +2）。
  **v1.26 起背包图标独立于本 atlas**（`assets/icons-atlas.png`，§4.5.4），二者不再互相影响。
  **权威计数以 `npm run check:data` 输出为准**（关系型断言，新增贴图自动跟上，勿在文档/spec 硬编码）。
  faces-data.js 全量 126 方块六面映射对齐 MaterialManager。
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

**4.5.4 背包/快捷栏（M3.1，v1.16 定稿）**

创造模式无限背包。**权威数据只有一份**：`player.inventory`（`src/player/inventory.js`），
快捷栏不是独立容器，而是背包前 5 格的视图。mc-lite 同构（`HUD.renderHotbar()` 读
`inventory.slots[i]`，i < 5），本设计不引入第二份物品状态。

物品模型照搬 mc-lite `src/actors/player/Slots.js` 语义：

```js
Slot { id, item /* string|null */, count, meta }   // set/clear/isEmpty
Inventory(size)  // slots[]、selectedSlot、add/remove/has/getSelected/selectSlot
```

- `isEmpty()` = `item === null || count <= 0`；`add()` 先堆叠到同类物品槽、再找空位；
- **两个数字不要混淆**：`Inventory(size = 1000)` 的 `size` 是**槽位数**（mc-lite `Slots.js:57`），
  `DEFAULT_INVENTORY_COUNT = 1500` 是创造模式填充时**每格的 count**（mc-lite `GameConfig.js:9`）。
  本设计文档 v1.16 前的 §4.5.4 曾写「mc-lite 默认 1500 格语义」，把二者混为一谈，已勘误。
  M3.1 实际填充 122 槽（物品集合大小），其余 878 槽留空供后续生存 Epic 的掉落/拾取使用。
  **2026-09-03 起口径变更为 118 槽**（排除 `chimney` 与床三项，见下方物品集合段落），其余 882 槽留空；
- **创造模式不消耗**：`count` 仅为占位字段，放块/挖掘不递减，`remove()` 保留供后续生存
  Epic 使用；**UI 不渲染数量**（无限背包语义，显示 1500 是噪声）。mc-lite 显示 count，
  此处为产品决策差异，非遗漏。

槽位语义（与 mc-lite 一致）：

- **快捷栏 = `slots[0..4]`**，数字键 1-5 → `selectSlot(0..4)`；
- `selectedSlot` **可越出 5**：背包面板点击任意非空槽即选中，此时快捷栏 5 格**无高亮**
  （mc-lite 同行为），放块取 `getSelected()` 的物品；
- `Player.placeBlock()` 从 `inventory.getSelected().item` 解析方块 ID，**不再索引常量数组**。

物品集合：BlockRegistry 全部条目，排除两类 →**118 项**：
- `air`、`collider`、`calcite`、`realistic_trunk_collider`（**非玩家可放置的功能性方块**；
  mc-lite 背包同样排除这 4 项）；
- `chimney`、`bed_head`、`bed_tail`、`bed_alias_block`（**可放置但不进背包**，2026-09-03 新增
  排除，归 `HIDDEN_FROM_INVENTORY` 常量）——
  - `chimney`（烟囱）：`solid:true` + 有 `faces-data` + 能放能挖，是正常可放置方块。对齐依据：
    mc-lite 背包清单是 `Game.js:206+` **手工列举 107 项**，实测核对 `chimney` 不在其中（非推测）。
  - `bed_head`/`bed_tail`/`bed_alias_block`（床）：**床渲染存在未修复的镂空透视问题**
    （床侧面有一个面无贴面 → 透视穿帮，详见 §4.3 顶点模板段 mesher 里的 TODO）。此处是
    **规避而非修复**：靠「不入背包 → 玩家选不到 → 实际不会被放置」避免暴露该问题，床渲染本身
    仍待专门解决（归属床/宝箱/门多方块 Epic）。mc-lite 手工清单同样不含 `bed_head`/`bed_tail`；
    `bed_alias_block` mc-lite **含**，本仓库一并移除是因为它 `cullMode:'none'`（不渲染、无法出
    图标），放进背包只会渲染一个空槽。
  - **为什么这些可放置方块不并入上面那 4 项的集合**：那 4 项语义是「非玩家可放置的功能性方块」，
    把可放置的方块放进去会让集合语义失真（后续若有人读该集合判断「能否放置」会得出错误结论）。
    故用独立的 `HIDDEN_FROM_INVENTORY` 常量表达（语义：**可放置但不进背包**），二者语义互斥。

**背包图标（v1.26 起为全量离线烘焙）**：图标是**离线预生成产物**，运行时只读一行 CSS 串。
演进路径：v1.23 手工图标表 → v1.24 异形方块等轴测（9 项，入世界 atlas）→ **v1.26 全量 118 项
独立 atlas + 预生成 CSS 串**（v1.26 修订说明）。

产物：`assets/icons-atlas.png`（1024²，**独立于世界 atlas**）+ `assets/icons.json`
（每个方块一条完整 `background` 串，含位置/尺寸/no-repeat，另存输入指纹）。
运行时（`src/ui/icons.js` 的 `loadIconManifest()`）：

```js
// 快捷栏 40px 档 / 背包 32px 档（按显示尺寸烘焙 → 运行时零缩放）
icon.style.background = manifest.hotbar[name];   // 1 行
```

取代 v1.24 之前的「`tileOfName()` 两级查表 + `tileStyle()` 裁剪数学 + 写 4 个样式属性 +
`INVENTORY_ICONS` 例外表」（实测约 91 行 → 1 行；预生成串与旧路径 computed style 逐项相等）。
**独立 atlas 的额外收益**：消除 v1.24 记录的「新增 textures 子目录重排世界 tile 坐标」副作用，
且 UI 不必加载 2048² 世界 atlas 只为裁图标。

**形状与 UV 的唯一权威 = `src/mesh/mesher.js`**（红线 1）：烘焙脚本
（`tools/bake-icon-atlas.mjs`）import 该模块，**禁止手写第二份几何/UV 定义**：

- 异形方块 → `TEMPLATES[geometry]`（v1.24 已导出）；
- 实心方块（104 项，无模板）→ `cubeQuads()`，由 mesher 的 `FACE_VERTICES`/`FACE_UVS`
  派生（v1.26 导出这两个常量）。`mesher.js` 可在 Node 下 import（无 three/DOM，红线 8）。

**逐面采样贴图**（v1.26 关键修正）：采样回调签名为 `(u, v, face)`，按面取 `getFaceTile(name, face)`。
实测背包实心 104 项里 17 项是多面不同贴图（`grass` 顶绿侧土、`chest`/`tnt` 顶侧不同），
旧的单面采样会让 `grass` 顶面渲成土色。

**覆盖范围（118 项全量）**：等轴测 104 项 + 平面 14 项。平面清单
（`tools/icon-fingerprint.mjs` 的 `FLAT_BLOCKS`，用户指定口径）= `water`/`swamp_water`/`cloud`/
`flower`/`short_grass`/`allium`/`azure_bluet`/`dead_bush`/`oxeye_daisy`/`red_mushroom`/`vine`/
`lilypad`/`mine_cart`/`hanging_lamp` —— 等轴测立方体对植被/水/云不合适（植被贴图有透明像素，
实测 `flower` 86% / `vine` 76%；水/云无几何语义），保持平面贴图并**保留 alpha**。
`mine_cart` 走平面路径采 mc-lite 手工图标 `Invicon_Minecart`（是**实体**不是方块，
mesher 无其几何模板 → 等轴测不适用）。

**图标过期门禁（v1.26）**：图标是派生产物，权威输入是 mesher 几何 + `faces-data` 贴图。
改背包内方块的贴图地址或几何后须重跑 `npm run icons`，否则图标**静默过期**（渲染旧形状/旧配色，
肉眼看不出）。`npm run check:data` 用**输入指纹**比对当场抓到：指纹 = 几何顶点序列 + 三个可见面
的贴图名 + **贴图内容哈希**（只钉贴图名会漏掉「换同名 PNG 内容」这条最常见路径，实测踩过）。
指纹逻辑放共享模块 `tools/icon-fingerprint.mjs`（烘焙脚本与门禁同一份，红线 1）。

> **两侧集合仍有差异（2026-09-03 实测记录，未处理）**：mc-heavy 118 项 vs mc-lite 手工清单
> 107 项。差集中除已排除的 chimney/床三项外还有：`swamp_water`、`sky_wood`/`sky_stone`/
> `sky_grass`/`sky_leaves`（M2-7 空岛新增，mc-lite 清单成文时这些方块尚不存在）、`azalea_log`、
> `vine`、`lilypad`、`realistic_oak_leaves`/`realistic_yellow_leaves`/`swamp_leaves`、
> `playground_block`/`playground_center_block`；反向差集 1 项 `gold`（mc-heavy 无此方块）。
> **本次只按指令排除 chimney + 床三项**，其余差异项未动——若要全面对齐 mc-lite 的 107 项清单，
> 需单独决策（`sky_*` 是本仓库独有的 M2-7 内容，不宜简单删除）。

**物品顺序（冻结）**：`slots[0..4]` = `stone`、`dirt`、`grass`、`sand`、`cobblestone`
（即 M3-4 既有 `HOTBAR_ITEMS`，保持快捷栏默认观感与既有测试断言不变），
其余 113 项按 `registry.all()` 注册顺序追加（确定性构建，不依赖 Map 迭代顺序以外的因素）。
理由：`blocks-data.js` 注册序前几位是 `water`/`swamp_water`/`cloud`/`glass_block`/
`glass_blink`（非玩家常用建材），纯注册序会让快捷栏前 5 格变成这些，既不合理也破坏
M3-4 视觉基线。mc-lite 用 `Game.js:206+` 手工列举 107 条（`stone` 居首）达到同样效果；
本设计以「5 项前置常量 + 注册序补全」表达，集合成员与 mc-lite 的差集为 v1.16 起的
BlockRegistry 新增方块（如 `sky_stone`/`sky_grass`），属预期扩展。

背包面板（`src/ui/inventory.js`，DOM 方案照搬 mc-lite `src/style/global.css`）：

| 项 | 值 |
|---|---|
| 触发 | `Z` toggle、`Escape` 关闭（仅打开态响应） |
| 遮罩 | `position:fixed; inset:0; background:rgba(0,0,0,.7); z-index:70` |
| 内容框 | 600×400、`#c6c6c6` 底 + 4px `#555` 边 + `box-shadow:5px 5px 0 #000` |
| 网格 | `grid-template-columns:repeat(8,1fr)`、gap 8、`overflow-y:auto` |
| 槽位 | 52×52 **总盒**（`box-sizing:border-box`，= 48 内容区 + 2px 边框 × 2）、`#8b8b8b` 底、左上白/右下 `#373737` 斜角浮雕边；`.selected` 3px `#FFFF00` + `#a0a0a0` 底；`:hover` `#999`。**必须 border-box**：选中边框 2px→3px 在 content-box 下会把总盒撑到 54×54 → grid 该行变高 2px → 下一行整体下移（点选抖动，实测位移 2px）；border-box 下边框往内吃、总盒恒 52 → 零抖动 |
| 图标 | 32×32、`image-rendering:pixelated`、读预生成的 `background` 串（v1.26，`icons.json` 的 `inventory` 档）；**按显示尺寸烘焙 → 运行时零缩放** |
| 名称 | `.item-name` 绝对定位顶部、10px 白字 + `text-shadow:1px 1px 0 #000`、溢出省略号 |
| 空槽 | 不渲染（只列非空槽，mc-lite 同行为） |

**输入门控（M3.1 修正既有漏洞）**：`Z`/`Escape` 与设置面板共用一套模态协议 —— 打开时
`document.exitPointerLock()` + 清空 `player.keys` + `game.uiModal = true`，关闭时
恢复 pointer lock（见下）+ `uiModal = false`。

`game.uiModal` 原先只在主循环 `if (!this.uiModal) this.player.update(dt)` 生效，
而 `Player._bindInput()` 的 `window.keydown` **不受门控**：模态打开期间新按的键仍会
写入 `keys`、改 `hotbarIndex`。M3.1 在 `keydown` 入口加 `uiModal` 守卫（`digit` 选中一并
拦截）。该守卫是 M4 Task 6 的前置条件 —— M4 在同一段 `keydown` 挂 `KeyR` 切武器，
若无守卫则面板打开时按 R 会切武器并播 `gun_load` 音效。

**模态栈（M3.1 新增，收口单一布尔标志的多面板竞争）**：`uiModal` 原先是**可写布尔**，
只有设置面板一个消费者时够用；背包加入后二者会互相踩 —— 设置面板开着时按 Z 开背包、
再关背包会把 `uiModal` 置 false，令仍在显示的设置面板**失去输入门控**（WASD 恢复移动、
`player.update` 恢复）。故 M3.1 把它改为**模态栈**：

```js
game.uiModal          // getter：栈非空即 true（读取侧完全不变）
game.pushModal(owner) // 打开时调用；owner 为面板标识（'settings' | 'inventory'）
game.popModal(owner)  // 关闭时调用；**只移除自己的 owner**，不误清他人的门控
```

`uiModal` 不再可写（写入抛错或忽略），`tests/m3-hud.spec.mjs` 的读取断言不受影响。
mc-lite 没有面板互斥（`UIManager.js` 里背包与设置各自独立 toggle、互不感知），
但它也没有共享的门控标志 —— 本仓库的 `uiModal` 是 M3-4 引入的，故互斥责任落在这里。

**pointer lock 恢复（口径与 mc-lite 不同，有意）**：mc-lite `Inventory.toggle()` 关闭时
`document.body.requestPointerLock()`；本仓库的 lock 目标是 **canvas**
（`Player._bindInput()` 的 `canvas.click` 入口 + `document.pointerLockElement !== this._canvas`
守卫），锁 body 会让视角与放挖全部失效。故 M3.1 关闭面板时 lock 回 `player.canvas`，
与设置面板统一。**注意**：浏览器的 pointer lock 需要用户手势，程序化 `requestPointerLock()`
可能因 `SecurityError` 失败（尤其无头环境）—— 调用处必须 try/catch 吞掉，
失败时回落到既有交互：用户点击画面即重新锁定（canvas click 入口已在）。
设置面板原 `close()` 未做 lock 恢复，M3.1 一并补齐以统一两个面板的语义。

样式表按 `settings-panel.js` 同法注入（组件自带、`mc-` 前缀防污染、重复构造只注入一次）：
`.slot:hover`/`.selected` 等伪类与状态类无法用 inline style 表达。

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
  ├─ player:  位置/朝向/背包（第二阶段；设置持久化已改落 localStorage，见 v1.15 ②。
  │           注：背包 UI 与物品模型本身已归 M3.1，见 §4.5.4；此处推迟的是其**持久化**——
  │           第一阶段背包内容确定性构建、无需落盘，玩家改动只体现在世界 edits 中）
  └─ entities:（M5 起：炮塔/矿车等持久运行时实体 snapshot；丧尸为临时实体，
                丧尸巢穴的锚点/冷却归对应 blockEntity）
```

- 写盘完全异步：edits 在内存中按 column 聚合，防抖 5s + 页面隐藏/退出时 flush（Worker 内序列化）。
- 加载 = 读 meta + 按需读 edits（column 生成时叠加），无"整图恢复"阶段。
- **丢弃玩家改动的统一入口 `Game._discardEdits()`**（v1.29）：取消在途防抖 flush + 清各
  column 的内存 edits + 清 IndexedDB `edits` store 与 `editsCache`。两个消费者共用同一份
  ——`newWorld`（换 seed + 写回 meta）/ `clearSave`（**保留 seed 与设置**，设置面板「删除缓存」）。
  内存 edits 那步必要但风险窗口窄（卸载事务能否提交时序不定），详见 v1.29 修订说明。
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
| DR-17 | 权威数据源含方块实体通道：`blocks`+`meta`+`blockEntities` 稀疏 Map；light 为派生缓存非权威 | 富状态塞 meta / 用 InstancedMesh userData 暂存（mc-lite 补丁） | 宝箱库存/告示牌文字/灯开关等富状态塞不进 8bit meta；mc-lite 已有 `_saveChestStates()`（ChunkConsolidation.js:597）证明需求真实，但用 userData 暂存是补丁式实现。做成数据模型一等公民：edits 条目、持久化 schema、重放逻辑现在定形状，第一阶段只预留不实现消费者，避免后续回填引发 schemaVersion + edits 重放二次重构。light 可从 blocks+emissive 重算收敛，不得当真相来源（§4.1）。**首个消费者已由 M7 落地（2026-09-10）**：丧尸巢穴锚点（`{kind:'zombie-nest', id, origin, critical, lastSpawnAt}`）随 edits 落盘，验证了当初预留的形状够用 —— 无需 schemaVersion 变更、无需二次重构（预留收益已兑现）。后续炮塔/床/宝箱等同类装置可直接复用此通道，见 roadmap「M7 交付的可复用模式」段 |

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
| 设置持久化（画质/音量/视距） | save/player 记录扩展 | player 记录已含画质设置字段。**音量档当前不在面板**（默认 100%，字段仍持久化 + `?volume=` URL 可达，v1.35）—— 音频接线时在此处加回档位即可，不必改数据模型 |
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
| structures/*.json | assets/structures/（原样复用；唯一例外 `big_house.json` 删 3 个草地 lilypad，见 §4.3） |
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
