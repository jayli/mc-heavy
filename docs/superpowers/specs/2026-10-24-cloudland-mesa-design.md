# Cloudland 高台（桌山）Epic 设计（v1.0）

**日期**：2026-10-24
**素材**：`~/Downloads/CLOUDLAND`（**仓库外**，见 §2.1 入库决策）
**状态**：**待用户评审**（评审通过后写实施计划 `docs/superpowers/plans/2026-10-24-cloudland-mesa.md`）

---

## 0. 摘要

把素材包 `CLOUDLAND` 里的**高台**（桌面状台地 / 桌山）引入 mc-heavy 的地形生成层：**每个 region 的沙漠区最多放 1 个**，落在**平缓的沙漠空地**上，尺寸与方块全部用本仓已有方块表达（零新增方块 / 零新增贴图）。

第一版只引入 **`Landscape/9`** 一个变体（20×43×21、10,712 方块）。

**范围外**（后续 Epic，本设计不碰）：云（`Cloud/` 8 个）、拱洞（`ARC/` 11 个）、其余 10 个 Landscape 高台、石柱。

---

## 1. 目标与验收口径

### 1.1 目标

| # | 要求（用户原话） | 本设计的落地 |
|---|---|---|
| 1 | 「默认一块沙漠地图渲染一个高台」 | **每 region 至多 1 个**（region = 400×400 格，本仓地图分块单位） |
| 2 | 「只要是空地上就可以渲染高台」 | 落点判据 = 沙漠 biome + 基座占地全沙漠 + 基座整体高于海平面 + 避开城市/地标/空岛/巨树/撒布结构 |
| 3 | 「先随机挑一个相对小点的高台」 | **`Landscape/9`**（最小三档里唯一有真正台面的：顶部 17×17、实心 74.7%） |
| 4 | 「六七种高台」 | 素材里实际有 **11 种**（`Landscape/1..11`），第一版只做 1 种；表驱动设计保证后续加变体不改结构 |

### 1.2 验收口径

**功能验收**（Playwright + 浏览器内单测）：

- 默认 seed 12345，`region(0,0)` 的沙漠里能找到 1 个高台，坐标与 `computeMesaAnchor()` 的返回值一致；
- 同一 seed 两次 GEN 逐格相同（红线 2 确定性）；
- 高台**完整**（10,712 格全落在同一 region 内，跨 column 接缝处无缺格）；
- 落点占地内**每列都有基座支撑**（无悬空列）；
- 非沙漠 region（如 `region(1,1)` 的森林部分）不出现高台。

**性能验收**（不得回退既有冻结门禁）：

| 指标 | 门 | 本设计的预算 |
|---|---|---|
| `structure-gen` genP95 | ≤ 10ms（v1.42 起的用户裁决） | 单列多写 10,712 格（同量级既有 `castle.json` 10,044 格），见计划 Task 6 实测 |
| layout 单 region 耗时 | 相对 HEAD 增加 ≤ 15% | 实测新增 **p50 0.35ms / max 0.60ms**；基准 2.9~3.3ms → **+11~12%** |
| `m3-fullscene` 显存 | ≤ 200 MiB | 见 §3.8 |

**容量验收**（`giant-tree-budget.spec.mjs` 同口径）：

- 三个通道**零扩容**；
- 总顶点相对 HEAD **不恶化**（第一版只有一个变体、每 region 至多 1 个，量级远小于巨树）；
- ⚠️ 若实测超线，按 `frozen-assertion-rebaseline-over-widening` 的既有裁决口径处理：**重标基线实测值**，不放大容差百分比。

---

## 2. 素材事实（实测，非推断）

### 2.1 目录内容

```
CLOUDLAND/                       16 MB
├─ blueprint/{Landscape,Cloud,ARC}/*.bp   30 个 Blueprint 文件
├─ schematic/cloudlandassets_1.20.schem   385×85×280、9,163,000 格、88 种 palette
│  （另有 1.12/1.16.5/1.17/1.18/1.19/1.21 各一份 + 1.8/1.12 .schematic）
└─ worlds/                         世界存档（level.dat + region/*.mca），本设计不用
```

### 2.2 `.bp` 是什么（**关键实测**）

`blueprint/*.bp` **不含方块数据**。格式实测：
- `offset 8` 起是一段标准 NBT（`ThumbnailYaw` / `ContainsAir` / `Version` / `BlockCount` / `Author` / `Name` / `ThumbnailPitch`）；
- NBT 之后紧跟**一张 96×96 PNG 缩略图**（`\x89PNG` 魔数定位）。

