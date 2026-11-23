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
- CPU 扫描成本：**0.0174 ms/列**，与既有 `rainStopY` 在 4000 个采样点上 **0 处不符**。

⚠️ **探针自身的三个测量错误已记入 spec §4.6b**，实施时写任何「把数据当颜色读回」
的探针必须先做两件事：① 关显示变换（`NoToneMapping` + `LinearSRGBColorSpace`）并用常量
灰阶标定作前提断言；② **不要翻取样行**（WebGPU `screenCoordinate.y` 自顶向下，与 PNG 同向），
且读**全部** texel 而不是一行。

## Global Constraints

- 依赖方向 `voxel ← gen ← mesh ← render`；`core/` 是装配层。新增 three-free 模块不得 import three（红线 8/10，`check:arch` 静态门）。
- **不改** packed 位段布局、顶点字节数、方块声明顺序/数量、任何既有 uniform 的名字与语义。
- **不改** 雨量/雨丝观感常量/水汪反光强度 —— 本轮只改生效范围。
- 每帧扫描预算 **8 列**（实测 0.0174 ms/列 ⇒ 0.139 ms）。
- 窗口 `SHELTER_MAP_SIZE = 512`；编码 `R = (stopY - (WORLD_MIN_Y - 1)) * 2`，`R=0` 是「未知/无截停」哨兵。
- `SHELTER_EPS = 1/512`，CPU/GPU 两侧读同一份。
- 探针 = `wp + faceNormal * 0.5`；`uWetShelter` 是第四级零回归锚点（写 0 逐位回到 v3.33）。
- 挡雨判据 = `solidTable===1 && hollowOccluderTable!==1 && id!==cloudId`。
- 时间基准一律 `performance.now()`，禁 `Date.now()`。
- 负向验证注入用 `edit`（不用 `sed`），还原用 `cp` 副本（**不用 `git checkout`**），注入后读回源码确认落地。
- 长跑（>1min）用 `run_in_background`；测试命令**不接管道**（会把退出码换成末端工具的）。
- 冻结数字不符时**停下报告**，不擅自放宽阈值。

## Review Focus

1. **玩家在屋内向外看** —— 屋外雨丝/水花必须仍上屏（这是用户报告的原缺陷，最易在「删总闸」时改成另一个总闸）。Task 5 的 C1。
2. **台阶/半砖盖的棚子** —— 必须挡雨（现行判据漏掉 21 个方块，含全部台阶）。Task 1 的 Tier 1 逐个断言。
3. **屋外地面与屋顶顶面** —— 遮挡门一个字节都不许碰它们（探针法线偏移是核心机制，删掉它就全错）。Task 4 的 C5/C6 + 负向①。
4. **挖掉屋顶 / 搭起棚子** —— 当帧跟随，不等节流轮到。Task 2 的失效用例 + Task 5 的编辑往返。
5. **关掉雨天光影** —— 逐位回到改动前，且不推进扫描、不上传纹理。Task 5 的 C7 + 零成本断言。

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
    'chest', 'cactus']) {
    assertTrue(blocksRain(id(n), REG), `${n} 是实心建材，必须挡雨`);
  }
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
  - `shelterTexelIndex(x: number, z: number, originX: number, originZ: number): number` —— `((floor(x)-originX) & 511) + (((floor(z)-originZ) & 511) << 9)`，返回 texel 序号（字节偏移 = ×4）
- Produces（`render/rain-shelter-map.js`，three-free class `RainShelterMap`）：
  - `new RainShelterMap({ world, registry })`
  - `data: Uint8Array(512*512*4)` —— 纹理字节，唯一权威
  - `originX / originZ: number` —— 窗口原点（16 对齐）
  - `stopAt(x, z): number|null`、`waterAt(x, z): boolean` —— 未知一律返回 `null` / `false`
  - `setCenter(x, z): void` —— 原点跟随（16 格步进），平移时清零失效条带并入队
  - `invalidateColumn(cx, cz): void` —— 插队首
  - `tick(budget = 8): number` —— 消费队列，返回本帧实扫列数；>0 表示纹理需重传
  - `debugState(): { queued, scanned, originX, originZ, lastTickColumns }`

