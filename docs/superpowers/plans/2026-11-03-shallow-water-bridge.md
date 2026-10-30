# 浅水高台跨湖拱桥 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在每个 seed 的浅水高台上生成一座横跨湖面的单层、3 格宽余弦拱桥，两端顺坡落到干燥沙岸，可用玩家走过去。

**Architecture:** 新增一个 Worker 同构纯函数模块 `shallow-water-bridge.js`，负责「桥轴搜索 → 剖面高度 → 材质分片 → 按 column 栅格化」四件事；`apply.js` 阶段 2.45 增加第 ⑤ 步调用它。桥轴只有 `+X` / `+Z` 两条候选（斜向无法满足严格 3 格宽，实测见 spec §15.5），按「两端干燥 + 过五座高台净空」择优。

**Tech Stack:** 纯 ES2022 JavaScript + JSDoc，无 TypeScript、无 bundler。浏览器内单测用自建 runner（`src/tests/runner.js`），E2E 用 Playwright。

**Spec:** `docs/superpowers/specs/2026-11-01-shallow-water-tarns-design.md` §15

## Global Constraints

- **禁止 TypeScript、禁止编译/转译/bundler**；纯 ES Modules + JSDoc。
- **Worker 同构层**：`src/gen/**` 不得 import three、不得 fetch、不得自建 Worker（`npm run check:arch` 静态门守）。
- **数据只有一份权威**（红线 1）：桥的几何与材质判据只在 `shallow-water-bridge.js` 一份，`apply.js`、单测、E2E 全部调它，不得各写一份。
- **禁止站点根绝对路径**：新增资源引用必须走 `resourceUrl()`；本计划不新增资源文件，故此约束不触发。
- **新增 salt 前必须程序化扫描占用**。本计划占用 **1038**（已扫描确认空闲）。
- **不新增方块、不新增贴图**：六种桥材质全是既有方块。
- **生成路径不记 edits、不 bump version**（与 `fillShallowTarnBasin` 同口径）。
- 修改 `src/**/*.js` 后跑 `npm run lint`，新增代码 0 error。
- **不自动提交**：每个 Task 的 commit 步骤需用户明确指令后才执行。

## Review Focus

- **桥在某条轴上一端找不到干燥落点**（该侧整段湖岸都是水下坡）→ 期望：换另一条轴；两条都失败 → 返回 `null`、不生成桥、**不阻断 GEN**，世界里只是没有桥。
- **桥面与高台顶部净空为负**（桥面钻进台体）→ 期望：该轴被判非法，选另一条；不出现「桥在台子里凭空消失几段」的画面。
- **桥面相邻两列高差 > 1 格** → 期望：玩家走不上去。剖面必须保证 `|y(s+1) − y(s)| ≤ 1` 全程成立。
- **桥两端最后一格与岸上地表差 1 格或悬空** → 期望：端部格 `y = 该列地表 y`，玩家踩上去高差 0。
- **材质分片退化成逐格棋盘 或 出现整段只有一种材质** → 期望：片长 8~15 格、六种材质都出现、相邻两片不同色。

---

### Task 1: 桥轴搜索（`computeShallowTarnBridge`）

**Files:**
- Create: `src/gen/structures/shallow-water-bridge.js`
- Test: `src/tests/test-shallow-water-bridge.js`（新建）
- Modify: `src/tests/index.html:57` 附近（在 `import './test-shallow-water-tarns.js';` 之后加一行）

**Interfaces:**
- Consumes:
  - `computeShallowTarnAnchor(seed) → {wx, wz, lakeFloorY, cityBounds, hardRadius} | null`（`./shallow-water-tarns.js`）
  - `computeShallowTarnLayout(seed) → Array<{variant, ang, cx, cz, loX, hiX, loZ, hiZ}>`（同上）
  - `shallowTarnLakeRadiusAt(angleRad, phase) → number`、`shallowTarnShapePhase(seed) → number`（同上）
  - `shallowTarnSurfaceYAt(wx, wz, seed, anchor) → number`（`./shallow-water-terrain.js`）
  - `BEACH_WIDTH`（=7）、`SLOPE_WIDTH`（=24）、`SEA_Y`（=`../../voxel/constants.js`）
  - `SHALLOW_TARN_VARIANTS` / `SHALLOW_TARN_METRICS`（`./shallow-water-tarn-data.js`）
  - `loadStructure(type) → {palette, blocks, stride}`（`./structure-json.js`；Node 侧会静默返回空，故本 Task 的**纯函数不读结构**，只吃注入的 `platformTop`）
- Produces:
  - `BRIDGE_APEX_Y = 47`
  - `BRIDGE_SALT = 1038`
  - `computeShallowTarnBridge(seed, platformTop) → {axis:'X'|'Z', ux:number, uz:number, apex:number, halfP:number, halfN:number, endYP:number, endYN:number, span:number} | null`
    - `halfP`/`halfN` = 湖心到两侧落点的距离（整数）
    - `endYP`/`endYN` = 两侧落点地表 y
    - `ux`/`uz` ∈ `{±1, 0}` 且恰有一个非 0
    - `platformTop` = `Map<'x,z', number>`（键 `wx + ',' + wz`，值 = 该列最顶层桥要避让的方块 y）。`null` / 空 Map 时跳过净空判据
  - `BRIDGE_MIN_CLEARANCE = 3`

- [ ] **Step 1: 写失败测试**

创建 `src/tests/test-shallow-water-bridge.js`。**文件头部包含一个模块级 `registry()` 单例**
（避免每条用例各建一次 138 个方块；与 `test-shallow-water-tarns.js` 同手法）：

```js
// src/tests/test-shallow-water-bridge.js — 浅水高台跨湖拱桥：纯函数层 + 栅格化层
//
// 权威：docs/superpowers/specs/2026-11-01-shallow-water-tarns-design.md §15
import { test } from './runner.js';
import {
  assertEqual, assertTrue, assertFalse, assertNotNull, assertNotEqual,
} from './assert.js';
import { SEA_Y, blockIndex, WORLD_MIN_Y, WORLD_MAX_Y } from '../voxel/constants.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { createRegistry } from '../voxel/block-registry.js';
import { fillColumn } from '../gen/terrain.js';
import { carveCaves } from '../gen/caves.js';
import {
  computeShallowTarnAnchor, clearShallowTarnCache,
} from '../gen/structures/shallow-water-tarns.js';
import { shallowTarnSurfaceYAt, clearShallowTarnTerrainCache } from '../gen/structures/shallow-water-terrain.js';
import {
  computeShallowTarnBridge, shallowTarnBridgeDeckY,
  clearShallowTarnBridgeCache, BRIDGE_APEX_Y, BRIDGE_MIN_CLEARANCE, BRIDGE_SALT,
} from '../gen/structures/shallow-water-bridge.js';

const SEEDS = [12345, 1, 2, 88, 20240101, 424242, 5150, 7, 999, 2026];

/** 供多组用例复用的 registry（模块级单例，136+ 方块；Task 3 起用到） */
let registryCache = null;
function registry() {
  if (registryCache) return registryCache;
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  registryCache = reg;
  return reg;
}
```

