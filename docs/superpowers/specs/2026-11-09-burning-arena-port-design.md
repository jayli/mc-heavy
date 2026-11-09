# 大竞技场移植设计（Cataclysm burning_arena → 城东最近沙漠）

日期：2026-11-09（v2 修订：落点从祭坛高台地带改为城东沙漠）
状态：已实施，待用户审阅

> ## ⚠️ v2 修订（2026-11-09，用户裁定）
>
> **初版把大竞技场放在祭坛高台地带中心、取代祭坛。实测与两个 Boss 硬冲突：**
> - 飞龙轨道 r=24 / y=30 被碗体完全封闭 —— 玩家站圆心、碗缘顶、碗口上方三处各扫
>   24 方位，视线净空 **0/24**；抬高轨道则斜距 ≈70~87 ≫ 步枪 entityRange 40
>   （`dragon-config.js` 钉死）⇒ 龙变成打不到的装饰；
> - 焰魔召唤点在圆心，而圆心是 712 格的熔岩柱+塔（y=3..36）⇒ 玩家落点从 y=5 抬到 y=37。
> - 10 个既有 E2E 因此全红（单变量 A/B 已归因）。
>
> **用户裁定改为**：大竞技场放到**城东距离最近的沙漠地带的相对平坦区域**，
> 该区域优先生成大竞技场、不与其他沙漠建筑重叠，这块沙漠的其他地方生成逻辑照旧；
> **祭坛 + 飞龙/焰魔原地不动**（祭坛地带恢复原状）。
> 术语：**大竞技场** = 本结构；**小竞技场** = 既有城门竞技场（城南门外）。
>
> 下文 §1 的初版落点描述（祭坛地带/取代祭坛/抑制高台）**已作废**，
> 以本节与 §3′（城东沙漠落点）为准。

## 1. 目标与范围

把 Cataclysm 模组（`~/jaylli/cataclysm1.19.2modding`，L_Ender，MC 1.19.2 Forge）的
`burning_arena` Boss 竞技场移植进 mc-heavy，生成在**城东距离最近的沙漠地带的
相对平坦区域**（v2 修订；初版「祭坛高台地带中心」已作废，见上方修订记录）。

用户裁定（2026-11-09）：
- 方案 A：**只搬几何 + 重映射到现有 137 个方块**，不新增任何方块声明/贴图。
  烘焙 = 数据格式转换，不产生新美术资源。
- 只放 `burning_arena` 一个结构（其余 4 个灾变竞技场不移植）。
- **城东最近的沙漠必须且唯一生成大竞技场**（无概率门，恒 1 个）。
- **祭坛 + 飞龙/焰魔原地不动**（初版「取代祭坛/抑制高台」已撤销）。

明确**不做**：
- 不移植 Boss 生成逻辑（原模组靠 `structure_block` 数据标记 + `dungeon_block` 刷
  Ignited Revenant；本仓的龙/焰魔体系不受影响）。
- 不移植原版 MC 方块的贴图（不在源仓库里，且 vanilla 资源不可再分发）。

## 2. 实测事实（冻结数字，探针 2026-11-09）

### 2.1 结构本体

`burning_arena` 由 **8 个 nbt 片**组装（`Burning_Arena_Structure.java` 的 OFFSET 表，
rotation=NONE）：

| 片 | 偏移 (x,y,z) | 片 | 偏移 (x,y,z) |
|---|---|---|---|
| arena1 | (0,1,0) | arena5 | (0,49,0) |
| arena2 | (0,1,38) | arena6 | (0,49,38) |
| arena3 | (47,1,0) | arena7 | (47,49,0) |
| arena4 | (47,1,38) | arena8 | (47,49,38) |

组装后（已用本仓 `tools/nbt-reader.mjs` 实测）：
- 非空气包围盒 **85×85×80**（x/z ∈ [0,84]，y ∈ [1,80]，片偏移含 y+1）；
- 非空气格 **115,382**，其中丢弃 4 格（`structure_block` 3 + `cataclysm:altar_of_fire` 1）
  ⇒ **contentCells = 115,381**；重映射后目标 palette **20** 种；
- 暴露面 **92,802**（无面剔除估算）≈ 371K 顶点上界；
- 源 palette 并集 **45** 种方块名；
- 3 个 `structure_block` 数据标记（Boss 刷怪点，(42,32,16)/(46,47,37)/(42,32,68)）→ 丢弃；
- **地板**：中心 40×40 区域 y=0..9 全实心（10 层基座），y=10 起 99% 空气
  ⇒ 碗内地板顶面 = 归一化 y=10 ⇒ **`floorRow = 10`**。

