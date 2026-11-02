# 丧尸局部避障（贴身绕行）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让丧尸在正前方 1.2 格内不可通行时按最小偏角转向绕行（一格台阶不算障碍），四面围死时原地站住；worker、RPC 形状、渲染层、物理碰撞语义全部不动。

**Architecture:** 新增同构模块 `src/entities/zombies/zombie-navigation.js` 承载三件事——丧尸 AABB 碰撞判据（`zombieCollidesAt`）、一格台阶落点（`zombieStepUpY`）、转向探针（`steerIntent`）。`zombie-system.js` 的既有 `collides()`/`tryStepUp()` 退化成转调（唯一实现），`ZombieService._applyIntent()`（AI 回包的唯一消费点）在钳速之后插一次 `steerIntent`，`mode` 白名单加 `'blocked'`。探针只读主线程世界数据，无随机、无记忆，成本 4800~86400 次 `isSolid`/秒。

**Tech Stack:** 纯 JavaScript（ES2022 ES Modules）+ JSDoc，零 three、零 DOM（`src/entities/**` 受 `npm run check:arch` 同构检查），浏览器内自研 runner（`src/tests/runner.js`）+ Playwright（Tier 4）。

**Spec:** `docs/superpowers/specs/2026-11-02-zombie-obstacle-avoidance-design.md`（本计划实现它；执行者两份都要读）

## Global Constraints

以下数值与口径来自规格，每个任务都隐含包含本节。

- **只换方向、不改长度**：`steerIntent` 输出的速度模长必须等于输入模长（零速输入原样返回）。速度上限的唯一权威仍是 `_applyIntent` 的钳制 + `ZOMBIE.speed`。
- **探针接在 `_applyIntent`，不得接在 `setIntent`**：`setIntent` 是通用意图写入口（物理用例、调试代码都用它直接下令），长在里面会把「想让它走就必须能走」的语义偷换。
- **`zombieCollidesAt` 是丧尸 AABB 碰撞的唯一实现**，必须原样带上 `PHYS_EPSILON = 0.001`（`y1 = floor(y + height − 0.001)`）；物理的 `collides()` 与探针共用它。
- **`zombieStepUpY(y) = Math.floor(y + 0.01) + 1`** 是台阶落点的唯一实现，物理的 `tryStepUp()` 与探针共用它。
- **常量全部落 `zombie-config.js`**：`ZOMBIE_MAX_STEP = 1.0`（从 `zombie-system.js` 上移）、`ZOMBIE_STEERING = { probeDistance: 1.2, anglesDeg: [22.5, 45, 67.5, 90] }`。`zombie-navigation.js` 与 `zombie-system.js` 不得再写字面量 1.0 / 1.2 / 22.5。
- **确定性**：`steerIntent` 同输入必同输出，禁止 `Math.random()`、禁止「记住上次绕哪边」（红线 2）。
- **不改**：worker `ai` 分支、RPC 形状（`{id, generation, vx, vz, mode}` 键集已被 `tests/zombies.spec.mjs:352` 钉死）、`zombie-renderer.js`、物理的碰撞/step-up/重力语义、`ZOMBIE` 的既冻结数值。
- **依赖方向**：`zombie-navigation.js` 位于 `src/entities/**`（同构层），**不得 import three / DOM**，世界只经参数传入（`world.isSolid`）。
- **Tier 1 改动 ⇒ 必须 TDD**：每个实现任务先写失败测试、跑出 RED、再实现、跑出 GREEN。
- **新增 `src/tests/test-*.js` 必须注册进 `src/tests/index.html`**（否则 `check:data` 的 `[测试注册]` 报错）；本计划不新建测试文件，只在既有 `src/tests/test-zombies.js` 追加段落。
- **门禁**：每个任务结束跑 `npm run check`（arch + data + lint）；涉及热路径的任务再跑 `npx playwright test tests/zombies.spec.mjs`。
- **提交**：沿用本仓上一版计划的口径——**每任务末尾的 commit 步骤先不执行**，只在任务完成时汇报；用户明确要求提交后再一次性提交。

## Review Focus

规格隐含、但单个用例最容易漏掉的五类失效模式，按最可能咬人的顺序（每类都已指派到具体任务的测试步骤）：

