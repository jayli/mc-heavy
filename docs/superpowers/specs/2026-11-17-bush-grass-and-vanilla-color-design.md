# 矮草丛新增 + 草方块配色对齐 vanilla（设计）

日期：2026-11-17
状态：待批准

## 1. 意图与背景

用户三条需求（2026-11-17）：

1. **新增「矮草丛」方块**：贴图取自 wiki `short_grass`，样子类似本仓现有 `short_grass`，
   但**稍微更大一些**；以**与 `short_grass` 同等概率**生成在草地地形上。
2. **草方块配色对齐参考图**：用户给 `/Users/bachi/ttt/b/Grass_Block_JE7_BE6.png`，
   反馈「我在游戏里的目前用的草方块过于鲜艳了」。
3. **全量方块配色普查**：参照 `blockrender.dev/blocks/` 的标准配色，找出本仓色差并修正。

### 用户已裁定（本轮问答）

| 议题 | 裁定 |
|---|---|
| 草方块侧面草沿 | **顶面 + 侧面一起对齐参考图**（只改 overlay 覆盖的 texel，dirt 区不动） |
| 普查修正范围 | **只修「同图案的色差」**，不动素材身份；**所有树叶方块、玻璃方块等透明方块一律不动** |
| 生成概率 | **各 5%，草总量翻倍**（花/蘑菇/枯灌木档位一律不动） |

## 2. 实测结论（全部已验证，非推断）

### 2.1 参考图身份与着色反解

- 用户给的 `Grass_Block_JE7_BE6.png` 与 wiki 官方 `/images/Grass_Block_JE7_BE6.png`
  **逐字节相同**（300×300，byte diff = 0）。
- 等轴测三面顶点（逐行/逐列扫描 opaque bbox 得出）：
  顶面 `N(150,2) E(283,68) W(16,68) S(150,134)`；左面底边 `y=231`；右面底边 `y=297`。
- **顶面**：`wiki = vanilla grass_block_top 灰度 × T`
  - 逐 texel 相关系数 **0.9997**（朝向 fu=0/fv=0；其余 7 种朝向 corr ≤ 0.14）
  - 最小二乘反解 **T = (119.21, 186.57, 101.54)**，RMSE **0.831**
  - 取整到 0.1 → **T = (119.2, 186.6, 101.5)**，RMSE 不变
- **侧面**：`wiki = [side成品 × (1−a) + overlayGray × T × a] × shade`，`a = overlayAlpha/255`
  - 该模型 RMSE **0.86（左）/ 1.15（右）**
  - 对照：直接用 side 成品 × shade 是 **12.67 / 10.54** ⇒ **wiki 不使用 side 自带的草沿像素**
  - 反解 shade：左 **0.789/0.784/0.769**、右 **0.648/0.639/0.617**（= 面朝向光照，本仓由 packed 法线位承担）
  - 侧面独立反解 T = (117.24, 187.38, 102.01)，与顶面一致（差 <2.5，属重采样噪声）
- **交叉验证**：blockrender 的 512px 官方渲染反解 T = **(144.1, 188.0, 88.2)** ≈ plains 官方
  `#91BD59` = (145,189,89)。**两张图是不同 biome tint 的同一模型** ⇒ 用户参考图用的是
  一个更暗、更偏青的 tint，不是 plains 默认值。用户要的是**参考图那个色调**。

### 2.2 本仓现状与差值

| 项 | 现状 | 目标 | Δ |
|---|---|---|---|
| `grass_carried` 隐含 tint | (134.94, 204.98, 73.08)，逐 texel 残差 ≤0.54 | (119.2, 186.6, 101.5) | — |
| 顶面均值 | 78.0 / 118.5 / 42.3 | **68.9 / 107.9 / 58.7** | −9.1 / −10.6 / **+16.5** |
| 顶面 HSV | H 91.8° S **0.644** V 0.804 | H **107.4°** S **0.460** V 0.733 | 饱和度 −29% |
| `grass_side_carried` 草沿均值 | 113.5 / 174.1 / 70.3 | **72.1 / 113.1 / 61.5** | −41.3 / −61.0 / −8.8 |
| 侧面 dirt 区 | 与 vanilla `dirt` 有 48 字节差（side 自带 dirt 变体） | **逐字节不动** | 0 |

