# 巨树景观 Epic 设计（v1.1）

**日期**：2026-10-23（v1.0 初稿 → v1.1 同日审阅修订）
**素材**：`assets/giant-trees/src/40AssortedTreesPack.schem`（**入库**；原件 `~/ttt/[BoutiqueBuilds] 40AssortedTreesPack/[SCHEMATIC] 40AssortedTreesPack.schem`，262,091 B，WorldEdit Sponge Schematic v3，DataVersion 4440，400×206×254，sha256 `217e215b…93aa8`）
**状态**：**已交付**（验收报告 [`docs/giant-trees-acceptance-report.md`](../giant-trees-acceptance-report.md)；计划 [`docs/superpowers/plans/2026-10-23-giant-trees.md`](../plans/2026-10-23-giant-trees.md)）。设计已评审，用户已逐项裁决（§0.2）

---

## 0. 修订说明（v1.0 → v1.1）

v1.1 是在 `git archive HEAD`（`218f836`）的**隔离副本里按 v1.0 + 旧计划原文真跑**之后的修订：烘焙脚本、方块/贴图、候选发现、column 光栅化、接线、浏览器内单测、真实页面（WebGPU）通道占用、全量 Playwright 回归都实际执行过。下表每一条都有实测依据，不是读文档推断。**v1.0 里凡与本节冲突的内容一律作废。**

### 0.1 变更总表

| # | 议题 | v1.0 | v1.1 | 依据（实测） |
|---|---|---|---|---|
| 1 | 验收口径 | Node 侧「注入树 + 真 mesher」得到的**已用顶点**占比 ≤ 100% | **真实页面 reserved 口径**（reserved = 1.25 × 已用，`render-world.js:204`；实测 `Σreserved/Σused = 1.250`）。opaque ≤ 90% 且零扩容；cutout / transparent **相对 HEAD 不恶化** | 同视域对照：v1.0 的 HEAD 基线 68/73/64/70/69 vs 真实页面 82.3/87.6/79.1/84.6/83.0（×1.20~1.24）；v1.0 的「最坏 93%」×1.25 = 116% |
| 2 | 容量 | 不放宽，守 §4.10 的 150MiB | **opaque `active` 1200 → 1800（2.85M → 4.275M）**，静态 148.06 → 188.83 MiB（**用户裁决 (a)**） | 计划参数在 2.85M 下 (-20,10) 122.9%、森林冲刺 134.8~142.9%；HEAD 自己密林 cutout 128% / 冲刺 145% 已越线（§2.5） |
| 3 | 树叶阴影 | `shadowCast:false`，称「对齐 mc-lite 树叶口径」 | **投影**（**用户裁决**）；`[阴影投射]` 门禁与其 13 项清单**不改** | mc-lite 的 20 项不投影里**没有任何树叶**；门禁「临界对照」要求 `leaves` 必须投影；同为 opaque 叶的 `sky_leaves` 也投影。按 v1.0 写法 Task 2 末尾 `check:data` 即红 |
| 4 | 素材 | 仓库外，只读，不入库 | **入库** `assets/giant-trees/src/`（**用户裁决**） | 指纹依赖仓库外文件 → 任何别的机器 `npm run check` 必红；其它烘焙输入（`night-src` / `turret_pic*`）都入库 |
| 5 | 变体集合 | 36 个：`tallOak` 13（含 5 棵混交树）+ `jungleGiant` 3（「保留备用」） | **28 个**：高橡/白桦 8、雪松 4、樱花 4、椰子 4、榕树有叶 4、榕树枯干 4。排除 12 = 无树干 4 + 混交 5 + 丛林 3 | v1.0 §2.2 自己的决策（混交/丛林偏热带不用于森林）与旧计划矛盾；`jungleGiant` 无任何落位路径使用 = 死数据 |
| 6 | 降采样规则 | 「每 K³ 内按出现次数投票取多数」 | **写死**：空气 / 展示台 / 被丢弃的装饰件**不参与投票**，≥1 个可映射方块即保留该格，取最大票，同票下标小者胜（`palette[0]` = 树干故树干不丢） | 字面多数投票（空气算一票）40 棵只得 6.4k~10.2k 格；本规则得 25.8k~26.3k，与 v1.0 的 25,640 相符（v1.0 的**数字**对应本规则，**文字描述**与它不符） |
| 7 | 方块分类 | 3 条正则 + 一个未定义的「grass 类」 | **24 个源方块名逐个归属**（§2.3），未知名字烘焙时 throw | 旧分类漏 4 个名字共 6,711 格（7.34%），含樱花冠主体 `pink_concrete(_powder)` 4,732 格 |
| 8 | 地块索引 | 「pad 索引」未定义排序 | 按 `(minZ, minX)` 升序；烘焙末尾按源方块名做**族标志反向校验** | x 优先序下 40 个位置全部错位 |
| 9 | 候选算法 | 逐点扫 region 160,000 格 + region 内贪心排序 | **全局对齐网格 + 内缩抖动**：一格一点、相邻点切比雪夫距离 ≥ spacing+1 由**构造**保证、无状态、跨 region 无缝（§3.4） | 候选发现 14~20 ms/region → ~1.1 ms；跨 region 边界间距违规 64 对（A18/B33/C13）→ 0 |
| 10 | 密度旋钮 | `forestChance = 0.10`（称「改一个数即可回退」） | `chance` = 每格出点概率（线性旋钮）；密度主要由 spacing / jitter 决定 | 原写法 0.10 → 0.01 只少 40%（143 → 86 棵），spacing 24 才 −59%：候选密度远超间距饱和密度，贪心结果由间距决定 |
| 11 | 让路 | A 路径无城内门控；B/C 的 `city` 在非 (0,0) region 恒为 null | **apply 层**排除：`pointContext` ∈ {normal, water} + 撒布结构 / 平地金字塔岛 / 海岛塔的 JSON 占地外包盒（§3.5） | 3×3 region 内 325/2013（16%）的树进城；排除城市后仍有 12.4% 压地标、9.4% 压撒布结构；既有 `pyramid` / `pyramidIsland` 用例被树覆盖而红；平地沙台只有 ±15 而 JSON 占地 34×39 |
| 12 | 邻域合并 | `giantCandidates[k] = layout.giantTrees[k]`（**覆盖赋值**） | **拼接** + 规范顺序（路径序, wx, wz） | `layouts` 是 3×3 邻域数组；区域(-1,0) 内 625 个 column 只会光栅化 1 棵（应 359 棵，0.3%），256 个 column 的真实 GEN 里零个 `giant_*` 方块 |
| 13 | 旋转 | `seededRandom(...) & 3` | `Math.floor(r*4)`，单一出处 `giantTreeRotation` | `seededRandom` 返回 [0,1) 浮点，`& 3` 恒 0（4 万个点直方图 `[40000,0,0,0]`）；旧测试用 `forcedRot` 绕过所以全绿 |
| 14 | 旧植被互斥 | `covered` 只标本 column 内的 AABB | **覆盖窗口** = AABB ⊕ EXT 铺满 column ± EXT；EXT 与阶段 3 的植被扫描外扩是**同一个常量** | 阶段 3 会外扩 3 格扫描，column 外 3 格带里的旧树把树冠写进本 column：每 256 个 column 游离 5,332 格没有树干的旧树冠 |
| 15 | 单格植物 | 「树下长草合理，不跳过」 | 覆盖区内**目标格已被占用（非空气）则不写**；空气格照常生成 | 植物写在 `h+1` = 巨树 `gy=0` 层：31 格/256 个 column 被顶掉，含 23 格树干（单树干的树因此悬空） |
| 16 | 悬空树干 | 无 | `gy=0` 树干格下方悬空 1~10 格补同种树干（地基） | 22% 的树基部悬空 ≥1 格，最高 9；项目已有 `GROUND_SUPPORT_TYPES` 同一语义 |
| 17 | Worker 预热 | `applyStructuresToColumn` 里 `await loadGiantTrees()` | + Worker 模块加载期预热，`layout` / `gen` 入口 await 同一个 promise | `structure-gen` genP95（门 10ms）：HEAD 8.1~9.8 / 无预热 11.6~14.0 / 预热 8.4~10.0 |
| 18 | 贴图 | `assets/textures/giant/` 8 张（含无人引用的 `giant/oak_log`） | `assets/textures/procedural/giant_*.png` **6 张**；`giant_oak_log` / `giant_oak_leaves` 复用既有 tile；脚本入库；**粉叶已预烘焙备用**（§3.6.2） | `atlas.spec` 只数 `.` / `procedural` / `inventory-icons` / `bed` 四个目录；`giant/oak_log.png` 无人引用 = 孤儿 tile |
| 19 | 对既有测试的影响 | 未提 | **有意同步**：4 条硬编码计数/清单单测、`m3-fullscene` 的 150 → 200 MiB；既有 `pyramid` / `pyramidIsland` / `island tower` 用例**不得改动** | 影子树真跑：`registry 126→134`、`HIDDEN 6→14`、`orientation 86→94`、`gpuVertexBytes 198,000,000` |
| 20 | 若干不实/过期声明 | 见右 | 纠正：① 贴图色值「从 schematic 实测」（`.schem` 只存方块名，不含颜色）→ 艺术基色；② genP95 门 8ms → **10ms**（v1.42 起的用户裁决）；③ 删除对不存在的 memory `prefer-simplest-format-over-custom-binary` 的引用；④ 「cutout 回退是唯一会撞破 150MB 的路径」不成立（HEAD 自己就越线） | 逐条核实 |

