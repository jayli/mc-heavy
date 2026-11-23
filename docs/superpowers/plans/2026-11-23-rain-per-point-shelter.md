# 雨的逐点遮挡 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让玩家躲在屋里/檐下/棚下时，棚下无雨无水汪、棚外照常下雨有水汪有镜面反射，且挖放方块当帧跟随。

**Architecture:** CPU 维护一张 512×512 RGBA8 环形窗口纹理，每格列存「从云层上界往下第一个截停面的高度」+「有无暴露水面」。雨丝/水花 CPU 查表（零体素扫描），湿表面片元用 `wp + faceNormal*0.5` 作探针 `textureLoad` 采表比较高度。删掉两个「玩家室内 ⇒ 全局关」总闸。

**Tech Stack:** three r185.1 本地 vendor（import map）+ TSL/WebGPU；Node 26 单测；Playwright Tier 4 像素门。

**Spec:** `docs/superpowers/specs/2026-11-23-rain-per-point-shelter-design.md`

## 已验证的前置（本轮探针，实施时不必重做）

方案的核心 GPU 机制**已实测 PASS**，不是推测：

- `tests/tmp-shelter-rawbytes.spec.mjs`：`copyTextureToBuffer` 读回 GPU 原始字节，
  三种 colorSpace 下均与 CPU 写入逐位相同 ⇒ 上传侧无问题、数据纹理不被 sRGB 解码。
- `tests/tmp-shelter-texload.spec.mjs`：片元 `textureLoad` 取回 8×8 纹理，
  **64/64 texel 三通道全对**（badR=0/badG=0/badB=0），零 GPU 验证错误。
- CPU 扫描成本（`column.blocks` 直读）：**0.0122 ms/column**（= 0.048 µs/格列），
  8 column/帧 = 0.098 ms；比逐格 `getBlockId` 快 **23.6 倍**。
  与既有 `rainStopY` 在 4000 个采样点上 **0 处不符**。

⚠️ **探针自身的三个测量错误已记入 spec §4.6b**，实施时写任何「把数据当颜色读回」
的探针必须先做两件事：① 关显示变换（`NoToneMapping` + `LinearSRGBColorSpace`）并用常量
灰阶标定作前提断言；② **不要翻取样行**（WebGPU `screenCoordinate.y` 自顶向下，与 PNG 同向），
且读**全部** texel 而不是一行。

## Global Constraints

- 依赖方向 `voxel ← gen ← mesh ← render`；`core/` 是装配层。新增 three-free 模块不得 import three（红线 8/10，`check:arch` 静态门）。
- **不改** packed 位段布局、顶点字节数、方块声明顺序/数量、任何既有 uniform 的名字与语义。
- **不改** 雨量/雨丝观感常量/水汪反光强度 —— 本轮只改生效范围。
- 每帧扫描预算 **8 个 column**（= 2048 格列）。实测：`column.blocks` 直读 **0.0122 ms/column**
  ⇒ 8 column/帧 = **0.098 ms**；逐格 `getBlockId` 慢 **23.6 倍**（2.309 ms）⇒ **必须缓存 column 引用后直读**。
  ⚠️ 「column」= 16×16×128 区块，含 256 个「格列」—— 两个单位不得混用。
- 窗口 `SHELTER_MAP_SIZE = 512`（= 32×32 = **1024 column**，全扫 12.5 ms ⇒ 不得首帧全扫）；
  编码 `R = (stopY - (WORLD_MIN_Y - 1)) * 2`，`R=0` 是「未知/无截停」哨兵。
- **texel 索引用绝对坐标** `floor(x) & 511`，**不是** `(floor(x)-origin) & 511`。
  后者原点一动整窗失效（实测），且 GPU 侧因此**不需要原点 uniform**。
- `SHELTER_EPS = 1/512`，CPU/GPU 两侧读同一份。
- 探针 = `wp + faceNormal * 0.5`；**遮挡判据 = `stopY > floor(probe.y) + 1 + EPS`**
  （格顶口径）。⚠️ **不得用 `probe.y <= stopY + EPS`** —— 那会把三款 slab、横柱、床的
  露头顶面判成「干」（几何顶面 0.5/0.65，探针恰好共面）。实测 1032 例穷举 0 不符。
- `uWetShelter` 是第四级零回归锚点（写 0 逐位回到 v3.33）。
- 预热：开档当帧扫玩家周围 **3×3 = 9 column**（0.11 ms），**不是**「满预算 8 column」。
- 挡雨判据 = `solidTable===1 && hollowOccluderTable!==1 && id!==cloudId`。
- 时间基准一律 `performance.now()`，禁 `Date.now()`。
- 负向验证注入用 `edit`（不用 `sed`），还原用 `cp` 副本（**不用 `git checkout`**），注入后读回源码确认落地。
- 长跑（>1min）用 `run_in_background`；测试命令**不接管道**（会把退出码换成末端工具的）。
- 冻结数字不符时**停下报告**，不擅自放宽阈值。

## Review Focus

