# 雨天光影重做：废弃上游湿地面与后处理链，按材质分类从零实现湿表面（v3.31）设计稿

> 状态：**待用户批准**。批准前不写任何产品代码（brainstorming HARD-GATE）。
> 分支：`feat/kv9-carbine-and-rainy-lighting`（当前 HEAD `c879a0f`，工作树干净）。

## 1. 意图与为什么

用户 2026-11-22 附两张实玩截图（`~/ttt/bug/反光.png`、`反光2.png`）报告：远处高空云层与近处岩壁上有明显光晕。
用户裁定：

1. **雨的效果保留**（雨丝 / 水花 / 雨声 / 遮挡与高度规则 / 水下排除）；
2. **地面反光与雨雾的代码全部去掉**，不参考 `bj-shooting-game`，**从零重新实现**；
3. 反光**必须按材质分类**——光滑近镜面的、草地/粗糙纹理的等等，不能只有一种反光材质；
4. 「我要的就是一个普普通通的雨天光影效果」。

为什么不是继续修补：本分支已为同一类缺陷修过 5 轮（v3.30b/d/e/f/g），每轮都定位到一个真实根因并修好，
但**上游那套 shader 的前提在本仓不成立**（见 §2），修补只能逐个症状追平，不能消除错配。用户据此裁定废弃重写。

## 2. 根因取证（本轮只读侦察的结论，不是猜测）

### 2.1 岩壁竖直亮带 —— 三个错配叠加

上游 `GROUND_FRAG` 服务的是一张**独立地面 mesh**，地面就在镜面高度 `y=0`，
所以它的「把世界点压平到镜面再投影」是 **no-op**。挂到体素材质后：

| 错配 | 实测读数（跑真实纯函数 / 常量算出） |
|---|---|
| 墙侧面并没有「不湿」 | `wetnessAt(1, up=0, streak=1)` = **0.85**（代码注释写的「侧面完全不湿」与实现不符） |
| 流水纹在竖面被拉成长条 | 沿 y 空间频率 `0.045×3.2 = 0.144` vs xz `0.55×3.2 = 1.76` ⇒ 竖直拉伸 **12.2×** |
| 反射采样对墙面几何上就是错的 | 世界点被压到「玩家脚下地面高度」，只在那一层成立；墙面采到别处内容（天空暖白） |
| 掠射角把错位内容放大 | `wetFresnel(0.05, 0.025)` = **0.808**；反射加项上限 `0.808×0.5×0.85` = **0.283**（线性空间加项） |

`wet-ground-config.js` 自己的文件头已承认「复用海平面 reflector 在几何上不可能正确」，
v3.30d 的修法是新建第二条 pass 把镜面移到玩家脚下——那只修好了**玩家站的那一层**，
墙面 / 云层 / 任何其他高度的面仍然错。**这是方案层面的错，不是参数层面的错。**

### 2.2 高空云层光晕 —— 两个独立来源

1. **云被当成地面**：`cloud.cullMode = 'opaque'`（`blocks-data.js:44`）⇒ 吃同一个湿分支，
   且顶面 `up=1` ⇒ `wetnessAt(1,1,·)` = **1.0** 满强度。云在 y=35/55、镜面在 y≈22 ⇒ 采样必然错位。
2. **屏幕空间体积雾**：`storm-grade.js` 的 `compositeNode` 对**每个像素**加
   `pow(dot(rd,sunDir),8)×0.6 + skyColor` 的暖白散射，乘 `distK = T/(T+18)`。
   天空背景的 `viewZ` 恒为相机 far ⇒ `T` 被钳到 120 ⇒ `distK = 0.87` **满额**。
   这就是朝太阳一侧那层暖色薄纱。
3. **bloom 把上面两处亮斑扩散成「光晕」**：阈值 0.9、软膝 0.54、5 级 mip 链、增益 0.16。

⇒ 用户看到的「光纤」不是雨雾，是**错位的镜面反射 + 屏幕空间加色雾**，再被 bloom 放大。

### 2.3 一条硬约束：不能给体素加顶点属性

三通道静态顶点缓冲现算（`CAPACITY`：opaque 4.275M / cutout 2.20M / transparent 0.30M，索引 = 顶点×1.5）：

| 每顶点字节 | 总量 |
|---|---|
| 24B（现状：pos 3×f32 + uv 2×f32 + packed u32） | **193.83 MiB** |
| 28B（加一个 float 属性） | **219.68 MiB** |

`tests/m3-fullscene.spec.mjs:98` 的门是 **200 MiB** ⇒ 加属性直接超门 19.7 MiB。
⇒ **材质分类只能塞进 `packed` 的空闲位**。`packed` 是 Uint32，现用 bit0–14
（light 0-7 / AO 8-9 / face 10-12 / emissive 13 / noShadowCast 14），bit15–31 全空。
用 bit15–18（4 bit，16 类）⇒ **零字节增量、零内存回归**，且 mesher 是 Worker/主线程共用同一份
（红线 8）⇒ 两条 meshing 路径自动一致。

## 3. 目标 / 非目标 / 反目标

**目标**
- 开启「雨天光影」= 持续下雨（现状保留）+ **按材质分类的湿表面**（压暗 + 有界天空反光 + 弱太阳高光 + 积水斑）。
- 云、自发光体、装置占位块**完全不湿**（消除 §2.2 来源 1）。
- 墙面只有极弱压暗与极弱广角反光，**没有竖直长条纹理**（消除 §2.1）。
- 关闭时**逐位回到未开启**（`uWet=0` ⇒ mix 取左端）。
- 雨天档的帧时**不高于**现状（删掉整条后处理链与第二条反射 pass）。

**非目标（本轮不做，写清楚免得后人「补齐」）**
- 雨雾 / 体积雾 / 任何屏幕空间加色层。用户已放弃雨雾，本轮不做替代实现。
- 真实倒影（不采样任何反射 RT）。反光反的是**程序化天空渐变 + 太阳高光**（用户裁定）。
- 采样天空盒立方图（用户裁定不用；`?skybox=0` 是全部既有 Tier 4 spec 的口径，必须成立）。
- 涟漪 / 流水动画。用户未选 ⇒ 湿表面是**静态**的（动的是雨丝与水花）。
  好处：无 `uWetTime`、Tier 4 判据天然稳定、不需要冻时间。
