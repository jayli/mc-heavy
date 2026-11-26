# 新增环境风格「普通」—— 移植 ASHLAR 的天空与光影（设计）

> 版本：v1 ｜ 日期：2026-11-27 ｜ 状态：待用户审阅
> 目标仓库：mc-heavy ｜ 上游：`~/jaylli/agent-demos/prompts/ultra-realistic-blockworld/generations/sonnet-5.6-next`（ASHLAR）
> 关联：`2026-10-24-lighting-realism-design.md`（v1.70 ACES/地板/半球）、`2026-10-20-sun-shading-and-skybox-design.md`（v1.58 N·L）、
> `2026-11-17-ghibli-noon-atmosphere-revert-report.md`（**必读**：两条否决结论 + 一批可复用标定数据）

## 1. 意图与范围

用户要新增第 5 档环境风格「**普通**」，**不参与日夜轮转**（纯手动 override，与 `dusk` 同性质），
把上游 ASHLAR 的天空与环境光影参数移植过来。

**用户已裁定的三条**（2026-11-27 问答）：
1. 天空走**离线烘成六张立方图**，不做运行时体积云；
2. 「普通」**只做手动档**，游戏启动默认仍是自动日夜循环；
3. 后处理**只上色调映射**（上游 AgX + display-space punch），不引入 bloom / 色差 / 暗角 / 体积雾 / 锐化。

### 1.1 非目标（明确不做）

- 不做运行时大气散射、不做 raymarch 体积云、不做云影。
- 不引入 GTAO / SSR / GGX-PBR / POM / 法线贴图 —— **本仓无 G-buffer**，只有 6 个离散面法线
  （`packed` bit10-12），没有逐像素法线 / 粗糙度 / 金属度数据源。这是结构性缺数据，不是参数没调够。
- 不做 4 级 cascade + PCSS 阴影 —— WebGPU 的 depth-compare 路径全黑（红线，VSM 唯一可用）。
- 不改帧循环为 `RenderPipeline`（见 §3.3 实测：不需要）。
- 不动玩法、地形生成、方块集合、存档格式。产物是像素。

### 1.2 反目标（做了就算失败）

- 「普通」档的任何改动**泄漏到其余四档或自动循环**（零回归是本设计的第一约束）。
- 天空盒里画进地面 / 建筑 / 树（用户红线：天空盒只画天空，那些由引擎渲染）。
- 为了对齐上游而放宽既有冻结断言的阈值。

## 2. 现状与约束（实测，不是推断）

### 2.1 上游天空是程序化的，**没有贴图可搬**

`22_sky.js` 用 Hillaire 式大气：透射率 LUT 256×64、多重散射 LUT 32×32、天空视图 LUT 200×112，
外加 96³/40³ 3D 噪声 raymarch 体积云。全部是 `ShaderMaterial(GLSL3)`。
整个 generation 目录只有 8 张截图 PNG，**零贴图文件**。

本仓 `pitfalls.md` 已记：raw GLSL `ShaderMaterial` 在 WebGPU 后端一行都不能用
（`fromMaterial()` 返 null → 画面全空）。⇒ 只能离线烘焙或 TSL 重写，用户选前者。

### 2.2 照片感的主因是**直射/环境比**，不是色调映射

| 口径 | 直射项 | 环境项 | 比值 |
|---|---|---|---|
| 上游 h=8 | `key·N·L/π = 1.330` | SH 上半球 `0.312` | **4.26** |
| 本仓 noon | `SUN_INTENSITY·N·L = 0.620` | `SHADOW_FLOOR = 0.38` | **1.63** |

太阳仰角也差一档：上游 h=8 是 **26.2°**，本仓 noon 是 **53.1°**。

### 2.3 上游 AgX ≠ three 内置 AgX（GPU 实测）

一次性探针（`renderer.library.addToneMapping` + 三个已知线性基色的 quad，真实 GPU 回读）：

| 线性输入 | NoToneMapping | ACES | three 内置 AgX | **上游 AgX+punch** |
|---|---|---|---|---|
| 0.05 | 63 | 50 | 70 | **47** |
| 0.2 | 124 | 135 | 133 | **110** |
| 0.6 | 203 | 207 | 182 | **165** |

