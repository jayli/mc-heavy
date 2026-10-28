# 城门竞技场（Arena）设计

日期：2026-10-29
素材：`/Users/bachi/Downloads/Prestance Arenas/Schematics/Arena{1..6}.schematic`
（WorldEdit 旧版 `.schematic` = gzip + NBT，含 `Width/Height/Length` + 8 位 `Blocks` +
半字节 `Data`）

## 1. 需求（用户原话要点）

- 在南门外、City 与其他地形交界处放一个**草地竞技场**（素材里「有树的那个」）。
- 方块全部来自现成方块，**不自创方块**。
- 竞技场不要和其他实体重合。
- 高度贴合**周围地形的最低点**。
- 有栏杆；栏杆方块**有方向**，且提供了转角栏杆方块，需要旋转到与两侧栏杆方向匹配，
  保证栏杆**连续连接**。

已确认的取舍（本次对话裁定）：

| 议题 | 裁定 |
|---|---|
| 栏杆语义 | **围成外圈闭合栏杆**（原图两段斜向折线 + 栅栏门不再保留） |
| 第二个竞技场 | 本轮**只做南门一个** |
| 占地内地形 | **清空上方、保留下方**（下沉式，靠高一侧留土壁） |
| 落点优先级 | **最近且干燥**（占地 100% 干燥 + 不压地标，取离南门最近） |

## 2. 素材实测（全部来自脚本读取 `.schematic`，非推断）

### 2.1 六个素材的规格

| 素材 | 源尺寸 X×Z | 内容格数 | 地面层 | 最高内容（高出地面） | 主材 |
|---|---|---|---|---|---|
| **Arena1** | 43×81 | 3991 | y=4 | y=11（**7**） | grass / sand / stained_glass / hay / log+leaves |
| Arena2 | 41×79 | 4404 | y=2 | y=9（7） | hclay / stone / silverfish / lava / stained_glass |
| Arena3 | 41×79 | 3972 | y=2 | y=9（7） | sand / sandstone / cactus |
| Arena4 | 41×79 | 5366 | y=3 | y=22（19） | stone / grass / cobblestone |
| Arena5 | 41×79 | 4632 | y=1 | y=13（12） | netherrack / nether_brick / glowstone |
| Arena6 | 41×79 | 6469 | y=4 | y=10（6） | stained_hardened_clay |

本轮只烘焙 **Arena1**。

### 2.2 每个素材都自带两类「非内容」方块

- **`barrier`（id 166）**：把整个选区包围盒**掏空的空心盒**（Arena1 在 y=5..37 共
  236 格/层 × 33 层 + 屋顶整层 3239 格）。它不是美术内容，本仓也**没有对应方块**。
- **`bedrock`（id 7）**：选区底部 4 层整铺（y=0..3，Arena1 共 9633 格）。它只是「垫底板」。

两者必须在烘焙时丢弃。实测丢弃后 Arena1 的**内容包围盒 = 39×77×8**
（x[2,40] × z[2,78] × y[4,11]），内容格 3991。

### 2.2b 内容包围盒与「最低层 ≠ 地板层」

丢弃 `air`/`barrier`/`bedrock` 后的**内容包围盒 = 39×10×77**（x[2,40] × y[2,11] × z[2,78]），
内容格 **3991**（含原图 42 个 fence/fence_gate，它们在映射阶段被外圈栏杆环取代 →
产物内容 **3949** 格）。

⚠️ **内容最低层 y=2 是水池沙底、不是地板层**（地板在 y=4）。故产物必须显式写
`floorRow`，归一化后 = **3**。这条是 DR-1 的存在理由，也是实施时最容易踩的一格。

### 2.3 Arena1 的层结构（逐层实测）

