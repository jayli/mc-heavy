# 丛林要塞移植 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Repurposed Structures 的 `fortress_jungle` 离线拼成一个定版布局、烘焙成 palette 产物，生成在 City 西方第一个丛林地带（全世界唯一一处），全部用既有方块 + 藤蔓。

**Architecture:** 三段式，与废弃堡垒（v2.89）逐一同构：① `tools/` 离线 jigsaw 拼装器 + 烘焙 → `assets/structures/jungle_fortress.json`；② `src/gen/structures/` 落点搜索（纯函数）+ 地形整形（体素覆写）；③ `apply.js` 新阶段 2.95 光栅化 + `pointContext` 让路。运行期零随机拼装、零新增方块、零新增几何、零新增贴图。

**Tech Stack:** Node v26（烘焙，仅 playwright/eslint/pngjs 三个 devDependency）、原生 ES module、three r185.1 WebGPU（不碰）、Playwright（E2E）、浏览器内单测（`src/tests/`）。

**Spec:** `docs/superpowers/specs/2026-11-17-jungle-fortress-port-design.md`

> ⚠️ **本计划相对 spec 的两处用户裁定更新（2026-11-17，批准时追加）**：
> 1. **落点改为「City 西方第一个丛林地带」**（spec DR-6 原写「离 City 最近」）——
>    与废弃堡垒同为城西口径，方向判据固定，**不再是逐 seed 取最近方位**。
>    新锚点表见 Task 4，spec §2.9 的旧表作废。
> 2. **藤蔓纳入本期**（spec §6 原列为开放项）——新增 Task 3，
>    产物格数 80,031 → **81,238**、palette 11 → **12**、cutout 4.1% → **5.0%**。
>    spec §2.4 的无藤蔓冻结值仍保留为「基线」，Task 3 给出含藤蔓的最终值。
>
> 两处偏离已获用户接受：栏杆木色（非铁灰）、苔藓/台阶纹理是圆石（非砖）。

## Global Constraints

- 依赖方向单向 `voxel ← gen ← mesh ← render`；`core/` 可依赖任何层。
- `src/gen/**` / `src/voxel/**` / `src/mesh/**` / `src/workers/**` **不得 import three、不得自建 Worker、不得 fetch**（产物由 `apply.js` 的 `preloadStructures` 统一拉取）。
- `tools/*-fingerprint.mjs` 依赖 `node:fs`，**`src/**` 与浏览器单测绝不能 import 它**（Worker 起不来 → 白屏，`check:arch` 抓不到）。运行期纯数据放 `src/gen/structures/jungle-fortress-data.js`。
- 资源路径只走 `resourceUrl()`，禁止站点根绝对路径。
- 时间基准 `performance.now()`，禁止 `Date.now()`。
- 坐标取模一律非负；`WorkerPool.call()` 返回 `{id, promise}` 不是 promise。
- 烘焙输入放 `assets/jungle-fortress/src/`，**禁止放 `assets/textures/`**（会被 `build-atlas` 递归扫成巨型 tile）。
- 新增 salt 前必须程序化扫描占用；本计划用 **1045**（实测 1044 已占、1045~1100 空闲）。
- 非 box 几何方块必须显式 `opaque:false`（本计划零新增方块，此条仅作核对）。
- `src/tests/test-*.js` 必须同时注册进 `src/tests/index.html`（漏注册 = 静默不跑）。
- Playwright 必须 `channel: 'chromium'`；worktree 里跑会连到主仓 8081 服务（`reuseExistingServer`），验证本计划改动必须 `worktree:false` 或独立端口。
- 冻结数字不符时**停下报告**，不擅自改断言或放宽阈值。
- Conventional Commits；**提交等用户明确指令**（本计划的 commit 步骤是执行阶段的授权范围内动作，逐 Task 提交）。

## Review Focus

以下五类是 spec 蕴含但常规用例容易漏掉的失效模式，按最可能咬人排序。每条都在对应 Task 里有钉它的用例：

1. **产物 air 格漏写** → 天然岩层填满全部房间，格数/类型/指纹全对，只有走进去才发现。Task 2 钉基线 `air === 16358`、Task 3 重标为 `15536`（内容级判据），Task 6 钉「房间内是空气不是石头」。
2. **落点方向判据写反** → 城西口径写成城东（`wx - HALF <= city.maxX + CLEAR`）会让每个候选都被拒，8/8 seed 返回 null 且**无任何报错**。Task 4 钉 8 seed 锚点表非 null + `wx + HALF_X < city.minX - CLEAR`。
3. **藤蔓悬空 / 埋进石头** → 无水平依附的藤蔓浮在空中；地下天空藤蔓被整形填石埋掉。Task 3 钉 orphan=0、地下天空藤蔓=0。
4. **整形改写了地表但瞬移落点用自然高度** → 玩家悬空 2~4 格或埋进土里。Task 5 钉落点 y = 整形后地表+1（8 seed 冻结表），Task 8 走真实按钮验脚底不悬空。
5. **第 9 个瞬移按钮撑破行 / 文案折行** → 面板布局坏掉。Task 8 用**行盒数**（`Range.getClientRects()`）判，不用 `scrollWidth <= clientWidth`（折行时两者相等，无判别力）。

---

### Task 1: 素材入库 + 离线 jigsaw 拼装器

**Files:**
- Create: `assets/jungle-fortress/src/*.nbt`（17 片，从源仓库逐字节复制）
- Create: `tools/jungle-fortress-fingerprint.mjs`
- Create: `tools/bake-jungle-fortress.mjs`
- Modify: `package.json`（scripts 加 `junglefortress`）
- Test: `src/tests/test-jungle-fortress-bake.js` + `src/tests/index.html`

