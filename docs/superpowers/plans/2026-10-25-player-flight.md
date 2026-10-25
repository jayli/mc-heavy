# 玩家飞行（创造模式飞行）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让玩家能像原版创造模式那样开关飞行、自由升降、水平速度为走路的 2 倍，并且下降触地自动退出飞行。

**Architecture:** `flying` 状态与其全部物理行为收在 `src/player/physics.js`（唯一权威）；`src/player/player.js` 只做按键边沿（F 切换）与垂直输入分流；面板文案加一行；其余行为（飞行时不晃、乘坐期 F 无效）靠既有判据自然得到，不新增第二份状态。

**Tech Stack:** 纯 ES2022 JavaScript + JSDoc（无 TypeScript / 无 bundler）、three r185.1 WebGPU、浏览器内自研测试 runner（`src/tests/`）、Playwright E2E（`tests/`）。

**Spec:** `docs/superpowers/specs/2026-10-25-player-flight-design.md`

## Global Constraints

- **常量单一权威**：`FLY_SPEED_MULT = 2`、`FLY_VERTICAL_SPEED = 8` 只写在 `src/player/physics.js` 顶部并 `export`；`player.js` / 测试 / 文档引用它们，不写字面量 `16` / `8` 当速度（spec §4.2）。
- **不改 `SPEED`、`GRAVITY`、`JUMP_FORCE`**：`view-bob.js` 的 `phasePerBlock` 由 `SPEED` 派生，改它要重标晃动频率（spec §1「明确不做」）。
- **不新增测试文件**：`tools/check-data.mjs:275` 的 `[测试注册]` 要求 `src/tests/test-*.js` 全部在 `src/tests/index.html` 里 import。用例加进既有的 `test-physics.js` / `test-player-input.js`。
- **不做**：Ctrl 加速档、双击空格、飞行惯性、飞行视角晃动、旁观模式穿墙、飞行音效、飞行状态持久化（spec §1）。
- **中文**：代码注释与提交信息说明用中文；提交信息用 Conventional Commits。**未获明确指令不得提交**（本计划的 `git commit` 步骤默认只在用户已授权提交时执行，见 Task 0）。
- **改完 `src/**/*.js` 必须跑 `npm run lint`**：`PNG_CSS` 类的模板字符串解析错误会让整页白屏（历史教训）。

## Review Focus

下面五类是 spec 没写、但用户实际会遇到的输入或条件，各自都容易在本实现里静默出错；每一条都已绑定到负责它的任务的测试步骤：

1. **在空中按 F 切成飞行时，玩家已经在往下掉** —— 若不清零 `vel.y`，按下 F 后玩家仍以 −24 的加速度继续下坠，观感是「F 没生效，只是慢了一点」（Task 1 / P1 的相邻场景：`toggleFlight` 后一句 `moveVertical(0)` 必须停住）。
2. **站在地面上按 F，贴地悬停 1 帧就被踢回地面** —— `onGround` 若不在每步清零，悬停读到上一步的 `true` 就立即退出飞行（Task 1 / P4 + N2）。
3. **飞行中按住 Shift 同时左键点矿车** —— Shift 在飞行中是下降键、在矿车交互里是「后退」修饰，两者会同时触发；预期「都生效、互不干扰」（Task 2 / K6 的对照用例 + Task 2 Step 7 跑矿车 spec，且不给 `digBlock` 加飞行门控）。
4. **坐在矿车里按 F** —— 物理步在乘坐期整段跳过，允许切换会造出「视觉在车上、状态说在飞」的分裂；预期按 F 无反应（Task 2 / K7）。
5. **面板文案变长后把固定宽度 330px 撑出横向溢出** —— 用户 v1.80 明确要求宽度不变，溢出是肉眼可见的破版（Task 3 改文案 + Task 4 的 E5 实测 `scrollWidth ≤ clientWidth` 且面板宽仍 330）。

---

### Task 0: 开工前提（分支与提交授权）

**Files:** 无代码改动。

**Interfaces:**
- Consumes: 无
- Produces: 一个可安全试错的起点

- [ ] **Step 1: 确认工作树干净**

Run: `git status --short`
Expected: 只有本次会话之前就该在的东西（spec 文件未提交是正常的）。若有**与飞行无关**的未提交改动，先停下问用户，不要 stash 别人的活。

- [ ] **Step 2: 确认提交授权**

问用户一句：本计划每个 Task 末尾的 `git commit` 是否现在就执行（项目规则：**未获明确指令不得提交**）。
- 用户说「提交」→ 各 Task 末尾照 Step 执行提交；
- 用户没说 → 跳过所有 `git commit` 步骤，其余步骤全部照做，最后统一报告改动文件列表。

- [ ] **Step 3: 记下基线**

Run: `npm run check`
Expected: exit 0（`check:arch` + `check:data` + `lint` 全绿）。若本来就红，先把红的原因报给用户，不要在红基线上开工。

---

### Task 1: `PlayerPhysics` 的飞行状态与运动

**Files:**
- Modify: `src/player/physics.js`（常量区 1-8 行；`constructor` 12-30 行；`step` 35-50；`_tryStepUp` 103；`jump` 184；`move` 201-208）
- Test: `src/tests/test-physics.js`（文件末尾追加用例；不新建文件）

**Interfaces:**
- Consumes: 既有 `PlayerPhysics.step(dt)` / `._moveAxis(delta, axis)` / `._collides()` / `world.isSolid`（全部不变）
- Produces（后续任务与测试都按这些名字用）:
  - `export const FLY_SPEED_MULT = 2`（无单位倍率）
  - `export const FLY_VERTICAL_SPEED = 8`（格/秒）
  - `player.physics.flying: boolean`（可读写；`false` = 地面/空中常规物理）
  - `player.physics.toggleFlight(): void`（翻转 `flying` 并清零 `vel.y`）
  - `player.physics.moveVertical(dir: number): void`（`dir` ∈ {+1, 0, -1}；非飞行态 no-op；飞行态把 `vel.y` 设成 `dir * FLY_VERTICAL_SPEED`）
  - `player.physics._stepFlying(dt: number): void`（内部方法，仅测试可读）

- [ ] **Step 1: 写失败用例（P1/P2 先落两条，确认 RED 后再补其余）**

在 `src/tests/test-physics.js` 末尾追加（`makeWorld()` / `EPS` 已在文件顶部定义，直接复用）：

