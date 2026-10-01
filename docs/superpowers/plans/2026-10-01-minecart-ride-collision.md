# 矿车乘坐碰撞修复实施计划（玩家走上矿车 / 不穿模 / 被车带着走）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> ⚠️ **本文档是实施记录，不是计划**（2026-10-01 实施完成后补写，issue #3 审核后定性）：
> 实施与验证步骤已全部执行，实测值已回填；commit 步骤已执行（Task 1~3 = `f59699d` /
> `2c0e23b` / `0d03c04`；Task 4 = `0317a74`，均已推送）。保留计划格式是为了让后续同类
> 改动有参照；矿车 Epic 的汇总实测数据 / 偏离表 / 负向验证清单见
> `docs/minecart-acceptance-report.md`。

**Goal:** 玩家与矿车相遇时不穿模，能站上矿车并被车带着走（两个方向：玩家走进车 / 车撞到玩家）——对齐 mc-lite 行为。

**Architecture:** 两个独立缺陷，两条不同路径：

- **场景 A（玩家走进静止车）**：mc-lite 靠 `Physics.isSolid` 把矿车占据格当实心
  （cell-based，查 `minecartManager.getMinecartAt`）→ 玩家走进车被挡 → 既有 `tryStepUp`
  抬到 `carY+1` → 与车顶 `carY+0.9` 差 0.1，被绑定容差 0.3 吸收 → 自动绑定。
  mc-heavy 的 `_collides` 只查方块（矿车不是方块）→ 穿模。修复 = 在 `_collides` 格子循环里
  加一句 `carAt(x,y,z)` 判定 + Player 构造时注入 service。**场景 A 不需要新机制**：
  step-up 与绑定判据都是既有的，缺的只是「车格是实心」这一条。
- **场景 B（车开过来撞静止玩家）**：⚠️ **这个需要新机制**（Task 4，与场景 A 相反）。
  车在前一格跨轨道中心时经 `resolvePlayerBlocking` 把玩家抬到 `carY+0.9`，但玩家脚下
  那格当时还没车 → 重力把玩家拉回轨面；车走到玩家格时既不再抬（只检查前方格）、
  也绑不上（`ridingCarFor` 查 `carY−1` ≠ 车格 `carY`）→ 车从玩家身上开过去。
  mc-lite 不需要这条 fallback（它靠重力段「向下扫描找支撑面 `gy`，`if (y < gy) y = gy`」
  把玩家顶上车，其 `isSolid` 含矿车格）；mc-heavy 重力是 `_moveAxis` 向下 + 碰撞二分回退，
  **只阻止下落、不上抬** → 修复 = `ridingCarFor` 加「嵌在车体内」分支。

**Tech Stack:** 纯 JavaScript ES2022 + JSDoc（禁 TypeScript、无 bundler）、浏览器内单测（`src/tests/`）+ Playwright E2E（`tests/`）。

**Spec:** `docs/superpowers/specs/2026-09-30-minecart-design.md` §4.4（本次修订了该节）

## Global Constraints

- **纯 JavaScript（ES2022+ ESM）+ JSDoc，禁止 TypeScript，无编译/转译、无 bundler。**
- **依赖方向 §3**：`player/` 不得 import `entities/`（同构层）。注入 service 引用而非硬依赖。
- **红线 1 数据只有一份权威**：矿车 state 权威在 `EntityManager`；`MinecartService.carAt` 是派生索引查询。
- **`_collides` 只在非乘坐时被调**（乘坐期 `physics.step` 整段跳过）→ 不需要「排除自己坐的车」。
- **`collidesAt`（乘坐跟随）保持仅方块**：矿车 Epic 既有裁定（避免乘客擦到另一辆车被甩下）。两个查询的分工是载荷性的，勿合并。
- **绑定帧不锁 y**：绑定在未绑定分支发生，「y 锁车顶」在已绑定分支（下一帧才跑）—— mc-lite 同序。测试在检测到绑定的当帧读 y 会读到 step-up 落点 `carY+1`，须多跑一帧再断言。
- **门禁分层**：physics 是热路径 → `npm run check` + 单测 + E2E + `npm run bench -- --check`。
- **每个 Task 结束必须 commit**（Conventional Commits）。

---

## 文件结构

**修改：**