⇒ 用户「过于鲜艳」的判断**定量成立**（饱和度 0.644 vs 0.460）。
⇒ 只改顶面会造成「顶面暗、侧面草沿亮 1.5 倍」的撕裂，故必须同步改侧面草沿。

### 2.3 全量普查（152 个 tile 引用 / 95 个可比对）

方法：抓 blockrender 全量 vanilla 贴图（缓存 358 张 16×16），对每个本仓 tile 做
**两级判据** —— 单靠相关系数会被「同族纹理」骗到 0.99（实测 `Light_Gray_Cloth` vs `pink_wool`
corr 0.9965，但那是错的配对），故补**去均值归一化后的逐 texel 残差**：

| tile | 最佳配对 | corr | 归一化 RMSE | 判定 |
|---|---|---|---|---|
| `grass_carried` | `grass_block_top` | 0.9999 | **0.29** | ★同一张图，只差色调 |
| `double_plant_grass_carried` | `tall_grass_top` | 0.9992 | 3.64 | 同图（alpha 逐 texel 一致，比例 sd 6~7） |
| `sand_side` | `sand` | 0.9999 | **0.25** | ★同一张图 × 0.8814（三通道 sd ≤0.0016） |
| `log_big_oak` | `dark_oak_log` | 0.9995 | **0.37** | ★同一张图（比例 sd 0.10~0.27） |
| `Light_Gray_Cloth` | `light_gray_wool` | 0.9901 | **1.97** | ★同一张图（本仓是**纯灰度**版，vanilla 偏暖） |
| `procedural/giant_mangrove_log` | `dark_oak_log` | 0.9995 | 0.81 | 同图，但**本仓烘焙器有意染红** |
| `procedural/dark_grass` | `grass_block_top` | 0.9984 | 0.85 | 同图，但**源图是用户给的** |
| `procedural/light_grass` | `grass_block_top` | — | **11.63** | 另一张图（用户源图） |

**关键溯源**：上述 7 个 tile 对应的源文件与 mc-lite `src/assets/textures/` **全部逐字节相同**
⇒ 色差是**上游继承**的，不是本仓有意标定。

**本轮排除项（不动）**：
- 树叶族（`leaves` / `azalea_*` / `giant_*_leaves` / `snow_leaves` …）—— 用户明确不动
- 玻璃（`Glass` / `glass_blink`）、水（`water` / `swamp_water`）—— 用户明确不动
- `procedural/dark_grass` / `light_grass` —— 源图是用户 2026-11-01 指定的 736×736 照片，
  且 `light_grass` 与 vanilla 是**另一张图**（RMSE 11.63）。改它等于推翻既有裁定。
- `procedural/giant_mangrove_log` —— `bake-giant-textures.mjs` 显式写
  `base:[135,65,65], contrast:0.6` 且注释「保持逐字节不变（不顺手改动已验收的树皮观感）」
  ⇒ 它是**有意染红的派生产物**，不是继承色差。改它要改烘焙器参数，属另一件事。
- `Bone_Block_*` / `Deepslate` / `Obsidian` / `Iron_Ore` / `Nether_Bricks` / `Glowstone` 等
  corr <0.3 的 —— 是**换素材**不是调色，超出本轮裁定范围（已单独报告）
- 自创方块（`void_stone` / `void_infused_end_stone_bricks` / `chorus_planks` /
  `Floatato` / `Block_of_Amber` / `box_*` / `sand_train_track*` / `bed/*`）—— vanilla 无对应物

**本轮实际改动清单（6 个 tile）**：