### 2.2 落点环境（seed 12345 祭坛地带实测）

- 祭坛地带 = `findAltarTarnRegion(seed)`（距 City 最近的高台地带，唯一权威已存在）；
  seed 12345 时中心 (1000, 200)，region (2,0)。
- `plateauY = 2`，`platformRadius = 114`（恒平内圈），`TARN_ZONE_RADIUS = 138`。
- arena 占地 ±42.5 ≪ 114 ⇒ **完整落在平台恒平区**，无需 ground support。
- 与地带内既有内容的净空：
  | 内容 | 位置 | 与 arena(±42.5) 关系 |
  |---|---|---|
  | 8 座高台 | ring 58，内缘 ~34 | **碰撞** → 抑制（用户裁定） |
  | 紫晶柱 | ring 20 | 祭坛地带本就不放（v2.31）→ 维持 |
  | 拱洞 ×5 | ring 96 | 净空 53.5 ✓ 保留 |
  | 巨型云 ×4 | ring 82.8，y≥54 | 水平净空 40.3 ✓ 保留 |
  | 飞龙轨道 | 半径 24，y=30 | **被罩进碗内** → 落地后再调（用户裁定） |

### 2.3 方块映射盘点（45 种源名 → 19 种目标）

- **直接命中本仓 9 种**：air、nether_bricks、netherrack、obsidian、lava、chest、
  gold_block、polished_blackstone_bricks、polished_deepslate。
- **需重映射 36 种**（完整表在 `burning-arena-fingerprint.mjs`，原则见 DR-2）。

**重映射后实测（探针 2026-11-09，完整映射规则跑完 8 片）**：
- 目标 palette **19** 种，未覆盖项 **0**，facing 缺失 **0**；
- 通道分布：**opaque 107,793（93.4%）/ cutout 7,588（6.6%）/ transparent 0**；
- 主要目标格数：nether_bricks 78,913、polished_diorite 9,171、obsidian 7,075、
  netherrack 4,882（含地板熔岩 937）、polished_deepslate 3,477、handrail 3,311、
  lava 1,179（仅墙内装饰流与悬空池）、cobblestone_step_updown 2,053、
  cobblestone_step 1,426、polished_blackstone_bricks 1,389、glowstone 942、
  deepslate 540、sand_slab 504。
- **地板层（floorRow=10）实测组成**：floorCells **4,825**/7,225（碗内非满铺，有空气格）：
  nether_bricks 3,180 / netherrack 937（熔岩映射后）/ polished_deepslate 556 /
  cobblestone_step 136 / polished_blackstone_bricks 16。
- **碗内中心不是可站地板**：中心列 (42,42) 归一化 y=10..40 是熔岩柱（地板层那格映射后
  为 netherrack，y=11..40 仍是 solid lava），顶上有 chest/obsidian/gold_block/glowstone
  小塔（y=41..45）。可站取样点用偏移点（如 (cx+5, cz)，实测 y=10 polished_deepslate、
  y=11 起空气）。
- 源台阶/半砖的 Properties 分布（实测）：台阶 `half=top` **2,053** vs `half=bottom`
  **1,426**（59% 倒置）；slab `bottom` 504 / `top` 231 / `double` 36（**三种都存在**）。

## 3. 设计决策

### DR-1 烘焙管线（完全复用 arena/pyramid 模式）

- 输入**入库**：`assets/burning-arena/src/burning_arena{1..8}.nbt`（共 1.5 MB，
  与 `assets/arena/src/`、`assets/ignis/src/` 同口径）→ 指纹不依赖仓库外文件。
- 新文件：
  - `tools/burning-arena-fingerprint.mjs` —— 映射表 `BLOCK_MAP` + 产物指标 + 输入指纹
    （node 侧模块；`src/**` 与浏览器单测**禁止 import**，B1 教训）。
  - `tools/bake-burning-arena.mjs` —— 读 8 片 nbt（复用 `tools/nbt-reader.mjs`）→
    按 OFFSET 拼合 → 重映射 → 输出。支持 `--census`（普查）与 `--census-orient`
    （真实 mesher 重测台阶朝向，pyramid 同款）。
- 输出：`assets/structures/burning_arena.json`（**palette + stride=5 带朝向**格式，
  同巨型金字塔）+ `burning_arena.meta.json`（尺寸/计数/指纹）。
- `package.json` 加 `"burningarena": "node tools/bake-burning-arena.mjs"`。

### DR-2 重映射原则（保形状优先，质感偏差是方案 A 的已知代价）

