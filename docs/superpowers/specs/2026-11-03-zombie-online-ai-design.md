# 丧尸在线 AI（Jev）设计

> 状态：**v1 已实施**（12 个 TDD 任务，commit `ed1844d..85f24fa`）→ **v2 修订中（2026-11-04）**
>
> **v2 修订说明（2026-11-04，用户实玩反馈「AI 还是太糟糕，不会绕路、不会寻路」）**：
> v1 的实测结论是「只要绕行超过约 4 格就必然失败」——31 格宽的墙把 69 次决策全部耗在原地横跳，
> 一次也没走出去。根因不是接线，而是**架构缺口**：模型只看 9×9 网格，**永远看不到墙的尽头**，
> 所以它无从知道该往东还是往西绕。用户裁定采用**分层**：**代码寻路 + 模型裁决**。
> 新增 §3.10（代码寻路组件 `zombie-pathfinder.js`）与 §2.7（长墙实测），其余约束不变。
> 前置：`docs/superpowers/specs/2026-11-02-zombie-obstacle-avoidance-design.md`（v2.40 本地避障）
> 用户需求（2026-11-03）：「使用 js-perf.cn 转接过来的 typesafe 接口对我的丧尸的 AI 能力进行增强，
> 把我和丧尸之间的方块数据传递给接口，让接口来判断丧尸行进的方向，然后在游戏中进行调整……加一个
> 代码中的开关，控制这个在线的丧尸 AI 是否开启，开启就走模型AI，不开启就还是现在的傻瓜离线 AI。」

## 1. 背景、目标与非目标

### 1.1 现状（M6 + v2.40）

丧尸 AI 只有两条规则，全部在 `src/entities/zombies/`：

1. **直线追逐**（`computeAiUpdates`）：`velocity = normalize(player - zombie) × speed(1.2)`，
   玩家超出 `perceptionRange`(80) 则 idle。
2. **局部避障**（`steerIntent`，v2.40）：0° 探不通就按 ±22.5/45/67.5/90° 找一个
   `probeDistance = 1.2` 格外不撞的方向；全不通 → `blocked`（原地站定）。

**已知能力上限**：没有记忆、没有全局视野，只会「绕开眼前 1.2 格」。实测（§2.3 的对照）在需要
长距离绕行的地形里会**永久打转**（U 形/螺旋/迷宫，循环检测在 6~8 步内触发）。

### 1.2 目标

- 引入在线模型（Jev / TypeSafe System One）做**方向判断**，让丧尸在复杂地形里能绕通。
- 提供一个**代码 + 面板 + URL** 的开关：关 = 现有离线 AI 原样（逐位零回归），开 = 在线 AI。
- 在线 AI 失败（网关拦截 / 限流 / 超时 / 解析失败）时**静默降级**到离线 AI，且**必须打 log 便于排查**。

### 1.3 非目标

- **不做寻路网格 / A\* / BFS**（M6 规格 §1 的非目标仍然有效）。在线 AI 的输入里**不包含**
  任何由寻路算出的「最优下一步」——那是把答案喂给模型。
- 不改丧尸物理、AABB、步态、渲染、伤害路由、持久化。
- 不做多语言、不做玩家可编辑提示词、不做模型微调。
- 不替换**巢穴刷怪 / 炮塔索敌**的 AI（它们与丧尸 AI 无关）。

## 2. 探针实测（决定设计的依据）

全部为 2026-11-03 对 `https://js-perf.cn/typesafe/v1/systemone` 的真实调用
（模型 `jev-1.14.0`，共 244 次请求），不是推断。

### 2.1 接口事实

| 项 | 实测 |
| --- | --- |
| 连通性 | `GET /v1/models` 与 `POST /v1/systemone` 均 200；**直连最快**（`?proxy=1087` 反而慢 10 倍） |
| CORS | `access-control-allow-origin: *`；`OPTIONS` 预检 204 且带回允许的方法/头 → **浏览器可直接调** |
| 延迟 | 单次 330~800ms，**中位 395ms**（n=244） |
| token | 单只丧尸（9×9 窗口 + 8 候选）约 **1100 input tokens**；批量 3 只 3692 |
| 请求体 | 单只约 3.5KB；20 只各带独立 state 约 70KB |
| 网关拦截 | **间歇性**：被拦时返回**一段 HTML**（403 或 307 跳 `office-sec.alibaba-inc.com`），非 JSON。同一分钟内可能 5 次 403 后连续 200 |

