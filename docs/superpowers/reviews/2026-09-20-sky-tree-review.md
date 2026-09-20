# 空岛天空树：设计规格与实施计划评审报告

**评审对象：**
- 规格：`docs/superpowers/specs/2026-09-20-sky-tree-design.md`
- 计划：`docs/superpowers/plans/2026-09-20-sky-tree.md`
（同在 `e6298db docs(sky-tree): 空岛天空树设计规格与实施计划` 提交）

**评审日期：** 2026-09-20
**评审方式：** **执行计划自身的测试代码**（把 `writeSkyTrees` / `writeIslands` /
`expectedTrunkCells` / `reassembleIslandWorld` 逐字移植到 Node 侧跑），并对规格的每条
事实性断言回到源码/mc-lite 逐条求证 —— 不是阅读理解式评审。

**结论：** 规格的事实基础**扎实**（salt 扫描、通道四方案对比、`opaqueTable` 消费者清单、
离线产物指纹口径全部经复核属实），**但有 2 处阻断级缺陷**：计划里的两条核心断言
（Task 3 树干逐格、Task 4 跨 column 完整性）**按计划原样写出必然失败或恒真无害**，
必须在动工前修掉，否则执行者要么卡住、要么写出无检验力的假绿。

> **两处缺陷同属一类**：规格 §9 的自我纠错记录已经把这类错误命名为
> 「读定义推断，而非实测运行时行为」。这两处是同一类错误在**测试设计**上的复现 ——
> 断言写的是**关于世界的想象**，没有先跑一遍看世界实际长什么样。

---

## 1. 阻断级缺陷

### 1.1 【阻断 A】Task 3 的树干断言必然失败（实测 21.4% 的树命中）

**位置：**
- 计划 `:422` `assertEqual(nWood, expect.length * 4, '每棵树 4 格树干')`
- 计划 `:426` `assertEqual(world.get(key), woodId, '树干格 ...')`
- 计划 `:430` `'树干底格下方须是 sky_grass'`

**复现**（把计划的 helper 逐字移植后跑 Task 3 Step 1 的断言）：

```
findIslandWithTree → region(-23,-21) r=5 h=5 bottomY=52
① 存在性: nWood=18 nLeaves=197 其它方块=178
② assertEqual(nWood, expect.length*4) → 期望 20，实际 18        → **FAIL**
   每格断言「树干格 === sky_wood」       → 失败 2 处            → **FAIL**
      -361,60,-325=16      ← id 16 = sky_leaves
      -361,61,-325=16
```

**根因：** `makeColumnSetter`（`landmarks.js:268-278`）**无条件覆盖**目标格：

```js
column.blocks[idx] = id;   // 无「已占用则跳过」判定
```

而 `writeSkyTrees` 在一个双层循环里**逐棵树依次调用** `generateTree`。先写的树 A 树干落在
`(wx, topY+1..topY+4, wz)`，后写的树 B 的树冠（`wx±2 / wz±2 / y+2..y+4`）可以覆盖 A 的树干格
→ **树干被后来的树叶盖掉**。

**规模（实测，seed=12345，region [-2,2]²）：**

| 指标 | 实测值 |
|---|---|
| 树干格总数 | 81,432 |
| 被非 `sky_wood` 覆盖 | **17,447 = 21.4%** |

**规格的推断与事实的差距：** 规格 §2.5 论证「树冠重叠是高频事件，重叠格由 `setBlock` 后写覆盖，
结果确定」—— 这句本身**没错**，但它只考虑了「叶盖叶」；规格没有意识到**后写的叶会盖掉先写的干**。
同一段的 `surrounded` 优化讨论（`vegetation.js:79`）也只覆盖「叶被叶包围」这一种情形。

**这是与 mc-lite 的真实偏离（规格未记录）：** mc-lite 的 `fakeChunk.add`
（`WorldWorker.js:532-538` / `:1508-1518`）有**占用格守卫**：

```js
// 关键修复：严格检查该位置是否已有方块
// 规则：只要该位置已有任何非空气方块，就不允许再放置任何方块
const existing = blockMap.get(key);
if (existing && existing.type !== 'air' && type !== 'air') return;
```

mc-heavy 没有这个守卫 → 「哪棵树赢」与 mc-lite 不同。规格 §8 的「有意偏离清单」8 项里
**没有这一条**。

**⚠️ 该缺陷不是本计划引入的 —— 是既有的、全局的。** mc-heavy 的地面树走的是同一条路径
（`apply.js:103` 同一个 `makeColumnSetter`，`:324` 调同一个 `generateTree`），
所以地面林地的树干同样会被邻树树冠覆盖。本计划的**独特性在于它是第一个把这个假设写成断言的地方** ——
断言把一个既有的、未被记录的偏离暴露了出来。

