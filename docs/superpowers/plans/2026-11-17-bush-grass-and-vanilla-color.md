# 矮草丛新增 + 草方块配色对齐 vanilla 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `bush_grass`（矮草丛）方块并在草地按 5% 生成，同时把 6 个继承自 mc-lite 的色差 tile 对齐 vanilla 配色。

**Architecture:** 全部配色改动落**离线烘焙产物**（灰度源图 × 固定 tint T），运行期零代码改动 —— 本仓是 unlit 管线、无 biome tint uniform，着色必须预乘进贴图。新方块走既有 cutout 通道 + 既有 `crossQuads` 几何手法，不新增通道/材质/Worker。生成侧在既有档位**之后**追加独立盐抽签，既有分布逐位不变。

**Tech Stack:** Node v26 + pngjs（烘焙）；纯函数 JS（gen/mesh，Worker 同构无 three）；浏览器内单测 `src/tests/`；Playwright（Tier 4 像素）。

**Spec:** `docs/superpowers/specs/2026-11-17-bush-grass-and-vanilla-color-design.md`

## Global Constraints

- **着色常量唯一权威**：`GRASS_TINT = [119.2, 186.6, 101.5]`（从用户参考图逐 texel 反解，顶面 corr 0.9997 / RMSE 0.83）。写在 **`src/voxel/tint-math.js`**（无 DOM 无 fs 无 three，浏览器单测与 node 烘焙器两侧共用），指纹模块从它 import。**禁止在第二处写字面量**。
- **不动**：全部树叶族（名字含 `leaves`）、玻璃（`Glass`/`glass_blink`）、水（`water`/`swamp_water`）、任何 `cullMode:'transparent'` 方块；`procedural/dark_grass`、`procedural/light_grass`（用户 2026-11-01 指定源图）、`procedural/giant_mangrove_log`（烘焙器有意染红的派生产物）。
- **烘焙 = 数据格式转换 + 着色，不新增美术资源**。源图入库 `assets/grass-textures/src/`，**绝不放 `assets/textures/`**（`build-atlas` 递归扫描，会多出巨型 tile）。
- **`grass_side_carried` 的 dirt 区必须逐字节不变**（只改 overlay alpha>0 的 45 个 texel）。这是内容级判据，指纹拓不到。
- **既有植被档位逐位不变**：`short_grass` 5.000% / `azure_bluet` 1.668% / `allium` 1.629% / `flower` 1.610% / `dead_bush` 1.476% / `oxeye_daisy` 0.991% / `tree` 0.515% / `red_mushroom` 0.500%（N=400000, seed 12345 实测）。
- **盐**：`BUSH_GRASS_SALT = 1043`（PLAINS）、`BUSH_GRASS_TARN_SALT = 1044`（tarn）。程序化扫描确认空闲（1041/1042 已被 `SAPLING_LEAF_SALT`/`TALL_LEAF_SALT` 占用）。
- **空档宽度**：PLAINS **0.86611**（实测，不是名义 0.87 —— 树抽签独立盐会重叠）；tarn **0.934167**（解析：`(1−0.05)×(1−0.05/3)`）。
- **不改 `CAPACITY`**。若实测需要改，必须同步 `tests/giant-tree-budget.spec.mjs` 的 `INIT`。
- 时间基准 `performance.now()`；坐标取模非负；`assertEqual` 是 `===`（数组用 `assertDeepEqual`）；`assertClose` 不在 `assert.js` 里，要用自己定义。
- 新增 `src/tests/test-*.js` 必须同时注册进 `src/tests/index.html`。
- **不提交**（等用户明确指令）。计划里的 commit 步骤一律**跳过**，改为在 seam 处报告。

## Review Focus