- 逐片元「屋檐遮挡」（见 §7 已知近似）。

**反目标（做到了也算失败）**
- 给体素新增顶点属性（超内存门，§2.3）。
- 新建第二条 reflector pass 或任何额外 render pass。
- 用加法把反光叠到基色上（亮端必钳白，本仓 ocean 已实测过）。
- 用 `hash(floor(uv))` 造积水斑（已实测出轴对齐矩形斑）。
- 单一反光材质「一刀切」（用户明确否决）。
- 改动 `blocks-data.js` 的方块**顺序或数量**（会让旧存档 edits 静默错位）。

## 4. 方案取舍（Approaches）

### 4.1 反光来源（用户已裁定：程序化天空 + 太阳高光）

| 方案 | 取舍 | 结论 |
|---|---|---|
| A 程序化天空渐变 + Blinn-Phong 太阳高光 | 零 RT、零额外 pass；对**任何朝向任何高度**的面都几何正确；`?skybox=0` 成立 | **采纳（用户选定）** |
| B 采样既有天空盒立方图 | 能映出真实云与落日；但 `?skybox=0` / 加载失败时无源可采，须另写回落路径并单独测 | 否 |
| C 独立平面反射 RT（现状） | 只对镜面那一层正确；两条 pass 的索引表隔离、读写冲突、占位图同步三个坑全部继承 | 否（本轮废弃） |

### 4.2 材质分类的载体

| 方案 | 取舍 | 结论 |
|---|---|---|
| A `packed` bit15–18（4 bit）+ 类参数 uniform 数组 | 零内存增量；Worker/主线程同源；分类是逐 quad 常量 ⇒ 顶点阶段查表、一个 vec4 varying 传片元 | **采纳** |
| B 新增 float 顶点属性 | +25.84 MiB ⇒ 超 200 MiB 门 | 否（§2.3 实测） |
| C 片元里按 UV 反查 tile → 材质 | tile 尺寸有 4 种（实测 0.0073/0.0151/0.0308/0.0620），反查不可靠；且要新增一张表纹理 | 否 |
| D 按方块名在 shader 里写 if 链 | 150 个分支；新增方块要改 shader | 否 |

### 4.3 后处理链（用户已裁定：整条删掉）

删 `storm-grade.js` / `storm-grade-config.js` 全部内容。雨天档回到 `renderer.render()` 单 pass。
连带消失：体积雾、bloom、色差、暗角、冷调、S 曲线、胶片颗粒，以及它们的全部已知坑
（预热收敛、色彩空间分段、`hash(vec2)` 竖纹、MSAA≠FXAA）。
雨夜氛围改由**既有** DayNight 风格系统承担（用户可自行选「傍晚/黑夜」），不新增分级层。

### 4.4 湿表面挂哪些通道

**opaque + cutout 都挂**。理由：台阶 / 半砖 / 栏杆 / 柱子全在 **cutout** 通道
（实测 45 个 cutout 方块里 `sand_step`/`planks_step`/`cobblestone_step`/`obsidian_brick_step`/
`*_slab`/`handrail*`/`*_pillar` 共 20 个是建筑表面）。只挂 opaque 会让「石地面湿、石台阶干」。
植被（`PLANT` 类）参数压到极弱 ⇒ 树叶/花草几乎不变，符合「植被保持哑光」。
transparent（水/玻璃）**不挂**（本来就是镜面，水已有自己的高光与倒影）。

## 5. 材质分类表（唯一权威）

新建 `src/voxel/wet-material-data.js`（**three-free**，与 `faces-data.js` 同性质的 name→值映射）。

类枚举（4 bit，写入 `packed` bit15–18）：

| 值 | 类 | 语义 |
|---|---|---|
| 0 | `NONE` | 完全不湿 |
| 1 | `POLISHED` | 抛光/致密：近镜面 |
| 2 | `STONE` | 粗糙石材：中等反光、明显压暗 |
| 3 | `SOIL` | 土/草/沙/雪/黏土：强吸水、最暗、最散 |
| 4 | `WOOD` | 木材：中等 |
| 5 | `METAL` | 金属/宝石：少吸水、强镜面 |
| 6 | `ICE` | 冰：本来就滑，湿增益小 |
| 7 | `FABRIC` | 布/羊毛/干草：极强吸水、几乎无镜面 |
| 8 | `PLANT` | 树叶/花/草/藤/仙人掌：极弱 |

**分类必须逐块显式列出，覆盖全部 150 个 opaque/cutout 方块**（实测：opaque 105 + cutout 45）。
未列出的方块 ⇒ 表值 0（`NONE`，安全失败：新方块顶多不湿，不会「湿错」）；
并由 Tier 1 门禁断言「每个 opaque/cutout 方块都已分类」⇒ 新增方块漏分类会**当场红**。

分组（按表面物理，不按 biome）：

- `NONE`（18）：`cloud`（**用户核心缺陷**）、`lava`、`glowstone`、`ochre_froglight`、`hanging_lamp`、
  `turret_alias_block`、`zombie_nest_alias_block`、`playground_block`、`playground_center_block`、
  `floatato`、`brain_coral_block`、`bed_head`、`bed_tail`、`orange_shulker_box`、`piston`、`piston_head`、
  `sand_train_track`、`sand_train_track_corner`
- `POLISHED`（21）：`smooth_stone`、`smooth_stone_1`、`polished_diorite`、`polished_granite`、
  `polished_deepslate`、`polished_blackstone_bricks`、`polished_end_stone`、`marble`、`block_of_quartz`、
  `quartz_bricks`、`obsidian`、`obsidian_bricks`、`chiseled_obsidian_bricks`、`obsidian_brick_step`、
  `obsidian_brick_step_updown`、`obsidian_brick_slab`、`chiseled_purpur_block`、`purpur_block`、
  `chiseled_stone_bricks`、`chiseled_end_stone_bricks`、`end_stone_pillar`
- `SOIL`（16）：`grass`、`dark_grass`、`light_grass`、`swamp_grass`、`sky_grass`、`dirt`、`moss`、
  `mossy_stone`、`mossy_stone_bricks`、`sand`、`sand_step`、`sand_slab`、`snow`、`snow_grass`、
  `snow_block`、`clay`
