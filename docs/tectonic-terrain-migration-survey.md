# Tectonic 地形模块调研：可抽离迁移的部分

> **性质**：调研报告（只读勘察 + 离线数值探针，未改动任何生产代码）
> **日期**：2026-11-16 首版；**2026-11-17 实测复核并修订**（修订清单见 §9）
> **上游**：[`~/jaylli/tectonic`](../../tectonic) @ `34241bd`（3.0.25，MIT，`build.gradle.kts:32`）
> **目的**：为**下阶段 TODO「丰富地图的多样性」**提供选型依据 —— 哪些地形能力可以从 Tectonic 拿过来、
> 拿过来的真实代价是什么、哪些不要碰。

---

## 0. 结论摘要

Tectonic **不是一个「地形函数」的集合，而是一整套 Minecraft 1.18+ 的密度场（density function）数据包**：
地形形状全部写在 JSON 里（105 个 `density_function` 文件 + 32 个噪声参数），Java 侧只有配置、mixin
和几个自定义 DF 类型，**没有任何地形算法**。所以「抽离迁移」的真实成本不在代码，
**在采样模型的差异**：Tectonic 是 3D 密度场逐格求值，mc-heavy 是每列一个标量高度 + `fillColumn`
规则地层。

**但「3D 数据包」不等于「所有子树都是 3D」。** 复核用程序化判据（子树内全部噪声调用 `y_scale==0`
且不含 `y_clamped_gradient` / `interpolated` / `base_3d_noise` / `minecraft:y`）逐个子树扫过，
**6 类地貌是纯 2D 的**，可以直接落到我们的标量高度模型上（§2）。

三条最重要的实测结论：

1. **2D 子集不撞 `genP95` 预算，余量极大。** 现状 `generateHeight` 只占 8 ms 门的 **0.3%**
   （0.022 ms/列）；四族 region 全量**逐格**求值也只要 **0.309 ms/列 = 门的 3.9%**。
   首版「2D 子集撞预算」的结论**不成立**（§5.C）。
2. **真正的代价在 GPU 侧水面遮罩，首版完全没算。** 红线 1 的 TSL 每片元调 **5 次**高度求值，
   而片元着色器**做不了列级缓存** ⇒ 四族方案 **167 octave/片元**（现状 30 次 sin/cos）。
   这是本次迁移最大的单项设计决策（§5.D）。
3. **现状世界有 ~628 格的近周期性**，这比「落差只有 30 格」更伤多样性：平移 628 格后
   **高度逐格相同 89.3%、biome 一致率 87.3%**。换 Perlin 后这条自然消失（§1.1）。

---

## 1. 上游数据模型（成本分水岭）

证据：`src/common/main/resources/resourcepacks/tectonic/`，10 个 overlay 合并后：

| 层 | 内容 |
|---|---|
| 噪声原语 | 32 个 `noise/*.json`（`firstOctave` + `amplitudes[]`，Perlin octave 参数表） |
| DF 文件 | 105 个 `density_function/*.json`（base `data/` 77 个 + `overlay.mod` 28 个；另有 `data/minecraft/` 侧 17 个） |
| 入口（vanilla 侧） | `data/minecraft/.../noise_router/final_density.json`（1.7 KB）—— 语义是 `min(base_terrain, caves)`，再叠 `cave/noodle` 与 `underground_river/total` + `lava_tunnel/total` |
| 入口（noise_settings） | `overlay.26_2/.../noise_settings/overworld.json` **105 KB**；与 Terralith 联动版 `overlay.terratonic` 是 **318 KB** |
| 配置面 | `ConfigState.java` 409 行；`__constants/*` 全部改写成 `tectonic:config_constant` / `config_noise`，指向 `min_y` / `max_y` / `vertical_scale` / `ocean_depth` / … |

**统计口径（重要，首版此处错了约 9×）**：把 overlay 链按优先级合并（`overlay.mod` → `overlay.datapack`
→ base `data`），从入口做**引用闭包**（同一 DF 只展开一次），区分 local DF 与 vanilla DF 引用。
**样条节点 = 任何带 `points` 数组的对象**（内联子样条没有 `type` 字段，只按 `type=='minecraft:spline'`
计数会漏掉绝大多数）；**控制点 = 各 `points` 数组长度之和**；**octave = 去重后噪声原语的
`amplitudes` 非零项数之和**（`amplitudes` 里的 0 在 MC 里会被跳过，按 `length` 计会偏高）。

| 子系统 | 入口 | DF | 样条节点 | 控制点 | 噪声原语 | octave |
|---|---|---|---|---|---|---|
| 全局地形形状 | `terrain_spline/offset/final` | 45 | 122 | 380 | 14 | 73 |
| 大陆度骨架 | `terrain_spline/offset/continents` | 33 | 101 | 313 | 10 | 49 |
| **四族区域地形** | `terrain_spline/offset/regions` | **25** | **66** | **218** | **9** | **40** |
| 四族（弱版） | `terrain_spline/offset/regions_weak` | 23 | — | 171 | 8 | 37 |
| 生物群系参数 | `biome_parameter/{ridges,erosion}` | 20 | — | 51 | 7 | 24 / 43 |
| 山脊 | `mountain_ridges/ridges` | 7 | 0 | 0 | 2 | 4 |
| 3D 顶层 | `sloped_cheese` | 70 | 178 | 533 | 25 | 95 |
| 洞穴 | `caves` | 76 | 179 | 535 | 25 | 95 |
| 地下河 | `underground_river/total` | 58 | 124 | 385 | 18 | 90 |
| 岩浆隧道 | `lava_tunnel/total` | 4 | — | 10 | 5 | 12 |
| 文件级合计（不展开引用） | 全部 105 个 DF | 105 | 197 | 594 | 32 | — |

