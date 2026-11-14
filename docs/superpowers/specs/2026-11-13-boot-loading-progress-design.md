# 启动加载进度条 + 慢网络不失败 —— 设计方案

日期：2026-11-13
状态：待审
修订：初版

## 0. 问题陈述（用户原话 + 实测）

> 我增加一个游戏整体 loading 的过程……有时候就因为等待时间太长导致渲染失败，比如会报错：
> `column (9,8) 加载超时`。我想做一个 loading 的进度条，加载进度就是让这么多脚本的加载进展
> 呈现出来。管理好加载脚本，不要因为加载慢就失败，即便加载慢，只要网络不断，也要都一个个的
> 把脚本加载完成。

### 0.1 现状（已实测，不是推测）

现有 `#loading-overlay`（v2.51）是静态 HTML + spinner + 一句阶段副文案，**没有进度**。
失败判据是两处绝对超时：

| 位置 | 预算 | 失败文案 |
|---|---|---|
| `StructureIndex.waitForRegion(0,0)`（game.js:905） | **5 s** | `layout timeout: 0,0` |
| `Game._waitForColumn`（game.js:1388） | **10 s** | `column (9,8) 加载超时` |

### 0.2 根因（从用户提供的 `js-perf.cn/mc-heavy` trace 解出）

| 事实 | 实测值 | 来源 |
|---|---|---|
| 总请求数 / 传输量 | 495 个 / 6.63 MiB | trace `ResourceFinish` 汇总 |
| 响应是否压缩 | **196 个响应全部无 `content-encoding`** | trace `ResourceReceiveResponse` |
| 主线程模块图 | 151 个模块 / 2344 KiB | 本机 CDP 实测 |
| **单个 Worker 模块图** | **52 个模块 / 905 KiB** | 本机 CDP 实测 |
| Worker 池大小 | **14**（`max(3, hc-1)`，hc=15） | trace 14 个 `DedicatedWorker thread` |
| 模块请求条目总数 | **874**（≈151 + 52×14） | trace `performance` 条目 |
| 主线程最长单任务 | 73 ms | trace `RunTask` 排序 |

**关键结论：主线程从未被 CPU 卡住（最长 73ms），失败纯粹是「等网络」。** 而超时预算要覆盖的
是「874 个模块请求 + atlas/图标/音频」一起抢带宽。本机限速复现（250 KB/s + 300 ms 延迟）：

```
worker 首个回包     90.9 s     ← layout 预算只有 5 s
模块下载完成       138.9 s
启动总耗时         158.9 s     → column (17,7) 加载超时
```

即超时值差了 **1~2 个数量级**。所以「把 5s/10s 调大」不是解（2 Mbps 只是中等档位），
必须同时改**语义**（无进展才失败）与**可观测性**（进度条）。

### 0.3 目标与非目标

**目标**
1. 启动全程有可信进度：脚本/资源下载 → 世界生成 → 首帧渲染，三阶段一条总进度。
2. 网络慢但不断线 ⇒ **永不失败**，逐个把脚本加载完。
3. 真卡住（零进展）时给玩家准确诊断与自救入口，而不是一句 `load timeout`。

**非目标（本次明确不做，用户已裁定）**
- 不按阶段延迟创建 Worker 池（14 个 Worker 各下载 905 KiB 的问题**本次不治**）。
- 生产部署（js-perf.cn）的 gzip/br 与缓存头**不动**，只改仓库内 dev server。
- 不承诺精确剩余秒数/剩余字节。

## 1. 关键设计决策

### DR-1 进度采集器放在 `index.html` 的内联脚本里（唯一权威）

**为什么不能放在 `src/main.js`**：`main.js` 自身是模块图的根，它执行前 874 个模块请求已经
挂出去了。由 JS 创建的采集器会漏掉最重要的那一段 —— 与 v2.51 把占位图写成静态 HTML 是同一个
理由（见 `index.html` 现有注释）。