**Interfaces:**
- Consumes: `tools/nbt-reader.mjs` 的 `NbtReader`（既有，废弃堡垒在用）；`tools/giant-pyramid-fingerprint.mjs` 的 `FACING_TO_ORIENT`（既有，re-export 不另写）。
- Produces:
  - `JUNGLE_FORTRESS_SOURCE_DIR: string`、`JUNGLE_FORTRESS_PIECES: readonly string[]`（17 个文件名）
  - `JUNGLE_FORTRESS_ASSEMBLE: {seed:263, size:10, boxRange:80, startPiece:'center_room'}`
  - `JUNGLE_FORTRESS_POOL_WEIGHTS: Record<string, ReadonlyArray<{w:number, loc:string|null}>>`
  - `assembleJungleFortress(): {placed: Array<{name:string, rot:0|1|2|3, o:[number,number,number], size:[number,number,number], depth:number}>}`（从 `bake-jungle-fortress.mjs` export）
  - `JUNGLE_FORTRESS_METRICS: {jungleFortress: {...}}`（本 Task 只填件数直方图，其余占位）

- [ ] **Step 1: 复制 17 片素材入库**

从 `/Users/bachi/jaylli/RepurposedStructures/common/src/main/resources/data/repurposed_structures/structure/fortresses/jungle/` 复制全部 `.nbt` 到 `assets/jungle-fortress/src/`。逐字节，不改名。

Run: `ls assets/jungle-fortress/src/ | wc -l`
Expected: `17`

- [ ] **Step 2: 写失败测试 —— 拼装件数直方图**

`src/tests/test-jungle-fortress-bake.js` 不能 import `tools/`（node:fs），故本 Task 的测试走 **Node 侧脚本断言**：在 `bake-jungle-fortress.mjs` 的 `--census` 里断言，浏览器单测从 Task 2 起（消费产物 JSON）。

在 `--census` 末尾加断言：件数 === 193、件种 === 17、逐件直方图等于冻结值。

冻结直方图（spec §2.4）：
```
center_room 1 / straight_outside 44 / 4_way_outside 26 / stairs_outside 28 /
4_way_outside_large 14 / spawner 15 / straight_inside 22 / 4_way_inside 7 /
turn_inside 8 / turn_inside_chest 2 / stairs_inside 3 / stairs_inside_plants 3 /
balcony 5 / terminator_1 5 / terminator_2 7 / terminator_3 1 / terminator_4 2
```

- [ ] **Step 3: 运行确认失败**

Run: `npm run junglefortress -- --census`
Expected: FAIL（script 不存在 / 拼装器未实现）

- [ ] **Step 4: 实现 fingerprint 模块 + 拼装器**

`tools/jungle-fortress-fingerprint.mjs`：常量 + `JUNGLE_FORTRESS_POOL_WEIGHTS`（逐字抄源池 JSON）+ `jungleFortressInputFingerprint()`（17 片按固定顺序合并 sha256 前 16 + 参数 sha 前 16，同废弃堡垒手法）。

池权重（源 `worldgen/template_pool/fortresses/jungle/`）：
```
start_pool: [{w:1, loc:'center_room'}]
outside:    [{w:1,loc:null},{w:8,loc:'straight_outside'},{w:2,loc:'4_way_outside'},
             {w:4,loc:'4_way_outside_large'},{w:2,loc:'stairs_outside'},{w:1,loc:'spawner'}]
inside:     [{w:1,loc:null},{w:10,loc:'straight_inside'},{w:4,loc:'4_way_inside'},
             {w:3,loc:'turn_inside'},{w:3,loc:'turn_inside_chest'},{w:2,loc:'stairs_inside'},
             {w:2,loc:'stairs_inside_plants'},{w:2,loc:'balcony'}]
terminator: [{w:1,loc:'terminator_1'},…_2,…_3,…_4]
```
（`loc:null` = `empty_pool_element`，抽到即该口终止。）

`tools/bake-jungle-fortress.mjs` 的 `assembleJungleFortress()` 实现 spec §2.2 的七条语义。PRNG 用 mulberry32(263)。三处载荷性细节：

```js
// ① 连接口判据是 target 不是 name（name 恒为 'empty'）
const isConnector = (j) => j.target === 'connection';
// ② 旋转：绕 Y 四档，与 vanilla StructureTemplate 一致
function rotPos([x,y,z], rot, [sx,,sz]) {
  switch (rot) { case 0: return [x,y,z]; case 1: return [sz-1-z,y,x];
    case 2: return [sx-1-x,y,sz-1-z]; case 3: return [z,y,sx-1-x]; }
}
// ③ AABB deflate 0.25 不重叠 + 件中心不超 ±boxRange
const overlaps = (bx) => boxes.some(o =>
  bx[0]+0.25 <= o[3]-0.25 && bx[3]-0.25 >= o[0]+0.25 &&
  bx[1]+0.25 <= o[4]-0.25 && bx[4]-0.25 >= o[1]+0.25 &&
  bx[2]+0.25 <= o[5]-0.25 && bx[5]-0.25 >= o[2]+0.25);
```

BFS 队列（不是递归）；候选放不下则剔除重抽；池空转 fallback `terminator`；feature 池（vines/breakage/drowned/vine_breakage）不参与拼装（它们的 jigsaw 在 Task 3 消费）。

`--census` 打印：件数直方图、水平/竖直跨度、逐件连接口数、feature jigsaw 计数。

- [ ] **Step 5: 运行确认通过**

Run: `npm run junglefortress -- --census`
Expected: PASS，打印「件数 193 / 件种 17」+ 直方图逐档匹配；水平最大跨度 ≤161

- [ ] **Step 6: 负向验证（三条，逐条注入后跑，用 cp 副本还原）**

先 `cp tools/bake-jungle-fortress.mjs /tmp/jf-bake-backup.mjs`。

| 注入 | 期望 |
|---|---|
| `isConnector` 改判 `j.name === 'connection'` | 件数 1（只有 center_room） |
| 去掉 boxRange 检查 | 水平跨度 >161 |
| 去掉 AABB 不重叠检查 | 件数暴增且 bbox 撑大 |

每条跑完 `cp /tmp/jf-bake-backup.mjs tools/bake-jungle-fortress.mjs` 还原（**禁止 git checkout**，会丢未提交改动）。

- [ ] **Step 7: Commit**

```bash
git add assets/jungle-fortress/src tools/jungle-fortress-fingerprint.mjs tools/bake-jungle-fortress.mjs package.json
git commit -m "feat: 丛林要塞离线 jigsaw 拼装器与素材入库"
```

---

### Task 2: 烘焙产物（空气分层 + 支撑柱 + 石砖族变体）

