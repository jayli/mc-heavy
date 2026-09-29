# 空岛天空树设计（M2-7 有意删除项回补 + sky_leaves 通道修正）

**状态：** ✅ **已实施**（`13ce699`，实测见 §10）
+ ✅ 已确认（用户选定方案 C）+ ✅ 已经评审修正（2026-09-20）+ ✅ 已经二次审核修正（2026-09-28，见 §2.5.2 / §9.2）<br>
⚠️ **本文 §4 / §5 / 头部「一句话现状」里的数字是勘查期估算，已被 §10 的实测数修正**
（三处差异：draw call **+15** 而非 +0；三通道占用百分比口径不对号；`structure-gen` 的含结构
fixture 门撞线 8.5~8.8ms → 用户裁决 8→10ms）。
§4.3 作为**决策依据的历史记录保留不改**，以 §10 为准。<br>
**起草：** 2026-09-20<br>
**评审：** [`docs/superpowers/reviews/2026-09-20-sky-tree-review.md`](../reviews/2026-09-20-sky-tree-review.md)
—— 评审方式是**执行计划自身的测试代码**，发现 2 处阻断级缺陷（Task 3 树干断言必然失败、
Task 4 选点判据恒真）+ 6 处次要问题。经实测复核全部成立，已按 §2.5.1 / §6.1.1 /
§6.2 / §6.3 / §8 / §9.1 修正。**动工前读 §6.2 开头的修正说明**。
**二次审核（2026-09-28）**：发现 1 处论证错误 + 2 处论证缺口，均已回写：
① §2.5 原文把 `surrounded` 生成期跳过论证为「方案 C 下的等价优化」—— 实测方向相反
（方案 C 下跳过净增 2.8% 面数），已重写为 §2.5.2（含甲/乙决策点，建议取甲）；
② §2.6.3 第 3 项补上「玩家可在空岛手动放光源」路径；③ §2.1 影响面 ② 展开为
手动放置的三处可感知新行为清单。另新增 §9.2（同类错误第三次复现的沉淀）。
**动工前读 §2.5.2 的甲/乙决策点**（本计划按甲写；若选乙须先重算 §4.3/§6.2 全部实测数字）。<br>
**定位：** M2-7 空中结构的**范围回补** + 一处**既有数据缺陷修正**。M2-7 按当时的产品范围明确
删除了「空岛宝箱与天空树」（设计文档 v1.14 修订说明），现在把**天空树**加回来，与 mc-lite
`Island.js:44-50` 对齐；宝箱仍不迁移。勘查过程中发现 `sky_leaves` 的渲染通道声明与 mc-lite
材质语义不符（M2-7 移植偏差），一并按用户选定的**方案 C（opaque）**修正。
**关联：** `docs/phase-1-engine-design.md` §4.1（cullMode 勘误先例）、§4.2（空中结构）、
§4.4.2 / DR-11（发布层容量口径）、§4.10（内存预算）；
`docs/superpowers/specs/2026-08-23-m2-sky-structures-design.md`（被本 spec 部分反转）；
`docs/testing-policy.md` §2.5~§2.7（断言落点与负向验证）、§5.2（Tier 4 像素口径）。

> **一句话现状**：天空树的零件几乎全部就位（方块注册、程序化贴图、atlas tile、背包图标、
> `generateTree(...,'skyTree')` 完整算法），缺的是**一个写入调用点**；另外 `sky_leaves` 的
> `cullMode` 声明需要从 `cutout` 改成 `opaque`（§2.6）。
>
> **性能结论（实测，§4/§5）**：GEN p95 **+0.33ms**（预算 8ms）、MESH **+0.4%**、
> 总面数 **+4.1%**、draw call **+0**、三通道容量**全守住**、`gpuVertexBytes` **保持 148.1MiB**
> —— **不需要放宽 §4.10 的 150MiB 冻结预算，不需要降密度，mc-lite 的 10% 可照搬**。
> 唯一须由真 GPU 裁决的是 transparent→opaque 后的填充率变化（§5.2），须 bench 实测。

## 1. 目标与范围

在空岛顶层按 mc-lite 的逐格 10% 概率长出天空树（`sky_wood` 树干 + `sky_leaves` 树冠），
确定性（同 seed 同位置同形状，与加载顺序无关）、跨 column 无断裂、不引入第二份权威数据；
并把 `sky_leaves` 的渲染通道修正为 opaque，使其与 mc-lite 材质语义和本仓渲染成本口径一致。

本任务包含：

- `src/gen/structures/sky-structures.js` 新增 `writeSkyTrees()`，在既有 `applySkyStructures()`
  的固定层序里追加为**第三层**（云 → 岛体 → 树）；导出 `SKY_TREE_CHANCE` / `SKY_TREE_SALT` 常量；
- 抽 `islandLayerRadius()` 作为岛层半径的单一权威，`writeIslands` 与 `writeSkyTrees` 共用（红线 1）；
- **`src/voxel/blocks-data.js:35` 的 `sky_leaves`：`cullMode` 由 `cutout` 改 `opaque`**（方案 C，§2.6）；
- 拆开 Playwright spec 的 `forbidden` 断言（`chest === 0` 保留，`sky_wood`/`sky_leaves` 改 `> 0`）；
  给现有浏览器内单测改名 + 新增树覆盖用例 + 新增通道契约断言（§6）；
- Tier 4 像素实测验证树冠渲染为不透明粉色（§6.5）。

明确**不**包含：

- **空岛宝箱**（mc-lite `Island.js:56` 的 `chest`）—— 用户已确认本次只做树。
  `sky-structures.spec.mjs` 的 `chest === 0` 断言**保留**；
- 树冠形状、密度、间距的任何改动 —— 逐格 10%、无间距约束，照搬 mc-lite（用户已确认）；
- **`sky_leaves` 的贴图 alpha 值改动**（`bake-procedural-textures.mjs:143` 的 0.9×255=230）——
  方案 C 下 opaque 通道材质 `transparent=false`，alpha 不参与混合 → 该值**继续不被消费**。
  保留不动是刻意的最小改动：改它会改变 tile 像素 → 触发 atlas 重打包 + 图标指纹变化 +
  重跑 `npm run atlas` / `npm run icons`，而收益为零（视觉完全相同）。
  ⚠️ 须在 `bake-procedural-textures.mjs` 该处**补注释**说明「alpha 在 opaque 通道下不消费，
  保留 0.9 仅为记录 mc-lite 原值」，否则后人会以为它生效；
- 其余树叶族（改 `sky_leaves` 后剩 **7 项**：`leaves` / `yellow_leaves` / `azalea_leaves` /
  `realistic_oak_leaves` / `realistic_yellow_leaves` / `swamp_leaves` / `snow_leaves`）的通道改动 ——
  它们的 mc-lite 材质确实是 `alphaTest`（真镂空，atlas 实测 `leaves` 中心 alpha=0.231 < 0.3
  → 会 discard），走 cutout 是**正确**的，不动；
- 新增渲染通道、新增 Worker、运行期实体或结构中心缓存（红线 1~4、M2-7 既有边界）。

## 2. 架构与数据流

### 2.1 既有零件盘点（本次勘查实测，非推断）

| 零件 | 位置 | 状态 |
|---|---|---|
| `sky_wood` 方块声明 | `src/voxel/blocks-data.js:30` | ✅ `solid:true, cullMode:opaque` → opaque 通道，无需改动 |
| `sky_leaves` 方块声明 | `src/voxel/blocks-data.js:35` | ⚠️ `cullMode:cutout` **与 mc-lite 材质语义不符** → 本次改 `opaque`（§2.6） |
| 贴图地址映射 | `src/voxel/faces-data.js:29-30` | ✅ `procedural/sky_wood` / `procedural/sky_leaves`，无需改动 |
| 程序化贴图烘焙 | `tools/bake-procedural-textures.mjs:133,140-144` | ✅ `#DDA0DD` / `#FF69B4`；`sky_leaves` 写 alpha 230（0.9）—— 保留不动，仅补注释 |
| atlas tile | `assets/atlas.json`（`procedural/sky_leaves` @ 1552,208 64×64） | ✅ 已入图；**不需重跑** `npm run atlas`（未改像素） |
| 背包图标 | `assets/icons.json`（hotbar + inventory 双尺寸） | ✅ 已有；**不需重跑** `npm run icons`（指纹只含 `geometry` 与 tile 地址，不含 `cullMode`，实测核实） |
| 树生成算法 | `src/gen/structures/vegetation.js:18-31` | ✅ `'skyTree'` 分支**已完整移植**，当前**零调用点** |

**改动安全性**：`sky_leaves` 在当前世界里**没有任何既有实例** —— grep 全仓，它的唯一生成点是
`vegetation.js:20` 的 `'skyTree'` 分支（且该分支**零调用点**）。
⚠️ **勿把这个口径推广到 `chest`**（E2E 的 `chest === 0` 断言与之同理但口径不同）——
`chest` 在 `scatter.js:543` 与 `:575` **有生成点**（house / 沉船），所以
`sky-structures.spec.mjs` 的 `chest === 0` 是**关于岛顶扫描窗口**的断言，
**不是全世界的断言**。两者混写会得出错误结论。
故改 `cullMode` 的影响面 = ①本次新增的天空树 ②玩家从背包手动放置的 `sky_leaves`。
**不影响任何既有世界内容、不影响任何既有断言的视觉预期。**

⚠️ **② 不是「零影响」，须展开**（二次审核补录）：`sky_leaves` **在背包物品集合内**
（既不在 `NON_PLACEABLE_ITEMS` 也不在 `HIDDEN_FROM_INVENTORY` —— 后者实测为
chimney + 三个床方块 + 创造台两项），玩家可从背包选中并放置。方案 C 下这些**手动放置**的
`sky_leaves` 会获得 §2.6.3 第 2/3/4 项的三处新行为：

| 新行为 | 玩家可感知的后果 |
|---|---|
| 成为 AO 遮挡物（第 2 项） | 手动搭的叶墙会在相邻方块上投暗角（与 `stone` 一致） |
| 阻断 blocklight（第 3 项） | 叶墙会挡住灯光传播（与 §2.6.3 第 3 项补录的「玩家放光源」路径同源） |
| 阻挡炮塔 LOS / 弹丸（第 4 项） | 玩家可用 `sky_leaves` 造「叶墙」挡丧尸视线与弹丸 —— 这是一处**新增玩法可能性**，不是缺陷 |

这三处都属**方案 C 的既定连带效应**（用户已选定 C），此处只是把「影响面 ②」从一句话
展开成可核对的清单 —— 免得实施者以为「手动放置」这条路没有语义变化。
**注意它与 ① 的差别**：① 的树在高空、交集小；② 完全由玩家意图驱动，交集大小取决于玩家怎么用。

### 2.2 数据流与层序

`applyStructuresToColumn()`（`apply.js` 阶段 2.5）已在做「云先写、岛体后写」；本次在其后追加树层：

```
writeClouds()        Y=55 单云层 + Y=35 连通云簇
writeIslands()       岛体（底层 sky_stone / 顶层 sky_grass）
writeSkyTrees()      ← 新增：顶层逐格 10% → generateTree(..., 'skyTree')
```

层序正确性由**几何不重叠**保证，不依赖写入顺序：

- 树基点 = `topY + 1`（`topY = bottomY + height`），岛体最高格 = `topY` → **树不覆盖岛体**；
- 树冠与 Y=55 单云相交时**树覆盖云** —— 与 mc-lite 一致（`Island.generate` 在
  `WorldWorker.js:1170`，单云在 `:1125`，岛在云之后生成，树在岛内部生成）。

树的 Y 上界（勘查实测）：`bottomY ≤ 69`、`height ≤ 7` → `topY ≤ 76`；树冠最高
`topY + 1 + 4 = 81` < `WORLD_MAX_Y = 96`。**不越界**，且 `makeColumnSetter` 自带 Y 边界检查兜底。

### 2.3 岛层半径的单一权威（红线 1）

