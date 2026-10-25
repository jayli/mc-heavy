# 巨型金字塔验收报告（Giant Pyramid Epic）

日期：2026-10-25
规格：`docs/superpowers/specs/2026-10-25-giant-pyramid-design.md`
计划：`docs/superpowers/plans/2026-10-25-giant-pyramid.md`
素材：`Small Pyramid Maze.litematic`（用户提供 → 入库 `assets/giant-pyramid/src/small_pyramid_maze.litematic`）

---

## 1. 交付内容

沙漠里一座 49×25×49 的**沙子系巨型金字塔迷宫**，平均每 2 块沙漠出现 1 座，
不与城市 / 地标 / 空岛 / 巨树 / 高台 / 其它撒布结构重合。

| 类别 | 文件 |
|---|---|
| 烘焙输入（入库） | `assets/giant-pyramid/src/small_pyramid_maze.litematic`（5.6 KB） |
| 烘焙产物 | `assets/structures/giant_pyramid.json`（158.9 KB）+ `.meta.json` |
| 烘焙工具 | `tools/litematic-reader.mjs` / `tools/giant-pyramid-fingerprint.mjs` / `tools/bake-giant-pyramid.mjs`（`npm run pyramid`） |
| 落点候选 | `src/gen/structures/giant-pyramid.js` |
| 接线 | `structure-layout.js`（layout 字段）/ `apply.js`（阶段 2.76 + `pointContext` + 阶段 2.7 剔除）/ `world-worker.js`（城市 bounds 预热） |
| 新方块 | `sand_step`（`planks_step` 几何）/ `sand_slab`（`half_block` 几何）—— **零新增几何与贴图** |
| 数据门 | `tools/check-data.mjs` 的 `[巨型金字塔]` 环节 |
| 测试 | `src/tests/test-giant-pyramid.js`（18 用例）/ `test-giant-pyramid-gen.js`（5 用例）/ `tests/giant-pyramid.spec.mjs`（4 用例） |

---

## 2. 素材实测（不是读格式推断）

| 项 | 实测值 |
|---|---|
| 尺寸 | 49 × 25 × 49（`Metadata.EnclosingSize`；`Region.Size` 是负数） |
| 非空气格 | 17966 == `Metadata.TotalBlocks`（**精确相等** ⇒ 位打包 / 索引序口径正确） |
| 分类 | air 42059 / barrier 1759 / smooth_sandstone 14982 / stairs 1219 / slab 6 |
| 实心合计 | **16207** |
| 台阶朝向 | orient 0/1/2/3 = 305/303/305/306（几乎均匀） |
| 结构特征 | 中空、顶部敞开的迷宫；空气格「上方有实心」= **0**（无拱顶）；无箱/实体/tick |
| 迷宫连通（原模型数据，本仓整格口径） | 可站立 2400 / 外圈可达 2364 = **98.5%**（36 格高层死角） |
| 迷宫连通（原版半格口径） | 4798 / 4798 = 100% |

---

## 3. 偏离表

| # | 偏离 | 理由 | 实测影响 |
|---|---|---|---|
| ① | 转角台阶（63 格，0.39%）→ 直台阶近似 | 本仓 `TEMPLATES` 只有 L 形直台阶；新造转角几何需自己定义形状（属「按 Minecraft 定义推断」，违本仓纪律） | 路口内侧缺 0.5³ 的角 |
| ② | `barrier` 1759 格 → 空气 | 本仓无对应方块 | 实测**没有一格**「若当空气会构成可站立通道」（0/1759）⇒ 不影响可走性 |
| ③ | `smooth_sandstone*` → `sand`/`sand_step`/`sand_slab` | 用户要求「用沙子方块构建」；本仓无砂岩方块 | 观感为纯沙材质 |
| ④ | 1× 原尺寸（不放大） | 用户裁定；2× 会让塔顶 y≈58 穿云（云在 y=35/55） | 塔顶世界 y ≤ 33，不穿云 |
| ⑤ | 落点走 region 级候选（非逐点撒布，与 `desertPyramid` 不同） | 49×49 占地需要间距护栏；逐点撒布实测过「一块沙漠 2~4 座、最近一对仅隔 32 格」 | — |
| ⑥ | 占地高差 ≤4 允许埋没底部 ≤4 层 | 「宁可埋没不悬空」；全是沙子，埋没观感无差 | 31% region 可用（≤2 只 15%、≤8 有 83%） |
| ⑦ | `double` 半砖 → 整格沙；`bottom` 半砖 → `sand_slab` | `half_block` 模板只有下半 | 塔尖唯一的那格用 `sand_slab` |
| ⑧ | 台阶/半砖在**碰撞上按整格**（本仓物理口径） | 本仓 `world.isSolid` 读 `solidTable`，不给台阶做半格碰撞 | 36 格高层死角玩家走不到（见 §6 已知限制） |