内联脚本做四件事，全部只依赖 `performance` 与 DOM：
1. `new PerformanceObserver({type:'resource'})` 累计已完成的资源条目（**实测能拿到全部 874 个**，
   而 `performance.getEntriesByType()` 受缓冲区上限只返 250 条）。
2. 按扩展名归类（js/png/json/audio），维护 `{js, other, total}`。
3. 每 100ms 重算一次进度并写 DOM（`requestAnimationFrame` 在后台标签页会停，进度会卡）。
4. 暴露 `window.__MC_LOADING__`，供 `main.js` 与 Playwright 读/驱动。

⚠️ **分母不能靠「数出总数」**：模块图是浏览器边解析边发现边请求的，事前不可知。
用**两段口径**（见 DR-2）而不是猜总数。

### DR-2 三阶段进度口径（各阶段独立权重，不伪造百分比）

| 阶段 | 分母来源 | 进度算法 | 权重 |
|---|---|---|---|
| **P1 脚本与资源** | 未知总数 | `已下载 js 数 → 渐近映射`：`p = 1 - 1/(1 + n/24)`。n=24 → 0.50，n=72 → 0.75，n=200 → 0.89 | 45% |
| **P2 世界生成** | `(2vd+1)²` 个 column | `max(P1 渐近值, ready/total)` —— 见下方修正（实测 vd=2 → 23/25） | 45% |
| **P3 首帧渲染** | 1 帧 | 二值：`setAnimationLoop` 首次回调后置 1 | 10% |

**P1 为什么必须用渐近曲线而不是 n/total**：总数不可知（DR-1）。渐近曲线给玩家「一直在动、
越来越慢」的正确感受，且**永不倒退**。n 恒增 ⇒ p 单调增，天然满足「不倒退」。
分母 24 的取法：实测本地首屏 151 个模块，24 让首个 10% 在最早几秒内发生。

⚠️ **P2 的显示值必须取 `max(P1, P2)`（v2.98 实测修正 DR-2）**：P2 从 `new Game()` 之后就开始，
但 `start()` 里的 GEN 要等 Worker 模块图到齐才跑得起来 —— 慢网络下这段空窗期很长
（实测 200KB/s：worker 首个回包 **90.9 秒**），期间 `stats().ready` **恒为 0**。
只按 `ready/total` 算会让进度条在整个下载期冻在 P1 结束时的值（实测 39.2%，而 js 从 161 涨到 852）。
两者都是「已完成多少」的合法度量，取较大者既单调又不撒谎。权威实现是
`load-progress.js` 的 `p2DisplayFraction()`（有单测钉住）。

**P2 用 `ready` 而不是 `sections`**：`ready` 是 GEN 完成的 column 数（已有 `stats()` 字段，
实测 23/25），`sections` 是网格上传数（同一时刻才 8），后者会让进度条看着像卡住。

⚠️ **P2 的 `total` 必须用 `2*viewDistance+1` 的平方，不是固定数**：视距可由存档/URL 改。

### DR-3 「无进展才失败」取代绝对超时（唯一超时权威）

新增 `src/core/load-watchdog.js`（three-free、无 DOM，同构层规范不适用于它，它是纯计时器）：

```
状态：{ phase, lastProgressAt, phaseStartedAt }
规则：每次进度前进 → lastProgressAt = now
      若 now - lastProgressAt > STALL_MS(=60s) → 判定 stall
```

三处消费：
1. `StructureIndex.waitForRegion` —— 去掉 `timeoutMs` 绝对超时，改为注入 `watchdog` 的
   `stall` 信号（仅通知 UI，不 reject）。
2. `Game._waitForColumn` —— 同上（仅通知 UI）。
3. `main.js` —— P1 阶段同样接入（模块还在下载时不算 stall）。

**必须保留硬上限 + 解释**：`stall` 只能识别「零进展」，识别不了「极慢但有进展」
（每 59s 前进一格可以永远拖下去）。因此**不是**彻底去掉超时，而是把
「绝对超时」换成「**总时长硬上限（默认 10 分钟）+ 零进展检测（60s）**」双判据：