`writeIslands` 现有逐层圆判据是 `Math.floor(radius * Math.pow(y / height, 0.7))`。
`writeSkyTrees` 需要同一个顶层圆的格集合 —— 若各写一份，两处漂移会产出
「树长在岛体之外悬空」或「岛顶层有格却没被扫到」的撕裂（肉眼可见但难归因）。

抽为纯函数：

```js
/** 岛层半径（mc-lite Island.generate 的逐层收窄判据，单一权威） */
export function islandLayerRadius(radius, y, height) {
  return Math.floor(radius * Math.pow(y / height, 0.7));
}
```

`writeIslands` 内部改用它（行为等价：`y` 与 `height` 同值时结果不变）；
`writeSkyTrees` 用 `islandLayerRadius(radius, height, height)`，即顶层半径。

### 2.4 跨 column 一致性（本次改动**最易出 bug** 的点）

`writeIslands` 现有的候选 AABB 门控是 `centerX ± radius`（岛体最大水平半径）。
但树冠从基点向外扩 **±2**（`vegetation.js:22-29` 的 `lx`/`lz` 循环范围）→ 树的实际水平足迹是
`centerX ± (radius + 2)`。

若沿用岛体门控，会出现：**某 column 与岛体 AABB 不相交、却有树冠落入** → 该 column 被 `continue`
跳过 → 这棵树的树冠在相邻 column 上**断裂缺失**（半边树冠）。方块层面岛体完全正常，
所以肉眼只看到「岛边缘的树缺了一角」，很难归因到门控。

修法：`writeSkyTrees` 的 AABB 门控用 `radius + 2`。写入裁剪仍由 `setBlock`
（`makeColumnSetter`）承担 —— 树基点在哪个 column 都能正确裁到当前 column，
与既有 `writeIslands` / `writeCloudClusters` 同一手法（M2-7 规格 §2：
「生成侧以候选 AABB 过滤，不能假定结构中心与当前 column 相同」）。

跨 column 逐格一致的判据（既有 M2-7 口径，本次沿用）：**判定与生成都只吃世界坐标** ——
`seededRandom(wx, wz, seed + salt)` 与 `generateTree` 内部的 `treeRand(lx, lz, ...)`
均以世界坐标为输入 → 同一格在任何 column 的生成过程中判定结果与形状完全相同。

### 2.5 树冠重叠与面剔除（方案 C 口径）

勘查实测（region [-1,1]²，474 个岛 / 112101 岛对）：岛体 AABB+Y 重叠 **14 对（0.030 对/岛）**，
含树冠外扩 2 格后 **58 对（0.122 对/岛）**；岛心切比雪夫距离最近 16、p1=64、中位 560。
→ 岛与岛之间的树冠重叠是**低频事件**，不需要去重或合并处理（重叠格由 `setBlock` 后写覆盖，
结果确定）。

岛**内部**的树冠重叠是**高频**的：10% 密度下相邻树冠必然穿插。用户已确认**不加间距**，
观感即 mc-lite 的「连绵叶团」而非独立树木。

#### 2.5.1 ⚠️ 重叠不只发生在「叶盖叶」—— 后写的树叶会盖掉先写的**树干**

> 这一小节是评审后补的（`docs/superpowers/reviews/2026-09-20-sky-tree-review.md` §1.1）。
> 原文只论证了「重叠格由 `setBlock` 后写覆盖，结果确定」—— 这句**没错但不够**：
> 它只想到「叶盖叶」，没意识到**后写树的树冠会覆盖先写树的树干格**。

`makeColumnSetter`（`landmarks.js:268-278`）**无条件覆盖**目标格，没有「已占用则跳过」的守卫：

```js
column.blocks[idx] = id;   // 无「已占用则跳过」判定
```

而 `writeSkyTrees` 在双层循环里**逐棵树依次**调 `generateTree`。树 A 的树干在
`(wx, topY+1..topY+4, wz)`，后写的树 B 的树冠（`wx±2 / wz±2 / y+2..y+4`）可以落到 A 的树干格上
→ **A 的树干被树叶覆盖**。实测规模（seed=12345，region [-2,2]²）：

| 指标 | 实测值 |
|---|---|
| 树干格总数 | 81,432 |
| 最终不是 `sky_wood` | **17,460 = 21.4%** |

**这是与 mc-lite 的真实偏离**：mc-lite 的 `fakeChunk.add`（`WorldWorker.js:532-538` /
`:1508-1518`）**有占用格守卫** ——

```js
// 关键修复：严格检查该位置是否已有方块
// 规则：只要该位置已有任何非空气方块，就不允许再放置任何方块
const existing = blockMap.get(key);
if (existing && existing.type !== 'air' && type !== 'air') return;
```

→ mc-lite 里「先写的树赢」，mc-heavy 里「后写的树赢」。已记入 §8 偏离清单。

⚠️ **该偏离不是本任务引入的，是既有的、全局的**：地面树走同一条路径
（`apply.js` 的同一个 `makeColumnSetter` + 同一个 `generateTree`），地面林地的树干同样会被
邻树树冠覆盖。本任务的独特性在于**它是第一个把这个隐含假设写成断言的地方** ——
断言把既有偏离暴露了出来（见 §6.2 第 4 条的断言形态修正）。

**处置：本次不改 `makeColumnSetter`**（加守卫会影响**全部**结构路径：岛体 / JSON 光栅化 /
撒布 / 城市 / 植被，每条都要各自回归，且会改变既有世界内容 → 地面林地形状变化 →
视觉比对基准变化 → 可能触发其它 spec 的截图断言）。正确做法是**让断言忠实描述实际行为**
（§6.2 第 4 条），并把偏离登记进 §8。

**方案 C 下的面剔除行为**（实测，与现状 cutout 有本质差别）：

`mesher.js:464` 的剔除判据是 `opaqueTable[neighborId] === 1`。方案 C 让 `sky_leaves`
的 `opaqueTable` 从 0 变 1 → **叶-叶相邻面开始互相剔除**：

| 场景 | 现状 cutout（`opaqueTable=0`） | 方案 C（`opaqueTable=1`） |
|---|---|---|
| 两格相邻 `sky_leaves` | 48 顶点（6 面/格，**零剔除**） | 40 顶点（5 面/格，共享面被剔） |
| 纯 3×3×3 叶团（27 格） | 648 顶点（162 面，**一面不剔**） | **216 顶点（54 面，只出外壳）** |
| 两棵重叠树（基点 (7,7)+(9,9)） | cutout 2084 顶点 | — |

⚠️ **注意方案 C 不需要加 `SAME_TYPE_CULL`**：`opaqueTable=1` 已经让 `:464` 的通用剔除生效，
`:465` 的同类剔除（`cullMode >= 2 || SAME_TYPE_CULL.has(name)`）是**给 `opaqueTable=0` 的方块用的**
（如 `cloud`：它 `cullMode:opaque` 但 `opaque:false` → 走不进 `:464`，只能靠 `SAME_TYPE_CULL`）。
方案 C 走的是 `:464` 主路径，`mesher.js` **零改动**。

#### 2.5.2 ⚠️ `surrounded` 生成期跳过在方案 C 下**不是等价优化，而是反向悲观化**（二次审核实测修正）

> 原文此处写「方案 C 下被包围的叶格本就被 mesh 剔除，生成期跳过是更早一层的**等价优化**，
> 两层不冲突」—— **这句是错的**，属 §9 已命名的同一类错误（读定义推断，未实测）。
> 它只在 **cutout** 通道下成立；方案 C 把 `opaqueTable` 置 1 后，机制**反转**。

`vegetation.js:79-84` 的 `surrounded`（移植自 mc-lite `Tree._addOptimized`）跳过六邻全被树块
包围的叶格。两种通道下的净面数效果**方向相反**：

| 通道 | 被包围叶格「写入」的面数 | 「跳过（留 air）」的面数 | 跳过的净效果 |
|---|---|---|---|
| cutout（现状，`opaqueTable=0`） | 6 面（叶-叶**不互剔**，`:464` 判据不成立） | 0 面 | **省 6 面** → 优化 ✅ |
| **方案 C**（`opaqueTable=1`） | **0 面**（自己 6 面全被邻居剔 + 邻居朝它的面也被剔） | **6 面**（6 个邻居各朝 air 出 1 面） | **多 6 面** → 悲观化 ⚠️ |

**实测（真实管线，seed=12345，探针按 `:464` 语义逐格算面）：**

| 维度 | 实测值 |
|---|---|
| 单棵 skyTree：不跳过的全集 vs 实写 | 58 格 → **51 格**（跳过 7 格） |
| 单棵面数：现状 cutout + 跳过 | 295 |
| 单棵面数：**方案 C + 跳过**（= 现状实现） | **168** |
| 单棵面数：**方案 C + 不跳过**（全写） | **146** ← 更省 |
| region [-1,1]²（= 9 个 region / 5625 chunk）7379 棵树：跳过 vs 全写 | 1,178,494 vs 1,146,064 面 → **跳过净增 32,430 面（+2.8%，相对树面数）≈ 130K 顶点** |

（单棵净增 22 面 < 7 格 × 6 = 42，因被跳过的格彼此相邻时不重复出面 —— 用实测值，不按公式推算。）

⚠️ **换算到本仓的验收口径（vd=8）后，绝对量很小** —— 勿把上面的 region² 总量当成场景增量：
§4.3 实测树对 vd=8 全场景的面数贡献是 700,064 − 672,206 = **27,858 面**，按 +2.8% 算
→ 乙只能再省约 **780 面 ≈ 3.1K 顶点**，相对 700,064 总面数仅 **0.11%**。
（+2.8% 这个**比例**是尺度无关的、可传递的；绝对面数随扫描区域大小线性变。）

**这不推翻方案 C 的结论**：§4.3 的 700,064 面**已包含**这 2.8% 悲观化（它测的就是现状实现），
仍比现状 cutout 的 735,576 少 4.8%，三通道容量与 `gpuVertexBytes` 结论不变。
**错的只是「两层不冲突、不用改」这个论证** —— 实际上有一处**真实的优化机会被漏掉了**。

**须由用户决策（规格此前未呈现这个分叉）：**

| 选项 | 做法 | 收益 | 代价与连带 |
|---|---|---|---|
| **甲** 保持现状（默认） | `vegetation.js` 零改动，接受 +2.8% 树面数 | 改动面最小；§4/§5/§6 全部实测数字与断言**原样有效** | 白留的量很小：vd=8 口径约 **780 面 ≈ 3.1K 顶点**（占总面数 0.11%） |
| **乙** 条件化跳过 | `surrounded` 判定加「该叶块 `opaqueTable === 1` 则不跳过」→ `sky_leaves` 全写、地面 `leaves` 族仍跳过 | vd=8 口径再省约 780 面（0.11%） | ① 须把 `registry`/`opaqueTable` 传进 `generateTree`（Worker 同构层共享函数，**地面树也走它** → 须回归地面林地）；② **改变方块数据**（树冠内部多约 0.78 格/棵的实心叶）→ §1「不改树冠形状」的范围声明须放宽；③ §4.3 面数、§6.2 第 4 条的「忠实写入顺序模拟」都要按新语义重算重测 |

**建议取甲**：乙的收益换算到验收口径只有 **0.11% 总面数**（vd=8 约 780 面），
**不在任何冻结预算的临界点上**（opaque 79% < maxVerts、`gpuVertexBytes` 148.1 < 150MiB，
两项都有余量），而它的代价是**动 Worker 同构层的共享函数 + 改变既有地面树数据 +
重跑全部勘定实测**（红线「改动放大器」）—— 收益与代价不成比例。
若将来 opaque 通道逼近容量临界，再单独开任务做乙。

