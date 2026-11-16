# 焰魔第五招「尖刺攻击」Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给焰魔加第五招 `spikeSlash`：举剑过顶向下劈地，正前方 5 根火焰尖锥递延升起；第一刀命中帧时玩家距 ≤4 格则接第二刀。

**Architecture:** 动画取 Bedrock 素材 `attack3a`（= Java `EARTH_SHUDDERS_ATTACK`）的第一刀与第三刀两段下劈，跳过中间上撩，经**多段时间重映射 + 烘焙期接缝补间**产出两条动画（单刀 52 帧 / 双刀 83 帧）。玩法档案加一档 `spikeSlash`，state 增 `spikeSecond` 决定播哪条与何时结束。尖刺是新建的程序化 `ConeGeometry` additive 实例池，伤害走 `attackFxRequest`（不受视线复查影响，与原版一致）。

**Tech Stack:** 原生 ES module + three r185.1（WebGPU 唯一后端）；烘焙 Node 脚本；浏览器内单测（`src/tests/`）+ Playwright（`tests/`）。

**Spec:** `docs/superpowers/specs/2026-11-15-ignis-spike-slash-design.md`

## Global Constraints

- 依赖方向单向 `voxel ← gen ← mesh ← render`；`src/entities/` 属 Worker 同构层，**不得 import three、不得碰 DOM/音频**。
- 资源路径只走 `resourceUrl()`（`src/core/resource-url.js`），禁止 `'/assets/` 站点根绝对路径。
- 时间基准 `performance.now()`，禁止 `Date.now()`。
- 同一事实只有一份权威（红线 1）：玩法数值在 `ignis-config.js`，烘焙参数在 `tools/ignis-fingerprint.mjs`，两者不互抄。
- 实例池零活跃时必须 `mesh.visible = false`；每帧零分配（临时矩阵/向量为模块级常量）。
- `src/tests/test-*.js` 必须同时注册进 `src/tests/index.html`（漏注册 = 静默不跑）。
- 坐标类判据一律非负取模；yaw 口径「正前方 = `(−sin yaw, −cos yaw)`」。
- 不新增贴图/音频文件；不碰相机；不做震屏。
- 断言前先在真实数据上跑一次打印实际值（AGENTS.md：多处踩坑都是「断言描述想象中的世界」）。
- 提交必须等明确指令 —— 本计划的 commit 步骤**执行时跳过**，改为在最终报告里列出改动文件。

## Review Focus

1. **第二刀的距离门用错时刻**：若用「起手时距离」而不是「第一刀命中帧时距离」，玩家跑开后仍被追劈（用户草图明确「4 格以外就不再劈第二刀」）。→ Task 4 的距离门用例两侧都测（3.9 格接 / 4.1 格不接）。
2. **尖刺伤害逐帧重复扣**：若伤害判定挂在 `update` 而不是命中帧的一次性 request，玩家站在刺上会每帧扣 18（瞬间清零）。→ Task 6 钉「一次命中帧只扣一次」。
3. **拼接接缝可见跳变**：压缩后接缝单帧 24.39° > 片段自身上限 14.93°，补间没生效时观感是「剑突然瞬移」。→ Task 2 钉补间后单帧角 ≤ 上限，并配「不补间确实超限」的判别力自检。
4. **`spikeSecond` 被每帧重置**：若 `createState` 没透传它，第二刀永远不播（而第一刀与尖刺全对）。→ Task 4 钉跨帧保持 + 离开 attack 复位。
5. **尖刺落点用产物 bbox 而非 footprint**：本招无方块产物，但落点若照抄法阵的 `firstOffset=0` 会让第一根刺长在焰魔自己脚下（用户要「向前」）。→ Task 5 钉首根在正前方 2 格。

---

### Task 1: 多段时间重映射（烘焙基建）

**Files:**
- Modify: `tools/ignis-fingerprint.mjs`（新增 `IGNIS_ANIM_SEGMENTS` + 改 `ignisAnimOutputPeriod` / `ignisAnimTimeWarp`）
- Test: `src/tests/test-ignis-bake.js`（新增段表用例；段表本身是 node 侧，故用**产物**间接验）

