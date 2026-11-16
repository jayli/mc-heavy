# 旋斩法阵 + 守卫踱步 + 围场 Boss Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 焰魔旋斩命中帧铺出与举盾砸击同位置的地面火焰法阵；末影守卫移动时双腿交替踱步；围场占地内按 B 召出末影守卫。

**Architecture:** 三项都是**接线修复 / 数据登记**，不新增子系统。① 旋斩只放行装配层已有的招式过滤，复用 `sigilSpawnPoints` + `_findSigilGroundY`（位置结构上同源）；② 守卫 Agent 把水平意图写回 `state.velocity`（与丧尸/焰魔同口径），渲染器按**实际水平位移**推进步态相位，常量落 `guardian-config.js`；③ `boss-map.js` 加 `ARENA` 判据 + `boss-registry.js` 加一行名册，`Game.summonBoss()` 一行不改。

**Tech Stack:** 原生 ES module（无构建）、three r185.1（`vendor/three/`，import map）、Playwright（`channel:'chromium'`）、浏览器内单测 `src/tests/index.html`。

**Spec:** `docs/superpowers/specs/2026-11-16-spin-sigil-guardian-gait-arena-boss-design.md`

## Global Constraints

- 依赖方向 `voxel ← gen ← mesh ← render`；`src/entities/**` 与 `src/gen/**` **不得 import three、不得引用 DOM**。
- 数据只有一份权威（红线 1）：新常量只在一处定义，其余 import；不在 `game.js` 重写落点公式。
- 时间基准 `performance.now()`，禁 `Date.now()`（`loadGuardianAsset` 的 cache-busting 是既有唯一例外）。
- 资源路径一律 `resourceUrl()`，禁 `'/assets/`、`'/src/`、`'/vendor/`。
- 零实例池必须 `visible=false`（守卫池扩到 2 后仍不得增常驻 draw call）。
- `src/tests/test-*.js` 必须出现在 `src/tests/index.html` 的 import 里（`check:data` 双向钉住）。
- **不改**：任何招式数值（射程/锥角/命中帧/时长/权重/冷却）、守卫四招动画与伤害、相机、`Game.summonBoss()`、热路径（mesher/materials/render-world/scheduler/physics）。
- **不新增**：方块、贴图、烘焙产物、设置面板开关、Boss 血条。
- 冻结断言不符时**停下来报告**，不擅自放宽（本轮 §5.4 三条重标是用户新裁定的结果，已在 spec 记明）。
- 提交必须等用户明确指令 ⇒ **本计划所有 Task 都不含 commit 步骤**；改动留在工作树，最后统一报告。
- 负向验证撤销注入一律用 `cp` 副本还原，**禁用 `git checkout/restore`**（工作树有未提交改动）。

## Review Focus

1. **守卫撞墙 / 被玩家挡住时腿仍在摆（滑步）** —— 意图非零但净位移为 0 的帧，四肢必须回 bind。Task 2 的「撞墙不滑步」用例。
2. **守卫死了又召 / 换实体时继承上一只的步态相位** —— 新实体首帧不得摆腿。Task 2 的「实例复用重置」用例。
3. **围场按 B 抢走别处的 Boss 判定** —— 围场占地内的点不得被判成 CITY/TARN/SNOW/浅水高台。Task 3 的多 seed 互斥用例。
4. **堡垒已有守卫时围场按 B 静默失败** —— `maxAlive` 必须够两张图各一只，且第三张才 limit。Task 3 的 service 用例。
5. **旋斩法阵位置与举盾砸击不同** —— 首段必须落在焰魔脚底（`firstSegmentDist < 0.01`），四段间距同源。Task 1 的 Tier 4 用例。

## 本轮的验证工具（已实测可用，实施者直接用）

浏览器内单测可在 node 里跑（快，用于 RED/GREEN 循环）：

```bash
node /tmp/mc-node-tests.mjs src/tests/test-guardian-render.js src/tests/test-guardian-boss-agent.js
```

该探针本轮已创建并实测（178/178 全绿）。它做两件事：把裸 `three` 映到 `vendor/three/`（node 无 import map）、把仓库根 `file://` URL 重写成 `http://localhost:8081/`（产物 fetch）。**需要 dev server 在跑**（`npm start`，端口 8081）。
⚠️ 它是**临时探针**（`/tmp`，不入仓）；最终门禁仍走浏览器：`npx playwright test tests/harness.spec.mjs`。
⚠️ 命令**不要接管道**（`| tail` 会把退出码换成 tail 的）——要看输出就直接跑，探针自己打印 JSON 汇总。

---

### Task 1: 旋斩命中帧铺地面法阵

**Files:**
- Modify: `src/core/game.js:3487`（`_consumeIgnisFxRequests` 的法阵段招式过滤）
- Test: `tests/ignis-fx.spec.mjs`（追加一条 Tier 4 用例）

**Interfaces:**
- Consumes: 既有 `sigilSpawnPoints(at, yaw, cfg)` → `Array<{x,z,delayMs}>`、`Game._findSigilGroundY(wx,wz,feetY)` → `number|null`、`FlameSigilRenderer.spawn(points, nowMs)`、`FLAME_SIGIL`（`firstOffset:0`、`spacing:4.25`、`segments:4`）。
- Produces: 无新接口（只放宽一处招式过滤）。

- [ ] **Step 1: 写失败用例（Tier 4，真实命中帧路径）**

在 `tests/ignis-fx.spec.mjs` 末尾追加。夹具逐行复用该文件既有的 `waitWorldReady` / `gotoOpenField` / `setupScene` / `shoot` / `goldenCount`（**不新写一份**）：