### 0.2 用户裁决记录（2026-10-23）

| 议题 | 裁决 | 落点 |
|---|---|---|
| 预算 | **接受 (a)**：opaque 容量 ×1.5；验收改为「真实页面 reserved 口径 + 相对 HEAD 不恶化」 | DR-10 / DR-17、§1.2、§3.9 |
| 巨树叶是否投影 | **投影** | DR-11、§3.6 |
| `.schem` | **入库** | DR-12、§3.1 |
| 已有存档 | **接受**：已有存档里的森林会长出巨树 | DR-13、§3.10 |
| 粉色镂空树叶 | 按计划（沿用现有镂空叶图案、只换色）**先烘焙备用** | §3.6.2；`assets/giant-trees/staging/giant_cherry_leaves.png` |
| 其余审阅意见 | 全部采纳（候选算法、让路、覆盖窗口、地基、预热、Task 1 规则写死等） | 本文各节 |

### 0.3 测量口径与环境

- 一律在 `git archive HEAD`（`218f836`）的隔离副本里做（独立端口、`node_modules` 软链），**主仓库零改动**。
- **占用 = Σ `slot.reservedV` / 初始容量常量**，在真实页面（WebGPU，`channel:'chromium'`）读 `renderWorld.slotMap`。相对**初始**常量算，因为扩容是黏性的（当前 `maxVertexCount` 会随历史漂移）。
- **口径校准**：同一脚本在 HEAD 出生点读到 opaque 81.6 / cutout 72.3 / transparent 10.6，与 roadmap v1.42 记载的稳态 82.9 / 72.3 / 10.6 对得上（opaque 差 1.3 来自其后天空树密度减半）。
- 视域 = 5 个固定 column 视点（`(18,27)` `(-20,10)` `(30,10)` `(-25,-5)` `(10,40)`，vd=8，seed=12345，队列收敛 + section 数连续 2s 不变）；冲刺 = 12s、8 格/秒、250ms 采样峰值。**同一视点两次测量逐位相同**（测量本身零噪声）。
- ⚠️ 出生点 `(283,117)` 在**城市中心**（城市 bounds x∈[0,566] z∈[-166,400]，region (0,0) 整块都在城内）：从出生点向三个方向冲 96 格都出不了城，**永远测不到树**。冲刺必须从森林/海岸起步。

---

## 1. 目标与验收口径

### 1.1 目标

把素材包里原版 Minecraft 景观树按 **1/2 比例**引入 mc-heavy（28 个变体），按三条地形规则落位：

| 路径 | 落位规则 | 来源族（各 50%） | 间距 / 抖动 | 实测密度 |
|---|---|---|---|---|
| **A 森林** | `biome === 'FOREST'` 且陆上（`h > SEA_Y`）；与旧森林树互斥（覆盖窗口） | 高橡/白桦（8）· 雪松（4） | **32 / 8** | 每 1523 个森林格 1 棵（v1.1 初版 14/8 是 464、20/8 是 586；原贪心 371） |
| **B 海边树林** | 陆上且距水 ≤ 24（4 轴向、步长 4 采样） | 樱花（4）· 椰子（4） | 8 / 6 | 每 199 个近水带格 1 棵（原 175） |
| **C 榕树带** | `PLAINS`/`DESERT` 且 4 轴向 ±32 处任一端点跨到另一种 | 榕树有叶（4）· 榕树枯干（4） | 8 / 6 | 每 207 个交界格 1 棵（原 224） |

三条路径**共同**的让路规则：城市、地标（金字塔 / 平地岛 / 海岛 / 雪原 / 冰封山）、撒布结构与 JSON 结构占地内不落树（§3.5）。

### 1.2 验收口径（可量化）

1. **预算（真实页面，reserved 口径）**：在 `CAPACITY.opaque.active = 1800` 下，固定 5 视域 + 3 条森林/海岸冲刺：
   - opaque ≤ **90%**，且 `renderWorld._capacity.opaque.maxVertexCount` 仍为 **4,275,000**（零 opaque 扩容）；
   - cutout / transparent 的占用与冲刺峰值**不高于 HEAD 同位置基线 + 1.0**（HEAD 基线冻结在 `tests/giant-tree-budget.spec.mjs`，来源见 §2.5）。
   > 为什么是「相对 HEAD」而不是「绝对不扩容」：HEAD 自己在密林视域就越线（cutout 128.1%、森林冲刺 cutout 145.4%，会触发 ×1.5 扩容），「任何视域都不扩容」对 HEAD 就不成立。本 Epic 只替换旧森林树（cutout 通道）、不碰水，所以 cutout 只会降（(-20,10) 128.1 → 53.9）。
2. **确定性与接缝**：同 seed 两次生成逐格一致；跨 column / 跨 region 接缝无缝（候选判定是无状态纯函数，排除判定对覆盖该树的任一 column 结论一致，§3.5）。
3. **让路**：巨树方块**零**落在城市 bounds、各地标范围、撒布结构与 JSON 结构占地内。
4. **不破坏既有玩法**：
   - `structure-gen` fixture 的含结构 genP95 门（`test-structure-gen.html:102`，**10ms**）不破；全量回归全绿；
   - **有意变更的既有断言恰好是**：4 条硬编码计数/清单单测（§3.9 末表）与 `m3-fullscene` 的 150 → 200 MiB（用户裁决）；
   - 既有 `pyramid`、`pyramidIsland`、`island tower` 用例**不得改动**且全绿（它们是让路的回归门）。
5. **观感**：森林里能明显看出「有些树比别的大得多」；城市靠海一侧能走进成片樱花 + 椰林；草地/沙漠交界能遇到榕树；巨树不压房子、不进城。

### 1.3 明确不做（YAGNI）

- 不做方块实体 / 运行时行为（树是纯静态方块）；不做砍树/掉落/生长。
- 不实现素材里的装饰件几何（栅栏 / 台阶 / 活板门 / 砖墙 / 楼梯）——**降采样时丢弃**，实测占树体方块的 3.60%（3,288 / 91,381）。
- 不做新几何模板（全部 `geometry:"box"`）；**不改 mesher / materials / scheduler**；`render-world.js` 只动 `CAPACITY` 一行常量与其注释（DR-10）。
- 不做 LOD、不做存档迁移（DR-13）。
- 不烘焙无消费者的变体（丛林 3、混交 5）。

---

## 2. 素材实测（决策依据）

### 2.1 结构

- `.schem` 是世界编辑器展示台：`y=0` 是 `cyan_terracotta` 全幅 400×254（101,600 格）；`y=1` 层有 `netherite_block` 圈 + `white_stained_glass` + `light_gray_concrete`。**这些都不是树**，必须剥离。
- 40 棵树在 40 个矩形地块上（26×26 ×28、33×33 ×12）。`netherite_block` 在 `y=1` 层的连通分量恰好 40 个（4 连通与 8 连通结果相同），每个分量的 bbox 就是一个地块。
- **地块索引 = 把 40 个分量按 `(minZ, minX)` 升序排好后的下标**（等价于先 z 后 x 的扫描序）。这个约定是载荷性的：改成 x 优先则 40 个位置全部错位、整张族映射表作废。树体取 `y ∈ [2, H)`（`y=0` 地板、`y=1` 展示台圈）。

### 2.2 族群（按源方块名反向校验，非按名字猜）

素材共 9 族 40 棵；本 Epic 取其中 6 族 **28 棵**：

