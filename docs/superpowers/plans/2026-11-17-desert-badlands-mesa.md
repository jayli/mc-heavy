# 沙漠恶地高山（Badlands Mesas）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans（本计划的任务**不独立**：Task 2~5 共享同一份几何权威与同一批 seed 夹具，串行内联执行成本更低）或 superpowers:subagent-driven-development。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 沙漠里出现稀有的平顶陡崖台地（平均三个沙漠 region 一座），`riser=3` 的真陡崖，配色只用现有 `sand` + 岩石三色，不与既有建筑重叠、不与空岛碰撞，**世界其余部分逐位不变**。

**Architecture:** 新增**一个** Worker 同构纯函数模块 `src/gen/structures/desert-mesa.js`（几何常量 + 落点搜索 + 体素填充 + 占地判据，四件事同一权威）。接入 `apply.js` 阶段 1 之后、2.45 之前的新阶段 **2.3**；`pointContext` 加一个 `kind:'none'` 分支实现撒布/植被压制；`applySkyStructures` 调用侧加云让路门控。**不改 `generateHeight`、不改 TSL 水面遮罩、不改任何既有 biome/地形常量** —— 与既有冰封山峰/金字塔同手法（体素覆写）。

**Tech Stack:** 原生 ESM（无构建）、Node v26、three r185.1 本地 `vendor/three/`（import map）、Playwright（`channel: 'chromium'`）。

**Spec:** `docs/superpowers/specs/2026-11-17-desert-badlands-mesa-design.md`

## Global Constraints

- **`generateHeight` / `TERRAIN_HEIGHT_PARAMS` / `BIOME_PARAMS` / `render/ocean*.js` / `fillColumn` 水体分支一行不改**。这是本 Epic 的核心不变式（spec §1 的关键发现：既有山从来不改高度场）。
- **水面逻辑一律沿用现状**（用户 2026-11-16 裁定）。落点门控要求占地全干燥 ⇒ 山里不会有水。
- **`riser = 3` ⇒ 山顶爬不上去是预期行为**（用户 2026-11-17 裁定）。`MAX_STEP` 不改，`physics.js` 不碰。测试要把它写成**正向断言**，不是当缺陷修。
- **零新增方块、零烘焙**：只用 `sand` / `stone` / `cobblestone` / `stone_diorite`（全部已在 `blocks-data.js`，全部 `opaque` 通道）。不跑任何 `npm run <bake>`。
- **撒布用「压制」不用「避让」**（spec §5.2 决定性对照：避让 0/1/3 座、3 个 seed 零座；压制 16/27/39 座、零座 0）。与 `burning-arena.js` / `ruined-citadel.js` 同一裁定。
- **地标 / 城市 / 空岛用「避让」**（不削既有内容）。
- **不叠概率抽签**：产率由门控自然稀疏度达成（实测通过率 0.225~0.527）。⚠️ 常量注释必须写清，否则将来有人「补上抽签」会让山几乎消失（实测乘 1/3 → 沙漠/座 8.4）。
- **Worker 同构**（红线 8/10）：新文件不得 import three、不得自建 Worker、不得 fetch、无 DOM。
- **不得 import `tarn-zone.js` / `shallow-water-tarns.js`**：它们反过来依赖地形链路，会成环（上次台地迁移的真实栈溢出）。高台/浅水高台的排除靠 purity + 干燥门自然达成，apply 层让路兜底。
- **确定性**（红线 2）：落点与形状只由 `(seed, rx, rz)` 推导，无 `Math.random`、无运行期可变状态（缓存除外，缓存键必须带 seed）。
- **时间基准 `performance.now()`**，禁止 `Date.now()`。坐标取模一律非负。
- **`assertEqual` 是 `===`**：数组用 `assertDeepEqual`；`assertClose` **不存在**于 `assert.js`，需要容差比较时在测试文件内自定义局部函数。
- **新测试文件必须同时注册进 `src/tests/index.html`**（漏注册 = 静默不跑，`check:data` 的 `[测试注册]` 双向钉）。
- **salt 取 1050~1053**（程序化扫描确认空闲：已占用到 1042，1043+ 空闲；spec §5 用 1050 基址）。⚠️ 落地前**重跑一次程序化扫描**（另一会话可能已占用）。
- **冻结数字不符时停下来报告**，不擅自改断言或放宽阈值。
- **验收锚是已交付的冰封山峰**（Δ>1格 +1.712% / Δ≥5格 +0），**不是自然沙漠**（那是平地的锚，拿它判山会把任何山判死）。
- **逐格采样，步长 1**（上次教训：步长 3 把最大跳 30 读成 7）。
- 上游 Tectonic 是 **MIT** @ `34241bd`。本 Epic **只取语义、不复制代码或数据**，仍须在模块头注明来源与 spec 路径。