1. 整块石材按色系就近：blackstone 族 → `deepslate`/`polished_deepslate`，
   basalt 族 → `polished_diorite`/`polished_granite` 之类浅色石（普查后定稿），
   red_nether_bricks → `nether_bricks_1`，cracked/chiseled 变体 → 基础变体。
1.5. **熔岩分层**（用户 2026-11-09 裁定）：**地板层（归一化 y = floorRow = 10）的 937 格
   lava → `netherrack`**（暗红可走，保住燃烧主题且碗内全可走）；其余层的 lava
   （墙内装饰流 y=11..40、悬空池 y=41..42）保持 `lava`（solid 发光）。
   ⚠️ 本仓 `lava` 是 `solid:true` 不可穿越 —— 若地板直映 lava，碗内 13% 地面走不过去，
   是玩法缺陷不是观感问题。判据用归一化 y === floorRow（与产物自洽，不写第二份）。
2. **台阶保几何**：`*_stairs` → `cobblestone_step`，facing→orient 用
   `FACING_TO_ORIENT`（pyramid 既有表）；`half=top` → `cobblestone_step_updown`
   且 orient 需 +2 mod 4（倒置台阶「颠倒+水平镜像」，高侧差 180°，AGENTS.md 已记）——
   用 `--census-orient` 对 updown 变体实测校验，不从定义推。
   ⚠️ **实测：倒置台阶是多数而非边缘情况** —— `half=top` **2,053** 格 vs `half=bottom`
   **1,426** 格（59% 倒置）。pyramid 的「top 罕见」假设在本素材**不成立**，故 updown 分支
   是主路径，其朝向映射必须实测冻结。
   ⚠️ **已知观感代价**：本仓三种台阶几何的贴图只有 Cobblestone（灰）/ sand（沙黄）/
   planks_birch（木），**没有暗色石台阶** ⇒ 3,479 格台阶全部渲染成灰 cobble，与暗红下界砖
   主体有色差。这是方案 A（不新增方块/贴图）的固有代价，用户已知情。
3. **slab**（实测三种 type 都存在，**不得假设 top 不出现**）：
   - `type=bottom`（492 格）→ `sand_slab`；
   - `type=double`（36 格）→ **显式表**映射到基础整块（`nether_brick_slab`→`nether_bricks`、
     `blackstone_slab`→`deepslate`）。⚠️ **不得用字符串剥 `_slab` 后缀查 BLOCK_MAP**：
     `nether_brick_slab` 剥出 `nether_brick`（单数）而表里是 `nether_bricks`（复数）→
     静默落到兜底值（探针实测因此错映 36 格为 `stone`）。
   - `type=top`（231 格）→ **映射到基础整块**（同上显式表），不用 `half_block_updown`。
     理由：`half_block_updown` 的贴图是 `planks_birch`（木色），在暗红下界砖场景里
     比「高 0.5 格的整块」显眼得多；而整块映射拿到的是 `deepslate`/`nether_bricks`
     （暗色，与主体一致），只损失 0.5 格轮廓。
4. **墙/栅栏/锁链保「细件」观感**：`*_wall`/`nether_brick_fence`/`chain` → `handrail`
   （cutout）。⚠️ 这是 cutout 预算的最大来源（~4,900 格），DR-5 留了降级保险丝。
5. **光源保发光**：shroomlight/soul_fire/candle → `glowstone`，
   lantern/soul_lantern → `hanging_lamp`（对齐 LIGHT_CONFIGS 的 4 个发光方块口径）。
6. 功能/标记方块丢弃：`structure_block`、`cataclysm:altar_of_fire`（1 格，
   原 Boss 功能块）→ 丢（air）；`ancient_debris` → `debris`，`raw_gold_block` → `gold_block`。
7. 藤蔓：twisting/weeping vines(+plant) → `vine`。
8. **未知源方块名必须 throw**（`makeColumnSetter` 对未注册名字静默 return → 那格变
   air，方块层面看不出映射错，v1.80 教训）。

### DR-3 落位：城东最近的沙漠（v2 修订，取代初版「祭坛地带中心」）

- 锚点 = **城东距离最近的、相对平坦的沙漠点**（`computeBurningArenaAnchor`），
  **全世界每 seed 恰好一个**（用户裁定「必须且唯一」，无概率门）。
- 搜索窗：城东（起点 = `city.maxX + 半宽 + 城市净空`），向东最多 1600 格，
  纬度取城市中线 ±900。候选按「距城市中心 → x → z」排序（确定性，不用随机）。