| 文件 | 改动 |
|---|---|
| `src/player/physics.js` | `_collides` 格子循环加矿车格实心判定 + `minecarts` 注入字段 + `_tryStepUp` JSDoc |
| `src/player/player.js` | 构造时把 `minecarts` 注入 `this.physics.minecarts` |
| `src/entities/minecarts/minecart-system.js` | `ridingCarFor` 加「嵌在车体内」fallback 分支（Task 4） |
| `src/tests/test-physics.js` | 3 条新单测（矿车格挡人 / 对照 / 绑定容差咬合） |
| `src/tests/test-minecarts.js` | 1 条新单测（`ridingCarFor` 嵌入分支 + 负向，Task 4） |
| `tests/minecarts.spec.mjs` | 2 条新 E2E（走进静止车 / 车撞静止玩家，Task 4） |
| `docs/superpowers/specs/2026-09-30-minecart-design.md` | §1.1 修正失准描述 / §4.4 补两个绑定分支 + 落点核实 / §6 补偏离 ⑦⑧⑨ |
| `CLAUDE.md`（= `AGENTS.md`） | 矿车活跃约束段追加三条载荷性口径 |

---

## Task 1: PlayerPhysics 矿车格实心判定（TDD）

**Files:**
- Modify: `src/player/physics.js`（`_collides` + 构造函数）
- Test: `src/tests/test-physics.js`（3 条新用例）

**Interfaces:**
- Consumes: `MinecartService.carAt(x, y, z) → {id, state} | null`（floor 基格查询，`minecart-system.js`）
- Produces: `PlayerPhysics.minecarts`（可空字段，非 null 时 `_collides` 把矿车格视为实心）

- [x] **Step 1: 写 fixture + 3 条失败测试**

fixture `makeMinecartWorld()`：真 `MinecartService` + 真 `EntityManager`（不用 fake——`carAt` 的 floor 基格换算正是被测的东西）。布局：stone 地面 y=0 → 铁轨 y=1（solid）→ 矿车占据格 y=2。铁轨铺满 x=2..14（防玩家走出轨尾掉落导致对照用例因错误原因失败）。

3 条用例：
1. 「矿车占据格对玩家是实心」：注入 service → 走向车 → 到车格时 y ≥ 车顶（不穿模）
2. 「未注入 minecarts 时矿车格不挡人」（对照——证明上一条不是恒真）
3. 「踩上矿车后 ridingCarFor 命中」：step-up 落点 `carY+1` 与车顶 `carY+0.9` 差 0.1，被容差 0.3 吸收

- [x] **Step 2: 跑测试验证 RED**

Run: `npx playwright test tests/harness.spec.mjs`（浏览器内单测的唯一入口；当时用临时脚本
过滤只看 physics 用例，已删）
Expected: 用例 1 FAIL（`clipped=true`，穿模）、用例 3 FAIL（`ridingCarFor` 返回 null）、用例 2 PASS（对照）
Actual: ✅ 与预期一致。RED 失败用例名清单（使 RED 可复核，issue #3 C6）：
  - FAIL `physics: 矿车占据格对玩家是实心 —— 走进车不穿模，被抬到车顶（mc-lite isSolid 同口径）`
    （失败原因：`站在车格内时脚底不得低于车顶（穿模）: Expected false, got true`）
  - FAIL `physics: 踩上矿车后 ridingCarFor 命中（step-up 落点与绑定容差 0.3 咬合）`
    （失败原因：`站在车格上方应可绑定乘坐，y=2: Expected value to not be null or undefined`）
  - PASS `physics: 未注入 minecarts 时矿车格不挡人（对照 —— 证明上一条不是恒真）`
  全量计数不在文档硬编码（CLAUDE.md 口径）：当时为全量 627 条中仅上述 2 条新用例失败。
  事后负向验证（issue #3 审核复刻）：撤销修复后用例 1/3 真 FAIL、`clippedFrames=8`，
  用例 2 仍 PASS → RED 记录可信。

- [x] **Step 3: 实现 `_collides` 矿车格判定**

`src/player/physics.js` 构造函数加 `this.minecarts = null`（JSDoc 注明注入语义与「不需要排除自己坐的车」的理由）。`_collides` 格子循环末尾加：

```js
if (this.minecarts && this.minecarts.carAt(x, y, z)) return true;
```