> 首版表里的「502 样条节点 / 3536 控制点」是把内联子样条按**引用次数**重复计入的结果。
> 按上面的口径重量，`offset/final` 是 **122 / 380**。**这不改变「3D 顶层不该迁」的结论**
> （它含 `blend_offset` / `quarter_negative` / `base_3d_noise`，见 §4），但成本论证要用正确的数。

### 1.1 现状基线（实测，seed=12345）

```js
h = Math.floor(noise(x, z, seed, 0.08) + noise(x, z, seed, 0.02) * 3);   // 两个 sin/cos 项
// noise(x,z,seed,scale) = sin((x+seed)*scale)*2 + cos((z+seed)*scale)*2
```

| 量 | 实测值 | 口径 |
|---|---|---|
| 高度值域 | **−15..15（落差 30 格）** | ±1600 网格步长 7，209764 点 |
| 列内高度极差 | 平均 **3.40** 格 / 最大 **12** 格 | 729 个 16×16 列 |
| biome 分布 | PLAINS 37.2% / FOREST 29.1% / DESERT 23.3% / AZALEA 6.9% / SWAMP 3.5% | 同上 |
| 水下占比（`h < SEA_Y`） | **31.8%** | 同上 |
| biome 斑块段长（沿 x） | 中位 **69** / p90 **284** 格 | ±8000 逐格 |
| `generateHeight` 成本 | **0.086 µs/次 = 0.022 ms/列** | Node，200000 次 |

**⚠️ 首版漏掉的一条：现状世界有 ~628 格的近周期性。** `noise()` 是 sin+cos，
coarse `0.08` 与 fine `0.02` 的公共周期 = `4×2π/0.08 = 2×2π/0.02 = 628.3185` 格，
而 biome 的 `TEMP_SCALE=0.01` 周期恰好也是 **628.3185** 格。实测：

| 平移 | 高度逐格相同 | 平均高度差 | biome 一致率 |
|---|---|---|---|
| 314 格 | 48.2% | 1.659 格 | — |
| **628 格** | **89.3%** | **0.301 格** | **87.3%** |
| 1256 格 | 91.0% | 0.097 格 | 99.7% |

⇒ **走 628 格就看到几乎重复的世界**。这比「落差只有 30 格」更伤多样性，也是支持迁移的强论据：
换成 Perlin（非周期）后这条自然消失。

**这就是「地图多样性」的现状基线**：一个周期性三角噪声切 5 个 biome，每个 biome 一个常数缩放。

---

## 2. 第一档：可直接抽（实测确认「纯 2D」）

### 2.1 判据（程序化，可复现）

一个子树可落到标量高度模型 ⟺ 闭包内**全部**噪声调用 `y_scale == 0`，且不含
`y_clamped_gradient` / `interpolated` / `quarter_negative` / `half_negative` / `cache_once` /
`blend_offset` / `blend_alpha`，也不引用 `minecraft:y` / `overworld/base_3d_noise` / `jagged` /
`cave_cheese` / `cave_layer` / `pillar*` / `overworld/caves/*`。

### 2.2 六类可迁地貌

| # | 地貌 | 上游入口 | DF | 样条节点 | 控制点 | octave | 语义 |
|---|---|---|---|---|---|---|---|
| 1 | **台地 + 河谷 + 恶地脊** | `region/club` | 11 | 6 | 90 | 9 | 平顶桌山、单/双河谷（`single/double_valley_spline`）、badlands 层脊 |
| 2 | **双层梯田** | `region/spade` | 7 | 2 | 31 | 9 | 上下两级台阶崖：`lower_tier`/`upper_tier` 取 **abs 噪声**当台阶高度 |
| 3 | **起伏丘陵 + 河谷 + 高地** | `region/heart` | 8 | 3 | 45 | 8 | rolling hills、下切河谷、突起高地 |
| 4 | **湿地** | `region/diamond` | 6 | 3 | 31 | 7 | 低平浅水洼地（`wetland` 4 octave） |
| 5 | **沙丘**（首版漏） | `region/diamond/dune/{final,spline}` | 18 | 9 | 44 | 31 | **域扭曲**（domain warp）生成的新月形沙丘链 |
| 6 | **丛林石柱**（首版漏） | `region/heart/jungle_pillar` + `terrain_spline/offset/depth_additive` | 16 | 5 | 83 | 30 | 拔地而起的独立石柱（**极稀有**，见 §2.5） |

**四族总入口 `offset/regions` = 25 DF / 66 样条节点 / 218 控制点 / 40 octave，一次拿完 1~4。**
另有两个弱版变体 `club_weak`（7 DF / 34 控制点）与 `spade_weak`（5 DF / 25 控制点），
是「同样的地貌但幅度压平」，**不是满强度版的别名**（实测差异见 §2.4）。

第 5、6 项虽然被 3D 的 `sloped_cheese` 引用，**但它们自己的子树没有任何 y 依赖** ——
是纯 2D 的加性高度项，可以单独摘出来，不必连带 3D 链。

