# OpusCraft 地形调研：能否作为新地形种类补进 mc-heavy

> **性质**：调研报告（只读勘察 + 离线数值探针，**未改动任何地形生产代码**）
> **日期**：2026-11-27
> **上游**：`~/jaylli/OpusCraft`（从零重写的 Minecraft Java 1.21，TypeScript + WebGL2，MIT）
> **目的**：回答用户 2026-11-27 的「调研一下他的地形能否借鉴过来，作为一个新的地形种类增补进来」
> **姊妹报告**：[`tectonic-terrain-migration-survey.md`](tectonic-terrain-migration-survey.md)（2026-11-16/17，另一个候选上游）

---

## 0. 结论摘要

**能借鉴，但只能拿它的 2D 骨架，且必须重标定 + 改 GPU 水面遮罩。**

OpusCraft 与 Tectonic 是**同一类东西的两种形态**：都是 Minecraft 1.18+ 的
**3D 密度场**（density function）地形。区别在于：

| | Tectonic | **OpusCraft** |
|---|---|---|
| 载体 | 105 个 JSON DF + Java 配置 | **可读的 TypeScript 代码** |
| 地形算法 | 全在 JSON 里（要写解释器） | **`router.ts` 286 行直接写着** |
| 噪声原语 | 引用 vanilla jar（本仓没有） | **`noise.ts` 257 行自带完整实现** |
| biome 判定 | 引用 vanilla 参数表 | **`biomes.ts` 431 行自带 21 个 biome 的完整判定** |
| 地貌分区 | 四族 region 两层样条（**更强**） | vanilla 的 continents/erosion/ridge 三轴 |

⇒ **OpusCraft 的优势是「不用解释 JSON、不用自造噪声」**：`ImprovedNoise` / `PerlinNoise` /
`NormalNoise` / `BlendedNoise` / `Spline` 五件基础设施它全有，且是 MC 口径的忠实实现。
Tectonic 报告 §2.4 列的「四件基础设施本仓根本没有」，在这里是**现成可搬的 1276 行 TS**。

**三条本轮实测的关键数字**：

1. **2D 骨架不撞预算**：`router.column` **1.79 µs/次**；每列 4×4 子采样 **0.044 ms**
   = 8ms 门的 **0.55%**。（现状 `generateHeight` 是 0.022 ms/列。）
2. **3D 部分不可迁**：含 `BlendedNoise` 的逐格求值 **47.6 ms/列 = 门的 6 倍**。
3. **周期性消失**：现状世界平移 628 格后高度**逐格相同 97.2%**；换成 OpusCraft 的
   Perlin 后降到 **8.3%**。这是「地图多样性」最直接的收益。

**三条必须先解决的硬约束**（与 Tectonic 报告一致，但这次是 OpusCraft 的实测）：

- **GPU 水面遮罩**：`render/ocean.js` 的 TSL 同构实现了高度公式、每片元调 5 次。
  Perlin + 样条无法在 TSL 里照抄 ⇒ 必须改**高度图纹理**。
- **消费面广**：`generateHeight` 被 **63 个文件**消费、`getBiome` **40 个**；
  7 个结构 GEN 单测共 **458 条断言**要重标。
- **可走性**：重标后相邻格高差 ≤1 的比例从 **100% 降到 98.4%**，
  **0.7% 的格出现 ≥3 格陡坎**（玩家 `MAX_STEP=1.0` 上不去）。

---

## 1. 上游数据模型

### 1.1 三层结构