| 源 y | 内容 | 说明 |
|---|---|---|
| 4 | grass 2430 + sand 421 + dirt 35 + stained_glass 115 + gold_block 2 | **地板层**，39×77 = **3003 格，一格不缺** |
| 3 | water 115 + sand 90（其余是 bedrock） | 水池：沙底在 y=2、水在 y=3 |
| 2 | sand 115（其余 bedrock） | 水池沙底 |
| 5 | tall_grass 271 / fence 40 / hay 32 / poppy 31 / dandelion 14 / double_plant 7 / deadbush 5 / log 4 / fence_gate 2 | 植被 + 栏杆 + 干草柱 |
| 6 | hay 18 / double_plant 7 / log 4 / chest 2 | |
| 7 | hay 8 / log 4 | |
| 8..11 | leaves 196~12 / log | 两棵小树（树干在 x=11/31, z=11/69） |

**水池是下挖 2 格**（沙底 −2、水 −1、玻璃盖与草地齐平）—— 地板层本身完整，
水池把 y=2..3 的两格改成了沙/水，y=4 换成 `stained_glass` 当「透明水面盖」。

### 2.4 素材里没有的东西

- **没有 `fence` 对应的本仓方块**（本仓只有 `handrail` / `handrailA` / `handrailB`）。
  原图 42 个 `fence` + 2 个 `fence_gate` 位于 **x=2..40 / z=35..45 的内圈**，形态是
  **两段 V 形折线（每段斜向）+ 中间两个门**。
- `barrier` 环位于 **x=1/41、z=1/79**（内容包围盒外扩 1 格），y=5..37。这个位置
  **正好是「外圈栏杆」该在的地方** —— 本设计用它作为栏杆环的几何依据。

### 2.5 本仓栏杆方的真实几何（真 mesher 实测，不按定义推断）

用 `buildSectionMesh` 对单块 + 4 个 `meta&3` 朝向实测「臂伸出方向」：

| 方块 | orient 0 | 1 | 2 | 3 | 柱半径 | 臂伸到 |
|---|---|---|---|---|---|---|
| `handrail` | **+X +Z** | **+X −Z** | **−X −Z** | **−X +Z** | 0.25 | 0.625（伸出格） |
| `handrailA` | **±X** | **±Z** | ±X | ±Z | 0.15 | 0.5（贯穿格） |
| `handrailB` | ±Z | ±X | ±Z | ±X | 0.15 | **0.25（只到格中心，接不上邻居）** |

结论：

- `handrail` 是**转角件**，四个朝向恰好覆盖矩形环的 4 种转角；
- `handrailA` 是**直段件**，两个朝向覆盖 ±X / ±Z 直边；
- `handrailB` 的臂长只有半格、**不与任何邻居接续**，因此本项目不使用。

矩形闭合环所需臂集合只有 4 种，全部可表达 —— **栏杆环闭合可行**。

### 2.6 现存管线支持的能力

- `structure-json.js` 的 `loadStructure` 支持三种产物形状，其中
  `{palette, stride: 5, blocks: [x,y,z,paletteIndex,direction, ...]}` 是**带逐格朝向**的
  palette 格式（巨型金字塔为 1219 个台阶引入）。`rasterizeStructure` 把它
  `setBlock(x, y, z, type, direction)` 写进 column，mesher 按 `meta & 3` 旋转几何。
- 因此「栏杆的方向」**不需要任何新机制**，只要产物带 `stride: 5`。

## 3. 决策记录（DR）

### DR-1 烘焙输入与产物

- 素材入库到 `assets/arena/src/arena1.schematic`（**烘焙输入，非渲染资源**，与
  `assets/giant-pyramid/src/`、`assets/azalea-trees/src/` 同口径）。源目录不动。
- 产物：`assets/structures/arena_grass.json`，形状
  `{ palette: [name...], stride: 5, floorRow: N, blocks: [...] }`。
- ⚠️ **`floorRow` 是必备字段，不是冗余**（实施时被实测强化）：Arena1 的内容最低层是
  **水池沙底**（源 y=2），地板层在源 y=4 ⇒ 归一化（minY→1）后 `floorRow = 3`。
  `loadStructure` 把它透传到返回对象上，`apply.js` 用它算落位。
  **任何「最低层就是地板」的假设都会让整个竞技场沉 2 格。**

### DR-2 丢弃范围与方块映射表

丢弃：`air`、`barrier`、`bedrock`。

