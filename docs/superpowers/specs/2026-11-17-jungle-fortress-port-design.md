# 丛林要塞移植设计（Repurposed Structures fortress_jungle → 离 City 最近的森林）

日期：2026-11-17（全部实测数据采于 2026-11-17）
版本：**v3.13**（roadmap 同版本行）
状态：**待用户审批**（设计文档，未实施）
参照：废弃堡垒移植（v2.89，`2026-11-10-ruined-citadel-port-design.md`）—— 本结构复用它的
烘焙管线、空气格分层、落点搜索、压制/避让、瞬移按钮全套手法。

---

## 0. 一句话

把 Repurposed Structures 模组的 `fortress_jungle`（丛林要塞，17 片 jigsaw 素材）
**离线拼装成一个定版布局**再烘焙成 palette 产物（80,031 格 / 159×33×155 / ≈1.03MB），
**全部用既有方块重映射（零新增方块、零新增贴图）**，落在 **离 City 最近的一片森林**，
占地内地形整形压平 + 外扩 16 格「遇湿即止」缓坡，并加一个「丛林」瞬移按钮。

---

## 1. 目标与范围

### 1.1 用户裁定（2026-11-17）

| # | 裁定 | 内容 |
|---|---|---|
| ① | 移植方式 | **先离线拼 jigsaw 定版布局，再烘焙**（用户原话：「就这么做，先离线拼丛林要塞定版布局再烘焙」） |
| ② | 规模 | **把整个巨大的丛林要塞迁移过来**（取最大档，不裁件） |
| ③ | 方块 | **尽量用已有方块**；异形方块也尽量用已有的代替，**实在不行才烘少量新方块** |
| ④ | 地形处置 | **整形压平 + 16 格缓坡**（`ask_user_question` 选定，三档实测对比见 §2.6） |
| ⑤ | 定版数量 | **只做 1 个最大档**（同上选定；每个世界的要塞形状相同，只有落点随 seed 变） |

### 1.2 明确不做

- **不移植 jigsaw 的运行期随机拼装**：产物是离线拼好的定版布局（裁定 ①）。
  运行期只做「按锚点光栅化」，与既有 8 个烘焙结构完全同构。
- **不移植刷怪笼 / 战利品表 / 考古**：源 `spawner`（15 格）丢弃；`chest`（18 格）
  保留为方块但**不填内容**（本仓 chest 无战利品系统，废弃堡垒 15 格 chest 同样处理）。
- **不移植 vanilla 贴图**：源仓库 `assets/` 只有 lang + logo，**零方块贴图**（实测）。
  石砖族的苔藓/裂纹/雕纹全部映到既有方块（§3.2）。
- **不新增方块、不新增几何、不新增贴图**（裁定 ③ 的实测结论：全部有既有替代，§3.2）。
- **不改 `generateHeight` / TSL 水面遮罩的高度公式**：整形走 `apply.js` 体素覆写
  （与冰封山峰 / 高台地带 / 浅水高台 / 恶地高山同一手法，红线 1 不受影响）。

---

## 2. 实测事实（冻结数字，探针 2026-11-17）

> 全部数字可复现：离线拼装器语义逐条对照
> `RepurposedStructures/common/src/main/java/.../pieces/PieceLimitedJigsawManager.java`；
> 探针脚本在 `/tmp/jf-*.mjs`（一次性，不入库；实施时按本文算法重写进 `tools/`）。

### 2.1 素材盘点（17 片 nbt，76KB）

源目录：`common/src/main/resources/data/repurposed_structures/structure/fortresses/jungle/`

| 件 | 尺寸 | 格数 | 连接口 | 说明 |
|---|---|---|---|---|
| `center_room` | 13×15×13 | 2071 | 2（外/内各 1） | 起始件，中央大厅 |
| `4_way_outside_large` | 19×9×19 | 1051 | 4 | 最大外墙十字段 |
| `straight_outside` | 5×9×19 | 571 | 2 | 长廊外墙（带窗长墙） |
| `4_way_outside` | 7×11×7 | 539 | 4 | 外墙十字段 |
| `stairs_outside` | 7×11×7 | 497 | 2 | 外墙楼梯段 |
| `spawner` | 7×10×9 | 428 | 1 | 刷怪房（spawner 丢弃） |
| `balcony` | 9×7×9 | 554 | 3 | 阳台 |
| `stairs_inside_plants` | 13×17×13 | 2328 | 3 | 带植物的室内楼梯塔 |
| `stairs_inside` | 10×14×5 | 525 | 2 | 室内楼梯 |
| `straight_inside` | 5×7×5 | 175 | 2 | 室内直廊 |
| `4_way_inside` | 5×7×5 | 175 | 4 | 室内十字 |
| `turn_inside` / `turn_inside_chest` | 5×7×5 | 175 | 2 | 室内转角（后者带箱） |
| `terminator_1..4` | 8×8×5 | 142~171 | 1 | 端头封墙 |

**全族只有 13 种源方块**（逐格统计）：
`stone_bricks` 5749 / `cave_air` 2978 / `red_stained_glass` 588 / `iron_bars` 328 /
`jigsaw` 147 / `stone_brick_stairs` 49 / `coarse_dirt` 20 / `red_mushroom` 20 /
`water` 5 / `mossy_stone_brick_stairs` 4 / `chest` 3 / `spawner` 1 / `air` 1。

⚠️ **`red_stained_glass` 是占位符不是美术内容**：`pillar_processor` 把它替换成
`stone_bricks` 并**向下补柱到地形**（`PillarProcessor.java`，direction=down）。
588 格全在 y=0 层（逐件实测），是「墙脚支撑柱的根」。

⚠️ **苔藓/裂纹/雕纹不在 nbt 里**：由 `processor_list/fortresses/jungle_main.json` 在
生成期按概率替换（`stone_bricks` → mossy 50% / cracked 25% / chiseled 5%）。
定版烘焙必须把这个随机分布**固化成确定性分配**（§3.3）。

### 2.2 jigsaw 拼装语义（离线复刻的 7 条）

逐条对照 `PieceLimitedJigsawManager.java` + `fortress_jungle.json`：

1. **起始件** = `start_pool` 唯一元素 `center_room`，随机旋转 0/90/180/270。
2. **BFS 队列**（`availablePieces` Deque），`size: 10` ⇒ 最大深度 10。
3. **连接口** = jigsaw 的 `target: "minecraft:connection"`（不是 `name`！
   `name` 恒为 `minecraft:empty`，`pool` 才是 inside/outside）。
   ⚠️ 第一版探针按 `name === 'connection'` 过滤 ⇒ 8/8 seed 只出 1 件（静默失效）。
4. **权重抽签**：outside 池 = empty 1 / straight 8 / 4way 2 / 4way_large 4 / stairs 2 / spawner 1；
   inside 池 = empty 1 / straight 10 / 4way 4 / turn 3 / turn_chest 3 / stairs 2 / stairs_plants 2 / balcony 2。
   抽到 `empty_pool_element` ⇒ 该口终止；抽到的件放不下 ⇒ 剔除重抽。
