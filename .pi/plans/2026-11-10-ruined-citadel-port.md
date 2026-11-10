# 废弃堡垒移植（Cataclysm ruined_citadel → 城西最近沙漠）

日期：2026-11-10（探索与实测数据采于 2026-11-09）
状态：用户已批准，待实施
参照：大竞技场移植（v2.85~v2.88，`docs/superpowers/specs/2026-11-09-burning-arena-port-design.md`）

---

## 0. 一句话

把 Cataclysm 模组的 `ruined_citadel`（废弃堡垒，18 片 nbt、26 万格）按大竞技场的同一套手法
移植进 mc-heavy：烘焙成 palette 产物 + 重映射到现有方块 + 落在 **City 西方最近的沙漠**，
甲板与地表齐平、**44 层地下地牢完整保留**，并加一个「堡垒」瞬移按钮。

**⚠️ 烘焙 = 数据格式转换，不产生新美术资源**：零新增方块声明、零新增贴图。

---

## 1. 用户裁定（2026-11-09，`ask_user_question`）

| # | 裁定 | 内容 |
|---|---|---|
| ① | 移植方式 | 参照大竞技场的移植方式（方案 A：只搬几何 + 重映射现有方块） |
| ② | 落点 | City **西方**最近的一块沙漠地带 |
| ③ | 不重叠 | 表面不要跟沙漠其他建筑重叠 |
| ④ | 方块 | 利用现有的方块做映射 |
| ⑤ | 锥体处理 | **完整保留·埋入地下**（见 §2.6 的更正说明） |
| ⑥ | 瞬移按钮 | **加「堡垒」按钮** |

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

---

## 2. 实测事实（冻结数字，探针 2026-11-09）

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
| 其中**甲板以下**（y<0）空气 | **27,060** 格 —— **100% 封闭**（6 邻全在片数据内）⇒ 地牢房间 |
| 其中甲板以上（y≥0）空气 | 230,205 格 ⇒ 是天空，**刻意不写进产物** |
| **产物总格数** | **288,835** = 261,775 实心 + 27,060 空气 |
| 产物 JSON 体积估算 | ~3.6MB（stride 5；参照 burning_arena 115,381 格 → 1.50MB = 13.0 字节/格） |
| 源 palette 并集 | **46** 种方块名 |
| 暴露面（6 邻域空气） | **74,518**（≈ 298K 顶点下界；大竞技场是 92,802） |
| `structure_block` 数据标记 | **10** 个（3 `golem` + 4 `mimic` + 3 `sentry`）→ 丢弃 |
| `cataclysm:altar_of_void` | 1 个（y=-15，末影守卫召唤祭坛）→ 丢弃 |
| 甲板层（y=-1） | 8,196 格，覆盖率 **72.3%**（非满铺，有缺口） |
| `floorRow`（归一化后甲板层 ny） | **45**（= -1 − (-45) + 1） |
| 归一化总高 | 63（ny ∈ [1,63]） |

⚠️ **甲板覆盖率 72.3% 不是满铺** —— 与大竞技场的 `floorCells` 4,825/7,225 同一情形，
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

### 2.5 落点环境（8 seed 实测，含全部避让项）

搜索算法与大竞技场同构（两级筛选：粗筛网格 + 逐格精检），方向改为**城西**。
判据 = ① 占地全 DESERT ② 每格 `generateHeight > SEA_Y` ③ 高差 ≤ span ④ 城西且与城市
bounds 净距 ≥ `CITY_TRANSITION_SIZE` ⑤ 不与高台地带/浅水高台/围场/大竞技场重叠。

| seed | 锚点 (wx,wz) | span | 距城市中心 | floorY | 搜索耗时 | 精检次数 |
|---|---|---|---|---|---|---|
| 12345 | (-469,-71) | 5 | 775 | -1 | 131ms | 2 |
| 99999 | (-338,197) | 5 | 455 | 4 | 83ms | 3 |
| 1249026 | (-619,365) | 5 | 760 | -1 | 67ms | 2 |
| 20260101 | (-218,313) | 5 | 538 | 4 | 87ms | 5 |
| 777 | (-397,177) | 5 | 514 | 4 | 89ms | 11 |
| 4242 | (-85,445) | 5 | 451 | 4 | 49ms | 2 |
| 31337 | (-167,361) | 5 | 512 | 4 | 54ms | 3 |
| 8888 | (-154,201) | 5 | 445 | -1 | 105ms | 2 |

**8/8 seed 全部命中 span=5**（与大竞技场同一档），候选 14,643~17,903 个、粗筛后精检仅 2~11 次。

⚠️ **实测踩到的坑（必须写进代码注释）**：城市净距判据的方向。大竞技场在城东，写的是
`wx - HALF <= city.maxX + CLEARANCE → 拒绝`；本结构在城西，必须是
`wx + HALF >= city.minX - CLEARANCE → 拒绝`。我第一版照抄了城东那行，
**8/8 seed 全部返回「未找到」**（9ms 就退出，因为每个候选都被 city 判据拒掉）。

⚠️ **span≤4 无解**：占地 106×108 比大竞技场（85×85）更大，沙漠地形容不下那么平的一块
（与大竞技场 spec DR-3 记录的是同一现象）。故 `SPANS = [4,5,6,8]` 先严后松，5 是实际命中档。

⚠️ **必须预热**：搜索首次 49~131ms，要像 `computeBurningArenaAnchor` 一样预热在
`world-worker.js` 的 `layout` 入口（不落进 GEN 计时路径，`structure-gen` 的 genP95 门是 10ms）。

### 2.6 方块映射盘点（46 种源名）

**直接命中本仓（5 种）**：`end_stone`、`end_stone_bricks`、`obsidian`、`chest`、`stone`

**整块石材重映射**：

