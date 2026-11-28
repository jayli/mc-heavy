# MineColonies 调研：哪些能借鉴或迁移进 mc-heavy

> **性质**：调研报告（只读勘察 + 离线数值探针，**未改动任何引擎代码**）
> **日期**：2026-11-28
> **上游**：`~/jaylli/minecolonies`（`ldtteam/minecolonies` @ `0c4e28253f`，MC 1.20.1 Forge）
> **目的**：回答用户 2026-11-28 的「这里都有什么内容，我可以借鉴或者迁移过来的」
> **姊妹报告**：[`tectonic-terrain-migration-survey.md`](tectonic-terrain-migration-survey.md)（2026-11-16）、
> [`opuscraft-terrain-migration-survey.md`](opuscraft-terrain-migration-survey.md)（2026-11-27）
> **可复现**：[`tools/minecolonies-blueprint-probe.mjs`](../tools/minecolonies-blueprint-probe.mjs)（只读、不依赖 three/DOM）

---

## 0. 结论摘要

**能借鉴的是它的 9515 个建筑蓝图存量 + 一张按格数加权的方块缺口表。玩法层（殖民地模拟）架构上搬不动，也不需要搬。**

MineColonies 是一个完整的 MC 城镇经营模组：2101 个 Java 文件 / **313,874 行**，
核心是「殖民地 + 工人 + 请求系统 + 寻路」四层。这四层与 mc-heavy 的定位（体素引擎 + 战斗）
正交，搬过来要重写而不是移植。

真正有迁移价值的是它的**内容资产**：

| | 值 |
|---|---|
| `.blueprint` 建筑蓝图 | **9515 个 / 53 MB / 24 个风格包** |
| 建筑类型（去等级、去 alt 变体） | **3335 个**，平均每类型 2.9 个文件（等级 1~5 + alt 变体） |
| 原版方块贴图（16×16） | `textures/block/` 1.1 MB（但**只有 mod 自有方块**，不含原版方块贴图） |
| 研究树（纯数据） | 217 个 JSON + 106 个 effect，每个 20 行 |
| 原版 NBT 结构 | 326 个 `.nbt` / 5 MB，vanilla structure 格式（比 `.blueprint` 更好解） |
| 声音 | 6.9 MB（`raid/` 5.1 MB 是袭击战鼓/号角） |

**三条本轮实测的关键数字**：

1. **格式完全可解，且与 mc-heavy 产物同构**：`.blueprint` = gzip + 未压缩 NBT，
   `blocks` 每 int 打包 **2 个 15 位调色板下标**，索引轴序 `(y*sz+z)*sx+x` 由
   **tile_entity 落格判据实测确认 100.0%**（x/z 轴只有 35.8% / 40.7%）。
   `stride:5` 的 palette JSON 就是同一个东西 —— 转换器是纯数据翻译，不是新管线。
2. **51% 的格子是「占位块」**：按格数加权 `structurize` 命名空间占 **50.7%**，
   其中 `blocksubstitution`（"用建筑配置选的材料填充"）的**风格调色板不在仓库里**
   ⇒ 直接转出来的建筑会有近一半格子是空的。这是内容工作量，不是技术难点。
3. **方块覆盖率 9.8%，但几何已经够了**：859 种原版方块里 mc-heavy 能表达 **84 种**；
   缺口最大的是**台阶 20 种 / 楼梯 16 种 / 半砖 20 种**这类**材质变体**，
   而 `TEMPLATES` 早已有 `planks_step` / `half_block` / `handrail` / `vertical_pillar`
   —— 新增一种变体 = `blocks-data.js` 加一行 + 一张 16×16 贴图，**零新几何**。

**开工前要知道的两件事**（都不是阻断项了）：

- **许可已裁定可用**：仓库页标 GPL-3.0，用户 2026-11-28 裁定「可任意使用」（§7.1）。
  残留的只是 GPLv3 的常规义务（衍生产物同样 GPLv3 + 注明来源），不影响能不能迁。
- **三档分解**（§4）：只有 **101 个**蓝图是纯原版调色板（其中 58 个方块零缺口），
  **648 个**只含 structurize 占位块（其中 69 个原版方块零缺口、120 个缺 ≤1 种），
  **8766 个**依赖 `domum_ornamentum` 的 `shingle`/`panel` 几何。想做「立刻能烘」的一批，
  候选池是前两档里那 **127 个**（58 + 69），不是 9515 个。

---

## 1. 上游数据模型与容器格式（成本分水岭）

### 1.1 体量与构成

| 项 | 实测 |
|---|---|
| 仓库总大小 | 690 MB |
| Java | 2101 文件 / 313,874 行 |
| `.blueprint` | 9515 个 / 53 MB（`blueprints/minecolonies/`） |
| `.blueprint` 之外 | 457 个 PNG（风格包图标）、23 个 `pack.json`、1 个 `template.zip` |
| 原版 NBT 结构 | 326 个 `.nbt` / 5 MB（`data/minecolonies/structures/`） |
| 贴图 | `textures/block` 1.1 MB（177 文件）/ `textures/entity` 32 MB / `gui` 396 KB |
| 模型 / 声音 | 3.0 MB / 6.9 MB |

**代码分层**（`src/main/java/com/minecolonies/`）：

| 目录 | 文件 | 行数 | 与 mc-heavy 的关系 |
|---|---:|---:|---|
| `core/colony` | 407 | 77,900 | 殖民地模拟总账（居民/建筑/请求/权限/事件）→ 无对应概念 |
| `core/colony/buildings` | 180 | 30,362 | 55 种 hut 方块 + 各自模块 → 无对应概念 |
| `core/colony/requestsystem` | 65 | 12,139 | 物流中枢（请求/解析/投递）→ 无对应概念 |
| `core/entity/pathfinding` | 39 | 10,243 | A\*（`AbstractPathJob` 单文件 1976 行，8000 节点预算）→ 已有替代（§5） |
| `core/colony/jobs` | 60 | 5,304 | 52 个职业 → 依赖上面三层 |
| `core/entity/ai` | 92 | — | 75 个 worker AI 子类 → 依赖 jobs |
| `core/research` | 12 | — | 研究树（纯数据在 `datagen/generated/`）→ **可借鉴数值设计** |
| `core/entity/mobs` | — | — | 袭击者（海盗/埃及/亚马逊/维京）、市民模型 → 部分可借鉴 |