### 2.3 分区机制（这是「区域感」的来源）

`offset/regions.json` 是**两层样条**：

```
外层 coordinate = noise/continent/erosion        断点 {-0.02, 0.04}
  内层 coordinate = noise/region_selector + flat_terrain_skew(0.1)   断点 {-0.1, 0, 0.1}
    低侵蚀支：club / club_weak / heart
    高侵蚀支：spade / spade_weak / diamond
  再乘 height_multiplier = clamp(1.2 + 0.4×noise, 0.8, 1.6)
```

每族内部再按 `temperature_index`（1..5 档）× `vegetation_index`（1..5 档）选具体形状。
**这正是 mc-heavy「每 biome 一个常数缩放」的升级版**，且天然 2D。

实测族占比（±2400 步长 13，338724 点）：
**diamond 41.0% / heart 16.3% / club 16.3% / spade 14.9% / spade_weak 6.6% / club_weak 4.9%**。

### 2.4 基础设施清单（四件，不是两件）

| 件 | 说明 | 实测要点 |
|---|---|---|
| **Improved Perlin + octave 归一化** | **仓库根本没有** —— 全仓 grep `perlin\|simplex\|fbm\|octave` **零命中**，`noise.js` 只有 sin/cos | 单 octave 0.081 µs；3 octave 0.139 µs；9 octave 0.539 µs；spline 8 控制点 0.012 µs |
| **cubic spline 求值器** | 每控制点带 `derivative` 的三次 Hermite | ⚠️ **端点外是「按 derivative 线性外插」，不是 clamp** |
| **DF 子集解释器** | `add/mul/min/max/abs/clamp/range_choice/spline/noise/shifted_noise` + 4 个 tectonic 自定义类型 | 可以只实现「编译后的 JS 形式」，不必真解析 JSON |
| **采样缓存层** | `flat_cache` / `cache_2d` 的语义 = 2D 参数每列算一次 | **列级缓存 vs 逐格 ≈ 100~200× 成本差**（三轮交替实测 103/180/191×，负载敏感） |

> ⚠️ **spline 端点语义是载荷性的**：写成 clamp 时 `spline(idxPts, 0)` 会算出 **−25**
> （正确值 **3**），温度档直接跑到 −293，整个分区机制作废。这个错误在「值域检查」里才现形，
> 计数类判据（DF 数 / 控制点数）全对。

### 2.5 两个必须知道的实现细节（实测）

**① 样条必须惰性求值（按 coordinate 只算命中的那一支）。**
Tectonic 的样条 `value` 可以是另一个 DF；eager 实现会把所有分支都算一遍。
**单变量对照**（同一份忠实四族代码，只差 `value` 是 thunk 还是数值）：

| 口径 | 噪声调用/次 | octave/次 | 每列(4×4) | GPU 五点/片元 |
|---|---|---|---|---|
| eager（所有分支都算） | 24.9 | 87.6 | 0.099 ms | 438 |
| **lazy（只算命中支）** | **7.7** | **33.4** | **0.035 ms** | **167** |

**2.6× 降本，且逐点结果逐位相同**（52441 点比对，最大差 **0.000e+0**）。

**② 丛林柱是极稀有地貌，不是「到处都有」。** 四层门控（`raw_continents ≥ 0.05` →
两条**窄侵蚀带** `[-0.875,-0.825] ∪ [-0.425,-0.375]` → `selector ≥ 0.05` → `ti=4` 且 `vi∈{4,5}`）
实测通过率 **411 / 11758041 = 0.0035%**，再经 ridges 样条塑形后**只有 12 个点非零（0.0001%）**，
命中处高度 0.6~26.0 格。⇒ 想要「看得见的石柱林」必须**自己放宽门控**，
照搬原版数值等于几乎不生成。

---

## 3. 第二档：改造后可抽（只取骨架，数值全部重标定）

| # | 组件 | 只保留什么 | 为什么数值必须重标定 |
|---|---|---|---|
| 7 | `terrain_spline/offset/continents` 大陆度骨架 | **语义**：7 个节点 `[-0.45, -0.35, -0.195, -0.155, 0, 0.1, 0.8]` 对应「深海床 → 海床 → 海岸 → 平原 → 台地」 | 33 DF / 313 控制点 / 49 octave；`ocean_offset=-0.8` 是为 vanilla 384 格高世界调的 ⇒ 实测把水下占比推到 **71%**（§6） |
| 8 | `mountain_ridges/{ridges,weathering}` 山脊 | **手法**：base + 0.6×域扭曲 detail，再乘「风化」衰减 | ⚠️ **含 y 依赖**：`base` 的 `y_scale=1`、`weathering` 的 `y_scale=2` ⇒ 取 y=0 切片才能 2D 化，属**改造**不是直抽 |
| 9 | `biome_parameter/{ridges,erosion}` | 把「一个环形噪声切 5 biome」升级成二维表的**语义模板** | 20 DF / 51 控制点 / 24+43 octave，锚在原版温度-植被刻度 |
| 10 | `terrain_spline/factor/continents`、`jaggedness/continents` | 纯 2D 的幅度调制器（11 DF/21 oct、8 DF/18 oct） | 原版用来乘 3D 基噪，2D 化后要自己接一个细节噪声 |

