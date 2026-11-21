# 森林落叶与草地萤火虫（v3.26）

> 用户 2026-11-20 需求 + 三项选型裁定。本文是设计文档（项目档）。
> 实施计划：`docs/superpowers/plans/2026-11-20-forest-leaves-and-fireflies.md`。
> 实测数据一律以 §7 为准（本文其余处的数字是设计取值，实施期若与实测不符按 §7 纪律停下报告）。

## 1. 意图与由来

用户原话（两段需求）：

> 我想增加一个新的特效，就是树叶飘落的特效，营造一种秋风萧瑟的氛围，这个树叶飘落的特效
> 只在森林地界存在，当玩家身处森林地图的时候，在贴近地面的高度（毕竟树叶飘落是从树上飘落的，
> 高于树的地方是不应该有树叶飘落的），有随风飘落的树叶，简单起见树叶落地后就消失，就和雨滴
> 类似，落到地上就消失掉，树叶的颜色你采集一下现在树叶方块的颜色，树叶不用纹理，一片树叶就
> 单色即可，主要是要做好飘落的动画，围绕玩家身边周围有一个飘落的动画，尽量不要太影响整体
> 游戏的性能，至少不要让游戏性能变差太多，不要影响当前游戏的流畅度。
>
> 另外，在草地地图上，增加一个萤火虫飞舞的特效，稀稀落落的萤火虫在玩家身边飞舞，营造出一种
> 充满生机的模样。

**三项选型裁定**（`ask_user_question` 实测回答）：

| 问题 | 用户选择 | 被否的选项与理由 |
|---|---|---|
| 落叶配色 | **秋色加权** | 「照真实比例采色」⇒ 森林真实叶种是绿 60% / 黄 25% / 巨树 15%，加权期望色实测 sRGB **71,119,44**（r/g=0.597）= 偏绿，秋意弱；「只用黄叶色系」⇒ 绿树一棵不落叶时不自然 |
| 萤火虫时段 | **全天都有，夜里更亮** | 「只在黄昏与夜里」⇒ 白天进草地看不到这个特效；「全天恒定」⇒ 白天偏淡、夜里偏亮，两头不讨好 |
| 玩家开关 | **默认开启 + 性能档自动减量；把设置面板的「雾色」那一组换成「萤火虫和落叶」（开启/关闭两按钮），雾色恒开不再可关** | 「只走 URL 不进面板」⇒ 玩家点不到；「面板新增一行」⇒ 撞「面板不得出现纵向滚动条」的冻结断言；「右下角常驻小坞」⇒ 多一块常驻 UI 要与迷你地图/快捷栏核避让 |

第三项的用户原文：

> 默认开启，性能档自动减量，把设置面板中的雾色去掉，雾色默认就是开启，不要关闭了，
> 把雾色配置换成"萤火虫和落叶"，有开启和关闭两个按钮。

## 2. 目标 / 非目标 / 反目标

**目标**
- FOREST：玩家周围有一圈**单色小叶片**从树冠高度飘落，带摆荡与翻飞，落地即消失。
- PLAINS：玩家周围有**稀疏的萤火虫**飞舞，自发光 + 呼吸闪烁，夜里更亮更密。
- 两个特效共用一个面板开关（默认开），性能档自动减量。
- 零新增贴图 / 零烘焙产物 / 零新增方块 / 零音效 / 零依赖。

**非目标**
- 不改地形生成、不改植被撒布、不改树叶方块本身（叶种权重 `pickLeaf` 一个字节不动）。
- 不改雨滴的任何参数与断言（267 滴 / 534 顶点 / `uOpacity=0.6` / 30Hz / 64 批）。
- 不改雾色的渲染语义（`uFogColorMix` 的两态与 `setupFog` 公式逐字不动）。
- 不做落地堆积、不做叶子上脚、不做风向随天气变、不做萤火虫被玩家惊飞。
- 不改 UI 层级不等式（两个特效都是 3D 场景内容，不是 DOM 覆盖层）。

**反目标（做成了也算失败）**
- 非森林/非草地时仍有常驻 draw call（对应池必须 `visible=false`）。
- 落叶出现在**树冠之上**（用户明确点名：「高于树的地方是不应该有树叶飘落的」）。
- 落叶穿过地面继续下落，或落在半空（必须 `isSolid` 截停）。
- 萤火虫读作「绕圈的粒子」或「一片白点」（要三轴异频 + 黄绿色相）。
- 落叶读作「绿色碎屑」而不是秋色（配色权重必须真的生效）。
- 帧时相对 HEAD 回退（bench 冻结基线）。
- 面板出现纵向滚动条。

## 3. 现状与约束（已核实）

### 3.1 可复用的基建

| 基建 | 文件 | 本轮用途 |
|---|---|---|
| 「围绕玩家的粒子场」骨架 | `render/rain.js` | 30Hz 距离检查 + 分批迁移削峰 + `isSolid` 地面截停 + `frustumCulled=false`，**语义照搬** |
| GPU instanced 粒子池 | `render/spike-fx-material.js:createSpikeSparkGeometry` | `THREE.Mesh` + `InstancedBufferGeometry` + 逐实例属性，**结构照搬** |
| 逐实例色（不写共享 opacity） | `render/spike-fx.js` 的 `setColorAt` 口径 | 本轮改用 instanced `aColor` 属性（无 instanceMatrix，见 §3.3） |
| 方块平均取色 | `render/block-color.js` 的 `createAtlasColorResolver` | 落叶颜色**复用 `blockHitFx` 已建的那个 resolver**（见 §4.1），不新建第二个 |
| biome 权威 | `gen/noise.js:getBiome` | 门控唯一入口（不写第二份阈值） |
| 夜间因子 | `render/daynight.js:nightBlendOf` | 萤火虫亮度/密度派生自它（不新增权威） |
| 分辨率档 → 粒子数 | `game.js:rainParticleCount` / `_rebuildRain` | 同一手法（构造期固定顶点数 ⇒ dispose 重建） |
| 倒影隐身列表 | `game.js:_renderWaterReflection` 的 `hidden` | 两个池都进（成本主杠杆是 draw call） |

### 3.2 载荷性约束（违反任一都是「非像素判据全绿而画面全错」）

1. **粒子必须 `THREE.Mesh` + `InstancedBufferGeometry`**，不能 `InstancedMesh`：后者的
   instanceMatrix 接管 modelViewMatrix，会把由 `aOrigin` 定位的粒子全塌到原点（v3.21 实测）。
2. **世界摆放走 `vertexNode`**（`positionNode` 的返回值会被 `modelViewMatrix` 再乘一次）。
3. **逐实例参数走 instanced attribute + `varyingProperty`**：片元阶段读不到 instanced 属性
   （v3.20 实测），直读 `positionGeometry` 会静默拿 0。
4. **常量色显式拆分量 `vec3(c.r,c.g,c.b)`** —— `vec3(new THREE.Color(hex))` 在 WebGPU 输出
   纯黑且零报错（v3.14 实测非黑像素 0 vs 10455）。
5. **节点不得与裸 JS 数字算术**（`float(x)*1.4` 生成 `NaN.0` 废掉整条管线），一律 `.mul()`。
6. **多层 mix 嵌套**，不得链式 `.mix()`（v3.21 实测暖色像素 78620→88）。
7. **`Fn` 不返回多键对象**（SplitNode 陷阱，自定义键全 undefined ⇒ 整片 pass 不上屏）。
8. **uniform 按调用闭包捕获**，不用模块级 `let U`（TSL `Fn` 体惰性求值，v3.22 实测两个池
   会互相覆写 uTime）。
9. **`aSpawn`/时间属性与 `uTime` 同一时钟（绝对秒）**（v3.20 实测混时基 ⇒ 粒子瞬间全灭）。
10. **径向量必须在片元算**：quad 只有 4 顶点，顶点算 `length()` 插值后恒为常数
    （v3.23 实测整片 quad 一起亮再整片消失）。本轮萤火虫的光晕径向衰减受此约束。
