# 高台地带（Cloudland Tarn Zone）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「每块沙漠一个孤立高台」换成一张 region 级固定景观「高台地带」——直径 180 的水池 + 8 座高台环形分布（**轴对齐摆放、不旋转**，spec DR-7 方案 1）+ 5 个拱洞（池外台地）+ 7 个紫晶巨柱（池内）+ 4 朵巨型云，每 ~3 个 region 出现一处。

**Architecture:** 两段式（与 scatter / giant-trees / mesa / giant-pyramid 四路同构）：候选与布局在 `computeRegionLayout`（layout 层，Worker 内、纯函数、无 fetch）算一次；光栅化在 `apply.js` 的新阶段 2.4 按 column 裁剪写入。地带 region 的地标在候选层直接置 `null`（实测地带圆与地标 100% 相交，无法靠避开；⚠️ **`snowLand` 除外**：字段保留、只在 apply 阶段 1 跳过生成）。素材烘焙成 35 个 palette+扁平数组 JSON，惰性预载（11 座高台里运行时只用 8 座）。水面 = 体素水（逻辑/游泳）+ `ocean.js` 平面（视觉，池内顶点抬升到 y=2.5），池半径 90 使 transparent 通道**不需要扩容**。零新增方块、零新增 Worker、**零新增旋转机制**（`rasterizeStructure` 签名不动）。

**Tech Stack:** 纯 JavaScript ES2022 + ES Modules + JSDoc（禁 TypeScript）；three.js r185.1 WebGPU（`vendor/three/`）；Playwright 1.62.1；无 bundler。

**Spec:** `docs/superpowers/specs/2026-10-26-cloudland-tarn-zone-design.md`

## Global Constraints

- 解释与对话用中文，代码注释用中文（`AGENTS.md`）。
- **零新增方块**：35 个产物与台地的 palette 全部用 registry 里已有的名字。
- **零新增 Worker**：候选在 `computeRegionLayout` 里算（DR-13 口径）；Worker 创建入口唯一 = `core/worker-pool.js`。
- **Worker 同构层禁止 `import three`**：`src/gen/**`、`src/voxel/**`、`src/mesh/**`、`src/workers/**` 一律相对路径 import 本项目模块（`npm run check:arch` 守）。
- **资源路径只能走 `resourceUrl()`**（`src/core/resource-url.js`），禁止站点根绝对路径字面量。
- **红线 1（单一权威）**：地带判定 `isTarnZone()` 只有一份；方块映射表只有一份（`cloudland-kit-fingerprint.mjs`）；`KIT_VARIANTS`/`KIT_METRICS` 只有一份（`cloudland-kit-data.js`）；池面判据的 CPU/GPU 两版共享数值常量。
- **零新增旋转机制**（spec DR-7 方案 1）：高台/拱洞/紫晶柱全部**轴对齐**摆放，`rasterizeStructure` 签名不动。
  ⚠️ 不要再提「加 4 向旋转让高台朝心」—— 已被实测否决（档位公式与环上角度 θ 无关，做不到「短边沿径向」，L3 四角伸出池外 4.44 格）。
- **`seededRandom` 返回 `[0,1)` 浮点，取整用 `Math.floor(r * N)`，禁止 `& N`**（恒为 0）。
- **时间基准统一 `performance.now()`，禁 `Date.now()`**（本设计暂不涉及计时，但新增任何到期时间戳都遵守）。
- 定值（来自 spec，实施时不得改动，只能按实测**上调**并在文档留档）：
  - `REGION_SIZE = 400`、`SEA_Y = -2`、`WORLD_MAX_Y = 96`
  - `TARN_ZONE_RADIUS = 160`、`TARN_POOL_RADIUS = 90`（直径 180）、**`TARN_RING_RADIUS = 58`**（spec DR-7）
  - `TARN_ZONE_CHANCE = 1/3`
  - **烘焙 11 座高台，运行时只用 8 座**。`TARN_KEPT_TARN_IDS`（产物基名 = `.schem` 分量序）=
     `['cloudland_tarn_03','cloudland_tarn_04','cloudland_tarn_05','cloudland_tarn_06',`
     `'cloudland_tarn_09','cloudland_tarn_08','cloudland_tarn_10','cloudland_tarn_11']`
     —— spec DR-7 定稿（轴对齐 + ringR=58）：无抖动 AABB 最小间距 **5.05**、抖动后最坏 **4.21**、
     四角最远 **88.88** ≤ 90、reserved **98,235 = 78.6%**（含紫晶柱与 `glass_block`）。
     **舍 tarn_01（L1，68×60）的关键原因**：它在 ringR=58 上吃掉 71.6° 占角，8 座总占角超 360° → 环上排不下
  - 拱洞 `5`（**池外台地**，中线半径 125）、紫晶柱 `7`（**池内**，内环半径 **20**）、巨型云 `4`（从 12 个里选）
  - **`CAPACITY.transparent` 不动**（保持 `active: 100`）—— 不扩容是用户第三轮裁定（spec DR-5c/5d/5e 的推演链）

⚠️ **池半径 90、「只留 8 座」、ringR 58 这三个数不是拍的，是 spec DR-5c~5f + DR-7 整条推演的结果**，改动前必读：

1. 体素水**必然**占 transparent 通道（`mesher.js:408` 的 `WATER_LIKE` 只做同类互剔）；
   体素水**也不能删**（`physics.js:74` 的游泳判据显式查 `water`）。⇒ 容量是硬约束。
2. **减少高台数会「增加」水格**（高台占掉自己的水格）⇒ 「减高台」与「不扩容」是相反方向。
3. 实测 poolR=110 下**没有任何保留座数**能装进 125,000（11 座 103%、8 座 142%）。
4. **`ringR = 58` 是「四角全部落在池内」的上限**（实测标定：59 起 L3 四角出池）。
   ⚠️ **不要写成 `TARN_POOL_RADIUS − max(half) − 4` 这类公式** —— 轴对齐下最远角与 θ 有关，没有闭式解。
5. **轴对齐的固有代价：真实间距只有 ~5 格**，`TARN_GAP` 因此从 10 改为 **4**（用户第六轮裁定）。
   缩 ringR / 重排顺序 / 加大抖动三条路都试过，都救不回 10 格（spec DR-7「固有代价」表）。

⇒ 要改这几个数里任何一个（池半径、保留座数、ringR、gap 下限），**先重跑 spec DR-7 的实测表**，
并在 `test-tarn-zone.js` 的容量回归与 AABB 间距用例上验证，不要直接改常量。
  - salt：`TARN_ZONE_SALT = 1020`、`TARN_ANGLE_SALT = 1021`、`TARN_TERRAIN_SALT = 1022`、`TARN_DECO_SALT = 1023`、`TARN_CLOUD_SALT = 1024`
  - **`TARN_GAP = 4`**（相邻高台 AABB 真实最小间距，格）。⚠️ 原值 10 是旋转假设下的口径，轴对齐下几何上达不到（spec DR-7）。
- **测试分级**（`docs/testing-policy.md`）：本计划触及 Tier 1（机制/性能，必须 TDD）+ Tier 2（数据契约）+ Tier 4（GPU 像素）。

## Review Focus

这些是 spec 隐含、但没有哪个任务的测试会全覆盖、而使用者最容易碰到的输入或条件。每条都要落到拥有该代码的任务里。

1. **玩家在水池里游泳** —— 走进水池应当下沉变慢、空格上浮，而不是踩在池底走。`physics.js` 的游泳语义显式查 `water` 方块；若池内没放 `water`，这条会静默失效（不报错，只是不能游）。→ Task 5 与 Task 6 各有一条用例。
2. **地带跨越 region 边界** —— 地带中心在 region 中心、半径 160，距边界 40 格。若将来有人调大 `TARN_ZONE_RADIUS` 越过 198，地带会半边消失（相邻 region 不为它算候选）。→ Task 3 断言 `TARN_ZONE_RADIUS + 2 <= REGION_SIZE/2`。
3. **`CITY_REGION` 恰好掷到地带** —— 城市固定 region [0,0] 且是全世界唯一。若它变成地带，城市彻底消失。→ Task 3 断言 `isTarnZone(0, 0, seed) === false`（对所有 seed）。
4. **未知源方块名** —— 烘焙映射表缺一项时，`makeColumnSetter` 对未注册名字是**静默 return**，那格变 air，方块层面完全看不出是映射错了。→ Task 2 断言烘焙对未知名字 throw；Task 8 断言 palette 全在 registry。
5. **高台顶面材质** —— 用户明确要求 `moss` → `grass`。若漏改，**全部 11 个烘焙产物**的台顶仍是苔藓，肉眼像「没做这次改动」。→ Task 1 有名字级自检，Task 8 有门禁断言。
6. **第 35 个以内的产物漏预载** —— 35 个文件里漏一个，对应变体就静默不出现（`rasterizeStructure` 拿到空 blocks 直接 return）。→ Task 5 断言「8 + 5 + 7 + 4 个都真的写进了世界」。

## File Structure

| 文件 | 责任 | 状态 |
|---|---|---|
| `src/gen/structures/tarn-zone.js` | 地带判定 + 环形布局 + 装饰落位（纯函数、无 fetch、Worker 同构） | 新建 |
| `src/gen/structures/landmark-circles.js` | 从 `mesa.js` 搬出的 `regionLandmarkCenters()` + `LANDMARK_CLEARANCE`（`giant-pyramid.js` 仍需它；**不搬就删 `mesa.js` 会白屏**） | 新建（Task 9） |
| `src/gen/structures/tarn-terrain.js` | 台地整形（草石镶嵌 + 池底下沉 + 水池填充） | 新建 |
| `src/gen/structures/cloudland-kit-data.js` | **纯数据**：`KIT_VARIANTS` + `KIT_METRICS`（无任何 node 依赖，供 `src/**` 与浏览器单测 import） | 新建 |
| `tools/cloudland-kit-fingerprint.mjs` | `BLOCK_MAP` + 指纹计算（依赖 `node:fs/crypto`，**只给 tools 与 check:data 用**）+ 从 `cloudland-kit-data.js` re-export `KIT_VARIANTS` / `KIT_METRICS` | 新建 |
| `tools/bake-cloudland-kit.mjs` | 26 连通分量 → 按 palette 判族 → 35 个 JSON | 新建 |
| `src/tests/test-tarn-zone.js` | Tier 1：判定 / 布局 / AABB 间距 / 装饰 / 让路 / 容量回归 | 新建 |
| `src/tests/test-tarn-zone-gen.js` | Tier 1：layout 接线 + 真实 column GEN | 新建 |
| `src/tests/test-tarn-terrain.js` | Tier 1：台地整形（高度恒定 / 1 层水 / 草石镶嵌） | 新建 |
| `src/tests/test-tarn-water.js` | Tier 1：池水判据 CPU 版（`ocean-mask.js`）+ 游泳语义 | 新建 |
| `tests/tarn-zone.spec.mjs` | Tier 4：真游戏页景观实测 | 新建 |
| `src/gen/structures/structure-layout.js` | 加 `tarn` 字段 + 地带 region 压制地标（⚠️ **`snowLand` 字段保留**，A4） | 修改 |
| `src/gen/structures/apply.js` | 阶段 2.4（地带）；`pointContext` 加 `kind:'tarn'`；**阶段 1 跳过 `generateSnowLand`**（雪原让路，A4）；删阶段 2.75 | 修改 |
| `src/gen/structures/structure-json.js` | 35 个新类型映射（从 `KIT_VARIANTS` 派生）+ 删 `cloudlandMesaSmall`（⚠️ **签名不动**：方案 1 不加旋转参数，零回归） | 修改 |
| `src/gen/structures/sky-structures.js` | `applySkyStructures` 加可选参 `tarnClouds`（巨型云并入既有链路，不新开阶段） | 修改 |
| `src/gen/structures/giant-pyramid.js` | 删 **mesa** 排除判据；import 改指 `landmark-circles.js`（Task 9） | 修改 |
| `src/render/ocean-mask.js` | 池面判据 CPU 版（`tarnPoolAt` / `isPointInTarnPool`） | 修改 |
| `src/render/ocean.js` | 池面门控 uniform `uTarnPool` + **`positionNode` 抬升池内顶点到 y=2.5**（A3） | 修改 |
| `src/core/game.js` | 帧循环节流调 `ocean.setTarnPool(tarnPoolAt(...))`（照 `_updateSunPosition()` 的移动阈值手法） | 修改 |
| `src/render/render-world.js` | **不改**（不扩容，见 Task 6 Step 8） | 不改 |
| `tools/check-data.mjs` | `[高台]` → `[高台地带]` | 修改 |
| `package.json` | `mesa` → `tarn` | 修改 |
| `src/tests/index.html` | 注册 **4** 个新单测文件（tarn-zone / tarn-zone-gen / tarn-terrain / tarn-water）+ 删 2 个 mesa 注册行 | 修改 |
| `src/gen/structures/mesa.js` | **删除**（DR-11） | 删除 |
| `tools/bake-cloudland-mesa.mjs`、`tools/cloudland-mesa-fingerprint.mjs` | **删除** | 删除 |
| `assets/structures/cloudland_mesa_small.json` + `.meta.json` | **删除产物** | 删除 |
| `src/tests/test-mesa.js`、`test-mesa-gen.js`、`tests/mesa.spec.mjs` | **删除**（判据被新用例覆盖） | 删除 |

---

## Task 1: 素材烘焙 —— 四族判定 + 35 个产物

**Files:**
- Create: `src/gen/structures/cloudland-kit-data.js`（**纯数据，零 node 依赖**）
- Create: `tools/cloudland-kit-fingerprint.mjs`
- Create: `tools/bake-cloudland-kit.mjs`
- Modify: `package.json`（`scripts` 加 `"tarn": "node tools/bake-cloudland-kit.mjs"`）
- Test: `npm run tarn` 的成功输出（本任务无单测，属 Tier 2 数据契约，由 Task 8 的门禁覆盖）

**Interfaces:**
- Consumes: `tools/nbt-reader.mjs` 的 `NbtReader`（已有）；`assets/cloudland/src/cloudlandassets_1.20.schem`（已入库）
- Produces:
  - **`src/gen/structures/cloudland-kit-data.js`**（无 node 依赖，浏览器/Worker 可 import）导出：
    - `KIT_METRICS: Record<string, {width:number, height:number, depth:number, blocks:number}>`
    - `KIT_VARIANTS: {tarn: string[], arch: string[], spire: string[], giantCloud: string[]}`（元素是产物文件基名，如 `cloudland_tarn_01`）
  - **`tools/cloudland-kit-fingerprint.mjs`**（依赖 `node:fs/path/crypto`，**只给 tools 与 check-data 用**）导出：
    - `SCHEM_PATH: string`、`KIT_JSON_DIR: string`、`BLOCK_MAP: Record<string,string>`
    - `cloudlandKitInputFingerprint(): {input, schemSha256, paramsSha256}`
    - 并 `export { KIT_METRICS, KIT_VARIANTS } from '../../src/gen/structures/cloudland-kit-data.js';`（re-export，单一定义处）

  ⚠️ **为什么必须拆两个文件**（B1，审阅实测）：`tools/` 下的模块 `import fs from 'node:fs'`，
  而浏览器与 Web Worker **无法解析 `node:` 协议** → `src/**` 或浏览器单测 import 它会让
  **整个模块不加载**（测试文件全不跑 / Worker 启动失败 / 游戏白屏）。
  `npm run check:arch` 抓不到这类**运行时**解析失败。既有教训见
  `src/tests/test-giant-pyramid-gen.js:252` 的注释（「那个模块在 tools/ 且依赖 node:fs，不 import」）。
  - 35 个产物文件：`assets/structures/cloudland_{tarn,arch,spire,giant_cloud}_NN.json`，格式 `{version:1, palette:string[], blocks:number[]}`（`blocks` 是 `[x,y,z,paletteIndex, ...]` 扁平数组，最低点归一化到 y=1）

- [ ] **Step 1: 建两个骨架文件（纯数据 + 指纹），先只导出空表**

⚠️ **必须分成两个文件**（B1）：`src/gen/structures/cloudland-kit-data.js` 放**纯数据**
（无 node 依赖，浏览器/Worker 可 import）；`tools/cloudland-kit-fingerprint.mjs` 放
**映射表 + 指纹计算**（依赖 `node:fs`，只给 tools 与 check-data 用），并 re-export 前者。

先写纯数据文件 `src/gen/structures/cloudland-kit-data.js`：

```javascript
// src/gen/structures/cloudland-kit-data.js — Cloudland 套件的**纯数据**（零 node 依赖）
//
// ⚠️ **不要在这个文件里 import 任何 node 内建模块**：它要被浏览器单测
// （test-tarn-zone.js / test-tarn-zone-gen.js）与 Worker 侧的 structure-json.js import。
// `node:` 协议在浏览器里无法解析 → 整个模块不加载 → 测试全不跑 / Worker 起不来 / 白屏。
// 映射表与指纹计算留在 tools/cloudland-kit-fingerprint.mjs（那里可以依赖 node:fs）。

export const KIT_METRICS = Object.freeze({});
export const KIT_VARIANTS = Object.freeze({ tarn: [], arch: [], spire: [], giantCloud: [] });
```

再写 `tools/cloudland-kit-fingerprint.mjs`（这里可以有 node 依赖）：

```javascript
// tools/cloudland-kit-fingerprint.mjs — Cloudland 素材套件烘焙的**输入指纹与映射表**共享模块
//
// 唯一权威（红线 1）：烘焙脚本 `bake-cloudland-kit.mjs` 与数据契约门 `check-data.mjs`
// 都从这里 import，不得各写一份。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
// 纯数据从 src/ 来（单一定义处，红线 1）；本文件只加 node 侧的东西并 re-export
import { KIT_METRICS, KIT_VARIANTS } from '../../src/gen/structures/cloudland-kit-data.js';
export { KIT_METRICS, KIT_VARIANTS };

const ROOT = path.resolve(import.meta.dirname, '..');
export const SCHEM_PATH = path.join(ROOT, 'assets', 'cloudland', 'src', 'cloudlandassets_1.20.schem');
export const KIT_JSON_DIR = path.join(ROOT, 'assets', 'structures');

/** 源方块名 → 本仓 registry 方块名（Step 2 填）。 */
export const BLOCK_MAP = Object.freeze({});
```

- [ ] **Step 2: 跑一次源方块普查，把需要映射的 69 种名字与格数打印出来**

在 `bake-cloudland-kit.mjs` 里先只写 `--census` 模式（读 `.schem` → 26 连通分量 → 按 palette 判族 → 打印每族的源方块与格数），然后运行：

```bash
node tools/bake-cloudland-kit.mjs --census
```

预期：打印四个族的分量与源方块汇总。**核对这些实测数字**（spec §2 已给出，若不一致说明 `.schem` 被换过，停下来报告）：

- 高台族 **11** 个，格数 `83145 / 50327 / 33215 / 32100 / 24087 / 22910 / 12624 / 10712 / 8952 / 5013 / 2025`
- 拱洞族 **5** 个有效（格数 ≥ 600）：`1480 / 1185 / 1142 / 1113 / 640`；另有 3 个碎屑 `13 / 5 / 1` 丢弃
- 紫晶柱族 **7** 个：`436 / 381 / 345 / 298 / 134 / 79 / 21`
- 巨型云族 **12** 个：`29836 / 15283 / 14177 / 12358 / 12235 / 9494 / 7945 / 6883 / 1432 / 436 / 121 / 60`

判族规则（写进 `bake-cloudland-kit.mjs`，**不要按 `.bp` 目录名判**，spec §2.2）：

