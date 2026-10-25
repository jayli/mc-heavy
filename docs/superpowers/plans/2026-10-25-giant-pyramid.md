# 巨型金字塔（Giant Pyramid Maze）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在沙漠里加一座 49×25×49 的沙子系巨型金字塔迷宫，平均每 2 块沙漠出现 1 座，且不与任何既有建筑/景观重合。

**Architecture:** 三段式，与 `src/gen/structures/mesa.js`（Cloudland 高台）同构：region 级纯函数候选发现（`computeGiantPyramidAnchor`）→ 内联进 `computeRegionLayout` → `apply.js` 阶段 2.76 按锚点光栅化。素材离线烘焙成 palette 索引 JSON，几何复用既有 mesher 模板（`planks_step` / `half_block`），只新增 2 个方块、零新增贴图。

**关于迷宫可走性（实测，必读）：** 本仓物理是 **格子级**碰撞（`world.isSolid(x,y,z)` 读 `solidTable`），所以台阶/半砖在碰撞上就是**整格**。实测将原模型按本仓口径重算：可站立格 2400、从外圈可达 2364、**未达 36 格**（均为 y≥12 的高层死角，形成一个独立的 36 格连通域）。而原版口径（台阶算半格）是 4798/4798 全可达。

⇒ **这不是缺陷，是已接受的代价**：若把台阶映射成整格 `sand` 会更糟（把楼梯口直接堵死，实测可站立格降到 2401 但通路变少）；而给台阶做真半格碰撞是另一个 Epic（要改 `physics`/`world.isSolid` 的语义，影响所有既有台阶方块）。本计划的做法 = **保留台阶几何（视觉上是楼梯）、碰撞按整格**，迷宫主体可达，36 格高层死角接受（用户自己的原模型素材，不影响从中庭向上探索）。

**Tech Stack:** 纯 ES2022 JS + ES Modules，无 bundler；three r185.1（本 Epic 不碰渲染层）；Node 侧烘焙脚本用 `node:zlib` + 既有 `tools/nbt-reader.mjs`；测试 = 浏览器内单测（`src/tests/`）+ Playwright spec（`tests/`）。

**Spec:** `docs/superpowers/specs/2026-10-25-giant-pyramid-design.md`

## Global Constraints
以下每条都来自 spec 或本仓 `AGENTS.md`，每个任务都隐式包含：

- **材质**：只允许 `sand` / `sand_step` / `sand_slab` 三种方块；**禁止** `smooth_sandstone`、砖块族、木族。
- **体量**：原尺寸 1×（49 × 24 × 49 归一化后，世界高 = `floorY + PYRAMID_HEIGHT`，`PYRAMID_HEIGHT = 24`）。
- **落点**：占地 49×49（半宽 `PYRAMID_HALF = 24`）**全 DESERT biome** + **全 `generateHeight > SEA_Y`** + **占地内地表高差 ≤ `PYRAMID_MAX_SURFACE_SPAN = 4`** + **完整落在本 region 内（内缩 `PYRAMID_INSET = 25`）**。
- **`floorY` = 占地内 `generateHeight` 的最小值**（取 min，绝不取中心点）。
- **去重**：`PYRAMID_MIN_SPACING = 384`（切比雪夫），**单向**比较（只跟字典序更小的 region 比）。
- **概率门**：`PYRAMID_CHANCE = 0.53`，salt = **960（排序）/ 961（门）**（程序化扫描确认：940~1015 中已占用 941/950/951/956/1000，960/961 空闲）。
- **两个新方块**：`sand_step`（geometry `planks_step`）、`sand_slab`（geometry `half_block`），均 `cullMode: "cutout"` + **显式 `"opaque": false`** + `orientationModes: 4`（`sand_slab` 用 0，它是 box 类半高、不需朝向）。
- **禁止**：新增 Worker、`import three`（在 `src/gen/**` 内）、第二份几何定义、`Math.random()`、硬编码用例计数。
- **Tier 1 走 TDD**（RED → 验证 RED → GREEN → 验证 GREEN）；Tier 2 免 TDD 流程。
- **不 commit**：本仓 `AGENTS.md` 规定「未获明确指令不得自动提交」——计划里的 commit 步骤**默认不执行**，除非用户在开始执行时明确授权。执行者遇到 commit 步骤时跳过并把改动留给用户。

## Review Focus

以下六类输入/条件是 spec 隐含、但没有哪个任务的测试直接覆盖的，最可能咬到玩家。每条都在下文对应任务的测试里有一条钉子：

1. **占地被洞穴挖空**：`carveCaves` 在 `fillColumn` 之后、结构注入之前跑。实测 4 座金字塔 9604 列里有 **10 列（0.104%）** 塔基下方 6 格内全空 —— 玩家会看到塔底一个 1 格宽的洞。**Task 7** 的「塔基支撑」用例把阈值定在 **≤ 1%**（实测 0.104%，差一个数量级）。
2. **玩家改动过的旧 column**：结构只在 GEN 时写入，`edits` 叠在其上。玩家此前挖掉的方块不会回来、新放的不被覆盖 —— 这是本仓既有口径（与高台/巨树一致），**Task 7** 用一条用例把它钉成预期行为而不是缺陷。
3. **两座金字塔同时可见**：`MIN_SPACING = 384` 小于视距 16 的直径 512，最坏会同时在屏上。实测（**真 mesher、逐 section 量**）单座 reserved = opaque **65,080** / cutout **73,170**（合计 138K，与手算的 95K 差 43% —— 因为**相邻 section 不互相剔除**，手算按「整座当一个 world」算的）。两座 = opaque 3.0% / cutout 6.7%（现峰值 73.4% / 38.3%）—— **Task 10 / 11** 的预算门必须覆盖这个情形，而不是只看「一座都看不见」的视域。
4. **塔顶是否穿云/撞空岛**：`floorY + 24 ≤ 33`（沙漠地表 max=9），云在 y=35/55、空岛底 y≥40。这条由**常量断言**守着（**Task 5**），因为一旦有人改 `PYRAMID_HEIGHT` 或沙漠高度模型，症状是「某天世界穿帮」而不是测试失败。
5. **撒布结构被埋进塔里**：`desertPyramid` 保留（用户裁定），它与巨型金字塔可能落在同一块沙漠 —— 若不剔除，那个 24 格高的小神殿会长在塔身内部，从外面看像塔上多出一块。**Task 7** 的措辞必须能区分「被正确剔除」与「本来就没候选」。
6. **台阶的碰撞是整格（本仓物理口径）**：迷宫有 36 格（占可站立格 1.5%）在高层形成独立连通域，玩家走不到。**Task 11** 的「迷宫连通」用例必须用**本仓口径**（台阶=整格），阈值定在 ≥ 95%；若用原版口径（台阶=半格）会得到 100% 但实际上没人走得到那里。

---

## File Structure

**新增**

| 路径 | 职责 | 规模 |
|---|---|---|
| `assets/giant-pyramid/src/small_pyramid_maze.litematic` | 烘焙输入（入库） | 5.6 KB（现为 `/Users/bachi/Downloads/Small Pyramid Maze.litematic`） |
| `assets/structures/giant_pyramid.json` | 产物：`{version, palette, blocks}` | ~320 KB |
| `assets/structures/giant_pyramid.meta.json` | 产物元数据 + 指纹 | < 1 KB |
| `tools/litematic-reader.mjs` | litematic → `{size, palette, blocks}` | ~90 行 |
| `tools/giant-pyramid-fingerprint.mjs` | `BLOCK_MAP` / `PYRAMID_METRICS` / 指纹（烘焙与门禁共用） | ~90 行 |
| `tools/bake-giant-pyramid.mjs` | `npm run pyramid` | ~130 行 |
| `src/gen/structures/giant-pyramid.js` | 锚点候选 + `inGiantPyramidFootprint` + 常量 | ~200 行 |
| `src/tests/test-giant-pyramid.js` | Tier 1 单测 | ~230 行 |
| `src/tests/test-giant-pyramid-gen.js` | Tier 1 接线单测 | ~200 行 |
| `tests/giant-pyramid.spec.mjs` | Tier 4 实测 | ~180 行 |

**改动**

| 路径 | 改动 |
|---|---|
| `src/voxel/blocks-data.js` | 追加 2 行（`sand_step` / `sand_slab`） |
| `src/voxel/faces-data.js` | 追加 2 行（六面 tile 数组） |
| `src/gen/structures/structure-json.js` | `STRUCTURE_FILES` 加 `giantPyramid` |
| `src/gen/structures/city-layout.js` | 新增 `getCityBoundsForSeed(seed)` |
| `src/gen/structures/mesa.js` | 抽出导出 `regionLandmarkCenters()`，`landmarkCircles` 改为它的调用方 |
| `src/gen/structures/structure-layout.js` | `computeRegionLayout` 增加 `giantPyramid` 字段 |
| `src/gen/structures/apply.js` | 阶段 2.76 光栅化 + `pointContext` 新分支 + 阶段 2.7 撒布剔除 |
| `src/workers/world-worker.js` | `layout` 入口预热 `getCityBoundsForSeed` |
| `tools/check-data.mjs` | 新增 `[巨型金字塔]` 环节 |
| `package.json` | `"pyramid"` 脚本 |
| `src/tests/index.html` | 注册 2 个新测试文件 |
| `AGENTS.md` / `docs/roadmap.md` | 新增活跃约束与验收报告条目 |

---

### Task 1: litematic 读取器（纯读取，无副作用）

**Files:**
- Create: `tools/litematic-reader.mjs`
- Test: 本任务的验证是**脚本直跑**（不是 TDD 测试）—— 它是一次性离线读取，判据是「解码格数 == 文件自带的 `TotalBlocks`」，那是文件自身的完整校验和，比任何自写断言都强。

**Interfaces:**
- Consumes: `tools/nbt-reader.mjs` 的 `NbtReader`（已有，`constructor(buf)` + `u1()` + `str()` + `payload(tag)`）。
- Produces: `readLitematic(buf) → { size: {x,y,z}, palette: string[], blocks: Uint16Array, regionName: string }`
  - `size` 取绝对值后的 `Metadata.EnclosingSize`
  - `palette[i]` 是**已剥掉 `minecraft:` 前缀与属性后缀**的方块名（如 `smooth_sandstone`），但**保留 `stairs`/`slab` 等类型词**
  - `blocks` 长度 = `size.x * size.y * size.z`，索引序 `(y*sz + z)*sx + x`，值是 palette 下标

- [ ] **Step 1: 先写解复用校验脚本，确认解码口径**

创建临时文件 `.tmp-verify-litematic.mjs`。⚠️ **本仓 `.gitignore` 不忽略根目录的 `.tmp-*`**（它只忽略 `tests/tmp-*`），用完必须删（Step 6），或直接放 `/tmp`：

```js
import fs from 'node:fs';
import { readLitematic } from './tools/litematic-reader.mjs';

const buf = fs.readFileSync('assets/giant-pyramid/src/small_pyramid_maze.litematic');
const r = readLitematic(buf);
const total = r.blocks.reduce((n, v) => n + (v !== 0 ? 1 : 0), 0);
console.log('size', r.size, 'palette', r.palette.length, 'totalNonAir', total);
// 文件自带 TotalBlocks = 17966（含 barrier），这才是权威对照
console.log('TotalBlocks from NBT =', r.totalBlocks);
```

- [ ] **Step 2: 跑它，确认 FAIL（模块不存在）**

Run: `node .tmp-verify-litematic.mjs`
Expected: `ERR_MODULE_NOT_FOUND: Cannot find module './tools/litematic-reader.mjs'`

- [ ] **Step 3: 放素材入库**

```bash
mkdir -p assets/giant-pyramid/src
cp "/Users/bachi/Downloads/Small Pyramid Maze.litematic" assets/giant-pyramid/src/small_pyramid_maze.litematic
```

- [ ] **Step 4: 实现 `readLitematic`**

`tools/litematic-reader.mjs`。**实现要点**（这些是实测出来的，不是按格式定义推断的）：

- 输入是 **gzip 压缩**的 NBT → `zlib.gunzipSync()`。
- 根 compound；`Metadata.EnclosingSize` 是 `{x,y,z}`，**`Regions.<name>.Size` 是负数**（取 `EnclosingSize` 的绝对值，不要用 `Size`）。
- `Regions` 可能有多个，**第一个 region** 就是全部内容（本素材实测只有 `'Small Pyramid Maze'`）。
- `BlockStates` 是 **LongArray（tag 12）**，元素是 BigInt；位宽 `bits = max(2, ceil(log2(palette.length)))`。
- **位打包跨 long 连续**（不是 `.schem` 的 varint 流，也不是「每个 long 塞 floor(64/bits) 个、不跨边界」—— 后者实测解出 60025 格乱码）：

