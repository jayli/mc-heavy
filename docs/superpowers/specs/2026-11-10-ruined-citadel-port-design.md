# 废弃堡垒移植设计（Cataclysm ruined_citadel → 城西最近沙漠）

日期：2026-11-10（探索与实测数据采于 2026-11-09 ~ 11-10）
状态：已批准，待实施
参照：大竞技场移植（v2.85~v2.88，`docs/superpowers/specs/2026-11-09-burning-arena-port-design.md`）
计划文档：`docs/superpowers/plans/2026-11-10-ruined-citadel-port.md`

> ## ⚠️ v2 修订（2026-11-10，用户新增两项需求）
>
> 初版是**纯重映射**（方案 A，零新增方块）。用户 2026-11-10 追加两点，升级为**方案 B**：
> 1. **地下部分不与水方块（含水面）相交** —— 落点判据强化为「占地 + 外扩 4 格全干燥」；
> 2. **允许为高频缺失方块新烘焙方块**（正六面体/柱/台阶/半砖，复制 mod 自带贴图，进背包）。
>
> 下文 §1 的「方案 A 纯重映射」描述已被本节与 §2.9（新烘焙方块清单）取代。

---

## 0. 一句话

把 Cataclysm 模组的 `ruined_citadel`（废弃堡垒，18 片 nbt，106×63×108，26 万格）移植进 mc-heavy：
烘焙成 palette 产物 + **重映射为主、辅以 15 个新烘焙方块** + 落在 **City 西方最近的干燥沙漠**，
甲板与地表齐平、**44 层地下地牢完整保留**（空气格写进产物清出房间、**不与任何水相交**），
并加一个「堡垒」瞬移按钮。

---

## 1. 目标与范围

把 Cataclysm 模组（`~/jaylli/cataclysm1.19.2modding`，L_Ender，MC 1.19.2 Forge）的
`ruined_citadel`（废弃堡垒）移植进 mc-heavy，生成在 **City 西方最近的沙漠地带的相对平坦区域**。

用户裁定（2026-11-09 ~ 11-10，`ask_user_question`）：

| # | 裁定 | 内容 |
|---|---|---|
| ① | 移植方式 | 参照大竞技场的移植方式（烘焙 + 重映射），**并允许新烘焙缺失方块**（v2 升级） |
| ② | 落点 | City **西方**最近的一块沙漠地带 |
| ③ | 不重叠 | 表面不要跟沙漠其他建筑重叠 |
| ④ | 方块 | 利用现有的方块做映射，**高频缺失的照 mod 贴图新烘焙**（v2 升级） |
| ⑤ | 锥体处理 | **完整保留·埋入地下**（见 §2.6 的更正说明） |
| ⑥ | 瞬移按钮 | **加「堡垒」按钮** |
| ⑦ | **水约束** | **地下部分不与水方块（含水面）相交**（v2 新增） |
| ⑧ | **新烘焙范围** | 有贴图的整块/柱全烘（9 个）+ 有贴图族的台阶/半砖（6 个）；**虚空灯不新烘、映到 ochre_froglight**（v2 新增） |

### ⚠️ 裁定 ⑤ 的来龙去脉（重要，别按初版理解实施）

我最初把堡垒下半部描述成「纯末地石倒锥体（浮岛底座）」，用户据此选了「裁掉锥体」。
**这个描述是错的**，实测更正后重新问过，用户改选「完整保留·埋入地下」：

- 下半部其实是一座 **44 层、22.6 万格的地下地牢**：内部约 36% 是可走空气空间，
  含 **17,944 格真实建筑**（黑曜石砖、楼梯、墙、虚空灯）；
- 贵重内容全在地下：**虚空祭坛 `altar_of_void`（y=-15）、134 盏虚空灯（129 盏集中在 y=-24）、
  3 个末影箱、3 个箱子、1 个潜影盒**；
- 裁掉锥体会丢失原版 **89%** 的内容；
- 而本仓世界高度 y∈[-32,96]（128 层），堡垒高 63 层 ⇒ 甲板放在沙漠地表后
  **整座恰好完整落在世界范围内**，底部只被世界底界自然裁掉纯末地石层，零内容损失。

⇒ **实施口径：不裁切。** 产物保留全部 63 层，落位后底部超出 `WORLD_MIN_Y` 的格由
`makeColumnSetter` 的既有越界守卫（`y < WORLD_MIN_Y → return`）自然丢弃。

明确**不做**：
- 不移植 Boss 生成逻辑（原模组靠 `structure_block` 数据标记刷 Ender Golem / Shulker；
  本仓的 Boss 体系不受影响）。
- 不移植原版 MC 方块的贴图（不在源仓库里，vanilla 资源不可再分发）。
- **不新烘发光方块**（用户：「我不需要发光」）—— 虚空灯映到现有 `ochre_froglight`。

---

## 2. 实测事实（冻结数字，探针 2026-11-09 ~ 11-10）

### 2.1 18 片的拼合偏移

逐字抄自 `RuinedCitadelStructure.java` 的 `OFFSET` 表（全部 `(0,1,0)`）+ `start()` 里的
`rotationOffSet`，rotation = NONE。**两层结构**：下层 9 片（y 偏移 -45，是 45 格高的地牢主体），
上层 9 片（y 偏移 0，是 21 格高的甲板+塔楼）。

| 片 | 偏移 (x,y,z) | 片 | 偏移 (x,y,z) |
|---|---|---|---|
| citadel5  | (0,-45,0)     | citadel14 | (0,0,0)     |
| citadel6  | (0,-45,37)    | citadel15 | (0,0,37)    |
| citadel4  | (0,-45,-37)   | citadel13 | (0,0,-37)   |
| citadel2  | (-36,-45,0)   | citadel11 | (-36,0,0)   |
| citadel8  | (36,-45,0)    | citadel17 | (36,0,0)    |
| citadel1  | (-36,-45,-37) | citadel10 | (-36,0,-37) |
| citadel3  | (-36,-45,37)  | citadel12 | (-36,0,37)  |
| citadel9  | (36,-45,37)   | citadel18 | (36,0,37)   |
| citadel7  | (36,-45,-37)  | citadel16 | (36,0,-37)  |