1. **玩家在屋内向外看** —— 屋外雨丝/水花必须仍上屏（这是用户报告的原缺陷，最易在「删总闸」时改成另一个总闸）。Task 5 的 C1。
2. **台阶/半砖盖的棚子** —— 必须挡雨（现行判据漏掉 21 个方块，含全部台阶）。Task 1 的 Tier 1 逐个断言。
3. **非整格顶面方块的露头顶面** —— slab/横柱/床 必须湿（探针共面陷阱，静默产生「台阶砖永远不湿」）。Task 3 的 slab 用例 + 负向④。
4. **屋外地面与屋顶顶面** —— 遮挡门一个字节都不许碰它们（探针法线偏移是核心机制）。Task 4 的 C5/C6 + 负向①。
5. **挖掉屋顶 / 搭起棚子 / 窗口平移** —— 当帧跟随且绝对索引不漂移。Task 2 的失效/平移用例 + 负向⑤。
6. **关掉雨天光影** —— 逐位回到改动前，且不推进扫描、不上传纹理。Task 5 的 C7 + 零成本断言。

---

### Task 1: 挡雨判据修正（屋顶语义）

**Files:**
- Modify: `src/render/rain-shelter.js`（`blocksRain` 函数体 + 文件头注释）
- Test: `src/tests/test-rain-shelter.js`（改两条旧口径用例 + 加台阶族用例）

**Interfaces:**
- Produces: `blocksRain(id, registry): boolean` —— 签名不变，判据改为读 `hollowOccluderTable`。后续所有任务共用它。

- [ ] **Step 1: 写失败测试**

在 `src/tests/test-rain-shelter.js` 追加（放在「规则①②」段内）：

```js
test('rain shelter: 台阶/半砖/栏杆/柱子/箱子都挡雨（棚子最常见的建材）', () => {
  for (const n of ['planks_step', 'planks_step_updown', 'cobblestone_step',
    'cobblestone_step_updown', 'stone_diorite_step', 'sand_step', 'sand_slab',
    'half_block_updown', 'obsidian_brick_step', 'obsidian_brick_step_updown',
    'end_stone_brick_step', 'end_stone_brick_step_updown',
    'obsidian_brick_slab', 'end_stone_brick_slab',
    'handrail', 'handrailA', 'handrailB', 'vertical_pillar', 'horizontal_pillar',
    'chest']) {
    assertTrue(blocksRain(id(n), REG), `${n} 是实心建材，必须挡雨`);
  }
});

// 仙人掌单列：它挡雨对，但 geometry='cactus' 顶面 1.05（超出单元格），
// 不是常规建材 —— 与台阶并列会让后来者误以为它是同类。
test('rain shelter: 仙人掌挡雨（顶面 1.05，超出单元格的特例）', () => {
  assertTrue(blocksRain(id('cactus'), REG));
});
```

同时把两条旧口径用例改成新口径（**不是放宽，是判据修正**，实测清单见 spec §2.3）：
- 「全部树叶族不挡雨（cutout 通道）」→ 筛选条件改 `REG.hollowOccluderTable[id(b.name)] === 1`，断言 ≥13 个；
- 「判据是「实心且非 cutout 且非云」，不是名字白名单」→ 期望式改
  `REG.solidTable[bid] === 1 && REG.hollowOccluderTable[bid] !== 1 && b.name !== 'cloud'`，
  用例名同步改成「实心且非镂空遮挡体且非云」。

- [ ] **Step 2: 跑测试确认失败**

Run: `node tools/run-unit-node.mjs --only=test-rain-shelter.js`
Expected: FAIL —— 台阶族用例报 `planks_step 是实心建材，必须挡雨`；改口径后的两条也红。

- [ ] **Step 3: 改判据**

`blocksRain` 里把 `if (registry.cullTable[id] === 1) return false;` 换成
`if (registry.hollowOccluderTable[id] === 1) return false;`，注释写明：
镂空遮挡体（13 个树叶族）才不挡；台阶/栏杆/柱子虽在 cutout 通道但是实心建材，必须挡。
文件头「① 屋顶拦雨」那段同步改口径描述。

- [ ] **Step 4: 跑测试确认通过**

Run: `node tools/run-unit-node.mjs --only=test-rain-shelter.js,test-water-surface.js,test-storm-rain.js,test-rain.js`
Expected: PASS（`rain.js` 共用本判据，一并验）

- [ ] **Step 5: 负向验证**

用 `edit` 把判据改回 `cullTable[id] === 1`，读回源码确认落地，跑 Step 2 的命令 ⇒ 台阶族用例必须 FAIL；用 `cp` 副本还原。

- [ ] **Step 6: Commit**

```bash
git add src/render/rain-shelter.js src/tests/test-rain-shelter.js
git commit -m "fix(rain): 挡雨判据改读镂空遮挡体表，台阶/栏杆/柱子不再漏判"
```

---

### Task 2: 遮挡数据层（编码 + 扫描 + 失效，three-free）