| 族 | 地块（pad） | 变体尺寸 w×d×h | 降采样后格数 | 路径 |
|---|---|---|---|---|
| `tallOak` 高橡/白桦 | 8 10 14 16 24 26 34 36 | 10×10×42 · 10×10×33 · 10×11×32 · 11×12×28 · 10×10×26 · 11×11×26 · 9×9×19 · 9×10×20 | 874 / 915 / 671 / 744 / 366 / 631 / 249 / 399 | A |
| `snowSpruce` 雪松 | 11 17 27 37 | 11×12×38 · 9×9×32 · 10×9×27 · 9×8×16 | 932 / 467 / 353 / 232 | A |
| `cherry` 樱花 | 0 1 6 7 | 17×17×27 · 17×17×20 · 17×17×21 · 15×15×13 | 1698 / 1244 / 1155 / 546 | B |
| `palm` 椰子 | 13 19 29 39 | 11×9×22 · 11×11×20 · 11×11×16 · 11×11×14 | 225 / 205 / 190 / 214 | B |
| `banyanLeafy` 榕树有叶 | 20 21 30 31 | 17×17×12 · 17×15×16 · 17×17×18 · 17×17×21 | 571 / 738 / 1057 / 1197 | C |
| `banyanBare` 榕树枯干 | 22 23 32 33 | 13×13×26 · 12×13×20 · 13×13×18 · 13×11×15 | 383 / 259 / 242 / 197 | C |

**排除的 12 个**：`12 18 28 38` 云杉带园墙（实测**无树干**，只有叶团 + 砖墙/栅栏门）；`4 9 15 25 35` 混交巨树（jungle+oak 叶混生，偏热带，§2.2 v1.0 决策不用于森林）；`2 3 5` 丛林巨树（无任何路径使用，且 v1.0 旧计划把它们当「备用」烘焙 = 死数据）。

A 路径变体的 AABB 最大 12，所以 spacing 14 → 两棵树的 AABB 互不相交；B/C 的樱花/榕树 AABB 达 17、spacing 8 → 冠幅互相重叠成片（设计意图「成片樱花 + 椰林」），树干不重叠。

### 2.3 方块分类（唯一分类表）

28 个变体里共出现 **24 个源方块名**，按族逐个归属（`-1` = 丢弃）。**素材里出现、表里没有的名字烘焙时直接 throw**——不允许「悄悄丢掉」或「悄悄归到某类」。

| 族 | 树干（palette[0]） | 叶（palette[1..]） | 丢弃（-1） |
|---|---|---|---|
| `tallOak` → `[giant_oak_log, giant_oak_leaves, giant_birch_leaves]` | `oak_wood` `birch_wood` | `oak_leaves`→1；`birch_leaves`→2 | `large_fern`（地被）`spruce_slab` `spruce_stairs` |
| `snowSpruce` → `[giant_oak_log, giant_spruce_leaves]` | `stripped_dark_oak_wood` | `spruce_leaves` `snow_block` `snow`→1 | `dark_oak_slab` `dark_oak_trapdoor` `dark_oak_fence` |
| `cherry` → `[giant_oak_log, giant_cherry_leaves]` | `spruce_planks` `oak_wood` `stripped_spruce_wood` | `cherry_leaves` `pink_concrete_powder` `pink_concrete` `pink_wool` `sponge`→1 | `spruce_slab` |
| `palm` → `[giant_oak_log, giant_palm_leaves]` | `spruce_planks` | `jungle_leaves`→1 | — |
| `banyanLeafy` → `[giant_mangrove_log, giant_banyan_leaves]` | `mangrove_wood` | `oak_leaves` `birch_leaves`→1 | — |
| `banyanBare` → `[giant_mangrove_log]` | `dark_oak_wood` | — | `dark_oak_fence` |

要点：
- 樱花树的粉色体积主要来自 `pink_concrete(_powder)` / `pink_wool` / `sponge`（占樱花树体约 70%），**全部并入樱花叶**；漏掉 `pink_concrete*`（4,732 格）会把樱花冠掏空近三成。
- 雪块 / 雪层并入雪松的叶（8 个方块是上限，不新增雪方块）。
- 白桦叶映射到独立的 `giant_birch_leaves`（v1.0 旧计划把白桦也染成橡树色，同时让 `giant_birch_leaves` 变成无人使用的死方块）。
- **只有两种树干**（`giant_oak_log` / `giant_mangrove_log`）：雪松/樱花/椰子/白桦共用深棕干。**这是有意偏离素材**（原素材里椰子树用 `spruce_planks` 浅色干、白桦用白色干），验收时不要当成 bug。

### 2.4 降采样（规则写死）

K = 2。每个 2×2×2 立方块：

1. 空气、展示台材质、被丢弃（-1）的装饰件/地被**都不参与投票**；
2. 只要有 ≥ 1 个可映射方块，该格保留；
3. 取出现次数最多的调色板下标；同票时**下标小者胜**（`palette[0]` = 树干，所以树干不会在降采样里消失）。

| 规则 | 40 棵全量产出（格） |
|---|---|
| **本规则（空气不参与，任一非空保留）** | **25,753 ~ 26,349**（视分类是否补 `pink_concrete*`）|
| 空气算一票、非空 > 半数 | 6,401 ~ 7,033 |
| 空气算一票、非空 ≥ 半数 | 9,461 ~ 10,216 |
| 非空 ≥ 2 | 18,366 ~ 19,125 |

v1.0 报告的 25,640 对应本规则；它的**文字描述**（「多数投票」）与实现不符——按字面做出来的树是稀疏空壳，且 §2.4 / §2.5 的全部预算数字都不适用。

28 个变体合计 **16,954 格**（= 本规则 36 变体的 25,205 减去混交 4,366 与丛林 3,885，逐位吻合），`trees.json` **156,440 B（152.8 KB）**。烘焙脚本末尾断言总格数落在 [16,000, 18,000]。

**锚点**：每个变体 `gy=0` 层树干格中离几何中心 `(w/2, d/2)` 最近者（平分取遍历序最先者）。**不是几何中心**——实测最大偏移 2 格。28 个变体的 `gy=0` 层都有树干格（锚点非 null）。

### 2.5 真实页面预算实测（决策依据）

**HEAD 基线**（初始容量 2.85M / 2.2M / 0.125M；reserved%，三列 = opaque / cutout / transparent）：

| 视域 / 路径 | HEAD |
|---|---|
| 出生点 (283,117)（城市中心） | 81.6 / 72.3 / 10.6 |
| (18,27) | 82.3 / 48.4 / 36.8 |
| (-20,10) | 87.6 / **128.1** / **100.3** |
| (30,10) | 79.1 / 70.8 / 11.2 |
| (-25,-5) | 84.6 / 21.2 / 49.0 |
| (10,40) | 83.0 / 30.1 / 85.8 |
| 冲刺 森林(-20,10)→西 | 99.9 / 129.3 / 128.7 |
| 冲刺 森林(-20,10)→南 | 103.1 / **145.4** / 140.8 |
| 冲刺 海岸(10,40)→东 | 98.4 / 57.1 / 114.3 |
| 冲刺 出生点→西 / 南 / 东（全程在城内） | 106.3 / 97.6 / 102.4（opaque）|

HEAD 在 (-20,10) 与森林冲刺 cutout / transparent 已越 100% → 触发 ×1.5 扩容（cutout → 3.3M、transparent → 187.5K），动态 GPU ≈ 190MB，已超出 §4.10 的 150MiB。

**v1.0 的 Node 侧数字对照真实页面**（同视域、同一基线）：

| 视域 | v1.0 HEAD 基线（opaque） | 真实页面 HEAD | 比值 | v1.0「三路全开」 | ×1.25 后 |
|---|---|---|---|---|---|
| (18,27) | 68 | 82.3 | 1.21 | 80 | 100 |
| (-20,10) | 73 | 87.6 | 1.20 | 93 | **116** |
| (30,10) | 64 | 79.1 | 1.24 | 77 | 96 |
| (-25,-5) | 70 | 84.6 | 1.21 | 91 | **114** |
| (10,40) | 69 | 83.0 | 1.20 | 84 | **105** |

v1.0 把「已用顶点占比」当成了「reserved 占比」。v1.0 自己的表乘 1.25 之后，5 个视域里 3 个已经 > 100%：**「opaque 叶可行」的结论缺了这个 ×1.25**。

**v1.1 终版（候选 = 网格抖动，A32/8·B8/6·C8/6；容量 opaque 4.275M）**：

