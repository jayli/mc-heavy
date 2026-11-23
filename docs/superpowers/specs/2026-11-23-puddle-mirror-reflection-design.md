# 雨天积水斑的镜面反光（v3.32）设计稿

> 状态：**用户已批准方案 A**（2026-11-23「按照你的建议用 A 方案」）。
> 分支：`feat/kv9-carbine-and-rainy-lighting`（HEAD `825ef67`，工作树干净）。
> 前置：`2026-11-22-wet-surface-rebuild-design.md`（v3.31 湿表面）—— 本稿是它的**增量**，不重写它。

## 1. 意图与为什么

用户 2026-11-23：「你刚刚实现了下雨天的雨天光影，实现了地面的水汪的效果，**水汪没有反光**，
适当地加一些水汪的反光效果，这样会更逼真」。

⇒ 目标只有一个：**让已有的积水斑真的反光**（看起来是一摊水，而不是一块更暗的斑）。
形状、材质分类、雨丝、水花、雨声、墙面弱湿、水下门、云不湿 —— **全部不动**。

## 2. 根因取证（GPU 像素 + CPU 纯函数双向实测，不是猜）

### 2.1 积水斑现在只压暗、不反光

v3.31 的积水修正只有三项：`rough × 0.25`、`specGain × 1.60`、`albedo × 0.88`。
反光强度仍走同一条 `reflK = (F + floor) × specGain × WET_REFL_MAX × wet`。
问题在于 **`specGain` 被 `min(…, 1)` 钳死**，而抛光/冰类的 `specGain` 本来就是 **1.0**
⇒ `× 1.60` 后仍是 1.0，**一点没涨**；只有 `rough` 变小带来的 F0/floor 微增。

CPU 同构纯函数实测（noV=0.53，真实 atlas 基色 Smooth_Stone 线性 luma 0.3816、正午天空 0.5529）：

| 类 | 水膜 reflK | 积水 reflK | 屏幕 Δluma（积水 − 水膜） |
|---|---|---|---|
| POLISHED | 0.1883 | **0.1962**（+4%） | **−5.91** |
| STONE | 0.0526 | 0.1123 | −2.96 |
| WOOD | 0.0336 | 0.0802 | −4.35 |
| SOIL | 0.0162 | 0.0494 | −4.32 |

**⇒ 积水处比周边更暗**（albedo × 0.88 的压暗盖过了那 4% 反光增量）。
这正是用户说的「水汪没有反光」。

GPU 侧交叉验证（`tests/tmp-puddle-probe.spec.mjs`，真实 Chromium/Metal，25×33 抛光石地面）：
开档后地面区 mean luma **181.58 → 178.32**（净变暗），p50 **183 → 177.81**。
方向与 CPU 侧一致 ⇒ 不是测量方法问题。

### 2.2 太阳高光在水汪处数学上恒为 0

积水处 `rough = 0.35 × 0.25 = 0.0875` ⇒ `wetShininess` = **320.6**。
该机位 `N·H = 0.677` ⇒ `pow(0.677, 320.6)` = **4.94e-55**。
⇒ 抬高 `WET_SUN_SPEC` 对水汪**零作用**（它是掠射角才可见的项，v3.31 §11.1 已记）。

### 2.3 积水掩码本身是好的，不要重做

绕开 ACES（`toneMapped=false`）直接量 `mx_noise_float` 与 puddle 掩码（`tmp-puddle-mask.spec.mjs`）：

| 量 | 实测 |
|---|---|
| 噪声 n 的分布 | p5 0.3916 / p50 0.5711 / p95 0.7529，min 0.008 |
| puddle > 0.1 的像素占比 | **0.3291** |
| puddle > 0.5 的占比 | 0.2081 |
| puddle 均值 / 最大 | **0.1832 / 0.7682** |

⇒ 连续、覆盖三成、**峰值只到 0.768 而不是 1.0**（`smoothstep(0.52, 0.76, n)` 而 n 的 p95 才 0.753）。
形状与连续性已由 v3.31 用例④守住。**本轮不动噪声、不动阈值带**。
⚠️ 但「峰值 0.768」是标定强度时必须代入的真实值 —— 按 p=1 算会高估效果 26%。

