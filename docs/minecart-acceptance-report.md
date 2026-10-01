# 矿车 Epic 验收报告

**日期：** 2026-10-01（Epic 交付 2026-09-30；乘坐碰撞修复 2026-10-01）
**规格：** `docs/superpowers/specs/2026-09-30-minecart-design.md`
**计划：** `docs/superpowers/plans/2026-09-30-minecart.md`（Epic 主计划，8 Task）
**实施记录：** `docs/superpowers/plans/2026-10-01-minecart-ride-collision.md`（乘坐碰撞修复）
**commit：** `3410713`（Epic）/ `f59699d` + `2c0e23b` + `0d03c04`（乘坐碰撞修复）

> ⚠️ **本报告是补写的**（issue #3 审核指出 C1 缺口）：矿车 Epic 交付时未写验收报告，
> 实测数据散落在计划正文与代码注释里。本报告把可复核的部分汇总，并**如实标注哪些数据
> 是补测的、哪些是交付时未记录且已无法复现的**（见 §3.5、§5）。

---

## §1 交付摘要

mc-lite 的矿车（`src/actors/minecart/`，2381 行 / 7 文件）用 M5 实体运行时重做，
**不复活 ShadowStore / Dispatcher / MinecartManager 补丁架构**：

| 交付项 | 实现 | 复用的既有底座 |
|---|---|---|
| 放置 / 拾取 / 激活 / 连挂列车 | `MinecartService`（玩法入口） | M5 `EntityManager`（state 唯一权威）+ M7 的「物品名路由」放置分流 |
| 移动 / 转弯 / 碰撞 / 连挂 | `planMinecartStep` 等同构纯函数 | M6 的「definition.update 返回全新 state」不变式 |
| 跨车协调（相向停 / 激活静止车 / 帧预占位） | `deferred` 队列 + `applyDeferred()` | M5 `reindexColumn`（跨 column 索引校准） |
| 渲染（车斗 + 4 轮） | 2 个 InstancedMesh，差集驱动 slot | M6 手法（零实例 `visible=false`）+ M8 炮塔的 `sync()` 差集 |
| 玩家乘坐（走上车 / 跟随 / 空格下车） | `_updateMinecartRiding` + `_collides` 矿车格实心 | 既有 `_tryStepUp`（台阶）+ `ridingCarFor`（绑定判据） |
| 持久化（写盘 / 卸载恢复 / 单独销毁） | `minecartDefinition` persistent + `Persistence.deleteEntity` | M5 entities store；`deleteEntity` 是本 Epic **新增**的 API |
| TNT 爆炸摧毁 | `destroyInRadius(center, 4)` | M8 `explodeTnt` 唯一入口 |

**本 Epic 首次暴露的底座缺口**：M5 持久层原本没有「删除单个持久实体」的 API
（`saveEntities` 是 upsert-only，唯一删除是整库 `clearAllEntities()`）。矿车是第一个可被
单独销毁的持久实体 → 补 `Persistence.deleteEntity(id)`。后果（实测复现）：已销毁实体的
snapshot 永久留在 store → ① 全局上限把死实体计入（50 次放/拾后永久放不出车）；② reload 复活。

---

## §2 规格逐项对照

