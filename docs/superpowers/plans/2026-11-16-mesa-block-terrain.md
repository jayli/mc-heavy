# 南方台地三地貌（单块嵌入）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在世界南方第一个高台地带的南侧嵌入一块 800×800 的三地貌区域（平顶桌山 / 下切河谷 / 恶地层脊），块外世界逐位不变。

**Architecture:** 新增三个 Worker 同构纯函数模块（Perlin 噪声 / cubic spline / 块布局与高度），在 `generateHeightForBiome` 内以「矩形早退 → 块高度 → 套既有 biome 压平」接入。块内 x 线性重映射铺满样条断点区间，故不需要水平尺度标定。水面判据一字不动，只把 `ocean.js` 的 TSL 高度输入同步（它是 `generateHeight` 的同构副本）。

**Tech Stack:** 原生 ESM（无构建）、Node v26、three r185.1 本地 `vendor/three/`（import map）、TSL / WebGPU、Playwright（`channel: 'chromium'`）。

**Spec:** `docs/superpowers/specs/2026-11-16-mesa-block-terrain-design.md`

## Global Constraints

- **水面逻辑一律沿用现状**（用户 2026-11-16 裁定）：`fillColumn` 水体分支、`render/ocean-mask.js`、浅水高台整形（`shallow-water-terrain.js` / `tarn-terrain.js`）**一行不改**。只同步 `ocean.js` 的 TSL 高度输入。
- **块外逐位不变**：块矩形外 `generateHeight` 的返回值必须与改动前逐位相同。这是本 Epic 的核心不变式。
- **宿主高台地带圆内零改动**：混合带**只向块内**（`dIn < 0` 直接返回现状高度）。向外伸会改宿主缓坡（spec R8 实测 139~594 格被改）。
- **既有 biome 压平保留在最外层**：`DESERT ×0.5+2` / `SWAMP ×0.3−2` / `CITY ×0.25+1`，读 `TERRAIN_HEIGHT_PARAMS`，不写字面量。
- **Worker 同构**（红线 8/10）：`src/gen/` 新文件不得 import three、不得自建 Worker、不得 fetch、无 DOM。
- **确定性**（红线 2）：块位置与形状只由 `(seed, 坐标)` 推导，无 `Math.random`、无运行期可变状态。
- **spline 端点按 derivative 线性外插**，不是 clamp（clamp 会让 `spline(idxPts,0)` 得 −25 而非 3）。
- **时间基准 `performance.now()`**，禁止 `Date.now()`。坐标取模一律非负。
- **`assertEqual` 是 `===`**：数组用 `assertDeepEqual`；`assertClose` **不存在**于 `assert.js`，需要容差比较时在测试文件内自定义局部函数。
- **新测试文件必须同时注册进 `src/tests/index.html`**（漏注册 = 静默不跑，`check:data` 的 `[测试注册]` 双向钉）。
- **TSL 动态查表必须用 `textureLoad` + `DataTexture`（NearestFilter）**。⚠️ **`uniformArray().element(动态下标)` 在 WebGPU 后端静默返回错值**（2026-11-16 实测：11 个下标只有前 2 个正确，其余恒返回同一元素，无报错）。
- **冻结数字不符时停下来报告**，不擅自改断言或放宽阈值。
- 块尺寸 **800**、混合带宽 **W=48**、高度系数 **K=100**、`RIDGE_SPAN=0.55`、`DETAIL=0.12`、避让净距 **32**（= `CITY_TRANSITION_SIZE`，不写字面量）。
- 上游 Tectonic 是 **MIT**（`build.gradle.kts:32`）@ `34241bd`，三条子样条控制点数值来自 `region/club`，须在 `mesa-block.js` 文件头注明来源与 commit。

## Review Focus

以下五类是 spec 隐含、但各任务测试不直接覆盖的失效形态，按咬人概率排序。每条已在其归属任务里追加了对应测试步骤。

1. **混合带向外溢出改宿主地形**（块矩形外的格被改）—— 玩家看到高台地带的缓坡被削出一道坎。→ Task 4 Step 2 的「宿主圆内零改动」用例（只钉「矩形外不变」抓不到它，因为它落在矩形外）。
2. **TSL 与 CPU 判据撕裂**（漏同步 `ocean.js`）—— 陆地上冒假水面 / 真水失去波纹，肉眼只觉得「水怪怪的」。→ Task 6 Step 2 的逐点比对 + Task 7 的像素实测。
3. **坐标重映射常量漂移**（`RIDGE_SPAN`/`DETAIL` 把 coord 推出样条端点）—— 端点外是线性外插不是 clamp，高度会失控炸出世界。→ Task 4 Step 2 的 coord 值域用例 + 块内高度上下界。
4. **块位置搜索在陌生 seed 上返回 null**（世界少一块地貌，且无任何报错）—— 用户走半天找不到新地形。→ Task 3 Step 2 的 12 seed 全落地用例（含 `checked > 0` 防恒真）。
5. **结构锚点从「移位」恶化成「召不出」**（返回 null）—— Boss 结构静默消失。→ Task 5 Step 2 的「非 null」与「移位后 candidateValid 仍通过」两条分开断言。