```js
test('焰魔特效 Tier 4：旋斩命中帧铺法阵，位置与举盾砸击同源（首段在脚底）', async ({ page }) => {
  test.setTimeout(200_000);
  await page.goto(`/?vd=3&seed=${SEED}&stats=0`);
  await waitWorldReady(page);
  await gotoOpenField(page);
  const id = await setupScene(page);
  // 单变量对照：藏掉焰魔本体（它自带火焰橙，idle 波动 ±18000 像素会淹没判据）
  await page.evaluate((eid) => {
    const g = window.__MC_GAME__;
    const idx = g.ignises.activeEntities().findIndex((x) => x.id === eid);
    g.ignisRenderer.instances[idx].mesh.visible = false;
  }, id);
  const base = [];
  for (let i = 0; i < 3; i++) { base.push(goldenCount(PNG.sync.read(await shoot(page)))); await page.waitForTimeout(120); }
  const noiseFloor = Math.max(...base);
  // 钉旋斩起手，让真实帧循环推进到命中帧 0.70s（同一次 evaluate 内注入，零 CDP 间隙）
  await page.evaluate((eid) => {
    const g = window.__MC_GAME__;
    const e = g.entities.get(eid);
    e.state = { ...e.state, mode: 'attack', attackKind: 'spin', attackAnimT: 0,
      yaw: 0, velocity: [0, 0, 0], losVisible: true, losTimer: 999 };
  }, id);
  await page.waitForFunction(() => window.__MC_GAME__.flameSigil.activeCount > 0, null, { timeout: 15_000 });
  await page.waitForTimeout(400);   // 等最后一段延迟（200ms）过去再读 visible
  const lit = await page.evaluate(() => ({
    visible: window.__MC_GAME__.flameSigil.mesh.visible,
    active: window.__MC_GAME__.flameSigil.activeCount,
  }));
  const onCount = goldenCount(PNG.sync.read(await shoot(page)));
  // 首段实例矩阵位移 == 焰魔脚底（真实 three.Matrix4，不自己造 stub）
  const geo = await page.evaluate(async (eid) => {
    const THREE = await import('three');
    const g = window.__MC_GAME__;
    const at = g.entities.get(eid).state.position;
    const m = new THREE.Matrix4();
    g.flameSigil.mesh.getMatrixAt(0, m);
    return { firstSegmentDist: Math.hypot(m.elements[12] - at[0], m.elements[14] - at[2]) };
  }, id);
  expect(lit.active, '旋斩须铺 4 段法阵').toBe(4);
  expect(lit.visible, '延迟过后法阵须真的提交渲染').toBe(true);
  expect(geo.firstSegmentDist, '首段必须落在焰魔脚底（与举盾砸击同口径）').toBeLessThan(0.01);
  expect(onCount, `金黄像素须显著高于噪声底（base=${base}）`).toBeGreaterThan(noiseFloor + 900);
  expect(onCount, '不得 additive 叠成一片过曝').toBeLessThan(294000 * 0.08);
  await page.waitForTimeout(3600);
  const end = await page.evaluate(() => ({
    active: window.__MC_GAME__.flameSigil.activeCount,
    visible: window.__MC_GAME__.flameSigil.mesh.visible,
  }));
  expect(end.active, '寿命结束须回收').toBe(0);
  expect(end.visible, '回收后 draw call 回基线').toBe(false);
});
```

⚠️ 阈值 `noiseFloor + 900` 与上界 `8%` 直接沿用同文件举盾砸击用例的实测标定（同一 clip、同一藏宿主手法）。**首跑必须打印 `base` 与 `onCount` 实际值**；若增量与 900 不在同一量级，停下来报告，不擅自改阈值。

- [ ] **Step 2: 跑用例确认它红**

Run: `npx playwright test tests/ignis-fx.spec.mjs -g "旋斩命中帧铺法阵"`
Expected: FAIL —— `旋斩须铺 4 段法阵` 收到 `0`（`waitForFunction` 15s 超时），因为 `spin` 在法阵段被过滤掉。

- [ ] **Step 3: 放行 spin（一处判据）**

`src/core/game.js` 的 `_consumeIgnisFxRequests`，法阵段那行改成：

```js
      // v3.09：旋斩也铺法阵（用户 2026-11-16「位置也跟盾击一样」）。
      // ⚠️ **复用同一套 sigilSpawnPoints + _findSigilGroundY**，不得为旋斩另写落点公式
      //（第二份权威 ⇒ 两招位置会漂，而段数/延迟/寿命全部仍对）。
      if ((req.kind !== 'shieldBash' && req.kind !== 'spin') || !this.flameSigil || !this.world) continue;
```

⚠️ 入口 gate（`:3436`）与尖刺分支的 `continue` **一行不动**（尖刺不得多出法阵）。

- [ ] **Step 4: 跑用例确认它绿**

Run: `npx playwright test tests/ignis-fx.spec.mjs`
Expected: PASS 3/3（既有两条 + 新增一条）。

- [ ] **Step 5: 负向验证（注入必须真红）**

`cp src/core/game.js /tmp/game.bak.js` → 把 Step 3 的 `&& req.kind !== 'spin'` 删掉 → 跑 `-g "旋斩命中帧铺法阵"` 应 FAIL → `cp /tmp/game.bak.js src/core/game.js` 还原 → `shasum -a 256` 与备份逐位核对。

---

### Task 2: 守卫移动时双腿踱步

**Files:**
- Modify: `src/entities/bosses/guardian-boss-agent.js:400`（返回值 `velocity`）
- Modify: `src/entities/guardian/guardian-config.js`（新增 `GUARDIAN_GAIT`）
- Modify: `src/render/guardian-renderer.js:56-60`（删四个本地常量）、`:165`/`:222`（实例字段与重置）、`:320-355`（`_idlePose`）
- Test: `src/tests/test-guardian-boss-agent.js`、`src/tests/test-guardian-render.js`（各追加用例）

**Interfaces:**
- Consumes: `GUARDIAN_AI.chaseSpeed = 5.4`、`GuardianPoseTransition.step(key, target, dt, seconds)`、既有 `IDLE_LIMBS`（`left_leg:+1 / right_leg:-1 / left_arm:-1 / right_arm:+1`）与 `_idleRoot`。
- Produces:
  - `state.velocity = [wantVx, vy, wantVz]`（水平分量 = 最终意图，格/秒；`attack`/`idle`/死区为 0）。
  - `export const GUARDIAN_GAIT = Object.freeze({ limbAmplitude: 0.3, rootAmplitude: 0.05, radiansPerBlock: 1.85, movingEpsilon: 0.001 })`（`src/entities/guardian/guardian-config.js`）。
  - 实例新增 `prevX: number|null`、`prevZ: number|null`（与既有 `prevY` 并列）。

- [ ] **Step 1: 写 Agent 侧失败用例**

在 `src/tests/test-guardian-boss-agent.js` 末尾追加（复用该文件的 `st` / `playerAt` / `groundWorld` / `REGISTRY`）：

