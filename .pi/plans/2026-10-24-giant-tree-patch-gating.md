# 巨树区域门控（beach / banyan 覆盖率）实施计划

日期：2026-10-24
状态：已批准，待实施

## 1. 需求（用户原话）

> beach 的巨树的出现，现在几乎是每个 海滩旁边都有巨树矩阵，我不需要每个海滩边上都有巨树矩阵，平均三个海滩，有一个边上有巨树矩阵就可以了，
>
> banyan 也是，平均两个 banyan 有一个有巨树矩阵的就可以了，密度维持照旧。

两个已确认口径：

1. **尺度 = 中斑块 `scale=1/96`**（斑块直径约 96~190 格）
2. **只做区域门控** —— `spacing/jitter` 完全不动，「密度维持照旧」

## 2. 现状

`GIANT_TREE_PATHS`（`src/gen/structures/giant-trees.js:79`）三条路径，`chance` 全为 1：

| 路径 | spacing/jitter | cell 边长 C | 落位判据 |
|---|---|---|---|
| forest | 32 / 8 | 40 | `FOREST` + 陆上 |
| beach | 12 / 8 | 20 | 陆上 + 距水 ≤ 24 |
| banyan | 17 / 11 | 28 | 陆上 + `PLAINS`/`DESERT` 交界（±32） |

3×3 region（seed 12345）候选数：forest 137 / beach 578 / banyan 103。

## 3. 关键实测：为什么不能用「聚类切分海滩」

用切比雪夫阈值做连通聚类（union-find）：

| 路径 | 阈值 32 | 阈值 64 | 阈值 96 | 阈值 128 |
|---|---|---|---|---|
| beach | 79 簇（最大 422×638） | **1 簇**（1187×1187） | **1 簇** | **1 簇** |
| banyan | 19 簇 | 12 簇 | 11 簇 | 10 簇 |

**beach 的高阈值下只有 1 个连通簇** —— 海岸线本身是连续的，所以「一个海滩」在几何上没有客观边界，无法用聚类切分。只能用**空间斑块门控**表达「这段海岸有树、那段没有」。

## 4. 否决的方案：噪声 + 标定阈值

试过 `noise(x, z, seed + salt, scale) > threshold`（threshold 按 top-p 分位标定）：

| 路径 | seed 12345 | seed 999 | seed 424242 |
|---|---|---|---|
| beach 阈值（标定到 1/3） | 0.553 | 0.568 | 0.664 |
| beach 用 12345 阈值迁移后通过率 | 0.330 | 0.340 | 0.362 |
| banyan 阈值（标定到 1/2） | 0.979 | 0.804 | **−0.071** |
| banyan 用 12345 阈值迁移后通过率 | 0.495 | 0.460 | **0.373** |

**根因**：`noise()`（`src/gen/noise.js:18`）是 `sin((x+seed)*scale)*2 + cos((z+seed)*scale)*2` —— seed 直接加进坐标，`seed*scale` 的相位随 seed 大幅漂移（seed 12345 → 128.6 rad，seed 424242 → 4419.2 rad）。所以**任何固定阈值的通过率都会随 seed 漂移**，必须为每个 seed 重新标定，不可接受。

另外还试过「双线性插值的平滑随机场」：cell=96 时各 seed 标定阈值极差 0.150（beach）/0.234（banyan），迁移通过率同样漂移 —— 因为标定量本身依赖候选集分布。**一并不采用。**

## 5. 采用的方案：粗格哈希门控

在候选层加一道门控：

```js
// 常量（与路径参数同处单一定义）
const PATCH_CELL = 128;              // 粗格边长（格）；斑块直径 ≈ 96~190 格
const PATCH_SALT = 951;              // seededRandom 的 salt（需程序化扫描确认空闲）

// discoverPath 内，求出 wx/wz 之后、eligible 求值之前：
const ci = Math.floor(wx / PATCH_CELL);
const cj = Math.floor(wz / PATCH_CELL);
if (seededRandom(ci, cj, seed + PATCH_SALT) >= path.patchChance) continue;
```

三条路径各加 `patchChance`：**forest 1 / beach 1/3 / banyan 1/2**。

### 为什么选这个

- **整格共享同一个随机值** → 树天然成片（粗格 128 格 ≈ 用户认可的斑块尺度），不是斑点式零散。
- **通过率精确等于 `patchChance`，且与 seed 无关**：哈希输入是整数粗格下标，没有 `seed*scale` 那种相位耦合。这比「噪声 + 标定阈值」少一个需随 seed 重新标定的常量。
- **跨 region 无缝**：粗格下标按全局网格算，一个粗格横跨 region 边界时两侧各算一次、结果一致（与既有 `C = spacing + jitter` 的跨 region 保证同源）。
- **先廉价后昂贵**：哈希在 `eligible`（biome / 近水 / 交界）求值之前，保住 `discoverPath` 既有的「每格至多求值一次谓词」口径。
- **forest 不受影响**（`patchChance = 1`），森林行为逐位不变。

### 20 个 seed 的实测（cell=128，R9 口径）