```js
// ---- 飞行（spec 2026-10-25-player-flight-design.md §4.3）----

test('flight: 悬停不掉落（零重力），且 toggleFlight 清零竖直速度', () => {
  const { world } = makeWorld();
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: 20, z: 8 };
  // 先让它掉一会儿，模拟「下坠中按 F」—— toggleFlight 必须吃掉这份速度
  p.step(1 / 60);
  assertTrue(p.vel.y < 0, `前提：须处于下坠，vel.y=${p.vel.y}`);
  p.toggleFlight();
  assertTrue(p.flying, 'toggleFlight 后处于飞行态');
  assertEqual(p.vel.y, 0, 'toggleFlight 必须清零竖直速度（否则按 F 后仍在加速下坠）');
  const y0 = p.pos.y;
  for (let i = 0; i < 60; i++) { p.moveVertical(0); p.step(1 / 60); }
  assertTrue(Math.abs(p.pos.y - y0) < 1e-9, `悬停 60 步高度须不变，y0=${y0} y=${p.pos.y}`);
});

test('flight: 空格上升 / Shift 下降的速度等于 FLY_VERTICAL_SPEED', () => {
  const { world } = makeWorld();
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: 20, z: 8 };
  p.toggleFlight();
  const y0 = p.pos.y;
  for (let i = 0; i < 60; i++) { p.moveVertical(1); p.step(1 / 60); }
  const up = p.pos.y - y0;
  assertTrue(Math.abs(up - FLY_VERTICAL_SPEED) < FLY_VERTICAL_SPEED * 0.05,
    `上升 1 秒的距离须 ≈ ${FLY_VERTICAL_SPEED} 格（实测 ${up}）`);
  const y1 = p.pos.y;
  for (let i = 0; i < 60; i++) { p.moveVertical(-1); p.step(1 / 60); }
  const down = y1 - p.pos.y;
  assertTrue(Math.abs(down - FLY_VERTICAL_SPEED) < FLY_VERTICAL_SPEED * 0.05,
    `下降 1 秒的距离须 ≈ ${FLY_VERTICAL_SPEED} 格（实测 ${down}）`);
});
```

并在文件顶部的 import 行把新常量一起引入：

```js
import { PlayerPhysics, FLY_SPEED_MULT, FLY_VERTICAL_SPEED } from '../player/physics.js';
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: FAIL。`window.__MC_TEST_RESULTS__.failed > 0`，失败信息含 `p.toggleFlight is not a function` 或 `import ... FLY_SPEED_MULT` 解析失败。**把实际失败文本抄下来**（Tier 1 的 RED 必须是真的跑过）。

- [ ] **Step 3: 实现常量、字段与两个方法**

`src/player/physics.js` 顶部常量区，在 `SPEED` 之后加：

```js
/**
 * 飞行水平速度倍率（用户裁定 2026-10-25：走路 2 倍，不设 Ctrl 加速档）。
 * 原版创造飞行是走路的 2.5×，但本仓 `SPEED = 8` 已是原版疾跑（5.612）的 1.43 倍，
 * 照抄 2.5× 会到 20 格/秒 —— 故按「倍率」口径取 2（= 16 格/秒）。
 */
export const FLY_SPEED_MULT = 2;
/**
 * 飞行垂直速度（格/秒，空格升 / Shift 降）。
 * ⚠️ **这是初值不是推导值**（原版无公开稳定数值可引）：8 ≈ 水平飞行速度的一半。
 * 实玩后若觉得爬升太慢/太快，只改这一个数 —— 与 `BOB.intensity` 同一标定口径。
 */
export const FLY_VERTICAL_SPEED = 8;
```

`constructor` 里，紧跟 `this.inWater = false;` 加：

```js
    /**
     * 飞行态（spec §4.1：**唯一权威在本类**，`Player` 不复制一份）。`true` 时 `step()` 走
     * `_stepFlying()`（零重力 + 恒定垂直速度），并且飞行中 `onGround` 恒为 false。
     */
    this.flying = false;
```

在 `step(dt)` **之前**加两个公开方法：

```js
  /** 开/关飞行（边沿由调用方保证 —— `player.js` 的 `!e.repeat`）。同时清零竖直速度： */
  toggleFlight() {
    this.flying = !this.flying;
    // 清零是载荷性的：不清的话「下坠中按 F」会保留 −24 的竖直速度继续掉、
    // 「起跳上升段按 F」会保留 +10 继续窜。起飞/降落都从静止竖直速度开始（悬停）。
    this.vel.y = 0;
  }

  /**
   * 飞行垂直输入：`dir` = +1 升 / -1 降 / 0 悬停。非飞行态 no-op（地面态的空格仍走 `jump()`）。
   * 每步重设 `vel.y`（无惯性，与 `move()` 每步重设水平速度同一手感口径）。
   */
  moveVertical(dir) {
    if (!this.flying) return;
    this.vel.y = dir * FLY_VERTICAL_SPEED;
  }
```

- [ ] **Step 4: 跑测试确认这两条 GREEN**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: 上面两条 `flight:` 用例通过（其余用例仍全绿）。

- [ ] **Step 5: 补其余飞行用例（P3~P8），先 RED**

追加到 `src/tests/test-physics.js` 末尾：

```js
test('flight: 下降触地退出飞行（Java 口径），落地后不再飞', () => {
  const { world } = makeWorld();       // y=0 一层石头地面，站立脚底 y=1
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: 6, z: 8 };
  p.toggleFlight();
  for (let i = 0; i < 120 && p.flying; i++) { p.moveVertical(-1); p.step(1 / 60); }
  assertFalse(p.flying, '一直下降必须触地退出飞行');
  assertTrue(p.onGround, '退出时确实在地面上');
  assertTrue(Math.abs(p.pos.y - 1) < 0.02, `停在石面 y=1，实测 ${p.pos.y}`);
});

test('flight: 贴地悬停不误退出（onGround 每步清零的护栏）', () => {
  const { world } = makeWorld();
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: 1, z: 8 };
  for (let i = 0; i < 10; i++) p.step(1 / 60);   // 先落地 → onGround = true
  assertTrue(p.onGround, '前提：须已站在地面上');
  p.toggleFlight();
  for (let i = 0; i < 60; i++) { p.moveVertical(0); p.step(1 / 60); }
  assertTrue(p.flying, '贴地悬停不得被踢出飞行');
  assertFalse(p.onGround, '飞行态 onGround 必须恒 false（同时是「飞行不晃」的判据来源）');
});