```javascript
const has = (names, n) => names.includes(n);
function familyOf(names) {
  if (has(names, 'moss_block')) return 'tarn';
  if (has(names, 'diorite') && has(names, 'snow_block')) return 'giantCloud';
  if (names.some((n) => n.includes('purple') || n === 'light_blue_terracotta' || n === 'chorus_plant')) return 'spire';
  return 'arch';   // 剩余灰岩族；格数 < 600 的当碎屑丢弃
}
```

- [ ] **Step 3: 填 `BLOCK_MAP`（继承既有 41 项 + 新增拱洞/紫晶柱 + 改 moss→grass），并把普查里出现的每个名字都覆盖到**

从 `tools/cloudland-mesa-fingerprint.mjs` 的 `BLOCK_MAP` 复制那 41 项作为基础，然后按 spec §4.3 改三处：

1. 苔藓层四个源名（`moss_block` / `green_terracotta` / `lime_terracotta` / `green_wool`）的目标从 `'moss'` **改为 `'grass'`**。
2. 拱洞族新增（普查里出现的灰岩名字）：`cobblestone`→`cobblestone`、`andesite`→`stone`、`nether_bricks`→`deepslate`、`cracked_nether_bricks`→`deepslate`。
3. 紫晶柱族新增：`light_blue_terracotta`→`block_of_quartz`、`purple_stained_glass_pane`→`glass_block`、`chorus_plant`→`amethyst`、`purple_concrete`/`purple_concrete_powder`/`purple_terracotta`/`purple_wool`→`block_of_quartz`、`blue_terracotta`→`block_of_quartz`。
4. 巨型云族新增（普查里出现的）：`basalt`→`deepslate`、`diorite`→`marble`、`polished_diorite`→`marble`、`snow_block`→`snow`、`iron_block`→`iron`、`gravel`→`debris`、`calcite`→`calcite`、`coarse_dirt`→`dirt`、`white_concrete`→`marble`、`white_wool`→`snow`、`light_gray_wool`→`light_gray_cloth`、`light_gray_concrete`→`smooth_stone`、`light_gray_concrete_powder`→`smooth_stone_1`、`light_gray_terracotta`→`clay`。

⚠️ **`mossy_stone` / `clay` / `stone` / `deepslate` / `marble` / `snow` / `calcite` / `debris` / `dirt` / `iron` / `amethyst` / `block_of_quartz` / `glass_block` / `light_gray_cloth` / `smooth_stone` / `smooth_stone_1` / `cobblestone` 必须都在 registry 里**（`src/voxel/blocks-data.js`）。若普查出现某个名字既不在既有 `BLOCK_MAP` 也不在上面的清单，**停下来报告**，不要猜一个名字。

- [ ] **Step 4: 写出烘焙，跑一次并验证 35 个产物生成且格数与实测一致**

`bake-cloudland-kit.mjs` 的主流程（沿用 `bake-cloudland-mesa.mjs` 的解码与 palette 压缩手法）：

1. `loadSchematic()`：gzip → `NbtReader` → `Width/Height/Length` + `Blocks.Palette` + `Blocks.Data`（varint）→ `Uint16Array`。
2. `connectedComponents()`：y ≥ 1 的实心格做 **26 邻接**连通分量（**剔除 y=0 地板层**，否则 38 个结构会连成一片）。
3. 每个分量：`familyOf(paletteNames)`；`arch` 族里 `cells.length < 600` 的丢弃。
4. **族内排序**：按格数**降序**（顺序必须固定，产物文件名与顺序绑定）。

   ⚠️ **编号规则决定了 `TARN_KEPT_TARN_IDS` 的取值，必须按这张表核对**（`.schem` 分量序 → 产物编号）：

   | 产物 | `.schem` 分量序 | 格数 | 尺寸 | 运行时保留？ |
   |---|---|---|---|---|
   | `cloudland_tarn_01` | #0 | 83,145 | 68×35×60 | ❌ 舍弃（切向宽 34 → 抖动余量 0%） |
   | `cloudland_tarn_02` | #1 | 50,327 | 58×31×46 | ❌ 舍弃 |
   | `cloudland_tarn_03` | #2 | 33,215 | 44×27×48 | ✅ |
   | `cloudland_tarn_04` | #3 | 32,100 | 40×45×36 | ✅ |
   | `cloudland_tarn_05` | #5 | 24,087 | 36×46×32 | ✅ |
   | `cloudland_tarn_06` | #6 | 22,910 | 36×39×32 | ✅ |
   | `cloudland_tarn_07` | #9 | 12,624 | 25×37×29 | ❌ 舍弃 |
   | `cloudland_tarn_08` | #12 | 10,712 | 20×43×21 | ✅ ← **现役那座**，保留它是为了玩家连续感 |
   | `cloudland_tarn_09` | #14 | 8,952 | 21×37×25 | ✅ |
   | `cloudland_tarn_10` | #17 | 5,013 | 17×36×18 | ✅ |
   | `cloudland_tarn_11` | #18 | 2,025 | 13×31×12 | ✅ |

   （8 个 ✅ = spec DR-5f 的 `TARN_KEPT_TARN_IDS`；烘 11、用 8。）
   ⚠️ **编号 ≠ 分量序**（因为剔除了 3 座，序号错位）。写 `TARN_KEPT_TARN_IDS` 时**按上表抄**，
   不要凭「分量序」脑补。
5. 每个分量烘焙一个 JSON：
   - `OX = comp.x0 + floor((comp.x1 - comp.x0) / 2)`、`OZ = comp.z0 + floor((comp.z1 - comp.z0) / 2)`（以**水平包围盒中心**为原点）；
   - `y` 归一化：`y - comp.y0 + 1`；
   - 逐格过 `BLOCK_MAP`，**未命中就 `throw`**（不要静默跳过）；
   - palette 索引压缩后写 `{version:1, palette, blocks}`。
6. 写 `KIT_METRICS`：每个基名 → `{width, height, depth, blocks}`（从烘焙结果回填，然后**手工固化进 `src/gen/structures/cloudland-kit-data.js`** —— 那是纯数据文件，不是 fingerprint 文件）。
7. 写 `KIT_VARIANTS`：四个族的基名数组（`cloudland_tarn_01..11` 等），**同样写进 `cloudland-kit-data.js`**。

   ⚠️ 烘焙脚本要从 `cloudland-kit-data.js` **import 这两个常量做断言**，断完再手工更新文件 ——
   不要反过来让烘焙脚本往 `src/**` 写文件（生成路径不得改源码）。

运行：

```bash
npm run tarn
```

预期输出形如：

```
高台 11 个 / 拱洞 5 个 / 紫晶柱 7 个 / 巨型云 12 个
cloudland_tarn_01.json 83145 格 68×35×60
...
共 35 个产物，合计 402624 格
指纹 <16 hex>:<16 hex>
```

**核对合计 = 402,624 格**（spec §2 实测）。不一致就停下报告。

⚠️ **每座高台的单独尺寸要与 spec §2.3 的 11 行表逐个对得上**（宽×高×深与格数）。
那张表是从 `.schem` 实测出来的，是 `KIT_METRICS` 回填的依据。对不上说明分量排序或判族变了。

⚠️ **`.bp` 蓝图文件不入库、也不参与烘焙**（spec §2.5）：`Landscape/7.bp` 声明 12623 而分量实测 12624
（差 1），`Cloud/` 与 `ARC/` 的 `.bp` 数量也与分量数不符。**族划分与布局一律从 `.schem` 的
连通分量派生**，`.bp` 只用来「看缩略图辅助判族」。不要写「按 .bp 文件数推变体数」的代码。

⚠️ **35 个产物 + 2 个运行时模块，零新增方块（spec DR-12）**：所有源方块都映射到
registry 里已有的名字。**不要为解决某个观感问题而新建方块**（用户明确要求），
也不要给这个地带加「整座地带」的 alias 占位物品（它是纯生成期地形，与高台同口径）。

- [ ] **Step 5: 断言「苔藓层已改成 grass」**

在烘焙脚本末尾加一条自检并运行：

```bash
node -e "
const fs=require('node:fs');
const t=JSON.parse(fs.readFileSync('assets/structures/cloudland_tarn_09.json','utf8'));
const idx=t.blocks.filter((_,i)=>i%4===3).map(i=>t.palette[i]);
const set=new Set(idx);
console.log('palette:', [...set].join(' '));
if (set.has('moss')) throw new Error('台顶还是 moss —— moss_block 等四个源名的映射没改成 grass');
console.log('OK: 无 moss');
"
```

预期：`OK: 无 moss`。若打印 `moss` 就回到 Step 3 改映射并重跑 `npm run tarn`。

- [ ] **Step 6: Commit**

```bash
git add src/gen/structures/cloudland-kit-data.js tools/cloudland-kit-fingerprint.mjs tools/bake-cloudland-kit.mjs package.json assets/structures/cloudland_tarn_*.json assets/structures/cloudland_arch_*.json assets/structures/cloudland_spire_*.json assets/structures/cloudland_giant_cloud_*.json
git commit -m "feat(tools): Cloudland 套件四族烘焙（35 产物，台顶 moss→grass）"
```

---

## Task 2: 地带判定与环形布局（纯函数）

**Files:**
- Create: `src/gen/structures/tarn-zone.js`
- Create: `src/tests/test-tarn-zone.js`
- Modify: `src/tests/index.html`（在 `import './test-giant-pyramid-gen.js';` 之后加 `import './test-tarn-zone.js';`）

**Interfaces:**
- Consumes: `seededRandom` 从 `../noise.js`；`REGION_SIZE` 从 `./region-config.js`
- Produces（`tarn-zone.js` 导出，后续任务全部依赖这份签名）:
  - `TARN_ZONE_RADIUS = 160`、`TARN_POOL_RADIUS = 90`、`TARN_RING_RADIUS = 58`、`TARN_ZONE_CHANCE = 1/3`、`TARN_GAP = 4`（AABB 真实间距口径，用户第六轮裁定）
  - `TARN_KEPT_TARN_IDS: string[]`（8 项，见 Global Constraints）
  - `TARN_ZONE_SALT = 1020`、`TARN_ANGLE_SALT = 1021`、`TARN_DECO_SALT = 1023`
  - `isTarnZone(regionX: number, regionZ: number, seed: number): boolean`
  - `tarnZoneCenter(regionX: number, regionZ: number): {cx: number, cz: number}`
  - `tarnHalfWidth(variant: {width:number, height:number, depth:number}): {halfX: number, halfZ: number}`
    —— **轴对齐的世界半宽**（= `width/2` / `depth/2`，与环上角度无关）。⚠️ 不要返回
    `{radial, tangential}` —— 那是「长边切向朝心」旋转假设下的概念，轴对齐下无意义（spec DR-7 致命 1′）。
  - `aabbGap(a, b): number` —— 两个轴对齐矩形的真实最短距离（供单测与布局自检共用，红线 1）
  - `computeTarnZone(regionX: number, regionZ: number, seed: number): TarnLayout | null`，其中
    ```javascript
    /** @typedef {{
     *   cx: number, cz: number,            // 地带中心（= region 中心）
     *   poolRadius: number, plateauRadius: number, plateauY: number,
     *   tarns: Array<{variant: string, ang: number, ring: number, halfX: number, halfZ: number}>,
     *   decos: Array<{variant: string, kind: 'arch'|'spire', ang: number, ring: number, halfX: number, halfZ: number}>,
     *   clouds: Array<{variant: string, ang: number, ring: number}>
     * }} TarnLayout */
    ```
  - `TARN_CLOUD_MIN_Y = 54`（巨型云的最低 y，**必须在 `tarn-zone.js` 里 export**，Task 5 要 import 它）

⚠️ **`isTarnZone()` 是地带的唯一入口（spec DR-2）**：候选层、`apply.js` 的让路、
雪原让路、`pointContext`、巨树 `allowedAt`、海面遮罩全部调它。
**加新消费者时 import 这个函数，不要自己写一份 `seededRandom(rx, rz, seed + 1020) < 1/3`** ——
两份判据漂移会让「有的系统当地带、有的不当」，形态是台地上长树、水池里插空岛这类撕裂。

⚠️ **`plateauY` 由 `computeTarnZone()` 定义**（= `SEA_Y + 4` = 2），因为它是**几何常量而不是地形常量**：
Task 4 的整形、Task 5 的高台 y、Task 6 的水面平面全要读同一个值。
放在 `tarn-zone.js` 而不要放在 `tarn-terrain.js`（后者依赖前者会成环）。

- [ ] **Step 1: 写失败测试（判定 + 中心 + 半径不越界 + 城市排除）**

```javascript
// src/tests/test-tarn-zone.js — 高台地带 Tier 1：判定 / 环形布局 / 间距 / 装饰落位 / 让路
//
// 钉的是「改坏了会静默产出一个错误但看起来正常的地带」这几类缺陷：
//   · 地带跨 region 边界 → 相邻 region 不为它算候选 ⇒ 地带半边永久消失
//   · 抖动过大 → 相邻高台贴在一起（水池里两块台子糊成一坨）
//   · 装饰件叠在高台上 → 拱洞穿进台身
//   · CITY_REGION 掷到地带 → 全世界唯一的城市消失
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse } from './assert.js';
import {
  isTarnZone, tarnZoneCenter, computeTarnZone,
  TARN_ZONE_RADIUS, TARN_POOL_RADIUS, TARN_ZONE_CHANCE, TARN_GAP, TARN_KEPT_TARN_IDS,
} from '../gen/structures/tarn-zone.js';
import { REGION_SIZE, CITY_REGION } from '../gen/structures/region-config.js';

const SEED = 12345;

test('地带判定：同一 seed 同一 region 两次调用结果相同', () => {
  for (const [rx, rz] of [[0, 0], [1, 0], [3, -2], [-4, 5]]) {
    assertEqual(isTarnZone(rx, rz, SEED), isTarnZone(rx, rz, SEED), `region(${rx},${rz}) 稳定`);
  }
});

test('地带判定：CITY_REGION 永远不是地带（城市是全世界唯一地标）', () => {
  for (const seed of [12345, 424242, 777, 2024, 1, 2, 3]) {
    assertFalse(isTarnZone(CITY_REGION.X, CITY_REGION.Z, seed),
      `seed ${seed} 的 CITY_REGION 不得是地带`);
  }
});

test('地带判定：密度落在 1/3 附近', () => {
  let hits = 0, total = 0;
  for (let rx = -6; rx <= 6; rx++) for (let rz = -6; rz <= 6; rz++) {
    total++;
    if (isTarnZone(rx, rz, SEED)) hits++;
  }
  const ratio = hits / total;
  assertTrue(Math.abs(ratio - TARN_ZONE_CHANCE) < 0.05,
    `密度 ${ratio.toFixed(3)} 应接近 ${TARN_ZONE_CHANCE.toFixed(3)}（${hits}/${total}）`);
});

test('地带中心 = region 中心', () => {
  for (const [rx, rz] of [[1, 0], [-2, 3]]) {
    const c = tarnZoneCenter(rx, rz);
    assertEqual(c.cx, rx * REGION_SIZE + REGION_SIZE / 2, 'cx');
    assertEqual(c.cz, rz * REGION_SIZE + REGION_SIZE / 2, 'cz');
  }
});

test('地带半径不越 region 边界（否则半边永久消失）', () => {
  assertTrue(TARN_ZONE_RADIUS + 2 <= REGION_SIZE / 2,
    `TARN_ZONE_RADIUS(${TARN_ZONE_RADIUS}) + 2 必须 <= ${REGION_SIZE / 2}`);
  assertTrue(TARN_POOL_RADIUS < TARN_ZONE_RADIUS, '水池必须在地带圆内');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx playwright test tests/harness.spec.mjs --grep "test-tarn-zone"
```

或直接开 `http://localhost:8081/src/tests/index.html` 看结果。
预期：**FAIL**，报 `Cannot find module '../gen/structures/tarn-zone.js'` 或（在浏览器里）`Failed to resolve module specifier`。若测试一开始就通过，说明测错了对象。

- [ ] **Step 3: 实现 `tarn-zone.js` 的常量与判定**

```javascript
// src/gen/structures/tarn-zone.js — 高台地带（Cloudland Tarn Zone）候选与布局
// 设计文档 docs/superpowers/specs/2026-10-26-cloudland-tarn-zone-design.md DR-1~DR-8
//
// 两段式的前一段（与 scatter / giant-trees / mesa / giant-pyramid 同构，红线 2）：
//   本文件               computeTarnZone()：region 级布局（纯函数、无状态、无 fetch）
//   apply.js 阶段 2.4    按布局光栅化到 column
//
// Worker 同构：不得 import three、不得自建 Worker、**不得 fetch**（候选在 layout 层算一次，DR-13）。
import { seededRandom } from '../noise.js';
import { REGION_SIZE, CITY_REGION } from './region-config.js';

/** 地带半径（圆）：池半径 90 + 岸带 70。改它必须先看 DR-4 的不等式。 */
export const TARN_ZONE_RADIUS = 160;
/** 水池半径（直径 180）。spec DR-5f/DR-7：128 会超容量 151%，90 只占 ~78%（定稿组合）。 */
export const TARN_POOL_RADIUS = 90;
/**
 * 高台环半径（轴对齐摆放，spec DR-7 方案 1）。
 * ⚠️ **这是实测标定值，不是公式**：58 是「定稿 8 座的四角全部落在池内」的上限
 * （59 起 L3 四角出池）。轴对齐下最远角与环上角度 θ 有关，没有闭式解，
 * **不要写成 `TARN_POOL_RADIUS − max(half) − 4` 这类公式**。
 * 改池半径 / 改保留组合 → 必须重新穷举标定这个值。
 */
export const TARN_RING_RADIUS = 58;

/**
 * 运行时实际使用的 8 座高台（产物基名，顺序 = .schem 分量序）。
 *
 * ⚠️ **烘焙产出 11 座，只用 8 座** —— 这不是「漏了 3 个」，是 spec DR-5f/DR-7 穷举后的定稿：
 * 约束「不扩容（reserved ≤ 125,000）且四角落池内」，取高台总格数尽量大的组合
 * （139,014 格 / reserved 98,235 = 78.6%）。
 *
 * ⚠️ 早期的「格数最大」组合（188,944 格）因含 L1（68×60）被否决：它在 ringR=58 上
 * 吃掉 71.6° 占角，8 座总占角超 360° → 环上排不下。
 *
 * 舍弃：cloudland_tarn_01(83,145) / cloudland_tarn_02(50,327) / cloudland_tarn_07(12,624)。
 * ⚠️ 保留 tarn_03（L3）—— 它是 44×48，是定稿组合里最大的一座（四角最远 88.88 ≤ 90）。
 * 改这个列表 = 改水池的容量占用与环半径标定 → **必须重跑 test-tarn-zone.js 的容量回归用例**。
 */
export const TARN_KEPT_TARN_IDS = Object.freeze([
  'cloudland_tarn_03', 'cloudland_tarn_04', 'cloudland_tarn_05', 'cloudland_tarn_06',
  'cloudland_tarn_09', 'cloudland_tarn_08', 'cloudland_tarn_10', 'cloudland_tarn_11',
]);
/** 地带出现概率（每 ~3 个 region 一处，用户裁定）。 */
export const TARN_ZONE_CHANCE = 1 / 3;
/**
 * 相邻高台的 **AABB 真实最小间距**（格）。抖动必须钳制，使该值恒成立（DR-7）。
 * ⚠️ **原值 10 是「长边切向朝心」旋转假设下的口径，轴对齐下几何上达不到**
 * （真实间距只有 ~5 格；缩 ringR / 重排顺序 / 加大抖动三条路都试过，都救不回 10）。
 * 用户第六轮裁定改为 4。改这个值前先读 spec DR-7「轴对齐的固有代价」。
 */
export const TARN_GAP = 4;

/** 地带判定的 salt（程序化扫描确认 1016..1099 空闲，本设计占用 1020..1024）。 */
export const TARN_ZONE_SALT = 1020;
/** 高台角度抖动的 salt（必须与判定用不同值，否则「顺序靠前的更容易过」产生偏斜）。 */
export const TARN_ANGLE_SALT = 1021;
/** 装饰件落位的 salt。 */
export const TARN_DECO_SALT = 1023;

/**
 * 该 region 是否为高台地带。
 *
 * ⚠️ **这是地带的唯一判定入口**（红线 1）：候选层、apply 的让路、雪原让路、pointContext、
 * 巨树 allowedAt、海面遮罩全部调它，不得各写一份。
 *
 * 用**粗格哈希**而不是噪声 + 阈值（巨树 v1.71 实测沉淀）：`noise()` 把 seed 加进坐标，
 * 相位随 seed 漂移 → 固定阈值跨 seed 不稳；而整数 region 下标的哈希通过率恒等于
 * `TARN_ZONE_CHANCE` 且与 seed 无关。
 *
 * ⚠️ **CITY_REGION 恒 false**：城市固定 region [0,0] 且全世界唯一，被随机吃掉是不可接受的。
 */
export function isTarnZone(regionX, regionZ, seed) {
  if (regionX === CITY_REGION.X && regionZ === CITY_REGION.Z) return false;
  return seededRandom(regionX, regionZ, seed + TARN_ZONE_SALT) < TARN_ZONE_CHANCE;
}

/** 地带中心 = region 中心（DR-3：偏移搜索在多数 seed 下找不到半径 160 的位置）。 */
export function tarnZoneCenter(regionX, regionZ) {
  return { cx: regionX * REGION_SIZE + REGION_SIZE / 2, cz: regionZ * REGION_SIZE + REGION_SIZE / 2 };
}
```