11. **空闲 `visible=false`**：否则恒增 draw call，且常驻透明 mesh 进透明排序列表干扰
     水面顺序不变式（`water-order.spec.mjs` 守）。
12. **时间基准 `performance.now()`**，禁 `Date.now()`。
13. **每帧零分配**：临时对象一律模块级常量。

### 3.3 已实测的关键数字（本轮探针，不是引用旧结论）

| 项 | 实测值 | 探针口径 |
|---|---|---|
| `getBiome` 单次成本 | **0.028 µs**（20 万次 5.6ms） | Node，warm 后计时 |
| 森林矮树叶层（相对地面） | **+2..+4** | `generateTree('default')` 收集叶格 |
| 森林高树叶层（相对地面） | **+8..+11**（单棵），33×33 范围聚合 **+4..+14** | 同上 + `rollVegetation` 真实抽签（32 棵） |
| 巨树叶层（相对树干底） | tallOak **2..41**、snowSpruce 2..37、cherry 0..26、palm 7..21、banyanLeafy 3..20 | `assets/giant-trees/trees.json` 逐变体扫 palIdx |
| FOREST 真实叶种权重 | leaves 0.60 / yellow 0.25 / 四种巨树各 0.0375 | `vegetation.js:pickLeaf(σ,tall=true)` |
| 六个叶种 atlas 均色（sRGB） | leaves 28,109,47 / yellow 124,132,21 / 巨橡 28,110,48 / 云杉 32,88,57 / 棕榈 42,140,51 / 榕 79,172,70 | 不透明像素均值（alpha<8 剔除） |
| 真实权重期望色 | sRGB **71,119,44**（r/g 0.597） | 线性空间加权后转 sRGB |
| 秋色 B 档期望色 | sRGB **106,135,39**（r/g 0.785） | 同上 |
| 正午草顶屏幕色 | **68,128,52** | linear × ACES(曝光1) → sRGB |
| 夜间草顶屏幕色 | **31,69,23** | ×skyDim 0.25 × ACES(曝光1.6) |
| `cloud` 是 solid | **true**（`cullMode:'opaque'`） | `BLOCKS` 声明 |
| bench 冲刺走廊 biome | x620..945, z=−100 ±14：**DESERT 7385 / PLAINS 2069**（PLAINS 21.8%） | 逐格 `getBiome` |
| bench 其余三场景 biome | 城市中心 / TNT 场地 / cinder 开阔地：**全 DESERT** | 同上 |

### 3.4 ⚠️ 既有 spec 的机位 biome（本轮实测 —— 决定哪些用例必须加隔离）

新池按 biome 自动激活 ⇒ **既有 Tier 4 用例的机位若落在 FOREST/PLAINS，画面里就会多出动画**，
它们的「噪声底必须为 0」类断言会被打破。逐条实测（seed 12345）：

| spec | 机位 | biome | 会不会被打破 | 处置 |
|---|---|---|---|---|
| `water-visual`（3 条） | (−504,−528)（扫描窗口最低点） | **PLAINS** | **会**：`frameDiff` 噪声底断言 `<0.02`（实测 0） | 加 `?ambient=0` |
| `water-reflect` | STAND (616,158) | **PLAINS** | **会**：`noise.frac` 必须 **=== 0** | 加 `?ambient=0` |
| `jungle-fortress`（2 条像素） | 要塞 (−304,217) 周边 | **FOREST** | **会**：`greenFrac` / `meanLum` 噪声底 `<1.0` | 加 `?ambient=0` |
| `ignis-fx`（offset 900 那条） | (908,908) | **FOREST** | **会**：`noiseFloor < 80` | 加 `?ambient=0` |
| `ignis-fx`（offset 600/1800） | (608,608) / (1808,1808) | DESERT | 不会 | 不动 |
| `ignis-spike` / `cinder-fall`（offset 1200） | (1208,1208) | DESERT | 不会 | 不动 |
| `ignis` / `guardian` 的像素用例 | 祭坛 (1000,200) / 堡垒 | FOREST / DESERT | **不会**：它们 `setAnimationLoop(null)` 后手动 render ⇒ `leafFx.update` 不再被调 ⇒ uTime 冻结 ⇒ 粒子静止 | 不动 |
| `boss-hint` 像素 | 祭坛 (1000,200) | FOREST | 不会：采样区是 **DOM 文字区**，落叶在它下面且判据只数金色 | 不动 |
| `giant-tree-budget` | 视域 (−312,168) 等 | FOREST | 不会：只读 `reservedV`，粒子**不进 BatchedMesh** | 不动 |
| `giant-trees` / `arena` / `tarn-*` / `*-gen` | 各异 | 混合 | 不会：只读世界方块 / reservedV | 不动 |
| `zombies` 的 draw ==6 | 出生点 (8,8) | DESERT | 不会 | 不动 |
| `m3-rain` / `render-terrain` / `city-visual` | 出生点 | DESERT | 不会 | 不动 |
| `water-order` | 岸边 (−32,40) | DESERT | 不会（两池 invisible ⇒ 不入透明队列） | 不动 |
| `sky-structures` / `skybox` / `dusk-style` / `sun-*` / `hemisphere-*` | 高空 / 出生点 | DESERT 或相机在 80~400 格高 | 不会（出生点 DESERT；高空机位的粒子在视野外） | 不动 |

⇒ **必须提供 `?ambient=0` 隔离入口**（§4.7），并只在上面标「会」的 4 个 spec 里加它。
**不得**为了让新特效通过而放宽那些既有噪声底断言。

### 3.5 `instanceCount` 的取舍（决定：不用它调密度）

已核实 `three.webgpu.js:30220` 每次 draw 都读 `geometry.instanceCount`、`:30228` 为 0 时返回 null。
但**「改它能否在已建好 bindGroup 的 mesh 上立即生效」本轮没有 GPU 实测** ⇒ 不作为设计依赖。

**决定：容量固定，密度靠逐实例存活标志**（`aAlive` 乘进尺寸，0 ⇒ 缩零不可见）——
这是本仓六个粒子池已验证的成熟手法，零新风险。萤火虫白天也有（count>0）⇒ 不需要
「instanceCount=0 省 draw call」那条优化；池的 `visible=false` 已经覆盖了「非草地零成本」。

⚠️ **`cloud` solid 的后果**：雨滴已记过「雨会停在云顶」。落叶的向下扫描同样会停在云顶 ——
但云簇在 Y=35/55，而落叶的出生高度上限是「地面+14」（§4.1），**扫描窗口根本到不了云**
⇒ 本轮不受影响。这一条要写进代码注释，防后人把出生带抬高后踩坑。

⚠️ **bench 冲刺会穿过 PLAINS 段**（21.8%）⇒ 萤火虫池会在场景①里被激活 ⇒
`drawCalls` 是 STRUCTURAL 指标（容差 2%），基线 489 的 2% = 9.8，**+1 draw call 在容差内**；
但 `sections` / `voxelBytes` / `gpuVertexBytes` 不受影响（粒子不进 BatchedMesh）。
这一点必须在实施期用 `bench -- --check` 实证，不得只靠推理。

## 4. 设计

### 4.1 落叶（FOREST）

**出生带（用户点名的硬约束）**

```
topY  = groundY(x,z) + LEAF_FX.birthMin + rand × (birthMax − birthMin)
birthMin = 3, birthMax = 13
```

- `groundY` = 该列**从上往下第一个实心格的顶面**（`isSolid` 扫描，同 `rain._resolveRainMinY`）。
- 上界 13 的依据：33×33 森林范围内代码生成树的叶层聚合上界实测 **+14**，取 13 留 1 格余量
  ⇒ 出生点**恒在树冠高度带内或以下**，不会在树顶之上凭空生叶。
