# M9 创造台（playground）验收报告

**日期：** 2026-09-12
**规格：** `docs/superpowers/specs/2026-09-11-m9-playground-design.md`
**计划：** `docs/superpowers/plans/2026-09-11-m9-playground.md`
**设计文档：** v1.40

---

## §1 交付摘要

mc-lite 的创造台（`PlaygroundService.js`）用 M4~M7 建立的底座重做，**不新开管线**：

| 交付项 | 实现 | 复用的既有底座 |
|---|---|---|
| 54×54 平台生成（2916 格）+ 中心标记块 | `PlaygroundService.create()` | `WorldEditor.setBlocks()` 唯一写入口 |
| 平台方块不可破坏 + 移出背包 | `blocks-data.js` 加 `indestructible` + `HIDDEN_FROM_INVENTORY` 加两项 | M8 交付的 `registry.indestructibleTable`（三个消费者自动生效，**零代码改动**） |
| 中心块锚点持久层（重启恢复 / 全局最多 1 个） | `{kind:'playground', id, origin, size}` | M7 装置模式的**持久层半边**（DR-17 edits 通道 + `listBlockEntities` 扫库） |
| 模型 JSON 导入导出 | `exportModel()` / `importModel()` | 格式与 `assets/structures/*.json` 完全一致 |
| 面板动作按钮（打开/关闭 + 导出/导入）+ toast | `settings-panel.js` `_rowPlayground()` + `src/ui/toast.js` | 既有两列盒 / 按钮组手法；toast 是本仓**首个**非模态提示设施 |

**不移植的 mc-lite 机制**（红线 1）：`playgroundBlocks: Set<'x,y,z'>`（2916 个字符串键的方块
集合副本）—— 平台是规则 54×54 矩形，坐标由 `origin + size` 确定性重算；记下来会引入「平台有
哪些方块」的第二份权威，且与 `blocks` typed array 必然漂移（玩家挖掉一格平台后方块集合就成了
谎话）。

**也不复用装置模式的 controller / 增量失效那半边** —— 创造台不刷怪、不射击、无运行时行为，
它的 `blockEntity` 只是「平台在哪、多大」的持久真相。这是本 Epic 与 M7/M8 的结构性差异
（记进设计文档 v1.40 修订说明 ①）。

---

## §2 规格逐项对照

| 规格节 | 要求 | 实测结果 |
|---|---|---|
| §1.1 | 两项登记 `indestructible`，自动生效于三个消费者 | ✅ `[不可破坏] 3 项：playground_block, playground_center_block, bedrock`。三个消费者**零代码改动**即生效（`player.js` 的注释「M9 追加 playground 两项后，这一行自动覆盖它们」实测兑现） |
| §1.2 | 成对移出背包，物品集合 118 → 116 | ✅ `[物品集合] 116 项 = registry 126 − 排除 10`（`HIDDEN_FROM_INVENTORY` 4 → 6）。图标已重烘焙（`[图标过期] 116 项指纹全部匹配`） |
| §1.3 | 翻转跨 Epic 的既有断言 | ✅ `test-weapons.js` 三条 policy 断言改回 `assertFalse` + MAG7 扫描用例的 `(5,0,0)` 格位断言翻转；`test-block-registry.js` 的 `isIndestructible(playground)` 改 `assertTrue`。**另发现计划未列的两个文件**（见 §4 偏离 ⑦） |
| §2.1 | 54×54 平台 + 选址顺序（东→西→Y−20→Y−5）+ 净空 10 + 未加载视为重叠 | ✅ 单测覆盖四个候选与「东侧未加载→试西侧」；`maxSearchY = WORLD_MAX_Y(96)` 而非 mc-lite 的 200 |
| §2.2 | 关闭判据 + 只删平台层、保留模型 | ✅ `isPlayerInPlayground` 用 `heightSpan(20)`（> `clearance(10)`，玩家在净空区高处也算在内）；关闭只置 `origin.y` 那一层为 air |
| §2.3 | 锚点恢复 + 全局最多 1 个 + 平台不可破坏 | ✅ `hydrate()` 走 `listBlockEntities('playground')`；E2E reload 用例实测 `active === true` 且再 create 返回 `exists` |
| §2.4 | 导出格式与 structures JSON 一致 / 导入 invalid·skipped 分类 / 未知方块名不写 air | ✅ `dimensions` 键名实测为 `{width,height,depth}`（与 27 个结构 JSON 逐一核对）；未知方块名计 `invalid` 且**不写 air**（实测已有方块未被删） |
| §3 | 面板两态文案 / 导出导入仅激活时可见 / busy 锁 / toast 非模态 | ✅ 文案常量已导出并被单测钉死；E2E 实测模态栈始终只有 `['settings']`（toast 不进栈） |
| §4 | 验收口径（6 条）+ 回归门禁 | ✅ 见 §3 实测数据与 §5 负向验证清单 |

