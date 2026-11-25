# 阴影缺陷排查复盘：五轮修复尝试全部失败的原因分析

> 日期：2026-11-25 ｜ 会话结论：**两个报障均未修复，全部源码改动已回退，`src/` 与 `tests/` 逐文件等于 HEAD**
> 报障素材：`~/ttt/bug/影子bug.mov`、`~/ttt/bug/阴影bug.png`、`~/ttt/bug/影子刷新的问题.mov`
> 本文目的：把**试过哪五条路、每条做了什么、为什么不通**完整留档，避免后续重踩。
> 阅读顺序建议：先读 §1（结论）与 §6（为什么我的验证反复失效），再读 §3（逐条尝试）。

---

## 1. 结论摘要

| 项 | 结果 |
|---|---|
| 用户报障 A：走动时身边影子反复刷新变化 | ❌ **未修复** |
| 用户报障 B：移动到某处整片沙漠突然全覆盖阴影 | ❌ **未修复**，且我的改动让它**更频繁** |
| 源码状态 | `src/core/game.js`、`src/core/scheduler.js`、`src/render/shadow-manager.js`、`src/tests/test-shadow-manager.js`、`src/tests/test-light-writeback.js`、`tests/sun-shadow.spec.mjs` **逐文件 identical to HEAD** |
| 保留物 | 仅文档：本报告 + `pitfalls.md` 三节 + `phase-1-engine-design.md` v3.40 段 + `roadmap.md` v3.40 行 |
| 修复尝试次数 | **5 轮**，其中 3 轮的"根因"是我自己的测量伪象，2 轮是真机制但修法错误 |
| 引入的真回归 | **2 处**（深度越界 / 请求风暴），均由用户实玩证伪后回退 |

**一句话总结失败原因**：我把「观察到的相关性」当成根因，把「让指标变绿」当成修好；
而**验证夹具的运动轴与被改动的轴不一致**，导致绿灯全部取自 bug 无法出现的路线。

---

## 2. 被排查系统的既有设计（读代码确认，非推测）

理解失败前必须先明确这些**载荷性约束**——我的两次回归正是破坏了它们。

### 2.1 阴影管线（`src/core/game.js:460-493`）

```
mapSize      1024 × 1024
camera       正交 left/right/top/bottom = ±96，near 0.1，far 300
radius       2.6（VSM 模糊半径，单位是纹素）
blurSamples  8
autoUpdate   false          ← DR-5 按需刷新
档位         VSMShadowMap（WebGPU 下 PCF 路径坏，见 pitfalls）
```

### 2.2 光源定位（`src/core/game.js:2175-2176`）

```js
sunLight.position = 玩家位置 + texelSnapOffset + dir × 60
sunLight.target   = 玩家位置 + texelSnapOffset
```

☠️ **`× 60` 是载荷性的**：它保证「光源到玩家的距离恒为 60」，
于是玩家周围几何的视空间深度始终落在 `near 0.1 / far 300` 的**中段**。
**我在第 4 轮破坏了这个不变式**（详见 §3.4）。

### 2.3 三个刷新请求源 + 节流器

| 源 | 触发条件 | 频率量级 |
|---|---|---|
| 日夜方向（`game.js:616`） | `sunDirectionChanged` > `SUN_DIR_GATE_DEG = 0.5°` | 默认 1200s/天 ⇒ 约 0.6 Hz |
| 玩家编辑（`game.js:707`） | `editor.subscribe` | 低频事件 |
| 移动阈值（`game.js:1710`） | `distSq > 25`（走 5 格） | 冲刺约 1.6 Hz |

`ShadowScheduler.minIntervalMs = 200`（`shadow-manager.js:23`）⇒ 刷新上限 5 Hz。
☠️ **三个源都以「低频事件」为前提**。我在第 5 轮接了一个高频持续事件进去（详见 §3.5）。

### 2.4 VSM 的判据链（`vendor/three/three.webgpu.js`）

```
:44950  frustumTest = (0 ≤ x ≤ 1) ∧ (0 ≤ y ≤ 1) ∧ (z ≤ 1)
:44958  return frustumTest.select(shadowNode, float(1))   ← 测试失败 ⇒ 恒返回 1（无影）
:44580  hardShadow = step(shadowCoord.z, mean)            ← 非 reversedDepth
:44590  p_max = variance / (variance + d²)                ← Chebyshev 软阴影
```

