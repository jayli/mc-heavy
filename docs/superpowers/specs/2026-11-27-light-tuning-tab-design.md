# 设置面板第三个 Tab「光影微调」设计（v3.51）

- 日期：2026-11-27
- 需求来源：用户 2026-11-27（本轮对话）
- 状态：待批准

## 1. 意图与为什么

用户上一轮问「『普通』环境风格的强光/弱光/环境光/对比度在哪配置」，得到答案是
`src/render/daynight.js` 的 `VISUAL_STYLES.normal` + `shade-params.js` + `ashlar-tonemap-config.js`
三处常量。用户随即裁定：**把这些常量做成滑块放进设置面板**，边看边拖，
再一键把满意的整套数值复制成文本贴回来固化。

也就是说：这个 Tab 是**标定工具**，不是玩家玩法开关。它的产出是「一段可粘贴的参数文本」，
而不是「一份要长期保存的玩家偏好」——这决定了下面「不持久化」的裁定。

## 2. 用户已裁定的事项（不再讨论）

| 事项 | 裁定 |
|---|---|
| Tab 位置 | **中间**：游戏设置 \| 光影微调 \| 关于游戏 |
| 作用域 | **当前生效风格**（切风格换一套；自动循环下滑动即固定当前时刻参数） |
| 持久化 | **只在本次会话有效**，不写 localStorage（照 `water-reflect-dock.js` 口径） |
| 参数集 | 核心 7 项 + 直射/环境色温 RGB + 对比度与饱和；**太阳仰角/方位不做** |
| 每行形态 | 一个参数一行：左标题、中滑块、右数值 |
| 复制按钮 | 「复制参数」→ 每行 `参数名，变量名:参数值` |

太阳仰角/方位被否决的理由（用户选项里已写明）：天空立方图里的太阳光晕是**预烘的**，
运行时改太阳方向会出现「影子朝这边、天上太阳在那边」。

## 3. 现状与硬约束（实测，不是推断）

### 3.1 面板尺寸是冻结的

`src/ui/settings-panel.js` 的 `.mc-content` 写死 `width:770px; height:560px`，
内部三段 = Tab 栏 40+14 / 页内容区 `flex:1` / 底栏 58 ⇒ **页内可视高 448px**。
三处 spec 冻结了相关不变式：

- `tests/about-tab.spec.mjs`：切 Tab 弹框尺寸逐位不变、页签等宽等高 40px、
  确定按钮在 Tab 内容之外且宽 156px、**前两页都不得出现纵向滚动条**；
- `tests/teleport.spec.mjs:99`、`tests/settings-resolution.spec.mjs:232`：
  `.mc-content` 的 `scrollHeight <= clientHeight + 1`。

⇒ **15 个滑块单列放不下**（每行约 26px + 间距 ⇒ 约 480px > 448）。
处置：**两列布局**（左 8 行 / 右 7 行），复用面板既有 `.mc-columns` / `.mc-column` 手法。
新 Tab 自己带 `overflow:auto` 兜底（`.mc-tab-panel.active` 本来就有），
但目标是**实测不溢出**；若实测溢出，停下报告，不擅自改面板高度。

### 3.2 「恰两个页签」是被硬钉的

`tests/about-tab.spec.mjs:73-74`：

```js
expect(init.tabs.map((t) => t.text)).toEqual(['游戏设置', '关于游戏']);
expect(init.tabs.map((t) => t.id)).toEqual(['settings-tab-settings', 'settings-tab-about']);
```

加第三个 Tab **必须同步改这两条**（需求变更，不是放宽阈值）。
改法：期望值改成三项、id 改成三个，其余断言（等宽/等高/尺寸不变/确定按钮位置）一字不动。
`src/tests/test-ui.js:646` 附近钉的是两个 label 常量的值，新增第三个常量并加一条断言。

### 3.3 「对比度」当前不是 uniform

`ASHLAR_PUNCH_GAMMA = 1.28` / `ASHLAR_PUNCH_SAT = 1.17` 是
`src/render/ashlar-tonemap-config.js` 的常量，被两个消费方吃：