### 2.2 题型与 state 编码的 A/B（同一批 12 个小迷宫）

判据「最优步」= 与最小 BFS 距离并列；「退步」= 所选方向的 BFS 距离没有减小。

| 编码 | 最优 | 退步 | **选了墙（非法）** | tokens |
| --- | --- | --- | --- | --- |
| 只给 ASCII 方块图（8 候选） | 6/12 | 6/12 | **4/12** | 684 |
| 7×7 以 Z 为中心的窗口 | 7/12 | 5/12 | **4/12** | 681 |
| **只给候选事实（可走性的由代码判）** | 10/12 | 2/12 | **0/12** | 929 |
| 候选事实 + 7×7 窗口 | 11/12 | 1/12 | **0/12** | 1078 |

**结论**：Jev 不擅长「从矩阵里数出哪格是墙」（官方 `model-jaggedness` 也把「计数 / 数学」列为
已知弱点）。**可走性必须由代码算，模型只做「往哪个可走方向走更聪明」的判断。**

### 2.3 是否真的比离线 AI 强（困难地形 × 完整 rollout）

地形 = 手工构造并用 BFS 校验可达的 5 个（U 形 / 螺旋 / 长迷宫 / 死胡同 / 折返）。
三条策略各跑完整回合（最多 120 步）：

| 地形 | BFS 最优 | 离线 AI（1.2 格探针，无记忆） | Jev（9×9 + 事实 + **记忆**） |
| --- | --- | --- | --- |
| U 形·开口东 | 14 | OK@13 | OK@13 |
| 螺旋 | 12 | OK@12 | OK@11 |
| 长迷宫 | 25 | **FAIL(looping)** | **OK@92** |
| 死胡同 | 9 | OK@8 | OK@8 |
| 折返 | 67 | **FAIL(looping)** | FAIL(maxsteps) |

**Jev 更好 2 / 离线 AI 更好 0 / 平手 2 / 双方都失败 1。**

### 2.4 「记忆」是载荷性的（不能省）

同一组地形，**去掉**「该格已被走过几次」这条事实后：螺旋与长迷宫**双双退化成无限绕圈**
（59 步不出）。加上记忆后两者都通。
⇒ **记忆（`trail` / 访问计数 / 死胡同标记）必须由代码维护并放进 state**，不能指望模型自己记住。

### 2.5 窗口尺寸

7×7 / 9×9 / 11×11 三档：9×9 是唯一在**全部**地形上都通的档位（7×7 在螺旋与长迷宫 runaway，
11×11 在长迷宫 runaway）。⇒ **默认 9×9**，常量可调。

### 2.6 「可达性」类 noul 不可靠，不进设计

问「北面那格是不是墙」时实测给出 `0.70`（实际是墙）、`0.29`（实际是空地）、`0.99` 之类
与真值无关的读数 ⇒ **不用 noul 做任何几何判断**，只用 1 个 `choice` 做方向取舍。

## 2.7 长墙实测（v2 修订的触发点，2026-11-04）

用户实玩反馈「AI 还是太糟糕，不会绕路，不会寻路」后的定量复现（`tests/tmp-repro.spec.mjs`，
城外平地、31 格宽 × 3 格高长墙、丧尸在墙南 2 格、玩家在墙北 8 格）：

| 指标 | 实测 |
| --- | --- |
| 决策次数 / 失败 | 69 / **0**（在线 AI 一直在正常工作，不是掉线） |
| 60 秒后的位置 | (284.2, 56, 179.4) ← 起点 (283.5, 56, 179.5)，**净位移 0.7 格** |
| 是否越过墙 | **否** |
| `path_to_player.walkable_steps_toward_player` | 全程 **0~1**（墙就在正前方） |
| 模型选的方向 | `east` / `west` / `south_east` / `south_west` / `north_west` 反复横跳 |

