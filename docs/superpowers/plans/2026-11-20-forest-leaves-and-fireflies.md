# 森林落叶与草地萤火虫 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 森林 biome 里玩家周围有秋色单色叶片随风飘落（落地即消失），草地 biome 里有稀疏萤火虫飞舞（夜里更亮更密），共用一个面板开关，零新增贴图/烘焙/方块，性能不回退。

**Architecture:** 两个独立 GPU 实例池（`THREE.Mesh` + `InstancedBufferGeometry`，各 1 draw call），运动全在顶点着色器；CPU 只做 5Hz biome 门控 + 30Hz 距离检查 + 每帧 ≤32 片分批迁移 + `isSolid` 地面截停。骨架照 `render/rain.js`，池结构照 `render/spike-fx-material.js`。观感常量与纯函数落在 three-free 的 `ambient-fx-config.js`。

**Tech Stack:** three r185.1 本地 vendor（import map）、TSL（`three/tsl`）、WebGPU 唯一后端、Playwright（channel chromium）、Node v26。

**Spec:** `docs/superpowers/specs/2026-11-20-forest-leaves-and-fireflies-design.md`

## Global Constraints

以下为 spec 的项目级要求，**每个 Task 的要求都隐含包含本节**。数值逐字取自 spec。

- **零新增资源**：不新增贴图 / 烘焙产物 / 方块 / 音效 / 依赖。落叶颜色从已加载 atlas 取。
- **粒子必须 `THREE.Mesh` + `InstancedBufferGeometry`**，禁 `InstancedMesh`（instanceMatrix 会接管 modelViewMatrix ⇒ 全塌到原点，v3.21 实测）。
- **世界摆放走 `vertexNode`**，不用 `positionNode`（后者返回值会被 `modelViewMatrix` 再乘一次）。
- **逐实例参数走 instanced attribute + `varyingProperty`**（片元读不到 instanced 属性，v3.20 实测）。
- **常量色显式拆分量 `vec3(c.r, c.g, c.b)`**；禁 `vec3(new THREE.Color(hex))`（WebGPU 输出纯黑且零报错，v3.14 实测非黑像素 0 vs 10455）。
- **节点不得与裸 JS 数字算术**（`float(x)*1.4` 生成 `NaN.0`），一律 `.mul(1.4)`。
- **多层 mix 嵌套 `mix(mix(a,b,t),c,t2)`**，禁链式 `.mix()`（v3.21 实测暖色像素 78620→88）。
- **`Fn` 不返回多键对象**（SplitNode 陷阱：自定义键全 undefined ⇒ 整片 pass 不上屏）。「把几行节点表达式装起来」用普通 JS 函数。
- **uniform 按调用闭包捕获**，禁模块级 `let U`（TSL `Fn` 体惰性求值，v3.22 实测两池互相覆写 uTime）。
- **时间属性与 `uTime` 同一时钟（绝对秒）**；时间基准 `performance.now()`，禁 `Date.now()`。
- **径向量在片元算**：quad 只有 4 顶点，顶点算 `length()` 插值后恒为常数（v3.23 实测）。
- **空闲 `visible=false`**（否则恒增 draw call 且干扰水面透明排序不变式）。
- **每帧零分配**：临时对象一律模块级常量。
- **`renderOrder = CINDER_FX.renderOrder`（= 3）**：体素水 0 < 海面 1 < 曳光 2 < 特效 3。
- **`castShadow = false` / `receiveShadow = false`**（transparent 双 false，VSM 硬约束）。
- **密度调节不靠 `instanceCount`**（spec §3.5）：容量固定，萤火虫白天/夜里的数量差走逐实例 `aAlive`（0 ⇒ 缩零不可见）。
- **依赖方向**：`ambient-fx-config.js` 不 import three、不 import `leaf-fx.js`/`firefly-fx.js`（会循环）。
- **红线 1（单一权威）**：biome 判定只用 `gen/noise.js:getBiome`；夜间因子只用 `daynight.js:nightBlendOf`；落叶色只用既有 `blockColorResolver`；昼夜亮度直接引用 `renderWorld.materials.dayNight` 的 uniform 实例。
- **不改的东西**：`vegetation.js:pickLeaf` 权重、`rain.js` 全部参数与断言、`setupFog` 公式、`setFogColorEnabled`/`fogColorEnabled` 两个 API、UI 层级不等式。
- **冻结断言不符时停下报告**，不擅自改断言或放宽阈值（spec §7）。
- **bench 基线不得重写**：只用 `npm run bench -- --check`；若误跑了不带 `--check` 的版本，`git checkout docs/m3-baseline.md docs/m3-baseline.json` 恢复。
- **并发会话**：本仓有另一条线同时工作。它的 v3.25（设置弹窗两个 Tab）已于 **commit 5353dcb** 入库；当前 `src/ui/settings-panel.js` 又有一处它的未提交改动（`ABOUT_PARAGRAPH` 文案）。本轮只做定点 `edit`，**禁整文件 `write`、禁 `git add -A`、禁 `git stash`、禁 `git checkout <这些文件>`**；提交前 `git diff --cached` 逐 hunk 核对，必要时 `git add -p`。
- **提交**：Conventional Commits，逐文件 `git add <具体路径>`。**每个 Task 末尾提交前须得到用户明确指令**（项目规范：提交必须等明确指令）；未获指令时把改动留在工作树并在报告里说明。

## Review Focus

spec 隐含但各 Task 的测试未直接覆盖的五类失效，按最可能咬人排序。每条都已在对应 Task 里补了测试步骤。

1. **切分辨率档后特效静默消失** —— 粒子数是几何容量（构造期固定），`_rebuildAmbientFx` 若漏喂 `enabled`/biome 门控，重建出的池永远 invisible。玩家点「性能」后落叶没了，而 draw call/计数全对。→ Task 6 Step 7。
2. **走出森林再走回来，叶子全在同一相位** —— 关闭态若把 `uTime` 也停掉，回来时 `age` 跳变；若清空缓冲则闪断。→ Task 3 Step 9、Task 5 Step 7。
3. **玩家快速移动时叶片留在身后** —— 分批迁移只改 origin 不改 groundY，或批大小为 0/过大。表现为「跑起来就没叶子了」。→ Task 3 Step 7。
4. **夜里落叶比草地还亮** —— 昼夜 uniform 只传了句柄没接进 colorNode，或接成了自己 new 的 uniform。→ Task 2 Step 7、Task 6 Step 5。
5. **面板开关点了没反应（但高亮变了）** —— `_rowAmbientFx` 只写 `settings` 没调 `game.setAmbientFxEnabled`，或 `?ambient=0` 与设置值的 AND 写成了 OR。→ Task 7 Step 5、Task 6 Step 9。

---

### Task 1: 观感常量与纯函数（three-free）

**Files:**
- Create: `src/render/ambient-fx-config.js`
- Create: `src/tests/test-ambient-fx.js`
- Modify: `src/tests/index.html`（在 `import './test-spike-sparks.js';` 之后追加一行）
- Modify: `tools/test-tiers.mjs`（`UNIT_NODE_SAFE` 数组追加 `'test-ambient-fx.js'`）

**Interfaces:**
- Consumes: `CINDER_FX` from `./cinder-fall-config.js`（取 `renderOrder`）；`nightBlendOf` 由调用方传入 `nb`，本模块**不 import daynight**（保持纯数据）。
- Produces:
  - `LEAF_FX`（冻结对象）：`{ capacity: 220, capacityPerformance: 110, radius: 18, birthMin: 3, birthMax: 13, fallSpeed: [0.55, 0.90], swayAmp: [0.5, 1.1], swayFreq: [0.6, 1.3], spin: [0.8, 2.4], size: [0.10, 0.18], maxScreen: 0.03, floorOffset: 0.02, landFadeSeconds: 0.6, sideShade: 0.845, refreshDistance: 8, refreshVertical: 6, refreshInterval: 1/30, biomeInterval: 1/5, refreshBatchSize: 32, searchDepth: 24, renderOrder }`
  - `LEAF_AUTUMN_WEIGHTS`：`readonly [string, number][]`，五项，顺序 = `yellow_leaves 0.65` / `giant_banyan_leaves 0.12` / `giant_palm_leaves 0.08` / `leaves 0.10` / `giant_spruce_leaves 0.05`
  - `FIREFLY_FX`（冻结对象）：`{ capacity: 42, capacityPerformance: 21, countDay: 28, countNight: 42, radius: 14, heightMin: 0.4, heightMax: 2.6, amp: [0.3, 0.9], freq: [0.5, 1.6], drift: 0.25, lifetime: [6, 12], size: [0.09, 0.16], breatheFreq: [0.7, 1.9], gainDay: 0.55, gainNight: 1.15, colorHex: 0xc8ff50, coreEdge: 0.35, haloFalloff: 2.2, maxScreen: 0.02, floorClearance: 0.25, renderOrder, refreshDistance: 8, refreshVertical: 6, refreshInterval: 1/30, biomeInterval: 1/5, refreshBatchSize: 16, searchDepth: 24 }`
  - `leafSeedAt(center, groundY, rand, cfg?)` → `{ x, y, z, minY, fallSpeed, swayAmp, swayFreq, swayPhase, spinX, spinY, spinZ, size }`
  - `fireflySeedAt(center, groundY, rand, cfg?)` → `{ x, y, z, groundY, ampX, ampY, ampZ, freqX, freqY, freqZ, phaseX, phaseY, phaseZ, driftX, driftZ, size, breatheFreq, breathePhase, life }`
  - `pickAutumnLeaf(sigma, weights?)` → `string`（方块名）
  - `leafLandSeconds(seed)` → `number`（`(y − minY) / fallSpeed`）
  - `leafMotionAt(seed, tSec, out?)` → `{ x, y, z, rotX, rotY, rotZ, landed, alpha }`（**CPU 复刻 shader**，`out` 可复用）
  - `fireflyMotionAt(seed, tSec, out?)` → `{ x, y, z }`（CPU 复刻）
  - `fireflyNightAt(nb, cfg?)` → `{ gain, count }`
  - `ambientParticleCount(mode, kind)` → `number`（`kind: 'leaf'|'firefly'`；`mode` 经 `normPixelRatioMode` 归一化）

- [ ] **Step 1: 写失败测试（常量关系 + 权重和）**

在 `src/tests/test-ambient-fx.js` 写：