| 源方块 | 格数(全量) | 目标 | 理由 |
|---|---|---|---|
| `cataclysm:obsidian_bricks` | 9,134 | `obsidian` | 本仓无黑曜石砖变体，obsidian 同色系（rgb 52,45,59） |
| `cataclysm:chiseled_obsidian_bricks` | 122 | `obsidian` | 同上（雕纹变体） |
| `crying_obsidian` | 234 | `obsidian` | 本仓无哭泣黑曜石（大竞技场同一裁定） |
| `cataclysm:void_stone` | 122 | `obsidian` | 虚空石 = 深紫黑，obsidian 最近似 |
| `cataclysm:obsidian_explosion_trap_bricks` | 53 | `obsidian` | 陷阱砖 → 基础砖（功能不移植） |
| `cataclysm:polished_end_stone` | 200 | `end_stone` | 磨制末地石 → 末地石 |
| `cataclysm:chiseled_end_stone_bricks` | 451 | `end_stone_bricks` | 雕纹变体 → 基础砖 |
| `cataclysm:void_infused_end_stone_bricks` | 81 | `end_stone_bricks` | 虚空浸染变体 → 基础砖 |
| `cataclysm:end_stone_teleport_trap_bricks` | 51 | `end_stone_bricks` | 传送陷阱砖 → 基础砖 |
| `purpur_block` | 2,799 | `amethyst` | 紫色系最近似（本仓 amethyst rgb 141,103,197） |
| `cataclysm:chiseled_purpur_block` | 156 | `amethyst` | 同上 |
| `cataclysm:purpur_void_rune_trap_block` | 70 | `amethyst` | 同上（符文陷阱 → 基础块） |

**柱状 / 细件 / 植物 / 光源**：

| 源方块 | 格数 | 目标 | 理由 |
|---|---|---|---|
| `cataclysm:end_stone_pillar` | 1,029 | `vertical_pillar` | 本仓唯一竖柱几何 |
| `purpur_pillar` | 263 | `vertical_pillar` | 同上 |
| `end_rod` | 30 | `vertical_pillar` | 末地烛是细竖件（⚠️ 本仓 `vertical_pillar` 贴图是木色 `#b98e5b`，见 §6 风险 2） |
| `chorus_plant` | 85 | `vine` | 紫颂植物 → 藤蔓（本仓唯一攀爬植物） |
| `chorus_flower` | 9 | `allium` | 紫颂花 → 绒球葱（本仓唯一紫色花） |
| `cataclysm:void_lantern_block` | 134 | `glowstone` | 本仓发光方块只有 4 个（`emissive:15`），glowstone 是「嵌在墙/顶里的光源」最近似 |
| `lantern` | 1 | `hanging_lamp` | 本仓唯一吊灯几何 |
| `cataclysm:chorus_planks` | 126 | `dark_planks` | 紫颂木板 → 深色木板（rgb 67,43,20） |
| `purple_stained_glass_pane` | 8 | `glass_block` | 本仓唯一玻璃（⚠️ 是 `transparent` 通道） |
| `ender_chest` | 3 | `chest` | 末影箱 → 箱子 |
| `shulker_box` | 2 | `orange_shulker_box` | 本仓已有同名方块 |
| `barrel` | 9 | 丢弃 | 本仓无木桶 |

**丢弃（功能件 / 无对应几何）**：

| 源方块 | 格数 | 丢弃理由 |
|---|---|---|
| `structure_block` | 10 | Boss/怪物刷怪标记（3 golem + 4 mimic + 3 sentry），不移植 Boss 生成 |
| `cataclysm:altar_of_void` | 1 | 末影守卫召唤祭坛（功能块），不移植 |
| `purple_carpet` | 41 | 地毯无对应几何（本仓无 carpet） |
| `white_carpet` | 9 | 同上 |
| `magenta_carpet` | 7 | 同上 |
| `iron_trapdoor` | 5 | 活板门无对应几何 |
| `spruce_trapdoor` | 3 | 同上 |
| `flower_pot` | 4 | 花盆无对应几何 |
| `lever` | 1 | 拉杆无对应几何 |
| `tripwire_hook` | 1 | 绊线钩无对应几何 |

⚠️ **实测：丢弃会不会造洞？** 逐个查了下方支撑 —— 81 格里 **79 格下方有支撑**，
只有 `iron_trapdoor` 1 格 + `tripwire_hook` 1 格下方是空（它们本就是挂在墙上的件，
丢弃后不留洞）。⇒ **丢弃安全，不需要补底**。

### 2.7 台阶 / 半砖 / 墙栏（裁切无关，全量统计）

**台阶 3,492 格**（5 种源名 × half 两态）：

| 源 | half=bottom | half=top |
|---|---|---|
| `end_stone_brick_stairs` | 585 | **1,258** |
| `cataclysm:obsidian_brick_stairs` | 1,096 | 55 |
| `purpur_stairs` | 624 | 126 |
| `cataclysm:polished_end_stone_stairs` | 0 | 74 |
| `cataclysm:chorus_stairs` | 0 | 44 |
| **合计** | **2,305** | **1,557**（45% 倒置） |

⚠️ **倒置台阶是多数派之一，不是边缘情况**（与大竞技场 59% 倒置同一情形）⇒
`cobblestone_step_updown` 分支是主路径，其朝向映射必须 `--census-orient` 实测冻结
（AGENTS.md：朝向映射只能用真实 mesher 实测定，不能从 `orientation.js` 或 MC 定义推）。

**半砖 3,320 格**（4 种源名 × type 三态）：

| 源 | bottom | top | double |
|---|---|---|---|
| `cataclysm:obsidian_brick_slab` | 2 | 48 | **1,801** |
| `purpur_slab` | 20 | **1,076** | 2 |
| `end_stone_brick_slab` | 16 | 224 | 72 |
| `cataclysm:polished_end_stone_slab` | 0 | 8 | 0 |
| **合计** | 38 | **1,356** | **1,875** |

