# 焰魔寻路：复用丧尸三层寻路（v2.61）

## 要解决的问题

**现象（用户实玩 2026-11-05）**：焰魔与玩家之间有方块阻隔时，玩家站住不动，焰魔也站着不动 —— 不绕行、不找路。

**用户要求**：参照丧尸的寻路，做到跟丧尸一样能绕行障碍物找到玩家并走向玩家。

## 根因（两条，必须一起修）

### 根因 1：视线是 `chase` 的生死门

`src/entities/bosses/ignis-boss-agent.js` 的 chase 分支：

```js
} else if (mode === 'chase') {
  if (!losVisible) mode = 'idle';
```

一旦有方块挡住（胸 → 胸的 `hasLineOfSight`）就退回 `idle`，而 `idle` 除了缓慢转头什么都不做；要回 `chase` 又要先"视线通"，于是**永久僵住**。

丧尸没有这个门控 —— 它只看距离。`zombie-navigator.js` 的 `decideStep` 根本不消费 LOS。

### 根因 2：焰魔完全没有长距离寻路

焰魔只有 `steerIntentAabb`（`src/entities/zombies/zombie-navigation.js`）：1.2 格前瞻、±22.5°/45°/67.5°/90° 四档局部绕行。墙角能滑过去，但**看不到墙的尽头**。

这正是丧尸 v2.46 被推翻的那一层判断（`zombie-pathfinder.js` 头部注释）：

> v1 的在线 AI 只在 9×9 窗口里让模型选方向 —— 实测 31 格宽的墙让 69 次决策全部耗在原地横跳（60 秒净位移 0.7 格）：**模型永远看不到墙的尽头**，信息根本不在它眼前。局部信息缺失无法靠措辞弥补，故「长距离可达性」必须由代码算。

## 丧尸寻路的现状（可见复用面）

| 层 | 文件 | 职责 | 关键常量 |
|---|---|---|---|
| ① 长距离 | `zombie-pathfinder.js` | 24 格有界 A\*（切比雪夫半径、**A\* 而非 BFS**、8 邻接固定顺序）+ `PathCache`（4 s 时效 + 路径前缀匹配 + 计划方向仍朝目标） | `PATHFIND.maxRadius = 24`、`maxExplored = 2601`、`nearRadius = 1`（实测标定） |
| ② 方向 | `zombie-navigator.js` `decideStep` | 把地标修成"能走的那一步"：贴墙滑行、计划固化防等长路线横跳、不可达回落直线 + 局部绕行 | `ZOMBIE_STEERING.anglesDeg` |
| ③ 精细 | `zombie-navigation.js` `steerIntentAabb` | 最后 1.2 格避让 | `probeDistance = 1.2` |

焰魔 v2.55 已在用第 ③ 层（`IgnisBossAgent` 的"局部绕行"段），**只缺第 ①② 层**。

## 三条硬约束

1. **丧尸寻路写死了丧尸的 AABB**：`zombie-pathfinder.js` 的 `standable()` 直接调 `zombieCollidesAt`，且快路径注释写明"丧尸高 1.8 ⇒ 占据 by 与 by+1 两层"。焰魔 halfWidth 0.5 / height 3.25 **必须占 4 层**。照搬会让"规划得出、物理走不通"——AGENTS.md 明写这条漂移只能靠实玩发现。
2. **不能写第二份寻路**（红线 1）。v2.55 已用同一手法参数化过 `aabbCollidesAt` / `steerIntentAabb`，本次照做：**加可选 AABB 参数、缺省等于丧尸值**，丧尸逐位零回归。
3. **`entities/` 是 Worker 同构层**：不得 import three/DOM、不得自建 Worker（`check:arch` 静态门守）。寻路是纯本地计算，在主线程 `IgnisService` 里跑 —— 与丧尸 `_stepNavigator` 完全同构，走同一条"服务写意图 → definition 跑物理"的分工。

## 改动清单

### 1. `src/entities/zombies/zombie-navigation.js`

导出 `AABB_EPSILON`（现 `PHYS_EPSILON` 改名导出，内部引用不变）。

理由：pathfinder 的快路径必须用**同一个** epsilon 才与 `aabbCollidesAt` 逐位等价；写第二份就是同一事实的第二个副本（红线 1）。该常量本身载荷性极强（少了它会把"净空恰好 1.8"的走廊判成堵死）。

### 2. `src/entities/zombies/zombie-pathfinder.js`（参数化，丧尸零回归）

- 新增 `DEFAULT_BOX`：`{ halfWidth: ZOMBIE.width / 2, height: ZOMBIE.height, maxStep: ZOMBIE_MAX_STEP }`。
- `standable(world, x, y, z, box)`：层数由**实际 AABB 跨度**算
  `Math.floor(y + height − AABB_EPSILON) − Math.floor(y) + 1`，不再写死 2。
  - 整数 `y` 且 `height` 1.8 时结果与现状**逐位相同**（2 层）；
  - 焰魔（3.25）得 4 层；
  - 非整数 `y` 时比现状更严格（可能多走一次权威 AABB 判定）—— 方向是"更等价"，不会更宽松。
