# 附录 F：RedCity 参考实现（落地形态，冻结快照）

> 本目录是 `docs/superpowers/plans/2026-10-22-redcity.md` 的**机械落地材料**：新文件 `cp`，既有文件 `git apply`。
> 它是**冻结快照**——落地后以 `src/` / `tools/` / `tests/` 为准，不要两处同时改（同一事实的多个副本会漂移）。
> 附录 A~E（`../appendix-{a..e}-*.mjs`）仍是算法的**独立可复现参考**（`node appendix-X.mjs` 复现全部数字）；
> 本目录的 `tools/` 是它们在仓库里的最终样子（常量归位到 `region-config.js`、导入路径改仓库风格、严格 I5）。

## 目录

```
appendix-f-reference/
├─ README.md
├─ manifest.json               # 阶段顺序 + 每阶段的新文件 / 补丁（replay-check 读它）
├─ helpers/run-unit.mjs        # 可选：跑浏览器内单测页并打印失败项 / 总数（只读辅助，不入构建链）
├─ helpers/replay-check.mjs    # 可选：在临时目录按序套补丁，验证快照还能落到当前 HEAD
├─ patches/tNN-<阶段>.diff     # 对既有文件的改动（git apply；HEAD f07703e 上按序生成）
├─ src/…  tools/…  tests/…     # 新文件（路径与落地路径一致）
```

阶段名：`red` = 测试与登记 · `green` = 实现 · `pins` = 既有 spec / bench 的 `spawn=city` pin · `budget` = 预算门禁。

## 用法

```bash
REF=docs/superpowers/specs/2026-10-22-redcity-appendix/appendix-f-reference
cp $REF/src/gen/structures/redcity-data.js src/gen/structures/redcity-data.js   # 新文件
git apply $REF/patches/t01-green.diff                                            # 既有文件的改动
```

`git apply --check` 在 HEAD `f07703e` 上逐个通过。HEAD 前进导致失配时按补丁内容手改（每块带 3 行上下文）；**不要为了让补丁套上去而改测试的断言**。

**阶段的应用顺序**（`新文件数 / 补丁`；T = Task）：

- `t01-red`：新文件 1 个；补丁 1 个文件（`src/tests/index.html`）
- `t01-green`：新文件 1 个；补丁 1 个文件（`src/gen/structures/region-config.js`）
- `t02-red`：新文件 1 个
- `t02-green`：新文件 5 个；补丁 1 个文件（`package.json`）
- `t03-red`：新文件 1 个；补丁 1 个文件（`src/tests/index.html`）
- `t03-green`：新文件 1 个
- `t04-red`：新文件 1 个；补丁 1 个文件（`src/tests/index.html`）
- `t04-green`：新文件 1 个；补丁 2 个文件（`src/gen/structures/landmarks.js`、`src/gen/terrain.js`）
- `t05-red`：新文件 1 个；补丁 2 个文件（`src/tests/index.html`、`src/tests/test-structure-layout.js`）
- `t05-green`：新文件 0 个；补丁 4 个文件（`src/core/scheduler.js`、`src/gen/structure-index.js`、`src/gen/structures/structure-layout.js`、`src/workers/world-worker.js`）
- `t06-red`：新文件 1 个；补丁 1 个文件（`src/tests/index.html`）
- `t06-green`：新文件 0 个；补丁 1 个文件（`src/gen/structures/apply.js`）
- `t07-red`：新文件 2 个；补丁 1 个文件（`src/tests/index.html`）
- `t07-green`：新文件 0 个；补丁 1 个文件（`src/gen/structures/apply.js`）
- `t08-red`：新文件 0 个；补丁 1 个文件（`tests/m3-fullscene.spec.mjs`）
- `t08-green`：新文件 0 个；补丁 1 个文件（`src/render/render-world.js`）
- `t09-red`：新文件 1 个；补丁 1 个文件（`src/tests/test-ocean-mask.js`）
- `t09-green`：新文件 0 个；补丁 5 个文件（`src/core/game.js`、`src/main.js`、`src/render/ocean-mask.js`、`src/render/ocean.js`、`src/save/persistence.js`）
- `t09-pins`：新文件 0 个；补丁 13 个文件（`src/bench/baseline.mjs`、`tests/city-visual.spec.mjs`、`tests/crosshair.spec.mjs`、`tests/light-house.spec.mjs`、`tests/light-structures.spec.mjs`、`tests/m1-acceptance.spec.mjs`、`tests/m3-hud.spec.mjs`、`tests/projectiles.spec.mjs`、`tests/sky-structures.spec.mjs`、`tests/tnt.spec.mjs`、`tests/turrets.spec.mjs`、`tests/weapons-world-edit.spec.mjs`、`tests/zombies.spec.mjs`）
- `t09-budget`：新文件 2 个
- `t10-green`：新文件 0 个；补丁 1 个文件（`tools/check-data.mjs`）
- `t11-green`：新文件 1 个

可选：验证补丁还能按序套上**当前** HEAD（在临时目录里做，不动你的工作区；HEAD 前进导致失配时会指出是哪个阶段）：

