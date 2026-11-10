# 废弃堡垒移植实施计划（v2：含水约束 + 新烘焙方块）

> **状态：已实施完成（v2.89，2026-11-10）** —— Task 1~10 全部交付，待用户验收。
> 实施期按 census 实测修订了 6 处冻结数字（见 Task 3 Step 2 与 spec 头部修订注），
> 并把版本号从误标的 v2.86 改为 **v2.89**（v2.86/v2.87/v2.88 已被占用）。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> ## ⚠️ v2 修订（2026-11-10）
>
> 初版是纯重映射（方案 A，零新增方块）。用户追加两项需求后升级为**方案 B**：
> ① **地下部分不与水方块（含水面）相交** → 锚点判据强化为「占地 + 外扩 4 格全干燥」；
> ② **为高频缺失方块新烘焙 15 个方块**（9 整块/柱 + 6 台阶/半砖，复制 mod 自带贴图，进背包）。
> 虚空灯**不新烘**，映到现有 `ochre_froglight`（用户：「我不需要发光」= 不需要新发光方块）。
>
> 本文件取代 plan-mode 快照 `.pi/plans/2026-11-10-ruined-citadel-port.md`（那是 v1 口径）。

**Goal:** 把 Cataclysm 模组的 `ruined_citadel`（废弃堡垒，18 片 nbt，106×63×108，26 万格）烘焙进 mc-heavy，生成在 **City 西方最近的干燥沙漠**（必须且唯一），甲板与地表齐平、**44 层地下地牢完整保留**（空气格写进产物清出房间、**不与任何水相交**），新增 15 个照 mod 贴图烘焙的方块并进背包，加一个「堡垒」瞬移按钮。

**Architecture:** 复用 burning-arena 烘焙管线 + 既有方块注册管线：mod 贴图入库 → `npm run atlas`/`icons` 重打 → nbt 入库 → `tools/bake-ruined-citadel.mjs` 拼合 + 重映射 + 栏杆朝向 pass → palette+stride=5 结构 JSON（**含甲板以下空气格**）→ `structure-json.js` 加载 → `apply.js` 新阶段 2.94 在城西沙漠锚点光栅化（甲板层 = floorY）。锚点由 `ruined-citadel.js` 的 `computeRuinedCitadelAnchor` 给出（每 seed 恰好一个，确定性，**含干燥判据**）。

**Tech Stack:** Node 烘焙脚本（无新依赖）、浏览器内 Tier 1 单测、Playwright Tier 4、check:data 契约门、bench 预算门。

**Spec:** `docs/superpowers/specs/2026-11-10-ruined-citadel-port-design.md`

## Global Constraints

- **新烘焙方块 = 数据条目 + 贴图，不开新几何分支**：台阶/半砖复用 `cobblestone_step`/`cobblestone_step_updown`/`half_block` 模板；整块/柱用 `box`。
- 新方块**自动进背包**（物品集合是派生的：`registry.all() − 排除集合`），只需跑 `npm run icons`；**不要手改背包清单**。
- 未知源方块名**必须 throw**（`makeColumnSetter` 对未注册名字静默 return → 那格变 air）。
- `tools/*-fingerprint.mjs` 是 node 侧模块，**`src/**` 与浏览器单测禁止 import**（B1 白屏教训）。
- 结构注册名走派生不手写（红线 1）；`floorRow` 必须由产物显式提供。
- 台阶朝向只能用真实 mesher 实测定（`--census-orient`），不得从定义推。
- **空气格写进产物**（spec DR-2）：甲板以下（structure y<0）的 `minecraft:air` 写进 palette。甲板以上空气不写。
- **水约束**（spec DR-5/§2.10）：锚点判据含「占地 + 外扩 4 格每格 `generateHeight > SEA_Y`」，判据用 `generateHeight`（唯一权威），不得另写高度公式。
- **不裁切锥体**（用户裁定 ⑤）：产物保留全部 63 层，底部越界格由 `makeColumnSetter` 既有守卫自然丢弃。
- 工作区可能有**别的会话未提交的改动**：不碰、不暂存、`git add` 只按文件名加本任务文件。
- **提交须等用户明确指令**（AGENTS.md）。
- 冻结数字与实测不符时**停下来报告**，不擅自改断言。
  ⚠️ 例外：加 15 个方块**必然**改变 `test-block-registry`/`test-inventory`/`test-orientation` 的冻结计数，那是预期变更（按实测回填），不是「放宽阈值」。

## Review Focus

