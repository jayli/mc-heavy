# 阶段 2：世界体验完善设计

**日期：** 2026-08-18
**状态：** 设计已获用户确认
**范围：** 在阶段 1 的可玩核心之上，迁移 mc-lite 的方块内容、异形模型、宝箱、TNT、粒子、下雨、光照画质档位、旧存档导入 UI，并补齐重力与跳跃。

## 1. 目标与验收边界

### 1.1 本阶段目标

- 迁移 mc-lite 的全部方块 key（约 130 种）与真实贴图，观感与 mc-lite 一致。
- 迁移异形几何：十字花草、台阶、柱子、栏杆、吊灯、床、仙人掌、藤蔓、荷叶、烟囱、宝箱、TNT。
- 实现宝箱开盖交互、TNT 点燃与连锁爆炸、破坏/爆炸粒子、可开关的下雨。
- 提供低/中/高光照画质档位，默认高画质。
- 提供启动时的 mc-lite 存档导入入口（同源 IndexedDB 与 JSON 文件）。
- 补齐第一人称重力、落地、碰撞与跳跃。

### 1.2 性能目标

沿用阶段 1 的验收契约，在默认高画质档下：

- WebGPU：300 秒固定路径基准 1% low FPS >= 90，等价 p99 帧时长 <= 11.1 ms。
- 帧率目标 >= 60 FPS，高刷设备尽量跑满 90-120 FPS。
- 画质档位不得成为掩盖性能问题的开关；低/中档可以比高画质更低开销，但高画质仍是验收档。

### 1.3 明确非目标

- 不迁移 JSON 建筑模板；保留阶段 1 的程序化 house/tower/pyramid。
- 不实现音效、昼夜循环切换、游泳、流体传播。
- 不实现敌人、枪械、炮塔、巢穴、矿车（阶段 3）。
- 不实现网络多人、红石、全流体模拟。

## 2. 方块注册表与纹理图集

### 2.1 资源迁移

- 把 `mc-lite/src/assets/textures/*.png`（122 张，约 1MB）复制到 `mc-heavy/public/assets/textures/`。
- 把粒子序列帧 `mc-lite/src/assets/gif/{pick,block_crash,big_blow}.png` 复制到 `mc-heavy/public/assets/effects/`。
- 资源不参与 Worker 协议；Worker 只消费 tile 编号和单位面 UV。

### 2.2 方块定义

`BlockDefinition` 扩展为：

```ts
type GeometryType =
  | 'cube' | 'cross' | 'slab' | 'half_block' | 'pillar_vertical'
  | 'pillar_horizontal' | 'handrail' | 'handrail_a' | 'handrail_b'
  | 'chimney' | 'lamp' | 'vine' | 'lilypad' | 'cactus';

type BlockTextures = Readonly<{
  all?: string;
  top?: string;
  bottom?: string;
  side?: string;
}>;

type BlockDefinition = Readonly<{
  id: number;
  key: string;
  solid: boolean;
  renderClass: 'opaque' | 'cutout' | 'translucent' | 'none';
  geometryType: GeometryType;
  orientation: boolean;
  textures: BlockTextures;
  emissive: number;        // 0..1，发光方块强度
  indestructible: boolean; // bedrock 等不可被 TNT/爆炸破坏
}>;
```

- key 与 mc-lite `BLOCK_DATA` 完全一致，供旧存档导入按 key 映射。
- 现有 id 0..7 保持不变（air/stone/grass/water/sand/wood/leaves/glass），新方块从 8 递增。
- 默认值：`renderClass='opaque'`、`geometryType='cube'`、`emissive=0`、`indestructible=false`。
- mc-lite 属性迁移规则：`isSolid -> solid`；`isTransparent -> cutout`（几何为 box 且非实心/花草 -> cutout；玻璃与水 -> translucent）；`geometryType` 原样映射；`orientationEnabled -> orientation`。

### 2.3 贴图槽位与图集

- `texture-tiles.ts` 按文件名排序为每个贴图分配稳定 tileId（0..127），与方块定义的 `textures` 字段解耦。
- 主线程启动时用 canvas 把全部贴图打包成 16 列 × 8 行的 RGBA 图集 DataTexture（128 格，NearestFilter、无 mipmap、SRGB）。
- 每面贴图在一个方块面上完整重复一次；不支持 mc-lite 的 `repeat` 自定义值（原木等已提供独立侧面贴图，视觉等价）。
- 发光表为与图集同格的单通道纹理，值来自该 tile 所属方块的 `emissive`。
- 网格只携带 `tileId`（每顶点 uint16）与标准单位面 UV；着色器用 `tileId` 和固定网格行列把单位 UV 换算为图集 UV。因此 Worker、mesh 协议与存档都不依赖 DOM 或图集运行时布局。

## 3. 网格、剔除与渲染

### 3.1 三通道网格