---

## §3 实测数据

### 3.1 主线程大体积扫描耗时（规格 §2.1 要求实测，目标 < 50ms）

| 操作 | 耗时 | 说明 |
|---|---|---|
| `create()` 全流程（含 `_findSafeHeight` + 2916 格 `setBlocks`） | **26.7 ms** | vd=4 / seed=12345，选址落在 `[293,70,90]` |
| `_findSafeHeight` 从世界底起扫（最坏情况） | **28.3 ms** | 从 `y=-32` 扫到返回 `70`（约 102 层 × 3.2 万次 `getBlockId`/层 ≈ 326 万次读取） |
| `exportModel`（稠密模型 2500 格） | **5.9 ms** | 导出 JSON 253 KB；全扫 54×54×95 ≈ 26 万次读取 |
| `close()`（2916 格置 air） | **2.5 ms** | 一次事务 |

**结论：四项全部远低于 50ms 目标 → 按计划不做增量优化**（计划 Task 2 的取舍「实测数据决定
是否优化，不预先优化」）。`getBlockId` 是 O(1) typed-array 读，326 万次也只 28ms；朴素全扫
在本仓库的数据结构下不构成可感知卡顿。

### 3.2 2916 格单次编辑的 REMESH 收敛（本 Epic 最大编辑量）

| 指标 | 实测值 | 对照 |
|---|---|---|
| REMESH 收敛耗时 | **10 ms**（2 帧） | bench 场景 ④「批量删 500 块」是既有基线，2916 格约为其 5.8 倍 |
| `meshQueued` 峰值 | **0** | 未积压 |
| `pendingMesh` 峰值 | **0** | 未积压 |
| `meshInflight` 峰值 | **20** | Worker 池并发在预算内 |

2916 格一次事务提交后 **2 帧即收敛**，队列零积压 → **无需分帧提交**（规格 §2.1 预留的
「若帧率跌破门禁则改分帧」这条没触发）。

### 3.3 draw call

**无增量**（规格 §4.1 已论证）：创造台走既有体素通道（BatchedMesh），不新增任何
InstancedMesh（区别于 M8 的炮塔/弹丸/爆炸特效），故无 draw 对照表。

### 3.4 性能门禁（`bench -- --check`）：交替对照

⚠️ **场景 ④ 的 frameP95 门禁被阻断，但经交错对照证明与 M9 改动无关。**

单次运行阻断（`[回退 11.1%] ④ frameP95: 9 → 10`）后，按 CLAUDE.md 的口径做了**交错对照**
（同会话内 HEAD 与改动交错各跑 3 次，不是「A×3 后接 B×3」—— 后者会被机器热状态混淆）：

| 轮次 | M9 侧 frameP95 | HEAD 侧 frameP95 |
|---|---|---|
| 1 | 10 | 10（**HEAD 也被阻断**） |
| 2 | 10 | 10（**HEAD 也被阻断**） |
| 3 | **9.9（通过）** | 10.2（**HEAD 被阻断，比 M9 更差**） |

**两侧分布完全重叠**（M9: 10 / 10 / 9.9；HEAD: 10 / 10 / 10.2），且 HEAD 侧在第 3 轮比 M9 侧
更差 → 无 M9 相关性。这正是 CLAUDE.md 记录的「frameP95 门禁会被 vsync 量子化噪声误报」
（120Hz 锁帧下 p95 按 8.33ms 一档量子化，基线 9ms 而实测在 9.6~10.2 随机浮动 → 9→10 只差
一个量子就报「回退 11%」）。

⚠️ **未改任何断言、未放宽阈值、未重写基线**（`docs/m3-baseline.*` 保持原状，全程只用
`-- --check`）。这条门禁的既有噪声问题记进 §7 遗留 TODO 1。

### 3.5 全量回归

- `npm run check`（`check:arch` + `check:data` + lint）：**全绿**，0 errors（9 个既有
  camelcase warning，非本次引入）。