## 定稿常量（全部来自实测，spec §5.1/§5.7/§5.8）

```
MESA_RTOP        = 26      顶面基准半径
MESA_LEVELS      = 12      阶梯级数
MESA_RISER       = 3       每级高（用户裁定）
MESA_TREAD       = 2       每级踏面宽
MESA_SLOPE       = 16      外围缓坡宽
MESA_WOBBLE      = 6       轮廓抖动幅度
MESA_HEIGHT      = 36      = LEVELS × RISER（派生，不写字面量）
MESA_RIM         = 68      = RTOP + WOBBLE×3 + LEVELS×TREAD（派生）
MESA_REACH       = 84      = RIM + SLOPE（派生）
MESA_RTOP_MAX    = 44      = RTOP + WOBBLE×3（派生，topY 上界用）
MESA_BLOB_SCALE  = 0.09    blobNoise 尺度（直段最短档且极差 12.8 < 18）
MESA_SCAN_STEP   = 12      候选扫描步长
MESA_MAX_TRY     = 30      候选尝试上限
MESA_PURITY      = 0.85    RIM 圆盘 DESERT 占比下限
MESA_PURITY_DIRS = 12      纯度采样方位数
MESA_PURITY_RINGS= 5       纯度采样环数
MESA_DRY_STEP    = 8       干燥采样步长
MESA_SALT        = 1050    抽签/乱序基址（+1 乱序、+3 轮廓噪声）
```

**实测冻结值（11 seed：12345 / 4242 / 99999 / 987654 / 424242 / 2096 / 2644 / 3740 / 4151 / 4973 / 13344380）**

| 量 | 实测 | 断言口径 |
|---|---|---|
| 沙漠/座 | min 1.48 / 中位 2.06 / max 3.09 | `>= 1.4 && <= 3.2` |
| 山总数（289 region） | 23~50 | `>= 20`，零座 seed = 0 |
| 顶面绝对 y | 39~45 | `>= 36 && <= 50`（`WORLD_MAX_Y=96` 余量 ≥ 46） |
| Δ≥5格断崖 | **全部 11 seed = 0** | `=== 0` |
| Δ>1格 | +1.843~2.043% | `<= 2.2`（锚 +1.712，同量级） |
| 最大邻格跳 | 6~11，**与同窗口天然沙漠逐位相同** | `mesaMax === natMax` |
| MAX_STEP=1 可达顶面 | **0%（11/11）** | `=== 0`（正向断言：riser=3 爬不上） |
| MAX_STEP=3 可达顶面 | **100%（11/11）** | `=== 100`（阶梯连续，无断路） |
| 撞空岛 | **0/365 座** | `=== 0` |
| 顶 y ≥ 云簇层 35 | 365/365 | 云让路必须生效 |
| 顶 y ≥ 单云层 55 | 0/365 | `=== 0` |
| 实测最大外缘半径 | 78.7 | `< MESA_REACH(84) && < 200` |
| 单座竖直填充 | 136983 格 ≈ 0.137M | 数量级参考，非冻结 |
| `liftAt` | 0.0742 µs/次 | 数量级参考 |
| 整列 `surfaceY` | 0.0299 ms/列 | 8 ms 门的 0.37% |
| 单 region 冷/热搜索 | 9.86 / 0.10 ms | 热 `<= 1 ms` |
| 非沙漠 region 早退 | 0.218 ms | `<= 1 ms` |
| 一个 seed ±8 全扫 | 59 ms | `<= 150 ms`（对照堡垒 63~141） |

## Review Focus

以下六类是 spec 隐含、但单任务测试不直接覆盖的失效形态，按咬人概率排序。每条已在其归属任务里追加了对应测试步骤。