⚠️ **只 import 本 Task 已实现的导出**。后续 Task 实现新函数时，在**它自己的 Step**
里把它追加到这个 import 块（Task 3 加 `BRIDGE_MATERIALS` / `BRIDGE_SEG_*` /
`shallowTarnBridgeBlockAt` / `bridgeSegments`，Task 4 加 `rasterizeShallowTarnBridge`）。
一次性把全部名字都 import 进来会让中间几 Task 的页面整页报解析错误
（未导出的具名 import 是**模块级** SyntaxError，不是用例内失败）。

然后是**桥轴的七条用例**（纯函数层）：

```js
test('桥：每个 seed 都有合法桥轴', () => {
  for (const seed of SEEDS) {
    const bridge = computeShallowTarnBridge(seed, new Map());
    assertNotNull(bridge, `seed ${seed} 没有合法桥轴`);
  }
});

test('桥：轴恰好是 +X 或 +Z 之一（吸附正轴）', () => {
  for (const seed of SEEDS) {
    const b = computeShallowTarnBridge(seed, new Map());
    const isUnitX = Math.abs(b.ux) === 1 && b.uz === 0;
    const isUnitZ = b.ux === 0 && Math.abs(b.uz) === 1;
    assertTrue(isUnitX || isUnitZ, `seed ${seed}: (ux, uz) = (${b.ux}, ${b.uz}) 不是正轴`);
    assertEqual(b.axis, isUnitX ? 'X' : 'Z', `seed ${seed}: axis 字段与 (ux,uz) 不一致`);
  }
});

test('桥：两端落点是干燥地面（地表 ≥ SEA_Y）', () => {
  for (const seed of SEEDS) {
    const b = computeShallowTarnBridge(seed, new Map());
    assertTrue(b.endYP >= SEA_Y, `seed ${seed}: +侧落点 y=${b.endYP} < SEA_Y`);
    assertTrue(b.endYN >= SEA_Y, `seed ${seed}: -侧落点 y=${b.endYN} < SEA_Y`);
  }
});

test('桥：跨度落在实测区间（160~205 格）', () => {
  for (const seed of SEEDS) {
    const b = computeShallowTarnBridge(seed, new Map());
    assertTrue(b.span >= 160 && b.span <= 205, `seed ${seed}: span=${b.span} 超出 160~205`);
    assertEqual(b.span, b.halfP + b.halfN, `seed ${seed}: span 应等于 halfP + halfN`);
  }
});

test('桥：弧顶高度 = BRIDGE_APEX_Y', () => {
  assertEqual(BRIDGE_APEX_Y, 47);
  for (const seed of SEEDS) {
    const b = computeShallowTarnBridge(seed, new Map());
    assertEqual(b.apex, BRIDGE_APEX_Y, `seed ${seed}: apex 应为 ${BRIDGE_APEX_Y}`);
  }
});

test('桥：同一 seed 两次调用逐字段相同（确定性 + 缓存不破坏纯函数性）', () => {
  for (const seed of SEEDS) {
    const a = computeShallowTarnBridge(seed, new Map());
    const c = computeShallowTarnBridge(seed, new Map());
    assertEqual(JSON.stringify(a), JSON.stringify(c), `seed ${seed}: 两次调用结果不同`);
  }
});

test('桥：净空不足时该轴被判非法（注入高墙的负向对照）', () => {
  const seed = 12345;
  const b = computeShallowTarnBridge(seed, new Map());
  const anchor = computeShallowTarnAnchor(seed);
  // 沿**两条轴都**堆一道比桥面还高的墙 → 应返回 null
  const blocked = new Map();
  for (const [ux, uz] of [[1, 0], [0, 1]]) {
    for (let s = -110; s <= 110; s++) {
      for (const off of [-1, 0, 1]) {
        const x = anchor.wx + ux * s + (-uz) * off;
        const z = anchor.wz + uz * s + ux * off;
        blocked.set(`${x},${z}`, BRIDGE_APEX_Y + 10);
      }
    }
  }
  assertEqual(computeShallowTarnBridge(seed, blocked), null,
    '两条轴都被超高墙挡住时应返回 null（否则桥会钻进墙体）');
  assertNotNull(b, '未注入障碍时该 seed 应有合法轴');
});
```

（以上为 Step 1 的测试内容；接下来七条 + 本条的代码均写入同一个文件。）

```js
test('桥：净空判据的阈值是 BRIDGE_MIN_CLEARANCE', () => {
  assertEqual(BRIDGE_MIN_CLEARANCE, 3);
  assertTrue(BRIDGE_MIN_CLEARANCE > 0 && BRIDGE_MIN_CLEARANCE < 10);
});

test('桥：缓存隔离 —— clearShallowTarnCache 之后结果不变（纯函数）', () => {
  const seed = 12345;
  const before = JSON.stringify(computeShallowTarnBridge(seed, new Map()));
  clearShallowTarnCache();
  clearShallowTarnTerrainCache();
  const after = JSON.stringify(computeShallowTarnBridge(seed, new Map()));
  assertEqual(after, before, '清缓存后桥轴变了 → 说明有非纯函数状态泄漏');
});
```

- [ ] **Step 2: 注册测试文件并确认 RED**

在 `src/tests/index.html` 的第 57 行 `import './test-shallow-water-tarns.js';` 之后加一行：

```html
    import './test-shallow-water-bridge.js';
```

`src/gen/structures/shallow-water-bridge.js` **尚不存在**，故 run 时该模块解析失败。

Run: `npm start`（后台）后打开 `http://localhost:8081/src/tests/index.html`，或
Run: `npx playwright test tests/harness.spec.mjs`（`harness.spec.mjs` 会加载整页单测）
Expected: FAIL —— 模块 `../gen/structures/shallow-water-bridge.js` 无法解析（`Failed to fetch dynamically imported module` / 整页用例不跑）。这就是 RED。

- [ ] **Step 3: 实现 `computeShallowTarnBridge`**

创建 `src/gen/structures/shallow-water-bridge.js`，本步只写常量与桥轴搜索：