1. **草方块顶面与侧面色调撕裂** —— 只改顶面会让同一块草「顶暗侧亮 1.5 倍」。Task 1 的逐 texel 断言必须同时覆盖顶面与侧面草沿，且钉「两者隐含 tint 相同」。
2. **侧面 dirt 区被误改** —— 用 `dirt + overlay×T` 重建整张 side 会改动 48 个非草沿字节（side 自带 dirt 变体）。Task 1 必须有「alpha=0 区逐字节等于原文件」的断言。
3. **新植被吃掉花的份额** —— 分支插在 0.05~0.10 之间会静默改变花分布。Task 3 必须有「既有 8 个档位计数逐位不变」的负向验证。
4. **bush_grass 密度偏离 5%** —— 用名义 0.87 而非实测 0.86611 会得到 4.978%（偏 −0.4%）；用 0.05 直接抽会得到 4.33%（偏 −13%）。Task 3 双侧钉界 4.5%~5.5%。
5. **新方块图标渲成立方体** —— 非实心方块漏进 `FLAT_BLOCKS` 会被当实心走等轴测。Task 4 的 `check:data` `[形状权威]` 环节钉住。
6. **cutout 通道预算恶化** —— 草总量翻倍。Task 5 用 `giant-tree-budget.spec` 判「相对 HEAD 不恶化」。
7. **改 T 忘重烘** —— 指纹必须覆盖 T 常量本身，否则改了 tint 而产物是旧的会静默放行。Task 1 的指纹用例钉住。

---

### Task 1: 烘焙器扩展 —— 灰度×tint 路径 + 6 个 tile 重算

**Files:**
- Create: `assets/grass-textures/src/vanilla/grass_block_top.png`（16×16 灰度，从 blockrender 取，已验与 wiki 官方文件逐字节相同）
- Create: `assets/grass-textures/src/vanilla/grass_block_side_overlay.png`
- Create: `assets/grass-textures/src/vanilla/tall_grass_top.png`
- Create: `assets/grass-textures/src/vanilla/short_grass.png`
- Create: `assets/grass-textures/src/vanilla/sand.png`
- Create: `assets/grass-textures/src/vanilla/dark_oak_log.png`
- Create: `assets/grass-textures/src/vanilla/light_gray_wool.png`
- Create: `assets/grass-textures/src/vanilla/grass_side_base.png`（= 当前 `grass_side_carried.png` 的副本，作为 side 重算的基底）
- Create: `src/voxel/tint-math.js`（纯函数 + `GRASS_TINT`，两侧共用）
- Modify: `tools/grass-textures-fingerprint.mjs`（import `GRASS_TINT` + `TINTED_TEXTURES` 表 + 指纹覆盖 T）
- Modify: `tools/bake-grass-textures.mjs`（新增 `applyTint` / `retintFringe` 两条路径）
- Modify: `tools/check-data.mjs:3268-3306`（`checkGrassTextures` 扩展校验新产物）
- Test: `src/tests/test-grass-tint.js`（新建，纯函数 + 产物契约）
- Modify: `src/tests/index.html`（注册新 test）

**Interfaces:**
- Consumes: 无（首个任务）
- Produces:
  - `GRASS_TINT: readonly [number, number, number]` = `[119.2, 186.6, 101.5]`
  - `TINTED_TEXTURES: Object<string, {source: string, out: string, mode: 'tint'|'fringe'|'copy', base?: string}>`
  - `applyTint(src: PNG, tint: readonly number[]) -> PNG`（逐 texel `round(gray × T/255)`，alpha 原样保留）
  - `retintFringe(base: PNG, overlay: PNG, tint: readonly number[]) -> PNG`（`round(base×(1−a) + ovGray×T/255×a)`，`a = overlayAlpha/255`）
  - `tintedSourcePath(name): string` / `tintedOutputPath(name): string`（指纹模块内部与烘焙器用；tile 名直接由 `def.out` 去 `.png` 得出，不另开 helper）
  - `grassTextureInputFingerprint()` 的 `parts` 追加 `tint:${GRASS_TINT.join(',')}` 与每个 tinted 项的源图 sha

- [ ] **Step 1: 落源图**

从 `/tmp/mcwiki-dl/van/` 复制 7 张 vanilla 贴图 + 当前 `grass_side_carried.png` 到 `assets/grass-textures/src/vanilla/`。逐个用 `read` 确认尺寸 16×16。

⚠️ 这些是**上游原始素材**（blockrender 的 `grass_block_top` 与 wiki `Grass_Block_(top_texture)_JE4_BE2.png` 逐字节相同，已验），入库是为了烘焙可复现。

- [ ] **Step 2: 写失败测试 —— 纯函数 + 目标均值**

烘焙器在 node 侧、单测在浏览器侧，而 `grass-textures-fingerprint.mjs` 依赖 `node:fs`（浏览器不能 import）。
故**纯函数落新模块 `src/voxel/tint-math.js`**（无 DOM 无 fs 无 three，两侧共用），
指纹模块从它 import。`src/voxel/` 属 Worker 同构层（红线 8）—— 新模块**不得 import three**。