⚠️ **片尺寸实测**：下层 9 片各 `36×45×37`，上层 9 片各 `36×21×37`。
⚠️ **x/z 偏移是 36/37 而不是 37/38**（与大竞技场的 47/38 不同）：片宽 36、偏移 36 ⇒ 相邻片
**首尾相接不重叠**；z 方向片深 37、偏移 37 同理。实测组装后包围盒连续无断层，佐证偏移抄对了。

### 2.2 组装结果

| 项 | 实测值 |
|---|---|
| 非空气包围盒 | **106 × 63 × 108**（x∈[-35,70]，y∈[-45,17]，z∈[-35,72]） |
| 非空气格 | **261,775** |
| 显式空气格（nbt 逐格存 air） | 257,265（占包围盒 35.7%） |
| 其中**甲板以下**（y<0）空气 | **27,060** 格 ⇒ 地牢房间/走廊的内部空间（判据是 y<0，见 DR-2 修订） |
| 其中甲板以上（y≥0）空气 | 230,205 格 ⇒ 是天空，**刻意不写进产物** |
| **产物总格数** | **288,744** = 261,775 非空气 − **91 丢弃**（功能标记 11 + 无几何薄件 80）+ 27,060 甲板下空气 |
| **产物包围盒** | **107 × 63 × 110**（x∈[-36,70]，z∈[-37,72]；甲板下空气把边界比非空气 bbox 各撑出 1 格） |
| 源 palette 并集 | **53** 种方块名（含 air；不含 air 52 种） |
| 产物 JSON 体积 | **3.70MB**（stride 5，实测；参照 burning_arena 115,381 格 → 1.50MB） |
| 暴露面（6 邻域空气） | **74,518**（≈ 298K 顶点下界；大竞技场是 92,802） |
| `structure_block` 数据标记 | **10** 个（3 `golem` + 4 `mimic` + 3 `sentry`）→ 丢弃 |
| `cataclysm:altar_of_void` | 1 个（y=-15，末影守卫召唤祭坛）→ 丢弃 |
| 甲板层（y=-1） | 8,197 格（产物口径，含 1 格空气竖井；非空气 8,196），覆盖率 **71.6%**（非满铺，有缺口） |
| `floorRow`（归一化后甲板层 ny） | **45**（= -1 − (-45) + 1） |
| 归一化总高 | 63（ny ∈ [1,63]） |

⚠️ **甲板覆盖率 71.6% 不是满铺** —— 与大竞技场的 `floorCells` 4,825/7,225 同一情形，
别照抄「满铺」断言（AGENTS.md 已记这条）。

### 2.3 竖直结构分区

| 区域 | structure y | 内容 |
|---|---|---|
| 塔楼 | 0..17 | 紫珀块/末地石砖塔、楼梯、柱子、箱子 9 + 木桶 9 + 潜影盒 1 |
| **甲板** | **-1..-2** | 末地石/末地石砖实心层（覆盖率 72%），**落位基准面** |
| 地牢上层 | -3..-16 | 黑曜石砖墙/楼梯/走廊/房间；**虚空祭坛在 y=-15**（上下各一层实心夹着它） |
| 地牢下层 | -17..-25 | 更多走廊；**129 盏虚空灯集中在 y=-24**（该层建筑块占 27%） |
| 锥体底部 | -26..-45 | **纯 end_stone**（实测 y=-45..-37 每层非 end_stone 格数 = **0**），倒锥形收分 |

### 2.4 落位后的世界底界裁切（零内容损失）

世界高度 y∈[-32,96]。甲板落在沙漠地表 `floorY` 后：

| floorY | 世界 y 范围 | 被裁层（structure y） | 被裁格数 | 被裁层组成 |
|---|---|---|---|---|
| -1 | [-45,17] | -45..-33（13 层） | 40,652 | **全部 end_stone** |
| 4 | [-40,22] | -45..-38（8 层） | 17,564 | **全部 end_stone** |

⇒ 裁掉的只是锥体最底部的纯末地石，**零建筑内容损失**。裁切由 `makeColumnSetter` 的
既有越界守卫自动完成，**不需要在烘焙期裁**（产物保持完整，落位随 floorY 自适应）。

### 2.5 落点环境（8 seed 实测，含全部避让项 + 水约束）

搜索算法与大竞技场同构（两级筛选：粗筛网格 + 逐格精检），方向改为**城西**。
判据 = ① 占地全 DESERT ② **占地 + 外扩 4 格每格 `generateHeight > SEA_Y`（干燥，见 §2.10）**
③ 占地内高差 ≤ span ④ 城西且与城市 bounds 净距 ≥ `CITY_TRANSITION_SIZE`
⑤ 不与高台地带/浅水高台/围场/大竞技场重叠。

| seed | 锚点 (wx,wz) | span | 距城市中心 | floorY |
|---|---|---|---|---|
| 12345 | (-469,-71) | 5 | 775 | -1 |
| 99999 | (-338,197) | 5 | 455 | 4 |
| 1249026 | (-619,365) | 5 | 760 | -1 |
| 20260101 | (-218,313) | 5 | 538 | 4 |
| 777 | (-397,177) | 5 | 514 | 4 |
| 4242 | (-85,445) | 5 | 451 | 4 |
| 31337 | (-167,361) | 5 | 512 | 4 |
| 8888 | (-154,201) | 5 | 445 | -1 |

**8/8 seed 全部命中 span=5**，加上水约束后锚点坐标与无水约束时**逐位相同**
（沙漠腹地干燥区远大于外扩 4 格的余量）。

⚠️ **实测踩到的坑（必须写进代码注释）**：城市净距判据的方向。大竞技场在城东，写的是
`wx - HALF <= city.maxX + CLEARANCE → 拒绝`；本结构在城西，必须是
`wx + HALF >= city.minX - CLEARANCE → 拒绝`。我第一版照抄了城东那行，
**8/8 seed 全部返回「未找到」**（9ms 就退出，因为每个候选都被 city 判据拒掉）。

⚠️ **span≤4 无解**：占地 106×108 比大竞技场（85×85）更大，沙漠地形容不下那么平的一块。
故 `SPANS = [4,5,6,8]` 先严后松，5 是实际命中档。