1. **平地也被打偏**（`steerIntent` 对无障碍输入做了归一化重建）—— 观感是「丧尸走路开始左右画龙」，而所有「能绕墙」的用例仍然绿。Task 1 的用例 `a` 用**逐位相等**钉死。
2. **一格台阶被当成障碍**（探针只看 `y` 层）—— 台阶方块在 `y` 层就是实心，探针会把「该抬脚」误判成「堵死」，丧尸在台阶前僵住、`mode` 变 `blocked`；而物理的 step-up 用例（`test-zombies.js:1092`）因为不走探针仍然全绿。Task 1 的用例 `e` 前半与 `test-zombies.js` 既有的 `丧尸物理: 一格 step-up` 同时钉住。
3. **走廊/低顶被误判堵死**（复制 AABB 采样时漏了 `PHYS_EPSILON`）—— 丧尸在 2 格高的走廊、门洞、隧道里僵住，方块层面完全看不出。Task 1 的用例 `h`（脚底 y=1.0 与 y=1.2 两个高度）钉住。
4. **`blocked` 被静默规范化成 `idle`**（`createState` / `setIntent` 的两处三元表达式）—— 速度与位置都对（都是零），只有 `mode` 错；任何只看「它没动」的用例都过。Task 2 的用例 `k` 钉住。
5. **围死后永远不恢复**（探针带了记忆或 `blocked` 后不再发探针）—— 拆掉墙之后丧尸永远站着不动，而「围死时不动」的用例仍然绿。Task 2 的用例 `l` 钉住。

---

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `src/entities/zombies/zombie-navigation.js` | `zombieCollidesAt` / `zombieStepUpY` / `steerIntent` 的**唯一实现**（同构纯函数，只读 world） | 新建 |
| `src/entities/zombies/zombie-config.js` | 新增 `ZOMBIE_MAX_STEP` / `ZOMBIE_STEERING` | 改 |
| `src/entities/zombies/zombie-system.js` | `collides()` / `tryStepUp()` 转调导航模块；`_applyIntent` 插探针；`mode` 白名单加 `blocked` | 改 |
| `src/tests/test-zombies.js` | 新增「局部避障」段落：纯函数用例 a~i + 接线用例 j~l | 改 |
| `tests/zombies.spec.mjs` | 新增 Tier 4：绕墙一条、围死一条 | 改 |
| `docs/roadmap.md` | 新增 v2.40 行 | 改 |
| `CLAUDE.md` | M6 段新增两条活跃约束 | 改 |

`src/tests/index.html` **不动**（测试文件已注册）。

---

### Task 1: 导航模块（碰撞判据 + 台阶落点 + 转向探针）

**Files:**
- Create: `src/entities/zombies/zombie-navigation.js`
- Modify: `src/entities/zombies/zombie-config.js`（文件末尾追加两个导出）
- Test: `src/tests/test-zombies.js`（在文件末尾追加新段落）

**Interfaces:**
- Consumes: `ZOMBIE`、`ZOMBIE_MOVING_EPSILON`、`ZOMBIE_MAX_STEP`、`ZOMBIE_STEERING`（均在 `zombie-config.js`）；`world.isSolid(x, y, z) -> boolean`（`src/voxel/world-data.js`）。
- Produces（Task 2 与 Task 3 依赖）：
  - `zombieCollidesAt(world, x, y, z) -> boolean` —— 丧尸 AABB `0.6 × 1.8 × 0.6`（脚底为 `y`）与实心方块是否相交。
  - `zombieStepUpY(y) -> number` —— 一格台阶的落点脚底高度。
  - `steerIntent({ world, position, vx, vz }) -> { vx: number, vz: number, blocked: boolean }`。

- [ ] **Step 1: 写失败测试（用例 a~i）**

在 `src/tests/test-zombies.js` **末尾**追加下列段落（`makeAiFixture` 已在该文件内定义，平地 y=0 全 stone、玩家 `[0.5,1,0.5]`）：