**结论**：代码层能借的是「研究树的数值设计」与「袭击者的敌人设计」，**不是架构**。
mc-heavy 的 `city-layout.js`（583 行）+ `scatter.js`（731 行）+ `apply.js`（1285 行）
已经把「城市布局 + 结构落地」这件事做完了，方式完全不同（程序化 JSON 结构 vs 蓝图迭代建造）。

### 1.2 `.blueprint` 容器格式（本轮逐项验证）

**顶层键**（9515 个文件一致）：

```
blocks, entities, mcversion, name, optional_data,
palette, required_mods, size_x, size_y, size_z, tile_entities, version
```

| 字段 | 值 | 说明 |
|---|---|---|
| 压缩 | **gzip**（无文件头魔数之外的封装） | 9515/9515 全部可 `gunzip` |
| NBT | 未压缩、标准大端 NBT | 解压后 9515/9515 **逐字节读尽**（无残余、无 alignment） |
| `version` / `mcversion` | `1` / `3465` | 3465 = MC 1.20.1 |
| `palette` | `[{Name, Properties?}]` | 最大 **414** 条目；15 位下标上限 32768，余量 32354 |
| `blocks` | `int[]` | **每 int 打包 2 个 15 位下标**（高 16 位在前） |
| `size_x/y/z` | int | 单结构最大体积 **90,112 格** |
| `tile_entities` | `[{id, x, y, z, …}]` | 共 1,055,050 个，含殖民地逻辑（§5） |
| `optional_data` | 复合 | 只有 `structurize.primary_offset`（建筑锚点） |

**体积校验**：`ceil(sx·sy·sz / 2) === blocks.length` 对 **9515/9515** 成立
（7864 个偶数体积精确 2 格/int + 1651 个奇数体积向上取整）。越界调色板下标 **0**。

**轴序（这是最关键的一条，且我第一版判据错了）**：

先说清楚第一版为什么错：我先用「y=0 层的实心率最高」投票，得到 y 明显胜出——
但差值只有 2 个百分点（58% vs 60%）的边界案例有一百多个，
**这类判据在边界上无判别力**（同 `docs/pitfalls.md` 里「夹具方向错会伪装成接线漏了」那一类）。
真正的错误在于：它测的是「建筑底座铺满不铺满」，而这是建筑的**风格属性**，不是格式属性。

正确判据是 **`tile_entity` 的坐标必然落在非空气格上** —— 箱子/床/招牌/殖民地建筑点
本质上就是某个方块，与「建筑是不是多部件、y=0 是不是地板」全都无关：

| 轴序 | tile_entity 落在非空气格上 |
|---|---|
| `(y*sz + z)*sx + x`（y-major） | **100.0%**（44,218 / 44,226） |
| `(x*sy + y)*sz + z`（x-major） | 35.8% |
| `(z*sy + y)*sx + x`（z-major） | 40.7% |

逐文件胜出（8938 个含 tile_entity 的文件）：**y=7912 / x=0 / z=0**，其余 1026 个是并列
（小结构里三种顺序恰好等价；7912 + 1026 = 8938，无遗漏）。
⇒ **轴序 = y-major，`index = (y*sz + z)*sx + x`，无例外。**

> 补充判据（连通分量数）：抽样 236 个三轴均 >1 的文件，正确轴序下 6-邻接连通分量最少
> 的占 188 个严格胜出 / 46 个并列 / **2 个反例**。2 个反例都是「本来就该是多个独立部件」
> 的结构（`wallgate` 门楼、`covered_mid_b1` 廊桥），说明这条判据不如 tile_entity 那条干净，
> 但方向一致。

### 1.3 与 mc-heavy 现有产物的同构关系

| | MineColonies `.blueprint` | mc-heavy `assets/structures/*.json` |
|---|---|---|
| 容器 | gzip + NBT | 裸 JSON |
| 调色板 | `palette[{Name, Properties}]` | `palette: [name...]` + `stride` |
| 方块数组 | `int[]`，2 格/int | `[x,y,z,paletteIdx(,direction)]` 扁平 |
| 逐格朝向 | 在 `Properties` 里（`facing`/`half`/`shape`） | `stride:5` 的第 5 项 |
| 实体 | `tile_entities[]` | 无（mc-heavy 无方块实体通道） |
| 尺寸典型值 | p50 **3135** 格 / p99 39,690 | `ruined_citadel` **288,744** 格 / 3.7 MB |

**⇒ 转换器是纯数据翻译**。mc-heavy 侧已有全部零件：
`tools/nbt-reader.mjs`（NBT 读取）、`structure-json.js` 的 `stride:5` 格式、
`tools/bake-arena.mjs`（schematic → palette JSON，含逐格朝向 + `FACING_TO_ORIENT` 实测标定）。

**体积不是问题**：`ruined_citadel.json` 3.7 MB → gzip 后 **0.54 MB（15%）**，
dev server 的 `COMPRESSIBLE` 已含 `.json`（`start-server.js:103`）。

---

## 2. 方块构成：51% 是「占位块」

### 2.1 命名空间（按格数加权，全 9515 文件，非空气格 15,715,355）

| 命名空间 | 格数 | 占比 | 含义 |
|---|---:|---:|---|
| `structurize` | 7,973,546 | **50.7%** | 占位块（`blocksubstitution` / `blocksolidsubstitution` / `blockfluidsubstitution` / `blocktagsubstitution`） |
| `minecraft` | 6,538,127 | 41.6% | 原版方块 |
| `domum_ornamentum` | 1,151,517 | 7.3% | `shingle`（屋顶瓦）/ `panel`（墙板）/ `plain` / `vanilla_stairs_compat` |
| `minecolonies` | 51,976 | 0.3% | hut 建造点 / 旗帜 / 矿场等**逻辑方块** |
| `multipiston` | 189 | 0.0% | 可忽略 |

### 2.2 占位块到底是什么（这条决定能不能离线烘焙）

Structurize 的 `blocksubstitution` 语义是 **「用当前建筑配置里选定的材料填充」**：

