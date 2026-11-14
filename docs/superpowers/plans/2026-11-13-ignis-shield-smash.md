# 焰魔盾击（Shield Smash）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给焰魔加第三招「盾击」（贴身重击），复用 v2.75 已建好的档案表 + 清单化烘焙轨道，零新增美术资源。

**Architecture:** 素材 `ignis.attack1` 已入库，只需在 `IGNIS_ANIM_SOURCES` 加一条让烘焙器多导出一条动画；玩法数值进 `IGNIS_ATTACKS` 第三档；抽签增加「玩家贴身才纳入」的候选过滤；渲染器 `clipKey` 从二元扩成三元；音效入库一个现成 ogg。结算层（`game.js`）与门禁（`check-data.mjs`）**零改动** —— 它们已按 `req.kind` / `IGNIS_ATTACK_ANIM_KEYS` 派生。

**Tech Stack:** 原生 ES module + three r185.1（WebGPU）；浏览器内单测（`src/tests/`）+ Playwright（`tests/`）；node 烘焙脚本（`tools/`）。

**Spec:** `docs/superpowers/specs/2026-11-13-ignis-shield-smash-design.md`

## Global Constraints

- 依赖方向 `voxel ← gen ← mesh ← render`；`src/entities/**` 属 Worker 同构层（红线 8）：**不得 import three、不得自建 Worker、无 DOM**。
- 同一事实只有一份权威（红线 1）：招式数值只在 `IGNIS_ATTACKS`；音效映射只在 `IGNIS_ATTACK_SOUNDS`；衔接时长只在 `ignisBlendSeconds`。
- 时间基准一律 `performance.now()`，禁止 `Date.now()`。
- 资源路径只能走 `resourceUrl()`；本计划不涉及新资源 URL（音效走既有 `soundFileName()`）。
- `src/tests/test-*.js` 必须已在 `src/tests/index.html` 注册 —— 本计划**只改既有 5 个已注册文件**（`test-ignis-bake` / `test-ignis-system` / `test-ignis-boss-agent` / `test-ignis-render` / `test-bgm`），**不新建测试文件**，故无需改注册表。
- 提交用 Conventional Commits；**每个 Task 末尾的 commit 步骤需用户已授权提交**，未授权时跳过该步并在最终报告里说明。
- 负向验证撤销注入**必须用 `cp` 副本还原**，禁止对含未提交改动的文件用 `git checkout` / `git restore`。
- 工作区有并发会话的未提交改动（`index.html` / `src/core/*` / `src/main.js` / `mch-*.mjs` 等）：**只暂存本计划明确列出的路径**，禁止 `git add -A` / `git add .`。
- 盾击档案的精确值（全文唯一权威，各 Task 引用这里）：
  `hitRange: 4.85` / `hitConeDeg: 22.5` / `hitFrameSeconds: 1.70` / `animSeconds: 3.50` / `weight: 0.2`
- 另两招权重同步改为 `swing: 0.56` / `spin: 0.24`（保持原 7:3 比例，三档和 = 1）。
- `IGNIS_AI.attackCooldownMin: 3.5 → 4.0`；`IGNIS_AI.smashEngageRange: 3.0`（新增）。
- 音效 id `ignis_attack_smash`，文件 `assets/sounds/ignis_attack_smash.ogg`，音量 `0.5`，扩展名 `ogg`。
- 素材来源 sha256（入库核对用）：`52e8c2f47958f15b6943f34ed8adcde72ef620a501e4ea64a1f8e1d29b24ab7a`

## Review Focus

spec 隐含、但没有任何 Task 的测试直接覆盖的五类输入/失效形态（最可能咬到玩家的排在前面）。每条都已指派给 owning Task 并在该 Task 内补了步骤：

1. **`feetOffsetY` 被新招压低 ⇒ 焰魔整体上浮/入地**（烘焙器扫全部招式动画算脚底补偿；加入 `attack1` 可能改变全局最低点，进而使 `IGNIS_CORE_OBB.center[1]` 的冻结值 1.5106 失配）。→ Task 2 Step 6/7。
2. **玩家站在 4.25~4.85 格之间时盾击仍应命中**（spec §6.2 记了我自己算错过一次的边界；只测 2.5 与 5.0 两点会让「射程写成 4.0」这类缺陷漏网）。→ Task 6 Step 2。
3. **`attackKind='shieldSmash'` 但产物缺该动画键**（旧产物 + 新代码：渲染器取 `animations.shieldSmash` 得 undefined ⇒ 采样抛错或空姿态）。→ Task 4 Step 2。
4. **贴身阈值边界上的抽签抖动**（玩家正好在 3.0 格来回晃，盾击时有时无；`<` 与 `<=` 的口径必须钉死）。→ Task 3 Step 2。
5. **盾击命中后玩家跑开 ⇒ 冷却仍被正确消耗**（冷却在命中帧置位，若盾击走了不同分支会漏置 ⇒ 贴脸时无间隔连砸）。→ Task 3 Step 3。

---

### Task 1: 音效素材入库 + 清单接线

**Files:**
- Create: `assets/sounds/ignis_attack_smash.ogg`（从 mod 素材拷贝，逐字节原样）
- Modify: `src/render/audio-config.js`（`SOUND_IDS` / `SOUND_EXT_OVERRIDES` / `SOUND_VOLUMES` / `IGNIS_ATTACK_SOUNDS` 各加一条）
- Test: `src/tests/test-bgm.js`（改既有两条断言的口径 + 加一条）

