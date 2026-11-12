# 水下视觉与大气逆光（v2.95 设计）

> 状态：待审阅 ｜ 2026-11-12 ｜ 来源：`/Users/bachi/ttt/mc/光影` 四套着色器包的对比分析
> 上游参考：Complementary v4.4 `lib/atmospherics/waterFog.glsl`、`lib/atmospherics/sunGlare.glsl`、
> `lib/atmospherics/fog.glsl`、`shaders/gbuffers_water.glsl`、`shaders/lib/color/waterColor.glsl`

## 1. 要解决什么问题

本仓的水下状态**只有物理效果、没有视觉表达**：

- `physics.js:237` 每帧算 `inWater`（只影响重力、上浮、速度、阻力）；
- 相机进水后看到的是**与陆地完全一样的世界**——同样的雾距、同样的天光、同样的色温；
- 水面平面（`ocean.js`）在水平面处绘出，水下向上看时它是一层半透明膜，**不成"水面对视线的总遮蔽"**；
- 天空盒（`sky.js` 的 `backgroundNode`）不经过任何水下处理 → 水下抬头看见晴朗天空。

对比上游：四套包都把「入水」当作一个**全局视觉状态**处理（`isEyeInWater`），它一次性改变
雾色、雾距、天光、焦散、体积光。本仓缺的是这个全局状态本身。

第二条是**大气逆光**：本仓的雾色已经能按视线方向采样天空盒（v1.59），但没有「朝太阳方向」
这一维度——太阳附近的天边与其他方位是同一种雾色，缺一层大气透视的暖化。

**明确不做**（已与本轮分析一起排除，勿在实现时"顺手补"）：
泛光/bloom、接触阴影、HBAO、体积光轴、彩色阴影、法线贴图、光谱大气、水下焦散。

## 2. 用户裁定（2026-11-12）

| 决策点 | 裁定 | 含义 |
|---|---|---|
| 压色强度 | **中等，能见度 ≈ 25 格** | 蓝绿压色明显、天光可辨；远景轮廓消失但方向感保留 |
| 与日夜的关系 | **乘法耦合** | 水下雾色 = 水面雾色（已随 skyDim/曝光变化）× 水下色相。夜里潜水是真的暗 |
| 用户开关 | **水下独立开关**（2026-11-12 修订） | `?underwater=0`；**不再复用「雾色」** —— 原裁定与 §9.2 数学上互斥，见 DR-7 |
| 眩光可见性 | **不挂钩遮拦** | 语义是"大气透视"而非"太阳光晕"；零 shadow map 采样 |

## 3. 架构决定

### DR-1：水下是「雾的颜色 + 雾的距离」的整体替换，不是新增一层染色

上游的做法（`gbuffers_water.glsl:476` 起）是 `isEyeInWater == 1` 时给 `underwaterColor`
与 `underwaterFog` 各一个分支。本仓**照这个语义**，但要守住红线 1（数据只有一份权威）：

```
fogColor_final = mix(surfaceFogColor, underwaterFogColor, uUnderwaterMix)
fogNear_final  = mix(fogNear_surface,   underwaterNear,     uUnderwaterMix)
fogFar_final   = mix(fogFar_surface,    underwaterFar,      uUnderwaterMix)
```

`uUnderwaterMix ∈ [0,1]` 是唯一的全局水下因子。三条都用同一个因子、同一个 `mix` 嵌套层级，
**不得**给某一条单独写 `if`——否则会出现"雾色换了但雾距没换"的撕裂，而这类撕裂没有断言之外的
可观测异常（同 `materials.js` 里阴影两层 `mix` 的教训）。

### DR-2：水下因子是 CPU 侧的一个 uniform，不进着色器

判据在 CPU 已经有了，而且是**物理的唯一权威**：

```
underwater = physics.inWater && ((pos.y + EYE_HEIGHT) < SEA_Y + 0.5 + EYE_SUBMERGE_LAG)
```

- `physics.inWater` 已在 `physics.js:237` 每帧更新（用 `blockId === water`），**且已扣除**
  “身体中段在水里”这一判定（读的是 `pos.y + 0.5`）；
