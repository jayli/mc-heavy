# 炮塔塔顶模型替换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把坦克 OBJ 模型的塔顶部分（楔形颊舱 + 中央炮座 + 转台环 + 鼻段 + 主炮管 + 两组副武器）烘焙成 JSON 几何产物，替换现有 8 个参数化盒/圆柱部件，炮管与塔身刚性一体共用单层 pivot。

**Architecture:** 离线烘焙（node 侧零依赖解析 OBJ → 按面 bbox 切 9 个语义部件 → 丢弃车体 → 定标到格 → 按几何面法线分三区重建 UV → 逐面拆顶点 → JSON 产物 + 指纹）。运行期主线程加载 JSON 建 `BufferGeometry`，8 个 `InstancedMesh` 共用现有 `T(pivot) × R_y(yaw) × R_x(-pitch)` 矩阵合成，**渲染层不再改写 UV**（权威移到烘焙侧）。玩法层零改动。

**Tech Stack:** Node 26（烘焙，仅 `node:fs`/`node:crypto`）、three r185.1 WebGPU（本地 `vendor/three/`）、Playwright（Tier 4）、pngjs。

**Spec:** `docs/superpowers/specs/2026-11-18-turret-top-model-replacement-design.md`

## Global Constraints

- **烘焙 = 数据格式转换**，不新增方块/贴图/美术资源。贴图复用既有 `assets/turret/armor.png`（192×64，三区 `front`/`side`/`top`）。
- **刚性一体**：全部 8 部件共用同一个 pivot 矩阵，`TURRET_PART_DEFS` 里**不得出现 per-part 的 pitch/独立旋转轴**。`controller.muzzle()` 与 `turret-controller.js` **零改动**。
- **定标 k = 3.5 / 113.36**，判据是炮口世界 z **=== `TURRET.muzzleOffsetZ`（3.5）**。pivot 取模型 y=14.667（炮管轴心）。
- **玩法数值全部冻结**：`TURRET` 的 detectionRange/rotationSpeed/pitchSpeed/fireCooldownMs/projectileDamage/muzzleOffsetZ/pivotHeightOffset 等一项不改。
- **UV 单一权威在烘焙侧**：`turret-renderer.js` 删除 `applyZoneUV`；`ARMOR_ZONES` 仍是区序唯一权威（`turret-config.js`）。
- **贴图/纯色分支靠 `def.textured`**（不是 `def.zone`，zone 恒 null）：`TURRET_PART_DEFS[key].textured` 为 true 的五个装甲部件走 map，false 的三个纯色部件走 color。旧判据 `!!def.zone` 恒假 ⇒ 不改会让装甲全部退化成纯色而指纹全对。
- **焊接键 = 模型坐标 + 法线，`toFixed(4)`**（世界化前）。禁用 OBJ 索引对 `(vi,vni)` 作键 —— 实测那样 barrel 得 1340 而非 1332（导出器有 8 组冗余索引）。
- **依赖方向**：`voxel ← gen ← mesh ← render`；`src/entities/turrets/turret-config.js` 属 Worker 同构层（红线 8），**不得 import three、不得 import node: 模块**。烘焙脚本与指纹模块只在 `tools/`。
- **资源 URL 只走 `resourceUrl()`**（`src/core/resource-url.js`），禁止 `'/assets/` 根绝对路径。
- **时间基准 `performance.now()`**，禁 `Date.now()`。
- **`assertEqual` 是 `===`**，数组用 `assertDeepEqual`；`assertClose` **不在 `assert.js` 里**，要用得在测试文件内自定义。
- **新 `src/tests/test-*.js` 必须同时注册进 `src/tests/index.html`**（漏注册 = 静默不跑）。
- **源 OBJ 放 `assets/turret/src/`**，绝不放 `assets/textures/`（被 `build-atlas` 递归扫描会变成巨型 tile）。
- **不提交**（用户未下提交指令）；每个 Task 末尾的 commit 步骤**跳过**，改为跑验证。
- 中文注释；不加 inline 版权头；不引新依赖。

## Review Focus

按「改坏了多久能被发现」排序，这五条是 spec 隐含但最容易静默失效的：

1. **炮管与塔身分离**（用户明确否决的形态）：任何 yaw/pitch 下炮管必须与鼻段刚性相连。→ Task 5 的「炮口同源」用例 + Task 7 的姿态像素判据。
2. **弹丸从炮管侧面飞出**：渲染矩阵与 `controller.muzzle()` 必须同源。→ Task 5 逐度扫描 ±45° 偏差 < 1e-6。
3. **UV 二次压区**：烘焙已压区 + 渲染层再压一次 ⇒ 全部采到 front 区左侧，而顶点数/指纹全对。→ Task 5 断言渲染层不改 UV（几何 uv 与产物逐位相同）。
4. **分区退化**：`zoneIndex` 恒 0 或阈值取错 ⇒ 塔身大面积单一贴图。→ Task 2 的「u 覆盖区集合 ≡ 法线分类区集合」关系式（**不得写「≥2 区」**，`deckMid` 全是 top 会让正确实现 FAIL）。
5. **无炮塔时恒增 8 个 draw call**：`visible` 未随 slot 归零。→ Task 6 沿用现有用例并迁移部件名。
6. **装甲部件退化成纯色**：`def.zone` 恒 null 后旧判据 `!!def.zone` 恒假，而顶点数/指纹全对。→ Task 4 的 `textured` 字段断言 + Task 5 的材质分支用例。
7. **Tier 4 取样面被遮挡或是内腔面**：取到背景/别的部件 ⇒ 注入退化仍全绿。→ Task 7 的射线可见性筛选（spec §9 已给出逐区候选序号）。