---

### Task 1: Perlin 噪声（Worker 同构）

**Files:**
- Create: `src/gen/terrain-noise.js`
- Test: `src/tests/test-terrain-noise.js`
- Modify: `src/tests/index.html`（追加 import）

**Interfaces:**
- Consumes: 无（本 Epic 最底层）
- Produces:
  - `createPermutation(seed: number) -> Uint8Array`（长度 512）
  - `perlin3(perm: Uint8Array, x: number, y: number, z: number) -> number`
  - `makeNoise2D(perm: Uint8Array, firstOctave: number, amplitudes: number[]) -> (x: number, z: number) => number`
  - `MESA_NOISE_SPECS: Readonly<{ ridge: {firstOctave, amplitudes}, lower: {...}, badlands: {...} }>`
  - `getMesaNoise(seed: number) -> { ridge, lower, badlands }`（各为 `(x,z)=>number`；按 seed 缓存）

- [ ] **Step 1: 写失败测试**

`src/tests/test-terrain-noise.js`，用 `import { test } from './runner.js'` 与 `assertEqual / assertTrue / assertDeepEqual`。文件内自定义 `const assertClose = (a, b, eps, msg) => assertTrue(Math.abs(a - b) <= eps, msg)`（`assert.js` 没有它）。

四条用例：
1. `createPermutation`：长度 512；前 256 项是 0..255 的一个排列（`new Set(...).size === 256`）；`perm[i] === perm[i & 255]` 对 i ∈ [256,512) 成立；同 seed 两次调用 `assertDeepEqual`。
2. `perlin3` 整数格点恒 0：对 (0,0,0)、(7,0,-3)、(-16,0,16) 断言 `assertClose(perlin3(...), 0, 1e-12)`。
3. `perlin3` 值域与确定性：±64 步长 3.7 的非整数采样（含负坐标），全部 `Number.isFinite` 且 `|v| <= 1`；同点两次调用逐位相同。
4. **零 amplitude 被跳过，且归一化按非零项数**：`makeNoise2D(perm,-8,[1,2,1])` 与 `makeNoise2D(perm,-8,[1,2,1,0])` 在 40 个非整数采样点上**逐位相同**（尾部补零不改变任何 octave）。
   ⚠️ **不要用 `[1,0,2]` vs `[1,2]` 做这条**：中间零项会**移位的 octave 下标**（`2^(firstOctave+i)` 的 i 不同），实测最大差 **0.1885**，断言「相同」是错的。
   **判别力已实测**：把归一化写成 `amplitudes.length`（而非非零项数）时，`[1,2,1,0]` 两侧最大差 **0.1233** ⇒ 本用例能抓到该缺陷。
   另断言 `MESA_NOISE_SPECS.ridge.amplitudes` 深等于 `[1,2,1]`、`lower` 深等于 `[1.4,2,1]`（spec §2.4 值）。

- [ ] **Step 2: 跑测试确认失败**

浏览器打开 `/src/tests/index.html`，读 `window.__MC_TEST_RESULTS__`（用例在 `suites.flatMap(s => s.tests)`）。
Expected: FAIL —— `Failed to resolve module specifier './terrain-noise.js'`（文件不存在）。

- [ ] **Step 3: 实现 `src/gen/terrain-noise.js`**

MC 口径 Improved Perlin：`fade(t)=t³(t(6t−15)+10)`、`grad(h,x,y,z)` 按 `h & 15` 的 16 分支（与 spec §7 探针逐项一致）、三线性 `lerp`。
`createPermutation`：0..255 用 LCG（`s = (s*1103515245 + 12345) & 0x7fffffff`，`rnd = s/0x7fffffff`）Fisher-Yates 洗牌，seed 参与初值；再镜像成 512。
`makeNoise2D`：只取 `amplitudes` 非零项，`norm = 非零项数 / Σ|a| × 0.5`，每项频率 `2^(firstOctave+i)`、权重 `a*norm`，求值 `Σ w·perlin3(perm, x*f, 0, z*f)`。
`MESA_NOISE_SPECS` 三项（spec §2.4 / 探针实测值）：`ridge` = `{-8, [1,2,1]}`、`lower` = `{-8, [1.4,2,1]}`、`badlands` = `{-8, [1,2,1]}`。
`getMesaNoise` 按 seed 缓存（`Map`，上限 8 条，超出删最早键）。