| 判据 | 触发 | 玩家看到 |
|---|---|---|
| 60 s 零进展 | stall | 遮罩出现「网络似乎已断开」+ 已加载 N 个脚本 + **重试 / 继续等待**；等待**继续** |
| 10 min 总时长 | hardCap | 同上；等待**仍继续**（防「每 59s 挪一格」的误导性假进展） |

「继续等待」按钮把两个计时器都重置一次（可反复点，不递增复杂度）。

⚠️ **stall 不 reject，只通知 UI**（实现时确立）：若把 stall 做成 `reject`，`boot()` 会落到
`showError` → 玩家看到「无法启动渲染」错误遮罩，而这正是本 Epic 要消灭的形态。等待循环
**永不因 stall 结束**，只把诊断面板弹出来；资源真到了就照常继续启动。
「不再失败」的边界只有两处：`acceptance` 里的“总时长 hardCap”是**提示**（带重试按钮），
而不是自动失败；真正会中断启动的只剩一个 —— 玩家自己点了「重新加载页面」。

⚠️ **「网络正常但慢」不弹任何提示**：只要还在持续有进展、且总时长未到 hardCap（实测 158 s
那一档离 10 分钟很远），遮罩就是一根正常前进的进度条，不出按钮、不出警告。提示只在
**stall 已发生**或**总时长超 hardCap** 时出现，且都是**提示 + 自救入口**，不是自动失败。

### DR-4 P1 的「卡住」判据要点名「还有多少没下载完」

失败文案必须能诊断：

```
正在等待资源（已加载 812 个脚本，仍在下载 62 个）
网络似乎已断开 · 已等待 60 秒无进展
[继续等待]  [重新加载页面]
```

而**不是** `Error: column (9,8) 加载超时` —— 后者把「网络慢」误报成「世界生成失败」，
玩家照提示换浏览器无效（与 v2.51 修 IndexedDB 误报同一教训）。

### DR-5 `_waitForColumn` 的两条路径**语义不同，不得合并**

出生点（必须到）与恢复位置（去不了就回落 City）是两件事：

| 路径 | 超时行为 | 理由 |
|---|---|---|
| 出生点 `_waitForColumn` | **无超时**，零进展只提示 | 玩家必须能进游戏，慢就等 |
| 恢复位置 `_waitForColumnOrTimeout` | **10 s 硬超时 → 回落 City 出生点** | 既有行为，改成无限等会让玩家卡在 loading 里永远进不去 |

同样地，`waitForRegion`（Worker 未就绪）与 `_waitForColumn`（GEN 未回包）共用 watchdog 的
**进展信号**，但各自保留调用点，不抽「通用等待器」—— 抽了会让「Worker 没起来」与
「GEN 慢」这两个诊断信息合并成一句含糊的 timeout，而这正是当前缺陷的形态。

### DR-6 dev server 加 gzip（只改 `server-script/start-server.js`）

- `Accept-Encoding` 含 gzip ⇒ 文本类（`.js/.mjs/.json/.html/.css/.svg`）用 `zlib.gzipSync` 压缩。
- 实测压缩比预期：`game.js` 204 KiB 源码 → 典型 ~45 KiB；本仓 874 个模块里源码总量 8.1 MiB，
  gzip 后约 2.4 MiB（**必须在实现时实测，不采信估算**）。
- **不加 `Cache-Control`**：本地 dev 无缓存更安全（改了文件立刻生效），且缓存头对「首次冷启动」
  这个被测场景无帮助。生产侧配置清单写进 `docs/`，不动线上。

## 2. 改动清单（文件级）

