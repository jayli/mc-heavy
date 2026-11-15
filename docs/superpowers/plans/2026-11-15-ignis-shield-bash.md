# 焰魔第四招「举盾砸击」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task（用户 2026-11-15 明确指定「出实施计划并新建分支实施」= 本会话内联执行）。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把原版 `ULTIMATE_ATTACK`（素材 `attack11`）迁移成焰魔第四招 `shieldBash`「举盾砸击」——举盾过顶 2.26 格、盾面转正前、向前 1.03 格 + 向下 2.61 格砸下。

**Architecture:** 沿用 v2.75/v3.01 的「档案表 + 素材清单」架构：`IGNIS_ANIM_SOURCES` 加一条 → 烘焙器多取一条已入库动画；新增 `IGNIS_ANIM_TIME_WARP` 做三段分段时间重映射（蓄力压缩 ×1/2.5、砸下拉长 ×3），`ignisAnimOutputPeriod()` 成为「产物时长」的唯一权威供烘焙器与 `check:data` 共用；玩法档案 `IGNIS_ATTACKS.shieldBash` 与另三招同构；渲染器按 `attackKind` 多一个分支。

**Tech Stack:** Node v26（烘焙/门禁）、three r185.1（仅烘焙期用 `three.core.js` 算四元数）、浏览器内单测（`src/tests/`）、Playwright（`tests/*.spec.mjs`）。

**Spec:** `docs/superpowers/specs/2026-11-15-ignis-shield-bash-design.md`

## Global Constraints

以下数值逐字取自 spec，每个任务的要求都隐含包含本节：

- 素材：`attack11`（**不是** `attack11` 之外的任何键；`animation_length` 5.7 ≡ `Animation.create(114)/20`）。
- 三段 warp 冻结值：源 `0~3.35` → 产物 `1.34`（×1/2.5）；源 `3.35~3.60` → 产物 `0.25`（×1）；源 `3.60~3.70` → 产物 `0.30`（×3）；源 `3.70~5.70` → 产物 `2.00`（×1）。
- 产物总时长 **3.89s**，帧数 `round(3.89 × 30) = 117`，实际 duration `117/30 = 3.90s`；**命中帧 1.89s**。
- 玩法档案：`hitRange 6.5` / `hitConeDeg 22.5`（**半角**，原版 arc 45 的一半）/ `hitFrameSeconds 1.89` / `animSeconds 3.89` / `weight 0.20`。
- 四招权重：`swing 0.25` / `spin 0.30` / `shieldSmash 0.25` / `shieldBash 0.20`（和 = 1）。
- 档案键与产物动画键：**`shieldBash`**（**不得复用废弃的 `shieldSlam`**）。中文名「举盾砸击」。
- 音效：新 id `ignis_attack_bash`，文件 = mod `ignis_impact.ogg` 逐字节副本（9023 字节），走 ogg，正音量。
- `feetOffsetY` 重标 **−0.07736861**（烘焙器实算，不手写）；`IGNIS_CORE_OBB.center[1]` 重标 **1.6988**。
- **只扣血**：不做击退 / 碎石 / 破玩家盾 / 眩晕 / 屏幕震动 / 火焰柱 / 8 段火焰喷射。
- **零新增美术资源**：不新增贴图/方块/几何；音效是既有 mod 文件的逐字节拷贝。
- **不抬 `attackCooldownMin`**（保持 4.0；3.89 < 4.0 余量 0.11s）。
- 新增 `src/tests/test-*.js` 必须同时注册进 `src/tests/index.html`（漏注册 = 静默不跑）。
- 盾几何判据一律用 **80 角点**（`shield` / `shield_root` / `shield_right` / `shield_left`），禁止单点探针。
- 冻结断言不符时**重标实测值**，不放宽容差。
- Playwright 必须 `channel: 'chromium'`；worktree 内跑 Playwright 前必须确认服务指向本 worktree（固定端口 8081 + `reuseExistingServer: true` 会静默连主仓）。

## Review Focus

spec 隐含但各任务测试未直接覆盖的失败模式，最可能咬人的排在前面：