- `METAL`（8）：`iron`、`gold_block`、`diamond`、`emerald`、`amethyst`、`block_of_amber`、
  `oxidized_cut_copper`、`weathered_cut_copper`
- `ICE`（1）：`ice`
- `FABRIC`（3）：`light_gray_cloth`、`pink_wool`、`hay_bale`
- `PLANT`（25）：`leaves`、`azalea_leaves`、`azalea_flowers`、`yellow_leaves`、`realistic_yellow_leaves`、
  `swamp_leaves`、`snow_leaves`、`sky_leaves`、`giant_oak_leaves`、`giant_birch_leaves`、`giant_spruce_leaves`、
  `giant_cherry_leaves`、`giant_palm_leaves`、`giant_banyan_leaves`、`flower`、`short_grass`、`bush_grass`、
  `allium`、`azure_bluet`、`dead_bush`、`oxeye_daisy`、`red_mushroom`、`vine`、`lilypad`、`cactus`
- `WOOD`（27）：`wood`、`dark_oak`、`birch_log`、`azalea_log`、`giant_oak_log`、`giant_mangrove_log`、
  `sky_wood`、`planks`、`oak_planks`、`oak_planks_1`、`white_planks`、`dark_planks`、`blue_planks`、
  `green_planks`、`acacia_planks`、`chorus_planks`、`planks_step`、`planks_step_updown`、`half_block_updown`、
  `handrail`、`handrailA`、`handrailB`、`vertical_pillar`、`horizontal_pillar`、`chimney`、`chest`、`bookbox`
- `STONE`（31，兜底类但仍逐项显式列出）：`stone`、`stone_diorite`、`cobblestone`、`bricks`、`calcite`、
  `end_stone`、`end_stone_bricks`、`stone_bricks`、`cracked_stone_bricks`、`tuff_bricks`、`mud_bricks`、
  `nether_bricks`、`nether_bricks_1`、`netherrack`、`deepslate`、`deepslate_diamond_ore`、`bedrock`、
  `gold_ore`、`iron_ore`、`nether_gold_ore`、`debris`、`tnt`、`sky_stone`、`void_stone`、
  `void_infused_end_stone_bricks`、`cobblestone_step`、`cobblestone_step_updown`、`stone_diorite_step`、
  `end_stone_brick_step`、`end_stone_brick_step_updown`、`end_stone_brick_slab`

**覆盖性已实测**：18+21+16+8+1+3+25+27+31 = **150**，与 `BLOCKS` 里 opaque(105)+cutout(45) 全集
**逐名对齐、无重复、无多余、无遗漏**（本轮跑脚本核对过）。
Tier 1 的覆盖断言把这份对齐钉成回归门 ⇒ 新增方块漏分类会当场红。

`registry` 派生 `wetClassTable`（Uint8Array，与 `shadowCastTable` 同手法）：
`wetClassTable[id] = WET_CLASS_DATA[name] ?? 0`。**不改 `register()` 的签名，不改方块顺序**
⇒ `fingerprint()` / `fingerprintOfPrefix()` 逐位不变 ⇒ **旧存档零影响**。

## 6. 湿表面着色模型（从零，全部片元/顶点数学写在新模块）

新建：
- `src/render/wet-surface-config.js`（**three-free**，常量 + CPU 同构纯函数，可 Node 单测）
- `src/render/wet-surface.js`（TSL 节点 + uniform 单例）

### 6.1 类参数（每类一个 vec4）

`WET_CLASS_PARAMS[cls] = (wetGain, darken, rough, specGain)`

| 类 | wetGain | darken | rough | specGain |
|---|---|---|---|---|
| NONE | 0 | 1.00 | 1.00 | 0 |
| POLISHED | 1.00 | 0.82 | 0.06 | 1.00 |
| STONE | 0.85 | 0.72 | 0.35 | 0.45 |
| SOIL | 1.00 | 0.62 | 0.62 | 0.18 |
| WOOD | 0.80 | 0.74 | 0.45 | 0.35 |
| METAL | 0.90 | 0.88 | 0.12 | 0.90 |
| ICE | 0.60 | 0.92 | 0.04 | 1.00 |
| FABRIC | 1.00 | 0.55 | 0.90 | 0.04 |
| PLANT | 0.35 | 0.88 | 0.85 | 0.05 |

语义：`wetGain` 该类能被淋湿的程度；`darken` 湿透时的 albedo 乘数；
`rough` 湿表面粗糙度（ drives F0 / 高光锐度 / 天空渐变带宽 / 积水门）；`specGain` 反光强度上限系数。

初值依据（**不是上游数值**，按物理与本仓光照口径定，实施期由 Tier 4 扇描重标）：
- 吸水性与 `darken` 反相关：布/羊毛最吸水（0.55）、金属最不吸水（0.88）；
- `rough` 按表面致密度：抛光石 0.06 ↔ 羊毛 0.90；
- `specGain` 与 `rough` 反相关，但金属/宝石额外抬（高折射率）。

全局常量：
```
WET_WALL_FACTOR   = 0.22   // 侧面湿强度系数（底面 0）
WET_WALL_ROUGH_ADD= 0.25   // 竖面水膜更薄更散
WET_REFL_MAX      = 0.55   // 天空环境混合的上限（有界，防钳白）
WET_SUN_SPEC      = 0.22   // 雨天云遮日 ⇒ 太阳高光很弱
WET_PUDDLE_SCALE  = 0.32   // 世界 xz 噪声尺度 ⇒ 斑块直径 ≈3 格
WET_PUDDLE_FROM   = 0.52
WET_PUDDLE_TO     = 0.76
WET_PUDDLE_ROUGH_K= 0.25   // 积水处 rough × 0.25
WET_PUDDLE_DARK_K = 0.88   // 积水处再压暗
WET_PUDDLE_SPEC_K = 1.60   // 积水处 specGain × 1.6（钳 ≤1）
```

### 6.1b 反光强度的量级标定（**实施期必须扇描，不凭直觉定**）

把 §6.1 初值与 §6.4 公式代进去算，正午俯视地面（NoV≈0.8）时：