零 GPU 校验错误。CPU 侧预测 0.05→47 / 0.2→110，与 GPU **逐位吻合** ⇒ 标定口径成立。

### 2.4 「上游天空更灰」主要是色调映射，不是大气公式

标定过程中我先把截图里一片**云**误当成纯天空（`[1500,60]-[1800,140]` = 165,171,186）。
按行内 std 重扫，真正的纯天空带是 y=30~54（std 6.4）= **154,161,180**（R−B −26）。

- 纯大气辐射（仰 34° 朝阳，h=8）线性 `0.3249,0.4333,0.7036`，直接 sRGB 编码 → `154,176,218`（R−B **−64**）；
- 同一辐射经**上游 AgX+punch**（exp 1.4）→ `151,167,193`（R−B **−42**），已与实测同量级（Δ≤13）。

⇒ AgX 本身大幅去饱和。剩余偏差来自真实时刻是 `G.time=7.35`（非 8.0）、真实相机 pitch/方位、薄云覆盖。
**烘焙曝光须在真实机位上重标，不得沿用本文的探针值。**

### 2.5 CPU 镜像与 GPU 版差异有限（推翻我自己的初判）

`Sky.radiance()` 是给环境光用的低精度近似（10 步、`msTerm=0.045·clamp(...)`、g=0.76），
GPU 版走真多重散射 LUT（32 步、g=0.8）。实测两者比 **0.92~1.16**。
⇒ 差异存在但不足以解释观感差距；**烘焙仍须用 GPU 版三个 pass**（已在 Node 里精确复现并跑通）。

### 2.6 辐射会超 1.0，烘焙必须定曝光

上半球辐射（h=8）：max **1.689**（太阳附近）、p50 0.474、p95 1.100、p99 1.305。
8bit JPEG 削顶扫描：exp 0.50 → 0%、0.65 → 0.13%、0.80 → 0.94%、1.00 → **4.88%**。
⇒ 烘焙曝光候选区间 **0.5~0.65**（与 §2.4 的运行时曝光 1.4 是两个不同的量，勿混）。

### 2.7 天底方向辐射≈0，必须给中性地面色

上游 `skyColor(rd)` 在 `rd.y<0` 时另画「远处海面」。烘焙立方图若直接取全方向，
天底那半会近黑（实测 `11,18,29`）。⇒ **只取上半球大气，天底半给中性地面色**
（与既有 `rainy` 天空盒「纯天空背景、不画地面景物」同口径）。

## 3. 方案

### 3.1 已考虑并否决的方案

| 方案 | 否决理由 |
|---|---|
| 搬上游天空贴图 | **不存在**（§2.1） |
| TSL 重写大气 + 体积云 | 用户已裁定不做；且要读 depth，MSAA depth 不可采样这条已实测失败过（见 memory `ssr-depth-prepass-blocked-by-webgpu-usage`），本仓 vd8 帧时 p95 9.2ms 已贴 8.3ms 预算 |
| 改帧循环为 `RenderPipeline` + 全屏 grade pass | §3.3 证明不需要；且会牵动准心/箭头/伤害数字的「render 之后」时机（4 处静态守卫 + 35 个读 `renderer.info` 的 spec） |
| 直接用 `THREE.AgXToneMapping` | 与上游矩阵不同，实测差 23 luma（§2.3） |
| 把「普通」设为默认 | 用户已裁定只做手动档；设默认要重标 48 个像素 spec 的基线 |

### 3.2 天空：离线烘焙第 5 套立方图

新增 `tools/bake-normal-sky.mjs` + `tools/normal-sky-fingerprint.mjs`，产出
`assets/sky/normal/{posx,negx,posy,negy,posz,negz}.jpg` + `normal-sky.json`（指纹）。

**烘焙 = 数据格式转换，不产生新美术资源**：输入是上游大气公式的数值求值，
输出是与既有四套同规格的六张 1024² 立方图面。