1. **空气格漏写**（spec DR-2 核心失效路径）：甲板以下空气若不写进产物，天然岩层会填满地牢 ⇒ 22.6 万格地牢白搬。格数/类型/指纹全对，只有挖下去才发现。→ Task 3 census 打印 air 格数 = 27,060；Task 6 check:data 断言；Task 4 单测断言「地牢房间格是 air」。
2. **水约束漏加或判据写错**（v2 新增）：若只判占地内干燥而不外扩 4 格，海面平面（y=-1.5，遮罩五点取样 ±3.5）会从湿邻居侵进占地 ⇒ 甲板下方出现假水天花板。→ Task 5 单测断言「占地+4 格全干燥」；负向验证 #3。
3. **城市净距判据方向**（spec §2.5 的坑）：本结构在城西，必须是 `wx + HALF_X >= city.minX - CLEARANCE → 拒绝`。照抄大竞技场城东那行会让 8/8 seed 全部找不到锚点（实测 9ms 就退出）。→ Task 5 单测；负向验证 #4。
4. **新方块漏注册某一个**：`makeColumnSetter` 静默 return ⇒ 那格变 air（墙上出现洞），而格数/指纹全对。→ Task 1 注册后跑 `npm run check`（引用完整性 + 物品集合关系式）；Task 6 断言产物 palette 全部 `REGISTRY.idOf` 有值。
5. **`end_stone_pillar` 误当细柱**：它是 `cube_column` = **完整正六面体**（顶/侧异图），不是 `vertical_pillar` 那种 0.3 宽细柱。用户「半粗石柱」是观感误解。→ Task 1 按 `geometry:'box'` + 六面贴图数组注册。
6. **倒置台阶朝向**：`half=top` 占 39%（1,537 格），不是边缘情况。→ Task 3 census-orient 实测后冻结。
7. **落位错层**：y 传错（忘了 `-(floorRow-1)`）→ 整座沉 44 格或浮 1 格。→ Task 4 单测断言「甲板层 = floorY 且其上为空气」。

---

### Task 1: 新方块注册（15 个）+ 贴图入库 + 重打图集

**Files:**
- Create: `assets/textures/`（+10 张 PNG，从 mod 复制）
- Modify: `src/voxel/blocks-data.js`（+15 方块条目）
- Modify: `src/voxel/faces-data.js`（+15 贴图映射）
- Modify: `assets/atlas.png` + `assets/atlas.json`（`npm run atlas` 重打）
- Modify: `assets/icons-atlas.png` + `assets/icons.json`（`npm run icons` 重烘）
- Modify: `src/tests/test-block-registry.js`、`src/tests/test-inventory.js`、`src/tests/test-orientation.js`（冻结计数按实测回填）

**Interfaces:**
- Produces（后续任务依赖）：15 个已注册方块名 + 其 faces-data 贴图映射；atlas 含 10 个新 tile。

- [ ] **Step 1: 复制 mod 贴图入库**

从 `~/jaylli/cataclysm1.19.2modding/src/main/resources/assets/cataclysm/textures/blocks/` 复制 10 张到 `assets/textures/`（逐字节原样，实测均为 16×16 不透明 PNG，`end_stone_pillar_top` 也是 16×16）：

```
obsidian_bricks.png  chiseled_obsidian_bricks.png  void_stone.png
end_stone_pillar.png  end_stone_pillar_top.png
chiseled_end_stone_bricks.png  polished_end_stone.png
void_infused_end_stone_bricks.png  chiseled_purpur_block.png  chorus_planks.png
```

⚠️ **不要复制 `void_lantern_block.png`**（16×80 动画贴图，且用户裁定不新烘发光方块）。
⚠️ end_stone_brick 族的台阶/半砖**复用本仓已有 `End_Stone_Bricks` tile**，零新增贴图。
⚠️ 命名沿用本仓惯例（首字母大写的 vanilla 风格 vs 小写的 mod 风格）—— 实施时看 `assets/textures/` 既有命名再定，保持一致；tile 名 = 文件名去 `.png`。

- [ ] **Step 2: 注册 15 个方块（`blocks-data.js`）**

9 个整块/柱（`geometry:'box'`，`cullMode:'opaque'`，`orientationModes:0`）：
`obsidian_bricks`、`end_stone_pillar`、`chiseled_end_stone_bricks`、`polished_end_stone`、
`chiseled_purpur_block`、`chorus_planks`、`chiseled_obsidian_bricks`、`void_stone`、
`void_infused_end_stone_bricks`

4 个台阶（`orientationModes:4`，`cullMode:'cutout'`，几何复用）：
`obsidian_brick_step`（geometry `cobblestone_step`）、`obsidian_brick_step_updown`（`cobblestone_step_updown`）、
`end_stone_brick_step`（`cobblestone_step`）、`end_stone_brick_step_updown`（`cobblestone_step_updown`）

2 个半砖（`cullMode:'cutout'`，`opaque:false`，geometry `half_block`，`orientationModes:0`）：
`obsidian_brick_slab`、`end_stone_brick_slab`

⚠️ **非 box 几何必须显式写 `"opaque":false`**（AGENTS.md：否则转换规则会按 cullMode 误推 opaqueTable=1）。参照既有 `sand_slab`/`cobblestone_step` 条目的写法逐字对齐。
⚠️ **`end_stone_pillar` 是整块不是细柱**（Review Focus #5）。

- [ ] **Step 3: 加贴图映射（`faces-data.js`）**

- 8 个单 tile 整块：`obsidian_bricks: 'obsidian_bricks'` 等（tile 名 = Step 1 的文件名）。
- `end_stone_pillar`：**六面数组**（面序 0:+X 1:-X 2:+Y 3:-Y 4:+Z 5:-Z）
  `['end_stone_pillar','end_stone_pillar','end_stone_pillar_top','end_stone_pillar_top','end_stone_pillar','end_stone_pillar']`
  （cube_column 语义：顶/底用 _top，四侧用 side。参照既有 `grass`/`sand` 的数组写法）
- 4 个台阶 + 2 个半砖：映射到各自族的 tile（`obsidian_brick_*` → `obsidian_bricks`；
  `end_stone_brick_*` → `End_Stone_Bricks`）。参照既有 `cobblestone_step: 'Cobblestone'` /
  `sand_slab: ['sand_side',...]` 的口径。