| 层 | 文件 | 行数 | 内容 |
|---|---|---|---|
| 噪声原语 | `src/world/gen/noise.ts` | 257 | `ImprovedNoise`（MC 口径 Perlin）/ `PerlinNoise`（octave 归一化）/ `NormalNoise`（双 Perlin + INPUT_FACTOR）/ `BlendedNoise`（legacy 3D）/ `SeedSource` |
| 气候样条 | `src/world/gen/spline.ts` | 230 | `Spline`（带 derivative 的三次 Hermite）+ `overworldOffset/Factor/Jaggedness` 三张表 |
| 密度路由 | `src/world/gen/router.ts` | 286 | `NOISES`（52 个噪声参数）+ `column()`（2D 气候）+ `corner()`（3D 密度 + 洞穴/面条/矿脉）+ `preliminarySurface()` |
| biome | `src/world/gen/biomes.ts` | 431 | 21 个 surface biome + `pickSurfaceBiome(T,H,C,E,W)` 五轴判定 |
| 生成器 | `src/world/gen/generator.ts` | 761 | `CELL_W=4 / CELL_H=8` 单元格插值 + aquifer + surface rules + decoration |

**合计可搬的核心 = 1276 行 TS**（noise + spline + router + biomes 的一半）。

### 1.2 采样模型（成本分水岭）

```
每列（4×4 格一个采样点）：
  column(x,z) → { continents, erosion, ridges, temperature, humidity, offset, factor, jaggedness }
                ↑ 纯 2D，5 个 NormalNoise + 3 张样条

每格（x,y,z）：
  slopedCheeseBase(y, c) + base3d.compute(x,y,z)   ← 3D，BlendedNoise 40 个 ImprovedNoise
  → 再叠 caves / noodle / ore vein 五个通道
  → squeeze(0.64 × 三线性插值)
```

mc-heavy 是**每列一个标量 `h`** + `fillColumn` 规则地层。
⇒ **只能取 `column()` 那一层**，把 `slopedCheeseBase(y,c) > 0` 的首个 y 当作高度。

⚠️ **这不是「简化」，是换了一个地形模型**：上游的悬崖/悬垂/洞穴由 3D 项产生，
2D 切片只能给出「每列一个顶面」。好处是接口 `generateHeight(x,z,seed)` 可保持不变。

---

## 2. 实测：成本

探针：把上游 `noise.ts / spline.ts / router.ts / rng.ts / math.ts` 用 `tsc` 编译成 JS
（`/tmp/opus-probe-zOoPbn/`，只读，未动仓库），Node v26 直接跑。

### 2.1 单价

| 量 | 实测 | 口径 |
|---|---|---|
| `OverworldRouter` 构造 | **4.31 ms** | 52 个 NormalNoise（每个两套 Perlin，共 ~600 个 ImprovedNoise） |
| `router.column(x,z)` | **1.79 µs/次** | 20 万次，含 5 个 NormalNoise + 3 张样条 |
| 2D 高度（逐格扫 y） | **2.31 µs/次** | 3000 次；`slopedCheeseBase` 从 320 往下扫 |
| 3D 高度（含 `base3d`） | **198.4 µs/次** | 1500 次 —— **比 2D 贵 86×** |

### 2.2 每列（256 格）

| 方案 | 4×4 子采样 + 双线性 | 逐格 256 次 | 占 8ms 门（逐格口径） |
|---|---|---|---|
| **现状 `generateHeight`** | — | **0.022 ms** | 0.3% |
| **OpusCraft 2D** | **0.044 ms**（带列缓存）/ 0.059 ms（无缓存） | **0.597 ms** | **7.5%** |
| OpusCraft 3D | 4.538 ms | **47.563 ms** | **594%** ❌ |

**结论**：
- **2D 骨架完全可行**。4×4 子采样 0.044 ms/列 = 门的 **0.55%**，比现状贵 2× 但绝对值极小。
- 逐格 0.597 ms = 7.5%，仍在门内但余量不多（结构还要吃 ~8ms）。**推荐 4×4 子采样**。
- **3D 不可迁**（47.6 ms/列 = 门的 6 倍）。要它就得重标定 `genP95`，属产品级决定。

> ⚠️ 4×4 子采样的**保真度未测**（Tectonic 报告 §5.C 测过它自己的四族：平均误差 0.16 格 /
> 最大 12.94 格）。OpusCraft 的高度场更陡（见 §3），落地前必须重测这条。