| 规格节 | 要求 | 实测结果 |
|---|---|---|
| §1.1 | 走 M5 实体运行时，不搬 MinecartManager+ShadowStore+Dispatcher | ✅ `check:arch` 全绿；`src/entities/minecarts/` 无 three import |
| §2.2 | 全局上限 50 来自 entities store（不是已加载数量） | ✅ `count()` = 已加载 + `entitiesCache` 未加载；单测钉住「拾取的车不占槽位」 |
| §3.1 | 单车移动：轨道判定用 round、位置索引用 floor | ✅ 单测覆盖跨格 / 吸附 / `lastTrack` 更新 |
| §3.2 | 车-车：相向都停 + 回弹 `lastTrack`；运动撞静止尝试激活；追尾等待 | ✅ 单测 + E2E「相向碰撞回弹」用例 |
| §3.3 | 车-玩家：头顶有净空则抬到车顶，无净空则停车 | ✅ 单测 `liftPlayer` 两分支（`11 + rideHeight` / null） |
| §3.4 | 跨车写入排队，`applyDeferred()` 在 `entities.update` 之后 | ✅ 单测「不得原地改对方 state」+ 跨 column `reindexColumn` 回归用例 |
| §3.5 | 连挂列车（上限 10）+ `breakLinks` + 朝向同步 no-op | ✅ 单测覆盖递归上限与 no-op 语义 |
| §4.1 | 放置 origin = `prevPos`（单格实体，与多格结构相反） | ✅ 两条路径（背包分流 / `selectPlaceable`）origin 语义一致 |
| §4.2 | 拾取走 `EntityManager.raycast`，射程 15 格 | ✅ E2E「拾取」用例；`interactRange` 单一权威 |
| §4.3 | ctrl+左键激活（+shift 后退） | ✅ E2E「激活与移动」用例 |
| §4.4 | 乘坐：走上车 / 自动绑定 / 分轴跟随 / 空格下车 / 偏离下车 | ✅ 见 §3.2 乘坐专项（2026-10-01 补「走上车」） |
| §4.5 | 爆炸摧毁（中心 +0.5、车中心 +0.3、半径 4） | ✅ E2E「爆炸摧毁」用例；度量与 mc-lite **同口径**（issue #3 §D 核实） |
| §5 | 2 个 InstancedMesh、零实例 `visible=false`、draw +2 | ✅ 实测 draw 557 → 559（+2），见 §3.1 |
| §7 | Tier 1 单测 + Tier 2 契约 + E2E + Tier 4 像素 | ✅ 见 §3.3 / §3.4 |

---

## §3 实测数据

### 3.1 50 车成本（规格 §8 / 计划 Task 8 Step 1 ①b）

⚠️ **本项数据在 Epic 交付时未记录**（计划要求「把实测数字记入报告」，但报告不存在）。
2026-10-01 补测，口径 = 计划原文：铺 50 格铁轨 + 逐格放 50 辆车 + 全部激活，
采样 5 秒。环境：`?vd=8&seed=12345`，apple/metal-3，120Hz 锁帧。

| 指标 | 零车基线 | 50 车全激活 | Δ |
|---|---|---|---|
| fps | 120.1 | 120.2 | +0.1 |
| frameP95 | 9.20 ms | 9.00 ms | −0.20 ms |
| draw call | 557 | **559** | **+2** |

**结论**：draw +2 与设计文档 §5 的预期**逐位吻合**（车斗 / 车轮各 1 个 InstancedMesh，
有活跃实例时才提交）；frameP95 无回退（差异在 vsync 量子 8.33ms 的噪声内，且方向为负）。
50 车 × 每帧 ~10 次 O(1) 方块读 + 250 个实例矩阵，与 M6 六部件同量级 → **不构成瓶颈**。

⚠️ 50 车逐格放置会触发连挂（上限 10 辆/列），故实测场景是 5 列连挂列车而非 50 辆独立车。
这与计划口径一致（计划未要求隔格放置），但**引用本数据时须注明**。
⚠️ 本项是**单次测量**（非 CLAUDE.md 计时门禁要求的交替对照）—— 它是成本实测而非
回归门禁，且 draw 是确定性指标、fps/p95 差异在量子噪声内，故单次足够；若未来要拿
frameP95 做门禁判据，须改交替对照。

### 3.2 乘坐碰撞修复（2026-10-01，issue #3 审核触发）

**缺陷**：玩家与矿车穿模、站不上去、带不走。根因 = `_collides` 只查方块（矿车不是方块），
而 mc-lite 靠 `Physics.isSolid` 把矿车占据格当实心。

**注入对照实测**（唯一变量 = `PlayerPhysics.minecarts` 是否注入）：

| 场景 | 修复在位 | 撤销修复 |
|---|---|---|
| 单测「矿车格对玩家是实心」 | PASS（y=3.000） | **FAIL**（`clipped=true`，y=2.000） |
| 单测「未注入时不挡人」（对照） | PASS | PASS（对照恒成立，符合设计） |
| 单测「踩上车后 ridingCarFor 命中」 | PASS | **FAIL**（返回 null） |
| E2E「走进静止车」`clippedFrames` | **0** | **8** |

