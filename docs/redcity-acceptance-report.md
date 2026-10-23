# RedCity Epic 验收报告

**日期：** 2026-10-23（规格/计划 2026-10-22 起草，2026-10-22~23 经「影子工作树按序真执行」审阅并升到 v1.2，2026-10-23 用户裁定 U1′ / R15 / R11 后在真实仓库落地）
**规格：** `docs/superpowers/specs/2026-10-22-redcity-design.md`（v1.2，**§14 为权威**，§13 为 v1.1，§1~§12 为 v1.0 调研）
**计划：** `docs/superpowers/plans/2026-10-22-redcity.md`（Task 0~11）
**参考实现：** `docs/superpowers/specs/2026-10-22-redcity-appendix/appendix-f-reference/`（新文件 + 补丁，冻结快照；落地后以 `src/` / `tools/` / `tests/` 为准）
**commit：** **未提交**（仓库规则：提交等用户明确指令）。建议分组见 §1 末尾。

---

## §1 交付摘要

把 Sakura Spawn（ArtillexStudios，WorldEdit schematic，250×289，24.5 万块）离线烘焙成 City 东侧的静态地标，并把默认出生点迁到它的中心。
**全部走既有管线，没有新增持久化路径、Worker 或子系统**：

| 交付项 | 实现 | 复用的既有底座 |
|---|---|---|
| 离线烘焙 + 指纹门禁 | `tools/{bake-redcity,redcity-config,redcity-schematic,redcity-bake-core,redcity-fingerprint}.mjs` → `assets/redcity/redcity.json`（扁平 `[col, dy, pal]` 三元组 JSON，2.85 MiB）；`check:data` 的 `[RedCity]` 环节 | `icons` / `zombie` / `turret` / `nightsky` 四个先例的「输入指纹」手法；烘焙核心为 Node-only Playwright spec |
| 全局下发（不走 3×3 域） | `StructureIndex._requiredKeys = 3×3 ∪ {(0,0)}` + `redCity()` 随每个 `gen` 任务下发（约 200 B） | DR-13「结构布局单 Worker 算一次、主线程转发」 |
| 地形整形 + 整体吞并 + 过渡环 | `redcity-surface.js`（环公式 / 列整形 / 吞并判定）+ `apply.js` 阶段 1 / 2 / 2.7 / 2.9 / 3；`landmarks.js` 的 `landmarkHalfExtent` 外包范围唯一权威 | 既有 GEN 阶段与 `makeColumnSetter` |
| 烘焙内容光栅化 | 阶段 2.9（空中结构之后、植被之前）：世界 y = `baseY + dy` | 后写胜的既有语义 |
| 植被避让 / 被吞并地标的植被上下文 | `pointContext` 带 `erased[li]`；避让距离 = `TREE_CANOPY_RADIUS`（3）= 阶段 3 的 `EXT`（同源） | `region-config.js` 常量权威 |
| 水面门控 | `ocean-mask.js` 第 5 参 + `ocean.js` 第二个 bounds uniform（同一不等式） | 红线 1：CPU 版与 TSL 版同构 |
| 出生点迁移 | `getRedCitySpawnPoint` + `scanDownForSpawn`；`?spawn=city` 退回 City（调试入口，不进设置面板） | 与 `?skybox=0` / `?shadows=0` 同类 |
| 存档 | IndexedDB `DB_VERSION` 2 → 3，升级清空 `meta / edits / entities`（用户裁定弃旧档，D7）；`onblocked` 接 `main.js` 覆盖层 | `Persistence` 既有 `onupgradeneeded` |
| GPU 预算 | `CAPACITY`：opaque 4.275M / cutout 2.2M（不变）/ transparent 0.36M；冻结预算 148.06 → **195.55 MiB**（U1′-a） | `render-world.js` 三级兜底不变 |

**规模**（`git status`）：非文档文件 34 个修改 + 20 个新增（+544 −61 行，不含新增文件）；新增 5 个烘焙工具、3 个运行时模块、7 个浏览器内单测文件、5 个 Playwright spec、1 个产物。
文档：设计文档 v1.65 → **v1.68**（修订说明 + §4.2 / §4.8 / §4.10 / §5）、`docs/roadmap.md`、`CLAUDE.md`、`docs/testing-policy.md`（§2.7 第 14/15/16 类）。