- 眼睛位置 = `pos.y + EYE_HEIGHT`（`player.js:375` 的相机公式，即**相机实际高度**）；
- `EYE_SUBMERGE_LAG` 是**在水面**之上的余量：眼睛还没真正潜到水面以下时就开始过渡，
  避免“贴水面游泳”时每帧翻转（观感是画面闪）。取正值 = 提前入水。
- `SEA_Y + 0.5` 是水面平面的世界高度（`ocean.js:WATER_LEVEL_OFFSET`，权威在 `voxel/constants.js` 的
  `SEA_Y`）。

⚠️ **不能用 `physics.inWater` 单独判**：它读的是身体中段，玩家站在浅水里（水只到脚脖）时
`inWater` 为真但眼睛在水面上 —→ 画面会错误地整片变蓝。
⚠️ **不能用片元的 `positionWorld.y` 判**：那是片元位置，水下时远处的山仍在水面以上，
会让“水下看山”与“水面以上看山”配色不同 —— 上游用 `isEyeInWater`（相机状态）正是这个道理。
⚠️ 本式有两套“水面高度”口径：`physics` 的 `pos.y + 0.5` 与这里的 `EYE_HEIGHT`。前者是
**物理权限**、后者是**视觉权限**，不得合并（否则浅水陆地面变蓝）。

### DR-3：雾距改由 uniform 驱动，形状不变

现状 `setupFog` 里 `fogNear/fogFar` 已经是 uniform（`materials.js:296-297`），但
`rangeFogFactor(fogNear, fogFar)` 的形状（线性 `smoothstep`）是固定的。

水下需要**指数雾**才像水（上游 `fog.glsl` 用 `1 - exp(-6·f^8)`）。但换成指数雾会改变
**陆地**的雾观感——那是零回归红线。

**取舍**：水下不换雾形状，只换距离。`rangeFogFactor` 在 `near≈0 / far≈25` 时与指数雾的差别
在 `t=0.5` 处约 0.08（sRGB 后不可辨），而"换形状"需要引入 `densityFogFactor` 的第二条路径
+ 一个 `mix` 选择器，收益（一点点更像水）与成本（两条雾路径各自漂移）不成比例。

> 若实测发现线性雾在水下"太软"，处置是**改 `underwaterFar` 的单次标定**，
> **不得**新增第二条雾公式（同 v1.70「同一个观感特征不得由两个旋钮重复表达」）。

### DR-4：水下色相从水面雾色派生，不新增色相权威

```
underwaterColor = uWaterFogColor（ocean.js 已有） × WATER_UNDERWATER_TINT
```

- `uWaterFogColor` 已存在（`ocean.js` 的 `WATER_FOG_COLOR = 0x6b9cc0`，v1.85 标定值）；
  ⚠️ 但它**当前是 ocean.js 的模块私有常量**，没有以 uniform 形式暴露 —— 本设计需把它
  `uniform` 化并从 `setupOcean()` 返回，或者把 `WATER_FOG_COLOR` 提到
  `underwater-config.js` 供两边 import（**二选一，不得两处落字面量**）。
- `WATER_UNDERWATER_TINT` 是一个**相对乘数**（`vec3`，均值 ≈1），与 `daynight.js` 的
  `waterTint` / `sunColor` / `ambientColor` 同一语义族——只改色相与相对亮度，不改总曝光；
- 这样"水面雾色"与"水下雾色"永远同色系，不会漂出「水上灰蓝、水下紫绿」的撕裂。

⚠️ **不新增第二个色相常量**：如果实现时发现需要单独定水下的基色，那说明 DR-4 的派生口径不够用，
应当先回到本设计讨论，而不是加一个字面量（红线 1）。

### DR-5：逆光眩光是「朝太阳方向的暖化」，乘在雾色上，不乘在片元色上

上游 `sunGlare.glsl` 全文（28 行）的核心：

```
e = max(dot(viewDir, sunDir), 0)
glare = vis/(1 - (1-vis)·e⁸) - vis        // vis = 0.075
glare *= e * strength
```

本仓的移植区别（用户裁定"不挂钩遮拦"）：

- **去掉 `sunVisibility` 项**（那一项在上游来自 shadow map，本仓雾节点里没有 shadow 节点）；
- 系数从上游的 `0.25 × SUN_GLARE_STRENGTH` 压到 **0.08 量级**——语义从"太阳光晕"降级为
  "大气透视"。物理上成立：大气散射与遮挡无关，隔着墙朝太阳方向的天边本来就更暖。