- 浏览器内单测：**全绿**（用例计数以 `npm run check:data` 的 `[测试注册]` 输出为准，
  不硬编码）。
- Playwright 全量：**114 passed / 2 failed**，两条失败均为**既有计时型 flaky**，
  单独复跑通过（见下表）。⚠️ 未改任何断言、未放宽阈值。

| 失败 spec | 失败表现 | 复跑 | 机制分析（不是「凭感觉判 flaky」） |
|---|---|---|---|
| `tests/m3-rain.spec.mjs` | 雨效截图差分 `diff=251 < 阈值`（阈值 CI=30 / 本地=89） | ✅ 单独复跑通过 | 截图差分对渲染时序敏感；CLAUDE.md 已记该类计时断言在高负载下偶发贴线 |
| `tests/weapons-world-edit.spec.mjs` | `pistolEffects` **199 ≠ 200** | ✅ 单独复跑 **3/3 通过** | **与 §3.4 同一类 vsync 量子化问题**：测试在两次射击之间 `setTimeout(95)`，而手枪冷却 0.09s 靠帧循环累加 `dt` 递减（`weapon-controller.js:148` 在 `cooldown > 0` 时返回空数组）。120Hz 锁帧下 95ms ≈ 11 帧 ≈ 91.6ms 的 dt，**余量仅 5ms** → 若该窗口少渲染一帧（83.3ms）冷却就走不完 → 第 200 次射击被门控拒绝 → 计 199 |

⚠️ **`weapons-world-edit` 的间歇性证据与机制论证**（不凭感觉判 flaky）：

- **直接证据**：本次改动下**单独复跑 3/3 全部通过**（每次 56s），即同一份代码既能通过也能
  报 199 → 间歇性，不是确定性回归。
- **机制上不可能与 M9 相关**：本 Epic 新增的面板代码只在 `open()` 时同步状态、Toast 只在
  构造期插一次 DOM，**都不进帧循环热路径**（`rg` 核对：放挖热路径 `world.setBlock` /
  `scheduler.remeshSections` 零命中面板与 toast 代码）。该 spec 也不触碰创造台任何接口。
- **根因是既有的量子化余量不足**（与 §3.4 同源）：`setTimeout(95)` vs 冷却 90ms，余量 5ms
  < 一个 vsync 量子（8.33ms）。⚠️ 这是**该 spec 自身的计时余量问题**，建议单独处理
  （记进 §7 遗留 TODO 2），本 Epic 未改它的断言。
- 直接证据：本次改动下**单独复跑 3/3 全部通过**（每次 56s），即同一份代码既能通过也能
  报 199 → 间歇性，不是确定性回归。
- 机制上不可能与 M9 相关：本 Epic 新增的面板代码只在 `open()` 时同步状态、Toast 只在
  构造期插一次 DOM，**都不进帧循环热路径**（`rg` 核对：放挖热路径 `world.setBlock` /
  `scheduler.remeshSections` 零命中面板与 toast 代码）。该 spec 也不触碰创造台任何接口。
- 根因是既有的量子化余量不足（与 §3.4 同源）：`setTimeout(95)` vs 冷却 90ms，余量 5ms
  < 一个 vsync 量子（8.33ms）。⚠️ 这是**该 spec 自身的计时余量问题**，建议单独处理
  （记进 §7 遗留 TODO 2），本 Epic 未改它的断言。

---

## §4 偏离表

### 规格已列的有意偏离（4 条，全部落地）

| # | 偏离 | 理由 |
|---|---|---|
| ① | 不维护 `playgroundBlocks` 方块集合副本 | 红线 1：那是「平台有哪些方块」的第二份权威，且与 `blocks` typed array 必然漂移 |
| ② | 走 `editor.setBlocks` 真实方块而非「mesher 顶点模板机制」 | 平台是可挖可放的真实体素。设计文档 §9 原表述是 M8 前的规划语，与实际实现不符 → 已在 Task 0 订正 |
| ③ | 导入**未做**「先清平台上方模型区」 | mc-lite `collectModelAreaBlocksToClear` 会在导入前把玩家已有模型全删（破坏性操作，须用户授权）。实测：导入与已有模型在同坐标冲突时**后写入者胜出**（`setBlocks` 的 `lastByPos` 去重语义），不会产生撕裂状态 |
| ④ | 安全高度搜索上界用本仓 `WORLD_MAX_Y=96` 而非 mc-lite 的 200 | 本仓世界高度 `-32~96`；照搬 200 会让搜索恒超出世界顶（`getBlockId` 对上界返回 air）→ 平台写在越界高度上 |