5. **旋转对齐**：候选件的连接口 front 必须与父口 front **反向**，`target` 名相同。
6. **AABB 不重叠**：`deflate(0.25)` 后与已放件求交（`BoxOctree.withinBoundsButNotIntersectingChildren`）。
7. **`maxDistanceFromCenter` 缺省 80**：`fortress_jungle.json` 未写该字段 ⇒
   `maxDistanceFromCenter.orElse(80)` ⇒ 件中心不得超出 ±80 格。
   ⚠️ 不加这条时 seed=1 拼出 253×217（超界）；加上后 151×157。

**fallback**：inside/outside 池的 fallback 都是 `terminator`（4 个端头等权）。
feature 池（vines/breakage/drowned/vine_breakage）的 fallback 是 `minecraft:empty`。

### 2.3 拼装规模分布（200 seed 实测）

| 指标 | min | p10 | p25 | p50 | p75 | p90 | max |
|---|---|---|---|---|---|---|---|
| 件数 | 3 | 19 | 39 | **61** | 93 | 123 | **190** |
| 水平最大跨度 | 25 | — | — | **128** | — | 157 | **160** |
| 竖直跨度 | 15 | — | — | **29** | — | 41 | 58 |

**水平跨度 100% ≤ 161 格**（200/200）⇒ 定版布局的占地可预测。

件数分档：<20 件 21 个 / 20~49 件 54 个 / 50~99 件 86 个 / 100~149 件 31 个 / 150~199 件 8 个。

### 2.4 定版布局选定：seed=263（最大档）

筛选判据（400 seed 扫描）：**件数 ≥ 140 且竖直跨度 ≤ 36 且水平 ≤ 161 且 17 种件全出现**。
命中 4 个：263（193 件）/ 327（163 件，16 种）/ 163（158 件）/ 309（152 件，15 种）。
取 **263**：件数最多、17 种件全出现、竖直跨度最小（33）。

**冻结指标**（含 jigsaw `final_state` 落格 + 空气分层 + 支撑柱 + 石砖族变体）：

| 项 | 实测值 |
|---|---|
| 件数 / 件种 | **193 / 17**（全族 17 种件都出现） |
| 产物包围盒 | **159 × 33 × 155**（x∈[-78,80]，y∈[-6,26]，z∈[-77,77]） |
| 非空气包围盒（= footprint） | **159 × 155**（与产物 bbox 相同 —— 空气没撑大边界） |
| **HALF_X / HALF_Z** | **80 / 77** |
| 产物总格数 | **80,031** |
| 其中空气格（写进产物） | **16,358** |
| 丢弃的天空空气 | 13,445 |
| 支撑柱根（红玻璃） | 6,498 |
| 支撑柱格（补到 floorRow） | **6,446**，最长 **10** 格 |
| 归一化 y | **[1, 33]**（= 结构 y + 7） |
| **floorRow**（归一化） | **13**（= 结构 y=6，中央大厅地板层） |
| floorRow 层格数 | 4,958 |
| palette 种数 | **11** |
| JSON 体积估算 | **1.03 MB**（stride 5，13.43 字节/格，按 ruined_citadel 实测比） |
| 真实 mesher section 数 | **125** |
| opaque 顶点 | **291,288** ⇒ reserved 364,110 = 容量 **8.5%** |
| cutout 顶点 | **72,620** ⇒ reserved 90,775 = 容量 **4.1%** |
| transparent 顶点 | 20（5 格水） |
| 通道格数 | opaque 60,752 / cutout 2,916 / transparent 5 / none 16,358 |

⚠️ **`floorRow` 必须是派生冻结常量，不能用 `floorRowOf()` 读**：后者读主线程模块缓存，
而产物只在 GEN Worker 里加载过 ⇒ 主线程恒返回兜底值 1（废弃堡垒的
`RUINED_CITADEL_FLOOR_ROW` 与大竞技场都踩过同源坑）。故 `jungle-fortress-data.js`
导出 `JUNGLE_FORTRESS_FLOOR_ROW = 13`，由单测的产物对账用例钉住（产物是权威）。

**palette 逐格冻结值**（目标方块名）：

```
mossy_stone 30503 / air 16358 / cobblestone 15085 / stone_bricks 12092 /
tuff_bricks 3012 / vertical_pillar 2682 / cobblestone_step 156 / dirt 60 /
red_mushroom 60 / chest 18 / water 5
```

**台阶朝向分布**（旋转后，`FACING_TO_ORIENT` 复用巨型金字塔那张表）：

```
cobblestone_step:0 = 24 / :1 = 54 / :2 = 69 / :3 = 12
```

⚠️ **两族台阶合并成同一个目标**（`stone_brick_stairs` 144 + `mossy_stone_brick_stairs` 12
= `cobblestone_step` 156），故朝向分布是**合并后**的四档，不是分族八档。

⚠️ **为什么不用 `stone_diorite_step`（builder check 改判）**：初稿按「石砖→石台阶」
直觉映了它，但**实测 tile 均色 189,188,189**，而墙体加权均色是 **113,116,107**
⇒ 台阶比墙亮 **76**，156 个亮白台阶贴在暗苔墙上会非常显眼。
`Cobblestone` 均色 **125,125,125**（差 12）才是匹配档。
两者**几何完全同模板**（`geometry: "cobblestone_step"`，实测 4 朝向 cutout 顶点
逐位相同 192）⇒ 换目标**零 mesher 成本变化**，只改贴图。

⚠️ 源台阶 **53 格全是 `shape=straight` + `half=bottom`**（逐格实测）⇒
**无倒置台阶、无 inner/outer 转角**，不需要 `_updown` 变体，也不需要 `(orient+2)%4`。

**件数直方图**（冻结，供门禁比对）：

```
center_room 1 / straight_outside 44 / 4_way_outside 26 / stairs_outside 28 /
4_way_outside_large 14 / spawner 15 / straight_inside 22 / 4_way_inside 7 /
turn_inside 8 / turn_inside_chest 2 / stairs_inside 3 / stairs_inside_plants 3 /
balcony 5 / terminator_1 5 / terminator_2 7 / terminator_3 1 / terminator_4 2
```

### 2.5 空气分层（本结构特有的关键决策，同废弃堡垒 DR-2）

nbt 里的 `cave_air` 分两类，**必须区别对待**：

| 类 | 判据 | 格数 | 处置 |
|---|---|---|---|
| **房间内腔** | 同 y 层水平洪泛**走不到**结构 bbox 外 | **16,358** | **写进产物**（`air`，id=0 ⇒ 清空天然岩层） |
| 露天天空 | 同 y 层水平洪泛**能走到** bbox 外 | 13,445 | 丢弃（写了 JSON 涨到 1.4MB+） |