- 在 Node 里精确复现上游三个 pass（`transPass` / `msPass` / `skyPass`），已跑通验证；
- 方向 → 立方图面的映射与加权**复用 `bake-night-sky.mjs` 的 `faceDir` / `dirToUV` 口径**
  （那条管线保证 12 条共享边接缝精确为零，实测 RMS 0.02）；
- 天底半给中性地面色（§2.7）；
- 固定时刻 = 上游 `G.time` 口径下的一个上午档（**待定，见 §6**）；
- `check:data` 的 `[天空盒]` 环节自动覆盖第 5 套（它遍历 `SKY_SETS`）；
  新增 `[普通天空]` 指纹环节（照 `[夜空]` 同款）；
- 接缝走 `tests/night-sky-seam.spec.mjs` 同口径实测，不宣称目视。

接线：`sky-config.js` 的 `SKY_SETS` 加 `normal`；`sky.js` 加第 4 层混合
`mix(mix(mix(day,night,uNightBlend),dusk,uDuskBlend),normal,uNormalBlend)`。
**嵌套顺序载荷性**：`uNormalBlend=0` 时内层表达式逐位回到 v1.71 ⇒ 其余四档零回归。
`setupFog` 的天空采样同步加同一层（共用同一个 uniform 实例，否则「雾是白天色、天是普通色」撕裂）。

### 3.3 色调映射：`renderer.library` 注册自定义曲线（**不改帧循环**）

**这是本设计最关键的实测结论。** 一次性 GPU 探针证实：

```js
renderer.library.addToneMapping(ashlarAgxFn, CUSTOM_ID);  // 公开 API
renderer.toneMapping = CUSTOM_ID;                          // 真实上屏
```

- `getOutputCacheKey()` 含 `toneMapping` ⇒ 切换时输出 pass 自动重建；
- 切回 `ACESFilmicToneMapping` 后读数**逐位回到原值**（`[50,135,207]`）⇒ per-style 来回切不残留；
- 零 GPU 校验错误；
- ⇒ **不需要 `RenderPipeline`、不需要 `pass()`、不碰帧循环**。
  准心 / 屏外箭头 / 伤害数字 / `renderer.info` 快照的「render 之后」时机全部不受影响。

落点：新增 `src/render/ashlar-tonemap.js`（TSL `Fn`，逐字移植上游 `25_post.js:389-403` 的
inset/outset 矩阵 + `agxContrast` + display-space `pow(1.28)` + 饱和 1.17）。
`DayNight._apply` 按风格写 `renderer.toneMapping`（与既有 `toneMappingExposure` 同一收口点）。

⚠️ `addToneMapping` 对已存在的 id 会 `warn` 并**拒绝覆盖**（`addType` 实现）⇒ 用一个未占用的常量 id，
且只注册一次（模块级惰初始化）。

### 3.4 光影参数：把三个全局常量做成 per-style uniform

上游的「照片感」落在直射/环境比上（§2.2），而本仓 `SHADOW_FLOOR` / `SUN_AMBIENT` / `SUN_INTENSITY`
是 `sun-shade.js` 的**全局常量**，`HEMI_GROUND` 是 `hemi-shade.js` 的全局常量。

新增三个 uniform（走 uniform buffer，**不占顶点属性** ⇒ `gpuVertexBytes` 零增量，200MiB 门不受影响）：

| uniform | 中性值（= 现状，逐位零回归） | 「普通」档候选 |
|---|---|---|
| `uShadowFloor` | 0.38 | ~0.14 |
| `uHemiGround` | 0.6（**已存在**，只需接风格写入） | ~0.12 |
| `uSunIntensity` | 0.775 | ~0.96 |

⚠️ **`SHADOW_FLOOR` 有两处消费**：影区地板 **与 `shadowKill` 的归一化分母 `1 − SHADOW_FLOOR`**。
per-style 化必须**同步改两处**，否则「影区地板」与「太阳被拿走的比例」撕裂。

⚠️ CPU 参考实现 `sunTermRGBFor` / `hemiFactorFor` 必须接受同样参数（红线 1：TSL 与单测同一份公式）。
用**可选参数 + 缺省为现有常量**的方式扩展 ⇒ 16 处既有调用方一字不动。

「普通」档候选值的来源（把上游截图 sRGB 反解回线性、再套本仓公式解方程）：

