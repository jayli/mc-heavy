# 巨型金字塔（Giant Pyramid Maze）设计

状态：待评审
日期：2026-10-25
素材：`/Users/bachi/Downloads/Small Pyramid Maze.litematic`（入库为
`assets/giant-pyramid/src/small_pyramid_maze.litematic`）

---

## 1. 目标与验收口径

在沙漠里加一座**沙子系**的 49×25×49 巨型金字塔迷宫，**平均每 2 块沙漠出现 1 座**，
且不与任何既有建筑/景观重合。

用户裁定（2026-10-25，四次问答）：

| 决策点 | 结论 |
|---|---|
| 体量 | **原尺寸 1×**（49×25×49），不放大 |
| 材质 | **保留原模型的方块分层与台阶结构**，全部换成沙子系方块 |
| 出现频率 | **每约 2 块沙漠 1 座**（不是「每 region 掷一次」） |
| 让路 | 城市 / 地标 / 空岛 / 巨树 / 高台 + 其它撒布结构（沙漠神殿、村落、丑陋房子、tank） |
| 转角台阶 | **用直台阶近似**（本仓无转角台阶几何） |
| 塔基落地 | 占地内地表高差 **≤ 4 格** |
| 旧沙漠神殿 | `desertPyramid` **保留**，只保证占地不重叠 |

验收判据（Tier 4 + 数据门）：

1. 真游戏页里能按确定性落点找到一座金字塔，其特征格（沙子整格 / 台阶 / 半砖）在位；
2. 迷宫**连通**（同一座金字塔的可站立格全部属于 1 个连通域）；
3. 沙漠里的金字塔平均密度落在「每 2 块沙漠 1 座」的关系式区间内；
4. 不出现悬空（塔基各列下方必为实心）；
5. 不与城市 / 地标 / 高台 / 撒布结构占地相交；
6. 三通道容量不扩容（`bench --check` 不阻断，`giant-tree-budget` 按实测重标基线）。

---

## 2. 素材实测（2026-10-25，不是读定义推断）

用 `tools/nbt-reader.mjs` 的思路读 litematic（gzip → NBT → 跨 long 打包的 5 bit 数组）：

| 项 | 实测值 |
|---|---|
| `EnclosingSize` | x=49, y=25, z=49（`Size` 字段是负数，须取绝对值） |
| `TotalBlocks` | 17966（与解码结果逐格吻合 → 解码口径已核实） |
| 索引序 | `(y*sz + z)*sx + x`（用「y=0 是满铺 49×49 地板」验过） |
| 位打包 | **跨 long 连续**（非 straddle 读法给出乱码；straddle 读法格数与 `TotalBlocks` 精确相等） |
| palette | 17 项：`air` / `smooth_sandstone` / `smooth_sandstone_stairs`(14 变体) / `smooth_sandstone_slab`(2 变体) / `barrier` |
| 实体/方块实体 | **空**（`TileEntities: []`、`Entities: []`、无待结算 tick） |

逐层剖面（`solid` 不含 barrier）：

```
y= 0 solid=2401  49×49 满铺        y=12 solid=386  23×23
y= 1 solid=2019  45×45             y=18 solid= 65  11×11
y= 2 solid=1707  43×43             y=22 solid=  3   2×2
y= 6 solid=1000  35×35             y=23 solid=  1   1×1（塔尖）
y=24 solid=0（整层空气）
```

方块构成（实心 16207 格）：

| 方块 | 格数 |
|---|---|
| `smooth_sandstone`（整格） | 14982 |
| `smooth_sandstone_stairs`（直台阶 4 朝向） | 1219 |
| `smooth_sandstone_slab`（double 5 + bottom 1） | 6 |
| `barrier`（隐形，等价空气） | 1759（不计入实心） |

**结构不是实心金字塔，是中空、顶部敞开的迷宫**：

- 空气格（不含 barrier）42059 个，「上方有实心方块」的 = **0**（没有任何拱顶）；
- 列内被上下实心夹住的空气格 = **0**；
- 可站立格（脚 + 头两格空气、脚下 1~2 格内有支撑）4801 个，**全部属于同一个连通域**
  （从外圈 1 格内可达 4801/4801）；
- barrier 1759 格中，「若当空气即构成可站立通道」的 = **0**（它们是墙体包边/装饰，不是隐形通路闸门）。

**渲染成本**（按本仓 mesher 口径估算）：