> ⚠️ A 森林的 spacing 于交付当天两次上调：14 → **20** → **32**（用户两轮实玩反馈「想更稀疏」后「再降一倍」，
> 两次都选「拉大间距」而非降 `chance`——间距保持「每棵树都在均匀格子里」，不会出现成片空缺）。
> **密度精确减半**（7 region 实测 243 → 122 棵 = 0.502；1/765 → 1/1523）。
> 下表是 14/8 的实测；20/8 时 opaque 峰值 78.6%、32/8 时 **76.4%**（冲刺森林→南），
> 静态五视域与另两条冲刺全部不高于下表。两个 Tier 4 spec 6 条全绿，单测 810/810。

| 视域 / 路径 | opaque（相对 4.275M） | cutout | transparent | 巨树方块（已加载 column） |
|---|---|---|---|---|
| 出生点（城市中心） | 54.4 | 72.3 | 10.6 | 0 |
| (18,27) | 58.0 | 45.9 | 36.8 | 15,316 |
| (-20,10) | **70.2** | 53.9 | 100.3 | 61,967 |
| (30,10) | 53.8 | 69.9 | 11.2 | 4,850 |
| (-25,-5) | 69.6 | 12.2 | 49.0 | 59,916 |
| (10,40) | 61.6 | 17.2 | 85.8 | 29,960 |
| 冲刺 森林(-20,10)→西 | 79.6 | 54.9 | 128.7 | — |
| 冲刺 森林(-20,10)→南 | **82.1**（A20/8 后 78.6，A32/8 后 76.4） | 60.3 | 140.8 | — |
| 冲刺 海岸(10,40)→东 | 72.6 | 25.9 | 114.3 | — |

- **opaque 最高 82.1%、零 opaque 扩容**；cutout 处处不高于 HEAD（巨树替掉旧树，(-20,10) 128.1 → 53.9，冲刺 145.4 → 60.3）；transparent 与 HEAD **逐位相同**（巨树不碰水）。
- 同一终版换回 2.85M 容量：(-20,10) = 70.2 × 1.5 = 105.3%、森林冲刺 123.2% → 必然扩容。这就是容量上调（DR-10）的依据。
- **v1.0 参数（贪心 + 混交树 + 36 变体）在 4.275M 下的最坏冲刺是 95.3%**（静态 81.9%）：v1.1 终版同密度下反而更轻，因为剔除了 5 棵最大的混交树，且网格抖动不会像贪心那样局部堆满。

**更轻的备选（均**未**采用**，留作回退参考；相对 2.85M，v1.0 参数）：1/3 缩放 静态最坏 101.8%/冲刺 119.3%；间距 24/16/16 104.9%/124.4%；二者叠加 94.8%/111.9% —— 没有任何单一减载方案能让冲刺回到 100% 以内，所以裁决走「抬容量」。

### 2.6 候选算法校准（为什么是网格抖动）

7 个 region（−1..1 十字 + 对角，各路径 eligible 格数 A 158,232 / B 176,928 / C 68,036）：

| 路径 | 方案 | 点数 | 密度（每 eligible 格） | Clark–Evans R¹ | 耗时 |
|---|---|---|---|---|---|
| A | 原贪心（0.10 / 间距 16） | 426 | 1/371 | 1.92 | 14~20 ms/region（三路径合计） |
| A | **网格抖动 14/8** | 341 | 1/464 | 1.80 | ≈0.3 ms |
| A | **网格抖动 20/8** | 270 | 1/586 | 1.72 | ≈0.2 ms |
| A | **网格抖动 32/8**（交付值） | 122 | 1/1523 | 1.65 | ≈0.15 ms |
| B | 原贪心（1/16 / 间距 12） | 1009 | 1/175 | 2.19 | — |
| B | **网格抖动 8/6** | 891 | 1/199 | 1.91 | ≈0.5 ms |
| C | 原贪心（1/24 / 间距 12） | 304 | 1/224 | 1.96 | — |
| C | **网格抖动 8/6** | 328 | 1/207 | 1.69 | ≈0.3 ms |

¹ R = 1 完全随机泊松，> 1.8 偏规则格子。**新方案三路径的 R 都不高于原贪心**：原贪心因为候选密度远超间距饱和密度，结果就是接近堆积极限的硬核填充，本身就比网格抖动更规则。三路径合计 **≈1.1 ms/region**（对照既有 `computeScatterCandidates` 4.4~6.4 ms）。

另试了「泊松盘式局部最大值」（每格全抖动 + 3×3 邻域内保留优先级最高者）：R 降到 1.62~1.67，但 B 路径每 region 要 3~5 ms（近水判据逐原始点求值），收益不值得，**未采用**。

3×3 region 块内（含 region(0,0) 城区）：原始候选 A 446 / B 1158 / C 399；再按城市 + 地标判定扣除后 282 / 776 / 240（撒布结构再约 −9%）。网格间距的构造保证实测：同路径最小切比雪夫距离 A 15 / B 9 / C 9（= spacing + 1）。

### 2.7 地形事实

- **城市矩形**（seed 12345）：x∈[0,566]、z∈[-166,400]；region (0,0)（x,z∈[0,399]）整块在城内；出生点 (283,117) 在城市中心。南侧 z=400 外几格即海（h=-3）。
- 地表高度 h ∈ [-16, 16]（`noise` 是 sin/cos 之和，值域 [-4,4]），树最高 42 → 树顶 ≤ 59 < `WORLD_MAX_Y`(96)，**无需做 Y 裁剪判据**。
- 地形/生物群系噪声是 sin/cos 之和，**近似周期**（温度 ≈628 格、湿度 ≈419 格），所以三条路径的落位图也近似周期重复 —— 这是既有世界的性质，不是本 Epic 引入的。
- 草地/沙漠交界是 PLAINS 与 DESERT 的接壤带（中间可能夹 SWAMP，所以只有湿度 ≤ 0.5 的接壤才有交界）。

---

## 3. 架构设计

### 3.1 数据格式与素材入库

**JSON，扁平数组 + palette**（复用 `structure-json.js` 既有的 fetch + 模块缓存路径，零新编解码器）：

```json
{ "version": 1, "scale": 2,
  "trees": { "tallOak": [ { "pad": 8, "w": 10, "d": 10, "h": 42, "anchor": [4,4],
                            "palette": ["giant_oak_log","giant_oak_leaves","giant_birch_leaves"],
                            "blocks": [gx,gy,gz,palIdx, ...] }, ... ], ... } }
```

- `blocks` 是扁平四元组，坐标以「块底角」为原点、`gy ∈ [0,h)`（与 mc-heavy 模板坐标口径一致，无需 ±0.5 换算）。**`palette[0]` 恒为树干**（地基填充按这个约定认树干）。运行时加载成 `Uint8Array`（取值 ≤ 42，不必 25k 个小数组）。
- 为什么不用自定义二进制：152.8 KB 的 JSON 走已跑过几个 Epic 的加载路径，不新增编解码器 + 往返单测。
- **素材入库**：`assets/giant-trees/src/40AssortedTreesPack.schem`（烘焙输入，**不是渲染资源**，与 `assets/sky/night-src/` 同口径；静态服务器不会也不应该 fetch 它）。只入库 `.schem`（262,091 B），原包里的 `.bp` / Java World（3.5 MB）不入库。
- 烘焙产物 `assets/giant-trees/trees.json` + `trees.meta.json`（尺寸 + 输入指纹）。指纹 = 入库 `.schem` 的 sha256 + 全部烘焙参数（SCALE、族表、调色板、分类表、族标志）的 sha256，烘焙脚本与 `check:data` 共用 `tools/giant-trees-fingerprint.mjs`（红线 1）。**不依赖任何仓库外文件**。

### 3.2 体积

| 量 | 值 |
|---|---|
| 原始树体方块（40 棵，y≥2） | 91,381 |
| 其中装饰件（栅栏/台阶/半砖/活板门/楼梯） | 3,288（3.60%），丢弃 |
| 降采样后（28 变体） | 16,954 格 |
| `trees.json` | 156,440 B（152.8 KB） |
| `.schem`（入库） | 262,091 B |
| 现有 `assets/structures/` 总计 | 3.9 MB |

### 3.3 为什么是独立模块，不是 JSON 光栅化结构

