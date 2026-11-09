# 大竞技场移植实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> ## ⚠️ v2 修订注记（2026-11-09）
>
> 本计划初版按「祭坛高台地带中心、取代祭坛、抑制 8 座高台」执行到 Task 8 时，
> 全量回归发现与飞龙/焰魔硬冲突（龙轨道被碗体封闭、焰魔召唤点被熔岩柱占据，
> 10 个既有 E2E 全红，单变量 A/B 已归因）。
>
> **用户裁定改为**：大竞技场放到**城东距离最近的沙漠地带的相对平坦区域**（必须且唯一），
> 祭坛 + 飞龙/焰魔原地不动。落点重做已完成并验证（浏览器单测 1836/1836、E2E 28/28、
> 零回归对比 142/147 逐位相同、Tier 4 像素通过）。详见 spec 的 v2 修订记录与
> ledger（`.superpowers/sdd/2026-11-09-burning-arena-port/progress.md`）。
>
> 下文 Task 1~8 的步骤是**初版祭坛落点**的执行记录（烘焙/映射/产物部分仍然有效，
> 落点/接线部分已被 v2 取代），保留作为历史执行轨迹。

**Goal:** 把 Cataclysm 模组的 burning_arena Boss 竞技场（8 片 nbt，85×85×80）以方案 A（纯几何 + 重映射现有方块）烘焙进 mc-heavy，生成在**城东距离最近的沙漠地带的相对平坦区域**（v2 修订；初版「祭坛高台地带中心」已作废）。

**Architecture:** 完全复用 arena/pyramid 烘焙管线：nbt 入库 → `tools/bake-burning-arena.mjs`（复用 `nbt-reader.mjs`）拼合 + 重映射 → palette+stride=5 结构 JSON → `structure-json.js` 加载 → `apply.js` 新阶段 2.93 在城东沙漠锚点光栅化（碗内地板顶面 = floorY）。锚点由 `burning-arena.js` 的 `computeBurningArenaAnchor` 给出（每 seed 恰好一个，确定性）。

**Tech Stack:** Node 烘焙脚本（无新依赖）、浏览器内 Tier 1 单测、Playwright Tier 4、check:data 契约门、bench 预算门。

**Spec:** `docs/superpowers/specs/2026-11-09-burning-arena-port-design.md`

## Global Constraints

- **烘焙 = 数据格式转换**：不新增任何方块声明、不新增贴图；`BLOCK_MAP` 目标名必须全部在 `src/voxel/blocks-data.js` 的 137 个已注册名字内。
- 未知源方块名**必须 throw**（`makeColumnSetter` 对未注册名字静默 return → 那格变 air）。
- `tools/*-fingerprint.mjs` 是 node 侧模块，**`src/**` 与浏览器单测禁止 import**（B1 白屏教训）。
- 结构注册名走派生不手写（红线 1）；`floorRow` 必须由产物显式提供。
- 台阶朝向只能用真实 mesher 实测定（`--census-orient`），不得从定义推。
- 工作区有**别的会话未提交的 ignis 改动**（`src/entities/**`、`tests/ignis.spec.mjs` 等）：不碰、不暂存、`git add` 只按文件名加本任务文件。
- **提交须等用户明确指令**（AGENTS.md）：每个 Task 的 commit 步骤写好命令与 message，但执行前等用户发话；用户未发话时累积到最后一起问。
- 冻结数字与实测不符时**停下来报告**，不擅自改断言。

## Review Focus

