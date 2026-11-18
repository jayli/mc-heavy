# 测试分层与耗时治理（设计文档）

> 日期：2026-11-18
> 状态：**待用户批准**（brainstorming 产出，尚未实施）
> 关联：`docs/testing-policy.md`（分级唯一权威，本文不改分级判据，只改**执行编排**）
>
> ⚠️ **本文所有例数/文件数都是 2026-11-18 当时的快照，不得写成冻结断言**。
> 本仓正在并行开发（写作期间另一个 session 就新增了 `test-boss-hint.js`），
> 例数每天都在长。所新增的门禁一律用**关系式**（集合相等 / 派生差集），
> 不得出现 `toBe(2434)` 这类硬编码计数 —— 这正是 policy §3.2 批判的「改动放大器」。

---

## 1. 意图与为什么

用户 2026-11-18：「游戏里积累了大量的测试用例……甚至每次修改一个简单的文案都要全量跑用例，
让任务时间等待用例跑时间很久……有些事关游戏核心逻辑的用例必须保留，有一些边边角角的不重要的
文案、样式等修改，不干扰核心逻辑、渲染过程和性能的测试用例，是不是就不用这么多的保留。」

**痛点不是「用例太多」，是「没有分档入口 + 少数用例吃掉绝大部分时间 + 整页被重复跑」。**
下面的实测把这三条分开了 —— 结论是：**用例数几乎不用动，时间能降一个数量级。**

活样本：本轮调查期间并发会话提交的 `32986c7`「瞬移按钮『丛林』改名『要塞』」只改 3 个文件
（`game.js` 注释 / `settings-panel.js` 常量 / `teleport.spec.mjs` 的 LABELS），按 policy 它是
**Tier 3（免测试，只跑 `npm run check` = 2.6s）**，却牵动 `teleport.spec.mjs` 11 例
（`test.setTimeout` 最长 **300s**）。

---

## 2. 现状实测（本机 2026-11-18，全部是跑出来的数，不是文档里的旧值）

### 2.1 规模

| 项 | 实测 |
|---|---|
| 浏览器内单测 | **115 文件 / 2434 例** |
| Playwright spec | **99 文件 / 423 例**（`--list` 口径） |
| 另被当正式用例跑的 `tmp-*` 探针 spec | 12 文件 / 14 例（合计 437） |
| 单测 assert 总数 | 7629 |
| spec expect 总数 | 前三：zombies 147 / ignis 138 / teleport 108 |

### 2.2 时间去哪了 —— 单测侧（整页 150~167s，两次实测）

| 分组 | 用例数 | 耗时 | 占比 |
|---|---|---|---|
| 最慢 **6** 条 | 6 | **98.8s** | **59%** |
| 最慢 **21** 条 | 21 | **137.6s** | **82%** |
| 其余 | **2345** | **7.4s** | **4.4%** |

最慢 6 条（全部是「真实 GEN 全量扫描」）：

| 耗时 | 用例 | 文件 |
|---|---|---|
| 37.8s | 金字塔/平地岛/海岛/雪原/冰封山地标内零巨树 | `test-giant-trees-gen.js:252` |
| 19.3s | 浅水高台缓坡草地真的长出植物 | `test-shallow-tarn-gen.js:88` |
| 11.3s | 丛林要塞树密度减半 | `test-jungle-fortress-gen.js:674` |
| 11.2s | 大竞技场占地内不得残留雪原地表 | `test-burning-arena-gen.js:576` |
| 9.9s | 城市 bounds 内零巨树 | `test-giant-trees-gen.js:203` |
| 9.2s | 废弃堡垒占地内不得残留雪原地表 | `test-ruined-citadel-gen.js:581` |

**成本结构是 column 数 × 每 column 完整 GEN，不是断言数。** 例：浅水高台
`SHALLOW_TARN_OUTER_RADIUS = 119.3` ⇒ 方形 column 网格 **16×16 = 256 个 column**，
每个走 `fillColumn + carveCaves + applyStructuresToColumn`（含 9 个 region 布局）。

### 2.3 时间去哪了 —— spec 侧

| 事实 | 实测 |
|---|---|
| 真游戏页 `goto` 次数 | **282**（423 例，零复用：无 `beforeAll` / `describe.serial`） |
| 一次 boot 到 `worldReady` | vd=2 **1.49s** / vd=4 **1.37s** / vd=8 **1.96s** |
| 固定 `waitForTimeout` | **170 处，合计 270.4s** 纯 sleep |
| 历史全量耗时 | 常态 **3.2min**；高负载曾 **32.1min**（roadmap v3.13e） |

### 2.4 整页被跑了 4 遍（本轮最刺眼的浪费）
| spec | 干了什么 | 等待窗口 |
|---|---|---|
| `harness.spec.mjs` | 跑整页，判 `total>0 && failed===0` | 150s ✅ |
| `weapons-logic.spec.mjs` | **只**判 `failed===0`（1 个 expect） | **90s** ❌ |
| `world-editor.spec.mjs` | **只**判 `failed===0`（1 个 expect） | **90s** ❌ |
| `zombies.spec.mjs:657`「30 只压力」 | 先等整页跑完，再自建 fixture | **100s** ❌ |
| `atlas.spec.mjs:22` | `goto` 整页**只为同源 fetch**（不等 RESULTS） | — |

后三个的窗口 **< 实测整页 150s** ⇒ **结构上必红**，与用例本身对错无关。
`weapons-logic` / `world-editor` 的断言是 `harness` 的**真子集**（零额外判别力）。
`zombies` 那条的真判据（30 容量 / 第 31 只被拒）**完全不依赖整页**，等整页纯属搭便车。

⚠️ **`harness` 自己的 150s 窗口也已经贴线**（本轮新发现，既有问题）：
同机三次整页实测 **150.3s / 167.5s / 147.7s** ⇒ 150s 窗口是「掷硬币」。
本轮修完 bgm 后跑 `harness.spec` 实测 **超时红**（`Timeout 150000ms exceeded`），
当时 **load average 17.88 / 69 个 Chrome**（并发会话也在跑测试）。
**这不是本轮引入的**：167.5s 那次在改动之前就必红。
按项目规则（冻结数字不符时停下报告、不擅自放宽阈值）**本轮不改该窗口** ——
§5.4 的无损筛/抽样把整页降到 20~30s 后，这条贴线问题**自然消失**，那是正确的修法。