- [ ] **Step 4: 跑测试确认通过**

预期：本文件的 5 条用例 **PASS**。（`computeTarnZone` 还没实现，后续步骤补。）

- [ ] **Step 5: 写失败的布局测试（8 座全落池内 + 间距 + 装饰件）**

追加到 `test-tarn-zone.js`：

```javascript
// ⚠️ 从 src/ 的**纯数据**模块 import，不从 tools/ —— 后者依赖 node:fs，浏览器里解析失败（B1）
import { KIT_VARIANTS, KIT_METRICS } from '../gen/structures/cloudland-kit-data.js';

/** 找一个确实发生在地带上的 region（按 seed 确定性搜） */
function findTarnRegion(seed) {
  for (let rx = -6; rx <= 6; rx++) for (let rz = -6; rz <= 6; rz++) {
    if (isTarnZone(rx, rz, seed)) return { rx, rz };
  }
  throw new Error('没找到地带 region —— 判定实现有问题');
}

test('地带布局：保留的 8 座高台全都在（不重不漏）', () => {
  const { rx, rz } = findTarnRegion(SEED);
  const lay = computeTarnZone(rx, rz, SEED);
  assertTrue(lay !== null, '地带 region 必须有布局');
  assertEqual(lay.tarns.length, 8, '高台数（spec DR-5f：8 座）');
  const variants = new Set(lay.tarns.map((t) => t.variant));
  assertEqual(variants.size, 8, '8 座必须是 8 个不同变体（不重复）');
});

test('地带布局：每座高台的四角落在水池内（轴对齐，逐角算）', () => {
  const { rx, rz } = findTarnRegion(SEED);
  const lay = computeTarnZone(rx, rz, SEED);
  for (const t of lay.tarns) {
    // ⚠️ **必须逐角算**（spec DR-7）：轴对齐矩形的最远点是四个角之一，不是边中点。
    //    两个常见错误口径：
    //    · ring + halfX + halfZ —— 把两个半宽相加，每座多算 10~34 格；
    //    · ring + min(halfX, halfZ) —— 那是边中点，实测 L3 角比边中点远 8.9 格，
    //      会让高台伸出池外而断言全绿。
    const cx = t.ring * Math.cos(t.ang), cz = t.ring * Math.sin(t.ang);
    let maxReach = 0;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      maxReach = Math.max(maxReach, Math.hypot(cx + sx * t.halfX, cz + sz * t.halfZ));
    }
    assertTrue(maxReach <= lay.poolRadius,
      `${t.variant} 四角最远 ${maxReach.toFixed(1)} > 池半径 ${lay.poolRadius}`);
  }
});

test('地带布局：相邻高台 AABB 真实间距 >= TARN_GAP（含抖动）', () => {
  const { rx, rz } = findTarnRegion(SEED);
  const lay = computeTarnZone(rx, rz, SEED);
  const n = lay.tarns.length;
  for (let i = 0; i < n; i++) {
    const a = lay.tarns[i], b = lay.tarns[(i + 1) % n];
    const ax = a.ring * Math.cos(a.ang), az = a.ring * Math.sin(a.ang);
    const bx = b.ring * Math.cos(b.ang), bz = b.ring * Math.sin(b.ang);
    // ⚠️ **轴对齐 AABB 的真实最短距离**（spec DR-7 唯一口径）：
    //    两轴分离量都 > 0 时取 hypot(dx,dz)，否则取正的那个；都 < 0 即重叠。
    //    ⚠️ 不要用 chord − halfX − halfZ 这类「弦长减半宽」的旧口径 ——
    //    那是旋转假设下的近似，轴对齐下会高估间距。
    const dx = Math.abs(ax - bx) - (a.halfX + b.halfX);
    const dz = Math.abs(az - bz) - (a.halfZ + b.halfZ);
    const gap = (dx > 0 && dz > 0) ? Math.hypot(dx, dz) : Math.max(dx, dz);
    assertTrue(gap >= TARN_GAP,
      `${a.variant}↔${b.variant} AABB 间距 ${gap.toFixed(2)} < ${TARN_GAP}`);
  }
});

test('地带布局：12 个装饰件全在（5 拱洞 + 7 紫晶柱）且在正确区域', () => {
  const { rx, rz } = findTarnRegion(SEED);
  const lay = computeTarnZone(rx, rz, SEED);
  const arches = lay.decos.filter((d) => d.kind === 'arch');
  const spires = lay.decos.filter((d) => d.kind === 'spire');
  assertEqual(arches.length, 5, '拱洞数');
  assertEqual(spires.length, 7, '紫晶柱数');
  // A1 修正：拱洞在**池外台地**（池半径之外、地带圆之内）
  for (const a of arches) {
    assertTrue(a.ring > lay.poolRadius, `拱洞 ${a.variant} 必须在池外（ring ${a.ring} <= ${lay.poolRadius}）`);
    const maxHalf = Math.max(a.halfX, a.halfZ);
    assertTrue(a.ring + maxHalf <= TARN_ZONE_RADIUS,
      `拱洞 ${a.variant} 压出地带边缘（${(a.ring + maxHalf).toFixed(1)} > ${TARN_ZONE_RADIUS}）`);
  }
  // 紫晶柱在**池内**
  for (const sp of spires) {
    assertTrue(sp.ring < lay.poolRadius, `紫晶柱 ${sp.variant} 必须在池内（ring ${sp.ring} >= ${lay.poolRadius}）`);
  }
});

/** 两个轴对齐矩形的真实最短距离（与上面的间距用例同一个函数，实现时抽成 tarn-zone.js 的导出）。 */
function aabbGap(a, b) {
  const dx = Math.abs(a.cx - b.cx) - (a.halfX + b.halfX);
  const dz = Math.abs(a.cz - b.cz) - (a.halfZ + b.halfZ);
  if (dx > 0 && dz > 0) return Math.hypot(dx, dz);
  return Math.max(dx, dz);   // 都 < 0 即重叠（返回负）
}

test('地带布局：装饰件不与任何高台/彼此重叠（轴对齐 AABB）', () => {
  const { rx, rz } = findTarnRegion(SEED);
  const lay = computeTarnZone(rx, rz, SEED);
  // ⚠️ **轴对齐下就是逐轴比较，不需要 SAT**（原稿的 rotatedRectsOverlap 是旋转假设的残留）。
  //    ⚠️ 也不要用外接圆近似：它会把「实际不重叠」判成重叠（假失败）。
  const rects = [
    ...lay.tarns.map((t) => ({
      kind: 'tarn', id: t.variant, cx: t.ring * Math.cos(t.ang), cz: t.ring * Math.sin(t.ang),
      halfX: t.halfX, halfZ: t.halfZ,
    })),
    ...lay.decos.map((d) => ({
      kind: d.kind, id: d.variant, cx: d.ring * Math.cos(d.ang), cz: d.ring * Math.sin(d.ang),
      halfX: d.halfX, halfZ: d.halfZ,
    })),
  ];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      assertTrue(aabbGap(rects[i], rects[j]) > 0,
        `${rects[i].kind}/${rects[i].id} 与 ${rects[j].kind}/${rects[j].id} 重叠`);
    }
  }
});

test('地带布局：4 朵巨型云，且全在地带圆内', () => {
  const { rx, rz } = findTarnRegion(SEED);
  const lay = computeTarnZone(rx, rz, SEED);
  assertEqual(lay.clouds.length, 4, '云数');
  for (const c of lay.clouds) {
    assertTrue(c.ring <= TARN_ZONE_RADIUS, `云环半径 ${c.ring} 超出地带半径`);
  }
});
```

- [ ] **Step 6: 跑测试确认失败**

预期：**FAIL**，`computeTarnZone is not a function`。

- [ ] **Step 7: 实现环形布局 `computeTarnZone()`**

实现要点（算法见 spec §2.6 / DR-7 / DR-8；下面的常量关系是实现必须满足的，代码结构自定）：

1. 读 `KIT_METRICS`，**只取 `TARN_KEPT_TARN_IDS` 里的 8 座**的 `{width,height,depth}`；
   **轴对齐半宽**：`halfX = width/2`、`halfZ = depth/2`（世界 X/Z 轴，与环上角度无关）。
   ⚠️ **不要算 `radialHalf`/`tangentialHalf`，也不要给高台定 `orientation`** ——
   那是「长边切向朝心」旋转假设的残留，已被 spec DR-7 致命 1′ 否决（轴对齐摆放、不旋转）。
2. 按 `max(halfX, halfZ)` 降序排序。

3. **环半径 = `TARN_RING_RADIUS`（= 58，实测标定）**。
   ⚠️ **不要写成 `TARN_POOL_RADIUS − max(half) − 4` 这类公式** —— 轴对齐下最远角与 θ 有关，
   没有闭式解。58 是对定稿组合穷举实测出的「四角全部落池内」上限（59 起 L3 出池）。

4. **每座按角向半宽占角**：`占角 = 2·asin(max(halfX, halfZ) / ringR)`（**没有** `gap/2` 项），
   累加得每座中心角。⚠️ 这只是**排序用的保守角向度量**，不是真实 AABB 占地；
   真实间距由 `aabbGap` 单独算。

5. **剩余角度均分给 8 个缝**：
   `gapAngle = (2π − Σ占角) / 高台数`。
   抖动：`jit = (rand(i) - 0.5) * 2 * jitterMax`，**统一减去均值**（零和，保证 Σ缝角守恒）。

   ⚠️⚠️ **`jitterMax` 必须由「AABB 真实间距仍 ≥ TARN_GAP」二分求出，不能写 `gapAngle/2`。**
   实测定稿组合：`gapAngle/2` = 7.62° → 300 次抽样相邻高台**直接重叠**（距离为负）；
   二分出的 `jmMax` = **0.71°**，× 0.8 = **0.57°** → 最坏 AABB 间距 **4.21 ≥ 4 → PASS**。
   实现时写成一个小循环二分，**不要把 0.57 写死**（改池半径或组合就失效）。

   ⚠️ 间距的**唯一口径**：`aabbGap`（轴对齐 AABB 真实最短距离）。定稿实测无抖动 **5.05**、
   抖动后最坏 **4.21**。历史文档里的 10.87 / 16.08 / 18.40 都是旋转假设下的旧口径，**全部作废**。

6. 拱洞：5 个，放**池外台地环带**（spec DR-8），中线半径 **125**，5 个等角位 + 抖动，
   轴对齐摆放。⚠️ **不要往高台之间的缝里塞**（真实间距只有 ~5 格，最宽拱洞 19 格）。
   断言：逐角算最近角 > 池半径 90、最远角 < 地带半径 160（实测 111.66 / 138.94）。

7. 紫晶柱：7 个，放**池内中心空地**，内环半径 **20**（实测标定），7 个等角位 + 抖动，轴对齐摆放。
   ⚠️ **不要用原公式 `max(12, ringR − max(half) − 30)`** —— 它在 ringR=58 下算出 12，
   而实测内环 12 时 7 个紫晶柱**互相重叠 3 对**（最小距 −1.86）。内环 20 是穷举实测的安全值
   （互不重叠、最小距 2.14；vs 高台最小距 4.53）。⚠️ **上界是 24**（26 起撞高台），
   调大前必须重跑 spec DR-8 那张表。

8. 巨型云：从 12 个云变体里按格数降序取**前 6 大**，用
   `seededRandom(regionX, regionZ, seed + TARN_CLOUD_SALT)` 决定起点后顺序取 4 个；
   环半径 = `TARN_ZONE_RADIUS * 0.6`，角度与高台环错开 `π/11`。

- [ ] **Step 8: 跑测试确认全部通过**

预期：本文件全部用例 **PASS**。

若「AABB 间距 >= TARN_GAP」失败 → 抖动钳制没写对（回 Step 7 第 5 点）。
若「四角落池内」失败 → ringR 不是 58，或用了错误的 reach 公式（回 Step 7 第 3 点）。
若「装饰件不与高台重叠」失败 → 紫晶柱内环不是 20，或拱洞被塞进了缝里。

- [ ] **Step 9: Commit**

```bash
git add src/gen/structures/tarn-zone.js src/tests/test-tarn-zone.js src/tests/index.html
git commit -m "feat(gen): 高台地带判定与环形布局（8 座高台 + 12 装饰件 + 4 朵云）"
```

---

## Task 3: 地带 region 压制地标 + 雪原让路

**Files:**
- Modify: `src/gen/structures/structure-layout.js`
- Modify: `src/gen/structures/landmarks.js`（雪原让路判据）
- Test: `src/tests/test-tarn-zone.js`（追加）

**Interfaces:**
- Consumes: `isTarnZone`、`computeTarnZone` 从 `./tarn-zone.js`
- Produces: `computeRegionLayout()` 的返回值新增字段 `tarn: TarnLayout|null`；地带 region 的
  `pyramid/frozenMountain/plainLand/island/city/giantPyramid` 全为 `null`（⚠️ **`snowLand` 除外**：
  字段保留中心坐标，让路发生在 `apply.js` 阶段 1 跳过 `generateSnowLand`，见 Step 5-8），
  `sky.skyIslands` 为空 `Int32Array`、`sky.cloudClusters` **保留**，`scatter.*` 与 `giantTrees.*` 全空

- [ ] **Step 1: 写失败测试（镇压地标 + 空岛清空 + 云保留 + 地带外零回归）**

追加到 `src/tests/test-tarn-zone.js`：

```javascript
import { computeRegionLayout } from '../gen/structures/structure-layout.js';

test('地带 region：全部地标被压制', () => {
  const { rx, rz } = findTarnRegion(SEED);
  const l = computeRegionLayout(rx, rz, SEED);
  assertTrue(l.tarn !== null, 'layout.tarn 必须有值');
  for (const k of ['pyramid', 'frozenMountain', 'plainLand', 'island', 'city', 'giantPyramid', 'mesa']) {
    assertEqual(l[k], null, `地带 region 的 ${k} 必须是 null`);
  }
  // ⚠️ **snowLand 不在此列**（A4）：它有 6 处既有消费方（pointContext / apply 阶段 1 /
  // 三个既有测试），字段必须保留中心坐标；让路在 apply.js 阶段 1 跳过 generateSnowLand，
  // 由 snowLandSuppressedByTarn() + 接线用例钉住（见 Step 5-8）。
});

test('地带 region：空岛清空但云簇保留（用户要求「原有云朵可以渲染」）', () => {
  const { rx, rz } = findTarnRegion(SEED);
  const l = computeRegionLayout(rx, rz, SEED);
  assertEqual(l.sky.skyIslands.length, 0, '地带上空不放空岛');
  assertTrue(l.sky.cloudClusters.length > 0, '云簇必须保留');
});

test('地带 region：撒布与巨树候选为空', () => {
  const { rx, rz } = findTarnRegion(SEED);
  const l = computeRegionLayout(rx, rz, SEED);
  assertEqual(l.scatter.cityScatter.length, 0, 'cityScatter');
  assertEqual(l.scatter.outsideScatter.length, 0, 'outsideScatter');
  assertEqual(l.giantTrees.forest.length, 0, 'forest');
  assertEqual(l.giantTrees.beach.length, 0, 'beach');
  assertEqual(l.giantTrees.banyan.length, 0, 'banyan');
});

test('非地带 region：layout 与改动前逐字段相同（零回归）', () => {
  // ⚠️ **口径必须收窄**（B9 / spec C4）：零回归只覆盖「非地带 region **且**其雪原未被
  // 地带让路波及」的那些。被让路的雪原虽然在地带外，但按 DR-6 是**有意**消失的。
  let found = null;
  for (let rx = -6; rx <= 6 && !found; rx++) for (let rz = -6; rz <= 6; rz++) {
    if (isTarnZone(rx, rz, SEED)) continue;
    if (snowLandSuppressedByTarn(rx, rz, SEED)) continue;   // 跳过让路波及区
    found = { rx, rz };
  }
  assertTrue(found !== null, '必须存在「非地带且雪原未被波及」的 region');
  const l = computeRegionLayout(found.rx, found.rz, SEED);
  assertEqual(l.tarn, null, '非地带 region 的 tarn 必须是 null');
  assertTrue(l.pyramid !== null, '非地带 region 的 pyramid 照常有值');
  assertTrue(l.frozenMountain !== null, '非地带 region 的 frozenMountain 照常有值');
  assertTrue(l.snowLand !== null, '未被波及的 region 的 snowLand 字段照常保留（A4）');
});
```

- [ ] **Step 2: 跑测试确认失败**

预期：**FAIL**，`l.tarn` 是 `undefined`（字段还不存在）。

- [ ] **Step 3: 在 `structure-layout.js` 里接线**

`computeRegionLayout` 的改动（要点，结构照现有风格）：

1. 顶部 `import { isTarnZone, computeTarnZone } from './tarn-zone.js';`
2. 在算各字段**之前**先算地带：
   ```javascript
   const tarn = isTarnZone(regionX, regionZ, seed) ? computeTarnZone(regionX, regionZ, seed) : null;
   ```
