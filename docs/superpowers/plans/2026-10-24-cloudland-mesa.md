# Cloudland 高台（桌山）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 CLOUDLAND 素材包的 `Landscape/9` 高台以 1:1 尺寸引入 mc-heavy 生成层，每个 region 的沙漠平地至多落 1 个，方块全部映射到既有 registry 方块。

**Architecture:** 素材 `.schem` 离线烘焙成既有 `assets/structures/*.json` 格式（不新开运行期格式）；落点由 `src/gen/structures/mesa.js` 的纯函数 `computeMesaAnchor()` 在 region layout 层算一次（与 `computeSkyCandidates` / `computeGiantTreeCandidates` 同构，DR-13）；光栅化作为 `apply.js` 新增的阶段 2.75，插在撒布结构之后、巨树之前。零新增方块/贴图/图标，全部目标是 opaque 通道。

**Tech Stack:** 纯 ES2022 JS + JSDoc（禁 TypeScript）、Node 26 ESM（烘焙脚本）、three r185.1 WebGPU（不涉及渲染改动）、Playwright 1.62.1 + 浏览器内单测 runner。

**Spec:** `docs/superpowers/specs/2026-10-24-cloudland-mesa-design.md`

## Global Constraints

- **禁止 TypeScript**、禁止编译/转译/bundler；代码注释用中文。
- `src/gen/**`、`src/mesh/**`、`src/workers/**` 是 **Worker 同构层**：不得 `import three`、不得自建 Worker（`npm run check:arch` 守）。
- **数据只有一份权威**（红线 1）：映射表只放 `tools/cloudland-mesa-fingerprint.mjs`；基座矩形常量只放 `src/gen/structures/mesa.js`；烘焙脚本与 `check:data` 都从这两处 import，不得各写一份字面量。
- **`seededRandom` salt 必须程序化扫描确认空闲**，不得 grep 字面量。本计划固定 `MESA_SALT = 950`（已确认 `932..999` 空闲；`58..107` 云簇、`270..397` landmarks、`102..112` terrain 已占用）。
- **不新增方块、不新增贴图、不跑 `npm run icons`、不跑 `npm run atlas`。**
- **不动任何 `CAPACITY.*` 常量**（本设计全 opaque、零 cutout）。
- 新增/改 `src/**/*.js` 后必须 `npm run lint`（0 error）。
- 新浏览器单测文件必须在 `src/tests/index.html` 注册，否则 `check:data` 的 `[测试注册]` 环节报「存在但未注册（= 静默不跑）」。
- 提交信息用 Conventional Commits（`feat:` / `test:` / `chore:` / `docs:`）。**每个 Task 结束提交一次。**
- 冻结断言（genP95 10ms / 200MiB / 三通道零扩容）实测不符时**停下来报告**，不得擅自改断言或放宽阈值。

## Review Focus

按「最可能咬到人」排序。每一条都在下面对应 Task 里有钉住它的测试。

1. **基座跨到海里** → 高台一半扎在海底、露出水面的只有台顶。判据是「基座 15×15 每列 `generateHeight > SEA_Y`」，不是「中心点在陆地」。钉在 Task 2。
2. **高台穿空岛** → 台顶 y≈51 与空岛底 y∈[40,68] 有重叠区间。判据是空岛 AABB（含半径外扩）与台顶最高位 `floorY+42` 比较。钉在 Task 2。
3. **落点落进城市/地标** → 城内地面是 `getCityFinalSurfaceY`（压平），城外的自然地形高度不同；高台用自然高度会给城内制造悬空/穿模。判据在 `apply.js`（拿得到 `cityLayout`），**不能在候选层** —— 城市 bounds 可跨 region。钉在 Task 4。
4. **跨 region 边界的高台缺一块** → 锚点太靠 region 边缘时，20×21 的占地会越界，而相邻 region 的 layout 不会为它生成锚点 ⇒ 半边永久消失。判据是候选内缩 `M = 13` 格（并集半宽 11 + 2 余量）。钉在 Task 2。
5. **映射表漂移出未注册方块** → `makeColumnSetter` 对未注册名字**静默 return**（`landmarks.js:274`），那一格变 air，高台内部出现空洞，方块层面看不出「是映射错了」。判据是烘焙时 throw + `check:data` 逐类型查 registry。钉在 Task 1 与 Task 6。

---

## File Structure

| 文件 | 责任 |
|---|---|
| `assets/cloudland/src/cloudlandassets_1.20.schem` | **新增**（入库）：烘焙输入，非渲染资源 |
| `tools/cloudland-mesa-fingerprint.mjs` | **新增**：`BLOCK_MAP`（28→14）、`MESA_METRICS`、路径、输入指纹。烘焙脚本与 `check:data` 的**共同权威** |
| `tools/bake-cloudland-mesa.mjs` | **新增**：`.schem` → 连通分量 → 映射 → `cloudland_mesa_small.json` + `.meta.json` |
| `tools/nbt-reader.mjs` | **新增**：从 `bake-giant-trees.mjs` 抽出的 `NbtReader`（两个烘焙脚本共用，红线 1） |
| `assets/structures/cloudland_mesa_small.json` | **新增**（产物）：`{version, blocks:[x,y,z,typeIdx...], palette}` |
| `src/gen/structures/mesa.js` | **新增**：`computeMesaAnchor()` 纯函数 + `MESA_BASE_RECT_HALF` / `MESA_SALT` / `MESA_UNION_HALF` |
| `src/gen/structures/structure-layout.js` | 改：layout 返回值加 `mesa` |
| `src/gen/structures/structure-json.js` | 改：`STRUCTURE_FILES` +1 |
| `src/gen/structures/apply.js` | 改：阶段 2.75 光栅化 + 让路；阶段 2.8 巨树 `allowedAt` 加一条 |
| `tools/check-data.mjs` | 改：新增 `[高台]` 契约环节 |
| `package.json` | 改：`"mesa": "node tools/bake-cloudland-mesa.mjs"` |
| `src/tests/test-mesa.js` | **新增**：Tier 1（候选发现 / 映射表 / 产物 metrics） |
| `src/tests/test-mesa-gen.js` | **新增**：Tier 1（真实 column GEN 接线） |
| `src/tests/index.html` | 改：注册上面两个文件 |
| `tests/mesa.spec.mjs` | **新增**：Tier 4（真实页面像素/世界坐标） |
| `docs/phase-1-engine-design.md` | 改：修订说明加一条（架构口径：新增阶段 2.75） |
| `AGENTS.md` | 改：活跃约束加一条（高台沉淀） |

---

### Task 1: 烘焙管线（`.schem` → JSON）+ 共享映射表

**Files:**
- Create: `tools/nbt-reader.mjs`
- Create: `tools/cloudland-mesa-fingerprint.mjs`
- Create: `tools/bake-cloudland-mesa.mjs`
- Modify: `tools/bake-giant-trees.mjs:34-62`（改为 import `NbtReader`）
- Modify: `package.json`（`scripts.mesa`）
- Test: 手工执行 `npm run mesa` + `node --check`

**Interfaces:**
- Produces:
  - `tools/nbt-reader.mjs` → `export class NbtReader { constructor(buf); payload(tagType) }`（与 `bake-giant-trees.mjs` 现有实现逐字相同）
  - `tools/cloudland-mesa-fingerprint.mjs` →
    - `export const SCHEM_PATH`（`assets/cloudland/src/cloudlandassets_1.20.schem` 绝对路径）
    - `export const MESA_JSON` / `MESA_META`（`assets/structures/cloudland_mesa_small.{json,meta.json}`）
    - `export const SOURCE_COMPONENT_BLOCKS = 10712`
    - `export const BLOCK_MAP`（`Record<string, string>`，28 个源名 → 目标名）
    - `export const MESA_METRICS = Object.freeze({ width: 20, height: 43, depth: 21, blocks: 10712, baseCells: 164 })`
    - `export const MESA_ORIGIN = Object.freeze({ cx: 9, cz: 11 })`（基座质心，烘焙时的平移原点）
    - `export function cloudlandMesaInputFingerprint()` → `{ input, schemSha256, paramsSha256 }`