- [ ] **Step 1: 写失败测试**

新建 `src/tests/test-rain-shelter-map.js`。用 `createRegistry` + `BLOCKS` 建表（照 `test-rain-shelter.js` 口径），用真实 `fillColumn(col, SEED, REG)` 造地形（照 `test-terrain.js` 口径，**注意 fillColumn 是三参**）。断言：

1. 编码往返：对 `[WORLD_MIN_Y+1, WORLD_MIN_Y+1.5, 0, 0.5, RAIN_CEILING_Y+1]` 逐个 `decodeStopY(encodeStopY(y)) === y`；`encodeStopY(null) === 0`、`decodeStopY(0) === null`。
2. 值域上界：`encodeStopY(RAIN_CEILING_Y + 1) <= 255`（关系式，不写死 136）。
3. **f32 往返 + EPS**：对全部合法编码 e，`Float32Array` 存 `e/255` 再解出 `stop`，断言 `e/2 + SHELTER_Y_BASE <= stop + SHELTER_EPS`（共面必判遮挡）且 `exact - 0.5 < stop + SHELTER_EPS`（半格之下必判遮挡）。
4. 单遍扫描 ≡ `rainStopY`：真实地形上 ≥2000 个格列，`map.stopAt(x+0.5, z+0.5)` 与 `rainStopY(world, REG, x+0.5, z+0.5, RAIN_CEILING_Y, 128)` 逐位相等（null 对 null）。注释写明这条钉的是「单遍首命中 ≡ 两遍取 max」，对挡雨判据本身零判别力。
5. **屋顶下的格列 stop = 屋顶顶面**：在 (4,4) 列 y=0 铺地板、y=9 盖 `stone_bricks` ⇒ `stopAt(4.5,4.5) === 10`（不是 1）。这是 spec §2.2 缺陷的判别力锚点。
6. 台阶棚子：屋顶换 `planks_step` ⇒ 同样 `=== 10`（Task 1 的判据在这里被端到端消费）。
7. 水体列：`waterAt` 为真且 `stopAt === WATER_SURFACE_Y`。
8. **屋顶盖住的水面**：水上盖屋顶 ⇒ `waterAt` 为假（语义有意收窄，spec §4.7），且 `stopAt` = 屋顶顶面。
9. 失效：`col.version++` 后 `tick()` 必须重扫该列（改屋顶高度后 `stopAt` 跟着变）。
10. `invalidateColumn` 插队首：队列里塞满远处列，invalidate 近处某列 ⇒ 下一次 `tick(1)` 扫的是它。
11. 预算：队列 > 8 时 `tick()` 返回值 `=== 8`；`tick(0)` 返回 0。
12. 未知安全失败：从未扫过的坐标 `stopAt === null`、`waterAt === false`。
13. 窗口平移：`setCenter` 移动 16 格后，新露出的格列在被扫到之前必须返回 `null`（**不得读到旧列的高度**）。
14. **负坐标环形索引**：`shelterTexelIndex(-1, -1, 0, 0)` 必须等于 `511 + (511 << 9)`
    （与 GPU 侧 `int(...).bitAnd(511)` 逐位同构）。这条钉的是「玩家走到负坐标区不会读错列」。
15. 静止世界零成本：连扫两轮后第三次 `tick()` 返回 0。

- [ ] **Step 2: 跑测试确认失败**

Run: `node tools/run-unit-node.mjs --only=test-rain-shelter-map.js`
Expected: FAIL —— 模块不存在（import 硬失败，runner 刻意不 catch）。

⚠️ 此时 `--only` 会因文件不在白名单而先报「不在 Node 白名单内」⇒ **Step 1 里就要把注册三处一起做完**（`index.html` + `test-tiers.mjs`），否则测不到真正的 RED。

- [ ] **Step 3: 实现两个模块**