映射表 `BLOCK_MAP`（**唯一权威** = `tools/arena-fingerprint.mjs`，烘焙脚本与
`check:data` 共用，红线 1）。**未知源方块名必须 throw** —— 因为 `makeColumnSetter`
对未注册名字是**静默 return**（`landmarks.js:281`），那格会变成 air，方块层面完全
看不出是映射错了（v1.80 高台烘焙的既有教训）。

Arena1 需要的映射（源 → 本仓）：

```
grass→grass  dirt→dirt  sand→sand  sandstone→sandstone  stone→stone
cobblestone→cobblestone  gravel→gravel  clay→clay
stained_hardened_clay→clay
stained_glass→glass_block  glass→glass_block  stained_glass_pane→glass_block
water→water  flowing_water→water
hay_block→hay_bale  chest→chest
log→wood  leaves→leaves
tall_grass→short_grass  double_plant→allium  poppy→flower  dandelion→flower
deadbush→dead_bush  gold_block→gold_block
```

「方块全都来自现成方块」由此满足：**没有任何新方块声明、没有新贴图**。
（其余 5 个素材的映射在真正启用时再补；本轮不写死它们的表。）

### DR-3 栏杆环：位置、臂集合、朝向反查

- **环的位置** = 源 `barrier` 环（内容包围盒外扩 1 格）。理由：那是素材作者画的
  「选区边界」，也正是外圈栏杆的语义位置；而内容包围盒的最外圈已经是地板。
- **环高度** = 地板层 + 1（源 y=5，与素材原栏杆同层）。
- **臂集合**：对环上每格，出现在环上的正交邻居决定它需要哪些臂（`+X`/`-X`/`+Z`/`-Z`）。
  矩形环上每格恰好有 2 个邻居（直边）或 2 个邻居（转角），无孤立格、无三向格。
- **反查 (方块, 朝向)**：由 `TEMPLATES` 的 quad 顶点派生每个方块每个朝向的**臂方向
  集合**（不手写第二份几何表 —— 红线 1：形状权威只在 `mesher.js`），再按
  「臂集合相等」查表：

  | 需要的臂 | 方块 | orient |
  |---|---|---|
  | `+X +Z` | `handrail` | 0 |
  | `+X -Z` | `handrail` | 1 |
  | `-X -Z` | `handrail` | 2 |
  | `-X +Z` | `handrail` | 3 |
  | `±X` | `handrailA` | 0 |
  | `±Z` | `handrailA` | 1 |

  **直边必须用 `handrailA` 而不是 `handrail`**：`handrail` 只在 +X/+Z 两条半边伸臂，
  放在直边上会缺半边（观感是「栏杆一格一格断着」）。这正是「转角件要旋转到与两边
  匹配」的具体含义。
- 原图的 42 个 `fence` + 2 个 `fence_gate` **整组丢弃**（斜向段无解，见 DR-5）。

### DR-4 落点：抑制型（不避让点状内容，只避固定地标）

竞技场的占地判据 = **`isArenaOccupied`**（`src/gen/structures/arena.js`），由
`pointContext` 的一个 `kind:'none'` 分支 + 阶段 2.7 的撒布剔除共同消费 —— 与巨型
金字塔的 `inGiantPyramidFootprint` 完全同手法（一个分支覆盖五个下游消费者：
高台让路 / 巨树 allowedAt / 城市树 / 普通树 / 单格植物）。

锚点 `computeArenaAnchor(seed)` 只需要避开**固定**内容：

1. 城市 bounds（`getCityBoundsForSeed`，跨 region，实测半宽 283 已超 `CITY_SIZE_MAX/2`）；
2. 地标圆（`regionLandmarkCenters`）；
3. 巨型金字塔（`computeRegionLocalGiantPyramid`，用**局部**锚点 —— 与金字塔自己排除
   高台时同手法）；
4. 高台地带（`isTarnZone` + `computeTarnZone`，半径 `TARN_ZONE_RADIUS`）；
5. 雪原（中心由 `getRegionSeededCenter + LANDMARK_OFFSET` 派生，半径
   `SNOW_LAND_SIZE/2 + 8`）。