```js
// src/gen/structures/shallow-water-bridge.js — 浅水高台跨湖拱桥：桥轴、剖面、材质、栅格化
//
// 设计文档：docs/superpowers/specs/2026-11-01-shallow-water-tarns-design.md §15
//
// Worker 同构：本文件不得 import three、不得 fetch、不得自建 Worker。
import { SEA_Y } from '../../voxel/constants.js';
import {
  computeShallowTarnAnchor, computeShallowTarnLayout,
  shallowTarnLakeRadiusAt, shallowTarnShapePhase,
  BEACH_WIDTH, SLOPE_WIDTH,
} from './shallow-water-tarns.js';
import { shallowTarnSurfaceYAt } from './shallow-water-terrain.js';

/** 弧顶高度（标定值，见 spec §15.3） */
export const BRIDGE_APEX_Y = 47;

/** 桥面与高台顶部的最小净空（格） */
export const BRIDGE_MIN_CLEARANCE = 3;

/** 桥轴搜索 / 材质分片的 salt（1038 经程序化扫描确认空闲） */
export const BRIDGE_SALT = 1038;

/** 桥宽（格）—— 中线 + 法向 ±1 */
export const BRIDGE_WIDTH = 3;

const bridgeCache = new Map();
const BRIDGE_CACHE_MAX = 64;

/** 清空桥轴缓存（单测隔离用） */
export function clearShallowTarnBridgeCache() {
  bridgeCache.clear();
}

/**
 * 沿某条正轴找该侧的干燥落点。
 * @returns {{d:number, y:number}|null}
 */
function findLanding(anchor, seed, sign, ux, uz, baseAngle) {
  const dirAngle = sign > 0 ? baseAngle : baseAngle + Math.PI;
  const rr = shallowTarnLakeRadiusAt(dirAngle, shallowTarnShapePhase(seed));
  for (let e = 0; e <= BEACH_WIDTH + SLOPE_WIDTH; e += 0.5) {
    const d = Math.max(1, Math.round(rr + e));
    const x = anchor.wx + ux * d * sign;
    const z = anchor.wz + uz * d * sign;
    const y = shallowTarnSurfaceYAt(x, z, seed, anchor);
    if (y >= SEA_Y) return { d, y };
  }
  return null;
}

/**
 * 某条正轴上的最小净空（桥面 y − 平台顶 y）。
 * @returns {number} Infinity 表示轴上没有任何平台
 */
function axisClearance(anchor, bridge, platformTop) {
  if (!platformTop || platformTop.size === 0) return Infinity;
  const { ux, uz } = bridge;
  const nx = -uz;
  const nz = ux;
  let worst = Infinity;
  for (let s = -bridge.halfN; s <= bridge.halfP; s++) {
    const deckY = shallowTarnBridgeDeckY(s, bridge);
    for (let off = -1; off <= 1; off++) {
      const x = anchor.wx + ux * s + nx * off;
      const z = anchor.wz + uz * s + nz * off;
      const top = platformTop.get(`${x},${z}`);
      if (top === undefined) continue;
      const clear = deckY - top;
      if (clear < worst) worst = clear;
    }
  }
  return worst;
}
```

同一步实现 `computeShallowTarnBridge`：

- 候选表 = `[{axis:'X', ux:1, uz:0, baseAngle:0}, {axis:'Z', ux:0, uz:1, baseAngle:Math.PI/2}]`
- 对每个候选：`findLanding` 两侧都要非 `null`，否则跳过
- 构造 `bridge = {axis, ux, uz, apex: BRIDGE_APEX_Y, halfP: lp.d, halfN: ln.d, endYP: lp.y, endYN: ln.y, span: lp.d + ln.d}`
- `clearance = axisClearance(...)`；`clearance < BRIDGE_MIN_CLEARANCE` → 跳过该轴
- 取 `clearance` 最大者；相等时取 `+X`（候选表顺序，确定性）
- 结果缓存键 = `seed`（`platformTop` 为空 Map 时才缓存；非空 Map 走实时计算，避免污染）
- 无候选合法 → 缓存 `null` 并返回 `null`

- [ ] **Step 4: 补 `shallowTarnBridgeDeckY`（Task 1 的测试需要它）**

同文件加（余弦拱，spec §15.3）：

```js
/**
 * 桥面高度（余弦拱）。s = 沿桥轴到湖心的整数偏移。
 * y(s) = round(endY + (apex − endY) · (cos(π·|s|/half) + 1) / 2)
 */
export function shallowTarnBridgeDeckY(s, bridge) {
  const half = s >= 0 ? bridge.halfP : bridge.halfN;
  const endY = s >= 0 ? bridge.endYP : bridge.endYN;
  const t = Math.min(1, Math.abs(s) / half);
  return Math.round(endY + (bridge.apex - endY) * ((Math.cos(Math.PI * t) + 1) / 2));
}
```

- [ ] **Step 5: 跑测试确认 GREEN**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: PASS，`failed: 0`。

若「净空不足时该轴被判非法」失败：说明候选轴的回退逻辑写成了「一条失败即整体 null」，
应改为「逐轴尝试、取最好的那条」。

- [ ] **Step 6: Commit**

```bash
git add src/gen/structures/shallow-water-bridge.js src/tests/test-shallow-water-bridge.js src/tests/index.html
git commit -m "feat(gen): 浅水高台跨湖拱桥 —— 桥轴搜索（吸附正轴 + 净空择优）"
```

---

### Task 2: 余弦拱剖面的可步行性

**Files:**
- Modify: `src/gen/structures/shallow-water-bridge.js`（`shallowTarnBridgeDeckY` 已存在，本 Task 只加测试与必要的取整保证）
- Test: `src/tests/test-shallow-water-bridge.js`

**Interfaces:**
- Consumes: Task 1 的 `computeShallowTarnBridge` / `shallowTarnBridgeDeckY`
- Produces: 不变（`shallowTarnBridgeDeckY` 签名不变）

- [ ] **Step 1: 写失败测试**

追加到 `src/tests/test-shallow-water-bridge.js`：

```js
test('桥：剖面相邻两列高差 ≤ 1（玩家能走上去，MAX_STEP = 1.0）', () => {
  for (const seed of SEEDS) {
    const b = computeShallowTarnBridge(seed, new Map());
    let prev = null;
    for (let s = -b.halfN; s <= b.halfP; s++) {
      const y = shallowTarnBridgeDeckY(s, b);
      if (prev !== null) {
        assertTrue(Math.abs(y - prev) <= 1,
          `seed ${seed}: s=${s} 处高差 ${Math.abs(y - prev)} > 1（玩家走不上去）`);
      }
      prev = y;
    }
  }
});

test('桥：湖心是弧顶、两端是落点地表（剖面端点值）', () => {
  for (const seed of SEEDS) {
    const b = computeShallowTarnBridge(seed, new Map());
    assertEqual(shallowTarnBridgeDeckY(0, b), BRIDGE_APEX_Y, `seed ${seed}: s=0 不是弧顶`);
    assertEqual(shallowTarnBridgeDeckY(b.halfP, b), b.endYP, `seed ${seed}: +端不是落点地表`);
    assertEqual(shallowTarnBridgeDeckY(-b.halfN, b), b.endYN, `seed ${seed}: -端不是落点地表`);
  }
});

test('桥：剖面单调 —— 从任一端走向湖心不出现下降', () => {
  for (const seed of SEEDS) {
    const b = computeShallowTarnBridge(seed, new Map());
    let prev = shallowTarnBridgeDeckY(-b.halfN, b);
    for (let s = -b.halfN + 1; s <= 0; s++) {
      const y = shallowTarnBridgeDeckY(s, b);
      assertTrue(y >= prev, `seed ${seed}: 从 -端 走向湖心在 s=${s} 处下降了`);
      prev = y;
    }
  }
});

test('桥：整座桥全程都在地表之上（不埋进地形）', () => {
  for (const seed of SEEDS) {
    const b = computeShallowTarnBridge(seed, new Map());
    const anchor = computeShallowTarnAnchor(seed);
    for (let s = -b.halfN; s <= b.halfP; s++) {
      const y = shallowTarnBridgeDeckY(s, b);
      for (let off = -1; off <= 1; off++) {
        const x = anchor.wx + b.ux * s + (-b.uz) * off;
        const z = anchor.wz + b.uz * s + b.ux * off;
        const ground = shallowTarnSurfaceYAt(x, z, seed, anchor);
        assertTrue(y >= ground, `seed ${seed}: s=${s} off=${off} 桥面 y=${y} 低于地表 ${ground}`);
      }
    }
  }
});
```