**根因**：9×9 窗口的半宽是 4 格，而墙宽 31 格 ⇒ **模型永远看不到墙的尽头**。它收到的每条事实都是
「这一格能走、离玩家更近半步」，于是选哪边都"合理"，表现为原地打转。这不是调提示词能解的
——**信息根本不在地图上**。

**结论**：局部窗口 + 局部事实的架构，**在绕行距离 > 窗口半宽（4 格）时结构性失效**。必须由代码提供
「长距离可达性」，模型只在代码给出的候选里做取舍。这直接推翻 v1 只在 9×9 里做决策的假设。

## 3. 架构

### 3.1 分层与文件

```
src/entities/zombies/
├─ zombie-config.js          （既有；新增 JEV_AI 常量块）
├─ zombie-navigation.js      （既有；不动）
├─ zombie-system.js          （既有；`_applyIntent` 增加在线 AI 的接管点）
├─ zombie-ai-view.js         ★ 新增：世界 → state 的纯函数（窗口采样 / 候选事实 / 记忆）
├─ zombie-jev-client.js      ★ 新增：HTTP 客户端 + 请求节流 + 失败熔断（唯一联网点）
└─ zombie-jev-prompts.js     ★ 新增：题面与选项文案的唯一权威
```

**为什么不放 worker**：世界数据的唯一权威在主线程（红线 1），且 `fetch` 在 `entities/` 同构层
是被允许的（`check:arch` 只禁 three / DOM / 自建 Worker，`nest-blueprint.js` 已有 fetch 先例）。
AI 决策在**主线程异步**进行，一次 400ms 的等待期间其它逻辑照跑。

**为什么不新建 Worker**：红线 3 的 `new Worker` 入口唯一（`core/worker-pool.js`）。
本功能不需要后台线程 —— HTTP 本身就是异步 IO。

### 3.2 数据流（每只丧尸独立）

```
帧循环（Game._frame，已有）
  └─ zombies.update(dt, {playerPosition})          ← 既有入口，不新增帧序
       ├─ 离线：pool.call('ai', …) → _applyIntent   ← 既有路径，开关关闭时逐位不变
       └─ 在线：JevPlanner.tick(dt)                 ★ 新增
            ├─ 选一批「该决策的」丧尸（周期 0.5s，并发 ≤ 4）
            ├─ buildAiState(world, entity, player, memory)   （纯函数，主线程读 world）
            ├─ client.request(state) → Promise<answer>       （异步，不阻塞）
            └─ 回包 → memory 更新 → _applyIntent({vx,vz,mode})
```

### 3.3 「每只独立异步 + 平滑跟随」（用户裁定）

- **决策周期**：每只丧尸 `JEV_AI.decisionPeriod = 0.5s`（从**上一次回包**算起，不是发起算起）。
- **并发上限**：`JEV_AI.maxConcurrent = 4`；超出则排队，同一只不重复入队（`inFlight` 标记）。
- **等待期间**：丧尸**继续沿上一次决策的方向走**（`state.velocity` 不动），
  并**仍然经过 `steerIntent`** 兜底 —— 也就是说在线 AI 只决定「往哪」，贴身的 1.2 格避让
  仍由离线探针执行（两者是叠加关系，不是替换）。
- **首次决策前**：该只丧尸走离线 AI（不必等 400ms 站着不动）。

### 3.4 记忆（`ZombieTravelMemory`）

每只丧尸一份，存在 `ZombieService._memory: Map<id, memory>`，随 slot 回收一并删除：

```js
{
  visits: Map<"x,z", count>,   // 走过的格（水平坐标，最多 64 项，LRU 淘汰）
  trail: Array<[x,z]>,          // 最近 12 个格（给模型看「我来过哪」）
  deadEnds: Set<"x,z">,         // 判定的死胡同（除来路外无出口）
  lastDecision: { vx, vz, at }, // 上一次的决策（等待期间沿用）
  armed: boolean,               // 是否已完成首次决策
}
```