⚠️ 无论甲乙，**§6.2 第 4 条的「忠实写入顺序模拟」必须与实现的 `surrounded` 行为同构**。
**已核实：计划已满足** —— `simulateIslandTrees`（计划 Task 3）**直接调真实的 `generateTree`**
（而非重写一份树叶判定），故 `surrounded` 跳过天然同构：甲下**零改动**，
若选乙，模拟侧也跟着自动生效（同一个函数）。
⚠️ 这条同构性**不得退化**：若后人为了「让模拟更可读」而把 `generateTree` 的树叶判定
抄一份到测试里，就会在选乙时静默漂移出假失败（红线 8 的同源要求）。

另：`surrounded` 集合按**名字**判定（`TRANSPARENT_LEAF` 含 `sky_leaves`），与 `cullMode` 无关
→ 方案 C **不会**让它自动失效，它照旧跳过（这正是悲观化的来源）。

### 2.6 `sky_leaves` 通道修正（方案 C）—— 本次的第二个交付物

#### 2.6.1 根因：M2-7 移植时的通道归属偏差

`blocks-data.js:6` 记录的转换规则是「**名字含 leaves → 'cutout'**（8 个树叶族，含 `sky_leaves`）」——
按**名字**归类，而非按 mc-lite 的**材质**归类。但 mc-lite 的 `sky_leaves` 材质不是镂空：

```js
// mc-lite MaterialManager.js
materials.registerMaterial('leaves',     { textureUrl:'leaves.png', transparent:true, alphaTest:0.3 }); // ← 真镂空
materials.registerMaterial('sky_leaves', mkMat('#FF69B4', 0.9));  // ← 无 alphaTest
// mkMat(col, op) → { color:col, opacity:op, transparent: op < 1 }
//   → sky_leaves = transparent:true + opacity:0.9，纯 alpha 混合，与 water/cloud/sky_stone 同族
```

atlas 实测印证（解码 `assets/atlas.png` 读 tile 中心像素）：

| tile | 中心 RGBA | alpha | 在 cutout 通道（`alphaTest=0.3`、无 `transparent`）下的实际渲染 |
|---|---|---|---|
| `procedural/sky_leaves` | `[255,105,180,230]` | **0.902** | 0.902 > 0.3 → 像素**全部保留**且不混合 → **不透明纯粉** |
| `leaves`（对照） | `[25,103,44,59]` | 0.231 | 0.231 < 0.3 → **discard** → 真镂空 ✅ |

**即：`sky_leaves` 那个 0.9 的半透明从未被消费过，当前渲染出来就是不透明粉色实心块。**
改成 opaque 通道**不损失任何现有视觉效果**（唯一新增视觉是 AO 暗角，见 §2.6.3）。

#### 2.6.2 四方案实测对比（vd=8 / 289 列 / 有树）

| 方案 | 声明 | 总面数 | 三通道 `reservedV` 占用 | `gpuVertexBytes` | 连带效应 |
|---|---|---|---|---|---|
| **A** 现状 cutout | `cullMode:cutout` | 735,576 | o:75% c:**68%** t:41% ✅ | 148.1MiB ✅ | 无（但面数最多） |
| **B** transparent | `cullMode:transparent` | 702,114 | o:75% c:55% t:**140% ⚠️** | **152.0MiB ⚠️** | 唯一真正实现 0.9 半透明；`depthWrite=false` |
| **C** ✅**已选** | `cullMode:opaque`（`opaqueTable=1`） | **700,064** | o:**79%** c:55% t:41% ✅ | **148.1MiB ✅** | AO 遮挡 + blocklight 阻断 + 炮塔 LOS 阻挡（§2.6.3） |
| D | `cullMode:opaque` + `opaque:false` | 735,576 | o:**85%** c:55% t:41% ✅ | 148.1MiB ✅ | 无，但面数与 A 相同（无叶-叶剔除）→ 无意义，排除 |
| E | D + `SAME_TYPE_CULL` 加 `sky_leaves` | 702,114 | o:79% c:55% t:41% ✅ | 148.1MiB ✅ | 无（与 mc-lite AO 语义一致）；须改 `mesher.js:288` |

**选 C 的理由**（用户决策）：面数最少（700,064，比 A 少 4.8%）、三通道全守住、
`gpuVertexBytes` 不变（**不动 §4.10 冻结预算**）、`mesher.js` 零改动、
且「一棵树整体阻挡视线」比「树干阻挡而树冠不阻挡」语义更一致（`sky_wood` 本就 opaque+solid）。
代价是三处语义连带效应（§2.6.3），均实测确认影响面很小，且已记入 §8 偏离清单。

> **方案 B 被否的原因**（存档）：它是唯一能真正实现 mc-lite 那个 0.9 半透明的方案，但
> `CAPACITY.transparent` 只有 `{active:100, avgVerts:1000}` → maxVerts **125,000**
> （三通道最小，此前只有 water/swamp_water/glass_block/glass_blink 四种方块用它），
> 有树后需 175,470（**140%**）→ 触发离散 ×1.5 扩容到 263,205 → `gpuVertexBytes` 152.0MiB，
> **撞破 §4.10 的 150MiB 冻结预算**，须重标定 + 放宽预算（架构口径变更）。
> 且 `depthWrite=false` 下多层树冠的混合观感须额外验证。用户判定「没必要一定 transparent」。

#### 2.6.3 方案 C 的三处语义连带效应（`opaqueTable` 0→1）

`opaqueTable` 有 5 类消费者（grep 实测），其中 3 类会因本次改动改变行为：

| # | 消费者 | 变化 | 实测影响 | mc-lite 对应语义 |
|---|---|---|---|---|
| 1 | `mesher.js:464` 面剔除 | 叶-叶相邻面开始剔除 | ✅ **收益**：面数 735,576→700,064 | mc-lite 实例级渲染无此概念 |
| 2 | `mesher.js:436-438,500-502` **AO 遮挡** | `sky_leaves` 成为 AO 遮挡物 | ⚠️ 单格遮挡实测：地面暗顶点 **0→20**（与 `stone` 一致）。真实树形下**树冠内部面已被剔除**（AO 不可见），可见效应集中在树冠外表面凹陷处与树冠-岛面交界。**注意：树在岛面投的 20 个暗顶点全部来自树干**（`sky_wood` 本就 opaque），与本项无关 | ⚠️ **偏离**：mc-lite `AOUtils.js:376` 的 `isOccluding = !props.isTransparent`，而 `sky_leaves.isTransparent=true` → mc-lite **不遮挡 AO** |
| 3 | `lighting.js:165` **blocklight BFS** | `sky_leaves` 阻断 blocklight 传播 | ⚠️ 空岛在 Y=40..76 高空，**自然生成**的附近通常无光源 → 该路径交集极小。⚠️ **但漏了一条路径（二次审核补录）：玩家可在空岛上手动放光源** —— 4 个 `emissive:15` 方块（`glowstone` / `ochre_froglight` / `lava` / `hanging_lamp`）**都在背包物品集合内**（均不在 `HIDDEN_FROM_INVENTORY`），玩家上岛后放灯，光会被树冠挡住（树下变暗）。规模仍小（须玩家主动上岛放灯），但**不是「附近无光源」可概括的** | mc-lite 光照传播不查 `isTransparent`（grep 零命中）→ 无对应语义。**skylight 不受影响**（v1.9 口径全列恒 15，遮挡模型未启用） |
| 4 | `turret-system.js:31` **炮塔 LOS / 弹丸阻挡** | `sky_leaves`（`solid:true` + `opaque:1`）开始阻挡视线与弹丸 | ⚠️ 树冠后的丧尸打不到、弹丸会被树叶挡。炮塔在地面、树在高空 → 实际交集仅「玩家在空岛上放炮塔」 | ⚠️ **已核实：偏离**。mc-lite `Turret.js:559-565` `isBlockOccluding = props.isSolid && !props.isTransparent`，而 `sky_leaves.isTransparent=true` → **不阻挡**。mc-heavy 的 `isProjectileOccluding = solidTable && opaqueTable` 与其同构，但方案 C 把 `opaqueTable` 置 1 → 变成阻挡 |
| 5 | `world-data.js:91` `isOpaque()` | 返回值变 true | grep 实测**零消费者** → 无影响 | — |

⚠️ **第 2/3/4 项都是有意偏离 mc-lite**，须记入 §8 偏离清单，并在验收时确认观感可接受。
第 4 项须在实施时**实测确认**（在空岛上放炮塔 + 丧尸，验证树冠阻挡行为是否符合预期）；
若不可接受，回退方案是 E（`opaque:false` + `SAME_TYPE_CULL`），容量代价相同（79%）。

## 3. 确定性与 salt 口径

### 3.1 salt 选值：113（**不能用 59**）

⚠️ **勘查期差点踩的坑，必须记下来**：`sky-structures.js` 的注释写「frontier 每一步 `seed+58` 加步号」，
容易读成「云簇只占用 58 这一个 salt」→ 顺手取 59 给树。**实际 59 已被占用**：
`computeClusterCells` 的 `step` 上界 = `size - 1`，而 `size = 30 + floor(r * 21) ∈ [30, 50]`
→ 云簇 frontier 的 salt 实际占用 **58..107 的连续区间**。

同理 `landmarks.js:239` 的 `seed + 302 + y`（`y ∈ [-32, 96)`）实际占用 **270..397**，
`terrain.js:100` 的 `seed + 100 + k`（`k = 2..12`）占用 **102..112**。

程序化扫描（展开全部派生区间，234 个已占用 salt）后，`1..500` 内的连续空闲带：
`6..9`、`27..49`、`113..199`、`202..269`、`398..400`、`408..500`。

**取 `113`** —— 理由：紧跟空岛段（50..58）与云簇段（58..107）之后的第一个空闲值，
与「空中结构」这一族在数值上相邻，便于后续读者建立关联；且 113..199 是 87 个连续空闲位，
未来空中结构再加随机量有余量。

> **沉淀为活跃约束**（写入 CLAUDE.md）：`seededRandom` 的 salt **不能按注释里的字面基值判断占用** ——
> 带 `+ step` / `+ k` / `+ y` 偏移的调用点实际占用的是**区间**。新增随机量前须程序化扫描
> （展开所有派生区间），不能 grep 字面量。

### 3.2 判定口径

```js
// 顶层每个岛格独立判定（mc-lite Island.js:48 `Math.random() < 0.1`）
if (seededRandom(wx, wz, seed + SKY_TREE_SALT) < SKY_TREE_CHANCE) {
  generateTree(wx, topY + 1, wz, setBlock, seed, 'skyTree');
}
```

- `SKY_TREE_SALT = 113`、`SKY_TREE_CHANCE = 0.1` 作为**导出常量**放在
  `sky-structures.js`（与既有 `SINGLE_CLOUD_Y` / `CLOUD_CLUSTER_Y` 同手法）—— 单一权威，
  测试与实现读同一处，不各写字面量（红线 1；同 M6 `ZOMBIE_MOVING_EPSILON` 的教训）；
- 判定输入是**世界坐标** `(wx, wz)`，不是局部坐标 → 跨 column 同格判定一致（§2.4）；
- mc-lite 的 `Math.random()` → `seededRandom`：这是**红线 2 的强制替换**，
  只保留「逐格 10% 独立判定」的分布语义，不保留其不可复现性。与 M2-7 对
  岛半径/高度（`+56/+57`）、云簇 frontier（`+58+step`）的处理完全同口径。

### 3.3 一处**有意保留**的差异：树形状随机源

`generateTree` 的 `'skyTree'` 分支内部用 `treeRand(lx, lz, seed + ly * 7, 401)`
做树叶稀疏化（`vegetation.js:23`），salt 401 与既有地面树**共用**。这是 M2-3 移植时的既有实现，
本次**不改**：它的输入同样是世界坐标 → 确定性成立，且共用 salt 不产生冲突
（不同 `(lx, lz)` 输入本就产出不同值，salt 相同只是让天空树与地面树的稀疏图案统计特性一致，
这正是 mc-lite 的行为 —— 它也共用同一个 `Math.random` 流）。

## 4. 观测数据（勘查实测，非推算）

以下均为本次勘查用真实生成管线（`fillColumn` + `carveCaves` + `applyStructuresToColumn`）
与真实 mesher（`buildSectionMesh` + `WorldData.getSectionView` 含 halo）跑出的数字，seed=12345。