**关键**：`z > 1` 时 `shadow()` **恒返回 1**，即"处处无影"。
这正是第 4 轮回归的失效路径——而它在屏幕上表现为**整片地形明暗错乱**，不是"影子变多"。

---

## 3. 五轮修复尝试逐条记录

### 3.1 第 1 轮：怀疑纹素对齐（texel snapping）失效 —— 假设被实测推翻

**动机**：仓库已有 `texelSnapOffset`（`shadow-manager.js:111`）专治"影子随移动晃动"，
用户症状描述高度相似，是最自然的怀疑对象。

**做了什么**：搭高空 stone 平台 + 3 格石柱夹具（照 `tests/sun-shadow.spec.mjs` 已验证手法），
`style=noon` 钉死太阳方向，玩家连续移动 30 帧 + 每帧强制 `needsUpdate`，逐帧读影区亮度。

**实测结果**：
```
shadowSpread = 0    （24 个采样点亮度逐位相同：94.42 × 24）
litSpread    = 0
phaseSpread  = 0
targetTravel = 0.9375   ← 相机确实动了，不是"什么都没发生"
```

**结论**：**纹素对齐是好的，不是根因**。这一轮是本次会话唯一一次"假设被干净排除"。
既有 `texelSnapOffset` 全程未动。

---

### 3.2 第 2 轮：判定"阴影矩阵上传时刻早于重算时刻" —— ☠️ 我的测量伪象

**动机**：读 three 源码发现两条路径读同一个 `shadow.matrix` 实例但写入时刻不同：
- 采样侧 `lightShadowMatrix()`（`three.webgpu.js:43554`）是 `renderGroup` uniform，
  `onRenderUpdate` 直接 `return light.shadow.matrix`；
- 生成侧 `renderShadow()` 里才调 `shadow.updateMatrices()`（`three.core.js:45940`）。

而 `_updateSunPosition()` 只写 `position/target`、不重算矩阵。**看起来**存在错配窗口。

**做了什么**：
1. 写探针在 `renderer.render()` **入口**取 `shadow.matrix` 当"采样侧的值"，
   与 `updateMatrices` 时刻的值比逐分量最大差（称 desync）；
2. 实测 desync = **0.021484**，且同一帧 VSM 贴图上 15226/16384 像素变化；
3. 写修法：帧循环置 `needsUpdate` 后当场调 `updateMatrices`；
4. 写 Tier 4 用例 + 单变量 A/B：desync **3/3 → 0/3**，"验证通过"。

**为什么不通**：
> **取样点错了**。`renderer.render()` 入口那一刻 GPU **还没上传**，
> 读到的是 JS 侧源对象的当时状态，与 GPU 真正拿到的字节隔着整条上传链。
> 量到的"差"只是**函数调用顺序**的产物，不是缺陷。

**正确口径**（后来才找到）：`renderer._bindings.updateForRender(renderObject)` **返回之后**，
从 `renderObject.getBindings()` 里找 `uniform.getValue() === shadow.matrix` 的那个 uniform，
读它所在 `uniformsGroup` 的 `values.slice(uniform.offset, +16)`。

换成正确口径后：**desync 恒为 0**，修法在不在位都一样。

**发现方式**：负向验证 —— 注掉修法后用例**仍然 PASS**。
若跳过负向验证，就会带着一个恒真判据和一段无效修法交付。

**两条已试失败的歧路（勿重试）**：
- 遍历 `renderer` 找 `updateMatrix4` 的 prototype ⇒ 不可达；
- 拦 `UniformNode.prototype.update` 判 `this.value === shadow.matrix` ⇒ 命中 **0** 次
  （`onUpdate` 包装后 `this` 绑定与实例判据不匹配）。

**处置**：修法与用例全部删除。

---

### 3.3 第 3 轮：判定"太阳方向门控与刷新节流不同步" —— ☠️ 我把太阳速度设快了 10 倍

**动机**：在"世界静止 + 玩家静止 + 每帧强制刷新"条件下对比两种模式：