`voxel/rain-occlusion-data.js`：只有常量与三个纯函数，无状态。
`render/rain-shelter-map.js`：
- 构造时按 registry 建 `rainTab` / `waterTab`（`Uint8Array(registry.count)`），热循环只读字节；
- 扫描单列：`for y = RAIN_CEILING_Y .. WORLD_MIN_Y`，首个 `rainTab[id]` ⇒ `stop=y+1` break；首个 `waterTab[id] && opaqueTable[prev]!==1 && prev!==id` ⇒ `stop=y+1-WATER_SURFACE_SINK`、`hasWater=1` break；`prev=id`；
- 有效性用**清零**而非哈希（spec §4.4：哈希碰撞会静默读到别的列）：`setCenter` 平移时把失效条带 `data[..]=0`，并把对应 column 入队；
- 队列按到中心的切比雪夫距离排序，`invalidateColumn` 用 `unshift`；
- `tick(budget)` 逐列出队 → 扫描 → 写 4 字节 → 记 `version`；返回实扫数。

- [ ] **Step 4: 跑测试确认通过**

Run: `node tools/run-unit-node.mjs --only=test-rain-shelter-map.js`
Expected: PASS（15 例）

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
  assertEqual(wetShelterGate(10, roof, 1), 0, '共面算遮挡（EPS 保证 f32 往返不翻判）');
  assertEqual(wetShelterGate(9.5, roof, 1), 0, '半格之下仍遮挡');
});
```

（`encodeStopY` 从 `voxel/rain-occlusion-data.js` import。）

- [ ] **Step 2: 跑测试确认失败**

Run: `node tools/run-unit-node.mjs --only=test-wet-surface.js`
Expected: FAIL —— `wetShelterGate is not a function`（或 import 报错）

- [ ] **Step 3: 实现**

`wetShelterGate`：`stopEnc <= 0 ⇒ 1`；`strength <= 0 ⇒ 1`；否则解码（**显式走一遍 `Float32Array` 的 `enc/255` 量化再 `×127.5`**，与 GPU 逐位同构）、`probeY <= stop + SHELTER_EPS ? 1 - strength : 1`。
`rain-shelter-texture.js`：建单例 + `uploadShelterTexture`。⚠️ 头注释写明「本文件依赖 three，故放 render/ 不放 voxel/」。

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
- Produces: `WET_SURFACE_UNIFORMS.uWetShelter`（默认 1）、`WET_SURFACE_UNIFORMS.uShelterOrigin`（`Vector2`，窗口原点，装配层每帧写）。

- [ ] **Step 1: 加 uniform 与片元门**

在 `WET_SURFACE_UNIFORMS` 加两项（注释写明第四级零回归锚点）。
在 `createWetSurfaceNode` 里，`const wet = ...` 那行**之后**插入门：

```js
// ⚠️ 坐标差可能为负（探针在原点西侧/北侧）⇒ **先 int 再 
 bitAnd**，