`.bp` 里唯一的方块信息是 `BlockCount`（整数）。**几何必须从 `.schem` 取。**

### 2.3 蓝图 ↔ 几何的对应关系（靠 `BlockCount` 精确匹配）

`.schem` 里剔除 y=0 地板层后做 26 连通分量 → **38 个独立结构**。其中 **23 个的方块数与某个 `.bp` 的 `BlockCount` 精确相等**（一一唯一匹配；两个 `436` 分别对上 `ARC/6` 与一个未匹配分量，故实际唯一匹配 22 组）。

`Landscape/` 的 11 个全部匹配上，即**用户说的「六七种高台」实际是这 11 种**：

| 蓝图 | bbox (x×y×z) | 方块数 | 顶部同高度平台（最大连通） | 观感 |
|---|---|---|---|---|
| Landscape/1 | 68×35×60 | 83,145 | 60×31 外接，实心 34.1% | 大型台地群 |
| Landscape/2 | 58×31×46 | 50,327 | 43×33，52.6% | 大型台地 |
| Landscape/3 | 44×27×48 | 33,215 | 37×29，40.4% | 大型台地 |
| Landscape/5 | 40×45×36 | 32,100 | 29×30，64.1% | 高瘦台地 |
| Landscape/6 | 36×46×32 | 24,087 | 22×22，58.1% | 高瘦台地 |
| Landscape/4 | 36×39×32 | 22,910 | 27×24，72.7% | 台地 |
| **Landscape/9** | **20×43×21** | **10,712** | **17×17，74.7%** | **第一版选中** |
| Landscape/8 | 21×37×25 | 8,952 | 15×21，58.4% | 侧面带拱洞 |
| Landscape/10 | 17×36×18 | 5,013 | 12×7，81.0% | 细台 |
| Landscape/11 | 13×31×12 | 2,025 | 7×8，62.5% | 更像石柱 |

`Cloud/` = 8 个云团（30k 方块以下），`ARC/` = 11 个拱门（78~1,480 方块）。**本设计不碰。**

### 2.4 为什么选 Landscape/9

「相对小点」的候选是 9/10/11 三个（≤2 万方块）。`Landscape/11` 只有 2,025 方块但顶部只有 7×8 —— 读起来是**石柱**而不是**高台**；`Landscape/10` 顶部 12×7 也偏窄。`Landscape/9` 顶部 17×17、实心 74.7%，是唯一「站得上去、看得出是台」的尺寸，且占地 20×21 只需约 60 格绕行一周。

**1:1 原尺寸，不降采样**（对比巨树 Epic 的 1/2 降采样）：20×43×21 本身就是人可绕行的大小；且这批高台是**桌山（蘑菇形）**——底部窄（基座 15×15、164 格）、中部收腰、顶部宽（17×17）。降采样会把收腰和台面压糊，观感直接崩。

### 2.5 竖直尺寸安全性

- `WORLD_MAX_Y = 96`，沙漠地表实测 `h ∈ [-6, 9]`（seed 12345、±600 采样 19,871 点）；
- 高台最高位 `rel-y=42` → 落在地表 9 时台顶 `y = 51`，**距世界顶还有 45 格**；
- 空岛底部实测 `y ∈ [40, 68]`（region(1,1) 68 个岛）→ **存在重叠区间**，故落点必须做空岛冲突剔除（§3.5）。

---

## 3. 设计

### 3.1 数据契约（DR-1）

**烘焙产物走既有 `assets/structures/*.json` 格式**（`{blocks:[{x,y,z,type,direction}]}`，`structure-json.js` 已实现加载 + 归一化 + `rasterizeStructure`）。

- 文件：`assets/structures/cloudland_mesa_small.json`
- 坐标：**相对基座质心**（`cx=9, cz=11`，即 `landscape9` 基座质心），`y` 从 **1** 起（与既有 JSON 的「Y 已归一化，最低点=1」一致，换算 `y_rel + 1`）；
- 方块名：**必须是 registry 里已存在的名字**，烘焙时对未知名字 **throw**（同巨树烘焙的 `SOURCE_MAP` 处置）。