| # | tile | 改法 | 目标均值 | 连带影响（必须知情） |
|---|---|---|---|---|
| 1 | `grass_carried` | 重算 = `vanilla灰度 × T` | 68.9/107.9/58.7 | 草地顶面（用户主诉） |
| 2 | `grass_side_carried` | 只改 overlay alpha>0 的 **45 texel** | 草沿 72.1/113.1/61.5 | dirt 区逐字节不动 |
| 3 | `double_plant_grass_carried` | 重算 = `tall_grass_top × T` | 70.7/109.3/60.2 | 现有 `short_grass` 草株变暗，与新草同色调 |
| 4 | `sand_side` | 重算 = `vanilla sand`（去掉 ×0.8814） | 219.2/207.2/163.1 | ⚠️ **sand 顶/侧不再有明暗差**（现在侧面暗 12%）；连带 `sand_step`/`sand_slab`/金字塔 |
| 5 | `log_big_oak` | 重算 = `vanilla dark_oak_log` | 60.4/46.6/26.2 | ⚠️ **树干变暗 ~27%**；连带 `wood` 与 `giant_oak_log`（巨树树干） |
| 6 | `Light_Gray_Cloth` | 重算 = `vanilla light_gray_wool` | 142.0/142.2/134.6 | ⚠️ **变暗 ~13% 且转暖**；浅水高台/中世纪船的历史明度序裁定引用过它（v2.21/v2.34） |

⚠️ **4/5/6 是用户选项里点名的那三项**，故纳入本轮。但它们各自有**超出草色的连带观感变化**
（沙块立体感、树干亮度、结构明度序）。若任一项不希望动，在批准时点名剔除即可 ——
它们与 1/2/3 完全解耦，可独立取舍。

`log_big_oak_top` 与 vanilla `dark_oak_log_top` **已逐字节相同**（dist 0）——
这正是「侧面被提亮、顶面没有」的证据，改侧面后顶/侧才一致。

## 3. 新方块设计

### 3.1 命名

`bush_grass`（矮草丛）。不用 `short_grass_2` / `tall_grass` —— 后者在 vanilla 是「高草丛」
（两格高），语义会撞。`bush_grass` 与 wiki 中文「矮草丛」对应且不与既有名冲突。

### 3.2 贴图

- 源：blockrender `/texture/block/short_grass.png`（16×16 灰度，6 个灰阶，
  不透明 140/256，bbox x0..15 y2..15）
- 产物：`assets/textures/procedural/bush_grass.png` = 源灰度 × **T(119.2,186.6,101.5)**
- 均值 **68.2 / 106.4 / 58.0**，与新草方块顶面（68.9/107.9/58.7）同色调
- 走烘焙脚本（**只是数据格式转换 + 着色，不新增美术资源**）：
  源图入库 `assets/grass-textures/src/short_grass_vanilla.png`，
  产物落 `procedural/`，指纹记源图 sha256 + T 常量。

### 3.3 几何

新模板 `TEMPLATES.bush_grass = crossQuads(0.805, -0.05, 0.87)`。

推导（**按实际草的 bbox 等比，不是按 quad 尺寸**）：

| | quad | 贴图 bbox | 实际草宽 | 实际草高 |
|---|---|---|---|---|
| 本仓 `short_grass` | `crossQuads(0.7,-0.1,0.6)` | x1..14 y0..15 | 0.7×14/16 = **0.6125** | 0.7×16/16 = **0.700** |
| 新 `bush_grass` | `crossQuads(0.805,-0.05,0.87)` | x0..15 y2..15 | 0.805×16/16 = **0.805** | 0.92×14/16 = **0.805** |

⇒ 草高 **+15%**、草宽 **+31%**（宽度差来自新贴图满宽、旧贴图左右各留 1 列空）。
「稍微更大」取 **+15% 等比草高**。若按 quad 尺寸等比放大，草高只 +0.6%（几乎看不出）——
这是必须按 bbox 算的原因。

`y0 = -0.05`（草底略入土，比 flower 的 −0.1 浅，避免草浮空）；`y1 = 0.87`。
双面 cross（`ds:true`），与 flower/vine 同手法，**不新增通道**。

### 3.4 方块声明

```
{"name":"bush_grass","solid":false,"cullMode":"cutout","orientationModes":4,
 "geometry":"bush_grass","shadowCast":false}
```