1. **warp 映射非单调或在段界不连续** → 动画在段界处倒放/跳帧。Task 1 的映射用例必须同时钉单调性、四个边界值、值域端点。
2. **`check:data` 仍按 `IGNIS_ANIM_PERIODS` 算帧数** → 新招必红，而红的原因是门禁没跟上不是产物错。Task 1 必须让两侧共用 `ignisAnimOutputPeriod`。
3. **`feetOffsetY` 变了但 `IGNIS_CORE_OBB.center[1]` 没跟着重标** → 命中盒整体上移 0.145 格，玩家「砍胸口打空」。Task 3 的产物独立复算用例必须红→重标→绿。
4. **四招音还只有三个 id** → 新招静默沿用别人的音。Task 4 的「四音两两不同」必须真的按四招算。
5. **抽签顺序变了** → `shieldBash` 必须是声明顺序最后一档（`IGNIS_ATTACK_IDS` 由 `Object.keys` 派生），否则既有「rng≈1 落末档」用例语义漂移。Task 3 必须核对末档。
6. **新招在 leap 落地路径上被漏掉** → 跳跃劈砍抽中 `shieldBash` 时渲染器回落 attack。Task 5 的 E2E 必须覆盖 leap 落地。
7. **warp 后蓄力段单帧角超过源自身合法上限** → 补间自己成为新抖动。Task 2 的产物用例钉 ≤ 源上限。

---

### Task 1: 烘焙侧时间重映射与产物时长权威

**Files:**
- Modify: `tools/ignis-fingerprint.mjs`（`IGNIS_ANIM_PERIODS` / `IGNIS_ANIM_SOURCES` 各加一条；新增 `IGNIS_ANIM_TIME_WARP` + `ignisAnimOutputPeriod()`）
- Modify: `tools/bake-ignis.mjs`（`resampleAnimation` 接受 `timeWarp`；主循环按 `ignisAnimOutputPeriod` 定帧数）
- Modify: `tools/check-data.mjs`（帧数断言改用 `ignisAnimOutputPeriod(key)`）
- Test: `src/tests/test-ignis-bake.js`（新增 warp 参数契约用例；此文件已在 index.html 注册）

**Interfaces:**
- Produces:
  - `IGNIS_ANIM_TIME_WARP: Readonly<Record<string, {chargeEnd:number, chargeScale:number, slamStart:number, slamEnd:number, dstSlamSeconds:number}>>` —— 只有 `shieldBash` 一条。
  - `ignisAnimOutputPeriod(key: string): number` —— 无 warp 的招返回 `IGNIS_ANIM_PERIODS[key]`；有 warp 的招返回三段映射后的总时长。
  - 产物新键 `animations.shieldBash`（`{fps:30, frameCount:117, boneIndices:number[], frames:number[]}`）。
- Consumes: 既有 `IGNIS_ANIM_PERIODS` / `IGNIS_ANIM_SOURCES` / `IGNIS_ATTACK_ANIM_KEYS` / `ignisInputFingerprint()`。

- [ ] **Step 1: 写失败测试 —— warp 参数与产物时长的关系式**

在 `src/tests/test-ignis-bake.js` 末尾追加（该文件是浏览器内单测，**不能 import node 侧模块**，故把冻结值写在用例里并断言产物自洽）：

```js
test('焰魔烘焙(v3.03): shieldBash 产物时长 = 三段 warp 后的 3.89s，帧数 117，fps 30', async () => {
  const d = await loadAsset();
  const a = d.animations.shieldBash;
  assertNotNull(a, '产物缺 shieldBash —— 烘焙器没取 attack11');
  assertEqual(a.fps, 30);
  assertEqual(a.frameCount, 117);
  // 117/30 = 3.90（帧数取整的必然结果）；warp 目标总时长 3.89
  assertTrue(Math.abs(a.frameCount / a.fps - 3.90) < 1e-9);
  // 10 根骨骼（attack11 实测；接成 attack1 的 9 根或 attack10Sa 的 9 根会在这里红）
  assertEqual(a.boneIndices.length, 10);
});
```

- [ ] **Step 2: 运行验证它失败**

Run: `npx playwright test tests/harness.spec.mjs`（浏览器内全量单测入口，整页实测 ~76s，窗口 150s）
Expected: FAIL，`产物缺 shieldBash` 或 `assertNotNull` 失败。
⚠️ **不要接管道**（`| sed` / `| grep`）—— 退出码会变成管道末端工具的，测试没跑也显示 exit 0
（memory `piped-test-command-masks-exit-code`）。输出很长时重定向到文件再读 tail。

- [ ] **Step 3: 在 `ignis-fingerprint.mjs` 加 warp 权威**

新增（放在 `IGNIS_ANIM_PERIODS` 之后）：