新建 `src/tests/test-grass-tint.js`，**同时注册进 `src/tests/index.html`**（漏注册 = 测试静默不跑的假绿）。
数组用 `assertDeepEqual`（`assertEqual` 是 `===`）；`assertClose` 不在 `assert.js` 里，要用自己定义。

Test 断言：

```js
// applyTint：灰度 160 × T → round(160×119.2/255)=75, round(160×186.6/255)=117, round(160×101.5/255)=64
const src = { width: 1, height: 1, data: new Uint8ClampedArray([160, 160, 160, 255]) };
assertDeepEqual([...applyTint(src, GRASS_TINT).data], [75, 117, 64, 255]);
// alpha 原样保留（非 255 也要保留）
const semi = { width: 1, height: 1, data: new Uint8ClampedArray([160, 160, 160, 128]) };
assertEqual(applyTint(semi, GRASS_TINT).data[3], 128);
// retintFringe：a=0 → base 原样；a=255 → 完全替换为 ovGray×T；a=128 → 线性混合
```

`GRASS_TINT` 从 `src/voxel/tint-math.js` import（浏览器侧拿不到指纹模块）。

- [ ] **Step 3: 跑测试确认 RED**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: FAIL —— `applyTint is not a function` / 模块不存在。

⚠️ Step 2 已注册进 index.html，所以这里的 FAIL 是真的跑了。若看到 PASS，先查 `total` 有没有增加 —— 
新用例没注册时 harness 依旧全绿（静默不跑）。

- [ ] **Step 4: 实现纯函数 + 常量**

新建 `src/voxel/tint-math.js`：导出 `GRASS_TINT`、`applyTint(src, tint)`、`retintFringe(base, overlay, tint)`，
只读写 `{data,width,height}`，不 import 任何 node 模块 / three。

`tools/grass-textures-fingerprint.mjs` 从 `tint-math.js` import `GRASS_TINT`（**不写第二份字面量**），
并追加 `TINTED_TEXTURES`（`out` 直接写相对 `assets/textures/` 的路径，不用 `../` 拼接）：

```
grass_carried:              { source:'vanilla/grass_block_top.png',          out:'grass_carried.png',              mode:'tint' }
grass_side_carried:         { source:'vanilla/grass_block_side_overlay.png', out:'grass_side_carried.png',         mode:'fringe', base:'vanilla/grass_side_base.png' }
double_plant_grass_carried: { source:'vanilla/tall_grass_top.png',           out:'double_plant_grass_carried.png', mode:'tint' }
bush_grass:                 { source:'vanilla/short_grass.png',              out:'procedural/bush_grass.png',      mode:'tint' }
sand_side:                  { source:'vanilla/sand.png',                     out:'sand_side.png',                  mode:'copy' }
log_big_oak:                { source:'vanilla/dark_oak_log.png',             out:'log_big_oak.png',                mode:'copy' }
Light_Gray_Cloth:           { source:'vanilla/light_gray_wool.png',          out:'Light_Gray_Cloth.png',           mode:'copy' }
```

`tintedOutputPath(name)` = `path.join(ROOT, 'assets', 'textures', def.out)`。

指纹 `parts` 追加 `tint:${GRASS_TINT.join(',')}` + 每项 `${name}:${source}:${out}:${mode}:${sha}`
（fringe 模式还要含 `base` 的 sha）。

- [ ] **Step 5: 跑测试确认 GREEN**

Expected: 纯函数用例全 PASS。

- [ ] **Step 6: 烘焙器接线**

`tools/bake-grass-textures.mjs` 在既有 `bake()` 里追加第二段循环遍历 `TINTED_TEXTURES`：`mode:'tint'` → `applyTint`；`'fringe'` → 读 base + overlay 走 `retintFringe`；`'copy'` → 直接写字节。每项写 meta 记录（source/base sha、out 均值、mode）。

⚠️ **均值偏差 ≤2 的既有断言只适用于盒式平均那两项**，tinted 项的均值必然偏离源图（那就是着色）→ 新段落用**目标均值断言**（下表），不要复用旧断言。

- [ ] **Step 7: 跑烘焙 + 核对 6 个产物均值**

Run: `npm run grasstextures`

Expected（±0.05，已预先算出精确值）：

