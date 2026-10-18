# 阴影纹素对齐 + 太阳方向阈值门控（v1.47）

> 日期：2026-10-17 ｜ 分支：`add-shadow` ｜ 前置：v1.44 太阳阴影落地 / v1.45 混合模型修正 / v1.46 远端闪烁修复（`31e5425`）
> 触发：用户实玩报告「阴影随着玩家的移动会微微晃动，幅度不大但能察觉」+ 质疑「200ms 刷新频率是否过高、对性能影响有点大」

## 1. 要解决什么

两件事，都由用户提出：

### 1.1 阴影随玩家移动微微晃动

根因是**纹素量化**：阴影相机正交 ±30 覆盖 60 格、贴图 256×256 → 每纹素 ≈ 60/256 = **0.234 格**。
光源跟随玩家连续移动（`game.js:818 _updateSunPosition()`），每次 200ms 重渲时世界相对纹素网格
错位一个**分数**纹素 → 所有影子边缘跳动最多半纹素 ≈ **0.1 格**。

这解释了用户的观察「幅度不大但能察觉」，也解释了「随移动才晃」：站着不动时阴影相机位置不变，
重渲不挪网格，影子是稳的。

⚠️ **不是**「太阳方向在变」造成的：日夜循环下太阳每秒只转 0.3°，每 200ms 转 0.06°，
在 256² 贴图上不可见。用户最初的猜测（「太阳一动一动所以阴影一动一动」）方向对了一半 ——
真正「一动一动」的是**阴影相机的纹素网格**，不是太阳。

### 1.2 日夜循环下的无谓刷新

`DayNight.update(dt)` 每帧 `_apply` → `onSunDirection` 回调**每帧**触发（`game.js:245-249`）→
每帧调 `_updateSunPosition()`（120 次/秒）+ `shadowScheduler.request()`。

而太阳每帧只转 **0.0025°**，这个量级在 256² 贴图上完全不可见 → 绝大部分重定位是白做的。

附带成本：`_updateSunPosition()` 读 `dayNight.params.sunDirection`，而 `get params()` 在无 override 时
调 `paramsAtHour()` → `lerpParams()` + `normalizeDirection()`，**每帧新分配 2~3 个小对象/数组**
（`_apply` 自己还会再算一遍）→ 帧循环里的 GC 压力源。CLAUDE.md 已记录 GC 压力会影响
fast-remesh p95（`src/ui/hotbar.js:40`），故这项不只是「浪费」，是已知的抖动源之一。

## 2. 先纠正上一轮的一个说法：200ms 的性能前提不成立

我上一轮说过「200ms 频率对性能影响有点大」这个前提，**实测不成立**，所以本方案**不改 200ms**。

探针实测（vd=8、日夜循环运行中、逐帧按「该帧是否刷新」分组）：

| | 帧数占比 | 帧时中位 | drawCalls |
|---|---|---|---|
| 稳态帧（不刷新） | 95.8%（692/722） | **8.3ms** | 467 |
| 刷新帧 | 4.2%（30/722） | **9.0ms** | 664 |
| 关阴影对照 | — | **8.3ms** | 512 |

- **稳态帧与关阴影逐位相同**（8.28 vs 8.33ms，噪声内）→ 阴影常驻成本为零
- 全部成本集中在那 4.2% 的刷新帧，每帧 **+0.7ms**
- 摊平到所有帧：`0.042 × 0.7 ≈ **0.03ms/帧**`，fps 恒 120，无掉帧

**单次刷新成本与频率无关**（强制不同间隔，静止场景）：

| 强制间隔 | 100ms | 200ms | 400ms | 800ms | 1600ms |
|---|---|---|---|---|---|
| 刷新帧中位 | 8.74 | 8.74 | 8.82 | 9.04 | 9.12 |
| 刷新帧占比 | 11.8% | 8.2% | 5.5% | 5.3% | 4.7% |

→ **降频不会让每次刷新变便宜，只是让它更少发生**。单纯把 200ms 调大省不下什么（0.02ms/帧量级），
还会让阴影覆盖滞后（走快时边缘影子缺失）。

⚠️ 既有验收数据用 p95（600 帧窗口 = 5s @120fps）：5Hz 刷新下刷新帧只占 4.2%，**刚好落在 p95
阈值之下** → 聚合 p95 抓不到刷新尖峰。这是「用聚合指标回答分组问题」的口径错误，本次改用分组对照。

## 3. 现状与约束

- `_updateSunPosition()`（`game.js:818`）是定位光源的**唯一入口**，两条路径都走它：
  ① 帧循环移动阈值（`distSq > 25`，`game.js:694-703`）② `onSunDirection` 回调（`game.js:245-249`）
- ⚠️ **硬约束：不得扰动光照方向**。`DirectionalLight` 对着色只生效「方向 = position − target」，
  而枪的 PBR 高光依赖它跟随日夜（`game.js:242-244` 已记录，且 `_updateSunPosition()` **刻意不受**
  `castShadow` 门控 —— 关阴影时枪的高光仍须跟随日夜）。所以对齐只能**平移**光源，不能改方向。