```bash
node $REF/helpers/replay-check.mjs
```

## 本快照的验证记录

本快照由**模拟执行**产出：从 HEAD `f07703e` 的干净副本出发，按计划逐 Task 落地，每个 Task 都跑了 RED → GREEN → 负向验证 → `npm run check`（`check:arch` + `check:data` + `lint` 0 error，RedCity 新文件 0 警告）。

| Task | 内容 | RED（实测） | GREEN（实测） | 负向验证（全部真 FAIL） |
|---|---|---|---|---|
| 1 | region-config 常量 + redcity-data 加载器 | 页面因缺模块中止（`__MC_TEST_RESULTS__` 不出现） | 单测总数 784（失败 0） | 3 项 |
| 2 | 烘焙脚本、产物与 Node-only spec | spec 缺 `tools/*.mjs`，Node 侧 import 失败 | Node-only spec 12 passed；重烘产物只差 `bakedAt`，二次重烘字节一致 | 11 项 |
| 3 | redcity-layout（落点 / baseY / influence / 分区 / 出生点纯函数） | 页面因缺模块中止（`__MC_TEST_RESULTS__` 不出现） | 单测总数 792（失败 0） | 4 项 |
| 4 | redcity-surface + landmarkHalfExtent + surfaceBlocksOfBiome | 页面因缺模块中止（`__MC_TEST_RESULTS__` 不出现） | 单测总数 802（失败 0） | 8 项 |
| 5 | redCity 全局下发 + Worker 注入 | 5 条失败 | 单测总数 806（失败 0） | 3 项 |
| 6 | apply.js 阶段 1 整形 / 吞并 / 撒布过滤 / 阶段 2.9（不碰 pointContext） | 5 条失败 | 单测总数 811（失败 0） | 7 项 |
| 7 | pointContext（吞并的植被上下文 + core⊕3 避让 + ring 落点） | 6 条失败 | 单测总数 819（失败 0） | 7 项 |
| 8 | CAPACITY 重标定（U1′）+ m3-fullscene 预算断言 | — （Tier 4 门禁：先证明改断言是有意的） | `m3-fullscene` 通过，`gpuVertexBytes = 205,050,000 B`（195.55 MiB） | 1 项 |
| 9 | 装配（game / main / ocean / persistence）+ 既有 spec / bench pin + E2E + 预算 spec | 单测 1 条失败；E2E 6/9 条失败 | 单测 822；E2E 9 passed；预算 4 passed；12 个既有 spec 加 pin 后转绿 | 19 项 |
| 10 | check:data [RedCity] 门禁 | `check:data` 输出里没有 `[RedCity]` 行 | `[RedCity] … 指纹 a9f0be96c3d4ebaa 匹配 …` 行出现 | 16 项 |
| 11 | Tier 4 像素实测 | — | 视觉 spec 4 passed | 4 项 |

负向验证合计 **83 项**，每项注入前断言锚点恰好匹配 1 处、注入后读回确认落地，验证后还原。

单测总数（浏览器内单测页的 `total`）：HEAD 779 → Task 1 784 → Task 3 792 → Task 4 802 → Task 5 806 → Task 6 811 → Task 7 819 → Task 9 822。

Playwright 用例数（`npx playwright test --list`，干净 `git archive HEAD` 导出，排除被 `.gitignore` 忽略的 `tests/tmp-*` 探针）：HEAD 182 条 / 61 个文件 → 最终 212 条 / 66 个文件（+30：`redcity-bake` 12 / `redcity-e2e` 9 / `redcity-budget` 4 / `redcity-visual` 4 / `redcity-edit-perf` 1）。

**补丁回放**（只用本目录：`cp` 新文件 + `git apply` 补丁 + `npm run redcity`，不借助模拟树）：