1. 运行时 `src/render/ashlar-tonemap.js` 的 TSL 曲线；
2. **离线烘焙** `tools/normal-sky-tonemap.mjs`（天空立方图用同一条曲线压进 8bit）。

⇒ 直接改常量会连带改烘焙输入 → `check:data` 判「普通天空贴图过期」→ 要重烘。
处置：改成**运行时 uniform**（初值 = 那两个常量），烘焙脚本继续吃常量。
**不重烘、指纹门不动。**

副作用（要知道，不是 bug）：天空贴图已经过一次 AgX+punch，运行时再调 punch
会让天空与方块一起变，但天空是「二次经过曲线」。这是预烘天空架构的必然结果。

### 3.4 唯一写入收口点是 `DayNight._apply`

`_apply` 被三条路径调用：构造首帧、`setStyle()`、`update()`（日夜循环每帧）。
`shadowEnabled` 那段注释记着一个已实测的静默失效：**绕过它直接写 uniform，
下一帧就被覆写回去**。所以 override 必须进 `_apply` 的输入，不能在面板里写 uniform。

### 3.5 `VISUAL_STYLES` 是权威数据，不得原地改

`src/tests/test-daynight.js:193-196` 冻结了四档 `sunDirection` 的字面值；
`get params()` 已刻意对数组字段做拷贝（防调用方改到权威原值）。
⇒ override 存在**旁路的 Map**，合并时产生新对象，绝不写回风格表。

## 4. 方案取舍

### 4.1 override 存哪里

| 方案 | 取舍 | 结论 |
|---|---|---|
| **A. `DayNight` 内的 `Map<风格键, overrides>`** | `_apply` 仍是唯一收口点；三条路径自动一致；面板只调 API | **选它** |
| B. 面板直接写 uniform | 最省事，但日夜循环下一帧被 `_apply` 覆写 —— 正是 §3.4 记的静默失效 | 否决 |
| C. 改 `VISUAL_STYLES` 表 | 污染权威数据，冻结断言会红 | 否决 |

### 4.2 punch 怎么变可调

| 方案 | 取舍 | 结论 |
|---|---|---|
| **A. 运行时 uniform，初值 = 现有常量** | 烘焙输入不变 ⇒ 不重烘、指纹门不动 | **选它** |
| B. 改 config 常量本身 | 天空贴图静默过期，要重烘 6 面 | 否决 |

### 4.3 自动循环下滑块的语义

`update()` 在 `_styleOverride` 非空时 early-return。自动循环（`null`）下每帧
`paramsAtHour(hour)` 重算 ⇒ 任何 override 都会被下一帧的插值结果混合。

处置：**自动循环下第一次拖动滑块，就把当前时刻的整套参数固定住**
（`_tuningFrozen = true`，`update()` 不再推进 hour）。UI 上给一行说明
「自动循环下调整会暂停日夜推进」。「恢复默认」清 override 并解冻，回到循环。

这是「当前生效风格」作用域在自动档下的唯一自洽解释：不冻结的话滑块拖动会被
每帧插值抹掉（拖了没反应）。

## 5. 参数清单（15 项，两列 8/7）

`key` = 内部键；`label` = 玩家可见标题；`varName` = 复制文本里的变量名。

### 左列（8 行）—— 直射与影区

| # | label | varName | 范围 | step | 缺省来源 |
|---|---|---|---|---|---|
| 1 | 强光 | `sunIntensity` | 0 ~ 2 | 0.001 | `p.sunIntensity ?? SUN_INTENSITY` |
| 2 | 弱光（影区地板） | `shadowFloor` | 0 ~ 0.9 | 0.001 | `p.shadowFloor ?? SHADOW_FLOOR` |
| 3 | 直射色 红 | `sunColor[0]` | 0 ~ 2 | 0.001 | `p.sunColor[0]` |
| 4 | 直射色 绿 | `sunColor[1]` | 0 ~ 2 | 0.001 | `p.sunColor[1]` |
| 5 | 直射色 蓝 | `sunColor[2]` | 0 ~ 2 | 0.001 | `p.sunColor[2]` |
| 6 | 环境光方向性 | `hemiGround` | 0 ~ 1 | 0.001 | `p.hemiGround ?? HEMI_GROUND` |
| 7 | 环境色 红 | `ambientColor[0]` | 0 ~ 2 | 0.001 | `p.ambientColor[0]` |
| 8 | 环境色 绿 | `ambientColor[1]` | 0 ~ 2 | 0.001 | `p.ambientColor[1]` |

