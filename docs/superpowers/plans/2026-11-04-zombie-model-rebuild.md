# 丧尸模型重建（原版 Minecraft 人形）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把丧尸的渲染模型从「6 个自定义小方块 + 只有头有贴图」换成原版 Minecraft 人形（32px = 2.0 格、标准 64×64 皮肤格式、六部件全部带贴图），并给手臂与头部加上随步伐的摆动；玩法逻辑一个字不动。

**Architecture:** 新增 `src/render/zombie-model.js` 作为「部件尺寸 / 轴心 / 皮肤 UV 矩形」的唯一权威（纯数据，无 three 无 node），渲染器与测试都从它派生。新增一条离线烘焙管线（`npm run zombieskin`）生成 64×64 标准皮肤 `assets/zombie/skin.png` + 指纹 `skin.json`；`tools/zombie-skin-fingerprint.mjs` re-export `src/` 侧的 UV 表并把它算进指纹（红线 1：渲染期与烘焙期读同一份）。渲染层仍用 6 个固定容量 `InstancedMesh`（draw call 恒 6），只把部件尺寸/轴心换掉、UV 从「只改正面」改为「每面按皮肤矩形重映射」。

**Tech Stack:** 纯 JavaScript（ES2022 ES Modules）+ JSDoc，three.js r185.1（WebGPU 后端），`pngjs`（离线烘焙），Playwright（Tier 4 像素实测），Node 内置 `assert` 风格的浏览器内自研 runner。

**Spec:** `docs/superpowers/specs/2026-11-04-zombie-model-rebuild-design.md`（本计划实现它；执行者两份都要读）

## Global Constraints

以下数值与口径来自规格，每个任务都隐含包含本节。

- **模型总高恰 2.0 格**：脚底 `y = 0`、头顶 `y = 2.0`。1 源像素 = `1/16 = 0.0625` 格，32px × 0.0625 = 2.0。
- **玩法数据一个字都不动**：`ZOMBIE.health = 100` / `width = 0.6` / `height = 1.8` / `speed = 1.2` / `perceptionRange = 80` / `aiSleepDistance = 60` / `aiPeriod = 0.05` / `maxActive = 20`；`ZOMBIE_FLASH_MS = 200`；`ZOMBIE_WALK_SPEED = 10`；`ZOMBIE_SWING = Math.PI / 8`；`ZOMBIE_MOVING_EPSILON = 0.001`；`ZOMBIE_SEPARATION.minDistance = 1.2` / `repulsionStrength = 3.0`。
- **6 个部件、6 个 draw call 不变**：`ZOMBIE_PARTS` 仍是 `['head','body','leftArm','rightArm','leftLeg','rightLeg']`、同一顺序；`tests/zombies.spec.mjs` 的 `drawCalls 增量 === 6` 断言**逐字不动**。
- **仍走单材质 + 单纹理 + UV 分区**：不得使用 `geometry.groups` + 材质数组（WebGPU 后端不实现，`three.webgpu.js:34592`）。
- **`BoxGeometry` 六面顺序** = `[+X, -X, +Y, -Y, +Z, -Z]`，每面 4 顶点 → `+Z` 面是顶点 `16..19`；`HEAD_FRONT_VERTICES = [16,17,18,19]` 保持不变。
- **皮肤版式 = 标准 Minecraft 64×64**，六个部件的每面 UV 矩形见规格 §3.2 的表（本计划的 Task 2 把它落成代码）。
- **确定性**：程序化绘制一律用固定种子 `mulberry32`（红线 2），禁止 `Math.random()`。
- **资源路径**：一律经 `resourceUrl()`（`src/core/resource-url.js`），禁止站点根绝对路径（`npm run check:arch` 的 `[资源 URL]` 门是零白名单）。
- **新常量必须落 `zombie-config.js`**：渲染层不得写摆动幅度的字面量（红线 1）。
- **新增 `src/tests/test-*.js` 必须注册进 `src/tests/index.html`**，否则 `check:data` 的 `[测试注册]` 报「存在但未注册（= 静默不跑）」。
- **提交**：用户明确要求**实施完成后先不提交**，等他确认。本计划的每个 Task 末尾的 commit 步骤**全部跳过**，改为「任务完成即停下汇报」；只有用户在末端确认后才一次性提交。

## Review Focus

规格隐含、但没有任何任务的测试会覆盖的五类输入 / 失效模式，按最可能咬人的顺序：

1. **皮肤的 `u1 < u0` 反向矩形**（Minecraft 皮肤格式的 `up`/`down` 习惯逆序书写，如 body 的 `up = [28,16,20,20]`）—— 一个把矩形「规范化」成 `min/max` 的实现在这类面上会把纹理**水平镜像**，观感是「衣服纹理左右反了」，不报错、格数与指纹全对。Task 3 与 Task 7 各有一条针对它的断言。
2. **`BoxGeometry` 六个面的轴映射搞反**（把 `north` 给到 `-Z`、`east` 给到 `-X`）—— 观感是「脸在后脑勺」或「右手穿左手袖子」。Task 7 的 Tier 4 用「侧面不该出现眼睛」判据钉它，Task 2 用「六面矩形互不相同」的副作用判据钉它。
3. **肢体轴心没移到顶端**（忘了 `geometry.translate(0, -h/2, 0)`）—— 摆动时肢体整体**平移**而不是绕肩/髋扫弧线，走起来像踩滑板。Task 6 用包围盒 `maxY = 0 / minY = -h` 钉它。
4. **纹理加载失败被静默吞掉**（`game.js` 的 `.catch(() => null)`）—— 六个部件全退回纯色，丧尸变成「绿头 + 青蓝躯干」的纯色方块人，不报错。Task 8 的真游戏页断言 `hasSkinTexture() === true` 钉它。
5. **眼镜/裤子/上衣三区颜色撞车**（自烘配色时把绿皮和蓝紫裤子调得太近）—— 远看是一个纯色人形，看不出头/身/腿分段。Task 4 的门禁用「三区均值色相距离 ≥ 阈值」钉它。

---

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `src/render/zombie-model.js` | 部件尺寸 / 轴心 / 皮肤 UV 矩形 / 面部轴映射的**唯一权威**。纯数据 + 纯函数，零 three 零 node | 新建 |
| `tests/zombie-model-fingerprint.mjs` → 实为 `tools/zombie-skin-fingerprint.mjs` | 皮肤版式参数 + 输入指纹；**re-export** `zombie-model.js` 的 UV 表 | 新建 |
| `tools/bake-zombie-skin.mjs` | 按参数程序化绘制 64×64 皮肤 → `assets/zombie/skin.png` + `skin.json` | 新建 |
| `assets/zombie/skin.png` / `skin.json` | 烘焙产物（64×64 + 尺寸/版式版本/指纹） | 新建（跑 `npm zombieskin`） |
| `src/render/zombie-renderer.js` | 6 部件 InstancedMesh：几何从 `zombie-model.js` 构建、UV 整面重映射、摆动（腿 + 臂 + 头） | 改 |
| `src/entities/zombies/zombie-config.js` | 新增 `ZOMBIE_ARM_SWING` / `ZOMBIE_HEAD_SWAY` | 改 |
| `src/render/zombie-skin-texture.js` | 加载 `assets/zombie/skin.png` | 由 `zombie-head-texture.js` 改名 |
| `src/core/game.js` | 接线字段改名（`_zombieSkinTexture` / `skinTexture`）+ import 改名 | 改 |
| `tools/check-data.mjs` | `[丧尸头部]` → `[丧尸皮肤]`（64×64 + 版式版本 + 指纹 + 三区色相距离） | 改 |
| `package.json` | `zombie` 脚本 → `zombieskin` | 改 |
| `src/tests/test-zombies.js` | 部件尺寸/UV/摆动断言按新口径重写 + 新增 | 改 |
| `src/tests/test-zombie-model.html` | Tier 4 fixture（单只丧尸 + 四视角 + 摆动帧对） | 新建（取代 `test-zombie-head.html`） |
| `tests/zombie-model.spec.mjs` | Tier 4 像素实测（五条 + 真游戏页接线） | 新建（取代 `zombie-head.spec.mjs`） |
| `tests/zombies.spec.mjs` | **不动**（`drawCalls === 6` 是护栏） | 不动 |
| `assets/zombie/head.png` / `head.json` / `tools/bake-zombie-head.mjs` / `tools/zombie-head-fingerprint.mjs` / `src/tests/test-zombie-head.html` / `tests/zombie-head.spec.mjs` | 被上面取代 | 删除 |

---

### Task 1: 皮肤版式与部件尺寸的唯一权威（`zombie-model.js`）

**Files:**
- Create: `src/render/zombie-model.js`
- Create: `src/tests/test-zombie-model.js`
- Modify: `src/tests/index.html`（在 `import './test-zombies.js';` 之后加一行）

**Interfaces:**
- Produces:
  - `ZOMBIE_MODEL_PARTS: readonly string[]` —— `['head','body','leftArm','rightArm','leftLeg','rightLeg']`（与 `ZOMBIE_PARTS` 同序）
  - `PIXEL: number` —— `0.0625`（1 源像素 = 1/16 格）
  - `ZOMBIE_MODEL_DEFS: { [part]: { size: [number,number,number], pivot: [number,number,number], pivotAtTop: boolean, fallbackColor: number } }` —— `size` 是盒体尺寸（格）；`pivot` 是部件轴心的本地偏移（格，相对丧尸脚底）；`pivotAtTop` 为真表示几何需 `translate(0, -size[1]/2, 0)`（臂/腿）；`fallbackColor` 是无纹理时的退回色
  - `ZOMBIE_SKIN_UV: { [part]: { px: [num,num,num,num], nx: [...], py: [...], ny: [...], pz: [...], nz: [...] } }` —— 每面一个 `[u1, v1, u2, v2]`（源像素），**故意保持源书写方向**（允许 `u1 < u0` 或 `v1 < v0`）
  - `SKIN_SIZE: 64`
  - `remapFaceUV(positionAttr, uvAttr, rect): void` —— 把 `positionAttr` 里法线匹配该面的顶点的 `uv` 重映射到 `rect`
  - `FACE_OF_RECT`（内部用，不必导出）
  - `zombieModelHeight(): number` —— 返回 `2.0`（由盒子实测算出，不写字面量）
  - `zombieModelWidth(): number` —— 返回 `1.0`

