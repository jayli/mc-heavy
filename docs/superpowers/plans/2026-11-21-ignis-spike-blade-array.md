# 焰魔尖刺：剑体 + 五向半圆阵列 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把焰魔尖刺攻击的锥体换成「焰魔宝剑的剑身插进地里、露出 1.6 格」，落点从正前方 5 根扩成五向各 6 根共 30 根的半圆阵列。

**Architecture:** 剑体几何在**运行期**从既有烘焙产物 `assets/ignis/ignis.json` 取剑身+剑尖两盒的 48 个 raw 顶点，做一次轴置换立起来（零重烘、零新增资源）；材质从 v3.24 的「亮度→炭火色阶」TSL 退回 `MeshBasicMaterial + map` 原色直采（剑身 UV 六面实测 100% 不透明）。落点由 `IGNIS_SPIKE.directionsDeg × count` 派生，延迟只跟半径序号挂钩 ⇒ 同半径 5 根同帧破土 = 天然的「先内圈再外圈」。

**Tech Stack:** three r185.1（本地 `vendor/three/`，WebGPU 唯一后端）、`InstancedMesh`、纯函数 + `assert.js` 浏览器内单测（Node 快档可跑）、Playwright Tier 4 像素实测。

**Spec:** `docs/superpowers/specs/2026-11-21-ignis-spike-blade-array-design.md`

## Global Constraints

- 全部解释、说明、注释用中文（项目 AGENTS.md）。
- 时间基准一律 `performance.now()`，禁止 `Date.now()`。
- 资源路径只走 `resourceUrl()`（`src/core/resource-url.js`），禁止站点根绝对路径。
- 依赖方向 `voxel ← gen ← mesh ← render`；`src/render/**` 是主线程专用，可 import three。
- **`src/render/spike-blade-geometry.js` 必须 three-free**（纯数组进出），这样 Tier 1 单测不必初始化 GPU。
- 每帧零分配：临时矩阵/向量用模块级常量。
- 空闲 slot 零 scale，零活跃时 `mesh.visible = false`（draw call 基线）。
- 冻结数字不符时**停下来报告**，不擅自改断言或放宽阈值。
- 提交用 Conventional Commits；**每个 Task 末尾提交一次**，`git add` 只列本 Task 改过的文件。
- 跑浏览器验证前核对端口归属：本 worktree 一律 `MC_PORT=8082`（`npm start` 与 `npx playwright test` 都要带）。

## Review Focus

以下五类是 spec 隐含、但单个 Task 的测试容易漏掉的失效形态，按「用户最可能撞上」排序。每条都在归属 Task 里有对应判据（已在各 Task 的步骤中标注 `RF-n`）。

1. **RF-1 左右镜像**：`directionsDeg` 的正负号写反 ⇒ 整个阵列左右翻转，而根数/间距/延迟/半圆轮廓全部仍正确。判据必须钉「左侧方向 · 模型左向量 > 0.9」，不能只钉「五个方向都在」。（Task 3）
2. **RF-2 剑柄露出**：取盒范围写宽（把护手/柄球取进来）⇒ 玩家蹲下或挖开地面就看到剑柄。判据钉「几何里零个非剑身/剑尖骨骼的顶点」+「立起后 y 最小值 = −1.055625」。（Task 1）
3. **RF-3 剑体多乘一次骨骼链**：产物顶点已是绝对模型坐标（bind 下 skinning 恒等，实测差 8.88e-16），再乘骨骼链会让 `sword_blade` 偏 0.466 格。判据要同时钉「与 raw 顶点的轴置换逐位一致」与「剑尖 bbox 落位」。（Task 1）
4. **RF-4 宽面朝向错**：实例 yaw 少加 π ⇒ 从焰魔/玩家方向看到的是 0.0625 厚的窄边而不是 0.4375 宽面（投影面积差 7.8 倍），而 `DoubleSide` 让正视图几乎一样。判据钉实例矩阵的基向量，Tier 4 另配同机位单变量像素对照。（Task 4 + Task 6）
5. **RF-5 粒子把剑糊掉**：30 根各自按原速率喷 ⇒ 1650 颗火星糊成橙雾盖掉剑形体；而降到每根 9 颗又让「破土猛迸」在单根上读不出（每批恒 1 颗）。判据是既有的「首批 > 末批」+ 池账关系式，两者都不许放宽。（Task 5）

---

### Task 1: 剑体几何纯函数（three-free）

**Files:**
- Create: `src/render/spike-blade-geometry.js`
- Create: `src/tests/test-spike-blade.js`
- Modify: `src/tests/index.html`（注册新测试文件）
- Modify: `tools/test-tiers.mjs`（`UNIT_NODE_SAFE` 加 `test-spike-blade.js`，按字母序插在 `test-spike-fx.js` 之前）

**Interfaces:**
- Consumes: `assets/ignis/ignis.json` 的形状（`{bones:[{name,...}], geometry:{position,normal,uv,skinIndex,index}}`），由调用方 fetch 后传入。
- Produces:
  - `selectBladeBoxes(asset) → {bodyStart:number, tipStart:number}`：两个盒的起始顶点下标（每盒 24 顶点）。
  - `buildSpikeBladeGeometry(asset, exposeHeight) → {position:number[], normal:number[], uv:number[], index:number[], metrics:{vertexCount, triangleCount, length, width, thickness, exposeHeight, buriedDepth, minY, maxY, halfWidth}}`
  - `SPIKE_BLADE_BONES = Object.freeze({body:'sword', tip:'sword_blade'})`

- [ ] **Step 1: 写失败测试**

新建 `src/tests/test-spike-blade.js`。用 `fetch(new URL('../../assets/ignis/ignis.json', import.meta.url))` 加载产物（同 `test-ignis-bake.js` 的 `loadAsset` 手法，Node 快档有 file:// 垫片）。断言辅助从 `./assert.js` import；浮点比较自己定义局部 `assertClose`（`assert.js` 里没有它，AGENTS.md 已记）。