外加两条地形判据：占地内 **100% 干燥**（每格 `generateHeight >= SEA_Y`）、占地内
**高差 ≤ `ARENA_MAX_SURFACE_SPAN`(10)**。

扫描顺序：以**南门**（`placements` 里 `type==='gate' && z>0` 的那个）的 x 为基准，
`dz` 从 1 逐格向外、`dx` 按 0, ±3, ±6 … ±120 展开，取**第一个**满足全部判据的位置。

**实测（20 个 seed）**：命中 **20/20**、无 relaxed、成本中位 **55.8ms** / p90 **97.2ms**
/ max **97.9ms**；落点距城市边界 `gap ∈ [1, 85]`、占地高差 `span ∈ [2, 10]`。
（对照：若不抑制点状内容、要求占地内无撒布/树，则只有 7/16 seed 在 160 格内找得到
落点 —— 这就是选抑制型的原因。）

**为什么「最近且干燥」能落在「City 与其他地形交界」**：实测默认 seed 12345 城市
南边界 z=400，南门 x=283，紧邻边界外那条带是浅海（`h < SEA_Y`），最近的干燥落脚点
在 z≈424（gap 24），正是城市人工地面与外海/自然地形的交界带。

### DR-5 为什么不保留原图的斜向栏杆

原图栅栏是**斜向折线**（每格沿对角线相邻）。本仓三个栏杆件的臂**只沿 ±X / ±Z**，
几何上不存在「对角臂」。逐格替换会在每个斜向交界处出现断口 —— 用户要的是「连续
连接在一起的栏杆」，所以按用户裁定改为**外圈轴对齐闭合环**（DR-3）。

### DR-6 地形处理：清空上方、保留下方

`apply.js` 的阶段 2.9 按下面顺序做（**顺序是载荷性的**）：

1. **清空上方**：对占地内每一列，把 `[floorY+1, naturalH]` 写成 air
   （`naturalH = generateHeight(wx, wz, seed)`）。不清的话，占地内高地形的土丘会从
   地板里长出来、穿透竞技场。
2. **补实地板下方的空洞**（⚠️ **实施时发现 spec 初稿的假设是错的，见下**）。
3. **光栅化**：`y = floorY - (floorRow - 1)` 作为结构最低层的落位
   （`rasterizeStructure` 的 `y` 语义是「最低层那一格」，内部 `y + b.y - 1`）。
   → 地板层（归一化 y=floorRow=3）正好落在 `floorY`。
   **水池**自动下挖 2 格：归一化 y=1 是沙底、y=2 是水，落位后是 `floorY-2` / `floorY-1`，
   在地板**之下**。

#### ⚠️ 实施时发现的错判（spec 初稿写错了，实测修正）

初稿写的是「`floorY` 取 min ⇒ `fillColumn` 对每列都填实到 `naturalH ≥ floorY` ⇒ 地板
下方保证实心 ⇒ **不需要补柱**」。**这条推理漏了一个执行顺序事实**：
**`carveCaves` 是在 `fillColumn` 之后跑的**（`world-worker.js` 的 GEN 链是
fillColumn → carveCaves → applyStructures）。

实测（默认 seed 12345，真实 column GEN）：占地内 **236 列**在地板正下方就是空气，
**最深向下 21 格**直通洞穴。不补的话玩家挖开地板就掉进洞里。

修法 = 阶段 2.9 的第 ② 步显式向上填 `stone`，上限 `ARENA_SUPPORT_MAX_DEPTH = 40`。

⚠️ **阀门值的标定不能只看 default seed**：default seed 12345 最深 21 格，但
**20 个 seed 扫下来最坏是 seed 20240101 的 33 格（115 列）**。取 40 = 实测最坏 + 7 格余量。
上限太小的后果是**静默漏补**（那 115 列会在世界上留洞，方块层面看不出），故
`test-arena-gen.js` 有一条专门量「原始空洞深度 vs 阀门值」的用例（负向验证：阀门改 24
→ 报 138 列漏补）。再深的空洞保留 —— 不把极深的矿穴用一根几十格实心柱堵死。
用 `stone` 而不是清成 air，与 `generateCity` 补水体缺口同一条理由：「清成 air 会造出
空洞，玩家挖下去掉进洞里比看到水更糟」。