⚠️ **三种 type 全存在，且 `double` 是多数**（1,875 格）⇒ 不得假设「top/double 罕见」。
⚠️ **不得用「剥 `_slab` 后缀查 BLOCK_MAP」的写法**：`end_stone_brick_slab` 剥出
`end_stone_brick`（单数）而表里是 `end_stone_bricks`（复数）→ 静默落到兜底值
（大竞技场探针实测因此错映 36 格为 `stone`，格数完全对得上、只有看画面才发现）。
必须用**显式 `SLAB_BASE` 表**。

**墙/栅栏 708 格**（`cataclysm:obsidian_brick_wall` 350 + `end_stone_brick_wall` 215 +
`cataclysm:purpur_wall` 20 + `cataclysm:chorus_fence` 123），其中 **533 格带连接 props**
⇒ 复用大竞技场的 `computeRailOrientations` 朝向 pass（`handrail` 转角件 / `handrailA` 直段件）。

### 2.8 通道分布预估（预算关注点）

| 通道 | 估算格数 | 说明 |
|---|---|---|
| opaque | ~283,000 | end_stone 系 + obsidian 系 + amethyst 系 + vertical_pillar(cutout，见下) |
| cutout | ~5,600 | 台阶 3,492 + 半砖(bottom) 38 + 墙栏 708 + vine 85 + allium 9 + chest 12 + hanging_lamp 1 + vertical_pillar 1,322 |
| transparent | 8 | `glass_block`（紫色玻璃板） |

⚠️ `vertical_pillar` 是 **cutout**（`cullMode:"cutout"`），1,322 格柱子全进 cutout 通道 ⇒
cutout 实际约 **5,600 格**，仍**低于**大竞技场的 7,588 格。
⚠️ 精确值必须用 `REGISTRY.cullTable` 算（**不要正则扫 blocks-data 源码** —— 大竞技场 v2.86
踩过：名字正则 `[a-z_0-9]+` 匹配不到带大写的 `handrailA`，cutout 少算 1,550 格而格数/类型/指纹全对）。

---

## 3. 设计决策

### DR-1 烘焙管线（完全复用 burning-arena 模式）

- 输入**入库**：`assets/ruined-citadel/src/ruined_citadel{1..18}.nbt`（共 1.4MB，
  与 `assets/burning-arena/src/`、`assets/arena/src/` 同口径）⇒ 指纹不依赖仓库外文件，
  任何机器 `npm run check` 结果一致。
  ⚠️ **不得放进 `assets/textures/`**（`build-atlas` 递归扫描该目录 → 任何源图放进去都会
  变成一个巨型 tile，AGENTS.md 已记）。
- 新文件：
  - `tools/ruined-citadel-fingerprint.mjs` — 映射表 `BLOCK_MAP` + `SLAB_BASE` + 产物指标
    `RUINED_CITADEL_METRICS` + 输入指纹（node 侧模块）
    ⚠️ **`src/**` 与浏览器单测绝不能 import 它** —— 它依赖 `node:fs`，浏览器解析
    `node:` 协议会失败 → 整个模块不加载 → Worker 起不来 → 游戏白屏，而 `check:arch`
    抓不到这类运行时解析失败（B1 教训）。运行期需要的纯数据放 `ruined-citadel-data.js`。
  - `tools/bake-ruined-citadel.mjs` — 读 18 片（复用 `tools/nbt-reader.mjs`）→ 按 OFFSET 拼合
    → 重映射 → 栏杆朝向 pass → 输出。支持 `--census`（普查）与 `--census-orient`
    （真实 mesher 重测台阶朝向，pyramid/arena 同款）。
    ⚠️ **必须判 main module**（`import.meta.url === file://${process.argv[1]}`）：
    验证脚本要 import 本文件的 `assemble` / `computeRailOrientations`（红线 1：共用同一份算法），
    不判的话 import 会直接触发 bake()。
- 输出：`assets/structures/ruined_citadel.json`（**palette + stride=5 带朝向**格式）
  + `ruined_citadel.meta.json`（尺寸/计数/朝向分布/指纹）。
- `package.json` 加 `"ruinedcitadel": "node tools/bake-ruined-citadel.mjs"`。
- **`FACING_TO_ORIENT` 从 `giant-pyramid-fingerprint.mjs` re-export**（同一事实不抄第二份，红线 1），
  且要纳入本结构的参数指纹（改朝向表会改变产物 → 指纹必须跟着变）。

### DR-2 空气格必须写进产物（本结构特有的关键决策）

**这是与大竞技场最大的不同**，也是「完整保留地牢」能成立的前提。

- **问题**：`rasterizeStructure` 只写产物里的格，而地牢房间在 nbt 里是**显式空气**。
  若不写空气，`fillColumn` + `carveCaves` 生成的天然岩层会**填满整个地牢**
  ⇒ 玩家挖下去看到的是实心石头，22.6 万格地牢白搬。
- **实测依据**：甲板以下 27,060 格空气 **100% 封闭**（6 邻全在片数据内，只有 1 格在边界）
  ⇒ 它们全是房间/走廊内部空间，写 air 不会在结构与天然地形之间造出空腔。
- **做法**：产物 palette 里加 `"air"` 条目，甲板以下（structure y<0）的空气格照常写进
  `blocks` 数组。光栅化时 `setBlock(…, 'air')` → `makeColumnSetter` 查
  `registry.idOf('air') === 0` → `blocks[idx] = 0`（**实测确认 air 已注册且 id=0**）⇒ 清空格。
- **甲板以上（y≥0）的 230,205 格空气刻意不写**：那是天空，写了纯浪费产物体积
  （会让 JSON 从 3.6MB 涨到 17.3MB）。
- ⚠️ **`rasterizeStructure` 不需要改**：它已经是「产物里有什么就写什么」，
  `air` 只是一个恰好 id=0 的普通 palette 条目。零运行期代码改动。
- ⚠️ **`check:data` 要钉住这条**：产物 palette 必须含 `air`，且 air 格数 = 27,060。
  漏了这条的失效形态是「地牢被天然岩层填满」—— 格数、类型、指纹全对，只有挖下去才发现。

### DR-3 重映射原则