**Interfaces:**
- Consumes: 无（本 Task 是起点）
- Produces: 音效 id 字符串 `'ignis_attack_smash'`；`IGNIS_ATTACK_SOUNDS.shieldSmash`；`ignisAttackSound('shieldSmash') → 'ignis_attack_smash'`

⚠️ **本 Task 先于 Task 2 做，但它的单测会红到 Task 2 完成**：`test-bgm.js:386` 断言
`IGNIS_ATTACK_SOUNDS` 的键集合与 `IGNIS_ATTACK_IDS` 完全一致，而 `shieldSmash` 要到 Task 2 才进档案表。
**这是预期的顺序依赖**，故本 Task 的 GREEN 判据只跑与音效自身相关的两条，键集合那条留到 Task 2 末尾一起绿。

- [ ] **Step 1: 拷素材并核对 sha256**

```bash
cp /Users/bachi/jaylli/cataclysm1.19.2modding/src/main/resources/assets/cataclysm/sounds/entity/sword_stomp.ogg \
   /Users/bachi/jaylli/mc-heavy/assets/sounds/ignis_attack_smash.ogg
shasum -a 256 /Users/bachi/jaylli/mc-heavy/assets/sounds/ignis_attack_smash.ogg
```

Expected: `52e8c2f47958f15b6943f34ed8adcde72ef620a501e4ea64a1f8e1d29b24ab7a`（与 Global Constraints 一致 ⇒ 逐字节原样，没有转码）

- [ ] **Step 2: 写失败测试**

在 `src/tests/test-bgm.js` 既有「`ignisAttackSound` 缺省/非法 attackKind 回落 swing」用例**之后**追加一条新 test（⚠️ 用 Edit 插入时 `oldText` 必须含前一条 test 的**完整 body 直到 `});`**，只含声明行会让后续 test 的 body 悬空）：

```js
test('audio-config(v2.98): 盾击起手音是 ignis_attack_smash（近似替代，不是原版 TOTEM_USE）', () => {
  assertEqual(IGNIS_ATTACK_SOUNDS.shieldSmash, 'ignis_attack_smash');
  assertEqual(ignisAttackSound('shieldSmash'), 'ignis_attack_smash');
  assertEqual(soundFileName('ignis_attack_smash'), 'ignis_attack_smash.ogg');
  assertTrue(SOUND_IDS.includes('ignis_attack_smash'), '必须进预载清单，否则静默无声');
  assertEqual(SOUND_EXT_OVERRIDES.ignis_attack_smash, 'ogg', '漏加扩展名表 ⇒ 按 .mp3 fetch 404 被 catch 吞');
  assertTrue(SOUND_VOLUMES.ignis_attack_smash > 0, '必须有正音量');
  // 三招两两不同（共用 = 加了招式却没接音，而数据层全绿）
  const ids = Object.values(IGNIS_ATTACK_SOUNDS);
  assertEqual(new Set(ids).size, ids.length, '三招起手音必须两两不同');
});
```

同时把既有那条「两招不得共用同一个音」的断言（`test-bgm.js` 内 `IGNIS_ATTACK_SOUNDS.swing !== IGNIS_ATTACK_SOUNDS.spin`）保留不动 —— 新用例的 `Set` 判据是它的超集，两条并存不冲突。

- [ ] **Step 3: 跑测试确认失败**

浏览器打开 `/src/tests/index.html`，读 `window.__MC_TEST_RESULTS__`（用 `suites.flatMap(s => s.tests)`）。
Expected: 新用例 FAIL，报 `IGNIS_ATTACK_SOUNDS.shieldSmash` 为 `undefined`。

- [ ] **Step 4: 接线四处**

在 `src/render/audio-config.js`：
- `SOUND_IDS` 数组加 `'ignis_attack_smash'`（放在 `'ignis_attack_circle'` 之后，带一行注释说明它是盾击起手音、来源是 mod 的 `sword_stomp.ogg`、**是原版 `TOTEM_USE` 的近似替代而非原音**）；
- `SOUND_EXT_OVERRIDES` 加 `ignis_attack_smash: 'ogg'`；
- `SOUND_VOLUMES` 加 `ignis_attack_smash: 0.5`（与另两招同档）；
- `IGNIS_ATTACK_SOUNDS` 加 `shieldSmash: 'ignis_attack_smash'`。

⚠️ `IGNIS_ATTACK_SOUNDS` 的文档注释里「v2.75 起焰魔有两招」需同步改成三招，否则文档与代码分裂。

- [ ] **Step 5: 跑测试确认新用例通过**

Expected: 新用例 PASS。键集合一致性那条仍 FAIL（`IGNIS_ATTACK_IDS` 还没有 `shieldSmash`）—— **这是预期**，Task 2 会补齐。

- [ ] **Step 6: 跑数据门禁的音效环节**

Run: `npm run check:data`
Expected: `[音效]` 环节报「23 个效果音 … 均有对应文件」（原 22 + 1）。若报缺文件 ⇒ Step 1 的路径或文件名写错了。

- [ ] **Step 7: Commit**

```bash
git add assets/sounds/ignis_attack_smash.ogg src/render/audio-config.js src/tests/test-bgm.js
git commit -m "feat(ignis): 盾击起手音入库并接进音效清单"
```

---

### Task 2: 烘焙参数 + 盾击档案 + 冷却下限