### 右列（7 行）—— 环境与色调

| # | label | varName | 范围 | step | 缺省来源 |
|---|---|---|---|---|---|
| 9 | 环境色 蓝 | `ambientColor[2]` | 0 ~ 2 | 0.001 | `p.ambientColor[2]` |
| 10 | 整体曝光 | `toneMappingExposure` | 0.2 ~ 4 | 0.01 | `p.toneMappingExposure` |
| 11 | 天空亮度 | `skyDim` | 0 ~ 1.5 | 0.01 | `p.skyDim` |
| 12 | 火把增强 | `blockBoost` | 0.5 ~ 2 | 0.01 | `p.blockBoost` |
| 13 | 水面亮度 | `waterTint` | 0 ~ 1.5 | 0.01 | `p.waterTint[0]` |
| 14 | 对比度 | `punchGamma` | 0.5 ~ 2.5 | 0.01 | `ASHLAR_PUNCH_GAMMA` |
| 15 | 饱和度 | `punchSat` | 0 ~ 2.5 | 0.01 | `ASHLAR_PUNCH_SAT` |

**范围取值理由**（都是「覆盖现有全部风格值 + 留调整余量」，不是凭空取整）：

- `shadowFloor` 上界 0.9 而非 1：`materials.js:238` 的 `shadowKill` 拿
  `1 − uShadowFloor` 当分母，取 1 会除零。0.9 留一个安全边界。
- `sunIntensity` / 色温三通道上界 2：现有最大值是 `sunColor[0] = 1.214`，
  留约 1.65 倍余量；下界 0 = 该项关闭（语义合法，`sunTerm` 退化到纯环境）。
- `skyDim` 上界 1.5：现有最大 1.0（morning 0.8 / night 0.25）。
  ⚠️ **它同时驱动 `uShadowStrength`**（§3.4），所以调它会连带改阴影浓度 ——
  这是既有耦合，UI 的 hint 里写明。
- `waterTint` **三通道必须相等**（既有全局断言：只调亮度不改色相）⇒ 一个滑块写三个分量。
- `punchGamma` / `punchSat` 只在 AgX 曲线（「普通」档）下有效；其余四档走 ACES，
  这两行**置灰**并 hint「仅『普通』档生效」。

### 参数表是单一权威

新增 `src/render/light-tuning-config.js`（**three-free**，与 `shade-params.js` 同理由）：
导出 `LIGHT_TUNING_PARAMS`（15 项定义：key/label/varName/min/max/step/列/读值函数/写值函数）、
`readTuningValues(params)`、`applyTuningOverride(params, overrides)`、`formatTuningText(...)`。

DOM、初值、复位、复制文本**全部从这张表派生**（照 `REFLECT_SLIDERS` 的既有手法）。
面板不写第二份字面量。

## 6. 文件改动清单

| 文件 | 改什么 |
|---|---|
| **新** `src/render/light-tuning-config.js` | 参数表 + 读/写/格式化纯函数（three-free） |
| **新** `src/tests/test-light-tuning.js` | Tier 1：参数表契约、读值回落、override 隔离、复制文本格式 |
| **新** `tests/light-tuning.spec.mjs` | Tier 2：真拖滑块改 uniform、切风格互不污染、复制文本、面板尺寸不变 |
| `src/render/ashlar-tonemap-config.js` | 加 `ASHLAR_PUNCH_UNIFORMS` 的**初值来源说明**（常量本身不动） |
| `src/render/ashlar-tonemap.js` | punch 两参数改读 uniform（`uniform()` 顶层单例）；导出句柄给 `_apply` |
| `src/render/daynight.js` | 加 `_tuning` Map + `_tuningFrozen`；`setTuning(key,v)` / `resetTuning()` / `get tuningValues`；`get params` 与 `update` 消费它 |
| `src/core/game.js` | 三个薄封装：`setLightTuning` / `resetLightTuning` / `get lightTuningValues`（面板不直连 dayNight） |
| `src/ui/settings-panel.js` | 第三个 Tab（中间位）+ `_panelLightTuning()` 两列滑块 + 底部「复制参数」「恢复默认」 |
| `src/tests/test-ui.js` | 加 `TAB_TUNING_LABEL` 断言 |
| `tests/about-tab.spec.mjs` | 两条页签断言改三项（其余不动） |
| `tools/test-tiers.mjs` | 新 spec 归 `ui` 档、新单测进 `UNIT_NODE_SAFE` |
| `src/tests/index.html` | 注册新单测 |
| `docs/roadmap.md` | v3.51 行 |

