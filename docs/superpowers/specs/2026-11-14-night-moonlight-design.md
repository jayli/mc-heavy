# 夜间月光照耀（v3.00 设计）

> 状态：待审阅 ｜ 2026-11-14 ｜ 分支：`feat/moonlight`
> 上游参考：mc-lite `Engine.js:74/99/122`（各风格 `sunDirection` / `moonDirection` 原值）

## 1. 要解决什么问题

夜里的**光照方向**与**月亮位置**互相矛盾。

实测（归一化后，`paramsAtHour`）：

| 量 | 值 | 仰角 | 方位 |
|---|---|---|---|
| `night.sunDirection` | `[0.0804, 0.2512, 0.9646]` | 14.5° | +5° |
| `night.moonDirection` | `[-0.3198, 0.5796, -0.7495]` | 35.4° | −157° |

两者夹角 **127°**（dot = −0.6031）。

后果：体素材质的 N·L 方向光（`materials.js` 的 `uSunDirection`）用的是 `sunDirection`
→ 夜间迎光面朝**南偏东**，而画面上月轮挂在**北偏西**。用户观感是"月亮在那边，亮面在这边"。

**为什么不是"夜里没有光照"**：夜里方向光其实一直在工作，`skyDim 0.25` 只是把 skylight
整体压到 1/4，2.63× 的朝向对比结构仍然存在（六面亮度 +Z 157 / 底面 82）。缺的不是亮度，
是**方向与月亮的语义一致性**，以及**色温**（当前夜间 `sunColor` 是中性白，不像月光）。

## 2. 用户裁定（2026-11-14）

| 决策点 | 裁定 | 含义 |
|---|---|---|
| 实现路径 | **方案 A：改月亮位置对齐太阳** | 不动 `sunDirection`（mc-lite 可溯源原值），只让月轮搬到光照方向那侧 |
| 月光形态 | **方向对准月亮 + 冷色** | 明暗关系与色温都变，不做"整体 tint" |
| 生效范围 | **仅 night 风格** | 白天/正午/傍晚的光照逐位不变 |
| 亮度目标 | **保持现状亮度，只换方向与色相** | 六面平均亮度漂移 < 1% |
| 月亮高度 | **保持 14.5°（低挂）** | 不改 `sunDirection`，接受月亮贴近地平线 |
| 水面高光 | **本轮不接** | `ocean.js` 的 `uSunDirection` 缺口单独处理，见 §7 |

## 3. 架构决定

### DR-1：改 `moonDirection`，一个字节不动 `sunDirection`

`sunDirection` 有三个既有消费者，改它会连带破坏：

1. `game.js:_updateSunPosition()` —— 阴影灯定位（`position = 玩家 + sunDirection × 60`）；
2. `DayNight._apply()` 写入的 `sunLight.color` —— 枪的 PBR 高光方向；
3. `__MC_GAME__.dayNight.params.sunDirection` —— `sun-shadow.spec` / `hemisphere-ambient.spec`
   / `dusk-style.spec` 直接读它做断言的接线口径。

而 `moonDirection` 只有两个消费者，且都不参与光照：

- `sky.js:placeCelestial()` —— 月轮 sprite 的世界位置；
- `skybox.spec.mjs` —— 只断言 `moonSprite.visible`。

**故改 `moonDirection` 是零光照风险的路径。** 反过来改 `sunDirection` 要重标定夜间六面亮度、
阴影方向、以及现有"night.sunDirection 是 mc-lite 原值"的断言（`test-daynight.js:81-85`）。

### DR-2：四个风格的 `moonDirection` 全部对齐，不是只改 night

**只改 night 会引入新缺陷**（实测，19:00→21:00 是 `moonVisible` 已为 true 但方向仍在
morning→night 之间插值的时段）：

| 小时 | 只改 night | 四风格一起改 |
|---|---|---|
| 19.00 | 仰角 26.7° 方位 −155°（尚不可见） | 仰角 26.6° 方位 +12° |
| 19.50 | 仰角 41.4° 方位 −144° | 仰角 23.7° 方位 +10° |
| 19.75 | 仰角 55.9° 方位 −125°（Δ 19°） | 平滑 |
| 20.00 | 仰角 64.4° 方位 −63°（**Δ 61.7°**） | 仰角 20.6° 方位 +8° |
| 20.50 | 仰角 30.0° 方位 −4°（Δ 46.1°） | 仰角 17.6° 方位 +6° |
| 21.00 | 仰角 14.5° 方位 +5° | 仰角 14.5° 方位 +5° |

只改 night 时，月亮在 2 小时内扫过天顶且单步方位跳 61.7° —— 肉眼可见的"月亮突然横穿天空"。
四个一起改则月亮永远沿太阳的既有平滑轨迹（**全程 dot = 1.000000**），且 morning/noon/dusk
的 `moonVisible` 本来就是 `false` → 视觉上零影响（只有 night 是 `true`）。

### DR-3：夜间 `sunColor` / `ambientColor` 改为冷色，整体亮度不变（±1%）