---

## 3b. 台阶朝向修复（2026-10-25 用户实玩反馈后的补丁）

### 用户诉求

> 「我的这个游戏的设计是台阶方块都是有方向的，可以朝向东南西北四个方向…比如朝东的坡面上的
> 台阶沙块就是朝向东侧（假设台阶凹口朝向东侧）。请你…调整一下台阶沙块在金字塔里组成时的方向。」

### 查出来的真实缺陷（比用户描述的更严重）

**产物根本没带朝向。** 烘焙产物原本是 `[x, y, z, paletteIndex]` 4 项/格，而
`loadStructure` 对 palette 格式的解析把 `direction` **硬编码为 0**：

```js
raw.push({ x, y, z, type: palette[idx], direction: 0 });   // ← 恒 0
```

⇒ **1219 个台阶全部按 `orient=0` 渲染**。格数、尺寸、基座、指纹全部对得上，只有画面错。
这个缺陷在修复前的 4 条 Tier 4 用例、`check:data`、940 条浏览器内单测**全部通过**——
因为没有任何判据在看朝向。

### 修复

1. **产物格式升级为 `stride: 5`**：`{version:2, stride:5, blocks:[x,y,z,paletteIndex,direction, ...]}`。
2. **`structure-json.js` 的 `loadStructure` 支持 `stride`**：按 `data.stride` 决定是否有第 5 项
   （**不靠数组长度猜** —— 4 项与 5 项格式的长度只差 25%，猜法在小结构上有歧义）。
   非 4/5 的 stride 直接 `throw`。
3. **`check:data` 的 `[巨型金字塔]` 加两条判据**：`stride === 5`；台阶 `orient` **四向都出现且分布
   接近均匀**（实测 305/303/305/306，门取「最多 ≤ 最少 × 1.5」）。

### 朝向语义链（三步都实测，不是推的）

| 步 | 结论 | 实测方法 |
|---|---|---|
| ① | `orient` 0/1/2/3 → **凹口**朝 **东/北/西/南** | 真实 mesher 量「上半部（y≥0.5）」的 bbox：orient=0 占 x[0,0.5]（空缺在东）、orient=1 占 z[0.5,1]（空缺在北）、orient=2 占 x[0.5,1]（空缺在西）、orient=3 占 z[0,0.5]（空缺在南） |
| ② | 素材 `facing` = **高侧**（凹口在反方向） | 北坡区（z<20）台阶 facing 分布 `{south:287, east:95, west:92}` —— 若 facing 是凹口方向，北坡台阶该是 `north`；实测是 `south`（指向塔内）。而北坡凹口实测 **296/296 = 100% 朝北**（塔外） |
| ③ | `facing=X → 凹口=反X → orient = NOTCH_TO_ORIENT[反X]` | ⇒ `FACING_TO_ORIENT = {west:0, south:1, east:2, north:3}`。**不是恒等**（恒等会让凹口朝塔内，四面全反） |

> ⚠️ 第 ③ 步的映射表**与修复前的实现逐值相同** —— 即「映射表本身是对的，只是没被写进产物」。
> 这一点是查证过程中一度误判的地方：我先把 `facing` 误认成「凹口方向」，得出「映射全反 180°」的
> 错误结论；后来用「北坡台阶 facing 分布」这条决定性数据才发现看反了。**记录在此，免得后人重走。**

### 端到端实测（真游戏页，锚点 (-1251, 1113)）