### 2.5 大半单测不需要浏览器（决定性发现）

在 Node 里直跑生产代码实测（探针已删，数字留档）：

| 条件 | 结果 |
|---|---|
| 裸 Node（无任何垫片） | **63 文件 / 1147 例全绿 / 23.3s**；其中 **51 文件 / 868 例仅 1.08s** |
| **+ `fetch` 垫片 + `three` loader（最终方案口径）** | **100 文件 / 2065 例全绿**，只剩 **15 文件 / 369 例**需要浏览器 |
| + 假 DOM 垫片 | ⚠️ **不可用**：`test-player-place` 23 例仍全红（`window.addEventListener`），`test-bgm` 17 红（AudioContext），`test-iso-icon` 4 红（`createImageBitmap`）—— 假 DOM 只能造出**假绿或假红**，不纳入方案 |

**最终口径下的耗时分解**（5 并发实测，含 CPU 争抢；串行时重档更快、轻档基本不变）：

| 分组 | 规模 | 耗时 |
|---|---|---|
| Node 全绿总 | 100 文件 / 2065 例 | 262.7s（5 并发） |
| 其中 **6 个重 GEN 文件** | 6 文件 / **155 例** | **217.7s（83%）** |
| 其余轻档（**串行实测**） | 94 文件 / **1910 例** | **36.0s**（import 138ms + 执行 35.8s） |

⚠️ **口径纠正**：本文早期版本写过「轻档 4.4s」，那是**只把 <1s 的文件相加**得到的，
不是轻档总耗时。串行实测轻档全量 = **36.0s**（墙钟 36.2s，含 node 启动）。
所以日常门的真实量级是 **数十秒**，不是 1 秒；要再降就得把轻档里的大头再分一层
（实施时逐文件量，参 §7）。对比基准仍是：**整页 150s → 轻档 36s**，而且日常改文案
根本不需要跑轻档全量（只跑 `check` 2.6s + 对应档）。

**留浏览器的 15 个文件与各自原因**（实测报错，不是猜）：

| 文件 | 失败/总 | 缺什么 |
|---|---|---|
| `test-inventory-ui.js` | 25/25 | `document` |
| `test-player-place.js` | 23/23 | `window` |
| `test-bgm.js` | 17/28 | `window`（AudioContext） |
| `test-player-input.js` | 15/15 | `window` |
| `test-perf.js` | 4/8 | `document` |
| `test-minecarts.js` | 4/54 | `document`（canvas） |
| `test-iso-icon.js` | 4/24 | `createImageBitmap` |
| `test-atlas-mip-safety.js` | 3/6 | `document` |
| `test-ui.js` | 3/30 | `Image` |
| `test-zombie-nests.js` | 3/33 | `indexedDB` |
| `test-block-registry.js` | 2/24 | `window` |
| `test-ignis-bake.js` | 2/49 | `createImageBitmap` |
| `test-resource-url.js` | 1/6 | `location` |
| `test-turret-plant-place.js` | 1/7 | `window` |
| `test-turrets.js` | 1/37 | `indexedDB` |

⚠️ 这 15 个里多数只**少数几例**需要浏览器（如 `test-turrets` 37 例里只 1 例）。
本轮**不拆文件**（拆文件会动 `index.html` 注册与 `check:data` 门），整个文件留浏览器。

`fetch` 垫片为什么必需且安全：`resourceUrl()` 用 `import.meta.url` 解析，在 Node 下产出
`file://…`（不是 `/assets/…`），垫片把 `file://` 读成本地文件即可。**它不改任何生产代码**，
也**不模拟浏览器语义**（只补「读文件」这一件 Node 天生没有的事）。

真正离不开浏览器的只有两类：**DOM/Canvas/AudioContext/Image** 与 **GPU 像素（Tier 4）**。

### 2.6 可直接清的死物（已核实零引用）

- `tests/weapons-logic.spec.mjs` / `tests/world-editor.spec.mjs`：`grep` 全仓 `tools/` /
  `docs/testing-policy.md` / `CLAUDE.md` / `package.json` **零引用**。
- `src/tests/` 下 **6 个零引用 fixture 页**（614 行）：`test-lamp-compare.html`(168) /
  `test-lamp-lite.html`(87) / `test-step-icon-methods.html`(133) / `test-step-icons.html`(98) /
  `test-turret-metal.html`(86) / `tmp-bgm-ramp.html`(42)。逐个核对：**没有任何 spec 引用**。
- `tests/tmp-tarn-probe.spec.mjs.bak`（1257 字节，`.bak` 不被 playwright 收集，纯残留）。

---

## 3. 目标 / 非目标 / 反目标

**目标**
1. 日常改动（文案 / 样式 / alias / 数据登记）的门降到**秒级**（`check` 2.6s + 对应档），
   且**不需要人记住该跑哪个**。
2. 整页单测从 150s 降到 **20~30s** 量级（靠 §5.4 的无损筛/抽样）。
   Node 轻档全量实测 **36.0s**，作为日常开发的全量单测入口（比整页快 4 倍且无需浏览器）。
3. 消除「结构上必红」的重复转发 spec。
4. **零判别力损失**：不删任何一条钉不变式的断言。

**非目标（本轮不做）**
- 不改 `docs/testing-policy.md` 的**分级判据**（Tier 1~4 的定义不动）。
- 不删/合并「钉文案与 CSS 值」的用例（那是选项 C，用户本轮选了 B）。
- 不清 `tests/tmp-*` 探针（用户明确只选了前两项死物）。
- 不动 `bench` 的四场景与冻结基线。
- 不改任何 spec 的**断言与阈值**（只改等待窗口与编排）。

**反目标（做成了也算失败）**
- 用「放宽阈值 / 拉长超时」换绿。
- 用假 DOM 把浏览器用例搬进 Node，造出「Node 全绿但浏览器仍红」的第二套语义。
- 分档漏标 ⇒ 静默全跑或静默不跑（比慢更危险）。

---

## 4. 三条路线与取舍（用户已选 B）

