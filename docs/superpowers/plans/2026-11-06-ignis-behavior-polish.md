# 焰魔行为优化（v2.62）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task（用户已选 Native/inline 执行）。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给焰魔（Ignis）落地八项行为优化：转向延迟、减速、台阶缓动、防卡死、卡住飞跃脱困、跳跃劈砍、阻挡玩家（不动如山）、绕行面向前进方向。

**Architecture:** 全部行为在 `IgnisBossAgent.update()`（同构层，无 three/DOM）与 `IgnisRenderer`（渲染层 StepLift）内实现；玩家阻挡经 `PlayerPhysics` 注入 `IgnisService`（与 `minecarts` 同手法）。新增一个 `leap` 模式承载两种飞跃（escape/attack），共用抛物线物理。不烘焙、不新增美术资源。

**Tech Stack:** 原生 ES module（浏览器 + Node 同构）、three r185.1（仅渲染层）、Playwright（E2E）、仓库自带浏览器内单测 runner（`src/tests/`）。

**Spec:** `docs/superpowers/specs/2026-11-06-ignis-behavior-polish-design.md`

## Global Constraints

- 同构层（`src/entities/**`）**不得 import three、不得 import `player/`、不得自建 Worker**（`npm run check:arch` 静态门）。渲染层 `src/render/**` 可 import three。
- **红线 1（单一权威）**：碰撞判据只用 `aabbCollidesAt`；台阶落点只用 `zombieStepUpY`；StepLift 衰减参数不写第二份（复用 `player/step-lift.js`）；玩家尺寸权威在 `physics.js`、焰魔盒权威在 `ignis-system.js`，两侧不互相复制对方的量。
- **Agent 契约**：`update(state, dt, ctx)` 只读 state 与 ctx，返回**全新 plain 对象 + 全新数组**，不得原地改写（M5 跨 column 索引迁移不变式）。新增 state 字段必须经 `createState` 保留（同 `_physAccum` 的载荷性警告）。
- **时间基准 `performance.now()`**，禁止 `Date.now()`。坐标判据用非负取模。
- 测试分级（`docs/testing-policy.md`）：AI 热路径 = **Tier 1 必须 TDD**；渲染结果 = **Tier 4 实测**（不得宣称目视）。像素/距离断言**同时钉上下界**。
- 浏览器内单测文件 `src/tests/test-*.js` 必须已在 `src/tests/index.html` 注册（本计划只改既有文件，不新增，故无需改注册）。
- **提交纪律**：用户明确要求「完成后先不要自动提交，等验收」。故本计划每个 Task 末尾的 commit 步骤**改为「暂存但不提交」**——用 `git add <files>` 暂存，**不执行 `git commit`**，等用户验收后统一提交。ledger 记录暂存的文件清单。

## 浏览器内单测的快速 RED/GREEN 回路（每个 Task 的 Step 2/4 都用它）

`tests/harness.spec.mjs` 跑全量（实测 ~64s），不适合逐步 TDD。用**一次性探针**（`tests/tmp-*` 已 gitignore，勿提交）：

1. 建 `tests/tmp-ignis-probe.html`（仓库根下，与 `src/tests/index.html` 同构）：拷 `src/tests/index.html` 的 import map（路径改 `../vendor/...`），`<script type="module">` 里只 `import { runAndExpose } from '../src/tests/runner.js';` + 本 Task 要测的那一两个 `import '../src/tests/test-ignis-*.js';`，末尾 `runAndExpose()`。
2. 建 `tests/tmp-ignis-probe.spec.mjs`：`page.goto('/tests/tmp-ignis-probe.html')` → `waitForFunction(() => window.__MC_TEST_RESULTS__ !== undefined)` → 把 `suites.flatMap(s=>s.tests)` 里 `status==='failed'` 的 `{name,error}` 打印出来并 `expect(failed).toBe(0)`。
3. 跑：`npx playwright test tests/tmp-ignis-probe.spec.mjs`（自带 webServer，端口 8081 已有服务则复用）。

⚠️ 探针文件用完即删（`rm` 字面路径，不用通配符——memory `tmp-cleanup-must-not-glob`）。Task 11 的全量回归仍走 `tests/harness.spec.mjs`。

## Review Focus

spec 暗示但单测未必覆盖、最可能咬人的输入/失败模式（每条都在 owning task 补了测试）：

1. **首帧 / dt=0 时玩家速度差分** → 不得产生 NaN 传进飞跃预判（Task 8 钉 dt=0 给 `[0,0,0]`）。
2. **跳跃劈砍滞空中玩家急转/跳开** → 落点预判偏差大时不得 NaN、不得穿地，落地兜底仍进 attack（Task 6 钉移动玩家落点 + 落地兜底）。
3. **被埋深于 `stuckResolveMaxRaise`（16 格）** → 不得静默抬到半路（仍在实心里却以为解了），应放弃并原地不动（Task 4 钉超深不抬）。
4. **焰魔消失后重新召唤 / 实例复用** → StepLift 的 `prevY` 不得把「出生」当成一次上台阶缓动（Task 9 钉首帧 prevY=null 不触发）。
5. **玩家传送恰好落进焰魔身体盒** → `resolveStuck` 走 `collidesAt`（只查方块）不感知焰魔，玩家需等焰魔走开（spec §2.7 已接受，Task 7 注释记录，不加测试）。

---

### Task 1: config 常量 + state 新字段（地基）

**Files:**
- Modify: `src/entities/ignis/ignis-config.js`（`IGNIS_AI` 改 `chaseSpeed` + 新增常量；新增 `IGNIS_STEP_LIFT`）
- Modify: `src/entities/ignis/ignis-system.js`（`createState` 新字段 + `MODES` 加 `'leap'`）
- Modify: `src/tests/test-ignis-system.js`（`chaseSpeed` 冻结断言 6.6→4.4；新字段保留用例）