`scatter.js` 已有「代码生成撒布类型走 `CODE_GENERATORS`、不占 `SCATTER_FOOTPRINT`」的分流。巨树有 28 个变体，每个都要按 AABB 裁剪跨 column 光栅化 —— 若走 `rasterizeStructure(type, …)`，`type` 得是 28 个键，`SCATTER_JSON_TYPES` / `check:data` 的 `jsonTypes` 派生基准全要膨胀。所以新增 `src/gen/structures/giant-trees.js`，**复用既有「region layout 层算候选 + column 层 AABB 裁剪光栅化」两段式**，但按「族数组 + 变体 hash」组织，不往 `SCATTER_TYPES` 加键。

```
region layout 层   computeGiantTreeCandidates(regionX, regionZ, seed)
                     → { forest, beach, banyan: Int32Array }   每项 stride=5: [wx, wy, wz, familyIdx, variantHash]
column 应用层      applyGiantTrees(column, layouts, seed, registry, { allowedAt, ext })
                     → 拼接邻域候选 → AABB 取交 → 排除 → 光栅化 + 地基 → 返回「旧植被覆盖窗口」
```

必须两段式的原因（红线 2）：树可跨 column（最大 17 格，覆盖 2~4 个 column）。若在 column 层直接判定，同一棵树在不同 column 会得出不同的生成结论 → 接缝断裂。候选在 region 层算一次，`layout` RPC 下发，各 column 只做几何裁剪。

### 3.4 候选发现：全局对齐网格 + 内缩抖动

对每条路径（参数见 §1.1 表）：

```
C = spacing + jitter                        // cell 边长
cell (i, j) 出点  ⇔ seededRandom(i, j, seed+salt)   < chance
 wx = i*C + floor(seededRandom(i, j, seed+salt+1) * jitter)
 wz = j*C + floor(seededRandom(i, j, seed+salt+2) * jitter)
 族 = families[ seededRandom(i, j, seed+salt+3) < 0.5 ? 0 : 1 ]
 variantHash = floor(seededRandom(i, j, seed+salt+4) * 65536)     // 光栅化层再 % 该族变体数
 归属 region = (floor(wx/400), floor(wz/400))；只保留落在本 region 内的点
 谓词（每格至多求值一次）：见下
 wy = h + 1
```

- **间距由构造保证**：点只落在 cell 内 `[0, jitter)` 的内缩方块里，相邻 cell 的点相差 ≥ `C − (jitter−1) = spacing + 1`（同行/同列/对角均成立）。不需要贪心、不需要排序、不需要跨 region 协调；实测同路径最小切比雪夫距离 A 15 / B 9 / C 9。
- **跨 region 无缝**：cell 按全局网格对齐（下标 = `floor(世界坐标/C)`），一个 cell 横跨 region 边界时两侧各算一次、各自只保留落在本 region 内的点 → 不重复、不遗漏。
- **谓词先廉价后昂贵**：每格至多 1 个点才求值，不再为 160,000 个格逐点算 biome/距水。
- **盐值**（`seededRandom` 的 salt）：forest 911~915、beach 921~925、banyan 931~935、rotation 941。**程序化扫描**（`src` 下全部 `seededRandom` 调用，排除 tests）确认 900~999 整段空闲；roadmap 的 salt 表只扫了 1..500，本 Epic 取空闲带 9xx，不与云簇 `58..107`、地层 `102..112`、岩石 `270..397`、植被 `800..805` 等任何已占区间相交。⚠️ 旧计划里列的占用段清单与 roadmap 表不一致（如 `301..430` vs `270..397`），结论（911~919 空闲）虽成立但清单本身不可信，已删除。
- 共享谓词（**候选层与测试共用同一份导出函数**，红线 1；v1.0 的测试自己另写一份判据且采样方式与实现不同）：
  - `isNearWater(wx, wz, seed, band)`：4 轴向、步长 4（`r = 4, 8, …, band`），任一采样点 `generateHeight < SEA_Y`；
  - `isBiomeEdge(wx, wz, seed, band)`：本点是 PLAINS/DESERT，且 4 轴向 `±band` 处任一端点是「另一种」；
  - A 路径：`getBiome === 'FOREST'` 且 `h > SEA_Y`；B：`h > SEA_Y` 且 `isNearWater(…, 24)`；C：`h > SEA_Y` 且 `isBiomeEdge(…, 32)`。
- **候选层不需要 `city`**：城市让路在 apply 层做（§3.5）。v1.0 的 `computeGiantTreeCandidates(…, city)` 在非 (0,0) region 里 `city` 恒为 null，等于没有城市门控。

### 3.5 column 层

流水线（`applyGiantTrees`）：

```
合并邻域候选(拼接) → 解析（变体 = list[hash % n]，朝向 = giantTreeRotation）→ 与窗口 AABB 外扩 ext 取交
 → 规范排序（路径序, wx, wz）→ 排除（isGiantTreeAllowed）→ 光栅化 + 地基（只对 AABB 与本 column 相交者）
 → buildCoveredWindow（供阶段 3 抑制旧植被）
```

**合并与规范顺序**：`layouts` 是查询域内最多 9（跨 region 边界的 column 最多 16）个 region 布局。**必须拼接，不得覆盖赋值**；并按 `(路径序, wx, wz)` 排成规范顺序，使逐格「后写胜」的结果与 `layouts` 的下发顺序无关。

**排除（让路）`isGiantTreeAllowed(tree, allowedAt, exclusionBoxes)`**：
1. AABB 九点（四角 + 四边中点 + 中心）与锚点：`allowedAt` 必须全真。`allowedAt` 由 apply.js 用 `pointContext` 构造（导出为 `giantAllowedAtFor`，测试复用同一份判据）：只允许 kind ∈ {`normal`, `water`}（`water` = 树冠悬在水面上），排除 `city` / `none`（金字塔、平地岛）/ `island` / `snow` / `fm`。
2. 不与任何**既有结构外包盒**相交（`collectExclusionBoxes`）：
   - 城外撒布结构（house / flowerBed / tallWell / 沙漠结构 / 沉船…）：`SCATTER_FOOTPRINT` 的 halfX/halfZ，外扩 1；
   - **平地金字塔岛 JSON 占地**（halfX 17 / halfZ 20）与**海岛塔**（halfX 4 / halfZ 5），外扩 2（= apply.js 的 `INTERSECT_MARGIN`）。
   > ⚠️ 只靠 `pointContext` 不够：平地沙台的 `getPlainLandInfo` 只有 ±15，而 `pyramid_island.json` 占地 34×39，比沙台大 2~5 格 —— 实测只用 `pointContext` 时既有的 `pyramidIsland` 用例被树干覆盖。

**结论对覆盖该树的任一 column 恒一致**（否则同一棵树在两个 column 里一个生成一个不生成 → 半棵树）：判定只依赖树本身与邻域 layouts。与树 AABB 相交的 column 位于树所在 region 或其相邻 region；它的 3×3 查询域含该树所在 region 及**朝向该 column 一侧**的全部邻居。能影响树 AABB 的地标/撒布只来自树所在 region 及其相邻 region（地标外延 < 60 格 ≪ region 边长 400），而背向一侧的邻居（≥300 格外）够不到 → 两侧看到的相关布局相同。

**光栅化 + 地基**（`rasterizeGiantTree`）：每个变体格 `(gx,gy,gz,pal)` 按 `rotateCell` 旋转后写 `setBlock(x0+rx, wy+gy, z0+rz, palette[pal])`（`makeColumnSetter` 自带 column 裁剪，未注册名静默跳过——所以 `check:data` 钉 palette ⊂ registry）。`gy=0` 层的树干格（`palette[0]`）若下方悬空（地表 `h < wy−1`），用同种树干向下补到 `h+1`（深度 1~10；> 10 不补）。直接用 `generateHeight`（纯函数、跨 column 一致）而不是探测 column 内容——探测在 column 边缘取不到邻列数据。这与既有 `GROUND_SUPPORT_TYPES` 机制（`structure-json.js`）是同一语义。

**覆盖窗口与旧植被互斥**（`buildCoveredWindow`）：窗口 = column 外扩 `ext` 的 `(16+2ext)²` 位图；每棵树的**覆盖区 = AABB ⊕ ext**（Chebyshev 外扩）。`ext` 取阶段 3 植被扫描的外扩 `VEGETATION_EXT = 3`（树冠半径 ≤ 3，与阶段 3 **同一个常量**）。阶段 3 对窗口内的每个点判 `giant.covers(wx, wz)`：命中则**不生成旧植被树**。
  - 为什么覆盖区要外扩 ext：旧树冠半径 ≤ ext，树干落在 AABB ⊕ ext 内的旧树，其树冠才可能碰到巨树 AABB；于是「AABB 内不存在任何旧树方块」是**可证明**的，而不只是概率上成立。
  - 为什么窗口要外扩 ext：阶段 3 会扫描 column 外 ext 格带，带内旧树的树冠会写进本 column；v1.0 的 `covered` 只标本 column 内，实测每 256 个 column 游离 5,332 格无树干的旧树冠。