### 4.1 结构规模

| 指标 | 实测值 |
|---|---|
| 岛密度 | 0.0843 个/chunk（8% 候选 × 有效率） |
| 视距 8（17×17=289 chunk）视野内岛数 | 约 24.4 个 |
| 岛顶层格数 | 均 156.7 格/岛（`radius` 5..9、`height` 5..7） |
| 10% 密度 → 每岛树数 | 期望 15.4 棵（实测 15.4） |
| `bottomY` 范围 | 40..69；顶层最高 Y=76，树顶最高 Y=81 |
| 视距 8 全场景树数 | **约 334 棵**（树干格 1336 ÷ 4） |

### 4.2 单棵树 mesh 成本（18³ 隔离 section）

| 通道方案 | 顶点合计 | 每格叶成本 |
|---|---|---|
| 现状 cutout | 1368（cutout 1296 + opaque 72） | 24.9 |
| **方案 C opaque** | **624**（全部 opaque） | **11.3** |
| 方案 B transparent | 648（transparent 576 + opaque 72） | 11.8 |

方案 C 比现状**省 54%** 顶点。对照：605 格实心 `stone` 立方体（11×5×11）= 1848 顶点
（每格 3.05）—— 一棵 59 格的树（624 顶点）仍然比它便宜 3 倍。

### 4.3 全场景性能（vd=8 / 289 列 / 有树 + 方案 C）

| 维度 | HEAD | 有树 + 方案 C | 增量 | 预算 |
|---|---|---|---|---|
| **GEN** p95（Worker 内，289 样本） | 1.206ms | 1.534ms | **+0.328ms** | §4.2 的 **8ms** ✅（占 19%） |
| GEN 合计（289 列） | 274.1ms | 299.4ms | +25.3ms（+9.2%） | — |
| **MESH** 全量遍历（交替对照，vd=6/169 列，各 5 轮） | 中位 537.0ms | 中位 539.4ms | **+0.4%** | — |
| **总面数**（GPU 光栅化量） | 672,206 | **700,064** | **+4.1%** | 须 bench 实测 fps |
| **draw call** | 3 | 3 | **0** | — |
| opaque `reservedV` | 74% | **79%** | +5pt | maxVerts 2.85M ✅ |
| cutout `reservedV` | 55% | **55%** | **0** | maxVerts 2.2M ✅ |
| transparent `reservedV` | 41% | **41%** | **0** | maxVerts 125K ✅ |
| `gpuVertexBytes` | 148.1MiB | **148.1MiB** | **0** | §4.10 的 150MiB ✅ |

对照（若不改通道，保持 cutout）：面数 **+9.4%**、cutout 占用 55%→**68%**、MESH **+3.4%**。
方案 C 把树的几何增量**减半**，且完全不动 cutout 通道。

⚠️ **MESH 时间必须用交替对照**：首轮顺序测量（先 HEAD 后有树）得出「有树反而快 60ms」，
机制上不可能（面数明明增加）—— 是 JIT 预热的顺序效应。改为每轮交换顺序、各 5 轮取中位后
得到 +0.4%。同 CLAUDE.md 对 `bench` frameP95 门禁的「交替对照」要求。

## 5. 性能与容量口径

### 5.1 结论：三通道全守住，不动任何冻结预算

方案 C 在 CAPACITY 的**设计口径（视距 8）**下：

- opaque `reservedV` 79% < maxVerts 2.85M ✅
- cutout 55%（**零变化** —— 树不进 cutout）✅
- transparent 41%（零变化）✅
- `gpuVertexBytes` **保持 148.1MiB** < §4.10 的 150MiB ✅（未触发任何通道扩容）

→ **不需要重标定 `CAPACITY`，不需要放宽 §4.10，不需要降密度。**
这是方案 C 相对方案 B 的决定性优势（B 会撞破 transparent 通道 → 152.0MiB）。

⚠️ **口径提醒（勘查期我自己踩过的坑）**：`render-world.js:9` 明确写 CAPACITY 是
「**视距 8** 容量口径」。不要用 vd=10（= scheduler 的加载半径 `R+2`）去论证撞破 ——
实测 HEAD 在 vd=10 下 opaque 就已 111.2% 撞破，**与天空树无关**，属奔跑态瞬时扩容的
正常设计（`optimize()` 回收后回落）。

### 5.2 须由真 GPU 裁决的一项：填充率

面数只 +4.1%，但**方案 C 把树从 cutout 挪进 opaque**，两个通道的材质设置不同：

- cutout：`alphaTest: 0.3` + `FrontSide`（`materials.js:74`）
- opaque：无 `alphaTest` + `FrontSide`（`materials.js:69`）

opaque 通道可以 early-z 剔除、无 alpha 测试开销，**理论上每面成本更低**；但 opaque 的
`reservedV` 占用从 74% 升到 79%，顶点缓冲的实际工作集变大。Node 环境无 WebGPU，
**这一项只能靠 `bench -- --check` + `m3-fullscene` 的实测 fps 裁决，本 spec 不宣称无影响**。

实测须记录：`memoryStats().gpuVertexBytes` / `gpuActiveBytes`、
`renderWorld._capacity.*.maxVertexCount`（判定是否发生过扩容的直接证据）、
bench 四场景的 fps / frameP95 / draw call、`genP95`。

### 5.3 撞破处置（用户已确认）

若实测出现下列任一情况，**停下报告，带数据等用户决策** —— 不擅自改断言、不静默降密度、
不重写基线（AGENTS.md「冻结的断言数字实测不符时停下来报告」）：

1. `gpuVertexBytes ≥ 150MiB`，或任一通道 `_capacity.*.maxVertexCount` 超过其标定 maxVerts（= 发生过扩容）；
2. `bench -- --check` 报任一场景回退 > 10%；
3. `genP95` 撞破 §4.2 的 8ms。

报告须附**交替对照**数据（同会话内 `git stash` HEAD 与改动侧交错各跑 2~3 次比分布，
不看单次数值 —— `bench` 的 frameP95 门禁在 vsync 量子边界上会随机翻转，
roadmap「M8/M9 之后的遗留 TODO」第 1 条已记此陷阱）。

诊断期间**不得提交** `docs/m3-baseline.*` —— 不带 `--check` 跑 bench 会自动重写冻结基线，
提交它会静默放宽门禁（roadmap 已记该踩坑）；诊断后 `git checkout` 恢复。

**若需回退**：方案 E（`cullMode:opaque` + `opaque:false` + `SAME_TYPE_CULL` 加 `sky_leaves`）
容量代价与 C 相同（opaque 79%），但消除 §2.6.3 的第 2/3/4 项连带效应。

## 6. 测试分级与断言清单

判据按 `docs/testing-policy.md`：改**确定性 gen 纯函数算法** + 改**方块数据契约**（`cullMode`）
= **Tier 1**（改坏了是静默数据错误，肉眼玩不出来）→ **走 TDD**（RED → 验证 RED → GREEN →
验证 GREEN → REFACTOR）；触及 mesh 顶点量与渲染通道 → 加 Tier 4 像素实测 + `bench -- --check`。

### 6.1 既有断言的影响（核实后：**只有 E2E 会真失败**）

⚠️ 勘查核实纠正了一处直觉错误：现有**浏览器内单测不会因树而失败**，因为它的扫描
范围是岛体 Y 区间（`y = bottomY..maxY`，`maxY = bottomY + height = topY`，见
`test-sky-structures.js:145`），而树在 `topY+1` 以上 —— **树不在扫描范围内**。

| 位置 | 现断言 | 是否失败 | 处置 |
|---|---|---|---|
| `src/tests/test-sky-structures.js:124` | 用例名含「无 chest/天空树」；`:145` 扫描 `y=bottomY..topY`；`:170` `assertTrue(skyId.has(id))` | ❌ **不会失败** | ① **改名**去掉「无天空树」（名字会变成谎话）；② **不改**这条岛体用例的断言 |
| `tests/sky-structures.spec.mjs:103-123` | `forbidden` 把 `chest`/`sky_wood`/`sky_leaves` 三者一起数，扫 `topY+1` 的 `dx,dz ∈ -2..2`，断言 `=== 0` | ✅ **会失败** | **拆开**：`chest === 0` 保留（宝箱仍不迁移）；`sky_wood`/`sky_leaves` 改为 `> 0`，并断言树干底格正下方是 `sky_grass` |

⚠️ **不得放宽无关部分**：岛体逐格形状、`cloudInside === 0`（岛体覆盖云）、
`singleCloud > 0` / `clusterCloud > 0` 全部原样保留。E2E 的 `forbidden` 拆开时，
`chest` 计数须仍用同一扫描区（只把 `sky_wood`/`sky_leaves` 移出 `forbidden`）。

#### 6.1.1 ⚠️ E2E `treeWood > 0` 的真实风险是**脆性**，不是概率（评审后实测修正）

原版（与计划 Task 5）用「10% × 156.7 格 → 全不长的概率 ≈ 0.9^157 ≈ 6e-8」论证风险可忽略。
**这个论证用错了口径**：E2E 跑的是**固定 `?vd=8&seed=12345`**，世界完全确定性（红线 2）——
那个岛要么有树、要么没树，**不存在 5.4% 或 6e-8 的概率空间**。把概率写进文档会误导后人
以为「偏发失败可以重跑」。

实测（按 E2E 的同一条选岛路径：出生点 `(283,117)` = `getCitySpawnPoint(region 0,0)`，
取最近的岛）：

| 项 | 实测值 |
|---|---|
| 选中的岛 | `centerX=312, centerZ=120, bottomY=49, radius=5, height=7`（距出生点 29.2 格） |
| 计划的 `treeWood`（±2 窗口、`topY+1` 层） | **2** → `> 0` ✅ |
| 计划的 `canopy`（±4、dy 1..6） | **165** → `> 0` ✅ |
| 该岛顶层圆内全岛树数 | 10（`radius=5` 是小岛，低于均 15.4） |

**真实风险 = 脆性**：`treeWood=2` 是**余量很小**的通过（不是「期望 15 棵」）。
若将来换 seed、改岛生成参数（salt 50/51/56/57）、或改出生点，这个值可能静默变 0
→ 假失败，而失败信息看起来像「树根本没长」。

**处置**：① 实施时**必须记录实跑值**（`treeWood` / `canopy` / `isl.radius`）写进验收报告；
② 若实跑得 0，先确认是否选到了小岛/中心无树的岛 → **扩大扫描窗口**（如 ±4，或扫整个顶层圆），
**不得放宽成 `>= 0`**（那是把断言改成恒真）。
⚠️ 评审报告建议的「扩大窗口」方向正确，但**不要把它的 5.4% 当作本 spec 的风险口径引用**。

⚠️ **已核实的既有单测影响面**（grep 全仓 `sky_leaves` 于 `src/tests/` 与 `tests/`）：
除 `sky-structures.spec.mjs:89` 外**零命中** —— 即：
- `test-vegetation.js` **没有**断言 `sky_leaves` 走 cutout 通道 → 无需反转；
- `test-mesher.js:568` 遍历 `BLOCKS` 断言「`cullMode !== 'none'` 的方块都有贴图」——
  方案 C 不删贴图（`faces-data.js:30` 的 `procedural/sky_leaves` 保留），**仍通过**；
- `src/tests/` 下无任何用例断言 `sky_leaves` 的 `cullTable`/`opaqueTable` 具体值
  → §6.2 第 5 条是**全新契约**，不会与既有断言冲突。

以上三条均须在实施后**实跑确认**（`npm run check` + 浏览器内单测），不以 grep 结论代替运行结果。

### 6.2 必须**新增**的断言（防本次改动的五类真实失效模式）