```js
test('spike blade: 选盒规则唯一 —— sword 取 z 跨度最大盒，sword_blade 只有一盒', async () => {
  const a = await loadAsset();
  const { bodyStart, tipStart } = selectBladeBoxes(a);
  // 判据从产物自推导，不硬编码 1248/1272（素材换版下标会漂）
  const names = a.bones.map((b) => b.name);
  assertEqual(names[a.geometry.skinIndex[bodyStart * 4]], 'sword');
  assertEqual(names[a.geometry.skinIndex[tipStart * 4]], 'sword_blade');
  // RF-2：选中的两盒必须都是「剑身/剑尖」，且剑身盒 z 跨度显著大于同骨骼其余盒
  const spans = boxesOfBone(a, 'sword').map((b) => b.zSpan);
  const best = Math.max(...spans);
  assertTrue(best > 2.0, `剑身盒 z 跨度 ${best} 须 > 2 格`);
  assertEqual(spans.filter((s) => Math.abs(s - best) < 1e-9).length, 1, '最大跨度必须唯一');
});

test('spike blade: 48 顶点 / 24 三角，尺寸取原剑（不缩放）', async () => {
  const g = buildSpikeBladeGeometry(await loadAsset(), 1.6);
  assertEqual(g.position.length / 3, 48);
  assertEqual(g.index.length, 72);
  assertEqual(g.metrics.vertexCount, 48);
  assertEqual(g.metrics.triangleCount, 24);
  assertClose(g.metrics.width, 0.4375, 1e-6, '剑面宽 = 原剑尺寸');
  assertClose(g.metrics.thickness, 0.0625, 1e-6, '剑厚 = 原剑尺寸');
  assertClose(g.metrics.length, 2.655625, 1e-6, '剑身总长');
});

test('spike blade: 露出 1.6 格、埋入 1.055625 格，剑尖在上（RF-2）', async () => {
  const g = buildSpikeBladeGeometry(await loadAsset(), 1.6);
  assertClose(g.metrics.maxY, 1.6, 1e-6, '剑尖恰好 1.6 格');
  assertClose(g.metrics.minY, -1.055625, 1e-6, '埋入深度');
  assertClose(g.metrics.buriedDepth, 1.055625, 1e-6);
  assertClose(g.metrics.halfWidth, 0.21875, 1e-6);
  // 轴置换正确性：x 是宽、z 是厚（写反会让剑侧着立）
  assertClose(Math.max(...xOf(g)) - Math.min(...xOf(g)), 0.4375, 1e-6);
  assertClose(Math.max(...zOf(g)) - Math.min(...zOf(g)), 0.0625, 1e-6);
});

test('spike blade: 顶点是 raw 的轴置换，没多乘骨骼链（RF-3）', async () => {
  const a = await loadAsset();
  const g = buildSpikeBladeGeometry(a, 1.6);
  const { bodyStart, tipStart } = selectBladeBoxes(a);
  // 独立复算：直接从 raw 取两盒，按 spec §3.3 的公式算一遍
  const raw = collectRaw(a, [bodyStart, tipStart]);
  const mn = minOf(raw), mx = maxOf(raw);
  const L = mx[2] - mn[2], cy = (mn[1] + mx[1]) / 2, cx = (mn[0] + mx[0]) / 2;
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i];
    assertClose(g.position[i * 3], p[1] - cy, 1e-6, `顶点 ${i} x`);
    assertClose(g.position[i * 3 + 1], (mx[2] - p[2]) - (L - 1.6), 1e-6, `顶点 ${i} y`);
    assertClose(g.position[i * 3 + 2], p[0] - cx, 1e-6, `顶点 ${i} z`);
  }
  // 负向锚点：若实现里乘了骨骼链，sword_blade 那 24 个顶点会偏 0.466 格 ⇒ 上面必红
});

test('spike blade: 法线同轴置换、UV 原样搬', async () => {
  const a = await loadAsset();
  const g = buildSpikeBladeGeometry(a, 1.6);
  const { bodyStart } = selectBladeBoxes(a);
  for (let i = 0; i < 48; i++) {
    const src = sourceIndexOf(a, bodyStart, i);   // 两盒在产物里的原下标
    assertClose(g.normal[i * 3], a.geometry.normal[src * 3 + 1], 1e-9);
    assertClose(g.normal[i * 3 + 1], -a.geometry.normal[src * 3 + 2], 1e-9);
    assertClose(g.normal[i * 3 + 2], a.geometry.normal[src * 3], 1e-9);
    assertEqual(g.uv[i * 2], a.geometry.uv[src * 2], 'UV 必须原样（产物 UV 已正确）');
    assertEqual(g.uv[i * 2 + 1], a.geometry.uv[src * 2 + 1]);
  }
  // 法线必须是单位长（轴置换保长，写成插值/归一化错会在这里红）
  for (let i = 0; i < 48; i++) {
    const n = [g.normal[i*3], g.normal[i*3+1], g.normal[i*3+2]];
    assertClose(Math.hypot(...n), 1, 1e-6, `顶点 ${i} 法线长度`);
  }
});

test('spike blade: 索引全部落在 [0,48)，且三角数守恒', async () => {
  const a = await loadAsset();
  const g = buildSpikeBladeGeometry(a, 1.6);
  for (const i of g.index) assertTrue(i >= 0 && i < 48, `索引 ${i} 越界`);
  // 产物里这两盒共 24 个三角，一个都不能丢
  assertEqual(g.index.length / 3, 24);
});

test('spike blade: 露出高度可参数化（改它等比改露出段，不改剑粗细）', async () => {
  const a = await loadAsset();
  const g2 = buildSpikeBladeGeometry(a, 2.0);
  assertClose(g2.metrics.maxY, 2.0, 1e-6);
  assertClose(g2.metrics.minY, -(2.655625 - 2.0), 1e-6);
  assertClose(g2.metrics.width, 0.4375, 1e-6, '粗细不随露出高度变');
});
```

`boxesOfBone` / `collectRaw` / `minOf` / `maxOf` / `xOf` / `zOf` / `sourceIndexOf` 是本文件的局部辅助（每盒 24 顶点，`skinIndex[v*4]` 反查骨骼）。**它们必须独立于被测实现**（自己遍历 raw 数组，不 import `spike-blade-geometry.js` 的内部函数）—— 否则两侧共用同一个错误假设会得出「一致」的假结论。

- [ ] **Step 2: 跑测试确认失败**

Run: `node tools/run-unit-node.mjs --only=test-spike-blade.js`
Expected: FAIL —— `--only 里这些文件不在 Node 白名单内`（白名单还没加）。先加白名单与 `index.html` 注册，再跑一次，此时应 FAIL 于 `Cannot find module '../render/spike-blade-geometry.js'`。

- [ ] **Step 3: 实现纯函数**

新建 `src/render/spike-blade-geometry.js`，**不 import three**（文件头写明「纯数组进出，属渲染层的几何预处理，无 GPU 依赖」；⚠️ 不要写「无 DOM 无 three」这类字样以外的同构声明措辞，`check:arch` 的 `ISOMORPHIC_DECLARED` 正则扫全文含注释）。

三个导出：

```js
export const SPIKE_BLADE_BONES = Object.freeze({ body: 'sword', tip: 'sword_blade' });
export function selectBladeBoxes(asset) { /* 每 24 顶点一盒，按 skinIndex 反查骨骼名；
  body = 'sword' 名下 z 跨度最大的盒；tip = 'sword_blade' 名下的盒（唯一）。
  找不到 / 不唯一 ⇒ throw Error（不静默返回 0 —— 那会让剑体变成空几何而计数判据全绿） */ }
export function buildSpikeBladeGeometry(asset, exposeHeight) { /* spec §3.3 的轴置换 */ }
```

`metrics` 的每一项都从变换后的顶点实测得出（不写死数字）：`length` 取 raw 的 z 跨度、`width` 取 x 跨度、`thickness` 取 z 跨度、`minY/maxY` 取 y 极值、`buriedDepth = length − exposeHeight`、`halfWidth = width / 2`。