- `planStep(world, from, to, { maxRadius, box })` 与 `PathCache.plan(..., { maxRadius, agentId, nowMs, box })`：`box` 转发到 `standable`，缺省 `DEFAULT_BOX`。
- 快路径判据改写：`!isSolid(cx, by, cz)` + 遍历 `by+1 … by+n−1` 全空 + `isSolid(cx, by−1, cz)`。
- **不新增第二份 A\***；不改邻接顺序（确定性红线 2）。

### 3. `src/entities/zombies/zombie-navigator.js`（参数化，丧尸零回归）

`decideStep({ ..., box, steering = ZOMBIE_STEERING })`：
- `steering` 替换现在写死的 `ZOMBIE_STEERING.anglesDeg`（两处：规划方向被挡时的滑行、不可达时的回落扫描）；
- `box` 转发给 `pathCache.plan`。

角度档位与宽度无关（既有注释已写明），焰魔直接复用同一组角度 —— 两个地面实体绕同一堵墙时不会走出不同风格。

### 4. `src/entities/ignis/ignis-system.js`（`IgnisService` 承担第 ①② 层）

与 `ZombieService._stepNavigator`（`zombie-system.js:520-581`）同构：

- 新增成员：`_pathCache = new PathCache()`、`_navMemory`、`_navAccum`、`_navDecisions` / `_navBlocked`（诊断）。
- 新增 `update(dt, { playerPosition })`：累计到 `IGNIS_AI.navPeriod`（0.05 s = 20 Hz，与 `ZOMBIE.aiPeriod` 同周期）才推进一次 `_stepNavigator`。
- `_stepNavigator(playerPosition)`：对每只 `state.needsPath === true` 的焰魔调 `decideStep`
  - `box` = `{ halfWidth: IGNIS.halfWidth, height: IGNIS.height, maxStep: IGNIS_AI.maxStep }`
  - `isWalkable` 用 `aabbCollidesAt` + `zombieStepUpY` + `IGNIS_AI.maxStep`（**不自己用 `isSolid` 拼** —— 那会把"脚下是地面"误判成不可走，丧尸侧实测踩过）
  - 结果写进 `state.navDir = [vx, vz] | null` 与 `state.navMode`
  - **只给 `needsPath` 的实体算**：正常直线追击不跑 A\*（焰魔 maxAlive = 2，成本本来就低，但这条纪律防的是"以后加更多 Boss 时每帧全跑"）
- `createState` 增加 `navDir` / `navMode` / `needsPath` 三个字段（含缺省，旧调用不破）。
- 死亡 despawn 与 `dispose()` 时 `_pathCache.forget(id)` + 删导航记忆（同 `ZombieService` 的三条回收路径纪律）。

### 5. `src/entities/bosses/ignis-boss-agent.js`（决策层）

#### ① 视线不再决定"有没有资格追击"

| 转移 | 现在 | 改成 |
|---|---|---|
| idle → chase | 视线通 **且** hDist ≤ sightRange | **hDist ≤ sightRange**（去掉视线） |
| chase → idle | `!losVisible` | **hDist > disengageRange** |
| attack → chase（中断） | `!losVisible` 或 hDist > disengageRange | **不变**（挥砍途中被挡开就该重找路） |
| chase → attack | hDist ≤ attackRange 且冷却 ≤ 0 | **不变** |

去掉 idle→chase 的视线门是刻意的：有了寻路，"看不见"从一个**停止条件**变成一个**可解状态**。`losVisible` 于是只服务一件事 —— "这一刀砍不砍得到"（起手前提 + 命中帧的新鲜复查，两处都不动）。

#### ② chase 的移动意图分两路

```
if (玩家看不见)      → 逼近（强制走寻路）
else if (环内死区)    → 原地不动，只转向        // v2.60 站定环语义一字不改
else if (太近)        → 背离退让              // 同上
else                  → 逼近（走寻路）
```

"玩家看不见就继续逼近"是必需的：否则玩家站在墙后、焰魔停在站定环上，会永远隔着墙空砍。

#### ③ 逼近时是否用寻路结果

```
direct   = 朝玩家（ring 给出的全速）
steered  = steerIntentAabb(direct)                    // 已有的 1.2 格前瞻
deviated = steered.blocked || 与 direct 夹角 > 5°
needsPath = deviated || !losVisible                   // 写回 state，供服务下一拍规划
want     = (deviated && state.navDir) ? navDir × chaseSpeed : steered
接着 want 再走一次 steerIntentAabb                     // 8 向地标也要过局部避障
```