### 2.4 水汪处若只抬强度会变成「纯色塑料板」

积水处 rough → 0.015 ⇒ 天空渐变带宽 `lo=−0.155 / hi=0.557` 极窄，
而正午 `sky` 与 `fogColor` **同为 0x87ceeb**（v3.31 §7.3 已记）
⇒ `skyEnv` 在整个水汪内**几乎是同一个颜色**。只抬 reflK 会得到一片均匀色块。
真实水汪反的是**阴天云层**（有明暗层次），所以必须给天空环境加一层低频调制。

## 3. 目标 / 非目标 / 反目标

**目标**
- 积水斑处有**明显强于周边水膜**的天空反光（镜面感），量级由 Tier 4 目标带钉住。
- 水汪内的反光有**明暗层次**（云影），不是纯色板。
- 材质分层保住：抛光/石强、土弱、布/植被几乎没有。
- **墙面、云、水下、关闭态逐位不动**。

**非目标（本轮不做）**
- 真实倒影（不采样任何 RT）—— v3.31 用户裁定不变。
- 涟漪 / 流水动画 / 任何 `uTime`（湿表面仍是静态的）。
- 改噪声尺度、阈值带、材质分类表、方块顺序。
- 新增顶点属性、新增 render pass、新增贴图。

**反目标（做到了也算失败）**
- 抬 `WET_REFL_MAX` 或 `WET_REFL_FLOOR` 来实现（会让**整片湿墙**变亮 = 用户上次报的岩壁光晕缺陷复活）。
- 抬 `WET_SUN_SPEC` 来实现（§2.2 实测零作用）。
- 让水汪镜面项在**侧面/底面**生效（墙面必须保持极弱）。
- 用 `add` 叠反光（亮端钳白，本仓已实测）。
- 关掉雨后水汪反光残留（`uWet=0` 必须逐位回到未开启）。

## 4. 方案取舍（Approaches）

| 方案 | 做法 | 取舍 | 结论 |
|---|---|---|---|
| **A** | 给积水加一条**独立于菲涅尔的镜面目标**：`reflK = mix(水膜 reflK, MIRROR × specGain × wet, puddle × topGate)`，并给水汪的天空环境加低频云影调制 | 零新 pass / 零新顶点属性 / 零新贴图；水膜与墙面公式**逐字不动**；强度是一个可单独 A/B 的常量 | **采纳（用户选定）** |
| B | 抬 `WET_REFL_MAX` / F0 / 菲涅尔幂 | 水膜与墙面一起变亮 ⇒ 岩壁光晕缺陷复活；v3.31 §11.1 已把这三个旋钮扇描完，最强也只 3.81 | 否 |
| C | 开水面的反射 RT 给地面采样 | 几何上只对镜面那一层成立（v3.31 §2.1 的根因），且新增 pass 吃帧时 | 否 |

## 5. 着色模型（增量，其余逐字沿用 v3.31 §6.4）

### 5.1 新增常量（`wet-surface-config.js`）

```
WET_PUDDLE_MIRROR   = 0.70   // 积水的镜面反光目标（绝对值，不是乘数）
WET_PUDDLE_CLOUD    = 0.25   // 水汪内天空环境的云影调制幅度（±25%）
WET_PUDDLE_CLOUD_SCALE = 0.09 // 云影噪声的世界 xz 尺度（斑块 ≈11 格，比积水斑大 3.5 倍）
```

**为什么 MIRROR 是绝对目标而不是乘数**：`specGain` 已被 `min(…,1)` 钳死（§2.1 根因），
再乘任何系数对抛光类都是恒等。必须是「积水处 reflK 直接拉到 `MIRROR × specGain × wet`」。

**MIRROR = 0.70 的扇描依据**（代入真实 p=0.7682、noV=0.53，Δ = 积水 − 水膜 luma）：