**Files:**
- Modify: `tools/ignis-fingerprint.mjs`（`IGNIS_ANIM_SOURCES` / `IGNIS_ANIM_PERIODS` 各加一条）
- Modify: `src/entities/ignis/ignis-config.js`（`IGNIS_ATTACKS` 加第三档、改另两档 weight、`attackCooldownMin` 4.0、新增 `smashEngageRange`）
- Modify: `src/tests/test-ignis-bake.js`（动画清单 + 三条盾击契约）
- Modify: `src/tests/test-ignis-system.js`（档案形状键集合、命中帧派生值、盾击档案数值）
- Regenerate: `assets/ignis/ignis.json` / `ignis.png` / `ignis.meta.json`（跑 `npm run ignis`，**不手改**）

**Interfaces:**
- Consumes: Task 1 的 `IGNIS_ATTACK_SOUNDS.shieldSmash`
- Produces:
  - `IGNIS_ATTACKS.shieldSmash = { hitRange, hitConeDeg, hitFrameSeconds, animSeconds, weight }`（值见 Global Constraints）
  - `IGNIS_ATTACK_IDS = ['swing', 'spin', 'shieldSmash']`（声明顺序 = 抽签顺序，盾击**必须排最后**）
  - `IGNIS_AI.smashEngageRange: 3.0`、`IGNIS_AI.attackCooldownMin: 4.0`
  - 产物 `animations.shieldSmash`：`{ fps: 30, frameCount: 105, boneIndices: number[9], frames: number[] }`

- [ ] **Step 1: 写失败测试（烘焙契约）**

在 `src/tests/test-ignis-bake.js` 改既有用例 + 追加三条：

① 既有「产物存在且动画清单是 idle + attack + spin」的 `assertEqual(Object.keys(d.animations).sort().join(','), 'attack,idle,spin')` 改成 `'attack,idle,shieldSmash,spin'`，用例标题同步改。

② 追加：

```js
test('焰魔烘焙(v2.98): shieldSmash 帧数 = round(3.5 × 30) = 105，fps 30，驱动 9 根骨骼', async () => {
  const d = await loadAsset();
  const a = d.animations.shieldSmash;
  assertEqual(a.fps, 30);
  assertEqual(a.frameCount, 105);
  // ⚠️ 9 根是 attack1 的实测骨骼数；接成 attack1_2（11 根）会在这里红
  assertEqual(a.boneIndices.length, 9);
  assertEqual(a.frameCount / a.fps, 3.5);
});

test('焰魔烘焙(v2.98): shieldSmash 是盾臂抡砸 —— left_arm_joint 绕 X 行程 ≥ 60°', async () => {
  const d = await loadAsset();
  const a = d.animations.shieldSmash;
  const idx = d.bones.findIndex((b) => b.name === 'left_arm_joint');
  const slot = a.boneIndices.indexOf(idx);
  assertTrue(slot >= 0, 'shieldSmash 没有驱动 left_arm_joint（盾臂）—— 接错动画了');
  // 取 t=1.0（蓄力到位，素材 −30°）与 t=1.75（砸下，素材 +35°）两帧的增量四元数夹角
  const quatAt = (t) => {
    const f = Math.round(t * a.fps);
    const o = (f * a.boneIndices.length + slot) * 7;
    return [a.frames[o], a.frames[o + 1], a.frames[o + 2], a.frames[o + 3]];
  };
  const swingDeg = quatAngleDeg(quatAt(1.0), quatAt(1.75));
  // ⚠️ 判据落在盾臂行程，不是 root.y 幅度：盾击 root.y 只到 30°，
  // 用「root 转角大」会把它误判成小横扫（spec §6.3）
  assertTrue(swingDeg >= 60,
    `盾臂行程只有 ${swingDeg.toFixed(1)}°（< 60°）—— 接成了别的动画`);
  assertTrue(swingDeg <= 90,
    `盾臂行程 ${swingDeg.toFixed(1)}° 超过 90°（素材实测 65°，接错动画？）`);
});
```

⚠️ `quatAngleDeg` 在 `test-ignis-render.js` 里已有同名辅助，但**本文件没有** ⇒ 需在 `test-ignis-bake.js` 内自带一个（两文件不互相 import，保持各自独立）。实现：`2 * acos(clamp(|dot(q1,q2)|, 0, 1)) * 180/π`。

③ 追加「命中帧落在动画内」：`Math.round(1.70 * 30) = 51 < 105`。

- [ ] **Step 2: 跑测试确认失败**

Expected: 三条新用例 FAIL（`d.animations.shieldSmash` 为 undefined），清单那条也 FAIL。

- [ ] **Step 3: 加烘焙参数**

在 `tools/ignis-fingerprint.mjs`：
- `IGNIS_ANIM_PERIODS` 加 `shieldSmash: 3.5`，注释写明 = Java `Animation.create(70)` ÷ 20，素材 `attack1`；
- `IGNIS_ANIM_SOURCES` 加 `shieldSmash: Object.freeze(['attack1'])`，注释写明**不是 `attack1_2`**（那是 3s / 11 骨骼的另一招，扫描差 72.5°），鉴别依据引 spec §2.2。

⚠️ `tools/bake-ignis.mjs` **零改动** —— `IGNIS_ATTACK_ANIM_KEYS` 自动派生。

- [ ] **Step 4: 加盾击档案 + 改冷却 + 加贴身阈值**