**Files:**
- Modify: `tools/bake-jungle-fortress.mjs`（加 assemble→产物的管线）
- Modify: `tools/jungle-fortress-fingerprint.mjs`（填 METRICS）
- Create: `assets/structures/jungle_fortress.json` + `.meta.json`（产物）
- Create: `src/gen/structures/jungle-fortress-data.js`
- Test: `src/tests/test-jungle-fortress-gen.js` + `src/tests/index.html`

**Interfaces:**
- Consumes: Task 1 的 `assembleJungleFortress()`。
- Produces:
  - `JUNGLE_FORTRESS_VARIANTS = ['jungleFortress']`（`-data.js`，零 node 依赖）
  - `JUNGLE_FORTRESS_HALF_X = 80`、`JUNGLE_FORTRESS_HALF_Z = 77`
  - `JUNGLE_FORTRESS_FLOOR_ROW = 13`、`JUNGLE_FORTRESS_HEIGHT = 33`
  - 产物 `{version:1, stride:5, floorRow:13, palette:[...], blocks:[x,ny,z,tpi,meta,...]}`
  - `BLOCK_MAP` / `STONE_VARIANTS` / `AIR_FLOOD` 参数（进指纹）

- [ ] **Step 1: 写失败测试 —— 产物契约（浏览器单测）**

`src/tests/test-jungle-fortress-gen.js`，用 `loadStructure('jungleFortress')` 读产物后断言：

```js
// 内容级判据：air 格数（指纹拓不到「漏写空气」）
assertEqual(airCells, 16358);           // 本 Task 无藤蔓基线；Task 3 重标为 15536
assertEqual(blocks.length, 80031);      // 同上，Task 3 重标为 81238
assertEqual(palette.length, 11);        // 同上，Task 3 重标为 12
assertEqual(json.floorRow, 13);
assertEqual(json.stride, 5);
assertEqual(JUNGLE_FORTRESS_FLOOR_ROW, json.floorRow);  // 派生常量对账
```

⚠️ **本 Task 的三个数字是无藤蔓基线**，Task 3 Step 1 会把它们改成含藤蔓的值
（16358→15536 / 80031→81238 / 11→12）。不要在本 Task 就写含藤蔓的值 —— 那会让
本 Task 的 GREEN 永远达不到（藤蔓还未实现）。

同时注册进 `src/tests/index.html`（漏注册 = 静默不跑）。

- [ ] **Step 2: 运行确认失败**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: FAIL（产物不存在 / `jungleFortress` 未注册 → 空结构）

- [ ] **Step 3: 实现空气分层（判据 D：同层水平洪泛）**

```
对每个 y 层：
  从「贴产物 bbox 边界的空气格」起洪泛
  可通 = 空气格 或 nbt 未写格；遇实心停
  洪泛到的 = 天空（丢弃）；没到的 = 房间内腔（写 'air'）
```
⚠️ **只在同 y 层洪泛，竖直不传播**（屋顶破洞会把整间房误判成天空）。
四档对照实测（含 final_state，空气总 29,803）：A 全写 29,803 / B 顶盖 10,599 / C 四向8格 5,681 / **D 16,358**。

- [ ] **Step 4: 实现 jigsaw final_state 落格 + 支撑柱 + 变体分配**

`final_state` 落格：`structure_void` 丢弃，其余按名写入（`cave_air` 参与分层）。

支撑柱（红玻璃 588 格 → 6,498 根）：
```
写 (x,y,z) = stone_bricks
从 y-1 向下到 FLOOR_ROW(结构 y=6)：
  遇实心停；遇「保留空气」停（不穿房间地板）；否则写 stone_bricks
```
实测 6,446 格 / 最长 10 格 / **穿房间 0 格**。

石砖族变体（mulberry32(20261117) 逐格抽签，概率 50/25/5/20）：
`mossy_stone` / `cobblestone` / `tuff_bricks` / `stone_bricks`。

台阶：`stone_brick_stairs` 与 `mossy_stone_brick_stairs` **都映 `cobblestone_step`**
（不用 `stone_diorite_step`：tile 均色 189 vs 墙体 113，差 76 太亮）。
facing 随件旋转后再查 `FACING_TO_ORIENT`；源 53 格全 `shape=straight`+`half=bottom`，无倒置。

栏杆 `iron_bars` → `vertical_pillar`（4 向对称，orient 恒 0，**无朝向 pass**）。

- [ ] **Step 5: 冻结 METRICS 并写产物**

Run: `npm run junglefortress -- --census`（先核对）再 `npm run junglefortress`

基线冻结值（无藤蔓）：
```
bbox 159×33×155  x[-78,80] y[-6,26] z[-77,77]
格数 80031 / air 16358 / 天空丢弃 13445 / 柱根 6498 / 柱格 6446 / 最长柱 10
palette 11: mossy_stone 30503 / air 16358 / cobblestone 15085 / stone_bricks 12092 /
  tuff_bricks 3012 / vertical_pillar 2682 / cobblestone_step 156 / dirt 60 /
  red_mushroom 60 / chest 18 / water 5
台阶朝向 cobblestone_step:0=24 / :1=54 / :2=69 / :3=12
通道格数 opaque 60752 / cutout 2916 / transparent 5 / none 16358
真实 mesher: sec 125 / op 291288 / cut 72620 / trans 20
```

- [ ] **Step 6: 注册结构名 + 运行确认通过**

`structure-json.js` 从 `JUNGLE_FORTRESS_VARIANTS` 派生 `STRUCTURE_FILES`（**不手写清单**，漏一行 = 静默不出现）。

Run: `npx playwright test tests/harness.spec.mjs`
Expected: PASS

- [ ] **Step 7: 校验 atlas 未变 + 台阶朝向**

Run: `npm run atlas && git diff --stat assets/atlas.png assets/atlas.json`
Expected: 无 diff（零新增贴图）。若有 diff ⇒ 误把源图放进了 `assets/textures/`，停下查。

Run: `npm run junglefortress -- --census-orient`
Expected: 四朝向高侧与 `FACING_TO_ORIENT` 一致（真实 mesher 实测，不从定义推）