3. 每个字段按 `tarn` 压制。**必须用「`tarn ? null : 原值`」的形式**，不要改变原表达式的求值顺序（那是零回归的保证）：
   - `pyramid`、`frozenMountain`、`plainLand`、`island`、`city`、`giantPyramid` → `tarn ? null : <原值>`
   - ⚠️ **`snowLand` 不在此列**（A4）：它有 6 处既有消费方（`pointContext` / `apply` 阶段 1 /
     `test-structure-layout.js` / `test-landmarks.js` / `test-giant-trees-gen.js`），置 `null`
     会让它们当场崩。**字段照常保留**，让路在 `apply.js` 阶段 1 跳过 `generateSnowLand`（Step 5-8）。
   - `sky`：`tarn ? { skyIslands: new Int32Array(0), cloudClusters: computeSkyCandidates(...).cloudClusters } : computeSkyCandidates(...)`
     ⚠️ **不要算式调用两次**：先 `const skyFull = computeSkyCandidates(regionX, regionZ, seed);` 再取用。
   - `scatter`：`tarn ? { cityScatter: new Int32Array(0), outsideScatter: new Int32Array(0) } : computeScatterCandidates(...)`
   - `giantTrees`：`tarn ? { forest: new Int32Array(0), beach: new Int32Array(0), banyan: new Int32Array(0) } : computeGiantTreeCandidates(...)`
   - `mesa`：本任务先保留原调用（Task 9 才删）
4. 返回值加 `tarn`。

- [ ] **Step 4: 跑测试确认通过**

预期：`test-tarn-zone.js` 全部 PASS。

- [ ] **Step 5: 写失败的雪原让路测试（落点是 `apply.js`，不是 layout）**

⚠️ **A4 修正：让路必须落在 `apply.js` 阶段 1 的 elif 链，不能在 layout 层把
`layout.snowLand` 置 `null`。** `layout.snowLand` 有 6 处既有消费者，置 null 会让它们
当场崩：`apply.js:102`（`pointContext`）、`apply.js:238`（地形整形 elif 链）、
`test-structure-layout.js:71/73/122-133`、`test-landmarks.js:59/124`、
`test-giant-trees-gen.js:171/182`。

⇒ **layout 字段照常保留**（"雪原中心在哪"是 region 的固有属性），只让**生成**跳过它。

先写判据的纯函数测试（判据本身可单测，与落点无关）：

```javascript
// 追加 import（test-tarn-zone.js 顶部已有的 import 之后）
import { snowLandSuppressedByTarn } from '../gen/structures/tarn-zone.js';
import { SNOW_LAND_SIZE, TRANSITION_SIZE, LANDMARK_OFFSET } from '../gen/structures/region-config.js';
import { getRegionSeededCenter } from '../gen/structures/region-center.js';
import { buildDefaultRegistry } from '../voxel/block-registry.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { fillColumn } from '../gen/terrain.js';
import { applyStructuresToColumn } from '../gen/structures/apply.js';

test('雪原让路判据：与地带圆相交的 region 判 true', () => {
  const snowR = SNOW_LAND_SIZE / 2 + TRANSITION_SIZE.SNOW_LAND;
  let dropped = 0, kept = 0;
  for (let rx = -6; rx <= 6; rx++) for (let rz = -6; rz <= 6; rz++) {
    const raw = getRegionSeededCenter(rx, rz, SEED);
    const sx = raw.centerX + LANDMARK_OFFSET.SNOW_LAND_X;
    const sz = raw.centerZ + LANDMARK_OFFSET.SNOW_LAND_Z;
    const suppressed = snowLandSuppressedByTarn(rx, rz, SEED);
    // 交叉验证：手工算一遍期望值
    let expect = false;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      if (!isTarnZone(rx + dx, rz + dz, SEED)) continue;
      const c = tarnZoneCenter(rx + dx, rz + dz);
      if (Math.hypot(sx - c.cx, sz - c.cz) < snowR + TARN_ZONE_RADIUS) expect = true;
    }
    assertEqual(suppressed, expect, `region(${rx},${rz}) 让路判据`);
    if (suppressed) dropped++; else kept++;
  }
  assertTrue(dropped > 0, '必须有被让路的雪原（否则判据没生效）');
  assertTrue(kept > 0, '也必须有保留的雪原（否则让路过头）');
});
```

再写**接线**测试（真正钉住「apply 阶段 1 跳过了 generateSnowLand」）：

```javascript
/** 找一个「雪原被让路」的 region（确定性搜索） */
function findSuppressedSnowRegion(seed) {
  for (let rx = -6; rx <= 6; rx++) for (let rz = -6; rz <= 6; rz++) {
    if (snowLandSuppressedByTarn(rx, rz, seed)) return { rx, rz };
  }
  return null;
}

test('雪原让路接线：被让路的 region 里没有雪原方块', async () => {
  const reg = await buildDefaultRegistry();
  const snowGrass = reg.idOf('snow_grass');
  const target = findSuppressedSnowRegion(SEED);
  assertTrue(target !== null, '必须存在被让路的雪原 region（否则用例无判别力）');
  const layouts = [computeRegionLayout(target.rx, target.rz, SEED)];
  const raw = getRegionSeededCenter(target.rx, target.rz, SEED);
  const cx = Math.floor((raw.centerX + LANDMARK_OFFSET.SNOW_LAND_X) / 16);
  const cz = Math.floor((raw.centerZ + LANDMARK_OFFSET.SNOW_LAND_Z) / 16);
  const col = new ChunkColumn(cx, cz);
  fillColumn(col, SEED, reg);
  await applyStructuresToColumn(col, SEED, reg, layouts);
  let snowHits = 0;
  for (const id of col.blocks) if (id === snowGrass) snowHits++;
  assertEqual(snowHits, 0, '被让路的雪原不得写出 snow_grass');
});
```

- [ ] **Step 6: 跑测试确认失败**

预期：**FAIL**，`snowLandSuppressedByTarn is not a function`。

- [ ] **Step 7: 在 `tarn-zone.js` 实现判据、在 `apply.js` 接跳过**

`tarn-zone.js` 里加（**纯函数，只 import 已有的常量**）：

```javascript
/**
 * 本 region 的雪原是否应被地带让路（spec DR-6 / A4）。
 *
 * ⚠️ **只用作判据，不要拿它去把 `layout.snowLand` 置 null** —— 那个字段有 6 处既有消费方
 * （pointContext / apply 阶段 1 / 三个既有测试）。让路发生在 `apply.js` 阶段 1 的 elif 链：
 * 命中本判据就**跳过 generateSnowLand**（与城市/金字塔等既有「分支跳过」同构）。
 *
 * 物理原因：雪原中心 = 邻 region 的 seededCenter + 偏移(160,0)，而 seededCenter 在 region 内
 * 随机 → 雪原圆可以伸进邻 region 144 格（实测最近仅 16 格）。不处理会压进地带的水池。
 */
export function snowLandSuppressedByTarn(regionX, regionZ, seed) { /* ... */ }
```

`apply.js` 阶段 1 的 elif 链里，`getSnowLandInfo` 命中后加一道门：

```javascript
        const slInfo = getSnowLandInfo(wx, wz, layout.snowLand, seed);
        if (slInfo) {
          // 地带让路：本 region 的雪原若与邻域地带圆相交，则整片不生成（spec DR-6 / A4）
          if (!snowLandSuppressedByTarn(layout.regionX, layout.regionZ, seed)) {
            generateSnowLand(wx, wz, h, slInfo, setBlock, seed);
          }
          handled = true;
          break;
        }
```

⚠️ **`handled = true` 必须无条件设置**（即使跳过了生成）—— 否则 elif 链会继续往下走到
冰封山分支，让雪原占地里长出冰封山。

- [ ] **Step 8: 跑测试确认通过**

预期：两条 PASS。

- [ ] **Step 9: Commit**

```bash
git add src/gen/structures/structure-layout.js src/gen/structures/landmarks.js src/tests/test-tarn-zone.js
git commit -m "feat(gen): 地带 region 压制地标 + 雪原让路"
```

---

## Task 4: 台地整形（草石镶嵌 + 水池）

**Files:**
- Create: `src/gen/structures/tarn-terrain.js`
- Create: `src/tests/test-tarn-terrain.js`
- Modify: `src/tests/index.html`（注册 `test-tarn-terrain.js`）

**Interfaces:**
- Consumes: `noise` 从 `../noise.js`；`blockIndex` 从 `../../voxel/constants.js`；`makeColumnSetter` 从 `./landmarks.js`
- Produces:
  - `TARN_TERRAIN_SALT = 1022`
  - `fillTarnPlateau(column, layout: TarnLayout, seed: number, registry): void`
    —— 直接写 `column.blocks`（生成路径，不走 `set()`），把地带圆内的台地压平到 `layout.plateauY`、
    池内下沉 1 格并填 1 层 `water`
  - `tarnSurfaceBlock(wx, wz, seed): 'grass'|'stone'` —— 草石镶嵌的唯一权威（单测直接用）

- [ ] **Step 1: 写失败测试（高度恒定 + 池底 + 1 层水 + 镶嵌两种都有）**

阶层的定义（Task 5 与 Task 6 都要用同一个口径，实现时不要各推一遍）：

| y | 内容 |
|---|---|
| `plateauY - 1` | 池底实心（`stone`）—— 玩家站在它上面时 `pos.y = plateauY` |
| `plateauY` | **池内**是 `water`；**池外台地**是 `tarnSurfaceBlock`（grass/stone）的地表方块；高台与紫晶柱的**最低层**也在这里（坐在池底上） |
| `plateauY + 1` 以上 | 池内是空气；**拱洞的最低层在这里**（它站在台地地表 `plateauY` 之上，DR-8） |
| 水面平面 | `plateauY + 0.5`（体素水的 `WATER_SURFACE_SINK` 口径） |

⚠️ **拱洞与高台/紫晶柱的 y 口径不同**（DR-8 把拱洞移到了池外台地）：高台与紫晶柱在**池内**，
最低层落 `plateauY`（= 水那一层，坐在池底上）；拱洞在**池外台地**，地表方块已占 `plateauY`，
故最低层要落 `plateauY + 1`。Task 5 Step 4 按 `d.kind` 分流，**不要给两者传同一个 y**。

```javascript
// src/tests/test-tarn-terrain.js — 高台地带台地整形 Tier 1
//
// 钉的是「台地看起来像台地」的四个不可让步的事实：高度恒定、池底在台地下一格、
// 池内恰有 1 层水、草石镶嵌两种方块都出现。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { computeTarnZone, isTarnZone } from '../gen/structures/tarn-zone.js';
import { fillTarnPlateau, tarnSurfaceBlock, TARN_TERRAIN_SALT } from '../gen/structures/tarn-terrain.js';
import { buildDefaultRegistry } from '../voxel/block-registry.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { blockIndex } from '../voxel/constants.js';
import { fillColumn } from '../gen/terrain.js';   // B5：整形/光栅化测试的前置（真实路径是 fillColumn → apply）

const SEED = 12345;

function findTarnRegion() {
  for (let rx = -6; rx <= 6; rx++) for (let rz = -6; rz <= 6; rz++) {
    if (isTarnZone(rx, rz, SEED)) return { rx, rz };
  }
  throw new Error('没找到地带 region');
}

test('台地：同一坐标两次调用表面方块相同（确定性）', () => {
  for (const [wx, wz] of [[100, 100], [-40, 77], [0, 0]]) {
    assertEqual(tarnSurfaceBlock(wx, wz, SEED), tarnSurfaceBlock(wx, wz, SEED), `(${wx},${wz}) 稳定`);
  }
});

test('台地：草石镶嵌两种方块都出现（不是清一色）', () => {
  const kinds = new Set();
  for (let wz = -150; wz <= 150; wz += 3) for (let wx = -150; wx <= 150; wx += 3) {
    kinds.add(tarnSurfaceBlock(wx, wz, SEED));
  }
  assertEqual(kinds.size, 2, `镶嵌必须产生 2 种方块，实际 ${[...kinds].join(',')}`);
});

test('台地：高度恒定（台地范围内地表高差 = 0）', async () => {
  const { rx, rz } = findTarnRegion();
  const lay = computeTarnZone(rx, rz, SEED);
  const reg = await buildDefaultRegistry();
  const heights = new Set();
  // 采样台地环带（池外、地带内）
  for (let a = 0; a < 32; a++) {
    const ang = (a / 32) * Math.PI * 2;
    for (const r of [lay.poolRadius + 6, lay.poolRadius + 20, lay.plateauRadius - 6]) {
      const wx = Math.round(lay.cx + r * Math.cos(ang));
      const wz = Math.round(lay.cz + r * Math.sin(ang));
      const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
      const col = new ChunkColumn(cx, cz);
      // ⚠️ **必须先 fillColumn 再整形**（B5）：空 column 上「削平原山」平凡通过，
      //    注入「忘了削山」的缺陷测不出来（既有手法见 test-giant-trees-gen.js:51）。
      fillColumn(col, SEED, reg);
      fillTarnPlateau(col, lay, SEED, reg);
      // 找该列最高的非空气方块
      let top = null;
      for (let y = 90; y >= -30; y--) {
        const id = col.blocks[blockIndex(wx - cx * 16, y, wz - cz * 16)];
        if (id !== 0) { top = y; break; }
      }
      if (top !== null) heights.add(top);
    }
  }
  assertEqual(heights.size, 1, `台地各采样点高度必须全相等，实际 ${[...heights].join(',')}`);
});

test('台地：池内恰有 1 层水体，池底在台地下一格', async () => {
  const { rx, rz } = findTarnRegion();
  const lay = computeTarnZone(rx, rz, SEED);
  const reg = await buildDefaultRegistry();
  const waterId = reg.idOf('water');
  const col = new ChunkColumn(Math.floor(lay.cx / 16), Math.floor(lay.cz / 16));
  fillColumn(col, SEED, reg);          // B5：先铺自然地层，整形才有「削/填」可言
  fillTarnPlateau(col, lay, SEED, reg);
  const lx = lay.cx - col.cx * 16, lz = lay.cz - col.cz * 16;
  // 从下往上数水格
  let waterLayers = 0, lastWaterY = null;
  for (let y = -30; y <= 90; y++) {
    if (col.blocks[blockIndex(lx, y, lz)] === waterId) { waterLayers++; lastWaterY = y; }
  }
  assertEqual(waterLayers, 1, '池心必须恰有 1 层水');
  // 水面之上是空气
  assertEqual(col.blocks[blockIndex(lx, lastWaterY + 1, lz)], 0, '水面上方必须是空气');
});
```

- [ ] **Step 2: 跑测试确认失败**

预期：**FAIL**，`Cannot find module '../gen/structures/tarn-terrain.js'`。

- [ ] **Step 3: 实现 `tarn-terrain.js`**

实现要点：

1. `plateauY` 的计算放进 `computeTarnZone()`（Task 2 补一个字段）：
   `plateauY = SEA_Y + 4`（= 2）。spec §4 实测「台地 y=2 → 高台顶最高 y=49 → 巨型云从 y≥56 开始」，
   且 `WORLD_MAX_Y = 96` 有充足余量。
2. `tarnSurfaceBlock(wx, wz, seed)`：用**低频噪声**做「成片」镶嵌（不是逐格随机 —— 逐格会读成花屏，spec DR-9）：
   `noise(wx, wz, seed + TARN_TERRAIN_SALT, 相同 scale) > 0` → `'grass'`，否则 `'stone'`。
   scale 取 `0.08`（与 `TERRAIN_HEIGHT_PARAMS.COARSE_SCALE` 同量级，每片约 8~16 格），
   **从 `terrain.js` import，不要写字面量**（红线 1）。
3. `fillTarnPlateau(column, layout, seed, registry)`：对本 column 的 16×16 列循环，
   只处理落在 `layout.plateauRadius` 圆内的格：
   - `dist <= poolRadius`：池底 = `plateauY - 1`（**下沉一格**），材质 `'stone'`；
     从 `plateauY - 1` 往填到 `WORLD_MIN_Y + 1` 全是 `'stone'`；`plateauY` 那层填 `water`；
     之上清空（不写 = 保持 fillColumn 的结果 → **必须显式置 0**，因为 `fillColumn` 已填过地形）。
   - `poolRadius < dist <= plateauRadius`：地表 = `plateauY`，材质 `tarnSurfaceBlock(...)`；
     往下填 `'stone'`；**高于 `plateauY` 的格必须显式置 0**（削平原来的山）。
   - 圆外：不动。

⚠️ **`fillTarnPlateau` 必须在 `fillColumn` 之后、结构光栅化之前调用**，且**不要**记 edits、不要 bump version
（生成路径同 `fillColumn`）。

⚠️ **高于 `plateauY` 的格必须显式写 0**：`fillColumn` 已按自然地形填过整个 column，
不清掉就会在台地上方留下原来的山体（台地“长”在山里）。

- [ ] **Step 4: 跑测试确认通过**

预期：4 条全 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/gen/structures/tarn-terrain.js src/tests/test-tarn-terrain.js src/tests/index.html
git commit -m "feat(gen): 高台地带台地整形（草石镶嵌 + 1 层水池）"
```

---

## Task 5: `structure-json.js` 接线 + `apply.js` 阶段 2.4

**Files:**
- Modify: `src/gen/structures/structure-json.js`
- Modify: `src/gen/structures/apply.js`
- Create: `src/tests/test-tarn-zone-gen.js`
- Modify: `src/tests/index.html`

**Interfaces:**
- Consumes: `computeTarnZone`、`KIT_VARIANTS`；`fillTarnPlateau`（Task 4）
- Produces: `apply.js` 的阶段 2.4 把台地、8 座高台、12 个装饰件写进 column；
  `pointContext()` 对地带圆内返回 `{ kind: 'tarn' }`

- [ ] **Step 1: 写失败的接线测试（8+5+7 个变体都真的进了世界）**

```javascript
// src/tests/test-tarn-zone-gen.js — 高台地带接线 Tier 1：layout 携带 + 真实 column GEN
//
// 钉的是「接线断了但纯函数全绿」这类缺陷（M7 教训）：
//   · structure-json 漏一个变体的映射 → rasterizeStructure 拿到空 blocks 直接 return
//     → 那个变体静默不出现（35 个里漏一个，肉眼几乎看不出）
//   · 阶段 2.4 的层序错了 → 高台被台地整形覆盖掉，只剩一圈平地
//   · pointContext 没加 kind:'tarn' → 地带台地上长满树
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { computeRegionLayout } from '../gen/structures/structure-layout.js';
import { isTarnZone } from '../gen/structures/tarn-zone.js';
import { applyStructuresToColumn } from '../gen/structures/apply.js';
import { KIT_VARIANTS } from '../gen/structures/cloudland-kit-data.js';
// ⚠️ **不要 import `tools/cloudland-kit-fingerprint.mjs`**（严重 8）：它依赖 `node:fs`，
//    浏览器单测解析它会失败 → 整个测试文件不运行。纯数据从 cloudland-kit-data.js 来。
import { buildDefaultRegistry } from '../voxel/block-registry.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { blockIndex } from '../voxel/constants.js';
import { fillColumn } from '../gen/terrain.js';   // B5：整形/光栅化测试的前置（真实路径是 fillColumn → apply）

const SEED = 12345;

function findTarnRegion() {
  for (let rx = -6; rx <= 6; rx++) for (let rz = -6; rz <= 6; rz++) {
    if (isTarnZone(rx, rz, SEED)) return { rx, rz };
  }
  throw new Error('没找到地带 region');
}

/** 收集地带圆内某 y 层的所有方块 id */
async function collectLayer(lay, y) {
  const reg = await buildDefaultRegistry();
  const ids = new Set();
  const layouts = [computeRegionLayout(lay.regionX, lay.regionZ, SEED)];
  const rCols = Math.ceil(lay.plateauRadius / 16) + 1;
  const ccx = Math.floor(lay.cx / 16), ccz = Math.floor(lay.cz / 16);
  for (let dcx = -rCols; dcx <= rCols; dcx++) for (let dcz = -rCols; dcz <= rCols; dcz++) {
    const col = new ChunkColumn(ccx + dcx, ccz + dcz);
    fillColumn(col, SEED, reg);   // B5：真实路径是 fillColumn → apply，空 column 会让断言平凡通过
    await applyStructuresToColumn(col, SEED, reg, layouts);
    for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
      const wx = col.cx * 16 + lx, wz = col.cz * 16 + lz;
      if (Math.hypot(wx - lay.cx, wz - lay.cz) > lay.plateauRadius) continue;
      const id = col.blocks[blockIndex(lx, y, lz)];
      if (id !== 0) ids.add(id);
    }
  }
  return ids;
}