**为什么不新开格式**：`structure-json.js` 的加载/裁剪/groundSupport 已存在且被 18 个结构复用；新开一份会让「结构 JSON 怎么读」出现第二份权威（红线 1）。

**为什么不合进 `.schem` 直读**：本仓 Worker 里没有 NBT 解析器，且 `.schem` 有 9 份（各游戏版本），体积 16MB —— 按版本格式解析会在运行期引入不必要的解析层，违反红线 2 精神（能烘焙成静态数据的不要留到运行期）。

### 3.2 方块映射表（DR-2）

**零新增方块**。28 种源方块全部映射到 registry 已有名字，映射表是**单一权威**（放 `tools/cloudland-mesa-fingerprint.mjs`，烘焙脚本与 `check:data` 共用 —— 与 `giant-trees-fingerprint.mjs` 同手法）。

**映射原则：按「材质族 → 观感最接近的既有方块」对齐，保留原设计的明暗层次**（源模型的观感来自「深色底 → 中灰台身 → 浅色横带 → 顶部苔藓」四层）：

| 源方块 | 格数 | 高度带 | 映射到 | 理由 |
|---|---|---|---|---|
| `mud` | 1,481 | y 1-10（底座） | `mud_bricks` | 同族 |
| `coal_block` | 340 | 散布 | `polished_blackstone_bricks` | 深色点缀 |
| `gray_concrete_powder` | 1,483 | y 11-20 | `calcite` | 浅灰粉质 |
| `tuff` | 2,574 | y 11-30（主体） | `tuff_bricks` | 同族 |
| `cracked_stone_bricks` | 1,030 | y 21-40（横带） | `stone_bricks` | 裂隙砖 |
| `chiseled_nether_bricks` | 1,148 | y 31-40（横带） | `nether_bricks_1` | 雕纹深带 |
| `gray_wool` | 773 | y 31-40 | `stone` | 平滑灰 |
| `moss_block` | 747 | y 41-42（**台顶**） | `moss` | 同族 |
| `acacia_wood[axis=y]` | 187 | y 11-20 | `acacia_planks` | 同色木 |
| `cyan_terracotta` | 171 | 散布 | `clay` | 青灰陶 |
| `deepslate*` 9 种 | 415 | 散布 | `deepslate` / `polished_deepslate` / `iron_ore` | 深板岩族整族归并 |
| `gray/black_concrete` | 44 | 散布 | `smooth_stone_1` / `deepslate` | 混凝土族 |
| `green_terracotta` / `green_concrete` / `lime_terracotta` | 59 | 台顶边缘 | `moss` | 绿色点缀 |
| `light_gray_concrete` | 44 | 散布 | `smooth_stone` | 浅灰 |
| `smooth_basalt` | 15 | 散布 | `deepslate` | 深色 |

**全部 28 种落到 14 个目标方块**，都是 opaque 通道（`opaqueTable=1`），**不碰 cutout**（避免 §4.10 容量风险，见 §3.8）。

⚠️ **不做的事**：不新增 block registry 条目、不烘焙新贴图、不跑 `npm run icons`（高台不进背包）。

### 3.3 落点：每 region 一个（DR-3）

**候选发现放在 region layout 层**（`computeRegionLayout()`），与 `computeSkyCandidates` / `computeGiantTreeCandidates` 同构（DR-13：各 GEN Worker 只做光栅化，不重复跑候选发现）。

**算法**（实测 169 个 region：163 命中 / 6 无沙漠或全部被排除；单 region p50 **0.35ms** / max **0.60ms**）：

```
computeMesaAnchor(regionX, regionZ, seed) -> { wx, wz, floorY } | null

① 便宜门（0.067ms/region @ step=8）：region 内缩 M=13 格，按 8 格步长扫，
   只查 getBiome()==='DESERT' 收集候选点。
   无候选 → null（绝大多数非沙漠 region 走这条）。
② 确定性乱序：候选点按 seededRandom(wx, wz, seed + MESA_SALT) 升序，
   tie 用 (wx, wz) 字典序 → 跨机 / 跨 Worker 一致。
③ 就近命中即停，对每个候选做「基座全检」，四条判据缺一不可：
   · 15×15 基座矩形逐格：getBiome()==='DESERT'        （整片占地都在沙漠）
   · 15×15 基座矩形逐格：generateHeight() > SEA_Y      （基座整体高于海平面）
   · floorY = min(基座各列 h)，须满足 floorY > SEA_Y
   · 不与任何空岛 AABB 相交（空岛底 y < 47）
   首个通过者即锚点。
```