- Consumes: 无（本任务是一切的起点）

- [ ] **Step 1: 入库素材**

```bash
mkdir -p assets/cloudland/src
cp /Users/bachi/Downloads/CLOUDLAND/schematic/cloudlandassets_1.20.schem assets/cloudland/src/
shasum -a 256 assets/cloudland/src/cloudlandassets_1.20.schem
```

预期 sha256 = `217e…` 不对 —— 记录**实际**输出值，下一步写进 `MESA_METRICS` 旁边作注释即可（指纹函数运行时自己算，不需要硬编码）。

- [ ] **Step 2: 抽出 `NbtReader`**

把 `tools/bake-giant-trees.mjs` 里 `class NbtReader`（第 34~62 行）整体移到新文件 `tools/nbt-reader.mjs`，加 `export`，其余逐字不动。然后在 `bake-giant-trees.mjs` 里删掉类定义、改 import：

```js
import { NbtReader } from './nbt-reader.mjs';
```

- [ ] **Step 3: 验证冻结产物未变**

Run: `npm run gianttrees && git status --short assets/giant-trees/`
Expected: **无输出**（产物逐字节不变）。若变了说明 NbtReader 抽取引入了行为差异，停下来查。

- [ ] **Step 4: 写共享映射表与指纹模块**

创建 `tools/cloudland-mesa-fingerprint.mjs`。`BLOCK_MAP` 就是规格 §3.2 那张表，逐条落实（28 个 key，14 个 value）：

```js
export const BLOCK_MAP = Object.freeze({
  // 基座（y 1-10）
  mud: 'mud_bricks',
  coal_block: 'polished_blackstone_bricks',
  // 台身
  tuff: 'tuff_bricks',
  gray_concrete_powder: 'calcite',
  light_gray_concrete_powder: 'calcite',
  white_concrete_powder: 'calcite',
  // 横带
  cracked_stone_bricks: 'stone_bricks',
  chiseled_nether_bricks: 'nether_bricks_1',
  cracked_nether_bricks: 'nether_bricks',
  nether_bricks: 'nether_bricks',
  gray_wool: 'stone',
  // 台顶苔藓层
  moss_block: 'moss',
  green_terracotta: 'moss',
  green_concrete: 'mossy_stone',
  lime_terracotta: 'moss',
  lime_wool: 'moss',
  // 木与陶
  acacia_wood: 'acacia_planks',
  oak_wood: 'wood',
  birch_wood: 'birch_log',
  cyan_terracotta: 'clay',
  blue_terracotta: 'clay',
  light_gray_terracotta: 'light_gray_cloth',
  // 深板岩族
  deepslate: 'deepslate',
  cobbled_deepslate: 'deepslate',
  polished_deepslate: 'polished_deepslate',
  deepslate_tiles: 'deepslate',
  cracked_deepslate_tiles: 'deepslate',
  chiseled_deepslate: 'polished_deepslate',
  deepslate_bricks: 'deepslate',
  cracked_deepslate_bricks: 'polished_deepslate',
  deepslate_coal_ore: 'deepslate',
  deepslate_copper_ore: 'deepslate',
  deepslate_iron_ore: 'iron_ore',
  // 混凝土族
  gray_concrete: 'smooth_stone_1',
  black_concrete: 'deepslate',
  black_concrete_powder: 'deepslate',
  light_gray_concrete: 'smooth_stone',
  smooth_basalt: 'deepslate',
  // 羊毛
  black_wool: 'deepslate',
  light_gray_wool: 'light_gray_cloth',
  white_wool: 'marble',
  green_wool: 'moss',
});
```

**这张表必须用脚本生成而不是手写**：先跑一次「列出现场 28 个源名」的临时脚本（见 Step 5），把实际出现的名字逐个填进来，缺一个就让烘焙 throw —— 不要凭规格表猜名字（规格表是按**方块族**归并的展示，源文件里的精确名字以脚本输出为准）。

指纹函数与 `giant-trees-fingerprint.mjs` 同手法：

```js
export function cloudlandMesaInputFingerprint() {
  const schemSha256 = createHash('sha256').update(fs.readFileSync(SCHEM_PATH)).digest('hex');
  const paramsSha256 = createHash('sha256')
    .update(JSON.stringify({ BLOCK_MAP, MESA_METRICS, MESA_ORIGIN, SOURCE_COMPONENT_BLOCKS }))
    .digest('hex');
  return { input: `${schemSha256.slice(0, 16)}:${paramsSha256.slice(0, 16)}`, schemSha256, paramsSha256 };
}
```

- [ ] **Step 5: 写烘焙脚本，先只打印现场方块名**

创建 `tools/bake-cloudland-mesa.mjs`，本步只实现到「解析 `.schem` + 切连通分量 + 找到 `BlockCount === 10712` 那个分量 + 打印它用到的全部源方块名与格数」，**不要写映射和输出**。

Run: `node tools/bake-cloudland-mesa.mjs`
Expected: 打印 28 个 `名字 → 格数`，与规格 §3.2 的格数吻合（`tuff 2574` / `gray_concrete_powder 1483` / `mud 1481` / `chiseled_nether_bricks 1148` / `cracked_stone_bricks 1030` / `gray_wool 773` / `moss_block 747` …），总数 = 10712。

把输出里**每一个**名字都写进 `BLOCK_MAP`（Step 4 的表是起点；以本步输出为准补齐/改名）。文件名里的 `[axis=y]` 后缀要先剥掉（`name.replace('minecraft:','').split('[')[0]`）。

- [ ] **Step 6: 补完烘焙输出**

继续实现：平移到 `MESA_ORIGIN` 为原点（`x - (x0 + 9)`、`z - (z0 + 11)`，`y` 相对 `y0` 后 **+1**）→ 逐格过 `BLOCK_MAP`（**未命中 throw**，错误信息含源方块名与格数）→ 按 `palette` 索引压缩成紧凑数组 → 写 `cloudland_mesa_small.json` 与 `.meta.json`。

产物格式（与既有 JSON 不同：用 palette + 扁平数组，1 万格逐字写 `{x,y,z,type}` 会到 500KB）：

```json
{"version":1,"sourceComponentBlocks":10712,"palette":["mud_bricks","tuff_bricks", "…"],
 "blocks":[x,y,z,pi, x,y,z,pi, "…"]}
```

`structure-json.js` 的 `loadStructure()` 需要同时认两种形状（Task 3 处理），本步只保证产物写出。

烘焙末尾断言（不通过就 throw，不写文件）：
- 输出方块数 == `MESA_METRICS.blocks`
- 输出 bbox == `20 × 43 × 21`
- `palette` 每一项都是单个方块名（不含 `minecraft:` 前缀、不含 `[`）

- [ ] **Step 7: 加 npm script 并跑**

`package.json` 加 `"mesa": "node tools/bake-cloudland-mesa.mjs"`（放在 `"gianttrees"` 之后）。

Run: `npm run mesa && node -e "const j=require('./assets/structures/cloudland_mesa_small.json'); console.log(j.blocks.length/4, j.palette.length)"`
Expected: `10712 16`（palette = BLOCK_MAP 的 value 去重数；实测 16，规格 §3.2 的归并展示表不是这个数字）

- [ ] **Step 8: Commit**

```bash
git add assets/cloudland/src/cloudlandassets_1.20.schem assets/structures/cloudland_mesa_small.json assets/structures/cloudland_mesa_small.meta.json tools/nbt-reader.mjs tools/cloudland-mesa-fingerprint.mjs tools/bake-cloudland-mesa.mjs tools/bake-giant-trees.mjs package.json
git commit -m "feat(gen): 烘焙 CLOUDLAND Landscape/9 高台为结构 JSON"
```