```js
// ---------- 局部避障（zombie-navigation） ----------
//
// 覆盖规格 §6.1 的 a~i。**全部只调纯函数**（不经过 ZombieService），因为接线由 Task 2 的 j~l 覆盖。
// fixture 口径：`makeAiFixture()` 的平地（y=0 全 stone，脚底 y=1），`world.setBlock(x, y, z, ids.stone)` 造墙。

test('避障: a) 无障碍 → 输出逐位等于输入（平地零回归）', () => {
  const { world } = makeAiFixture();
  const intent = { vx: ZOMBIE.speed, vz: 0 };
  const out = steerIntent({ world, position: [10.5, 1, 0.5], vx: intent.vx, vz: intent.vz });
  // 逐位相等（Object.is），不是 close —— 归一化重建会让 1.2 变成 1.1999999999999997
  assertTrue(Object.is(out.vx, intent.vx), `vx 须逐位相等，实得 ${out.vx}`);
  assertTrue(Object.is(out.vz, intent.vz), `vz 须逐位相等，实得 ${out.vz}`);
  assertFalse(out.blocked);
});

test('避障: b) 正前 1 格墙、右侧通 → 偏 +22.5°（最小偏角）', () => {
  const { world, ids } = makeAiFixture();
  // 朝 +X 走，墙在 x=11 的 y=1..2（2 格高 → 1.8 高的丧尸过不去）
  world.setBlock(11, 1, 0, ids.stone);
  world.setBlock(11, 2, 0, ids.stone);
  const out = steerIntent({ world, position: [10.5, 1, 0.5], vx: ZOMBIE.speed, vz: 0 });
  assertFalse(out.blocked);
  // 偏角 = 第一个候选档（anglesDeg[0] = 22.5°），方向 = 把 (+1,0) 旋转 +22.5°
  const theta = ZOMBIE_STEERING.anglesDeg[0] * Math.PI / 180;
  assertClose(out.vx, Math.cos(theta) * ZOMBIE.speed, 1e-12, 'vx');
  assertClose(out.vz, Math.sin(theta) * ZOMBIE.speed, 1e-12, 'vz');
});
```

⚠️ `assertClose` 在本文件里是**私有局部 helper**（`:34`，收 4 个参数），不在 `assert.js`——
直接调用即可，**不要**另外 import。

接着按同样格式补齐 `c`~`i` 七条（本条步骤要求**九条全部写完再跑**）：

- `c) 正前墙、左侧通 → 偏 −22.5°`：造一列**把右侧完整堵住**的墙（`x=11`、`z=0..3`、`y=1..2`
  全 stone，左侧 `z<0` 留空），断言 `out.vz < 0`（向 −Z 偏 = −22.5° 方向）。
- `d) 正前墙、两侧都通 → 取 +22.5°`：墙只在 `x=11, z=0, y=1..2`（两侧皆空）；断言输出与 `b`
  **逐位相同**（`assertDeepEqual` 比 `[out.vx, out.vz]`），钉住候选顺序常量「先 + 后 −”。
  （b 与 d 共用同一个输入与同一堵墙，差别只在「两侧是否都空」—— 只写一条的话「永远偏右」与
  「永远偏左」两种实现各能通过一条。）
- `e) 台阶不误判 / 2 格墙仍偏转`：先把 `x=11, z=0` 只放 `y=1`（一格台阶）→ 断言
  `Object.is(out.vx, ZOMBIE.speed) && Object.is(out.vz, 0)`（**不偏转**）；再补 `y=2`（变 2 格墙）→
  断言 `out.vz !== 0`（偏转）。
- `f) 四面围死 → blocked 且零速度`：把整个世界都填成实心（`world.columns` 里每个 column 的
  `y=1..3` 全 `setBlock(..., ids.stone)`；fixture 只有 8 列）—— 比「按候选点算环」简单且无遗漏。
  用 `position: [10.5, 4, 0.5]`（站在填好的实心层**上方**）→ 断言
  `out.blocked === true && out.vx === 0 && out.vz === 0`。
  ⚠️ 不要把丧尸埋进石头里：探针只回答「目标点能不能站」，不判「当前是否已被埋」，
  那种情况由物理的 `_moveAxis` 处理，不在本用例范围。
- `g) 速度长度守恒`：对 `vx/vz` 取 9 个方向（0°, 40°, 80° … 320°）各调一次（平地无墙），
  断言 `hypot(out.vx,out.vz)` 与 `hypot(vx,vz)` 差 < 1e-12（此处用 `assertClose`，**不用** `Object.is`）。
- `h) 净空 1.8 的走廊不判 blocked`：把世界 `y=3` 整层填 stone（顶栅），脚底分别取 `y=1` 与
  `y=1.2` 两个高度各调一次（都朝 +X），断言 `blocked === false`。**y=1.2 是关键**：AABB 顶面恰为
  3.0，没有 `PHYS_EPSILON` 的实现会多采一格 `y=3` 判堵死（而 y=1 时顶面 2.8 不会）。
  ⚠️ **不能取 `y=1.2` 之外的任意小数**：只有「顶面恰落在格边界上」才能区分有没有 ε ——
  取 1.5（顶面 3.3）两种实现都判堵，取 1.0（顶面 2.8）两种实现都判通。