| 路线 | 内容 | 代价 | 收益 |
|---|---|---|---|
| A | 只加分档入口 + 清死物 | 长尾仍在，整页仍 150s | 日常门秒级，零风险 |
| **B（选定）** | A + Node 快档 + 最慢 6 条有原理抽样 | 新增 runner/垫片（Tier 1，须自测）；抽样要逐条论证据 | 整页 20~30s，日常门 1s |
| C | B + 删钉值用例 | **删用例不可逆**，须逐条判「钉值 vs 钉不变式」 | 用例数实质下降，风险最高 |

选 B 的理由：它解掉「等待久」的三个根因，而**不删任何真判据**；C 的增量收益小、风险大，
可以之后单独做。

---

## 5. 设计

### 5.1 分档：按**文件清单**分档，不按 test 标签

**为什么不用 `@core` / `@slow` 标签 + `--grep`**：`--grep` 对**未打标签**的用例默认全跑
⇒ 漏标一个文件就静默回到全量，正是 policy 反复警告的「静默失效」。
文件清单是**闭合集合**，可以做双向门禁。

**唯一权威**：新增 `tools/test-tiers.mjs`，导出

- `UNIT_NODE_SAFE`：可在 Node 跑的单测文件白名单（**实测得出，不靠猜**，见 §5.3）
- `UNIT_BROWSER_ONLY`：其余单测文件（= 全集 − 白名单，**派生**，不写第二份）
- `SPEC_TIERS`：`{ core: [...], struct: [...], ui: [...], pixel: [...], slow: [...] }`
  按 §2 的实测分组（spec 侧 99 个文件全部归档，一个不漏）

**门禁（新增到 `check:data`）**：
- `tests/*.spec.mjs`（排除 `tmp-*`）的集合 **≡** `SPEC_TIERS` 各档并集，**双向**：
  漏归档 = 报错，归档了但文件不存在 = 报错。
- `UNIT_NODE_SAFE ∪ UNIT_BROWSER_ONLY ≡ src/tests/test-*.js` 全集。
- 白名单里的每个文件必须**仍在 `index.html` 的 import 里**（见 §5.2 的零覆盖损失原则）。

### 5.2 整页单测：加 `?only=`，但**注册照旧全量**

⚠️ **实测发现的前置缺口（必须先补，否则 `?only=` 结构上不可能）**：
现有 115 个文件全用**裸 `test()`**（不用 `describe`），而 `runner.js` 对裸 `test()` 的处理是
「每条用例新建一个名为 `Default Suite` 的 suite」⇒ 实测整页 **2434 个 suite 全叫
`Default Suite`、每个 1 例**，**runner 手里没有任何文件归属信息**。
所以「按文件/档位过滤」必须先把文件归属补上。

**落地机制（零改 115 个测试文件、零改 `index.html`）**：

⭐ **实施前的决定性实测（推翻了原计划的改法，风险大降）**：
六个重 GEN 文件的 **import 期合计只有 209ms**（逐文件 204/1/1/0/1/1ms），
而它们的**执行期是 217.7s** ⇒ **成本全在 test 体内，不在模块顶层**。
⇒ `?only=` **只需过滤「执行」，不需要过滤 import** ⇒ `index.html` 的 115 行静态 import
**一字不改** ⇒ `check:data` 的注册正则（`tools/check-data.mjs:322`）**也不用改**
⇒ 原计划里「最容易静默破门的一步」**结构上消失了**。

1. `runner.js` 给每个 suite 记**文件归属**：优先用显式 `setCurrentFile()`（Node 快档用），
   否则从 `new Error().stack` 里取**最外层的 `test-*.js` 帧**。
   ✅ 实测两侧都可行：浏览器栈帧带 `http://…/src/tests/test-x.js:3:17`，
   Node 带 `file:///…/src/tests/test-x.js:9:16`，同一正则可提取。
   ⚠️ **取最外层而不是第一个**：实测「helper 文件里注册」时栈是
   `[helper.js, owner.js]`，取第一个会归到 helper（错）；取最外层得 owner（对）。
   当前仓内**无跨文件注册**（已 grep 确认），但这一条防将来静默归错。
2. `?only=<文件名或档位名>` / `?tier=fast|slow|all` 只影响 `runAllTests()` 跑哪些 suite。

✅ **`check:data` 的 `[测试注册]` 门不受影响**：`index.html` 一字不改，该门的正则
（`/import\s+'\.\/(test-[^']+\.js)'/g`，`tools/check-data.mjs:322`）继续成立。
实施后仍跑一次确认它绿。

**附带收益**：suite 名从 `Default Suite` 变成文件名 ⇒ 整页失败时能直接看出是哪个文件，
现在只能看到用例标题（本轮调查就因此多跑了一轮探针）。

⚠️ **白名单文件仍留在整页全集**（`?only` 缺省 = 全跑），Node 快档只是「额外的更快入口」，
**不是替代**。这样零覆盖损失；整页时间的下降**全部来自 §5.4 的 GEN 抽样**。

`harness.spec.mjs` 跑**默认全集**（含抽样版）。新增 `tests/unit-fast.spec.mjs` 跑
`?only=<轻档>` 作为日常门；新增 `tests/harness-slow.spec.mjs` 跑 `?only=<慢档>`（全量 GEN）。

**⭐ 零覆盖损失的准确定义（消除一处看似矛盾）**：
「零覆盖损失」指的是 **`npm test` 仍覆盖全部判据**，不是「每个入口都覆盖全部」。
因为 `npm test` 跑全部 spec，`harness`（默认档）+ `harness-slow`（全量档）**两个都在里**
⇒ 全量 GEN 判据在提交前门上**一条不少**，只是日常门不跑它。
这正是用户选的「有原理抽样，保留全量在慢档」，不需要拆文件、也不丢覆盖。

**全量版怎么与抽样版共存于同一文件**：`runner.js` 的 `test()` 加一个可选第三参
`{ tier: 'slow' }`（缺省 `fast`）。同一文件里写两条用例：抽样版（缺省）+ 全量版（`tier:'slow'`）。
`?only=` 除了按文件名，还按 tier 过滤：缺省跑 `fast`，`?tier=slow` 跑 `slow`，
`?tier=all` 两者都跑。**这是 runner 的最小扩展，不引入第二套测试框架。**