- [ ] **Step 4: 重打图集与图标**

```bash
npm run atlas
npm run icons
```
Expected: atlas tile 数 163 → 173（+10）；icons 覆盖新增 15 项。
⚠️ **atlas 重打会移动所有 tile 的 UV**（shelf 装箱）—— 运行期从 `atlas.json` 读、单测用派生假 atlas，故安全；但**必须重跑全量单测**确认无 UV 硬编码。
⚠️ 不带 `--check` 的 bench 会重写基线（AGENTS.md 明令禁止）—— 本 Task 不跑 bench。

- [ ] **Step 5: 回填冻结计数（按实测，不是按推算）**

Run: `npx playwright test tests/harness.spec.mjs` → 读失败信息里的实际值，回填：
- `test-block-registry.js`：`reg.count === 139` → **154**（推算值，以实测为准）
- `test-inventory.js`：`registry.all() 139 条` → **154**
- `test-orientation.js`：`disabled.length === 98` → **109**（+11：9 整块 + 2 半砖都是 orientationModes=0；4 个台阶是 4 不计入）

⚠️ 实测与推算不符 → **停下报告**（可能某个方块的 orientationModes 写错了）。

- [ ] **Step 6: 验证**

Run: `npm run check`
Expected: 三门全绿。`[引用完整性]` 会校验 faces-data 引用的 tile 都在 atlas 里（漏复制 PNG 会在这里红）；`[物品集合]` 关系式自动跟上（15 个新方块进背包）；`[图标]` 指纹比对会抓「忘跑 icons」。

- [ ] **Step 7: Commit（等用户指令）**

```bash
git add assets/textures src/voxel/blocks-data.js src/voxel/faces-data.js assets/atlas.png assets/atlas.json assets/icons-atlas.png assets/icons.json src/tests/test-block-registry.js src/tests/test-inventory.js src/tests/test-orientation.js
git commit -m "feat(blocks): 新增 15 个废弃堡垒方块（照 mod 贴图烘焙，进背包）"
```

---

### Task 2: 素材入库 + 指纹共享模块

**Files:**
- Create: `assets/ruined-citadel/src/ruined_citadel{1..18}.nbt`（共 1.4MB）+ `README.md`
- Create: `tools/ruined-citadel-fingerprint.mjs`

**Interfaces:**
- Produces：`RUINED_CITADEL_SOURCE_DIR`、`RUINED_CITADEL_PIECES`（18 片偏移，spec §2.1）、
  `RUINED_CITADEL_JSON`/`_META`、`RUINED_CITADEL_VARIANTS`、`BLOCK_MAP`（spec DR-4）、
  `SLAB_BASE`、`FLOOR_ROW = 45`、`RUINED_CITADEL_METRICS`（Task 3 census 后冻结）、
  `ruinedCitadelInputFingerprint()`、re-export `FACING_TO_ORIENT`。

- [ ] **Step 1: 复制 18 片 nbt 入库**

```bash
mkdir -p assets/ruined-citadel/src
cp /Users/bachi/jaylli/cataclysm1.19.2modding/src/main/resources/data/cataclysm/structures/ruined_citadel{1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18}.nbt assets/ruined-citadel/src/
```

`README.md`：出处（L_Ender's Cataclysm mod, MC 1.19.2）、仅数据无代码、用途（烘焙输入）。
⚠️ **不得放进 `assets/textures/`**（`build-atlas` 递归扫描该目录 → 会变成巨型 tile）。

- [ ] **Step 2: 写 `tools/ruined-citadel-fingerprint.mjs`**

头注释照抄 `burning-arena-fingerprint.mjs` 口径（node 侧、src 禁 import、唯一权威）。
`BLOCK_MAP` 按 **spec DR-4 总表**逐条定稿（每条理由写进注释）。要点：
- 9 个整块/柱 → Task 1 新注册的同名方块；
- `cataclysm:void_lantern_block` → `ochre_froglight`（**不新烘**，用户裁定）；
- `purpur_block`/`purpur_pillar`/`purpur_void_rune_trap_block` → `deepslate`（v2.90 用户裁定，原 `amethyst`）；
- `purpur_stairs`/`polished_end_stone_stairs`/`chorus_stairs` → 走 classify 台阶分支映 `stone_diorite_step`；
- `crying_obsidian`/`obsidian_explosion_trap_bricks` → `obsidian`；
- `end_stone_teleport_trap_bricks`/`chiseled_end_stone_bricks`→ 见 DR-4（前者映 end_stone_bricks，后者**新烘**）；
- 4 种墙/栅栏 → `handrail`（朝向 pass 处理，**BLOCK_MAP 目标值保持 `handrail` 不动**，它是 `RAIL_SOURCES` 反查依据）；
- `chorus_plant`→`vine`、`chorus_flower`→`allium`、`end_rod`→`vertical_pillar`、
  `purple_stained_glass_pane`→`glass_block`、`ender_chest`→`chest`、`shulker_box`→`orange_shulker_box`、
  `lantern`→`hanging_lamp`；
- 地毯/活板门/花盆/拉杆/绊线钩/木桶/`structure_block`/`altar_of_void` → `''`（丢弃）。

⚠️ **台阶（`/_stairs$/`）与半砖（`/_slab$/`）不进 BLOCK_MAP**，由 classify 分支处理（塞进表里会让分支永远走不到 → 静默丢朝向）。