同大竞技场：保形状优先，质感偏差是方案 A 的已知代价。完整表见 §2.6。

1. 整块石材按色系就近（obsidian 族 → `obsidian`，末地石族 → `end_stone`/`end_stone_bricks`，
   紫珀族 → `amethyst`）。
2. **台阶保几何**：`*_stairs` → `stone_diorite_step`（浅灰，与末地石色系协调；
   ⚠️ 本仓三种台阶几何的贴图只有 Cobblestone(灰)/sand(沙黄)/planks_birch(木)/stone_diorite(浅灰)，
   **没有末地石色台阶** ⇒ 色差是方案 A 的固有代价，用户已知情）。
   - `half=bottom` → `stone_diorite_step` + `FACING_TO_ORIENT[facing]`
   - `half=top` → `cobblestone_step_updown` + `(orient+2)%4`
     （倒置台阶是「颠倒 + 水平镜像」，高侧差 180°，AGENTS.md 已记；
     ⚠️ 刻意不复用 `stone_diorite_step` 的倒置变体 —— 本仓没有它）
   - ⚠️ **`shape=straight/inner/outer` 统一按直台阶处理**（pyramid/arena 同款裁定），
     转角处允许轻微几何失真。
3. **半砖三型分流**（实测三种都存在，`double` 还是多数）：
   - `type=bottom`（38 格）→ `sand_slab`
   - `type=top`（1,356 格）/ `type=double`（1,875 格）→ **显式 `SLAB_BASE` 表**映射到基础整块
     ⚠️ `type=top` 刻意**不用** `half_block_updown`：那个方块的贴图是 `planks_birch`（木色），
     在末地石+黑曜石场景里比「高 0.5 格的整块」显眼得多（大竞技场同一裁定）。
4. **墙/栅栏保「细件」观感**：`*_wall` / `chorus_fence` → `handrail`，
   朝向与直段/转角拆分复用 `computeRailOrientations`。
   ⚠️ **`BLOCK_MAP` 的目标值保持 `handrail` 不动** —— 它是 `RAIL_SOURCES` 的反查依据
   （映射到 handrail 的源方块即栏杆），改它会同时改掉「哪些格参与朝向计算」。
   ⚠️ **刻意不用 `handrailB`**：其实测臂只伸到 ±0.25（格中心），与邻居在格边界断开
   → 环上出现看不见的缺口（`test-arena.js` / `test-medieval-ship.js` 已钉住这条约束）。
5. **光源保发光**：`void_lantern_block` → `glowstone`，`lantern` → `hanging_lamp`
   （对齐本仓 4 个 `emissive:15` 方块的口径）。
6. **功能/标记方块丢弃**：见 §2.6 的丢弃表（实测丢弃不造洞）。
7. **未知源方块名必须 throw**：`makeColumnSetter` 对未注册名字是**静默 return** → 那格变 air，
   而**方块层面完全看不出是映射错了**（只表现为「墙上有个洞」）。v1.80 高台烘焙教训。

### DR-4 落位：城西最近的沙漠

- 锚点 = **城西距离最近的、相对平坦的沙漠点**（`computeRuinedCitadelAnchor`），
  **全世界每 seed 恰好一个**（用户裁定「必须且唯一」，无概率门）。
- 搜索窗：城西（起点 = `city.minX - 半宽 - 城市净空`），向西最多 **2400** 格，
  纬度取城市中线 ±900。候选按「距城市中心 → x → z」排序（确定性，不用 `seededRandom` 乱序 ——
  用户要的是「最近」，不是「随机一个」）。
- 判据（全部满足才算合法）：
  ① 占地 **106×108** 全是 DESERT biome；② 每格 `generateHeight > SEA_Y`；
  ③ 占地内地表高差 ≤ span（先严后松，`RUINED_CITADEL_SPANS = [4,5,6,8]`，取第一个有解的档）；
  ④ 在城西且与城市 bounds 净距 ≥ `CITY_TRANSITION_SIZE`（⚠️ 方向见 §2.5 的坑）；
  ⑤ 不与高台地带 / 浅水高台 / 围场 / **大竞技场** / 巨型金字塔重叠。
- **两级筛选是性能关键**（照抄大竞技场）：106×108 = 11,448 格逐格全检，
  粗筛用 8 格网格的 biome/height 先淘汰 99.99%（实测每 seed 只需 2~11 次精检），
  总耗时 49~131ms。
  ⚠️ **粗筛网格步长换算必须用 `floor` 不是 `ceil`**：粗筛只能是精检的**必要条件**（更宽），
  绝不能更严（大竞技场 v2.85 实测踩到：`ceil` 让粗筛覆盖 ±48 > 精检的 ±42，
  误杀了**更近**的合法候选，违反「最近」口径）。
  ⚠️ **网格必须向四周外扩 `gi` 格**：否则**窗边缘的候选**其邻域越出网格 → 越界返回 false
  → 合法候选被静默误杀（大竞技场 v2.85 实测踩到 seed 99999）。
  ⚠️ 本结构 x/z 半宽不同（53 / 54）⇒ `giX` 与 `giZ` 要分开算，不能共用一个 `gi`。
- 落位 y：`rasterizeStructure(type, wx, floorY - (floorRow-1), wz, ...)`，
  使**甲板层（归一化 ny=45）正好落在 floorY**（占地内最低自然高度，同大竞技场口径）。
- **不补 groundSupport**：甲板以下全是实心结构体（44 层），不需要支撑柱；
  补柱会在锥体底部外多插一圈（大竞技场同一裁定）。
- **底部越界格由既有守卫自然丢弃**（§2.4），不需要额外代码。

### DR-5 压制 vs 避让（与大竞技场/浅水高台同一裁定）

- **避让**只留「地基级大结构」：城市 / 高台地带 / 浅水高台 / 围场 / **大竞技场**
  （五者互斥是既有口径；⚠️ 大竞技场是本次**新增**的避让项 —— 它也在沙漠里，
  两个结构都在沙漠找落点，不互斥就会撞在一起）。