**Interfaces:**
- Consumes: 现有 `IGNIS_ANIM_PERIODS` / `IGNIS_ANIM_TIME_WARP` / `ignisAnimOutputPeriod(key)` / `ignisAnimTimeWarp(key)`
- Produces:
  - `IGNIS_ANIM_SEGMENTS: {[key]: ReadonlyArray<{srcStart:number, srcEnd:number, scale:number, blendIn?:number}>}`
  - `ignisAnimOutputPeriod(key)` 优先按段表求和（无段表则回落现有 4 段 warp / 原 period）
  - `ignisAnimTimeWarp(key)` 段表形态返回 `{toSource(tOut), bounds:{seams:number[], total}, blendAt(tOut):number|null}`
    —— `blendAt` 返回该时刻的补间权重 ∈[0,1]（0 = 不补间，1 = 完全取上一段末姿态）

- [ ] **Step 1: 写失败测试（node 侧一次性探针，验段表数学）**

在 `/tmp/spike-probe/seg-math.mjs` 写探针（**不入库**），import `tools/ignis-fingerprint.mjs`，断言：
- `ignisAnimOutputPeriod('spikeSlash')` ≈ 1.7166666666666668（容差 1e-9）
- `ignisAnimOutputPeriod('spikeSlash2')` ≈ 2.75
- `toSource` 单调不减、段界连续（相邻段界处左右极限差 < 1e-9）
- `toSource(0) === 0`、`toSource(total) === 6.9`
- `blendAt` 在接缝后 0.2s 内从 1 线性降到 0，其余时刻为 null
- `shieldBash` 的 `ignisAnimOutputPeriod` 仍为 3.89（零回归）

- [ ] **Step 2: 跑探针确认失败**

Run: `node /tmp/spike-probe/seg-math.mjs`
Expected: FAIL —— `IGNIS_ANIM_SEGMENTS` 未定义 / `spikeSlash` 缺 period

- [ ] **Step 3: 实现段表与两个函数**

在 `tools/ignis-fingerprint.mjs`：
- `IGNIS_ANIM_PERIODS` 增 `spikeSlash: 6.9, spikeSlash2: 6.9`（源时长）
- `IGNIS_ANIM_SOURCES` 增 `spikeSlash: Object.freeze(['attack3a'])` / `spikeSlash2: Object.freeze(['attack3a'])`
- 新增 `IGNIS_ANIM_SEGMENTS`（值见 spec §4.3 两张表，`blendIn: 0.2` 标在**接缝后的那一段**上）：
  - `spikeSlash` 5 段，第 5 段（源 6.40~6.90）带 `blendIn: 0.2`
  - `spikeSlash2` 10 段，第 6 段（源 4.70~4.90）带 `blendIn: 0.2`
- `ignisAnimOutputPeriod`：有段表 ⇒ `Σ (srcEnd−srcStart)×scale`；否则走现有逻辑
- `ignisAnimTimeWarp`：有段表 ⇒ 构造分段线性 `toSource` + `bounds.seams`（各段产物起点）+ `blendAt`
- **参数合法性必须 throw**（同现有 warp 的 `bad()`）：`srcEnd > srcStart`、`scale > 0`、`srcEnd ≤ period`、`blendIn ≥ 0` 且 `blendIn ≤ 本段产物时长`
- `IGNIS_ANIM_SEGMENTS` 进 `ignisInputFingerprint` 的 params 哈希

- [ ] **Step 4: 跑探针确认通过**

Run: `node /tmp/spike-probe/seg-math.mjs`
Expected: PASS（全部断言）

- [ ] **Step 5: 确认 shieldBash 零回归**

Run: `npm run check:data`
Expected: `[焰魔]` 报「输入已变但产物未重烘」（指纹变了，这是**预期**的 —— Task 2 重烘后消失）；其余环节全绿

---

### Task 2: 烘焙两条动画 + 接缝补间

**Files:**
- Modify: `tools/bake-ignis.mjs`（`resampleAnimation` 支持 `blendAt`）
- Modify: `assets/ignis/ignis.json` / `ignis.meta.json`（烘焙产物，不手改）
- Test: `src/tests/test-ignis-bake.js`

**Interfaces:**
- Consumes: Task 1 的 `ignisAnimTimeWarp(key).blendAt(tOut)` / `bounds.seams`
- Produces: 产物 `animations.spikeSlash`（52 帧）/ `animations.spikeSlash2`（83 帧），`boneIndices` 9 根（含 `sword`）

- [ ] **Step 1: 写失败测试**

