# 丧尸行动拟真度 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让丧尸撞墙走不动时「愣一下 → 后退 → 重新寻路」、真没路时原地徘徊等玩家，并给速度加波动、给转身加限速，不再一股脑贴墙平移。

**Architecture:** 在既有三层（A\* 寻路 → `decideStep` 8 向决策 → `steerIntent` 局部避让）之间插入**丧尸专属的第四层** `zombie-behavior.js`：用「一段时间内有没有真的走动」判定卡住（时间维度，不用几何维度），驱动状态机与速度包络。共用层与物理、渲染、存档一律不动 ⇒ 焰魔/守卫零回归。转身限速接在 `_applyIntent`（AI 决策路径），不接通用写入口 `setIntent`。

**Tech Stack:** 原生 ES module（无构建）、Node v26 跑同构层单测、Playwright（chromium channel，WebGPU）跑真游戏页、eslint。

**Spec:** `docs/superpowers/specs/2026-11-16-zombie-behavior-realism-design.md`

## Global Constraints

- 同构层（`src/entities/**`）：**无 DOM、无 three、不自建 Worker**（`npm run check:arch` 静态门）。
- **红线 1**：`state.velocity` 唯一写者链 `_stepNavigator → _applyIntent → setIntent`；行为状态存进**既有** `_navMemory`（`memoryFor`），不新建第二个 Map（回收已在 `_releaseSlot` 覆盖三条路径）。
- **红线 7**：`generation` 校验仍在 `_applyIntent`，行为层不碰。
- **`ZOMBIE` 冻结表一字不改**：`speed 1.2` / `maxActive 20` / `health 100` / `width 0.6` / `height 1.8` / `aiPeriod 0.05` / `perceptionRange 80` / `aiSleepDistance 60`。
- **共用层签名与行为逐位不变**：`decideStep` / `memoryFor` / `steerIntent` / `steerIntentAabb` / `zombieCollidesAt` / `zombieStepUpY` / `planStep` / `PathCache`（焰魔 + 守卫共用）。
- **速度硬上限 1.2**：任何一帧 `hypot(vx,vz) ≤ ZOMBIE.speed`（含排斥力合成后，由既有钳制保证）。
- **巡航倍率下界 0.92**：实测低于 0.90 会让既有 12s 绕墙 E2E 变红（spec §3.3）。
- 随机性走**可注入 `rng`**（默认 `Math.random`），与 `BossAgent` 同一既有手法；单测注入定值。
- 时间基准一律 `performance.now()` 口径的 `nowMs`，**禁 `Date.now()`**。
- 代码注释用中文；新增常量全部进 `zombie-config.js` 并附实测依据。
- **不改** mesher/materials/render-world/scheduler/physics ⇒ **不跑 `bench --check`**。
- **调试端口**：本 worktree 已把 `server-script/start-server.js` 与 `playwright.config.mjs` 的 8081 改成 **8231**（避免 `reuseExistingServer` 静默连主仓服务）。**这两处是调试配置，提交前必须还原，不得混进功能提交。**

## Review Focus

按 spec  implied 但最容易咬到真实玩家的五条（每条都已在对应 Task 里落了测试）：

1. **丧尸成功追到玩家身边后反而开始后退** —— 抵达后本来就零位移，卡住判据若无到达门会把「追到了」误判成「卡住了」。实测正常抵达距离恒 0.48~0.67。→ Task 2 用例 d3 + Task 3 前置门。
2. **丧尸不敢进 1 格宽门洞 / 2 格高走廊** —— 侧向净空判据会误杀（实测门洞净空 0.10 < 贴墙 0.60）。→ Task 2 用例 m（两个走廊夹具全程零触发）。
3. **正常绕墙时频繁犹豫，导致 12s 内追不上玩家** —— 既有 E2E 的实测余量只到 0.80 倍率。→ Task 4 巡航下界 + Task 7 既有 E2E 复跑。
4. **玩家拆墙后丧尸永久徘徊不动** —— `PathCache` 缓存可达路径 4s，不清缓存会走回墙边。→ Task 3 用例 j/l。
5. **20 只同点生成不再散开** —— 速度包络若乘到「导航+排斥力」合成向量上会把排斥力一起缩小。→ Task 4 用例 + Task 7 互斥 E2E 复跑。

---

### Task 1: 行为常量表（`ZOMBIE_BEHAVIOR`）

**Files:**
- Modify: `src/entities/zombies/zombie-config.js`（在 `ZOMBIE_STEERING` 之后、`PATHFIND` 之前追加）
- Test: `src/tests/test-zombie-behavior.js`（新建）
- Modify: `src/tests/index.html`（注册新单测，紧跟 `import './test-zombie-pathfinder.js';` 之后）

**Interfaces:**
- Consumes: 既有 `ZOMBIE`（取 `speed` / `aiPeriod` 做派生断言）
- Produces: `ZOMBIE_BEHAVIOR` 冻结对象，字段与值如下（后续所有 Task 都从这里读，**不得写字面量**）：