**建议的提交分组**（等你授权；每组都是 `npm run check` 绿的）：① 文档（规格 v1.2 + 计划 + 附录 F + 设计文档 v1.68）→ ② Task 1~2（常量/加载器/烘焙）→ ③ Task 3~7（布局/整形/吞并/植被）→ ④ Task 8（容量）→ ⑤ Task 9（装配 + pin + E2E + 预算 + R15 观测）→ ⑥ Task 10~11（门禁 + 文档 + 像素实测 + 本报告）。

---

## §2 需求逐项对照（规格 §1 的 R1~R5 与用户裁定）

| 需求 / 裁定 | 结果 | 证据 |
|---|---|---|
| R1 City 边界开辟空地，渲染新地图 | ✅ 固定在 City 东侧，`core.minX = city.maxX + 1 + 24` | `test-redcity-layout.js`；E2E 全局下发（x>799 的 core 列仍是 clay） |
| R2 建筑来自 schematic | ✅ 244,647 块，palette 28 项，Worker 接线逐格比对 | 烘焙 spec 黄金比对；E2E「Worker 接线」断言主线程 `world` 里的方块 |
| R3 尽量用现有方块、颜色接近 | ✅ palette ⊂ registry（门禁）；屋顶 `168:2 → oxidized_cut_copper`（U2 接受偏亮青绿）；粉羊毛/粉混凝土 → `pink_wool`；玻璃（含粉玻璃，U3）→ `glass_block` | `check:data` 颜色关系式（R<B<G）；Tier 4 像素实测（§3.4） |
| R4 地形衔接平缓、无断崖 | ✅ 过渡环 `s = clamp(baseY, e−m, e+m)`，可证明 `|Δs| ≤ |Δe|+1` | 20 个 seed `|Δs|>1` 占比 ≤ 2%（最差 0.69%）；seed 1–80 core 边缘一圈对自然地表台阶 >2 的占比最差 3.88% |
| R5 出生点在 RedCity 中心 | ✅ `x/z` 取方块中心（+0.5），脚下 solid、头顶 24 格全空 | E2E「出生点」 |
| D5 吞并邻区地标 | ✅ **整体吞并**（地形 + JSON 结构 + 植被上下文） | `吞并 ≡ 地标不存在` 单测（五类地标逐类）；80 个 seed 累计被吞并：冰山 91 / 金字塔 80 / 雪原 63 / 海岛 19 / 平原岛 4 |
| D6 / U3 玻璃用现成 `glass_block` | ✅ 含粉玻璃 | 像素实测「玻璃通透」 |
| D7 弃旧档 | ✅ DB v3 | E2E「D7」×4 |
| D8 产物 JSON | ✅ 2.85 MiB / parse 4.6 ms / heap +6.4 MiB | — |
| U1′-a（2026-10-23） | ✅ 195.55 MiB，零扩容 | 预算 spec（§3.3） |
| R15 选 A（2026-10-23） | ✅ 冻结口径 pin 在 City + RedCity 口径观测门 3.5 ms | §3.5 |
| R11 模型授权（2026-10-23） | ✅ 用户确认 ok | — |

---

## §3 实测数据

### 3.1 烘焙（`npm run redcity`）

烘焙 ~0.9 s；不变量 **I1=1**（岛外相邻高差上限 1）/ **I2=0**（矩形边界非零 ground 列数）/ **I3=-5**（`ground ≥ -5`）/ **I4** `dyMax=80`（预算 87，`BASE_Y_MAX 8 + 87 = 95 = WORLD_MAX_Y − 1`）/ **严格 I5=0**（同一刚性分量内部保形）/ **I5′=0.055%**（84 / 151,392）；
映射覆盖：未覆盖 0 块；产物 250×289，244,647 块，palette 28 项；出生点 `ox=138 oz=141 dy=-3`（距中心 13.83 格）；指纹 `a9f0be96c3d4ebaa`。
新产物与入库版**只差 `bakedAt` 一个键**（脚本不再写时间戳）；再烘一次 sha256 一致（幂等）。**I6 已删除**（125 个刚性分量里 104 个违反，极差中位 8、最大 40；见 §4）。

### 3.2 测试规模

| 口径 | HEAD | 最终 | 新增 |
|---|---|---|---|
| 浏览器内单测页 `total` | 779 | **822** | +43（Task 1 +5 / Task 3 +8 / Task 4 +10 / Task 5 +4 / Task 6 +5 / Task 7 +8 / Task 9 +3） |
| Playwright 用例（干净 `git archive HEAD` 导出） | 182 条 / 61 文件 | **212 条 / 66 文件** | +30（`redcity-bake` 12 / `redcity-e2e` 9 / `redcity-budget` 4 / `redcity-visual` 4 / `redcity-edit-perf` 1） |