1. **既有结构从「移位」恶化成「召不出」**（返回 null）—— Boss 结构静默消失。上次台地迁移接入后立刻 3 条冻结断言 FAIL。→ Task 6 Step 1 的「非 null」与「锚点仍合法」两条**分开**断言 + Task 7 全量回归。
2. **撒布/植被压制漏了一处** —— 树或房长进崖壁，方块层面看不出是漏了判据。→ Task 4 Step 1 的「占地内撒布/植被方块数 = 0」逐格用例（五个下游消费者都要覆盖）。
3. **云穿崖壁** —— 山顶 y 39~45 与云簇层 35 共处，云是 `solid:true` 会埋掉山顶一截。→ Task 5 Step 1 的「占地内 y=35/55 的 cloud 方块数 = 0」。
4. **`topY` 上界取错** —— 用「圆心自然高 + H + 8」这种拍出来的值 ⇒ 过保守，产率崩到 2/4/8（实测）；用圆心单点 ⇒ 漏判空岛碰撞。→ Task 2 Step 1 用例 2 的「上界 = 顶半径圆盘内 maxNat + H」+ 与逐格真实最高的两侧夹逼。
5. **`REACH` 小于真实占地** —— 圆越界 ⇒ 半边永久消失（`TARN_ZONE_RADIUS` 的实测教训）；或占地伸出 region 而邻居不为它算 ⇒ 同样的半边消失。→ Task 1 Step 1 用例 4 的「实测最大外缘 < REACH < 200」+ Task 2 Step 1 用例 7 的不越 region。
6. **浏览器/Node 落点不一致** —— 上次放弃时有一条「seed 987654 浏览器 null、Node OK」未查明。→ Task 6 Step 3 必须在**浏览器内**复核同一批 seed 的落点，不能只跑 Node。

---

### Task 1: 几何权威与形状纯函数（Tier 1 TDD）

**Files:**
- Create: `src/gen/structures/desert-mesa.js`
- Test: `src/tests/test-desert-mesa.js`
- Modify: `src/tests/index.html`（追加 import）

**Interfaces:**
- Consumes: `blobNoise`（`tarn-terrain.js:203`）、`generateHeight`（`terrain.js`）、`getBiome` / `seededRandom`（`noise.js`）、`SEA_Y` / `WORLD_MIN_Y` / `WORLD_MAX_Y`（`voxel/constants.js`）
- Produces:
  - 常量：上表全部 `MESA_*`（`MESA_HEIGHT` / `MESA_RIM` / `MESA_REACH` / `MESA_RTOP_MAX` 必须**派生计算**，不写字面量）
  - `mesaTopRadiusAt(cx, cz, seed, lx, lz) -> number`（顶面半径，含 blobNoise + 方位起伏）
  - `mesaLiftAt(cx, cz, seed, lx, lz) -> number`（相对自然地表的抬升，0..H）
  - `mesaSurfaceY(cx, cz, seed, wx, wz) -> number`（最终地表 y）
  - `inMesaFootprint(wx, wz, mesas) -> boolean`（**唯一占地判据**，含缓坡；`mesas` 是 layout 里的数组，null/空数组安全）
  - `MESA_ROCK_BANDS: readonly ['stone','cobblestone','stone_diorite']`
  - `mesaSurfaceBlock(cx, cz, seed, lx, lz) -> 'sand'|'stone'|'cobblestone'|'stone_diorite'`

- [ ] **Step 1: 写失败测试**

`src/tests/test-desert-mesa.js`，用 `import { test } from './runner.js'` 与 `assertEqual / assertTrue / assertDeepEqual`。文件内自定义 `const assertClose = (a,b,eps,msg) => assertTrue(Math.abs(a-b) <= eps, msg)`。

七条用例：
1. **常量派生关系**：`MESA_HEIGHT === MESA_LEVELS * MESA_RISER`、`MESA_RIM === MESA_RTOP + MESA_WOBBLE*3 + MESA_LEVELS*MESA_TREAD`、`MESA_REACH === MESA_RIM + MESA_SLOPE`、`MESA_RTOP_MAX === MESA_RTOP + MESA_WOBBLE*3`。并钉 `MESA_RISER === 3`（用户裁定，改动需重新裁定）。
2. **三段语义**：取一个固定 `(cx,cz,seed)`，沿 +x 射线逐格取 `mesaLiftAt`：
   - `d ≤ rt` 段恒 `MESA_HEIGHT`；`d ≥ rt + levels*tread` 恒 0；中间段 `0 < lift < H` 且**单调不增**。
   - **阶梯层序**：对同一格的 `lvl = ⌊(d−rt)/tread⌋`，断言 `lift === H − (lvl+1)*riser`（**按公式逐格验**）。
   ⚠️ **不得写成「沿射线每 `tread` 格降 `riser`」**（实测推翻）：`rt` 本身是 `(lx,lz)` 的函数，
   沿射线也在变 ⇒ 实测 seed 12345 / (200,600) 的 +x 射线上 `lx 40→42` lift 从 24 降到 **18**（跳 6 = 2×riser），
   因为 `rt` 同时从 32.15 缩到 31.90。写成固定步长递减会在正确实现下 FAIL。
