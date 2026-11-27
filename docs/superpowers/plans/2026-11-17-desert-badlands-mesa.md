# 沙漠恶地高山（Badlands Mesas）Implementation Plan

> **2026-11-27 修订**：本计划经影子执行审阅（`/tmp/mesa-review/`，43 个探针）后重写。
> 原判据中有 **8 条在正确实现下也会 FAIL 或恒绿**，已逐条修正；几何公式与落点门控两处**设计缺陷**
> 已在 spec §5.1 / §5.2 修好，本计划同步。**完整推翻清单见 spec §10。**
> ⚠️ 不要把任何判据改回 2026-11-17 的写法 —— 那几条已被实测推翻。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans（本计划的任务**不独立**：Task 2~5 共享同一份几何权威与同一批 seed 夹具，串行内联执行成本更低）或 superpowers:subagent-driven-development。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 沙漠里出现稀有的平顶陡崖台地（平均三个沙漠 region 一座），`riser=3` 的真陡崖，配色只用现有 `sand` + 岩石三色，不与既有建筑重叠、不与空岛碰撞，**世界其余部分逐位不变**。

**Architecture:** 新增**一个** Worker 同构纯函数模块 `src/gen/structures/desert-mesa.js`（几何常量 + 落点搜索 + 体素填充 + 占地判据，四件事同一权威）。接入 `apply.js` 阶段 1 之后、2.45 之前的新阶段 **2.3**；`pointContext` 加一个 `kind:'none'` 分支实现撒布/植被压制；`applySkyStructures` 加可选 `skipAt` 实现云让路。**不改 `generateHeight`、不改 TSL 水面遮罩、不改任何既有 biome/地形常量** —— 与既有冰封山峰/金字塔同手法（体素覆写）。

**Tech Stack:** 原生 ESM（无构建）、Node v26、three r185.1 本地 `vendor/three/`（import map）、Playwright（`channel: 'chromium'`）。

**Spec:** `docs/superpowers/specs/2026-11-17-desert-badlands-mesa-design.md`（**已修订，先读 §5.1 / §5.2 / §10**）

**参考实现:** `/tmp/mesa-review/geom8.mjs`（几何）+ `search5.mjs`（落点）—— 本计划全部冻结值由它们产出。
若 `/tmp` 已被清，按 spec §5.1 的公式与 §5.2 的七步重建即可（两者都是完整伪码）。

## Global Constraints

- **`generateHeight` / `TERRAIN_HEIGHT_PARAMS` / `BIOME_PARAMS` / `render/ocean*.js` / `fillColumn` 水体分支一行不改**。这是本 Epic 的核心不变式（spec §1 的关键发现：既有山从来不改高度场）。
- **水面逻辑一律沿用现状**（用户 2026-11-16 裁定）。落点门控要求占地全干燥 ⇒ 山里不会有水。
- **`riser = 3` ⇒ 山顶爬不上去是预期行为**（用户 2026-11-17 裁定）。`MAX_STEP` 不改，`physics.js` 不碰。测试要把它写成**正向断言**，不是当缺陷修。
- **零新增方块、零烘焙**：只用 `sand` / `stone` / `cobblestone` / `stone_diorite`（已核实四者均 `opaqueTable=1`、`cullTable=0`）。不跑任何 `npm run <bake>`。
- **撒布用「压制」不用「避让」**（spec §5.2）。与 `burning-arena.js` / `ruined-citadel.js` 同一裁定。
- **地标 / 城市 / 空岛 / 六类地基级结构用「避让」**（不削既有内容）。⚠️ **避让必须单向**：`desert-mesa` import 它们，**不得反向**（会成真环，已程序化验证 31 模块 DFS）。
- **不叠概率抽签**：产率由门控自然稀疏度达成（定稿 per 中位 1.91）。⚠️ 常量注释必须写清，否则将来有人「补上抽签」会让山几乎消失。
- **Worker 同构**（红线 8/10）：新文件不得 import three、不得自建 Worker、不得 fetch、无 DOM。文件头需含能被 `check:arch` 的 `ISOMORPHIC_DECLARED` 正则匹中的声明（例：「Worker 同构：本文件不得 import three」）。
- **可以 import `tarn-zone.js` / `shallow-water-tarns.js`**（原约束作废）：实测不成环，且避让它们必需 import。完整依赖白名单见 spec §5.2。
- **确定性**（红线 2）：落点与形状只由 `(seed, rx, rz)` 推导，无 `Math.random`、无运行期可变状态（缓存除外，缓存键必须带 seed）。
- **时间基准 `performance.now()`**，禁止 `Date.now()`。坐标取模一律非负。
- **`assertEqual` 是 `===`**：数组/对象用 `assertDeepEqual`（它内部是 `JSON.stringify` 比较，键序敏感）；`assertClose` **不存在**于 `assert.js`，需要容差比较时在测试文件内自定义局部函数。
- **新测试文件必须同时注册进 `src/tests/index.html`**（漏注册 = 静默不跑，`check:data` 的 `[测试注册]` 双向钉）。
- **新 spec 必须归档进 `tools/test-tiers.mjs` 的 `STRUCT`**（`check:data` 的 `[测试分档]` 对 spec 双向钉，漏归档必红）。新单测无 DOM 依赖 ⇒ 同时加进 `UNIT_NODE_SAFE`。
- **salt 取 1050~1053**（已重扫确认：现占用到 1047，1048+ 空闲）。⚠️ 落地前**重跑一次程序化扫描**（另一会话可能已占用）。
- **冻结数字不符时停下来报告**，不擅自改断言或放宽阈值。
- **验收锚是已交付的冰封山峰，且必须同口径重测**（spec §5.3 表）—— 不是自然沙漠，也不是原文那个无口径的 1.712%。
- **逐格采样，步长 1**（上次教训：步长 3 把最大跳 30 读成 7）。**窗口半径与邻域数必须写进断言**（±100 / ±200 双口径，4 邻域轴向）。
- 上游 Tectonic 是 **MIT** @ `34241bd`。本 Epic **只取语义、不复制代码或数据**，仍须在模块头注明来源与 spec 路径。