⚠️ 本地 `npx playwright test --list` 会比干净 HEAD 多 3 条——工作区里有被 `.gitignore` 忽略的 `tests/tmp-*` 探针 spec（`tmp-col21` / `tmp-flicker`）。数用例数前先排除；本次全量回归用 `--grep-invert "P12-E|P12-F|列21残留光溯源"` 排除它们。

### 3.3 GPU 预算（U1′-a，真实页面，vd=8，`reservedV = ceil(vertexCount × 1.25)`）

| 通道 | 容量 | 稳态（出生点） | 无碰撞飞越峰值（预算 spec 实测） | 4 个 seed × 6 路线取最大 |
|---|---|---|---|---|
| opaque | 4,275,000 | 3,344,190（**78.2%**） | seed 12345：**92.4%**；seed 777：85.6% | 92.4%（seed 12345 R5） |
| cutout | 2,200,000（不变） | 553,630（**25.2%**） | seed 12345：92.3%；seed 777：21.8% | **92.6%**（seed 12345 R6 东南角，自然森林驱动，R10） |
| transparent | 360,000 | 252,465（**70.1%**） | seed 12345：66.8%；seed 777：**83.1%** | 83.1%（seed 777 R3；旧 300K 下 99.7%） |

`gpuVertexBytes = 205,050,000 B = 195.55 MiB`（= 三通道容量之和 × 30 B），全程**零扩容**。门禁 ≤95%：cutout 余量只有 7.4%（R10），余量被侵蚀时会先红，届时再升 cutout 到 2.4M（U1′-b，+5.7 MiB）并重新过用户。
对照（方案 A，**作废**）：opaque 稳态 90.3%、12 s 无碰撞飞越 106.6% 触发 ×1.5 扩容（GPU 177.53 → 230.5 MiB）；W 键奔跑峰值 98.9% 无扩容但贴线；transparent 在 seed=777 上 99.7%。
冻结基线（HEAD）`gpuVertexBytes = 155,250,000 B = 148.06 MiB` → 本 Epic 后 195.55 MiB；`m3-fullscene` 的 150 MiB 断言按设计会红，已在同一次变更里有意改为 196 MiB（负向验证：改回 150 MiB → `Expected: < 157286400  Received: 205050000`）。

### 3.4 像素实测（Tier 4，每条都带同机位对照）

| 用例 | 实测 | 门限 |
|---|---|---|
| 青绿屋顶（R<B<G 且 G−R>40 的像素占比） | 正对 **19.01%** / 背对 6.23% | 正对 > 8% 且 ≥ 2× 背对 |
| 樱花粉（R>B>G 且 R−G>50、B−G>15） | 正对 **26.08%** / 背对 0.32% | 正对 > 8% 且 ≥ 5× 背对 |
| 玻璃通透（同机位 3×3 玻璃面板换 stone，中心 50×50 均值） | glass (104.6, 109.0, 116.6) → stone (92.3, 94.6, 99.8)，Δ = (−12.2, −14.4, −16.8) | `max\|Δ\|` > 8 |
| 水面门控（洞中心蓝通道，门控开 → 关 = 注入缺陷） | on (141.6, 146.5, 158.1) → off (160.1, 184.0, 236.9)，ΔB = **+78.9** | ΔB > 40 |

U3 之后粉色只有两个源：`35:6` 粉羊毛 13,573 + `251:6`/`252:6` 粉混凝土 16,370，共 29,943 块；`95:6` 粉玻璃（2,785）已映射为 `glass_block`。

### 3.5 R15：RedCity 出生点的编辑耗时（用户裁定选 A）

| 出生点 | 单块放置 p95 | 单块挖除 p95 |
|---|---|---|
| City（冻结口径，早期 3 次实测） | 1.6~1.8 ms | 1.6~1.8 ms |
| **RedCity**（`redcity-edit-perf` 5 次重复 + 真实仓库 1 次） | **2.4~2.5 ms** | **2.4~2.7 ms** |