**两条修法，选择影响范围（须先定这个再动工）：**

| | 做法 | 代价 | 风险 |
|---|---|---|---|
| **甲** | 改断言：不再宣称「每格树干都是 wood」，改为与「忠实的写入顺序模拟」比对 | 最小改动，Task 3/8 各改几行 | **默认接受**与 mc-lite 的偏离，且偏离不进 §8 清单 → 后人比对时按原样判定 |
| **乙** | 给 `makeColumnSetter` 加占用格守卫（对齐 mc-lite） | 架构级：影响**全部**结构路径（岛体 / JSON 光栅化 / 撒布 / 城市 / 植被） | 每个结构路径的行为都会变，须各自回归；**不该塞进天空树任务** |

**建议：甲 + 登记偏离。** 理由：乙 的影响面远超本任务范围（红线「改动放大器」），
且它会改变既有世界内容（地面林地形状变化 → 视觉比对基准变化 → 可能触发其它 spec 的截图断言）。
正确做法是：本任务用甲让断言变成**忠实描述**（与写入顺序模拟比对），同时把
「mc-heavy 结构写入无占用格守卫、mc-lite 有」作为**一条独立的活跃约束/偏离**记入
`AGENTS.md` 与设计文档，并另开 Epic 评估乙。

**连带影响：** 计划的 Task 8 Step 1（注入半径 -1）与 Step 3（层序倒置）都期望 FAIL 在
`'树干底格下方须是 sky_grass'` 这条断言上。改用甲之后，这两条注入的**期望 FAIL 点会变**
（须重新指定落到哪条断言上），否则负向验证会失效。

---

### 1.2 【阻断 B】Task 4 的用例恒真（选点判据在负数坐标下失效）

**位置：** 计划 `:649`

```js
const distToBoundaryX = Math.min(t.wx % 16, 16 - (t.wx % 16));
```

**根因：** JS 的 `%` 是**取余**而非取模。世界坐标几乎全是负数（本仓库世界无边界、
出生点附近就有负坐标），负数下 `wx % 16 ∈ (-16, 0]`，于是 `16 - (wx % 16) > 16`，
`Math.min` 恒取那个**负值** → 恒 `<= 2` → 条件**恒真**。

实测：

```
wx=-1197 → Math.min(-13, 29) = -13   （正确应为 3）
wx=-1186 → Math.min(-2, 18)  = -2    （正确应为 2）
wx=-360  → Math.min(-8, 24)  = -8    （正确应为 8）
wx=4     → 4                          （仅正数正确）
```

**后果：** 用例退化为「取第一个岛的第一棵树」。实测选中 trunk `(-1197,-1093)`，
它**树冠只覆盖 1 个 column**。于是它自己的两条前提断言立刻失败：

```
④ 前提跨度: 1 个 column（须≥2）      ← 计划 :664 断言 >= 2  → FAIL
⑤ 前提 crossColumnCells=0（须>0）    ← 计划 :698 断言 > 0   → FAIL
```

即 **Task 4 Step 2 在写完后会直接 FAIL**，根本走不到 Step 3 的负向验证。

**更严重的是：即便修好选点、让用例通过，Step 3 的注入也不会 FAIL。**

我按计划 Task 4 的 `reassembleIslandWorld`（含 `span = radius + 2`）跑注入对照，
目标就是那棵**不跨界**的树：

```
[正确 radius+2] 树(-1197,-1093) → missing=0 mismatch=0
[注入 radius]   树(-1197,-1093) → missing=0 mismatch=0    ← 注入无差异
```

**机制（为什么「不跨界」就一定测不出）：** `radius + 2` 门控与 `radius` 门控的**唯一差别**
是「岛体 AABB 不相交但树冠落入」的那些 column。对一棵**树冠不跨界**的树，它的全部格
都落在岛体 AABB 之内 → 两种门控下该 column **都被生成** → 结果逐格相同 → 断言必然两侧都过。
**即：这条用例的检验力完全依赖于「选到的树真的跨界」，选点失效则整条用例归零。**

**修法：** 把选点判据从「边界距离启发式」改为「**按真实足迹判跨度**」：

```js
// 正确：直接算树冠覆盖的 column 集合，用真实的跨界性筛选（不依赖取模）
function spansMultipleColumns(trunk) {
  const cols = new Set();
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    cols.add(`${Math.floor((trunk.wx + dx) / 16)},${Math.floor((trunk.wz + dz) / 16)}`);
  }
  return cols.size >= 2;
}
```