## 定稿常量（全部来自实测，spec §5.1）

```
MESA_RTOP        = 26      顶面基准半径
MESA_LEVELS      = 12      台阶级数（含末级台面）
MESA_RISER       = 3       每级高（用户裁定）
MESA_TREAD       = 2       每级踏面宽
MESA_SLOPE       = 16      外围缓坡宽
MESA_WOBBLE      = 6       轮廓抖动幅度
MESA_HEIGHT      = 36      = LEVELS × RISER（派生）
MESA_STAIR_STEPS = 11      = LEVELS − 1（派生，← 关键：降幅次数不是 12）
MESA_STAIR_DROP  = 33      = STAIR_STEPS × RISER（派生）
MESA_TAIL        = 3       = HEIGHT − STAIR_DROP（派生，末级台面 = 缓坡起点）
MESA_STAIR_W     = 22      = STAIR_STEPS × TREAD（派生）
MESA_RTOP_MAX    = 44      = RTOP + WOBBLE×3（派生）
MESA_RIM         = 66      = RTOP_MAX + STAIR_W（派生）
MESA_REACH       = 82      = RIM + SLOPE（派生）
MESA_BLOB_SCALE  = 0.09    blobNoise 尺度（采样点在单位方向×RTOP 上）
MESA_SCAN_STEP   = 12      候选扫描步长
MESA_MAX_TRY     = 60      候选尝试上限（原 30；补避让后必须括到 60）
MESA_PURITY      = 0.85    RIM 圆盘 DESERT 占比下限
MESA_PURITY_DIRS = 12      纯度采样方位数
MESA_PURITY_RINGS= 5       纯度采样环数
MESA_DRY_STEP    = 8       干燥采样步长
MESA_SALT        = 1050    基址（+1 乱序、+3 轮廓噪声）
```

## 实测冻结值（11 seed：12345 / 4242 / 99999 / 987654 / 424242 / 2096 / 2644 / 3740 / 4151 / 4973 / 13344380）

**产率与避让（±8 region = 289，396 座全扫）**

| 量 | 实测 | 断言口径 |
|---|---|---|
| 沙漠/座（分母 = **region 中心 biome === DESERT**） | min 1.36 / 中位 1.91 / max 3.18 | `>= 1.3 && <= 3.3` |
| 山总数 | 22 / 39 / 44 | `>= 20`，零座 seed = 0 |
| 与六类地基级结构相交（RIM 圆） | **全 0** | `=== 0`（逐类分开断言）|
| 撞空岛 | **0/396** | `=== 0` |
| 不越 region | 违例 **0** | 构造性，仍要断言 |

**几何（33 座 = 11 seed × 前 3 座，除注明外）**

| 量 | 实测 | 断言口径 |
|---|---|---|
| 轴向 `maxΔlift` | **3.000**，违例 **0**（396 座全扫） | `<= MESA_RISER`（**只钉 4 邻域轴向**）|
| 对角 `maxΔlift` | **6.000** | 不得钉 `<= RISER`（两轴各跳一级）|
| 缓坡段取整后最大轴向 Δ | **1** | `<= 1` |
| 真实最大外缘（逐格 `lift>0`） | **75.29** | `< MESA_REACH(82) && < 200` |
| `rt` 全局范围 | 14.77 ~ 37.37 | `< MESA_RTOP_MAX(44)`（理论上界 39.8）|
| 顶半径极差（256 方位） | 10.94 ~ 20.97 | `> 5`（防退化成理想圆）|
| 顶面边界最长轴向直线段 | **21** | `<= 24`（口径：`lift===H` 且 4 邻有 `lift<H` 的格）|
| 顶面绝对 y | **40 ~ 45** | `>= 36 && <= 50` |
| `topY` 上界失效 / 最大 gap | **0** / **4** | 失效 `=== 0`；gap `<= 8` |
| 占地一致性（±88 窗） | changed⊆footprint，**反向差 35094 格** | **只单向**断言 |
| 洪泛 `MAX_STEP=1` / `=3` | **0%** / **100%**（11/11） | `=== 0` / `=== 100`（正向断言）|

**断崖（双口径，4 邻域轴向，步长 1，同窗有山/无山单变量对照）**

| 量 | 本设计 ±100 | 本设计 ±200 | 冰封山锚 ±100 | 冰封山锚 ±200 |
|---|---|---|---|---|
| `Δ>1格%` | **3.92~4.63**（396 座全扫） | **0.98~1.16**（396 座） | 0.46~1.42（33 座） | 0.116~0.357（33 座） |
| 新增≥5格跳 | **24 / 396 座** | **24** | **27 / 33 座** | **27** |
| 最大跳逐位相同 | 310/396（78%） | **387/396（97.7%）** | 19/33 | 33/33 |
| 最大跳范围 | 4~14 | 7~14 | 3~11 | 5~11 |