**水平尺度必须重标定（首版只提了垂直）**。Tectonic 原值的有效波长
（`2^-firstOctave / xz_scale`）：

| 噪声 | firstOctave | xz_scale | octave | 有效波长 |
|---|---|---|---|---|
| `region/selector` | −11 | 1.1 | 7 | **1862 格** |
| `parameter/erosion` | −10 | 0.25 | 9 | **4096 格** |
| `parameter/continentalness` | −10 | 0.13 | 9 | **7877 格** |
| `parameter/ridge` | −8 | 0.25 | 3 | **1024 格** |
| `region/spade/{lower,upper}_tier` | −8 | 0.35 | 3 | 731 格 |
| `region/heart/rolling_hills` | −6 | 0.2 | 5 | 320 格 |
| `region/diamond/wetland` | −6 | 0.8 | 4 | 80 格 |

而我们 `REGION_SIZE = 400`、视距 8~16 列 = **128~256 格半径**。实测同族连通斑块
（400×400 窗口洪泛）：

| 水平缩放 k | club 最大斑块 | diamond 最大斑块 | 解读 |
|---|---|---|---|
| **1（原值）** | **21011 格²**（≈145×145） | 13742 格² | 一个视距装不下一个地貌 |
| 4 | 22798 格²（长条） | 21133 格² | 斑块碎化，中位降到 4~6 格² |
| 8 | 13047 格² | 19508 格² | 中位 1~2 格²，过碎 |

⇒ **k ≈ 2~4 才能在视距内看到地貌切换**（k 是采样坐标乘数，k>1 = 地貌变小）。

---

## 4. 第三档：不建议移植（判据复核确认）

| # | 组件 | y 依赖来源（程序化扫描实测） |
|---|---|---|
| 11 | `caves`（76 DF） | `interpolated` 无、但含 `cache_once` / `y_clamped_gradient` / `quarter_negative` / `half_negative` / `blend_*`，噪声 `cave_layer y_scale=8`、`cave_cheese y_scale=0.667`，并引用 `overworld/caves/{entrances,spaghetti_2d,pillars,spaghetti_roughness_function}`。mc-heavy 的 `src/gen/caves.js` 是 3D 值噪声 + LCG rooms，**两套语义无法对接** |
| 12 | `underground_river/total`（58 DF） | `interpolated` + `minecraft:y` + `pillar y_scale=0.3` / `pillar_thickness y_scale=1` / `height y_scale=1.6` |
| 13 | `lava_tunnel/total`（4 DF） | `minecraft:y` |
| 14 | `sloped_cheese` / `offset/final` 整体 | `cache_once` / `quarter_negative` / `half_negative` / `y_clamped_gradient` / `blend_offset` / `blend_alpha` + `base_3d_noise` + `jagged` |
| 15 | `island_*` 族 | **纯 2D 但 27 octave**，且是「海岛上多一块陆地」的语义，与 mc-heavy 的海洋/湖盆体系冲突 |

---

## 5. 与 mc-heavy 硬约束的正面冲突（带实测数据）

### A. 采样域不同

Tectonic 每格求值 3D 密度；mc-heavy 每列一个标量 `h`，其余交给 `fillColumn` 的规则地层。
原版粗化机制 `minecraft:interpolated` 是 **4×8×4 单元格**，要求密度在垂直 8 格内近似线性，
而我们的列高 128 格、`fillColumn` 只吃一个整数高度。

**⇒ 只迁 §2 的纯 2D 子树时这条冲突不存在**（2D 参数与 y 无关，逐格求值天然成立）。

### B. 世界几何全是锚定值（`overlay.mod` 把常量全部配置化）

| 量 | Tectonic 公式 | mc-heavy 代入后的实际值 |
|---|---|---|
| `min_offset` | `0.0078 × (min_y − 25)` | **−0.4446**（min_y = −32） |
| `max_offset` | `0.0078 × (max_y − 80)` | **+0.1248**（max_y = 96） |
| 可用垂直带 | `max_offset − min_offset` | **0.5694 ≡ 73 格** |
| `depth` | `y_clamped_gradient(−2048→17, 2048→−15)` | −32 处 1.250 / −2 处 1.016 / 96 处 0.250 |
| `vertical_scale` 默认 | 1.125（`ConfigState.GlobalTerrain.VERTICAL_SCALE`） | 与我们的 128 格世界不匹配 |
| `ocean_offset` 默认 | **−0.8**（`ConfigState.Continents.OCEAN_OFFSET`） | 实测把水下占比推到 71%（§6 方案 C） |
| `ocean_depth` / `deep_ocean_depth` | −0.22 / −0.45 | 锚在 vanilla 海平面 |

我们的 `min_y=-32 / max_y=96 / SEA_Y=-2` 都不是 vanilla 值 ⇒ 这一整套必须整体重标定。

### C. 预算：**2D 子集不撞墙**（首版此结论已推翻）

**门禁的真实位置与口径**（首版引的 `docs/roadmap.md:530` 不是门禁本体）：

- `src/tests/test-worker-gen.html`：**纯地形** GEN p95 **< 8 ms/列**（未放宽）
- `src/tests/test-structure-gen.html`：**含结构** GEN p95 **< 10 ms/列**
  （2026-09-29 用户裁决 8→10，实测中位 **8.30 ms**）