- **压制**其余内容（`ruinedCitadelSuppressedLandmarks`，逐地标粒度）：
  地标（金字塔/冰封山/岛/平地/雪原）、巨型金字塔、空岛、撒布、植被。
- ⚠️ **压制判据必须用「圆↔矩形相交」而不是「地标中心在占地内」**（大竞技场 v2.85 实测踩到：
  plainLand 中心 dz=43 在占地外 1 格但半径 15 伸进来 ⇒ 中心判据漏压，
  平地的沙柱+仙人掌长进了碗身，实测 16 格植被穿模）。半径取 `LANDMARK_CLEARANCE`（既有权威表）。
- ⚠️ **必须扫占地触及的全部 region**：106×108 占地可跨 2×2 个 region（region 边长 400），
  而锚点所在的那个 region 里可能一个地标都没有、地标全在邻居 region。
  按「锚点 region」压制会 ① 压掉一个本来没冲突的地标（零回归失败）② 又不压真正冲突的那些。
- ⚠️ **廉价距离门（性能关键）**：本函数对**每个** region 都会被 `computeRegionLayout` 调用，
  而它内部要调 `computeRegionLocalGiantPyramid`（扫全区沙漠）与 `computeSkyCandidates`
  （两个都是重函数）。大竞技场 v2.85 实测不加门时 `computeRegionLayout` 从 7.81ms/region
  涨到 8.57ms/region（+9.7%），把 `lake-ripple.spec` 推过线。
  ⇒ 先判「region AABB 到本结构矩形的最近距离 ≤ 最大地标半径」，超过就直接返回全 false。
- **空岛压制**：本结构塔顶 = `floorY + 18`（实测 floorY=-1..4 ⇒ 塔顶 y=17..22），
  而空岛底 y≥40 ⇒ **水平重叠也不相撞**（与大竞技场塔顶 y=79~84 必然相交不同）。
  ⚠️ 但仍要保留压制项：判据写成 `bottomY <= topY` 时本结构恒不触发（零成本），
  而**将来若加高塔楼就会静默失效**。故按大竞技场同一写法保留，注释里写明「本结构当前不触发」。
- ⚠️ **雪原压制不在 layout 层做**：雪原的压制粒度是「这座雪原是否压进占地」，
  走 `apply.js` 阶段 1 的跳过门（与 `snowLandSuppressedByTarn` 同手法），
  **不是**把 `layout.snowLand` 置 null —— 它有 6 处消费方直接解引用 `.cx`，置 null 会抛 TypeError。

### DR-6 apply.js 接线：新阶段 2.94

- **位置**：阶段 2.93（大竞技场）**之后**、阶段 2.5（空中结构）**之前** ——
  同为「地面级人工结构后写胜」语义。
  ⚠️ **`apply.js` 的阶段层序是载荷性的**（AGENTS.md 已记）：调换会让「树冠打穿屋顶」
  这类**方块层面看不出因果**的缺陷复活。
- **早退**：`placementIntersects({x:wx, z:wz}, 53, 54, column.cx, column.cz)`
  （不早退会让 9×9 邻域每个 column 白跑 28.8 万格循环）。
  ⚠️ 本结构 x/z 半宽不同（53 / 54），不能像大竞技场那样传同一个值。
- **预载**：携带锚点的 region 在 `needTypes` 里加 `ruinedCitadel`
  （惰性预载：本产物 ~3.6MB 将成为全部结构里最大的，不能无条件预载）。
  ⚠️ 不预热的话每个 Worker 的首个 GEN 要付 fetch+解析（大竞技场实测使 `structure-gen` 的
  genP95 从 ~9ms 涨到 ~12ms，撞破 10ms 门）。
- **撒布剔除**：阶段 2.7 用 `inRuinedCitadelFootprint` 剔除占地内的撒布候选
  （只靠后写胜不够：被埋的沙漠神殿/村落会有一半露在结构外面）。
- **植被让路**：`pointContext` 对占地返回 `kind:'none'`
  （**一个分支覆盖五个下游消费者**：阶段 2.75 高台让路 / 阶段 2.8 巨树 `allowedAt` /
  阶段 3 城市树·普通树 / 阶段 3 单格植物与睡莲 / 将来的新植被路径）。
  ⚠️ 判据转调 `inRuinedCitadelFootprint`（唯一权威，与阶段 2.7 共用同一份），
  不在此重写一遍 `Math.abs(dx) <= 53`（红线 1）。
- **结构名注册**：`structure-json.js` 的 `STRUCTURE_FILES` 加
  `ruinedCitadel: 'ruined_citadel.json'`（从 `ruined-citadel-data.js` 的 VARIANTS 派生，
  红线 1：不手写第二份）。
  ⚠️ 漏注册的失效形态是 `rasterizeStructure` 拿到空 blocks **直接 return** ⇒
  结构**静默不出现**，方块层面完全看不出。

### DR-7 预算

| 项 | 本结构 | 大竞技场（参照） | 判断 |
|---|---|---|---|
| 产物格数 | 288,835 | 115,381 | 2.5× |
| 产物 JSON | ~3.6MB | 1.50MB | 2.4× |
| 暴露面 | 74,518 | 92,802 | **0.8×**（地牢内部大量封闭格不产生面） |
| cutout 格 | ~5,600 | 7,588 | **0.74×** |
| 光源（glowstone） | 134 | 942 | 0.14× |

⇒ **渲染压力低于大竞技场**（暴露面与 cutout 都更小），GEN 写入量大 2.5 倍但仍在
大竞技场已验证的量级内。**门禁**：`npm run bench -- --check` +
`tests/m3-fullscene.spec.mjs`（`gpuVertexBytes < 200 MiB`）。
⚠️ 出生点在城市、bench 四场景的冲刺路径从森林/海岸起步，均不含本结构视域 ⇒
既有 bench 数字理论上不受影响，但**必须实跑确认**（不拍脑袋）。
⚠️ **bench 不可与回归并发跑**（AGENTS.md / memory 已记：frameP95 门禁会被负载污染）。