- [x] **Step 4: 跑测试验证 GREEN**

Run: 同 Step 2
Expected: 全量全绿（计数以 harness 输出为准，不在文档硬编码 —— CLAUDE.md 口径）
Actual: ✅ 全绿（当时 627 条，0 failed）

- [x] **Step 5: Commit**（已执行：`f59699d`，已推送）

```bash
git add src/player/physics.js src/tests/test-physics.js
git commit -m "fix(player): 矿车占据格对玩家实心——走进车不穿模（mc-lite isSolid 同口径）"
```

---

## Task 2: Player 接线 + E2E（走进静止车 → 自动绑定）

**Files:**
- Modify: `src/player/player.js`（构造函数，1 行注入）
- Test: `tests/minecarts.spec.mjs`（1 条新 E2E）

**Interfaces:**
- Consumes: Task 1 的 `PlayerPhysics.minecarts` 字段
- Produces: 真游戏里玩家走进矿车 → step-up → 绑定乘坐的完整链路

- [x] **Step 1: 写 E2E 用例**

`tests/minecarts.spec.mjs` 新增「乘坐：玩家从轨道上走进静止矿车 → 自动站上并绑定（不穿模，不 teleport）」。

关键设计：
- 玩家放在车前 3 格的**轨面上**（脚底 y = 车顶格 y），朝 +X 走（`yaw = -π/2` + `KeyW`）
- **不 teleport 到车顶**——那正是既有用例绕过「走上去」而漏掉本缺陷的原因
- 穿模判据：脚底格与车格 XZ 重叠且脚底低于车顶 → `clippedFrames++`
- 绑定后**多跑 5 帧**再读 y（绑定帧不锁 y，mc-lite 同序）
- 断言：`bound=true`、`clippedFrames=0`、`|playerY - carTopY| < 0.01`

- [x] **Step 2: Player 构造时注入 service**

`src/player/player.js` 构造函数，`this.physics = new PlayerPhysics(world)` 之后加：

```js
this.physics.minecarts = minecarts;
```

- [x] **Step 3: 跑 E2E 验证 GREEN**

Run: `npx playwright test tests/minecarts.spec.mjs`（后台执行——Chromium 在 bash 沙箱里崩溃）
Expected: 11/11 全绿
Actual: 首次跑 10/11——新 E2E 的第三条断言失败（`playerY=20` vs `carTopY=19.9`，差 0.1）。
原因：**我自己的测试缺陷**——绑定当帧读 y 读到 step-up 落点 `carY+1`（绑定帧不锁 y）。
修正：绑定后多跑 5 帧再读 y。复跑 → ✅ 11/11 全绿。

- [x] **Step 4: 跑全量 minecarts spec 确认无回归**

Run: 同上（含既有 10 条用例）
Actual: ✅ 11/11

- [x] **Step 5: Commit**（已执行：`2c0e23b`，已推送）

```bash
git add src/player/player.js tests/minecarts.spec.mjs
git commit -m "fix(player): 接线矿车碰撞 + E2E 走进静止车自动绑定"
```

---

## Task 3: 门禁验证 + 文档同步

**Files:**
- Modify: `docs/superpowers/specs/2026-09-30-minecart-design.md`（§4.4 + §6）
- Modify: `CLAUDE.md`（矿车活跃约束段）

- [x] **Step 1: `npm run check`（arch + data + lint）**

Actual: ✅ 0 errors（13 warnings 均为既有 camelcase/unused，与本次无关）

- [x] **Step 2: `npm run bench -- --check`（physics 是热路径）**

Actual: ✅ 通过（无显著回退）。4 场景 fps/p95/draw 均在基线范围内。

- [x] **Step 3: 更新设计文档 §4.4**

补「走上车」机制（`_collides` 矿车格实心 → step-up → 绑定容差吸收）+ 修正被证伪的「不动 `_collides` 主路径」+ 补「绑定帧不锁 y」的测试注意事项。

- [x] **Step 4: 更新设计文档 §6 偏离表**

补偏离 ⑦：乘坐跟随的障碍检测不把其他矿车当障碍（mc-lite `checkAABBExcludeMinecart` 把其他车当障碍）。理由：车-车碰撞已由 `planMinecartStep` 处理；若把车加进 `collidesAt`，乘客擦到另一辆车会被甩下车。