⚠️ **必须预热**：搜索首次 ~1000ms（外扩 4 格使精检占地从 106×108 增到 114×116），
要像 `computeBurningArenaAnchor` 一样预热在 `world-worker.js` 的 `layout` 入口
（不落进 GEN 计时路径，`structure-gen` 的 genP95 门是 10ms）。

### 2.6 方块映射盘点（52 种源名，另有 air 由 DR-2 分层处理）

**直接命中本仓（5 种）**：`end_stone`、`end_stone_bricks`、`obsidian`、`chest`、`stone`

**v2 新烘焙（15 种，见 §2.9）**：9 个整块/柱 + 6 个台阶/半砖。

**其余重映射**（完整表见 §2.9 映射总表）：紫珀族 → `amethyst`、虚空灯 → `ochre_froglight`、
哭泣黑曜石 → `obsidian`、墙/栅栏 → `handrail`、紫颂植物 → `vine`、紫颂花 → `allium`、
地毯/活板门/花盆/拉杆/绊线钩/木桶 → 丢弃、`structure_block`/`altar_of_void` → 丢弃。

### 2.7 台阶 / 半砖 / 墙栏（全量精确统计）

**台阶 3,916 格**（5 种源名 × half 两态）：

| 源 | bottom | top | 合计 | 处理 |
|---|---|---|---|---|
| `end_stone_brick_stairs` | 585 | 1,258 | **1,843** | **新烘焙**（有 end_stone_bricks 贴图） |
| `cataclysm:obsidian_brick_stairs` | 1,096 | 55 | **1,151** | **新烘焙**（有 obsidian_bricks.png） |
| `purpur_stairs` | 624 | 126 | 750 | 映 `stone_diorite_step`（无贴图） |
| `cataclysm:polished_end_stone_stairs` | 74 | 54 | 128 | 映 `stone_diorite_step`（低频） |
| `cataclysm:chorus_stairs` | 0 | 44 | 44 | 映 `stone_diorite_step`（低频） |

⚠️ **倒置台阶是多数派之一，不是边缘情况**（top 合计 1,537 格，占 39%）⇒
`*_step_updown` 分支是主路径，其朝向映射必须 `--census-orient` 实测冻结
（AGENTS.md：朝向映射只能用真实 mesher 实测定，不能从 `orientation.js` 或 MC 定义推）。
⚠️ **台阶 `shape` 实测**：straight 3,598 / inner_left 89 / inner_right 91 / outer_left 69 /
outer_right 69 ⇒ 转角件仅 318 格（8%），统一按直台阶处理（pyramid/arena 同款裁定）。

**半砖 3,277 格**（4 种源名 × type 三态）：

| 源 | bottom | top | double | 合计 | 处理 |
|---|---|---|---|---|---|
| `cataclysm:obsidian_brick_slab` | 2 | 48 | 1,801 | **1,851** | **新烘焙**（bottom→新半砖，top/double→obsidian_bricks 整块） |
| `purpur_slab` | 20 | 1,076 | 2 | 1,098 | 映 `sand_slab`/`amethyst`（无贴图） |
| `end_stone_brick_slab` | 16 | 224 | 72 | **312** | **新烘焙**（bottom→新半砖，top/double→end_stone_bricks 整块） |
| `cataclysm:polished_end_stone_slab` | 8 | 8 | 0 | 16 | 映 `sand_slab`/`polished_end_stone`（低频；top 用 Task 1 新烘的同材质整块，比 `end_stone` 忠实） |

⚠️ **`double` 是多数**（1,875 格）⇒ 不得假设「top/double 罕见」。
⚠️ **不得用「剥 `_slab` 后缀查 BLOCK_MAP」的写法**：`end_stone_brick_slab` 剥出
`end_stone_brick`（单数）而表里是 `end_stone_bricks`（复数）→ 静默落到兜底值。
必须用**显式 `SLAB_BASE` 表**。

**墙/栅栏 708 格**（`cataclysm:obsidian_brick_wall` 350 + `end_stone_brick_wall` 215 +
`cataclysm:chorus_fence` 123 + `cataclysm:purpur_wall` 20），其中 533 格带连接 props
⇒ 复用大竞技场的 `computeRailOrientations` 朝向 pass（`handrail` 转角件 / `handrailA` 直段件）。

### 2.8 通道分布预估（预算关注点）

| 通道 | 估算格数 | 说明 |
|---|---|---|
| opaque | 256,866 | end_stone 系 + obsidian 系 + amethyst 系 + 新烘焙整块（实测） |
| cutout | 4,810 | 台阶 3,916 + 半砖(bottom) 26 + 墙栏 708 + vine 85 + allium 9 + chest 12 + hanging_lamp 1 + 新半砖（实测） |
| transparent | 8 | `glass_block`（紫色玻璃板） |

⚠️ 精确值必须用 `REGISTRY.cullTable` 算（**不要正则扫 blocks-data 源码** —— 大竞技场 v2.86
踩过：名字正则 `[a-z_0-9]+` 匹配不到带大写的 `handrailA`，cutout 少算 1,550 格）。

### 2.9 v2 新烘焙方块清单（15 个，用户裁定 ⑧）

**前提**：mod 在 `textures/blocks/` 里自带全部 `cataclysm:*` 方块的 16×16 贴图
（实测均为不透明 PNG），直接复制进 `assets/textures/` 即可，无需程序化生成。

**A. 整块/柱（9 个，全部复制 mod 贴图）**：

| 新方块名 | 源 | 格数 | 几何 | 贴图 |
|---|---|---|---|---|
| `obsidian_bricks` | `cataclysm:obsidian_bricks` | 9,134 | box | obsidian_bricks.png（rgb 22,16,37 深紫黑） |
| `end_stone_pillar` | `cataclysm:end_stone_pillar` | 1,029 | box（cube_column，顶/侧异图） | end_stone_pillar.png + _top.png |
| `chiseled_end_stone_bricks` | `cataclysm:chiseled_end_stone_bricks` | 451 | box | chiseled_end_stone_bricks.png |
| `polished_end_stone` | `cataclysm:polished_end_stone` | 200 | box | polished_end_stone.png |
| `chiseled_purpur_block` | `cataclysm:chiseled_purpur_block` | 156 | box | chiseled_purpur_block.png |
| `chorus_planks` | `cataclysm:chorus_planks` | 126 | box | chorus_planks.png（rgb 169,141,168 粉紫木） |
| `chiseled_obsidian_bricks` | `cataclysm:chiseled_obsidian_bricks` | 122 | box | chiseled_obsidian_bricks.png |
| `void_stone` | `cataclysm:void_stone` | 122 | box | void_stone.png（rgb 120,31,225 紫） |
| `void_infused_end_stone_bricks` | `cataclysm:void_infused_end_stone_bricks` | 81 | box | void_infused_end_stone_bricks.png |