---

### Task 2: 落点纯函数 `computeMesaAnchor`

**Files:**
- Create: `src/gen/structures/mesa.js`
- Test: `src/tests/test-mesa.js`

**Interfaces:**
- Consumes: `getBiome(wx, wz, seed)`、`generateHeight(wx, wz, seed)`、`seededRandom(a, b, salt)`、`SEA_Y`、`computeSkyCandidates(regionX, regionZ, seed) → { skyIslands: Int32Array /* stride 5: originCx, originCz, bottomY, radius, height */ }`
- Produces:
  - `export const MESA_BASE_RECT_HALF = 7`
  - `export const MESA_UNION_HALF = 11`
  - `export const MESA_TOP_REL_Y = 42`（`Landscape/9` 最高位相对 y）
  - `export const MESA_SALT = 950`
  - `export function computeMesaAnchor(regionX, regionZ, seed) → { wx: number, wz: number, floorY: number } | null`

- [ ] **Step 1: 写失败测试**

创建 `src/tests/test-mesa.js`（顶部注释说明钉的是什么，同 `test-giant-trees.js` 风格）：

```js
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse } from './assert.js';
import { computeMesaAnchor, MESA_BASE_RECT_HALF, MESA_SALT } from '../gen/structures/mesa.js';
import { getBiome } from '../gen/noise.js';
import { generateHeight } from '../gen/terrain.js';
import { SEA_Y } from '../voxel/constants.js';

const SEED = 12345;

test('高台落点：同一 seed 同一 region 两次调用结果逐字段相同（红线 2 确定性）', () => {
  for (const [rx, rz] of [[0, 0], [1, 0], [2, -1]]) {
    const a = computeMesaAnchor(rx, rz, SEED);
    const b = computeMesaAnchor(rx, rz, SEED);
    if (a === null) { assertEqual(b, null, `region(${rx},${rz}) 两次都 null`); continue; }
    assertEqual(a.wx, b.wx, `region(${rx},${rz}) wx 稳定`);
    assertEqual(a.wz, b.wz, `region(${rx},${rz}) wz 稳定`);
    assertEqual(a.floorY, b.floorY, `region(${rx},${rz}) floorY 稳定`);
  }
});

test('高台落点：基座 15×15 每列都是 DESERT（不跨 biome）', () => {
  let checked = 0;
  for (let rx = -2; rx <= 2; rx++) for (let rz = -2; rz <= 2; rz++) {
    const a = computeMesaAnchor(rx, rz, SEED);
    if (!a) continue;
    checked++;
    const H = MESA_BASE_RECT_HALF;
    for (let dz = -H; dz <= H; dz++) for (let dx = -H; dx <= H; dx++) {
      const b = getBiome(a.wx + dx, a.wz + dz, SEED);
      assertEqual(b, 'DESERT', `region(${rx},${rz}) 基座 (${dx},${dz}) 是 DESERT，实际 ${b}`);
    }
  }
  assertTrue(checked >= 8, `至少 8 个 region 有锚点（实际 ${checked}）`);
});

test('高台落点：基座 15×15 每列地表都高于海平面（不跨海）', () => {
  for (let rx = -2; rx <= 2; rx++) for (let rz = -2; rz <= 2; rz++) {
    const a = computeMesaAnchor(rx, rz, SEED);
    if (!a) continue;
    const H = MESA_BASE_RECT_HALF;
    for (let dz = -H; dz <= H; dz++) for (let dx = -H; dx <= H; dx++) {
      const h = generateHeight(a.wx + dx, a.wz + dz, SEED);
      assertTrue(h > SEA_Y, `region(${rx},${rz}) 基座 (${dx},${dz}) 地表 h=${h} > SEA_Y=${SEA_Y}`);
    }
  }
});

test('高台落点：floorY === 基座各列 generateHeight 的最小值（取 min 保证绝不悬空）', () => {
  for (let rx = -2; rx <= 2; rx++) for (let rz = -2; rz <= 2; rz++) {
    const a = computeMesaAnchor(rx, rz, SEED);
    if (!a) continue;
    const H = MESA_BASE_RECT_HALF;
    let mn = Infinity;
    for (let dz = -H; dz <= H; dz++) for (let dx = -H; dx <= H; dx++) {
      mn = Math.min(mn, generateHeight(a.wx + dx, a.wz + dz, SEED));
    }
    assertEqual(a.floorY, mn, `region(${rx},${rz}) floorY 是基座最低地表`);
  }
});

test('高台落点：整个 20×21 并集外接框落在本 region 内（不跨 region 边界）', () => {
  for (let rx = -2; rx <= 2; rx++) for (let rz = -2; rz <= 2; rz++) {
    const a = computeMesaAnchor(rx, rz, SEED);
    if (!a) continue;
    const U = 11;
    assertTrue(a.wx - U >= rx * 400 && a.wx + U < (rx + 1) * 400,
      `region(${rx},${rz}) x 向占地 [${a.wx - U},${a.wx + U}] 在 [${rx * 400},${(rx + 1) * 400}) 内`);
    assertTrue(a.wz - U >= rz * 400 && a.wz + U < (rz + 1) * 400,
      `region(${rx},${rz}) z 向占地 [${a.wz - U},${a.wz + U}] 在 [${rz * 400},${(rz + 1) * 400}) 内`);
  }
});

test('高台落点：不与任何空岛 AABB 相交（台顶 y=floorY+42 不得穿岛）', async () => {
  const { computeSkyCandidates } = await import('../gen/structures/sky-structures.js');
  for (let rx = -2; rx <= 2; rx++) for (let rz = -2; rz <= 2; rz++) {
    const a = computeMesaAnchor(rx, rz, SEED);
    if (!a) continue;
    const islands = computeSkyCandidates(rx, rz, SEED).skyIslands;
    for (let i = 0; i < islands.length; i += 5) {
      const ox = islands[i] * 16 + 8, oz = islands[i + 1] * 16 + 8;
      const bottom = islands[i + 2], radius = islands[i + 3];
      const xOverlap = Math.abs(ox - a.wx) <= radius + 11;
      const zOverlap = Math.abs(oz - a.wz) <= radius + 11;
      if (!xOverlap || !zOverlap) continue;
      assertTrue(bottom > a.floorY + 42,
        `region(${rx},${rz}) 空岛底 y=${bottom} 必须高于台顶 y=${a.floorY + 42}`);
    }
  }
});

test('高台落点：无沙漠的 region 返回 null（不硬塞）', () => {
  // region(1,1) 的 400×400 里既有沙漠也有森林，故不保证 null。
  // 用 forest-only 点做反向判据：若某 region 内所有 8 格步长采样点都非 DESERT，必须 null。
  let forestOnly = null;
  for (let rx = -8; rx <= 8 && forestOnly === null; rx++) for (let rz = -8; rz <= 8; rz++) {
    let anyDesert = false;
    for (let wz = rz * 400 + 13; wz < rz * 400 + 387 && !anyDesert; wz += 8) {
      for (let wx = rx * 400 + 13; wx < rx * 400 + 387; wx += 8) {
        if (getBiome(wx, wz, SEED) === 'DESERT') { anyDesert = true; break; }
      }
    }
    if (!anyDesert) { forestOnly = [rx, rz]; break; }
  }
  if (forestOnly === null) return; // 全都有沙漠：本条不适用（不是失败）
  assertEqual(computeMesaAnchor(forestOnly[0], forestOnly[1], SEED), null,
    `forest-only region(${forestOnly[0]},${forestOnly[1]}) 应返回 null`);
});

test('高台落点：MESA_SALT 不与巨树/撒布/云簇的 salt 区间重叠', async () => {
  // 程序化校验：MESA_SALT 落在 932..999 空闲带内，且不在 58..107（云簇）/ 270..397（landmarks +302+y）区间
  assertTrue(MESA_SALT >= 932 && MESA_SALT <= 999, `MESA_SALT=${MESA_SALT} 在空闲带 932..999`);
  assertFalse(MESA_SALT >= 58 && MESA_SALT <= 107, 'MESA_SALT 不与云簇 frontier 区间重叠');
  assertFalse(MESA_SALT >= 270 && MESA_SALT <= 397, 'MESA_SALT 不与 landmarks +302+y 区间重叠');
  assertFalse([911, 921, 931].includes(MESA_SALT), 'MESA_SALT 不与巨树路径 salt 相同');
});
```