test('flight: 水平速度恰为走路的 2 倍（不比走路慢）', () => {
  const { world } = makeWorld();
  const walk = new PlayerPhysics(world);
  walk.pos = { x: 2, y: 1, z: 8 };
  for (let i = 0; i < 10; i++) walk.step(1 / 60);
  const wx = walk.pos.x;
  for (let i = 0; i < 12; i++) { walk.move(1, 0); walk.step(1 / 60); }
  const walkDist = walk.pos.x - wx;

  const fly = new PlayerPhysics(world);
  fly.pos = { x: 2, y: 40, z: 8 };
  fly.toggleFlight();
  const fx = fly.pos.x;
  for (let i = 0; i < 12; i++) { fly.move(1, 0); fly.step(1 / 60); }
  const flyDist = fly.pos.x - fx;

  assertTrue(walkDist > 0.5, `前提：走路须真的前进，实测 ${walkDist}`);
  const ratio = flyDist / walkDist;
  assertTrue(Math.abs(ratio - FLY_SPEED_MULT) < 0.02, `飞行/走路速度比须 = ${FLY_SPEED_MULT}，实测 ${ratio}`);
});

test('flight: 飞行时不自动上台阶（撞 1 格台阶被挡住）', () => {
  const { world, reg } = makeWorld();
  const col = world.getColumn(0, 0);
  for (let x = 10; x <= 15; x++) for (let lz = 0; lz < 16; lz++) {
    col.blocks[blockIndex(x, 1, lz)] = reg.idOf('stone');
  }
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: 1, z: 8 };        // 与台阶同高（台面 y=2）
  p.toggleFlight();
  for (let i = 0; i < 60; i++) { p.move(1, 0); p.step(1 / 60); }
  assertTrue(p.pos.x < 10, `飞行时不得被抬上台阶，x=${p.pos.x}`);
  assertTrue(Math.abs(p.pos.y - 1) < 1e-6, `高度不变，y=${p.pos.y}`);
});

test('flight: 关闭飞行后恢复重力（自由落体）', () => {
  const { world } = makeWorld();
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: 10, z: 8 };
  p.toggleFlight();
  for (let i = 0; i < 30; i++) { p.moveVertical(0); p.step(1 / 60); }
  assertTrue(Math.abs(p.pos.y - 10) < 1e-9, '飞行时悬停在 y=10');
  p.toggleFlight();
  assertFalse(p.flying, '再次 toggle 退出飞行');
  for (let i = 0; i < 180; i++) p.step(1 / 60);
  assertTrue(p.onGround, '退出飞行后必须落地');
  assertTrue(Math.abs(p.pos.y - 1) < 0.02, `落在石面 y=1，实测 ${p.pos.y}`);
});