```js
function readPackedAt(longs, bits, mask, i) {
  const bitPos = i * bits;
  const li = Math.floor(bitPos / 64);
  const off = bitPos - li * 64;
  let v = longs[li] >> BigInt(off);
  if (off + bits > 64) v |= longs[li + 1] << BigInt(64 - off);
  return Number(v & mask);
}
```

- 索引序 `(y * sz + z) * sx + x`。
- `palette` 剥前缀与属性：`name.replace('minecraft:', '').split('[')[0]`。
- 返回值额外带 `totalBlocks`（读 `Metadata.TotalBlocks`，tag 3 = Int）。
- ⚠️ **`blocks` 里 barrier 的下标要保留**（不要在这里过滤）——过滤是烘焙脚本的职责（`BLOCK_MAP` 里 `barrier: ''`）。读者只做「字节 → 下标」的忠实翻译，这样验证脚本才能用「非 0 格数 == `TotalBlocks`」核对解码口径。

- [ ] **Step 5: 跑验证脚本，确认 PASS**

Run: `node .tmp-verify-litematic.mjs`
Expected:
```
size { x: 49, y: 25, z: 49 } palette 17 totalNonAir 17966
TotalBlocks from NBT = 17966
```
**两个数字必须精确相等**。不等说明位打包或索引序错了。

- [ ] **Step 6: 删除临时脚本**

```bash
rm .tmp-verify-litematic.mjs
```

---

### Task 2: 方块映射表 + 指纹共享模块

**Files:**
- Create: `tools/giant-pyramid-fingerprint.mjs`
- Test: 本模块的全部数值都被 Task 3 的烘焙断言与 Task 8 的 `check:data` 消费；它自身没有逻辑可测（纯数据 + 一个哈希函数）。

**Interfaces:**
- Consumes: 无。
- Produces:
  - `LITEMATIC_PATH`、`PYRAMID_JSON`、`PYRAMID_META`（绝对路径字符串）
  - `BLOCK_MAP: Readonly<Record<string, string>>` —— 源方块名 → 本仓 registry 名；`''`（空串）表示「映射到空气即跳过」
  - `PYRAMID_METRICS: Readonly<{width, height, depth, blocks, stepCells, slabCells, baseCells, paletteSize}>`
  - `giantPyramidInputFingerprint() → {input, litematicSha256, paramsSha256}`

- [ ] **Step 1: 实现模块**

`tools/giant-pyramid-fingerprint.mjs`。⚠️ **`BLOCK_MAP` 的 key 还不能定稿**：实测 palette 里台阶是同一个 `Name`（`smooth_sandstone_stairs`）+ 不同 `Properties`（`shape`/`facing`），而 `readLitematic` 只剥出名字。所以映射表的 key **必须把 shape 与 facing 带上**。下面的骨架里用**编译式**的 key 表示：

```js
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');

export const LITEMATIC_PATH = path.join(ROOT, 'assets', 'giant-pyramid', 'src', 'small_pyramid_maze.litematic');
export const PYRAMID_JSON = path.join(ROOT, 'assets', 'structures', 'giant_pyramid.json');
export const PYRAMID_META = path.join(ROOT, 'assets', 'structures', 'giant_pyramid.meta.json');

/**
 * 直台阶的 `facing` → 本体仓 `meta` 低 2 位的 orient。
 *
 * ⚠️ **这张表是实测出来的，不是按 Minecraft 定义推的**。实测手法：用真实 mesher
 * （`buildSectionMesh`）对一个 `planks_step` 方块分别设 orient = 0/1/2/3，读发射出的
 * 顶点里「y > 0.5 那半部」的 bbox，得到高侧的朝向：
 *
 *   orient=0 → 高侧在 x∈[0,0.5]（西/-X）
 *   orient=1 → 高侧在 z∈[0.5,1]（南/+Z）
 *   orient=2 → 高侧在 x∈[0.5,1]（东/+X）
 *   orient=3 → 高侧在 z∈[0,0.5]（北/-Z）
 *
 * 而素材里直台阶的 `facing` 实测语义（seed 无关，全量统计 1173 格）：**facing 方向 = 高侧**
 * （对 4 个 facing 各统计：facing 方向同层有实心 44~56%，facing 反方向同层有实心 **100%**
 * — 即反方向才是“低的那边/走过来的一边”，facing 指向更高的那一半）。
 * ⇒ facing → orient 直接按「facing 方向 == 高侧方向」对到上表。
 *
 * 若怀疑这张表，用 `npm run pyramid -- --census-orient` 重测（烘焙脚本自带的校验入口）。
 */
export const FACING_TO_ORIENT = Object.freeze({
  west: 0,   // 高侧 -X
  south: 1,  // 高侧 +Z
  east: 2,   // 高侧 +X
  north: 3,  // 高侧 -Z
});

/**
 * 源方块名 → 目标方块名。**空串 = 丢弃**（当作空气）。
 * key 必须与 litematic palette 剔净后的名字逐字一致（用 `--census` 核对）。
 * 台阶/半砖不走这张表 —— 它们的形状由 Properties 决定，走 Target 分类（见 bake 脚本）。
 */
export const BLOCK_MAP = Object.freeze({
  air: '',
  smooth_sandstone: 'sand',
  barrier: '',
  // 转角台阶：无对应几何，用直台阶近似（spec 偏离 ①），同样在 bake 脚本的 Target 分类里处理
});

export const PYRAMID_METRICS = Object.freeze({
  width: 49, height: 24, depth: 49,
  blocks: 16207,     // 由「解码格数 == TotalBlocks 17966」与「36 格 barrier/非实心」双重确认
  stepCells: 1219,   // ⚠️ 占位：由 Task 3 Step 4 打印的实际值回填
  slabCells: 6,      // ⚠️ 同上
  baseCells: 2401,   // y=1 层满铺 49×49（实测）
  paletteSize: 3,    // sand / sand_step / sand_slab
});
```

⚠️ **`stepCells` / `slabCells` 的精确值要在 Task 3 烘焙时由脚本打印的实际值回填** —— 计划阶段按 palette 条目相加得到 1219/6，但那是**总格数口径**而非「直台阶/转角分开」；**Task 3 Step 4 会打印真实分类计数，用它回填这两个常量**。`blocks` / `baseCells` 已由「解码格数 == TotalBlocks」与「y=0 层 2401 格」双重确认，不需回填。

- [ ] **Step 2: 实现指纹函数**

同文件末尾，照 `tools/giant-trees-fingerprint.mjs` 的形状（`fs.existsSync` 缺失即 throw，因为它是入库文件）：

```js
export function giantPyramidInputFingerprint() {
  if (!fs.existsSync(LITEMATIC_PATH)) throw new Error(`[金字塔] 烘焙输入缺失：${LITEMATIC_PATH}`);
  const litematicSha256 = createHash('sha256').update(fs.readFileSync(LITEMATIC_PATH)).digest('hex');
  const paramsSha256 = createHash('sha256')
    .update(JSON.stringify({ BLOCK_MAP, PYRAMID_METRICS }))
    .digest('hex');
  return {
    input: `${litematicSha256.slice(0, 16)}:${paramsSha256.slice(0, 16)}`,
    litematicSha256,
    paramsSha256,
  };
}
```

- [ ] **Step 3: 验证模块可加载 + 指纹可算**

Run: `node -e "import('./tools/giant-pyramid-fingerprint.mjs').then(m => console.log(m.giantPyramidInputFingerprint()))"`
Expected: 打印 `{ input: '<32 hex chars>', litematicSha256: '…', paramsSha256: '…' }`，不抛错。

---

### Task 3: 烘焙脚本（`npm run pyramid`）

**Files:**
- Create: `tools/bake-giant-pyramid.mjs`
- Modify: `package.json`（加 `"pyramid": "node tools/bake-giant-pyramid.mjs"`）
- Output: `assets/structures/giant_pyramid.json` + `assets/structures/giant_pyramid.meta.json`

**Interfaces:**
- Consumes: `readLitematic`（Task 1）、`BLOCK_MAP` / `PYRAMID_METRICS` / 路径常量 / `giantPyramidInputFingerprint`（Task 2）。
- Produces: 磁盘产物。形状 = `{version:1, sourceBlocks:17966, palette: string[], blocks: number[]}`，`blocks` 每 4 项 `[x, y, z, paletteIndex]`，`y ∈ [1, 24]`（归一化：最底层 = 1），坐标相对锚点中心。

- [ ] **Step 1: 实现烘焙脚本（含 `--census` 模式）**

`tools/bake-giant-pyramid.mjs`。**必须先有 census 模式**，因为映射表要对着真实源名写 —— 这也正是 `bake-cloudland-mesa.mjs` 的做法。

census 模式（`node tools/bake-giant-pyramid.mjs --census`）打印：

```
每个 palette 条目的：原始 Name + Properties + 格数 + 映射结果
```

映射逻辑（**关键：台阶朝向进 `meta`，不是进方块名**）。`FACING_TO_ORIENT` 已在 Task 2 定义（实测得出），这里直接 import 使用：

```js
import { FACING_TO_ORIENT, BLOCK_MAP, PYRAMID_METRICS } from './giant-pyramid-fingerprint.mjs';

/** 一个 palette 条目 → 目标方块名 + meta。`null` = 丢弃（当作空气）。 */
function classify(entry) {
  const name = entry.Name.replace('minecraft:', '');
  const props = entry.Properties || {};
  if (name === 'air' || name === 'barrier') return null;
  if (name === 'smooth_sandstone') return { block: 'sand', meta: 0 };
  if (/_stairs$/.test(name)) {
    // 直台阶与转角台阶都映射到 sand_step（转角用直台阶近似，spec 偏离 ①）。
    // 朝向 = facing 方向 = 高侧（实测：1173 格直台阶 100% 朝向塔心，即向内收的阶梯）。
    const o = FACING_TO_ORIENT[props.facing];
    if (o === undefined) throw new Error(`台阶 facing 未知：${props.facing}（${name}）`);
    return { block: 'sand_step', meta: o };
  }
  if (/_slab$/.test(name)) {
    // double = 整格；bottom = 半砖（塔尖唯一 1 格）。top 不存在，出现即 throw（数据异常）。
    if (props.type === 'double') return { block: 'sand', meta: 0 };
    if (props.type === 'bottom') return { block: 'sand_slab', meta: 0 };
    throw new Error(`半砖 type 未知：${props.type}（${name}）`);
  }
  throw new Error(`未映射的源方块：${name}（补 BLOCK_MAP 后重跑）`);
}
```

⚠️ **转角台阶（`outer_left` / `outer_right`）也走 `/_stairs$/` 分支** —— 它们的 `facing` 同样指向该台阶的“高侧”那一半，直接当直台阶用即可（观感差异 = 路口内侧缺一个 0.5³ 的角，用户已接受）。**不要**为转角写单独分支：本仓没有转角几何，写分支只能落到同一个目标。

烘焙主体：

1. `readLitematic` 读素材；
2. 逐格映射（跳过 `''`）；统计每类计数；
3. 平移：`x' = x - 24`、`z' = z - 24`（49 宽的中心 = 24）、`y' = y + 1`（最底层从 0 变 1，与 `rasterizeStructure` 的 y-1 落位约定对齐）；
4. palette 压缩（按首次出现顺序）；
5. 断言（见 Step 3）；
6. 写 JSON + meta。

meta 形状照 `cloudland_mesa_small.meta.json`：

```js
{
  version: 1,
  sourceBlocks: 17966,
  width: 49, height: 24, depth: 49,
  blocks: <实际>,
  stepCells: <实际>,
  slabCells: <实际>,
  baseCells: <实际>,
  paletteSize: <实际>,
  fingerprints: { input, litematicSha256, paramsSha256 },
}
```

- [ ] **Step 2: 验证 `FACING_TO_ORIENT`（照原计划照做，但改成本地实测脚本，**不依赖 orientation.js**）**

⚠️ **`src/player/orientation.js` 不覆盖台阶的几何朝向**（它管的是「放置时方块朝向玩家 yaw」的三分支逻辑，不是 `TEMPLATES.planks_step` 的高侧在哪）。所以不要从它推映射。