> ⚠️ **本小节已按实测修正（评审后）**。原版第 1/2/4 条的断言形态都是「关于世界的想象」：
> 第 4 条假定「每格树干都是 `sky_wood`」（实测 21.4% 被后写树叶覆盖，§2.5.1）；
> 第 1 条用取模启发式选点（负坐标下恒真）；第 2 条押在「树干底格下方是 `sky_grass`」
> （实测 0/300 个岛能因圆判据漂移而 FAIL，无检验力）。下面每条的判据都在真实数据上跑过。
>
> **通用纪律（新增，已建议同步进 `docs/testing-policy.md` §2.5）：新写的断言必须先在真实
> 数据上跑一次、打印实际值，再决定断言写成什么。**

1. **跨 column 树冠完整**（防 §2.4 的 AABB 门控漏写）—— 本次最关键的新增用例：
   选一棵树冠真跨界的空间树，对涉及的每个 column **独立**生成后重组世界坐标集合，断言与
   「单 column 内一次性生成」的参照树**无缺格**。
   - ⚠️ **选点判据必须按真实足迹算，不得用取模启发式**（原版
     `Math.min(t.wx % 16, 16 - (t.wx % 16))` 在负坐标下是**取余**而非取模：
     `wx=-1197 → Math.min(-13, 29) = -13` → 恒 `<= 2` → **条件恒真** → 退化为「取第一个岛的
     第一棵树」，而那棵树不跨界）。正确写法：直接枚举树冠 `±2` 覆盖的 column 集合，
     `size >= 2` 即跨界。**本仓库世界无边界、负坐标是常态，`wx % 16` 是高频陷阱**；
     若非要用取模，写 `((wx % 16) + 16) % 16`。
   - 实测：跨界树占全部树的 **22.8%**（seed=12345，region [-3,3]²）→ 从
     `collectIslands(SEED, 3)` 里筛必然能选到，**不需要放宽判据**。
   - **判据形态（实测标定）**：断言参照树的**每一格都在重组世界里出现**（`missing === 0`），
     且**每格 id ∈ {`sky_wood`, `sky_leaves`}**。⚠️ **不得断言逐格 id 相等** ——
     因 §2.5.1 的覆盖，参照树的树干格可能变成 `sky_leaves`、树冠格可能变成 `sky_wood`；
     实测 300 棵跨界树中有 **48.8%** 存在这类 id 不符（与门控 bug 无关的假失败）。
   - **检验力（实测）**：基线 `missing=0`（300 棵树 / 16,347 格全部命中且均为树块）；
     注入门控改回 `radius` → `missing=901` → **真 FAIL**。
   - 保留两条**前提断言**（`spannedColumns.size >= 2` 与 `crossColumnCells > 0`）——
     它们正是防恒真的护栏。
2. **单一权威生效**（防 §2.3 的圆判据漂移）—— 断言**每个期望基点处 `(wx, topY+1, wz)` 非 air**
   （即按独立重算的基点集合，该长树的地方确实长了树），并保留
   「`(wx, topY, wz)` 是 `sky_grass`」作为辅助断言（它验的是「树基点落在岛顶层上」这一几何前提）。
   - ⚠️ **原版只押「树干底格下方是 `sky_grass`」，实测无检验力**：按计划的断言顺序
     （`assertEqual` 是 throw 语义，首个失败即停）实测前 300 个有树的岛 × 5 种注入，
     **没有任何一种注入能让它成为首个 FAIL**（计数断言总是先炸）；即便移除计数断言，
     它在「半径 -1」注入下是 **0/300** 个岛 FAIL（radius≥6 的岛半径缩 1 后基点仍全在岛内，
     下方仍是 `sky_grass`）。
   - **检验力（实测，300 个岛）**：「基点非 air」在基线为 0；半径 -1 → **1,276** 处、
     圆判据漂移（`y` 传 `height-1`）→ **1,623** 处、`SKY_TREE_CHANCE=0` → **4,896** 处。
   - ⚠️ **不要用「岛顶层圆外不得出现树块」当判据** —— 实测无效：树冠外扩 ±2 本就超出岛圆，
     且扫描区内会含**邻岛**的树（基线就 31,774 格命中）。
3. **常量单一权威**（防两处字面量漂移）—— 测试从 `sky-structures.js` **import**
   `SKY_TREE_CHANCE` / `SKY_TREE_SALT` 而非写死 `0.1` / `113`；并在**临界值附近**断言
   （取一个 `seededRandom(wx,wz,seed+SKY_TREE_SALT)` 结果略小于 `SKY_TREE_CHANCE`
   与略大于它的格，分别断言长树 / 不长树）—— M6 教训：「用远离阈值的输入测不出阈值写错」。
4. **树存在性 + 逐格确定性**（防「实现了但判定错 / 根本没长树」）——
   选一个有树的岛，断言：
   - ① 岛顶层（`topY+1` 以上）存在 `sky_wood` 与 `sky_leaves`；
   - ② 树块集合与**忠实写入顺序模拟**的结果一致，且必须是**单向**比对：
     模拟的每格 → 世界里必须存在（`missing === 0`）且 id ∈ {`sky_wood`, `sky_leaves`}。
     ⚠️ **不得写成双向比对** —— `reassembleIslandWorld` 的扫描区（`span = radius + 2`）里
     含**邻岛**的树，反向比对（世界 → 模拟）在基线就有 **34,901** 格「多出来」→ 假失败。
     单向形态实测：**60/60 个岛逐格完全相等**（「后写覆盖」是确定性的、可精确模拟）。
   - ③ **不得断言「每棵树 4 格树干」或「树干格 === `sky_wood`」** —— 实测该断言
     **必然失败**（§2.5.1：21.4% 的树干格被后写树叶覆盖）。原版这两条是评审发现的
     【阻断 A】。
   - ④ 同一岛对同一组 column **两次独立生成**结果逐格相同（确定性）。
5. **`sky_leaves` 通道契约**（防方案 C 被无意改回）—— 断言
   `registry.cullTable[idOf('sky_leaves')] === 0`（opaque）且
   `registry.opaqueTable[idOf('sky_leaves')] === 1`；并断言**其余 7 个树叶族仍为 cutout**
   （`cullTable === 1`）—— 这条双向断言防止「顺手把所有树叶都改成 opaque」的过度修正。
   另断言一棵树 mesh 后 `cutout.vertexCount === 0`（树完全不进 cutout 通道）。

### 6.3 负向验证（每条须实测确认真 FAIL，不是「应该会 FAIL」）

按 testing-policy §2.7，注入下列缺陷后对应断言必须真 FAIL。

> ⚠️ **「预期 FAIL 的断言」列已按实测修正（评审后）**。原版两条指错了断言：
> ① 「圆判据半径 -1 → 树干底格下方非 `sky_grass`」实测 **0/300** 个岛 FAIL（§6.2 第 2 条）；
> ② 「层序倒置 → 岛体盖掉树基点」经自查**不成立**（树基点在 `topY+1`、岛体最高格是 `topY`，
> 几何不重叠 → 注入无差异，实测两侧结果逐格相同）。另：`assertEqual` 是 **throw 语义**
> （首个失败即停），故「预期 FAIL 点」必须按**断言实际执行顺序**定，不能凭直觉。

| 注入 | 预期 FAIL 的断言（实测标定） |
|---|---|
| AABB 门控改回 `radius`（不 `+2`） | §6.2 第 1 条：参照树 `missing > 0`（实测 901 格缺，且全部落在跨 column 那一侧） |
| `writeSkyTrees` 自己算圆（不用 `islandLayerRadius`）且半径 `-1` | §6.2 第 2 条：**期望基点处 `(wx, topY+1, wz)` 为 air**（实测 1,276 处）。⚠️ 不是「树干底格下方非 `sky_grass`」（实测 0/300） |
| `SKY_TREE_CHANCE` 改 0 | 单测 `findIslandWithTree` 返回 null（测试 import 同一常量 → `expectedTrunkCells` 空）→ FAIL「找到有树的岛」；E2E `treeWood`/`canopy` 收 0 → FAIL。⚠️ 这正是§6.2 第 3 条「常量单一权威」的预期行为：改常量两侧同步 |
| 树层写在岛体**之前**（层序倒置） | ❌ **无有效断言 —— 已实测确认这不是一个真实失效模式**（几何不重叠：树基点 `topY+1` vs 岛体最高格 `topY`，且岛体写入不触及 `topY+1`）。实测注入后两侧逐格完全相同 → **把它从本清单移除**，不要为了凑负向验证而编造无效注入（testing-policy §2.7）。保留它的**正向**价值：§6.2 第 4 条 ④ 的两次生成确定性 |
| `writeSkyTrees` 未追加进 `applySkyStructures()`（只实现不调） | E2E 的 `sky_wood`/`sky_leaves > 0` —— ⚠️ 浏览器内单测直接调纯函数，**测不到「没接线」**（同 M6 fake pool 盲区），故这条**必须靠 E2E 兜住** |
| `sky_leaves` 的 `cullMode` 改回 `cutout` | §6.2 第 5 条（通道契约）+ §6.2 第 4 条 ① 的 `cutout.vertexCount === 0` + Tier 4 的 `A.info.cull` |
| 把全部树叶族都改成 `opaque`（过度修正） | §6.2 第 5 条的反向断言（其余 7 项须仍为 cutout） |
| 测试里把 salt 写成字面量 `113` 而非 import 常量，再把常量改 `114` | 常量单一权威断言（实测：基点 air 4,397 处 + id 不符 4,263 处） |

⚠️ 每条注入后**先确认源码真的被改了**再读结果 —— M7 的教训：注入没生效时「全绿」是假信号。

### 6.4 门禁分层

| 门禁 | 是否需跑 | 理由 |
|---|---|---|
| `npm run check`（arch + data + lint） | ✅ | `check:arch` 守 `sky-structures.js` 不得 import three（Worker 同构层） |
| 浏览器内单测（`src/tests/index.html`） | ✅ | Tier 1 TDD 主战场 |
| `npm test`（Playwright 全量） | ✅ | 改了 gen 算法 + 方块数据契约 + 反转 E2E 断言 |
| `npm run bench -- --check` | ✅ | 触及 mesh 顶点量与渲染通道（§5.2 填充率） |
| Tier 4 像素实测 | ✅ | §6.5 |
| `npm run icons` | ❌ | 图标指纹只含 `geometry` 与 tile 地址，**不含 `cullMode`**（实测核实 `tools/icon-fingerprint.mjs`）；未改 mesher 几何、未改背包物品集合 |
| `npm run atlas` | ❌ | 未改任何贴图像素（`sky_leaves` 的 alpha 230 保留不动，§1） |

### 6.5 Tier 4 像素实测（方案 C 的视觉验收）

`sky_leaves` 从 cutout 挪到 opaque 后，须验证渲染结果符合预期。**不宣称目视**
（CLAUDE.md：截图的 `Read` 只返回 URL，不能宣称目视验证）：

1. **不透明性**：树冠后方放一个已知颜色的方块，采样树冠覆盖区的屏幕像素 →
   须等于 `sky_leaves` 的颜色（约 `[255,105,180]` × shade），**不含**背景色混合成分
   （证明 opaque 通道确实不混合、深度写入生效）；
2. **颜色口径**：采样值与 atlas tile 中心 `[255,105,180,230]` 的 RGB 一致（±shade/AO 容差）——
   阈值须对着**屏幕实测值**读，不是图集统计值（M8 教训：两个口径差一个数量级）；
3. **对照**：同位置改回 `cullMode:'cutout'` 重采样，断言两者 RGB **基本相同**
   （证明 §2.6.1 的论断「当前 cutout 渲染已是不透明，改 opaque 视觉零变化」）——
   这条对照是**只差一个变量**（只改 `cullMode`）的单变量对照，符合 AGENTS.md 要求。
   ⚠️ 预期差异仅来自 AO（§2.6.3 第 2 项），若差异远超 AO 可解释范围须停下来查。

## 7. 文档同步清单

AGENTS.md「文档同步」要求：本次不新增文件，但**改变了多处既有文档宣称的事实**，必须同步
（否则文档成谎话）：