| 坡面 | 台阶数 | 凹口朝塔外 | 比例 | orient 分布 |
|---|---|---|---|---|
| 北坡 | 296 | 296 | **100%** | 全 north |
| 南坡 | 293 | 293 | **100%** | 全 south |
| 东坡 | 316 | 305 | **97%** | east 305 / north 6 / south 5 |
| 西坡 | 314 | 305 | **97%** | west 305 / south 8 / north 1 |

东/西坡非 100% 的原因：转角台阶（`outer_left`/`outer_right`）归到「距锚点更近的那一面」时会被算到
相邻坡面，属分类边界而非朝向错。

### 负向验证

| 注入 | 期望 | 实测 |
|---|---|---|
| 产物 stride 改回 4（去第 5 项） | FAIL | ✓ `stride=4 ≠ 5 —— 台阶朝向（direction）没写进产物` |
| 所有台阶 orient 改成同一值 | FAIL | ✓ `sand_step 的 orient 只出现 1 种（0）` |

### 新增测试

- `src/tests/test-giant-pyramid-gen.js`：2 条（stride=5 + 四向分布 / 朝向语义链自证 + 产物交叉验证）
- `tests/giant-pyramid.spec.mjs`：1 条（真游戏页逐坡面验证凹口朝塔外 ≥90%）

---

## 4. 实测数字

### 4.1 密度（每 2 块沙漠 1 座）

口径：跨 8 seed、测量窗 ±3200、分母 = **沙漠连通块数**（8 格粒度、8 连通、质心在窗内）。

| gate | 合计 | 密度 |
|---|---|---|
| 1.00 | 815/902 | 0.904 |
| 0.58 | 464/902 | 0.514 |
| 0.57 | 457/902 | 0.507 |
| **0.56（采用）** | **452/902** | **0.501** |
| 0.55 | 439/902 | 0.487 |

各 seed（gate=0.56）：0.48 / 0.42 / 0.54 / 0.48 / 0.59 / 0.53 / 0.44 / 0.54

### 4.2 间距

- 沙漠连通块最大 bbox 跨度：**368 格**（跨 5 seed 稳定）
- `PYRAMID_MIN_SPACING = 384` > 368 ⇒ 一块沙漠至多 1 座由构造保证

### 4.3 顶点占用

| 口径 | opaque | cutout |
|---|---|---|
| 手算（整座当一个世界） | 45570 | 73500 |
| **真 mesher 逐 section（跨 20 个 section）** | **65080** | **73170** |
| 真游戏页实测（占地内 occupied） | 123405（2.89%） | 76570（3.48%） |

- 全视域：opaque 57.2% / cutout 12.3% / transparent 54.0%
- **三通道零扩容**（caps 结束时等于初始值）

### 4.4 塔基与落地

| 项 | 实测 |
|---|---|
| 塔基悬空列（Node 侧 4 座 × 2401 列） | 10 / 9604 = **0.104%**（洞穴挖空） |
| 塔基格是沙系（真游戏页） | 0 例外 / 2401 |
| 跨 column 命中率 | ≥95% |

### 4.5 生成性能

| 项 | 实测 |
|---|---|
| `rasterizeStructure` 全量遍历 16207 格 | ≈0.014ms |
| 候选层局部锚点 | 0.207ms/region（逐格全检） |
| `getCityBoundsForSeed`（缓存后） | 0.000ms/call（首次 10~12ms，Worker 预热） |

---

## 5. 负向验证清单

**全部用 `cp` 副本还原，未用 `git checkout`**（AGENTS.md 既有教训：会丢失未提交改动）。

### 数据门（`npm run check:data`）

| 注入 | 期望 | 实测 |
|---|---|---|
| `BLOCK_MAP` 的 `smooth_sandstone` → `stone` | FAIL（指纹不匹配） | ✓ `npm exit=1`，报「产物已过期：指纹不匹配」 |
| `PYRAMID_METRICS.stepCells` 1219 → 1218 | FAIL（指标不符） | ✓ `npm exit=1`，「指纹不匹配」+「"sand_step" 格数 1219 ≠ 1218」 |
| 产物里 `sand_step` 全改 `sand` | FAIL（台阶退化） | ✓ `npm exit=1`，「sand 16206 ≠ 14987」+「sand_step 0 ≠ 1219」+「sand_step 只有 0 格（必须 ≥1000）」 |