| 通道 | 面数 | 顶点 | reserved（×1.25） |
|---|---|---|---|
| opaque（14982 整格） | 9114 | 36456 | 45570 |
| cutout（1225 台阶/半砖 × 48） | — | 58800 | 73500 |
| 合计 | — | **95256** | 119070 |

- 占 opaque 通道（4.275M）**1.07%**，占 cutout 通道（2.2M）**3.34%**；
- 两座同时在视域内（间距 400 < 视距 16 的直径 512，最坏会同时可见）= cutout 6.7%，仍远低于实测峰值 38.3%。

**地形兼容性**（seed 12345）：

| 项 | 实测 |
|---|---|
| 沙漠地表高度 | p50=2 / p90=6 / max=9（±1200 采样） |
| 塔顶世界高度 | `floorY + 24` ≤ 33 → **在云层 Y=35 之下**（不穿云、不撞空岛底 y≥40） |
| 49×49 占地全沙漠且全高于海平面 | 48 个非城市 region 中 **40 个**有合法落点 |
| 占地内地表高差 | ≤2 只有 15% region / **≤4 有 31%** / ≤8 有 83%。取 ≤4 |

---

## 3. 决策记录（DR）

### DR-1 落点走「region 级候选 + 单向邻域去重」，不走逐点撒布

**理由**：`desertPyramid` 的逐点撒布没有间距护栏，本仓已在高台（mesa）上实测过同类口径的
失败形态——「一块沙漠里出现 2~4 个，最近一对仅隔 32 格」。金字塔 49×49 占地是沙漠神殿的
2 倍，重叠尤其难看。故照 `src/gen/structures/mesa.js` 的成熟三段式：

```
本文件               computeGiantPyramidAnchor()   纯函数、region 级、跨 region 无缝
apply.js 阶段 2.76   按锚点光栅化 + 让路判据
```

不新建 Worker（红线 3/8），候选仍在 `computeRegionLayout` 里算一次（DR-13）。

### DR-2 单位是「沙漠连通块」，不是 region

**理由**：region 是 400×400 的**矩形网格**，沙漠是**不规则块**。实测（seed 12345，8 格粒度，
±1200）沙漠连通块 31 个，**最大 bbox 跨度 368 格**。所以：

- **间距阈值 `PYRAMID_MIN_SPACING = 384`**（= 368 上取整到最近的 32 倍数），使「一块沙漠
  至多 1 座」由构造保证（与 `MESA_MIN_SPACING` 同一取值依据）；
- **邻域去重必须单向**（只跟字典序更小的 region 比）：互相让位会让相邻 region 双双放弃
  → 那块沙漠一座都没有；
- 去重查 `NEIGHBOR_RINGS = ceil(384/400) + 1 = 2` 圈，并先按 region 矩形的最近可能距离剪枝
  （`max(|dx|-1, 0, |dz|-1) * REGION_SIZE ≥ SPACING` 直接跳过），避免为 24 个邻域各算一次
  局部锚点（实测局部锚点 0.207ms/region）。

### DR-3 密度是「间距 × 概率门」两个独立旋钮，不可互相倒推

- **间距**保证「一块沙漠至多 1 座」（0 或 1 的上界）；
- **概率门 `PYRAMID_CHANCE`** 把「有锚点的沙漠」再抽掉一半 → 「每 2 块沙漠 1 座」。

⚠️ 初值取 `PYRAMID_CHANCE = 0.5`，但**必须按实测标定**：实现时在 5 个 seed × ±1600 上量
「金字塔数 ÷ 沙漠连通块数」，落在 **[0.4, 0.6]** 才收工。断言用**关系式**（`spacing >
最大沙漠连通块跨度`、`密度在区间内`），不硬编码概率值（硬编码「被测代码写入的那个值」，
回退后仍 PASS）。

### DR-4 占地四条判据，缺一不可

逐条对应一种「静默产出一个看起来正常的错误金字塔」：

1. **占地 49×49 全为 DESERT biome** —— 否则一半坐在草地上；
2. **占地 49×49 全部 `generateHeight > SEA_Y`** —— 否则一半扎在海底；
3. **占地内地表高差 ≤ 4** —— 否则一侧悬空（护栏见 DR-5）；
4. **并集外接框完整落在本 region 内（内缩 25 格）** —— 否则占地越界，而相邻 region
   **不会**为它生成锚点（各 region 独立算候选）→ 半边永久消失。