1. **`docs/phase-1-engine-design.md`** —— 新增 **v1.42 修订说明**（当前版本 v1.41，
   版本号以该文档首行为准），记录两项口径变更：① 天空树按产品范围回补、宝箱仍不迁移；
   ② `sky_leaves` 的 `cullMode` 由 cutout 改 opaque（追加进 **§4.1 的 cullMode 勘误**段 ——
   ⚠️ 那段是**一段文字 + 一个计数**（「12 个不透明材质方块」+「真混合通道仅留 water/…/cloud/…」），
   **不是枚举列表**，没有「第 N 项」可追加。正确做法：在该段末尾**追加一句 `sky_leaves`**
   （措辞与 `cloud` 那处一致：它只是作为「留在 transparent 通道」的例子被提及，也不是独立编号项）。
   ⚠️ 不要把「M2 的 12 项」与「本次追加的 1 项」混成一个计数（spec 原文「同一族的第 13 项」措辞已据此修正）。
   §4.2 正文的「空中结构（M2-7）」段落补上树层（现有那句「岛体/云簇只把落入当前 column
   的体素写入 `blocks`」须扩为「岛体/云簇/天空树」）。
   ⚠️ **v1.14 修订说明本身不动** —— 它是历史决策记录（AGENTS.md「历史记录段不动」），
   由 v1.42 说明其被部分反转。
2. **`docs/m2-seed12345-comparison.md`** —— **两处**须改（都是给用户的当前状态比对指引），
   按**内容定位**而非行号（评审 §2.3：行号会随文档增删漂移，本仓库已发生过三次版本号漂移）：
   ① 「观察要点」段里的「**无宝箱、无天空树**（有意差异）」；
   ② 第五节「已知的有意差异」第 1 条「空岛**无宝箱、无天空树**（M2-7 规格明确不迁移）」。
   两处均改为「无宝箱；天空树已回补（不透明粉色实心叶团）」。
   ⚠️ 同时补上 §8 末尾那条「位置不会逐棵对应，只有密度与观感可比」的提醒。
3. **`docs/roadmap.md`** —— 在「M3.2 之后的独立 bugfix / 改造」表（v1.19~v1.38）新增
   **v1.42** 行；在「活跃约束详情 · 渲染与容量」段补记本次沉淀的三条约束
   （salt 区间扫描 / CAPACITY 是视距 8 口径勿用 vd=10 论证 / 通道归属须核对 mc-lite 材质而非方块名）。
   ⚠️ 版本号须与设计文档一致（roadmap:318 已记「v1.36~v1.38 已被独立改动表占用」，
   v1.39/v1.40 = M8/M9，v1.41 = 水面遮罩 → 本次取 **v1.42**）。
4. **`AGENTS.md`** —— 新增活跃约束**十条**（措辞从 §2.5.1 / §2.5.2 / §2.6.3 / §3.1 / §4.3 /
   §5.2 / §9.1 / §9.2 / §10.6 浓缩，完整清单见计划 Task 9 Step 4）：① 判断方块渲染语义须读 mc-lite
   `MaterialManager`（§9 第 1 条）；② `opaqueTable=1` 有四项后果不止面剔除（§2.6.3）；
   ③ salt 占用须程序化扫描（§3.1）；④ cutout 每格顶点成本约为 opaque 实心团 3 倍（§4.2）；
   ⑤ Node 侧 A/B 时间比较须交替顺序（§9 第 4 条）；⑥ 结构写入无占用格守卫（§2.5.1，
   **独立约束**，不进视觉清单）；⑦ 写断言前先跑真实数据（§9.1 第 5 条）；⑧ 坐标判据用
   非负取模或按足迹判（§9.1 第 6 条）；⑨ 凡论证 A/B 优化等价须分别实测（§9.2，
   二次审核沉淀）；⑩ BatchedMesh 的 draw call 不是「每通道 1 次」—— WebGPU 后端对每个可见
   geometry slot 各发一次 draw（`three.webgpu.js:85531`），实测 draw 530→545（§10.6
   实测期发现，原枚举漏列）。并更新「五处已知的有意偏离 mc-lite」清单为**六处**（追加 `sky_leaves`
   的 AO 遮挡偏离），或按该清单的既有口径判断是否归入（它是「视觉比对专用清单」，
   AO 差异属视觉 → 应归入）。
   ⚠️ **「结构写入无占用格守卫」（§2.5.1 / §8 首行）**不进那个视觉清单 —— 它是
   **结构写入语义**的全局偏离（影响全部结构路径，不只空岛），应作为一条
   **独立的活跃约束**登记（含实测的 21.4% 树干覆盖率与「本次不修」的理由）。
   另需同步评审与二次审核建议的**两条**通用规则（进 `docs/testing-policy.md` §2.5）：
   ① **新写的断言必须先在真实数据上跑一次、打印实际值**；② **凡论证「A 优化与 B 优化
   等价/不冲突」，须在 A、B 各自的参数取值下分别实测一遍**（配套：坐标类判据用非负取模
   或直接按足迹判 —— `wx % 16` 在无边界世界是高频陷阱；建议另开小任务全仓 grep 同类写法）。
5. **`docs/superpowers/specs/2026-08-23-m2-sky-structures-design.md`** —— 其 §1「明确不包含：
   天空树」与 §4 验收第 3 条「不含 `sky_wood`、`sky_leaves`」已被本 spec 部分反转。
   ⚠️ **不改历史 spec 正文**，改在其头部加一行指向本 spec 的**反转说明**。
6. **`src/voxel/blocks-data.js` 文件头注释** —— `:6` 的转换规则「名字含 leaves → 'cutout'
   （8 个树叶族）」在方案 C 后变成 **7 个**（实测计数：`blocks-data.js` 中 8 项含 `leaves`，
   扣掉 `sky_leaves` 剩 7）；须更新该规则说明并在 `sky_leaves` 行加注释
   记录偏离理由（同 `:22` 给 `cloud` 加注释的既有手法）。
7. **`docs/testing-policy.md` §2.5**（断言落点的**唯一权威**，AGENTS.md 明文指向它）——
   补**两条**评审沉淀的通用规则：
   ① **「新写的断言必须先在真实数据上跑一次、打印实际值，再决定断言写成什么」**
   （配套：坐标类判据用非负取模或直接按足迹判）—— §9.1 两处阻断缺陷的共同根因；
   ② **「凡论证『A 优化与 B 优化等价/不冲突』，须在 A、B 各自的参数取值下分别实测一遍」**
   —— §9.2 的根因（`surrounded` 跳过在 cutout 下是优化、在方案 C 下是悲观化，
   而本次改动恰好就在改那个参数）。两条同源（都是「先跑一遍再下结论」），
   但落点不同（① 测试断言、② 设计论证）。
   ⚠️ 若不落地，§9.1 / §9.2 与计划里的「已建议同步进 testing-policy」
   就是**悬空引用**（规则没进它的权威副本 → 后人查不到）。落地内容见计划 Task 9 Step 4。

## 8. 有意偏离 mc-lite 清单（本次新增/继承）

| 项 | mc-lite | mc-heavy（方案 C） | 理由 |
|---|---|---|---|
| **结构写入无占用格守卫（后写胜）** | `fakeChunk.add`（`WorldWorker.js:532-538` / `:1508-1518`）有守卫：该格已有任何非空气方块则 `return`（**先写胜**） | `makeColumnSetter`（`landmarks.js:268-278`）**无条件覆盖**（**后写胜**） | ⚠️ **不是本任务引入的，是既有的全局偏离**（地面树走同一条路径）。实测后果：天空树 **21.4%** 的树干格被后写树叶覆盖（§2.5.1）。本次**不修**（加守卫会改变全部结构路径的行为与既有世界内容 → 视觉比对基准变化）；已让断言忠实描述实际行为（§6.2 第 4 条） |
| 随机源 | `Island.js:48` `Math.random() < 0.1` | `seededRandom(wx, wz, seed + 113) < 0.1` | 红线 2：世界无预生成、须确定性可复现。与 M2-7 对岛半径/云簇的处理同口径 |
| 空岛宝箱 | `Island.js:56` 岛顶中心写 `chest` | **仍不迁移** | 用户本次确认范围只做树 |
| 树冠间距 | 无约束（岛内树冠互相穿插） | **无约束**（照搬） | 用户已确认；观感即 mc-lite 的连绵叶团 |
| `structureCenters` | `Island.js:19-26` 注册结构中心供跨 chunk 渲染责任判断 | **不引入** | 红线 1/2：结构随 column 确定性生成，无需运行期跨 chunk 协调（M2-7 既有边界） |
| **`sky_leaves` 的 AO 遮挡** | `AOUtils.js:376` `isOccluding = !isTransparent`，而 `sky_leaves.isTransparent=true` → **不遮挡 AO** | `opaqueTable=1` → **遮挡 AO**（树冠外表面凹陷处有暗角） | 方案 C 的连带效应，用户已知悉并选定；实测影响面小（§2.6.3 第 2 项） |
| **`sky_leaves` 阻断 blocklight** | mc-lite 光照传播不查 `isTransparent`（grep 零命中） | 阻断（`lighting.js:165`） | 同上；空岛在高空、附近通常无光源 → 实际交集极小 |
| **`sky_leaves` 阻挡炮塔 LOS / 弹丸** | `Turret.js:565` `isBlockOccluding = isSolid && !isTransparent`，`sky_leaves.isTransparent=true` → **不阻挡** | 阻挡（`turret-system.js:31` `solidTable && opaqueTable`，方案 C 下 `opaqueTable=1`） | 方案 C 连带效应，已核实为偏离；实际交集仅「空岛上放炮塔」，须实施时实测观感，不可接受则回退方案 E |
| **`sky_leaves` 材质透明度** | `mkMat('#FF69B4', 0.9)` → `transparent:true + opacity:0.9`（真半透明） | **不透明**（opaque 通道，alpha 0.902 不消费） | ⚠️ **这不是本次引入的偏离** —— mc-heavy 自 M2-7 起实际渲染就是不透明（cutout 通道 `alphaTest=0.3` 且无 `transparent` → 0.902 全保留不混合，atlas 实测印证）。方案 C 只是让**声明与实际渲染一致**。若将来要真半透明须走方案 B（代价：transparent 通道容量重标定 + 放宽 §4.10 预算） |

**视觉比对时的口径提醒**（须写进 `m2-seed12345-comparison.md`）：天空树与 mc-lite 同 seed 下
**位置不会逐棵对应** —— mc-lite 的 `Math.random` 不可复现，只有**密度与观感**可比
（约 15 棵/岛、粉色叶团覆盖岛顶）。且 mc-lite 的叶团是**半透明**、mc-heavy 是**不透明**
（上一行最后一项），比对时不要把这个差异判为 bug。

## 9. 勘查期的自我纠错记录（沉淀为活跃约束，防重犯）

本次勘查犯了四个错，其中前两个会直接导致错误实施，必须记入 CLAUDE.md：

1. **⚠️ 只读 mc-heavy 的声明就推断 mc-lite 的材质语义** —— 看到 `blocks-data.js:35` 的
   `cullMode:"cutout"` + 名字含 `leaves`，就判定 `sky_leaves` 是镂空材质，并据此写了一整节
   机制分析与「cutout 容量告急」的三选一决策。**实际 mc-lite 是 `mkMat('#FF69B4', 0.9)`
   = `transparent + opacity 0.9`，无 `alphaTest`**。是用户凭观感质疑（「我记得有点半透明效果」）
   才发现。违反 CLAUDE.md 既有约束「**对齐上游须实测其运行时行为，不能读定义推断**」。
   → **沉淀**：判断一个方块的渲染语义，**必须同时读 mc-lite 的 `MaterialManager` 注册**
   （材质层）与 `BlockData`（数据层），不能只看 mc-heavy 的 `cullMode` —— 后者是前者的
   **转换产物**，而转换规则（`blocks-data.js:6`「名字含 leaves → cutout」）本身可能有偏差。
   `cullMode` 与 `isTransparent` 是**两套语义**（M2 勘误已记：前者是渲染通道，后者是面剔除）。
