# mc-heavy 体素引擎重建设计

**日期：** 2026-08-17
**状态：** 已完成方案确认，待书面审阅
**范围：** 在 `mc-heavy` 从零实现可扩展的单机 3D 体素游戏；以 `mc-lite` 的玩家体验为参考，但不复用其世界、网格与运行时架构。

## 1. 目标与验收边界

### 1.1 产品目标

- 保留 `mc-lite` 的核心体验：第一人称移动、碰撞、挖掘、放置、背包、方块模型、水面、昼夜/光照、地形、生物群系、可探索地标和大型建筑。
- 后续保留并迁移全部高级互动：宝箱、TNT、粒子、下雨、敌人、枪械、炮塔、丧尸巢穴、矿车与轨道。
- 世界允许采用新生成规则，但保留原版的玩法氛围和可探索性；不要求新旧地图逐格一致。
- 消除整图/Region 预生成、玩家到 Region 边界时扩容、结构跨区块散射补丁、动态方块 `Consolidation` 等造成的卡顿与竞态。

### 1.2 性能目标

基准设备为当前 Mac 的最新 Chrome、高刷新率显示器。

- WebGPU 首选路径：默认画质、8 个 16×16 chunk 的可视半径下，在规定的持续移动基准中稳定不低于 **90 FPS**。
- 记录并比较平均 FPS、1% low FPS、p95/p99 帧时长、生成延迟、网格耗时和每帧 GPU 上传量；验收要求 1% low 不低于 90 FPS，等价于 p99 帧时长不高于 11.1 ms。
- WebGL2 是功能降级路径：保证可玩与数据正确性，但不承诺上述 90 FPS 指标。
- 视距扩展不得要求重写核心架构。近景精细区块与远景 LOD 环必须分离，性能开销不能随着可视半径简单线性增长。

### 1.3 首期可玩核心（阶段 1）

首期完成后，玩家可以进入无限新世界，在 8 chunk 视距内流畅奔跑、跳跃、碰撞、挖掘、放置和旋转方块；可以使用背包，观察水面、昼夜光照、地形、生物群系和大型建筑，并进行手动存档。该阶段必须达到本设计的 WebGPU 性能目标。

高级武器、敌人、炮塔、巢穴、矿车、宝箱/TNT 的完整行为不阻塞阶段 1，但其数据与交互接口必须在核心中预留，禁止为迁移这些功能修改世界、网格或流式调度器的权威边界。

### 1.4 明确非目标

- 不兼容 `mc-lite` 的 Region 预生成格式、WorldStore 运行期权威模型、全局方块 InstancedMesh 表、Consolidation 定时器或独立 FaceCulling 系统。
- 不承诺导入后未被旧存档显式记录的地形与旧世界视觉一致；新生成器负责这些区域。
- 不在首期实现网络多人、服务端权威、红石式逻辑电路或全流体模拟。

## 2. 技术边界与目录

使用 TypeScript、Vite、Three.js r184、Web Workers、Vitest 和 Playwright。Three.js 是渲染适配层的依赖，不得成为世界数据、游戏规则或交互命中的权威来源。

```text
src/
  app/                 启动、设置、性能 HUD、组合根
  domain/              坐标、方块注册表、体素 section、实体组件、纯规则
  world/               世界查询、编辑事务、确定性生成、结构物化
  streaming/           视距、优先级、取消、背压、生命周期状态机
  meshing/             Worker 协议、邻域采样、光照、AO、贪心网格
  render/              Three.js WebGPU/WebGL2 适配、GPU 资源页、LOD、水面、阴影
  gameplay/            玩家、物理、背包、交互以及分阶段的实体系统
  persistence/         IndexedDB、新快照、mc-lite 导入器
  workers/             generation、meshing、persistence Worker 入口
  benchmark/           可重复的移动场景、指标采样与导出
tests/
  unit/                无 DOM 的领域、生成、网格、存档测试
  integration/         Worker/渲染边界与浏览器流程测试
  performance/         固定世界种子和移动路径的实机基准
```

`domain`、`world`、`streaming` 和 `meshing` 不得导入 Three.js 或 DOM API。Worker 输入输出使用可转移的 typed array；所有浏览器 I/O 集中在 `render`、`persistence` 与 `app`。

## 3. 世界数据与查询

### 3.1 空间单位