⚠️ 索引搬运：遍历产物 `index`，只收「三个顶点都落在选中两盒的下标集合里」的三角，逐个减去区间起点映射到 `[0,48)`。两盒下标不连续时也要对（用 Map 而不是单一 offset）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node tools/run-unit-node.mjs --only=test-spike-blade.js`
Expected: PASS，7 例全绿。

- [ ] **Step 5: 负向验证（RF-2 / RF-3）**

用 `cp` 备份 `src/render/spike-blade-geometry.js` 到 `/tmp/`，然后依次注入并跑测试，每次跑完用 `cp` 还原（**禁止 `git checkout`** —— AGENTS.md 记过真实数据丢失）：

| 注入 | 期望 |
|---|---|
| N-a：`selectBladeBoxes` 的 body 改成「z 跨度最小」的盒 | 选盒用例红 |
| N-b：把 `sword_guard` 的盒也收进来（范围扩到全部 sword* 骨骼） | 顶点数 48 用例红 + minY 用例红（RF-2） |
| N-c：变换里对 raw 顶点再乘一次骨骼世界矩阵 | 轴置换用例红（RF-3） |
| N-d：x/z 互换（`local.x = raw.x − cx`） | 「x 是宽 z 是厚」用例红 |

每条都要**看到真的红**并记下失败信息首行。四条全绿说明判据无判别力，停下来报告。

- [ ] **Step 6: 门禁 + 提交**

Run: `npm run check`
Expected: exit 0（`check:data` 的 `[测试注册]` 环节会双向核对新文件；lint 对新增两文件单独跑 `npx eslint src/render/spike-blade-geometry.js src/tests/test-spike-blade.js` 必须零 warning）。

```bash
git add src/render/spike-blade-geometry.js src/tests/test-spike-blade.js src/tests/index.html tools/test-tiers.mjs
git commit -m "feat(ignis): 剑体几何纯函数（从产物取剑身两盒并立起）"
```

---

### Task 2: 玩法常量 —— 五向 × 6 根 + 池容量

**Files:**
- Modify: `src/entities/ignis/ignis-config.js`（`IGNIS_SPIKE`）
- Modify: `src/tests/test-ignis-system.js:994-1011`（`IGNIS_SPIKE 常量取用户裁定值` 用例）

**Interfaces:**
- Consumes: 无（纯常量表，本文件不 import 任何模块）。
- Produces: `IGNIS_SPIKE` 新增/改动字段：
  - `count: 6`（每方向根数，原 5）
  - `directionsDeg: Object.freeze([0, -45, 45, -90, 90])`（前/左前/右前/左/右）
  - `maxActive: 120`（原 20）
  - `exposeHeight: 1.6`（**新增**，剑体露出地面的高度）
  - `height: 1.6` 保留（粒子出生高度爬升沿用它，语义不变）
  - `radius: 0.21875`（原 0.35；语义改为「剑体半宽」= 剑面宽 0.4375 / 2）
  - 其余字段（`spacing/firstOffset/damage/secondRange/secondHitFrame/soloSeconds/doubleSeconds/riseMs/lifeMs/delayPerSegmentMs`）**一个不改**

- [ ] **Step 1: 写失败测试**

改 `src/tests/test-ignis-system.js` 的 `IGNIS_SPIKE 常量取用户裁定值` 用例（按新语义改写，不是放宽）：

```js
assertEqual(IGNIS_SPIKE.count, 6, '用户 2026-11-21 裁定「五排各 6 根」');
assertDeepEqual([...IGNIS_SPIKE.directionsDeg], [0, -45, 45, -90, 90],
  '五向：前 / 左前 / 右前 / 左 / 右（左侧 = −90，见 spec §4.1 实测）');
assertEqual(IGNIS_SPIKE.directionsDeg.length, 5);
assertTrue(Object.isFrozen(IGNIS_SPIKE.directionsDeg));
assertEqual(IGNIS_SPIKE.exposeHeight, 1.6, '露出高度与原锥体一致');
assertEqual(IGNIS_SPIKE.spacing, 2);
assertEqual(IGNIS_SPIKE.firstOffset, 2);
assertEqual(IGNIS_SPIKE.damage, 18, '伤害不变');
assertEqual(IGNIS_SPIKE.secondRange, 4, '双刀门不变');
// 池容量按「总根数 × 并发 4 招」算，不是按每方向根数
const total = IGNIS_SPIKE.count * IGNIS_SPIKE.directionsDeg.length;
assertEqual(total, 30);
assertTrue(total * 4 <= IGNIS_SPIKE.maxActive,
  `池容量 ${IGNIS_SPIKE.maxActive} 装不下并发 4 招 × ${total} 根`);
```

⚠️ 原用例的 `IGNIS_SPIKE.count * 4 <= maxActive` 必须改成 `count * directionsDeg.length * 4` —— 不改的话 6×4=24 ≤ 120 仍绿，而真实需求是 120，**那条断言就失去了判别力**（把 maxActive 改回 20 也仍然绿）。

另加一条新用例钉半径语义：

```js
test('焰魔(v3.27): 尖刺半径 = 剑体半宽（不是锥底半径）', () => {
  assertClose(IGNIS_SPIKE.radius, 0.4375 / 2, 1e-9,
    'radius 语义已改为剑面宽的一半（破土环由它派生）');
  assertTrue(IGNIS_SPIKE.radius !== 0.35, '不得留着旧锥底半径');
});
```

（`assertClose` 若该文件没有则定义局部版本，同 Task 1。）

- [ ] **Step 2: 跑测试确认失败**

Run: `node tools/run-unit-node.mjs --only=test-ignis-system.js`
Expected: FAIL —— `count` 实得 5、`directionsDeg` undefined。

- [ ] **Step 3: 改常量**

按 Interfaces 的清单改 `IGNIS_SPIKE`。注释要写清三件事（都是载荷性的）：
- `directionsDeg` 的**左侧 = −90** 是实测的（与模型 +X / `left_arm` 点积 +1.00），不是数学直觉；
- `count` 是**每方向**根数，总根数 = `count × directionsDeg.length`；
- `radius` 语义从「锥底半径」改成「剑体半宽」，`exposeHeight` 与 `height` 为何都在（前者是剑体露出段，后者是粒子爬升基准，本轮两者同值但语义不同）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node tools/run-unit-node.mjs --only=test-ignis-system.js`
Expected: PASS（该文件全部用例，不只是改的那两条）。

- [ ] **Step 5: 提交**

```bash
git add src/entities/ignis/ignis-config.js src/tests/test-ignis-system.js
git commit -m "feat(ignis): 尖刺常量改五向各 6 根，池容量与半径按剑体派生"
```

---

### Task 3: 落点函数 —— 五向阵列 + 逐根朝向

**Files:**
- Modify: `src/render/spike-fx.js`（`spikeSpawnPoints`）
- Modify: `src/tests/test-spike-fx.js:46-88`（落点与朝向四条用例）

**Interfaces:**
- Consumes: Task 2 的 `IGNIS_SPIKE.{count, directionsDeg, spacing, firstOffset, delayPerSegmentMs}`。
- Produces: `spikeSpawnPoints(at, yaw, cfg = IGNIS_SPIKE) → Array<{x:number, z:number, delayMs:number, yaw:number}>`
  —— **新增 `yaw` 字段**（该根的实例朝向，弧度）；数组长度 30；顺序 = 方向外层、半径内层。

- [ ] **Step 1: 写失败测试**

改 `src/tests/test-spike-fx.js` 的落点段。四条旧用例按新语义改写 + 三条新增：