标定口径与 dusk（v1.71）一致 —— 色温是**相对乘数**，只改色相不改亮度：

```
night.sunColor     = [0.795, 0.954, 1.431]   // 均值 1.0600
night.ambientColor = [0.954, 1.018, 1.208]   // 均值 1.0600
```

⚠️ **均值是 1.060，不是 1.000** —— 这一点与 dusk（`sunColor` 均值 1.0333）不同，
必须说清楚否则实现者会「顺手归一到 1.000」而丢掉标定：

均值恰为 1.000 的同色相候选（`sun [0.75,0.90,1.35]` / `amb [0.90,0.96,1.14]`）实测
六面平均 luma 是 **97.14（−3.3%）**，不是 100.5。原因：ACES 在 +Z 迎光面（线性
`shade 1.13 × skyDim 0.25 × 曝光 1.6 = 0.45`）已进肩部，而 B 通道被抬到 1.44 后
**压缩率高于 R/G** ⇒ 冷色的亮度损失比「均值守 1」能补偿的更大。故整体乘 1.06 是
&quot;把 ACES 肩部吃掉的亮度补回来&quot;的标定值，不是「顺手调亮」。

**实测标定依据**（屏幕口径：`基色 0.5 × shade × skyDim 0.25 × 曝光 1.6 → ACES → sRGB`，
与 `sun-shade.js` 的 `srgbEncode`/`acesFilmic` 同一公式）：

| 指标 | 现状（中性白） | 改后 | 判据 |
|---|---|---|---|
| 六面平均 luma | 100.50 | **100.84** | 漂移 +0.3%（< 1% 目标） |
| 迎光面 +Z luma | 157.0 | 155.5 | 基本不变 |
| 背光面 −Z luma | 82.0 | 82.9 | 基本不变 |
| 迎光/背光比 | 1.91 | 1.87 | 保持 ≥ 1.8（朝向对比不得被抹平） |
| 迎光面 R−B | 0 | **−32** | < −12（屏幕口径"明显偏冷"） |
| 背光面 R−B | 0 | **−15** | < −8 |

`skyDim 0.25` / `toneMappingExposure 1.6` / `SHADOW_FLOOR 0.38` / `HEMI_GROUND 0.6` /
`SUN_INTENSITY` **全部不动** —— 这是"保持现状亮度"的落地定义。

### DR-4：夜间影子自动变成"月光投下的"，不新增阴影开销

阴影灯跟随 `sunDirection`（`_updateSunPosition`），而月亮现在与它同向 → 影子的方向天然
与月亮一致。`uShadowStrength = skyDim = 0.25` **不动** → 夜里有影子但很淡，且
`shadowScheduler` 的 200ms 节流与按键刷新路径完全不变。

**不**为月亮单独增加阴影强度或刷新频率 —— 那是用户明确否决的"再加月影"选项（§2）。

## 4. 改动清单

| 文件 | 改动 |
|---|---|
| `src/render/daynight.js` | 四个风格 `moonDirection` 改为与同风格 `sunDirection` 相同；`night.sunColor`/`ambientColor` 改冷色；`VISUAL_STYLES` 上方注释说明"月亮与光照方向同源"这条不变式 |
| `src/tests/test-daynight.js` | ① `test('三风格 moonDirection 是 mc-lite 原值…')` 改为断言 `moonDirection ≡ sunDirection`（四风格，dot=1）；② `dusk：三种既有风格的色温字段保持中性` 中 night 那一条改为冷色断言；③ `不变式：自动日夜循环全程 duskBlend=0` 里的 `sunColor 必须中性` 改为「morning 段中性 / night 段冷色」 |
| `src/tests/test-moonlight.js`（新增） | 纯函数层：四风格一致性、插值全程 dot=1、`paramsAtHour` 全天 moon∥sun、色温均值、冷色方向性 |
| `src/tests/index.html` | 注册 `test-moonlight.js`（`check:data` 的 `[测试注册]` 双向钉住） |
| `tests/moonlight.spec.mjs`（新增） | Tier 4：月轮方向与 `uSunDirection` 一致（几何）+ 夜间冷色（像素）+ 改 `moonDirection` 不动地面像素（隔离）+ 白天零回归 |
| `docs/roadmap.md` | 版本表加 v3.00 行 |

**不改**：`sun-shade.js` / `hemi-shade.js` / `materials.js` / `shadow-manager.js` /
`ocean.js` / `sky.js` / `game.js`（着色器与装配层零改动 —— 这是方案 A 的主要收益）。

## 5. 验证

### Tier 1（`src/tests/`，浏览器内单测）
- 四风格 `moonDirection` 与 `sunDirection` 归一化后完全相等（dot = 1 ± 1e-12）。
- `paramsAtHour(h)` 对 h ∈ [0,24) 每 0.125h 采样：`moonDirection ≡ sunDirection`（同一插值路径 → 天然成立，断言钉住"不许单风格改"）。
- `night.sunColor` / `ambientColor` 均值 ∈ [1.04, 1.08]（**不是 1.0** —— 见 DR-3，
  这是 ACES 肩部标定值）；`sunColor[2] > sunColor[0]`（偏冷）。