- 判据（全部满足才算合法）：
  ① 占地 85×85 全是 DESERT biome；② 每格 `generateHeight > SEA_Y`；
  ③ 占地内地表高差 ≤ span（先严后松，`BURNING_ARENA_SPANS = [4,5,6,8]`，取第一个有解的档）；
  ④ 在城东且与城市 bounds 净距 ≥ `CITY_TRANSITION_SIZE`；
  ⑤ 不与高台地带 / 浅水高台 / 小竞技场重叠。
  实测：85×85 在 span≤4 下候选数 0（占地是金字塔 3 倍，沙漠容不下那么平的一块），
  span≤5 时 8/8 seed 全命中 ⇒ 5 是「相对平坦」的最小可行档，6/8 是兜底。
- 落位 y：`rasterizeStructure(type, wx, floorY - (floorRow-1), wz, ...)`，
  使**碗内地板顶面正好落在 floorY**（占地内最低自然高度，同小竞技场口径）。
  9 层实心基座埋在 floorY 以下；基座下方空洞用 stone 补实（同小竞技场）。
- 不补 groundSupport（基座 9 层已足够，补柱会在碗底外多插一圈）。

### DR-4 压制 vs 避让（与浅水高台同一裁定）

- 实测：把地标圆 / 巨型金字塔 / 空岛都当**避让**项时，seed 12345 在 span≤8 下
  **一个落点都找不到**（landmark 1179 + pyramid 607 + sky 1009 次拒绝）—— 与
  `shallow-water-tarns.js` 的 `fixedBlockers` 注释记录的是同一个坑。
  用户要求「必须生成」⇒ 只能压制。改用压制后 8/8 seed 命中 span=5，搜索 ~100ms。
- **避让**只留「地基级大结构」：城市 / 高台地带 / 浅水高台 / 小竞技场（四者互斥是既有口径）。
- **压制**其余内容（`burningArenaSuppressedLandmarks`，逐地标粒度）：
  地标（金字塔/冰封山/岛/平地/雪原）、巨型金字塔、空岛、撒布、植被。
  ⚠️ 压制判据必须用「圆↔矩形相交」而不是「地标中心在占地内」（实测踩到：
  plainLand 中心 dz=43 在占地外 1 格但半径 15 伸进来 → 平地沙柱+仙人掌长进碗身）。
  半径取 `LANDMARK_CLEARANCE`（既有权威表）。
- **空岛压制是大竞技场特有的**（浅水高台没有）：它高 80 格（塔顶实测 y=79~84），
  而空岛底 y≥40 ⇒ 水平重叠即相撞。且空岛在 apply 阶段 2.5 光栅化，**晚于**大竞技场的
  2.93 ⇒ 不压制的话空岛会反过来打穿竞技场上半部（后写胜）。实测 8 seed 中 7 个需要压制。
  用户 2026-11-09 裁定：「大竞技场上面的空岛可以先不显示，空岛给大竞技场让路」。
  ⚠️ `cloudClusters`（既有小云）两种情况都必须保留，只压 `skyIslands`。

### DR-5 apply.js 接线：新阶段 2.93（大竞技场）

- 位置：阶段 2.9（小竞技场）**之后**、阶段 2.5（空中结构）**之前**——同为
  「地面级人工结构后写胜」语义。
- 早退：`placementIntersects({x:wx, z:wz}, 42, 42, column.cx, column.cz)`
  （不早退会让 9×9 邻域每个 column 白跑 11.5 万格循环）。
- 预载：携带锚点的 region 在 `needTypes` 里加 `burningArena`（惰性预载，
  本产物 1.4MB 是全部结构里最大的，不能无条件预载）。
- 撒布剔除：阶段 2.7 用 `inBurningArenaFootprint` 剔除占地内的撒布候选
  （只靠后写胜不够：被埋的沙漠神殿/村落会有一半露在碗身外面）。
- 植被让路：`pointContext` 对占地返回 `kind:'none'`（一个分支覆盖五个下游消费者）。
- 结构名注册：`structure-json.js` 的 `STRUCTURE_FILES` 加
  `burningArena: 'burning_arena.json'`（从 `burning-arena-data.js` 的 VARIANTS 派生，
  红线 1：不手写第二份）。

### DR-6 预算保险丝（cutout）

- **实测（非估算）**：cutout **7,588 格**（handrail 3,311 + 台阶 3,479 + sand_slab 504 +
  vine 168 + hanging_lamp 125 + chest 1），占 contentCells 的 **6.6%**；opaque 107,793 格。
  按 cutout 每格 ≈ opaque 3 倍顶点算 ≈ +23K 顶点量级；opaque 主体 ~9 万面是大头但
  opaque 通道余量充足（active 1800）。