| 模式 | 最大点跳变 | >4 的跳变次数 |
|---|---|---|
| `noon`（方向恒定） | 1.97 | **0** |
| 日夜循环（方向推进） | 8.27 | **6**（全在刷新帧） |

看起来"跳变与方向推进强相关"。进一步量到 `uSunDirection` 每帧连续推进，
而贴图按 0.5° 门控 + 200ms 节流离散刷新，方向差最大 0.0135。

**为什么不通**：两个独立错误。

1. **参数放大**：那轮我设 `cycleSeconds = 120`，而**默认是 1200**（`daynight.js:381`）
   ⇒ 把太阳速度**人为放大 10 倍**。补测真实速度：

   | arm（`reflect=0&ambient=0`） | 最大点跳变 | >4 跳变 |
   |---|---|---|
   | 阴影关（噪声底） | **0** | 0 |
   | 阴影开 + noon | **0** | 0 |
   | 阴影开 + 日夜 120s/天（快 10×） | 1.34 | **0** |
   | 阴影开 + 日夜 **1200s/天（真实）** | 0.75 | **0** |

   ⇒ 之前那 6 次跳变在关掉反射/环境特效后**完全消失**，真实速度下也归零。

2. **"隐藏环境特效"根本没生效**：我用 `mesh.visible = false` 关落叶/萤火虫，
   但实测 `fxVisibleMax` 恒为 1 —— **渲染器每帧 sync 会把它写回**。
   所以那一轮的"逐项隔离"结论无效。

**处置**：假设作废，未写任何修法。

---

### 3.4 第 4 轮：判定"沿太阳方向平移污染深度编码" —— 观察正确，☠️ 修法引入真回归

**这一轮最值得复盘：诊断是对的，修法是错的。**

**观察（正确，纯数学单变量、零 GPU 噪声）**：
固定一个世界点，只改光源平移方向，用真实 `LightShadow.updateMatrices` 算 `shadowCoord.z`：

| 平移方向（0~30 格） | zSpread |
|---|---|
| **沿 dir 平移** | **0.10003** |
| 垂直 dir 的 X 轴 | **0** |
| 垂直 dir 的 Y 轴 | **0** |
| 玩家沿 −Z 走（用户方向） | **0.06002** |

而影区/受光的判据余量只有 **0.011** 量级 ⇒ 漂移是余量的 5 倍。
逐帧实测也印证：`z` 从 0.20368 降到 0.14866、`mean` 从 0.19250 降到 0.14893，第 60 帧交叉 ⇒ 影子消失。

**做了什么**：新增纯函数 `depthStableCenter(center, sunDir, anchor)` ——
把中心分解为「沿 dir」+「垂直 dir」，**沿 dir 分量钉死在首次定位锚点**、垂直分量跟随。
配套 6 条 Tier 1 单测 + 1 条 Tier 4 不变式用例（量"固定世界点此刻有影/无影"，不量亮度）。

**当时的"验证"**：zSpread 0.055 → **0**，flips 4 → **0**，`sun-shadow` 13/13，负向真红。

**☠️ 为什么不通（用户实玩证伪）**：

沿 **−Z**（用户实际走的方向）实测同一固定世界点：

| 走过 | HEAD | 我的改动 |
|---|---|---|
| 100 格 | z = 0.20774 | **0.4078** |
| 200 格 | 0.20774 | **0.60787** |
| 300 格 | 0.20774 | **0.80794** |
| 400 格 | 0.20774 | **1.008** ← 越界 |

`lightDist`（光源到玩家距离）从恒 **60** 变成 **120 / 180 / 240 / 300**。

**失效链**：钉死沿 dir 分量 ⇒ 玩家跑远后光源到几何距离线性增长 ⇒ `z > 1`
⇒ `frustumTest`（`three.webgpu.js:44950`，要求 `z ≤ 1`）失败
⇒ `frustumTest.select(shadowNode, float(1))` 返回 **1**
⇒ **整片地形失去阴影调制、明暗错乱、树影消失** = 用户截图形态（沙地一片灰）。

**根本教训**：
> §2.2 的 `× 60` 不是随手写的偏移，它保证**深度分布落在 near/far 中段**。
> 我把它钉死，等于把这个不变式换成"深度随玩家距离线性漂移"。
> **诊断正确 ≠ 修法正确。改一个载荷性常量前，先问它原本在保证什么。**