```js
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { LEAF_FX, FIREFLY_FX, LEAF_AUTUMN_WEIGHTS } from '../render/ambient-fx-config.js';
import { CINDER_FX } from '../render/cinder-fall-config.js';

test('ambient: 两张常量表冻结，renderOrder 与既有特效同档', () => {
  assertTrue(Object.isFrozen(LEAF_FX) && Object.isFrozen(FIREFLY_FX), '须冻结');
  assertEqual(LEAF_FX.renderOrder, CINDER_FX.renderOrder);
  assertEqual(FIREFLY_FX.renderOrder, CINDER_FX.renderOrder);
});

test('ambient: 秋色权重和恰为 1（不做归一化兜底）', () => {
  const sum = LEAF_AUTUMN_WEIGHTS.reduce((n, [, w]) => n + w, 0);
  assertTrue(Math.abs(sum - 1) < 1e-9, `权重和 ${sum}`);
});

test('ambient: 出生带上界不超过森林叶层聚合上界（用户点名「高于树不得有落叶」）', () => {
  // 实测：33×33 森林范围内代码生成树的叶层相对地面上界 +14（spec §3.3）
  assertTrue(LEAF_FX.birthMax < 14, `birthMax=${LEAF_FX.birthMax}`);
  assertTrue(LEAF_FX.birthMin >= 2, '下界须在矮树叶层最低处之上');
});

test('ambient: 性能档粒子数严格小于清晰档，且容量装得下夜间上限', () => {
  assertTrue(LEAF_FX.capacityPerformance < LEAF_FX.capacity, '落叶');
  assertTrue(FIREFLY_FX.capacityPerformance < FIREFLY_FX.capacity, '萤火虫');
  assertTrue(FIREFLY_FX.countNight <= FIREFLY_FX.capacity, '夜间只数不得越界');
  assertTrue(FIREFLY_FX.countDay < FIREFLY_FX.countNight, '夜里更密');
});
```

同时在 `src/tests/index.html` 的 `import './test-spike-sparks.js';` 后加 `import './test-ambient-fx.js';`，在 `tools/test-tiers.mjs` 的 `UNIT_NODE_SAFE` 里追加 `'test-ambient-fx.js'`（两处漏任一都会被 `check:data` 抓）。

- [ ] **Step 2: 跑测试确认 RED**

Run: `node tools/run-unit-node.mjs --only=test-ambient-fx.js`
Expected: FAIL —— `Cannot find module .../ambient-fx-config.js`（import 失败硬失败，不是 0 例全绿）。

- [ ] **Step 3: 建 `ambient-fx-config.js`，只写常量表**

按 Interfaces 的字段与值写两张 `Object.freeze` 表 + `LEAF_AUTUMN_WEIGHTS`（`Object.freeze` 外层与每项）。`renderOrder` 从 `CINDER_FX.renderOrder` 取，**不写字面量 3**。每个非显然值写一行中文注释说明依据（引 spec 章节号）。文件头注明「three-free、不 import leaf-fx/firefly-fx（会循环）」。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `node tools/run-unit-node.mjs --only=test-ambient-fx.js`
Expected: PASS（4 例）。

- [ ] **Step 5: 写失败测试（出生采样 + 秋色抽签）**

追加：

```js
import { leafSeedAt, fireflySeedAt, pickAutumnLeaf } from '../render/ambient-fx-config.js';

/** 确定性 LCG（同 test-spike-sparks.js 的 makeRand） */
function makeRand(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

test('ambient: 落叶出生在圆内面积均匀 + 高度带内 + minY 贴地', () => {
  const rand = makeRand(7);
  const c = { x: 100, y: 0, z: -50 };
  let inner = 0;
  for (let i = 0; i < 2000; i++) {
    const s = leafSeedAt(c, 8, rand);
    const r = Math.hypot(s.x - c.x, s.z - c.z);
    assertTrue(r <= LEAF_FX.radius + 1e-9, `半径越界 ${r}`);
    if (r <= LEAF_FX.radius / 2) inner++;
    assertTrue(s.y >= 8 + LEAF_FX.birthMin - 1e-9 && s.y <= 8 + LEAF_FX.birthMax + 1e-9, `y=${s.y}`);
    assertEqual(s.minY, 8 + LEAF_FX.floorOffset);
  }
  // 面积均匀 ⇒ 内半圆占 25%（角度均匀会挤在圆心 ⇒ 约 50%）
  const share = inner / 2000;
  assertTrue(share > 0.20 && share < 0.30, `内半圆占比 ${share}`);
});

test('ambient: 萤火虫出生在贴地高度带内，三轴频率互不相同', () => {
  const rand = makeRand(11);
  for (let i = 0; i < 500; i++) {
    const s = fireflySeedAt({ x: 0, y: 0, z: 0 }, 5, rand);
    assertTrue(s.y >= 5 + FIREFLY_FX.heightMin - 1e-9 && s.y <= 5 + FIREFLY_FX.heightMax + 1e-9, `y=${s.y}`);
    assertTrue(s.freqX !== s.freqY && s.freqY !== s.freqZ && s.freqX !== s.freqZ, '三轴同频会读作绕圈');
    assertTrue(s.driftX !== 0 || s.driftZ !== 0, '要有慢漂移');
  }
});

test('ambient: 秋色抽签按权重分箱，σ 越界不静默落回第一项', () => {
  assertEqual(pickAutumnLeaf(0), 'yellow_leaves');
  assertEqual(pickAutumnLeaf(0.64), 'yellow_leaves');
  assertEqual(pickAutumnLeaf(0.65), 'giant_banyan_leaves');
  assertEqual(pickAutumnLeaf(0.999), 'giant_spruce_leaves');
  let threw = false;
  try { pickAutumnLeaf(1.5); } catch { threw = true; }
  assertTrue(threw, 'σ 越界须抛错（静默回落会放大第一项占比）');
});
```

- [ ] **Step 6: 跑测试确认 RED**

Run: `node tools/run-unit-node.mjs --only=test-ambient-fx.js`
Expected: FAIL —— `leafSeedAt is not a function` / 导出缺失。

- [ ] **Step 7: 实现出生采样与抽签**

签名见 Interfaces。要点：
- 圆内采样 `r = radius * Math.sqrt(rand())`（直接 `rand()` 当半径会挤在圆心）。
- 区间量一律 `lo + rand() * (hi - lo)`。
- 萤火虫三轴频率：先抽 `f0`，再 `f1 = f0 * (1.31 + rand()*0.4)`、`f2 = f0 * (0.61 + rand()*0.3)`，最后各自钳进 `freq` 区间 —— **保证互不相同且非整数倍**（钳制后仍可能相等，故用 `while` 重抽或加固定微偏移；实现者选一种并让 Step 5 的断言通过）。
- `pickAutumnLeaf`：累加权重分箱；`sigma < 0 || sigma >= 1` 抛 `RangeError`。
- `leafSeedAt` 的 `minY = groundY + floorOffset`；`y = groundY + birthMin + rand()*(birthMax−birthMin)`。

- [ ] **Step 8: 跑测试确认 GREEN**

Run: `node tools/run-unit-node.mjs --only=test-ambient-fx.js`
Expected: PASS（7 例）。

- [ ] **Step 9: 写失败测试（运动闭式复刻 + 夜间派生 + 档位）**

追加：

```js
import {
  leafLandSeconds, leafMotionAt, fireflyMotionAt, fireflyNightAt, ambientParticleCount,
} from '../render/ambient-fx-config.js';

test('ambient: 落叶 y 单调不增且不低于 minY；落地后 x/z/rot 全部冻结', () => {
  const s = leafSeedAt({ x: 0, y: 0, z: 0 }, 8, makeRand(3));
  const tLand = leafLandSeconds(s);
  assertTrue(tLand > 0, '落地时刻须为正');
  let prevY = Infinity;
  for (let t = 0; t <= tLand + 2; t += 0.1) {
    const m = leafMotionAt(s, t);
    assertTrue(m.y <= prevY + 1e-9, `y 上升了 t=${t}`);
    assertTrue(m.y >= s.minY - 1e-9, `y 穿地 t=${t}`);
    prevY = m.y;
  }
  const a = leafMotionAt(s, tLand + 0.05);
  const b = leafMotionAt(s, tLand + 1.20);
  assertEqual(a.x, b.x); assertEqual(a.z, b.z);
  assertEqual(a.rotX, b.rotX); assertEqual(a.rotY, b.rotY); assertEqual(a.rotZ, b.rotZ);
  assertTrue(a.alpha > b.alpha, '落地后须淡出');
  assertTrue(leafMotionAt(s, tLand + LEAF_FX.landFadeSeconds + 0.01).alpha <= 1e-9, '淡出到 0');
});

test('ambient: 萤火虫 y 无长期漂移（不飘上天也不钻地）', () => {
  const s = fireflySeedAt({ x: 0, y: 0, z: 0 }, 5, makeRand(5));
  let sum = 0; let n = 0; let minY = Infinity;
  for (let t = 0; t < 120; t += 0.05) {
    const m = fireflyMotionAt(s, t);
    sum += m.y; n++; minY = Math.min(minY, m.y);
  }
  assertTrue(Math.abs(sum / n - s.y) < 0.05, `y 均值漂移 ${sum / n - s.y}`);
  assertTrue(minY >= 5 + FIREFLY_FX.floorClearance - 1e-9, `钻地 minY=${minY}`);
});

test('ambient: 夜间 gain/count 单调不减，两端等于常量表', () => {
  const d = fireflyNightAt(0); const n = fireflyNightAt(1);
  assertEqual(d.gain, FIREFLY_FX.gainDay); assertEqual(n.gain, FIREFLY_FX.gainNight);
  assertEqual(d.count, FIREFLY_FX.countDay); assertEqual(n.count, FIREFLY_FX.countNight);
  let pg = -1; let pc = -1;
  for (let nb = 0; nb <= 1.0001; nb += 0.05) {
    const r = fireflyNightAt(nb);
    assertTrue(r.gain >= pg - 1e-9 && r.count >= pc, '须单调不减');
    assertTrue(r.count <= FIREFLY_FX.capacity, 'count 不得越界');
    pg = r.gain; pc = r.count;
  }
});

test('ambient: 档位 → 粒子数（非法档位回落清晰档）', () => {
  assertEqual(ambientParticleCount('sharp', 'leaf'), LEAF_FX.capacity);
  assertEqual(ambientParticleCount('performance', 'leaf'), LEAF_FX.capacityPerformance);
  assertEqual(ambientParticleCount('performance', 'firefly'), FIREFLY_FX.capacityPerformance);
  assertEqual(ambientParticleCount('bogus', 'leaf'), LEAF_FX.capacity);
});
```

- [ ] **Step 10: 跑测试确认 RED**

Run: `node tools/run-unit-node.mjs --only=test-ambient-fx.js`
Expected: FAIL —— 五个新函数未导出。

- [ ] **Step 11: 实现运动复刻与派生函数**

**这是本 Task 唯一需要写公式体的地方**（shader 侧要逐字对应，故公式在此钉死）：

```
tLand = (y − minY) / fallSpeed
tEff  = min(t, tLand)                        // 落地后冻结摆荡与自转
y(t)  = max(y − fallSpeed × t, minY)
x(t)  = x + swayAmp × sin(swayFreq × tEff + swayPhase)
z(t)  = z + swayAmp × cos(swayFreq × 0.83 × tEff + swayPhase)
rotX  = spinX × tEff;  rotY = spinY × tEff;  rotZ = spinZ × tEff
landed = t >= tLand
alpha  = landed ? clamp(1 − (t − tLand)/landFadeSeconds, 0, 1) : 1

firefly:
x(t) = x + driftX × t + ampX × sin(freqX × t + phaseX)
y(t) = max(y + ampY × sin(freqY × t + phaseY), groundY + floorClearance)
z(t) = z + driftZ × t + ampZ × sin(freqZ × t + phaseZ)
```