**Files:**
- Create: `src/voxel/rain-occlusion-data.js`
- Create: `src/render/rain-shelter-map.js`
- Create: `src/tests/test-rain-shelter-map.js`
- Modify: `src/tests/index.html`（注册新测试）
- Modify: `tools/test-tiers.mjs`（`UNIT_NODE_SAFE` 加 `test-rain-shelter-map.js`）

**Interfaces:**
- Consumes: `blocksRain`（Task 1）、`isWaterLike` / `WATER_SURFACE_Y`（`render/water-surface.js`）、`RAIN_CEILING_Y`（`render/rain-shelter.js`）。
- Produces（`voxel/rain-occlusion-data.js`，全部 three-free）：
  - `SHELTER_MAP_SIZE = 512`
  - `SHELTER_EPS = 1/512`
  - `SHELTER_Y_BASE = WORLD_MIN_Y - 1`（= −33）
  - `encodeStopY(y: number|null): number` —— null ⇒ 0；否则 `round((y - SHELTER_Y_BASE) * 2)`
  - `decodeStopY(enc: number): number|null` —— 0 ⇒ null；否则 `enc/2 + SHELTER_Y_BASE`
  - `shelterTexelIndex(x: number, z: number): number` —— **绝对索引** `(floor(x) & 511) + ((floor(z) & 511) << 9)`，返回 texel 序号（字节偏移 = ×4）。⚠️ **不接 origin 参数** —— 相对索引会让原点一动整窗失效。
  - `SHELTER_WINDOW_COLS = SHELTER_MAP_SIZE / 16`（= 32，窗口每边多少 column）
- Produces（`render/rain-shelter-map.js`，three-free class `RainShelterMap`）：
  - `new RainShelterMap({ world, registry })`
  - `data: Uint8Array(512*512*4)` —— 纹理字节，唯一权威
  - `originX / originZ: number` —— 窗口原点（16 对齐）
  - `stopAt(x, z): number|null`、`waterAt(x, z): boolean` —— 窗外/未知一律返回 `null` / `false`
  - `setCenter(x, z): void` —— 原点跟随（16 格步进），平移时清零 `(originOLD & 511)..+15` 条带并入队
  - `warmup(x, z): number` —— 同步扫玩家周围 **3×3 = 9 column**（不走每帧预算），返回实扫数
  - `invalidateColumn(cx, cz): void` —— 插队首
  - `tick(budget = 8): number` —— 消费队列（单位 **column**），返回本帧实扫数；>0 表示纹理需重传
  - `debugState(): { queued, scanned, originX, originZ, lastTickColumns }`

- [ ] **Step 1: 建文件 + 注册三处，再写失败测试**

⚠️ **顺序是载荷性的**：`run-unit-node.mjs --only` 对不在 `UNIT_NODE_SAFE` 的文件
**硬失败**（实测：报「不在 Node 白名单内」而不是跑测试）。故必须先完成：
1. 新建 `src/tests/test-rain-shelter-map.js`（先只放 1 条必红用例）；
2. `src/tests/index.html` 加 `import './test-rain-shelter-map.js';`；
3. `tools/test-tiers.mjs` 的 `UNIT_NODE_SAFE` 加 `'test-rain-shelter-map.js'`。
三处缺一不可：漏 2 或 3 会被 `check:data` 的双向门抓红。

用 `createRegistry` + `BLOCKS` 建表（照 `test-rain-shelter.js` 口径），用真实
`fillColumn(col, SEED, REG)` 造地形（**三参**，已核；照 `test-terrain.js` 口径）。
⚠️ `col.state = 'ready'` 要手动置（`fillColumn` 不置），否则被测实现若按 state 过滤会扫不到。

断言：

1. 编码往返：对 `[WORLD_MIN_Y+1, WORLD_MIN_Y+1.5, 0, 0.5, RAIN_CEILING_Y+1]` 逐个 `decodeStopY(encodeStopY(y)) === y`；`encodeStopY(null) === 0`、`decodeStopY(0) === null`。
2. 值域上界：`encodeStopY(RAIN_CEILING_Y + 1) <= 255`（关系式，不写死 136）。
3. **f32 往返 + 格顶判据边界**：对全部合法编码 e（`4..encodeStopY(RAIN_CEILING_Y+1)`），
   `Float32Array` 存 `e/255` 再解出 `stop`；取探针格顶 `cellTop = floor(probeY)+1`，断言：
   · `probeY = stop - 0.5`（半格之下）⇒ `stop > cellTop + EPS` 为真（必判遮挡）；
   · `probeY = stop`（探针恰在格顶，即半砖顶面）⇒ `stop > cellTop + EPS` 为假（必判不遮挡）。
   ⚠️ **不得写成 `exact <= stop + EPS`** —— 那是旧 `probe<=stop` 语义，
   数值上恒真但**对新判据零判别力**（本轮自审实测：133 个编码全过，即使判据写反也全过）。