⚠️ **`only=` / `tier=` 失配必须硬失败**（reviewer 指出的真缺口）：
现有 harness 判据是 `total>0 && failed===0` ⇒ `only=` 拼错一个名字、或过滤后为空，
会「少跑 2000 例仍全绿」。故：
- runner 对**未知文件名 / 未知档位名**直接抛错（不静默忽略）；
- 过滤后匹配数为 0 时抛错；
- `unit-fast.spec` / `harness-slow.spec` 必须钉「**实际跑到的文件集合 ≡ 清单**」
  （从 results 的 suite 名派生，不只看例数）。

### 5.3 Node 快档：`tools/run-unit-node.mjs`

组成（全部是**测试侧**代码，生产代码零改动）：
1. `fetch` 垫片：`file://` → `fs.readFileSync`（§2.5 已实测）
2. `three` 解析映射：`three` / `three/tsl` / `three/webgpu` / `three/addons/*` → `vendor/three/`
   （用 Node 的 `module.register` loader；**不改 `package.json` 的 imports 字段**，避免影响
   生产解析口径）
3. **不加 DOM 垫片**（§2.5 实测它只造假绿/假红）

**白名单怎么定**：逐文件在「fetch + three 垫片、无 DOM」条件下跑，**failed === 0 才入选**。
这份实测清单是白名单的唯一依据，写进 `tools/test-tiers.mjs` 的注释（含实测日期与例数）。

**准入还要加一条静态判据**（防将来引入第二套语义）：白名单文件**不得断言 URL 形状 / origin /
同源语义**（`location.origin`、`url.startsWith('/assets/')` 这类）—— Node 下 `resourceUrl()` 必为
`file://`，这类断言通过与失败的原因会与浏览器不同。
✅ **已逐文件核实当前白名单干净**：扫到 6 个文件含 `.origin` 字样，逐个读后确认全是
**Blockbench `rotation.origin` / 实体锚点 `origin` / 射线 `aim.origin`**，与 URL 无关；
仅两处 `new URL(..., import.meta.url)` 是 fetch 资源路径（正是垫片要处理的），无形状断言。
（`test-resource-url.js` 真的断言 `parsed.origin === location.origin`，它已在 browser-only 档。）

**自测（runner 属 Tier 1，policy §9）**：新增 `src/tests/test-unit-node-runner.js`
钉三条不变式：
- 白名单 ⊆ 全集，且与 `index.html` 注册一致（与 `check:data` 交叉）
- 垫片**不改** `resourceUrl` 的返回值语义（`resourceUrlFrom` 纯函数已有单测，这里只钉
  「垫片只在 `file://` 分支起作用，`http(s)://` 原样透传」）
- **负向验证**：把某个白名单文件的生产代码注入缺陷 → Node 快档必须真红（证明快档不是空转）

⚠️ **执行侧的命名冲突（reviewer 指出，已解）**：`src/tests/test-*.js` 必须在浏览器内跑，
而浏览器无法 spawn Node。故拆两侧：
- **Node 侧自测放 `tools/test-unit-node-runner.mjs`**（`.mjs` 不匹 `check:data` 的
  `/^test-.*\.js$/` 正则 ⇒ **不进注册门、不需开例外**），由 `npm run test:unit` 启动时先跑；
  它验「白名单完整性 / 垫片分支 / per-file 例数对账」。
- **浏览器侧**只在既有 `test-resource-url.js` 里补「`resourceUrlFrom` 对 `file://` 基址也正确」
  一条（纯函数，不需 Node）。

**per-file 例数对账（防静默丢文件）**：白名单文件将来若因生产代码新增 DOM 依赖而在
**import 期**抛错，该文件 0 例注册而 `failed===0` 依旧全绿。故 Node runner 必须：
- import 失败 **硬失败**（不得 catch 后继续）；
- 每个白名单文件**至少注册 1 例**，否则硬失败；
- 例数用**关系式**而非冻结计数（policy §3.2）：钉「各文件例数之和 ≡ `runAllTests().total`」
  与「白名单文件集 ≡ 实际有 suite 的文件集」，**不写 `toBe(2065)`**（例数每天在长）。

### 5.4 最慢 6 条：有原理抽样，全量保留在慢档

**原则（roadmap v1.42 已建立先例）**：抽样口径必须**按「缺陷会出现在哪」排序**取，
不是随机取、更不是「取第一个」。原全量扫描**保留**，挪进 `slow` 档。

逐条口径（实施时须先跑一次打印实际值再定常量 —— policy §2.6 ⑤）：

| 用例 | 现状 | 抽样口径（待实施时实测定标） |
|---|---|---|
| 浅水高台缓坡植物 19.3s | 方形 256 column | **圆形湖 ⇒ 只生成与圆相交的 column**：实测 **208/256（省 18.8%）**，且这是**无损**的（四角 column 与判据无关，原判据已 `cols.has()` 跳过它们）。另按「缓坡带草地格密度」降序取前 N 个 column，全量留慢档 |
| 地标零巨树 37.8s | 5 类地标 × 半径 60~110，小地标取**全部**实例 | 大地标各取 1 个（现状已是）；小地标按「不排除时会闯入的树数」**降序**取前 N 个 —— 判别力由「对照 intruders > 0」保证（该断言已在用例里） |
| 城市零巨树 9.9s | 全城 bounds 逐格 | 按「基线里确有树」的 column 降序取前 N（无树的 column 对本判据零信息） |
| 丛林要塞树密度 11.3s | 全部「本来会种树」的列 | 伯努利抽样 ⇒ 按二项分布定 N 使 95% 置信区间落在 [0.40,0.60] 内；**判据区间不变** |
| 大竞技场排雪原 11.2s | **5 个显式雪压 seed** × 占地全部 column（每 seed 49） | ⚠️ **seed 不能减**（`coveredSeeds >= 4` 是硬断言）。只减 column，而且是**几何无损筛不是抽样**：只生成「16×16 范围与某座雪原盒（含过渡带）相交」的 column。**已实测：245 → 67 个，省 72.7%**（逐 seed：20/16/15/6/10）。不相交的 column **结构上不可能**出现雪原方块 ⇒ 零判别力损失 |
| 废弃堡垒排雪原 9.2s | 同上 | 同上手法（实施时重测它自己的比例） |