| 类 | F | reflK = F×specGain×0.55 | 观感 |
|---|---|---|---|
| POLISHED | 0.058 | **0.032** | 只有 3% 天空色 ⇒ 几乎看不出反光 |
| STONE | 0.046 | 0.011 | 看不见 |
| SOIL | 0.035 | 0.003 | 看不见 |

掠射（NoV≈0.15）时 POLISHED 的 reflK 才到 0.26。
⇒ **正对地面看时反光会太弱**，这与用户「地面湿滑反光」的诉求可能不符。

三个可动旋钮（按此顺序试，每次只动一个）：
1. `WET_REFL_MAX` 0.55 → 0.75 / 0.90（上限仍 ≤1，`mix` 天然有界，不会钳白）；
2. 菲涅尔幂 5 → 3（掠射增益变缓、正视基础值抬高）；
3. `F0` 基数 0.02+0.04×(1−rough) → 0.03+0.09×(1−rough)。

**标定判据（Tier 4，写进 spec）**：正午、俯视 45°、`smooth_stone` 地面，
开档后该区域的 luma 相对关档的变化必须落在 **[+6, +40]**（sRGB 0~255）——
下界拦「看不出湿」，上界拦「变成镜子」。`grass` 同机位的变化必须 **小于 stone 的一半**
（材质分层在真实像素上也成立，不只在类参数表里成立）。
⚠️ 这两个数是**待标定的目标带**，不是既有冻结值；实测落在带外就调旋钮，
**不要反过来放宽这条判据**（那是把缺陷实测值当阈值，已记教训）。

### 6.2 uniform（模块级单例，`uWet` 初值 0 ⇒ 未接线逐位等于原材质）

| uniform | 写入方 | 说明 |
|---|---|---|
| `uWet` | `Game.setStormLighting` / `_updateStorm` | 总强度 0/1（室内 ⇒ 0） |
| `uWetWaterY` | 常量初值 `WATER_SURFACE_Y` | 水下门基准（复用既有权威） |
| `uWetHorizon` | `DayNight._apply` | 地平线天空色 = `p.fogColor`（**既有风格数据**） |
| `uWetZenith` | `DayNight._apply` | 天顶天空色 = `p.sky`（**既有风格数据**） |
| `uWetParams` | 构造期一次 | `uniformArray(9×Vector4, 'vec4')`，576 B |

复用**已有 uniform 实例**（红线 1，不新建第二份）：`uSkyDim`（天空环境亮度）、
`uSunDirection`、`uSunColor`（色温）、`uShadowStrength` 与 `shadowFactor`（太阳高光的影区衰减）。

⚠️ `uWetHorizon`/`uWetZenith` 用 `uniform(new THREE.Color(hex))`（与既有 `fogColor` 同口径，
Color 构造按 sRGB→线性），**片元里显式拆 `.r/.g/.b`**——`vec3(Color)` 在 WebGPU 静默输出纯黑（已记教训）。

### 6.3 顶点阶段（一个新 varying）

```
cls        = packed.shiftRight(15).bitAnd(15)        // uint 节点（同既有 worldFaceIndex 手法）
vWetParams = varying(vertexStage(uWetParams.element(cls)), 'vWetParams')   // vec4，逐 quad 常量
```
⚠️ `uniformArray` 的 `.element()` 接受节点索引（`UniformArrayElementNode`），
且 WebGPU 的 `storageBuffer` 可用性为 true ⇒ 走 uniform buffer 路径，**不会退化成逐顶点属性**。
`uWetParams` 的 9 个元素是 `THREE.Vector4`（`elementType='vec4'` ⇒ paddedType `vec4`，无 padding 浪费）。
构造期写一次，之后只读 ⇒ 每帧零 CPU 成本。
理由：分类是逐 quad 常量 ⇒ 顶点查表 + 常量 vec4 插值**逐位精确**，片元零查表。
⚠️ **不在片元读 `packed`**：three 对 int 类型 varying 强制 `flat`（已记教训），
虽然 flat 对常量恰好无害，但绕开它更省心，且省一次片元位运算。
⚠️ 新增 varying 数：现有自定义 4 个（vSkyShade / vBlockShade / vEmissive / vSunDot）+ 本项 = 5，
远低于 WebGPU `maxInterStageShaderVariables`（默认 16）。**实施期必须由 Tier 4 无 console 错误判据确认编译通过**。

### 6.4 片元阶段

```
P = vWetParams;  up = faceNormal.y
orient = select(up > 0.5, 1.0, select(up < -0.5, 0.0, WET_WALL_FACTOR))
rough0 = min(P.z + select(up > 0.5, 0.0, WET_WALL_ROUGH_ADD), 1.0)

// 积水斑：只在朝上面，且材质足够致密（rough 越大越不积水）
n        = mx_noise_float(vec3(wp.xz * WET_PUDDLE_SCALE, 0)) * 0.5 + 0.5
puddle   = smoothstep(FROM, TO, n) * step(0.5, up) * oneMinus(smoothstep(0.55, 0.80, rough0))
rough    = rough0 * mix(1.0, WET_PUDDLE_ROUGH_K, puddle)
specGain = min(P.w * mix(1.0, WET_PUDDLE_SPEC_K, puddle), 1.0)
darken   = P.y * mix(1.0, WET_PUDDLE_DARK_K, puddle)

aboveWater = step(uWetWaterY, wp.y)          // 水下门（保留既有裁定）
wet        = clamp(uWet * P.x * orient, 0, 1) * aboveWater

// 反光的「天空」：按反射方向 y 在雾色↔天顶色之间插值，带宽随粗糙度变宽
V = normalize(cameraPosition - wp)
R = reflect(V.negate(), faceNormal)
bandLo = mix(-0.15, -0.50, rough);  bandHi = mix(0.55, 1.00, rough)
skyEnv = mix(uWetHorizon, uWetZenith, smoothstep(bandLo, bandHi, R.y)) * uSkyDim

// 菲涅尔（Schlick，F0 由粗糙度派生）
NoV = clamp(dot(faceNormal, V), 0, 1)
F0  = 0.02 + 0.04 * (1 - rough)
F   = F0 + (1 - F0) * pow(1 - NoV, 5)

// 太阳高光（Blinn-Phong，锐度由粗糙度派生，影区衰减复用既有 shadowKill）
H    = normalize(uSunDirection + V)
shin = mix(6, 420, pow(1 - rough, 3))
spec = pow(max(dot(faceNormal, H), 0), shin) * specGain * WET_SUN_SPEC * shadowKill

// 合成：压暗 → 有界混合天空 → 加一点点高光
albedo   = baseRgb * mix(1.0, darken, wet)
reflK    = F * specGain * WET_REFL_MAX * wet
withSky  = mix(albedo, skyEnv, reflK)          // ★ mix 不是 add ⇒ 天然有界，不会钳白
lit      = withSky + uSunColor * spec * wet
return mix(baseRgb, lit, uWet)                 // uWet=0 ⇒ 逐位回到原色
```