---

## 3. 实测：形态

口径：±1200 格步长 7（117649 点）算落差与占比；200 个 16×16 列算列内极差。
seed = 12345。

### 3.1 原生值域（各自 sea level）

| | min | max | 落差(p99−p1) | 水下占比 | 越界 [−32,96] |
|---|---|---|---|---|---|
| **mc-heavy 现状**（sea −2） | −15 | 15 | **27** | **38.4%** | 0% |
| **OpusCraft 2D**（sea 63） | 25 | 145 | **74** | **69.5%** | 2.2% |

⚠️ **上游 sea level 是 63、世界高 384 格**（`MIN_Y=−64 / MAX_Y=320`），
本仓是 **sea −2 / 高 128 格**（`WORLD_MIN_Y=−32 / WORLD_MAX_Y=96`）。
⇒ 直接搬会把 **69.5% 的世界淹掉**，必须重标。

### 3.2 重标：`h' = round((h − anchor) × K) + SEA_Y`

**anchor 取上游高度的 p38 分位**（= 48），使水下占比落回现状量级。

| k（水平缩放） | K（高度系数） | 落差 | min | max | 水下 | 越界 | 列内极差 均/最大 |
|---|---|---|---|---|---|---|---|
| 1 | 0.5 | 37 | −13 | 47 | 22.9% | 0% | 1.33 / 11 |
| 1 | 0.7 | 52 | −18 | 66 | 23.9% | 0% | 1.87 / 15 |
| 1 | 0.9 | 67 | −23 | 85 | 23.9% | 0% | 2.40 / 19 |
| **2** | **0.5** | **41** | **−13** | **76** | **19.0%** | **0%** | **2.26 / 11** |
| 2 | 0.7 | 58 | −18 | 107 | 19.9% | 0% | 3.20 / 15 |
| 2 | 0.9 | 75 | −23 | 138 | 19.9% | 0% | 4.04 / 20 |
| 3 | 0.5 | 42 | −13 | 75 | 15.4% | 0% | 2.76 / 12 |
| 3 | 0.7 | 59 | −18 | 106 | 16.2% | 0% | 3.84 / 17 |
| 3 | 0.9 | 76 | −23 | 137 | 16.2% | 0% | 4.91 / 22 |

> ⚠️ **K=0.7/0.9 在 k≥2 时 max 超过 96**（世界顶）—— 表里「越界 0%」是因为超出的格
> 少于 0.05%，但**它们会被 `fillColumn` 截断成平台**。落地时要么压 K，要么显式钳顶。

**推荐档位：k=2 / K=0.5**
- 落差 **41 格 = 现状 1.5×**（比 Tectonic 方案 B 的 72 格温和）；
- 水下 19.0%（现状 38.4%）⇒ 陆地更多，既有「全格干燥」选址判据**更容易满足**；
- 列内极差 2.26（现状 3.38）⇒ 单列更平，但**列与列之间**落差更大 = 区域感；
- 零越界；成本 0.044 ms/列。

### 3.3 周期性（这是最直接的多样性收益）

平移 628 格后比对 2000 个点：

| | 高度逐格相同 | 平均高度差 |
|---|---|---|
| **mc-heavy 现状** | **97.2%** | **0.029 格** |
| **OpusCraft 2D** | **8.3%** | **15.31 格** |

现状 `noise()` 是 sin+cos，coarse 0.08 与 fine 0.02 的公共周期 = 628.3185 格，
biome 的 `TEMP_SCALE=0.01` 周期恰好也是 628.3185 ⇒ **走 628 格就看到几乎重复的世界**。
换 Perlin（非周期）后这条自然消失。

> ⚠️ 本轮实测 **97.2%** 比 Tectonic 报告的 89.3% 更高 —— 口径不同（本轮是 ±300 窗口
> 2000 点，那份是 ±8000 逐格）。**两者都指向同一个结论**，引用时须带口径。