- [ ] **Step 2: 跑测试**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: **PASS 全部四条**。余弦拱的端部斜率为 0，实测最大相邻高差恒为 1，
所以这四条是对已有实现的**回归门**而非新功能。

若任一条 FAIL，说明 `shallowTarnBridgeDeckY` 的取整或 `Math.min(1, ...)` 钳制写错了 ——
先打印失败那一点附近的 `s / y / prev` 三元组再改，**不要直接放宽断言**。

- [ ] **Step 3: Commit**

```bash
git add src/tests/test-shallow-water-bridge.js
git commit -m "test(gen): 跨湖拱桥剖面可步行性（相邻高差 ≤1 / 单调 / 不埋地形）"
```

---

### Task 3: 材质分片

**Files:**
- Modify: `src/gen/structures/shallow-water-bridge.js`
- Test: `src/tests/test-shallow-water-bridge.js`

**Interfaces:**
- Consumes: Task 1 的 `BRIDGE_SALT`、`shallowTarnBridgeDeckY`
- Produces:
  - `BRIDGE_MATERIALS: readonly string[]`（`['cloud','ice','dark_grass','light_grass','marble','sky_stone']`）
  - `BRIDGE_SEG_MIN_LEN = 8`
  - `BRIDGE_SEG_SCALE = 0.03`
  - `shallowTarnBridgeBlockAt(s, bridge, seed) → string`（返回 `BRIDGE_MATERIALS` 中的一个）

- [ ] **Step 1: 写失败测试**

追加：

```js
test('桥：材质只取六种已声明的方块', () => {
  assertEqual(BRIDGE_MATERIALS.length, 6);
  const legal = new Set(BRIDGE_MATERIALS);
  for (const seed of SEEDS) {
    const b = computeShallowTarnBridge(seed, new Map());
    for (let s = -b.halfN; s <= b.halfP; s++) {
      const name = shallowTarnBridgeBlockAt(s, b, seed);
      assertTrue(legal.has(name), `seed ${seed} s=${s}: 材质 "${name}" 不在六种之内`);
    }
  }
});

test('桥：材质必须是既有方块且全部走 opaque 通道（静态内存零增量）', async () => {
  const { BLOCKS } = await import('../voxel/blocks-data.js');
  for (const name of BRIDGE_MATERIALS) {
    const def = BLOCKS.find((x) => x.name === name);
    assertNotNull(def, `材质 ${name} 未在 blocks-data.js 注册（makeColumnSetter 会静默 return）`);
    assertEqual(def.cullMode, 'opaque', `${name} 的 cullMode 应为 opaque（否则撞容量预算）`);
  }
});

test('桥：材质里没有叶子方块（用户明确要求「用非叶子方块」）', () => {
  for (const name of BRIDGE_MATERIALS) {
    assertFalse(/leaves|flower|azalea/.test(name), `材质 ${name} 是叶子族，违反用户要求`);
  }
});

test('桥：相邻两片材质必不同色', () => {
  for (const seed of SEEDS) {
    const b = computeShallowTarnBridge(seed, new Map());
    const segs = bridgeSegments(b, seed);        // 供测试的派生视图，见 Step 3
    for (let i = 1; i < segs.length; i++) {
      assertNotEqual(segs[i].material, segs[i - 1].material,
        `seed ${seed}: 第 ${i-1}/${i} 片同为 ${segs[i].material}`);
    }
  }
});

test('桥：片长 ≥ BRIDGE_SEG_MIN_LEN（首尾被截断的除外）', () => {
  for (const seed of SEEDS) {
    const b = computeShallowTarnBridge(seed, new Map());
    const segs = bridgeSegments(b, seed);
    for (let i = 1; i < segs.length - 1; i++) {
      assertTrue(segs[i].len >= BRIDGE_SEG_MIN_LEN,
        `seed ${seed}: 第 ${i} 片长 ${segs[i].len} < ${BRIDGE_SEG_MIN_LEN}`);
    }
  }
});

test('桥：六种材质都出现过（不是退化成两三种）', () => {
  const seen = new Set();
  for (const seed of SEEDS) {
    const b = computeShallowTarnBridge(seed, new Map());
    for (let s = -b.halfN; s <= b.halfP; s++) seen.add(shallowTarnBridgeBlockAt(s, b, seed));
  }
  for (const name of BRIDGE_MATERIALS) {
    assertTrue(seen.has(name), `材质 ${name} 在 10 个 seed 里一次都没出现`);
  }
});

test('桥：分片不是逐格棋盘（同色游程的中位长度 > 4）', () => {
  const lens = [];
  for (const seed of SEEDS) {
    const b = computeShallowTarnBridge(seed, new Map());
    const segs = bridgeSegments(b, seed);
    for (let i = 1; i < segs.length - 1; i++) lens.push(segs[i].len);
  }
  lens.sort((a, b) => a - b);
  const median = lens[Math.floor(lens.length / 2)];
  assertTrue(median > 4, `同色游程中位长度 ${median} ≤ 4 → 退化成棋盘噪点`);
});
```

同一步在测试文件顶部补 import —— **已在 Step 1 的头块里全部预置**，此步无需重复。

Step 1 的头块已 import `assertNotEqual` / `assertFalse` / `bridgeSegments` / `shallowTarnBridgeBlockAt`
等本 Task 才用到的名字，所以 Task 1 跑时它们会是 `undefined`——**这是预期的**：
Task 1 的 Step 5 只要求「桥轴」那批用例通过；`test()` 在文件加载期就注册所有用例，
未实现的导出会成为那个用例内的 TypeError，不会拖垒整个文件。
若 runner 的失败计数因此变红，把本 Task 的用例**先写到独立文件**
`src/tests/test-shallow-water-bridge-materials.js`，Task 3 完成后再合并——两步都可行，
但**不要删用例来让中间态变绿**。

- [ ] **Step 2: 跑测试确认 RED**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: FAIL —— `BRIDGE_MATERIALS` 等为 undefined、`shallowTarnBridgeBlockAt`、`bridgeSegments` 未定义。

- [ ] **Step 3: 实现材质分片**

同文件加（spec §15.6 的实测算法）：