⚠️ `fireflyMotionAt` 的 y 钳制需要 `groundY`：把它作为 seed 的一个字段（`groundY`）在 `fireflySeedAt` 里存下，**不要**让调用方再传一次（两处传会漂移）。
⚠️ `leafMotionAt` / `fireflyMotionAt` 默认返回**复用对象**（模块级 `_leafOut` / `_flyOut`），传 `out` 时用传入的；单测不传 `out` 时每次新建（方便逐次比较）—— 照 `spikeScaleAt` 的口径。
`fireflyNightAt(nb)`：`gain = gainDay + (gainNight−gainDay)×nb`，`count = Math.round(countDay + (countNight−countDay)×nb)`，`nb` 先钳 [0,1]。
`ambientParticleCount(mode, kind)`：经 `normPixelRatioMode` 归一化后查表。

- [ ] **Step 12: 跑测试确认 GREEN + 静态门**

Run: `node tools/run-unit-node.mjs --only=test-ambient-fx.js && npm run check`
Expected: 单测累计 11 例 PASS；`check:arch` / `check:data` / `lint` 全绿（`check:data` 的 `[测试注册]` 与 `[测试分档]` 会验两处归档）。

- [ ] **Step 13: 提交（须先得到用户明确指令）**

```bash
git add src/render/ambient-fx-config.js src/tests/test-ambient-fx.js src/tests/index.html tools/test-tiers.mjs
git commit -m "feat(render): 环境特效观感常量与纯函数（落叶/萤火虫）"
```

⚠️ `tools/test-tiers.mjs` 当前干净（v3.25 的 `about-tab` 归档行已入库），但并发会话可能再动它 ⇒ 提交前 `git diff --cached tools/test-tiers.mjs` 核对只含本轮那一行；含别人的行时改用 `git add -p`。

---

### Task 2: 落叶 TSL 材质与几何

**Files:**
- Create: `src/render/leaf-fx-material.js`
- Modify: `src/tests/test-ambient-fx.js`（追加 TSL 结构用例）

**Interfaces:**
- Consumes: `LEAF_FX` from `./ambient-fx-config.js`；`THREE` / `three/tsl`。
- Produces:
  - `LEAF_ATTR`（冻结）：`{ origin:'aOrigin', params:'aParams', sway:'aSway', spin:'aSpin', color:'aColor', size:'aSize', born:'aBorn', alpha:'aAlpha' }`
    - `aOrigin` vec3 = (x, y, z) 出生点；`aParams` vec2 = (minY, fallSpeed)；`aSway` vec3 = (amp, freq, phase)；`aSpin` vec3 = (spinX, spinY, spinZ)；`aColor` vec3 = 线性 RGB；`aSize` float；`aBorn` float = 出生绝对秒；`aAlpha` float = CPU 每帧写的淡出系数（落地后 0→1 递减）
  - `createLeafGeometry(capacity)` → `THREE.InstancedBufferGeometry`（单 quad 4 顶点 / 6 索引，`instanceCount = capacity`，`boundingSphere` 半径 1e4，八个属性齐全且 `DynamicDrawUsage`）
  - `createLeafMaterial({ skyDim, shadowStrength })` → `{ material: THREE.MeshBasicNodeMaterial, uniforms: { uTime, uSkyDim, uShadowStrength } }`
    - `skyDim` / `shadowStrength` 是**外部 uniform 实例**（装配层传 `renderWorld.materials.dayNight.uSkyDim` / `.uShadowStrength`）；缺省（undefined）时材质内部退化为常量 1。
    - 返回的 `uniforms` **把这两个句柄原对象透出**（Step 1 的最后一条用 `===` 钉它）。

- [ ] **Step 1: 写失败测试（几何 + 材质结构）**

追加到 `test-ambient-fx.js`（文件顶部补 `import * as THREE from 'three';`）：

```js
import { LEAF_ATTR, createLeafGeometry, createLeafMaterial } from '../render/leaf-fx-material.js';

/** 取真正的 TSL 函数体（照 test-spike-sparks.js 的 nodeSource/nodeCode，含去注释） */
function nodeSource(node, depth = 0) {
  if (!node || depth > 6) return '';
  if (typeof node.jsFunc === 'function') return String(node.jsFunc);
  for (const k of ['node', 'shaderNode']) {
    if (node[k]) { const s = nodeSource(node[k], depth + 1); if (s) return s; }
  }
  return '';
}
const nodeCode = (n) => nodeSource(n).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

test('leaf 几何: 八个属性齐全、单 quad、instanceCount = 容量、包围球够大', () => {
  const g = createLeafGeometry(64);
  assertEqual(g.instanceCount, 64);
  assertEqual(g.getAttribute('position').count, 4);
  assertEqual(g.getIndex().count, 6);
  for (const name of Object.values(LEAF_ATTR)) assertTrue(!!g.getAttribute(name), `缺 ${name}`);
  assertTrue(g.boundingSphere.radius >= 1000, '包围球太小会被误剔除');
  assertTrue(g.isInstancedBufferGeometry === true, '必须是 InstancedBufferGeometry');
});

test('leaf 材质: 正常混合（不发光）、双面、不写深度、不吃雾、不投影', () => {
  const { material: m } = createLeafMaterial({});
  assertEqual(m.blending, THREE.NormalBlending);
  assertEqual(m.side, THREE.DoubleSide);
  assertEqual(m.depthWrite, false);
  assertEqual(m.depthTest, true);
  assertEqual(m.fog, false);
  assertEqual(m.castShadow, false);
});

test('leaf TSL: 顶点有 rotate 与落地钳制，且 tEff 取 min（落地后冻结）', () => {
  const { material: m } = createLeafMaterial({});
  const v = nodeCode(m.vertexNode);
  assertTrue(v.includes('rotate('), '缺自转 ⇒ 读作纸片平移');
  assertTrue(/\.min\(|min\(/.test(v), '缺 tEff=min ⇒ 落地后仍打转');
  assertTrue(/max\(/.test(v), '缺 y 钳制 ⇒ 穿地');
});

test('leaf TSL: 昼夜 uniform 是外部实例（不是自己 new 的）', () => {
  const skyDim = { value: 1 }; const shadowStrength = { value: 1 };
  const made = createLeafMaterial({ skyDim, shadowStrength });
  // 材质须持有传入的同一对象引用（红线 1：日夜变了落叶要跟着变）
  assertTrue(made.uniforms.uSkyDim === skyDim, 'uSkyDim 必须是传入实例');
  assertTrue(made.uniforms.uShadowStrength === shadowStrength, 'uShadowStrength 同理');
});
```

⚠️ 最后一条要求 `createLeafMaterial` 的返回 `uniforms` **包含** `uSkyDim` / `uShadowStrength` 两个键（缺省时是内部常量 uniform）—— Interfaces 已按此写明。

- [ ] **Step 2: 跑测试确认 RED**

Run: `node tools/run-unit-node.mjs --only=test-ambient-fx.js`
Expected: FAIL —— `Cannot find module .../leaf-fx-material.js`。

- [ ] **Step 3: 实现几何工厂**

`createLeafGeometry(capacity)`：照 `createSpikeSparkGeometry` 的结构（quad 顶点 `[-0.5,-0.5,0, 0.5,-0.5,0, 0.5,0.5,0, -0.5,0.5,0]`、索引 `[0,1,2,0,2,3]`），八个属性按 `LEAF_ATTR` 的 itemSize 建（vec3→3、vec2→2、float→1），全部 `DynamicDrawUsage`。初始 `aBorn = -1e3`、`aAlpha = 0`（全部不可见）。`instanceCount = capacity`，`boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)`。

- [ ] **Step 4: 实现 TSL 材质**

顶点（`vertexNode`，`Fn` 体），**顺序是载荷性的**：
1. 读八个属性，`t = uTime − aBorn`；`tLand = (aOrigin.y − aParams.x) / aParams.y`；`tEff = min(t, tLand)`。
2. 按 Task 1 Step 11 的公式算世界中心 `pos`（y 用 `max(...)` 钳到 `aParams.x`）与 `rot = vec3(spinX,spinY,spinZ).mul(tEff)`。
3. **屏幕尺寸硬钳先算**：`centerView = modelViewMatrix.mul(vec4(pos,1))`；`depth = max(centerView.z.negate(), float(0.05))`；`s = min(aSize, depth.mul(float(LEAF_FX.maxScreen).mul(1.4)))`。
4. **再旋转**：`local = rotate(positionGeometry.mul(s), rot)` —— 这是**世界轴向**的局部偏移（薄片自己翻飞，**不做 billboard**）。
5. `vShade = mix(float(sideShade), float(1), abs(cos(rot.x)))`；`vColor` / `vAlpha` 经 `varyingProperty` 传片元。
6. 返回 `cameraProjectionMatrix.mul(modelMatrix 无关的 vec4(pos,1).add(vec4(local,0)))`。
   ⚠️ **不得把 `local` 再加进 `centerView`**：`centerView` 已经过视图旋转，世界偏移加进去会随镜头转歪。
   正确写法：`cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(pos.add(local), 1)))`（先在世界空间相加，再一次性进视图）。
   ⇒ 第 3 步的 `centerView` **只用于算 depth**，不参与最终位置。

片元（`colorNode`）：`col = vColor × mix(1.0, uSkyDim, uShadowStrength) × vShade`，`alpha = vAlpha`；`Discard(alpha.lessThanEqual(0.004))`。`vShade` 由顶点算 `mix(sideShade, 1.0, abs(cos(rotX)))`。

设置：`transparent=true`、`NormalBlending`、`depthWrite=false`、`depthTest=true`、`side=DoubleSide`、`fog=false`、`lights=false`。

⚠️ uniform 闭包捕获；⚠️ 常量色拆分量（本材质的色来自属性，无 hex 常量，但 `sideShade` 等标量一律 `float()`）；⚠️ 禁裸数字算术。

- [ ] **Step 5: 跑测试确认 GREEN**

Run: `node tools/run-unit-node.mjs --only=test-ambient-fx.js`
Expected: PASS（15 例）。

- [ ] **Step 6: 负向验证（TSL 结构判据真的有判别力）**

用 `edit` 临时把 `rotate(` 改成不转（直接返回 `positionGeometry.mul(s)`），跑 Step 5 的命令确认「顶点有 rotate」那条 **FAIL**，再用 `edit` 改回。
⚠️ **禁用 `git checkout` 还原**（文件未提交，会丢改动）—— 用 `edit` 精确改回，或先 `cp` 一份副本再 `cp` 回来。

- [ ] **Step 7: 补 Review Focus #4 的测试（昼夜真的乘进颜色）**

追加一例：读 `nodeCode(m.colorNode)`，断言它**同时**引用 `uSkyDim` 与 `uShadowStrength`（去注释后按标识符匹配）。这条抓「只传句柄没接进 colorNode」。
Run: `node tools/run-unit-node.mjs --only=test-ambient-fx.js` → PASS（16 例）。