- **门禁**：`npm run bench -- --check` + `tests/m3-fullscene.spec.mjs`
  （`gpuVertexBytes < 200 MiB`）。出生点在城市、冲刺路径从森林/海岸起步，均不含
  大竞技场视域 → 既有 bench 数字理论上不受影响，但**必须实跑确认**（不拍脑袋）。
- **保险丝**：若实测 cutout 峰值恶化 >5 个百分点，把 `*_wall`/`fence` 映射降级为
  `nether_bricks`（opaque 整块）重烘——只改 `BLOCK_MAP` 一行族，不动运行期代码。

### DR-7 祭坛与两个 Boss（v2 修订：原地不动）

- 初版「取代祭坛 / 抑制高台 / 飞龙先落地再调」**已全部撤销**。
- 祭坛地带恢复原状：祭坛图案、飞龙轨道、焰魔召唤点、高台地带 8 座高台全部不动。
- 大竞技场与两个 Boss 物理上分离（一个在城东沙漠，一个在祭坛高台地带），无冲突。

### DR-8 许可备注

- nbt 数据文件将复制入库。源仓库 `LICENSE.txt` 是 Forge MDK 模板（LGPL），
  **未声明模组本体许可**。用户已裁定移植；入库文件注明出处
  （L_Ender's Cataclysm mod, 1.19.2）。仅数据（方块布局），不含其代码/贴图。

## 4. 测试（testing-policy 分级）

| 级别 | 内容 | 门禁 |
|---|---|---|
| Tier 1（TDD） | `src/tests/test-burning-arena-gen.js`：① 产物注册/加载（尺寸/格数/floorRow）② 锚点必须且唯一（每 seed 都有、确定性）③ 在城东且与城市净距 ④ 占地全沙漠+高于海平面 ⑤ 地表高差在放宽档内 ⑥ 是「最近」的那个（转调 `burningArenaCandidateValid` 唯一权威）⑦ 不与地基级大结构重叠 ⑧ 占地判据边界精确 ⑨ region 裁剪 ⑩ 空岛让路 ⑪ 真实 GEN 落位（地板/偏移点/无 lava/无植被/基座实心底） | 注册进 `index.html`（check:data 双向钉） |
| Tier 2 | `check:data` 新环节：输入 nbt 指纹 + 产物（尺寸/格数/stride/floorRow/地板无 lava）契约 | `npm run check` |
| Tier 4 | `tests/burning-arena.spec.mjs`：飞到城东沙漠锚点，等 sections 稳定（world-stable 判据），读真实世界方块 + 截图**上下界双钉**（非纯黑 + 含暗红下界砖主色）；碗外斜看 + 碗内平视两机位 | `npm test` |
| 预算 | `npm run bench -- --check` + m3-fullscene 200MiB 门 | 实跑，不估算 |

## 5. 文件清单

新增：
- `tools/bake-burning-arena.mjs`、`tools/burning-arena-fingerprint.mjs`
- `assets/burning-arena/src/burning_arena{1..8}.nbt`（入库素材）
- `assets/structures/burning_arena.json` + `burning_arena.meta.json`（烘焙产物）
- `src/gen/structures/burning-arena.js`（锚点/占地判据/region 裁剪/地标压制）
- `src/gen/structures/burning-arena-data.js`（浏览器侧 VARIANTS 纯数据）
- `src/tests/test-burning-arena-gen.js`、`tests/burning-arena.spec.mjs`

修改：
- `package.json`（burningarena 脚本）、`src/gen/structures/structure-json.js`（注册）
- `src/gen/structures/structure-layout.js`（burningArena 字段 + 压制并集）
- `src/gen/structures/apply.js`（阶段 2.93 + 预载 + 撒布剔除 + pointContext 让路）
- `src/tests/index.html`（新测试注册）
- `tools/check-data.mjs`（新环节）
- `src/tests/test-tarn-zone.js`（零回归用例跳过大竞技场压制的字段）

删除：无（初版删的祭坛文件已全部恢复）

## 6. 风险与开放项

1. **cutout 预算**：DR-6 保险丝兜底，bench 实测为准。
2. **倒置台阶朝向**：`--census-orient` 实测 updown 变体后才算定稿（AGENTS.md：
   朝向映射只能用真实 mesher 实测定）。
3. 巨型金字塔烘焙的 `FACING_TO_ORIENT` 表可直接复用（同为「facing=高侧」口径），
   但 arena 的楼梯有 `shape=straight/inner/outer` —— 转角台阶统一映射为直台阶
   （pyramid 同款裁定），转角处允许轻微几何失真。
4. **初版祭坛落点已撤销**：飞龙/焰魔/祭坛全部原地不动，无遗留冲突（DR-7）。