- [ ] **Step 2: 确认测试失败**

Run: `npx playwright test tests/harness.spec.mjs --reporter=line`（harness 会跑全部浏览器内单测）
Expected: FAIL —— `Failed to fetch dynamically imported module: .../mesa.js`（文件不存在）

- [ ] **Step 3: 实现 `computeMesaAnchor`**

创建 `src/gen/structures/mesa.js`。文件头注释要写清三条：为什么用 15×15 矩形而非 164 格掩码（候选层不能 fetch）、为什么 floorY 取 min（不悬空优先于不埋没）、为什么必须内缩 13 格（跨 region 会半边消失）。

算法按规格 §3.3 逐步实现。关键实现约束：

- `MESA_BASE_RECT_HALF = 7`（15×15 = 225 格，多查 61 个角格，实测锚点与 164 格掩码 16/16 一致）
- 候选收集用 `step = 8`、边距 `M = 13`（= `MESA_UNION_HALF + 2`）
- 排序键：`seededRandom(wx, wz, seed + MESA_SALT)` 升序，tie 用 `(wx - bw) || (wz - bz)` 保证跨机一致
- 首个满足全部四条判据的候选即返回
- 空岛冲突：`bottomY < floorY + MESA_TOP_REL_Y` 且 AABB（`radius + MESA_UNION_HALF`）相交 → 跳过
- **候选耗尽返回 `null`**（不要兜底塞一个点）

- [ ] **Step 4: 确认测试通过**

Run: `npx playwright test tests/harness.spec.mjs --reporter=line`
Expected: PASS。同时打印实际锚点做人工核对：

```bash
node -e "
const {computeMesaAnchor}=await import('./src/gen/structures/mesa.js');
for(const [rx,rz] of [[0,0],[1,0],[1,1],[2,-1],[0,-2]]) console.log(rx,rz,computeMesaAnchor(rx,rz,12345));
"
```

Expected: region(0,0) 得到 `{wx: 21, wz: 13, floorY: 0}` 附近（floorY 允许 ±1 差异 —— 取决于 `MESA_TOP_REL_Y` 的取值口径，`assertEqual` 断言只钉「floorY === 基座 min」，不钉具体数值）。

- [ ] **Step 5: 负向验证（必须真 FAIL）**

依次临时改 `mesa.js` 的判据、跑 harness、确认 FAIL、**用 `cp` 副本还原**（⚠️ 不得用 `git checkout` —— 该文件此时还没提交）：

| 注入 | 期望失败的用例 |
|---|---|
| 删掉「基座每列 > SEA_Y」判据 | `基座 15×15 每列地表都高于海平面` |
| 删掉空岛冲突检查 | `不与任何空岛 AABB 相交` |
| `M = 13` 改成 `M = 0` | `整个 20×21 并集外接框落在本 region 内` |
| `floorY` 改为中心点 `generateHeight(wx,wz)` | `floorY === 基座各列 generateHeight 的最小值` |

- [ ] **Step 6: Commit**

```bash
git add src/gen/structures/mesa.js src/tests/test-mesa.js src/tests/index.html
git commit -m "feat(gen): 高台落点候选发现（沙漠平地 / 海平面 / 空岛 / region 内缩）"
```

---

### Task 3: 结构加载支持 palette + 扁平数组格式

**Files:**
- Modify: `src/gen/structures/structure-json.js:8-30`（`STRUCTURE_FILES`）、`:73-100`（`loadStructure` 归一化）
- Test: `src/tests/test-mesa.js`（追加一条）

**Interfaces:**
- Consumes: Task 1 的产物格式 `{version, palette:string[], blocks:number[]}`（`blocks` 是 `x,y,z,paletteIndex` 四元组扁平数组）
- Produces: `loadStructure('cloudlandMesaSmall')` 返回 `{ blocks: [{x, y, z, type, direction}] }`（**与既有 JSON 同形状**，下游 `rasterizeStructure` 零改动）

- [ ] **Step 1: 写失败测试**

在 `src/tests/test-mesa.js` 追加：

```js
test('高台产物：加载后 10712 格、bbox 20×43×21、每格 type 都在 registry 里', async () => {
  const { loadStructure } = await import('../gen/structures/structure-json.js');
  const { buildDefaultRegistry } = await import('../voxel/block-registry.js');
  const reg = await buildDefaultRegistry();
  const data = await loadStructure('cloudlandMesaSmall');
  assertEqual(data.blocks.length, 10712, '方块数');
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity, mnz = Infinity, mxz = -Infinity;
  for (const b of data.blocks) {
    mnx = Math.min(mnx, b.x); mxx = Math.max(mxx, b.x);
    mny = Math.min(mny, b.y); mxy = Math.max(mxy, b.y);
    mnz = Math.min(mnz, b.z); mxz = Math.max(mxz, b.z);
    assertTrue(reg.idOf(b.type) !== undefined, `type "${b.type}" 必须在 registry 里（否则 makeColumnSetter 静默跳过 → 空洞）`);
  }
  assertEqual(mxx - mnx + 1, 20, '宽');
  assertEqual(mxy - mny + 1, 43, '高');
  assertEqual(mxz - mnz + 1, 21, '深');
  assertEqual(mny, 1, '最低点归一化为 y=1（rasterizeStructure 按此约定减 1）');
});

test('高台产物：底部 15×15 每列至少有一个 y=1 的基座方块（无悬空列）', async () => {
  const { loadStructure } = await import('../gen/structures/structure-json.js');
  const data = await loadStructure('cloudlandMesaSmall');
  const cols = new Map();
  for (const b of data.blocks) if (b.y === 1) cols.set(`${b.x},${b.z}`, true);
  assertEqual(cols.size, 164, '基座列数（实测 Landscape/9 的 y=1 层是 164 格）');
});
```

- [ ] **Step 2: 确认测试失败**

Run: `npx playwright test tests/harness.spec.mjs --reporter=line`
Expected: FAIL —— `loadStructure('cloudlandMesaSmall')` 返回空（`STRUCTURE_FILES` 无此 key → `fetch('/assets/structures/undefined')` → catch 成空结构），断言 `0 !== 10712`

- [ ] **Step 3: 加映射 + 两形状归一化**

`STRUCTURE_FILES` 加一行：

```js
  cloudlandMesaSmall: 'cloudland_mesa_small.json',
```

`loadStructure()` 的 `.then((data) => {...})` 里，把现在的「只认 `data.blocks` 为对象数组」改成两形状：

```js
      .then((data) => {
        // 两种产物形状：
        //  ① 旧：{blocks:[{x,y,z,type,direction}]}（mc-lite 移植的 18 个 JSON）
        //  ② 新：{palette:[name...], blocks:[x,y,z,paletteIndex, ...]}（万格级结构，逐字写对象会到 500KB）
        let raw;
        if (Array.isArray(data.palette) && Array.isArray(data.blocks)) {
          raw = [];
          for (let i = 0; i < data.blocks.length; i += 4) {
            raw.push({
              x: data.blocks[i], y: data.blocks[i + 1], z: data.blocks[i + 2],
              type: data.palette[data.blocks[i + 3]], direction: 0,
            });
          }
        } else raw = data.blocks;
        let minY = Infinity;
        for (const b of raw) if (b.y < minY) minY = b.y;
        const normalized = {
          blocks: raw.map((b) => ({
            x: b.x, y: b.y - minY + 1, z: b.z,
            type: b.type, direction: b.direction !== undefined ? b.direction : 0,
          })),
        };
        cache.set(type, normalized);
        return normalized;
      })
```

