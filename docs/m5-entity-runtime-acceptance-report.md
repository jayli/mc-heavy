# M5 实体运行时验收报告

> **状态：** 已实施（2026-09-07）
> **规格：** `docs/superpowers/specs/2026-08-23-m5-entity-runtime-design.md`
> **计划：** `docs/superpowers/plans/2026-08-23-m5-entity-runtime.md`
> **基线参照：** `docs/m3-baseline.md`（M3 冻结基线，只参照不修改其阈值）

## 1. 环境

| 项 | 值 |
|---|---|
| 日期 | 2026-09-07 |
| 设备 | macOS ARM（本机设备矩阵，硬验收口径） |
| WebGPU adapter | apple / metal-3（`channel:'chromium'` 零 flag） |
| 浏览器 | Playwright 1.62.1 / Chromium 151（headless，真 GPU） |
| Node | v26.4.0 |
| three | r185.1（本地 `vendor/three/`） |
| 视距 | 8（289 column，稳态性能 case）；2（功能/卸载 case，加速） |

## 2. 验收项对照（M5 规格 §4）

每条验收都有对应断言，且**做了负向验证**（注入缺陷确认测试真的 FAIL —— 否则断言可能恒真）。

| 验收项 | 断言落点 | 负向验证 |
|---|---|---|
| 同 id 不能重复 spawn | `test-entity-manager.js`「唯一 id」 | 重复 id → spawn 返回 null |
| 类型未注册/无效 snapshot/已销毁实体不产生副作用 | 同上「未注册类型与非法 state」 | 改 spawn 跳过校验 → FAIL |
| Probe 可 spawn、按 AABB 被 raycast | 同上「最近 AABB」+「AABB 未命中/超距/predicate」 | 命中距离从 `PROBE_AABB` 派生（关系型断言，非硬编码 2.7）；slab 返回出射距离而非进入距离 → FAIL（`Expected 2.7, got 3.3`） |
| 地形命中仍由 `raycastVoxel()` 决定 | `EntityManager.raycast` 不读 world/mesh | `rg` 静态边界 + check:arch |
| 迟到 `{id,generation}` 不改已 despawn / 同 id 后续实例 | 同上「generation 拒绝迟到结果」 | despawn 后重置计数 → FAIL（见下） |
| 保存期间不越过删除边界 | `entities.spec.mjs`「保存 gate 期间」 | 退回同步删除 → 5 用例 FAIL |
| 保存期间重入取消并恢复持久 probe | 同上「保存未结束重入」 | 同上 |
| 保存失败保留 column | 同上「写盘失败」 | 同上 |
| 最终卸载后持久 probe 恰恢复一次 | 同上「卸载后重入」 | 恢复成临时实体 → FAIL |
| `dispose()` 后 scene 无节点 / layer 无活动 instance / 无悬挂 snapshot | 同上「dispose 对称」 | 去掉差集回收 → 节点泄漏 FAIL |
| 视距 8 空闲相对 M3 基线回退 ≤10% | 同上「视距 8 稳态」+ `bench --check` | — |

## 3. 负向验证实测（Tier 1 必需环节）

竞态/协议类断言必须钉在**同步可观测的内存状态**上，且每条都注入缺陷确认真 FAIL
（`docs/testing-policy.md` §2.4：端到端断言会让缺陷静默逃逸）。本次实测的注入路径：