```
影/亮 = floor/(floor + I·N·L) = 0.249   （草地树影 34 / 受光 92）
顶/侧 = 1/(影亮比 × 侧面hemi)  = 7.16   （stone 顶 161 / 阴侧 64）
⇒ 侧面 hemi = 0.561 ⇒ HEMI_GROUND ≈ 0.122
⇒ I·N·L/floor = 3.015 ⇒ floor 0.14 时 I ≈ 0.956
```

⚠️ 这是**反解初值，不是终值**。必须在真实机位上按 Tier 4 口径重标（§5）。

#### 3.4.1 `skyDim` 必须保持 1.0（builder check 发现的耦合）

`DayNight._apply:468` 与 `game.js:2445` 都把 **`uShadowStrength` 写成 `p.skyDim`**
⇒ `skyDim` 同时驱动「skylight 亮度」**与**「阴影浓度」，两个自由度被绑在一起。

上游要的是「强直射 + 深阴影」。若为了压暗而把 `normal.skyDim` 设 <1，
**阴影会跟着变浅**，正好抵消 §3.4 想要的效果。

⇒ **`normal.skyDim = 1.0`、`blockBoost = 1.0`**（与 noon 同）。
暗部与对比全部交给 `shadowFloor` / `hemiGround` / `sunIntensity` / `toneMappingExposure`。
这也让 `nightBlend` 的显式 0 与派生值恰好一致（双保险，但仍须显式写，见 §3.5）。

### 3.5 风格数据与 UI

`VISUAL_STYLES.normal` 新增，字段与既有四档同构：
`sky` / `fogColor` / `fogScale` / `skyDim` / `blockBoost` / `sunDirection` / `toneMappingExposure` /
`moonDirection`（仰角 35.4241°、方位 = 本档太阳方位，既有遍历断言强制）/ `moonVisible:false` / `moonSize` /
`sunColor` / `ambientColor` / `duskBlend:0` / `nightBlend:0`（显式，不从 skyDim 倒算）/ `waterTint` /
新增 `normalBlend:1` / `shadowFloor` / `hemiGround` / `sunIntensity` / `toneMapping`。

- `KEYFRAMES` **一行不动** ⇒ 自动循环全程 `normalBlend=0`（与 `duskBlend` 同款不变式，单测钉死）；
- `settings.js`：`VISUAL_STYLE_OPTIONS` 加 `'normal'`，位置**待定（见 §6）**；
- 面板 `_rowVisualStyle` 加「普通」文案。左列 375px / gap 8px / padding 8px / border 4px
  ⇒ 6 个按钮每只 55.8px、文字可用 **43.8px**，2 字（24px）放得下 ⇒ **不折行、面板高度不变**
  （`teleport.spec` / `about-tab.spec` 的「不得出现纵向滚动条」冻结断言仍守得住）；
- `waterTint` 必须重新标定：曝光变了会连带提亮 unlit 海面（v2.1 的既有教训）。

### 3.6 色温：保色相、幅度需裁定

上游 h=8 的 key `[11.291,9.466,7.147]` → 相对乘数 `[1.214,1.018,0.768]`（暖直射）；
SH 上半球 `[0.196,0.312,0.499]` → `[0.584,0.929,1.487]`（冷环境）。

⚠️ 本仓 `ambientColor` 是**单一乘数（各面同色）**，上游 SH 是逐方向的 ⇒ 色相只能取一个代表方向，
「上蓝下黄」的方向性在本仓由标量 `HEMI_GROUND` 表达，**无法逐通道**。

⚠️ ghibli 报告已实测：`ambientColor` 原色相会把石头变蓝砖（背光面 R−B −95），当时裁定衰减到 0.15。
本轮用户要「照抄上游」⇒ **幅度需重新裁定（见 §6）**。候选扫描（背光面 R−B）：
0.15 → −14 / 0.25 → −23 / 0.35 → −32 / 0.50 → −45 / 1.00 → −95。

## 4. 改动清单