// 不能先 uint（float→uint 转负数是未定义行为，会读到垃圾 texel）。
// int 的位与在 WGSL 里是二进制补码 ⇒ -1 & 511 = 511，与 JS 的 & 逐位同构。
const tx = int(floor(probe.x).sub(U.uShelterOrigin.x)).bitAnd(int(SHELTER_MAP_SIZE - 1));
const tz = int(floor(probe.z).sub(U.uShelterOrigin.y)).bitAnd(int(SHELTER_MAP_SIZE - 1));
const sh = textureLoad(SHELTER_TEXTURE, ivec3(tx, tz, int(0)));
const known = step(float(0.5 / 255), sh.r);
const stopY = add(sh.r.mul(255 / 2), float(SHELTER_Y_BASE));
const sheltered = mul(known, step(probe.y, stopY.add(float(SHELTER_EPS))));
const shelterGate = mix(float(1), oneMinus(sheltered), U.uWetShelter);
```

⚠️ `uShelterOrigin` 用 **`uniform(new THREE.Vector2())`**（float）；`.x/.y` 减完再 `int()`。
`textureLoad` 的 `ivec3` 接受 int 节点（vendor `generateUV` 对 `sampler===false` 走 `'ivec3'`）。

把 `wet` 乘上 `shelterGate`（**五项一起归零**：压暗/水膜/水汪镜面/真倒影/太阳高光都从 `wet` 派生）。
⚠️ `puddleW` 也要乘 —— 它独立于 `wet` 参与 `skyMul` 与真倒影权重。

TSL 口径照既有七条：不与裸数字算术、不用 `.toVar()/.assign()`（本函数不在 `Fn()` 体内）、`textureLoad` 从 `three/tsl` import。

- [ ] **Step 2: 静态门 + 单测**

Run: `npm run check && node tools/run-unit-node.mjs --only=test-wet-surface.js,test-puddle-reflect.js`
Expected: PASS（uniform 初值用例要加 `uWetShelter === 1`）

- [ ] **Step 3: 浏览器冒烟（确认无 WebGPU 验证错误）**

Run（后台）: `npx playwright test tests/wet-surface.spec.mjs -g "材质分层"`
Expected: PASS 且无 `GPUValidationError`。若报 `Unsupported texture format` / 绑定错 ⇒ 停下查纹理格式，不改判据。

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
- Consumes: `RainShelterMap`（Task 2）、`uploadShelterTexture`（Task 3）、`WET_SURFACE_UNIFORMS.uWetShelter` / `uShelterOrigin`（Task 4）。
- Produces: `StormRain.debugState()` 新增 `shelterColumns`（本帧扫描列数）；`underRoof` 语义改为「玩家所在处是否被遮挡」，**只喂音频**。

- [ ] **Step 1: 重写 Tier 4 用例（先 RED）**

把 `tests/storm-lighting.spec.mjs` 的「室内不生效」整条替换成 spec §5 的 C1~C8 夹具与判据：
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
- `this.editor.subscribe(...)` 追加一条：`for (const c of event.changes) map.invalidateColumn(floor(c.x/16), floor(c.z/16))`（去重）；
- `_updateStorm()`：`map.setCenter(pp.x, pp.z)` → `const n = map.tick(8)` → `n > 0 && uploadShelterTexture(map.data)` → 写 `uShelterOrigin`；
  ⚠️ **`uShelterOrigin` 必须无条件每帧写**（不只 `n > 0` 时）：窗口平移那一帧可能恰好
  `n === 0`（队列空），而原点已变 ⇒ 不写会让片元用旧原点索引新数据 ⇒ **整片干湿错位**
  （同 `game.js` 已记的「uniform 必须先写再判门」教训）。
  ⚠️ **首次开启要预热**：`setStormLighting(true)` 后立即 `map.setCenter(pp)` + 一次满预算 `tick`，
  否则第一帧全窗口未知 ⇒ 棚下也是湿的（安全失败方向，但会被 Tier 4 的 C3 当场抓红）。
- **删掉** `wet.uWet.value = indoor ? 0 : WET_STRENGTH_MAX`，改成恒 `WET_STRENGTH_MAX`（遮挡交给片元门）；
- `setStormLighting(false)`：不 tick、不上传（零成本）。

- [ ] **Step 4: 跑 Tier 4 确认 GREEN**

Run（后台）: `npx playwright test tests/storm-lighting.spec.mjs`
Expected: PASS（含重写那条的 C1~C8 + 编辑往返）

- [ ] **Step 5: 负向验证三条**

按 spec §5 逐条注入（`edit` 注入 → 读回确认 → 跑 → `cp` 还原）：
① 删探针法线偏移 ⇒ C5 非零；② 扫描起点改回滴自身 y ⇒ C2 非零；③ 判据改回 `cullTable` ⇒ Task 1 台阶用例红。

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

roadmap 加版本行（改了什么 + 实测证据：扫描 0.0174ms/列、4000 点等价、21 个方块判据修正、Tier 4 各判据读数）。
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
  `tests/tmp-shelter-texload.spec.mjs`、`tests/tmp-shelter-rawbytes.spec.mjs`、
  `tests/tmp-shelter-order.spec.mjs`（后者未跑过，已被前两个取代）、`/tmp/mc-shelter-bench.mjs`。
- 全套 `npm test` **不跑** —— 本改动不属「全局基础设施」，最小充分集已在 Task 5 Step 6/8 覆盖。
- 提交等用户明确指令（计划里的 commit 步骤是计划的一部分，执行时仍按用户指令）。