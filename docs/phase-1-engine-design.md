# mc-heavy 第一阶段实施设计文档：游戏引擎原型

> 版本：v1.2 ｜ 日期：2026-08-18 ｜ 状态：定稿（经两轮逐条代码核验修订）
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
  edits:  Map<index, {id, meta}>;  // 玩家修改稀疏层（生成时叠加，卸载时序列化）
  light:  Uint8Array(16*16*128);   // 高4位 skylight，低4位 blocklight（§4.6）
  sections: Section[8];            // 派生：网格状态（dirty/mesh/version）
  state: 'empty'|'generating'|'ready';
  version: number;                 // 每次数据变更 +1，所有异步结果校验用
}
```

- `blocks` 是"terrain + edits 叠加后"的最终数据（生成完毕即叠加），保证读路径零分支。
  `edits` 仅用于持久化与 column 重生成（卸载后内存释放，再进入视距时 terrain 重算 + edits 重放）。
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
  4. 叠加 edits           玩家修改覆盖生成结果
  5. 输出 Transferable    blocks/meta 的 ArrayBuffer + 结构元数据（光源点、实体挂点）
```

**结构系统（对 mc-lite 的继承与改造）**：

- 布局确定性：`StructureIndex` 以 region（400×400，沿用 RegionMapConfig）为键，
  由 seed 确定性产出该 region 的地标清单与位置（金字塔/冰封山/雪地/海岛/城市/树木候选）。
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

**顶点格式（interleaved，单 BufferGeometry）**：

```
position: float32 ×3   （section 局部坐标，mesh.position 挂 chunk 世界偏移）
uv:       float32 ×2   （atlas 坐标，构建时写入）
aoFace:   uint8        （bit0-1: AO 值 0-3，经典四角 AO，移植 mc-lite AOUtils 算法；
                        bit2-4: 面索引 0-5，供着色器取法线——不依赖导数技巧，M1 前定死）
light:    uint8        （skylight<<4 | blocklight，§4.6）
```

每面 4 顶点 6 索引（uint32 index buffer）。一个典型地形 section 约 1~4k 面 → 缓冲 100~400KB 级别，
上传走 `BufferAttribute.updateRanges` 只传变化段。

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

### 4.4 渲染管线（src/render/）