**Interfaces:**
- Produces: `IGNIS_AI.{chaseSpeed:4.4, turnDelay:1.5, stuckLeapSeconds:4.0, stuckProgressRatio:0.15, stuckResolveMaxRaise:16, leapJumpForce:11, leapSpeed:8, leapMaxSeconds:3.0, leapAttackMin:8, leapAttackMax:14, leapAttackAirtime:0.9, leapAttackCooldown:8.0, leapSlashLead:0.5}`；`IGNIS_STEP_LIFT.epsilon:1e-4`；state 字段 `acquireT, stuckT, leapKind, leapDir, leapT, leapTargetY, leapAttackCooldown`；`MODES` 含 `'leap'`。

- [ ] **Step 1: 写失败测试**（`test-ignis-system.js`）

改既有冻结断言：`assertEqual(IGNIS_AI.chaseSpeed, 4.4);`（注释标「用户裁定 2026-11-06：降 1/3，作者原值 6.6」）。新增一条用例钉新字段经 `createState` 保留：

```js
test('焰魔: createState 保留全部行为新字段（同 _physAccum 的载荷性）', () => {
  const s = ignisDefinition.create({
    position: [0, 10, 0], acquireT: 1.2, stuckT: 3.4, leapKind: 'attack',
    leapDir: [1, 2], leapT: 0.5, leapTargetY: 9, leapAttackCooldown: 7,
  });
  assertEqual(s.acquireT, 1.2); assertEqual(s.stuckT, 3.4);
  assertEqual(s.leapKind, 'attack'); assertEqual(s.leapDir[0], 1);
  assertEqual(s.leapT, 0.5); assertEqual(s.leapTargetY, 9);
  assertEqual(s.leapAttackCooldown, 7);
});
test('焰魔: 新常量数值不变式', () => {
  assertTrue(IGNIS_AI.leapAttackMin > IGNIS_AI.attackRange, '跳劈窗下界须在原地起手距离外');
  assertTrue(IGNIS_AI.leapAttackMax <= IGNIS_AI.sightRange);
  assertTrue(IGNIS_AI.standoffRange - IGNIS_AI.standoffDeadband / 2 < IGNIS_AI.hitRange, '跳完须砍得到');
});
```

- [ ] **Step 2: 跑测试确认失败** — `npx playwright test` 不适用（这是浏览器内单测）。用 `npm start` 起服务后访问 `/src/tests/index.html` 读 `window.__MC_TEST_RESULTS__`，或跑既有驱动脚本。Expected: FAIL（`chaseSpeed` 仍 6.6；新字段 undefined）。

- [ ] **Step 3: 改 config** — `IGNIS_AI.chaseSpeed` 6.6→4.4（保留作者原值注释）；追加 §3.2 全部新常量（每个带来源注释：用户裁定 / 本仓标定）；文件末尾新增 `export const IGNIS_STEP_LIFT = Object.freeze({ epsilon: 1e-4 });`（注释说明与丧尸 `ZOMBIE_STEP_LIFT.epsilon` 同值同标定依据）。

- [ ] **Step 4: 改 createState** — `MODES` 加 `'leap'`；解构参数与返回对象各加 7 个新字段，缺省：`acquireT:0, stuckT:0, leapKind:null, leapDir:null, leapT:0, leapTargetY:null, leapAttackCooldown:0`。`leapKind` 校验 `=== 'escape' || 'attack'` 否则 null；`leapDir` 校验「长度 2 且有限」否则 null（同 `navDir` 手法）；`leapTargetY` 校验有限否则 null。

- [ ] **Step 5: 跑测试确认通过** — Expected: PASS。

- [ ] **Step 6: 暂存（不提交）** — `git add src/entities/ignis/ignis-config.js src/entities/ignis/ignis-system.js src/tests/test-ignis-system.js`

---

### Task 2: ① 转向延迟（idle 不追踪 + acquireT 门控）

**Files:**
- Modify: `src/entities/bosses/ignis-boss-agent.js`（idle 分支删 yaw 追踪；idle→chase 加 acquireT 门控）
- Test: `src/tests/test-ignis-boss-agent.js`

**Interfaces:**
- Consumes: `IGNIS_AI.turnDelay`、state `acquireT`（Task 1）。
- Produces: `update` 返回含 `acquireT`；idle→chase 需累计满 `turnDelay`。

- [ ] **Step 1: 写失败测试**

```js
test('焰魔 AI: idle 不追踪 yaw（玩家绕其移动，朝向逐位不变）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  let s = st({ mode: 'idle', yaw: 0.7 });
  for (let i = 0; i < 30; i++) {
    const ang = i / 30 * Math.PI * 2;
    s = a.update(s, 1 / 60, { ...OPEN_CTX, player: { position: [Math.sin(ang)*3, 10, Math.cos(ang)*3] } });
  }
  assertEqual(s.yaw, 0.7, 'idle 应保持最后朝向，不炮塔式追踪');
});
test('焰魔 AI: idle→chase 需 turnDelay 累计（中途离开清零）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const ctx = { ...OPEN_CTX, player: playerAt(20) };
  let s = st({ mode: 'idle' });
  const frames = Math.ceil(IGNIS_AI.turnDelay * 60);
  for (let i = 0; i < frames - 5; i++) s = a.update(s, 1/60, ctx);
  assertEqual(s.mode, 'idle', '未满 turnDelay 不应转 chase');
  // 离开一次 → 清零
  s = a.update(s, 1/60, { ...OPEN_CTX, player: playerAt(IGNIS_AI.sightRange + 10) });
  for (let i = 0; i < frames - 5; i++) s = a.update(s, 1/60, ctx);
  assertEqual(s.mode, 'idle', '离开后重新累计，不应立即 chase');
  for (let i = 0; i < 10; i++) s = a.update(s, 1/60, ctx);
  assertEqual(s.mode, 'chase', '累计满 turnDelay 后应 chase');
});
```