```js
/** 六种桥材质（用户点名，全部 opaque 通道） */
export const BRIDGE_MATERIALS = Object.freeze([
  'cloud', 'ice', 'dark_grass', 'light_grass', 'marble', 'sky_stone',
]);

/** 最小片长（格）—— 短于此的片段并入相邻片 */
export const BRIDGE_SEG_MIN_LEN = 8;

/** 1D 分段场的尺度（0.03，20 seed 实测片长 min 8 / p25 12 / 中位 14 / p75 19） */
export const BRIDGE_SEG_SCALE = 0.03;

/**
 * 1D 不可分离场：与 `tarn-terrain.js` 的 `blobNoise` 同构（sin·cos 交叉耦合 + hypot 项），
 * 但只吃沿桥轴的 `s`（桥宽 3 格，横向分片没有意义）。
 *
 * ⚠️ 不能用 `noise()`：它可分离相加 ⇒ 等值线是十字/菱形，分界会出现长直线段。
 */
function bridgeField(s, seed) {
  const nx = s * BRIDGE_SEG_SCALE;
  const nz = seed * 0.37;
  const sc = seed + BRIDGE_SALT;
  const a = Math.sin(nx + sc * 0.013) * Math.cos(nz * 0.9 + sc * 0.021) * 2;
  const b = Math.sin(nx * 0.7 + nz * 1.3 + sc * 0.017) * 1.4;
  const c = Math.cos(Math.hypot(nx * 0.82, nz) * 1.1 + sc * 0.011) * 0.6;
  return a + b + c;
}

/**
 * 桥的分片视图（供 `shallowTarnBridgeBlockAt` 与测试共用，红线 1 只有这一份）。
 * @returns {Array<{start:number, len:number, material:string}>}
 */
export function bridgeSegments(bridge, seed) {
  const s0 = -bridge.halfN;
  const s1 = bridge.halfP;
  const n = s1 - s0 + 1;
  const values = new Array(n);
  let vmin = Infinity;
  let vmax = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = bridgeField(s0 + i, seed);
    values[i] = v;
    if (v < vmin) vmin = v;
    if (v > vmax) vmax = v;
  }
  const span = (vmax - vmin) || 1;
  const N = BRIDGE_MATERIALS.length;
  // ① 按归一化值的等值线切原始片段
  const raw = [];
  let start = 0;
  let prevBucket = Math.min(N - 1, Math.floor(((values[0] - vmin) / span) * N));
  for (let i = 1; i < n; i++) {
    const bucket = Math.min(N - 1, Math.floor(((values[i] - vmin) / span) * N));
    if (bucket !== prevBucket) {
      raw.push({ start, len: i - start, bucket: prevBucket });
      start = i;
      prevBucket = bucket;
    }
  }
  raw.push({ start, len: n - start, bucket: prevBucket });
  // ② 游程合并：短片段并入前一片（保证最小片长）
  const merged = [];
  for (const r of raw) {
    if (merged.length && r.len < BRIDGE_SEG_MIN_LEN) {
      merged[merged.length - 1].len += r.len;
      continue;
    }
    if (merged.length && merged[merged.length - 1].len < BRIDGE_SEG_MIN_LEN) {
      merged[merged.length - 1].len += r.len;
      merged[merged.length - 1].bucket = r.bucket;
      continue;
    }
    merged.push({ ...r });
  }
  // ③ 上色：强制相邻两片不同色
  const out = [];
  for (const seg of merged) {
    let bucket = seg.bucket;
    if (out.length && BRIDGE_MATERIALS[bucket] === out[out.length - 1].material) {
      bucket = (bucket + 1) % N;
    }
    out.push({ start: s0 + seg.start, len: seg.len, material: BRIDGE_MATERIALS[bucket] });
  }
  return out;
}

/** 某格桥面的材质（纯函数） */
export function shallowTarnBridgeBlockAt(s, bridge, seed) {
  const segs = bridgeSegments(bridge, seed);
  for (let i = segs.length - 1; i >= 0; i--) {
    if (s >= segs[i].start) return segs[i].material;
  }
  return segs[0].material;
}
```

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: PASS。若「六种材质都出现过」失败，调 `BRIDGE_SEG_SCALE` 后重跑 ——
但 `0.03` 是 20 seed 实测值（六种全出现），先打印实际出现的集合再动。

- [ ] **Step 5: Commit**

```bash
git add src/gen/structures/shallow-water-bridge.js src/tests/test-shallow-water-bridge.js
git commit -m "feat(gen): 跨湖拱桥材质分片（等值线分片 + 游程合并 + 强制相邻异色）"
```

---

### Task 4: 按 column 栅格化

**Files:**
- Modify: `src/gen/structures/shallow-water-bridge.js`
- Test: `src/tests/test-shallow-water-bridge.js`

**Interfaces:**
- Consumes: Task 1~3 全部导出；`makeColumnSetter` 同款的 `setBlock(wx, y, wz, name, meta?)`
- Produces:
  - `rasterizeShallowTarnBridge(column, anchor, seed, registry, setBlock, platformTop) → void`
    - `column`：`ChunkColumn`（用 `column.cx * 16` / `column.cz * 16` 定本列范围）
    - 按本 column 覆盖的 `s` 区间裁剪，只写落在本列的格
    - 每格只写 **1 格**（`y = shallowTarnBridgeDeckY(s, bridge)`），不写上下相邻层

- [ ] **Step 1: 写失败测试**

追加：

```js
test('桥：真实 column GEN —— 桥面在三个 column 里都写出来了', () => {
  const seed = 12345;
  const anchor = computeShallowTarnAnchor(seed);
  const b = computeShallowTarnBridge(seed, new Map());
  const reg = registry();
  // 取桥轴中心处与两侧各 40 格的三个 column
  const cols = [-40, 0, 40].map((ds) => {
    const x = anchor.wx + b.ux * ds;
    const z = anchor.wz + b.uz * ds;
    return Math.floor(x / 16) * 16 + ',' + Math.floor(z / 16) * 16;
  });
  let written = 0;
  for (const key of cols) {
    const [cx, cz] = key.split(',').map(Number);
    const col = new ChunkColumn(cx / 16, cz / 16);
    fillColumn(col, seed);
    carveCaves(col, seed);
    const seen = [];
    const setBlock = (wx, y, wz, name, meta = 0) => {
      if (wx < cx || wx > cx + 15 || wz < cz || wz > cz + 15) return;
      seen.push({ wx, y, wz, name });
      col.blocks[blockIndex(wx - cx, y, wz - cz)] = reg.idOf(name);
    };
    rasterizeShallowTarnBridge(col, anchor, seed, reg, setBlock, new Map());
    written += seen.length;
    for (const cell of seen) {
      assertTrue(BRIDGE_MATERIALS.includes(cell.name), `写入了非桥材质 ${cell.name}`);
      assertEqual(col.blocks[blockIndex(cell.wx - cx, cell.y, cell.wz - cz)], reg.idOf(cell.name),
        'setBlock 与 column 实际内容不一致');
    }
  }
  assertTrue(written > 0, '三个 column 里一个桥面格都没写出来（栅格化没接线）');
});

test('桥：单层 —— 桥面格的上方与下方都不是桥材质', () => {
  const seed = 12345;
  const anchor = computeShallowTarnAnchor(seed);
  const b = computeShallowTarnBridge(seed, new Map());
  const reg = registry();
  const cx = Math.floor(anchor.wx / 16);
  const cz = Math.floor(anchor.wz / 16);
  const col = new ChunkColumn(cx, cz);
  fillColumn(col, seed);
  carveCaves(col, seed);
  const setBlock = (wx, y, wz, name) => {
    col.blocks[blockIndex(wx - cx * 16, y, wz - cz * 16)] = reg.idOf(name);
  };
  rasterizeShallowTarnBridge(col, anchor, seed, reg, setBlock, new Map());
  const matIds = new Set(BRIDGE_MATERIALS.map((n) => reg.idOf(n)));
  let deckCells = 0;
  for (let lx = 0; lx < 16; lx++) {
    for (let lz = 0; lz < 16; lz++) {
      for (let y = WORLD_MIN_Y + 1; y < WORLD_MAX_Y - 1; y++) {
        const id = col.blocks[blockIndex(lx, y, lz)];
        if (!matIds.has(id)) continue;
        deckCells++;
        assertFalse(matIds.has(col.blocks[blockIndex(lx, y + 1, lz)]), `桥面 y=${y} 上方也写了桥材质（双层）`);
        assertFalse(matIds.has(col.blocks[blockIndex(lx, y - 1, lz)]), `桥面 y=${y} 下方也写了桥材质（双层）`);
      }
    }
  }
  assertTrue(deckCells > 0, '本 column 没有任何桥面格');
});

test('桥：3 格宽 —— 每一行（沿轴）都是中线 + 法向 ±1 三格', () => {
  const seed = 12345;
  const anchor = computeShallowTarnAnchor(seed);
  const b = computeShallowTarnBridge(seed, new Map());
  const reg = registry();
  const cx = Math.floor(anchor.wx / 16);
  const cz = Math.floor(anchor.wz / 16);
  const col = new ChunkColumn(cx, cz);
  fillColumn(col, seed);
  carveCaves(col, seed);
  const written = new Set();
  const setBlock = (wx, y, wz, name) => {
    col.blocks[blockIndex(wx - cx * 16, y, wz - cz * 16)] = reg.idOf(name);
    written.add(`${wx},${y},${wz}`);
  };
  rasterizeShallowTarnBridge(col, anchor, seed, reg, setBlock, new Map());
  // 只验落在本 column 内、且三格都齐的那些 s
  for (let s = -b.halfN; s <= b.halfP; s++) {
    const y = shallowTarnBridgeDeckY(s, b);
    const cells = [-1, 0, 1].map((off) => {
      const x = anchor.wx + b.ux * s + (-b.uz) * off;
      const z = anchor.wz + b.uz * s + b.ux * off;
      return `${x},${y},${z}`;
    });
    const inCol = cells.every((k) => {
      const [x, , z] = k.split(',').map(Number);
      return x >= cx * 16 && x <= cx * 16 + 15 && z >= cz * 16 && z <= cz * 16 + 15;
    });
    if (!inCol) continue;
    for (const k of cells) assertTrue(written.has(k), `s=${s} 缺法向格 ${k}`);
  }
});
```