```js
export const ZOMBIE_BEHAVIOR = Object.freeze({
  arriveDistance: 1.5,        // 到达门：距玩家 ≤ 此值不进任何新状态
  stuckWindowSeconds: 1.5,    // 信号A 滚动窗口
  stuckDistance: 0.35,        // 信号A 净位移阈值
  nearPlayerDistance: 6.0,    // 信号B 距离门
  awayAngleDeg: 120,          // 信号B 背离角阈值
  awayHoldSeconds: 0.8,       // 信号B 持续时长
  hesitateSecondsMin: 0.6,
  hesitateSecondsMax: 1.2,
  backoffDistanceMin: 1.0,
  backoffDistanceMax: 2.0,
  backoffSpeedScale: 0.55,
  paceStepsMin: 1,
  paceStepsMax: 2,
  paceStepDistance: 0.6,
  wanderAfterAttempts: 3,
  wanderRadius: 2.0,
  wanderRetrySeconds: 2.0,
  wanderSpeedScale: 0.45,
  cruiseScaleMin: 0.92,       // ⚠️ 实测下界，见 spec §3.3
  cruiseScaleMax: 1.0,
  cruisePeriodSecondsMin: 3.0,
  cruisePeriodSecondsMax: 5.0,
  accelSeconds: 0.35,
  turnSlowFloor: 0.7,
  turnRateDegPerSec: 540,
});
```

- [ ] **Step 1: 写失败测试**

新建 `src/tests/test-zombie-behavior.js`，头部 import：

```js
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse, assertDeepEqual } from './assert.js';
import { ZOMBIE, ZOMBIE_BEHAVIOR } from '../entities/zombies/zombie-config.js';
```

断言（每条都用**字面量**而非从被测常量派生，testing-policy §2.7 第 7 类）：

```js
test('ZOMBIE_BEHAVIOR: 阈值取实测标定值', () => {
  assertEqual(ZOMBIE_BEHAVIOR.arriveDistance, 1.5);
  assertEqual(ZOMBIE_BEHAVIOR.stuckWindowSeconds, 1.5);
  assertEqual(ZOMBIE_BEHAVIOR.stuckDistance, 0.35);
  assertEqual(ZOMBIE_BEHAVIOR.awayAngleDeg, 120);
  assertEqual(ZOMBIE_BEHAVIOR.cruiseScaleMin, 0.92);
  assertEqual(ZOMBIE_BEHAVIOR.turnRateDegPerSec, 540);
});

test('ZOMBIE_BEHAVIOR: 三条载荷性不变式', () => {
  // ① 到达门必须大于正常抵达距离 0.67（实测），否则追到就退开
  assertTrue(ZOMBIE_BEHAVIOR.arriveDistance > 0.67, '到达门须大于实测抵达距离 0.67');
  // ② 到达门必须小于信号B距离门（两信号职责不重叠）
  assertTrue(ZOMBIE_BEHAVIOR.arriveDistance < ZOMBIE_BEHAVIOR.nearPlayerDistance);
  // ③ 巡航下界不得低于 0.90（既有 12s 绕墙 E2E 的实测余量）
  assertTrue(ZOMBIE_BEHAVIOR.cruiseScaleMin >= 0.90, '巡航下界须保住既有 E2E 余量');
  assertTrue(ZOMBIE_BEHAVIOR.cruiseScaleMax <= 1.0, '巡航不得超过 ZOMBIE.speed');
  // ④ 卡住阈值须小于正常绕墙的窗口净位移最小值 0.85（实测）
  assertTrue(ZOMBIE_BEHAVIOR.stuckDistance < 0.85);
  // ⑤ 区间上下界顺序
  assertTrue(ZOMBIE_BEHAVIOR.hesitateSecondsMin < ZOMBIE_BEHAVIOR.hesitateSecondsMax);
  assertTrue(ZOMBIE_BEHAVIOR.backoffDistanceMin < ZOMBIE_BEHAVIOR.backoffDistanceMax);
});
```

同时在 `src/tests/index.html` 加 `import './test-zombie-behavior.js';`（漏注册 = 静默不跑）。

- [ ] **Step 2: 跑测试确认 RED**

Run: `node -e "import('./src/tests/test-zombie-behavior.js').then(async()=>{const{runAllTests}=await import('./src/tests/runner.js');const r=await runAllTests();console.log(r.passed,r.failed);for(const s of r.suites)for(const t of s.tests)if(t.status==='failed')console.log('FAIL',t.name,t.error);})"`
Expected: FAIL —— `ZOMBIE_BEHAVIOR` 为 undefined（读属性抛 TypeError）

- [ ] **Step 3: 实现常量表**

