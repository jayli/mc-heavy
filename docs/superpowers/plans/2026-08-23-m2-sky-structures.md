# M2-7 空中结构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在既有确定性 GEN 管线中实现悬浮空岛、单云层和连通云簇，并将其纳入 M2 关闭与 M3 性能基线。

**Architecture:** BlockRegistry 新增两种岛体方块及通用 `supportsPlayer` 查询表；StructureIndex 使用紧凑候选数组，Worker GEN 按“云先写、空岛后覆盖”的固定层序裁剪到当前 column。空中内容不创建 entity、不复制体素状态，也不使用 `structureCenters` 或运行期跨 chunk 补刷。

**Tech Stack:** ES2022 ESM、JSDoc、WorkerPool、typed array、Playwright、three.js r185.1（仅渲染既有体素通道）。

**Spec:** `docs/superpowers/specs/2026-08-23-m2-sky-structures-design.md`

## Global Constraints

- 遵循设计文档 §4.2：GEN/MESH/LIGHT 都在 Worker；主线程不得重算候选、岛体或云簇。
- 候选与方块必须只由 `(seed, region/chunk/world coordinate)` 推导；禁止 `Math.random`、`structureCenters`、跨 chunk 补刷与运行期实体容器。
- `blocks + meta + blockEntities` 仍是唯一权威；本任务不写 blockEntity、不创建空岛宝箱或天空树。
- 固定 salt：岛候选/底部 Y/半径/高度为 `+50/+51/+56/+57`；云簇候选/起点 X/起点 Z/大小/frontier 步为 `+52/+53/+54/+55/+58+step`。
- `src/gen/`、`src/mesh/`、`src/workers/` 不得 import three；所有异步回传继续使用 `(columnKey, version)` 丢弃协议。
- 先 RED、确认失败、最小 GREEN、再全量回归；性能数字不达标时停止报告，不改阈值或候选率。

---

### Task 1: 空岛方块、程序化材质与 atlas

**Files:**
- Modify: `src/voxel/blocks-data.js`
- Modify: `src/voxel/faces-data.js`
- Modify: `tools/bake-procedural-textures.mjs`
- Regenerate: `assets/textures/procedural/sky_stone.png`, `assets/textures/procedural/sky_grass.png`, `assets/atlas.png`, `assets/atlas.json`
- Modify: `src/tests/test-block-registry.js`, `src/tests/test-mesher.js`, `tests/atlas.spec.mjs`

**Interfaces:** Produces solid/opaque `sky_stone` and `sky_grass`, six-face mappings to `procedural/sky_stone` and `procedural/sky_grass`, registry count=126 and atlas tile count=147.

- [x] **Step 1: 写失败的方块、face 与 atlas 单测**

在 `test-block-registry.js` 断言两个 block ID 存在且 `solidTable/opaqueTable` 都为 1，将当前 124 改为 126。以两个孤立 cube 断言 mesher 发布六面及各自 tile；atlas fixture 由 145 改为 147，并断言两个 procedural 键。

- [x] **Step 2: 运行 RED 验证**

```bash
node server-script/start-server.js & SERVER_PID=$!; npx playwright test tests/harness.spec.mjs tests/atlas.spec.mjs; STATUS=$?; kill $SERVER_PID; exit $STATUS
```

Expected: 新 block、face 和 atlas tile 缺失，新增断言失败。

- [x] **Step 3: 最小实现并重建 atlas**

在 `blocks-data.js` 加入 `{name:'sky_stone',solid:true,cullMode:'opaque',orientationModes:0,geometry:'box'}` 与同构 `sky_grass`；在 `faces-data.js` 映射六面。烘焙脚本用既有 `bakeMat()` 生成 `#DDDDDD` 和 `#88CCFF` 噪点 PNG，再运行：

```bash
node tools/bake-procedural-textures.mjs
npm run atlas
```

同步更新所有 124 block/145 atlas fixture；不得新增运行时 canvas 或材质通道。

- [x] **Step 4: 运行 GREEN**

```bash
node server-script/start-server.js & SERVER_PID=$!; npx playwright test tests/harness.spec.mjs tests/atlas.spec.mjs tests/render-terrain.spec.mjs; STATUS=$?; kill $SERVER_PID; exit $STATUS
```

Expected: 126/147 断言全绿，新方块走既有 atlas/三通道。