拆分计时：`world.setBlock` 0.1 ms 不变，`scheduler.remeshSections(..., { fastPath: true })` 的同步重建 1.7 → 2.4 ms——出生点周围 section 更密（被编辑 section 的顶点量更大）。
**处置**：冻结口径「单块放/挖 p95 < 2 ms」（§4.3 快速路径硬约束）仍由 `m1-acceptance` / `weapons-world-edit` 守，已 pin `?spawn=city`，**一个字没放宽**；RedCity 口径另立 `tests/redcity-edit-perf.spec.mjs`（测量代码与 `m1-acceptance` 逐行同构；阈值 3.5 ms，用户选 A 即同意该建议数字；合理性下限 0.5 ms）。

### 3.6 bench（`npm run bench -- --check`，Task 8 之后 / Task 11）

| 时点（真实仓库，`npm run bench -- --check`） | ① 平原冲刺 | ② 城市中心环视 | ③ 连续放/挖 200 块 | ④ 模拟 TNT 批量删 500 块 | 结论 |
|---|---|---|---|---|---|
| Task 8 之后（`CAPACITY` 已改、出生点仍在 City） | fps 119.98 · p95 9.2 · draw 500 | 119.99 · 9.2 · 559 | 120 · 9.1 · 559 | 119.99 · 9.1 · 545 | `--check` 通过 |
| Task 11 之后（装配 + pin 后的最终状态） | fps 120 · p95 9 · draw 500 | 120 · 9.1 · 559 | 120 · 9 · 559 | 120.32 · 9.2 · 545 | `--check` 通过 |

模拟树回放里另有两次独立实测：p95 9.9 / 9.9 / 9.9 / 9.9 与 10.0 / 9.9 / 9.8 / 9.9，同样通过——**帧 p95 落在 9.0~10.0，正是 9↔10 的 vsync 量子边界**。冻结基线各场景 p95 为 9.2 / 9.2 / 16.7 / 9，门限 = 基线 × 1.1，场景 ④ 的门限只有 9.9，所以那几次是贴线通过；
门禁阻断时按交替对照处理，不看单次数值（CLAUDE.md 既有口径）。`docs/m3-baseline.*` 全程未被改写（只带 `--check` 跑）。

⚠️ **发现一处 `--check` 的既有缺陷（本期不修，见 §7）**：`compareWithBaseline` 对 `STRUCTURAL` 集合（`drawCalls` / `sections` / `voxelBytes` / `gpuVertexBytes`）的判定分支恒为 false——
`regressed = LOWER_IS_BETTER.has(k) ? … : (isFps ? … : false)`，这四项既不在 `LOWER_IS_BETTER` 也不是 fps，注释里写的「结构类 2%」实际**不生效**。实证：draw 559 / 559 / 545 比冻结基线的 545 / 545 / 526 高 2.6~3.6%，门禁照样通过；`gpuVertexBytes` 148.06 → 195.55 MiB 它也看不见。
所以本 Epic 的 GPU 预算**只由** `m3-fullscene`（196 MiB 上限）与 `redcity-budget`（≤95% + 零扩容 + `gpuMiB ≤ 195.55`）守，不要指望 bench 兜底。

### 3.7 全量回归与 flaky 清单

**真实仓库最终全量回归（Task 11 之后，pin 与全部新增 spec 就位）：212 passed / 0 failed，14.0 min**（`npx playwright test --grep-invert "P12-E|P12-F|列21残留光溯源"`——排除 3 条被 `.gitignore` 忽略的临时探针；退出码 0）。

落地前，同一份补丁在**模拟树**（干净 `git archive HEAD` 副本，端口隔离）上按序回放过，结果如下（回放时 RedCity 新增 29 条 = 211 条，尚不含 R15 观测用例；该用例是 2026-10-23 裁定 R15 后补入的）：

| 检查点 | 结果 | 说明 |
|---|---|---|
| Task 8 之后（装配前，出生点仍在 City） | **194 passed / 0 failed**（11.9 min） | 182 + 烘焙 spec 12 |
| Task 11 之后 · 第一次回放 | 209 passed / 2 failed（13.7 min） | `m3-2-orientation:283`（`meshInflight`）+ `zombies:803`（0.397 < 0.4） |
| Task 11 之后 · 第二次回放（已补 `zombies` pin） | 210 passed / 1 failed（13.6 min） | 唯一红的是 `weapons-world-edit`（`pistolEffects` 199≠200） |

三条红**都不是靠单次红绿下结论**，而是交替对照看分布：