或用正确的非负取模 `((wx % 16) + 16) % 16`。**但推荐前者** —— 它直接以
「用例需要什么前提」为判据，不需要维护一段位运算直觉，也不会再犯同类错误。
选到之后，应保留 `spannedColumns.size >= 2` 与 `crossColumnCells > 0` 两条前提断言
（它们正是防这类恒真的护栏，规格 §6.2 第 1 条已经把「选点须先验证确实跨界」写对了 ——
**规格对，计划把它实现错了**）。

**实测跨界树的占比**（供选点设定预期，seed=12345）：全局 **22.8%**（通过真实足迹判据算得），
所以从 `collectIslands(SEED, 3)` 里筛必然能选到，不需要放宽判据。

---

## 2. 次要问题

### 2.1 Task 7 Step 3 的 `git stash` A/B 有把重写基线带回来的风险

计划 `:1240` 附近的交替对照流程是：

```bash
npm run bench -- --check 2>&1 | tail -20          # 改动侧
git stash push -m "skytree-bench-ab"
npm run bench -- --check 2>&1 | tail -20          # HEAD 侧
git stash pop
```

**问题：** `docs/m3-baseline.*` 是**冻结基线**，而 `npm run bench` **不带 `--check` 时会自动重写它**。
这个流程把 `git stash` 夹在两次 bench 之间 —— 一旦哪次调用漏了 `--check`（或将来有人手工补跑），
被重写的基线就随 `stash pop` 一起回到工作区，而计划末尾的 `git checkout -- docs/m3-baseline.*`
是**可选步骤**（写了 `# 仅在有改动时`）。

**建议：**
1. 把 `--check` 写进每一条 bench 命令行（不要依赖读者记得）；
2. A/B 的 HEAD 侧改为**独立 worktree**（`git worktree add`），彻底避免 stash 往返；
   若坚持 stash，则在 `stash push` **之前**先 `git checkout -- docs/m3-baseline.*`。

### 2.2 Task 9「§4.1 勘误追加第 13 项」没有锚点

计划 `:1505` 与规格 `:483` 都写「追加第 13 项」。但设计文档 `:1204` 的 M2 勘误是
**一段文字 + 一个计数「12 个不透明材质方块」**，不是**枚举列表** —— 没有「第 N 项」可追加。

**建议：** 改为「在该段追加 `sky_leaves` 一条」，并把「12」的措辞一并复核
（加上 `sky_leaves` 后该段的数量表述是否要调整，或明确区分「M2 的 12 个」与
「v1.42 追加的 1 个」两件事，不要混成一个计数）。

### 2.3 `m2-seed12345-comparison.md` 行号口径

规格 §7 第 2 条说两处在 `:41-42` 与 `:58`。实测：`:42` 与 `:58` 命中同一句话
（「无宝箱、无天空树」），`:41-42` 是「观察要点」段。行号**基本准确**，
但建议改为**按内容定位**（「观察要点段」与「已知的有意差异第 1 条」），
行号会随文档增删漂移（本仓库已发生过三次版本号漂移）。

### 2.4 E2E `treeWood > 0` 的失败风险被低估了一个量级

规格 §6.1 与计划 `:1150` 附近用「10% × 156.7 格 → 全不长的概率 ≈ 0.9^157 ≈ 6e-8」论证
「`treeWood > 0` 可忽略失败风险」。但 **E2E 的扫描窗口不是整个岛顶，而是岛顶中心
`dx,dz ∈ -2..2` 的 5×5 区域**（`tests/sky-structures.spec.mjs:104-107`）。

实测（region (0,0) 的 56 个岛）：**中心 ±2 窗口内有树的岛 = 53/56 = 94.6%**，
即约 **5.4%** 的岛在该窗口内一棵树都没有 → 若「离出生点最近的岛」恰好落在其中，
E2E 会**假失败**。这与规格的 `6e-8` 差**六个数量级**。

**建议：** 修正风险描述（~5% 而非 ~1e-7），并把「实施时先跑一次读实际数字」升级为
**必须记录实跑值**；若 `treeWood === 0` 且确认选到的是小岛/中心无树的岛，
应改**扩大扫描窗口**（如 ±4，覆盖顶层圆的主体）或**改为扫描整个顶层圆**，
而**不是**放宽成 `>= 0`（计划 `:1156` 已正确警告了这一点）。

### 2.5 Task 6 fixture 的 precedent 说明可更准