- ⚠️ **巨树（最高 41 格叶层）刻意不覆盖**：它们是稀疏景观（spacing 32），为它们把出生带抬到
  40 会让绝大多数普通树上方全是凭空落叶 —— 那正是用户否掉的形态。巨树脚下的落叶来自
  同一带的普通树，观感上仍是「树在落叶」。这一取舍写进代码注释。
- `minY` = `groundY + floorOffset(0.02)`；GPU 下落到 `minY` 即钳住。
- **落地后 0.6s 淡出并回收**（`landFadeSeconds`）：出生带 3~13 格 ÷ 下落 0.55~0.9 格/秒
  ⇒ 落地时刻 **3.3~23.6 秒**，故**不设固定寿命**，寿命由「落地 + 淡出」派生。
  容量 220 片、半径 18 ⇒ 稳态就是「220 片都在飘」，回收即在玩家周围重新出生。

**运动（三项叠加，全在顶点着色器）**

```
y(t)   = max(topY − fallSpeed × t, minY)                    // 匀速下落，非抛物线
x(t)   = originX + swayAmp × sin(swayFreq × t + phase)      // 水平摆荡（风）
z(t)   = originZ + swayAmp × cos(swayFreq × 0.83 × t + phase)
rot(t) = vec3(spinX × t + phase, spinY × t, spinZ × t)      // 三轴自转（翻飞）
```

- `fallSpeed ∈ [0.55, 0.90]` 格/秒 —— 比雨滴（24）慢约 **30 倍**，读作「飘」不是「掉」。
- `swayAmp ∈ [0.5, 1.1]` 格、`swayFreq ∈ [0.6, 1.3]` rad/s。
- 自转用 TSL 的 **`rotate(positionNode, vec3(...))`**（已程序化核实 `RotateNode` 存在且
  `isNode===true`，`vec3` 分支走 `Rx·Ry·Rz`）—— 不自己拼矩阵。
- ⚠️ **落地后必须停摆荡与自转**：`y` 被钳在 `minY` 之后若继续摆荡/翻飞，读作「叶子在地上
  打转」。实现口径：把 `t` 换成 `tEff = min(t, tLand)`，`tLand = (topY − minY)/fallSpeed`。

**形状与着色**

- 几何：单 quad（4 顶点 / 6 索引），边长 `LEAF_FX.size ∈ [0.10, 0.18]` 格（逐实例随机）。
  ⚠️ 尺寸下限 0.10 的依据是 v3.23 实测：0.055 在 4~8 格距离只投影 **2.3px** ⇒ 画面上等于没有。
  本轮距离更远（半径 18），故取 0.10~0.18 并在 §5 用像素实测复核。
- **无贴图**、**单色**（用户明确要求）：`aColor` 逐实例线性 RGB。
- **`NormalBlending`**（不是 additive）：落叶是不透明实体，additive 会让它在亮草地上消失。
- 逐实例亮度（**朝向近似**，在顶点算成 varying `vShade`）：`mix(sideShade, 1.0, abs(cos(rotX)))`，
  `sideShade = 0.845`（= `sun-shade.js` 标定的正午侧面亮度，同一语义不另拍一个数）
  —— 薄片翻到侧面时略暗，读作「有厚度」。
  ⚠️ 刻意**不接体素的太阳方向 uniform**：落叶是自由翻转的薄片，接方向光会让它一半时间全黑。
  ⚠️ **它不是 instanced 属性**（由 rotX 实时算出）—— 早稿曾写作 `aShade` 属性，那会多一个
  每帧要上传的缓冲而且与旋转不同步；以本条为准。
- **昼夜与环境亮度：直接引用体素那两个 uniform 实例**（红线 1，同 `turret-metal` 复用
  `dayNight.uSunDirection` 的手法）：装配层把
  `renderWorld.materials.dayNight.uSkyDim` 与 `.uShadowStrength` 传进材质工厂，
  片元里乘 `mix(1.0, uSkyDim, uShadowStrength)`。
  ⇒ **白天逐位乘 1（零回归）、夜里自动跟着体素变暗、关阴影时不受影区影响**，
  且日夜插值无需 CPU 每帧写任何东西。⚠️ 两个句柄缺失时（fixture 路径）退化为常量 1。
- `alphaTest` 不用（无贴图）；`depthWrite=false`、`depthTest=true`、`side=DoubleSide`
  （薄片翻到背面也要看得见）、`fog=false`（同既有特效，否则远处被雾洗成天空色）。
- `renderOrder = 3`（体素水 0 < 海面 1 < 曳光 2 < 特效 3，与 Cinder/Storm/火圈同档）。

**秋色权重（用户裁定「秋色加权」，取实测 B 档）**

| 叶种 | 权重 | 线性色（atlas 实测） |
|---|---|---|
| `yellow_leaves` | **0.65** | 0.2024, 0.2320, 0.0077 |
| `giant_banyan_leaves` | 0.12 | 0.0790, 0.4137, 0.0608 |
| `giant_palm_leaves` | 0.08 | 0.0235, 0.2603, 0.0334 |
| `leaves` | 0.10 | 0.0117, 0.1539, 0.0288 |
| `giant_spruce_leaves` | 0.05 | 0.0143, 0.0983, 0.0402 |

- 合计 **1.000000**（单测钉住；不写归一化兜底 —— 权重和不为 1 时必须红，而不是静默缩放）。
- `giant_oak_leaves` 权重 **0**：它与 `leaves` 的均色实测几乎相同（28,110,48 vs 28,109,47），
  列进去只是把同一个色写两遍。**表里不列它**（避免「六个叶种」的假完整性）。
- 期望色 sRGB **106,135,39**（r/g **0.785**，真实比例是 0.597）⇒ 明显转黄。
- ⚠️ **权重是「落叶自己的观感表」，不是 `pickLeaf` 的副本**：后者是**世界树叶**的权威，
  一个字节不动。两者刻意不同（用户裁定），故各自成表、各有单测，注释里写清「不是同一事实」。

**颜色来源：复用既有 resolver（不新增烘焙产物、不新建第二个取色器）**

- 装配层**复用 `blockHitFx` 那个 `blockColorResolver`**（`game.js` 已在 `start()` 中段建好）：
  签名 `(blockName, normal) => linearRGB`，传 `[0,1,0]` 取顶面。本轮构造紧跟其后即可。
- ⚠️ **不在渲染层写死 hex**：atlas 是产物，换贴图后颜色必须跟着变（红线 1）。
- ⚠️ **不再调一次 `createAtlasColorResolver`**：那会把 2048² 的 atlas 再读一遍像素
  （`readAtlasPixels` 建 canvas + `getImageData`），纯浪费且是第二份缓存。
- resolver 为 null（取色失败）时**跳过落叶装配**（置 null，下游 `?.`）——同 `flameSigil` 口径，
  不拿兜底灰建一个「颜色错了但看得见」的池。**萤火虫不依赖取色**（常量色）⇒ 仍装配。

### 4.2 萤火虫（PLAINS）

**分布与运动**

```
半径 R = 14 格（圆内面积均匀：r = R × sqrt(rand)）
高度 = groundY + [0.4, 2.6] 格
pos(t) = origin + vec3(
  driftX × t + ampX × sin(fx × t + px),
                ampY × sin(fy × t + py),
  driftZ × t + ampZ × sin(fz × t + pz))
```

- **三轴异频**（`fx/fy/fz` 互不相同且非整数倍关系）⇒ 李萨如式游走，读作「乱飞」而不是绕圈。
- `driftX/Z ∈ [−0.25, 0.25]` 格/秒（慢漂移），`amp ∈ [0.3, 0.9]` 格，`f ∈ [0.5, 1.6]` rad/s。
- **y 不漂移**（只正弦）⇒ 不会飘上天或钻地。钳制 `max(groundY + 0.25, y)` 兜底。
- 寿命 `[6, 12]` 秒，到期淡出后在玩家周围重新出生（**不是环形缓冲覆盖**：萤火虫是常驻场，
  没有「一次 spawn」的概念）。