⚠️ 文件头注明：permutation 用 LCG 自造（**不是 MC 的 seed 派生**），故绝对数值不与原版 Minecraft 逐位相同；这是刻意选择，spec §7.5 已记为未核边界。

- [ ] **Step 4: 注册并跑测试确认通过**

在 `src/tests/index.html` 的 import 区块末尾（`import './test-health.js';` 之后）追加 `import './test-terrain-noise.js';`。
Run: `npm run check:data`
Expected: `[测试注册] N 个测试文件全部已注册`（无 unregistered / dangling）。
浏览器读 `__MC_TEST_RESULTS__`：本文件 4 条全 passed。

- [ ] **Step 5: 提交**

```bash
git add src/gen/terrain-noise.js src/tests/test-terrain-noise.js src/tests/index.html
git commit -m "feat(gen): 新增 Improved Perlin 噪声（台地三地貌用，Worker 同构）"
```

---

### Task 2: cubic spline 求值器（端点线性外插）

**Files:**
- Create: `src/gen/terrain-spline.js`
- Test: `src/tests/test-terrain-spline.js`
- Modify: `src/tests/index.html`

**Interfaces:**
- Consumes: 无
- Produces:
  - `splinePoint(location: number, value: number|(() => number), derivative?: number) -> {location, value, derivative}`
  - `evalSpline(points: Array<{location, value, derivative}>, c: number) -> number`（**惰性**：`value` 是函数时只在命中该支时调用）

- [ ] **Step 1: 写失败测试**

`src/tests/test-terrain-spline.js`，四条用例：
1. **端点语义（载荷性）**：构造 `idxPts = [(-0.48,1),(-0.42,2),(-0.18,2),(-0.12,3),(0.17,3),(0.23,4),(0.52,4),(0.58,5)]`（derivative 全 0），断言 `assertEqual(evalSpline(idxPts, 0), 3)`。注释写明「clamp 版会得 −25」。
2. **端点外按 derivative 线性外插**：`pts = [splinePoint(0, 10, 2), splinePoint(1, 20, 0)]`，断言 `evalSpline(pts, -1) === 8`（10 + 2×(−1)）与 `evalSpline(pts, 2) === 20`。
3. **惰性求值**：`value` 传 thunk 并计数调用次数；`evalSpline([splinePoint(0, thunkA), splinePoint(1, thunkB)], 0.25)` 后断言两个 thunk 各被调用 ≤1 次，且**第三支未被命中时其 thunk 调用数为 0**（构造三支、c 落在第一支区间内，断言第三支 thunk 计数 `assertEqual(..., 0)`）。
4. **段内 Hermite 端点吻合**：`evalSpline(pts, 0) === 10`、`evalSpline(pts, 1) === 20`；中点值落在 [10,20] 内。

- [ ] **Step 2: 跑测试确认失败**

Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 `src/gen/terrain-spline.js`**

`evalSpline`：`c < points[0].location` → `val(points[0]) + derivative*(c − location)`；`c > 末点` 同理；否则线性找到 `points[i+1].location <= c` 的最大 i，取 a/b 两点，`d = b.location − a.location`、`t = (c − a.location)/d`，Hermite 基 `(2t³−3t²+1)·av + (t³−2t²+t)·ad + (−2t³+3t²)·bv + (t³−t²)·bd`，其中 `ad = a.derivative*d`、`bd = b.derivative*d`。`val(p)` 对函数型 value 调用求值（惰性）。`a === b` 时直接返回 `val(a)`。

- [ ] **Step 4: 注册并跑测试确认通过**

追加 `import './test-terrain-spline.js';`；`npm run check:data` 无注册失败；浏览器 4 条全 passed。

- [ ] **Step 5: 提交**

```bash
git add src/gen/terrain-spline.js src/tests/test-terrain-spline.js src/tests/index.html
git commit -m "feat(gen): 新增 cubic spline 求值器（端点线性外插 + 惰性分支）"
```

---

### Task 3: 块布局与避让搜索

**Files:**
- Create: `src/gen/mesa-block.js`（本任务只写布局部分）
- Test: `src/tests/test-mesa-block.js`
- Modify: `src/tests/index.html`