**死胡同判定（代码侧，纯函数）**：丧尸走到某格后，若「除来路外的可走方向数 == 0」，
标记该格为 deadEnd，并把丧尸的目标方向反转一次（下一次决策会看到这条事实）。
⚠️ **不要求模型自己发现死胡同** —— 代码能算的不要问模型（§2.2 的结论）。

### 3.5 state 的形状（给 Jev 的「环境信息」）

单一权威 = `zombie-ai-view.js` 的 `buildJevState()`，输出**完全可 JSON 序列化**：

```jsonc
{
  "situation": "A zombie chases the player through terrain with walls. ...",
  "player_direction_from_zombie": "north and west",     // 代码算
  "straight_line_distance_now": "18.4 meters",           // 代码算
  "steps_already_walked": 7,                             // 记忆
  "ground_window": {                                     // ★ 用户要的「方块矩阵」
    "rows": [ ".........", "..#...#..", "..##Z##..", ... ],  // 9 行 × 9 字符
    "top_is": "north",
    "left_is": "west",
    "legend": "Every character is one square meter of ground. '.' is walkable ..."
  },
  "candidate_steps": {                                   // 只含**可走**方向（1~8 项）
    "north": {
      "direction": "north",
      "player_lies_toward": "north and west",
      "straight_line_distance_after_step": "17.8 meters",
      "closer_or_farther": "closer to the player",
      "open_ground_ahead": "6 meters",
      "other_ways_out_after_the_step": 2,
      "times_already_visited": 0
    }
  }
}
```

**窗口采样规则**（唯一实现 `sampleGroundWindow`）：
- 9×9，以丧尸脚底所在格为中心；
- `Z` 在正中，玩家在窗口内则标 `P`；
- **可走**（丧尸 AABB 在 `y` 处不撞、或抬一格不撞 —— 复用 `zombieCollidesAt` + `zombieStepUpY`）
  → `.`；不可走 → `#`；**世界未加载的 column → `#`**（与「墙」同码，且这条要写进 legend）。
- ⚠️ 判据**复用 `zombie-navigation.js`**（红线 1），不写第二份 AABB 采样。

### 3.6 问题（提示词的唯一权威 = `zombie-jev-prompts.js`）

只 **1 个 `choice`**（§2.6：noul 不可靠）：

```jsonc
"step": {
  "type": "choice",
  "instructions": "Which candidate step is most likely to lead `Z` to `P` without getting stuck? Use both the ground window and the candidate facts. Do not step onto a square the zombie has already visited when another step keeps the route open.",
  "criteria": {
    "north": "Step north, toward the top of the picture. After it the player lies north and west and is 17.8 meters away, so this step is closer to the player. Open ground continuing that way: 6 meters. Other ways out after the step: 2. The zombie has stood on that square 0 times before."
    // … 只列可走方向
  }
}
```

**选项名 = 方向名**（`north` / `north_east` / …）—— 官方 skill 明确「选项名会发给模型，
`A`/`option_1` 给不了任何信息」。**8 个方向全列**（不行就只列可走的：代码已过滤，模型见不到墙）。

### 3.7 答案 → 动作（代码侧映射与兜底）

`answer.choice` 是一个方向名：

1. 查 `DIRECTION_VECTORS[choice]`（`zombie-ai-view.js` 的常量，8 项）；
2. **必须校验该方向当前可走**（`zombieCollidesAt`）——模型可能给出过期/幻觉答案；
3. 不可走 / 未知方向 / 无 `choice` → **视为本轮失败**（`reason: 'illegal-direction'`），
   该丧尸继续用上一次的方向（`lastDecision`），若无则走离线 AI；
4. 可走 → `_applyIntent({ vx: dx*speed, vz: dz*speed, mode: 'chasing' })`，并记入 `lastDecision`。

⚠️ **不因为「模型说 north」就跳过 `steerIntent`**：`_applyIntent` 里的离线探针照常执行。

### 3.8 失败与熔断（用户裁定：静默降级 + **console log**）