计划 Task 6 Step 2 说「照 `src/tests/test-ao.html` 的既有范式」。该页确实覆盖了
`WorldData` + `computeSkylightColumn` + `getSectionView` + `uploadSection` 这条链路（范式正确），
但它只上传 `opaque` 单通道、且不含 `generateTree`。更贴近的参考是
`test-zombie-head.html` / `test-turret-render.html` / `test-explosion-sprite.html`
（都涉及 GPU 纹理与多通道上传）。建议两者都点名，并补一句提醒：
`getSectionView` 返回的是 **18³ halo 视图**，fixture 布几何时要按该口径放。

（计划已经正确指出 `.html` fixture **不需要**登记进 `check:data` 的 `[测试注册]` ——
我核对了 `tools/check-data.mjs:277` 的扫描口径确为 `/^test-.*\.js$/`，结论属实。）

### 2.6 `sky_leaves`「唯一生成点」的措辞要收紧

规格 §2.1 的「改动安全性」论证「`sky_leaves` 在当前世界里没有任何既有实例」时写
「grep 全仓，唯一生成点是 `vegetation.js:20`」。**这个结论对 `sky_leaves` 成立**
（我复核了：只有 `vegetation.js` 的 `skyTree` 分支产出它），但同一段用来类比的
`chest` 口径不同 —— `chest` 在 `scatter.js:543` 与 `:575` **有生成点**（house / 沉船）。
故 `sky-structures.spec.mjs` 的 `chest === 0` 是**关于岛顶扫描窗口**的断言，不是全世界的断言。

**建议：** 明确写「`sky_leaves` 的唯一生成点是 `vegetation.js` 的 skyTree 分支（且该分支零调用点）」，
避免读者把 `chest` 也理解成全局零实例。

---

## 3. 经复核属实的断言（无须改动）

以下都是规格/计划的事实性论断，我逐条回到源码与 mc-lite 求证，**全部属实**：

| 论断 | 复核结果 |
|---|---|
| `SKY_TREE_SALT = 113` 空闲；**59 已被占用** | ✅ 独立扫描证实：`computeClusterCells` 的 `seed+58+step`（`step < size`，`size ∈ [30,50]`）占 **58..107**；113 空闲 |
| 「salt 占用是区间而非字面量」并给出程序化扫描口径 | ✅ 方法论正确且有价值（本轮最有价值的沉淀之一） |
| `sky_leaves` 通道归属根因 = M2 按「名字含 leaves」归类 | ✅ mc-lite `MaterialManager.js:809` = `mkMat('#FF69B4', 0.9)`（transparent+opacity，**无 alphaTest**）；`:767` 的 `leaves` 才是 `alphaTest: 0.3` |
| 「`sky_leaves` 自 M2-7 起实际渲染就是不透明」 | ✅ 由 cutout 通道 `alphaTest=0.3` 且无 `transparent` 推出：alpha 0.902 > 0.3 → 全保留不混合 |
| `opaqueTable=1` 的 4 类消费者 | ✅ 全部核对：`mesher.js:464`（面剔除）/ `:436-438,500-502`（AO）/ `lighting.js:33,84,165`（含 skylight 垂直 + BFS）/ `turret-system.js:31`（LOS+弹丸） |
| 方案 C **不需要**加 `SAME_TYPE_CULL` | ✅ `SAME_TYPE_CULL` 仅含 `cloud`（`mesher.js:288`）；`:464` 主判据已覆盖 |
| 图标指纹**不含** `cullMode` → 免跑 `npm run icons` | ✅ `tools/icon-fingerprint.mjs:118-134` 只含 geometry + quad 顶点 + 三面 tile 名与内容 hash |
| 新建 `.html` fixture **不需要**登记 | ✅ `tools/check-data.mjs:277` 口径 `/^test-.*\.js$/` |
| 树叶族 8 项，扣掉 `sky_leaves` 剩 7 项 | ✅ `blocks-data.js` 实测 8 个含 `leaves` 的方块名 |
| `m3-fullscene.spec.mjs:95` 断言 `gpuVertexBytes < 150MiB` | ✅ 行号与内容均对 |
| `test-worker-gen.html:57` 断言 `genP95 < 8` | ✅ 存在（**注**：不在 `tests/worker-gen.spec.mjs`，而在被它加载的 fixture 页里 —— 计划若要去"找这条断言"，去 fixture 页找） |
| 设计文档当前 v1.41，故本次取 v1.42 | ✅ `docs/phase-1-engine-design.md:3` 确认；`roadmap.md:318` 确认 v1.39/v1.40/v1.41 已占用 |
| 岛候选不可能超出所属 region（故 `reassembleIslandWorld` 的单 region 候选是对的） | ✅ 岛中心 = `cx*16+8`、`radius ≤ 9`，而 region = 400 格、来源 chunk 25×25 → 数学上余量充足 |
| `blue_planks` 存在且为 opaque（可做 Tier 4 的墙） | ✅ `blocks-data.js:87` |