**判据 D（水平洪泛）的推导**（三档对照实测）：

| 判据 | 留 | 丢 | 问题 |
|---|---|---|---|
| A：全部空气都写 | 29,803 | 0 | JSON 涨 37%，天空空气无意义 |
| B：上方 12 格内有顶盖 | 10,599 | 19,204 | **漏掉露天走廊**（城墙顶部走道上方无盖） |
| C：±X/±Z 各 8 格内撞到实心 | 5,681 | 24,122 | **漏掉宽房间**（19 格宽的 4_way_large 中心距墙 9 格） |
| **D：同层水平洪泛到 bbox 外** | **16,358** | **13,445** | ✅ 正确 |

（四档均在**同一口径**下实测：含 jigsaw `final_state` 落格，空气格总数 29,803。）

⚠️ **洪泛只在同 y 层做，竖直不传播**：屋顶开口（breakage feature 打的洞）若让洪泛
竖直传播，会把整间房判成天空 ⇒ 房间被天然岩层填实。

⚠️ **洪泛的「可通」包括未写格**（nbt 没写的格 = 天空），不只是 `cave_air`。

### 2.6 地形处置：三档实测对比（用户选定「整形压平 + 缓坡」）

FOREST 的地表起伏远大于 DESERT（`TERRAIN_HEIGHT_PARAMS` 无 FOREST 压平系数）：

| 占地 | 全 FOREST + 全干燥候选（8 seed） | 最小 span |
|---|---|---|
| 253×241 | **0 / 0 / 0 / 0 / 0 / 0 / 0 / 0** | — |
| 181×181 | 1 / 5 / 6 / **0** / 7 / 4 / 3 / 3 | 16 |
| 177×177 | 8/8 都有 | 16 |
| **161×155**（本结构） | **995 / 747 / 870 / 867 / 859 / 978 / 872 / 736** | **14~16** |
| 121×121 | 1306 / 1031 / … | 12 |

⇒ **161×155 是可行的最大档**，但 span 14~16（沙漠只有 5）⇒ 必须整形。

三档处置实测（seed=263 布局，floorRow=6）：

| 方案 | 挖方 | 填方 | 地上房间被埋 | 墙脚露空列 | 观感 |
|---|---|---|---|---|---|
| **① 整形压平 + 缓坡**（选定） | **217,221** | **0** | **0** | **0** | 堡垒坐在林间平地，边缘缓坡过渡 |
| ② 只清结构占用列 | 80,989 | 0 | **5,425 格** | 458 | 城墙走廊一半在土里 |
| ③ 整体架高 + 支撑柱 | 1,877 | **65,867** | 70 | **8,925** | 堡垒浮在土坡上、底部石柱林 |

（②③ 两档的量测在不含 `final_state` 的早期探针上做，与 §2.4 的最终产物差 667 格空气；
三档的**相对差距**（千格 vs 万格）不受该口径影响，选型结论成立。① 是最终口径实测值。）

### 2.7 缓坡带：「遇湿即止」自适应带宽（关键设计）

**问题**：固定 16 格缓坡带会触水 —— 193×187 范围内**全干燥候选 = 0**（8/8 seed）。
缓坡带内低于海平面的列有 810~1415 个，产生两类撕裂：
- **A 假水面**：自然 `h < SEA_Y`（遮罩渲水面）但整形抬成陆地 ⇒ 陆地上冒假水；
- **B 无波纹**：整形后低于海平面（有体素水）但遮罩不渲 ⇒ 静态水顶面。

**六档方案实测**（seed 12345）：

| 方案 | 挖方 | 填方 | 水格 | A | B | 边缘跳变 |
|---|---|---|---|---|---|---|
| 纯插值（不钳制） | 217,307 | 840 | 1305 | 190 | 0 | 1 |
| 钳到 `SEA_Y+1`（只削） | 217,307 | 3276 | 0 | 0 | 0 | **8** ← 填湾造坎 |
| 钳到 `SEA_Y+1`（可填） | 217,307 | 3276 | 0 | 0 | 0 | **8** |
| 区内抑制门控 | 217,307 | 840 | 1305 | 0 | **1131** | 1 |
| 区内强制渲门控 | 217,307 | 840 | 1305 | **34,960** | 0 | 1 |
| **遇湿即止（选定）** | **217,221** | **0** | **0** | **0** | **0** | **1** |

**「遇湿即止」算法**（逐列）：

```
e = 该列到占地矩形的切比雪夫距离（占地内 e=0）
若 e=0：target = floorY
否则：
  沿该列的 outward 路径从 k=1 走到 16，
  遇到第一个 generateHeight <= SEA_Y 的列 ⇒ w = k-1，停止
  若 e > w：该列不动（在自适应带外）
  否则：target = min(round(floorY + (h - floorY) × e/w), h)   // w=0 时 target=floorY
```

**为什么它同时解决三个问题**：
1. **零水格**：湿列及其外侧一律不动 ⇒ 整形区内恒干燥 ⇒ 遮罩恒假 ⇒ A=B=0，
   **不需要改 `ocean-mask.js` / `ocean.js`**（红线 1 零风险）。
2. **边缘零悬崖**：插值分母用**逐列带宽 w** 而不是固定 16 ⇒ 带末 `e=w` 时
   `target = h` ⇒ 与自然地形连续。实测**边缘最大跳变 1、区内最大跳变 1**
   （对照 HEAD 自然地形在该处的跳变也是 1）。
3. **只削不填**：`min(t, h)` ⇒ 填方恒 0，不需要「填实基座下方」那套逻辑。

**8 seed 冻结值**：

| seed | floorY | 整形列数 | 挖方 | 填方 | 水格 | 边缘跳变 | 区内跳变 |
|---|---|---|---|---|---|---|---|
| 12345 | -1 | 34,770 | 217,221 | 0 | 0 | 1 | 1 |
| 99999 | -1 | 34,571 | 219,376 | 0 | 0 | 1 | 1 |
| 1249026 | -1 | 34,891 | 219,190 | 0 | 0 | 1 | 1 |
| 20260101 | 0 | 35,031 | 188,049 | 0 | 0 | 1 | 1 |
| 777 | -1 | 34,494 | 219,614 | 0 | 0 | 1 | 1 |
| 4242 | 0 | 34,955 | 187,578 | 0 | 0 | 1 | 1 |
| 31337 | -1 | 35,060 | 217,313 | 0 | 0 | 1 | 1 |
| 8888 | 0 | 34,970 | 187,688 | 0 | 0 | 1 | 1 |

带宽分布：min 1~3 / 中位 16 / max 16（多数方向能走满 16 格）。
整形区 biome：FOREST 99.9%（少量 AZALEA/PLAINS 侵入，≤30 列）。

### 2.8 GEN 成本（实测，对照 10ms 冻结门）