**关键事实：地形现在只占预算的 0.3%**（0.022 ms/列 ÷ 8 ms）。所以「比现有地形贵一到两个数量级」
和「撞破预算」是两件不同的事 —— 前者成立，后者不成立。

实测（Node，MC 口径 Improved Perlin + 带 derivative 的 cubic spline，**惰性分支**）：

| 方案 | 列中心缓存 | **4×4 子采样+双线性** | 逐格 256 次 | 占 8 ms 门（逐格口径） |
|---|---|---|---|---|
| 现状 `generateHeight` | — | — | **0.022 ms** | 0.3% |
| A 只 club 台地族 | 0.001 ms | **0.020 ms** | 0.182 ms | 2.3% |
| **B 四族 region** | 0.002 ms | **0.035 ms** | **0.309 ms** | **3.9%** |
| C 四族 + 大陆度基座 | 0.003 ms | **0.040 ms** | 0.373 ms | 4.7% |
| 沙丘（单独） | — | 0.008 ms | — | — |
| 山脊（单独，y=0 切片） | — | 0.005 ms | — | — |
| 丛林柱（单独） | — | 0.004 ms | — | — |

**即使逐格全量求值也只占门的 2~5%。** 两个手法带来这个结果：

1. **惰性样条**（§2.5）：2.6× 降本，结果逐位不变。
2. **列内 4×4 子采样 + 双线性**：每列只算 25 个参数点而不是 256 个。
   实测高度误差（K=100）：

| 方案 | 平均误差 | 最大误差 |
|---|---|---|
| B 四族 | **0.16 格** | 12.94 格 |
| 沙丘 | 0.05 格 | 2.08 格 |
| 山脊 | 0.27 格 | 1.33 格 |
| 丛林柱 | 1.84 格 | 9.45 格 |

> 对照：**列中心单点**（每列只算 1 次）虽然只要 0.002 ms，但列内高度全同 ⇒ 地形变成 16×16 平台
> （实测 100 列的列内极差**恒 0**），不可用。**16 格步长双线性**（4 角）平均误差 **0.99 格**、
> 最大 **53.52 格**，也不可接受。**4×4 是成本与保真的平衡点。**

**要迁 3D 密度场仍然是另一回事**：`sloped_cheese` 是 178 样条节点 / 533 控制点 / 95 octave
**每格**（不是每列），且垂直方向无法缓存 ⇒ 那才需要重标定 `genP95`，是产品级决定。

### D. 红线 1：**真正的代价在 GPU 侧**（首版完全没算）

`src/render/ocean.js` 的水面遮罩 TSL **同构实现**了 `getTerrainHeight`，
常量从 `TERRAIN_HEIGHT_PARAMS` / `BIOME_PARAMS` 读（红线 1，防第二份权威）。
**它每片元调 5 次**（`h0..h4`，五点取样 ±`OCEAN_MASK_OFFSET=3.5`，见 `ocean-mask.js`）：

| 方案 | 单次 octave | **×5 点/片元** |
|---|---|---|
| 现状 | 6 次 sin/cos | **30 次三角函数** |
| A club 台地族 | 16.9 | **84 octave** |
| **B 四族 region** | **33.4** | **167 octave** |
| C 四族+大陆度 | 42.4 | **212 octave** |

每个 Perlin octave ≈ 8 次 grad + 7 次 lerp + 3 次 fade，**而片元着色器做不了列级缓存**
（没有跨片元共享状态）⇒ CPU 侧那套百倍级的缓存收益在 GPU 侧**拿不到**。
水面平面是 `PlaneGeometry(800, 800)`，近处水平视角下覆盖屏幕大部分 ⇒ 片元量级与屏幕分辨率同阶
（**具体片元数与帧时未实测**，见 §7）。

**两条出路（这是本次迁移最大的单项设计决策）**：

| 出路 | 做法 | 代价 | 红线 1 |
|---|---|---|---|
| **A（推荐）高度图纹理** | CPU 侧 `generateHeight` 算出高度场 → `DataTexture` → TSL 只 `textureSample` | 视距 16：**272 KiB**（Int8）/ 545 KiB（Int16）；全量生成 **38.1 ms**（可分帧）；跨列边界每帧新增 33 列 = **1.16 ms** | ✅ 成立 —— 高度图是**可重建的派生数据**（红线 1 明确允许），唯一生成入口仍是 `generateHeight`，且 CPU/GPU **逐位同源**（比现状的「同构实现」更强） |
| B TSL 里同构 Perlin+spline | 把 40 个 octave 与样条表全部翻译成 TSL | 167~212 octave/片元，**需 Tier 4 实测帧时**；样条控制点要传成 uniform/纹理 | ⚠️ 仍是两份实现，漂移风险与现状同级但复杂度×10 |

> ⚠️ 出路 A 有一个必须核的点：现状 `test-ocean-mask.js` 的判据是「CPU 版与 GPU 版同构」，
> 改高度图后判据要变成「纹理采样值 == `generateHeight`」，**且要钉住纹理分辨率与插值方式**
> （最近邻 vs 双线性会让岸边判定差一格）。

### E. 全仓结构锚定在 `generateHeight`

实测（`grep -rln`）：`generateHeight` 被 **40 个 `src/` 模块**（含 **21 个**浏览器内单测）
与 **8 个** Playwright spec 消费，覆盖：