在 `src/tests/test-ignis-bake.js` 追加（用现有 `loadAsset()` / `boneWorldAt(d, animKey, t)` / `cornersOfBones(src, names)`）：
```js
test('焰魔烘焙(v3.06): spikeSlash/spikeSlash2 帧数与时长', async () => {
  const d = await loadAsset();
  assertEqual(d.animations.spikeSlash.frameCount, 52);
  assertEqual(d.animations.spikeSlash2.frameCount, 83);
  assertEqual(d.animations.spikeSlash.fps, 30);
  assertEqual(d.animations.spikeSlash2.fps, 30);
});

test('焰魔烘焙(v3.06): 两刀都是下劈（剑身轴竖直分量 < −0.8），不是上撩', async () => {
  // 剑身轴 = sword 局部 −z 的世界方向；第一刀命中帧 0.991667 / 第二刀 2.25
  // 判据：竖直分量 < −0.8（实测源素材 −0.915）
});

test('焰魔烘焙(v3.06): 两条动画的第一刀段逐位相同（切换无跳变）', async () => {
  // 前 44 帧（0 ~ 1.466667s）的 frames 数组逐位相等
});

test('焰魔烘焙(v3.06): 接缝补间后单帧角 ≤ 片段自身上限（不补间确实超限）', async () => {
  // 上限由片段数据现算（排除接缝窗口），实测 14.93°
  // 判别力自检：把 blendIn 当 0 重算 ⇒ 接缝处 24.39° > 上限
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx playwright test tests/harness.spec.mjs`（浏览器内单测经它跑）
Expected: FAIL —— `d.animations.spikeSlash` 为 undefined

- [ ] **Step 3: 实现烘焙期补间**

在 `tools/bake-ignis.mjs` 的 `resampleAnimation`：
- 签名不变（`timeWarp` 参数已存在），新增：若 `timeWarp.blendAt` 存在，对每帧算 `w = blendAt(tOut)`
- `w > 0` 时：先按 `toSource(tOut)` 采样本段姿态，再按**上一段末源时刻**采样一份，两者按 `w` 混合
  - 旋转：`deltaRotation` 得到的四元数做 slerp（`THREE.Quaternion.slerpQuaternions`）
  - 位移：线性 lerp
- ⚠️ **上一段末源时刻** = 段表里前一段的 `srcEnd`（不是 `toSource(tOut)` 的左极限 —— 接缝处源时间不连续）
- ⚠️ 首段无上一段 ⇒ `blendAt` 必须返回 null（Task 1 已保证）

- [ ] **Step 4: 重烘 + 跑测试确认通过**

Run: `npm run ignis && npx playwright test tests/harness.spec.mjs`
Expected: 烘焙日志出现 `动画 spikeSlash: 52 帧` / `动画 spikeSlash2: 83 帧`；测试 PASS

- [ ] **Step 5: 确认 feetOffsetY 未变**

Run: `node -e "console.log(require('./assets/ignis/ignis.json').metrics.feetOffsetY)"`
Expected: `-0.048089811082653866`（spec §4.2 实测：新招身体最低点 0.295845 高于现有 0.048090）
若变了 ⇒ **停下报告**（`IGNIS_CORE_OBB.center[1]` 需重标，超出本计划范围）

---

### Task 3: 玩法档案与权重

**Files:**
- Modify: `src/entities/ignis/ignis-config.js`（`IGNIS_ATTACKS` 加一档 + 权重改 + 新增 `IGNIS_SPIKE`）
- Modify: `src/tests/test-ignis-system.js`（既有四招断言改五招）
- Test: `src/tests/test-ignis-system.js`

**Interfaces:**
- Consumes: Task 2 的产物时长（1.716667 / 2.75）
- Produces:
  - `IGNIS_ATTACKS.spikeSlash = {hitRange:6.5, hitConeDeg:40, hitFrameSeconds:0.9916666666666667, animSeconds:2.75, weight:0.20}`
  - `IGNIS_SPIKE`（冻结常量，字段见 spec §5.2）
  - `IGNIS_ATTACK_IDS` 末档变成 `'spikeSlash'`

- [ ] **Step 1: 写失败测试**