- **关键几何事实**：`position = target + sunDir × 60`，两者之差平行于相机 Z 轴 → 它们在相机
  X/Y 轴上的投影**完全相同** → 给两者加**同一个**偏移向量，方向严格不变，且对齐任一点等价。
  这是本方案能成立的核心，也是「偏移必须同时加到 position 与 target」这条载荷性约束的来源。
- `shadow-manager.js` 已是「纯逻辑无 three」的阴影节流模块（`ShadowScheduler`），新纯函数放这里
  符合既有分层（`src/render/` 不得依赖 three 的部分已有先例）
- **mc-lite 没有这两项**：它无连续日夜循环（`sunDirection` 只在点风格按钮时变，`Engine.js:584-586`），
  光源只在移动超 5 格时重定位（`Game.js:536-558`），且无纹素对齐 → 两项都是**有意偏离 mc-lite**，
  须记录进设计文档偏离清单

## 4. 打算改哪些文件

### 4.1 `src/render/shadow-manager.js` —— 两个纯函数（无 three，可确定性单测）

```js
export const SUN_DIR_GATE_DEG = 0.5;   // 单一权威，可调（红线 1：不写字面量到消费点）
export function sunDirectionChanged(lastDir, dir, thresholdDeg)  // 点积 vs cos(阈值)；lastDir=null 恒 true
export function texelSnapOffset(center, sunDir, texelSize)       // 返回世界空间偏移 [dx,dy,dz]
```

**`texelSnapOffset` 算法**：由 `sunDir` 构造相机基（`zAxis = sunDir`、
`xAxis = normalize(cross(worldUp, zAxis))`、`yAxis = cross(zAxis, xAxis)`，与 three `lookAt` 同口径）
→ 把 `center` 投影到 xAxis/yAxis → 各自 round 到 `texelSize` 整数倍
→ 偏移 = `xAxis·Δu + yAxis·Δv`。

**退化保护**：`sunDir` 平行 worldUp（`[0,±1,0]`）时 cross 为零向量 → 返回 `[0,0,0]`（不对齐、不崩）。
本仓三组 `VISUAL_STYLES.sunDirection` 的 y 分量均 < 1，不会退化，但纯函数须自守。

**阈值取 0.5° 的依据**：太阳 0.3°/秒 → 约 1.67 秒一次 = **0.6Hz**（8× 降幅）。
误差量级评估：
- 3 格石柱的影子尖端偏 `3 × tan(0.5°) ≈ 0.026` 格（不可见）
- 视锥边缘 30 格处偏 `30 × tan(0.5°) ≈ 0.26` 格 ≈ 1.1 纹素，但那是**静态偏移**而非抖动，
  且位于阴影覆盖最边缘
- 附带收益：noon 平台段（`KEYFRAMES` 的 hour 9~17，占一天 1/3）方向恒定 → 该时段**零**方向驱动刷新

### 4.2 `src/core/game.js` —— 接线（两处）

- `_updateSunPosition()`：算出 `texelSize = (camera.right − camera.left) / shadow.mapSize.width`
  （**从实际配置读，不写字面量**，红线 1）→ 调 `texelSnapOffset(player, sunDir, texelSize)`
  → 把偏移**同时**加到 `sunLight.position` 与 `sunLight.target.position`
- `onSunDirection` 回调：加 `sunDirectionChanged(this._lastSunDir, dir, SUN_DIR_GATE_DEG)` 门控，
  通过才 `_updateSunPosition()` + `request()` + 更新 `_lastSunDir`；
  新增 `this._lastSunDir = null` 字段（首次恒通过，保证启动即定位）
- ⚠️ **移动阈值路径不加方向门控**（它本来就是事件驱动，且玩家移动必须让阴影相机跟上；
  加了会让「走 5 格后影子钉在原地」）

### 4.3 `src/tests/test-shadow-manager.js` —— Tier 1 单测（TDD，RED 先行）

`texelSnapOffset`：
1. 偏移量在 xAxis/yAxis 上都是 `texelSize` 的整数倍差
2. **方向不变**（`position − target` 归一化后与 `sunDir` 逐分量相等）
3. 已在网格上时返回零偏移（幂等）
4. 退化方向（`[0,1,0]`）返回 `[0,0,0]` 不抛
5. noon 与 night 两个真实 `sunDir` 各测一遍（不同基）

`sunDirectionChanged`：
1. `lastDir=null` 恒 true
2. 同方向 false
3. 超阈值 true、阈值内 false（**在临界值附近取点**，不用远离阈值的输入 —— CLAUDE.md 已记的教训：
   「用远离阈值的输入测不出来」）
4. noon→night 大跳变 true

### 4.4 `tests/sun-shadow.spec.mjs` —— E2E（1 改 + 3 新增）