**4.4.1 纹理图集**
- 启动时把 mc-lite 现有散纹理（src/assets/textures/*.png，122 张 16×16/64×64）
  打包进一张 2048×2048 atlas（离线脚本生成 atlas.json：tile 名 → UV 矩形；运行时也保留 Canvas 合成 fallback）。
- **atlas 渗色防护**：2048 atlas + mipmap 会跨 tile 渗色。tile 之间留 2px gutter，
  UV 内缩半 texel；默认 blur=0 时用 NearestFilter + 关闭 mipmap（mc-lite 默认即像素风），
  模糊档位开启时才启用 mipmap（此时 gutter 生效）。
- 全部不透明方块 = 1 个材质。cutout 用 alphaTest 同 atlas 第二材质；
  玻璃/水单独透明材质（排序渲染）。
- mc-lite 的纹理模糊档位（NearestFilter ↔ mipmap）在 atlas 级别保留实现。

**4.4.2 渲染发布粒度：section 重建、合批发布（3-group 语义 + 可插拔发布层）**

**决策**：section 继续作为重建与脏标记的最小粒度（快速路径 <2ms 不变），
但**发布层合批**，且发布层做成可插拔接口（`PublishStrategy`），M1 用微基准在两个候选间定型。

**候选 A：column 级 3-group 合批（默认实现）**

- 每 column 一个 Mesh，缓冲区必须是 **channel-major 布局**：opaque 全列连续一段、
  cutout 一段、transparent 一段，**恰好 3 个 geometry group**。section 在各通道内是
  连续子区间（offset 表索引）。
- **draw call 陷阱（必须写死 3-group 语义）**：three.js 在 material 为数组时**每个 group
  各发一次 draw**。若按 8 section × 3 通道切成 24 个 group，每 column 是 24 次 draw
  （289 × 24 ≈ 7000 次），比"每 section 一个 Mesh"还差。只有 channel-major 3-group 才能
  拿到每 column ≤3 draw。WebGPU 路径是否和 WebGL 一样逐 group 发 draw，需在 M0 实测确认，
  但实现必须按 3-group 语义写死，不能按 24-group 理解。
- draw call 上限：视距 8 为 289 column × ≤3 ≈ 867 次，实际因空 column/空通道远低（典型 300~500）。

**候选 B：BatchedMesh + sector 合批（M1 微基准对比项）**

- r185.1 的 `BatchedMesh` 已从 addons 进核心 three 包，带
  `addGeometry(reservedVertexCount)` / `setGeometryAt` / `setGeometrySize` / `setVisibleAt`，
  天然支持"一次 draw、按 slot 增量替换"。
- 按 sector（如 4×4 column）合批：视距 8 下约 25 sector × 3 通道 ≈ 75 draw，
  同时保留 sector 级视锥剔除（`setVisibleAt` + 包围盒）。

**选型标准（M1 硬决策门）**：120fps 基线下，放块/挖块的 p95 帧时。两个候选跑同一套
放挖压力场景，谁 p95 更稳选谁；若接近，选实现更简单的候选 A。

**变长 section 的打包策略（两个候选共用，必须定义清楚）**：

单块编辑重建后该 section 顶点数会变，原地写回会顶掉后续 section 数据。策略：

- **slot 预留余量**：每 section slot 按"上次实际顶点数 × 1.25"预留（首次按典型值），
  offset 表记录各 slot 起点；重建后若未溢出预留区间，直接 `updateRanges` 增量写回。
- **溢出触发整列 repack**：slot 溢出时不原地扩，而是把该 column（或 sector）整列
  在 Worker 重排（摊销——单块编辑极少连续溢出，repack 频率低）。repack 结果携带
  column.version，回传时版本校验，原子替换 offset 表与缓冲。
- repack 期间快速路径仍对旧 slot 布局生效（写旧区间），repack 完成后原子切换，无视觉空洞。

**其他约束**：

- **纠正一个前提**："WebGPU 每 draw 的 CPU 成本远低于 WebGL"不成立——three.js 的
  WebGPURenderer 在 pipeline/bind group 哈希与 render list 排序上的每 draw CPU 开销
  通常不低于 WebGL。draw call 数量必须作为一级约束控制，不能指望后端红利。
- **历史参照的适用边界**：本仓库上一版 TS 实现（a7feb44^，已清空）验证过 120fps，
  但它当时只流式加载约 3 个垂直 section；新设计是 8 个 section，工作量约 2.67 倍，
  其结论只能作为量级参照，M1 必须重新跑基线确认。
- `RenderSectionPool`（缓冲/geometry 复用）只省 CPU 分配与 GC，**不省显存**；
  显存控制靠视距卸载（§4.10 内存预算）。

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
  但 draw call 数量仍必须作为一级约束：这正是 §4.4.2 采用 column 级合批发布
  （而非每 section 一个 Mesh）的原因。
- **renderAsync 异步渲染循环**：帧循环用 `renderer.setAnimationLoop` + async 语义，
  渲染提交与主线程调度解耦，配合 §4.9 帧预算控制器。
- **BufferAttribute.updateRanges**：section 网格重建后只上传变化段，避免整缓冲重传
  （WebGPU 下路径最优）。
- **TSL NodeMaterial**：天空、水面、雾、色调映射全部用节点材质实现
  （mc-lite 的 TSL 水面/天空盒方案整体移植，r185 节点库更完整）。
- **frustumCulled + 预计算包围盒**：合批 Mesh 的包围盒在 meshing 时算好随缓冲回传，
  剔除粒度随发布层——候选 A 逐 column（16×16×128 AABB）、候选 B 逐 sector，零运行时计算。
- **预留（第二阶段+）**：compute shader 做 GPU 驱动剔除/LOD 选择、indirect draw 进一步
  压缩 draw call。第一阶段不引入，但 section 聚合数据结构（§4.4.5）为其留好形状。

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
  2. column.edits.set(idx, {id, meta})          ← 持久化层
  3. 标记受影响 section dirty（本 section + 跨界的相邻 section）
  4. 快速路径：同步重建脏 section（单块 < 2ms）
  5. 光照增量更新（§4.6，异步）
  6. 事件广播：'block-changed'（物理/实体/音效/粒子订阅）
```

批量编辑（TNT/爆炸，后续阶段）走 `world.setBlocks(batch)`：一次版本递增、
合并脏 section、跳过快速路径直接 Worker REMESH，主线程只做缓冲替换——
mc-lite 的 batchFaceCullingTimeout / isBatch 补丁语义被原生吸收。

**4.5.4 背包/快捷栏**：第一阶段实现创造模式无限背包（mc-lite 默认 1500 格语义），
物品 = BlockRegistry 条目 + 少量工具项。UI 移植 mc-lite Inventory 的 DOM 方案。

### 4.6 光照与 AO（src/mesh/lighting.js，Worker 侧）

第一阶段模型（对齐 mc-lite 的视觉效果，补齐其缺失的体素光照）：

- **AO**：经典四角 AO（移植 AOUtils 的 side/corner 判定），meshing 时计算，无独立 AO Worker/脏集——
  mc-lite 的 AOWorker/AOBridge/AONodeSystem/dirtyAOPositions 整套删除，
  因为 AO 在新管线里是 meshing 的免费副产品。
- **skylight（修正模型）**：不用"高度图以下衰减"（那在洞穴、悬挑下会给出错误光照，
  且 skylight 本不该随深度衰减）。正确做法：从 y=MAX 向下**逐列**传播，初始强度 15，
  遇 opaque 方块停止（下方为 0），空气/透明方块保持 15——洞穴顶部被遮、洞内为暗，自动正确。
  生成时随 GEN 计算；玩家挖穿地表时按受影响列增量重算。**纯垂直模型不含水平扩散**，
  因此不依赖任何水平邻居 column（与 §4.3 halo 协议无关）；代价是悬挑/侧开口洞穴的光照
  与 Minecraft 不同——侧开口洞穴在此模型下也是暗的。"洞穴自动正确"仅指**封闭洞穴**。
  后续阶段如需侧向透光，可升级为 3D flood fill（届时才引入水平 halo 依赖）。
- **blocklight**：emissive 方块（灯/萤石/岩浆，移植 LightSourceManager 的方块清单）
  做 flood fill（强度 15 逐级 -1 衰减）。**放置**光源用增量 BFS 即可；
  **删除**光源时的降光是全流程最难的一步（需撤销传播路径），第一阶段不追求增量删除，
  采用**全 column 重算**（或小半径局部重算）兜底，增量删除 BFS 明确放到后续阶段。
  重算触发相关 section 精修重建。
- 视觉效果上保留 mc-lite 的 PointLight 挂灯方案作为**可选增强**（镜面高光），
  但基础照度不再依赖它，避免光源数量增长拖垮渲染。

### 4.7 水面与特效

- **全局海面**：移植 mc-lite 的 800×800 水面平面 + TSL 波纹/边缘淡出 shader，
  跟随玩家平移（海面是平面不是体素，成本 O(1)，这是 mc-lite 做对的地方，保留）。
- **体素水**（swamp_water/河流湖泊）：transparent 材质组，meshing 时只生成与水/空气交界的面，
  顶面按邻居水位降低高度（简单水面高度图，避免 Z-fighting）。
### 4.8 持久化（src/save/）

```
IndexedDB（沿用 mc-lite DB 名/版本约定）
  ├─ meta:    { seed, spawn, schemaVersion, savedAt }
  ├─ edits:   chunkKey → 压缩的修改列表（仅玩家改过的方块，典型 KB 级/column）
  ├─ player:  位置/朝向/背包/画质设置
  └─ entities:（第二阶段起：炮塔/矿车/巢穴等运行时实体快照）
```

- 写盘完全异步：edits 在内存中按 column 聚合，防抖 5s + 页面隐藏/退出时 flush（Worker 内序列化）。
- 加载 = 读 meta + 按需读 edits（column 生成时叠加），无"整图恢复"阶段。
- mc-lite 老存档迁移：提供一次性迁移脚本（第二阶段），读旧 region 记录提取 blockData diff。

### 4.9 调度与帧预算（src/core/scheduler.js）

**主线程每帧固定流程**：

```
1. input → player.step(定步长物理)
2. 世界调度：按玩家位置计算目标 column 集合（视距 + 2 生成提前量）
   - 新 column → 发 GEN 任务（Worker 池，按距离优先级）
   - GEN 完成 → 主线程接管数据（Transferable 零拷贝）→ 发 MESH 任务
   - MESH 完成 → 进入上传队列
3. 帧预算消费（硬上限，超支顺延下帧）：
   - mesh 上传：≤ 3ms/帧（约 2~4 个 section 的增量段，column 合批后按 section 区间写回）
   - 快速路径重建：≤ 2ms/帧（玩家操作优先，可透支单帧）
   - 光照增量：≤ 1ms/帧
4. 实体/特效 update（第一期为空/轻量）
5. render
```

- **版本协议**：所有异步任务携带 `(columnKey, columnVersion)`，结果回传时版本不匹配即丢弃。
  这是 mc-lite 用十几个补丁（assemblyEpoch/sourceEpoch/staging buffer/原子切换）才逼近的机制，
  新引擎作为基础设施一次做对。
- **高刷适配**：渲染循环用 rAF 原生节奏（120Hz 设备自然 120 帧），
  物理/调度按 dt 归一；预算常量按 8.3ms（120fps）帧间隔标定，保证高刷下仍有帧内余量。
- **HUD 性能面板**：移植 mc-lite 的打点体系（ChunkPerfMonitor 思路），
  输出 GEN/MESH 队列深度、上传耗时、section 数、draw call、帧时分布——性能验收靠它说话。

### 4.10 内存预算（视距 8 基线）

| 项 | 估算 | 说明 |
|---|---|---|
| 体素数据（CPU） | ~37 MB | 289 column × 128KB（blocks Uint16Array 64KB + meta/light 各 32KB；保留 Uint16 为 >255 方块留余量） |
| GPU 顶点缓冲 | **~100 MB 级（大头）** | 活跃 section 平均几十~几百 KB，城市区更重；视距 16 会到数百 MB |
| atlas 纹理 | ~22 MB | 2048² RGBA + mipmap 链 |

- GPU 顶点缓冲是内存大头，且随视距近似平方增长。**显存控制靠视距卸载**（column 出圈即
  释放其 column 缓冲），不靠池化——`RenderSectionPool` 只省 CPU 分配与 GC，**不省显存**。
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
| DR-7 | 无构建步骤 + CDN import map | Vite 构建 | 延续 mc-lite 开发体验；本项目规模下无实质收益 |
| DR-8 | 世界高度 128（-32..96） | -16..112 / 64 / 256 | 兼容 mc-lite 坐标（结构零改造移植）；128 对齐 8 个 section 整除；内存 128KB/column 可控；下界 -32 给地形填充（最低 h-12，h 下界约 -16 → 最低块 -28）留足余量，避免截断 |
| DR-9 | 纯 JavaScript + JSDoc，不用 TypeScript | TS + 构建工具链 | 与 mc-lite 技术栈一致，零迁移成本；无编译环节，Worker/主线程同构代码直接共享；类型表达靠 JSDoc + ESLint 足够 |
| DR-10 | WebGPU 唯一后端（three r185.1），不做 WebGL2 降级 | WebGPU 优先 + WebGL2 兜底 | 目标用户全在现代浏览器，fallback 收益趋近于零；mc-lite 已验证 WebGPU 主路径；砍掉双后端的正确性/性能双重验证负担；架构不被锁死，未来可后补 |
| DR-11 | 渲染发布粒度：section 重建、合批发布（可插拔，M1 微基准确定 column 3-group vs BatchedMesh sector） | 每 section 独立 Mesh | section 独立 Mesh 在视距 8 下上限约 3600 draw，120fps 不可接受；合批后候选 A ~289×3、候选 B ~25×3；three.js WebGPU 每 draw CPU 开销不低于 WebGL，draw call 必须一级管控；material 数组逐 group 发 draw，必须 channel-major 3-group 布局 |
| DR-12 | 跨 region 结构：邻区索引查询（本 region + 8 邻区） | 地标加硬 margin 禁止跨界 | 地标中心偏移 100~400 + 半尺寸 40~80 必然跨 400 格 region 边界；硬 margin 会改变与 lite 的世界布局、破坏同 seed 对比；邻区布局同 seed 确定性重算，成本由布局广播（DR-13）兜住 |
| DR-13 | 结构布局单 Worker 算一次、主线程转发广播 | 每 Worker 各持 LRU 缓存 / 主线程直接计算 | City 候选扫描很重：N Worker 重复跑会成为冷启动/进城新卡点，放主线程会卡帧；布局体积小且确定性，单点计算 + 广播成本可忽略；GEN 任务依赖布局就绪（最多 9 份邻区布局） |
| DR-14 | skylight 用 top-down 逐列传播（纯垂直，不含水平扩散） | 高度图以下衰减近似 / 3D flood fill | 近似模型在洞穴/悬挑下光照错误，且 skylight 本不该随深度衰减；逐列传播实现同样简单、封闭洞穴正确、且无水平邻居依赖；侧开口洞穴偏暗的代价接受，3D flood fill 放后续阶段 |
| DR-15 | 逐面网格化，不用 greedy meshing | greedy meshing | 上一版 mc-heavy（已清空）用过 greedy；逐面在 AO/编辑增量更新/UV 映射上显著更简单，三角形多 2~3× 但当前瓶颈是 draw call 而非三角形（WebGPU 下三角形吞吐充裕）；视距 16+ 若三角形成为瓶颈再评估 greedy 或 LOD |

---

## 7. 第一阶段里程碑

每个里程碑独立可玩、可验收，全部 TDD（延续 mc-lite 的 Playwright 测试工作流）。

**M0 骨架（0.5 周）**
- 项目脚手架、import map、Worker 池与 RPC、perf 打点、BlockRegistry + atlas 构建。
- **WebGPU group-draw 语义实测**：构造 3-group 单 Mesh 与 24-group 单 Mesh 对比，
  确认 WebGPURenderer 逐 group 发 draw 的行为与 CPU 开销，为 §4.4.2 的 3-group 写死提供实测依据。
- 验收：空白场景渲染 + HUD 帧率面板；atlas 覆盖 mc-lite 全部纹理。

**M1 体素核心闭环（1~1.5 周）**
- WorldData/ChunkColumn/edits；地形生成（无结构）；section meshing（快速+精修双路径）；
  玩家移动/物理/DDA 射线/放块挖块；最小存档（edits 读写）。
- **发布层决策门（硬）**：实现 §4.4.2 候选 A（column 3-group）与候选 B（BatchedMesh sector），
  在同一放挖压力场景下对比 120fps 基线的 p95 帧时，定型发布层实现（含变长 slot 打包策略落地）。
- 验收：平原地形无限行走不掉帧；放块挖块当帧生效；重启后修改保留。

**M2 结构与世界完整性（1~1.5 周）**
- StructureIndex + 城市/金字塔/冰封山/雪地/海岛/树木移植；biome 全量；洞穴；
  光照（skylight/AO/blocklight）；水面（海面+体素水）；日夜与三种视觉风格。
- 验收：出生点可见城市天际线；地标与 mc-lite 结构轮廓/配色基调一致（同 seed 同位置截图人工比对，
  不做像素级 diff，因高度与光照模型不同）；
  跨 region 行走无卡顿。

**M3 性能达标与收尾（1 周）**
- 视距 8 全量调优；预算参数标定（60Hz/120Hz 双档）；雨效；HUD 完善；
  性能回归基线脚本（Playwright 自动跑图采样帧时）。
- 验收：§1 目标表全部达标；输出性能报告。

---

## 8. 性能验证方案

- **自动跑图**：Playwright 脚本驱动玩家沿固定路线奔跑（含跨 region、进城市、贴墙转向），
  采集帧时分布（p50/p95/p99）、GEN/MESH 队列、上传耗时，输出对比报告。
  注意：headless Chromium 跑 WebGPU 需要 SwiftShader flag（`--enable-unsafe-webgpu`），
  且 CI 上帧率采样不稳定——**CI 自动跑图只作为门禁参考（趋势监控），
  本机设备矩阵才是硬验收**。
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
| TNT/爆炸 | `world.setBlocks(batch)` + REMESH + 粒子 | 批量编辑 API、粒子接口 |
| 炮塔/子弹/丧尸 | EntityManager + 实体射线 + InstancedMesh 实体渲染 | 实体系统骨架、`block-changed` 事件 |
| 矿车/轨道 | 方块属性（track 类型）+ 实体运动系统 | BlockRegistry 的 `interact`/`onStep` 钩子 |
| 创造台 | 模型编辑 → 注册自定义 geometry 模板 | mesher 顶点模板机制 |
| 灯/光源 | emissive 属性 + blocklight flood fill | 光照管线已含 |
| 床/宝箱/门 | 多方块结构 + 朝向 + 交互钩子 | meta/orientation 位、交互事件 |
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