4. 单遍扫描 ≡ `rainStopY`：真实地形上 ≥2000 个格列，`map.stopAt(x+0.5, z+0.5)` 与 `rainStopY(world, REG, x+0.5, z+0.5, RAIN_CEILING_Y, 128)` 逐位相等（null 对 null）。注释写明这条钉的是「单遍首命中 ≡ 两遍取 max」，对挡雨判据本身零判别力。
5. **屋顶下的格列 stop = 屋顶顶面**：在 (4,4) 列 y=0 铺地板、y=9 盖 `stone_bricks` ⇒ `stopAt(4.5,4.5) === 10`（不是 1）。这是 spec §2.2 缺陷的判别力锚点。
6. 台阶棚子：屋顶换 `planks_step` ⇒ 同样 `=== 10`（Task 1 的判据在这里被端到端消费）。
7. 水体列：`waterAt` 为真且 `stopAt === WATER_SURFACE_Y`。
8. **屋顶盖住的水面**：水上盖屋顶 ⇒ `waterAt` 为假（语义有意收窄，spec §4.7），且 `stopAt` = 屋顶顶面。
9. 失效：`col.version++` 后 `tick()` 必须重扫该列（改屋顶高度后 `stopAt` 跟着变）。
10. `invalidateColumn` 插队首：队列里塞满远处列，invalidate 近处某列 ⇒ 下一次 `tick(1)` 扫的是它。
11. 预算：队列 > 8 时 `tick()` 返回值 `=== 8`；`tick(0)` 返回 0。
12. 未知安全失败：从未扫过的坐标 `stopAt === null`、`waterAt === false`。
13. 窗口平移：`setCenter` 移动 16 格后，新露出的格列在被扫到之前必须返回 `null`。
14. **绝对索引不变性**：`shelterTexelIndex(-1,-1) === 511 + (511<<9)`；
    且 `setCenter` 前后 **同一绝对坐标的 texel 序号不变**（相对索引会在这里 FAIL）。
15. **平移清零条带位置**：取 `originX = 0 / 16 / 496 / 1008 / -32`，逐个断言被清零的
    texel 集合 ≡ `(originX_OLD & 511) .. +15`（环形）。
    ⚠️ 固定 `[0,15]` 与审阅建议的 `((O+16)&511)..+15` **两种错写均必须在此 FAIL**。
16. **预热**：`warmup(x,z)` 返回 9，且玩家周围 3×3 column 均已扫（不是 8）。
17. 静止世界零成本：连扫两轮后第三次 `tick()` 返回 0。

- [ ] **Step 2: 跑测试确认失败**

Run: `node tools/run-unit-node.mjs --only=test-rain-shelter-map.js`
Expected: FAIL —— 模块不存在（import 硬失败，runner 刻意不 catch）。
⚠️ 若报的是「不在 Node 白名单内」⇒ Step 1 的注册三处没做完，**那不是真正的 RED**。

- [ ] **Step 3: 实现两个模块**

`voxel/rain-occlusion-data.js`：只有常量与三个纯函数，无状态。
`render/rain-shelter-map.js`：
- 构造时按 registry 建 `rainTab` / `waterTab`（`Uint8Array(registry.count)`），热循环只读字节；
- **扫描必须缓存 column 引用后直读 `col.blocks`**（实测比逐格 `getBlockId` 快 23.6 倍）：
  `for y = RAIN_CEILING_Y .. WORLD_MIN_Y`，首个 `rainTab[id]` ⇒ `stop=y+1` break；
  首个 `waterTab[id] && opaqueTable[prev]!==1 && prev!==id` ⇒ `stop=y+1-WATER_SURFACE_SINK`、`hasWater=1` break；`prev=id`；
- 有效性用**清零**而非哈希（哈希碰撞会静默读到别的列）；`setCenter` 平移时清
  **`(originX_OLD & 511) .. +15`**（环形，**不是固定 `[0,15]`、也不是 `+16`**）并把对应 column 入队；
- 队列按到中心的切比雪夫距离排序，`invalidateColumn` 用 `unshift`；
- `tick(budget)` 逐 column 出队 → 扫描 → 写 256 个 texel × 4 字节 → 记 `version`；返回实扫数；
- `warmup(x,z)` 同步扫 3×3 column，**不受 budget 限制**。

- [ ] **Step 4: 跑测试确认通过**

Run: `node tools/run-unit-node.mjs --only=test-rain-shelter-map.js`
Expected: PASS（17 例）

- [ ] **Step 5: 负向验证**

用 `edit` 把扫描起点从 `RAIN_CEILING_Y` 改成「传入的 y」（模拟 spec §2.2 的原缺陷），读回确认，跑 Step 4 ⇒ 第 5/6 条必须 FAIL；`cp` 还原。

- [ ] **Step 6: 静态门**

Run: `npm run check`
Expected: PASS（新模块在 `src/voxel` / `src/render`，不得 import three；测试注册与分档双向一致）

- [ ] **Step 7: Commit**

```bash
git add src/voxel/rain-occlusion-data.js src/render/rain-shelter-map.js src/tests/test-rain-shelter-map.js src/tests/index.html tools/test-tiers.mjs
git commit -m "feat(rain): 逐列遮挡高度图的数据层（扫描/失效/编码，three-free）"
```