```js
export const IGNIS_ANIM_TIME_WARP = Object.freeze({
  shieldBash: Object.freeze({
    chargeEnd: 3.35, chargeScale: 2.5,
    slamStart: 3.60, slamEnd: 3.70, dstSlamSeconds: 0.30,
  }),
});
export function ignisAnimOutputPeriod(key) { /* 三段求和；无 warp 直接返回 IGNIS_ANIM_PERIODS[key] */ }
```

`ignisAnimOutputPeriod` 的算法（spec §3.2）：
`chargeEnd/chargeScale + (slamStart − chargeEnd) + dstSlamSeconds + (period − slamEnd)`。
参数非法（`chargeEnd <= 0`、`chargeScale <= 0`、`slamStart < chargeEnd`、`slamEnd <= slamStart`、`slamEnd > period`、`dstSlamSeconds <= 0`）必须 **throw**，不得静默返回原 period。

同时 `IGNIS_ANIM_PERIODS.shieldBash = 5.7`、`IGNIS_ANIM_SOURCES.shieldBash = Object.freeze(['attack11'])`。
⚠️ 两者都进 `ignisInputFingerprint` 的 params 哈希 ⇒ 指纹自动变，`check:data` 会要求重烘。

- [ ] **Step 4: 烘焙器消费 warp**

`resampleAnimation(anims, names, frameCount, fps, boneNameToIndex, bind, timeWarp = null)`：
帧循环里 `const tOut = f / fps; const t = timeWarp ? timeWarp.toSource(tOut) : tOut;`。
主循环按 `ignisAnimOutputPeriod(key)` 定 `frames`，并构造 `toSource`（分段线性，spec §3.2 的四段公式）。

- [ ] **Step 5: `check:data` 改用产物时长权威**

`checkIgnisAsset()` 里 `const expectFrames = Math.round(ignisAnimOutputPeriod(key) * IGNIS_BAKE_PARAMS.defaultFps);`
并在文件顶部 import 里加 `ignisAnimOutputPeriod`。

- [ ] **Step 6: 重烘并跑门禁**

Run: `npm run ignis && npm run check:data`
Expected: 烘焙日志出现 `动画 shieldBash: 117 帧 × 10 骨骼 @ 30fps（attack11）`；`check:data` 的 `[焰魔]` 行全绿。

- [ ] **Step 7: 运行 Step 1 的测试验证通过**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: PASS（含新用例）。

- [ ] **Step 8: 提交**

```bash
git add tools/ignis-fingerprint.mjs tools/bake-ignis.mjs tools/check-data.mjs src/tests/test-ignis-bake.js assets/ignis/ignis.json assets/ignis/ignis.png assets/ignis/ignis.meta.json
git commit -m "feat(ignis): 烘焙 attack11 为举盾砸击，三段时间重映射"
```

---

### Task 2: 举盾砸击的语义判据（真实 80 角点，三条交集）

**Files:**
- Modify: `src/tests/test-ignis-bake.js`（新增盾几何工具 + 四条语义用例）

**Interfaces:**
- Consumes: Task 1 的 `animations.shieldBash`。
- Produces: 测试内部工具 `shieldBBoxAt(d, animKey, t)` → `{lo:[x,y,z], hi:[x,y,z]}`（80 角点）、`shieldFaceForwardAt(d, animKey, t)` → number（法线前方分量）、`headTopAt(d, animKey, t)` → number。后续任务与 E2E 不消费它们（测试内部）。

- [ ] **Step 1: 写失败测试 —— 四条语义判据**

在 `test-ignis-bake.js` 追加盾几何工具（用产物 `bones[].pivot/bindQuaternion` 累乘 + `src/ignis.geo.json` 的角点；⚠️ 浏览器内单测可以 fetch 素材 JSON，路径走 `resourceUrl()` 或相对路径 `../../assets/ignis/src/ignis.geo.json`），并加四条用例：

```js
test('焰魔烘焙(v3.03): shieldBash 举盾过顶 > 1.5 格（真实 80 角点，不是单点探针）', ...);
test('焰魔烘焙(v3.03): shieldBash 盾面转向正前 —— 法线前方分量峰值 > 0.85', ...);
test('焰魔烘焙(v3.03): shieldBash 向前砸 —— 峰后 0.6s 前推 > 0.6 格 且 下降 > 1.5 格', ...);
test('焰魔烘焙(v3.03): shieldBash 可见砸下段 ≥ 250ms（盾顶从峰值跌到 <2.0 格）', ...);
```

阈值与实测值（spec §6.1，产物时间轴）：过头顶 **2.259**、面朝前峰 **0.973**、峰后前推 **1.029** / 下降 **2.554**、可见砸下段 **500ms**。
每条断言**同时钉上下界**（例如过头顶 `> 1.5 && < 3.0`），防「数据变了恒真」。