- 上游 Java 侧：`AbstractEntityAIStructure.getSolidSubstitution()` 返回
  `building.getSetting(FILL_BLOCK).getValue()`（`AbstractEntityAIStructure.java:1152`），
  即**运行期从建筑设置读**，不是蓝图里写死的。
- 蓝图里只存了占位符本身（`palette` 条目长这样：`{"Name":"structurize:blocksubstitution"}`，
  无 `Properties`、无 `textureData`）。
- **风格调色板不在这个仓库里** —— 它是 Structurize 的 Blueprints 包在游戏内配置的。

⇒ **直接转出来的建筑会有约一半格子是空的**。要么：
① 按风格人工裁定一张 `占位块 → mc-heavy 方块` 的替换表（内容工作量，不是技术难点）；
② 只烘「占位块占比低」的分类（§4.2 已按这个排序）；
③ 放弃占位块多的风格，只做纯原版调色板那批（§4.1，仅 101 个）。

⚠️ **反直觉的实测**：占位块占比**不代表质量**。
`infrastructure/mineshafts`（208 文件，平均 5561 格）占位块 **89%** —— 矿道材料本来就该由风格定；
而 `decorations/lights`（平均体积 **8 格**）占位块 21.9%。**不能按「占位块少」筛，要按用途筛。**

### 2.3 几何族构成（按格数加权）

| 族 | 占比 | mc-heavy 现有几何 | 差距 |
|---|---:|---|---|
| structurize 占位块 | 50.7% | — | 需风格表 |
| 单件（整块方块） | 21.2% | `box`（125 种） | **只缺材质变体**，零新几何 |
| domum_ornamentum | 7.3% | — | 需新几何（`shingle`/`panel`） |
| **楼梯** | 4.5% | `planks_step` / `cobblestone_step` / `*_updown` | **只缺材质变体** |
| 原木 | 3.6% | `box` + `orientationModes:0` | 只缺材质变体 |
| 木板 | 3.1% | 同上 | 只缺材质变体 |
| **半砖** | 2.8% | `half_block` / `half_block_updown` | **只缺材质变体** |
| 树叶 | 1.7% | `cutout` + `opaque:true`（9 种） | 只缺材质变体 |
| 栅栏 | 1.4% | ⚠️ 只有 `handrail`/`handrailA`/`handrailB`（装饰杆，语义不同） | **需新几何** |
| 墙 | 0.6% | 无 | **需新几何** |
| 火把 | 0.6% | 无（`glowstone` 是整块光源） | **需新几何 + 需 blocklight** |
| 玻璃板 | 0.4% | 无（有整块 `glass_block`） | 需新几何 |
| 陶瓦 / 地毯 / 羊毛 / 混凝土 / 活板门 / 门 / 彩色玻璃 / 床 / 栅栏门 / 旗帜 / 挂牌 / 立牌 / 蜡烛 | 合计 1.9% | 半砖几何可借 | 视族而定 |

**逐族判据的价值**：它把「859 种缺口」压成「**4 样新几何**（栅栏/墙/火把/门）+ 一批材质变体」。
其余全是 `blocks-data.js` 加一行 + 一张 16×16 贴图（Tier 2 数据改动，免 TDD）。

### 2.4 台阶的朝向复杂度（这条决定要不要做转角件）

| `half/shape` | 格数占比 |
|---|---:|
| `top/straight` | 47.0% |
| `bottom/straight` | 43.1% |
| `top/inner_left` | 1.6% |
| `top/inner_right` | 1.5% |
| `bottom/outer_right` | 1.3% |
| `bottom/outer_left` | 1.2% |
| `top/outer_right` | 1.1% |
| `bottom/inner_left` | 1.1% |
| `top/outer_left` | 1.1% |
| `bottom/inner_right` | 1.0% |

⇒ **90.1% 是 straight**，转角四种合计 9.9%。**先只做 straight 是可行的一期**，
视觉损失局限于楼梯拐弯处的单格。
`half=top` 与 `half=bottom` 各占约一半 —— mc-heavy 的 `planks_step` / `planks_step_updown`
正好就是这对，且 `FACING_TO_ORIENT` 经实测可与两者共用（`bake-medieval-ship` §「正置与倒置台阶
的高侧逐 orient 一致」）。

半砖：`top` 56.8% / `bottom` 40.6% / `double` 2.6% —— `half_block` + `half_block_updown` 覆盖 97.4%，
`double` 可直接映射成整块。

---

## 3. 方块缺口：真实覆盖率 9.8%

| 指标 | 值 |
|---|---:|
| 蓝图出现的原版方块种类 | **859** |
| mc-heavy 能表达（直接同名 ∪ 人工短名映射） | **84** |
| 覆盖率（按种类） | **9.8%** |
| mc-heavy `BLOCKS.length` | 159（19 种几何） |

⚠️ **这个 84 不是「57 个直接同名」**。mc-heavy 对一批方块用了自己的短名，
只数同名会严重低估。可审计的映射表在探针的 `RENAME`（38 条），例如：

| 原版 | mc-heavy | 注意 |
|---|---|---|
| `oak_stairs` | `planks_step_updown` | ⚠️ 语义有偏差（见下） |
| `oak_log` | `wood` | 等价 |
| `grass_block` | `swamp_grass` | **近似** |
| `oak_planks` | `oak_planks_1` | 等价（贴图不同） |
| `hay_block` | `hay_bale` | 等价 |
| `bookshelf` | `bookbox` | 等价 |
| `white_wool` / `blue_wool` / `green_wool` | `white_planks` / `blue_planks` / `green_planks` | **近似**（本仓没做彩色羊毛） |

⚠️ **`oak_stairs → planks_step_updown` 是个陷阱**：那几何是「上半全幅 + 下半 -X 半幅」，
而 `planks_step` 是「下半全幅 + 上半 -X 半幅」—— 两者**不是** `half=top/bottom` 的关系，
是 `planks_step` 的上下镜像。真正的对应是：
`half=bottom → planks_step`、`half=top → planks_step_updown`。
报告用的 `RENAME` 只是「本仓有没有一个能凑合的台阶」，**落地时必须逐格按 `half` 分流**。