```js
// ==================== 水平意图写回 velocity（v3.09 步态接线）====================

test('守卫 AI: chase 追击时把水平意图写回 velocity（渲染步态据此判「在移动」）', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const ctx = { world: groundWorld(9), registry: REGISTRY, player: playerAt(12) };
  const s = a.update(st({ mode: 'chase', onGround: true, losVisible: true, losTimer: 1 }), 1 / 60, ctx);
  assertEqual(s.mode, 'chase', '前提：12 格外不该起手');
  assertTrue(Math.hypot(s.velocity[0], s.velocity[2]) > 1,
    `水平意图须写回 velocity，实际 ${JSON.stringify(s.velocity)}`);
  assertTrue(s.velocity[2] < 0, '玩家在 −Z ⇒ vz 须为负');
});

test('守卫 AI: attack / idle / 死区站定时水平 velocity 恒 0（静止不摆腿）', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  const world = groundWorld(9);
  const cases = [
    { mode: 'idle', player: playerAt(12) },
    { mode: 'attack', player: playerAt(3), over: { attackKind: 'stomp', attackAnimT: 0.1 } },
    { mode: 'chase', player: playerAt(3.2) },      // 站定环 3.5 死区 0.75 ⇒ 站定
  ];
  for (const c of cases) {
    const s = a.update(st({ onGround: true, losVisible: true, losTimer: 1, mode: c.mode, ...(c.over || {}) }),
      1 / 60, { world, registry: REGISTRY, player: c.player });
    assertEqual(s.velocity[0], 0, `${c.mode} 水平 vx 须 0`);
    assertEqual(s.velocity[2], 0, `${c.mode} 水平 vz 须 0`);
  }
});

test('守卫 AI: 四面被围时意图仍非零但净位移为 0（不清零意图，与丧尸同口径）', () => {
  const a = new GuardianBossAgent({ rng: () => 0.5 });
  // 切比雪夫半径 2 的实心墙（半径 1 会出生即被埋），地面 y<=9
  const world = makeWorld((x, y, z) => y <= 9
    || (Math.max(Math.abs(x), Math.abs(z)) === 2 && y >= 10 && y <= 14));
  const ctx = { world, registry: REGISTRY, player: { position: [0, 10, -12] } };
  let s = st({ mode: 'chase', onGround: true, losVisible: false, losTimer: 999 });
  const p0 = s.position.slice();
  for (let i = 0; i < 30; i++) s = a.update(s, 1 / 60, ctx);
  assertTrue(Math.hypot(s.velocity[0], s.velocity[2]) > 1, '意图不得被清零');
  assertTrue(Math.hypot(s.position[0] - p0[0], s.position[2] - p0[2]) < 0.05, '被围住 ⇒ 净位移≈0');
});
```

- [ ] **Step 2: 跑 Agent 用例确认它红**

Run: `node /tmp/mc-node-tests.mjs src/tests/test-guardian-boss-agent.js`
Expected: FAIL 2 条（第一条与第三条的「意图须写回 / 不得清零」收到 `[0, vy, 0]`）；第二条应已绿（本来就恒 0）。

- [ ] **Step 3: Agent 写回水平意图**

`src/entities/bosses/guardian-boss-agent.js` 返回值：

```js
      // v3.09：水平意图写回 velocity（渲染层步态据此判「在移动」）。
      // ⚠️ 与丧尸/焰魔同口径：意图写进 state.velocity，**不另设 intent 容器** ——
      // 另设会让「渲染看到的移动」与「物理实际的移动」分家。
      // ⚠️ 本 Agent 顶部只读 state.velocity[1]（vy），不读水平分量 ⇒ 写回无反馈回路。
      velocity: [wantVx, vy, wantVz],
```

- [ ] **Step 4: 跑 Agent 用例确认它绿**

Run: `node /tmp/mc-node-tests.mjs src/tests/test-guardian-boss-agent.js`
Expected: PASS 53/53（既有 50 + 新增 3）。

- [ ] **Step 5: 写渲染侧失败用例**

在 `src/tests/test-guardian-render.js` 末尾追加（复用该文件的 `ent`；`GUARDIAN_GAIT` 从 config import）。判据落在**真实骨骼四元数**上，`bindQuaternion` 四肢与 root 实测均为 `[0,0,0,1]` ⇒ 增量角 = `2·acos(|w|)`：