本步还需要在测试文件顶部补 import：

```js
import { WORLD_MIN_Y, WORLD_MAX_Y, blockIndex } from '../voxel/constants.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { fillColumn } from '../gen/terrain.js';
import { carveCaves } from '../gen/caves.js';
import { rasterizeShallowTarnBridge } from '../gen/structures/shallow-water-bridge.js';
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: FAIL —— `rasterizeShallowTarnBridge` 未导出（`undefined is not a function`）。

- [ ] **Step 3: 实现 `rasterizeShallowTarnBridge`**

```js
/**
 * 在 column 里光栅化跨湖拱桥（单层 + 3 格宽）。
 *
 * ## 每格只写 1 格
 * 用户要求「单层方块」。不写桥墩、不写栏杆、不写桥体加厚。
 *
 * ## 目标格已有方块时照写（后写胜）
 * 桥面必须连续 —— 被高台残留或缓坡植被挡住的格子会让桥断掉，玩家会掉下去。
 * 净空判据（`computeShallowTarnBridge`）已保证桥面在台顶之上 3 格，不会争同一格。
 *
 * ## 裁剪
 * 只处理落在本 column 的格；`s` 的范围按 column 与桥轴的交集先算一遍再进循环。
 */
export function rasterizeShallowTarnBridge(column, anchor, seed, registry, setBlock, platformTop) {
  void registry;
  const bridge = computeShallowTarnBridge(seed, platformTop);
  if (!bridge) return;
  const colMinX = column.cx * 16;
  const colMinZ = column.cz * 16;
  const margin = 1;   // 法向 ±1 的余量
  for (let s = -bridge.halfN; s <= bridge.halfP; s++) {
    const y = shallowTarnBridgeDeckY(s, bridge);
    if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) continue;
    const material = shallowTarnBridgeBlockAt(s, bridge, seed);
    for (let off = -1; off <= 1; off++) {
      const wx = anchor.wx + bridge.ux * s + (-bridge.uz) * off;
      const wz = anchor.wz + bridge.uz * s + bridge.ux * off;
      if (wx < colMinX - margin || wx > colMinX + 15 + margin) continue;
      if (wz < colMinZ - margin || wz > colMinZ + 15 + margin) continue;
      setBlock(wx, y, wz, material);
    }
  }
}
```

同一步在文件顶部补 import：

```js
import { blockIndex, WORLD_MIN_Y, WORLD_MAX_Y } from '../../voxel/constants.js';
```

（`blockIndex` 若本文件未用到则不加 —— `setBlock` 已负责索引换算。）

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/gen/structures/shallow-water-bridge.js src/tests/test-shallow-water-bridge.js
git commit -m "feat(gen): 跨湖拱桥按 column 栅格化（单层 + 3 格宽，后写胜保证连续）"
```

---

### Task 5: 接入 `apply.js` 阶段 2.45

**Files:**
- Modify: `src/gen/structures/apply.js:405-419`（阶段 2.45 的 ④ 之后）
- Test: `src/tests/test-shallow-water-bridge.js`（真实 `applyStructuresToColumn` 层）

**Interfaces:**
- Consumes: Task 4 的 `rasterizeShallowTarnBridge`；`apply.js` 已有的 `setBlock`（`makeColumnSetter` 产物）与 `layout.shallowTarn`
- Produces: 不变

- [ ] **Step 1: 写失败测试**

追加（钉「纯函数全绿但世界里没有桥」这一类接线缺陷）：

```js
test('桥：真实 applyStructuresToColumn 把桥写进世界（接线门）', async () => {
  const { computeRegionLayout, neighborRegionKeys } = await import('../gen/structures/structure-layout.js');
  const { applyStructuresToColumn } = await import('../gen/structures/apply.js');
  const seed = 12345;
  const anchor = computeShallowTarnAnchor(seed);
  const reg = registry();
  // 取桥轴靠近湖心的 column（那里一定是桥面）
  const cx = Math.floor(anchor.wx / 16);
  const cz = Math.floor(anchor.wz / 16);
  const col = new ChunkColumn(cx, cz);
  fillColumn(col, seed);
  carveCaves(col, seed);
  // ⚠️ 签名是 `(column, seed, registry, layouts)`，且是 **async**（内部 await 结构加载）
  const layouts = neighborRegionKeys(cx, cz).map((key) => {
    const [rx, rz] = key.split(',').map(Number);
    return computeRegionLayout(rx, rz, seed);
  });
  await applyStructuresToColumn(col, seed, reg, layouts);
  const matIds = new Set(BRIDGE_MATERIALS.map((n) => reg.idOf(n)));
  let hits = 0;
  for (let lx = 0; lx < 16; lx++) {
    for (let lz = 0; lz < 16; lz++) {
      for (let y = BRIDGE_APEX_Y - 5; y <= BRIDGE_APEX_Y + 5; y++) {
        if (matIds.has(col.blocks[blockIndex(lx, y, lz)])) hits++;
      }
    }
  }
  assertTrue(hits >= 3, `湖心 column 在弧顶高度附近只命中 ${hits} 格桥材质（apply 阶段没接线）`);
});
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: FAIL —— `hits` 为 0（`apply.js` 尚未调用桥）。

- [ ] **Step 3: 接线**

在 `apply.js` 的阶段 2.45 循环里，`plantShallowTarnGrass(column, st, seed, registry, setBlock);` 之后加：

```js
    // ⑤ 跨湖拱桥（v2.24，用户 2026-11-03：「从浅水湖两岸之间架起一座高大的桥……
    //   单层方块，三个方块宽……形成一个横跨天幕的桥」）。
    //
    // ⚠️ **必须在 ②③ 之后**：桥的净空判据比对的是**真实烘焙方块**的最顶层，
    // 先写桥再光栅化高台会被后写胜覆盖（缺陷形态：桥某几段静默消失）。
    // ⚠️ **必须在 ④ 之后**：桥头落在缓坡带上，会顶掉那里的草/花；反过来桥头被植物挡住。
    //
    // `platformTop` 传 null：`apply.js` 不持有「全部烘焙方块的最顶层」这份派生数据，
    // 净空已由 `computeShallowTarnBridge` 在候选层用 `platformTop` 算出并择优；
    // 这里只需要轴向与剖面（已缓存）。
    rasterizeShallowTarnBridge(column, st, seed, registry, setBlock, null);