test('地带接线：layout 的 tarn 与 computeTarnZone 一致', () => {
  const { rx, rz } = findTarnRegion();
  const l = computeRegionLayout(rx, rz, SEED);
  assertTrue(l.tarn !== null, 'layout.tarn 有值');
  assertEqual(l.tarn.tarns.length, 8, '8 座');
});

test('地带接线：台地高度那一层出现了 grass 与 stone', async () => {
  const { rx, rz } = findTarnRegion();
  const lay = { ...computeRegionLayout(rx, rz, SEED).tarn, regionX: rx, regionZ: rz };
  const reg = await buildDefaultRegistry();
  const ids = await collectLayer(lay, lay.plateauY);
  const names = [...ids].map((id) => reg.nameOf(id));
  assertTrue(names.includes('grass'), `台地层必须有 grass，实际 ${names.join(',')}`);
  assertTrue(names.includes('stone'), `台地层必须有 stone，实际 ${names.join(',')}`);
});

test('地带接线：水池层出现 water', async () => {
  const { rx, rz } = findTarnRegion();
  const lay = { ...computeRegionLayout(rx, rz, SEED).tarn, regionX: rx, regionZ: rz };
  const reg = await buildDefaultRegistry();
  const ids = await collectLayer(lay, lay.plateauY);
  const names = [...ids].map((id) => reg.nameOf(id));
  assertTrue(names.includes('water'), `水池那层必须有 water，实际 ${names.join(',')}`);
});

test('地带接线：地带 region 内不出现空岛方块', async () => {
  const { rx, rz } = findTarnRegion();
  const lay = { ...computeRegionLayout(rx, rz, SEED).tarn, regionX: rx, regionZ: rz };
  const reg = await buildDefaultRegistry();
  // 扫描地带圆内全部 16 列的高空段，断言没有 sky_stone / sky_grass
  const skyStone = reg.idOf('sky_stone'), skyGrass = reg.idOf('sky_grass');
  const ccx = Math.floor(lay.cx / 16), ccz = Math.floor(lay.cz / 16);
  const rCols = Math.ceil(lay.plateauRadius / 16) + 1;
  const layouts = [computeRegionLayout(rx, rz, SEED)];
  let skyHits = 0;
  for (let dcx = -rCols; dcx <= rCols; dcx++) for (let dcz = -rCols; dcz <= rCols; dcz++) {
    const col = new ChunkColumn(ccx + dcx, ccz + dcz);
    fillColumn(col, SEED, reg);   // B5：同上
    await applyStructuresToColumn(col, SEED, reg, layouts);
    for (let i = 0; i < col.blocks.length; i++) {
      if (col.blocks[i] === skyStone || col.blocks[i] === skyGrass) skyHits++;
    }
  }
  assertEqual(skyHits, 0, '地带上空不得有空岛方块');
});
```

- [ ] **Step 2: 跑测试确认失败**

预期：**FAIL**（阶段 2.4 还不存在，台地层是自然地形）。

- [ ] **Step 3: 在 `structure-json.js` 登记 35 个变体**

在 `STRUCTURE_FILES` 里加（基名与 Task 1 的产物文件名一致）：

```javascript
  // 高台地带（Cloudland Tarn Zone）：11 座高台 + 5 拱洞 + 7 紫晶柱 + 12 巨型云
  // ⚠️ 不要手写这 35 行清单 —— 从 KIT_VARIANTS 派生（红线 1：加第 12 座时不用改两处）。
```

实现方式：在文件顶部 `import { KIT_VARIANTS } from '../cloudland-kit-data.js';`
⚠️ **不要 import `tools/cloudland-kit-fingerprint.mjs`** —— 它依赖 `node:fs`，在 Worker 里解析失败 →
**Worker 启动不了 → 游戏白屏**（B1）。
然后

```javascript
for (const base of [...KIT_VARIANTS.tarn, ...KIT_VARIANTS.arch, ...KIT_VARIANTS.spire, ...KIT_VARIANTS.giantCloud]) {
  STRUCTURE_FILES[base] = `${base}.json`;
}
```

⚠️ `STRUCTURE_FILES` 是 `Object.freeze({...})`，要改成先构造对象再 freeze。

⚠️ **`tools/` 下的模块被 `src/` import 是否违反依赖方向？** 不违反：`check-architecture.mjs` 只
约束 `src/` 内部方向；`tools/*-fingerprint.mjs` 已被 `check-data.mjs` 与多处烘焙脚本共用，
这里额外被 `src/gen` import 是同一份数据的消费方（红线 1）。**跑 `npm run check:arch` 验证**。

- [ ] **Step 4: 在 `apply.js` 加阶段 2.4**

插入位置：**阶段 1（地形整形）之后、阶段 2（JSON 结构光栅化）之前** ——
因为阶段 1 的 `fillColumn` 原始地层要被台地整形覆盖，而阶段 2 的城市结构不该写进地带（地带已压制城市）。

```javascript
  // ---- 阶段 2.4：高台地带（Cloudland Tarn Zone）----
  // 层序理由：台地整形必须在 fillColumn 之后（覆盖原始地层）。高台与装饰件在台地之后写（后写胜）。
  //
  // ⚠️ **y 参数是 plateauY，不是 plateauY + 1**（易错一格）：
  //   · 池底实心在 `plateauY - 1`、水在 `plateauY`；
  //   · `rasterizeStructure(type, x, y, z, ...)` 把**最低那层写成 y**（内部是 `y + b.y - 1`，
  //     而产物已把最低点归一化为 b.y = 1）；
  //   · 故 `y = plateauY` ⇒ 台基最低层正好落在水那一层、坐在池底上（台体占掉它自己的水格）。
  //   传 `plateauY + 1` 会让整座高台**悬在水面上方一格**（区块层面看不出，只是台子浮在水上）。
  const tarnLayout = layouts.map((l) => l.tarn).find(Boolean) || null;
  if (tarnLayout) {
    fillTarnPlateau(column, tarnLayout, seed, registry);
    // 8 座高台（TARN_KEPT_TARN_IDS；烘焙有 11 个产物，运行时只用 8 座）
    for (const t of tarnLayout.tarns) {
      const wx = Math.round(tarnLayout.cx + t.ring * Math.cos(t.ang));
      const wz = Math.round(tarnLayout.cz + t.ring * Math.sin(t.ang));
      // ⚠️ **轴对齐摆放下 AABB 半宽就是 halfX / halfZ 本身**（spec DR-7 方案 1，不旋转）。
      //    不要写成 `halfX + halfZ`（那是旋转假设下的保守投影，轴对齐下会把裁剪框撑大一倍，
      //    白跑很多 column）；也不要传已不存在的 `tangentialHalf`/`radialHalf`。
      if (!placementIntersects({ x: wx, z: wz }, t.halfX, t.halfZ, column.cx, column.cz)) continue;
      // ⚠️ **`rasterizeStructure` 签名不动**（无 orientation 参数）—— 方案 1 不新增旋转机制。
      rasterizeStructure(t.variant, wx, tarnLayout.plateauY, wz, setBlock, column, registry, seed, false);
    }
    // 12 个装饰件：⚠️ **拱洞与紫晶柱的 y 口径不同**（DR-8 把拱洞移到了池外台地）：
    //   · 紫晶柱在**池内** → 最低层落在 `plateauY`（= 水那一层），坐在池底 `plateauY - 1` 上；
    //   · 拱洞在**池外台地** → 台地地表方块就在 `plateauY`，故最低层要落在 `plateauY + 1`
    //     （坐在地表之上）。传 `plateauY` 会把拱洞最底下一层**埋进台地地表**。
    for (const d of tarnLayout.decos) {
      const wx = Math.round(tarnLayout.cx + d.ring * Math.cos(d.ang));
      const wz = Math.round(tarnLayout.cz + d.ring * Math.sin(d.ang));
      if (!placementIntersects({ x: wx, z: wz }, d.halfX, d.halfZ, column.cx, column.cz)) continue;
      const dy = d.kind === 'arch' ? tarnLayout.plateauY + 1 : tarnLayout.plateauY;
      rasterizeStructure(d.variant, wx, dy, wz, setBlock, column, registry, seed, false);
    }
  }
```

⚠️ **不补 `groundSupport`**：台地已被整形压平，高台基座天然贴地（与巨型金字塔同口径）。

⚠️ **预载**：在函数开头的 `needTypes` 收集段加

```javascript
  if (tarnLayout) {
    // 惰性预载：只有地带 region 才拉这 35 个文件（1/3 的 region）。
    for (const base of [...KIT_VARIANTS.tarn, ...KIT_VARIANTS.arch, ...KIT_VARIANTS.spire, ...KIT_VARIANTS.giantCloud]) {
      needTypes.add(base);
    }
  }
```

并 `import { fillTarnPlateau } from './tarn-terrain.js';`。

- [ ] **Step 5: 加 `pointContext` 的 `kind: 'tarn'` 分支**

在 `pointContext` 里、**城市分支之后**（保持「城市优先级最高」的既有语义）：

```javascript
  // 高台地带：地带圆内一律视为「地带」，让路给台地/水池/高台。
  // 一个分支覆盖五个下游消费者（阶段 2.4 的让路、巨树 allowedAt、阶段 3 的树/植物、睡莲、将来的新植被路径）
  // —— 与巨型金字塔的 kind:'none' 同一手法，不要为每一处各写一份判据。
  for (const layout of layouts) {
    const t = layout.tarn;
    if (!t) continue;
    if (Math.hypot(wx - t.cx, wz - t.cz) <= t.plateauRadius) return { kind: 'tarn', surfaceY: t.plateauY };
  }
```

- [ ] **Step 6: 跑测试确认通过 + 架构门**

```bash
npm run check:arch
```

预期：`test-tarn-zone-gen.js` 4 条 PASS；`check:arch` 全绿（特别是 `[资源 URL]` 与 three 隔离）。

- [ ] **Step 7: 加巨型云写入（并入 `applySkyStructures`，不新开阶段）**

⚠️ **云必须走既有的 `applySkyStructures` 链路**（spec DR-10）：新开一个写入阶段会与
「先 Y=55 单云层 → Y=35 云簇 → 空岛」的层序打架。

在 `sky-structures.js` 加一个可选参数：`applySkyStructures(column, skyCandidates, seed, registry, tarnClouds)`，
在 `writeClouds` 之后、`writeIslands` 之前写 `tarnClouds`（`[{variant, wx, wy, wz}]`）。
`apply.js` 的调用点传入：

```javascript
  const tarnClouds = tarnLayout
    ? tarnLayout.clouds.map((c) => ({
        variant: c.variant,
        wx: Math.round(tarnLayout.cx + c.ring * Math.cos(c.ang)),
        wy: tarnLayout.plateauY + TARN_CLOUD_MIN_Y,   // 从 tarn-zone.js 导出
        wz: Math.round(tarnLayout.cz + c.ring * Math.sin(c.ang)),
      }))
    : [];
```

`TARN_CLOUD_MIN_Y` 在 `tarn-zone.js` 里定为 `54`（台地 y=2 + 高台最高 46 + 6 格间隙 = 54；
云高最大 38 → 云顶 92 ≤ `WORLD_MAX_Y` 96 ✅）。

- [ ] **Step 8: 写巨型云的失败测试并实现**

追加到 `test-tarn-zone-gen.js`：

```javascript
test('地带接线：地带上空出现巨型云方块（cloud 变体写入生效）', async () => {
  const { rx, rz } = findTarnRegion();
  const lay = { ...computeRegionLayout(rx, rz, SEED).tarn, regionX: rx, regionZ: rz };
  const reg = await buildDefaultRegistry();
  const layouts = [computeRegionLayout(rx, rz, SEED)];
  const ccx = Math.floor(lay.cx / 16), ccz = Math.floor(lay.cz / 16);
  const rCols = Math.ceil(lay.plateauRadius / 16) + 1;
  let cloudHits = 0;
  for (let dcx = -rCols; dcx <= rCols; dcx++) for (let dcz = -rCols; dcz <= rCols; dcz++) {
    const col = new ChunkColumn(ccx + dcx, ccz + dcz);
    fillColumn(col, SEED, reg);   // B5：同上
    await applyStructuresToColumn(col, SEED, reg, layouts);
    // 上界取 94：云底 54 + 云高最大 38 = 92，留 2 格余量（云块可能整体上移）
    for (let y = 50; y <= 94; y++) for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
      const wx = col.cx * 16 + lx, wz = col.cz * 16 + lz;
      if (Math.hypot(wx - lay.cx, wz - lay.cz) > lay.plateauRadius) continue;
      if (col.blocks[blockIndex(lx, y, lz)] !== 0) cloudHits++;
    }
  }
  assertTrue(cloudHits > 100, `地带上空应有巨型云方块（实测 ${cloudHits}）`);
});
```

预期 RED → 实现 → GREEN。

- [ ] **Step 9: Commit**

```bash
git add src/gen/structures/structure-json.js src/gen/structures/apply.js src/gen/structures/sky-structures.js src/gen/structures/tarn-zone.js src/tests/test-tarn-zone-gen.js src/tests/index.html
git commit -m "feat(gen): 高台地带光栅化（阶段 2.4）+ pointContext tarn + 巨型云"
```

---

## Task 6: 池面渲染（CPU/GPU 同源判据）

**Files:**
- Modify: `src/render/ocean-mask.js`
- Modify: `src/render/ocean.js`
- Create: `src/tests/test-tarn-water.js`
- Modify: `src/tests/index.html`

**Interfaces:**
- Consumes: `tarnZoneCenter`、`isTarnZone`、`TARN_POOL_RADIUS` 从 `../gen/structures/tarn-zone.js`
  ⚠️ `src/render/` 可以 import `src/gen/`（依赖方向 `voxel ← gen ← mesh ← render` 允许向上）；
  **但 `ocean.js` 是 three 专属模块，`tarn-zone.js` 是 Worker 同构模块 —— 不要在 `tarn-zone.js` 里 import three**。
- Produces:
  - `ocean-mask.js` 导出 `isPointInTarnPool(x, z, seed): boolean`
  - `ocean-mask.js` 导出 `tarnPoolAt(x, z, seed): {cx, cz, radius, waterY}|null`（GPU 侧的 uniform 源）
  - `ocean.js` 的 `setupOcean(scene)` 返回值新增 `setTarnPool(pool: {cx,cz,radius,waterY}|null): void`

- [ ] **Step 1: 写失败的 CPU 判据测试**

```javascript
// src/tests/test-tarn-water.js — 池面判据 Tier 1（CPU 版）
//
// ocean.js 的 TSL 是同构实现（GPU 求值、单测测不到）。判据的数值与几何必须与 CPU 版一致，
// 否则会漂移出「单测说池里有水、画面没有水」的撕裂（既有 ocean-mask.js 的同一教训）。
import { test } from './runner.js';
import { assertTrue, assertFalse, assertEqual } from './assert.js';
import { isPointInTarnPool, tarnPoolAt } from '../render/ocean-mask.js';
import { isTarnZone, tarnZoneCenter, computeTarnZone, TARN_POOL_RADIUS } from '../gen/structures/tarn-zone.js';
import { fillTarnPlateau } from '../gen/structures/tarn-terrain.js';
import { buildDefaultRegistry } from '../voxel/block-registry.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { blockIndex } from '../voxel/constants.js';
import { REGION_SIZE } from '../gen/structures/region-config.js';
import { fillColumn } from '../gen/terrain.js';   // B5：先铺自然地层，整形才有「削/填」可言

const SEED = 12345;

function findTarnRegion() {
  for (let rx = -6; rx <= 6; rx++) for (let rz = -6; rz <= 6; rz++) {
    if (isTarnZone(rx, rz, SEED)) return { rx, rz };
  }
  throw new Error('没找到地带 region');
}

test('池面判据：池心在内、池外一点在外', () => {
  const { rx, rz } = findTarnRegion();
  const c = tarnZoneCenter(rx, rz);
  assertTrue(isPointInTarnPool(c.cx, c.cz, SEED), '池心必须在池内');
  assertFalse(isPointInTarnPool(c.cx + TARN_POOL_RADIUS + 5, c.cz, SEED), '池外一点必须在池外');
});

test('池面判据：边界按半径精确（r-1 在内、r+1 在外）', () => {
  const { rx, rz } = findTarnRegion();
  const c = tarnZoneCenter(rx, rz);
  assertTrue(isPointInTarnPool(c.cx + TARN_POOL_RADIUS - 1, c.cz, SEED), 'r-1 在内');
  assertFalse(isPointInTarnPool(c.cx + TARN_POOL_RADIUS + 1, c.cz, SEED), 'r+1 在外');
});

test('池面判据：非地带 region 的点一律不在池内', () => {
  let found = null;
  for (let rx = -6; rx <= 6 && !found; rx++) for (let rz = -6; rz <= 6; rz++) {
    if (!isTarnZone(rx, rz, SEED)) { found = { rx, rz }; break; }
  }
  const c = tarnZoneCenter(found.rx, found.rz);
  assertFalse(isPointInTarnPool(c.cx, c.cz, SEED), '非地带 region 的中心不在池内');
});

test('池面判据：tarnPoolAt 只对地带 region 返回对象', () => {
  const { rx, rz } = findTarnRegion();
  const c = tarnZoneCenter(rx, rz);
  const pool = tarnPoolAt(c.cx, c.cz, SEED);
  assertTrue(pool !== null, '地带 region 必须返回池');
  assertEqual(pool.radius, TARN_POOL_RADIUS, '半径');
});

test('池面判据：玩家在池里能游泳（池内确实有 water 方块）', async () => {
  // 本用例钉的是 Review Focus 第 1 条：池内必须是 water 方块而不是空池。
  // physics.js:74 的游泳判据是 `getBlockId(floor(pos.x), floor(pos.y + 0.5), floor(pos.z)) === water`
  // ⇒ 玩家站在池底时，**身体中心那一格（poolWaterY）必须是 water**。
  // 这正是本用例要断言的格 —— 不是「waterY 是个整数」那种无判别力的断言
  // （负向验证：把池内改成空气，那条断言仍然全绿）。
  const { rx, rz } = findTarnRegion();
  const c = tarnZoneCenter(rx, rz);
  const pool = tarnPoolAt(c.cx, c.cz, SEED);
  assertTrue(pool !== null, '池心必须在池内');

  // 用真实 GEN 验证那一格到底是 water 而不是空气
  const reg = await buildDefaultRegistry();
  const waterId = reg.idOf('water');
  const col = new ChunkColumn(Math.floor(c.cx / 16), Math.floor(c.cz / 16));
  fillColumn(col, SEED, reg);   // B5：先铺自然地层，整形才有「削/填」可言
  fillTarnPlateau(col, computeTarnZone(rx, rz, SEED), SEED, reg);
  const lx = c.cx - col.cx * 16, lz = c.cz - col.cz * 16;
  // 池的结构（Task 4）：池底实心在 `waterY - 1`、水在 `waterY`、上面是空气。
  // 玩家踩在池底上 ⇒ 脚底 y = waterY，身体中心 y + 0.5 → floor = waterY
  // ⇒ physics.js:74 查到的那一格正是 `waterY`，必须为 water 才能游泳。
  // ⚠️ 那个 +0.5 是载荷性的：若水只在 `waterY - 1`（池底被顶掉）玩家就游不了。
  const floorId = col.blocks[blockIndex(lx, pool.waterY - 1, lz)];
  assertTrue(floorId !== 0 && floorId !== waterId,
    `waterY-1 必须是实心池底（不能是空气也不能是水），实际 id=${floorId}`);
  assertEqual(col.blocks[blockIndex(lx, pool.waterY, lz)], waterId,
    `waterY 那格必须是 water（physics 查 floor(pos.y+0.5) = ${pool.waterY}）`);
  assertEqual(col.blocks[blockIndex(lx, pool.waterY + 1, lz)], 0,
    '水面之上必须是空气（否则玩家反而在实心里）');
});
```

- [ ] **Step 2: 跑测试确认失败**

预期：**FAIL**，`isPointInTarnPool is not a function`。

- [ ] **Step 3: 实现 `ocean-mask.js` 的池判据**

文件顶部的静态 import（**不要用 `await import`**，也**不要**把 `tarnZone` / `layout` 当已存在的变量
—— 那是伪代码残留，照抄跑不起来）：

```javascript
import { isTarnZone, tarnZoneCenter, computeTarnZone, TARN_POOL_RADIUS } from '../gen/structures/tarn-zone.js';
import { REGION_SIZE } from '../gen/structures/region-config.js';
```

实现（**所有输入现算，不引用不存在的变量**）：

```javascript
/**
 * 该点若落在高台地带的水池圆内，返回池信息；否则 null（CPU 版；GPU 版见 `ocean.js` 的 uTarnPool）。
 *
 * ⚠️ 判据的两个消费方必须同源（红线 1）：本文件（单测可断言）与 ocean.js 的 TSL
 * （GPU 求值、单测测不到）。半径/中心/水位**全部从 `tarn-zone.js` 读**，不在此写字面量。
 *
 * @returns {{cx:number, cz:number, radius:number, waterY:number}|null}
 */