### 实施中新发现的偏离 / 修正（8 条）

| # | 偏离 / 修正 | 实测证据 |
|---|---|---|
| ⑤ | **`_findGroundLevelFromBelow` 按 mc-lite 的「向下扫」实现 —— 计划正文写成了「向上扫」** | mc-lite `PlaygroundService.js:116-123` 实测是 `for (let y = startY; y >= 0; y--)` **向下**找实心方块并返回 `y + 1`。计划正文的 `for (let y = startY; y < maxSearchY; y++)` 与上游相反 —— 照计划实现会让平台落在「玩家头顶上方」而非地面上方。**本实现按 mc-lite 语义落地**，单测钉住 `origin.y === 1`（地面在 y=0 → 返回 1） |
| ⑥ | **`physics.pos` 是普通对象 `{x,y,z}`，没有 `.set()`** | 计划 E2E 写的 `g.player.physics.pos.set(...)` 不存在（`physics.js:13` 是对象字面量）。改用既有 `player.spawn(x,y,z)`（`player.js:149`）传送。⚠️ 这正是计划附「既有 API 实际签名对照表」要防的那类错误 —— **本表漏了 `physics.pos` 这一条**，建议后续 Epic 的对照表补上 |
| ⑦ | **计划未列的两个文件也有冻结断言会被打挂** | ① `src/tests/test-inventory-ui.js`（`:143/:147/:393/:394` 四处 118 与「末槽下标 117」）；② `src/tests/test-weapons.js` 的 **MAG7 扫描用例**（`(5,0,0)` 格位断言 —— 计划只列了 policy 用例的三条）。两处都已改 |
| ⑧ | **代码注释里的 8 处硬编码 118 改为不携带计数** | `player.js` / `inventory.js`（2 处）/ `bake-icon-atlas.mjs`（2 处）/ `icon-fingerprint.mjs` / `check-data.mjs` / `ui/inventory.js` / `test-iso-icon.js`。理由：CLAUDE.md 明令「同一事实的多个副本会漂移」，而这些是**现状计数**（非设计决策）→ 一律改为指向 `npm run check:data` 输出。⚠️ `tests/m3-1-inventory.spec.mjs` 里的历史叙述性注释（解释「为何不硬编码」）**保留原文** —— 那是方法论说明，不是计数副本 |
| ⑨ | **E2E 视距分配与计划不符**：成功路径用 `vd=4`，`vd=2` 专用于 not-loaded 路径 | 实测：平台跨约 20 个 column（54 格 ÷ 16），**vd=2 的加载半径不足以覆盖 → 直接返回 `not-loaded`**（不是计划假定的「vd=2 下能创建成功并触发判据」）。vd=4/8 创建成功。故 spec 用 vd=4 跑成功路径、vd=2 专测未加载判据（该用例实测 `reason === 'not-loaded'` + 零写入） |
| ⑩ | **`Toast` 的样式注入改为幂等**（计划是每次构造新建） | fixture 页会多次构造 Game（→ 多次 `new Toast`），不幂等则产出多个同 id 元素（跨实例串扰，CLAUDE.md 记过背包面板的同类问题）。改法与 `settings-panel.js` 的 `ensureStyle` 同手法（按 id 检查）；单测的桩件容器无 `getElementById` → 走直接新建分支 |
| ⑪ | **面板打开时同步创造台状态（`_syncPlaygroundState`），不依赖构造期初值** | 面板可能在创造台创建之后才第一次打开（构造时还没创建），也可能在别处（测试 API / reload）被改动过。构造期初值只作首帧渲染，`open()` 一律重新读服务真实状态 |
| ⑫ | **`importModel` 的 skipped 只计硬失败**（计划是 `skipped += report.skipped.length`） | `world-data.js` 把 **no-change 也推进 skipped** → 计划写法会把「重复导入同一模型」全计成 skipped，误导用户。与 `_write` 同口径：只计 `column-missing` / `out-of-bounds` / `bedrock` 三种硬失败 |

### mc-lite 侧的既有差异（不作为对齐依据，如实记录）