**教训**：这类「A 已经保证 B」的推理必须先核一遍**执行顺序**，再当真。
（与已有的「凡论证 A 优化与 B 等价，须在 A/B 各自参数下分别实测」同源。）

### DR-7 不旋转

长轴沿 **Z（南北）**，北缘贴城市南边界，向南伸出 79 格。`rasterizeStructure` 签名
不动（无旋转参数）—— 与高台地带「轴对齐摆放」同一裁定：为了一个结构新增旋转机制
会让所有消费方都要考虑，收益不成比例。

### DR-8 与点状内容的互斥（必做，不是可选）

竞技场占地内的**撒布结构**（`scatter`）在阶段 2.7 跳过（`inArenaFootprint`，
与 `inGiantPyramidFootprint` 同手法）；**巨树/杜鹃树/普通树/单格植物**由
`pointContext` 的 `kind:'none'` 分支一次性排除（**不要为每一处各写一份判据**）。

层序：阶段 2.9（竞技场）放在阶段 2.8（巨树）之后、阶段 2.5（空中结构）之前。
理由：竞技场比树更「硬」（用户明确要求「不要和其他实体重合」），后写胜保证不会被树
打穿；同时早于空中结构，与既有层序自洽。

### DR-9 性能

- `computeArenaAnchor` 在 **每个 Worker 的 `layout` 入口预热**（与
  `getCityBoundsForSeed` 同位置、同理由）：实测中位 56ms、最差 98ms，
  **绝不能落进 GEN 计时路径**（`structure-gen` 的 genP95 门是 10ms）。
- 锚点按 `(seed)` 做模块级缓存（纯函数，`seed` 变则重算）。
- 光栅化本身按 column AABB 裁剪（与既有两个 `rasterizeStructure` 消费点同模式），
  单 column 成本 ≪ 1ms。

### DR-10 顶点预算（实测回填）

产物 4185 格按渲染通道分类（实测）：**opaque 3175 / cutout 780 / transparent 230**。
按「通道 × 平均实出面 × 4 顶点」估算增量：

| 通道 | 格数 | 估算顶点增量 | 占容量 |
|---|---|---|---|
| opaque | 3175 | 15,240 | **0.356%**（容量 4.275M） |
| cutout | 780 | 9,360 | **0.390%**（容量 2.4M） |
| transparent | 230 | 1,840 | **1.472%**（容量 125k） |

三个通道都是**噪声级**。⚠️ transparent 的**百分比**看着最大（1.47%）是因为它的容量基数最小
（125k），绝对增量只有 1840 顶点 —— 而该通道实测峰值已到 91.6%（`tarn` 段记录），
这 1.47% 不会改变量级，但**若将来再往 transparent 里加内容，仍须重跑容量探针**。

⚠️ 上表是 Node 侧的**估算**（实出面数按通道经验值），不是真实页面读 `reservedV`。
若要把竞技场计入冻结预算，必须按既有手法在真游戏页读 `renderWorld` 的 `reservedV`。

## 4. 组件与数据流

```
assets/arena/src/arena1.schematic            （烘焙输入，入库）
      │  npm run arena（tools/bake-arena.mjs + arena-fingerprint.mjs）
      ▼
assets/structures/arena_grass.json           {palette, stride:5, floorRow, blocks}
      │  loadStructure（structure-json.js，已有 stride:5 支持）
      ▼
computeRegionLayout → layout.arena            （只在与本 region 相交时携带锚点）
      │  worker 'layout' RPC 下发
      ▼
apply.js 阶段 2.9：
  ① 清 [floorY+1, naturalH] → air
  ② rasterizeStructure('arenaGrass', cx, floorY-(floorRow-1), cz, …)
③ pointContext: arena 占地 → kind:'none'（树/植物/巨树/杜鹃让路）
④ 阶段 2.7: inArenaFootprint 的撒布候选跳过
```