- [ ] **Step 2: 运行验证它们失败**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: 四条新用例 FAIL（Task 1 已产出动画，故失败原因必须是**阈值/工具**而不是「缺动画」——若报缺动画说明 Task 1 没落地，回去查）。

⚠️ **本步骤的 RED 形态特殊**：Task 1 已经烘焙出正确产物，所以这四条在正确实现下**会直接绿**。
按 TDD 的「必须看着它失败」要求，**先用注入错误素材的方式造 RED**：
临时把 `IGNIS_ANIM_SOURCES.shieldBash` 改成 `['attack1']` → `npm run ignis` → 跑用例 → 四条必须全红
（attack1 的过头顶 1.47 < 1.5、面朝前 0.36 < 0.85、前推 0.14 < 0.6）。
记录每条的实际读数，然后 `cp` 副本还原 + 重烘 → 四条全绿。
**这就是 spec §6.1 要求的负向验证，与本步的 RED 合并完成。**

- [ ] **Step 3: 补齐工具实现让四条转绿**

工具口径必须与 `probePoints` 一致（`R = bind·delta`，`position = pivot − R·pivot + deltaPos`）。
盾面法线 = `shield` 骨骼局部 `+x` 方向变换后的单位向量，前方分量 = `−normal.z`。

- [ ] **Step 4: 负向验证矩阵（逐个注入，记录哪条抓住）**

对 `attack1` / `attack9Sa` / `attack13Ta` / `attack8a3` 各做一轮「改清单 → 重烘 → 跑用例 → 记读数 → cp 还原 → 重烘」。
Expected: 每个错误素材至少被一条判据抓住；把矩阵写进 spec §6.1 下方（实测值替换预估值）。

- [ ] **Step 5: 单帧角判据**

追加用例：`shieldBash` 片段自身最快单帧（1/60s）骨骼转角，以及「warp 后 ≤ 源自身上限」。
源上限实测 **30.00°**，warp 后 **12.66°**。断言 `warp后单帧角 <= 源上限`（源上限由用例现算，不写死）。

- [ ] **Step 6: 运行全量单测**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: PASS，无 warning。

- [ ] **Step 7: 提交**

```bash
git add src/tests/test-ignis-bake.js docs/superpowers/specs/2026-11-15-ignis-shield-bash-design.md
git commit -m "test(ignis): 举盾砸击语义判据（80 角点 + 向前 + 可见时长）与四组负向验证"
```

---

### Task 3: 玩法档案、四招权重与命中盒重标

**Files:**
- Modify: `src/entities/ignis/ignis-config.js`（`IGNIS_ATTACKS.shieldBash`、四招权重、`IGNIS_CORE_OBB.center[1]`）
- Modify: `src/tests/test-ignis-system.js`（四招形状/权重/派生值/命中盒重标）
- Modify: `src/tests/test-ignis-boss-agent.js`（抽签区间与末档按四招重标）

**Interfaces:**
- Consumes: Task 1 的产物 `metrics.feetOffsetY`（−0.07736861）。
- Produces: `IGNIS_ATTACKS.shieldBash`（五字段）、`IGNIS_ATTACK_IDS` 末位 `'shieldBash'`、`IGNIS_CORE_OBB.center = [0, 1.6988, -0.2095]`。

- [ ] **Step 1: 写失败测试 —— 四招档案与派生值**

`test-ignis-system.js`：把 `'shieldSmash,spin,swing'` 改成 `'shieldBash,shieldSmash,spin,swing'`；
权重断言改 0.25/0.30/0.25/0.20；新增 `shieldBash` 五字段用例（1.89 / 3.89 / 6.5 / 22.5 / 0.20）；
派生值断言 `hitFrameSeconds === 1.89`、`attackAnimSeconds === 3.89`；
`hitConeDeg < 45` 的半角守卫扩到 `shieldBash`。

- [ ] **Step 2: 运行验证失败**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: FAIL，`IGNIS_ATTACKS` 键集合不含 shieldBash。

- [ ] **Step 3: 加档案 + 改权重**

`shieldBash` 档案**排在 `shieldSmash` 之后**（声明顺序 = 抽签顺序，末档必须是它）。
注释写清四项数值来源（原版 tick 74 / arc 45 半角 / warp 后时长）与「只扣血」裁定。

- [ ] **Step 4: 命中盒重标（先让独立复算用例红）**