**Steps:**

- [ ] **Step 1: 写失败的测试**

`src/tests/test-zombie-model.js`：

```js
// src/tests/test-zombie-model.js — 丧尸模型版式（原版人形）的纯数据契约
//
// 这里的断言全部**从 zombie-model.js 自身的导出派生**能被派生的部分（尺寸关系、UV 合法性），
// 只有「原版口径的绝对数值」写成字面量（2.0 / 0.5 / 0.75 / 0.25 / 64）—— 那是设计锁定的
// 外部事实（Minecraft 人形模型），不是被测代码的内部常量，写成字面量才有判别力。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse, assertDeepEqual } from './assert.js';
import {
  ZOMBIE_MODEL_PARTS, PIXEL, ZOMBIE_MODEL_DEFS, ZOMBIE_SKIN_UV, SKIN_SIZE,
  zombieModelHeight, zombieModelWidth,
} from '../render/zombie-model.js';

test('zombie-model: 1 源像素 = 1/16 格，部件集合与顺序对齐 ZOMBIE_PARTS', () => {
  assertEqual(PIXEL, 1 / 16);
  assertEqual(PIXEL, 0.0625);
  assertDeepEqual([...ZOMBIE_MODEL_PARTS],
    ['head', 'body', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg']);
});

test('zombie-model: 六部件尺寸 = 原版人形口径（8³ / 8×12×4 / 4×12×4）', () => {
  // 源像素 → 格：8px = 0.5、12px = 0.75、4px = 0.25
  assertDeepEqual(ZOMBIE_MODEL_DEFS.head.size, [0.5, 0.5, 0.5]);
  assertDeepEqual(ZOMBIE_MODEL_DEFS.body.size, [0.5, 0.75, 0.25]);
  for (const arm of ['leftArm', 'rightArm']) {
    assertDeepEqual(ZOMBIE_MODEL_DEFS[arm].size, [0.25, 0.75, 0.25], arm);
  }
  for (const leg of ['leftLeg', 'rightLeg']) {
    assertDeepEqual(ZOMBIE_MODEL_DEFS[leg].size, [0.25, 0.75, 0.25], leg);
  }
});

test('zombie-model: 轴心位置 —— 头/躯干在盒中心，臂在肩、腿在髋（顶端轴心）', () => {
  const D = ZOMBIE_MODEL_DEFS;
  // 头：盒中心 y = 1.75 → 盒体 [1.5, 2.0]
  assertDeepEqual(D.head.pivot, [0, 1.75, 0]);
  assertFalse(D.head.pivotAtTop);
  // 躯干：盒中心 y = 1.125 → 盒体 [0.75, 1.5]
  assertDeepEqual(D.body.pivot, [0, 1.125, 0]);
  assertFalse(D.body.pivotAtTop);
  // 臂：肩部轴心 y = 1.5、x = ±(0.25 + 0.125) = ±0.375 → 盒体向下延伸到 0.75
  assertDeepEqual(D.leftArm.pivot, [-0.375, 1.5, 0]);
  assertDeepEqual(D.rightArm.pivot, [0.375, 1.5, 0]);
  assertTrue(D.leftArm.pivotAtTop);
  assertTrue(D.rightArm.pivotAtTop);
  // 腿：髋部轴心 y = 0.75、x = ±0.125 → 盒体向下延伸到 0
  assertDeepEqual(D.leftLeg.pivot, [-0.125, 0.75, 0]);
  assertDeepEqual(D.rightLeg.pivot, [0.125, 0.75, 0]);
  assertTrue(D.leftLeg.pivotAtTop);
  assertTrue(D.rightLeg.pivotAtTop);
});

test('zombie-model: 总高恰 2.0、脚底恰 0、水平跨度恰 1.0（原版口径）', () => {
  // **从盒体区间派生，不读 PIXEL 相乘的结果** —— 否则公式写错（如 30px）时断言跟着错。
  const boxTop = (part) => {
    const d = ZOMBIE_MODEL_DEFS[part];
    return d.pivot[1] + (d.pivotAtTop ? 0 : d.size[1] / 2);
  };
  const boxBottom = (part) => {
    const d = ZOMBIE_MODEL_DEFS[part];
    return d.pivot[1] - d.size[1] / 2;
  };
  assertEqual(Math.max(...ZOMBIE_MODEL_PARTS.map(boxTop)), 2.0, '头顶须恰为 2.0');
  assertEqual(Math.min(...ZOMBIE_MODEL_PARTS.map(boxBottom)), 0, '脚底须恰为 0（不陷地）');
  assertEqual(zombieModelHeight(), 2.0);
  assertEqual(zombieModelWidth(), 1.0, '臂外缘 x = ±0.5 → 总宽 1.0');
  // 脚底不陷地（现状是 -0.1，本设计修掉）
  assertTrue(Math.min(...ZOMBIE_MODEL_PARTS.map(boxBottom)) >= 0, '脚底不得低于 0');
});

test('zombie-model: 皮肤版式 = 标准 64×64，六部件 × 六面矩形齐全且落在图内', () => {
  assertEqual(SKIN_SIZE, 64);
  const FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
  for (const part of ZOMBIE_MODEL_PARTS) {
    const uv = ZOMBIE_SKIN_UV[part];
    assertTrue(!!uv, `${part} 须有 UV 表`);
    for (const f of FACES) {
      const r = uv[f];
      assertTrue(Array.isArray(r) && r.length === 4, `${part}.${f} 须是 [u1,v1,u2,v2]`);
      for (const v of r) {
        assertTrue(Number.isFinite(v), `${part}.${f} 分量须是有限数`);
        assertTrue(v >= 0 && v <= SKIN_SIZE, `${part}.${f} 分量 ${v} 须落在 [0,${SKIN_SIZE}]`);
      }
      // 矩形必须有面积（宽高都 > 0）—— 反向书写是允许的，但不能是零面积
      assertTrue(Math.abs(r[2] - r[0]) > 0, `${part}.${f} 的 u 跨度不得为 0`);
      assertTrue(Math.abs(r[3] - r[1]) > 0, `${part}.${f} 的 v 跨度不得为 0`);
    }
  }
});

test('zombie-model: 同一部件的六面矩形互不重叠（防「六面指同一个区」这类静默错）', () => {
  // 六面共用一块矩形时，头/身/腿的所有面都是同一张图案 —— 观感是「纯色块」，
  // 但 UV 合法性断言全绿。故用重叠判据兜住。
  const FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
  const norm = (r) => [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
  for (const part of ZOMBIE_MODEL_PARTS) {
    const rects = FACES.map((f) => ({ f, r: norm(ZOMBIE_SKIN_UV[part][f]) }));
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i].r, b = rects[j].r;
        const overlap = a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
        assertFalse(overlap, `${part}: ${rects[i].f} 与 ${rects[j].f} 的 UV 矩形不得重叠`);
      }
    }
  }
});

test('zombie-model: 反向书写的矩形被保留（不规范化成 min/max）', () => {
  // Minecraft 皮肤格式里 up/down 习惯逆序书写（如 body.up = [28,16,20,20]）。
  // 若实现把矩形规范化，这些面会被水平镜像 → 「衣服纹理左右反了」，格数与指纹全对。
  // 故显式钉住至少一处 u1 > u0、且那一处的原值逐位保留。
  const reversals = [];
  for (const part of ZOMBIE_MODEL_PARTS) {
    for (const [face, r] of Object.entries(ZOMBIE_SKIN_UV[part])) {
      if (r[2] < r[0] || r[3] < r[1]) reversals.push(`${part}.${face}`);
    }
  }
  assertTrue(reversals.length > 0, '标准皮肤版式必然含反向矩形（up/down），本表不得把它们规范化掉');
  // 逐位钉住 body 的 up（规格 §3.2 的实测值）
  assertDeepEqual(ZOMBIE_SKIN_UV.body.py, [28, 16, 20, 20]);
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx playwright test tests/harness.spec.mjs --reporter=line`
Expected: FAIL（`Cannot find module '../render/zombie-model.js'`，整页 `window.__MC_TEST_RESULTS__` 不产生 → harness 超时或 `failed > 0`）

- [ ] **Step 3: 实现 `src/render/zombie-model.js`**

模块内容（纯数据 + 纯函数）：