**Interfaces:**
- Consumes: `isTarnZone` / `tarnZoneCenter` / `TARN_ZONE_RADIUS`（`gen/structures/tarn-zone.js`）、`getCityBoundsForSeed`（`city-layout.js`）、`computeBurningArenaAnchor`（`burning-arena.js`）、`computeRuinedCitadelAnchor`（`ruined-citadel.js`）、`computeArenaAnchor`（`arena.js`）、`computeShallowTarnAnchor` + `SHALLOW_TARN_OUTER_RADIUS`（`shallow-water-tarns.js`）、`CITY_TRANSITION_SIZE`（`region-config.js`）、`BURNING_ARENA_HALF`（`burning-arena-data.js`）、`RUINED_CITADEL_HALF_X/Z`（`ruined-citadel-data.js`）、`ARENA_HALF_X/Z`（`arena.js`）
- Produces:
  - `MESA_BLOCK_SIZE = 800`、`MESA_BLEND_WIDTH = 48`、`MESA_HEIGHT_SCALE = 100`、`MESA_RIDGE_SPAN = 0.55`、`MESA_RIDGE_DETAIL = 0.12`
  - `MESA_SEEDS_PROBE: readonly number[]`（12 个：12345, 1234, 2096, 2644, 3740, 4151, 4973, 99999, 11984370, 7777, 4567, 987654）
  - `firstSouthTarnZone(seed: number) -> {regionX, regionZ, cx, cz} | null`
  - `computeMesaBlock(seed: number) -> {minX, minZ, maxX, maxZ, hostCx, hostCz, bandHeight} | null`（按 seed 缓存）
  - `clearMesaBlockCache() -> void`
  - `inMesaBlock(x: number, z: number, block) -> boolean`（严格矩形内，`block` 为 null 时恒 false）

- [ ] **Step 1: 写失败测试**

`src/tests/test-mesa-block.js`，五条用例：
1. **宿主选择确定性**：`firstSouthTarnZone(12345)` 的 `regionZ > 0`；同 seed 两次 `assertDeepEqual`；断言 seed 12345 得 `{regionX: -1, regionZ: 2}`（spec §7 实测值）。
2. **12 seed 全落地**：对 `MESA_SEEDS_PROBE` 逐个 `computeMesaBlock`，`assertNotNull`；累计 `checked` 并断言 `assertEqual(checked, 12)`（防恒真）。
3. **块尺寸与接壤**：`maxX − minX === 800`、`maxZ − minZ === 800`、`bandHeight === 800/3`；块到宿主圆的净距 ∈ [−40, 120]（用 `circleRectGap`，从 `tarn-zone.js` import，**不自己写一份**）。
4. **避让净距 ≥32**：逐 seed 断言块与「其它高台地带圆（半径 `TARN_ZONE_RADIUS`）」「城市 bounds」「四个结构占地」的净距均 `>= CITY_TRANSITION_SIZE`。⚠️ **必须排除宿主自己**。每类各自累计 `checked` 并断言 > 0（防「没有邻居 → 判据恒真」）。
5. **`inMesaBlock` 边界**：矩形内 true、四边外 1 格 false、`block=null` 恒 false。

- [ ] **Step 2: 跑测试确认失败**

Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现布局部分**

`firstSouthTarnZone`：扫 `rx ∈ [-8,8] × rz ∈ [1,8]`，取 `isTarnZone` 为真者，排序键 `rz 升序 → |rx| 升序 → rx 升序`，取首个。
`computeMesaBlock`：首选矩形 x 居中宿主圆心、`minZ = hostCz + TARN_ZONE_RADIUS`；候选顺序 **先沿 x 平移（步长 100，dx 从 0 递增，每个 dx 先 −1 后 +1），再沿 z 南移（步长 100，dz 0..8，dx 0..16）**；接受条件 = 宿主净距 ∈ [−40,120] 且其它地带/城市/四结构净距 ≥ `CITY_TRANSITION_SIZE`。找不到返回 null。
按 seed 缓存（`Map`，上限 16）。

⚠️ 文件头写明：**「避让结构占地」只防「块压住旧锚点」，防不住「锚点移位」**（spec §5.1 实测：加该判据后选址结果逐位相同）。移位是既有「距城最近 + span 先严后松」语义的正常结果，本轮接受（spec R7）。

- [ ] **Step 4: 注册并跑测试确认通过**

追加 import；`npm run check:data` 通过；浏览器 5 条全 passed。

- [ ] **Step 5: 提交**