**为什么基座判据用「15×15 实心矩形」而不是「164 格真实掩码」**：这批高台是**桌山**——底部窄、顶部宽。基座 164 格全部落在 `x ∈ [-7,7] z ∈ [-7,7]` 的 15×15 框内（实测），矩形只是多查 61 个角格。

**实测两版对照**（16 个 region，交替同 seed）：

| 版本 | 命中 | p50 | max | 锚点是否一致 |
|---|---|---|---|---|
| A：164 格真实掩码 | 16/16 | 0.39ms | 0.95ms | — |
| **B：15×15 实心矩形** | **16/16** | **0.35ms** | **0.60ms** | **16 个全一致** |

B 的 `floorY` 只会**更低或相等**（矩形包含对角低点）→ 埋没量略大但**绝不悬空**，方向安全。

**选 B 的决定性理由**：`computeMesaAnchor` 在 layout 层（Worker 内、无 fetch），而 164 格掩码只能从烘焙 JSON 读 —— 走掩码就得让候选发现依赖异步 fetch，违反 DR-13 的「候选在 layout 层算一次」。矩形是纯常量，零依赖。

**为什么判据是「全部高于海平面」而不是高差门控**：实测基座占地内高差 `span` p50=1 / p95=3 / max=4（沙漠被 `h*0.5+2` 压平，高差门控几乎恒真）；真正会把高台放歪的是**基座跨到海里**（`h <= SEA_Y`），那会让高台一半扎在海底。故判据取「全部 > SEA_Y」，**不设 span 上界**（max 4 格的起伏由地形自然吸收在台底之下）。

**`floorY = min(基座各列地表 h)`**，高台 JSON 的 `y=1` 层落在 `floorY + 1`。取 **min** 而非中心点高度：min 保证任何一列基座都不悬空（取中心点高度会让低洼侧露出空隙，实测 8% 的候选会有 4~8 格空隙）。代价是低洼侧地形被台体埋没 ≤ span 格（≤4，与「山体埋进地形」同一观感）。

### 3.4 与其他系统的让路（DR-4）

高台落在**地面**，必须在已有的地面内容之上判断让路。落点判据里已包含 biome + 海平面 + 空岛，**其余让路在 GEN 侧用 `pointContext` 同源的排除逻辑**：

| 冲突对象 | 处理 | 实现位置 |
|---|---|---|
| **城市**（bounds 可跨 region） | 丢掉整个锚点（城内不放高台） | `apply.js` 阶段 2.9，`cityLayout && inCityBounds(anchor)` |
| **地标**（金字塔/雪原/冰封山/海岛/平地/城市） | 丢掉整个锚点 | 同上，复用 `pointContext(anchor).kind !== 'normal'` |
| **空岛** | 已在候选层剔除（region 内可判） | `computeMesaAnchor` |
| **巨树** | 高台先写 → 巨树在用 `pointContext` 让路时**额外**检查高台占用框 | 阶段 2.8 的 `allowedAt` 回调加一条 |
| **撒布结构 / 植被** | 高台后写覆盖（与既有「后写胜」语义一致，**不新增守卫**） | 阶段 3 的 `covers` 窗口（同巨树手法） |

⚠️ **为什么城市/地标排除必须在 `apply.js` 而不能在候选层**：城市 bounds 可跨 region（实测 seed 12345 `x ∈ [0,566]`），只有持有 city 的 region `[0,0]` 拿得到 `cityLayout` —— 与 scatter 的「阶段 2.7 才有唯一权威」完全同源（v1.74 的教训，勿重犯）。

### 3.5 层序（DR-5）

插在 **阶段 2.7（撒布结构）之后、阶段 2.8（巨树）之前**，编号 **阶段 2.75**：

```
阶段 1     地形整形
阶段 2     JSON 结构（城市建筑 / 海岛塔 / 平地金字塔岛）
阶段 2.7   撒布结构（flowerBed / pavilion / tallWell / house / ship / 沙漠结构）
阶段 2.75  ★ 高台（本设计新增）
阶段 2.8   巨树（让路判据 +1 条）
阶段 2.5   空中结构（云 + 空岛）
阶段 3     植被
```