**乘在哪一侧是载荷性的**：必须乘在**雾色**上（与上游 `fog.glsl` 里
`SunGlare(GetSkyColor(...))` 同位置），**不得**乘在最终片元色上。乘在片元色上会变成
"整个屏幕按视线方向加亮"——那是 screen-space 光晕，且会让阴影区发亮（影子里的墙面被暖化）。

```
skyColor += glareStrength × glare × e × uSunColor
```

用 `uSunColor`（已有 uniform）而不是新常量，保证逆光暖化与直射光色温永远同源。

### DR-6：天空盒在相机入水时整体压色

`sky.js` 的 `backgroundNode` 不经过 `setupFog`（背景是独立绘制），所以水下抬头仍看见晴天。

修法：`uUnderwaterMix` 由 **`materials.js` 模块顶层导出**（与 `uSkyDim` / `uShadowStrength`
同一口径），`sky.js` **直接 import 同一个实例**，给 `backgroundNode` 末尾乘
`mix(vec3(1), UNDERWATER_SKY_TINT, uUnderwaterMix)`。`setupSky` 的签名**不变**。

⚠️ **两个模块必须共用一个 uniform 实例**，不得各建一份：各写一份混合因子会漂移出
"雾已变蓝、天空还是晴天"的撕裂，而这类撕裂**没有断言之外的可观测异常**
（与 `uNightBlend` 在背景与雾色两处共用同一实例同一教训）。
⚠️ **模块导入不构成环**：`materials.js` 不 import `sky.js`（已核）。
✅ 这个方案的一个附带好处：`game.js` 的装配顺序**不需要改**（`setupSky` 仍在 `setupFog` 之前
`await`，模块级 uniform 在两次调用之前就已存在）。

### DR-7：水下与眩光各自一个独立开关，**不受「雾色」开关管辖**

> **2026-11-12 修订（用户裁定）**：初稿写「复用雾色开关」，实测证明它与 §9.2 的
> 「`?skybox=0` 时水下雾仍生效」**数学上互斥**，已改为独立开关。

**为什么不能复用雾色开关（实测结论，勿再改回）**：

1. 「把水下 `mix` 叠在 `uFogColorMix` 合并结果之后」**并不能**让开关生效。实测：
   ```
   c1 = mix(fallback=100, sky=200, uFogColorMix=0) = 100
   c2 = mix(c1=100, underwater=30, uUnderwaterMix=1) = 30   ← 仍然压色
   ```
   第二层 `mix` 的插值因子与第一层无关，嵌套顺序不产生门控。要靠顺序实现开关是错的。
2. 真要用雾色开关管辖，唯一写法是 **CPU 侧相乘门控**
   （`effective = uUnderwaterMix × uFogColorMix`）。但 `game.setFogColorEnabled()` 在
   `this.sky === null` 时**强制** `uFogColorMix = 0`（`game.js:1587`，既有行为，防采样未绑定
   立方图导致全黑雾）⇒ `?skybox=0` 时门控恒 0 ⇒ **水下永不生效**，与 §9.2 直接冲突。

**因此本设计的口径**：

- 水下由 `?underwater=0|1` 独立控制（默认开），与 `uFogColorMix` **无关**；
- 眩光由 `?glare=0|1` 独立控制（默认开）；
- 两个开关都经 `DayNight` 的类字段 → `_apply` 收口，**不得**在 `game.js` 里直写 uniform
  （每帧被 `_apply` 覆写 → 下一帧静默失效，同 `shadowEnabled` 的历史教训）。

⚠️ **`?fog=0` 时水下仍会压色，这是正确行为**，不是缺陷。Tier 4 必须按这个口径断言
（初稿的「`?fog=0` 兼底水下不压色」用例**必须删除**，它钉的是错的行为）。

### DR-8：水下与眩光的节点必须放在 `if (sky)` **之外**

`setupFog` 的现状是 `let colorNode = fogColor;` 在 `if (sky)` **外**，而所有天空采样与
`colorNode` 的重新赋值都在 `if (sky)` **内**。因此：