1. **映射漏项**：45 种源方块名漏映射一种 → 烘焙 throw 是护栏，但若护栏被改成静默跳过 → 碗身出现空气洞。→ Task 2 的 `--census` 必须打印 0 未覆盖（探针已验证：目标 19 种、未覆盖 0、facing 缺失 0）；Task 5 check:data 断言 palette 全注册。
2. **倒置台阶朝向**：`half=top` 的台阶若按正台阶 orient 直写 → 楼梯高侧差 180°（上下颠倒 + 镜像）。**实测倒置是多数（2,053 格 vs 正置 1,426，59%）**，不是边缘情况。→ Task 2 的 census-orient 对 `cobblestone_step_updown` 实测后才冻结映射。
3. **落位错层**：y 传错（如忘了 `-(floorRow-1)`）→ 整座竞技场沉 9 格或浮 1 格，方块层面看不出因果。→ Task 3 单测断言「碗内地板顶面 = plateauY 且其上为空气」。
4. **祭坛地带判定漂移**：竞技场写到非最近地带（两份「最近」判据）→ 玩家按「高台」瞬移看到的还是祭坛。→ Task 3 断言落点 = `findAltarTarnRegion` 圆心（迁移 test-tarn-altar 的有效断言）。
5. **cutout 预算**：~8000 格台阶/墙/栏杆进 cutout 通道 → 密林视域峰值恶化。→ Task 7 bench 实测 + 保险丝（降级墙/栅栏为 `nether_bricks` 重烘）。

---

### Task 1: 素材入库 + 指纹共享模块

**Files:**
- Create: `assets/burning-arena/src/burning_arena{1..8}.nbt`（从源仓库复制，共 1.5MB）
- Create: `tools/burning-arena-fingerprint.mjs`

**Interfaces:**
- Produces（后续任务依赖）：
  - `BURNING_ARENA_SOURCE_DIR`（目录路径）、`BURNING_ARENA_PIECES`（8 片 `{file, ox, oy, oz}`，偏移表见 spec §2.1，**含 y+1**）
  - `BURNING_ARENA_JSON` / `BURNING_ARENA_META`（产物路径）
  - `BLOCK_MAP`（源名→目标名，空串=丢弃；不含台阶/slab，它们走烘焙脚本 classify 分支）
  - `BURNING_ARENA_METRICS`（width/depth/height/floorRow/sourceCells/droppedCells/contentCells/paletteSize，Task 2 census 后冻结）
  - `burningArenaInputFingerprint()` → `{input, sourceSha256, paramsSha256}`（8 片内容 sha 合并 + 参数 sha，格式同 `arenaInputFingerprint`）

- [ ] **Step 1: 复制 8 片 nbt 入库**

```bash
mkdir -p assets/burning-arena/src
cp /Users/bachi/jaylli/cataclysm1.19.2modding/src/main/resources/data/cataclysm/structures/burning_arena{1,2,3,4,5,6,7,8}.nbt assets/burning-arena/src/
```

在 `assets/burning-arena/src/` 放一个 `README.md`：出处（L_Ender's Cataclysm mod, MC 1.19.2）、仅数据无代码无贴图、用途（烘焙输入）。

- [ ] **Step 2: 写 `tools/burning-arena-fingerprint.mjs`**

头注释照抄 `arena-fingerprint.mjs` 的口径（node 侧、src 禁 import、唯一权威）。`BLOCK_MAP` 定稿（spec DR-2，逐条理由写进注释）：

```
nether_bricks / netherrack / obsidian / lava / chest / gold_block /
polished_blackstone_bricks / polished_deepslate      → 同名直通
red_nether_bricks → nether_bricks_1
chiseled_nether_bricks / cracked_nether_bricks → nether_bricks
cracked_polished_blackstone_bricks → polished_blackstone_bricks
blackstone → deepslate
polished_blackstone → polished_deepslate
crying_obsidian → obsidian
polished_basalt / smooth_basalt → polished_diorite
ancient_debris → debris
raw_gold_block → gold_block
soul_soil → netherrack
soul_fire / shroomlight / candle → glowstone
lantern / soul_lantern → hanging_lamp
nether_brick_fence / nether_brick_wall / polished_blackstone_wall /
polished_blackstone_brick_wall / chain → handrail
twisting_vines / twisting_vines_plant / weeping_vines / weeping_vines_plant → vine
structure_block / cataclysm:altar_of_fire → ''（丢弃）
```

⚠️ **lava 不进 BLOCK_MAP**，走 classify 分层分支（用户 2026-11-09 裁定，spec DR-2.1.5）：
归一化 y === floorRow(10) 的 lava → `netherrack`（碗内地板可走）；其余层 lava 保持
`lava`（墙内装饰流/悬空池，solid 发光）。本仓 lava 是 solid:true，地板直映会让 13%
地面走不过去。