- 逻辑和网格最小单位为 **16×16×16 的 section**。section key 使用可处理负坐标的整除规则 `floorDiv`，包含 `cx`、`cy`、`cz`。
- 流式调度以 XZ column 管理请求和距离；column 内仅加载地形、玩家高度和可见建筑所需的垂直 section。
- 坐标使用整数世界格，不使用旧项目的全局浮点数字编码作为运行期键。内部 key 是结构化 section 坐标，块内索引是 `0..4095`。

### 3.2 单一权威数据源

每个 `VoxelSection` 只保留一份逻辑状态：调色板（`uint16` block id）、紧凑索引缓冲、方块状态位和单调递增的 `editVersion`。

- 基础地形和程序结构由纯生成函数按 `(world seed, generator version, world coordinate)` 推导，不写入存档。
- 玩家挖掘、放置和爆炸产生稀疏编辑覆盖；覆盖值可以是方块、方块状态或显式空气。加载时按“基础生成 → 编辑覆盖”的固定顺序组合。
- 运行时实体是独立的组件记录，不得混入方块数组；实体所属 section 只决定加载/保存范围。
- 网格、可见面、AO、GPU buffer、Raycast 加速数据和 LOD 都是可丢弃的派生数据。它们携带来源 `editVersion`，但永不反向修改权威体素。

这取代 `mc-lite` 中 `Chunk.blockData`、WorldBlockDataStore、payload registry、shadow store、实例索引与多层缓存并存的架构。

### 3.3 世界查询与玩家交互

`WorldQuery` 是物理、生成、光照、交互和实体的唯一读写入口，提供：

```ts
getBlock(position: BlockPos): BlockState
isSolid(position: BlockPos): boolean
raycast(origin: Vec3, direction: Vec3, maxDistance: number): VoxelHit | null
applyEdits(edits: readonly BlockEdit[]): EditResult
```

- `raycast` 使用基于栅格的 DDA 遍历，不使用 Three.js 对 InstancedMesh 的射线命中，也不依赖 `instanceIndexMap`。
- `applyEdits` 先原子更新编辑覆盖并增加受影响 section 的 `editVersion`，再通知流式与网格系统。
- 输入、物理和交互只等待内存中的 `WorldQuery`；永远不等待 Worker 或 IndexedDB。未加载 section 视为空气以避免卡住玩家，但移动边界由已加载的近场安全环保证。

## 4. 即时生成与大型建筑

### 4.1 无预生成世界

世界没有 Region 边界、WorldBounds 扩容或后台整图预生成。进入世界时，生成 Worker 仅完成出生点周围 3×3 column 的近场安全环；完成后即可进入游戏。其余 chunk 按需求即时生成。

流式调度器每帧根据相机视锥、距离、玩家移动速度和前进方向计算优先级：

1. 玩家脚下与碰撞安全环；
2. 视锥内近景；
3. 速度预测的前方扇区；
4. 侧后方近景；
5. 远景 LOD 与低优先级预取。

每项任务带 `requestEpoch` 和 `editVersion`。chunk 被卸载、优先级失效或数据版本变化时，任务可以取消；过期 Worker 回包直接丢弃。调度器有 Worker 并发上限、队列长度上限和每帧上传预算，确保后台工作不会抢占交互与渲染。

### 4.2 结构规则

大建筑、树、城市、金字塔、雪地、海岛和地标按 **256×256 世界坐标超级单元**产生确定性 feature manifest。manifest 是纯函数结果，包含 feature 类型、中心、变换、影响 AABB 与随机种子。

任意 section 生成时：

1. 查询该 section AABB 与相邻超级单元 manifest 的交集；
2. 对相交 feature 调用模板物化函数；
3. 把模板输出直接写到所属世界坐标的普通方块；
4. 仅保留落在当前 section 的结果。

模板 AABB 使 section 可在未加载邻居的情况下正确生成；建筑跨 section 不产生 overflow bucket、归属重路由或散射缓存。建筑的每一格均为普通方块，玩家交互、破坏和放置路径与地形完全相同。大型建筑在远距离由 LOD 地形/轮廓提前显示，近场精细网格就绪后原子替换，避免近距离闪现。

## 5. 流式生命周期与编辑更新

section 生命周期为：

```text
Absent → Queued → Generating → Meshing → UploadQueued → Visible → Evicting → Absent
```