- `i) 零速度意图 → 原样返回、不判 blocked`：两个输入 —— `(0, 0)` 与 `(1e-4, 0)`（后者小于
  `ZOMBIE_MOVING_EPSILON = 0.001`，是亚阈值档）→ 断言两者都**逐位**原样返回且 `blocked === false`。

同时在文件顶部 import 区追加：

```js
import {
  zombieCollidesAt, zombieStepUpY, steerIntent,
} from '../entities/zombies/zombie-navigation.js';
import { ZOMBIE_MAX_STEP, ZOMBIE_STEERING } from '../entities/zombies/zombie-config.js';
```

- [ ] **Step 2: 跑测试确认 RED**

先 `npm start`（若 8081 已在跑则复用），浏览器打开 `http://localhost:8081/src/tests/index.html`，
或直接 `npx playwright test tests/harness.spec.mjs`。

Expected: 9 条新用例 FAIL，报 `Failed to resolve module specifier` 或 `steerIntent is not a function`
（模块尚不存在）。**这一条必须亲眼看到** —— 若显示 PASS，说明测试写错了。

- [ ] **Step 3: 在 `zombie-config.js` 追加常量**

在文件末尾追加（`ZOMBIE_MAX_STEP` 从 `zombie-system.js` 的局部常量上移，见 Task 2）：

```js
/**
 * 一格台阶上限（mc-lite `PHYSICS_CONFIG.MAX_STEP`）。物理的 `tryStepUp` 与避障探针共用同一份
 * （红线 1：两份字面量会漂移成「探针以为能上台阶、物理抬不上去」→ 丧尸贴着台阶反复试探）。
 */
export const ZOMBIE_MAX_STEP = 1.0;

/**
 * 局部避障（v2.40）。用户裁定「贴身绕行即可」+「完全过不去时留在原地不追」。
 *
 * `probeDistance = 1.2`（≈ 半宽 0.3 + 0.9 行程）是**实玩标定值**：嫌拐早/拐晚只改它。
 * `anglesDeg` 必须**升序**且每档「先 + 后 −」——保证取能走的最小偏角，90° 只在最后兜底沿墙蹭。
 */
export const ZOMBIE_STEERING = Object.freeze({
  probeDistance: 1.2,
  anglesDeg: Object.freeze([22.5, 45, 67.5, 90]),
});
```

- [ ] **Step 4: 实现 `zombie-navigation.js`**

新建 `src/entities/zombies/zombie-navigation.js`，导出 `zombieCollidesAt`、`zombieStepUpY`、`steerIntent`
三个函数，签名与语义严格按上方 Interfaces 与规格 §3：

- `zombieCollidesAt` 的三层循环从 `zombie-system.js:236` 的 `collides()` **整段搬过来**（含
  `PHYS_EPSILON = 0.001` 与 `y1 = Math.floor(y + ZOMBIE.height - PHYS_EPSILON)`），只把
  `state.position` 换成入参 `x/y/z`。
- `zombieStepUpY(y) = Math.floor(y + 0.01) + 1`。
- `steerIntent` 按规格 §3 的四步：零速短路（`len <= ZOMBIE_MOVING_EPSILON` 原样返回）→ 归一化 →
  9 个候选（`0` + 每档先 `+` 后 `−`，旋转用规格里那条
  `(u.x·cos − u.z·sin, u.x·sin + u.z·cos)`）→ 取第一个可通行，**`0` 档命中时原样返回输入**
  （保证用例 a 的逐位回归）；全不可通行返回 `{ vx: 0, vz: 0, blocked: true }`。
- 候选点的通行判定 = `!zombieCollidesAt(world, tx, y, tz)`，否则若
  `zombieStepUpY(y) - y <= ZOMBIE_MAX_STEP && !zombieCollidesAt(world, tx, zombieStepUpY(y), tz)` 也算通行。

文件头必须写明：同构层（无 DOM / 无 three / 不新建 Worker）、这是碰撞与台阶落点的**唯一实现**、
`PHYS_EPSILON` 是载荷性的。