- [ ] **Step 8: 提交（须先得到用户明确指令）**

```bash
git add src/render/leaf-fx-material.js src/tests/test-ambient-fx.js src/render/ambient-fx-config.js
git commit -m "feat(render): 落叶 TSL 材质与实例几何"
```

---

### Task 3: 落叶池（门控 / 迁移 / 回收 / 取色）

**Files:**
- Create: `src/render/leaf-fx.js`
- Modify: `src/tests/test-ambient-fx.js`

**Interfaces:**
- Consumes: Task 1 全部导出；Task 2 的 `LEAF_ATTR` / `createLeafGeometry` / `createLeafMaterial`；`getBiome` from `../gen/noise.js`。
- Produces: `class LeafFxRenderer`
  - `constructor({ scene, world, seed, colorResolver, playerPos, capacity?, rand?, skyDim?, shadowStrength? })`
  - `mesh`（`THREE.Mesh`，`name='ambient:leaf'`）、`meshes = [mesh]`（供倒影 hidden 展开）
  - `setEnabled(on)` → `boolean`（实际生效值）
  - `update(playerPos, dt)`（`dt` 秒；内部累计绝对秒喂 `uTime`）
  - `get activeCount()`、`get visible()`、`debugState()` → `{ enabled, biome, visible, count, refreshCursor, isRefreshing, time }`
  - `dispose()`

- [ ] **Step 1: 写失败测试（池化 + 门控零成本）**

追加（用真 `THREE.Scene` + fake world）：

```js
import { LeafFxRenderer } from '../render/leaf-fx.js';
import { getBiome } from '../gen/noise.js';

/** fake world：只实现 isSolid，并计数（零成本判据要落在「有没有查体素」上） */
function fakeWorld(groundY = 8) {
  const w = { calls: 0, isSolid(x, y, z) { w.calls++; return y <= groundY; } };
  return w;
}
/** 固定色 resolver（避免单测依赖 canvas） */
const fakeResolver = () => [0.2, 0.23, 0.01];

function makeLeaf(overrides = {}) {
  return new LeafFxRenderer({
    scene: new THREE.Scene(), world: fakeWorld(), seed: 12345,
    colorResolver: fakeResolver, playerPos: { x: -400, y: 9, z: -400 },
    capacity: 32, rand: makeRand(9), ...overrides,
  });
}

test('leaf 池: 构造后不可见（未 update 过 ⇒ 不提交渲染）', () => {
  const r = makeLeaf();
  assertEqual(r.mesh.visible, false);
  assertEqual(r.mesh.name, 'ambient:leaf');
  assertEqual(r.mesh.renderOrder, LEAF_FX.renderOrder);
  assertEqual(r.mesh.frustumCulled, false);
  assertEqual(r.meshes.length, 1);
  r.dispose();
});

test('leaf 池: 森林机位 update 后可见；沙漠机位不可见且零 isSolid 调用', () => {
  const forest = makeLeaf();
  forest.update({ x: -400, y: 9, z: -400 }, 0.016);
  assertEqual(forest.mesh.visible, true);
  assertTrue(forest.debugState().biome === 'FOREST', '机位须真是 FOREST');
  forest.dispose();

  const desertWorld = fakeWorld();
  const desert = makeLeaf({ world: desertWorld, playerPos: { x: 8, y: 5, z: 8 } });
  for (let i = 0; i < 60; i++) desert.update({ x: 8, y: 5, z: 8 }, 0.016);
  assertEqual(desert.mesh.visible, false);
  assertEqual(desertWorld.calls, 0, '非目标 biome 不得查体素（零成本）');
  desert.dispose();
});

test('leaf 池: 关闭态 uTime 仍推进（回到森林时 age 不跳变）', () => {
  const r = makeLeaf();
  r.setEnabled(false);
  for (let i = 0; i < 30; i++) r.update({ x: -400, y: 9, z: -400 }, 0.1);
  const t1 = r.debugState().time;
  assertTrue(t1 > 2.5, `关闭态时间须累计，实得 ${t1}`);
  assertEqual(r.mesh.visible, false);
  r.setEnabled(true);
  r.update({ x: -400, y: 9, z: -400 }, 0.016);
  assertTrue(r.debugState().time > t1, '重开后时间继续');
  r.dispose();
});
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `node tools/run-unit-node.mjs --only=test-ambient-fx.js`
Expected: FAIL —— `Cannot find module .../leaf-fx.js`。

- [ ] **Step 3: 实现构造与 `setEnabled` / `dispose`**

构造：建几何与材质（`capacity` 缺省 `LEAF_FX.capacity`）、`mesh.name='ambient:leaf'`、`renderOrder`、`frustumCulled=false`、`visible=false`、`castShadow/receiveShadow=false`、`scene.add`。用 `colorResolver(name, [0,1,0])` 按 `pickAutumnLeaf(rand())` 逐实例填 `aColor`（**只在构造与迁移时写色**，不每帧写）。`_time=0`、`_enabled=true`、`_biome=null`、`_biomeAcc=0`、`_refreshAcc=0`、`_cursor=0`、`_isRefreshing=false`。
`setEnabled(on)`：写 `_enabled`，`false` 时立即 `mesh.visible=false`；返回 `_enabled`。
`dispose()`：`scene.remove` + 几何/材质 dispose + `meshes.length=0`。

- [ ] **Step 4: 实现 `update` 的门控与时间**

顺序（照 spec §4.3）：`dt` 非法直接 return → `_time += dt`、`uniforms.uTime.value = _time` → `_biomeAcc += dt`，到期（`biomeInterval`）时算 `getBiome(floor(px), floor(pz), seed)` → `want = biome==='FOREST' && _enabled` → 不 want 则 `mesh.visible=false` 并 **return**（不查体素、不迁移）→ want 则继续迁移与回收，`mesh.visible=true`。

- [ ] **Step 5: 跑测试确认 GREEN**

Run: `node tools/run-unit-node.mjs --only=test-ambient-fx.js`
Expected: PASS（19 例）。

- [ ] **Step 6: 写失败测试（出生带 / 落地 / 分批迁移）**

追加：

```js
test('leaf 池: 每片叶的出生高度都在该列地面 +[3,13]（用户点名的硬约束）', () => {
  const r = makeLeaf({ capacity: 64 });
  r.update({ x: -400, y: 9, z: -400 }, 0.016);
  const o = r.mesh.geometry.getAttribute(LEAF_ATTR.origin);
  const p = r.mesh.geometry.getAttribute(LEAF_ATTR.params);
  let checked = 0;
  for (let i = 0; i < o.count; i++) {
    const groundY = p.getY(i) - LEAF_FX.floorOffset;   // minY 反解地面
    const above = o.getY(i) - groundY;
    assertTrue(above >= LEAF_FX.birthMin - 1e-6 && above <= LEAF_FX.birthMax + 1e-6,
      `第 ${i} 片离地 ${above}`);
    checked++;
  }
  assertTrue(checked >= 64, '须真的检查了全部实例');
  r.dispose();
});

test('leaf 池: 落地后 aAlpha 递减到 0 并重新出生（不堆积、不穿地）', () => {
  const r = makeLeaf({ capacity: 16 });
  const pos = { x: -400, y: 9, z: -400 };
  r.update(pos, 0.016);
  const alpha = r.mesh.geometry.getAttribute(LEAF_ATTR.alpha);
  const born = r.mesh.geometry.getAttribute(LEAF_ATTR.born);
  const born0 = born.getX(0);
  // 大步长推进到超过最慢叶的落地时刻（13/0.55 ≈ 23.6s）+ 淡出
  for (let i = 0; i < 300; i++) r.update(pos, 0.1);
  assertTrue(born.getX(0) > born0, '第 0 片须已重新出生（落地淡出后回收）');
  for (let i = 0; i < alpha.count; i++) {
    assertTrue(alpha.getX(i) >= 0 && alpha.getX(i) <= 1, `alpha 越界 ${alpha.getX(i)}`);
  }
  r.dispose();
});

test('leaf 池: 玩家移动超阈值触发分批迁移，每帧不超过批大小', () => {
  const r = makeLeaf({ capacity: 64 });
  r.update({ x: -400, y: 9, z: -400 }, 0.016);
  const o = r.mesh.geometry.getAttribute(LEAF_ATTR.origin);
  const x0 = o.getX(0);
  // 移动 20 格（> refreshDistance 8）；仍在森林内
  const far = { x: -380, y: 9, z: -400 };
  r.update(far, 0.05);   // 跨过 30Hz 与 5Hz 两个节流窗口
  const st = r.debugState();
  assertTrue(st.isRefreshing, '须进入迁移态');
  assertTrue(st.refreshCursor <= LEAF_FX.refreshBatchSize, `单帧迁移 ${st.refreshCursor} 片`);
  // 推进若干帧后全部迁移完，中心跟着玩家
  for (let i = 0; i < 10; i++) r.update(far, 0.05);
  assertEqual(r.debugState().isRefreshing, false);
  assertTrue(Math.abs(o.getX(0) - x0) > 1, '第 0 片的 x 须真的迁移了');
  r.dispose();
});
```

- [ ] **Step 7: 实现迁移与回收（含 Review Focus #3）**

- `_resolveGroundY(x, z, fromY)`：从 `floor(fromY)` 向下扫 `searchDepth` 格，第一个 `world.isSolid` 为真的 `y+1` 即地面；扫不到返回 `null` ⇒ **跳过该片**（不回落到玩家 y 或世界底）。
- `_resetLeaf(i, center)`：`leafSeedAt` → 查地面 → 写八个属性（`aBorn = _time`、`aAlpha = 1`）。
- 迁移：30Hz 检查 `dx²+dz² > refreshDistance²` 或 `|dy| > refreshVertical` ⇒ `_isRefreshing=true`、`_cursor=0`；每帧处理 `refreshBatchSize` 片，**只改 origin/params（地面），不改 sway/spin/size/color**（减少上传）；完成后 `_isRefreshing=false`。
- 回收：每帧逐片算 `t = _time − aBorn`，`landed && t > tLand + landFadeSeconds` ⇒ `_resetLeaf`；否则写 `aAlpha`（落地后递减）。
- ⚠️ 每帧零分配：`leafMotionAt` 传模块级 `out`；属性写入用 `setXYZ/setX`，不建数组。
- ⚠️ `needsUpdate` 只置真的改过的属性。

- [ ] **Step 8: 跑测试确认 GREEN**

Run: `node tools/run-unit-node.mjs --only=test-ambient-fx.js`
Expected: PASS（22 例）。

- [ ] **Step 9: 补 Review Focus #2 的测试（走出再走回不闪断）**

追加一例：森林 → 沙漠（30 帧）→ 回森林，断言 ① 回来那一帧 `mesh.visible===true`；② `aBorn` 的值**没有被清成 -1e3**（缓冲未清空 ⇒ 不闪断）；③ `debugState().time` 单调增。
Run: `node tools/run-unit-node.mjs --only=test-ambient-fx.js` → PASS（23 例）。

- [ ] **Step 10: 写失败测试（NaN 守卫 + resolver 缺失）**

追加：`update(null, 0.016)` / `update({x:NaN,...}, 0.016)` / `update(pos, NaN)` 三种输入后，`aOrigin` 全部仍是有限数、`mesh.visible` 不变、不抛错。
另：`colorResolver: null` 时构造**不抛错**（渲染器自己容错；装配层负责不装配 —— 见 Task 6）。

- [ ] **Step 11: 实现 NaN 守卫**

`update` 开头判 `Number.isFinite(dt)` 与 `playerPos` 三分量有限，否则 return。`_resetLeaf` 里判地面为 null 则跳过。`colorResolver` 缺省时用**中性绿**兜底并 `console.warn` 一次（渲染层不崩；装配层仍会跳过装配，两层职责不同）。

- [ ] **Step 12: 跑测试 + 静态门**

Run: `node tools/run-unit-node.mjs --only=test-ambient-fx.js && npm run check`
Expected: PASS（累计 25 例）。

- [ ] **Step 13: 提交（须先得到用户明确指令）**

```bash
git add src/render/leaf-fx.js src/tests/test-ambient-fx.js
git commit -m "feat(render): 落叶池（biome 门控/分批迁移/落地回收）"
```

---

### Task 4: 萤火虫 TSL 材质与几何

**Files:**
- Create: `src/render/firefly-fx-material.js`
- Modify: `src/tests/test-ambient-fx.js`

**Interfaces:**
- Consumes: `FIREFLY_FX`；`THREE` / `three/tsl`。
- Produces:
  - `FIREFLY_ATTR`（冻结）：`{ origin:'aOrigin', amp:'aAmp', freq:'aFreq', phase:'aPhase', drift:'aDrift', size:'aSize', breathe:'aBreathe', born:'aBorn', life:'aLife', alive:'aAlive', ground:'aGround' }`
    - `aOrigin` vec3；`aAmp` vec3；`aFreq` vec3；`aPhase` vec3；`aDrift` vec2 = (driftX, driftZ)；`aSize` float；`aBreathe` vec2 = (freq, phase)；`aBorn` float（绝对秒）；`aLife` float（秒）；`aAlive` float（0/1，夜间密度用）；`aGround` float（该列地面 y，供 y 钳制）
  - `createFireflyGeometry(capacity)` → `THREE.InstancedBufferGeometry`
  - `createFireflyMaterial()` → `{ material, uniforms: { uTime, uGain } }`

- [ ] **Step 1: 写失败测试（几何 + additive + 径向量在片元）**

追加：

```js
import { FIREFLY_ATTR, createFireflyGeometry, createFireflyMaterial } from '../render/firefly-fx-material.js';