**两条纪律**：
- 抽样后**必须重跑负向验证**（撤销对应的生产接线 → 快档仍须真红）。抽样的合法性完全靠这一步。
- 原判据的**上下界与对照断言一个字不改**（`grassCells > 3000`、`intruders > 0`、
  `coveredSeeds >= 4`、`ratio ∈ [0.40,0.60]` 等）。若抽样后某个下界达不到，**停下来报告**，
  不擅自放宽 —— 那说明抽样口径选错了。

**⭐ 优先用「几何无损筛」而不是「抽样」**（本轮实测得出的重要区分）：
上表里有三条根本不需要抽样，只需把「结构上不可能命中的 column」排除：
- 浅水高台：方形 256 → 圆内相交 **208**（省 18.8%）
- 大竞技场排雪原：245 → **67**（省 **72.7%**）
- 废弃堡垒排雪原：同手法

这三条的判别力**逐格不变**（排除的格本来就不在判据范围内），所以**不需要负向验证重新论证**，
只需确认「改动前后 violations/found 计数逐位相同」。真正需要抽样论证的只有剩下三条
（地标零巨树 / 城市零巨树 / 丛林要塞树密度）。实施时**先做无损筛那三条**，
量完降幅再决定剩下三条要不要抽样。

### 5.5 删死物（用户已批准这两项）

| 目标 | 处置 | 依据 |
|---|---|---|
| `tests/weapons-logic.spec.mjs` | 删 | 断言是 harness 真子集；窗口 90s < 150s 必红；全仓零引用 |
| `tests/world-editor.spec.mjs` | 删 | 同上 |
| `tests/zombies.spec.mjs` 那条 30 只压力 | **不删用例**，只去掉 `goto(index.html)` + 等 RESULTS 两行，改 `goto` 一个**空白 fixture 页**（带 import map）；断言一字不动 | 真判据完全不依赖整页；**已实测**，见下 |
| `tests/atlas.spec.mjs:22` | 同上换成空白 fixture 页 | 它只为同源 fetch，却触发整页 2434 例 |
| 6 个零引用 fixture 页 + `.bak` | 删（7 个文件，逐个 literal 路径） | §2.6 已核实零引用 |

**已实测验证（本轮探针，不是推测）**：建一个只有 import map 的空白页
`src/tests/tmp-blank-probe.html`（15 行），把 `zombies.spec:670-712` 的 import 与 fixture 构造
**逐字复刻**跑一遗：

| 目标页 | 就绪耗时 | 30 只压力用例的五个读数 | atlas 同源 fetch |
|---|---|---|---|
| **空白 fixture 页** | **19ms** | `spawned 30 / count 30 / activeSlots 30 / meshCapacity 30 / over null` | `tiles 174 / size 2048` ✅ |
| `index.html`（现状） | **147723ms** | **逐位相同** | **逐位相同** |

⇒ **19ms vs 147.7s = 7775 倍**，而断言值与 fetch 结果完全一致，`pageerrors: none`。
`import('/src/...')` 与 `import('three')` 在空白页下**全部正常解析**。
新页另已跑 `npm run check:arch` 确认**不碰资源 URL 门**（它扫 `src/**/*.html`，
而 import map 写的是 `../../vendor/...` 相对路径，合规）。

⚠️ 实施时该页要改成**正式文件名**（如 `src/tests/fixture-blank.html`），不能留 `tmp-` 前缀。

### 5.6 npm 入口（新增，不改既有 `test` 的覆盖范围）

```
npm run check          # 既有：arch + data + lint（2.6s）—— 日常最小门，不变
npm run test:unit      # 新：Node 快档（白名单）
npm run test:fast      # 新：check + test:unit + unit-fast.spec + core 档 spec
npm run test:core      # 新：引擎/协议/物理/编辑 core 档 spec
npm run test:ui        # 新：UI/文案/面板档 spec
npm run test:pixel     # 新：Tier 4 像素档
npm run test:slow      # 新：全量 GEN 扫描 + 结构落地档
npm test               # 全部（里程碑/提交前）
```

⚠️ **`npm test` 必须串上 Node 快档与慢档，否则新入口是假门**（reviewer 指出的真风险，
本仓已有先例：`giant-tree-budget.spec` 静默红六天，就因为 `npm run check` 不跑它）：

- `npm test` = `node tools/run-unit-node.mjs && playwright test`
  ⇒ **覆盖范围只增不减**（新增 Node 档，原 423 例一条不少），符合「语义不变」的本意；
- `harness-slow.spec.mjs` 作为**普通 spec 落在 `tests/`**⇒ `playwright test` 天然收集它，
  全量 GEN 在提交前门上**默认仍跑**，不靠人记；
- 日常快档（`test:fast` / `test:ui`）才是不跑慢档的那个。

⇒ 全量 GEN 的耗时**只在日常门上省下来**，提交前门仍付全额 —— 这是「零判别力损失」的必然代价，
也是用户选「保留全量在慢档」的本意。

**policy §6 的门禁映射表新增一列「命令」**，把「改文案 → `npm run check`」写成可直接执行的形式。
分级判据本身不动。

### 5.7 `tmp-*` 探针：本轮不删，但**不再进正式门**

用户明确本轮不清 `tmp-*`，所以**文件不动**。但实测发现它们正在吃掉本轮收益：
当前 `tests/tmp-*.spec.mjs` **7 个（并发会话又新增了 2 个），全部 `goto('/src/tests/index.html')`**
⇒ `npm test` 里藏着 **7 次额外的整页重跑**，其中 `tmp-boss-hit-detail` 的窗口是 **420s**。
`.gitignore` 只忽略入库，**不影响 playwright 收集**（config 无 `testIgnore`）。

**做法**：给 `playwright.config.mjs` 加 `testIgnore: 'tmp-*'`。
这是「不删文件、只不再当正式用例跑」，与用户「不清 tmp」不矛盾（探针仍可用
`npx playwright test tests/tmp-x.spec.mjs` 显式单跑）。⚠️ 这一条需用户确认（见 §9）。

---

## 6. 验证计划（实施后必须跑，逐项附实测）

1. `npm run check` 全绿，**新增的分档门禁**双向判别力：故意漏归档一个 spec → 真红；
   归档一个不存在的文件 → 真红。