---

### Task 3: 纹理封装与 CPU 同构门函数

**Files:**
- Create: `src/render/rain-shelter-texture.js`
- Modify: `src/render/wet-surface-config.js`（加 `wetShelterGate` 纯函数）
- Modify: `src/tests/test-wet-surface.js`（加门函数用例）

**Interfaces:**
- Consumes: `SHELTER_MAP_SIZE` / `SHELTER_Y_BASE` / `SHELTER_EPS`（Task 2）。
- Produces:
  - `SHELTER_TEXTURE`（模块级单例 `THREE.DataTexture`，512×512 RGBA8，`flipY=false`、`generateMipmaps=false`、`min/magFilter=NearestFilter`、`wrapS/T=ClampToEdgeWrapping`，初值全 0）
  - `uploadShelterTexture(data: Uint8Array): void` —— 把 map 的字节 copy 进单例并置 `needsUpdate`
  - `wetShelterGate(probeY: number, stopEnc: number, strength: number): number`（three-free，在 `wet-surface-config.js`）—— 返回 0..1 的可见系数

- [ ] **Step 1: 写失败测试**

在 `src/tests/test-wet-surface.js` 追加：

```js
test('wet shelter gate: 未知/关档恒 1，棚下 0，棚外 1（CPU 与 GPU 同构）', () => {
  const roof = encodeStopY(10);        // 屋顶顶面 y=10
  assertEqual(wetShelterGate(10.5, 0, 1), 1, 'R=0 未知 ⇒ 不遮挡');
  assertEqual(wetShelterGate(5.5, roof, 0), 1, 'strength=0 ⇒ 逐位回到 v3.33');
  assertEqual(wetShelterGate(5.5, roof, 1), 0, '探针在屋顶之下 ⇒ 干');
  assertEqual(wetShelterGate(10.5, roof, 1), 1, '屋顶自身顶面之上 ⇒ 湿');
});

// ★ P0-2 的判别力锚点：非整格顶面方块的露头顶面必须湿
// 实测几何顶面（真实 TEMPLATES）：half_block=0.5、horizontal_pillar=0.65、cactus=1.05
test('wet shelter gate: 半砖/横柱/仙人掌的露头顶面必须湿（探针共面陷阱）', () => {
  const ground = encodeStopY(1);       // 方块在 y=0，格顶 stop=1
  // 半砖：几何顶面 0.5 ⇒ 探针 0.5+0.5 = 1.0（恰好共面）
  assertEqual(wetShelterGate(1.0, ground, 1), 1, 'sand_slab 露头顶面不得被判干');
  // 横柱：0.65+0.5 = 1.15
  assertEqual(wetShelterGate(1.15, ground, 1), 1, 'horizontal_pillar 露头顶面必须湿');
  // 仙人掌：1.05+0.5 = 1.55
  assertEqual(wetShelterGate(1.55, ground, 1), 1, 'cactus 露头顶面必须湿');
  // 半砖棚顶自身（棚顶在 y=4，几何顶面 4.5，探针 5.0，stop=5）
  assertEqual(wetShelterGate(5.0, encodeStopY(5), 1), 1, '半砖棚顶自身必须湿');
});
```

再加一条**穷举用例**：全部挡雨方块（`solid ∧ 非hollow ∧ 非cloud`）× cellY 0..3 ×
有/无上方屋顶（y=6），顶面探针 = `cellY + 几何顶面 + 0.5`，期望：有屋顶 ⇒ 干，无 ⇒ 湿。
实测基准 **1032 例 0 不符**（几何顶面从真实 `TEMPLATES` 算，不写死）。

（`encodeStopY` 从 `voxel/rain-occlusion-data.js` import。）

- [ ] **Step 2: 跑测试确认失败**

Run: `node tools/run-unit-node.mjs --only=test-wet-surface.js`
Expected: FAIL —— `wetShelterGate is not a function`（或 import 报错）

- [ ] **Step 3: 实现**