test('firefly 几何: 十一个属性齐全、单 quad、初始全部已死', () => {
  const g = createFireflyGeometry(24);
  assertEqual(g.instanceCount, 24);
  for (const name of Object.values(FIREFLY_ATTR)) assertTrue(!!g.getAttribute(name), `缺 ${name}`);
  const born = g.getAttribute(FIREFLY_ATTR.born);
  const life = g.getAttribute(FIREFLY_ATTR.life);
  for (let i = 0; i < 24; i++) { assertTrue(born.getX(i) < -100, '初始须已死'); assertTrue(life.getX(i) < 0.01, '初始寿命极小'); }
  assertTrue(g.boundingSphere.radius >= 1000, '包围球');
});

test('firefly 材质: additive 自发光、不写深度、不吃雾', () => {
  const { material: m } = createFireflyMaterial();
  assertEqual(m.blending, THREE.AdditiveBlending);
  assertEqual(m.depthWrite, false);
  assertEqual(m.fog, false);
  assertEqual(m.side, THREE.DoubleSide);
});

test('firefly TSL: 径向量在片元算（顶点算 length 会整片一起亮）', () => {
  const { material: m } = createFireflyMaterial();
  const v = nodeCode(m.vertexNode);
  const c = nodeCode(m.colorNode);
  assertTrue(/length\(/.test(c), '片元必须算径向距离');
  assertTrue(!/length\(\s*positionGeometry/.test(v), '顶点不得对 quad 局部坐标算 length');
  assertTrue(/pow\(/.test(c), '光晕须有幂衰减（否则是硬边圆盘）');
});

test('firefly TSL: 三轴各自用自己的频率与相位（同频会读作绕圈）', () => {
  const { material: m } = createFireflyMaterial();
  const v = nodeCode(m.vertexNode);
  // 钉表达式结构而不是字面量：三个轴分别取 freq 的 x/y/z 分量
  assertTrue(/freq\.x/.test(v) && /freq\.y/.test(v) && /freq\.z/.test(v), '三轴须各取自己的频率分量');
});
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `node tools/run-unit-node.mjs --only=test-ambient-fx.js`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现几何工厂**

照 Task 2 Step 3 的手法，十一个属性按 itemSize 建；初始 `aBorn=-1e3`、`aLife=1e-3`、`aAlive=0`。

- [ ] **Step 4: 实现 TSL 材质**

顶点：按 Task 1 Step 11 的萤火虫公式算世界 `pos`（y 用 `max(..., aGround + floorClearance)`）；`age = uTime − aBorn`，`k = clamp(age/max(aLife,1e-3), 0, 1)`；`alive = step(0,age) × step(k,0.999) × aAlive`；`breathe = 0.15 + 0.85 × pow(0.5 + 0.5×sin(bf×uTime + bp), 3)`；尺寸 `s = aSize × alive × mix(0.02,1,smoothstep(0,0.06,k)) × mix(1,0.3,smoothstep(0.8,1,k))`。
** billboard 与硬钳（照 `spike-fx-material.js:makeParticlePass` 逐字）**：`centerView = modelViewMatrix.mul(vec4(pos,1))`；`depth = max(centerView.z.negate(), float(0.05))`；`s = min(s, depth.mul(float(FIREFLY_FX.maxScreen).mul(1.4)))`；`corner = positionGeometry.xy.mul(s)`（屏幕对齐）；返回 `cameraProjectionMatrix.mul(vec4(centerView.xyz.add(vec3(corner,0)), 1))`。
⚠️ **萤火虫与落叶的空间口径刻意不同**：萤火虫是屏幕对齐光点（在 centerView 上加 corner 正确）；落叶是世界轴向的翻转薄片（必须在世界空间相加，见 Task 2 Step 4 的 ⚠️）。照拄任一侧到另一侧都会错。
varying 传 `vUv = positionGeometry.xy.mul(2)`、`vBreathe`、`vK`。

片元：`r = length(vUv)`（**片元算**）；`core = oneMinus(smoothstep(0, coreEdge, r))`；`halo = pow(max(oneMinus(r), 1e-4), haloFalloff)`；`mask = max(core, halo.mul(0.55))`；`fade = oneMinus(smoothstep(0.8, 1, vK))`；`a = mask.mul(vBreathe).mul(fade)`；`Discard(a.lessThanEqual(0.004))`；`col = rgb(colorHex).mul(uGain).mul(vBreathe)`（`rgb()` 显式拆分量）；返回 `vec4(col, a)`。

设置：`transparent=true`、`AdditiveBlending`、`depthWrite=false`、`depthTest=true`、`side=DoubleSide`、`fog=false`、`lights=false`。uniform 闭包捕获。

- [ ] **Step 5: 跑测试确认 GREEN**

Run: `node tools/run-unit-node.mjs --only=test-ambient-fx.js`
Expected: PASS（29 例）。

- [ ] **Step 6: 负向验证（径向判据有判别力）**

用 `edit` 把片元的 `length(vUv)` 挪到顶点（写成 varying 传进来），跑 Step 5 确认「径向量在片元算」那条 **FAIL**，再 `edit` 改回。禁 `git checkout`。

- [ ] **Step 7: 提交（须先得到用户明确指令）**

```bash
git add src/render/firefly-fx-material.js src/tests/test-ambient-fx.js
git commit -m "feat(render): 萤火虫 TSL 材质与实例几何"
```

---

### Task 5: 萤火虫池（门控 / 迁移 / 夜间联动）

**Files:**
- Create: `src/render/firefly-fx.js`
- Modify: `src/tests/test-ambient-fx.js`

**Interfaces:**
- Consumes: Task 1 导出；Task 4 的 `FIREFLY_ATTR` / `createFireflyGeometry` / `createFireflyMaterial`；`getBiome`。
- Produces: `class FireflyFxRenderer`
  - `constructor({ scene, world, seed, playerPos, capacity?, rand? })`
  - `mesh`（`name='ambient:firefly'`）、`meshes = [mesh]`
  - `setEnabled(on)` → `boolean`
  - `update(playerPos, dt, nightBlend)`（`nightBlend` 缺省 0）
  - `debugState()` → `{ enabled, biome, visible, count, gain, time, isRefreshing }`
  - `dispose()`

- [ ] **Step 1: 写失败测试（门控 + 夜间联动）**

追加：

```js
import { FireflyFxRenderer } from '../render/firefly-fx.js';

function makeFly(overrides = {}) {
  return new FireflyFxRenderer({
    scene: new THREE.Scene(), world: fakeWorld(6), seed: 12345,
    playerPos: { x: -350, y: 6, z: -150 }, capacity: 24, rand: makeRand(13), ...overrides,
  });
}

test('firefly 池: 草地机位可见、沙漠机位不可见且零 isSolid', () => {
  const plains = makeFly();
  plains.update({ x: -350, y: 6, z: -150 }, 0.016, 0);
  assertEqual(plains.debugState().biome, 'PLAINS');
  assertEqual(plains.mesh.visible, true);
  plains.dispose();
  const w = fakeWorld();
  const desert = makeFly({ world: w, playerPos: { x: 8, y: 5, z: 8 } });
  for (let i = 0; i < 60; i++) desert.update({ x: 8, y: 5, z: 8 }, 0.016, 0);
  assertEqual(desert.mesh.visible, false);
  assertEqual(w.calls, 0);
  desert.dispose();
});

test('firefly 池: 夜里 gain 与 count 都抬升，且 aAlive 前 count 个为 1', () => {
  const r = makeFly({ capacity: FIREFLY_FX.capacity });
  const pos = { x: -350, y: 6, z: -150 };
  r.update(pos, 0.016, 0);
  const day = r.debugState();
  r.update(pos, 0.016, 1);
  const night = r.debugState();
  assertTrue(night.gain > day.gain, '夜里更亮');
  assertTrue(night.count > day.count, '夜里更密');
  const alive = r.mesh.geometry.getAttribute(FIREFLY_ATTR.alive);
  let ones = 0;
  for (let i = 0; i < alive.count; i++) if (alive.getX(i) === 1) ones++;
  assertEqual(ones, night.count);
  // 前 count 个必须是 1（不是随便散布 —— 否则密度判据与实际渲染不符）
  for (let i = 0; i < night.count; i++) assertEqual(alive.getX(i), 1);
  r.dispose();
});

test('firefly 池: 出生高度在该列地面 +[0.4,2.6]，且 aGround 记的是真实地面', () => {
  const r = makeFly({ capacity: 24 });
  r.update({ x: -350, y: 6, z: -150 }, 0.016, 0.5);
  const o = r.mesh.geometry.getAttribute(FIREFLY_ATTR.origin);
  const gr = r.mesh.geometry.getAttribute(FIREFLY_ATTR.ground);
  for (let i = 0; i < o.count; i++) {
    const above = o.getY(i) - gr.getX(i);
    assertTrue(above >= FIREFLY_FX.heightMin - 1e-6 && above <= FIREFLY_FX.heightMax + 1e-6,
      `第 ${i} 只离地 ${above}`);
    assertEqual(gr.getX(i), 7);   // fakeWorld(6) ⇒ 地面顶面 = 6+1
  }
  r.dispose();
});
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `node tools/run-unit-node.mjs --only=test-ambient-fx.js`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现构造 / setEnabled / dispose / 门控**

照 Task 3 Step 3~4 的结构，`want = biome==='PLAINS' && _enabled`。`mesh.name='ambient:firefly'`。

- [ ] **Step 4: 实现夜间联动与出生**

`update(pos, dt, nb)`：门控通过后 `fireflyNightAt(nb)` → 写 `uniforms.uGain.value = gain`；`count` 与上帧不同时才重写 `aAlive`（前 count 个 1、其余 0）并置 `needsUpdate`。
出生：`fireflySeedAt` + `_resolveGroundY` → 写十一个属性（`aBorn=_time`、`aGround=groundY`）。寿命到期（`_time − aBorn > aLife`）⇒ 重新出生。

- [ ] **Step 5: 跑测试确认 GREEN**

Run: `node tools/run-unit-node.mjs --only=test-ambient-fx.js`
Expected: PASS（32 例）。

- [ ] **Step 6: 写失败测试（迁移 + NaN 守卫）**

追加：草地内移动 20 格触发分批迁移（每帧 ≤ `refreshBatchSize`）；`update(null,…)` / `dt=NaN` / `nb=NaN` 三种非法输入不污染缓冲（`nb` 非法时按 0 处理）。

- [ ] **Step 7: 实现迁移 + 守卫，并补 Review Focus #2 的萤火虫侧测试**

迁移逻辑照 Task 3 Step 7（只改 origin / ground，不改 amp/freq/phase/size）。
追加一例：草地 → 沙漠（30 帧）→ 回草地，断言 `visible` 恢复、`aBorn` 未被清成 -1e3、`time` 单调增。

- [ ] **Step 8: 跑测试 + 静态门**

Run: `node tools/run-unit-node.mjs --only=test-ambient-fx.js && npm run check`
Expected: PASS（累计 35 例）。

- [ ] **Step 9: 提交（须先得到用户明确指令）**

```bash
git add src/render/firefly-fx.js src/tests/test-ambient-fx.js
git commit -m "feat(render): 萤火虫池（biome 门控/夜间亮度与密度联动）"
```

---

### Task 6: 装配层接线（game.js / main.js）

**Files:**
- Modify: `src/core/game.js`（import 段；`start()` 内 `this.blockHitFx = new BlockHitFxRenderer(...)` :975 之后；帧循环 `if (this.weather.isRaining) this.rain.update(...)` :1451 之后；`_renderWaterReflection` 的 `if (this.spikeFx) hidden.push(...)` :1846 之后；`setPixelRatioMode` :1692；`_rebuildRain` :1707 之后；`dispose()` 的 `this.fireRing?.dispose()` :4287 之后；新增 `setAmbientFxEnabled`）
- Modify: `src/main.js`（`const reflect = ...` :276 之后加 `ambient` 解析；`new Game({...})` 传参）
- Modify: `src/ui/settings.js`（`DEFAULT_SETTINGS` 加 `ambientFx: true`；`resolveSettings` 加存储与 `?ambient=` 读取；**删掉 :153 那行「从存储读 fogColor」**）
- Modify: `src/tests/test-ambient-fx.js`

**Interfaces:**
- Consumes: Task 3 / Task 5 的两个渲染器；既有 `blockColorResolver`（`game.js:967`）、`renderWorld.materials.dayNight.uSkyDim` / `.uShadowStrength`、`nightBlendOf`、`normPixelRatioMode`。
- Produces:
  - `Game#leafFx` / `Game#fireflyFx`（可能为 null）
  - `Game#setAmbientFxEnabled(enabled)` → `boolean`（实际生效值 = `enabled && this._ambientOption`）
  - `Game#ambientFxEnabled`（getter，两池都可见时为 true？—— **不**：返回意图位 `_ambientWanted && _ambientOption`，与 `fogColorEnabled` 读 uniform 的口径不同，注释说明理由：特效可见性还受 biome 门控，不能当开关状态）
  - `Game#_rebuildAmbientFx(mode)`
  - `Game` 构造选项 `ambient`（默认 true）

- [ ] **Step 1: 写失败测试（设置三道入口 + AND 语义）**

在 `src/tests/test-ambient-fx.js` 追加（`test-ui.js` 需 DOM，本文件在 Node 白名单里，故设置类断言放这里）：

```js
import { DEFAULT_SETTINGS, resolveSettings } from '../ui/settings.js';

test('ambient 设置: 默认开；存储与 ?ambient= 均可覆盖；旧存档缺字段自然回落', () => {
  assertEqual(DEFAULT_SETTINGS.ambientFx, true);
  assertEqual(resolveSettings(null, new URLSearchParams('')).ambientFx, true);
  assertEqual(resolveSettings({ viewDistance: 4 }, new URLSearchParams('')).ambientFx, true);
  const v = DEFAULT_SETTINGS.settingsVersion;
  assertEqual(resolveSettings({ settingsVersion: v, ambientFx: false }, new URLSearchParams('')).ambientFx, false);
  assertEqual(resolveSettings({ settingsVersion: v, ambientFx: false }, new URLSearchParams('ambient=1')).ambientFx, true);
  assertEqual(resolveSettings({ settingsVersion: v, ambientFx: true }, new URLSearchParams('ambient=0')).ambientFx, false);
  assertEqual(resolveSettings({ settingsVersion: v, ambientFx: 'yes' }, new URLSearchParams('')).ambientFx, true);
});

test('雾色恒开: 存储里的 false 不再被采信，但 ?fog=0 仍是隔离入口', () => {
  const v = DEFAULT_SETTINGS.settingsVersion;
  assertEqual(resolveSettings({ settingsVersion: v, fogColor: false }, new URLSearchParams('')).fogColor, true,
    '玩家侧已无雾色开关 ⇒ 存储值不可信');
  assertEqual(resolveSettings({ settingsVersion: v, fogColor: false }, new URLSearchParams('fog=0')).fogColor, false,
    '?fog=0 必须仍能关（Tier 4 隔离入口）');
  assertEqual(resolveSettings(null, new URLSearchParams('fog=0')).fogColor, false);
});
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `node tools/run-unit-node.mjs --only=test-ambient-fx.js`
Expected: FAIL —— `ambientFx` 为 undefined；雾色那条读到 false。

- [ ] **Step 3: 改 `settings.js`（定点 edit）**

三处：① `DEFAULT_SETTINGS` 加 `ambientFx: true`（附注释：旧存档无此字段 ⇒ 不需要 `settingsVersion` 迁移，同 `pixelRatio`）；② `resolveSettings` 的存储段加 `if (typeof stored.ambientFx === 'boolean') s.ambientFx = stored.ambientFx;`，**删掉** `if (typeof stored.fogColor === 'boolean') s.fogColor = stored.fogColor;` 那一行并在原位留注释说明「玩家侧已无入口，存储值不可信」；③ URL 段加 `if (params.has('ambient')) s.ambientFx = params.get('ambient') === '1';`。
⚠️ `?fog=` 的 URL 分支与 `migrateStored` **一个字节不动**。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `node tools/run-unit-node.mjs --only=test-ambient-fx.js`
Expected: PASS（37 例）。

- [ ] **Step 5: 接线 `game.js`（含 Review Focus #4 的 uniform 注入）**

按 Files 的七个位置定点 edit：
- import 两个渲染器 + `nightBlendOf`；
- `start()` 里 `blockHitFx` 之后构造两个池（落叶只在 `blockColorResolver` 非 null 时装配，否则置 null；萤火虫恒装配），注入 `world / seed / playerPos: this.player.physics.pos / capacity: ambientParticleCount(this.settings.pixelRatio, kind) / skyDim / shadowStrength`；构造后调 `this.setAmbientFxEnabled(this.settings.ambientFx)`；
- 帧循环 `rain.update` 之后：`const nb = nightBlendOf(this.dayNight.params); this.leafFx?.update(pp, dt); this.fireflyFx?.update(pp, dt, nb);`
- `_renderWaterReflection`：两池的 `meshes` 进 `hidden`；
- `setPixelRatioMode`：`this._rebuildAmbientFx(m)`；
- `_rebuildAmbientFx(mode)`：dispose 两池 → 用新容量重建 → **重新调 `setAmbientFxEnabled(this._ambientWanted)`**（Review Focus #1）；
- `setAmbientFxEnabled(v)`：`_ambientWanted = !!v`，`eff = _ambientWanted && this._ambientOption`，两池 `setEnabled(eff)`，返回 `eff`；
- `dispose()`：两池 `?.dispose()`。
- 构造器：`this._ambientOption = ambient`（新构造参数，默认 true）、`this._ambientWanted = true`。

- [ ] **Step 6: 接线 `main.js`**

`const ambient = params.get('ambient') !== '0';`（与 `?reflect=0` 同口径，注释说明它是 Tier 4 隔离入口、不持久化），传进 `new Game({ ..., ambient })`。
⚠️ **`?ambient=` 在 `resolveSettings` 里也认**（Step 3 已加）—— 两者分工：设置项是玩家意图（持久化），构造选项是代码级隔离（不持久化），生效值取 AND。这与 `?fog=` 只走设置、`?reflect=` 只走构造选项都不同，**必须在注释里写清为什么本轮两条都要**（面板开关要持久化 + spec §3.4 要求 spec 能不改存档就隔离）。

- [ ] **Step 7: 补 Review Focus #1 的测试（切档后不消失）**

追加一例：直接构造两个渲染器（不经 Game，Node 无 DOM），模拟 `_rebuildAmbientFx` 的顺序 —— dispose → 用 `capacityPerformance` 重建 → `setEnabled(true)` → `update(森林/草地机位)`，断言 `mesh.visible===true` 且 `geometry.instanceCount === capacityPerformance`。
Run: `node tools/run-unit-node.mjs --only=test-ambient-fx.js` → PASS（38 例）。

- [ ] **Step 8: 静态门 + 浏览器轻档**

Run: `npm run check && npx playwright test tests/unit-fast.spec.mjs`
Expected: 三门全绿；浏览器轻档全绿（`test-ui.js` 的 fogColor 用例此时会红 —— 那是 Task 7 要改写的，**本 Step 只记录哪几条红，不改断言**）。

- [ ] **Step 9: 补 Review Focus #5 的测试（AND 语义）**

追加一例：用 fake scene 构造两池，模拟 `setAmbientFxEnabled` 的合成逻辑（`wanted && option` 四种组合），断言只有两者都 true 时 `update` 后 `visible===true`。
Run: `node tools/run-unit-node.mjs --only=test-ambient-fx.js` → PASS（39 例）。

- [ ] **Step 10: 提交（须先得到用户明确指令）**

```bash
git add src/core/game.js src/main.js src/ui/settings.js src/tests/test-ambient-fx.js
git commit -m "feat(core): 装配落叶与萤火虫池（含 ?ambient=0 隔离入口）"
```

---

### Task 7: 面板开关替换雾色 + 既有测试处置

**Files:**
- Modify: `src/ui/settings-panel.js`（`_rowFogColor` :691 → `_rowAmbientFx`；`_combinedFogMusic` :742 → `_combinedAmbientMusic`；调用点 :440；新增两个导出常量）
- Modify: `src/tests/test-ui.js`（fogColor 三条按新语义改写 + 追加新开关用例）
- Modify: `tests/fog-color.spec.mjs`（两条面板用例改写，前四条像素用例一字不动）

**Interfaces:**
- Consumes: `game.setAmbientFxEnabled`（Task 6）、`settings.ambientFx`（Task 6）。
- Produces: `AMBIENT_ROW_TITLE = '萤火虫和落叶'`、`AMBIENT_LABELS = ['关闭', '开启']`（导出，供单测钉死）。

- [ ] **Step 1: 写失败测试（面板常量 + 设置语义）**

在 `src/tests/test-ui.js` 的 import 里加 `AMBIENT_ROW_TITLE, AMBIENT_LABELS`，追加：

```js
test('环境特效行：标题与两个按钮文案是导出的单一口径常量', () => {
  assertEqual(AMBIENT_ROW_TITLE, '萤火虫和落叶');
  assertEqual(AMBIENT_LABELS.length, 2);
  assertEqual(AMBIENT_LABELS[0], '关闭');
  assertEqual(AMBIENT_LABELS[1], '开启');
  // 与既有组标题不得撞名（面板按标题定位按钮组）
  assertFalse(AMBIENT_ROW_TITLE === RESOLUTION_ROW_TITLE, '不得与分辨率行撞名');
});
```

同时把既有「settings: fogColor 默认开，存储与 ?fog= 均可覆盖」那条里的**存储断言**改成「存储值不再被采信 ⇒ 恒开」（`resolveSettings({settingsVersion:v, fogColor:false}, '') === true`），`?fog=` 两个方向的断言保留；「旧存档迁移」那条**一字不动**（`migrateStored` 未改）。

- [ ] **Step 2: 跑测试确认 RED**

Run: `npx playwright test tests/unit-fast.spec.mjs`
Expected: FAIL —— `AMBIENT_ROW_TITLE` 未导出（import 报错）+ fogColor 存储那条读到 false。

- [ ] **Step 3: 改面板（定点 edit，四处）**

① 新增两个导出常量（放在 `RESOLUTION_LABELS` 之后，附注释说明它是「氛围」组、与背景音乐同盒）；
② `_rowFogColor` 整体改名为 `_rowAmbientFx`，标题用 `AMBIENT_ROW_TITLE`、文案用 `AMBIENT_LABELS`、值 `[false, true]`、当前值 `this.settings.ambientFx`、回调写 `settings.ambientFx` + `this._save()` + `this.game.setAmbientFxEnabled(v)`；**删掉 `if (!this.game.sky)` 的置灰块**（新开关无异步前置条件）；
③ `_combinedFogMusic` 改名 `_combinedAmbientMusic`，内部第一项换成 `this._rowAmbientFx('mc-combined-col')`；
④ 调用点 `left.appendChild(this._combinedFogMusic())` → `_combinedAmbientMusic()`。
⚠️ **不碰 Tab 相关代码**（`_panelAbout` / `mkTab` / `PANEL_CSS` 的 Tab 段都是另一条线的未提交改动）。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `npx playwright test tests/unit-fast.spec.mjs`
Expected: PASS（含新用例与改写后的 fogColor 用例）。

- [ ] **Step 5: 改写 `fog-color.spec.mjs` 的两条面板用例（Review Focus #5 的 E2E 侧）**

- 「启动默认开启雾色」：保留 `settings.fogColor===true` / `mix===1` / `fogColorEnabled===true` / `?fog=0` 四条断言；把「面板高亮」那段改成定位 `AMBIENT_ROW_TITLE` 那一组、断言 `button.active` 文案为「开启」。
- 「面板『雾色』行落在左列…」整条改名为「面板『萤火虫和落叶』行落在左列环境风格下方、与背景音乐同盒」：标题序列断言换成新标题；**删掉**「无天空盒时整组禁用」段；**保留**「环境风格『自动』按钮必须还在」；新增「点『关闭』⇒ `game.ambientFxEnabled===false`，点『开启』⇒ true」两段（这是 Review Focus #5 的真实入口验证）。
- 前四条像素用例（含 `?skybox=0` 那条）**一字不动**。

- [ ] **Step 6: 跑 UI 档与像素档**

Run: `npm run test:ui && npx playwright test tests/fog-color.spec.mjs`
Expected: 全绿。⚠️ `teleport.spec` / `settings-resolution.spec` / `about-tab.spec` 的「面板不得出现滚动条」断言必须仍绿 —— 若红，**停下报告**（说明换组改变了高度），不擅自改阈值。

- [ ] **Step 7: 量标题行盒数（布局载荷）**

在 `tests/fog-color.spec.mjs` 新增的那条里加：用 `Range.getClientRects()` 数新标题与两个按钮文案的**行盒数**，断言恒为 1（`scrollWidth<=clientWidth` 对折行无判别力）。
Run: `npx playwright test tests/fog-color.spec.mjs` → PASS。

- [ ] **Step 8: 提交（须先得到用户明确指令）**

```bash
git add src/ui/settings-panel.js src/tests/test-ui.js tests/fog-color.spec.mjs
git commit -m "feat(ui): 面板雾色组换成萤火虫与落叶开关（雾色恒开）"
```

⚠️ 这三个文件里 `settings-panel.js` 当前含并发会话的 `ABOUT_PARAGRAPH` 文案改动 ⇒ **必须 `git add -p` 逐 hunk 选**，提交前 `git diff --cached` 核对没有 `ABOUT_*` / Tab 相关 hunk。`test-ui.js` 与 `fog-color.spec.mjs` 当前干净。

---

### Task 8: 既有 spec 的隔离入口（4 个文件，只改 URL）

**Files:**
- Modify: `tests/water-visual.spec.mjs`（三条用例的 `page.goto` URL 加 `&ambient=0`）
- Modify: `tests/water-reflect.spec.mjs`（`openGame` 的 URL）
- Modify: `tests/jungle-fortress.spec.mjs`（两条像素用例的 URL）
- Modify: `tests/ignis-fx.spec.mjs`（**只改 offset 900 那条**的 URL）

**Interfaces:**
- Consumes: `?ambient=0`（Task 6）。
- Produces: 无新接口。

- [ ] **Step 1: 先跑一遍确认哪些真的红了（不凭推理改）**

Run: `npx playwright test tests/water-visual.spec.mjs tests/water-reflect.spec.mjs`
Expected: 至少 `water-visual` 的「噪声底必须为零」与 `water-reflect` 的「关闭态两张必须逐像素相同」变红（spec §3.4 预测）。**这一步就是本 Task 的 RED**：把实际失败信息记下来。
⚠️ 若它们反而全绿，说明预测有误（可能是机位飘了或池未装配）⇒ **停下重新核实**，不盲改。

- [ ] **Step 2: 加隔离参数（只改 URL 字符串，断言一字不动）**

四个文件的对应 `page.goto` 加 `&ambient=0`，并在 URL 上方加一行注释：「`?ambient=0` 是观测口径隔离：本 spec 的机位落在 PLAINS/FOREST（spec §3.4 实测），环境特效会引入持续动画 ⇒ 噪声底断言失效。断言与阈值逐字未动。」

- [ ] **Step 3: 跑这四个 spec 确认全绿**

Run: `npx playwright test tests/water-visual.spec.mjs tests/water-reflect.spec.mjs tests/jungle-fortress.spec.mjs tests/ignis-fx.spec.mjs`
Expected: 全绿。⚠️ `jungle-fortress` 单条 500s、`ignis-fx` 四条各 200s ⇒ 用 `run_in_background` 起，不要前台等。

- [ ] **Step 4: 提交（须先得到用户明确指令）**

```bash
git add tests/water-visual.spec.mjs tests/water-reflect.spec.mjs tests/jungle-fortress.spec.mjs tests/ignis-fx.spec.mjs
git commit -m "test: 既有 Tier 4 机位加 ?ambient=0 隔离（断言未动）"
```

---

### Task 9: Tier 4 像素实测（新 spec）

**Files:**
- Create: `tests/ambient-fx.spec.mjs`
- Modify: `tools/test-tiers.mjs`（`PIXEL` 数组追加 `'ambient-fx'`）

**Interfaces:**
- Consumes: `window.__MC_GAME__.leafFx` / `.fireflyFx` / `.setAmbientFxEnabled`；`LEAF_ATTR` / `FIREFLY_ATTR`（经 `await import('/src/render/...')`）；`leafMotionAt` / `fireflyMotionAt`（CPU 复刻）。
- Produces: 无新接口。

- [ ] **Step 1: 写夹具与机位（按 spec §5.2 的实测坐标）**

新建 spec，写：
- `const SEED = 12345`；森林机位 `(-400, -400)`、草地机位 `(-350, -150)`、沙漠对照 `(8, 8)`；
- `gotoSite(page, x, z)`：`g._teleportTo(x, 45, z)` + 等目标 column 就绪 + 等队列收敛（照 `ignis-fx.spec` 的 `gotoOpenField`，**不用 `player.spawn`**）；
- `freezeAll(page)`：钉 `physics.pos`（setInterval 16ms）+ `player.yaw/pitch`、`ocean.update=(cam,dt)=>orig(cam,0)`、藏 `viewArm.mesh` 与 `viewWeapon.node`、`dayNight.update=()=>{}`、`player.viewBob.update=()=>{}`、`player._stepLift.update=()=>{}`、`setShadowsEnabled(false)`、隐藏 `#hud-root > *` 与 `#crosshair`；每项返回布尔，用例里逐条 `expect(...).toBe(true)`（缺一项就红，不静默跳过）；
- URL 一律带 `?seed=12345&vd=6&weather=clear&shadows=0&reflect=0`（`reflect=0` 是 draw call 判据的必需项）。
- ⚠️ **不要求「同状态连拍噪声底=0」**：被测对象自己是动画。对照组用 `setAmbientFxEnabled(false)`，两侧各连拍 3 张取最大值。

- [ ] **Step 2: 写落叶「不高于树」用例（读 GPU 属性，不用像素）**

森林机位 → `freezeAll` → 读 `leafFx.mesh.geometry` 的 `aOrigin` / `aParams`，逐实例断言 `origin.y − (minY − floorOffset) ∈ [birthMin, birthMax]`，且 `checked === capacity`（防空转）。
Run: `npx playwright test tests/ambient-fx.spec.mjs -g "不高于树"`
Expected: PASS。
⚠️ **本条的 RED 已在 Task 1 Step 2 验过**（常量不存在时 import 失败）；这里额外做一次**负向**：把 `birthMax` 临时改成 40（`edit` 改 config）后重跑，确认本条 **FAIL**，再 `edit` 改回。禁 `git checkout`。

- [ ] **Step 3: 写落叶「落地即停」用例（CPU 复刻）**

读 `aOrigin/aParams/aSway/aSpin/aBorn` 重建 seed，用 `leafMotionAt` 算 `tLand`，断言 `tLand+0.05` 与 `tLand+1.2` 两个时刻的 x/z/rot **逐位相同**，且 `alpha` 递减。
Run: `npx playwright test tests/ambient-fx.spec.mjs -g "落地"` → PASS。

- [ ] **Step 4: 写落叶色相像素用例（机位按 spec 的俯视口径）**

`pitch = -0.45`（画面下部全是草地）→ 采样区取画面下 40% → 判据 `Δr ≥ 25 && Δr > Δg + 12 && Δb < 0`；开/关两侧各连拍 3 张，断言「开的下限 > 关的上限」且「开的上限 < 采样区像素数 × 0.25」（防整屏变色的上界）。
Run: `npx playwright test tests/ambient-fx.spec.mjs -g "秋色"` → PASS（先打印两侧实际读数再定阈值）。

- [ ] **Step 5: 写萤火虫色相 + 夜间更亮用例**

草地机位 → 判据 `Δr > 20 && Δg > 20 && Δb < Δr − 15`；同机位 `setVisualStyle('noon')` 与 `('night')` 两侧对照，断言夜间命中像素数 > 白天（并打印两侧读数）。
⚠️ 切风格后必须**重新冻昼夜**（`setVisualStyle` 会 apply 一次，但 `dayNight.update` 已被换空转 ⇒ 不会漂）。
Run: `npx playwright test tests/ambient-fx.spec.mjs -g "萤火虫"` → PASS。

- [ ] **Step 6: 写萤火虫「不是绕圈」用例（CPU 复刻轨迹）**

读属性重建 seed → `fireflyMotionAt` 采 200 个时刻的 (x,z) → 最小二乘拟合圆 → 断言残差 > 阈值（阈值先量「三轴异频」与「三轴同频」两侧的实际残差再取中间）。
Run: `npx playwright test tests/ambient-fx.spec.mjs -g "绕圈"` → PASS。

- [ ] **Step 7: 写 draw call 用例（+1 / 回基线）**

沙漠机位读基线 → 森林机位读（应 +1，萤火虫池 invisible）→ 草地机位读（应 +1，落叶池 invisible）→ 回沙漠读（应回基线，容差 ≤2）。
⚠️ 每次读数前等队列收敛 + `setShadowsEnabled(false)`（VSM 重渲帧会让 drawCalls 尖峰）。
Run: `npx playwright test tests/ambient-fx.spec.mjs -g "draw"` → PASS。

- [ ] **Step 8: 写五条负向对照（`page.route` 换 config 模块）**

对每条判据各写一条负向用例：`page.route('**/ambient-fx-config.js*', ...)` **在 `page.goto` 之前注册**，把模块内容里的
① 秋色权重换成真实比例（`yellow_leaves 0.25` / `leaves 0.60` / 四种巨树各 0.0375）
② `birthMax: 13` → `40`
③ `landFadeSeconds` 改大且去掉 `tEff` 的 min（改 material 模块）
④ 萤火虫三轴频率改成同频
⑤ `gainNight` 改成等于 `gainDay`
逐个确认对应正向判据 **FAIL**。
⚠️ 注入后必须**读回浏览器侧的常量值**确认注入真的生效（`await import` 后打印），否则是「注入没生效的假绿」。

- [ ] **Step 9: 归档 + 跑全 spec**

`tools/test-tiers.mjs` 的 `PIXEL` 追加 `'ambient-fx'`（漏归档会被 `check:data` 抓）。
Run: `npm run check && npx playwright test tests/ambient-fx.spec.mjs`
Expected: 三门全绿 + 新 spec 全部用例 PASS。

- [ ] **Step 10: 提交（须先得到用户明确指令）**

```bash
git add tests/ambient-fx.spec.mjs tools/test-tiers.mjs
git commit -m "test(render): 落叶与萤火虫 Tier 4 像素实测（含五条负向对照）"
```

⚠️ `test-tiers.mjs` 同 Task 1：提交前核对只含本轮那一行，必要时 `git add -p`。

---

### Task 10: 性能门禁与收尾

**Files:**
- Modify: `docs/roadmap.md`（追加本轮版本行：改了什么、实测数据、门禁结果）
- Modify: `docs/superpowers/specs/2026-11-20-forest-leaves-and-fireflies-design.md`（§7 填实测记录）
- Modify: `CLAUDE.md`（若有新的非显然坑，追加到「高频坑」；**改 `CLAUDE.md` 不改 `AGENTS.md`** —— 后者是符号链接）

**Interfaces:**
- Consumes: 前九个 Task 的全部产物。
- Produces: 无代码接口。

- [ ] **Step 1: 跑 bench 回归门（新增 render 热路径文件）**

Run: `npm run bench -- --check`（用 `run_in_background`，约 5min）
Expected: `[bench] --check 通过（无显著回退）`。
⚠️ 冲刺走廊 21.8% 是 PLAINS ⇒ 萤火虫会真的激活，`drawCalls` 是 STRUCTURAL 指标（容差 2%，基线 489 ⇒ 容差 9.8）⇒ +1 在容差内。**若报回退，停下报告实测数字**，不改基线、不放宽阈值。
⚠️ 若误跑了不带 `--check` 的 `npm run bench`：`git checkout docs/m3-baseline.md docs/m3-baseline.json` 恢复（**只这两个文件**，它们本轮无改动）。

- [ ] **Step 2: 跑 core / entity / struct 三档确认零回归**

Run: `npm run test:core`（含 `render-terrain` / `m3-fullscene` / `giant-tree-budget` / `water-order` 等冻结门）
Expected: 全绿。若 `giant-tree-budget` 红，先核实是不是本轮引入（粒子不进 BatchedMesh ⇒ 理论上不影响 reservedV）。

- [ ] **Step 3: 量帧时交替对照（不是单次红绿）**

在森林与草地机位各做 A/B：`setAmbientFxEnabled(true)` 与 `false` **交替各 3 轮**，每轮 `perf.reset()` + 6s 采样，记 `fps` 与 `frameMs.p95`。
判据：两侧分布重叠即通过（既有教训：单侧连跑会让后跑一侧承担更高负载）。把六轮读数写进 spec §7。

- [ ] **Step 4: 填 spec §7 与 roadmap**

spec §7 追加：像素标定表（尺寸/密度/gain 的同机位单变量扫描）、噪声底实测、draw call 实测、bench 结果、帧时交替对照六轮读数。
roadmap 追加版本行（版本号接当前最新，查 roadmap 版本表确认）。
⚠️ **lint warning 数不得称「既有基线」**：跑 `npx eslint <本轮改过的文件>` 单独看有没有新 warning。

- [ ] **Step 5: 若有新坑，写进 CLAUDE.md**

候选（实施期若真的踩到才写）：本轮实测发现的「既有 Tier 4 机位落在目标 biome ⇒ 必须加隔离入口」这一类。
⚠️ `git add CLAUDE.md`（**不是 AGENTS.md**，后者是符号链接，add 它只暂存链接本身）。

- [ ] **Step 6: 自审并报告**

按 `verification-before-completion`：列出**实际跑过的命令与返回值**，未跑的明说。
本轮无新鲜视角 reviewer（用户此前裁定 Native 内联执行）⇒ **报告里必须明说是 self-review，弱于独立 reviewer**。

- [ ] **Step 7: 提交（须先得到用户明确指令）**

```bash
git add docs/roadmap.md docs/superpowers/specs/2026-11-20-forest-leaves-and-fireflies-design.md
git commit -m "docs: 落叶与萤火虫实测记录与路线图"
```

---

## 自审记录

⚠️ **例数一律是累计值**（同一个 `test-ambient-fx.js` 逐 Task 追加）。
若实际例数与括号里的数字不符，**以「全部 PASS」为准**，不为了凑数字增删用例
（policy §3.2：不钉「事实统计」类硬编码计数）。下文数字只是进度参考。

**1. spec 覆盖**：§4.1 落叶 → Task 1/2/3；§4.2 萤火虫 → Task 1/4/5；§4.3 门控 → Task 3 Step 4 / Task 5 Step 3；§4.4 装配 → Task 6；§4.5 面板 → Task 7；§4.6 隔离入口 → Task 6 Step 6 + Task 8；§4.7 五个新文件 → Task 1~5；§5.1 十一类单测 → Task 1/2/3/4/5/6 的测试步骤；§5.2 六类像素判据 + 五条负向 → Task 9；§5.3 门禁 → Task 6 Step 8 / Task 7 Step 6 / Task 8 Step 3 / Task 9 Step 9 / Task 10 Step 1~2。**无遗漏**。

**2. 步骤扫描**：每步只做一件事且有可检查结果。公式体只在 Task 1 Step 11 出现一次（shader 要逐字对应，故必须钉死）；其余代码步骤只给签名与要点。

**3. 类型一致性**：`LEAF_ATTR` / `FIREFLY_ATTR` 的键名在 Task 2/4 定义、Task 3/5/9 消费，逐字一致；`leafSeedAt` 返回的字段名与 `leafMotionAt` 读的字段名一致；`fireflySeedAt` 含 `groundY`（Task 1 Step 11 明确要求，Task 5 写 `aGround` 时用它）；`createLeafMaterial` 的 `uniforms` 在 Task 2 Step 1 扩为三键并在 Interfaces 注明。

**4. Review Focus**：五条各已落到具体 Task 的具体 Step（#1→T6S7、#2→T3S9+T5S7、#3→T3S7、#4→T2S7+T6S5、#5→T7S5+T6S9）。

**5. 篇幅**：计划 1194 行 vs spec 526 行（≈ 2.3×）；代码块占 472 行（**39.5%**）且**全部是测试断言**（那是「唯一合理写法」的载体），生产代码只给签名与一处公式（Task 1 Step 11）。
偏长的原因是 **10 个 Task × 每个 6~13 步的 RED/GREEN/负向/提交四段式**，而不是把程序写进了计划。
两个新渲染器 + 两套 TSL + 面板改造 + 4 个既有 spec 隔离 + 一个新 Tier 4 spec，本身就是十份可独立验收的交付物。**不是程序转录**。