断言口径（**不钉 0，钉密度与超出量**）：
- `Δ>1格%`：±100 `<= 5.0`；±200 `<= 1.3`。
- 新增≥5格密度：`本设计新增数 / 本设计座数 <= 锚新增数 / 锚座数`（实测 0.061 vs 0.818）。
- 最大跳：`mesaMax - natMax <= MESA_RISER`；且 ±200 窗下 **≥95% 的座逐位相同**。

**成本（口径逐项写清，spec §5.8）**

| 量 | 实测 | 口径 | 门禁 |
|---|---|---|---|
| `liftAt` | 0.0723 µs/次 | 20 万次均值 | 数量级参考 |
| 整列 `surfaceY`（256 格） | **0.0327 ms** | ×256 | 8 ms 门的 0.41% |
| 整列 `inFootprint` | 0.0170 ms | ×256 | — |
| 单 region 冷搜索（**有解** region） | 中位 0.82 / max 1.95 ms | 清空全部 memo | `<= 30 ms` |
| 单 region 热搜索（**结果缓存**） | 0.00005 ms | 1 万次均值 | `<= 1 ms` |
| 真空 region 早退（扫描窗无候选） | 0.0276 ms | 20 个均值 | `<= 1 ms` |
| 一个 seed ±8 全扫（热 memo） | **136 ms** | 第二轮 | `<= 200 ms` |
| 同上（冷 memo） | 702~1190 ms | 含首次依赖 640 ms | 不设门，只记录 |
| 单座竖直填充 | **159399 格** | seed 12345 首座 | 数量级参考 |

## Review Focus

以下八类是 spec 隐含、但单任务测试不直接覆盖的失效形态，按咬人概率排序。每条已在其归属任务里追加了对应测试步骤。

1. **几何公式退化（新增，本轮最大根因）** —— `rt` 改回依赖 `(lx,lz)`、或阶梯带写 `levels×tread`、或缓坡早退用常量 `REACH`。三者任一都会让「轴向陡度 ≤ riser」或「无负 lift」静默失效。→ Task 1 用例 2/3/8。
2. **既有建筑被山半埋（新增）** —— 避让清单漏任一类，山先写、建筑后写胜且 `floorY` 看不到山。→ Task 2 用例 9（逐类分开断言）。
3. **既有结构从「移位」恶化成「召不出」**（返回 null）—— Boss 结构静默消失。→ Task 6 Step 1 的「非 null」与「锚点仍合法」两条**分开**断言 + Task 7 全量回归。
4. **零回归断言恒绿（新增）** —— anchor / 地标中心都是纯函数，山不改它们的输入 ⇒ 断言零判别力。→ Task 6 用例 4/5（改钉 layout 压制结果与 apply 后方块）。
5. **撒布/植被压制漏了一处** —— 树或房长进崖壁。→ Task 4 Step 1 的「占地内撒布/植被方块数 = 0」逐格用例（五个下游消费者都要覆盖）。
6. **云穿崖壁** —— 山顶 y 40~45 与云簇层 35 共处。→ Task 5 Step 1；⚠️ `skipAt` 必须传到**两个**写云函数。
7. **`topY` 上界取错** —— 用「圆心自然高 + H + 8」⇒ 过保守；用圆心单点 ⇒ 漏判空岛。→ Task 2 用例 2 两侧夹逼。
8. **浏览器/Node 落点不一致** —— 上次放弃时有一条「seed 987654 浏览器 null、Node OK」未查明。→ Task 6 Step 3 必须在**浏览器内**复核同一批 seed 的落点。

---

### Task 1: 几何权威与形状纯函数（Tier 1 TDD）

**Files:**
- Create: `src/gen/structures/desert-mesa.js`
- Test: `src/tests/test-desert-mesa.js`
- Modify: `src/tests/index.html`（追加 import）

**Interfaces:**
- Consumes: `blobNoise`（`tarn-terrain.js:203`）、`generateHeight`（`terrain.js`）、`getBiome` / `seededRandom`（`noise.js`）、`SEA_Y` / `WORLD_MIN_Y` / `WORLD_MAX_Y`（`voxel/constants.js`）
- Produces:
  - 常量：上表全部 `MESA_*`（`MESA_HEIGHT` / `MESA_STAIR_STEPS` / `MESA_STAIR_DROP` / `MESA_TAIL` / `MESA_STAIR_W` / `MESA_RTOP_MAX` / `MESA_RIM` / `MESA_REACH` 必须**派生计算**，不写字面量）
  - `mesaTopRadiusAt(seed, theta) -> number`（顶面半径，**只吃方位角**，不吃 (lx,lz)）
  - `mesaLiftAt(cx, cz, seed, lx, lz) -> number`（相对自然地表的抬升，0..H）
  - `mesaSurfaceY(cx, cz, seed, wx, wz) -> number`（最终地表 y）
  - `inMesaFootprint(wx, wz, mesas) -> boolean`（**唯一占地判据**，含缓坡；`mesas` 是 layout 里的数组，null/空数组安全）
  - `MESA_ROCK_BANDS: readonly ['stone','cobblestone','stone_diorite']`
  - `mesaSurfaceBlock(cx, cz, seed, lx, lz) -> 'sand'|'stone'|'cobblestone'|'stone_diorite'`

- [ ] **Step 1: 写失败测试**

`src/tests/test-desert-mesa.js`，用 `import { test } from './runner.js'` 与 `assertEqual / assertTrue / assertDeepEqual`。文件内自定义 `const assertClose = (a,b,eps,msg) => assertTrue(Math.abs(a-b) <= eps, msg)`。