**载荷性口径（每条都是本仓已实测的教训）**
1. 节点不与裸 JS 数字算术，一律 `.mul()/.add()`；常量色显式拆分量。
2. 多层 `mix` **嵌套**，不链式 `.mix()`。
3. 径向量（`V`/`R`/`H`/`NoV`）全在**片元**算 —— 体素 quad 只有 4 顶点，顶点算会插值成常量。
4. 不用 `.toVar()/.assign()`（本函数在 `makeMaterial` 里直接调，不在 `Fn()` 体内 ⇒ 会报 No stack defined）；
   用普通 JS 变量持有节点。
5. 反向 smoothstep 写 `oneMinus(smoothstep(lo,hi,x))`。
6. 噪声用 `mx_noise_float`（连续），**不用 `hash(floor(...))`**（会出轴对齐矩形斑）。
7. 反光用 `mix` 而非 `add`（加法在亮端必钳白）。

### 6.5 CPU 同构纯函数（`wet-surface-config.js`，Tier 1 可测）

- `wetClassOf(name)` / `WET_CLASS_PARAMS`
- `wetnessAt(strength, up, cls, waterY, worldY)` → 0..1（含底面 0 / 侧面系数 / 水下 0）
- `wetRoughnessAt(cls, up, puddle)`
- `wetFresnel(noV, rough)`（单调、边界 noV=1 ⇒ F0、noV=0 ⇒ 1）
- `wetShininess(rough)`（单调递减）
- `skyEnvMixAt(ry, rough)` → 0..1（ry 低 ⇒ 0、ry 高 ⇒ 1；粗糙 ⇒ 过渡更缓）
- `puddleAllowed(rough)`（rough ≥0.8 ⇒ 0）
- `wetAboveWaterGate(worldY, waterY)`（沿用既有语义：严格小于才算水下）

## 7. 已知近似与边界（写清楚，不藏）

1. **屋檐下的地面会湿**。逐片元「上方有没有屋顶」在本仓拿不到免费信号：
   - `skylight` 不行：树叶 `opaqueTable=1` 会阻断 skylight ⇒ 树下地面被判为干，
     **违反用户「树叶不拦雨」的既有裁定**；
   - 阴影图不行：`?shadows=0` 与夜里 `uShadowStrength=0` 时失效，且引入耦合。
   ⇒ 本轮只用**玩家级室内门**（`isUnderRoof`，已有）+ 水下门 + 朝向权重。
   若用户实玩提出，再单独设计（属新需求，不在本轮）。
2. **反光不是真实倒影**：映的是天空渐变，不会映出旁边的建筑。用户已裁定接受。
3. **正午天空环境近似单色**：`VISUAL_STYLES.noon` 的 `sky` 与 `fogColor` 都是 `0x87ceeb`
   ⇒ 天顶/地平线同色。傍晚/夜里有层次（`dusk` sky `0x8890a6` / fog `0xa8897a`）。
   这是复用既有风格数据的必然结果，不新增权威。
4. **湿表面无动画**（用户未选涟漪）。雨丝与水花提供动态感。

## 8. 文件清单

### 8.1 删除（**需用户在批准本稿时一并确认**；全部已在 HEAD `c879a0f` 里，`git show` 可恢复）

| 路径 | 行数 | 理由 |
|---|---|---|
| `src/render/wet-ground.js` | 255 | 上游湿地面 TSL，整体废弃 |
| `src/render/wet-ground-config.js` | 201 | 其常量与纯函数 |
| `src/render/ground-reflect.js` | 185 | 第二条反射 pass |
| `src/render/ground-reflect-config.js` | 144 | 其常量与四个纯函数 |
| `src/render/storm-grade.js` | 340 | 整条后处理链（用户裁定） |
| `src/render/storm-grade-config.js` | 187 | 其常量与纯函数 |
| `src/tests/test-ground-reflect.js` | 164 | 只测被删模块 |

### 8.2 新建

| 路径 | 内容 |
|---|---|
| `src/voxel/wet-material-data.js` | `WET_CLASS` 枚举 + `WET_CLASS_DATA`（150 项显式分类），three-free |
| `src/render/wet-surface-config.js` | 类参数表 + 全局常量 + §6.5 纯函数，three-free |
| `src/render/wet-surface.js` | uniform 单例 + `createWetSurfaceNode()` |
| `src/tests/test-wet-surface.js` | Tier 1（分类覆盖 / 参数关系 / 纯函数 / mesher 位） |
| `tests/wet-surface.spec.mjs` | Tier 4（见 §9.2） |

### 8.3 修改