`test-ignis-system.js` 的「命中盒实测度量」用例把 `center[1]` 期望改成 **1.6988**；
先跑一次确认它红（此时 config 还是 1.5534），再改 config → 绿。
⚠️ 「产物独立复算」用例（`coreBboxFromAsset` + `metrics.feetOffsetY`）会自动跟着产物走，
它红说明 config 没重标 —— **不得放宽容差**。

- [ ] **Step 5: 抽签用例按四招重标**

`test-ignis-boss-agent.js`：
- 末档 `rng≈1` → `'shieldBash'`（原来是 `shieldSmash`）。
- 区间：swing `[0,0.25)` / spin `[0.25,0.55)` / shieldSmash `[0.55,0.80)` / shieldBash `[0.80,1)`。
  实测落点（已用真实抽签算法跑过，不是推算）：`rng=0`→swing、`0.25`→spin、`0.3`→spin、
  `0.5`→spin、`0.55`→shieldSmash、`0.64`→shieldSmash、`0.8`→shieldBash、`0.999999`→shieldBash
  ⇒ 既有的 `rng=0.5` / `rng=0.3` 落 spin 用例**不用改**。
- 权重扫描用例改成四档，实测 1000 档得 **250 / 300 / 250 / 200**（本组权重浮点和恰好是 1，
  没有 v3.01 那次的边界偏移）；保留「swing 与 shieldSmash 占比差 ≤ 0.3%」的平分判据。
- 「屏蔽 spin 后」用例：候选集 swing 0.25 / shieldSmash 0.25 / shieldBash 0.20（总 0.70），
  实测：`rng=0`→swing、`0.35`→swing、`0.5`→**shieldSmash**、`0.7`→shieldSmash、`0.999999`→**shieldBash**。
  ⇒ 原用例的「`rng≈1` 落 shieldSmash」必须改成 shieldBash；「`rng=0.5` 落 shieldSmash」结论不变但理由变了
  （不再是浮点边界，而是 0.5×0.70=0.35 落在第二档内），注释要重写。
- leap 落地用例：`rng≈1` 起跳抽定的招现在是 `shieldBash`，两处 `leapAttackKind` 期望跟着改。

- [ ] **Step 6: 运行全量单测**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add src/entities/ignis/ignis-config.js src/tests/test-ignis-system.js src/tests/test-ignis-boss-agent.js
git commit -m "feat(ignis): 举盾砸击玩法档案与四招权重，命中盒按新 feetOffsetY 重标"
```

---

### Task 4: 渲染器选片段与起手音

**Files:**
- Modify: `src/render/ignis-renderer.js`（`wantClip` 加 `shieldBash` 分支）
- Modify: `src/render/audio-config.js`（`SOUND_IDS` / `SOUND_EXT_OVERRIDES` / `SOUND_VOLUMES` / `IGNIS_ATTACK_SOUNDS` 各加一条）
- Create: `assets/sounds/ignis_attack_bash.ogg`（mod `ignis_impact.ogg` 逐字节副本）
- Modify: `src/tests/test-ignis-render.js`（四招姿态互不相同 + 淡入 + 缺键回落）
- Modify: `src/tests/test-bgm.js`（四招音齐全、两两不同）

**Interfaces:**
- Consumes: Task 3 的 `IGNIS_ATTACKS.shieldBash` / `IGNIS_ATTACK_IDS`；Task 1 的 `animations.shieldBash`。
- Produces: `IGNIS_ATTACK_SOUNDS.shieldBash = 'ignis_attack_bash'`；渲染器 `clipKey === 'shieldBash'`。

- [ ] **Step 1: 写失败测试 —— 渲染器按 kind 选片段**

`test-ignis-render.js` 新增：`attackKind='shieldBash'` 在 t=1.0s 的姿态与另三招两两距离 > 0.2；
缺 `animations.shieldBash` 键时不抛错、回落 `attack`；
淡入 `ignisBlendSeconds('shieldBash') === 0.2` 且 `< 1.89`，补间单帧角 ≤ `clipMaxStepDeg(shieldBash)`。

- [ ] **Step 2: 写失败测试 —— 四招音**

`test-bgm.js`：把「三招两两不同」改成按 `IGNIS_ATTACK_IDS` 全量算（`new Set(ids).size === ids.length`，ids 长度 4）；
新增 `shieldBash` 音用例（id / ogg / 正音量 / `soundFileName`）。

- [ ] **Step 3: 运行验证两处都失败**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: FAIL —— 渲染器回落 attack 导致姿态差不足；音表键集合与 `IGNIS_ATTACK_IDS` 不一致。

- [ ] **Step 4: 拷音效文件**

```bash
cp /Users/bachi/jaylli/cataclysm1.19.2modding/src/main/resources/assets/cataclysm/sounds/entity/ignis_impact.ogg assets/sounds/ignis_attack_bash.ogg
```
Expected: `stat -f %z` 得 **9023**。

- [ ] **Step 5: 实现渲染器分支与音表**

`wantClip`：`st.attackKind === 'shieldBash' ? 'shieldBash' : ...`（保持既有回落链）。
音表四处各加一条，`SOUND_VOLUMES.ignis_attack_bash` 与 `ignis_attack_smash` 同档。

- [ ] **Step 6: 运行全量单测 + 音频 spec**

Run: `npx playwright test tests/harness.spec.mjs tests/boss-audio.spec.mjs`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add src/render/ignis-renderer.js src/render/audio-config.js assets/sounds/ignis_attack_bash.ogg src/tests/test-ignis-render.js src/tests/test-bgm.js
git commit -m "feat(ignis): 渲染器播举盾砸击片段，起手音入库 ignis_attack_bash"
```