- 地标 / 城市 / 竞技场 / 废弃堡垒 / 金字塔选址与「全格干燥 `> SEA_Y`」判据
- 巨树 / 杜鹃树的 `wy = h + 1` 落地
- 撒布落点、小地图区域分类、水面遮罩、出生点

换高度场 ⇒ 这些数值全部重标定（**接口可以不动**）。

### F. 纯 JSON 移植还缺两块

1. **vanilla 噪声参数不在本仓**：`minecraft:overworld/temperature` / `vegetation` / `jagged` /
   `cave_cheese` / `overworld/base_3d_noise` / `shift_x` / `shift_z` 等在 MC 客户端 jar 里
   （本仓 `data/minecraft/worldgen/noise/` 只有 2 个 badlands 文件）。
   ⇒ §2 的六类地貌**全部依赖 `temperature` / `vegetation`**（分区机制的坐标轴），
   必须自己造两个 Perlin 并**标定值域**：原版 `temperature_index` 的断点在 ±0.48..0.58，
   实测自造 3-octave Perlin 的 p1/p99 是 −0.46/+0.53，**乘 2.2 后五档占比才均衡**
   （1:18.0% / 2:21.5% / 3:29.5% / 4:18.5% / 5:12.5%）。不标定（×1）的话分布是
   1:1.5% / 2:24.3% / **3:57.2%** / 4:16.0% / 5:1.0% —— 过半样本挤在第 3 档，两端几乎不出现。
2. **自定义 DF 类型要自己实现**：`tectonic:config_constant` / `config_noise` / `invert` / `config_clamp`
   （语义见 `shared/*/worldgen/densityfunction/*.java`，每个几十行）。
   `config_noise` 的 `scale` 默认 0.25（`NoiseState.DEFAULT`），
   continents/erosion/ridge 分别 0.13/0.25/0.25（`ConfigState.Continents`）。

---

## 6. 选型实测表与推荐路径

### 6.1 三档候选 × 水平尺度（K=高度换算系数，k=水平缩放）

口径：±2400 步长 13（338724 点）算落差与占比；729 个 16×16 列算列内极差；1500 列算 4×4 成本。

| 候选 | k | K | 落差(p99−p1) | 列内极差 均/最大 | 4×4 成本 | 越界[−32,96] | 水下 |
|---|---|---|---|---|---|---|---|
| **现状** | — | — | **30** | **3.4 / 12** | 0.022 ms | 0% | **31.8%** |
| A club 台地 | 1 | 100 | 32.2 | 2.1 / 35.1 | 0.019 ms | 0% | 22.6% |
| A club 台地 | 2 | 80 | 25.7 | 2.9 / 30.9 | 0.018 ms | 0% | 21.4% |
| A club 台地 | 4 | 60 | 19.2 | 4.4 / 28.0 | 0.019 ms | 0% | 19.5% |
| **B 四族** | 1 | 100 | 54.9 | 2.5 / 68.2 | 0.033 ms | 0% | 24.9% |
| **B 四族** | **2** | **80** | **72.4** | **4.7 / 57.8** | **0.036 ms** | **0%** | **23.6%** |
| B 四族 | 4 | 60 | 54.3 | 7.5 / 50.7 | 0.040 ms | 0% | 21.7% |
| B 四族 | 8 | 40 | 34.3 | 9.7 / 41.0 | 0.044 ms | 0% | 17.8% |
| C 四族+大陆度 | 1 | 100 | 135.5 | 23.5 / 101.2 | 0.041 ms | **44.5%** | **70.8%** |
| C 四族+大陆度 | 2 | 80 | 111.6 | 29.4 / 90.7 | 0.044 ms | **40.6%** | **71.0%** |
| C 四族+大陆度 | 4 | 60 | 79.9 | 33.9 / 98.0 | 0.050 ms | 1.6% | 71.8% |
| C 四族+大陆度 | 8 | 40 | 51.8 | 33.1 / 77.3 | 0.056 ms | 0% | 71.3% |

### 6.2 推荐：**先只拿四族 region（方案 B），k=2 / K=80，不碰大陆度基座**

理由（全部有实测支撑）：

- 落差 **72.4 格 = 现状 2.4×**，列内极差 4.7 格（现状 3.4），**零越界**；
- 水下占比 23.6%，与现状 31.8% 同量级 ⇒ 既有「全格干燥」选址判据不会成片失效；
- 成本 0.036 ms/列 = 8 ms 门的 **0.45%**，预算无需重标定；
- 一次拿到 6 类地貌里的 4 类（台地/河谷/恶地脊、双层梯田、丘陵/高地、湿地）+ 区域感分区机制；
- **周期性消失**（Perlin 非周期）。

**方案 C 的问题**：大陆度基座把水下占比推到 **71%**（原版 `ocean_offset=-0.8` 是为 384 格高世界调的），
且 k=1/2 时 **40%+ 的格越出 [−32,96]**。要它就得先重标定 `ocean_offset` / `ocean_depth`，属独立一轮。

**沙丘与丛林柱作为后续增量**：沙丘 0.008 ms/列、值域 0~19.7 格（75.9% 非零），
是「沙漠 biome 的地形升级」的天然候选；丛林柱**必须先放宽门控**（§2.5），否则几乎不生成。

### 6.3 与「丰富地图多样性」目标的对应关系