**处置**：`depthStableCenter` + `_shadowDepthAnchor` + 6 条单测 + Tier 4 用例全部回退。

---

### 3.5 第 5 轮：给"新 section 发布"补刷新请求 —— ☠️ 引入请求风暴

**动机（针对报障 B）**：三个请求源都不覆盖"新几何发布"。
玩家走动时新列不断加载，这些几何不在贴图里 ⇒ 新地形无影；
等下一次别的源放行，一次重渲把积累的新几何一起纳入 ⇒ "突然整片全是阴影"。

**实测支持**（沿 +X 走 200 格）：
```
i=190  sections 720  refreshes 8
停下    sections 675  refreshes 8
+2 秒   sections 792  refreshes 9   ← 117 个新 section 只换来 1 次刷新
```

**做了什么**：
1. `Scheduler.onSectionsUploaded(cb)` 订阅入口，在 `_processUploadQueue()` 末尾按
   `uploaded > 0` 触发一次（按帧聚合、不逐 section）；
2. `Game` 订阅 → `shadowScheduler.request()`（第四个源，同判 `castShadow`）；
3. 3 条 Tier 1 单测（按帧聚合 / 全无效项不通知 / 空队列不通知 + 退订对称）
   + 1 条 Tier 4 用例（`style=noon` + 玩家钉死 + 抬视距 2→4 制造新列加载）。

**当时的"验证"**：负向真红 `requests=0`；正向 `requests=44`、sections 179→372。

**☠️ 为什么不通（用户实玩证伪）**：

同一条 200 帧冲刺路线的 request 次数：

| | request 次数 | 实际刷新 |
|---|---|---|
| HEAD | **18** | 16 |
| 我的改动 | **134** | 16 |

**7.4 倍**。奔跑期 streaming 几乎每帧都在发布 section ⇒ 几乎每帧请求
⇒ 节流器**满频放行**（每 200ms 必刷）⇒ 用户报"更频繁、一秒刷一次"。

**根本教训**：
> §2.3 的三个源都以**低频事件**为前提。streaming 是**高频持续事件**，
> 直接挂 `request()` 等于把"按需刷新"变成"定时满频刷新"。
> 要覆盖它，必须先**降频**（如只在"玩家静止且队列收敛"时补一次），而不是逐帧通知。

**处置**：订阅与消费点回退（`Scheduler` 侧的订阅入口也一并回退，避免留死代码）。

---

### 3.6 附加尝试：粗格吸附（cell snapping）—— 同时打破既有门禁

**动机**：第 4 轮回退后，仍有一条已证实的机制未解 ——
`texelSnapOffset` 只钉住**网格相位**（uv 小数部分），相机中心仍连续平移
⇒ 固定世界点的 uv **整数部分**在变 ⇒ 采到别的纹素。

**实测**：同一世界点 70 帧内采到 **6 个纹素**（503→526→552→578→603→629）。
VSM 模糊邻域（radius 2.6 纹素）在不同纹素上覆盖不同几何 ⇒ `mean` 变
⇒ `step(z, mean)` **间歇**翻转。**这解释了用户说的"时有时无、找不到规律"——它是数据相关的。**

**做了什么**：探针里包一层 `_updateSunPosition`，把相机中心按粗世界格量化。
用户拍板选 cell=64。探针读数：

| 方案 | flips | 纹素数 | meanSpread |
|---|---|---|---|
| cell=32 | 1 | 2 | 0.209 |
| cell=64 | **0** | **1** | **0** |

**☠️ 为什么不通**：入生产后**同时两个真失败**：
```
✘ 光源跟随玩家：target=[282.94, 21.98, 117.03]  player=(289.0, 22.0, 117.0)
  差 6.06 格，容差 0.153  ⇒ 打破既有门禁「相机必须覆盖玩家所在几何」
✘ 身边影子恒定：实测 2 次翻转（mean 0.034 ↔ 0.2598）
```

**两个独立错误**：
1. **探针与生产不等价**：探针里"包一层函数"的量法与真实串联顺序不同，
   探针结论不可直接外推；