同一 section 同时只有一个权威状态和一个当前请求 epoch。`Generating` 输出体素；`Meshing` 读取中心 section 及一格 halo；`UploadQueued` 在每帧严格预算内创建/替换 GPU 资源；`Visible` 的 mesh 与数据版本一致。Worker 错误时保留旧 mesh 或远景 LOD，并以受限次数重试；绝不让输入循环停顿。

编辑采用两段式显示：

1. 立即写入权威编辑覆盖，并显示仅包含改动格的极小 overlay mesh；
2. 提交版本化重网格任务，结果成功后以一次 GPU 资源交换替换旧 section 与 overlay。

这不是 `Consolidation`：没有“累计 50 个方块/等待 1000 ms”的第二份逻辑缓存，也没有主线程与 Worker 竞争写入。overlay 只是一帧到数帧的渲染派生物。

## 6. 网格、剔除与渲染

### 6.1 统一网格 Worker

网格 Worker 接收 section 体素、六面 halo、`editVersion` 和光照输入，输出按渲染类别划分的可转移几何数据：

- **opaque full cube**：面可见性、AO、光照和贪心矩形合并一次完成；只有材质、法线、光照/AO 兼容的面才能合并。
- **cutout/non-cube**：十字草、半砖、栏杆、床等按形状和材质作 section 局部实例批次，保留 DDA 所需的体素命中语义。
- **translucent**：水、玻璃等输出独立透明数据，采用独立深度/排序策略，绝不污染不透明通道。

旧项目的 face culling 语义保留在 mesh builder 内，但独立 `FaceCullingSystem` 被删除。旧全局 InstancedMesh 也被删除：它破坏空间剔除且需要大型位置到实例索引映射。

### 6.2 GPU 资源与空间剔除

渲染适配层以材质图集/纹理数组和可复用 GPU buffer page 管理 mesh。每个 render page 保存 section AABB、距离层级与资源版本；CPU 先按 frustum、距离和遮挡候选筛掉 section/page，再提交少量按材质合批的 draw range。Three.js 只封装 WebGPU/WebGL2 资源和渲染命令，不能持有方块权威数据。

不透明方块不再是“每个可见方块一个 InstancedMesh”；常见地表、墙面和建筑表面被贪心网格大幅合并。异形方块的实例化局限于各 section/page，使剔除、回收和编辑局部化。

### 6.3 远景、水面、光照与阴影

- 近景为精细 section mesh；外层是相机跟随的地形 clipmap LOD 环，使用低分辨率高度、材质色和大型建筑轮廓。可视半径增加时优先扩展 LOD 环，而非线性增加精细 section 数量。
- 海洋使用相机跟随的 clipmap 水面；玩家放置的水和局部水体使用透明体素网格。水着色器负责波动、法线、边缘淡化与水下雾。首期水保持 `mc-lite` 的静态方块行为，不实现流体传播。
- Worker 计算天空光、方块发光传播和 AO，并作为顶点/面属性交给着色器。昼夜太阳颜色和方向在 GPU 动态计算，不重建地形 mesh。
- 近距离方向阴影可按质量档启用；发光方块默认使用 emissive + 体素光，不为每个发光方块创建 `PointLight`。阴影图、远景、特效和渲染比例可在性能压力下依次降低。

## 7. 存档与 mc-lite 导入

### 7.1 新存档

新 IndexedDB 数据库与 store 独立保存：世界元数据（seed、生成器版本、设置）、稀疏 section 编辑覆盖、实体组件、玩家快照和手动快照清单。存档 Worker 在用户明确保存时执行序列化和事务提交，运行期不做全世界重新写入。

快照提交使用“先写 section/实体记录，再切换 manifest 当前版本”的原子顺序；加载到不完整快照时保留最后有效 manifest。持久化失败只显示可恢复提示，绝不回滚内存中已完成的玩家编辑。

### 7.2 旧存档输入

支持两种输入，均为一次性导入到新格式：

1. **同源直接导入（首选）**：当新游戏部署到与旧游戏相同的协议、主机与端口时，读取 `mc_lite_manual_saves / snapshots / latest`，不修改旧库。
2. **JSON 文件导入（后备）**：读取合法的旧快照 JSON。

浏览器 IndexedDB 以协议、主机和端口隔离，因此在不同端口开发时不能直接读取旧库。`mc-lite` 当前的 `exportToFile()` 未等待 `collectSnapshot()`，导出 JSON 可能不含世界内容；其快照收集也只遍历当前已加载的 chunk。导入器必须校验 `player` 和 `worldDeltas`，对无效或不完整文件给出明确报告，而不能伪造成功。