在 `zombie-config.js` 追加上面的 `ZOMBIE_BEHAVIOR`。**每个字段一行中文注释写明实测依据**，其中三条必须写全（它们是后人最容易「顺手调」的）：
- `arriveDistance`：实测正常抵达后距离恒 0.48~0.67，卡死场景 11.59；无此门则「追到就退开」（191 帧误触发）。
- `cruiseScaleMin`：实测倍率 0.80 时既有 E2E 跨墙 11.5s（贴线）、0.70 直接 FAIL。
- `stuckDistance`：实测正常绕墙窗口 min 1.04、卡死 0.02；窗口取 1.0s 时正常值低到 0.501（余量不足）。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: 同 Step 2 命令
Expected: `2 0`（2 passed / 0 failed）

- [ ] **Step 5: 门禁 + 提交**

```bash
npm run check
git add src/entities/zombies/zombie-config.js src/tests/test-zombie-behavior.js src/tests/index.html
git commit -m "feat(zombie): 行为层冻结常量表（实测标定阈值）"
```

---

### Task 2: 卡住检测（纯函数，三信号 + 到达门）

**Files:**
- Create: `src/entities/zombies/zombie-behavior.js`
- Test: `src/tests/test-zombie-behavior.js`（追加）

**Interfaces:**
- Consumes: `ZOMBIE_BEHAVIOR`（Task 1）
- Produces:

```js
/** 取（或建）某只丧尸的行为记忆。挂在既有 memoryFor 返回的对象上，字段名 behavior。 */
export function behaviorFor(memory, nowMs)  // → behavior 对象（形状见下）

/** 记录一拍位置采样（滚动窗口）。原地改 behavior.hist。 */
export function recordSample(behavior, position, nowMs)

/**
 * 判定这一拍是否「走不动」。纯函数（只读 behavior + 入参）。
 * @param {{behavior:object, position:number[], playerPosition:number[],
 *          plannedDirection:string|null, blocked:boolean, nowMs:number}} p
 * @returns {{stuck:boolean, reason:'none'|'no-progress'|'no-way'|'blocked'}}
 */
export function detectStuck(p)
```

`behavior` 对象形状（Task 3 会扩状态机字段，本 Task 只用这几个）：

```js
{
  hist: [],            // [[nowMs, x, z], ...] 滚动窗口
  awaySince: null,     // 信号B 的持续计时起点（ms）
  phase: 'chase',      // Task 3 起消费
}
```

- [ ] **Step 1: 写失败测试**

追加到 `test-zombie-behavior.js`。夹具用**真实世界**（与 `test-zombie-pathfinder.js` 的 `makeFlat` 同手法：`createRegistry` + `ChunkColumn` + `WorldData`，`top=0` 平地），因为 `plannedDirection` 要由真 `decideStep` 给出。

八条用例（编号沿用 spec §6.1）：

```js
// d1 卡死侧：远 + 走不动 ⇒ 触发
test('detectStuck d1: 距玩家11.6格 + 1.5s净位移0.02 ⇒ no-progress', () => {
  // 构造 behavior.hist：两端相距 0.02 格、时间跨度 1.5s
  // position=[32.5,1,32]，playerPosition=[32.5,1,20.5]
  // 断言 stuck===true && reason==='no-progress'
});

// d2 正常侧：净位移足够 ⇒ 不触发
test('detectStuck d2: 1.5s净位移1.04格 ⇒ 不触发', () => { /* hist 两端相距 1.04 */ });

// d3 ★到达门（本轮实测新增，最易漏）
test('detectStuck d3: 净位移0 但距玩家0.48格（已抵达）⇒ 不触发', () => {
  // position=[32.5,1,20.98]，playerPosition=[32.5,1,20.5]，hist 两端同点
  // 断言 stuck===false（没有这道门，每只追上玩家的丧尸都会开始后退）
});

// e1/e2/e3 信号B 三侧
test('detectStuck e1: 距5格 + 背离160° + 持续0.8s ⇒ no-way', () => {});
test('detectStuck e2: 距5格 + 背离74° + 持续0.8s ⇒ 不触发', () => {});
test('detectStuck e3: 距20格 + 背离160° + 持续0.8s ⇒ 不触发（距离门）', () => {});
test('detectStuck e4: 距5格 + 背离160° 但只持续0.3s ⇒ 不触发（时长门）', () => {});

// 信号C
test('detectStuck c: decideStep 报 blocked ⇒ reason=blocked', () => {});

// m ★反目标：两个走廊夹具全程零触发（端到端跑真 service）
test('detectStuck m: 1格宽门洞与2格高走廊全程不触发卡住', () => {
  // 夹具1（实测已验证）：x=31 与 x=33 两道 3 格高墙夹出 x=32 一列通道，z∈[20,45]
  //   spawn [32.5,1,40.5]，player [32.5,1,22.5]，跑 16s
  // 夹具2：x=31 与 x=34 两道墙 + y=3 顶盖（净空 2 格），同 spawn/player，跑 16s
  // 逐拍调 recordSample + detectStuck，断言：全程 stuck===false
  // 且断言最终 z < 30（真的走过去了，不是因为站着不动才没触发）
});
```