| 产物 | 目标均值 |
|---|---|
| `grass_carried` | 68.95 / 107.88 / 58.71 |
| `grass_side_carried`（全图） | 119.53 / 96.41 / 64.05 |
| `grass_side_carried`（草沿 45 texel） | 72.13 / 113.11 / 61.49 |
| `double_plant_grass_carried` | 70.44 / 109.13 / 60.02 |
| `procedural/bush_grass` | 68.16 / 106.29 / 58.12 |
| `sand_side` | 219.16 / 207.22 / 163.10 |
| `log_big_oak` | 60.39 / 46.56 / 26.16 |
| `Light_Gray_Cloth` | 142.03 / 142.16 / 134.60 |

- [ ] **Step 8: 加「dirt 区逐字节不变」断言（Review Focus 2）**

在 `test-grass-tint.js` 加用例：读 `grass_side_base.png` 与产物 `grass_side_carried.png`，对 overlay alpha=0 的 texel 逐个比 RGB，**必须全等**。

负向验证：把 `retintFringe` 改成 `dirt + ovGray×T`（用 `dirt.png` 当 base），该用例必须 FAIL（实测会有 48 个字节差）。用 `cp` 副本还原，**不要用 git checkout**。

- [ ] **Step 9: 加「顶/侧 tint 一致」断言（Review Focus 1）**

用例：从产物顶面反解隐含 tint（逐 texel LS，除 vanilla 灰度），从产物草沿反解隐含 tint（除 ovGray），两者三通道差 **<1.0**。

- [ ] **Step 10: 加「改 T 忘重烘」指纹用例（Review Focus 7）**

用例：`grassTextureInputFingerprint().input` 在 T 改变时必须变。手法：临时把 `GRASS_TINT` 换成别的值算一次指纹，断言两次不等（用副本还原）。

- [ ] **Step 11: 门禁扩展**

`tools/check-data.mjs` 的 `checkGrassTextures()` 追加：遍历 `TINTED_TEXTURES` 校验产物存在 + 均值落在目标 ±0.5 + 源图 sha 未变 + T 进指纹。

Run: `npm run check:data`
Expected: `[草贴图]` 环节列出全部 9 项（2 盒式 + 7 tinted）且全绿。

- [ ] **Step 12: 全量单测 + 门禁**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: `failed === 0` 且 `total` 比改动前增加。

Run: `npm run check`
Expected: arch + data + lint 全绿；`npx eslint tools/grass-textures-fingerprint.mjs tools/bake-grass-textures.mjs src/voxel/tint-math.js src/tests/test-grass-tint.js` 零 warning。

---

### Task 2: 新方块 `bush_grass` 声明 + 几何

**Files:**
- Modify: `src/voxel/blocks-data.js`（在 `short_grass` 行后插入）
- Modify: `src/voxel/faces-data.js`（植被段）
- Modify: `src/mesh/mesher.js`（`TEMPLATES`，`flower` 条目附近）
- Test: `src/tests/test-bush-grass.js`（新建）
- Modify: `src/tests/index.html`

**Interfaces:**
- Consumes: Task 1 的 `procedural/bush_grass.png` 产物 + `tileName` 口径
- Produces: 方块名 `bush_grass`；`TEMPLATES.bush_grass`（8 个 quad —— 2 平面 × 双面绕线，与 `flower` 同结构）

- [ ] **Step 1: 写失败测试 —— 几何 bbox**

新建 `src/tests/test-bush-grass.js`：

```js
// 实际草的 bbox（quad 尺寸 × 贴图不透明 bbox 占比）
// bush_grass 贴图 bbox x0..15 y2..15 → 宽 16/16、高 14/16
// quad = crossQuads(0.805, -0.05, 0.87) → 宽 0.805、高 0.92
const q = TEMPLATES.bush_grass;
assertNotNull(q, 'TEMPLATES.bush_grass 存在');
// quad 的 x/z 跨度 = 0.805，y 跨度 = 0.92
// 实际草高 = 0.92 × 14/16 = 0.805；实际草宽 = 0.805
// 必须 > short_grass 的 0.6125 / 0.700
```

断言 quad 数与 `flower` 相同（同结构）、`ds:true`（双面）、草高 >0.78 且 <0.83、草宽 >0.78 且 <0.83，且**严格大于** `flower` 模板算出的对应值。

⚠️ 不要只断言 quad 尺寸 —— 那对「按 quad 等比放大」的错误实现无判别力（草高只 +0.6%）。必须乘贴图 bbox 占比。

- [ ] **Step 2: 跑测试确认 RED**

Expected: FAIL —— `TEMPLATES.bush_grass` undefined。