真正的验证 = **用真实 mesher 量出 orient → 高侧方向**。在仓库根建 `.tmp-orient-probe.mjs`（用完删）：

```js
import { buildSectionMesh } from './src/mesh/mesher.js';
import { createRegistry } from './src/voxel/block-registry.js';
import { BLOCKS } from './src/voxel/blocks-data.js';

const reg = createRegistry();
for (const d of BLOCKS) reg.register(d.name, d);
reg.register('probe_step', { solid:true, cullMode:'cutout', opaque:false, orientationModes:4, geometry:'planks_step' });
reg.freeze();
const VIEW = 18;
const atlasMeta = { tiles: new Proxy({}, { get: () => ({ u0:0, v0:0, u1:1, v1:1 }) }) };
const id = reg.idOf('probe_step');
const idx = (x,y,z) => x + z*VIEW + y*VIEW*VIEW;
for (let orient = 0; orient < 4; orient++) {
  const data = new Uint16Array(VIEW**3), meta = new Uint8Array(VIEW**3);
  const light = new Uint8Array(VIEW**3).fill(0xFF);
  data[idx(9,9,9)] = id; meta[idx(9,9,9)] = orient;   // 格内局部坐标 (8,8,8)
  const g = buildSectionMesh({ data, light, meta }, reg, atlasMeta, 0, 0, 0).cutout;
  // ⚠️ 必须过 y > 8.5（绝对 section 坐标，不是 y > 0.5）—— 只取上半个 box
  let mnx=1e9, mxx=-1e9, mnz=1e9, mxz=-1e9;
  for (let i = 0; i < g.positions.length; i += 3) {
    const x = g.positions[i], y = g.positions[i+1], z = g.positions[i+2];
    if (y <= 8.5 + 1e-6) continue;
    mnx=Math.min(mnx,x); mxx=Math.max(mxx,x); mnz=Math.min(mnz,z); mxz=Math.max(mxz,z);
  }
  const cx = ((mnx+mxx)/2) - 8, cz = ((mnz+mxz)/2) - 8;
  console.log(`orient=${orient} 高侧 bbox x[${(mnx-8).toFixed(2)},${(mxx-8).toFixed(2)}] z[${(mnz-8).toFixed(2)},${(mxz-8).toFixed(2)}]`);
}
```

Run: `node .tmp-orient-probe.mjs`

Expected（**这是本计划已实测过的结果**，你的机器应得到同样四行）：
```
orient=0 高侧 bbox x[0.00,0.50] z[0.00,1.00]
orient=1 高侧 bbox x[0.00,1.00] z[0.50,1.00]
orient=2 高侧 bbox x[0.50,1.00] z[0.00,1.00]
orient=3 高侧 bbox x[0.00,1.00] z[0.00,0.50]
```
⇒ **orient 0/1/2/3 的高侧分别在 -X / +Z / +X / -Z**。若你的结果不同（例如 ±Z 颠倒），**以你的实测为准修改 `FACING_TO_ORIENT`**，并在注释里写清日期与实测手法。

然后删掉临时脚本：`rm .tmp-orient-probe.mjs`。

- [ ] **Step 3: 跑 census 模式，对着真实源名核对映射表**

Run: `npm run pyramid -- --census`
Expected: 打印 17 个 palette 条目，每条都有明确的映射目标或「丢弃」，末尾 `全部已映射`。

若有未映射条目 → 补 `BLOCK_MAP` 后重跑。

- [ ] **Step 4: 跑烘焙，读真实计数**

Run: `npm run pyramid`
Expected 输出形如：
```
金字塔 JSON <kb> KB，<n> 格（sand <a> / sand_step <b> / sand_slab <c>），49×24×49，palette 3 种，基座 2401 列
指纹 <16hex>:<16hex>
```
**把打印出来的 `<b>` 与 `<c>` 回填 Task 2 的 `PYRAMID_METRICS.stepCells` / `slabCells`，然后重跑一次**（指纹会变，这是预期：参数改了就该重烘）。

- [ ] **Step 5: 验证产物**

Run:
```bash
node --input-type=module -e "
import fs from 'node:fs';
const j = JSON.parse(fs.readFileSync('assets/structures/giant_pyramid.json','utf8'));
const m = JSON.parse(fs.readFileSync('assets/structures/giant_pyramid.meta.json','utf8'));
console.log('blocks', j.blocks.length/4, 'palette', j.palette);
console.log(JSON.stringify(m));
"
```

Expected:
- `blocks` 数 == `PYRAMID_METRICS.blocks`（16207）
- `palette` 恰好是 `['sand', 'sand_step', 'sand_slab']` 三个（顺序按首次出现，可能不同）
- meta 的 `baseCells` == 2401
- meta 的 `stepCells` + `slabCells` + sand 格数 == 16207

---

### Task 4: 两个新方块声明（`sand_step` / `sand_slab`）

**Files:**
- Modify: `src/voxel/blocks-data.js`（在 `sand` 那行附近追加）
- Modify: `src/voxel/faces-data.js`（在台阶段追加）
- Test: `src/tests/test-block-registry.js`（追加 2 条用例）

**Interfaces:**
- Consumes: 既有模板 `TEMPLATES.planks_step` / `TEMPLATES.half_block`（`src/mesh/mesher.js`，**几何零新增**）。
- Produces: `registry.idOf('sand_step')`、`registry.idOf('sand_slab')` 可用；两张表 `cullTable === 1`（cutout）、`opaqueTable === 0`。

- [ ] **Step 1: 写失败测试**

在 `src/tests/test-block-registry.js` 末尾追加：

```js
test('巨型金字塔方块：sand_step / sand_slab 走 cutout + opaqueTable=0（非 box 几何必须显式声明）', async () => {
  const { buildDefaultRegistry } = await import('../voxel/block-registry.js');
  const { BLOCKS } = await import('../voxel/blocks-data.js');
  const reg = await buildDefaultRegistry();
  const byName = new Map(BLOCKS.map((b) => [b.name, b]));
  for (const [name, geom] of [['sand_step', 'planks_step'], ['sand_slab', 'half_block']]) {
    const def = byName.get(name);
    assertTrue(def !== undefined, `${name} 必须在 blocks-data.js 里声明`);
    assertEqual(def.cullMode, 'cutout', `${name} 走 cutout 通道（opaque 通道 alphaTest=0，且模板面不分通道）`);
    assertEqual(def.opaque, false, `${name} 必须显式 opaque:false（AGENTS.md：非 box 几何须显式声明）`);
    assertEqual(def.geometry, geom, `${name} 复用既有几何模板 ${geom}（禁止第二份几何定义）`);
    const id = reg.idOf(name);
    assertEqual(reg.cullTable[id], 1, `${name} cullTable == 1 (cutout)`);
    assertEqual(reg.opaqueTable[id], 0, `${name} opaqueTable == 0（不剔邻居面，否则塔身出现洞）`);
    assertEqual(reg.solidTable[id], 1, `${name} 必须是实心（玩家要能站上去）`);
  }
  // 台阶朝向必须可旋转（meta 低 2 位）
  assertEqual(byName.get('sand_step').orientationModes, 4, 'sand_step 需要 4 向朝向');
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `npx playwright test tests/harness.spec.mjs`
（⚠️ **本仓没有 `tests/block-registry.spec.mjs`** —— 浏览器内单测的唯一入口是 `tests/harness.spec.mjs`，它加载 `/src/tests/index.html` 跑全量。`test-block-registry.js` 就是其中一个文件。）
Expected: FAIL，消息含 `sand_step 必须在 blocks-data.js 里声明`。

- [ ] **Step 3: 声明两个方块**

`src/voxel/blocks-data.js`，紧跟 `{"name":"sand", ...}` 之后：

```js
  // 巨型金字塔（Giant Pyramid Epic）：沙子系台阶/半砖。
  // 几何复用既有模板（planks_step L 形 / half_block 半高），**零新增几何**。
  // ⚠️ 必须显式 `opaque:false`：cutout 通道的默认推导已是 0，但 AGENTS.md 要求非 box 几何显式声明
  // （否则将来有人把 cullMode 改成 opaque 就会静默误推 opaqueTable=1 → mesher 剔掉邻居面 → 塔身出现洞）。
  {"name":"sand_step","solid":true,"cullMode":"cutout","opaque":false,"orientationModes":4,"geometry":"planks_step"},
  {"name":"sand_slab","solid":true,"cullMode":"cutout","opaque":false,"orientationModes":0,"geometry":"half_block"},
```

⚠️ **`opaque` 字段名必须确认**：`block-registry.js` 的 `register()` 读的是 `def.opaque ?? (def.cullMode === 'opaque')`，而 `blocks-data.js` 里其它方块从未显式写过 `opaque`（都是靠 `cullMode` 推导）。**Step 1 的断言 `def.opaque === false` 就是在锁这个字段名与类型**。若实测发现字段名叫别的（例如 `translucent`），以 `block-registry.js` 的实际读取为准。

⚠️ **`orientationModes: 0` 对 `sand_slab` 是严格的吗？** 既有 `bed_head`/`bed_tail` 用 `half_block` 几何 + `orientationModes: 4`（床要转向）。半砖方块不需要转向（下半始终在下），所以 `0` 是对的。但 **`sand_slab` 只有 1 格**（塔尖），像素级差异不可见 —— 若你想减少一个自由度，写 `0` 即可。

`src/voxel/faces-data.js`，紧跟 `sand:` 之后（六面数组，面序 `0:+X 1:-X 2:+Y 3:-Y 4:+Z 5:-Z`）：

```js
  sand_step: ['sand_side', 'sand_side', 'sand', 'sand', 'sand_side', 'sand_side'],
  sand_slab: ['sand_side', 'sand_side', 'sand', 'sand', 'sand_side', 'sand_side'],
```

- [ ] **Step 4: 跑测试确认 PASS**

Run: 同 Step 2 的命令
Expected: 该用例 PASS。

- [ ] **Step 5: 跑架构门与数据门（方块数变化会影响关系式）**

Run: `npm run check:arch && npm run check:data`
Expected: 两个都 exit 0。

⚠️ `check:data` 的 `[物品集合]` 会打印新计数（两个新方块进背包）。若报 `[图标 manifest] 缺项`，那是**预期**的 —— Task 10 会重跑 `npm run icons`。

⚠️ **`[形状权威]` 可能会报一项**：它要求 `solid=false` 的背包方块必须在 `FLAT_BLOCKS` 里；新方块 `solid=true`，所以不触发。但它同时检查 `geometry` 有 `TEMPLATES` 条目 —— `planks_step` / `half_block` 都存在，所以也过。若真报错，把消息原文贴出来再判断，不要随手加 `FLAT_BLOCKS`（那是给「多方块结构的占位物品」用的，台阶/半砖是真实方块）。

---

### Task 5: 落点候选模块 `giant-pyramid.js`

**Files:**
- Create: `src/gen/structures/giant-pyramid.js`
- Test: `src/tests/test-giant-pyramid.js`（本任务只写前半：判据 + 去重 + 不变量；密度关系式在 Task 8 的量测之后填）
- Modify: `src/gen/structures/mesa.js`（抽出 `regionLandmarkCenters`）
- Modify: `src/gen/structures/city-layout.js`（`getCityBoundsForSeed`）

**Interfaces:**
- Consumes:
  - `getBiome(wx, wz, seed)`、`seededRandom(x, z, salt)`（`src/gen/noise.js`）
  - `generateHeight(wx, wz, seed)`（`src/gen/terrain.js`）
  - `getPyramidCenterInRegion` / `getFrozenMountainCenterInRegion` / `getPlainLandCenterInRegion` / `isPlainLandValid` / `getIslandCenterInRegion` / `isIslandValid`（`landmarks.js`，**签名见 mesa.js 现有调用**）
  - `computeSkyCandidates(regionX, regionZ, seed)`（`sky-structures.js`）
  - `computeRegionLocalAnchor(regionX, regionZ, seed)`（`mesa.js`）
  - `getCityBoundsForSeed(seed)`（本任务在 `city-layout.js` 新增）
  - `REGION_SIZE`、`PYRAMID_SIZE`、`FROZEN_MOUNTAIN_SIZE`、`SNOW_LAND_SIZE`、`ISLAND_SIZE`、`PLAIN_LAND_SIZE`、`TRANSITION_SIZE`、`LANDMARK_OFFSET`（`region-config.js`）
  - `SEA_Y`（`voxel/constants.js`）
- Produces:
  - `PYRAMID_HALF = 24`、`PYRAMID_INSET = 25`、`PYRAMID_HEIGHT = 24`、`PYRAMID_MAX_SURFACE_SPAN = 4`、`PYRAMID_MIN_SPACING = 384`、`PYRAMID_CHANCE = 0.53`、`PYRAMID_SALT_ORDER = 960`、`PYRAMID_SALT_GATE = 961`
  - `computeGiantPyramidAnchor(regionX, regionZ, seed) → {wx, wz, floorY} | null`
  - `computeRegionLocalGiantPyramid(regionX, regionZ, seed) → {wx, wz, floorY} | null`
  - `inGiantPyramidFootprint(wx, wz, anchors) → boolean`（`anchors` = 邻域 layouts 的锚点数组，`null` 项自动跳过）
  - `clearGiantPyramidCache()`（单测隔离用）

- [ ] **Step 1: 写失败测试（判据部分）**

创建 `src/tests/test-giant-pyramid.js`：

```js
// src/tests/test-giant-pyramid.js — 巨型金字塔 Tier 1：落点判据 / 去重 / 不变量
//
// 钉的是「判据被改坏后静默产出一个看起来正常的错误金字塔」这几类缺陷：
//   · 占地跨 biome / 跨海 → 一半坐在草地或海底
//   · 占地内地表高差 > 4 → 一侧悬空（塔基 49×49 满铺只能保证「不整体浮空」）
//   · 锚点太靠 region 边界 → 相邻 region 不会为它生成锚点 ⇒ 半边永久消失
//   · 落地进城市 → 城市地面已被 generateCity 整形，塔基悬空/埋死
//   · 两座挨太近 → 巨型金字塔互相穿插
//
// ⚠️ 断言下界都取自实测（seed 12345，见 spec §2），不是拍脑袋。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse } from './assert.js';
import {
  computeGiantPyramidAnchor, computeRegionLocalGiantPyramid, clearGiantPyramidCache,
  PYRAMID_HALF, PYRAMID_INSET, PYRAMID_HEIGHT, PYRAMID_MAX_SURFACE_SPAN, PYRAMID_MIN_SPACING,
  PYRAMID_SALT_ORDER, PYRAMID_SALT_GATE,
} from '../gen/structures/giant-pyramid.js';
import { getBiome } from '../gen/noise.js';
import { generateHeight } from '../gen/terrain.js';
import { SEA_Y } from '../voxel/constants.js';