**单格植物规则**：阶段 3 的 `roll.plant` 写在 `h+1`，正是巨树 `gy=0` 层。规则：`giant.covers(wx,wz)` 且目标格已非空气（被树干/贴地叶或地基占用）则**不写**；目标格是空气（覆盖区内树冠下方的空地）照常生成。**不能**写成「覆盖区内一律不生成植物」——那会让既有 PLAINS 植被用例（固定坐标采样）变红，也无必要。

### 3.6 方块与贴图

#### 3.6.1 8 个方块（全部 `geometry:"box"`、`orientationModes:0`、`solid:true`、`cullMode:"opaque"`）

| 方块 | 用于 | faces tile |
|---|---|---|
| `giant_oak_log` | 高橡/白桦/雪松/樱花/椰子的树干 | `['log_big_oak','log_big_oak','log_big_oak_top','log_big_oak_top','log_big_oak','log_big_oak']`（**复用既有 tile**） |
| `giant_mangrove_log` | 榕树干 | `procedural/giant_mangrove_log`（单 tile） |
| `giant_oak_leaves` | 高橡叶 | **`leaves`（复用既有 tile）** |
| `giant_birch_leaves` | 白桦叶 | `procedural/giant_birch_leaves` |
| `giant_spruce_leaves` | 雪松叶（含雪块/雪层） | `procedural/giant_spruce_leaves` |
| `giant_cherry_leaves` | 樱花叶（含粉混凝土/羊毛/海绵） | `procedural/giant_cherry_leaves` |
| `giant_palm_leaves` | 椰子叶 | `procedural/giant_palm_leaves` |
| `giant_banyan_leaves` | 榕树叶 | `procedural/giant_banyan_leaves` |

- **树叶 `opaque` + 投影（用户裁决）**：`opaque` 让叶-叶共享面互剔（`mesher.js` 判据 `opaqueTable[neighbor]===1`），单棵树顶点远少于 cutout；**投影**与同为 opaque 叶的 `sky_leaves`、既有 `leaves` 同口径，`[阴影投射]` 门禁（`EXPECTED_NO_CAST` 恰 13 项，且「临界对照」要求 `leaves` 必须投影）因此**不需要改**。不要写 `opaque:false`（叶-叶不再互剔）、不要写 `shadowCast:false`（v1.0 的写法会让 Task 2 末尾 `check:data` 红，且其「对齐 mc-lite 树叶口径」的理由与事实相反）。
- **`opaqueTable=1` 的四项后果**（CLAUDE.md 既有约束）：邻居面剔除（收益）、AO 遮挡、blocklight 阻断、炮塔 LOS / 弹丸阻挡。巨树叶与 `sky_leaves` 同属这一族：巨树冠会遮挡 AO 与 blocklight、会挡炮塔视线。这是本 Epic 的**第七处**与 mc-lite 行为的差异（mc-lite 无这些树，所以它是「新内容的既有口径」，不进「六处偏离」那个视觉比对清单）。
- **全部不进背包**（`HIDDEN_FROM_INVENTORY` +8，语义 = 可放置但不进背包，与 `chimney` 同类；**不要**塞 `NON_PLACEABLE_ITEMS`）。registry 126 → 134，背包集合仍是 116 项（134 − 4 − 14）。

#### 3.6.2 贴图：沿用现有镂空叶的图案，只换色（粉叶已预烘焙）

**做法**（`tools/bake-giant-textures.mjs`，确定性）：源图 `assets/textures/leaves.png`（16×16，**alpha 孔洞图案**：59 个不透明 / 13 个全透明 / 184 个半透明；alpha < 77 的 80 个像素是 cutout 材质 `alphaTest 0.3` 会丢弃的「镂空」）。
- **alpha 通道逐字节保留**（孔洞形状不变）；RGB **全部重算，含 alpha=0 的像素**：巨树叶走 opaque 通道，材质无 `alphaTest`，**alpha 被忽略 → 孔洞处直接显示该像素的 RGB**。若把透明像素的 RGB 留成原来的绿色，粉叶上会渗出绿点；留成黑色则出黑点。
- 重着色 = 亮度比乘法：`out = base × k`，`k = max(0.45, 1 + CONTRAST × (Y/Y_ref − 1))`；`Y` = Rec.709 亮度，`Y_ref` = 可见像素亮度的 p90（所以 `base` 是「受光最亮那档叶面」的颜色）。
- **`CONTRAST = 0.6`** 是有意压缩明暗：源图是深绿叶，亮度比低到 0.55；原样乘到亮粉上（1.0）最暗处变成发闷的紫褐色（Y=93），对樱花叶偏脏；0.6 保留叶脉图案又不发闷（最暗 Y=123）；0.4 几乎变平。可按观感调这一个常量。

| 贴图 | 源 | 基色 `base` | 实测可见像素均值 RGB |
|---|---|---|---|
| `giant_birch_leaves` | `leaves.png` | (160, 235, 150) | (148, 218, 139) |
| `giant_spruce_leaves` | `leaves.png` | (35, 95, 60) | (32, 88, 56) |
| `giant_cherry_leaves` | `leaves.png` | (255, 140, 195) | **(236, 130, 181)**（22 个像素 R 饱和） |
| `giant_palm_leaves` | `leaves.png` | (45, 150, 55) | (42, 139, 51) |
| `giant_banyan_leaves` | `leaves.png` | (85, 185, 75) | (79, 171, 69) |
| `giant_mangrove_log` | `log_big_oak.png` | (135, 65, 65) | (126, 61, 61) |

- 基色是**艺术取色**，不是「从 schematic 实测」（`.schem` 只存方块名，不含任何颜色信息 —— v1.0 的该说法不成立）。樱花粉 (236,130,181) 与 `sky_leaves` 的 (253,104,179) 同属粉色系但更浅；两者在画面里可区分（实测截图）。
- **粉叶已预烘焙**（用户要求「备用」）：`assets/giant-trees/staging/giant_cherry_leaves.png`（999 B，sha256 `8847b717…10f51`，16×16，镂空像素 80/256，两次烘焙逐字节相同）。暂存目录**不在 `assets/textures/` 下**——`build-atlas.mjs` 递归扫描整个 `assets/textures`，`atlas.spec` 断言「atlas tile 数 ≡ 目录 PNG 数」，直接放进去会在没重跑 `npm run atlas` 前变红。Task 2 补全脚本表、烘焙终态产物后，用 `cmp` 确认暂存的粉叶与终态逐字节相同，再删暂存目录。
- 终态位置 `assets/textures/procedural/giant_*.png`（落在 `atlas.spec` 已统计的 `procedural` 目录内 → **不用改该 spec**）。atlas 147 → **153 tile**（+6），既有 147 个 tile 里 32 个坐标被重排；`icons-atlas.png` / `icons.json` 逐字节不变（8 个新方块全部隐藏，不在背包集合，**不需要**重跑 `npm run icons`）。

### 3.7 旋转

`giantTreeRotation(wx, wz, seed) = floor(seededRandom(wx, wz, seed+941) * 4)`，**单一出处**：光栅化、覆盖窗口、测试都用它，候选层不存旋转（stride 不再多一列）。`rotateCell` 绕 AABB 顺时针 90°×rot：`rot=1` 时 `(x,z) → (d−1−z, x)`；非正方形 AABB 旋转后宽深互换，**一律用 `rotatedFootprint`**（17×16 的树旋转后是 16×17，沿用未旋转的 w/d 做 AABB 会把树切掉一角）。

### 3.8 性能

| 项 | 实测 |
|---|---|
| 候选发现（region 层，三路径合计） | **≈1.1 ms/region**（v1.0 逐点扫描 14~20 ms；既有 scatter 4.4~6.4 ms） |
| `trees.json` 冷加载（读 + parse + 展开 `Uint8Array`，不含 fetch） | 1.2~3.5 ms/Worker（v1.0 的 25k 个小数组更慢） |
| GEN 光栅化 | 单 column 均值 ~0.7~0.9 ms（Node，含/不含巨树无显著差） |
| `structure-gen` genP95（门 10ms，交替对照 3 轮×3 次） | HEAD 8.1~9.8；**无预热 11.6~14.0（撞门）**；预热 8.4~10.0 |