```js
test('spike fx: 30 根落点 = 五向 × 2/4/6/8/10/12 格（本仓 yaw 口径）', () => {
  const pts = spikeSpawnPoints([10, 5, 20], 0);
  assertEqual(pts.length, 30);
  // yaw=0：正前方 = (0,−1)，左侧(−90°) = (+1,0)，右侧(+90°) = (−1,0)
  const front = pts.filter((p) => Math.abs(p.x - 10) < 1e-9);
  assertEqual(front.length, 6);
  assertDeepEqual(front.map((p) => +(20 - p.z).toFixed(6)), [2, 4, 6, 8, 10, 12]);
});

test('spike fx: 左侧方向落在模型左手侧（RF-1，符号写反会整阵镜像）', () => {
  for (const yaw of [0, 0.7, Math.PI / 2, 2.3]) {
    const pts = spikeSpawnPoints([0, 0, 0], yaw);
    // 模型 +X（left_arm / 盾所在侧）经 yaw 旋转后的世界方向
    const modelLeft = [Math.cos(yaw), -Math.sin(yaw)];
    // 左侧那一排 = directionsDeg 里 −90 的那一组（按方向的定义取，不靠下标猜）
    const leftDeg = IGNIS_SPIKE.directionsDeg[3];
    assertEqual(leftDeg, -90);
    const a = yaw + leftDeg * Math.PI / 180;
    const dir = [-Math.sin(a), -Math.cos(a)];
    const dot = dir[0] * modelLeft[0] + dir[1] * modelLeft[1];
    assertTrue(dot > 0.9, `yaw=${yaw} 左侧方向 · 模型左向量 = ${dot}，须 > 0.9`);
    // 右侧必须相反（只钉一侧时「五向全挤到左边」也能绿）
    const ar = yaw + IGNIS_SPIKE.directionsDeg[4] * Math.PI / 180;
    const dr = [-Math.sin(ar), -Math.cos(ar)];
    assertTrue(dr[0] * modelLeft[0] + dr[1] * modelLeft[1] < -0.9);
  }
});

test('spike fx: 同一半径的 5 根同延迟（先内圈再外圈）', () => {
  const pts = spikeSpawnPoints([0, 0, 0], 0.4);
  for (let i = 0; i < 6; i++) {
    const ring = pts.filter((p) => Math.abs(Math.hypot(p.x, p.z) - 2 * (i + 1)) < 1e-6);
    assertEqual(ring.length, 5, `半径 ${2 * (i + 1)} 那一圈须有 5 根`);
    const delays = new Set(ring.map((p) => p.delayMs));
    assertEqual(delays.size, 1, `同圈延迟必须相同，实得 ${[...delays]}`);
    assertEqual([...delays][0], i * IGNIS_SPIKE.delayPerSegmentMs);
  }
  // 负向锚点：延迟若按「方向 × 6 + 半径」递增，同圈会有 5 个不同值 ⇒ 上面必红
});

test('spike fx: 延迟序列每方向 0/50/100/150/200/250ms', () => {
  const pts = spikeSpawnPoints([0, 0, 0], 0);
  const front = pts.filter((p) => Math.abs(p.x) < 1e-9 && p.z < 0);
  assertDeepEqual(front.map((p) => p.delayMs), [0, 50, 100, 150, 200, 250]);
});

test('spike fx: 30 根占 30 个互不相同的格，最近两点不穿模', () => {
  const pts = spikeSpawnPoints([0.5, 0, 0.5], 0);
  const cells = new Set(pts.map((p) => `${Math.floor(p.x)},${Math.floor(p.z)}`));
  assertEqual(cells.size, 30, '落点不得共格（共格会让两根剑叠在一起）');
  let min = Infinity;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      min = Math.min(min, Math.hypot(pts[i].x - pts[j].x, pts[i].z - pts[j].z));
    }
  }
  assertClose(min, 1.530734, 1e-4, '最近两点间距（实测）');
  assertTrue(min > IGNIS_SPIKE.radius * 2, '间距须大于剑面宽，否则穿模');
});

test('spike fx: 逐根 yaw 让剑宽面朝焰魔（RF-4）', () => {
  const yaw = 0.9;
  const pts = spikeSpawnPoints([0, 0, 0], yaw);
  for (const p of pts) {
    // 剑宽沿局部 X、厚沿局部 Z ⇒ 宽面法线 = 局部 ±Z
    // 实例 rotation.y = p.yaw 后，局部 +Z 的世界方向 = (sin p.yaw, cos p.yaw)
    const n = [Math.sin(p.yaw), Math.cos(p.yaw)];
    const r = Math.hypot(p.x, p.z);
    const radial = [p.x / r, p.z / r];
    const dot = n[0] * radial[0] + n[1] * radial[1];
    assertTrue(dot > 0.999, `(${p.x.toFixed(2)},${p.z.toFixed(2)}) 宽面法线 · 径向 = ${dot}，须 ≈1`);
  }
  // 负向锚点：yaw 不加 π ⇒ dot ≈ −1 ⇒ 上面必红
});

test('spike fx: 落点随 yaw 旋转等变（不是固定 −Z）', () => {
  const yaw = 0.7;
  const a = spikeSpawnPoints([3, 0, -4], 0);
  const b = spikeSpawnPoints([3, 0, -4], yaw);
  // 逐点绕 y 旋转 yaw 后必须与 b 重合（等变性，比逐根算公式更难写错）
  for (let i = 0; i < a.length; i++) {
    const dx = a[i].x - 3, dz = a[i].z + 4;
    const rx = dx * Math.cos(yaw) + dz * Math.sin(yaw);
    const rz = -dx * Math.sin(yaw) + dz * Math.cos(yaw);
    assertClose(b[i].x, 3 + rx, 1e-9);
    assertClose(b[i].z, -4 + rz, 1e-9);
    assertClose(b[i].yaw - a[i].yaw, yaw, 1e-9, '朝向也要跟着转');
  }
});
```

⚠️ 保留「首根不在脚底」那条用例，但把「最远一根 = 10」改成 **12**（新阵列最外圈）。

- [ ] **Step 2: 跑测试确认失败**

Run: `node tools/run-unit-node.mjs --only=test-spike-fx.js`
Expected: FAIL —— `pts.length` 实得 5、`p.yaw` undefined。

- [ ] **Step 3: 实现落点函数**

`spikeSpawnPoints` 改成双层循环（方向外层、半径内层），逐点算：

```
ang   = yaw + cfg.directionsDeg[d] * Math.PI / 180
dist  = cfg.spacing * (i + 1) + (cfg.firstOffset - cfg.spacing)
x     = at[0] - Math.sin(ang) * dist
z     = at[2] - Math.cos(ang) * dist
delay = i * cfg.delayPerSegmentMs
yaw   = ang + Math.PI
```

`dist` 的公式**照抄现有写法**（`firstOffset - spacing` 那一项在 `firstOffset=2, spacing=2` 时为 0，但保留它才能让用户改 `firstOffset` 时生效）。