**`SLAB_BASE`**（显式表，**不得剥后缀查 BLOCK_MAP**）：
```
cataclysm:obsidian_brick_slab     → obsidian_bricks
end_stone_brick_slab              → end_stone_bricks
purpur_slab                       → deepslate
cataclysm:polished_end_stone_slab → polished_end_stone
```

`RUINED_CITADEL_METRICS` 先留占位注释「Task 3 census 后填」。

- [ ] **Step 3: 冒烟验证**

Run: `node -e "import('./tools/ruined-citadel-fingerprint.mjs').then(m => console.log(m.ruinedCitadelInputFingerprint().input))"`
Expected: 打印 `<sha16>:<sha16>`，无异常。

- [ ] **Step 4: Commit（等用户指令）**

```bash
git add assets/ruined-citadel/src tools/ruined-citadel-fingerprint.mjs
git commit -m "feat(ruined-citadel): 烘焙素材入库 + 映射表/指纹共享模块"
```

---

### Task 3: 烘焙脚本 + 产物（Tier 2）

**Files:**
- Create: `tools/bake-ruined-citadel.mjs`
- Modify: `package.json`（加 `"ruinedcitadel": "node tools/bake-ruined-citadel.mjs"`）
- Modify: `tools/ruined-citadel-fingerprint.mjs`（census 后冻结 METRICS）
- Create: `assets/structures/ruined_citadel.json` + `.meta.json`

**Interfaces:**
- Consumes: Task 1 的 15 个新方块名、Task 2 全部导出、`tools/nbt-reader.mjs`、`arena.js` 的 `railPlacementFor`/`railArmSet`。
- Produces: `ruined_citadel.json`（`{version:1, stride:5, floorRow:45, palette:[...含 'air'...], blocks:[x,y,z,pi,dir,...]}`）。

- [ ] **Step 1: 写烘焙脚本**

照抄 `bake-burning-arena.mjs` 三段式（`--census` / `--census-orient` / 默认 bake）：
- **拼合**：逐片 `gunzipSync` + `NbtReader`，按 `RUINED_CITADEL_PIECES` 偏移累加；
  **保留空气格**（`minecraft:air` 不跳过，记为 `{name:'air'}`）；`structure_block`/`altar_of_void` 计入 droppedCells 后丢弃。
- **classify**（→ `{block, meta}|null`）：
  - **air 分支**（spec DR-2）：`name==='air'` 且 structure y < 0（甲板以下）→ `{block:'air',meta:0}`；
    y ≥ 0（甲板以上，天空）→ `null`；
    ⚠️ 判据用**组装后的 structure y**（不是归一化 ny），与 spec 表述一致；实施时二者等价（ny = y+46，y<0 ⟺ ny<46 = FLOOR_ROW），选一个并注释清楚。
  - 直查 `BLOCK_MAP`（空串 → null）；
  - `/_stairs$/`：按源名分流 —— `cataclysm:obsidian_brick_stairs` → `obsidian_brick_step(_updown)`；
    `end_stone_brick_stairs` → `end_stone_brick_step(_updown)`；其余（purpur/polished_end_stone/chorus）→ `stone_diorite_step`。
    `half==='bottom'` → 正台阶 + `meta = FACING_TO_ORIENT[facing]`；
    `half==='top'` → 对应 `_updown` + `meta = (FACING_TO_ORIENT[facing] + 2) % 4`
    （**以 Step 2 实测为准，不符则改这里**）；`shape` inner/outer 统一按直台阶；facing 缺失/未知 → throw；
    ⚠️ **`stone_diorite_step` 没有 updown 变体**（本仓只有 `cobblestone_step_updown` 与 `planks_step_updown`）
    ⇒ purpur/polished_end_stone/chorus 的 top 台阶只能映 `cobblestone_step_updown`（灰 cobble 贴图）。
    这是已知观感代价，写进注释。
  - `/_slab$/`：查 `SLAB_BASE[bn]` 拿基础整块名（**不剥字符串**）；
    `type==='bottom'` → 新半砖（obsidian_brick_slab / end_stone_brick_slab）或 `sand_slab`（无新半砖的族）；
    `type==='top'`/`'double'` → `SLAB_BASE[bn]` 整块；未收录 → throw；
  - 其余未命中 → throw（列出源名）。
- **栏杆朝向 pass**：从 `bake-burning-arena.mjs` 移植 `computeRailOrientations`，
  `inwardArms` 的中心改为结构中心 **(17, 18)**（spec §2.2：中心 x=17 z=18.5 取整）。
- **输出**：x/z 减中心偏移、y 归一化 minY→1；stride=5 第 5 项写 meta；`floorRow: 45` 写 JSON 顶层。
- **`--census`**：打印 53 种源名逐名格数、映射结果、未覆盖项（有则 throw）、包围盒、
  **air 格数（甲板以下）**、通道分布（用 `REGISTRY.cullTable`，**不要正则扫 blocks-data 源码**）。
- **`--census-orient`**：用**真实注册的台阶方块**（从 `STAIR_TARGETS` 收集，不手写清单：
  obsidian_brick_step / _updown、end_stone_brick_step / _updown、stone_diorite_step、
  cobblestone_step_updown 共 6 个），各测 orient 0~3 高侧方向；验证「+2 mod 4」。
  ⚠️ 不注册临时探针方块（计划初稿的写法）：Task 1 已把四个新台阶真实注册，直接测它们
  比测「几何同名的探针」更强（能同时抓到 faces-data/geometry 声明写错）。