- 整形涉及 **164 个 column**，最密 column 写 **4,267 格**（削平 + 铺地表）。
- 最密 column 整形耗时 **0.112 ms**（50 轮均值，typed array 逐格写，同
  `fillShallowTarnBasin` 口径）⇒ 占 `genP95 < 10ms` 门的 **1.1%**。
- 结构光栅化平均 **721 格/column**（80,031 格 / 110 个 column）。
- 锚点搜索（粗筛 8 格网格 + 距离排序 + 精检早退）：**54.8 ms**
  （网格 41.0 + 粗筛排序 9.4 + 精检 4.4，**只 1 次精检 / 24,955 格**）。
  ⚠️ 与废弃堡垒同口径：**必须在 `world-worker.js` 的 layout 入口预热**，
  否则首个 GEN 付这 55ms（废弃堡垒实测 141ms 就是这么来的）。

### 2.9 落点环境（8 seed 冻结锚点表）

判据（与废弃堡垒同构，§3.4）：占地 161×155 全 FOREST + 全干燥 + 城市净距 32 +
避让五类地基级结构 + 取距 City 中心最近。

| seed | 锚点 (wx,wz) | floorY | h max | span | 距 City | 瞬移落点 (x,y,z) |
|---|---|---|---|---|---|---|
| 12345 | (304, -392) | -1 | 15 | 16 | 509 | (304, 2, -309) |
| 99999 | (608, -88) | -1 | 15 | 16 | 562 | (522, 2, -88) |
| 1249026 | (152, 688) | -1 | 15 | 16 | 512 | (152, 2, 605) |
| 20260101 | (128, 648) | 0 | 15 | 15 | 553 | (128, 3, 565) |
| 777 | (552, 480) | -1 | 15 | 16 | 528 | (466, 2, 480) |
| 4242 | (256, 776) | 0 | 15 | 15 | 592 | (256, 3, 693) |
| 31337 | (176, 696) | -1 | 15 | 16 | 589 | (176, 3, 613) |
| 8888 | (8, 528) | 0 | 15 | 15 | 495 | (8, 3, 445) |

**8/8 seed 都有解**，候选数 663~809（加完整避让后）。
落点 = 占地**靠 City 那一侧**缘外 6 格，y = **整形后**地表 + 1（不是自然高度！
落点在缓坡带内，8/8 都被整形改写，自然 h 4~6 → 整形后 1~2）。
落点 5×5 高差 ≤ 2（整形后恒 1）。

⚠️ **与废弃堡垒/大竞技场的方向判据不同**：那两个是固定方向（城西/城东），
本结构是**逐 seed 取「靠 City 的那一侧」**（锚点可能在 City 的任意方位）。
判据：`|ccz - wz| >= |ccx - wx|` ⇒ 走 Z 缘，否则走 X 缘。

### 2.10 世界高度核对（零裁切）

世界 y∈[-32, 96]。floorRow=13（归一化），产物 y∈[1,33]。
落位后世界 y = `floorY + (ny - 13)`：

| floorY | 世界 y 范围 | 是否越界 |
|---|---|---|
| -1 | **[-13, 19]** | 否（-13 > -32，19 < 96） |
| 0 | **[-12, 20]** | 否 |

⇒ **8/8 seed 零裁切**，产物完整落地。

---

## 3. 设计决策

### DR-1 烘焙管线（复用废弃堡垒模式，零新方块）

三个新文件 + 一个 npm script，与 `ruined-citadel` 逐一同构：

| 文件 | 职责 |
|---|---|
| `tools/jungle-fortress-fingerprint.mjs` | 映射表 / 拼装参数 / 产物指标 / 输入指纹（node 侧，`src/` 不得 import） |
| `tools/bake-jungle-fortress.mjs` | 离线拼装 + 空气分层 + 支撑柱 + 变体分配 + 写产物；`--census` / `--census-orient` |
| `src/gen/structures/jungle-fortress-data.js` | 纯数据（VARIANTS / HALF_X / HALF_Z / FLOOR_ROW），零 node 依赖 |
| `src/gen/structures/jungle-fortress.js` | 落点搜索 + 整形 + 让路判据（Worker 同构，无 three） |

素材**入库** `assets/jungle-fortress/src/`（17 片 nbt，76KB），指纹不依赖仓库外文件。
产物 `assets/structures/jungle_fortress.json` + `.meta.json`。
npm script：`"junglefortress": "node tools/bake-jungle-fortress.mjs"`。

⚠️ **离线拼装器是本结构独有的新代码**（既有 8 个烘焙结构都是固定偏移拼合）。
它必须：
- 逐条实现 §2.2 的 7 条语义，**参数全部进指纹**（池权重 / size / boxRange / 定版 seed）；
- 用**确定性 PRNG**（mulberry32，seed=263 固定），不用 `Math.random`；
- `--census` 打印件数直方图 + 逐层覆盖率 + 空气分层统计 + 通道分布，供冻结值核对。

### DR-2 空气格写进产物（同废弃堡垒 DR-2，判据换成水平洪泛）

- palette 加 `"air"` 条目（id=0，`cullMode:'none'` ⇒ 不渲染任何面）；
- **房间内腔 16,358 格**写进产物（判据 D，§2.5）；露天天空 13,445 格丢弃；
- `rasterizeStructure` **零改动**：`air` 只是一个恰好 id=0 的普通 palette 条目，
  `makeColumnSetter` 查 `registry.idOf('air') === 0` → `blocks[idx] = 0` ⇒ 清空格。

⚠️ **失效形态是静默的**：格数/类型/指纹全对，只有走进去才发现房间被岩层填实
⇒ 门禁必须用**内容级判据**（air 格数 = 16,358）钉住，指纹拓不到。

### DR-3 方块映射总表（13 种源方块 → 11 种既有方块，零新增）

| 源方块 | 格数 | 目标 | 理由 |
|---|---|---|---|
| `stone_bricks` | 5749+柱 | **四色分配**（见 DR-4） | 本仓有 `stone_bricks` tile |
| `cave_air` / `air` | 2978+ | `air`（分层，DR-2） | id=0 |
| `red_stained_glass` | 588 | `stone_bricks`（+向下补柱） | `pillar_processor` 语义 |
| `iron_bars` | 328 | **`vertical_pillar`** | 见下方「栏杆选型」 |
| `stone_brick_stairs` | 49 | **`cobblestone_step`** | 既有石台阶，facing→orient；**不用 `stone_diorite_step`**（见下） |
| `mossy_stone_brick_stairs` | 4 | `cobblestone_step` | 同上，两族合并 |
| `coarse_dirt` | 20 | `dirt` | 本仓无砂土 |
| `red_mushroom` | 20 | `red_mushroom` | 同名直通 |
| `chest` | 3 | `chest` | 同名直通（不填内容） |
| `water` | 5 | `water` | 中央大厅水池（y2~6 竖井） |
| `spawner` | 1 | **丢弃** | 本仓无刷怪笼系统 |
| `jigsaw` | 147 | 按 `final_state` 落格 | `structure_void` 丢弃 |