- [ ] **Step 2: 跑测试确认失败** — Expected: FAIL（idle 仍追踪 yaw；无 acquireT 门控立即 chase）。

- [ ] **Step 3: 实现** — 在 `update` 顶部 locals 加 `let acquireT = Number.isFinite(state.acquireT) ? state.acquireT : 0;`。idle 转移分支改为：玩家在 `sightRange` 内 → `acquireT += step`，满 `turnDelay` 才 `mode='chase'` 并 `acquireT=0`；玩家不在范围 → `acquireT=0`。**删除** idle 分支末尾的 `yaw = this._steerYaw(...)`（待机不转向）。返回对象加 `acquireT`。

- [ ] **Step 4: 跑测试确认通过** — Expected: PASS。⚠️ 同时确认既有用例「玩家在 sightRange 内且视线通 → chase」仍绿——它用 `dt=0.1` 单帧，acquireT 只累 0.1 < 1.5 ⇒ **会红**。改写该用例：循环喂满 `turnDelay` 再断言 chase（或直接 `st({acquireT: IGNIS_AI.turnDelay})` 起步）。ledger 记这条改写。

- [ ] **Step 5: 暂存（不提交）** — `git add src/entities/bosses/ignis-boss-agent.js src/tests/test-ignis-boss-agent.js`

---

### Task 3: ⑧ 绕行面向前进方向（yaw 移到最终意图之后）

**Files:**
- Modify: `src/entities/bosses/ignis-boss-agent.js`
- Test: `src/tests/test-ignis-boss-agent.js`

**Interfaces:**
- Consumes: 最终 `wantVx/wantVz`（站定环 → 局部绕行 → navDir 覆盖 之后）。
- Produces: chase 中 yaw 目标 = 有水平意图时面向速度方向 `atan2(-wantVx,-wantVz)`，无意图（死区）时面向玩家。

- [ ] **Step 1: 写失败测试**

```js
test('焰魔 AI: 绕行（navDir 侧向）时面向前进方向而非玩家', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = wallWorld({ groundY: 9, wallZ: -14, halfLen: 6, wallH: 4 });
  // 玩家在墙后正北；navDir 给一个纯侧向（+X）方向
  let s = st({ position: [0.5, 10, 0], mode: 'chase', onGround: true, navDir: [1, 0], needsPath: true });
  for (let i = 0; i < 60; i++) s = a.update(s, 1/60, { world: w, registry: REGISTRY, player: playerAt(20) });
  // 面向 +X ⇒ yaw ≈ -π/2；面向玩家（-Z）⇒ yaw ≈ 0。两者差 > 45°
  const facePlayer = Math.abs(s.yaw) < 0.3;
  assertTrue(!facePlayer, `绕行时仍面向玩家（yaw=${s.yaw.toFixed(2)}），应面向前进方向`);
});
test('焰魔 AI: 死区站定时面向玩家', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  let s = st({ position: [0.5, 10, 0], mode: 'chase', onGround: true, yaw: 1.0 });
  const player = { position: [0.5, 10, -4.6] };  // 死区内（4.25~5.0）
  for (let i = 0; i < 90; i++) s = a.update(s, 1/60, { world: groundWorld(9), registry: REGISTRY, player });
  assertTrue(Math.abs(s.yaw) < 0.2, `死区站定应面向玩家（yaw=${s.yaw.toFixed(2)}）`);
});
```

- [ ] **Step 2: 跑测试确认失败** — Expected: FAIL（现状 chase 开头就面向玩家）。

- [ ] **Step 3: 实现** — 删除 chase 分支开头的 `yaw = this._steerYaw(yaw, this._angleTo(...))`。在 navDir 覆盖块**之后**、物理之前，统一算 yaw：
  - `mode === 'attack'` → 不改 yaw（锁朝向）；
  - 否则若 `wantVx!==0 || wantVz!==0` → `yaw = this._steerYaw(yaw, Math.atan2(-wantVx, -wantVz), step)`；
  - 否则（死区/idle 站定）→ 若 `player && losVisible` 则 `yaw = this._steerYaw(yaw, this._angleTo([px,py,pz], player), step)`。
  - ⚠️ idle 不追踪（Task 2 已删），此处 idle 无意图也**不**转向玩家——保持 Task 2 语义。故「面向玩家」分支只在 `mode==='chase'` 死区时生效。

- [ ] **Step 4: 跑测试确认通过** — Expected: PASS。⚠️ 既有用例「追击时 yaw 朝玩家平滑转动」玩家在 +X 30 格、焰魔从 z=0 走向玩家 ⇒ 意图朝 +X ⇒ yaw 仍趋向 -π/2，断言 `s.yaw < -0.3` 仍成立。确认绿。

- [ ] **Step 5: 暂存（不提交）** — `git add src/entities/bosses/ignis-boss-agent.js src/tests/test-ignis-boss-agent.js`

---

### Task 4: ④ 穿模自解卡（_resolveStuck）

**Files:**
- Modify: `src/entities/bosses/ignis-boss-agent.js`
- Test: `src/tests/test-ignis-boss-agent.js`

**Interfaces:**
- Consumes: `IGNIS_AI.stuckResolveMaxRaise`、`aabbCollidesAt`（经 `this._collides`）。
- Produces: `update` 顶部若被埋则抬到首个可站整数 y、`vy=0`；未埋时位置逐位不变。

- [ ] **Step 1: 写失败测试**