**发光与呼吸**

- `AdditiveBlending`（自发光）、`depthWrite=false`、`depthTest=true`、`fog=false`。
- 屏幕对齐 billboard 小点：核心 + 光晕两层，**径向量在片元算**（约束 10）。
  轮廓 `core = 1 − smoothstep(0, 0.35, r)`、`halo = pow(1 − r, 2.2)`，quad 比可见光晕大一圈
  ⇒ 几何硬边落在完全透明处（v3.20b「发光鸡蛋」的既有教训）。
- 呼吸：`breathe = 0.15 + 0.85 × pow(0.5 + 0.5 × sin(bf × t + bp), 3)`
  —— 三次幂让「暗的时间长、亮的时间短」，读作闪烁而不是匀速正弦。
- 颜色 `#c8ff50`（黄绿）。实测（CPU 复刻 ACES）：正午草地背景上 gain 0.6 时
  Δ = **[127, 95, 41]**，夜间 Δ = **[182, 163, 72]** ⇒ 两档都满足「r 增 > 20 且 b 增显著小于 r 增」。
- ⚠️ **gain 上限**：实测 gain 2.4 时夜间 Δb 已到 159（开始钳白）⇒ 取 **day 0.55 / night 1.15**
  两档，中间按 `nightBlend` 插值。**不取 1.6 以上**。

**夜间联动（用户裁定「全天都有，夜里更亮」）**

```
nb     = nightBlendOf(dayNight.params)        // 既有权威，0=白昼 1=深夜
gain   = mix(GAIN_DAY, GAIN_NIGHT, nb)       // 0.55 → 1.15
count  = round(mix(COUNT_DAY, COUNT_NIGHT, nb))  // 白天基数 → 夜里 ×1.5
```

- **密度变化走逐实例 `aAlive`**（见 §3.5 的决定）：容量按夜间上限分配，CPU 每帧把
  前 `count` 个置 1、其余置 0（乘进尺寸 ⇒ 缩零不可见）。**不重建几何、不改 instanceCount**。
  ⚠️ 只在 `count` 真的变了时才写属性并置 `needsUpdate`（日夜插值下它每帧都在变，
  但 `round` 后多数帧相同 ⇒ 一次整数比较即可跳过上传）。
- ⚠️ **`nightBlendOf` 对手动风格显式给值**（dusk 显式 0），不能从 skyDim 倒算 —— 直接调
  该函数即可，不自己写公式。

### 4.3 门控与跟随（两个池共用语义）

```
每帧：
  uniforms.uTime = 累计秒（绝对时钟，与出生属性同源）
  若 5Hz 节流到期：
      biome = getBiome(floor(px), floor(pz), seed)     // 唯一权威
      want  = (biome === 'FOREST')  /  (biome === 'PLAINS')
      若 want 且 enabled → 池 visible=true；否则 visible=false 且 return（零成本）
  若 30Hz 节流到期且玩家移动 > refreshDistance(8) 或 |dy| > 6：
      启动分批迁移（每帧 ≤ 32 片，只改 origin/groundY，不改相位与速度）
  推进寿命/回收（落叶）或呼吸相位（萤火虫）
```

- **biome 门控用 `getBiome` 而不是 `game.biomeAt`**：后者会把 CITY 覆盖成 `'CITY'`，
  而城市是压平的 DESERT/PLAINS 地表 —— 城市里**不该**有落叶（那是建筑群），
  但萤火虫在城市的草地边缘出现是合理的。⚠️ 取舍：**两个池都用 `getBiome`**（自然 biome），
  理由是「特效跟着地表植被走，不跟着行政边界走」；城市内自然 biome 实测全 DESERT
  ⇒ 两个池在城市中心都不出现，与用户「只在森林/草地」的表述一致。
- **`visible=false` 时直接 return**：不推进时间、不做迁移、不查体素 ⇒ 非目标 biome 零成本。
  ⚠️ 但 `uTime` 必须**继续累计**（否则回到目标 biome 时 `age` 会跳变）——
  故 `uTime` 写在 return 之前。
- 关闭开关时同样 `visible=false` + 零成本，且**不清空缓冲**（重开时立刻有内容，不闪断）。

### 4.4 装配层接线（`core/game.js`）

| 位置 | 改动 |
|---|---|
| import | 两个渲染器 + 两张 config |
| `start()` 内（`blockHitFx` 之后、`flameSigil` 附近） | 构造两个池，注入 `world` / `seed` / **既有 `blockColorResolver`** / `playerPos` / 粒子数（按 `settings.pixelRatio`）/ **体素的 `uSkyDim` 与 `uShadowStrength` 句柄** |
| 帧循环（`rain.update` 之后） | `this.leafFx?.update(pp, dt)` / `this.fireflyFx?.update(pp, dt, nightBlend)`（`nightBlend = nightBlendOf(this.dayNight.params)`） |
| `_renderWaterReflection` | `hidden.push(...this.leafFx.meshes)` / `...this.fireflyFx.meshes` |
| `setPixelRatioMode` | 追加 `_rebuildAmbientFx(m)`（照 `_rebuildRain`） |
| 新方法 `setAmbientFxEnabled(v)` | 写两个池的 enabled + 立即同步 visible（返回实际生效值） |
| `dispose()` | 两个池 `?.dispose()` |
| `main.js` | `?ambient=0` → 构造选项 `ambient`（不持久化，同 `?reflect=0`） |

⚠️ **装配顺序**：必须在 `this.world` 与 `blockColorResolver` 就绪之后（取色依赖 atlas）。
`blockHitFx` 的取色块已在 `start()` 中段，本轮紧跟其后即可。
⚠️ **`_rebuildAmbientFx` 必须同时重建两个池**（粒子数是几何容量，构造期固定），
且重建后要把 `enabled` 与当前 biome 门控重新喂一次 —— 否则切分辨率后特效静默消失。

### 4.5 面板改动（用户裁定）

- `_rowFogColor` → **`_rowAmbientFx`**：标题「萤火虫和落叶」，两按钮「关闭/开启」，
  绑 `settings.ambientFx` + `game.setAmbientFxEnabled(v)`。**不置灰**（无异步前置条件）。
- `_combinedFogMusic` → **`_combinedAmbientMusic`**：仍是「新开关 + 背景音乐」两列合并盒
  ⇒ **面板高度逐位不变**（同一个 `_makeCombined`、同样两按钮）。
- 标题与按钮文案**导出为常量**（`AMBIENT_ROW_TITLE` / `AMBIENT_LABELS`），
  供 `src/tests/test-ui.js` 钉住（同 `RESOLUTION_ROW_TITLE` 手法）。
- ⚠️ **标题长度**：「萤火虫和落叶」6 字，与既有最长组标题「TNT 破坏」（6 字符+空格）同量级，
  合并盒列宽约 171px ⇒ 放得下。实施期必须用**行盒数**实测（`scrollWidth<=clientWidth`
  对折行无判别力）。

**雾色恒开**

- `DEFAULT_SETTINGS.fogColor` **保留字段但恒 true**：`resolveSettings` 不再从存储读它，
  `?fog=0` **保留**（Tier 4 隔离入口，`fog-color.spec` / `sun-shadow.spec` 依赖它）。
- ⚠️ **不删 `setFogColorEnabled` / `fogColorEnabled`**：`fog-color.spec.mjs` 的 5 条用例
  全靠它们做单变量对照。删了等于删掉那些门禁。
- `settingsVersion` **不 +1**：`fogColor` 的既有迁移（v2）语义不变，只是玩家侧不再有入口；
  旧存档里的 `false` 仍被迁移丢弃 ⇒ 恒开。新增 `ambientFx` 字段旧存档没有 ⇒ 自然回落默认开
  （与 `pixelRatio` / `chunkPace` 同理，无需迁移）。

**既有测试的处置（按 testing-policy §4.2「钉值的随载体更新，钉不变式的迁移」）**