### 复制文本格式（用户指定）

每行 `参数名，变量名:参数值`，例如：

```
强光，sunIntensity: 0.956
弱光（影区地板），shadowFloor: 0.140
直射色 红，sunColor[0]: 1.214
...
对比度，punchGamma: 1.28
饱和度，punchSat: 1.17
```

首行附风格键（`风格，visualStyle: normal`），便于知道这套值属于哪一档。
数值统一 `toFixed(3)`（step 最小 0.001）；曝光等 step 0.01 的也走三位，格式一致好比对。

剪贴板：`navigator.clipboard.writeText`，失败回落隐藏 textarea + `execCommand('copy')`
（无头环境 clipboard API 可能不可用）。成功/失败都给 toast（复用面板既有 `this._toast`）。

## 7. 非目标 / 反目标

- **不做持久化**（用户裁定）。刷新即回风格表默认。
- **不做太阳方向滑块**（用户裁定，理由见 §2）。
- **不改任何风格的缺省值**：15 个滑块的初值全部读自当前生效参数 ⇒ 打开面板不动任何滑块时，
  画面**逐位不变**（这是最重要的零回归锚点）。
- **不改烘焙产物**、不重烘天空、不动 `docs/m3-baseline.*`。
- **不放宽既有冻结断言**：`about-tab` 只改「两个页签」这一条需求性断言，
  尺寸/滚动条/按钮宽度全部保留。
- 不动 `?style=` URL 语义、不动 `VISUAL_STYLE_OPTIONS` 顺序。

## 8. 验证计划（最小充分集）

改动横跨 render + ui + core，但**不碰热路径**（mesher/scheduler/physics）⇒ 不跑 bench。

1. `npm run check`（5.4s，arch + data + lint）；
2. `node tools/run-unit-node.mjs --only=test-light-tuning.js,test-daynight.js,test-normal-style.js,test-sun-shade.js,test-cloud-shade.js`
   —— 新增纯函数 + 全部消费 `daynight` / punch 常量的邻居；
3. `npx playwright test tests/light-tuning.spec.mjs tests/about-tab.spec.mjs tests/normal-style.spec.mjs tests/settings-resolution.spec.mjs tests/teleport.spec.mjs`
   —— 新 spec + 页签断言受影响的那个 + 「普通」档零回归 + 两处面板高度冻结断言；
4. `npm run test:unit`（改了纯函数与数据模型，36s）。

**负向验证**（每条都要真 FAIL，用 `edit` 注入、`cp` 副本还原）：

- `applyTuningOverride` 改成直接返回原 params（override 不生效）→ Tier 1 override 用例 + spec「拖滑块改 uniform」真红；
- `setTuning` 不写 Map（静默丢弃）→ 同上；
- punch uniform 换成写死常量 → spec「拖对比度真改画面」真红；
- 「打开面板不动滑块画面逐位不变」的对照：注入一个初值偏移 → 该用例真红。

**不跑全套**（AGENTS.md：本轮既非用户要求、非里程碑发版、也没改全局基础设施）。

## 9. 留给实施者的决定

- 滑块 CSS 具体像素（轨道高、thumb 尺寸）：照 `water-reflect-dock.js` 的比例缩放到面板灰底风格，
  实测两列 8/7 行在 448px 内不溢出即可。
- 置灰行的具体样式（`opacity` + `disabled`）与 hint 文案措辞。
- 「恢复默认」是否同时解冻日夜循环：按 §4.3 是「是」。