### Task 2: 单云层、紧凑候选、固定 salt 与确定性层序 rasterize

**Files:**
- Create: `src/gen/structures/sky-structures.js`
- Modify: `src/gen/structures/structure-layout.js`, `src/gen/structures/apply.js`
- Create: `src/tests/test-sky-structures.js`
- Modify: `src/tests/test-structure-layout.js`, `src/tests/index.html`

**Interfaces:** Produces `computeSkyCandidates(regionX,regionZ,seed) -> {skyIslands:Int32Array,cloudClusters:Int32Array}` and `applySkyStructures(column,candidates,seed,registry)`; both arrays use stride 5.

- [x] **Step 1: 写失败的确定性、覆盖层序与跨 column 单测**

固定 `seed=12345`，断言两个候选数组均为 `Int32Array`、stride=5 且重复调用逐元素相等。先找一个 `noise(wx,wz,seed,0.03)>1.2` 的坐标，断言 `writeSingleCloudLayer()` 在 Y=55 写 `cloud`。扫描 `[-2,2]×[-2,2]` 找空岛，断言 `+50/+51` 的候选/Y 和 `+56/+57` 的半径/高度口径。生成中心列和横跨其 AABB 的邻列，重组成同一世界坐标集合，断言顶层 `sky_grass`、下层 `sky_stone`，且无 chest/sky tree。构造与 Y=55 相交的岛，断言最终是岛体而非 cloud；该断言必须先确认该格在空岛写入前为 cloud，禁止以“原本是 air”通过。

- [x] **Step 2: 运行 RED 验证**

```bash
node server-script/start-server.js & SERVER_PID=$!; npx playwright test tests/harness.spec.mjs; STATUS=$?; kill $SERVER_PID; exit $STATUS
```

Expected: 新模块、layout 字段和 `index.html` 注册均不存在，harness 失败而非静默跳过。

- [x] **Step 3: 实现候选与空岛层**

每 region 枚举 25×25 来源 chunk。`skyIslands` 记录 `[originCx,originCz,bottomY,radius,height]`，严格使用候选/Y/半径/高度 salt `+50/+51/+56/+57`；`cloudClusters` 记录 `[originCx,originCz,startX,startZ,size]`，严格使用 `+52/+53/+54/+55`，但本任务只产出云簇候选、不写云簇体素。实现 `writeSingleCloudLayer(column,seed,registry)`：严格按 `noise(wx,wz,seed,0.03)>1.2` 无条件写 Y=55 cloud。仅遍历 AABB 相交候选，空岛按 `floor(radius*(y/height)**.7)` 写圆内格；空中层固定调用仅含单云层的 `writeClouds()` 后 `writeIslands()`，二者都无条件写自身目标格，岛后写覆盖云。

- [x] **Step 4: 运行 GREEN 与边界回归**

```bash
node server-script/start-server.js & SERVER_PID=$!; npx playwright test tests/harness.spec.mjs tests/structure-gen.spec.mjs tests/worker-gen.spec.mjs; STATUS=$?; kill $SERVER_PID; exit $STATUS
```

Expected: 候选/方块稳定，边界列重组与“先确认为 cloud、后被 island 覆盖”的断言通过，既有 GEN 计时不回退。

### Task 3: 连通云簇、单向下落支撑与 DDA

**Files:**
- Modify: `src/gen/structures/sky-structures.js`, `src/voxel/blocks-data.js`, `src/voxel/block-registry.js`, `src/voxel/world-data.js`, `src/player/physics.js`
- Modify: `src/tests/test-block-registry.js`, `src/tests/test-physics.js`, `src/tests/test-raycast.js`, `src/tests/test-sky-structures.js`, `src/tests/index.html`

**Interfaces:** Produces `supportsPlayerTable[id]`, `registry.supportsPlayer(id)`, `world.supportsPlayer(x,y,z)` and cloud voxel generation; supportsPlayer affects only downward Y collision.

- [x] **Step 1: 写失败的云、物理与射线单测**

断言 Task 2 的单云公式仍精确为 `noise(wx,wz,seed,0.03)>1.2`、Y=55；新增断言云簇为 30..50 块且四邻接连通、跨 column 逐格一致。断言 cloud 是 non-solid/supportsPlayer。physics 分别断言：下落落在云上、上跳穿过头顶云、X/Z 穿侧面云、从云上对 solid 台阶仍走 `_tryStepUp()`；raycast 仍命中 cloud、仍跳过 water。