- **水下两条 `mix`（雾色 + 雾距）必须写在 `if (sky)` 块结束之后**，否则 `?skybox=0` 时
  整段被跳过 → 水下完全无效果（而 `uUnderwaterMix` 的值仍然是 1，**计数类判据全对**）。
- **眩光项只能留在 `if (sky)` 内**（它需要 `dir` 与立方图采样）—— `?skybox=0` 时眩光
  不生效是**有意降级**，写进验收报告。

⚠️ 这两条的失效形态都是静默的：uniform 值对、单测全绿、只有真实画面的降级路径能看出。

## 4. 改动清单

| 文件 | 改动 | 归属 |
|---|---|---|
| `src/render/underwater-config.js` | **新增**（three-free 纯数据 + 纯函数）：`WATER_UNDERWATER_TINT` / `UNDERWATER_FOG_NEAR` / `UNDERWATER_FOG_FAR` / `GLARE_VISFACTOR` / `GLARE_STRENGTH` / `EYE_SUBMERGE_LAG` / `WATER_FOG_COLOR`（从 `ocean.js` 提上来）/ `EYE_HEIGHT`（从 `player.js` 提上来）/ `isUnderwater()` | 纯函数层，可单测 |
| `src/voxel/constants.js` | 不动（`SEA_Y` 已是权威，新模块 import 它） | — |
| `src/render/ocean.js` | `WATER_FOG_COLOR` 改为从 `underwater-config.js` import（红线 1：只一份字面量）；新增 `uWaterFogColor` uniform 句柄并返回 | 色相权威 |
| `src/player/player.js` | `EYE_HEIGHT` 改为从 `underwater-config.js` import（唯一权威两个消费方） | 常量提级 |
| `src/render/materials.js` | 模块顶层新增并导出 `uUnderwaterMix` / `uGlareStrength` / `uUnderwaterColor`；`setupFog` 里加 DR-1 的三条 `mix` + DR-5 的 glare 项；句柄表加这两个 uniform | 消费方 |
| `src/render/sky.js` | `import { uUnderwaterMix }`；`backgroundNode` 末尾乘 DR-6 的 tint（**签名不变**） | 消费方 |
| `src/render/daynight.js` | `_writeUnderwaterUniforms()` 唯一公式；`_apply` 与 `setUnderwater`（值变化时）各调一次（§9.7）；`setUnderwater(on)` / `glareEnabled` / `underwaterDisabled` 字段 | 收口点 |
| `src/ui/settings.js` | 新增 URL 参数 `?underwater=0` / `?glare=0`（**不进面板、不持久化**，仅供 Tier 4 做单变量 A/B） | URL 开关 |
| `src/core/game.js` | 帧循环里推进 `isUnderwater()` → `dayNight.setUnderwater(...)`；`start()` 尾部消费 `?underwater` / `?glare` | 装配层 |

**为什么 `underwater-config.js` 要单独成文件**：`isUnderwater` 是 Tier 1 判据（纯函数、
可确定性单测），而 `materials.js` 依赖 three、无法在浏览器单测里直接跑。这与
`sun-shade.js` / `hemi-shade.js` / `ocean-mask.js` 的既有拆分口径**完全一致**（三位前例）。

## 5. 零回归不变式（单测钉住）

1. `uUnderwaterMix = 0` 时，雾色/雾距**逐位**回到 v2.94 —— 三条 `mix` 在 `t=0` 取左端；
2. `uUnderwaterMix = 0` 时，glare 项必须**恒等 0**：注意 `glare = vis/(1-(1-vis)e⁸) - vis`
   在 `e=0` 时确实为 0，但**不得依赖这个巧合**。
3. **两条效果各自一个独立开关**：`uUnderwaterMix` 与 `uGlareStrength` 必须能分别置 0
   （否则"关水下≠关眩光"，两条效果耦合在一起就无法做单变量 A/B）。
   ⚠️ **两者的模块初值都是 0**（与 `uFogColorMix` 同口径），但**运行时由 `_apply` 每帧
   写成生效值**（`GLARE_STRENGTH` / 水下时为 1）—— 初值 0 只保证「`_apply` 未跑过的首帧
   不引入新效果」，**不是**零回归的保证。零回归靠 Tier 4 的 A/B（两个开关置 0 后与
   v2.94 截图比对）。初稿写的「运行时初值都是生效值」误导，已改正。