八条用例（**用例 8 是本轮新增，针对已实测到的负 lift 缺陷**）：
1. **常量派生关系**：`MESA_HEIGHT === MESA_LEVELS * MESA_RISER`、**`MESA_STAIR_STEPS === MESA_LEVELS - 1`**、`MESA_STAIR_DROP === MESA_STAIR_STEPS * MESA_RISER`、`MESA_TAIL === MESA_HEIGHT - MESA_STAIR_DROP`、`MESA_STAIR_W === MESA_STAIR_STEPS * MESA_TREAD`、`MESA_RTOP_MAX === MESA_RTOP + MESA_WOBBLE*3`、`MESA_RIM === MESA_RTOP_MAX + MESA_STAIR_W`、`MESA_REACH === MESA_RIM + MESA_SLOPE`。并钉 `MESA_RISER === 3`（用户裁定，改动需重新裁定）。
   ⚠️ **不得把 `STAIR_W` 写成 `LEVELS*TREAD`**（原计划的写法）：那使末级 `lift = 0`、缓坡权重段恒乘 0 ⇒ **缓坡是死代码**（实测：带/不带权重，11 seed 全部山逐格 0 差异）。
2. **三段语义 + 阶梯层序**：取一个固定 `(cx,cz,seed)`，沿 **+x 射线**逐格取 `mesaLiftAt`（此时 θ≡0，`rt` 恒定）：
   - `d ≤ rt` 段恒 `MESA_HEIGHT`；`d ≥ rt + STAIR_W + SLOPE` 恒 0；中间段单调不增。
   - **阶梯层序**：`lvl = ⌊(d−rt)/tread⌋`，断言 `lift === H − (lvl+1)*riser`（**逐格验**）。
   - **末级接缝**：`d` 刚过 `rt+STAIR_W` 时 `lift` 从 `MESA_TAIL` 连续下降，**不得出现 0→TAIL 的逆跳**。
   ⚠️ **不得在非轴向射线上钉「每 `tread` 格降 `riser`」**：斜射线上 θ 逐格微变，`rt` 跟着变 ⇒ 级边界会漂移。沿轴向射线 θ 恒定，公式才逐格成立。
3. **陡度上界**：占地内**逐格**（步长 1）扫 `(RIM+4)×2` 方阵，**轴向**相邻 `|Δlift| <= MESA_RISER` 恒成立（实测 396 座全扫：最大 **3.000**、违例 **0**）。
   ⚠️ **只能钉 4 邻域轴向，不得钉对角**：实测对角最大 **6**（两轴各跳一级）⇒ 8 邻域会在正确实现下 FAIL。
   ⚠️ **本条的前提是 `rt` 只依赖 θ**：若 `rt` 改回依赖 `(lx,lz)`，实测最大跳到 **6**、**39 处违例** ⇒ 本条立刻红。这正是它的判别力所在。
4. **`REACH` 覆盖真实占地**：11 seed × 每个前 3 座，**逐格**扫 `lift>0` 的最大 `hypot`，断言 `< MESA_REACH` 且 `< 200`。**实测 75.29**。
   ⚠️ **不要用「128 方位取 `rt + STAIR_W + SLOPE`」代替**：那是**公式保守值**（实测 77.8~78.1），与真实逐格外缘（75.29）不是同一个量。两个口径均可断言，但要分开命名。
5. **轮廓非圆 + 边界不直**：同一座山 256 方位的顶半径极差 `> 5`（实测 **10.94~20.97**）；且**顶面边界最长轴向直线段** `<= 24`（实测 **21**）。
   边界格定义：`lift === H` 且 4 邻域里有 `lift < H`；沿 x / z 数最长连续 run。
   ⚠️ **不得钉「沿轴最长等半径直段」**（原计划的写法）：`rt` 现在只依赖 θ，沿一条射线 θ 恒定 ⇒ `rt` 恒定 ⇒ 该量恒等于窗宽（实测 100），**零判别力**。
6. **配色分层**：`mesaSurfaceBlock` 在顶面返回 `'sand'`；缓坡带（含末级台面）返回 `'sand'`；阶梯带第 `lvl` 级返回 `MESA_ROCK_BANDS[lvl % 3]`（逐级断言 **11** 级）。`MESA_ROCK_BANDS` 深等于 `['stone','cobblestone','stone_diorite']`。
7. **`inMesaFootprint` 边界与空安全**：`null` / `[]` 返回 false；圆心 true；`d = REACH + 5` false。
   **与 `mesaSurfaceY` 的一致性只能单向断言**：`mesaSurfaceY(x,z) !== generateHeight(x,z)` ⇒ `inMesaFootprint(x,z) === true`。
   ⚠️ **反向不成立，不得写成双向相等**：占地含外围缓坡，那里 `round(lift) = 0` ⇒ `surfaceY === 自然高`。
   实测（定稿几何，33 座 × ±88 窗）：`changed ⊆ footprint` 成立，反向差 **35094** 格 ⇒ 写双向必 FAIL。
8. **无负 lift（新增）**：占地内外逐格扫 `±(REACH+4)` 方阵，断言 `mesaLiftAt >= 0` 恒成立。
   ⚠️ 这条针对已实测到的真缺陷：若缓坡早退用常量 `REACH` 而 `outer` 用真实 `rt`，两者不一致 ⇒ 实测算出 **lift = −3.121**（d=96.75 处），表现为山外一圈凹坑。

- [ ] **Step 2: 跑测试确认 RED**