- [x] **Step 5: 更新 CLAUDE.md 矿车活跃约束段**

追加两条载荷性口径：
1. `_collides`（非乘坐）= 方块 + 矿车格；`collidesAt`（乘坐跟随）= 仅方块。分工是载荷性的，勿合并。
2. 绑定帧不锁 y（mc-lite 同序）——测试须多跑一帧再断言。

- [x] **Step 6: Commit**（已执行：`0d03c04`，已推送）

```bash
git add docs/superpowers/specs/2026-09-30-minecart-design.md CLAUDE.md docs/superpowers/plans/2026-10-01-minecart-ride-collision.md
git commit -m "docs: 矿车乘坐碰撞修复——设计文档 §4.4/§6 修订 + CLAUDE.md 活跃约束 + 实施计划"
```

---

## Task 4: 场景 B —— 车撞静止玩家也自动绑定（2026-10-01 补，用户实玩发现）

**背景**：Task 1~3 只修了场景 A（玩家走进静止车）。端到端验证「被车带着走」时发现场景 B
仍穿模：玩家站着不动、车开过来撞 → 车从玩家身上开过去（实测 `clippedFrames=60`、
`bound=false`）。逐帧诊断定位根因：车在**前一格**跨轨道中心时经 `resolvePlayerBlocking`
把玩家抬到 `carY+0.9`，但玩家脚下那格**当时还没车** → 重力把玩家拉回轨面 `carY`。
等车走到玩家格时：`resolvePlayerBlocking` 只检查**前方格**（玩家已不在前方）→ 不再抬；
而 `ridingCarFor` 查 `floor(carY−0.1) = carY−1` ≠ 车格 `carY` → **恒不命中** → 永不绑定。

⚠️ **mc-lite 不需要这条 fallback**：它靠重力段的「向下扫描找支撑面 `gy`，
`if (y < gy) y = gy`」把玩家顶上车（其 `isSolid` 含矿车格）；本仓库重力是
`_moveAxis` 向下 + 碰撞二分回退，**只阻止下落、不上抬** → 必须补绑定侧 fallback。

**Files:**
- Modify: `src/entities/minecarts/minecart-system.js`（`ridingCarFor`）
- Test: `src/tests/test-minecarts.js`（1 条新用例）+ `tests/minecarts.spec.mjs`（1 条新 E2E）

**Interfaces:**
- Consumes: `MinecartService.carAt(x, y, z)`（floor 基格查询）
- Produces: `ridingCarFor` 两分支语义（① 站在车顶，mc-lite 原口径；② 嵌在车体内）

- [x] **Step 1: 写失败测试（单测 + E2E）**

单测「玩家嵌在车体内（脚底格 == 车格）也返回」：`[4.5, 11.0]` / `[4.5, 11.5]`（车体中部，
容差外）命中；负向：车在邻格 / 车格上方一格不命中。
⚠️ `[4.5, 11.5]` 这条钉的是「① 的容差判定失败必须 fall through 到 ②，不得直接
`return null`」—— 若实现写成先 return 再 fallback，这条必 FAIL。
E2E「玩家静止站着，矿车开过来撞」：玩家放车前 3 格轨面、不按任何键 →
断言 `bound=true` + `|playerY − carTopY| < 0.01` + `clippedFrames ≤ 5`。
⚠️ **穿模帧数阈值刻意不贴实测值**（实测 2）：贴线断言高负载下 flaky（同 CLAUDE.md 记的
`weapons-world-edit` 5ms 余量教训），取 5 与修复前 60 仍差一个数量级 → 注入回退必 FAIL。

- [x] **Step 2: 跑测试验证 RED**

Expected: 单测 FAIL（`脚底在车格底面 → 命中: Expected value to not be null`）、
E2E FAIL（`bound=false`、`clippedFrames=60`）
Actual: ✅ 与预期一致（单测 628 total, 1 failed；E2E 实测值与诊断脚本一致）

- [x] **Step 3: 实现 `ridingCarFor` fallback 分支**