- [ ] **Step 8: 负向验证（四条）**

`cp` 备份产物与烘焙脚本后逐条注入：

| 注入 | 期望 |
|---|---|
| 空气分层改判据 B（顶盖） | air 16358→10599，单测红 |
| 洪泛加竖直传播 | air 骤降，单测红 |
| 支撑柱去掉「遇保留空气停」 | 414 格穿房间（新增用例钉） |
| 台阶改映 `stone_diorite_step` | 目标色断言红 |

- [ ] **Step 9: Commit**

```bash
git add tools/bake-jungle-fortress.mjs tools/jungle-fortress-fingerprint.mjs assets/structures/jungle_fortress.json assets/structures/jungle_fortress.meta.json src/gen/structures/jungle-fortress-data.js src/gen/structures/structure-json.js src/tests/test-jungle-fortress-gen.js src/tests/index.html
git commit -m "feat: 丛林要塞烘焙产物（空气分层/支撑柱/石砖族变体）"
```

---

### Task 3: 藤蔓（本期纳入，用户裁定）

**Files:**
- Modify: `tools/bake-jungle-fortress.mjs`（加 `addVines`）
- Modify: `tools/jungle-fortress-fingerprint.mjs`（VINE 参数 + METRICS 重标）
- Modify: `assets/structures/jungle_fortress.json` + `.meta.json`（重烘）
- Modify: `src/tests/test-jungle-fortress-gen.js`

**Interfaces:**
- Consumes: Task 2 的基线产物 Map（实心 + 保留空气 + 柱）。
- Produces: `JUNGLE_FORTRESS_VINE = {attempts:10, length:3, xzRange:3, seed:20261118, pools:['vines','vine_breakage']}`（进指纹）

- [ ] **Step 1: 写失败测试 —— 藤蔓三条判据（同时重标 Task 2 的三个基线值）**

先把 Task 2 的三个断言改成含藤蔓值：`airCells` 16358→**15536**、
`blocks.length` 80031→**81238**、`palette.length` 11→**12**，再加：

```js
assertEqual(vineCells, 2029);
// 悬空藤蔓 = 0（每格至少一个水平实心邻居）
assertEqual(orphanVines, 0);
// 地下天空藤蔓 = 0（floorRow 以下必须在 keep 内）
assertEqual(undergroundSkyVines, 0);
```

⚠️ **air 减少 822 格是预期的**：822 格保留空气被藤蔓占走（air→vine 替换，不增格数）；
产物总格只增 **1207**（= 81238 − 80031），那是长在天空里的藤蔓。
核对：2029 = 822（keep 内）+ 1207（天空），且 16358 − 822 = 15536。

- [ ] **Step 2: 运行确认失败**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: FAIL（vine 格数 0）

- [ ] **Step 3: 实现 addVines（忠实复刻 StructureVineAndLeaves）**

```
对 vines / vine_breakage 的每个 jigsaw 点（共 682 个），做 10 次尝试：
  x = ox + ri(7) - 3;  y = oy + ri(4) - 1;  z = oz + ri(7) - 3
  ① 钳到基线 footprint：x∈[-78,80]、z∈[-77,77]，否则跳过
  ② y < FLOOR_ROW(6) 时必须在 keep 内（否则地下天空藤蔓会被整形埋进石头）
  ③ 该格必须是空气或未写格（天空）
  maxLen = 3 - ri(ri(3)+1)          // 偏向上界，同上游
  从 y 向下 maxLen 格：
    y < 6 且不在 keep ⇒ 停
    非空气 ⇒ 停
    无水平实心邻居 ⇒ 停（canSurvive）
    写 'vine'
```

⚠️ **三条都是载荷性的，缺一条就静默退化**（实测）：
- 缺①：bbox 从 159 撑到 **160**，HALF_X 变 81 ⇒ 与 footprint 判据漂移（AGENTS.md「产物 bbox ≠ footprint bbox」同形坑）
- 缺②：**582 格**地下天空藤蔓被整形填石埋掉
- 缺③（只允许 keep 内生长）：vine 从 2029 掉到 **829**，且第一版更严的写法只出 **218** 格 —— 藤蔓本来就长在墙外天空里

- [ ] **Step 4: 重烘 + 重标 METRICS**

Run: `npm run junglefortress -- --census && npm run junglefortress`

最终冻结值（含藤蔓）：
```
bbox 159×33×155（不变）  HALF_X 80 / HALF_Z 77  floorRow 13
格数 81238 / air 15536 / vine 2029 / palette 12
palette: mossy_stone 30503 / air 15536 / cobblestone 15085 / stone_bricks 12092 /
  tuff_bricks 3012 / vertical_pillar 2682 / vine 2029 / cobblestone_step 156 /
  dirt 60 / red_mushroom 60 / chest 18 / water 5
通道格数 opaque 60752 / cutout 4945 / transparent 5 / none 15536
真实 mesher: sec 127 / op 291288 / cut 88852 / trans 20
op 8.5% / cut 5.0%（容量占比）  JSON 1.04MB
竖直串 1081 串，长度分布 1:475 / 2:304 / 3:268 / 4:28 / 5:6
```

- [ ] **Step 5: 运行确认通过**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: PASS

- [ ] **Step 6: 负向验证（三条，对应 Step 3 的三个钳制）**

| 注入 | 期望 |
|---|---|
| 去掉 footprint 钳制 | bbox 宽 160，`HALF_X===80` 断言红 |
| 去掉地下 keep 约束 | undergroundSkyVines=582，断言红 |
| 改成只允许 keep 内生长 | vine 829（≠2029），断言红 |

- [ ] **Step 7: Commit**

```bash
git add tools/bake-jungle-fortress.mjs tools/jungle-fortress-fingerprint.mjs assets/structures/jungle_fortress.json assets/structures/jungle_fortress.meta.json src/tests/test-jungle-fortress-gen.js
git commit -m "feat: 丛林要塞藤蔓（忠实复刻上游生长算法，零悬空/零埋石）"
```

---

### Task 4: 落点搜索（City 西方第一个丛林地带）

**Files:**
- Create: `src/gen/structures/jungle-fortress.js`
- Modify: `src/tests/test-jungle-fortress-gen.js`