- ⚠️ **必须判 main module**（`import.meta.url === file://${process.argv[1]}`）。

- [ ] **Step 2: 跑 census 与 census-orient，冻结数字**

Run: `npm run ruinedcitadel -- --census` → 预期（探针已实测）：
- 53 种源名 **0 未覆盖**、facing 缺失 **0**；
- 非空气包围盒 **106×63×108**、非空气 **261,775**、dropped **11**（structure_block 10 + altar_of_void 1）；
- **air 格数 = 27,060**（甲板以下）、**contentCells = 288,744**、floorRow **45**；
  ⚠️ contentCells = 261,775 − **91 丢弃**（功能标记 11 + 无几何薄件 80）+ 27,060 空气。
  spec 初稿 288,835 一个丢弃都没减；中途修订值 288,824 只减了功能标记、漏减 80 个薄件。
  以 census 实测 288,744 为准；
- **产物包围盒 107×63×110**（x∈[-36,70]，z∈[-37,72]）—— 甲板下空气比非空气 bbox 各撑出 1 格；
  ⚠️ **footprint 仍用非空气 bbox 106×108（HALF_X/HALF_Z = 53/54）**，多出的 1 格空气在 y=-45
  地下，不进 footprint ⇒ §2.5 的 8 seed 锚点表全部有效，无需重测；
- 台阶合计 **3,916**（bottom 2,379 / top 1,537）；半砖合计 **3,277**（bottom 46 / top **1,356** / double 1,875）；
  ⚠️ 半砖三态逐族相加（spec §2.7 表）：bottom = 2+20+16+8 = **46**、top = 48+1,076+224+8 = **1,356**、
  double = 1,801+2+72+0 = **1,875**，三者相加 = 3,277 = 半砖合计（原写 top 1,406 会使相加得 3,327 ≠ 合计）；
- 墙栏 **708**；甲板层（ny=45）**8,197** 格（产物口径，含 1 格空气竖井；覆盖率 71.6%）；
- 通道分布（实测）：opaque **256,866** / cutout **4,810** / transparent **8** / none **27,060**（air）；
- palette **34** 种（含 air + handrail + handrailA）；
- 新方块格数：obsidian_bricks 9,134 / end_stone_pillar 1,029 / chiseled_end_stone_bricks 451 /
  polished_end_stone 200 / chiseled_purpur_block 156 / chorus_planks 126 /
  chiseled_obsidian_bricks 122 / void_stone 122 / void_infused_end_stone_bricks 81 /
  ochre_froglight 134。

Run: `npm run ruinedcitadel -- --census-orient` → 预期：正台阶与 `FACING_TO_ORIENT` 一致；updown 高侧 = 正台阶 +180°。
**实测结果（2026-11-10）**：6 个台阶方块 × 4 个 orient 全部 ✓（含 4 个 Task 1 新烘台阶，
其朝向语义与既有 cobblestone_step 完全一致）。
**实测与预期不符 → 停下报告**。把 census 输出填进 `RUINED_CITADEL_METRICS`。

- [ ] **Step 3: 烘焙产物**

Run: `npm run ruinedcitadel`
Expected: 生成 `assets/structures/ruined_citadel.json`（3.70MB）+ meta。
抽查：`stride===5`、`floorRow===45`、**palette 含 `air`**、blocks 长度 = contentCells×5、
palette 全部 `REGISTRY.idOf` 有值。

- [ ] **Step 4: Commit（等用户指令）**

```bash
git add tools/bake-ruined-citadel.mjs tools/ruined-citadel-fingerprint.mjs package.json assets/structures/ruined_citadel.json assets/structures/ruined_citadel.meta.json
git commit -m "feat(ruined-citadel): 烘焙脚本与产物（18 片拼合 + 重映射 + 空气格）"
```

---

### Task 4: Tier 1 单测（RED）

**Files:**
- Create: `src/tests/test-ruined-citadel-gen.js`
- Modify: `src/tests/index.html`（加 import 一行）

**Interfaces:**
- Consumes: `loadStructure`/`STRUCTURE_FILES`/`floorRowOf`、`computeRegionLayout`、`applyStructuresToColumn`、`fillColumn`、`buildDefaultRegistry`、`ChunkColumn`、`blockIndex`、`getCityBoundsForSeed`、`getBiome`、`generateHeight`、`SEA_Y`。
- Produces: 供 Task 5 GREEN 的失败用例集。

- [ ] **Step 1: 写失败测试**（手法照抄 `test-burning-arena-gen.js`）