文件头注释更新：把「首根在正前方 2 格」那段改成「五向 × 6 根半圆阵列」，并写明**左侧 = −90 的实测依据**与**朝向 +π 的理由**（宽面朝圆心；不加 π 会看到 0.0625 厚窄边，投影面积差 7.8 倍）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node tools/run-unit-node.mjs --only=test-spike-fx.js`
Expected: 落点段全绿；**几何/材质相关用例此时仍红**（Task 4 才改），这是预期的 —— 记下红的用例名，Task 4 结束时它们必须全绿。

- [ ] **Step 5: 负向验证（RF-1 / RF-4）**

`cp` 备份 `spike-fx.js` 到 `/tmp/`，注入后跑测试，`cp` 还原：

| 注入 | 期望 |
|---|---|
| N-a：`directionsDeg` 取 `[0, 45, -45, 90, -90]`（左右反） | RF-1 用例红 |
| N-b：延迟改成 `(d * 6 + i) * delayPerSegmentMs` | 「同圈同延迟」用例红 |
| N-c：`yaw: ang`（不加 π） | RF-4 用例红 |
| N-d：只改左侧符号（`[0,-45,45,90,90]`，两排都在左） | RF-1 的右侧判据红 |

- [ ] **Step 6: 提交**

```bash
git add src/render/spike-fx.js src/tests/test-spike-fx.js
git commit -m "feat(ignis): 尖刺落点扩成五向半圆阵列，逐根带宽面朝向"
```

---

### Task 4: 剑体上屏 —— 几何 + 原色材质 + 实例朝向

**Files:**
- Modify: `src/render/spike-fx-material.js`（删剑纹 TSL，加剑体材质）
- Modify: `src/render/spike-fx.js`（构造参数加 `asset`；几何换剑体；实例矩阵加旋转；删剑纹属性）
- Modify: `src/core/game.js`（`this._ignisAsset` + 装配传参 + 消费 `p.yaw`）
- Modify: `src/tests/test-spike-fx.js`（几何/材质用例按新语义改写；删 4 条剑纹用例）

**Interfaces:**
- Consumes: Task 1 的 `buildSpikeBladeGeometry(asset, exposeHeight)`；Task 2 的 `IGNIS_SPIKE.exposeHeight/radius`；Task 3 的 `spikeSpawnPoints` 返回的 `yaw`。
- Produces:
  - `createSpikeBladeMaterial({texture}) → THREE.MeshBasicMaterial`（`map` + `alphaTest:0.5` + `NormalBlending` + `DoubleSide` + `transparent:true` + `depthWrite:false` + `fog:false`）
  - `SpikeFxRenderer` 构造参数新增 `asset`（`loadIgnisAsset()` 的结果，可为 null）
  - `SpikeFxRenderer.blade` getter → `{vertexCount, triangleCount, length, width, thickness, exposeHeight, buriedDepth, halfWidth} | null`（null = 走了锥体回落）
  - `createSpikePlainMaterial(color)` **保留不变**（回落路径）
  - **删除**：`createSpikeConeMaterial`、`SPIKE_TEX_ATTR`

- [ ] **Step 1: 写失败测试**

改 `src/tests/test-spike-fx.js`：

① 把「几何是 6 棱锥」用例整条替换（`ConeGeometry.parameters` 在剑体上不存在）：

```js
test('spike fx: 给了产物就走剑体几何，尺寸取剑体度量', async () => {
  const asset = await loadIgnisAssetForTest();
  const r = new SpikeFxRenderer({ scene: new THREE.Scene(), asset, texture: fakeTex() });
  try {
    assertEqual(r.mesh.geometry.getAttribute('position').count, 48);
    assertEqual(r.mesh.geometry.getIndex().count, 72);
    assertNotNull(r.blade, '有产物时 blade 度量不得为 null');
    assertClose(r.blade.exposeHeight, IGNIS_SPIKE.exposeHeight, 1e-6);
    assertClose(r.blade.width, 0.4375, 1e-6);
    assertClose(r.blade.halfWidth, IGNIS_SPIKE.radius, 1e-9,
      '玩法侧 radius 必须与几何半宽同源（两份会漂）');
    // RF-2：几何 y 极值 —— 剑尖 1.6、埋入 −1.055625
    const pos = r.mesh.geometry.getAttribute('position');
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < pos.count; i++) { minY = Math.min(minY, pos.getY(i)); maxY = Math.max(maxY, pos.getY(i)); }
    assertClose(maxY, 1.6, 1e-6);
    assertClose(minY, -1.055625, 1e-6);
  } finally { r.dispose(); }
});

test('spike fx: 无产物时退回锥体且不抛错，阵列不回落（§6.2）', () => {
  const r = new SpikeFxRenderer({ scene: new THREE.Scene(), asset: null, texture: null });
  try {
    assertNull(r.blade, '无产物时 blade 度量须为 null（可分辨「形状退化」与「招式消失」）');
    assertEqual(r.mesh.geometry.type, 'ConeGeometry');
    // 阵列仍是 30 根（落点是玩法常量，与产物无关）
    r.spawn(spikeSpawnPoints([0, 5, 0], 0).map((p) => ({ ...p, y: 5 })), 1000);
    r.update(1000 + SPIKE_FX.riseMs);
    assertEqual(r.activeCount, 30);
    assertTrue(r.mesh.visible);
  } finally { r.dispose(); }
});
```

② 「additive 混合」用例按新语义改写（v3.24 已改正常混合，本轮沿用）：

```js
test('spike fx: 剑体是正常混合 + 原色贴图 + 不写深度', async () => {
  const r = new SpikeFxRenderer({ scene: new THREE.Scene(), asset: await loadIgnisAssetForTest(), texture: fakeTex() });
  try {
    assertEqual(r.mesh.material.blending, THREE.NormalBlending,
      'additive 在亮天空前必然钳白，金纹出不来（v3.24 实测）');
    assertNotNull(r.mesh.material.map, '剑体贴图必须真的挂上（原色直采）');
    assertEqual(r.mesh.material.alphaTest, 0.5);
    assertEqual(r.mesh.material.side, THREE.DoubleSide, '0.0625 厚薄片必须双面');
    assertFalse(r.mesh.material.depthWrite);
    assertTrue(r.mesh.material.depthTest);
    assertTrue(r.mesh.material.transparent);
    assertFalse(r.mesh.material.fog, '远处不得被雾洗成天空色');
  } finally { r.dispose(); }
});
```

③ **删除**四条剑纹用例（`UV 子区落在剑身嵌纹带内` / `逐根随机参数真的在变` / `矩形必须落在剑身嵌纹带上` / `逐实例纹理参数属性在两种材质下都存在`）与文件顶部对 `spikeTexUvRect / spikeTexPattern / SPIKE_TEX_ATTR` 的 import。用户原话「现在的圆锥体的带有纹路的尖刺模型不要了」⇒ 这些机制整体退场，不是放宽。

④ 新增实例朝向用例（RF-4 的数据层）：

```js
test('spike fx: 实例矩阵真的带朝向（RF-4，只写 position 会全部同向）', async () => {
  const r = new SpikeFxRenderer({ scene: new THREE.Scene(), asset: await loadIgnisAssetForTest(), texture: fakeTex() });
  try {
    const pts = spikeSpawnPoints([0, 5, 0], 0.9).map((p) => ({ ...p, y: 5 }));
    r.spawn(pts, 1000);
    r.update(1000 + SPIKE_FX.riseMs);   // 满尺寸
    const m = new THREE.Matrix4();
    for (let i = 0; i < pts.length; i++) {
      r.mesh.getMatrixAt(i, m);
      const e = m.elements;
      // 局部 +Z 基向量（第三列）在世界的 xz 投影 = (sin yaw, cos yaw)
      const n = [e[8], e[10]];
      const len = Math.hypot(n[0], n[1]);
      assertClose(len, 1, 1e-5, '满尺寸时基向量须单位长（scale=1）');
      const want = [Math.sin(pts[i].yaw), Math.cos(pts[i].yaw)];
      assertClose(n[0] / len, want[0], 1e-5, `第 ${i} 根朝向 x`);
      assertClose(n[1] / len, want[1], 1e-5, `第 ${i} 根朝向 z`);
      // 位置也要对（makeRotationY 会清位移 ⇒ 必须最后 setPosition）
      assertClose(e[12], pts[i].x, 1e-6);
      assertClose(e[13], 5, 1e-6);
      assertClose(e[14], pts[i].z, 1e-6);
    }
    // 负向锚点：只 makeScale + setPosition（旧写法）⇒ 所有 n = (0,1) ⇒ 上面必红
  } finally { r.dispose(); }
});
```

⑤ 「5 根一次 spawn」/「全部延迟过后 5 根可见」/「5 根都找到地面并 spawn」三条的 5 改 **30**，并把「延迟到点后可见数递增」的采样点按新延迟序列（0..250）重算。

`loadIgnisAssetForTest` 与 `fakeTex` 是本文件局部辅助：前者 `fetch(new URL('../../assets/ignis/ignis.json', import.meta.url)).then(r => r.json())`，后者 `new THREE.DataTexture(new Uint8Array([255,255,255,255]), 1, 1)`。

- [ ] **Step 2: 跑测试确认失败**

Run: `node tools/run-unit-node.mjs --only=test-spike-fx.js`
Expected: FAIL —— `r.blade` undefined、几何仍是 ConeGeometry、材质无 map。

- [ ] **Step 3: 实现材质**

`src/render/spike-fx-material.js`：删掉 v3.24 那一整段（`SPIKE_TEX_ATTR` / `vec3arr` / `createSpikeConeMaterial`）与文件头对应的注释段。新增：

```js
export function createSpikeBladeMaterial({ texture: tex }) { /* MeshBasicMaterial：
  color 白（有贴图时基色必须白，否则「深色 × 纹理」变暗）、map: tex、alphaTest 0.5、
  side DoubleSide、transparent true、depthWrite false、depthTest true、
  blending NormalBlending、fog false、toneMapped false */ }