### DR-8 瞬移按钮（用户裁定 ⑥）

- 设置面板瞬移行**第 8 个**按钮，文案 **「堡垒」**（2 字）。
- id：`btn-teleport-ruined-citadel`；常量 `TELEPORT_CITADEL_LABEL = '堡垒'`。
- **落点唯一权威** = `ruinedCitadelTeleportPoint(seed)`（`ruined-citadel.js`，新增导出）：
  占地**东缘**（City 那一侧）再向东 `RUINED_CITADEL_TELEPORT_GAP = 6` 格、z 取锚点中线
  （玩家面朝西就能看到堡垒），y = 该格**自然地表** `generateHeight + 1`
  —— **不用 `anchor.floorY`**（那是甲板层高度，缘外沙漠的自然高度与之可能差几格；
  大竞技场 v2.87 实测 8 seed 差 0~5 格）。
  ⚠️ 与大竞技场**镜像**：大竞技场在城东 ⇒ 落点在西缘；本结构在城西 ⇒ 落点在**东缘**。
- `Game.teleportToRuinedCitadel()`，kind `ruined-citadel`，reason `no-ruined-citadel`
  （与大竞技场的 `no-burning-arena` 分开，面板逐 reason 映射）。
- **⚠️ 布局必须实测**：现有 7 按钮 + `gap:4px` ⇒ 每只 50.1px、内容宽 38.1px（3 字单行放得下）。
  加到 8 按钮后每只 ~44px、内容宽 ~32px ⇒ **3 字会折行，2 字（24px）刚好放得下**。
  「堡垒」是 2 字 ⇒ 理论上可行，但**必须用 `teleport.spec` 的行盒数判据实测确认**
  （⚠️ `scrollWidth <= clientWidth` 对折行**无判别力** —— 折行时两者依然相等，v2.19 实测踩过；
  要判「不得换行」用 `offsetTop`，判「文案不得折行」用**行盒数**）。
  若实测折行，备选方案：本行 `gap` 收到 2px，或把「堡垒」放进新的第二行。
- ⚠️ **缘外那一点不在锚点判据的保证范围内**（判据只逐格校占地）：
  必须像大竞技场 v2.87 那样**跑一份 8 seed 普查**（该点是否 DESERT、高于海平面、
  周围 5×5 高差、是否落进浅水高台整形区/城市 bounds），并把结论写进注释。
  最坑的形态是落点泡进浅水高台的整形区。

### DR-9 许可备注

同大竞技场：nbt 数据文件复制入库，入库目录注明出处（L_Ender's Cataclysm mod, 1.19.2）。
仅数据（方块布局），不含其代码/贴图。源仓库 `LICENSE.txt` 是 Forge MDK 模板（LGPL），
未声明模组本体许可；用户已裁定移植。

---

## 4. 实施步骤（按依赖顺序）

### 阶段 A：素材入库 + 烘焙管线

1. `mkdir assets/ruined-citadel/src/`，从上游复制 18 片 nbt（逐字节原样），写 `README.md` 注明出处。
2. 写 `tools/ruined-citadel-fingerprint.mjs`：
   - `RUINED_CITADEL_SOURCE_DIR` / `_JSON` / `_META` 路径常量
   - `RUINED_CITADEL_VARIANTS = ['ruinedCitadel']`
   - `RUINED_CITADEL_PIECES`（18 片偏移，§2.1）
   - `BLOCK_MAP`（§2.6）、`SLAB_BASE`（§2.7）、`FLOOR_ROW = 45`
   - `RUINED_CITADEL_METRICS`（§2.2 的冻结值）
   - `ruinedCitadelInputFingerprint()`（18 片**按顺序合并后整体求 sha**，
     ⚠️ 不是逐片各算一个 —— 逐片算会让「片顺序被调换」拓不到，而顺序错了 = 上下层错位）
   - re-export `FACING_TO_ORIENT`（从 `giant-pyramid-fingerprint.mjs`）
3. 写 `tools/bake-ruined-citadel.mjs`：
   - `assemble()`（export，验证脚本共用）
   - `classify(name, props, ny)`（含 air 分支：y<0 的 air → `{block:'air',meta:0}`，y≥0 的 air → 丢弃）
   - `computeRailOrientations(cells)`（从大竞技场移植，`inwardArms` 的中心改为 (17,18)）
   - `bake()` / `census()` / `censusOrient()`
   - main module 守卫
4. `package.json` 加 `"ruinedcitadel"` 脚本。
5. 跑 `npm run ruinedcitadel -- --census` 核对映射（**未映射项必须为 0**），
   跑 `--census-orient` 冻结台阶朝向，再跑正式烘焙。
6. **按实测值回填 `RUINED_CITADEL_METRICS`**（§2 的数字是探针估的，烘焙后以产物为准；
   ⚠️ 计划里标「冻结」的数字不符时**停下来报告**，不擅自改断言或放宽阈值）。

### 阶段 B：生成层

7. 写 `src/gen/structures/ruined-citadel-data.js`（浏览器侧纯数据：VARIANTS + `RUINED_CITADEL_HALF_X/Z`）。
8. 写 `src/gen/structures/ruined-citadel.js`：
   - `computeRuinedCitadelAnchor(seed)`（DR-4，含 memo + `clearRuinedCitadelCache()`）
   - `ruinedCitadelCandidateValid(wx,wz,span,seed)`（**export 供单测复用同一份判据**，红线 1）
   - `inRuinedCitadelFootprint(wx,wz,anchors)`
   - `ruinedCitadelSuppressedLandmarks(anchor,rx,rz,seed)`（DR-5，含廉价距离门）
   - `ruinedCitadelOverlapsRegion(anchor,rx,rz)`
   - `ruinedCitadelTeleportPoint(seed)`（DR-8）
   - 常量：`RUINED_CITADEL_HEIGHT`、`_MAX_SPAN`、`_SPANS`、`_MAX_GAP`、`_TELEPORT_GAP`