### 3.1 缺口 Top 40（按「出现在多少个文件里」）

| 方块 | 文件数 | 几何族 |
|---|---:|---|
| `stone_brick_stairs` | 16898 | 楼梯 |
| `wall_torch` | 14021 | 火把 |
| `spruce_stairs` | 13671 | 楼梯 |
| `dark_oak_stairs` | 10774 | 楼梯 |
| `spruce_fence` | 8815 | 栅栏 |
| `oak_fence` | 8344 | 栅栏 |
| `stone_brick_wall` | 7770 | 墙 |
| `dark_oak_fence` | 7535 | 栅栏 |
| `cobblestone_wall` | 7475 | 墙 |
| `spruce_door` | 7144 | 门 |
| `birch_stairs` | 5801 | 楼梯 |
| `jungle_stairs` | 5612 | 楼梯 |
| `lantern` | 4991 | 单件 |
| `acacia_stairs` | 4961 | 楼梯 |
| `barrel` | 4421 | 单件 |
| `torch` | 4212 | 火把 |
| `iron_bars` | 4073 | 单件 |
| `birch_fence` | 4000 | 栅栏 |
| `dark_oak_door` | 3538 | 门 |
| `jungle_fence` | 3431 | 栅栏 |
| `glass_pane` | 3212 | 玻璃板 |
| `ladder` | 3171 | 单件 |
| `oak_door` | 3166 | 门 |
| `acacia_fence` | 3065 | 栅栏 |
| `polished_diorite_stairs` | 3042 | 楼梯 |
| `spruce_log` | 2984 | 原木 |
| `crafting_table` | 2941 | 单件 |
| `spruce_slab` | 2766 | 半砖 |
| `oak_slab` | 2766 | 半砖 |
| `spruce_trapdoor` | 2764 | 活板门 |
| `gravel` | 2477 | 单件 |
| `oak_trapdoor` | 2425 | 活板门 |
| `furnace` | 2285 | 单件 |
| `dark_oak_leaves` | 2228 | 树叶 |
| `cobblestone_slab` | 2206 | 半砖 |
| `polished_andesite_stairs` | 2165 | 楼梯 |
| `white_bed` | 2122 | 床 |
| `brick_stairs` | 2107 | 楼梯 |
| `dirt_path` | 2043 | 单件 |
| `birch_door` | 1970 | 门 |

**读法**：这张表的作用不是「按顺序补」，而是**告诉你补一种方块能解锁多少文件**。
前 6 名全是「楼梯/栅栏」，全部落在「已有多样材质变体」的两族里 —— 补一种
`stone_brick_stairs` 只加一行 `blocks-data.js`，立刻影响 16898 个文件。

### 3.2 逐风格覆盖率

| 风格 | 文件数 | 原版种类 | mc-heavy 缺 |
|---|---:|---:|---:|
| cavern | 719 | 534 | 471 |
| original | 555 | 504 | 435 |
| ancientathens | 533 | 389 | 335 |
| colonial | 515 | 528 | 460 |
| fortress | 466 | 554 | 487 |
| pagoda | 455 | 371 | 317 |
| caledonia | 442 | 353 | 294 |
| medievaloak | 440 | 459 | 397 |
| jungle | 415 | 377 | 319 |
| nordic | 411 | 352 | 292 |
| acacia | 406 | 388 | 335 |
| medievalspruce | 405 | 449 | 388 |
| shire | 400 | 419 | 355 |
| lostcity | 395 | 475 | 407 |
| medievalbirch | 395 | 455 | 393 |
| medievaldarkoak | 394 | 440 | 381 |
| sandstone | 389 | 481 | 419 |
| birch | 331 | 540 | 472 |
| incan | 331 | 432 | 372 |
| spacewars | 323 | 419 | 356 |
| darkoak | 296 | 528 | 465 |
| warped | 264 | 529 | 463 |
| truedwarven | 235 | 360 | 305 |

**风格间的方块需求高度重叠**（每风格 350~540 种，缺口 290~490）⇒ **不按风格分期**，
按方块族分期。`nordic`（352 种）比 `cavern`（534 种）省 34% 的方块需求，若只做一个风格它最省。

---

## 4. 三档分解：哪些蓝图能立刻烘

⚠️ **这是本报告最容易出错的地方。** 我第一版把「零 modded 依赖」和「方块全可表达」
混成一个口径，得到 240 个候选 —— 实际那 240 里混进了两类完全不同的文件。
按 palette 的**命名空间集合**重新划分，三档**互斥且穷尽**：

### 4.1 三档总表

| 档 | 判据 | 文件数 | 其中原版方块零缺口 |
|---|---|---:|---:|
| ① 纯原版调色板 | palette 里只有 `minecraft:` | **101** | **58** |
| ② 只有 structurize 占位块 | `minecraft:` + `structurize:` | **648** | 69 |
| ③ 含 domum / colony 方块 | 出现 `domum_ornamentum:` 或 `minecolonies:` | **8766** | — |

**① 的缺口分布**：`0种:58  1种:4  2种:8  3种:9  4种:22` —— 一共就 101 个，
说明「完全不用占位块」的建筑在原包里是少数（它们主要是 barracks tower、桥墩、运河、
矿场入口这类功能性部件）。

**② 的缺口分布**：`0种:69  1种:51  2种:113  3种:132  4种:53  5种:56  6种:69  7种:29 …`
—— 这一档是**性价比最高的一期**：648 个文件里 **120 个「缺 ≤1 种方块」**（69 + 51），
补一两种台阶/墙就能烘一大批。⚠️ 中位数是「缺 3 种」，不是「几乎都能烘」。

**③ 逐风格分布**：`cavern:687 colonial:495 ancientathens:489 original:449 fortress:432
medievaloak:427 jungle:409 medievalspruce:403 nordic:398 …`
—— 这一档需要先做 `domum_ornamentum` 的 `shingle`/`panel` 几何（屋顶瓦/墙板），
7.3% 的格子。**不建议一期做**：它是唯一需要「新几何系统」的档。

### 4.2 逐功能分类 × 占位块占比（决定哪些目录先能烘）