```

⚠️ **不要写 `colorNode` / TSL** —— 剑身 UV 已正确，原色直采就够了；引入 TSL 只会把 v3.24 的重映射问题带回来。
⚠️ 逐根淡出仍靠 `instanceColor`（three 的 `setupDiffuseColor` 自动 `instanceColor.mul(colorNode)`，`three.webgpu.js:21619` 已核）⇒ 材质里**不得再乘一次**。
⚠️ 两个粒子 pass（`createSpikeSparkMaterial` / `createSpikeEmberMaterial` / `createSpikeSparkGeometry`）**一行不改**。

- [ ] **Step 4: 实现渲染器几何与矩阵**

`src/render/spike-fx.js`：

- 构造签名加 `asset = null`；`this.blade = asset ? buildSpikeBladeGeometry(asset, IGNIS_SPIKE.exposeHeight).metrics : null`。
- 有 asset ⇒ `BufferGeometry` 装 `position/normal/uv/index`（从 Task 1 的返回值），材质走 `createSpikeBladeMaterial({texture})`（`texture` 为 null 时仍走 `createSpikePlainMaterial`，两者独立判断：**几何看 asset，贴图看 texture**）。
- 无 asset ⇒ 保留现有 `ConeGeometry(SPIKE_FX.radius, SPIKE_FX.height, 6)` + `translate`。⚠️ 此时 `SPIKE_FX.radius` 已是 0.21875（剑体半宽），回落锥会比原来细 —— 这是可接受的退化形态，注释写明。
- 删掉四个剑纹 instanced 属性的创建与初始化循环（`_texTiles/_texReps/_texPhase/_texMirror` 与 `spikeTexPattern` import）。
- `spawn` 把 `p.yaw` 存进活跃项（`Number.isFinite(p.yaw) ? p.yaw : 0`）。
- `update` 的矩阵改成：`_matrix.makeRotationY(s.yaw)` → `_matrix.scale(_scaleVec.set(k,k,k))` → `_matrix.setPosition(s.x, s.y, s.z)`。⚠️ `makeRotationY` 会清位移、`scale` 是右乘（先缩放后旋转，等比缩放下两者可交换），**`setPosition` 必须最后**。新增模块级 `_scaleVec = new THREE.Vector3()`。
- `SPIKE_FX` 表加 `exposeHeight: IGNIS_SPIKE.exposeHeight`。

- [ ] **Step 5: 装配层接线**

`src/core/game.js`：
- `loadIgnisAsset()` 的结果存到 `this._ignisAsset`（try 内赋值，catch 里置 null）。
- `new SpikeFxRenderer({ scene, texture: this.ignisRenderer?.texture ?? null, asset: this._ignisAsset })`。
- `_consumeIgnisFxRequests` 的 `spikeSlash` 分支：`spikes.push({ x, y, z, delayMs: p.delayMs, yaw: p.yaw })`。**伤害逻辑一行不改**（仍逐根 `overlapsBlock` + break）。

- [ ] **Step 6: 跑测试确认通过**

Run: `node tools/run-unit-node.mjs --only=test-spike-fx.js,test-spike-blade.js,test-ignis-system.js`
Expected: PASS，Task 3 Step 4 记下的红用例全部转绿。

- [ ] **Step 7: 负向验证（RF-4 / §6.2）**

`cp` 备份三个源文件到 `/tmp/`，逐条注入后跑测试再 `cp` 还原：

| 注入 | 期望 |
|---|---|
| N-a：`update` 退回 `makeScale + setPosition`（丢掉旋转） | RF-4 实例矩阵用例红 |
| N-b：`setPosition` 挪到 `scale` 之前 | 位置判据红 |
| N-c：有 asset 时仍走 `ConeGeometry` | 剑体几何用例红（⚠️ 与合法回落区分：注入的是「给了 asset 却不用」） |
| N-d：材质改 `AdditiveBlending` | 正常混合用例红 |
| N-e：材质里再乘一次 `instanceColor` 等价物（`color` 设成非白） | 「基色必须白」——若没这条判据就补一条 |

- [ ] **Step 8: 门禁 + 提交**

Run: `npm run check`
Expected: exit 0；`npx eslint src/render/spike-fx.js src/render/spike-fx-material.js src/core/game.js src/tests/test-spike-fx.js` 零**新增** warning（与改动前逐文件对比，不看全仓总数）。

```bash
git add src/render/spike-fx.js src/render/spike-fx-material.js src/core/game.js src/tests/test-spike-fx.js
git commit -m "feat(ignis): 尖刺改剑体几何与原色贴图，实例带朝向"
```

---

### Task 5: 粒子速率与池容量

**Files:**
- Modify: `src/render/spike-fx-config.js`（删剑纹常量与两个纯函数；速率÷2；容量 4096）
- Modify: `src/tests/test-spike-sparks.js`（若有硬值断言则按新语义改写）
- Modify: `tests/ignis-spike.spec.mjs:378`（`capacity` 硬值 768 改成读常量）

**Interfaces:**
- Consumes: Task 2 的 `IGNIS_SPIKE.{count, directionsDeg, radius, height, riseMs, lifeMs}`。
- Produces: `SPIKE_SPARK_FX` 的 `burstRate:120 / trickleRate:13 / emberBurstRate:38.5 / emberTrickleRate:5 / capacity:4096`；**删除** `textureRect / wrapTiles / riseTiles / charcoalRamp / charcoalWindow / charcoalGain / opacity` 与 `spikeTexUvRect / spikeTexPattern` 两个导出。`spikeSparkQuotaAt` / `spikeSparkSeeds` **签名与实现不变**。
- 另修正 `test-spike-sparks.js` 池账用例的**总根数口径**（详 Step 1）。

- [ ] **Step 1: 先跑一遍确认哪些断言会红**

Run: `node tools/run-unit-node.mjs --only=test-spike-sparks.js`
Expected: **池账用例红**（实得 876 > 768）。记下红的用例与实得数字 —— 这是本 Task 的 RED。

⚠️ **池账公式本身有缺陷，必须一并修**：它用 `IGNIS_SPIKE.count`，而 Task 2 之后那是
**每方向**根数（6）不是总根数（30）。不改它的形态是「池账按 6 根算而实际喷 30 根」
—— 把 `capacity` 改回 768 也仍然可能绿（判别力丢失）。三处引用全改成
`IGNIS_SPIKE.count * IGNIS_SPIKE.directionsDeg.length`：`perCast` / `perCastSpark` /
`longestMs` 里的「最后一根延迟」项（后者用 `count - 1` 是对的 —— 延迟只跟半径序号挂钩，
最大延迟仍是 `(count-1) × 50 = 250ms`，**不要乘方向数**）。

改完后重跑：池账应红于 **4380 > 768**（而不是 876）。

- [ ] **Step 2: 改常量**

按 Interfaces 改 `SPIKE_SPARK_FX`。注释要写清 spec §5.0 的实测结论：**÷6 会让每批恒 1 颗、「首批 > 末批」红**，所以取 ÷2；容量 4096 的推导（30×27×2 = 1620，且留了「还原速率」的 3300 余量）。

删掉的常量与函数：连带删掉文件头 v3.24 那两段注释（剑纹来源、烧炭色阶推导），换成一句「剑体几何自带正确 UV，原色直采，本表不再持有表面着色参数」。

- [ ] **Step 3: 跑测试确认通过**

Run: `node tools/run-unit-node.mjs --only=test-spike-sparks.js`
Expected: PASS。⚠️ **九条关系式全部不许改**（已实测 ÷2 后逐条通过：burst>trickle ✓、burst≥4×trickle ✓（9.2 倍）、破土占比 0.815>0.5 ✓、余烬 9>0 ✓、9<27×0.5 ✓、批次 17≥5 ✓、首批 2>末批 1 ✓、池总 2160≤4096 ✓、火星 1620≤4096 ✓）。若有任何一条红，**停下来报告**，不要调阈值。

⚠️ 池账的**总根数口径**（Step 1 改的那三处）不是放宽 —— 它把判据从「6 根」修回「30 根」，
是变严。负向验证 N-c（capacity 改回 768）必须真红，那就是它的判别力证明。

- [ ] **Step 4: 改 spec 的容量硬值**

`tests/ignis-spike.spec.mjs:378` 的 `expect(pre.capacity).toBe(768)` 改成从页面读常量比对：在 `pre` 的 evaluate 里 `const { SPIKE_SPARK_FX } = await import('/src/render/spike-fx-config.js')` 取 `capacity`，断言 `pre.capacity === pre.cfgCapacity`。⚠️ 不要在 spec 里写 4096（第二份权威）。

- [ ] **Step 5: 负向验证（RF-5）**

`cp` 备份 config 到 `/tmp/`：

| 注入 | 期望 |
|---|---|
| N-a：速率÷6（`burstRate:40, trickleRate:26/6`） | 「首批 > 末批」红（RF-5 的下界） |
| N-b：速率还原成 240/26/77/10 | 池账红（RF-5 的上界） |
| N-c：`capacity` 改回 768 | 池账红 |

- [ ] **Step 6: 门禁 + 提交**

Run: `npm run check`
Expected: exit 0（`spikeTexUvRect` 等导出被删后，`check:arch` 的依赖检查与 lint 的未用 import 都会抓到残留引用）。

```bash
git add src/render/spike-fx-config.js src/tests/test-spike-sparks.js tests/ignis-spike.spec.mjs
git commit -m "feat(ignis): 尖刺粒子速率减半、池容量按 30 根重算，删剑纹重映射参数"
```

---

### Task 6: Tier 4 像素实测

**Files:**
- Modify: `tests/ignis-spike.spec.mjs`（前提断言、机位、五向判据、朝向对照）

**Interfaces:**
- Consumes: Task 4 的 `SpikeFxRenderer.blade` getter 与实例矩阵；Task 3 的 `spikeSpawnPoints`（带 `yaw`）；Task 5 的 `SPIKE_SPARK_FX.capacity`。
- Produces: 无源码接口（测试文件）。

- [ ] **Step 1: 起本 worktree 的服务并核对端口归属**

```bash
MC_PORT=8082 npm start > /tmp/mc-8082.log 2>&1 &
lsof -ti:8082
```
拿到 PID 后 `lsof -p <pid> | grep cwd` 确认 cwd 是**本 worktree**（`…/.worktrees/feat/ignis-spike-blade-array`），再 `curl -s http://localhost:8082/src/render/spike-blade-geometry.js | head -3` 确认内容是新的。⚠️ 不带 `MC_PORT` 会复用主仓 8081 的服务，测的是别人的代码（AGENTS.md 记过）。