- [ ] **Step 3: 实现三处声明**

`blocks-data.js`（紧跟 `short_grass` 行）：
```js
{"name":"bush_grass","solid":false,"cullMode":"cutout","orientationModes":4,"geometry":"bush_grass","shadowCast":false},
```

`faces-data.js` 植被段：`bush_grass: 'procedural/bush_grass',`

`mesher.js` `TEMPLATES`：`bush_grass: crossQuads(0.805, -0.05, 0.87),`

注释写清「按实际草 bbox 等比 +15%，不是按 quad 尺寸」的推导（spec §3.3 的表）。

- [ ] **Step 4: 跑测试确认 GREEN**

- [ ] **Step 5: 加「方块声明与 short_grass 同口径」用例**

断言 `bush_grass` 的 `solid/cullMode/orientationModes/shadowCast` 与 `short_grass` 逐项相等，且 `registry.opaqueTable[id] === 0`（不遮光/不剔面/不挡 LOS）。

- [ ] **Step 6: 注册 + 门禁**

`src/tests/index.html` 注册新 test。
Run: `npm run check:data`
Expected: `[物品集合]` 自动含 `bush_grass`（派生集合）；`[形状权威]` 此刻会**FAIL**（非实心未在 `FLAT_BLOCKS`）—— 这是预期的，Task 4 修。记录该失败，不要在本任务里顺手改 `FLAT_BLOCKS`（那是 Task 4 的写集）。

---

### Task 3: 生成接线 —— PLAINS + 高台草地各 5%

**Files:**
- Modify: `src/gen/structures/vegetation.js`（`rollVegetation` 末尾 + 导出 `BUSH_GRASS_SALT` / `PLAINS_EMPTY_SHARE`）
- Modify: `src/gen/structures/tarn-terrain.js`（`tarnPlantAt` 末尾 + `BUSH_GRASS_TARN_SALT` / `TARN_EMPTY_SHARE`）
- Test: `src/tests/test-bush-grass-gen.js`（新建）
- Modify: `src/tests/index.html`

**Interfaces:**
- Consumes: Task 2 的方块名 `bush_grass`
- Produces:
  - `BUSH_GRASS_SALT = 1043`、`PLAINS_EMPTY_SHARE = 0.86611`
  - `BUSH_GRASS_TARN_SALT = 1044`、`TARN_EMPTY_SHARE = 0.934167`
  - `rollVegetation` 返回值新增可能 `{plant:'bush_grass'}`
  - `tarnPlantAt` 返回值新增可能 `'bush_grass'`

- [ ] **Step 1: 写失败测试 —— 密度双侧界 + 既有档位不变**

新建 `src/tests/test-bush-grass-gen.js`。N=400000、seed 12345、坐标遍历口径与 spec §2.3 实测一致（`wx = (i%2000)-1000, wz = floor(i/2000)-100`）。

```js
// ① bush_grass 密度落 [4.5%, 5.5%]
// ② 既有 8 个档位的比例与冻结值差 <0.05 个百分点：
//    short_grass 5.000 / azure_bluet 1.668 / allium 1.629 / flower 1.610
//    dead_bush 1.476 / oxeye_daisy 0.991 / tree:default 0.515 / red_mushroom 0.500
// ③ 空档 + 全部档位 = 100%（无落空）
```

⚠️ 冻结值取**百分点**比较而非绝对计数 —— 计数会随 N 变，比例才是契约。

- [ ] **Step 2: 跑测试确认 RED**

Expected: FAIL —— `bush_grass` 计数 0。

- [ ] **Step 3: 实现 PLAINS 分支**

`rollVegetation` 在**最后一个 `return {}` 之前**插入：

```js
if (seededRandom(wx, wz, seed + BUSH_GRASS_SALT) < 0.05 / PLAINS_EMPTY_SHARE) {
  return { plant: 'bush_grass' };
}
```

常量导出 + 注释写清「0.86611 是实测空档（树抽签独立盐会重叠），不是名义 0.87」。

- [ ] **Step 4: 跑测试确认 GREEN**

Expected: `bush_grass` ≈5.000%，既有 8 档逐位不变。

- [ ] **Step 5: 负向验证（Review Focus 3）**

把新分支**移到 `randPlant < 0.05` 之后、`< 0.10` 之前**，跑用例：既有花档断言必须 FAIL。
再试阈值直接写 `0.05`（不除空档）：密度断言必须 FAIL（实测 4.33%）。
两次都用 `cp` 副本还原。