```

文件顶部 import 区加：

```js
import { rasterizeShallowTarnBridge } from './shallow-water-bridge.js';
```

⚠️ **注意 `platformTop` 传 `null` 的后果**：桥轴在 GEN 时不再做净空校验（缓存命中时用的是
候选层的择优结果）。这是刻意的 —— `apply.js` 里逐 column 重建 5 个 JSON 的顶层映射
（5442 格 × 5 座）会撞 GEN 预算。净空保证由 `computeShallowTarnBridge(seed, platformTop)`
在**首个调用方**（单测 / Tier 4）给出，`apply.js` 复用缓存。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/gen/structures/apply.js src/tests/test-shallow-water-bridge.js
git commit -m "feat(gen): 跨湖拱桥接入 apply 阶段 2.45 第 ⑤ 步"
```

---

### Task 6: `check:data` 门禁

**Files:**
- Modify: `tools/check-data.mjs`（`checkShallowTarns()` 尾部）

**Interfaces:**
- Consumes: `src/gen/structures/shallow-water-bridge.js` 的 `BRIDGE_MATERIALS`
- Produces: `[浅水高台]` 环节新增两条判据

- [ ] **Step 1: 加门禁**

在 `tools/check-data.mjs` 顶部 import 区加：

```js
// 跨湖拱桥的材质契约（v2.24）：六种必须都是已注册的 opaque 方块
const BRIDGE = await import('../src/gen/structures/shallow-water-bridge.js');
```

在 `checkShallowTarns()` 的函数体末尾（`if (failures.length === before) { success(...) }` 之前）加：

```js
  // ⑦ 跨湖拱桥的材质契约（v2.24）：六种必须都已注册 + 全部 opaque 通道 + 无叶子族。
  //
  // 钉的失效路径（全部**静默**）：
  //   · 材质名拼错 → `makeColumnSetter` 静默 return → 那几格变空气（桥出现空洞，玩家掉下去）
  //   · 材质改到 cutout/transparent 通道 → 撞容量预算（且只表现为掉帧）
  //   · 有人「顺手」把叶子加进材质表 → 违反用户「用非叶子方块」的明确要求
  if (BRIDGE.BRIDGE_MATERIALS.length !== 6) {
    fail(`BRIDGE_MATERIALS 应为 6 种，实际 ${BRIDGE.BRIDGE_MATERIALS.length}`);
  }
  for (const name of BRIDGE.BRIDGE_MATERIALS) {
    const def = BLOCKS.find((b) => b.name === name);
    if (!def) { fail(`桥材质 ${name} 未在 blocks-data.js 注册（栅格化会静默变空气）`); continue; }
    if (def.cullMode !== 'opaque') fail(`桥材质 ${name} 的 cullMode 是 "${def.cullMode}"，应为 opaque`);
  }
  const leafLike = BRIDGE.BRIDGE_MATERIALS.filter((n) => /leaves|flower|azalea/.test(n));
  if (leafLike.length) fail(`桥材质含叶子族 ${leafLike.join(', ')}（用户明确要求用非叶子方块）`);
```

- [ ] **Step 2: 跑门禁确认 GREEN**

Run: `npm run check:data`
Expected: PASS，输出含 `✓ [浅水高台]`。

- [ ] **Step 3: 负向验证**

临时把 `BRIDGE_MATERIALS` 里的 `'marble'` 改成 `'marble_typo'`，
Run: `npm run check:data`
Expected: FAIL，报 `桥材质 marble_typo 未在 blocks-data.js 注册`。
确认后**用 `cp` 副本还原**（禁止 `git checkout` —— 文件里有本任务的未提交改动）。

- [ ] **Step 4: Commit**

```bash
git add tools/check-data.mjs
git commit -m "chore(gate): check:data 增加跨湖拱桥材质契约（注册/opaque/无叶子）"
```

---

### Task 7: Tier 4 真实页面验证

**Files:**
- Modify: `tests/shallow-water-tarns.spec.mjs`（追加用例）

**Interfaces:**
- Consumes: 页面上 `window.__MC_GAME__` 的 world / registry；`computeShallowTarnBridge`
- Produces: 不变

- [ ] **Step 1: 写用例**

追加到 `tests/shallow-water-tarns.spec.mjs`：