```js
// ==================== 程序化步态（v3.09：按位移推相位）====================

/** 从骨骼四元数反解绕 X 的增量角（弧度，带符号）——bind 是单位四元数 */
function legAngle(inst, boneIndex) {
  const q = inst.bones[boneIndex].quaternion;
  return 2 * Math.atan2(q.x, q.w);
}

/** 让守卫沿 −Z 走 frames 帧，每帧位移 dz 格；返回逐帧的左右腿角 */
function walkFrames(r, d, li, ri, frames, dz, startMs = 1000) {
  const out = [];
  let z = 0;
  for (let i = 0; i < frames; i++) {
    z -= dz;
    r.sync([ent({ position: [0, 10, z], velocity: [0, 0, -5.4], attackAnimT: 0, attackKind: null })],
      startMs + i * 16);
    out.push([legAngle(r.instances[0], li), legAngle(r.instances[0], ri)]);
  }
  return out;
}

test('守卫步态: 移动中双腿反相摆动，幅度不超过 limbAmplitude', async () => {
  const d = await loadGuardianAsset();
  const r = new GuardianRenderer(new THREE.Scene(), d);
  try {
    const li = d.bones.findIndex((b) => b.name === 'left_leg');
    const ri = d.bones.findIndex((b) => b.name === 'right_leg');
    const seq = walkFrames(r, d, li, ri, 40, 0.09);   // 5.4 格/秒 @60Hz
    const peak = Math.max(...seq.map(([l]) => Math.abs(l)));
    assertTrue(peak > GUARDIAN_GAIT.limbAmplitude * 0.5,
      `摆幅须接近标定值，实测峰值 ${peak.toFixed(4)}`);
    assertTrue(peak <= GUARDIAN_GAIT.limbAmplitude + 1e-6,
      `摆幅不得超标定值，实测 ${peak.toFixed(4)}`);
    const opposed = seq.filter(([l, rr]) => l * rr < -1e-8).length;
    assertTrue(opposed > seq.length * 0.5, `左右腿须反相，实测 ${opposed}/${seq.length}`);
  } finally { r.dispose(); }
});

test('守卫步态: 相位按**位移**推进而非时间（同 dt 下位移 10 倍 ⇒ 相位 10 倍）', async () => {
  const d = await loadGuardianAsset();
  const li = d.bones.findIndex((b) => b.name === 'left_leg');
  const angles = [];
  for (const dz of [0.02, 0.2]) {
    const r = new GuardianRenderer(new THREE.Scene(), d);
    // 两帧：首帧建立 prevX/prevZ 基准（不摆），第二帧的位移唯一决定相位
    r.sync([ent({ position: [0, 10, 0], velocity: [0, 0, -5.4] })], 1000);
    r.sync([ent({ position: [0, 10, -dz], velocity: [0, 0, -5.4] })], 1016);
    angles.push(legAngle(r.instances[0], li));
    r.dispose();
  }
  const want = Math.sin(0.2 * GUARDIAN_GAIT.radiansPerBlock) * GUARDIAN_GAIT.limbAmplitude;
  assertTrue(Math.abs(angles[1] - want) < 1e-6, `大位移帧角度须等于解析值 ${want}，实测 ${angles[1]}`);
  assertTrue(Math.abs(angles[1] / angles[0] - 10) < 0.05,
    `位移 10 倍 ⇒ 相位 10 倍（小角度下 sin 近线性），实测比 ${(angles[1] / angles[0]).toFixed(3)}`);
});

test('守卫步态: 撞墙不滑步（意图非零但位置不变 ⇒ 淡入走完后腿回 bind）', async () => {
  const d = await loadGuardianAsset();
  const r = new GuardianRenderer(new THREE.Scene(), d);
  try {
    const li = d.bones.findIndex((b) => b.name === 'left_leg');
    walkFrames(r, d, li, li, 20, 0.09);            // 先真的走一段，腿摆起来
    for (let i = 0; i < 30; i++) {                  // 位置钉死，意图仍非零
      r.sync([ent({ position: [0, 10, -1.8], velocity: [0, 0, -5.4] })], 2000 + i * 16);
    }
    assertTrue(Math.abs(legAngle(r.instances[0], li)) < 1e-6,
      `撞墙后腿须回 bind，实测 ${legAngle(r.instances[0], li)}`);
  } finally { r.dispose(); }
});

test('守卫步态: 实例复用给新实体时相位与位移基准重置（首帧不摆）', async () => {
  const d = await loadGuardianAsset();
  const r = new GuardianRenderer(new THREE.Scene(), d);
  try {
    const li = d.bones.findIndex((b) => b.name === 'left_leg');
    walkFrames(r, d, li, li, 20, 0.09);
    const e2 = { id: 'guardian:arena:0', type: 'guardian',
      state: { ...ent({ position: [40, 10, 40], velocity: [0, 0, -5.4] }).state } };
    r.sync([e2], 3000);
    assertTrue(Math.abs(legAngle(r.instances[0], li)) < 1e-6,
      '新实体首帧不得继承上一只的相位（也不得把跨图位移当一大步）');
  } finally { r.dispose(); }
});

test('守卫步态: 攻击期间不叠加步态（腿姿态 == 片段采样值）', async () => {
  const d = await loadGuardianAsset();
  const r = new GuardianRenderer(new THREE.Scene(), d);
  try {
    const li = d.bones.findIndex((b) => b.name === 'left_leg');
    const T = 0.5;
    r.sync([ent({ position: [0, 10, 0], velocity: [0, 0, -5.4], attackAnimT: T, attackKind: 'strong_right' })], 1000);
    r.sync([ent({ position: [0, 10, -0.09], velocity: [0, 0, -5.4], attackAnimT: T, attackKind: 'strong_right' })], 1016);
    // 与「零速度但同招同时刻」的渲染器逐位比较（淡入来源相同 ⇒ 差异只可能来自步态叠加）
    const r2 = new GuardianRenderer(new THREE.Scene(), d);
    r2.sync([ent({ position: [0, 10, 0], velocity: [0, 0, 0], attackAnimT: T, attackKind: 'strong_right' })], 1000);
    r2.sync([ent({ position: [0, 10, 0], velocity: [0, 0, 0], attackAnimT: T, attackKind: 'strong_right' })], 1016);
    const a = r.instances[0].bones[li].quaternion, b = r2.instances[0].bones[li].quaternion;
    assertTrue(Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.w - b.w) < 1e-9, '攻击期间腿不得被步态改写');
    r2.dispose();
  } finally { r.dispose(); }
});
```

⚠️ 同时把既有「零实例时全部实例 visible=false」用例保持不变（它遍历 `r.instances`，池扩到 2 后自动覆盖两个）。

- [ ] **Step 6: 跑渲染用例确认它红**

Run: `node /tmp/mc-node-tests.mjs src/tests/test-guardian-render.js`
Expected: FAIL —— `GUARDIAN_GAIT` 未导出（import 报错）或摆幅用例收到 0。先把 import 加上再跑，确保红在断言而不是解析。

- [ ] **Step 7: 新增 GUARDIAN_GAIT 常量**

`src/entities/guardian/guardian-config.js` 追加（放在 `GUARDIAN_POSE_BLEND` 附近）：

```js
/**
 * 程序化步态（v3.09）—— 渲染层与单测共用的唯一权威。
 *
 * 原版 `ModelEnder_Guardian.setupAnim`：四肢 `walkDegree×1.2 = 0.6 rad`、root `×0.2 = 0.1 rad`。
 * 用户 2026-11-16 裁定「稍微有一个踱步的动作」⇒ **两者都取原版一半**。
 *
 * ⚠️ **相位按移动距离推进，不按时间**：原版 `limbSwing` 由 `walkAnimation(distance)` 驱动。
 * 按 dt 推的形态是「撞墙 / 被玩家挡住时腿仍摆」（滑步），且步频与步幅随帧率脱钩。
 * `radiansPerBlock = 1.85` ⇒ 一步周期 2π/1.85 ≈ 3.40 格；chaseSpeed 5.4 格/秒 ⇒ **1.59 周期/秒**。
 */
export const GUARDIAN_GAIT = Object.freeze({
  limbAmplitude: 0.3,
  rootAmplitude: 0.05,
  radiansPerBlock: 1.85,
  movingEpsilon: 0.001,
});
```

- [ ] **Step 8: 渲染器改按位移推相位**

`src/render/guardian-renderer.js`：
1. 删 `IDLE_WALK_SPEED` / `IDLE_LIMB_AMPLITUDE` / `IDLE_ROOT_AMPLITUDE` / `MOVING_EPSILON` 四个本地常量及其注释段，改从 config import `GUARDIAN_GAIT`（红线 1：不留第二份）。
2. `_makeInstance()` 的返回对象加 `prevX: null, prevZ: null`（紧邻既有 `prevY`）。
3. `sync()` 的实例复用分支加 `inst.prevX = null; inst.prevZ = null;`（紧邻 `inst.prevY = null`）。
4. `_syncOne` 在算 pose **之前**取本帧位移并更新基准（用**物理** `st.position`，不是加了 lift/knock 的渲染位置）：

```js
    const dx = inst.prevX === null ? 0 : st.position[0] - inst.prevX;
    const dz = inst.prevZ === null ? 0 : st.position[2] - inst.prevZ;
    inst.prevX = st.position[0];
    inst.prevZ = st.position[2];
```
   把 `Math.hypot(dx, dz)` 作为第三参传给 `_idlePose(inst, st, moved)`（替换原来的 `dt` 参数 —— 相位不再用 dt）。
5. `_idlePose(inst, st, moved)`：