2. **串联顺序错**：我第一版写 `depthStable → snapCell → depthStable`，
   新单测当场真红（`y 52.72 → 75.76`）—— 第二次 `depthStable` 把量化位移**拉回连续值**，
   等于抵消修复。改成 `snapCell` 在前、`depthStable` 在后且只一次后单测绿，
   但**生产仍失败**（因为第 4 轮的 `depthStable` 本身就是错的）。

**处置**：全部回退。

---

## 4. 已证实但未解决的机制（留给后续立项）

**纹素映射漂移**（§3.6 的观察部分成立，修法未找到）：

- 相机 XY 平移 ⇒ 同一固定世界点采到不同纹素（实测 6 个）；
- VSM 的模糊邻域在不同纹素上覆盖不同世界几何 ⇒ `mean` 变；
- `step(z, mean)` 间歇翻转，**数据相关**（取决于该物体周围几何的深度分布）
  ⇒ 这就是"概率很高但不必现"的来源。

**它需要的修法**：保持"已投影内容 ↔ 纹素"映射不变的相机投影策略
（类似 stable shadow projection / 阴影图重投影），
**且必须同时满足**「相机覆盖玩家所在几何」（既有门禁 `snapTol = 0.153`）。

**已排除的两条歧路**：
| 方案 | 为什么不行 |
|---|---|
| 相机完全世界固定 | 覆盖盒不跟人，跑远没影子，违背"视距边缘可刷新"语义 |
| 粗格吸附（32/64） | 打破"相机覆盖玩家几何"门禁；且 cell=64 生产实测仍 2 次翻转 |

**不是参数问题**：格长、刷新频率、`minIntervalMs` 都属治标。
用户已明确驳回："不是快不快的问题，快刷新也是刷新，是不应该有刷新。"

---

## 5. 两处回归的完整失效链（供后续避坑）

### 5.1 深度越界

```
钉死沿 dir 分量
  → 光源到玩家距离不再恒 60，随玩家跑远线性增长（60→120→180→240→300）
  → 固定世界点的视空间深度线性增长
  → 正交投影 z = 深度 / (far − near) 线性增长（0.208→0.408→0.608→0.808→1.008）
  → z > 1
  → frustumTest 失败（three.webgpu.js:44950）
  → select(shadowNode, float(1)) 返回 1
  → shadow() 恒 1 ⇒ shadowKill 恒 1 ⇒ 太阳项满强度
  → 整片地形明暗错乱、树影消失
```

**观感陷阱**：用户读作"阴影全覆盖"，实际是"阴影调制整体失效"。
**若只看"暗像素占比"这类统计量会误判方向** —— 必须量 `z` 本身。

### 5.2 请求风暴

```
streaming 每帧发布 section（奔跑期）
  → onSectionsUploaded 每帧触发
  → request() 每帧置 _pending
  → tick 每 200ms 必放行（而 HEAD 只在移动阈值/编辑/方向变化时才有 pending）
  → 刷新从"事件驱动"退化为"定时满频"
  → 用户观感：影子一秒刷一次
```

**判据陷阱**：`requests` 与 `refreshes` 是两个量。
我的 Tier 4 用例只断言 `requests > 0`（正向）与 `= 0`（负向），
**没有对请求频率设上界** ⇒ 134 次与 18 次都能过。

---

## 6. ☠️ 为什么我的验证反复失效（本报告最重要的一节）

本次会话我**四次**得出错误结论，其中三次是测量口径错误。共性如下。

### 6.1 取样点与被测量之间隔着一条链

第 2 轮：在 `renderer.render()` 入口读 JS 侧 `Matrix4`，
而"GPU 用了哪份数据"要等到 `_bindings.updateForRender` **之后**读 GPU 缓冲才知道。
**入口值与 GPU 值之间隔着整条上传链**，量到的差是调用顺序。

### 6.2 ☠️ 夹具的运动轴与被改动的轴不一致（最致命）

第 4 轮：我改的是**沿太阳方向**的深度分量，而探针**一直沿 +X 移动玩家**。

```
sunDir = (0, 0.8, 0.6)   ← X 分量是 0
```