| 目标 | 建议采用 | 不采用 |
|---|---|---|
| 地形起伏不再只有 ±15 | 方案 B（四族 region），k=2/K=80 | 3D 密度场 |
| 区域感（不同地区不同地貌） | `offset/regions` 两层样条分区（§2.3） | 其原始水平尺度 |
| 消除 ~628 格周期性 | Improved Perlin 替 sin/cos | — |
| 沙漠地貌升级 | 沙丘 `dune/{final,spline}`（后续增量） | — |
| 海岸线 / 海床形状 | **暂无可直抽件**（`ocean` 是 3D，见 §9） | `terrain_spline/ocean` |
| 洞穴形态 | 保持现有 `src/gen/caves.js` | 第三档 11~13 |
| 多 biome 分布 | `biome_parameter/{ridges,erosion}` 模板 + 现有 `getBiome` 升级 | `island_*` |

---

## 7. 方法论与未核边界

### 怎么核的（可复现）

1. 按 overlay 优先级合并（`overlay.mod` → `overlay.datapack` → base `data`）；
2. 从各入口做**引用闭包**（同一 DF 只展开一次），区分 local DF 与 vanilla DF 引用；
3. **2D 判据**：扫闭包内全部噪声调用的 `y_scale` 与 y 依赖类型/引用（§2.1）；
4. `noise` 字段走噪声参数表，按 `amplitudes` **非零项**计 octave；
5. **样条节点 = 任何带 `points` 数组的对象**（不只 `type=='minecraft:spline'`）；
6. 跑过 `overlay.datapack` vs `overlay.mod` 的 `diff -r`：差异**只是**把字面量换成
   `config_constant` / `config_noise`（配置化开关），没有独立逻辑；
7. **离线数值探针**：[`tools/tectonic-terrain-probe.mjs`](../tools/tectonic-terrain-probe.mjs)
   （`node tools/tectonic-terrain-probe.mjs [--json]`，只读、不依赖 three/DOM）——
   自写 MC 口径 Improved Perlin + cubic spline + 惰性 DF 求值，产出 §5.C / §6 的成本与形态表。
   **探针自校验**（每次跑都输出）：同一份忠实四族代码的
   eager / lazy 两版 52441 点比对最大差 **0.000e+0**（单变量对照，只差 `value` 是否 thunk）；
   `spline(idxPts,0)` 必为 **3**（clamp 版会得 −25）；零 NaN。
   weak 两族与满强度版实测确有差异（club_weak 最大 Δ0.18、spade_weak 最大 Δ0.399）。

### 没核的（⚠️ 引用本文数字时必须带上这些边界）

- **探针不是生产实现**（`tools/tectonic-terrain-probe.mjs` 文件头已列同一清单）：
  Perlin 的 permutation 表用 LCG 自造（不是 MC 的 seed 派生），
  octave 归一化用近似 `valueFactor`，`shift_x/shift_z`（域扭曲）在四族里被省略、
  只在沙丘/山脊里近似实现。⇒ **§5.C/§6 的绝对数值是数量级依据，不是冻结基线**；
  落地实现必须重测并按 Tier 1 TDD 钉住。成本数字还受机器负载影响
  （实测缓存倍数三轮 103/180/191×），**差异判定要看交替对照的分布，不看单次**。
- **Tectonic 的实际视觉产出与实际生成耗时**：没启动 Minecraft 实测。
  §6 的「落差/极差/占比」是**我们的探针**跑出来的形态，不是原版截图比对。
- **GPU 侧帧时未实测**：§5.D 的 167 octave/片元是**静态计数**，不是帧时。
  高度图方案（出路 A）的 272 KiB / 38.1 ms / 1.16 ms 是**算术推算 + CPU 侧实测单价**，
  纹理上传与采样的真实开销要 Tier 4 实测。
- **`temperature` / `vegetation` 的 ×2.2 标定是探针值**，依赖自造 Perlin 的值域；
  换实现必须重标。
- Perlin 噪声的算法细节（`y_scale` 对垂直 octave 的压缩语义）来自对 MC 噪声实现的了解，
  **不在上游源码里可验证**。
- `overlay.clifftree` / `overlay.terratonic`（Terralith / CliffTree 联动）只看了入口体量，没做闭包 ——
  那部分依赖外部 mod，本来也不该迁。
- `overlay.1_21_9*` / `overlay.no_carvers` / `overlay.ore_fix` / `overlay.ultrasmooth` 只确认了用途，未逐节点读。

### 上游许可

Tectonic 是 **MIT**（`build.gradle.kts:32`），数据包内容可复用，需在文档/代码注释里注明来源。

---

## 8. 下阶段 TODO：丰富地图的多样性

**状态**：📝 待立项（本报告只做选型依据，未产生任何生产代码改动）

**目标**：把地形从「一个周期性三角噪声切 5 个 biome、落差 30 格、628 格重复」升级为有区域感的多地貌地形。

**建议范围（方案 B，k=2 / K=80）**：

1. `src/gen/terrain-noise.js`（新）：Improved Perlin + octave 归一化（Worker 同构，不 import three）。Tier 1 TDD。
2. `src/gen/terrain-spline.js`（新）：cubic spline 求值器（**端点按 derivative 线性外插**）
   + DF 子集解释器 + **惰性分支求值**。Tier 1 TDD。