### 3.4 可走性（玩家 `MAX_STEP = 1.0`）

±400 格步长 3（约 71000 对相邻格）：

| | 高差 ≤1 | =2 | ≥3 |
|---|---|---|---|
| **现状** | **100.0%** | 0% | 0% |
| **OpusCraft k=2/K=0.5** | **98.4%** | 0.9% | **0.7%** |

⇒ **0.7% 的相邻格出现 ≥3 格陡坎**，玩家走不过去（`MAX_STEP=1`，士兵 `maxStep=2`）。
这在现状世界里**完全不存在**（sin/cos 的梯度天然平缓）。

**这是产品判断，不是技术问题**：陡崖是「地形多样性」的一部分，但会让玩家卡住。
三条出路：① 压 K 到 0.35（落差降到 ~29，接近现状）；② 抬玩家 `MAX_STEP`（改手感，红线 12）；
③ 接受它（原版 MC 就是这样）。**开工前必须裁决**。

---

## 4. 实测：结构选址命中率

判据 = 占地内**逐格全干燥**（`h ≥ SEA_Y`）且**高差 ≤ span**。400 个候选点。

| 结构 | 现状 | OpusCraft k=2/K=0.5 |
|---|---|---|
| 大竞技场 85×85 span5 | **0.0%** | **4.3%** |
| 废弃堡垒 106×108 span5 | **0.0%** | **1.3%** |
| 围场 span4 | 4.3% | **19.8%** |
| 巨型金字塔 span8 | 12.5% | **34.0%** |
| 浅水高台 小占地 span3 | 12.3% | **33.0%** |

⚠️ **现状那两个 0.0% 不是缺陷**：真实选址用的是**粗筛网格 + 逐格精检 + 压制既有地标**
（`burning-arena.js` 的 `SEARCH_HALF_X/Z` 窗 + `fixedBlockers`），本探针的 400 个随机点
没有那套搜索策略。**这张表只能读作「相对趋势」**：OpusCraft 的陆地更多、平坦区更容易找到。

⇒ **换地形后结构选址不会成片失效，反而更容易**。但**锚点坐标会全部移动**
（`computeBurningArenaAnchor` 等 6 个锚点函数都是 seed 的纯函数）⇒ 冻结坐标断言会红。

---

## 5. 实测：biome 分布

`pickSurfaceBiome(T,H,C,E,W)` 在 ±1200 步长 11（47961 点）：

| biome | 占比 | | biome | 占比 |
|---|---|---|---|---|
| lukewarm_ocean | 27.3% | | jungle | 3.0% |
| deep_lukewarm_ocean | 18.6% | | old_growth_birch_forest | 2.8% |
| savanna | 10.2% | | sparse_jungle | 2.6% |
| ocean | 7.8% | | deep_ocean | 2.1% |
| river | 4.3% | | bamboo_jungle | 1.9% |
| forest | 3.9% | | savanna_plateau | 1.7% |
| plains | 3.5% | | birch_forest | 0.4% |
| beach | 3.3% | | stony_peaks | 0.3% |
| dark_forest | 3.3% | | …（共 **21** 种） | |
| stony_shore | 3.2% | | | |

对比 mc-heavy 现状 **5 种**（PLAINS 37.2% / FOREST 29.1% / DESERT 23.3% / AZALEA 6.9% / SWAMP 3.5%）。

⚠️ **21 种不等于「直接可用」**：
- 上游 biome 表带 **grass/foliage/water/sky/fog 五种颜色**（`colormapGrass` 三角混色），
  而本仓 biome 只决定**地表方块名**（`SURFACE_BY_BIOME` 5 项）+ 植被规则（`rollVegetation`）。
- 本仓没有 `savanna` / `jungle` / `stony_peaks` 对应的**地表方块与树种**。
  要么映射到既有 5 类（多样性打折），要么新烘方块（用户裁定过「新方块要进背包」）。