**E2E 实测值**（`[walk-onto-cart]`）：`bound=true`、`boundAt≈446ms`、`clippedFrames=0`、
`playerY=19.9 == carTopY=19.9`。

**落点口径核实**（issue #3 A1，逐行复刻 mc-lite `tryStepUp`+`isSolid`+`checkAABB` 实测）：

| 场景 | feetY | mc-lite 专用分支 | mc-lite 落点 | 本仓库落点 |
|---|---|---|---|---|
| 走进车（player.y=2.0, carY=2） | `floor(1.99)=1` | **MISS** | `carY+1` = 3.0 | `carY+1` = 3.0（**相同**） |
| 下车后在车顶（player.y=2.9） | `floor(2.89)=2` | HIT | `carY+0.9` = 2.9 | `carY+1` = 3.0（差 0.1） |

→ 主路径两侧落点**相同**，唯一差异在「下车后冷却期内站在车顶水平移动」，见 §4 偏离 ⑧。

### 3.3 门禁

- `npm run check`（`check:arch` + `check:data` + lint）：**全绿**，0 errors
  （13 个既有 camelcase / unused warning，非本 Epic 引入）。
- `check:data` 矿车契约：`✓ [矿车] mine_cart 在背包 + 铁轨 sand_train_track/sand_train_track_corner 可放置`。
- `npm run bench -- --check`：**通过**（无显著回退）。乘坐碰撞修复后复跑：
  ① fps=120 p95=9 draw=498 / ② fps=120 p95=9.1 draw=557 / ③ fps=108.71 p95=16.7 draw=557 /
  ④ fps=119.35 p95=9.2 draw=543。

### 3.4 测试规模

| 层 | 文件 | 用例数 |
|---|---|---|
| Tier 1 单测 | `src/tests/test-minecarts.js` | 53 |
| Tier 1 单测（乘坐碰撞） | `src/tests/test-physics.js`（新增 3 条） | — |
| E2E | `tests/minecarts.spec.mjs` | 11 |
| Tier 4 像素 | `tests/minecart-render.spec.mjs` | 1 |

⚠️ 全量计数不在本报告硬编码（CLAUDE.md 口径：以 `npm run check:data` 输出为准）。
issue #3 审核时的全量实测：浏览器内单测 627 条全绿；Playwright 137 条 → 136 passed /
1 failed（唯一失败是已登记的贴线 flaky `m1-acceptance`，`Received: 16.700000762939453`
vs 断言 `< 16.7`，差 7.6e-7，未改断言未放宽阈值）。

### 3.5 交付时未记录、现已无法复现的数据

如实登记（不编造）：

- **Epic 交付时（2026-09-30）的 bench 对照原始输出**未留存。§3.3 的数字是
  2026-10-01 乘坐碰撞修复后复跑的，**不能代表 Epic 交付当时的基线**。
- **fix round 1 / 2 的复现脚本**（`repro-headon-deadlock.mjs` 等）已删除，
  其结论保留在代码注释里（`minecart-system.js:78-84`、`:328-336`、`:556-566`），
  但**原始 trace 无法复现**。
- **Tier 4 像素判据的具体采样值**未记录（只有 spec 文件里的断言阈值）。

---

## §4 偏离表

设计文档 §6 是权威（9 条），此处摘要 + 补充实施中新发现的偏离。

### 规格已列的有意偏离（§6 ①~⑦）

① 架构走 M5 EntityManager（不搬 ShadowStore/Dispatcher）；② 命中走实体 AABB raycast；
③ 放置不消耗物品 / 拾取不加回背包（创造模式口径）；④ column 卸载恢复后车继续原方向
（mc-lite 停成 IDLE）；⑤ 车斗纹理无指纹门禁（运行时 canvas 生成）；⑥ 跨车写入排队统一生效；
⑦ 乘坐跟随的障碍检测不把其他矿车当障碍。

### 2026-10-01 补登记（issue #3 审核触发）