| 用例 | 处置 |
|---|---|
| `fog-color.spec.mjs` 前 4 条（像素不变式） | **一字不动**（走 `?fog=0` + `setFogColorEnabled`，两者都保留） |
| `fog-color.spec.mjs`「启动默认开启雾色」里面板高亮那段 | 改为断言**新开关**默认高亮「开启」；雾色部分只断言 `settings.fogColor===true` 与 `mix===1` |
| `fog-color.spec.mjs`「面板『雾色』行落在左列…」整条 | **改写**为「面板『萤火虫和落叶』行落在左列环境风格下方、与背景音乐同盒」；删掉「无天空盒时整组禁用」（新开关不置灰），保留「环境风格『自动』按钮必须还在」 |
| `test-ui.js` 的 fogColor 三条 | **保留**（`resolveSettings` 仍认 `?fog=`，存储不再采信 ⇒ 把「当前版本的存储关生效」那条改成「存储值不再被采信，恒开」） |
| `test-ui.js` 里引用 `TAB_*` / `ABOUT_*` 的用例 | **不碰** —— 那是 v3.25「关于 Tab」的用例（已于 commit 5353dcb 入库） |
| `about-tab.spec.mjs` 的「既有档位组 ≥4」与滚动条断言 | **一字不动**（换组不改组数，仍是 4 个合并盒） |
| `teleport.spec` / `settings-resolution.spec` 的滚动条断言 | **一字不动**（它们是本轮的护栏） |

⚠️ **并发会话**：本仓有另一条线在同时工作。设计期它正在改 `settings-panel.js` /
`test-ui.js` / `test-tiers.mjs` / `check-data.mjs`，已于 **commit 5353dcb**（v3.25 两个 Tab）入库；
当前工作树里 `settings-panel.js` 又有一处新改动（`ABOUT_PARAGRAPH` 文案）。
⇒ 本轮仍只做**定点 `edit`**：settings-panel 只改 `_rowFogColor` / `_combinedFogMusic` 两处
+ 调用点 + 新增两个导出常量；test-ui 只改 fogColor 那几条 + 追加新开关用例；
test-tiers 只追加归档行。**禁整文件重写、禁 `git add -A`、禁 stash、禁
`git checkout <这些文件>`**；提交前逐 hunk 核对，不把别人的改动卷进本轮 commit。

### 4.6 测试隔离入口 `?ambient=0`（**必需，不是可选**）

§3.4 实测证明 4 个既有 spec 的机位落在目标 biome ⇒ 新池会激活并打破它们的噪声底断言。

- `?ambient=0` 关掉两个池（`main.js` 直传构造选项，**不进 `resolveSettings`、不持久化**
  —— 与 `?shadows=0` / `?reflect=0` / `?skybox=0` 同一口径）。
- 生效值 = `settings.ambientFx && opts.ambient`（两者 AND）。
- 关闭时**零成本**：`visible=false` + 不查体素 + 不推进粒子（`uTime` 仍累计，见 §4.3）。
- 只在 §3.4 标「会」的 4 个 spec 的 URL 上加它，**断言与阈值一字不动**
  （testing-policy「只改被测 setup」口径）。

### 4.7 新增文件与职责

| 文件 | 职责 | three |
|---|---|---|
| `render/ambient-fx-config.js` | 两张常量表（`LEAF_FX` / `FIREFLY_FX`）+ 纯函数（出生采样、秋色抽签、亮度派生、配额） | **无** |
| `render/leaf-fx-material.js` | 落叶 TSL（下落/摆荡/翻飞/落地钳制）+ 几何工厂 | 有 |
| `render/leaf-fx.js` | 落叶池（门控/迁移/回收/取色注入） | 有 |
| `render/firefly-fx-material.js` | 萤火虫 TSL（三轴异频/呼吸/片元径向） | 有 |
| `render/firefly-fx.js` | 萤火虫池（门控/迁移/夜间联动） | 有 |

⚠️ **为什么 config 合成一个而 material/renderer 分开**：两张常量表都是「环境特效观感量」，
共享 `renderOrder` 与「跟随语义」常量（半径/节流/批大小）⇒ 合一份避免漂移。
而两个 pass 的 TSL 结构完全不同（正常混合的翻转薄片 vs additive 的呼吸光点），
合一个文件会变成 `if (kind)`  giant 分支 —— 与 `spike-fx-material` 的双 pass 不同，
那两个共用同一套粒子结构，本轮不共用。

⚠️ **依赖方向**：`ambient-fx-config` 只 import `gen/noise.js` 的类型无关常量与
`daynight.js` 的 `nightBlendOf`（render→gen 是**向下**，合法）。
**不 import `leaf-fx.js`**（后者 import 前者 ⇒ 循环）。

## 5. 验证方案

### 5.1 Tier 1（必须 TDD）—— `src/tests/test-ambient-fx.js`

覆盖「改坏了肉眼玩不出来」的部分：

1. **常量关系**：两张表冻结；秋色权重和 ≡ 1（±1e-9）；`birthMax` < 森林叶层聚合上界；
   `renderOrder` ≡ `CINDER_FX.renderOrder`；粒子数性能档 < 清晰档。
2. **出生采样**（`rand` 注入可复现）：圆内**面积均匀**（不是角度均匀 ⇒ 不挤在圆心）；
   落叶 `topY ∈ [ground+3, ground+13]`；萤火虫 `y ∈ [ground+0.4, ground+2.6]`。
3. **秋色抽签**：给定 σ 序列，命中分布与权重表一致（大样本 χ² 或区间判据）；
   σ 越界不得静默落回第一项。
4. **运动闭式复刻**（CPU 复刻 shader 公式）：
   - 落叶 `y(t)` 单调不增且 `≥ minY`；`t > tLand` 后 **x/z/rot 全部冻结**（落地不打转）；
   - 萤火虫三轴频率**互不相同且非整数倍**；`y` 无漂移项（长期均值不偏离出生高度）。
5. **夜间派生**：`gain`/`count` 随 `nb` 单调不减；`nb=0`/`1` 两端等于常量表两端；
   `count ≤ capacity`（否则 `aAlive` 写越界）。
6. **池账**：容量 ≥ 峰值并发；`instanceCount` 恒等于 capacity（本轮不靠它调密度，§3.5）；
   零活跃 / 非目标 biome 时 `visible=false`。
7. **门控**：非目标 biome ⇒ `visible=false` 且 **`isSolid` 调用次数为 0**（零成本的判据
   必须落在「有没有查体素」上，不是只看 visible）；`uTime` 在关闭态**仍推进**。
8. **NaN 守卫**：`nowMs`/`playerPos` 非法时不污染缓冲。
9. **TSL 结构**（去注释后读 `Fn` 体）：落叶有 `rotate(`、有 `max(...minY)`、
   **无** `AdditiveBlending`；萤火虫有 `AdditiveBlending`、径向量在 colorNode 里算
   （`length(` 出现在片元函数体而不是顶点函数体）。
   ⚠️ **不断言「源码里有没有某个字面量」**（v3.23 实测三条零判别力）：钉**表达式结构**
   （如 `tEff = min(` 存在），且先去掉注释再匹。
10. **`?ambient=0` 与面板开关的 AND 语义**：任一为关 ⇒ 两个池都不画；
    两者都开才画（单测用 fake scene 断言 `setEnabled` 的合成结果）。
11. **昼夜 uniform 真的接上了**（不是只传了句柄）：把注入的 `uSkyDim.value` 从 1 改成 0.25，
    材质的 uniform 引用必须**同一个对象**（`===`）—— 否则日夜变了而落叶钉在正午亮度。

### 5.2 Tier 4（像素实测）—— `tests/ambient-fx.spec.mjs`

**机位按数据选**（已实测，seed 12345）：