2. **⚠️ 用错误口径论证容量撞破** —— 拿 vd=10（= scheduler 加载半径 `R+2`）的数据论证
   「10% 密度会撞破 cutout 预算」，但 `render-world.js:9` 明确写 CAPACITY 是「**视距 8**
   容量口径」。实测 HEAD 在 vd=10 下 opaque 就已 111.2% 撞破 —— 与天空树无关，属奔跑态
   瞬时扩容的正常设计。→ **沉淀**：论证容量撞破必须用 CAPACITY 的**设计口径**（视距 8），
   且必须先确认 HEAD 在同口径下是否已撞破（否则会把既有状态算到新改动头上）。
3. **机制归因错误** —— 曾写「两棵重叠树 cutout 2084 < 2×1296，重叠区被 mesher 合并」。
   实测证明 **cutout 之间根本不互剔**（判据要 `opaqueTable[neighborId]===1`，树叶是 0；
   两格相邻 `sky_leaves` = 48 顶点零剔除）。真正变便宜的机制在**生成层**的 `surrounded`
   优化（107 格写入 → 89 格实际）。→ 已在 §2.5 记录正确机制。
4. **顺序测量得出机制上不可能的结论** —— 首轮 MESH 测量显示「有树反而快 60ms」，
   而面数明明增加。是 JIT 预热的顺序效应，改交替对照后得 +0.4%。
   → 同 CLAUDE.md 对 `bench` 的既有要求（「门禁阻断时先做交替对照，不要看单次数值」），
   **本次把它推广到所有 Node 侧性能勘查**：任何 A/B 时间比较都必须交替顺序 + 多轮取中位。

另：AO 探针第一版用**坐标匹配**取顶点（`Math.abs(px - 9.5) < 0.6`）返回 `null`，
得出「null→3」这种机制上不可能的数值。改用**分布统计法**（数暗顶点个数，不依赖坐标匹配）
才拿到有效数据 —— 同 AGENTS.md「出现机制上不可能的数值时先怀疑脚本本身」。

### 9.1 评审补录：同一类错误在**测试设计**上的复现（沉淀为活跃约束）

评审（`docs/superpowers/reviews/2026-09-20-sky-tree-review.md`，方式是**执行计划自身的测试代码**
而非阅读理解）发现两处阻断级缺陷，**都属于§9 已命名的同一类错误**：
「读定义推断，而非实测运行时行为」—— 只是发生在**断言**上：断言描述的是
**关于世界的想象**，没有先跑一遍看世界实际长什么样。实测复核后的两条沉淀：

5. **⚠️ 写断言前必须先在真实数据上跑一次、打印实际值** —— 两处阻断均为「断言先于实测」：
   ① 「每棵树 4 格树干、每格都是 `sky_wood`」（实测 21.4% 被覆盖，§2.5.1）；
   ② 「树干底格下方是 `sky_grass`」当作圆判据漂移的护栏（实测 0/300 个岛会 FAIL）。
   与仓库既有的「不凭感觉宣称通过」「出现机制上不可能的数值时先怀疑脚本本身」同源。
   已建议进 `docs/testing-policy.md` §2.5。
6. **⚠️ 坐标类判据一律用非负取模或直接按足迹判** —— `Math.min(wx % 16, 16 - (wx % 16))`
   在 JS 里是**取余**而非取模，负坐标下恒返回负值 → 判据**恒真**（§6.2 第 1 条）。
   本仓库世界无边界、负坐标是常态，这类写法是**高频陷阱**。修法优先「直接枚举足迹算
   column 集合」（以用例需要的前提为判据，不需维护位运算直觉）。待办：全仓 grep 同类写法。

**评审探针自身的纪律印证**：我的复核探针第一版也犯了同类错（漏传 `seed` 参数 →
「树干 100% 被覆盖」这种机制上不可能的数值），回头查脚本才拿到与评审一致的 21.4%。
→ **双向印证了第 5 条：机制上不可能的数值 = 先查自己。**

### 9.2 二次审核补录：同一类错误第三次复现（在**机制论证**上）

二次审核（2026-09-28）发现 §2.5 原文把 `surrounded` 生成期跳过论证为「方案 C 下的等价优化」，
实测证明**方向相反**（方案 C 下跳过净增 2.8% 面数，详见 §2.5.2）。这与 §9 第 1 条、§9.1 第 5 条
是**同一类错误的第三次复现**，只是发生的位置不同：

| 次 | 发生位置 | 表现 |
|---|---|---|
| §9 第 1 条 | **上游语义** | 读 mc-heavy 的 `cullMode` 声明推断 mc-lite 材质（实为 `transparent+opacity 0.9`） |
| §9.1 第 5 条 | **测试断言** | 断言「每格树干都是 `sky_wood`」（实测 21.4% 被覆盖） |
| **§9.2（本条）** | **机制论证** | 论证「生成期跳过与 mesh 剔除两层等价」（实测反向悲观化 +2.8%） |

7. **⚠️ 「两层机制等价/不冲突」这类论证必须逐通道实测，不能靠语义直觉** ——
   本条的错误形态特别隐蔽：它**不是**数值错、也不是引用错，而是一句听起来完全合理的
   机制推理（「反正都会被剔除，早跳晚跳一样」）。错在**没区分通道**：`opaqueTable` 是
   0 还是 1，决定了「跳过」与「写入」哪个更省 —— 而本次改动恰恰就是把它从 0 改成 1。
   **凡论证「A 优化与 B 优化等价/不冲突」，须在 A、B 各自的参数取值下分别实测一遍**，
   尤其当本次改动正在修改其中一个参数时。
   → 与第 5 条同源（都是「先跑一遍再下结论」），但落点是**设计论证**而非测试断言，
   故单列。**建议同步进 `docs/testing-policy.md` §2.5**（与第 5/6 条一起，见 §7 第 7 项）。


## 10. 实施结果回填（Task 7/8 实测，2026-09-29）

⚠️ **本节是实施后的真实数字**。与 §4.3 勘查期估算的差异在 §10.6 逐条列出；
§4.3 是决策依据的历史记录，**不改**。所有数字来自
`.superpowers/sdd/2026-09-20-sky-tree/task-7-report.md`（性能/容量/E2E）与
`task-8-report.md`（负向验证），非推算。

### 10.1 容量与内存（m3-fullscene + 临时 read-mem 探针，vd=8 / seed=12345）

| 项 | 实测 | 判定 |
|---|---|---|
| `gpuVertexBytes` | **155,250,000 B = 148.06 MiB** | ✅ < §4.10 的 150MiB（余量 1.94MiB） |
| opaque `_capacity.maxVertexCount` | **2,850,000** = 标定值（1200×1900×1.25） | ✅ 零扩容 |
| cutout `_capacity.maxVertexCount` | **2,200,000** = 标定值（550×3200×1.25） | ✅ 零扩容 |
| transparent `_capacity.maxVertexCount` | **125,000** = 标定值（100×1000×1.25） | ✅ 零扩容 |

`gpuVertexBytes` 恰为 `(2,850,000 + 2,200,000 + 125,000) × 30B` —— 三通道 cap 全部停留在
标定值的直接算术证明。cap 在稳态、冲刺峰值（48 次采样）、冲刺后收敛三个时点全部等于标定值。

**三通道 `reservedV` 占用（实测数，⚠️ 不能照抄 §4.3 的 79/55/41 —— 口径不对号）**：

| 状态 | opaque | cutout | transparent |
|---|---|---|---|
| **稳态**（289 列，队列全收敛） | 2,362,255 / **82.9%** | 1,590,455 / **72.3%** | 13,290 / **10.6%** |
| **冲刺峰值**（12s 奔跑，250ms 采样） | 2,674,080 / **93.8%** | 1,802,230 / **81.9%** | 14,055 / **11.2%** |
| 冲刺后收敛（323 列） | 2,656,210 / 93.2% | 1,802,230 / 81.9% | 13,975 / 11.2% |
| §4.3 勘查预测（对照，不改） | 79% | 55% | 41% |

口径说明（为何与 §4.3 不对号）：

- **cutout 高占用是 HEAD 既有状态**（撒布补齐 `87cd571` 后花/树叶进 cutout；冻结基线场景 ②
  cutout vertices 1,164,428 ×1.25 对旧 cap 即 80.9%），**不是本次改动引入**；本次把
  `sky_leaves` **移出** cutout 反而使其低于旧口径。
- **transparent 的 41% 是冲刺态数字**（基线场景 ①/④ 水面大量暴露：63,676/58,132 vertices），
  不是 289 列稳态数字；289 列城市稳态只有 ~9.8%（基线场景 ② 9,828 vertices）。
- **opaque 冲刺峰值余量已收窄到 6.2%**：后续往 opaque 通道加量前须重测峰值。

### 10.2 bench `--check` 与交替对照（MOD 8 次 / HEAD 5 次，3 轮交替 + 补采）

- **fps 与结构指标无差异**：场景 ④ fps MOD 119.33~120.14 / HEAD 118.72~119.36。
- **⚠️ draw call 不是 +0**：场景 ④ 实测 **MOD 545 vs HEAD 530（+15）**（基线 526）。
  机制：WebGPU 后端对 BatchedMesh 的**每个可见 geometry slot 各发一次 draw**
  （`three.webgpu.js:85531`），天空树新增可见 opaque slot → +15。§4.3 的「draw call +0」
  是勘查期按「合批进既有 3 通道」的推断，**已被实测证伪**。该值不在门禁 LOWER_IS_BETTER
  集合内，不阻断。
- **bench 阻断全部归因于已知噪声源，非本次改动**：场景 ④ frameP95 在 9↔10 vsync 量子边界
  随机翻转（MOD 8 样本中位 9.95 / HEAD 5 样本中位 9.9，分布几乎完全重叠，HEAD 侧也阻断 1 次）；
  场景 ③ fastRemeshP95 1.1→1.3 是单样本 p95 的 GC 抖动（`hotbar.js:40` 注释已记录该噪声签名）。

### 10.3 GEN p95 与一处冻结断言的用户裁决放宽

> ⚠️ **本节记录的是密度 0.1 时的实测。交付后用户指令把密度减半（0.1→0.05），
> genP95 已回落到 7.6~7.8ms（回到原 8ms 预算内），但用户裁决**保留 10ms 作余量**。
> 完整记录见 §10.8；本节正文作为 0.1 密度下的历史实测保留不改。**

- **全场景 GEN p95 = 1.534ms**（HEAD 1.206ms，**+0.33ms**，289 样本）—— 远低于 §4.2 预算，
  **未撞线**（与 §4.3 预测一致）。
- ⚠️ **`structure-gen` fixture 的「含结构 genP95」门撞线**：实测 **8.5~8.8ms**（4 次单独复跑
  分布极窄 → 非负载噪声）。机制：该 fixture 的 4×4 测量域是**空岛密集区**（region `(-4,-4)`
  金字塔 column 周围实测 3 个空岛、圆内 563 顶层格 → 约 56 棵树集中进这 16 个 column 的
  GEN 计时路径），+0.33ms 的全场景平均增量在岛密区被放大到约 +1ms（基线 7.7 → 实测 8.5~8.8）。
- **用户 2026-09-29 裁决：放宽该冻结断言 8ms → 10ms**。只改 `test-structure-gen.html` 的
  **含结构**门；`test-worker-gen.html` 的**无结构**门（纯地形，GEN 调用不传 `layouts`）
  **逐字未改**，仍守 8ms。§4.2 档位口径澄清：设计文档 §4.2 原文「单 column GEN（**无大结构**）
  目标 < 8ms；含城市结构切片 < 25ms」—— 8ms 档本就是「无大结构」口径，含结构属 25ms 档，
  故 **10ms 相对 §4.2 原文是保守值**。
- 放宽后验证：`structure-gen` **3/3 通过**（探针实测 genP95 **8.20~8.40ms**，余量 16~18%，
  fixture 全部 10 条用例通过）；`worker-gen` 仍通过。