9. `structure-json.js`：从 `RUINED_CITADEL_VARIANTS` 派生注册。
10. `structure-layout.js`：加 `ruinedCitadel` 字段 + 压制项并入既有并集
    （⚠️ 压制一律写成 `cond ? null : <原表达式>`，**保留原表达式的求值位置与顺序** ⇒ 零回归）。
11. `apply.js`：阶段 2.94 + 预载 + 撒布剔除 + `pointContext` 让路。
12. `world-worker.js`：`layout` 入口预热 `computeRuinedCitadelAnchor(p.seed)`。

### 阶段 C：UI

13. `settings-panel.js`：`TELEPORT_CITADEL_LABEL = '堡垒'` + 第 8 个按钮 + gap 调整（按实测）。
14. `game.js`：`teleportToRuinedCitadel()`。

### 阶段 D：门禁与测试

15. `tools/check-data.mjs`：新增 `[废弃堡垒]` 环节（照抄 `[灾变竞技场]` 的 8 类判据 +
    **本结构特有的 air 判据**，见 DR-2），并在主流程**显式调用**
    （⚠️ 漏了调用行则门禁永不执行 —— 本仓已因此出过两次事故）。
16. `src/tests/test-ruined-citadel-gen.js`（Tier 1，TDD：RED→GREEN→REFACTOR）+
    注册进 `src/tests/index.html`（⚠️ 漏注册是**测试静默不跑**的全绿假象，
    `check:data` 的 `[测试注册]` 环节双向钉住）。
17. `src/tests/test-ui.js`：瞬移按钮常量（8 按钮）。
18. `tests/ruined-citadel.spec.mjs`（Tier 4 像素验收）。
19. `tests/teleport.spec.mjs`：新按钮用例 + 8 按钮不折行判据。

### 阶段 E：验证

20. `npm run check`（三门）→ 浏览器单测 → 相关 E2E → `npm run bench -- --check`。
21. 负向验证（每处用 `cp` 副本还原，**禁止对含未提交改动的文件用 `git checkout`/`restore`**）。
22. 写设计文档 `docs/superpowers/specs/2026-11-10-ruined-citadel-port-design.md`
    + 更新 `docs/roadmap.md` 版本表 + `AGENTS.md` 的路由表/坑清单（若有新教训）。

---

## 5. 测试计划（testing-policy 分级）

判据不是改动大小，而是**改坏了多久能被发现**。

| 级别 | 内容 | 门禁 |
|---|---|---|
| **Tier 1（TDD）** | `src/tests/test-ruined-citadel-gen.js`：① `STRUCTURE_FILES` 登记了 `ruinedCitadel` ② 产物加载（尺寸/格数/floorRow=45/stride=5）③ **palette 含 `air` 且 air 格数 = 冻结值**（DR-2 的唯一守卫）④ 锚点必须且唯一（每 seed 都有、确定性、跨调用一致）⑤ 在城西且与城市净距 ≥ `CITY_TRANSITION_SIZE` ⑥ 占地全 DESERT + 高于海平面 ⑦ 地表高差在放宽档内 ⑧ 是「最近」的那个（转调 `ruinedCitadelCandidateValid`，**多 seed**）⑨ 不与地基级大结构重叠（含大竞技场）⑩ 占地判据边界精确（内/外一格）⑪ region 裁剪（`overlapsRegion` 让跨 region 占地被邻区携带）⑫ 空岛/地标让路 ⑬ 真实 GEN 落位（甲板在 floorY、**地牢房间是空气**、无植被、底部越界格被裁）⑭ 瞬移落点逐值 | 注册进 `index.html`（`check:data` 双向钉） |
| **Tier 2** | `check:data` 新环节：输入 nbt 指纹 / 产物尺寸格数 / stride=5 / floorRow / **palette 全已注册** / **air 格数** / 台阶朝向分布逐档 / 栏杆朝向分布逐档 / 通道分布（用 `REGISTRY.cullTable`）/ 两侧 VARIANTS 一致 / 半宽与 data.js 一致 | `npm run check` |
| **Tier 4** | `tests/ruined-citadel.spec.mjs`：真实游戏页飞到城西锚点 → 等 sections 稳定（**world-stable 判据：sections 停止增长 + 三条队列归零**，不能只看队列瞬时归零）→ ① 读真实世界方块：甲板层在 floorY、地牢某房间格是 air、虚空灯位置是 glowstone ② 截图**上下界双钉**（非纯黑 + 含末地石主色；⚠️ 只钉「够暗」抓不到「纯黑」，只钉「非黑」抓不到「过曝」）③ 先测同状态重复截图的**噪声底**（⚠️ 大竞技场 v2.83 踩过：idle 动画让噪声底 1.3~2.0 万像素盖住信号 ⇒ 必要时 `renderer.setAnimationLoop(null)` 冻结帧循环） | `npm test` |
| **预算** | `npm run bench -- --check`（⚠️ 不可与回归并发）+ `m3-fullscene` 的 `gpuVertexBytes < 200 MiB` | 实跑，不估算 |

**门禁选择**：本改动含 Tier 1（GEN 落点算法 = 纯函数 + 热路径）⇒ `npm run check` + `npm test`；
改到 `apply.js`（GEN 热路径）⇒ 再加 `npm run bench -- --check`。

**负向验证清单**（每条都要真红，用 `cp` 副本还原 + sha256 核对）：
1. 产物 palette 去掉 `air` ⇒ Tier 1 ③ 红 + `check:data` 红（**这是 DR-2 的核心守卫**）
2. 城市净距判据方向写反（照抄城东那行）⇒ Tier 1 ④ 红（8/8 seed 找不到锚点）
3. `STRUCTURE_FILES` 漏注册 ⇒ Tier 1 ① 红
4. 粗筛用 `ceil` ⇒ Tier 1 ⑧ 红（误杀更近候选）
5. 压制判据用「中心在占地内」⇒ Tier 1 ⑫ 红
6. 台阶 `half=top` 不 +2 ⇒ `--census-orient` 红
7. 半砖用「剥后缀查表」⇒ `check:data` 的 palette 断言红
8. 瞬移按钮文案改 3 字 ⇒ `teleport.spec` 的行盒数判据红