| # | 偏离 | 理由 |
|---|---|---|
| ⑧ | `_tryStepUp` **无矿车专用分支**（mc-lite `Physics.js:241-248` 有）。仅在「玩家已在车顶且未绑定」时差 0.1 格 + 一次相机缓动 | 走进车的主路径两侧落点相同（上游专用分支因 `feetY=carY−1` 而 MISS，§3.2 实测）；差异场景被 `dismountJump` 弹起后几乎不触发。补分支要改 `_tryStepUp` 语义 + 新增测试，收益不抵成本（YAGNI，用户裁定） |
| ⑨ | 自动下车的偏离基准 = **车中心**（`position+0.5`）；mc-lite 从**车格角**量 | mc-lite 口径下玩家站在车的远半格（`cx+0.7`）时 deviation=0.7 > 0.6 → **人还在车上就被自动下车**（上游缺陷）。本仓库从车中心量：`cx+0.7` 时 0.2 → 保持乘坐 |

### mc-lite 侧的既有缺陷（不作为对齐依据，如实记录）

- **相向碰撞死锁**：mc-lite 自身 `isHeadOn` 用 floor（`MinecartCollisionSystem.js:55`）
  而前方格查询用 round（`MinecartMovementSystem.js:479`）→ 两判据基准不一致 → 死锁
  （已核实源码）。本仓库统一 round 是**有意偏离**（对齐其意图而非其 bug）。
- **自动下车基准缺陷**：见偏离 ⑨。

---

## §5 负向验证清单

⚠️ **如实区分三类**（issue #3 C6 指出「RED 不可复核」）：

### A. 本次（2026-10-01）实测的注入对照 —— 可复核

| # | 注入 | FAIL 证据 |
|---|---|---|
| 1 | 撤销 `PlayerPhysics.minecarts` 注入 | 单测 T1 FAIL（`clipped=true`）、T3 FAIL（`ridingCarFor=null`）；E2E `clippedFrames=8` |
| 2 | E2E 在绑定当帧读 y（不等多一帧） | `playerY=20` vs `carTopY=19.9` → 断言 FAIL（**我自己的测试缺陷**，已修正为多跑 5 帧） |
| 3 | 单测 fixture 铁轨只铺到 x=9（太短） | 对照用例 FAIL 于 `y=1`（玩家走出轨尾掉到 stone 地面）—— **因错误原因失败**，已修正为铺满 x=2..14 |

### B. 断言落点层面的负向验证（测试注释已钉住，但未跑注入）

这些用例的设计意图是「若把实现改回 X 则 FAIL」，注释里有明确记载，但**交付时未实际跑注入验证**：

| # | 用例 | 钉住的回归 |
|---|---|---|
| 4 | `service: carsView/carAtRound 返回帧前快照` | 改成返回实时 state → 顺序依赖复活（`[a,b]` ❌ / `[b,a]` ✅） |
| 5 | 「不得原地改对方 state」 | 原地改 → 跨 column 索引迁移判据恒等 → 卸载漏回收 |
| 6 | `renderer.sync: 朝向 3 的 yaw 反解不折叠` | 用 `Euler.setFromQuaternion` → 折叠到 ±π/2 |
| 7 | 「勿把实现改回 floor」 | 改回 floor → 重新引入相向死锁（花了 2 轮 fix round 才修掉） |
| 8 | 「拾取的车不占全局上限槽位」 | 假 persistence 写成 no-op → `count()===0` 恒真（M6 fake 盲区同型） |

### C. 交付时未做、现已无法补的

- Epic 主计划各 Task 的 RED 阶段失败输出**未留存**（计划复选框当时也未勾选，
  2026-10-01 才补勾）。
- 上述 B 类的注入验证**未实际执行** → 严格说它们是「断言落点正确」而非「负向验证通过」。

---

## §6 文档同步（CLAUDE.md 硬规则的三类文档）

| 文档 | 同步内容 |
|---|---|
| `docs/roadmap.md` | 里程碑总表矿车行（状态 + commit hash）/ 现状声明段 / 「去哪找细节」表加本报告 |
| `CLAUDE.md`（= `AGENTS.md`） | 「矿车沉淀的活跃约束」段（17 条），含 2026-10-01 补的两条载荷性口径 |
| 设计文档 §1.1 / §4.4 / §6 | §1.1 修正失准描述（issue #3 B1）/ §4.4 补「走上车」机制 + 落点核实 / §6 补偏离 ⑧⑨ |
| 主计划 47 个复选框 | 2026-10-01 补勾（issue #3 C4；交付时全未勾） |
| 实施记录 | `2026-10-01-minecart-ride-collision.md` 降级为「实施记录」（issue #3 C3），commit hash 回填 |