- [ ] **Step 6: 实现 tarn 分支**

`tarnPlantAt` 在 `return null` 之前插入同结构抽签，用 `BUSH_GRASS_TARN_SALT` 与 `0.05 / TARN_EMPTY_SHARE`。`TARN_EMPTY_SHARE = (1 - TARN_GRASS_CHANCE) * (1 - TARN_FLOWER_CHANCE)` —— **由既有常量派生，不写字面量**（红线 1）。

- [ ] **Step 7: tarn 密度用例**

在既有 `src/tests/test-tarn-terrain.js` 的密度用例旁追加 `bush_grass` 断言（复用它的 tarn layout 造壳手法），双侧界 4.5%~5.5%，且 `short_grass`/`azure_bluet` 计数不变。

Run: 浏览器内单测全量。
Expected: 全 PASS。

- [ ] **Step 8: 盐占用扫描复核**

重跑程序化扫描（`src/**` + `tools/**` + `tests/**` 的 `seed + N` / `seed + CONST` / `*SALT = N`），确认 1043/1044 只被本次新增消费。

---

### Task 4: 门禁名单同步 + 烘焙链

**Files:**
- Modify: `tools/icon-fingerprint.mjs:86`（`FLAT_BLOCKS` 追加 `bush_grass`）
- Modify: `tools/check-data.mjs:1143-1147`（`EXPECTED_NO_CAST` 13 → 14 项）
- Modify: `src/tests/test-block-registry.js:294-298`（`NO_CAST` 同步）
- Modify: `assets/atlas.png` / `assets/atlas.json` / `assets/icons-atlas.png` / `assets/icons.json`（烘焙产物）

**Interfaces:**
- Consumes: Task 2 的方块声明、Task 1/2 的贴图产物
- Produces: 全量门禁绿；`bush_grass` 在背包里且有平面图标

- [ ] **Step 1: 三处名单同步追加 `bush_grass`**

`FLAT_BLOCKS`（非实心必须进，否则图标渲成立方体）、`EXPECTED_NO_CAST`、`NO_CAST`。三处注释里的「13 项」改「14 项」。

- [ ] **Step 2: 跑门禁确认形状权威修好**

Run: `npm run check:data`
Expected: `[形状权威]` 从 Task 2 记录的 FAIL 转绿；`[阴影投射]` 14 项全绿。

- [ ] **Step 3: 重跑烘焙链**

Run: `npm run atlas && npm run icons`
Expected: atlas tile 数 +1（`procedural/bush_grass`）；icons 条数 +1。

⚠️ 顺序载荷性：`grasstextures`（Task 1 已跑）→ `atlas` → `icons`。反了会烘出旧贴图。

- [ ] **Step 4: 全量门禁 + lint**

Run: `npm run check`
Expected: 全绿。`npx eslint` 单独跑本轮改过的每个文件，确认**零新增 warning**（不得把新 warning 称作既有基线）。

- [ ] **Step 5: 浏览器内单测全量**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: `window.__MC_TEST_RESULTS__.failed === 0`，且 `total` 比改动前增加（新用例真的跑了）。

---

### Task 5: Tier 4 像素实测 + 预算回归

**Files:**
- Create: `tests/tmp-bush-grass-pixel.spec.mjs`（一次性探针，已 gitignore，**不提交**）
- Modify: 无生产代码（若实测发现缺陷则回到对应 Task 修）

**Interfaces:**
- Consumes: Task 1~4 的全部产物
- Produces: 像素证据 + 预算证据（写进 roadmap）

- [ ] **Step 1: 写像素探针**

`channel: 'chromium'`（默认 headless shell 拿不到 WebGPU adapter）。经 `window.__MC_GAME__` 驱动：传送到 PLAINS 草地（用 `g._teleportTo(x,45,z)`，它会加载目标 column），`?skybox=0&fog=0&shadows=0&stats=0` 固定环境，正午风格。

判据：
- 草方块**顶面**像素均值落在 68.95/107.88/58.71 的 **±3**（含光照与 tone mapping 偏移，故容差比烘焙大）
- **同时钉上下界**：不得纯黑（lum >20）、不得与改动前逐位相同
- 先测**同状态重复截图的噪声底**，判据阈值必须大于噪声底

⚠️ WebGPU canvas 回读必须在 `renderer.render()` **之后**；逐帧读像素要在 rAF 回调内。