`needsPath` 的判据用**相对 `direct` 的偏差**而不是最终向量 —— 否则会"用 navDir → 不偏 → 清标志 → 下一帧又偏"地自激。

无阻碍时 `steerIntentAabb` 0° 命中会**逐位原样返回**，故 `deviated` 恒 false，通天大道上的手感与现在完全一致（不引入 8 向网格化走路）。

### 6. `src/core/game.js`

在 `this.zombies.update(...)` 旁边加：

```js
this.ignises.update(dt, { playerPosition: [pp.x, pp.y, pp.z] });
```

位置在 `entities.update` **之前**（与丧尸同一理由：意图先写、物理后跑）。加注释说明顺序载荷性。

### 7. `src/entities/ignis/ignis-config.js`

新增 `navPeriod: 0.05`（= `ZOMBIE.aiPeriod`）。

寻路半径直接复用 `PATHFIND.maxRadius`（24）—— **不新增一份可调常量**，那会变成两个半径互相漂移。

## 验证

### Tier 1 → TDD（先红后绿）

**`src/tests/test-zombie-pathfinder.js`（+3）**
- 丧尸参数调 `planStep` 与不传 `box` 的结果**逐位相同**（零回归硬判据）。
- 焰魔 box（0.5 / 3.25）下：2 格高的门洞**判不可走**、4 格高的门洞**判可走** —— 钉住"高度真的参与了可走性"。
- `decideStep` 不传 `steering` 时行为不变。

**`src/tests/test-ignis-boss-agent.js`（+5）**
- 视线被挡但玩家在 `disengageRange` 内 → **仍是 chase**（现有那条"视线被挡退回 idle"的用例按新语义重写 —— 它正是缺陷的编码）。
- 越过 `disengageRange` → 退回 idle。
- 长墙（x ∈ [−14, 14]、z ≈ −2，远于 1.2 格探针）挡在中间、玩家在墙后 → 真实物理推进 30 秒后与玩家水平距 ≤ `standoffRange + 1`，**且绕行段里穿越墙所在 z 时 |x| > 14**（证明是绕过去而不是穿过去）。
- 四面围死 → 不产生 NaN、不穿墙、不来回抖（`blocked` 时站住）。
- 无阻碍直线追击 → `needsPath === false`（不触发 A\*，行为零变化）。

**`src/tests/test-ignis-system.js`（+2）**
- `IgnisService.update` 在 `needsPath` 为真时写入 `navDir`、为假时保持 `null`。
- 死亡后 `_pathCache` 不再保留该 id（`cachedPathOf(id) === null`）。

### Tier 4 像素/真实帧循环

**`tests/ignis.spec.mjs` +1**

真实游戏页、祭坛高台地带：用 `g.editor.setBlock` 逐列（从该列地表向上 5 格）垒一道 13 格宽的墙在玩家 +Z 侧 8 格处，把焰魔召到墙外 11 格，**玩家站定 45 秒**，断言：
1. 玩家血量下降（它绕过去砍到了，不是隔墙空砍）；
2. 墙的方块全部还在（它是走过去的，不是拆墙）；
3. 焰魔任何时刻没有落进墙体内。

### 负向验证（单变量、`cp` 副本还原 + sha256 核对）

- 把 `needsPath` 恒置 false → 长墙单测与 E2E 必须真红。
- 把 `standable` 的层数退回写死 2 → "2 格门洞不可走"那条必须真红。
- 把 `chase → idle` 的 LOS 门控加回去 → "视线被挡仍是 chase"必须真红。

### 回归

- `npm run check`（arch / data / lint）
- `npx playwright test tests/harness.spec.mjs`（浏览器单测全量）
- `tests/ignis.spec.mjs` 全部
- `tests/zombies.spec.mjs` 与 `test-zombie-*` 相关分组（丧尸零回归）

## 明确不做（非目标）

- **不做跨层寻路**：`planStep` 只在 `from[1]` 这一层搜（丧尸同口径）。玩家在焰魔上/下数层时不保证能到 —— 这条限制写进 spec 与 roadmap。
- **不放大寻路半径**：沿用 24 格（`PATHFIND.maxRadius`）。更大半径是"每帧全图 BFS"，正是 M6 规格 §1 那条禁令真正要防的形态。
- **不拆方块**：焰魔没有破坏地形能力，绕不过去就走不过去。
- **不改丧尸行为**：所有新参数都有等于丧尸现状的缺省值，由逐位等价用例守住。
- **不动站定环**（v2.60）、命中判据（`hitRange` / `hitConeDeg` / 冷却）、动画时序。

## 文档

- `docs/superpowers/specs/2026-11-05-ignis-boss-design.md` §4.4 加"寻路"小节（三层来源、`needsPath` 协议、视线只服务命中、跨层非目标）。
- `docs/roadmap.md` 新增 v2.61 行（根因两条、实测对比、判定依据、遗留）。