test('flight: 顶到天花板不退出飞行（撞头 ≠ 落地）', () => {
  const { world, reg } = makeWorld();
  const col = world.getColumn(0, 0);
  for (let lz = 0; lz < 16; lz++) col.blocks[blockIndex(8, 6, lz)] = reg.idOf('stone');
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: 3, z: 8 };
  p.toggleFlight();
  for (let i = 0; i < 120; i++) { p.moveVertical(1); p.step(1 / 60); }
  assertTrue(p.flying, '顶到天花板仍须保持飞行态');
  assertTrue(p.pos.y < 6 - 1.7, `被天花板挡住（脚底 + 1.8 ≤ 6），y=${p.pos.y}`);
});
```

并把 `assertFalse` 加进该文件的 import 行（若尚未引入）。

- [ ] **Step 6: 跑测试确认这批 RED，然后实现 `_stepFlying` 与三处早退**

Run: `npx playwright test tests/harness.spec.mjs` → 期望这批新用例失败（`flying` 仍走重力路径：悬停会掉、台阶会爬）。

然后改 `physics.js`：

1) `step(dt)` 开头（**在 `inWater` 判定与重力之前**）：

```js
  step(dt) {
    if (this.flying) { this._stepFlying(dt); return; }
    const w = this.world;
    /* …既有重力路径逐字不动… */
```

2) 在 `step` 之后加 `_stepFlying`：

```js
  /**
   * 飞行物理（spec §4.3）。与地面路径共用 `_moveAxis` 的分轴碰撞与二分回退 ——
   * 区别只有「零重力 + 竖直速度由输入直接给」。
   *
   * ⚠️ **`onGround` 必须在移动前清零**：`onGround` 只由 `_moveAxis` 在向下碰撞时置 true，
   * 所以「清零 → 移动 → 判 onGround」恰好等价于「本步向下且触地」。不清零时，
   * 贴地悬停（竖直步长 0 → `_moveAxis` 直接 return）会带着上一步的 `true` 进来 →
   * **悬停被立即踢出飞行**（实测形态：按 F 在地面悬停一帧就掉回地面）。
   * 同一个 `onGround === false` 还是「飞行时不晃」的判据来源（`player.js` 传 `jumping: !onGround`）。
   */
  _stepFlying(dt) {
    this._moveAxis(this.vel.x * dt, 0);
    this._moveAxis(this.vel.z * dt, 2);
    this.onGround = false;
    this._moveAxis(this.vel.y * dt, 1);
    // 向下触地 → 退出飞行（Java 口径）。向上顶到天花板不会置 onGround（只把 vel.y 归零）→ 仍在飞。
    if (this.onGround) { this.flying = false; this.vel.y = 0; }
    this.vel.x = 0; this.vel.z = 0;
  }
```

3) `_tryStepUp()` 第一行之前加：

```js
    // 飞行时没有「自动上台阶」的概念（原版飞行撞到方块边缘就是停住）。
    if (this.flying) return false;
```

4) `jump()` 改为：

```js
  jump() {
    if (this.flying) return;   // 飞行中空格归 moveVertical(+1) 管（双保险，player.js 侧也已分流）
    if (this.onGround) this.vel.y = JUMP_FORCE;
    else if (this.inWater) this.vel.y = 4; // 水中上浮
  }
```

5) `move()` 里把速度行改成：

```js
    const speed = this.flying ? SPEED * FLY_SPEED_MULT : SPEED * (this.inWater ? 0.6 : 1);
```

- [ ] **Step 7: 跑测试确认全部 GREEN**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: `failed === 0`，且 `total` 比 Task 0 基线多 8 条（P1~P8）。

- [ ] **Step 8: 负向验证 N1 / N2 / N3 / N4 / N6 真 FAIL（用副本还原，禁止 `git checkout`）**

逐条做：`cp src/player/physics.js /tmp/physics-flight.js.bak` → 注入 → 跑 → **确认对应用例 FAIL 并抄下失败信息** → `cp /tmp/physics-flight.js.bak src/player/physics.js` → `diff` 逐位核对还原。

| 注入 | 期望 FAIL |
|---|---|
| N1：`step()` 里删掉 `if (this.flying) {...}` 分支 | `flight: 悬停不掉落` / `flight: 空格上升` || N2：删掉 `_stepFlying` 里的 `this.onGround = false;` | `flight: 贴地悬停不误退出` |
| N3：`SPEED * FLY_SPEED_MULT` 改成 `SPEED` | `flight: 水平速度恰为走路的 2 倍` |
| N4：删掉 `_tryStepUp` 的飞行早退 | `flight: 飞行时不自动上台阶` |
| N6：`moveVertical` 改成 `this.vel.y = dir * FLY_VERTICAL_SPEED * 2` | `flight: 空格上升 / Shift 下降的速度` |

- [ ] **Step 9: lint + commit（提交需 Task 0 的授权）**

Run: `npm run lint`
Expected: 新增代码 0 error。

```bash
git add src/player/physics.js src/tests/test-physics.js
git commit -m "feat: 玩家飞行 —— PlayerPhysics 飞行状态与运动（FLY_SPEED_MULT=2 / FLY_VERTICAL_SPEED=8）"
```

---

### Task 2: 输入绑定（F 切换 + 空格/Shift 分流）

**Files:**
- Modify: `src/player/player.js`（`onKeyDown` 208-217 附近；`_applyInput` 594-596）
- Test: `src/tests/test-player-input.js`（追加用例，复用文件既有的 `pressKey` / `releaseKey` / `makeFixture` / `stepDelta`）

**Interfaces:**
- Consumes: Task 1 的 `physics.flying` / `toggleFlight()` / `moveVertical(dir)`；既有 `this.ridingMinecartId`、`this._isModal()`
- Produces:
  - 键位契约：`KeyF` keydown（`!e.repeat`、非乘坐态）→ `physics.toggleFlight()`
  - 飞行态下 `Space` → `moveVertical(+1)`、`ShiftLeft|ShiftRight` → `moveVertical(-1)`、两者同按 → `moveVertical(0)`
  - 非飞行态下 `Space` 仍走 `physics.jump()`（行为不变）

- [ ] **Step 1: 写失败用例（K1~K7）**

追加到 `src/tests/test-player-input.js` 末尾。注意 fixture 的 camera 是纯对象 stub —— 断言只读 `physics`，不碰渲染：

```js
// ---- 飞行键位（spec 2026-10-25-player-flight-design.md §4.4）----

test('flight: F 真实 keydown 切换飞行、再按一次切回，且不 preventDefault', () => {
  const { player } = makeFixture();
  assertEqual(pressKey('KeyF'), false, 'KeyF 不得 preventDefault（F 不是浏览器功能键）');
  releaseKey('KeyF');
  assertEqual(player.physics.flying, true, '第一次按 F 起飞');
  pressKey('KeyF');
  releaseKey('KeyF');
  assertEqual(player.physics.flying, false, '第二次按 F 退出飞行');
  player.dispose();
});

test('flight: 按住 F 不连发（repeat 事件被忽略）', () => {
  const { player } = makeFixture();
  const ev = new KeyboardEvent('keydown', { code: 'KeyF', repeat: true, cancelable: true, bubbles: true });
  window.dispatchEvent(ev);
  assertEqual(player.physics.flying, false, 'repeat 事件不得触发切换（否则按住 F 会疯狂抖动）');
  player.dispose();
});

test('flight: 模态期间 F 不切换', () => {
  const { player } = makeFixture();
  player._isModal = () => true;
  pressKey('KeyF');
  releaseKey('KeyF');
  assertEqual(player.physics.flying, false, '模态守卫须覆盖 F');
  player.dispose();
});

test('flight: 飞行时空格走垂直上升而不是跳跃', () => {
  const { player } = makeFixture();
  player.physics.toggleFlight();
  player.keys.clear();
  player.keys.add('Space');
  player._applyInput();
  assertEqual(player.physics.vel.y, FLY_VERTICAL_SPEED, '飞行中空格 → 恒定上升速度');
  assertTrue(player.physics.vel.y !== 10, '不得复用 JUMP_FORCE');
  player.dispose();
});

test('flight: Shift 下降、左右 Shift 等价、升降同按=悬停', () => {
  const { player } = makeFixture();
  player.physics.toggleFlight();
  player.keys.clear();
  player.keys.add('ShiftLeft');
  player._applyInput();
  assertEqual(player.physics.vel.y, -FLY_VERTICAL_SPEED, 'ShiftLeft 下降');
  player.keys.clear();
  player.keys.add('ShiftRight');
  player._applyInput();
  assertEqual(player.physics.vel.y, -FLY_VERTICAL_SPEED, 'ShiftRight 与左 Shift 等价');
  player.keys.clear();
  player.keys.add('Space');
  player.keys.add('ShiftLeft');
  player._applyInput();
  assertEqual(player.physics.vel.y, 0, '升降同按 = 悬停（不是互相取消成两个动作）');
  player.dispose();
});

test('flight: 不飞行时 Shift 不产生任何竖直速度（飞行分支不漏到地面态）', () => {
  const { player } = makeFixture();
  player.keys.clear();
  player.keys.add('ShiftLeft');
  player._applyInput();
  assertEqual(player.physics.vel.y, 0, '地面态按 Shift 不得产生上升/下降速度');
  player.dispose();
});

test('flight: 坐在矿车里按 F 不切换（物理步在乘坐期被跳过）', () => {
  const { player } = makeFixture();
  // 用假的乘坐 id 即可：本用例只验证 player.js 的门控，不驱动矿车物理。
  player.ridingMinecartId = 'car-1';
  pressKey('KeyF');
  releaseKey('KeyF');
  assertEqual(player.physics.flying, false, '乘坐期 F 必须无效');
  player.ridingMinecartId = null;
  pressKey('KeyF');
  releaseKey('KeyF');
  assertEqual(player.physics.flying, true, '下车后 F 恢复');
  player.dispose();
});
```

并把文件顶部 import 改为同时引入常量：

```js
import { FLY_VERTICAL_SPEED } from '../player/physics.js';
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: 上面 7 条全部失败，失败信息形如 `Expected true, got false`（`flying` 仍为 false）。

- [ ] **Step 3: 实现 F 切换**

`src/player/player.js` 的 `onKeyDown` 里，紧跟 `KeyX` 那段之后加：

```js
      // 飞行开关（spec 2026-10-25 §4.4）：单击 F，**非重复事件**才触发 ——
      // 按住 F 时键盘重复率约 30Hz，不判 `e.repeat` 会让飞行状态疯狂抖动。
      // 不 preventDefault：F 不是浏览器功能键（与 ARROW_CODES 只拦方向键的口径一致）。
      // 乘坐矿车期间忽略：物理步在乘坐期整段跳过（`player.js` 的 riding 分支），
      // 允许切换只会造出「视觉在车上、状态说在飞」的分裂。
      if (e.code === 'KeyF' && !e.repeat && !this.ridingMinecartId) this.physics.toggleFlight();
```

- [ ] **Step 4: 实现空格/Shift 分流**

`_applyInput()` 末尾，把 `if (k.has('Space')) this.physics.jump();` 换成：

```js
    // 飞行态：空格/Shift 是垂直输入（原版口径），不是跳跃/潜行。
    // 升降同按时取差 → 0 = 悬停（原版同口径，不是「两个动作互相取消」）。
    // ⚠️ 非飞行态的分支必须保留原样：地面上的空格仍是 `jump()`，Shift 在键位层面不产生任何位移。
    if (this.physics.flying) {
      const up = k.has('Space') ? 1 : 0;
      const down = (k.has('ShiftLeft') || k.has('ShiftRight')) ? 1 : 0;
      this.physics.moveVertical(up - down);
    } else if (k.has('Space')) this.physics.jump();
```

- [ ] **Step 5: 跑测试确认全部 GREEN**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: `failed === 0`，`total` 再 +7。

- [ ] **Step 6: 负向验证 N5 / N7 真 FAIL**

同样用 `cp` 副本还原（**禁止 `git checkout`**）：

| 注入 | 期望 FAIL |
|---|---|
| N5：删掉 `!e.repeat` | `flight: 按住 F 不连发` |
| N7：删掉 `!this.ridingMinecartId` | `flight: 坐在矿车里按 F 不切换` |
| 额外：把分流写成 `up + down` | `flight: Shift 下降、左右 Shift 等价、升降同按=悬停`（断言 `vel.y === 0` 会变成 `-8`） |

- [ ] **Step 7: 确认「Shift + 左键点矿车」两条路径互不干扰（Review Focus 3）**

Run: `npx playwright test tests/minecarts.spec.mjs`
Expected: 全绿。飞行不改变 `digBlock({shift})` 的语义（`player.js:245` 传的是鼠标事件的 `shiftKey`，与 `keys` 集合无关）。若这里红了，说明改动误伤了矿车交互，必须修的是实现而不是测试。

- [ ] **Step 8: lint + commit**

Run: `npm run lint`
Expected: 0 error。

```bash
git add src/player/player.js src/tests/test-player-input.js
git commit -m "feat: 玩家飞行 —— F 键切换 + 空格/Shift 升降输入"
```

---

### Task 3: 面板操作说明加飞行键位

**Files:**
- Modify: `src/core/perf-hud.js`（`HELP_LINES` 33-37 行）
- Test: `src/tests/test-perf.js`（既有 `PerfHUD: 面板宽度固定 + 操作说明三行入面板` 用例：把标题与断言里的「三行」改成「四行」并加一条新文案断言）

**Interfaces:**
- Consumes: 无（纯文案）
- Produces: `HELP_LINES` 变为四行；`helpEl.textContent` 首行仍是 `SEP（10 个 ─）`，第二行起是四行文案

- [ ] **Step 1: 改既有用例为「四行」并加新文案断言（RED）**

`src/tests/test-perf.js` 里那条用例：把注释与标题中的「三行」改成「四行」，并在既有三条 `includes` 之后加：

```js
  assertTrue(hud.helpEl.textContent.includes('F：飞行开关'), '飞行开关的键位须出现在操作说明里');
  assertTrue(hud.helpEl.textContent.includes('Space：升') && hud.helpEl.textContent.includes('Shift：降'),
    '飞行中的升降键位须出现在操作说明里');
```

Run: `npx playwright test tests/harness.spec.mjs`
Expected: FAIL（文案里还没有 F 键位）。

- [ ] **Step 2: 加第四行文案**

`src/core/perf-hud.js`：

```js
const HELP_LINES = [
  '操作：a←s↓d→w↑ | Space：跳',
  'F：飞行开关 | 飞行中 Space：升 / Shift：降',
  'Z：背包 | X：生成丧尸 | R：换枪',
  'Ctrl+鼠标左键：点燃TNT，矿车启动',
];
```

- [ ] **Step 3: 跑测试确认 GREEN**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: `failed === 0`，包括「两条横线等长」那条既有断言（`SEP` 没动，仍然通过）。

- [ ] **Step 4: 实测面板不撑宽（Review Focus 5）**

这一步在 Task 4 的 E2E 里落成断言（E5）；本地先人工看一眼也行，但**判定必须以 E5 的 `scrollWidth` 实测为准**，不看观感。

- [ ] **Step 5: lint + commit**

Run: `npm run lint` → 0 error。

```bash
git add src/core/perf-hud.js src/tests/test-perf.js
git commit -m "docs: 性能面板操作说明补飞行键位"
```

---

### Task 4: E2E —— 真游戏页的飞行主路径

**Files:**
- Create: `tests/player-flight.spec.mjs`
- Test: 该文件即测试

**Interfaces:**
- Consumes: `window.__MC_GAME__`（`main.js:74` 暴露），其上有 `player`（→ `player.physics.flying` / `.toggleFlight()` / `.pos`）、`registry`、`editor`；`window.__MC_GAME__.worldReady`
- Produces: E1~E5 五条断言，作为「飞行在主路径上真的可用」的唯一证据

- [ ] **Step 1: 写 E1（起飞）并确认 RED**

创建 `tests/player-flight.spec.mjs`：

```js
// tests/player-flight.spec.mjs — 玩家飞行（spec 2026-10-25-player-flight-design.md §5.2）
//
// 走**真实 keydown 派发 + 真游戏页**，不调测试 API：飞行的落点就是键盘主路径。
// ⚠️ 无头环境无真实键鼠，但 `window.dispatchEvent(new KeyboardEvent(...))` 走的是
// `player.js` 里那条 window 监听器 —— 与真实按键等价（`zombies.spec.mjs` 同手法）。
import { test, expect } from 'playwright/test';

const URL = '/?vd=2&seed=12345';

/** 等世界稳定：worldReady + 队列归零（判据照 `tests/minecarts.spec.mjs` 的同名 helper 精简）。 */
async function boot(page) {
  test.setTimeout(180_000);
  await page.goto(URL);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => {
    const s = window.__MC_GAME__.scheduler.stats();
    return s.meshInflight === 0 && s.meshQueued === 0 && s.uploadQueue === 0;
  }, null, { timeout: 60_000, polling: 300 });
  // 等玩家落定：出生点在城市中心，加载期物理尚未收敛，直接按 F 会量到一段自由落体。
  await page.waitForFunction(() => window.__MC_GAME__.player.physics.onGround === true,
    null, { timeout: 30_000, polling: 100 });
}

const press = (page, code) => page.evaluate((c) =>
  window.dispatchEvent(new KeyboardEvent('keydown', { code: c, bubbles: true })), code);
const release = (page, code) => page.evaluate((c) =>
  window.dispatchEvent(new KeyboardEvent('keyup', { code: c, bubbles: true })), code);

test('E1：F 起飞 + 按住空格爬升，高度确实上升', async ({ page }) => {
  await boot(page);
  const y0 = await page.evaluate(() => window.__MC_GAME__.player.physics.pos.y);
  await press(page, 'KeyF');
  await release(page, 'KeyF');
  const flying = await page.evaluate(() => window.__MC_GAME__.player.physics.flying);
  expect(flying, '按 F 后必须进入飞行态').toBe(true);

  await press(page, 'Space');
  await page.waitForTimeout(2000);
  await release(page, 'Space');
  const after = await page.evaluate(() => ({
    y: window.__MC_GAME__.player.physics.pos.y,
    flying: window.__MC_GAME__.player.physics.flying,
  }));
  expect(after.flying, '爬升期间仍须是飞行态').toBe(true);
  expect(after.y - y0, `2 秒爬升须明显高于起飞点（实测 Δ=${after.y - y0}）`).toBeGreaterThan(5);
});
```

Run: `npx playwright test tests/player-flight.spec.mjs`
Expected: 若 Task 1/2 已落地则 PASS；若此刻 FAIL（例如飞行分支还没接上），把失败信息抄下来 —— 这条是 Task 1/2 在真实页面上的第一道验收。

- [ ] **Step 2: 写 E2~E5**

追加到同一文件：

```js
test('E2：空中再按 F 落回地面', async ({ page }) => {
  await boot(page);
  await press(page, 'KeyF'); await release(page, 'KeyF');
  await press(page, 'Space');
  await page.waitForTimeout(1500);
  await release(page, 'Space');
  // 先确认确实在高处（否则「落回地面」可能只是因为本来就在地面）
  const high = await page.evaluate(() => window.__MC_GAME__.player.physics.pos.y);
  await press(page, 'KeyF'); await release(page, 'KeyF');
  await page.waitForFunction(() => window.__MC_GAME__.player.physics.onGround === true,
    null, { timeout: 30_000, polling: 100 });
  const st = await page.evaluate(() => ({
    flying: window.__MC_GAME__.player.physics.flying,
    y: window.__MC_GAME__.player.physics.pos.y,
  }));
  expect(st.flying, '再次按 F 退出飞行').toBe(false);
  expect(st.y, `须已落回地面（高空 ${high} → ${st.y}）`).toBeLessThan(high - 3);
});

test('E3：按住 Shift 降到地面后自动退出飞行（Java 口径）', async ({ page }) => {
  await boot(page);
  await press(page, 'KeyF'); await release(page, 'KeyF');
  await press(page, 'Space');
  await page.waitForTimeout(1500);
  await release(page, 'Space');
  const y0 = await page.evaluate(() => window.__MC_GAME__.player.physics.pos.y);
  await press(page, 'ShiftLeft');
  await page.waitForFunction(() => window.__MC_GAME__.player.physics.onGround === true,
    null, { timeout: 30_000, polling: 100 });
  const st = await page.evaluate(() => ({
    flying: window.__MC_GAME__.player.physics.flying,
    onGround: window.__MC_GAME__.player.physics.onGround,
    y: window.__MC_GAME__.player.physics.pos.y,
  }));
  await release(page, 'ShiftLeft');
  expect(st.flying, '下降触地必须自动退出飞行').toBe(false);
  expect(st.onGround).toBe(true);
  expect(st.y, `须降到地面以下（起飞高度 ${y0}）`).toBeLessThan(y0 - 3);
});

test('E4：飞行水平速度约为走路的 2 倍', async ({ page }) => {
  await boot(page);
  // 固定 yaw：前进沿 +X（与 `test-player-input.js` 的 stepDelta 同口径）
  const walk = await page.evaluate(async () => {
    const g = window.__MC_GAME__; const pl = g.player;
    pl.yaw = -Math.PI / 2;
    const x0 = pl.physics.pos.x;
    pl.keys.add('KeyW');
    await new Promise((r) => setTimeout(r, 600));
    pl.keys.delete('KeyW');
    return pl.physics.pos.x - x0;
  });
  // 起飞并**用空格真爬升**到高处再量（不假 teleport —— 直接改 pos.y 可能把玩家塞进建筑/巨树里，
  // 那会让这一条因错误原因失败）。云不是水平阻碍（M2-7），高空直飞是安全路径。
  const fly = await page.evaluate(async () => {
    const g = window.__MC_GAME__; const pl = g.player;
    pl.physics.toggleFlight();
    pl.keys.add('Space');
    await new Promise((r) => setTimeout(r, 2500));
    pl.keys.delete('Space');
    pl.yaw = -Math.PI / 2;
    const x0 = pl.physics.pos.x;
    pl.keys.add('KeyW');
    await new Promise((r) => setTimeout(r, 600));
    pl.keys.delete('KeyW');
    const dx = pl.physics.pos.x - x0;
    pl.physics.toggleFlight();
    return dx;
  });
  expect(walk, `前提：走路须真的前进，实测 ${walk}`).toBeGreaterThan(1);
  // 前提：飞行那一段没有被地形挡住（被挡就是误测，不是速度错 —— 先查这个再查公式）
  expect(fly, `前提：飞行须真的前进（未被建筑阻挡），实测 ${fly}`).toBeGreaterThan(walk * 1.4);
  const ratio = fly / walk;
  expect(ratio, `飞行/走路速度比须 ≈2（实测 ${ratio}，walk=${walk} fly=${fly}）`)
    .toBeGreaterThan(1.7);
  expect(ratio, `飞行/走路速度比须 ≈2（实测 ${ratio}）`).toBeLessThan(2.3);
});

test('E5：操作说明加飞行键位后不撑宽面板（Review Focus 5）', async ({ page }) => {
  await boot(page);
  const m = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const help = g._hud.helpEl;
    const el = g._hud.el;
    return {
      panelWidth: el.getBoundingClientRect().width,
      clientWidth: help.clientWidth,
      scrollWidth: help.scrollWidth,
      hasFlight: help.textContent.includes('F：飞行开关'),
    };
  });
  expect(m.hasFlight, '操作说明须含飞行键位').toBe(true);
  expect(m.panelWidth, '面板宽度必须仍是 330（v1.80 用户裁定）').toBeCloseTo(330, 0);
  expect(m.scrollWidth, `操作说明不得横向溢出（scrollWidth ${m.scrollWidth} > clientWidth ${m.clientWidth} 即裁切）`)
    .toBeLessThanOrEqual(m.clientWidth);
});
```

- [ ] **Step 3: 跑整个 spec**

Run: `npx playwright test tests/player-flight.spec.mjs`
Expected: 5 passed。若 E4 的比值落在区间外，**先读实测值再判断**：区间 1.7~2.3 是按 60Hz 定步长 + 定时器抖动留的余量；实测若稳定偏离（例如 1.5），说明实现里还有一条速度来源没算对，要修实现而不是放宽区间。

- [ ] **Step 4: 负向验证 E 系列真 FAIL**

| 注入 | 期望 FAIL |
|---|---|
| 把 `player.js` 的 F 分支整段注释掉 | E1（`按 F 后必须进入飞行态`） |
| 把 `_stepFlying` 的落地退出整段注释掉 | E3 |
| 把 `FLY_SPEED_MULT` 改成 1 | E4 |
| 删掉 `HELP_LINES` 的飞行那行 | E5（两条断言都会红） |

同样用 `cp` 副本还原 + `diff` 核对。

- [ ] **Step 5: commit**

```bash
git add tests/player-flight.spec.mjs
git commit -m "test: 玩家飞行 E2E（起飞/空中取消/落地退出/速度比/面板不撑宽）"
```

---

### Task 5: 文档同步（设计文档 / roadmap / CLAUDE.md）

**Files:**
- Modify: `docs/phase-1-engine-design.md`（首行版本号 + 修订说明块首部；§4.5.1「物理」段追加飞行小节）
- Modify: `docs/roadmap.md`（「M3.2 之后的独立 bugfix / 改造」表末尾追加一行）
- Modify: `CLAUDE.md`（「活跃约束」新增一段飞行）

**Interfaces:**
- Consumes: Task 1~4 的最终常量值与实测数据
- Produces: 三处文档与代码口径一致

- [ ] **Step 1: 设计文档 §4.5.1 追加飞行小节**

在 §4.5.1「物理」两条 bullet 之后追加（**只写口径，不复制实现**）：

```markdown
**飞行（创造模式，2026-10-25）**
- 状态唯一权威 = `PlayerPhysics.flying`（`src/player/physics.js`）；`Player` 不复制一份。
- 键位（**有意偏离原版**）：`F` 单击切换（原版是双击空格 —— 那需要 350ms 时间窗，且第一次按空格会先跳，
  与本仓空间键上的「矿车下车边沿检测」争夺同一键位）；空格升、Shift 降、WASD/方向键水平移动。
- 速度：水平 = `SPEED × FLY_SPEED_MULT`（= 16 格/秒，用户裁定的「走路 2 倍」；原版是 2.5×，
  但本仓 `SPEED = 8` 已是原版疾跑的 1.43 倍）；垂直恒 `FLY_VERTICAL_SPEED`（8 格/秒，**标定初值**）。
  **不设疾跑加速档**（用户裁定）。
- 落地退出（Java 口径）：`_stepFlying` 每步先清 `onGround` 再移动，向下触地即 `flying = false`；
  顶到天花板不退出。
- 与既有系统的耦合：飞行中 `onGround` 恒 false → `player.js` 既有的 `jumping: !onGround` 判据
  自动让跑动晃动为 0（**不新增判据**）；乘坐矿车期间物理步整段跳过 → F 键在乘坐期忽略（偏离原版
  「进矿车不解除飞行」，理由是避免状态分裂）；飞行状态不持久化、不进进度包。
```

- [ ] **Step 2: 设计文档版本号与修订说明**

版本号取 **v1.81**：roadmap 与 CLAUDE.md 的特性版本已排到 **v1.80**（v1.79 = 面板折叠、v1.80 = 固定宽度 +
操作说明 + 方向键），设计文档首行停在 v1.78（那两项纯 UI 没进设计文档）。**不要用 v1.79** ——
它会与已落地的面板折叠特性撞号，而撞号在本仓已经发生过三次。

把首行的 `版本：v1.78` 改为 `版本：v1.81`，并在修订说明块首部（`> v1.78 修订说明：…` 之前）插入：

```markdown
> v1.81 修订说明：**新增玩家飞行（创造模式口径）**（2026-10-25，§4.5.1）。
> 用户要求「实现玩家会飞的能力，参照我的世界原版」。键位经用户裁定为 `F` 单击切换（原版双击空格
> 需要 350ms 时间窗，且与本仓空格键上的矿车下车边沿检测争键位）；水平速度按「走路 2 倍」取 16 格/秒、
> 垂直 8 格/秒、不设疾跑加速档（均为用户裁定）。落地退出取 **Java 口径**（触地即退出，Bedrock 不是）。
> 状态唯一权威在 `PlayerPhysics.flying`，`Player` 只做按键边沿与垂直输入分流。
```

- [ ] **Step 3: roadmap 版本表追加一行**

在 `docs/roadmap.md` 的「M3.2 之后的独立 bugfix / 改造」表末尾（v1.80 行之后）追加（版本号 = v1.81，
与 Task 5 Step 2 的设计文档版本一致）：

```markdown
| v1.81 | 玩家飞行（创造模式口径：F 切换 / Space 升 / Shift 降 / 落地退出） | ✅ 已完成 | 用户要求「实现玩家会飞的能力，参照我的世界原版」。**键位是用户裁定**：原版双击空格需 350ms 时间窗 + 首按会先跳，与本仓空格键上的矿车下车边沿检测争键位 → 改 `F` 单击（`!e.repeat`）。**速度也是裁定**：水平 = `SPEED × 2`（16 格/秒，不照抄原版 2.5×/10.92 —— 本仓 `SPEED=8` 已是原版疾跑的 1.43 倍）、垂直 8 格/秒（初值，待实玩标定）、**无疾跑加速档**。落地退出取 Java 口径（向下触地即退出）；顶到天花板不退出。**耦合点**：飞行中 `onGround` 恒 false → 既有 `jumping: !onGround` 判据让晃动自动为 0（不新增判据）；乘坐矿车期间物理步被跳过 → F 键在乘坐期忽略（有意偏离原版「进矿车不解除飞行」）。单测 15 条（8 物理 + 7 输入）+ E2E 5 条（起飞/空中取消/落地退出/速度比/面板不撑宽）。 |
```

- [ ] **Step 4: CLAUDE.md 增补活跃约束**

在「活跃约束」列表末尾（背景音乐段之后）追加：

```markdown
- **飞行状态唯一权威 = `PlayerPhysics.flying`（2026-10-25）**，`Player` 不复制一份 —— 重力/积分/
  碰撞/step-up 都在 physics 层，放 Player 就会被迫在物理层重复判定（红线 1）。常量 `FLY_SPEED_MULT`
  （=2，用户裁定的「走路 2 倍」）与 `FLY_VERTICAL_SPEED`（=8，**标定初值不是推导值**）也在这一个文件里
  并 export，测试读同一份。**改 `SPEED` 时要连带重算 `view-bob.js` 的 `phasePerBlock`**（既有约束），
  而改 `FLY_SPEED_MULT` 不影响晃动 —— 飞行中根本不进晃动分支。
- **`_stepFlying` 里 `onGround = false` 必须在 `_moveAxis` 之前，且落地判据就是随后的 `onGround`**：
  `onGround` 只由向下碰撞置 true，故「清零 → 移动 → 判」等价于「本步向下且触地」。**删掉那行清零**的
  形态是「按 F 在地面悬停一帧就掉回地面」（上一步的 `true` 被带进来），而它同时是「飞行时不晃」的
  判据来源（`player.js` 传 `jumping: !onGround`）—— 两个用途共用这一行，不要单开第二份判据。
- **飞行键位**：`F` 单击（`!e.repeat`，不 preventDefault，乘坐矿车期间忽略）；升降 = 空格 / 左右 Shift
  （同按取差 = 悬停）。Shift 在飞行中是下降键，但 `shiftKey + 左键` 仍是矿车后退 —— 两者不同通道
  （`keys` 集合 vs 鼠标事件修饰键），**不要为「消除冲突」给 `digBlock` 加飞行门控**。
- **面板文案改动必须实测不撑宽**：`PANEL_WIDTH_PX = 330` 是对着实测峰值标定的定值，新文案要跑
  `tests/player-flight.spec.mjs` 的 E5（`scrollWidth ≤ clientWidth` 且面板宽仍 330），不得改常量迁就。
```

- [ ] **Step 5: 跑整套相关门禁**

Run: `npm run check && npx playwright test tests/harness.spec.mjs tests/player-flight.spec.mjs tests/minecarts.spec.mjs`
Expected: 全绿（`check` = arch + data + lint；三个 spec 覆盖单测全量、飞行 E2E、矿车交互不被误伤）。

- [ ] **Step 6: commit**

```bash
git add docs/phase-1-engine-design.md docs/roadmap.md CLAUDE.md
git commit -m "docs: 玩家飞行口径（设计文档 v1.81 / roadmap / CLAUDE.md 活跃约束）"
```

---

## 自检结果（写完计划后逐项过了一遍）

**1. Spec coverage** —— spec 每一节都有任务：
| Spec 章节 | 任务 |
|---|---|
| §4.1 状态归属 | Task 1 Step 3 |
| §4.2 常量 | Task 1 Step 3 |
| §4.3 行为改动（含四条约定） | Task 1 Step 3/6 |
| §4.4 输入绑定 | Task 2 Step 3/4 |
| §4.5.1 矿车 | Task 2 Step 1（K7）/ Step 6（N7） |
| §4.5.2 挖块放置不受影响 | Task 2 Step 7 |
| §4.5.3 晃动自动为 0 | Task 1 Step 5（P4 里断言 `onGround === false`） |
| §4.5.4 面板文案（含宽度实测） | Task 3 + Task 4 Step 3（E5） |
| §4.6 未采纳方案 | 不需实现 |
| §5.1 单测 P1~P8 / K1~K7 | Task 1 Step 1/5、Task 2 Step 1 |
| §5.2 E2E E1~E5 | Task 4 |
| §5.3 负向验证 N1~N7 | Task 1 Step 8、Task 2 Step 6、Task 4 Step 4 |
| §6 风险（垂直速度待标定） | Task 5 Step 1 文档记「标定初值」 |
| §7 影响面 9 个文件 | Task 1~5 全覆盖 |

**2. Step scan** —— 每个实现步骤都给了签名/常量值/关键行位置；没有「加适当的错误处理」这类空步骤。Step 4（Task 3）唯一不给指令，是因为判定落在 H1 上。

**3. Type consistency** —— `flying: boolean`、`toggleFlight(): void`、`moveVertical(dir: number): void`、`FLY_SPEED_MULT`、`FLY_VERTICAL_SPEED` 在 Task 1 定义、Task 2/4/5 引用，名字一致。`_stepFlying` 只在 Task 1 内部与文档里出现。

**4. Review Focus** —— 五条都已绑定：① P1 的 `toggleFlight` 清零断言；② P4 + N2；③ Task 2 Step 7 跑矿车 spec；④ K7 + N7；⑤ E5。
**5. Proportion** —— 计划约 400 行，其中代码块是测试体与两段载荷性注释（`_stepFlying` 的 `onGround` 约定、`toggleFlight` 的清零理由），不是实现的逐行誊写。

**Spec 修正（写计划时发现并已回改 spec）**：spec §4.3 原稿用了 `wasDown` 门控落地退出，但同时要求每步清 `onGround` —— 清零后 `wasDown` 恒真，是死分支，且会让 N2「去掉 `wasDown`」这条负向验证无法真 FAIL。已改为「清零 → 移动 → 判 `onGround`」，并把 N2 换成「删掉那行清零」。