## 5. 错误处理

| 情形 | 行为 |
|---|---|
| 找不到合法落点（`MAX_GAP` 内无满足判据处） | 退回「干燥 + 不压地标」中高差最小的一个；若连它都没有，**该 seed 不生成竞技场**（`layout.arena = null`），不阻断 GEN |
| 产物 JSON 缺失 / fetch 失败 | `loadStructure` 既有兜底：空 blocks → `rasterizeStructure` 静默跳过（**已接受**，与既有结构一致）；但 `check:data` 会在 CI 期抓到 |
| 某源方块名未知 | 烘焙脚本 **throw**（DR-2），不产出产物 |
| 栏杆环上出现「需要 3 个臂」或「0 个臂」的格 | 烘焙脚本 throw（说明环不是简单矩形环，几何假设被破坏） |

## 6. 测试口径（按 `docs/testing-policy.md`）

本改动含**新机制**（layout 字段 + 新落点算法 + 新 block 层序）→ **Tier 1**，TDD。

- **Tier 1 纯函数**（`src/tests/test-arena.js`）：
  1. `computeArenaAnchor` 是 `(seed)` 的确定性纯函数（两次调用逐位相同）；
  2. 占地内每格 `generateHeight >= SEA_Y`（干燥）；
  3. 占地内高差 ≤ `ARENA_MAX_SURFACE_SPAN`；
  4. 不压城市 bounds / 地标圆 / 巨型金字塔 / 高台地带；
  5. **栏杆环闭合**：环上每格恰好 2 个环邻居（无孤格、无 3 向格）；
  6. **臂-朝向匹配**：把烘焙产物里每格栏杆的 (方块, orient) 交给「真 mesher 的臂方向
     派生」，得到的臂集合必须**等于**它在该环位置上需要的臂集合 ——
     这条是本设计最核心的判据（用户要求「转角旋转到与两边匹配」）；
  7. 产物 `floorRow` 指向的那一层恰好铺满 39×77 格（地板完整）。
- **Tier 1 column 层**（`src/tests/test-arena-gen.js`）：
  1. 地板层 y == 占地内 `generateHeight` 的最小值；
  2. 地板层以上到 `naturalH` 之间**全是 air**（清空生效）；
  3. 地板层以下**每一列都有实心支撑**（无悬空、无空洞）；
  4. 占地内**没有**普通树/杜鹃树/巨树/撒布结构的方块；
  5. 栏杆在地板 +1 层、且环上无缺口。
- **Tier 4 真游戏页**（`tests/arena.spec.mjs`）：
  1. 飞到竞技场锚点，断言地板是 `grass` 系且高度 == 占地内最低地形；
  2. 断言栏杆环连续（沿线采样无缺口）；
  3. 断言占地内无树。
- **负向验证**（必须真 FAIL）：
  - 把直边改成 `handrail`（缺半边）→ 臂-朝向匹配断言 FAIL；
  - 把某个转角 orient 改错 → 同上 FAIL；
  - 把 `floorRow` 改错 → 地板高度断言 FAIL；
  - 去掉「清空上方」→ 地板以上有非空气方块，断言 FAIL。

## 7. 已知偏离 / 刻意不做

1. **不保留原图斜向栏杆与栅栏门**（DR-5，用户裁定）。
2. **只做 Arena1**（用户裁定「先只做南门一个」）。
3. **不旋转结构**（DR-7）。
4. **不补地板以下支撑柱**（DR-6：`floorY` 取 min 已保证每列有支撑）。
5. **不新增方块**（DR-2 全映射到现成方块），因此**不需要** `npm run atlas` 之外
   的任何烘焙；`glass_block` / `hay_bale` / `chest` / `flower` 等均已在 atlas 与背包中。
6. **不做 `SAME_TYPE_CULL` / 不碰材质声明**：`handrail*` 已是 `cullMode:"cutout"` 且
   未声明 `opaque`（非 box 几何的既有口径），零材质层改动。