```js
// src/render/zombie-model.js — 丧尸模型版式的唯一权威（原版 Minecraft 人形，32px = 2.0 格）
//
// 为什么住 src/ 而不是 tools/：渲染器**运行时**要用这张表构建 BoxGeometry 与 UV
// （`zombie-renderer.js` 的构造期），所以版式必须能被浏览器 import。
// `tools/zombie-skin-fingerprint.mjs` 只 re-export 它并把内容算进指纹
// （手法同 `tools/cloudland-kit-fingerprint.mjs` re-export `src/gen/structures/cloudland-kit-data.js`，
// 红线 1：同一事实只有一份权威）。
//
// 本模块无 three、无 DOM、无 node 依赖（纯数据 + 纯数组运算），故渲染层与单测都能直接跑。
//
// 数值出处：标准 Minecraft 人形模型（头 8³ / 躯干 8×12×4 / 肢 4×12×4，合计 32px），
// 与用户提供的 The Walking Zombie Pack 的 .bbmodel 骨架逐项一致（spec §3.1）。
// UV 矩形出处：标准 64×64 皮肤版式（spec §3.2 的实测表）。

/** 1 源像素 = 1/16 格（原版口径） */
export const PIXEL = 1 / 16;

/** 部件集合与顺序（与 zombie-renderer.js 的 ZOMBIE_PARTS 同序） */
export const ZOMBIE_MODEL_PARTS = Object.freeze([
  'head', 'body', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg',
]);

/** 皮肤贴图边长（标准 Minecraft 皮肤是 64×64） */
export const SKIN_SIZE = 64;

/**
 * 部件几何（格）。
 *
 * `pivot` = 部件轴心相对丧尸脚底的本地偏移；`pivotAtTop` 为真时几何要
 * `translate(0, -size[1]/2, 0)`（臂绕肩、腿绕髋旋转，不 translate 会整体平移而非扫弧线）。
 * `fallbackColor` = 无纹理时的退回色（有纹理时六部件都用白底 0xffffff 乘纹理色）。
 */
export const ZOMBIE_MODEL_DEFS = Object.freeze({
  head: { size: Object.freeze([0.5, 0.5, 0.5]), pivot: Object.freeze([0, 1.75, 0]), pivotAtTop: false, fallbackColor: 0x406b30 },
  body: { size: Object.freeze([0.5, 0.75, 0.25]), pivot: Object.freeze([0, 1.125, 0]), pivotAtTop: false, fallbackColor: 0x037c7c },
  leftArm: { size: Object.freeze([0.25, 0.75, 0.25]), pivot: Object.freeze([-0.375, 1.5, 0]), pivotAtTop: true, fallbackColor: 0x699058 },
  rightArm: { size: Object.freeze([0.25, 0.75, 0.25]), pivot: Object.freeze([0.375, 1.5, 0]), pivotAtTop: true, fallbackColor: 0x699058 },
  leftLeg: { size: Object.freeze([0.25, 0.75, 0.25]), pivot: Object.freeze([-0.125, 0.75, 0]), pivotAtTop: true, fallbackColor: 0x322b71 },
  rightLeg: { size: Object.freeze([0.25, 0.75, 0.25]), pivot: Object.freeze([0.125, 0.75, 0]), pivotAtTop: true, fallbackColor: 0x322b71 },
});

/** 盒体顶 / 底（格）：`pivotAtTop` 的部件盒体从 pivot 向下延伸 */
function boxTopOf(def) { return def.pivot[1] + (def.pivotAtTop ? 0 : def.size[1] / 2); }
function boxBottomOf(def) { return def.pivot[1] - def.size[1] / 2; }

/** 模型总高（格）= 最高盒顶 − 最低盒底；原版口径恰为 2.0 */
export function zombieModelHeight() {
  const tops = ZOMBIE_MODEL_PARTS.map((p) => boxTopOf(ZOMBIE_MODEL_DEFS[p]));
  const bottoms = ZOMBIE_MODEL_PARTS.map((p) => boxBottomOf(ZOMBIE_MODEL_DEFS[p]));
  return Math.max(...tops) - Math.min(...bottoms);
}

/** 模型水平跨度（格）= 最外侧臂外缘 × 2；原版口径恰为 1.0 */
export function zombieModelWidth() {
  let maxAbsX = 0;
  for (const p of ZOMBIE_MODEL_PARTS) {
    const d = ZOMBIE_MODEL_DEFS[p];
    maxAbsX = Math.max(maxAbsX, Math.abs(d.pivot[0]) + d.size[0] / 2);
  }
  return maxAbsX * 2;
}

/**
 * 皮肤 UV 矩形（标准 64×64 版式，spec §3.2 的实测表逐项落成代码）。
 *
 * 键是 **BoxGeometry 的面序**：`px` = +X、`nx` = -X、`py` = +Y、`ny` = -Y、`pz` = +Z、`nz` = -Z。
 * 值是 `[u1, v1, u2, v2]`（源像素，非归一化）—— **刻意保持源书写方向**：
 * Minecraft 皮肤版式里 `up`/`down` 习惯逆序写（如 body.py = [28,16,20,20]），
 * 规范化成 min/max 会让那些面水平镜像（观感是「衣服纹理左右反了」，不报错）。
 *
 * 轴映射：`px→east`、`nx→west`、`py→up`、`ny→down`、`pz→north`、`nz→south`。
 */
export const ZOMBIE_SKIN_UV = Object.freeze({
  head: Object.freeze({
    px: [0, 8, 8, 16],    // east  （右/耳朵侧）
    nx: [16, 8, 24, 16],  // west  （左/耳朵侧）
    py: [8, 0, 16, 8],    // up
    ny: [16, 0, 24, 8],   // down
    pz: [8, 8, 16, 16],   // north （正脸 —— 眼睛在这里）
    nz: [24, 8, 32, 16],  // south （后脑）
  }),
  // 躯干与四肢取标准 64×64 版式的**整段**矩形（12px 高）。
  // 素材把 12 高切成上下两段（各 6 高，各有 UV，因为它要弯肘/膝），本设计合并成单段，
  // 故一个面的 u/v 跨度是 12 而不是 6 —— 与标准皮肤布局一致（spec §3.2 已核实）。
  body: Object.freeze({
    px: [16, 20, 20, 32],
    nx: [28, 20, 32, 32],
    py: [28, 16, 20, 20],  // ⚠️ 反向书写（u1 > u0），不得规范化
    ny: [36, 16, 28, 20],  // ⚠️ 反向书写
    pz: [20, 20, 28, 32],
    nz: [32, 20, 40, 32],
  }),
  rightArm: Object.freeze({
    px: [40, 20, 44, 32],
    nx: [48, 20, 52, 32],
    py: [44, 16, 40, 20],  // ⚠️ 反向
    ny: [48, 16, 44, 20],  // ⚠️ 反向
    pz: [44, 20, 48, 32],
    nz: [52, 20, 56, 32],
  }),
  leftArm: Object.freeze({
    px: [32, 52, 36, 64],
    nx: [40, 52, 44, 64],
    py: [36, 48, 32, 52],  // ⚠️ 反向
    ny: [40, 48, 36, 52],  // ⚠️ 反向
    pz: [36, 52, 40, 64],
    nz: [44, 52, 48, 64],
  }),
  rightLeg: Object.freeze({
    px: [0, 20, 4, 32],
    nx: [8, 20, 12, 32],
    py: [8, 16, 4, 20],    // ⚠️ 反向
    ny: [12, 16, 8, 20],   // ⚠️ 反向
    pz: [4, 20, 8, 32],
    nz: [12, 20, 16, 32],
  }),
  leftLeg: Object.freeze({
    px: [16, 52, 20, 64],
    nx: [24, 52, 28, 64],
    py: [24, 48, 20, 52],  // ⚠️ 反向
    ny: [28, 48, 24, 52],  // ⚠️ 反向
    pz: [20, 52, 24, 64],
    nz: [28, 52, 32, 64],
  }),
});

/** 六面 → BoxGeometry 面序下标（每面 4 顶点，索引 = faceIndex × 4 + 0..3） */
const FACE_ORDER = Object.freeze(['px', 'nx', 'py', 'ny', 'pz', 'nz']);

/**
 * 把一个面的默认 UV（u,v ∈ [0,1]）重映射到皮肤矩形 `rect`（源像素）。
 *
 * **支持反向矩形**（`u1 > u0` / `v1 > v0`）：公式 `u' = u0 + u*(u2-u0)` 在 u2 < u0 时
 * 自然得到递减映射 —— 这正是 Minecraft 皮肤版式要的镜像效果，不得规范化。
 *
 * @param {{count:number, getX:(i:number)=>number, getY:(i:number)=>number,
 *          setXY:(i:number,x:number,y:number)=>void, needsUpdate:boolean}} uv `geometry.attributes.uv`
 * @param {number} faceIndex BoxGeometry 面序（0=+X,1=-X,2=+Y,3=-Y,4=+Z,5=-Z）
 * @param {number[]} rect `[u1, v1, u2, v2]`（源像素）
 */
export function remapFaceUV(uv, faceIndex, rect) {
  const [u0, v0, u1, v1] = rect;
  const S = SKIN_SIZE;
  for (let k = 0; k < 4; k++) {
    const i = faceIndex * 4 + k;
    const u = uv.getX(i);
    const v = uv.getY(i);
    uv.setXY(i, (u0 + u * (u1 - u0)) / S, (v0 + v * (v1 - v0)) / S);
  }
  uv.needsUpdate = true;
}

/** 面序名数组（供渲染器遍历），只读 */
export const ZOMBIE_UV_FACES = FACE_ORDER;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx playwright test tests/harness.spec.mjs --reporter=line`
Expected: PASS（`failed === 0`）

- [ ] **Step 5: 不提交，继续下一个任务**

（用户要求实施完成后先不提交；本任务结束只汇报进度。）

---

### Task 2: 皮肤烘焙管线（`npm run zombieskin`）

**Files:**
- Create: `tools/zombie-skin-fingerprint.mjs`
- Create: `tools/bake-zombie-skin.mjs`
- Modify: `package.json`（`"zombie": ...` → `"zombieskin": "node tools/bake-zombie-skin.mjs"`）

**Interfaces:**
- Consumes: `ZOMBIE_SKIN_UV` / `SKIN_SIZE` / `ZOMBIE_MODEL_PARTS`（Task 1）
- Produces:
  - `SKIN_PNG: string` / `SKIN_JSON: string` —— 绝对路径（`tools/zombie-skin-fingerprint.mjs`）
  - `SKIN_LAYOUT_VERSION: string` —— `'mc-standard-64'`
  - `SKIN_REGIONS: { head, torso, arm, leg }` —— 每区 `{ x0, y0, x1, y1 }`（源像素，烘焙时按它填色）
  - `SKIN_PALETTE: { skin: [r,g,b], shirt: [r,g,b], pants: [r,g,b], eye: [r,g,b], shoe: [r,g,b] }`
  - `mulberry32(seed): () => number`
  - `skinInputFingerprint(): string`
  - 产物 `assets/zombie/skin.png`（64×64）+ `assets/zombie/skin.json`（`{ width, height, layout, version, fingerprint }`）

**Steps:**

- [ ] **Step 1: 写失败的测试（门禁侧，`tools/check-data.mjs` 的 `[丧尸皮肤]` 环节）**

在 `tools/check-data.mjs` 里把 `checkZombieHeadTexture()` 整体替换为 `checkZombieSkinTexture()`（`[丧尸头部]` → `[丧尸皮肤]`），保留三条既有判据的结构、把「眼睛黑像素数」换成「三区色相距离」，并新增「版式版本」：

```js
// ---------------------------------------------------------------- [9] 丧尸皮肤契约