3. **陡度上界可证明**：占地内**逐格**（步长 1）扫 200×200，**轴向**相邻 `|lift(lx+1,lz) − lift(lx,lz)| <= MESA_RISER` 与 `|lift(lx,lz+1) − lift(lx,lz)| <= MESA_RISER` 恒成立（实测 3 座 × 97200 样本，最大 3、违例 0）。
   ⚠️ **只能钉 4 邻域轴向，不得钉对角**：实测对角相邻 `|Δlift|` 最大 **6**（= 2×riser，两个轴各跳一级）⇒ 写成 8 邻域会在正确实现下 FAIL。
   本条钉的是「阶梯由整数常量定义」这个设计核心 —— 若有人把 lift 改成连续噪声，本条立刻红。
4. **`REACH` 覆盖真实占地**：11 seed × 每个前 6 个沙漠 region，128 方位取 `mesaTopRadiusAt + levels*tread + SLOPE` 的最大值，断言 `< MESA_REACH` 且 `< 200`。**实测参考 78.7**。
5. **轮廓非圆**：同一座山 256 方位的顶半径极差 `> 5`（实测 12.8）；且沿 x/z 轴的最长等半径直段 `<= 35`（实测中位 16 / max 31）。⚠️ **两侧都要钉**：只钉「极差 > 5」抓不到「退化成理想圆」之外的「直边」缺陷。
6. **配色分层**：`mesaSurfaceBlock` 在顶面返回 `'sand'`；缓坡带返回 `'sand'`；阶梯带第 `lvl` 级返回 `MESA_ROCK_BANDS[lvl % 3]`（逐级断言 12 级）。`MESA_ROCK_BANDS` 深等于 `['stone','cobblestone','stone_diorite']`。
7. **`inMesaFootprint` 边界与空安全**：`null` / `[]` 返回 false；圆心 true；`d = REACH + 5` false。
   **与 `mesaSurfaceY` 的一致性只能单向断言**：`mesaSurfaceY(x,z) !== generateHeight(x,z)` ⇒ `inMesaFootprint(x,z) === true`（改了高度的格必在占地内）。
   ⚠️ **反向不成立，不得写成双向相等**（实测推翻了直觉）：占地含**外围缓坡**，那里 `lift = 0` ⇒ `surfaceY === 自然高`。
   实测（cx 200 / cz 600 / seed 12345，177×177 窗）：`inFootprint` 为真 **14035** 格、高度被改 **6725** 格，
   写成双向相等会有 **7310** 格假失配 ⇒ **正确实现下也 FAIL**。这条负向锚点自己先验过判别力。

- [ ] **Step 2: 跑测试确认 RED**

`npm start` 后浏览器开 `/src/tests/index.html`，读 `window.__MC_TEST_RESULTS__.suites.flatMap(s => s.tests)`，确认新用例全 FAIL（模块还不存在 ⇒ import 失败也要算 RED，但要先确认**是因为模块缺失**而不是注册漏了）。

- [ ] **Step 3: 实现模块**

按 spec §5.1 的公式实现。要点：
- `blobNoise` **必须 import**，不在本文件重写（红线 1；它的存在理由就是「`noise()` 可分离 ⇒ 边界横平竖直」）。
- `mesaSurfaceY` 的缓坡权重 `w`：`d ≤ outer` 时 1，`outer..outer+SLOPE` 线性降 0，`≥ outer+SLOPE` 直接返回 `generateHeight`（早退，省 blobNoise）。
- `inMesaFootprint` 用**真实 `rt`**（不是 `REACH` 常量圆）—— 与 `mesaSurfaceY` 同源。
- 文件头注明：上游 Tectonic MIT @ `34241bd`、spec 路径、「只取语义不复制代码」。
- **不 import** `tarn-zone.js` / `shallow-water-tarns.js`（会成环）。

- [ ] **Step 4: 跑测试确认 GREEN + 负向验证**

三条负向验证（用 `cp` 副本还原，**禁止 `git checkout`**）：
- 把 `MESA_TREAD` 改成 1 ⇒ 用例 3（陡度上界）应仍绿（riser 不变），但用例 2 的逐级断言应红 ⇒ 证明逐级断言有判别力。
- 把 `mesaTopRadiusAt` 的 blobNoise 项去掉（退化成理想圆）⇒ 用例 5 的极差断言应红。
- 把 `inMesaFootprint` 改成用 `REACH` 常量圆 ⇒ 用例 7 的一致性断言应红。