在 `src/entities/ignis/ignis-config.js`：
- `IGNIS_ATTACKS` 追加 `shieldSmash` 档（**排在 `spin` 之后**，抽签顺序载荷性），五项值见 Global Constraints，注释标注来源 `AreaAttack(4.85, 2.5, 45, …)` / tick 34 / `Animation.create(70)`，并写明 **22.5 是半角**；
- `swing.weight` 0.7 → 0.56、`spin.weight` 0.3 → 0.24，注释说明「按原 7:3 缩放到 0.8，保持非贴身时的相对手感」；
- `attackCooldownMin` 3.5 → 4.0，注释补「盾击动画 3.50 与旧下限相等会破坏不变式；命中后剩 1.80s，4.0 留 2.20s 余量」；
- `IGNIS_AI` 新增 `smashEngageRange: 3.0`，注释标注来源 Java `tick()` 的 `distanceTo(target) < 3F`，并写明**不改「不动如山」**（`_ringIntent` 不动）。

⚠️ 文件头的「数值来源」表与 `IGNIS_ATTACKS` 的「两招的来源」表都要补第三行，否则文档与代码分裂。

- [ ] **Step 5: 改既有断言的口径（不是放宽）**

在 `src/tests/test-ignis-system.js`：
- 档案形状用例：`assertEqual(Object.keys(IGNIS_ATTACKS).sort().join(','), 'spin,swing')` → `'shieldSmash,spin,swing'`；
- 命中帧用例：`assertEqual(IGNIS_AI.hitFrameSeconds, 1.20)` → `1.70`，标题从「= SWING_ATTACK 的 tick 24 / 20」改为「= 各招最大者（盾击 tick 34 / 20）」，并**保留** `IGNIS_ATTACKS.swing.hitFrameSeconds === 1.20` 的单招断言（派生值变了，单招值没变）；
- 追加盾击档案用例：四项数值 + `hitConeDeg < 45`（半角守卫）+ `hitFrameSeconds < animSeconds` + `animSeconds === 3.5`；
- 追加不变式用例：`IGNIS_AI.smashEngageRange < IGNIS_ATTACKS.shieldSmash.hitRange`（抽到时必在射程内）。

在 `src/tests/test-ignis-boss-agent.js`：冷却不变式那条读的是 `IGNIS_AI.attackCooldownMin > IGNIS_AI.attackAnimSeconds`（派生关系），**零改动**自动成立（4.0 > 3.5）。跑一遍确认。

- [ ] **Step 6: 重烘焙并核对 feetOffsetY 是否变化（Review Focus #1）**

```bash
npm run ignis
```

Expected: 日志出现 `动画 shieldSmash: 105 帧 × 9 骨骼 @ 30fps（attack1）`。

**然后必须读实际值**，不得预设它没变：

```bash
node -e "const m=require('./assets/ignis/ignis.meta.json');console.log('feetOffsetY =',m.metrics.feetOffsetY)"
```

- 若仍是 `-0.265625` ⇒ 冻结值不动，进 Step 8。
- 若变了 ⇒ 进 Step 7。

⚠️ spec 的 v2.75 教训：**设计期预测被实测否决过**（当时预测会变、实测一个数没动）。所以这里只按实测走，两个分支都不预设。

- [ ] **Step 7: 仅当 feetOffsetY 变了才做 —— 重标 IGNIS_CORE_OBB.center[1]**

`IGNIS_CORE_OBB.center[1] = IGNIS_MODEL_CENTER[1] + feetOffsetY`（`test-ignis-system.js` 钉住这条关系）。
按新 `feetOffsetY` 算出新的 `center[1]`（4 位小数），改 `ignis-config.js` 的该字段 + `test-ignis-system.js` 里写死 `1.5106` 的那条断言，并在注释里记下「v2.98 因加入盾击动画重标，旧值 1.5106」。

⚠️ **这是重标基线，不是放宽容差**（用户既有裁定：冻结断言因预期代价越线时重标实测值，不放大容差）。`halfExtents` 与 `MODEL_CENTER` 不受影响（它们来自 bind pose，与动画无关）—— 若它们也变了，说明烘焙器出了别的问题，**停下来报告**。

- [ ] **Step 8: 跑全部相关单测 + 门禁**

浏览器 `/src/tests/index.html`：Expected 全绿，含 Task 1 遗留的键集合一致性那条（`IGNIS_ATTACK_IDS` 现在有三档了）。

Run: `npm run check`
Expected: 三门全绿。`check:data` 的 `[焰魔]` 环节应报四条动画（idle/attack/spin/shieldSmash）帧数与指纹均对。

- [ ] **Step 9: Commit**

```bash
git add tools/ignis-fingerprint.mjs src/entities/ignis/ignis-config.js \
        src/tests/test-ignis-bake.js src/tests/test-ignis-system.js \
        assets/ignis/ignis.json assets/ignis/ignis.png assets/ignis/ignis.meta.json
git commit -m "feat(ignis): 盾击档案与 attack1 烘焙，冷却下限抬到 4.0"
```

---

### Task 3: 抽签的贴身门（四象限）

**Files:**
- Modify: `src/entities/bosses/ignis-boss-agent.js`（`_rollAttackKind` 签名与候选过滤 + 调用点传参）
- Test: `src/tests/test-ignis-boss-agent.js`（四象限 + 边界 + 冷却消耗）