只列前 30（完整 197 行由探针输出）。「占位块」低不代表好烘 —— 见 §2.2 的反直觉结论。

| 分类 | 文件 | 平均体积 | 占位块 | 原版种类 | 缺口 |
|---|---:|---:|---:|---:|---:|
| `decorations/retaining_wall` | 8 | 66 | **0.0%** | 12 | 4 |
| `decorations/canals/deep` | 7 | 56 | **0.0%** | 1 | 0 |
| `decorations/agora` | 9 | 414 | 0.6% | 52 | 47 |
| `infrastructure/gates` | 2 | 1729 | 2.9% | 18 | 15 |
| `infrastructure/parks` | 6 | 8662 | 5.1% | 35 | 18 |
| `walls/fences` | 15 | 89 | 8.7% | 14 | 12 |
| `craftsmanship/storage/alternative` | 10 | 3745 | 9.9% | 52 | 40 |
| `infrastructure/roads/urban/road` | 6 | 67 | 10.2% | 1 | 1 |
| `mystic/alternative` | 10 | 7140 | 10.4% | 53 | 42 |
| `mystic/default` | 20 | 2142 | 10.7% | 69 | 54 |
| `agriculture/husbandry/default` | 35 | 2016 | 11.1% | 87 | 62 |
| `decorations/statues` | 33 | 359 | 11.2% | 84 | 66 |
| `infrastructure/halls` | 4 | 4662 | 11.4% | 13 | 9 |
| `infrastructure/roads/rails` | 6 | 75 | 12.1% | 1 | 1 |
| `craftsmanship/luxury/default` | 30 | 1176 | 12.7% | 100 | 85 |
| `decorations/markets` | 17 | 454 | 12.9% | 64 | 47 |
| `craftsmanship/masonry/default` | 20 | 1512 | 13.6% | 81 | 64 |
| `infrastructure/roads/plain` | 8 | 210 | 13.8% | 4 | 4 |
| `craftsmanship/carpentry/default` | 10 | 1008 | 14.3% | 49 | 37 |
| `infrastructure/roads/inland` | 15 | 88 | 14.7% | 7 | 5 |
| `decorations/decorative` | 30 | 2415 | 18.9% | 133 | 108 |
| `decorations/plaza` | 9 | 5082 | 19.0% | 82 | 62 |
| `education/default` | 15 | 2464 | 20.8% | 64 | 54 |
| `military/default` | 25 | 2768 | 21.3% | 63 | 49 |
| `decorations/lights` | 6 | **8** | 21.9% | 2 | 2 |
| `walls/original` | 14 | 173 | 26.6% | 19 | 15 |
| `walls/gate` | 23 | 1018 | 37.9% | 59 | 48 |
| `decorations/utility` | 22 | 2477 | 38.1% | 85 | 68 |
| `infrastructure/roads` | 264 | 487 | 59.6% | 69 | 51 |
| `infrastructure/mineshafts` | 208 | 5561 | **89%** | — | — |

**与 mc-heavy 现有地图的互补性**（这是我认为最该拿的部分）：

mc-heavy 的城市是程序化生成的 16 种"JSON 大楼"（`region-config.js` 的 `CITY_STRUCTURE_CONFIGS`：
castle / bigHouse / treeHouse / uglyHouse / whiteTower …），**没有道路、没有城墙、
没有广场、没有码头**。而 MineColonies 的：

- `infrastructure/roads`（264 文件，92 种类型：直路/路口/台阶/窄巷/林荫道）
- `walls`（墙段/转角/塔/城门，可拼接）
- `decorations`（市集/喷泉/雕像/路灯/码头）

恰好是这类**城市肌理零件**，且大多**体量小、占位块低**。
`decorations/canals/deep`（7 文件，占位块 0%，**1 种方块**）与
`decorations/retaining_wall`（8 文件，占位块 0%）是最干净的样本。

### 4.3 ① 档零缺口的 58 个文件（可直接烘）

探针输出全清单。抽样看内容：

```
acacia/military/barrackstower1..5.blueprint
lostcity/infrastructure/roads/{plain,simple,nice}/*_bridge_pillars.blueprint
original/decorations/misc/simplefountain.blueprint
original/infrastructure/misc/{dig,fill,patrolpoint,waypoint}.blueprint
sandstone/infrastructure/mineshafts/mediumquarry1.blueprint
sandstone/craftsmanship/storage/warehousecourier1..5.blueprint
shire|spacewars|caledonia/military/barrackstower1..5.blueprint
birch|original/infrastructure/roads/{fancy,nice}/*.blueprint
```

价值有限（主要是兵营塔、桥墩、喷泉、路标），但**它们是「转换器正确性」的最廉价验证集** ——
58 个文件、全部零缺口，用来先跑通 `.blueprint → stride:5 JSON → 游戏内落地` 这条链路。

### 4.4 体量分位

| p50 | p75 | p90 | p95 | p99 | max |
|---:|---:|---:|---:|---:|---:|
| 3135 | 5632 | 11250 | 16200 | 39690 | **90112** |

对照 mc-heavy 最大的结构 `ruined_citadel`（288,744 格）⇒ **单个蓝图普遍比现有结构小一个量级**，
不会撞 `genP95` 预算（但要按柱状图重测，见 §6.A）。

---

## 5. 附带价值：纯数据 / 不搬代码

### 5.1 `tile_entities`（1,055,050 个，必须逐类裁决）

| id | 占比 | 数量 | 处理方式 |
|---|---:|---:|---|
| `domum_ornamentum:materially_retexturable` | 90.0% | 949,820 | **丢弃**（材质重着色标记，无方块实体） |
| `minecolonies:rack` | 2.7% | 28,360 | 丢弃 |
| `minecraft:barrel` | 1.0% | 10,222 | 可丢弃或映射成整块 |
| `minecraft:bed` | 0.9% | 9,369 | **保留朝向**（本仓有 bed_head/bed_tail） |
| `minecolonies:colonybuilding` | 0.7% | 7,214 | **丢弃**（hut 建造点，纯游戏逻辑） |
| `minecraft:banner` | 0.7% | 7,017 | 丢弃 |
| `domum_ornamentum:dynamic_timberframe` | 0.6% | 6,783 | 丢弃 |
| `minecraft:sign` | 0.6% | 6,513 | 丢弃（本仓无挂牌方块） |
| `minecraft:furnace` | 0.4% | 4,079 | 丢弃或整块 |
| `minecolonies:namedgrave` | 0.4% | 3,726 | 丢弃 |
| 其余 30+ 类 | 2.4% | — | 逐类裁决 |