| 路径 | 改什么 |
|---|---|
| `src/voxel/block-registry.js` | 新增 `wetClassTable`（Uint8Array）+ import `WET_CLASS_DATA`；`register()` 内派生。**不改签名、不改顺序** |
| `src/mesh/mesher.js` | 两条发射路径（模板 quad / 立方体）各 OR 上 `wetClassTable[id] << 15`；新增 `WET_CLASS_SHIFT` 常量 |
| `src/render/materials.js` | 换 import 与调用为 `createWetSurfaceNode`；`makeMaterial` 的 `wet:true` 给 **opaque 与 cutout**；返回 `wet: WET_SURFACE_UNIFORMS`；`dayNight` 增加两个天空色句柄 |
| `src/render/render-world.js` | 构造参数 `wetReflect` → 删除（新分支不需要反射句柄）；文件头注释更新 |
| `src/render/daynight.js` | `_apply` 末尾写 `uWetHorizon`（`p.fogColor`）/ `uWetZenith`（`p.sky`），句柄缺失跳过（同既有容错口径） |
| `src/render/ocean.js` | 删 `_wetPlaceholder`/`placeholderTexture`、`reflectMatrix`、`setWetReflectNode`、`setWetReflectMatrix` 及 `renderReflection` 内的占位图切换段 ⇒ 反射段回到 v3.30 之前 |
| `src/core/game.js` | 删 4 个 import 段与 `groundReflect`/`stormGrade` 全部装配、`_renderGroundReflection`、`_stormReflectVisible`、`_lastGroundDt`、pipeline 分支、dispose 三行；`setStormLighting`/`_updateStorm` 只留雨 + `uWet` + 雨声；`RenderWorld` 构造去掉 `wetReflect` |
| `src/ui/settings-panel.js` | `_rowStormLighting` 的注释更新（文案 `雨天光影`/`关闭`/`开启` **一字不动**，落位不动 ⇒ 面板高度冻结断言不受影响） |
| `src/tests/test-storm-rain.js` | 删 wet-ground / storm-grade 两段 import 与对应用例；保留全部雨丝/水花/音频用例 |
| `src/tests/index.html` | 删 `test-ground-reflect.js`，加 `test-wet-surface.js` |
| `tools/test-tiers.mjs` | Node 白名单同上替换；PIXEL 档加 `wet-surface` |
| `tests/storm-lighting.spec.mjs` | 删 grade/bloom 断言与「bloom 级数减一」用例（改为只钉雨丝减半）；`materials.wet.uWet` 句柄名不变 ⇒ 其余用例不动 |
| `tests/storm-rain-visual.spec.mjs` | 重写为 3 条：雨丝上屏 / 主画面不撕碎（中心天空区）/ 关闭零回归。删竖纹、世界锚定雾、湿地面近中远三条 |
| `tests/storm-underwater.spec.mjs` | 删 2 条颗粒用例；湿地面水下用例改读 `uWetWaterY`（名不变）+ 去掉 `groundReflect.mirrorY` 与 `stormGrade.pipeline.render()` |
| `tests/carbine-flash-wet.spec.mjs` | 删 2 条湿地面用例（火光 2 条保留，文件名不动） |
| `docs/roadmap.md` | 新增 v3.31 行 |
| `docs/pitfalls.md` | 新增「上游独立地面 mesh 的 shader 不能挂到体素通道」节 |

**保留不动**（雨的全部）：`storm-rain.js` / `storm-rain-config.js` / `storm-rain-material.js` /
`rain-shelter.js` / `water-surface.js` / `rain.js` / `weather.js` / 雨声与远雷 /
天气快照还原 / `tests/storm-audio-off.spec.mjs` / `src/tests/test-rain-shelter.js` /
`src/tests/test-water-surface.js` / `tools/bake-carbine-audio.mjs` 及其指纹门禁。

## 9. 验证口径

### 9.1 Tier 1（`src/tests/test-wet-surface.js`，Node 可跑）

1. **分类覆盖**：`BLOCKS` 里每个 `cullMode ∈ {opaque,cutout}` 的方块在 `WET_CLASS_DATA` 有条目（实测 150 个）。
2. **`cloud` 必须是 `NONE`**（用户核心缺陷的直接防线）。
3. **存档兼容**：加了 `wetClassTable` 后 `registry.fingerprint()` 与 `fingerprintOfPrefix(n)` 逐位不变。
4. **参数关系**：`rough(POLISHED) < rough(STONE) < rough(SOIL) < rough(FABRIC)`；
   `specGain(FABRIC) < 0.1`、`specGain(PLANT) < 0.1`；`NONE` 四项 = (0,1,1,0)。
5. **`wetnessAt`**：`uWet=0 ⇒ 0`；底面 ⇒ 0；侧面 = `WET_WALL_FACTOR×…`；`NONE` ⇒ 0；水下 ⇒ 0。
6. **`wetFresnel`** 单调递增（noV 递减）、边界值；**`wetShininess`** 单调递减。
7. **`skyEnvMixAt`**：ry=−1 ⇒ 0、ry=1 ⇒ 1；粗糙度越大过渡越缓（同 ry 下更接近 0.5）。
8. **`puddleAllowed`**：FABRIC/PLANT ⇒ 0，POLISHED/STONE ⇒ 1。
9. **mesher 位**（真实 `buildSectionMesh`）：逐方块扫，`packed>>15 & 15 === registry.wetClassTable[id]`；
   且 **bit0–14 逐位等于改动前**（零回归锚点，用同一 view 的两次构建对照）。

### 9.2 Tier 4（`tests/wet-surface.spec.mjs`，真实 GPU 像素）

机位与噪声源冻结沿用既有口径：`?vd=4&seed=12345&skybox=0&weather=clear`、`setStyle('noon')`、
隐藏 HUD、`physics.step=()=>{}`、等 `slotMap.size` 连续 3 次不变、`setAnimationLoop(null)` 后只重渲。

| # | 用例 | 判据（缺陷态必须真红） |
|---|---|---|
| 1 | **云与岩壁零光晕** | 造云簇 + 石墙 + 石地面于同机位；单变量 `uWet` 0↔1。云区与墙面区变化像素占比 **< 0.02**，同时地面区 **> 0.10**（后者防「整体没生效」的恒真） |
| 2 | **材质分层** | 并排 5 块朝上同法线：`smooth_stone`/`stone`/`grass`/`planks`/`pink_wool`。① 读真实 GPU `packed` 验类值 = 期望；② **同一块**依次改 `uWetParams` 里那一项的 vec4（几何/相机/太阳全不动）⇒ 反光强度按 `POLISHED>STONE>WOOD>SOIL>FABRIC` 单调。⚠️ 改的是 uniform 数组元素，不是重新 mesh ⇒ 零几何变量 |
| 2b | **反光量级带** | 见 §6.1b：`smooth_stone` 地面 Δluma ∈ [+6,+40]，且 `grass` 的 Δluma < stone 的一半 |
| 3 | **积水斑非矩形** | 量效应层自身（开−关差分）的「相邻像素差为 0 的比例」接近场景水平（硬格子态该比例极高） |
| 4 | **不过曝** | 开档后整屏 `luma≥250` 占比不高于关档 + 0.005（防加法钳白） |
| 5 | **关闭零回归** | **同一 page 内**把 `uWet` 从 1 写回 0，与「从未开启过」的基线图**逐位相同**。⚠️ 不跨 page 比（`?storm=0` 与 `?storm=1` 是两个 page，天气状态机初值不同 ⇒ 雨丝/水花本就不同，跨 page 比会假红） |
| 6 | **水下归零** | 相机在水上、朝下看湖底；`uWetWaterY` 真实值 vs −1000 ⇒ 湖底带变化占比 > 0.10 |
| 7 | **无 console / GPU 错误** | `errs` 为空（TSL 构造类缺陷只有这条能抓） |
| 8 | **负向：cloud 改成 STONE** | `page.route` 换 `wet-material-data.js`（**goto 之前注册**）⇒ 用例 1 必须 FAIL |
| 9 | **负向：mix 改 add** | 换 `wet-surface.js` 的合成行 ⇒ 用例 4 必须 FAIL |