⚠️ **`end_stone_pillar` 是完整正六面体，不是半粗柱**：mod 的模型是 `cube_column`
（`parent: block/cube_column`，顶面 `end_stone_pillar_top` + 侧面 `end_stone_pillar`），
与原木同语义 —— 一个 1×1×1 实心立方体，只是顶/底与四侧贴图不同。用户「似乎是半粗的」
是观感误解（堡垒里它竖直堆叠成柱，看起来像柱子）。**按整块烘焙**（`geometry:'box'` +
六面贴图数组，顶/底用 _top、四侧用 side），比细柱更简单也更忠实。
⚠️ **axis 实测**：end_stone_pillar 1,024 格 axis=y / 2 格 x / 3 格 z ⇒ 几乎全竖直，
**不需要 horizontal 变体**（与 purpur_pillar 的 24/215/24 不同，但 purpur 不新烘）。

**B. 台阶/半砖（6 个，只烘有贴图的 obsidian_brick + end_stone_brick 两族）**：

| 新方块名 | 源 | 格数 | 几何模板 | 贴图 |
|---|---|---|---|---|
| `obsidian_brick_step` | obsidian_brick_stairs[bottom] | 1,096 | `cobblestone_step` | obsidian_bricks.png |
| `obsidian_brick_step_updown` | obsidian_brick_stairs[top] | 55 | `cobblestone_step_updown` | obsidian_bricks.png |
| `obsidian_brick_slab` | obsidian_brick_slab[bottom] | 2 | `half_block` | obsidian_bricks.png |
| `end_stone_brick_step` | end_stone_brick_stairs[bottom] | 585 | `cobblestone_step` | end_stone_bricks（本仓已有 tile） |
| `end_stone_brick_step_updown` | end_stone_brick_stairs[top] | 1,258 | `cobblestone_step_updown` | end_stone_bricks（本仓已有 tile） |
| `end_stone_brick_slab` | end_stone_brick_slab[bottom] | 16 | `half_block` | end_stone_bricks（本仓已有 tile） |

⚠️ **几何模板全部复用现有**（`cobblestone_step`/`cobblestone_step_updown`/`half_block`），
只新增贴图映射 + blocks-data 条目，**不新增几何**（红线：不开新 mesh 分支）。
⚠️ **半砖只烘 `type=bottom`**：top/double 映到对应整块（obsidian_bricks / end_stone_bricks），
与大竞技场「top 不用 half_block_updown（木色贴图）」同一裁定。

**C. 虚空灯（不新烘，用户裁定「不需要发光」）**：
`cataclysm:void_lantern_block`（134 格）→ **`ochre_froglight`**（本仓已有，`emissive:15`，
rgb 244,230,178 亮奶白，lum 217）。地牢在地下 skylight=0，靠这 134 盏提供 blocklight 照明；
选 `ochre_froglight` 而非 `glowstone`（rgb 134,104,59 暗棕，lum 99）是因为它更亮、更接近
原版虚空灯的「亮」感。**零新增发光方块类型**。

### 2.10 水约束（v2 新增，用户裁定 ⑦）

**本引擎的水只有两处来源**（实测 `terrain.js`/`ocean.js`/`ocean-mask.js`）：
1. **体素水**：`fillColumn` 仅在 `generateHeight < SEA_Y`（即 h ≤ -3）的列填水，从 h+1 到 SEA_Y=-2；
2. **海面平面**：`ocean.js` 在 y = SEA_Y+0.5 = **-1.5** 渲染一张 800×800 平面，
   遮罩判据 = 五点取样（中心 + 四方向各 **±3.5** 格）任一点 `generateHeight < SEA_Y`。

**堡垒与水的关系**：
- 堡垒**覆盖**天然地形（`rasterizeStructure` 在 `fillColumn`+`carveCaves` 之后写，后写胜）
  ⇒ 堡垒格本身不可能是水；
- 真正的风险是**海面平面**：若占地边缘 3.5 格内有湿列（h < SEA_Y），遮罩五点取样会把
  海面平面渲进占地，在甲板（floorY=-1 时顶面 y=0）下方 0.5 格处（y=-1.5）切出一片假水面，
  从地牢往上看会看到「水天花板」。

**⇒ 约束落为锚点判据**：占地 **外扩 4 格**（ceil(3.5)）内每格 `generateHeight > SEA_Y`。
这同时保证 ① 占地内无体素水（h > SEA_Y ⟺ fillColumn 不填水）② 海面平面遮罩在占地上恒假。
实测加此判据后 8/8 seed 锚点不变（§2.5）。
⚠️ **判据用 `generateHeight`（自然地形的唯一权威）**，与 `fillColumn`/`ocean-mask` 同源
（红线 1，AGENTS.md「两个消费方」条）——不得另写一份高度公式。

---

## 3. 设计决策

### DR-1 烘焙管线（复用 burning-arena 模式 + 新方块注册）

- 输入**入库**：`assets/ruined-citadel/src/ruined_citadel{1..18}.nbt`（共 1.4MB）。
  ⚠️ **不得放进 `assets/textures/`**（`build-atlas` 递归扫描该目录）。
- 新文件：
  - `tools/ruined-citadel-fingerprint.mjs` — 映射表 + 产物指标 + 输入指纹（node 侧模块）
    ⚠️ **`src/**` 与浏览器单测绝不能 import 它**（依赖 `node:fs`，B1 白屏教训）。
  - `tools/bake-ruined-citadel.mjs` — 读 18 片 → 拼合 → 重映射 → 栏杆朝向 pass → 输出。
    支持 `--census` / `--census-orient`。⚠️ **必须判 main module**。