台阶（`/_stairs$/`）与 slab（`/_slab$/`）**不进 BLOCK_MAP**，由烘焙脚本 classify 分支处理（同 pyramid）；`FACING_TO_ORIENT` 从 `giant-pyramid-fingerprint.mjs` import（同一事实不抄第二份，红线 1）。

**另导出 `SLAB_BASE`**（显式表，spec DR-2.3）：

```
nether_brick_slab → nether_bricks
blackstone_slab → deepslate
polished_blackstone_slab → polished_deepslate
```

⚠️ **不得用字符串剥 `_slab` 后缀查 BLOCK_MAP**：`nether_brick_slab` 剥出 `nether_brick`（单数）而表里是 `nether_bricks`（复数）→ 静默落到兜底值（探针实测因此错映 36 格为 `stone`）。

`BURNING_ARENA_METRICS` 先留占位注释「Task 2 census 后填」。

- [ ] **Step 3: 冒烟验证指纹模块可 import**

Run: `node -e "import('./tools/burning-arena-fingerprint.mjs').then(m => console.log(m.burningArenaInputFingerprint().input))"`
Expected: 打印 `<sha16>:<sha16>`，无异常。

- [ ] **Step 4: Commit（等用户指令）**

```bash
git add assets/burning-arena/src tools/burning-arena-fingerprint.mjs
git commit -m "feat(burning-arena): 烘焙素材入库 + 映射表/指纹共享模块"
```

---

### Task 2: 烘焙脚本 + 产物（Tier 2）

**Files:**
- Create: `tools/bake-burning-arena.mjs`
- Modify: `package.json`（scripts 加 `"burningarena": "node tools/bake-burning-arena.mjs"`）
- Modify: `tools/burning-arena-fingerprint.mjs`（census 后冻结 METRICS 数字）
- Create: `assets/structures/burning_arena.json` + `burning_arena.meta.json`（烘焙产物）

**Interfaces:**
- Consumes: Task 1 全部导出；`tools/nbt-reader.mjs` 的 `NbtReader`。
- Produces: `burning_arena.json`（`{version:1, stride:5, floorRow:10, palette:[...], blocks:[x,y,z,pi,dir,...]}`，x/z 相对结构中心 ∈ [-42,42]，y 归一化 minY→1 ∈ [1,80]）；meta 含 `fingerprints.input` 与各目标方块计数。

- [ ] **Step 1: 写烘焙脚本**

结构照抄 `bake-giant-pyramid.mjs` 三段式（`--census` / `--census-orient` / 默认 bake）：
- **拼合**：逐片 `gunzipSync` + `NbtReader`，按 `BURNING_ARENA_PIECES` 偏移累加进全局坐标；跳过 `air`；`structure_block` 与 `cataclysm:altar_of_fire` 计入 droppedCells 后丢弃。
- **classify**（一个 palette 条目 → `{block, meta}|null`）：
  - 直查 `BLOCK_MAP`（空串 → null）；
  - `lava` → 归一化 y === floorRow(10) 时 `netherrack`，否则 `lava`（spec DR-2.1.5）；
  - `/_stairs$/` → `cobblestone_step` + `meta = FACING_TO_ORIENT[p.facing]`；`half === 'top'` → `cobblestone_step_updown` + `meta = (FACING_TO_ORIENT[p.facing] + 2) % 4`（倒置「颠倒+水平镜像」，高侧差 180°——**以 Step 2 实测为准，不符则改这里**）；`shape` inner/outer 统一按直台阶（pyramid 同款裁定）；facing 缺失/未知 → throw；
  - `/_slab$/` → 查 `SLAB_BASE[bn]` 拿基础整块名（**不剥字符串**，见 Task 1）；`type==='bottom'` → `sand_slab`；`type==='top'` **和** `'double'` → `SLAB_BASE[bn]` 整块（spec DR-2.3：top 不用 `half_block_updown`，那个贴图是 planks_birch 木色，在暗红下界砖场景里比高 0.5 格的整块显眼）；`SLAB_BASE` 未收录 → throw；
  - 其余未命中 → throw（列出源名）。
  ⚠️ classify 需要格子的归一化 y（lava 分层用）——拼合时先算 minY 再逐格映射，
  或两遍扫描（先定 minY，再映射），不得用「源片内 y」判层。