⚠️ mc-lite 的 `convertOrientation`（导出用）与 `convertDirectionToOrientation`（导入用）是
**两个不同函数**，导出侧直接返回原值（`:395-398` 的注释承认「为了兼容性，返回原值」）。
本仓导出直接用 `getBlockMeta()`（orientation 原值），与上游**行为**一致但不引入那两个函数的
不对称。

---

## §5 负向验证清单

**共 15 条注入，全部真 FAIL**（做完均已恢复源码，`git status` 已核对无残留）。

### Task 1（门禁环节，4 条）

| # | 注入 | FAIL 证据 |
|---|---|---|
| 1 | 移除 `HIDDEN_FROM_INVENTORY` 里的两项 | `[创造台] "playground_block" 在背包物品集合内（→ 撕裂状态）` ×2 |
| 2 | 移除两条声明的 `indestructible` 字段 | `[创造台] "playground_block" 未标 indestructible` ×2（同时 `[不可破坏]` 降回 1 项） |
| 3 | `PLAYGROUND.size` 改 40 | `[创造台] PLAYGROUND.size = 40 ≠ 54（mc-lite 口径）` |
| 4 | `PLAYGROUND_KIND` 改 `'create-table'` | `[创造台] PLAYGROUND_KIND ≠ "playground"（hydrate 扫库会对不上）` |

### Task 2（单测，6 条）

| # | 注入 | FAIL 证据 |
|---|---|---|
| 5 | `isPlayerInPlayground` 用 `clearance` 替代 `heightSpan` | `heightSpan 内（玩家可站在自己雕的高处）: Expected true, got false` |
| 6 | `_hasOverlap` 恒返回 false | `向上搜到第一个无重叠高度: Expected 2, got 1` |
| 7 | `_allColumnsLoaded` 恒返回 true | 两条断言同时 FAIL：`东侧未加载时须经西侧成功创建: Expected true, got false` + `失败路径零世界写入: Expected 0, got 2` |
| 8 | 导入的未知方块名写 air（`?? 0`） | `Expected 1, got 0`（invalid 计数） |
| 9 | `maxSearchY` 改 200 | `Expected 96, got 200`（冻结数据断言） |
| 10 | 断言方向自查（写反的 `oy+11` 判在外） | 自查发现**我自己的断言写错了**（`oy+11` 在 `[oy,oy+20)` 内应为 true）→ 修正为 `assertTrue` 并加注说明它是「误用 clearance 的判别点」 |

### Task 2（E2E，2 条）

| # | 注入 | FAIL 证据 |
|---|---|---|
| 11 | `_allColumnsLoaded` 恒返回 true（vd=2） | `expect(r.writes).toBe(0)` → `Received: 2` |
| 12 | 关闭时连模型区一起删（`oy+1` 也置 air） | `modelKept` → `Expected: true, Received: false` |

### Task 3（UI，3 条）

| # | 注入 | FAIL 证据 |
|---|---|---|
| 13 | `_onPlaygroundToggle` 去掉 busy 锁 | `duringBusy.calls` → `Expected: 0, Received: 1` |
| 14 | toast 提示时调 `game.pushModal('toast')` | `modalsAfterToast` → `Expected ['settings'], Received ['settings','toast']` |
| 15 | 导出/导入按钮恒可见（不随状态切换） | `exportVisibleBefore` → `Expected: false, Received: true` |

### 自查发现的无效盲区（3 处，如实记录）

| # | 盲区 | 处置 |
|---|---|---|
| A | **vd=2 的 `reason === 'not-loaded'` 断言会假通过**：注入 7/11 后回滚路径同样返回 `not-loaded` → reason 断言区分不出 bug | 真正的判据是 `writes === 0`（失败路径零写入）—— 该断言在注入 7 与 11 下都真 FAIL。**E2E 保留两条断言**，reason 那条只作可读性 |
| B | **E2E 的「净空区全空」断言在该出生点下恒真**：注入 6（`_hasOverlap` 恒 false）时它仍通过 —— 因为该 seed 的选址落在 y=70（远高于地形），净空区本来就是空 | 注入 6 的真实守门人是**单测**那条「地形挡住净空时向上搜到更高高度」（已验证真 FAIL）+ E2E 用例 4 的导出方块数（注入 6 时 `Expected: 2, Received: 6095` —— 地形被导进模型）。E2E 的净空断言保留作**多出生点下的兜底**，不宣称它是注入 6 的判据 |
| C | **busy 锁若只断言「第一次点击成功」则注入 13 仍全绿**（第二次点击返回 `exists`，断言照样通过） | 改为断言**锁的可见状态 + 服务调用次数**：busy 期间 `calls === 0`（第二次点击没触碰服务）+ 按钮 `disabled === true`，释放后 `calls === 1` |