**Interfaces:**
- Consumes: `-data.js` 的 HALF_X/HALF_Z；既有 `getCityBoundsForSeed` / `computeRuinedCitadelAnchor` / `computeBurningArenaAnchor` / `computeArenaAnchor` / `computeShallowTarnAnchor` / `isTarnZone` / `computeTarnZone`。
- Produces:
  - `computeJungleFortressAnchor(seed): {wx, wz, floorY, span} | null`（memo，键=seed）
  - `clearJungleFortressCache(): void`
  - `jungleFortressCandidateValid(wx, wz, seed): {ok:true, minH, maxH, span} | {ok:false, why:string}`
  - `inJungleFortressFootprint(wx, wz, anchors): boolean`
  - `JUNGLE_FORTRESS_MAX_GAP = 2400`、`JUNGLE_FORTRESS_SEARCH_HALF_Z = 900`

- [ ] **Step 1: 写失败测试 —— 8 seed 锚点表 + 城西方向**

```js
const FROZEN = {
  12345:   { wx: -304, wz: 217,  floorY: 0  },
  99999:   { wx: -621, wz: -91,  floorY: 0  },
  1249026: { wx: -454, wz: 77,   floorY: 0  },
  20260101:{ wx: -493, wz: 33,   floorY: 0  },
  777:     { wx: -672, wz: 473,  floorY: -1 },
  4242:    { wx: -368, wz: 165,  floorY: -1 },
  31337:   { wx: -442, wz: 81,   floorY: -1 },
  8888:    { wx: -613, wz: -87,  floorY: -1 },
};
// 每个 seed：锚点非 null、逐字段相等、且 wx + HALF_X < city.minX - CITY_TRANSITION_SIZE
```
再加「唯一性」：同 seed 两次调用返回同一对象（memo）；`clearJungleFortressCache()` 后重算结果相同。

再加「**西方第一个**」的最优性用例（转调 `jungleFortressCandidateValid`，不自己写判据）：

```js
// 在 8 格粗筛网格上，不存在「更东」或「同 x 但 |z-cityCz| 更小」的合法候选
for (let x = anchor.wx + 8; x <= xHi; x += 8)
  for (let z = cityCz - 900; z <= cityCz + 900; z += 8)
    assertFalse(jungleFortressCandidateValid(x, z, seed).ok);
for (let z = cityCz - 900; z <= cityCz + 900; z += 8) {
  if (Math.abs(z - cityCz) >= Math.abs(anchor.wz - cityCz)) continue;
  assertFalse(jungleFortressCandidateValid(anchor.wx, z, seed).ok);
}
```

⚠️ **断言必须限定在 8 格网格上，不能写成 1 格粒度**（实测）：
seed 12345 锚点 x=-304，而 x=-303/-302/-301 在 z=-411 处也是合法候选
（只是不在粗筛网格上）。写成逐格断言会 **正确实现下也 FAIL**。
8 格网格上实测：更东候选 **0** 个、同 x 更优 z 候选 **0** 个。

- [ ] **Step 2: 运行确认失败**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: FAIL（`computeJungleFortressAnchor` 未定义）

- [ ] **Step 3: 实现落点搜索**

判据（**方向是城西，照抄废弃堡垒那一侧，不要抄大竞技场**）：
```js
// 城西：占地东缘必须出城西界 − 净空
if (wx + JUNGLE_FORTRESS_HALF_X >= city.minX - CITY_CLEARANCE) return 'city';
```
其余四条：占地逐格全 FOREST；占地逐格 `generateHeight > SEA_Y`；避让五类地基级（高台地带整圆 / 浅水高台整形区 / 围场 / 大竞技场 / 废弃堡垒，**x/z 半宽不同要分开比**）；取「**西方第一个**」= 候选按 `x 降序 → |z − cityCz| 升序 → z 升序` 排序后第一个合法的。

搜索窗：`xHi = city.minX − HALF_X − CLEAR`，`xLo = xHi − 2400`，`z ∈ cityCz ± 900`。
粗筛 8 格网格（`giX = floor(HALF_X/8)`、`giZ = floor(HALF_Z/8)` **分开算**；网格向四周外扩 gi 格；用 `floor` 不用 `ceil`），精检早退。
`floorY = 占地最低 generateHeight`（保证只削不填）。

- [ ] **Step 4: 运行确认通过**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: PASS，8/8 seed 锚点逐字段匹配

- [ ] **Step 5: 负向验证（三条）**

| 注入 | 期望 |
|---|---|
| 城西判据改成城东（`wx - HALF <= city.maxX + CLEAR`） | 8/8 seed 返回 null |
| 粗筛 `floor` 改 `ceil` | 至少一个 seed 锚点偏移（误杀更近候选） |
| 排序改成「距 City 中心最近」 | 锚点变成 spec 旧表的值（如 12345 → (304,-392)），断言红 |

- [ ] **Step 6: Commit**

```bash
git add src/gen/structures/jungle-fortress.js src/tests/test-jungle-fortress-gen.js
git commit -m "feat: 丛林要塞落点搜索（City 西方第一个丛林地带）"
```

---

### Task 5: 地形整形（遇湿即止缓坡）

**Files:**
- Create: `src/gen/structures/jungle-fortress-terrain.js`
- Modify: `src/tests/test-jungle-fortress-gen.js`

**Interfaces:**
- Consumes: Task 4 的锚点；既有 `surfaceTypeOfBiome` / `getBiome` / `generateHeight` / `blockIndex` / `WORLD_MIN_Y` / `WORLD_MAX_Y` / `SEA_Y`。
- Produces:
  - `JUNGLE_FORTRESS_SLOPE_BAND = 16`
  - `jungleFortressSurfaceYAt(wx, wz, seed, anchor): number | null`（null = 该列不整形）
  - `inJungleFortressTerraform(wx, wz, anchors): boolean`（整形区判定，含缓坡带）
  - `fillJungleFortressGround(column, anchor, seed, registry): void`

- [ ] **Step 1: 写失败测试 —— 整形四条判据**