- **海洋系占 55.9%**（lukewarm + deep_lukewarm + ocean + deep_ocean）——
  与 §3 的水下占比同源，重标 anchor 后会被压下去，但**biome 判定读的是原始气候值**，
  不随高度重标而变 ⇒ **必须同时重标 biome 的 continents 阈值**，否则「陆地上的海洋 biome」。

---

## 6. 与 mc-heavy 硬约束的正面冲突

### A. GPU 水面遮罩（**最大的单项设计决策**）

`src/render/ocean.js:273` 的 `getTerrainHeight` 是 TSL 同构实现，
常量从 `TERRAIN_HEIGHT_PARAMS` / `BIOME_PARAMS` 读（红线 1）。
**每片元调 5 次**（`h0..h4`，五点取样 ±`OCEAN_MASK_OFFSET=3.5`）。

| 方案 | 单次成本 | ×5 点/片元 |
|---|---|---|
| 现状 | 6 次 sin/cos | **30 次三角函数** |
| OpusCraft 2D | 5 个 NormalNoise（每个 2 套 Perlin × 3~9 octave）+ 3 张样条 | **~200 octave + 15 次样条求值** |

**片元着色器做不了列级缓存** ⇒ CPU 侧那套 4×4 子采样的收益在 GPU 侧拿不到。

**两条出路**（与 Tectonic 报告 §5.D 同）：

| 出路 | 做法 | 代价 | 红线 1 |
|---|---|---|---|
| **A（推荐）高度图纹理** | CPU 侧 `generateHeight` 算高度场 → `DataTexture` → TSL 只 `textureLoad` | 需设计分辨率/更新时机/边界处理 | ✅ 高度图是**可重建的派生数据**，且 CPU/GPU **逐位同源**（比现状的「同构实现」更强） |
| B TSL 里同构 Perlin+样条 | 把噪声与样条全部翻译成 TSL | ~200 octave/片元，**需 Tier 4 实测帧时**；样条控制点要传 uniform/纹理 | ⚠️ 仍是两份实现，复杂度 ×10 |

**本仓已有出路 A 的前例**：`src/render/rain-shelter-texture.js` 的
`SHELTER_TEXTURE`（512×512 RGBA8 DataTexture + `textureLoad`），
文件头记着实测配方（`copyTextureToBuffer` 读回逐位相同、`flipY` 必须显式写死 false、
Nearest 而非 Linear）。**照抄那套手法即可**。

⚠️ 判据要从「CPU 版与 GPU 版同构」（`test-ocean-mask.js`）改成
「**纹理采样值 == `generateHeight`**」，并钉住分辨率与插值方式。

### B. 消费面

| 符号 | 消费文件数（src + tests） |
|---|---|
| `generateHeight` / `generateHeightForBiome` | **63** |
| `getBiome` / `surfaceTypeOfBiome` | **40** |

7 个结构 GEN 单测的断言数：

| 文件 | 断言数 |
|---|---|
| `test-jungle-fortress-gen.js` | 187 |
| `test-ruined-citadel-gen.js` | 115 |
| `test-burning-arena-gen.js` | 85 |
| `test-arena-gen.js` | 20 |
| `test-giant-trees-gen.js` | 20 |
| `test-shallow-tarn-gen.js` | 17 |
| `test-azalea-trees-gen.js` | 14 |
| **合计** | **458** |

⚠️ 这些不全是冻结坐标（多数是关系式），但**锚点坐标类的一定会红**。
按 CLAUDE.md 口径：**冻结数字不符时停下来报告，不擅自改断言**。

### C. 世界几何全是锚定值

| 量 | OpusCraft | mc-heavy |
|---|---|---|
| `MIN_Y` | −64 | **−32** |
| `MAX_Y` | 320 | **96** |
| `SEA_LEVEL` | 63 | **−2** |
| `depth` 梯度 | `clampedMap(y, −64, 320, 1.5, −1.5)` | 需整体重标 |
| slides | `y∈[240,256]` 与 `y∈[−64,−40]` 两段 | **本仓世界只有 128 格，两段都在界外** |