| MIRROR | 抛光 | 石 | 木 | 土 | 布 |
|---|---|---|---|---|---|
| 0.65 | +14.0 | +11.3 | +6.7 | +5.2 | −2.4 |
| **0.70** | **+15.8** | **+12.7** | **+7.7** | **+6.0** | **−2.2** |
| 0.80 | +19.5 | +15.4 | +9.7 | +7.6 | −1.8 |
| 1.00 | +26.6 | +20.6 | +13.6 | +10.9 | −0.8 |

取 0.70：抛光落在目标带 [12,28] 中段、布仍几乎不变（分层保住）、
且 `reflK` 全组合上界 **0.70 < 1** ⇒ `mix` 天然有界。

**CLOUD = 0.25 的扇描依据**（水汪内 luma 跨度，amp 已 × puddle）：

| CLOUD | 抛光 span | 石 span |
|---|---|---|
| 0.20 | 17.9 | 11.4 |
| **0.25** | **22.4** | **14.3** |
| 0.30 | 27.0 | 17.1 |

取 0.25：抛光 span 22.4 落在 [12,36]，肉眼有层次但不花。

### 5.2 公式（只改两行 + 加一项）

```
topGate = step(0.5, up)                                  // 水汪镜面只在朝上面
mirrorK = WET_PUDDLE_MIRROR × specGain × wet
reflK   = mix(reflK_film, mirrorK, puddle × topGate)      // ★ 水膜项 reflK_film 逐字不动
reflK   = min(reflK, 1.0)                                 // 有界（实测上界 0.70）

cloud   = mx_noise_float(vec3(wp.xz × WET_PUDDLE_CLOUD_SCALE, 7.3)) // 常数 z 偏移 ⇒ 与积水噪声不相关
skyMul  = 1.0 + (cloud × WET_PUDDLE_CLOUD × puddle × topGate)       // 只调制水汪，且只抬不压过 1±amp
skyEnv  = mix(horizon, zenith, smoothstep(bandLo, bandHi, R.y)) × skyDim × skyMul
```

⚠️ `reflK_film` 仍受 `WET_REFL_MAX = 0.55` 钳制（**不动它**）；只有积水项能超过 0.55。
⚠️ `topGate` 是**必须的**：没有它，墙面 `puddleAllowed` 对 POLISHED/STONE/METAL/ICE
仍分别是 1.0/0.896/1.0/1.0（实测），水汪镜面会爬上墙 ⇒ 光晕缺陷复活。
⚠️ 云影噪声的 z 取 **7.3**（非零常数）：与积水噪声（z=0）在同一 perlin 场上不相关，
否则水汪边界与云影边界会重合，看起来像「每摊水自带一个亮斑」。
⚠️ `skyMul` 上界 1.25 ⇒ `skyEnv` 线性 luma 最大 0.6911，配 reflK 0.70
⇒ 全组合最大线性 luma **0.5664**（sRGB 198.3）⇒ 不会过曝（Tier 4 用例③仍守）。

### 5.3 新增 uniform：`uWetPuddleMirror`

`uniform(WET_PUDDLE_MIRROR)` —— **不是为了运行时调参**，而是给 Tier 4 一个
**只差一个变量**的 A/B 锚点：写 0 ⇒ 积水项退化成 `mix(filmK, 0, puddle)`…
⚠️ 那样会让水汪**变暗**而不是回到水膜。故 A/B 锚点的正确做法是
**把 `puddle` 的镜面混合因子置 0**，即 `uWetPuddleRefl`（0 = 积水不反光，逐位回到 v3.31）：

```
uWetPuddleRefl : uniform(1)      // 积水镜面反光的开关强度（0 ⇒ 逐位等于 v3.31）
reflK = mix(reflK_film, mirrorK, puddle × topGate × uWetPuddleRefl)
skyMul = 1 + cloud × CLOUD × puddle × topGate × uWetPuddleRefl
```

⇒ `uWetPuddleRefl = 0` 时两行都退化回 v3.31 的原式（**第二级零回归锚点**，
与既有 `uWet = 0` 的第一级锚点并列）。Tier 4 的正/负向对照全部走它，不改几何、不重 mesh。