`npm start` 后浏览器开 `/src/tests/index.html`，读 `window.__MC_TEST_RESULTS__.suites.flatMap(s => s.tests)`，确认新用例全 FAIL（模块还不存在 ⇒ import 失败也要算 RED，但要先确认**是因为模块缺失**而不是注册漏了）。
若已把新文件加进 `UNIT_NODE_SAFE`，可用 `node tools/run-unit-node.mjs --only=test-desert-mesa.js` 更快地跑 RED/GREEN。

- [ ] **Step 3: 实现模块**

按 spec §5.1 的公式实现（参考 `/tmp/mesa-review/geom8.mjs`）。要点：
- `blobNoise` **必须 import**，不在本文件重写（红线 1）。
- **`mesaTopRadiusAt(seed, theta)` 的采样点是 `(cosθ×RTOP, sinθ×RTOP)`**，不是 `(lx,lz)`。这是轴向陡度上界成立的前提。
- **阶梯带宽度用 `STAIR_W = (LEVELS−1)×TREAD`**，末级台面高 `TAIL`，与缓坡起点同值。
- **缓坡早退用真实 `outer + SLOPE`**；函数入口的 `d >= REACH` 早退只是保守剪枝，不能当作缓坡终点。
- `inMesaFootprint` 用**真实 `rt + STAIR_W + SLOPE`**（不是 `REACH` 常量圆）—— 与 `mesaSurfaceY` 同源。
- 文件头注明：上游 Tectonic MIT @ `34241bd`、spec 路径、「只取语义不复制代码」，并含同构声明（`check:arch` 要匹）。

- [ ] **Step 4: 跑测试确认 GREEN + 负向验证**

五条负向验证（用 `cp` 副本还原，**禁止 `git checkout`**；注入后用 `read` 读回确认落地）：
- 把 `mesaTopRadiusAt` 的采样点改回 `(lx, lz)` ⇒ **用例 3（轴向陡度）应红**（实测 maxΔ 6、39 处违例）。
- 把 `STAIR_W` 改成 `LEVELS*TREAD` ⇒ **用例 1（派生关系）与用例 2（末级接缝）应红**。
- 把缓坡早退改成常量 `REACH` ⇒ **用例 8（无负 lift）应红**。
- 把 `mesaTopRadiusAt` 的 blobNoise 项去掉（退化成理想圆）⇒ **用例 5 的极差断言应红**。
- 把 `inMesaFootprint` 改成用 `REACH` 常量圆 ⇒ **用例 7 的一致性断言应红**。

- [ ] **Step 5: `npm run check`**

`check:arch` 会验新文件的依赖方向与 three 隔离；`check:data` 会验测试注册双向。

---

### Task 2: 落点搜索（Tier 1 TDD）

**Files:**
- Modify: `src/gen/structures/desert-mesa.js`
- Modify: `src/tests/test-desert-mesa.js`

**Interfaces:**
- Consumes: `regionLandmarkCenters`（`landmark-circles.js`）、`getCityBoundsForSeed`（`city-layout.js`）、`computeSkyCandidates`（`sky-structures.js`）、`REGION_SIZE`（`region-config.js`）
- Consumes（**本轮新增的避让项**）: `computeGiantPyramidAnchor` + `PYRAMID_HALF`（`giant-pyramid.js`）、`computeBurningArenaAnchor` + `BURNING_ARENA_HALF`（`burning-arena.js`）、`computeRuinedCitadelAnchor` + `RUINED_CITADEL_HALF_X/Z`（`ruined-citadel.js`）、`computeArenaAnchor` + `ARENA_HALF_X/Z`（`arena.js`）、`isTarnZone` + `computeTarnZone` + `TARN_ZONE_RADIUS`（`tarn-zone.js`）、`computeShallowTarnAnchor` + `SHALLOW_TARN_OUTER_RADIUS`（`shallow-water-tarns.js`）、`computeJungleFortressAnchor`（`jungle-fortress.js`）
- Produces:
  - `computeDesertMesas(regionX, regionZ, seed) -> Array<{cx, cz, topY}>`（本 region 至多 1 座；带 `(seed,rx,rz)` **结果缓存**）
  - `clearDesertMesaCache()`（单测隔离用）
  - `mesaTopYBound(cx, cz, seed) -> number`（= 顶半径上界圆盘内 `max(generateHeight) + MESA_HEIGHT`）

⚠️ **单向依赖**：上述模块都不得反过来 import `desert-mesa.js`。已程序化验证：从这 12 个候选依赖出发的 **31 个模块 DFS 无环**，且其中**没有一个** import `structure-layout.js` / `apply.js`。

- [ ] **Step 1: 写失败测试**

十条用例（**用例 9 是本轮新增，针对 78 座穿插缺陷**）：
1. **确定性**：同 `(rx,rz,seed)` 两次调用逐字段相同（`assertEqual` 逐字段）。
2. **`topY` 上界正确**：对 11 seed 各取前 3 座，`mesaTopYBound >= 逐格真实最高 surfaceY`（**上界性质**）；且 `mesaTopYBound - 真实最高 <= 8`（**不过度保守**）。实测：33 座上界失效 **0** 次、最大 gap **4**。⚠️ 两侧都钉。
3. **全 DESERT + 全干燥**：每座山的 `RIM` 圆盘逐格（步长 2）`getBiome === 'DESERT'` 占比 `>= 0.85`，且每格 `generateHeight > SEA_Y`。
4. **不撞地标 / 城市**：每座山与 3×3 邻域的 `regionLandmarkCenters` 任一圆（半径 + REACH）**不相交**；与 `getCityBoundsForSeed` AABB 不相交。
5. **不撞空岛**：每座山与 3×3 邻域的 `computeSkyCandidates().skyIslands` 逐个判 `bottomY > topY` 或水平不相交。**实测 396 座撞 0**。
6. **产率**：11 seed 各扫 ±8 region（289 个），断言每 seed `mesas >= 20`、`沙漠region数 / mesas` ∈ **`[1.3, 3.3]`**、**零座 seed 数 === 0**。
   ⚠️ **分母定义必须写进测试**：`desertRegionCount = 满足 getBiome(rx*400+200, rz*400+200, seed) === 'DESERT' 的 region 数`。
   实测六种口径给出 0.55~11.52（spec §5.2 表）⇒ 不写清口径，这条断言没有意义。
   ⚠️ 必须同时断言 `desertRegionCount > 0`（防恒真）。实测产率：per **1.36/1.91/3.18**，座数 **22/39/44**。