4. **`?fog=0` 时水下仍压色**（DR-7 修订后的正确行为）；`?underwater=0` 时才不压色。
   两者是独立自由度，不得互相推导。
5. `night` 风格 + 水下：亮度必须**同时**钉上下界——只钉"变暗"抓不到"纯黑"（v1.45 教训）。

## 6. 测试分级（`docs/testing-policy.md`）

| 级别 | 覆盖 | 判据 |
|---|---|---|
| **Tier 1**（必须 TDD） | `isUnderwater()` 纯函数：水面上下、眼部余量、浅水（`inWater=true` 但眼睛在水面上）、深层 | `src/tests/test-underwater-config.js`，注册进 `src/tests/index.html`（漏注册 = 静默不跑） |
| **Tier 1** | 常量关系：`UNDERWATER_FOG_FAR < (vd+2)*16*0.95`、`tint` 均值 ≈1、`EYE_SUBMERGE_LAG > 0` | 同上 |
| **Tier 2** | `check:data` 无需改动（无烘焙产物、无图标、无新方块） | — |
| **Tier 4**（GPU 求值，必须像素实测） | 入水/出水交替各 3 轮、同机位、五变量冻结；**另有 `?underwater=0` 与 `?skybox=0` 两条降级路径用例** | 水区亮度**分带**（近/中/远）、`R−B` 色相、绝对亮度上下界 |
| **门禁** | `npm run check` + `npm test` + `npm run bench -- --check`（片元增量须在噪声内） | — |

⚠️ **不得写 `?fog=0` 时水下不压色的用例**（DR-7 修订：那是错的行为）。
⚠️ **Tier 4 不得只用 `?style=noon`**：`DayNight.update()` 在 `_styleOverride` 非空时
**early-return**（`daynight.js:412`）⇒ `_apply` 不跑 ⇒ 水下 uniform 永不更新。实测：
`style=null → uUnderwaterMix=1`（OK）而 `style=noon → 0`（静默失效）。
处置见 §9.7。

**Tier 4 必须带的对照组**：同一机位在陆地上的读数。判据型态照 v2.89 的废弃堡垒教训——
「水色」判定要有对照组校准，否则"只是沙漠/只是雾"也会命中。

## 7. 已知残留（写进验收报告，不在本次修）

1. **实体不压色**：丧尸 / 焰魔 / 守卫 / 矿车 / 炮塔 / 视图武器各有独立材质，不走 voxel 材质
   → 水下挡不住它们的颜色。深海/湖底本来没有这些实体，可接受。
2. **天空盒与水下的时差**：`uUnderwaterMix` 是**模块级同一实例**，雾与天空同步翻转 ——
   不会出现"雾已变蓝、天空还是晴天"的中间态。但天空盒只能整体乘一个常量 tint，不随
   日夜变化：夜里的水下天空会偏亮于水下雾。若实测可见，处置是在 tint 里乘 `mix(1, skyDim, ...)`，
   属独立改动。
3. **水面过渡带**：`EYE_SUBMERGE_LAG` 是一个固定偏移，不是滞回区间——如果实测发现贴水面时
   仍会翻转，处置是改成区间（上阈/下阈）并给 Tier 1 补用例，而不是调参。

## 8. 待实测标定的数字（本设计只定口径，不定值）

| 常量 | 初值来源 | 标定方法 |
|---|---|---|
| `UNDERWATER_FOG_NEAR` / `_FAR` | 上游 `waterFog` 的能见度档 + 用户裁定的 25 格 | Tier 4 分带扫描，取"远景轮廓消失但方向感在"的交点 |
| `WATER_UNDERWATER_TINT` | 水面雾色 `0x6b9cc0` 的色相延伸 | 钉 `B − G` 与 `G − R` 的符号（与水面色一致），不钉绝对值 |
| `GLARE_VISFACTOR` | 上游 0.075 | 逐档截图，取"能看出暖化但不糊" |
| `GLARE_STRENGTH` | 0.08（上游 0.25 的降级） | 同上；必须同时验"影区不发光" |
| `EYE_SUBMERGE_LAG` | 0.15 格 | 贴水面潜游 30s，验证不翻转 |