**栏杆选型（三档实测，这是裁定 ③ 的核心）**：

| 候选 | 几何 | 顶点/格 | 2683 格 cutout | 占容量 | 观感 |
|---|---|---|---|---|---|
| `handrail` | 0.5² 柱 + 两臂 | 72 | 201,428 | **11.4%** | 木色，每格伸两臂（窗里像十字） |
| **`vertical_pillar`**（选定） | 0.3² 通高方柱 | 24 | **72,644** | **4.1%** | 木色细柱，**能看过去** |
| `iron` | 整块铁 | 24(opaque) | 8,252 | 0.5% | 铁灰色但**窗变铁墙、看不过去** |
| `glass_block` | 整玻璃 | 24(trans) | 18,400(trans) | — | 透明但无栏杆形态 |

选 `vertical_pillar` 的理由：
1. **形态最接近**：原版 `iron_bars` 是窗洞里的细竖条，`vertical_pillar` 是 0.3 宽通高柱
   （竖直堆叠 3 格 = 连续竖条，实测 bbox y[2,5] 连续）；`handrail` 每格伸两臂，
   竖直堆叠后是「每格一个十字」，形态差更远。
2. **能看过去**：`iron` 是整块不透明 ⇒ 窗洞被堵死（实测窗洞遮挡率 100%），
   而原版铁栏杆窗是能看出去的。这是**玩法级差异**，不是观感偏好。
3. **cutout 省 64%**：72,644 vs 201,428（`handrail`）。
4. **4 向对称** ⇒ `orient` 恒 0，**不需要栏杆朝向 pass**（废弃堡垒那套
   `computeRailOrientations` 整个不用搬）。

⚠️ **已知偏离**：颜色是木色（184,141,90）不是铁灰（220,220,220）。
用户裁定 ③ 是「尽量用已有方块」，本仓唯一的细竖件就是木色柱子。
**若用户要求铁灰色**，最小改动是给 `vertical_pillar` 加一个铁灰贴图变体
（1 个新方块 + 1 张程序化贴图，几何零新增）—— 本设计**不做**，等用户提。

### DR-4 石砖族变体分配（把生成期随机固化成确定性）

上游 `jungle_main.json` 的概率：`stone_bricks` → mossy 50% / cracked 25% / chiseled 5%
（剩 20% 保持纯石砖）。定版烘焙用 **mulberry32(20261117)** 逐格抽签固化：

| 目标 | 概率 | 实测格数 | tile 均色 |
|---|---|---|---|
| `mossy_stone`（Mossy_Cobblestone） | 50% | **30,503** | 104,110,93 |
| `cobblestone`（Cobblestone） | 25% | **15,085** | 125,125,125 |
| `tuff_bricks`（Tuff_Bricks） | 5% | **3,012** | 99,103,95 |
| `stone_bricks`（Stone_Bricks） | 20% | **12,092** | 122,122,122 |

**加权均色 113,116,107（g−r = 3，略偏绿）** —— 对照纯石砖 122,122,122。
这是「苔藓覆盖」的正确观感（丛林要塞就该长苔）。

⚠️ **映射理由**：本仓无 `mossy_stone_bricks` / `cracked_stone_bricks` /
`chiseled_stone_bricks` 三种贴图（atlas 实测只有 `Stone_Bricks` / `Mossy_Cobblestone` /
`Cobblestone` / `Tuff_Bricks`）。`mossy_stone` 用的是 Mossy_Cobblestone tile（苔石圆石），
不是苔石砖 —— **纹理是圆石不是砖**，这是裁定 ③ 下的最近似。

⚠️ **变体分配不改变 mesher 成本**（四者都是 opaque box，实测分配前后
opaque/cutout/section 逐位相同）⇒ 不需要重测预算。

⚠️ **`infested_*` 四种**（上游 5% 概率）本仓无对应 ⇒ 并入基础色，不单独处理。
**`gravel` / `suspicious_gravel`**（上游 surface processor 20%/1%）本仓无砂砾 ⇒
本设计**不移植 surface processor**（它的作用是「风化掉块」，定版布局里直接不施加）。

### DR-5 支撑柱（`pillar_processor` 语义，烘焙期固化）

588 格红玻璃（逐件 y=0）→ 替换成 `stone_bricks`，并**向下补柱到 floorRow 层**：

```
对每个红玻璃格 (x, y, z)：
  写 (x,y,z) = stone_bricks
  从 y-1 向下到 floorRow(6)：
    遇实心（nbt 里的非空气）⇒ 停
    遇保留空气（房间内腔）⇒ 停   ← 关键：不穿房间地板
    否则写 stone_bricks
```

实测：**6,498 根 / 6,446 格 / 最长 10 格**。

⚠️ **「遇房间地板即停」是载荷性的**：不停的话柱子会穿过房间地板插进室内
（实测 seed=263 有 414 格柱穿房间）。加上这条后 **0 格穿房间**。

⚠️ **柱底是 floorRow 而不是逐格地形**：整形后占地内地表恒 = floorY = 结构 y6，
故柱补到 y6 即止。**这是「整形」与「支撑柱」的耦合** —— 若改成不整形方案，
柱底必须换成逐格 `generateHeight`（实测那样要补 5.6 万格，最长 25 格）。

### DR-6 落位：离 City 最近的森林（与废弃堡垒同构，方向判据不同）

新文件 `src/gen/structures/jungle-fortress.js`，导出：

| 函数 | 职责 |
|---|---|
| `computeJungleFortressAnchor(seed)` | 全局唯一锚点（memo，纯函数） |
| `jungleFortressCandidateValid(wx,wz,seed)` | 单点合法性（导出供单测复用，红线 1） |
| `inJungleFortressFootprint(wx,wz,anchors)` | 占地判定（唯一权威） |
| `jungleFortressOverlapsRegion(anchor,rx,rz)` | layout 层 AABB 裁剪 |
| `jungleFortressSuppressedLandmarks(...)` | 地标压制（圆↔矩形相交） |
| `snowLandSuppressedByJungleFortress(...)` | 雪原整座让路 |
| `jungleFortressTeleportPoint(seed)` | 瞬移落点（唯一权威） |
| `jungleFortressSurfaceYAt(wx,wz,seed,anchor)` | **整形后地表高度**（纯函数，瞬移/落位共用） |

**判据**（先严后松不需要 —— 8/8 seed 在 span≤16 下都有解）：
1. 占地 161×155 **逐格**全 FOREST；
2. 占地逐格 `generateHeight > SEA_Y`（干燥）；
3. 与 City bounds 净距 ≥ `CITY_TRANSITION_SIZE`(32)（方↔方，**整个占地出城**）；
4. 避让五类地基级：城市 / 高台地带 / 浅水高台 / 围场 / 大竞技场 / **废弃堡垒**；
5. 取距 City 中心**最近**（tie 用 x→z 字典序，确定性）。

