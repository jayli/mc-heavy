# 积水斑镜面反光（v3.32）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans（用户 2026-11-19 已定 Native 内联 + 新分支，不用 worktree）。Steps use checkbox (`- [ ]`) syntax.

**Goal:** 让雨天地面上已有的积水斑真的反光（明显强于周边水膜、内部有云影明暗层次），而墙面/云/水下/关闭态逐位不动。

**Architecture:** 在 v3.31 湿表面的片元合成里，给 `reflK` 加一层「积水镜面目标」mix（`mix(水膜reflK, MIRROR×specGain×wet, puddle×topGate×uWetPuddleRefl)`），并给水汪的天空环境乘一个低频云影调制。零新 pass、零新顶点属性、零新贴图、零方块改动。

**Tech Stack:** three r185.1 TSL（WebGPU 唯一后端）、Node 内置 test runner（浏览器内单测 + Node 白名单）、Playwright + pngjs 真实 GPU 像素。

**Spec:** `docs/superpowers/specs/2026-11-23-puddle-mirror-reflection-design.md`

## Global Constraints

- 所有解释、说明、注释用中文（项目 AGENTS.md）。
- 红线 1：CPU 纯函数与 TSL 公式**逐项同构**，常量只有一份权威（`wet-surface-config.js`）。
- 红线 8：不 import three 到 `wet-surface-config.js`（Node 单测直接读）。
- TSL 七条口径：节点不与裸数字算术、常量色显式拆分量、多层 mix 嵌套不链式、径向量在片元算、不用 `.toVar()/.assign()`、反向 smoothstep 用 `oneMinus`、噪声用 `mx_noise_float`。
- **不动**：`WET_REFL_MAX=0.55`、`WET_REFL_FLOOR=0.28`、`WET_SUN_SPEC=0.22`、`WET_PUDDLE_FROM/TO=0.52/0.76`、`WET_PUDDLE_SCALE=0.32`、材质分类表、方块顺序、mesher。
- 新常量：`WET_PUDDLE_MIRROR=0.70`、`WET_PUDDLE_CLOUD=0.25`、`WET_PUDDLE_CLOUD_SCALE=0.09`。
- 新 uniform：`uWetPuddleRefl = uniform(1)`（0 ⇒ 逐位回到 v3.31）。
- 测试命令**不接管道**（退出码会被末端工具替换）。> 1 分钟的命令用 `run_in_background`。
- 提交等明确指令；本计划不含 commit 步骤。

## Review Focus

1. **墙面/云被水汪镜面爬上** ⇒ 用户上次报的岩壁光晕复活。`topGate` 必须在，且 Tier 1 钉「up≤0.5 时 reflK 逐位等于 v3.31」+ Tier 4 负向③去掉 topGate 必红。
2. **关档残留** ⇒ 雨后水汪还在反光。两级锚点：`uWet=0` 与 `uWetPuddleRefl=0` 都必须逐位回归。
3. **`specGain` 钳位使乘数恒等**（本轮根因）⇒ 任何「乘个系数」的写法对抛光类零效果。Tier 1 钉「抛光积水 reflK 显著大于水膜」。
4. **水汪变纯色塑料板** ⇒ 正午 sky==fogColor。Tier 4 用例⑧量效应层空间方差。
5. **过曝** ⇒ `skyMul` 上界 1.25 与 reflK 0.70 的组合。Tier 1 全组合扫描 + Tier 4 用例③沿用。

---

### Task 1: CPU 同构层（常量 + 三个纯函数）

**Files:**
- Modify: `src/render/wet-surface-config.js`（在 `wetReflK` 之后追加）
- Test: `src/tests/test-wet-surface.js`（追加）

**Interfaces:**
- Produces:
  - `WET_PUDDLE_MIRROR: number` = 0.70、`WET_PUDDLE_CLOUD: number` = 0.25、`WET_PUDDLE_CLOUD_SCALE: number` = 0.09
  - `wetPuddleMirrorK(cls: number, puddle: number, wet: number, up: number, reflStrength: number): number`
  - `wetPuddleReflK(noV: number, cls: number, up: number, puddle: number, wet: number, reflStrength: number): number`
  - `wetPuddleSkyMul(cloud: number, puddle: number, up: number, reflStrength: number): number`
- Consumes: 既有 `wetReflK` / `wetRoughnessAt` / `wetSpecGainAt` / `wetnessAt` / `wetDarkenAt`

- [ ] **Step 1: 写失败测试**（追加到 `test-wet-surface.js` 末尾）

八条，逐条对应 spec §8.1：`wetPuddleMirrorK` 三条归零门；`wetPuddleReflK` 的 `reflStrength=0` 与 `puddle=0` 逐位等于 `wetReflK`；675 组全组合有界 + 四类顶面积水 > 水膜；`wetPuddleSkyMul` 恒 1 门与值域；量级带（p=0.7682、noV=0.53、BASE=0.3816、SKY=0.5529，抛光 Δ∈[12,28]、布 |Δ|<3、抛光>石>木>土）；墙面零回归；既有常量未放宽；uniform 句柄初值。

- [ ] **Step 2: 跑测试确认 RED**

Run: `node tools/run-unit-node.mjs --only=test-wet-surface.js`
Expected: FAIL —— 导入 `wetPuddleMirrorK` 等不存在（SyntaxError / not a function）。

- [ ] **Step 3: 实现三个常量与三个纯函数**