3. 用 `offset/regions` 四族重写 `generateHeight` 的参数化部分 —— **保持
   `generateHeight(x, z, seed)` 签名与 `TERRAIN_HEIGHT_PARAMS` 的单权威地位不变**（红线 1）。
   采样口径 = **列内 4×4 子采样 + 双线性**（§5.C）。
4. 数值标定到我们的世界几何（`WORLD_MIN_Y=-32 / SEA_Y=-2 / WORLD_MAX_Y=96`）：
   水平缩放 k、高度系数 K、`temperature`/`vegetation` 值域。**标定判据要同时钉上下界**
   （落差、列内极差、越界占比、水下占比），只钉「落差变大」抓不到「地形炸出世界」。
5. **水面遮罩改高度图纹理**（§5.D 出路 A）—— 判据从「CPU/GPU 同构」改为
   「纹理采样值 == `generateHeight`」，并钉住分辨率与插值方式。既有手法见 `src/tests/test-ocean-mask.js`。
6. 结构锚点重标定：跑既有 8 个 Playwright spec + 21 个浏览器内单测，逐条看哪些冻结数字要改
   （**按 CLAUDE.md 口径：冻结数字不符时停下来报告，不擅自改断言**）。

**门禁要求**：Tier 1（纯函数算法/热路径）⇒ `npm run check` + `npm test` +
`npm run bench -- --check`；像素级判据按 Tier 4 实测，不得宣称目视通过。

**⚠️ 开工前必须先裁决的三件事**：

1. **水面遮罩走高度图纹理还是 TSL 同构**（§5.D）—— 这是本次最大的架构决策，
   高度图会引入一个新的派生数据层（红线 1 允许，但要设计分辨率/更新时机/边界处理）。
2. **是「换地形」还是「第二种地形风格」** —— 若是后者，需要设计地形风格开关（现有
   `?style=` 只管视觉风格，不含地形），那会额外牵动存档兼容（红线 2：edits diff 是按 seed 的纯函数差，
   换地形公式会让旧存档的 edits 落到新地形上）。
3. **目标落差与地貌尺度**（k / K）—— §6.1 给了实测档位，但「落差 72 格好不好玩」是产品判断。

> `genP95` **不再需要裁决**：2D 子集实测占门 0.45%（4×4 口径）~3.9%（逐格口径），
> 无需重标定。只有动 3D 密度场才需要，那是独立 Epic。

---

## 9. 首版（2026-11-16）修订清单

复核推翻或补齐了首版 6 处结论。**引用首版数字前先看这里。**

| # | 首版说法 | 复核结论 | 依据 |
|---|---|---|---|
| 1 | §2 第 3 项：`terrain_spline/ocean` 是「整个文件只有一个样条、纯 2D、7 octave，可做海岸线」 | **错判**。实测 **0 个样条节点**（全是 add/mul/min/max/abs）、**4 个噪声调用点 / 12 octave**，含 `y_clamped_gradient(0→64, 2→0.5)` + `ocean1 y_scale=4` + `ocean2 y_scale=2` ⇒ **是 3D 海床形状，不能直抽** | §2.1 判据扫描 |
| 2 | §2 第 4 项：`roughness` 输出「2D 粗糙度系数」 | **错判**。它的输出**乘在 `minecraft:overworld/base_3d_noise` 上**，本体是 3D。可迁的只有内层那个 2D 样条（5 节点 / 20 控制点），且要自己接一个 2D 细节噪声 | 同上 |
| 3 | §5.C：「2D 子集撞 `genP95` 预算，比现有地形贵一到两个数量级」 | **不成立**。现状地形只占 8 ms 门的 0.3%；四族逐格 0.309 ms/列 = 3.9%，4×4 口径 0.035 ms = 0.45%。「贵一到两个数量级」成立，「撞预算」不成立 | §5.C 实测表 |
| 4 | §1 表：`offset/final` = 502 样条节点 / 3536 控制点 | **偏高约 9×**。正确口径（带 `points` 的对象计一个节点、闭包去重）下是 **122 / 380**；全 105 个 DF 文件级合计 **197 / 594** | §1 统计口径 |
| 5 | §2/§3 未列 **沙丘** 与 **丛林柱** | **补齐**。两者子树自身纯 2D，可单独摘出（沙丘 31 oct / 丛林柱 30 oct）。丛林柱**极稀有**（门控通过率 0.0035%），照搬原版数值几乎不生成 | §2.2 / §2.5 |
| 6 | 未提 GPU 侧遮罩代价、628 格周期性、水平尺度、Perlin 缺失 | **补齐四条**：GPU 每片元 5 次高度求值（167 octave）+ 高度图出路；~628 格近周期（高度相同 89.3%）；有效波长 1862~7877 格 vs 我们 400 格 region ⇒ k≈2~4；仓库零 Perlin | §5.D / §1.1 / §3 / §2.4 |

另修正两处引用：`genP95` 门禁本体在 `src/tests/test-worker-gen.html`（8 ms，纯地形）与
`test-structure-gen.html`（10 ms，含结构），不是 `docs/roadmap.md:530`；
`region/` 族的语义是「club 台地 / spade 梯田 / **diamond 湿地** / **heart 丘陵**」，
首版把 diamond 写成「沙丘」、heart 写成「丛林柱」—— 那两个是各自族内的**独立子树**，不是族的主地貌。