**搜索手法**（照搬废弃堡垒，实测 54.8ms）：
- 粗筛 8 格网格（`floor(HALF/STEP)`，**x/z 半宽不同 ⇒ giX/giZ 分开算**）；
- 网格向四周外扩 gi 格（否则窗边缘候选邻域越界被误杀）；
- 候选按距离排序，逐个精检（**早退**：遇非 FOREST/湿格立即返回）；
- ⚠️ **粗筛只能是必要条件**（`floor` 不是 `ceil`），否则误杀更近的合法候选。

⚠️ **`floorY = 占地最低 generateHeight`**（不是均值/分位数）：
保证占地内**只削不填**（填方恒 0），且 floorY 恒 > SEA_Y（干燥判据保证）。

### DR-7 地形整形（新文件 `jungle-fortress-terrain.js`，同浅水高台手法）

```
fillJungleFortressGround(column, anchor, seed, registry):
  只扫本 column 与「占地 + 16 格外接方形」的交集
  逐列算 e（切比雪夫距离）与 target（DR-7 的遇湿即止算法）
  ① 削平：target 以上一律写 0（含原山体）
  ② 地表：target 层写 grass（FOREST 地表材质，复用 surfaceTypeOfBiome）
  ③ 向下填实：只填空气（防玩家掉进 carveCaves 的洞）
  ④ 不填水（整形区恒干燥，§2.7）
```

⚠️ **三件事的顺序是载荷性的**：先削平再铺地表再填实。反序会把地表削掉。

⚠️ **`jungleFortressSurfaceYAt` 是唯一权威**：整形、瞬移落点、单测三处共用同一份
「遇湿即止」算法（红线 1）。不得各写一份插值 —— 两份漂移会让瞬移落点与真实地表差几格
（浅水高台踩过完全同形的坑）。

⚠️ **缓坡带的地表材质**：用 `surfaceTypeOfBiome(getBiome(...))`（FOREST→grass，
AZALEA→moss，PLAINS→grass），**不硬编码 grass** —— 整形区有 ≤30 列非 FOREST。

### DR-8 apply.js 接线：新阶段 2.95

层序（在废弃堡垒 2.94 之后、空中结构 2.5 之前）：

```
阶段 2.95：丛林要塞
  ① fillJungleFortressGround（整形，必须先于光栅化）
  ② rasterizeStructure('jungleFortress', wx, floorY - (floorRow-1), wz, …, false)
```

⚠️ **不补 groundSupport**：支撑柱已在烘焙期固化（DR-5），运行期再补会穿房间。

**让路接线**（一个 `kind` 分支覆盖全部下游，同浅水高台）：
- `pointContext` 加 `kind: 'jungleFortress'` 分支（判据转调 `inJungleFortressFootprint`，
  范围 = **整形区**而不是占地 —— 缓坡带的地表也被改写过，树长在缓坡上会穿模）；
- 阶段 2.7 撒布剔除（同废弃堡垒）；
- layout 层：`jungleFortressSuppressedLandmarks` + `snowLandSuppressedByJungleFortress`。

⚠️ **新 kind 自动被三个既有判据挡住，无需改它们**（builder check 逐个核对源码确认）：

| 判据 | 实现 | 新 kind 的效果 |
|---|---|---|
| `giantAllowedAtFor` | `kind === 'normal' \|\| kind === 'water'` | 自动 false ✅ |
| `azaleaAllowedAtFor` | `kind === 'normal' && biome === 'AZALEA'` | 自动 false ✅ |
| `azaleaCrownAllowedAtFor` | `kind === 'normal'` | 自动 false ✅ |
| 阶段 3 各分支 | `if (ctx.kind === 'normal') … else if …` | 无匹配分支 ⇒ 不生成 ✅ |

⚠️ **不要用 `kind: 'none'`**（巨型金字塔/围场/大竞技场用的是它）：`'none'` 语义是
「这里什么都不长」，而本结构的整形区**将来可能要长草**（缓坡带是自然地表）。
用专属 kind 保留那个扩展位，与 `'tarn'` / `'shallowTarn'` 同口径。

⚠️ **`pointContext` 的新分支必须放在 `shallowTarn` 之后、`giantPyramid` 之前**：
锚点层已保证与浅水高台互斥（避让判据），两者不会同时命中；放在城市之后保持
「城市优先级最高」的既有语义。

⚠️ **廉价距离门**（性能关键，大竞技场 v2.85 实测 +9.7% 的教训）：
`jungleFortressSuppressedLandmarks` 对每个 region 都调，内部要扫全区沙漠/空岛
⇒ 必须先算 region AABB 到要塞矩形的最近距离，超过最大地标半径就早退。
**x/z 半宽不同 ⇒ gapX/gapZ 分别用 HX/HZ 算**。

### DR-9 预算（全部实测，零容量改动）

| 项 | 本结构 | 容量 | 占比 |
|---|---|---|---|
| opaque reserved | 364,110 | 4,275,000 | **8.5%** |
| cutout reserved | 90,775 | 2,200,000 | **4.1%** |
| transparent reserved | 25 | 300,000 | 0.01% |
| JSON 体积 | 1.03 MB | — | 废弃堡垒 3.7MB 的 28% |
| GEN 整形最密 column | 0.112 ms | 10 ms 门 | **1.1%** |

⇒ **不动 `CAPACITY`、不动 `m3-fullscene` 的 200MiB 门、不动 `genP95` 门**。

⚠️ **藤蔓 feature 若移植**（§4 开放项）：498 处 × ≤3 格 × 8 顶点 = 上界 11,952
cutout 顶点（占容量 0.68%），实测贴墙 3 格净增 24 顶点 ⇒ 预算无压力。

### DR-10 瞬移按钮（第 9 个，文案 2 字）

⚠️ **布局账（v2.89 实测的延续）**：八按钮时每只 43.4px / 文字可用 31.4px，
3 字（36px）已折行。**加第 9 个后每只 ≈38.2px / 文字可用 ≈26.2px** ⇒
**2 字（24px）是上限，且 gap 必须保持 4px**。

- 按钮文案：**「丛林」**（2 字，用户可见）；toast 用全名「丛林要塞」。
- id：`btn-teleport-jungle-fortress`；`Game.teleportToJungleFortress()`。
- 落点：`jungleFortressTeleportPoint(seed)`（DR-6 唯一权威），
  y 用**整形后**地表 + 1（8 seed 实测 y=2~3，自然高度是 4~6 ⇒ 用自然值会悬空 2~4 格）。
- 成功后自动关面板（`_teleportThenAutoClose`，同其余 6 个跳转按钮）。

⚠️ **`tests/teleport.spec.mjs` 的 ORDER/LABELS 数组要扩到 9 项**，
且「同一行不换行」断言必须重测（第 9 个按钮可能把行撑破 —— 若撑破，
**停下来报告**，不擅自改布局或缩文案到 1 字）。