`wetPuddleMirrorK` = `WET_PUDDLE_MIRROR × wetSpecGainAt(cls,puddle) × clamp01(wet) × topGate × clamp01(reflStrength)`，`topGate = up > 0.5 ? 1 : 0`。
`wetPuddleReflK` = `min(lerp(wetReflK(noV, rough, sg, wet), mirrorK, clamp01(puddle)), 1)`，其中 `rough`/`sg` 走既有 `wetRoughnessAt`/`wetSpecGainAt`；`mirrorK` 已含 topGate 与 strength，故 `puddle` 的混合权重也要乘 topGate×strength（否则 strength=0 时会 mix 向 0 而不是回到水膜）。
`wetPuddleSkyMul` = `1 + clamp(cloud,-1,1) × WET_PUDDLE_CLOUD × clamp01(puddle) × topGate × clamp01(reflStrength)`。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `node tools/run-unit-node.mjs --only=test-wet-surface.js`
Expected: PASS，全部用例（既有 29 + 新增）。

---

### Task 2: TSL 侧接线（uniform + 两行公式）

**Files:**
- Modify: `src/render/wet-surface.js`
- Test: `src/tests/test-wet-surface.js`（Task 1 已含句柄断言）+ `tests/wet-surface.spec.mjs`（Task 3）

**Interfaces:**
- Consumes: Task 1 的三个常量
- Produces: `WET_SURFACE_UNIFORMS.uWetPuddleRefl`（`uniform(1)`）

- [ ] **Step 1: 写失败测试**（Tier 1 句柄 + 源码结构断言）

断言 `U.uWetPuddleRefl.value === 1`；源码**代码行**里必须出现 `uWetPuddleRefl` 参与 reflK 与 skyMul 两处，且 `WET_REFL_MAX` 仍只钳水膜项。

- [ ] **Step 2: 跑测试确认 RED**

Run: `node tools/run-unit-node.mjs --only=test-wet-surface.js`
Expected: FAIL —— `uWetPuddleRefl` undefined。

- [ ] **Step 3: 实现 TSL**

加 uniform；在既有 `reflK` 之后加 `mirrorK` 与两层 mix；新增 `cloud` 噪声（`vec3(wp.x×SCALE, wp.z×SCALE, 7.3)`）与 `skyMul`，乘进 `skyEnv`。`topGate = select(isTop, float(1), float(0))`。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `node tools/run-unit-node.mjs --only=test-wet-surface.js`
Expected: PASS。

---

### Task 3: Tier 4 真实 GPU 像素判据

**Files:**
- Modify: `tests/wet-surface.spec.mjs`（追加用例⑦⑧⑨ + 负向③；用例②追加一条断言）

**Interfaces:**
- Consumes: `g.renderWorld.materials.wet.uWetPuddleRefl`

- [ ] **Step 1: 写失败测试**

用例⑦：抛光石地面夹具（复用用例②的几何），单变量 `uWetPuddleRefl` 1↔0，地面区变亮像素占比 > 0.05 且 Δluma > +2；云/墙区 |Δluma| < 1（用 `buildScene` 的真实投影区）。
用例⑧：效应层（on−off）在地面区的空间标准差 > 同区水膜基线的标准差 × 1.5。
用例⑨：`uWetPuddleRefl=0` 两次取样逐位相同 + 与 `=1` 的差分集中在地面区。
负向③：`page.route` 去掉 `topGate`（把 `puddle.mul(topGate)` 换成 `puddle`）⇒ 用例⑦的墙区判据必红。

- [ ] **Step 2: 跑测试确认 RED**

Run: `MC_PORT=8081 npx playwright test tests/wet-surface.spec.mjs --reporter=list`（后台）
Expected: 新用例 FAIL（`uWetPuddleRefl` 未接线时写它无效果 ⇒ 差分为 0）。

- [ ] **Step 3: 接线已在 Task 2 完成 ⇒ 直接跑 GREEN**

Run: 同上
Expected: 全部 PASS（既有 8 + 新增 4）。

- [ ] **Step 4: 负向验证真红**

用 `edit` 注入（不用 sed），读回代码行确认落地，跑负向③必须 FAIL；用 `cp` 副本还原（不用 git checkout）。

---

### Task 4: 最小充分集回归 + 文档

**Files:**
- Modify: `docs/roadmap.md`（v3.32 行）、`docs/pitfalls.md`（新节）、`docs/superpowers/specs/2026-11-22-wet-surface-rebuild-design.md`（末尾指向本稿）

- [ ] **Step 1: 跑最小充分集**

```
npm run check
node tools/run-unit-node.mjs --only=test-wet-surface.js,test-storm-rain.js,test-daynight.js
npx playwright test tests/wet-surface.spec.mjs tests/storm-lighting.spec.mjs tests/storm-underwater.spec.mjs tests/carbine-flash-wet.spec.mjs tests/water-visual.spec.mjs
npm run bench -- --check
```
Expected: 全绿；冻结数字（指纹、193.83 MiB、水面色阶）不变。

- [ ] **Step 2: 写文档**（实测读数入库，不写「应该」）

- [ ] **Step 3: 清理临时探针**（字面路径，两条）

`tests/tmp-puddle-probe.spec.mjs`、`tests/tmp-puddle-mask.spec.mjs` —— 本 session 创建，`mv` 到 `/tmp` 备份目录而非直接删。