- **`zombies` 互斥（0.397 < 0.4）→ RedCity 出生点造成的系统性下移，补第 12 个 pin。** 同源探针（逐字复制该用例场景、只去掉断言、打印 `after`）在干净 HEAD 与回放树上交替各 6 轮：City 出生点 `min` = 0.574 / 0.586 / 0.526 / 0.570 / 0.575 / 0.600（中位 0.574），RedCity 出生点 = 0.420 / 0.410 / 0.412 / 0.424 / 0.361 / 0.496（中位 0.416，1 轮 < 0.4）。pin 后真实仓库该用例通过。
- **`m3-2-orientation:283`（`meshInflight` 1≠0）→ HEAD 既有 flake，不 pin。** 隔离交替对照 40 轮：干净 HEAD 0 次、回放树 2 次，Fisher 精确检验 p≈0.49，差异不显著（CLAUDE.md 已记该断言在 HEAD 的频率约 2/30）。真实仓库最终全量里它是绿的。
- **`weapons-world-edit`（199≠200）→ 已知计时型 flaky，且在干净 HEAD 上同样复现。** 单独交替复跑 2 轮：回放树 2/2 通过，**干净 HEAD 1/2 红（同为 199）**；该用例已 pin `spawn=city`，场景与 HEAD 相同。真实仓库最终全量里它是绿的。

CLAUDE.md 记的其余计时型 spec（`m1-acceptance` / `m3-rain` / `worker-gen` / bench 两条门禁）在真实仓库这一轮没有出现贴线红。

---

## §4 偏离表

### A. 相对规格 v1.0 / v1.1 的偏离（规格 §14.1 订正总表 C1~C18 的要点）

| # | v1.1 / 旧计划的说法 | 实测后的做法 |
|---|---|---|
| C1 | 方案 A 容量足够（U1 已批准） | **真实页面不够** → U1′-a（§3.3）；设计文档 §4.10 明确取代 v1.42 的 148.06 MiB 口径 |
| C2 | I6「建筑 footprint 内 ground 极差 ≤ 1」+ 脚下平台化 | 与算法矛盾（125 个刚性分量里 104 个违反）→ **删除，不替换为断言**；旧 I5 对逐列剪切无感（注入后读数 84→0）→ 拆为严格 I5 + I5′ |
| C3 | 海岛外包 39 / 平原岛 15 | 真值：海岛 **25**（`dist<39` 不可达）、平原岛 **(17, 20)**（地标 = 地形 ∪ JSON 结构）；R1 吞并代价表用真值复核无误 |
| C4 | 吞并 = 阶段 1/2 跳过 | 还须让 `pointContext`（植被）当它不存在，否则被吞并的冰山处长悬空雪桦树（60 seed 里 46 个） |
| C5 | ring「12 层岩石基底 + 台阶钳制」 | 欠规格 → 给出填方 / 挖方 / 水域转陆地（clay 补实，不得清成 air）/ 表层取 biome 的构造与可证明高差界 |
| C6 | `redCity` 经 `layoutsForColumn` 就够 | 必须 `_requiredKeys = 3×3 ∪ {(0,0)}` + 全局下发（60/80 seed 越过 x=799） |
| C7 | 产物缺失时降级 | 三种情形：未注入→降级（warn 一次）；尺寸不符→抛错；fetch 失败→启动失败（loud） |
| C8 | 出生点 `x/z` 取整数格、`scanDown` 返回 y+1 | `x/z` 取方块中心（+0.5）；`scanDownForSpawn` 返回脚所在 y；不用 `findSpawnY` |
| C9 | 清库写错会「白屏无报错」 | 真实失败形态是 `open()` AbortError reject；`onblocked` 必须接 UI |
| C10 | 隐含依赖 >5 处再加 `?spawn=city` | 全量回归实测远超 5 处，直接加；**12 个既有 spec + bench** pin |
| C11 | `DY_MAX_BUDGET` / `BASE_Y_MAX` 放 `tools/` | `src/` 不能 import `tools/` → 常量全部归位 `region-config.js` |
| C12 | 烘焙核心用浏览器内单测 | 静态服务器对 `.mjs` 回 octet-stream，浏览器 import 不了 → Node-only Playwright spec |
| C13 | `check:data` 6~8 条断言 | 补出 8 条产物自洽断言 + 加载器 5 类校验；16 项篡改 / 漂移负向验证 |
| C14 | 对照实验「影响域外逐位相同」 | 撒布候选最大半宽 24 → 对照带宽 ≥ 32 格 |
| C15 | 预算 spec「冲刺 ≤100%」+ W 键奔跑 | W 键奔跑被塔挡住 → 无碰撞飞越 + ≤95% + 多 seed |
| C16 | bench 场景不含 RedCity | 走廊 z=-100 距影响域北缘 49 格，RedCity 北部约 90 格落在 vd=8 半径内 → 场景变了但仍在门内（R13） |
| C17 | 每个任务结束 commit | 与仓库「提交必须等用户明确指令」冲突 → 计划里的 Commit 步骤仅在授权后执行 |
| C18 | 冻结口径「单块放/挖 p95 < 2 ms」在新出生点依然成立 | **不成立**（R15）→ 用户裁定选 A（§3.5） |