export function tarnPoolAt(x, z, seed) {
  const rx = Math.floor(x / REGION_SIZE), rz = Math.floor(z / REGION_SIZE);
  if (!isTarnZone(rx, rz, seed)) return null;
  const c = tarnZoneCenter(rx, rz);
  if (Math.hypot(x - c.cx, z - c.cz) > TARN_POOL_RADIUS) return null;
  const lay = computeTarnZone(rx, rz, seed);       // plateauY 的唯一来源（几何常量）
  if (!lay) return null;
  // waterY = 体素水那一层的 y；水面平面在 waterY + 0.5（与 ocean.js 的 WATER_LEVEL_OFFSET 同口径）
  return { cx: c.cx, cz: c.cz, radius: TARN_POOL_RADIUS, waterY: lay.plateauY };
}

export function isPointInTarnPool(x, z, seed) {
  return tarnPoolAt(x, z, seed) !== null;
}
```

⚠️ **依赖方向**：`ocean-mask.js` 在 `src/render/`，`tarn-zone.js` 在 `src/gen/`；
`render → gen` 是允许方向（`voxel ← gen ← mesh ← render`），且 `tarn-zone.js` 不 import
`render/**`，**不成环**。写完跑 `npm run check:arch` 确认。

⚠️ 顶部用静态 `import` 而不是 `await import()` —— 先确认依赖方向不成环：
`tarn-zone.js` 只 import `noise.js` / `region-config.js`，不 import `render/**`，所以 `render → gen` 单向合法。

- [ ] **Step 4: 跑测试确认通过**

预期：5 条 PASS。

- [ ] **Step 5: 改 `ocean.js` 的 GPU 门控**

在 `setupOcean` 里加：

```javascript
  /**
   * 高台地带水池的平面门控（xyzw = 池心 x + 池心 z + 池半径 + 水面 y）。
   * w ≤ 0 是「无池」哨兵（判定恒假），与 uCityBounds 的 OCEAN_MASK_NO_CITY 同手法。
   */
  const uTarnPool = uniform(new THREE.Vector4(0, 0, 0, -1));
```

在 `colorNode` 的城市门控之后加：

```javascript
    // 高台地带水池：池圆内一律渲染水面、池外 Discard。
    // 这是城市门控的**反向**（城市是 bounds 内一律不渲）。两者互斥（地带 region 不可能在城市内），
    // 但顺序仍按「城市先、水池后」写，避免将来判据漂移。
    const inTarnPool = and(
      uTarnPool.w.greaterThan(0.0),
      length(pos.sub(vec2(uTarnPool.x, uTarnPool.y))).lessThanEqual(uTarnPool.z),
    );
```

并把既有的水域遮罩表达式改为：

```javascript
    const oceanMask = max(inTarnPool, mix(float(0.0), nearOceanMask, inRangeMask));
```

⚠️ **`inTarnPool` 为 1 时遮罩恒 1**（池内一律渲染），为 0 时退回既有逻辑（零回归）。

⚠️ **本任务只解决「观感」，不解决容量**（spec DR-5b/5c/5d 的实测结论）：
平面渲染**不能**让体素水省下顶点 —— `mesher.js:408` 的 `WATER_LIKE` 只做同类互剔，
每个水格照样发面。所以 Step 8 的**容量回归断言必须加**（不扩容是用户裁定，
不是「加了平面就不用管容量」）。
反过来说：体素水**不能删**（`physics.js:74` 的游泳判据显式查 `water` 方块，
删了就变成「踩在池底走」）。两者缺一不可。
⚠️ `vec2(...)` 需从 `three/tsl` import（检查文件头已有的 import 清单，避免重复 import 或未导入）。
⚠️ **`vec2` 必须接受两个节点**；若 TSL 的 `vec2` 只收一个 Vector2 节点，改用
`vec2(uTarnPool.x, uTarnPool.y)`（两个 float 节点）—— 实现时先读 `vendor/three/three.tsl.js` 的签名确认。

在返回值里加：

```javascript
    setTarnPool(pool) {
      if (!pool) { uTarnPool.value.set(0, 0, 0, -1); return; }
      uTarnPool.value.set(pool.cx, pool.cz, pool.radius, pool.waterY + 0.5);
    },
```

⚠️ `uniform(new THREE.Vector4())` 的 `.value` 是 `Vector4`，有 `set(x,y,z,w)` ——
**没有** `setXYZ` 之类（既有教训：`.setRGB` 是 `Color` 的方法，写错会白屏）。

- [ ] **Step 5a: 把平面抬到池面高度（A3 —— 不做这步池面永远看不见）**

⚠️ **这是审阅发现的核心缺陷**：`ocean.js:243` 的 `plane.position.y = WATER_LEVEL_OFFSET`
是写死的 **−1.5**，而水池水面在 `plateauY + 0.5 = 2.5`。只加「池圆内渲染」的门控时，
那块 800×800 平面仍躺在**池底下方 2.5 格**、被池底挡住 → 玩家看不到任何水面。

**实测事实**：体素水的顶面经 `mesher.js` 的 `WATER_SURFACE_SINK = 0.5` 下沉后
**本身就在 y = 2.5**（水方块占 y∈[2,3) → 顶面 2.5）。所以池面几何上已被体素水渲出，
平面只是要贴上同一高度提供波纹与高光。

**用户裁定：平面抬升到 y=2.5**。实现用 `material.positionNode`（TSL 顶点阶段）：

```javascript
// 既有：ocean.js 里 waterMaterial 的构造处
// ⚠️ **positionNode 必须返回局部坐标** —— three 在 three.webgpu.js:21575 做的是
//    positionLocal.assign(subBuild(this.positionNode))，之后还会再乘一次 modelWorldMatrix。
//    返回世界坐标会双重变换 → 平面跑到 2×camera.position 处。
const worldPos = objectWorldMatrix.mul(positionLocal);   // 由局部算世界 xz（只用于判池内）
waterMaterial.positionNode = Fn(() => {
  const inPool = and(
    uTarnPool.w.greaterThan(0.0),
    length(worldPos.xz.sub(vec2(uTarnPool.x, uTarnPool.y))).lessThanEqual(uTarnPool.z),
  );
  // 池内把**局部 z** 抬高，池外保持原值。
  //   平面 `rotation.x = -π/2` ⇒ 局部 +Z 映射到世界 +Y；世界高度由
  //   plane.position.y（= WATER_LEVEL_OFFSET）+ 局部 z 偏移共同决定。
  //   故局部偏移量 = 目标世界高度 − WATER_LEVEL_OFFSET = 2.5 − (−1.5) = 4.0
  //   ⚠️ 不要加在局部 y 上 —— 那是平面的法线方向（旋转后指向世界 −Z），加了会把平面推远。
  const lift = uTarnPool.w.sub(float(WATER_LEVEL_OFFSET));   // = 4.0
  return vec3(positionLocal.x, positionLocal.y, positionLocal.z.add(select(inPool, lift, float(0.0))));
})();
```

⚠️ **在 `positionNode` 里读 `positionLocal` 是 three 的文档写法，不是自引用缺陷**：
`positionLocal = positionGeometry.toVarying('positionLocal')`（`three.webgpu.js:15055`），
顶点阶段读它解析到原始 attribute；three 自己的示例就是
`material.positionNode = positionLocal.add(displace)`（`:21020`）。
⚠️ 但 `worldPos` 必须定义在 `Fn()` **外部**且只算一次（节点图惰求值，写进闭包里会逐顶点重建）。
**Step 5b 的最小 Tier 4 探针验的是「池面真的出现在 y=2.5」**（而不是只验编译通过）。

⚠️ **positionNode 只输出局部坐标**（致命 3）：`three.webgpu.js:21575` 是
`positionLocal.assign(subBuild(this.positionNode))`，之后 vertex shader 还会乘
`modelWorldMatrix`。返回世界坐标会**双重变换**（平面跑到 2×camera.position 处）。
判断「在不在池内」用 `objectWorldMatrix.mul(positionLocal).xz` 算世界 xz，
返回的仍是局部坐标。three 自己的文档示例（`:21020`）也是
`positionNode = positionLocal.add(displace)`。

⚠️ **平面 `rotation.x = -π/2`，所以局部 +Z 对应世界 +Y** —— 抬升必须加在**局部 z** 上，
不能加在 y 上。抬升量 = `目标世界高度 − WATER_LEVEL_OFFSET` = 2.5 − (−1.5) = **4.0**。

⚠️ **四条硬要求（每条都对应一种可见缺陷）**：

1. **池外顶点必须留在 −1.5**，否则整片海面被抬到 2.5（全世界陆地都被一层水盖住）。
2. **抬升后与体素水顶面共面（都是 2.5）** —— 这与既有海面**刻意共面**是同一手法，
   靠 `renderOrder = 1` + `depthWrite = false` 避免 z-fighting。
   **不要**为了「避让」抬到 2.51 之类，那会与体素水之间露出一条缝（俯视看到水下）。
3. **平面仍跟相机横行**（`plane.position.x/z = camera.position`）—— 抬升只改 y。
4. **法线不用改**：平面仍水平，既是着色器用固定 `vec3(0,1,0)` 参与 Fresnel（`ocean.js:205`）。

⚠️ 若 `positionNode` 的写法与 three r185.1 的 TSL 签名不符（如 `select` 的参数顺序），
**以 `vendor/three/three.tsl.js` 的实际导出为准**，并在 Tier 4 用例上验证池面真的出现。

- [ ] **Step 5b: 跑一次 Tier 4 的最小版本，确认池面可见**

在写完整 Tier 4 用例（Task 7）之前，先用探针确认「池心俯视能看到水面」——
否则后面的用例全在测一块看不见的水。判据见 Task 7 的「池面可见」用例。

- [ ] **Step 6: 在 `game.js` 接线 `setTarnPool`**

在帧循环里按玩家位置设池（玩家走远就清掉）。**照 `_updateSunPosition()` 的「移动超 5 格才重算」
节流手法**（既有约束：不要每帧做重计算）：

```javascript
    // 高台地带池面门控：按玩家所在 region 判，进池附近才启用（避免全图所有地带同时求值）
    if (!this._tarnPoolAt || distSqTo(this._tarnPoolAt) > 25) {
      this._tarnPoolAt = { x: pos.x, z: pos.z };
      this.ocean.setTarnPool(tarnPoolAt(pos.x, pos.z, this.seed));
    }
```

⚠️ **玩家走进地带时水面必须出现** —— 若只在地带**内部**才设池，从外部走近时
一旦进入地带中心所在的 region 就会生效（`tarnPoolAt` 按 region 判，不按距离）；
跨 region 边界时也要重算，所以判据里要包含 region 变化。

⚠️ **`this.seed` 必须是 Game 已存的字段**（`grep -n "this.seed" src/core/game.js` 确认；
既有代码用 `this.seed` 还是 `this.settings.seed` 照现状写，别自创）。

- [ ] **Step 7: 跑测试 + 手动验证**

```bash
npm run check
```

预期：`test-tarn-water.js` 5 条 PASS；`check:arch` 全绿。
再开 `http://localhost:8081/` 走进地带，确认池面出现（Task 10 的 Tier 4 用例会钉这一点）。

- [ ] **Step 8: 不扩容 —— 改为加一条容量回归断言**

**`src/render/render-world.js` 的 `CAPACITY` 一行都不改**（spec DR-5f：不扩容是用户第三轮裁定）。

实测依据（spec DR-7 定稿组合 L3/L5/L6/L4/L8/L9/L10/L11，轴对齐）：poolR=90
→ 池面积 25,447 − 8 座高台占地 7,263 − 紫晶柱占地 560 = 水格 **17,624**；
→ transparent used = 17,624 × 4.414 ≈ 77,792 → reserved **97,241**；
→ 再加 180 格 `glass_block`（reserved ≈ 994）：**合计 reserved ≈ 98,235 = 现容量 125,000 的 78.6%**。

⚠️ **容量必须同时计入紫晶柱**（它们立在池内、占掉水格，且 `glass_block` 走 transparent）：
- 紫晶柱占地 = 7 个尺寸之和 = **560 格**（⚠️ 不是 924 —— 那是 7×12×11 的粗估，实际 7 个柱尺寸不同）；
- `glass_block` ≈ 180 格 → 约 794 顶点。
不计会把 reserved 算低（漏掉 ~1,000），虽然仍不超容量，但**留的余量是假的**。

改为在 `src/tests/test-tarn-zone.js` 加容量护栏（**先 RED 后 GREEN**）：

```javascript
test('地带容量：transparent reserved 必须 <= 现容量（不扩容的前提）', () => {
  const { rx, rz } = findTarnRegion(SEED);
  const lay = computeTarnZone(rx, rz, SEED);
  // ⚠️ 轴对齐口径：占地 = (2·halfX) × (2·halfZ)（不是 radialHalf/tangentialHalf，那是旋转假设的残留）
  const tarnArea = lay.tarns.reduce((s, t) => s + (2 * t.halfX) * (2 * t.halfZ), 0);
  const spireArea = lay.decos
    .filter((d) => d.kind === 'spire')
    .reduce((s, d) => s + (2 * d.halfX) * (2 * d.halfZ), 0);
  const waterCells = Math.round(Math.PI * lay.poolRadius ** 2) - tarnArea - spireArea;
  // 4.414 = poolR=128 的真实 mesher 实测比例（used 顶点 / 水格）
  const reserved = Math.ceil(Math.round(waterCells * 4.414) * 1.25);
  assertTrue(reserved <= 125000,
    `transparent reserved ${reserved} 超出 125,000 —— 池半径或高台数被改大了`);
});

test('地带：运行时用的 8 座 == TARN_KEPT_TARN_IDS，且都是烘焙过的变体', () => {
  const { rx, rz } = findTarnRegion(SEED);
  const lay = computeTarnZone(rx, rz, SEED);
  assertEqual(lay.tarns.length, 8, '高台数');
  const got = new Set(lay.tarns.map((t) => t.variant));
  assertEqual(got.size, 8, '8 座必须互不相同');
  for (const v of got) {
    assertTrue(TARN_KEPT_TARN_IDS.includes(v), `${v} 不在 TARN_KEPT_TARN_IDS 里`);
  }
});
```

⚠️ **负向验证（必做）**：临时把 `TARN_KEPT_TARN_IDS` 或 `TARN_POOL_RADIUS` 改回 11 座 / 128，
确认容量用例 **FAIL**，再改回来。不做这一步就无法判断这条护栏是否真有判别力。

- [ ] **Step 9: Commit**

```bash
# ⚠️ render-world.js 不在清单里（Step 8 裁定不扩容，它无改动）；
#    Step 8 的容量护栏加在 test-tarn-zone.js，故 add 它。
git add src/render/ocean-mask.js src/render/ocean.js src/core/game.js \
        src/tests/test-tarn-water.js src/tests/test-tarn-zone.js src/tests/index.html
git commit -m "feat(render): 高台地带池面渲染（平面抬升 + CPU/GPU 同源判据）"
```

---

## Task 7: Tier 4 真游戏页景观验收

**Files:**
- Create: `tests/tarn-zone.spec.mjs`

**Interfaces:**
- Consumes: `window.__MC_GAME__`（`world/player/scheduler/registry + perfSnapshot/renderStats`）；
  `?seed=` / `?vd=` URL 参数；`tests/harness.spec.mjs` 的既有等待手法
- Produces: Tier 4 用例（不产出被其他任务消费的接口）

- [ ] **Step 1: 先跑一次真实数据，打印实际值（不得凭想象写断言）**

写一个临时探针 `tests/tmp-tarn-probe.spec.mjs`（`.gitignore` 已忽略 `tests/tmp-*`）：

```javascript
import { test, expect } from '@playwright/test';
const SEED = 12345;
test('探针：地带 region 与池心坐标', async ({ page }) => {
  await page.goto(`/?seed=${SEED}&vd=8`);
  await page.waitForFunction(() => window.__MC_GAME__, null, { timeout: 60000 });
  const info = await page.evaluate(async (seed) => {
    const { isTarnZone, tarnZoneCenter } = await import('../../src/gen/structures/tarn-zone.js');
    const out = [];
    for (let rx = -6; rx <= 6; rx++) for (let rz = -6; rz <= 6; rz++) {
      if (isTarnZone(rx, rz, seed)) out.push({ rx, rz, ...tarnZoneCenter(rx, rz) });
    }
    return out;
  }, SEED);
  console.log(`seed ${SEED} 的地带 region（${info.length} 个）：`, JSON.stringify(info));
  expect(info.length).toBeGreaterThan(0);
});
```

运行并**记录输出**：

```bash
npx playwright test tests/tmp-tarn-probe.spec.mjs
```

把第一个地带 region 的坐标记下来（后续用例要飞到那里）。**不要用一个想象中的坐标。**

- [ ] **Step 2: 写 Tier 4 的景观用例**