用例清单（断言值来自 spec §2 冻结数字）：
1. `STRUCTURE_FILES.ruinedCitadel === 'ruined_citadel.json'`；
2. 产物加载：blocks 非空、x 跨度 106、z 跨度 108、y 跨度 63（minY=1,maxY=63）、`floorRowOf === 45`；
3. **palette 含 `air` 且 air 格数 = 27,060**（spec DR-2 唯一守卫）；
4. **锚点必须且唯一**：逐 seed（≥3 个）非 null、确定性（二次调用同值）；
5. **在城西且净距 ≥ `CITY_TRANSITION_SIZE`**：`anchor.wx + HALF_X < city.minX - CLEARANCE`；
6. **水约束**：占地 **+ 外扩 4 格**每格 `generateHeight > SEA_Y`（逐格实测，不是只查锚点）；
7. 占地全 DESERT + 高于海平面（转调 `ruinedCitadelCandidateValid`，红线 1）；
8. 高差在放宽档内（`anchor.span <= RUINED_CITADEL_MAX_SPAN`）；
9. **是「最近」的那个**（转调 `ruinedCitadelCandidateValid` 判更近的点都不合法，**多 seed**）；
10. 不与地基级大结构重叠（含**大竞技场**）；
11. `inRuinedCitadelFootprint` 边界精确（内一格 true / 外一格 false）；
12. `ruinedCitadelOverlapsRegion` 让跨 region 占地被邻区携带；
13. `ruinedCitadelSuppressedLandmarks` 对占地内地标返回 true；
14. **真实 GEN 落位**（`fillColumn + applyStructuresToColumn`，需 preload）：
    - 甲板层（floorY）是 **end_stone 系**（非 air）；甲板上方一格是 air（可站）；
    - **地牢某房间格是 air**（取虚空祭坛 (19,-15,16) 附近一个已知空气坐标 → 世界坐标）；
    - **虚空灯位是 `ochre_froglight`**（取一个已知 void_lantern 坐标）；
    - 占地内无植被（`pointContext` 返回 `kind:'none'`）；
    - **占地内无 water 方块**（水约束的 GEN 级守卫）；
    - 底部越界格被裁（世界 y < -32 不存在）；
15. **瞬移落点逐值**：`ruinedCitadelTeleportPoint(seed)` 在占地东缘外、y = 自然地表 + 1。

- [ ] **Step 2: 注册进 index.html 并跑，确认 RED**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: **harness 红**。
⚠️ **漏注册 = 静默不跑（全绿假象）**：判 RED 前先用一次性探针 spec（`tests/tmp-*.spec.mjs`，已 gitignore）读 `results.suites.flatMap(s => s.tests)` 确认能看到新用例名且状态 fail。

- [ ] **Step 3: Commit（等用户指令）**

```bash
git add src/tests/test-ruined-citadel-gen.js src/tests/index.html
git commit -m "test(ruined-citadel): Tier 1 接线用例（RED）"
```

---

### Task 5: 运行期接线（GREEN）

**Files:**
- Create: `src/gen/structures/ruined-citadel-data.js`、`src/gen/structures/ruined-citadel.js`
- Modify: `src/gen/structures/structure-json.js`、`structure-layout.js`、`apply.js`
- Modify: `src/workers/world-worker.js`
- Modify: `src/gen/structures/burning-arena.js`（**只加注释**：单向避让说明，spec 风险 5）

**Interfaces:**
- Consumes: Task 3 产物、Task 4 测试集。
- Produces: 全绿的 Task 4 用例。

- [ ] **Step 1: 写 `ruined-citadel-data.js`**（浏览器侧纯数据，零 node 依赖）

```js
export const RUINED_CITADEL_VARIANTS = Object.freeze(['ruinedCitadel']);
export const RUINED_CITADEL_HALF_X = 53;   // 106 宽
export const RUINED_CITADEL_HALF_Z = 54;   // 108 深
```
⚠️ 头注释写明「必须与 fingerprint 模块的 VARIANTS/METRICS 一致，check:data 双向钉住」。

- [ ] **Step 2: 写 `ruined-citadel.js`**（照抄 `burning-arena.js` 结构，方向改城西 + 加干燥判据）

导出常量：`RUINED_CITADEL_HEIGHT = 63`、`_MAX_SPAN = 5`、`_SPANS = [4,5,6,8]`、
`_MAX_GAP = 2400`、`_TELEPORT_GAP = 6`、`_DRY_MARGIN = 4`（= ceil(OCEAN_MASK_OFFSET 3.5)）、
`SEARCH_HALF_Z = 900`、`COARSE_STEP = 8`。

导出函数：
- `computeRuinedCitadelAnchor(seed)`（memo + `clearRuinedCitadelCache()`）
  ⚠️ **城市净距方向**：`wx + HALF_X >= city.minX - CITY_CLEARANCE → 拒绝`（城西！Review Focus #3）
  ⚠️ **干燥判据**：`exactFootprint` 扫 **占地 ± (HALF+DRY_MARGIN)**，每格 `generateHeight > SEA_Y`；
    biome/高差判据仍只扫占地本身（外扩那圈只判干燥，不要求 DESERT）。注释引 spec §2.10 的两处水源。
  ⚠️ **粗筛 `giX`/`giZ` 分开算**（半宽 53/54 不同）；用 `floor` 不用 `ceil`；网格外扩 `gi` 格；
    粗筛的干燥判据也要覆盖外扩 4 格（粗筛是精检的必要条件，不能更严也不能漏判）。
  ⚠️ **避让项**：城市 / 高台地带 / 浅水高台 / 围场 / **大竞技场**。
- `ruinedCitadelCandidateValid(wx,wz,span,seed)`（**export 供单测复用**，红线 1）
- `inRuinedCitadelFootprint(wx,wz,anchors)`
- `ruinedCitadelSuppressedLandmarks(anchor,rx,rz,seed)`（廉价距离门 + 圆↔矩形相交）
- `ruinedCitadelOverlapsRegion(anchor,rx,rz)`
- `ruinedCitadelTeleportPoint(seed)`（落点在占地**东缘**外，y = `generateHeight + 1`）

- [ ] **Step 3: structure-json.js 注册**（从 VARIANTS 派生，同 burning-arena 手法）