| 文件 | 改什么 |
|---|---|
| `tools/bake-normal-sky.mjs` | **新增**：Node 复现上游三个大气 pass → 六面立方图 |
| `tools/normal-sky-fingerprint.mjs` | **新增**：指纹（照 `night-sky-fingerprint.mjs`） |
| `assets/sky/normal/*` | **新增产物**（6 JPEG + 1 JSON，不手改） |
| `package.json` | 加 `npm run normalsky` |
| `src/render/sky-config.js` | `SKY_SETS` 加 `normal` |
| `src/render/sky.js` | 第 4 层混合 + `uNormalBlend` 句柄 + dispose |
| `src/render/materials.js` | `setupFog` 同步第 4 层；三个新 uniform + `shadowKill` 分母同步 |
| `src/render/ashlar-tonemap.js` | **新增**：上游 AgX+punch 的 TSL `Fn` + 注册入口 |
| `src/render/sun-shade.js` | `sunTermRGBFor` 加可选 floor/intensity 参数（缺省 = 现常量） |
| `src/render/hemi-shade.js` | 无需改（`hemiFactorFor` 已接受 ground 参数） |
| `src/render/daynight.js` | `VISUAL_STYLES.normal`；`lerpParams` / `_apply` / `get params` 三处同步新字段 |
| `src/ui/settings.js` | `VISUAL_STYLE_OPTIONS` 加档 |
| `src/ui/settings-panel.js` | 「普通」文案 |
| `tools/check-data.mjs` | `[普通天空]` 指纹环节 |
| `src/tests/test-normal-style.js` | **新增** Tier 1 |
| `tests/normal-style.spec.mjs` | **新增** Tier 4 |
| `tools/test-tiers.mjs` | 两个新文件归档（双向门禁） |
| `docs/roadmap.md` | 版本行 |

## 5. 验证策略

**Tier 1（必须 TDD，RED→GREEN）**：
- `normalBlend` 不变式：自动循环全程恒 0（照 `duskBlend` 同款，h 步长 0.25 扫全 24h）；
- 三个新 uniform 取中性值时，`sunTermRGBFor` / TSL 公式**逐位**回到现状；
- `shadowFloor` 与 `shadowKill` 分母同步（注入不同步 → 必须真 FAIL）；
- 风格表遍历断言：新档满足月亮仰角/方位、色温三分量、`waterTint ∈ (0.15,1]` 且三通道相等；
- **`skyDim` 与阴影浓度的耦合**（§3.4.1）：`normal.skyDim === 1` 且 `uShadowStrength` 读回 1；
- **`nightBlend` 必须显式给 0**：漏写时 `nightBlendOf` 会从 skyDim 倒算（实测 skyDim 0.9 → 0.133）
  ⇒ 天空混入星空。断言钉「显式字段存在」而不是只钉混合结果为 0（skyDim=1 时倒算也得 0，判据会恒真）；
- **`test-daynight.js:292` 的「风格表只应有这四项」会真红** ⇒ 改成「五项 + 自动循环仍只引用三档」，
  **不放宽其它断言**。

**Tier 4（像素实测，不得宣称目视）**：
- 天空接缝：12 条共享边 RMS / 面内噪声底比值，与白天基准 1.765 同量级；
- 天空内容：只含天空（天底半是中性地面色，不含建筑/树）；
- 直射/环境比：顶/阴侧、影/受光，落在实测标定带内；
- 色调映射真的生效：同一机位 `normal` vs `noon` 的灰阶读数必须可区分（上游 AgX ≠ ACES ≠ 内置 AgX）；
- **零回归**：其余四档 + 自动循环，同机位逐位不变（`uNormalBlend=0` / 三 uniform 中性）；
- 水面 luma 落在重标后的带内。

**负向验证（必需）**：注掉第 4 层混合 / 注掉自定义 toneMapping / 让 floor 与分母不同步，
对应断言必须真 FAIL；注入后**读回源码确认落地**（用 `edit` 不用 `sed`），还原用 `cp` 副本。

**最小充分集**（按 AGENTS.md）：`npm run check` + `npm run test:unit` +
`tests/normal-style.spec.mjs` + 共享装配段的邻居
（`daynight-visual` / `dusk-style` / `skybox` / `fog-color` / `sun-directional` / `hemisphere-ambient` / `sun-shadow` / `water-visual`）。
**不跑 `npm test`**（本改动不是全局基础设施）。
碰了 materials 热路径 ⇒ 加 `npm run bench -- --check`。

