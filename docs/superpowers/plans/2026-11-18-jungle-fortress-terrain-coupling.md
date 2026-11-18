# 丛林要塞地形耦合改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把丛林要塞从「占地整片削平」改为「保留自然起伏 + 整体抬到 75 分位高度 + 石墩托底 + 接壤阶梯过渡裙边」，让地下基座 45.8% 露出、地下房间 26.4% 露出，且接壤处无悬崖突变。

**Architecture:** 只改运行期 GEN，产物逐字节不变。① 锚点 `floorY` 语义改为 `baseY`（占地自然高度 75 分位，8 seed 恒 9）；② 删除削平整形，地形内部恒 = `generateHeight`；③ 新增石墩（逐列从结构底面补到自然地表，`mossy_stone`）+ 漏底修补；④ 新增接壤阶梯过渡裙边（边缘环源向内外两侧 Lipschitz 包络，每步降 1，三屏障：建筑/保护/湿列）；⑤ 植被/瞬移地表口径统一走 `jungleFortressSurfaceYAt`（新语义 = 裙边后地面）。

**Tech Stack:** Node v26、原生 ES module、浏览器内单测（`src/tests/`）、Playwright（E2E，`channel:'chromium'`）。不碰 three / 烘焙 / 产物 / 高度公式 / 水面遮罩。

**Spec:** `docs/superpowers/specs/2026-11-18-jungle-fortress-terrain-coupling-design.md`（v3.18，已批准；DR-1~DR-10 + §9 冻结表）

## Global Constraints

- 依赖方向单向 `voxel ← gen ← mesh ← render`；`src/gen/**` 不得 import three、不得自建 Worker、不得 fetch。
- `tools/*-fingerprint.mjs` 依赖 `node:fs`，`src/**` 与浏览器单测绝不能 import 它。
- 资源路径只走 `resourceUrl()`；时间基准 `performance.now()`；坐标取模非负。
- **产物 `assets/structures/jungle_fortress.json` / `.meta.json` 逐字节不变**，`check:data` 的 `[丛林要塞]` 环节不动。
- **不改 `generateHeight` / `TERRAIN_HEIGHT_PARAMS` / `noise.js` / `caves.js` / `ocean-mask.js` / `ocean.js` / `render-world.js`（CAPACITY）/ `blocks-data.js` / `mesher.js` / `atlas.*`**。
- 新增 salt 前程序化扫描占用（本计划不新增 salt，复用 1045/1046/1047）。
- `src/tests/test-*.js` 必须注册进 `src/tests/index.html`（本计划只改既有文件，不新增文件，注册不变）。
- Playwright 必须 `channel:'chromium'`；验证本计划改动必须 `worktree:false` 或独立端口（worktree 会连主仓 8081）。
- **冻结数字不符时停下报告**，不擅自改断言或放宽阈值。
- Conventional Commits；逐 Task 提交（执行阶段授权范围内）。
- 数组断言用 `assertDeepEqual`（`assertEqual` 是 `===`，数组恒 FAIL）；`assertClose` 不在 `assert.js`，需要时自定义。
- 负向验证用 `page.route` 在浏览器侧换模块内容，**不碰工作树**（并发会话约束）。

## Review Focus

按最可能咬人排序，每条都在对应 Task 有钉它的用例：

1. **接壤处悬崖突变**（用户追加裁定的核心）→ 裙边只做外侧会在内侧自然列与外侧裙边间留 9~11 格沟槽；只抬内部会把基座埋回去（可见率 45.8%→22.2%）。Task 5 钉「带内/带缝/外侧高差≤1」+「基座可见率不降」+「露出 air 零被埋」三条同时成立。
2. **`anchor.floorY` 语义变更漏改消费方** → 光栅化/瞬移/植被/单测/spec 五处都读它，漏一处就错位几格。Task 1 钉 8 seed baseY=9，Task 6 钉瞬移 y=5/6，Task 7 钉植被地表 = surfaceYAt。
3. **裙边埋掉用户要的裸露** → 保护列（露出地下 air）若被抬，房间/竖井被填，违背诉求。Task 5 钉保护列零抬升 + 露出 air 仍露 602/seed。
4. **裙边抬湿列造成假水面** → 湿列（nat≤SEA_Y）被抬后遮罩判据撕裂。Task 5 钉湿列零抬升、不传播。
5. **墩/裙边格未纳入植被让位索引** → 树冠穿墩穿裙边（v3.13c「树叶被切割」复发）。Task 7 钉树冠意图格 ∩ (墩格∪裙边格) = 0。