7. **不越 region**：每座山的 `cx ± REACH` / `cz ± REACH` 落在本 region 内。**构造性成立**：`inset = min(REACH, 200−16) = 82` ⇒ 候选窗 `[base+82, base+318)`。实测 396 座违例 **0**。
   （参考：region(0,1) seed 12345 在 inset=84 时有 215 个候选，cx 84..240 / cz 484..712；inset=82 时窗略大，数字会变，不要把 215 当冻结值。）
8. **缓存与早退成本**：热搜索（**结果缓存命中**）`<= 1 ms`；**真空 region**（扫描窗内无 DESERT 候选）早退 `<= 1 ms`；`clearDesertMesaCache()` 后冷搜索 `<= 30 ms`。用 `performance.now()`。
   ⚠️ **冷搜索要选「有解」的 region**：无解 region 走的是早退/全拒路径，拿它量冷搜索会量到 0.25 ms 而不是真实成本（实测有解 region 中位 **0.82** / max **1.95 ms**）。
9. **不撞六类地基级结构（新增，逐类分开断言）**：每座山的 `RIM` 圆与下列占地均不相交：
   - 巨型金字塔（3×3 邻域的 `computeGiantPyramidAnchor`，方↔圆最近距 ≤ RIM）
   - 大竞技场 / 废弃堡垒 / 围场 / 丛林要塞（`seed` 级锚点，各调一次）
   - 高台地带（3×3 邻域 `isTarnZone` → `computeTarnZone`，圆↔圆）
   - 浅水高台（`computeShallowTarnAnchor`，半径 `SHALLOW_TARN_OUTER_RADIUS`）
   **实测：补避让前 78/9/1/1/1 座相交；补后全 0**。
   ⚠️ **不得写成一条合并断言**：合并后只能看到「有相交」，定位不到漏了哪类。
10. **无概率抽签**：同一 `(rx,rz,seed)` 的落点与 `seededRandom(wx,wz,seed+SALT+n)` 无关（改 SALT 的抽签位不影响结果）—— 防将来有人「补上抽签」。

- [ ] **Step 2: 跑测试确认 RED**

- [ ] **Step 3: 实现搜索**

照 `giant-pyramid.js:221` 的手法（spec §5.2 的七步，参考 `/tmp/mesa-review/search5.mjs`）。要点：
- **便宜判据先**：城市/地标（纯算术）→ **地基级结构** → topY 上界 → 空岛 → purity → 干燥。
- **`topY` 用 `mesaTopYBound`**（只扫 `generateHeight`，步长 3），**不逐格算 `surfaceY`**。
- **不查撒布**（压制在 Task 4）。
- 邻域 **3×3**（占地 82 会伸进邻居）；全局唯一结构的锚点是 `seed` 级，**调一次并缓存**，不要在候选循环里重算。
- **`maxTry = 60`**（原 30；实测补避让后 30 会把 per 打到 2.06~4.67，超出「三个沙漠一座」）。
- 乱序 tie-break 用坐标字典序（跨 Worker 一致）。
- **结果缓存**键带 seed（同进程切世界不串味），照 `passesTarnGates` 的粗 LRU。实测：仅依赖 memo 时热搜索 0.29 ms，加结果缓存后 0.00005 ms。
- **无概率抽签**，注释写清理由与实测数字。

- [ ] **Step 4: 跑测试确认 GREEN + 负向验证**

- 把 `mesaTopYBound` 改成 `generateHeight(cx,cz,seed) + H + 8` ⇒ 用例 2 的「不过度保守」应红。
- 把邻域改成只查本 region ⇒ 用例 4/5 应红（邻居地标/空岛漏判）。
- 把 `MESA_PURITY` 降到 0.3 ⇒ 用例 3 应红。
- **逐类删掉用例 9 的避让项（六次，每次只删一类）** ⇒ 对应那类的断言应红，其余仍绿。这是证明「六类都真接上了」的唯一手法。

- [ ] **Step 5: Node 侧对照探针复核**

用 `/tmp/mesa-review/search5.mjs` + `geom8.mjs`（若已被清，按 spec §5.1/§5.2 重建）跑同一批 seed，**逐座标比对**生产实现与探针的落点。不一致要查清（上次有一条浏览器/Node 不一致未查明）。

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