**放在 2.7 之后**：高台是「地面级固定景观」，比撒布结构更"重"，被撒布结构压住会缺一块（同层序里地面级内容由小到大、后写胜）。
**放在 2.8 之前**：巨树有 `allowedAt` 判据可避让，高台没有；让巨树避让比让高台避让简单（一处回调）。
**放在 2.5 之前**：空岛在 y≈40-68，与本设计无几何重叠（2.75 已剔除），顺序不影响；沿用「地面内容先写」的既有层序。

### 3.6 烘焙管线（DR-6）

仿巨树 Epic 的完整手法（唯一被验证过的「离线烘焙 + 指纹门禁」路径）：

```
tools/bake-cloudland-mesa.mjs       npm run mesa
  读 schematic/cloudlandassets_1.20.schem
  → gunzip + 最小 NBT 读取（复用 bake-giant-trees.mjs 的 NbtReader，抽成共享模块）
  → 26 连通分量，按 BlockCount 匹配 Landscape/9
  → 取该分量，平移到基座质心为原点、y 从 1 起
  → 逐格过映射表（未知源方块 throw）
  → 断言：方块数 == 10712、bbox == 20×43×21、底部 164 列每列都从 y=1 起
  → 写 assets/structures/cloudland_mesa_small.json + cloudland_mesa_small.meta.json

tools/cloudland-mesa-fingerprint.mjs   （共享模块，红线 1）
  SOURCE_SHA256        素材 .schem 的 sha256
  SOURCE_COMPONENT     10712（连通分量 BlockCount，用于匹配）
  BLOCK_MAP            28 → 14 的映射表
  MESA_METRICS         bbox / blocks / baseColumns
  fingerprint()        参数 sha → 供烘焙脚本与 check:data 共用

assets/cloudland/src/cloudlandassets_1.20.schem   ★ 入库（烘焙输入，非渲染资源）
```

**`npm run mesa` 与 `check:data` 的 `[高台]` 环节**（同 `[巨树]` 的手法）：
- 产物存在 + 指纹匹配（不匹配 → 「跑 `npm run mesa`」）；
- 方块数 == 10,712、bbox == 20×43×21；
- 每个 `type` 都在 registry 里（防映射表漂移出空方块）；
- 全部目标方块 `cullMode === 'opaque'`（防有人把某个映射目标改成 cutout → 容量预算失效）。

### 3.7 接线（DR-7）

改 3 个文件 + 加 1 个：

| 文件 | 改动 |
|---|---|
| `src/gen/structures/mesa.js`（**新增**） | `computeMesaAnchor(regionX, regionZ, seed)`（纯函数，Worker 同构，无 three）+ `MESA_BASE_RECT_HALF = 7` / `MESA_SALT = 950` 常量 |
| `src/gen/structures/structure-layout.js` | layout 返回值加 `mesa: {wx, wz, floorY} \| null` |
| `src/gen/structures/apply.js` | 新增阶段 2.75（光栅化 + 让路判据）；阶段 2.8 的 `allowedAt` 加一条高台占用检查 |
| `src/gen/structures/structure-json.js` | `STRUCTURE_FILES` 加 `cloudlandMesaSmall: 'cloudland_mesa_small.json'` |

**基座掩码不进 layout 层**：候选发现用的是纯常量的 **15×15 实心矩形**（§3.3），不依赖烘焙 JSON。烘焙产物里的 164 格真实基座只用于**光栅化后的断言**（「每列都有基座支撑」），不进热路径。

### 3.8 容量与性能（DR-8）

**几何量级**：高台 10,712 方块 → **4,386 个暴露面**（6 面剔除后）→ **17,544 顶点**，全部进 **opaque** 通道。

参照系：
- 单个 `castle.json` = 10,044 方块（同量级）；
- 巨树 Epic 实测 opaque `active` 容量 4,275,000 顶点、5 视域最坏占用 73.4%（3,478,025）。

**每 region 一个、视距 8 时最多同时加载 ≈ 5 个**（400 格 region、视距 128 格）→ **5 × 17,544 = 87,720 顶点 = opaque 容量基准的 2.05%**。风险等级：**低**。

**零 cutout 影响**（全部映射目标是 opaque 通道） → **不动 `CAPACITY.cutout`**。

**layout 成本**：实测 p50 **0.34ms** / max **0.75ms**，对既有 2.9~3.3ms 是 **+10~12%**，在 §1.2 的 15% 门内。