另加两条**数值断言式**护栏（不是排除判据，而是不变式）。高度口径先定死：
`rasterizeStructure` 写入的世界 y = `anchor.floorY + b.y`（`b.y` 是归一化后的产物 y ∈ [1, 24]），
故**塔顶世界 y = `floorY + PYRAMID_HEIGHT`**（`PYRAMID_HEIGHT = 24`）。

5. `MAX_DESERT_H + PYRAMID_HEIGHT < SKY_MIN_Y`（9 + 24 = 33 < 40）—— 台顶不得撞空岛；
6. `MAX_DESERT_H + PYRAMID_HEIGHT < CLOUD_Y`（33 < 35）—— 台顶不得穿云。

两条都由「沙漠地表 max=9」保证，但写成断言（且 `MAX_DESERT_H` 直接由真实 `generateHeight`
扫出来，不写字面量）是为了常量改动时立刻红，而不是某天世界穿帮。

### DR-5 `floorY` 取占地内**最低**地表，不取中心点

取 min 保证**任何一列塔基都不悬空**；代价是占地内高处的地形被埋没 ≤ span（≤4 格）。
方向选择与高台同源（「宁可埋没不悬空」）。因为整座金字塔都是沙子、沙漠地表也是沙子，
埋没在观感上只是「底面抬高」，不像岩石高台那样显眼。

塔基最底层（原模型 y=0 的满铺地板）落在 `floorY + 1`（= 地表之上第一格）。
该层是**满铺 49×49 实心**，故不存在「塔底悬空、从侧面看到缝隙」。

### DR-6 城市排除必须精确且廉价 → 引入 `getCityBoundsForSeed()`

**问题**：城市 bounds 实测（seed 12345）为 x∈[0,566] × z∈[-166,400]，**横跨 4 个 region**；
而 `city` 布局只存在于 region [0,0] 的 layout 里。候选层若只判「自己的 layout 有没有 city」，
region [1,0] / [0,-1] / [1,-1] 里的锚点会落在城内。城市面积里 **20.7% 是 DESERT biome**，
且实测存在 504 个「49×49 全沙漠」的城内落点 —— 不是理论风险。

候选层不能把它推给 apply 层（那会产出「锚点存在但没光栅化」→ 该区域植被被
`pointContext` 抑制却长不出金字塔 = 光秃秃的空地）。

**解法**：`city-layout.js` 新增 `getCityBoundsForSeed(seed)`——内部调用一次
`buildCityLayout(seed)` 并**只缓存派生的 bounds 对象**（`Object.freeze`，不缓存 layout 本身，
避免改变其别名语义）。`buildCityLayout` 实测 10~12ms，故：

- **在每个 Worker 的 `layout` 入口预热一次**（那里已经在 await 预载 promise），
  确保这笔成本绝不落进 GEN 计时路径；
- 候选层直接读缓存 bounds，零成本。

**为什么不在候选层用「保守 bbox 常量」**：实测 bounds 半宽 **283** 已远超
`CITY_SIZE_MAX/2 = 112`（`expandBoundsIfNeeded` 有不受 `CITY_SIZE_MAX` 钳制的增长路径），
任何「猜一个保守常量」的做法都是「按定义推断」而不是实测。

### DR-7 层序与让路：候选层排除 + `pointContext` 单一判据

- 候选层排除（一次性解决绝大部分冲突）：本 region 的**全部地标**（金字塔 / 冰封山 / 雪原 /
  海岛 / 平地）、**本 region 的高台锚点**、**城市 bounds（DR-6）**、**邻接巨型金字塔**（DR-2）。
- `apply.js` 的 `pointContext()` 增加一条分支：锚点占地内 → `kind: 'none'`。
  这一条一次性覆盖五个下游消费者（**不写第二份判据**）：
  ① 阶段 2.75 高台的让路（它判 `kind !== 'normal'`）；
  ② 阶段 2.8 巨树的 `allowedAt`（只允许 normal/water）；
  ③ 阶段 3 的城市树 / 普通树 / 巨树覆盖；
  ④ 阶段 3 的睡莲与单格植物（`inColumn` 分支都按 kind 分流）；
  ⑤ 未来的新植被路径。
- 阶段 2.7 的**撒布结构**在 apply 层剔除，判据函数 `inGiantPyramidFootprint()` 放
  `giant-pyramid.js`（与 `inCityBounds` 同手法：候选层跨 region 判不了一半，唯一权威在 apply）。