**Worker 预热（DR-16）**：`world-worker.js` 已有「撒布 JSON 预热」手法（模块加载期发起、不 await；`layout` 入口 await 同一个 promise；注释里记着冷 fetch 并行 3.1ms 让 genP95 涨 30% 的前车之鉴）。巨树 JSON 同手法：`const giantPreloadPromise = loadGiantTrees();`，`layout` 与 `gen` 入口都 `await giantPreloadPromise.catch(() => {})`。⚠️ **不能**写成 top-level await（早到的 RPC 会被丢弃，首个 `layout` 死锁，见该文件头注释）。`applyStructuresToColumn` 里仍保留 `await loadGiantTrees()`（缓存命中 ≈ 0ms；主线程单测环境也靠它）。

`loadGiantTrees()` 失败不抛、**不缓存失败**（返回空 families，本次 GEN 无巨树；下一次调用重试）：与 `structure-json.js` 的「失败即空」同口径，但不把失败永久缓存，避免某个 Worker 永远无树。

### 3.9 容量与显存

`render-world.js`：`CAPACITY.opaque { active: 1200 → 1800, avgVerts: 1900 }` → `maxVerts = 1800×1900×1.25 = 4,275,000`。三通道静态顶点缓冲 `(4.275M + 2.20M + 0.125M) × 30B = 198,000,000 B`（`memoryStats().gpuVertexBytes` 实测同值）= **188.83 MiB**（原 148.06 MiB）。§4.10 的「150MiB 冻结预算」**由此有意上调**（用户裁决）；对照：HEAD 在密林视域会把 cutout 扩容到 3.3M（≈190MB），该预算在 HEAD 已被动态扩容突破。与 RedCity 的 U1′ 方案 a（opaque 4.275M，GPU 148.06 → 195.55 MiB）同量级、同一个 opaque 值。

**有意变更的既有断言**（不是「放宽冻结断言」，是随容量变更一并更新，且都经用户裁决）：

| 断言 | 位置 | 改前 → 改后 |
|---|---|---|
| `BlockRegistry: 126 方块全部注册且 ID 唯一` | `src/tests/test-block-registry.js:17` | 126 → 134 |
| `registry.all(): 按注册顺序返回 126 条` | `src/tests/test-inventory.js:134` | 126 → 134 |
| `HIDDEN_FROM_INVENTORY = …` + `buildItemNames` 算式 | `src/tests/test-inventory.js:161` / `:176` | 清单 6 → 14 项；算式 `126−4−6` → `134−4−14`（结果仍 116） |
| `orientation: 门控集合` | `src/tests/test-orientation.js:45` | 86 → 94 不参与旋转，`all.length` 126 → 134 |
| `gpuVertexBytes` 上限 | `tests/m3-fullscene.spec.mjs:95` | `< 150 MiB` → `< 200 MiB`（188.83 + ~11 MiB 扩容兜底） |

> `bench --check` 的 `STRUCTURAL` 判定分支恒为 false（`gpuVertexBytes` 等永不报回退，注释写的 2% 不生效，已另立项）——**修它之前 GPU 预算只由 `m3-fullscene` 与本 Epic 的 `giant-tree-budget` 守**。不要重跑不带 `--check` 的 bench（会静默重写冻结基线 `docs/m3-baseline.*`）。

### 3.10 存档兼容（用户裁决：接受）

存档只存玩家修改（edits diff，按索引覆盖在**生成结果**之上）。本 Epic 改变森林/海边/交界的生成结果：**已有存档里这些区域未被玩家改动的格子会长出巨树**；玩家已放置/已挖掉的格子仍按 edits 覆盖（放置的方块仍在、挖掉的仍是空气），所以不会损坏存档。可能的观感影响：玩家在森林里建的房子旁边/中间长出巨树 —— 用户已裁决接受，**不 bump DB 版本、不做迁移、不弃旧档**（对照 RedCity 的 D7「弃旧档」：那次是出生点迁移，语义不同）。

---

## 4. 设计决策（DR）

**DR-1｜候选在 `layout` RPC 的 region 层算，column 层不判定候选。** 跨 column 接缝一致性（红线 2）。v1.1 候选发现 ≈1.1 ms/region，v1.0 担心的「layout 变重 → 出生点等待」不成立。

**DR-2｜候选发现放进既有 `layout` RPC，不新开 RPC。** `LAYOUT_DISPATCH_PER_FRAME = 4` 的标定（region(0,0) 含城市 ~12ms）不受影响（+1.1 ms/region）。

**DR-3｜树叶走 opaque 通道。** 叶-叶共享面互剔。依据已用真实页面重测（§2.5），不是 v1.0 的 Node 估算。

**DR-4｜候选 = 全局对齐网格 + 内缩抖动。**（取代 v1.0 的「region 内贪心」）无状态、跨 region 无缝、间距由构造保证、≈1.1 ms/region（§2.6）。

**DR-5｜旧植被互斥 = 覆盖窗口（AABB ⊕ EXT）抑制阶段 3 的树 + 单格植物「目标格非空则不写」。**（取代 v1.0 的「只标本 column 的 `covered`」）

**DR-6｜不往 `SCATTER_TYPES` 加键。** `SCATTER_TYPES` 的下标是 `Int32Array` 的 stride 值，也是 `check:data` 的 `jsonTypes` 派生基准。

**DR-7｜装饰件（栅栏/台阶/半砖/活板门/楼梯）与地被丢弃。** 实测 3.60%；实现它们需要新几何模板 + 新贴图 + `orientationModes` 处理，远超主体工作量。

**DR-8｜降采样在离线工具里做一次，产物入 JSON；规则写死（§2.4）。** 运行时不做降采样。

**DR-9｜不修改 mesher / materials / scheduler；`render-world.js` 只动 `CAPACITY` 常量。** 巨树只是普通 cube 方块，走既有管线。

**DR-10｜opaque 容量 ×1.5（用户裁决 (a)）。** `CAPACITY.opaque.active` 1200 → 1800；§4.10 的 150MiB 有意上调到 188.83 MiB（§3.9）。

**DR-11｜巨树叶投影（用户裁决）。** 与 `sky_leaves` / `leaves` 同口径；`[阴影投射]` 门禁不动；新 `[巨树]` 门禁反向钉「不得写 `shadowCast:false`」。

**DR-12｜`.schem` 入库（用户裁决）。** `assets/giant-trees/src/`，指纹不依赖仓库外文件。

**DR-13｜已有存档接受（用户裁决）。** 不 bump DB 版本、不迁移。

**DR-14｜让路在 apply 层做（`pointContext` + JSON/撒布外包盒），不在候选层做。** 候选层拿不到邻居 region 的地标；让路不依赖候选的相对关系（网格点互相独立），所以**拒绝一棵树不会连锁改变其它树**（贪心则会）。

**DR-15｜悬空的 `gy=0` 树干格补地基（≤10 格）。** 复用 `GROUND_SUPPORT_TYPES` 的语义，用纯函数 `generateHeight` 而不探测 column。

**DR-16｜Worker 模块加载期预热 `trees.json`。** 否则每个 Worker 首个 GEN 付 fetch + 解析，`structure-gen` genP95 撞破 10ms 门（实测 11.6~14.0）。

**DR-17｜验收口径 = 真实页面 reserved；opaque ≤ 90% 且不扩容，cutout / transparent 相对 HEAD 不恶化。** v1.0 把「已用」当「reserved」少算了 1.25；且「绝对不扩容」对 HEAD 本身不成立。

---

## 5. 测试策略（按 testing-policy 分级）

主体是 **Tier 1**（生成协议 + 数据契约），局部 Tier 2（门禁）与 Tier 4（真实页面）。**写断言前先在真实数据上跑一次、打印实际值**（testing-policy §2.6 ⑤）：下面的下界/区间都取自实测的 ~1/4~1/3。

### 5.1 Tier 1（TDD，必须先 RED）

`src/tests/test-giant-trees.js`（新，注册进 `src/tests/index.html`），**31 条**，按任务分三批（15 + 7 + 9）。每条对应一类**审阅期实测出来的真实缺陷**，注入该缺陷后必须真 FAIL（15 条负向验证已实测）：