**Interfaces:**
- Consumes: `IGNIS_ATTACK_IDS`（三档）、`IGNIS_AI.smashEngageRange`、`IGNIS_ATTACKS[*].weight`
- Produces: `_rollAttackKind(spinBlocked: boolean, smashAllowed: boolean) → 'swing'|'spin'|'shieldSmash'`

⚠️ **签名从一参扩成两参**，不是把距离传进去：Agent 的抽签函数保持「只管候选集与权重」，
距离判断留在调用点（与既有 `spinCooldown > 0` 同一分工）。

- [ ] **Step 1: 写失败测试（四象限 + Review Focus #4/#5）**

在 `src/tests/test-ignis-boss-agent.js` 追加。夹具用既有的 `st()` / `playerAt(d)` / `OPEN_CTX` / `runToAttackStart()`：

```js
test('焰魔 AI(v2.98): 贴身(<3格)才可能抽到盾击；非贴身恒不抽到', () => {
  // 非贴身：4.0 格（在 attackRange 5.5 内 ⇒ 会起手，但超出 smashEngageRange）
  const far = { ...OPEN_CTX, player: playerAt(4.0) };
  for (const r of [0, 0.3, 0.5, 0.8, 0.999999]) {
    const a = new IgnisBossAgent({ rng: () => r });
    const s = runToAttackStart(a, st({ mode: 'chase', onGround: true }), far);
    assertEqual(s.mode, 'attack');
    assertTrue(s.attackKind !== 'shieldSmash',
      `非贴身(4.0格) rng=${r} 抽到了盾击（贴身门失效）`);
  }
  // 贴身：2.5 格 + rng≈1 ⇒ 落在最后一档（盾击）
  const near = { ...OPEN_CTX, player: playerAt(2.5) };
  const a = new IgnisBossAgent({ rng: () => 0.999999 });
  const s = runToAttackStart(a, st({ mode: 'chase', onGround: true }), near);
  assertEqual(s.attackKind, 'shieldSmash', '贴身 + rng≈1 应抽中最后一档（盾击）');
});

test('焰魔 AI(v2.98): 贴身阈值边界取严格小于（3.0 格本身不算贴身）', () => {
  const at = { ...OPEN_CTX, player: playerAt(IGNIS_AI.smashEngageRange) };
  const a = new IgnisBossAgent({ rng: () => 0.999999 });
  const s = runToAttackStart(a, st({ mode: 'chase', onGround: true }), at);
  assertTrue(s.attackKind !== 'shieldSmash',
    '恰好 3.0 格不应算贴身（Java 是 distanceTo < 3F，严格小于）');
});

test('焰魔 AI(v2.98): 旋斩冷却未好时，贴身仍可从 swing/盾击 里抽', () => {
  const near = { ...OPEN_CTX, player: playerAt(2.5) };
  const a = new IgnisBossAgent({ rng: () => 0.999999 });
  const s = runToAttackStart(a,
    st({ mode: 'chase', onGround: true, spinCooldown: 5 }), near);
  assertEqual(s.attackKind, 'shieldSmash',
    '旋斩被屏蔽后最后一档是盾击（候选集去掉旋斩，不是抽中再改判）');
});

test('焰魔 AI(v2.98): 盾击命中后冷却正常置位（玩家跑开也不连砸）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.999999 });
  const ctx = { ...OPEN_CTX, player: playerAt(2.5) };
  let s = st({ mode: 'attack', attackAnimT: 0, attackKind: 'shieldSmash', onGround: true });
  for (let i = 0; i < 200 && !s.attackRequest; i++) s = a.update(s, 1 / 60, ctx);
  assertNotNull(s.attackRequest);
  assertEqual(s.attackRequest.kind, 'shieldSmash');
  assertTrue(s.attackCooldown >= IGNIS_AI.attackCooldownMin - 1 / 60 - 1e-9,
    `盾击命中后冷却 ${s.attackCooldown} 未按 [4.0, 6.0] 置位`);
});
```

- [ ] **Step 2: 跑测试确认失败**

Expected: 第一条的「贴身 + rng≈1」FAIL（当前 rng≈1 抽到 spin），第三条 FAIL。边界那条可能**假绿**（当前没有盾击，恒不抽到）—— 它的判别力靠 Step 4 之后的负向验证保证。

- [ ] **Step 3: 改 `_rollAttackKind` 与调用点**

`_rollAttackKind(spinBlocked, smashAllowed)`：候选集按两维过滤 —— `spinBlocked` 去掉 `'spin'`，`!smashAllowed` 去掉 `'shieldSmash'`。其余（总权重归一、浮点边界取末档）不动。

调用点（`mode === 'chase'` 迁入 attack 处）：
```js
attackKind = this._rollAttackKind(spinCooldown > 0, hDist < IGNIS_AI.smashEngageRange);
```

⚠️ `hDist` 是该分支已有的水平距变量，直接复用，不重新算。
⚠️ 盾击**不置独立冷却**（spec §5.2：距离门本身就是低频门）。`if (attackKind === 'spin')` 那行不动。
⚠️ `_ringIntent` **完全不动** —— 焰魔不为了出盾击而贴近。

- [ ] **Step 4: 跑测试确认通过**

Expected: 四条新用例全绿；既有「rng=0 ⇒ swing / rng≈1 ⇒ spin」那条**仍绿**（它用 `playerAt(attackRange - 1) = 4.5` 格，非贴身 ⇒ 候选集仍是 swing/spin，rng≈1 落 spin）。

⚠️ 若那条红了，说明贴身门写成了「恒允许」或候选顺序错了 —— 停下来查，不要改那条断言。