```bash
git add src/gen/mesa-block.js src/tests/test-mesa-block.js src/tests/index.html
git commit -m "feat(gen): 台地块布局与避让搜索（南方第一个高台地带南侧）"
```

---

### Task 4: 三条带高度 + 混合带 + 坐标重映射

**Files:**
- Modify: `src/gen/mesa-block.js`（追加高度部分）
- Modify: `src/tests/test-mesa-block.js`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 `getMesaNoise`、Task 2 的 `splinePoint` / `evalSpline`、Task 3 的 `computeMesaBlock` / 常量
- Produces:
  - `mesaRawHeight(x: number, z: number, block, noise) -> number`（**未套 biome 压平**的块内高度，整数）
  - `MESA_BAND_NAMES = ['plateau', 'valley', 'badlands']`（北→南）
  - `MESA_SPLINE_TABLES`：**纯数据**的三条带控制点表 + `tier`/`bad` 子样条表（无函数、无 three 依赖）。Task 6 的 TSL 侧读同一份，**不得各写一份字面量**（红线 1）。

- [ ] **Step 1: 写失败测试**

追加七条用例到 `src/tests/test-mesa-block.js`：
1. **coord 值域**（Review Focus 3）：块内 x 从 minX 到 maxX 步长 7，`coord` 全部落在 `[−0.55 − 0.12, 0.55 + 0.12]`；且**去掉 detail 项后的线性部分**恰好铺满 `[−0.55, 0.55]`（两端点断言 `assertClose(..., 1e-9)`）。
2. **三条带形态**（钉住「地形不是平的」）：seed 12345，逐带统计「出现频次最高的高度值占比」，断言 plateau ≥ 0.10、valley ≥ 0.08、badlands ≥ 0.20（spec §7.1 实测 15.4/12.1/44.4，下界留余量）。
3. **块内高度上下界**（同时钉，防炸出世界）：12 seed 全部块内采样高度 `>= WORLD_MIN_Y` 且 `<= WORLD_MAX_Y`；且最大值 `<= 60`（实测最高 51）。
4. **界外逐位不变**（核心不变式）：对 12 seed，在块矩形**外**取样（含四边外 1 格与远处），`generateHeightForBiome` 与「不装块的原公式」逐位相同。原公式参考值在测试内按 `TERRAIN_HEIGHT_PARAMS` + `noise()` 现算（不 import 第二份实现）。
5. **宿主圆内零改动**（Review Focus 1）：宿主圆（半径 `TARN_ZONE_RADIUS`）内逐格（步长 2）高度与原公式逐位相同。⚠️ 注释写明「这条落在块矩形外，只钉上一条会漏掉它」。
6. **接缝**：块内邻格最大高差 `<= 55`（实测最大 47 + 余量）；`> 1.0`（玩家 `MAX_STEP` 的值，**它在 `physics.js` 里未导出，测试里写注释注明来源、不 
 import**）的相邻对占比 `<= 0.10`。
7. **确定性**：同 `(x,z,seed)` 两次 `mesaRawHeight` 逐位相同；`clearMesaBlockCache()` 后重算仍相同。

- [ ] **Step 2: 跑测试确认失败**

Expected: FAIL —— `mesaRawHeight is not a function`。

- [ ] **Step 3: 实现高度部分**

三条子样条控制点先落成 **`MESA_SPLINE_TABLES` 纯数据**（Task 6 的 TSL 侧读同一份），再由 CPU 侧包成 thunk 消费。数值来自 Tectonic `region/club`（MIT @ 34241bd，须在文件头注明）：
- **plateau**：`[(-0.5,0.25,-0.1), (-0.4,tier(0.1,0.22)), (-0.3,0.05,-0.8), (-0.1,0.01), (-0.03,-0.06,-0.5), (0.03,-0.06,0.5), (0.1,0.01), (0.3,0.05,0.8), (0.4,tier(0.135,0.28)), (0.5,0.35,0.1)]`，coordinate = `coord`
- **valley**：`[(-0.5,0.25,-0.1), (-0.4,tier(0.1,0.22)), (-0.3,0.05,-0.8), (-0.1,0.01), (-0.03,-0.06,-0.5), (0.03,-0.06,0.5), (0.075,0.01), (0.14,0.05,0.8), (0.2,tier(0.135,0.28)), (0.3,0.35), (0.45,0.03)]`，coordinate = `coord`
- **badlands**：`[(0,-0.15,2.5), (0.1,0.04), (0.2,bad(0.15,0.185)), (0.3,bad(0.185,0.5))]`，coordinate = `|coord|`
- `tier(b,t)` = 子样条 `[(0,b),(0.15,t)]` 在 `|lower(x*0.35, z*0.35)|` 处求值（**thunk，惰性**）
- `bad(b,c)` = 子样条 `[(0.45,0.05),(0.6,b,1.5),(0.63,c,0.2)]` 在 `|badlands(x*0.35, z*0.35)|` 处求值（thunk）