const SEED = 12345;

test('巨型金字塔落点：同一 seed 同一 region 两次调用逐字段相同（红线 2 确定性）', () => {
  for (const [rx, rz] of [[0, 1], [1, -1], [-2, -2]]) {
    const a = computeGiantPyramidAnchor(rx, rz, SEED);
    const b = computeGiantPyramidAnchor(rx, rz, SEED);
    if (a === null) { assertEqual(b, null, `region(${rx},${rz}) 两次都 null`); continue; }
    assertEqual(a.wx, b.wx); assertEqual(a.wz, b.wz); assertEqual(a.floorY, b.floorY);
  }
});

test('巨型金字塔落点：占地 49×49 每列都是 DESERT（不跨 biome）', () => {
  let checked = 0;
  for (let rx = -2; rx <= 2; rx++) for (let rz = -2; rz <= 2; rz++) {
    const a = computeGiantPyramidAnchor(rx, rz, SEED);
    if (!a) continue;
    checked++;
    for (let dz = -PYRAMID_HALF; dz <= PYRAMID_HALF; dz++) for (let dx = -PYRAMID_HALF; dx <= PYRAMID_HALF; dx++) {
      const b = getBiome(a.wx + dx, a.wz + dz, SEED);
      if (b !== 'DESERT') assertEqual(b, 'DESERT', `region(${rx},${rz}) 占地 (${dx},${dz}) 实际 ${b}`);
    }
  }
  assertTrue(checked >= 8, `至少 8 个 region 有锚点（实测更多，实际 ${checked}）`);
});

test('巨型金字塔落点：占地每列地表高于海平面（不跨海）', () => {
  for (let rx = -2; rx <= 2; rx++) for (let rz = -2; rz <= 2; rz++) {
    const a = computeGiantPyramidAnchor(rx, rz, SEED);
    if (!a) continue;
    for (let dz = -PYRAMID_HALF; dz <= PYRAMID_HALF; dz++) for (let dx = -PYRAMID_HALF; dx <= PYRAMID_HALF; dx++) {
      const h = generateHeight(a.wx + dx, a.wz + dz, SEED);
      if (h <= SEA_Y) assertTrue(false, `region(${rx},${rz}) 占地 (${dx},${dz}) h=${h} 必须 > SEA_Y=${SEA_Y}`);
    }
  }
});

test('巨型金字塔落点：floorY === 占地各列 generateHeight 的最小值（取 min 保证绝不悬空）', () => {
  for (let rx = -2; rx <= 2; rx++) for (let rz = -2; rz <= 2; rz++) {
    const a = computeGiantPyramidAnchor(rx, rz, SEED);
    if (!a) continue;
    let mn = Infinity;
    for (let dz = -PYRAMID_HALF; dz <= PYRAMID_HALF; dz++) for (let dx = -PYRAMID_HALF; dx <= PYRAMID_HALF; dx++) {
      mn = Math.min(mn, generateHeight(a.wx + dx, a.wz + dz, SEED));
    }
    assertEqual(a.floorY, mn, `region(${rx},${rz}) floorY 必须是占地最低地表`);
  }
});

test('巨型金字塔落点：占地内地表高差 ≤ PYRAMID_MAX_SURFACE_SPAN', () => {
  for (let rx = -2; rx <= 2; rx++) for (let rz = -2; rz <= 2; rz++) {
    const a = computeGiantPyramidAnchor(rx, rz, SEED);
    if (!a) continue;
    let mn = Infinity, mx = -Infinity;
    for (let dz = -PYRAMID_HALF; dz <= PYRAMID_HALF; dz++) for (let dx = -PYRAMID_HALF; dx <= PYRAMID_HALF; dx++) {
      const h = generateHeight(a.wx + dx, a.wz + dz, SEED);
      mn = Math.min(mn, h); mx = Math.max(mx, h);
    }
    assertTrue(mx - mn <= PYRAMID_MAX_SURFACE_SPAN,
      `region(${rx},${rz}) 高差 ${mx - mn} 必须 ≤ ${PYRAMID_MAX_SURFACE_SPAN}`);
  }
});

test('巨型金字塔落点：整个占地落在本 region 内（不跨 region 边界）', () => {
  for (let rx = -2; rx <= 2; rx++) for (let rz = -2; rz <= 2; rz++) {
    const a = computeGiantPyramidAnchor(rx, rz, SEED);
    if (!a) continue;
    assertTrue(a.wx - PYRAMID_HALF >= rx * 400 && a.wx + PYRAMID_HALF < (rx + 1) * 400,
      `region(${rx},${rz}) x 占地 [${a.wx - PYRAMID_HALF},${a.wx + PYRAMID_HALF}] 越界`);
    assertTrue(a.wz - PYRAMID_HALF >= rz * 400 && a.wz + PYRAMID_HALF < (rz + 1) * 400,
      `region(${rx},${rz}) z 占地 [${a.wz - PYRAMID_HALF},${a.wz + PYRAMID_HALF}] 越界`);
  }
});

test('巨型金字塔落点：任意两座切比雪夫距 ≥ PYRAMID_MIN_SPACING（一块沙漠一座）', () => {
  const list = [];
  for (let rx = -6; rx <= 6; rx++) for (let rz = -6; rz <= 6; rz++) {
    const a = computeGiantPyramidAnchor(rx, rz, SEED);
    if (a) list.push(a);
  }
  assertTrue(list.length >= 10, `±6 范围内应有足够样本（实测更多，实际 ${list.length}）`);
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const d = Math.max(Math.abs(list[i].wx - list[j].wx), Math.abs(list[i].wz - list[j].wz));
    assertTrue(d >= PYRAMID_MIN_SPACING, `两个锚点相隔 ${d} < ${PYRAMID_MIN_SPACING}`);
  }
});

test('巨型金字塔落点：无合法落点时返回 null（不硬塞）', () => {
  let nullCount = 0;
  for (let rx = -6; rx <= 6; rx++) for (let rz = -6; rz <= 6; rz++) {
    if (computeGiantPyramidAnchor(rx, rz, SEED) === null) nullCount++;
  }
  assertTrue(nullCount > 0, `±6 范围内应存在无合法落点的 region（实际 ${nullCount}）`);
  assertTrue(nullCount < 169, `也不能全部为 null（实际 ${nullCount}/169）`);
});

test('巨型金字塔落点：锚点不在任何城市 bounds 内（5 seed）', async () => {
  const { getCityBoundsForSeed } = await import('../gen/structures/city-layout.js');
  for (const seed of [12345, 424242, 777, 20260819, 999983]) {
    clearGiantPyramidCache();
    const city = getCityBoundsForSeed(seed);
    for (let rx = -2; rx <= 2; rx++) for (let rz = -2; rz <= 2; rz++) {
      const a = computeGiantPyramidAnchor(rx, rz, seed);
      if (!a) continue;
      const inside = a.wx >= city.minX && a.wx <= city.maxX && a.wz >= city.minZ && a.wz <= city.maxZ;
      assertFalse(inside, `seed=${seed} region(${rx},${rz}) 锚点 (${a.wx},${a.wz}) 落在城市 bounds 内`);
    }
  }
});

test('巨型金字塔落点：与同 region 的高台占地不相交（实测：局部候选有 32/151 重叠 → 排除必需）', async () => {
  const { computeRegionLocalAnchor, MESA_UNION_HALF } = await import('../gen/structures/mesa.js');
  // ⚠️ 先用**未排除**的局部候选证实「排除确实有必要」：实测 seed 12345 ±6 region 下
  // 同时有局部金字塔与局部高台的 151 个 region 中，**32 个占地重叠**（21%）。
  // 这条对赌是载荷性的：若哪天局部候选不再重叠，下面的主断言就失去判别力。
  let both = 0, rawOverlap = 0;
  for (let rx = -6; rx <= 6; rx++) for (let rz = -6; rz <= 6; rz++) {
    const p = computeRegionLocalGiantPyramid(rx, rz, SEED);
    const m = computeRegionLocalAnchor(rx, rz, SEED);
    if (!p || !m) continue;
    both++;
    if (Math.abs(p.wx - m.wx) <= PYRAMID_HALF + MESA_UNION_HALF &&
        Math.abs(p.wz - m.wz) <= PYRAMID_HALF + MESA_UNION_HALF) rawOverlap++;
  }
  assertTrue(both > 50, `应有足够的“两者都有”样本（实测 151，实际 ${both}）`);
  assertTrue(rawOverlap > 0, `局部候选应该有重叠样本（实测 32）—— 否则本用例失去判别力`);

  // 主断言：**最终**锚点（已过排除）与高台必不相交
  let checked = 0;
  for (let rx = -6; rx <= 6; rx++) for (let rz = -6; rz <= 6; rz++) {
    const a = computeGiantPyramidAnchor(rx, rz, SEED);
    if (!a) continue;
    const mesa = computeRegionLocalAnchor(rx, rz, SEED);
    if (!mesa) continue;
    checked++;
    const overlap = Math.abs(a.wx - mesa.wx) <= PYRAMID_HALF + MESA_UNION_HALF &&
                    Math.abs(a.wz - mesa.wz) <= PYRAMID_HALF + MESA_UNION_HALF;
    assertFalse(overlap, `region(${rx},${rz}) 金字塔 (${a.wx},${a.wz}) 与高台 (${mesa.wx},${mesa.wz}) 占地相交`);
  }
  assertTrue(checked >= 50, `应为 ≥50 个“两者都有”的 region 做最终断言（实际 ${checked}）`);
});

test('巨型金字塔常量：高度必须落在云层与空岛之下（改常量即红）', async () => {
  const { CLOUD_CLUSTER_Y } = await import('../gen/structures/sky-structures.js');
  // 沙漠地表实测 max = 9（spec §2，±1200 采样）—— 这里现场重扫一遍，不写字面量
  let maxH = -Infinity;
  for (let wz = -1200; wz <= 1200; wz += 40) for (let wx = -1200; wx <= 1200; wx += 40) {
    if (getBiome(wx, wz, SEED) !== 'DESERT') continue;
    maxH = Math.max(maxH, generateHeight(wx, wz, SEED));
  }
  assertTrue(maxH > 0, `沙漠地表 max=${maxH} 应大于 0（否则本用例恒真）`);
  assertTrue(maxH + PYRAMID_HEIGHT < CLOUD_CLUSTER_Y,
    `塔顶 ${maxH + PYRAMID_HEIGHT} 必须低于云簇高度 ${CLOUD_CLUSTER_Y}（否则塔顶穿云）`);
  assertTrue(maxH + PYRAMID_HEIGHT < 40, `塔顶 ${maxH + PYRAMID_HEIGHT} 必须低于空岛底 y=40`);
});