⚠️ **m 必须同时断言「走过去了」**：只断言「没触发」时，「丧尸压根没动」也会全绿（判别力缺失）。

- [ ] **Step 2: 跑测试确认 RED**

Run: `node -e "…同 Task 1 Step 2…"`
Expected: FAIL —— `detectStuck is not a function` / `behaviorFor is not a function`

- [ ] **Step 3: 实现**

新建 `zombie-behavior.js`，文件头写明分层位置与「为什么用时间维度不用几何维度」（引 spec §1.3 的实测表：贴墙与墙角侧向净空**都是 0.60**，门洞 0.10 ⇒ 几何判据会让丧尸不敢进门）。

实现要点（签名与测试已定，body 由实现者写，但这四条是算法决策）：
- `recordSample`：push `[nowMs, x, z]`，然后 shift 掉 `nowMs - stuckWindowSeconds*1000` 之前的项。
- `detectStuck` **第一件事是到达门**：`dist <= arriveDistance` ⇒ 直接 `{stuck:false, reason:'none'}`（在三个信号之前，统一落点）。
- 信号 A：`hist.length >= 2` 且窗口已铺满（`nowMs - hist[0][0] >= stuckWindowSeconds*1000 - 1e-6`）才算，避免开局误判。
- 信号 B：`plannedDirection` 经 `DIRECTION_VECTORS` 转单位向量，与「朝玩家单位向量」求夹角；超阈值则记 `awaySince`（首次置 `nowMs`），低于阈值**清零**；`nowMs - awaySince >= awayHoldSeconds*1000` 才触发。
- 信号 C：`blocked === true` ⇒ `reason:'blocked'`（优先级最高，围死语义不变）。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: 同上
Expected: 全部 passed，failed 0

- [ ] **Step 5: 提交**

```bash
git add src/entities/zombies/zombie-behavior.js src/tests/test-zombie-behavior.js
git commit -m "feat(zombie): 卡住检测三信号 + 到达门（时间维度判据）"
```

---

### Task 3: 状态机（chase / hesitate / backoff / replan / wander）

**Files:**
- Modify: `src/entities/zombies/zombie-behavior.js`
- Modify: `src/entities/zombies/zombie-system.js`（`normalizeMode` 扩白名单；`_stepNavigator` 接线）
- Test: `src/tests/test-zombie-behavior.js`（追加）
- Test: `src/tests/test-zombies.js`（追加 mode 白名单用例）

**Interfaces:**
- Consumes: `behaviorFor` / `recordSample` / `detectStuck`（Task 2）、`ZOMBIE_BEHAVIOR`（Task 1）
- Produces:

```js
/**
 * 行为层主入口：决定这一拍怎么走。
 * @param {{behavior:object, position:number[], playerPosition:number[],
 *          step:{vx:number,vz:number,mode:string,plannedDirection:string|null,blocked:boolean},
 *          nowMs:number, rng:()=>number}} p
 * @returns {{vx:number, vz:number, mode:string, phase:string, replan:boolean}}
 *   vx/vz 是**单位向量 × 速度倍率**（调用方再乘 ZOMBIE.speed）；
 *   replan=true 时调用方须清 PathCache 该 id 条目。
 */
export function decideBehavior(p)
```

`behavior` 扩展字段：`phase` / `phaseUntil`（ms）/ `backoffStart`（[x,z]）/ `backoffDir`（[x,z]）/ `failCount` / `paceLeft` / `paceDir` / `wanderAnchor`（[x,z]）/ `wanderNextRetry`（ms）/ `lastDir`（[x,z]，转向减速用）/ `movingSince`（ms，起步加速用）。

新增 mode 白名单：`'hesitating'` / `'backing'` / `'wandering'`（`'blocked'` 保留）。

- [ ] **Step 1: 写失败测试**

追加用例（注入定值 rng，如 `() => 0` 与 `() => 1` 取区间两端）：

```js
test('decideBehavior f: 状态序 chase→hesitate→backoff→replan（rng两端）', () => {
  // 喂 detectStuck 会判 stuck 的入参，逐拍推进 nowMs
  // 断言 phase 依次出现 hesitate / backoff，且 hesitate 时长 ∈ [0.6,1.2]
  // rng=()=>0 取下界、()=>1 取上界，两端各测
});
test('decideBehavior g: hesitate 期间 vx=vz=0', () => {});
test('decideBehavior h: backoff 方向背离玩家，累计退 1~2 格', () => {});
test('decideBehavior i: backoff 背后撞墙 ⇒ 立即结束（不硬顶）', () => {
  // 夹具（实测已验证）：丧尸 [32.5,1,32.5]，z=31 与 z=34 各一道 3 格高墙（x∈[28,36]）
  // 玩家 [32.5,1,20.5] ⇒ 后退方向正南；退 1.0 格可走、退 1.5 格撞墙
  // 断言：backoff 在退够 backoffDistanceMax 之前就结束
});
test('decideBehavior j: replan 拍返回 replan=true', () => {});
test('decideBehavior k: 连续失败3次 ⇒ wander；wander 有非零位移', () => {});
test('decideBehavior l: wander 中玩家可近 ⇒ 回 chase', () => {});
test('decideBehavior n: blocked（四面围死）⇒ mode=blocked，不进犹豫', () => {});
test('decideBehavior r: 同 rng 同输入 ⇒ 逐位同输出', () => {});
test('decideBehavior 前置门: 距玩家0.48格 ⇒ 恒 chase，不进任何新状态', () => {});
```