```js
// ① 只削不填：整形区内 target <= 自然 h
// ② 零水格：整形区内 target > SEA_Y 恒成立
// ③ 边缘连续：整形列与相邻未整形列高度差 <= 1
// ④ 区内相邻差 <= 1
// 用 8 seed 锚点各取整形区全格跑（约 3.5 万列/seed）
```
再钉 `jungleFortressSurfaceYAt` 与 `fillJungleFortressGround` 写入的地表**逐格一致**（唯一权威）。

- [ ] **Step 2: 运行确认失败**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: FAIL（函数未定义）

- [ ] **Step 3: 实现 surfaceYAt（遇湿即止）**

```
e = max(max(0,|dx|-HALF_X), max(0,|dz|-HALF_Z))   // 切比雪夫距离
e === 0 ⇒ target = floorY
否则：沿该列 outward 路径 k=1..16，遇 generateHeight <= SEA_Y ⇒ w = k-1 并停
      e > w ⇒ 返回 null（不整形）
      target = w===0 ? floorY : min(round(floorY + (h-floorY)*e/w), h)
```
outward 路径：`ex >= ez` 时走 X（`sx = sign(dx)*(HALF_X+k), sz = dz`），否则走 Z。

⚠️ **插值分母是逐列带宽 w 不是固定 16** —— 这是边缘零悬崖的关键（固定 16 时边缘跳变 8）。

- [ ] **Step 4: 实现 fillJungleFortressGround**

只扫本 column 与「占地 + 16 格外接方形」的交集；逐列：① target 以上写 0；② target 层写 `surfaceTypeOfBiome(getBiome(...))`；③ target 以下**只填空气**为 `stone`（防掉进洞穴）。**不填水**（整形区恒干燥）。

⚠️ 顺序载荷性：先削平再铺地表再填实。

- [ ] **Step 5: 运行确认通过**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: PASS

冻结成本（8 seed，城西新锚点）：
```
seed     floorY 整形列  挖方   填方 水格 边缘/区内跳变
12345    0      34796   186331 0    0    1/1
99999    0      34643   185398 0    0    1/1
1249026  0      34700   185848 0    0    1/1
20260101 0      34548   184420 0    0    1/1
777      -1     34395   212701 0    0    1/1
4242     -1     34389   212782 0    0    1/1
31337    -1     34293   211090 0    0    1/1
8888     -1     34255   211231 0    0    1/1
```

- [ ] **Step 6: 负向验证（三条）**

| 注入 | 期望 |
|---|---|
| 插值分母改成固定 16 | 出现水格（1131 列）+ 边缘跳变 >1 |
| 去掉 `min(t,h)` | 填方 >0 |
| 去掉「遇湿即止」 | 整形区出现 target <= SEA_Y 的列 |

- [ ] **Step 7: Commit**

```bash
git add src/gen/structures/jungle-fortress-terrain.js src/tests/test-jungle-fortress-gen.js
git commit -m "feat: 丛林要塞地形整形（遇湿即止缓坡，零水格零悬崖）"
```

---

### Task 6: 生成层接线（layout + apply 阶段 2.95 + 让路）

**Files:**
- Modify: `src/gen/structures/structure-layout.js`
- Modify: `src/gen/structures/jungle-fortress.js`（加压制/让路/重叠判定）
- Modify: `src/gen/structures/apply.js`
- Modify: `src/workers/world-worker.js`（layout 入口预热）
- Modify: `src/tests/test-jungle-fortress-gen.js`

**Interfaces:**
- Consumes: Task 4/5 全部导出。
- Produces:
  - `jungleFortressOverlapsRegion(anchor, rx, rz): boolean`
  - `jungleFortressSuppressedLandmarks(anchor, rx, rz, seed): {pyramid, frozenMountain, plainLand, island, snowLand, giantPyramid, skyIslands}`
  - `snowLandSuppressedByJungleFortress(rx, rz, seed): boolean`
  - layout 新字段 `jungleFortress: {wx, wz, floorY, span} | null`
  - `pointContext` 新 kind `'jungleFortress'`

- [ ] **Step 1: 写失败测试 —— 光栅化 + 让路**

```js
// ① 锚点所在 column 含 mossy_stone / cobblestone（不是纯自然地形）
// ② 房间内是空气：取 center_room 内部一点，blocks[idx] === 0
// ③ 整形区内地表 === jungleFortressSurfaceYAt
// ④ 占地内零撒布、零植被树（kind 让路生效）
// ⑤ 世界 y 范围不越界：floorY + (1-13) >= WORLD_MIN_Y
```

再加三条钉「产出了但无人测」的接口（自查补）：

```js
// ⑥ AABB 裁剪：占地跳 2×2 region 时，四个邻区都要携带锚点
//    （只让锚点所在 region 携带 ⇒ 结构缺半边，围场 v2.7 踩过同形坑）
assertTrue(jungleFortressOverlapsRegion(anchor, rxOf(anchor.wx - HALF_X), rzOf(anchor.wz - HALF_Z)));
assertTrue(jungleFortressOverlapsRegion(anchor, rxOf(anchor.wx + HALF_X), rzOf(anchor.wz + HALF_Z)));
assertFalse(jungleFortressOverlapsRegion(null, 0, 0));

// ⑦ 地标压制用「圆↔矩形相交」而不是「中心在占地内」：
//    造一个中心在占地外 1 格、但半径伸进占地的地标 ⇒ 必须被压
//    （大竞技场 seed 12345 的 plainLand 就是这个形态，中心判据会漏压）

// ⑧ 雪原整座让路：snowLandSuppressedByJungleFortress 在相交 region 返 true，
//    且 layout 里该 region 的 snowLand === null
```

- [ ] **Step 2: 运行确认失败**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: FAIL（layout 无 jungleFortress 字段）

- [ ] **Step 3: 实现 layout 接线 + 压制判据**

`structure-layout.js`：算全局锚点 → `jungleFortressOverlapsRegion` 裁剪 → 携带字段；`jungleFortressSuppressedLandmarks` 用**圆↔矩形相交**（不是「中心在占地内」）；**廉价距离门**先算 region AABB 到要塞矩形最近距离，超过最大地标半径早退（gapX/gapZ 分别用 HX/HZ）。

- [ ] **Step 4: 实现 apply 阶段 2.95 + pointContext + 惰性预载**