- **输出**：归一化 x/z 减中心偏移 42、y 归一化 minY→1；stride=5 第 5 项写 meta；`floorRow: 10` 写入 JSON 顶层；meta.json 写指纹 + 计数 + 包围盒。
- **`--census`**：打印源方块普查（45 种逐名 + 格数）、映射结果、未覆盖项（有则 throw）、组装包围盒、floorRow 推导（中心 40×40 逐层空气占比，第一个 ≥95% 空气层的下一层即地板）。
- **`--census-orient`**：照抄 pyramid 的实测函数，但注册**两个**探针方块（几何 `cobblestone_step` 与 `cobblestone_step_updown`），各测 orient 0~3 的高侧方向；对 updown 额外验证「+2 mod 4」假设。

- [ ] **Step 2: 跑 census 与 census-orient，冻结数字**

Run: `npm run burningarena -- --census` → 预期（探针 2026-11-09 已实测）：
- 45 种源名 **0 未覆盖**、facing 缺失 **0**；
- 包围盒 **85×80×85**、非空气 **115,382**、dropped **4**（structure_block 3 + altar_of_fire 1）；
- **contentCells = 115,381**、目标 **paletteSize = 19**、floorRow **10**；
- 通道分布 opaque **107,793（93.4%）** / cutout **7,588（6.6%）** / transparent **0**；
- 台阶 `half=top` **2,053** / `half=bottom` **1,426**；slab `bottom` 504 / `top` 231 / `double` 36；
- 熔岩分层：netherrack **4,882**（含地板熔岩 937）/ lava **1,179**（仅 y≠10 层）；
- 地板层 floorCells **4,825**（nether_bricks 3,180 / netherrack 937 / polished_deepslate 556 /
  cobblestone_step 136 / polished_blackstone_bricks 16）。

Run: `npm run burningarena -- --census-orient` → 预期：正台阶与 `FACING_TO_ORIENT` 一致；updown 高侧 = 正台阶 +180°。
**实测与预期不符 → 停下报告**（可能是拼合偏移或朝向假设错）。把 census 输出的格数填进 `BURNING_ARENA_METRICS`（以上数字为准，floorCells 以实测为准）。

- [ ] **Step 3: 烘焙产物**

Run: `npm run burningarena`
Expected: 生成 `assets/structures/burning_arena.json`（~1.5MB 量级）+ meta；stdout 打印各目标方块计数。
抽查：`node -e` 读 JSON，确认 `stride===5`、`floorRow===10`、palette 无未注册名、blocks 长度 = contentCells×5。

- [ ] **Step 4: Commit（等用户指令）**

```bash
git add tools/bake-burning-arena.mjs tools/burning-arena-fingerprint.mjs package.json assets/structures/burning_arena.json assets/structures/burning_arena.meta.json
git commit -m "feat(burning-arena): 烘焙脚本与产物（8 片拼合 + 重映射）"
```

---

### Task 3: Tier 1 单测（RED）

**Files:**
- Create: `src/tests/test-burning-arena-gen.js`
- Modify: `src/tests/index.html`（加 import 一行；**同时保留** test-tarn-altar 行到 Task 4 才删）

**Interfaces:**
- Consumes: `loadStructure`/`STRUCTURE_FILES`/`floorRowOf`（structure-json.js）、`computeTarnZone`/`findAltarTarnRegion`/`isAltarTarnZone`（tarn-zone.js）、`computeRegionLayout`、`applyStructuresToColumn`、`fillColumn`、`buildDefaultRegistry`、`ChunkColumn`、`blockIndex`。
- Produces: 供 Task 4 GREEN 的失败用例集。

- [ ] **Step 1: 写失败测试**（手法照抄 `test-tarn-zone-gen.js`：真实 `fillColumn` + `applyStructuresToColumn`，SEED=12345）