- [ ] **Step 5: `npm run check`**

`check:arch` 会验新文件的依赖方向与 three 隔离；`check:data` 会验测试注册双向。

---

### Task 2: 落点搜索（Tier 1 TDD）

**Files:**
- Modify: `src/gen/structures/desert-mesa.js`
- Modify: `src/tests/test-desert-mesa.js`

**Interfaces:**
- Consumes: `regionLandmarkCenters`（`landmark-circles.js`）、`getCityBoundsForSeed`（`city-layout.js`）、`computeSkyCandidates`（`sky-structures.js`）、`REGION_SIZE`（`region-config.js`）
- Produces:
  - `computeDesertMesas(regionX, regionZ, seed) -> Array<{cx, cz, topY}>`（本 region 至多 1 座；带 `(seed,rx,rz)` 缓存）
  - `clearDesertMesaCache()`（单测隔离用）
  - `mesaTopYBound(cx, cz, seed) -> number`（= 顶半径上界圆盘内 `max(generateHeight) + MESA_HEIGHT`）

- [ ] **Step 1: 写失败测试**

八条用例：
1. **确定性**：同 `(rx,rz,seed)` 两次调用逐字段相同（`assertEqual` 逐字段，不用 `assertDeepEqual` 比对象数组）。
2. **`topY` 上界正确**：对 11 seed 各取前 3 座，`mesaTopYBound >= 逐格真实最高 surfaceY`（**上界性质**）；且 `mesaTopYBound - 真实最高 <= 8`（**不过度保守**）。实测参考：16 个样本上界失效 **0** 次、最大 gap **5**。⚠️ 两侧都钉：只钉上界抓不到「拍 +8 导致产率崩」。
3. **全 DESERT + 全干燥**：每座山的 `RIM` 圆盘逐格（步长 2）`getBiome === 'DESERT'` 占比 `>= 0.85`，且每格 `generateHeight > SEA_Y`。
4. **不撞地标 / 城市**：每座山与 3×3 邻域的 `regionLandmarkCenters` 任一圆（半径 + REACH）**不相交**；与 `getCityBoundsForSeed` AABB 不相交。
5. **不撞空岛**：每座山与 3×3 邻域的 `computeSkyCandidates().skyIslands` 逐个判 `bottomY > topY` 或水平不相交。**实测 365 座撞 0**。
6. **产率**：11 seed 各扫 ±8 region（289 个），断言每 seed `mesas >= 20`、`沙漠region数 / mesas` ∈ `[1.4, 3.2]`、**零座 seed 数 === 0**。⚠️ 必须同时断言 `desertRegionCount > 0`（防恒真）。
7. **不越 region**：每座山的 `cx ± REACH` / `cz ± REACH` 落在本 region 内。**构造性成立**：`inset = min(REACH, 200−16) = 84` ⇒ 候选窗 `[base+84, base+316)` ⇒ `cx±84 ⊂ [base, base+400)`。实测 region(0,1) seed 12345：215 个候选，cx 84..240 / cz 484..712 ⇒ `cx−84 >= 0`、`cx+84 <= 324 < 400`；`cz−84 >= 400`、`cz+84 <= 796 < 800`。
8. **缓存与早退成本**：热搜索 `<= 1 ms`；非沙漠 region 早退 `<= 1 ms`；`clearDesertMesaCache()` 后冷搜索 `<= 30 ms`。用 `performance.now()`。

- [ ] **Step 2: 跑测试确认 RED**

- [ ] **Step 3: 实现搜索**

照 `giant-pyramid.js:222` 的手法（spec §5.2 的七步）。要点：
- **便宜判据先**：城市/地标（纯算术）→ topY 上界 → 空岛 → purity → 干燥。
- **`topY` 用 `mesaTopYBound`**（只扫 `generateHeight`，步长 3），**不逐格算 `surfaceY`**（实测 3.2× 降本：191→59 ms/seed，且产率更好）。
- **不查撒布**（压制在 Task 4）。
- 邻域 **3×3**（占地 84 会伸进邻居）。
- 乱序 tie-break 用坐标字典序（跨 Worker 一致）。
- 缓存键带 seed（同进程切世界不串味），照 `passesTarnGates` 的粗 LRU。
- **无概率抽签**，注释写清理由与实测数字。