- [ ] **Step 4: structure-layout.js 接线**

加 `ruinedCitadel` 字段 + 压制项并入既有并集。
⚠️ 压制写成 `cond ? null : <原表达式>`，**保留原表达式求值位置与顺序** ⇒ 零回归。
⚠️ 雪原压制不在 layout 层做（走 apply 阶段 1 跳过门）。

- [ ] **Step 5: apply.js 接线**

- 预载：`if (layouts.some((l) => l.ruinedCitadel)) needTypes.add('ruinedCitadel');`
- 撒布剔除（阶段 2.7）：`inRuinedCitadelFootprint`。
- `pointContext` 让路：占地返回 `kind:'none'`（转调 `inRuinedCitadelFootprint`）。
- 新阶段 2.94（阶段 2.93 之后、阶段 2.5 之前）：

```js
for (const layout of layouts) {
  const rc = layout.ruinedCitadel;
  if (!rc) continue;
  if (!placementIntersects({ x: rc.wx, z: rc.wz }, RUINED_CITADEL_HALF_X, RUINED_CITADEL_HALF_Z, column.cx, column.cz)) continue;
  const rcFloorRow = floorRowOf('ruinedCitadel');
  rasterizeStructure('ruinedCitadel', rc.wx, rc.floorY - (rcFloorRow - 1), rc.wz,
    setBlock, column, registry, seed, false);
}
```
⚠️ **不需要「清空地表凸起」步骤**（大竞技场阶段 2.93 的 ① 是因为碗内要平整）：
本结构甲板以下全是实心/房间，直接光栅化即可；但**要确认**甲板层是否会与沙漠沙丘冲突
（span≤5 ⇒ 最多 5 格起伏，甲板在 floorY=占地最低高度 ⇒ 沙丘会高出甲板）。
**实施时实测**：若沙丘从甲板里冒出来，补一段与大竞技场 ① 同款的清空循环（`floorY+1..naturalH`）。
⚠️ **性能**：每相交 column 遍历 288,744 格，~49 column ⇒ ~14M 次 setBlock，GEN Worker 内每 seed 一次。

- [ ] **Step 6: world-worker.js 预热**

`layout` 入口加 `computeRuinedCitadelAnchor(p.seed);`（注释说明「不落进 GEN 计时路径」，
实测首次 ~1000ms）。

- [ ] **Step 7: burning-arena.js 加注释**（单向避让说明，spec 风险 5；**不改逻辑**）

- [ ] **Step 8: 跑单测确认 GREEN**

Run: `npx playwright test tests/harness.spec.mjs` → 全绿（`failed === 0`）
Run: `npm run check` → 三门全绿

- [ ] **Step 9: Commit（等用户指令）**

```bash
git add src/gen/structures/ruined-citadel-data.js src/gen/structures/ruined-citadel.js src/gen/structures/structure-json.js src/gen/structures/structure-layout.js src/gen/structures/apply.js src/workers/world-worker.js src/gen/structures/burning-arena.js
git commit -m "feat(ruined-citadel): 城西干燥沙漠生成废弃堡垒，地牢完整保留且不与水相交"
```

---

### Task 6: check:data 契约环节（Tier 2）

**Files:**
- Modify: `tools/check-data.mjs`（新函数 `checkRuinedCitadel()` + 主流程显式调用行）

- [ ] **Step 1: 写 `checkRuinedCitadel()`**（照抄 `checkBurningArena` 骨架）

断言：① 输入 18 片与产物存在；② 指纹匹配；③ `stride === 5`；④ palette 全部 `REGISTRY.idOf` 有值；
⑤ **palette 含 `air`**；⑥ 产物包围盒 107×63×110 且 minY=1；⑦ `floorRow === 45` 且甲板层格数 = 8,197；
⑧ 格数 = contentCells（288,744）；⑨ **air 格数 = 27,060**（DR-2 内容级判据，指纹拓不到）；
⑩ `STRUCTURE_FILES.ruinedCitadel === 'ruined_citadel.json'`；⑪ 通道分布（用 `REGISTRY.cullTable`）；
⑫ 两侧 VARIANTS 一致；⑬ 半宽与 `ruined-citadel-data.js` 一致（**X/Z 分别比**，本结构不是正方形）；
⑭ **15 个新方块都在 registry + 都在背包物品集合内**（用户裁定「新制作的方块加入背包」）；
⑮ 台阶/栏杆朝向分布逐档比对（部分堵上「只改烘焙算法而指纹不变」的盲区）。
成功行涵盖全部判据。

- [ ] **Step 2: 主流程加显式调用行**（`await checkBurningArena();` 附近，带「漏了本行则门禁永不执行」注释）

- [ ] **Step 3: 验证**

Run: `npm run check:data` → Expected: `[废弃堡垒] ...` 信息行，退出码 0。

- [ ] **Step 4: Commit（等用户指令）**

```bash
git add tools/check-data.mjs
git commit -m "test(ruined-citadel): check:data 契约环节（指纹/air 格数/新方块进背包/朝向分布）"
```

---

### Task 7: UI 瞬移按钮

**Files:**
- Modify: `src/ui/settings-panel.js`、`src/core/game.js`、`src/tests/test-ui.js`、`tests/teleport.spec.mjs`

- [ ] **Step 1: settings-panel.js**