- 既有"方向在风格边界连续"用例继续通过（月亮现在跟太阳同轨迹，连续性自动继承）。

### Tier 4（`tests/moonlight.spec.mjs`，像素）

**先想清楚本轮到底改了什么**（这决定了判据能测什么）：
方案 A 不动 `uSunDirection`（它仍等于 `sunDirection`），所以**体素世界的 N·L 几何逐位不变**。
本轮有两个可观测变化：① 月轮 sprite 搬到了光照方向那侧（几何，不是像素）；
② 夜间色温变冷（像素）。故判据必须落在**这两件事**上，不能落在光照方向上。

1. **一致性判据（几何，非像素）**：`?style=night` 下，月轮世界位置相对相机的归一化方向
   必须与 `materials.dayNight.uSunDirection.value` 相同（dot > 0.999）。这是本次改动的**核心
   断言** —— 它直接钉住"月亮在光来的那侧"，而不是任何间接代理。
2. **冷色判据（像素）**：`?style=night&vd=4&seed=12345` 固定机位，天空外地面区域的 R−B < −12
   （屏幕口径的"明显偏冷"）。**同时钉上下界**：同一区域 luma 不得低于改动前基线的 90%、
   也不得高于 110%（防"变成纯蓝死黑"或"变亮了"——用户裁定保持现状亮度）。
   基线在实施时先跑一次打印实际值，按实测定阈值，不拍脑袋。
3. **零回归对照（像素）**：同一夜间机位，只把 `params.moonDirection` 改回旧值
   `[-0.32,0.58,-0.75]` 并重摆月轮 → **地面像素逐位不变**。这条钉住 DR-1：本轮的改动
   不经过任何光照通路，只有 sprite 位置与色温。若这条 FAIL，说明改动意外污染了 shade 输入。
4. **白天零回归（像素）**：`?style=noon` 的整屏像素与改动前基线一致
   （`moonVisible=false` → 月轮不可见；`sunColor`/`ambientColor` 仍中性）。

### 回归（必须全绿）
`daynight-visual` / `dusk-style` / `skybox` / `sun-directional` / `hemisphere-ambient` /
`sun-shadow` / `water-visual`。

`dusk-style.spec` 有**两处会被本轮改动直接命中**（不是间接耦合）：

- `test('傍晚⑤：其余三种风格零回归')` 遍历 `['morning','noon','night',null]` 并断言
  `sunColor`/`ambientColor` 逐位等于 `[1,1,1]`、`sunLight` 逐位等于原色 —— **night 那两轮会 FAIL**。
  按 DR-3 的裁定，这条要改成「morning/noon 中性；night 冷色」，或把 night 从该循环里移出
  并另写 night 版断言。
- `test('傍晚④')` 的「傍晚须远亮于深夜 > 1.8×」（实测 dusk 96 / night 84）—— 夜间色温虽然
  总亮度不变（+0.3%），但 sRGB 三通道分配变了，luma 可能微动，需实测确认仍在 1.8× 以上。

### 门禁
`npm run check`（arch + data + lint）→ `npm test` → 改热路径（`daynight.js` 被 materials 消费）
需 `npm run bench -- --check`。

## 6. 风险与已知边界

- **月亮低挂（14.5°）**：用户已确认接受。视觉上月亮在夜空中靠近地平线，且因为
  `placeCelestial` 距离固定为 `camera.far × 0.55`，位置始终在视野内。
- **天空盒不含烘焙月亮**：逐面实测 `assets/sky/night/*.jpg` 最大 luma 111、零像素 >120
  → 挪动月轮不会产生"两个月亮"。
- **`test-daynight.js:308` 的断言作废**：那是 dusk（v1.71）落地时写的"其余三风格保持中性"
  约束，本轮按 DR-3 有意打破 night 的那一条。改动必须同时更新该注释，说明"night 现在有
  月光色温（v3.00），不再是零回归锚点"。
- **`moonDirection` 不再是 mc-lite 原值**：`test-daynight.js:173-179` 的三组原值断言要改成
  "与 sunDirection 同源"。这是一次**有意放弃上游可溯源性**（用户裁定方案 A 的直接代价），
  与 `sunDirection` 仍保持 mc-lite 原值不冲突。

## 7. 明确不做

- **不接水面高光**（用户 2026-11-14 裁定"第 4 段先不接"）：`ocean.js` 的 `uSunDirection`
  仍恒为 `(0,0.8,0.6)`。**这是既有的缺口**，与本次改动正交 —— 夜里水面高光方向仍是正午值。
  单独处理时需重标 `water-visual.spec` 的 luma 断言。
- **不增加月影强度/刷新频率**：`uShadowStrength` 保持 `skyDim = 0.25`。
- **不做月亮轨迹的独立演化**：月亮与太阳共轨迹，不模拟真实的"日月相对运动"。
- **不改 `moonSize` / `moonVisible` / `nightBlend` / `duskBlend`。**
- **不引入第二个方向光或第二个 N·L 项**：着色器零改动。