```js
    const v = Array.isArray(st.velocity) ? st.velocity : [0, 0, 0];
    const eps = GUARDIAN_GAIT.movingEpsilon;
    const intentMoving = Math.abs(v[0]) > eps || Math.abs(v[2]) > eps;
    // ⚠️ 两条都要：意图为假（idle/attack/死区）归零；意图真但净位移≈0（撞墙、被玩家挡住）
    // 也归零 —— 这是「不滑步」的判据。首帧 prevX===null ⇒ moved=0 ⇒ 不摆。
    if (intentMoving && moved > eps) inst.idlePhase += moved * GUARDIAN_GAIT.radiansPerBlock;
    else inst.idlePhase = 0;
    const out = new Map();
    if (inst.idlePhase === 0) return out;
```
   其余（`Math.sin(inst.idlePhase)`、`IDLE_LIMBS` 反相、root）不变，幅度改用 `GUARDIAN_GAIT.limbAmplitude` / `rootAmplitude`。
6. 文件头「程序化 idle」段的注释补一句：相位按位移、幅度取原版一半（用户裁定）。

- [ ] **Step 9: 跑渲染 + Agent 用例确认全绿**

Run: `node /tmp/mc-node-tests.mjs src/tests/test-guardian-render.js src/tests/test-guardian-boss-agent.js src/tests/test-guardian-system.js src/tests/test-guardian-config.js`
Expected: PASS（既有 153 + 新增 8；`test-guardian-config.js` 的 `maxAlive===1` 此刻仍绿，Task 3 才改）。

- [ ] **Step 10: 负向验证（三条，各自真红）**

`cp` 备份三个源文件 → 逐条注入 → 跑对应用例 → `cp` 还原 + `shasum` 核对：
- `velocity` 改回 `[0, vy, 0]` ⇒ 步态用例红（摆幅 0）；
- 相位改回 `dt × 2`（把 `moved * radiansPerBlock` 换成 `dt * 2`，`_idlePose` 第三参改回 dt）⇒ 「位移 10 倍 ⇒ 相位 10 倍」红；
- 去掉 `moved > eps` 门 ⇒ 「撞墙不滑步」红。

---

### Task 3: 围场登记末影守卫（按 B 召唤）

**Files:**
- Modify: `src/gen/structures/arena.js`（新增 `ARENA_SUMMON_FEET_DY`）
- Modify: `src/entities/bosses/boss-map.js`（`BOSS_MAP_KINDS` + `arenaMapAt` + `DETECTORS`）
- Modify: `src/entities/bosses/boss-registry.js`（`BOSS_ROSTER.ARENA`）
- Modify: `src/entities/guardian/guardian-config.js:53`（`maxAlive: 1 → 2`）
- Modify: `src/core/game.js:747-756`（守卫装配注释补「也服务围场」，无逻辑改动）
- Test: `src/tests/test-boss-map.js`、`src/tests/test-guardian-system.js`、`src/tests/test-guardian-config.js`、`tests/guardian.spec.mjs`

**Interfaces:**
- Consumes: `computeArenaAnchor(seed)` → `{wx,wz,floorY,maxH,span}|null`、`inArenaFootprint(wx,wz,anchors)`、`ARENA_HALF_X=20` / `ARENA_HALF_Z=39`、`GuardianService.summon(mapKey,cx,cz,slot,refY)`、`guardianEntityIdFor(mapKey,slot)` → `guardian:<mapKey>:<slot>`。
- Produces:
  - `export const ARENA_SUMMON_FEET_DY = 1`（`src/gen/structures/arena.js`）。
  - `bossMapAt` 新返回形状 `{kind:'ARENA', cx:a.wx, cz:a.wz, key:'arena:0', summonY:a.floorY + ARENA_SUMMON_FEET_DY}`。
  - `BOSS_MAP_KINDS` 顺序：`CITY, TARN, BURNING_ARENA, RUINED_CITADEL, ARENA, SNOW, SHALLOW_TARN`。
  - `GUARDIAN.maxAlive = 2`。

- [ ] **Step 1: 写地图/名册失败用例**

在 `src/tests/test-boss-map.js` 末尾追加（import 补 `computeArenaAnchor, inArenaFootprint, ARENA_HALF_X, ARENA_HALF_Z, ARENA_SUMMON_FEET_DY`）：

```js
// ==================== 围场（ARENA，末影守卫第二张地图）====================

test('bossMapAt: 围场锚点 → ARENA，落点 = 场地中心地板上方一格', () => {
  const a = computeArenaAnchor(SEED);
  assertTrue(a !== null, `前提：seed ${SEED} 应有围场锚点`);
  const m = bossMapAt(a.wx, a.wz, SEED);
  assertTrue(m !== null && m.kind === 'ARENA', `应判 ARENA，实际 ${JSON.stringify(m)}`);
  assertEqual(m.cx, a.wx);
  assertEqual(m.cz, a.wz);
  assertEqual(m.key, 'arena:0');
  assertEqual(m.summonY, a.floorY + ARENA_SUMMON_FEET_DY, 'summonY = 地板层上方一格');
});

test('bossMapAt: 围场四缘也判 ARENA，外一格不判（转调 inArenaFootprint，不自写 AABB）', () => {
  const a = computeArenaAnchor(SEED);
  for (const [dx, dz] of [[ARENA_HALF_X, 0], [-ARENA_HALF_X, 0], [0, ARENA_HALF_Z], [0, -ARENA_HALF_Z]]) {
    const m = bossMapAt(a.wx + dx, a.wz + dz, SEED);
    assertTrue(m !== null && m.kind === 'ARENA', `缘 (${dx},${dz}) 应命中，实际 ${JSON.stringify(m)}`);
    assertEqual(inArenaFootprint(a.wx + dx, a.wz + dz, [a]), true, '判定器与占地权威须一致');
  }
  for (const [dx, dz] of [[ARENA_HALF_X + 1, 0], [0, ARENA_HALF_Z + 1]]) {
    const m = bossMapAt(a.wx + dx, a.wz + dz, SEED);
    assertTrue(m === null || m.kind !== 'ARENA', `外一格 (${dx},${dz}) 不得判 ARENA`);
  }
});

test('bossMapAt: ARENA 在 BOSS_MAP_KINDS 里且排在 SNOW 之前', () => {
  assertTrue(BOSS_MAP_KINDS.includes('ARENA'));
  assertTrue(BOSS_MAP_KINDS.indexOf('ARENA') < BOSS_MAP_KINDS.indexOf('SNOW'),
    '地面级人工结构统一排在 region 级雪原盒之前');
});

test('名册: 围场登记了唯一 Boss（slot 0 = 末影守卫）', () => {
  const slots = bossSlotsFor('ARENA');
  assertEqual(slots.length, 1, '围场只有守卫一个 Boss');
  assertEqual(slots[0].slot, 0);
  assertEqual(slots[0].type, 'guardian');
  assertEqual(slots[0].service, 'guardians');
});

test('bossMapAt: 围场占地内的点不得被别的地图抢走（多 seed 互斥，Review Focus #3）', () => {
  // 结构层本来互斥（arena.fixedBlockers 避地标；shallow-tarns / ruined-citadel 反过来避围场）。
  // ⚠️ 扫**整个占地**而不只是中心：中心不重叠不代表边缘不重叠。
  let checked = 0;
  for (const seed of [12345, 42, 2096, 424242, 777, 1000, 8919, 16838]) {
    const a = computeArenaAnchor(seed);
    if (!a) continue;
    for (let dx = -ARENA_HALF_X; dx <= ARENA_HALF_X; dx += 5) {
      for (let dz = -ARENA_HALF_Z; dz <= ARENA_HALF_Z; dz += 5) {
        checked++;
        const m = bossMapAt(a.wx + dx, a.wz + dz, seed);
        assertTrue(m !== null && m.kind === 'ARENA',
          `seed ${seed} 占地内 (${dx},${dz}) 应判 ARENA，实际 ${JSON.stringify(m)}`);
      }
    }
  }
  assertTrue(checked > 0, '前提：至少一个 seed 有围场锚点（否则本用例空跑）');
});
```