- [ ] **Step 5: 跑测试确认 GREEN**

Run: `npx playwright test tests/harness.spec.mjs`（或浏览器打开 `/src/tests/index.html`）
Expected: 全绿，**且 `Failed: 0`**。若 `h` 用 y=1.2 那条红，检查 `PHYS_EPSILON` 是否被漏掉。

- [ ] **Step 6: 门禁**

Run: `npm run check`
Expected: `check:arch` / `check:data` / `lint` 全绿（`src/entities/**` 不得出现 three import）。

- [ ] **Step 7: 汇报（不提交）**

汇报用例 a~i 的实测结果（尤其 a 的逐位断言、e 的台阶两半、h 的两个高度）。

---

### Task 2: 接线 —— 物理转调 + `_applyIntent` 探针 + `mode` 白名单

**Files:**
- Modify: `src/entities/zombies/zombie-system.js`（`collides()` :236、`tryStepUp()` :206、`createState()` :138、`setIntent()` :466、`_applyIntent()` :546；删除局部 `MAX_STEP` :168 附近）
- Test: `src/tests/test-zombies.js`（继续在末尾追加 j~l）

**Interfaces:**
- Consumes: Task 1 的 `zombieCollidesAt` / `zombieStepUpY` / `steerIntent`；`ZOMBIE_MAX_STEP`、`ZOMBIE_STEERING`。
- Produces: 无新导出。行为契约 = `_applyIntent` 写入 state 的速度是**经转向后**的速度；`state.mode` 允许取 `'idle' | 'chasing' | 'blocked'`。

- [ ] **Step 1: 写失败测试（用例 j~l）**

在同一文件的避障段落之后追加（沿用 `makeAiFixture` 的 fake pool，回包注入方式见 `test-zombies.js:1000` 附近的既有用例）：

```js
test('避障: j) _applyIntent 写入的是偏转后的速度（接线，不是纯函数）', async () => {
  const { zombies, pool, playerPosition, world, ids } = makeAiFixture();
  // 2 格高墙挡住 +X 直线
  world.setBlock(11, 1, 0, ids.stone);
  world.setBlock(11, 2, 0, ids.stone);
  const id = zombies.spawn([10.5, 1, 0.5], { source: 'test' });
  const generation = zombies.entities.get(id).generation;
  pool.replies.push({ updates: [{ id, generation, vx: ZOMBIE.speed, vz: 0, mode: 'chasing' }] });
  zombies.update(ZOMBIE.aiPeriod, { playerPosition, nowMs: 1000 });
  await Promise.resolve(); await Promise.resolve();
  const st = zombies.get(id);
  assertTrue(Math.abs(st.velocity[2]) > 0.1, `须被偏转（vz=${st.velocity[2]}）`);
  assertEqual(st.mode, 'chasing');
});
```

⚠️ **`makeAiFixture()` 已返回 `world` 与 `ids`**（`:857`）——直接用解构拿，
**不要给它加新字段**（那是为这个用例改 fixture，会把「消费方看不到的数据」变成契约）。

- `j)` 在 `x=11, y=1..2, z=0` 造 2 格墙；`zombies.spawn([10.5,1,0.5])`；注入回包
  `{ id, generation, vx: ZOMBIE.speed, vz: 0, mode: 'chasing' }`；`update(ZOMBIE.aiPeriod, ...)` + 两次
  `await Promise.resolve()`；断言 `zombies.get(id).velocity[2] !== 0`（被偏转）且
  `zombies.get(id).mode === 'chasing'`。
- `k)` 直接 `zombies.setIntent(id, { vx: 0, vz: 0, mode: 'blocked' })`，断言 `zombies.get(id).mode === 'blocked'`
  （**不得**被规范化成 `'idle'`）；再 `zombies.damage(id, 1, 0)` 触发一次 `createState` 重建，断言
  `mode` 仍是 `'blocked'`（两条路径都要覆盖 —— `createState` 与 `setIntent` 各有一份三元表达式）。
- `l)` 四面围死（同 Task 1 用例 `f` 的造墙法）→ 注入朝 +X 的回包 → 断言 `velocity` 水平分量全为 0 且
  `mode === 'blocked'`、`position[0]` 与围死前差 < 1e-6；然后**拆掉 +X 侧的墙**，再注入同一回包 →
  `await` 两拍 → 断言 `mode === 'chasing'` 且 300 步物理（`entities.update(1/60, { world })`）后
  `position[0]` 增加了（探针无记忆，能恢复）。