七条用例（原六条 + 新增第 7 条）：
1. **顶面高度**：填充后占地内每格从顶向下首个非 air 方块的 y `=== mesaSurfaceY(...)`（逐格，步长 1，取 3 座）。
2. **配色落地**：地表那一格的方块名 `=== mesaSurfaceBlock(...)`；崖壁竖直段按级序取三色（抽查每级各 3 格）。
3. **填充下方补实**：地表下方到 `WORLD_MIN_Y+1` 全非 air（防悬空），`WORLD_MIN_Y` 是 bedrock。
4. **不越世界顶**：占地内最高 y `<= 50`（实测 **40~45**，`WORLD_MAX_Y=96` 余量 ≥ 46）。⚠️ **同时钉下界 `>= 36`** —— 只钉上界抓不到「山没生成」。
5. **占地外逐位不变**：`REACH + 8`（=90）之外的格，填充前后 `column.blocks` 逐字节相同（核心不变式）。
6. **层序**：在 `fillColumn` + `carveCaves` 之后调用 ⇒ 山顶不被原始地层盖回；在阶段 2.45/2.4 之前 ⇒ 浅水高台/高台地带不削山（构造性验证：造一个假山与真高台圆相邻的夹具，确认两者互不覆盖）。
7. **既有建筑占地内方块逐位不变（新增）**：取一座山附近的巨型金字塔/大竞技场/堡垒，断言它们占地内的 `column.blocks` 在有山/无山两侧**逐字节相同**。
   ⚠️ 这条是 Task 6 「零回归恒绿」问题的真正解法：anchor 是纯函数不会变，**方块才是会变的**。实测补避让前 78 座与金字塔相交 ⇒ 本条必红。

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

- `pointContext`（`apply.js` 的 `pointContext`，**现位 257 行**；原计划写的 132 行已失效）加 `if (inMesaFootprint(wx, wz, layouts.flatMap(l => l.desertMesas))) return { kind: 'none' };`
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

⚠️ **不改云的生成规则本身**（`writeSingleCloudLayer` / `writeCloudClusters` 的噪声判据一字不动）。
**定稿手法**：`applySkyStructures(column, skyCandidates, seed, registry, skipAt?)` 加一个可选回调，
调用侧传 `(wx,wz) => inMesaFootprint(wx, wz, mesaAnchors)`。

⚠️ **必须把 `skipAt` 一直传到两个写云函数**：`applySkyStructures` → `writeClouds` →
`writeSingleCloudLayer` **与** `writeCloudClusters`。`writeClouds` 是个转发层，**只改最外层签名传不下去**
（原计划写「改调用侧」不够明确，已实测确认链路）。三处签名都要加可选参，默认 `undefined` 时行为逐位不变。

⚠️ **高台地带的 4 朵巨型云不在本门控范围**（`apply.js` 阶段 2.4 的 `tarnLayout.clouds`，
`TARN_CLOUD_MIN_Y=54`，走 `rasterizeStructure`）：山已避让地带圆（Task 2 用例 9）⇒ 几何上不可能重叠。

备选（若改签名波及面大）：在阶段 2.5 之后补一个「占地内清云」pass（后写胜）。⚠️ 会多扫一遍占地，成本要实测。选型理由写进注释。

- [ ] **Step 4: 跑测试确认 GREEN + 负向验证**

- 把 `skipAt` 传 `undefined` ⇒ 用例 1 应红（实测顶面 y 40~45 全部 ≥ 35，云必然穿山）。
- **只把 `skipAt` 传给 `writeCloudClusters`、不传给 `writeSingleCloudLayer`** ⇒ y=55 那半条断言应红（证明两个函数都真接上了）。
  ⚠️ 定稿顶面 y < 55 ⇒ 单云层本来就不穿山，这条负向验证可能仍绿。若如此，**改成直接断言「`writeSingleCloudLayer` 拿到的 `skipAt` 非 undefined」**（接线断言），而不是靠像素/方块差异。

---

### Task 6: 既有内容零回归（Tier 1 + Tier 2）

**Files:**
- Modify: `src/tests/test-desert-mesa.js`
- 可能 Modify: 既有 spec/单测的冻结数字 —— ⚠️ **不符时停下来报告，不擅自改**

- [ ] **Step 1: 写失败测试**

五条用例。**前三条是原计划的，已实测确认它们恒绿、零判别力**（anchor 与地标中心都是纯函数，
山不改它们的任何输入）—— 保留作为回归底线，**但不得把它们当作零回归的证据**。
真正有判别力的是新增的用例 4/5。

1. **既有结构非 null**（恒绿，回归底线）：11 seed 下 `computeBurningArenaAnchor(seed)` / `computeRuinedCitadelAnchor(seed)` / `computeArenaAnchor(seed)` / `computeShallowTarnAnchor(seed)` / `computeGiantPyramidAnchor(rx,rz,seed)` **全部非 null**。
2. **锚点仍合法**（恒绿）：锚点仍通过各自的 `candidateValid` 类判据。
3. **地标位置不变**（恒绿）：四个 `getXxxCenterInRegion` 返回值逐位相同。
4. **layout 压制结果不变（新增，有判别力）**：对 11 seed × ±3 region，`computeRegionLayout` 的
   `giantPyramid` / `snowLand` / `pyramid` / `frozenMountain` / `plainLand` / `island` / `skyIslands` 字段
   在有山/无山两侧**逐字段相同**。
   ⚠️ 这才是「山会不会反过来压掉既有内容」的真判据 —— `structure-layout.js` 里的压制链（`suppressGiantPyramid` 等）依赖 anchor，而 anchor 又依赖候选搜索。
5. **apply 后既有建筑方块逐位不变（新增，有判别力）**：取一座山附近的巨型金字塔 / 大竞技场 / 废弃堡垒，
   断言它们占地内 `column.blocks` 在有山/无山两侧**逐字节相同**（与 Task 3 用例 7 同一判据，两处都要钉）。
   实测：补避让前 **78 座与金字塔相交** ⇒ 本条必红；补后全 0 ⇒ 绿。