⚠️ **必须在隔离副本里实测真实页面的 `reservedV`**，不能只按上面这个推演数字结案（巨树 Epic v1.0 的教训：Node 侧估算系统性低 1.20~1.24 倍）。

### 3.9 seededRandom salt（DR-9）

**程序化扫描确认空闲**（不能只 grep 字面量 —— 带 `+ step`/`+ y` 的调用点占用的是区间）：

- 已占用：`100/200/201/301/302/303/311~314/777/800/801/803~805/812/823/824/826/911/921/931/1000/2000/…/16000`；
- 区间占用：`58..107`（云簇 frontier）、`270..397`（landmarks `+302+y`）、`102..112`（terrain `+100+k`）；
- **本设计取 `MESA_SALT = 950`**（`932..999` 空闲带内，已验证 14 个 region 的锚点选择都用了它）。

变体选择（将来加第 2 个变体时用）：`MESA_VARIANT_SALT = 951`。

### 3.10 已有存档（DR-10）

高台是**生成期内容**，与巨树同理：**已有存档的沙漠里会长出高台**，玩家的 edits 照常覆盖在生成结果之上（`restoreEdits` 在 `applyStructuresToColumn` 之后）。**不 bump DB 版本**（用户已就巨树同类情况接受过）。

---

## 4. 已知取舍与有意偏离

| # | 取舍 | 理由 |
|---|---|---|
| ① | **方块配色偏离原版**（源图 40+ 种方块 → 本仓 14 种） | 用户裁决「全部映射到已有方块」：零新增方块/贴图/图标，零容量风险 |
| ② | **不降采样**（原尺寸 1:1） | 桌山形态（底座窄 / 收腰 / 台面宽）在 1/2 比例下会糊掉；且 20×43×21 本就人可绕行 |
| ③ | **只做 1 个变体** | 用户裁决「先随机挑一个相对小的」；表驱动设计保证后续加变体只改数据 |
| ④ | **不进背包** | 高台是地形景观，不是可放置物品（同巨树景观：8 项 `giant_*` 在 `HIDDEN_FROM_INVENTORY`） |
| ⑤ | **不新增 groundSupport** | 基座判据已保证「占地全高于海平面 + 每列都有基座方块」，不需要 `GROUND_SUPPORT_TYPES` 的补柱逻辑；且补柱会填出 15 格宽的石柱凭空插入地形 |
| ⑥ | **撒布结构会被高台覆盖**（后写胜） | 与既有全局语义一致（`makeColumnSetter` 无占用守卫）。这是**已知的全局偏离**，本设计不改变它 |
| ⑦ | **空岛冲突按 AABB 粗判**（不做逐格） | 空岛底 y ∈ [40,68]、台顶 ≤ 51，AABB 判据已足够；逐格会引入不必要的复杂度 |

---

## 5. 测试分级（按 `docs/testing-policy.md`）

| 层 | 内容 |
|---|---|
| **Tier 1**（必须 TDD） | `computeMesaAnchor()` 纯函数（确定性 / 沙漠门控 / 海平面门控 / 空岛剔除 / 内缩边距）；`BLOCK_MAP` 覆盖全部 28 种源方块；烘焙产物 metrics 断言 |
| **Tier 2**（门禁） | `check:data` 的 `[高台]` 环节（指纹 / 方块数 / bbox / 类型都在 registry / 全 opaque） |
| **Tier 3**（免测） | — |
| **Tier 4**（像素实测） | 真实页面截一张沙漠高台，断言「台面海拔高于周边地表 ≥ 30 格」（像素级或世界坐标读取） |

**负向验证**（每个候选判据各一条注入 + 断言必须真 FAIL）：
- 去掉「基座全高于海平面」→ 应出现海岛上的高台；
- 去掉「空岛剔除」→ 应出现穿岛的高台；
- 把 `MESA_SALT` 改成已占用的 `931` → 确定性测试应不 FAIL 但**与巨树候选相关性**会出现（这条只能靠 code review，不写断言）。

---

## 6. 不做的事（范围外）

- `Cloud/` 8 个云团、`ARC/` 11 个拱门、其余 10 个 Landscape 高台、石柱；
- 新增方块 / 贴图 / 图标；
- 高台的可交互性（攀爬辅助、宝箱、楼梯）；
- 高台的 `blockEntity`（它是静态地形，不是装置 —— 与 M9 创造台的「无行为装置」也不同，连持久元数据都不需要）。