- [ ] **Step 2: 跑测试确认 RED**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: j 报「velocity[2] 为 0」（未接线）；k 报「mode 为 idle」（白名单没改）；l 同样红。
a~i 仍绿（纯函数已实现）。

- [ ] **Step 3: 改 `zombie-system.js` 的五处**

1. 顶部 import 增加 `import { zombieCollidesAt, zombieStepUpY, steerIntent } from './zombie-navigation.js';`
   与 `ZOMBIE_MAX_STEP`（并入既有 `zombie-config.js` 的 import 列表）。
2. `collides(state, world)` 函数体（`:236`~`:250`）整体替换为
   `return zombieCollidesAt(world, state.position[0], state.position[1], state.position[2]);`
   （保留原 JSDoc 并把「唯一实现在 `zombie-navigation.js`」写进去）。
3. `tryStepUp()`（`:206`）里 `const lifted = Math.floor(oldY + 0.01) + 1;` 改成
   `const lifted = zombieStepUpY(oldY);`；`if (lifted - oldY > MAX_STEP)` 改成 `> ZOMBIE_MAX_STEP`，
   并删除局部常量 `const MAX_STEP = 1.0;`（`:166`）。
   ⚠️ **`PHYS_EPSILON`（`:167`）也一并删除** —— 它**只**被 `collides()`（`:240`）用过（实测已用 grep
   核过），而 `collides()` 整段搬去 `zombie-navigation.js`，所以它跟随迁移：导航侧保留同名常量
   `PHYS_EPSILON = 0.001`（**只有一份权威**）。删完 `zombie-system.js` 里不得再出现该名字
   （lint 的 `no-unused-vars` 会抓漏删）。
4. `createState()` 的 `mode: mode === 'chasing' ? 'chasing' : 'idle',` 与 `setIntent()` 的同名字段，
   都改成三值白名单（抽一个模块内的小函数 `normalizeMode(mode)`，两处共用 —— 不要写两份三元）：
   ```js
   function normalizeMode(mode) {
     return mode === 'chasing' || mode === 'blocked' ? mode : 'idle';
   }
   ```
5. `_applyIntent()`（`:546`）在钳速之后、`setIntent` 之前插入探针：
   ```js
   const steered = steerIntent({
     world: this.world, position: entity.state.position, vx: outVx, vz: outVz,
   });
   return this.setIntent(id, {
     vx: steered.vx, vz: steered.vz,
     mode: steered.blocked ? 'blocked' : mode,
   });
   ```
   并把 JSDoc 补一条：**探针必须留在这里（AI 回包唯一消费点），不得搬进 `setIntent`**。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: a~l 全绿。

- [ ] **Step 5: 跑既有丧尸回归（本任务最可能误伤的地方）**

Run: `npx playwright test tests/zombies.spec.mjs`
Expected: 全绿。特别关注三条：
- 「M6：AI batch 经真实 WorkerPool 可观测」（`mode` 与 RPC 键集）；
- 「X 键生成丧尸」（生成后要能追）；
- 「默认 20 只丧尸压力验收」（`fps > 90`）。
若「AI batch」红在 `mode`，先确认 `normalizeMode` 没有把 `chasing` 写错；若压力用例红在 fps，
按 `docs/testing-policy.md` §2.5 做交替对照再判定。

- [ ] **Step 6: 门禁**

Run: `npm run check`
Expected: 全绿。

- [ ] **Step 7: 汇报（不提交）**

汇报 a~l 与 `tests/zombies.spec.mjs` 的实测结果。

---

### Task 3: Tier 4 —— 真游戏页的绕墙与围死

**Files:**
- Modify: `tests/zombies.spec.mjs`（文件末尾追加两条 test）

**Interfaces:**
- Consumes: `window.__MC_GAME__`（`editor.setBlock` / `zombies.spawn` / `zombies.get` / `world`）、
  `installHelpers(page)`（该文件已有）、`waitWorldReady(page)`（该文件已有）。
- Produces: 无。

- [ ] **Step 1: 写两条 Tier 4 用例**

在 `tests/zombies.spec.mjs` 末尾追加：