- 高台与金字塔**只在同 region 可能相交**，可用内缩量证明：
  金字塔中心 ∈ `[base+25, base+375]`，高台中心 ∈ `[base+13, base+387]`；
  相邻 region 下 `|Δ| ≥ 413 − 375 = 38 > 24 + 11 = 35` → 相邻 region 不可能冲突。
  候选层只查**本 region** 的 `computeRegionLocalAnchor`（不触发它的邻域去重，省 3.5ms）。
  这条「内缩量保证」写成单测，常量一改就红。

### DR-8 只加 2 个方块，几何复用既有模板

| 新方块 | `geometry` | `cullMode` | `opaque` | 贴图 |
|---|---|---|---|---|
| `sand_step` | `planks_step`（既有 L 形模板） | `cutout` | **显式 `false`** | `sand` 六面数组（顶面用 `sand`，侧面 `sand_side`） |
| `sand_slab` | `half_block`（既有半高模板） | `cutout` | **显式 `false`** | 同上 |

- **几何零新增**：两个 `geometry` 都是既有 `TEMPLATES` 条目 → 形状与 UV 的唯一权威仍在
  `mesher.js`（红线 1，禁止第二份几何定义）。
- **显式 `opaque:false` 是防御**：`cutout` 的默认推导已经是 0，但 AGENTS.md 的既有约束要求
  非 box 几何方块显式声明（否则将来有人把 `cullMode` 改成 `opaque` 就会静默误推
  `opaqueTable=1` → mesher 剔掉邻居面 → 塔身出现洞）。
- **两个方块都进背包**（玩家挖下来能拿起来）：不加 `HIDDEN_FROM_INVENTORY`，
  故须重跑 `npm run icons`；**不需要** `npm run atlas`（无新 PNG，复用既有 tile）。
- `sand_step` 必须 `orientationModes: 4`（台阶朝向靠 `meta & 3` 旋转，与既有 `planks_step` 同口径）。

### DR-9 台阶的顶点成本是设计接受的代价

模板几何**不参与面剔除**（`mesher.js` 的模板路径刻意不做 culling），每格恒 12 quad = 48 顶点。
1225 格 = 58800 顶点，是同等数量整格方块的 4~6 倍。

- 换成 `cullMode:"opaque"` 也**不省一个顶点**（模板路径不分通道）；
- 真正的节省需要「模板面与邻居整格的面互相剔除」，属 mesher 的新机制，本期不做；
- 结论：**接受**，并把它记进容量账（DR-11）。

### DR-10 素材解码：新增 `tools/litematic-reader.mjs`

本仓此前只有 Sponge `.schem` 读取（`nbt-reader.mjs` + 各自的 varint/位数组代码）。
litematic 是**另一种格式**，不能靠 `.schem` 的代码路径：

- 结构：`Regions.<name>.{BlockStates: LongArray, BlockStatePalette: [Compound], Size, Position}`；
- 位数组：`bits = max(2, ceil(log2(palette.length)))`，**跨 long 连续**（不是 `.schem` 的
  varint 流）；已用「解码格数 == `TotalBlocks`」核实；
- 索引序：`(y*sz + z)*sx + x`；`Size` 可能为负，取绝对值；
- 复用 `NbtReader`（已有 tag 1~12 实现），**不重写 NBT 解析**。

### DR-11 预算：不新增通道，只吃既有余量

| 通道 | 单座 reserved（**真 mesher 逐 section 实测**） | 现峰值 | 加一座后 | 判定 |
|---|---|---|---|---|
| opaque | 65,080 | 73.4% | 74.9% | 安全 |
| cutout | 73,170 | 38.3% | 41.6% | 安全 |

⚠️ 这两列比手算值（opaque 45,570 / cutout 73,500）大 43%：手算把整座当作一个世界（相邻
section 的面会互相剔除），而真实渲染**相邻 section 不互相剔除**（实测跨 20 个 section，
各自都把自己那面当暴露）。**预算一律用逐 section 真值**，与高台/巨树同口径。

**不调 `CAPACITY`**。`giant-tree-budget.spec.mjs` 的冻结基线若因新内容实测变化，
按既有裁定**重标为新实测值**（不是放大容差）——实施时先量再定，并把交替对照结果写进验收报告。

### DR-12 与 `desertPyramid` 共存