Worker 输出 `SectionMesh`，含三个独立通道几何和同一 `sourceVersion`：

```ts
type ChannelMesh = Readonly<{
  positions: Float32Array;
  normals: Int8Array;
  uvs: Float32Array;
  tileIds: Uint16Array;
  ao: Uint8Array;      // 0..3，仅 opaque 通道参与 AO
  indices: Uint32Array;
}>;

type SectionMesh = Readonly<{
  opaque: ChannelMesh;
  cutout: ChannelMesh;
  translucent: ChannelMesh;
  sourceVersion: number;
}>;
```

- opaque：完整立方体走贪心合并；`renderClass==='opaque' && geometryType==='cube'` 的方块才是完整遮挡体。
- cutout：树叶、花草、宝箱、台阶、柱子、栏杆等；相邻 cutout 之间不互相剔除，仅被完整遮挡体遮住的面剔除。
- translucent：水、玻璃；相邻 translucent 方块之间不再绘制内侧面（避免水体内部出现玻璃状夹层），仅对空气、cutout 等非遮挡邻居绘制，被完整遮挡体遮住的面剔除；使用独立透明材质与深度策略。
- 非立方 opaque 形状（床）输出到 opaque 通道，但不算完整遮挡体；按各自形状生成几何，被完整遮挡体遮住的面跳过。

### 3.2 异形几何

每种 `GeometryType` 由纯函数生成局部四边形并应用 0..3 朝向。cross 为两个交叉面；slab 为半高盒；half_block 为下半盒；pillar/handrail/chimney/lamp/vine/lilypad/cactus 按 mc-lite 的比例实现。异形几何不参与贪心合并，AO 恒为 1（不烘焙 AO）。

### 3.3 环境光遮蔽

opaque 完整立方体面的每个角按两侧邻块与角邻块计算 0..3 AO。贪心合并要求 tileId、法线、四角 AO 完全一致。AO 作为每顶点 Uint8 属性进网格；着色器在高画质档按 `ao/3` 调制，低/中档忽略。

### 3.4 光照与材质

- 用共享节点材质替换现在的纯色 `MeshBasicNodeMaterial`：`color = 图集颜色 * (太阳漫反射 + 环境光) + 发光`。
- uniforms：太阳方向/颜色/强度、环境光颜色/强度、AO 强度。
- 固定早晨式太阳方向，不做昼夜循环。
- 三份共享材质对应三通道：opaque 不透明、cutout 开启 alphaTest、translucent 透明且 `depthWrite=false`。
- WebGL2 回退沿用现有 `WebGLNodesHandler`，节点材质两端共用。

## 4. 玩家物理

- `PlayerController.step(input, dt)` 保持纯水平语义不变：现有 300 秒基准与 e2e 都直接依赖它。
- 新增 `applyVerticalPhysics(dt)`：重力 -24、终端速度 -50、地面判定、垂直碰撞与落地吸附；新增 `requestJump()`（落地时初速 10）与 `isOnGround` 只读状态。
- 新增 `setPosition(pos)`，供出生点落地与存档导入瞬移使用。
- 游戏主循环逐帧调用水平 step 与垂直物理；Space 在 keydown 时请求跳跃（需松开后再次按下才能连续跳）。
- 出生点从固定 y=50 改为：出生列最高非空气方块顶部 + 1（玩家脚底坐标）；水面算可站立表面。
- 挖掘/放置距离从 64 收紧为 6，与 mc-lite 手感一致；相关 e2e 用例同步更新。
- 水保持非实心：玩家可沉入水底行走，本阶段无游泳。

## 5. 内容系统

### 5.1 宝箱

- `chest` 为 solid、cutout、可朝向的方块；方块网格本身是带宝箱贴图的立方体。
- 第一次左键命中：播放开盖动画（运行时场景内临时 lid 对象，绕盖子铰链旋转约 0.4 秒），不改变方块。
- 第二次左键命中：挖掉方块并把 chest 物品加入背包。
- 动画由独立的 `ChestAnimations` 管理器持有；方块被编辑、卸载或管理器销毁时自动回收动画对象。

### 5.2 TNT

- `tnt` 为 opaque 立方体，贴图为 `tnt_side`/`tnt_top`。
- 左键点燃：立即移除该 TNT，并同步在 WorldQuery 上计算爆炸：
  - 3×3×3 范围内破坏方块，跳过 `indestructible` 方块；
  - 5×5×5 范围扫描其他 TNT，各自延迟 0.5~1.1 秒连锁点燃；
  - 所有破坏通过一次 `applyEdits` 提交，并触发一次爆炸粒子。
- 爆炸逻辑是纯函数 + 可注入时钟/调度器，主线程执行；不引入 ExplosionWorker（3×3×3+5×5×5 规模无需异步）。
- 设置面板提供"TNT 破坏方块"开关，默认开启；关闭时只移除被点燃的 TNT，不做 3×3×3 破坏。