- [ ] **Step 4: 确认测试通过 + 既有结构零回归**

Run: `npx playwright test tests/harness.spec.mjs --reporter=line`
Expected: PASS（含既有 `test-landmarks.js` / `test-sky-structures.js` 全部用例）

- [ ] **Step 5: Commit**

```bash
git add src/gen/structures/structure-json.js src/tests/test-mesa.js
git commit -m "feat(gen): 结构加载支持 palette 扁平数组格式（万格级结构）"
```

---

### Task 4: 接线 layout + apply 阶段 2.75 光栅化与让路

**Files:**
- Modify: `src/gen/structures/structure-layout.js:33-71`
- Modify: `src/gen/structures/apply.js`（阶段 2.75 插入、阶段 2.8 `allowedAt` 加一条、预载清单加一条）
- Test: `src/tests/test-mesa-gen.js`

**Interfaces:**
- Consumes:
  - Task 2 的 `computeMesaAnchor(regionX, regionZ, seed)`
  - Task 3 的 `loadStructure('cloudlandMesaSmall') → {blocks:[{x,y,z,type,direction}]}`（y 已归一化，最低点 = 1）
  - `apply.js` 既有的 `cityLayout`、`pointContext(wx, wz, layouts, cityLayout, seed) → {kind, ...}`、`placementIntersects(p, halfX, halfZ, cx, cz)`、`VEGETATION_EXT`
- Produces: `computeRegionLayout()` 返回值加 `mesa: {wx, wz, floorY} | null`

- [ ] **Step 1: 写失败测试**

创建 `src/tests/test-mesa-gen.js`：

```js
// src/tests/test-mesa-gen.js — 高台接线 Tier 1：layout 携带 + 真实 column GEN 逐格落位
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse } from './assert.js';
import { computeRegionLayout } from '../gen/structures/structure-layout.js';
import { computeMesaAnchor } from '../gen/structures/mesa.js';
import { applyStructuresToColumn } from '../gen/structures/apply.js';
import { loadStructure } from '../gen/structures/structure-json.js';
import { buildDefaultRegistry } from '../voxel/block-registry.js';
import { generateHeight } from '../gen/terrain.js';
import { blockIndex } from '../voxel/constants.js';

const SEED = 12345;

test('高台接线：computeRegionLayout 的 mesa 字段与 computeMesaAnchor 一致', () => {
  for (const [rx, rz] of [[0, 0], [1, 0], [2, -1]]) {
    const layout = computeRegionLayout(rx, rz, SEED);
    const direct = computeMesaAnchor(rx, rz, SEED);
    if (direct === null) { assertEqual(layout.mesa, null, `region(${rx},${rz}) 都 null`); continue; }
    assertEqual(layout.mesa.wx, direct.wx, `region(${rx},${rz}) wx`);
    assertEqual(layout.mesa.wz, direct.wz, `region(${rx},${rz}) wz`);
    assertEqual(layout.mesa.floorY, direct.floorY, `region(${rx},${rz}) floorY`);
  }
});

test('高台接线：默认 seed 的 region(0,0) 真的有锚点（否则测不到接线）', () => {
  const a = computeMesaAnchor(0, 0, SEED);
  assertTrue(a !== null, 'region(0,0) 必须有锚点');
});

test('高台接线：真实 GEN 在锚点 column 里写出高台方块，且总数跨 column 汇总 == 10712', async () => {
  const anchor = computeMesaAnchor(0, 0, SEED);
  assertTrue(anchor !== null, '前提：有锚点');
  const data = await loadStructure('cloudlandMesaSmall');
  // 找锚点占地覆盖的全部 column（20×21 并集，相对 anchor）
  const cols = new Set();
  for (const b of data.blocks) {
    const wx = anchor.wx + b.x, wz = anchor.wz + b.z;
    cols.add(`${Math.floor(wx / 16)},${Math.floor(wz / 16)}`);
  }
  assertTrue(cols.size >= 4, `高台应跨 ≥4 个 column（实际 ${cols.size}）`);
  // 逐 column 跑真实 applyStructuresToColumn，统计写进世界的格数
  const reg = await buildDefaultRegistry();
  const { ChunkColumn } = await import('../voxel/chunk-column.js'); // 构造签名：new ChunkColumn(cx, cz)
  let written = 0;
  for (const key of cols) {
    const [cx, cz] = key.split(',').map(Number);
    const column = new ChunkColumn(cx, cz);
    const layouts = [computeRegionLayout(0, 0, SEED)];
    await applyStructuresToColumn(column, SEED, reg, layouts);
    for (const b of data.blocks) {
      const wx = anchor.wx + b.x, wz = anchor.wz + b.z;
      if (Math.floor(wx / 16) !== cx || Math.floor(wz / 16) !== cz) continue;
      const id = column.blocks[blockIndex(wx - cx * 16, anchor.floorY + b.y, wz - cz * 16)];
      if (id === reg.idOf(b.type)) written++;
    }
  }
  assertEqual(written, 10712, '跨 column 汇总的高台方块数');
});

test('高台接线：高台不入城（城市 bounds 内的锚点被丢弃）', async () => {
  // 构造：把 mesa 锚点手动放进城市 bounds 内，断言 apply 阶段 2.75 不写方块。
  // 用真实 cityLayout + 一个确定在城内的假锚点（城市中心）。
  const layout = computeRegionLayout(0, 0, SEED);
  assertTrue(layout.city !== null, 'region(0,0) 有城市');
  const cityCx = Math.floor((layout.city.minX + layout.city.maxX) / 2);
  const cityCz = Math.floor((layout.city.minZ + layout.city.maxZ) / 2);
  const fakeLayout = { ...layout, mesa: { wx: cityCx, wz: cityCz, floorY: 1 } };
  const reg = await buildDefaultRegistry();
  const { ChunkColumn } = await import('../voxel/chunk-column.js');
  const cx = Math.floor(cityCx / 16), cz = Math.floor(cityCz / 16);
  const column = new ChunkColumn(cx, cz);
  const data = await loadStructure('cloudlandMesaSmall');
  await applyStructuresToColumn(column, SEED, reg, [fakeLayout]);
  let mesaWritten = 0;
  for (const b of data.blocks) {
    const wx = cityCx + b.x, wz = cityCz + b.z;
    if (Math.floor(wx / 16) !== cx || Math.floor(wz / 16) !== cz) continue;
    const id = column.blocks[blockIndex(wx - cx * 16, 1 + b.y, wz - cz * 16)];
    if (id === reg.idOf(b.type)) mesaWritten++;
  }
  assertEqual(mesaWritten, 0, '城内的高台必须一个方块都不写');
});
```

- [ ] **Step 2: 确认测试失败**

Run: `npx playwright test tests/harness.spec.mjs --reporter=line`
Expected: FAIL —— `layout.mesa` 是 `undefined`（`computeRegionLayout` 还没加该字段）

- [ ] **Step 3: layout 加字段**

`structure-layout.js`：

```js
import { computeMesaAnchor } from './mesa.js';
```

`computeRegionLayout()` 末尾：

```js
  // 高台（Cloudland Epic）：每 region 至多一个沙漠平地锚点；纯函数、无异步依赖
  // （基座判据用 15×15 常量矩形，不读烘焙产物 —— 候选层不能 fetch）。
  const mesa = computeMesaAnchor(regionX, regionZ, seed);
```

返回值加 `mesa`（与 `giantTrees` 并列）。JSDoc 的返回类型注释也加一行 `*   mesa: ({wx:number, wz:number, floorY:number}|null)`。

- [ ] **Step 4: apply.js 加预载 + 阶段 2.75 + 巨树让路**