与 `short_grass` 逐项同口径（非实心、cutout、不投影、4 向朝向）。
`opaque` 不写 ⇒ `opaqueTable=0`（不遮光、不剔邻居面、不挡 LOS），与 short_grass 一致。

### 3.5 生成

**PLAINS（`vegetation.js` 的 `rollVegetation`）**：在函数**末尾**（现有 `return {}` 之前）
追加独立抽签，不改任何既有档位边界：

```
// 现有档位一律不动 …
if (randPlant < 0.13) return { plant: 'dead_bush' };
// 新增：矮草丛。独立盐、只在「原本空着」的格上生效，逐格概率恰 5%
if (seededRandom(wx, wz, seed + BUSH_GRASS_SALT) < BUSH_GRASS_CHANCE) {
  return { plant: 'bush_grass' };
}
return {};
```

⚠️ **必须放在所有既有 return 之后**（等价于 `randPlant >= 0.13` 且未抽中树）。
若插在 0.05~0.10 之间会**吃掉花的份额** —— 那是用户没要求的玩法变更。

⚠️ **空档宽度不能写 0.87**：`randPlant >= 0.13` 名义占 87%，但树抽签（`seed+1 < 0.005`）
是**独立盐**、会与之重叠。**实测 40 万格空档 = 86.611%**（不是 87%）。
故阈值取 `BUSH_GRASS_CHANCE = 0.05 / 0.86611 = 0.057729`，使逐格概率**恰 5%**。

分布实测（N=400000，seed 12345）：空 86.611% / short_grass **5.000%** /
azure_bluet 1.668% / allium 1.629% / flower 1.610% / dead_bush 1.476% /
oxeye_daisy 0.991% / tree 0.515% / red_mushroom 0.500%。

**更稳的等价写法（采纳）**：把常量写成 `0.05 / PLAINS_EMPTY_SHARE`，
`PLAINS_EMPTY_SHARE` 由**实测标定**并在单测里钉住（4.5%~5.5% 双侧界）。
这样将来任何既有档位调整都会被密度用例抓到，而不是静默漂移。

**高台草地（`tarn-terrain.js` 的 `tarnPlantAt`）**：同口径追加在 `return null` 之前。
该函数只有两档（`TARN_GRASS_CHANCE=0.05`、`TARN_FLOWER_CHANCE=0.05/3`），
**两者是独立盐**⇒ 空档 = `(1−0.05)×(1−0.016667) = 0.934167`（可解析，无需实测）。
阈值 `0.05 / 0.934167 = 0.053524`。

**盐**：`1043`（PLAINS）/ `1044`（tarn）。
程序化扫描确认空闲（扫 `src/**` + `tools/**` + `tests/**` 的 `seed + N`、`seed + CONST`、
`*SALT = N`；1041/1042 已被 `SAPLING_LEAF_SALT`/`TALL_LEAF_SALT` 占用，1043 起是第一个空档）。

**地表判据**：不新写「哪里有草」—— PLAINS 分支本身就是草地 biome，
tarn 分支复用 `tarnSurfaceBlock() === 'grass'`（红线 1）。

### 3.6 装配点（全部已核实存在）

| 文件 | 改动 |
|---|---|
| `src/voxel/blocks-data.js` | 新增 BLOCKS 条目 |
| `src/voxel/faces-data.js` | `bush_grass: 'procedural/bush_grass'` |
| `src/mesh/mesher.js` | `TEMPLATES.bush_grass` |
| `src/gen/structures/vegetation.js` | PLAINS 分支 + `BUSH_GRASS_SALT` |
| `src/gen/structures/tarn-terrain.js` | tarn 分支 + `BUSH_GRASS_TARN_SALT` |
| `tools/icon-fingerprint.mjs` | `FLAT_BLOCKS` 追加（非实心必须进，否则图标渲成立方体） |
| `tools/check-data.mjs` | `EXPECTED_NO_CAST` 追加（13 → 14 项） |
| `src/tests/test-block-registry.js` | `NO_CAST` 同步追加 |
| `src/tests/test-vegetation.js` | PLAINS 植物清单追加 + 新密度用例 |
| `src/tests/test-tarn-terrain.js` | tarn 密度用例追加 |
| `src/tests/index.html` | 若新建 test 文件则注册 |
| `assets/grass-textures/src/` | 源图入库 |
| `tools/bake-grass-textures.mjs` | 扩展：新增「灰度 × tint」路径 |
| `tools/grass-textures-fingerprint.mjs` | 新增 T 常量 + 源图指纹 |