⚠️ **这 90% 的 `materially_retexturable` 就是 domum_ornamentum 的运行时重着色机制** ——
它解释了为什么 §4 ① 档只有 101 个文件，也说明**③ 档的难点不是几何，是材质重着色**。

### 5.2 `minecolonies:*` 方块（43 种）

全是**游戏逻辑方块**，离线烘焙时必须丢弃或替换：
`blockhut<职业>`（55 种 hut 建造点，如 `blockhutbuilder`/`blockhutfarmer`）、
`colony_banner`（123 文件）、`gate_wood`（116）、`blockpostbox`（54）、`blockstash`（52）、
`blockconstructiontape`（45）、`simplequarry`/`mediumquarry`。

本仓**一个都不该要** —— 它们是殖民地系统的锚点，mc-heavy 没有对应概念。

### 5.3 研究树（纯数据，可直接借数值设计）

| 分支 | JSON 数 |
|---|---:|
| civilian | 69 |
| combat | 68 |
| technology | 76 |
| unlockable | 4 |
| effects（等级收益定义） | 106 |

单项长这样（`combat/duelist.json`，20 行）：

```json
{
  "branch": "minecolonies:combat",
  "costs": [{ "type": "minecolonies:item_simple", "item": "minecraft:iron_ingot", "quantity": 64 }],
  "effects": [{ "id": "minecolonies:effects/meleearmormultiplier", "level": 3 }],
  "icon": "minecraft:chainmail_chestplate",
  "parentResearch": "minecolonies:combat/riposte",
  "requirements": [{ "type": "minecolonies:building", "building": "minecolonies:smeltery", "level": 3 }],
  "researchLevel": 4
}
```

**价值**：若 mc-heavy 以后做「科技树 / 装备升级」，这是现成的 **217 节点 DAG** 数值设计
（成本曲线、前置深度、等级收益 5 档）。⚠️ 但它耦合了「建筑等级」作为前置条件，
直接搬要先把 `requirements` 的 building 门拆掉。

### 5.4 原版 NBT 结构（比 `.blueprint` 更好解）

`data/minecolonies/structures/` 有 **326 个 `.nbt` / 5 MB / 13 个风格**，
是 **vanilla structure 格式**（带 `DataVersion`、`palette`、`blocks` 长数组）。
259 个含 `structurize` 占位块（同样问题），共出现 401 个原版方块名。

**为什么值得单独提**：这是在 MC 原生结构方块里直接放的格式，任何 MC 结构工具都能读写，
且**不含 domum_ornamentum 依赖**（`minecolonies` 的 25 个 `.nbt` 是精简版：
builder/cook/courier/farm/forester/house/guardtower/… 每风格约 25 个）。
若要「先在 MC 里改了再烘」，用这批 `.nbt` 比 `.blueprint` 阻力小。

### 5.5 声音与贴图

| 素材 | 体量 | 可否用 |
|---|---|---|
| `sounds/raid/` | 5.1 MB | 袭击战鼓/号角，**按旧裁定不烘焙、直接指向文件** |
| `sounds/mob/` | 856 KB | 市民/袭击者音效 |
| `sounds/tile/` | 1.0 MB | 方块音效 |
| `textures/block/` | 1.1 MB / 177 文件 | **只有 mod 自有方块**（无原版方块贴图）⇒ 不能靠它补 §3 的材质变体 |
| `textures/entity/` | 32 MB | 市民/马/袭击者/盾牌；GLB 模型在 `models/` |
| `gui/` | 396 KB | 殖民地 UI 图标 |

⚠️ **`textures/block/` 里没有原版方块贴图**（我核过：`oak`/`cobble`/`planks` 零命中）。
这意味着 §3 的「只缺材质变体」需要**另外找贴图来源**（mc-heavy 现有的
`assets/textures/*.png` 是 132 张 16×16 原版贴图；缺的是 sprace/dark_oak/birch 木种变体）。

---

## 6. 与 mc-heavy 硬约束的正面冲突

### A. `genP95 < 8ms` 冻结预算

`structure-gen.spec.mjs` 钉住「每 region 的 GEN p95 < 8ms」。当前城市布局 + 撒布已接近上限
（`docs/roadmap.md`「撒布密度刻意低于 mc-lite」段明确记了：大 JSON 光栅化是 p95 大头）。

**蓝图比现有 JSON 结构更小**（p50 3135 格 vs `ruined_citadel` 288,744 格），所以单体不成问题；
但**数量**是风险：`infrastructure/roads` 一个分类就 264 个文件，若按城市肌理铺进去，
每 region 的 `rasterizeStructure` 调用次数会涨一个量级。

⇒ **必须先重测 `genP95`，不能假设「更小就没问题」**（同 `docs/pitfalls.md`
「既有判据标定的目标变了，断言会变成恒真」那一类）。

### B. 通道容量（`render-world.js` 的 `CAPACITY`）

当前冻结值：`opaque.active=1800` / `cutout.active=550` / `transparent.active=240`，
三通道静态内存 **(4.275M + 2.20M + 300K) × 30B = 193.62 MiB**，门是 `m3-fullscene` 的 **200 MiB**。

⚠️ **余量只有 6.4 MiB**。台阶/半砖必须写 `opaque:false`（`docs/pitfalls.md`：「非 box 几何必须
显式 `"opaque":false`」），走 **cutout 通道**（`active=550`，峰值 38.3%）。
按 §2.3 台阶 4.5% + 半砖 2.8% + 栅栏 1.4% = **8.7% 的蓝图格数会进 cutout**。
铺开规模未知，**但这是唯一会直接撞破冻结门的地方**。

⇒ **任何「先烘一批进去看看」的方案必须先按真实 mesher 重测 cutout 峰值**
（`render-world.js:204` 的口径是 `reserved = 1.25 × 已用`，且扩容是**离散 ×1.5 跳增、粘性不回缩**）。