按 `docs/testing-policy.md` §2.7 的高发区自查，本 Epic 命中三类：「恒真陷阱」（盲区 B）、
「断言落点落在桩件而非真实接线」（fixture 的 fake editor **委托真实 `WorldData.setBlocks`**，
使 `_hasOverlap`/`exportModel`/`close` 的断言不落在空世界上）、以及「竞态断言落在内存侧而非
重载后的落库结果」（reload 用例断言落在**重启后的服务状态**上，不是 scene 或方块 id）。

---

## §6 文档同步（CLAUDE.md 硬规则的三类文档）

| 类别 | 同步内容 |
|---|---|
| 目录结构清单（设计文档 §5） | `src/entities/playground/`（config / service）、`src/ui/toast.js`、`src/tests/test-playground.js`、`tests/playground.spec.mjs`、本报告 |
| 开发命令清单 | **无新增 npm 命令**（创造台不涉及烘焙） |
| 现状声明 | CLAUDE.md「一句话现状」加 M9；roadmap 里程碑总表 M9 行状态 + commit hash |

设计文档 bump 至 **v1.40**（v1.36~v1.38 已被 roadmap 独立改动表占用，M8 取 v1.39），
修订说明三项：① DR-17 第三批消费者；② 物品集合口径 118 → 116；③ 平台方块集合不维护副本。

---

## §7 遗留 TODO

| # | 事项 | 优先级 | 说明 |
|---|---|---|---|
| 1 | **bench 场景 ④ 的 frameP95 门禁既有噪声**（非 M9 引入） | 中 | 交错对照实测 HEAD 侧同样阻断（10 / 10 / 10.2）→ 门禁在 9↔10 的 vsync 量子边界上随机翻转。建议单独处理：把该场景的 p95 阈值改成「按量子档容忍」或改用交替对照作门禁判据。**本 Epic 未改断言、未放宽阈值** |
| 2 | **`weapons-world-edit.spec.mjs` 的计时余量不足**（非 M9 引入） | 中 | `setTimeout(95)` vs 手枪冷却 90ms → 余量 5ms < 一个 vsync 量子（8.33ms），少渲染一帧就计 199。建议把等待改成 ≥100ms 或改判「≥199」。**本 Epic 未改它的断言** |
| 3 | 导入的「先清模型区」语义（偏离 ③） | 低 | 若用户需要「导入即替换整个模型」的语义，须作为破坏性操作单独确认后再实现 |
| 4 | `tools/bake-procedural-textures.mjs` 的 `textures.turret_alias_block` 生成代码已无消费者 | 低 | M8 把图标改指向 mc-lite 手工原图后遗留（非 M9 范围，顺手记录） |

---

## §8 操作失误记录（如实）

| # | 失误 | 处置 |
|---|---|---|
| 1 | 负向验证时**未恢复源码就叠加注入**（注入 6 叠在注入 5 之上 → 一次跑出两条 FAIL，无法归因） | 改为「每条注入前先从备份恢复」，逐条独立验证。**未用 `git checkout` 恢复**（CLAUDE.md 禁令：M8 期间误用 `git checkout src/core/game.js` 冲掉整个文件的接线）—— 一律用 `.tmp-bak-*` 备份/恢复 |
| 2 | 第一轮 bench 对照跑的是「A×3 后接 B×3」而非交错 | 察觉机器热状态混淆后**重做交错对照**（HEAD 与改动交错各 3 次），才得出「两侧分布重叠」的有效结论 |
| 3 | E2E 里写了不存在的 `physics.pos.set(...)`（照计划抄） | 实测核对后改用 `player.spawn()`，并记进偏离 ⑥ |
| 4 | 单测里 toast 用例第二次 `show` 漏传短时长（默认 2200ms → 40ms 后仍可见），**误判为实现缺陷** | 核对 `Toast.show` 签名后确认是**断言写错**，修测试而非修实现，并加注说明原因 |
| 5 | 临时性能测量脚本里写了 `waitWorldSettled(undefined)`（复制粘贴残留） | 修掉后重测；所有 `.tmp-*` 文件用完已清理（`git status` 核对无残留） |