⚠️ 注入后必须**读回源码确认落地**（用 `edit` 不用 `sed`）；还原用 `cp` 副本，**不用 `git checkout`**。
⚠️ 判据 2 的「同法线单变量」是必须的：不同法线下 N·L/菲涅尔会造出亮度差，
即使分类完全退化也能全绿（v3.14 已实测过这个盲区）。

### 9.3 回归集合

⚠️ **删除文件属于「难以撤销」类，需用户在批准本稿时一并确认**（§8.1 已逐条列出路径与行数）。
它们全部已在 HEAD `c879a0f` 里，`git show HEAD:<path>` 可逐字恢复。
实施时**先 `mv` 到 `/tmp` 下的备份目录再删**（可恢复优于不可恢复），
不用通配符批量删，逐条字面路径。

```
npm run check                                   # 每次改动
node tools/run-unit-node.mjs --only=test-wet-surface.js,test-storm-rain.js,test-mesher.js,test-rain-shelter.js,test-water-surface.js,test-daynight.js
npx playwright test tests/wet-surface.spec.mjs tests/storm-lighting.spec.mjs \
  tests/storm-rain-visual.spec.mjs tests/storm-underwater.spec.mjs \
  tests/carbine-flash-wet.spec.mjs tests/storm-audio-off.spec.mjs \
  tests/water-visual.spec.mjs tests/water-reflect.spec.mjs \
  tests/render-world.spec.mjs tests/light-mesh-sync.spec.mjs \
  tests/m3-fullscene.spec.mjs tests/atlas.spec.mjs tests/unit-fast.spec.mjs
npm run bench -- --check                        # 碰了 materials/mesher 热路径
```

理由：改了 `mesher`（所有 section 的生产者）与 `materials`（三通道材质）⇒ 消费方是全部渲染 spec；
`light-mesh-sync` 逐顶点比 `packed` ⇒ 必跑；`m3-fullscene` 钉内存门 ⇒ 必跑（预期逐位不变）。
**改了 `src/tests/index.html` 注册 ⇒ 命中 AGENTS.md 的「全局基础设施」**，
故**收尾时跑一次 `npm test` 作为里程碑门**（不是每个 Task 都跑）。

### 9.4 冻结数字（不符就停下报告，不擅自改断言）

- `gpuVertexBytes` **193.83 MiB**（bit15–18 是零字节增量）⇒ `m3-fullscene` 200 MiB 门不动。
- `registry.fingerprint()` 逐位不变。
- `packed` bit0–14 逐位不变 ⇒ `test-mesher.js` 175 例与 `light-mesh-sync` 全绿。
- 水面冻结色阶（`water-visual`：luma 95~136、G−R>8、B−G 20~33）不动
  —— 删掉 ocean 的湿挂钩后反射段回到 v3.30 之前，预期逐位回到基线。
- 面板高度冻结（`teleport`/`about-tab`/`settings-resolution`）不动 —— 文案与落位一字未改。

## 10. 留给实施者

- 类参数表的**数值**是初值，按 §9.2 用例 2 的单调关系扇描重标；关系式是判据，绝对值可调。
- `WET_CLASS_DATA` 的最终名单以「150 项覆盖断言」为准。
- `mx_noise_float` 的 octave 数（1 层还是 2 层）按用例 3 的读数定，先取 1 层。
- 若新增 varying 导致编译失败（用例 7 会抓），退路是把 `cls` 作为 float varying 传、片元查表
  （多一次片元查表，但少一个 vec4 slot）。**先试 vec4 方案**。
---

## 11. v3.31 实施期修订（三处偏离本稿，均已实测取证）

### 11.1 新增非物理地板 `WET_REFL_FLOOR = 0.28`（用户第四轮裁定）

§6.1b 预留的三个旋钮**全扇描完毕**，最强组合下抛光石在俯视 32° 时 Δluma 仅 **3.81**，
低于本稿定的目标带下界 **6** ⇒ 按 §6.1b 的规则**停下报告**，未放宽判据。

实测表（真实 atlas 基色 Smooth_Stone 线性 luma 0.3816、天空 0x87ceeb 线性 luma 0.5529、noV 0.530）：

| 旋钮 | fabric | soil | wood | stone | polished |
|---|---|---|---|---|---|
| 基线 MAX=0.55 | 0.03 | 0.19 | 0.41 | 0.56 | **1.46** |
| MAX=1.00 | 0.06 | 0.35 | 0.75 | 1.02 | 2.64 |
| 菲涅尔幂 5→3 | 0.09 | 0.45 | 0.91 | 1.20 | 2.85 |
| F0=0.04+0.16(1−r) | 0.06 | 0.40 | 0.96 | 1.36 | **3.81** |

根因是结构性的：Schlick 在 noV 0.53 时 F≈**0.068** —— 物理上湿石头半俯视只反 7% 的光。
太阳高光也帮不上：该机位 N·H 0.677 而 shin 119~350 ⇒ `pow` 下溢到 0（它是掠射角才可见的项）。