旧的小沙漠神殿**保留**（用户裁定）。两者占地由金字塔一侧的单向剔除保证不重叠
（`inGiantPyramidFootprint` 在 apply 阶段 2.7 剔除落在金字塔占地内的撒布候选）。

---

## 4. 实现清单

### 4.1 新增文件

| 路径 | 职责 |
|---|---|
| `assets/giant-pyramid/src/small_pyramid_maze.litematic` | 烘焙输入（入库，**非渲染资源**） |
| `assets/structures/giant_pyramid.json` | 烘焙产物：`{version, palette, blocks}`（palette 索引压缩，预计 ~320KB） |
| `assets/structures/giant_pyramid.meta.json` | 产物元数据（尺寸 / 格数 / 台阶格数 / 输入指纹） |
| `tools/litematic-reader.mjs` | litematic → `{palette, blocks, size}` 纯读取（无 DOM、无 three） |
| `tools/giant-pyramid-fingerprint.mjs` | 映射表 `BLOCK_MAP` + `PYRAMID_METRICS` + 指纹（**烘焙脚本与 `check:data` 共用**） |
| `tools/bake-giant-pyramid.mjs` | `npm run pyramid`：读 litematic → 映射 → palette 压缩 → 写 JSON + meta + 断言 |
| `src/gen/structures/giant-pyramid.js` | `computeGiantPyramidAnchor()` + `inGiantPyramidFootprint()` + 常量 |
| `src/tests/test-giant-pyramid.js` | Tier 1：落点判据 / 去重 / 密度关系式 / 产物契约 |
| `src/tests/test-giant-pyramid-gen.js` | Tier 1：layout 接线 + 真实 column GEN |
| `tests/giant-pyramid.spec.mjs` | Tier 4：真游戏页按落点扫方块 + 迷宫连通性 |

### 4.2 改动文件

| 路径 | 改动 |
|---|---|
| `src/voxel/blocks-data.js` | 追加 `sand_step`（`planks_step` 几何）、`sand_slab`（`half_block` 几何），均 `cutout` + `opaque:false` |
| `src/voxel/faces-data.js` | 追加两项，六面数组（顶/底用 `sand`，四侧用 `sand_side`） |
| `src/gen/structures/structure-json.js` | `STRUCTURE_FILES` 加 `giantPyramid: 'giant_pyramid.json'`；**不进** `GROUND_SUPPORT_TYPES`（底层是满铺实心） |
| — | 常量不加进 `region-config.js`：`GIANT_PYRAMID_*` 与 mesa 的 `MESA_*` 同口径，**全部落在 `giant-pyramid.js` 自己的顶部**（一个模块一个权威，避免常量表与判据分家） |
| `src/gen/structures/city-layout.js` | 新增 `getCityBoundsForSeed(seed)`（memoized bounds，`Object.freeze`） |
| `src/gen/structures/mesa.js` | 抽出并导出 `regionLandmarkCenters(regionX, regionZ, seed)`（供金字塔复用；mesa 改为它的调用方）。**这是一处针对既有代码的小重构**：`landmarkCircles()` 里现在写着「没有 `getSnowLandCenterInRegion` 导出，这里复现那两行（若 layout 改了须同步）」——那正是「第三份副本」的入口。金字塔要同一批地标圆，不抽出就会变成第三份。回归门 = `test-mesa.js` + `test-mesa-gen.js` 逐用例不动。注：雪原中心这一项**刻意不进**该函数（金字塔不需要它；且它缺导出是既有问题，本次不顺手扩范围） |
| `src/gen/structures/scatter.js` | **不改**。金字塔不是撒布类型（不走逐点撒布，DR-1），故 `SCATTER_TYPES` / `SCATTER_FOOTPRINT` / `SCATTER_JSON_TYPES` 一行不动 —— 列在此仅为记下「刻意不动」，避免实施时顺手把它塞进撒布链 |
| `src/gen/structures/structure-layout.js` | `computeRegionLayout` 增加 `giantPyramid` 字段 |
| `src/gen/structures/apply.js` | 阶段 2.76 光栅化 + `pointContext` 新分支 + 阶段 2.7 撒布剔除 |
| `src/workers/world-worker.js` | `layout` 入口预热 `getCityBoundsForSeed`（与既有预载 promise 同处） |
| `tools/check-data.mjs` | 新增 `[巨型金字塔]` 环节 |
| `package.json` | 新增 `"pyramid": "node tools/bake-giant-pyramid.mjs"` |
| `AGENTS.md` / `docs/roadmap.md` | 新增活跃约束段与扩展点记录 |