```js
test('焰魔 AI: 被埋进方块 → 向上解卡到首个可站 y', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  // y<=12 全实心（焰魔脚底 y=10 被埋），y=13 起空气
  const w = makeWorld((_x, y, _z) => y <= 12);
  let s = st({ position: [0.5, 10, 0.5], mode: 'chase', onGround: false });
  s = a.update(s, 1/60, { world: w, registry: REGISTRY, player: playerAt(20) });
  assertTrue(s.position[1] >= 13, `应抬到 y>=13，实际 ${s.position[1]}`);
  assertEqual(s.velocity[1], 0, '解卡后 vy 清零');
});
test('焰魔 AI: 未被埋时位置逐位不变（解卡零副作用）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = groundWorld(9);
  let s = st({ position: [0.5, 10, 0.5], mode: 'idle', onGround: true });
  const before = s.position.slice();
  s = a.update(s, 1/60, { world: w, registry: REGISTRY, player: null });
  assertEqual(s.position[1], before[1], '未埋不应改 y');
});
test('焰魔 AI: 埋深于 stuckResolveMaxRaise → 放弃不抬（不静默抬半路）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = makeWorld((_x, y, _z) => y <= 10 + IGNIS_AI.stuckResolveMaxRaise + 5);
  let s = st({ position: [0.5, 10, 0.5], mode: 'chase' });
  s = a.update(s, 1/60, { world: w, registry: REGISTRY, player: playerAt(20) });
  assertEqual(s.position[1], 10, '超深应原地不动');
});
```

- [ ] **Step 2: 跑测试确认失败** — Expected: FAIL（无 _resolveStuck，被埋仍卡 y=10）。

- [ ] **Step 3: 实现** — 新增方法 `_resolveStuck(world, px, py, pz)`：若 `!this._collides(world,px,py,pz)` 返回 `null`（常态零副作用）；否则从 `Math.ceil(py)` 起 `for dy in 0..stuckResolveMaxRaise`，第一个 `!this._collides(world,px,base+dy,pz)` 的 `base+dy` 即落点，返回它；扫到上限仍埋返回 `null`。在 `update` 读出 px/py/pz 后、移动意图前调用：`const raised = world ? this._resolveStuck(world,px,py,pz) : null; if (raised !== null) { py = raised; vy = 0; }`。

- [ ] **Step 4: 跑测试确认通过** — Expected: PASS。

- [ ] **Step 5: 暂存（不提交）** — `git add src/entities/bosses/ignis-boss-agent.js src/tests/test-ignis-boss-agent.js`

---

### Task 5: ⑤ 卡住 4 秒 → 飞跃脱困（leap/escape）

**Files:**
- Modify: `src/entities/bosses/ignis-boss-agent.js`（stuckT 计时 + leap 模式 + escape 触发/空中/落地）
- Test: `src/tests/test-ignis-boss-agent.js`

**Interfaces:**
- Consumes: `IGNIS_AI.{stuckLeapSeconds, stuckProgressRatio, leapJumpForce, leapSpeed, leapMaxSeconds, standoffRange, standoffDeadband}`、state `stuckT/leapKind/leapDir/leapT`、`MODES` 含 `'leap'`。
- Produces: `mode==='leap' && leapKind==='escape'`；leap 期水平意图 = `leapDir`（常量），落地回 chase。

- [ ] **Step 1: 写失败测试**

```js
// ⚠️ 围死世界：中心 (0.5,·,0.5) 占格 {0,1}²，墙在 x=-1/2、z=-1/2（留 1 格余量，
// 避免出生即重叠触发 _resolveStuck 而非测 stuckT——见 ledger 预检 Ruling）。
function sealedBoxWorld() {
  return makeWorld((x,y,z) => {
    if (y <= 9) return true;                                  // 地面
    if (y > 12) return false;                                 // 顶开口（跳得出）
    return x <= -1 || x >= 2 || z <= -1 || z >= 2;            // 四面墙
  });
}
test('焰魔 AI: 有意图无进展 → stuckT 累加', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = sealedBoxWorld();
  let s = st({ position: [0.5,10,0.5], mode:'chase', onGround:true });
  // 先跑 2 秒让它撞墙（前几帧可能还在走），再读 stuckT
  for (let i=0;i<120;i++) s = a.update(s,1/60,{world:w,registry:REGISTRY,player:playerAt(20)});
  assertTrue(s.stuckT > 1.0, `围死 2 秒后 stuckT=${s.stuckT}（应按 pre-steering 意图累计）`);
});
test('焰魔 AI: stuckT 满 4s → leap(escape)，给上跳 + 朝意图方向水平速', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = sealedBoxWorld();
  let s = st({ position:[0.5,10,0.5], mode:'chase', onGround:true, stuckT: IGNIS_AI.stuckLeapSeconds });
  s = a.update(s,1/60,{world:w,registry:REGISTRY,player:playerAt(20)});
  assertEqual(s.mode, 'leap'); assertEqual(s.leapKind, 'escape');
  assertTrue(s.velocity[1] > 0 || s.leapDir !== null, '应起跳');
});
test('焰魔 AI: leap(escape) 落地回 chase、stuckT 清零', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = groundWorld(9);
  let s = st({ position:[0.5,12,0.5], mode:'leap', leapKind:'escape', leapDir:[0,-IGNIS_AI.leapSpeed], onGround:false, stuckT:2 });
  for (let i=0;i<120 && s.mode==='leap';i++) s = a.update(s,1/60,{world:w,registry:REGISTRY,player:playerAt(20)});
  assertEqual(s.mode, 'chase'); assertEqual(s.stuckT, 0);
});
test('焰魔 AI: leap 期与玩家过近 → 本步水平意图清零（不穿过玩家）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = groundWorld(9);
  const player = { position:[0.5,10,-2] };  // 距 < inner(4.25)
  let s = st({ position:[0.5,11,0.5], mode:'leap', leapKind:'escape', leapDir:[0,-IGNIS_AI.leapSpeed], onGround:false });
  const s2 = a.update(s,1/60,{world:w,registry:REGISTRY,player});
  // 水平不应朝玩家推进（z 不减小）
  assertTrue(s2.position[2] >= s.position[2] - 1e-6, 'leap 期不应穿进玩家');
});
```