```js
test('M6：局部避障 —— 丧尸绕开 3 格高短墙追上玩家（真游戏页）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=4&seed=12345');
  await waitWorldReady(page);
  await installHelpers(page);
  const result = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const pos = window.__ZT__.legalSpawnNear(8);           // 8~20 格：足够远，绕行才有可观测行程
    const p = g.player.physics.pos;
    // ⚠️ **先造墙，再生成丧尸**：`spawn` 会校验「脚格/头格 air」；先 spawn 再在它脚下立墙
    // 会把方块写进丧尸身体（且后续 step-up 行为不可预测）。
    const stone = g.registry.idOf('stone');
    const mx = Math.floor((p.x + pos[0]) / 2), mz = Math.floor((p.z + pos[2]) / 2);
    const y0 = Math.floor(pos[1]);
    const alongX = Math.abs(pos[0] - p.x) >= Math.abs(pos[2] - p.z);
    // 3 格高 × 5 格宽的墙：只挡住直线，两端留空 —— 丧尸必须绕过端头才能过来。
    // ⚠️ 宽度 5 而不是 3（实测教训口径）：1.2 格步长的探针需 2 次偏移才能让开 3 格宽墙，
    // 留宽一点才能让「未接线」与「已接线」两侧读数差拉开（负向验证必须真红）。
    for (let k = -2; k <= 2; k++) {
      for (let dy = 0; dy < 3; dy++) {
        g.editor.setBlock({ x: alongX ? mx : mx + k, y: y0 + dy, z: alongX ? mz + k : mz, id: stone });
      }
    }
    const id = g.zombies.spawn(pos, { source: 'test' });
    const startDist = Math.hypot(pos[0] - p.x, pos[2] - p.z);
    // 等 12 秒（1.2 格/秒 × 12 = 14.4 格行程；绕 5 格宽墙需约 7~9 格）
    await new Promise((r) => setTimeout(r, 12000));
    const st = g.zombies.get(id);
    const now = st.position;
    return {
      id, startDist,
      endDist: Math.hypot(now[0] - p.x, now[2] - p.z),
      // 「跨过墙所在直线、到了玩家这一侧」—— 未接线时永远为 false（丧尸贴着墙一动不动）
      crossed: alongX ? (now[0] - mx) * (p.x - mx) > 0 : (now[2] - mz) * (p.z - mz) > 0,
      mode: st.mode,
      count: g.zombies.count(),
    };
  });
  // 正向：确实绕过去了（落在墙的玩家这一侧 + 距离明显减小）
  expect(result.id).toBeTruthy();
  expect(result.crossed).toBe(true);
  expect(result.endDist).toBeLessThan(result.startDist - 2);
  expect(result.count).toBe(1);
});
```

第二条（围死）：

```js
test('M6：局部避障 —— 四面围死时原地站住（blocked），不消失', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=4&seed=12345');
  await waitWorldReady(page);
  await installHelpers(page);
  const result = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const pos = window.__ZT__.legalSpawnNear(8);
    const stone = g.registry.idOf('stone');
    const x0 = Math.floor(pos[0]), y0 = Math.floor(pos[1]), z0 = Math.floor(pos[2]);
    // 3×3 的竖井（内空 1 格）+ 顶盖：把丧尸关在 (x0, y0, z0) 里。
    // 环 = |dx|==1 或 |dz|==1；盖 = 内圈 y0+3（防跳走 —— 虽然丧尸不会跳，但防 step-up）。
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dy = 0; dy < 3; dy++) {
          if (dx === 0 && dz === 0) continue;                 // 中心格留给丧尸
          g.editor.setBlock({ x: x0 + dx, y: y0 + dy, z: z0 + dz, id: stone });
        }
        g.editor.setBlock({ x: x0 + dx, y: y0 + 3, z: z0 + dz, id: stone });
      }
    }
    const id = g.zombies.spawn(pos, { source: 'test' });
    const before = [...g.zombies.get(id).position];
    await new Promise((r) => setTimeout(r, 8000));
    const st = g.zombies.get(id);
    return {
      moved: Math.hypot(st.position[0] - before[0], st.position[2] - before[2]),
      dy: Math.abs(st.position[1] - before[1]),
      mode: st.mode,
      count: g.zombies.count(),
    };
  });
  expect(result.moved).toBeLessThan(0.05);
  expect(result.dy).toBeLessThan(0.05);
  expect(result.mode).toBe('blocked');
  expect(result.count).toBe(1);   // 没被 column 卸载或上限回收
});
```