用例清单（断言值来自 spec §2 冻结数字）：
1. `STRUCTURE_FILES.burningArena === 'burning_arena.json'`；
2. `loadStructure('burningArena')` 后：blocks 非空、x/z 跨度 85、y 跨度 80（minY=1, maxY=80）、`floorRowOf('burningArena') === 10`；
3. **落点迁移**（自 test-tarn-altar.js）：`findAltarTarnRegion(12345)` = region(2,0)、中心 (1000,200)；逐 seed（至少 12345/1/99999）恰一个 region `isAltarTarnZone` 为 true；memo 二次调用同值；
4. **高台抑制**：祭坛地带 `computeTarnZone(...).tarns.length === 0`、decos 只有 5 拱洞、clouds 仍 4；任取一个非祭坛地带 `tarns.length === 8`；
5. **真实 GEN 落位**：对祭坛地带圆心 column 走 `fillColumn + applyStructuresToColumn`（需 preload `burningArena`）：
   - `(cx, plateauY, cz)` 是 **netherrack**（地板层熔岩映射后的结果，非 air、非 lava）；
   - `(cx+5, plateauY, cz)` 是 **polished_deepslate**（实测偏移点，防「静默空结构」恒真）；
   - `(cx+5, plateauY+1, cz)` 是 air（碗内可站；⚠️ 不能用中心列——中心是熔岩柱，
     y=11 起是 solid lava）；
   - 占地内 plateauY 层 nether_bricks 计数 > 1000（地板确实铺进来了）；
   - 占地内 plateauY 层**没有** debris（祭坛中心美朵已消失）。

- [ ] **Step 2: 注册进 index.html 并跑，确认 RED**

Run: `npx playwright test tests/harness.spec.mjs`（它 goto `/src/tests/index.html` 并读 `window.__MC_TEST_RESULTS__`，`failed === 0` 才绿）。
Expected: **harness 红**（新用例失败）。
⚠️ **漏注册 = 静默不跑（全绿假象）**：判 RED 前先用一次性探针 spec（`tests/tmp-*.spec.mjs`，已 gitignore）读 `results.suites.flatMap(s => s.tests)` 确认**能看到新用例名**且状态为 fail；`check:data` 的 `[测试注册]` 环节会双向钉住 index.html。

- [ ] **Step 3: Commit（等用户指令）**

```bash
git add src/tests/test-burning-arena-gen.js src/tests/index.html
git commit -m "test(burning-arena): Tier 1 接线用例（RED）"
```

---

### Task 4: 运行期接线（GREEN）+ 祭坛删除

**Files:**
- Modify: `src/gen/structures/structure-json.js`（注册 `burningArena`）
- Modify: `src/gen/structures/apply.js`（预载 + 阶段 2.93 + 删 rasterizeAltar 调用与 import）
- Modify: `src/gen/structures/tarn-zone.js`（`computeTarnZone` 对 altar 地带 `tarns: []`）
- Delete: `src/gen/structures/tarn-altar.js`、`src/tests/test-tarn-altar.js`
- Modify: `src/tests/index.html`（删 test-tarn-altar import 行）
- Modify: 受影响断言（预计 `src/tests/test-tarn-zone-gen.js` 若有祭坛地带 8 高台断言）

**Interfaces:**
- Consumes: Task 2 产物（`burning_arena.json`）、Task 3 测试集。
- Produces: 全绿的 Task 3 用例；`apply.js` 阶段 2.93 的既有消费方（后续 check:data 读 `STRUCTURE_FILES`）。

- [ ] **Step 1: structure-json.js 注册**

在 `BASE_STRUCTURE_FILES` 区加（从纯数据模块派生则与 arena 同款；单变体可直接一行）：
`burningArena: 'burning_arena.json'`，附注释说明「灾变 burning_arena，方案 A 重映射产物」。
⚠️ 纯数据常量不要放进 fingerprint 模块（node:fs 依赖，B1）——如需 src 侧常量，新建 `src/gen/structures/burning-arena-data.js`（零依赖，同 `arena-variants.js` 手法）并由两侧派生。

- [ ] **Step 2: apply.js 接线**

- 预载：`if (layouts.some((l) => l.tarn?.altar)) needTypes.add('burningArena');`
- 删 `rasterizeAltar` 的 import 与阶段 2.4 里的调用块（:486-489 区域）。
- 新阶段 2.93（插在阶段 2.9 竞技场块之后、阶段 2.5 空中结构之前）：