在 `src/tests/test-ignis-system.js`：
- 改既有「四招档案形状」用例的期望清单为 `'shieldBash,shieldSmash,spikeSlash,spin,swing'`
- 改既有权重用例：`swing .175 / spin .30 / shieldSmash .175 / shieldBash .15 / spikeSlash .20`，和 = 1，`swing === shieldSmash`
- 改既有「末档 = shieldBash」用例为 `'spikeSlash'`
- 新增：
```js
test('焰魔(v3.06): spikeSlash 档案取设计文档标定值', () => {
  const a = IGNIS_ATTACKS.spikeSlash;
  assertEqual(a.hitRange, 6.5);
  assertEqual(a.hitConeDeg, 40);          // 原版 AreaAttack(4f,6,80) 的半角
  assertTrue(a.hitConeDeg < 80, '半角不是全角（写成 80 会让扇面静默变 160°）');
  assertTrue(Math.abs(a.hitFrameSeconds - 0.9916666666666667) < 1e-9);
  assertEqual(a.animSeconds, 2.75);
  assertTrue(a.animSeconds < IGNIS_AI.attackCooldownMin, '冷却不变式');
});

test('焰魔(v3.06): IGNIS_SPIKE 常量取用户裁定值', () => {
  assertEqual(IGNIS_SPIKE.count, 5);
  assertEqual(IGNIS_SPIKE.spacing, 2);
  assertEqual(IGNIS_SPIKE.firstOffset, 2);
  assertEqual(IGNIS_SPIKE.damage, 18);
  assertEqual(IGNIS_SPIKE.secondRange, 4);
  assertTrue(IGNIS_SPIKE.soloSeconds < IGNIS_SPIKE.doubleSeconds);
  assertTrue(IGNIS_SPIKE.secondHitFrame > IGNIS_ATTACKS.spikeSlash.hitFrameSeconds);
  assertTrue(IGNIS_SPIKE.count * 4 <= IGNIS_SPIKE.maxActive, '池容量装得下并发 4 招');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: FAIL —— `IGNIS_ATTACKS.spikeSlash` undefined / `IGNIS_SPIKE` 未导出

- [ ] **Step 3: 实现档案与常量**

在 `src/entities/ignis/ignis-config.js`：
- `IGNIS_ATTACKS` 末尾加 `spikeSlash`（注释写清来源：Java `EARTH_SHUDDERS_ATTACK` / Bedrock `attack3a` / 半角 40 来自 `arc 80`）
- 权重改四档（注释记「v3.06 用户裁定：新招 0.20，横扫与持盾冲撞各让 0.075 仍平分，举盾砸击让 0.05，旋斩不动」）
- 新增 `IGNIS_SPIKE`（字段与值见 spec §5.2，`soloSeconds: 1.7166666666666668`）
- ⚠️ `IGNIS_AI` 的四项派生值自动跟上（`ATTACK_MAX` 已按 `IGNIS_ATTACK_IDS` 派生）——
  `hitConeDeg` 派生最大值仍是 155（旋斩），`animSeconds` 仍是 3.89（举盾砸击）⇒ **不变**

- [ ] **Step 4: 跑测试确认通过**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: PASS

---

### Task 4: Agent 双刀推进与 spikeSecond

**Files:**
- Modify: `src/entities/bosses/ignis-boss-agent.js`（命中推进块 + 返回值）
- Modify: `src/entities/ignis/ignis-system.js`（`createState` 透传 `spikeSecond`）
- Test: `src/tests/test-ignis-boss-agent.js`

**Interfaces:**
- Consumes: Task 3 的 `IGNIS_ATTACKS.spikeSlash` / `IGNIS_SPIKE`
- Produces:
  - `state.spikeSecond: boolean`（本招内保持，离开 attack 复位 false）
  - `attackRequest` / `attackFxRequest` 在 `spikeSlash` 档下**可产生两次**（第一刀 + 第二刀）
  - `attackFxRequest` 形状不变 `{at, yaw, kind}`（尖刺伤害由 game.js 按 kind 判定）

- [ ] **Step 1: 写失败测试**

在 `src/tests/test-ignis-boss-agent.js` 追加（复用现有 `st()` / `wallWorld()` / `OPEN_CTX` / `playerAt()`）：
```js
test('焰魔 AI(v3.06): spikeSlash 第一刀命中帧恒触发一次', () => {
  // 玩家在 10 格外（> secondRange）⇒ 只一刀
  // 断言 attackFxRequest 出现 1 次、spikeSecond === false
});