test('巨型金字塔 salt：落在空闲带且不与既有 salt 冲突（程序化校验）', () => {
  for (const s of [PYRAMID_SALT_ORDER, PYRAMID_SALT_GATE]) {
    assertTrue(s >= 952 && s <= 999, `salt ${s} 在空闲带`);
    for (const used of [941, 950, 951, 956]) assertFalse(s === used, `salt ${s} 不与既有 ${used} 冲突`);
  }
  assertFalse(PYRAMID_SALT_ORDER === PYRAMID_SALT_GATE, '排序与门必须用两个不同 salt（否则相关）');
});

test('巨型金字塔常量：region 内缩量足以容纳占地（改常量即红）', () => {
  // 内缩的语义：锚点必须离 region 边界 ≥ INSET，才能让半宽 HALF 的占地完整落在本 region 内。
  assertEqual(PYRAMID_INSET, PYRAMID_HALF + 1, 'PYRAMID_INSET = PYRAMID_HALF + 1（留 1 格余量）');
  assertTrue(PYRAMID_INSET >= PYRAMID_HALF, '内缩不得小于半宽（否则占地会越界）');
});

test('巨型金字塔常量：与高台的最近可能间距大于两者占地半径之和（相邻 region 不冲突）', () => {
  // 推导（spec DR-7）：
  //   金字塔中心 ∈ [base + PYRAMID_INSET, base + REGION_SIZE - PYRAMID_INSET]
  //   高台中心   ∈ [base + MESA_INSET,   base + REGION_SIZE - MESA_INSET]
  //   相邻 region（base' = base + REGION_SIZE）时，两边最近可能距离
  //     = (base' + MESA_INSET) - (base + REGION_SIZE - PYRAMID_INSET)
  //     = MESA_INSET + PYRAMID_INSET
  //   ⇒ 不冲突条件 = PYRAMID_INSET + MESA_INSET > PYRAMID_HALF + MESA_UNION_HALF
  const REGION_SIZE = 400;
  const MESA_INSET = 13;        // mesa.js: REGION_INSET = MESA_UNION_HALF + 2
  const MESA_UNION_HALF = 11;   // mesa.js: MESA_UNION_HALF
  const minAdjacentGap = MESA_INSET + PYRAMID_INSET;    // 实测 13 + 25 = 38
  const needed = PYRAMID_HALF + MESA_UNION_HALF;        // 实测 24 + 11 = 35
  assertTrue(minAdjacentGap > needed,
    `相邻 region 的最小可能间距 ${minAdjacentGap} 必须 > 两者占地半径之和 ${needed}（实测 38 > 35）`);
  // 同时验证占据不越界（两侧都不越）
  assertTrue(PYRAMID_INSET + PYRAMID_HALF < REGION_SIZE / 2, '占地不超过半个 region');
});
```

✅ **上面两条已按 spec DR-7 的推导写成直接不等式**（`PYRAMID_INSET + MESA_INSET > PYRAMID_HALF + MESA_UNION_HALF`，实测 38 > 35）—— 执行时不需要再“按实测重写”，照抄即可。若你的实现把 `PYRAMID_HALF` / `PYRAMID_INSET` 改了，这两条会立即红，正是想要的。

⚠️ **有一条重要的关联必须一起改**：`MESA_INSET` 与 `MESA_UNION_HALF` 是 `mesa.js` 里的常量，上面的用例把它们**写成字面量**了。这违反红线 1（第二份权威）。**更好的写法**：从 `mesa.js` import `MESA_UNION_HALF`（它已导出），`MESA_INSET` 未导出则用 `MESA_UNION_HALF + 2` 当场算；并在用例注释里写明「与 mesa.js 的 REGION_INSET 定义同源」。**不要**为了少写一个 import 而留下第二份字面量。

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `npx playwright test tests/harness.spec.mjs`（跑全量浏览器单测；也可以起服务后打开 `/src/tests/index.html` 看 report）
Expected: FAIL，`Cannot find module '../gen/structures/giant-pyramid.js'`

- [ ] **Step 3: 抽出 `regionLandmarkCenters`（改 `mesa.js`）**

把 `mesa.js` 现有的 `landmarkCircles(regionX, regionZ, seed)` 拆成两部分：

- **导出的** `regionLandmarkCenters(regionX, regionZ, seed)` → 金字塔/冰封山/海岛/平地四项，**与本文件同文件**（不需要新文件，见下）
- **非导出的** `landmarkCircles()` = `regionLandmarkCenters()` + 雪原那一项（雪原只在 mesa 用，且它的中心没有导出函数 —— 本次不扩范围）

改造要点：

```js
/**
 * 本 region 的地标圆（半径 = 核心 + 过渡带）。
 * 抽出来的理由：巨型金字塔的候选层要用**同一批地标圆**做排除。
 * 不抽出来就会有第三份副本（现有注释已经写着「没有 getSnowLandCenterInRegion 导出，
 * 这里复现那两行」—— 那就是第二份）。
 * ⚠️ 雪原**刻意不在这里**：它只在 mesa 的让路判据里用，且金字塔不需要它。
 * @returns {Array<{cx:number, cz:number, r:number}>}
 */
export function regionLandmarkCenters(regionX, regionZ, seed) { /* 原 landmarkCircles 的前四项 */ }

function landmarkCircles(regionX, regionZ, seed) {
  const circles = regionLandmarkCenters(regionX, regionZ, seed);
  const raw = getRegionSeededCenter(regionX, regionZ, seed);
  circles.push({ cx: raw.centerX + LANDMARK_OFFSET.SNOW_LAND_X,
    cz: raw.centerZ + LANDMARK_OFFSET.SNOW_LAND_Z, r: SNOW_LAND_SIZE / 2 + TRANSITION_SIZE.SNOW_LAND });
  return circles;
}
```

⚠️ **`regionLandmarkCenters` 必须返回新数组**（每次调）——`landmarkCircles` 会往它里面 push 雪原项。原实现每次也新建数组，保持这个行为：**不要改成模块级缓存数组**（那会让第一次调用后雪原项被永久污染）。

**回归门**：`src/tests/test-mesa.js` / `test-mesa-gen.js` 逐用例不动，`npm run check` 与 `npx playwright test tests/harness.spec.mjs tests/mesa.spec.mjs` 全绿。

✅ **已验证没有循环依赖**：`mesa.js` 只被 `structure-layout.js` 与 `apply.js` import（实测 grep），且 `mesa.js` 自己只 import `sky-structures.js` / `landmarks.js` / `region-config.js` / `region-center.js`。所以：

- `giant-pyramid.js` **可以单向 import** `mesa.js` 的 `computeRegionLocalAnchor()`（用于高台排除）与 `regionLandmarkCenters()` —— **不会成环**；
- 不需要 `await import()`、不需要「把高台排除推到 apply 层」、不需要第三个文件。

⚠️ 但**绝不要**让 `mesa.js` import `giant-pyramid.js`（那才会成环）。金字塔只能单向依赖 mesa。

- [ ] **Step 4: 实现 `getCityBoundsForSeed`（改 `city-layout.js`）**

```js
/**
 * 城市 bounds 的派生只读快照（巨型金字塔候选层排除城市用）。
 *
 * 为什么要这一个函数：城市 bounds 实测（seed 12345）为 x∈[0,566] × z∈[-166,400]，
 * **横跨 4 个 region**，而 `city` 布局只存在于 region [0,0] 的 layout 里 —— 其余 region 的
 * 候选层拿不到它。实测城市面积里 **20.7% 是 DESERT**，且存在 504 个「49×49 全沙漠」的城内落点
 * （不是理论风险）。候选层若只判「自己的 layout 有没有 city」，那三个 region 的锚点会落在城内。
 *
 * 为什么不能猜一个保守常量：实测 bounds 半宽 **283** 已远超 CITY_SIZE_MAX/2 = 112
 * （expandBoundsIfNeeded 有不受 CITY_SIZE_MAX 钳制的增长路径），猜常量必定错。
 *
 * ⚠️ 只缓存**派生出的 bounds 快照**（Object.freeze），不缓存 layout 本身 ——
 * 后者是可变对象（computeRegionLayout 会 spread/改写），缓存它会改变别名语义。
 * ⚠️ buildCityLayout 实测 10~12ms：必须由每个 Worker 在 `layout` 入口预热（world-worker.js），
 * 不能落进 GEN 计时路径。
 */
let _cityBoundsCache = null; // { seed, bounds }

export function getCityBoundsForSeed(seed) {
  if (_cityBoundsCache && _cityBoundsCache.seed === seed) return _cityBoundsCache.bounds;
  const city = buildCityLayout(seed);
  const bounds = Object.freeze({ minX: city.minX, maxX: city.maxX, minZ: city.minZ, maxZ: city.maxZ });
  _cityBoundsCache = { seed, bounds };
  return bounds;
}
```

- [ ] **Step 5: 实现 `src/gen/structures/giant-pyramid.js`**

按 spec DR-1~DR-7 实现。结构与 `mesa.js` 一一对应（可直接对照着写）：

- 常量（`PYRAMID_*` 8 个，全在本文件顶部，**不进 `region-config.js`**）
- `LANDMARK_CLEARANCE`（各项半径 = 尺寸/2 + 过渡带；**从 `regionLandmarkCenters` 拿圆的半径**，不要在金字塔这边再写一份半径表 —— 那是第二份权威。若 `regionLandmarkCenters` 返回的圆已带 `r`，直接用）
- `_localCache`（Map，LRU 512，键 `${seed}:${rx},${rz}`）+ `cachedLocalAnchor`
- `computeRegionLocalGiantPyramid(regionX, regionZ, seed)`：
  1. 扫描窗内（内缩 `PYRAMID_INSET`）每 `SCAN_STEP = 12` 取一个点，`getBiome === 'DESERT'` 才收；
  2. 按 `seededRandom(x, z, seed + PYRAMID_SALT_ORDER)` 升序排（tie 用坐标字典序）；
  3. 逐点做占地全检（4 条判据 + 城市 + 地标 + 空岛 AABB，`SCAN_STEP` 步长 2 采样占地）；
  4. 首个通过即返回 `{wx, wz, floorY}`
- `computeGiantPyramidAnchor(regionX, regionZ, seed)`：
  1. 取 `own = cachedLocalAnchor(...)`，null 直接返回；
  2. **邻域去重**（`NEIGHBOR_RINGS = ceil(PYRAMID_MIN_SPACING / 400) + 1 = 2`，**只查字典序更小的 region**，先按 region 矩形最近距离剪枝）；
  3. **概率门**（`seededRandom(own.wx, own.wz, seed + PYRAMID_SALT_GATE) < PYRAMID_CHANCE` 才返回，否则 null）。

  ⚠️⚠️ **概率门位置是载荷性的**：必须放在**去重之后**，而且**去重时必须比较未过门的邻居**。
  若把门放在去重之前（或去重时只比已过门的邻居），会让「本该让位的邻居因为自己被门掉而不参与比较」
  → 两个锚点可能贴在一起（实测口径：门后的锚点必须仍满足间距，否则间距门失效）。
  实现上：`cachedLocalAnchor` 存**未过门**的局部锚点（供去重），门只作用在返回值上。
  这条必须写进代码注释，并有对应单测（Task 8 的密度用例隐含覆盖；间距用例是直接现场）。
- `inGiantPyramidFootprint(wx, wz, anchors)`：任一锚点的 49×49 方形命中即 true（`|dx| <= PYRAMID_HALF && |dz| <= PYRAMID_HALF`）
- `clearGiantPyramidCache()`

- [ ] **Step 6: 跑测试确认 PASS**

Run: 同 Step 2
Expected: 全部 PASS（包括 Step 1 里那两条几何不变量用例 —— 它们已按 spec DR-7 的推导写成直接不等式，不需要再“按实测重写”）。

---

### Task 6: 接线（layout 字段 + Worker 预热 + `pointContext` 分支）

**Files:**
- Modify: `src/gen/structures/structure-layout.js`
- Modify: `src/workers/world-worker.js`
- Modify: `src/gen/structures/apply.js`（只加 `pointContext` 分支）

**Interfaces:**
- Consumes: `computeGiantPyramidAnchor`（Task 5）。
- Produces: `computeRegionLayout(...)` 返回值新增 `giantPyramid: {wx, wz, floorY} | null`；`pointContext()` 对金字塔占地返回 `{kind: 'none'}`。

- [ ] **Step 1: 写失败测试**

追加到 `src/tests/test-giant-pyramid.js`：

```js
test('巨型金字塔接线：computeRegionLayout 的 giantPyramid 字段与直接调用一致', async () => {
  const { computeRegionLayout } = await import('../gen/structures/structure-layout.js');
  for (const [rx, rz] of [[0, 1], [1, -1], [-2, -2], [3, 3]]) {
    const layout = computeRegionLayout(rx, rz, SEED);
    const direct = computeGiantPyramidAnchor(rx, rz, SEED);
    if (direct === null) { assertEqual(layout.giantPyramid, null, `region(${rx},${rz})`); continue; }
    assertEqual(layout.giantPyramid.wx, direct.wx, `region(${rx},${rz}) wx`);
    assertEqual(layout.giantPyramid.wz, direct.wz, `region(${rx},${rz}) wz`);
    assertEqual(layout.giantPyramid.floorY, direct.floorY, `region(${rx},${rz}) floorY`);
  }
});