`coord = −MESA_RIDGE_SPAN + ((x − minX)/MESA_BLOCK_SIZE)*2*MESA_RIDGE_SPAN + MESA_RIDGE_DETAIL*ridge(x*0.25, minZ*0.25)`

带选择 `bi = clamp(floor((z − minZ)/bandHeight), 0, 2)`；带间混合：`dBand = min(z − zLo, zHi − z)`，`dBand < W` 时与邻带（ nearer 侧）按 `0.5 − 0.5·cos(π·dBand/W)` 混合。
块↔外界：`dIn = min(x−minX, maxX−x, z−minZ, maxZ−z)`；**`dIn < 0` 由调用方早退**（本函数只处理块内）；`dIn >= W` 返回纯块高度；否则按 `0.5 − 0.5·cos(π·dIn/W)` 与现状高度混合。
最后 `Math.floor(...)`。**本函数不套 biome 压平**（由 Task 5 在外层套）。

- [ ] **Step 4: 跑测试确认通过**

浏览器：本文件 12 条全 passed。

- [ ] **Step 5: 提交**

```bash
git add src/gen/mesa-block.js src/tests/test-mesa-block.js
git commit -m "feat(gen): 台地三条带高度 + 48 格 inward-only 混合带 + 坐标重映射"
```

---

### Task 5: 接入 generateHeightForBiome（保留 biome 压平）

**Files:**
- Modify: `src/gen/terrain.js:29-37`（`generateHeightForBiome`）
- Modify: `src/tests/test-mesa-block.js`（追加接入层用例）

**Interfaces:**
- Consumes: Task 3 的 `computeMesaBlock` / `inMesaBlock`、Task 4 的 `mesaRawHeight`、Task 1 的 `getMesaNoise`
- Produces: `generateHeightForBiome(x, z, seed, biome)` 签名**不变**；块外行为逐位不变

- [ ] **Step 1: 写失败测试**

追加三条用例：
1. **块外逐位不变（端到端）**：12 seed × 块矩形外采样，`generateHeight(x,z,seed)` 与改动前公式逐位相同（参考值按 `TERRAIN_HEIGHT_PARAMS` + `getBiome` 现算）。
2. **既有结构锚点不失败**（Review Focus 5）：12 seed 上 `computeBurningArenaAnchor` / `computeRuinedCitadelAnchor` / `computeArenaAnchor` / `computeShallowTarnAnchor` **全部非 null**（累计 checked 断言 = 48）。⚠️ **每次调锚点前必须清全部四个缓存**：`clearBurningArenaCache` / `clearRuinedCitadelCache` / `clearArenaCache` / `clearShallowTarnCache` —— 围场锚点是前两者选址的 blocker 输入，漏清会串味（spec §7 实测踩过）。
3. **移位锚点仍合法**：对与 base 不同的锚点，断言 `burningArenaCandidateValid(wx,wz,span,seed)` / `ruinedCitadelCandidateValid(...)` 仍为 true；并断言「移位个数 ≤ 8」（实测 5，留余量；**失败个数必须为 0**，与上一条分开）。
4. **biome 压平仍生效**：块内 DESERT 格的高度 `=== floor(rawH * DESERT_FACTOR + DESERT_OFFSET)`（rawH 由 `mesaRawHeight` 取），SWAMP / CITY 同理；各类累计 checked > 0。

- [ ] **Step 2: 跑测试确认失败**

Expected: FAIL —— 块内高度仍等于原公式（未接入）。

- [ ] **Step 3: 改 `generateHeightForBiome`**

顺序（载荷性）：① 算现状 `h`（原两行噪声公式，不动）→ ② `const block = computeMesaBlock(seed)`，`inMesaBlock(x,z,block)` 为假则**直接返回原 biome 调整后的 h**（零 Perlin）→ ③ 块内：`raw = mesaRawHeight(x,z,block,getMesaNoise(seed))`，再套**同一套** biome 调整（DESERT/SWAMP/CITY 三条，读 `TERRAIN_HEIGHT_PARAMS`）。