```js
ridingCarFor(playerPos) {
  const [px, py, pz] = playerPos;
  const cellX = Math.floor(px), cellZ = Math.floor(pz);
  // ① mc-lite：feetY = floor(y − 0.1) + 车顶容差
  const c = this.carAt(cellX, Math.floor(py - 0.1), cellZ);
  if (c) {
    const topY = c.state.position[1] + MINECART.rideHeight;
    if (Math.abs(py - topY) < MINECART.rideBindTolerance) return c;
  }
  // ② 嵌在车体内：脚底格 == 车格（车撞静止玩家）
  return this.carAt(cellX, Math.floor(py), cellZ);
}
```

⚠️ ② 不需头顶净空检查：车能开到玩家格 = `resolvePlayerBlocking` 已在**前一格**检查过净空
（无净空则车停）；且玩家无法自己走进「车格内 + 头顶无净空」（车格对玩家实心 →
`_tryStepUp` 内部有净空检查）。

- [x] **Step 4: 跑测试验证 GREEN + 全量回归**

Actual: ✅ 单测 628/628；E2E `bound=true`、`boundAt≈1513ms`、`clippedFrames` **60→2**、
`playerY=19.9 == carTopY=19.9`；minecarts + render spec **13/13**；`npm run check` 全绿。

- [x] **Step 5: 文档同步**

spec §4.4 自动绑定改为两分支（含根因与「mc-lite 不需要」的机制差异）；CLAUDE.md 矿车
活跃约束段追加一条（含「穿模帧数断言不得贴实测值」）。

- [x] **Step 6: Commit**（已执行：`0317a74`，已推送）

```bash
git add src/entities/minecarts/minecart-system.js src/tests/test-minecarts.js tests/minecarts.spec.mjs docs/superpowers/specs/2026-09-30-minecart-design.md CLAUDE.md
git commit -m "fix(minecart): 车撞静止玩家也自动绑定乘坐——ridingCarFor 加嵌入分支"
```

---

## Review Focus

1. **玩家在自己脚下格放车**（实测 2026-10-01，node 隔离复现）：车格变实心后——
   - 静止不动：玩家留在车格内 y=2（与车体重叠）。mc-lite 同行为：两侧都没有
     「静止时把人推出车格」的机制（本仓库根本没有 pushOut；mc-lite 的 `applyPushOut`
     是六向 0.1 试探且只在 `isMoving || isStuck` 时调，推不出整格障碍）——
     静止时停在车格内是重力步二分回退收敛回原处的结果；
   - 第一帧水平输入：`_moveAxis` 碰撞 → `_tryStepUp` 立即抬到 y=3.000（车顶+0.1）
     → `ridingCarFor` HIT → 下一帧绑定乘坐。全程零帧穿模、无卡死。
     mc-lite 同路径同落点：其 `tryStepUp` 的矿车专用分支在走进车场景因
     `feetY = floor(y−0.01) = carY−1` 而 MISS，同样走通用循环抬到 `carY+1`
     （逐行复刻上游实测确认，issue #3 A1/A2 核实）。
2. **两辆车相邻时乘客擦到另一辆** → `collidesAt` 仅方块 → 不会被甩下车（偏离 ⑦ 的设计意图）。若未来把矿车加进 `collidesAt`，此行为会变。
3. **矿车被 TNT 炸毁时玩家正在乘坐** → `_updateMinecartRiding` 的已绑定分支检测 `entity` 消失 → 立即解绑。既有逻辑，本次未改。
4. **bench 热路径开销** → `_collides` 每格多一次 `carAt`（Map.get + 字符串拼接）。bench 通过，无显著回退。若未来矿车数量大增（>50），可考虑优化 `cellKey` 分配。
5. **玩家从空中跳上矿车**（Task 4 后推演，未单独写用例）：车格对玩家实心 → Y 轴向下碰撞
   二分回退停在车格顶面 `carY+1` → `onGround=true` → ① 查 `floor(carY+1−0.1)=carY` 命中、
   容差 0.1 → 绑定。既有路径自然接通，无需新机制。
6. **重绑冷却期（0.25s）内车撞玩家**（推演，未实测）→ 不绑定（未绑定分支被
   `_remountCooldown <= 0` 门控，`player.js:357`，既有语义且 mc-lite 同款门控）→
   车从玩家身上开过去。这是冷却期的预期行为（防下车立即重绑），不是缺陷；
   冷却过后恢复绑定。⚠️ 本条是读代码推演，未跑实测；若后续要拿它做断言需先实测。