- ⚠️ 余量真实但不大：若天空树密度或 GEN 成本再涨，该门须**重新实测**而非再次静默放宽。
- ⚠️ §5.3 末列的「方案 E」治不了这条（GEN 阶段不读 `cullMode`）—— 与 §5.4 的复核结论一致。

### 10.4 测试通过情况

- **浏览器内单测全绿**（计数以 harness 输出为准；Task 8 Step 7 还原后复跑确认 failed=0）。
- **全量 E2E：120 用例 / 117 passed / 3 failed**（47 spec 文件，6.9min，串行）→ 三处处置：
  1. `structure-gen` genP95 → **用户裁决放宽 8→10ms**（§10.3，已修，3/3 通过）；
  2. `m1-acceptance` placeP95 在 2ms 边界振荡（1.7~2.1，`--repeat-each=3` → 1 failed/5 passed）
     = **既有 flaky**（CLAUDE.md 三条计时型之一），未改断言、未放宽阈值；
  3. `sky-structures` frameMs.p95 16.9 vs 16.75 = **vsync 量子贴线**（单独复跑 3/3 通过：
     16.7/16.6/16.7；该 spec 注释自述此门本就贴在量子边界），未改断言、未放宽阈值。
- **§2.6.3 第 4 项连带效应（`sky_leaves` 阻挡炮塔 LOS / 弹丸）未在既有 E2E 体现**：
  `turrets` 6/6、`projectiles` 4/4 全通过 —— 两 spec 都钉地面 `vd=2&seed=12345`，
  树在高空空岛，炮塔/丧尸与空岛无交集（LOS 用例用 stone/glass 墙）。
- **Tier 4 像素实测（Task 6）通过**：`canopyA=[255,105,180]` 与 atlas tile 逐位相同
  （SRGB 口径）；`ratioA=1.000`（树冠区纯度）；`wallDist=266`（不透明性：叶 B 通道恰为
  atlas 原值 180，未被墙色 226 抬升 → 无混合）；`channelDelta=0`（opaque vs cutout
  单变量对照：树冠主色完全相同，且对照侧通道归属确实不同 —— `vertsB.cutout=1328`）。

### 10.5 负向验证（7 条有效，全部真 FAIL；层序倒置那条已移除）

| # | 注入 | 结果（预期断言处真 FAIL） |
|---|---|---|
| 1 | Task 4 Step 3：AABB 门控 `radius+2`→`radius` | 跨 column 用例 `missing=12`（单树，全在跨界侧） |
| 2 | Task 5 Step 3：`writeSkyTrees` 未接线 | E2E `treeWood`/`canopy` → 0；**单测同时全绿**（「单测测不到没接线」的盲区实证） |
| 3 | Task 8 Step 1：圆判据半径 `-1` | `baseAir`「3/5 处为 air: Expected 0, got 3」+ 跨 column 缺 33 格（同根因连带） |
| 4 | Task 8 Step 2：`SKY_TREE_CHANCE=0` | **单测 + E2E 双侧** FAIL（单测「找到有树的岛」false；E2E `treeWood` 0） |
| 5 | Task 8 Step 4：`sky_leaves` 改回 `cutout` | **三处冗余断言全部命中**：registry 契约（Expected 0, got 1）/ mesher「树不进 cutout」（Expected 0, got 1296）/ Tier 4 `A.info.cull`（Expected 0, Received 1）→ 通道归属有三重独立防线 |
| 6 | Task 8 Step 5：全部树叶族改 opaque（过度修正） | 反向断言「leaves 仍 cutout: Expected 1, got 0」（+7 条 chest/azalea_flowers 连带失败，属预期噪声） |
| 7 | Task 8 Step 6：测试写 salt 字面量 + 实现改 114 | 「5/5 处为 air: Expected 0, got 5」（唯一失败无噪声）；还原后复跑 PASS |

**Task 8 Step 3（层序倒置）的两条结论**：① 「树层写在岛体之前/之后」**不是真实失效模式**
（几何不重叠：树基点 `topY+1` vs 岛体最高格 `topY`；且注入点够不到被测路径 —— 新用例的
写入顺序是测试自己写死的回调，不经过 `applySkyStructures`）→ 已从 §6.3 清单移除，
不为凑负向验证编造无效注入；② `applySkyStructures` 的层序（云→岛→树）**只靠代码顺序与
注释守、无断言检验力** —— 可接受（层序价值在与 mc-lite 生成顺序一致的可读性），
**但若将来树基点与岛体几何重叠必须重新评估**。

### 10.6 与 §4.3 勘查估算的差异（§4.3 不改，以本节为准）

| 维度 | §4.3 勘查估算 | §10 实测 | 差异原因 |
|---|---|---|---|
| draw call | +0 | **+15**（545 vs 530，场景 ④） | 勘查期按「合批进既有 3 通道」推断；实际 WebGPU 后端对 BatchedMesh 每个可见 geometry slot 各发一次 draw（`three.webgpu.js:85531`） |
| 三通道占用 | 79% / 55% / 41% | 稳态 **82.9% / 72.3% / 10.6%**；峰值 **93.8% / 81.9% / 11.2%** | 口径不对号：§4.3 的 55%/41% 混入了 HEAD 既有状态（撒布补齐后 cutout 本就高）与冲刺态数字（水面暴露）；实测口径见 §10.1 |
| `gpuVertexBytes` | 保持 148.1MiB | **148.06MiB**（一致） | — |
| GEN p95 | +0.33ms（预算 8ms）✅ | 全场景 **+0.33ms 未撞线**；但**含结构 fixture 门撞线** 8.5~8.8ms → 用户裁决 8→10ms（⚠️ 密度减半后已回落 7.6~7.8ms，10ms 保留作余量 —— 见 §10.8） | §4.3 只测了全场景平均口径；fixture 的岛密集测量域把增量放大到约 +1ms（§10.3） |
| MESH | +0.4%（交替对照） | 一致（bench fps 无差异） | — |
| 总面数 | 672,206 → 700,064（+4.1%） | 一致（MOD 收敛后 opaque reservedV +2.6% 与面数量级吻合） | — |

### 10.7 文档同步去向（Task 9 已落地）

- 设计文档 v1.42 修订说明（含 genP95 裁决 + draw call 修正 + 占用百分比实测口径）+ §4.1
  勘误段补记 + §4.2 正文（天空树写入段）；
- `docs/m2-seed12345-comparison.md` 两处（观察要点 + 有意差异第 1 条）+ 比对口径提醒；
- `docs/roadmap.md` v1.42 行 + 「活跃约束详情 · 渲染与容量」天空树段 +
  「seededRandom 的 salt 分配」小节 + 偏离清单五→六；
- `CLAUDE.md`（= `AGENTS.md` 符号链接）活跃约束十条 + 偏离清单五→六；
- `docs/testing-policy.md` §2.6 追加第 ⑤/⑥ 条（标题「四类踩坑」→「六类踩坑」）；
- `docs/superpowers/specs/2026-08-23-m2-sky-structures-design.md` 头部反转指针（正文不改）；
- `docs/superpowers/plans/2026-09-20-sky-tree.md` Task 8 段的两处命令缺陷修正回写
  （Step 5 perl 模式缺逗号 / Step 6 注入注释位置造成语法错）。

**提交状态**：已于 2026-09-29 提交（`13ce699` feat(sky-tree): 空岛天空树回补 + sky_leaves
通道修正（v1.42）），roadmap v1.42 行与本 spec 状态行的 commit 位已回填真实 hash。

### 10.8 交付后的用户追加改动：生成密度减半（0.1 → 0.05）

**用户指令（2026-09-29，交付后）**：「天空树的生成密度减少到原来的一半」。

这**反转了 §1 的范围声明**（「明确不包含：树冠形状、密度、间距的任何改动 —— 逐格 10%、
无间距约束，照搬 mc-lite（用户已确认）」）。用户指令即授权，故 `SKY_TREE_CHANCE`
由 **0.1 改为 0.05**，成为一项**新的有意偏离 mc-lite**（§8 偏离清单的「随机源」行需补记：
mc-lite `Math.random() < 0.1` → 本仓 `seededRandom(wx,wz,seed+113) < 0.05`，
既换随机源守红线 2、又按产品口径减半密度）。观感从 mc-lite 的「连绵叶团」变为「疏朗树木」。

**改动落点只有一处**（红线 1 的收益兜现）：`sky-structures.js:26` 的导出常量。
测试均 **import 同一常量**而非写字面量 → 期望值自动跟随，**零测试改动**
（包括临界值用例的 ±0.002 窗口选点、`expectedTrunkCells` 的期望基点集合、
忠实写入顺序模拟）。这正是 §6.2 第 3 条「常量单一权威」与 Task 8 Step 6
负向验证（测试写字面量 salt → 5/5 处为 air）所钉住的价值。

**改前探针预测 → 改后实测对照**（探针只读，不依赖实现）：

| 指标 | 0.1 | 0.05 预测 | 0.05 实测 |
|---|---|---|---|
| E2E 岛（312,120,r=5）全岛树数 | 10 | 4 | ✅ 测试通过 |
| E2E `treeWood`（±2 窗口） | 2 | **1** | ✅ `> 0` 仍成立（余量更薄） |
| 临界值用例 ±0.002 窗口选点 | below 0.098811 / above 0.101222 | below 0.049855 / above 0.051086 | ✅ **两侧都在** → 用例仍有检验力 |
| `structure-gen` 测量域树数（563 圆内格） | ≈56 | ≈28 | genP95 **7.6~7.8ms**（回落） |
| region [-3,3]² 总树数 | 40,549 | ≈20,275 | — |
| opaque 顶点（sky-structures E2E） | 2,083,572 | — | **2,054,336**（−29,236） |
| drawCalls（同上） | 806 | — | **801**（−5） |
| sections（同上） | 2006 | — | **1998** |
| Tier 4 像素值 | canopyA=[255,105,180] / ratioA=1 / wallDist=266 / channelDelta=0 | 不变 | ✅ **逐位相同**（fixture 是单棵树，与密度无关） |

**验证**：`npm run check` 0 error / 13 既有 warning；5 条相关 spec 全绿
（harness 浏览器内单测 0 失败 / sky-structures E2E / sky-tree-visual Tier 4 /
structure-gen / worker-gen）；三通道 `_capacity.*.maxVertexCount` 仍全 = 标定值（**零扩容**）。

**genP95 门的处置（用户裁决）**：密度减半后实测 **7.6~7.8ms**，已回到原 8ms 冻结预算内
→ 原撞线不再成立。用户裁决 **保留 10ms 作余量**而不收回 8ms，理由：本门是**单样本 p95**
（无平均、无舍入），7.6~7.8 对 8ms 只剩 **2.5%** 余量，高负载下会贴线抖动。
⚠️ **故 10ms 现在的性质是「保守余量」而非「撞线所需」** —— `test-structure-gen.html` 的注释
已同步改写为如实记录（保留 0.1 时的撞线历史 + 0.05 后的回落实测 + 保留 10ms 的理由），
后人读到不会误以为当前密度仍在撞线。

**文档同步**（权威文档 5 处，均已落地）：设计文档 v1.42 修订说明 ①（密度取半 + 有意偏离）
与 ④（genP95 回落 + 保留 10ms 的理由）、§4.2 正文（`< 0.05` + 单一权威指向）、
roadmap v1.42 行（删除已失真的「不降密度（mc-lite 的 10% 照搬）」→ 改为「容量守住不是靠降密度」
+ 密度减半的独立记录；以及 genP95 回落）、`m2-seed12345-comparison.md`（用户比对指引：
逐格 5% / 约 4~8 棵/岛 + 「密度是 mc-lite 一半、不是 bug」的比对口径提醒）。
⚠️ **本 spec §1~§9 正文不改**（属历史决策记录，记录的是当时「照搬 10%」的决策与其依据），
密度变更只记在本节与设计文档 v1.42 修订说明。