/**
 * 丧尸皮肤（64×64 标准版式）的四个环节必须齐全，否则观感**静默错乱**。
 *
 * 与图标过期同类：皮肤是**派生产物**，权威输入是 `tools/zombie-skin-fingerprint.mjs`
 * 的参数 + re-export 的 `src/render/zombie-model.js` 的 UV 表。改了参数却忘跑
 * `npm run zombieskin` → 渲染旧图（肉眼看不出「过期」，只觉得「颜色怪怪的」）。
 *
 * 四条断言：
 *   ① PNG 存在 + 尺寸 = 64×64 → 缺文件时 `loadAsync` 抛错，game.js 的 catch 退回纯色
 *      （**静默降级**，不阻断启动 → 只有门禁能抓）
 *   ② 版式版本 = 当前 UV 表对应的版本 → 抓「UV 表改成新布局但皮肤还是旧布局」
 *   ③ 三区均值色相距离 ≥ 阈值 → 抓「绿皮 / 上衣 / 裤子配色撞车」（远看是一个纯色人形）
 *   ④ 输入指纹匹配 → 抓「改了参数忘重烘」
 */
function checkZombieSkinTexture() {
  if (!fs.existsSync(SKIN_PNG)) {
    failures.push('[丧尸皮肤] assets/zombie/skin.png 不存在 —— 跑 npm run zombieskin');
    return;
  }
  const png = PNG.sync.read(fs.readFileSync(SKIN_PNG));
  if (png.width !== SKIN_SIZE || png.height !== SKIN_SIZE) {
    failures.push(`[丧尸皮肤] PNG ${png.width}×${png.height} 与期望 ${SKIN_SIZE}×${SKIN_SIZE} 不符`);
    return;
  }

  // ② 版式版本
  if (!fs.existsSync(SKIN_JSON)) {
    failures.push('[丧尸皮肤] assets/zombie/skin.json 不存在 —— 跑 npm run zombieskin');
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(SKIN_JSON, 'utf8'));
  if (manifest.layout !== SKIN_LAYOUT_VERSION) {
    failures.push(`[丧尸皮肤] 版式版本 ${manifest.layout} ≠ 期望 ${SKIN_LAYOUT_VERSION}`
      + '（UV 表与皮肤布局不同步，重跑 npm run zombieskin）');
  }

  // ③ 三区色相距离（关系型：不是绝对 RGB，而是「彼此可分」）
  const means = {};
  for (const [name, r] of Object.entries(SKIN_REGIONS)) means[name] = regionMean(png, r);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const pairs = [['head', 'torso'], ['torso', 'leg'], ['head', 'leg']];
  for (const [a, b] of pairs) {
    const d = dist(means[a], means[b]);
    if (d < SKIN_REGION_MIN_DIST) {
      failures.push(`[丧尸皮肤] 「${a}」与「${b}」的均值色距 ${d.toFixed(1)} < ${SKIN_REGION_MIN_DIST}`
        + `（${means[a].map(Math.round)} vs ${means[b].map(Math.round)}）—— 三区分不开，远看是纯色人形`);
    }
  }

  // ④ 输入指纹
  const current = skinInputFingerprint();
  if (manifest.fingerprint !== current) {
    failures.push('[丧尸皮肤] 参数已变但皮肤未重烘（跑 npm run zombieskin）'
      + `\n      期望 ${current}\n      实际 ${manifest.fingerprint}`);
  }

  if (!failures.some((f) => f.startsWith('[丧尸皮肤]'))) {
    infos.push(`[丧尸皮肤] skin.png ${SKIN_SIZE}×${SKIN_SIZE} 版式 ${SKIN_LAYOUT_VERSION}`
      + ` + 三区色距达标 + 指纹匹配`);
  }
}
```

配套在 `tools/zombie-skin-fingerprint.mjs` 里定义（门禁与烘焙共用）：

```js
/** 三区最小均值色距（欧氏，sRGB 0..255 单位）。实测留够余量，见计划 Task 4 的标定步骤。 */
export const SKIN_REGION_MIN_DIST = 40;
```

并在 `check-data.mjs` 顶部把 `import` 从 `zombie-head-fingerprint.mjs` 换成 `zombie-skin-fingerprint.mjs`，导出 `SKIN_PNG, SKIN_JSON, SKIN_SIZE, SKIN_LAYOUT_VERSION, SKIN_REGIONS, skinInputFingerprint`；把主流程里的 `checkZombieHeadTexture()` 调用改成 `checkZombieSkinTexture()`，并把 §9 的注释编号与标题同步。

- [ ] **Step 2: 跑门禁确认它失败**

Run: `npm run check:data`
Expected: FAIL，报 `[丧尸皮肤] assets/zombie/skin.png 不存在 —— 跑 npm run zombieskin`

- [ ] **Step 3: 实现 `tools/zombie-skin-fingerprint.mjs`**

```js
// tools/zombie-skin-fingerprint.mjs — 丧尸皮肤版式参数与输入指纹
//
// **两个消费者共用同一份逻辑**（红线 1）：烘焙脚本按本参数绘制，check:data 按本参数重算指纹。
// UV 矩形**不在这里再写一份** —— 从 `src/render/zombie-model.js` re-export（渲染器运行时
// 读的是那份，两处必须字面同一）。手法同 `tools/cloudland-kit-fingerprint.mjs` re-export
// `src/gen/structures/cloudland-kit-data.js`。
//
// node 侧模块（门禁与烘焙脚本都要读 PNG / 路径），不进 src/，浏览器不消费。

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import { ZOMBIE_SKIN_UV, SKIN_SIZE, ZOMBIE_MODEL_PARTS } from '../src/render/zombie-model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 产物路径（烘焙脚本与门禁共用） */
export const SKIN_PNG = path.join(__dirname, '..', 'assets', 'zombie', 'skin.png');
export const SKIN_JSON = path.join(__dirname, '..', 'assets', 'zombie', 'skin.json');

/** 版式版本：皮肤图的布局口径。改 UV 表/区域划分时必须同步改它（门禁据此抓「表新图旧」） */
export const SKIN_LAYOUT_VERSION = 'mc-standard-64';

/** re-export（权威在 src/render/zombie-model.js，供烘焙脚本与门禁共同 import） */
export { ZOMBIE_SKIN_UV, SKIN_SIZE, ZOMBIE_MODEL_PARTS };

/**
 * 皮肤的四个语义区（源像素，左闭右开）。
 *
 * 绘制按区填色 + 叠细节；门禁按同一组矩形取均值算「三区色距」。
 * **值必须与 `ZOMBIE_SKIN_UV` 的矩形们一致**（区内是纯色基底，UV 切出来的面自然分色）。
 */
export const SKIN_REGIONS = Object.freeze({
  head: Object.freeze({ x0: 0, y0: 0, x1: 32, y1: 16 }),
  torso: Object.freeze({ x0: 16, y0: 16, x1: 40, y1: 32 }),
  arm: Object.freeze({ x0: 32, y0: 48, x1: 48, y1: 64 }),
  leg: Object.freeze({ x0: 0, y0: 16, x1: 16, y1: 32 }),
});

/**
 * 配色（sRGB）。原版丧尸口径：绿皮 + 青蓝破烂上衣 + 蓝紫裤子。
 *
 * ⚠️ 这组值要按「三区色距 ≥ SKIN_REGION_MIN_DIST」标定 —— 先烘一版量门的输出，
 * 不达标就调这里，不要在门里放宽阈值（阈值是判别力，配色是观感）。
 */
export const SKIN_PALETTE = Object.freeze({
  skin: Object.freeze([92, 140, 85]),
  shirt: Object.freeze([70, 110, 140]),
  pants: Object.freeze([80, 70, 150]),
  eye: Object.freeze([24, 32, 20]),
  shoe: Object.freeze([52, 48, 62]),
  rot: Object.freeze([120, 120, 78]),
});

/** 三区均值最小欧氏色距（sRGB）。标定值见计划 Task 4 */
export const SKIN_REGION_MIN_DIST = 40;

/** 固定种子（红线 2：程序化绘制不许用 Math.random） */
export const SKIN_SEED = 20261104;

/** 纹理噪声强度（每 1px 的明度抖动幅度） */
export const SKIN_NOISE = 8;

/** mulberry32（与 `tools/zombie-head-fingerprint.mjs` 同款实现） */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** UV 表的稳定串（进入指纹：改矩形即指纹变） */
function uvFingerprint() {
  const parts = [];
  for (const part of ZOMBIE_MODEL_PARTS) {
    const faces = ZOMBIE_SKIN_UV[part];
    parts.push(`${part}:${['px', 'nx', 'py', 'ny', 'pz', 'nz']
      .map((f) => faces[f].join(',')).join('|')}`);
  }
  return parts.join(';');
}