| 路径 | 目标 | 粗格覆盖率均值 | 实测 sd | 二项理论 sd |
|---|---|---|---|---|
| beach | 1/3 | **0.315** | 0.055 | 0.047 |
| banyan | 1/2 | **0.491** | 0.086 | 0.050 |

banyan 的离散度偏大是因为粗格数只有 26~40 个（二项噪声 ∝ 1/√n），属正常抽样波动。

seed 12345 单看：beach 99 个有候选粗格 → **38 个有树（38%）**；banyan 35 → **18 个（51%）**。

`seededRandom` 在整数点上的分布质量已验证（salt 951，1681 个点：均值 0.494、`P(v < 1/3) = 0.336`、χ²(9df)=3.8）。

### salt 占用

`PATCH_SALT = 951` 必须程序化扫描确认空闲（CLAUDE.md 既有约束：salt 占用须程序化扫描，不能 grep 字面量；巨树已占 911~935 / 941）。951 在 9xx 段、与现有区间不相交，仍须扫描复核。

## 6. 改动清单

### 6.1 `src/gen/structures/giant-trees.js`

1. 新增 `PATCH_CELL = 128` / `PATCH_SALT = 951` 常量（导出供单测复用同一份判据，红线 1）。
2. 三条路径各加 `patchChance` 字段（forest 1 / beach 1/3 / banyan 1/2）。
3. `discoverPath`：在 `eligible` 之前插入门控。
4. 文件头注释块补两段：
   - 为什么用粗格哈希而不是噪声阈值（附相位漂移证据）；
   - 为什么不能按聚类切分海滩（附连通性实测）。

### 6.2 `src/tests/test-giant-trees.js`

新增用例：

- **门控确定性**：同 seed 两次调用逐元素相等（红线 2）。
- **门控通过率**：R9 口径，beach 在 `[0.2, 0.5]`、banyan 在 `[0.35, 0.65]`（seed 12345 实测值两侧留足余量，不贴线）。
- **同粗格同进退**（成片判据，核心）：取一个有候选的粗格，格内候选全在候选表里；取一个没通过的粗格，格内候选一个都不在。这才区分「成片」与「斑点」。
- **forest 不受门控影响**：候选数与手工按 `patchChance=1` 复算的结果逐位相同。

更新：既有「候选密度下界」——beach 578 → 约 193、banyan 103 → 约 51，下界按实测 2/3 重算。

### 6.3 文档同步（同一事实的多个副本，一起改）

- `docs/superpowers/specs/2026-10-23-giant-trees-design.md` §1.1 表（加 `patchChance` 列）+ §3.4 候选算法（门控规则与理由）。
- `docs/giant-trees-acceptance-report.md` §2.2 密度表 + §5 可调旋钮（`patchChance` 进旋钮清单）。
- `docs/roadmap.md` v1.71 条目追加第二轮（区域门控）；「活跃约束详情 · 巨树景观」段更新密度/覆盖率。
- `CLAUDE.md` 活跃约束新增一条：**覆盖率用粗格哈希，不用噪声阈值**（附相位耦合实测）。
- `docs/superpowers/plans/2026-10-23-giant-trees.md` 的内联代码块副本。

### 6.4 `tests/giant-trees.spec.mjs`

榕树落地用例上一轮已改成「用真实 `giantAllowedAtFor` + `collectExclusionBoxes` 筛候选」，修法本身不依赖密度。门控后候选变少，若某 seed 下可落地候选不足会真 FAIL —— 届时按实测调整取点数量（**不是**放宽判据）。

### 6.5 `tests/giant-tree-budget.spec.mjs`

`GIANT_FLOOR`（各视域巨树方块数下界）会随树量下降。**实际做法（偏离原计划）**：不按视域重标，而是改成
**「5 个视域合计下界 20,000」** —— 因为实测 seed 12345 下 `(18,27)` 与 `(30,10)` 的巨树方块从 7235 / 1741
变成 **0**（视域落在被跳过的粗格里，正是用户要的效果），按视域重标就只能写 0（等于没对照）。
合计口径仍能抓住「树根本没生成」这种真回归。

## 7. 验证

| 步骤 | 命令 | 判据 |
|---|---|---|
| 单测 | 浏览器 `src/tests/index.html` | 全绿；新增 4 条含在内 |
| 静态门 | `npm run check` | 架构红线守住 + 数据契约一致 + 0 error |
| E2E | `npx playwright test tests/giant-trees.spec.mjs tests/giant-tree-budget.spec.mjs` | 全绿 |

**负向验证（必须真 FAIL）**：

1. 把三条路径的 `patchChance` 全改成 1 → 「门控通过率」与「同粗格同进退」两条须 FAIL。
2. 把门控从「粗格哈希」改成「按候选点哈希」→「同粗格同进退」须 FAIL（斑点 vs 成片的判据）。

撤注入一律用 `cp` 副本还原，**禁止** `git checkout`（含未提交改动）。

## 8. 注意事项

- `bg_15`（上一轮 `17/11` 的 E2E）仍在后台跑；结果到了先看是否全绿，再叠加本轮改动。
- 本轮**不提交**，等明确指令。
- 上一轮（`12/8 → 17/11`）的改动尚未提交，本轮在其之上继续。