⇒ **沿 X 移动对深度编码是恒等变换**。那条路径根本不经过被改动的轴。
于是"zSpread=0 / flips=0 / 13/13 全绿"全部取自一条 **bug 无法出现**的路线。

换成沿 **−Z**（用户实际走的方向）立刻量到 `z` 越界。

**规则**：写夹具前先算——**我改的量在哪个轴上变？夹具的运动在那个轴上有分量吗？**
方向类改动尤其危险：某分量为 0 时，沿该轴移动完全无效。

### 6.3 参数被无意放大

第 3 轮：`cycleSeconds = 120` vs 默认 **1200** ⇒ 太阳速度快 10 倍。
**效应量不可外推到实玩**。改任何"速度/频率"类参数前，先读默认值。

### 6.4 隔离手段本身没生效

第 3 轮：`mesh.visible = false` 被渲染器每帧 sync 写回（实测 `fxVisibleMax` 恒 1）。
**"我关掉了 X"必须验证 X 真的关掉了**，不能假设赋值即生效。

### 6.5 把现象当根因

第 3 轮末尾我量到"刷新间隔 = 200ms 内走过的距离"（慢走 0.804 格 / 中速 1.8~5.1 / 快走 6~6.5），
就把它当根因并提议降 `minIntervalMs`。用户当场驳回：

> "你只定位了现象，没有定位到根因……不是通过刷新率提高来解决的，这个动作只能是治标不治本。
> 玩家在移动过程中，身边的影子完全不应该有刷新，是不应该有，不是快不快的问题。"

**规则**：报"根因"前自问——**这个结论解释了"为什么不该变的东西变了"吗？**
若只解释了"多久变一次"，那是现象。

### 6.6 判据只设下界不设上界

第 5 轮的 Tier 4 用例断言 `requests > 0`，于是 134 次请求风暴也能过。
**"必须发生"类判据要配"不能过度发生"的上界**，否则修过头照样绿。

### 6.7 单轮绿不能证明间歇缺陷已修

③ 是数据相关的间歇缺陷。同一份代码我量到过 flips = 0 / 1 / 2。
负向验证连跑 3 轮只有 2 轮红 ⇒ **判据本身判别力不稳**。
按仓库规矩（`AGENTS.md` 长跑纪律）应看**交替对照的分布**，不看单次红绿。

---

## 7. 回退后的验证证据

```
$ for f in src/core/game.js src/core/scheduler.js src/render/shadow-manager.js \
           src/tests/test-shadow-manager.js src/tests/test-light-writeback.js \
           tests/sun-shadow.spec.mjs; do git diff --quiet HEAD -- $f && echo OK; done
src/core/game.js                         identical to HEAD
src/core/scheduler.js                    identical to HEAD
src/render/shadow-manager.js             identical to HEAD
src/tests/test-shadow-manager.js         identical to HEAD
src/tests/test-light-writeback.js        identical to HEAD
tests/sun-shadow.spec.mjs                identical to HEAD

$ git diff --stat src/ tests/ | wc -l
0

$ npm run check:arch
[check:arch] ✓ 架构红线全部守住

$ npm run lint
✖ 186 problems (0 errors, 186 warnings)      ← 186 = 既有基线

$ node tools/run-unit-node.mjs --only=test-shadow-manager.js,test-light-writeback.js
[test:unit] 2 文件 / 31 例 ✓ 全部通过（passed=31）

$ npx playwright test tests/sun-shadow.spec.mjs
11 passed (56.0s)
```

**行为回到 HEAD 的逐项核对**（沿 −Z 走，与用户方向一致）：

| 量 | HEAD | 回退后 |
|---|---|---|
| `shadowCoord.z`（走 100/200/300/400 格） | 0.20774 恒定 | **0.20774 恒定** |
| `lightDist` | 60 | **60** |
| 200 帧冲刺 request 次数 | 18 | **18** |

**既有失败（与本次无关，未触碰）**：`check:data` 的 `[水中脚步声]` 产物指纹、
`test-footstep-water` 2 例 —— 已在干净 HEAD 上复现同样读数。

---

## 8. 给后续接手者的建议

### 8.1 先建立能复现缺陷的夹具，再动代码

本次最大的流程错误是**先改代码、再找能证明它的夹具**。正确顺序：