---

## §7 遗留 TODO

1. **车斗纹理算法改动无指纹门禁**（偏离 ⑤）：运行时 canvas 生成 → 渐变色 / 噪点数 /
   拉丝间距的改动会静默生效，靠 Tier 4 像素实测兜底。若未来改离线烘焙须同步补指纹门禁
   （手法见 `tools/zombie-head-fingerprint.mjs`）。已登记在 roadmap 遗留 TODO 段。
2. **矿车与丧尸无物理碰撞**（规格 §9）：mc-lite 本身也无此交互，保持同口径。
3. **`_tryStepUp` 的矿车专用分支**（偏离 ⑧）：若未来实测发现冷却期相机缓动可感知，
   可补 mc-lite 同款分支（抬到 `carY+0.9`）。当前判定为 YAGNI。
4. **B 类负向验证未实际跑注入**（§5）：5 条用例的「改回 X 则 FAIL」只有注释记载，
   未实测。若要补齐，需逐条注入并记录 FAIL 输出。
5. **`check:data` 不输出用例总数**（issue #3 C5）：CLAUDE.md 要求「计数以 check:data
   输出为准」，但它只输出 `[测试注册] 39 个测试文件全部已注册`，不输出用例数 →
   口径与工具脱节。本次按「不在文档硬编码」处理（写「全绿」+ 注明审核时的实测值）。
   彻底解决需让 `check:data` 或 harness 输出用例总数。

---

## §8 操作失误记录（如实）

### Epic 交付时（2026-09-30）

1. **未写验收报告**（issue #3 C1）：CLAUDE.md 既定做法是「M4 之后的实玩反馈修正在各
   里程碑验收报告的偏离表」，roadmap 的「去哪找细节」表也把验收报告列为落点 → 缺口。
2. **主计划 47 个复选框全未勾选**（C4）：代码已交付推送，但计划状态无法反映「哪些 Task 已做」。
3. **roadmap 写「待提交（零 commit 模式）」**（C2）：commit 已推送后未更新。
4. **50 车实测数据未记录**（计划 Task 8 Step 1 ①b 明确要求「记入报告」）。
5. **两处有意偏离只在代码注释与 CLAUDE.md 登记，设计文档偏离表缺项**（B2 / 偏离 ⑨）。

### 乘坐碰撞修复时（2026-10-01，本人）

6. **既有 E2E 用例把玩家 teleport 到车顶**再断言跟随 → 绕过「走上去」这一步 → 全绿却漏了
   穿模缺陷（同 M7「只测 API 漏玩家主路径」教训）。**是用户实玩发现的，不是测试发现的。**
7. **单测 fixture 铁轨太短**（只铺到 x=9）→ 对照用例因「玩家走出轨尾掉落」而失败，
   是**因错误原因失败**（违反 CLAUDE.md「写断言前先在真实数据上跑一次」）。
8. **E2E 在绑定当帧读 y** → 读到 step-up 落点 `carY+1` 而非车顶 `carY+0.9`，
   首跑 10/11。根因是绑定帧不锁 y（mc-lite 同序），已沉淀进 CLAUDE.md。
9. **设计文档 §4.4 原写「不动 `_collides` 主路径」** → 被本次修复直接证伪（走上车正是
   靠改 `_collides`）。已修正并标注证伪日期。
10. **实施记录 Review Focus 把 mc-lite 机制归因到 `applyPushOut`**（issue #3 A2）→
    实测不成立：`applyPushOut` 是六向 0.1 试探且只在 `isMoving || isStuck` 时调，
    本仓库根本没有 pushOut 机制；真正路径是 `tryStepUp`。**违反「对齐上游须实测其运行时
    行为，不能读定义推断」**——结论对（抬到 y=3.000）但推理错。已改写。
11. **实施记录头部写「commit 步骤尚未执行」而 commit 已推送**（C3）→ 文档与仓库状态矛盾。
    已改为「实施记录」定性 + 回填 commit hash。