- [ ] **Step 2: 跑测试确认失败** — Expected: FAIL（无 stuckT/leap）。

- [ ] **Step 3: 实现** —
  - locals 加 `stuckT, leapKind, leapDir, leapT`（从 state 读，带缺省）。
  - 转移：`chase` 中若 `stuckT >= stuckLeapSeconds && onGround` → `mode='leap'; leapKind='escape'; leapT=0;` 并设 `vy=leapJumpForce`、`leapDir = 归一化(wantVx,wantVz)×leapSpeed`（用本帧最终意图；若意图为零则用朝玩家方向）、`stuckT=0`。
  - leap 分支（在「按模式决定意图」里）：`wantVx=leapDir[0]; wantVz=leapDir[1];` 不转向玩家、不走站定环、不消费 navDir。每物理步前若 `player && hDist(player) < standoffRange-standoffDeadband` → 本步 `wantVx=wantVz=0`（保留下落）。`leapT += step`；落地（`onGround` 由 false→true）或 `leapT>leapMaxSeconds` → `mode='chase'; leapKind=null; leapDir=null; stuckT=0;`。
  - stuckT 计时（物理之后）：算本帧实际水平位移 `moved = hypot(px-prevPx, pz-prevPz)`，应走 `direct = hypot(directVx,directVz)*step`（⚠️ **用 pre-steering 的原始意图**，不是 post-steering 的 `wantVx/wantVz`——否则四面围死时 `steerIntentAabb` 归零意图 ⇒ stuckT 永不累计，见 ledger 预检 Ruling）；若 `direct>1e-6 && moved < direct*stuckProgressRatio` → `stuckT+=step` 否则 `stuckT=0`（leap 期间不计时）。
  - 返回对象加 `stuckT, leapKind, leapDir, leapT`。

- [ ] **Step 4: 跑测试确认通过** — Expected: PASS。

- [ ] **Step 5: 暂存（不提交）** — `git add src/entities/bosses/ignis-boss-agent.js src/tests/test-ignis-boss-agent.js`

---

### Task 6: ⑥ 跳跃劈砍（leap/attack）

**Files:**
- Modify: `src/entities/bosses/ignis-boss-agent.js`
- Test: `src/tests/test-ignis-boss-agent.js`

**Interfaces:**
- Consumes: `ctx.player.velocity`（装配层注入，缺省 `[0,0,0]`）、`IGNIS_AI.{leapAttackMin,leapAttackMax,leapAttackAirtime,leapAttackCooldown,leapSlashLead,gravity,standoffRange,standoffDeadband}`、Task 5 的 leap 机制。
- Produces: chase 中 8~14 格 + 冷却好 + 视线 + onGround + 直路可通 → `leap(attack)`；下落近地 → `attack`。

- [ ] **Step 1: 写失败测试**

```js
test('焰魔 AI: 8~14 格 + 冷却好 → leap(attack)，落点预判在玩家外侧', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = groundWorld(9);
  const player = { position:[0,10,-11], velocity:[0,0,0] };
  let s = st({ position:[0,10,0], mode:'chase', onGround:true, losVisible:true, leapAttackCooldown:0 });
  s = a.update(s,1/60,{world:w,registry:REGISTRY,player});
  assertEqual(s.mode,'leap'); assertEqual(s.leapKind,'attack');
  assertTrue(s.velocity[1] > 0, '应上跳');
  // 水平速指向玩家（-Z）
  assertTrue(s.leapDir[1] < 0, '应朝玩家方向飞');
});
test('焰魔 AI: 移动玩家 → 落点含速度预判（顺速度方向偏移）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const still = a.update(st({position:[0,10,0],mode:'chase',onGround:true,losVisible:true}),1/60,
    {world:groundWorld(9),registry:REGISTRY,player:{position:[0,10,-11],velocity:[0,0,0]}});
  const moving = a.update(st({position:[0,10,0],mode:'chase',onGround:true,losVisible:true}),1/60,
    {world:groundWorld(9),registry:REGISTRY,player:{position:[0,10,-11],velocity:[5,0,0]}});
  assertTrue(moving.leapDir[0] > still.leapDir[0], '玩家向 +X 移动 ⇒ 落点应偏 +X');
});
test('焰魔 AI: 距离 <8 / >14 / 冷却中 / 无视线 → 不跳劈', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = groundWorld(9);
  for (const [d, cd, los] of [[5,0,true],[16,0,true],[11,99,true],[11,0,false]]) {
    let s = st({position:[0,10,0],mode:'chase',onGround:true,losVisible:los,leapAttackCooldown:cd});
    s = a.update(s,1/60,{world:w,registry:REGISTRY,player:{position:[0,10,-d],velocity:[0,0,0]}});
    assertTrue(s.mode!=='leap'||s.leapKind!=='attack', `d=${d},cd=${cd},los=${los} 不应跳劈`);
  }
});
test('焰魔 AI: leap(attack) 下落近地 → 转 attack 且 yaw 对准玩家', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = groundWorld(9);
  const player = { position:[0,10,-4.6], velocity:[0,0,0] };
  let s = st({position:[0,11.5,-6],mode:'leap',leapKind:'attack',leapDir:[0,-8],leapTargetY:10,onGround:false,velocity:[0,-5,0]});
  for (let i=0;i<60 && s.mode==='leap';i++) s = a.update(s,1/60,{world:w,registry:REGISTRY,player});
  assertEqual(s.mode,'attack');
  assertTrue(Math.abs(s.yaw) < 0.3, `起劈应对准玩家（yaw=${s.yaw.toFixed(2)}）`);
});
```

- [ ] **Step 2: 跑测试确认失败** — Expected: FAIL。