---

### Task 1: percentile75 纯函数 + 锚点 baseY 语义

**Files:**
- Modify: `src/gen/structures/jungle-fortress.js`（`computeJungleFortressAnchor` 的 `result` 行 258；新增 `percentile75` 导出）
- Test: `src/tests/test-jungle-fortress-gen.js`（`FROZEN_ANCHORS` 行 270~279 + 新增 percentile75 用例）

**Interfaces:**
- Produces: `percentile75(sortedArr: number[]): number`（返回 `arr[Math.floor(0.75*(arr.length-1))]`，空数组返回 0）；`computeJungleFortressAnchor(seed)` 返回 `{wx, wz, floorY, minH, span}`，其中 **`floorY` 语义改为 baseY（75 分位）**，`minH` 保留为占地最低自然高度。
- Consumes: 既有 `exactFootprint`（返回 `{minH,maxH,span}`）。

- [ ] **Step 1: 写 percentile75 失败测试**

在 `test-jungle-fortress-gen.js` 顶部 import 区加 `percentile75`，新增：

```js
test('丛林要塞 percentile75：合成数组逐值', () => {
  assertEqual(percentile75([0,1,2,3,4,5,6,7,8,9]), 7);   // floor(0.75*9)=6 → arr[6]=6? 实测见下
  assertEqual(percentile75([5]), 5);
  assertEqual(percentile75([]), 0);
  assertEqual(percentile75([1,1,1,9]), 1);               // floor(0.75*3)=2 → arr[2]=1
});
```

⚠️ 第一个断言的期望值实施时先 `console.log(percentile75([0..9]))` 实测再钉（`floor(0.75*9)=6` ⇒ `arr[6]=6`）。**断言描述想象中的世界是高频坑**，先跑再钉。

- [ ] **Step 2: 跑测试确认 FAIL**

Run: 浏览器 `/src/tests/index.html`，读 `window.__MC_TEST_RESULTS__`。Expected: `percentile75 is not defined`。

- [ ] **Step 3: 实现 percentile75 + 改锚点**

在 `jungle-fortress.js` 导出：

```js
export function percentile75(sortedArr) {
  if (!sortedArr.length) return 0;
  return sortedArr[Math.floor(0.75 * (sortedArr.length - 1))];
}
```

`computeJungleFortressAnchor` 内：精检命中后，收集占地 161×155 逐格 `generateHeight` 排序，`baseY = percentile75(sorted)`；`result = Object.freeze({ wx, wz, floorY: baseY, minH: f.minH, span: f.span })`。
⚠️ 收集高度可在 `exactFootprint` 里顺带返回排序数组，避免二次扫 24955 格（性能：锚点搜索已在 layout 入口预热，多一次排序 ~2ms 可接受，但优先复用）。

- [ ] **Step 4: 改 FROZEN_ANCHORS 并跑测试**

`FROZEN_ANCHORS` 的 `floorY` 全改为 `9`（8 seed），新增 `minH` 字段（12345/99999/1249026/20260101 = 0，777/4242/31337/8888 = -1）。锚点用例断言 `a.floorY === 9` 且 `a.minH === want.minH`。
Run: 浏览器单测。Expected: percentile75 + 锚点用例 PASS。

- [ ] **Step 5: 负向验证**