test('巨型金字塔接线：pointContext 在锚点占地内返回 kind=none（抑制植被/巨树/高台）', async () => {
  const { computeRegionLayout } = await import('../gen/structures/structure-layout.js');
  const { giantAllowedAtFor } = await import('../gen/structures/apply.js');
  // 找一个有锚点的 region
  let layout = null;
  for (let rx = -2; rx <= 2 && !layout; rx++) for (let rz = -2; rz <= 2 && !layout; rz++) {
    const l = computeRegionLayout(rx, rz, SEED);
    if (l.giantPyramid) layout = l;
  }
  assertTrue(layout !== null, '必须找到有锚点的 region（否则本用例恒真）');
  const allowed = giantAllowedAtFor([layout], layout.city, SEED);
  assertFalse(allowed(layout.giantPyramid.wx, layout.giantPyramid.wz), '锚点正上方不得长巨树');
  assertFalse(allowed(layout.giantPyramid.wx + 20, layout.giantPyramid.wz + 20), '占地内不得长巨树');
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

Expected: `layout.giantPyramid` 为 `undefined` → 断言失败。

- [ ] **Step 3: 接线 `structure-layout.js`**

```js
import { computeGiantPyramidAnchor } from './giant-pyramid.js';
// ...
  // 巨型金字塔（Giant Pyramid Epic）：region 级候选，与高台同构。
  // 城市/地标/空岛的排除在候选层（拿得到 getCityBoundsForSeed）；高台的排除也在候选层
  // （实测确认 mesa.js 只被 structure-layout / apply import，且它不反向 import 本模块 ——
  //  单向依赖，不成环）。
  const giantPyramid = computeGiantPyramidAnchor(regionX, regionZ, seed);
// ...
  return { regionX, regionZ, pyramidRaw, pyramid, frozenMountain, snowLand, plainLand,
    island, city, sky, scatter, giantTrees, mesa, giantPyramid };
```

同时更新函数头部的 JSDoc `@returns` 形状。

- [ ] **Step 4: 接线 `apply.js` 的 `pointContext`**

在 `pointContext()` 的 `for (const layout of layouts)` 循环**之前**加：

```js
  // 巨型金字塔占地内：让路给塔（kind='none' 一次性覆盖 5 个下游消费者 —— 城市树 / 普通树 /
  // 巨树 covers / 单格植物 / 高台的 kind !== 'normal' 判据。**不要为每一处各写一份判据**）。
  for (const layout of layouts) {
    const gp = layout.giantPyramid;
    if (!gp) continue;
    if (Math.abs(wx - gp.wx) <= PYRAMID_HALF && Math.abs(wz - gp.wz) <= PYRAMID_HALF) {
      return { kind: 'none' };
    }
  }
```

（需要 `import { PYRAMID_HALF } from './giant-pyramid.js'`。）

⚠️ **必须在 `cityInfo` 判断之后还是之前？** 看 `pointContext` 现有顺序：它先判 city，再遍历 layouts 判地标。金字塔占地**不可能**在城市内（候选层已排除），所以放 city 之后、layout 循环之前都是等价的。**放在 city 之后**（保持「城市优先级最高」的既有语义）。

- [ ] **Step 5: 接线 `world-worker.js` 的 Worker 预热**

在 `layout(p)` handler 里、`await giantPreloadPromise` 之后加一行：

```js
    // 预热城市 bounds 缓存：buildCityLayout 实测 10~12ms，绝不能落进首个 GEN 的计时路径
    // （structure-gen fixture 的 genP95 门是 10ms）。layout 入口是唯一保证先于 GEN 的位置。
    getCityBoundsForSeed(p.seed);
```

并在文件顶部 import：`import { getCityBoundsForSeed } from '../gen/structures/city-layout.js';`

- [ ] **Step 6: 跑测试确认 PASS**

Run: 同 Step 2
Expected: 两条新用例 PASS。

- [ ] **Step 7: 跑 `check:arch`（确认没有引入循环依赖或 three 依赖）**

Run: `npm run check:arch`
Expected: exit 0。

---

### Task 7: 光栅化 + 撒布剔除（`apply.js` 阶段 2.76）

**Files:**
- Modify: `src/gen/structures/structure-json.js`（`STRUCTURE_FILES` 加一行）
- Modify: `src/gen/structures/apply.js`（阶段 2.76 + 阶段 2.7 剔除）

**Interfaces:**
- Consumes: `PYRAMID_HALF` / `inGiantPyramidFootprint`（Task 5）、`rasterizeStructure`（既有）。
- Produces: 阶段 2.76 的世界方块；阶段 2.7 对落在金字塔占地内的撒布候选 `continue`。

- [ ] **Step 1: 写失败测试**

创建 `src/tests/test-giant-pyramid-gen.js`：

```js
// src/tests/test-giant-pyramid-gen.js — 巨型金字塔接线 Tier 1：真实 column GEN 逐格落位
//
// 钉的是「纯函数全绿但世界里什么都不长」这一类缺陷（M7 的教训）：
//   · STRUCTURE_FILES 漏映射 → rasterizeStructure 静默 return
//   · apply 阶段 2.76 漏了 / y 差一格 → 塔体被地形覆盖
//   · 预载漏了 → cache 未命中 → 同样静默
// 断言落点一律是**真实 applyStructuresToColumn 写出的方块数据**。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { computeRegionLayout, neighborRegionKeys } from '../gen/structures/structure-layout.js';
import { applyStructuresToColumn } from '../gen/structures/apply.js';
import { loadStructure } from '../gen/structures/structure-json.js';
import { buildDefaultRegistry } from '../voxel/block-registry.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { fillColumn } from '../gen/terrain.js';
import { carveCaves } from '../gen/caves.js';
import { blockIndex } from '../voxel/constants.js';
import { PYRAMID_HALF } from '../gen/structures/giant-pyramid.js';

const SEED = 12345;

/** 找一个确实有锚点的 region（不硬编码 region 坐标 —— 密度参数一改它就会变） */
function findRegionWithAnchor() {
  for (let rx = -3; rx <= 3; rx++) for (let rz = -3; rz <= 3; rz++) {
    const l = computeRegionLayout(rx, rz, SEED);
    if (l.giantPyramid) return l;
  }
  return null;
}

/** 与 Worker 真实路径一致的完整 GEN（fillColumn + caves + applyStructures，不含 edits/light） */
async function genColumn(reg, cx, cz, layouts) {
  const col = new ChunkColumn(cx, cz);
  fillColumn(col, SEED, reg);
  carveCaves(col, SEED);
  await applyStructuresToColumn(col, SEED, reg, layouts);
  return col;
}

function layoutsFor(cx, cz) {
  const out = [];
  for (const key of neighborRegionKeys(cx, cz)) {
    const [rx, rz] = key.split(',').map(Number);
    out.push(computeRegionLayout(rx, rz, SEED));
  }
  return out;
}

test('巨型金字塔 GEN：锚点 column 内出现 sand_step 与 sand（特征方块在位）', async () => {
  const layout = findRegionWithAnchor();
  assertTrue(layout !== null, '必须找到有锚点的 region');
  const a = layout.giantPyramid;
  const reg = await buildDefaultRegistry();
  const cx = Math.floor(a.wx / 16), cz = Math.floor(a.wz / 16);
  const col = await genColumn(reg, cx, cz, layoutsFor(cx, cz));

  const sandStepId = reg.idOf('sand_step');
  const sandId = reg.idOf('sand');
  let steps = 0, sands = 0;
  for (let i = 0; i < col.blocks.length; i++) {
    if (col.blocks[i] === sandStepId) steps++;
    else if (col.blocks[i] === sandId) sands++;
  }
  assertTrue(steps > 0, `锚点 column 必须有 sand_step（实际 ${steps}）`);
  assertTrue(sands > 500, `锚点 column 必须有大量 sand（实际 ${sands}）`);
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

Expected: `STRUCTURE_FILES` 没有 `giantPyramid` → `loadStructure` fetch 404 → 缓存空结构 → `steps === 0`。

- [ ] **Step 3: 加 `STRUCTURE_FILES` 映射**

`src/gen/structures/structure-json.js`：

```js
  // 巨型金字塔（Giant Pyramid Epic）：palette + 扁平数组格式（同 cloudlandMesaSmall）
  giantPyramid: 'giant_pyramid.json',
```

**不要**加进 `GROUND_SUPPORT_TYPES` —— 底层是满铺 49×49 实心，补支撑柱只会在沙漠里插 2401 根沙柱。

- [ ] **Step 4: 实现阶段 2.76 光栅化**

`src/gen/structures/apply.js`，在阶段 2.75（高台）之后、阶段 2.8（巨树）之前：

```js
  // ---- 阶段 2.76：巨型金字塔（Giant Pyramid Epic）----
  // 层序理由：撒布结构（2.7）与高台（2.75）都是地面级内容，先写；金字塔是 24 格高的大型结构，
  // 在其上（后写胜）；巨树（2.8）有 allowedAt 判据可避让，故金字塔先于巨树。
  //
  // 让路判据两块：① 候选层已排除城市/地标/空岛（拿得到 getCityBoundsForSeed）；
  // ② 高台与撒布结构的排除在**这里** —— 理由与城市同源（v1.74 的教训）：
  //    候选层若 import mesa 会形成循环依赖，而撒布候选要按 footprint 剔除也不该在候选层做。
  //    另：pointContext 已对锚点占地返回 kind='none'，故高台的 `kind !== 'normal'` 判据自动让路。
  for (const layout of layouts) {
    const anchor = layout.giantPyramid;
    if (!anchor) continue;
    // 高台让路：同一 region 的高台与金字塔可能相交（内缩量只保证相邻 region 不相交）
    if (layout.mesa &&
        Math.abs(anchor.wx - layout.mesa.wx) <= PYRAMID_HALF + MESA_UNION_HALF &&
        Math.abs(anchor.wz - layout.mesa.wz) <= PYRAMID_HALF + MESA_UNION_HALF) continue;
    // 城市让路（纵深防御：候选层已排除，但城市 bounds 可跨 region，这里再判一次零成本）
    if (cityLayout &&
        anchor.wx + PYRAMID_HALF >= cityLayout.minX && anchor.wx - PYRAMID_HALF <= cityLayout.maxX &&
        anchor.wz + PYRAMID_HALF >= cityLayout.minZ && anchor.wz - PYRAMID_HALF <= cityLayout.maxZ) continue;
    if (!placementIntersects({ x: anchor.wx, z: anchor.wz }, PYRAMID_HALF, PYRAMID_HALF, column.cx, column.cz)) continue;
    // 不补 groundSupport：底层是满铺 49×49 实心，补柱会在沙漠里插 2401 根沙柱
    rasterizeStructure('giantPyramid', anchor.wx, anchor.floorY + 1, anchor.wz,
      setBlock, column, registry, seed, false);
  }
```

⚠️ **`placementIntersects` 的 `INTERSECT_MARGIN = 2` 会让裁剪切比占地大 2 格** —— 那是安全的（多裁不丢方块），不要改它。

⚠️ **预载**：阶段 2 之前的 `needTypes` 收集里要加一条：

```js
  if (layouts.some((l) => l.giantPyramid)) needTypes.add('giantPyramid');
```

放在 `if (mesaAnchor) needTypes.add('cloudlandMesaSmall');` 旁边。

- [ ] **Step 5: 实现阶段 2.7 的撒布剔除**

在阶段 2.7 的候选循环里，紧跟「城市 bounds 剔除」那条之后加：

```js
      // 巨型金字塔占地内的撒布候选一律不落地（用户裁定：巨型金字塔不与任何撒布结构重合）。
      // 判据函数在 giant-pyramid.js（与 inCityBounds 同手法：唯一权威，不在此另写一份）。
      // 不剔除的后果：24 格高的小沙漠神殿会长在塔身内部（用户报告的那类「从外面看塔上多一块」）。
      if (inGiantPyramidFootprint(x, z, giantAnchors)) continue;
```

其中 `giantAnchors` 在阶段 2.7 循环之前算一次：

```js
  const giantAnchors = layouts.map((l) => l.giantPyramid).filter(Boolean);
```

- [ ] **Step 6: 跑测试确认 PASS**

Run: 同 Step 2
Expected: PASS。

- [ ] **Step 7: 追加落地质量用例（Review Focus 1 / 5 / 6）**

追加到 `src/tests/test-giant-pyramid-gen.js`：

```js
test('巨型金字塔 GEN：塔基各列下方 6 格内有实心（洞穴挖空 ≤1%，实测 0.104%）', async () => {
  const layout = findRegionWithAnchor();
  const a = layout.giantPyramid;
  const reg = await buildDefaultRegistry();
  // 塔基 49×49 跨多个 column，逐个生成
  const cols = new Map();
  for (let dz = 0; dz <= PYRAMID_HALF * 2; dz += 8) for (let dx = 0; dx <= PYRAMID_HALF * 2; dx += 8) {
    const wx = a.wx - PYRAMID_HALF + dx, wz = a.wz - PYRAMID_HALF + dz;
    cols.set(`${Math.floor(wx / 16)},${Math.floor(wz / 16)}`, true);
  }
  const built = new Map();
  for (const key of cols.keys()) {
    const [cx, cz] = key.split(',').map(Number);
    built.set(key, await genColumn(reg, cx, cz, layoutsFor(cx, cz)));
  }
  let checked = 0, voids = 0;
  for (let dz = -PYRAMID_HALF; dz <= PYRAMID_HALF; dz++) for (let dx = -PYRAMID_HALF; dx <= PYRAMID_HALF; dx++) {
    const wx = a.wx + dx, wz = a.wz + dz;
    const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
    const col = built.get(`${cx},${cz}`);
    if (!col) continue;
    checked++;
    let solid = false;
    for (let k = 1; k <= 6; k++) {
      const id = col.blocks[blockIndex(wx - cx * 16, a.floorY + 1 - k, wz - cz * 16)];
      if (id !== 0 && reg.solidTable[id] === 1) { solid = true; break; }
    }
    if (!solid) voids++;
  }
  assertTrue(checked > 2000, `应检查 ≥2000 列（实际 ${checked}）`);
  assertTrue(voids / checked <= 0.01,
    `塔基悬空列占比 ${(voids / checked * 100).toFixed(3)}% 必须 ≤ 1%（实测 0.104%，洞穴所致）`);
});

test('巨型金字塔 GEN：撒布结构不落在金字塔占地内（对照：占地外仍有撒布/植被）', async () => {
  // 找一对「有锚点」+「占地内有沙漠神殿候选」的 region；若找不到就退化成
  // 「占地内 sand_step 数 ≥ 1000 且占地内没有任何其它结构特征方块被写到塔身高度以上」。
  //
  // ⚠️ 不要用「占地内有没有 stone_bricks」做判据：desertPyramid 的 stone_bricks 与
  // 城市/其它结构的方块共享名字 → 会恒真。用**坐标**判据（候选点落在占地内且该点有沙石方块）。
  const layout = findRegionWithAnchor();
  const a = layout.giantPyramid;
  const reg = await buildDefaultRegistry();
  // 塔身内部（距锚点 ≤ 20 且 y 在 floorY+2..floorY+23）若出现非 sand/sand_step/sand_slab 的
  // **结构类**方块（bricks/planks/wool/cloth 等），说明撒布结构被埋进了塔里。
  const allowed = new Set(['sand', 'sand_step', 'sand_slab']);
  const cx = Math.floor(a.wx / 16), cz = Math.floor(a.wz / 16);
  const col = await genColumn(reg, cx, cz, layoutsFor(cx, cz));
  const suspicious = [];
  for (let ly = 0; ly < 128; ly++) {
    const y = ly - 32;
    if (y <= a.floorY || y > a.floorY + 24) continue;
    for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
      const wx = cx * 16 + lx, wz = cz * 16 + lz;
      if (Math.abs(wx - a.wx) > PYRAMID_HALF || Math.abs(wz - a.wz) > PYRAMID_HALF) continue;
      const id = col.blocks[blockIndex(lx, y, lz)];
      if (id === 0) continue;
      const name = reg.nameOf(id);
      if (allowed.has(name)) continue;
      // 地形/洞穴/其它结构…只关心「结构类」手工材料
      if (/brick|plank|wool|cloth|glass|wood|log/i.test(name)) suspicious.push(`${wx},${y},${wz}:${name}`);
    }
  }
  assertEqual(suspicious.length, 0,
    `塔身内不得出现结构类方块（实测前 5 个：${suspicious.slice(0, 5).join(' | ')}）`);
});
```

- [ ] **Step 8: 跑全部测试**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: `test-giant-pyramid.js` 与 `test-giant-pyramid-gen.js` 全部 PASS。

---

### Task 8: 密度标定（5 seed 实测 → 关系式断言）

**Files:**
- Modify: `src/tests/test-giant-pyramid.js`（追加密度用例）
- Modify: `src/gen/structures/giant-pyramid.js`（如需调 `PYRAMID_CHANCE`）

**Interfaces:**
- Consumes: `computeGiantPyramidAnchor`（Task 5）。
- Produces: 无新符号；`PYRAMID_CHANCE` 的最终值。

- [ ] **Step 1: 写密度测试（先用计划阶段实测的 0.53）**

追加到 `src/tests/test-giant-pyramid.js`：

```js
test('巨型金字塔密度：跨 8 seed 平均「每 2 块沙漠 1 座」（关系式，实测 0.504）', async () => {
  // 口径（勿改）：分母 = 世界沙漠连通块数（8 格粒度、8 连通、质心落在测量窗内），
  // 分子 = 测量窗内的最终锚点数。窗取 ±1600（3.2 km²，实测沙漠块 25~46 个/seed，样本足够）。
  // ⚠️ 为什么分母不能是 region 数：region 是 400×400 矩形网格，沙漠是不规则块 ——
  // 一个 region 可能只有 5% 是沙漠，也可能 90%。用 region 做分母会让密度随 seed 乱跳 3 倍。
  const { getBiome, seededRandom } = await import('../gen/noise.js');
  const WIN = 1600, G = 8;
  const SEEDS = [12345, 424242, 777, 20260819, 999983, 3, 42, 65535];
  let totalPyramids = 0, totalDeserts = 0;
  const perSeed = [];
  for (const seed of SEEDS) {
    clearGiantPyramidCache();
    let pyramids = 0;
    const nr = Math.ceil(WIN / 400);
    for (let rx = -nr; rx <= nr; rx++) for (let rz = -nr; rz <= nr; rz++) {
      const a = computeGiantPyramidAnchor(rx, rz, seed);
      if (!a) continue;
      if (Math.abs(a.wx) >= WIN || Math.abs(a.wz) >= WIN) continue;
      pyramids++;
    }
    // 沙漠连通块
    const N = Math.floor(2 * WIN / G) + 1;
    const map = new Uint8Array(N * N);
    for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) {
      const wx = -WIN + ix * G, wz = -WIN + iz * G;
      map[iz * N + ix] = (getBiome(wx, wz, seed) === 'DESERT' && generateHeight(wx, wz, seed) > SEA_Y) ? 1 : 0;
    }
    const seen = new Uint8Array(N * N);
    let comps = 0;
    for (let i = 0; i < N * N; i++) {
      if (!map[i] || seen[i]) continue;
      seen[i] = 1;
      const st = [i]; let n = 0, sx = 0, sz = 0;
      while (st.length) {
        const c = st.pop(); n++;
        const iz = Math.floor(c / N), ix = c - iz * N; sx += ix; sz += iz;
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          const nx = ix + dx, nz = iz + dz;
          if (nx < 0 || nx >= N || nz < 0 || nz >= N) continue;
          const j = nz * N + nx;
          if (map[j] && !seen[j]) { seen[j] = 1; st.push(j); }
        }
      }
      const ccx = -WIN + (sx / n) * G, ccz = -WIN + (sz / n) * G;
      if (Math.abs(ccx) < WIN && Math.abs(ccz) < WIN) comps++;
    }
    perSeed.push({ seed, pyramids, comps, ratio: pyramids / comps });
    totalPyramids += pyramids; totalDeserts += comps;
  }
  const ratio = totalPyramids / totalDeserts;
  assertTrue(ratio >= 0.45 && ratio <= 0.60,
    `跨 seed 平均密度 ${ratio.toFixed(3)} 必须落在 [0.45, 0.60]（目标 0.5 = 每 2 块沙漠 1 座）；各 seed：${perSeed.map((r) => `${r.seed}:${r.ratio.toFixed(2)}`).join(' ')}`);
  assertTrue(totalDeserts > 500, `分母样本量足够（实际 ${totalDeserts} 块沙漠）—— 否则本用例不可信`);
  // 单 seed 也不得离谱（防「平均对了但某个 seed 一个都没有」）
  for (const r of perSeed) {
    assertTrue(r.ratio >= 0.20 && r.ratio <= 0.80,
      `seed=${r.seed} 密度 ${r.ratio.toFixed(3)} 越界 [0.20, 0.80]`);
    assertTrue(r.pyramids > 0, `seed=${r.seed} 必须至少有一座（否则该世界沙漠全是空的）`);
  }
});