`wetShelterGate`：`stopEnc <= 0 ⇒ 1`；`strength <= 0 ⇒ 1`；否则解码
（**显式走一遍 `Float32Array` 的 `enc/255` 量化再 `×127.5`**，与 GPU 逐位同构），
判据 **`stop > Math.floor(probeY) + 1 + SHELTER_EPS ? 1 - strength : 1`**。
⚠️ **不得写成 `probeY <= stop + EPS`** —— 那会把半砖/横柱/床的露头顶面判干（P0-2）。
`rain-shelter-texture.js`：建单例 + `uploadShelterTexture`。⚠️ 头注释写明「本文件依赖 three，故放 render/ 不放 voxel/」。
构造配方照 spec §4.6（已实测 PASS）：`RGBAFormat` + `UnsignedByteType`、`flipY=false`、
`generateMipmaps=false`、`min/magFilter=NearestFilter`；`textureLoad` **自带 `setSampler(false)`**，
不需 `storageTexture` 也不需 `unwrap`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node tools/run-unit-node.mjs --only=test-wet-surface.js,test-puddle-reflect.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/render/rain-shelter-texture.js src/render/wet-surface-config.js src/tests/test-wet-surface.js
git commit -m "feat(rain): 遮挡纹理单例与 CPU 同构遮挡门"
```

---

### Task 4: 湿表面接线（片元遮挡门）

**Files:**
- Modify: `src/render/wet-surface.js`（加 `uWetShelter` uniform + 片元门）

**Interfaces:**
- Consumes: `SHELTER_TEXTURE`（Task 3）、`SHELTER_MAP_SIZE` / `SHELTER_Y_BASE` / `SHELTER_EPS`（Task 2）。
- Produces: `WET_SURFACE_UNIFORMS.uWetShelter`（默认 1）。⚠️ **不需 `uShelterOrigin`** —— 绝对索引下 GPU 不关心窗口原点。

- [ ] **Step 1: 加 uniform 与片元门**

在 `WET_SURFACE_UNIFORMS` 加 `uWetShelter`（注释写明第四级零回归锚点）。
在 `createWetSurfaceNode` 里，`const wet = ...` 那行**之后**插入门：

```js
// 探针推到面外半格（法线偏移是核心机制，删不得）
const probe = add(wp, faceNormal.mul(0.5));
// ⚠️ 绝对索引（不减窗口原点）；坐标可能为负 ⇒ **先 int 再 bitAnd**
// （int 位与是二进制补码 ⇒ -1 & 511 = 511，与 JS 的 & 逐位同构；
//   先 uint 会把负 float 转成未定义值，读到垃圾 texel）
const tx = int(floor(probe.x)).bitAnd(int(SHELTER_MAP_SIZE - 1));
const tz = int(floor(probe.z)).bitAnd(int(SHELTER_MAP_SIZE - 1));
const sh = textureLoad(SHELTER_TEXTURE, ivec3(tx, tz, int(0)));
const known = step(float(0.5 / 255), sh.r);
const stopY = add(sh.r.mul(255 / 2), float(SHELTER_Y_BASE));
// ★ 格顶判据：截停面严格高于探针所在格的格顶 ⇒ 头上真的有盖
// （而不是「探针撞到自己这一格的表面」—— 后者把半砖/横柱/床的露头顶面判干）
// ⚠️ step(edge, x) = x >= edge ? 1 : 0 ⇒ **edge 传 cellTop、x 传 stopY，且不取反**。
// 写反（oneMinus(step(...))）会得到**完全 inverted 的门**：露天全干、棚下全湿
// （本轮 CPU 同构校验实测 7/8 例判反，已修）。
const cellTop = add(floor(probe.y), float(1 + SHELTER_EPS));
const sheltered = mul(known, step(cellTop, stopY));
// 窗外保护：绝对索引会 wrap 到别的格列 ⇒ 远处强制不遮挡（与难距一致）
const horiz = length(vec2(probe.x.sub(cameraPosition.x), probe.z.sub(cameraPosition.z)));
const inWindow = oneMinus(step(float(SHELTER_MAP_SIZE / 2), horiz));
const shelterGate = mix(float(1), oneMinus(mul(sheltered, inWindow)), U.uWetShelter);
```

⚠️ `step(cellTop, stopY)` = `stopY >= cellTop ? 1 : 0` ⇒ `sheltered=1` 即「stop 高于格顶 = 被挡」。
**不要再套 `oneMinus`** —— CPU 同构函数与它必须同方向（已用 8 个关键场景逐例校验）。
⚠️ `textureLoad` 自带 `setSampler(false)`（vendor 已核），直接喂 `DataTexture` 即可，
不需 `storageTexture`、不需 `unwrap`。`ivec3` 接受 int 节点。

把 `wet` 乘上 `shelterGate`（**五项一起归零**：压暗/水膜/水汪镜面/真倒影/太阳高光都从 `wet` 派生）。
⚠️ `puddleW` 也要乘 —— 它独立于 `wet` 参与 `skyMul` 与真倒影权重。

TSL 口径照既有七条：不与裸数字算术、不用 `.toVar()/.assign()`（本函数不在 `Fn()` 体内）、`textureLoad` 从 `three/tsl` import。

- [ ] **Step 2: 静态门 + 单测**

Run: `npm run check && node tools/run-unit-node.mjs --only=test-wet-surface.js,test-puddle-reflect.js`
Expected: PASS（uniform 初值用例要加 `uWetShelter === 1`）

- [ ] **Step 3: 浏览器冒烟（确认无 WebGPU 验证错误）**

Run（后台）: `npx playwright test tests/wet-surface.spec.mjs -g "材质分层"`
Expected: PASS 且无 `GPUValidationError`。若报 `Unsupported texture format` / 绑定错 ⇒ 停下查纹理格式，不改判据。
⚠️ 先确认 `-g` 真的命中了用例（输出里的 `1 passed` 而不是 `0 tests`）——
既有用例名是「湿表面②：材质分层 —— …」，含该词；改名时要同步。

- [ ] **Step 4: Commit**

```bash
git add src/render/wet-surface.js src/tests/test-wet-surface.js
git commit -m "feat(wet): 湿表面按遮挡高度图逐片元门控（棚下干、棚外湿）"
```

---

### Task 5: 雨丝/水花查表 + 装配层删总闸

**Files:**
- Modify: `src/render/storm-rain.js`
- Modify: `src/core/game.js`（装配 map、每帧 tick、删 `uWet` 室内门、订阅编辑事件）
- Modify: `tests/storm-lighting.spec.mjs`（重写「室内不生效」那条为逐点判据）

**Interfaces:**
- Consumes: `RainShelterMap`（Task 2）、`uploadShelterTexture`（Task 3）、`WET_SURFACE_UNIFORMS.uWetShelter`（Task 4）。
- Produces: `StormRain.debugState()` 新增 `shelterColumns`（本帧扫描列数）；`underRoof` 语义改为「玩家所在处是否被遮挡」，**只喂音频**。

- [ ] **Step 1: 重写 Tier 4 用例（先 RED）**

把 `tests/storm-lighting.spec.mjs:139` 的「室内不生效」整条替换成 spec §5 的 C1~C8 夹具与判据：
⚠️ **新用例名必须仍含「室内」二字**（建议「雨天光影：室内逐点遮挡（棚下干、棚外湿，屋外雨仍上屏）」）
—— Step 1 的 `-g "室内"` 靠它命中；改名不含该词会让 `-g` **命中 0 条而显示通过**（静默空跑）。
抛光石地面一半盖 `stone_bricks` 屋顶、相机在屋内朝外、取样区由真实投影算出、三态取样（dry / gated / ungated）、C5/C6 用**位级**差。
同时加「编辑往返」：挖掉屋顶 ⇒ 屋内地面变湿（`gated` 与 `ungated` 在该区逐字节相同）；盖回去 ⇒ 恢复。

Run（后台）: `npx playwright test tests/storm-lighting.spec.mjs -g "室内"`
Expected: FAIL —— C1 屋外雨丝为 0（总闸还在）

- [ ] **Step 2: 改 StormRain**

- 构造参数加 `shelterMap`（必填，装配层给）；
- `update()` 删掉 `if (this._underRoof) { ...visible=false; return; }` 整块，`_underRoof` 仍每帧算（喂音频）；
- `_resolveShelterBatch()` 把 `rainStopY` / `waterSurfaceYAt` 两次扫描换成 `this.shelterMap.stopAt(wx,wz)` / `.waterAt(wx,wz)`；
- `_spawnSplashes()` 落点改查表，删 `isUnderRoof` 那行。
  ⚠️ **落点公式**：`stop = map.stopAt(x, z)`；`if (stop === null) continue;`
  然后照旧判 `if (stop > playerPos.y + SP.maxAboveEye) continue;`，出生点 `y = stop + SP.floorOffset`。
  **不需要额外的「在屋顶下」判据** —— `stop` 本身就是该列最高截停面：
  屋内地板那一列的 `stop` = **屋顶顶面**（不是地板）⇒ 它要么被 `maxAboveEye` 滤掉（屋顶高于眼高），
  要么就是屋顶上方的合法落点。旧的 `isUnderRoof` 是对同一个事实的第二次扫描。
- 移除已不再使用的 `rainStopY` / `isUnderRoof` import（`isUnderRoof` 仍用于 `_underRoof`，保留）。

- [ ] **Step 3: 改装配层**

`game.js`：
- `setStormLighting(true)` 分支里惰建 `this.rainShelterMap = new RainShelterMap({ world, registry })`，传给 `StormRain`；
  建完立即 `map.setCenter(pp.x, pp.z)` → **`map.warmup(pp.x, pp.z)`**（3×3 = 9 column，0.11 ms）
  → `uploadShelterTexture(map.data)` ⇒ 开档当帧近处就正确（Tier 4 夹具在 ±7 格内，已覆盖）；
- `this.editor.subscribe(...)` 追加一条：`for (const c of event.changes) map.invalidateColumn(floor(c.x/16), floor(c.z/16))`（去重）；
- `_updateStorm()`：`map.setCenter(pp.x, pp.z)` → `const n = map.tick(8)` → `n > 0 && uploadShelterTexture(map.data)`；
  ⚠️ **上传必须早于本帧所有 render pass**（反射/阴影/主）—— 遮罩纹理是模块级单例，
  反射替身材质也采样它；pass 中途更新会让主画面与 RT 干湿不一致。
  现有帧循环顺序 `_updateStorm()` → `_renderWaterReflection()` → `renderer.render()` 已满足，不要改顺序。
  ⚠️ **不需要写任何原点 uniform**（绝对索引）—— 旧稿的 `uShelterOrigin` 已取消。
- **删掉** `wet.uWet.value = indoor ? 0 : WET_STRENGTH_MAX`，改成恒 `WET_STRENGTH_MAX`（遮挡交给片元门）；
- `setStormLighting(false)`：不 tick、不上传（零成本）。

- [ ] **Step 4: 跑 Tier 4 确认 GREEN**

Run（后台）: `npx playwright test tests/storm-lighting.spec.mjs`
Expected: PASS（含重写那条的 C1~C8 + 编辑往返）

- [ ] **Step 5: 负向验证五条**

按 spec §5 逐条注入（`edit` 注入 → 读回确认 → 跑 → `cp` 还原）：
① 删探针法线偏移 ⇒ C5 非零；② 扫描起点改回滴自身 y ⇒ C2 非零；
③ 判据改回 `cullTable!==1` ⇒ Task 1 台阶用例红；
④ 格顶判据改回 `probe.y <= stopY + EPS` ⇒ Task 3 的 slab/横柱露头顶面用例红；
⑤ 绝对索引改回 `(floor(x)-origin) & 511` ⇒ Task 2 的索引不变性与平移条带用例红。

- [ ] **Step 6: 消费方回归**

Run（后台）: `npx playwright test tests/storm-rain-visual.spec.mjs tests/storm-underwater.spec.mjs tests/wet-surface.spec.mjs tests/puddle-reflect.spec.mjs tests/m3-rain.spec.mjs`
Expected: PASS。既有冻结数字越线 ⇒ **停下报告**，不放宽。

- [ ] **Step 7: 热路径门禁**

Run（后台）: `npm run bench -- --check`
Expected: 回退 ≤10%。⚠️ 跑完若 `docs/m3-baseline.*` 被改写要 `git checkout` 恢复（不带 `--check` 才重写，但核对一次）。

- [ ] **Step 8: 最小充分集收尾**

Run: `npm run check && node tools/run-unit-node.mjs --only=test-rain-shelter.js,test-rain-shelter-map.js,test-wet-surface.js,test-storm-rain.js,test-mesher.js,test-water-surface.js,test-puddle-reflect.js`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/render/storm-rain.js src/core/game.js tests/storm-lighting.spec.mjs
git commit -m "feat(rain): 删两个室内总闸，雨丝/水花/湿表面统一走逐点遮挡"
```