### Tier 4（`tests/giant-pyramid.spec.mjs`）

| 注入 | 期望 | 实测 |
|---|---|---|
| A. `STRUCTURE_FILES.giantPyramid` → 不存在的文件 | 多条 FAIL | ✓ **3/4 FAIL**（特征方块 / 连通 / 塔基；预算用例不测存在性属正常） |
| B. `apply.js` 的 `anchor.floorY + 1` → `+ 6` | 塔基用例 FAIL | ✓ FAIL |
| C. `CAPACITY.cutout` 550 → 300 | 预算用例 FAIL | ✓ FAIL（开局容量断言） |
| D. 产物里 `sand_step` 全改 `sand` | 特征方块用例 FAIL | ✓ FAIL |

### Tier 1（浏览器内单测）

| 阶段 | RED 证据 |
|---|---|
| Task 4（新方块） | 2 FAIL：「sand_step 必须在 blocks-data.js 里声明」「sand_step 的 faces-data 必须是六面数组」 |
| Task 5（候选模块） | 测试页因模块 404 **整个挂掉**（TIMEOUT + "Failed to load resource: 404"）—— 模块级 import 失败的真实后果 |
| Task 6（接线） | 2 FAIL：「region(0,1) layout 必须有 giantPyramid 字段」「必须找到有锚点的 region」 |
| Task 7（GEN） | 3 FAIL：`sand_step` 计数 0 / 产物格数 0 / 跨 column 数 0（根因：`STRUCTURE_FILES` 缺映射） |

---

## 6. 实施期间的裁决（计划之外的修正）

| # | 裁决 | 依据 | 代价 |
|---|---|---|---|
| R3 | 占地全检 `FOOTPRINT_STEP` 2 → **1（逐格）** | 采样会少算地表高差：实测 388 个沙漠样本里 **1 个**「逐格 span=5 但 step2 span=4」 | 0.207ms/候选（vs 0.055），可忽略 |
| R4 | **高台排除从 apply 层上移到候选层** | 实测 ±6 region 里两者都有 27 个、**其中 5 个（19%）占地重叠** → apply 会丢弃它们，后果是「金字塔静默消失 + 植被已抑制 = 空地」 | 用局部高台（比最终高台保守）→ 略少几座，方向安全 |
| R5 | `PYRAMID_CHANCE` 0.53 → **0.56** | R3 的逐格全检筛掉更多锚点 → 同 gate 密度下降 | 密度偏离会导致用例红 |
| R6 | 密度测量窗 ±1600 → **±3200** | 窗越小边界效应越强：实测同一 gate ±1600 得 0.363、±3200 得 0.501 | 大窗标定在小窗世界略偏稀 |
| R7 | 「高台排除必需」的判别力前置条件改写 | 排除上线后局部锚点已不重叠，原断言恒假。改为「高台占地内存在合法候选」：实测 162 个有高台的 region 里 **139 个**如此 | 两处都设了下界（withMesa>100 / eats>50） |
| R8 | 「塔基不悬空」判据从「向下 6 格有实心」改为「**塔基格必须是沙系**」 | 注入「塔上移 5 格」实测：判据1 = 0/2401、判据2（正下方）= 0/2401 **都无判别力**；判据3（塔基格沙系）= **459/2401 命中** | 若将来塔基换材质须同步改判据 |
| R9 | 「迷宫连通」判据补强为 5 项 | 本仓塔是每层向内收 2 格的锥形，任何「填实某层」的注入都能从外侧绕过（实测填实 5..14 后 ratio 仍 0.985、填实 1..20 后反而 1.0）；而 cells 也挡不住缺失（断开映射后 2400→2401）。**有效判据 = 沙系方块数**：16524 → 4037 | 多 4 个断言，误报面变大（各项实测余量充足） |
| R1 | `readLitematic` 额外返回 `totalBlocks` | Task 1 的 PASS 判据要打印它（解码口径的唯一权威校验） | 只读字段，零成本 |
| R2 | `blocks` 保留 barrier 下标不过滤 | 读者做忠实翻译；过滤是烘焙脚本的职责 | 若读者过滤，那唯一的校验就失真 |