```js
test('跨湖拱桥：真实世界里有桥、3 格宽、可步行、六种材质都出现', async ({ page }) => {
  test.setTimeout(180_000);
  const seed = 12345;
  await page.goto(`/?seed=${seed}&vd=8`);
  await page.waitForFunction(() => window.__MC_GAME__, null, { timeout: 90_000 });

  // 桥轴由被测模块算出（不在这里写第二份几何）
  const probe = await page.evaluate(async (s) => {
    const m = await import('/src/gen/structures/shallow-water-bridge.js');
    const t = await import('/src/gen/structures/shallow-water-tarns.js');
    const anchor = t.computeShallowTarnAnchor(s);
    const bridge = m.computeShallowTarnBridge(s, null);
    if (!bridge) return null;
    const deck = [];
    for (let ds = -bridge.halfN; ds <= bridge.halfP; ds++) {
      deck.push([ds, m.shallowTarnBridgeDeckY(ds, bridge), m.shallowTarnBridgeBlockAt(ds, bridge, s)]);
    }
    return {
      anchor: { wx: anchor.wx, wz: anchor.wz },
      bridge: { ux: bridge.ux, uz: bridge.uz, apex: bridge.apex, halfP: bridge.halfP, halfN: bridge.halfN },
      deck,
      materials: m.BRIDGE_MATERIALS,
    };
  }, seed);
  expect(probe, '该 seed 没有合法桥轴').not.toBeNull();

  // 逐格读真实世界
  const observed = await page.evaluate(async ({ probe }) => {
    const { world } = window.__MC_GAME__;
    const { registry } = window.__MC_GAME__;
    const idToName = new Map();
    for (const def of registry.all ? registry.all() : []) idToName.set(registry.idOf(def.name), def.name);
    const results = [];
    for (const [ds, y, mat] of probe.deck) {
      const wx = probe.anchor.wx + probe.bridge.ux * ds;
      const wz = probe.anchor.wz + probe.bridge.uz * ds;
      if (!world.hasColumn(Math.floor(wx / 16), Math.floor(wz / 16))) continue;
      const row = [];
      for (const off of [-1, 0, 1]) {
        const x = wx + (-probe.bridge.uz) * off;
        const z = wz + probe.bridge.ux * off;
        row.push({ id: world.getBlockId(x, y, z), name: idToName.get(world.getBlockId(x, y, z)) ?? null });
      }
      results.push({ ds, y, mat, row });
    }
    return results;
  }, { probe, seed });

  expect(observed.length, '一个已加载的桥面列都没读到').toBeGreaterThan(20);

  // ① 3 格宽：中线与法向 ±1 都命中桥材质
  const legal = new Set(probe.materials);
  let fullRows = 0;
  for (const r of observed) {
    if (r.row.every((c) => legal.has(c.name))) fullRows++;
  }
  expect(fullRows / observed.length, '三格齐全的行占比过低').toBeGreaterThan(0.9);

  // ② 可步行：相邻两列高差 ≤ 1
  const sorted = observed.slice().sort((a, b) => a.ds - b.ds);
  for (let i = 1; i < sorted.length; i++) {
    expect(Math.abs(sorted[i].y - sorted[i - 1].y), `ds=${sorted[i].ds} 高差 > 1`).toBeLessThanOrEqual(1);
  }

  // ③ 六种材质都出现过
  const seen = new Set(observed.map((r) => r.mat));
  for (const m of probe.materials) expect(seen.has(m), `材质 ${m} 没出现`).toBe(true);
});
```

- [ ] **Step 2: 跑用例确认 GREEN**

Run: `npx playwright test tests/shallow-water-tarns.spec.mjs -g "跨湖拱桥"`
Expected: PASS。

- [ ] **Step 3: 负向验证**

临时把 `apply.js` 里新加的那行 `rasterizeShallowTarnBridge(...)` 注释掉，
Run: `npx playwright test tests/shallow-water-tarns.spec.mjs -g "跨湖拱桥"`
Expected: FAIL（`fullRows` 占比 0）。确认真 FAIL 后**用 `cp` 副本还原**（禁止 `git checkout`）。

- [ ] **Step 4: Commit**

```bash
git add tests/shallow-water-tarns.spec.mjs
git commit -m "test(e2e): 跨湖拱桥 Tier 4 —— 真实世界逐格验证 3 格宽/可步行/六种材质"
```

---

### Task 8: 文档同步与全量门禁

**Files:**
- Modify: `AGENTS.md`（浅水高台活跃约束段）
- Modify: `docs/roadmap.md`（v2.24 行）

**Interfaces:**
- Consumes: 全部前序 Task
- Produces: 不变

- [ ] **Step 1: 更新 `AGENTS.md`**

在「浅水高台沉淀的活跃约束」段的末尾追加：

```markdown
- **跨湖拱桥（v2.24）的三条载荷性口径**：
  - **桥轴必须吸附正轴（`+X` / `+Z` 二选一）**：斜向桥轴实测 22°/30°/60°/137° 有 **9%~18%**
    的沿轴步只覆盖 **2 格**（玩家会掉下去），且足迹法向宽度涨到 **3.8~4.1 格**（不是 3 格）。
    根因是格坐标取整在斜向不对齐。备选「中心细线 + 主轴邻居」在 45° 时 **114/114** 个中心格
    成孤岛。⇒ 严格 3 格宽**只能**靠正轴。
  - **剖面必须是余弦拱，不能用抛物**：抛物 `1−t²` 端部斜率 2 格/格 > `MAX_STEP = 1.0`，
    实测 `maxStep = 2` → 玩家走不上桥（违背用户「一路走上去」）。余弦端部斜率为 0，
    实测全程最大相邻高差 **1**。
  - **材质分片必须「等值线分片 + 游程合并」，不能逐格分桶**：逐格
    `floor(blobNoise/8·6)` 实测材质占比 **4/15/28/32/14/3%**（云与 `sky_stone` 几乎不出现）
    且片长碎到 1 格。改「归一化 → 等值线切 → <8 格并入相邻 → 强制相邻异色」后
    片长 min 8 / p25 12 / 中位 14 / p75 19，六种全出现。
  ⚠️ **净空最小实测只有 3 格**（seed 9）：候选只有两条正轴，某个 seed 两条都撞高台就没有桥。
  当前 20 seed 未出现，**但不是构造性保证** —— 加候选轴前必须先解决上面第一条的宽度问题。
```

- [ ] **Step 2: 更新 `docs/roadmap.md`**

在 v2.23 行之后追加一行 v2.24，格式与既有行一致：

```markdown
| v2.24 | 浅水高台跨湖拱桥 | 2026-11-03 | ✅ | 用户：「从浅水湖两岸之间架起一座高大的桥，单层方块，三个方块宽，用云/冰/深浅草/大理石/sky_stone 等非叶子方块，一片一片连接形成横跨天幕的桥」。桥轴吸附正轴（`+X`/`+Z` 择优，20 seed 全部命中）、余弦拱（弧顶 y=47、全程相邻高差 ≤1）、3 格宽单层、六种 opaque 材质等值线分片（片长 8~19 格）。实测跨度 162~201 格、与五座高台净空 3~27 格。设计文档 §15 |
```

⚠️ **v2.24 的版本号与表格列名以 `roadmap.md` 实际结构为准** —— 追加前先读它最近三行，
按同样的列数与措辞写。若表格没有「版本/改动/日期/状态/说明」五列，按实际列补。

- [ ] **Step 3: 跑全量门禁**

Run: `npm run check`
Expected: PASS（`check:arch` + `check:data` + `lint` 全绿，新增代码 0 error）。

Run: `npm run lint`
Expected: PASS。

若 `check:arch` 报依赖方向违规：桥模块 import 了 `./structure-json.js`（它可能触碰 fetch）的话
不算违规（`gen → gen`），但要确认没有 import three。

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md docs/roadmap.md
git commit -m "docs: 跨湖拱桥沉淀的活跃约束与 roadmap v2.24"
```

---

## 实施后必须回答的两件事

1. **`apply.js` 传 `platformTop = null` 是否可接受？**
   本计划的做法是「净空在候选层算一次、`apply.js` 复用缓存」。代价：若将来有人改了
   `computeShallowTarnLayout`（五座高台位置），而桥轴缓存未失效，桥可能穿进新位置的高台。
   → 验收时检查 `clearShallowTarnCache()` 是否也应清桥缓存；若发现两套缓存不同步，合并成一处。

2. **`+X` / `+Z` 两条候选是否够？**
   20 seed 全过，但净空最小 3 格（seed 9）没有余量。若要加候选（如 ±X / ±Z 之外的
   4 条对角轴），必须先解决斜向 3 格宽的问题（spec §15.5）—— 那是独立改动，不在本计划范围。