| 场景 | 坐标 | 实测依据 |
|---|---|---|
| 森林 | **(−400, −400)** | r16 圆盘 **100% FOREST**，h 4..12，33×33 内 32 棵代码树 |
| 草地 | **(−350, −150)** | r16 与 r22 圆盘均 **100% PLAINS**，h 5..8（起伏小 ⇒ 相机稳定） |
| 对照（沙漠） | 出生点 (0,0) | 17×17 全 DESERT ⇒ 两个池都该 invisible |

**六个动态源全冻**（既有教训，缺一则判据零判别力）：玩家下落（钉 `physics.pos`）、
海面波纹（`ocean.update` 传 dt=0）、第一人称手臂（藏 `viewArm.mesh` + `viewWeapon.node`）、
昼夜（`setVisualStyle`）、viewBob/stepLift（两个 `update` 换空转）、**雨滴**（`?weather=clear`）。

⚠️⚠️ **本轮特有的第七个问题：被测对象自己就是持续动画**。冻结全部环境源之后，
落叶/萤火虫仍在动 ⇒ **不能要求「同状态连拍噪声底 = 0」**（那是断言想象中的世界）。
正确口径：**对照组 = 同会话、同机位、`setAmbientFxEnabled(false)`**（而不是「等画面静止」）；
两侧各连拍 3 张取**最大值**，判据取「开的下限 > 关的上限」。

**判据**

- 落叶：同机位「开 vs 关」差分 + **色相判据**。CPU 复刻实测：黄叶顶面屏幕色 **150,159,9**，
  草顶背景 **68,128,53** ⇒ 判据 `Δr ≥ 25 && Δr > Δg + 12 && Δb < 0` 在**草顶背景**上命中、
  在其余五种叶色上**不命中** ⇒ 这条判据钉的正是「秋色权重真的生效」。
  ⚠️ **机位必须让叶子落在草顶背景上**（而不是天空/树干）：实测该判据在天空
  (169,208,219) 与树干 (58,29,8) 背景上 **不命中** ⇒ 机位选错就零判别力。
  做法：俯视（pitch 约 −0.45）使画面下部全是草地，采样区取画面下 40%。
  ⚠️ 必须同时钉**上下界**：只钉「有差分」抓不到「整屏变绿」。
- 落叶「不高于树」：读**真实 GPU 属性** `aOrigin.y` 与该列 `groundY`，
  断言 `origin.y − groundY ≤ 13`（**不用屏幕像素** —— 出生点自己在动，屏幕判据零判别力，
  v3.23 已实测四种口径全部失效）。
- 落叶「落地即停」：读属性算 `tLand`，断言 `t > tLand` 后 CPU 复刻的 x/z 不再变。
- 萤火虫：**暖黄绿像素自身色相**（不是差分计数）+ 夜间比白天更亮（同机位单变量）。
  判据候选（CPU 复刻已验）：`Δr > 20 && Δg > 20 && Δb < Δr − 15`，
  gain 0.6 正午 Δ[127,95,41] / 夜间 Δ[182,163,72] 两侧都命中。
- 萤火虫「三轴异频」：读属性 + CPU 复刻轨迹，断言**不是圆**（拟合圆残差 > 阈值）。
- draw call：目标 biome 下 **+1**（单池），非目标 biome **回基线**；
  `?shadows=0&reflect=0`（不关倒影会把反射 pass 算进同一计数，v3.20 实测）。

**负向对照**（每条判据都要有）：
`page.route` 换 config 模块内容（**必须在 `page.goto` 之前注册**），把
① 秋色权重改成真实比例 ② `birthMax` 改成 40 ③ 落地钳制去掉 ④ 萤火虫三轴改成同频
⑤ 夜间 gain 改成恒定 —— 逐个确认对应判据**真的 FAIL**。
⚠️ 常量编译进 shader ⇒ 浏览器侧改对象无效，必须换模块内容。

### 5.3 门禁

| 门 | 理由 |
|---|---|
| `npm run check` | 新增 src 文件（arch/data/lint） |
| `npm run test:unit` | Tier 1 新单测（Node 白名单归档） |
| `npx playwright test tests/unit-fast.spec.mjs` | `test-ui.js` 需 DOM，不在 Node 白名单 |
| `npm run test:ui` | 面板改了（含 teleport / settings-resolution 的滚动条护栏） |
| `npm run test:pixel` | Tier 4 新 spec + 既有 `fog-color` / `water-order` / `water-visual` / `water-reflect` 零回归 |
| `npx playwright test tests/jungle-fortress.spec.mjs tests/ignis-fx.spec.mjs` | §3.4 标「会」的另两个 spec（加了 `?ambient=0` 后须仍绿） |
| `npm run bench -- --check` | **新增热路径文件**（render/），且冲刺走廊 21.8% 是 PLAINS ⇒ 萤火虫真的会激活 |

⚠️ **bench 基线不得重写**：`npm run bench` 不带 `--check` 会覆盖 `docs/m3-baseline.*`。
诊断后要 `git checkout` 恢复（提交它等于静默放宽门禁）。

## 6. 留给实施者的决定

- 两张常量表的**具体数值**在 §4 给了设计取值，但**尺寸/密度/gain 三项必须按像素实测标定**
  （v3.23 的教训：照抄别的特效的尺寸会得到「写入了 N 颗但画面上看不见」）。
  标定方法：同机位单变量扫描，记实测表进 §7。
- 分批迁移的**批大小**（设计 32）可按实测帧时调整，但必须 > 0 且 < 容量。
- 单测的具体断言阈值：先在真实数据上跑一次打印实际值，再定阈值（policy §2.6 ⑤）。
- 萤火虫「拟合圆残差」的阈值：先量三轴异频与同频两侧的实际残差，取中间。
- 具体属性名（`aOrigin` / `aSeed` / `aColor` / `aAlive` …）与函数签名由实施计划钉住；
  本文只钉**语义**（每个属性答什么问题）。

## 7. 实施期实测记录（以本节为准）

### 7.0 实施期新增实测（v3.26 落地，2026-11-20）

**六个真缺陷（全部「数值判据全绿而画面零像素」型，逐个 RED→GREEN）**

| # | 缺陷 | 实测形态 | 修法 | 判据 |
|---|---|---|---|---|
| ① | **WebGPU `maxVertexBuffers` = 8** | 落叶 position+8=9 / 萤火虫 position+11=12 ⇒ `Vertex buffer count (9) exceeds the maximum number of vertex buffers (8)` ⇒ render pipeline 创建失败、**整池不上屏**，而 visible/count/属性值全对 | 落叶 born+alpha 合 `aLife` vec2（8）；萤火虫 size+alive+breatheFreq+breathePhase 合 `aSizeAlive` **vec4**、born+life 合 `aLife` vec2、driftX/Z+ground 合 `aDriftGround` vec3（8） | 几何 `attributes` 键数 ≤8 |
| ② | `searchDepth: 24` 太浅 | `_teleportTo(x,45,z)` 距森林真地面 **37 格** ⇒ 窗口 [45,21] 够不到 ⇒ 220 片全跳过 | 改 **56**（同 `rain.js`） | `searchDepth ≥ 45` |
| ③ | 地面扫描从出生带顶部起 | 被玩家**头顶树冠**（实测 y=55）骗到 ⇒ 地面解成 56 ⇒ 第二次扫描够不到真地面 | 从**玩家脚下**起；第二次扫描起点取 `min(出生高度, 玩家高度)` | 树冠在头顶时仍全部播种且地面=9 |
| ④ | 播种一次性布尔 `_seeded` | 地面未加载时首次全跳过，而标志已置位 ⇒ **属性永远全 0** | 逐片计数 `_seededCount` + 每帧重试差额 | 未加载 seeded=0，加载后 seeded=capacity |
| ⑤ | 扫描下界未钳 `WORLD_MIN_Y` | `WorldData.getBlockId` 对 `y < WORLD_MIN_Y` 返回 **bedrock**（防穿底）⇒ 未加载 column 全 air 时扫到世界底 ⇒ 地面解成 −32、叶子全在地下（实测 origin.y≈−20、minY=−31.98） | `endY = max(WORLD_MIN_Y, startY − searchDepth)` | 世界底不算地面 |
| ⑥ | `isSolid` 需**整数** x/z | `blockIndex(x − cx*16, …)` 小数坐标算出小数数组下标 ⇒ undefined ⇒ 全读 air（玩家坐标恒带 .5）⇒ 整池零像素 | resolver 内 `Math.floor(x/z)` | 小数玩家坐标下仍全部播种 |