- 输出：`assets/structures/ruined_citadel.json`（palette + stride=5）+ `.meta.json`。
- `package.json` 加 `"ruinedcitadel"` 脚本。
- **`FACING_TO_ORIENT` 从 `giant-pyramid-fingerprint.mjs` re-export**（红线 1）。

### DR-2 空气格必须写进产物（本结构特有的关键决策）

**这是与大竞技场最大的不同**，也是「完整保留地牢」能成立的前提。

- **问题**：`rasterizeStructure` 只写产物里的格，而地牢房间在 nbt 里是**显式空气**。
  若不写空气，`fillColumn` + `carveCaves` 生成的天然岩层会**填满整个地牢**。
- **实测依据**：甲板以下 27,060 格空气全在结构体内（判据是 **y<0 = 地牢内部空间**，
  不是封闭性 —— 实测仅 19 格六邻全封闭，4,915 格有门窗/走廊侧向开口，22,125 格上方
  通向甲板层；这些开口正是地牢房间/走廊的连通方式，写空气清出它们正是目的）。
- **做法**：产物 palette 里加 `"air"` 条目，甲板以下（structure y<0）的空气格写进
  `blocks` 数组。光栅化时 `setBlock(…,'air')` → `makeColumnSetter` 查
  `registry.idOf('air') === 0` → `blocks[idx] = 0`（**实测确认 air 已注册且 id=0**）⇒ 清空格。
- **甲板以上（y≥0）的 230,205 格空气刻意不写**（天空，写了 JSON 从 3.7MB 涨到 17MB+）。
- ⚠️ **`rasterizeStructure` 不需要改**：`air` 只是一个恰好 id=0 的普通 palette 条目。
- ⚠️ **`check:data` 要钉住**：产物 palette 含 `air`，且 air 格数 = 27,060。

### DR-3 v2 新烘焙方块的注册（15 个）

新方块是**数据条目 + 贴图**，不开新几何分支（红线）。每个新方块改 4 处：
1. `src/voxel/blocks-data.js`：加 `{name, solid:true, cullMode, orientationModes, geometry}` 条目；
2. `src/voxel/faces-data.js`：加贴图映射（整块单 tile 字符串；柱用六面数组；台阶/半砖复用族 tile）；
3. `assets/textures/`：复制 mod 的 PNG（9 个整块 + 柱顶/侧 2 张 = 10 张新贴图；
   end_stone_brick 族复用本仓已有 `End_Stone_Bricks` tile，零新增）；
4. 跑 `npm run atlas`（重打图集）+ `npm run icons`（重烘背包图标）。

**背包自动进入**：本仓物品集合是**派生**的（`buildItemNames = registry.all() − 排除集合`，
`inventory.js:181`），新方块只要不在 `NON_PLACEABLE_ITEMS`/`HIDDEN_FROM_INVENTORY` 就自动进背包
（用户 2026-10-25 已反转口径：「不在背包才是缺陷」，AGENTS.md 巨树段）。**无需手改背包清单**。

⚠️ **方块 ID 空间**：`MAX_BLOCKS = 512`（`block-registry.js:5`），现 139 个，加 15 个 = 154，
余量充足。
⚠️ **存档兼容**：edits 按**名字**存（`progress-codec.js:59 nameOf` / `:133 idOf`），
新增方块不改既有名字 ⇒ 旧存档不破坏。
⚠️ **atlas 重打会移动所有 tile 的 UV**（shelf 装箱），但 mesher 运行期从 `atlas.json` 读 UV，
单测用派生假 atlas（`test-mesher`/`test-giant-trees` 实测）⇒ 安全。

**冻结计数需同步更新**（加 15 个方块必然改变，属预期，非「放宽阈值」）：
- `test-block-registry.js`：`reg.count === 139` → 154；
- `test-inventory.js`：`registry.all() 139 条` → 154；
- `test-orientation.js`：`disabled.length === 98` → 109（新增 11 个 orientationModes=0：9 整块 + 2 半砖；
  4 个台阶是 orientationModes=4 不计入 disabled）。
⚠️ 实施时以实测为准回填，若与上述推算不符**停下报告**。

### DR-4 重映射总表（v2 定稿）