### 4.3 烘焙映射表（`BLOCK_MAP`）

| 源方块 | 目标 | 说明 |
|---|---|---|
| `smooth_sandstone` | `sand` | 整格 |
| `smooth_sandstone_stairs`（`straight`，4 朝向） | `sand_step` | 朝向进 `meta` 低 2 位 |
| `smooth_sandstone_stairs`（`outer_left` / `outer_right`，63 格 = 0.39%） | `sand_step` | **有意简化**（DR-13 ①），朝向取 `facing` |
| `smooth_sandstone_slab`（`double`，5 格） | `sand` | 双半砖 == 整格 |
| `smooth_sandstone_slab`（`bottom`，1 格，塔尖） | `sand_slab` | |
| `barrier` | —（跳过） | 隐形，等价空气 |

未知源方块名 → 烘焙脚本 **throw**（不静默丢弃：`makeColumnSetter` 对未注册名字是静默 return，
那格变 air 且方块层面看不出是映射错了）。

### 4.4 产物契约（`check:data` 的 `[巨型金字塔]` 环节钉住）

1. `palette` 每项都在 registry 里注册；
2. `blocks` 长度 ≡ `PYRAMID_METRICS.blocks × 4`（= 16207 × 4）；
3. 尺寸 ≡ 49 × 24 × 49（归一化后 y∈[1,24]，最底层 y=1）；
4. **台阶格数 ≥ 1000**（守住「拒绝退化成全整格」，实测 1225）；
5. 最底层 y=1 的格数 ≡ **2401**（满铺 49×49 → 塔基不悬空的构造性保证）；
6. 指纹新鲜（改 `.litematic` / `BLOCK_MAP` / `PYRAMID_METRICS` 后不重烘即红）；
7. 无砖块族、无木族（与高台同口径的名字模式判据）；
8. palette 全部 `cullTable ∈ {0, 1}` 且无 transparent（不许落进 blended 通道）。

---

## 5. 测试分级与判据

按 `docs/testing-policy.md`，本改动属 **Tier 1**（机制/架构）+ **Tier 2**（数据契约）+ **Tier 4**（渲染）。

### Tier 1（`src/tests/test-giant-pyramid.js`，先 RED 后 GREEN）

| 用例 | 判据 |
|---|---|
| 确定性 | 同 seed 同 region 两次调用逐字段相同 |
| 占地全沙漠 | 锚点占地内 `getBiome === 'DESERT'` 全部成立 |
| 占地全高于海 | 占地内 `generateHeight > SEA_Y` 全部成立 |
| 高差 | `max − min ≤ PYRAMID_MAX_SURFACE_SPAN` |
| region 内缩 | 占地 [wx±24] 完整落在 `[base+25, base+375]` |
| 地标排除 | 锚点不落在地标半径内（逐地标枚举） |
| 高台排除 | 同 region 的 `computeRegionLocalAnchor` 占地与本金字塔不相交 |
| 城市排除 | 5 seed × ±2 region：**0 个锚点**与 `getCityBoundsForSeed` 相交 |
| 串行去重 | 相邻两 region 的锚点切比雪夫距 ≥ `PYRAMID_MIN_SPACING`（或其一为 null） |
| 单向性 | 「A 让位给 B」不会同时「B 让位给 A」（构造合成输入断言） |
| 内缩不变式 | `PYRAMID_INSET + PYRAMID_HALF` 与 `MESA_INSET + MESA_UNION_HALF` 之和 < `REGION_SIZE` |
| 高度不变式 | `MAX_DESERT_H + PYRAMID_HEIGHT - 1 < CLOUD_Y`（用真实 `generateHeight` 扫出的 max） |
| 密度关系式 | 5 seed × ±1600：`pyramids / desertComponents ∈ [0.4, 0.6]` 且 `spacing > 最大连通块跨度` |

### Tier 1（`src/tests/test-giant-pyramid-gen.js`）