在 `needTypes` 收集段之后（`await preloadStructures([...needTypes])` **之前**）加：

```js
  // 高台：只在锚点 column 的查询域里需要。命中才预载（同撒布结构的惰性预载理由：
  // 无条件预载会让每个新 Worker 的首个 GEN 多付一次冷 fetch）。
  const mesaAnchor = layouts.map((l) => l.mesa).find(Boolean) || null;
  if (mesaAnchor) needTypes.add('cloudlandMesaSmall');
```

在阶段 2.8（巨树）**之前**、阶段 2.7 循环之后插入：

```js
  // ---- 阶段 2.75：Cloudland 高台（桌山景观）----
  // 层序理由：撒布结构（2.7）是地面级小内容，先写；高台是地面级固定景观，在其上（后写胜）；
  // 巨树（2.8）有 allowedAt 判据可避让，故高台先于巨树。
  //
  // 让路必须在**这里**判而不能在候选层：城市 bounds 可跨 region（实测 seed=12345
  // bounds x∈[0,566]），只有持有 city 的 region [0,0] 拿得到 cityLayout —— 与 v1.74
  // 修「City 里 house 悬空」的判据落点完全同源（见 scatter.js 的口径差异②）。
  for (const layout of layouts) {
    const anchor = layout.mesa;
    if (!anchor) continue;
    const ctx = pointContext(anchor.wx, anchor.wz, layouts, cityLayout, seed);
    if (ctx.kind !== 'normal') continue; // 城市 / 地标 / 水面 一律让路
    const data = cache.get('cloudlandMesaSmall');
    if (!data || !data.blocks.length) continue;
    if (!placementIntersects({ x: anchor.wx, z: anchor.wz }, MESA_UNION_HALF, MESA_UNION_HALF, column.cx, column.cz)) continue;
    rasterizeStructure('cloudlandMesaSmall', anchor.wx, anchor.floorY + 1, anchor.wz,
      setBlock, column, registry, seed, false);
  }
```

⚠️ `cache` 是 `structure-json.js` 的模块私有变量，`apply.js` 拿不到。改法：用已 import 的 `rasterizeStructure` 即可（它内部读 cache，缓存未命中时静默 return —— 而预载已在上面 `await preloadStructures([...needTypes])` 完成，不会未命中）。故上面那段删掉 `const data = ...` 两行。

`MESA_UNION_HALF` 从 `mesa.js` import。

阶段 2.8 的 `giantAllowedAtFor` 加高台让路。改成接受额外参数并返回的判据里多一条「不落在高台占用框内」：

```js
export function giantAllowedAtFor(layouts, cityLayout, seed) {
  const mesa = layouts.map((l) => l.mesa).find(Boolean) || null;
  return (wx, wz) => {
    if (mesa &&
        Math.abs(wx - mesa.wx) <= MESA_UNION_HALF + 1 &&
        Math.abs(wz - mesa.wz) <= MESA_UNION_HALF + 1) return false; // 巨树给高台让路
    const kind = pointContext(wx, wz, layouts, cityLayout, seed).kind;
    return kind === 'normal' || kind === 'water';
  };
}
```

- [ ] **Step 5: 确认测试通过**

Run: `npx playwright test tests/harness.spec.mjs --reporter=line`
Expected: PASS（含 4 条新用例）

- [ ] **Step 6: 负向验证（必须真 FAIL）**

| 注入 | 期望失败 |
|---|---|
| 删掉阶段 2.75 的 `ctx.kind !== 'normal'` 门控 | `高台不入城` |
| 删掉 layout 的 `mesa` 字段 | `computeRegionLayout 的 mesa 字段与 computeMesaAnchor 一致` |
| 把 `rasterizeStructure` 的 y 参数从 `anchor.floorY + 1` 改成 `anchor.floorY` | `真实 GEN 在锚点 column 里写出高台方块…汇总 == 10712`（整体下沉一格 → 台面格被地形覆盖 → 计数不足） |

⚠️ 还原用 `cp` 副本，不用 `git checkout`。

- [ ] **Step 7: Commit**

```bash
git add src/gen/structures/mesa.js src/gen/structures/structure-layout.js src/gen/structures/apply.js src/tests/test-mesa-gen.js
git commit -m "feat(gen): 高台接入 layout 与 apply 阶段 2.75（含城市/地标/巨树让路）"
```

---

### Task 5: 注册测试 + 修 `check:data` 的注册完整性

**Files:**
- Modify: `src/tests/index.html:40-60`
- Test: `npm run check:data`

**Interfaces:**
- Consumes: Task 2/4 的两个测试文件
- Produces: `check:data` 的 `[测试注册]` 环节绿

- [ ] **Step 1: 确认当前注册门是红的**

Run: `npm run check:data 2>&1 | tail -20`
Expected: FAIL —— `[测试注册] 存在但未注册（= 静默不跑）：test-mesa.js, test-mesa-gen.js`

- [ ] **Step 2: 注册**

`src/tests/index.html` 在 `import './test-sky-structures.js';` 附近加两行（保持字母序邻近）：

```js
     import './test-mesa.js';
     import './test-mesa-gen.js';
```

- [ ] **Step 3: 验证**

Run: `npm run check:data 2>&1 | tail -20`
Expected: 不再报 `[测试注册]`

Run: `npx playwright test tests/harness.spec.mjs --reporter=line`
Expected: PASS，且报告的用例总数比 Task 4 结束时多 0（两个文件已经在 Task 2/4 被 harness 间接跑到，注册只影响计数完整性与 `check:data`）

- [ ] **Step 4: Commit**

```bash
git add src/tests/index.html
git commit -m "test(gen): 注册高台单测（check:data 静默不跑门）"
```

---

### Task 6: `[高台]` 数据契约门

**Files:**
- Modify: `tools/check-data.mjs`（新增 `checkCloudlandMesa()`，在 `await checkGiantTrees();` 之后调用）
- Test: `npm run check:data`

**Interfaces:**
- Consumes: Task 1 的 `cloudland-mesa-fingerprint.mjs`、`REGISTRY`、`BLOCKS`
- Produces: 无（门禁本身）

- [ ] **Step 1: 写门禁**

在 `check-data.mjs` 里仿 `checkGiantTrees()` 写 `checkCloudlandMesa()`，六条断言：