---

### Task 1: OBJ 解析器与部件切分（纯函数，TDD）

**Files:**
- Create: `tools/turret-top-fingerprint.mjs`（参数 + 输入指纹 + **解析/切分纯函数**，烘焙与门禁共用）
- Create: `assets/turret/src/TankCannon.obj`（源模型入库，从 `/Users/bachi/ttt/mc/素颜炮塔/TankCannon.obj` 拷贝）
- Create: `src/tests/test-turret-top-bake.js`（浏览器内单测；**纯函数部分**从 `tools/` import 会踩 node: 依赖 ⇒ 见下方 Interfaces 的拆分说明）
- Modify: `src/tests/index.html`（注册新测试）

**Interfaces:**
- Produces:
  - `TURRET_TOP_SRC`（绝对路径常量）、`TURRET_TOP_JSON`、`TURRET_TOP_META`
  - `TURRET_TOP_PARAMS = { scale: 3.5/113.36, pivotY: 14.667, zoneNyThreshold: 0.85, zones: ['front','side','top'] }`
  - `TURRET_TOP_METRICS`（冻结指标，见 Step 1 的表）
  - `turretTopInputFingerprint(): string`（源 OBJ 内容 sha256 + 参数 sha256，照 `guardian-fingerprint.mjs`）
  - `parseObj(text): { positions: number[][], normals: number[][], uvs: number[][], groups: Record<string, number[][][]> }`（`f` 的 token 解析成 `[vi, vti, vni]`，1-indexed 原样保留）
  - `splitParts(parsed): Record<PartKey, Face[]>`，`Face = { p: number[][], n: number[][], uv: number[][] }`（已 deref 成实际坐标）
  - `PartKey = 'cheek'|'mantlet'|'deckMid'|'ring'|'nose'|'podR'|'podL'|'barrel'|'hull'`

⚠️ **纯函数放 `tools/turret-top-parse.mjs`（无 node: 依赖）**，指纹模块（有 `node:fs`）从它 re-export。
浏览器单测 import `../../tools/turret-top-parse.mjs` —— **已核实本仓有先例**：
`src/tests/test-molang.js:16` 就是 `import { compileMolang, MolangError } from '../../tools/molang-eval.mjs'`。
⇒ 直接照这个手法，不必改放 `src/mesh/`。

- [ ] **Step 1: 写失败测试 —— 解析与切分的冻结指标**

在 `src/tests/test-turret-top-bake.js`：

```js
import { parseObj, splitParts } from '../../tools/turret-top-parse.mjs';
// fixture：不读真实 OBJ（浏览器无 fs）⇒ 用 fetch 取 assets/turret/src/TankCannon.obj
const text = await (await fetch(resourceUrl('assets/turret/src/TankCannon.obj'))).text();
const parsed = parseObj(text);
assertEqual(parsed.positions.length, 2192);
assertEqual(parsed.normals.length, 1131);
assertEqual(parsed.uvs.length, 1194);
assertEqual(Object.keys(parsed.groups).length, 4);
assertEqual(parsed.groups.TankBase.length, 1134);
assertEqual(parsed.groups.TankCannon.length, 374);
assertEqual(parsed.groups.Secondary2.length, 332);
assertEqual(parsed.groups.Secondary1.length, 288);
const parts = splitParts(parsed);
// 九部件面数（spec §2.2 冻结表）
const FACES = { cheek:140, mantlet:57, deckMid:14, ring:123, nose:281, podR:288, podL:332, barrel:374, hull:519 };
for (const [k, n] of Object.entries(FACES)) assertEqual(parts[k].length, n, `${k} 面数`);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx playwright test tests/harness.spec.mjs -g "浏览器内单测"`（或直接在浏览器页读 `window.__MC_TEST_RESULTS__`）
Expected: FAIL —— `Failed to resolve module specifier` 或 `parseObj is not a function`

- [ ] **Step 3: 实现 `parseObj` 与 `splitParts`**

`parseObj`：逐行扫 `v `/`vn `/`vt `/`g `/`f `，`f` 的每个 token 按 `/` 拆成三个数（空段记 0）。
`splitParts`：按 spec §2.2 的判定顺序（**顺序是载荷性的**，先判组名再判 y 窗口）：