⚠️ **bench 盲区**：`bootGame` 不传 `style` ⇒ 四场景全走自动循环，
`bench --check` 只证明「其余档无回退」，**不是「普通」档的性能证据**。
「普通」档的帧时须单独构造机位量（交替对照，绕开 vsync）。

## 6. 留给用户的三个决定（实施前需答）

1. **「普通」档固定在上游哪个时刻？** 上游截图是 `G.time=7.35`（上午，太阳仰角 ~17°）；
   本文参数反解用的是 h=8（仰角 26.2°）。两者影子长度差近一倍。
   建议取 **h≈8~9（仰角 26~38°）**：影子够长有立体感，又不至于像黄昏那样地面偏暗。
2. **「普通」按钮放哪？** 建议放在「正午」右边、「傍晚」左边（自动/早晨/正午/**普通**/傍晚/黑夜）——
   但既有断言钉死「傍晚紧挨正午右边」，插入需同步改那条关系式（改成「傍晚在普通右边」）。
   另一个选项是放在末位（…/黑夜/普通），既有关系式一字不动。
3. **`ambientColor` 冷色幅度取多少？** 原色相（1.00）会让石头明显发蓝（R−B −95）；
   ghibli 那轮裁定 0.15。建议 **0.35**（R−B −32）：比 0.15 明显更冷、仍在不饱和区间。

## 7. 实施细节（builder check 已核定；我的判断，非用户裁定）

- 烘焙曝光初值取 0.5~0.65（§2.6 削顶扫描），运行时曝光按 §2.4 在真实机位重标；
- 天底半的中性地面色取「本档地平线色 × 0.5」，理由是雾色与背景天空共用同一份数据（红线 1）；
- 自定义 toneMapping 的常量 id 取一个未占用值（three 现用 0~7），只注册一次
  （`addType` 对已存在 id 会 warn 并**拒绝覆盖**）；
- **`normalBlend` 进 `lerpParams` 用 `(a.x || 0)` 容错**（照 `daynight.js:287` 的 `duskBlend` 同款）
  ⇒ 旧四档不写该字段，插值结果恒 0；
- **三个新 uniform 同样「缺字段 → 回落现有常量」**（`SHADOW_FLOOR` / `HEMI_GROUND` / `SUN_INTENSITY`）
  ⇒ 自动循环与旧四档逐位零回归。**不得给旧四档补写字面量**（那会多一份权威，红线 1）；
- **`check:data` 的 `[天空盒]` 环节自动覆盖第 5 套** —— 已核实 `checkSkyboxAssets` 遍历 `SKY_SETS`、
  信息行也从清单派生 ⇒ 那一节无需改，只新增 `[普通天空]` 指纹环节；
- `moonDirection` 已算出满足既有遍历断言的写法（实测方位差 **0.000000°**、仰角 **35.4241°**）：
  `sunDirection [0.847863, 0.441506, 0.293599]` / `moonDirection [0.770024, 0.579624, 0.266645]`
  （对应 h=8；若用户选其它时刻需重算）。

## 8. Builder check 记录

未获委派授权，故由我以实施者视角自审（**不是独立 fresh 审查**，这一点明说）。拓到并已补入文档的缺口：

1. **`skyDim` 与阴影浓度耦合**（§3.4.1）—— 原文没写 `normal.skyDim` 取何值，
   而它同时驱动 `uShadowStrength` ⇒ 设 <1 会抵消本设计想要的深阴影。已定 **1.0**。
2. **`nightBlend` 断言会恒真** —— skyDim=1 时倒算也得 0，只钉混合结果拓不到「漏写显式字段」。
   已改成钉「显式字段存在」。
3. **新字段的缺省回落路径**（§7）—— 原文只说「三处同步」，未说旧四档不写时怎么办。
4. **`addToneMapping` 拒绝覆盖已存在 id**（§3.3 / §7）。

仍留给用户的只有 §6 那三条（它们会实质改变画面，不是实施细节）。