- 每个失败都 `console.warn('[zombie-ai] …')`，带 `reason` 与丧尸 id（**用户明确要求打 log 排查**）。
  reason 枚举（逐条独立，不合成一句「失败」）：
  `network-error` / `http-<status>` / `not-json`（网关拦截）/ `no-answer` / `illegal-direction` / `timeout`
- **`not-json` 是最容易误判的**：网关拦截返回 HTML，`res.json()` 会抛 —— 必须当作失败，
  **不得当成「没有方向」**（那会静默让丧尸停住）。
- **连续失败 3 次 → 整体暂停在线 AI 30 秒**（`JEV_AI.cooldownMs`），期间所有丧尸走离线 AI，
  并在恢复时打一条 `console.info('[zombie-ai] resumed after cooldown')`。
  失败计数在**任何一次成功**后清零。
- 超时：`JEV_AI.timeoutMs = 4000`（AbortController）。

### 3.9 开关（用户裁定：面板 + URL）

- `settings.onlineZombieAi: false`（**默认关**）。
  ⚠️ 新字段旧存档里不存在 ⇒ 缺字段自然回落默认，**不需要 `settingsVersion` 迁移**
  （与 `chunkPace` / `pixelRatio` 同理，与 `fogColor` 那次相反）。
- URL：`?zombieai=1` / `?zombieai=0`。
- 面板：左列新增一行「丧尸 AI」两按钮（关闭 / 在线）。**落位 = 左列**（v1.63/v1.92 的判据：
  「不抬高面板高度的那一列」——落位前须实测两列高度，见 §6.3）。
- **运行期切换立即生效**：`Game.setOnlineZombieAi(v)`（关 → 取消全部在途请求、清记忆、恢复离线路径）。
- 端点可覆盖：`JEV_AI.endpoint = 'https://js-perf.cn/typesafe/v1/systemone'`（常量，不在面板暴露）。
  `?jevendpoint=` 仅供调试。

## 3.10 代码寻路组件（v2 新增，用户裁定「代码寻路 + 模型裁决」）

### 3.10.1 为什么必须分层

§2.7 的实测证明：局部 9×9 窗口在绕行距离 > 4 格时**结构性失效**。信息缺失无法靠措辞弥补。
故新增一层：**代码算「怎么绕」，模型判「现在这一步该不该这么走」**。

职责切分（这是本设计的核心不变式）：

| 判断 | 谁做 | 理由 |
| --- | --- | --- |
| 目标点是否可达、绕行路径怎么走 | **代码**（BFS） | 需要全局可达性，模型看不到 |
| 下一个地标（waypoint）在哪 | **代码** | 同上 |
| 这一步具体踩哪一格 | **模型** | 局部避让、避免重复走、判断"看起来堵" |
| 可走性（某格能不能站） | **代码** | 已在 v1 确立（模型 4/12 次选墙） |

### 3.10.2 `src/entities/zombies/zombie-pathfinder.js`

纯函数、无 DOM 无 three、无状态（同构层）：

```js
/**
 * 从丧尸位置向玩家做有界 BFS，返回路径上的下一个地标。
 * @returns {{reachable: boolean, nextStep: [dx, dz]|null, distance: number,
 *            exploredCells: number, truncated: boolean}}
 */
export function planStep(world, from, to, {maxRadius = 24, y = null} = {})
```

- **算法**：24 格半径内的 **BFS**（8 邻接），目标 = 与玩家水平距离首次 ≤ 1 的格。
  用 BFS 不用 A*：半径只有 24，探索量上限 `(2·24+1)² ≈ 2401` 格，BFS 的常数更小且不需要优先队列
  （避免在主线程引入排序开销）。
- **只搜水平面**：`y` 固定为丧尸当前脚底高度，一格台阶（`zombieStepUpY`）算可走、两格不可走。
  **不跨层寻路**（不搜上下楼梯）——那是三维搜索，成本 ×几十，且当前玩法里丧尸追的是同一层平面上的玩家。
- **`truncated`**：探索到半径上限仍未连通时置 true。此时 `reachable=false`，**回落到 v1 的局部行为**
  （模型在 9×9 里自行找路）—— 保证「远处玩家」不会让丧尸完全瘫痪。