```
  已落地 t01-red（新文件 1，补丁 有）
  已落地 t01-green（新文件 1，补丁 有）
  已落地 t02-red（新文件 1，补丁 无）
  已落地 t02-green（新文件 5，补丁 有）
  已落地 t03-red（新文件 1，补丁 有）
  已落地 t03-green（新文件 1，补丁 无）
  已落地 t04-red（新文件 1，补丁 有）
  已落地 t04-green（新文件 1，补丁 有）
  已落地 t05-red（新文件 1，补丁 有）
  已落地 t05-green（新文件 0，补丁 有）
  已落地 t06-red（新文件 1，补丁 有）
  已落地 t06-green（新文件 0，补丁 有）
  已落地 t07-red（新文件 2，补丁 有）
  已落地 t07-green（新文件 0，补丁 有）
  已落地 t08-red（新文件 0，补丁 有）
  已落地 t08-green（新文件 0，补丁 有）
  [t08] 全量回归：194 passed / 0 failed，耗时 11.9 min
  已落地 t09-red（新文件 1，补丁 有）
  已落地 t09-green（新文件 0，补丁 有）
  已落地 t09-pins（新文件 0，补丁 有）
  已落地 t09-budget（新文件 1，补丁 无）
  已落地 t10-green（新文件 0，补丁 有）
  已落地 t11-green（新文件 1，补丁 无）
回放树 vs 模拟树：逐文件一致（比对忽略两棵树各自的端口配置 playwright.config.mjs / server-script/start-server.js——两棵树跑在不同端口，避免与真实仓库的 8081 冲突）
  [t11] 全量回归：210 passed / 1 failed，耗时 13.6 min
     ✘ ✘  183 tests/weapons-world-edit.spec.mjs:23:1 › M4：200 次普通枪和 20 次 MAG7 破坏后版本与队列收敛
  [bench --check] 通过
     [bench] server 已启动 :8084
     [bench] gpu: apple/metal-3
     [bench] ① 平原冲刺: fps=119.98 p95=10 draw=500 (44s)
     [bench] ② 城市中心环视: fps=120 p95=9.9 draw=559 (11s)
     [bench] ③ 连续放/挖 200 块: fps=120 p95=9.8 draw=559 (8s)
     [bench] ④ 模拟 TNT 批量删 500 块: fps=120.01 p95=9.9 draw=545 (6s)
     [bench] --check 通过（无显著回退）
汇总：{"t11": 1}
```

**全量回归与交替对照**（干净 `git archive HEAD` 导出 182 条用例；回放时 RedCity 新增 29 条 = 211 条。⚠️ R15 观测用例 `redcity-edit-perf`（1 条，用户 2026-10-23 裁定选 A 后补入）**在回放之后才加**：单独重复跑 5 次（`placeP95` 2.4~2.5、`digP95` 2.4~2.7，均 < 3.5）并做过 5 项负向验证，合计 212 条；含它的全量回归以真实仓库落地时的那一次为准）：

| 检查点 | 结果 | 说明 |
|---|---|---|
| Task 8 之后（装配前，出生点仍在 City） | **194 passed / 0 failed**（11.9 min） | 182 + 烘焙 spec 12 |
| Task 11 之后 · 第一次回放 | 209 passed / 2 failed（13.7 min） | `m3-2-orientation:283` + `zombies:803`（0.397 < 0.4），见下 |
| Task 11 之后 · 第二次回放（已补 `zombies` pin） | **210 passed / 1 failed**（13.6 min） | 唯一红的是 `weapons-world-edit`（`pistolEffects` 199≠200，已知计时型 flaky），见下 |
| `bench --check`（两次） | 均通过 | ①②③④ draw 500 / 559 / 559 / 545；帧 p95 9.8~10.0（9↔10 的 vsync 量子边界；场景 ④ 门限仅 9.9，两次都是 9.9 贴线通过） |

三条红都**不是靠单次红绿下结论**，而是交替对照看分布：

- **`zombies` 互斥（0.397 < 0.4）→ RedCity 出生点造成的系统性下移，补 pin。** 同源探针（逐字复制该用例场景、只去掉断言、打印 `after`）在干净 HEAD 与回放树上交替各 6 轮：City 出生点 `min` = 0.574 / 0.586 / 0.526 / 0.570 / 0.575 / 0.600（中位 0.574），RedCity 出生点 = 0.420 / 0.410 / 0.412 / 0.424 / 0.361 / 0.496（中位 0.416，1 轮 < 0.4）。
- **`m3-2-orientation:283`（`meshInflight` 1≠0）→ HEAD 既有 flake，不 pin。** 隔离交替对照 40 轮：H 0 次、R 2 次，Fisher 精确检验 p≈0.49，差异不显著（CLAUDE.md 已记该断言在 HEAD 的频率约 2/30）。
- **`weapons-world-edit`（199≠200）→ 已知计时型 flaky，且在干净 HEAD 上同样复现。** 单独交替复跑 2 轮：回放树 2/2 通过，**干净 HEAD 1/2 红（同为 199）**。该用例已 pin `spawn=city`，场景与 HEAD 相同。

**真实仓库落地后**（2026-10-23，本快照的 54 个非文档文件与模拟树逐字节相同）：最终全量回归（含 `redcity-edit-perf`，212 条）**212 passed / 0 failed**（14.0 min）；`bench --check` 通过（p95 9 / 9.1 / 9 / 9.2，draw 500 / 559 / 559 / 545）。详见 `docs/redcity-acceptance-report.md` §3。


## 可选辅助：`helpers/run-unit.mjs`

仓库的浏览器内单测没有「只跑一个文件」的命令，`tests/harness.spec.mjs` 只报「`failed > 0`」。TDD 时想看**哪几条红、总数多少**，用：

```bash
node docs/superpowers/specs/2026-10-22-redcity-appendix/appendix-f-reference/helpers/run-unit.mjs 8081 60000 "RedCity"
```

参数：`<端口> <超时毫秒> [用例标题过滤正则]`。输出最后一行 `RESULT total=N passed=N failed=N`，或 `NO_RESULT`（页面没暴露结果——通常是某个 import 失败导致整页中止，即 RED 的「页面中止」形态）。