**用户裁定「加非物理地板，反光明显」** ⇒ `floor = WET_REFL_FLOOR × (1 − rough)` 加在 **F** 上。
- ⚠️ **必须随粗糙度衰减**：否则布/植被也反光，材质分层就没了（用户明确否决单一材质）。
- 取值 0.28 是扇描 0.06/0.10/0.14/0.20/0.28 中**第一个让抛光 ≥6 的档**（实测 6.19）。
- **不动既有 `WET_REFL_MAX = 0.55`**（最小改动）。
- 实测分层：抛光 6.19 / 石 2.07 / 木 1.41 / 土 0.54 / 布 0.06 ⇒ 差 100 倍。

### 11.2 `reflK` 加上限钳制（§6.4 的公式修订）

加了地板后 `F + floor` 在 noV→0、rough→0 时可达 **1.28** ⇒ 乘 MAX 后 0.704，
虽然仍 <1 但已逼近；且 specGain/wet 都 ≤1 ⇒ 理论上限 0.704。
为与 CPU 同构纯函数 `wetReflK` 完全一致，两侧都显式 `min(..., WET_REFL_MAX)`：

```
reflK = min((F + floor(rough)) × specGain × WET_REFL_MAX × wet, WET_REFL_MAX)
```

由 Tier 1 的全组合扫描钉住（9 类 × 3 朝向 × 2 积水 × 5 noV = **270 组**，全部 ∈[0, 0.55]）。

### 11.3 类索引必须钳到表长 − 1（自审发现的 Important）

§6.3 写的是 `uWetParams.element(cls)`。但类位是 **4 bit**（能表达 0..15）而表只有 **9** 项
⇒ cls ∈ [9,15] 时**越界读 uniform buffer**（WGSL undefined behavior：可能读 0、读邻项、
或触发验证错误 ⇒ 整片材质不上屏）。CPU 侧纯函数有 `if (!p) return` 回落，两侧**不同构**。

真实可达路径：将来扩类到 >9 却忘了扩数组、或旧 section 缓存里的高位残留。
⇒ 改为 `const clsSafe = min(cls, uint(WET_CLASS_COUNT - 1))`，`element(clsSafe)`。
钳到最后一项（PLANT，wetGain 0.35 / specGain 0.05 = 几乎不湿）而非 NONE —— 后者需额外一次 select。

### 11.4 §9.2 判据的六处口径修正（全部实测推翻，不是放宽）

| # | 本稿原口径 | 实测问题 | 修正后 |
|---|---|---|---|
| 1 | 取样区写死屏幕相对坐标 | 真实投影 cloud fy **0.043** / wall fy **0.641** ⇒ 两区**取到天空**，判据恒真 | 取样区**由真实 `camera.project` 算包围盒** + 三条夹具前提断言；机位由几何算（fov 70°，三目标跨度 37.0°） |
| 2 | 墙面「变化像素计数 < 地面一半」 | 光晕是「变亮」而正确实现是「压暗」；墙压暗 5.2% 让 frac 达 0.667 | 改量**亮度幅度**：墙 Δluma ≤ 0.5 且 \|Δ\| < 6 |
| 3 | 材质分层按最终 luma 排序 | luma 同时吃压暗与反光两个**反向**项（wood 168.89 > stone 166.91） | darken 固定 1 做单变量；屏幕上分不开的中间档交给 Tier 1 |
| 4 | 积水连续性 `eff < 0.60` | 匀质石头贴图的**场景本身**就有 0.8521，效应层 0.8506 | 相对判据 `eff < sceneSame + 0.05` |
| 5 | 注入确认全文件 `includes` | jsdoc 里有同串公式 ⇒ `hasMix` 恒真 | 只扫**代码行** |
| 6 | 负向①取样云底面 | 相机仰视云时底面法线·视线 0.509、侧面 0.861；底面 up=−1 ⇒ orient=0 **完全不湿** | 取云**南侧立面**；负向判据与正向同口径（量幅度） |

另：负向②的过曝判据改**相对倍数**（`on > off × 3`）—— 本机位过曝基数极低（0.00008），
ACES 把高亮压得很扁 ⇒ add×20 后只到 0.00042（上升 5.25 倍），绝对增量远低于 0.005。

### 11.5 最终验证读数

- `npm run check` exit 0（arch 全守住、测试注册 134 / 分档 spec 114 双向钉住、lint **0 error**）
- Node 轻档 **111 文件 / 2366 例全绿**；`test-wet-surface.js` **29 例**
- `tests/wet-surface.spec.mjs` **8/8**（6 正向 + 2 负向真红）
- **云区 frac = 0（逐位不动）**、墙 Δluma **−1.9**、地面 Δluma **−3.5** 且 frac 0.819
- 材质阶梯 polished **186.18** / stone 183.15 / wood 182.53 / fabric 182.55 / none 182.21
- 过曝占比开关**两侧相同 0.00008**；积水连续性 eff 0.8064 < 场景 0.832
- 关闭零回归 **diffBytes = 0**；水下门 frac **0.8699**
- 真 GPU 探针：console errs **[]**、hasGrade/hasGroundReflect **false**、uWet 单变量改变 **79~81%** 像素
- `npm run bench -- --check` **exit 0**（四场景 fps 120.02~120.36 / p95 9.8~9.9）
- `blocks-data.js` 与 HEAD **逐字节相同**；`registry.fingerprint()` = `16d99151`（前缀指纹相等）

---

## 12. 后续增量：v3.32 积水斑的镜面反光

本稿的积水修正（`rough×0.25` / `specGain×1.60` / `albedo×0.88`）**不足以让水汪反光** ——
`wetSpecGainAt` 被 `min(…,1)` 钳死，抛光类本来就是 1.0 ⇒ ×1.60 是恒等。
用户 2026-11-23 实玩报「水汪没有反光」，实测水汪比周边水膜**暗 5.9 luma**。

⇒ 增量设计稿：[`2026-11-23-puddle-mirror-reflection-design.md`](2026-11-23-puddle-mirror-reflection-design.md)
（给积水一条独立于菲涅尔的绝对镜面目标 `WET_PUDDLE_MIRROR=0.70` + 低频云影调制）。
**本稿的 `WET_REFL_MAX` / `WET_REFL_FLOOR` / `WET_SUN_SPEC` / 噪声阈值带一律未动**，
水膜与墙面的公式逐字保留；新增项全部乘 `topGate × uWetPuddleRefl`，
后者写 0 即**逐位回到本稿描述的 v3.31 行为**（第二级零回归锚点）。