- [ ] **Step 2: 写 service / config 侧失败用例**

`src/tests/test-guardian-config.js`：`assertEqual(GUARDIAN.maxAlive, 1, '废弃堡垒只有一个')` → `assertEqual(GUARDIAN.maxAlive, 2, '两张地图各一只（废弃堡垒 + 围场）')`。

`src/tests/test-guardian-system.js`：
- 「summon 幂等」用例的 `assertEqual(b.reason, 'limit', …)` → `assertEqual(b.reason, 'exists', 'maxAlive=2 时同槽重召先命中 id 检查')`，注释同步改写（**场上仍只有一条**那条断言不动）；
- 「超出 maxAlive 返回 limit」用例改成从常量派生：

```js
test('守卫 service: 两张地图各召一只成功，第三张才 limit（围场 Boss 的前提）', () => {
  const { svc } = mkSvc();
  for (let i = 0; i < GUARDIAN.maxAlive; i++) {
    assertTrue(svc.summon(`map:${i}`, 10 + i * 10, 20, 0, 11).ok, `第 ${i} 只应成功`);
  }
  const b = svc.summon('map:extra', 90, 90, 0, 11);
  assertFalse(b.ok);
  assertEqual(b.reason, 'limit');
  assertEqual(svc.activeEntities().length, GUARDIAN.maxAlive);
});
```

- [ ] **Step 3: 跑用例确认它们红**

Run: `node /tmp/mc-node-tests.mjs src/tests/test-boss-map.js src/tests/test-guardian-system.js src/tests/test-guardian-config.js`
Expected: FAIL —— `ARENA_SUMMON_FEET_DY` 未导出（解析错）⇒ 先只加常量再跑，确保红在断言：地图用例收到 `null`、名册 length 0、`maxAlive` 收到 1、幂等 reason 收到 `limit`。

- [ ] **Step 4: 加常量 + 地图判据 + 名册 + 上限**

1. `src/gen/structures/arena.js`（尺寸常量段之后）：

```js
/**
 * 召唤落点脚底相对 `floorY` 的偏移（格）—— 与 `BURNING_ARENA_SUMMON_FEET_DY` 同手法。
 *
 * `apply.js` 阶段 2.9 用 `floorY - (floorRow - 1)` 落位，使**地板层正好坐落在 floorY**
 * ⇒ 站在它上面一格 = `floorY + 1`（与 `Game.teleportToArena` 同口径）。
 * ⚠️ 中心格是水池的 `glass_block` 盖（`solid:true`），可站；中心 15 格内无实心装饰（产物实测）。
 */
export const ARENA_SUMMON_FEET_DY = 1;
```

2. `src/entities/bosses/boss-map.js`：import 补 `computeArenaAnchor, inArenaFootprint, ARENA_SUMMON_FEET_DY`；`BOSS_MAP_KINDS` 在 `'RUINED_CITADEL'` 后插 `'ARENA'`；新增判定器（放在 `ruinedCitadelMapAt` 之后）：

```js
/**
 * 围场（城南门外草地竞技场）—— 末影守卫的第二张地图（用户 2026-11-16「围栏内增加一个 boss」）。
 *
 * ⚠️ **判据转调 `inArenaFootprint`**（唯一权威），不自写 `Math.abs(dx) <= 20`。
 * ⚠️ **`summonY` 恒为场地地板上方一格**，与玩家所在高度无关：围场是下沉式场地，
 *    玩家可能站在靠高一侧的土壁上，不传会召到土壁那一层。
 * ⚠️ 排在 SNOW **之前**：雪原盒是 region 级包围盒（±28），口径与另两个地面级结构一致。
 *    实测 8 seed × 整个占地零重叠（结构层互相避让），本顺序是防御性的。
 */
function arenaMapAt(wx, wz, seed) {
  const a = computeArenaAnchor(seed);
  if (!a || !inArenaFootprint(wx, wz, [a])) return null;
  return {
    kind: 'ARENA', cx: a.wx, cz: a.wz, key: 'arena:0',
    summonY: a.floorY + ARENA_SUMMON_FEET_DY,
  };
}
```
   `DETECTORS` 同位置插入 `arenaMapAt`；文件头的判据表补一行 `| ARENA | computeArenaAnchor + inArenaFootprint |`，优先级行同步。

3. `src/entities/bosses/boss-registry.js`：`BOSS_ROSTER` 加

```js
  // 围场（城南门外草地竞技场，v3.09）：唯一 Boss = 末影守卫（与废弃堡垒同一实体）。
  // ⚠️ slot 0：本图只有守卫（toast「已召唤 Boss1」）。
  // ⚠️ 召唤点恒在场地中心地板上方一格（`bossMapAt` 给本图返回 summonY）。
  ARENA: Object.freeze([
    Object.freeze({ slot: 0, type: GUARDIAN_TYPE, service: 'guardians' }),
  ]),
```

4. `src/entities/guardian/guardian-config.js`：`maxAlive: 1` → `2`，注释改「同时存活上限 —— 两张地图各一只（废弃堡垒 + 围场），与 `IGNIS.maxAlive` 同口径」。
5. `src/core/game.js` 守卫装配段注释补「也服务围场（ARENA）」；`summonBoss()` **一行不改**。

- [ ] **Step 5: 跑单测确认全绿**