2. `npm run test:unit` 全绿，例数与白名单实测一致；**负向验证**：注入一个生产缺陷 → 真红。
3. `npx playwright test tests/harness.spec.mjs` 全绿，**整页耗时实测**（目标 20~30s，
   附改动前后对照；用交替对照，不看单次 —— policy §2.6 ①）。
4. 6 条抽样用例**各自重跑负向验证**（撤销对应生产接线 → 快档真红），并确认全量版在
   `test:slow` 下仍全绿。
5. 删死物后正式 spec 数 = 99 − 2 = **97**（口径：**排除 `tmp-*`**，与 §5.7 的 `testIgnore` 一致；
   实施时从 `--list` 现读，不写硬编码），且 `check:data` 的 `[测试注册]` 仍绿
   （✅ `index.html` 不改 ⇒ 该门结构上不会被碰；仍跑一次确认）。
6. `?only=` 的零覆盖损失验证：各档例数之和 **≡ 全量例数**（两边都从运行时读，不写硬编码）；
   且 suite 名不再是 `Default Suite`（文件归属真的生效）。
7. `zombies` 30 只压力 / `atlas` 换页后**单跑通过**，断言未改（已有探针实测打底，§5.5）。
8. 新增/改动文件单独 `npx eslint` **0 error 0 新 warning**（全仓基线 60，不得把新增算进基线）。

---

## 7. 留给实施者的判断

- 抽样常量 N 的具体取值：**必须先跑一次打印实际分布再定**，本文只给口径。
- `SPEC_TIERS` 里 `core` / `struct` / `ui` / `pixel` 的边界：按 §2 的「有无游戏页 / 有无像素」
  三类实测分组落地，个别文件归档有歧义时按「它守的失效路径」判，不按文件名判。
- `?only=` 的档位名与 `tools/test-tiers.mjs` 的字段名如何对齐（两边不得写第二份清单）。
- 分档命令的 wrapper 实现（读清单传文件列表 + 空集合硬失败）、`module.register` 的 Node 版本要求。
- 抽样常量 N（见 §5.4，必须先实测分布）。

**已裁定、不得再问的项**（用户 2026-11-18 明确选定）：
- 路线 **B**（分层 + Node 化 + GEN 抽样），不做选项 C（不删钉值用例）。
- 最慢 6 条：**有原理抽样/无损筛，全量保留在慢档**。
- 死物只删两项：**4 处重复整页转发** + **6 个零引用 fixture 页及 `.bak`**。
- `tmp-*` 探针：**文件不动**，加 `testIgnore: 'tmp-*'` 让它们不再进正式门。
- bgm 那条既有失败：**先修绿再做分层**（已完成，见 §9）。

---

## 8. 已实测确认的关键数字（供实施时对账）
- 整页：**150.3s / 167.5s / 147.7s / 163.8s**（四次，负载不同）；例数 2434 → 2454
  （并发会话新增 `test-boss-hint.js` 20 例）；**修完 bgm 后 failed=0**
- `harness.spec` 的 150s 窗口：实测整页 163.8s ⇒ **超时红（非断言失败）**，属既有贴线问题
- 最慢 6 条 **98.8s**；最慢 21 条 **137.6s**；尾部 2345 条 **7.4s**
- Node 裸跑全绿 **63 文件 / 1147 例 / 23.3s**；其中 **51 文件 / 868 例 / 1.08s**
- **最终口径（fetch + three 垫片、无 DOM）：100 文件 / 2065 例全绿**；
  6 个重 GEN 文件 155 例占 **217.7s**（5 并发）；轻档 **94 文件 / 1910 例 串行 36.0s**；
  留浏览器 **15 文件 / 369 例**
- boot：vd=2 **1486ms** / vd=4 **1369ms** / vd=8 **1956ms**
- 固定 sleep 合计 **270410ms**
- 浅水高台 column：方形 **256** → 圆内相交 **208**（省 18.8%，无损）
- 大竞技场排雪原 column：5 seed × 49 = **245** → 与雪原盒相交 **67**（省 **72.7%**，无损；
  逐 seed 20/16/15/6/10）
- 空白 fixture 页就绪 **19ms** vs 整页 **147723ms**（**7775 倍**）；30 只压力五个读数逐位相同
  （spawned/count/activeSlots/meshCapacity 均 30、over null），atlas fetch tiles 174 / size 2048，
  pageerrors none
- 整页 runner 现状：**2434 个 suite 全名 `Default Suite`**（无文件归属，`?only=` 的前置缺口）

---

## 9. 前置修复：bgm 那条间歇失败（已完成，2026-11-18）
用户裁定「先修绿它，再做分层」。按 systematic-debugging 四阶段定位，**根因不是音频代码缺陷，
是用例等错了时钟**：

**Phase 1 证据链**（每一步都实测，两个假设被推翻）：
1. 隔离复现：**PASS**（音量 20ms 内就收敛到 0.15）⇒ 不是恒红。
2. 假设「音频时钟被饿死」→ **推翻**：整页跑重 GEN 期间采样 12 次，
   音频钟与墙钟 **1:1 推进**（0/12 低于 0.05s）。
3. 假设「全局 AudioContext 被前面用例挂起」→ **推翻**：全仓只有 `test-bgm.js` 碰
   `AudioContext`，且采样 state 恒 `running`。
4. 重跑整页 ⇒ 那次 **failed=0**（前两轮 failed=1）⇒ 确认是**间歇型**。
5. 隔离连跑 8 轮全 PASS，但同页采样里捕到 **`setTimeout(200)` 实际 53790ms 才回调**。

**根因**：three 的 `setVolume()` 是 `gain.setTargetAtTime(v, context.currentTime, 0.01)`
（`vendor/three/three.core.js:51692`）—— 指数逼近、走 **AudioContext 时钟**，
误差 `0.85·e^(-t/0.01)`，容差 0.02 ⇒ 需音频时间 **≥ 0.0375s**。
而用例等的是 **墙钟 `setTimeout(200)`**；整页重 GEN 占住主线程时定时器被饿死
⇒ 读音量时斜坡没走完 ⇒ 断言以错误的原因失败。
（附带发现：`audio-manager.js:457` 的注释写「linearRampToValueAtTime」，与 three 实际的
`setTargetAtTime` 不符 —— 属注释陈旧，本轮不改生产代码。）