`test-zombies.js` 追加：

```js
test('行为层 mode 白名单: hesitating/backing/wandering 不被规范化成 idle', () => {
  // 三个 mode 各测两条路径：setIntent 与 damage(走 createState)
});
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `node -e "…"`（两个测试文件都要跑）
Expected: FAIL —— `decideBehavior is not a function`；mode 用例报 `Expected hesitating, got idle`

- [ ] **Step 3: 实现状态机**

在 `zombie-behavior.js` 实现 `decideBehavior`。**七条载荷性细节**（spec §4.3，每条都是已知陷阱的防线）：
1. 入口前置门：`dist <= arriveDistance` ⇒ 原样返回 `step` 的方向（`mode:'chasing'`），不动状态机。
2. `step.blocked` ⇒ 直接 `mode:'blocked'`、零速度，**不进犹豫**（既有 E2E 语义）。
3. `hesitate`：零速度，`phaseUntil = nowMs + (min + rng()*(max-min))*1000`。
4. `backoff`：方向 = 背离玩家单位向量；累计位移达目标 **或** 本拍位置相对上拍没动（撞墙）⇒ 结束。
5. `replan`：返回 `replan:true`，`paceLeft = paceStepsMin + floor(rng()*(max-min+1))`，侧向踱步。
6. 失败计数**只在「重算后仍无路」时 +1**；`chase` 且本拍有位移则归零。
7. `wander`：锚点 = 进入时的位置；踱步目标在半径 `wanderRadius` 内；`wanderNextRetry` 每 `wanderRetrySeconds` 到期一次，到期拍返回 `replan:true`。

`zombie-system.js` 两处改动：
- `normalizeMode`：白名单加三个新值（**单一实现**，`createState` 与 `setIntent` 共用它）。
- `_stepNavigator`：在 `decideStep` 之后、`_applyIntent` 之前插入行为层；`replan` 为真时 `this._pathCache.forget(entity.id)`；`vx/vz` 改成 `behavior.vx * ZOMBIE.speed + sep.x`（**排斥力不缩放**，见 Task 4）。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: 同上
Expected: 全部 passed

- [ ] **Step 5: 跑既有回归（共用层零回归 + 围死语义）**

Run: `node -e "import('./src/tests/test-zombie-pathfinder.js').then(async()=>{const{runAllTests}=await import('./src/tests/runner.js');const r=await runAllTests();console.log(r.passed,r.failed);})"`
Expected: `28 0`（一字未改的既有 28 条）

- [ ] **Step 6: 提交**

```bash
git add src/entities/zombies/zombie-behavior.js src/entities/zombies/zombie-system.js src/tests/test-zombie-behavior.js src/tests/test-zombies.js
git commit -m "feat(zombie): 犹豫/后退/重新寻路/徘徊状态机"
```

---

### Task 4: 速度包络（巡航漂移 / 起步加速 / 转向减速）

**Files:**
- Modify: `src/entities/zombies/zombie-behavior.js`
- Test: `src/tests/test-zombie-behavior.js`（追加）

**Interfaces:**
- Consumes: `decideBehavior`（Task 3）
- Produces:

```js
/**
 * 速度倍率（0~1）。三项相乘后钳到 [0,1]。
 * @param {{behavior:object, id:string, nowMs:number, dir:[number,number], moving:boolean}} p
 * @returns {number}
 */
export function speedScale(p)
```

`decideBehavior` 内部消费它，把返回的 `vx/vz` 乘上倍率（**只乘导航分量**）。

- [ ] **Step 1: 写失败测试**

```js
test('speedScale b: 巡航倍率 ∈ [0.92,1.0]，恒 ≤ 1', () => {
  // 扫 nowMs 0..10s 步进 0.05，断言每个值都在区间内
});
test('speedScale c: 静止起步前 0.35s 递增', () => {
  // movingSince=nowMs ⇒ scale 小；nowMs+0.35s ⇒ 达巡航
});
test('speedScale o1: 转向那一拍减速，但不累积', () => {
  // 连续 20 拍同向转 45°，断言第 20 拍的 scale 与第 1 拍相同（不累乘）
});
test('speedScale o2: 三项相乘后仍 ≤ 1', () => {});
test('speedScale 相位: 不同 id 不同步（避免全场齐步走）', () => {
  // 同 nowMs 下 z0 与 z7 的巡航倍率不同
});
test('行为层不缩放排斥力: 20只同点仍散开', () => {
  // 真 service：20 只同点 spawn，跑 3s，断言最小间距 > 0.4
  // （与既有 E2E 同判据，但在单测层先钉住）
});
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `node -e "…"`
Expected: FAIL —— `speedScale is not a function`