### B. 相对 mc-lite 的有意偏离（RedCity 本身无上游对应）

1. **玻璃板（53,615 块）与楼梯 / 半砖（约 9.2k 块）按整格方块处理**——mc-heavy 没有薄板 / 半砖几何。
2. **吞并是「整体吞并」**（与影响域相交的地标整体当作不存在），不是 City 那样按 bounds 裁切——避免半个冰山 / 半座金字塔留在 RedCity 脚下。
3. **屋顶 `168:2 → oxidized_cut_copper`（U2）**：接受偏亮的青绿（实测 RGB(58,196,169)），不新增贴图、不做真实 1.12 色值校准；颜色门禁只留关系式（R<B<G）。
4. **粉色玻璃 `95:6 → glass_block`（U3）**，而不是 `pink_wool`——空间角色不变（仍是树冠，不参与刚性平移）。
5. **撒布对 RedCity 影响域做整体丢弃**——mc-lite / 本仓对 City bounds 都没有这层过滤（R6），RedCity 的过滤自写，**不替 City 补**。

---

## §5 负向验证清单

每项注入前断言锚点恰好匹配 1 处、注入后读回确认落地，验证后还原（还原用 `cp` 备份而非 `git checkout`——工作区里有未提交改动，见 CLAUDE.md 与 `docs/roadmap.md` v1.67 行记录过的操作失误）。

| Task | 项数 | 内容（摘要） | 在哪验证 |
|---|---|---|---|
| 1 | 3 | 加载器不校验 col 越界 / dy 越界 / 乱序等 | 模拟树 |
| 2 | 11 | 地面取「每列最高 skin」/ 保留 K+1 层 / **逐列平移（严格 I5 注入后 504，旧 I5 反而 84→0）** / 贴边保护失效 / 外推不衰减 / 出生点不查净空·贴墙 / 粉玻璃回退 / 删 I2 / 清单混入·缺 clay | 模拟树 |
| 3 | 4 | 落点 / baseY 钳制 / influence / 出生点纯函数 | 模拟树 |
| 4 | 8 | 环公式 / 列整形（填 / 挖 / 水域补实 / `s==n` 不动）/ 外包范围暴力扫描 / `surfaceBlocksOfBiome` | 模拟树 |
| 5 | 3 | 门控少 (0,0) / payload 不带 redCity / handler 不走同一条 parse | 模拟树 |
| 6 | 7 | core 少一层 / **放置公式多叠 `ground`** / 不写烘焙内容 / 撒布过滤删除 / 降级改抛错 / 尺寸校验去掉 | 模拟树 |
| 7 | 7 | `pointContext` 不跳过被吞并地标 / 删 RedCity 避让分支 / 避让距离改 0 / 阶段 1 不跳过被吞并的金字塔 / ring 不写次表层 / ring 植被落点用自然高度 | 模拟树 |
| 8 | 1 | 断言改回 150 MiB → 必红 | 模拟树 **+ 真实仓库** |
| 9 | 19 | E2E 10（不 broadcast / 漏 `res.ok` / payload 不带 redCity / `?spawn=city` 被忽略 / DB 不清库·版本回 2 / 坑① 坑② / 漏 `onblocked` / 放置公式多叠 `ground`）+ 预算 3 + 水面门控单测 1 + **R15 观测 5**（门限改回 2.0 / 误 pin / 放 air / 不重建 / 挖除 no-op） | 模拟树（R15 观测 5 项含一次盲区修复，见 §8） |
| 10 | 16 | 配置漂移 3（屋顶映射 / `REDCITY_SIZE.X` / 樱花粉）+ 产物篡改 13（边界 ground 非零 / 出生点 dy / palette 越界·外名 / 乱序·降序·重复 / 少三元组 / col·dy 越界 / ground 与 blocks 脱节…） | 模拟树 **+ 真实仓库**（16/16） |
| 11 | 4 | palette 里屋顶 / 粉羊毛 / 玻璃被换 + `game.js` 漏接 `ocean.setRedCityBounds` | 模拟树 **+ 真实仓库**（4/4） |
| 合计 | **83** | | |