- [ ] **Step 4: 跑测试确认 GREEN + 负向验证**

- 把 `mesaTopYBound` 改成 `generateHeight(cx,cz,seed) + H + 8` ⇒ 用例 2 的「不过度保守」应红，用例 6 的产率应红（实测崩到 2/4/8）。
- 把邻域改成只查本 region ⇒ 用例 4/5 应红（邻居地标/空岛漏判）。
- 把 `MESA_PURITY` 降到 0.3 ⇒ 用例 3 应红。

- [ ] **Step 5: Node 侧对照探针复核**

用 `/tmp/badlands-tune2.mjs` 的定稿口径（`top=natmax try30 dry8 p12x5`）跑同一批 seed，**逐座标比对**生产实现与探针的落点。不一致要查清（上次有一条浏览器/Node 不一致未查明）。

---

### Task 3: 体素填充与层序接入（Tier 1 + Tier 2）

**Files:**
- Modify: `src/gen/structures/desert-mesa.js`（加 `fillDesertMesa`）
- Modify: `src/gen/structures/structure-layout.js`（layout 加 `desertMesas` 字段）
- Modify: `src/gen/structures/apply.js`（新阶段 2.3）
- Modify: `src/tests/test-desert-mesa.js`

**Interfaces:**
- Produces: `fillDesertMesa(column, mesa, seed, registry) -> void`（生成路径：不记 edits、不 bump version，与 `fillTarnPlateau` 同口径）

- [ ] **Step 1: 写失败测试**

六条用例：
1. **顶面高度**：填充后占地内每格从顶向下首个非 air 方块的 y `=== mesaSurfaceY(...)`（逐格，步长 1，取 3 座）。
2. **配色落地**：地表那一格的方块名 `=== mesaSurfaceBlock(...)`；崖壁竖直段按级序取三色（抽查每级各 3 格）。
3. **填充下方补实**：地表下方到 `WORLD_MIN_Y+1` 全非 air（防悬空），`WORLD_MIN_Y` 是 bedrock。
4. **不越世界顶**：占地内最高 y `<= 50`（实测 39~45，`WORLD_MAX_Y=96` 余量 ≥ 46）。⚠️ **同时钉下界 `>= 36`** —— 只钉上界抓不到「山没生成」。
5. **占地外逐位不变**：`REACH + 8` 之外的格，填充前后 `column.blocks` 逐字节相同（核心不变式）。
6. **层序**：在 `fillColumn` + `carveCaves` 之后调用 ⇒ 山顶不被原始地层盖回；在阶段 2.45/2.4 之前 ⇒ 浅水高台/高台地带不削山（构造性验证：造一个假山与真高台圆相邻的夹具，确认两者互不覆盖）。

- [ ] **Step 2: 跑测试确认 RED**

- [ ] **Step 3: 实现填充 + 接线**

- `fillDesertMesa` 照 `generateFrozenMountain`（`landmarks.js:526`）的写法：`fillStartY = min(自然高, 目标y)`、`fillEndY = max(...)`，逐层 `setBlock`；下方补实到基岩。
- `structure-layout.js`：加 `desertMesas: computeDesertMesas(regionX, regionZ, seed)`。⚠️ **无条件调用**（照 `skyFull` 的理由），不要写成 `tarn ? [] : ...` —— 那会让缓存与压制判据漂移。
- `apply.js`：新阶段 **2.3**，位置在阶段 1 循环之后、阶段 2.45 之前。遍历 `layouts.flatMap(l => l.desertMesas)`（**不能只取第一个** —— 3×3 邻域可能有多座，同 `tarnLayouts` 的实测教训）。
- 层序注释写清三条理由（spec §4.1）。

- [ ] **Step 4: 跑测试确认 GREEN + 负向验证**

- 把阶段 2.3 挪到阶段 1 **之前** ⇒ 用例 1 应红（被 `fillColumn` 盖回）。
- 把 `layouts.flatMap(...)` 改成 `.find(Boolean)` ⇒ 用例 1 在「邻域有多座」的夹具上应红。

- [ ] **Step 5: `npm run check` + `structure-gen` genP95**

跑 `/src/tests/test-structure-gen.html`，确认含结构 GEN p95 仍 `< 10 ms`。**超了就停下来报告**，不放宽阈值。

---

### Task 4: 撒布与植被压制（Tier 1）

**Files:**
- Modify: `src/gen/structures/apply.js`（`pointContext` 加分支 + 阶段 2.7 撒布剔除）
- Modify: `src/tests/test-desert-mesa.js`