```js
async function checkCloudlandMesa() {
  const fp = await import('./cloudland-mesa-fingerprint.mjs');
  const fail = (m) => failures.push(`[高台] ${m}`);

  // ① 烘焙输入实测存在（缺失 = 仓库损坏）
  if (!fs.existsSync(fp.SCHEM_PATH)) fail(`烘焙输入缺失 ${path.relative(ROOT, fp.SCHEM_PATH)}（.schem 入库）`);

  // ② 产物存在且是合法 JSON
  if (!fs.existsSync(fp.MESA_JSON) || !fs.existsSync(fp.MESA_META)) {
    fail('缺 assets/structures/cloudland_mesa_small.json 或 .meta.json（跑 npm run mesa）');
    return;
  }
  let meta, json;
  try {
    meta = JSON.parse(fs.readFileSync(fp.MESA_META, 'utf8'));
    json = JSON.parse(fs.readFileSync(fp.MESA_JSON, 'utf8'));
  } catch { fail('产物不是合法 JSON（重跑 npm run mesa）'); return; }

  // ③ 指纹：输入变了但没重烘
  const cur = fp.cloudlandMesaInputFingerprint();
  if (meta.fingerprints?.input !== cur.input) {
    fail(`产物已过期：指纹不匹配（烘焙时 "${meta.fingerprints?.input}" vs 当前 "${cur.input}"）→ 跑 npm run mesa`);
  }

  // ④ metrics：方块数 / bbox / 基座列数
  const n = json.blocks.length / 4;
  if (n !== fp.MESA_METRICS.blocks) fail(`方块数 ${n} ≠ MESA_METRICS.blocks ${fp.MESA_METRICS.blocks}`);
  const baseCols = new Set();
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity, mnz = Infinity, mxz = -Infinity;
  for (let i = 0; i < json.blocks.length; i += 4) {
    const x = json.blocks[i], y = json.blocks[i + 1], z = json.blocks[i + 2];
    mnx = Math.min(mnx, x); mxx = Math.max(mxx, x);
    mny = Math.min(mny, y); mxy = Math.max(mxy, y);
    mnz = Math.min(mnz, z); mxz = Math.max(mxz, z);
    if (y === 0) baseCols.add(`${x},${z}`);
  }
  const M = fp.MESA_METRICS;
  if (mxx - mnx + 1 !== M.width) fail(`宽 ${mxx - mnx + 1} ≠ ${M.width}`);
  if (mxy - mny + 1 !== M.height) fail(`高 ${mxy - mny + 1} ≠ ${M.height}`);
  if (mxz - mnz + 1 !== M.depth) fail(`深 ${mxz - mnz + 1} ≠ ${M.depth}`);
  if (baseCols.size !== M.baseCells) fail(`基座列数 ${baseCols.size} ≠ ${M.baseCells}（底层面板被改动？）`);

  // ⑤ palette 每一项都在 registry，且全部是 opaque 通道
  //    理由：改成 cutout 会让 1 万格方块走 cutout 通道（每格顶点成本约 opaque 的 3 倍）
  //    → 撞破 §4.10 的容量预算。这条是「零 cutout 影响」承诺的唯一护栏。
  for (const name of json.palette) {
    const id = REGISTRY.idOf(name);
    if (id === undefined) { fail(`palette 含未注册方块 "${name}"（makeColumnSetter 静默跳过 → 高台出现空洞）`); continue; }
    if (REGISTRY.cullTable[id] !== 0) fail(`palette 方块 "${name}" 不是 opaque 通道（cutout/transparent 会撞容量预算）`);
    if (REGISTRY.opaqueTable[id] !== 1) fail(`palette 方块 "${name}" 的 opaqueTable≠1（面剔除失效 → 顶点暴涨）`);
  }

  // ⑥ 不进背包（地形景观不是可放置物品）
  //    ⚠️ 变量名以文件实际为准：`HIDDEN_FROM_INVENTORY` 是「可放置但不进背包」集合，
  //    `buildItemNames(...)` 算出的才是最终背包物品集合。两个集合语义互斥（AGENTS.md 已记）。
  //    高台方块应当：能放置（不在 NON_PLACEABLE_ITEMS）+ 不进背包（在 HIDDEN_FROM_INVENTORY）。
  for (const name of json.palette) {
    if (!HIDDEN_FROM_INVENTORY.includes(name)) {
      fail(`palette 方块 "${name}" 不在 HIDDEN_FROM_INVENTORY（高台是景观，玩家不该能在背包里选中放出单块）`);
    }
    if (NON_PLACEABLE_ITEMS.includes(name)) {
      fail(`palette 方块 "${name}" 在 NON_PLACEABLE_ITEMS（该集合是「不可放置」语义，景观方块不该进这里）`);
    }
  }
  if (baseCols.size === M.baseCells && n === M.blocks) {
    infos.push(`[高台] ${n} 格 / ${mxx - mnx + 1}×${mxy - mny + 1}×${mxz - mnz + 1} / 基座 ${baseCols.size} 列 / ${json.palette.length} 种方块（全 opaque）/ 指纹匹配`);
  }
}
```

调用点（`await checkGiantTrees();` 之后）：

```js
await checkCloudlandMesa(); // 高台：烘焙产物 / 映射表 / 通道契约（⚠️ 漏了本行则门禁永不执行）
```

⚠️ 变量名以 `check-data.mjs` 实际为准（已核准）：`infos`（第 28 行）、`REGISTRY`、`BLOCKS`、`HIDDEN_FROM_INVENTORY`、`NON_PLACEABLE_ITEMS`。高台方块要求 **在 `HIDDEN_FROM_INVENTORY`**、**不在 `NON_PLACEABLE_ITEMS`**，两个集合语义互斥（AGENTS.md 已记）。

- [ ] **Step 2: 确认门禁跑得通且是绿的**

Run: `npm run check:data 2>&1 | tail -25`
Expected: 输出含 `[高台] 10712 格 / 20×43×21 / 基座 164 列 / 14 种方块（全 opaque）/ 指纹匹配`，退出码 0

- [ ] **Step 3: 负向验证（必须真 FAIL）**

| 注入 | 期望报错 |
|---|---|
| 改 `BLOCK_MAP` 里任一 value 为 `'not_a_block'` 但**不重烘** | `产物已过期：指纹不匹配`（指纹抓住了映射表改动） |
| 手改 `cloudland_mesa_small.json` 把某个 palette 项改成 `tuff`（未注册名不存在则用一个真未注册名如 `foo`） | `palette 含未注册方块` |
| 把 `MESA_METRICS.blocks` 改成 10713 | `方块数 10712 ≠ 10713` |
| 删掉 `checkCloudlandMesa()` 的调用行 | 门禁静默不跑 → 上面三条注入全部变绿（这条本身是「漏了本行」的护栏，靠 code review 守） |

前三项还原用 `cp` 副本。

- [ ] **Step 4: Commit**

```bash
git add tools/check-data.mjs
git commit -m "chore(tools): 新增 [高台] 数据契约门（指纹/metrics/registry/通道/背包）"
```

---

### Task 7: Tier 4 真实页面验收 + 全量回归

**Files:**
- Create: `tests/mesa.spec.mjs`
- Test: 本任务全部

**Interfaces:**
- Consumes: `window.__MC_GAME__`（`world` / `player` / `scheduler` / `renderStats`）
- Produces: 无

- [ ] **Step 1: 写 spec**

创建 `tests/mesa.spec.mjs`。**必须先 `setShadowsEnabled(false)` 隔离**（VSM 下 receiveShadow 的对象也进阴影 pass → drawCalls 尖峰，见 AGENTS.md 的阴影约束），并用 `setTestAim` 类的真实路径而非手塞内部状态。

```js
import { test, expect } from '@playwright/test';

test('高台：真实页面里沙漠锚点处有 43 格高的结构，且台顶高于周边地表 ≥30 格', async ({ page }) => {
  await page.goto('/?seed=12345&vd=4');
  await page.waitForFunction(() => window.__MC_GAME__?.world && window.__MC_GAME__?.scheduler);
  await page.evaluate(() => window.__MC_GAME__.setShadowsEnabled(false));

  const anchor = await page.evaluate(async () => {
    const m = await import('/src/gen/structures/mesa.js');
    return m.computeMesaAnchor(0, 0, 12345);
  });
  expect(anchor).not.toBeNull();

  // 把玩家传送到锚点旁（+30 格），等该区域 column 收敛
  const result = await page.evaluate(async ({ wx, wz }) => {
    const g = window.__MC_GAME__;
    g.player.position[0] = wx + 30;
    g.player.position[2] = wz + 30;
    await new Promise((r) => setTimeout(r, 4000));
    // getBlockId(x, y, z) → id；column 未加载返回 0（air），故须等收敛后读
    let topY = -Infinity, groundY = Infinity;
    for (let dz = -8; dz <= 8; dz++) for (let dx = -8; dx <= 8; dx++) {
      for (let y = 95; y >= -32; y--) {
        if (g.world.getBlockId(wx + dx, y, wz + dz) !== 0) { topY = Math.max(topY, y); break; }
      }
    }
    // 周边 40~60 格的沙漠地表高度（判定「台顶确实高出很多」）
    for (let dz = -60; dz <= 60; dz += 10) for (let dx = -60; dx <= 60; dx += 10) {
      if (Math.abs(dx) < 25 && Math.abs(dz) < 25) continue;
      for (let y = 95; y >= -32; y--) {
        if (g.world.getBlockId(wx + dx, y, wz + dz) !== 0) { groundY = Math.min(groundY, y); break; }
      }
    }
    return { topY, groundY };
  }, anchor);

  expect(result.topY).toBeGreaterThan(result.groundY + 30);
});
```