test('焰魔 AI(v3.06): 第一刀命中帧时玩家 ≤4 格 ⇒ 接第二刀（两次请求）', () => {
  // 玩家在 3.9 格 ⇒ spikeSecond true、attackFxRequest 出现 2 次
});

test('焰魔 AI(v3.06): 第一刀命中帧时玩家 >4 格 ⇒ 不接第二刀', () => {
  // 玩家在 4.1 格 ⇒ spikeSecond false、只 1 次
  // ⚠️ 两侧都测（Review Focus 1：距离门用错时刻的判别力）
});

test('焰魔 AI(v3.06): 距离门用命中帧时刻而不是起手时刻', () => {
  // 起手时玩家 3 格，但第一刀命中帧前把玩家移到 8 格 ⇒ 不接第二刀
});

test('焰魔 AI(v3.06): spikeSecond 跨帧保持，离开 attack 复位', () => {
  // 命中帧后连续 30 帧 spikeSecond 恒 true；动画结束后 false
});

test('焰魔 AI(v3.06): 单刀 1.716667s 结束 / 双刀 2.75s 结束', () => {
  // 两种模式各跑到 mode 回 chase，记 attackAnimT 峰值
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: FAIL —— `spikeSecond` undefined / 第二次请求不出现

- [ ] **Step 3: 实现 Agent 推进**

在 `src/entities/bosses/ignis-boss-agent.js` 的「攻击推进与命中帧」块：
- 顶部读 `let spikeSecond = state.spikeSecond === true;`
- `spikeSlash` 档走**双命中帧**分支（其余招走现有单帧逻辑，一行不改）：
  - 第一帧 `prevAnimT < hitFrameSeconds && attackAnimT >= hitFrameSeconds`：
    产生两个 request（同现有口径：FX 无条件、伤害看 `freshLos`）；
    **同帧判 `hDist <= IGNIS_SPIKE.secondRange`** ⇒ `spikeSecond = true`
  - 第二帧 `spikeSecond && prevAnimT < secondHitFrame && attackAnimT >= secondHitFrame`：同样产生两个 request
- 动画结束阈值：`spikeSecond ? IGNIS_SPIKE.doubleSeconds : IGNIS_SPIKE.soloSeconds`
- 离开 attack 态（中止门 / 播完）⇒ `spikeSecond = false`
- 返回值加 `spikeSecond`

在 `src/entities/ignis/ignis-system.js` 的 `createState`：
- 解构参数加 `spikeSecond`，字段 `spikeSecond: spikeSecond === true`
- `deserialize` 不传它（缺省 false）；`serialize` 不含它

- [ ] **Step 4: 跑测试确认通过**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: PASS

- [ ] **Step 5: 确认既有四招零回归**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: 既有「四招都产特效请求」用例现在跑五招，`spikeSlash` 在玩家 4.5 格（`attackRange−1`）时
**会产生 2 次** ⇒ 该用例的 `assertEqual(fx, 1)` 会红。
**改法**：把该用例的玩家距离改到 `IGNIS_SPIKE.secondRange + 1`（5 格，仍 ≤ attackRange 5.5）
⇒ 五招都恰好 1 次。⚠️ 这是**夹具调整不是放宽断言**（语义仍是「每招至少产一次特效」）。

---

### Task 5: 尖刺渲染器

**Files:**
- Create: `src/render/spike-fx.js`
- Create: `src/tests/test-spike-fx.js`
- Modify: `src/tests/index.html`（注册新 test）

**Interfaces:**
- Consumes: Task 3 的 `IGNIS_SPIKE`
- Produces:
  - `SPIKE_FX`（渲染层常量：`height / radius / riseMs / lifeMs / maxActive / color`，从 `IGNIS_SPIKE` 派生或独立标定）
  - `spikeSpawnPoints(at, yaw, cfg = IGNIS_SPIKE) → Array<{x, z, delayMs}>`
  - `spikeScaleAt(ageMs, delayMs, cfg = SPIKE_FX, out?) → {scale, visible, done}`
  - `class SpikeFxRenderer { constructor({scene, maxActive}); spawn(points, nowMs); update(nowMs); dispose(); get activeCount }`

- [ ] **Step 1: 写失败测试**

Create `src/tests/test-spike-fx.js`（照 `test-flame-sigil.js` 的结构与 `assertClose` 局部工具）：
```js
test('spike fx: 5 根落点 = 正前方 2/4/6/8/10 格（本仓 yaw 口径）', () => {
  const pts = spikeSpawnPoints([10, 5, 20], 0);
  assertEqual(pts.length, 5);
  for (let i = 0; i < 5; i++) {
    assertClose(pts[i].x, 10, 1e-9);
    assertClose(pts[i].z, 20 - (2 + 2 * i), 1e-9);
  }
  // yaw = π/2 ⇒ 正前方 = (−1, 0)
  const p2 = spikeSpawnPoints([10, 5, 20], Math.PI / 2);
  assertClose(p2[0].x, 8, 1e-9);
  assertClose(p2[0].z, 20, 1e-9);
});

test('spike fx: 首根在正前方 2 格，不在脚底（Review Focus 5）', () => {
  const pts = spikeSpawnPoints([0, 0, 0], 0);
  assertTrue(Math.hypot(pts[0].x, pts[0].z) >= 2 - 1e-9);
});

test('spike fx: 延迟序列 0/50/100/150/200ms', () => {
  const pts = spikeSpawnPoints([0, 0, 0], 0);
  assertDeepEqual(pts.map(p => p.delayMs), [0, 50, 100, 150, 200]);
});

test('spike fx: 升起→保持→缩回的 scale 包络', () => {
  // 延迟期内 visible=false, scale=0
  // 升起段 scale 从 0 单调增到 1
  // 保持段 scale === 1
  // 缩回段 scale 单调降到 0，末尾 done=true
});

test('spike fx: 几何是 6 棱锥，基准高度 = SPIKE_FX.height', () => {
  const r = new SpikeFxRenderer({ scene: new THREE.Scene() });
  assertEqual(r.mesh.geometry.parameters.radialSegments, 6);
  assertEqual(r.mesh.geometry.parameters.height, SPIKE_FX.height);
  r.dispose();
});

test('spike fx: 零活跃时 visible=false，spawn 后 true，寿命结束后回 false', () => {
  // 同 flame-sigil 的池化用例
});

test('spike fx: NaN nowMs / NaN 落点不污染池', () => {
  // 同 flame-sigil 的 NaN 守卫用例
});
```
注册进 `src/tests/index.html`（紧邻 `test-flame-sigil.js`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现渲染器**

Create `src/render/spike-fx.js`，照 `flame-sigil.js` 的池化口径：
- `ConeGeometry(SPIKE_FX.radius, SPIKE_FX.height, 6)`，`translate(0, height/2, 0)`（底面落在 y=0）
- `MeshBasicMaterial({transparent:true, blending:AdditiveBlending, depthWrite:false, toneMapped:false})`
- 颜色 `SPIKE_FX.color = [1.0, 0.45, 0.12]`，逐实例 `setColorAt` 做亮度包络
  （⚠️ **不写共享 `material.opacity`** —— v3.04b 实测教训：多段递延淡出会互相拖着满亮）
- `spikeScaleAt`：`age < delay` ⇒ 不可见；`lived < riseMs` ⇒ `scale = lived/riseMs`；
  `lived < lifeMs × holdUntil` ⇒ 1；之后线性降到 0；`lived >= lifeMs` ⇒ done
- `frustumCulled = false`、零活跃 `visible = false`、模块级临时矩阵

- [ ] **Step 4: 跑测试确认通过**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: PASS

---

### Task 6: 装配与伤害结算

**Files:**
- Modify: `src/core/game.js`（装配 / update / dispose / `_consumeIgnisFxRequests`）
- Modify: `src/render/audio-config.js`（`IGNIS_ATTACK_SOUNDS.spikeSlash`）
- Modify: `src/render/ignis-renderer.js`（按 `spikeSecond` 选片段）
- Test: `src/tests/test-spike-fx.js`（伤害判据）+ `src/tests/test-ignis-render.js`（片段选择）

**Interfaces:**
- Consumes: Task 4 的 `state.spikeSecond` / Task 5 的 `SpikeFxRenderer` / `spikeSpawnPoints`
- Produces: `game.spikeFx`（实例）；`_consumeIgnisFxRequests` 里 `kind === 'spikeSlash'` 分支

- [ ] **Step 1: 写失败测试**

在 `src/tests/test-spike-fx.js` 追加（造壳手法同 `test-flame-sigil.js` 的 `Object.create(Game.prototype)`）：
```js
test('spike fx: 玩家站在尖刺格内扣 18，格外不扣', () => {
  // 注入 world.isSolid / player.physics.overlapsBlock / _damagePlayer 记账
  // 5 根刺在正前方 2/4/6/8/10 格；玩家在第 3 根（6 格）⇒ 扣 18
  // 玩家在 5 格（两根之间的间隙）⇒ 不扣
});

test('spike fx: 一次命中帧只扣一次（Review Focus 2）', () => {
  // 同一个 attackFxRequest 消费两次（模拟重复消费）⇒ 第二次不扣
  // 或：连续 update 30 帧 ⇒ 只扣一次
});

test('spike fx: 尖刺伤害不看视线（与原版 ShieldSmashDamage 一致）', () => {
  // attackFxRequest 存在但 freshLos 为假 ⇒ 仍扣 18
});
```
在 `src/tests/test-ignis-render.js` 追加：
```js
test('焰魔渲染(v3.06): spikeSecond 决定播 spikeSlash 还是 spikeSlash2', async () => {
  // st.attackKind='spikeSlash' + spikeSecond=false ⇒ 采样 spikeSlash
  // spikeSecond=true ⇒ 采样 spikeSlash2
  // 产物缺 spikeSlash2 时回落 spikeSlash（不抛错）
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: FAIL —— `game.spikeFx` undefined / 渲染器不认 `spikeSecond`

- [ ] **Step 3: 实现装配与结算**

在 `src/core/game.js`：
- import `SpikeFxRenderer, spikeSpawnPoints` + `IGNIS_SPIKE`
- 装配 `this.spikeFx = new SpikeFxRenderer({ scene: this.scene })`（无贴图依赖，恒装配）
- `update` 链加 `this.spikeFx.update(nowMs)`（紧邻 `this.flameSigil?.update`）
- `dispose()` 加 `this.spikeFx?.dispose()`
- `_consumeIgnisFxRequests`：把现有 `if (req.kind !== 'shieldSmash' && req.kind !== 'shieldBash') continue;`
  改为三招放行；`spikeSlash` 分支：
  - 5 根落点逐根 `this._findSigilGroundY(p.x, p.z, req.at[1])`，null 则跳过该根
  - `this.spikeFx.spawn(points, nowMs)`
  - **伤害**：逐根判 `this.player.physics.overlapsBlock(floor(x), floor(y), floor(z))`
    ⇒ 命中则 `this._damagePlayer(IGNIS_SPIKE.damage)` 并 **break**（一次命中帧只扣一次）
  - 碎石圆环复用现有 `spawnSmashRing`（三招共用）
- ⚠️ **去重**：`attackFxRequest` 是瞬态（Agent 下一帧清 null），故天然只消费一次；
  但 `_consumeIgnisFxRequests` 每帧跑 ⇒ 加 `if (this._lastSpikeFxAt === req)` 之类的守卫？
  **不需要** —— 瞬态字段已保证。测试用「连续 update 30 帧」验证。

在 `src/render/ignis-renderer.js` 的 `wantClip` 三元链末尾加：
`: st.attackKind === 'spikeSlash' ? (st.spikeSecond ? 'spikeSlash2' : 'spikeSlash')`
（放在 `shieldBash` 之后、`: 'attack'` 之前）

在 `src/render/audio-config.js`：`IGNIS_ATTACK_SOUNDS.spikeSlash = 'ignis_attack_smash'`
（复用既有音，注释记「近似替代，原版是 TOTEM_USE」）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: PASS

- [ ] **Step 5: 跑门禁**

Run: `npm run check`
Expected: arch + data + lint 全绿（`[焰魔]` 指纹已在 Task 2 重烘）
⚠️ 新增 lint warning 不得称作「既有基线」—— 单独跑 `npx eslint <改过的文件>` 确认零 warning

---

### Task 7: Tier 4 像素实测

**Files:**
- Create: `tests/ignis-spike.spec.mjs`
- Modify: `docs/roadmap.md`（登记 v3.06）

**Interfaces:**
- Consumes: Task 6 的 `game.spikeFx` / `_consumeIgnisFxRequests`
- Produces: 像素实测证据（橙红像素数上下界 + draw call 基线）

- [ ] **Step 1: 写 spec（先跑一次打印实际值，再定阈值）**

Create `tests/ignis-spike.spec.mjs`，逐行复用 `tests/ignis-fx.spec.mjs` 的
`waitWorldReady` / `gotoOpenField` / `setupScene` / `shoot`：
- 判据函数 `spikeCount(png)`：`r > g + 40 && g > b + 20 && r − b > 120`（橙红）
- **藏掉焰魔本体**（`inst.mesh.visible = false`）—— v3.04 实测教训：焰魔自己是火焰橙，
  不藏它判据被 ±18000 像素噪声淹没
- 噪声底：同状态重复截图 3 次取 max
- 注入：同一帧内取基线 + `spikeFx.spawn(...)`（零 CDP 间隙）
- 前提断言：`spikeFx` 已装配、几何 `radialSegments === 6`、零活跃 `visible === false`、
  `blending === AdditiveBlending`
- **先只 console.log 实测值不断言**，跑一次拿到数字

- [ ] **Step 2: 跑一次取实测值**

Run: `npx playwright test tests/ignis-spike.spec.mjs`
Expected: 打印 `SPIKE_COUNTS {baseCounts, noiseFloor, onCount, onWhite, ...}`

- [ ] **Step 3: 按实测值钉上下界**

下界取 `noiseFloor + (onCount − noiseFloor) × 0.45`，上界取 `noiseFloor + (onCount − noiseFloor) × 1.6`
（两侧余量对称，同 v3.04b 口径）；另钉 `nearWhiteCount` 上界防 additive 烧成白团。
⚠️ **阈值必须来自 Step 2 的实测，不得拍脑袋**。

- [ ] **Step 4: 负向验证（判别力自检）**

临时把 `spikeFx.update` 里的 `visible` 强制 false（尖刺永不上屏），跑 spec ⇒ **必须 FAIL**。
⚠️ 撤销注入用 `cp` 副本还原，**禁止 `git checkout`**（仓库有未提交改动）。

- [ ] **Step 5: 水面顺序回归 + draw call**

Run: `npx playwright test tests/water-order.spec.mjs`
Expected: PASS（新池入列本身不会让它红 —— 它 filter 掉 'other'；这条是回归确认）

- [ ] **Step 6: 登记 roadmap**

在 `docs/roadmap.md` 版本表加 v3.06 行：改动摘要 + 实测数字（帧数 / 命中帧 / 像素上下界 / 门禁结果）。

---

## Self-Review

**1. Spec coverage**
- §2 调研结论 → Task 1/2（素材配对与段表）✓
- §4.3 时间重映射两张表 → Task 1 Step 3 ✓
- §5.1 烘焙 → Task 1/2 ✓
- §5.2 玩法档案 → Task 3 ✓
- §5.3 Agent → Task 4 ✓
- §5.4 尖刺渲染器 → Task 5 ✓
- §5.5 接线与伤害 → Task 6 ✓
- §5.6 音效 → Task 6 Step 3 ✓
- §6 验证 → 各 Task 的测试步骤 + Task 7 ✓
- §4.2「feetOffsetY 不刷新」→ Task 2 Step 5 ✓
- §4.2「入场硬切 ≤0.26° ⇒ 默认 0.2s 淡入」→ **无需改动**（`ignisBlendSeconds` 回落默认），
  但 Task 6 的渲染用例应顺带断言 `ignisBlendSeconds('spikeSlash') === 0.2`（已并入 Step 1 的渲染用例）

**2. Step scan**：每步一个动作 + 一个可检查结果。Task 1 Step 1 的探针不入库（避免 `.tmp-*` 污染）；
Task 7 Step 1 明确「先打印不断言」（AGENTS.md：断言前先跑真实数据）。

**3. Type consistency**：`spikeSpawnPoints` / `spikeScaleAt` / `SpikeFxRenderer` 在 Task 5 定义、
Task 6 消费，签名一致；`IGNIS_SPIKE` 字段在 Task 3 定义、Task 4/5/6 消费，名称一致；
`ignisAnimTimeWarp` 的 `blendAt` 在 Task 1 定义、Task 2 消费 ✓

**4. Review Focus**：5 条各有归属任务与用例 ✓

**5. Proportion**：计划 ~330 行 vs spec ~230 行。代码块只含测试断言（不含实现体），
实现步骤给签名 + 值 + 口径警告，不是程序转录 ✓