阶段 2.95（在 2.94 之后、2.5 之前）：① `fillJungleFortressGround` ② `rasterizeStructure('jungleFortress', wx, floorY - (FLOOR_ROW-1), wz, …, false)`。**不补 groundSupport**（柱已烘焙期固化）。

`pointContext` 新分支插在 `shallowTarn` 之后、`giantPyramid` 之前，判据转调 `inJungleFortressTerraform`（**整形区不是占地**）。用专属 kind `'jungleFortress'` 不用 `'none'`。

惰性预载：`if (layouts.some(l => l.jungleFortress)) for (const b of JUNGLE_FORTRESS_VARIANTS) needTypes.add(b);`

阶段 2.7 撒布剔除加 `inJungleFortressFootprint`。

- [ ] **Step 5: world-worker layout 入口预热锚点**

实测本结构自身搜索 **19.8ms**（网格 8.4 + 粗筛排序 3.5 + 精检 7.9），必须在 layout 入口预热，否则落进 GEN 计时。

- [ ] **Step 6: 运行确认通过**

Run: `npx playwright test tests/harness.spec.mjs tests/structure-gen.spec.mjs`
Expected: PASS；`genP95 < 10ms` 仍绿（整形最密 column 4,271 格 ≈ 0.11ms）

- [ ] **Step 7: 负向验证（三条）**

| 注入 | 期望 |
|---|---|
| 漏接 pointContext 分支 | 占地内出现树/撒布，用例④红 |
| 光栅化与整形顺序颠倒 | 结构底部被削掉，用例①红 |
| 预载改成无条件 | structure-gen 的 genP95 上升（记录实测值） |
| AABB 裁剪改成「只在锚点所在 region 携带」 | 用例⑥红（邻区不携带） |
| 地标压制改成「中心在占地内」 | 用例⑦红（圆伸进来但中心在外的那个漏压） |

- [ ] **Step 8: Commit**

```bash
git add src/gen/structures/structure-layout.js src/gen/structures/jungle-fortress.js src/gen/structures/apply.js src/workers/world-worker.js src/tests/test-jungle-fortress-gen.js
git commit -m "feat: 丛林要塞生成层接线（阶段 2.95/让路/预热）"
```

---

### Task 7: 瞬移入口（Game + 面板第 9 个按钮）

**Files:**
- Modify: `src/gen/structures/jungle-fortress.js`（加 `jungleFortressTeleportPoint`）
- Modify: `src/core/game.js`（加 `teleportToJungleFortress`）
- Modify: `src/ui/settings-panel.js`（常量 + 按钮）
- Modify: `src/tests/test-jungle-fortress-gen.js`

**Interfaces:**
- Consumes: Task 4 锚点 + Task 5 `jungleFortressSurfaceYAt`。
- Produces:
  - `JUNGLE_FORTRESS_TELEPORT_GAP = 6`
  - `jungleFortressTeleportPoint(seed): {x, y, z} | null`
  - `Game.teleportToJungleFortress(): {ok, kind?, reason?, x?, y?, z?}`
  - `TELEPORT_JUNGLE_LABEL = '丛林'`、按钮 id `btn-teleport-jungle-fortress`

- [ ] **Step 1: 写失败测试 —— 8 seed 落点冻结表**

```js
const TELEPORT = {
  12345:   [-218, 3, 217],  99999:   [-535, 3, -91],
  1249026: [-368, 3, 77],   20260101:[-407, 3, 33],
  777:     [-586, 2, 473],  4242:    [-282, 2, 165],
  31337:   [-356, 2, 81],   8888:    [-527, 2, -87],
};
// 落点 = 占地东缘 + 6（结构在城西 ⇒ 落点在靠 City 那一侧 = 东）
// y = 整形后地表 + 1（不是自然高度 + 1）
```
再钉：落点不在废弃堡垒占地内、不在 city bounds 内、整形后 5×5 高差 ≤2（8/8 实测 true/false/≤2）。

- [ ] **Step 2: 运行确认失败**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: FAIL

- [ ] **Step 3: 实现 teleportPoint + Game 入口**

`x = wx + HALF_X + 6`、`z = wz`、`y = (jungleFortressSurfaceYAt(x,z,seed,anchor) ?? generateHeight(x,z,seed)) + 1`。
`Game.teleportToJungleFortress()` 走既有 `_teleportTo(x,y,z)`（它会加载目标 column；`player.spawn` 不加载 ⇒ 悬空超时）。

- [ ] **Step 4: 面板加第 9 个按钮**

文案 `'丛林'`（2 字）；toast 用全名「丛林要塞」；走 `_teleportThenAutoClose`。
`.mc-teleport .mc-btn-group` 的 `gap:4px` 保持不变。

- [ ] **Step 5: 运行确认通过**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: PASS

- [ ] **Step 6: 负向验证（两条）**

| 注入 | 期望 |
|---|---|
| y 改用自然高度 + 1 | 落点 y 偏 2~4，冻结表红 |
| 落点改西缘（`wx - HALF_X - 6`） | 8/8 落点 x 全错，冻结表红 |

- [ ] **Step 7: Commit**

```bash
git add src/gen/structures/jungle-fortress.js src/core/game.js src/ui/settings-panel.js src/tests/test-jungle-fortress-gen.js
git commit -m "feat: 丛林要塞瞬移入口（第 9 个按钮，落点用整形后地表）"
```

---

### Task 8: 门禁 + E2E + 像素验收

**Files:**
- Modify: `tools/check-data.mjs`（加 `[丛林要塞]` 环节）
- Create: `tests/jungle-fortress.spec.mjs`
- Modify: `tests/teleport.spec.mjs`（ORDER/LABELS 扩到 9）
- Modify: `docs/roadmap.md`（v3.13 行）
- Modify: `AGENTS.md`（高频坑）

**Interfaces:**
- Consumes: 全部前序 Task 的导出与产物。
- Produces: `checkJungleFortress()`（check:data 内部函数）

- [ ] **Step 1: 写 check:data 的 [丛林要塞] 环节**