背包自动进包（派生集合 = registry − 排除集合），只需跑 `npm run icons`。

## 4. 方案取舍

### 方案 A（采纳）：离线烘焙重算像素 + 新方块独立模板

- 草色改动全部落**烘焙产物**，运行期零代码改动（无 tint uniform、无新材质）
- 新方块走既有 cutout 通道 + 既有 cross 几何手法
- 指纹门钉住「源图 + T 常量」，改 T 忘重烘会当场报错
- 代价：`grass_side_carried` 不再与 vanilla 原始文件逐字节相同（**这是必要的** ——
  vanilla 靠运行时 overlay×biomeTint 着色，本仓是 unlit 无 tint 管线，必须预乘进贴图）

### 方案 B（否决）：运行时 tint uniform

给草方块加 biome tint uniform，在 TSL 里乘。
否决理由：① 违反「数据只有一份权威」精神（贴图与 uniform 两处着色）；
② 本仓无 biome→tint 表，要新建一套；③ 草方块之外的草株/树叶都要跟着接，
波及面远超需求；④ 用户只要一个固定色调，不要 biome 变化。

### 方案 C（否决）：直接换用 vanilla `grass_block_side` 原始文件 + 顶面改色

否决理由：实测 RMSE 12.67 —— vanilla side 自带的草沿是**另一套更亮的绿**，
wiki 渲染根本不用它。直接用会造成顶/侧撕裂（正是用户裁定要避免的）。

## 5. 验证计划

| 层 | 判据 |
|---|---|
| Tier 1（TDD） | `rollVegetation` / `tarnPlantAt` 的 bush_grass 密度：大样本逐格统计，**两侧钉界**（4.5%~5.5%），且既有 short_grass/花/蘑菇/枯灌木计数**逐位不变**（负向：把新分支插到 0.05~0.10 之间必须红） |
| Tier 1 | `TEMPLATES.bush_grass` 顶点 bbox：草宽/草高实测 0.805，且 > short_grass 的 0.6125/0.700 |
| Tier 2（门禁） | `check:data` 全绿（物品集合关系式 / 图标指纹 / 草贴图指纹 / 阴影投射 14 项 / 测试注册） |
| Tier 2 | 烘焙产物均值断言：顶面 68.9/107.9/58.7、草沿 72.1/113.1/61.5、bush_grass 68.2/106.4/58.0、sand_side 219.2/207.2/163.1、log_big_oak 60.4/46.6/26.2、Light_Gray_Cloth 142.0/142.2/134.6（±0.5） |
| Tier 2 | 侧面 dirt 区**逐字节不变**（内容级判据，指纹拓不到「只改了草沿」） |
| Tier 4（像素） | 真游戏页截图：草方块顶面均值落在目标 ±3；**同时钉上下界**（防纯黑/防没变） |
| 预算 | `npm run bench -- --check` + `tests/giant-tree-budget.spec.mjs`（cutout 相对 HEAD 不恶化；粗估草类占 cutout <1%，新增后 +<1 点） |
| 门 | `npm run check`（arch + data + lint），改动文件单独跑 eslint 确认零新 warning |

烘焙链：`npm run grasstextures` → `npm run atlas` → `npm run icons`。

## 6. 非目标

- 不做 biome 动态着色
- 不动树叶/玻璃/水/任何 transparent 方块
- 不换任何素材身份（corr<0.3 的那批只出报告）
- 不动 `dark_grass`/`light_grass`/`giant_mangrove_log`（既有裁定或有意派生产物）
- 不改花/蘑菇/枯灌木的生成档位
- 不提交（等明确指令）