test('巨型金字塔间距：阈值必然大于沙漠连通块最大跨度（否则一块沙漠会出现两座）', () => {
  // 依据与高台同源（spec DR-2）：8 格粒度下沙漠连通块的最大 bbox 跨度 = 368 格（实测
  // seed 12345 ±1200），故阈值取 384（>368 上取整到 32 的倍数）。
  // 这里**现场重测**（不硬编码 368），且把“跨 seed 取最大”也一起测 —— 单个 seed 的 368
  // 可能不是全局上限。
  const WIN = 1200, G = 8;
  const N = Math.floor(2 * WIN / G) + 1;
  let globalMaxSpan = 0;
  for (const seed of [12345, 424242, 777, 20260819, 999983]) {
    const map = new Uint8Array(N * N);
    for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) {
      const wx = -WIN + ix * G, wz = -WIN + iz * G;
      map[iz * N + ix] = (getBiome(wx, wz, seed) === 'DESERT' && generateHeight(wx, wz, seed) > SEA_Y) ? 1 : 0;
    }
    const seen = new Uint8Array(N * N);
    for (let i = 0; i < N * N; i++) {
      if (!map[i] || seen[i]) continue;
      seen[i] = 1;
      const st = [i];
      let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
      while (st.length) {
        const c = st.pop();
        const iz = Math.floor(c / N), ix = c - iz * N;
        x0 = Math.min(x0, ix); x1 = Math.max(x1, ix);
        z0 = Math.min(z0, iz); z1 = Math.max(z1, iz);
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          const nx = ix + dx, nz = iz + dz;
          if (nx < 0 || nx >= N || nz < 0 || nz >= N) continue;
          const j = nz * N + nx;
          if (map[j] && !seen[j]) { seen[j] = 1; st.push(j); }
        }
      }
      globalMaxSpan = Math.max(globalMaxSpan, (x1 - x0 + 1) * G, (z1 - z0 + 1) * G);
    }
  }
  assertTrue(globalMaxSpan > 0, `必须扫到沙漠块（否则本用例恒真）`);
  assertTrue(globalMaxSpan < PYRAMID_MIN_SPACING,
    `跨 5 seed 的沙漠连通块最大跨度 ${globalMaxSpan} 必须 < PYRAMID_MIN_SPACING ${PYRAMID_MIN_SPACING}（实测 368 < 384）`);
});
```

- [ ] **Step 2: 跑测试**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: PASS（计划阶段用同样口径实测：`PYRAMID_CHANCE = 0.53` → 跨 8 seed 合计 **450/902 = 0.499**）。

若 FAIL：按实测值调 `PYRAMID_CHANCE`（升高→更密），**每次改完重跑**。`0.53` 附近的实测数据（8 seed 合计）：`0.55 → 0.497` / `0.54 → 0.508` / `0.53 → 0.499` / `0.52 → 0.487`。

⚠️ **不要改密度的口径（分母定义）来迁就数值** —— 那会让门禁失去意义。

---

### Task 9: 数据门（`check:data` 的 `[巨型金字塔]` 环节）

**Files:**
- Modify: `tools/check-data.mjs`（新增 `checkGiantPyramid()` + 主流程调用）
- Modify: `src/tests/index.html`（注册 2 个新测试文件）

**Interfaces:**
- Consumes: Task 2 的指纹模块 + Task 3 的产物。
- Produces: `check:data` 新增一行 ✓ 输出；违规时 `failures` 增加对应条目。

- [ ] **Step 1: 写门禁函数**

`tools/check-data.mjs`，照 `checkCloudlandMesa()` 的结构写 `async function checkGiantPyramid()`，钉住 spec §4.4 的 8 条：

1. 输入与产物存在（`.litematic` 入库缺失 = 仓库损坏）；
2. 指纹匹配（不匹配 → `跑 npm run pyramid`）；
3. `blocks.length / 4 === PYRAMID_METRICS.blocks`；
4. bbox = 49 × 24 × 49 且 `minY === 1`；
5. `y === 1` 的列数 === `PYRAMID_METRICS.baseCells`（2401，底层满铺）；
6. 台阶格数 `>= 1000`（守住「拒绝退化成全整格」，实测 1219）；
7. palette 全部注册 + `cullTable` 只允许 0/1（不许 transparent）+ **无砖无木**（`/brick/i`、`/log|wood|plank|oak|birch/i`）；
8. 成功行的条件必须涵盖**全部**失败判据（既有教训：`[高台]` 曾同时打印 ✗ 与 ✓）。

主流程在 `checkCloudlandMesa()` 之后加：

```js
await checkGiantPyramid();   // 巨型金字塔：烘焙产物/映射表/通道契约（⚠️ 漏了本行则门禁永不执行）
```

- [ ] **Step 2: 注册两个新测试文件**

`src/tests/index.html`，在 `import './test-mesa-gen.js';` 之后加：

```html
    import './test-giant-pyramid.js';
    import './test-giant-pyramid-gen.js';