`page.route` 把 `percentile75` 换成 `arr[0]`（minH）⇒ 锚点用例 FAIL（floorY 回到 0/-1）。确认判别力后还原。

- [ ] **Step 6: Commit**

```bash
git add src/gen/structures/jungle-fortress.js src/tests/test-jungle-fortress-gen.js
git commit -m "feat(jungle-fortress): anchor floorY 改为 75 分位 baseY + percentile75 纯函数"
```

---

### Task 2: 删除削平整形，地表权威改为自然高度（内部）

**Files:**
- Modify: `src/gen/structures/jungle-fortress-terrain.js`（`jungleFortressSurfaceYAt` 行 45~64；`fillJungleFortressGround` 行 104~148）
- Modify: `src/gen/structures/apply.js`（阶段 2.95 行 1134~1147，移除 `fillJungleFortressGround` 调用）
- Test: `src/tests/test-jungle-fortress-gen.js`（整形类用例行 352~449 改写）

**Interfaces:**
- Produces: `jungleFortressSurfaceYAt(wx,wz,seed,anchor)` 暂返回 `generateHeight(wx,wz,seed)`（Task 5 再改为裙边后地面 T）；`fillJungleFortressGround` 删除（或保留空函数体 + 注释「v3.18 移除削平」）。
- Consumes: Task 1 的 `anchor.floorY = baseY`。

- [ ] **Step 1: 改写整形用例为「内部地形零改动」**

把「只削不填 + 零水格」「边缘高差≤1」「surfaceYAt 与 fillJungleFortressGround 一致」三条用例改写为：
```js
test('丛林要塞地形：占地内部逐列地表 == generateHeight（零削平）', async () => {
  // 取占地中心 column，fillColumn + carveCaves + applyStructuresToColumn 后
  // 逐列读「从天空向下第一格实心 wy」，断言 == generateHeight(wx,wz,seed)
  // ⚠️ 建筑列/墩列除外（Task 3/5 才加），本 Task 只验非建筑列
});
```
⚠️ 本 Task 完成后墩/裙边尚未加，地表应恒 = nat（建筑列产物实心会高于 nat，判据排除产物实心列）。

- [ ] **Step 2: 跑测试确认 FAIL**

Expected: 旧整形用例 FAIL（削平还在）或新用例 FAIL（地表被削平 ≠ nat）。

- [ ] **Step 3: 删除削平 + 改 surfaceYAt**

`jungleFortressSurfaceYAt` 改为 `return generateHeight(wx, wz, seed);`（保留函数签名与「唯一权威」注释，删插值逻辑）。
`fillJungleFortressGround` 整体删除；`apply.js` 阶段 2.95 移除对它的调用（光栅化保留，`jf.floorY` 现在是 baseY）。
`JUNGLE_FORTRESS_SLOPE_BAND` 常量保留（植被管理区仍用 16），注释更新「不再用于整形」。

- [ ] **Step 4: 跑测试确认 PASS**