⇒ `router.ts` 的 `depth()` / `preliminarySurface()` / `corner()` 里的 y 常数**全部要改**。
好消息：**2D 切片只需要 `slopedCheeseBase`**，它只含 `depth + offset` 与 `factor`，
slides 与洞穴通道都不参与 ⇒ 改动面比想象小。

### D. 存档兼容（红线 2）

存档只存 `seed + edits diff`。换高度公式 ⇒ **旧存档的 edits 落到新地形上**
（玩家挖的洞出现在半空 / 建的房子里长出石头）。

⇒ 若做成**可选新地形**（`?terrain=opus`），必须：
- 把地形种类**写进 `saveMeta`**（与 seed 同列），启动时读回；
- `progress-codec` 的 `PROGRESS_VERSION` 加一版并带迁移（旧包默认 `classic`）。

---

## 7. 与 Tectonic 的对比与选型建议

| 维度 | Tectonic | OpusCraft |
|---|---|---|
| 迁移工作量 | 要写 **DF 解释器 + 自造 Perlin + 标定 temperature/vegetation** | **1276 行 TS 直接搬**（噪声/样条/biome 全有） |
| 地貌丰富度 | **四族 region**（台地/梯田/丘陵/湿地）+ 沙丘 + 丛林柱，**分区机制更强** | vanilla 三轴（大陆度/侵蚀/山脊），地貌类型较常规 |
| 落差（推荐档） | 72.4 格（k=2/K=80） | **41 格**（k=2/K=0.5） |
| 水下占比 | 23.6% | **19.0%** |
| 成本（4×4） | 0.035 ms/列 | **0.044 ms/列** |
| biome | 要自己造判定表 | **21 种现成** |
| 许可 | MIT | MIT |
| 已验证程度 | 探针自写 DF 语义（**不是上游代码**） | **直接编译上游代码跑**（保真度更高） |

**建议**：

- **若目标是「快速拿到一个明显不同的地形」** → **选 OpusCraft**。
  它的代码可直接编译验证（本报告就是这么做的），噪声与 biome 都是现成的，
  落地路径短：搬 3 个文件 + 重标 y 常数 + 高度图遮罩。
- **若目标是「有区域感的多地貌」** → Tectonic 的四族分区机制更强，
  但要先付「写解释器 + 自造噪声」的成本。
- **两者可以合并**：用 OpusCraft 的 `noise.ts`（MC 口径 Perlin）作为**共同基础设施**，
  再在上面接 Tectonic 的四族样条。这样 Tectonic 报告 §2.4 的「四件基础设施」缺口
  由 OpusCraft 补上，而地貌丰富度由 Tectonic 提供。**这是最省事的组合**。

---

## 8. 落地路线（若立项）

**范围建议：做成可选新地形 `?terrain=opus`，默认关，旧存档零影响。**

1. `src/gen/perlin-noise.js`（新）：从上游 `noise.ts` 移植
   `ImprovedNoise / PerlinNoise / NormalNoise / SeedSource`（Worker 同构，不 import three）。
   **Tier 1 TDD**：值域、octave 归一化、同 seed 可复现、`wrap()` 边界。
2. `src/gen/climate-spline.js`（新）：`Spline` + `overworldOffset/Factor/Jaggedness`。
   **Tier 1 TDD**：⚠️ **端点按 derivative 线性外插，不是 clamp**
   （Tectonic 报告 §2.4 记过：写成 clamp 时 `spline(idxPts,0)` 得 −25 而正确值是 3）。
3. `src/gen/terrain-opus.js`（新）：2D 切片高度场 + 重标常数（k/K/anchor/y 梯度）。
   **保持 `generateHeight(x,z,seed)` 签名不变**，按地形种类分流。