- [ ] **Step 3: 实现**

- 巡航：`min + (max-min) * (0.5 + 0.5*sin(2π*(nowMs/1000)/period + phase))`，`period` 与 `phase` 都由 **id 散列**派生（复用 `separationForce` 的 charCode 求和手法，确定且不同步）。
- 起步：`movingSince` 为 null 时置 `nowMs`；`min(1, (nowMs-movingSince)/(accelSeconds*1000))`；`moving=false` 时清 `movingSince`。
- 转向：本拍 `dir` 与 `behavior.lastDir` 夹角 θ ⇒ `max(turnSlowFloor, 1 - θ/π*0.5)`；**每拍独立算，不写回累积**。
- 三项相乘 → `Math.min(1, Math.max(0, …))`。
- `backoff` / `wander` / `hesitate` 用各自的固定倍率（**不叠巡航漂移**，那三个状态的速度语义是独立的）。

⚠️ `_stepNavigator` 里必须是 `behavior.vx * ZOMBIE.speed + sep.x` —— 排斥力**在包络之外**全额叠加（spec §4.5）。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: 同上
Expected: 全部 passed

- [ ] **Step 5: 提交**

```bash
git add src/entities/zombies/zombie-behavior.js src/tests/test-zombie-behavior.js
git commit -m "feat(zombie): 速度包络（巡航漂移/起步加速/转向减速）"
```

---

### Task 5: 转身限速

**Files:**
- Modify: `src/entities/zombies/zombie-system.js`（`_applyIntent` 内，`setIntent` 之后）
- Test: `src/tests/test-zombie-behavior.js`（追加）
- Modify: `src/tests/test-zombies.js:920`（**改写既有「朝向从速度派生」用例**）

**Interfaces:**
- Consumes: `ZOMBIE_BEHAVIOR.turnRateDegPerSec`、`ZOMBIE.aiPeriod`
- Produces:

```js
/**
 * 朝目标 yaw 限速逼近（最短弧）。纯函数。
 * @param {number} current 当前 yaw @param {number} target 目标 yaw
 * @param {number} maxStep 本拍最大转角（rad）
 * @returns {number} 新 yaw（wrap 到 ±π）
 */
export function steerYawLimited(current, target, maxStep)
```

- [ ] **Step 1: 写失败测试 + 改写既有用例**

新增：

```js
test('steerYawLimited p1: 单拍不超过限速上限', () => {
  const maxStep = 540 * Math.PI / 180 * 0.05;   // 字面量，不从常量派生
  const out = steerYawLimited(0, Math.PI / 2, maxStep);
  assertTrue(Math.abs(out) <= maxStep + 1e-12);
  assertEqual(out, maxStep);                     // 0→90° 该拍恰好用满
});
test('steerYawLimited p2: 走最短弧（+179°→−179° 只转 2°）', () => {
  const cur = 179 * Math.PI / 180, tgt = -179 * Math.PI / 180;
  const out = steerYawLimited(cur, tgt, Math.PI);  // 不限速时应走 2° 而非 358°
  // 断言 |out − tgt| < 1e-9（一步到位，因为 2° < maxStep）
});
test('steerYawLimited: 已达目标则原样返回', () => {});
```

**改写** `test-zombies.js` 的「v2.47 ZombieService: 朝向从速度派生（移动跟随、静止保持）」：
- 原断言 `assertClose(st.yaw, atan2(vx,vz), 1e-9)` 在**一拍后**执行 ⇒ 限速下必红（实测 yaw=0.471239 vs 要求 1.570796）。
- 改成：推进 **5 拍**（`for (let i=0;i<5;i++) zombies.update(ZOMBIE.aiPeriod, {playerPosition:[30.5,1,0.5]})`）后断言 `yaw ≈ atan2`（0→90° 需 4 拍，5 拍有余量）。
- **新增**一条「单拍不得超过 27°+ε」——旧用例对限速零判别力，这条补上。
- 「静止保持原朝向」那半段**一字不动**。

⚠️ 这是**按新裁定重标**（不变式仍是「朝向源自速度」），不是放宽；观察窗口从 1 拍改为收敛后，并补上限断言。

- [ ] **Step 2: 跑测试确认 RED**

Run: `node -e "…"`（两个文件）
Expected: FAIL —— `steerYawLimited is not a function`；改写后的既有用例仍红（生产代码还没限速，5 拍后 yaw 正确但「单拍上限」那条会红）

- [ ] **Step 3: 实现**