- [ ] **Step 1: 写失败测试**

四条用例（**五个下游消费者逐个覆盖**，不能只测一个）：
1. **撒布**：占地内 `computeScatterCandidates` 的候选经阶段 2.7 后**零方块**（逐格扫，按类型分别断言 `desertPyramid` / `desertVillage` / `house` / `ship` / `tank` / `uglyHouse`）。
2. **巨树 / 杜鹃**：占地内巨树与杜鹃方块数 = 0（`allowedAt` 只允许 `normal`/`water`）。
3. **普通树 / 单格植物**：占地内 `leaves` / `wood` / `short_grass` / `cactus` / `dead_bush` 方块数 = 0。
4. **判据单一权威**：`pointContext` 用的与本任务断言用的是**同一个** `inMesaFootprint`（构造一个「占地边缘一格」的夹具，两侧结论必须一致）。

- [ ] **Step 2: 跑测试确认 RED**

- [ ] **Step 3: 实现压制**

- `pointContext`（`apply.js:132`）加 `if (inMesaFootprint(wx, wz, layouts.flatMap(l => l.desertMesas))) return { kind: 'none' };`
- **位置**：放在 `city` 之后、`tarn` 之前或之后都可（两者互斥），但**必须在 `snowLand`/`fm` 判定之前**（照 tarn 的理由）。注释写清一个分支覆盖五个消费者。
- 阶段 2.7 撒布剔除转调同一函数。
- ⚠️ **不在 apply 里重写几何**（红线 1）。

- [ ] **Step 4: 跑测试确认 GREEN + 负向验证**

把 `pointContext` 的新分支删掉 ⇒ 用例 2/3 应红；把阶段 2.7 的剔除删掉 ⇒ 用例 1 应红。**两条分别验**（证明两处都真的接上了，不是靠一处兜住）。

---

### Task 5: 云让路（Tier 1）

**Files:**
- Modify: `src/gen/structures/apply.js`（阶段 2.5 的 `applySkyStructures` 调用侧）
- Modify: `src/tests/test-desert-mesa.js`

- [ ] **Step 1: 写失败测试**

三条用例：
1. **占地内无云**：占地内 `y === CLOUD_CLUSTER_Y(35)` 与 `y === SINGLE_CLOUD_Y(55)` 的 `cloud` 方块数 = 0（逐格）。
2. **占地外云不变**：`REACH + 8` 之外的云方块与改动前逐位相同（不能把全世界的云关掉）。
3. **空岛仍不碰撞**：填充后占地内 `sky_stone` / `sky_grass` 方块数 = 0（避让在候选层已保证，这里是纵深防御）。

- [ ] **Step 2: 跑测试确认 RED**

- [ ] **Step 3: 实现云让路**

⚠️ **不改云的生成规则本身**（`writeSingleCloudLayer` / `writeCloudClusters` 的噪声判据一字不动）。手法二选一，取** cheaper to reverse** 的那个：
- 优先：`applySkyStructures` 加一个可选的 `skipAt(wx,wz)` 回调参数，调用侧传 `inMesaFootprint`。云写入前判一次。
- 若改签名波及面大：在阶段 2.5 之后补一个「占地内清云」的 pass（后写胜）。⚠️ 这条会多扫一遍占地，成本要实测。

选型理由写进注释。默认取第一种（改一个可选参数，不动既有调用点的行为）。

- [ ] **Step 4: 跑测试确认 GREEN + 负向验证**

把 `skipAt` 传 `undefined` ⇒ 用例 1 应红（实测 365/365 座顶 y ≥ 35，云必然穿山）。

---

### Task 6: 既有内容零回归（Tier 1 + Tier 2）

**Files:**
- Modify: `src/tests/test-desert-mesa.js`
- 可能 Modify: 既有 spec/单测的冻结数字 —— ⚠️ **不符时停下来报告，不擅自改**

- [ ] **Step 1: 写失败测试**

三条用例（**「移位」与「召不出」分开断言** —— 上次复盘 §2 的核心教训）：
1. **既有结构非 null**：11 seed 下 `computeBurningArenaAnchor` / `computeRuinedCitadelAnchor` / `computeArenaAnchor` / `computeShallowTarnAnchor` / `computeGiantPyramidAnchor` **全部非 null**（与改动前基线比对）。
2. **锚点仍合法**：移位后的锚点仍通过各自的 `candidateValid` 类判据（全 DESERT / 全干燥 / span 达标）。
3. **地标位置不变**：`getPyramidCenterInRegion` / `getFrozenMountainCenterInRegion` / `getPlainLandCenterInRegion` / `getIslandCenterInRegion` 的返回值与改动前**逐位相同**（山避让地标，不该反过来动它们）。