---

## 6. 风险与开放项

1. **产物体积 3.6MB（最大产物）**：GEN Worker 首次 fetch + 解析的耗时必须实测，
   确认不撞 `structure-gen` 的 genP95 10ms 门（大竞技场 1.5MB 时实测 ~9ms→~12ms 撞破过）。
   缓解：`needTypes` 惰性预载（只有携带锚点的 region 才拉）+ `world-worker.js` 预热锚点。
2. **`vertical_pillar` 贴图是木色 `#b98e5b`**（实测 `bake-procedural-textures.mjs:131`），
   而 1,322 格柱子在末地石场景里应该是石色 ⇒ **观感偏差**（方案 A 的固有代价）。
   备选：柱子改映 `block_of_quartz`（rgb 235,229,222，浅白石色，但是 opaque 整块、
   会丢掉柱状几何）。**实施时先看 census 出的实际占比再定，倾向保留 `vertical_pillar`
   （保形状优先，与大竞技场「台阶保几何」同一裁定）**，并在设计文档里记明这个取舍。
3. **甲板覆盖率 72.3%（非满铺）**：需确认玩家能从甲板缺口进入地牢。
   实施时用探针查甲板层的连通性（缺口是否形成可用入口）；若缺口全在边缘、
   中心是封闭的，可能需要在 apply 阶段补几个入口台阶 —— **这是开放项，实测后再定，
   不在本计划里预设方案**。
4. **134 盏 glowstone 的 blocklight BFS**：129 盏集中在 y=-24 单层 ⇒ 该层单 region 内
   BFS 种子密度高。实测 GEN 计时确认不超标（`computeBlocklightRegion` 是 3×3 region 口径）。
5. **瞬移行 8 按钮布局**：2 字文案在每只 ~44px / 内容宽 ~32px 下理论上放得下，
   但**必须实测**（DR-8）。若折行，备选：`gap` 收到 2px，或「堡垒」另起一行。
6. **两个沙漠结构的落点竞争**：大竞技场（城东）与本结构（城西）分处城市两侧，
   实测 8 seed 无冲突；但**避让项必须双向**（本结构避让大竞技场，
   而大竞技场的 `fixedBlockerAt` 目前**不知道**本结构存在）。
   ⚠️ 这是**已知的单向避让**：因为两者分处城东/城西、搜索窗不重叠，实际不会撞。
   实施时在 `burning-arena.js` 的 `fixedBlockerAt` 注释里写明这一点，
   避免将来有人把本结构也放到城东时静默相撞。
7. **台阶朝向**：`--census-orient` 实测后才算定稿（AGENTS.md：朝向映射只能用真实 mesher 实测定）。
8. **`seededRandom` salt 占用**：本结构**不用** `seededRandom`（落点是确定性最近点，不是随机），
   ⇒ 不占 salt 区间，无确定性污染风险。

---

## 7. 文件清单

**新增**：
- `tools/bake-ruined-citadel.mjs`、`tools/ruined-citadel-fingerprint.mjs`
- `assets/ruined-citadel/src/ruined_citadel{1..18}.nbt` + `README.md`（入库素材）
- `assets/structures/ruined_citadel.json` + `ruined_citadel.meta.json`（烘焙产物，生成物不手改）
- `src/gen/structures/ruined-citadel.js`、`src/gen/structures/ruined-citadel-data.js`
- `src/tests/test-ruined-citadel-gen.js`、`tests/ruined-citadel.spec.mjs`
- `docs/superpowers/specs/2026-11-10-ruined-citadel-port-design.md`

**修改**：
- `package.json`（`ruinedcitadel` 脚本）
- `src/gen/structures/structure-json.js`（注册 `ruinedCitadel`）
- `src/gen/structures/structure-layout.js`（`ruinedCitadel` 字段 + 压制并集）
- `src/gen/structures/apply.js`（阶段 2.94 + 预载 + 撒布剔除 + `pointContext` 让路）
- `src/workers/world-worker.js`（预热锚点）
- `src/ui/settings-panel.js`（第 8 个瞬移按钮「堡垒」+ gap 调整）
- `src/core/game.js`（`teleportToRuinedCitadel`）
- `src/tests/index.html`（新测试注册）
- `src/tests/test-ui.js`（瞬移按钮常量）
- `tests/teleport.spec.mjs`（新按钮用例 + 8 按钮不折行判据）
- `tools/check-data.mjs`（新环节 + 主流程调用行）
- `docs/roadmap.md`（版本表新行）、`AGENTS.md`（路由表 + 若有新坑）

**删除**：无

---

## 8. 红线自检（AGENTS.md 四问）

| 问 | 答 |
|---|---|
| 引入了第二份权威或新缓存层？ | **否**。`FACING_TO_ORIENT` 从 pyramid re-export；`railPlacementFor`/`railArmSet` 从 `arena.js` import；落点判据转调既有权威（`getCityBoundsForSeed`/`getBiome`/`generateHeight`/`computeTarnZone`/…）；`inRuinedCitadelFootprint` 是唯一占地判据，`pointContext` 与阶段 2.7 共用它。memo 是既有手法（同 `computeBurningArenaAnchor`），不是新缓存层。 |
| 把生成期问题推到运行期？ | **否**。落点、朝向、映射全在烘焙期/GEN 期确定；运行期只读产物。 |
| 在主线程做了可后台化的重计算？ | **否**。锚点搜索在 Worker 的 `layout` 入口预热（不落进 GEN 计时）；光栅化在 GEN Worker。 |
| 绕过统一管线新开了专属 Worker/子系统？ | **否**。走 `rasterizeStructure` 统一管线（`air` 只是一个 id=0 的普通 palette 条目，零运行期改动）；不新建 Worker。 |