Run: `node /tmp/mc-node-tests.mjs src/tests/test-boss-map.js src/tests/test-guardian-system.js src/tests/test-guardian-config.js src/tests/test-guardian-render.js src/tests/test-guardian-boss-agent.js`
Expected: PASS（既有 178 + Task 2 的 8 + Task 3 的 5，减去被改写的 1 条 = 190）。

- [ ] **Step 6: 写围场 E2E 失败用例**

在 `tests/guardian.spec.mjs` 的 `test.describe` 内追加（复用该文件的 `waitWorldReady` / `waitColumn` / `pressB` / `putPlayer`）：

```js
  test('围场：占地内按 B → 守卫落在场地中心地板上，且在栏杆环内（Review Focus #3/#4）', async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto(`/?seed=${SEED}`);
    await waitWorldReady(page);
    const a = await page.evaluate(async () => {
      const m = await import('/src/gen/structures/arena.js');
      const anchor = m.computeArenaAnchor(window.__MC_GAME__.seed);
      return anchor && { ...anchor, dy: m.ARENA_SUMMON_FEET_DY, hx: m.ARENA_HALF_X, hz: m.ARENA_HALF_Z };
    });
    expect(a, '前提：seed 12345 必须有围场').not.toBeNull();
    // 关阴影：VSM 下 receiveShadow 对象也进阴影 pass，会让 drawCalls 无关波动（全仓 spec 同口径）
    await page.evaluate(() => window.__MC_GAME__.setShadowsEnabled(false));
    await page.waitForTimeout(300);
    // 玩家放在场地**靠高一侧的土壁上方**（floorY + maxH − floorY + 2），验证 summonY 无视玩家高度
    await putPlayer(page, a.wx + 0.5, a.maxH + 2, a.wz + 0.5);
    await waitColumn(page, a.wx, a.wz);
    const drawBefore = await page.evaluate(() => window.__MC_GAME__.renderStats().drawCalls);
    await pressB(page);
    await page.waitForFunction(() => window.__MC_GAME__.guardians.activeEntities().length === 1,
      null, { timeout: 30_000 });
    await page.waitForFunction(() => window.__MC_GAME__.guardians.activeEntities()[0]?.state.onGround === true,
      null, { timeout: 15_000 });
    const got = await page.evaluate(() => {
      const g = window.__MC_GAME__;
      const e = g.guardians.activeEntities()[0];
      const [x, y, z] = e.state.position;
      return { id: e.id, x, y, z,
        below: g.world.getBlockId(Math.floor(x), Math.floor(y) - 1, Math.floor(z)),
        self: g.world.getBlockId(Math.floor(x), Math.floor(y), Math.floor(z)) };
    });
    console.log('ARENA GUARDIAN SPAWN:', JSON.stringify(got), 'expect y', a.floorY + a.dy);
    expect(got.id, 'id 必须带围场标识').toContain('arena:0');
    expect(got.y, '脚底 = 地板层上方一格（不是土壁那一层）').toBe(a.floorY + a.dy);
    expect(Math.floor(got.x)).toBe(a.wx);
    expect(Math.floor(got.z)).toBe(a.wz);
    expect(got.below, '脚下应实心').not.toBe(0);
    expect(got.self, '自身所在格应是空气').toBe(0);
    expect(Math.abs(got.x - a.wx), '必须在栏杆环内').toBeLessThan(a.hx);
    expect(Math.abs(got.z - a.wz)).toBeLessThan(a.hz);
    // 击杀后 draw call 回基线（守卫池扩到 2 仍不得留常驻 draw）
    await page.evaluate(() => {
      const g = window.__MC_GAME__;
      const e = g.guardians.activeEntities()[0];
      g.guardians.damage(e.id, 999999, performance.now());
    });
    await page.waitForTimeout(500);
    const drawAfter = await page.evaluate(() => window.__MC_GAME__.renderStats().drawCalls);
    expect(drawAfter, `守卫 despawn 后 draw call 须回基线（before=${drawBefore}）`)
      .toBeLessThanOrEqual(drawBefore);
  });
```

⚠️ `a.maxH` 是占地内最高自然地表（`computeArenaAnchor` 返回字段），玩家放它上方 2 格 ⇒ 若 `summonY` 没接线，`_findGroundY` 会取「离玩家最近」的土壁层 ⇒ `got.y` 断言红。这是本用例的判别力所在。

- [ ] **Step 7: 跑 E2E 确认它绿（Step 4 已实现）**

Run: `npx playwright test tests/guardian.spec.mjs -g "围场"`
Expected: PASS。⚠️ 若 `waitColumn` 超时，先确认 dev server 在跑且端口 8081 是**本仓**（worktree 会静默连主仓服务）。

- [ ] **Step 8: 负向验证（两条真红）**

- `DETECTORS` 去掉 `arenaMapAt` ⇒ 单测「围场锚点 → ARENA」红 + E2E 的 `waitForFunction` 超时（`no-map`）；
- `summonY` 那行删掉（改成不带该字段）⇒ E2E 的 `got.y` 红（落到土壁层）。
两条都用 `cp` 副本还原 + `shasum` 核对。

---

### Task 4: 守卫踱步的 Tier 4 实测 + 全量门禁

**Files:**
- Test: `tests/guardian.spec.mjs`（追加一条踱步 E2E）
- Modify: `docs/roadmap.md`（追加 v3.09 版本行）

**Interfaces:**
- Consumes: Task 2 的 `GUARDIAN_GAIT`、`GuardianRenderer.instances[i].bones`、`GuardianService.summon`。
- Produces: 无（验证 + 文档）。

- [ ] **Step 1: 写踱步 E2E**

在 `tests/guardian.spec.mjs` 追加。开阔地召守卫（不走围场，避免栏杆干扰追击），玩家钉在 12 格外让它 chase，逐帧采样**真实骨骼四元数 + state.position**：