**修法**（`src/tests/test-bgm.js`，只改测试侧）：新增 `waitAudioClock(ctx, seconds, capMs)`，
按「音频时钟推进 ≥ 0.05s（5 个时间常数）」等待，带 5s 墙钟上限兜「context 真被挂起」。
**容差 0.02 与所有断言一字未改**，不是放宽阈值。

**负向验证（用 `page.route` 在浏览器侧换文件，不碰工作树）**：

| 侧 | 结果 | actual 读数 |
|---|---|---|
| 修好的实现（隔离 12 轮） | **12/12 PASS** | 0.152408~0.154112 |
| 注入「只改意图不写 setVolume」 | **0/3 PASS**（真红） | 恒 **1** |

等待墙钟从固定 200ms 降到 **50~97ms**（条件满足即返回）⇒ 顺带变快。
`npx eslint src/tests/test-bgm.js` **0 error 0 warning**。

**整页终极确认（实测）**：`total=2454 failed=0`，该条 **`passed` / 54ms**，`pageerrors: none`。
⇒ bgm 修复在真实整页环境下成立（不只是隔离夹具）。

⚠️ **但 `harness.spec` 本轮仍红了一次，原因是超时不是断言**：
`TimeoutError: page.waitForFunction: Timeout 150000ms exceeded`。
同环境下把窗口放宽到 300s 的诊断探针量到整页真实耗时 **墙钟 163767ms / 内部 161094ms**
（当时 load average 峰值 **17.88**、**69 个 Chrome**，并发会话也在跑测试）。
⇒ **150s 窗口本身已不够**，与 bgm 改动无关（本轮三次基线 150.3 / 167.5 / 147.7s）。
按项目规则**本轮不改该窗口**；§5.4 把整页降到 20~30s 后这条贴线自然消失。
（另：该次命令接了 `| tail` 管道，`exit=0` 是 `tail` 的退出码而非测试的 —— 项目已记过这个坑。）

⚠️ **本轮只改了这一处生产无关的测试文件**；分层实施尚未开始（待本文批准）。

---

## 10. 实施记录（2026-11-18，用户批准后）

### 10.1 实施前的两个实测，改掉了原计划

**① `index.html` 根本不用改**（原计划最大的风险点消失）：
六个重 GEN 文件的 **import 期合计仅 209ms**（204/1/1/0/1/1），而执行期 217.7s
⇒ 成本全在 test 体内 ⇒ `?only=` 只需过滤**执行**。于是：
- `index.html` 的 115 行静态 import **一字未改**（只追加了新测试文件的注册行）；
- `check:data` 的注册正则**不用改** ⇒ 「115 个文件全被判未注册」的破门风险结构上不存在。

**② 文件归属用调用栈，不用改注册形式**：
实测浏览器栈帧带 `http://…/src/tests/test-x.js:3:17`、Node 带 `file:///…:9:16`，同一正则可提取。
⚠️ **取最外层而不是第一个**：实测「helper 里注册」时栈是 `[helper.js, owner.js]`，
取第一个会归到 helper（错）。当前仓内无跨文件注册，这一条防将来静默归错。

### 10.2 已落地改动

| 文件 | 改动 |
|---|---|
| `src/tests/runner.js` | 文件归属（`setCurrentFile` 优先 + 栈兵底）/ `tier` 参数 / `parseTierQuery` / `selectSuites`（**失配硬失败**）/ `getRegisteredSuites` / results 加 `files`·`registered`·`selection` / `runAndExpose` 失败也写 `selectionError` |
| `src/tests/test-runner-tiers.js` | **新增 12 例**（Tier 1）：解析/筛选/档位展开 + **5 条失配硬失败** + 真实注册路径的文件归属 |
| `tools/test-tiers.mjs` | **新增**：分档唯一权威（spec 5 档 / Node 白名单 100 / 重 GEN 6 / 轻档派生） |
| `tools/check-data.mjs` | **新增 `[测试分档]` 门**：spec 双向一致 / 白名单⊆全集且仍在 index.html 注册 / 重GEN⊆白名单（**不钉例数**） |
| `tools/three-resolver.mjs` | **新增**：Node 侧 `three` → `vendor/three/` 映射（不改 package.json imports） |
| `tools/unit-node-shim.mjs` | **新增**：`file://` → 读本地文件；**无 DOM 垫片**；http(s) 原样透传 |
| `tools/run-unit-node.mjs` | **新增**：Node 快档入口，**import 失败/0 例注册/集合不对账 均硬失败** |
| `tools/test-unit-node-runner.mjs` | **新增 17 条自测**（放 tools/ 故不进注册门，无需开例外） |
| `tools/run-spec-tier.mjs` | **新增**：按档位跑 spec，未知档位名/空集合硬失败 |
| `tests/unit-fast.spec.mjs` | **新增**：轻档入口，钉「**跑到的文件集合 ≡ 清单**」+ `selectionError` 为空 |
| `tests/harness-slow.spec.mjs` | **新增**：慢档入口（普通 spec ⇒ `npm test` 天然收集） |
| `playwright.config.mjs` | `testIgnore: 'tmp-*'`，留 `MC_ALLOW_TMP=1` 逗口 |
| `src/tests/fixture-blank.html` | **新增**：空白同源夹具页（带 import map） |
| `tests/zombies.spec.mjs` | 30 只压力那条改 goto 空白页，**断言一字未改** |
| `tests/atlas.spec.mjs` | 同源 fetch 那处改 goto 空白页 |
| `package.json` | 新增 7 个入口；`npm test` 串上 Node 全量档（**覆盖只增不减**） |
| 删除 | 2 个纯转发 spec + 5 个零引用 fixture 页 + 1 个 `.bak`（**均 `mv` 到 /tmp，可恢复**） |

### 10.3 重 GEN 治理：**五条无损筛 + 一条真抽样**

原计划估「三条无损筛 + 三条抽样」，**实测后变成五条无损筛**（比抽样更安全）：