- [ ] **Step 2: 改前提断言与机位**

`tests/ignis-spike.spec.mjs` 第一个用例：
- `pre` 里删 `geoType/radialSegments/radius/height`（ConeGeometry 专有），改读 `g.spikeFx.blade`（`vertexCount/triangleCount/width/thickness/exposeHeight/buriedDepth`）与 `geometry.getAttribute('position').count`。
- 断言：`blade.vertexCount === 48`、`blade.exposeHeight === 1.6`、`blade.width ≈ 0.4375`、`blade.buriedDepth ≈ 1.055625`、`material.map !== null`、`blending === NormalBlending`、`renderOrder > oceanRenderOrder`。
- `injected.spawned` 与两处 `active` 的 5 改 **30**。
- **机位按数据搜索**（不写死坐标）：spec 里跑一遍 `generateHeight`（经 `page.evaluate` import `/src/gen/terrain.js`），在候选网格里找「30 根落点高度全相同且 > SEA_Y」的点。已实测 seed 12345 的 **(1199, 1100)** 满足（30/30 同高 5，DESERT）；搜索逻辑要在 spec 里，换 seed 时自动跟上。
- `setupScene` 的焰魔位置改成相对搜索出的机位，玩家 yaw 朝向阵列中心。

- [ ] **Step 3: 加「五向都上屏」判据**

在第一个用例里，spawn 后按**方向分区**数暖色像素：在 `page.evaluate` 里用
`g.camera`（`game.js:279` 的 PerspectiveCamera，经 `window.__MC_GAME__` 可访）把
`spikeSpawnPoints` 的 30 个落点 `project(camera)` 成屏幕坐标（✕ pixelRatio，实测=1），
回传给 Node 侧；逐像素按**最近落点**归属到五个方向之一，分别数暖色像素。
断言**五个方向各自的暖色像素数都 > 噪声底 + 阈值**。

⚠️ 只数总量抓不到「少了一个方向」（29 根与 30 根的总量差异在噪声量级）。阈值先跑一遍打印实际值再定（AGENTS.md：断言前先在真实数据上跑一次）。
⚠️ **相机姿态要先冻住**（viewBob / stepLift 两个 update 换空转），否则投影坐标与实际画面对不上
—— AGENTS.md 记过「相机投影定中心撞上 viewBob 每帧重写姿态，实测偏 59px/96px」。

- [ ] **Step 4: 加「先内圈后外圈」判据**