**装配位置**：plan 原写「`blockHitFx` 之后」，但那里 `this.player` 仍为 null ⇒ 读 `physics.pos` 抛
`Cannot read properties of null` ⇒ **整页启动失败**（实测 about-tab / audio-fx / bgm 全红）。
已移到 **`player.spawn` 之后**（`blockColorResolver` 是同函数局部变量，仍可读）。

**机位与夹具（实测推翻 §5.2 的设计取值）**

| 项 | 设计取值 | 实测结论 |
|---|---|---|
| 森林机位 | (−400,−400) | 该整数落点恰在**巨树树冠内**（y=39 是 `giant_spruce_leaves`，真地面 y=9）⇒ 玩家停在叶层顶 y=40、相机高于全部落叶 ⇒ `inFront=0`。改用 **(−393.5,−399.5)** |
| 传送方式 | `_teleportTo(x,45,z)` | 改 **y=60 后等 `onGround`**；反复搜索式传送会让玩家在未加载 column 间坠落到 y=−23 |
| 采样区 | 画面下 40% | **零判别力**：落叶出生在地面+3..13 而相机眼高仅 +1.62 ⇒ 多数叶子在相机之上。实测 pitch −0.10 时秋色命中 712（top 665 / mid 47 / **lower 0**）⇒ 改**整屏**，pitch 从 −0.45 改 **−0.10** |
| 像素口径 | 「开的下限 > 关的上限」（相邻帧差分） | **必 flaky**：落叶是自由翻转薄片（侧面投影 1~2px），同实现同机位两轮读数 [0,0,0] vs [324,502,316]；萤火虫呼吸三次幂让多数帧很暗（单张 0~108）。改 **「关态固定基线 → 开态 N 帧并集」**（`unionCounts`，单调不减、随时序稳定，仍是单变量） |
| draw call | 跨机位差 +1 | **零判别力**：跨机位可见 geometry slot 数差异巨大（实测沙漠 353 / 森林 308 / 草地 300）⇒「森林−沙漠」= **−45**。改**同机位开/关差**，实测 **+2**（池自身 1 + three 把新 transparent mesh 插入排序列表带来的额外一次提交）；沙漠 **0** |
| 负向①判据 | 「秋色计数为 0」 | **零判别力**：真实比例里仍有 25% 黄叶 ⇒ 计数仍非零。改**秋色占比**（暖色命中/全部变化像素） |
| settle 时长 | 700ms（切换后） | 读数不稳 ⇒ 切换后 **2500ms**，freezeAll 后再 **4000ms**（远处 column 仍在流式上传） |

**像素标定（§6 要求的三项，同机位单变量扫描）**

| 参数 | 扫描结果 | 结论 |
|---|---|---|
| 萤火虫 gain × size | 基线 on=[1370,952,611]；×1.6 [1236,1469,1087]；×2.2 [1246,1077,766]；×1.6/×1.5 [1440,1293,1657]；×3.0/×1.8 [711,1394,638] | **无稳定提升 ⇒ 不改常量**（gainDay 0.55 / size 0.09~0.16 已够）。正式 spec 首轮的 [0,7,0] 是缺 settle 的时序问题 |
| 落叶尺寸 | 0.10~0.18（设计值） | 秋色累计 842 像素、占比 0.111 ⇒ 够用，不改 |
| 秋色占比 | 秋色档 **0.111**（累计口径）/ 相邻帧口径 0.140~0.190；真实比例档 **0.030** | 正向钉 ≥0.10，负向钉 <0.10 ⇒ 两侧分离 |

**最终 Tier 4 读数（`tests/ambient-fx.spec.mjs`，11/11 passed）**

⚠️ **两条判据在自审后的复核里被实测推翻，按真意图改写（不是放宽）**：
· **秋色占比（暖色命中/全部变化像素）分布重叠** —— 正向 0.11~0.42 / 负向 0.03~0.11，
  两者都随**叶片翻转相位与落地时刻**漂移 ⇒ 任何固定阈值必 flaky。改用**内容级判据**：
  读真实 GPU 属性色分布，正向钉「黄叶 > 绿叶×2」（实测 **136 / 24**）、
  负向钉「黄叶 < 绿叶」（实测 **48 / 140**）—— 与相位/时序/机位无关。
  像素判据保留「开累计 > 关累计 + 上界 25%」。
· **拟合圆残差「每一只都 >0.05」不成立** —— 三轴异频里仍有个体在采样窗口内走出近圆
  （实测最小 **0.0067**，而同频对照恒 ~4e-13）⇒ 改钉「多数个体（>60%）显著非圆」。

⚠️ **自审抳到并修掉一条热路径缺陷（Important）**：`_seedAll` 对未播种成功的片**每帧全池重扫**。
玩家站在世界边缘 / 流式加载没跟上时该状态**永久持续** ⇒ 真实 `WorldData` 空世界实测
**0.359ms/帧、3135 次 isSolid/帧**。修法：新增 `seedRetryInterval = 0.25s` 节流重试（两池共用），
修后实测 **0.026ms/帧（−93%）**。TDD：新用例 RED（每帧 9680 次）→ GREEN；
两条既有自愈用例按新语义推进到重试窗口（不放宽节流）。

| 用例 | 实测 |
|---|---|
| 落叶出生带 | min **3.18** / max **12.98**（220/220 全检查），biome FOREST |
| 落叶落地即停 | frozen **220/220**、fading **220/220**、maxLand **22.4s** |
| 落叶秋色像素 | 关态累计 **0**（噪声底为零）/ 开态累计 **1504**；上界 1504 < 921600×0.25。**权重生效用内容级判据**：GPU 属性色分布 yellow **136** / green **24**（要求 >2×） |
| 萤火虫白天 | 关 **0** / 开累计 **109**（8 帧） |
| 萤火虫夜里 | 关 **0** / 开累计 **461** ⇒ 夜里 **4.2×** 白天；gain 0.55→1.15、count 28→42 |
| 萤火虫不是绕圈 | 三轴异频拟合圆残差 **0.14~0.40**，同频对照 **4.1e-13** ⇒ 完全分离 |
| draw call | 沙漠 delta **0** / 森林 **+2** / 草地 **+2**（同机位单变量） |
| 负向① 真实叶种比例 | GPU 属性色分布 yellow **48** / green **140**（秋色档 136/24）⇒ 黄叶少于绿叶，FAIL 如期 |
| 负向② birthMax=40 | 实测最高出生 **39.66 > 13** ⇒ FAIL 如期 |
| 负向③ 去掉 tEff 的 min | frozen **0/220** ⇒ FAIL 如期 |
| 负向④ 三轴同频 | **42/42** 同频且零漂移 ⇒ FAIL 如期 |
| 负向⑤ gainNight=gainDay | night gain **0.55 === day 0.55** ⇒ FAIL 如期 |

**门禁结果**

| 门 | 结果 |
|---|---|
| `npm run check` | exit **0**（lint **60 warnings = 既有基线**；本轮改过的文件单独 lint **0 warning**） |
| `npm run test:unit` | **103 文件 / 2202 例全绿**（调参+自审修复后新单测共 **50 例**） |
| `npx playwright test tests/unit-fast.spec.mjs` | **1 passed** |
| `npm run bench -- --check` | **通过（无显著回退）**：①平原冲刺 fps 119.98 / p95 **9.2** / draw 523；②城市中心 120.01 / 9.1 / 973；③放挖 120 / 9.2 / 973；④TNT 119.97 / 9.3 / 1016 |
| `tests/ambient-fx.spec.mjs` | **11 passed**（含 5 条负向对照） |