| 注入缺陷 | 预期 FAIL | 实测 |
|---|---|---|
| `despawn` 重置 generation 计数 | generation 单调性破坏 | ✅ FAIL（`Expected true, got false`） |
| `generation` 恒置 1（不递增） | 旧回包被判有效 | ✅ FAIL |
| `despawnColumn` 去掉 persistent 门控 | 持久实体被误删 | ✅ FAIL（`Expected 1, got 2`） |
| Scheduler 退回同步删除（不两阶段） | 保存期间删除 column | ✅ 5 用例 FAIL |
| `commit()` 漏回收临时实体 | 卸载后临时实体残留 | ✅ 2 用例 FAIL |
| `restorePersistent` 恢复成临时实体 | 下次卸载不写盘 → 永久丢失 | ✅ FAIL（harness + spec 双侧） |
| `saveEntities` 改 clear+write（整库替换） | 抹掉其它 column 的持久实体 | ✅ FAIL（`storedIds` 只剩后写的一批） |
| `sync` 去掉差集回收 | 节点泄漏（scene 节点数 > 实体数） | ✅ 2 用例 FAIL |
| `applyPose` 回写 state（drift） | 渲染层污染唯一权威 | ✅ 2 用例 FAIL |

`check:arch` 静态门的负向验证（门禁脚本自身属 Tier 1，`testing-policy.md` §9）：

| 注入 | 预期 | 实测 |
|---|---|---|
| `src/entities/**` import three | 红线 8/10 拦 | ✅ FAIL（「且头部声明了同构 → 自我矛盾」） |
| `src/entities/**` `new Worker` | 红线 3 拦 | ✅ FAIL（「须经既有 WorkerPool RPC」） |

## 4. DB v1→v2 升级路径

一次性验证（造 v1 库写 meta/edits → 升级到 v2 → 读回）：

| 项 | 实测 |
|---|---|
| v1 store 集合 | `['edits','meta']` |
| v2 store 集合 | `['edits','entities','meta']`（entities 幂等创建） |
| 升级后 meta.seed | 999（保留） |
| 升级后 edits 条目 | 1（保留） |
| 升级后 entities 计数 | 0（新建为空） |

`onupgradeneeded` 用「不存在才创建」的幂等写法 —— 老存档升级到 v2 不丢 meta/edits。

## 5. 门禁命令输出

| 命令 | 结果 |
|---|---|
| `npm run check`（arch+data+lint） | 通过（arch 扫描 63 源文件；data 8 项；lint 0 error / 9 既有 camelcase warning） |
| `npm test`（全量） | 见 §6 |
| `npm run lint` | 0 error |
| `git diff --check` | 通过 |
| `rg "from 'three'\|new Worker" src/entities` | 无命中 |
| `npm run bench -- --check` | 见 §7 |

## 6. 全量 E2E

`npm test`（67 spec）：**66 passed / 1 failed**。唯一失败是 `m1-acceptance` 的
`frameMs.p95 < 16.7`（Received 16.700000762939453）—— CLAUDE.md 记录的**已知 flaky**
（120Hz vsync 锁帧下 frameMs.p95 量化为 16.66，上浮贴线；该断言数学上恒在边界抖动）。
真正的 M1 冻结硬约束 `placeP95/digP95 < 2ms` **稳定通过**。

按 `testing-policy.md` §2.3 做**交替对照**（改动侧 3 次 → `git stash` 到 HEAD → HEAD 侧 3 次）：

| 指标 | 改动侧（3 次） | HEAD 侧（3 次） |
|---|---|---|
| placeP95 | 1.8 / 1.8 / 1.8 | 1.8 / 2.1 / 1.7 |
| digP95 | 1.6 / 1.7 / 1.8 | 2.1 / 2.1 / 1.8 |
| 失败次数 | 1/3（frameMs.p95=16.7） | **2/3**（编辑 p95=2.1 贴线） |

- 两侧编辑 p95 分布完全重合，改动侧甚至更低（从未触及 2.0 线）；
- **HEAD 侧失败率反而更高**，且失败的是真正的编辑硬约束而非 vsync 二级门 ——
  与 v1.29 交替对照结论同构（单看全量跑会得出「改动侧更差」的相反结论）。

结论：失败是 vsync 量化 + 编辑 p95 贴线的既有 flaky，机制上与 M5 无关
（M5 的 entities.update / entityLayer.sync 在无实体时近 no-op，编辑热路径零命中实体代码）。
M5 新增的 `tests/entities.spec.mjs`（11 用例）与 `test-entity-manager.js`（13 用例）全绿。