### 5.4 CPU 同构纯函数（`wet-surface-config.js`，Tier 1 可测）

- `wetPuddleMirrorK(cls, puddle, wet, up, reflStrength)` → 积水镜面目标（含 topGate）
- `wetPuddleReflK(noV, cls, up, puddle, wet, reflStrength)` → 最终 reflK（水膜与积水的 mix）
- `wetPuddleSkyMul(cloud, puddle, up, reflStrength)` → `1 + cloud×CLOUD×puddle×topGate×strength`
  （`cloud ∈ [−1,1]`，与 `mx_noise_float` 原始值域一致）

## 6. 已知近似

1. 水汪反的仍是**程序化天空**（加云影层次），不映旁边的建筑 —— v3.31 用户裁定不变。
2. 正午 `sky == fogColor` ⇒ 水汪里的「天空」底色单一，层次全靠云影调制（§2.4）。
3. 云影是**静态**的（无 `uTime`）—— 与 v3.31「湿表面无动画」一致。

## 7. 文件清单

**修改（4 个源文件 + 3 个测试 + 3 份文档）**

| 路径 | 改什么 |
|---|---|
| `src/render/wet-surface-config.js` | 加 3 个常量 + 3 个纯函数；`WET_REFL_MAX`/`FLOOR`/`SUN_SPEC`/噪声阈值**一律不动** |
| `src/render/wet-surface.js` | 加 `uWetPuddleRefl` uniform；`reflK` 改为两层 mix；`skyEnv` 乘 `skyMul` |
| `src/tests/test-wet-surface.js` | 新增 Tier 1 用例（见 §8.1） |
| `tests/wet-surface.spec.mjs` | 新增用例⑦⑧ + 负向③；重标受影响的用例②（见 §8.2） |
| `docs/roadmap.md` | 新增 v3.32 行 |
| `docs/pitfalls.md` | 新增「specGain 钳位使积水乘数恒等」节 |
| `docs/superpowers/specs/2026-11-22-wet-surface-rebuild-design.md` | 末尾加一行指向本稿 |

**不动**：`blocks-data.js`、`block-registry.js`、`mesher.js`、`materials.js`、`daynight.js`、
`game.js`、`wet-material-data.js`、雨的全部、`tools/test-tiers.mjs`（无新增文件 ⇒ 注册不变）。

⇒ **零新增文件、零方块改动、零指纹变化、零顶点字节增量、无新 pass**。

## 8. 验证口径

### 8.1 Tier 1（`src/tests/test-wet-surface.js` 追加）

1. `wetPuddleMirrorK`：顶面 ∧ puddle>0 ⇒ >0；**侧面/底面恒 0**；`reflStrength=0` ⇒ 0。
2. `wetPuddleReflK`：`reflStrength=0` ⇒ **逐位等于 `wetReflK`**（第二级零回归锚点）；
   `puddle=0` ⇒ 同样逐位等于 `wetReflK`。
3. 积水 reflK **全组合扫描**（9 类 × 3 朝向 × 5 puddle × 5 noV = 675 组）∈ [0, 1]，
   且顶面积水 > 同条件水膜（抛光/石/木/土四类）。
4. `wetPuddleSkyMul`：`reflStrength=0` 或 `puddle=0` 或非顶面 ⇒ **恒 1**；
   值域 ⊂ [1−CLOUD, 1+CLOUD]；cloud 单调。
5. **量级带**（真实 p=0.7682、noV=0.53、atlas 基色）：抛光 Δluma ∈ **[12,28]**，
   布 |Δ| < 3，且抛光 Δ > 石 Δ > 木 Δ > 土 Δ。
6. **墙面零回归**：`up=0` 时任意 puddle 的 reflK 与 v3.31 的 `wetReflK` **逐位相同**。
7. **既有常量未被偷偷放宽**：`WET_REFL_MAX === 0.55`、`WET_REFL_FLOOR === 0.28`、
   `WET_SUN_SPEC === 0.22`、`WET_PUDDLE_FROM/TO === 0.52/0.76`。