按真实 age 逐点采样（`waitForFunction(performance.now() − T0 >= t)`，t = 60/120/180/240/300ms），每帧算暖色像素的**半径质心**（像素 → 最近落点 → 该落点的世界半径，加权平均）。断言质心**单调不减**且首末差 > 2 格。

⚠️ 出生点自己在动的那条教训（`moving-emitter-needs-relative-displacement-criterion`）在这里**不适用** —— 本判据量的是「哪些根已破土」，落点是固定的，不随时间移动。但要在注释里写明这个区别，避免后来者误改。

- [ ] **Step 5: 加朝向的同机位单变量对照（RF-4）**

用 `page.route('**/spike-fx.js*', …)` 在**浏览器侧**把 `yaw: ang + Math.PI` 换成 `yaw: ang + Math.PI + Math.PI/2`（转 90° ⇒ 看窄边），同机位重拍。断言正确态的暖色像素数 **显著高于** 转 90° 态（预期比值 ≈7.8，阈值按实测取中）。

⚠️ `page.route` **必须在 `page.goto` 之前注册**（AGENTS.md 记过，放后面时拦截永不触发）。
⚠️ 两侧都要藏掉焰魔本体（同色系宿主）+ 冻五个动态源（玩家下落 / 海面 / 手臂 / 昼夜 / viewBob+stepLift）+ `ignises.update` 空转。

- [ ] **Step 6: 跑 spec**

Run: `MC_PORT=8082 npx playwright test tests/ignis-spike.spec.mjs`
Expected: 全部用例 PASS。⚠️ **不要接管道**（`| sed` 会把退出码变成管道末端工具的，AGENTS.md 记过假绿）。

- [ ] **Step 7: 跑相邻 spec 与 bench**

```bash
MC_PORT=8082 npx playwright test tests/ignis-fx.spec.mjs tests/ignis.spec.mjs tests/water-order.spec.mjs
npm run bench -- --check
```
Expected: 全绿。bench 若报 frameP95 回退，用**交替对照**判定（vsync 量子化噪声，AGENTS.md 记过），不改阈值。⚠️ `docs/m3-baseline.*` 是冻结基线，诊断后要 `git checkout` 恢复 —— 但**只对这两个文件**，且确认它们没有别人的未提交改动。

- [ ] **Step 8: 提交**

```bash
git add tests/ignis-spike.spec.mjs
git commit -m "test(ignis): 尖刺剑体与五向阵列的 Tier 4 像素实测"
```

---

### Task 7: 文档与收尾

**Files:**
- Modify: `docs/roadmap.md`（v3.27 行）
- Modify: `CLAUDE.md`（高频坑：bind 下 skinning 恒等 / 速率÷6 的反直觉）

**Interfaces:**
- Consumes: 前六个 Task 的实测数据。
- Produces: 无代码接口。

- [ ] **Step 1: 写 roadmap v3.27 行**

按既有版本表的格式写：改了什么、实测数据（剑体 48 顶点 / 露出 1.6 / 埋入 1.055625 / 30 根五向 / 最近间距 1.5307 / 粒子每根 27+9 / 池 4096）、验证结果（各命令与实际读数）、被推翻的旧断言清单。

- [ ] **Step 2: 写两条高频坑**

追加到 `CLAUDE.md` 的「渲染与 GPU」段：

1. **bind 姿态下 skinning 是恒等变换**：焰魔产物顶点已是绝对模型坐标（实测 1920 顶点最大差 8.88e-16），从产物抽子几何**不能再乘骨骼链**（实测 `sword_blade` 偏 0.466 格）。这是守卫那条「顶点必须预乘 bind 世界矩阵」的**镜像** —— 守卫是 Java 局部顶点所以必须乘，焰魔是 Bedrock 绝对顶点所以绝不能乘。判据要同时钉「与 raw 的轴置换逐位一致」与「bbox 落位」。
2. **「保持粒子总量不变」会毁掉单根的节奏**：根数 5→30 时把速率÷6，每根只剩 9 颗、逐帧每批恒 1 颗 ⇒ 「破土猛迸」读不出，且既有「首批 > 末批」断言真红。÷2 才是既保节奏又不过曝的档（实测五档扫描）。

⚠️ **`AGENTS.md` 是 `CLAUDE.md` 的符号链接** ⇒ `git add CLAUDE.md`（不是 AGENTS.md），提交后用 `git show --stat` 核对它真的在里。

- [ ] **Step 3: 全量最小门 + 单测**

```bash
npm run check
node tools/run-unit-node.mjs --all
```
Expected: 两条都 exit 0。记下文件数与用例总数（与改动前对比，新增用例数应 = Task 1 的 7 + Task 2/3/4 新增的若干）。

- [ ] **Step 4: 提交**

```bash
git add docs/roadmap.md CLAUDE.md docs/superpowers/specs/2026-11-21-ignis-spike-blade-array-design.md docs/superpowers/plans/2026-11-21-ignis-spike-blade-array.md
git commit -m "docs(ignis): v3.27 剑体阵列的进度、设计与两条高频坑"
```

- [ ] **Step 5: 停掉 dev server**

`lsof -ti:8082` 拿 PID → kill → **再用端口探测确认 listener 子进程也退了**（AGENTS.md：kill 父进程不等于服务停了）。

---

## Self-Review

**1. Spec coverage**：§3.0/3.1/3.2/3.3（bind 恒等、选盒、露出、轴置换）→ Task 1；§3.4（朝向）→ Task 3 + Task 4 + Task 6 Step 5；§3.5/3.6（原色材质、混合、顺序）→ Task 4；§4（五向落点、左右、同圈同延迟、格去重）→ Task 2 + Task 3；§4.3（伤害面积变大但只扣一次）→ Task 4 Step 5 明确不改 + 既有用例保留；§5（速率÷2、池账、容量）→ Task 5；§6.2（产物缺失回落）→ Task 4；§7（验证计划、六条负向）→ 各 Task 的负向步骤 + Task 6；§8 非目标 → 各 Task 的「不改」清单。无缺口。

**2. Step scan**：每个 Step 都是一件事 + 一个可检查结果。代码块只出现在「测试断言」与「实现者无法从签名推出的算法」（轴置换公式、矩阵乘法顺序）；材质与渲染器的 body 用签名 + 参数清单描述，不写转录。

**3. Type consistency**：`buildSpikeBladeGeometry` 返回的 `metrics.halfWidth` 在 Task 4 被断言等于 `IGNIS_SPIKE.radius`（Task 2 定义）；`spikeSpawnPoints` 的 `yaw` 字段在 Task 3 产出、Task 4 的 `spawn`/`update` 消费、Task 6 的投影判据消费，名字一致；`SpikeFxRenderer.blade` getter 在 Task 4 定义、Task 6 读取；`createSpikeBladeMaterial({texture})` 的参数名与 `createSpikeConeMaterial` 的旧签名同形（ destructuring `{texture: tex}`）。

**4. Review Focus**：五条各有归属 Task 与判据（RF-1→Task 3 Step 1/5；RF-2→Task 1 Step 1/5 + Task 4 Step 1；RF-3→Task 1 Step 1/5；RF-4→Task 3 Step 1/5 + Task 4 Step 1/7 + Task 6 Step 5；RF-5→Task 5 Step 3/5）。

**5. Proportion**：spec ~230 行，plan ~430 行。测试断言占多数（那是计划的本体：它决定实现者写什么），实现 body 只有轴置换与矩阵顺序两处。比例合理。