```javascript
// tests/tarn-zone.spec.mjs — 高台地带 Tier 4：真游戏页景观实测
//
// ⚠️ 必须隐藏全部 HUD 并冻结物理/日夜/阴影（fog-color.spec 的既有手法），否则噪声底可达 0.95。
// ⚠️ 逐帧读像素必须在 rAF 回调内（WebGPU swapchain 在 rAF 外 drawImage 读到黑屏）。
import { test, expect } from '@playwright/test';

const SEED = 12345;
/** Step 1 实测得到的地带 region（运行前用探针确认仍是这个值） */
// ⚠️ 用 Step 1 探针的**真实**地带 region 替换。占位值故意让用例直接失败：
//    (0,0) 是 CITY_REGION，isTarnZone(0,0,*) ≡ false → 忘替换会「静默测错地方」。
const TARN_REGION = { rx: NaN, rz: NaN };
if (!Number.isFinite(TARN_REGION.rx)) {
  throw new Error('TARN_REGION 未填：先跑 Step 1 探针取真实地带 region（不能是 [0,0]，那是城市）');
}

async function flyToTarn(page) {
  const c = await page.evaluate(async ({ rx, rz }) => {
    const { tarnZoneCenter } = await import('../../src/gen/structures/tarn-zone.js');
    return tarnZoneCenter(rx, rz);
  }, TARN_REGION);
  // ⚠️ 本仓**没有** player.setPosition() —— 必须直写 physics.pos + pin（见文件头的 teleport）
  await teleport(page, c.cx + 32, c.cz + 32, 80);
  await settle(page, c.cx, c.cz);
  return c;
}

async function freezeAndHideHud(page) {
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    if (g.setShadowsEnabled) g.setShadowsEnabled(false);
    if (g.setVisualStyle) g.setVisualStyle('noon');
    // ⚠️ 停物理用 teleport 里的 setInterval pin，**不要用 pushModal** ——
    //    它阻断玩家更新循环 → 相机不跟随新位置 → 换了机位画面却没变（实测整屏 Δ=0，一度误判为功能失效）。
    for (const el of document.querySelectorAll('#hud-root > *, #crosshair, #settings-btn')) {
      el.style.display = 'none';
    }
  });
}

const queueConverged = () => {
  const s = window.__MC_GAME__.scheduler;
  return s._inflightGen.size === 0 && s._meshQueue.length === 0 && s._inflightMesh.size === 0 &&
         s._uploadQueue.length === 0 && s._pendingMesh.size === 0 && s._lightQueue.size === 0 &&
         s._inflightLight.size === 0;
};

/** 传送到 (x, z) 并钉住位置，y 给 80 避开卡地形（手法照抄 tests/mesa.spec.mjs:30-41） */
async function teleport(page, x, z, y = 80) {
  await page.evaluate(([px, pz, py]) => {
    clearInterval(window.__PIN__);
    const p = window.__MC_GAME__.player.physics;
    p.pos.x = px; p.pos.y = py; p.pos.z = pz;
    p.vel.x = p.vel.y = p.vel.z = 0;
    window.__PIN__ = setInterval(() => { p.pos.x = px; p.pos.z = pz; p.pos.y = py; p.vel.y = 0; }, 30);
  }, [x, z, y]);
}

/** 等目标周围的 column 全部加载 + 队列收敛 */
async function settle(page, x, z) {
  await page.waitForFunction(([px, pz]) => {
    const g = window.__MC_GAME__; const cx = Math.floor(px / 16), cz = Math.floor(pz / 16);
    for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) {
      if (!g.world.hasColumn(cx + dx, cz + dz)) return false;
    }
    return true;
  }, [x, z], { timeout: 180_000 });
  await page.waitForFunction(queueConverged, null, { timeout: 180_000 });
}

async function unpin(page) {
  await page.evaluate(() => clearInterval(window.__PIN__));
}

async function openGame(page) {
  await page.goto(`/?vd=8&seed=${SEED}`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 120_000 });
  await page.waitForFunction(queueConverged, null, { timeout: 180_000 });
}

test('高台地带：台地层以 grass/stone 为绝对主体', async ({ page }) => {
  await flyToTarn(page);
  await freezeAndHideHud(page);
  const shot = await page.screenshot();
  // 判别力对照：同机位在非地带 region 截一张，两者必须显著不同
  // …（见下一条用例的对照手法）
  expect(shot.length).toBeGreaterThan(1000);
});

test('高台地带：池面可见（海蓝三相判据）', async ({ page }) => {
  const c = await flyToTarn(page);
  await freezeAndHideHud(page);
  // 从池心正上方俯视采样水面（用 teleport 而非 player.setPosition —— 本仓没有后者）
  await teleport(page, c.cx, c.cz, 40);
  await page.waitForTimeout(800);
  // ⚠️ WebGPU swapchain canvas 在 rAF 外 drawImage 读到黑屏 → 必须在 rAF 回调内读
  const pixels = await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => {
      const cv = document.querySelector('canvas');
      const off = new OffscreenCanvas(cv.width, cv.height);
      const ctx = off.getContext('2d');
      ctx.drawImage(cv, 0, 0);
      const d = ctx.getImageData(0, Math.floor(cv.height * 0.3), cv.width, Math.floor(cv.height * 0.4)).data;
      let gr = 0, bg = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        // 只统计「水体像素」（沿用 water-visual.spec 的定义：B 与 G 都显著高于 R）
        if (d[i + 2] > d[i] + 12 && d[i + 1] > d[i] + 12) { gr += d[i + 1] - d[i]; bg += d[i + 2] - d[i + 1]; n++; }
      }
      resolve({ n, gr: n ? gr / n : 0, bg: n ? bg / n : 0 });
    });
  }));
  // 阈值取自 water-visual.spec 的既有海蓝三相判据（G−R ≥ 24、B−G ∈ [8,45]）
  expect(pixels.n).toBeGreaterThan(1000);
  expect(pixels.gr).toBeGreaterThanOrEqual(24);
  expect(pixels.bg).toBeGreaterThanOrEqual(8);
  expect(pixels.bg).toBeLessThanOrEqual(45);
});
```

⚠️ **不要依赖 `g.tarnPool`**（Game 不存这个字段）。需要坐标时就在 evaluate 里
`await import('../../src/gen/structures/tarn-zone.js')` 现算（与 `flyToTarn` 同一手法）。

- [ ] **Step 3: 跑测试确认能跑通（不是全绿，先确认判据有判别力）**

```bash
npx playwright test tests/tarn-zone.spec.mjs
```

预期：至少「池面可见」通过。若 `pixels.n === 0` → 水面没渲染（回 Task 6）。
**再做一个负向验证**：把 `ocean.js` 的 `inTarnPool` 临时改成 `float(0.0)`，重跑该用例，
**必须 FAIL**。改回来后重跑通过。这一步不能省 —— 否则你不知道判据在量什么。

- [ ] **Step 4: 加高台与云的用例**

按 Step 1~3 的手法再加两条：

- **高台在位**：俯视画面上半部统计「高度 > 15 格的实心柱」数量 ≥ 8
  （用 `world.getBlockId` 在一组采样点向上扫描，而不是数像素 —— 方块层判据更可靠）。
- **地带上空有云**：`y ∈ [50, 94]` 的非空气格数 > 100（上界给到 94：云底 54 + 最高云 38 = 92，留 2 格余量）。

- [ ] **Step 5: 加零回归用例**

```javascript
test('零回归：非地带 region 的画面与改动前一致', async ({ page }) => {
  // 与 fog-color.spec 同手法：同一机位、同一冻结条件，截图比对
  // 基线图首次运行生成后提交入库（tests/fixtures/tarn-none-regression.png）
});
```

⚠️ 首个基线图必须在**改动前后各截一次**确认逐像素 diff = 0 才提交。

- [ ] **Step 6: Commit**

```bash
git add tests/tarn-zone.spec.mjs tests/fixtures/tarn-none-regression.png
git commit -m "test(e2e): 高台地带 Tier 4 景观与零回归验收"
```

---

## Task 8: 数据门 `[高台地带]`

**Files:**
- Modify: `tools/check-data.mjs`

**Interfaces:**
- Consumes: `cloudland-kit-fingerprint.mjs` 的 `BLOCK_MAP` / `KIT_METRICS` / `KIT_VARIANTS` / `cloudlandKitInputFingerprint`；
  `REGISTRY`（既有）；`fs` / `path`
- Produces: `checkCloudlandTarnZone()`，在主流程里被 `await` 调用（**漏了这行则门禁永不执行**，本仓已因此出过两次事故）

- [ ] **Step 1: 先测「产物缺失」是否能被抓住（负向验证先行）**

临时把 `assets/structures/cloudland_tarn_01.json` 改名，跑：

```bash
mv assets/structures/cloudland_tarn_01.json /tmp/tarn01.json
npm run check:data
```

预期：**必须报错**（此时门禁还没写，会全绿 —— 记下这个「全绿」作为 RED 基线）。

```bash
mv /tmp/tarn01.json assets/structures/cloudland_tarn_01.json   # 复原
```

⚠️ **复原必须用 `mv` 回原位，禁用 `git checkout`**（既有教训：对含未提交改动的文件用 git restore 丢过数据）。

- [ ] **Step 2: 写 `checkCloudlandTarnZone()`**

按 §4.4 的八条判据实现。结构照既有的 `checkCloudlandMesa()`（同文件的 734 行起）：

```javascript
// ---------------------------------------------------------------- [高台地带] 契约（Cloudland Tarn Zone）

/**
 * [高台地带] 契约：烘焙输入 / 35 个产物 / 映射表 / 渲染通道 / 台顶材质五者互相对得上。
 *
 * 为什么这些必须自动化（每一条都对应一种「肉眼看不出来」的失效）：
 *   ① 指纹不匹配 → 改了映射表却没重烘 → 世界渲染的是旧配色
 *   ② palette 含未注册方块 → makeColumnSetter 静默 return → 那格变 air（台身出现空洞）
 *   ③ palette 跑进 cutout → 每格顶点成本约 ×3 → 撞 §4.10 容量预算
 *   ④ 台顶不是 grass 而是 moss → 用户明确要的改动肉眼像没做
 *   ⑤ 少了一个变体 → 对应那座高台静默不出现（rasterizeStructure 拿到空 blocks 直接 return）
 */
async function checkCloudlandTarnZone() {
  const fp = await import('./cloudland-kit-fingerprint.mjs');
  const fail = (m) => failures.push(`[高台地带] ${m}`);

  if (!fs.existsSync(fp.SCHEM_PATH)) {
    fail('缺烘焙输入 assets/cloudland/src/cloudlandassets_1.20.schem（应与仓库同存）');
    return;
  }

  // ① 指纹：烘焙时写进伴随 meta，门禁重算比对（防「改了映射表没重烘」）
  const metaPath = path.join(fp.KIT_JSON_DIR, 'cloudland_kit.meta.json');
  if (!fs.existsSync(metaPath)) {
    fail('缺 assets/structures/cloudland_kit.meta.json（跑 npm run tarn）');
    return;
  }
  const cur = fp.cloudlandKitInputFingerprint();
  let kitMeta;
  try { kitMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); }
  catch { fail('cloudland_kit.meta.json 不是合法 JSON（重跑 npm run tarn）'); return; }
  if (kitMeta.fingerprints?.input !== cur.input) {
    fail(`产物已过期：指纹不匹配（烘焙时 "${kitMeta.fingerprints?.input}" vs 当前 "${cur.input}"）→ 跑 npm run tarn`);
  }

  // ② 35 个产物全部存在 + 格数/bbox 与 KIT_METRICS 相符 + palette 合法
  let checkedVariants = 0;
  const allVariants = [
    ...fp.KIT_VARIANTS.tarn.map((v) => ['tarn', v]),
    ...fp.KIT_VARIANTS.arch.map((v) => ['arch', v]),
    ...fp.KIT_VARIANTS.spire.map((v) => ['spire', v]),
    ...fp.KIT_VARIANTS.giantCloud.map((v) => ['giantCloud', v]),
  ];
  // 数量契约
  if (fp.KIT_VARIANTS.tarn.length !== 11) fail(`高台变体 ${fp.KIT_VARIANTS.tarn.length} ≠ 11`);
  if (fp.KIT_VARIANTS.arch.length !== 5) fail(`拱洞变体 ${fp.KIT_VARIANTS.arch.length} ≠ 5`);
  if (fp.KIT_VARIANTS.spire.length !== 7) fail(`紫晶柱变体 ${fp.KIT_VARIANTS.spire.length} ≠ 7`);
  if (fp.KIT_VARIANTS.giantCloud.length !== 12) fail(`巨型云变体 ${fp.KIT_VARIANTS.giantCloud.length} ≠ 12`);

  const brickishAll = [];
  for (const [family, base] of allVariants) {
    const p = path.join(fp.KIT_JSON_DIR, `${base}.json`);
    if (!fs.existsSync(p)) { fail(`缺产物 ${base}.json（跑 npm run tarn）`); continue; }
    let json;
    try { json = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { fail(`${base}.json 不是合法 JSON`); continue; }
    const n = json.blocks.length / 4;
    const M = fp.KIT_METRICS[base];
    if (!M) { fail(`KIT_METRICS 缺 ${base} 的条目`); continue; }
    if (n !== M.blocks) fail(`${base} 格数 ${n} ≠ KIT_METRICS.blocks ${M.blocks}`);
    // bbox
    let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity, mnz = Infinity, mxz = -Infinity;
    for (let i = 0; i < json.blocks.length; i += 4) {
      const x = json.blocks[i], y = json.blocks[i + 1], z = json.blocks[i + 2];
      mnx = Math.min(mnx, x); mxx = Math.max(mxx, x);
      mny = Math.min(mny, y); mxy = Math.max(mxy, y);
      mnz = Math.min(mnz, z); mxz = Math.max(mxz, z);
    }
    if (mxx - mnx + 1 !== M.width) fail(`${base} 宽 ${mxx - mnx + 1} ≠ ${M.width}`);
    if (mxy - mny + 1 !== M.height) fail(`${base} 高 ${mxy - mny + 1} ≠ ${M.height}`);
    if (mxz - mnz + 1 !== M.depth) fail(`${base} 深 ${mxz - mnz + 1} ≠ ${M.depth}`);
    if (mny !== 1) fail(`${base} 最低点 y=${mny} ≠ 1（归一化失败）`);
    // palette 合法性 + 通道
    for (const name of json.palette) {
      const id = REGISTRY.idOf(name);
      if (id === undefined) { fail(`${base} 含未注册方块 "${name}"`); continue; }
      if (name === 'glass_block') continue;   // 紫晶柱的唯一合法 transparent 例外
      if (REGISTRY.cullTable[id] !== 0) fail(`${base} 的 "${name}" 不在 opaque 通道`); 
    }
    brickishAll.push(...json.palette.filter((x) => /brick/i.test(x)));
    checkedVariants++;
  }

  // ③ 无砖块族 / 木族（沿用 v1.77 的名字模式判据）
  // ⚠️ 必须同时判砖与木（原稿只写了砖，木族判据漏了 → 木方块混进高台也全绿）
  const brickish = [...new Set(brickishAll)].filter((x) => /brick/i.test(x));
  if (brickish.length > 0) fail(`palette 含砖块族：${brickish.join(', ')}`);

  const WOOD_RE = /log|wood|plank|acacia_planks|oak_planks|birch/i;
  const woody = [];
  for (const [, base] of allVariants) {
    const p2 = path.join(fp.KIT_JSON_DIR, `${base}.json`);
    if (!fs.existsSync(p2)) continue;
    const j2 = JSON.parse(fs.readFileSync(p2, 'utf8'));
    for (const name of j2.palette) if (WOOD_RE.test(name)) woody.push(`${base}:${name}`);
  }
  const woodyUniq = [...new Set(woody)];
  if (woodyUniq.length > 0) fail(`palette 含木族：${woodyUniq.join(', ')}`);

  // ④ 台顶必须是 grass 不是 moss（用户裁定）
  const mossInTarn = [];
  for (const base of fp.KIT_VARIANTS.tarn) {
    const p = path.join(fp.KIT_JSON_DIR, `${base}.json`);
    if (!fs.existsSync(p)) continue;
    const json = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (json.palette.includes('moss')) mossInTarn.push(base);
  }
  if (mossInTarn.length > 0) fail(`这些高台的 palette 里还有 moss（台顶必须是 grass）：${mossInTarn.join(', ')}`);

  // ⚠️ 成功行的条件必须涵盖本函数全部判据（既有教训：曾同时打印「✗ 含砖块族」与「✓ 无砖无木」）
  const before = failures.length;
  // ⚠️ 成功行的条件必须涵盖本函数**全部**判据（既有教训：[高台] 曾同时打印
  // 「✗ 含砖块族」与「✓ 无砖无木」，读者只看 ✓ 就误判）
  const paletteOk = brickish.length === 0 && woodyUniq.length === 0;
  if (failures.length === before && paletteOk && mossInTarn.length === 0 && checkedVariants === allVariants.length) {
    infos.push(`[高台地带] ${checkedVariants} 个产物（11 高台 + 5 拱洞 + 7 紫晶柱 + 12 巨型云）/ 台顶全 grass / 无砖块族 / 指纹匹配`);
  }
}
```

⚠️ **需要 `KIT_METRICS` 里同时存指纹**：在 `cloudlandKitInputFingerprint()` 的 `paramsSha256` 输入里
包含 `BLOCK_MAP` / `KIT_METRICS` / `KIT_VARIANTS`。产物侧的指纹放在一个伴随文件
`assets/structures/cloudland_kit.meta.json`（烘焙脚本写，门禁比对）——同 `cloudland_mesa_small.meta.json` 的手法。

- [ ] **Step 3: 注册到主流程**

在 `check-data.mjs` 的主流程里，把 `await checkCloudlandMesa();` 那一行**替换**为：

```javascript
await checkCloudlandTarnZone();  // 高台地带：35 产物/映射表/通道/台顶材质契约（⚠️ 漏了本行则门禁永不执行）
```

- [ ] **Step 4: 负向验证（三条，每条都必须真 FAIL）**

依次注入、跑 `npm run check:data`、确认报错、用 `mv` 复原：

1. 把 `cloudland_tarn_01.json` 改名 → 预期 `缺产物 cloudland_tarn_01.json`。
2. 把某个 `cloudland-kit-fingerprint.mjs` 里 `KIT_VARIANTS.tarn.length` 改 10 → 预期 `高台变体 10 ≠ 11`。
   复原必须用 `cp` 备份 + `cp` 还原（**禁用 `git checkout`**）。
3. 在产物 JSON 的 `palette` 里手工插入 `"moss"` → 预期 `palette 里还有 moss`。

- [ ] **Step 5: 跑全绿**

```bash
npm run check
```

预期：`check:data` 打印 `[高台地带] 35 个产物（…）/ 台顶全 grass / 无砖块族 / 指纹匹配`。

- [ ] **Step 6: Commit**

```bash
git add tools/check-data.mjs assets/structures/cloudland_kit.meta.json
git commit -m "test(gate): [高台地带] 数据契约门（35 产物 / 台顶 grass / 无砖 / 指纹）"
```

---

## Task 9: 删除沙漠孤立高台（DR-11）

**Files:**
- Delete: `src/gen/structures/mesa.js`、`tools/bake-cloudland-mesa.mjs`、`tools/cloudland-mesa-fingerprint.mjs`
- Delete: `assets/structures/cloudland_mesa_small.json`、`assets/structures/cloudland_mesa_small.meta.json`
- Delete: `src/tests/test-mesa.js`、`src/tests/test-mesa-gen.js`、`tests/mesa.spec.mjs`
- Modify: `src/gen/structures/structure-layout.js`、`src/gen/structures/apply.js`、
  `src/gen/structures/structure-json.js`、`src/gen/structures/giant-pyramid.js`、
  `src/tests/index.html`、`package.json`

**Interfaces:**
- Consumes: 无
- Produces: `mesa` 字段从 `computeRegionLayout` 消失；`giant-pyramid.js` 不再依赖 `mesa.js`

- [ ] **Step 1: 先删测试与产物，确认剩下多少红**

```bash
git rm src/tests/test-mesa.js src/tests/test-mesa-gen.js tests/mesa.spec.mjs
git rm assets/structures/cloudland_mesa_small.json assets/structures/cloudland_mesa_small.meta.json
```

从 `src/tests/index.html` 删除两行：