Run: 浏览器单测 + `npm run check`。Expected: 新地形用例 PASS，`check:arch`/`check:data` 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/gen/structures/jungle-fortress-terrain.js src/gen/structures/apply.js src/tests/test-jungle-fortress-gen.js
git commit -m "feat(jungle-fortress): 删除削平整形，内部地形保留自然起伏"
```

---

### Task 3: 石墩（逐列补到自然地表）+ 漏底修补

**Files:**
- Modify: `src/gen/structures/jungle-fortress-terrain.js`（新增 `fillJungleFortressPiers`）
- Modify: `src/gen/structures/apply.js`（阶段 2.95 光栅化后调 `fillJungleFortressPiers`）
- Test: `src/tests/test-jungle-fortress-gen.js`（新增墩用例）

**Interfaces:**
- Produces: `fillJungleFortressPiers(column, anchor, seed, registry): void`。逐列：`baseNy`=该列最低产物实心 ny，`baseWy = anchor.floorY + (baseNy − floorRow)`，`h = generateHeight`；若 `baseWy−1 > h`，从 `ny=baseNy−1` 向下写 `mossy_stone` 直到 `wy ≤ h`，守卫 `column.blocks[idx]===0`。漏底修补：对地下房间 air 格与房间地板格，正下方第一格若既非产物实心也非产物 air 且是洞穴（`noise3D > 0.72`，`wy ≤ h−4`）⇒ 写 `stone`，迭代到补的格下方也是实心（≤9 轮）。
- Consumes: `loadStructure('jungleFortress')` 产物、`floorRowOf`、`noise3D`（from `caves.js`，阈值 0.72 是 `caves.js` 内部常量，需导出或复制判据——**优先导出 `CAVE_THRESHOLD`**，避免第二份权威）。

- [ ] **Step 1: 写墩失败测试**

```js
test('丛林要塞墩：8 seed 墩格数/列数/max 命中冻结表', async () => {
  // FROZEN_PIERS = {12345:[12332,3145,21], 99999:[13554,3471,21], 777:[12748,3208,21],
  //   4242:[14339,3686,21], 31337:[14220,3614,22], 20260101:[13663,3495,22],
  //   1249026:[13462,3439,21], 8888:[14491,3708,22]}
  // 真实 GEN 后统计「mossy_stone 且不在产物格」的格数/列数/单列最大
});
test('丛林要塞墩：不覆盖产物（含 air）、不穿地下房间', async () => { /* 墩格 ∩ 产物格 = 0 */ });
test('丛林要塞墩：顶被建筑盖住、底坐实地表', async () => { /* 墩顶正上方是产物实心；墩底下方非洞穴 */ });
test('丛林要塞漏底：修补后地下房间 air/地板下方第一格恒实心', async () => { /* 8 seed 零漏底 */ });
```

- [ ] **Step 2: 跑测试确认 FAIL**

Expected: `fillJungleFortressPiers is not defined`。

- [ ] **Step 3: 实现 fillJungleFortressPiers**

按 Interfaces 的算法。⚠️ 墩材质 `mossy_stone`（建筑主材，与墙同色）；漏底修补材质 `stone`。
⚠️ **`CAVE_THRESHOLD` 从 `caves.js` 导出**（改 `const CAVE_THRESHOLD = 0.72` 为 `export const`），墩模块 import 它，不复制 0.72。
⚠️ 漏底修补必须排除「下方是产物 air」（房间竖井，正常），否则多补 116 格（seed 4242）。

- [ ] **Step 4: apply.js 接线 + 跑测试**

阶段 2.95：光栅化后 `fillJungleFortressPiers(column, jf, seed, registry)`。
Run: 浏览器单测。Expected: 墩用例 PASS。

- [ ] **Step 5: 负向验证**

`page.route`：① 墩补到 `baseWy`（多一格）⇒ 「不覆盖产物」FAIL；② 从房间最低 air 起补 ⇒ 「不穿房间」FAIL；③ 去掉漏底「下方是产物 air 则跳过」⇒ 漏底格数变多。确认判别力后还原。

- [ ] **Step 6: Commit**

```bash
git add src/gen/structures/jungle-fortress-terrain.js src/gen/structures/apply.js src/gen/caves.js src/tests/test-jungle-fortress-gen.js
git commit -m "feat(jungle-fortress): 石墩托底 + 地下房间漏底修补"
```

---

### Task 4: 地下可见率 / 地上被埋率验收用例

**Files:**
- Test: `src/tests/test-jungle-fortress-gen.js`（新增可见率用例）

**Interfaces:**
- Consumes: Task 1~3 的 GEN 结果。

- [ ] **Step 1: 写可见率失败测试**

```js
test('丛林要塞：地下基座可见率 ∈ [40%,50%]（8 seed）', async () => {
  // 可见 = 高于地表 nat 且水平四邻至少一侧 nat 低于它
  // 基座 = 地下实心且不邻地下房间 air；8 seed 均 45.8%，逐 seed 41.7~48.7%
});
test('丛林要塞：地下房间外壳可见 ∈ [30%,39%]、房间 air 露出 ∈ [19%,31%]、竖井 air 露出 ∈ [45%,75%]', async () => {});
test('丛林要塞：地上墙真被埋（dy>0）∈ [6%,14%]', async () => {});
```
⚠️ 钉区间不钉精确值（逐列几何判定换 seed 会漂）。⚠️ 可见判据必须含「水平四邻」条件。

- [ ] **Step 2: 跑测试确认 FAIL/PASS**

Expected: 若 Task 1~3 正确，这些用例应直接 PASS（它们是验收而非驱动）。若 FAIL，停下查 Task 1~3。

- [ ] **Step 3: 负向验证**

`page.route` 把 baseY 换成 minH ⇒ 可见率全 0 ⇒ FAIL。确认判别力。

- [ ] **Step 4: Commit**

```bash
git add src/tests/test-jungle-fortress-gen.js
git commit -m "test(jungle-fortress): 地下可见率/地上被埋率验收用例"
```

---

### Task 5: 接壤阶梯过渡裙边（DR-10，用户追加裁定核心）

**Files:**
- Modify: `src/gen/structures/jungle-fortress-terrain.js`（新增 `jungleFortressSkirtField` + `fillJungleFortressSkirt` + 常量；`jungleFortressSurfaceYAt` 改为返回 T）
- Modify: `src/gen/structures/apply.js`（阶段 2.95 墩后调 `fillJungleFortressSkirt`）
- Test: `src/tests/test-jungle-fortress-gen.js`（新增裙边用例）

**Interfaces:**
- Produces:
  - `JUNGLE_FORTRESS_SKIRT_INNER = 12`、`JUNGLE_FORTRESS_SKIRT_OUTER = 22`（导出常量）。
  - `jungleFortressSkirtField(anchor, seed, data): (px,pz)=>number`（纯函数，返回过渡带后地面 T；按 anchor WeakMap 缓存）。算法：源 = 边缘环（占地最外圈）列，`source = 建筑列 ? baseTop−1 : (pierTop ?? nat)`；过渡带 = 占地内侧 R=12 ∪ 外侧 BW=22；`T(x,z) = max(nat, max_e(source(e) − dist4(e,(x,z))))`，dist4 为 4 邻域最短路，**建筑列/保护列/湿列不可穿越也不被抬**；建筑列 T = nat。用值降序优先队列（max-plus Dijkstra）。
  - `fillJungleFortressSkirt(column, anchor, seed, registry): void`：对过渡带内非建筑列，`T > nat` 时从 `nat+1` 到 `T` 逐格写：顶格 `surfaceTypeOfBiome(getBiome)`（FOREST→grass），下方 `dirt`。守卫 `blocks[idx]===0`。
  - `jungleFortressSurfaceYAt(wx,wz,seed,anchor)` 改为返回 `jungleFortressSkirtField(...)(wx−anchor.wx, wz−anchor.wz)`（需 data，内部 `loadStructure` 缓存）。
- Consumes: Task 3 的 pierTop/baseTop 派生（从产物 + anchor.floorY 算）、`prot`（露出地下 air 列）、`noise3D`/`CAVE_THRESHOLD`。

- [ ] **Step 1: 写裙边失败测试**

```js
test('丛林要塞裙边：带内/带缝/外侧地面相邻高差 ≤1（8 seed）', async () => {
  // 带内非建筑非保护非湿列相邻 |T差| ≤1；带内缘↔内部 nat ≤1；外侧非湿 ≤1
  // 8 seed 实测 max 0/0/1
});
test('丛林要塞裙边：不盖建筑（基座可见率不降 45.8%）', async () => {});
test('丛林要塞裙边：保护列零抬升、露出地下 air 仍露 602/seed', async () => {});
test('丛林要塞裙边：湿列零抬升、不传播', async () => {});
test('丛林要塞裙边：材质顶 grass / 下 dirt（FOREST）', async () => {});
test('丛林要塞裙边：填方冻结（内 655±/外 2317± 格）', async () => {});
```

- [ ] **Step 2: 跑测试确认 FAIL**

Expected: `jungleFortressSkirtField is not defined`。

- [ ] **Step 3: 实现 skirtField + fillSkirt + surfaceYAt 改 T**

按 Interfaces 算法。⚠️ 三屏障缺一即静默退化（建筑列被盖→基座可见率降；保护列被抬→露出 air 被埋；湿列被抬→假水面）。
⚠️ 优先队列用值降序（`[value, key, dist]`，value 大优先），settled 集合防重复松弛。
⚠️ `jungleFortressSurfaceYAt` 改 T 后，Task 2 的「内部地形零改动」用例仍 PASS（内部非带列 T=nat）。

- [ ] **Step 4: apply.js 接线 + 跑测试**

阶段 2.95：墩后 `fillJungleFortressSkirt(column, jf, seed, registry)`。
Run: 浏览器单测 + `npm run check`。Expected: 裙边用例 PASS，Task 2/4 用例仍 PASS。

- [ ] **Step 5: 负向验证（三条屏障各一）**

`page.route`：① 去掉内侧 R 缓坡（R=0）⇒ 跨界沟槽 max 9~10 ⇒ 「带内高差」FAIL；② 去掉保护屏障 ⇒ 露出 air 被埋 ⇒ FAIL；③ 去掉湿屏障 ⇒ 湿列被抬 ⇒ FAIL。确认判别力后还原。

- [ ] **Step 6: Commit**

```bash
git add src/gen/structures/jungle-fortress-terrain.js src/gen/structures/apply.js src/tests/test-jungle-fortress-gen.js
git commit -m "feat(jungle-fortress): 接壤阶梯过渡裙边（内外两侧 Lipschitz 包络 + 三屏障）"
```

---

### Task 6: 瞬移落点改自然地表+1

**Files:**
- Modify: `src/gen/structures/jungle-fortress.js`（`jungleFortressTeleportPoint` 行 401~411）
- Test: `src/tests/test-jungle-fortress-gen.js`（`FROZEN_TELEPORT` 行 1024~1033）
- Modify: `tests/jungle-fortress.spec.mjs`（冻结落点 y 行 135）

**Interfaces:**
- Consumes: Task 5 的 `jungleFortressSurfaceYAt`（= T）。落点在东缘外 6 格（带外缘，T=nat）⇒ y = nat+1。

- [ ] **Step 1: 改 FROZEN_TELEPORT + spec 冻结值**

`FROZEN_TELEPORT` y 改为：12345/99999/1249026 = 6，777/4242/31337/20260101/8888 = 5（x/z 不变）。
`jungle-fortress.spec.mjs` 行 135 `toBe(3)` → `toBe(6)`，文案改「自然地表+1」。

- [ ] **Step 2: 跑测试确认 FAIL**

Expected: 瞬移用例 FAIL（旧 y=3/2）。

- [ ] **Step 3: 改 jungleFortressTeleportPoint**

`const surface = jungleFortressSurfaceYAt(x, z, seed, a);`（去掉 `?? generateHeight` 兜底，T 恒有值）；`y = surface + 1`。注释更新「落点在带外缘，T=nat」。

- [ ] **Step 4: 跑测试确认 PASS**

Run: 浏览器单测 + `npx playwright test tests/jungle-fortress.spec.mjs -g "瞬移"`（或整 spec）。Expected: PASS。

- [ ] **Step 5: 负向验证**

`page.route` 把 surface 换成 `anchor.floorY`（baseY=9）⇒ y=10 ⇒ 悬空 4~5 格 ⇒ FAIL。

- [ ] **Step 6: Commit**

```bash
git add src/gen/structures/jungle-fortress.js src/tests/test-jungle-fortress-gen.js tests/jungle-fortress.spec.mjs
git commit -m "feat(jungle-fortress): 瞬移落点 y 改自然地表+1（8 seed 冻结 5/6）"
```

---

### Task 7: 植被让位含墩+裙边，地表口径统一

**Files:**
- Modify: `src/gen/structures/apply.js`（`jungleFortressCells` 行 203~218 索引含墩+裙边；植被分支行 1237~1277 地表口径）
- Test: `src/tests/test-jungle-fortress-gen.js`（既有让位用例 + 新增）

**Interfaces:**
- Consumes: Task 3 墩格、Task 5 裙边格、`jungleFortressSurfaceYAt`（T）。
- Produces: `jungleFortressCells(data, anchor, seed)` 索引含产物非空气格 + 墩格 + 裙边格（运行期派生，WeakMap 缓存键改为 data+anchor）。

- [ ] **Step 1: 写让位失败测试**

```js
test('丛林要塞植被：树冠意图格 ∩ (墩格∪裙边格) = 0', async () => {
  // 用真实 generateTree 收集意图格（v3.13c 口径），比对墩+裙边格
});
test('丛林要塞植被：草/树干落点 y = jungleFortressSurfaceYAt（裙边后地面）', async () => {});
```

- [ ] **Step 2: 跑测试确认 FAIL**

Expected: 树冠穿墩/裙边（索引未含）。

- [ ] **Step 3: 改索引 + 地表口径**

`jungleFortressCells` 加墩格（Task 3 派生）+ 裙边格（Task 5 派生）；缓存键含 anchor。
植被分支 `surface = jungleFortressSurfaceYAt(wx,wz,seed,jf)`（已是 T，确认调用正确）；`groundNy = groundY − jf.floorY + jfFloorRow`（jf.floorY 现在是 baseY，确认换算正确）。
⚠️ `jfVegSetter` / `jfCellFreeAt` 的 ny 换算用 `anchor.floorY`（baseY），与光栅化同口径。

- [ ] **Step 4: 跑测试确认 PASS**

Run: 浏览器单测。Expected: 让位用例 PASS，既有 v3.13c/d/e 用例仍 PASS。

- [ ] **Step 5: 负向验证**

`page.route` 索引去掉墩+裙边 ⇒ 树冠穿墩 ⇒ FAIL。

- [ ] **Step 6: Commit**

```bash
git add src/gen/structures/apply.js src/tests/test-jungle-fortress-gen.js
git commit -m "feat(jungle-fortress): 植被让位索引含墩+裙边，地表口径统一走 surfaceYAt"
```

---

### Task 8: Tier 4 像素验收（六机位）+ 回归

**Files:**
- Modify: `tests/jungle-fortress.spec.mjs`（新增机位①~⑥像素用例；既有俯瞰/室内机位 y 换算改 baseY）

**Interfaces:**
- Consumes: Task 1~7 全部 GEN 结果。

- [ ] **Step 1: 改既有机位 y 换算**

spec 行 138 `anchor.floorY + 45`（俯瞰）、行 211 `a.floorY + (16 − d.floorRow)`（室内）——`floorY` 现在是 baseY=9，换算自动正确，但**核对室内机位 (10,16,2) 仍是 air**（baseY 变了，世界 y 变了，产物 ny 不变 ⇒ 仍是 air ✓）。

- [ ] **Step 2: 写六机位像素用例**

按 spec §6 Tier 4 表：① 墩身仰视 (-254,2,263) 朝西仰 46°；② 半埋房间 (-242,4,256) 朝北；③ 露天坑 (-236,168) 俯视 y=20；④ 全景 (-194,1,217) 朝西仰 15~43°；⑤ 地形起伏 (-204,3,217) 朝西；⑥ 接壤阶梯 (-218,6,270) 朝西。
每条同时钉上下界 + 先测重复截图噪声底 + 带对照组（`page.route` 换 baseY=minH 或 R=BW=0）。
⚠️ 机位⑥判据「地面轮廓呈阶梯下降、无垂直悬崖像素带」：用 `stoneStats` 类似的逐行扫描，量「相邻行地面 y 差 ≤1 的占比」，对照组（无裙边）应出现 ≥2 的突变带。

- [ ] **Step 3: 跑 spec 确认 PASS**

Run: `npx playwright test tests/jungle-fortress.spec.mjs`（`worktree:false` 或独立端口）。Expected: 全 PASS。

- [ ] **Step 4: 回归**

Run: `npm run check` + `npx playwright test tests/teleport.spec.mjs tests/structure-gen.spec.mjs` + 浏览器整页单测。
Expected: 全绿。若 `structure-gen` genP95 贴线，按交替对照判定（不改阈值）。
**不跑 `bench --check`**（不碰渲染管线）。

- [ ] **Step 5: Commit**

```bash
git add tests/jungle-fortress.spec.mjs
git commit -m "test(jungle-fortress): Tier 4 六机位像素验收（含接壤阶梯过渡）"
```

---

### Task 9: 文档收尾（roadmap + CLAUDE.md）

**Files:**
- Modify: `docs/roadmap.md`（v3.18 行）
- Modify: `CLAUDE.md`（高频坑：墩语义/漏底口径/层序/percentile75 派生/裙边三屏障）

- [ ] **Step 1: 写 roadmap v3.18 行**

按既有版本表格式，记：用户裁定（保留自然+抬升+石墩+接壤阶梯）、实测冻结值（墩 13601/裙边 2972/可见率 45.8%/带内高差 0）、验证证据（单测/spec/check 输出）、顺带修上层件悬空。

- [ ] **Step 2: 写 CLAUDE.md 高频坑**

⚠️ `git add CLAUDE.md`（不是 AGENTS.md，那是符号链接）。新增：
- 裙边三屏障（建筑/保护/湿列）缺一即静默退化；只外侧留沟槽、只内部埋基座。
- 漏底修补排除「下方是产物 air」（竖井），粗口径填 36026 格 vs 精确 74 格。
- `anchor.floorY` 语义 = baseY（75 分位），五处消费方同改。
- percentile75 派生不硬编码 9。
- 层序：先光栅化后墩后裙边。

- [ ] **Step 3: Commit**

```bash
git add docs/roadmap.md CLAUDE.md
git commit -m "docs(jungle-fortress): v3.18 roadmap + 高频坑"
```

---

## Self-Review

**1. Spec coverage:** DR-1（baseY）→Task 1；DR-2（删削平）→Task 2；DR-3（墩）→Task 3；DR-4（漏底）→Task 3；DR-5（可见率）→Task 4；DR-6（瞬移）→Task 6；DR-7（植被）→Task 7；DR-8（层序）→Task 3/5；DR-9（预算）→Task 8 回归；DR-10（裙边）→Task 5。§6 Tier 4 六机位→Task 8。全覆盖。

**2. Step scan:** 每步一个可检查动作；算法块只给签名+判据不决定的部分（包络传播/漏底迭代）。无「TBD/处理边界」空话。

**3. Type consistency:** `percentile75`/`fillJungleFortressPiers`/`jungleFortressSkirtField`/`fillJungleFortressSkirt`/`jungleFortressSurfaceYAt` 签名跨 Task 一致；`anchor.floorY`=baseY 全程统一；`CAVE_THRESHOLD` 从 caves.js 导出（Task 3 改，Task 5 复用）。

**4. Review Focus:** 五类各有钉它的用例（裙边三屏障→Task 5；floorY 语义→Task 1/6/7；保护列→Task 5；湿列→Task 5；让位索引→Task 7）。

**5. Proportion:** 计划 ~9 Task，每 Task 6 步，代码块只给算法关键处；与 spec（10 DR + 冻结表）比例相当，非程序转录。