### DR-11 许可备注

Repurposed Structures 是 **LGPL-3.0**（`LICENSE.txt` 实测）。
结构 nbt 是数据不是代码，入库 76KB 素材 + 注明出处与许可。
**不复制任何 vanilla 贴图**（源仓库本来就没有）。

---

## 4. 实施步骤（按依赖顺序）

### 阶段 A：素材入库 + 离线拼装器
1. 17 片 nbt 复制到 `assets/jungle-fortress/src/`（逐字节，不改）。
2. 写 `tools/jungle-fortress-fingerprint.mjs`：池权重 / size=10 / boxRange=80 /
   定版 seed=263 / 映射表 / 变体概率 / METRICS 占位。
3. 写 `tools/bake-jungle-fortress.mjs` 的拼装器（§2.2 七条语义）+ `--census`。
4. **跑 `--census` 核对 §2.4 的件数直方图**（193 件 / 17 种）—— 不符就停下查拼装器。

### 阶段 B：烘焙管线
5. 空气分层（判据 D 水平洪泛）+ 支撑柱（DR-5）+ 变体分配（DR-4）。
6. `--census` 冻结 METRICS（格数 80,031 / air 16,358 / palette **11** / bbox 159×33×155）。
7. `--census-orient` 用真实 mesher 校验 `FACING_TO_ORIENT`（复用巨型金字塔那张表）。
8. 写产物 + meta，跑 `npm run atlas`（**零新增贴图 ⇒ atlas 应当逐字节不变**，
   若变了说明误放了源图进 `assets/textures/`）。

### 阶段 C：生成层
9. `jungle-fortress-data.js`（纯数据）+ `structure-json.js` 注册 VARIANTS。
10. `jungle-fortress.js`（落点搜索 + 让路判据 + 瞬移落点）。
11. `jungle-fortress-terrain.js`（整形 + `surfaceYAt` 唯一权威）。
12. `structure-layout.js` 接线（锚点 + 压制 + 雪原让路）。
13. `apply.js` 阶段 2.95 + `pointContext` 分支 + 撒布剔除 + **惰性预载**
    （`if (layouts.some(l => l.jungleFortress)) needTypes.add(...)`，同废弃堡垒 ——
    1.03MB 产物无条件预载会让每个新 Worker 的首个 GEN 付冷 fetch+解析）。
14. `world-worker.js` layout 入口预热锚点（§2.8）。

### 阶段 D：UI
15. `Game.teleportToJungleFortress()` + 面板第 9 个按钮 + toast 文案。

### 阶段 E：门禁与测试
16. `check:data` 加 `[丛林要塞]` 环节（指纹 / 格数 / air 格数 / palette / bbox /
    floorRow / stride / 台阶朝向分布 / 件数直方图 / 两侧 VARIANTS 一致 / 结构名注册）。
17. `src/tests/test-jungle-fortress-gen.js`（Tier 1 TDD）+ 注册进 `index.html`。
18. `tests/jungle-fortress.spec.mjs`（Tier 4 像素 + 接线）。
19. `tests/teleport.spec.mjs` 扩到 9 按钮。

### 阶段 F：验证
20. `npm run check` + `npm test` + `npm run bench -- --check`。

---

## 5. 测试计划（testing-policy 分级）

### Tier 1（必须 TDD）

| 用例 | 判据 | 负向验证 |
|---|---|---|
| 拼装器确定性 | 同 seed 两次拼装逐件逐格相同 | 换 PRNG seed ⇒ 件数直方图变 |
| 拼装器语义 | 件数直方图 = §2.4 冻结值 | 去掉 boxRange=80 ⇒ 跨度 >161 |
| 连接口判据 | 按 `target==='connection'` 过滤 | 改按 `name==='connection'` ⇒ 只出 1 件 |
| 空气分层 | air 格数 = 16,358 | 改判据 B（顶盖）⇒ 10,599；改判据 C ⇒ 5,681 |
| 洪泛不竖直传播 | 屋顶开口不改变房间判定 | 加竖直传播 ⇒ air 格数骤降 |
| 支撑柱不穿房间 | 柱格 ∩ 房间空气 = 0 | 去掉「遇房间地板停」⇒ 414 格穿房间 |
| 台阶朝向 | 逐档 = §2.4 冻结分布（合并后四档 24/54/69/12） | 去掉 facing 旋转 ⇒ 分布变 |
| 台阶目标色匹配 | 目标是 `cobblestone_step` 不是 `stone_diorite_step` | 改回 diorite ⇒ 断言红（tile 均色差 76） |
| floorRow 派生常量 | `JUNGLE_FORTRESS_FLOOR_ROW === 产物 floorRow` | 改成读 `floorRowOf()` ⇒ 主线程得 1 |
| 落点最近性 | 锚点是最近合法候选（转调 `candidateValid`） | 粗筛用 ceil ⇒ 误杀更近候选 |
| 整形唯一权威 | `surfaceYAt` 与整形逐格一致 | 两份插值漂移 ⇒ 落点差几格 |
| 遇湿即止 | 整形区零水格、边缘跳变 ≤1 | 固定带宽 16 ⇒ 1131 水格 |
| 整形只削不填 | 填方恒 0 | 去掉 `min(t,h)` ⇒ 填方 840 |
| 瞬移落点 | y = 整形后地表+1，8 seed 冻结表 | 用自然高度 ⇒ 悬空 2~4 格 |
| 让路判据 | 占地内零撒布/零树 | 漏接 `pointContext` ⇒ 树穿模 |

### Tier 2（门禁断言，免 TDD）

`check:data` 的 `[丛林要塞]` 环节（§4 阶段 E.16），重点钉：
- **air 格数 = 16,358**（内容级判据，指纹拓不到）；
- 件数直方图（拼装器算法的产物，部分堵「只改算法指纹不变」盲区）；
- 台阶朝向逐档分布（合并后四档）；
- palette **11** 种全已注册（漏注册 ⇒ `makeColumnSetter` 静默 return ⇒ 空气洞）；
- **`floorRow` 三处一致**：产物 JSON / fingerprint 的 `FLOOR_ROW` / `-data.js` 的派生常量。

### Tier 4（像素级实测）

- **要塞存在性**：瞬移后截图，石砖族像素占比 > 阈值（带「无要塞森林」对照组校准）；
- **房间可进入**：走进中央大厅截图，内部非纯黑（skylight/blocklight 正确）；
- **整形边缘无悬崖**：缓坡带截图，相邻列高度差 ≤1（几何判据，不靠目视）；
- **零假水面**：整形区内截图，无「陆地上的蓝色水面」（带对照组）。

⚠️ 像素判据必须**同时钉上下界**，且先测同状态重复截图的噪声底（AGENTS.md 既有约束）。

---

## 6. 风险与开放项