## 7. 相对 M3 冻结基线（`npm run bench -- --check`）

```
[bench] gpu: apple/metal-3
[bench] ① 平原冲刺:        fps=120.02 p95=9.2  draw=489 (42s)
[bench] ② 城市中心环视:     fps=120.01 p95=9.1  draw=545 (9s)
[bench] ③ 连续放/挖 200 块: fps=111.43 p95=16.6 draw=545 (7s)
[bench] ④ 模拟 TNT 批量删:  fps=120.04 p95=9.1  draw=526 (5s)
[bench] --check 通过（无显著回退），退出码 0
```

对照 M3 基线（`docs/m3-baseline.md`）：

| 场景 | M5 实测 fps | M3 基线 fps | 回退 |
|---|---:|---:|---:|
| ① 平原冲刺 | 120.02 | 120.02 | 0% |
| ② 城市中心环视 | 120.01 | 120.00 | ~0% |
| ③ 连续放/挖 200 块 | 111.43 | 108.33 | **更快**（无回退） |
| ④ 模拟 TNT 批量删 | 120.04 | 119.28 | ~0% |

四场景 fps/p95/draw 与 M3 基线持平或更优，**无回退 >10%**（阻断线）。
M5 的实体运行时（manager.update / renderLayer.sync）在视距 8 稳态、无实体时近 no-op，
未触及体素 meshing / 光照 / 调度热路径，故 M3 冻结基线不受影响。

## 8. 交付清单

- **实体运行时**（`src/entities/`）：`entity-manager.js`（唯一 state 权威 + generation +
  派生 column 索引 + AABB raycast + 两阶段卸载）/ `entity-types.js`（probe 定义 + AABB slab
  射线 + state 校验，无 three）。
- **受控渲染层**（`src/render/entity-render-layer.js`）：只读 pose 发布；probe 节点 = 受控
  `THREE.Group`（fixture）；不回写 state、不调 setBlock、不作命中真相。
- **持久化**（`src/save/persistence.js`）：DB v2 `entities` store；`saveEntities`（upsert）/
  `loadEntities`/`flushEntities`/`entitiesForColumn`/`clearAllEntities`；`entitiesCache`
  同步恢复源。
- **调度**（`src/core/scheduler.js`）：两阶段卸载（`onColumnUnloadRequested`/`onColumnWillRemove`）
  + `_pendingColumnUnloads`（只登记 key/handle，不复制体素数据）+ `stats().pendingUnloads`/
  `lastUnloadError` 只读诊断。
- **装配**（`src/core/game.js`）：帧序 `player → entities.update → scheduler → entityLayer.sync
  → render`；卸载请求接 `beginColumnUnload` + `saveEntities`；column ready 恢复持久 snapshot；
  `_discardEdits` 一并回收持久实体（防 beforeunload 写回竞态 + 换 seed 泄漏）。
- **几何推导唯一权威**（`src/voxel/constants.js`）：新增 `columnKeyAt(x,z)` —— 实体派生索引
  与 snapshot column 归属共用同一份判据（红线 1）。
- **静态门扩充**（`tools/check-architecture.mjs`）：`src/entities` 纳入同构目录受检 +
  新增「Worker 创建入口唯一」检查（`WORKER_EXEMPT` 白名单只含 `worker-pool.js`）。

## 9. 边界与后续

- M5 **不创建任何具体玩法实体**（丧尸/弹丸/矿车/巢穴）；probe 仅为 render contract fixture
  与单测载体。M6 丧尸注册自己的 definition + 实例渲染器，不复用 per-entity Group。
- M5 **不新建 Worker**；M6 的 AI 经既有 `WorkerPool` 的统一 RPC 接入（红线 3）。
- 方块锚定装置的结构与持久配置仍归 `blockEntities`；实体管理器只持有由锚点重建的运行时
  controller，不复制方块状态（M7 丧尸巢穴的接入点）。