---

## 7. 已知限制与盲区

1. **迷宫有 36 格高层死角（占可站立格 1.5%）玩家走不到** —— 本仓物理把台阶/半砖当**整格**碰撞
   （`world.isSolid` 读 `solidTable`），而原模型是按半格设计的。这是**已接受的代价**：
   给台阶做半格碰撞是另一个 Epic（要改 `physics` / `world.isSolid` 的语义，影响所有既有台阶方块）。
   迷宫主体（98.5% 可站立格）可达，不影响从中庭向上探索。

2. **指纹盲区**：只改烘焙**算法**而不动参数时指纹不变 → 靠 Tier 1 产物契约 + Tier 4 兜住。

3. **`structure-gen` fixture 的 genP95 门在高系统负载下会越线** —— 实测系统 load 5.7~6.5 时
   `genP95` 在 9.6~12.1ms 间跳动。**交替对照（MOD/BASE 各 3 轮交错）结论**：
   MOD 中位 **9.7ms**、BASE 中位 **11.6ms** —— **我的改动不比 BASE 差**，两者都受负载影响。
   这属 HEAD 既有的临界状态（与 AGENTS.md 记录的 `m1-acceptance` / `m3-rain` /
   `weapons-world-edit` 三条计时型 spec 同类），**未改断言、未放宽阈值**。

4. **`bench --check` 未跑**：改动不触热路径（mesher / materials / scheduler / physics 均未动），
   只新增 GEN 侧的结构光栅化（≈0.014ms/座）。若后续有人改 mesher 再补跑。

5. **旧存档**：已生成的 column 不会自动长出金字塔（结构在 GEN 时写入）。这与高台/巨树的既有
   口径一致；玩家改动过的 column 由 edits 覆盖在生成结果之上。

---

## 7b. 背包改动（2026-10-25 用户要求）

用户：「新增的沙块台阶方块，和之前巨树烘焙的几个新的树叶方块，都放到背包里」。

| 方块 | 改动前 | 改动后 |
|---|---|---|
| `sand_step` / `sand_slab` | **已在背包**（新增方块时就是默认进背包，未进任何排除清单） | 不变 |
| 8 个 `giant_*`（巨树树干 + 树叶） | 在 `HIDDEN_FROM_INVENTORY` 里（**不进背包**） | **已移出 → 进背包** |

- 物品集合：**118 → 126 项**（`registry 136 − 排除 10`，排除项 = `NON_PLACEABLE_ITEMS` 4 + `HIDDEN` 6）。
- 已重跑 `npm run icons`（图标 manifest 与背包集合双向一致，126 项）。
- `check:data` 的 `[巨树]` 环节口径**反转**：原来钉「8 项必须不在背包」，现在钉
  「**不得**在 `HIDDEN_FROM_INVENTORY` 里 + 必须在 `buildItemNames` 派生集合里」。
  负向验证：把 `giant_oak_log` 塞回 HIDDEN → 两条同时 FAIL ✓。
- 连带更新 4 处硬编码计数断言（`test-inventory.js` / `test-inventory-ui.js`）：
  物品集合 118→126、HIDDEN 14→6、渲染槽 118→126、空槽下标 117→125。

---

## 8. 门禁结果

| 命令 | 结果 |
|---|---|
| `npm run check`（arch + data + lint） | ✓ 全部通过（lint 0 error / 17 个既有 warning） |
| 浏览器内单测（`tests/harness.spec.mjs`） | **940 / 940 pass**（passRate 100%） |
| `tests/giant-pyramid.spec.mjs` | **4 passed** |
| `tests/mesa.spec.mjs` / `tests/giant-trees.spec.mjs` | passed（回归确认） |
| `npm run check:data` 的 `[巨型金字塔]` | ✓ `16207 格 / 49×24×49 / 基座 2401 列 / 3 种（sand 14987 + step 1219 + slab 1，4 向朝向）/ 无砖无木 / 指纹匹配` |
| `tests/structure-gen.spec.mjs` | ⚠️ genP95 在高负载下越线（见 §7.3，交替对照已证明非本改动引入） |