| 用例 | 判据 |
|---|---|
| layout 接线 | `computeRegionLayout(...).giantPyramid` 与直接调用一致；无沙漠 region 为 null |
| 真实 GEN 落地 | 锚点 column 内出现 `sand_step`（特征格，≥1）与 `sand` |
| 塔基不悬空 | 最底层（`floorY+1`）的 49×49 每列下方 1~4 格内必有实心 |
| 植被抑制 | 占地内的树/花草格数 = 0（对照：占地外 3 格内有植被） |
| 撒布剔除 | 在合成 anchors 下，落在金字塔占地内的 `desertPyramid` 候选不落地 |
| 跨 column 无缝 | 同一座金字塔在 4 个相邻 column 各自光栅化本列部分，拼接后与「整座」逐格相同 |

### Tier 4（`tests/giant-pyramid.spec.mjs`）

⚠️ 先测**噪声底**，冻结物理/日夜/阴影/HUD（与 `fog-color.spec` 同手法）。

| 用例 | 判据 |
|---|---|
| 特征方块在位 | 页面内按锚点扫方块：`sand_step` 计数 ≥ 1000、`sand_slab` ≥ 1 |
| 迷宫连通 | 从塔基外圈可站立格 BFS，覆盖占地内可站立格的 ≥ 95%（实测 100%） |
| 无悬空 | 塔基各列向下 4 格内有实心（逐列断言） |
| 顶点预算 | 站在金字塔旁的 `renderWorld` reserved 增速 ≤ 单座估算 × 1.3；三通道零扩容 |

### 门禁

- `npm run check`（arch + data + lint）
- `npx playwright test tests/giant-pyramid.spec.mjs tests/structure-gen.spec.mjs tests/mesa.spec.mjs tests/giant-trees.spec.mjs`
- `npm run bench -- --check`（热路径未动，但常量与结构注入影响 GEN；若 frameP95 贴线按交替对照判定）
- `npm run icons` → 确认图标指纹通过

---

## 6. 与素材的有意偏离（逐条留档）

| # | 偏离 | 理由 |
|---|---|---|
| ① | 转角台阶（`outer_left/right`，63 格）→ 直台阶 | 本仓无转角台阶几何（`TEMPLATES` 只有 L 形 `planks_step`）；新造两个转角几何需要自己定义形状，属「按 Minecraft 定义推断」，违反本仓「对齐上游须实测运行时行为」的纪律。用户裁定 |
| ② | `barrier` 1759 格 → 空气 | barrier 是隐形碰撞/装饰件，本仓无对应方块；实测无一个 barrier 构成可站立通道，故跳过不改变迷宫可走性 |
| ③ | `smooth_sandstone*` → `sand` / `sand_step` / `sand_slab` | 用户要求「用沙子方块构建」，且本仓 registry 无 `smooth_sandstone`。不新增砂岩方块（会多 3 个方块 + 3 张贴图 + 图标） |
| ④ | 1× 原尺寸（不放大） | 用户裁定；且 2× 会让塔顶 y≈58 穿云 |
| ⑤ | 落点走 region 级候选（非逐点撒布，与 `desertPyramid` 不同） | DR-1 |
| ⑥ | 占地高差 ≤4 时允许埋没底部 ≤4 层 | DR-5「宁可埋没不悬空」 |
| ⑦ | `double` 半砖 → 整格沙；`bottom` 半砖 → `sand_slab` | 本仓半砖模板只有 `half_block`（下半），`double` 语义上就是整格 |

---

## 7. 已知盲区与风险

1. **指纹盲区（与既有烘焙产物同源）**：只改烘焙**算法**而不动参数时指纹不变 →
   靠 Tier 1 的产物契约与 Tier 4 的像素/方块实测兜住。
2. **`giant-tree-budget` 基线**：新增内容会改变固定视域的顶点总量。若实测变化，
   按既有裁定**重标基线**（不是放宽容差），并做交替对照证明增量真实。
3. **`bench --check` 的 frameP95 门禁**：120Hz 下按 8.33ms 量子化，本改动不动热路径，
   但结构注入会让 GEN 略重。阻断时先做交替对照，不看单次数值。
4. **`structure-gen` fixture 的 genP95**：本仓实测该门在 7.6~8.2ms 区间。
   金字塔只在极少数 column 命中（撒布级稀疏），且 `rasterizeStructure` 全量遍历 16207 格实测
   ≈0.014ms，故预期无可见影响；仍须实测确认。
5. **存档兼容**：已生成的 column 不会自动长出金字塔（结构在 GEN 时写入）。这与高台/巨树的
   既有口径一致（旧存档里的森林会长出巨树，是因为它按 column 重生成时才生效）；
   玩家改动过的 column 由 edits 覆盖在生成结果之上。