⚠️ 把 biome 调整抽成文件内局部函数 `applyBiomeAdjust(h, biome)` 供两条路径共用，**不写两份**（红线 1）。
⚠️ `TERRAIN_HEIGHT_PARAMS` 的注释要补一句「第三个消费方：`gen/mesa-block.js` 的块高度也套同一套 biome 调整」。

- [ ] **Step 4: 跑测试确认通过 + 既有回归**

浏览器：`test-mesa-block.js` 全 passed，且 **`test-terrain.js` / `test-ocean-mask.js` / `test-arena-gen.js` / `test-burning-arena-gen.js` 全 passed**（这几条是冻结数字的守门人）。
Run: `npm run check`
Expected: arch + data + lint 全过，**lint warning 数不得比改动前增加**（改动前先跑一次记下基线）。

- [ ] **Step 5: 提交**

```bash
git add src/gen/terrain.js src/tests/test-mesa-block.js
git commit -m "feat(gen): generateHeight 接入台地块（块外逐位不变，biome 压平共用）"
```

---

### Task 6: TSL 高度输入同步（水面判据一字不动）

**Files:**
- Modify: `src/render/ocean.js:152-186`（`getTerrainHeight`）+ 新增 uniform 与 setter
- Modify: `src/core/game.js:935`（装配，紧随 `setCityBounds` 之后）
- Create: `src/tests/test-mesa-tsl.js`
- Modify: `src/tests/index.html`

**Interfaces:**
- Consumes: Task 3 的 `computeMesaBlock` / 常量、Task 1 的 `MESA_NOISE_SPECS` / `createPermutation`、**Task 4 的 `MESA_SPLINE_TABLES`**（控制点单一权威）
- Produces: `ocean.setMesaBlock(block | null) -> void`（哨兵 = 空矩形 `minX > maxX` ⇒ 门控关闭，手法同 `setCityBounds`）

- [ ] **Step 1: 写失败测试**

`src/tests/test-mesa-tsl.js`（浏览器内，可 import three —— 先例 `test-zombies.js`）：
1. **TSL Perlin 与 CPU 逐点一致**：用 `DataTexture`(512×1, RGBAFormat, NearestFilter) 存 perm，`textureLoad(tex, ivec2(bitAnd(int(i), int(511)), 0)).r.mul(255)` 取值；对 16 个非整数采样点（含负坐标）与 `perlin3` 比对。读回用 8bit RenderTarget ⇒ 容差取 **1 个量化步长 1/64**（2026-11-16 实测最大误差 0.0069）。
2. **负向对照：`uniformArray` 动态索引不可用**：断言 `uniformArray(...).element(动态k)` 的读回**与 CPU 不一致**（实测 11 个下标只有前 2 个对）。⚠️ 这条钉住「为什么必须用 textureLoad」，防后人「顺手简化」成 uniformArray。若某天 three 修好了，这条会红 —— 那时按实测改判据并在注释记明版本。
3. **块矩形哨兵**：未接线（null）时 `setMesaBlock` 后 uniform 为 `minX > maxX`；接真实 block 后逐字段相等。

- [ ] **Step 2: 跑测试确认失败**

Expected: FAIL —— `ocean.setMesaBlock` 不存在 / TSL 侧未实现。

- [ ] **Step 3: 实现 TSL 同步**

在 `ocean.js` 内新增 `uMesaBlock = uniform(new THREE.Vector4(1, 0, 1, 0))`（空矩形哨兵）与 perm 纹理（模块级懒建，`DataTexture` 512×1 RGBA Nearest，值来自 `createPermutation(seed)`；seed 变化时重建）。
`getTerrainHeight(x, z)` 改为：先算现状 `base`（原 sin/cos 逻辑**保留不动**，块外要用）→ 若 `(x,z)` 在 `uMesaBlock` 矩形内，走 TSL 版三条带高度（`perlinN` + `evalSplineN` + coord 重映射 + inward-only 混合），再套同一套 biome 调整 → 否则返回现状值。
**五点取样 `h0..h4`、阈值 `OCEAN_MASK_THRESHOLD`、`OCEAN_MASK_OFFSET`、城市/湖区门控、`Discard` 顺序全部不动。**
`setMesaBlock(block)` 写 uniform，null/缺字段 → 哨兵。
`game.js` 在 `this.ocean.setCityBounds(regionLayout.city);` 之后加 `this.ocean.setMesaBlock(computeMesaBlock(this.seed));`（import 走相对路径）。

⚠️ TSL 侧 spline 的控制点表与 CPU 侧**必须同源**：把三条带的控制点数组导出为 `mesa-block.js` 的 `MESA_SPLINE_TABLES`（纯数据，无函数），CPU 与 TSL 都读它。`tier`/`bad` 子样条同样导出。