---

### Task 6: 文档与坑目录

**Files:**
- Modify: `docs/roadmap.md`（新版本行 + 实测读数）
- Modify: `docs/pitfalls.md`（「雨的遮挡与高度」节追加本轮教训）

- [ ] **Step 1: 写文档**

roadmap 加版本行（改了什么 + 实测证据：扫描 0.0122 ms/column、8 column/帧 0.098ms、
直读比 getBlockId 快 23.6×、4000 点等价、21 个方块判据修正、格顶判据 1032 例穷举、Tier 4 各判据读数）。
pitfalls 追加四条：
1. 「玩家状态 ⇒ 全局开关」是遮挡类特效的通用错误形态，正解是空间数据 + 逐点门；
2. 逐滴扫描起点取「滴自己的 y」永远看不到头顶的屋顶（被总闸掩盖的静默缺陷）；
3. `cullTable!==1` 会把台阶/栏杆/柱子当成不挡雨 —— 正解读 `hollowOccluderTable`；
4. **像素探针必须先去变换、再确认行方向**（本轮连踩三次，详见 spec §4.6b）：
   ① ACES+sRGB 把字节 4→15、136→201，直接比「屏幕字节==纹理编码」得出 64/64 不符的假结论；
   ② 用 6 点标定 LUT 反查也不行（ACES 压缩段相邻编码映到同一字节）；
   ③ **WebGPU `screenCoordinate.y` 自顶向下**，照 OpenGL 习惯翻行会读到对面那一行；
   等差编码序列下它表现为「恒偏 +112」，而 0/255 交替通道因 SIZE 是偶数而奇偶性不变
   ⇒ 极易误读成「只有 R 通道坏了」。**只读一行的探针发现不了行错位**。
5. **判据异常时先怀疑测量方法**：本轮「R 恒偏常量」的第一反应是查 colorSpace / 节点缓存 /
   通道 swizzle，全部白跑；把观测值**反查编码表**才一步定位到行错位（全部落在 ty=7）。

- [ ] **Step 2: 静态门**

Run: `npm run check`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add docs/roadmap.md docs/pitfalls.md
git commit -m "docs(rain): 逐点遮挡的实测读数与四条坑"
```

---

## 收尾

- 删除一次性探针（**用 literal path，不用通配符**）：
  `tests/tmp-shelter-texload.spec.mjs`、`tests/tmp-shelter-rawbytes.spec.mjs`。
  ⚠️ 删前先把探针 B 的纹理构造与节点写法抄进 spec §4.6（已抄）—— 它是唯一参照样本。
- 全套 `npm test` **不跑** —— 本改动不属「全局基础设施」，最小充分集已在 Task 5 Step 6/8 覆盖。
- 提交等用户明确指令（计划里的 commit 步骤是计划的一部分，执行时仍按用户指令）。