```js
function partOf(groupName, p) {
  const ymin = Math.min(...p.map(q => q[1])), ymax = Math.max(...p.map(q => q[1]));
  const xmax = Math.max(...p.map(q => Math.abs(q[0])));
  const zmin = Math.min(...p.map(q => q[2]));
  if (groupName === 'TankCannon') return 'barrel';
  if (groupName === 'Secondary1') return 'podR';
  if (groupName === 'Secondary2') return 'podL';
  if (ymin >= 29.99) return xmax >= 16 ? 'cheek' : (xmax <= 13.6 ? 'mantlet' : 'deckMid');
  if (ymax <= 28.2) return zmin >= 40.5 ? 'nose' : 'hull';
  return 'ring';
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2
Expected: PASS（9 个面数断言 + 8 个解析断言全绿）

- [ ] **Step 5: 补负向验证 —— 切分顺序的判别力**

把 `partOf` 里 `if (ymax <= 28.2)` 改成 `if (ymax <= 30.05)`（把 ring 吞进 nose/hull），
跑测试必须 FAIL（`ring` 面数 123 → 0）。**用 `cp` 副本还原，禁 `git checkout`**（仓库有未提交改动）。

- [ ] **Step 6: 注册测试 + 跑 check**

在 `src/tests/index.html` 加 `import './test-turret-top-bake.js';`
Run: `npm run check`
Expected: `[测试注册]` 环节通过；lint 无新增 warning（`npx eslint tools/turret-top-parse.mjs src/tests/test-turret-top-bake.js` 单独看）

---

### Task 2: 定标 + UV 重建 + 烘焙产物（TDD）

**Files:**
- Modify: `tools/turret-top-parse.mjs`（加 `geomNormal`/`zoneOf`/`rebuildUV`/`buildPartGeometry`）
- Create: `tools/bake-turret-top.mjs`
- Create: `assets/turret/turret-top.json` + `assets/turret/turret-top.meta.json`（产物）
- Modify: `tools/turret-top-fingerprint.mjs`（补 `TURRET_TOP_METRICS`）
- Modify: `package.json`（加 `"turretop": "node tools/bake-turret-top.mjs"`）
- Modify: `src/tests/test-turret-top-bake.js`

**Interfaces:**
- Consumes: Task 1 的 `parseObj` / `splitParts` / `PartKey`
- Produces:
  - `geomNormal(p: number[][]): { n: [number,number,number], area: number }`（Newell 法，面积 = |cross|/2）
  - `zoneOf(p: number[][], threshold?: number): 'front'|'side'|'top'`
  - `buildPartGeometry(faces: Face[], key: PartKey, params): { position:number[], normal:number[], uv:number[], index:number[] }`
  - 产物 JSON 结构（spec §7.1）：`{ scale, pivotY, parts: { [key]: { position, normal, uv, index, zone: null, color?: number } } }`

- [ ] **Step 1: 写失败测试 —— 定标、UV 零退化、分区关系式、跨区拆顶点**

```js
import { buildPartGeometry, zoneOf, geomNormal } from '../../tools/turret-top-parse.mjs';
import { TURRET_TOP_PARAMS } from '../../tools/turret-top-parse.mjs';
const ARMOR = ['cheek','mantlet','deckMid','ring','nose'];
const ZONES = ['front','side','top'];
const built = {};
for (const k of [...ARMOR,'podR','podL','barrel']) built[k] = buildPartGeometry(parts[k], k, TURRET_TOP_PARAMS);

// ① 定标：炮口世界 z === 3.5（assertClose 自定义，assert.js 里没有）
const assertClose = (a, b, eps, msg) => assertTrue(Math.abs(a-b) <= eps, `${msg}: ${a} vs ${b}`);
const bz = built.barrel.position.filter((_, i) => i % 3 === 2);
assertClose(Math.max(...bz), 3.5, 1e-6, '炮口 z 对齐 muzzleOffsetZ');

// ② UV 零退化：五个装甲部件 615 面，每面 UV 面积 > 1e-6
//    （逐面检查：index 每 3 个一组，取 uv 算三角面积）
let degenerate = 0;
for (const k of ARMOR) {
  const g = built[k];
  for (let i = 0; i < g.index.length; i += 3) {
    const [a,b,c] = [g.index[i],g.index[i+1],g.index[i+2]];
    const u = (j) => [g.uv[j*2], g.uv[j*2+1]];
    const A = u(a), B = u(b), C = u(c);
    const area = Math.abs((B[0]-A[0])*(C[1]-A[1]) - (C[0]-A[0])*(B[1]-A[1])) / 2;
    if (area <= 1e-6) degenerate++;
  }
}
assertEqual(degenerate, 0, '装甲部件 UV 零退化');

// ③ 分区关系式：u 覆盖区集合 ≡ 法线分类区集合（⚠️ 不得写「≥2 区」，deckMid 全是 top）
for (const k of ARMOR) {
  const want = new Set(parts[k].map(f => zoneOf(f.p)));
  const got = new Set();
  for (let i = 0; i < built[k].uv.length; i += 2) got.add(ZONES[Math.min(2, Math.floor(built[k].uv[i]*3))]);
  assertDeepEqual([...got].sort(), [...want].sort(), `${k} 的 u 覆盖区集合`);
}
// 实测期望：cheek/mantlet/ring/nose = {front,side,top}，deckMid = {top}

// ④ 跨区顶点必须拆开：不存在同一 (position,normal) 落在两个不同区
//    原始数据有 26 个跨区共用顶点 ⇒ 注入「全焊接」必须 FAIL
let conflict = 0;
for (const k of ARMOR) {
  const g = built[k], seen = new Map();
  for (let v = 0; v < g.position.length/3; v++) {
    const key = [0,1,2].map(j => g.position[v*3+j].toFixed(4)).join(',') + '|'
              + [0,1,2].map(j => g.normal[v*3+j].toFixed(4)).join(',');
    const z = Math.min(2, Math.floor(g.uv[v*2]*3));
    if (seen.has(key) && seen.get(key) !== z) conflict++;
    seen.set(key, z);
  }
}
assertEqual(conflict, 0, '跨区顶点已按面拆开');