## 9. 已定与待定

**已定（写进实现）**：

1. **`uUnderwaterMix` / `uGlareStrength` / `uUnderwaterColor` 的创建位置 = `materials.js`
   **模块顶层导出**（与 `uSkyDim` / `uBlockBoost` / `uShadowStrength` / `uSunColor` 完全同口径）。
   这是本设计相对初稿的**修正**：初稿打算在 `setupFog()` 内创建并当作参数传给 `setupSky`，
   但那会被迫调整 `game.js` 的启动时序（`setupSky` 目前先于 `setupFog` 且是 `await`），
   而模块级导出既不用改签名也不动装配顺序。
2. **接线路径**：
   - `sky.js` → 直接 `import { uUnderwaterMix } from './materials.js'`；
   - 材质侧 → 句柄表 `createVoxelMaterials().dayNight` 新增 `uUnderwaterMix` / `uGlareStrength`；
   - `DayNight` → 经**已有的** `voxelUniforms` 通道消费（`game.js:425` 传的就是该句柄表），
     **不需要新构造参数**。
   ⚠️ `?skybox=0` 时 `this.sky === null` → 天空盒分支不存在，但**水下两条 mix 写在
   `if (sky)` 之外**（DR-8）→ 水下雾依然生效（只是天空不变色、眩光不生效）。
   这是 DR-7 修订后才成立的：若水下受 `uFogColorMix` 门控，这条降级就不可能实现。
3. `physics.pos.y` 是**脚底**（`player.js:375` 的 `camY = p.y + EYE_HEIGHT` 推出）：
   脚底在水面下**不等于**眼睛在水下。水下判据必须用 `pos.y + EYE_HEIGHT` 口径，
   不能用 `pos.y`。`EYE_HEIGHT = 1.62` 当前是 `player.js` 的模块私有常量 ——
   本设计随之把它提到 `underwater-config.js`，`player.js` 改为 import（**单一权威**）。
   ⚠️ **循环依赖检查（已核）**：`underwater-config.js` 只 import `voxel/constants.js` 的 `SEA_Y`
   （无消费方依赖）→ `player.js` 从它 import 不构成环。
4. `uGlareStrength` **不加设置项**（与 DR-7 同一取向：默认开、无面板入口、
   可用 `?glare=0` 做 A/B）。若后续要开关，走独立改动。
5. **雾距是每帧写入的，所以 `_apply` 每帧跑不成问题**：`DayNight.update()` 本来就每帧调
   `_apply`（`daynight.js:419`），所以 `uUnderwaterMix` 不需要单独一条写入路径；
   `setUnderwater(on)` 只存一个布尔字段，真正的 uniform 写入仍然在 `_apply` 里 —— 这与
   `shadowEnabled` 的既有口径**完全一致**（标志存类字段、`_apply` 读它），不新增第二条写入路径。
6. `underwater-config.js` **只导出常量与 `isUnderwater()`**，不导出 `fogFor()` ——
   Tier 1 的零回归断言直接对 `isUnderwater()` 与常量关系（`UNDERWATER_FOG_FAR < fogFar`）
   下断言，不复制 `setupFog` 的公式（避免第三份公式）。
7. **`_styleOverride` 下必须仍能写水下 uniform**（实测发现的阻断级缺陷）：
   `DayNight.update(dt)` 开头就是 `if (this._styleOverride) return;`，而面板选了任何风格
   （含 `?style=noon`）后 `_styleOverride` 非空 ⇒ `_apply` **每帧不跑** ⇒ 水下/眩光永不生效。
   **处置**：`setUnderwater(on)` 在值**发生变化**时直接调一次写入（仅这两个 uniform，
   不重算整套风格参数）；`_apply` 里的那份保留，两条路径共用同一个私有方法
   `_writeUnderwaterUniforms()`（唯一公式，红线 1）。
   ⚠️ 这不是「第二条写入路径」—— 公式仍只有一份，只是多了一个调用时机（同 `setStyle`
   与 `update` 都调 `_apply` 的既有口径）。

**已知降级（写进验收报告）**：`?skybox=0` 时眩光不生效 —— 眩光项挂在 `setupFog` 的
`if (sky)` 分支内（没有立方图就没有方向感来源）。水下雾不受影响。