`steerYawLimited` 放 `zombie-behavior.js`（导出供单测）。`_applyIntent` 末尾：`setIntent` 之后，若本拍水平速度非零，读 `entity.state.yaw`（已被 `setIntent` 设成瞬时目标）与**限速前的旧 yaw**，用 `steerYawLimited(旧yaw, 目标yaw, turnRateDegPerSec*π/180*ZOMBIE.aiPeriod)` 经 `createState` 写回。

⚠️ **必须用 `ZOMBIE.aiPeriod` 不是帧 dt**（`_applyIntent` 由 20Hz 导航驱动）。
⚠️ **`setIntent` 直接调用仍瞬时**（通用写入口契约不动）。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: 同上
Expected: 全部 passed（含改写后的既有用例）

- [ ] **Step 5: 提交**

```bash
git add src/entities/zombies/zombie-behavior.js src/entities/zombies/zombie-system.js src/tests/test-zombie-behavior.js src/tests/test-zombies.js
git commit -m "feat(zombie): 转身限速 540°/s（最短弧，接 AI 决策路径）"
```

---

### Task 6: 记忆回收与诊断

**Files:**
- Modify: `src/entities/zombies/zombie-system.js`（`debugNavigator` 增行为诊断）
- Test: `src/tests/test-zombie-behavior.js`（追加）

**Interfaces:**
- Consumes: `behaviorFor`（Task 2）、既有 `_releaseSlot`
- Produces: `debugNavigator()` 返回对象增 `behaviorPhases: {chase:number, hesitate:number, backoff:number, wander:number}`（只读计数，供 Tier 4 断言）

- [ ] **Step 1: 写失败测试**