- [ ] **Step 4: 跑测试确认通过**

浏览器：`test-mesa-tsl.js` 3 条 passed；`test-ocean-mask.js` 仍全 passed。
Run: `npm run check`
Expected: 全过（`ocean.js` 属 render 层，可 import three；`mesa-block.js` 仍不得 import three）。

- [ ] **Step 5: 提交**

```bash
git add src/render/ocean.js src/core/game.js src/gen/mesa-block.js src/tests/test-mesa-tsl.js src/tests/index.html
git commit -m "feat(render): 水面遮罩 TSL 同步台地块高度（判据与门控不动）"
```

---

### Task 7: Tier 4 像素实测 + 全量门禁

**Files:**
- Create: `tests/mesa-block.spec.mjs`
- Modify: `docs/roadmap.md`（新版本行 + 实测数据）

**Interfaces:**
- Consumes: 全部前序任务的产物；`window.__MC_GAME__`
- Produces: 无（验证与文档）

- [ ] **Step 1: 写 spec（先确认它在「注入退化」下会红）**

`tests/mesa-block.spec.mjs`，三条用例：
1. **块内三地貌真的上屏**：传送到块内台地带中心。⚠️ **`g._teleportTo(x,y,z)` 内部就是 `player.spawn`，它不等目标 column 加载**（`game.js:1777` 实测）⇒ 传送后必须等队列收敛（`sections` 停止增长，不是只看队列瞬时归零）再量，否则玩家悬在未加载空列里。判据落在**真实几何**上：读 `renderWorld.slotMap` 的 section 数与 `world.getColumn` 的高度直方图，断言最高频高度占比 ≥ 0.10。
2. **块内水面有波纹**（Review Focus 2）：块内河谷水域固定机位连续两帧截图，水区像素变化比例 **> 0.05**（与 `lake-ripple.spec.mjs` 同口径）；**同时钉上界**（< 0.9，防「整屏都在变」= 相机没钉住）。先测同状态重复截图的噪声底。
3. **块外水面零回归**：块外海岸机位同法测波纹，与 HEAD 同口径；断言落在噪声底之上。

⚠️ 每条都要有**负向验证**：临时把 `setMesaBlock` 改成传 null（用 `page.evaluate` 覆盖，**不改源文件**），确认用例 1、2 变红。验完恢复。

- [ ] **Step 2: 跑 spec 确认能抓到退化**

Run: `npx playwright test tests/mesa-block.spec.mjs --reporter=line`
Expected: 三条 passed；注入 null 后用例 1、2 FAIL（**这一步的 FAIL 是预期证据，不是缺陷**）。

- [ ] **Step 3: 跑全量门禁**

```bash
npm run check
npm test
npm run bench -- --check
```
Expected: 全过。
⚠️ `bench --check` 不带 `--check` 会重写冻结基线 —— 若诊断时跑过不带 `--check` 的版本，必须 `git checkout docs/m3-baseline.md docs/m3-baseline.json` 恢复。
⚠️ 计时型 spec 贴线 flaky ⇒ **看交替对照的分布，不看单次红绿**，不改阈值。冻结数字不符**停下来报告**。

- [ ] **Step 4: 更新 roadmap**

在 `docs/roadmap.md` 版本表追加一行：改动摘要 + 本 Epic 的实测数据（界外 0 差异 / 宿主 0 改动 / 锚点 43 不变 5 移位 0 失败 / 块外顶点 0.0% / 最忙视域 opaque 35.7% / GEN 0.503ms / 迷你地图块内 0.695ms）+ 「块内地表材质与植被避让留下一轮」。

- [ ] **Step 5: 提交**

```bash
git add tests/mesa-block.spec.mjs docs/roadmap.md
git commit -m "test(gen): 台地块 Tier 4 像素实测 + roadmap 实测数据"
```

---

## 落地后必须重测的数字（spec §7.5 的未核边界）

spec 的实测值来自 LCG 自造 permutation 的**探针**，不是生产实现。Task 1~5 落地后，以下数字须用生产代码重测并把实测值写进 roadmap（**不是照抄 spec**）：

- 三条带的平顶占比、块内最高高度、邻格最大高差
- 12 seed 的锚点不变/移位/失败计数
- 块外顶点与 section 增量（应恒 0）、最忙视域 opaque 占用、GEN ms/列、迷你地图 ms

若重测值与 spec 的冻结下界冲突（例如平顶占比低于 Task 4 的断言下界），**停下来报告**，不擅自放宽断言。