| 用例 | 手法 | 实测效果 |
|---|---|---|
| 大竞技场排雪原 | 只 GEN 与雪原盒相交的 column | 245→67 column（省72.7%），**11.2s→5.8s** |
| 废弃堡垒排雪原 | 同上 | **9.2s→2.9s** |
| 浅水高台缓坡植物 | 圆形区：只 GEN 与圆相交的 column | 256→208（省18.8%） |
| 地标零巨树 | 无巨树候选 ⇒ 差格必空 ⇒ 跳过双 GEN | 4239→551 column（**省87.0%**）；对照断言仍满足（intruders 101>0、scannedCells 16348>5000） |
| 城市零巨树 | 同上 | 同手法 |
| 丛林要塞树密度 | **真抽样**（伯努利比值，无几何捷径） | 字典序等步长取（**无偏**，不按 spot 数降序以免偏向密列）；stride 2 ⇒ ~73列/~560 spot，σ≈0.021、4σ≈0.084 < 判据半宽 0.10；**全量版另存一条 `tier:'slow'`** |

⚠️ **所有判据的上下界与对照断言一字未改**（`coveredSeeds>=4`、`intruders>0`、
`scannedCells>5000`、`ratio∈[0.40,0.60]`）；只新增了「样本量 >=400」的下界（防样本太小而 flaky）。

### 10.4 已跑的验证

| 验证 | 结果 |
|---|---|
| `test-runner-tiers.js` | **12/12 绿**；三次注入（静默忽略未知token / 空集合不报错 / 不做文件归属）**均真红**，`cp` 还原 + sha256 逐位核对 |
| `[测试分档]` 门 | 绿；三次注入（漏归档 / 白名单死引用 / 摸掉 index.html 注册）**均真红** |
| 浏览器侧分档 | 拼错 **312ms 硬失败**（不是超时）；单文件筛 12 例；整页 fast=all=registered=**2466**、**Default Suite 残留 0**、117 文件全有归属 |
| `unit-fast.spec` | **1 passed / 26.8s**（日常门，原整页 150s+） |
| Node 轻档 | **94 文件 / 1909 例 / 39.6s 全绿** |
| Node 全量档 | **100 文件 / 2064 例 / 170.5s 全绿**（改前 262.7s） |
| runner 自测 | **17/17 绿** |
| 大竞技场无损筛负向验证 | 撤销雪压接线 ⇒ **2 例真红**，精确报出 5 个雪块坐标 ⇒ 筛后判别力成立 |
| `npm run check:data` | 全绿（`[测试注册] 117` + `[测试分档] spec 100 分 5 档`） |
| 改动文件 eslint | **0 error 0 warning**（逐文件跑） |

⚠️ **`tmp-bgm-ramp.html` 已被并发会话删掉**（不是我）；本轮只移了 5 个非-tmp 的死 fixture 页。
⚠️ **`testIgnore` 会连显式单跑一起阻断**（实测：位置参数**不**优先于它）⇒ 加了
`MC_ALLOW_TMP=1` 逗口，否则「探针仍可单跑」的承诺不成立。

### 10.5 最终耗时对账（同一口径：page.goto → RESULTS，同机同并发环境）

| 入口 | 改前 | 改后 | 备注 |
|---|---|---|---|
| **整页默认档**（harness） | 150.3 / 167.5 / 147.7 / 163.8s（四次） | **101.2s** | 2466 例全绿；不再贴 150s 窗口 |
| **浏览器轻档**（unit-fast） | —（无此入口） | **27.3s** | 1909 例 / 94 文件，**日常门** |
| **浏览器慢档**（harness-slow） | — | **12.0s** | 1 例（丛林要塞全量 146 column） |
| **Node 轻档**（test:unit） | — | **39.6s** | 1909 例，无需浏览器 |
| **Node 全量**（test:unit:all） | 262.7s（5 并发） | **170.5s** | 2064 例全绿 |
| **atlas.spec** | 第一条触发整页 150s+ | **7.0s（3/3）** | 换空白夹具页 |
| **zombies 30 只压力** | 等整页，且窗口 100s 结构上必红 | **1.0s（1/1）** | 断言一字未改 |

**零覆盖损失对账（实测）**：`fast(2466) + slow(1) = 2467 ≡ registered(2467)` ✅

**最慢三条的变化**（整页内）：
- 地标零巨树：**37.5s → 9.4s**（无损筛 87%）
- 丛林要塞树密度：**11.3s → 5.5s**（抽样），全量版 11.8s 在慢档
- 浅水高台缓坡植物：19.3s → **14.9s**（圆形筛 18.8%；它是模块级共享夹具，成本落在首条用例上）

### 10.6 全部验证读数

| 验证 | 结果 |
|---|---|
| `npm run check` | 三门全绿（arch ✓ / data ✓ / lint **60 warnings = 基线**） |
| 改动/新增 **20 个文件**单独 eslint | **0 error 0 warning** |
| `npm run test:unit`（端到端） | runner 自测 **17/17** + 单测 **1909/1909** |
| `npm run test:unit:all` | **2064/2064** |
| harness + unit-fast + harness-slow | **3 passed（2.3m）** |
| 分档例数对账 | core 51 + ui 90 + entity 197 + struct 46 + pixel 46 = **430 ≡ 全量 430**（100 文件） |
| 五个分档入口 | 逐个 `--list` 确认非空且文件数正确 |
| 未知档位名 | **硬失败 exit=1** |
| 抽样判别力（丛林要塞） | 注入「jfTreeKept 恒 true」⇒ 抽样版 **ratio 1.000 真红**（572 样本）、全量版同步真红 |
| 无损筛判别力（大竞技场） | 注入「撤销雪压」⇒ **2 例真红**，报出 5 个雪块坐标 |
| runner 三次注入 | 均真红，`cp` 还原 + sha256 逐位核对 |
| `[测试分档]` 三次注入 | 均真红（漏归档 / 死引用 / 摸掉注册） |

⚠️ **未跑 `bench --check`**：本轮不碰 mesher/materials/render-world/scheduler/physics（只改测试设施）。
⚠️ **删除均用 `mv` 到 `/tmp/mc-removed-{specs,fixtures}-20261118/`**，可恢复；未用 `rm`。
⚠️ **并发会话的文件未碰**：`assets/sounds/gun_hit.ogg` / `src/core/game.js` /
`src/entities/bosses/*` / `src/ui/boss-hint.js` / `test-boss-hint.js` / `boss-hint.spec.mjs` /
`docs/roadmap.md` 的 v3.16 行 —— 全部原样保留。`index.html` 只追加了一行注册与一个 `.catch`。