- [ ] **Step 3: 实现** —
  - 读 `const pvel = player && Array.isArray(player.velocity) ? player.velocity : [0,0,0];`
  - chase 转移里，**在 attack 起手判定之前**加跳劈判定：若 `onGround && losVisible && leapAttackCooldown<=0 && hDist∈[leapAttackMin,leapAttackMax] && 本帧 steerIntentAabb 对直接意图零偏角且未 blocked` → 起跳：
    - `T = leapAttackAirtime`；预判 `pred = player + pvel*T`；
    - 落点 = 从 `pred` 朝焰魔方向外推 `standoffRange - standoffDeadband/2`：`dir = normalize(self - pred); land = pred + dir*(that)`；
    - `leapDir = (land - self)/T`（水平）；`vy = (Δy + 0.5*|gravity|*T²)/T`，钳 `[8,14]`；`leapTargetY = land.y`；
    - `mode='leap'; leapKind='attack'; leapT=0; leapAttackCooldown=IGNIS_AI.leapAttackCooldown;`
  - leap(attack) 空中：每帧若 `vy<0 && py <= leapTargetY + leapSlashLead`，或 `onGround` → `mode='attack'; attackAnimT=0; yaw=this._angleTo(self,player); leapDir=null;`（水平动量保留到 onGround：`leapDir` 在转 attack 后置 null，但 attack 意图为 0，故靠物理惯性——本仓物理无水平惯性，落地即停，可接受）。
  - `leapAttackCooldown` 每帧 `-step`（同 attackCooldown）。返回对象加 `leapAttackCooldown, leapTargetY`。
  - ⚠️ 复用本帧已算的 steering 结果判「直路可通」，不得重复调 `steerIntentAabb`。

- [ ] **Step 4: 跑测试确认通过** — Expected: PASS。

- [ ] **Step 5: 暂存（不提交）** — `git add src/entities/bosses/ignis-boss-agent.js src/tests/test-ignis-boss-agent.js`

---

### Task 7: ⑦ 不动如山（移除退让 + 玩家阻挡）

**Files:**
- Modify: `src/entities/bosses/ignis-boss-agent.js`（`_ringIntent` 去 retreat → tooClose）
- Modify: `src/entities/ignis/ignis-system.js`（新增 `overlapsAabb(box)`）
- Modify: `src/player/physics.js`（注入 `this.ignises` + `_collides` 追加阻挡）
- Test: `src/tests/test-ignis-boss-agent.js`、`src/tests/test-ignis-system.js`、`src/tests/test-physics.js`

**Interfaces:**
- Consumes: `ignisAabbFor(state)`（已导出）、`state.position`。
- Produces: `IgnisService.overlapsAabb({minX,maxX,minY,maxY,minZ,maxZ}) → boolean`；`PlayerPhysics.ignises`（注入字段，缺省 null）。

- [ ] **Step 1: 写失败测试**

`test-ignis-system.js`（用既有夹具：`new EntityManager()` + `new IgnisService({entities, world: flatWorld(10), seed:1})` + `svc.summon('tarn:t:0', cx, cz, 1, refY)`）：
```js
test('焰魔: overlapsAabb 相交真 / 远离假 / 无焰魔假', () => {
  const em = new EntityManager();
  const svc = new IgnisService({ entities: em, world: flatWorld(10), seed: 1 });
  assertTrue(svc.summon('tarn:t:0', 5, 5, 1, 11).ok);   // 焰魔脚底在 y=11（地表 y=10 之上）
  const e = svc.activeEntities()[0];
  const [ex, ey, ez] = e.state.position;
  // 包住焰魔身体的盒 → 相交
  assertTrue(svc.overlapsAabb({minX:ex-1,maxX:ex+1,minY:ey,maxY:ey+3,minZ:ez-1,maxZ:ez+1}));
  // 远离 10 格的盒 → 不相交（严格不等式，贴面也不算）
  assertFalse(svc.overlapsAabb({minX:ex+10,maxX:ex+11,minY:ey,maxY:ey+1,minZ:ez+10,maxZ:ez+11}));
  // 无焰魔的 service → 恒假
  const em2 = new EntityManager();
  const svc2 = new IgnisService({ entities: em2, world: flatWorld(10), seed: 1 });
  assertFalse(svc2.overlapsAabb({minX:-1,maxX:1,minY:0,maxY:2,minZ:-1,maxZ:1}));
});
```
`test-physics.js`：
```js
test('physics: 玩家撞焰魔身体盒被挡（不动如山）', () => {
  const { world } = makeWorld();
  const p = new PlayerPhysics(world);
  p.ignises = { overlapsAabb: (box) => box.maxX > 9 && box.minX < 11 && box.maxZ > 7 && box.minZ < 9 && box.maxY > 1 && box.minY < 3 };
  p.pos = {x:8,y:1,z:8};
  for (let i=0;i<10;i++) p.step(1/60);
  p.move(1,0);  // 朝 +X（焰魔在 x=10）
  for (let i=0;i<120;i++){ p.move(1,0); p.step(1/60); }
  assertTrue(p.pos.x < 9.5, `应被焰魔挡住，实际 x=${p.pos.x}`);
});
```
`test-ignis-boss-agent.js`（改写既有 retreat 用例）：
```js
test('焰魔 AI: 玩家贴上来 → 焰魔原地不动（不退让，v2.62）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const w = groundWorld(9);
  const player = { position:[0.5,10,-5.5] };
  let s = st({ position:[0.5,10,0], onGround:true, mode:'chase', attackCooldown:999 });
  const start = s.position.slice();
  for (let i=0;i<120;i++){ player.position[2]+=0.1; s=a.update(s,1/60,{world:w,registry:REGISTRY,player}); }
  const drift = Math.hypot(s.position[0]-start[0], s.position[2]-start[2]);
  assertTrue(drift < 0.5, `玩家贴近时焰魔应站定，漂移 ${drift.toFixed(2)}`);
});
```

- [ ] **Step 2: 跑测试确认失败** — Expected: FAIL（无 overlapsAabb；physics 无 ignises；retreat 仍在）。