- **成本**：实测 24 格半径最坏 ~2401 次 `isSolid`（每次 O(1) typed-array 读）→ 目标 **< 0.3ms**。
  每只丧尸每 0.5 秒算一次（复用决策周期，不新增节流）。
- **确定性**：邻接顺序固定（N, NE, E, SE, S, SW, W, NW），同一输入必得同一路径（红线 2）。

### 3.10.3 进 state 的新事实

`buildJevState()` 增加一段（**不改变原有字段**）：

```jsonc
"path_plan": {
  "reachable_within_24_meters": true,
  "next_step_toward_player": "east",     // 代码算的下一步方向名
  "path_length_in_steps": 31,            // 完整路径长度（模型据此判断"要不要耐心绕"）
  "walked_along_this_plan": 6            // 记忆：当前计划已经走了几步
}
```

**候选方向的 `criterion` 里也带一条对齐信号**：
`This step continues the planned route.` / `This step leaves the planned route.`

### 3.10.4 模型的新职责（题面修订）

从「选哪个方向走向玩家」改为「**代码给了一条可行路线，判断这一步该不该照走**」：

> "A route planner has worked out a walkable route from `Z` to `P`, and one of the candidate steps
> continues that route. Pick the step the zombie should take now. Follow the planned route unless the
> step looks worse than another option — for example, the square it leads to has already been visited
> many times, it is a dead end, or it leaves almost no room to move."

这样模型仍然可能「否决」代码的路线（例如掉头、重复绕圈），但**它不再需要自己发现绕行方向**。

## 3.11 与既有非目标的关系（明确记录这次是有意推翻）

两处既有约束被本修订**有意推翻**，必须同时更新：

1. `docs/superpowers/specs/2026-11-02-zombie-obstacle-avoidance-design.md:40` 写「不做寻路网格 /
   A\* / BFS（M6 规格 §1 的非目标」—— 那是 **v2.40 贴身避障**那一轮的边界，当时的用户裁定是
   「贴身绕行即可」。本次用户明确要求「会绕路、会寻路」，故该条**作废**。
2. `docs/superpowers/specs/2026-08-23-m6-zombies-design.md:67` 写「没有……主线程 BFS」——
   该句的意图是**禁止每只丧尸每帧做全图寻路**（那会撞破帧预算）。本设计的 BFS 是
   **有界 24 格 + 每 0.5 秒一次 + 同构纯函数**，与那一条的意图不冲突，但**字面冲突**，
   故在该处加一条指向本节的注记。

⚠️ **不引入 Worker**：24 格 BFS < 0.3ms，且世界数据权威在主线程（红线 1）。

## 4. 关键实现约束

### 4.1 离线路径必须逐位零回归

开关关闭时：
- `ZombieService.update()` 走**完全原有**的 `pool.call('ai', …)` 分支；
- 不构造 `JevPlanner`、不发任何请求、不创建记忆表；
- `_applyIntent` 的签名与行为不变。

判据 = 既有 `src/tests/test-zombies.js` 全绿 + 一条新的「开关关闭时不产生任何 fetch」用例。

### 4.2 主线程成本

- 每 0.5s 每只丧尸一次 `buildJevState`：9×9×2（两档 y）次 `zombieCollidesAt` ≈ 162 次
  `world.isSolid`，20 只 = 3240 次/0.5s ≈ **6.5k/s**（对比 `getSectionView` 曾因 5508 次查找
  造成 14.7ms/帧 —— 这里每次是 O(1) typed-array 读，量级可忽略，但**必须实测**，见 §6.4）。
- ⚠️ **不得在帧循环里同步等待**；`tick()` 只负责发起与消费，不 `await`。

### 4.3 与既有编排的关系

`ZombieService.update()` 里的 `_aiAccum` / `_aiInFlight` 是**离线路径**的节流，保持不变。
在线 AI 有自己的 `JevPlanner` 节流。两者**互斥**：开关开着时离线 RPC 仍会跑（作为兜底方向源），
但**在线回包优先**（后写胜）。⚠️ 这样写会让「等待期间沿上次方向走」自然成立。