### 7.0b 用户调参（v3.26b，2026-11-20）

用户原话：「在现在的基础上，**落叶飘速度快一倍，萤火虫数量多一倍**。」

| 项 | 首版 | 调参后 | 连带改动 |
|---|---|---|---|
| `LEAF_FX.fallSpeed` | [0.55, 0.90] | **[1.10, 1.80]** | 落地时刻 3.3~23.6s → **1.7~11.8s**（实测 maxLand 22.4 → **11.46**）；稳态密度不变（容量固定，回收即重生） |
| `FIREFLY_FX.countDay / countNight` | 28 / 42 | **56 / 84** | — |
| `FIREFLY_FX.capacity / capacityPerformance` | 42 / 21 | **84 / 42** | **必须同比例抬**：不抬的形态是「夜里只数被容量静默钳住」（计数/可见性/draw call 全绿而密度没变）——已写成单测 + 负向验证 |
| `FIREFLY_FX.refreshBatchSize` | 16 | **32** | 容量翻倍后同比例（仍 < 容量） |

**未动**：出生带 / 半径 / 摆荡 / 自转 / 尺寸 / 秋色权重 / gain / 呼吸 / 寿命 / 门控语义。

**TDD 与负向验证**：先写失败用例（钉倍率关系式 + 容量关系式）→ RED（`下界翻倍: Expected 1.1, got 0.55`）
→ 改常量 → GREEN **48/48**。两条负向真红：
① 只改只数不抬容量 ⇒ **5 例红**（含「容量 42 装不下夜间 84」与「只数须按容量比例缩 Expected 28, got 21」）；
② fallSpeed 退回旧值 ⇒ 倍率用例红。均已 `cp` 还原并复绿。

**调参后 Tier 4 复测（11/11 passed）**

| 用例 | 首版 | 调参后 |
|---|---|---|
| 落叶 maxLand | 22.4s | **11.46s**（≈减半，与速度翻倍一致） |
| 落叶秋色累计像素 | 842 | **1504~2770**（飘得快 ⇒ 同一窗口内扫过更多像素；具体值随翻转相位浮动） |
| 萤火虫 count | 28 / 42 | **56 / 84** |
| 萤火虫白天累计 | 109 | **359**（≈3.3×） |
| 萤火虫夜里累计 | 461 | **2753**（≈6×；只数×2 与 brighter 帧更多叠加） |
| 负向① 内容级判据 | yellow 54 / green 139 | **yellow 48 / green 140**（仍黄<绿 ⇒ 判据仍分离） |
| draw call | 沙漠 0 / 森林 +2 / 草地 +2 | **逐位不变**（容量不影响 draw call 数） |

### 7.0c 二次调参（v3.26c，2026-11-21）

用户原话：「草地上的萤火虫数量太少，再增加一倍。」

| 项 | v3.26b | 调参后 | 说明 |
|---|---|---|---|
| `FIREFLY_FX.countDay` | 56 | **112** | 白天只数再 ×2（首版 28 至今 ×4） |
| `FIREFLY_FX.countNight` | 84 | **168** | 夜间只数再 ×2，2:3 的昼/夜比保持不变 |
| `FIREFLY_FX.capacity / capacityPerformance` | 84 / 42 | **168 / 84** | 同比例抬；不抬 ⇒ 夜间只数被容量静默钳在 84（判据全绿而密度没变） |
| `FIREFLY_FX.refreshBatchSize` | 32 | **32（不动）** | 单帧迁移成本不随容量增长 = 削峰；整池迁移 3 帧 → 6 帧，触发条件是移动 8 格 |

**为什么昼夜同比例抬**：用户看到的是「草地上的萤火虫太少」，没有限定昼夜；只抬夜间会让
白天进游戏的玩家一点变化都看不到，而昼夜比本身是设计裁定（§4.2「夜里更密」），不该被调参破坏。

**未动**：出生带 / 半径 / 摆荡 / drift / 尺寸 / gain / 呼吸 / 寿命 / 门控语义 / 面板开关。

**单测按新语义重钉**（`test-ambient-fx.js`）：`countDay=112`、`countNight=168`、`capacity >= countNight`、
`capacityPerformance × 2 = capacity`、性能档比例式 `112 × 84/168 = 56`（不是直接钳容量得 84）。

**负向验证（`cp` 副本还原 + sha256 逐位核对，均真红）**：
① 只抬 `countNight` 不抬容量 ⇒ **4 例红**（「容量 112 装不下夜间 168」/「夜间只数不得越界」/
「夜里更密」/ 比例式）；
② `countDay` 退回 56 ⇒ **1 例红**（「白天只数再翻倍: Expected 112, got 56」）。

**未跑**：Tier 4 `tests/ambient-fx.spec.mjs`（只改常量，判据是「开 > 关」「夜 > 昼」的相对量，
不受绝对只数影响）；`bench --check`（不碰热路径模块。池的每帧成本 ∝ 容量：属性上传实测
`7 次 writeBuffer / 7056 B`（容量 84 时的口径，≈ 84 B/只）⇒ 容量 168 即 **≈14112 B / 帧**，
仍小于雨池 `RAIN.PARTICLE_COUNT` **267** 的同口径量级 —— **这是估算，未实测**）。

### 7.1 设计期已完成的实测（本文引用的数字全部出自这里）

| 探针 | 结论 |
|---|---|
| `getBiome` 计时 | 20 万次 5.6ms ⇒ 0.028 µs/次，5Hz 门控成本可忽略 |
| `generateTree` 叶层扫描 | 矮树 +2..+4、高树 +8..+11；33×33 森林聚合 +4..+14（32 棵） |
| `trees.json` 逐变体扫描 | 巨树叶层最高 41（tallOak），故刻意不覆盖巨树 |
| atlas 六叶种均色 | 见 §3.3 表；`giant_oak_leaves` 与 `leaves` 几乎同色 ⇒ 权重表不列它 |
| 权重表期望色 | 真实比例 71,119,44（r/g 0.597）vs 秋色 B 档 106,135,39（r/g 0.785） |
| ACES 屏幕色复刻 | 黄叶顶面 150,159,9 / 草顶 68,128,53 ⇒ 落叶色相判据只在黄叶上命中 |
| 萤火虫 additive 扫描 | `#c8ff50` gain 0.6 正午 Δ[127,95,41] / 夜间 Δ[182,163,72]；gain 2.4 夜间 Δb 159（钳白）⇒ 上限取 1.15 |
| biome 圆盘扫描 | FOREST(−400,−400) r16/r22 均 100%；PLAINS(−350,−150) r16/r22 均 100% |
| bench 走廊 biome | 冲刺 21.8% PLAINS（萤火虫会激活）；其余三场景全 DESERT |
| `RotateNode` 可用性 | Node 侧程序化核实 `TSL.rotate` 存在、`isNode===true`、vec3 分支走 Rx·Ry·Rz |
| `cloud` solid | true，但落叶扫描窗口（地面+13 起）到不了 Y=35/55 的云 ⇒ 不受影响 |
| 既有 spec 机位 biome | `water-visual`(−504,−528) / `water-reflect`(616,158) = **PLAINS**；`jungle-fortress`(−304,217) / `ignis-fx` offset900(908,908) / 祭坛(1000,200) = **FOREST**；出生点 / offset600 / offset1200 / offset1800 / 大竞技场 / 废弃堡垒 = DESERT |
| 围场 / 非祭坛高台 biome | 围场(280,463) = PLAINS；非祭坛高台(−2600,2600) = PLAINS/AZALEA 混合 |
| `instanceCount` 消费点 | 每次 draw 都读，但「已建 bindGroup 后改它是否立即生效」**未做 GPU 实测** ⇒ 设计不依赖它（§3.5） |