| 批 | 用例 | 钉的缺陷 |
|---|---|---|
| Task 4 | 加载（28 变体、族数 = `trees.meta.json`、`palette[0]` 是树干、锚点是 `gy=0` 树干格、无重复坐标）| 烘焙产物契约 |
| | 旋转 ×3（宽深互换 / 转 4 次回原位 / 双射且落在 bbox 内）、`giantTreeRotation` 四向都出现且均匀、`treeBox` 全变体×4 朝向 | `& 3` 恒为 0；非正方形 AABB（Review Focus ②） |
| | 候选：确定性、结构（stride / 族 ⊂ 路径 / hash 范围 / `wy=h+1`）、判据（用导出谓词）、`isNearWater` 单调、**间距含 region 边界**、**region 归属且无重复**、`chance` 线性、密度下界、耗时 < 8ms | 贪心的跨 region 违规；`forestChance` 无效；谓词写崩变恒空 |
| Task 5 | `collectGiantTrees` 拼接 + 规范顺序、`isGiantTreeAllowed`、`collectExclusionBoxes`、**跨 column 光栅化**（4 朝向 × 含非正方形变体 × 2×2 个 column 逐格双向）、地基、覆盖窗口、`applyGiantTrees` 合成场景 | 覆盖赋值；跨 column 接缝（Review Focus ①②）；游离旧树冠 |
| Task 6 | layout 字段；真实 GEN：期望⇔实际逐 column 一致、森林 column 确有巨树、**城市 bounds 内零巨树**、**撒布结构 footprint 内零**、**地标范围内零**（带「不排除时确有树闯入」对照）、**旧树互斥（带基线对照）**、**植物不顶掉树干底格**、确定性 | 16% 进城 / 12.4% 压地标 / 9.4% 压撒布；旧树冠游离；植物顶树干（Review Focus ③⑤） |

### 5.2 Tier 2（门禁）

`tools/check-data.mjs` 新增 `[巨树]` 环节（9 项失效路径，**9 条注入全部实测真红、恢复后全绿**）：产物存在；指纹匹配（入库 `.schem` + 全部参数）；变体数 = `TREE_FAMILIES`；palette ⊂ registry 且 = `FAMILY_PALETTES`；`giant_*` 声明 ↔ palette 使用**双向闭包**（无死方块）；树叶 `opaque` 且**必须投影**（`castsShadow`）且不得 `opaque:false`；8 个方块全在 `HIDDEN_FROM_INVENTORY`；6 张贴图 16×16 且无近黑像素、无孤儿 `giant_*` 贴图。

### 5.3 Tier 3

贴图基色与对比度（观感）：免测试，只需 `lint`。

### 5.4 Tier 4（真实页面）

- `tests/giant-trees.spec.mjs`（2 条）：三条路径的各族方块真的出现（数据级）；城市 bounds 内零巨树（带「城外有」对照）。
- `tests/giant-tree-budget.spec.mjs`（4 条）：5 个固定视域静态 + 3 条冲刺。判据与基线见 §1.2 / §2.5；每个视域带「巨树方块数下界」防恒真。⚠️ 计时型：冲刺峰值依赖加载时序，高负载下贴线 → **先交替对照比分布，不要看单次数值**。

### 5.5 bench

`npm run bench -- --check` 的 `STRUCTURAL` 分支恒为 false（见 §3.9 注），所以 GPU 预算由 `m3-fullscene` 与 `giant-tree-budget` 守；`frameP95` 的 vsync 量子化与 `uploadMsP95/fastRemeshP95` 的 GC 抖动是既有已知噪声，门禁阻断时按 CLAUDE.md 做交替对照。

---

## 6. 落地顺序（供 writing-plans 参考；任务级清单见实施计划）

1. **Task 1** 素材入库 + 烘焙工具 + 指纹（含分类表、族标志校验、规则写死）。
2. **Task 2** 8 个方块 + 6 张贴图 + 既有 4 条单测同步（粉叶预烘焙产物 `cmp` 后并入）。
3. **Task 3** `CAPACITY` 提升 + `m3-fullscene` 断言同步 + 设计文档 §4.10（**先改设计文档再动代码**）。
4. **Task 4** `giant-trees.js` 第一部分：region 层候选 + 几何（TDD）。
5. **Task 5** `giant-trees.js` 第二部分：column 层（TDD）。
6. **Task 6** 接线：`structure-layout.js` / `apply.js`（阶段 2.8 + 阶段 3 两处）/ `world-worker.js` 预热（TDD，含 15 条负向验证）。
7. **Task 7** `check:data` `[巨树]` 门禁 + 9 条注入验证。
8. **Task 8** Tier 4 spec（落地/让路 + 预算门）。
9. **Task 9** 全量回归 + genP95 交替对照 + bench。
10. **Task 10** 文档同步 + 验收报告。

---

## 7. 风险与回退

| 风险 | 概率 | 依据 / 回退 |
|---|---|---|
| opaque 预算在后续 Epic 里被挤占 | 中 | 实测最坏 82.1%（余量 17.9 个百分点）；`giant-tree-budget` 门在 opaque > 90% 时先红。回退旋钮：`chance`（线性）或 `spacing` |
| 实玩觉得树过密/过疏 | 中 | 三个常量：每条路径的 `chance` / `spacing` / `jitter`（`GIANT_TREE_PATHS`）。⚠️ 与 v1.0 不同，`chance` 现在真的线性控制密度 |
| B/C 冠幅重叠成片 → 跨族嵌色（粉冠嵌进绿冠） | 低（设计意图） | spacing 8 对 AABB 17。若观感不可接受：把 B/C 的 spacing 提到 10~12（密度约降 1/3~1/2） |
| 粉叶/榕树叶的重着色观感不对 | 低 | `CONTRAST` 与各 `base` 是 `bake-giant-textures.mjs` 里的常量，改完重烘焙（确定性） |
| 巨树跨 column 接缝断裂 | 低 | Task 5 的跨 column 逐格双向用例是硬门（含非正方形变体 × 4 朝向）；排除判定对覆盖该树的任一 column 一致（§3.5） |
| 新增贴图重排 atlas | 低 | 32 个既有 tile 坐标变化，`check:data` 指纹门禁与 `atlas.spec` 会抓；图标产物逐字节不变 |
| `layout` / GEN 变重 | 低 | 候选 ≈1.1 ms/region；genP95 靠预热守在 10ms 门内（预热前实测 11.6~14.0，注入验证过） |

**整体回退**：删 `giant-trees.js` 与其测试/门禁/两个 spec；去掉 `apply.js` 的阶段 2.8 与阶段 3 的三处（`giant.covers` / 植物规则 / `tree && !inGiant`）及 `giantAllowedAtFor` / `VEGETATION_EXT`；还原 `structure-layout.js` 的一个字段；去掉 `world-worker.js` 的预热两处；删 8 个方块声明 + faces 映射 + HIDDEN 8 项 + 6 张贴图 + `assets/giant-trees/`；**还原 `CAPACITY.opaque` 与 `m3-fullscene` 的 150MiB**，同步还原 4 条单测的计数与清单。

---

## 8. 设计自检

- [x] 无 TBD / TODO / 占位；用户 4 项裁决 + 粉叶预烘焙均已落到具体章节（§0.2）。
- [x] 三条路径的落位规则互不冲突；让路规则对三条路径一致；B 与 C 都可能落在 PLAINS，但 B 要近水、C 要交界，各自网格独立，AABB 互穿是设计意图（§2.2）。
- [x] 所有数字都有实测出处（§2、§3.8、§3.9），且**口径一致**（真实页面 reserved；Node 侧数字只在 §2.5 作为「v1.0 错在哪」的对照出现）。
- [x] 与红线无冲突：无第二份权威（候选派生自 seed，产物派生自入库 `.schem` + 参数）、无预生成、重计算在 Worker、单一 meshing 管线、版本协议未动、WebGPU 不变；唯一对 `render-world.js` 的改动是一个容量常量（用户裁决）。
- [x] 明确列出不做的项（§1.3）与有意变更的既有断言（§3.9 末表）。
- [x] 与既有活跃约束的关系已核对：`seededRandom` salt 取空闲带；`opaqueTable=1` 四项后果（§3.6.1）；`SAME_TYPE_CULL` / `cloud` 手法**不适用**（巨树要 AO/blocklight 遮挡与互剔，走纯 opaque）；cutout 容量不受影响（巨树不进 cutout）；`makeColumnSetter` 无占用格守卫（后写胜，规范排序保证确定性）；`WorkerPool.call()` 返回 `{id,promise}` 的坑与本 Epic 无关（不新增 RPC）。