### C. 消费面：`apply.js` 的阶段层序是载荷性的

`apply.js` 的阶段 1 → 2.45 → 2.4 → 2 → 2.7 → 2.75 → 2.76 → 2.8 → 2.85 → 2.9 → 2.93 → 2.94
→ 2.5 → 3 是**载荷性**的（调换会让「树冠打穿屋顶」「祭坛被广场材质盖回」这类缺陷复活）。

新的建筑蓝图若要按城市肌理落地，**必须决定它插在哪个阶段**，不能"随便加在后面"。
最自然的插入点是**新增一个阶段 2.6x（在 2 JSON 结构之后、2.7 撒布之前）**，
理由是：① 建筑体量大于撒布物（要压住撒布）；② 必须在植被（阶段 3）之前（树要长在建筑周围）。

### D. `generateHeight` 40 个消费方

蓝图落地需要「地面高度」判据（和现有 `houseAnchorY` / `computeArenaAnchor` 同一件事）。
现有的「占地最低地表 + 1」与「占地内高差 ≤ 3」两条门控（`scatter.js` 的
`HOUSE_MAX_SURFACE_SPAN`）**可以直接复用** —— 这是既有代码，不是新设计。

### E. 方块注册序

`docs/pitfalls.md`：「末尾追加方块不得清档（用 `fingerprintOfPrefix`）；改方块数后要跑一次
`tests/unit-fast.spec.mjs`」。加 §3 那批材质变体会改 `BLOCKS.length`（159 → 200+），
**必须确认所有 `fingerprintOfPrefix` 覆盖了新前缀**。

---

## 7. 上游许可

| 项 | 值 |
|---|---|
| 代码 + 数据 | **GPLv3**（`LICENSE`，GNU General Public License Version 3） |
| 上游仓库页 | `https://github.com/ldtteam/minecolonies` 标注 **GPL-3.0** |
| 蓝图目录 | `src/main/resources/blueprints/`，9515 个 `.blueprint` / 53 MB |
| 资产子目录里的一行 LICENSE | `src/main/resources/assets/minecolonies/LICENSE` 内容为 `All Rights Reserved` |
| `CONTRIBUTING.md` / `README.md` | 只说「不限制 GPL 授予你的权利」，**未对美术资产另作说明** |
| `AGENTS.md`（上游自带） | 声明「AI 生成实现代码不被鼓励」，并禁止 Mixin 类下游修改 —— **与我们从外部读数据无关** |

### 7.1 许可裁定（用户 2026-11-28）

> **用户明确裁定：整个仓库（含蓝图与资产）适用 GPLv3，「完全没有版权的风险，可以任意使用」。**

我此前把 `assets/minecolonies/LICENSE` 那行 `All Rights Reserved` 当成待裁决阻断项，这个判断被用户推翻：
上游仓库页标注的就是 **GPL-3.0**，资产随仓库走同一许可。**本节不再作为开工前置条件**，
后文所有「需先解决许可」的门槛一律作废。

落地时仍按 GPLv3 的常规义务执行（这不影响能不能用，只影响怎么标注）：

- **衍生作品同样以 GPLv3 分发** —— 烘焙产物（`.json` 结构）是从蓝图派生的，属衍生数据。
- **注明来源**：新增的烘焙脚本、产物伴随 JSON 指纹、以及本文档引用处均写明
  `来源：MineColonies (ldtteam/minecolonies, GPL-3.0)`。
- 若 mc-heavy 自身以非 GPL 许可发布，需单独评估「把 GPL 数据烘成产物并入库」的边界 ——
  这是发布决策，不是本次迁移的阻断项，**未在本报告内解决**（见 §9 未核边界）。

> ⚠️ 另注：`structurize` / `domum_ornamentum` 是 **LDT 的另外两个 mod**（`gradle.properties:31-32`
> 声明版本依赖）。若要完整还原 ③ 档，需要它们的几何与重着色机制 —— 但**不需要它们的代码**，
> 因为我们只烘最终方块数据，不跑运行期。

---

## 8. 落地路线（立项后）

### 路径 ①：只补方块族（最小，不依赖蓝图）

- 加 20 种台阶 + 20 种半砖的**材质变体**（`blocks-data.js` 加行 + 16×16 贴图 + `faces-data.js` 加面表）
- 加 4 样新几何：**栅栏 / 墙 / 火把 / 门**（`TEMPLATES` 各一份，`handrailA/B` 可作栅栏起点）
- **零蓝图、不依赖上游资产**。贴图自己画或用 mc-heavy 现有素材衍生。
- 收益：mc-heavy 自身地图的建筑表达力立刻变丰富（现有 `scatter.js` / `city-layout.js` 不动）。
- 成本：Tier 2 数据改动为主；新几何部分 Tier 1 TDD。
- **风险**：改 `BLOCKS.length` 会动所有指纹前缀（§6.E）；cutout 峰值要重测（§6.B）。

### 路径 ②：切片烘焙（推荐）

前置：**先跑通 §4.3 那 58 个零缺口文件**作为转换器正确性验证集。

1. 写 `tools/bake-minecolonies-blueprint.mjs`（`.blueprint` → `stride:5` palette JSON）
   - 复用 `tools/nbt-reader.mjs` + `tools/giant-pyramid-fingerprint.mjs` 的 `FACING_TO_ORIENT`
   - 丢弃：`tile_entities` 全部、`minecolonies:*` 全部、`domum_ornamentum:*`（一期）
   - 占位块：按 §2.2 三选一（人工风格表 / 跳过该分类 / 只做 ① 档）
   - 产物指纹进 `check:data`（照 `tools/arena-fingerprint.mjs` 的口径）
2. 先烘 **① 档 58 个 + ② 档「缺 ≤1 种」的 120 个**，共约 178 个文件
3. 落地：新增 `apply.js` 阶段 **2.6x**（在 2 JSON 结构之后、2.7 撒布之前），走现有
   `rasterizeStructure` + `buildStructureGeometry` 管线
4. 门禁：`genP95`、cutout 峰值、`m3-fullscene` 的 200 MiB、以及**像素实测**
   （`docs/testing-policy.md` Tier 4：新结构落地属 GPU 可见结果）