```js
// ---- 阶段 2.93：灾变竞技场（burning arena，祭坛地带中心）----
for (const layout of layouts) {
  const t = layout.tarn;
  if (!t || !t.altar) continue;
  if (!placementIntersects({ x: t.cx, z: t.cz }, 43, 43, column.cx, column.cz)) continue;
  const floorRow = floorRowOf('burningArena');
  rasterizeStructure('burningArena', t.cx, t.plateauY - (floorRow - 1), t.cz,
    setBlock, column, registry, seed, false);
}
```

层序注释照抄阶段 2.9 的口径（后写胜、不补 groundSupport 的理由）。
⚠️ **性能已知代价**：`rasterizeStructure` 对每个相交 column 都遍历全部 115,381 格
（setBlock 越界静默丢）。相交 column ≈ 6×6=36 ⇒ 约 4.1M 次 setBlock，全在 GEN Worker
里、每 seed 只发生一次（一个祭坛地带）。比巨型金字塔（16K 格）大 7 倍但同构，
可接受；若实测 GEN 明显变慢再考虑按 column 预分桶（不在本期）。

- [ ] **Step 3: tarn-zone.js 抑制高台**

`computeTarnZone` 里 `placed` 计算后：祭坛地带（`altar` 为真）时 `tarns: []`，注释引 v2.31 紫晶柱同款手法与用户 2026-11-09 裁定。⚠️ arch/clouds/spire 逻辑不动。

- [ ] **Step 4: 删祭坛**

`rm src/gen/structures/tarn-altar.js src/tests/test-tarn-altar.js`（本仓内、可恢复：git 里有）；删 index.html 对应 import 行。确认 `altarSurfaceBlockAt` 等无其他 import 方（已核：只有 apply.js 与测试）。

- [ ] **Step 5: 跑单测确认 GREEN + 修受影响的既有断言**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: 全绿（`failed === 0`）。若 `test-tarn-zone-gen.js` 等出现「地带恒 8 高台/12 装饰件」类红：先确认该用例测的是不是祭坛地带（`findTarnRegion` 扫出的第一个不一定是），只改**确实针对祭坛地带**的断言，非祭坛地带的断言不动。
Run: `npm run check`（arch 门会扫同构层 import；确认无新违规）。

- [ ] **Step 6: Commit（等用户指令）**

```bash
git add src/gen/structures/structure-json.js src/gen/structures/apply.js src/gen/structures/tarn-zone.js src/tests/index.html src/tests/test-tarn-zone-gen.js
git rm src/gen/structures/tarn-altar.js src/tests/test-tarn-altar.js
git commit -m "feat(burning-arena): 祭坛地带中心生成灾变竞技场，取代祭坛并抑制高台"
```

---

### Task 5: check:data 契约环节（Tier 2）

**Files:**
- Modify: `tools/check-data.mjs`（新函数 `checkBurningArena()` + 主流程显式调用行）

**Interfaces:**
- Consumes: `tools/burning-arena-fingerprint.mjs` 全部导出、产物 JSON/meta、`STRUCTURE_FILES`。

- [ ] **Step 1: 写 `checkBurningArena()`**（照抄 `checkArena` 骨架，钉 spec §4 的失效路径）

断言：① 输入 8 片与产物存在；② 指纹匹配；③ `stride === 5`；④ palette 全部 `REGISTRY.idOf` 有值；⑤ 包围盒 85×80×85 且 minY=1；⑥ `floorRow === 10` 且与产物实际一致（地板层格数 = METRICS.floorCells = 4,825）；⑦ 格数 = METRICS.contentCells（115,381）；⑧ `STRUCTURE_FILES.burningArena === 'burning_arena.json'`；⑨ **地板层无 lava**（熔岩分层规则的内容级判据，AGENTS.md「overlay 静默跳过」同款教训：指纹拓不到分层逻辑，必须用目标方块计数钉）。成功行涵盖全部判据（AGENTS.md 已记「✓✗同打」坑）。