1. 沿**用户真实移动方向**（−Z，`sunDir` 的 Z 分量 0.6 ≠ 0）建夹具；
2. 确认夹具在 HEAD 上**能复现**"身边影子翻转"（不是量亮度，而是量
   "固定世界点此刻有影/无影"，口径见 §8.2）；
3. 才动代码；改完必须"注掉修复 ⇒ 真红"。

### 8.2 有效判据的口径（已验证可用）

```js
// GPU 侧矩阵：必须在上传完成后读
renderer._bindings.updateForRender(ro)  // 调完之后
const u = /* ro.getBindings() 里 uniform.getValue() === shadow.matrix 的那个 */;
const m = uniformsGroup.values.slice(u.offset, u.offset + 16);

// 固定世界点 → 光空间坐标
const sc = proj(m, [wx, wy, wz, 1]);

// 读 VSM 水平 pass 输出对应纹素（注意 y 取 1−y）
const buf = await renderer.readRenderTargetPixelsAsync(vsmShadowMapHorizontal, px, py, 1, 1);
const mean = half(buf[0]);

// 判据（非 reversedDepth）
const isLit = sc[2] <= mean;   // true = 此刻无影
```

**不变式**：玩家移动时，固定世界点的 `isLit` **不得翻转**，且 `sc[2]` 必须恒定。
这两个量都**不含屏幕噪声**，比亮度判据可靠得多。

### 8.3 三条不可违反的既有约束

1. **`光源 = 玩家位置 + dir × 60`**：保证深度落在 near/far 中段。**不得钉死沿 dir 分量**；
2. **相机必须覆盖玩家所在几何**：既有门禁 `snapTol = 0.5 × texelSize × √2 + 0.02 ≈ 0.153`；
3. **刷新请求源必须是低频事件**：streaming 这类高频持续事件要先降频才能接。

### 8.4 不要重试的清单

| 已排除 | 原因 |
|---|---|
| 纹素对齐失效 | 实测 spread = 0，它是好的 |
| 矩阵上传/重算时序错配 | 测量伪象，正确口径下 desync 恒 0 |
| 太阳方向门控不同步 | 那轮参数快 10 倍；真实速度下归零 |
| 降低 `minIntervalMs` / 调刷新频率 | 治标，用户已明确驳回 |
| 钉死沿 dir 分量 | 深度越界 ⇒ 整片阴影失效 |
| 逐帧挂 streaming 刷新请求 | 请求风暴 7.4× |
| 相机完全世界固定 | 覆盖盒不跟人 |
| 粗格吸附 32 / 64 | 打破覆盖门禁；64 生产仍翻转 |
| 遍历 renderer 找 `updateMatrix4` prototype | 不可达 |
| 拦 `UniformNode.prototype.update` | 命中 0 次 |

---

## 9. 元教训（写给下一次的自己）

1. **诊断正确 ≠ 修法正确**。改载荷性常量前先问它保证什么不变式。
2. **绿灯要先问"这条路线能出现 bug 吗"**。轴不对齐时全绿毫无意义。
3. **报"已修"前必须先证明夹具能复现原始缺陷**（注掉修复必须真红），而不是只看绿。
4. **"必须发生"判据要配上界**，否则修过头也绿。
5. **间歇缺陷看分布不看单次**，交替对照是硬要求。
6. **隔离手段要验证真的生效**（`visible=false` 会被 sync 写回）。
7. **参数改动前先读默认值**（120 vs 1200 差了 10 倍）。
8. **用户说"治标不治本"时，不要再提参数方案**，去查机制。
9. **同一会话里犯过同类错，第四次仍会犯** —— 靠的不是记性，而是每次动手前的检查清单。

---

## 附：相关文档

- `docs/pitfalls.md` §渲染与 GPU：三节新增判据教训（深度钉死后果 / 轴对齐 / streaming 降频）
- `docs/phase-1-engine-design.md` v3.40 段：两条载荷性约束的正式记录
- `docs/roadmap.md` v3.40 行：状态 🚧 未修复（源码 = HEAD）
- `.pi/plans/2026-11-25-shadow-matrix-desync-and-upload-refresh.md`：过程流水（含被推翻的中间结论）