```js
test('行为记忆 q: despawn 后回收，id 复用不带旧状态', () => {
  // spawn → 推进到 hesitate → damage 致死 → 再 spawn（同 slot 同 id）
  // 断言新实例 phase==='chase'、hist 为空、failCount===0
});
test('行为诊断: debugNavigator 暴露各 phase 计数', () => {});
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `node -e "…"`
Expected: FAIL —— `behaviorPhases` undefined

- [ ] **Step 3: 实现**

`_releaseSlot` 已经 `this._navMemory.delete(id)` ⇒ behavior 挂在同一对象上**自动回收**，本 Task 只需验证 + 加诊断计数（不新建 Map，红线 1）。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: 同上
Expected: 全部 passed

- [ ] **Step 5: 提交**

```bash
git add src/entities/zombies/zombie-system.js src/tests/test-zombie-behavior.js
git commit -m "feat(zombie): 行为诊断计数与记忆回收验证"
```

---

### Task 7: Tier 4 真游戏页验收 + 全量回归 + 负向验证

**Files:**
- Modify: `tests/zombies.spec.mjs`（追加 5 条）
- Modify: `docs/roadmap.md`（v3.11 行）
- Modify: `AGENTS.md`（高频坑补记）
- Modify: spec §11 实施记录

**Interfaces:**
- Consumes: `debugNavigator().behaviorPhases`（Task 6）、既有 `window.__MC_GAME__` / `__ZT__` helper
- Produces: 无（验收与文档）

- [ ] **Step 1: 写 5 条 Tier 4 判据**

全部经 `window.__MC_GAME__` 驱动，夹具用 `editor.setBlock` 造墙、`legalSpawnNear` 找落点（既有 helper）：

1. **整图封死长墙**：断言 20s 内 `behaviorPhases.hesitate > 0` 且 `.backoff > 0`，且出现过背离玩家的位移。（现状实测：全程 chasing、零犹豫 ⇒ 判别力充足）
2. **贴脸隔墙**：断言出现过 hesitate 且随后有后退位移。
3. **徘徊可恢复**：wander 中拆墙 ⇒ ≤3s 恢复 chasing 并靠近玩家。
4. **速度非二值**：采样 20s 速度集合 `distinct > 5`（现状实测恰好 2）。
5. **转身有过程**：单帧 yaw 变化 max ≤ 30°（现状实测 135°）。

⚠️ 每条都要**先测现状读数确认判别力**（spec §6.3 已给现状值），不要凭想象写阈值。
⚠️ 造墙夹具**先造墙后 spawn**（spawn 校验脚/头格 air）。

- [ ] **Step 2: 确认服务指向本 worktree（关键，否则测的是主仓代码）**

```bash
npm start > /tmp/zai-server.log 2>&1 &
sleep 2
curl -s http://localhost:8231/src/tests/index.html | grep -c "test-zombie-behavior"
```
Expected: `1`（返回 0 = 连错服务，必须先修端口）

- [ ] **Step 3: 跑新 spec**

Run: `npx playwright test tests/zombies.spec.mjs`
Expected: 全部 passed（含既有 13 条 + 新增 5 条）

⚠️ **既有「绕 3 格高短墙」12s 是最高风险项**（spec §3.3：倍率 0.80 时跨墙 11.5s 贴线）。若它 flaky，**按 testing-policy 用交替对照测分布，停下报告，不擅自放宽断言**。

- [ ] **Step 4: 浏览器内全量单测**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: passed（全量单测无 fail）

- [ ] **Step 5: Boss 零回归**

Run: `npx playwright test tests/ignis.spec.mjs tests/guardian.spec.mjs`
Expected: passed（共用层未动 ⇒ 应零回归；`ignis.spec` 的「不卡死(v2.78)」是**既有 flaky**，若红按 roadmap v3.04 的定性处理，不改其断言）

- [ ] **Step 6: 九条负向验证（每条必须真 FAIL）**

用 `edit` 精确注入（**不用 perl/sed**，静默不匹配会造成假全绿）；还原用 **`cp` 副本**（**禁 `git checkout`**，工作树有未提交改动）。注入后**读回源码确认注入生效**。

| # | 注入 | 预期真红 |
|---|---|---|
| 1 | `stuckDistance` 0.35 → 1.5 | Task 2 用例 d2 / m |
| 2 | 去掉信号 B 的距离门 | Task 2 用例 e3 |
| 3 | `replan` 不清缓存 | Task 3 用例 j |
| 4 | `cruiseScaleMin` 0.92 → 0.70 | 既有 E2E 绕墙（spec §3.3 已预测） |
| 5 | 包络乘「导航+排斥力」合成向量 | 互斥 E2E |
| 6 | 限速接回 `setIntent` | 「直接 setIntent 仍瞬时」用例 |
| 7 | 限速不走最短弧 | Task 5 用例 p2 |
| 8 | 转向减速每帧累乘 | Task 4 用例 o1 |
| 9 | **去掉信号 A 的到达门** | Task 2 用例 d3 |

- [ ] **Step 7: 门禁**

```bash
npm run check
npx eslint src/entities/zombies/zombie-behavior.js src/entities/zombies/zombie-config.js src/entities/zombies/zombie-system.js src/tests/test-zombie-behavior.js
```
Expected: arch ✓ / data ✓ / lint 0 error；**改动文件单独 lint 必须 0 warning**（不得把新增 warning 称作「既有基线」——AGENTS.md 明载）

- [ ] **Step 8: 还原调试端口 + 文档**

把 `server-script/start-server.js` 的 `PORT` 与 `playwright.config.mjs` 的两处 8231 **改回 8081**，确认 `git diff` 里不含端口改动。

补 `docs/roadmap.md` v3.11 行（用户原话 + 实测数据 + 已知取舍）、`AGENTS.md` 三条高频坑（侧向净空无判别力 / 到达门 / 限速接 `_applyIntent`）、spec §11 实施记录。

- [ ] **Step 9: 提交**

```bash
git add tests/zombies.spec.mjs docs/roadmap.md AGENTS.md docs/superpowers/specs/2026-11-16-zombie-behavior-realism-design.md docs/superpowers/plans/2026-11-16-zombie-behavior-realism.md
git commit -m "test(zombie): 行为层 Tier 4 验收与文档同步"
```

---

## Self-Review

**1. Spec coverage**：§4.2 三信号 → Task 2；§4.3 状态机 → Task 3；§4.4 速度包络 → Task 4；§4.6 转身限速 → Task 5；§4.5 排斥力顺序 → Task 4；§6 测试 → 各 Task + Task 7；§5 改动清单九个文件全部有归属。spec §9 留给实施者的四项（环形缓冲实现 / wander 路径形状 / 相位派生 / 状态名拼写）已在 Task 2~4 的实现要点里给了决定或明确留白。

**2. Step scan**：每步一个动作 + 一个可检查结果。常量表给了完整字段值（那是 spec 钉死的数据，不是 body）；算法只给决策要点（窗口铺满判定、最短弧、不累乘），body 留给实现者。

**3. Type consistency**：`behaviorFor(memory, nowMs)` / `recordSample(behavior, position, nowMs)` / `detectStuck(p)→{stuck,reason}` / `decideBehavior(p)→{vx,vz,mode,phase,replan}` / `speedScale(p)→number` / `steerYawLimited(current,target,maxStep)→number` 在 Task 2~5 的 Interfaces 与测试里拼写一致。`behavior` 字段名在 Task 2 定义、Task 3 扩展，无重名冲突。

**4. Review Focus**：五条各有归属测试（到达门 d3 / 走廊 m / 巡航下界 + E2E / 清缓存 j+l / 排斥力 Task 4 + 互斥 E2E）。

**5. Proportion**：计划 ~330 行 vs spec ~400 行，代码块集中在「测试断言」与「常量表」，无函数体转录。

**落地前已实测验证的夹具**（避免「断言描述想象中的世界」）：1 格宽走廊 16s 走到 z=22.98；2 格高走廊同样通过；backoff 夹具退 1.0 可走 / 1.5 撞墙；整图封死 20s 窗口净位移 min=0.000；到达门 1.5/2.0/3.0 三档下五个正常场景触发帧均为 0。