- [x] **Step 2: 运行 RED 验证**

```bash
node server-script/start-server.js & SERVER_PID=$!; npx playwright test tests/harness.spec.mjs tests/interaction.spec.mjs; STATUS=$?; kill $SERVER_PID; exit $STATUS
```

Expected: supportsPlayer 表/查询和云生成缺失，新增断言失败。

- [x] **Step 3: 最小实现**

所有 block 默认 `supportsPlayer:false`，仅 cloud=true；registry 填 `supportsPlayerTable`，WorldData 加坐标查询。令 `_collides(includeSupportsPlayer=false)` 只在 flag 为 true 时读 `isSolid || supportsPlayer`；`_moveAxis()` 仅在 `axis===1 && delta<0` 传 true，向上、X/Z、`_tryStepUp()` 保持 false。以 `seed+58+step` frontier 选点写 Y=35 连通云簇，并把 `writeCloudClusters()` 追加到 Task 2 已有的 `writeClouds()`：顺序必须是 Y=55 单云层、Y=35 云簇、空岛。mc-lite Cloud.js 的 20-40 注释过时，唯一口径为 30..50。不得修改 raycast.js。

- [x] **Step 4: 运行 GREEN、交互与光照回归**

```bash
node server-script/start-server.js & SERVER_PID=$!; npx playwright test tests/harness.spec.mjs tests/interaction.spec.mjs tests/light-arch.spec.mjs; STATUS=$?; kill $SERVER_PID; exit $STATUS
```

Expected: 云仅向下支撑、可从侧面/下方穿过、DDA 命中不变，不引入光照或交互回归。

### Task 4: 真实世界验收、M3 门与文档回填

**Files:**
- Create: `tests/sky-structures.spec.mjs`
- Modify: `tests/m1-acceptance.spec.mjs`, `docs/superpowers/plans/2026-08-20-phase1-remaining-roadmap.md`, `AGENTS.md`, `README.md`, `docs/phase-1-engine-design.md`

**Interfaces:** Consumes `window.__MC_GAME__`、Task 2 layout、Task 3 云语义、`perfSnapshot()` / `renderStats()`; produces repeatable browser acceptance and M3 baseline evidence.

- [x] **Step 1: 写失败的 Playwright 验收**

以 `/?vd=8` 等待 worldReady/队列收敛；从紧凑 layout 找最近空岛候选，传送并加载覆盖列。断言 island 的 sky 方块、无 chest/天空树、相交 Y=55 岛体内无 cloud；截图确认岛和云可见，记录 fps/p95/draw。m1-acceptance 等待已加载空岛/云层候选。

- [x] **Step 2: 运行 RED 验证**

```bash
node server-script/start-server.js & SERVER_PID=$!; npx playwright test tests/sky-structures.spec.mjs; STATUS=$?; kill $SERVER_PID; exit $STATUS
```

Expected: Task 1–3 前 layout、方块或云语义缺失，spec 失败。

- [x] **Step 3: 转绿并执行冻结性能门**

只增加读取现有 layout/column/队列的诊断；本机断言 fps≥90、p95<16.7ms，CI 沿用宽松门槛。若不达标，记录 8%/20%、126/147、fps/p95/draw 后停止，禁止降率或缩视距。

- [x] **Step 4: 完整验证与文档一致性回填**

```bash
node server-script/start-server.js & SERVER_PID=$!; npm test; STATUS=$?; npm run lint; LINT_STATUS=$?; git diff --check; DIFF_STATUS=$?; kill $SERVER_PID; test $STATUS -eq 0 && test $LINT_STATUS -eq 0 && test $DIFF_STATUS -eq 0
```

Expected: 全套 Playwright、lint、diff check 无错误。回填 M2 状态、126 block/147 atlas 与实际测试数；用 `npx playwright test --list` 分别记录 spec 文件数与 test 用例数（本任务前基线为 19 files/22 tests），浏览器单测也以 harness 实测值记录（本任务前为 114）。复核权威设计仍明确“仅 Y=55 为单云层、Y=35 为候选云簇”，并保持 AGENTS.md 和 README.md 的 v1.14 版本声明及测试统计与实测一致。仅获明确授权后提交。