导入器规范化数值/字符串坐标 key、字符串或 `{ type, orientation }` 方块条目、玩家位置、种子与炮塔/巢穴/矿车实体记录。可映射的方块写入新的编辑覆盖；无法识别的方块或实体原样封存并生成迁移报告。由于新生成规则不同，旧快照未包含的远方区域将按新世界生成。

## 8. 玩法模块迁移顺序

### 阶段 0：基础和可重复基准

创建工程、块注册表、坐标/section、WorldQuery、Worker 协议、渲染后端探测和性能采样器。建立固定 seed、固定出生点、固定奔跑/转向/编辑路径，先获得基线数据。

### 阶段 1：高性能可玩核心

实现即时生成、feature manifest、流式调度、近景/远景渲染、DDA 交互、玩家物理、背包、基础方块、静态水、昼夜、手动存档和性能 HUD。此阶段通过 8 chunk / 90 FPS 验收。

### 阶段 2：世界体验完善

迁移全部方块定义、纹理、异形模型、JSON 建筑模板、宝箱、TNT、爆炸/破坏粒子、下雨、方块光、画质设置和 mc-lite 存档导入器。每个内容系统仅调用 WorldQuery 和实体组件接口。

### 阶段 3：实体和高级互动

迁移敌人、枪械、弹丸、AI、炮塔、巢穴、矿车、轨道、乘坐和其持久化。实体系统独立使用空间索引和渲染批次，不能直接修改 render page；任何方块破坏仍通过 `applyEdits` 进入世界。

## 9. 测试与可观测性

### 9.1 单元测试

- 相同 seed/坐标的地形和 feature manifest 恒等；不同请求顺序不改变结果。
- 结构跨 section、跨超级单元边界时，所有方块只出现一次且归属正确。
- 贪心网格只输出暴露面，面合并不穿过材质、光照、AO 或透明边界。
- 编辑增加版本；旧 Worker 回包不能覆盖新版本；取消任务不能重新发布 GPU 数据。
- DDA 射线、物理碰撞、放置边界、背包变化与方块朝向正确。
- 存档 round-trip、损坏 manifest 恢复、同源旧库导入、JSON 导入、无法识别内容封存与迁移报告正确。

### 9.2 浏览器集成测试

Playwright 覆盖首次加载、出生点安全环、持续移动、挖掘/放置、区块卸载再加载、存档恢复、导入流程、WebGPU 失败后的 WebGL2 回退和 Worker 失败恢复。测试不依赖 Three.js 实例命中来验证交互。

### 9.3 性能基准

实机基准在当前 Mac 的最新 Chrome 上运行，分别记录：

- 8 chunk 半径持续奔跑/转向 5 分钟；
- 连续穿越 20 个未生成 chunk；
- 穿越大型建筑和生物群系边界；
- 连续挖掘/放置、批量 TNT 破坏和区块重新网格；
- 高级实体上线后，在规定数量的敌人、炮塔和矿车下重复以上路径。

报告包含平均/1% low FPS、p95/p99 帧时长、最长单帧、生成到可见的延迟、Worker 队列深度、过期任务比例、GPU 上传字节和 draw call。任何导致 WebGPU 路径低于 90 FPS 的改动必须先定位原因并修复，不能以提高预生成规模或降低默认精细视距掩盖。

## 10. 错误处理和不变量

- 主线程只在帧预算内提交 GPU 上传；超预算时延后低优先级任务，绝不阻塞输入。
- 每份 Worker 输出必须匹配请求 epoch、section key 和 `editVersion`；任何不匹配结果直接释放。
- 生成失败、网格失败或 WebGPU 资源失败时保留旧可见资源或 LOD，并显示可诊断事件；允许有限重试。
- 世界中每个方块的真值只存在于“生成基底 + 编辑覆盖”；所有 mesh/缓存均可无损重建。
- 大型建筑没有独立的运行时逻辑实体；其每个方块都通过 WorldQuery 交互。
- 新旧存档导入不会清空、修改或删除 `mc-lite` 的数据库。

## 11. 设计结论

本设计以“确定性按需生成 + 单一权威体素数据 + 版本化 Worker 网格 + 空间局部 GPU 资源”替代 `mc-lite` 的预生成、散射、Consolidation、全局实例缓存和后补式 culling 优化。它把可玩体验与性能关键路径前置为可测量约束，并让后续内容迁移在清晰的世界/渲染边界内进行。