| # | 项 | 状态 |
|---|---|---|
| R1 | **栏杆是木色不是铁灰** | 已知偏离（DR-3）。用户若要铁灰，加 1 个贴图变体即可，几何零新增 |
| R2 | **苔藓纹理是圆石不是砖** | 已知偏离（DR-4）。本仓无 mossy_stone_bricks 贴图 |
| R3 | **第 9 个瞬移按钮可能撑破行** | 实施时实测行盒数；撑破则**停下报告**，不擅自改布局 |
| R4 | **feature 池（vines/breakage/drowned）未移植** | 见下方开放项 |
| R5 | **拼装器与 Java 的 PRNG 不逐位一致** | 有意偏离：定版布局只要求「形态正确 + 确定性」，不要求与某个 MC seed 逐位相同 |
| R6 | **`spawner` 15 格丢弃** | 本仓无刷怪笼系统；房间形态完整（只是少了笼） |
| R7 | **台阶纹理是圆石不是砖** | 与 R2 同源（本仓无石砖台阶贴图）。`cobblestone_step` 是色匹配档，几何正确 |

### builder check 已修的五处（2026-11-17 自审，勿改回）

1. **台阶目标 `stone_diorite_step` → `cobblestone_step`**：均色差 76 vs 12（DR-3）。
   连带 palette 12→**11** 种、朝向分布从分族八档变**合并四档 24/54/69/12**。
2. **`floorRow` 必须派生冻结常量**：`floorRowOf()` 在主线程恒返回 1（§2.4 补注）。
3. **让路 kind 用专属名不用 `'none'`**，并逐个核对三个既有 `allowedAt` 判据自动生效（DR-8）。
4. **惰性预载**漏写会让每个新 Worker 首个 GEN 付 1.03MB 冷 fetch（§4 阶段 C.13）。
5. **`pointContext` 新分支的插入位置**明确到「shallowTarn 之后、giantPyramid 之前」（DR-8）。

### 开放项：feature 池要不要移植（建议本期不做）

193 件布局里有 **1,254 个 feature jigsaw**：vines 498 / drowned 367 / breakage 205 /
vine_breakage 184。它们在上游是「生成期随机装饰」：
- `vines`：从 jigsaw 位置向下长 ≤3 格藤蔓（`StructureVineAndLeaves.java`）；
- `breakage`：36.6% 概率打一个椭球洞（`StructureBreakage.java`，风化破洞）；
- `drowned`：2/5 概率放水（溺亡装饰）；
- `vine_breakage`：藤蔓 + 破洞组合。

**本期不做**的理由：
- 定版布局已经把 `final_state` 落格（vines 的 25 格 `structure_void` 丢弃、
  5 格 `stone_bricks` 保留），**主体形态完整**；
- 藤蔓移植要新增「确定性藤蔓生长」算法（498 处 × 向下探 3 格），是独立改动；
- breakage 会**打穿墙体**，与「空气分层」判据耦合（洞会让洪泛竖直传播风险上升）。

**若用户要藤蔓**（观感上丛林要塞爬满藤是标志性的）：最小方案是烘焙期在
vines jigsaw 下方的空气格写 `vine`（既有方块，8 顶点/格，上界 11,952 cutout 顶点
= 容量 0.68%），**零运行期代码**。建议作为 v3.14 独立改动。

---

## 7. 文件清单

**新增**：
```
assets/jungle-fortress/src/*.nbt              17 片素材（76KB，入库）
assets/structures/jungle_fortress.json        产物（≈1.03MB）
assets/structures/jungle_fortress.meta.json   伴随元数据
tools/jungle-fortress-fingerprint.mjs         映射/参数/指标/指纹
tools/bake-jungle-fortress.mjs                离线拼装 + 烘焙
src/gen/structures/jungle-fortress-data.js    纯数据
src/gen/structures/jungle-fortress.js         落点 + 让路 + 瞬移
src/gen/structures/jungle-fortress-terrain.js 整形 + surfaceYAt
src/tests/test-jungle-fortress-gen.js         Tier 1 单测
tests/jungle-fortress.spec.mjs                Tier 4 + 接线
```

**修改**：
```
package.json                          + junglefortress script
src/gen/structures/structure-json.js  + VARIANTS 注册
src/gen/structures/structure-layout.js + 锚点/压制/雪原让路
src/gen/structures/apply.js           + 阶段 2.95 + pointContext + 撒布剔除
src/workers/world-worker.js           + layout 入口预热
src/core/game.js                      + teleportToJungleFortress
src/ui/settings-panel.js              + 第 9 个按钮 + 文案常量
tools/check-data.mjs                  + [丛林要塞] 环节
src/tests/index.html                  + 单测注册
tests/teleport.spec.mjs               ORDER/LABELS 扩到 9
docs/roadmap.md                       + v3.13 行
AGENTS.md                             + 高频坑（拼装器/空气分层/遇湿即止）
```

**零改动**（实测确认）：
```
src/voxel/blocks-data.js / faces-data.js   零新增方块
src/mesh/mesher.js                         零新增几何
assets/atlas.*                             零新增贴图（应当逐字节不变）
src/render/render-world.js                 CAPACITY 不动
src/render/ocean-mask.js / ocean.js        零门控改动（遇湿即止保证零水）
src/gen/terrain.js / noise.js              高度公式不动
```

---

## 8. 红线自检（AGENTS.md 四问）

| 问 | 答 |
|---|---|
| 引入了第二份权威或新缓存层？ | **否**。映射表/指标/指纹在 fingerprint 模块单份；`surfaceYAt` 是整形唯一权威；`inJungleFortressFootprint` 是让路唯一权威；台阶 facing→orient 复用巨型金字塔那张表；锚点 memo 同既有 6 个结构手法 |
| 把生成期问题推到运行期？ | **否**。jigsaw 拼装/空气分层/支撑柱/变体分配全部烘焙期固化；运行期只光栅化 + 整形（整形是地形覆写，与既有 4 个地貌同性质） |
| 在主线程做了可后台化的重计算？ | **否**。锚点搜索在 GEN Worker 的 layout 入口（预热）；整形在 GEN；光栅化在 GEN |
| 绕过统一管线新开了专属 Worker/子系统？ | **否**。走既有 `rasterizeStructure` + `makeColumnSetter` + `Scheduler` 版本协议；整形走 `apply.js` 体素覆写（同浅水高台） |

**额外自检**：
- 红线 1（数据单权威）：体素仍是 typed array，产物是可重建派生数据 ✅
- 红线 2（删除预生成）：地形 + 结构由 seed 确定性生成，存档只存 edits diff ✅
- 红线 8（同构纯函数）：`jungle-fortress.js` / `-terrain.js` / `-data.js` 无 DOM 无 three ✅
- 红线 10（worker 不继承 import map）：新模块全部相对路径 import ✅
- 资源 URL：产物经 `structure-json.js` 的 `resourceUrl()` 加载 ✅