8. `uWetPuddleRefl` 句柄初值 **1**，且 `uWet` 初值仍 **0**。

### 8.2 Tier 4（`tests/wet-surface.spec.mjs`）

沿用既有夹具与冻结口径（`?vd=4&seed=12345&skybox=0&weather=clear`、`noon`、
藏 HUD/海面/雨丝、`physics.step=()=>{}`、`setAnimationLoop(null)`、等 `slotMap.size` 稳定）。

| # | 用例 | 判据 |
|---|---|---|
| ⑦ | **积水真的反光** | 抛光石地面，单变量 `uWetPuddleRefl` 1↔0。地面区**变亮**像素占比 > 0.05 且 Δluma > +2；同时云/墙区 \|Δluma\| < 1 |
| ⑧ | **水汪内有明暗层次** | 水汪像素（`puddle` 掩码 > 0.3 的屏幕投影区）的 luma 标准差显著大于同区水膜；用「效应层自身的空间方差」判，不用绝对阈值 |
| ②′ | 材质分层（重标） | 既有口径不变（darken 固定 1、只改 `uWetParams`），但**新增一条**：积水档下抛光 − 布的差必须比水膜档更大 |
| ③′ | 不过曝（沿用） | 开档后 `luma≥250` 占比 ≤ 关档 + 0.005（`skyMul` 上界 1.25 的实测防线） |
| ⑤′ | 关闭零回归（沿用） | `uWet` 1→0 与基线**逐位相同**（diffBytes = 0） |
| ⑨ | **第二级零回归** | `uWetPuddleRefl` 1→0 与「v3.31 行为」对照：用 `page.route` 换回旧 `wet-surface.js` 不现实 ⇒ 改为**同 page 内** `uWetPuddleRefl=0` 两次取样逐位相同，且与 `uWet=1` 的差分只落在地面区 |
| 负向③ | 把 `topGate` 去掉 | `page.route` 换 `wet-surface.js`（goto 之前注册）⇒ 用例⑦的「墙区 \|Δ\|<1」必须 FAIL |

⚠️ 注入后读回**代码行**确认落地（jsdoc 里有同串公式 ⇒ 全文件 includes 恒真，v3.31 已踩）；
还原用 `cp` 副本，**不用 `git checkout`**。

### 8.3 回归集合（最小充分集）

改动只碰 `wet-surface-config.js` / `wet-surface.js` 两个模块 + 两个测试文件。
消费方由 grep 确定：`materials.js`（装配）→ 三通道渲染 spec。

```
npm run check
node tools/run-unit-node.mjs --only=test-wet-surface.js,test-storm-rain.js,test-daynight.js
npx playwright test tests/wet-surface.spec.mjs tests/storm-lighting.spec.mjs \
  tests/storm-underwater.spec.mjs tests/carbine-flash-wet.spec.mjs tests/water-visual.spec.mjs
npm run bench -- --check
```

**不跑 `npm test`**：无新增文件、`src/tests/index.html` 与 `tools/test-tiers.mjs` 注册不变
⇒ 不命中 AGENTS.md 的「全局基础设施」条款。

### 8.4 冻结数字（不符就停下报告）

- `registry.fingerprint()` 逐位不变（不碰方块）。
- `gpuVertexBytes` **193.83 MiB**（零新增属性）。
- `packed` 全部位段逐位不变（不碰 mesher）。
- 既有 8 条 wet-surface 用例的判据**不放宽**；用例②只**追加**一条，原断言不动。
- 水面冻结色阶（`water-visual`）不动。

## 9. 留给实施者

- 云影噪声用 `mx_noise_float`（与积水同一函数，z=7.3），**1 层**先试；
  若用例⑧的方差判据不足再加第 2 层（不要一上来就叠）。
- `WET_PUDDLE_CLOUD_SCALE = 0.09` 是初值：若屏幕上云影斑块比水汪还小，抬到 0.06。
- 三个常量的绝对值可调，**关系式与目标带是判据**（同 v3.31 §10 口径）。