✅ 签名已核准：`WorldData.getBlockId(x, y, z)`（`src/voxel/world-data.js:26`）—— column 缺失或越界返回 `0`。

- [ ] **Step 2: 跑**

Run: `npx playwright test tests/mesa.spec.mjs --reporter=line`
Expected: PASS

- [ ] **Step 3: 负向验证**

把 `apply.js` 阶段 2.75 的 `rasterizeStructure(...)` 整段注掉（改成 `continue`），重跑。
Expected: FAIL —— `topY` 退化成地形高度，`topY > groundY + 30` 不成立

还原用 `cp` 副本。

- [ ] **Step 4: 全量回归 + 性能门**

```bash
npm test 2>&1 | tail -40
npm run check
npm run bench -- --check
```

Expected:
- `npm test` 全绿（⚠️ 三条已知 flaky：`m1-acceptance` / `m3-rain` / `weapons-world-edit`；若 FAIL **单独复跑**确认是 flaky 而非新回归，不放宽断言）
- `npm run check` 全绿
- `npm run bench -- --check` 不阻断（`frameP95` 若报回退，按 AGENTS.md 做**交替对照**：`git stash` HEAD 与改动交错各跑 2~3 次比分布；⚠️ 不带 `--check` 跑会重写冻结基线，诊断后 `git checkout docs/m3-baseline.*` 恢复）

- [ ] **Step 5: 容量实测（隔离副本，真实 WebGPU 页面）**

```bash
# 在隔离副本里跑，主仓库零改动
git stash push -u
git archive HEAD --format=tar -o /tmp/head.tar && mkdir -p /tmp/mesa-head && tar -xf /tmp/head.tar -C /tmp/mesa-head
git stash pop
```

分别在 `/tmp/mesa-head`（HEAD）与主仓库（改动后）跑容量测量页，读 `renderWorld.slotMap` 的 `reservedV` / 初始容量常量（三通道）。**视点必须包含一个能看到高台的**（锚点旁 30 格，vd=8）。

Expected:
- 三通道**零扩容**（`maxVertexCount` 未变）
- opaque 占用相对 HEAD 增幅 < 3%（规格 §3.8 推演 2.05%，留余量）
- cutout / transparent 与 HEAD **逐位相同**

⚠️ 若 opaque 超线，**停下来报告实测数字**，不要自己改 `CAPACITY`（那是有意上调过的用户裁决值）。

- [ ] **Step 6: Commit**

```bash
git add tests/mesa.spec.mjs
git commit -m "test(gen): 高台真实页面 Tier 4 验收（台顶高度 / 跨 column 完整）"
```

---

### Task 8: 文档同步

**Files:**
- Modify: `docs/phase-1-engine-design.md`（修订说明首行版本号 +1，正文加阶段 2.75 的口径变更）
- Modify: `docs/roadmap.md`（改动表加一行 + 扩展点表标注高台已交付第一个变体）
- Modify: `AGENTS.md`（「活跃约束」加一条 + 「目录结构」加新文件 + 「开发命令」加 `npm run mesa`）
- Modify: `docs/superpowers/specs/2026-10-24-cloudland-mesa-design.md`（状态改为「已交付」，补实测数据）

**Interfaces:** 无

- [ ] **Step 1: 设计文档**

`docs/phase-1-engine-design.md` 的修订说明（首行「> 版本：」与状态串）版本号 +1（v1.75 → v1.76），状态串末尾追加 ` + Cloudland 高台（阶段 2.75 / 离线烘焙 + region 级沙漠锚点）`，并在修订说明表加一条记录「新增 apply 阶段 2.75：高台光栅化层序在撒布结构之后、巨树之前」。

- [ ] **Step 2: roadmap**

`docs/roadmap.md` 的「独立改动」表加一行（版本号 / 日期 / 说明），「后续扩展点」表里在矿车那行的位置附近加「Cloudland 高台 ✅ 已交付第一个变体（`Landscape/9`）；云 / 拱洞 / 其余 10 个高台待做」。

- [ ] **Step 3: AGENTS.md**

三处：
1. 「活跃约束」加一小节 **「Cloudland 高台沉淀的活跃约束」**，写清 ① 基座判据用 15×15 矩形而非 164 格掩码（候选层不能 fetch）；② `floorY` 取 min（不悬空优先）；③ 让路在 `apply.js` 不在候选层（城市 bounds 跨 region）；④ palette 必须全 opaque（cutout 会撞容量）；⑤ `npm run mesa` 不跑则产物静默过期（`[高台]` 指纹会抓）。
2. 「目录结构」加 `assets/cloudland/` + `tools/bake-cloudland-mesa.mjs` + `tools/cloudland-mesa-fingerprint.mjs` + `tools/nbt-reader.mjs` + `src/gen/structures/mesa.js`。
3. 「开发命令」加 `npm run mesa`。

- [ ] **Step 4: 规格文档状态回填**

规格文档头部的 `**状态**：` 改为「**已交付**（验收报告 / 计划路径）」，并把 Task 7 实测的容量 / 性能真数字补进 §3.8 与 §1.2。

- [ ] **Step 5: 验证文档无漂移**

```bash
grep -rn "v1.75" docs/phase-1-engine-design.md AGENTS.md docs/roadmap.md | head
grep -rn "npm run mesa" AGENTS.md package.json docs/roadmap.md
```

Expected: 版本号只在新版本处出现；`npm run mesa` 三处齐备且拼写一致。

- [ ] **Step 6: Commit**

```bash
git add docs/phase-1-engine-design.md docs/roadmap.md AGENTS.md docs/superpowers/specs/2026-10-24-cloudland-mesa-design.md
git commit -m "docs: 高台 Epic 交付回填（设计文档 v1.76 / roadmap / 活跃约束）"
```

---

## Self-Review

**1. 规格覆盖**：§3.1 数据契约 → Task 1/3；§3.2 映射表 → Task 1/6；§3.3 落点 → Task 2；§3.4 让路 → Task 4；§3.5 层序 → Task 4；§3.6 烘焙 → Task 1；§3.7 接线 → Task 3/4；§3.8 容量 → Task 7 Step 5；§3.9 salt → Task 2 末条用例；§3.10 已有存档 → 无需任务（沿用既有 `restoreEdits` 路径，无代码改动）；§5 测试分级 → Task 2/4/6/7。**无缺口。**

**2. 步骤扫描**：每步都是「写测试 / 跑测试 / 实现 / 验证 / 提交」之一，无「处理边界情况」这类空步。唯一偏长的 Step 是 Task 1 Step 4 的 `BLOCK_MAP` —— 那是**确切内容**（规格固定的数据），不是代码体。

**3. 类型一致性**：`computeMesaAnchor` 返回 `{wx, wz, floorY}` 在 Task 2 定义、Task 4 消费，字段名三处一致；`loadStructure` 返回 `{blocks:[{x,y,z,type,direction}]}` 在 Task 3 定义、Task 4 消费，一致；`MESA_UNION_HALF` / `MESA_BASE_RECT_HALF` / `MESA_TOP_REL_Y` / `MESA_SALT` 四个常量全在 Task 2 的 `mesa.js` 定义，Task 4 只 import 不重定义。

**4. Review Focus**：五条各有着落 —— ①海平面（Task 2）、②空岛（Task 2）、③城市（Task 4）、④跨 region（Task 2）、⑤映射漂移（Task 1 throw + Task 6 registry 检查）。

**5. 比例**：计划约为规格的 1.6 倍长度，其中代码块以**测试断言**为主（那是「确切值」，不是实现体），实现步骤只给签名与判据。符合比例要求。