- [ ] **Step 2: 跑测试确认 RED → 实现 → GREEN**

本任务**不新增生产代码**（若前面任务正确，五条应直接绿）。
⚠️ **用例 4/5 在 Task 2 完成前应能真红**（那时避让还没接上）—— 先跑一次确认它们有判别力，不要写完就直接绿。
若红：
- 先查是不是山**压制**了本该保留的内容（设计说山避让地标）。
- **冻结数字不符 ⇒ 停下来报告实测值与差异，等用户裁决**。

- [ ] **Step 3: 浏览器/Node 落点一致性（Review Focus 6）**

在浏览器内单测里对 11 seed 各取前 5 座，把 `(cx, cz, topY)` 与 Task 2 Step 5 的 Node 结果**逐座标比对**。⚠️ 上次放弃时有一条未查明的浏览器/Node 不一致，这条必须做。

- [ ] **Step 4: `npm run check`**

---

### Task 7: 全量回归与像素实测（Tier 1/2/4）

**Files:**
- Create: `tests/desert-mesa.spec.mjs`（Playwright，Tier 4 像素）
- **Modify: `tools/test-tiers.mjs`**（把 `desert-mesa` 加进 `STRUCT`）—— ⚠️ **漏了这一步 `npm run check` 必红**

- [ ] **Step 0: 归档新 spec（新增，必须先做）**

`check:data` 的 `[测试分档]` 对 spec 是**双向钉**：磁盘上有 `tests/desert-mesa.spec.mjs` 而
`SPEC_TIERS` 里没有 ⇒ 报「spec 漏归档（= 分档入口静默不跑它）」。
把它加进 `tools/test-tiers.mjs` 的 `STRUCT` 数组（与 `giant-pyramid` / `tarn-zone` 同档）。
⚠️ `tools/test-tiers.mjs` 正被其他会话改动（normal 环境风格 Epic）⇒ **改前先 `git diff` 看一眼，只动自己那一行**。

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

- [ ] 11 seed 全部：沙漠/座 ∈ **`[1.3, 3.3]`**（分母 = region 中心 biome）、零座 seed = 0、撞空岛 0。
- [ ] **与六类地基级结构相交全 0**（巨型金字塔 / 大竞技场 / 废弃堡垒 / 围场 / 高台地带 / 浅水高台，逐类分开断言）。
- [ ] **轴向 `maxΔlift <= RISER`、违例 0；无负 lift**（只钉 4 邻域）。
- [ ] **断崖双口径**：`Δ>1格%` ±100 `<= 5.0` / ±200 `<= 1.3`；新增≥5格**密度不高于冰封山锚**（实测 0.061 vs 0.818）；最大跳超出 `<= RISER` 且 ±200 窗 ≥95% 逐位相同。
- [ ] `MAX_STEP=1` 可达 0% / `=3` 可达 100%（**正向断言**，riser=3 的预期行为）。
- [ ] 既有结构全部非 null、地标位置逐位不变、**layout 压制结果与既有建筑占地内方块逐位不变**（后两条才是有判别力的）。
- [ ] 占地内撒布/植被/云/空岛方块数全 0；占地外逐字节不变。
- [ ] `npm run check`（**含新 spec 已归档进 `test-tiers.mjs`**）+ `npm test` + `npm run bench -- --check` + `giant-tree-budget.spec.mjs` 全绿。
- [ ] Tier 4 像素实测带对照组校准，上下界都钉。
- [ ] `generateHeight` / `TERRAIN_HEIGHT_PARAMS` / `BIOME_PARAMS` / `ocean*.js` / `physics.js` **零改动**（`git diff` 核对）。

---

## 附：本轮修订删除的错误断言（勿改回）

| 原写法 | 为何错 | 现写法 |
|---|---|---|
| `Δ≥5格 === 0` | 锚自己就有 27 处；原几何 40 处 | 密度不高于锚 |
| `mesaMax === natMax` | ±100 窗只 78% 成立 | 超出 ≤ RISER + ±200 窗 ≥95% 相同 |
| `Δ>1格% <= 2.2` | ±100 窗实测 4.4~5.1，超门一倍 | 双口径各自钉 |
| `沙漠/座 ∈ [1.4,3.2]`（无分母定义） | 6 种口径给 0.55~11.52 | 钉死分母 + `[1.3,3.3]` |
| 「沿轴最长等半径直段 <= 35」 | rt 只依赖 θ ⇒ 该量恒等窗宽，零判别力 | 顶面边界最长直线段 <= 24 |
| 「128 方位 rt+levels*tread+SLOPE < REACH」作为真实占地 | 那是公式保守值，与逐格外缘差 17 格 | 逐格扫 lift>0 的最大 hypot |
| 「逐级断言 12 级」 | 降幅只有 11 次 | 11 级 |
| 「把 TREAD 改 1 ⇒ 逐级断言应红」 | 逐级断言用的是同一个 TREAD 常量，改它两边一起变 ⇒ 恒绿 | 改成注入「rt 依赖 (lx,lz)」/「STAIR_W=LEVELS*TREAD」/「缓坡早退用常量」三条 |
| Task6 三条零回归断言 | anchor/地标中心是纯函数 ⇒ 恒绿 | 保留作底线，新增 layout 压制 + 方块两条 |
| 「不 import tarn-zone / shallow-water-tarns」 | 实测不成环，且避让它们必需 import | 单向 import，31 模块 DFS 已验 |
| 「只改 applySkyStructures 调用侧」 | writeClouds 是转发层，传不到两个写云函数 | 三处签名都加可选 skipAt |