### 路径 ③：整包移植（不做）

9515 个全转 + `domum_ornamentum` 的 `shingle`/`panel` 几何 + 材质重着色机制。
理由：内容量超出引擎当前表现力（7.3% 格子需要新几何系统），且必然撞 §6.B 的容量门。

### 推荐分期

| 期 | 内容 | 前置 |
|---|---|---|
| P0 | 跑通 §4.3 的 58 个文件（转换器 + 像素判据） | 无（许可已裁定，§7.1） |
| P1 | 补台阶/半砖材质变体（约 40 行 `blocks-data.js`） | 无 |
| P2 | 栅栏/墙/火把/门 四样新几何 | P1 的门禁经验 |
| P3 | ② 档 648 个里「缺 ≤1 种」的 120 个落地 | P1/P2 + `genP95` 重测 |
| P4 | `infrastructure/roads` + `walls` 作为城市肌理 | P3 的容量实测 |

---

## 9. 方法论与未核边界

### 怎么核的（可复现）

```bash
# 单命令跑完全部数字（只读，不写任何文件）
node tools/minecolonies-blueprint-probe.mjs          # 人类可读
node tools/minecolonies-blueprint-probe.mjs --json    # 机器可读
```

探针做的事：

1. `gunzip` + 自写 NBT 解析（tag 1~12，**不支持** TAG_End 之外的定长数组快捷路径，
   即 `int[]`/`long[]` 逐项读）；
2. 解包 `blocks` 为 `2 × ints` 个 15 位下标；
3. **体积校验**：`ceil(vol/2) === ints`（9515/9515 通过，这是「格式已正确解析」的第一道自证）；
4. **轴序判据**：`tile_entity` 坐标必须落在非空气格上（三轴各算命中率 + 逐文件胜出）；
5. 命名空间 / 几何族 / 台阶 shape / 半砖 type 按**格数**加权（不是按文件数 —— 文件数会被
   等级 1~5 与 alt 变体放大 2~5 倍）；
6. 三档分解按 palette 的**命名空间集合**（互斥且穷尽）；
7. 方块覆盖率 = 蓝图出现的原版方块 ∩（mc-heavy `BLOCKS` ∪ 手写 `RENAME`）。

**探针自证**：解压后 `consumed === total` 对 9515/9515 成立（无残余字节），
越界调色板下标 0。

### 没核的（⚠️ 引用本文数字时必须带上这些边界）

- **`RENAME` 是人工核对的近似映射，不是形式化等价**。例如
  `grass_block → swamp_grass`、`white_wool → white_planks` 只是「本仓有一个语义接近的方块」。
  真实落地必须逐格裁决，且台阶要按 `half` 分流到 `planks_step` / `planks_step_updown`
  （§3 的两个 ≠ 同一几何）。
- **占位块的最终材料不在仓库里**（§2.2）。所有关于它的数字只描述「量」，不描述「该变成什么」。
- **几何族的归类是按方块名后缀的启发式**（`_stairs` → 楼梯 等）。会有少量误判
  （如 `staircase` 不含 `_stairs`）。
- **没有在游戏里加载过任何一个蓝图**。本报告全部是离线读字节，没有视觉产出比对。
  §2.3 的「只缺材质变体」是**基于 mc-heavy 的 `TEMPLATES` 清单推断**，不是实测渲染结果。
- **`genP95` 与 cutout 峰值未实测**：§6.A/§6.B 是**风险提示**，不是测量。任何一期开工前
  必须按 `npm run test:unit`（`structure-gen`）+ `npm run bench` 重测。
- **蓝图的数量效应未测**：单个体积小于现有结构，但 `infrastructure/roads` 一类有 264 个文件，
  铺进城市后每 region 的 `rasterizeStructure` 次数未知。
- **`tile_entities` 的保留/丢弃裁决是建议**，不是实现。`materially_retexturable` 占 90% 这件事
  说明 ③ 档真正的难点是**材质重着色机制**而不是几何 —— 这一条是**推断**（来自 id 名 + 7.3% 的
  `domum_ornamentum` 格数），未读其 Java 实现（它在另一个 mod 里，不在本仓库）。
- **研究树的耦合未细看**：§5.3 的 `requirements` 里 `building` 前置有多少节点依赖、拆掉后
  DAG 是否仍连通，未统计。
- **GPLv3 的分发义务未评估**：§7.1 已钉住「可用」，但「烘焙产物入驻 mc-heavy 后是否因其 GPL 派生
  而传染本仓整体许可」未展开 —— 那是发布决策，不属本次调研范围。
- **§7.1 的许可裁定来自用户，不是我的核查**：我核到的是仓库页标 GPL-3.0 + 资产子目录里那行
  `All Rights Reserved`；两者关系由用户裁定为「随仓库走 GPLv3」。本节不复述法律结论。

### 上游许可

见 §7：仓库页标 **GPL-3.0**，用户已裁定可任意使用（§7.1）。**不再作为开工前置条件。**

---

## 10. 与既有两份 survey 的关系

| | Tectonic | OpusCraft | **MineColonies** |
|---|---|---|---|
| 上游是什么 | 地形数据包（105 JSON DF） | 从零重写的 MC（TS） | **MC 城镇经营模组（Java）** |
| 可迁的东西 | 地形 2D 骨架 | 地形 3D 密度场 | **建筑蓝图存量 + 方块缺口表** |
| 载体 | JSON | TypeScript | **gzip+NBT 蓝图** |
| 主要成本 | 采样模型差异（3D vs 标量 h） | GPU 水面遮罩 | **51% 占位块 + 新几何** |
| 许可 | MIT ✅ | MIT ✅ | **GPLv3 ✅（可用，需注明来源）** |
| 与本仓冲突 | `genP95` + `generateHeight` 40 消费方 | 同上 + 存档兼容 | **cutout 容量 + `apply.js` 阶段层序** |

**三者的共同结论**：真正的成本都不在「代码能不能搬」，而在
**「上游的数据模型与本仓的硬约束之间的错位」**。MineColonies 的错位点是
**占位块（数据不在仓库里）** 与 **domum_ornamentum 的材质重着色（7.3% 格子）**。