加 `export const TELEPORT_CITADEL_LABEL = '堡垒';`，`_rowTeleport()` 第 8 个按钮：
```js
mk(TELEPORT_CITADEL_LABEL, 'btn-teleport-ruined-citadel', () => {
  this._teleportThenAutoClose(this.game.teleportToRuinedCitadel());
});
```
⚠️ **布局实测**：8 按钮 + `gap:4px` ⇒ 每只 ~44px、内容宽 ~32px，2 字（24px）理论放得下。若折行 → `gap` 收到 2px。

- [ ] **Step 2: game.js**

`teleportToRuinedCitadel()`（照抄 `teleportToBurningArena`，落点转调 `ruinedCitadelTeleportPoint`，
kind `ruined-citadel`，reason `no-ruined-citadel`）。

- [ ] **Step 3: 瞬移落点 8 seed 普查**（spec DR-9 的要求）

用 node 探针查缘外那一点：是否 DESERT、高于海平面、周围 5×5 高差、是否落进浅水高台整形区/城市 bounds。
结论写进 `ruinedCitadelTeleportPoint` 的注释（照抄 `burningArenaTeleportPoint` 的注释口径）。

- [ ] **Step 4: test-ui.js + teleport.spec.mjs**

`test-ui.js`：8 按钮常量数组。
`teleport.spec.mjs`：新按钮用例（落点在占地东缘外、y = 自然地表+1）+ **8 按钮不折行判据**
（`offsetTop` 判不得换行、**行盒数**判文案不得折行；⚠️ `scrollWidth <= clientWidth` 对折行无判别力）。

- [ ] **Step 5: 跑**

Run: `npx playwright test tests/teleport.spec.mjs` → PASS

- [ ] **Step 6: Commit（等用户指令）**

```bash
git add src/ui/settings-panel.js src/core/game.js src/tests/test-ui.js tests/teleport.spec.mjs
git commit -m "feat(ruined-citadel): 设置面板加「堡垒」瞬移按钮"
```

---

### Task 8: Tier 4 像素验收

**Files:**
- Create: `tests/ruined-citadel.spec.mjs`

- [ ] **Step 1: 写 spec**

流程：开游戏 → `page.evaluate` 取 `computeRuinedCitadelAnchor(seed)` → 瞬移到堡垒外看全景 →
**等世界稳定（sections 停止增长 + 三条队列归零）** → 截图 A；再瞬移进地牢房间截图 B。
断言（**上下界双钉**）：
- A/B 均非纯黑（均值 > 噪声底）且非全同色（标准差 > 阈值）；
- A 含末地石主色（浅黄系 rgb ~218,221,157）；
- **B（地牢内）亮度 > 阈值**（ochre_froglight 照明生效，不是全黑 —— 这是「地牢可玩」的像素级证据）；
- **B 不含水体主色**（水约束的像素级证据）。
**先测同状态重复截图的噪声底再定阈值**。
⚠️ 必要时 `renderer.setAnimationLoop(null)` 冻结帧循环（大竞技场 v2.83 教训）。

- [ ] **Step 2: 跑**

Run: `npx playwright test tests/ruined-citadel.spec.mjs` → PASS

- [ ] **Step 3: Commit（等用户指令）**

```bash
git add tests/ruined-citadel.spec.mjs
git commit -m "test(ruined-citadel): Tier 4 像素验收（堡垒外观 + 地牢有光无水）"
```

---

### Task 9: 预算门

- [ ] **Step 1: 跑预算门**

Run: `npm run bench -- --check`（⚠️ 不带 --check 会重写基线；frameP95 贴线用交替对照判定；**不可与回归并发**）
Run: `npx playwright test tests/m3-fullscene.spec.mjs`（200 MiB 门）
Expected: 出生点在城市、冲刺从森林/海岸起步，不含本结构视域 → 理论不受影响；**以实测为准**。

- [ ] **Step 2: 保险丝（仅当 cutout 峰值恶化 > 5pp）**

把墙/栅栏族（708 格）改映整块 → 重烘 → 更新 METRICS → 重跑相关断言。**触发即报告用户**（观感降级）。
⚠️ 台阶族（3,916 格）**不进保险丝**：降级成整块会丢掉楼梯可走性。

---

### Task 10: 全量回归 + 交付

- [ ] **Step 1: 全量**

Run: `npm run check` + `npm test`
Expected: 全绿。红的 spec 先判是否本改动引起（逐文件回退二分，或读失败信息定位）。
⚠️ **atlas 重打可能影响既有像素类 spec**（city-visual / tarn-altar / burning-arena 等）——
若出现，先确认是 UV 移动导致的阈值漂移还是真缺陷，**不擅自放宽阈值**，报告用户。

- [ ] **Step 2: 负向验证**（spec §5 的 9 条清单，每条 `cp` 副本还原 + sha256 核对，
  **禁止对含未提交改动的文件用 `git checkout`/`restore`**）

- [ ] **Step 3: 更新文档**

`docs/roadmap.md` 版本表新行 + `AGENTS.md` 路由表（「废弃堡垒」条目）+ 坑清单（若有新教训：
城西方向判据、air 格写产物、水约束外扩 4 格、pillar 是整块不是细柱）。

- [ ] **Step 4: 汇报**

交付物清单 + 实测数字（contentCells、air 格数、15 个新方块格数、cutout 峰值、截图）+
已知开放项（甲板入口连通性、purpur 族映 deepslate 的色差、stone_diorite_step 的色差）。
**提交等用户指令**。