| 源方块 | 格数 | 目标 | 说明 |
|---|---|---|---|
| `end_stone` / `end_stone_bricks` / `obsidian` / `chest` / `stone` | — | 同名直通 | 本仓已有 |
| `cataclysm:obsidian_bricks` | 9,134 | **新 `obsidian_bricks`** | DR-3 |
| `cataclysm:end_stone_pillar` | 1,029 | **新 `end_stone_pillar`** | DR-3，整块 |
| `cataclysm:chiseled_end_stone_bricks` | 451 | **新 `chiseled_end_stone_bricks`** | DR-3 |
| `cataclysm:polished_end_stone` | 200 | **新 `polished_end_stone`** | DR-3 |
| `cataclysm:chiseled_purpur_block` | 156 | **新 `chiseled_purpur_block`** | DR-3 |
| `cataclysm:chorus_planks` | 126 | **新 `chorus_planks`** | DR-3 |
| `cataclysm:chiseled_obsidian_bricks` | 122 | **新 `chiseled_obsidian_bricks`** | DR-3 |
| `cataclysm:void_stone` | 122 | **新 `void_stone`** | DR-3 |
| `cataclysm:void_infused_end_stone_bricks` | 81 | **新 `void_infused_end_stone_bricks`** | DR-3 |
| `cataclysm:obsidian_brick_stairs` | 1,151 | **新 `obsidian_brick_step(_updown)`** | DR-3，按 half 分流 |
| `end_stone_brick_stairs` | 1,843 | **新 `end_stone_brick_step(_updown)`** | DR-3，按 half 分流 |
| `cataclysm:obsidian_brick_slab` | 1,851 | bottom→**新 `obsidian_brick_slab`**，top/double→`obsidian_bricks` | DR-3 |
| `end_stone_brick_slab` | 312 | bottom→**新 `end_stone_brick_slab`**，top/double→`end_stone_bricks` | DR-3 |
| `cataclysm:void_lantern_block` | 134 | `ochre_froglight` | 照明，不新烘（裁定 ⑧） |
| `purpur_block` | 2,799 | `amethyst` | 紫珀族，无贴图（裁定：继续映射） |
| `purpur_pillar` | 263 | `amethyst` | 整块紫，比细柱忠实 |
| `purpur_stairs` | 750 | `stone_diorite_step(_updown)` | 无贴图 |
| `purpur_slab` | 1,098 | bottom→`sand_slab`，top/double→`amethyst` | 无贴图 |
| `crying_obsidian` | 234 | `obsidian` | 本仓无哭泣黑曜石 |
| `end_stone_brick_wall` / `cataclysm:obsidian_brick_wall` / `cataclysm:chorus_fence` / `cataclysm:purpur_wall` | 708 | `handrail`（朝向 pass） | 细件 |
| `cataclysm:polished_end_stone_stairs` | 128 | `stone_diorite_step(_updown)` | 低频 |
| `cataclysm:chorus_stairs` | 44 | `stone_diorite_step_updown` | 低频（全 top） |
| `cataclysm:polished_end_stone_slab` | 16 | bottom→`sand_slab`，top→`polished_end_stone` | 低频（top 用新烘同材质整块） |
| `chorus_plant` | 85 | `vine` | 紫颂植物 |
| `chorus_flower` | 9 | `allium` | 紫颂花 |
| `end_rod` | 30 | `vertical_pillar` | 末地烛细竖件 |
| `cataclysm:purpur_void_rune_trap_block` | 70 | `amethyst` | 符文陷阱→基础块 |
| `cataclysm:obsidian_explosion_trap_bricks` | 53 | `obsidian` | 陷阱砖→基础砖 |
| `cataclysm:end_stone_teleport_trap_bricks` | 51 | `end_stone_bricks` | 传送陷阱→基础砖 |
| `purple_stained_glass_pane` | 8 | `glass_block` | transparent 通道 |
| `ender_chest` | 3 | `chest` | 末影箱 |
| `shulker_box` | 2 | `orange_shulker_box` | 本仓已有 |
| `lantern` | 1 | `hanging_lamp` | 吊灯 |
| `purple_carpet`/`white_carpet`/`magenta_carpet`/`iron_trapdoor`/`spruce_trapdoor`/`flower_pot`/`lever`/`tripwire_hook`/`barrel` | 80 | 丢弃 | 无对应几何（实测丢弃不造洞；41+9+7+5+3+4+1+1+9） |
| `structure_block` / `cataclysm:altar_of_void` | 11 | 丢弃 | 功能标记 |

### DR-5 落位：城西最近的干燥沙漠

- 锚点 = **城西距离最近的、相对平坦且干燥的沙漠点**（`computeRuinedCitadelAnchor`），
  全世界每 seed 恰好一个。
- 搜索窗：城西（起点 = `city.minX - 半宽 - 城市净空`），向西最多 **2400** 格，纬度 ±900。
  候选按「距城市中心 → x → z」排序（确定性）。
- 判据（全部满足才算合法）：
  ① 占地 **106×108** 全是 DESERT biome；
  ② **占地 + 外扩 4 格每格 `generateHeight > SEA_Y`（水约束，§2.10）**；
  ③ 占地内地表高差 ≤ span（`RUINED_CITADEL_SPANS = [4,5,6,8]`）；
  ④ 在城西且与城市 bounds 净距 ≥ `CITY_TRANSITION_SIZE`（⚠️ 方向见 §2.5 的坑）；
  ⑤ 不与高台地带 / 浅水高台 / 围场 / **大竞技场** / 巨型金字塔重叠。
- **两级筛选是性能关键**：粗筛 8 格网格先淘汰 99.99%。
  ⚠️ **粗筛步长换算用 `floor` 不用 `ceil`**；**网格外扩 `gi` 格**；
  ⚠️ **x/z 半宽不同（53/54）⇒ `giX`/`giZ` 分开算**；
  ⚠️ **水约束的精检也要外扩 4 格**（干燥判据的范围 = 占地 + 4）。
- 落位 y：`rasterizeStructure(type, wx, floorY - (floorRow-1), wz, ...)`，
  使**甲板层（归一化 ny=45）正好落在 floorY**。
- **不补 groundSupport**（甲板以下全是实心结构体）。
- **底部越界格由既有守卫自然丢弃**（§2.4）。

### DR-6 压制 vs 避让（与大竞技场/浅水高台同一裁定）

- **避让**只留「地基级大结构」：城市 / 高台地带 / 浅水高台 / 围场 / **大竞技场**。
- **压制**其余内容（`ruinedCitadelSuppressedLandmarks`，逐地标粒度）：
  地标（金字塔/冰封山/岛/平地/雪原）、巨型金字塔、空岛、撒布、植被。
- ⚠️ **压制判据用「圆↔矩形相交」不是「中心在占地内」**；**扫占地触及的全部 region**；
  **廉价距离门**（性能关键，大竞技场 v2.85 实测 +9.7% 的教训）。
- **空岛压制**：本结构塔顶 = floorY+18（y=17..22），空岛底 y≥40 ⇒ 当前不相撞，
  但保留压制项（判据 `bottomY <= topY` 恒假，零成本；将来加高塔楼不会静默失效）。
- ⚠️ **雪原压制不在 layout 层做**（走 apply 阶段 1 跳过门，同 `snowLandSuppressedByTarn`）。

### DR-7 apply.js 接线：新阶段 2.94

- **位置**：阶段 2.93（大竞技场）**之后**、阶段 2.5（空中结构）**之前**。
  ⚠️ **阶段层序是载荷性的**（AGENTS.md 已记）。
- **早退**：`placementIntersects({x,z}, 53, 54, column.cx, column.cz)`（x/z 半宽不同）。
- **预载**：`if (layouts.some((l) => l.ruinedCitadel)) needTypes.add('ruinedCitadel');`
  （惰性预载：产物 ~3.7MB 是全部结构里最大的）。
- **撒布剔除**：阶段 2.7 用 `inRuinedCitadelFootprint`。
- **植被让路**：`pointContext` 对占地返回 `kind:'none'`（转调 `inRuinedCitadelFootprint`，红线 1）。
- **结构名注册**：`structure-json.js` 从 `RUINED_CITADEL_VARIANTS` 派生（红线 1）。
- ⚠️ **性能**：`rasterizeStructure` 对每个相交 column 遍历全部 288,744 格，
  相交 column ≈ 7×7=49 ⇒ ~14M 次 setBlock，全在 GEN Worker、每 seed 一次。比大竞技场大 3.4 倍但同构。