- [ ] **Step 5: Commit**

```bash
git add src/entities/bosses/ignis-boss-agent.js src/tests/test-ignis-boss-agent.js
git commit -m "feat(ignis): 盾击只在玩家贴身 3 格内进入抽签池"
```

---

### Task 4: 渲染器选片段 + 衔接时长

**Files:**
- Modify: `src/render/ignis-renderer.js`（`clipKey` 三元）
- Modify: `src/entities/ignis/ignis-config.js`（`ignisBlendSeconds` 的注释；盾击走默认 0.2s，**逻辑可能零改动**）
- Test: `src/tests/test-ignis-render.js`

**Interfaces:**
- Consumes: 产物 `animations.shieldSmash`（Task 2）、`state.attackKind`（Task 3）
- Produces: 渲染器对 `attackKind='shieldSmash'` 发布 `animations.shieldSmash` 的姿态

- [ ] **Step 1: 写失败测试（含 Review Focus #3）**

在 `src/tests/test-ignis-render.js` 追加：

```js
test('焰魔渲染(v2.98): attackKind="shieldSmash" 时用 shieldSmash 动画（三招姿态互不相同）', async () => {
  const d = await getAsset();
  const scene = new THREE.Scene();
  const r = new IgnisRenderer(scene, d);
  const base = { position: [0, 0, 0], yaw: 0, health: 1000, flashedUntil: 0, attackCooldown: 0 };
  let clock = 0;
  const poseOf = (state) => {
    clock = settle(r, { id: 'a', state: { ...base, ...state } }, clock);
    return r.instances[0].bones.map((b) => b.quaternion.toArray());
  };
  const dist = (p, q) => {
    let s = 0;
    for (let i = 0; i < p.length; i++) for (let k = 0; k < 4; k++) s += Math.abs(p[i][k] - q[i][k]);
    return s;
  };
  // 取 1.0s：盾击此时蓄力到位（盾臂 −30°），与另两招形态差别最大
  const swing = poseOf({ attackAnimT: 1.0, attackKind: 'swing' });
  const spin = poseOf({ attackAnimT: 1.0, attackKind: 'spin' });
  const smash = poseOf({ attackAnimT: 1.0, attackKind: 'shieldSmash' });
  assertTrue(dist(smash, swing) > 0.2,
    `盾击与横扫在 1.0s 的姿态差仅 ${dist(smash, swing).toFixed(4)} —— 渲染器没按 attackKind 选动画`);
  assertTrue(dist(smash, spin) > 0.2,
    `盾击与旋斩在 1.0s 的姿态差仅 ${dist(smash, spin).toFixed(4)}`);
  const legacy = poseOf({ attackAnimT: 1.0 });
  assertTrue(dist(legacy, swing) < 1e-9, '缺 attackKind 时应回落 attack（swing）动画');
  r.dispose();
});

test('焰魔渲染(v2.98): 产物缺 shieldSmash 键时不抛错、回落 attack（旧产物 + 新代码）', async () => {
  const d = await getAsset();
  const stripped = { ...d, animations: { ...d.animations } };
  delete stripped.animations.shieldSmash;
  const scene = new THREE.Scene();
  const r = new IgnisRenderer(scene, stripped);
  let clock = 0;
  const poseWith = (asset, renderer) => {
    clock = settle(renderer, { id: 'a', state: {
      position: [0, 0, 0], yaw: 0, health: 1000, flashedUntil: 0, attackCooldown: 0,
      attackAnimT: 1.0, attackKind: 'shieldSmash',
    } }, clock);
    return renderer.instances[0].bones.map((b) => b.quaternion.toArray());
  };
  // 不抛错（取 undefined 再采样会 TypeError）
  const got = poseWith(stripped, r);
  r.dispose();
  // 且回落成 attack 片段，而不是全 bind 的空姿态
  const r2 = new IgnisRenderer(new THREE.Scene(), stripped);
  clock = 0;
  clock = settle(r2, { id: 'a', state: {
    position: [0, 0, 0], yaw: 0, health: 1000, flashedUntil: 0, attackCooldown: 0,
    attackAnimT: 1.0, attackKind: 'swing',
  } }, clock);
  const want = r2.instances[0].bones.map((b) => b.quaternion.toArray());
  let gap = 0;
  for (let i = 0; i < got.length; i++) for (let k = 0; k < 4; k++) gap += Math.abs(got[i][k] - want[i][k]);
  assertTrue(gap < 1e-9, `缺键时应回落 attack 片段，实际姿态差 ${gap.toFixed(4)}`);
  r2.dispose();
});

test('焰魔渲染(v2.98): 盾击淡入在命中帧之前走完，且补间单帧角不超片段自身上限', async () => {
  const d = await getAsset();
  assertEqual(ignisBlendSeconds('shieldSmash'), 0.2, '盾击入场用默认档（与横扫同）');
  assertTrue(ignisBlendSeconds('shieldSmash') < IGNIS_ATTACKS.shieldSmash.hitFrameSeconds,
    '淡入必须在命中帧之前走完 —— 命中那一刻画面要是完整盾击姿态');
  const limit = clipMaxStepDeg(d.animations.shieldSmash);   // ← 实测，不得照抄旋斩的 24.5°
  const period = d.animations.idle.frameCount / d.animations.idle.fps;
  let worst = 0;
  for (let i = 0; i < 8; i++) {
    const seq = simulateEntry(d, 'shieldSmash', (i / 8) * period,
      Math.ceil(ignisBlendSeconds('shieldSmash') * 60) + 6);
    for (let k = 1; k < seq.length; k++) worst = Math.max(worst, poseStepDeg(seq[k - 1], seq[k]));
  }
  assertTrue(worst <= limit,
    `盾击入场补间单帧最大角 ${worst.toFixed(1)}° 超过片段自身上限 ${limit.toFixed(1)}°`);
});
```