- [ ] **Step 2: A/B 对照证明变量真的改了**

用 `page.route` 在浏览器侧换 atlas 内容做 A/B（**不要用 git stash 或原地 cp 换文件** —— 并发会话竞态）。两侧只差 atlas 的草 tile 像素。

⚠️ 先确认「变量真的被改动了」：断言两侧 atlas 的 sha 不同，否则数字相同是假象。

- [ ] **Step 3: 新方块可见性像素证据**

在草地上找到 `bush_grass` 格，截图证明它上屏且比 `short_grass` 大。判据落在**实例几何**（mesher 发射顶点的 bbox 跨度）而非纯像素圈选 —— 后者对「地形也圈进去」无判别力。

- [ ] **Step 4: 预算回归**

Run: `npm run bench -- --check`
Expected: 回退 ≤10%。若 frameP95 贴线，用**交替对照**判分布（两侧交错各 2~3 轮），不看单次红绿。

Run: `npx playwright test tests/giant-tree-budget.spec.mjs`
Expected: cutout 相对 HEAD 不恶化（+1.0 容差内）。

⚠️ **bench 不可与回归并发**（既有教训）。`npm run bench` 不带 `--check` 会重写冻结基线 —— 若为诊断跑过，必须 `git checkout docs/m3-baseline.*` 恢复。

- [ ] **Step 5: 记录实测数据**

把像素均值、噪声底、A/B 差、cutout 峰值、frameP95 写进 Task 6 的 roadmap 条目。

---

### Task 6: 普查报告 + roadmap

**Files:**
- Create: `docs/vanilla-texture-color-audit.md`（95 个 tile 的完整普查表）
- Modify: `docs/roadmap.md`（新增版本行）
- Modify: `CLAUDE.md`（若产生新的高频坑则追加）

**Interfaces:**
- Consumes: Task 1~5 的全部实测数据
- Produces: 可复核的普查报告 + 版本记录

- [ ] **Step 1: 写普查报告**

表格逐 tile 列：本仓均值 / 最佳 vanilla 配对 / corr / 归一化 RMSE / Δ均值 / 判定（同图色差 / 换素材 / 自创 / 已裁定不动）/ 本轮是否改。

数据来源 `/tmp/mcwiki-dl/tile-match.json` + `.tmp-resid.mjs` 的两级判据输出。**把方法与「单靠 corr 会被同族纹理骗到 0.99」的教训写进报告开头**（`Light_Gray_Cloth` vs `pink_wool` corr 0.9965 是错配对）。

未改的 corr<0.3 那批（`Bone_Block_*` / `Deepslate` / `Obsidian` / `Iron_Ore` / `Nether_Bricks` / `Glowstone` …）单独一节列「建议换素材，待裁定」。

- [ ] **Step 2: roadmap 版本行**

按既有格式写：用户需求原话 + 实测根因 + 落地项 + 验证证据（命令输出 / 像素均值 / cutout 峰值）+ 反向验证教训。

必须记的非显然点：① 参考图反解 T 的方法与 corr/RMSE；② wiki 侧面用 overlay 不用 side 草沿（RMSE 0.86 vs 12.67）；③ 空档 0.86611 不是 0.87；④ 几何按 bbox 而非 quad 等比；⑤ 两级判据（corr + 归一化残差）。

- [ ] **Step 3: 最终门禁**

Run: `npm run check`
Expected: 全绿。

---

## 收尾（不在 Task 内，执行完统一做）

- [ ] 逐个删除本轮创建的临时脚本（**字面路径，不用 `.tmp-*` 通配符** —— 同目录有别人的 `.tmp-map.mjs`）：
  `.tmp-texaudit.mjs` `.tmp-texbest.mjs` `.tmp-faces.mjs` `.tmp-match.mjs` `.tmp-fetchall.mjs` `.tmp-fetchwant.mjs` `.tmp-filter.mjs` `.tmp-pairs.mjs` `.tmp-resid.mjs` `.tmp-verify.mjs`
- [ ] 一次性探针 spec `tests/tmp-bush-grass-pixel.spec.mjs` 删除（已 gitignore）
- [ ] `git status` 确认没有意外文件；`docs/m3-baseline.*` 若被 bench 重写则恢复
- [ ] 最终 review（一个 fresh reviewer 看整个改动，不是每 task 一个）
- [ ] **不提交** —— 等用户明确指令