- [ ] **Step 3: 实现** —
  - `_ringIntent`：`d < inner` 分支返回 `{vx:0,vz:0,tooClose:true}`（原 `-ux*chaseSpeed` 退让删除）；死区与 `d>standoff` 分支的 `retreat` 字段更名 `tooClose:false`。`update` 里 `retreating` 变量更名 `tooClose`，navDir 覆盖块条件 `!retreating`→`!tooClose`（语义不变）。
  - `IgnisService.overlapsAabb(box)`：遍历 `activeEntities()`，对每只算 `const local = ignisAabbFor(e.state); const p = e.state.position;` 世界盒 `minX=p[0]+local.min[0]` 等，严格不等式相交（`box.minX < wMaxX && box.maxX > wMinX && ...` 三轴），任一相交返回 true。
  - `physics.js`：构造器加 `this.ignises = null;`（注释同 minecarts 手法）；`_collides()` 末尾 `return` 前加 `if (this.ignises && this.ignises.overlapsAabb(this.aabb())) return true;`。⚠️ `_collides` 有多个 return 路径（采样循环 + 末尾），阻挡判定加在**末尾 return false 之前**，且只在水平/竖直采样未命中时才查（保持方块优先）。

- [ ] **Step 4: 跑测试确认通过** — Expected: PASS。⚠️ 既有「站定环内优先原地不动」用例注释提到「退开 1.5 格」已陈旧，更新注释（行为仍绿：drift≈0 < 3.0）。

- [ ] **Step 5: 暂存（不提交）** — `git add src/entities/bosses/ignis-boss-agent.js src/entities/ignis/ignis-system.js src/player/physics.js src/tests/test-ignis-boss-agent.js src/tests/test-ignis-system.js src/tests/test-physics.js`

---

### Task 8: game.js 装配接线（玩家速度差分 + ignises 注入）

**Files:**
- Modify: `src/core/game.js`（ctx.player 加 velocity；player.physics.ignises 注入）
- Test: `tests/ignis.spec.mjs`（E2E 间接验证；本 task 主要靠既有 E2E 不回归 + Task 10 新 E2E）

**Interfaces:**
- Consumes: `IgnisService`（:665 已建）、`Player`（:903 已建）、帧循环 `dt`（:1065）、`pp`（:1097）。
- Produces: `entities.update` 的 ctx.player = `{position, velocity}`；`player.physics.ignises === this.ignises`。

- [ ] **Step 1: 实现 velocity 差分** — 在类字段加 `this._prevPlayerPos = null;`（构造器或 `_lastFrameMs` 附近）。帧循环里 `const pp = this.player.physics.pos;` 之后、`entities.update` 之前：
```js
let pvel = [0,0,0];
if (this._prevPlayerPos && dt > 0) {
  pvel = [(pp.x-this._prevPlayerPos.x)/dt, (pp.y-this._prevPlayerPos.y)/dt, (pp.z-this._prevPlayerPos.z)/dt];
}
this._prevPlayerPos = {x:pp.x, y:pp.y, z:pp.z};
```
ctx.player 改为 `{ position:[pp.x,pp.y,pp.z], velocity: pvel }`。⚠️ 首帧/dt=0 给 `[0,0,0]`（Review Focus #1）。

- [ ] **Step 2: 实现 ignises 注入** — Player 构造（:903 块）之后加 `this.player.physics.ignises = this.ignises;`（注释：与 minecarts 同手法，player/ 不 import entities/）。

- [ ] **Step 3: 验证不回归** — 跑 `tests/ignis.spec.mjs` 既有用例（召唤/不穿模/寻路）。Expected: 仍绿。⚠️ 「不穿模」E2E 断言 `minDist > standoffRange-1.5`——移除 retreat 后玩家站定、焰魔停在环上，minDist≈5 仍 > 3.5，绿。

- [ ] **Step 4: 暂存（不提交）** — `git add src/core/game.js`

---

### Task 9: ③ 上台阶视觉缓动（渲染层 StepLift）

**Files:**
- Modify: `src/render/ignis-renderer.js`（每实例挂 StepLift + prevY；sync 算 dt；发布 y 加 offset；测试钩子）
- Test: `src/tests/test-ignis-render.js`

**Interfaces:**
- Consumes: `StepLift`（`player/step-lift.js`）、`IGNIS_STEP_LIFT.epsilon`（Task 1）。
- Produces: `liftOffsetOf(index)`、`renderYOf(index)`（= physY + offset）。

- [ ] **Step 1: 写失败测试**

```js
test('焰魔渲染: 上台阶 → lift.offset<0 且 renderYOf=physY+offset', async () => {
  const d = await getAsset(); const r = new IgnisRenderer(new THREE.Scene(), d);
  const ent = (y) => ({id:'i', state:{position:[0,y,0], yaw:0, flashedUntil:0, attackAnimT:0, idleTime:0}});
  r.sync([ent(10)], 0);            // 首帧对齐
  assertEqual(r.liftOffsetOf(0), 0, '首帧不触发');
  r.sync([ent(11)], 16);           // 抬 1 格
  assertTrue(r.liftOffsetOf(0) < 0, '上台阶应欠负偏移');
  assertTrue(Math.abs(r.renderYOf(0) - (11 + r.liftOffsetOf(0))) < 1e-9, 'renderYOf=physY+offset');
  r.dispose();
});
test('焰魔渲染: 下落 → offset 立即清零', async () => {
  const d = await getAsset(); const r = new IgnisRenderer(new THREE.Scene(), d);
  const ent = (y) => ({id:'i', state:{position:[0,y,0], yaw:0, flashedUntil:0, attackAnimT:0, idleTime:0}});
  r.sync([ent(10)],0); r.sync([ent(11)],16);
  r.sync([ent(10.5)],32);
  assertEqual(r.liftOffsetOf(0), 0, '下落应清零');
  r.dispose();
});
```