⚠️ 第三条的 `limit` **必须实测**（`clipMaxStepDeg`），不得照抄旋斩的 24.5° —— 那是旋斩片段的值。
spec §5.4 明确要求「不凭推理直接宣称通过」。实施后把 `limit` 与 `worst` 的实测值写进最终报告。

- [ ] **Step 2: 跑测试确认失败**

Expected: 第一条 FAIL（当前 `clipKey` 二元，盾击播成 attack ⇒ 姿态差 0）。第二条可能已绿（取决于当前取 undefined 的行为）—— 若它直接抛错，说明回落分支必须显式写。

- [ ] **Step 3: 改渲染器**

`src/render/ignis-renderer.js` 的 `clipKey`：

```js
const clipKey = st.attackKind === 'spin' ? 'spin'
  : st.attackKind === 'shieldSmash' ? 'shieldSmash' : 'attack';
```

⚠️ 加一层产物键存在性回落：`this.asset.animations[clipKey] ? clipKey : 'attack'`（Review Focus #3）。
注释写明「旧产物 + 新代码时回落，不抛错」。

- [ ] **Step 4: 衔接时长**

`ignisBlendSeconds` 当前 `sourceKey === 'spin' ? spinInSeconds : seconds` ⇒ 盾击**自动落默认 0.2s**，逻辑零改动。
只更新注释：把「`'idle' | 'attack' | 'spin'`」扩成四个键，并写明盾击用默认档的依据（起手是 1.0s 缓入，无旋斩那种 177° 硬切）。

- [ ] **Step 5: 跑测试确认通过 + 记录实测值**

Expected: 三条全绿。**把第三条实测出的 `limit` 与 `worst` 写进最终报告**（spec 要求实测证据，不凭推理）。
若 `worst > limit` ⇒ 不要放宽断言，按实测调 `IGNIS_POSE_BLEND` 并报告取舍。

- [ ] **Step 6: Commit**

```bash
git add src/render/ignis-renderer.js src/entities/ignis/ignis-config.js src/tests/test-ignis-render.js
git commit -m "feat(ignis): 渲染器按 attackKind 播盾击片段"
```

---

### Task 5: 负向验证（四处单变量注入）

**Files:**
- 临时修改被测文件（每处注入后立即还原）
- 备份放 `/tmp/`（`mktemp -d`）

**Interfaces:**
- Consumes: Task 1~4 的全部实现
- Produces: 四处注入各自的**真 FAIL 证据**（写进最终报告）

⚠️ 本 Task 不产生持久代码改动，**不 commit**。它的产出是「判据真的有判别力」的证据。

- [ ] **Step 1: 建备份目录并逐文件留 sha256**

```bash
BK=$(mktemp -d)
cp src/render/ignis-renderer.js "$BK/"
cp src/entities/ignis/ignis-config.js "$BK/"
cp src/entities/bosses/ignis-boss-agent.js "$BK/"
cp tools/ignis-fingerprint.mjs "$BK/"
shasum -a 256 src/render/ignis-renderer.js src/entities/ignis/ignis-config.js \
  src/entities/bosses/ignis-boss-agent.js tools/ignis-fingerprint.mjs
```

记下四个 sha256 与 `$BK` 路径。

- [ ] **Step 2: 注入① 渲染器恒播 attack**

把 `clipKey` 改回二元（`spin ? 'spin' : 'attack'`）→ 跑 Task 4 第一条用例。
Expected: FAIL，姿态差 ≈ 0。
还原：`cp "$BK/ignis-renderer.js" src/render/ignis-renderer.js`，核对 sha256 逐位一致。

- [ ] **Step 3: 注入② hitConeDeg 改 45**

`IGNIS_ATTACKS.shieldSmash.hitConeDeg` 22.5 → 45 → 跑 Task 2 的半角守卫用例。
Expected: FAIL（`hitConeDeg < 45` 不成立）。
还原 + sha256 核对。

- [ ] **Step 4: 注入③ 抽签不做贴身过滤**

调用点第二参恒传 `true` → 跑 Task 3 第一条用例。
Expected: FAIL（4.0 格 + rng≈1 抽到盾击）。
还原 + sha256 核对。

- [ ] **Step 5: 注入④ 烘焙源改成 attack1_2**

`IGNIS_ANIM_SOURCES.shieldSmash` → `['attack1_2']` → `npm run ignis` → 跑 Task 2 的帧数/骨骼数与盾臂行程用例。
Expected: FAIL（帧数 90 ≠ 105、骨骼 11 ≠ 9）。
还原 + `npm run ignis` 重烘 + sha256 核对（产物也要回到正确状态）。

- [ ] **Step 6: 确认全部还原**

四个源文件 sha256 与 Step 1 逐位一致；`npm run check` 三门全绿；相关单测全绿。

⚠️ 任一处**没有真红** ⇒ 那条判据没有判别力，**停下来报告并补强判据**，不要继续往下做。

---

### Task 6: Tier 4 像素与真实结算（E2E）