### 5.3 粒子

- 复用 mc-lite 的序列帧 Sprite 池：挖方块 -> block_crash，TNT 爆炸 -> explosion。
- 池容量与 mc-lite 一致：crash 15、explosion 10；总量 < 50 个 Sprite，通过共享贴图与对象池控制开销。
- Sprite 由渲染适配层的特效容器持有，生命周期独立于 section 页面。

### 5.4 下雨

- 把 mc-lite 的 GPU LineSegments 雨效按当前渲染适配层重写（TSL，WebGPU/WebGL2 共用）。
- 以玩家为中心半径 20，雨滴落点用 WorldQuery.isSolid 求地面高度；玩家移动超过 8 格或高度变化超过 6 格时按批（每批 64）刷新，削峰。
- 设置面板可开关；粒子数随画质档缩放：低 250、中 450、高 700；默认关闭。

## 6. 画质档位与设置 UI

```ts
type LightQuality = 'low' | 'medium' | 'high';
type QualityPreset = Readonly<{
  renderScale: number;      // low 0.6 / medium 0.8 / high 1.0
  sunEnabled: boolean;      // low false / medium true / high true
  aoEnabled: boolean;       // low false / medium false / high true
  emissiveEnabled: boolean; // low false / medium true / high true
  rainParticleCount: number; // low 250 / medium 450 / high 700
}>;
```

- 新增 ⚙ 按钮与模态面板：画质三档、下雨开关、TNT 破坏开关；打开面板自动退出指针锁定，关闭后重新锁定。
- 档位切换调用 `renderer.setPixelRatio(renderScale)` 并更新共享材质的 uniform 与雨效密度。
- 默认高画质；设置仅保存在内存，不进存档。

## 7. 旧存档导入 UI

- 启动时先显示轻量模态：**开启新世界 / 从 IndexedDB 导入 / 从 JSON 文件导入**。
- 复用阶段 1 的 `parseLegacySnapshot` 与 `importFromLegacyIndexedDb`：
  1. 解析并校验 `player`、`seed`、`worldDeltas`；
  2. 以旧 seed 创建 WorldService，等待出生安全环；
  3. 一次性 `applyEdits` 写入全部可映射方块；
  4. 玩家瞬移到快照坐标与视角，随后进入重力下落；
  5. 展示迁移报告：导入方块数、封存条目数、警告数。
- 导入失败只显示明确错误；导入过程绝不修改、清空或删除 `mc-lite` 的数据库。
- 无法识别的方块/实体按现有 `PreservedEntry` 机制封存并计入报告。

## 8. 测试与验收

### 8.1 单元测试

- 方块注册表 key/id 稳定、贴图槽位表确定性、图集格子数与发光表。
- 三通道网格：opaque 贪心合并边界、cutout/translucent 互不剔除、非立方形状的几何与朝向、AO 四角值。
- 重力落地、跳跃、头顶碰撞、终端速度、纯水平 step 回归。
- TNT 爆炸范围、不可破坏方块、连锁延迟、开关行为。
- 画质档位 preset 值、粒子池分配上限、雨效刷新批次纯逻辑。
- 旧导入解析回归与新增 key 映射。

### 8.2 浏览器测试

- 出生点落地、跳跃、宝箱两次点击、TNT 连锁爆炸、下雨开关、画质档切换、启动导入（文件与同源 IndexedDB）与错误提示。

### 8.3 性能基准

- 默认高画质档重跑 300 秒 WebGPU 基准，更新 `artifacts/perf/playable-core.json`；阈值 1% low >= 90、p99 <= 11.1 ms 不变。
- 如高画质不达标，先定位真实瓶颈（图集采样、AO、上传量），不得通过降低默认视距或降低默认画质掩盖。

## 9. 错误处理与不变量

- 贴图加载失败时该 tile 回退为洋红色调试色，不阻塞启动；图集构建失败回退到阶段 1 的纯色路径。
- 三通道任一通道上传失败只影响该通道，旧可见资源保留；版本化交换与取消语义沿用阶段 1。
- 爆炸与连锁只通过 WorldQuery.applyEdits 修改世界，不直接写网格。
- 宝箱动画、粒子、雨都是可丢弃派生对象，不参与权威数据与存档。
- 阶段 3 的敌人/炮塔/矿车接口不受本阶段改动影响：它们仍只能通过 WorldQuery 影响方块。

## 10. 设计结论

本阶段把内容系统统一到"WorldQuery 单一权威 + 三通道版本化网格 + 共享光照材质"上：贴图与几何全部数据驱动，Worker 保持无 DOM；爆炸、宝箱、粒子、雨都通过内容边界接入，不引入新的世界权威缓存。物理补齐垂直维度，但保持 `step` 纯水平语义，使阶段 1 的基准契约与验收链路不被破坏。