- [ ] **Step 2: 跑测试确认失败** — Expected: FAIL（无 liftOffsetOf/renderYOf）。

- [ ] **Step 3: 实现** — import `StepLift` 与 `IGNIS_STEP_LIFT`。`_makeInstance` 返回对象加 `lift:new StepLift(), prevY:null`。`sync` 开头算 `const dt = this._lastSyncMs===null?0:Math.max(0,(nowMs-this._lastSyncMs)/1000); this._lastSyncMs=nowMs;`（构造器加 `this._lastSyncMs=null`）。`_syncOne` 里调 `this._advanceLift(inst, st.position[1], dt)`（三分支同丧尸 `_advanceLift`），发布 `inst.pivot.position.set(x, st.position[1]+inst.lift.offset, z)`。加钩子 `liftOffsetOf(i)`/`renderYOf(i)`（i 是实例下标；测试用 index 0）。

- [ ] **Step 4: 跑测试确认通过** — Expected: PASS。

- [ ] **Step 5: 暂存（不提交）** — `git add src/render/ignis-renderer.js src/tests/test-ignis-render.js`

---

### Task 10: E2E（不动如山 / 跳跃劈砍 / 围困脱困）

**Files:**
- Test: `tests/ignis.spec.mjs`（新增 3 条 E2E）

**Interfaces:**
- Consumes: 全部前序 task 的行为；`g.player.keys.add('KeyW')` 驱动玩家跑动（既有 spec 手法）；`g.editor.setBlock` 垒墙。

- [ ] **Step 1: 写 E2E（不动如山）** — 召唤焰魔、玩家全速冲向它 3 秒（`keys.add('KeyW')` 朝焰魔方向）→ 断言玩家中心距停在 `[身体盒表面, 3格]`（钉上下界：`> 0.8 && < 3.0`）、焰魔位置漂移 `< 0.5` 格。

- [ ] **Step 2: 写 E2E（跳跃劈砍）** — 玩家与焰魔相距 ~11 格站定 → 轮询 `e.state.mode/leapKind`，断言若干秒内出现 `mode==='leap' && leapKind==='attack'`，随后 `mode==='attack'`，且玩家被命中 ≥1 刀（每次命中回满血）。

- [ ] **Step 3: 写 E2E（围困脱困）** — `editor.setBlock` 给焰魔垒一圈 3 格高石墙（它 step 不上）→ 8 秒内出现 `mode==='leap'`，随后焰魔 y 升高越过墙顶或到墙外。

- [ ] **Step 4: 跑 E2E 确认通过** — `npx playwright test tests/ignis.spec.mjs`。Expected: 全部 PASS（含既有用例）。⚠️ 计时型判据看交替对照分布，不看单次红绿（AGENTS.md）。

- [ ] **Step 5: 暂存（不提交）** — `git add tests/ignis.spec.mjs`

---

### Task 11: 全量回归 + 负向验证 + 门禁

**Files:** 无新增（验证 task）

- [ ] **Step 1: 三门** — `npm run check`（check:arch + check:data + lint）。Expected: 0 error。

- [ ] **Step 2: 浏览器内单测全量** — `npm start` 后读 `/src/tests/index.html` 的 `window.__MC_TEST_RESULTS__`，或既有驱动。Expected: 0 failed。

- [ ] **Step 3: Playwright 全量** — `npm test`。Expected: 全绿（`tests/zombie-model.spec.mjs` 在 HEAD 上已红，与本次正交，不计入）。

- [ ] **Step 4: bench 回归**（动了 `player/physics.js` 热路径）— `npm run bench -- --check`。Expected: 无回退 >10%。⚠️ frameP95 有 vsync 量子化噪声，回退判定用交替对照（AGENTS.md / memory `bench-framep95-vsnc-quantization-noise`）。

- [ ] **Step 5: 负向验证**（单变量、cp 副本还原 + sha256 核对，memory `negative-test-revert-use-copy-not-git-checkout`）— 至少覆盖：① retreat 加回 → 「玩家贴近焰魔原地不动」红；② `turnDelay=0` → 「idle→chase 需累计」红；③ `_resolveStuck` 删除 → 「被埋解卡」红；④ 跳劈触发窗去掉 `leapAttackMin` 下界 → 「距离 <8 不跳劈」红；⑤ StepLift offset 不写进 pivot → 「renderYOf」红。每条记录真红证据。

- [ ] **Step 6: 暂存全部 + 报告** — `git add -A` 后 `git status` 复核暂存清单（memory `concurrent-session-stage-per-hunk-not-whole-file`：本仓可能并发会话，逐文件核对）。**不提交**，等用户验收。ledger 记全量回归结果与负向验证证据。

---

## Self-Review

**Spec coverage：** ①→Task2 ②→Task1 ③→Task9 ④→Task4 ⑤→Task5 ⑥→Task6 ⑦→Task7+8 ⑧→Task3。装配→Task8。E2E→Task10。门禁→Task11。全覆盖。

**Type consistency：** `tooClose`（Task7 统一，替代 `retreat`/`retreating`）；`leapKind∈{escape,attack}`（Task5/6 一致）；`overlapsAabb(box)` 入参形状 = `physics.aabb()` 返回形状（Task7 一致）；`ctx.player.velocity`（Task6 消费、Task8 产出，缺省 `[0,0,0]` 两侧一致）。

**Review Focus 落点：** #1→Task8 Step1（dt=0 给 [0,0,0]）；#2→Task6（移动玩家落点 + 落地兜底用例）；#3→Task4（超深不抬用例）；#4→Task9（首帧 prevY=null 用例）；#5→Task7 注释（spec 已接受，不加测试）。

**Proportion：** 11 个 task，每个给签名/测试名/断言/关键算法值，不贴完整 body（仅 leap 预判、resolveStuck、velocity 差分给算法骨架——这些是签名定不出的）。计划长度 < spec。