**如实说明**：真实仓库里重做了 Task 8（1）、Task 10（16）、Task 11（4）共 21 项；其余 62 项在模拟树做过。
我核对了真实仓库中被 RedCity 改动或新增的 **54 个非文档文件与模拟树逐字节相同**（sha256），测试是确定性的，所以沿用模拟树的结论；但这是「同一份字节 + 同一台机器」的推论，不是真实仓库里的亲手重做。

---

## §6 文档同步（CLAUDE.md 硬规则的三类文档）

| 文档 | 同步内容 |
|---|---|
| `docs/phase-1-engine-design.md` | 版本 v1.65 → **v1.68**；修订说明（RedCity 地标的三项架构口径变更 + 存档 + 出生点 / R15）；§4.2 RedCity 条目；§4.8 DB v3；§4.10 GPU 预算行（**明确取代 v1.42 的 148.06 MiB 口径**）；§5 目录结构 |
| `docs/roadmap.md` | 里程碑总表 RedCity 行 / 「一句话现状」段 / 「活跃约束详情 · RedCity（v1.68）」 / 「去哪找细节」表 |
| `CLAUDE.md`（= `AGENTS.md`） | 现状声明 / 目录结构（tools、assets、gen、docs）/ 开发命令 `npm run redcity` / 新小节「RedCity 沉淀的活跃约束」 |
| `docs/testing-policy.md` | §2.7 追加第 14 / 15 / 16 类（监控指标在缺陷出现时读数反而更好 / Tier 2 数据门禁自身也要做篡改注入 / 「改动了世界」的计数不能看被测 API 的返回值） |
| 规格 / 计划 / 附录 | 规格 v1.2（§14）、计划 Task 0~11、附录 A~E 注释订正（I6 删除、严格 I5/I5′）、附录 F 参考实现 |

---

## §7 遗留项

1. **R10 cutout 余量 7.4%**（seed 12345 东南角 92.6%，自然森林驱动）；**R9 transparent 余量 17%**（seed 777）：后续给 RedCity 加任何 water / glass 前必须重测预算。
2. **`docs/roadmap.md` 既有缺陷**：出生点移出 City 后，City 周边（约 400 格外）的玩家改动重启后不持久（规格 §13.6.3）——建议另立项（Tier 1，改 GEN 下发协议 / 时序）。
3. **R6 撒布不过滤 City bounds**（既有现象，本期不修）：City 侧建议另行评估。
4. **R12 塔座岩丘 1:1 保留**（极差中位 8、最大 40）：与源模型一致，接受。
5. **R13 bench 走廊**：`z=-100` 距影响域北缘 49 格，RedCity 北部落在 vd=8 半径内；`--check` 通过，但冻结基线与新场景不严格同构，下次重标基线时应一并评估（本期不重标）。
6. **R1 吞并代价**：几乎每个世界东侧的金字塔与冰山都会消失（设计如此，用户选址时选了吞并）。
7. **R15 的将来**：若 mesher 快速路径变快、`redcity-edit-perf` 的「门限改回 2.0 必须红」不再红，说明 R15 裁定与两个 pin 可以重新评估；若要真优化 mesher 快速路径，是独立 Epic（Tier 1）。
8. **阈值标定都来自本机（macOS ARM / Metal）单机抽样**：预算（4 个 seed × 6 路线）、像素阈值、`redcity-edit-perf` 的 3.5 ms 都没在 Linux CI（SwiftShader）上重标。
9. **没有人眼验证**：本环境「截图的 `Read` 只返回 URL、不渲染成图像」，所有视觉结论都是像素级 / DOM 几何实测（§3.4），没有宣称目视。
10. **`bench --check` 对结构类指标不设防（既有缺陷，本期不修）**：`compareWithBaseline` 里 `STRUCTURAL`（`drawCalls` / `sections` / `voxelBytes` / `gpuVertexBytes`）的判定分支恒为 false，注释写的「结构类 2%」不生效（§3.6 有实证：draw 比冻结基线高 2.6~3.6% 仍通过）。建议另立项：让该集合真正生效，并同时重标冻结基线（天空树 / RedCity 等已让 draw 高于基线）；重标属于放宽冻结口径，须用户批准。在那之前 GPU 预算只由 `m3-fullscene` 与 `redcity-budget` 守。