```

- [ ] **Step 3: 跑门禁**

Run: `npm run check:data`
Expected: 输出含 `✓ [巨型金字塔] 16207 格 / 49×24×49 / 基座 2401 列 / 3 种方块（全 opaque/cutout、无砖无木）/ 指纹匹配`。

- [ ] **Step 4: 负向验证（三条，每条都要真 FAIL）**

按 `docs/testing-policy.md` §2.7 的要求，**每条注入都必须在**一份副本**上做、用完还原（禁止 `git checkout`）**：

```bash
cp tools/giant-pyramid-fingerprint.mjs /tmp/fp.bak
# 注入 ①：改映射表（指纹应变）
sed -i '' "s/smooth_sandstone: 'sand'/smooth_sandstone: 'stone'/" tools/giant-pyramid-fingerprint.mjs
npm run check:data   # 期望：✗ [巨型金字塔] 产物已过期 + ✗ palette 含砖/非沙
cp /tmp/fp.bak tools/giant-pyramid-fingerprint.mjs

# 注入 ②：改 PYRAMID_METRICS.stepCells（指标应变）
# 注入 ③：改 baseCells 2401 → 2400
```

每条注入都必须让 `check:data` **exit 1** 且报出对应的 `[巨型金字塔]` 消息。若某条注入后仍全绿 → 那条判据是无效的，须重写。

---

### Task 10: 图标烘焙 + 预算实测

**Files:**
- 产物：`assets/icons-atlas.png` + `assets/icons.json`（重烘）
- 无源码改动（除非预算实测要求）

**Interfaces:**
- Consumes: Task 4 的两个新方块（进背包 → 必须有图标）。
- Produces: 更新的图标产物。

- [ ] **Step 1: 重跑图标烘焙**

Run: `npm run icons`
Expected: 输出新 manifest，含 `sand_step` / `sand_slab` 两套尺寸档。

- [ ] **Step 2: 验证图标门禁**

Run: `npm run check:data`
Expected: `[图标 manifest]` 两档都是「= 背包集合（双向一致）」，`[形状权威]` 两项都是等轴测（`sand_step` / `sand_slab` 是非 box 几何 → 走 `TEMPLATES` 等轴测路径，**不要**进 `FLAT_BLOCKS`）。

- [ ] **Step 3: 实测单座顶点占用（Review Focus 3）**

这一步不做单独探针 —— **它已并入 Task 11 的用例 4**，因为那里本来就要传送 + 收敛，多读一次 `reservedV` 零额外成本。

Task 11 用例 4 的门槛判定就是本步的产出：若实测发现 opaque > 80% 或 cutout > 50%，**先做交替对照**（HEAD vs 改动，同一会话各 2 轮）再判定，不要看单次数值。

**预期数据（已用真 mesher 逐 section 实测，不是估算）**：单座 reserved = opaque **65,080** / cutout **73,170** / transparent 0，跨 **20 个 section**。占初始容量：opaque **1.52%**（4.275M）、cutout **3.33%**（2.2M）。

⚠️ **这比 spec §2 的手算值大 43%（65080 vs 45570）—— 两个口径都必须知道**：手算把整座当一个世界（面剔除跨 section 生效），而真实渲染按 section 分块，**相邻 section 之间不互相剔除**（mesher 只拿 section + 1 格 halo，但两个相邻 section 各自都认为自己那面暴露 → 重复算）。**不要把这个差异当回归** —— 它在本仓所有多 section 结构上都存在（高台/巨树/城堡同款）。

---

### Task 11: Tier 4 spec（真游戏页实测）

**Files:**
- Create: `tests/giant-pyramid.spec.mjs`

**Interfaces:**
- Consumes: 页面内 `window.__MC_GAME__`（`world` / `registry` / `scheduler` / `player.physics` / `renderWorld`）。
- Produces: 4 条 Playwright 用例。

- [ ] **Step 1: 写 spec（照 `tests/mesa.spec.mjs` 与 `tests/giant-trees.spec.mjs` 的结构）**

四条用例：

1. **特征方块在位**：找到最近的锚点 → 传送 → 收敛 → 按锚点扫 49×49×24 范围，断言 `sand_step` 计数 ≥ 1000、`sand_slab` ≥ 1、`sand` ≥ 10000。**sanitty**：断言扫描范围内确实有非空气方块（防「扫错坐标 → 全 0 → 恰好 ≥ 阈值」的假通过）。
2. **迷宫连通**：从塔基外圈的可站立格 BFS，覆盖占地内可站立格的 ≥ 95%。
   ⚠️⚠️ **可站立判据必须用本仓物理口径**：脚格 + 头格都是空气 + **脚下 1 格**是 `registry.solidTable[id] === 1`（**就是整格**，台阶/半砖也算实心）。**不能写「脚下 1~2 格内实心」** —— 那是原版（台阶=半格）的口径，会把 36 个实际走不到的高层格算成可达，得到 100% 的**假通过**。
   ⚠️ 阶梯移动集合用 `dy ∈ {0, +1, -1, -2}`（本仓 `tryStepUp` 的最大抬升是 1 格，而向下可落多格）。
   ⚠️ 实测本仓口径：可站立 2400 / 从外圈可达 2364 = **98.5%**。阈值定 95%（留 96 格余量给「玩家可能挖挖改改」的合理波动，同时能抓到「塔身被地形埋住一半」这类真回归）。
3. **塔基不悬空**：逐列向下 6 格内必须有实心，悬空列占比 ≤ 1%（实测 0.104%）。
4. **顶点预算**（Review Focus 3）：传送前后各读一次 `Σ reservedV`，增量 ≤ 单座实测（**opaque 65,080 / cutout 73,170**，真 mesher 逐 section 量）× 1.5；三通道 `maxVertexCount` 等于初始常量（零扩容）。⚠️ **开局先断言初始容量**（既有教训：`2.85M × 1.5` 恰好等于 `4.275M`，改回容量后末尾断言照样过）。
   ⚠️ 系数取 1.5 而不是 1.3：实测跨度 20 个 section，而「站隐旁边看」可能只加载了一部分 section（视距内），也可能因相邻施工重复计入 → 1.5 足够宽但不至于失去判别力（真实回归是「容量扩容」那种量级）。
   ⚠️ **主判据仍是「三通道零扩容」**（它才是玩家能感知到卡顿的那个东西）；顶点增量只是一个辅助信号。

必读的两条既有约束（照抄到 spec 顶部注释）：
- `setShadowsEnabled(false)`（VSM 下 receiveShadow 的对象也进阴影 pass → drawCalls 无关波动）；
- 传送用 `player.physics.pos` + 定时 pin（`clearInterval(window.__PIN__)` 打头）。

- [ ] **Step 2: 跑 spec**

Run: `npx playwright test tests/giant-pyramid.spec.mjs`
Expected: 4 passed。

- [ ] **Step 3: 负向验证（每条用例至少一条注入）**

- 用例 1：把 `STRUCTURE_FILES.giantPyramid` 改成不存在的文件 → 必须 FAIL（`sand_step` 计数 0）。
- 用例 3：把锚点 `floorY` 在 `apply.js` 里 `+5` → 必须 FAIL（悬空列暴涨）。
- 用例 4：把 `CAPACITY.cutout.active` 改成 300 → 必须 FAIL（开局容量断言）。

还原时用 `cp` 副本，**禁止 `git checkout`**。

---

### Task 12: 文档同步

**Files:**
- Modify: `AGENTS.md`（新增「巨型金字塔沉淀的活跃约束」段 + 目录结构清单 + 开发命令清单）
- Modify: `docs/roadmap.md`（扩展点表格 + 验收报告条目）
- Create: `docs/giant-pyramid-acceptance-report.md`

- [ ] **Step 1: `AGENTS.md`**

三处：

1. **目录结构清单**：`assets/giant-pyramid/src/` + `assets/structures/giant_pyramid.json` + `tools/litematic-reader.mjs` / `bake-giant-pyramid.mjs` / `giant-pyramid-fingerprint.mjs` + `src/gen/structures/giant-pyramid.js`。
2. **开发命令清单**：`npm run pyramid`（含「改 BLOCK_MAP / PYRAMID_METRICS / .litematic 后必跑」与「不跑会静默过期」）。
3. **新增活跃约束段**，至少覆盖：litematic 位打包跨 long、转角台阶用直台阶近似（有意偏离）、`PYRAMID_CHANCE` 是观感标定不是性能代偿、密度分母是沙漠连通块不是 region、高台/撒布排除落在 apply 层（循环依赖原因）、`opaque:false` 必须显式声明、门槛指标准确到洞穴悬空率 0.104%。

- [ ] **Step 2: `roadmap.md`**

扩展点表格加一行（「巨型金字塔 ✓ 已交付（2026-10-25）」+ 接入点指向 `giant-pyramid.js`）；「遗留 TODO」若涉及「更多沙漠大型结构」则更新。

- [ ] **Step 3: 验收报告**

`docs/giant-pyramid-acceptance-report.md`，照 `docs/giant-trees-acceptance-report.md` 的结构，含：

- 素材实测表（spec §2 那份）；
- 实现偏离表（spec §6 那 7 条 + 计划期间新增的）；
- 负向验证清单（Task 9 Step 4 三条 + Task 11 Step 3 三条，逐条写「注入什么 → 期望什么 → 实测什么」）；
- 实测数字：密度（8 seed 各值 + 合计）、顶点占用（opaque/cutout 百分比 + 是否扩容）、`check:data` 输出、`bench --check` 结果；
- 已知盲区（spec §7）。

- [ ] **Step 4: 最终门禁**

Run: `npm run check && npx playwright test tests/giant-pyramid.spec.mjs tests/structure-gen.spec.mjs tests/mesa.spec.mjs tests/giant-trees.spec.mjs tests/harness.spec.mjs`
Expected: 全部 exit 0 / PASS。

（热路径未动，`bench --check` 不是必须项；但若 Task 10 的预算实测发现 vertex 有可见增量，再跑一次 `npm run bench -- --check` 并做交替对照。）