⚠️ **两条用例都是「先造墙、后 `spawn`」**（顺序与直觉相反）：`spawn` 校验脚/头格必须为 air。
先 spawn 再在它脚下立墙会直接把方块写进丧尸身体。

- [ ] **Step 2: 跑测试确认 GREEN**

Run: `npx playwright test tests/zombies.spec.mjs -g "局部避障"`
Expected: 两条 PASS。若绕墙那条跨不过去，先打印实际轨迹判断是「墙造得太宽」还是「探针没生效」
（前者是 fixture 问题，后者回去看 Task 2 Step 3 的接线）。

- [ ] **Step 3: 负向验证（必须有，且必须真红）**

临时把 `zombie-navigation.js` 的 `steerIntent` 第一行改成 `return { vx, vz, blocked: false };`
（**先 `cp src/entities/zombies/zombie-navigation.js /tmp/nav.bak`**，本仓禁用 `git checkout` 还原未提交改动）。
再跑 `npx playwright test tests/zombies.spec.mjs -g "局部避障"`。

Expected: **绕墙那条 FAIL**（`crossed === false`）。围死那条此时仍可能 PASS（零速度本来就不到墙），
所以它是**第二条判据**而非负向目标。确认后 `cp /tmp/nav.bak src/entities/zombies/zombie-navigation.js` 还原，
重跑确认恢复 GREEN。

- [ ] **Step 4: 全量丧尸 spec**

Run: `npx playwright test tests/zombies.spec.mjs`
Expected: 全绿（含既有 10 条）。

- [ ] **Step 5: 汇报（不提交）**

汇报两条 Tier 4 的实测数值（`startDist`/`endDist`/`crossed`、围死位移与 mode）与负向验证结论。

---

### Task 4: 文档同步（roadmap v2.40 + CLAUDE.md 活跃约束 + spec 实施记录）

**Files:**
- Modify: `docs/roadmap.md`（在 v2.39 行之后加 v2.40 行）
- Modify: `CLAUDE.md`（「M6 丧尸沉淀的活跃约束」段追加两条）
- Modify: `docs/superpowers/specs/2026-11-02-zombie-obstacle-avoidance-design.md`（§10 实施记录）

**Interfaces:** 无代码接口。

- [ ] **Step 1: roadmap 加一行**

在 `docs/roadmap.md` 的 `| v2.39 | … |` 行之后追加 `| v2.40 | 丧尸局部避障（贴身绕行） | ✅ 已完成 | … |`，
行内必须含：用户原话（「丧尸现在只是无脑的走向玩家……可以绕过简单的障碍物」）、实现要点
（探针接 `_applyIntent`、9 个候选偏角、台阶前瞻、`blocked`）、Task 3 的实测数值、已知取舍
（转向跳变未平滑 / 贴墙蹭）。

- [ ] **Step 2: CLAUDE.md 加两条活跃约束**

在「M6 丧尸沉淀的活跃约束」段末尾追加两条：

1. **避障探针接在 `_applyIntent`（AI 回包唯一消费点），不得接在 `setIntent`** —— 后者是通用指令通道，
   物理用例与调试代码直接用它下令；探针长在里面会让「想让它走就必须能走」的语义被偷换，且既有物理用例
   会被地形挡住假红。附**为什么是主线程**：worker 无世界数据（M6 规格 §2），世界唯一权威在主线程。
2. **`zombieCollidesAt` / `zombieStepUpY` 是丧尸 AABB 与台阶落点的唯一实现**（物理与探针共用，
   `PHYS_EPSILON = 0.001` 载荷性）。改任一处必须同时跑 `test-zombies.js` 的避障段落与
   「丧尸物理: 一格 step-up」两条。

- [ ] **Step 3: spec 填实施记录**

把 `docs/superpowers/specs/2026-11-02-zombie-obstacle-avoidance-design.md` 的 §10 从「待填」改成实测记录：
a~l 与 Tier 4 的实际读数、负向验证结论、实玩观感（拐早拐晚 / 转头是否生硬 / 是否需要绕行侧记忆）、
偏离本设计之处。

- [ ] **Step 4: 门禁**

Run: `npm run check`
Expected: 全绿（文档改动不影响门禁，但确认没有顺手改坏别的）。

- [ ] **Step 5: 汇报**

汇报三份文档的落点与 roadmap 新行的一句话摘要，并**询问用户是否要提交**（本计划全程不自动 commit）。