- [ ] **Step 2: 主流程加显式调用行**（`await checkArena();` 附近，带「漏了本行则门禁永不执行」注释）

- [ ] **Step 3: 验证**

Run: `npm run check:data` → Expected: `[灾变竞技场] ... 指纹匹配` 信息行，退出码 0。
负向自检（可选）：手改 meta 里一个数字 → 门禁报过期 → 还原。

- [ ] **Step 4: Commit（等用户指令）**

```bash
git add tools/check-data.mjs
git commit -m "test(burning-arena): check:data 契约环节（指纹/包围盒/floorRow/palette）"
```

---

### Task 6: Tier 4 像素验收

**Files:**
- Create: `tests/burning-arena.spec.mjs`

**Interfaces:**
- Consumes: `window.__MC_GAME__`（瞬移/世界状态）、`findAltarTarnRegion`（经 page.evaluate 取圆心）。

- [ ] **Step 1: 写 spec**

流程：开游戏（`openGame` 既有手法）→ `page.evaluate` 取 `findAltarTarnRegion(seed)` 圆心 → 瞬移到 `(cx, plateauY+3, cz+50)` 面向圆心（碗外看全景）→ **等世界稳定：sections 停止增长**（memory：不能只看队列瞬时归零）→ 截图 A；再瞬移进碗内 `(cx, plateauY+2, cz)` 截图 B。
断言（**上下界双钉**，AGENTS.md 规定）：
- A/B 均非纯黑（均值 > 噪声底）且非全同色（标准差 > 阈值）；
- A 含暗红/黑系主色：采样区域红色通道均值 > 蓝通道均值（下界砖主色），同时亮度 < 上界（不是过曝白屏）。
**先测同状态重复截图的噪声底再定阈值**（先跑一次打印实际值）。

- [ ] **Step 2: 跑**

Run: `npx playwright test tests/burning-arena.spec.mjs`
Expected: PASS；失败时先看截图（test-results/）判断是接线错还是阈值错。

- [ ] **Step 3: Commit（等用户指令）**

```bash
git add tests/burning-arena.spec.mjs
git commit -m "test(burning-arena): Tier 4 像素验收（碗形外观 + 碗内可站）"
```

---

### Task 7: 预算门

**Files:** 无新增（可能触发 `BLOCK_MAP` 保险丝改动 → 重烘）

- [ ] **Step 1: 跑预算门**

Run: `npm run bench -- --check`（⚠️ 不带 --check 会重写基线 = 静默放宽门禁；frameP95 贴线时按 memory 用交替对照判定，不单次红绿）
Run: `npx playwright test tests/m3-fullscene.spec.mjs`（200 MiB 门）
Expected: 出生点在城市、冲刺从森林/海岸起步，均不含祭坛地带视域 → 理论上不受影响；**以实测为准**。

- [ ] **Step 2: 保险丝（仅当 cutout 峰值恶化 > 5pp）**

把 `BLOCK_MAP` 的墙/栅栏族（`nether_brick_wall`/`nether_brick_fence`/`polished_blackstone_wall`/`polished_blackstone_brick_wall`/`chain`，共 **3,311 格**）改映 `nether_bricks` → `npm run burningarena` 重烘 → 更新 METRICS 冻结值（cutout 7,588 → 4,277）→ 重跑 Task 5/6/7 相关断言。**触发即报告用户**（这是观感降级：细栏杆变实心墙）。
⚠️ 台阶族（3,479 格）**不进保险丝**：降级成整块会丢掉楼梯可走性，比 cutout 预算更伤。

- [ ] **Step 3: Commit（若触发保险丝，等用户指令）**

---

### Task 8: 全量回归 + 交付

- [ ] **Step 1: 全量**

Run: `npm run check` + `npm test`
Expected: 全绿。红的 spec 先判是否本改动引起（`git stash` 禁用——工作区有他人未提交改动；用「逐文件回退本任务改动」方式二分，或直接读失败信息定位）。

- [ ] **Step 2: 汇报**

交付物清单 + 实测数字（contentCells、cutout 峰值、截图）+ 龙的已知状态（被罩在碗内，待后续单独调）。**提交等用户指令**。