| 文件 | 改动 | 级别 |
|---|---|---|
| `index.html` | 内联进度采集脚本 + 进度条 DOM/CSS（z-index 仍 95） | Tier 3（DOM）+ 见下方测试 |
| `src/core/load-watchdog.js` | **新增**：进展计时器 + stall/hardCap 判据（纯逻辑） | Tier 1 |
| `src/core/game.js` | `_waitForColumn` 接 watchdog；`start()` 里分阶段上报进度 | Tier 1 |
| `src/gen/structure-index.js` | `waitForRegion` 接 watchdog（去绝对超时） | Tier 1 |
| `src/main.js` | 创建 watchdog、驱动三阶段文案与百分比、stall 时的按钮 | Tier 1（启动时序） |
| `server-script/start-server.js` | gzip | Tier 2（实测断言） |
| `src/tests/test-load-watchdog.js` | **新增**单测 | Tier 1（TDD） |
| `tests/loading-overlay.spec.mjs` | 扩充：慢网络不失败 + 进度单调 | Tier 1（E2E） |
| `docs/roadmap.md` | 登记 | Tier 3 |

## 3. 测试策略（按 `docs/testing-policy.md` 分级）

**Tier 1（必须 RED→GREEN）**
- `src/tests/test-load-watchdog.js`：
  - 有进展 ⇒ 永不 stall（注入假时钟，推进 5 分钟、每 30s 前进一次）；
  - 零进展 60s ⇒ stall 恰好触发一次；
  - `continueWait()` 重置后重新计时；
  - hardCap 10 min 触发；
  - **单调性**：报告值永不倒退（把 `report()` 的历史全量比对）。
- `tests/loading-overlay.spec.mjs` 新增三条 E2E：
  1. **慢网络不失败**：CDP 限速（250 KB/s + 300 ms，即实测能复现失败的那档）下启动，
     最终 `rendererReady === true`、`error === null`。**这条是本 Epic 的主验收**。
     ⚠️ 该用例必须自己 `test.setTimeout(400_000)` —— 全局 200 s 装不下「限速下的完整启动」
     （改前实测 158 s 且失败；加 gzip 后应显著下降，但断言不能依赖这个下降多少）。
  2. **进度单调**：全程采样 `__MC_LOADING__.percent`，断言 `非递减` 且末值 ≥ 99。
  3. **真卡住能诊断**：`page.route` 掐断某一类资源（模拟断网但不断 DNS），断言出现
     「已加载 N 个脚本」的诊断文案 + 两个按钮，且**不出现** `column (\d+,\d+) 加载超时`。

**Tier 2（门禁断言，免 TDD）**
- gzip：起服务后请求 `game.js` 带 `Accept-Encoding: gzip`，断言 `content-encoding: gzip`
  且 `encodedBodySize < decodedBodySize × 0.6`（实测值落地后钉死）。

**门禁**：`npm run check` + `npm test`（改的是启动时序，不碰热路径 ⇒ **不跑 bench**）。

## 4. 风险与已否决方案

| 方案 | 否决理由 |
|---|---|
| 只调大超时（5s→120s、10s→300s） | 实测 158 s 是 2 Mbps 档；绝对超时对未知网络始终是赌（用户裁定） |
| 按阶段延迟创建 Worker 池 | 用户裁定本次不做（能砍掉 ~12 MiB 流量，但是独立改动） |
| 用 `performance.getEntriesByType` 求分母 | 缓冲区上限 250 条，实测漏掉 624 个模块 ⇒ 进度条会在 30% 处冻住 |
| 用 `navigator.connection` 估总时长 | Chrome-only、且给不出可信剩余时间；宁可不说 |
| 把 `_waitForColumn` 与 `waitForRegion` 抽成通用等待器 | 合并会让「Worker 没起来」与「GEN 慢」的诊断信息丢失（DR-5） |
| 由 `main.js` 创建进度采集器 | 采集器执行时 874 个请求已挂出（DR-1） |

## 5. 验收（可测的句子）

1. CDP 限速 250 KB/s + 300 ms 冷启动，`__MC_BOOT__.error === null` 且 `rendererReady === true`。
2. 同一条件下 P1→P2→P3 三阶段文案均出现，`percent` 单调不减，末值 ≥ 99。
3. `page.route` 挂死资源 60 s 后，出现诊断文案与两个按钮；**不出现**任何 `加载超时` 字样。
4. `npm run check` 全绿；`npm test` 全绿；`docs/roadmap.md` 已登记。
5. 本机无节流启动耗时不回退（对照改前 1.45–1.55 s，用交替对照，不取单次）。