钉：素材 17 片存在 / 产物存在 / 指纹匹配 / 两侧 VARIANTS 一致 / `STRUCTURE_FILES.jungleFortress === 'jungle_fortress.json'` / stride 5 / floorRow **三处一致**（产物 JSON、fingerprint `FLOOR_ROW`、`-data.js` 常量）/ 格数 81238 / **air 15536** / **vine 2029** / palette 12 全已注册 / bbox 159×33×155 / HALF_X 80 HALF_Z 77 / 台阶朝向四档 24/54/69/12 / 件数直方图 / 通道格数。

- [ ] **Step 2: 运行 check:data 确认通过**

Run: `npm run check:data`
Expected: PASS，打印 `[丛林要塞] 81238 格 / 159×33×155 / floorRow 13 / air 15536 / vine 2029 / …`

- [ ] **Step 3: 写 E2E（真实按钮入口，不只调 Game API）**

`tests/jungle-fortress.spec.mjs`：
- 从 `#settings-btn` 打开面板 → 点 `#btn-teleport-jungle-fortress` → 等世界稳定（sections 停止增长 + 三队列归零）→ 断言 toast 含「丛林要塞」、玩家坐标等于冻结落点。
- **像素**：瞬移后截图，石砖族像素占比 > 阈值；**带对照组**（同 seed 未瞬移的森林截图）校准，同时钉上下界。
- **房间可进入**：走进中央大厅，断言该处 `blocks[idx] === 0` 且截图非纯黑。
- **零假水面**：整形区截图无「陆地上的蓝色水面」（水体判据用 `b>r+25 && g>r+12 && lum∈[95,150]`，带对照组）。

- [ ] **Step 4: teleport.spec 扩到 9 按钮**

ORDER 末尾加 `btn-teleport-jungle-fortress`，LABELS 末尾加 `'丛林'`，`ids.size` 改 9。
**用行盒数判文案折行**：`Range.getClientRects().length === 1`，不用 `scrollWidth <= clientWidth`。

- [ ] **Step 5: 运行全量验证**

Run: `npm run check`
Expected: 0 error（lint warning 数不得比 HEAD 增加 —— 改动后单独跑 `npx eslint <改过的文件>` 核对）

Run: `npx playwright test tests/jungle-fortress.spec.mjs tests/teleport.spec.mjs tests/structure-gen.spec.mjs`
Expected: PASS

Run: `npm test`
Expected: 全绿（既有 flaky 用交替对照判定，不改阈值）

Run: `npm run bench -- --check`
Expected: 通过（frameP95 若贴线用交替对照，不单次判红）

⚠️ **若第 9 个按钮撑破行**：停下报告实测行盒数与按钮宽度，**不擅自缩文案到 1 字或改布局**。

- [ ] **Step 6: 更新 roadmap + AGENTS.md**

roadmap v3.13 行：写清两处用户裁定更新（城西第一个 / 藤蔓纳入）、冻结值、实测证据、两处接受的偏离。

AGENTS.md 高频坑加四条：
- jigsaw 连接口判据是 `target` 不是 `name`（写错 ⇒ 只出 1 件，无报错）
- 空气分层用同层水平洪泛，竖直不传播（四档实测 29803/10599/5681/16358）
- 藤蔓三个钳制缺一即静默退化（bbox 撑大 / 582 格埋石 / 2029→829）
- 缓坡插值分母是逐列带宽 w 不是固定 16（固定 ⇒ 边缘跳变 8）

- [ ] **Step 7: Commit**

```bash
git add tools/check-data.mjs tests/jungle-fortress.spec.mjs tests/teleport.spec.mjs docs/roadmap.md AGENTS.md
git commit -m "test: 丛林要塞门禁与 E2E 验收"
```

---

## 自查（writing-plans Self-Review）

**1. Spec 覆盖**：DR-1→T1/T2；DR-2→T2；DR-3→T2；DR-4→T2；DR-5→T2；DR-6→T4（**按用户新裁定改城西**）；DR-7→T5；DR-8→T6；DR-9→T6/T8 实测；DR-10→T7/T8；DR-11→T1 素材入库注释。spec §6 开放项「藤蔓」→T3（用户裁定纳入）。无遗漏。

**2. 步骤扫描**：每步一个可检查结果。算法体只给三处签名+测试不能确定的（jigsaw 旋转/AABB、洪泛、遇湿即止插值），其余给签名与冻结值。

**3. 类型一致**：`computeJungleFortressAnchor` 返回 `{wx,wz,floorY,span}` 全程一致；`jungleFortressSurfaceYAt` 四参 `(wx,wz,seed,anchor)` 在 T5 定义、T7 消费一致；`JUNGLE_FORTRESS_FLOOR_ROW` 在 T2 定义、T6/T8 消费一致。

**4. Review Focus**：五条各有归属用例（T2 air / T4 方向 / T3 藤蔓 / T5+T7 落点高度 / T8 行盒数）。

**5. 比例**：本计划 789 行 vs spec 779 行，基本等长（计划多了 8 个 Task 的测试代码与 20 条负向验证表）。
代码块只占算法必需部分（jigsaw 旋转/AABB、洪泛、遇湿即止插值、藤蔓三个钳制），
其余均为签名 + 冻结值 + 可执行命令。

**6. 自查发现并修正的四处**（勿改回）：
1. Task 2 Step 1 的 `airCells` 误写成含藤蔓值 15536，与同 Task 的无藤蔓基线 80031/11 矛盾
   ⇒ 改为 16358，并在 Task 3 Step 1 显式重标三个值。
2. 藤蔓分解算错（写 792+1237）⇒ 实测是 **822（keep 内）+ 1207（天空）= 2029**，
   且 16358−822=15536、80031+1207=81238 两条恒等式均成立。
3. 「西方第一个」的最优性断言差点写成 1 格粒度 ⇒ 实测 x=-303/-302/-301 在 z=-411 处
   也合法（只是不在 8 格粗筛网格上），逐格断言会正确实现下也 FAIL ⇒ 限定在 8 格网格。
4. 三个产出了但无人测的接口（`jungleFortressOverlapsRegion` / `SuppressedLandmarks` /
   `snowLandSuppressedByJungleFortress`）⇒ Task 6 补用例⑥⑦⑧ + 两条负向验证。