4. **水面遮罩改高度图纹理**（照 `rain-shelter-texture.js`）。
5. biome 映射表：21 种 → 本仓地表方块 + 植被规则（**先映射到既有 5 类**，新方块另立项）。
6. 存档：`saveMeta.terrain` + `PROGRESS_VERSION` 迁移。
7. 结构锚点重标定：跑既有 8 个 Playwright spec + 25 个浏览器内单测，
   逐条看哪些冻结数字要改 —— **停下来报告，不擅自改断言**。

**门禁**：Tier 1（纯函数/热路径）⇒ `npm run check` + `npm test` + `npm run bench -- --check`；
像素级判据按 Tier 4 实测。

**开工前必须先裁决的四件事**：

1. **陡坎**（§3.4 的 0.7%）：压 K / 抬 MAX_STEP / 接受？
2. **水面遮罩**走高度图还是 TSL 同构（§6.A）？
3. **biome**：21 种映射到既有 5 类，还是新烘方块？
4. **是「换地形」还是「第二种地形」**（存档兼容，§6.D）？

---

## 9. 方法论与未核边界

### 怎么核的（可复现）

```bash
# 1. 编译上游核心（只读，产物在 /tmp）
D=$(mktemp -d /tmp/opus-probe-XXXXXX)
mkdir -p "$D/src/world/gen" "$D/src/core"
cp ~/jaylli/OpusCraft/src/world/gen/{noise,spline,router,biomes}.ts "$D/src/world/gen/"
cp ~/jaylli/OpusCraft/src/core/{rng,math}.ts "$D/src/core/"
cd "$D" && tsc --target es2022 --module esnext --moduleResolution bundler \
  --outDir out --skipLibCheck --strict false src/world/gen/router.ts
# 2. 补 .js 扩展名（tsc 的 bundler 模式不写扩展名，Node ESM 要）
# 3. 跑探针：shape.mjs / shape2.mjs / shape3.mjs / sites.mjs
```

探针脚本留在 `/tmp/opus-probe-zOoPbn/`（**临时目录，会被系统清理**；
若要长期保留须搬进 `tools/`，照 `tools/tectonic-terrain-probe.mjs` 的口径）。

### 没核的（⚠️ 引用本文数字时必须带上这些边界）

- **4×4 子采样的保真度未测**（Tectonic 报告测过它自己的四族，OpusCraft 的场更陡，须重测）。
- **GPU 侧帧时未实测**：§6.A 的 ~200 octave/片元是**静态计数**，不是帧时。
  高度图方案的纹理上传与采样开销要 Tier 4 实测。
- **OpusCraft 的实际视觉产出未比对**：§3 的落差/占比是**我们的探针**跑出来的形态，
  不是启动上游游戏截图比对。
- **anchor=48 是 p38 分位的实测值，依赖 seed=12345**：换 seed 须重测
  （气候噪声的分布在不同 seed 下应稳定，但未验证）。
- **结构选址命中率**（§4）用的是 400 个随机点，**不是真实选址算法**
  （粗筛网格 + 压制策略）⇒ 只能读相对趋势。
- **biome 与高度重标的耦合未测**：§5 末尾指出的「陆地上的海洋 biome」是**推断**，
  未实际跑重标后的 biome 分布。
- **上游 `biomes.ts` 的 cave biome / 3D biome 未看**（本仓无对应概念）。
- 成本数字受机器负载影响（Tectonic 报告记过缓存倍数三轮 103/180/191×）
  ⇒ **差异判定要看交替对照的分布，不看单次**。

### 上游许可

OpusCraft 是 **MIT**（`LICENSE`），代码可复用，需在文档/代码注释里注明来源。
⚠️ 它自己声明「NOT AN OFFICIAL MINECRAFT PRODUCT」，且**不使用任何 Minecraft 文件**
（贴图与音效全部代码生成）—— 与本仓的素材口径一致。