### DR-8 预算

| 项 | 本结构 | 大竞技场（参照） | 判断 |
|---|---|---|---|
| 产物格数 | 288,744 | 115,381 | 2.5× |
| 产物 JSON | 3.70MB | 1.50MB | 2.5× |
| 暴露面 | 74,518 | 92,802 | **0.8×** |
| cutout 格 | 4,810 | 7,588 | **0.63×** |
| 光源（ochre_froglight） | 134 | 942（glowstone） | 0.14× |

⇒ **渲染压力低于大竞技场**。门禁：`npm run bench -- --check` + `m3-fullscene`（200 MiB）。
⚠️ bench 不可与回归并发跑。

### DR-9 瞬移按钮（用户裁定 ⑥）

- 设置面板瞬移行**第 8 个**按钮，文案 **「堡垒」**（2 字）。
- id：`btn-teleport-ruined-citadel`；常量 `TELEPORT_CITADEL_LABEL = '堡垒'`。
- **落点唯一权威** = `ruinedCitadelTeleportPoint(seed)`：占地**东缘**（City 那一侧）再向东
  `RUINED_CITADEL_TELEPORT_GAP = 6` 格、z 取锚点中线，y = 自然地表 `generateHeight + 1`。
  ⚠️ 与大竞技场**镜像**（大竞技场在城东⇒落点西缘；本结构在城西⇒落点**东缘**）。
- `Game.teleportToRuinedCitadel()`，kind `ruined-citadel`，reason `no-ruined-citadel`。
- ⚠️ **布局必须实测**：8 按钮 + `gap:4px` ⇒ 每只 ~44px、内容宽 ~32px，2 字（24px）理论放得下。
  用 `teleport.spec` 的 `offsetTop`（不得换行）+ 行盒数（文案不得折行）判据实测；
  ⚠️ `scrollWidth <= clientWidth` 对折行无判别力。若折行：`gap` 收到 2px 或另起一行。
- ⚠️ **缘外那一点不在锚点判据保证范围内**：跑 8 seed 普查（DESERT/高于海平面/5×5 高差/
  不落进浅水高台整形区/城市 bounds），结论写进注释。

### DR-10 许可备注

同大竞技场：nbt 数据文件 + mod 贴图复制入库，注明出处（L_Ender's Cataclysm mod, 1.19.2）。
⚠️ **贴图许可**：mod 的 `textures/blocks/*.png` 是模组资源，复制进本仓前确认源仓库
`LICENSE.txt`（Forge MDK 模板 LGPL）覆盖资源文件；用户已裁定移植。

---

## 4. 实施步骤（按依赖顺序）

### 阶段 A：素材入库 + 新方块注册（v2 新增前置）

1. `mkdir assets/ruined-citadel/src/`，复制 18 片 nbt + `README.md`。
2. **复制 mod 贴图**：`assets/ruined-citadel/src/textures/` 暂存 10 张 PNG
   （obsidian_bricks / end_stone_pillar / end_stone_pillar_top / chiseled_end_stone_bricks /
   polished_end_stone / chiseled_purpur_block / chorus_planks / chiseled_obsidian_bricks /
   void_stone / void_infused_end_stone_bricks），实施时拷进 `assets/textures/`。
3. **注册 15 个新方块**：`blocks-data.js` + `faces-data.js`（DR-3）。
4. `npm run atlas` + `npm run icons`（重打图集 + 重烘图标）。
5. 更新冻结计数：`test-block-registry.js`（139→154）、`test-inventory.js`（139→154）、
   `test-orientation.js`（98→109），以实测为准。

### 阶段 B：烘焙管线

6. 写 `tools/ruined-citadel-fingerprint.mjs`（BLOCK_MAP 按 DR-4 定稿、SLAB_BASE、FLOOR_ROW=45、
   METRICS、指纹、re-export FACING_TO_ORIENT）。
7. 写 `tools/bake-ruined-citadel.mjs`（assemble / classify 含 air 分支 / 栏杆朝向 pass /
   bake / census / census-orient / main module 守卫）。
8. `package.json` 加 `"ruinedcitadel"` 脚本。
9. 跑 `--census`（未映射项必须为 0）+ `--census-orient`（冻结台阶朝向）+ 正式烘焙。
10. 按实测值回填 `RUINED_CITADEL_METRICS`（不符停下报告）。

### 阶段 C：生成层

11. `src/gen/structures/ruined-citadel-data.js`（浏览器侧纯数据：VARIANTS + HALF_X/Z）。
12. `src/gen/structures/ruined-citadel.js`（锚点含水约束 / candidateValid / footprint /
    suppressedLandmarks / overlapsRegion / teleportPoint）。
13. `structure-json.js` 注册；`structure-layout.js` 接线；`apply.js` 阶段 2.94；
    `world-worker.js` 预热锚点。

### 阶段 D：UI

14. `settings-panel.js`（「堡垒」按钮 + gap 调整）；`game.js`（teleportToRuinedCitadel）。

### 阶段 E：门禁与测试

15. `tools/check-data.mjs` 新增 `[废弃堡垒]` 环节（含 air 格数判据）+ 主流程调用行。
16. `src/tests/test-ruined-citadel-gen.js`（Tier 1 TDD）+ 注册进 `index.html`。
17. `src/tests/test-ui.js`（8 按钮）；`tests/teleport.spec.mjs`（新按钮 + 不折行判据）。
18. `tests/ruined-citadel.spec.mjs`（Tier 4 像素验收）。

### 阶段 F：验证

19. `npm run check` + 浏览器单测 + 相关 E2E + `npm run bench -- --check`。
20. 负向验证（cp 副本还原，禁 git checkout/restore）。
21. 更新 `docs/roadmap.md` + `AGENTS.md`。

---

## 5. 测试计划（testing-policy 分级）