- [ ] **Step 2: 跑测试确认 RED → 实现 → GREEN**

本任务**不新增生产代码**（若前面任务正确，这三条应直接绿）。若红：
- 先查是不是山**压制**了本该保留的内容（设计说山避让地标）。
- **冻结数字不符 ⇒ 停下来报告实测值与差异，等用户裁决**。

- [ ] **Step 3: 浏览器/Node 落点一致性（Review Focus 6）**

在浏览器内单测里对 11 seed 各取前 5 座，把 `(cx, cz, topY)` 与 Task 2 Step 5 的 Node 结果**逐座标比对**。⚠️ 上次放弃时有一条未查明的浏览器/Node 不一致，这条必须做。

- [ ] **Step 4: `npm run check`**

---

### Task 7: 全量回归与像素实测（Tier 1/2/4）

**Files:**
- 可能 Create: `tests/desert-mesa.spec.mjs`（Playwright，Tier 4 像素）

- [ ] **Step 1: 浏览器内全量单测**

`/src/tests/index.html`，读 `window.__MC_TEST_RESULTS__`（`suites.flatMap(s => s.tests)`），确认 `failed === 0`。**逐条看哪些既有冻结断言变了**。

- [ ] **Step 2: Playwright 全量**

`npm test`（workers:1 串行，自带 webServer）。⚠️ **命令不要接 `sed`/`grep` 管道**（退出码会被管道末端吃掉，仓库有实测假绿教训）。

- [ ] **Step 3: Tier 4 像素实测**

新建 `tests/desert-mesa.spec.mjs`（`channel: 'chromium'`）：
1. 传送到一座山的崖底（用 `g._teleportTo(x, y, z)`，它会加载目标 column；`player.spawn` 不加载 ⇒ 会悬空超时）。
2. 截图断言**同时钉上下界**：
   - 「崖壁岩石像素」占比 ∈ `[下界, 上界]`（只钉「有岩石」抓不到「满屏岩石」）。
   - 「顶面沙色像素」在仰视/俯视两个机位分别有合理占比。
   - 判据要带**对照组校准**：先在**无山的沙漠**同机位截一张，确认判据在对照图上不命中（否则「只是沙漠」也过）。
3. **穿模检查**：山顶机位截图里不得出现 `cloud` 的白像素（云让路生效）；崖壁里不得出现树叶/木头的色域。
4. 先测同状态重复截图的**噪声底**，再定阈值。

- [ ] **Step 4: 性能门禁**

- `npm run bench -- --check`（回退 >10% 退出码 1）。⚠️ `frameP95` 有 vsync 量子化噪声 ⇒ 若贴线，用**交替对照**判定，不看单次红绿。
- `npx playwright test tests/giant-tree-budget.spec.mjs`（通道容量；本 Epic 全 opaque 通道，但崖壁暴露面增多）。
- ⚠️ **`npm run bench` 不带 `--check` 会重写冻结基线** ⇒ 诊断后要 `git checkout docs/m3-baseline.*` 恢复。

- [ ] **Step 5: 汇总报告**

按 spec §8 的边界清单，明确写出「哪些数字是实测冻结、哪些是数量级参考、哪些没核」。

---

## 完成判据

- [ ] 11 seed 全部：沙漠/座 ∈ `[1.4, 3.2]`、零座 seed = 0、撞空岛 0、Δ≥5格 = 0、最大跳与天然沙漠相同。
- [ ] `MAX_STEP=1` 可达 0% / `=3` 可达 100%（**正向断言**，riser=3 的预期行为）。
- [ ] 既有结构全部非 null、地标位置逐位不变、既有冻结断言全绿（或差异已报告并获裁决）。
- [ ] 占地内撒布/植被/云/空岛方块数全 0；占地外逐字节不变。
- [ ] `npm run check` + `npm test` + `npm run bench -- --check` + `giant-tree-budget.spec.mjs` 全绿。
- [ ] Tier 4 像素实测带对照组校准，上下界都钉。
- [ ] `generateHeight` / `TERRAIN_HEIGHT_PARAMS` / `BIOME_PARAMS` / `ocean*.js` / `physics.js` **零改动**（`git diff` 核对）。