- **改** `光源跟随玩家` 用例的容差：现为硬编码 `0.1`，而对齐后 target 与 player 最多差半纹素对角
  ≈ **0.166**（`0.5 × 0.234 × √2`）→ 会假失败。改为**从配置推导**的容差（半纹素对角 + 余量），
  并在注释里写清为什么不再是 0.1。
  ⚠️ 这**不是**「放宽断言」而是行为变了导致几何口径变了，会在提交说明里点明。
- **新增** 方向不变式用例：走真实 `_updateSunPosition()` 路径，断言对齐前后
  `normalize(position − target)` 与 `dayNight.params.sunDirection` 逐分量一致
  （这是「不扰动枪 PBR」的守卫，单测测不到真实接线）
- **新增** Tier 4 晃动回归门：固定渲染相机 + 俯视平台 + 石柱，把玩家位置按**分数纹素**小步长
  （如 0.05 格 × 10 步）推进，每步调 `_updateSunPosition()` + 强制刷新，扫描并锁定一个影子边缘像素，
  断言其亮度跨全部步长**恒定**。
  sanity floor：该像素须真的是边缘（亮度介于受光/影区之间），否则用例恒真无意义。
  **负向验证**在实施期临时关掉对齐跑一遍，把实测 FAIL 数值写进用例注释（同 v1.45/v1.46 惯例）。
- **新增** 刷新率用例：日夜循环 + 静止玩家，窗口内统计 `needsUpdate` 置位次数，
  断言显著低于 5Hz 口径（门控生效）；对照组 `setStyle(null)` 前后须有差

### 4.5 文档同步

- `docs/phase-1-engine-design.md`：§4.4.4 的「跟随玩家：`position = player + sunDirection × 60`、
  `target = player`」口径变更（加纹素对齐）+ **v1.47 修订说明**（含实测帧时数据、两项有意偏离
  mc-lite 的理由）。
  这次**要** bump 版本号 —— 与前两次（v1.45/v1.46 是实玩修正不进修订说明）不同，
  它改的是 §4.4.4 已明文写出的架构口径。
- `CLAUDE.md`：阴影段新增活跃约束 ——
  ① 纹素对齐的载荷性：偏移必须**同时**加到 position 与 target，只加一个会改方向 → 枪 PBR 高光漂移
  ② `onSunDirection` 的方向门控**不得**加到移动阈值路径上
- `docs/roadmap.md`：v1.47 行 + 头部现状段

## 5. 怎么验证

按 `testing-policy.md` 门禁分层，这是 **Tier 1**（机制类，改坏了肉眼看不出方向漂移）→ TDD + 全门禁：

1. `npm run check`（arch + data + lint）
2. 浏览器内单测（`tests/harness.spec.mjs`，含新增纯函数用例）—— **RED 阶段先确认新用例真的失败**
3. `npx playwright test tests/sun-shadow.spec.mjs`（含新增 3 条 + 改容差的 1 条）
4. `tests/render-terrain.spec.mjs` + `tests/daynight-visual.spec.mjs`
   （drawCalls 与亮度冻结断言，确认对齐没动 draw 数）
5. `npm run bench -- --check`；若阻断，按仓库铁律做 MOD/BASE **交替对照**各 3 轮判定，
   不看单次数值、不改断言、不重写基线
6. **负向验证**（两条，都须真 FAIL 并记录实测数值）：
   - 临时关掉对齐 → Tier 4 晃动用例须真 FAIL
   - 临时把阈值改成 0 → 刷新率用例须真 FAIL

## 6. 不做的事

- **不改 200ms 节流值**（实测单次刷新成本与频率无关，改它省不到性能，只增加阴影滞后）
- **不提阴影贴图分辨率**（256→512 能让量化减半，但显存/带宽翻倍，且对齐后已无必要）
- **不做太阳旋转引起的网格转动补偿**（旋转 0.3°/秒，慢到不可见；对齐只治平移，
  这是已知边界，会写进文档）
- **不加 URL 开关**（负向验证用临时改代码的方式，同 v1.45/v1.46 惯例）

## 7. 任务拆分（TDD 顺序）

| # | 任务 | 产出 | 验证 |
|---|---|---|---|
| 1 | `sunDirectionChanged` 纯函数 + 单测 | `shadow-manager.js` / `test-shadow-manager.js` | RED→GREEN，harness 全绿 |
| 2 | `texelSnapOffset` 纯函数 + 单测 | 同上 | RED→GREEN，harness 全绿 |
| 3 | `game.js` 接线（两处）+ 方向不变式 E2E | `game.js` / `sun-shadow.spec.mjs` | 新用例绿 + 既有 9 条不回归 |
| 4 | Tier 4 晃动回归门 + 改跟随容差 | `sun-shadow.spec.mjs` | 新用例绿 + 负向验证真 FAIL |
| 5 | 刷新率 E2E + 负向验证 | `sun-shadow.spec.mjs` | 门控生效 + 阈值归零真 FAIL |
| 6 | 文档同步（设计文档 v1.47 / CLAUDE.md / roadmap） | 三份文档 | `npm run check` |
| 7 | 全门禁 + bench 交替对照 | — | 见 §5 |