**Files:**
- Modify: `tests/ignis.spec.mjs`（三条新用例）
- Modify: `tests/boss-audio.spec.mjs`（起手音分流扩到三招）

**Interfaces:**
- Consumes: 全部实现（Task 1~4）
- Produces: 真实 WebGPU 下的像素与结算证据

- [ ] **Step 1: 姿态差用例（像素级）**

照既有「旋斩 vs 横扫是两个不同姿态」用例的夹具（`renderer.setAnimationLoop(null)` **冻结帧循环**后手动 `sync` + `render`，v2.83 的噪声底口径）。
三招两两截图差分，断言差异像素数 > 噪声底（先测同状态重复截图的噪声底，应为逐位 0）。

- [ ] **Step 2: 真实结算三点取样（含 Review Focus #2）**

玩家分别站 **2.5 / 4.5 / 5.0 格**，强制 `attackKind='shieldSmash'` 走到命中帧：

| 距离 | 期望 | 依据 |
|---|---|---|
| 2.5 | 扣 14 血 | `< hitRange 4.85` |
| 4.5 | **扣 14 血** | `< 4.85` ⚠️ 不是「打不中」 |
| 5.0 | 不掉血 | `> 4.85` |

⚠️ **4.5 格这一格是本用例的核心判别力**：只测 2.5 与 5.0 时，把 `hitRange` 误写成 4.0 也会全绿。
⚠️ 玩家位置用真实入口设置后**冻结焰魔朝向**（照 v2.78 的教训：靠 AI 自然转身制造前提是非确定性的）。

- [ ] **Step 3: 锥宽用例**

侧向 40° 处：盾击打不中（半角 22.5），旋斩打得到（半角 155）。同一位置对照 ⇒ 证明锥宽真的按招取。

- [ ] **Step 4: 起手音分流（三招）**

扩 `tests/boss-audio.spec.mjs` 既有「旋斩播 circle / 普攻播 swing」用例：rAF 逐帧探针记录起手事件与该帧三个音的播放增量，断言盾击起手 `ignis_attack_smash=1` 且另两个 `=0`。
⚠️ 前置断言「盾击起手必须非空」—— 需让玩家贴近 3 格内制造前提，否则测的是空集。

- [ ] **Step 5: 跑 E2E**

```bash
npx playwright test tests/ignis.spec.mjs tests/boss-audio.spec.mjs
```
Expected: 全绿（既有 16 + 新增 3；boss-audio 6 + 扩写 1）。

⚠️ 必须 `channel: 'chromium'`（配置里已有）。⚠️ 若在其他 worktree 跑，注意 8081 端口会复用主仓服务 ⇒ 测的是没改过的代码。

- [ ] **Step 6: Commit**

```bash
git add tests/ignis.spec.mjs tests/boss-audio.spec.mjs
git commit -m "test(ignis): 盾击的像素姿态、三点射程与起手音 E2E"
```

---

### Task 7: 全量门禁与文档登记

**Files:**
- Modify: `docs/roadmap.md`（新增 v2.98 行）
- Modify: `src/entities/ignis/ignis-config.js` / `src/render/audio-config.js`（仅文档注释，若前面漏改）

**Interfaces:**
- Consumes: 全部实现与验证证据
- Produces: roadmap 版本行（含实测数据）

- [ ] **Step 1: 跑最小充分回归**

```bash
npm run check
npx playwright test tests/ignis.spec.mjs tests/boss-audio.spec.mjs tests/sword.spec.mjs
```

⚠️ 按 testing-policy 分层选最小充分验证，**不铺开全量**。判据是「该 spec 是否消费被改的变量」：
本次改了 `ignis-config` / `ignis-boss-agent` / `ignis-renderer` / `audio-config` ⇒ 上面三个 spec 消费它们。
`zombies.spec` / `harness.spec` 不消费 ⇒ 不跑（除非前面出现意外失败）。

- [ ] **Step 2: 热路径判定**

改动落在 `ignis-boss-agent`（每帧 AI）与 `ignis-renderer`（每帧骨骼发布）⇒ 属热路径。

```bash
npm run bench -- --check
```
Expected: 无回退。⚠️ `frameP95` 会被 vsync 量子化噪声误报 ⇒ 若贴线红，用**交替对照**判定，不改阈值。
⚠️ 诊断后若基线被重写，`git checkout docs/m3-baseline.*` 恢复（这两个文件是冻结基线，提交它等于静默放宽门禁）。

- [ ] **Step 3: 登记 roadmap**

在 `docs/roadmap.md` 版本表加 v2.98 行，含：五项裁定、素材鉴别实测（15.0° vs 对照组 12.5°）、
档案四项值、冷却下限改动与代价、`feetOffsetY` 实测是否变化、四处负向验证结果、
Tier 4 三点射程读数、门禁与 bench 结果。

⚠️ **数字一律填实测值**，不得照抄本计划的预期值。

- [ ] **Step 4: Commit**

```bash
git add docs/roadmap.md
git commit -m "docs: roadmap 登记焰魔盾击 v2.98"
```

---

## 附：本计划刻意不做的事

spec §8 的边界（持盾格挡免疫 / 破盾阶段 / 举盾待机 / 击退 / 碎石 / 眩晕 / 屏幕震动）一律不做。
`src/core/game.js` 与 `tools/check-data.mjs` **零改动** —— 若实施中发现必须改它们，
说明有派生关系没走通，**停下来报告**，不要顺手加第二份分支。