---

## §8 操作失误记录（如实）

### 设计 / 计划审阅阶段

1. **初版规格 / 计划里有多处说法与现实不符**（规格 §14.1 的 C1~C18）——最大一处是方案 A 的预算：Node 侧原型估算偏低，真实页面里被证伪。**根因是写计划时没有在真实页面里按序执行**，评审阶段才补上。
2. **我在审阅中说错一句**：「R1 表的海岛 19 是按 39 算的」——错，海岛外包真值是 25，R1 表本来就对。已在规格 §14.4 订正。
3. **我在审阅中给出过后来被实测推翻的数字**：方案 A「99.3% / 253 MiB」「加载集合更大（~441 列）」——实测加载集合是 289 列，W 键奔跑峰值 98.9% 无扩容，12 s 无碰撞飞越 106.6% 才触发扩容。
4. **模拟中的篡改测试初版是 no-op**（改到了岛外格 / `blocks[0]==blocks[3]`），「全红」是假象；重做后才暴露 `check:data` 的 4 个盲区（同列 dy 降序 / palette 下标越界 / 三元组丢失 / ground 与 blocks 脱节）。
5. **Worker 接线 E2E 初版断言「出生列方块数 > 10」**，实测出生列只有 2 块（出生点要求头顶 24 格空）；改为「出生列 ≥1 块 + 另挑 3 根 ≥20 块的高柱」。
6. **`scanDownForSpawn` 的变异（漏掉第二格空气）初版没被抓住**，补了「1 格间隙」断言。
7. **Task 6 的 GREEN 判据初版混入依赖后续 Task 的用例**（植被阶段）→ 拆成 `test-redcity-apply.js` / `test-redcity-gen-full.js`，各自有干净的 RED→GREEN。
8. **计划依赖倒置**：烘焙脚本 import 后面任务才写的加载器；`CAPACITY` 与装配的先后会让既有 spec 当场变红 → 重排 Task。
9. **参考实现带着来源性头注释**（「附录 X」「评审会话…不入库」）与孤立 docblock → 重写；README 里的 worktree 片段写错（相对路径 / 新文件）→ 换成 `helpers/replay-check.mjs`。

### 回放与落地阶段

10. **把本地 `playwright --list` 的 185 当成 HEAD 用例数**——其实含 3 条被 `.gitignore` 忽略的临时探针，干净 HEAD 是 182；已订正（规格 §14.8、本报告 §3.2）。
11. **最终全量回归第一次是 209 / 2**：`zombies` 互斥用例 0.397 < 0.4 贴线红。我没有当 flaky 放过，做了同源探针交替对照（City 出生点中位 0.574 vs RedCity 0.416），确认是**系统性下移**，补了第 12 个 pin；另一条 `m3-2-orientation:283` 交替对照 H 0/40 vs R 2/40（Fisher p≈0.49）按 HEAD 既有 flake 处理。
12. **R15 观测用例第一版用 `world.setBlock` 的返回值计数「改动了世界」**：负向验证 N3（把放置的方块换成 air）**照样通过**——`setBlock` 不做 no-op 检测。是负向验证本身发现的盲区，改为对比写入前后的方块 id 后才真红；沉淀为 testing-policy §2.7 第 16 类。
13. **我一度给该观测用例写了「耗时必须 ≥ 2 ms」的永久下界断言**——性能变好时让测试变红是反模式，已删除，判别力改由作者期负向验证承担。
14. **单测标题里残留旧版计划的 `T1/T2/T3/T5/T6/T8` 前缀**，与现在的 Task 编号冲突（`T8 阶段 2.9 放置` 读起来像 Task 8）→ 统一清掉（12 个文件里的 33 处 + 1 处 `T5/I4`）。
15. **设计文档 §4.10 我一度写了一句「稳态 reserved 比旧容量下的 City 高约 20%」**——没有实测依据（那个 +23% 是相对 Node 侧估算的，不是相对 City 的），写入后自查删除。
16. **验证记录里 bench 帧 p95 最初只写了「9.0~9.2」**（一次实测）；后两次是 9.9 / 10.0，场景 ④ 的门限只有 9.9，是贴线通过。已订正为三次实测范围 + 贴线说明。
17. **小流程失误**：zsh 把 `echo =====` 当命令；前台 `sleep` 被拦；两次中途杀掉模拟并手动清理遗留的 Playwright chromium 进程。