| 级别 | 内容 | 门禁 |
|---|---|---|
| **Tier 1（TDD）** | `test-ruined-citadel-gen.js`：① STRUCTURE_FILES 登记 ② 产物加载（尺寸/格数/floorRow=45/stride=5）③ **palette 含 air 且 air 格数=27,060** ④ 锚点必须且唯一 ⑤ 城西且净距 ⑥ **占地+4 格全干燥（水约束）** ⑦ 占地全 DESERT+高于海平面 ⑧ 高差在档内 ⑨ 是「最近」 ⑩ 不与地基级结构重叠 ⑪ footprint 边界精确 ⑫ region 裁剪 ⑬ 空岛/地标让路 ⑭ 真实 GEN 落位（甲板=floorY、地牢房间是 air、无植被、底部越界被裁）⑮ 瞬移落点逐值 | 注册进 index.html |
| **Tier 1（新方块）** | `test-block-registry.js`/`test-inventory.js`/`test-orientation.js` 冻结计数更新；15 个新方块都在 registry + 背包 + 有 faces-data 条目 | npm run check |
| **Tier 2** | `check:data` 新环节：指纹/尺寸/stride/floorRow/palette 全注册/**air 格数**/台阶朝向/栏杆朝向/通道分布/两侧 VARIANTS/半宽 | npm run check |
| **Tier 4** | `ruined-citadel.spec.mjs`：飞到城西锚点→等 sections 稳定→读真实方块（甲板=floorY、地牢房间=air、虚空灯位=ochre_froglight）→截图上下界双钉（先测噪声底） | npm test |
| **预算** | `npm run bench -- --check`（不并发）+ m3-fullscene 200MiB | 实跑 |

**负向验证清单**（每条真红，cp 副本还原 + sha256 核对）：
1. palette 去掉 air ⇒ Tier 1 ③ + check:data 红（DR-2 核心守卫）
2. 城市净距方向写反 ⇒ Tier 1 ④ 红（8/8 找不到锚点）
3. **去掉水约束（外扩 4 格判据）⇒ Tier 1 ⑥ 红**（v2 新增守卫）
4. STRUCTURE_FILES 漏注册 ⇒ Tier 1 ① 红
5. 粗筛用 ceil ⇒ 「最近」用例红
6. 台阶 half=top 不 +2 ⇒ census-orient 红
7. 半砖剥后缀查表 ⇒ check:data palette 断言红
8. **新方块漏注册某一个 ⇒ test-block-registry 计数红 + 该方块在产物里变 air**
9. 瞬移按钮文案改 3 字 ⇒ teleport.spec 行盒数判据红

---

## 6. 风险与开放项

1. **产物体积 3.7MB（最大产物）**：GEN Worker 首次 fetch+解析耗时实测，确认不撞 genP95 10ms 门。
2. **甲板覆盖率 71.6%（非满铺）**：实施时探针查甲板缺口连通性（能否进地牢）；
   若缺口全在边缘、中心封闭，可能需补入口台阶 —— **开放项，实测后定**。
3. **134 盏 ochre_froglight 的 blocklight BFS**：129 盏集中 y=-24 单层，实测 GEN 计时不超标。
4. **瞬移行 8 按钮布局**：2 字文案理论放得下，必须实测（DR-9）。
5. **两个沙漠结构落点竞争**：大竞技场（城东）与本结构（城西）分处两侧，实测无冲突；
   避让单向（本结构避让大竞技场，大竞技场 `fixedBlockerAt` 不知道本结构）——
   在 `burning-arena.js` 注释里写明，避免将来本结构也放城东时静默相撞。
6. **atlas 重打**：加 10 张新贴图会移动所有 tile UV，但运行期从 atlas.json 读、单测用假 atlas ⇒ 安全；
   仍需重跑全量单测确认无 UV 硬编码。
7. **新方块贴图许可**：DR-10，实施前确认 LICENSE 覆盖资源。
8. **`seededRandom` salt**：本结构不用 seededRandom（落点是确定性最近点）⇒ 不占 salt 区间。

---

## 7. 文件清单

**新增**：
- `tools/bake-ruined-citadel.mjs`、`tools/ruined-citadel-fingerprint.mjs`
- `assets/ruined-citadel/src/ruined_citadel{1..18}.nbt` + `README.md` + `textures/`（10 张 PNG 暂存）
- `assets/structures/ruined_citadel.json` + `.meta.json`（烘焙产物）
- `src/gen/structures/ruined-citadel.js`、`ruined-citadel-data.js`
- `src/tests/test-ruined-citadel-gen.js`、`tests/ruined-citadel.spec.mjs`

**修改**：
- `src/voxel/blocks-data.js`（+15 方块）、`src/voxel/faces-data.js`（+15 贴图映射）
- `assets/textures/`（+10 PNG）、`assets/atlas.{png,json}`（重打）、`assets/icons-atlas.png`+`icons.json`（重烘）
- `package.json`（ruinedcitadel 脚本）
- `src/gen/structures/structure-json.js`、`structure-layout.js`、`apply.js`、`src/workers/world-worker.js`
- `src/ui/settings-panel.js`、`src/core/game.js`
- `src/tests/index.html`、`test-ui.js`、`test-block-registry.js`、`test-inventory.js`、`test-orientation.js`
- `tests/teleport.spec.mjs`、`tools/check-data.mjs`
- `docs/roadmap.md`、`AGENTS.md`

**删除**：无

---

## 8. 红线自检（AGENTS.md 四问）

| 问 | 答 |
|---|---|
| 引入了第二份权威或新缓存层？ | **否**。FACING_TO_ORIENT 从 pyramid re-export；railPlacementFor/railArmSet 从 arena.js import；落点/水判据转调既有权威（getCityBoundsForSeed/getBiome/**generateHeight**/computeTarnZone）；inRuinedCitadelFootprint 是唯一占地判据。memo 是既有手法。 |
| 把生成期问题推到运行期？ | **否**。落点、朝向、映射、新方块注册全在烘焙期/GEN 期；运行期只读产物。 |
| 在主线程做了可后台化的重计算？ | **否**。锚点搜索在 Worker layout 入口预热；光栅化在 GEN Worker。 |
| 绕过统一管线新开了专属 Worker/子系统？ | **否**。走 rasterizeStructure 统一管线（air 是 id=0 的普通 palette 条目）；新方块走既有 blocks-data/faces-data/atlas/icons 管线，**不开新几何分支、不新建 Worker**。 |