```javascript
    import './test-mesa.js';
    import './test-mesa-gen.js';
```

跑：

```bash
npm run check:arch
```

预期：**FAIL**（`test-tarn-zone.js` 的「地带 region 全部地标被压制」用例里断言了 `l.mesa === null`，
而字段还在；`check:data` 的 `[高台]` 环节会报缺产物）。记下这些红。

- [ ] **Step 2: 删代码引用（逐个文件，每改一处跑一次 `npm run check:arch`）**

1. `src/gen/structures/structure-layout.js`：删 `import { computeMesaAnchor } from './mesa.js';`、
   `const mesa = computeMesaAnchor(...)`、返回值的 `mesa` 字段。
2. `src/gen/structures/apply.js`：删 `import { MESA_UNION_HALF } from './mesa.js';`、
   阶段 2.75 整段、`needTypes.add('cloudlandMesaSmall')` 那两行；
   以及 `giantAllowedAtFor` 里对 `mesa` 的排除块。
3. `src/gen/structures/structure-json.js`：删 `cloudlandMesaSmall: 'cloudland_mesa_small.json',`。
4. `src/gen/structures/giant-pyramid.js`：**这是删 `mesa.js` 最危险的连带改动，必须先处理**。

   `mesa.js` 不只导出 mesa 专用的东西 —— 它还导出 **`regionLandmarkCenters()`**，
   而 `giant-pyramid.js:250` **正在用它**（计算「不压地标」的圆）。直接 `git rm mesa.js`
   会让 `giant-pyramid.js` `Cannot resolve module` → 整个 GEN 挂掉 → **游戏白屏**。

   做法：**先把 `regionLandmarkCenters()` 与它依赖的 `LANDMARK_CLEARANCE` / `landmarkCircles`
   搬到一个中性文件**（新建 `src/gen/structures/landmark-circles.js`），再从 `giant-pyramid.js`
   改 import。搬完先跑 `npm run check:arch` 确认无环，然后才删 `mesa.js`。

   `giant-pyramid.js` 自己的改动：
   - import 从 `'./mesa.js'` 改成 `'./landmark-circles.js'`（只取 `regionLandmarkCenters`），
     **删掉 `computeRegionLocalAnchor` 与 `MESA_UNION_HALF`**；
   - 删 `const mesa = computeRegionLocalAnchor(...)`（第 253 行）；
   - 删第 284-285 行的 `if (mesa && ...) continue;` 排除判据；
   - 删注释里关于 mesa 的段落（第 4/12/208 行附近），避免死注释。

   ⚠️ **搬 `regionLandmarkCenters` 时连带搬 `LANDMARK_CLEARANCE`**（它只用
   `region-config.js` 的常量，无外部依赖），否则新文件要从即将删除的 `mesa.js` import → 循环。

   ⚠️ **`landmarkCircles()`（含雪原的那份）只给 mesa 用 —— 直接删，不要搬**。

5. `src/tests/test-giant-pyramid.js` 里若有对 mesa 的断言，一并删除（先 `grep -n mesa src/tests/test-giant-pyramid.js` 确认）。
6. `src/tests/test-tarn-zone.js` 的「全部地标被压制」用例里，把 `'mesa'` 从断言清单里去掉。

7. **扫一遍还有谁引用 `mesa.js`（B8）**：

   ```bash
   grep -rn "mesa\.js\|computeMesaAnchor\|computeRegionLocalAnchor\|MESA_UNION_HALF\|MESA_BASE_RECT_HALF\|MESA_TOP_REL_Y\|MESA_SALT\|MESA_MIN_SPACING\|clearMesaAnchorCache" \
     src tests tools --include=*.js --include=*.mjs
   ```

   预期只剩 `src/gen/structures/landmark-circles.js` 的迁移注释。**任何残留的 import 都必须在
   这一步清掉**。**`src/tests/test-giant-pyramid.js` 有两处动态 import（`:149` 与 `:232`）
   用的是 `await import('../gen/structures/mesa.js')`，静态 `grep "import.*from '.*mesa"` 抓不到**，
   必须用上面那个模式扫。漏掉会让该测试文件**整体不加载**（浏览器里模块解析失败）。

   ⚠️ 那个文件里**两条测试整条依赖 mesa**，删 `mesa.js` 时必须一起处理：
   - `:148` 「与同 region 的高台占地不相交」—— mesa 消失后这条**失去被测对象**，整条删除；
   - `:231` 「金字塔常量：与高台的最近可能间距……」—— 同理删除；
   - 同时清理它们依赖的 `MESA_UNION_HALF` / `computeRegionLocalAnchor` 引用与顶部 import。

- [ ] **Step 3: 删烘焙工具与 package script**

```bash
git rm tools/bake-cloudland-mesa.mjs tools/cloudland-mesa-fingerprint.mjs
```

`package.json` 删 `"mesa": "node tools/bake-cloudland-mesa.mjs",`（`tarn` 已在 Task 1 加）。

- [ ] **Step 4: 删 `check-data.mjs` 的 `[高台]` 环节**

删 `checkCloudlandMesa()` 函数体与主流程那行调用（Task 8 已把它替换成 `checkCloudlandTarnZone()`，确认没有残留）。

- [ ] **Step 5: 全绿验证**

```bash
npm run check
npm test
```

预期：`check:arch` + `check:data` + `lint` 全绿；`npm test` 全绿（`mesa.spec.mjs` 已删，
新增的 `tarn-zone.spec.mjs` 通过）。

⚠️ **若 `npm test` 里有别的 spec 引用了 mesa**（`grep -rn "mesa" tests/`），一并清理。

- [ ] **Step 6: Commit**

```bash
# 按文件名 stage（AGENTS.md 纪律：git add -A 会扫进意外文件）
git rm src/gen/structures/mesa.js src/tests/test-mesa.js src/tests/test-mesa-gen.js \
       tests/mesa.spec.mjs tools/bake-cloudland-mesa.mjs tools/cloudland-mesa-fingerprint.mjs \
       assets/structures/cloudland_mesa_small.json assets/structures/cloudland_mesa_small.meta.json
git add src/gen/structures/structure-layout.js src/gen/structures/apply.js \
        src/gen/structures/structure-json.js src/gen/structures/giant-pyramid.js \
        src/gen/structures/landmark-circles.js \
        src/tests/index.html src/tests/test-giant-pyramid.js \
        tools/check-data.mjs package.json
git commit -m "refactor(gen): 删除沙漠孤立高台，由高台地带取代"
```

---

## Task 10: 性能与容量验收

**Files:**
- Modify: `src/render/render-world.js`（**预期不改**，仅当实测超线且用户裁定扩容时才动）
- Modify: `docs/superpowers/specs/2026-10-26-cloudland-tarn-zone-design.md`（回填实测值）

⚠️ **`src/render/render-world.js` 预期不改**（不扩容是用户裁定）。若实测峰值超 125,000，
**停下来报告**而不是改它 —— 改容量会撞破 §4.10 的冻结内存预算。

**Interfaces:**
- Consumes: `window.__BENCH__`、`window.__MC_GAME__.renderStats`；`npm run bench -- --check`
- Produces: 实测的 `transparent.active` 定值与 genP95 数据

- [ ] **Step 1: 测「地带 region 首个 GEN 的 genP95」（35 个 JSON 的预载成本）**

```bash
npm test -- tests/structure-gen.spec.mjs
```

记录 `genP95`。**门槛 = 8ms**（§1.2 的冻结预算）。若超 8ms：

- 先确认是否只有「地带 region 的首个 GEN」超（那是预载成本，与巨树 `giantPreloadPromise` 同性质）；
- 超了就在 Worker 的 `layout` 入口预热（照 `giantPreloadPromise` 的手法：模块加载期发起、不 await，
  `layout`/`gen` 入口 await 同一个 promise）。

- [ ] **Step 2: 在真游戏页读 transparent reservedV 峰值**

用临时探针（`.gitignore` 已忽略 `tests/tmp-*`）：

```javascript
// tests/tmp-tarn-budget.spec.mjs
import { test, expect } from '@playwright/test';

test('探针：地带视域的 transparent reservedV 峰值', async ({ page }) => {
  await page.goto('/?seed=12345&vd=8');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 120_000 });
  const peak = await page.evaluate(async () => {
    const { tarnZoneCenter } = await import('../../src/gen/structures/tarn-zone.js');
    const g = window.__MC_GAME__;
    const c = tarnZoneCenter(0, 0);   // ← 用 Task 7 Step 1 的真实地带 region（不能是 [0,0]，那是城市）
    // 本仓没有 player.setPosition() —— 直写 physics.pos（照 mesa.spec.mjs 的 teleport）
    const p = g.player.physics;
    p.pos.x = c.cx; p.pos.y = 60; p.pos.z = c.cz;
    p.vel.x = p.vel.y = p.vel.z = 0;
    let maxUsed = 0, maxReserved = 0;
    for (let i = 0; i < 400; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const rw = g.renderWorld;
      // reservedV 是逐 slot 字段（slotMap 的值），不在 stats() 里 —— 遍历它
      for (const slot of rw.slotMap.values()) {
        if (slot.channel !== 'transparent') continue;
        if (slot.reservedV > maxReserved) maxReserved = slot.reservedV;
        if (slot.vertexCount > maxUsed) maxUsed = slot.vertexCount;
      }
    }
    return { maxUsed, maxReserved, capacity: rw.stats().capacity.transparent };
  });
  console.log('transparent:', JSON.stringify(peak));
  expect(peak.maxReserved).toBeGreaterThan(0);
});
```

⚠️ **上面遍历的是单 slot 的 reservedV，不是全局已用总量**。全局占用是
`Σ slot.reservedV`（逐 slot 预留之和），而 `stats().capacity.transparent` 是
`{maxVerts, maxIndices}` 类的常量字典。需要全局峰值时把遍历改成 `Σ slot.reservedV`
并在每帧取最大值（峰值往往在跨 section 边界那一帧）。

- [ ] **Step 3: 按实测校正 `active`**

⚠️ **本步是验收，不是调参**（spec DR-5f 已裁定不扩容）：
**不要**因为「峰值低于预期」就下调 `active`，也不要因为「峰值接近上限」就自行上调 ——
两种情况都只记录实测值。

预期：**峰值 ≤ 125,000（即 `active: 100` 的原值就够）**：

- 若实测峰值 ≤ 125,000 → 不动 `CAPACITY`，把实测值回填进 **spec DR-7 的定稿实测表**
  （解析估算值是 reserved 98,235 = 78.6%）。
- 若实测峰值 **> 125,000** → **停下来报告**，不要自行扩容。可能原因：
  ① 有别的 transparent 内容（如紫晶柱的 `glass_block`）叠加；
  ② 水格估算偏低（解析式用「池面积 − 高台占地 − 紫晶柱占地」，而 mesher 实际发面数
  还受池边缘与台地交界的影响）。
  报告时附「峰值 / 125,000 / 超标来源」三项数据。

- [ ] **Step 4: 跑性能门禁**

```bash
npm run bench -- --check
```

预期：不阻断。

⚠️ **若阻断**：先做**交替对照**（`git stash` HEAD 与改动交错各跑 2~3 次）比两侧分布，
而不是看单次数值（既有约束：`frameP95` 的 vsync 量子化噪声 9↔10 会误报 11% 回退）。
⚠️ **不带 `--check` 跑 bench 会自动重写冻结基线** —— 诊断后必须复原（`git checkout docs/m3-baseline.*`
仅限**未提交**状态；若已提交则用 `git restore` 前先 `git status` 确认没有别的工作区改动）。

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-10-26-cloudland-tarn-zone-design.md
# ⚠️ 若实测未超线，render-world.js 无改动，不要 add 它
git commit -m "perf(render): 回填高台地带容量与 genP95 实测数据（不扩容）"
```

---

## Task 11: 文档回填

**Files:**
- Modify: `AGENTS.md`（`CLAUDE.md`）—— 活跃约束新增一节「高台地带沉淀的活跃约束」；
  目录结构清单加 `src/gen/structures/tarn-zone.js` / `tarn-terrain.js`、
  `tools/bake-cloudland-kit.mjs` / `cloudland-kit-fingerprint.mjs`；
  开发命令清单 `mesa` → `tarn`
- Modify: `docs/roadmap.md` —— 改动表加一条；「后续扩展点」里把云岛/高台相关项更新
- Modify: `docs/phase-1-engine-design.md` —— 修订说明加一条（**版本号只加在文档自身首行**）
- Modify: `docs/superpowers/specs/2026-10-26-cloudland-tarn-zone-design.md` —— 状态改「已实施」

**Interfaces:**
- Consumes: Task 1~10 的全部实测数据
- Produces: 文档

- [ ] **Step 1: 在 `AGENTS.md` 加活跃约束**

必须包含（每条都是从本设计的实测得出、会影响后续决策的）：

- 地带判定的唯一权威 = `isTarnZone()`；`CITY_REGION` 恒 false。
- `TARN_ZONE_RADIUS + 2 ≤ REGION_SIZE/2` 这条不等式（越界 ⇒ 地带半边永久消失）。
- **高台/拱洞/紫晶柱全部轴对齐摆放，不旋转**：`rasterizeStructure` 签名不动。
  ⚠️ 不要再提「加 4 向旋转让高台朝心」—— 旋转档位与环上角度 θ 无关，做不到「短边沿径向」
  （实测 L3 四角伸出池外 4.44 格）。
- **`TARN_RING_RADIUS = 58` 是实测标定值，不是公式**：它是「定稿 8 座四角全部落池内」的上限
  （59 起 L3 出池）。改池半径/改保留组合 → 必须重新穷举标定。
- **「四角最远」必须逐角算**（`hypot(ring·cosθ ± halfX, ring·sinθ ± halfZ)` 取极值），
  不能只看 `ring + min(halfX, halfZ)`（那是边中点，实测差 8.9 格 → 高台伸出池外而断言全绿）。
- **间距口径 = 轴对齐 AABB 真实最短距离**，`TARN_GAP = 4`。⚠️ 原值 10 是旋转假设下的口径，
  轴对齐下几何上达不到（真实间距 ~5 格）—— 用户第六轮裁定改为 4。
- 高台环的抖动必须钳制（`jitterMax` 由「AABB 真实间距仍 ≥ `TARN_GAP`」二分求出，× 0.8），否则破 `TARN_GAP`。
  ⚠️ 不能写 `缝角/2`（实测 7.62° 会让相邻高台**直接重叠**）。
- **紫晶柱内环 = 20（实测标定，上界 24）**：原公式 `max(12, ringR − max(half) − 30)` 在 ringR=58 下
  算出 12，而 7 个紫晶柱在内环 12 上**互相重叠 3 对**（最小距 −1.86）。
- **拱洞与高台/紫晶柱的 y 口径不同**：拱洞在池外台地（地表已占 `plateauY`）→ 最低层落
  `plateauY + 1`；高台与紫晶柱在池内 → 最低层落 `plateauY`。传错会把拱洞埋进台地。
- 池面的 CPU 版判据（`ocean-mask.js`）与 GPU 版（`ocean.js` 的 `uTarnPool`）必须同源。
- **`positionNode` 只能输出局部坐标**（`three.webgpu.js:21575` 是 `positionLocal.assign(...)`）；
  平面 `rotation.x = -π/2` ⇒ 抬升量加在**局部 z** 上。返回世界坐标会双重变换。
- transparent 容量的判据是 reserved（= 1.25 × 已用）相对初始容量常量，不是已用占比。
- 35 个产物必须惰性预载（只在 `isTarnZone` 为真时），否则 genP95 +30%。
- 雪原让路：`snowLandSuppressedByTarn()` 与 `pointContext` 的 `kind:'tarn'` 两处都要。
  ⚠️ **`layout.snowLand` 字段必须保留**（6 处既有消费方），让路只在 `apply.js` 阶段 1 跳过生成。
- 高台顶面是 `grass` 不是 `moss`（用户裁定），`check:data` 钉住。
- **`KIT_VARIANTS`/`KIT_METRICS` 住 `src/gen/structures/cloudland-kit-data.js`（零 node 依赖）**，
  `tools/cloudland-kit-fingerprint.mjs` re-export 它。⚠️ `src/**` 与浏览器单测**绝不能** import
  后者（它依赖 `node:fs` → 模块不加载 → 测试全不跑 / Worker 起不来 / 白屏）。

- [ ] **Step 2: 同步目录结构与开发命令**

在 `AGENTS.md` 的目录结构块加：

```
   ├─ gen/structures/tarn-zone.js   # 高台地带（Cloudland Tarn Zone）：region 级候选（确定性
   │                                #   判定 + 轴对齐环形布局 + 装饰落位）+ 雪原让路判据
   │                                #   （判定唯一权威 isTarnZone；Worker 同构）
   │                  tarn-terrain.js # 台地整形（草石噪声镶嵌 + 池底下沉 + 1 层水池）
   │                  cloudland-kit-data.js # 套件纯数据（KIT_VARIANTS/KIT_METRICS，零 node 依赖）
   │                  landmark-circles.js   # 从 mesa.js 搬出的地标圆（giant-pyramid 仍需）
```

开发命令块加：

```bash
npm run tarn                   # 烘焙 Cloudland 套件四族（11 高台 + 5 拱洞 + 7 紫晶柱 + 12 巨型云）
                               #   → assets/structures/cloudland_{tarn,arch,spire,giant_cloud}_NN.json
                               #   改 tools/cloudland-kit-fingerprint.mjs 或 .schem 后需跑，
                               #   否则产物静默过期（check:data 的 [高台地带] 指纹检查会抓）
```

并删除 `npm run mesa` 那一行。

- [ ] **Step 3: 更新 roadmap 与设计文档修订说明**

`docs/roadmap.md` 的改动表加一行（版本号连续），`docs/phase-1-engine-design.md` 的修订说明加对应条目，
spec 的状态从「待评审」改「已实施（YYYY-MM-DD）」。

- [ ] **Step 4: 全量验证**

```bash
npm run check
npm test
```

预期：全绿。

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md docs/roadmap.md docs/phase-1-engine-design.md docs/superpowers/specs/2026-10-26-cloudland-tarn-zone-design.md
git commit -m "docs: 高台地带交付回填（活跃约束 / 目录结构 / 开发命令 / roadmap）"
```


---

## 附录：任务间的依赖顺序

```
Task 1（烘焙）
  └─→ Task 2（判定+布局，需要 KIT_METRICS）
        ├─→ Task 3（压制地标+雪原让路）
        └─→ Task 4（台地整形）
              └─→ Task 5（structure-json + 阶段 2.4 + 云）
                    ├─→ Task 6（池面渲染 + 容量）
                    │     └─→ Task 7（Tier 4）
                    │           └─→ Task 10（性能验收）
                    └─→ Task 8（数据门）
Task 9（删 mesa）依赖 Task 3 与 Task 5 完成（否则会打断正在工作的引用）
Task 11（文档）最后
```

⚠️ **Task 12（`rasterizeStructure` 4 向旋转）已在第四轮审阅中整体删除**：方案 A 被实测否决
（旋转档位与环上角度 θ 无关，做不到「短边沿径向」，L3 四角伸出池外 4.44 格，spec DR-7 致命 1′）。
用户第六轮裁定改为**方案 1：轴对齐摆放 + ringR=58**，`rasterizeStructure` 签名不动、零新增旋转机制。

⚠️ **Task 9 必须在 Task 3 + Task 5 之后**：Task 3 的测试断言 `l.mesa === null`（字段还在），
Task 5 完成后 `apply.js` 已不再依赖阶段的 2.75。提前删会让 Task 3/5 的测试无法运行。