**另：** 规格 §5.1 关于「CAPACITY 是**视距 8** 容量口径、不要用 vd=10 论证撞破」的提醒，
与 `render-world.js:9` 的原文一致 —— 这条口径提醒值得保留，同类的口径陷阱在本仓库反复出现过。

---

## 4. 处置清单（建议的执行顺序）

**动工前必须解决（阻断）：**

1. **定 1.1 的甲/乙方案** —— 若选乙，本任务须先拆出独立 Epic；若选甲，改 Task 3 的两条断言
   （`:422` / `:426`）+ 相应调整 Task 8 Step 1/3 的期望 FAIL 点，并把
   「无占用格守卫」作为一条新偏离登记进 §8 / `AGENTS.md`。
2. **修 Task 4 选点判据**（计划 `:649`）为「按真实足迹判跨度」，删掉取模启发式。
3. **在修好的 Task 4 上重跑负向验证**（计划 `:713` Step 3），确认注入 `radius` 后
   **真的 FAIL** —— 这是规格 §6.2 第 1 条唯一真正的检验力来源。

**建议一并处理（非阻断）：**

4. Task 7 Step 3 改独立 worktree，或至少把 `--check` 写进每条 bench 命令（§2.1）。
5. Task 9 的「第 13 项」改为按内容定位（§2.2）。
6. 修正 E2E `treeWood > 0` 的风险描述（~5.4% 而非 6e-8，§2.4）。
7. Task 6 补 `test-zombie-head.html` 一类的 precedent 与 18³ halo 提醒（§2.5）。

**值得沉淀为通用规则的两条：**

- **写断言前先跑一遍世界**：本报告两处阻断缺陷都是「断言描述的是想象中的世界」。
  建议在 `docs/testing-policy.md` §2.5（恒真陷阱）补一条：
  **新写的断言必须先在真实数据上跑一次、打印实际值**，再决定断言写成什么。
  这与仓库既有的「不凭感觉宣称通过」「出现机制上不可能的数值时先怀疑脚本本身」同源。
- **坐标类判据一律用非负取模或直接按足迹判**：`wx % 16` 在本仓库（无边界世界、负坐标是常态）
  是**高频陷阱**。同类写法值得全仓 grep 一次（本次评审未展开，建议列为后续小任务）。

---

## 5. 评审方法与可复现性

**方法：** 为避免「读文档推断」重蹈规格 §9 自己记录的覆辙，本轮评审采取
**执行而非阅读**：

1. 把计划的 `writeSkyTrees` / `writeIslands` / `islandLayerRadius` / `makeColumnSetter` /
   `expectedTrunkCells` / `reassembleIslandWorld` / `findIslandWithTree` **逐字移植**到 Node 侧
   （复用真实的 `computeSkyCandidates` / `generateTree` / `seededRandom` / `ChunkColumn`），
   然后照抄 Task 3 与 Task 4 的断言跑一遍；
2. 每条事实性引用（行号、断言、材质注册、指纹口径、扫描口径）回到源码逐条核对；
3. mc-lite 侧只作**行为**核对（`fakeChunk.add` 的占用格守卫、`MaterialManager` 注册），
   不读定义推断。

**诊断纪律：** 本轮探针自身出过 3 次错（`%` 取余直觉、结构顺序 bug 导致 100% 假值、
字符串 id 与数字 id 混比导致 100% 假值），每次都在**数值机制上不可能**时回头查脚本
（如「100% 覆盖」）—— 与 `AGENTS.md`「出现机制上不可能的数值时先怀疑脚本本身」一致。
用户如要复核，探针脚本暂存于 `/tmp/mcheavy-probes/`（非仓库内，不污染工作区）。

**行号口径：** 本报告引用的计划/规格行号对应 `e6298db` 的版本；若两份文档在处置过程中被修改，行号会漂移 ——
定位时请以**引用的代码片段内容**为准（同 §2.3 的建议：用内容而非行号锚定）。

**未展开的部分：** 本报告**未**做的验证，明确列出以免读者误以为已覆盖：

- 未跑 bench / Tier 4 / 真实 GPU（属于实施期门禁，本评审只做静态与 Node 侧验证）；
- 未验证规格 §4 的勘查数据本身（GEN p95 +0.33ms、MESH +0.4%、面数 700,064 等）——
  这些是**规格声称的实测**，本评审只核对了其方法论（交替对照）与结论自洽性；
- 未全仓 grep 坐标取模类写法（§4 最后一条建议的小任务）。