### 4.4 安全

- 不把 API key 放前端（转接层已注入，调用方不带 key）。
- state 里**只有方块类型与相对方位**，不含玩家坐标绝对值以外的信息（玩家坐标不进 state，
  只有「方位 + 距离」与窗口内的 `P` 标记）。
- 不打 `console.log` 整个 payload（体积大且噪声）；只在失败时打 reason + id。

## 5. 测试计划

### 5.1 Tier 1（TDD，浏览器内单测 `src/tests/test-zombie-jev-ai.js`）

1. `sampleGroundWindow`：中心是 `Z`、玩家格是 `P`、墙 `#`、未加载 column `#`；9×9 尺寸；方位标记正确。
2. `buildJevState`：只列**可走**方向；`times_already_visited` 来自记忆；`trail` 长度上限。
3. `parseAnswer`：合法方向 → 向量；**非法方向 / 未知方向 / 缺字段 → 失败**（不得静默取一个默认方向）。
4. `deadEnd` 判定：除来路外无出口 → 标记。
5. 熔断：连续 3 次失败 → 进入冷却；成功一次 → 计数清零。
6. **开关关闭时零 fetch**（注入 spy）。
7. 记忆表随 slot 回收删除（无泄漏）。

### 5.2 Tier 4（真实 Jev E2E，`tests/zombie-jev-ai.spec.mjs`）

一条**真实打 js-perf.cn** 的用例（会消耗额度，用户已同意）：

- 造一个静态 U 形墙（用 `world.setBlock` 摆方块），把玩家放在墙内侧、丧尸放在墙外；
- `?zombieai=0`：断言丧尸在 N 秒内**没有**到达玩家附近（打转/贴墙）；
- `?zombieai=1`：断言丧尸在 N 秒内到达玩家附近（`dist < 4`）。
- ⚠️ 判据要带**内侧对照**（若在线 AI 根本没接线，「到不了」和「到了」都会恒定，两侧都测才有效）。
- ⚠️ 用例必须**容忍网关拦截**：若首次请求即 `not-json`，重试最多 3 次；仍失败则 `test.skip`，
  **不得让它变成随机的红**（记录 skip 原因）。
- 需在 spec 顶部 `test.setTimeout(120_000)`（400ms/步 × 多步）。

### 5.3 回归

`npm run check`（arch/data/lint）+ `src/tests/index.html` 全量（尤其 `test-zombies.js` 的
避障 a~l 与「丧尸物理: 一格 step-up」）+ `tests/zombies.spec.mjs`。

## 6. 落地前必须实测的三件事

1. **面板高度**：读出两列 `getBoundingClientRect().height`，确认新行不产生纵向滚动条
   （`.mc-content` 的 `scrollHeight <= clientHeight`）。
2. **主线程成本**：`buildJevState` 单次耗时（目标 < 0.3ms/只），20 只时的帧时无回退
   （`perf.snapshot().frameMs` 口径，**不是** rAF 包 `performance.now()`）。
3. **真实游戏内可绕通**：默认 seed、`?zombieai=1`、用 `spawnZombieNearPlayer` 在墙外造丧尸，
   观察它是否绕过墙（不能只靠单测）。

## 7. 已知取舍

- **单步 400ms** 意味着反应延迟约 1 步（1.2 格）。丧尸在等待期间沿旧方向走 —— 观感是
  「会思考地绕路」而非「瞬发」。
- **长迷宫（BFS 25 步以上）** 需要 90+ 步、约 45 秒才能通过（实测）。这是「只看 9×9 局部 +
  记忆」的固有限制，不追求最优路径。
- **折返 67 步** 这类超长地形仍会 `maxsteps` 失败 —— 属已知上限，不在本期目标内。
- 20 只丧尸全开时，每只约 2.5s 才能决策一次（并发 4 × 400ms）。这是**吞吐换质量**的取舍，
  可用 `JEV_AI.maxConcurrent` 调。
- 额度和延迟都是不可控的外部依赖；熔断保证它永远不会把游戏卡住。