/** 输入指纹 = 版式版本 + 区域 + 配色 + 噪声 + 种子 + UV 表 */
export function skinInputFingerprint() {
  const regions = Object.entries(SKIN_REGIONS)
    .map(([k, r]) => `${k}:${r.x0},${r.y0},${r.x1},${r.y1}`).join('|');
  const palette = Object.entries(SKIN_PALETTE).map(([k, v]) => `${k}:${v.join(',')}`).join('|');
  return [
    `layout:${SKIN_LAYOUT_VERSION}`,
    `size:${SKIN_SIZE}`,
    `regions:${regions}`,
    `palette:${palette}`,
    `noise:${SKIN_NOISE}`,
    `seed:${SKIN_SEED}`,
    `uv:${uvFingerprint()}`,
  ].join(';');
}

/** PNG 内容哈希（FNV-1a 32bit，同 `icon-fingerprint.mjs` 口径） */
export function pngHash(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  let h = 0x811c9dc5;
  for (let i = 0; i < png.data.length; i++) {
    h ^= png.data[i];
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return (h >>> 0).toString(36);
}
```

- [ ] **Step 4: 实现 `tools/bake-zombie-skin.mjs`**

绘制规则（保每区语义清楚，细节由实现者定，但必须满足）：

1. 以 `SKIN_PALETTE` 的基色按 `SKIN_REGIONS` 填满四区（head → skin、torso+arm → shirt 底 + 前臂露 skin、leg → pants 底 + 脚底 shoe）。
2. 浑身叠 `SKIN_NOISE` 幅度的逐像素明度抖动（用 `mulberry32(SKIN_SEED)`，**逐像素取一次随机**，不按像素块 —— 皮肤是 64px 尺度，块状抖动会显得像马赛克）。
3. 破损：在 torso/arm 区用固定种子的伪随机挑约 8% 的像素涂 `skin`（露皮肤）；在 head 区挑约 5% 涂 `rot`。
4. **正脸眼睛**：`ZOMBIE_SKIN_UV.head.pz` 矩形内，按标准皮肤习惯在**该矩形从顶部起第 4 行**（`v = v1_top + 3`）画两只 2px 宽的 `eye` 色块，横向位置约在矩形的 1/8 与 5/8 处（具体取整由实现者定，但两只眼必须**水平镜像对称**且都在该矩形内）。
5. 写 PNG + JSON（`{ width, height, layout, version, fingerprint }`），其中 `version` 与 `fingerprint` 来自 `SKIN_LAYOUT_VERSION` / `skinInputFingerprint()`。
6. 控制台打印摘要：尺寸、版式、四区均值、指纹。

- [ ] **Step 5: 跑烘焙再跑门禁**

Run: `npm run zombieskin && npm run check:data`
Expected: 烘焙打印 `[zombieskin] 烘焙完成：assets/zombie/skin.png 64×64`；门禁输出 `✓ [丧尸皮肤] skin.png 64×64 版式 mc-standard-64 + 三区色距达标 + 指纹匹配`

- [ ] **Step 6: 目视核对皮肤图（必须真看，不能只看门禁）**

用 `sips -Z 512 assets/zombie/skin.png --out /tmp/skin-big.png` 放大后用 `read` 工具看这张图，确认：头部区能看到两只眼睛、躯干区是青蓝衣服、腿区是蓝紫、破损处露绿皮。若「三区看起来是一个颜色」，调 `SKIN_PALETTE` 后重跑本 Step。

- [ ] **Step 7: 不提交，继续下一个任务**

---

### Task 3: 渲染层改用新版式（部件尺寸 + 整面 UV 重映射）

**Files:**
- Modify: `src/render/zombie-renderer.js`
- Modify: `src/tests/test-zombies.js`

**Interfaces:**
- Consumes: `ZOMBIE_MODEL_DEFS` / `ZOMBIE_SKIN_UV` / `ZOMBIE_UV_FACES` / `remapFaceUV` / `SKIN_SIZE`（Task 1）
- Produces（对 Task 5/6 与测试可见）：
  - `ZOMBIE_PART_DEFS` 保留但**改为派生**：`size` / `offset` 从 `ZOMBIE_MODEL_DEFS` 取（`offset` = `pivot`）、`color` = `fallbackColor`、`rotation` 只保留臂的基准前伸角
  - `ZOMBIE_PARTS` 不变
  - `HEAD_FRONT_VERTICES` 不变（`[16,17,18,19]`）
  - 构造器参数仍是 `{ scene, maxActive, headTexture }`（Task 5 再改名）

**Steps:**

- [ ] **Step 1: 改写 `src/tests/test-zombies.js` 里依赖旧尺寸的断言，并新增 UV 断言**

替换「六部件尺寸/偏移/旋转/配色对齐 mc-lite」这条测试为：

```js
test('ZombieRenderer: 六部件尺寸/偏移派生自 zombie-model（原版人形口径）', () => {
  // 断言的是**派生关系**：ZOMBIE_PART_DEFS 必须等于 ZOMBIE_MODEL_DEFS 的投影，
  // 而不是各写一份数值（两份会漂移）。同时钉住「不许有人把旧的自定义尺寸改回去」。
  for (const part of ZOMBIE_PARTS) {
    const model = ZOMBIE_MODEL_DEFS[part];
    const def = ZOMBIE_PART_DEFS[part];
    assertDeepEqual(def.size, [...model.size], `${part}.size 须派生自 zombie-model`);
    assertDeepEqual(def.offset, [...model.pivot], `${part}.offset 须 = 模型轴心`);
    assertEqual(def.color, model.fallbackColor, `${part}.color 须 = 模型退回色`);
  }
  // 关键绝对值（原版口径）：躯干 0.5×0.75×0.25、四肢 0.25×0.75×0.25
  assertDeepEqual(ZOMBIE_PART_DEFS.body.size, [0.5, 0.75, 0.25]);
  assertDeepEqual(ZOMBIE_PART_DEFS.leftLeg.size, [0.25, 0.75, 0.25]);
  // 臂仍保留基准前伸角（左右略不对称，现状口径）
  assertEqual(ZOMBIE_PART_DEFS.leftArm.rotation[0], -Math.PI / 2.4);
  assertEqual(ZOMBIE_PART_DEFS.rightArm.rotation[0], -Math.PI / 2.7);
  // 腿的静态 rotation 为 null（摆幅由步态给）
  assertNull(ZOMBIE_PART_DEFS.leftLeg.rotation);
  assertNull(ZOMBIE_PART_DEFS.rightLeg.rotation);
});

test('ZombieRenderer: 有纹理时每个面的 UV 落在该部件对应的皮肤矩形内', () => {
  const dummy = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const { renderer } = makeZombieFixture({ headTexture: dummy });
  const FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
  for (const part of ZOMBIE_PARTS) {
    const uv = renderer.meshes[part].geometry.getAttribute('uv');
    const table = ZOMBIE_SKIN_UV[part];
    FACES.forEach((face, faceIndex) => {
      const r = table[face];
      const u0 = Math.min(r[0], r[2]) / SKIN_SIZE, u1 = Math.max(r[0], r[2]) / SKIN_SIZE;
      const v0 = Math.min(r[1], r[3]) / SKIN_SIZE, v1 = Math.max(r[1], r[3]) / SKIN_SIZE;
      for (let k = 0; k < 4; k++) {
        const i = faceIndex * 4 + k;
        const u = uv.getX(i), v = uv.getY(i);
        assertTrue(u >= u0 - 1e-6 && u <= u1 + 1e-6,
          `${part}.${face} 顶点 ${i} 的 u=${u} 须落在 [${u0}, ${u1}]`);
        assertTrue(v >= v0 - 1e-6 && v <= v1 + 1e-6,
          `${part}.${face} 顶点 ${i} 的 v=${v} 须落在 [${v0}, ${v1}]`);
      }
    });
  }
});

test('ZombieRenderer: 反向书写的 UV 矩形被映射成镜像（不规范化）', () => {
  const dummy = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const { renderer } = makeZombieFixture({ headTexture: dummy });
  // body.py（+Y 面，faceIndex 2）的矩形是 [28,16,20,20]（u 反向：u0=28 → u1=20）
  const uv = renderer.meshes.body.geometry.getAttribute('uv');
  const us = [0, 1, 2, 3].map((k) => uv.getX(2 * 4 + k));
  const vs = [0, 1, 2, 3].map((k) => uv.getY(2 * 4 + k));
  // 矩形规范化后应是 u ∈ [20/64, 28/64]、v ∈ [16/64, 20/64]
  const uMin = 20 / 64, uMax = 28 / 64, vMin = 16 / 64, vMax = 20 / 64;
  for (const u of us) assertTrue(u >= uMin - 1e-6 && u <= uMax + 1e-6, `u=${u} 超界`);
  for (const v of vs) assertTrue(v >= vMin - 1e-6 && v <= vMax + 1e-6, `v=${v} 超界`);
  // **镜像判据**：默认 BoxGeometry 的 +Y 面 u 递增，矩形 u1 < u0 ⇒ 映射后 u 必须递减。
  // 若实现把矩形规范化成 min/max，u 会递增 → 该面水平镜像（衣服纹理左右反了）。
  const sortedPairs = us.map((u, i) => [u, vs[i]]).sort((a, b) => a[1] - b[1]);
  assertTrue(us.some((u, i) => i > 0 && Math.abs(u - us[i - 1]) > 1e-9), '前提：u 不是常量');
  const increasingAlongV = vs[1] > vs[0] ? us[1] > us[0] : us[1] < us[0];
  // 只要 u 与 v 的走向与矩形一致即可 —— 用「极值位置」判：u 最小处应伴随 v 最大处
  // （矩形 [28,16,20,20] 意味着 u=20 ↔ v=16、u=28 ↔ v=20，即 u 大处 v 小）
  const uMaxIdx = us.indexOf(Math.max(...us));
  const uMinIdx = us.indexOf(Math.min(...us));
  assertTrue(vs[uMaxIdx] < vs[uMinIdx],
    `body.py 的 u 最大处 v 应更小（矩形 [28,16,20,20]）——实测 uMax@v=${vs[uMaxIdx]}, uMin@v=${vs[uMinIdx]}`);
});
```

同时删掉旧测试里对 `[0.55, 0.63, 0.45]` / `[0.23, 0.8, 0.23]` / `[0.26, 1.0, 0.26]` / `-0.43` / `0.3` 等旧自定义尺寸的断言；把 `makeZombieFixture` 的 `headTexture` 参数名保留（Task 5 再改名）。

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx playwright test tests/harness.spec.mjs --reporter=line`
Expected: FAIL（`ZOMBIE_PART_DEFS.body.size` 仍是 `[0.55, 0.63, 0.45]`；UV 断言超出旧矩形）

- [ ] **Step 3: 改 `src/render/zombie-renderer.js` 的部件定义与几何构造**

- 顶部 import 从 `zombie-model.js` 取 `ZOMBIE_MODEL_DEFS` / `ZOMBIE_SKIN_UV` / `ZOMBIE_UV_FACES` / `remapFaceUV` / `SKIN_SIZE`。
- `ZOMBIE_PART_DEFS` 改为从模型派生的冻结表（`size` / `offset` / `color` 派生，臂保留 `rotation: [-Math.PI/2.4, 0, 0]` / `[-Math.PI/2.7, 0, 0]`，头/躯干 `[0,0,0]`，腿 `null`）。
- 构造器里：几何按 `def.size` 建 `BoxGeometry`；`pivotAtTop` 的部件（臂/腿）调 `geometry.translate(0, -def.size[1] / 2, 0)`。
- **有纹理时**：对六个面逐面调 `remapFaceUV(uv, faceIndex, ZOMBIE_SKIN_UV[part][ZOMBIE_UV_FACES[faceIndex]])` —— 取代原 `applyHeadUV`（删掉那个函数）。
- 六个部件都带 `map`（不再只有 head）；`_baseColorOf(part)` 的语义改为「有纹理 → `0xffffff`；无纹理 → `ZOMBIE_PART_DEFS[part].color`」。
- `headHasTexture()` 暂时保留原名（Task 5 改名），返回「是否给了纹理」。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx playwright test tests/harness.spec.mjs --reporter=line`
Expected: PASS

- [ ] **Step 5: 不提交，继续下一个任务**

---

### Task 4: 烘焙产物的配色与指纹标定（实测，不放宽阈值）

**Files:**
- Modify: `tools/zombie-skin-fingerprint.mjs`（仅 `SKIN_PALETTE` / `SKIN_REGION_MIN_DIST` 若需调）
- Modify: `assets/zombie/skin.png` / `skin.json`（重跑烘焙）

**Interfaces:**
- Consumes: Task 2 的门禁与烘焙
- Produces: 通过的门禁 + 一份记录在案的实测读数（写进最终汇报，不进代码注释）

**Steps:**

- [ ] **Step 1: 量三区均值与色距**

Run: `node -e "…"`（用 `pngjs` 读 `assets/zombie/skin.png`、按 `SKIN_REGIONS` 求均值、打印三对欧氏距离）。把三对距离与三个均值都打印出来。

- [ ] **Step 2: 判断是否达标**

若三对距离都 ≥ 40 → 记下读数，进入 Step 5。若任一 < 40 → 调 `SKIN_PALETTE` 里对应两区的基色（保持「绿皮 / 青蓝上衣 / 蓝紫裤子」的语义，只调亮度与饱和度），重跑 `npm run zombieskin` 后回 Step 1。

- [ ] **Step 3: 记录 MIN_DIST 的标定依据**

`SKIN_REGION_MIN_DIST` 保持 40 不变，除非实测「达标配色下最小值只有 41~42」（贴线）—— 那种情况**下调到实测最小值 − 6** 并在汇报里写明两侧读数（同「阈值须落在两侧实测值之间」的纪律）。不得为了让现有配色过门而放宽阈值。

- [ ] **Step 4: 跑门禁确认通过**

Run: `npm run check:data`
Expected: `✓ [丧尸皮肤]` 一行含「三区色距达标 + 指纹匹配」

- [ ] **Step 5: 不提交，继续下一个任务**

---

### Task 5: 纹理加载与 `game.js` 接线改名

**Files:**
- Rename: `src/render/zombie-head-texture.js` → `src/render/zombie-skin-texture.js`
- Modify: `src/core/game.js`（import + `_zombieSkinTexture` + 传参）
- Modify: `src/render/zombie-renderer.js`（`headTexture` → `skinTexture`、`headHasTexture()` → `hasSkinTexture()`）
- Modify: `src/tests/test-zombies.js`（fixture 参数名 + 断言）

**Interfaces:**
- Consumes: `assets/zombie/skin.png`（Task 2）
- Produces:
  - `loadZombieSkinTexture(): Promise<THREE.Texture>`（`src/render/zombie-skin-texture.js`）
  - `ZombieRenderer` 构造器 `{ scene, maxActive, skinTexture }`
  - `renderer.hasSkinTexture(): boolean`
  - `makeZombieFixture({ skinTexture })`

**Steps:**

- [ ] **Step 1: 改测试（先失败）**

把 `src/tests/test-zombies.js` 里所有 `headTexture` / `headHasTexture` 改为 `skinTexture` / `hasSkinTexture`，并把「无纹理时 head 退回视觉色」改名扩成：

```js
test('ZombieRenderer: 无纹理时六部件退回各自视觉色（不渲染成纯白）', () => {
  const { renderer } = makeZombieFixture(); // 无 skinTexture
  assertFalse(renderer.hasSkinTexture(), '默认 fixture 不应有纹理');
  const c = new THREE.Color();
  for (const part of ZOMBIE_PARTS) {
    assertNull(renderer.meshes[part].material.map, `${part} 无纹理时不应带 map`);
    renderer.meshes[part].getColorAt(0, c);
    assertEqual(c.getHex(), ZOMBIE_MODEL_DEFS[part].fallbackColor, `${part} 退回色`);
  }
});

test('ZombieRenderer: 有纹理时六部件基色为白底（避免基色 × 纹理变暗）', () => {
  const dummy = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const { renderer } = makeZombieFixture({ skinTexture: dummy });
  const c = new THREE.Color();
  for (const part of ZOMBIE_PARTS) {
    assertTrue(!!renderer.meshes[part].material.map, `${part} 有纹理时须带 map`);
    renderer.meshes[part].getColorAt(0, c);
    assertEqual(c.getHex(), 0xffffff, `${part} 有纹理时基色须为白底`);
  }
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx playwright test tests/harness.spec.mjs --reporter=line`
Expected: FAIL（`renderer.hasSkinTexture is not a function`）

- [ ] **Step 3: 落实现**

- `git mv src/render/zombie-head-texture.js src/render/zombie-skin-texture.js`，函数改名 `loadZombieSkinTexture()`，读 `assets/zombie/skin.png`，文件头注释改成「丧尸全身皮肤（标准 64×64 版式）」。
- `zombie-renderer.js`：构造器参数 `skinTexture`，字段 `_skinTexture`，方法 `hasSkinTexture()`；`dispose()` 仍只释放一次纹理（六部件共享同一 `THREE.Texture` 实例，各自一个 `MeshBasicMaterial`）。
- `game.js`：`import { loadZombieSkinTexture } from '../render/zombie-skin-texture.js';`；`this._zombieSkinTexture = await loadZombieSkinTexture().catch(...)`（注释同步改成「皮肤纹理」）；`new ZombieRenderer({ scene, skinTexture: this._zombieSkinTexture })`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx playwright test tests/harness.spec.mjs --reporter=line`
Expected: PASS

- [ ] **Step 5: 不提交，继续下一个任务**

---

### Task 6: 手臂与头部摆动

**Files:**
- Modify: `src/entities/zombies/zombie-config.js`（新增两个常量）
- Modify: `src/render/zombie-renderer.js`（`sync()` 算相位、`_writeSlot()` 写矩阵）
- Modify: `src/tests/test-zombies.js`

**Interfaces:**
- Produces:
  - `ZOMBIE_ARM_SWING = Math.PI / 12`、`ZOMBIE_HEAD_SWAY = Math.PI / 24`（`zombie-config.js`）
  - `renderer.armSwingOf(slot, part)` / `renderer.headSwayOf(slot)` —— 只读测试接口
  - `renderer.poseOf(slot)` 返回对象新增 `armSwing` / `headSway` 字段

**Steps:**

- [ ] **Step 1: 写失败的测试**

```js
test('ZOMBIE config: 手臂与头部摆动幅度是冻结常量（渲染层不得写字面量）', () => {
  assertEqual(ZOMBIE_ARM_SWING, Math.PI / 12);
  assertEqual(ZOMBIE_HEAD_SWAY, Math.PI / 24);
  // 幅度必须小于腿的摆幅（原版：腿的跨步比手臂前后甩大）
  assertTrue(ZOMBIE_ARM_SWING < ZOMBIE_SWING, '臂摆幅须小于腿摆幅');
  assertTrue(ZOMBIE_HEAD_SWAY < ZOMBIE_ARM_SWING, '头摆幅须小于臂摆幅');
});

test('ZombieRenderer: 手臂与腿反相摆动、头部半频摆动', () => {
  const { zombies, renderer } = makeZombieFixture();
  const id = zombies.spawn([0.5, 1, .5], { source: 'test' });
  const slot = renderer.slotOf(id);
  renderer.sync(zombies, 0);
  // 静止：三者全部为 0
  assertEqual(renderer.armSwingOf(slot), 0, '静止时臂摆幅为 0');
  assertEqual(renderer.headSwayOf(slot), 0, '静止时头摆幅为 0');

  const dtMs = 500;
  zombies.setIntent(id, { vx: 0, vz: ZOMBIE.speed, mode: 'chasing' });
  renderer.sync(zombies, dtMs);
  const phase = (dtMs / 1000) * ZOMBIE_WALK_SPEED;
  const expectedLeg = Math.sin(phase) * ZOMBIE_SWING;
  const expectedArm = Math.sin(phase) * ZOMBIE_ARM_SWING;
  const expectedHead = Math.sin(phase * 0.5) * ZOMBIE_HEAD_SWAY;
  assertClose(renderer.legSwingOf(slot), expectedLeg, 1e-9, '腿摆幅');
  assertClose(renderer.armSwingOf(slot, 'leftArm'), expectedArm, 1e-9, '左臂摆幅');
  assertClose(renderer.armSwingOf(slot, 'rightArm'), -expectedArm, 1e-9, '右臂取反');
  assertClose(renderer.headSwayOf(slot), expectedHead, 1e-9, '头摆幅（半频）');

  // **矩阵级断言**（pose 内存值不是落点）：左臂/右臂的实例矩阵绕 X 的旋转必须反相，
  // 且各自 = 基准前伸角 + 摆幅。基准角来自 ZOMBIE_PART_DEFS，不与摆动混淆。
  const euler = new THREE.Euler();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const m = new THREE.Matrix4();
  const readRotX = (part) => {
    renderer.meshes[part].getMatrixAt(slot, m);
    m.decompose(p, q, s);
    euler.setFromQuaternion(q);
    return euler.x;
  };
  assertClose(readRotX('leftArm'), -Math.PI / 2.4 + expectedArm, 1e-6, '左臂矩阵 = 基准角 + 摆幅');
  assertClose(readRotX('rightArm'), -Math.PI / 2.7 - expectedArm, 1e-6, '右臂矩阵 = 基准角 − 摆幅');
  // 头：绕 Y 的摆动（不能用 Euler.y 反解到 π 之外 —— 这里摆幅远小于 π/2，安全）
  assertClose(readRotX('head'), 0, 1e-6, '头部不得绕 X 旋转');
  renderer.meshes.head.getMatrixAt(slot, m);
  m.decompose(p, q, s);
  euler.setFromQuaternion(q);
  assertClose(euler.y, expectedHead, 1e-6, '头部矩阵绕 Y = 头摆幅');
  assertClose(euler.z, 0, 1e-6, '头部不得绕 Z 旋转');

  // 静止 → 三者归零（不是冻结在上一个摆幅）
  zombies.setIntent(id, { vx: 0, vz: 0, mode: 'idle' });
  renderer.sync(zombies, dtMs + 500);
  assertEqual(renderer.legSwingOf(slot), 0);
  assertEqual(renderer.armSwingOf(slot), 0);
  assertEqual(renderer.headSwayOf(slot), 0);
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx playwright test tests/harness.spec.mjs --reporter=line`
Expected: FAIL（`ZOMBIE_ARM_SWING` 未导出 / `armSwingOf is not a function`）

- [ ] **Step 3: 落实现**

- `zombie-config.js` 加两个导出常量并写注释（含「原版：腿跨步 > 臂前后甩 > 头轻摆」的理由 + 「实玩后可调」）。
- `zombie-renderer.js` 的 `sync()`：沿用现有 `pose.swing`，新增 `pose.armSwing = Math.sin(pose.walkTime * ZOMBIE_WALK_SPEED) * ZOMBIE_ARM_SWING`、`pose.headSway = Math.sin(pose.walkTime * ZOMBIE_WALK_SPEED * 0.5) * ZOMBIE_HEAD_SWAY`；静止时三者一并归零。
- `_writeSlot()`：臂的 `rotation.x` = 基准角 ± `armSwing`（左加右减）；头的 `rotation.y` = `headSway`（`rotation.x/z` 仍 0）；腿的旋转逻辑不变。
- 新增 `armSwingOf(slot, part = 'leftArm')`（右臂返负值）与 `headSwayOf(slot)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx playwright test tests/harness.spec.mjs --reporter=line`
Expected: PASS

- [ ] **Step 5: 不提交，继续下一个任务**

---

### Task 7: Tier 4 像素实测（fixture + spec）

**Files:**
- Create: `src/tests/test-zombie-model.html`
- Create: `tests/zombie-model.spec.mjs`

**Interfaces:**
- Consumes: 渲染器 + `loadZombieSkinTexture()` + `ZOMBIE_MODEL_DEFS` / `ZOMBIE_SKIN_UV`
- Produces:
  - `window.__ZM_READY__` / `window.__ZM_ERROR__`
  - `window.__ZM_INFO__` = `{ hasSkinTexture, allPartsHaveMap, textureSize }`
  - `window.__ZM_RENDER__(view, opts)` —— `view ∈ 'front' | 'side' | 'back' | 'top'`，`opts = { flashing, phaseMs }`；返回该视角的取样点 `{ head, torso, leg, eyeL, eyeR }`（world → 屏幕像素）

**Steps:**

- [ ] **Step 1: 写 fixture**

照 `src/tests/test-zombie-head.html` 的骨架（isolated scene + 黑背景 + `outputColorSpace = SRGBColorSpace` + 每视角渲染两帧），改动：

- `ZombieRenderer({ scene, maxActive: 1, skinTexture: texture })`，pose 固定在原点、`yaw = 0`（正面朝 +Z）。
- `__ZM_RENDER__(view, { flashing = false, phaseMs = 0 })`：先 `zr.sync()` 需要一个 `ZombieService`… **不引入 service**（fixture 只验渲染）：直接改 `zr._poses[0]` 的 `swing` / `armSwing` / `headSway`（按 `phaseMs` 用与实现相同的公式算）再 `_writeSlot(0, pose)`。
- 取样点：按 `ZOMBIE_MODEL_DEFS` 的 pivot/size 算出「头正面中心」「躯干正面中心」「腿正面中心」，以及两只眼睛的屏幕位置（眼睛在皮肤里的位置由 `ZOMBIE_SKIN_UV.head.pz` 与烘焙时的眼睛像素坐标共同决定 —— **fixture 里不要硬编码眼睛的屏幕坐标，而是从烘焙参数算**：把 `tools/zombie-skin-fingerprint.mjs` 里眼睛的像素坐标导出成常量（如 `SKIN_EYES = [[x,y],[x,y]]`），fixture `import` 它在纹理空间算出 uv 再投影到面）。
- `__ZM_INFO__` 暴露 `{ hasSkinTexture, allPartsHaveMap: ZOMBIE_PARTS.filter(p => !!zr.meshes[p].material.map), textureSize: [w,h] }`。

- [ ] **Step 2: 写 spec（先失败）**

```js
import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

function regionRGB(png, cx, cy, r) { /* 同 zombie-head.spec.mjs 的辅助函数 */ }

test('丧尸模型 Tier 4：原版人形比例 + 皮肤分区 + 摆动 + 红闪', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 360 });
  await page.goto('/src/tests/test-zombie-model.html');
  await page.waitForFunction(() => window.__ZM_READY__ === true || window.__ZM_ERROR__, null, { timeout: 60_000 });
  expect(await page.evaluate(() => window.__ZM_ERROR__)).toBeUndefined();

  // ⑤ 前提：皮肤确实加载（防静默退回纯色）
  const info = await page.evaluate(() => window.__ZM_INFO__);
  expect(info.hasSkinTexture).toBe(true);
  expect(info.textureSize).toEqual([64, 64]);
  expect(info.allPartsHaveMap).toEqual([]); // 空数组 = 六部件全部带 map

  const R = 2;
  const shot = async (view, opts) => {
    const pts = await page.evaluate(([v, o]) => window.__ZM_RENDER__(v, o), [view, opts]);
    const png = PNG.sync.read(await page.screenshot());
    return { pts, png };
  };

  // ① 三个区能分开（头绿皮 / 躯干青蓝 / 腿蓝紫）
  const front = await shot('front', {});
  const head = regionRGB(front.png, front.pts.head.x, front.pts.head.y, R);
  const torso = regionRGB(front.png, front.pts.torso.x, front.pts.torso.y, R);
  const leg = regionRGB(front.png, front.pts.leg.x, front.pts.leg.y, R);
  console.log('FRONT:', JSON.stringify({ head, torso, leg }));
  const dist = (a, b) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
  expect(dist(head, torso)).toBeGreaterThan(40);
  expect(dist(torso, leg)).toBeGreaterThan(40);
  expect(dist(head, leg)).toBeGreaterThan(40);
  // 头部须偏绿（G 是最大通道——绿皮）
  expect(head.g).toBeGreaterThan(head.r);
  expect(head.g).toBeGreaterThan(head.b);

  // ② 眼睛存在（正脸暗点）
  const eye = regionRGB(front.png, front.pts.eyeL.x, front.pts.eyeL.y, 1);
  expect(eye.r + eye.g + eye.b).toBeLessThan((head.r + head.g + head.b) * 0.7);

  // ③ 侧面不串脸（侧面取样点是皮肤色、不是眼睛黑）
  const side = await shot('side', {});
  const sideTorso = regionRGB(side.png, side.pts.torso.x, side.pts.torso.y, R);
  expect(sideTorso.g).toBeGreaterThan(30);

  // ④ 摆动：两个相位下的画面必须不同
  const a = await shot('front', { phaseMs: 0 });
  const b = await shot('front', { phaseMs: 157 });
  let changed = 0, total = 0;
  for (let i = 0; i < a.png.data.length; i += 4) {
    total++;
    if (Math.abs(a.png.data[i] - b.png.data[i]) > 6) changed++;
  }
  expect(changed / total).toBeGreaterThan(0.01);

  // ⑤ 红闪仍染红
  const flash = await shot('front', { flashing: true });
  const f = regionRGB(flash.png, flash.pts.torso.x, flash.pts.torso.y, R);
  expect(f.r / Math.max(1, f.g)).toBeGreaterThan(2);
});
```

- [ ] **Step 3: 跑 spec 确认它失败**

Run: `npx playwright test tests/zombie-model.spec.mjs --reporter=line`
Expected: FAIL（fixture 不存在 / `__ZM_READY__` 不产生）

- [ ] **Step 4: 实现 fixture 让 spec 通过**

- [ ] **Step 5: 跑 spec 确认通过（阈值按实测标定）**

Run: `npx playwright test tests/zombie-model.spec.mjs --reporter=line`
Expected: PASS。**先打印实测读数再定阈值**：若某条实测值与阈值贴线（余量 < 20%），按「阈值落在两侧实测值之间」重定，并在汇报里写明两侧读数。

- [ ] **Step 6: 负向验证（每条都真跑一遍）**

逐条注入 → 跑 spec → 确认 FAIL → 用 `cp` 副本还原（**禁止 `git checkout`**，工作区有未提交改动）：

| 注入 | 期望哪条 FAIL |
|---|---|
| UV 表里 body.pz 改成 `[20,20,20,32]`（零宽） | 门禁 `[丧尸皮肤]`；单测「u 跨度不得为 0」 |
| `remapFaceUV` 里把矩形规范化（`Math.min/max`） | 单测「反向书写被保留」那条 |
| 删掉 `sync()` 里的 `armSwing` 计算 | Tier 4 摆动条 |
| 部件尺寸改回 `body.size = [0.5, 0.375, 0.25]` | 单测「总高恰 2.0」 |
| `game.js` 不传 `skinTexture` | 下一条真游戏页 spec |

- [ ] **Step 7: 不提交，继续下一个任务**

---

### Task 8: 真游戏页接线验收 + 旧产物清理 + 文档同步

**Files:**
- Modify: `tests/zombie-model.spec.mjs`（追加真游戏页用例）
- Delete: `assets/zombie/head.png`、`assets/zombie/head.json`、`tools/bake-zombie-head.mjs`、`tools/zombie-head-fingerprint.mjs`、`src/tests/test-zombie-head.html`、`tests/zombie-head.spec.mjs`
- Modify: `docs/roadmap.md`、`AGENTS.md`、`docs/m6-zombies-acceptance-report.md`

**Steps:**

- [ ] **Step 1: 追加真游戏页用例**

```js
test('丧尸模型：真游戏页确实接线了皮肤（防忘传 → 静默退回纯色）', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?vd=4&seed=12345');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  const info = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return {
      hasSkinTexture: g.zombieRenderer.hasSkinTexture(),
      partsWithMap: ['head', 'body', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg']
        .filter((p) => !!g.zombieRenderer.meshes[p].material.map).length,
      textureSize: (() => {
        const img = g.zombieRenderer.meshes.head.material.map?.image;
        return img ? [img.width, img.height] : null;
      })(),
    };
  });
  expect(info.hasSkinTexture).toBe(true);
  expect(info.partsWithMap).toBe(6);
  expect(info.textureSize).toEqual([64, 64]);
});
```

- [ ] **Step 2: 跑确认通过**

Run: `npx playwright test tests/zombie-model.spec.mjs --reporter=line`
Expected: PASS（含真游戏页）

- [ ] **Step 3: 跑护栏 spec（确认 draw call 仍是 6）**

Run: `npx playwright test tests/zombies.spec.mjs tests/zombie-nests.spec.mjs --reporter=line`
Expected: 全绿；`zombies.spec.mjs` 的 `drawCalls 增量 === 6` 断言**逐字未改**且通过

- [ ] **Step 4: 删旧产物与旧模块**

```bash
git rm assets/zombie/head.png assets/zombie/head.json \
       tools/bake-zombie-head.mjs tools/zombie-head-fingerprint.mjs \
       src/tests/test-zombie-head.html tests/zombie-head.spec.mjs
```

（都是 git 已跟踪文件，可恢复。`package.json` 的 `zombie` 脚本已在 Task 2 换成 `zombieskin`。）

- [ ] **Step 5: 跑全部门禁**

Run: `npm run check`
Expected: 三项全绿（`check:arch` / `check:data` 含 `[丧尸皮肤]` / `lint` 0 error）

- [ ] **Step 6: 同步文档**

- `docs/roadmap.md`：在「M3.2 之后的独立 bugfix / 改造」表末尾加一行 `v2.38`，记录：原版人形重建（六部件尺寸/UV 换标准 64×64 皮肤）、三处实测数值（总高 2.0 / 躯干 0.5×0.75×0.25 / draw call 仍 6）、负向验证条数、已知取舍（头顶 0.2 在 AABB 之外）。
- `AGENTS.md`：把「M6 丧尸沉淀的活跃约束」里关于头部马赛克纹理那条**扩写**为「皮肤 = 标准 64×64 + 六部件 UV 矩形」（保留 WebGPU 不支持材质数组那条），并更新目录结构里的 `assets/zombie/` 与 `tools/` 两个条目、开发命令里的 `npm run zombie` → `npm run zombieskin`。
- `docs/m6-zombies-acceptance-report.md`：§6 偏离表追加一行「模型口径 2026-11-04 改为原版人形」。

- [ ] **Step 7: 汇报，等用户确认后再提交**

不再有任何 `git commit`。把以下内容整理成汇报：改了哪些文件、`npm run check` 输出、单测与 spec 的实测读数（含阈值标定依据）、6 条负向验证的结果、四处文档同步。

---

## Self-Review

**1. Spec coverage**

| 规格章节 | 覆盖任务 |
|---|---|
| §4.1 部件几何（尺寸/轴心/总高 2.0） | Task 1（定义 + 测试）、Task 3（渲染器消费） |
| §4.1 对外接口保持不变（`ZOMBIE_PARTS` / `ZOMBIE_PART_DEFS` / `HEAD_FRONT_VERTICES`） | Task 3 |
| §4.2 皮肤烘焙（64×64 + 固定种子 + 四区语义） | Task 2 |
| §4.2 「RGB 待实施时按可用性定」 | Task 4（标定步骤） |
| §4.3 UV 映射（含反向矩形、`NearestFilter`） | Task 1（`remapFaceUV`）、Task 3（构造期调用）、Task 3 的镜像断言 |
| §4.3 红闪口径不变 | Task 7 的红闪断言 |
| §4.4 纹理加载 + `game.js` 接线改名 + 六部件共享一个纹理 | Task 5 |
| §4.4 `hasSkinTexture()` 改名（不留别名） | Task 5 |
| §4.5 摆动（两个常量 + 三条公式 + 静止归零） | Task 6 |
| §4.6 无纹理退回色 | Task 5 |
| §5 影响面清单（含删除） | Task 2/5/8 |
| §7 Tier 1 | Task 1/3/6 |
| §7 Tier 2 | Task 2/4 |
| §7 Tier 4（五条 + 真游戏页） | Task 7/8 |
| §7 负向验证 6 条 | Task 7 Step 6 + Task 8 Step 3 |
| §9 验收口径（`drawCalls === 6` 不动） | Task 8 Step 3 |

无缺口。

**2. Step scan**

- 每个测试步骤带完整断言代码（实施者可直接抄）。
- 每个实现步骤只给签名/数据表/约束，不给完整函数体（`remapFaceUV` 与 `ZOMBIE_SKIN_UV` 的完整内容属「规格锁定的精确数据」与「三行公式」，给出来是必要的）。
- Task 2 Step 4 的绘制规则用「必须满足的约束」表达（6 条），不是逐行代码 —— 因为绘制细节是实现者的自由，而约束（固定种子、四区语义、眼睛在正脸区、两只眼对称）是设计锁定的。
- Task 4 是纯标定任务（无可写代码），步骤是「量 → 判断 → 调 → 复量」。
- 无「TBD」「处理边界情况」这类空步骤。

**3. Type consistency**

- `ZOMBIE_MODEL_DEFS[part].pivot` 在 Task 1 定义、Task 3 映射为 `ZOMBIE_PART_DEFS[part].offset`、Task 5 用 `fallbackColor`、Task 7 fixture 用 `pivot`/`size` —— 名字一处定义、各处引用一致。
- `ZOMBIE_SKIN_UV[part][face]` 的 face 键在 Task 1 定义（`px/nx/py/ny/pz/nz`）、Task 2 的 `uvFingerprint()`、Task 3 的构造期循环、Task 3 的断言、Task 7 fixture 全都用同一组键。
- `remapFaceUV(uv, faceIndex, rect)` 签名在 Task 1 定义，Task 3 按它调用，无第二形态。
- `skinTexture` / `hasSkinTexture()` 在 Task 5 统一改名，Task 7/8 用新名。
- `SKIN_PNG` / `SKIN_JSON` / `SKIN_LAYOUT_VERSION` / `SKIN_REGIONS` / `SKIN_REGION_MIN_DIST` / `skinInputFingerprint()` 在 Task 2 定义，Task 2 的门禁与 Task 4 的标定脚本使用，名字一致。

**4. Review Focus**

五条都已绑到具体任务与断言：反向矩形 → Task 1「反向书写被保留」+ Task 3「镜像映射」；轴映射搞反 → Task 1「六面互不重叠」+ Task 7「侧面不串脸」；轴心没移到顶端 → Task 3 的 `pivotAtTop` 派生 + Task 6 的矩阵断言（`readRotX` 读的是实例矩阵）；纹理静默降级 → Task 8 真游戏页；三区配色撞车 → Task 2 门禁 + Task 4 标定。

**5. Proportion**

计划约 700 行，规格约 290 行；代码块以「测试断言 + 两张精确数据表」为主，实现步骤基本是签名与约束。比例合理（数据表是规格固定的，测试是 TDD 要求）。