// ⑤ 冻结规模
const TRIS = { cheek:280, mantlet:114, deckMid:28, ring:246, nose:562, podR:576, podL:632, barrel:712 };
const VERTS = { cheek:560, mantlet:228, deckMid:56, ring:492, nose:1124, podR:960, podL:480, barrel:1332 };
for (const k of Object.keys(TRIS)) {
  assertEqual(built[k].index.length / 3, TRIS[k], `${k} 三角数`);
  assertEqual(built[k].position.length / 3, VERTS[k], `${k} 顶点数`);
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: 浏览器内单测页
Expected: FAIL —— `buildPartGeometry is not a function`

- [ ] **Step 3: 实现 `geomNormal` / `zoneOf` / `buildPartGeometry`**

`zoneOf`：`n[1] > 0.85 || n[1] < -0.85 → 'top'`；否则 `|n[0]| >= |n[2]| → 'side'`，else `'front'`。
`buildPartGeometry`：
- 世界化 `[x*k, (y-14.667)*k, z*k]`，法线**不缩放**（单位向量）。
- 装甲部件（`ARMOR` 五个）：**逐面**处理，每面的 4 角各自成顶点（不焊接）；
  UV = 丢弃法线主轴后另两轴在**该面自身 bbox** 内归一化，再 `u' = zoneIndex/3 + u/3`（**只改 u**）。
- 纯色部件（`barrel`/`podR`/`podL`）：按**模型坐标+法线的 `toFixed(4)`** 焊接（世界化前），UV 全填 0。
  ⚠️ **不得用 OBJ 索引对 `(vi,vni)`**：实测 barrel 会得 1340 而非冻结的 1332。
- 三角化：四边形扇形 `[0,i,i+1]`（i=1..len-2）。

- [ ] **Step 4: 跑测试确认通过**

Expected: PASS（定标 / 零退化 / 分区关系式 / 跨区拆分 / 16 个规模断言）

- [ ] **Step 5: 负向验证 —— 三条注入各自必须 FAIL**

用 `cp` 备份 `tools/turret-top-parse.mjs` 到 `/tmp/`，逐条注入后跑测试再还原：
① `zoneOf` 恒返回 `'front'` → ③ 分区关系式 FAIL
② 装甲部件改成按 `(pos,normal)` 焊接 → ④ 跨区冲突 FAIL（应报 26 附近）
③ `scale` 改成 `3.0/113.36` → ① 定标 FAIL

- [ ] **Step 6: 写烘焙脚本并产出产物**

`tools/bake-turret-top.mjs`：读 `TURRET_TOP_SRC` → `parseObj` → `splitParts` → **丢弃 `hull`** →
逐部件 `buildPartGeometry` → **内容级断言**（炮口 z、零退化、跨区为 0、三角/顶点数）→
写 `turret-top.json` + `turret-top.meta.json`（含 `fingerprints` 与 `metrics`）。
纯色色值从 `turret-config.js` 取（Task 4 会加；本 Task 先写字面量并在 Task 4 改为 import，**或**先做 Task 4 的 config 部分）。

Run: `npm run turretop`
Expected: 打印 `[turret-top] 烘焙完成 8 部件 / 3150 三角 / 5232 顶点`，产物落盘

- [ ] **Step 7: 内容级判据 —— hull 必须被排除**

在测试里加：产物 `parts` 的键集合 `assertDeepEqual` 排序后 === 8 个新部件名（不含 `hull`）；
且所有部件的 position 中**不存在** `y < (25.72-14.667)*k - 1e-6` 的顶点（hull 的 y 下界是 0）。

Run: 浏览器内单测 → PASS

---

### Task 3: check:data 门禁与指纹

**Files:**
- Modify: `tools/turret-top-fingerprint.mjs`（`TURRET_TOP_METRICS` + `readTurretTopJson()`）
- Modify: `tools/check-data.mjs`（新增 `[炮塔塔顶]` 环节 + 注册进 main 调用列表）

**Interfaces:**
- Consumes: Task 2 的产物与 `turretTopInputFingerprint()`
- Produces: `checkTurretTopGeometry()`（内部函数，push 到 `failures`/`infos`）

- [ ] **Step 1: 写门禁断言**

在 `check-data.mjs` 加 `checkTurretTopGeometry()`：
① 产物存在（缺 → 报「跑 `npm run turretop`」）
② `meta.fingerprints.input` === `turretTopInputFingerprint()`
③ `Object.keys(json.parts).sort()` === `TURRET_PARTS` 排序后（**关系式**，两侧漂移即红）
④ 三角总数 3150 / 顶点总数 5232（冻结）
⑤ **内容级**：炮口 z === 3.5（±1e-6）；装甲部件 UV 零退化；跨区顶点冲突 0
⑥ 每个部件 UV ∈ [0,1]
⑦ **`textured` 集合关系式**：`TURRET_PARTS.filter(k => TURRET_PART_DEFS[k].textured).sort()`
   === `['cheek','deckMid','mantlet','nose','ring']`（烘焙侧装甲集合，两侧漂移即红）

⚠️ **⑤ 不可省**：spec §9 已记「只改烘焙算法不动参数时指纹不变」是已知盲区。

- [ ] **Step 1b: 替掉旧 zone 断言（否则变空转）**

`check-data.mjs:1078-1082` 的 `if (zone !== null && !ARMOR_ZONES.includes(zone))` 在 zone 恒 null 后
**永不进入** ⇒ 失去判别力。把它改成⑦ 的 `textured` 集合关系式 + 「每个 textured 部件的
u 覆盖区集合 ≡ 法线分类区集合」。**不得保留旧断言假装它仍在保护**。

- [ ] **Step 2: 跑门禁确认通过**

Run: `npm run check:data`
Expected: `[炮塔塔顶] 8 部件 / 3150 三角 / 5232 顶点 + 指纹匹配 + 炮口 z=3.5`

- [ ] **Step 3: 负向验证 —— 指纹与内容级各自有判别力**

① 手改 `turret-top.meta.json` 的 fingerprint 一个字符 → ② FAIL
② 用 `cp` 备份产物后，把 `barrel.position` 里最大 z 改成 3.0（**只改产物不改参数**，指纹不变）→ ⑤ FAIL
还原用 `cp`，禁 `git checkout`。

- [ ] **Step 4: 跑全量 check**

Run: `npm run check`
Expected: arch + data + lint 全绿

---

### Task 4: config 部件定义与几何加载器

**Files:**
- Modify: `src/entities/turrets/turret-config.js`（`TURRET_PARTS` / `TURRET_PART_DEFS` / `TURRET_GUN_COLOR` / 新增定标常量）
- Create: `src/render/turret-top-geometry.js`
- Modify: `tools/bake-turret-top.mjs`（色值改为从 config import，消除字面量副本）

**Interfaces:**
- Consumes: Task 2 的产物 JSON
- Produces:
  - `TURRET_PARTS = ['mantlet','cheek','nose','ring','deckMid','barrel','podR','podL']`（顺序 = spec §8.0 映射表的旧序 front/left/right/top/back/barrel/root/sight）
  - `TURRET_PART_DEFS[key] = { zone: null, textured: boolean, color?: number }`
    （**不再有 geo/size/pos/rotX** —— 几何全在产物里，部件局部变换是恒等）
    · `textured: true` → cheek/mantlet/deckMid/ring/nose；`false` → barrel/podR/podL
    · ⚠️ **渲染层靠它判贴图/纯色**，不是 `zone`（zone 恒 null，旧判据 `!!def.zone` 恒假）
  - `TURRET_TOP_SCALE = 3.5/113.36`、`TURRET_TOP_PIVOT_Y = 14.667`（**溯源用**，运行期不消费，产物已烘进）
  - `TURRET_GUN_COLOR = { BARREL: 0x8a8a8a, POD: 0x6e6e6e }`（替换旧 BARREL/ROOT/SIGHT）
  - `loadTurretTopGeometry(): Promise<{ parts: Record<string, {position,normal,uv,index}> } | null>`

- [ ] **Step 1: 写失败测试 —— config 关系式**

```js
assertEqual(TURRET_PARTS.length, 8);
assertDeepEqual([...TURRET_PARTS].sort(), ['barrel','cheek','deckMid','mantlet','nose','podL','podR','ring']);
// 刚性一体：任何部件都不得带独立旋转/位移（spec 全局约束）
for (const k of TURRET_PARTS) {
  const d = TURRET_PART_DEFS[k];
  assertUndefined(d.rotX, `${k} 不得有独立 rotX`);
  assertUndefined(d.pos, `${k} 不得有独立位移`);
  assertUndefined(d.pitchAxis, `${k} 不得有独立 pitch 轴`);
}
assertEqual(TURRET_GUN_COLOR.BARREL, 0x8a8a8a);
assertEqual(TURRET_GUN_COLOR.POD, 0x6e6e6e);
// textured 集合（渲染层贴图/纯色分支的唯一依据）
assertDeepEqual(TURRET_PARTS.filter(k => TURRET_PART_DEFS[k].textured).sort(),
  ['cheek','deckMid','mantlet','nose','ring']);
assertDeepEqual(TURRET_PARTS.filter(k => !TURRET_PART_DEFS[k].textured).sort(),
  ['barrel','podL','podR']);
// 定标常量与 muzzleOffsetZ 的关系式（不是字面量副本）
assertClose(TURRET_TOP_SCALE * 113.36, TURRET.muzzleOffsetZ, 1e-9, '定标对齐炮口');
```

- [ ] **Step 2: 跑测试确认失败**

Expected: FAIL（旧部件名 / 旧色值 / rotX 仍存在）

- [ ] **Step 3: 改 config**

⚠️ **`TURRET` 玩法数值一项不改**；只改部件定义段。`ARMOR_ZONES` 保留（烘焙侧消费）。
`TURRET_TOWER_COLOR` 保留（无纹理退回路径）。

- [ ] **Step 4: 实现 `loadTurretTopGeometry()`**

照 `turret-armor-texture.js` 的容错口径：`fetch(resourceUrl('assets/turret/turret-top.json'))` →
失败 `console.warn` + 返回 null。**不在此处建 BufferGeometry**（three 依赖留给渲染层，
本模块只做数据加载 ⇒ 可被单测无 three 消费）。

- [ ] **Step 5: 跑测试确认通过 + check:arch**

Run: 浏览器内单测 + `npm run check:arch`
Expected: PASS；arch 无「同构层 import three」误报
⚠️ 若在 config 注释里写「同构层（无 DOM 无 three）」会触发 `ISOMORPHIC_DECLARED` 正则误判 ⇒
描述别的模块时写「属 Worker 同构层（红线 8）」。

---

### Task 5: turret-renderer 接产物几何（删 applyZoneUV）

**Files:**
- Modify: `src/render/turret-renderer.js`
- Modify: `src/tests/test-turrets.js`（渲染层用例迁移）

**Interfaces:**
- Consumes: Task 4 的 `TURRET_PARTS`/`TURRET_PART_DEFS`/`TURRET_GUN_COLOR` + 产物数据
- Produces: `new TurretRenderer({ scene, maxActive?, armorTexture?, topGeometry })`
  （`topGeometry` = Task 4 加载器的返回值；null 时**退回旧参数化几何**不可行——旧 def 已删 ⇒
  改为 `topGeometry` 缺失时**不建 mesh、`sync` 空转**，并 `console.warn`）

- [ ] **Step 1: 写失败测试 —— UV 不被二次改写 + 炮口同源**

```js
// ① UV 单一权威：渲染层几何的 uv 与产物逐位相同（注入「保留 applyZoneUV」必须 FAIL）
const tr = new TurretRenderer({ scene, topGeometry: fixtureTop, armorTexture: makeFakeTexture() });
for (const k of ['cheek','mantlet','nose','ring','deckMid']) {
  const uv = tr.meshes[k].geometry.getAttribute('uv');
  const src = fixtureTop.parts[k].uv;
  assertEqual(uv.count * 2, src.length);
  for (let i = 0; i < src.length; i++) assertClose(uv.array[i], src[i], 1e-6, `${k} uv[${i}] 未被改写`);
}

// ② 炮口同源：渲染矩阵变换后的炮口顶点 === controller.muzzle()（全 ±45° 逐度）
//    炮口局部坐标 = 产物 barrel 里 z 最大的顶点（取 x≈0,y≈0 的那个）
const ctl = new TurretController({ /* 最小 fixture：anchor.origin=[0,0,0] */ });
const muzzleLocal = /* 从 fixtureTop.parts.barrel 取 z 最大且 |x|,|y| 最小的顶点 */;
for (let deg = -45; deg <= 45; deg++) {
  const pitch = deg * Math.PI / 180;
  ctl.currentPitch = pitch; ctl.currentRotation = 0;
  tr.sync(new Map([['t', { position: ctl.pivot(), yaw: 0, pitch }]]));
  tr.meshes.barrel.getMatrixAt(0, m);
  const world = new THREE.Vector3(...muzzleLocal).applyMatrix4(m);
  const want = ctl.muzzle().position;
  assertClose(world.x, want[0], 1e-6, `pitch=${deg}° 炮口 x`);
  assertClose(world.y, want[1], 1e-6, `pitch=${deg}° 炮口 y`);
  assertClose(world.z, want[2], 1e-6, `pitch=${deg}° 炮口 z`);
}
```

⚠️ **这条是「弹丸从炮管侧面飞出」的唯一防线**，且**必须交叉比对渲染矩阵**——只读渲染矩阵的单测测不到 `muzzle()` 的符号。

- [ ] **Step 2: 跑测试确认失败**

Expected: FAIL（`topGeometry` 参数不认 / UV 被二次压区）

- [ ] **Step 3: 改渲染层**

- 删 `applyZoneUV` 函数与调用（UV 权威在烘焙侧）。
- 删 `buildPartGeometry`（参数化几何），改为从 `topGeometry.parts[part]` 建 `BufferGeometry`：
  `setAttribute('position'/'normal'/'uv', Float32BufferAttribute)` + `setIndex`。
- 材质：`def.textured && armorTexture` → `{color:0xffffff, map:armorTexture}`；
  `def.textured && !armorTexture` → `{color: TURRET_TOWER_COLOR.MAIN}`（退回）；
  `!def.textured` → `{color: def.color}`。
  ⚠️ **判据是 `def.textured` 不是 `def.zone`**（zone 恒 null，用旧判据会让装甲全部退纯色而指纹全对）。
  ⚠️ `TURRET_TOWER_COLOR.DARK` **保留常量但无消费点**（新 8 部件无「后板」语义），
  不得为了用上它而给某部件硬塞 color。
- **`sync` 的 pivot 矩阵合成完全不动**；部件局部变换改为**恒等**（`_local.identity()`），
  因为几何已含世界化坐标。⚠️ 这一步是刚性一体的落点：8 部件乘同一个 `_pivotMatrix`。
- `mesh.name` 仍是 `turret:${part}`；`frustumCulled=false`；零实例 `visible=false`。

- [ ] **Step 4: 跑测试确认通过**

Expected: PASS（UV 逐位 + 91 个 pitch 档 × 3 轴炮口断言）

- [ ] **Step 5: 负向验证 —— 三条注入**

① 恢复 `applyZoneUV(geometry, 0)` → ① UV 断言 FAIL
② 给 `barrel` 单独加一个 pitch 轴偏移（模拟分层）→ ② 炮口同源 FAIL
③ `sync` 里漏掉 `visible = anyActive` → 现有「无炮塔不可见」用例 FAIL
每条用 `cp` 还原。

- [ ] **Step 6: 迁移旧渲染用例**

`test-turrets.js` 里：
- `assertEqual(renderer.meshes.front.geometry.type, 'BoxGeometry')` → 改为 `'BufferGeometry'`
- `assertEqual(TURRET_PART_DEFS.barrel.length, 3.0)` 等**旧几何数值断言全部删除**（几何不再参数化）
- `uOf('left') === uOf('right')` **删除**（spec §8.0：新 cheek 是一个部件，左右对称断言失去意义）
- 「UV 分区把五块装甲板映射到对应区」用例改为消费产物 uv（Task 2 已在烘焙侧钉住，此处只验渲染层不改写）

Run: 浏览器内单测 → 全绿

---

### Task 6: game.js 装配与 E2E spec 迁移

**Files:**
- Modify: `src/core/game.js`（加载 + 注入）
- Modify: `tests/turret-render.spec.mjs`（部件名 + 数量断言）
- Modify: `src/tests/test-turret-render.html`（fixture 注入产物几何）

**Interfaces:**
- Consumes: Task 4 的 `loadTurretTopGeometry()`、Task 5 的 `TurretRenderer({topGeometry})`

- [ ] **Step 1: 改 game.js 装配**

在 `_turretArmorTexture` 加载处**并行**加载几何（spec §10 风险 1：避免串行延长启动）：

```js
const [armorTex, topGeo] = await Promise.all([
  loadTurretArmorTexture().catch(e => { console.warn('[game] 炮塔装甲纹理加载失败，退回纯色炮塔：', e); return null; }),
  loadTurretTopGeometry().catch(e => { console.warn('[game] 炮塔塔顶几何加载失败：', e); return null; }),
]);
this._turretArmorTexture = armorTex;
this._turretTopGeometry = topGeo;
```

构造处加 `topGeometry: this._turretTopGeometry`。

- [ ] **Step 2: 迁移 fixture 与 spec 的部件名**

`test-turret-render.html`：`import { loadTurretTopGeometry }`，构造 `TurretRenderer` 时传 `topGeometry`；
`__TT_INFO__.meshNames` 改为新 8 名；`armorPartsHaveMap` 改为 `['mantlet','cheek','nose','ring','deckMid']`。
`tests/turret-render.spec.mjs`：`meshNames` 期望数组换新名；真游戏页用例的 `=== 8` **不变**（部件数仍 8）。

- [ ] **Step 3: 跑 E2E 确认接线**

Run: `npx playwright test tests/turret-render.spec.mjs -g "真游戏页"`
Expected: PASS（放一个炮塔后 8 个 `turret:*` mesh 可见）
⚠️ 若报 `fixture 不应报错`，先读 `window.__TT_ERROR__` 的实际内容再改，不要猜。

- [ ] **Step 4: 跑炮塔玩法回归**

Run: `npx playwright test tests/turrets.spec.mjs`
Expected: PASS（索敌/开火/三发杀死/失效回收全部不变 —— 玩法层零改动的证据）

---

### Task 7: Tier 4 像素实测（三区 + 刚性姿态）

**Files:**
- Modify: `src/tests/test-turret-render.html`（取样点从产物几何反解 + 姿态渲染入口）
- Modify: `tests/turret-render.spec.mjs`（像素判据）

**Interfaces:**
- Consumes: Task 6 的 fixture

- [ ] **Step 1: fixture 加「按部件+区取第一个射线无遮挡面」的取样点反解**

spec §9 的取样点表是「取哪个面」的权威。fixture 里：
从 `topGeometry.parts[part]` 按三角面积**降序**遍历，对每个候选面做**射线遮挡检测**
（相机置面心 + 法线×2.4，向面心发射，首个命中距离 ≥ 2.4−1e-4 才可见），取第一个可见面。

⚠️⚠️ **不能直接取最大面，也不能只查近邻遮挡**（实测推翻）：
· `mantlet.side` 最大面（A=545）被 **cheek 在 1.885 格处**挡住，要跳到第 **3** 个（A=8）；
· `nose.side` 最大面（A=354）被 **podL 在 1.031 格处**挡住，要跳到第 **7** 个（A=18）；
· `nose.top` 最大面（A=354）是**中央腔内顶面**（炮管通道），被 nose 自身在 1.695 格处挡住，
  要跳到第 **3** 个（A=339）。

**三区主判据固定用**：`cheek.front`（A=387，彩色）/ `cheek.side`（A=814，灰度）/
`mantlet.top`（A=1129，蓝灰）—— 这三个都是第 1 候选即可见，最稳。
面心与法线经 `getMatrixAt(0,m)` 变换到世界，相机沿**变换后的法线**外摆。
新增 `window.__TT_RENDER_POSE__(pitchDeg)` 入口（渲染指定 pitch 的一帧，返回炮管-鼻段连接处的屏幕坐标）。

- [ ] **Step 2: 写像素判据（先测噪声底）**

```js
// ⓪ 噪声底：同状态重复截图三次，取最大差
// ① cheek.front 区彩色：|r-g| > 8 且 r > 60
// ② cheek.side 区灰度：|r-g| < 4 且 |g-b| < 4 且 r > 60
// ③ mantlet.top 与 cheek.side 亮度差 > 4
// ④ barrel 纯色：|r-g| < 6 且 r > 15（0x8a8a8a=138 经 unlit+SRGB 输出后仍远大于 15）
// ⑤ 刚性姿态：pitch=0 / -45 / +45 三帧，炮管与鼻段连接处不得出现背景色像素
//    判据同时钉上下界：连接处非背景像素数 ∈ [noiseFloor+下限, 上限]
// ⑥ 装甲部件确实带 map（防 textured 判据退化成纯色）：
//    __TT_INFO__.armorPartsHaveMap === ['mantlet','cheek','nose','ring','deckMid']
```

⚠️ **先跑一次打印实际值再定阈值**（AGENTS.md：断言前先在真实数据上跑一次）。
⚠️ 阈值**不得取缺陷实测值**（memory: terrain-migration-cliff-acceptance-criteria）。

- [ ] **Step 3: 跑 Tier 4 确认通过**

Run: `npx playwright test tests/turret-render.spec.mjs`
Expected: PASS

- [ ] **Step 4: 负向验证 —— 像素判据的判别力**

① 注入「`zoneOf` 恒 front」重烘焙 → ②③ FAIL（side/top 变彩色）
② 注入「barrel 单独 pitch 轴」→ ⑤ FAIL（连接处出现背景）
③ 注入「`visible` 恒 true」→ 现有「无炮塔」用例 FAIL
每条用 `cp` 还原产物与源码。

- [ ] **Step 5: 跑最小充分验证集**

Run: `npm run check` + `npx playwright test tests/turret-render.spec.mjs tests/turrets.spec.mjs`
Expected: 全绿

- [ ] **Step 6: 热路径 bench**

改了 `render/`，按 testing-policy 加跑：
Run: `npm run bench -- --check`
Expected: 退出码 0
⚠️ **不可与回归并发**；frameP95 有 vsync 量子化噪声 ⇒ 若报回退，用交替对照判定，**不擅自放宽阈值**。
⚠️ `npm run bench` 不带 `--check` 会重写冻结基线 ⇒ 诊断后必须 `git checkout docs/m3-baseline.*` 恢复
（**这是唯一允许对该文件用 checkout 的场景**，因为它是生成物且本任务未改它）。

---

## 自查（writing-plans Self-Review）

**1. Spec 覆盖**：§2.1 格式选型 → Task 1；§2.2 部件切分 → Task 1；§2.3 UV 重建 → Task 2；
§3.1 刚性一体 → Task 5 Step 3 + Step 5②；§3.2 三区贴图 → Task 2 + Task 7；§5 定标 → Task 2 Step 1①；
§5.1 穿模 → 已由调研实测确认零穿模，无需新增用例（Task 7⑤ 的姿态判据覆盖分离风险）；
§6 着色 → Task 2（UV）+ Task 4（色值）；§7.1 产物结构 → Task 2 Step 6；§8.0 部件名映射 → Task 4/5/6；
§9 验证 → 各 Task 的 TDD 步骤 + Task 7；§10 风险 1（启动延迟）→ Task 6 Step 1 并行加载。

**2. 步骤扫描**：每步一个动作 + 一个可检查结果。算法块只出现在 `partOf`（判定顺序载荷性）
与 UV 投影口径（签名与测试不能唯一确定）两处，其余给签名与断言。

**3. 类型一致**：`PartKey` 在 Task 1 定义，Task 2/3/4/5 一致使用；`buildPartGeometry` 返回
`{position,normal,uv,index}` 与产物 JSON 字段、Task 5 的 `setAttribute` 逐一对应；
`topGeometry` 参数名在 Task 4 加载器、Task 5 构造器、Task 6 装配三处一致。

**4. Review Focus**：五条各有归属 —— 1→Task 5②/Task 7⑤；2→Task 5②；3→Task 5①；
4→Task 2③；5→Task 5 Step 5③/Task 6。

**5. 比例**：spec 407 行，计划约 330 行，代码块集中在测试断言（冻结数字必须逐字给出），
未出现函数体转录。

**已知待决**（实施时按此定，不回头问）：
- Task 2 Step 6 的色值：若 Task 4 尚未做，先写字面量并在 Task 4 Step 3 改为 import（消除副本）。

## Builder check 结果处理（2026-11-18）

fresh reviewer 提了 5 条，**逐条核实后全部采纳**（无一条需要回头问用户 —— 都是实现细节，
不改变成品形态，按 receiving-code-review 的「Minor 堆」自行定案）：

| # | 问题 | 核实结果 | 处理 |
|---|---|---|---|
| 1 | `zone` 恒 null 后贴图/纯色分支缺字段，MAIN/DARK 退回无法实现 | **成立**：`turret-renderer.js:78` 确实是 `!!def.zone` | 新增 `def.textured`；DARK 保留常量但标明无消费点（spec §6.3） |
| 2 | 旧 zone 断言变空转，§7.1「仍成立」不实 | **成立**：`check-data.mjs:1078-1082` 的 `zone !== null` 永不进入 | 替成 `textured` 集合关系式（Task 3 Step 1b） |
| 3 | 顶点数 5232 依赖未定的焊接容差 | **成立且实测出真差异**：索引对焊接 barrel=1340 vs 坐标焊接 1332 | 定案 `toFixed(4)` 坐标键；实测 3/4/6 三档同结果（spec §6.1） |
| 4 | `nose.top` 取样面疑为内腔面 | **成立，而且还多找出两处**：射线实测 nose.top/nose.side/mantlet.side 均被挡 | 改用 Möller–Trumbore 射线筛选，主判据改 cheek.front/cheek.side/mantlet.top（spec §9） |
| 5 | `turret:root/sight` 改名是否需别名 | **核实为不需要**：全仓只有 spec 一处消费旧名 | 不加别名（YAGNI + 避免第二份真相），spec §8.0 已记 |

reviewer 同时确认：`applyZoneUV` 单一权威**不是未决矛盾**（§7.1 已定案烘焙侧）；
旧→新 8 部件映射 §8.0 已明确；三角/面/KB 数字全部自洽无矛盾。