```js
  test('踱步：守卫追击时双腿真的交替摆动，站定后回 bind（Tier 4 真实骨骼）', async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto(`/?seed=${SEED}&vd=3`);
    await waitWorldReady(page);
    // 开阔地（远离城市，建筑遮挡会让 AI 抖动）——同 ignis-fx.spec 的 gotoOpenField 手法
    await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      const p = g.player.physics.pos;
      g._teleportTo(Math.floor(p.x) + 600, 45, Math.floor(p.z) + 600);
      await new Promise((r) => setTimeout(r, 2500));
    });
    const r = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      const { GUARDIAN_GAIT } = await import('/src/entities/guardian/guardian-config.js');
      const p = g.player.physics.pos;
      const sum = g.guardians.summon('gait:e2e', Math.floor(p.x), Math.floor(p.z) - 14, 0, Math.floor(p.y));
      if (!sum.ok) return { err: sum.reason };
      await new Promise((res) => setTimeout(res, 1500));
      const e = g.entities.get(sum.id);
      const d = g.guardianRenderer.asset;
      const li = d.bones.findIndex((b) => b.name === 'left_leg');
      const ri = d.bones.findIndex((b) => b.name === 'right_leg');
      const ang = (i) => { const q = g.guardianRenderer.instances[0].bones[i].quaternion; return 2 * Math.atan2(q.x, q.w); };
      const frames = [];
      let prev = e.state.position.slice();
      for (let k = 0; k < 150; k++) {
        await new Promise((res) => requestAnimationFrame(res));
        const cur = g.entities.get(sum.id)?.state.position;
        if (!cur) break;
        frames.push({ moved: Math.hypot(cur[0] - prev[0], cur[2] - prev[2]), l: ang(li), rr: ang(ri) });
        prev = cur.slice();
      }
      const moving = frames.filter((f) => f.moved > 0.01);
      const opposed = moving.filter((f) => f.l * f.rr < -1e-8).length;
      const peak = Math.max(...moving.map((f) => Math.abs(f.l)), 0);
      // 玩家贴近到死区内 ⇒ 站定；等淡入走完再读
      const st = g.entities.get(sum.id).state;
      g.entities.get(sum.id).state = { ...st, position: [p.x, st.position[1], p.z - 3.2] };
      g.guardians.activeEntities();
      for (let k = 0; k < 40; k++) await new Promise((res) => requestAnimationFrame(res));
      return { movingFrames: moving.length, opposed, peak, amp: GUARDIAN_GAIT.limbAmplitude,
        restAngle: Math.abs(ang(li)), totalDisplacement: frames.reduce((s, f) => s + f.moved, 0) };
    });
    console.log('GUARDIAN GAIT:', JSON.stringify(r));
    expect(r.err).toBeUndefined();
    expect(r.totalDisplacement, '前提：守卫须真的走起来（否则用例空跑）').toBeGreaterThan(2);
    expect(r.movingFrames, '须有足够移动帧').toBeGreaterThan(20);
    expect(r.opposed, `左右腿须反相（${r.opposed}/${r.movingFrames}）`).toBeGreaterThan(r.movingFrames * 0.4);
    expect(r.peak, '摆幅须接近标定值').toBeGreaterThan(r.amp * 0.5);
    expect(r.peak, '摆幅不得超标定值').toBeLessThanOrEqual(r.amp + 1e-6);
    expect(r.restAngle, '站定且淡入走完后腿须回 bind').toBeLessThan(1e-3);
  });
```

⚠️ 首跑必须打印 `GUARDIAN GAIT` 的实际值再定阈值 —— 若 `totalDisplacement ≤ 2`（守卫没走起来，可能被地形挡住），先调夹具位置，**不放宽断言**。

- [ ] **Step 2: 跑该 spec 全部用例**

Run: `npx playwright test tests/guardian.spec.mjs`
Expected: PASS（既有 8 条 + Task 3 的围场 1 条 + 本条 = 10）。

- [ ] **Step 3: 全量门禁**

```bash
npm run check
npx playwright test tests/harness.spec.mjs
npx playwright test tests/ignis-fx.spec.mjs tests/guardian.spec.mjs tests/arena.spec.mjs tests/teleport.spec.mjs
npx eslint src/core/game.js src/entities/bosses/guardian-boss-agent.js src/entities/bosses/boss-map.js src/entities/bosses/boss-registry.js src/entities/guardian/guardian-config.js src/render/guardian-renderer.js src/gen/structures/arena.js
```
Expected: `check` 三门全绿；harness `failed === 0`；四个 spec 全绿；改动文件 eslint **0 error 0 warning**（新增 warning 不得称作既有基线）。
⚠️ **不跑 `bench --check`**：三项都不碰热路径（testing-policy §6.1）。
⚠️ `arena.spec` / `teleport.spec` 是回归确认：本轮给围场加了 Boss 判定与常量，但**没动落点算法与瞬移落点**。

- [ ] **Step 4: 更新 roadmap**

`docs/roadmap.md` 版本表追加 v3.09 行：三项需求原话、三项裁定、两处缺陷根因（`velocity` 恒 0 / 相位按 dt）、`maxAlive` 1→2 的连带与两条断言重标、实测数据（摆幅峰值 / 步频 / 金黄像素 / 落点 y）、负向验证清单、门禁结果。**不写「目视通过」**。

- [ ] **Step 5: 清理临时探针**

`rm /tmp/mc-node-tests.mjs /tmp/mc-probe-run.mjs /tmp/mc-three-loader.mjs /tmp/mc-three-reg.mjs`（逐个字面路径，不用通配符）+ 各 Task 的 `/tmp/*.bak.js` 备份。
⚠️ 只删本轮自己创建的这些文件；`/tmp` 下其它文件一律不碰。

---

## Self-Review

**1. Spec coverage**：§5.1 旋斩 → Task 1；§5.2 踱步（Agent + config + 渲染器）→ Task 2；§5.3 围场（常量 + 判据 + 名册 + maxAlive）→ Task 3；§5.4 三条断言重标 → Task 3 Step 2（config / 幂等 reason / 上限用例）+ 池容量用例本就从常量派生；§6 Tier 1 → Task 2/3 的 node 循环；§6 Tier 4 → Task 1 Step 1、Task 3 Step 6、Task 4 Step 1；§6 负向验证 5 条 → Task 1 Step 5（1）、Task 2 Step 10（3）、Task 3 Step 8（2，其中 DETECTORS 那条覆盖单测与 E2E）；§6 门禁 → Task 4 Step 3。无缺口。

**2. Step scan**：每个代码步给了确切文件、确切签名/常量值与判别性注释要点；函数体只在「算法不由签名与测试确定」处给出（`_idlePose` 的相位门、`arenaMapAt` 的返回形状）。测试步给的是可直接落地的断言代码。

**3. Type consistency**：`GUARDIAN_GAIT` 四个字段名在 Task 2 定义、Task 2 测试与 Task 4 E2E 消费处一致；`_idlePose(inst, st, moved)` 第三参由 `dt` 改 `moved`，调用点与负向验证 Step 10 都按此写；`ARENA_SUMMON_FEET_DY` 在 Task 3 定义、单测与 E2E 同名消费；`prevX/prevZ` 与既有 `prevY` 并列命名。

**4. Review Focus**：五条各有归属用例（#1 Task 2 撞墙、#2 Task 2 实例复用、#3 Task 3 多 seed 互斥 + E2E 栏杆环内、#4 Task 3 service 上限、#5 Task 1 首段矩阵位移）。

**5. Proportion**：计划以断言代码为主（那是 TDD 的载荷），实现步只给签名/常量/关键门控，未抄写函数全文。