---

### Task 5: E2E 像素实测与 roadmap 登记

**Files:**
- Modify: `tests/ignis.spec.mjs`（四招像素/骨骼互不相同、新招射程与锥宽、砸下段画面变化、leap 落地）
- Modify: `docs/roadmap.md`（v3.03 行）
- Modify: `docs/superpowers/specs/2026-11-15-ignis-shield-bash-design.md`（把预估数字换成实测）

**Interfaces:**
- Consumes: 前四个任务的全部产出。
- Produces: 无（终端任务）。

- [ ] **Step 1: 写失败测试 —— 四招 E2E**

`tests/ignis.spec.mjs`：
- 把既有「三招两两不同」扩成四招（t=1.0s，噪声底必须为 0）。
- 新增「砸下段画面真的在动」：`shieldBash` 在 t=1.59 与 t=1.89 的截图差异显著（上下界都钉）。
- 新增射程/锥宽：`shieldBash` 在 2.5 / 5.0 / 6.0 格命中、7.0 格不掉血；侧 40° 不中、正面中（半角 22.5）。
- 新增 leap 落地：起跳 `rng≈1` 抽定 `shieldBash`，落地后 `attackKind === 'shieldBash'` 且渲染器用的是该片段。

- [ ] **Step 2: 确认服务指向本 worktree**

Run: `curl -s http://localhost:<本worktree端口>/src/tests/index.html | grep -c test-ignis-bake`
Expected: ≥ 1。若为 0 说明连到主仓 —— 按 memory `worktree-playwright-reuses-main-server` 改本 worktree 的
`playwright.config.mjs` 与 `server-script/start-server.js` 端口（**提交前必须还原**）。

- [ ] **Step 3: 运行验证失败**

Run: `npx playwright test tests/ignis.spec.mjs`
Expected: 新增用例 FAIL（四招扩写前只测三招 / 新招判据尚未满足）。

- [ ] **Step 4: 补齐 spec 实现与断言**

按实测值钉阈值（先打印实际读数再写断言 —— AGENTS.md 的「断言前先在真实数据上跑一次」）。

- [ ] **Step 5: 运行 E2E 与全量门禁**

Run: `npx playwright test tests/ignis.spec.mjs tests/boss-audio.spec.mjs && npm run check`
Expected: 全绿。

- [ ] **Step 6: roadmap 与 spec 登记实测**

`docs/roadmap.md` 加 v3.03 行（用户诉求、四条选招判据、warp 三段、四招权重、feetOffsetY 重标、验证证据）。
spec 里把 §6.1 的预估列换成本轮实测读数，并补负向验证矩阵。

- [ ] **Step 7: 还原调试用的端口改动并提交**

```bash
git checkout -- playwright.config.mjs server-script/start-server.js   # 仅当本任务改过端口
git add tests/ignis.spec.mjs docs/roadmap.md docs/superpowers/specs/2026-11-15-ignis-shield-bash-design.md
git commit -m "test(ignis): 举盾砸击 E2E 像素实测，roadmap 登记 v3.03"
```

⚠️ `git checkout --` 只用于**本任务自己改的调试端口**，不得用于撤销功能改动（memory
`negative-test-revert-use-copy-not-git-checkout`）。若工作树里这两个文件还有别人的改动，改用 `cp` 副本还原。